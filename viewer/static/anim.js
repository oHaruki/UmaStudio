import * as THREE from 'three';
import { $, $$, store, radio, typing } from '/static/ui.js';

// animating the scene: keys on a scene clock for the place's parts and added places, props, her
// spot and the camera. between two keys things move with the later key's ease. the scene clock
// also drives her motion (looping) and the models' own animations, and a video records it whole.
//
// a key holds a transform and whether the thing shows. showing doesn't fade: it switches at the
// key, so "pop in" is a hidden key, a tiny visible one and a full-size one right after.
//
// each uma also has motion keys ('motion:<her key>' tracks, { t, clip, title }): from a key on she
// plays that pose; viewer.js blends from one to the next. face keys ('face:<her key>', { t, face })
// switch her expression preset. her spot is 'her' for the first uma,
// 'uma:<key>' for the others.

const EASES = {
  smooth: u => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2,
  linear: u => u,
  out: u => 1 - (1 - u) ** 3,
  in: u => u * u * u,
  back: u => { const c = 1.9; return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2; },
  bounce: u => {
    const n = 7.5625, d = 2.75;
    if (u < 1 / d) return n * u * u;
    if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
    if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
    return n * (u -= 2.625 / d) * u + 0.984375;
  },
  step: () => 0,
};
const SNAP = 1 / 60;          // keys this close count as the same moment
const TINY = 0.001;

let ctx = null;
let data = load();
let time = 0;
let mode = store.get('animMode', 'picked');   // what gets keyed: picked | her | camera
let source = null;                             // which editor picked last: 'stage' | 'prop'
let dirty = true;                              // keys or time changed since the last apply

function load() {
  const d = store.get('anim', null);
  return d && d.tracks ? d : { length: 10, tracks: {} };
}
const save = () => store.set('anim', data);

// --- targets ---------------------------------------------------------------------------------

/** What would be keyed now: { id, label, obj } (obj null for the camera), or null. */
function target() {
  if (mode === 'camera') return { id: 'camera', label: 'the camera', obj: null };
  if (mode === 'her') return spotTarget(ctx.place);
  const prop = ctx.selectedProp();
  const part = ctx.stagePicked();
  const usePart = part && (source !== 'prop' || !prop);
  if (usePart) {
    if (part === ctx.place || ctx.keyOfSpot(part)) return spotTarget(part);
    return { id: `part:${ctx.placeId()}|${part.name}`, label: ctx.partLabel(part), obj: part };
  }
  if (prop) return { id: 'prop:' + prop.key, label: ctx.propLabel(prop), obj: prop.holder };
  return null;
}

/** An uma's spot as a keying target. */
function spotTarget(spot) {
  const key = ctx.keyOfSpot(spot) || 'main';
  const name = ctx.activeMember()?.key === key ? ctx.activeMember().name : null;
  return { id: key === 'main' ? 'her' : 'uma:' + key, label: name ? `${name}'s spot` : 'her spot', obj: spot };
}

/** The object a track moves, if it's around right now. */
function resolve(id) {
  if (id === 'her') return ctx.spotOf('main') || ctx.place;
  if (id.startsWith('uma:')) return ctx.spotOf(id.slice(4));
  if (id.startsWith('prop:')) return ctx.propByKey(id.slice(5))?.holder || null;
  if (id.startsWith('part:')) {
    const [pid, name] = id.slice(5).split('|');
    if (pid !== ctx.placeId()) return null;
    return ctx.stageGroup()?.getObjectByName(name) || null;
  }
  return null;
}

// --- keys ---------------------------------------------------------------------------------------

function snapshot(obj) {
  if (!obj) {
    const c = ctx.camera;
    return { p: c.position.toArray(), tg: ctx.controls.target.toArray(), fov: c.fov };
  }
  return { p: obj.position.toArray(), q: obj.quaternion.toArray(), s: obj.scale.toArray(), v: obj.visible };
}

function putKey(id, key) {
  const keys = (data.tracks[id] ||= []);
  const i = keys.findIndex(k => Math.abs(k.t - key.t) < SNAP);
  if (i >= 0) keys[i] = key; else keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  if (key.t > data.length - 0.5) data.length = Math.ceil(key.t + 1);
}

/** Keys in [from, to] taken out (a preset lays its own there). */
function clearRange(id, from, to) {
  const keys = data.tracks[id];
  if (!keys) return;
  data.tracks[id] = keys.filter(k => k.t < from - SNAP / 2 || k.t > to + SNAP / 2);
}

function changed() {
  for (const [id, keys] of Object.entries(data.tracks)) if (!keys.length) delete data.tracks[id];
  save();
  dirty = true;
  refresh();
  ctx.onChange?.();
}

const _p = new THREE.Vector3(), _p2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3(), _s2 = new THREE.Vector3(), _box = new THREE.Box3(), _size = new THREE.Vector3();

/** Where the keys are around t: [a, b, w] with w the eased way from a to b. */
function around(keys, t) {
  if (t <= keys[0].t) return [keys[0], keys[0], 0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return [last, last, 0];
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const u = (t - a.t) / (b.t - a.t);
  return [a, b, (EASES[b.e] || EASES.smooth)(u)];
}

function applyTrack(id, keys, t) {
  if (id.startsWith('motion:') || id.startsWith('face:')) return;   // viewer.js plays those
  if (id === 'camera') {
    const [a, b, w] = around(keys, t);
    const c = ctx.camera;
    c.position.lerpVectors(_p.fromArray(a.p), _p2.fromArray(b.p), w);
    ctx.controls.target.lerpVectors(_p.fromArray(a.tg), _p2.fromArray(b.tg), w);
    const fov = a.fov + (b.fov - a.fov) * w;
    if (Math.abs(fov - c.fov) > 1e-4) { c.fov = fov; c.updateProjectionMatrix(); }
    c.lookAt(ctx.controls.target);
    return;
  }
  const obj = resolve(id);
  if (!obj) return;
  const [a, b, w] = around(keys, t);
  // a key may leave out position, turn or size: those stay as they are
  if (a.p && b.p) obj.position.lerpVectors(_p.fromArray(a.p), _p2.fromArray(b.p), w);
  if (a.q && b.q) obj.quaternion.slerpQuaternions(_q.fromArray(a.q), _q2.fromArray(b.q), w);
  if (a.s && b.s) obj.scale.lerpVectors(_s.fromArray(a.s), _s2.fromArray(b.s), w);
  obj.visible = a === b || t < b.t ? a.v : b.v;
}

// --- presets -------------------------------------------------------------------------------------

/** The thing's size in the world and how a world offset reads in its parent's space. */
function worldSize(obj) {
  _box.setFromObject(obj);
  return _box.isEmpty() ? new THREE.Vector3(1, 1, 1) : _box.getSize(_size).clone();
}
function shifted(obj, worldOffset) {
  const at = obj.getWorldPosition(new THREE.Vector3()).add(worldOffset);
  return (obj.parent ? obj.parent.worldToLocal(at) : at).toArray();
}

const PRESETS = {
  // grows out of nothing with a little overshoot
  pop(id, obj, t, k) {
    const tiny = k.s.map(v => v * TINY);
    clearRange(id, t - 0.05, t + 0.4);
    putKey(id, { ...k, t: Math.max(0, t - 0.02), s: tiny, v: false, e: 'step' });
    putKey(id, { ...k, t, s: tiny, v: true, e: 'step' });
    putKey(id, { ...k, t: t + 0.35, v: true, e: 'back' });
  },
  // falls in from above, lands where it is now with one small hop (a full bounce throws a big
  // thing back out of the picture)
  drop(id, obj, t, k) {
    const h = Math.max(2, worldSize(obj).y * 1.5);
    const from = shifted(obj, new THREE.Vector3(0, h, 0));
    const hop = shifted(obj, new THREE.Vector3(0, h * 0.08, 0));
    clearRange(id, t - 0.05, t + 0.75);
    putKey(id, { ...k, t: Math.max(0, t - 0.02), p: from, v: false, e: 'step' });
    putKey(id, { ...k, t, p: from, v: true, e: 'step' });
    putKey(id, { ...k, t: t + 0.45, v: true, e: 'in' });
    putKey(id, { ...k, t: t + 0.57, p: hop, v: true, e: 'out' });
    putKey(id, { ...k, t: t + 0.7, v: true, e: 'in' });
  },
  // comes in from the left of the view
  slide(id, obj, t, k) {
    const size = worldSize(obj);
    const right = new THREE.Vector3().setFromMatrixColumn(ctx.camera.matrixWorld, 0).setY(0).normalize();
    const from = shifted(obj, right.multiplyScalar(-(Math.max(size.x, size.z) * 1.5 + 2)));
    clearRange(id, t - 0.05, t + 0.55);
    putKey(id, { ...k, t: Math.max(0, t - 0.02), p: from, v: false, e: 'step' });
    putKey(id, { ...k, t, p: from, v: true, e: 'step' });
    putKey(id, { ...k, t: t + 0.5, v: true, e: 'out' });
  },
  // shrinks away
  out(id, obj, t, k) {
    clearRange(id, t, t + 0.3);
    putKey(id, { ...k, t, v: true, e: 'smooth' });
    putKey(id, { ...k, t: t + 0.25, s: k.s.map(v => v * TINY), v: true, e: 'in' });
    putKey(id, { ...k, t: t + 0.27, v: false, e: 'step' });
  },
  // a shake, as if hit, then back
  wobble(id, obj, t, k) {
    const base = new THREE.Quaternion().fromArray(k.q);
    const turn = deg => base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(deg))).toArray();
    clearRange(id, t, t + 0.6);
    [[0, 0], [0.1, 9], [0.2, -7], [0.3, 5], [0.4, -3], [0.55, 0]].forEach(([dt, deg]) =>
      putKey(id, { ...k, t: t + dt, q: turn(deg), e: 'smooth' }));
  },
};

// --- panel ---------------------------------------------------------------------------------------

function keyNow() {
  const tg = target();
  if (!tg) return;
  putKey(tg.id, { t: time, ...snapshot(tg.obj), e: $('#animEase').value });
  changed();
}

function deleteKey() {
  const tg = target();
  const keys = tg && data.tracks[tg.id];
  if (!keys) return;
  const i = keys.findIndex(k => Math.abs(k.t - time) < 1 / 30);
  if (i < 0) return;
  keys.splice(i, 1);
  changed();
}

function preset(name) {
  const tg = target();
  if (!tg || !tg.obj) return;
  PRESETS[name](tg.id, tg.obj, time, { ...snapshot(tg.obj), v: true });
  changed();
}

function marks() {
  const box = $('#keyMarks');
  box.innerHTML = '';
  if (!active()) return;
  const tg = target();
  const L = data.length;
  // the active uma's motion keys: round, below the others
  const me = ctx.activeMember();
  for (const k of (me && data.tracks['motion:' + me.key]) || []) {
    const d = document.createElement('i');
    d.className = 'mot';
    d.style.left = (100 * Math.min(1, k.t / L)) + '%';
    d.title = `${me.name}: ${k.title} from ${k.t.toFixed(2)} s`;
    d.onclick = () => seek(k.t);
    box.appendChild(d);
  }
  // every key as a faint tick, the keyed thing's ones as diamonds you can click
  const seen = new Set();
  for (const [id, keys] of Object.entries(data.tracks)) {
    if (id.startsWith('motion:') || id.startsWith('face:')) continue;
    const mine = tg && id === tg.id;
    for (const k of keys) {
      const tag = (mine ? 'm' : 'o') + k.t.toFixed(3);
      if (seen.has(tag)) continue;
      seen.add(tag);
      const d = document.createElement('i');
      d.className = mine ? 'mine' : '';
      d.style.left = (100 * Math.min(1, k.t / L)) + '%';
      if (mine) {
        d.title = `${k.t.toFixed(2)} s`;
        d.onclick = () => seek(k.t);
      }
      box.appendChild(d);
    }
  }
}

function refresh() {
  const tg = target();
  radio('#animModes .chip', $(`#animModes .chip[data-mode="${mode}"]`));
  $('#animTarget').textContent = tg ? tg.label : 'nothing picked';
  const keys = tg && data.tracks[tg.id];
  $('#animCount').textContent = keys ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : 'no keys';
  $('#animKey').disabled = !tg;
  $('#playKey').disabled = !tg;
  $('#playKey').title = tg ? `K: key ${tg.label} at this moment` : 'Pick something to key (place editor, props, or Her / Camera in Render, Animation)';
  $('#animDel').disabled = !keys;
  $('#animClear').disabled = !keys;
  $$('#animPresets .chip').forEach(b => { b.disabled = !tg || !tg.obj; });
  $('#animLen').value = data.length;
  const me = ctx.activeMember();
  const mk = me ? motionKeys(me.key) : [];
  $('#animMotionWho').textContent = me ? `${me.name}'s motion` : 'Her motion';
  $('#animMotionCount').textContent = mk.length ? `${mk.length} key${mk.length === 1 ? '' : 's'}` : 'no keys';
  $('#animMotionKey').disabled = $('#playMotion').disabled = !me?.clip;
  $('#animMotionDel').disabled = !mk.some(k => Math.abs(k.t - time) < 1 / 30);
  $('#animClearAll').disabled = !active();
  marks();
}

// --- clock ---------------------------------------------------------------------------------------

/** Whether there's anything animated (the timeline is the scene's then, not her motion's). */
export function active() { return Object.keys(data.tracks).length > 0; }
export const length = () => data.length;
export const now = () => time;
export const hasCamera = () => !!data.tracks.camera?.length;

/** The scene clock moved by dt (playing), looping over the length. */
export function advance(dt) {
  time = (time + dt) % data.length;
  dirty = true;
}

export function seek(t) {
  time = Math.max(0, Math.min(data.length, t));
  dirty = true;
  ctx.onSeek?.(time);
}

/** Everything keyed put where it is at time t (now when left out). Skips when nothing changed,
 *  so dragging a thing with its handles while paused isn't undone each frame. */
export function apply(t = time, force = false) {
  if (!force && !dirty && t === time) return;
  dirty = false;
  for (const [id, keys] of Object.entries(data.tracks)) if (keys.length) applyTrack(id, keys, t);
}

/** A place, prop or her changed: keyed things go back to their keys. */
export function touch() { dirty = true; if (ctx) refresh(); }

export function initAnim(c) {
  ctx = c;
  $$('#animModes .chip').forEach(b => {
    b.onclick = () => { mode = b.dataset.mode; store.set('animMode', mode); refresh(); };
  });
  $('#animEase').value = store.get('animEase', 'smooth');
  $('#animEase').onchange = () => store.set('animEase', $('#animEase').value);
  $('#animKey').onclick = keyNow;
  $('#playKey').onclick = keyNow;
  $('#animMotionKey').onclick = keyActiveMotion;
  $('#animFaceKey').onclick = () => {
    const me = ctx.activeMember();
    if (me?.face) keyFace(me.key, me.face);
  };
  $('#playMotion').onclick = keyActiveMotion;
  $('#animMotionDel').onclick = () => {
    const me = ctx.activeMember();
    const keys = me && data.tracks['motion:' + me.key];
    const i = keys ? keys.findIndex(k => Math.abs(k.t - time) < 1 / 30) : -1;
    if (i < 0) return;
    keys.splice(i, 1);
    changed();
  };
  $('#animDel').onclick = deleteKey;
  $$('#animPresets .chip').forEach(b => { b.onclick = () => preset(b.dataset.preset); });
  $('#animClear').onclick = () => {
    const tg = target();
    if (tg) delete data.tracks[tg.id];
    changed();
  };
  $('#animClearAll').onclick = () => {
    if (!confirmClear()) return;
    data.tracks = {};
    changed();
  };
  $('#animLen').oninput = () => {
    data.length = Math.max(1, +$('#animLen').value || 10);
    if (time > data.length) seek(data.length);
    save();
    marks();
    ctx.onChange?.();
  };
  document.addEventListener('keydown', e => {
    if (typing() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === 'k') { e.preventDefault(); keyNow(); }
  });
  refresh();
}

// two clicks within a couple of seconds: no dialogs in this app
let armed = 0;
function confirmClear() {
  const now = performance.now();
  if (now - armed < 2500) { armed = 0; $('#animClearAll').textContent = 'Clear everything'; return true; }
  armed = now;
  $('#animClearAll').textContent = 'Click again to clear';
  setTimeout(() => { if (armed && performance.now() - armed >= 2500) { armed = 0; $('#animClearAll').textContent = 'Clear everything'; } }, 2600);
  return false;
}

/** An uma's motion keys, in time order. */
export function motionKeys(key) { return data.tracks['motion:' + key] || []; }

/** An uma's face keys, in time order. */
export function faceKeys(key) { return data.tracks['face:' + key] || []; }

/** From now on she has this expression preset. */
export function keyFace(key, face) {
  putKey('face:' + key, { t: time, face });
  changed();
}

/** From now on (the timeline's moment) she plays clip. */
export function keyMotion(key, clip, title) {
  putKey('motion:' + key, { t: time, clip, title });
  changed();
}

function keyActiveMotion() {
  const me = ctx.activeMember();
  if (!me?.clip) return;
  keyMotion(me.key, me.clip, me.title);
}

/** Every object a key moves that is around right now (for baking). */
export function animatedObjects() {
  return Object.keys(data.tracks).filter(id => id !== 'camera' && !id.startsWith('motion:') && !id.startsWith('face:')).map(resolve).filter(Boolean);
}

/** Something new was picked in the place editor or the props. */
export function picked(from) { source = from; if (ctx) refresh(); }

export const animDebug = { get data() { return data; }, seek, apply, advance, get time() { return time; } };
