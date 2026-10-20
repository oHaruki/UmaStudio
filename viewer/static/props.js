import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { kindOf, makeMaterial, makeOutline } from '/static/look.js';
import { $, $$, post, getJson, toast, store, radio, typing, busy, showTab, endDragOnRelease } from '/static/ui.js';
import { pickImage, pictureName, onPictureDropped } from '/static/images.js';

// props: the game's hand props, or one of your pictures as a card or a box, held by the Uma.
// a picture can also replace a game prop's texture.
//
// props live outside the character's node tree (their bones would clash with hers by name)
// and follow an anchor every frame: a hand's attach bone (where the game puts props), the
// point between both hands, the head, the chest, or the floor.

const BONES = { right: 'Hand_Attach_R', left: 'Hand_Attach_L', head: 'Head', chest: 'Chest' };
const KIND_LABEL = { game: 'Prop', card: 'Picture card', box: 'Picture box' };

let ctx = null;              // from the viewer: scene, camera, renderer, controls, canvas, current(), libraryClip()
const group = new THREE.Group();
const list = [];
let selected = null;
let tc = null;
let uid = 0;
let outlinesOn = true;
let restored = false;
const restInv = new Map();   // bone name -> inverse of its world rotation at rest
const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _b = new THREE.Box3();
const UP = new THREE.Vector3(0, 1, 0);

// --- anchors ---------------------------------------------------------------------------

function bone(cur, name) {
  cur.propBones ??= new Map();
  if (!cur.propBones.has(name)) cur.propBones.set(name, cur.root.getObjectByName(name) || null);
  return cur.propBones.get(name);
}

/** Game props in a hand sit exactly on the attach bone, as in the game. Everything else
 *  uses a frame that is upright when the Uma is at rest and turns as the bone turns, so
 *  "up" and "forward" mean what they look like. */
const usesBoneFrame = p => p.kind === 'game' && (p.anchor === 'right' || p.anchor === 'left');

function placeAnchor(p, cur) {
  const a = p.anchorObj;
  a.scale.set(1, 1, 1);
  if (!cur || p.anchor === 'floor') { a.position.set(0, 0, 0); a.quaternion.identity(); return; }
  if (p.anchor === 'both') {
    const l = bone(cur, BONES.left), r = bone(cur, BONES.right);
    if (!l || !r) return;
    l.getWorldPosition(_v);
    r.getWorldPosition(_v2);
    a.position.addVectors(_v, _v2).multiplyScalar(0.5);
    // kept level, facing the way her hands do (X from her right hand to her left), so a carried
    // box doesn't wobble with every step
    _x.subVectors(_v, _v2).setY(0);
    if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
    _x.normalize();
    _y.copy(UP);
    _z.crossVectors(_x, _y);
    a.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    return;
  }
  const name = BONES[p.anchor], b = bone(cur, name);
  if (!b) { a.position.set(0, 0, 0); a.quaternion.identity(); return; }
  b.matrixWorld.decompose(a.position, a.quaternion, _s);
  if (!usesBoneFrame(p) && restInv.has(name)) a.quaternion.multiply(restInv.get(name));
}

/** Every frame, after motion, face and physics. */
export function updateProps() {
  if (!list.length) return;
  const cur = ctx.current();
  cur?.root.updateMatrixWorld(true);
  for (const p of list) placeAnchor(p, cur);
}

/** A new character (or outfit) is loaded, still at rest. */
export function onModel(cur) {
  restInv.clear();
  cur.root.updateMatrixWorld(true);
  for (const name of Object.values(BONES)) {
    const b = bone(cur, name);
    if (b) restInv.set(name, b.getWorldQuaternion(new THREE.Quaternion()).invert());
  }
  if (!restored) {
    restored = true;
    restore();
  } else applyGrips();
}

// --- grips ----------------------------------------------------------------------------
//
// many props have a hand motion of their own (fingers and attach point only). it plays on top
// of the pose with a far larger weight, so it wins on those bones and nowhere else.

let gripSeq = 0;
export async function applyGrips() {
  const cur = ctx.current();
  if (!cur) return;
  const my = ++gripSeq;
  const want = [];
  for (const p of list) {
    if (p.kind !== 'game' || !p.grip || !p.visible) continue;
    const path = p.anchor === 'right' ? p.info.grip : p.anchor === 'left' ? p.info.gripLeft : null;
    if (path && !want.includes(path)) want.push(path);
  }
  let clips = [];
  try { clips = await Promise.all(want.map(w => ctx.libraryClip(w))); } catch (e) { toast(e.message, true); }
  if (my !== gripSeq || cur !== ctx.current()) return;
  for (const a of cur.grips || []) {
    a.stop();
    for (const t of a.getClip().tracks) {
      const o = cur.root.getObjectByName(t.name.split('.')[0]), r = o && cur.rest.get(o);
      if (r) { o.position.copy(r[0]); o.quaternion.copy(r[1]); o.scale.copy(r[2]); }
    }
  }
  cur.grips = clips.map(c => {
    const a = cur.mixer.clipAction(c);
    a.reset();
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.setEffectiveWeight(1000);
    a.play();
    return a;
  });
  cur.mixer.update(0);
}

// --- pictures -------------------------------------------------------------------------------

const pics = new Map();
function picture(url) {
  if (!pics.has(url)) {
    const p = new THREE.TextureLoader().loadAsync(url).then(t => {
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = false;     // UVs here run top-down, as in the converted models
      t.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      return t;
    });
    p.catch(() => pics.delete(url));
    pics.set(url, p);
  }
  return pics.get(url);
}

/** Quarter turns clockwise. */
function turnUv(u, v, t) {
  for (let i = 0; i < t; i++) [u, v] = [v, 1 - u];
  return [u, v];
}

/** UVs that put the whole picture, upright, on every side: each triangle is projected
 *  along the axis it faces, over the model's bounding box. */
function boxProject(src, turn) {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const pos = g.attributes.position;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const size = new THREE.Vector3().subVectors(max, min);
  const norm = (v, i) => size.getComponent(i) > 1e-6 ? (v - min.getComponent(i)) / size.getComponent(i) : 0.5;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(e.subVectors(c, a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    [a, b, c].forEach((p, k) => {
      const px = norm(p.x, 0), py = norm(p.y, 1), pz = norm(p.z, 2);
      let u, v;
      if (az >= ax && az >= ay) { u = n.z > 0 ? px : 1 - px; v = 1 - py; }
      else if (ax >= ay) { u = n.x > 0 ? 1 - pz : pz; v = 1 - py; }
      else { u = px; v = n.y > 0 ? pz : 1 - pz; }
      [u, v] = turnUv(u, v, turn);
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    });
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function cardGeometry(h, aspect, turn) {
  const g = new THREE.PlaneGeometry(h * (turn % 2 ? 1 / aspect : aspect), h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = turnUv(uv.getX(i), 1 - uv.getY(i), turn);
    uv.setXY(i, u, v);
  }
  return g;
}

// --- loading game props ---------------------------------------------------------------

async function loadGame(name, quiet) {
  const info = await post('/api/prop/load', { name }, quiet ? null : 'Loading prop…');
  if (!info.meshes) return { info, meshes: [] };
  const gltf = await loader.loadAsync(info.base + 'model.gltf');
  const texCache = new Map();
  const getTex = idx => {
    if (!texCache.has(idx)) {
      texCache.set(idx, gltf.parser.getDependency('texture', idx).then(t => {
        t.colorSpace = THREE.NoColorSpace;
        t.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
        t.needsUpdate = true;
        return t;
      }));
    }
    return texCache.get(idx);
  };
  const meshes = [];
  gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  const orig = new Map();
  for (const m of meshes) {
    const ud = m.material.userData || {};
    const tex = {};
    for (const [slot, idx] of Object.entries(ud.textures || {})) tex[slot] = await getTex(idx);
    m.material.dispose();
    m.material = makeMaterial(kindOf(ud), ud, tex);
    m.frustumCulled = false;
    orig.set(m, { geometry: m.geometry, material: m.material, ud, tex });
  }
  return { info, root: gltf.scene, meshes, orig };
}

/** The prop's bounding box in its own space, as loaded. */
function bounds(g) {
  g.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of g.meshes) {
    if (m.isSkinnedMesh) { m.skeleton.update(); m.computeBoundingBox(); _b.copy(m.boundingBox); }
    else { m.geometry.computeBoundingBox(); _b.copy(m.geometry.boundingBox); }
    box.union(_b.applyMatrix4(m.matrixWorld));
  }
  return { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
}

function disposeGame(g) {
  for (const [, o] of g.orig || []) {
    o.geometry.dispose();
    o.material.dispose();
    Object.values(o.tex).forEach(t => t.dispose());
  }
}

// --- thumbnails ---------------------------------------------------------------------------
//
// drawn here the first time a prop shows up in the picker, then kept by the server

const thumbCam = new THREE.PerspectiveCamera(25, 1, 0.001, 50);
const thumbsDone = new Set();
let thumbChain = Promise.resolve();

/** One at a time: the picker and the idle-time pass share the renderer. */
function renderThumb(name) {
  const run = thumbChain.then(() => drawThumb(name));
  thumbChain = run.catch(() => {});
  return run;
}

async function drawThumb(name) {
  const g = await loadGame(name, true);
  if (!g.meshes.length) return null;
  const sc = new THREE.Scene();
  sc.add(g.root);
  const { center, size } = bounds(g), radius = Math.max(size.length() / 2, 0.01);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(thumbCam.fov / 2)) * 1.05;
  thumbCam.position.copy(center).addScaledVector(_v.set(0.55, 0.45, 1).normalize(), dist);
  thumbCam.near = dist / 50; thumbCam.far = dist * 4;
  thumbCam.lookAt(center);
  thumbCam.updateProjectionMatrix();

  const S = 192, r = ctx.renderer;
  const rt = new THREE.WebGLRenderTarget(S, S, { samples: 4 });
  const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
  r.setRenderTarget(rt);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.render(sc, thumbCam);
  const px = new Uint8Array(S * S * 4);
  r.readRenderTargetPixels(rt, 0, 0, S, S, px);
  r.setRenderTarget(null);
  r.setClearColor(clear, alpha);
  rt.dispose();
  disposeGame(g);

  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const img = new ImageData(S, S);
  for (let y = 0; y < S; y++) {
    const src = (S - 1 - y) * S * 4, dst = y * S * 4;
    for (let x = 0; x < S * 4; x += 4) {
      const a = px[src + x + 3], k = a > 0 && a < 255 ? 255 / a : 1;
      img.data[dst + x] = px[src + x] * k;
      img.data[dst + x + 1] = px[src + x + 1] * k;
      img.data[dst + x + 2] = px[src + x + 2] * k;
      img.data[dst + x + 3] = a;
    }
  }
  cv.getContext('2d').putImageData(img, 0, 0);
  const png = cv.toDataURL('image/png');
  thumbsDone.add(name);
  post('/api/prop/thumb', { name, png }, null).catch(() => {});
  return png;
}

const thumbQ = [];
let thumbBusy = false;
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQ.length && $('#propPicker').style.display === 'block') {
      // whatever is on screen now goes first
      const view = $('#propGrid').getBoundingClientRect();
      let i = thumbQ.findIndex(j => { const r = j.img.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom; });
      const job = thumbQ.splice(Math.max(i, 0), 1)[0];
      if (!job.img.isConnected) continue;
      const item = propItems.find(it => it.name === job.name);
      try {
        const png = await renderThumb(job.name);
        if (png) {
          job.img.src = png;
          item.thumb = true;
        } else {
          job.tile.remove();
          propItems.splice(propItems.indexOf(item), 1);
        }
      } catch (e) { console.warn(job.name, e); job.tile.classList.add('broken'); }
    }
  } finally {
    thumbBusy = false;
    if ($('#propPicker').style.display !== 'block') thumbQ.length = 0;
  }
}

// --- the picker -------------------------------------------------------------------------------

let propItems = null;
// tiles without a preview yet ask for one once they scroll into view
const thumbWatch = new IntersectionObserver(es => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    thumbWatch.unobserve(e.target);
    thumbQ.push({ name: e.target.dataset.prop, img: e.target, tile: e.target.parentElement });
  }
  pumpThumbs();
}, { rootMargin: '200px' });

async function openPicker() {
  $('#propPicker').style.display = 'block';
  $('#propFilter').value = '';
  setTimeout(() => $('#propFilter').focus(), 30);
  try {
    propItems ??= (await getJson('/api/props')).items;
    fillPicker();
  } catch (e) { toast(e.message, true); }
}
const closePicker = () => { $('#propPicker').style.display = 'none'; };

function fillPicker() {
  const grid = $('#propGrid');
  grid.innerHTML = '';
  thumbWatch.disconnect();
  thumbQ.length = 0;
  const f = $('#propFilter').value.trim().toLowerCase();
  const recent = store.get('recentProps', []);
  const rank = it => { const i = recent.indexOf(it.name); return i < 0 ? 1e9 : i; };
  const items = propItems.filter(it => !f || it.id.includes(f)).sort((a, b) => rank(a) - rank(b));
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.innerHTML = `<img loading="lazy" alt=""><span>${it.id}${recent.includes(it.name) ? ' · recent' : ''}</span>`;
    const img = b.querySelector('img');
    if (it.thumb || thumbsDone.has(it.name)) img.src = `/api/prop/thumb/${it.name}`;
    else {
      img.dataset.prop = it.name;
      thumbWatch.observe(img);
    }
    b.onclick = () => {
      closePicker();
      store.set('recentProps', [it.name, ...recent.filter(n => n !== it.name)].slice(0, 24));
      add('game', { name: it.name }).catch(e => toast(e.message, true));
    };
    grid.appendChild(b);
  }
  if (!items.length) grid.innerHTML = '<div class="empty">No props match.</div>';
}

// --- adding and changing props --------------------------------------------------------------

function defaultPlacement(p) {
  const h = p.holder;
  h.position.set(0, 0, 0);
  h.quaternion.identity();
  h.scale.set(1, 1, 1);
  if (p.kind === 'game') {
    if (usesBoneFrame(p)) return;   // in a hand: exactly where the game puts it
    // elsewhere by its bounding box: hands a little below its middle, on top of the head, in
    // front of the chest, standing on the floor.
    const c = p.box.center, sz = p.box.size;
    const at = { both: [0, sz.y * 0.1, 0.02], head: [0, 0.24 + sz.y / 2, 0], chest: [0, 0, 0.13 + sz.z / 2],
                 floor: [0.45, sz.y / 2, 0.1] }[p.anchor];
    h.position.set(at[0] - c.x, at[1] - c.y, at[2] - c.z);
    return;
  }
  const H = p.dims.h, D = p.kind === 'box' ? p.dims.d : 0;
  const at = {
    right: [0, H * 0.35, 0.02], left: [0, H * 0.35, 0.02],
    both: p.kind === 'box' ? [0, H * 0.1, 0.02] : [0, H / 2 - 0.03, 0.03],
    head: [0, 0.24 + H / 2, 0], chest: [0, 0, 0.13 + D / 2], floor: [0.45, H / 2, 0.1],
  }[p.anchor];
  h.position.set(...at);
}

/** kind: 'game' (opts.name), 'card' or 'box' (opts.image). Saved props pass their state. */
export function add(kind, opts = {}, quiet = false) {
  return busy(quiet ? 'Restoring props…' : kind === 'game' ? 'Loading prop…' : 'Loading picture…', addNow(kind, opts, quiet));
}

async function addNow(kind, opts, quiet) {
  const p = {
    uid: ++uid, kind, name: opts.name || null, anchor: opts.anchor || (kind === 'game' ? 'right' : 'both'),
    image: opts.image || null, fit: opts.fit || 'sides', turn: opts.turn || 0, toon: opts.toon ?? true,
    grip: opts.grip ?? true, visible: opts.visible ?? true, dims: opts.dims || null, info: null,
    anchorObj: new THREE.Object3D(), holder: new THREE.Object3D(), meshes: [], outlines: [], orig: new Map(), made: [],
  };
  p.anchorObj.add(p.holder);
  if (kind === 'game') {
    const g = await loadGame(p.name);
    if (!g.meshes.length) throw new Error('That prop has nothing to show');
    Object.assign(p, { info: g.info, meshes: g.meshes, orig: g.orig, box: bounds(g) });
    p.holder.add(g.root);
    for (const m of g.meshes) {
      if (!m.isSkinnedMesh) continue;
      const o = p.orig.get(m);
      const ol = new THREE.SkinnedMesh(m.geometry, makeOutline(o.ud, o.tex));
      ol.bind(m.skeleton, m.bindMatrix);
      ol.frustumCulled = false;
      ol.visible = outlinesOn;
      m.parent.add(ol);
      p.outlines.push(ol);
    }
  } else {
    if (!p.dims) {
      p.dims = kind === 'card' ? { h: 0.3 } : { w: 0.3, h: 0.22, d: 0.22 };
      const cur = ctx.current(), l = cur && bone(cur, BONES.left), r = cur && bone(cur, BONES.right);
      if (kind === 'box' && l && r && p.anchor === 'both') {
        // as wide as her hands are apart right now
        cur.root.updateMatrixWorld(true);
        p.dims.w = THREE.MathUtils.clamp(l.getWorldPosition(_v).distanceTo(r.getWorldPosition(_v2)) * 0.9, 0.12, 0.7);
      }
    }
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.frustumCulled = false;
    p.holder.add(mesh);
    p.meshes = [mesh];
  }
  p.anchorObj.visible = p.visible;
  if (opts.pos) {
    p.holder.position.fromArray(opts.pos);
    p.holder.quaternion.fromArray(opts.quat);
    p.holder.scale.fromArray(opts.scale);
  } else defaultPlacement(p);
  group.add(p.anchorObj);
  list.push(p);
  await refreshLook(p);
  placeAnchor(p, ctx.current());
  if (!quiet) {
    select(p);
    save();
  } else renderList();
  if (kind === 'game') applyGrips();
  return p;
}

function made(p, x) { p.made.push(x); return x; }

/** Geometry and material from the prop's current settings. */
async function refreshLook(p) {
  const my = p.lookSeq = (p.lookSeq || 0) + 1;
  let tex = null;
  if (p.image) {
    try { tex = await picture(p.image); } catch { toast('Could not load that picture', true); }
  }
  if (my !== p.lookSeq) return;
  const old = p.made;
  p.made = [];
  const opts = { cutout: tex ? 0.5 : 0 };
  if (p.kind === 'game') {
    for (const m of p.meshes) {
      const o = p.orig.get(m);
      if (!tex) { m.geometry = o.geometry; m.material = o.material; continue; }
      m.geometry = p.fit === 'sides' ? made(p, boxProject(o.geometry, p.turn)) : o.geometry;
      m.material = made(p, makeMaterial(p.toon ? 'body' : 'flat', o.ud, { _MainTex: tex }, opts));
    }
  } else {
    const m = p.meshes[0];
    const aspect = tex ? tex.image.width / tex.image.height : 1;
    m.geometry = made(p, p.kind === 'card' ? cardGeometry(p.dims.h, aspect, p.turn)
                                         : boxProject(new THREE.BoxGeometry(p.dims.w, p.dims.h, p.dims.d), p.turn));
    m.material = made(p, makeMaterial(p.toon ? 'body' : 'flat', {}, tex ? { _MainTex: tex } : {},
                                      { ...opts, side: p.kind === 'card' ? THREE.DoubleSide : THREE.FrontSide }));
  }
  old.forEach(x => x.dispose());
}

export function remove(p) {
  if (selected === p) select(null);
  list.splice(list.indexOf(p), 1);
  group.remove(p.anchorObj);
  p.made.forEach(x => x.dispose());
  if (p.kind === 'game') disposeGame(p);
  else p.meshes.forEach(m => m.geometry.dispose());
  if (p.kind === 'game') applyGrips();
  renderList();
  save();
}

function select(p) {
  selected = p;
  if (p) showTab('props');
  if (p && p.visible) tc.attach(p.holder);
  else tc.detach();
  renderList();
  syncEditor();
}

export function setOutlines(on) {
  outlinesOn = on;
  list.forEach(p => p.outlines.forEach(o => { o.visible = on; }));
}

/** Hides the move/rotate handles while a picture or video frame is drawn. */
export function gizmo(visible) { tc.visible = visible && !!tc.object; }

function setPicture(p, url) {
  p.image = url;
  busy('Loading picture…', refreshLook(p)).then(() => { renderList(); syncEditor(); });
  save();
}

// --- saving ------------------------------------------------------------------------------------

function save() {
  store.set('props', list.map(p => ({
    kind: p.kind, name: p.name, anchor: p.anchor, image: p.image, fit: p.fit, turn: p.turn, toon: p.toon, grip: p.grip,
    visible: p.visible, dims: p.dims, pos: p.holder.position.toArray(), quat: p.holder.quaternion.toArray(),
    scale: p.holder.scale.toArray(),
  })));
}

async function restore() {
  for (const s of store.get('props', [])) {
    try { await add(s.kind, s, true); } catch (e) { console.warn('could not restore a prop', e); }
  }
  save();
}

// --- panel ------------------------------------------------------------------------------------

function propLabel(p) {
  const base = p.kind === 'game' ? `${KIND_LABEL.game} ${p.info?.id || ''}` : KIND_LABEL[p.kind];
  return p.image ? `${base} · ${pictureName(p.image)}` : base;
}

function renderList() {
  const box = $('#propList');
  box.innerHTML = '';
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'propItem' + (p === selected ? ' on' : '') + (p.visible ? '' : ' off');
    row.innerHTML = `<span class="name"></span><button class="mini" title="Show or hide">${p.visible ? 'Hide' : 'Show'}</button><button class="mini" title="Remove (Delete)">✕</button>`;
    row.querySelector('.name').textContent = propLabel(p);
    row.onclick = () => select(p === selected ? null : p);
    const [vis, del] = row.querySelectorAll('button');
    vis.onclick = e => {
      e.stopPropagation();
      p.visible = !p.visible;
      p.anchorObj.visible = p.visible;
      if (selected === p) select(p);
      else renderList();
      if (p.kind === 'game') applyGrips();
      save();
    };
    del.onclick = e => { e.stopPropagation(); remove(p); };
    box.appendChild(row);
  }
  $('#propHint').style.display = list.length ? 'none' : '';
}

const show = (sel, on) => { $(sel).style.display = on ? '' : 'none'; };

function syncEditor() {
  const p = selected;
  show('#propEdit', !!p);
  if (!p) return;
  $('#propAnchor').value = p.anchor;
  $('#propPicName').textContent = p.image ? pictureName(p.image) : 'none';
  show('#propPicClear', !!p.image);
  show('#propTurn', !!p.image);
  show('#propFitRow', p.kind === 'game' && !!p.image);
  radio('#propFit .chip', $(`#propFit .chip[data-fit="${p.fit}"]`));
  show('#propToonRow', p.kind !== 'game' || !!p.image);
  $('#propToon').checked = p.toon;
  const gripPath = p.kind === 'game' && (p.anchor === 'right' ? p.info?.grip : p.anchor === 'left' ? p.info?.gripLeft : null);
  show('#propGripRow', !!gripPath);
  $('#propGrip').checked = p.grip;
  show('#propScaleRow', p.kind === 'game');
  $('#propScale').value = (p.holder.scale.x + p.holder.scale.y + p.holder.scale.z) / 3;
  show('#propCardRow', p.kind === 'card');
  show('#propBoxRows', p.kind === 'box');
  if (p.dims) {
    $('#propH').value = p.dims.h;
    if (p.kind === 'box') { $('#propBW').value = p.dims.w; $('#propBH').value = p.dims.h; $('#propBD').value = p.dims.d; }
  }
}

function setMode(mode) {
  tc.setMode(mode);
  radio('#gizmoModes .chip', $(`#gizmoModes .chip[data-mode="${mode}"]`));
}

let dimTimer;
function setDims(change) {
  const p = selected;
  if (!p || !p.dims) return;
  Object.assign(p.dims, change);
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => { refreshLook(p); save(); }, 40);
}

export function initProps(c) {
  ctx = c;
  ctx.scene.add(group);
  tc = new TransformControls(ctx.camera, ctx.canvas);
  tc.setSize(0.75);
  tc.setSpace('local');
  tc.addEventListener('dragging-changed', e => {
    ctx.controls.enabled = !e.value;
    if (!e.value) { save(); syncEditor(); }
  });
  endDragOnRelease(tc);
  ctx.scene.add(tc);

  $('#addProp').onclick = openPicker;
  $('#addCard').onclick = async () => {
    const url = await pickImage({ title: 'Picture for the card' });
    if (url) add('card', { image: url }).catch(e => toast(e.message, true));
  };
  $('#addBox').onclick = async () => {
    const url = await pickImage({ title: 'Picture for the box' });
    if (url) add('box', { image: url }).catch(e => toast(e.message, true));
  };
  $('#propPickerClose').onclick = closePicker;
  $('#propPicker').addEventListener('mousedown', e => { if (e.target.id === 'propPicker') closePicker(); });
  let filterTimer;
  $('#propFilter').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(fillPicker, 150); };

  $('#propAnchor').onchange = () => {
    const p = selected;
    p.anchor = $('#propAnchor').value;
    defaultPlacement(p);
    placeAnchor(p, ctx.current());
    if (p.kind === 'game') applyGrips();
    syncEditor();
    save();
  };
  $('#propPic').onclick = async () => {
    const p = selected;
    const url = await pickImage({ title: 'Picture for the ' + (p.kind === 'game' ? 'prop' : KIND_LABEL[p.kind].toLowerCase()) });
    if (url && list.includes(p)) setPicture(p, url);
  };
  $('#propPicClear').onclick = () => setPicture(selected, null);
  $('#propTurn').onclick = () => { selected.turn = (selected.turn + 1) % 4; refreshLook(selected); save(); };
  $$('#propFit .chip').forEach(b => {
    b.onclick = () => { selected.fit = b.dataset.fit; refreshLook(selected); syncEditor(); save(); };
  });
  $('#propToon').onchange = () => { selected.toon = $('#propToon').checked; refreshLook(selected); save(); };
  $('#propGrip').onchange = () => { selected.grip = $('#propGrip').checked; applyGrips(); save(); };
  $('#propScale').oninput = () => { selected.holder.scale.setScalar(parseFloat($('#propScale').value)); save(); };
  $('#propH').oninput = () => setDims({ h: parseFloat($('#propH').value) });
  $('#propBW').oninput = () => setDims({ w: parseFloat($('#propBW').value) });
  $('#propBH').oninput = () => setDims({ h: parseFloat($('#propBH').value) });
  $('#propBD').oninput = () => setDims({ d: parseFloat($('#propBD').value) });
  $$('#gizmoModes .chip[data-mode]').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
  $('#propReset').onclick = () => { defaultPlacement(selected); syncEditor(); save(); };

  // click a prop in the view to select it, click empty space to let go
  let down = null;
  ctx.canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  ctx.canvas.addEventListener('pointerup', e => {
    if (!down || e.button !== 0 || tc.dragging) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (moved > 4 || !list.length || e.defaultPrevented) return;   // defaultPrevented: pose mode picked a joint
    const r = ctx.canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), ctx.camera);
    const hit = raycaster.intersectObjects(list.filter(p => p.visible).map(p => p.holder), true)[0];
    if (hit) {
      let o = hit.object;
      while (o && !list.some(p => p.holder === o)) o = o.parent;
      const p = list.find(q => q.holder === o);
      if (p && p !== selected) select(p);
      e.preventDefault();   // taken: stage editing leaves it alone
    } else if (selected && tc.axis === null) select(null);
  });

  document.addEventListener('keydown', e => {
    if (typing() || !selected || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') setMode('translate');
    else if (k === 'e') setMode('rotate');
    else if (k === 'r') setMode('scale');
    else if (k === 'delete') remove(selected);
    else if (k === 'escape') select(null);
    else return;
    e.preventDefault();
  });

  // a dropped or pasted picture goes on the selected prop, or becomes a card she holds
  onPictureDropped(url => {
    if (selected) { setPicture(selected, url); toast('Picture put on the selected prop'); }
    else add('card', { image: url }).then(() => toast('Added as a picture card')).catch(e => toast(e.message, true));
  });
  renderList();
  syncEditor();
}

/** Draws the previews the prop picker would otherwise draw while you wait, a few at a
 *  time whenever the app is idle. report(done, total) shows progress. */
export async function warmThumbs(report) {
  let items;
  try { items = (await getJson('/api/props', null)).items.filter(it => !it.thumb); } catch { return; }
  for (let i = 0; i < items.length; i++) {
    while (!ctx.idle()) await new Promise(r => setTimeout(r, 400));
    if (!thumbsDone.has(items[i].name)) {
      try { await renderThumb(items[i].name); } catch { /* broken prop: the picker marks it */ }
    }
    report(i + 1, items.length);
    await new Promise(r => setTimeout(r, 60));
  }
}

/** For the model export: the group every prop hangs from, and each prop's outline meshes. */
export function exportInfo() { return { group, props: list.map(p => ({ uid: p.uid, anchor: p.anchorObj, outlines: p.outlines })) }; }

export const propsDebug = { list, get selected() { return selected; }, add, remove, select };
