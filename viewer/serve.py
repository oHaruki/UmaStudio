"""UmaStudio viewer: pick an Uma, pose her, give her props, render PNGs and videos.

Runs on its own with the game closed: it reads the installed game files directly
(see umadata.py and offline.py). The window opens at once; the heavy modules and the
game's file list load behind a progress bar (boot()).

    python serve.py            then open http://127.0.0.1:27620
    pythonw serve.py --app     its own window; the server stops when it is closed
    UmaStudio.exe              the same as --app, built by build_exe.ps1
"""
import base64
import contextlib
import glob
import gzip
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# frozen (UmaStudio.exe): the scripts and static/ are unpacked under _MEIPASS
HERE = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gamepaths  # noqa: E402
# loaded by boot() once the window is up. they pull in UnityPy and numpy, which take a couple
# of seconds.
cyspring = motionnames = offline = story = umaconv = umadata = None

VERSION = "0.2.0"
PORT = 27620
CONFIG = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "UmaStudio")   # = umadata.CONFIG
ROOT = os.path.join(os.path.expanduser("~"), "Pictures", "UmaStudio")
PACKS = os.path.join(ROOT, "packs")
BUNDLES = os.path.join(ROOT, "bundles")
CACHE = os.path.join(ROOT, "viewer-cache")
RENDERS = os.path.join(ROOT, "renders")
IMAGES = os.path.join(ROOT, "images")
LIBRARY_DIR = os.path.join(CACHE, "_library")
ICONS = os.path.join(CACHE, "_icons")
PROPS = os.path.join(CACHE, "_props")
PROP_THUMBS = os.path.join(PROPS, "_thumbs")
BGS = os.path.join(CACHE, "_bg")
STAGES = os.path.join(CACHE, "_stages")
STATIC = os.path.join(HERE, "static")
CONVERTER_VERSION = "10"
PROP_VERSION = "1"
STAGE_VERSION = "8"
IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}
SETUP = ("UmaStudio could not read the installed game's files. Check that Uma Musume is installed "
         "through Steam and has downloaded its data (start it once), or pick the game's folder.")

DATA = None
_lock = threading.Lock()
_prop_lock = threading.Lock()
_stage_lock = threading.Lock()
_charas = {"stamp": None, "list": None}
_boot = {"stage": "Starting", "progress": 0.0, "done": False, "error": None}
_booted = threading.Event()
_window = []   # the app window once it is open, for the folder picker


def boot():
    """The heavy modules, then the game's file list; /api/status shows the progress.
    Starts the warm-up when done."""
    global cyspring, motionnames, offline, story, umaconv, umadata, DATA
    try:
        import cyspring, motionnames, offline, story, umaconv, umadata  # noqa: F401,F811
        _boot.update(stage="Reading the game's file list", progress=0.15)
        DATA = umadata.GameData(progress=lambda stage, k: _boot.update(stage=stage, progress=0.15 + 0.85 * k))
        if DATA.ready():
            print(f"  game data read from the {DATA.source}", flush=True)
        else:
            print("  " + SETUP + (f" ({DATA.error})" if DATA.error else ""), flush=True)
    except Exception as e:
        traceback.print_exc()
        _boot["error"] = str(e)
    finally:
        _boot.update(done=True, progress=1.0)
        _booted.set()
    if DATA is not None:
        threading.Thread(target=warm, daemon=True).start()


def need_data():
    _booted.wait()
    if DATA is None or not DATA.ready():
        raise RuntimeError(SETUP)


# --- characters ----------------------------------------------------------------------

def charas():
    need_data()
    if _charas["stamp"] != DATA._stamp:
        _charas.update(stamp=DATA._stamp, list=DATA.charas())
    return _charas["list"]


def icon(chara_id, dress_id=None):
    """A portrait PNG, extracted once and cached."""
    os.makedirs(ICONS, exist_ok=True)
    name = f"{chara_id}_{dress_id}" if dress_id else str(chara_id)
    out = os.path.join(ICONS, name + ".png")
    if os.path.exists(out):
        return out
    need_data()
    candidates = []
    if dress_id:
        candidates.append(f"chara/chr{chara_id:04d}/chr_icon_{chara_id:04d}_{dress_id:06d}_01")
    candidates.append(f"chara/chr{chara_id:04d}/chr_icon_{chara_id:04d}")
    candidates += [f"mob/mob_chr_icon_{chara_id}_000001_01", f"mob/mob_chr_icon_{chara_id}"]
    import UnityPy
    for path in candidates:
        e = DATA.entries.get(path)
        if not e or not e.local:
            continue
        env = UnityPy.load(DATA.read(path))
        for o in env.objects:
            if o.type.name == "Texture2D":
                o.read().image.save(out)
                return out
    return None


def load(chara_id, dress_id):
    need_data()
    charas()
    name = DATA.build_pack(chara_id, dress_id, PACKS)
    manifest = convert(name)
    c = DATA._charas.get(chara_id, {})
    if c.get("mini"):
        # chibi faces are tiles in texture atlases: the game's expression presets pick them
        idle = f"3d/motion/mini/event/body/chara/chr{c['base']:04d}_00/anm_min_eve_chr{c['base']:04d}_00_idle01_loop"
        manifest = {**manifest, "mini": {"faces": DATA.mini_faces(), "idle": idle if idle in DATA.entries else None}}
    return name, manifest


def own_sets(manifest):
    return motionnames.group([m["name"] for m in manifest["motions"]], own=int(manifest["chara"]))


# --- physics -------------------------------------------------------------------------------
#
# hair, ears, bust and tail run on the game's own CySpring plugin (cyspring.py). the page
# makes one simulation per loaded character and sends the pose every 60 Hz tick.

_springs = {}


def spring_new(pack, nodes, body=None):
    base = safe_join(CACHE, pack)
    path = os.path.join(base, "physics.json") if base else None
    if not path or not os.path.exists(path):
        raise ValueError("no physics for that character")
    sim = cyspring.Simulation(json.load(open(path, encoding="utf-8")), nodes, body)
    sid = uuid.uuid4().hex[:12]
    _springs[sid] = (sim, threading.Lock())
    while len(_springs) > 4:
        _springs.pop(next(iter(_springs)))
    return {"id": sid, **sim.describe()}


def spring_step(sid, raw):
    sim, lock = _springs[sid]
    with lock:
        return sim.step(raw)


# --- story scenes ---------------------------------------------------------------------------

def story_scene(story_id):
    """A story's timeline and voice lip-sync, gzipped JSON (read from the game files)."""
    if not re.fullmatch(r"\d{9}", story_id or ""):
        raise ValueError("bad story id")
    need_data()
    tl_path, lip_path = story.paths(story_id)
    if tl_path not in DATA.entries or not DATA.entries[tl_path].local:
        raise ValueError("that story is not downloaded")
    out = {"timeline": story.timeline(DATA.read(tl_path)), "lipsync": {}}
    if lip_path in DATA.entries and DATA.entries[lip_path].local:
        out["lipsync"] = story.lipsync(DATA.read(lip_path))
    return gzip.compress(json.dumps(out, separators=(",", ":")).encode("utf-8"))


# --- conversion ---------------------------------------------------------------------------

def is_fresh(name):
    stamp = os.path.join(CACHE, name, "version.txt")
    if not os.path.exists(stamp) or open(stamp).read() != CONVERTER_VERSION:
        return False
    newest = 0
    for dirpath, _, files in os.walk(os.path.join(PACKS, name)):
        for f in files:
            newest = max(newest, os.path.getmtime(os.path.join(dirpath, f)))
    return os.path.getmtime(stamp) >= newest


def convert(name):
    src, dst = os.path.join(PACKS, name), os.path.join(CACHE, name)
    with _lock:
        if is_fresh(name):
            return json.load(open(os.path.join(dst, "manifest.json"), encoding="utf-8"))
        t = time.time()
        manifest = umaconv.convert(src, dst)
        with open(os.path.join(dst, "version.txt"), "w") as f:
            f.write(CONVERTER_VERSION)
        print(f"converted {name} in {time.time() - t:.1f}s", flush=True)
        return manifest


def recent():
    out = []
    if os.path.isdir(PACKS):
        for name in os.listdir(PACKS):
            m = os.path.join(CACHE, name, "manifest.json")
            if os.path.exists(m):
                out.append({"name": name, "time": os.path.getmtime(m)})
    return sorted(out, key=lambda x: -x["time"])


# --- motion library -------------------------------------------------------------------------

LIBRARY = [
    ("victory", "Victory poses", "3d/motion/raceresult/body/"),
    ("cutin", "Card cut-ins", "3d/motion/cutin/card/body/"),
    ("event", "Everyday poses", "3d/motion/event/body/type00/"),
    ("charaevent", "Character poses", "3d/motion/event/body/chara/"),
    ("home", "Home screen", "3d/motion/home/body/"),
    ("live", "Dance", "3d/motion/live/body/"),
    ("training", "Training", "3d/motion/training/tra/body/"),
    ("story", "Story & menus", "3d/motion/outgame/"),
    ("mini", "Chibi", "3d/motion/mini/"),
]
SKIP = re.compile(r"(_cam|_pos|_face|_ear|_driven|_camera|_prop)(_|$)")


def library_file(path):
    return os.path.join(LIBRARY_DIR, path.replace("/", os.sep) + ".json.gz")


_sets = {}


def library_sets(cat, mirror):
    """The category's motions as named sets (motionnames), built once per category."""
    need_data()
    prefix = next((p for k, _, p in LIBRARY if k == cat), "3d/motion/")
    key = (prefix, mirror, DATA._stamp)
    sets = _sets.get(key)
    if sets is None:
        names = []
        for n in DATA.prefix(prefix):
            leaf = n.rsplit("/", 1)[-1]
            if "/body/" not in n or SKIP.search(leaf) or (not mirror and leaf.endswith("_mirror")):
                continue
            if DATA.entries[n].local:
                names.append(n)
        sets = motionnames.group(names)
        for st in sets:
            st["search"] = " ".join([st["title"], st["sub"], st["tags"]] + [it.rsplit("/", 1)[-1] for _, it in st["parts"]]).lower()
        _sets[key] = sets
    return sets


def library_list(cat, q, offset, limit, mirror, chara=None):
    terms = q.lower().split()
    hits = [st for st in library_sets(cat, mirror) if all(t in st["search"] for t in terms)]
    if chara:
        hits.sort(key=lambda st: st["chara"] != chara)   # the loaded uma's own first
    page = [{k: st[k] for k in ("title", "sub", "family", "name", "tags", "chara", "parts", "default")}
            for st in hits[offset:offset + limit]]
    return {"items": page, "total": len(hits), "cats": [{"key": k, "label": l} for k, l, _ in LIBRARY]}


_paths = {"key": None, "map": {}}


def all_paths():
    """Bone path hashes of every converted character, merged (re-read when one changes)."""
    files = sorted(glob.glob(os.path.join(CACHE, "*", "paths.json")))
    key = [(f, os.path.getmtime(f)) for f in files]
    if key != _paths["key"]:
        merged = {}
        for f in files:
            merged.update({int(k): v for k, v in json.load(open(f, encoding="utf-8")).items()})
        _paths.update(key=key, map=merged)
    return _paths["map"]


def has_clips(data):
    """False for cached results without clips: older converters skipped the legacy clips
    the dances use, so those are converted again."""
    return len(data) > 200 or bool(json.loads(data)["clips"])


def library_clip(path):
    """The gzipped JSON of one library motion, converted the first time."""
    out = library_file(path)
    if os.path.exists(out) and (os.path.getsize(out) > 200 or has_clips(gzip.decompress(open(out, "rb").read()))):
        return out
    need_data()
    if not path.startswith("3d/motion/") or path not in DATA.entries:
        raise ValueError("not a motion: " + path)
    old = out[:-3]
    if os.path.exists(old) and has_clips(open(old, "rb").read()):   # converted before the cache was gzipped
        data = open(old, "rb").read()
    else:
        with _lock:
            files = DATA.export(path, BUNDLES, deps=False)
            paths = all_paths()
            if not paths:
                raise RuntimeError("open a character first")
            data = json.dumps({"path": path, "clips": umaconv.convert_clip_bundle(files[0], paths)},
                              separators=(",", ":")).encode("utf-8")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = f"{out}.{threading.get_ident()}.tmp"
    with open(tmp, "wb") as f:
        f.write(gzip.compress(data, 6))
    os.replace(tmp, out)
    if os.path.exists(old):
        os.remove(old)
    return out


# --- props ------------------------------------------------------------------------------------
#
# hand props (3d/chara/prop/propNNNN_VV), converted one at a time when first used. the game
# attaches them to Hand_Attach_L/R, a matching grip motion (fingers and attach point) exists
# for many of them.

PROP_NAME = re.compile(r"pfb_chr_prop(\d+)_(\d+)")
GRIPS = "3d/motion/event/body/type00/anm_eve_type00_prop"


def prop_list():
    need_data()
    out = []
    for n in DATA.prefix("3d/chara/prop/"):
        leaf = n.rsplit("/", 1)[-1]
        m = PROP_NAME.fullmatch(leaf)
        if not m or not DATA.entries[n].local:
            continue
        done = os.path.join(PROPS, leaf, "manifest.json")
        if os.path.exists(done) and not json.load(open(done, encoding="utf-8")).get("meshes"):
            continue   # nothing to draw (effect-only props)
        out.append({"name": leaf, "id": f"{m.group(1)}_{m.group(2)}",
                    "thumb": os.path.exists(os.path.join(PROP_THUMBS, leaf + ".png"))})
    return out


def grip_for(pid):
    base = pid.split("_")[0]
    for cand in (f"{GRIPS}{pid}_r", f"{GRIPS}{base}_00_r"):
        e = DATA.entries.get(cand)
        if e and e.local:
            left = DATA.entries.get(cand + "_mirror")
            return cand, (cand + "_mirror") if left and left.local else None
    return None, None


def prop_load(name):
    need_data()
    m = PROP_NAME.fullmatch(name)
    if not m:
        raise ValueError("not a prop: " + name)
    pid = f"{m.group(1)}_{m.group(2)}"
    dst = os.path.join(PROPS, name)
    stamp = os.path.join(dst, "version.txt")
    with _prop_lock:
        if not (os.path.exists(stamp) and open(stamp).read() == PROP_VERSION):
            files = DATA.export(f"3d/chara/prop/prop{pid}/{name}", BUNDLES)
            umaconv.convert_prop(files, dst)
            with open(stamp, "w") as f:
                f.write(PROP_VERSION)
        info = json.load(open(os.path.join(dst, "manifest.json"), encoding="utf-8"))
    grip, grip_left = grip_for(pid)
    return {"name": name, "id": pid, "base": f"/data/_props/{name}/", "meshes": info["meshes"],
            "grip": grip, "gripLeft": grip_left}


# --- places -------------------------------------------------------------------------------------
#
# whole places from the game to stand her in: concert stages (3d/env/live), racecourses (race),
# Tracen's grounds (home), story and event sets (set), skill cut-in sets (cutin), the gacha rooms
# (gacha) and the chibi sets (mini). converted the first time one is picked; the picker shows a
# preview once a place has been seen (the page renders it).
#
# a place is made of pieces, and a piece can come in variants coded season, weather, time
# (1-5 spring summer autumn winter cherry blossom, 1-4 sunny cloudy rainy snowy, 2-4 day evening
# night, 0 = any; e.g. the race skies 112..534, dry and wet tracks 010 / 030). one of each is
# picked for the conditions asked for.

PLACE_PIECE = re.compile(r"3d/env/(race|home|set|cutin|gacha|mini)/([a-z0-9_]+?)/(?:.*/)?(pfb_[a-z0-9_]+)")
STAGE_NAME = re.compile(r"3d/env/live/live(\d+)/pfb_env_live\1_controller000")
VARIANT = re.compile(r"(.+)_(\d{3})")
# a place's main, middle or sky piece can come as whole alternatives (Tracen's hall main000 and
# main002..007, each with its own decorations): the game shows one of them
ALTERNATIVE = re.compile(r"(.+_(?:main|mid|sky))(\d{3})")
# pieces every place of a kind shares: the race skies, the chibi sky
SHARED = {"race": "race00000_9000/", "mini": "mini00000/"}
# the glow sticks the crowd holds come from the song: Umapyoi Legend's unless it isn't there
CYALUME = "live/cyalume/m1001/tex_live_cyalume_m1001_000"
_places = {"stamp": None, "pieces": {}}


def place_pieces():
    """{(kind, place): [piece path, ...]} for everything downloaded, shared pieces included."""
    need_data()
    if _places["stamp"] == id(DATA.entries):
        return _places["pieces"]
    out, shared = {}, {k: [] for k in SHARED}
    for n in DATA.prefix("3d/env/"):
        m = PLACE_PIECE.fullmatch(n)
        if not m or not DATA.entries[n].local:
            continue
        kind, place = m.group(1), m.group(2)
        if kind in SHARED and SHARED[kind] in n:
            shared[kind].append(n)
        elif (kind == "race" and place.startswith("race0")) or (kind == "home" and not place.startswith("home")) \
                or (kind == "set" and place == "set00000") or (kind == "mini" and place == "mini00000") or "_cutt" in n:
            continue   # race gates and props, the jukebox, a lone prop, racecourse copies for cutscenes
        else:
            out.setdefault((kind, place), []).append(n)
    for (kind, place), pieces in out.items():
        pieces += shared.get(kind, [])
    for n in DATA.prefix("3d/env/live/live"):
        m = STAGE_NAME.fullmatch(n)
        if m and DATA.entries[n].local:
            out[("live", m.group(1))] = [n]
    _places.update(stamp=id(DATA.entries), pieces=out)
    return out


def variant_axes(pieces):
    """Which seasons, weathers and times this place has variants for."""
    axes = [set(), set(), set()]
    for n in pieces:
        m = VARIANT.fullmatch(n.rsplit("/", 1)[-1])
        if m:
            for i, d in enumerate(m.group(2)):
                if d != "0":
                    axes[i].add(int(d))
    return [sorted(a) for a in axes]


# what "usual" means: a sunny spring day. the plain _000 pieces are often only templates the game
# fills per condition (a set's main textures come with its _112 piece), so they don't get picked
# over a variant that fits
USUAL = (1, 1, 2)


def variant_score(cond, code):
    cond = tuple(c or u for c, u in zip(cond, USUAL))
    return sum(2 if d == want else 0 if d == 0 else -1 for want, d in zip(cond, map(int, code)))


def alternative_group(pieces):
    """(piece family, its numbers sorted) for the alternatives a place has, or (None, [])."""
    groups = {}
    for n in pieces:
        m = VARIANT.fullmatch(n.rsplit("/", 1)[-1])
        a = ALTERNATIVE.fullmatch(m.group(1) if m else n.rsplit("/", 1)[-1])
        if a:
            groups.setdefault(a.group(1), set()).add(a.group(2))
    return next(((k, sorted(v)) for k, v in sorted(groups.items()) if len(v) > 1), (None, []))


def alternatives(pieces):
    return alternative_group(pieces)[1]


def pick_variants(pieces, cond, alt=None):
    """One variant per piece for cond (season, weather, time; 0 = usual), and of a place's
    alternatives only alt (the first when not given)."""
    def score(code):
        return variant_score(cond, code)
    family, alts = alternative_group(pieces)
    keep = alt if alt in alts else (alts[0] if alts else None)
    families = {}
    for n in pieces:
        leaf = n.rsplit("/", 1)[-1]
        m = VARIANT.fullmatch(leaf)
        a = ALTERNATIVE.fullmatch(m.group(1) if m else leaf)
        if a and a.group(1) == family and a.group(2) != keep:
            continue
        m = VARIANT.fullmatch(n.rsplit("/", 1)[-1])
        families.setdefault(m.group(1) if m else n, []).append((m.group(2) if m else None, n))
    out = []
    for options in families.values():
        if options[0][0] is None:
            out += [n for _, n in options]
        else:
            out.append(max(sorted(options), key=lambda o: score(o[0]))[1])
    return out


TEX_VARIANT = re.compile(r"(tex_.*?_)(\d{3})(_.+)")


def pick_textures(kind, place, cond):
    """The game also swaps textures by condition at runtime (a racecourse's turf goes brown in
    winter, white under snow), and fills some materials that ship without one (a racecourse's
    turf, dirt and rails): {texture name: the one to use instead}, {(name head, tail): the one
    to use} and the paths to pack."""
    families = {}
    for n in DATA.prefix(f"3d/env/{kind}/{place}/"):
        m = TEX_VARIANT.fullmatch(n.rsplit("/", 1)[-1])
        if m and "/textures/" in n and DATA.entries[n].local:
            families.setdefault((m.group(1), m.group(3)), []).append((m.group(2), n))
    swap, fill, paths = {}, {}, []
    for (head, tail), options in families.items():
        best = max(sorted(options), key=lambda o: variant_score(cond, o[0]))
        paths.append(best[1])
        fill[head + "|" + tail] = head + best[0] + tail
        for code, _ in options:
            if code != best[0]:
                swap[head + code + tail] = head + best[0] + tail
    return swap, fill, paths


def _texts(cat):
    import sqlite3
    try:
        db = sqlite3.connect(f"file:{gamepaths.master()}?mode=ro", uri=True)
        return dict(db.execute("SELECT [index], text FROM text_data WHERE category = ?", (cat,)))
    except Exception:
        return {}


def place_name(kind, place, courses, charas):
    num = re.search(r"\d+", place)
    n = int(num.group()) if num else 0
    if kind == "live":
        return f"Stage {place}"
    if kind == "race":
        return courses.get(n) or f"Racecourse {n}"
    if kind == "home":
        return "Tracen Academy" if n == 10001 else f"Tracen {n}"
    if kind == "cutin":
        cid, _, v = place[len("cutin"):].partition("_")
        return f"{charas.get(int(cid), 'Cut-in ' + cid)} · {v}"
    if kind == "gacha":
        return {"gacha_chara00": "Gacha: Umamusume", "gacha_support_card00": "Gacha: support cards"}.get(place, place)
    return f"{'Chibi set' if kind == 'mini' else 'Set'} {n}"


def place_dir(pid, cond, alt=None):
    return pid.replace(":", "_") + ("" if not any(cond) else "_" + "".join(map(str, cond))) + (f"_v{alt}" if alt else "")


def place_list():
    courses, charas = _texts(34), _texts(6)
    out = []
    for (kind, place), pieces in sorted(place_pieces().items()):
        pid = f"{kind}:{place}"
        out.append({"id": pid, "kind": kind, "name": place_name(kind, place, courses, charas),
                    "axes": variant_axes(pieces), "alts": alternatives(pieces), "dir": place_dir(pid, (0, 0, 0)),
                    "thumb": os.path.exists(os.path.join(STAGES, place_dir(pid, (0, 0, 0)), "thumb.jpg"))})
    return out


def place_load(pid, cond=(0, 0, 0), alt=None):
    """Convert (once) and hand out a place. pid: kind:place, e.g. live:10101, race:race10006."""
    if ":" not in pid:
        pid = "live:" + pid   # stages picked before there were other places
    kind, _, place = pid.partition(":")
    pieces = place_pieces().get((kind, place))
    if not pieces:
        raise ValueError("no such place: " + pid)
    cond = tuple(int(c) for c in cond)
    alts = alternatives(pieces)
    alt = alt if alt in alts[1:] else None   # the first one is the plain folder
    folder = place_dir(pid, cond, alt)
    dst = os.path.join(STAGES, folder)
    stamp = os.path.join(dst, "version.txt")
    with _stage_lock:
        if not (os.path.exists(stamp) and open(stamp).read() == STAGE_VERSION):
            files = []
            for n in pick_variants(pieces, cond, alt):
                files += DATA.export(n, BUNDLES)
            swap, fill, textures = pick_textures(kind, place, cond) if kind != "live" else ({}, {}, [])
            for n in textures:
                files += DATA.export(n, BUNDLES, deps=False)
            if kind == "live":
                sticks = CYALUME if CYALUME in DATA.entries and DATA.entries[CYALUME].local else next(
                    (n for n in DATA.prefix("live/cyalume/") if DATA.entries[n].local), None)
                if sticks:
                    files += DATA.export(sticks, BUNDLES, deps=False)
            umaconv.convert_stage(sorted(set(files)), dst, swap, fill)
            with open(stamp, "w") as f:
                f.write(STAGE_VERSION)
    return {"id": pid, "dir": folder, "base": f"/data/_stages/{folder}/",
            "thumb": os.path.exists(os.path.join(dst, "thumb.jpg"))}


# --- backgrounds --------------------------------------------------------------------------------
#
# the game's story backgrounds (bg/bg_*) are 16:9 pictures stored squashed to a power of two
# (2048x1024, or 1024x2048 for the vertical ones), so they get stretched back.

BG_NAME = re.compile(r"(vertical_)?bg_[a-z0-9_]+")


def bg_list():
    need_data()
    return [{"name": n[3:], "vertical": n.startswith("bg/vertical_")}
            for n in DATA.prefix("bg/") if BG_NAME.fullmatch(n[3:]) and DATA.entries[n].local]


def bg_image(name, thumb):
    if not BG_NAME.fullmatch(name):
        return None
    out = os.path.join(BGS, "thumbs" if thumb else "", name + (".jpg" if thumb else ".png"))
    if os.path.exists(out):
        return out
    need_data()
    if f"bg/{name}" not in DATA.entries:
        return None
    import UnityPy
    img = None
    for o in UnityPy.load(DATA.read(f"bg/{name}")).objects:
        if o.type.name == "Texture2D":
            img = o.read().image.convert("RGB")
            break
    if img is None:
        return None
    w, h = img.size
    if (w, h) == (2048, 1024):
        img = img.resize((2048, 1152), 1)
    elif (w, h) == (1024, 2048):
        img = img.resize((1152, 2048), 1)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = f"{out}.{threading.get_ident()}.tmp"
    if thumb:
        img.thumbnail((360, 360))
        img.save(tmp, "JPEG", quality=84)
    else:
        img.save(tmp, "PNG", compress_level=3)
    os.replace(tmp, out)
    return out


# --- your images ----------------------------------------------------------------------------------

def image_list():
    out = []
    if os.path.isdir(IMAGES):
        for f in os.listdir(IMAGES):
            if f.rsplit(".", 1)[-1].lower() in IMAGE_TYPES:
                out.append({"file": f, "time": os.path.getmtime(os.path.join(IMAGES, f))})
    return sorted(out, key=lambda x: -x["time"])


def image_save(name, data):
    from io import BytesIO
    from PIL import Image
    try:
        im = Image.open(BytesIO(data))
        kind = (im.format or "").lower()
        im.verify()
    except Exception:
        raise ValueError("that file is not a picture UmaStudio can read")
    ext = {"jpeg": "jpg"}.get(kind, kind)
    if ext not in IMAGE_TYPES:
        raise ValueError("use a PNG, JPG, WebP or GIF picture")
    os.makedirs(IMAGES, exist_ok=True)
    stem = re.sub(r"[^\w\-. ]", "_", os.path.splitext(name)[0])[:80].strip() or "image"
    path = unique(os.path.join(IMAGES, f"{stem}.{ext}"))
    with open(path, "wb") as f:
        f.write(data)
    return os.path.basename(path)


# --- warm-up ----------------------------------------------------------------------------------
#
# fills the caches once that would otherwise be filled while the user waits: uma pictures,
# the pose lists, props and background previews. steps aside whenever a request is being
# served, so it never slows the app down.

_warm = {"stage": "", "done": 0, "total": 0, "finished": False}
_active = [0]
_active_lock = threading.Lock()


@contextlib.contextmanager
def serving():
    with _active_lock:
        _active[0] += 1
    try:
        yield
    finally:
        with _active_lock:
            _active[0] -= 1


def warm():
    while not DATA.ready():
        time.sleep(5)
    jobs = []
    for c in charas():
        if not os.path.exists(os.path.join(ICONS, f"{c['id']}.png")):
            jobs.append(("Uma pictures", lambda c=c: icon(c["id"])))
    jobs += [("Pose lists", lambda k=k: library_sets(k, False)) for k, _, _ in LIBRARY]
    for it in prop_list():
        stamp = os.path.join(PROPS, it["name"], "version.txt")
        if not (os.path.exists(stamp) and open(stamp).read() == PROP_VERSION):
            jobs.append(("Props", lambda n=it["name"]: prop_load(n)))
    for b in bg_list():
        if not os.path.exists(os.path.join(BGS, "thumbs", b["name"] + ".jpg")):
            jobs.append(("Backgrounds", lambda n=b["name"]: bg_image(n, True)))
    _warm.update(total=len(jobs), done=0)
    for stage, job in jobs:
        while _active[0]:
            time.sleep(0.05)
        _warm["stage"] = stage
        try:
            job()
        except Exception:
            traceback.print_exc()
        _warm["done"] += 1
    _warm.update(stage="", finished=True)


# --- video ------------------------------------------------------------------------------------
#
# the page renders each frame at a fixed time step and posts raw RGBA, frames stream straight
# into ffmpeg's stdin so nothing piles up on disk.

FORMATS = {
    "mp4": ("mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", "-movflags", "+faststart"]),
    "webm": ("webm", ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1",
                      "-auto-alt-ref", "0"]),
    "mov": ("mov", ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]),
    "gif": ("gif", ["-filter_complex", "[0:v]split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128"]),
}
_videos = {}
_encoding = [0]            # videos ffmpeg is still finishing


def unique(path):
    stem, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(path):
        path = f"{stem} ({n}){ext}"
        n += 1
    return path


def find_ffmpeg():
    beside = os.path.join(os.path.dirname(sys.executable), "ffmpeg.exe")
    return beside if os.path.exists(beside) else shutil.which("ffmpeg")


def video_start(w, h, fps, fmt, name):
    os.makedirs(RENDERS, exist_ok=True)
    safe = re.sub(r"[^\w\-. ]", "_", name)[:120]
    vid = uuid.uuid4().hex
    if fmt == "png":
        # frames as numbered PNGs in their own folder, no ffmpeg involved
        folder = unique(os.path.join(RENDERS, safe))
        os.makedirs(folder)
        _videos[vid] = {"dir": folder, "w": w, "h": h, "n": 0, "size": w * h * 4}
        return vid
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is needed for video: run  winget install ffmpeg  and restart UmaStudio")
    ext, args = FORMATS[fmt]
    path = unique(os.path.join(RENDERS, safe + "." + ext))
    log = open(os.path.join(CACHE, "ffmpeg.log"), "wb")
    proc = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                             "-s", f"{w}x{h}", "-r", str(fps), "-i", "-", *args, path],
                            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    _videos[vid] = {"proc": proc, "path": path, "size": w * h * 4, "log": log}
    return vid


def video_frame(vid, data):
    v = _videos[vid]
    if len(data) != v["size"]:
        raise ValueError("frame has the wrong size")
    if "dir" in v:
        from PIL import Image
        v["n"] += 1
        Image.frombuffer("RGBA", (v["w"], v["h"]), data, "raw", "RGBA", 0, 1).save(
            os.path.join(v["dir"], f"{os.path.basename(v['dir'])} {v['n']:04d}.png"), compress_level=3)
        return
    v["proc"].stdin.write(data)


def video_finish(vid, cancel=False):
    v = _videos.pop(vid)
    if "dir" in v:
        if cancel:
            shutil.rmtree(v["dir"], ignore_errors=True)
            return None
        return v["dir"]
    proc = v["proc"]
    _encoding[0] += 1
    try:
        if cancel:
            proc.kill()
            proc.wait(timeout=30)
        else:
            proc.stdin.close()
            proc.wait(timeout=900)
    finally:
        _encoding[0] -= 1
        v["log"].close()
    if cancel:
        try:
            os.remove(v["path"])
        except OSError:
            pass
        return None
    if proc.returncode != 0:
        err = open(os.path.join(CACHE, "ffmpeg.log"), encoding="utf-8", errors="replace").read()[-400:]
        raise RuntimeError("ffmpeg failed: " + err)
    return v["path"]


def export_save(name, data):
    """A model the page exported (.glb), saved with the renders."""
    if data[:4] != b"glTF":
        raise ValueError("not a glb file")
    os.makedirs(RENDERS, exist_ok=True)
    path = unique(os.path.join(RENDERS, re.sub(r"[^\w\-. ]", "_", name)[:120] + ".glb"))
    with open(path, "wb") as f:
        f.write(data)
    return path


# --- app window ------------------------------------------------------------------------------

_last_ping = [time.time()]


def browser_exe():
    local = os.environ.get("LOCALAPPDATA", "")
    for p in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              os.path.join(local, r"Google\Chrome\Application\chrome.exe"),
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
        if os.path.exists(p):
            return p
    return None


def open_window(url):
    """Its own window (no tabs or address bar) when Chrome or Edge is installed."""
    exe = browser_exe()
    if not exe:
        webbrowser.open(url)
        return
    profile = os.path.join(CONFIG, "window")
    subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                      "--no-default-browser-check", "--window-size=1600,950"])


def watchdog():
    """In app mode, stop once the window has been closed (it pings every few seconds)."""
    while True:
        time.sleep(5)
        if time.time() - _last_ping[0] > 40 and not _videos and not _encoding[0]:
            os._exit(0)


def browse_folder():
    """Windows' folder picker in the app window; None when cancelled or not in the app."""
    if not _window:
        return None
    import webview
    kind = webview.FileDialog.FOLDER if hasattr(webview, "FileDialog") else webview.FOLDER_DIALOG
    got = _window[0].create_file_dialog(kind)
    return got[0] if got else None


def native_window(url):
    """A real window (Edge WebView2, part of Windows 11) when pywebview is available.
    Blocks until the window is closed; False when it could not be shown."""
    try:
        import webview
    except ImportError:
        return False
    try:
        _window.append(webview.create_window("UmaStudio", url, width=1600, height=950, min_size=(1000, 640),
                              background_color="#0e1014", text_select=False))
        webview.start(gui="edgechromium", private_mode=False,
                      storage_path=os.path.join(CONFIG, "webview"))
        return True
    except Exception:
        traceback.print_exc()
        return False


# --- HTTP ------------------------------------------------------------------------------------

def safe_join(base, rel):
    full = os.path.realpath(os.path.join(base, rel))
    return full if full.startswith(os.path.realpath(base) + os.sep) else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        return (self.headers.get("Host") or "").split(":")[0] in ("127.0.0.1", "localhost")

    def _send(self, status, body, ctype="application/json", cache=False, gzipped=False):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if gzipped:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, cache=False):
        if not path or not os.path.isfile(path):
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.endswith(".js"):
            ctype = "text/javascript"
        elif path.endswith(".gltf"):
            ctype = "model/gltf+json"
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype, cache)

    # requests in flight, so the warm-up can wait for them (counted once the request line is in,
    # browsers keep idle connections open).
    def do_GET(self):
        with serving():
            self._get()

    def do_POST(self):
        with serving():
            self._post()

    def _get(self):
        if not self._host_ok():
            return self._send(421, {"error": "unexpected Host"})
        url = urlparse(self.path)
        p = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if p == "/":
                return self._file(os.path.join(STATIC, "index.html"))
            if p.startswith("/static/"):
                return self._file(safe_join(STATIC, p[len("/static/"):]))
            if p == "/api/ping":
                _last_ping[0] = time.time()
                return self._send(200, {"ok": True})
            if p == "/api/status":
                if not _boot["done"]:
                    return self._send(200, {"ready": False, "loading": True, "stage": _boot["stage"],
                                            "progress": round(_boot["progress"], 3), "version": VERSION})
                ready = DATA is not None and DATA.ready()
                game, data = gamepaths.paths()
                return self._send(200, {"ready": ready, "setup": SETUP, "version": VERSION,
                                        "error": (DATA.error if DATA else None) or _boot["error"],
                                        "game": game, "data": data, "picked": gamepaths.picked(),
                                        "browse": bool(_window), "recent": recent()})
            if p == "/api/charas":
                return self._send(200, {"ok": True, "charas": charas()})
            m = re.match(r"^/api/icon/(\d+)(?:_(\d+))?$", p)
            if m:
                path = icon(int(m.group(1)), int(m.group(2)) if m.group(2) else None)
                return self._file(path, cache=True) if path else self._send(404, {"error": "no icon"})
            if p == "/api/warm":
                return self._send(200, _warm)
            if p == "/api/library":
                return self._send(200, library_list(q.get("cat", ""), q.get("q", ""), int(q.get("o", 0)),
                                                    int(q.get("n", 200)), q.get("mirror") == "1",
                                                    int(q.get("chara") or 0) or None))
            if p == "/api/library/clip":
                with open(library_clip(q.get("path", "")), "rb") as f:
                    return self._send(200, f.read(), gzipped=True)
            if p == "/api/story":
                return self._send(200, story_scene(q.get("id", "")), gzipped=True)
            if p == "/api/props":
                return self._send(200, {"ok": True, "items": prop_list()})
            m = re.match(r"^/api/prop/thumb/(pfb_chr_prop\d+_\d+)$", p)
            if m:
                return self._file(os.path.join(PROP_THUMBS, m.group(1) + ".png"), cache=True)
            if p == "/api/stages":
                return self._send(200, {"ok": True, "items": place_list()})
            if p == "/api/bgs":
                return self._send(200, {"ok": True, "items": bg_list()})
            m = re.match(r"^/api/bg/(thumb/)?([a-z0-9_]+)\.(png|jpg)$", p)
            if m:
                return self._file(bg_image(m.group(2), bool(m.group(1))), cache=True)
            if p == "/api/images":
                return self._send(200, {"ok": True, "items": image_list()})
            if p.startswith("/img/"):
                return self._file(safe_join(IMAGES, p[len("/img/"):]), cache=True)
            m = re.match(r"^/data/([^/]+)/(.+)$", p)
            if m:
                return self._file(safe_join(os.path.join(CACHE, m.group(1)), m.group(2)))
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"ok": False, "error": str(e)})
        self._send(404, {"error": "not found"})

    def _post(self):
        if not self._host_ok() or self.headers.get("X-Studio") != "1":
            return self._send(403, {"error": "forbidden"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            if self.path.startswith("/api/video/frame"):
                video_frame(parse_qs(urlparse(self.path).query)["id"][0], raw)
                return self._send(200, {"ok": True})
            if self.path.startswith("/api/spring/step"):
                sid = parse_qs(urlparse(self.path).query)["id"][0]
                if sid not in _springs:
                    return self._send(410, {"error": "simulation gone"})
                return self._send(200, spring_step(sid, raw), "application/octet-stream")
            if self.path.startswith("/api/export"):
                name = parse_qs(urlparse(self.path).query).get("name", ["model"])[0]
                return self._send(200, {"ok": True, "path": export_save(name, raw)})
            if self.path.startswith("/api/images/upload"):
                name = parse_qs(urlparse(self.path).query).get("name", ["image"])[0]
                return self._send(200, {"ok": True, "file": image_save(name, raw)})
            body = json.loads(raw or b"{}")
            if self.path == "/api/video/start":
                vid = video_start(int(body["w"]), int(body["h"]), int(body["fps"]), body["format"], body.get("name", "video"))
                return self._send(200, {"ok": True, "id": vid})
            if self.path == "/api/video/finish":
                path = video_finish(body["id"], cancel=bool(body.get("cancel")))
                return self._send(200, {"ok": True, "path": path})
            if self.path == "/api/load":
                name, manifest = load(int(body["chara"]), int(body["dress"]))
                return self._send(200, {"ok": True, "pack": name, "manifest": manifest, "sets": own_sets(manifest)})
            if self.path == "/api/convert":
                name = body.get("pack", "")
                if not safe_join(PACKS, name):
                    return self._send(400, {"error": "bad pack"})
                manifest = convert(name)
                return self._send(200, {"ok": True, "pack": name, "manifest": manifest, "sets": own_sets(manifest)})
            if self.path == "/api/spring/new":
                return self._send(200, {"ok": True, **spring_new(body.get("pack", ""), body["nodes"], body.get("body"))})
            if self.path == "/api/render":
                os.makedirs(RENDERS, exist_ok=True)
                name = re.sub(r"[^\w\-. ]", "_", body.get("name", "render"))[:120] or "render"
                data = base64.b64decode(body.get("png", "").split(",", 1)[-1])
                path = os.path.join(RENDERS, name + ".png")
                n = 2
                while os.path.exists(path):
                    path = os.path.join(RENDERS, f"{name} ({n}).png")
                    n += 1
                with open(path, "wb") as f:
                    f.write(data)
                return self._send(200, {"ok": True, "path": path})
            if self.path == "/api/stage/load":
                return self._send(200, {"ok": True, **place_load(str(body.get("id", "")), body.get("cond") or (0, 0, 0), body.get("alt"))})
            if self.path == "/api/stage/thumb":
                # one preview per place, whatever season or time it was seen in
                pid = str(body.get("id", ""))
                if (pid.split(":")[0], pid.partition(":")[2]) not in place_pieces():
                    return self._send(400, {"error": "bad place"})
                folder = os.path.join(STAGES, place_dir(pid, (0, 0, 0)))
                os.makedirs(folder, exist_ok=True)
                with open(os.path.join(folder, "thumb.jpg"), "wb") as f:
                    f.write(base64.b64decode(body.get("jpg", "").split(",", 1)[-1]))
                return self._send(200, {"ok": True})
            if self.path == "/api/prop/load":
                return self._send(200, {"ok": True, **prop_load(body.get("name", ""))})
            if self.path == "/api/prop/thumb":
                name = body.get("name", "")
                if not PROP_NAME.fullmatch(name):
                    return self._send(400, {"error": "bad prop"})
                os.makedirs(PROP_THUMBS, exist_ok=True)
                with open(os.path.join(PROP_THUMBS, name + ".png"), "wb") as f:
                    f.write(base64.b64decode(body.get("png", "").split(",", 1)[-1]))
                return self._send(200, {"ok": True})
            if self.path == "/api/game/path":
                try:
                    game, data = gamepaths.pick(body.get("path", ""))
                except ValueError as e:
                    return self._send(400, {"ok": False, "error": str(e)})
                return self._send(200, {"ok": True, "game": game, "data": data})
            if self.path == "/api/game/browse":
                return self._send(200, {"ok": True, "path": browse_folder()})
            if self.path == "/api/open":
                target = {"renders": RENDERS, "images": IMAGES}.get(body.get("what"), ROOT)
                os.makedirs(target, exist_ok=True)
                subprocess.Popen(["explorer", target])
                return self._send(200, {"ok": True})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"ok": False, "error": str(e)})
        self._send(404, {"error": "not found"})


def running_version(url):
    """The version of the UmaStudio already on this address, None when it is something else."""
    import urllib.request
    try:
        with urllib.request.urlopen(url + "api/status", timeout=5) as r:
            return json.loads(r.read()).get("version") or None
    except Exception:
        return None


def tell(msg, app):
    print(msg, flush=True)
    if app and sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "UmaStudio", 0x30)   # MB_ICONWARNING


def main():
    app =("--app" in sys.argv or getattr(sys, "frozen", False)) and "--no-browser" not in sys.argv
    if sys.stdout is None:   # pythonw / the exe: no console, so keep a log instead
        os.makedirs(CONFIG, exist_ok=True)
        sys.stdout = sys.stderr = open(os.path.join(CONFIG, "viewer.log"), "a", encoding="utf-8", buffering=1)
    os.makedirs(CACHE, exist_ok=True)
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PORT   # a second copy, for testing
    url = f"http://127.0.0.1:{port}/"
    # thumbnails, frames and model files arrive in bursts, the default backlog of 5 can drop
    # connections while the GIL is busy decoding.
    ThreadingHTTPServer.request_queue_size = 64
    # windows lets a second SO_REUSEADDR socket onto a port that's in use, and the first one keeps
    # getting the requests: a second copy would start up and quietly talk to the first
    ThreadingHTTPServer.allow_reuse_address = sys.platform != "win32"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        other = running_version(url)
        if other == VERSION:
            # already running: open another window onto it
            if app:
                native_window(url) or open_window(url)
            else:
                webbrowser.open(url)
            return
        if other:
            # another version (an old copy still open after an update) would show its own page here
            tell(f"UmaStudio {other} is still running. Close it, or end UmaStudio.exe in Task Manager, "
                 f"then start {VERSION} again.", app)
            return
        # something else has the port, so a free one
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        url = f"http://127.0.0.1:{server.server_port}/"
    print(f"UmaStudio viewer on {url}", flush=True)
    threading.Thread(target=boot, daemon=True).start()
    if not app:
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        server.serve_forever()
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if native_window(url):
        # closed: a recording cut short is dropped, one already encoding finishes first
        for vid in list(_videos):
            try:
                video_finish(vid, cancel=True)
            except Exception:
                pass
        while _encoding[0]:
            time.sleep(0.5)
        os._exit(0)
    threading.Thread(target=watchdog, daemon=True).start()
    open_window(url)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
