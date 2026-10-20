// small helpers shared by the viewer's modules

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];

// anything that takes a moment shows a spinner and what it's doing in the top bar, so a click
// never looks ignored.
const GENERIC = 'Working…';
const waiting = [];
let busyTimer = null;

function showBusy() {
  busyTimer = null;
  const el = $('#busy');
  if (!el) return;
  el.classList.toggle('on', waiting.length > 0);
  document.body.classList.toggle('busy', waiting.length > 0);
  el.querySelector('span').textContent = waiting.find(l => l !== GENERIC) || GENERIC;
}

/** Shows label while promise runs (after a short delay, so quick things don't flicker). */
export async function busy(label, promise) {
  waiting.push(label);
  busyTimer ??= setTimeout(showBusy, 150);
  try {
    return await promise;
  } finally {
    waiting.splice(waiting.indexOf(label), 1);
    if (!waiting.length) {
      clearTimeout(busyTimer);
      showBusy();
    } else if (!busyTimer) showBusy();
  }
}

/** label: what the top bar says while waiting; null for background requests. */
export async function call(url, opts, label = GENERIC) {
  const run = async () => {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || r.statusText);
    return j;
  };
  return label ? busy(label, run()) : run();
}
export const post = (url, body, label) => call(url, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, label);
export const getJson = (url, label) => call(url, undefined, label);

/** A message in the status bar (errors in red), with an optional [label, onclick] link. */
let msgTimer;
export function toast(msg, bad, action) {
  if (bad) console.error(msg);
  const el = $('#statusMsg');
  el.className = bad ? 'bad' : '';
  el.textContent = msg;
  if (action) {
    const a = document.createElement('a');
    a.textContent = action[0];
    a.onclick = action[1];
    el.appendChild(a);
  }
  void el.offsetWidth;   // restart the flash
  el.classList.add('flash');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, bad ? 15000 : 8000);
}

// --- chrome: number sliders, sidebar tabs, folding panels ----------------------------------

function showSlider(inp) {
  const min = +inp.min || 0, max = +(inp.max || 100), v = +inp.value;
  inp.style.setProperty('--p', `${(v - min) / (max - min || 1) * 100}%`);
  const out = inp.parentElement.querySelector('output');
  if (out) {
    const step = +inp.step || 1;
    out.textContent = v.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3) + (inp.dataset.unit || '');
  }
}

export function showTab(tab) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.page').forEach(p => { p.hidden = p.dataset.tab !== tab; });
  store.set('tab', tab);
}

export function initChrome() {
  document.addEventListener('input', e => { if (e.target.closest?.('.num')) showSlider(e.target); });
  // values also change from code (presets, a selected prop), keep the bars in step
  setInterval(() => $$('.num input').forEach(i => { if (i.shown !== i.value) { i.shown = i.value; showSlider(i); } }), 150);
  $$('.tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
  showTab(store.get('tab', 'face'));
  const open = store.get('panels', {});
  $$('details.panel').forEach(d => {
    if (d.id in open) d.open = open[d.id];
    d.addEventListener('toggle', () => { open[d.id] = d.open; store.set('panels', open); });
  });
}

export const radio = (sel, el) => $$(sel).forEach(x => x.classList.toggle('on', x === el));

export const store = {
  get(k, d) { try { const v = localStorage.getItem('umastudio.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('umastudio.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/** True while typing in a field, so single-key shortcuts stay out of the way. */
export const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) &&
  !['checkbox', 'range', 'radio'].includes(document.activeElement.type);

/** A gizmo drag ends once the left button is up, even when its pointerup never arrived
 *  (focus lost mid-drag, or the right button still held when the left one let go). */
export function endDragOnRelease(tc) {
  const end = () => { if (tc.dragging) tc.pointerUp({ button: 0 }); };
  // capture: before the gizmo's own pointermove turns it one more step
  window.addEventListener('pointermove', e => { if (!(e.buttons & 1)) end(); }, true);
  window.addEventListener('pointercancel', end, true);
}
