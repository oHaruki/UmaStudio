import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fitBody } from '/static/bodyfit.js';

// animations from other humanoid rigs (mixamo, quaternius / unreal, vrm-style names) put on an
// uma's skeleton. per bone, the source's turn away from its rest pose is copied in the
// character's own space; where the two rest poses point a bone differently (an A-pose source on
// her T-pose), that difference is taken out first so arms don't end up raised or lowered. the
// hips also carry the bounce and sway, scaled to her height. her arms are then kept out of her
// body: the source's proportions differ, so hands and forearms can land inside her torso, her
// thighs or the other arm.

// source bone name (lowercased, separators and rig prefixes stripped) -> uma bone
const MAP = {};
const side = (names, uma) => {
  for (const [s, u] of [['l', 'L'], ['r', 'R']]) {
    const full = s === 'l' ? 'left' : 'right';
    for (const n of names) MAP[n.replace('{s}', s).replace('{side}', full)] = uma.replace('{S}', u);
  }
};
for (const [names, uma] of [
  [['hips', 'pelvis', 'hip', 'root_pelvis'], 'Hip'],
  [['spine', 'spine01', 'spine1st'], 'Waist'],
  [['spine1', 'spine02', 'chest'], 'Spine'],
  [['spine2', 'spine03', 'upperchest'], 'Chest'],
  [['neck', 'neck01'], 'Neck'],
  [['head'], 'Head'],
]) for (const n of names) MAP[n] = uma;
side(['{side}shoulder', 'clavicle{s}', 'shoulder{s}'], 'Shoulder_{S}');
side(['{side}arm', 'upperarm{s}', '{side}upperarm', 'arm{s}'], 'Arm_{S}');
side(['{side}forearm', 'lowerarm{s}', '{side}lowerarm', 'forearm{s}'], 'Elbow_{S}');
side(['{side}hand', 'hand{s}'], 'Wrist_{S}');
side(['{side}upleg', 'thigh{s}', '{side}upperleg', 'upperleg{s}'], 'Thigh_{S}');
side(['{side}leg', 'calf{s}', '{side}lowerleg', 'lowerleg{s}', 'shin{s}'], 'Knee_{S}');
side(['{side}foot', 'foot{s}'], 'Ankle_{S}');
side(['{side}toebase', 'ball{s}', '{side}toes', 'toes{s}'], 'Toe_{S}');
for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
  const uma = f[0].toUpperCase() + f.slice(1);
  for (let i = 1; i <= 3; i++) side([`{side}hand${f}${i}`, `${f}0${i}{s}`, `{side}${f}${i}`], `${uma}_0${i}_{S}`);
}
// mixamo's 'LeftArm' is the upper arm, while 'LeftLeg' is the shin: both handled above. a plain
// 'spine' that is the only spine bone stays on the waist.

const norm = n => n.replace(/^mixamorig[:_]?/i, '').replace(/^(def|bip\d*|j)[_:-]?/i, '').replace(/[\s_.:-]/g, '').toLowerCase();

/** Which uma bone a source bone drives, or null. */
export function umaBone(name) {
  return MAP[norm(name)] || null;
}

const loader = new GLTFLoader();
const files = new Map();     // url -> { scene, animations, rest }

/** A source file: its skeleton at rest and its clips. */
export async function loadSource(url) {
  if (!files.has(url)) {
    files.set(url, loader.loadAsync(url).then(g => {
      const rest = new Map();
      g.scene.traverse(o => rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
      return { scene: g.scene, animations: g.animations, rest };
    }));
  }
  return files.get(url);
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** World rotation and position relative to a root (her group may be turned and moved). */
function relQuat(o, rootInv, out) { return out.copy(rootInv).multiply(o.getWorldQuaternion(_q2)); }
function relPos(o, rootMatInv, out) { return o.getWorldPosition(out).applyMatrix4(rootMatInv); }

function firstMappedChild(o, mapped) {
  for (const c of o.children) {
    if (mapped.has(c)) return c;
    const d = firstMappedChild(c, mapped);
    if (d) return d;
  }
  return null;
}

/**
 * The clip baked onto her bones. cur: the loaded character (root, rest). opts.inPlace keeps her
 * where she stands (the hips still bob). Returns a THREE.AnimationClip.
 */
export function retarget(src, clip, cur, { fps = 30, inPlace = true } = {}) {
  const sRoot = src.scene, dRoot = cur.root;
  // both at rest
  for (const [o, [p, q, s]] of src.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  const saved = new Map();
  for (const [o, [p, q, s]] of cur.rest) { saved.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]); o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  sRoot.updateMatrixWorld(true);
  dRoot.updateMatrixWorld(true);
  const sInv = sRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const dInv = dRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const sMatInv = sRoot.matrixWorld.clone().invert();
  const dMatInv = dRoot.matrixWorld.clone().invert();

  // pairs, in her hierarchy order so parents are posed before children
  const byUma = new Map();
  sRoot.traverse(o => {
    const u = (o.isBone || o.type === 'Object3D') && umaBone(o.name);
    if (u && !byUma.has(u)) byUma.set(u, o);
  });
  const pairs = [];
  dRoot.traverse(o => { if (o.isBone && byUma.has(o.name)) pairs.push({ d: o, s: byUma.get(o.name) }); });
  // half a mapped skeleton would leave her arms or legs stuck in the rest pose
  const have = new Set(pairs.map(p => p.d.name));
  const core = ['Hip', 'Head', 'Arm_L', 'Arm_R', 'Elbow_L', 'Elbow_R', 'Thigh_L', 'Thigh_R', 'Knee_L', 'Knee_R'];
  const missing = core.filter(n => !have.has(n));
  if (missing.length) throw new Error(`that animation's skeleton doesn't match a humanoid one (no ${missing.join(', ')})`);
  const srcMapped = new Set(pairs.map(p => p.s)), dstMapped = new Set(pairs.map(p => p.d));
  const pairOfS = new Map(pairs.map(p => [p.s, p]));

  for (const p of pairs) {
    p.rs0 = relQuat(p.s, sInv, new THREE.Quaternion());
    p.rd0 = relQuat(p.d, dInv, new THREE.Quaternion());
    // where the two rest poses point the bone differently: the turn from hers to the source's
    p.fix = new THREE.Quaternion();
    const sc = firstMappedChild(p.s, srcMapped);
    const dc = sc && pairOfS.get(sc)?.d;
    if (sc && dc) {
      const ds = relPos(sc, sMatInv, new THREE.Vector3()).sub(relPos(p.s, sMatInv, _v)).normalize();
      const dd = relPos(dc, dMatInv, new THREE.Vector3()).sub(relPos(p.d, dMatInv, _v2)).normalize();
      if (ds.lengthSq() > 0.5 && dd.lengthSq() > 0.5) p.fix.setFromUnitVectors(dd, ds);
    }
    // the parent's rest, relative to the root, for turning world targets into local ones
  }
  const hip = pairs.find(p => p.d.name === 'Hip');
  const sHip0 = relPos(hip.s, sMatInv, new THREE.Vector3());
  const dHip0 = relPos(hip.d, dMatInv, new THREE.Vector3());
  // her hips are lower or higher than the source's: moves scale with that
  const k = sHip0.y > 1e-4 ? dHip0.y / sHip0.y : 1;
  const hipRest = cur.rest.get(hip.d)[0].clone();

  const mixer = new THREE.AnimationMixer(sRoot);
  const action = mixer.clipAction(clip);
  action.play();
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(n);
  const quats = pairs.map(() => new Float32Array(n * 4));
  const hipPos = new Float32Array(n * 3);
  const target = new THREE.Quaternion(), parent = new THREE.Quaternion();
  const guard = armGuard(cur);
  const feet = ['L', 'R'].map(S => [dRoot.getObjectByName(`Ankle_${S}`), dRoot.getObjectByName(`Toe_${S}`)]).filter(f => f[0]);
  const feetAt = feet.map(() => new Float32Array(n * 3));   // ankle x, z from the hips, the foot's lowest point
  const hipW = new THREE.Vector3(), footW = new THREE.Vector3(), toeW = new THREE.Vector3();
  let x0 = 0, z0 = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.duration, i / fps);
    times[i] = t;
    mixer.setTime(t);
    sRoot.updateMatrixWorld(true);
    pairs.forEach((p, j) => {
      // target = source's turn since rest, applied to her rest with the rest difference taken out
      relQuat(p.s, sInv, target).multiply(_q.copy(p.rs0).invert()).multiply(p.fix).multiply(p.rd0);
      if (p.d.parent && p.d.parent !== dRoot) relQuat(p.d.parent, dInv, parent); else parent.identity();
      p.d.quaternion.copy(parent.invert().multiply(target));
      p.d.updateMatrixWorld(true);
    });
    guard();
    pairs.forEach((p, j) => p.d.quaternion.toArray(quats[j], i * 4));
    // hips: the source's move since rest, scaled, in the hip's parent space
    const pos = relPos(hip.s, sMatInv, _v).sub(sHip0).multiplyScalar(k);
    // the feet: where they are from her hips, and how high with the hips' bob
    hip.d.getWorldPosition(hipW);
    feet.forEach(([ankle, toe], j) => {
      ankle.getWorldPosition(footW);
      const low = toe ? Math.min(footW.y, toe.getWorldPosition(toeW).y) : footW.y;
      feetAt[j].set([footW.x - hipW.x, footW.z - hipW.z, low + pos.y], i * 3);
    });
    if (i === 0) { x0 = pos.x; z0 = pos.z; }
    if (inPlace) { pos.x -= x0; pos.z -= z0; }
    if (hip.d.parent && hip.d.parent !== dRoot) {
      relQuat(hip.d.parent, dInv, parent);
      _m.makeRotationFromQuaternion(parent.invert());
      pos.applyMatrix4(_m);
      // and the parent's scale (the converted skeletons can carry one)
      const ps = hip.d.parent.getWorldScale(_v2).divide(dRoot.getWorldScale(new THREE.Vector3()));
      pos.divide(ps);
    }
    pos.add(hipRest).toArray(hipPos, i * 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(sRoot);
  // her bones back as they were, the motion will pose them from here
  for (const [o, [p, q, s]] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }

  const tracks = pairs.map((p, j) => new THREE.QuaternionKeyframeTrack(THREE.PropertyBinding.sanitizeNodeName(p.d.name) + '.quaternion', times, quats[j]));
  tracks.push(new THREE.VectorKeyframeTrack('Hip.position', times, hipPos));
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  out.groundSpeed = inPlace ? groundSpeed(feetAt, fps) : 0;
  return out;
}

/** How fast a clip played in place would cover ground (m/s): the speed a planted foot moves
 *  back under her, 0 when her feet don't travel (standing, sitting). */
function groundSpeed(feetAt, fps) {
  const speeds = [];
  for (const a of feetAt) {
    const n = a.length / 3;
    let low = Infinity;
    for (let i = 0; i < n; i++) low = Math.min(low, a[i * 3 + 2]);
    for (let i = 1; i < n; i++) {
      // planted: heel or toe near its lowest on both frames
      if (a[i * 3 + 2] - low > 0.03 || a[i * 3 - 1] - low > 0.03) continue;
      speeds.push(Math.hypot(a[i * 3] - a[i * 3 - 3], a[i * 3 + 1] - a[i * 3 - 2]) * fps);
    }
  }
  if (speeds.length < 4) return 0;
  speeds.sort((x, y) => x - y);
  const v = speeds[speeds.length >> 1];
  return v > 0.3 ? v : 0;
}

// --- arms out of her body ------------------------------------------------------------------------

const ARM_PASSES = 4;      // per arm, each frame
const ARM_SLACK = 0.008;   // m of overlap that is left alone (sleeves brushing the body)
const HAND_R = 0.025;
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3();
const _w = new THREE.Quaternion(), _turn = new THREE.Quaternion();

/** The closest points of segments p1q1 and p2q2 into c1, c2; returns their distance. */
function segSeg(p1, q1, p2, q2, c1, c2) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
  else if (a <= 1e-12) { t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-12) s = Math.max(0, Math.min(1, -c / a));
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  c1.copy(p1).addScaledVector(_d1, s);
  c2.copy(p2).addScaledVector(_d2, t);
  return c1.distanceTo(c2);
}

/** A per-frame step that turns each upper arm about its shoulder until her forearm and hand are
 *  outside her fitted body (bodyfit.js shapes) and the other arm. */
function armGuard(cur) {
  const root = cur.root;
  const shapes = (cur.bodyFit ??= fitBody(root)).map(c => ({ ...c, o: root.getObjectByName(c.bone) })).filter(c => c.o);
  const sides = ['L', 'R'].map(S => {
    const O = S === 'L' ? 'R' : 'L';
    const arm = root.getObjectByName(`Arm_${S}`), elbow = root.getObjectByName(`Elbow_${S}`), wrist = root.getObjectByName(`Wrist_${S}`);
    if (!arm || !elbow || !wrist) return null;
    const tip = root.getObjectByName(`Middle_02_${S}`) || root.getObjectByName(`Middle_01_${S}`);
    const f = shapes.find(c => c.bone === `Elbow_${S}`), fore = f ? f.outer ?? f.r : 0.03;
    // her torso, neck and legs, and the other arm. not her own arm or either shoulder
    const blocks = shapes.filter(c => /^(Waist|Spine|Chest|Neck|Thigh_[LR]|Knee_[LR])$/.test(c.bone) || c.bone === `Arm_${O}` || c.bone === `Elbow_${O}`);
    return { arm, elbow, wrist, tip, fore, blocks };
  }).filter(Boolean);
  if (!sides.length || !shapes.length) return () => {};
  const E = new THREE.Vector3(), W = new THREE.Vector3(), T = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
  const mine = new THREE.Vector3(), theirs = new THREE.Vector3(), best = new THREE.Vector3(), out = new THREE.Vector3();
  const pivot = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3(), sc = new THREE.Vector3();
  return () => {
    for (let pass = 0; pass < ARM_PASSES; pass++) {
      let moved = false;
      for (const s of sides) {
        s.elbow.getWorldPosition(E);
        s.wrist.getWorldPosition(W);
        if (s.tip) s.tip.getWorldPosition(T); else T.subVectors(W, E).setLength(0.07).add(W);
        let deepest = ARM_SLACK, found = false;
        for (const c of s.blocks) {
          const k = c.o.getWorldScale(sc).x;
          c.o.localToWorld(A.copy(c.a));
          c.o.localToWorld(B.copy(c.b));
          for (const [p, q, r] of [[E, W, s.fore], [W, T, HAND_R]]) {
            const d = segSeg(p, q, A, B, mine, theirs);
            const depth = (c.outer ?? c.r) * k + r - d;
            if (depth > deepest && d > 1e-6) { deepest = depth; found = true; best.copy(mine); out.subVectors(mine, theirs).normalize(); }
          }
        }
        if (!found) continue;
        // the smallest turn about the shoulder that takes that point out
        s.arm.getWorldPosition(pivot);
        from.subVectors(best, pivot);
        to.copy(best).addScaledVector(out, deepest).sub(pivot);
        if (from.lengthSq() < 1e-8) continue;
        _turn.setFromUnitVectors(from.normalize(), to.normalize());
        s.arm.getWorldQuaternion(_w).premultiply(_turn);
        s.arm.parent.getWorldQuaternion(_q).invert();
        s.arm.quaternion.copy(_q.multiply(_w));
        s.arm.updateMatrixWorld(true);
        moved = true;
      }
      if (!moved) break;
    }
  };
}
