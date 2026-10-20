import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GameSprings, TICK } from '/static/physics.js';
import { fitBody } from '/static/bodyfit.js';
import { loadStage, showParts, faceCamera, partKinds } from '/static/stage.js';
import { initStageEdit, stageLoaded, stageShown, updateStageEdit, stageGizmo } from '/static/stagedit.js';
import { U, kindOf, makeMaterial, makeOutline } from '/static/look.js';
import { $, $$, call, post, getJson, toast, radio, store, busy, initChrome } from '/static/ui.js';
import { pickImage, pictureName } from '/static/images.js';
import * as props from '/static/props.js';
import * as pose from '/static/pose.js';

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
// she hangs under this: on a stage it stands her where she was put (stagedit.js), else the origin
const place = new THREE.Group();
place.name = 'placement';
scene.add(place);
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
  const c = charas.find(x => x.id === (+new URLSearchParams(location.search).get('uma') || (last && last.chara)));
  if (c) await chooseUma(c, last && last.chara === c.id ? last.dress : null);
  else openPicker();
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
function closePicker() { $('#picker').style.display = 'none'; }
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
    b.onclick = () => { closePicker(); chooseUma(c); };
    box.appendChild(b);
  }
}
$('#umaFilter').oninput = fillUmas;
$('#umaFilter').onkeydown = e => { if (e.key === 'Enter') $('#umaGrid .uma')?.click(); };

async function chooseUma(c, dressId) {
  closePicker();
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
  await openUma(c, d);
}

// the newest pick wins: an older load (a first-time convert is slow) that finishes later is dropped
let umaSeq = 0;
async function openUma(c, d) {
  const seq = ++umaSeq, stale = () => seq !== umaSeq;
  $('#umaOutfit').textContent = d.name;
  $('#overlay').textContent = `Loading ${c.name}…`;
  $('#overlay').style.display = 'flex';
  try {
    const r = await post('/api/load', { chara: c.id, dress: d.id }, `Loading ${c.name}…`);
    if (stale()) return;
    await busy(`Loading ${c.name}…`, loadModel(r.pack, r.manifest, r.sets, c, d, stale));
    if (!stale()) store.set('last', { chara: c.id, dress: d.id });
  } catch (e) {
    if (stale()) return;
    $('#overlay').textContent = '';
    toast(e.message, true);
  }
}

async function loadModel(pack, manifest, sets, chara, dress, stale = () => false) {
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
    const tex = {};
    for (const [slot, idx] of Object.entries(ud.textures || {})) tex[slot] = await getTex(idx);
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
  if (current) {
    place.remove(current.root);
    current.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
  const root = gltf.scene;
  place.add(root);
  const rest = new Map();
  root.traverse(o => { if (o.isBone || o.type === 'Object3D') rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  current = { pack, base, manifest, sets, root, rest, outlines, chara: chara.id, name: chara.name, dress: dress.name, miniParts,
              mixer: new THREE.AnimationMixer(root), action: null, clips: new Map(), springs: null, named: {} };
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
    await playClip(await libraryClip(path), path, true, 'Idle').catch(() => {});
  } else if (idle) {
    const st = sets.find(x => x.parts.some(([, k]) => k === idle.name));
    await playClip(await ownClip(idle.name), idle.name, true, st ? st.title : 'idle');
  } else {
    // background Umas have no motions of their own: a plain standing loop from the library
    const stand = '3d/motion/event/body/type00/anm_eve_type00_homestand01_loop';
    await playClip(await libraryClip(stand), stand, true, 'Standing').catch(() => {});
  }
}

// --- poses ------------------------------------------------------------------------------
//
// an outliner. similar motion sets fold into a family (Arms crossed 1, 1-1, 2…). a set plays
// its main part, and the playing set shows a row of buttons for its other parts (start, loop,
// end, still, reactions, cut-in shots). a category loads whole, once, and is searched here.

const POSE_CATS = [['own', 'Her poses'], ['mini', 'Chibi'], ['event', 'Everyday'], ['charaevent', 'Characters'], ['victory', 'Victory'],
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
  if (poseCat === 'own') {
    if (!current) { box.innerHTML = '<div class="empty">Choose an Uma first.</div>'; return; }
    sets = current.sets;
    getClip = ownClip;
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

async function ownClip(name) {
  if (current.clips.has(name)) return current.clips.get(name);
  const clip = buildClip(await getJson(`${current.base}motions/${encodeURIComponent(name)}.json`, null));
  current.clips.set(name, clip);
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

async function libraryClip(path) {
  if (current.clips.has(path)) return current.clips.get(path);
  const r = await getJson('/api/library/clip?path=' + encodeURIComponent(path), null);
  if (!r.clips.length) throw new Error('that pose has no usable motion');
  if (path.startsWith('3d/motion/live/')) toOrigin(r.clips[0]);
  const clip = buildClip(r.clips[0]);
  current.clips.set(path, clip);
  return clip;
}

// the motion only rewrites the bones it has tracks for, so what went on top of it last time
// comes off first, newest first: the head turn, then the pose mode offsets
function runMotion(dt) {
  liftHeadTurn();
  pose.liftEdits();
  current.mixer.update(dt);
}

function restPose() {
  current.mixer.stopAllAction();
  current.action = null;
  for (const [o, [p, q, s]] of current.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  current.springs?.reset();
}

async function playClip(clip, key, autoplay, title) {
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
  setPlaying(!!autoplay);
  runMotion(0);
  props.applyGrips();
}

let playing = false;
function setPlaying(p) {
  playing = p && !!(current && current.action);
  if (current && current.action) current.action.paused = !playing;
  $('#play').textContent = playing ? '❚❚' : '▶';
}
function updateTime() {
  const t = current && current.action ? current.action.time : 0;
  $('#time').textContent = t.toFixed(2) + 's';
  if (document.activeElement !== $('#scrub')) $('#scrub').value = t;
}
$('#play').onclick = () => setPlaying(!playing);
$('#scrub').oninput = () => {
  if (!current || !current.action) return;
  setPlaying(false);
  current.action.time = parseFloat($('#scrub').value);
  runMotion(0);
  current.springs?.reset();
  updateTime();
};
$('#speed').onchange = () => { if (current) current.mixer.timeScale = parseFloat($('#speed').value); };
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
  pose.applyEdits();   // hand-made joint changes first: the helper bones follow the final angles
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
  current?.outlines.forEach(o => { o.visible = $('#outline').checked; });
  props.setOutlines($('#outline').checked);
};
$('#eyeCell').onchange = () => U.eyeCell.value.set(+$('#eyeCell').value, 0);
$('#eyeHi').oninput = () => { U.eyeHi.value = parseFloat($('#eyeHi').value); };
$('#physics').onchange = () => current?.springs?.setEnabled($('#physics').checked);

// the springs, from the rest skeleton like the game binds them. with body collisions on, hair and
// ties also get colliders fitted to her outfit (bodyfit.js), so changing those makes new springs
function newSprings() {
  const mine = current;
  const body = $('#bodyCol').checked
    ? { shapes: mine.bodyFit ??= fitBody(mine.root), clearance: parseFloat($('#bodyGap').value) / 1000 } : null;
  GameSprings.create(mine.root, mine.rest, mine.pack, body).then(sp => {
    if (current !== mine || !sp) return;
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
    liveStage.group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
  }
  liveStage.group = group;
  liveStage.id = id;
  store.set('stageId', id);
  store.set('placeConds', { ...store.get('placeConds', {}), [id]: cond });
  store.set('placeAlts', { ...store.get('placeAlts', {}), [id]: alt });
  scene.add(group);
  showParts(group, stageParts());
  stageLoaded(group, id);
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

async function chooseStage() {
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
  $('#stagePicker').style.display = 'block';
  $('#stagePickerClose').onclick = () => done(null);
  $('#stagePicker').onmousedown = e => { if (e.target.id === 'stagePicker') done(null); };
  const id = await picked;
  $('#stagePicker').style.display = 'none';
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
function renderFrame(w, h, ss = 1) {
  const RW = w * ss, RH = h * ss;
  const g = guideRect();
  const savedAspect = camera.aspect;
  camera.aspect = g.W / g.H;
  camera.setViewOffset(g.W, g.H, g.x, g.y, g.w, g.h);
  camera.updateProjectionMatrix();
  updateLight();
  const rt = new THREE.WebGLRenderTarget(RW, RH, { samples: 4, stencilBuffer: true });
  const bg = background();
  placeBg(true);
  faceCamera(liveStage.group, camera);
  props.gizmo(false);
  stageGizmo(false);
  pose.gizmo(false);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(bg && bg !== 'picture' && bg !== 'stage' ? new THREE.Color(bg) : 0x000000, bg ? 1 : 0);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);
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
  if (!current || !current.action) return toast('Pick a pose to record first', true);
  let [w, h] = targetSize();
  // GIFs this big would be enormous, and codecs want even sizes
  if (video.fmt === 'gif') { const k = Math.min(1, 720 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k); }
  w -= w % 2; h -= h % 2;
  const fps = video.fmt === 'gif' ? Math.min(30, video.fps) : video.fps;
  const clip = current.action.getClip();
  const seconds = video.len === 'loop' ? clip.duration : Number(video.len);
  const frames = Math.max(1, Math.round(seconds * fps));
  const { id } = await post('/api/video/start', { w, h, fps, format: video.fmt, name: fileName() });

  recording = { cancel: false };
  const wasPlaying = playing;
  setPlaying(false);
  $('#recBar').style.display = 'flex';
  $('#record').disabled = $('#render').disabled = true;
  const start = video.len === 'loop' ? 0 : current.action.time;
  const step = 1 / fps;
  // following moves the camera along the video, the view gets its own camera back after
  const view = { pos: camera.position.clone(), target: controls.target.clone(), at: follow.at?.clone(), root: follow.root };
  try {
    // the game steps its physics at 60 Hz, each frame shows the tick nearest its time
    const springs = current.springs?.enabled ? current.springs : null;
    const poseAt = t => { current.action.time = (start + t) % clip.duration; runMotion(0); applyProcess(); applyFace(); };
    let ticks = 0;
    if (springs) { springs.reset(); poseAt(0); await springs.step(); }
    for (let i = 0; i < frames; i++) {
      if (recording.cancel) throw new Error('cancelled');
      if (springs) {
        const target = Math.round(i * step / TICK);
        while (ticks < target) { ticks++; poseAt(ticks * TICK); await springs.step(); }
      } else poseAt(i * step);
      current.root.updateMatrixWorld(true);
      const cut = rootJumped();
      followCamera(step, i === 0 || cut);
      applyHeadTurn(i === 0 ? 0 : step);
      applyEyeTrace(i === 0 ? 0 : step);
      props.updateProps();
      const frame = renderFrame(w, h, 1);
      // a local request can still drop now and then, one lost frame shouldn't end the video
      for (let tries = 3; ; tries--) {
        try {
          await call(`/api/video/frame?id=${id}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: frame.data }, null);
          break;
        } catch (e) {
          if (tries <= 1) throw e;
          await new Promise(r => setTimeout(r, 300));
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

// --- loop ----------------------------------------------------------------------------------------

const clock = new THREE.Clock();
let stepping = false;   // a physics step is out: this frame is drawn once it is back
function draw() {
  props.updateProps();
  pose.updateDots();
  updateLight();
  placeBg(false);
  faceCamera(liveStage.group, camera);
  updateStageEdit();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(() => {
  if (recording || stepping) return;   // the recorder drives every frame itself
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  let tick = null;
  if (current) {
    // the motion (re-evaluated even when paused), the face, the camera after her, then the springs
    // on that pose. they keep running while paused, like in the game.
    runMotion(playing ? dt : 0);
    applyProcess();
    applyFace();
    current.root.updateMatrixWorld(true);
    const cut = rootJumped();
    if (cut) current.springs?.reset();
    followCamera(dt, cut);
    applyHeadTurn(dt);
    applyEyeTrace(dt);
    tick = current.springs?.frame(dt);
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
                  idle: () => !!current && !recording && !pointerHeld });
initStageEdit({ scene, camera, canvas, controls, place, her: () => current?.root,
                onPick: () => props.propsDebug.select(null),
                onReset: () => { if (liveStage.group) showParts(liveStage.group, stageParts()); } });

window.studio = { scene, camera, controls, setCamera, setFace, savePNG, recordVideo, exportModel, chooseUma, get charas() { return charas; },
                  get current() { return current; }, video, shot, props: props.propsDebug, pose: pose.poseDebug, bgPic,
                  // for scripted shots: pause the live loop and pose / render frames by hand
                  script: { renderFrame, libraryClip, ownClip, applyFace, applyProcess, faceState, updateProps: props.updateProps, TICK,
                            freeze(on) { recording = on ? { cancel: false } : null; } } };
background();
resize();
start().catch(e => toast(e.message, true));
followWarmUp();
