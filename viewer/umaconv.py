"""Convert an UmaStudio character pack (decrypted Unity bundles) into files the
viewer and Blender can open:

    model.gltf + model.bin + tex/*.png   the character: body, head and tail merged
                                          onto one skeleton, with toon textures
    motions/<clip>.json                  every AnimationClip in the pack, sampled to
                                          per-bone keyframes (three.js track format)

Unity is left-handed, glTF right-handed: X is mirrored on the way out (positions,
normals, rotations, bind poses, and triangle winding).
"""
import glob
import json
import math
import os
import re
import struct
import sys
import zlib

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

# --- small helpers -----------------------------------------------------------


def obj_key(reader):
    return (reader.assets_file.name, reader.path_id)


def deref(pptr):
    if pptr is None or pptr.path_id == 0:
        return None
    try:
        return pptr.deref()
    except Exception:
        return None


def go_name(transform):
    r = deref(transform.m_GameObject)
    return r.read().m_Name if r else ""


def conv_pos(v):
    return [-v.x, v.y, v.z]


def conv_quat(q):
    return [q.x, -q.y, -q.z, q.w]


def unity_matrix(t):
    """Matrix4x4f typetree dict -> numpy 4x4 (eRC is row R, column C)."""
    return np.array([[t[f"e{r}{c}"] for c in range(4)] for r in range(4)], dtype=np.float64)


MIRROR = np.diag([-1.0, 1.0, 1.0, 1.0])


def conv_matrix(m):
    return MIRROR @ m @ MIRROR


# --- the pack ------------------------------------------------------------------


class Pack:
    def __init__(self, folder=None, files=None):
        self.folder = folder
        if files is None:
            files = glob.glob(os.path.join(folder, "**", "*.unity3d"), recursive=True)
        if not files:
            raise SystemExit(f"no .unity3d files under {folder}")
        self.env = UnityPy.load(*files)
        self.objects = list(self.env.objects)
        self.by_type = {}
        for o in self.objects:
            self.by_type.setdefault(o.type.name, []).append(o)
        info = os.path.join(folder, "pack.json") if folder else ""
        self.info = json.load(open(info, encoding="utf-8")) if info and os.path.exists(info) else {}
        self.textures = {}
        for o in self.by_type.get("Texture2D", []):
            t = o.read()
            self.textures.setdefault(t.m_Name, o)

    def roots(self):
        """Prefab root transforms by name (pfb_bdy..., pfb_chr..., pfb_tail...)."""
        out = {}
        for o in self.by_type.get("Transform", []):
            t = o.read()
            if t.m_Father is None or t.m_Father.path_id == 0:
                out[go_name(t)] = (o, t)
        return out


# --- skeleton --------------------------------------------------------------------


class Skeleton:
    """One merged node tree. Head and tail rigs are grafted onto the body's bones of
    the same name, which is how the game assembles a character."""

    def __init__(self):
        self.nodes = []          # dicts: name, parent, children, t, r, s
        self.by_unity = {}       # unity transform key -> node index
        self.by_go = {}          # unity game object key -> node index
        self.by_name = {}

    def add(self, name, parent, t, r, s):
        i = len(self.nodes)
        self.nodes.append({"name": name, "parent": parent, "children": [], "t": t, "r": r, "s": s})
        if parent is not None:
            self.nodes[parent]["children"].append(i)
        self.by_name.setdefault(name, i)
        return i

    def add_tree(self, reader, transform, parent):
        name = go_name(transform)
        i = self.add(name, parent, conv_pos(transform.m_LocalPosition),
                     conv_quat(transform.m_LocalRotation),
                     [transform.m_LocalScale.x, transform.m_LocalScale.y, transform.m_LocalScale.z])
        self.by_unity[obj_key(reader)] = i
        self.by_go[(reader.assets_file.name, transform.m_GameObject.path_id)] = i
        for c in transform.m_Children:
            r = deref(c)
            if r:
                self.add_tree(r, r.read(), i)
        return i

    def graft(self, reader, transform, parent, keep_go=False):
        """Merge a subtree: bones the body already has are reused, the rest are added.
        keep_go also maps its game objects, so rigid meshes on it get drawn (chibi faces;
        full-size heads keep their tears and effect lines out this way)."""
        name = go_name(transform)
        if name in self.by_name:
            i = self.by_name[name]
        else:
            i = self.add(name, parent, conv_pos(transform.m_LocalPosition),
                         conv_quat(transform.m_LocalRotation),
                         [transform.m_LocalScale.x, transform.m_LocalScale.y, transform.m_LocalScale.z])
        self.by_unity[obj_key(reader)] = i
        if keep_go:
            self.by_go[(reader.assets_file.name, transform.m_GameObject.path_id)] = i
        for c in transform.m_Children:
            r = deref(c)
            if r:
                self.graft(r, r.read(), i, keep_go)

    def path(self, i, root):
        parts = []
        while i is not None and i != root:
            parts.append(self.nodes[i]["name"])
            i = self.nodes[i]["parent"]
        return "/".join(reversed(parts))


# --- glTF writer --------------------------------------------------------------------


class Gltf:
    def __init__(self):
        self.doc = {"asset": {"version": "2.0", "generator": "UmaStudio umaconv"},
                    "scenes": [{"nodes": []}], "scene": 0, "nodes": [], "meshes": [], "skins": [],
                    "materials": [], "textures": [], "images": [], "samplers": [{"magFilter": 9729, "minFilter": 9987}],
                    "accessors": [], "bufferViews": [], "buffers": []}
        self.bin = bytearray()
        self.images = {}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.doc["bufferViews"].append(v)
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, arr, ctype, atype, target=None, normalized=False, minmax=False):
        arr = np.ascontiguousarray(arr)
        a = {"bufferView": self.view(arr.tobytes(), target), "componentType": ctype,
             "count": int(arr.shape[0]), "type": atype}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"] = [float(x) for x in arr.min(axis=0)]
            a["max"] = [float(x) for x in arr.max(axis=0)]
        self.doc["accessors"].append(a)
        return len(self.doc["accessors"]) - 1

    def image(self, name, uri):
        if name in self.images:
            return self.images[name]
        self.doc["images"].append({"name": name, "uri": uri})
        self.doc["textures"].append({"source": len(self.doc["images"]) - 1, "sampler": 0})
        self.images[name] = len(self.doc["textures"]) - 1
        return self.images[name]

    def write(self, folder, stem):
        self.doc["buffers"] = [{"byteLength": len(self.bin), "uri": stem + ".bin"}]
        with open(os.path.join(folder, stem + ".bin"), "wb") as f:
            f.write(self.bin)
        with open(os.path.join(folder, stem + ".gltf"), "w", encoding="utf-8") as f:
            json.dump(self.doc, f, separators=(",", ":"))


FLOAT, UBYTE, USHORT, UINT = 5126, 5121, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

# shader parameters the viewer's toon material reads
FLOAT_PARAMS = ("_ToonStep", "_ToonFeather", "_RimStep", "_RimFeather", "_RimShadow", "_RimSpecRate",
                "_OutlineWidth", "_OutlineBrightness", "_SpecularPower", "_EnvRate", "_EnvBias", "_CheekRate")
COLOR_PARAMS = ("_RimColor", "_OutlineColor", "_ShadowColor", "_SpecularColor", "_faceShadowColor",
                "_ToonBrightColor", "_ToonDarkColor", "_CharaColor")
# and the ones its stage materials read
STAGE_FLOATS = ("_ColorPower", "_Alpha", "_Cull", "_Mode", "_DstBlend")
STAGE_COLORS = ("_Color", "_MulColor0", "_MulColor1", "_AddColor", "_BaseColor")


# --- conversion ------------------------------------------------------------------------


def chara_id_from(names):
    for n in names:
        if n.startswith("pfb_chr"):
            return n[7:11]
    return "0000"


# --- background Umas -----------------------------------------------------------------------
#
# their head materials come without textures: the game picks them at runtime from the mob's face
# and hair ids and skin tone. hair, eyebrows, eyes, tail and outfit are recoloured from an area
# mask (_MaskColorTex) and six colours per part; the page does that (look.js), this hands it over.

MOB_HEAD = "tex_chr0001_00_"


def mob_textures(pack, info, mat_name, texs):
    mob, skin = info["mob"], info["skin"]
    face, hair = f"{MOB_HEAD}face{mob['face']:03d}", f"{MOB_HEAD}hair{mob['hair']:03d}"

    def pick(*names):
        return next((n for n in names if n in pack.textures), None)

    def skinned(base, kind):
        return pick(*(f"{base}_{s}_{kind}" for s in (skin, 0, 1, 2, 3)))

    want = {}
    if mat_name.endswith("_face"):
        # the lashes are drawn white in the face texture and take the eyebrow colours
        want = {"_MainTex": skinned(face, "diff"), "_ToonMap": skinned(face, "shad_c"),
                "_TripleMaskMap": pick(f"{face}_0_base"), "_OptionMaskMap": pick(f"{face}_0_ctrl"),
                "_MaskColorTex": pick(f"{face}_0_area")}
    elif mat_name.endswith("_mayu"):
        want = {"_MainTex": skinned(face, "diff"), "_MaskColorTex": pick(f"{face}_0_area")}
    elif mat_name.endswith("_eye"):
        want = {"_MainTex": pick(f"{face}_0_eye0"), "_High0Tex": pick(f"{face}_0_eyehi00"),
                "_High1Tex": pick(f"{face}_0_eyehi01"), "_MaskColorTex": pick(f"{face}_0_eye0_area")}
    elif mat_name.endswith("_cheek"):
        want = {"_MainTex": skinned(face, "cheek0")}
    elif mat_name.endswith("_hair"):
        want = {"_MainTex": pick(f"{hair}_0_diff"), "_ToonMap": pick(f"{hair}_0_shad_c"),
                "_TripleMaskMap": pick(f"{hair}_{mob.get('sex', 1)}_base", *(f"{hair}_{i}_base" for i in range(4))),
                "_OptionMaskMap": pick(f"{hair}_0_ctrl"),
                "_MaskColorTex": pick(f"{hair}_0_area")}
    elif mat_name.startswith("mtl_bdy") and "_MaskColorTex" not in texs:
        area = sorted(n for n in pack.textures if n.startswith(f"tex_bdy{info['body_type']:04d}_{info['body_sub']:02d}")
                      and n.endswith("0_area"))
        want = {"_MaskColorTex": area[0] if area else None}
    return {k: v for k, v in want.items() if v}


def mini_textures(pack, info, mat_name, texs):
    """Chibi face parts share one face mesh; the eyes, brows and mouth come from the character's
    own mini head textures (atlases the page picks tiles from), the skin from her skin tone."""
    if "_MainTex" in texs:
        return {}
    skin, own = info["skin"], f"tex_mchr{info['chara']:04d}_"
    def find(suffix):
        return next((n for n in sorted(pack.textures) if n.startswith(own) and n.endswith(suffix)), None)
    def face(kind):
        return next((n for n in (f"tex_mchr0001_00_face0_{s}_{kind}" for s in (skin, 0, 1, 2, 3)) if n in pack.textures), None)
    part = mat_name.rsplit("_", 1)[-1] if not mat_name.endswith(("_mayu_l", "_mayu_r")) else "mayu"
    want = {"face0": face("diff"), "cheek": face("cheek0"), "eye": find("_eye_diff"),
            "mouth": find("_mouth_diff"), "mayu": find("_mayu_diff")}.get(part)
    return {"_MainTex": want} if want else {}


def mob_mask(info, mat_name):
    """The six colours (R1 R2 G1 G2 B1 B2) and their shadow versions for one material, or None."""
    mob = info["mob"]
    hair, dress = mob.get("hair_colors", {}), mob.get("dress_colors", {})
    part = next((p for p in ("hair", "mayu", "eye", "tail") if mat_name.endswith("_" + p) or f"mtl_{p}" in mat_name), None)
    if mat_name.endswith("_face"):
        part = "mayu"
    if mat_name.startswith("mtl_bdy"):
        src, lit, toon = dress, "color_", "toon_color_"
    elif part:
        src, lit, toon = hair, f"{part}_color_", f"{part}_toon_color_" if part != "eye" else f"{part}_color_"
    else:
        return None
    six = lambda pre: [src.get(f"{pre}{c}{i}") or "#FFFFFF" for c in "rgb" for i in (1, 2)]
    if not src:
        return None
    out = {"colors": six(lit), "toon": six(toon)}
    if part == "hair":
        # accessories (glasses...) sit lower in the base map's blue than the hair: the mob's cutoff
        # decides which of them show
        out["cutoff"] = mob.get("hair_cutoff", 0) / 10000
    return out


def convert_model(pack, out):
    roots = pack.roots()
    # chibis use pfb_mbdy / pfb_mchr / pfb_mtail; background Umas and chibis have two head parts
    body = next((n for n in roots if n.startswith(("pfb_bdy", "pfb_mbdy"))), None)
    heads = sorted(n for n in roots if n.startswith(("pfb_chr", "pfb_mchr")))
    head = heads[0] if heads else None
    tail = next((n for n in roots if n.startswith(("pfb_tail", "pfb_mtail"))), None)
    if not body:
        raise SystemExit("no body prefab in the pack")
    chara = f"{pack.info['chara']:04d}" if pack.info.get("mini") else chara_id_from(roots)

    sk = Skeleton()
    root_reader, root_t = roots[body]
    root = sk.add_tree(root_reader, root_t, None)
    for extra, attach in [(h, "Neck") for h in heads] + [(tail, "Hip")]:
        if not extra:
            continue
        _, t = roots[extra]
        for c in t.m_Children:
            r = deref(c)
            if r and go_name(r.read()) == attach:
                sk.graft(r, r.read(), sk.by_name.get(attach, root), keep_go=bool(pack.info.get("mini")))

    write_model(pack, sk, root, out, chara)
    # bone paths relative to the body root, keyed by Unity's CRC32 path hash, so motions can
    # find their bones.
    paths = {}
    for i in range(len(sk.nodes)):
        parts = sk.path(i, root).split("/")
        paths[zlib.crc32("/".join(parts).encode("utf-8"))] = sk.nodes[i]["name"]
        # head and tail clips address bones relative to their own prefab root
        for anchor in ("Neck", "Hip"):
            if anchor in parts:
                rel = "/".join(parts[parts.index(anchor):])
                paths.setdefault(zlib.crc32(rel.encode("utf-8")), sk.nodes[i]["name"])
    return {"chara": chara, "body": body, "head": head, "tail": tail, "paths": paths}


def skin_slots(indices, weights, n, bone_count):
    """Joints and weights in the four slots glTF wants. Unity keeps as many per vertex as the
    mesh's skin quality (1, 2 or 4), and a one-bone mesh can come without any weights."""
    bi = np.array(indices, dtype=np.int64).reshape(n, -1)[:, :4]
    k = bi.shape[1]
    joints = np.zeros((n, 4), np.int64)
    joints[:, :k] = np.clip(bi, 0, bone_count - 1)
    bw = np.zeros((n, 4), np.float32)
    if weights:
        w = np.array(weights, dtype=np.float32).reshape(n, -1)[:, :k]
        bw[:, :w.shape[1]] = w
    else:
        bw[:, 0] = 1
    s = bw.sum(axis=1, keepdims=True)
    s[s == 0] = 1
    return joints.astype(np.uint16), bw / s


def write_model(pack, sk, root, out, chara, tree_only=False, swap=None, fill=None):
    """model.gltf + model.bin + tex/: the skeleton and every renderer in the pack (tree_only: only
    the skinned ones whose object is in the skeleton too; swap: texture name -> one to use instead;
    fill: "texture head|tail" -> the texture for materials that ship without a main one)."""
    os.makedirs(os.path.join(out, "tex"), exist_ok=True)
    g = Gltf()
    for n in sk.nodes:
        node = {"name": n["name"], "translation": n["t"], "rotation": n["r"], "scale": n["s"]}
        if n["children"]:
            node["children"] = list(n["children"])
        g.doc["nodes"].append(node)
    g.doc["scenes"][0]["nodes"].append(root)

    tex_cache = {}

    def texture(name):
        if not name:
            return None
        if name not in tex_cache:
            o = pack.textures.get(name)
            if o is None:
                tex_cache[name] = None
            else:
                img = o.read().image
                file = f"tex/{name}.png"
                img.save(os.path.join(out, file))
                tex_cache[name] = g.image(name, file)
        return tex_cache[name]

    def material(mat_reader, smr_name):
        m = mat_reader.read()
        props = m.m_SavedProperties
        shader = deref(m.m_Shader)
        shader_name = ""
        if shader:
            try:
                shader_name = shader.read().m_ParsedForm.m_Name
            except Exception:
                shader_name = ""
        texs = {}
        for k, v in props.m_TexEnvs:
            r = deref(v.m_Texture)
            if r:
                texs[k] = r.read().m_Name
        if "tail" in m.m_Name and "_MainTex" not in texs:
            # tail textures are picked per character at runtime
            base = m.m_Name.replace("mtl_", "tex_")
            texs.update({k: v for k, v in {
                "_MainTex": f"{base}_{chara}_diff", "_ToonMap": f"{base}_{chara}_shad_c",
                "_TripleMaskMap": f"{base}_0000_base", "_OptionMaskMap": f"{base}_0000_ctrl"}.items()
                if v in pack.textures})
        info = pack.info
        if info.get("shared") and m.m_Name.startswith("mtl_bdy") and "_MainTex" not in texs:
            # shared outfits are textured at runtime from the character's skin, bust and socks
            import umadata
            part = umadata.material_part(m.m_Name)
            for slot, kind in umadata.SLOTS.items():
                for p in (part, "body"):
                    n = next((n for n in umadata.generic_texture_names(info["body_type"], info["body_sub"], info["skin"],
                                                                      info["bust"], info["socks"], kind, p)
                              if n in pack.textures), None)
                    if n:
                        texs[slot] = n
                        break
        if swap:
            texs = {k: swap.get(v, v) if swap.get(v) in pack.textures else v for k, v in texs.items()}
        if fill and "_MainTex" not in texs:
            # mtl_env_race10006_0000_002_turf00_lm00 -> the tex_env_race10006_0000_<code>_turf00 in use
            base = re.sub(r"(_lm\d+|_H)+$", "", m.m_Name.replace("mtl_", "tex_", 1))
            fam = re.fullmatch(r"(tex_.*?_)\d{3}(_.+)", base)
            name = fam and fill.get(fam.group(1) + "|" + fam.group(2))
            if name in pack.textures:
                texs["_MainTex"] = name
        if "CyalumeDefault" in shader_name and "_MainTex" not in texs:
            # the crowd's glow sticks get a song's stick sheet at runtime: one came with the pack
            texs.update({"_MainTex": n for n in pack.textures if n.startswith("tex_live_cyalume_")})
        if info.get("mini"):
            texs.update(mini_textures(pack, info, m.m_Name, texs))
        mask = None
        if info.get("mob"):
            texs.update(mob_textures(pack, info, m.m_Name, texs))
            if "_MaskColorTex" in texs:
                mask = mob_mask(info, m.m_Name)
        floats = {k: v for k, v in props.m_Floats if k in FLOAT_PARAMS or k in STAGE_FLOATS}
        colors = {k: [c.r, c.g, c.b, c.a] for k, c in props.m_Colors if k in COLOR_PARAMS or k in STAGE_COLORS}
        mat = {"name": m.m_Name, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1},
               "extras": {"shader": shader_name, "textures": {}, "floats": floats, "colors": colors, "mesh": smr_name}}
        if mask:
            mat["extras"]["mask"] = mask
        for k, name in texs.items():
            idx = texture(name)
            if idx is not None:
                mat["extras"]["textures"][k] = idx
        if "_MainTex" in mat["extras"]["textures"]:
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": mat["extras"]["textures"]["_MainTex"]}
        if any(s in shader_name for s in ("Cheek", "Tear")) or m.m_Name.endswith("_eye"):
            mat["alphaMode"] = "BLEND"
        g.doc["materials"].append(mat)
        return len(g.doc["materials"]) - 1

    def add_mesh(name, mesh_r, mats, smr=None, parent=None):
        mesh = mesh_r.read()
        h = MeshHandler(mesh)
        h.process()
        n = h.m_VertexCount
        if not n:
            return

        def channel(data, k, pad=0.0):
            # a channel is as wide as the mesh stores it (stage normals come with 4, some colors with 3)
            a = np.array(data, dtype=np.float32).reshape(n, -1)
            if a.shape[1] < k:
                a = np.hstack([a, np.full((n, k - a.shape[1]), pad, np.float32)])
            return np.ascontiguousarray(a[:, :k])

        pos = channel(h.m_Vertices, 3)
        pos[:, 0] *= -1
        attrs = {"POSITION": g.accessor(pos, FLOAT, "VEC3", ARRAY_BUFFER, minmax=True)}
        if h.m_Normals:
            nrm = channel(h.m_Normals, 3)
            nrm[:, 0] *= -1
            attrs["NORMAL"] = g.accessor(nrm, FLOAT, "VEC3", ARRAY_BUFFER)
        if h.m_UV0:
            uv = channel(h.m_UV0, 2)
            uv[:, 1] = 1 - uv[:, 1]
            attrs["TEXCOORD_0"] = g.accessor(uv, FLOAT, "VEC2", ARRAY_BUFFER)
        if h.m_UV1:
            uv1 = channel(h.m_UV1, 2)
            uv1[:, 1] = 1 - uv1[:, 1]
            attrs["TEXCOORD_1"] = g.accessor(uv1, FLOAT, "VEC2", ARRAY_BUFFER)
        if h.m_Colors:
            col = channel(h.m_Colors, 4, 1.0)
            if col.max() > 1.0:
                col /= 255.0
            attrs["COLOR_0"] = g.accessor(col, FLOAT, "VEC4", ARRAY_BUFFER)

        skin = None
        if smr is not None:
            bones = []
            for b in smr.m_Bones:
                r = deref(b)
                bones.append(sk.by_unity.get(obj_key(r), root) if r else root)
            if bones and h.m_BoneIndices:
                bi, bw = skin_slots(h.m_BoneIndices, h.m_BoneWeights, n, len(bones))
                attrs["JOINTS_0"] = g.accessor(bi, USHORT, "VEC4", ARRAY_BUFFER)
                attrs["WEIGHTS_0"] = g.accessor(bw, FLOAT, "VEC4", ARRAY_BUFFER)
                ibm = np.stack([conv_matrix(unity_matrix(m)).T for m in mesh_r.read_typetree()["m_BindPose"]])
                g.doc["skins"].append({"name": name, "joints": bones,
                                       "inverseBindMatrices": g.accessor(ibm.astype(np.float32).reshape(-1, 16), FLOAT, "MAT4"),
                                       "skeleton": root})
                skin = len(g.doc["skins"]) - 1

        prims = []
        for si, tris in enumerate(h.get_triangles()):
            # unity draws only submeshes that have a material, extra ones stay hidden
            if si >= len(mats) or mats[si] is None:
                continue
            idx = np.array(tris, dtype=np.uint32).reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)
            if not len(idx):
                continue
            prims.append({"attributes": attrs, "indices": g.accessor(idx, UINT, "SCALAR", ELEMENT_ARRAY_BUFFER),
                          "mode": 4, "material": material(mats[si], name)})
        if not prims:
            return
        g.doc["meshes"].append({"name": name, "primitives": prims})
        node = {"name": name, "mesh": len(g.doc["meshes"]) - 1}
        if skin is not None:
            node["skin"] = skin
        g.doc["nodes"].append(node)
        i = len(g.doc["nodes"]) - 1
        if parent is None:
            g.doc["scenes"][0]["nodes"].append(i)
        else:
            g.doc["nodes"][parent].setdefault("children", []).append(i)

    for o in pack.by_type.get("SkinnedMeshRenderer", []):
        smr = o.read()
        if tree_only and (o.assets_file.name, smr.m_GameObject.path_id) not in sk.by_go:
            continue
        owner = deref(smr.m_GameObject)
        mesh_r = deref(smr.m_Mesh)
        if mesh_r:
            add_mesh(owner.read().m_Name if owner else "mesh", mesh_r, [deref(m) for m in smr.m_Materials], smr=smr)

    # rigid meshes (a few props): drawn at their own transform
    filters = {}
    for o in pack.by_type.get("MeshFilter", []):
        mf = o.read()
        filters[(o.assets_file.name, mf.m_GameObject.path_id)] = mf.m_Mesh
    for o in pack.by_type.get("MeshRenderer", []):
        mr = o.read()
        key = (o.assets_file.name, mr.m_GameObject.path_id)
        mesh_r = deref(filters.get(key))
        if mesh_r and key in sk.by_go:
            owner = deref(mr.m_GameObject)
            add_mesh(owner.read().m_Name if owner else "mesh", mesh_r, [deref(m) for m in mr.m_Materials],
                     parent=sk.by_go[key])

    g.write(out, "model")
    return len(g.doc["meshes"])


def convert_prop(files, out):
    """A hand prop (3d/chara/prop/...): its own small rig, placed at the hand's attach
    bone by the viewer."""
    pack = Pack(files=files)
    roots = pack.roots()
    name = next((n for n in roots if n.startswith("pfb_chr_prop")), None) or next(iter(roots), None)
    if not name:
        raise RuntimeError("no prop in that bundle")
    sk = Skeleton()
    reader, t = roots[name]
    root = sk.add_tree(reader, t, None)
    meshes = write_model(pack, sk, root, out, "0000")
    info = {"name": name, "meshes": meshes}
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(info, f)
    return info


def convert_stage(files, out, swap=None, fill=None):
    """A concert stage (3d/env/live/liveNNNNN): every prefab its controller puts up, all at the
    origin (stage, screens, light rigs, crowd, sky), as one model. Particles and lens flares have no
    mesh renderer and stay out, so do the collision prefabs, the front-row fans (skinned, the
    controller places them in rows and animates them, left alone they lie at the origin in T-pose)
    and the source models the prefabs pull in (mdl_*, the prefabs already place them)."""
    pack = Pack(files=files)
    sk = Skeleton()
    root = sk.add("stage", None, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0])
    for name, (reader, t) in sorted(pack.roots().items()):
        if "collision" not in name and "_audience" not in name and not name.startswith("mdl_"):
            sk.add_tree(reader, t, root)
    meshes = write_model(pack, sk, root, out, "0000", tree_only=True, swap=swap, fill=fill)
    info = {"name": os.path.basename(out), "meshes": meshes}
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(info, f)
    return info


# --- animation ---------------------------------------------------------------------------


def parse_streamed(words):
    data = struct.pack(f"<{len(words)}I", *words)
    frames, pos = [], 0
    while pos + 8 <= len(data):
        time, count = struct.unpack_from("<fI", data, pos)
        pos += 8
        keys = []
        for _ in range(count):
            idx, c0, c1, c2, c3 = struct.unpack_from("<i4f", data, pos)
            pos += 20
            keys.append((idx, (c0, c1, c2, c3)))
        frames.append((time, keys))
    return frames


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def euler_to_quat(x, y, z):
    """Unity euler degrees -> quaternion (x, y, z, w) in Unity space. Unity rotates
    about Z, then X, then Y, i.e. q = qY * qX * qZ."""
    hx, hy, hz = (math.radians(a) / 2 for a in (x, y, z))
    qx = (math.sin(hx), 0.0, 0.0, math.cos(hx))
    qy = (0.0, math.sin(hy), 0.0, math.cos(hy))
    qz = (0.0, 0.0, math.sin(hz), math.cos(hz))
    return qmul(qmul(qy, qx), qz)


def track(bone, kind, v):
    """One sampled Unity-space curve (frames x 3, or x 4 for quaternions) as a
    three.js track."""
    if kind == "position":
        out = np.stack([-v[:, 0], v[:, 1], v[:, 2]], axis=1)
    elif kind == "scale":
        out = v
    else:
        q = v if kind == "quaternion" else np.array([euler_to_quat(*row) for row in v])
        out = np.stack([q[:, 0], -q[:, 1], -q[:, 2], q[:, 3]], axis=1)
        out /= np.linalg.norm(out, axis=1, keepdims=True).clip(1e-9)
        kind = "quaternion"
    # constant tracks shrink to one key
    if np.allclose(out, out[0], atol=1e-6):
        out = out[:1]
    return {"bone": bone, "type": kind, "values": np.round(out, 5).reshape(-1).tolist()}


def convert_clip(reader, paths):
    t = reader.read_typetree()
    if t.get("m_Legacy") and not t["m_ClipBindingConstant"]["genericBindings"]:
        return convert_legacy_clip(t, paths)
    mc = t["m_MuscleClip"]
    clip = mc["m_Clip"]["data"]
    fps = t["m_SampleRate"] or 30.0
    start, stop = mc["m_StartTime"], mc["m_StopTime"]
    count = max(1, int(round((stop - start) * fps)) + 1)
    times = np.array([start + i / fps for i in range(count)], dtype=np.float64)

    streamed_n = clip["m_StreamedClip"]["curveCount"]
    dense = clip["m_DenseClip"]
    dense_n = dense["m_CurveCount"]
    const = clip["m_ConstantClip"]["data"]
    total = streamed_n + dense_n + len(const)
    values = np.zeros((count, total), dtype=np.float64)

    # streamed: piecewise cubics, each key valid from its frame time to the curve's next key
    if streamed_n:
        keys = {}
        for time, ks in parse_streamed(clip["m_StreamedClip"]["data"]):
            for idx, co in ks:
                keys.setdefault(idx, []).append((time, co))
        for idx, ks in keys.items():
            if idx >= streamed_n:
                continue
            ks.sort(key=lambda k: k[0])
            kt = np.array([k[0] for k in ks])
            j = np.searchsorted(kt, times, side="right") - 1
            for fi in range(count):
                k = max(j[fi], 0)
                kt0, (c0, c1, c2, c3) = ks[k]
                dt = times[fi] - kt0 if math.isfinite(kt0) else 0.0
                if j[fi] < 0:
                    dt = 0.0
                values[fi, idx] = ((c0 * dt + c1) * dt + c2) * dt + c3

    if dense_n:
        arr = np.array(dense["m_SampleArray"], dtype=np.float64).reshape(-1, dense_n)
        frame = np.clip(np.round((times - dense["m_BeginTime"]) * dense["m_SampleRate"]).astype(int), 0, len(arr) - 1)
        values[:, streamed_n:streamed_n + dense_n] = arr[frame]
    if const:
        values[:, streamed_n + dense_n:] = np.array(const, dtype=np.float64)

    tracks, col, missing = [], 0, 0
    for b in t["m_ClipBindingConstant"]["genericBindings"]:
        attr = b["attribute"]
        width = 4 if attr == 2 else 3
        if b["typeID"] != 4 or attr not in (1, 2, 3, 4):
            # not a Transform curve (blend shapes, material params...), but these still occupy curve
            # slots, one each
            col += 1
            continue
        bone = paths.get(b["path"])
        v = values[:, col:col + width]
        col += width
        if bone is None:
            missing += 1
            continue
        tracks.append(track(bone, {1: "position", 2: "quaternion", 3: "scale", 4: "euler"}[attr], v))
    return {"name": t["m_Name"], "fps": fps, "duration": float(stop - start), "frames": count,
            "tracks": tracks, "unmapped": missing}


LEGACY_CURVES = (("m_PositionCurves", "position", "xyz"), ("m_RotationCurves", "quaternion", "xyzw"),
                 ("m_EulerCurves", "euler", "xyz"), ("m_ScaleCurves", "scale", "xyz"))


def sample_curve(keys, comps, times):
    """A Unity AnimationCurve of vector keys at the given times: cubic Hermite between
    keys, held flat outside them, stepped where a slope is infinite."""
    kt = np.array([k["time"] for k in keys])
    v = np.array([[k["value"][c] for c in comps] for k in keys])
    if len(keys) == 1:
        return np.repeat(v, len(times), axis=0)
    out_s = np.array([[k["outSlope"][c] for c in comps] for k in keys])
    in_s = np.array([[k["inSlope"][c] for c in comps] for k in keys])
    j = np.clip(np.searchsorted(kt, times, side="right") - 1, 0, len(kt) - 2)
    d = (kt[j + 1] - kt[j])[:, None]
    u = np.clip((times - kt[j])[:, None] / np.where(d > 0, d, 1), 0, 1)
    u2, u3 = u * u, u * u * u
    with np.errstate(invalid="ignore", over="ignore"):
        m0, m1 = out_s[j] * d, in_s[j + 1] * d
        out = (2 * u3 - 3 * u2 + 1) * v[j] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v[j + 1] + (u3 - u2) * m1
    return np.where(np.isfinite(m0) & np.isfinite(m1), out, v[j])


def convert_legacy_clip(t, paths):
    """Legacy clips (the dances) keep keyframed curves per transform path instead of a
    muscle clip."""
    by_leaf = {n: n for n in paths.values()}
    curves = [(c, kind, comps) for field, kind, comps in LEGACY_CURVES for c in t.get(field) or []
              if c["curve"]["m_Curve"]]
    fps = t["m_SampleRate"] or 30.0
    duration = max((c["curve"]["m_Curve"][-1]["time"] for c, _, _ in curves), default=0.0)
    count = max(1, int(round(duration * fps)) + 1)
    times = np.arange(count) / fps
    tracks, missing = [], 0
    for c, kind, comps in curves:
        bone = paths.get(zlib.crc32(c["path"].encode("utf-8"))) or by_leaf.get(c["path"].rsplit("/", 1)[-1])
        if bone is None:
            missing += 1
            continue
        tracks.append(track(bone, kind, sample_curve(c["curve"]["m_Curve"], comps, times)))
    return {"name": t["m_Name"], "fps": fps, "duration": float(duration), "frames": count,
            "tracks": tracks, "unmapped": missing}


# --- facial expressions ------------------------------------------------------------------

# Gallop.FaceEyeType / FaceEyebrowType / FaceMouthType in declaration order, the facial
# target arrays are indexed by these.
EYE_TYPES = ("Base HalfA CloseA HalfB HalfC WaraiA WaraiB WaraiC WaraiD IkariA KanasiA DereA OdorokiA OdorokiB "
             "OdorokiC JitoA KusyoA UreiA RunA DrivenA XRange YRange EyeHideA SeriousA PupilA PupilB PupilC "
             "EyelidHideA EyelidHideB").split()
EYEBROW_TYPES = ("Base WaraiA WaraiB WaraiC WaraiD IkariA KanasiA DoyaA DereA OdorokiA OdorokiB JitoA KomariA KusyoA "
                 "UreiA RunA RunB SeriousA SeriousB ShiwaA ShiwaB Offset_U Offset_D Offset_L Offset_R").split()
MOUTH_TYPES = ("Base Normal CheekA_L CheekA_R WaraiA WaraiB WaraiC WaraiD WaraiE IkariA IkariB KanasiA DoyaA DereA "
               "OdorokiA OdorokiB JitoA KomariA KusyoA_L KusyoA_R KusyoB_L KusyoB_R UreiA TalkA_A_S TalkA_A_L "
               "TalkA_I_S TalkA_I_L TalkA_U_S TalkA_U_L TalkA_E_S TalkA_E_L TalkA_O_S TalkA_O_L TalkB_A_S TalkB_A_L "
               "TalkB_I_S TalkB_I_L TalkB_E_S TalkB_E_L RunA RunB DrivenA ToothHide TalkC_I TanA TanB TanC_L TanD_L "
               "TanC_R TanD_R Offset_U Offset_D Offset_L Offset_R Scale_U Scale_D LowAngle").split()


def trs(t):
    p, r, sc = t["_position"], t["_rotation"], t["_scale"]
    return [p["x"], p["y"], p["z"], r["x"], r["y"], r["z"], sc["x"], sc["y"], sc["z"]]


def convert_face(pack):
    """The head's facial targets: per part and side, the bones, their rest transform
    (entry 0) and one offset per shape. Values stay in Unity space (Euler degrees);
    the viewer converts after blending, as the game does."""
    target = None
    for o in pack.by_type.get("MonoBehaviour", []):
        try:
            d = o.read_typetree()
        except Exception:
            continue
        if d.get("m_Name", "").endswith("_facial_target") and "_eyeTarget" in d:
            target = d
            break
    if target is None:
        return None
    face = {}
    for part, key, names in (("eye", "_eyeTarget", EYE_TYPES), ("eyebrow", "_eyebrowTarget", EYEBROW_TYPES),
                             ("mouth", "_mouthTarget", MOUTH_TYPES)):
        entries = target[key]
        groups = []
        for gi in range(len(entries[0]["_faceGroupInfo"])):
            bones = [t["_path"].split("/")[-1] for t in entries[0]["_faceGroupInfo"][gi]["_trsArray"]]
            r, l = sum(b.endswith("_R") for b in bones), sum(b.endswith("_L") for b in bones)
            side = "R" if r > 2 * l else "L" if l > 2 * r else "C"
            shapes = [[round(v, 6) for t in e["_faceGroupInfo"][gi]["_trsArray"] for v in trs(t)] for e in entries]
            groups.append({"side": side, "bones": bones, "shapes": shapes})
        face[part] = {"names": names[:len(entries)], "groups": groups}

    presets = []
    import gamepaths
    if os.path.exists(gamepaths.master()):
        import sqlite3
        db = sqlite3.connect(f"file:{gamepaths.master()}?mode=ro", uri=True)
        for row in db.execute("SELECT label, eyebrow_l, eyebrow_r, eye_l, eye_r, mouth FROM face_type_data"):
            presets.append(dict(zip(("label", "eyebrow_l", "eyebrow_r", "eye_l", "eye_r", "mouth"), row)))
        db.close()
    face["presets"] = presets
    return face


# --- physics (CySpring) ----------------------------------------------------------------

def convert_physics(pack):
    """The cloth assets as the game reads them, for cyspring.py: the CySpringDataContainer
    of the head, the outfit, its bust and the tail, and the outfit's skirt data."""
    containers, skirt = {}, None
    for o in pack.by_type.get("MonoBehaviour", []):
        try:
            d = o.read_typetree()
        except Exception:
            continue
        if "springParam" in d:
            r = o.read()
            name = r.m_GameObject.read().m_Name if r.m_GameObject else ""
            kind = ("bust" if "_bust" in name else "body") if name.startswith(("pfb_bdy", "pfb_mbdy")) else                 "head" if name.startswith(("pfb_chr", "pfb_mchr")) else "tail" if name.startswith(("pfb_tail", "pfb_mtail")) else None
            if kind:
                d.pop("m_Script", None)
                d.pop("m_GameObject", None)
                containers[kind] = d
        elif "_skirtBone" in d:
            d.pop("m_Script", None)
            d.pop("m_GameObject", None)
            skirt = d
    if not containers:
        return None
    return {"containers": containers, "skirt": skirt}


PROCESS_KINDS = ("position", "rotation", "scale")


def convert_process(pack):
    """Outfit helper bones (Tp_*) the game moves from other bones' angles: the body's
    transform_process_data, ProcessId 1 (Gallop TransformExpression_AddPosition_FromAngle,
    whose ASSET_* constants name the value slots: angle axis, min and max angle, add type,
    add x/y/z). Each entry: one Euler axis of a source bone's rotation from its rest, an
    angle range (degrees) mapped to 0..1, and the helper's offset from rest at 1. The add
    types' meaning (position m, rotation degrees, scale) is read from the values' sizes.
    Values are stored x10000."""
    out = []
    for o in pack.by_type.get("MonoBehaviour", []):
        try:
            d = o.read_typetree()
        except Exception:
            continue
        for t in d.get("TargetDataArray") or []:
            v, s = t.get("ValueParameterArray") or [], t.get("StringParameterArray") or []
            if t.get("ProcessId") != 1 or len(v) < 7 or not s or not 0 <= v[3] < len(PROCESS_KINDS):
                continue
            out.append({"target": t["TargetTransformName"], "source": s[0], "axis": v[0], "from": v[1] / 1e4,
                        "to": v[2] / 1e4, "kind": PROCESS_KINDS[v[3]], "value": [x / 1e4 for x in v[4:7]]})
    return out


def convert(pack_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    pack = Pack(pack_dir)
    info = convert_model(pack, out_dir)
    motions_dir = os.path.join(out_dir, "motions")
    os.makedirs(motions_dir, exist_ok=True)
    motions = []
    for o in pack.by_type.get("AnimationClip", []):
        try:
            m = convert_clip(o, info["paths"])
        except Exception as e:
            print(f"  skipped a clip: {e}", file=sys.stderr)
            continue
        if not m["tracks"]:
            continue
        with open(os.path.join(motions_dir, m["name"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(m, f, separators=(",", ":"))
        motions.append({"name": m["name"], "duration": m["duration"], "frames": m["frames"], "tracks": len(m["tracks"])})
    motions.sort(key=lambda m: m["name"])
    # bone path hashes, so motions fetched later (the library) can be converted against this
    # skeleton too.
    with open(os.path.join(out_dir, "paths.json"), "w", encoding="utf-8") as f:
        json.dump({str(k): v for k, v in info["paths"].items()}, f)
    physics = convert_physics(pack)
    if physics:
        with open(os.path.join(out_dir, "physics.json"), "w", encoding="utf-8") as f:
            json.dump(physics, f, separators=(",", ":"))
    face = convert_face(pack)
    if face:
        with open(os.path.join(out_dir, "face.json"), "w", encoding="utf-8") as f:
            json.dump(face, f, separators=(",", ":"))
    manifest = {"chara": info["chara"], "body": info["body"], "head": info["head"], "tail": info["tail"],
                "motions": motions, "face": bool(face), "physics": bool(physics), "process": convert_process(pack)}
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    return manifest


def convert_clip_bundle(bundle_file, paths):
    """Every AnimationClip in one exported bundle, against a known path map."""
    env = UnityPy.load(bundle_file)
    out = []
    for o in env.objects:
        if o.type.name == "AnimationClip":
            m = convert_clip(o, paths)
            if m["tracks"]:
                out.append(m)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: umaconv.py <pack folder> <output folder>")
    m = convert(sys.argv[1], sys.argv[2])
    print(f"{m['body']} + {m['head']} + {m['tail']}, {len(m['motions'])} motions")
