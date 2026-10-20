import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { $, store, toast, typing, endDragOnRelease } from '/static/ui.js';

// pose mode: turn joints by hand on top of whatever the motion does. an edit is a rotation offset
// per bone, applied right after the motion poses the skeleton (applyEdits), so physics, the head
// turn, videos and model exports all see it. the rings rotate a proxy that sits on the bone; the
// offset is worked out from the proxy, so the motion never fights the drag.

const SIDES = ['L', 'R'];
const BODY = ['Hip', 'Waist', 'Spine', 'Chest', 'Neck', 'Head',
  ...SIDES.flatMap(s => ['Shoulder', 'Arm', 'Elbow', 'Wrist', 'Thigh', 'Knee', 'Ankle', 'Toe', 'Ear_01'].map(b => `${b}_${s}`))];
const FINGERS = SIDES.flatMap(s => ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap(f => [1, 2, 3].map(i => `${f}_0${i}_${s}`)));

const edits = new Map();          // bone name -> offset quaternion, local, after the motion
const under = new Map();          // bone -> { base: what the motion set this frame, put: base + offset }
const undoStack = [];
let ctx = null, cur = null, tc = null, proxy = null;
let showing = false, fingers = false, selected = null;
const dots = new THREE.Group();
dots.renderOrder = 999;
const dotGeo = new THREE.SphereGeometry(1, 12, 8);
const COLORS = { idle: 0x8db3ef, edited: 0xf0a040, picked: 0xffffff };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();

function dotMaterial(color) {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
}

function bones() {
  if (!cur) return [];
  return (fingers ? [...BODY, ...FINGERS] : BODY).map(n => cur.root.getObjectByName(n)).filter(Boolean);
}

function rebuildDots() {
  dots.children.slice().forEach(d => { d.material.dispose(); dots.remove(d); });
  if (!showing) return;
  for (const b of bones()) {
    const d = new THREE.Mesh(dotGeo, dotMaterial(COLORS.idle));
    d.renderOrder = 999;
    d.userData.bone = b;
    dots.add(d);
  }
}

/** Every frame, right after the motion: the offsets on top of it. */
export function applyEdits() {
  if (!cur) return;
  for (const [name, off] of edits) {
    const b = cur.root.getObjectByName(name);
    if (!b) continue;
    const base = b.quaternion.clone();
    b.quaternion.multiply(off);
    under.set(b, { base, put: b.quaternion.clone() });
  }
  if (selected && !under.has(selected)) under.set(selected, { base: selected.quaternion.clone(), put: selected.quaternion.clone() });
}

/** Right before the motion runs again: the offsets come off. the motion only rewrites bones it
 *  has tracks for (never the ears, nothing in the rest pose), so the others would stack another
 *  offset every frame. a bone something else has set since (rest pose, a grip) keeps that. */
export function liftEdits() {
  for (const [b, u] of under) if (b.quaternion.equals(u.put)) b.quaternion.copy(u.base);
  under.clear();
}

/** Every frame before drawing: dots on the joints at a steady size, the proxy on the picked bone. */
export function updateDots() {
  if (!showing || !cur) return;
  const cam = ctx.camera, h = ctx.canvas.clientHeight || 1;
  for (const d of dots.children) {
    const b = d.userData.bone;
    b.getWorldPosition(d.position);
    const dist = d.position.distanceTo(cam.position);
    const px = FINGERS.includes(b.name) ? 4.5 : 6.5;
    d.scale.setScalar(dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * 2 * px / h);
    d.material.color.setHex(b === selected ? COLORS.picked : edits.has(b.name) ? COLORS.edited : COLORS.idle);
  }
  if (selected && !tc.dragging) {
    selected.getWorldPosition(proxy.position);
    selected.getWorldQuaternion(proxy.quaternion);
  }
}

/** Hidden while a picture, video frame or thumbnail is drawn. */
export function gizmo(visible) {
  dots.visible = visible && showing;
  tc.visible = visible && !!selected;
}

function select(b) {
  selected = b;
  if (b) {
    b.getWorldPosition(proxy.position);
    b.getWorldQuaternion(proxy.quaternion);
    tc.attach(proxy);
    ctx.onPick?.();
  } else tc.detach();
  $('#poseJoint').textContent = b ? b.name.replace(/_/g, ' ') : 'none';
  $('#poseResetJoint').disabled = !b;
}

function snapshot() { return new Map([...edits].map(([k, q]) => [k, q.clone()])); }
function remember() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
}
function restore(m) {
  edits.clear();
  m.forEach((q, k) => edits.set(k, q.clone()));
  refreshCount();
}
function refreshCount() {
  $('#poseCount').textContent = edits.size ? `${edits.size} joint${edits.size > 1 ? 's' : ''} changed` : 'no changes';
}

// while dragging: the offset that makes the bone match the proxy, given what the motion set
function fromProxy() {
  if (!selected) return;
  const base = under.get(selected)?.base || selected.quaternion;
  selected.parent.getWorldQuaternion(_q).invert().multiply(proxy.quaternion);   // wanted local rotation
  edits.set(selected.name, base.clone().invert().multiply(_q));
  refreshCount();
}

/** A new character: same bone names, so the edits carry over. */
export function onModel(c) {
  under.clear();
  cur = c;
  select(null);
  rebuildDots();
}

function setShowing(on) {
  showing = on;
  store.set('poseShow', on);
  $('#poseEdit').checked = on;
  if (!on) select(null);
  rebuildDots();
  dots.visible = on;
}

// --- saved poses ---------------------------------------------------------------------------------

function saved() { return store.get('savedPoses', {}); }
function renderSaved() {
  const box = $('#poseSaved');
  box.innerHTML = '';
  const all = saved();
  const names = Object.keys(all).sort((a, b) => a.localeCompare(b));
  if (!names.length) { box.innerHTML = '<div class="hint">Nothing saved yet.</div>'; return; }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = '<span class="grow val"></span><button class="b">Load</button><button class="mini" title="Delete">✕</button>';
    row.querySelector('.val').textContent = name;
    const [load, del] = row.querySelectorAll('button');
    load.onclick = () => {
      remember();
      restore(new Map(Object.entries(all[name]).map(([k, v]) => [k, new THREE.Quaternion().fromArray(v)])));
      toast(`Loaded pose "${name}"`);
    };
    del.onclick = () => { const s = saved(); delete s[name]; store.set('savedPoses', s); renderSaved(); };
    box.appendChild(row);
  }
}

export function initPose(c) {
  ctx = c;
  ctx.scene.add(dots);
  proxy = new THREE.Object3D();
  ctx.scene.add(proxy);
  tc = new TransformControls(ctx.camera, ctx.canvas);
  tc.setMode('rotate');
  tc.setSpace('local');
  tc.setSize(0.6);
  tc.addEventListener('dragging-changed', e => {
    ctx.controls.enabled = !e.value;
    if (e.value) remember();
  });
  tc.addEventListener('objectChange', fromProxy);
  endDragOnRelease(tc);
  ctx.scene.add(tc);

  // click a dot to pick its joint; this runs before the props' own click handling, which skips
  // a click taken here. only marked, never stopped: the orbit and both gizmos need the pointerup
  // to end their own drag, or the camera keeps turning with the mouse
  let down = null;
  ctx.canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; }, true);
  ctx.canvas.addEventListener('pointerup', e => {
    if (!showing || !down || e.button !== 0 || tc.dragging) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (moved > 4) return;
    const r = ctx.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = 14;
    for (const d of dots.children) {
      _v.copy(d.position).project(ctx.camera);
      if (_v.z > 1) continue;
      const dd = Math.hypot((_v.x + 1) / 2 * r.width - x, (1 - _v.y) / 2 * r.height - y);
      if (dd < bestD) { bestD = dd; best = d.userData.bone; }
    }
    if (best) {
      e.preventDefault();
      select(best);
    } else if (selected && tc.axis === null) select(null);
  }, true);

  document.addEventListener('keydown', e => {
    if (typing()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && showing && undoStack.length) {
      e.preventDefault();
      restore(undoStack.pop());
    } else if (e.key === 'Escape' && selected) select(null);
  });

  $('#poseEdit').onchange = () => setShowing($('#poseEdit').checked);
  $('#poseFingers').onchange = () => { fingers = $('#poseFingers').checked; store.set('poseFingers', fingers); if (selected && FINGERS.includes(selected.name) && !fingers) select(null); rebuildDots(); };
  $('#poseResetJoint').onclick = () => { if (!selected) return; remember(); edits.delete(selected.name); refreshCount(); };
  $('#poseResetAll').onclick = () => { if (!edits.size) return; remember(); edits.clear(); refreshCount(); };
  $('#poseSaveBtn').onclick = () => {
    const name = $('#poseName').value.trim();
    if (!name) return toast('Give the pose a name first', true);
    if (!edits.size) return toast('No joints changed yet', true);
    const s = saved();
    s[name] = Object.fromEntries([...edits].map(([k, q]) => [k, q.toArray()]));
    store.set('savedPoses', s);
    $('#poseName').value = '';
    renderSaved();
    toast(`Saved pose "${name}"`);
  };
  $('#poseName').onkeydown = e => { if (e.key === 'Enter') $('#poseSaveBtn').click(); };

  fingers = store.get('poseFingers', false);
  $('#poseFingers').checked = fingers;
  select(null);
  refreshCount();
  renderSaved();
  setShowing(store.get('poseShow', false));
}

export const poseDebug = { edits, get selected() { return selected; }, select: name => select(cur?.root.getObjectByName(name) || null), setShowing };
