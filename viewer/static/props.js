import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { U, kindOf, makeMaterial, makeOutline } from '/static/look.js';
import { $, $$, call, post, getJson, toast, store, radio, typing, busy, showTab, endDragOnRelease } from '/static/ui.js';
import { pickImage, pictureName, onPictureDropped, onModelDropped } from '/static/images.js';

// props: the game's hand props, one of your pictures as a card or a box, or a .glb model from
// anywhere, held by the Uma or standing around. a picture can also replace a prop's texture.
//
// props live outside the character's node tree (their bones would clash with hers by name)
// and follow an anchor every frame: a hand's attach bone (where the game puts props), the
// point between both hands, the head, the chest, or the floor. with several umas in the scene
// each prop belongs to one of them (p.owner, her key).

const BONES = { right: 'Hand_Attach_R', left: 'Hand_Attach_L', head: 'Head', chest: 'Chest' };
const KIND_LABEL = { game: 'Prop', card: 'Picture card', box: 'Picture box', model: 'Model' };
// game props and models come as loaded meshes with their own materials, cards and boxes are made here
const isMeshy = p => p.kind === 'game' || p.kind === 'model';

let ctx = null;              // from the viewer: scene, camera, renderer, controls, canvas, current(), libraryClip()
const group = new THREE.Group();
const list = [];
let selected = null;
let tc = null;
let uid = 0;
let outlinesOn = true;
let restored = false;
const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _b = new THREE.Box3();
const UP = new THREE.Vector3(0, 1, 0);

// models keeping their own materials need light, nothing else here uses three's lights
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
const sky = new THREE.HemisphereLight(0xffffff, 0x8a8078, 1.4);

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
  if (!usesBoneFrame(p) && cur.restInv?.has(name)) a.quaternion.multiply(cur.restInv.get(name));
}

/** Every frame, after motion, face and physics. */
/** The uma a prop belongs to (the active one if hers isn't loaded). */
const ownerOf = p => ctx.member(p.owner) || ctx.current();

export function updateProps() {
  if (!list.length) return;
  for (const m of ctx.members()) m.root.updateMatrixWorld(true);
  for (const p of list) placeAnchor(p, ownerOf(p));
  sun.position.copy(U.lightDir.value).multiplyScalar(10);
}

/** The models' own animations (wings flapping...) at time t in seconds, looping. */
export function animateModels(t) {
  for (const p of list) {
    if (!p.mixer || !p.action) continue;
    const d = p.action.getClip().duration || 1;
    p.action.time = ((t % d) + d) % d;
    p.mixer.update(0);
  }
}

/** A new character (or outfit) is loaded, still at rest. */
export function onModel(cur) {
  // bone name -> inverse of its world rotation at rest (with her spot taken out)
  cur.restInv = new Map();
  cur.root.updateMatrixWorld(true);
  const spot = cur.root.parent ? cur.root.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  for (const name of Object.values(BONES)) {
    const b = bone(cur, name);
    if (b) cur.restInv.set(name, spot.clone().invert().multiply(b.getWorldQuaternion(new THREE.Quaternion())).invert());
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

export async function applyGrips() {
  await Promise.all(ctx.members().map(gripsFor));
}

async function gripsFor(cur) {
  const my = cur.gripSeq = (cur.gripSeq || 0) + 1;
  const want = [];
  for (const p of list) {
    if (p.kind !== 'game' || !p.grip || !p.visible || ownerOf(p) !== cur) continue;
    const path = p.anchor === 'right' ? p.info.grip : p.anchor === 'left' ? p.info.gripLeft : null;
    if (path && !want.includes(path)) want.push(path);
  }
  let clips = [];
  try { clips = await Promise.all(want.map(w => ctx.libraryClip(w, cur))); } catch (e) { toast(e.message, true); }
  if (my !== cur.gripSeq || !ctx.members().includes(cur)) return;
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

// --- loading your models -------------------------------------------------------------------------

/** A 1x1 texture of a colour, for untextured parts going through the toon shader. */
const swatches = new Map();
function swatch(color) {
  const k = color.getHexString();
  if (!swatches.has(k)) {
    const t = new THREE.DataTexture(new Uint8Array([color.r * 255, color.g * 255, color.b * 255, 255]), 1, 1);
    t.needsUpdate = true;
    swatches.set(k, t);
  }
  return swatches.get(k);
}

async function loadModel(file) {
  const gltf = await loader.loadAsync('/models/' + encodeURIComponent(file));
  const meshes = [];
  gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  const orig = new Map();
  for (const m of meshes) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    m.material = mat;
    // no environment to reflect here: fully metal parts would come out black
    if ('metalness' in mat) mat.metalness = Math.min(mat.metalness, 0.4);
    const cut = mat.alphaTest > 0 || mat.transparent;
    const map = mat.map || null;
    if (map) map.colorSpace = THREE.NoColorSpace;   // the toon shader writes values as they are
    const main = map || swatch(mat.color ? mat.color.clone().convertLinearToSRGB() : new THREE.Color(1, 1, 1));
    orig.set(m, { geometry: m.geometry, material: mat, own: mat, ud: {}, tex: { _MainTex: main }, cut });
    m.frustumCulled = false;
  }
  let mixer = null;
  if (gltf.animations.length) mixer = new THREE.AnimationMixer(gltf.scene);
  // her toon shader has no morph targets or vertex colours: models built on those get three's toon
  // material (it has both) instead
  for (const m of meshes) {
    const o = orig.get(m);
    o.three = !!(m.morphTargetInfluences?.length || (m.geometry.attributes.color && !m.material.map));
    // models without normals are lit flat by their own material; the toon ones need them
    if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
  }
  const own = meshes.some(m => orig.get(m).three);
  return { root: gltf.scene, meshes, orig, mixer, clips: gltf.animations, own };
}

/** A model's box as it shows (morphs and bones posed), in the holder's space. */
function modelBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  return { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
}

/** Sketchfab models come in any size, centimetres or kilometres: sensible ones keep theirs.
 *  Measured on the first frame of its animation, a morphed model's rest shape can be far off. */
function fitModel(p, root) {
  let box = modelBounds(root);
  const big = Math.max(box.size.x, box.size.y, box.size.z);
  if (big > 0 && (big > 4 || big < 0.05)) {
    root.scale.multiplyScalar(1 / big);
    box = modelBounds(root);
  }
  p.box = box;
}

// three bands of light, like her shading
let stepTex = null;
function steps() {
  if (!stepTex) {
    stepTex = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 190, 190, 190, 255, 255, 255, 255, 255]), 3, 1);
    stepTex.minFilter = stepTex.magFilter = THREE.NearestFilter;
    stepTex.needsUpdate = true;
  }
  return stepTex;
}

/** Which of the model's animations plays (-1: none). */
function setClip(p, i) {
  p.clip = i;
  if (!p.mixer) return;
  p.mixer.stopAllAction();
  p.action = null;
  if (i >= 0 && p.clips[i]) {
    p.action = p.mixer.clipAction(p.clips[i]);
    p.action.play();
  }
  p.mixer.update(0);
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
    if (o.own && o.material !== o.own) o.own.dispose();
    Object.values(o.tex).forEach(t => { if (![...swatches.values()].includes(t)) t.dispose(); });
  }
  g.mixer?.stopAllAction();
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
  if (isMeshy(p)) {
    if (usesBoneFrame(p)) return;   // in a hand: exactly where the game puts it
    // elsewhere by its bounding box: one hand round its middle, both hands a little below it, on
    // top of the head, in front of the chest, standing on the floor.
    const c = p.box.center, sz = p.box.size;
    const at = { right: [0, 0, 0], left: [0, 0, 0], both: [0, sz.y * 0.1, 0.02], head: [0, 0.24 + sz.y / 2, 0],
                 chest: [0, 0, 0.13 + sz.z / 2], floor: [0.45, sz.y / 2, 0.1] }[p.anchor] || [0, 0, 0];
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

/** kind: 'game' (opts.name), 'card' or 'box' (opts.image), 'model' (opts.name = your .glb file).
 *  Saved props pass their state. */
export function add(kind, opts = {}, quiet = false) {
  const what = { game: 'Loading prop…', model: 'Loading model…' }[kind] || 'Loading picture…';
  return busy(quiet ? 'Restoring props…' : what, addNow(kind, opts, quiet));
}

async function addNow(kind, opts, quiet) {
  const p = {
    uid: ++uid, key: opts.key || Math.random().toString(36).slice(2, 10), kind, name: opts.name || null,
    anchor: opts.anchor || { game: 'right', model: 'floor' }[kind] || 'both', clip: opts.clip ?? 0,
    owner: opts.owner || ctx.activeKey(),
    image: opts.image || null, fit: opts.fit || (kind === 'model' ? 'uv' : 'sides'), turn: opts.turn || 0, toon: opts.toon ?? true,
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
  } else if (kind === 'model') {
    const g = await loadModel(p.name);
    if (!g.meshes.length) throw new Error('That model has nothing to show');
    Object.assign(p, { meshes: g.meshes, orig: g.orig, mixer: g.mixer, clips: g.clips });
    setClip(p, p.clip);
    fitModel(p, g.root);
    p.holder.add(g.root);
  } else {
    if (!p.dims) {
      p.dims = kind === 'card' ? { h: 0.3 } : { w: 0.3, h: 0.22, d: 0.22 };
      const cur = ownerOf(p), l = cur && bone(cur, BONES.left), r = cur && bone(cur, BONES.right);
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
  placeAnchor(p, ownerOf(p));
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
  if (p.kind === 'model') {
    // toon: through her shader with its own texture (or colour); else its own materials, lit
    for (const m of p.meshes) {
      const o = p.orig.get(m);
      m.geometry = tex && p.fit === 'sides' ? made(p, boxProject(o.geometry, p.turn)) : o.geometry;
      if (!p.toon && !tex) { m.material = o.own; continue; }
      if (o.three && !tex) {
        m.material = made(p, new THREE.MeshToonMaterial({ color: o.own.color, map: o.own.map, vertexColors: o.own.vertexColors,
                                                          gradientMap: steps(), side: o.own.side, flatShading: o.own.flatShading }));
        continue;
      }
      m.material = made(p, makeMaterial(p.toon ? 'body' : 'flat', o.ud, { _MainTex: tex || o.tex._MainTex },
                                        { cutout: tex || o.cut ? 0.5 : 0, side: o.own.side }));
    }
  } else if (p.kind === 'game') {
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
  if (isMeshy(p)) disposeGame(p);
  else p.meshes.forEach(m => m.geometry.dispose());
  if (p.kind === 'game') applyGrips();
  renderList();
  save();
}

function select(p) {
  selected = p;
  ctx.onSelect?.(p);
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
    key: p.key, owner: p.owner, kind: p.kind, name: p.name, anchor: p.anchor, image: p.image, fit: p.fit, turn: p.turn, toon: p.toon, grip: p.grip,
    clip: p.clip,
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

export function propLabel(p) {
  const base = p.kind === 'game' ? `${KIND_LABEL.game} ${p.info?.id || ''}`
    : p.kind === 'model' ? p.name.replace(/\.glb$/i, '') : KIND_LABEL[p.kind];
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
  // who holds it, with more than one uma in the scene
  const ms = ctx.members();
  show('#propOwnerRow', ms.length > 1);
  if (ms.length > 1) {
    const sel = $('#propOwner');
    sel.innerHTML = '';
    for (const m of ms) sel.add(new Option(m.name, m.key));
    sel.value = ownerOf(p)?.key || ms[0].key;
  }
  $('#propPicName').textContent = p.image ? pictureName(p.image) : 'none';
  show('#propPicClear', !!p.image);
  show('#propTurn', !!p.image);
  show('#propFitRow', isMeshy(p) && !!p.image);
  radio('#propFit .chip', $(`#propFit .chip[data-fit="${p.fit}"]`));
  show('#propToonRow', p.kind !== 'game' || !!p.image);
  show('#propClipRow', p.kind === 'model' && p.clips?.length > 0);
  if (p.kind === 'model' && p.clips?.length) {
    const sel = $('#propClip');
    sel.innerHTML = '';
    sel.add(new Option('None', -1));
    p.clips.forEach((c, i) => sel.add(new Option(c.name || `Animation ${i + 1}`, i)));
    sel.value = p.clip;
  }
  $('#propToon').checked = p.toon;
  const gripPath = p.kind === 'game' && (p.anchor === 'right' ? p.info?.grip : p.anchor === 'left' ? p.info?.gripLeft : null);
  show('#propGripRow', !!gripPath);
  $('#propGrip').checked = p.grip;
  show('#propScaleRow', isMeshy(p));
  // models can be anything from a pebble to a tank
  $('#propScale').max = p.kind === 'model' ? 30 : 3;
  $('#propScale').min = p.kind === 'model' ? 0.05 : 0.2;
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

// --- your models -------------------------------------------------------------------------------

async function importModels(files) {
  let last = null;
  for (const f of files) {
    try {
      const r = await call('/api/models/upload?name=' + encodeURIComponent(f.name || 'model.glb'),
                           { method: 'POST', headers: { 'X-Studio': '1' }, body: f }, 'Importing ' + f.name + '…');
      last = r.file;
    } catch (e) { toast(e.message, true); }
  }
  return last;
}

async function openModels() {
  $('#modelPicker').style.display = 'block';
  const grid = $('#modelGrid');
  grid.innerHTML = '';
  let items = [];
  try { items = (await getJson('/api/models')).items; } catch (e) { toast(e.message, true); }
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.innerHTML = '<span></span>';
    b.querySelector('span').textContent = it.file.replace(/\.glb$/i, '');
    b.onclick = () => { closeModels(); add('model', { name: it.file }).catch(e => toast(e.message, true)); };
    grid.appendChild(b);
  }
  if (!items.length) grid.innerHTML = '<div class="empty">No models yet. Import a .glb (Sketchfab: Download 3D model, glTF binary) or drop one on this window.</div>';
}
const closeModels = () => { $('#modelPicker').style.display = 'none'; };

export function initProps(c) {
  ctx = c;
  ctx.scene.add(group);
  sun.target.position.set(0, 0, 0);
  group.add(sun, sun.target, sky);
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
  $('#addModel').onclick = openModels;
  $('#modelClose').onclick = closeModels;
  $('#modelPicker').addEventListener('mousedown', e => { if (e.target.id === 'modelPicker') closeModels(); });
  $('#modelImport').onclick = () => $('#modelFile').click();
  $('#modelFolder').onclick = () => post('/api/open', { what: 'models' }).catch(() => {});
  $('#modelFile').onchange = async () => {
    const files = [...$('#modelFile').files];
    $('#modelFile').value = '';
    const file = await importModels(files);
    if (file) { closeModels(); add('model', { name: file }).catch(e => toast(e.message, true)); }
  };
  onModelDropped(async files => {
    const file = await importModels(files);
    if (file) add('model', { name: file }).catch(e => toast(e.message, true));
  });
  $('#propClip').onchange = () => { setClip(selected, +$('#propClip').value); save(); };
  $('#propPickerClose').onclick = closePicker;
  $('#propPicker').addEventListener('mousedown', e => { if (e.target.id === 'propPicker') closePicker(); });
  let filterTimer;
  $('#propFilter').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(fillPicker, 150); };

  $('#propAnchor').onchange = () => {
    const p = selected;
    p.anchor = $('#propAnchor').value;
    defaultPlacement(p);
    placeAnchor(p, ownerOf(p));
    if (p.kind === 'game') applyGrips();
    syncEditor();
    save();
  };
  $('#propOwner').onchange = () => {
    const p = selected;
    p.owner = $('#propOwner').value;
    placeAnchor(p, ownerOf(p));
    applyGrips();
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

/** An uma left the scene: her props go to another. */
export function reown(from, to) {
  for (const p of list) if (p.owner === from) p.owner = to;
  save();
  applyGrips();
}

/** The selected prop, for keying. */
export const selectedProp = () => selected;
/** A prop by its saved key. */
export const propByKey = key => list.find(p => p.key === key) || null;
