import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GameSprings, TICK } from '/static/physics.js';
import { fitBody } from '/static/bodyfit.js';
import { loadStage, showParts, faceCamera, partKinds } from '/static/stage.js';
import { initStageEdit, stageLoaded, stageShown, updateStageEdit, stageGizmo, stagePicked, partLabel, placeCast } from '/static/stagedit.js';
import { U, kindOf, makeMaterial, makeOutline } from '/static/look.js';
import { $, $$, call, post, getJson, toast, radio, store, busy, initChrome } from '/static/ui.js';
import { pickImage, pictureName } from '/static/images.js';
import * as props from '/static/props.js';
import * as pose from '/static/pose.js';
import * as anim from '/static/anim.js';
import { loadSource, retarget } from '/static/retarget.js';
import { makeChain, settings as finish } from '/static/post.js';
import { initScenes, tick as sceneTick, scenesDebug } from '/static/scenekit.js';

// --- renderer -----------------------------------------------------------------

initChrome();
const canvas = $('#view');
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, stencil: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
// the toon shaders write final display values themselves, as the game does
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const scene = new THREE.Scene();
// she hangs under this: on a stage it stands her where she was put (stagedit.js), else the origin.
// every uma in the scene has her own; this is the active one's
let place = new THREE.Group();
place.name = 'placement';
scene.add(place);
function newSpot(n) {
  const g = new THREE.Group();
  g.name = 'placement';
  g.position.x = 0.8 * n;   // next to the others, not inside them
  scene.add(g);
  return g;
}
const camera = new THREE.PerspectiveCamera(25, 1, 0.03, 100);
camera.position.set(0, 0.9, 4.2);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.85, 0);
controls.enableDamping = true;
controls.update();
// a camera drag whose pointerup never came (focus lost mid-drag) keeps turning with the mouse.
// the first move with no button ends it, ahead of the orbit's own pointermove, through the
// orbit's pointercancel handling
let orbiting = false;
controls.addEventListener('start', () => { orbiting = true; });
controls.addEventListener('end', () => { orbiting = false; });
window.addEventListener('pointermove', e => {
  if (orbiting && !e.buttons && e.pointerType !== 'touch')
    canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: e.pointerId, pointerType: e.pointerType }));
}, true);

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  updateGuide();
}
new ResizeObserver(resize).observe(stage);

// --- state ------------------------------------------------------------------------

let current = null;          // the loaded character
let charas = [];
const shot = { cam: 'full', bg: store.get('bg', ''), size: store.get('size', '1280x720') };
const video = { len: 'loop', fmt: store.get('vidFmt', 'mp4'), fps: store.get('vidFps', 60) };
let recording = null;        // { cancel } while a video is being made

// --- choosing an Uma --------------------------------------------------------------------

let castReady;
const castLoaded = new Promise(r => { castReady = r; });

async function start() {
  const s = await getJson('/api/status', null);
  $('#status').textContent = s.version ? 'v' + s.version : '';
  if (s.loading) {
    // the server is still loading its modules and the game's file list
    $('#bootProg').value = s.progress;
    $('#bootText').textContent = `${s.stage}…`;
    setTimeout(() => start().catch(e => toast(e.message, true)), 250);
    return;
  }
  $('#boot').style.display = 'none';
  if (!s.ready) {
    $('#setup').style.display = 'flex';
    if (!picking) $('#setupError').textContent = s.error || '';
    $('#setupWhere').textContent = `Looked for the data in ${s.data}` + (s.game ? `, the game in ${s.game}` : ', the game was not found in Steam');
    $('#gameBrowse').style.display = s.browse ? '' : 'none';
    if (s.picked && !$('#gamePath').value) $('#gamePath').value = s.picked;
    $('#status').textContent = 'setup needed';
    setTimeout(() => start().catch(() => {}), 3000);
    return;
  }
  $('#setup').style.display = 'none';
  if (shot.bg === 'stage' && liveStage.id) openStage(liveStage.id).catch(e => toast(e.message, true));
  charas = (await getJson('/api/charas')).charas;
  fillUmas();
  const last = store.get('last', null);
  const saved = store.get('cast', []);
  const first = saved[0] || (last && { key: 'main', chara: last.chara, dress: last.dress });
  const c = charas.find(x => x.id === (+new URLSearchParams(location.search).get('uma') || first?.chara));
  if (c) {
    await chooseUma(c, first && first.chara === c.id ? first.dress : null, first?.key || 'main');
    // the rest of the scene's umas
    for (const s of saved.slice(1)) {
      const cc = charas.find(x => x.id === s.chara);
      if (cc) await chooseUma(cc, s.dress, s.key).catch(() => {});
    }
    if (cast.length > 1) setActive(cast[0]);
  } else openPicker();
  castReady();
}

// game files not found: the user points at the install or data folder by hand
let picking = false;   // keeps the answer to a pick on screen until the next status check
async function useGamePath(path) {
  if (!path) return;
  $('#gamePath').value = path;
  picking = true;
  try {
    await post('/api/game/path', { path }, null);
    $('#setupError').textContent = 'Reading the game files…';
  } catch (e) {
    $('#setupError').textContent = e.message;
  }
  setTimeout(() => { picking = false; }, 4000);
}
$('#gameUse').onclick = () => useGamePath($('#gamePath').value.trim());
$('#gamePath').onkeydown = e => { if (e.key === 'Enter') $('#gameUse').click(); };
$('#gameBrowse').onclick = async () => {
  const r = await post('/api/game/browse', {}, null).catch(e => toast(e.message, true));
  if (r?.path) await useGamePath(r.path);
};

function openPicker() {
  $('#picker').style.display = 'block';
  $('#umaFilter').value = '';
  fillUmas();
  setTimeout(() => $('#umaFilter').focus(), 30);
}
function closePicker() { $('#picker').style.display = 'none'; pickerAdd = false; }
let pickerAdd = false;   // the picker adds an uma to the scene instead of swapping the active one
$('#umaBtn').onclick = openPicker;
$('#pickerClose').onclick = closePicker;
$('#picker').addEventListener('mousedown', e => { if (e.target.id === 'picker' && current) closePicker(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && current) closePicker(); });

// the main cast, or the background Umas (mobs) the races and events are filled with
let umaKind = store.get('umaKind', 'main');
$$('#umaKinds .chip').forEach(b => {
  b.onclick = () => { umaKind = b.dataset.kind; store.set('umaKind', umaKind); radio('#umaKinds .chip', b); fillUmas(); };
});
radio('#umaKinds .chip', $(`#umaKinds .chip[data-kind="${umaKind}"]`));

function fillUmas() {
  const f = $('#umaFilter').value.trim().toLowerCase();
  const box = $('#umaGrid');
  box.innerHTML = '';
  for (const c of charas) {
    if ((c.mob ? 'mob' : c.mini ? 'mini' : 'main') !== umaKind) continue;
    if (f && !c.name.toLowerCase().includes(f) && !String(c.id).includes(f)) continue;
    const b = document.createElement('button');
    b.className = 'uma' + (current && current.chara === c.id ? ' on' : '');
    b.innerHTML = `<img loading="lazy" alt="" src="/api/icon/${c.base || c.id}"><span>${c.name}</span>`;
    b.querySelector('img').onerror = e => { e.target.style.visibility = 'hidden'; };
    b.onclick = () => {
      const add = pickerAdd;
      closePicker();
      chooseUma(c, null, add ? 'u' + Date.now().toString(36) : undefined);
    };
    box.appendChild(b);
  }
}
$('#umaFilter').oninput = fillUmas;
$('#umaFilter').onkeydown = e => { if (e.key === 'Enter') $('#umaGrid .uma')?.click(); };

async function chooseUma(c, dressId, key = active?.key || 'main') {
  closePicker();
  const d = umaHeader(c, dressId);
  await openUma(c, d, key);
}

/** The header shows c in outfit dressId (or her first); returns the outfit. */
function umaHeader(c, dressId) {
  const sel = $('#outfit');
  sel.length = 0;
  const own = c.dresses.filter(d => d.own), shared = c.dresses.filter(d => !d.own);
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    list.forEach(d => g.appendChild(new Option(d.name, d.id)));
    sel.appendChild(g);
  };
  group('Her outfits', own);
  if (shared.length) group('Shared outfits', shared);
  const d = c.dresses.find(x => x.id === dressId) || own[0] || shared[0];
  sel.value = d.id;
  sel.onchange = () => openUma(c, c.dresses.find(x => String(x.id) === sel.value));
  $('#umaImg').src = `/api/icon/${c.base || c.id}`;
  $('#umaName').textContent = c.name;
  $('#umaOutfit').textContent = d.name;
  return d;
}

// the newest pick wins: an older load (a first-time convert is slow) that finishes later is dropped
let umaSeq = 0;
async function openUma(c, d, key = active?.key || 'main') {
  const seq = ++umaSeq, stale = () => seq !== umaSeq;
  $('#umaOutfit').textContent = d.name;
  $('#overlay').textContent = `Loading ${c.name}…`;
  $('#overlay').style.display = 'flex';
  try {
    const r = await post('/api/load', { chara: c.id, dress: d.id }, `Loading ${c.name}…`);
    if (stale()) return;
    await busy(`Loading ${c.name}…`, loadModel(r.pack, r.manifest, r.sets, c, d, stale, key));
    if (!stale() && key === 'main') store.set('last', { chara: c.id, dress: d.id });
  } catch (e) {
    if (stale()) return;
    $('#overlay').textContent = '';
    toast(e.message, true);
  }
}

async function loadModel(pack, manifest, sets, chara, dress, stale = () => false, key = active?.key || 'main') {
  const base = `/data/${encodeURIComponent(pack)}/`;
  const gltf = await new GLTFLoader().loadAsync(base + 'model.gltf');

  const texCache = new Map();
  const getTex = idx => {
    if (!texCache.has(idx)) {
      texCache.set(idx, gltf.parser.getDependency('texture', idx).then(t => {
        t.colorSpace = THREE.NoColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.needsUpdate = true;
        return t;
      }));
    }
    return texCache.get(idx);
  };

  const meshes = [];
  gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  const miniParts = {};
  const outlines = [];
  for (const mesh of meshes) {
    const ud = mesh.material.userData || {};
    const kind = kindOf(ud);
    mesh.userData.kind = kind;   // the blender export rebuilds the shading from it
    const tex = {};
    for (const [slot, idx] of Object.entries(ud.textures || {})) tex[slot] = await getTex(idx);
    mesh.userData.tex = tex;     // the blender export needs every map, not just the ones the view uses
    mesh.material.dispose();
    mesh.material = makeMaterial(kind, ud, tex);
    mesh.frustumCulled = false;
    if (kind === 'tear') mesh.visible = false;
    // eyes and brows show through the bangs, like in the game: they mark the stencil and hair
    // skips those pixels
    if (kind.startsWith('mini')) (miniParts[kind] ??= []).push(mesh);
    if (kind === 'eye' || kind === 'mayu' || kind === 'minieye' || kind === 'minimayu') {
      Object.assign(mesh.material, { stencilWrite: true, stencilRef: 1, stencilZPass: THREE.ReplaceStencilOp });
      mesh.renderOrder = 2;
    } else if (kind === 'hair') {
      Object.assign(mesh.material, { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc });
      mesh.renderOrder = 3;
    } else if (kind === 'cheek') mesh.renderOrder = 4;
    else if (kind === 'face') mesh.renderOrder = 1;
    if (['body', 'hair', 'face', 'tail'].includes(kind) && mesh.isSkinnedMesh) {
      const o = new THREE.SkinnedMesh(mesh.geometry, makeOutline(ud, tex));
      if (manifest.mini) o.material.uniforms.uWidth.value *= 0.4;   // full-size line widths swamp a chibi
      o.bind(mesh.skeleton, mesh.bindMatrix);
      o.position.copy(mesh.position); o.quaternion.copy(mesh.quaternion); o.scale.copy(mesh.scale);
      o.frustumCulled = false;
      o.renderOrder = mesh.renderOrder;
      mesh.parent.add(o);
      outlines.push(o);
    }
  }

  if (stale()) {
    gltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return;
  }
  // the uma with this key is replaced, or a new one joins
  const old = cast.find(m => m.key === key);
  if (current && current !== old) stash(current);
  if (old) {
    old.spot.remove(old.root);
    old.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
  const spot = old?.spot || (cast.length ? newSpot(cast.length) : place);
  const root = gltf.scene;
  spot.add(root);
  const rest = new Map();
  root.traverse(o => { if (o.isBone || o.type === 'Object3D') rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  current = { pack, base, manifest, sets, root, rest, outlines, chara: chara.id, name: chara.name, dress: dress.name, miniParts,
              mixer: new THREE.AnimationMixer(root), action: null, clips: new Map(), springs: null, named: {},
              key, spot, dressId: dress.id, g: null };
  if (old) cast[cast.indexOf(old)] = current; else cast.push(current);
  active = current;
  place = spot;
  face = null; faceBones = null; mini = null; eyeTrace = null;
  look.yaw = 0; look.pitch = 0; look.set = new Map();
  saveCast();
  renderCast();
  placeCast();
  anim.touch();
  follow.root = null;
  current.mixer.timeScale = parseFloat($('#speed').value);
  props.onModel(current);
  pose.onModel(current);
  if (manifest.physics) newSprings();
  current.process = bindProcess(manifest.process || []);
  outlines.forEach(o => { o.visible = $('#outline').checked; });
  $('#overlay').style.display = 'none';
  await loadFace();
  if (stale()) return;
  setCamera(shot.cam);
  fillPoses();
  // chibis pose from the chibi motions, everyone else not
  if (!!manifest.mini !== (poseCat === 'mini')) { poseCat = manifest.mini ? 'mini' : 'own'; $('#poseCat').value = poseCat; fillPoses(); }
  const idle = !manifest.mini && (manifest.motions.find(m => /idle01_loop$/i.test(m.name)) || manifest.motions[0]);
  if (manifest.mini) {
    const path = manifest.mini.idle || '3d/motion/mini/event/body/type00/anm_min_eve_type00_idle01_loop';
    await playClip(await libraryClip(path), path, true, 'Idle', false).catch(() => {});
  } else if (idle) {
    const st = sets.find(x => x.parts.some(([, k]) => k === idle.name));
    await playClip(await ownClip(idle.name), idle.name, true, st ? st.title : 'idle', false);
  } else {
    // background Umas have no motions of their own: a plain standing loop from the library
    const stand = '3d/motion/event/body/type00/anm_eve_type00_homestand01_loop';
    await playClip(await libraryClip(stand), stand, true, 'Standing', false).catch(() => {});
  }
}

// --- the cast -----------------------------------------------------------------------------------
//
// everyone in the scene. one is active: the panels (face, poses, props...) work on her and she is
// `current`. each frame the others get the same treatment by swapping current and the few
// per-uma globals (face, eyes, head turn, playing pose) for theirs.

const cast = [];
let active = null;

function stash(m) {
  m.g = { face, faceBones, faceState: { ...faceState }, mini, eyeTrace, look: { yaw: look.yaw, pitch: look.pitch, set: look.set },
          poseKey, poseTitle };
}
function unstash(m) {
  const g = m.g;
  if (!g) return;
  face = g.face; faceBones = g.faceBones; Object.assign(faceState, g.faceState); mini = g.mini; eyeTrace = g.eyeTrace;
  look.yaw = g.look.yaw; look.pitch = g.look.pitch; look.set = g.look.set;
  poseKey = g.poseKey; poseTitle = g.poseTitle;
}
function swapTo(m) {
  if (!m || current === m) return;
  if (current) stash(current);
  current = m;
  unstash(m);
  place = m.spot;
}
/** fn for every uma in the scene, each as current; the active one is current again after. */
function forCast(fn) {
  const was = active;
  for (const m of [...cast]) { swapTo(m); fn(m); }
  swapTo(was);
}

const saveCast = () => store.set('cast', cast.map(m => ({ key: m.key, chara: m.chara, dress: m.dressId })));

/** The panels switch to m. */
function setActive(m) {
  if (!m) return;
  swapTo(m);
  active = m;
  place = m.spot;
  const c = charas.find(x => x.id === m.chara);
  if (c) umaHeader(c, m.dressId);
  follow.root = null;
  pose.onModel(m);
  if (mini) { const st = mini.st; setupMiniFace(); mini.st = st; applyMiniFace(); }
  else fillFace();
  $('#scrub').max = m.action ? m.action.getClip().duration : 1;
  fillPoses();
  renderCast();
  anim.touch();
}

function removeMember(m) {
  if (cast.length < 2) return;
  const i = cast.indexOf(m);
  cast.splice(i, 1);
  m.spot.remove(m.root);
  scene.remove(m.spot);
  m.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  m.springs = null;
  props.reown(m.key, cast[0].key);
  if (current === m) { current = null; active = null; }
  setActive(m === active || !active ? cast[0] : active);
  saveCast();
  renderCast();
}

function renderCast() {
  const box = $('#cast');
  box.innerHTML = '';
  box.style.display = cast.length > 1 ? '' : 'none';
  for (const m of cast) {
    const c = charas.find(x => x.id === m.chara);
    const b = document.createElement('button');
    b.className = 'castChip' + (m === active ? ' on' : '');
    b.title = `${m.name}: click to work on her`;
    b.innerHTML = '<img alt=""><span></span><i title="Take her out of the scene">✕</i>';
    b.querySelector('img').src = `/api/icon/${c?.base || m.chara}`;
    b.querySelector('span').textContent = m.name;
    b.onclick = e => { if (e.target.tagName === 'I') removeMember(m); else if (m !== active) setActive(m); };
    box.appendChild(b);
  }
}
$('#castAdd').onclick = () => { openPicker(); pickerAdd = true; };

// --- poses ------------------------------------------------------------------------------
//
// an outliner. similar motion sets fold into a family (Arms crossed 1, 1-1, 2…). a set plays
// its main part, and the playing set shows a row of buttons for its other parts (start, loop,
// end, still, reactions, cut-in shots). a category loads whole, once, and is searched here.

const POSE_CATS = [['own', 'Her poses'], ['imported', 'Imported'], ['mini', 'Chibi'], ['event', 'Everyday'], ['charaevent', 'Characters'], ['victory', 'Victory'],
                   ['cutin', 'Cut-ins'], ['live', 'Dance'], ['home', 'Home'], ['training', 'Training'], ['story', 'Story']];
let poseCat = store.get('poseCat', 'own');
let poseKey = null;          // the part playing: a motion name (her own) or a library path
let poseTitle = 'rest';      // what it is called, for file names
const libSets = new Map();   // 'category|mirror' -> sets
const openFams = new Set();  // 'category|family' folded open
const MAX_OPEN_ON_SEARCH = 400;

for (const [k, label] of POSE_CATS) $('#poseCat').add(new Option(label, k));
if (!POSE_CATS.some(([k]) => k === poseCat)) poseCat = 'own';
$('#poseCat').value = poseCat;
$('#poseCat').onchange = () => { poseCat = $('#poseCat').value; store.set('poseCat', poseCat); fillPoses(); };

const searchText = st => (st.search ??= `${st.title} ${st.sub} ${st.tags || ''} ${st.parts.map(([, k]) => k.split('/').pop()).join(' ')}`.toLowerCase());

let poseSeq = 0;
async function fillPoses() {
  const seq = ++poseSeq;
  const box = $('#poses');
  let sets, getClip;
  $('#animImport').style.display = poseCat === 'imported' ? '' : 'none';
  $('#libMirror').parentElement.style.display = poseCat === 'imported' || poseCat === 'own' ? 'none' : '';
  if (poseCat === 'own') {
    if (!current) { box.innerHTML = '<div class="empty">Choose an Uma first.</div>'; return; }
    sets = current.sets;
    getClip = ownClip;
  } else if (poseCat === 'imported') {
    try { sets = await importedSets(); } catch (e) { toast(e.message, true); return; }
    if (seq !== poseSeq) return;
    if (!sets.length) {
      box.innerHTML = '<div class="empty">No animations yet. Import a .glb with animations on a humanoid rig: Mixamo (Download, FBX converted to glb, or glb), Quaternius\' Universal Animation Library, or anything else with a standard skeleton.</div>';
      return;
    }
    getClip = importedClip;
  } else {
    const key = `${poseCat}|${$('#libMirror').checked ? 1 : 0}`;
    if (!libSets.has(key)) {
      const q = new URLSearchParams({ cat: poseCat, n: 100000, mirror: $('#libMirror').checked ? '1' : '0' });
      try {
        libSets.set(key, (await getJson('/api/library?' + q, 'Loading poses…')).items);
      } catch (e) { toast(e.message, true); return; }
      if (seq !== poseSeq) return;
    }
    sets = libSets.get(key);
    getClip = libraryClip;
  }
  const terms = $('#poseFilter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = terms.length ? sets.filter(st => terms.every(t => searchText(st).includes(t))) : sets;
  if (poseCat !== 'own' && current) {
    // the loaded uma's own entries first
    list = [...list.filter(st => st.chara === current.chara), ...list.filter(st => st.chara !== current.chara)];
  }
  renderTree(list, getClip, terms.length > 0 && list.length <= MAX_OPEN_ON_SEARCH);
}

function renderTree(list, getClip, openAll) {
  const box = $('#poses');
  box.innerHTML = '';
  box.scrollTop = 0;
  if (!list.length) {
    box.innerHTML = '<div class="empty">No poses match.</div>';
    return;
  }
  const byName = new Map();
  for (const st of list) {
    if (!byName.has(st.family)) byName.set(st.family, { name: st.family, sets: [] });
    byName.get(st.family).sets.push(st);
  }
  const fams = [...byName.values()];
  const frag = document.createDocumentFragment();
  const toOpen = [];
  for (const fam of fams) {
    if (fam.sets.length === 1) {
      frag.appendChild(setRow(fam.sets[0], getClip, 0, true));
      continue;
    }
    const key = `${poseCat}|${fam.name}`;
    const head = document.createElement('div');
    head.className = 'row fam';
    head.tabIndex = 0;
    head.innerHTML = '<i class="tw"></i><span class="t"></span><span class="n"></span>';
    head.querySelector('.t').textContent = fam.name;
    head.querySelector('.n').textContent = fam.sets.length;
    let rows = null;
    const fold = open => {
      head.classList.toggle('open', open);
      if (open) {
        openFams.add(key);
        rows ??= fam.sets.map(st => setRow(st, getClip, 1, false));
        head.after(...rows);
        rows.forEach(markPose);
      } else {
        openFams.delete(key);
        rows?.forEach(r => { r.remove(); r.partsRow?.remove(); r.partsRow = null; });
      }
    };
    head.onclick = () => fold(!head.classList.contains('open'));
    head.onkeydown = e => { if (e.key === 'Enter') head.onclick(); };
    frag.appendChild(head);
    if (openAll || openFams.has(key) || fam.sets.some(st => st.parts.some(([, k]) => k === poseKey))) toOpen.push(fold);
  }
  box.appendChild(frag);
  toOpen.forEach(fold => fold(true));
  $$('#poses .row.set').forEach(markPose);
  $('#poses .row.on')?.scrollIntoView({ block: 'center' });
}

function setRow(st, getClip, depth, top) {
  const row = document.createElement('div');
  row.className = 'row set';
  row.tabIndex = 0;
  row.style.setProperty('--depth', depth);
  row.st = st;
  row.keys = st.parts.map(([, k]) => k);
  row.innerHTML = '<i class="tw"></i><span class="t"></span><small></small>';
  row.querySelector('.t').textContent = top ? st.title : (st.name || st.sub || st.title);
  row.querySelector('small').textContent = top || st.name ? st.sub : '';
  row.title = st.sub ? `${st.title} · ${st.sub}` : st.title;
  row.play = async (label, key) => {
    if (!current) return openPicker();
    row.classList.add('loading');
    try {
      const clip = await busy('Loading pose…', getClip(key));
      await playClip(clip, key, true, st.parts.length > 1 ? `${st.title} (${label})` : st.title);
    } catch (e) { toast(e.message, true); }
    finally { row.classList.remove('loading'); }
  };
  row.onclick = () => row.play(...st.parts[st.default]);
  row.onkeydown = e => { if (e.key === 'Enter') row.onclick(); };
  return row;
}

/** Highlights the playing row and gives it its parts' buttons. */
function markPose(row) {
  const on = row.keys.includes(poseKey);
  row.classList.toggle('on', on);
  const want = on && row.st.parts.length > 1 && row.isConnected;
  if (want && !row.partsRow) {
    const pr = document.createElement('div');
    pr.className = 'row parts';
    pr.style.setProperty('--depth', +row.style.getPropertyValue('--depth') + 1);
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.setProperty('--cols', Math.min(row.st.parts.length, 4));
    for (const [label, key] of row.st.parts) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.key = key;
      b.textContent = label;
      b.onclick = () => row.play(label, key);
      seg.appendChild(b);
    }
    pr.appendChild(seg);
    row.after(pr);
    row.partsRow = pr;
  } else if (!want && row.partsRow) {
    row.partsRow.remove();
    row.partsRow = null;
  }
  row.partsRow?.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b.dataset.key === poseKey));
}

let poseTimer;
$('#poseFilter').oninput = () => { clearTimeout(poseTimer); poseTimer = setTimeout(fillPoses, 120); };
$('#libMirror').onchange = fillPoses;

// --- imported animations ---------------------------------------------------------------------
//
// .glb files in Pictures\UmaStudio\animations: every clip in them shows as a pose, put on the
// loaded uma when picked (retarget.js), then kept like her own.

let importedList = null;
async function importedSets() {
  if (!importedList) {
    const files = (await getJson('/api/anims', 'Loading animations…')).items;
    importedList = [];
    for (const f of files) {
      const url = '/anims/' + encodeURIComponent(f.file);
      let src;
      try { src = await busy('Reading ' + f.file + '…', loadSource(url)); } catch { continue; }
      const fam = f.file.replace(/\.glb$/i, '');
      for (const c of src.animations) {
        const name = c.name.replace(/^.*\|/, '').replace(/[_-]+/g, ' ').trim() || 'Animation';
        importedList.push({ title: name, name, sub: fam, family: fam, parts: [['Loop', `anim:${f.file}|${c.name}`]], default: 0 });
      }
    }
  }
  return importedList;
}

async function importedClip(key, cur = current) {
  if (cur.clips.has(key)) return cur.clips.get(key);
  const [file, name] = key.slice(5).split('|');
  const src = await loadSource('/anims/' + encodeURIComponent(file));
  const clip = src.animations.find(c => c.name === name);
  if (!clip) throw new Error('that animation is gone from ' + file);
  const out = retarget(src, clip, cur);
  cur.clips.set(key, out);
  return out;
}

/** Any pose by its key, for an uma: her own motion, a library path or an imported animation. */
function clipFor(m, key) {
  return key.startsWith('anim:') ? importedClip(key, m) : key.includes('/') ? libraryClip(key, m) : ownClip(key, m);
}

$('#animImport').onclick = () => $('#animFile').click();
$('#animFile').onchange = async () => {
  const files = [...$('#animFile').files];
  $('#animFile').value = '';
  for (const f of files) {
    try {
      await call('/api/anims/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'X-Studio': '1' }, body: f }, 'Importing ' + f.name + '…');
    } catch (e) { toast(e.message, true); }
  }
  importedList = null;
  fillPoses();
};

function buildClip(m) {
  const times = new Float32Array(m.frames);
  for (let i = 0; i < m.frames; i++) times[i] = i / m.fps;
  const zero = new Float32Array([0]);
  const tracks = [];
  for (const t of m.tracks) {
    const width = t.type === 'quaternion' ? 4 : 3;
    const Track = t.type === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    tracks.push(new Track(THREE.PropertyBinding.sanitizeNodeName(t.bone) + '.' + t.type,
                          t.values.length / width === 1 ? zero : times, t.values));
  }
  return new THREE.AnimationClip(m.name, m.duration, tracks);
}

async function ownClip(name, cur = current) {
  if (cur.clips.has(name)) return cur.clips.get(name);
  const clip = buildClip(await getJson(`${cur.base}motions/${encodeURIComponent(name)}.json`, null));
  cur.clips.set(name, clip);
  return clip;
}

/** Dances place her on the stage. here she starts where she stands, keeping her moves
  *  across it, with the stage floor at 0. */
function toOrigin(m) {
  const t = m.tracks.find(t => t.bone === 'Position' && t.type === 'position');
  if (!t) return;
  const v = t.values;
  let floor = Infinity;
  for (let i = 1; i < v.length; i += 3) floor = Math.min(floor, v[i]);
  const x0 = v[0], z0 = v[2];
  for (let i = 0; i < v.length; i += 3) { v[i] -= x0; v[i + 1] -= floor; v[i + 2] -= z0; }
}

async function libraryClip(path, cur = current) {
  if (cur.clips.has(path)) return cur.clips.get(path);
  const r = await getJson('/api/library/clip?path=' + encodeURIComponent(path), null);
  if (!r.clips.length) throw new Error('that pose has no usable motion');
  if (path.startsWith('3d/motion/live/')) toOrigin(r.clips[0]);
  const clip = buildClip(r.clips[0]);
  cur.clips.set(path, clip);
  return clip;
}

// the motion only rewrites the bones it has tracks for, so what went on top of it last time
// comes off first, newest first: the head turn, then the pose mode offsets
function runMotion(dt) {
  liftHeadTurn();
  if (current === active) pose.liftEdits();
  current.mixer.update(dt);
}

function restPose() {
  current.mixer.stopAllAction();
  current.action = null;
  for (const [o, [p, q, s]] of current.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  current.springs?.reset();
}

/** `keyIt`: false for the pose she starts in when she loads, which never replaces a motion key. */
async function playClip(clip, key, autoplay, title, keyIt = true) {
  restPose();
  const a = current.mixer.clipAction(clip);
  a.reset();
  a.setLoop(THREE.LoopRepeat, Infinity);
  a.play();
  current.action = a;
  current.springs?.reset();
  poseKey = key;
  poseTitle = title || poseTitle;
  $$('#poses .row.set').forEach(markPose);
  $('#scrub').max = clip.duration;
  // on an animated scene the timeline stays where it is: she shows the pose at that moment
  setPlaying(!!autoplay && !anim.active());
  runMotion(0);
  props.applyGrips();
  // with motion keys on the timeline a picked pose goes in as a key where the timeline is
  if (keyIt && anim.active() && anim.motionKeys(current.key).length) {
    anim.keyMotion(current.key, key, poseTitle);
    setPlaying(false);
    toast(`${current.name}: ${poseTitle} from ${anim.now().toFixed(2)} s`);
  }
  anim.touch();
}

let playing = false;
function setPlaying(p) {
  playing = p && (!!(current && current.action) || anim.active());
  for (const m of cast) if (m.action) m.action.paused = !playing;
  $('#play').textContent = playing ? '❚❚' : '▶';
}
function updateTime() {
  const scene = anim.active();
  const t = scene ? anim.now() : current && current.action ? current.action.time : 0;
  $('#time').textContent = t.toFixed(2) + 's';
  if (scene) $('#scrub').max = anim.length();
  else if (current?.action) $('#scrub').max = current.action.getClip().duration;
  if (document.activeElement !== $('#scrub')) $('#scrub').value = t;
}

// switching poses blends for longer the further her body has to move: a hand gesture takes
// BLEND, lying down to standing BLEND_MAX. a switch on a cut doesn't blend at all
const BLEND = 0.25, BLEND_MAX = 1.0, BLEND_PER_M = 0.7, CUT_NEAR = 0.1;
const POSE_POINTS = ['Hip', 'Head', 'Wrist_L', 'Wrist_R', 'Ankle_L', 'Ankle_R'];
// one-shot clips (a fall, a jump) hold their last frame instead of starting over; library clips
// are one-shots unless named _Loop
const playsOnce = key => key.once ?? (/^anim:/.test(key.clip) && !/_Loop$/.test(key.clip));
const clipTime = (clip, time, once) => {
  const d = clip.duration || 1;
  return once ? Math.min(time, d - 1e-3) : time % d;
};

/** Seconds into `clip` at scene time t for her key `key`. A run or walk played in place while
 *  her spot is keyed across the ground plays as fast as she travels, so her feet don't slide:
 *  half to twice its own speed, and its own speed while she stands still. */
const STRIDE_STEP = 1 / 30;
function clipClock(clip, key, t) {
  const lt = Math.max(0, t - key.t);
  const v = clip.groundSpeed;
  let prev = v && anim.spotAt(current.key, key.t);
  if (!prev) return lt;
  let time = 0;
  for (let x = key.t; x < t - 1e-9;) {
    const dt = Math.min(STRIDE_STEP, t - x), p = anim.spotAt(current.key, x + dt);
    const speed = Math.hypot(p[0] - prev[0], p[1] - prev[1]) / dt;
    time += dt * (speed < 0.05 ? 1 : Math.min(2, Math.max(0.5, speed / v)));
    x += dt;
    prev = p;
  }
  return time;
}

/** Where her hips, head, hands and feet are (her root's space) in `clip` at `time`. Leaves the
 *  mixer posed that way: the caller poses her again. */
function posePoints(clip, time) {
  const x = current.mixer.clipAction(clip);
  for (const o of current.mixer._actions) if (o !== x && !current.grips?.includes(o)) o.enabled = false;
  x.enabled = true;
  x.play();
  x.setEffectiveWeight(1);
  x.time = time;
  runMotion(0);
  current.root.updateMatrixWorld(true);
  const inv = current.root.matrixWorld.clone().invert();
  return POSE_POINTS.map(n => current.root.getObjectByName(n)?.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
}

/** How long the switch from key `prev` to key `k` blends. */
function blendLength(prev, a, k, b) {
  const id = `${prev.clip}@${(k.t - prev.t).toFixed(3)}>${k.clip}`;
  current.blends ??= new Map();
  if (!current.blends.has(id)) {
    const p = posePoints(a, clipTime(a, clipClock(a, prev, k.t), playsOnce(prev))), q = posePoints(b, 0);
    let far = 0;
    p.forEach((v, i) => { if (v && q[i]) far = Math.max(far, v.distanceTo(q[i])); });
    current.blends.set(id, Math.min(BLEND_MAX, BLEND + far * BLEND_PER_M));
  }
  return current.blends.get(id);
}

/** Her motion at scene time t: her motion keys (each pose plays from its key, the switch
 *  blends), or without keys the pose she has, looping. */
function motionAt(t) {
  if (!current) return;
  const keys = anim.motionKeys(current.key);
  if (!keys.length) {
    if (!current.action) return;
    current.action.enabled = true;
    const d = current.action.getClip().duration || 1;
    current.action.time = t % d;
    runMotion(0);
    return;
  }
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const k = keys[i], prev = i > 0 ? keys[i - 1] : null;
  // 'rest': no motion, her skeleton as it was modelled (a T-pose)
  if (k.clip === 'rest') {
    for (const x of current.mixer._actions) x.enabled = false;
    for (const [o, [p, q, s]] of current.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
    current.action = null;
    runMotion(0);
    return;
  }
  const b = current.clips.get(k.clip), a = prev && prev.clip !== 'rest' && current.clips.get(prev.clip);
  if (!b) needClip(current, k.clip);
  if (prev && !a) needClip(current, prev.clip);
  if (!b) { runMotion(0); return; }
  const lt = Math.max(0, t - k.t);
  let w = 1;
  if (a && lt < BLEND_MAX && !anim.cutTimes(current.key).some(c => Math.abs(c - k.t) <= CUT_NEAR)) {
    const u = Math.min(1, lt / blendLength(prev, a, k, b));
    w = u * u * (3 - 2 * u);
  }
  const ab = current.mixer.clipAction(b), aa = w < 1 ? current.mixer.clipAction(a) : null;
  for (const x of current.mixer._actions) if (x !== ab && x !== aa && !current.grips?.includes(x)) x.enabled = false;
  const put = (x, time, weight, one) => {
    x.enabled = true;
    x.setLoop(THREE.LoopRepeat, Infinity);
    x.play();
    x.setEffectiveWeight(weight);
    x.time = clipTime(x.getClip(), time, one);
  };
  put(ab, clipClock(b, k, t), w, playsOnce(k));
  if (aa) put(aa, clipClock(a, prev, t), 1 - w, playsOnce(prev));
  current.action = ab;
  runMotion(0);
}

/** Her face at scene time t from her face keys (the first one holds before it). */
function faceAt(t) {
  const keys = anim.faceKeys(current.key);
  if (!keys.length || !face) return;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  if (current.faceShown === keys[i].face) return;
  const p = face.presets.find(x => x.label === keys[i].face);
  if (!p) return;
  current.faceShown = keys[i].face;
  for (const k of Object.keys(faceState)) faceState[k] = p[k] || 'Base';
}

/** Loads a pose an uma's motion keys need (once), in the background. */
function needClip(m, key) {
  m.loading ??= new Set();
  if (m.loading.has(key)) return;
  m.loading.add(key);
  clipFor(m, key).catch(e => toast(`${m.name}: ${e.message}`, true));
}

/** Every pose the motion keys need, loaded (before a video). */
async function loadMotionClips() {
  for (const m of cast) for (const k of anim.motionKeys(m.key)) if (k.clip !== 'rest' && !m.clips.has(k.clip)) await clipFor(m, k.clip);
}
$('#play').onclick = () => setPlaying(!playing);
$('#scrub').oninput = () => {
  if (anim.active()) {
    setPlaying(false);
    anim.seek(parseFloat($('#scrub').value));
    current?.springs?.reset();
    updateTime();
    return;
  }
  if (!current || !current.action) return;
  setPlaying(false);
  current.action.time = parseFloat($('#scrub').value);
  runMotion(0);
  current.springs?.reset();
  updateTime();
};
$('#speed').onchange = () => { for (const m of cast) m.mixer.timeScale = parseFloat($('#speed').value); };
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); setPlaying(!playing); }
});

// --- face --------------------------------------------------------------------------------
//
// face.json: per part (eye / eyebrow / mouth) and side, the bones, their rest transform (shape 0)
// and one offset per shape. an expression is rest plus weighted offsets, in unity space,
// converted to three.js space after blending.

let face = null, faceBones = null;
const faceState = { eyebrow_l: 'Base', eyebrow_r: 'Base', eye_l: 'Base', eye_r: 'Base', mouth: 'Base' };
const FACE_CHIPS = [['Base', 'Neutral'], ['WaraiA', 'Smile'], ['WaraiB', 'Happy'], ['WaraiC', 'Laugh'], ['WinkL', 'Wink'],
                    ['OdorokiA', 'Surprised'], ['IkariA', 'Angry'], ['KanasiA', 'Sad'], ['DoyaA', 'Smug'], ['DereA', 'Shy'],
                    ['KomariA', 'Troubled'], ['EyeClose', 'Eyes closed']];
const FACE_HINTS = [
  ['OutGameWarai', 'smile'], ['EyeHohoemi', 'gentle smile'], ['EyeWarai', 'smiling eyes'], ['EyeUrei', 'worried eyes'],
  ['EyeHalf', 'half-closed eyes'], ['EyeClose', 'eyes closed'], ['EyeHide', 'eyes hidden'], ['EyelidHide', 'no eyelids'],
  ['Warai', 'smile'], ['Ikari', 'angry'], ['Kanasi', 'sad'], ['Doya', 'smug'], ['Futu', 'neutral'], ['Odoroki', 'surprised'],
  ['Jitome', 'side-eye'], ['Jito', 'side-eye'], ['Komari', 'troubled'], ['Dere', 'flustered'], ['Kusyo', 'wry smile'],
  ['Urei', 'worried'], ['Wink', 'wink'], ['Close', 'eyes closed'], ['Half', 'half-closed'], ['Serious', 'serious'],
  ['Shiwa', 'frown'], ['Tan', 'pout'], ['Cheek', 'puffed cheek'], ['Run', 'running'], ['Unique', 'character-specific'],
  ['MouthKanasi', 'sad talking'], ['Mouth', 'talking'], ['Talk', 'talking'], ['Magao', 'blank'], ['Normal', 'normal'], ['Base', 'default'],
];
const faceHint = l => { const n = l.replace(/^_/, ''); const f = FACE_HINTS.find(([k]) => n.startsWith(k)); return f ? f[1] : ''; };
const withHint = n => faceHint(n) ? `${n} — ${faceHint(n)}` : n;
const parseParts = v => String(v || 'Base').split('|').map(x => { const m = x.match(/^(.*?)(?:__(\d+))?$/); return [m[1], m[2] ? +m[2] / 100 : 1]; });

// chibi faces: no face bones, the eyes, mouth and brows are tiles picked from atlases. presets
// come from the game (mini_face_type_data); the part menus pick single tiles.
let mini = null;   // { faces, st: { brow_l, brow_r, eye_l, eye_r, mouth, cheek } }
const tile = (i, rows) => new THREE.Vector2(0.25 * (i % 4), (1 / rows) * Math.floor(i / 4));
function applyMiniFace() {
  if (!mini?.st) return;
  const st = mini.st, parts = current.miniParts;
  const set = (kind, f) => (parts[kind] || []).forEach(m => f(m.material.uniforms.uTile.value, m));
  set('minieye', v => { const r = tile(st.eye_r, 8), l = tile(st.eye_l, 8); v.set(r.x, r.y, l.x, l.y); });
  set('minimouth', v => { const t = tile(st.mouth, 8); v.set(t.x, t.y, t.x, t.y); });
  set('minimayu', (v, m) => { const t = tile(/_L$/.test(m.name) ? st.brow_l : st.brow_r, 4); v.set(t.x, t.y, t.x, t.y); });
  current.root.traverse(o => { if (o.isMesh && o.name === 'M_Cheek') o.visible = st.cheek > 0; });
}
function setupMiniFace() {
  mini = { faces: current.manifest.mini.faces, st: null };
  const have = new Set(mini.faces.map(f => f.label));
  const chips = $('#faces');
  chips.innerHTML = '';
  for (const [label, text] of FACE_CHIPS) {
    if (!have.has(label)) continue;
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.face = label; b.textContent = text;
    b.onclick = () => setFace(label);
    chips.appendChild(b);
  }
  const sel = $('#facePreset');
  sel.length = 0;
  sel.add(new Option('More expressions…', ''));
  mini.faces.forEach(f => sel.add(new Option(withHint(f.label), f.label)));
  const nums = (s, n) => { s.length = 0; for (let i = 0; i < n; i++) s.add(new Option(`Tile ${i + 1}`, i)); };
  nums($('#faceBrow'), 9); nums($('#faceEye'), 15); nums($('#faceMouth'), 19);
  setFace(have.has('WaraiA') ? 'WaraiA' : mini.faces[0]?.label);
}

async function loadFace() {
  face = null; faceBones = null; mini = null;
  if (current.manifest.mini) { setupMiniFace(); bindEyeTrace(); return; }
  if (current.manifest.face) {
    face = await getJson(current.base + 'face.json');
    faceBones = {};
    for (const part of ['eye', 'eyebrow', 'mouth'])
      faceBones[part] = face[part].groups.map(g => g.bones.map(b => current.root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(b))));
  }
  bindEyeTrace();
  fillFace();
  setFace('Base');
}

function fillFace() {
  const chips = $('#faces');
  chips.innerHTML = '';
  const have = new Set(face ? face.presets.map(p => p.label) : []);
  for (const [label, text] of FACE_CHIPS) {
    if (!have.has(label)) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.face = label;
    b.textContent = text;
    b.onclick = () => setFace(label);
    chips.appendChild(b);
  }
  const sel = $('#facePreset');
  sel.length = 0;
  sel.add(new Option('More expressions…', ''));
  for (const p of face ? face.presets : []) if (!p.label.startsWith('_')) sel.add(new Option(withHint(p.label), p.label));
  const opts = (s, list) => { s.length = 0; list.forEach(n => s.add(new Option(withHint(n), n))); };
  opts($('#faceBrow'), face ? face.eyebrow.names.filter(n => !/^Offset/.test(n)) : []);
  opts($('#faceEye'), face ? face.eye.names.filter(n => !/Range$/.test(n)) : []);
  opts($('#faceMouth'), face ? face.mouth.names.filter(n => !/^(Offset|Scale|LowAngle)/.test(n)) : []);
}

function setFace(label) {
  if (mini) {
    const f = mini.faces.find(x => x.label === label);
    if (!f) return;
    mini.st = { ...f };
    const chip = $(`#faces .chip[data-face="${label}"]`);
    radio('#faces .chip', chip);
    $('#facePreset').value = chip ? '' : label;
    $('#faceBrow').value = f.brow_l; $('#faceEye').value = f.eye_l; $('#faceMouth').value = f.mouth;
    return applyMiniFace();
  }
  const p = face && face.presets.find(x => x.label === label);
  if (!p) return;
  for (const k of Object.keys(faceState)) faceState[k] = p[k] || 'Base';
  current.facePicked = label;
  // with face keys on the timeline a picked face goes in as a key where the timeline is
  if (anim.active() && anim.faceKeys(current.key).length && current === active) anim.keyFace(current.key, label);
  const chip = $(`#faces .chip[data-face="${label}"]`);
  radio('#faces .chip', chip);
  $('#facePreset').value = chip ? '' : label;
  const main = v => parseParts(v).sort((a, b) => b[1] - a[1])[0][0];
  $('#faceBrow').value = main(faceState.eyebrow_l);
  $('#faceEye').value = main(faceState.eye_l);
  $('#faceMouth').value = main(faceState.mouth);
}
$('#facePreset').onchange = () => { if ($('#facePreset').value) setFace($('#facePreset').value); };
const miniPick = (keys, v) => { keys.forEach(k => { mini.st[k] = +v; }); radio('#faces .chip', null); applyMiniFace(); };
$('#faceBrow').onchange = () => { if (mini) return miniPick(['brow_l', 'brow_r'], $('#faceBrow').value); faceState.eyebrow_l = faceState.eyebrow_r = $('#faceBrow').value; radio('#faces .chip', null); };
$('#faceEye').onchange = () => { if (mini) return miniPick(['eye_l', 'eye_r'], $('#faceEye').value); faceState.eye_l = faceState.eye_r = $('#faceEye').value; radio('#faces .chip', null); };
$('#faceMouth').onchange = () => { if (mini) return miniPick(['mouth'], $('#faceMouth').value); faceState.mouth = $('#faceMouth').value; radio('#faces .chip', null); };

const _fq = new THREE.Quaternion(), _fe = new THREE.Euler();
function applyFace() {
  if (!face || !faceBones) return;
  for (const part of ['eye', 'eyebrow', 'mouth']) {
    const def = face[part];
    def.groups.forEach((g, gi) => {
      const key = part === 'mouth' ? 'mouth' : part + '_' + (g.side === 'L' ? 'l' : 'r');
      const mix = parseParts(faceState[key]).map(([n, w]) => [def.names.indexOf(n), w]).filter(([i]) => i > 0);
      const base = g.shapes[0], bones = faceBones[part][gi];
      for (let b = 0; b < g.bones.length; b++) {
        const o = bones[b];
        if (!o) continue;
        const k = b * 9;
        let px = base[k], py = base[k + 1], pz = base[k + 2], rx = base[k + 3], ry = base[k + 4], rz = base[k + 5];
        let sx = base[k + 6], sy = base[k + 7], sz = base[k + 8];
        for (const [i, w] of mix) {
          const d = g.shapes[i];
          px += d[k] * w; py += d[k + 1] * w; pz += d[k + 2] * w;
          rx += d[k + 3] * w; ry += d[k + 4] * w; rz += d[k + 5] * w;
          sx += d[k + 6] * w; sy += d[k + 7] * w; sz += d[k + 8] * w;
        }
        o.position.set(-px, py, pz);
        // unity applies Z, then X, then Y: three's 'YXZ' order. then mirror X.
        _fe.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), 'YXZ');
        _fq.setFromEuler(_fe);
        o.quaternion.set(_fq.x, -_fq.y, -_fq.z, _fq.w);
        o.scale.set(sx, sy, sz);
      }
    });
  }
}

// --- eyes on the camera -------------------------------------------------------------------
//
// like the game's EyeTraceObject: each iris bone slides along its face's XRange / YRange offsets
// (a full look sideways / up, rates -1..1), eased by DELAY_RATE_BASE per 60 Hz frame. how far
// off-axis the camera has to be for a full look (EYE_MAX_*) is picked here.

const EYE_MAX_H = THREE.MathUtils.degToRad(30), EYE_MAX_V = THREE.MathUtils.degToRad(20);
const EYE_DELAY = 0.85;
let eyeTrace = null;   // per eye: { bone, rest (head-local position), x, y (Unity offsets), off }

function bindEyeTrace() {
  eyeTrace = null;
  const names = face?.eye.names || [], xi = names.indexOf('XRange'), yi = names.indexOf('YRange');
  if (xi < 0 || yi < 0) return;
  eyeTrace = face.eye.groups.flatMap((g, gi) => {
    const b = g.bones.findIndex(n => /^Eye_[LR]$/.test(n));
    const bone = b >= 0 && faceBones.eye[gi][b];
    if (!bone || !current.rest.has(bone)) return [];
    // a positive rate looks to her right (unity +x) / up, whichever way each eye's data points
    const vec = (i, axis) => { const v = g.shapes[i].slice(b * 9, b * 9 + 3); const s = Math.sign(v[axis]) || 1; return v.map(c => c * s); };
    return [{ bone, rest: current.rest.get(bone)[0], x: vec(xi, 0), y: vec(yi, 1), off: new THREE.Vector3() }];
  });
}

const _hInv = new THREE.Matrix4(), _cam = new THREE.Vector3(), _d = new THREE.Vector3(), _want = new THREE.Vector3();
/** After applyFace: the iris bones toward the camera. dt in seconds (0: no easing). */
function applyEyeTrace(dt) {
  if (!eyeTrace?.length) return;
  const on = $('#lookCam').value !== 'off';
  const head = current.named.Head ??= current.root.getObjectByName('Head') || null;
  if (!head) return;
  head.updateWorldMatrix(true, false);
  _cam.copy(camera.position).applyMatrix4(_hInv.copy(head.matrixWorld).invert());   // head space: +z ahead, +x her left
  const k = dt > 0 ? 1 - Math.pow(EYE_DELAY, dt * 60) : 1;
  for (const e of eyeTrace) {
    _want.set(0, 0, 0);
    _d.copy(_cam).sub(e.rest);
    if (on && _d.z > 0) {
      const rx = THREE.MathUtils.clamp(Math.atan2(-_d.x, _d.z) / EYE_MAX_H, -1, 1);
      const ry = THREE.MathUtils.clamp(Math.atan2(_d.y, Math.hypot(_d.x, _d.z)) / EYE_MAX_V, -1, 1);
      // unity offsets -> three: x mirrored
      _want.set(-(e.x[0] * rx + e.y[0] * ry), e.x[1] * rx + e.y[1] * ry, e.x[2] * rx + e.y[2] * ry);
    }
    e.off.lerp(_want, k);
    e.bone.position.add(e.off);
  }
}
// the head, like the game's TurnController: at most MAX_HEAD_ANGLE (30°) from where the motion
// has it, shared between neck and head (cut-in timelines offset both), the eyes cover the rest.
// the up/down limit, the share and the easing are picked here.
const HEAD_MAX_YAW = THREE.MathUtils.degToRad(30), HEAD_MAX_PITCH = THREE.MathUtils.degToRad(20);
const HEAD_BEHIND = THREE.MathUtils.degToRad(120);   // camera further round than this: face ahead
const NECK_SHARE = 0.4;
const look = { yaw: 0, pitch: 0, set: new Map() };   // set: bone -> { base, applied } from the last frame
const UP = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3(), _t = new THREE.Vector3(), _axis = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

// bones the motion didn't set since still hold the last turn, so back to base
function liftHeadTurn() {
  for (const [b, s] of look.set) if (b.quaternion.equals(s.applied)) b.quaternion.copy(s.base);
  look.set.clear();
}

/** Before applyEyeTrace: neck and head turned toward the camera. dt in seconds (0: no easing). */
function applyHeadTurn(dt) {
  const neck = current.named.Neck ??= current.root.getObjectByName('Neck') || null;
  const head = current.named.Head ??= current.root.getObjectByName('Head') || null;
  if (!neck || !head) return;
  liftHeadTurn();
  head.updateWorldMatrix(true, false);
  _f.set(0, 0, 1).transformDirection(head.matrixWorld);   // where the motion has her face
  _t.copy(camera.position).sub(head.getWorldPosition(_axis)).normalize();
  let yaw = 0, pitch = 0;
  if ($('#lookCam').value === 'head') {
    const fx = _f.x, fz = _f.z, tx = _t.x, tz = _t.z;
    const raw = Math.atan2(fz * tx - fx * tz, fx * tx + fz * tz);   // + toward her left
    if (Math.abs(raw) < HEAD_BEHIND) {
      yaw = THREE.MathUtils.clamp(raw, -HEAD_MAX_YAW, HEAD_MAX_YAW);
      pitch = THREE.MathUtils.clamp(Math.asin(_t.y) - Math.asin(_f.y), -HEAD_MAX_PITCH, HEAD_MAX_PITCH);
    }
  }
  const k = dt > 0 ? 1 - Math.pow(EYE_DELAY, dt * 60) : 1;
  look.yaw += (yaw - look.yaw) * k;
  look.pitch += (pitch - look.pitch) * k;
  if (Math.abs(look.yaw) < 1e-4 && Math.abs(look.pitch) < 1e-4) return;
  _axis.set(_f.x, 0, _f.z).normalize().cross(UP).normalize();   // a positive turn about it looks up
  for (const [bone, share] of [[neck, NECK_SHARE], [head, 1 - NECK_SHARE]]) {
    const base = bone.quaternion.clone();
    bone.updateWorldMatrix(true, false);
    _q1.setFromAxisAngle(UP, look.yaw * share).multiply(_q2.setFromAxisAngle(_axis, look.pitch * share));
    bone.getWorldQuaternion(_q2);
    bone.parent.getWorldQuaternion(_q3).invert();
    bone.quaternion.copy(_q3.multiply(_q1.multiply(_q2)));
    look.set.set(bone, { base, applied: bone.quaternion.clone() });
  }
  head.updateWorldMatrix(true, false);
}
$('#lookCam').value = store.get('lookCam', store.get('eyeCam', false) ? 'eyes' : 'off');
$('#lookCam').onchange = () => store.set('lookCam', $('#lookCam').value);

// --- outfit helper bones ---------------------------------------------------------------
//
// some outfits have helper bones (Tp_*) the game moves every frame from another bone's angle
// (the body's transform_process_data, run by the game's TransformExpression_AddPosition_FromAngle):
// one Euler axis of the source's rotation relative to its rest, mapped from one angle to another
// onto 0..1, offsets the helper from rest by up to the given position, rotation or scale.
// unity space, converted here.

function bindProcess(list) {
  const find = n => current.root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
  const out = new Map();   // helper bone -> its entries, each with its source bone
  for (const e of list) {
    const obj = find(e.target), src = find(e.source);
    if (!obj || !src || !current.rest.has(obj) || !current.rest.has(src)) continue;
    if (!out.has(obj)) out.set(obj, []);
    out.get(obj).push({ ...e, src, srcRestInv: current.rest.get(src)[1].clone().invert() });
  }
  return out;
}

const _pq = new THREE.Quaternion(), _pe = new THREE.Euler();
/** One Euler axis (unity's order and axes) of the source's rotation away from its rest,
 *  as -180..180. */
function unityAngle(e) {
  _pq.multiplyQuaternions(e.srcRestInv, e.src.quaternion);
  _pq.set(_pq.x, -_pq.y, -_pq.z, _pq.w);
  _pe.setFromQuaternion(_pq, 'YXZ');   // Unity applies Z, then X, then Y
  return THREE.MathUtils.radToDeg(e.axis === 0 ? _pe.x : e.axis === 1 ? _pe.y : _pe.z);
}

function applyProcess() {
  if (current === active) pose.applyEdits();   // hand-made joint changes first: the helper bones follow the final angles
  if (!current?.process) return;
  for (const [obj, list] of current.process) {
    const sum = { position: null, rotation: null, scale: null };
    for (const e of list) {
      const span = e.to - e.from;
      const k = span ? THREE.MathUtils.clamp((unityAngle(e) - e.from) / span, 0, 1) : 0;
      const v = (sum[e.kind] ??= [0, 0, 0]);
      for (let i = 0; i < 3; i++) v[i] += e.value[i] * k;
    }
    const [p, q, s] = current.rest.get(obj);
    if (sum.position) obj.position.set(p.x - sum.position[0], p.y + sum.position[1], p.z + sum.position[2]);
    if (sum.scale) obj.scale.set(s.x + sum.scale[0], s.y + sum.scale[1], s.z + sum.scale[2]);
    if (sum.rotation) {
      const r = sum.rotation.map(THREE.MathUtils.degToRad);
      _pq.setFromEuler(_pe.set(r[0], r[1], r[2], 'YXZ'));
      obj.quaternion.copy(q).multiply(_pq.set(_pq.x, -_pq.y, -_pq.z, _pq.w));
    }
  }
}

// --- camera -------------------------------------------------------------------------------

function bonePos(name, fallback) {
  if (!current) return fallback;
  const o = current.named[name] ??= current.root.getObjectByName(name) || null;
  return o ? o.getWorldPosition(new THREE.Vector3()) : fallback;
}

function setCamera(preset) {
  shot.cam = preset;
  radio('#cams .chip', $(`#cams .chip[data-cam="${preset}"]`));
  if (!current) return;
  current.root.updateMatrixWorld(true);
  const head = bonePos('Head', new THREE.Vector3(0, 1.45, 0));
  const chest = bonePos('Chest', new THREE.Vector3(0, 1.15, 0));
  const floor = bonePos('Position', new THREE.Vector3()).y;
  const top = head.y + 0.2;
  let target, span;
  if (current.manifest.mini) {
    // chibis are mostly head: frame from the posed model's real top instead of fixed sizes
    const crown = new THREE.Box3().setFromObject(current.root, true).max.y;
    if (preset === 'face') { target = new THREE.Vector3(head.x, (head.y + crown) / 2, head.z); span = (crown - head.y) * 1.2; }
    else if (preset === 'upper') { target = new THREE.Vector3(head.x, (chest.y + crown) / 2, head.z); span = (crown - chest.y) * 1.35; }
    else { target = new THREE.Vector3(head.x, (floor + crown) / 2, head.z); span = (crown - floor) * 1.12; }
  } else if (preset === 'face') { target = head.clone().add(new THREE.Vector3(0, 0.08, 0)); span = 0.42; }
  else if (preset === 'upper') { target = chest.clone().add(new THREE.Vector3(0, 0.1, 0)); span = 0.95; }
  else { target = new THREE.Vector3(head.x, (floor + top) / 2, head.z); span = (top - floor) * 1.1; }
  // fit the subject inside the render guide, not the whole viewport
  const g = guideRect();
  const dist = (span / 2 * (g.H / g.h)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0, 0, 1);
  dir.y = Math.max(-0.3, Math.min(0.3, dir.y));
  dir.normalize();
  controls.target.copy(target);
  camera.position.copy(target).add(dir.multiplyScalar(dist));
  controls.update();
  follow.at = followPoint();
}
$$('#cams .chip').forEach(b => {
  b.onclick = () => {
    // a preset also follows what it frames, unless following is off
    if ($('#follow').value !== 'off') setFollow({ full: 'body', upper: 'chest', face: 'head' }[b.dataset.cam]);
    setCamera(b.dataset.cam);
  };
});

// follow: the camera moves with a point on her (eased over FOLLOW_LAG seconds) and keeps its
// angle, distance and any pan.
const FOLLOW_LAG = 0.12;
const FOLLOW_BONES = { body: 'Hip', chest: 'Chest', head: 'Head' };
const JUMP = 0.5;            // the root moving this far in one frame is a cut (a loop starting over)
const follow = { at: null, root: null };

function followPoint() {
  const bone = FOLLOW_BONES[$('#follow').value];
  return bone ? bonePos(bone, null) : null;
}

function setFollow(mode) {
  $('#follow').value = mode;
  store.set('followPt', mode);
  follow.at = followPoint();
}

/** The same for an uma that isn't followed. */
function jumped(m) {
  const p = bonePos('Position', null);
  const j = !!(p && m.lastRoot && p.distanceTo(m.lastRoot) > JUMP);
  m.lastRoot = p;
  return j;
}

/** True when the root jumped since the last call. */
function rootJumped() {
  const p = bonePos('Position', null);
  const jumped = !!(p && follow.root && p.distanceTo(follow.root) > JUMP);
  follow.root = p;
  return jumped;
}

/** Moves the camera dt seconds further after her. snap: all the way at once. */
function followCamera(dt, snap) {
  const p = current && followPoint();
  if (!p) { follow.at = null; return; }
  if (!follow.at) { follow.at = p; return; }
  const d = p.sub(follow.at).multiplyScalar(snap ? 1 : 1 - Math.exp(-dt / FOLLOW_LAG));
  follow.at.add(d);
  camera.position.add(d);
  controls.target.add(d);
}
$('#follow').value = store.get('followPt', 'body');
$('#follow').onchange = () => setFollow($('#follow').value);
$('#fov').oninput = () => {
  // keep the framing: move the camera so the subject stays the same size
  const old = camera.fov, nu = parseFloat($('#fov').value);
  const k = Math.tan(THREE.MathUtils.degToRad(old / 2)) / Math.tan(THREE.MathUtils.degToRad(nu / 2));
  camera.position.sub(controls.target).multiplyScalar(k).add(controls.target);
  camera.fov = nu;
  camera.updateProjectionMatrix();
};

// --- look -------------------------------------------------------------------------------------

function updateLight() {
  const az = THREE.MathUtils.degToRad(parseFloat($('#lightAz').value));
  const el = THREE.MathUtils.degToRad(parseFloat($('#lightEl').value));
  const d = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  if (!$('#lightFollow').checked) d.transformDirection(camera.matrixWorldInverse);
  U.lightDir.value.copy(d).normalize();
}
$('#toonStep').oninput = () => { U.toonStep.value = parseFloat($('#toonStep').value); };
$('#bright').oninput = () => { U.bright.value = parseFloat($('#bright').value); };
$('#rim').oninput = () => { U.rim.value = parseFloat($('#rim').value); };
$('#outlineW').oninput = () => { U.outlineW.value = parseFloat($('#outlineW').value); };
$('#outline').onchange = () => {
  for (const m of cast) m.outlines.forEach(o => { o.visible = $('#outline').checked; });
  props.setOutlines($('#outline').checked);
};
// the finishing pass's settings (post.js), kept between sessions
Object.assign(finish, store.get('finish', {}));
for (const [id, key] of [['#postLines', 'lines'], ['#postLineDist', 'lineDist'], ['#postBloom', 'bloom'], ['#postSat', 'sat'],
                         ['#postContrast', 'contrast'], ['#postWarm', 'warm'], ['#postVignette', 'vignette']]) {
  $(id).value = finish[key];
  $(id).oninput = () => { finish[key] = parseFloat($(id).value); store.set('finish', finish); };
}
$('#postOn').checked = finish.on;
$('#postOn').onchange = () => { finish.on = $('#postOn').checked; store.set('finish', finish); };
$('#postReset').onclick = () => {
  Object.assign(finish, { on: true, lines: 0.8, lineDist: 40, bloom: 0.2, sat: 1.12, contrast: 1.06, warm: 0.3, vignette: 0.35 });
  store.set('finish', finish);
  for (const [id, key] of [['#postLines', 'lines'], ['#postLineDist', 'lineDist'], ['#postBloom', 'bloom'], ['#postSat', 'sat'],
                           ['#postContrast', 'contrast'], ['#postWarm', 'warm'], ['#postVignette', 'vignette']]) $(id).value = finish[key];
  $('#postOn').checked = true;
};
$('#eyeCell').onchange = () => U.eyeCell.value.set(+$('#eyeCell').value, 0);
$('#eyeHi').oninput = () => { U.eyeHi.value = parseFloat($('#eyeHi').value); };
$('#physics').onchange = () => { for (const m of cast) m.springs?.setEnabled($('#physics').checked); };

// the springs, from the rest skeleton like the game binds them. with body collisions on, hair and
// ties also get colliders fitted to her outfit (bodyfit.js), so changing those makes new springs
function newSprings() {
  const mine = current;
  const body = $('#bodyCol').checked
    ? { shapes: mine.bodyFit ??= fitBody(mine.root), clearance: parseFloat($('#bodyGap').value) / 1000 } : null;
  GameSprings.create(mine.root, mine.rest, mine.pack, body).then(sp => {
    if (!cast.includes(mine) || !sp) return;
    mine.springs = sp;
    sp.setEnabled($('#physics').checked);
  }).catch(e => toast('Physics: ' + e.message, true));
}
$('#bodyCol').checked = store.get('bodyCol', true);
$('#bodyGap').value = store.get('bodyGap', 0);
$('#bodyCol').onchange = () => { store.set('bodyCol', $('#bodyCol').checked); if (current?.manifest.physics) newSprings(); };
$('#bodyGap').onchange = () => { store.set('bodyGap', +$('#bodyGap').value); if (current?.manifest.physics && $('#bodyCol').checked) newSprings(); };

/** The color to clear to, 'picture', 'stage', or '' for transparent. */
function background() {
  const pic = shot.bg === 'picture', set = shot.bg === 'stage';
  const color = shot.bg === 'custom' ? $('#bgColor').value : pic || set ? '' : shot.bg;
  $('#bgColor').style.display = shot.bg === 'custom' ? '' : 'none';
  $('#bgPicCtl').style.display = pic ? '' : 'none';
  $('#bgStageCtl').style.display = set ? '' : 'none';
  scene.background = pic && bgPic.tex ? bgPic.tex : null;
  stage.classList.toggle('solid', !!color);
  stage.style.setProperty('--stage-color', color || 'transparent');
  showStage();
  return pic && bgPic.tex ? 'picture' : set && liveStage.group ? 'stage' : color;
}

// --- places -------------------------------------------------------------------------------------
//
// a whole place from the game around her (stage.js): a concert stage, a racecourse, Tracen, a story
// or cut-in set... converted the first time it's picked, and again for another season, weather or
// time of day where the place has those. the picker shows a preview of the ones already opened
// (rendered here, saved by the server).

const PLACE_KINDS = [['live', 'Concerts'], ['race', 'Racecourses'], ['home', 'Tracen'], ['set', 'Story sets'],
                     ['cutin', 'Cut-ins'], ['gacha', 'Gacha'], ['mini', 'Chibi']];
const CONDS = [
  ['#placeSeason', 'Season', { 1: 'Spring', 2: 'Summer', 3: 'Autumn', 4: 'Winter', 5: 'Cherry blossom' }],
  ['#placeWeather', 'Weather', { 1: 'Sunny', 2: 'Cloudy', 3: 'Rainy', 4: 'Snowy' }],
  ['#placeTime', 'Time', { 1: 'Morning', 2: 'Day', 3: 'Evening', 4: 'Night' }],
];
// concert stages were remembered by number before there were other places
const placeId = id => /^\d+$/.test(id) ? 'live:' + id : id;
const liveStage = { id: placeId(store.get('stageId', '')), group: null, items: null };
const condOf = id => store.get('placeConds', {})[id] || [0, 0, 0];
const altOf = id => store.get('placeAlts', {})[id] || null;

async function placeItems() {
  liveStage.items ??= (await getJson('/api/stages', null)).items;
  return liveStage.items;
}

function showStage() {
  const on = shot.bg === 'stage' && !!liveStage.group;
  if (liveStage.group) liveStage.group.visible = on;
  // skies and far stands are hundreds of metres out
  const near = on ? 0.1 : 0.03, far = on ? 3000 : 100;
  if (camera.far !== far) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
  stageShown(on);
}

async function openStage(id, cond = condOf(id), alt = altOf(id)) {
  const item = (await placeItems()).find(it => it.id === id);
  if (!item) throw new Error('That place is not downloaded');
  const info = await post('/api/stage/load', { id, cond, alt }, `Building ${item.name}…`);
  const group = await busy('Loading the place…', loadStage(info, renderer));
  if (liveStage.group) {
    scene.remove(liveStage.group);
    disposeGroup(liveStage.group);
  }
  liveStage.group = group;
  liveStage.id = id;
  store.set('stageId', id);
  store.set('placeConds', { ...store.get('placeConds', {}), [id]: cond });
  store.set('placeAlts', { ...store.get('placeAlts', {}), [id]: alt });
  scene.add(group);
  showParts(group, stageParts());
  stageLoaded(group, id);
  anim.touch();
  $('#bgStageName').textContent = item.name;
  $('#bgStageThumb').src = `/data/_stages/${item.dir}/thumb.jpg`;
  // the season / weather / time this place comes in, the rest of the controls it has parts for
  CONDS.forEach(([sel, any, names], i) => {
    const el = $(sel);
    el.innerHTML = '';
    el.add(new Option(any, 0));
    for (const v of item.axes[i]) el.add(new Option(names[v] || v, v));
    el.value = cond[i];
    el.style.display = item.axes[i].length ? '' : 'none';
  });
  // whole alternative versions of the place (other decorations): numbered, the game has no names
  const alts = item.alts || [];
  $('#placeAlt').innerHTML = '';
  alts.forEach((a, i) => $('#placeAlt').add(new Option(`Version ${i + 1}`, a)));
  $('#placeAlt').value = alts.includes(alt) ? alt : alts[0] || '';
  $('#placeAlt').style.display = alts.length > 1 ? '' : 'none';
  $('#placeConds').style.display = item.axes.some(a => a.length) || alts.length > 1 ? '' : 'none';
  const kinds = partKinds(group);
  $('#stageLightsRow').style.display = kinds.has('lights') ? '' : 'none';
  $('#stageCrowdRow').style.display = kinds.has('crowd') ? '' : 'none';
  $('#stageFxRow').style.display = kinds.has('effects') ? '' : 'none';
  background();
  if (!item.thumb) stageThumb(item);
}
CONDS.forEach(([sel]) => {
  $(sel).onchange = () => {
    if (!liveStage.id) return;
    openStage(liveStage.id, CONDS.map(([s]) => +$(s).value)).catch(e => toast(e.message, true));
  };
});
$('#placeAlt').onchange = () => {
  if (liveStage.id) openStage(liveStage.id, condOf(liveStage.id), $('#placeAlt').value).catch(e => toast(e.message, true));
};

/** Another place to mix into the one showing (stagedit.js adds it): converted and loaded on its own. */
async function loadExtraPlace(id, cond, alt) {
  const item = (await placeItems()).find(it => it.id === id);
  if (!item) throw new Error('That place is not downloaded');
  const info = await post('/api/stage/load', { id, cond, alt }, `Building ${item.name}…`);
  return { group: await busy('Loading the place…', loadStage(info, renderer)), item };
}

function disposeGroup(g) {
  g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.lightMap?.dispose(); o.material.dispose(); } });
}

/** Places were added or taken out: the switches and beams cover them too. */
function extrasChanged() {
  const group = liveStage.group;
  if (!group) return;
  group.userData.beams = null;
  showParts(group, stageParts());
  const kinds = partKinds(group);
  $('#stageLightsRow').style.display = kinds.has('lights') ? '' : 'none';
  $('#stageCrowdRow').style.display = kinds.has('crowd') ? '' : 'none';
  $('#stageFxRow').style.display = kinds.has('effects') ? '' : 'none';
}

/** A small picture of the place for the picker: a stage from the crowd, anywhere else the view. */
function stageThumb(item) {
  const W = 320, H = 180;
  let cam;
  if (item.kind === 'live') {
    cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 3000);
    cam.position.set(0, 4, 18);
    cam.lookAt(0, 3, -2);
  } else {
    cam = new THREE.PerspectiveCamera(Math.max(camera.fov, 40), W / H, 0.1, 3000);
    cam.position.copy(camera.position);
    cam.quaternion.copy(camera.quaternion);
  }
  cam.updateMatrixWorld();
  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  props.gizmo(false);
  stageGizmo(false);
  pose.gizmo(false);
  liveStage.group.visible = true;   // picked before the background switches to it
  faceCamera(liveStage.group, cam);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, cam);
  showStage();
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 0);
  props.gizmo(true);
  stageGizmo(true);
  pose.gizmo(true);
  rt.dispose();
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  cv.getContext('2d').putImageData(img, 0, 0);
  post('/api/stage/thumb', { id: item.id, jpg: cv.toDataURL('image/jpeg', 0.85) }, null).then(() => {
    item.thumb = true;
    $('#bgStageThumb').src = `/data/_stages/${item.dir}/thumb.jpg?` + Date.now();
  }).catch(() => {});
}

/** The place picker: resolves to a place id, or null when closed. */
async function pickPlace(title = 'Choose a place') {
  const items = await placeItems();
  const kinds = PLACE_KINDS.filter(([k]) => items.some(it => it.kind === k));
  let tab = store.get('placeTab', 'live');
  if (!kinds.some(([k]) => k === tab)) tab = kinds[0]?.[0];
  let done;
  const picked = new Promise(r => { done = r; });
  const fill = () => {
    const find = $('#placeFilter').value.trim().toLowerCase();
    radio('#placeTabs .chip', $(`#placeTabs .chip[data-kind="${tab}"]`));
    const grid = $('#stageGrid');
    grid.innerHTML = '';
    // searching looks through every kind
    for (const it of items.filter(it => find ? it.name.toLowerCase().includes(find) : it.kind === tab)) {
      const b = document.createElement('button');
      b.className = 'tile wide';
      b.innerHTML = '<img alt=""><span></span>';
      b.querySelector('span').textContent = it.name + (it.id === liveStage.id ? ' · current' : '');
      if (it.thumb) b.querySelector('img').src = `/data/_stages/${it.dir}/thumb.jpg`;
      b.onclick = () => done(it.id);
      grid.appendChild(b);
    }
    if (!grid.children.length) {
      grid.innerHTML = items.length ? '<div class="empty">Nothing matches.</div>'
        : '<div class="empty">No places downloaded yet. The game fetches them as you play.</div>';
    }
  };
  $('#placeTabs').innerHTML = '';
  for (const [k, label] of kinds) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.kind = k;
    b.textContent = label;
    b.onclick = () => { tab = k; store.set('placeTab', k); $('#placeFilter').value = ''; fill(); };
    $('#placeTabs').appendChild(b);
  }
  $('#placeFilter').value = '';
  $('#placeFilter').oninput = fill;
  fill();
  $('#stagePickerTitle').textContent = title;
  $('#stagePicker').style.display = 'block';
  $('#stagePickerClose').onclick = () => done(null);
  $('#stagePicker').onmousedown = e => { if (e.target.id === 'stagePicker') done(null); };
  const id = await picked;
  $('#stagePicker').style.display = 'none';
  return id;
}

async function chooseStage() {
  const id = await pickPlace();
  if (!id) return false;
  await openStage(id).catch(e => { toast(e.message, true); throw e; });
  return true;
}
$('#bgStageChange').onclick = () => chooseStage().catch(() => {});
const stageParts = () => ({ lights: $('#stageLights').value / 100, crowd: $('#stageCrowd').checked, effects: $('#stageFx').checked });
$('#stageLights').value = store.get('stageLights', 40);
$('#stageCrowd').checked = store.get('stageCrowd', true);
$('#stageLights').oninput = () => { store.set('stageLights', +$('#stageLights').value); if (liveStage.group) showParts(liveStage.group, stageParts()); };
$('#stageFx').checked = store.get('stageFx', false);
for (const [id, key] of [['#stageCrowd', 'stageCrowd'], ['#stageFx', 'stageFx']]) {
  $(id).onchange = () => { store.set(key, $(id).checked); if (liveStage.group) showParts(liveStage.group, stageParts()); };
}

// a picture behind her: cover-fitted to the render frame, then zoomed, panned and optionally
// blurred (baked into the texture).
const bgPic = { url: store.get('bgUrl', ''), zoom: store.get('bgZoom', 1), x: store.get('bgX', 0), y: store.get('bgY', 0),
                blur: store.get('bgBlur', 0), img: null, tex: null, aspect: 16 / 9 };

async function loadBgPicture() {
  const url = bgPic.url;
  $('#bgPicName').textContent = pictureName(url);
  $('#bgPicThumb').src = url.replace(/^\/api\/bg\/(.+)\.png$/, '/api/bg/thumb/$1.jpg');
  const img = new Image();
  img.src = url;
  await img.decode();
  if (url !== bgPic.url) return;
  bgPic.img = img;
  bgPic.aspect = img.naturalWidth / img.naturalHeight;
  buildBgTexture();
}

function buildBgTexture() {
  const img = bgPic.img;
  if (!img) return;
  const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  if (bgPic.blur > 0) {
    // over the sharp copy, so the edges don't fade to transparent
    g.filter = `blur(${bgPic.blur * c.width / 1000}px)`;
    g.drawImage(img, 0, 0, c.width, c.height);
  }
  bgPic.tex?.dispose();
  bgPic.tex = new THREE.CanvasTexture(c);
  bgPic.tex.colorSpace = THREE.NoColorSpace;
  // past the frame guide (dimmed in the view, never rendered) the picture is mirrored
  bgPic.tex.wrapS = bgPic.tex.wrapT = THREE.MirroredRepeatWrapping;
  background();
}

/** Cover-fit for the render frame. The view shows the same picture inside the guide and
 *  carries it on past the guide's edges. */
function placeBg(frameOnly) {
  const t = bgPic.tex;
  if (!t) return;
  const g = guideRect(), aspect = g.w / g.h;
  let rx = 1, ry = 1;
  if (bgPic.aspect > aspect) rx = aspect / bgPic.aspect; else ry = bgPic.aspect / aspect;
  rx /= bgPic.zoom; ry /= bgPic.zoom;
  const ox = (1 - rx) / 2 * (1 + bgPic.x), oy = (1 - ry) / 2 * (1 + bgPic.y);
  if (frameOnly) { t.repeat.set(rx, ry); t.offset.set(ox, oy); }
  else { t.repeat.set(rx * g.W / g.w, ry * g.H / g.h); t.offset.set(ox - rx * g.x / g.w, oy - ry * g.y / g.h); }
}

async function chooseBgPicture() {
  const url = await pickImage({ title: 'Background picture', tab: bgPic.url.startsWith('/img/') ? 'mine' : 'bg' });
  if (!url) return false;
  bgPic.url = url;
  store.set('bgUrl', url);
  await busy('Loading background…', loadBgPicture()).catch(e => toast('Could not load that picture: ' + e.message, true));
  return true;
}

function setBg(b) {
  shot.bg = b.dataset.bg;
  store.set('bg', shot.bg);
  radio('#bgs .chip', b);
  background();
}
/** A background by its value: 'stage', 'picture', a colour chip's value or any '#rrggbb'. */
function setBgValue(v) {
  const chip = $(`#bgs .chip[data-bg="${v}"]`);
  if (chip) return setBg(chip);
  shot.bg = v;
  store.set('bg', v);
  background();
}
$$('#bgs .chip').forEach(b => {
  b.onclick = async () => {
    if (b.dataset.bg === 'picture' && !bgPic.tex && !(await chooseBgPicture())) return;
    if (b.dataset.bg === 'stage' && !liveStage.group) {
      const ok = liveStage.id ? await openStage(liveStage.id).then(() => true, () => false) : false;
      if (!ok && !(await chooseStage().catch(() => false))) return;
    }
    setBg(b);
  };
});
$('#bgPicChange').onclick = () => chooseBgPicture();
for (const [id, key] of [['#bgZoom', 'zoom'], ['#bgX', 'x'], ['#bgY', 'y']]) {
  $(id).value = bgPic[key];
  $(id).oninput = () => { bgPic[key] = parseFloat($(id).value); store.set('bg' + key[0].toUpperCase() + key.slice(1), bgPic[key]); };
}
let blurTimer;
$('#bgBlur').value = bgPic.blur;
$('#bgBlur').oninput = () => {
  bgPic.blur = parseFloat($('#bgBlur').value);
  store.set('bgBlur', bgPic.blur);
  clearTimeout(blurTimer);
  blurTimer = setTimeout(buildBgTexture, 60);
};
$('#bgColor').oninput = background;
radio('#bgs .chip', $(`#bgs .chip[data-bg="${shot.bg}"]`));
if (bgPic.url) loadBgPicture().catch(() => {});

// --- framing guide --------------------------------------------------------------------------------

function targetSize() { return shot.size.split('x').map(Number); }

/** The largest rectangle with the render's aspect ratio inside the viewport. */
function guideRect() {
  const W = stage.clientWidth || 1, H = stage.clientHeight || 1;
  const [w, h] = targetSize();
  const a = w / h;
  let gw = W, gh = W / a;
  if (gh > H) { gh = H; gw = H * a; }
  return { x: (W - gw) / 2, y: (H - gh) / 2, w: gw, h: gh, W, H };
}

function updateGuide() {
  const g = $('#frameGuide');
  if (!$('#guide').checked) { g.style.display = 'none'; return; }
  const r = guideRect();
  Object.assign(g.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
}
$('#guide').onchange = updateGuide;
// a preset, or your own width x height (kept even, codecs want that)
const PRESETS = [...$$('#sizes .chip')].map(b => b.dataset.size).filter(s => s !== 'custom');
function useSize(size, custom) {
  shot.size = size;
  store.set('size', size);
  radio('#sizes .chip', $(`#sizes .chip[data-size="${custom ? 'custom' : size}"]`));
  $('#customSize').style.display = custom ? 'flex' : 'none';
  updateGuide();
  setCamera(shot.cam);
}
function customSize() {
  const fit = v => Math.max(16, Math.min(8192, Math.round((+v || 16) / 2) * 2));
  const w = fit($('#sizeW').value), h = fit($('#sizeH').value);
  $('#sizeW').value = w; $('#sizeH').value = h;
  store.set('customSize', `${w}x${h}`);
  return `${w}x${h}`;
}
$$('#sizes .chip').forEach(b => {
  b.onclick = () => {
    if (b.dataset.size !== 'custom') return useSize(b.dataset.size, false);
    useSize(customSize(), true);
  };
});
$('#sizeW').onchange = $('#sizeH').onchange = () => useSize(customSize(), true);
{
  const [w, h] = store.get('customSize', shot.size).split('x');
  $('#sizeW').value = w; $('#sizeH').value = h;
  const custom = !PRESETS.includes(shot.size);
  radio('#sizes .chip', $(`#sizes .chip[data-size="${custom ? 'custom' : shot.size}"]`));
  $('#customSize').style.display = custom ? 'flex' : 'none';
}

// --- rendering frames ----------------------------------------------------------------------------

/** Render what is inside the guide at (w x h) * ss. Returns straight-alpha RGBA, rows top-down. */
let frameChain = null, liveChain = null;
function renderFrame(w, h, ss = 1) {
  const RW = w * ss, RH = h * ss;
  const g = guideRect();
  const savedAspect = camera.aspect;
  camera.aspect = g.W / g.H;
  camera.setViewOffset(g.W, g.H, g.x, g.y, g.w, g.h);
  camera.updateProjectionMatrix();
  updateLight();
  const bg = background();
  const post = finish.on && !!bg;
  const rt = new THREE.WebGLRenderTarget(RW, RH, { samples: post ? 0 : 4, stencilBuffer: true });
  placeBg(true);
  faceCamera(liveStage.group, camera);
  props.gizmo(false);
  stageGizmo(false);
  pose.gizmo(false);
  renderer.setClearColor(bg && bg !== 'picture' && bg !== 'stage' ? new THREE.Color(bg) : 0x000000, bg ? 1 : 0);
  if (post) {
    // the finishing pass (post.js), kept for the size: a video draws hundreds of frames
    if (!frameChain || frameChain.w !== RW || frameChain.h !== RH) { frameChain?.dispose(); frameChain = makeChain(renderer, scene, camera, RW, RH, false); }
    frameChain.render();
    frameChain.copyTo(rt);
  } else {
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  }
  props.gizmo(true);
  stageGizmo(true);
  pose.gizmo(true);
  const px = new Uint8Array(RW * RH * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, px);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 0);
  rt.dispose();
  camera.clearViewOffset();
  camera.aspect = savedAspect;
  camera.updateProjectionMatrix();
  // GL rows are bottom-up and MSAA edges come back premultiplied, ffs. fix both
  const out = new Uint8ClampedArray(RW * RH * 4);
  for (let y = 0; y < RH; y++) {
    const src = (RH - 1 - y) * RW * 4, dst = y * RW * 4;
    for (let x = 0; x < RW * 4; x += 4) {
      const a = px[src + x + 3];
      const k = a > 0 && a < 255 ? 255 / a : 1;
      out[dst + x] = px[src + x] * k;
      out[dst + x + 1] = px[src + x + 1] * k;
      out[dst + x + 2] = px[src + x + 2] * k;
      out[dst + x + 3] = a;
    }
  }
  return { data: out, width: RW, height: RH, bg };
}

function toCanvas(frame, w, h) {
  const big = document.createElement('canvas');
  big.width = frame.width; big.height = frame.height;
  big.getContext('2d').putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  if (frame.width === w && frame.height === h) return big;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const c = out.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(big, 0, 0, w, h);
  return out;
}

function maxSupersample(w, h) {
  const gl = renderer.getContext();
  const maxDim = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
  let ss = 2;
  while (ss > 1 && Math.max(w, h) * ss > maxDim) ss--;
  return ss;
}

const fileName = () => {
  const pose = current.action ? poseTitle.replace(`${current.name} · `, '') : 'rest';
  return `${current.name} - ${pose} - ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
};
const openSaved = () => post('/api/open', { what: 'renders' }).catch(() => {});

async function savePNG() {
  if (!current) return openPicker();
  const [w, h] = targetSize();
  const frame = renderFrame(w, h, $('#ssaa').checked ? maxSupersample(w, h) : 1);
  let out = toCanvas(frame, w, h);
  if ($('#crop').checked && !frame.bg) out = cropToContent(out);
  await post('/api/render', { name: fileName(), png: out.toDataURL('image/png') });
  toast(`Saved ${out.width}×${out.height} PNG`, false, ['Show', openSaved]);
}

function cropToContent(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

$('#render').onclick = () => {
  $('#render').disabled = true;
  savePNG().catch(e => toast(e.message, true)).finally(() => { $('#render').disabled = false; });
};
$('#openRenders').onclick = openSaved;

// --- video -----------------------------------------------------------------------------------------
//
// frame-exact: each frame is posed at its own time step (motion, face, physics), rendered at
// the output size and streamed to ffmpeg, so the result is smooth no matter how fast this
// machine draws.

function chipGroup(sel, attr, key, storeKey, cast = v => v) {
  $$(`${sel} .chip`).forEach(b => {
    b.onclick = () => { video[key] = cast(b.dataset[attr]); if (storeKey) store.set(storeKey, video[key]); radio(`${sel} .chip`, b); };
  });
  radio(`${sel} .chip`, $(`${sel} .chip[data-${attr}="${video[key]}"]`));
}
chipGroup('#vidLen', 'len', 'len', null);
chipGroup('#vidFmt', 'fmt', 'fmt', 'vidFmt');
chipGroup('#vidFps', 'fps', 'fps', 'vidFps', Number);

async function recordVideo() {
  const scene = anim.active();
  if (!current || !(current.action || scene)) return toast('Pick a pose to record first', true);
  let [w, h] = targetSize();
  // GIFs this big would be enormous, and codecs want even sizes
  if (video.fmt === 'gif') { const k = Math.min(1, 720 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k); }
  w -= w % 2; h -= h % 2;
  const fps = video.fmt === 'gif' ? Math.min(30, video.fps) : video.fps;
  const clip = current.action?.getClip();
  if (scene) await busy('Loading poses…', loadMotionClips());
  // with an animation "full" is the whole of it, from the start
  const seconds = video.len === 'loop' ? (scene ? anim.length() : clip.duration) : Number(video.len);
  const frames = Math.max(1, Math.round(seconds * fps));
  const { id } = await post('/api/video/start', { w, h, fps, format: video.fmt, name: fileName() });

  recording = { cancel: false };
  const wasPlaying = playing;
  setPlaying(false);
  $('#recBar').style.display = 'flex';
  $('#record').disabled = $('#render').disabled = true;
  const start = video.len === 'loop' ? 0 : scene ? anim.now() : current.action.time;
  const sceneWas = anim.now();
  const step = 1 / fps;
  // following moves the camera along the video, the view gets its own camera back after
  const view = { pos: camera.position.clone(), target: controls.target.clone(), at: follow.at?.clone(), root: follow.root };
  try {
    // the game steps its physics at 60 Hz, each frame shows the tick nearest its time
    const springs = cast.some(m => m.springs?.enabled);
    const stepAll = () => Promise.all(cast.map(m => m.springs?.enabled ? m.springs.step() : null));
    const poseAt = t => {
      if (scene) {
        anim.apply(start + t, true);
        props.animateModels(start + t);
      }
      forCast(m => {
        if (scene) { motionAt(start + t); faceAt(start + t); }
        else if (m.action) {
          m.action.time = (start + t) % (m.action.getClip().duration || 1);
          runMotion(0);
        }
        applyProcess();
        applyFace();
      });
    };
    let ticks = 0;
    if (springs) { for (const m of cast) m.springs?.reset(); poseAt(0); await stepAll(); }
    for (let i = 0; i < frames; i++) {
      if (recording.cancel) throw new Error('cancelled');
      if (springs) {
        const target = Math.round(i * step / TICK);
        while (ticks < target) { ticks++; if (scene) resetOnCut(start + (ticks - 1) * TICK, start + ticks * TICK); poseAt(ticks * TICK); await stepAll(); }
      } else poseAt(i * step);
      forCast(m => m.root.updateMatrixWorld(true));
      const cut = rootJumped();
      if (!anim.hasCamera()) followCamera(step, i === 0 || cut);
      forCast(() => {
        applyHeadTurn(i === 0 ? 0 : step);
        applyEyeTrace(i === 0 ? 0 : step);
      });
      props.updateProps();
      const frame = renderFrame(w, h, 1);
      // a local request can still drop now and then, one lost frame shouldn't end the video
      for (let tries = 1; ; tries++) {
        try {
          await call(`/api/video/frame?id=${id}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: frame.data }, null);
          break;
        } catch (e) {
          if (tries >= 6) throw e;
          await new Promise(r => setTimeout(r, 300 * tries));
        }
      }
      $('#recProg').value = (i + 1) / frames;
      $('#recText').textContent = `${i + 1} / ${frames}`;
    }
    $('#recText').textContent = 'encoding…';
    await post('/api/video/finish', { id });
    toast(video.fmt === 'png' ? `Saved ${frames} PNG frames` : `Saved ${seconds.toFixed(1)} s ${video.fmt.toUpperCase()} video`, false, ['Show', openSaved]);
  } catch (e) {
    await post('/api/video/finish', { id, cancel: true }).catch(() => {});
    if (e.message !== 'cancelled') toast(e.message, true);
  } finally {
    camera.position.copy(view.pos);
    controls.target.copy(view.target);
    Object.assign(follow, { at: view.at || null, root: view.root });
    recording = null;
    if (scene) { anim.seek(sceneWas); anim.apply(sceneWas, true); }
    $('#recBar').style.display = 'none';
    $('#record').disabled = $('#render').disabled = false;
    setPlaying(wasPlaying);
  }
}
$('#record').onclick = () => recordVideo().catch(e => toast(e.message, true));
$('#recCancel').onclick = () => { if (recording) recording.cancel = true; };

// --- model export ------------------------------------------------------------------------------
//
// her and her props as one .glb for blender. the toon shaders don't exist in glTF, so every mesh
// goes out with a plain textured material; outlines and the multiplied blush stay behind.
// "with the motion" bakes what the view shows, frame by frame, into one animation: the clip, face,
// physics, head turn and props, the same steps a video recording takes.

const EXPORT_FPS = 30;

/** A canvas copy of (part of) a texture's image, same orientation as the source. */
function canvasTexture(src, draw) {
  const c = document.createElement('canvas');
  draw(c, c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.flipY = src.flipY;
  t.colorSpace = src.colorSpace;
  return t;
}

/** Background Umas: the recolour (and the accessory cutoff) baked into a copy of the texture, the
 *  same maths as MASK_GLSL in look.js. */
function bakeMask(u, main) {
  const img = main.image, W = img.width, H = img.height;
  const read = (t, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(t.image, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
  const mask = read(u.uMask.value, W, H);
  const triple = u.uHairCut?.value > 0 && u.uTriple ? read(u.uTriple.value, W, H) : null;
  const cols = u.uMaskC.value.map(v => [v.x, v.y, v.z]);
  const w = (v, dir) => Math.min(1, Math.max(0, ((v - 0.5) * dir * 2 - 0.02) / 0.96));
  return canvasTexture(main, (c, x) => {
    c.width = W; c.height = H;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, W, H), px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      let t = [1, 1, 1];
      for (let ch = 0; ch < 3; ch++) {
        const v = mask[i + ch] / 255;
        for (const [k, a] of [[ch * 2, w(v, -1)], [ch * 2 + 1, w(v, 1)]]) if (a > 0) t = t.map((tv, j) => tv + (cols[k][j] - tv) * a);
      }
      px[i] *= t[0]; px[i + 1] *= t[1]; px[i + 2] *= t[2];
      if (triple && triple[i + 2] / 255 < u.uHairCut.value) px[i + 3] = 0;
    }
    x.putImageData(d, 0, 0);
  });
}

/** Plain glTF stand-ins for the shaders: the eye keeps its chosen iris and its shine, eyebrows and
 *  flat props go out unlit, everything else as a textured, fully rough surface. */
function exportMaterial(m) {
  const u = m.uniforms, cut = u.uCutout?.value || 0;
  const masked = u.uHasMask?.value > 0.5 && u.uMain?.value?.image;
  const main = masked ? bakeMask(u, u.uMain.value) : u.uMain?.value || null;
  const hairCut = masked && u.uHairCut?.value > 0 ? 0.5 : 0;
  if (u.eyeCell) {
    const img = main.image, cw = img.width / 4, col = Math.round(u.eyeCell.value.x);
    const iris = canvasTexture(main, (c, x) => { c.width = cw; c.height = img.height; x.drawImage(img, col * cw, 0, cw, img.height, 0, 0, cw, img.height); });   // main is already recoloured for background Umas
    const hi = [u.uHi0.value, u.uHi1.value].filter(t => t?.image?.width > 1);
    let shine = null;
    if (hi.length) {
      shine = canvasTexture(hi[0], (c, x) => {
        c.width = hi[0].image.width; c.height = hi[0].image.height;
        x.globalCompositeOperation = 'lighter';
        hi.forEach(t => x.drawImage(t.image, 0, 0, c.width, c.height));
      });
      shine.channel = 1;
    }
    const k = u.eyeHi.value;
    return new THREE.MeshStandardMaterial({ map: iris, emissive: new THREE.Color(k, k, k), emissiveMap: shine, roughness: 1, metalness: 0 });
  }
  if (u.uTile) {
    // chibi face parts: the chosen tile as a texture offset (both eyes take the first one's)
    const t = main.clone();
    t.offset.set(u.uTile.value.x, u.uTile.value.y);
    t.needsUpdate = true;
    return new THREE.MeshBasicMaterial({ map: t, side: m.side, alphaTest: cut });
  }
  if (!u.uToon) return new THREE.MeshBasicMaterial({ map: main, side: m.side, alphaTest: cut });
  return new THREE.MeshStandardMaterial({ map: main, side: m.side, roughness: 1, metalness: 0, alphaTest: Math.max(cut, hairCut) });
}

async function bakeMotion(nodes) {
  const clip = current.action.getClip();
  const frames = Math.max(2, Math.round(clip.duration * EXPORT_FPS));
  const step = 1 / EXPORT_FPS;
  const keys = nodes.map(() => ({ p: [], q: [], s: [] }));
  const springs = current.springs?.enabled ? current.springs : null;
  const poseAt = t => { current.action.time = t % clip.duration; runMotion(0); applyProcess(); applyFace(); };
  let ticks = 0;
  if (springs) { springs.reset(); poseAt(0); await springs.step(); }
  for (let i = 0; i < frames; i++) {
    if (springs) {
      const target = Math.round(i * step / TICK);
      while (ticks < target) { ticks++; poseAt(ticks * TICK); await springs.step(); }
    } else poseAt(i * step);
    current.root.updateMatrixWorld(true);
    applyHeadTurn(i === 0 ? 0 : step);
    applyEyeTrace(i === 0 ? 0 : step);
    props.updateProps();
    nodes.forEach((n, k) => { keys[k].p.push(...n.position.toArray()); keys[k].q.push(...n.quaternion.toArray()); keys[k].s.push(...n.scale.toArray()); });
  }
  const times = Float32Array.from({ length: frames }, (_, i) => i * step);
  const moves = v => v.some((x, i) => Math.abs(x - v[i % (v.length / frames)]) > 1e-5);
  const tracks = [];
  nodes.forEach((n, k) => {
    if (moves(keys[k].p)) tracks.push(new THREE.VectorKeyframeTrack(`${n.name}.position`, times, keys[k].p));
    if (moves(keys[k].q)) tracks.push(new THREE.QuaternionKeyframeTrack(`${n.name}.quaternion`, times, keys[k].q));
    if (moves(keys[k].s)) tracks.push(new THREE.VectorKeyframeTrack(`${n.name}.scale`, times, keys[k].s));
  });
  return new THREE.AnimationClip(poseTitle.replace(`${current.name} · `, '') || 'motion', frames * step, tracks);
}

async function exportModel() {
  if (!current) return openPicker();
  const withMotion = $('#expMotion').checked && !!current.action;
  const wasPlaying = playing;
  setPlaying(false);
  recording = { cancel: false };
  const keepTime = current.action ? current.action.time : 0;
  const undo = [];
  const info = props.exportInfo();
  const out = new THREE.Group();
  out.name = 'UmaStudio';
  try {
    // plain materials, no outlines or blush, a unique name on everything that moves
    const hidden = new Set([...current.outlines, ...info.props.flatMap(p => p.outlines)]);
    const nodes = [];
    let n = 0;
    for (const root of [current.root, info.group]) {
      root.traverse(o => {
        if (o.isMesh) {
          if (hidden.has(o) || o.material?.blending === THREE.CustomBlending) {
            const v = o.visible; o.visible = false; undo.push(() => { o.visible = v; });
          } else if (o.material?.uniforms) {
            const m = o.material;
            o.material = exportMaterial(m);
            undo.push(() => { o.material.map?.isCanvasTexture && o.material.map.dispose(); o.material.dispose(); o.material = m; });
            // the game's vertex colors are shading data, glTF would multiply them into the texture
            const col = o.geometry.getAttribute('color');
            if (col) { o.geometry.deleteAttribute('color'); undo.push(() => o.geometry.setAttribute('color', col)); }
          }
          return;
        }
        if (!o.name || nodes.some(x => x.name === o.name)) {
          const name = o.name; o.name = `${name || 'node'}_${++n}`; undo.push(() => { o.name = name; });
        }
        nodes.push(o);
      });
    }
    const clip = withMotion ? await busy('Baking the motion…', bakeMotion(nodes)) : null;
    if (current.action) { current.action.time = keepTime; runMotion(0); applyProcess(); applyFace(); }
    props.updateProps();
    const parents = [current.root.parent, info.group.parent];
    out.add(current.root, info.group);
    let glb;
    try {
      glb = await busy('Writing the model…', new GLTFExporter().parseAsync(out, { binary: true, onlyVisible: true, animations: clip ? [clip] : [] }));
    } finally {
      parents[0].add(current.root);
      parents[1].add(info.group);
    }
    await call(`/api/export?name=${encodeURIComponent(fileName())}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: glb }, 'Saving the model…');
    toast(`Saved model${clip ? ' with the motion' : ''} (${(glb.byteLength / 1048576).toFixed(1)} MB)`, false, ['Show', openSaved]);
  } finally {
    undo.reverse().forEach(f => f());
    recording = null;
    setPlaying(wasPlaying);
  }
}
$('#exportModel').onclick = () => exportModel().catch(e => toast(e.message, true));

// --- to blender ----------------------------------------------------------------------------------
//
// the whole scene for blender (blender/uma_scene.py builds the look there: toon shading from the
// game's own maps, outlines, sun shadows, haze, depth of field, glow). into
// Pictures\UmaStudio\blender\<name>\: scene.glb with everything baked over the timeline (every
// uma's motion keys, physics, face and eyes, the props, keyed place parts, the camera), the
// textures blender can't get from a glTF (the shadow colour and shading masks), and scene.json.

async function putFile(dir, path, body) {
  await call(`/api/blender/put?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`,
             { method: 'POST', headers: { 'X-Studio': '1' }, body }, null);
}

/** A texture's picture as png bytes (null when it has none). */
async function texturePng(t) {
  const img = t?.image;
  if (!img || !img.width) return null;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  if (img.data) x.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer ?? img.data), img.width, img.height), 0, 0);
  else x.drawImage(img, 0, 0);
  return await new Promise(r => c.toBlob(r, 'image/png'));
}

async function exportBlender(name = null) {
  if (!current) return openPicker();
  const scene3 = anim.active();
  if (!scene3 && !current.action) return toast('Pick a pose first', true);
  const fps = Math.min(60, video.fps);
  const seconds = scene3 ? anim.length() : current.action.getClip().duration;
  const frames = Math.max(1, Math.round(seconds * fps));
  const dir = (name || fileName()).replace(/[^\w\-. ]/g, '_').slice(0, 100);
  const [W, H] = targetSize();
  const wasPlaying = playing;
  setPlaying(false);
  recording = { cancel: false };
  const sceneWas = anim.now();
  const view = { pos: camera.position.clone(), target: controls.target.clone(), at: follow.at?.clone(), root: follow.root, fov: camera.fov };
  const undo = [];
  const out = new THREE.Group();
  out.name = 'UmaStudio';
  try {
    if (scene3) await busy('Loading poses…', loadMotionClips());
    const info = props.exportInfo();
    const textures = new Map();   // texture -> file name
    const saveTex = async t => {
      if (!t?.image) return null;
      if (!textures.has(t)) {
        const png = await texturePng(t);
        if (!png) return null;
        const name = `tex/${textures.size}.png`;
        await putFile(dir, name, png);
        textures.set(t, name);
      }
      return textures.get(t);
    };
    // the umas' and props' materials: a plain textured one for glTF, the rest by name in extras
    const hidden = new Set([...cast.flatMap(m => m.outlines), ...info.props.flatMap(p => p.outlines)]);
    const roots = [...cast.map(m => m.spot), info.group];
    const nodes = [];
    let n = 0;
    for (const r of roots) {
      const meshes = [];
      r.traverse(o => { if (o.isMesh) meshes.push(o); });
      for (const o of meshes) {
        if (hidden.has(o) || o.material?.blending === THREE.CustomBlending) {
          const v = o.visible; o.visible = false; undo.push(() => { o.visible = v; });
          continue;
        }
        if (!o.material?.uniforms) {
          // an imported model's own material; a prop marked as ground (holder.userData.env) is
          // shaded like the place, without outlines
          let env = false;
          for (let a = o; a && !env; a = a.parent) env = !!a.userData?.env;
          const mm = o.material, had = mm.userData;
          mm.userData = env ? { ...had, env: true } : { ...had, prop: true };
          undo.push(() => { mm.userData = had; });
          continue;
        }
        const m = o.material, u = m.uniforms;
        const plain = exportMaterial(m);
        plain.userData = {
          uma: o.userData.kind || 'prop',   // her parts have a kind; picture cards and boxes don't
          toon: u.uHasToon?.value > 0.5 ? await saveTex(u.uToon.value) : null,
          triple: u.uHasTriple?.value > 0.5 ? await saveTex(u.uTriple.value) : null,
          ctrl: o.userData.tex?._OptionMaskMap ? await saveTex(o.userData.tex._OptionMaskMap) : null,
          cutout: u.uCutout?.value || 0,
        };
        o.material = plain;
        undo.push(() => { o.material.map?.isCanvasTexture && o.material.map.dispose(); o.material.dispose(); o.material = m; });
        const col = o.geometry.getAttribute('color');
        if (col) { o.geometry.deleteAttribute('color'); undo.push(() => o.geometry.setAttribute('color', col)); }
      }
    }
    // the place: unlit in glTF; vertex light at half brightness doubled into the colours, glow
    // (light beams, bulbs) left out
    let placeRoot = null;
    if (shot.bg === 'stage' && liveStage.group) {
      placeRoot = liveStage.group;
      const meshes = [];
      placeRoot.traverse(o => { if (o.isMesh) meshes.push(o); });
      for (const o of meshes) {
        if (!o.visible) continue;
        const m = o.material;
        if (m.blending === THREE.AdditiveBlending || !m.map) {
          if (m.blending === THREE.AdditiveBlending || !m.color) { o.visible = false; undo.push(() => { o.visible = true; }); }
          continue;
        }
        const had = m.userData;
        m.userData = { ...had, env: true };
        undo.push(() => { m.userData = had; });
        const col = o.geometry.getAttribute('color');
        if (col && !m.vertexColors) { o.geometry.deleteAttribute('color'); undo.push(() => o.geometry.setAttribute('color', col)); }
        else if (col && m.vertexColors) {
          const k = Math.max(m.color.r, m.color.g, m.color.b, 1e-3);
          const c2 = col.clone();
          for (let i = 0; i < c2.count; i++) for (let j = 0; j < Math.min(3, c2.itemSize); j++) c2.setComponent(i, j, Math.min(1, c2.getComponent(i, j) * k));
          o.geometry.setAttribute('color', c2);
          const keep = m.color.clone();
          m.color.multiplyScalar(1 / k);
          undo.push(() => { o.geometry.setAttribute('color', col); m.color.copy(keep); });
        }
      }
    }
    // the camera as it renders: the guide's aspect and its vertical view
    const cam = new THREE.PerspectiveCamera(camera.fov, W / H, 0.05, 3000);
    cam.name = 'Camera';
    const g = guideRect();
    // the picture is the guide's part of the view: its vertical angle
    const effFov = () => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * g.h / g.H));
    out.add(cam);

    // every node that may move gets a name of its own
    const named = new Set();
    const unique = o => {
      if (!o.name || named.has(o.name)) { const nm = o.name; o.name = `${nm || 'node'}_${++n}`; undo.push(() => { o.name = nm; }); }
      named.add(o.name);
    };
    for (const r of roots) r.traverse(o => { if (!o.isMesh || o.isSkinnedMesh || o.morphTargetInfluences) { unique(o); nodes.push(o); } });
    const animated = anim.animatedObjects().filter(o => placeRoot && placeRoot.getObjectById(o.id));
    for (const o of animated) { unique(o); nodes.push(o); }
    unique(cam);
    const morphs = [];
    for (const r of roots) r.traverse(o => { if (o.isMesh && o.morphTargetInfluences?.length) morphs.push(o); });

    // walk the timeline like a video does
    const step = 1 / fps;
    const keys = nodes.map(() => ({ p: [], q: [], s: [] }));
    const camKeys = { p: [], q: [], fov: [] };
    const morphKeys = morphs.map(() => []);
    const springs = cast.some(m => m.springs?.enabled);
    const stepAll = () => Promise.all(cast.map(m => m.springs?.enabled ? m.springs.step() : null));
    const start = 0;
    const poseAt = t => {
      if (scene3) { anim.apply(start + t, true); props.animateModels(start + t); }
      forCast(m => {
        if (scene3) { motionAt(start + t); faceAt(start + t); }
        else if (m.action) { m.action.time = (start + t) % (m.action.getClip().duration || 1); runMotion(0); }
        applyProcess();
        applyFace();
      });
    };
    let ticks = 0;
    if (springs) { for (const m of cast) m.springs?.reset(); poseAt(0); await stepAll(); }
    $('#recBar').style.display = 'flex';
    for (let i = 0; i < frames; i++) {
      if (recording.cancel) throw new Error('cancelled');
      if (springs) {
        const target = Math.round(i * step / TICK);
        while (ticks < target) { ticks++; if (scene3) resetOnCut(start + (ticks - 1) * TICK, start + ticks * TICK); poseAt(ticks * TICK); await stepAll(); }
      } else poseAt(i * step);
      forCast(m => m.root.updateMatrixWorld(true));
      const cut = rootJumped();
      if (!anim.hasCamera()) followCamera(step, i === 0 || cut);
      forCast(() => { applyHeadTurn(i === 0 ? 0 : step); applyEyeTrace(i === 0 ? 0 : step); });
      props.updateProps();
      // hidden things go to nothing (glTF has no visibility)
      nodes.forEach((o, k) => {
        keys[k].p.push(...o.position.toArray());
        keys[k].q.push(...o.quaternion.toArray());
        if (o.visible) keys[k].s.push(...o.scale.toArray()); else keys[k].s.push(0, 0, 0);
      });
      camera.updateMatrixWorld();
      camKeys.p.push(...camera.position.toArray());
      camKeys.q.push(...camera.quaternion.toArray());
      camKeys.fov.push(camera.fov);
      morphs.forEach((o, k) => morphKeys[k].push(...o.morphTargetInfluences));
      $('#recProg').value = (i + 1) / frames;
      $('#recText').textContent = `baking ${i + 1} / ${frames}`;
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }
    const times = Float32Array.from({ length: frames }, (_, i) => i * step);
    const moves = (v, w) => v.some((x, i) => Math.abs(x - v[i % w]) > 1e-5);
    const tracks = [];
    nodes.forEach((o, k) => {
      if (moves(keys[k].p, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${o.name}.position`, times, keys[k].p));
      if (moves(keys[k].q, 4)) tracks.push(new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`, times, keys[k].q));
      if (moves(keys[k].s, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${o.name}.scale`, times, keys[k].s));
    });
    tracks.push(new THREE.VectorKeyframeTrack('Camera.position', times, camKeys.p));
    tracks.push(new THREE.QuaternionKeyframeTrack('Camera.quaternion', times, camKeys.q));
    morphs.forEach((o, k) => { unique(o); tracks.push(new THREE.NumberKeyframeTrack(`${o.name}.morphTargetInfluences`, times, morphKeys[k])); });
    const clip = new THREE.AnimationClip('scene', frames * step, tracks);

    // back to the first frame for the file's rest state
    poseAt(0);
    props.updateProps();
    cam.position.fromArray(camKeys.p, 0);
    cam.quaternion.fromArray(camKeys.q, 0);
    cam.fov = effFov();
    // things that come in later are hidden now, and glTF leaves hidden things out: they go in
    // whole, their tracks keep them at nothing until they show
    // (groups only: meshes hidden here are outlines and blush the export leaves out on purpose)
    for (const o of nodes) if (!o.visible && !o.isMesh) { o.visible = true; undo.push(() => { o.visible = false; }); }
    // and keyed parts of the place hidden at the start (the turf before it's laid)
    for (const o of animated) if (!o.visible) { o.visible = true; undo.push(() => { o.visible = false; }); }
    const parents = roots.map(r => r.parent);
    const placeParent = placeRoot?.parent;
    out.add(...roots);
    if (placeRoot) out.add(placeRoot);
    let glb;
    try {
      glb = await busy('Writing the scene…', new GLTFExporter().parseAsync(out, { binary: true, onlyVisible: true, animations: [clip] }));
    } finally {
      roots.forEach((r, i) => parents[i].add(r));
      if (placeRoot) placeParent.add(placeRoot);
      out.remove(cam);
    }
    await busy('Saving…', putFile(dir, 'scene.glb', new Blob([glb])));
    // what the blender script needs besides the file
    const headOf = m => { let h = null; m.root.traverse(o => { if (!h && o.isBone && /^Head(_\d+)?$/.test(o.name)) h = o; }); return h; };
    const focus = cast.map(m => ({ key: m.key, name: m.name, head: headOf(m)?.name || null, root: m.spot.name }));
    const meta = {
      fps, frames, width: W, height: H, fov: effFov(),
      lightAz: parseFloat($('#lightAz').value), lightEl: parseFloat($('#lightEl').value), lightFollowsCamera: $('#lightFollow').checked,
      background: shot.bg === 'stage' ? 'place' : shot.bg || 'transparent', bgColor: shot.bg?.startsWith('#') ? shot.bg : null,
      focusOn: active.key, cast: focus, place: placeRoot ? liveStage.id : null,
      textures: textures.size,
    };
    // a scene file's night tints and flashes, focus pulls and haze
    const sc = anim.sceneInfo();
    if (sc) for (const k of ['fx', 'focusKeys', 'haze']) if (sc[k] !== null && sc[k] !== undefined) meta[k] = sc[k];
    await putFile(dir, 'scene.json', new Blob([JSON.stringify(meta, null, 1)]));
    toast(`Saved for Blender: ${dir}`, false, ['Render in Blender', () => renderBlender(dir)]);
    return dir;
  } finally {
    undo.reverse().forEach(f => f());
    $('#recBar').style.display = 'none';
    recording = null;
    camera.position.copy(view.pos);
    controls.target.copy(view.target);
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    Object.assign(follow, { at: view.at || null, root: view.root });
    if (scene3) { anim.seek(sceneWas); anim.apply(sceneWas, true); }
    setPlaying(wasPlaying);
  }
}

/** Blender renders the exported scene in the background (blender/uma_scene.py); progress in the status bar. */
async function renderBlender(dir, still = false) {
  const { id } = await post('/api/blender/render', { dir, still }, 'Starting Blender…');
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await getJson('/api/blender/status?id=' + id, null);
    if (s.done) {
      if (s.error) return toast('Blender: ' + s.error, true);
      return toast(`Blender finished: ${s.output}`, false, ['Show', openSaved]);
    }
    $('#warm').textContent = s.progress ? `Blender · ${s.progress}` : 'Blender · starting';
  }
}
$('#exportBlender').onclick = async () => {
  const dir = await exportBlender(anim.sceneInfo()?.name || null).catch(e => { if (e.message !== 'cancelled') toast(e.message, true); return null; });
  if (dir && $('#blenderRender').checked) renderBlender(dir).catch(e => toast(e.message, true));
};

// --- loop ----------------------------------------------------------------------------------------

const clock = new THREE.Clock();
let modelClock = 0;     // the models' own animations when nothing is animated
let stepping = false;   // a physics step is out: this frame is drawn once it is back
function draw() {
  props.updateProps();
  pose.updateDots();
  updateLight();
  placeBg(false);
  faceCamera(liveStage.group, camera);
  updateStageEdit();
  if (finish.on && solidBg()) {
    // the view shows the finished look too; the canvas is otherwise see-through over a css colour
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!liveChain) liveChain = makeChain(renderer, scene, camera, size.x, size.y, true);
    else if (liveChain.w !== size.x || liveChain.h !== size.y) liveChain.setSize(size.x, size.y);
    renderer.setClearColor(shot.bg.startsWith('#') || shot.bg === 'custom' ? new THREE.Color(shot.bg === 'custom' ? $('#bgColor').value : shot.bg) : 0x000000, 1);
    liveChain.render();
    renderer.setClearColor(0x000000, 0);
  } else renderer.render(scene, camera);
}

/** A background the frame fills completely (no see-through). */
function solidBg() {
  if (!shot.bg) return false;
  if (shot.bg === 'stage') return !!liveStage.group;
  if (shot.bg === 'picture') return !!bgPic.tex;
  return true;
}
renderer.setAnimationLoop(() => {
  if (recording || stepping) return;   // the recorder drives every frame itself
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  let tick = null;
  // with an animation the scene clock leads: her motion, the keyed things, the models
  const scene = anim.active();
  const speed = current ? current.mixer.timeScale : 1;
  if (scene && playing) anim.advance(dt * speed);
  anim.apply();
  sceneTick();
  modelClock = scene ? anim.now() : modelClock + dt;
  props.animateModels(modelClock);
  if (current) {
    // per uma: the motion (re-evaluated even when paused), the face, the camera after the active
    // one, then the springs on that pose. they keep running while paused, like in the game.
    const ticks = [];
    forCast(m => {
      if (scene) { motionAt(anim.now()); faceAt(anim.now()); }
      else runMotion(playing ? dt : 0);
      applyProcess();
      applyFace();
      m.root.updateMatrixWorld(true);
      const cut = m === active ? rootJumped() : jumped(m);
      if (cut) m.springs?.reset();
      // a keyed camera is the timeline's, paused too
      if (m === active && !(scene && anim.hasCamera())) followCamera(dt, cut);
      applyHeadTurn(dt);
      applyEyeTrace(dt);
      const tk = m.springs?.frame(dt);
      if (tk) ticks.push(tk);
    });
    tick = ticks.length ? Promise.all(ticks) : null;
    updateTime();
  }
  if (!tick) return draw();
  stepping = true;
  tick.catch(e => console.warn(e)).finally(() => { stepping = false; draw(); });
});

// the app window tells the server it is still open
setInterval(() => fetch('/api/ping').catch(() => {}), 5000);
fetch('/api/ping').catch(() => {});

// --- getting ready ------------------------------------------------------------------------------
//
// on start the server fills its caches in the background (uma pictures, pose lists, props,
// background previews). after that the prop previews are drawn here while nothing else is going
// on. progress shows in the top bar.

let pointerHeld = false;
canvas.addEventListener('pointerdown', () => { pointerHeld = true; });
window.addEventListener('pointerup', () => { pointerHeld = false; });

async function followWarmUp() {
  for (;;) {
    const w = await fetch('/api/warm').then(r => r.json()).catch(() => null);
    if (w?.finished) break;
    $('#warm').textContent = w?.total ? `Getting ${w.stage.toLowerCase()} ready · ${w.done} / ${w.total}` : '';
    await new Promise(r => setTimeout(r, 1500));
  }
  await props.warmThumbs((done, total) => {
    $('#warm').textContent = done < total ? `Drawing prop previews · ${done} / ${total}` : '';
  });
  $('#warm').textContent = '';
}

pose.initPose({ scene, camera, canvas, controls, onPick: () => props.propsDebug.select(null) });
props.initProps({ scene, camera, renderer, controls, canvas, current: () => current, libraryClip,
                  members: () => cast, member: key => cast.find(m => m.key === key) || null, activeKey: () => active?.key || 'main',
                  idle: () => !!current && !recording && !pointerHeld, onSelect: p => { if (p) anim.picked('prop'); else anim.touch(); } });
initStageEdit({ scene, camera, canvas, controls, get place() { return place; }, her: () => current?.root,
                members: () => cast.map(m => ({ key: m.key, spot: m.spot, root: m.root, name: m.name })),
                onPick: () => props.propsDebug.select(null),
                onReset: () => { if (liveStage.group) showParts(liveStage.group, stageParts()); },
                pickPlace, loadPlace: loadExtraPlace, placeItem: id => liveStage.items?.find(it => it.id === id),
                condOf, altOf, conds: CONDS, dispose: disposeGroup, onExtras: () => { extrasChanged(); anim.touch(); },
                onPicked: o => { if (o) anim.picked('stage'); else anim.touch(); } });
anim.initAnim({ camera, controls, get place() { return place; }, stagePicked, partLabel, placeId: () => liveStage.id, stageGroup: () => liveStage.group,
                spotOf: key => cast.find(m => m.key === key)?.spot || null, keyOfSpot: o => cast.find(m => m.spot === o)?.key || null,
                activeMember: () => active && { key: active.key, name: active.name, clip: poseKey, title: poseTitle, face: active.facePicked },
                selectedProp: props.selectedProp, propByKey: props.propByKey, propLabel: p => props.propLabel(p),
                onChange: animChanged, onSeek: () => updateTime() });

initScenes({ useSize: size => { if (shot.size !== size) useSize(size, !PRESETS.includes(size)); }, size: () => shot.size,
             setFps: fps => { video.fps = fps; store.set('vidFps', fps); radio('#vidFps .chip', $(`#vidFps .chip[data-fps="${fps}"]`)); },
             stage: () => liveStage, openStage, condOf, setBg: setBgValue,
             members: () => cast, charas: () => charas, chooseUma, removeMember, setActive,
             props: () => props.propsDebug, importedSets,
             facePresets: key => {
               const m = cast.find(x => x.key === key);
               const f = m === current ? face : m?.g?.face;
               return f?.presets ? f.presets.map(p => p.label) : null;
             },
             settle, renderFrame, freeze: on => { if (on) setPlaying(false); recording = on ? { cancel: false } : null; },
             afterLoad: () => { setPlaying(false); anim.seek(Math.min(anim.now(), anim.length())); animChanged(); },
             whenReady: () => castLoaded });

/** Keys added or taken away: the timeline and the video length follow. */
function animChanged() {
  const scene = anim.active();
  $('#vidLen .chip[data-len="loop"]').textContent = scene ? 'Animation' : 'Full pose';
  $('#vidLen .chip[data-len="loop"]').title = scene ? 'The whole animation, from the start' : 'The whole pose, once';
  if (scene && current?.action && !playing) motionAt(anim.now());
  updateTime();
}
animChanged();

/** A cut between two ticks starts the springs over on the new pose (the game's warm-up), so
 *  nothing swings on from the shot before. */
function resetOnCut(t0, t1) {
  if (anim.cutTimes().some(c => c > t0 + 1e-6 && c <= t1 + 1e-6)) for (const m of cast) m.springs?.reset();
}

/** Scripted stills: the scene at time t with physics run like a video renders it, starting
 *  `pre` seconds earlier. */
async function settle(t, pre = 1.5) {
  await loadMotionClips();
  const t0 = Math.max(0, t - pre);
  const poseAt = x => {
    anim.apply(x, true);
    props.animateModels(x);
    forCast(() => { motionAt(x); faceAt(x); applyProcess(); applyFace(); });
  };
  const stepAll = () => Promise.all(cast.map(m => m.springs?.enabled ? m.springs.step() : null));
  for (const m of cast) m.springs?.reset();
  poseAt(t0);
  await stepAll();
  for (let k = 1; t0 + k * TICK <= t + 1e-6; k++) {
    resetOnCut(t0 + (k - 1) * TICK, t0 + k * TICK);
    poseAt(t0 + k * TICK);
    await stepAll();
  }
  forCast(m => m.root.updateMatrixWorld(true));
  props.updateProps();
}

window.studio = { scene, camera, controls, setCamera, setFace, savePNG, recordVideo, exportModel, chooseUma, get charas() { return charas; },
                  get current() { return current; }, video, shot, props: props.propsDebug, pose: pose.poseDebug, bgPic, anim: anim.animDebug,
                  exportBlender, renderBlender, get cast() { return cast; }, scenes: scenesDebug,
                  // for scripted shots: pause the live loop and pose / render frames by hand
                  script: { renderFrame, settle, libraryClip, ownClip, importedClip, playClip, applyFace, applyProcess, faceState, updateProps: props.updateProps, TICK,
                            freeze(on) { recording = on ? { cancel: false } : null; } } };
background();
resize();
start().catch(e => toast(e.message, true));
followWarmUp();
