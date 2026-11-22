import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { $, $$, store, radio, typing, endDragOnRelease, toast } from '/static/ui.js';

// editing a place: with "Edit the place" on, a part of it (the screen, a speaker, an LED wall...) can
// be moved, turned, resized or hidden, or she can be stood somewhere on it. parts are picked from
// the outliner (searchable, hover shows them in the view) or by clicking in the view: what the
// pointer is over gets a light outline first, and clicking the same spot again goes to the next
// thing behind. a part is a piece of one of the place's prefabs, "whole group" takes the prefab.
// everything is kept per place by node name (the loader keeps those unique), her spot too. with
// no place showing she goes back to the origin.
//
// other places can be added in to build with (a racecourse's stands propped up on Tracen's school
// building): each comes in as one group, its nodes renamed x<key>:... so names stay unique even
// with the same place in twice (once in winter, once in summer). their skies start hidden.
//
// with several umas in the scene each has her own spot: the first one's is kept as `her` (as it
// always was), the others' under `hers` by their key.

let ctx = null, tc = null, box = null, hoverBox = null;
let group = null, base = null, placeId = '', shown = false, active = false;
let picked = null;               // a part, or ctx.place for her
let loadToken = 0;               // bumps when the place changes, late added places get dropped
let hovered = null;
const open = new Set();          // outliner groups folded open
const raycaster = new THREE.Raycaster();

const allEdits = () => store.get('stageEdits', {});
function edits() {
  const all = allEdits();
  // concert stages were saved by number before there were other places
  const e = all[placeId] || all[placeId.replace(/^live:/, '')] || {};
  return { parts: {}, her: null, hers: {}, extras: [], ...e };
}
function putEdits(e) {
  const all = allEdits();
  delete all[placeId.replace(/^live:/, '')];
  if (Object.keys(e.parts).length || e.her || Object.keys(e.hers).length || e.extras.length) all[placeId] = e;
  else delete all[placeId];
  store.set('stageEdits', all);
}

const memberOf = o => ctx.members().find(m => m.spot === o) || null;
const isHer = o => !!o && (o === ctx.place || !!memberOf(o));
const isFirst = o => ctx.members()[0]?.spot === o;
const isExtra = o => !!o?.userData.extra;
// the nodes whose children are prefabs: the place itself and each added place
const isRoot = o => !!o && (o === base || isExtra(o));
const bare = n => n.replace(/^x[a-z0-9]+:/, '');
const restOf = o => o.userData.rest ??= { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };

/** The part a picked mesh belongs to: the node right under its prefab. */
function partOf(o) {
  while (o.parent && !isRoot(o.parent) && !isRoot(o.parent.parent)) o = o.parent;
  return o;
}

function shownInView(o) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** A readable name: no prefab prefix, no copy number the loader added, spaces. */
function label(o) {
  if (isHer(o)) return memberOf(o)?.name || 'her';
  if (isExtra(o)) return '+ ' + o.userData.extra.name;
  let n = bare(o.name);
  const m = n.match(/^(.*)_\d+$/);
  if (m && o.parent && bare(o.parent.name) === m[1]) n = m[1];
  return n.replace(/^(pfb|mdl)_env_[a-z]+\d*_/, '').replace(/^pfb_/, '').replace(/_/g, ' ');
}

function remember(o) {
  const e = edits();
  if (isHer(o)) {
    const spot = { p: o.position.toArray(), ry: o.rotation.y };
    if (isFirst(o) || !memberOf(o)) e.her = spot;
    else e.hers[memberOf(o).key] = spot;
  }
  else {
    const r = restOf(o);
    const same = o.visible && o.position.equals(r.p) && o.quaternion.equals(r.q) && o.scale.equals(r.s);
    if (same) delete e.parts[o.name];
    else e.parts[o.name] = { v: o.visible, p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() };
  }
  putEdits(e);
  refresh();
}

function setVisible(o, on) {
  o.visible = on;
  o.userData.userHidden = !on;
  remember(o);
}

function pick(o) {
  picked = o;
  for (let p = o && !isHer(o) ? o.parent : null; p && p !== base; p = p.parent) open.add(p);
  if (o) { tc.attach(o); ctx.onPick?.(); } else tc.detach();
  ctx.onPicked?.(o);
  const her = !!o && isHer(o);
  // she turns about the vertical only and keeps her size
  tc.showX = tc.showZ = !(her && tc.mode === 'rotate');
  if (her && tc.mode === 'scale') setMode('translate');
  refresh();
  $('#stageTree .row.on')?.scrollIntoView({ block: 'nearest' });
}

function setMode(mode) {
  if (picked && isHer(picked) && mode === 'scale') return;
  tc.setMode(mode);
  tc.showX = tc.showZ = !(picked && isHer(picked) && mode === 'rotate');
  radio('#stageModes .chip', $(`#stageModes .chip[data-mode="${mode}"]`));
}

function hover(o) {
  hovered = o;
  hoverBox.visible = !!o && o !== picked && active;
}

// --- outliner -----------------------------------------------------------------------------------

function row(o, depth, kids) {
  const r = document.createElement('div');
  r.className = 'row' + (kids ? ' fam' : '') + (kids && open.has(o) ? ' open' : '') + (o === picked ? ' on' : '')
    + (o.visible ? '' : ' off');
  r.style.setProperty('--depth', depth);
  r.innerHTML = '<span class="tw"></span><span class="t"></span><span class="n"></span><button class="mini"></button>';
  r.querySelector('.t').textContent = label(o);
  if (kids) r.querySelector('.n').textContent = kids;
  const vis = r.querySelector('button');
  vis.textContent = o.visible ? 'Hide' : 'Show';
  vis.title = o.visible ? 'Hide it (Delete)' : 'Show it again';
  vis.onclick = e => { e.stopPropagation(); if (o === picked && o.visible) pick(null); setVisible(o, !o.visible); };
  r.querySelector('.tw').onclick = e => {
    if (!kids) return;
    e.stopPropagation();
    if (open.has(o)) open.delete(o); else open.add(o);
    fillTree();
  };
  r.onclick = () => pick(o === picked ? null : o);
  r.onmouseenter = () => hover(o);
  r.onmouseleave = () => { if (hovered === o) hover(null); };
  return r;
}

// what a row folds open to: an added place its prefabs, a prefab its parts
const kidsOf = o => isRoot(o) ? o.children : isRoot(o.parent) && o.children.length > 1 ? o.children : [];

function fillTree() {
  const tree = $('#stageTree');
  tree.innerHTML = '';
  if (!base || !active) return;
  const find = $('#stageFind').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  const walk = (list, depth) => {
    for (const o of list) {
      const kids = kidsOf(o);
      if (find) {
        // a flat list of whatever matches, groups and parts
        if (label(o).toLowerCase().includes(find)) frag.appendChild(row(o, 0, kids.length));
        walk(kids, 0);
      } else {
        frag.appendChild(row(o, depth, kids.length));
        if (kids.length && open.has(o)) walk(kids, depth + 1);
      }
    }
  };
  walk(base.children, 0);
  if (!frag.childNodes.length) tree.innerHTML = '<div class="hint">Nothing matches.</div>';
  tree.appendChild(frag);
}

function refresh() {
  const her = !!picked && isHer(picked);
  $('#stagePick').textContent = picked ? label(picked) : 'nothing';
  $('#stageUp').disabled = !picked || her || picked.parent === base;
  $('#stageHide').disabled = !picked || her;
  $('#stageHide').textContent = isExtra(picked) ? 'Remove' : 'Hide';
  fillExtraConds();
  $('#stagePartReset').disabled = !picked;
  $('#stageModes .chip[data-mode="scale"]').disabled = her;
  const n = Object.values(edits().parts).filter(p => !p.v).length;
  $('#stageUnhide').textContent = n ? `Show hidden (${n})` : 'Show hidden';
  $('#stageUnhide').disabled = !n;
  box.visible = !!picked && active;
  hoverBox.visible = !!hovered && hovered !== picked && active;
  fillTree();
}

function setActive(on) {
  active = on && shown && !!group;
  if (!active) { pick(null); hover(null); }
  $('#stageEditor').style.display = on ? '' : 'none';
  refresh();
}

/** Their spots on this place while it shows; the first uma goes to the origin otherwise, the
 *  others stay where they are. */
function placeHer() {
  const e = shown && group ? edits() : null;
  ctx.members().forEach((m, i) => {
    const her = e ? (i === 0 ? e.her : e.hers[m.key]) : null;
    if (her) {
      m.spot.position.fromArray(her.p);
      m.spot.rotation.set(0, her.ry, 0);
    } else if (i === 0) {
      m.spot.position.set(0, 0, 0);
      m.spot.rotation.set(0, 0, 0);
    }
  });
}

// --- added places -------------------------------------------------------------------------------

/** Saved moves and hiding put back on the nodes under root. */
function applyEdits(root) {
  for (const [name, p] of Object.entries(edits().parts)) {
    const o = root.getObjectByName(name);
    if (!o) continue;
    o.visible = p.v;
    o.userData.userHidden = !p.v;
    o.position.fromArray(p.p);
    o.quaternion.fromArray(p.q);
    o.scale.fromArray(p.s);
  }
}

async function loadExtra(ex, fresh) {
  const token = loadToken;
  const { group: g, item } = await ctx.loadPlace(ex.id, ex.cond, ex.alt);
  if (token !== loadToken || !base) { ctx.dispose(g); return null; }
  const root = g.children.length === 1 ? g.children[0] : g;
  root.removeFromParent();
  root.traverse(o => { if (o !== root) o.name = `x${ex.key}:` + o.name; });
  root.name = 'x' + ex.key;
  root.userData.extra = { ...ex, name: item.name };
  base.add(root);
  root.traverse(o => restOf(o));
  if (fresh) {
    // two skies inside each other fight: the one of the place it's added to stays
    for (const pre of root.children) {
      if (!/sky|cloud/i.test(pre.name)) continue;
      pre.visible = false;
      pre.userData.userHidden = true;
      remember(pre);
    }
  }
  applyEdits(root);
  ctx.onExtras();
  return root;
}

function dropExtra(root) {
  if (picked && (picked === root || root.getObjectById(picked.id))) pick(null);
  if (hovered && (hovered === root || root.getObjectById(hovered.id))) hover(null);
  root.removeFromParent();
  ctx.dispose(root);
  ctx.onExtras();
}

async function addExtra() {
  if (!base) return;
  const id = await ctx.pickPlace('Add a place to this one');
  if (!id) return;
  const ex = { key: Date.now().toString(36), id, cond: ctx.condOf(id), alt: ctx.altOf(id) };
  const e = edits();
  e.extras.push(ex);
  putEdits(e);
  const root = await loadExtra(ex, true).catch(err => { removeExtra(ex.key); throw err; });
  if (root) { open.add(root); pick(root); }
}

/** An added place taken out again, with everything saved about it. */
function removeExtra(key) {
  const e = edits();
  e.extras = e.extras.filter(x => x.key !== key);
  for (const name of Object.keys(e.parts)) if (name.startsWith(`x${key}:`) || name === 'x' + key) delete e.parts[name];
  putEdits(e);
  const root = base?.children.find(o => o.name === 'x' + key);
  if (root) dropExtra(root);
  refresh();
}

/** Season, weather, time and version of the picked added place: changing one reloads it where it is. */
function fillExtraConds() {
  const line = $('#extraConds');
  const root = isExtra(picked) ? picked : null;
  const item = root && ctx.placeItem(root.userData.extra.id);
  const alts = item?.alts || [];
  if (!item || !(item.axes.some(a => a.length) || alts.length > 1)) { line.style.display = 'none'; return; }
  line.style.display = '';
  const ex = root.userData.extra, sels = line.querySelectorAll('select');
  ctx.conds.forEach(([, any, names], i) => {
    const el = sels[i];
    el.innerHTML = '';
    el.add(new Option(any, 0));
    for (const v of item.axes[i]) el.add(new Option(names[v] || v, v));
    el.value = ex.cond[i];
    el.style.display = item.axes[i].length ? '' : 'none';
  });
  sels[3].innerHTML = '';
  alts.forEach((a, i) => sels[3].add(new Option(`Version ${i + 1}`, a)));
  sels[3].value = alts.includes(ex.alt) ? ex.alt : alts[0] || '';
  sels[3].style.display = alts.length > 1 ? '' : 'none';
  sels.forEach(el => {
    el.onchange = async () => {
      const e = edits();
      const saved = e.extras.find(x => x.key === ex.key);
      if (!saved) return;
      saved.cond = [0, 1, 2].map(i => +sels[i].value);
      saved.alt = sels[3].value || null;
      putEdits(e);
      dropExtra(root);
      const again = await loadExtra(saved, false).catch(err => { toast(err.message, true); return null; });
      if (again) pick(again);
    };
  });
}

/** A place was loaded: its saved changes go back on. */
export function stageLoaded(g, id) {
  pick(null);
  hover(null);
  open.clear();
  group = g;
  // the model's own root node holds the prefabs
  base = g.children.length === 1 ? g.children[0] : g;
  placeId = id;
  loadToken++;
  g.traverse(o => restOf(o));
  applyEdits(g);
  placeHer();
  setActive($('#stageEdit').checked);
  // the added places come in one by one after
  (async () => {
    for (const ex of edits().extras) {
      await loadExtra(ex, false).catch(err => toast(err.message, true));
      refresh();
    }
  })();
}

/** An uma joined the scene: she goes to her spot on this place. */
export function placeCast() { if (ctx) placeHer(); }

/** The place showing or not (the background changed). */
export function stageShown(on) {
  if (shown === on) return;
  shown = on;
  placeHer();
  setActive($('#stageEdit').checked);
}

/** What's picked in the place editor (ctx.place for her), for keying. */
export const stagePicked = () => (active ? picked : null);
export const partLabel = o => label(o);

/** Every frame before drawing: the outlines round what's picked and what the pointer is over. */
export function updateStageEdit() {
  if (box.visible && picked) box.setFromObject(picked);
  if (hoverBox.visible && hovered) hoverBox.setFromObject(hovered);
}

/** Hidden while a picture, video frame or thumbnail is drawn. */
export function stageGizmo(visible) {
  tc.visible = visible && !!picked;
  box.visible = visible && !!picked && active;
  hoverBox.visible = visible && !!hovered && hovered !== picked && active;
}

export function initStageEdit(c) {
  ctx = c;
  tc = new TransformControls(ctx.camera, ctx.canvas);
  tc.setSpace('local');
  tc.setSize(0.8);
  tc.addEventListener('dragging-changed', e => {
    ctx.controls.enabled = !e.value;
    if (!e.value && picked) remember(picked);
  });
  endDragOnRelease(tc);
  ctx.scene.add(tc);
  const outline = color => {
    const b = new THREE.BoxHelper(undefined, color);
    b.material.depthTest = false;
    b.material.transparent = true;
    b.renderOrder = 999;
    b.visible = false;
    ctx.scene.add(b);
    return b;
  };
  box = outline(0xffa040);
  hoverBox = outline(0xffffff);
  hoverBox.material.opacity = 0.55;

  // everything under the pointer, nearest first, one entry per part: her if she's hit, solid
  // parts before glowing ones at the same spot (beams would catch every click otherwise)
  function under(e) {
    const r = ctx.canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), ctx.camera);
    const found = [];
    for (const m of ctx.members()) {
      const hit = raycaster.intersectObject(m.root, true).find(h => shownInView(h.object));
      if (hit) found.push({ o: m.spot, d: hit.distance, glow: false });
    }
    for (const h of raycaster.intersectObject(group, true)) {
      if (!h.object.isMesh || !shownInView(h.object) || h.object.renderOrder <= -10) continue;
      found.push({ o: partOf(h.object), d: h.distance, glow: h.object.material.blending === THREE.AdditiveBlending });
    }
    found.sort((a, b) => (a.glow - b.glow) || (a.d - b.d));
    return [...new Set(found.map(f => f.o))];
  }

  // hover: what a click would pick, a few times a second at most
  let hoverAt = 0;
  ctx.canvas.addEventListener('pointermove', e => {
    if (!active || e.buttons || tc.dragging || tc.axis !== null) { if (hovered && !e.buttons) hover(null); return; }
    const now = performance.now();
    if (now - hoverAt < 70) return;
    hoverAt = now;
    hover(under(e)[0] || null);
  });
  ctx.canvas.addEventListener('pointerleave', () => hover(null));

  // click: the nearest thing; clicking the same spot again steps to the next one behind it
  let down = null, last = null;
  ctx.canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  ctx.canvas.addEventListener('pointerup', e => {
    if (!active || !down || e.button !== 0 || tc.dragging) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (moved > 4 || e.defaultPrevented) return;
    const list = under(e);
    // the same spot with the view where it was (the orbit eases a little after a move)
    const again = last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 5 && ctx.camera.position.distanceTo(last.cam) < 0.01;
    let i = 0;
    if (again && list.includes(picked)) i = (list.indexOf(picked) + 1) % list.length;
    last = { x: e.clientX, y: e.clientY, cam: ctx.camera.position.clone() };
    if (list.length) pick(list[i]);
    else if (tc.axis === null) pick(null);
  });

  document.addEventListener('keydown', e => {
    if (!active || !picked || typing() || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') setMode('translate');
    else if (k === 'e') setMode('rotate');
    else if (k === 'r') setMode('scale');
    else if (k === 'delete') $('#stageHide').click();
    else if (k === 'escape') pick(null);
    else return;
    e.preventDefault();
  });

  $$('#stageModes .chip').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
  $('#stageEdit').checked = store.get('stageEdit', false);
  $('#stageEdit').onchange = () => { store.set('stageEdit', $('#stageEdit').checked); setActive($('#stageEdit').checked); };
  $('#stageFind').oninput = fillTree;
  $('#stageHer').onclick = () => { if (active) pick(ctx.place); };
  $('#stageUp').onclick = () => { if (picked && !isHer(picked) && picked.parent !== base) pick(picked.parent); };
  $('#stageHide').onclick = () => {
    if (!picked || isHer(picked)) return;
    if (isExtra(picked)) { removeExtra(picked.userData.extra.key); return; }
    const o = picked;
    pick(null);
    setVisible(o, false);
  };
  $('#stagePartReset').onclick = () => {
    if (!picked) return;
    if (isHer(picked)) { picked.position.set(0, 0, 0); picked.rotation.set(0, 0, 0); }
    else {
      const r = restOf(picked);
      picked.visible = true;
      picked.userData.userHidden = false;
      picked.position.copy(r.p); picked.quaternion.copy(r.q); picked.scale.copy(r.s);
    }
    remember(picked);
  };
  $('#stageUnhide').onclick = () => {
    for (const [name, p] of Object.entries(edits().parts)) {
      const o = !p.v && group?.getObjectByName(name);
      if (o) setVisible(o, true);
    }
  };
  $('#stageAddPlace').onclick = () => addExtra().catch(err => toast(err.message, true));
  $('#stageResetAll').onclick = () => {
    if (!group) return;
    pick(null);
    // added places go too
    for (const root of base.children.filter(isExtra)) dropExtra(root);
    group.traverse(o => {
      const r = o.userData.rest;
      if (r) { o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s); }
    });
    // the light/crowd/effects switches decide those meshes, the rest show again
    for (const name of Object.keys(edits().parts)) {
      const o = group.getObjectByName(name);
      if (o) { o.visible = true; o.userData.userHidden = false; }
    }
    putEdits({ parts: {}, her: null, hers: {}, extras: [] });
    ctx.onReset?.();
    placeHer();
    refresh();
  };
  setMode('translate');
  setActive(false);
}
