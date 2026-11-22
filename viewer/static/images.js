// choosing a picture: your own (kept in Pictures/UmaStudio/images) or one of the game's story
// backgrounds. pictures can also be dropped onto the window or pasted (Ctrl+V).

import { $, $$, call, getJson, post, toast, radio, store, typing } from '/static/ui.js';

let tab = store.get('imgTab', 'mine');
let resolver = null;
let bgs = null;
let seq = 0;
let dropHandler = null;

const isOpen = () => $('#imgPicker').style.display === 'block';

/** Opens the picker; resolves to the picture's URL, or null when closed. */
export function pickImage({ title = 'Choose a picture', tab: start } = {}) {
  resolver?.(null);
  $('#imgTitle').textContent = title;
  $('#imgPicker').style.display = 'block';
  $('#imgFilter').value = '';
  setTab(start || tab);
  return new Promise(r => { resolver = r; });
}

function close(url) {
  $('#imgPicker').style.display = 'none';
  const r = resolver;
  resolver = null;
  r?.(url ?? null);
}

/** Saves a picture with the user's others; returns its URL. */
export async function upload(file) {
  const r = await call('/api/images/upload?name=' + encodeURIComponent(file.name || 'picture.png'),
                       { method: 'POST', headers: { 'X-Studio': '1' }, body: file });
  return '/img/' + encodeURIComponent(r.file);
}

/** What happens to a picture dropped or pasted while the picker is closed. */
export function onPictureDropped(fn) { dropHandler = fn; }

/** A short name for a picture URL. */
export function pictureName(url) {
  if (!url) return '';
  const m = url.match(/\/api\/bg\/([^/]+)\.png$/);
  if (m) return 'Background ' + m[1].replace(/^(vertical_)?bg_/, '');
  return decodeURIComponent(url.split('/').pop()).replace(/\.[a-z]+$/i, '');
}

function setTab(t) {
  tab = t;
  store.set('imgTab', t);
  radio('#imgTabs .chip', $(`#imgTabs .chip[data-tab="${t}"]`));
  fill().catch(e => toast(e.message, true));
}

function tile(src, label, url, wide) {
  const b = document.createElement('button');
  b.className = 'tile' + (wide ? ' wide' : '');
  b.innerHTML = `<img loading="lazy" alt=""><span></span>`;
  b.querySelector('img').src = src;
  b.querySelector('span').textContent = label;
  b.onclick = () => close(url);
  return b;
}

async function fill() {
  const my = ++seq;
  const grid = $('#imgGrid');
  const f = $('#imgFilter').value.trim().toLowerCase();
  grid.classList.toggle('portrait', tab === 'vbg');
  if (tab === 'mine') {
    const items = (await getJson('/api/images')).items;
    if (my !== seq) return;
    grid.innerHTML = '';
    const add = document.createElement('button');
    add.className = 'tile add';
    add.innerHTML = '<b>+</b><span>Add pictures…</span>';
    add.onclick = () => $('#imgFile').click();
    grid.appendChild(add);
    for (const it of items) {
      if (f && !it.file.toLowerCase().includes(f)) continue;
      const url = '/img/' + encodeURIComponent(it.file);
      grid.appendChild(tile(url, it.file.replace(/\.[a-z]+$/i, ''), url));
    }
    if (!items.length) grid.insertAdjacentHTML('beforeend', '<div class="empty">No pictures yet. Add one, drop one on this window, or paste one with Ctrl+V.</div>');
    return;
  }
  bgs ??= (await getJson('/api/bgs')).items;
  if (my !== seq) return;
  grid.innerHTML = '';
  const vertical = tab === 'vbg';
  for (const b of bgs) {
    if (b.vertical !== vertical || (f && !b.name.includes(f))) continue;
    grid.appendChild(tile(`/api/bg/thumb/${b.name}.jpg`, b.name.replace(/^(vertical_)?bg_/, ''), `/api/bg/${b.name}.png`, !vertical));
  }
}

let modelHandler = null;
/** What happens to .glb models dropped on the window. */
export function onModelDropped(fn) { modelHandler = fn; }

async function takeFiles(files) {
  const models = files.filter(f => /\.glb$/i.test(f.name));
  if (models.length && modelHandler) {
    modelHandler(models);
    if (models.length === files.length) return;
  }
  files = files.filter(f => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
  if (!files.length) return toast('Use a PNG, JPG, WebP or GIF picture', true);
  let url;
  try {
    for (const f of files) url = await upload(f);
  } catch (e) { return toast(e.message, true); }
  if (isOpen()) {
    if (files.length === 1 && resolver) return close(url);
    return setTab('mine');
  }
  dropHandler?.(url);
}

$$('#imgTabs .chip').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
let filterTimer;
$('#imgFilter').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => fill().catch(() => {}), 150); };
$('#imgClose').onclick = () => close(null);
$('#imgFolder').onclick = () => post('/api/open', { what: 'images' }).catch(() => {});
$('#imgPicker').addEventListener('mousedown', e => { if (e.target.id === 'imgPicker') close(null); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(null); });
$('#imgFile').onchange = () => { const files = [...$('#imgFile').files]; $('#imgFile').value = ''; takeFiles(files); };

window.addEventListener('dragover', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  document.body.classList.remove('dropping');
  takeFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', e => {
  if (typing()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  takeFiles(files);
});
