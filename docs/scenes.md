# Scene files

A scene file is a whole short written as code: the place, the umas, the props, and everything
that happens over time. UmaStudio loads it (Render tab, **Scene file**), sets everything up and
puts it on the timeline, where it plays, records and goes to Blender like a hand-keyed scene.

Each scene is a folder in `Pictures\UmaStudio\scenes\<name>\`:

| file | who writes it | what |
|---|---|---|
| `scene.js` | you | the scene (one file; it can't import files next to it) |
| `notes.json` | the app | notes written on each beat in the Scene panel, by beat title |
| `script.json` | the app | the voice lines, `[[start s, text], ...]` |
| `check.json` | the app | beats, who is in each shot, warnings |
| `sheets\*.png` | the app / `scene.mjs` | contact sheets |

With **Reload when the file changes** on, saving `scene.js` reloads it in the app. Only what
changed is loaded again: the place, umas and props stay when they are the same.

## The file

```js
export default {
  title: 'Gold Ship digs',
  length: 12,                      // seconds
  size: '1080x1920', fps: 30, fov: 32,
  place: 'race:race10006',         // or { id, cond: [season, weather, time], alt }
  extras: [{ key: 'gt1', id: 'race:race00000' }],   // other places mixed in
  cast: { spe: 1001, gs: { chara: 1007, dress: 100701 } },   // alias: chara id; first = main uma
  props: {
    shovel: { model: 'shovel.glb', hand: 'gs', grip: { p: [0, -0.257, 0.705], rx: -70 } },
    bill: { card: 'space_bill.png', hand: 'tz', side: 'left', h: 1.6 },
    box: { game: 'pfb_chr_prop1118_00', hand: 'spe' },
    sofa: 'sofa.glb',              // a .glb standing in the world, at its own size
  },
  build(s) { /* keys, see below */ },
};
```

Positions are metres `[x, y, z]` in the place's world. Turns (`ry`, `rx`, `rz`) are degrees;
`ry` 0 faces +z, 90 faces +x. Models come from `Pictures\UmaStudio\models`, pictures from
`images`, animations from `animations`.

Props: `hand` puts it in that uma's hand (`side: 'left'` for the left), `grip` is its offset
there. Without `hand` it stands in the world and keys move it. Size keys on props are times the
model's own size.

## build(s)

Who: an uma's alias, a prop's name, `'cam'`, or `'part:<node name>'` for a part of the place
(added places' nodes are `x<key>:<name>`, the added place itself `x<key>`).

Keys. `e` is how it gets there from the key before: `smooth` (default), `linear`, `out`, `in`,
`back`, `bounce`, `step` (jumps at the key). Channels a key leaves out aren't touched, so a
position path and a size pop on the same prop don't disturb each other.

| call | what |
|---|---|
| `s.key(who, t, { p, ry, rx, rz, q, s, v, e, ep, eq, es })` | one key; `ep/eq/es` ease per channel |
| `s.at(who, t, p, ry, e = 'step')` | is at p from t (jumps there unless e says otherwise) |
| `s.go(who, t0, t1, p, ry, e)` | moves from where it is at t0 to p by t1 |
| `s.hold(who, t)` | stays as it is until t |
| `s.path(who, [[t, p, ry, e], ...], e = 'linear')` | keys along a path (first one jumps) |
| `s.show(who, t0, t1)` | shows only in these windows (several add up) |
| `s.hide(who, t0, t1)` | hidden in this window |
| `s.pop(who, t, { s, dur })` | grows out of nothing at t, shows from t |
| `s.out(who, t, { s, dur })` | shrinks away from t, hidden after |
| `s.drop(who, t, p, { h, ry })` | falls onto p, lands at t + 0.45 with a small hop |
| `s.motion(who, t, clip, { once })` | plays clip from t |
| `s.motions(who, [[t, clip], ...])` | several |
| `s.face(who, t, 'WaraiA')`, `s.faceList(who, [[t, face], ...])` | face presets |
| `s.cam(t, p, tg, { fov, e })` | the camera at p looking at tg |
| `s.shot(t0, t1, { ... })` | a framed shot, see below |
| `s.shake(t, dur, amp)` | the picture shakes, amp metres at first, dying away |
| `s.beat(t0, t1, title, { say, note })` | a beat: timeline band, sheet label, voice line |
| `s.say(t, text)` | a voice line besides a beat's |
| `s.fx(t, { dark, flash })`, `s.focus(t, who or null)`, `s.haze(d)` | Blender only |

Clips: an imported animation by name (`'Idle_Loop'`, or `'UAL2:Yes'` for one file), one of the
uma's own motion names, a library path (`3d/motion/...`), or `'rest'` (T-pose). Clips not named
`_Loop` play once and hold their last frame; `{ once: false }` loops them.

Shots: `on` is an alias, a list of aliases, or a point `[x, y, z]`. `size` is `face`, `close`,
`upper`, `medium`, `full`, `wide`, `xwide` or metres of frame height. `angle` turns the camera
round her from her front (degrees), `yaw` sets it absolute, `tilt` looks down (default 6),
`dist` and `height` override, `offset` moves the look point. `to: { size, angle, tilt, dist,
height, yaw }` is where it ends at t1 (push in, orbit), eased by `e`. `follow: true` keeps on
her while she moves. Every shot starts with a cut; it replaces camera keys inside it.

Looking around while building:

| call | gives |
|---|---|
| `s.ground(x, z)` | ground height there |
| `s.on(x, z, dy)` | `[x, ground + dy, z]` |
| `s.parts(/regex/)` | names of the place's parts |
| `s.box(name)` | a part's world box `{ min, max, center, size }` |
| `s.height(alias)` | how tall she is |
| `s.front(p, ry, d, side, up)` | the point d metres in front of someone at p facing ry |
| `s.face2(a, b)` | the ry that faces from a to b |
| `s.add(a, b)` | a + b |
| `s.rand(seed)` | a seeded random source |
| `s.length`, `s.THREE` | the length, three.js |

## Checks

Loading checks the scene without rendering and lists what looks wrong in the panel (click a
warning to go there) and in `check.json`: names that point at nothing, unknown clips and faces,
beats with nobody in the picture (put `no uma` in the beat's `note` when that's meant), umas
inside each other, the camera under the ground, keys after the end.

## From the command line

`viewer\tools\scene.mjs` drives the viewer headless (`npm install` in `viewer\tools` once). It
starts `serve.py` on port 27621 when nothing answers there, with its own browser profile.

```
node scene.mjs <name>                 load, list beats (with who is in shot) and warnings
node scene.mjs <name> sheet --per=3   contact sheet, 3 frames a beat (or --t=1,4.5,9)
node scene.mjs <name> info            the place's parts with boxes, umas, props, clips, faces
node scene.mjs <name> screen --tab=render --at=5
node scene.mjs <name> eval "<js>"     an expression on the page (studio = window.studio)
node scene.mjs <name> blender [--render | --still=<frame>]
node scene.mjs <name> new [--from=<other scene>]
```
