// drives UmaStudio headless for scene files (Pictures\UmaStudio\scenes\<name>\scene.js)
//
//   node scene.mjs <name> [check]            load it, print the beats and what looks wrong
//   node scene.mjs <name> sheet [--per=3]    a contact sheet: per frames per beat (or --t=1,2.5,9)
//   node scene.mjs <name> info               the place's parts, the umas, props, clips and faces
//   node scene.mjs <name> blender [--render] [--still=n] send it to Blender (and render it, or frame n)
//   node scene.mjs <name> new [--from=<other>]           start a scene folder from the template
//   node scene.mjs <name> screen [--tab=render] [--at=5] the app window as a picture
//   node scene.mjs <name> eval "<js>"                     an expression on the page (studio = window.studio)
//
// starts the viewer from source on --port (27621) when nothing answers there. the browser keeps
// its own profile in %LOCALAPPDATA%\UmaStudio\scene-cli, apart from the app's.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.dirname(HERE);
const SCENES = path.join(os.homedir(), 'Pictures', 'UmaStudio', 'scenes');
const PROFILE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'UmaStudio', 'scene-cli');

const args = process.argv.slice(2);
const opt = (k, d = null) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : args.includes('--' + k) ? true : d; };
const [name, cmd = 'check'] = args.filter(a => !a.startsWith('--'));
const PORT = +opt('port', 27621);
const URL = `http://127.0.0.1:${PORT}/`;
const t0 = Date.now();
const lap = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

if (!name) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 12).map(l => l.slice(3).trimEnd()).join('\n'));
  process.exit(1);
}

if (cmd === 'new') {
  const dir = path.join(SCENES, name);
  if (fs.existsSync(path.join(dir, 'scene.js'))) { console.log('already there: ' + dir); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  const from = opt('from') ? path.join(SCENES, opt('from'), 'scene.js') : path.join(HERE, 'scene-template.js');
  fs.copyFileSync(from, path.join(dir, 'scene.js'));
  console.log('made ' + path.join(dir, 'scene.js'));
  process.exit(0);
}

async function up() {
  try { return (await fetch(URL + 'api/status')).ok; } catch { return false; }
}

async function server() {
  if (!(await up())) {
    lap(`starting the viewer on ${PORT}`);
    const py = spawn('python', ['serve.py', '--no-browser', '--port', String(PORT)], { cwd: VIEWER, detached: true, stdio: 'ignore', windowsHide: true });
    py.unref();
  }
  for (let i = 0; i < 600; i++) {
    try {
      const s = await (await fetch(URL + 'api/status')).json();
      if (s.ready) return;
      if (!s.loading && s.error) throw new Error(s.error);
    } catch (e) { if (e.message && !/fetch failed|ECONNREFUSED/.test(e.message)) throw e; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('the viewer did not come up');
}

async function main() {
  await server();
  const { chromium } = require('playwright-core');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: !opt('show'), viewport: { width: 1400, height: 1000 },
    args: ['--use-angle=d3d11', '--enable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  page.setDefaultTimeout(0);
  await page.goto(URL);
  await page.waitForFunction(() => window.studio?.charas?.length > 0 && window.studio.scenes, null, { timeout: 180000 });
  lap('viewer up');
  const r = await page.evaluate(n => window.studio.scenes.load(n).then(r => ({
    beats: r.beats.map(b => ({ t0: b.t0, t1: b.t1, title: b.title, inShot: b.inShot, say: b.say })), warnings: r.warnings,
  })), name);
  lap(`loaded ${name}`);
  r.beats.forEach((b, i) => console.log(`${String(i + 1).padStart(3)}  ${b.t0.toFixed(2).padStart(6)}-${b.t1.toFixed(2).padEnd(6)} ${b.title}` +
    (b.inShot ? `   [${b.inShot.join(', ') || 'nobody in shot'}]` : '')));
  for (const w of r.warnings) console.log(`${w.level === 'error' ? 'ERROR' : 'warn '} ${w.msg}`);
  if (!r.warnings.length) console.log('no warnings');

  if (cmd === 'sheet') {
    const times = opt('t') ? String(opt('t')).split(',').map(Number) : null;
    const file = opt('file', times ? 'moments' : 'sheet');
    const out = await page.evaluate(o => window.studio.scenes.sheet(o),
      { times, per: +opt('per', 1), width: +opt('width', 216), file, pre: +opt('pre', 0.6), cols: +opt('cols', 0) });
    lap('sheet: ' + out);
  } else if (cmd === 'info') {
    const info = await page.evaluate(async () => {
      const s = window.studio, cur = s.scenes.current;
      const env = cur.env;
      const parts = env.partNames().map(n => ({ n, b: env.box(n) })).filter(x => x.b);
      const umas = Object.values(env.umas).map(u => ({ alias: u.alias, key: u.key, name: u.name, head: +u.head.toFixed(2) }));
      const props = s.props.list.map(p => ({ key: p.key, kind: p.kind, name: p.name, anchor: p.anchor, owner: p.owner, base: p.sceneBase }));
      const clips = (await (await fetch('/api/anims')).json()).items.map(i => i.file);
      return { parts, umas, props, clips, place: env.placeId };
    });
    console.log(`\nplace ${info.place}: ${info.parts.length} parts (world boxes)`);
    for (const { n, b } of info.parts) console.log(`  ${n.padEnd(34)} min ${b.min.map(v => v.toFixed(1)).join(',').padEnd(22)} max ${b.max.map(v => v.toFixed(1)).join(',')}`);
    console.log('\numas'); for (const u of info.umas) console.log(`  ${u.alias} (${u.key}) ${u.name}, head at ${u.head} m`);
    console.log('\nprops'); for (const p of info.props) console.log(`  ${p.key}: ${p.kind} ${p.name || ''} on ${p.anchor} of ${p.owner}, base size ${p.base}`);
    console.log('\nanimation files: ' + info.clips.join(', '));
    const names = await page.evaluate(() => window.studio.scenes.clipNames());
    for (const [f, list] of Object.entries(names)) console.log(`clips in ${f}: ${list.join(', ')}`);
    const faces = await page.evaluate(() => window.studio.scenes.faces());
    for (const [k, list] of Object.entries(faces)) console.log(`faces of ${k}: ${list.join(', ')}`);
  } else if (cmd === 'screen') {
    // the whole window as it looks (--tab=render opens a sidebar tab, --at=seconds moves the timeline)
    if (opt('tab')) await page.click(`nav.tabs button[data-tab="${opt('tab')}"]`);
    if (opt('at')) await page.evaluate(t => window.studio.anim.seek(t), +opt('at'));
    await page.waitForTimeout(1500);
    const out = opt('out', path.join(SCENES, name, 'sheets', 'screen.png'));
    await page.screenshot({ path: out });
    lap('screen: ' + out);
  } else if (cmd === 'eval') {
    // any expression on the loaded page (studio = window.studio), printed as JSON
    const src = args.filter(a => !a.startsWith('--'))[2];
    const res = await page.evaluate(src => (0, eval)(`(async () => { const studio = window.studio; return (${src}); })()`), src);
    console.log(JSON.stringify(res, null, 1));
  } else if (cmd === 'blender') {
    const dir = await page.evaluate(n => window.studio.exportBlender(n), name);
    lap('exported Pictures\\UmaStudio\\blender\\' + dir);
    if (opt('render') || opt('still') !== null) {
      const job = await (await fetch(URL + 'api/blender/render', { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' },
                                                                   body: JSON.stringify({ dir, still: opt('still') === null ? false : +opt('still') || 0 }) })).json();
      if (!job.ok) throw new Error(job.error);
      for (;;) {
        await new Promise(r => setTimeout(r, 5000));
        const st = await (await fetch(URL + 'api/blender/status?id=' + job.id)).json();
        process.stdout.write(`\r  ${st.state || ''} ${st.frame ?? ''}/${st.frames ?? ''}   `);
        if (st.done || st.error || st.state === 'done' || st.state === 'error') { console.log('\n' + JSON.stringify(st)); break; }
      }
    }
  }
  if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].slice(0, 15).join('\n  '));
  process.exit(0);   // closing a persistent context can hang
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
