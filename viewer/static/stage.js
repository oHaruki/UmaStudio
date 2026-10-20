import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// places from the game around her at the origin: concert stages (3d/env/live), racecourses, Tracen,
// story sets, cut-in sets... in the game each song's timeline drives a stage's lights, colours and
// screens; here they stand as the assets have them. the game's stage and background shaders are
// unlit, so plain textured surfaces (times vertex colour) get close; light beams, bulbs and glow
// sticks add on top. baked lightmaps and fog are left out.

const ADD = /LightAdd|LightBlink|Particle|WaveLight|AlphaAdd/;
const BLEND = /Transparent|MobShadow/;
// mirror floors and shadow catchers need the game's reflection and shadow passes (drawn plain a
// catcher shows a placeholder silhouette, the baked shadow decals red and green smears)
const SKIP = /ReceiveMirror|UnlitMirror|Stage\/Shadow$|RedAlphaGreen/;
const LIGHTS = /LightAdd|LightBlink/;
const CROWD = /Cyalume/;
// set pieces a song fires at its moments (smoke, fireworks, petals, bubbles, sweeping spots):
// parked at rest they'd fog over her
const EFFECTS = /smoke|firework|petal|bubble|confetti|spot_move/i;
const STICK_COLOR = 0xff8fd0;

// the glow sticks have no texture, the game's shader draws the stick: a bright core fading out
// sideways, rounded at the ends
let stick = null;
function stickTexture() {
  if (stick) return stick;
  const W = 32, H = 128, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = Math.min(y, H - 1 - y) / (W / 2);           // 0 at the ends
    for (let x = 0; x < W; x++) {
      const u = Math.abs(x + 0.5 - W / 2) / (W / 2);       // 0 in the middle
      const k = Math.exp(-u * u * 9) * Math.min(1, v) ** 0.5;
      const o = 4 * (y * W + x);
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 * k;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  stick = new THREE.CanvasTexture(c);
  stick.colorSpace = THREE.NoColorSpace;
  return stick;
}

function material(ud, tex, vcol, uv1, kind) {
  const shader = ud.shader || '', f = ud.floats || {}, c = ud.colors || {};
  // the background shaders (Gallop/3D/Bg) store vertex light at half brightness like their
  // lightmaps, 0.5 is plain. on racecourses the vertex colour means something else (white rails
  // come at 0.04), there it's left out
  const bg = shader.startsWith('Gallop/3D/Bg/');
  if (bg && kind === 'race') vcol = false;
  const k = bg && vcol ? 2 : 1;
  const tint = col => new THREE.Color(...(col || [1, 1, 1]).slice(0, 3)).multiplyScalar(k);
  const base = { map: tex._MainTex || null, vertexColors: vcol, side: f._Cull === 0 ? THREE.DoubleSide : THREE.FrontSide };
  // the backgrounds' baked light (and the night in a night variant): on the second UVs, stored at
  // half brightness like unity's lightmaps. three divides its lightmaps by pi
  if (tex._LightTex && uv1) {
    tex._LightTex.channel = 1;
    Object.assign(base, { lightMap: tex._LightTex, lightMapIntensity: 2 * Math.PI });
  }
  const glow = { side: THREE.DoubleSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false };
  if (/CyalumeDefault/.test(shader)) {
    // the song's stick sheet when the converter found one (it has the colours), else plain sticks
    return new THREE.MeshBasicMaterial({ ...glow, map: tex._MainTex || stickTexture(), color: tex._MainTex ? 0xffffff : STICK_COLOR });
  }
  // the sky's sun rays scroll faintly in the game; at full strength they'd fan out white
  if (ADD.test(shader)) return new THREE.MeshBasicMaterial({ ...base, ...glow, color: tint(c._MulColor0).multiplyScalar(/AlphaAdd/.test(shader) ? 0.3 : 1) });
  // the song's video plays on these in the game
  if (/Monitor/.test(shader)) return new THREE.MeshBasicMaterial({ color: 0x08080c });
  if (/Cutoff/.test(shader)) return new THREE.MeshBasicMaterial({ ...base, color: tint(c._Color), alphaTest: 0.5 });
  // trees, fences, stands: soft edges, but solid enough to keep their depth and sort themselves
  if (/Alpha/.test(shader)) return new THREE.MeshBasicMaterial({ ...base, color: tint(c._Color), transparent: true, alphaTest: 0.05 });
  if (BLEND.test(shader) || f._Mode >= 2) {
    return new THREE.MeshBasicMaterial({ ...base, color: tint(c._Color), transparent: true, depthWrite: false });
  }
  return new THREE.MeshBasicMaterial({ ...base, color: tint(c._Color) });
}

/** The converted stage from /api/stage/load: a group to add to the scene. */
export async function loadStage(info, renderer) {
  const gltf = await new GLTFLoader().loadAsync(info.base + 'model.gltf');
  const textures = new Map();
  const getTex = idx => {
    if (!textures.has(idx)) {
      textures.set(idx, gltf.parser.getDependency('texture', idx).then(t => {
        t.colorSpace = THREE.NoColorSpace;   // the game's values go out as they are, like hers
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return t;
      }));
    }
    return textures.get(idx);
  };
  const meshes = [];
  gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const ud = mesh.material.userData || {};
    const shader = ud.shader || '';
    const tex = {};
    for (const [slot, idx] of Object.entries(ud.textures || {})) tex[slot] = await getTex(idx);
    mesh.material.dispose();
    if (SKIP.test(shader)) { mesh.visible = false; continue; }
    mesh.material = material(ud, tex, !!mesh.geometry.attributes.color, !!mesh.geometry.attributes.uv1, info.id?.split(':')[0]);
    mesh.userData.stagePart = EFFECTS.test(mesh.name) || EFFECTS.test(mesh.parent?.name || '') ? 'effects'
      : LIGHTS.test(shader) ? 'lights' : CROWD.test(shader) ? 'crowd' : 'stage';
    if (mesh.userData.stagePart === 'lights') mesh.userData.full = mesh.material.color.clone();
    if (/sky|cloud/i.test(mesh.name)) {
      // the sky and clouds are hundreds of metres out: always behind, never hiding anything
      mesh.renderOrder = -10;
      mesh.material.depthWrite = false;
      // a sky's alpha is often left empty: it's drawn solid. an untextured one is a stand-in the
      // game replaces (racecourses carry one under the real sky)
      if (!tex._MainTex && mesh.material.name === 'Default-Material') mesh.visible = false;
      else if (!/cloud/i.test(mesh.name) && !ADD.test(shader)) Object.assign(mesh.material, { transparent: false, alphaTest: 0 });
    }
    mesh.frustumCulled = false;
  }
  // some places carry several versions of a piece in the same spot (a racecourse's signboards for
  // different races): the game shows one, drawn together they flicker through each other. the
  // first one stays (pieces come in name order), the rest can be shown from the outliner
  gltf.scene.updateMatrixWorld(true);
  const spots = new Set(), box = new THREE.Box3();
  for (const mesh of meshes) {
    if (!mesh.visible || mesh.material.blending === THREE.AdditiveBlending) continue;
    box.setFromObject(mesh);
    const key = mesh.name.replace(/_\d+$/, '') + ' ' + [...box.min.toArray(), ...box.max.toArray()].map(v => v.toFixed(2)).join(' ');
    if (spots.has(key)) mesh.visible = false;
    else spots.add(key);
  }
  gltf.scene.name = 'stage';
  return gltf.scene;
}

// light beams are flat quads along their local Y. the game's BillboardController turns each one
// about that axis to face the camera, else they show as white slabs edge-on and face-on
const _c = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Every frame before drawing: the beams turned toward the camera. */
export function faceCamera(group, camera) {
  if (!group?.visible) return;
  if (!group.userData.beams) {
    group.userData.beams = [];
    group.traverse(o => { if (o.isMesh && /billboard/i.test(o.name)) group.userData.beams.push({ o, rest: o.quaternion.clone() }); });
  }
  for (const { o, rest } of group.userData.beams) {
    if (!o.visible || !o.parent) continue;
    o.parent.worldToLocal(_c.copy(camera.position)).sub(o.position);
    _y.set(0, 1, 0).applyQuaternion(rest);
    _c.addScaledVector(_y, -_c.dot(_y));
    if (_c.lengthSq() < 1e-8) continue;
    _z.set(0, 0, 1).applyQuaternion(rest);
    const angle = Math.atan2(_z.clone().cross(_c).dot(_y), _z.dot(_c));
    o.quaternion.copy(_q.setFromAxisAngle(_y, angle)).multiply(rest);
  }
}

/** How bright the light rigs are (beams, bulbs, LED walls: 0 = off), the crowd and the song's
 *  effects on or off. With no song driving them the lights would all sit at full white, and
 *  dozens of beams stack up. */
export function showParts(group, { lights, crowd, effects }) {
  group.traverse(o => {
    if (!o.isMesh || !o.userData.stagePart || o.userData.userHidden) return;
    if (o.userData.stagePart === 'lights') {
      o.visible = lights > 0;
      o.material.color.copy(o.userData.full).multiplyScalar(lights);
    } else if (o.userData.stagePart === 'crowd') o.visible = crowd;
    else if (o.userData.stagePart === 'effects') o.visible = effects;
  });
}

/** Which of the switchable kinds of parts this place has (lights, crowd, effects). */
export function partKinds(group) {
  const out = new Set();
  group.traverse(o => { if (o.isMesh && o.userData.stagePart && o.userData.stagePart !== 'stage') out.add(o.userData.stagePart); });
  return out;
}
