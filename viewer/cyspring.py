"""The game's spring-bone physics (CySpring), run by the game's own native plugin.

Hair, ears, bust and tail are simulated by CySpringPlugin.dll from the game folder,
fed the way the game feeds it: the cloth assets' parameters and collision spheres,
the animated pose every tick, and 60 Hz steps. All values here are Unity space and
relative to the character root (the game also zeroes the owner while simulating);
the viewer converts at its side.

Setup follows Gallop's managed wrapper (CySpringController / CySpring / CySpringRootBone /
CySpringBoneBase): parts head (+ bust as its add data), body and tail; bones gathered
depth-first under each root; collisions placed relative to their target bone.
"""
import array
import ctypes
import math
import os
import re
import struct

# NativeClothWorking (0x168 bytes)
INIT_LOCAL, PARENT_ROT, FINAL_ROT = 0x000, 0x010, 0x020
BONE_AXIS, TARGET, PREV_TARGET, AIM, SELF_POS = 0x030, 0x040, 0x050, 0x070, 0x090
LIMIT_MIN, LIMIT_MAX = 0x0A0, 0x0B0
INIT_DIST, STIFF, DRAG, COL_RADIUS, GRAVITY = 0x0C0, 0x0C4, 0x0C8, 0x0CC, 0x0D0
WIND = 0x0D4                       # vertical slow, vertical fast, horizontal slow, horizontal fast
CHECK_COL, IS_LIMIT, ACTIVE_COL = 0x0E4, 0x0EC, 0x0F0
CINDEX_LO, CINDEX_HI = 0x0F4, 0x154  # 8 + 8 int16 collision indices
DYN_RATIO, ANIM_ROT = 0x104, 0x108
MOVE_RATE, PARENT_WORK, IS_ADD = 0x13C, 0x140, 0x164
WORK = 0x168
# NativeClothCollision (0x4C bytes). ffs: the solver skips every collision whose enable flag is 0.
# IsCharaCollision ones are skipped for bones that don't check collisions
C_POS, C_POS2, C_NORMAL, C_TYPE, C_INNER, C_RADIUS, C_DIST, C_PARENT = 0x00, 0x10, 0x20, 0x30, 0x34, 0x38, 0x3C, 0x40
C_ENABLED, C_CHARA = 0x44, 0x48
COL = 0x4C
# NativeRootParentWork (0x20 bytes): position, rotation
PARENT = 0x20
# NativeSkirt (0x60 bytes), one per skirt panel: its root and target positions, the outward
# normal, the axis it swings out about, which legs it checks (right knee, left knee, right ankle,
# left ankle) and the angle NativeSkirtUpdate works out
SK_ROOT, SK_TARGET, SK_NORMAL, SK_AXIS, SK_CHECK, SK_ANGLE = 0x00, 0x10, 0x20, 0x30, 0x40, 0x50
SKIRT = 0x60
# NativeSkirtArg (0x70 bytes): knee L, knee R, ankle L, ankle R, the center bone, the origin,
# then knee radius, ankle radius, influence angle and max angle (degrees)
SA_LEGS, SA_CENTER, SA_ORIGIN, SA_PARAMS = 0x00, 0x40, 0x50, 0x60
SKIRT_ARG = 0x70

SPHERE, NONE, CAPSULE, PLANE = 0, 1, 2, 3
MAX_COLLISIONS = 16                # index slots per bone on the native side
MIN_BONE_DISTANCE = 1e-4
# springs that also collide with the body fitted to her outfit (bodyfit.js): hair, and ties,
# ribbons and collars on the chest and neck. not the bust (inside her), ears, tail or the hips' cloth
BODY_SPRINGS = re.compile(r"^Sp_(He_Hair|Ch_(?!Bust)|Ne_)")
TICK = 1 / 60
PARTS = ("head", "body", "tail")


# --- plugin ------------------------------------------------------------------------------

DLL = os.path.join("UmamusumePrettyDerby_Data", "Plugins", "x86_64", "CySpringPlugin.dll")
_dll = None


def find_game():
    """The game's install folder (Steam's library list, or the folder the user picked)."""
    import gamepaths
    game = gamepaths.game()
    return game if game and os.path.exists(os.path.join(game, DLL)) else None


def plugin():
    """The game's CySpringPlugin.dll, loaded once."""
    global _dll
    if _dll is None:
        game = find_game()
        if not game:
            raise RuntimeError("CySpringPlugin.dll was not found: is the game installed through Steam?")
        dll = ctypes.CDLL(os.path.join(game, DLL))
        tail = [ctypes.c_float] * 7 + [ctypes.c_bool, ctypes.c_float, ctypes.c_bool] + [ctypes.c_float] * 3
        f = dll.NativeClothUpdate
        f.restype = None
        f.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p] + tail
        # same, with the skirt panel and the legs in front of the parent work
        f = dll.NativeClothSkirtUpdate
        f.restype = None
        f.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p] + tail
        _dll = dll
    return _dll


# --- math (Unity conventions: quaternions x, y, z, w) -------------------------------------

def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qinv(q):
    return (-q[0], -q[1], -q[2], q[3])


def qrot(q, v):
    x, y, z, w = q
    tx, ty, tz = 2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])
    return (v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx)


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def mul3(a, b):
    return (a[0] * b[0], a[1] * b[1], a[2] * b[2])


def length(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def normalize(a):
    n = length(a)
    return scale(a, 1 / n) if n > 1e-12 else (0.0, 0.0, 0.0)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def from_to(a, b):
    a, b = normalize(a), normalize(b)
    c = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    w = 1 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    if w < 1e-6:
        axis = normalize((0.0, -a[2], a[1]) if abs(a[0]) < 0.9 else (-a[2], 0.0, a[0]))
        return (axis[0], axis[1], axis[2], 0.0)
    n = math.sqrt(c[0] ** 2 + c[1] ** 2 + c[2] ** 2 + w * w)
    return (c[0] / n, c[1] / n, c[2] / n, w / n)


class Xf:
    """A transform as position, rotation and (lossy) scale, enough for TRS chains."""
    __slots__ = ("p", "q", "s")

    def __init__(self, p, q, s=(1.0, 1.0, 1.0)):
        self.p, self.q, self.s = tuple(p), tuple(q), tuple(s)

    def point(self, v):
        return add(self.p, qrot(self.q, mul3(self.s, v)))

    def child(self, p, q, s):
        return Xf(self.point(p), qmul(self.q, q), mul3(self.s, s))


# --- struct access --------------------------------------------------------------------------

def put3(buf, off, v):
    struct.pack_into("<3f", buf, off, *v)


def put4(buf, off, q):
    struct.pack_into("<4f", buf, off, *q)


def putf(buf, off, x):
    struct.pack_into("<f", buf, off, x)


def puti(buf, off, x):
    struct.pack_into("<i", buf, off, x)


def get3(buf, off):
    return struct.unpack_from("<3f", buf, off)


def get4(buf, off):
    return struct.unpack_from("<4f", buf, off)


def getf(buf, off):
    return struct.unpack_from("<f", buf, off)[0]


def v3(d):
    return (float(d["x"]), float(d["y"]), float(d["z"]))


# --- the simulation -----------------------------------------------------------------------

class Bone:
    __slots__ = ("node", "name", "element", "index", "parent_bone", "exist", "end_sim", "first_local_pos",
                 "init_rot_inv")

    def __init__(self, node, name, element, parent_bone):
        self.node, self.name, self.element, self.parent_bone = node, name, element, parent_bone
        self.index = 0
        self.exist = True
        self.end_sim = True
        self.first_local_pos = (0.0, 0.0, 0.0)
        self.init_rot_inv = (0.0, 0.0, 0.0, 1.0)


class Root:
    def __init__(self, part, element, is_add, bones):
        self.part, self.element, self.is_add, self.bones = part, element, is_add, bones
        self.buf = ctypes.create_string_buffer(WORK * len(bones))
        self.count = len(bones)
        self.skirt = None   # set when the game's skirt controller drives this root


class Part:
    def __init__(self, name, main, add_data):
        self.name, self.main, self.add = name, main, add_data
        self.collisions = []      # dicts: name, node, type, radius, pos, pos2, normal, distance
        self.roots = []
        self.col_buf = None


class Simulation:
    """One character's springs. `nodes` is the rest skeleton: [name, parent index or -1,
    local position, local rotation, local scale], Unity space, root at the origin."""

    def __init__(self, physics, nodes, body_fit=None):
        self.dll = plugin()
        self.names = [n[0] for n in nodes]
        self.parent = [n[1] for n in nodes]
        self.rest_t = [tuple(n[2]) for n in nodes]
        self.rest_r = [tuple(n[3]) for n in nodes]
        self.rest_s = [tuple(n[4]) for n in nodes]
        self.children = [[] for _ in nodes]
        for i, p in enumerate(self.parent):
            if p >= 0:
                self.children[p].append(i)
        self.world = []
        for i in range(len(nodes)):
            p = self.parent[i]
            base = self.world[p] if p >= 0 else Xf((0, 0, 0), (0, 0, 0, 1))
            self.world.append(base.child(self.rest_t[i], self.rest_r[i], self.rest_s[i]))
        self.by_name = {}
        for i, n in enumerate(self.names):
            self.by_name.setdefault(n, i)

        conts = physics.get("containers", {})
        head, bust, body, tail = (conts.get(k) for k in ("head", "bust", "body", "tail"))
        self.hip = self.by_name.get("Hip", -1)
        self.parts = []
        self.work_nodes = []      # parent transforms gathered every tick, in RootParentWork order
        work_index = {}

        def work(node):
            if node not in work_index:
                work_index[node] = len(self.work_nodes)
                self.work_nodes.append(node)
            return work_index[node]

        # collision objects per part: head (+ bust as add data), body, tail. a spring can name a
        # collider another part made (the tail's Col_B_*_Tail sit in the body's list), so every part
        # also gets those. the body gives up the tail's ones unless its own springs use them too.
        made = {}
        cols = {"head": self.make_collisions(head, bust, made), "body": self.make_collisions(body, None, made),
                "tail": self.make_collisions(tail, None, made)}
        for name, main, extra in (("head", head, bust), ("body", body, None), ("tail", tail, None)):
            if main is None:
                continue
            want = collision_names(main) | (collision_names(extra) if extra else set())
            have = {c["name"] for c in cols[name]}
            cols[name] += [made[n] for n in sorted(want - have) if n in made]
        if tail is not None and body is not None:
            tail_only = collision_names(tail) - collision_names(body)
            cols["body"] = [c for c in cols["body"] if c["name"] not in tail_only]
        self.body = self.make_body(body_fit or {})
        if self.body:
            cols["head"] += self.body
            cols["body"] += self.body
        for name, main, extra in (("head", head, bust), ("body", body, None), ("tail", tail, None)):
            if main is None:
                continue
            part = Part(name, main, extra)
            part.collisions = cols[name]
            self.bind(part)
            self.parts.append(part)
        # RootParentWork: roots' parents, then collision targets, part by part
        for part in self.parts:
            for root in part.roots:
                puti(root.buf, PARENT_WORK, work(self.parent[root.bones[0].node]))
            for k, c in enumerate(part.collisions):
                puti(part.col_buf, k * COL + C_PARENT, work(c["node"]))
        self.skirt_arg = None
        self.setup_skirt(physics.get("skirt"), work)
        self.work_buf = ctypes.create_string_buffer(PARENT * max(1, len(self.work_nodes)))
        self.roots = [root for part in self.parts for root in part.roots]
        self.bones = [b for root in self.roots for b in root.bones]
        self.hip_prev = None
        self.zero_dt = True

    # -- loading ---------------------------------------------------------------------------

    def make_collisions(self, main, extra, made):
        out = []
        lists = [main.get("collisionParam", [])] if main else []
        if extra:
            have = {c["_collisionName"] for c in lists[0]} if lists else set()
            lists.append([c for c in extra.get("collisionParam", []) if c["_collisionName"] not in have])
        for lst in lists:
            for c in lst:
                name, target = c["_collisionName"], c["_targetObjectName"]
                if not name or name == "None" or not target or target == "None" or c["_radius"] == 0:
                    continue
                node = self.by_name.get(target)
                if node is None:
                    continue
                if name in made:
                    out.append(made[name])
                    continue
                kind = int(c["_type"])
                offset, offset2 = v3(c["_offset"]), v3(c["_offset2"])
                col = {"name": name, "node": node, "type": kind, "radius": float(c["_radius"]),
                       "inner": int(bool(c["_isInner"])), "pos": (0.0, 0.0, 0.0), "pos2": (0.0, 0.0, 0.0),
                       "normal": (0.0, 0.0, 0.0), "distance": 0.0}
                ls = self.world[node].s
                if kind == SPHERE:
                    col["pos"] = mul3(offset, ls)
                elif kind == CAPSULE:
                    col["pos"] = mul3(offset, ls)
                    col["pos2"] = mul3(offset2, ls)
                elif kind == PLANE:
                    # placed in world space at load, its forward is the plane normal
                    rot = from_to((0.0, 1.0, 0.0), v3(c["_normal"]))
                    fwd = qrot(rot, (0.0, 0.0, 1.0))
                    col["normal"] = fwd
                    col["distance"] = (self.world[node].p[0] * fwd[0] + self.world[node].p[1] * fwd[1]
                                       + self.world[node].p[2] * fwd[2])
                made[name] = col
                out.append(col)
        return out

    def make_body(self, fit):
        """Collision objects for the shapes bodyfit.js fitted to her outfit: {bone, a, b, r} with
        a and b in the bone's space (unity axes), plus the clearance on top of every radius."""
        out = []
        extra = float(fit.get("clearance", 0.0))
        for k, c in enumerate(fit.get("shapes", [])):
            node = self.by_name.get(c["bone"])
            if node is None:
                continue
            ls = self.world[node].s
            a, b = mul3(tuple(c["a"]), ls), mul3(tuple(c["b"]), ls)
            kind = CAPSULE if length(sub(a, b)) > 1e-4 else SPHERE
            out.append({"name": f"UmaStudio_Body{k}", "node": node, "type": kind, "radius": float(c["r"]) + extra,
                        "inner": 0, "pos": a, "pos2": b if kind == CAPSULE else (0.0, 0.0, 0.0),
                        "normal": (0.0, 0.0, 0.0), "distance": 0.0})
        return out

    def body_gap(self, c, p):
        """How far rest-pose point p is outside body collider c (negative: inside)."""
        w = self.world[c["node"]]
        a = add(w.p, qrot(w.q, c["pos"]))
        if c["type"] == CAPSULE:
            b = add(w.p, qrot(w.q, c["pos2"]))
            ab = sub(b, a)
            t = max(0.0, min(1.0, dot(sub(p, a), ab) / max(dot(ab, ab), 1e-12)))
            a = add(a, scale(ab, t))
        return length(sub(p, a)) - c["radius"]

    def body_for(self, root, b, free):
        """The body colliders spring bone b checks: the nearest ones that fit in its free slots,
        leaving out any its chain starts well inside (it would be shoved out every tick)."""
        if not self.body or free <= 0 or not BODY_SPRINGS.match(b.name):
            return []
        start, here = self.world[root.bones[0].node].p, self.world[b.node].p
        ok = [c for c in self.body if self.body_gap(c, start) > -0.02]
        ok.sort(key=lambda c: self.body_gap(c, here))
        return [c["name"] for c in ok[:free]]

    def setup_skirt(self, data, work):
        """The game's SkirtController: skirt panels swing out of the way of the knees (and the
        ankles on long skirts) instead of the legs going through them. NativeClothSkirtUpdate keeps
        a panel's bones outside a plane through its root, turned out by the angle it finds to clear
        the legs. The managed side that fills normal and axis can't be read, so they come from the
        rest pose here: outward from the center bone, and the axis that swings the panel that way."""
        if not data or not data.get("m_Enabled", 1):
            return
        legs = [self.by_name.get(data.get(k) or "")
                for k in ("_kneeLBoneName", "_kneeRBoneName", "_ankleLBoneName", "_ankleRBoneName")]
        center = self.by_name.get(data.get("_centerBoneName") or "")
        if center is None or (legs[0] is None and legs[1] is None):
            return
        knee_r, ankle_r = float(data.get("_kneeColliderRadius", 0.0)), float(data.get("_ankleColliderRadius", 0.0))
        roots = {self.names[r.bones[0].node]: r for part in self.parts for r in part.roots}
        for e in data.get("_skirtBone", []):
            root, target = roots.get(e["_rootBoneName"]), self.by_name.get(e["_childBoneName"])
            if root is None or target is None:
                continue
            node = root.bones[0].node
            parent = self.parent[node]
            if data.get("IsOffsetAngleTargetEndNode"):
                chain = {b.node for b in root.bones}
                while True:
                    nxt = [c for c in self.children[target] if c in chain]
                    if not nxt:
                        break
                    target = nxt[0]
            r, t, c = self.world[node].p, self.world[target].p, self.world[center].p
            u = normalize(sub(t, r))
            out = sub(r, c)
            n = normalize(sub(out, scale(u, dot(out, u))))
            a = normalize(cross(u, n))
            if length(n) < 0.5 or length(a) < 0.5:
                continue
            inv = qinv(self.world[parent].q)
            buf = ctypes.create_string_buffer(SKIRT)
            right, left = bool(e.get("_isCheckRightLeg")), bool(e.get("_isCheckLeftLeg"))
            struct.pack_into("<4i", buf, SK_CHECK, right and legs[1] is not None, left and legs[0] is not None,
                             right and legs[3] is not None and ankle_r > 0, left and legs[2] is not None and ankle_r > 0)
            root.skirt = {"parent": parent, "target": qrot(inv, sub(t, r)), "normal": qrot(inv, n),
                          "axis": qrot(inv, a), "buf": buf}
        if not any(getattr(r, "skirt", None) for r in roots.values()):
            return
        self.skirt_arg = ctypes.create_string_buffer(SKIRT_ARG)
        struct.pack_into("<4f", self.skirt_arg, SA_PARAMS, knee_r, ankle_r,
                         float(data.get("_influenceAngle", 0.0)), float(data.get("_influenceMaxAngle", 0.0)))
        self.skirt_legs = [work(n) if n is not None else None for n in legs]
        self.skirt_center = work(center)

    def put_skirt_arg(self, parents):
        a = self.skirt_arg
        for k, w in enumerate(self.skirt_legs):
            # a missing leg sits far away, its check is off anyway
            put3(a, SA_LEGS + 0x10 * k, parents[w][0] if w is not None else (0.0, -100.0, 0.0))
        put3(a, SA_CENTER, parents[self.skirt_center][0])

    def bind(self, part):
        table = {}
        for k, c in enumerate(part.collisions):
            table.setdefault(c["name"], k)
        main_names = set()
        for element in part.main.get("springParam", []):
            main_names.add(element["_boneName"])
            self.create_root(part, element, False, table)
        if part.add:
            for element in part.add.get("springParam", []):
                if element["_boneName"] not in main_names:
                    self.create_root(part, element, True, table)
        # collisions: parameters are local to the target bone
        part.col_buf = ctypes.create_string_buffer(COL * max(1, len(part.collisions)))
        for k, c in enumerate(part.collisions):
            o = k * COL
            put3(part.col_buf, o + C_POS, c["pos"])
            put3(part.col_buf, o + C_POS2, c["pos2"])
            put3(part.col_buf, o + C_NORMAL, c["normal"])
            puti(part.col_buf, o + C_TYPE, c["type"])
            puti(part.col_buf, o + C_INNER, c["inner"])
            putf(part.col_buf, o + C_RADIUS, c["radius"])
            putf(part.col_buf, o + C_DIST, c["distance"])
            puti(part.col_buf, o + C_ENABLED, 1)
        for root in part.roots:
            for b in root.bones:
                o = b.index * WORK
                names = [n for n in b.element.get("_collisionNameList", []) if n in table]
                names += self.body_for(root, b, MAX_COLLISIONS - len(names))
                active = 0
                for n in names:
                    k = table.get(n)
                    if k is None or active == MAX_COLLISIONS:
                        continue
                    if active < 8:
                        struct.pack_into("<h", root.buf, o + CINDEX_LO + 2 * active, k)
                    elif active < 16:
                        struct.pack_into("<h", root.buf, o + CINDEX_HI + 2 * (active - 8), k)
                    active += 1
                puti(root.buf, o + ACTIVE_COL, active)
                puti(root.buf, o + CHECK_COL, 1)
                self.apply_params(root, b)
        self.reset_part(part, {})

    def create_root(self, part, element, is_add, table):
        node = self.by_name.get(element["_boneName"])
        if node is None:
            return
        allowed = {c["_boneName"] for c in element.get("_childElements", [])}
        by_child = {c["_boneName"]: c for c in element.get("_childElements", [])}
        bones = [Bone(node, element["_boneName"], element, None)]

        def walk(bone):
            for ch in self.children[bone.node]:
                n = self.names[ch]
                if n in table or n not in allowed:
                    continue
                b = Bone(ch, n, by_child[n], bone)
                bones.append(b)
                walk(b)
        walk(bones[0])
        root = Root(part, element, is_add, bones)
        last = len(bones) - 1
        for i, b in enumerate(bones):
            self.initialize(root, b, i, i == last and i > 0)
        n = root.count
        if last > 0 and not bones[last].end_sim:
            n -= 1
        root.count = n
        part.roots.append(root)

    def initialize(self, root, b, idx, is_end):
        b.index = idx
        o = idx * WORK
        buf = root.buf
        w = self.world[b.node]
        if idx > 0:
            # bones after the root start from the wrapper's defaults
            putf(buf, o + STIFF, 0.0001)
            putf(buf, o + DRAG, 0.05)
            putf(buf, o + COL_RADIUS, 0.01)
            put3(buf, o + BONE_AXIS, (0.0, 1.0, 0.0))
            struct.pack_into("<4f", buf, o + WIND, 1.0, 1.0, 1.0, 1.0)
            putf(buf, o + MOVE_RATE, 1.0)
            puti(buf, o + IS_ADD, int(root.is_add))
        b.init_rot_inv = qinv(w.q)
        put4(buf, o + INIT_LOCAL, self.rest_r[b.node])
        put3(buf, o + TARGET, w.p)
        put3(buf, o + PREV_TARGET, w.p)
        puti(buf, o + CHECK_COL, 1)
        putf(buf, o + DYN_RATIO, 1.0)
        put3(buf, o + LIMIT_MIN, (180.0, 180.0, 180.0))
        put3(buf, o + LIMIT_MAX, (180.0, 180.0, 180.0))
        b.first_local_pos = (0.0, 0.0, 0.0)
        if b.parent_bone is None:
            put3(buf, o + BONE_AXIS, (0.0, 1.0, 0.0))
            putf(buf, o + INIT_DIST, 1.0)
        else:
            pb = b.parent_bone
            po = pb.index * WORK
            delta = sub(w.p, self.world[pb.node].p)
            dist = length(delta)
            putf(buf, po + INIT_DIST, dist)
            pb.first_local_pos = self.rest_t[b.node]
            if dist < MIN_BONE_DISTANCE:
                pb.exist = False
                b.exist = False
            else:
                put3(buf, po + BONE_AXIS, normalize(qrot(pb.init_rot_inv, delta)))
            if not self.children[b.node]:
                put3(buf, o + BONE_AXIS, get3(buf, po + BONE_AXIS))
                putf(buf, o + INIT_DIST, dist)
        b.end_sim = bool(root.element.get("_needSimulateEndBone", 1)) if is_end else True

    def apply_params(self, root, b):
        e = b.element
        o = b.index * WORK
        buf = root.buf
        ls = self.world[b.node].s[1]
        putf(buf, o + STIFF, e["_stiffnessForce"])
        putf(buf, o + DRAG, e["_dragForce"])
        putf(buf, o + GRAVITY, e["_gravity"])
        putf(buf, o + COL_RADIUS, e["_collisionRadius"] * ls)
        struct.pack_into("<4f", buf, o + WIND, e.get("_verticalWindRateSlow", 0.0), e.get("_verticalWindRateFast", 0.0),
                         e.get("_horizontalWindRateSlow", 0.0), e.get("_horizontalWindRateFast", 0.0))
        puti(buf, o + IS_LIMIT, int(bool(e.get("_isLimit", 0))))
        put3(buf, o + LIMIT_MIN, v3(e["_limitAngleMin"]))
        put3(buf, o + LIMIT_MAX, v3(e["_limitAngleMax"]))
        putf(buf, o + MOVE_RATE, e.get("MoveSpringApplyRate", 1.0))
        puti(buf, o + IS_ADD, int(root.is_add))

    # -- running -----------------------------------------------------------------------------

    def reset_part(self, part, pose):
        """The springs back to their rest shape under the current pose (ResetNativeCloth).
        `pose` maps node -> Xf (model space) for the parents gathered this tick."""
        for root in part.roots:
            pnode = self.parent[root.bones[0].node]
            if pnode < 0:
                continue
            base = pose.get(pnode) or self.world[pnode]
            matrix = Xf(base.p, base.q, self.world[pnode].s)
            rot = {pnode: base.q}
            for b in root.bones:
                matrix = matrix.child(self.rest_t[b.node], self.rest_r[b.node], self.rest_s[b.node])
                pos = matrix.point(b.first_local_pos)
                local = self.rest_r[b.node]
                prot = rot.get(self.parent[b.node], base.q)
                final = qmul(prot, local)
                rot[b.node] = final
                o = b.index * WORK
                put3(root.buf, o + SELF_POS, pos)
                put3(root.buf, o + TARGET, pos)
                put3(root.buf, o + PREV_TARGET, pos)
                put4(root.buf, o + PARENT_ROT, prot)
                put4(root.buf, o + FINAL_ROT, final)
                put3(root.buf, o + AIM, qrot(final, get3(root.buf, o + BONE_AXIS)))

    @staticmethod
    def hip_rate(data, main, distance):
        """How much hip movement this tick lets through (CySpring.GetHipMoveRate)."""
        if data is None or not data.get("IsEnableHipMoveParam"):
            return -1.0
        near, far = data.get("HipMoveInfluenceDistance", 0.0), data.get("HipMoveInfluenceMaxDistance", 0.0)
        if near >= distance:
            return 1.0
        if distance <= far:
            return 1.0 - (far - distance) / (far - main.get("HipMoveInfluenceDistance", 0.0))
        return 0.0

    def tick(self, parents, root_pos, local_rot, hip, dt=TICK, reset=False):
        """One BeginSimulation/EndSimulation. parents: (pos, rot) per work node; root_pos:
        each root's local position; local_rot: every bone's local rotation now (the
        animation, or what the last tick left). Returns the bones' final rotations (model
        space), or None for ones the game leaves alone this tick."""
        pose = {}
        for k, node in enumerate(self.work_nodes):
            p, q = parents[k]
            pose[node] = Xf(p, q)
            struct.pack_into("<3f4x4f", self.work_buf, k * PARENT, *p, *q)  # position (padded to 16), rotation
        if reset:
            for part in self.parts:
                self.reset_part(part, pose)
        distance = 0.0 if self.hip_prev is None or hip is None else length(sub(hip, self.hip_prev))
        self.zero_dt = abs(dt) <= 1e-5
        r = 0
        k = 0
        for part in self.parts:
            for root in part.roots:
                b0 = root.bones[0]
                w = pose[self.parent[b0.node]]
                put4(root.buf, PARENT_ROT, w.q)
                put3(root.buf, SELF_POS, add(w.p, qrot(w.q, root_pos[r])))
                r += 1
                for b in root.bones:
                    if b.exist:
                        put4(root.buf, b.index * WORK + ANIM_ROT, local_rot[k])
                    k += 1
        if self.skirt_arg is not None:
            self.put_skirt_arg(parents)
        for part in self.parts:
            main_rate = self.hip_rate(part.main, part.main, distance)
            add_rate = self.hip_rate(part.add, part.main, distance)
            cols = part.col_buf if part.collisions else None
            rest = (1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, True, 1.0, True, main_rate, add_rate, 1.0)
            for root in part.roots:
                sk = root.skirt
                if sk is None or self.skirt_arg is None:
                    self.dll.NativeClothUpdate(root.buf, root.count, cols, self.work_buf, *rest)
                    continue
                # the panel as the animation has it: root where the solver has it, target
                # from the root's rest rotation under its parent's current one
                w = pose[sk["parent"]]
                r = get3(root.buf, SELF_POS)
                put3(sk["buf"], SK_ROOT, r)
                put3(sk["buf"], SK_TARGET, add(r, qrot(w.q, sk["target"])))
                put3(sk["buf"], SK_NORMAL, qrot(w.q, sk["normal"]))
                put3(sk["buf"], SK_AXIS, qrot(w.q, sk["axis"]))
                self.dll.NativeClothSkirtUpdate(root.buf, root.count, cols, sk["buf"], self.skirt_arg,
                                                self.work_buf, *rest)
        self.hip_prev = hip
        out = []
        for part in self.parts:
            for root in part.roots:
                for b in root.bones:
                    if self.zero_dt or not b.end_sim:
                        out.append(None)
                    else:
                        out.append(get4(root.buf, b.index * WORK + FINAL_ROT))
        return out

    def run(self, parents, root_pos, local_rot, hip, ticks=1, dt=TICK, reset=False):
        """`ticks` simulation steps on one pose (more than one = the game's warm-up, where the
        animation does not move and each step starts from what the last one left)."""
        local_rot = list(local_rot)
        out = None
        for t in range(max(1, ticks)):
            out = self.tick(parents, root_pos, local_rot, hip, dt, reset and t == 0)
            if t + 1 < ticks:
                self.relocal(parents, out, local_rot)
        return out

    def relocal(self, parents, finals, local_rot):
        """Local rotations the bones have after their final rotations were applied."""
        world = {node: parents[k][1] for k, node in enumerate(self.work_nodes)}
        for k, b in enumerate(self.bones):
            pq = world.get(self.parent[b.node])
            if pq is None:
                continue
            if finals[k] is not None:
                local_rot[k] = qmul(qinv(pq), finals[k])
            world[b.node] = qmul(pq, local_rot[k])

    def step(self, raw):
        """run() from the viewer's packed floats: dt, ticks, reset, hip xyz, then each
        parent's position + rotation, each root's local position, each bone's local
        rotation. Answers per bone: applied (0/1) and the final rotation."""
        a = array.array("f")
        a.frombytes(raw)
        nw, nr, nb = len(self.work_nodes), len(self.roots), len(self.bones)
        if len(a) != 6 + nw * 7 + nr * 3 + nb * 4:
            raise ValueError("spring step: wrong size")
        o = 6
        parents = [(tuple(a[o + 7 * k:o + 7 * k + 3]), tuple(a[o + 7 * k + 3:o + 7 * k + 7])) for k in range(nw)]
        o += nw * 7
        root_pos = [tuple(a[o + 3 * k:o + 3 * k + 3]) for k in range(nr)]
        o += nr * 3
        local_rot = [tuple(a[o + 4 * k:o + 4 * k + 4]) for k in range(nb)]
        out = self.run(parents, root_pos, local_rot, tuple(a[3:6]), ticks=int(a[1]), dt=a[0], reset=a[2] > 0.5)
        res = array.array("f", [0.0] * (nb * 5))
        for k, q in enumerate(out):
            if q is not None:
                res[5 * k:5 * k + 5] = array.array("f", (1.0, *q))
        return res.tobytes()

    def describe(self):
        return {"parents": [self.names[n] for n in self.work_nodes],
                "roots": [self.names[root.bones[0].node] for root in self.roots],
                "bones": [self.names[b.node] for b in self.bones],
                "hip": self.names[self.hip] if self.hip >= 0 else None}


def collision_names(container):
    out = set()
    for e in container.get("springParam", []):
        out.update(e.get("_collisionNameList", []))
        for c in e.get("_childElements", []):
            out.update(c.get("_collisionNameList", []))
    return out
