import * as THREE from 'three';
import { $, store, toast, busy, getJson, call } from '/static/ui.js';
import * as anim from '/static/anim.js';

// scene files: a whole short written as code instead of keyed by hand.
//
// Pictures\UmaStudio\scenes\<name>\scene.js exports { length, place, cast, props, build(s) }.
// loading one sets up the place, the umas and the props (only what changed), runs build(s) and
// puts the result on the timeline. s is the builder below: keys by time, windows in which things
// show, camera shots framed on an uma, beats with their voice lines. docs/scenes.md has the format.
//
// the page writes back into the scene's folder: notes.json (what was said about each beat in the
// Scene panel), script.json (the voice lines), check.json (what looks wrong), sheets\*.png.

const DEG = Math.PI / 180;
const UMA_H = 1.6;                     // when her head can't be found
// how much of her a shot shows: frame height in metres and where it looks, from her head (top)
// or her height (full)
const SIZES = {
  face: { h: 0.6, at: m => m.head - 0.04 },
  close: { h: 0.85, at: m => m.head - 0.14 },
  upper: { h: 1.05, at: m => m.head - 0.28 },
  medium: { h: 1.3, at: m => m.head - 0.42 },
  full: { h: null, at: m => m.top * 0.52 },
  wide: { h: null, at: m => m.top * 0.5 },
  xwide: { h: 14, at: m => m.top * 0.5 },
};
const sizeHeight = (size, m) => typeof size === 'number' ? size
  : size === 'full' ? m.top * 1.25 : size === 'wide' ? m.top * 2.8 : SIZES[size]?.h ?? m.top * 1.25;
const lookY = (size, m) => (SIZES[size] || SIZES.full).at(m);

let ctx = null;
let current = null;    // { name, def, stamp, result }
let watchTimer = null;
let notes = {};
let noteTimer = null;

// --- the builder ---------------------------------------------------------------------------------

class Builder {
  constructor(def, env) {
    this.def = def;
    this.env = env;                       // { placeId, umas: alias -> {key, head, top}, props: name -> {base} }
    this.length = def.length || 10;
    this.THREE = THREE;
    this.keys = {};                       // id -> [{t, ...channels}]
    this.holds = [];                      // [{id, t, e}] keys that copy the last value
    this.shows = {};                      // id -> [[t0, t1]]
    this.hides = {};
    this.motions = {};                    // key -> [{t, clip, once}]
    this.faces = {};
    this.shots = [];
    this.beats = [];
    this.lines = [];
    this.fxKeys = [];
    this.focusKeys = [];
    this.shakes = [];
    this.hazeV = null;
    this.errors = [];
  }

  // --- who is who
  /** A track id from a name: an uma's alias, a prop's name, 'cam', or 'part:<node name>'. */
  id(who) {
    if (who === 'cam' || who === 'camera') return 'camera';
    const u = this.env.umas[who];
    if (u) return u.key === 'main' ? 'her' : 'uma:' + u.key;
    if (this.env.props[who]) return 'prop:' + who;
    if (typeof who === 'string' && who.startsWith('part:')) return `part:${this.env.placeId}|${who.slice(5)}`;
    this.err(`nothing called "${who}" (umas: ${Object.keys(this.env.umas).join(', ')}; props: ${Object.keys(this.env.props).join(', ') || 'none'})`);
    return null;
  }
  part(name) { return 'part:' + name; }
  umaKey(who) {
    const u = this.env.umas[who];
    if (!u) this.err(`no uma called "${who}"`);
    return u?.key;
  }
  err(msg) { if (!this.errors.includes(msg)) this.errors.push(msg); }
  checkT(t, what) {
    if (!(t >= 0) || t > this.length + 1e-6) this.err(`${what} at ${t} s is outside the scene (0 to ${this.length} s)`);
  }

  // --- keys
  /** A key: { p, ry, rx, rz (degrees) or q, s (number or [x,y,z], props: times their size), v, e }.
   *  Channels left out aren't keyed. e is how it gets here from the key before (smooth, linear,
   *  out, in, back, bounce, step); ep / eq / es set it per channel. */
  key(who, t, k) {
    const id = typeof who === 'string' && who.includes(':') && !who.startsWith('part:') ? who : this.id(who);
    if (!id) return this;
    this.checkT(t, `a key of ${who}`);
    const out = { t };
    if (k.p) out.p = [...k.p];
    if (k.q) out.q = [...k.q];
    else if (k.ry !== undefined || k.rx !== undefined || k.rz !== undefined)
      out.q = new THREE.Quaternion().setFromEuler(new THREE.Euler((k.rx || 0) * DEG, (k.ry || 0) * DEG, (k.rz || 0) * DEG, 'YXZ')).toArray();
    if (k.s !== undefined) {
      const s = typeof k.s === 'number' ? [k.s, k.s, k.s] : k.s;
      const base = id.startsWith('prop:') ? this.env.props[id.slice(5)].base : 1;
      out.s = s.map(v => v * base);
    }
    if (k.v !== undefined) out.v = !!k.v;
    if (id === 'camera') { if (k.tg) out.tg = [...k.tg]; if (k.fov !== undefined) out.fov = k.fov; }
    for (const e of ['e', 'ep', 'eq', 'es']) if (k[e]) out[e] = k[e];
    if (!out.e) out.e = 'smooth';
    (this.keys[id] ||= []).push(out);
    return this;
  }
  /** She (or it) is at p turned ry degrees from t on. Jumps there unless e says how to get there. */
  at(who, t, p, ry, e = 'step') { return this.key(who, t, { p, ...(ry !== undefined ? { ry } : {}), e }); }
  /** Moves from wherever it is at t0 to p by t1. */
  go(who, t0, t1, p, ry, e = 'smooth') {
    this.hold(who, t0);
    return this.key(who, t1, { p, ...(ry !== undefined ? { ry } : {}), e });
  }
  /** Stays as it is until t (the next key's move starts here). */
  hold(who, t) {
    const id = this.id(who);
    if (id) { this.checkT(t, `a hold of ${who}`); this.holds.push({ id, t }); }
    return this;
  }
  /** Keys along a path: [[t, p, ry, e], ...]. */
  path(who, pts, e = 'linear') {
    pts.forEach(([t, p, ry, ee], i) => this.key(who, t, { p, ...(ry !== undefined ? { ry } : {}), e: ee || (i === 0 ? 'step' : e) }));
    return this;
  }

  // --- showing
  /** Shows only from t0 to t1 (several windows add up). */
  show(who, t0 = 0, t1 = Infinity) { const id = this.id(who); if (id) (this.shows[id] ||= []).push([t0, t1]); return this; }
  /** Hidden from t0 to t1. */
  hide(who, t0 = 0, t1 = Infinity) { const id = this.id(who); if (id) (this.hides[id] ||= []).push([t0, t1]); return this; }
  /** Grows out of nothing at t to size s, with a little overshoot (shows from t). */
  pop(who, t, { s = 1, dur = 0.35 } = {}) {
    this.show(who, t);
    this.key(who, t, { s: s * 0.001, es: 'step', e: 'step' });
    return this.key(who, t + dur, { s, es: 'back', e: 'back' });
  }
  /** Shrinks away from t, gone after. */
  out(who, t, { s = 1, dur = 0.25 } = {}) {
    this.key(who, t, { s, e: 'step' });
    this.key(who, t + dur, { s: s * 0.001, e: 'in' });
    return this.hide(who, t + dur);
  }
  /** Falls onto p from h metres up, lands at t + 0.45 with a small hop (shows from t). */
  drop(who, t, p, { h = 4, ry } = {}) {
    const up = d => [p[0], p[1] + d, p[2]];
    const r = ry !== undefined ? { ry } : {};
    this.show(who, t);
    this.key(who, t, { p: up(h), ...r, e: 'step' });
    this.key(who, t + 0.45, { p, e: 'in' });
    this.key(who, t + 0.57, { p: up(h * 0.06), e: 'out' });
    return this.key(who, t + 0.7, { p, e: 'in' });
  }

  // --- umas
  /** From t she plays clip: an imported one by name ('Idle_Loop', 'UAL2:Yes'), one of her own
   *  motions, a library path, or 'rest'. Clips not named _Loop play once and hold. */
  motion(who, t, clip, opts = {}) {
    const key = this.umaKey(who);
    if (key) { this.checkT(t, `${who}'s motion`); (this.motions[key] ||= []).push({ t, clip, ...opts }); }
    return this;
  }
  motions(who, list) { for (const [t, clip, o] of list) this.motion(who, t, clip, o); return this; }
  /** From t she has this face preset (WaraiA, IkariA, OdorokiA, KanasiA, DoyaA, KomariA...). */
  face(who, t, face) {
    const key = this.umaKey(who);
    if (key) { this.checkT(t, `${who}'s face`); (this.faces[key] ||= []).push({ t, face }); }
    return this;
  }
  faceList(who, list) { for (const [t, f] of list) this.face(who, t, f); return this; }

  // --- camera
  /** The camera at p looking at tg. */
  cam(t, p, tg, { fov, e = 'smooth' } = {}) { return this.key('camera', t, { p, tg, ...(fov ? { fov } : {}), e }); }
  /** A shot from t0 to t1, starting with a cut. on: an uma, several, or a point. size: face, close,
   *  upper, medium, full, wide, xwide or metres of frame height. angle: degrees round her from her
   *  front (+ = to her left as she faces you... the camera's right). tilt: degrees looking down.
   *  to: { size, angle, tilt, dist } at t1 for a push in or an orbit. follow: keeps on her as she
   *  moves. */
  shot(t0, t1, opts) { this.checkT(t0, 'a shot'); this.checkT(t1, 'a shot'); this.shots.push({ t0, t1, ...opts }); return this; }
  /** The picture shakes from t for dur seconds, amp metres at first. */
  shake(t, dur = 0.5, amp = 0.25) { this.shakes.push({ t, d: dur, a: amp }); return this; }

  // --- the story
  /** A beat: shown over the timeline, on the sheets, and its line goes to the voice script. */
  beat(t0, t1, title, { say, note } = {}) {
    this.beats.push({ t0, t1, title, say: say || null, note: note || null });
    if (say) this.lines.push({ t: t0, text: say });
    return this;
  }
  /** A voice line starting at t (besides a beat's own). */
  say(t, text) { this.lines.push({ t, text }); return this; }

  // --- blender only
  fx(t, k) { this.fxKeys.push({ t, ...k }); return this; }
  focus(t, who) { this.focusKeys.push({ t, key: who === null ? null : this.umaKey(who) }); return this; }
  haze(d) { this.hazeV = d; return this; }

  // --- looking around (while building)
  /** Height of the place's ground under x, z. */
  ground(x, z) { return this.env.ground(x, z); }
  /** [x, ground + dy, z]. */
  on(x, z, dy = 0) { return [x, this.ground(x, z) + dy, z]; }
  /** Names of the place's parts matching re. */
  parts(re = /./) { return this.env.partNames().filter(n => re.test(n)); }
  /** A part's box in the world: { min, max, center, size }. */
  box(name) { return this.env.box(name); }
  /** How tall an uma is (top of her head, metres). */
  height(who) { return this.env.umas[who]?.top ?? UMA_H; }
  /** a + b, for arrays. */
  add(a, b) { return a.map((v, i) => v + (b[i] || 0)); }
  /** A point d metres in front of an uma standing at p turned ry degrees (side: to her left). */
  front(p, ry, d, side = 0, up = 0) {
    const r = ry * DEG;
    return [p[0] + Math.sin(r) * d + Math.cos(r) * side, p[1] + up, p[2] + Math.cos(r) * d - Math.sin(r) * side];
  }
  /** Which way to turn (degrees) to face from a to b. */
  face2(a, b) { return Math.atan2(b[0] - a[0], b[2] - a[2]) / DEG; }
  /** A seeded random number source, so a scene comes out the same every time. */
  rand(seed = 1) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
}

// --- compiling -----------------------------------------------------------------------------------

const byT = (a, b) => a.t - b.t;

function windowsToKeys(shows, hides, length) {
  const inside = (ws, t) => ws.some(([a, b]) => t >= a - 1e-6 && t < b - 1e-6);
  const vis = t => (shows ? inside(shows, t) : true) && !(hides && inside(hides, t));
  const edges = new Set([0]);
  for (const [a, b] of [...(shows || []), ...(hides || [])]) { edges.add(Math.max(0, a)); if (b < Infinity) edges.add(b); }
  const out = [];
  let last = null;
  for (const t of [...edges].sort((a, b) => a - b)) {
    if (t > length + 1) continue;
    const v = vis(t);
    if (v !== last) { out.push({ t, v, e: 'step' }); last = v; }
  }
  return out;
}

/** Turns the builder's lists into timeline tracks (anim.js) and the scene info. */
function compile(b, clipOf) {
  const tracks = {};
  // keys and holds, in time order; a hold copies the position and turn the keys before it leave
  for (const [id, keys] of Object.entries(b.keys)) tracks[id] = [...keys].sort(byT);
  for (const h of [...b.holds].sort(byT)) {
    const keys = (tracks[h.id] ||= []);
    const before = keys.filter(k => k.t <= h.t + 1e-9);
    if (keys.some(m => Math.abs(m.t - h.t) < 1e-6 && (m.p || m.q))) continue;   // keyed there already
    const k = { t: h.t, e: 'step' };
    for (const ch of ['p', 'q']) {
      const v = before.length ? anim.channelAt(before, ch, h.t) : null;
      if (v) k[ch] = v;
    }
    if (k.p || k.q) { keys.push(k); keys.sort(byT); }
  }
  // two keys at one moment: the later one written wins for its channels
  for (const id of Object.keys(tracks)) {
    const merged = [];
    for (const k of tracks[id]) {
      const same = merged.find(m => Math.abs(m.t - k.t) < 1e-6);
      if (same) Object.assign(same, k); else merged.push({ ...k });
    }
    tracks[id] = merged;
  }
  // showing
  for (const id of new Set([...Object.keys(b.shows), ...Object.keys(b.hides)])) {
    const vk = windowsToKeys(b.shows[id], b.hides[id], b.length);
    const keys = (tracks[id] ||= []);
    for (const k of vk) {
      const same = keys.find(m => Math.abs(m.t - k.t) < 1e-6);
      if (same) same.v = k.v; else keys.push({ t: k.t, v: k.v, e: keys.length ? 'smooth' : 'step' });
    }
    keys.sort(byT);
  }
  // camera shots, framed on where the umas are by now
  shotKeys(b, tracks);
  for (const [key, list] of Object.entries(b.motions)) {
    // a clip that can't be found is left out (the check says so)
    tracks['motion:' + key] = list.sort(byT).map(k => {
      const clip = clipOf(key, k.clip);
      const out = { t: k.t, clip, title: String(k.clip).replace(/^.*[|:/]/, '') };
      if (k.once !== undefined) out.once = k.once;
      return out;
    }).filter(k => k.clip);
  }
  for (const [key, list] of Object.entries(b.faces)) tracks['face:' + key] = list.sort(byT);
  return {
    length: b.length,
    tracks,
    scene: {
      name: b.def.name, title: b.def.title || b.def.name,
      beats: [...b.beats].sort((x, y) => x.t0 - y.t0), lines: [...b.lines].sort(byT),
      fx: b.fxKeys.length ? b.fxKeys.sort(byT) : null, focusKeys: b.focusKeys.length ? b.focusKeys.sort(byT) : null,
      haze: b.hazeV, shakes: b.shakes,
    },
  };
}

/** Where an uma is at t on the compiled tracks: { p, ry, v }. */
function umaAt(tracks, u, t) {
  const keys = tracks[u.key === 'main' ? 'her' : 'uma:' + u.key] || [];
  const p = (keys.length && anim.channelAt(keys, 'p', t)) || u.rest.p;
  const q = (keys.length && anim.channelAt(keys, 'q', t)) || u.rest.q;
  const v = keys.length ? anim.channelAt(keys, 'v', t) : null;
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(q));
  return { p, ry: Math.atan2(f.x, f.z), v: v === null ? true : v };
}

function shotKeys(b, tracks) {
  if (!b.shots.length) return;
  const cam = (tracks.camera ||= []);
  const aspect = b.env.aspect;
  const fov0 = b.def.fov || 32;
  const umaOf = who => b.env.umas[who];
  for (const sh of [...b.shots].sort((x, y) => x.t0 - y.t0)) {
    const ons = sh.on === undefined ? [] : Array.isArray(sh.on) && typeof sh.on[0] === 'number' ? null : [].concat(sh.on);
    for (const w of ons || []) if (!umaOf(w)) b.err(`shot at ${sh.t0} s: no uma called "${w}"`);
    const to = sh.to || {};
    const fov = sh.fov || fov0;
    // the framing at time t, part u of the way to `to`
    const lerp = (x, y, u) => (y === undefined ? x : x + (y - x) * u);
    const sizeA = sh.size ?? (ons === null ? 'wide' : 'full'), sizeB = to.size ?? sizeA;
    // where the picture looks on her: by the size's rule, or for metres the matching height
    const lookOf = (size, m) => typeof size === 'number' ? Math.max(m.top * 0.5, m.head - size * 0.33) : lookY(size, m);
    const frame = (t, u) => {
      let center, ry = 0, H;
      if (ons === null) {
        const m = { top: UMA_H, head: UMA_H - 0.12 };
        center = new THREE.Vector3(...sh.on);
        H = lerp(sizeHeight(sizeA, m), sizeHeight(sizeB, m), u);
      } else {
        const where = ons.map(w => ({ u: umaOf(w), at: null })).filter(x => x.u);
        if (!where.length) return null;
        for (const x of where) x.at = umaAt(tracks, x.u, sh.follow ? t : sh.t0);
        const m = where[0].u;
        ry = where[0].at.ry;                 // the first one named: her front is the shot's front
        H = lerp(sizeHeight(sizeA, m), sizeHeight(sizeB, m), u);
        const ly = x => lerp(lookOf(sizeA, x.u), lookOf(sizeB, x.u), u);
        center = new THREE.Vector3(where.reduce((s, x) => s + x.at.p[0], 0) / where.length,
                                   where.reduce((s, x) => s + x.at.p[1] + ly(x), 0) / where.length,
                                   where.reduce((s, x) => s + x.at.p[2], 0) / where.length);
        // several: wide enough for all of them
        if (where.length > 1) {
          let spread = 0;
          for (const a of where) for (const c of where) spread = Math.max(spread, Math.hypot(a.at.p[0] - c.at.p[0], a.at.p[2] - c.at.p[2]));
          H = Math.max(H, (spread + 0.9) / aspect);
        }
      }
      if (sh.yaw !== undefined) ry = lerp(sh.yaw, to.yaw, u) * DEG;
      const angle = lerp(sh.angle || 0, to.angle, u) * DEG, tilt = lerp(sh.tilt ?? 6, to.tilt, u) * DEG;
      const dist = sh.dist !== undefined ? lerp(sh.dist, to.dist, u) : (H / 2) / Math.tan((fov / 2) * DEG);
      const az = ry + angle;
      const look = center.add(new THREE.Vector3(...(sh.offset || [0, 0, 0])));
      const p = look.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(tilt), Math.sin(tilt), Math.cos(az) * Math.cos(tilt)).multiplyScalar(dist));
      if (sh.height !== undefined) p.y = look.y + lerp(sh.height, to.height, u);
      return { p: p.toArray().map(v => +v.toFixed(4)), tg: look.toArray().map(v => +v.toFixed(4)), fov };
    };
    // a shot replaces the camera keys inside it
    for (let i = cam.length - 1; i >= 0; i--) if (cam[i].t >= sh.t0 - 1e-6 && cam[i].t < sh.t1 - 1e-6) cam.splice(i, 1);
    const ease = sh.e || 'smooth';
    const easeF = { smooth: u => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2, linear: u => u, out: u => 1 - (1 - u) ** 3, in: u => u * u * u }[ease] || (u => u);
    const end = sh.t1 - 0.001;
    if (sh.follow) {
      const n = Math.max(2, Math.ceil((end - sh.t0) / 0.2));
      for (let k = 0; k <= n; k++) {
        const t = sh.t0 + (end - sh.t0) * k / n;
        const f = frame(t, easeF(k / n));
        if (f) cam.push({ t, ...f, e: k === 0 ? 'step' : 'linear' });
      }
    } else {
      const a = frame(sh.t0, 0), z = frame(sh.t0, 1);
      if (a) cam.push({ t: sh.t0, ...a, e: 'step' });
      if (z) cam.push({ t: end, ...z, e: ease });
    }
    cam.sort(byT);
  }
}

// --- checking ----------------------------------------------------------------------------------

/** What looks wrong, without rendering: nobody in the shot, umas inside each other, the camera
 *  under the ground, keys that point at nothing. */
function check(b, out, env) {
  const msgs = b.errors.map(m => ({ level: 'error', msg: m }));
  const tracks = out.tracks;
  const cam = tracks.camera;
  const umas = Object.entries(env.umas);
  const camera = new THREE.PerspectiveCamera(32, env.aspect, 0.1, 5000);
  const fr = new THREE.Frustum(), m4 = new THREE.Matrix4();
  const seen = (t, u) => {
    if (!cam) return true;
    camera.position.fromArray(anim.channelAt(cam, 'p', t));
    camera.fov = anim.channelAt(cam, 'fov', t) ?? (b.def.fov || 32);
    camera.updateProjectionMatrix();
    camera.lookAt(new THREE.Vector3(...anim.channelAt(cam, 'tg', t)));
    camera.updateMatrixWorld();
    fr.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const at = umaAt(tracks, u, t);
    const head = new THREE.Vector3(at.p[0], at.p[1] + u.head, at.p[2]), hip = new THREE.Vector3(at.p[0], at.p[1] + u.top * 0.5, at.p[2]);
    return fr.containsPoint(head) || fr.containsPoint(hip);
  };
  // each beat: who's in the picture halfway through
  out.scene.beats.forEach((bt, i) => {
    const t = (bt.t0 + bt.t1) / 2;
    const inShot = umas.filter(([, u]) => umaAt(tracks, u, t).v && seen(t, u)).map(([a]) => a);
    bt.inShot = inShot;
    if (!inShot.length && !bt.note?.includes('no uma')) msgs.push({ level: 'warn', t, msg: `beat ${i + 1} "${bt.title}": no uma in the picture at ${t.toFixed(1)} s` });
  });
  for (let t = 0; t <= out.length; t += 0.25) {
    // umas inside each other
    for (let i = 0; i < umas.length; i++) for (let j = i + 1; j < umas.length; j++) {
      const a = umaAt(tracks, umas[i][1], t), c = umaAt(tracks, umas[j][1], t);
      if (a.v && c.v && Math.hypot(a.p[0] - c.p[0], a.p[2] - c.p[2]) < 0.35 && Math.abs(a.p[1] - c.p[1]) < 1)
        msgs.push({ level: 'warn', t, msg: `${umas[i][0]} and ${umas[j][0]} stand inside each other at ${t.toFixed(2)} s` });
    }
    if (cam) {
      const p = anim.channelAt(cam, 'p', t);
      const g = env.ground(p[0], p[2], p[1] + 0.5);
      if (g !== null && p[1] < g + 0.05) msgs.push({ level: 'warn', t, msg: `the camera is under the ground at ${t.toFixed(2)} s` });
    }
  }
  for (const [id, keys] of Object.entries(tracks)) {
    if (!id.startsWith('part:')) continue;
    const [, name] = id.slice(5).split('|');
    if (!env.hasPart(name)) msgs.push({ level: 'error', msg: `no part called "${name}" in the place` });
    for (const k of keys) if (k.t > out.length + 0.5) msgs.push({ level: 'warn', msg: `${id} has a key after the end (${k.t} s)` });
  }
  // the same warning every quarter second is one warning
  const seenMsg = new Map();
  for (const m of msgs) {
    const key = m.msg.replace(/at [\d.]+ s/, '');
    const had = seenMsg.get(key);
    if (had) { had.until = m.t; had.n++; } else seenMsg.set(key, { ...m, n: 1 });
  }
  return [...seenMsg.values()].map(m => m.n > 1 ? { ...m, msg: m.msg.replace(/at [\d.]+ s/, `from ${m.t.toFixed(2)} to ${m.until.toFixed(2)} s`) } : m);
}

// --- loading a scene -------------------------------------------------------------------------------

const scenePath = (name, file) => `/scenes/${encodeURIComponent(name)}/${file}`;

async function importScene(name) {
  const st = await getJson('/api/scenes/stamp?name=' + encodeURIComponent(name), null);
  if (!st.ok) throw new Error(`no scene called "${name}" in Pictures\\UmaStudio\\scenes`);
  const mod = await import(scenePath(name, 'scene.js') + '?v=' + st.time);
  const def = { ...(mod.default || mod.scene) };
  if (!def.build) throw new Error('scene.js needs export default { ..., build(s) { } }');
  def.name = name;
  return { def, stamp: st.time };
}

/** The place, cast and props the scene wants; only what differs from now is loaded. */
async function setUp(def) {
  if (def.size) ctx.useSize(def.size);
  if (def.fps) ctx.setFps(def.fps);
  // the place, with its added places
  if (def.place) {
    const pl = typeof def.place === 'string' ? { id: def.place } : def.place;
    const extras = (def.extras || []).map(x => ({ key: x.key, id: x.id, cond: x.cond || [0, 0, 0], alt: x.alt ?? null }));
    const all = store.get('stageEdits', {});
    const was = all[pl.id] || { parts: {}, her: null, hers: {}, extras: [] };
    const sameExtras = JSON.stringify(was.extras || []) === JSON.stringify(extras);
    if (!sameExtras) store.set('stageEdits', { ...all, [pl.id]: { ...was, extras } });
    const cond = pl.cond || [0, 0, 0], alt = pl.alt ?? null;
    const st = ctx.stage();
    if (!st.group || st.id !== pl.id || !sameExtras || JSON.stringify(ctx.condOf(pl.id)) !== JSON.stringify(cond))
      await ctx.openStage(pl.id, cond, alt);
    ctx.setBg('stage');
    // added places come in one by one after the place
    const want = extras.map(x => 'x' + x.key);
    for (let i = 0; i < 1200; i++) {
      const g = ctx.stage().group;
      let n = 0;
      g?.traverse(o => { if (o.userData.extra && want.includes(o.name)) n++; });
      if (n >= want.length) break;
      await new Promise(r => setTimeout(r, 250));
    }
  } else if (def.bg) ctx.setBg(def.bg);
  // the cast: the first one is the main uma
  const entries = Object.entries(def.cast || {});
  if (!entries.length) throw new Error('the scene needs a cast: { alias: chara id, ... }');
  const umas = entries.map(([alias, v], i) => {
    const c = typeof v === 'number' ? { chara: v } : v;
    return { alias, key: i === 0 ? 'main' : alias, chara: c.chara, dress: c.dress || null };
  });
  for (const u of umas) {
    const have = ctx.members().find(m => m.key === u.key);
    if (have && have.chara === u.chara && (!u.dress || have.dressId === u.dress)) continue;
    const c = ctx.charas().find(x => x.id === u.chara);
    if (!c) throw new Error(`no uma with id ${u.chara} (${u.alias})`);
    await ctx.chooseUma(c, u.dress, u.key);
  }
  for (const m of [...ctx.members()]) if (!umas.some(u => u.key === m.key)) ctx.removeMember(m);
  ctx.setActive(ctx.members().find(m => m.key === 'main'));
  // props: kept when they're the same, the rest swapped
  const props = ctx.props();
  const want = Object.entries(def.props || {}).map(([name, v]) => [name, propSpec(name, v, umas)]);
  const sigOf = p => JSON.stringify({ kind: p.kind, name: p.name || undefined, anchor: p.anchor, owner: p.owner, image: p.image || undefined,
                                      dims: p.kind === 'card' || p.kind === 'box' ? p.dims : undefined });
  const sigWant = spec => JSON.stringify({ kind: spec.kind, name: spec.opts.name, anchor: spec.opts.anchor, owner: spec.opts.owner,
                                           image: spec.opts.image, dims: spec.opts.dims });
  for (const p of [...props.list]) {
    const w = want.find(([n]) => n === p.key);
    if (!w || sigOf(p) !== sigWant(w[1])) props.remove(p);
  }
  for (const [name, spec] of want) {
    const p = props.list.find(x => x.key === name) || await props.add(spec.kind, { key: name, ...spec.opts }, true);
    props.placeDefault(p);
    if (spec.kind === 'model' && !spec.hand) {
      // models at their own size (the props panel shrinks big ones to fit)
      const k = p.holder.children[0]?.scale.x || 1;
      p.holder.scale.setScalar(Math.abs(k - 1) > 1e-6 ? 1 / k : 1);
      p.holder.position.set(0, 0, 0);
    }
    if (spec.grip) {
      if (spec.grip.p) p.holder.position.fromArray(spec.grip.p);
      p.holder.quaternion.setFromEuler(new THREE.Euler((spec.grip.rx || 0) * DEG, (spec.grip.ry || 0) * DEG, (spec.grip.rz || 0) * DEG, 'YXZ'));
    }
    p.sceneBase = p.holder.scale.x;     // size keys are times this (the timeline rescales the holder)
  }
  props.select(null);
  return umas;
}

function propSpec(name, v, umas) {
  const s = typeof v === 'string' ? (/\.glb$/i.test(v) ? { model: v } : /^pfb_chr_prop/.test(v) ? { game: v } : { card: v }) : v;
  const ownerKey = s.hand ? umas.find(u => u.alias === s.hand)?.key : 'main';
  if (s.hand && !ownerKey) throw new Error(`prop ${name}: no uma called "${s.hand}"`);
  const anchor = s.hand ? (s.side || 'right') : 'floor';
  const kind = s.model ? 'model' : s.game ? 'game' : s.box ? 'box' : 'card';
  const opts = { anchor, owner: ownerKey };
  if (kind === 'model') opts.name = s.model;
  else if (kind === 'game') opts.name = s.game;
  else {
    const img = s.card || s.box;
    opts.image = img.startsWith('/') ? img : '/img/' + img;
    opts.dims = kind === 'card' ? { h: s.h || 0.3 } : { w: s.w || 0.3, h: s.h || 0.22, d: s.d || 0.22 };
  }
  return { kind, opts, hand: s.hand, grip: s.grip || null };
}

/** What the builder needs to know about the loaded scene. */
function environment(umas, def) {
  const placeId = ctx.stage().id;
  const group = ctx.stage().group;
  const rc = new THREE.Raycaster();
  group?.updateMatrixWorld(true);
  const ground = (x, z, from = 400) => {
    if (!group) return 0;
    rc.set(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
    const h = rc.intersectObject(group, true).find(h => h.object.isMesh && h.object.visible && visibleUp(h.object) && !/sky|cloud/i.test(h.object.name + h.object.parent?.name));
    return h ? h.point.y : (from === 400 ? 0 : null);
  };
  const visibleUp = o => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
  const node = name => group?.getObjectByName(name) || null;
  const [W, H] = (def.size || ctx.size()).split('x').map(Number);
  const env = {
    placeId, aspect: W / H, ground,
    hasPart: name => !!node(name),
    partNames: () => {
      const out = [];
      const base = group && (group.children.length === 1 ? group.children[0] : group);
      base?.children.forEach(c => { out.push(c.name); if (c.userData.extra) c.children.forEach(d => out.push(d.name)); });
      return out;
    },
    box: name => {
      const o = node(name);
      if (!o) return null;
      const b = new THREE.Box3().setFromObject(o, true);
      return { min: b.min.toArray(), max: b.max.toArray(), center: b.getCenter(new THREE.Vector3()).toArray(), size: b.getSize(new THREE.Vector3()).toArray() };
    },
    umas: {}, props: {},
  };
  for (const u of umas) {
    const m = ctx.members().find(x => x.key === u.key);
    let head = UMA_H - 0.12;
    if (m) {
      // standing, from the skeleton as modelled (whatever pose she is in now)
      let hb = null;
      m.root.traverse(o => { if (!hb && o.isBone && /^Head(_\d+)?$/.test(o.name)) hb = o; });
      if (hb) {
        const M = new THREE.Matrix4(), L = new THREE.Matrix4();
        const chain = [];
        for (let o = hb; o && o !== m.root; o = o.parent) chain.unshift(o);
        M.copy(m.root.matrix);
        for (const o of chain) {
          const r = m.rest.get(o);
          M.multiply(r ? L.compose(r[0], r[1], r[2]) : o.matrix);
        }
        // the bone sits at the base of the skull: about eye level a little above
        head = new THREE.Vector3().setFromMatrixPosition(M).y + 0.09;
      }
    }
    env.umas[u.alias] = { key: u.key, alias: u.alias, head, top: head + 0.12, name: m?.name || u.alias,
                          rest: { p: m ? m.spot.position.toArray() : [0, 0, 0], q: m ? m.spot.quaternion.toArray() : [0, 0, 0, 1] } };
  }
  for (const p of ctx.props().list) env.props[p.key] = { base: p.sceneBase ?? 1 };
  return env;
}

/** Clip names to what the viewer plays: 'Idle_Loop' or 'UAL1:Idle_Loop' -> anim:UAL1.glb|Idle_Loop,
 *  her own motion names and library paths as they are. */
async function clipResolver(umas, b) {
  const sets = await ctx.importedSets();
  const imported = sets.map(s => s.parts[0][1]);   // anim:<file>|<clip>
  return (key, clip) => {
    if (clip === 'rest' || clip.startsWith('anim:') || clip.includes('/')) return clip;
    const m = ctx.members().find(x => x.key === key);
    let file = null, name = clip;
    const colon = clip.indexOf(':');
    if (colon > 0) { file = clip.slice(0, colon).toLowerCase(); name = clip.slice(colon + 1); }
    const hit = imported.find(id => {
      const [f, n] = id.slice(5).split('|');
      return n.replace(/^.*\|/, '') === name && (!file || f.toLowerCase().replace(/\.glb$/, '') === file);
    }) || imported.find(id => id.slice(5).split('|')[1].toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    if (m?.manifest?.motions?.some(x => x.name === clip)) return clip;
    b.err(`no animation called "${clip}" (for ${umas.find(u => u.key === key)?.alias})`);
    return null;
  };
}

/** Parts a previous scene keyed go back to how the place has them, so the ground and boxes the
 *  builder measures are the place's own. */
function resetKeyedParts() {
  const g = ctx.stage().group;
  const prev = anim.animDebug.data.tracks;
  if (!g) return;
  for (const id of Object.keys(prev)) {
    if (!id.startsWith('part:')) continue;
    const o = g.getObjectByName(id.slice(5).split('|')[1]);
    const r = o?.userData.rest;
    if (!r) continue;
    o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s);
    o.visible = !o.userData.userHidden;
  }
}

/** Loads (or reloads) a scene by its folder name. Returns { beats, warnings }. Loads queue up:
 *  two at once would both swap the umas and props. */
let queue = Promise.resolve();
let pending = 0;
export function load(name, { unlessLoaded = false } = {}) {
  const run = queue.then(() => (unlessLoaded && (current || pending > 1) ? null : loadNow(name)));
  pending++;
  const done = () => { pending--; };
  run.then(done, done);
  queue = run.catch(() => {});
  return run;
}

async function loadNow(name) {
  const { def, stamp } = await importScene(name);
  const umas = await busy('Setting up the scene…', setUp(def));
  resetKeyedParts();
  const env = environment(umas, def);
  const b = new Builder(def, env);
  try { def.build(b); } catch (e) { b.err('build(s) stopped: ' + e.message); console.error(e); }
  const clipOf = await clipResolver(umas, b);
  const out = compile(b, clipOf);
  const warnings = check(b, out, env);
  for (const [id, keys] of Object.entries(out.tracks)) {
    if (!id.startsWith('face:')) continue;
    const presets = ctx.facePresets(id.slice(5));
    const alias = umas.find(u => u.key === id.slice(5))?.alias;
    for (const k of keys) if (presets && !presets.includes(k.face))
      warnings.push({ level: 'error', msg: `${alias} has no face "${k.face}" (she has ${presets.slice(0, 30).join(', ')})` });
  }
  anim.setScene(out);
  current = { name, def, stamp, out, warnings, env };
  await loadNotes(name);
  await put(name, 'script.json', JSON.stringify(out.scene.lines.map(l => [+l.t.toFixed(2), l.text]), null, 1));
  await put(name, 'check.json', JSON.stringify({ when: new Date().toISOString(), length: out.length,
    beats: out.scene.beats.map((x, i) => ({ n: i + 1, t0: x.t0, t1: x.t1, title: x.title, inShot: x.inShot })), warnings }, null, 1));
  store.set('scene', name);
  ctx.afterLoad();
  renderPanel();
  return { beats: out.scene.beats, warnings };
}

async function put(name, path, body) {
  await call(`/api/scenes/put?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`,
             { method: 'POST', headers: { 'X-Studio': '1' }, body }, null).catch(e => console.warn('scene put', path, e));
}

// --- sheets ------------------------------------------------------------------------------------------

/** Frames from the scene in one picture, each labelled with its beat and time. times: seconds, or
 *  left out for `per` frames per beat. Saved as sheets\<file>.png in the scene's folder. */
export async function sheet({ times = null, per = 1, width = 216, file = 'sheet', pre = 0.6, cols = 0 } = {}) {
  if (!current) throw new Error('no scene loaded');
  const beats = current.out.scene.beats;
  const list = [];
  if (times) for (const t of times) list.push({ t, beat: anim.beatAt(t) });
  else beats.forEach((bt, i) => {
    for (let k = 0; k < per; k++) {
      const u = per === 1 ? 0.5 : 0.12 + 0.76 * k / (per - 1);
      list.push({ t: bt.t0 + (bt.t1 - bt.t0) * u, beat: i });
    }
  });
  if (!list.length) for (let t = 0.5; t < current.out.length; t += 2) list.push({ t, beat: -1 });
  const [W, H] = ctx.size().split('x').map(Number);
  const w = width, h = Math.round(width * H / W), label = 30;
  const n = list.length, c = cols || Math.min(n, Math.max(4, Math.ceil(Math.sqrt(n * h / w))));
  const rows = Math.ceil(n / c);
  const can = document.createElement('canvas');
  can.width = c * w; can.height = rows * (h + label);
  const g = can.getContext('2d');
  g.fillStyle = '#1d1d1d'; g.fillRect(0, 0, can.width, can.height);
  ctx.freeze(true);
  try {
    for (let i = 0; i < n; i++) {
      const { t, beat } = list[i];
      await ctx.settle(t, pre);
      const f = ctx.renderFrame(w, h, 1);
      const x = (i % c) * w, y = Math.floor(i / c) * (h + label);
      g.putImageData(new ImageData(f.data, f.width, f.height), x, y);
      g.fillStyle = '#2b2b2b'; g.fillRect(x, y + h, w, label);
      g.fillStyle = '#e6e6e6'; g.font = '600 12px Segoe UI, sans-serif';
      const bt = beats[beat];
      g.fillText(`${beat >= 0 ? beat + 1 + '. ' : ''}${t.toFixed(2)} s`, x + 5, y + h + 13);
      g.fillStyle = '#9a9a9a'; g.font = '11px Segoe UI, sans-serif';
      g.fillText((bt?.title || '').slice(0, 34), x + 5, y + h + 26);
      g.strokeStyle = '#000'; g.strokeRect(x + 0.5, y + 0.5, w - 1, h + label - 1);
      $('#sceneStatus').textContent = `Sheet: frame ${i + 1} of ${n}`;
    }
  } finally {
    ctx.freeze(false);
    anim.seek(anim.now());
  }
  const blob = await new Promise(r => can.toBlob(r, 'image/png'));
  const res = await call(`/api/scenes/put?name=${encodeURIComponent(current.name)}&path=${encodeURIComponent(`sheets/${file}.png`)}`,
                         { method: 'POST', headers: { 'X-Studio': '1' }, body: blob }, 'Saving the sheet…');
  $('#sceneStatus').textContent = 'Sheet saved';
  return res.path;
}

// --- notes ---------------------------------------------------------------------------------------

async function loadNotes(name) {
  const r = await fetch(scenePath(name, 'notes.json') + '?v=' + Date.now()).catch(() => null);
  notes = r && r.ok ? await r.json().catch(() => ({})) : {};
}

function saveNotes() {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { if (current) put(current.name, 'notes.json', JSON.stringify(notes, null, 1)); }, 600);
}

// --- the panel -------------------------------------------------------------------------------------

async function fillList() {
  const items = (await getJson('/api/scenes', null).catch(() => ({ items: [] }))).items;
  const sel = $('#sceneList');
  const keep = sel.value || store.get('scene', '');
  sel.innerHTML = '';
  if (!items.length) sel.add(new Option('No scene files yet', ''));
  for (const it of items) sel.add(new Option(it.name, it.name));
  if (items.some(i => i.name === keep)) sel.value = keep;
}

let shownBeat = -2;
function renderPanel() {
  const box = $('#sceneBeats');
  box.innerHTML = '';
  shownBeat = -2;
  if (!current) { $('#sceneInfo').textContent = 'No scene loaded'; $('#sceneWarn').innerHTML = ''; return; }
  const { out, warnings } = current;
  const errs = warnings.filter(w => w.level === 'error').length, warns = warnings.length - errs;
  $('#sceneInfo').textContent = `${out.scene.beats.length} beats · ${out.length} s` + (errs ? ` · ${errs} error${errs > 1 ? 's' : ''}` : '') + (warns ? ` · ${warns} warning${warns > 1 ? 's' : ''}` : '');
  out.scene.beats.forEach((bt, i) => {
    const row = document.createElement('div');
    row.className = 'beatRow';
    row.innerHTML = '<span class="n"></span><span class="t"></span><span class="name"></span><i></i>';
    row.querySelector('.n').textContent = i + 1;
    row.querySelector('.t').textContent = bt.t0.toFixed(1);
    row.querySelector('.name').textContent = bt.title;
    row.querySelector('i').textContent = notes[bt.title] ? '✎' : '';
    row.title = bt.say ? `"${bt.say}"` : bt.title;
    row.onclick = () => anim.seek(bt.t0 + 1e-3);
    box.appendChild(row);
  });
  const wl = $('#sceneWarn');
  wl.innerHTML = '';
  for (const w of warnings.slice(0, 40)) {
    const d = document.createElement('div');
    d.className = 'warnRow ' + w.level;
    d.textContent = w.msg;
    if (w.t !== undefined) d.onclick = () => anim.seek(w.t);
    wl.appendChild(d);
  }
  tick(true);
}

/** Called every frame: the playing beat is marked, its note shows. */
export function tick(force = false) {
  if (!current) return;
  const i = anim.beatAt();
  if (i === shownBeat && !force) return;
  shownBeat = i;
  [...$('#sceneBeats').children].forEach((r, k) => r.classList.toggle('on', k === i));
  const bt = current.out.scene.beats[i];
  const ta = $('#sceneNote');
  ta.disabled = !bt;
  ta.placeholder = bt ? `What should change in "${bt.title}"?` : 'Move into a beat to write about it';
  if (document.activeElement !== ta) ta.value = bt ? notes[bt.title] || '' : notes[''] || '';
  $('#sceneSay').textContent = bt?.say ? `"${bt.say}"` : '';
}

function setWatch(on) {
  clearInterval(watchTimer);
  store.set('sceneWatch', on);
  if (!on) return;
  watchTimer = setInterval(async () => {
    if (!current || reloading) return;
    const st = await getJson('/api/scenes/stamp?name=' + encodeURIComponent(current.name), null).catch(() => null);
    if (st?.ok && st.time !== current.stamp) reload();
  }, 1200);
}

let reloading = false;
async function reload(name = current?.name || $('#sceneList').value) {
  if (!name || reloading) return;
  reloading = true;
  $('#sceneStatus').textContent = `Loading ${name}…`;
  try {
    const r = await load(name);
    const errs = r.warnings.filter(w => w.level === 'error');
    $('#sceneStatus').textContent = errs.length ? errs[0].msg : 'Loaded ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('#sceneStatus').textContent = e.message;
    toast(e.message, true);
  } finally { reloading = false; }
}

export function initScenes(c) {
  ctx = c;
  fillList();
  $('#sceneList').onfocus = fillList;
  $('#sceneLoad').onclick = () => reload($('#sceneList').value);
  $('#sceneOpen').onclick = () => call('/api/open', { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ what: 'scenes', name: current?.name || $('#sceneList').value }) }, null);
  $('#sceneSheet').onclick = async () => {
    try { toast('Sheet saved: ' + await sheet({ per: 1 })); } catch (e) { toast(e.message, true); }
  };
  $('#sceneWatch').checked = store.get('sceneWatch', true);
  $('#sceneWatch').onchange = () => setWatch($('#sceneWatch').checked);
  setWatch($('#sceneWatch').checked);
  $('#sceneNote').oninput = () => {
    if (!current) return;
    const bt = current.out.scene.beats[anim.beatAt()];
    const k = bt ? bt.title : '';
    if ($('#sceneNote').value.trim()) notes[k] = $('#sceneNote').value; else delete notes[k];
    saveNotes();
    const row = $('#sceneBeats').children[anim.beatAt()];
    if (row) row.querySelector('i').textContent = notes[k] ? '✎' : '';
  };
  // a scene loaded last time comes back with the page (its tracks are on the timeline already)
  const last = store.get('scene', '');
  if (last && anim.sceneInfo()?.name === last)
    ctx.whenReady().then(() => load(last, { unlessLoaded: true })).catch(() => {});
}

/** Imported clip names by file, for scene writers. */
async function clipNames() {
  const out = {};
  for (const st of await ctx.importedSets()) {
    const [file, clip] = st.parts[0][1].slice(5).split('|');
    (out[file.replace(/\.glb$/i, '')] ||= []).push(clip);
  }
  return out;
}

/** Each uma's face presets by her alias. */
function faces() {
  const out = {};
  for (const u of Object.values(current?.env.umas || {})) out[u.alias] = ctx.facePresets(u.key) || [];
  return out;
}

export const scenesDebug = { load, sheet, clipNames, faces, get current() { return current; }, reload, get notes() { return notes; } };
