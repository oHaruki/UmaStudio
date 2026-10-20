import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { $, $$, store, radio, typing, endDragOnRelease } from '/static/ui.js';

// editing a place: with "Edit the place" on, a part of it (the screen, a speaker, an LED wall...) can
// be moved, turned, resized or hidden, or she can be stood somewhere on it. parts are picked from
// the outliner (searchable, hover shows them in the view) or by clicking in the view: what the
// pointer is over gets a light outline first, and clicking the same spot again goes to the next
// thing behind. a part is a piece of one of the place's prefabs, "whole group" takes the prefab.
// everything is kept per place by node name (the loader keeps those unique), her spot too. with
// no place showing she goes back to the origin.

let ctx = null, tc = null, box = null, hoverBox = null;
let group = null, base = null, placeId = '', shown = false, active = false;
let picked = null;               // a part, or ctx.place for her
let hovered = null;
const open = new Set();          // outliner groups folded open
const raycaster = new THREE.Raycaster();

const allEdits = () => store.get('stageEdits', {});
function edits() {
  const all = allEdits();
  // concert stages were saved by number before there were other places
  return all[placeId] || all[placeId.replace(/^live:/, '')] || { parts: {}, her: null };
}
function putEdits(e) {
  const all = allEdits();
  delete all[placeId.replace(/^live:/, '')];
  if (Object.keys(e.parts).length || e.her) all[placeId] = e;
  else delete all[placeId];
  store.set('stageEdits', all);
}

const isHer = o => o === ctx.place;
const restOf = o => o.userData.rest ??= { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };

/** The part a picked mesh belongs to: the node right under its prefab. */
function partOf(o) {
  while (o.parent && o.parent !== base && o.parent.parent !== base) o = o.parent;
  return o;
}

function shownInView(o) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** A readable name: no prefab prefix, no copy number the loader added, spaces. */
function label(o) {
  if (isHer(o)) return 'her';
  let n = o.name;
  const m = n.match(/^(.*)_\d+$/);
  if (m && o.parent && o.parent.name === m[1]) n = m[1];
  return n.replace(/^(pfb|mdl)_env_[a-z]+\d*_/, '').replace(/^pfb_/, '').replace(/_/g, ' ');
}

function remember(o) {
  const e = edits();
  if (isHer(o)) e.her = { p: o.position.toArray(), ry: o.rotation.y };
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
  if (o && !isHer(o) && o.parent !== base) open.add(o.parent);
  if (o) { tc.attach(o); ctx.onPick?.(); } else tc.detach();
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

function fillTree() {
  const tree = $('#stageTree');
  tree.innerHTML = '';
  if (!base || !active) return;
  const find = $('#stageFind').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  const parts = g => g.children;
  if (find) {
    // a flat list of whatever matches, groups and parts
    for (const g of base.children) {
      if (label(g).toLowerCase().includes(find)) frag.appendChild(row(g, 0, parts(g).length > 1 ? parts(g).length : 0));
      if (parts(g).length > 1) for (const p of parts(g)) if (label(p).toLowerCase().includes(find)) frag.appendChild(row(p, 1, 0));
    }
  } else {
    for (const g of base.children) {
      const kids = parts(g);
      frag.appendChild(row(g, 0, kids.length > 1 ? kids.length : 0));
      if (kids.length > 1 && open.has(g)) for (const p of kids) frag.appendChild(row(p, 1, 0));
    }
  }
  if (!frag.childNodes.length) tree.innerHTML = '<div class="hint">Nothing matches.</div>';
  tree.appendChild(frag);
}

function refresh() {
  const her = !!picked && isHer(picked);
  $('#stagePick').textContent = picked ? label(picked) : 'nothing';
  $('#stageUp').disabled = !picked || her || picked.parent === base;
  $('#stageHide').disabled = !picked || her;
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

/** Her spot on this place while it shows, the origin otherwise. */
function placeHer() {
  const her = shown && group ? edits().her : null;
  ctx.place.position.fromArray(her ? her.p : [0, 0, 0]);
  ctx.place.rotation.set(0, her ? her.ry : 0, 0);
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
  const e = edits();
  g.traverse(o => restOf(o));
  for (const [name, p] of Object.entries(e.parts)) {
    const o = g.getObjectByName(name);
    if (!o) continue;
    o.visible = p.v;
    o.userData.userHidden = !p.v;
    o.position.fromArray(p.p);
    o.quaternion.fromArray(p.q);
    o.scale.fromArray(p.s);
  }
  placeHer();
  setActive($('#stageEdit').checked);
}

/** The place showing or not (the background changed). */
export function stageShown(on) {
  if (shown === on) return;
  shown = on;
  placeHer();
  setActive($('#stageEdit').checked);
}

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
    const herRoot = ctx.her();
    const herHit = herRoot ? raycaster.intersectObject(herRoot, true).find(h => shownInView(h.object)) : null;
    if (herHit) found.push({ o: ctx.place, d: herHit.distance, glow: false });
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
  $('#stageResetAll').onclick = () => {
    if (!group) return;
    pick(null);
    group.traverse(o => {
      const r = o.userData.rest;
      if (r) { o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s); }
    });
    // the light/crowd/effects switches decide those meshes, the rest show again
    for (const name of Object.keys(edits().parts)) {
      const o = group.getObjectByName(name);
      if (o) { o.visible = true; o.userData.userHidden = false; }
    }
    putEdits({ parts: {}, her: null });
    ctx.onReset?.();
    placeHer();
    refresh();
  };
  setMode('translate');
  setActive(false);
}
