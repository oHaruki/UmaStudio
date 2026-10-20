import * as THREE from 'three';

// body colliders for the springs, fitted to the outfit she wears. the game gives hair and ties a
// handful of hand-placed spheres around the shoulders and chest, which leaves gaps once the arms
// or the torso turn. these fill them: a capsule lying across each torso bone (wide as the
// outfit, round as it is deep), and one along the neck, shoulders, arms and thighs. all from the
// bind pose, so the pose she's in doesn't matter. sent to the game's solver as extra collision
// objects (cyspring.py), so they behave like the game's own.

const TORSO = [['Waist', 'Spine'], ['Spine', 'Chest'], ['Chest', 'Neck']];
const LIMBS = [['Neck', 'Head', 0.5], ...['L', 'R'].flatMap(s => [
  [`Shoulder_${s}`, `Arm_${s}`, 0.5], [`Arm_${s}`, `Elbow_${s}`, 0.4], [`Elbow_${s}`, `Wrist_${s}`, 0.4], [`Thigh_${s}`, `Knee_${s}`, 0.4]])];
const MIN_WEIGHT = 0.6;   // a vertex counts for the bone that moves it at least this much

const quantile = (arr, k) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(k * (s.length - 1))))];
};

/** The outfit's vertices per bone, in that bone's bind-pose space (three's axes). */
function vertsByBone(mesh, names) {
  const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses;
  const want = new Map();
  bones.forEach((b, j) => { if (names.has(b.name)) want.set(j, []); });
  const v = new THREE.Vector3(), l = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    for (let k = 0; k < 4; k++) {
      const j = si.getComponent(i, k);
      if (sw.getComponent(i, k) < MIN_WEIGHT || !want.has(j)) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
      l.copy(v).applyMatrix4(inv[j]);
      want.get(j).push(l.clone());
    }
  }
  const out = new Map();
  for (const [j, list] of want) out.set(bones[j].name, { index: j, verts: list });
  return out;
}

/** Where bone `to` sits in bone `from`'s bind space. */
function boneIn(mesh, from, to) {
  const bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses;
  const i = bones.findIndex(b => b.name === from), j = bones.findIndex(b => b.name === to);
  if (i < 0 || j < 0) return null;
  const toWorld = new THREE.Matrix4().copy(inv[j]).invert();
  return new THREE.Vector3().setFromMatrixPosition(toWorld).applyMatrix4(inv[i]);
}

/** Capsules / spheres in each bone's space: { bone, a, b, r } (three's axes, b = a for a sphere). */
export function fitBody(root) {
  let mesh = null;
  root.traverse(o => { if (!mesh && o.isSkinnedMesh && /^M_Body/.test(o.name) && o.geometry.attributes.skinIndex) mesh = o; });
  if (!mesh) return [];
  const names = new Set(LIMBS.map(t => t[0]));
  const byBone = vertsByBone(mesh, names);
  const out = [];

  // torso: the outfit sliced by height between the spine joints, one capsule across each slice.
  // left-right comes from the upper arms, up from waist to neck (bind pose, skeleton space)
  const bind = name => {
    const j = mesh.skeleton.bones.findIndex(b => b.name === name);
    return j < 0 ? null : { j, p: new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(mesh.skeleton.boneInverses[j]).invert()) };
  };
  const joints = Object.fromEntries(['Waist', 'Spine', 'Chest', 'Neck', 'Arm_L', 'Arm_R'].map(n => [n, bind(n)]));
  if (Object.values(joints).every(Boolean)) {
    const up = joints.Neck.p.clone().sub(joints.Waist.p).normalize();
    const side = joints.Arm_R.p.clone().sub(joints.Arm_L.p);
    side.addScaledVector(up, -side.dot(up)).normalize();
    const depth = new THREE.Vector3().crossVectors(up, side).normalize();
    const torso = new Set(TORSO.map(t => joints[t[0]].j));
    const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const pts = [], v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (torso.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
      if (w >= MIN_WEIGHT) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix).clone());
    }
    for (const [bone, next] of TORSO) {
      const h0 = joints[bone].p.dot(up), h1 = joints[next].p.dot(up);
      const X = [], Z = [];
      for (const p of pts) {
        const h = p.dot(up);
        if (h >= h0 && h <= h1) { X.push(p.dot(side)); Z.push(p.dot(depth)); }
      }
      if (X.length < 30) continue;
      // the slice is a ring of surface points: its semi-axes are about √2 σ, which a bow or a
      // belt buckle moves far less than the extremes would
      const mean = A => A.reduce((s, x) => s + x, 0) / A.length;
      const xm = mean(X), zc = mean(Z);
      const ax = Math.SQRT2 * Math.sqrt(mean(X.map(x => (x - xm) ** 2)));
      const r = Math.SQRT2 * Math.sqrt(mean(Z.map(z => (z - zc) ** 2)));
      const x0 = xm - ax, x1 = xm + ax, hc = (h0 + h1) / 2;
      const inv = mesh.skeleton.boneInverses[joints[bone].j];
      const at = x => up.clone().multiplyScalar(hc).addScaledVector(side, x).addScaledVector(depth, zc).applyMatrix4(inv);
      if (x1 - x0 > 2 * r) out.push({ bone, a: at(x0 + r), b: at(x1 - r), r });
      else out.push({ bone, a: at((x0 + x1) / 2), b: at((x0 + x1) / 2), r: Math.max(r, (x1 - x0) / 2) });
    }
  }

  // limbs: along the bone, as thick as most of the outfit around it
  for (const [bone, next, k] of LIMBS) {
    const got = byBone.get(bone), end = boneIn(mesh, bone, next);
    if (!got || got.verts.length < 20 || !end) continue;
    const len = end.length(), a = end.clone().normalize();
    const S = [], R = [];
    for (const p of got.verts) {
      const s = p.dot(a);
      if (s < 0 || s > len) continue;
      S.push(s);
      R.push(p.clone().addScaledVector(a, -s).length());
    }
    if (S.length < 20) continue;
    const r = quantile(R, k);
    const s0 = Math.max(quantile(S, 0.05), r * 0.5), s1 = Math.min(quantile(S, 0.95), len - r * 0.5);
    if (s1 <= s0) continue;
    out.push({ bone, a: a.clone().multiplyScalar(s0), b: a.clone().multiplyScalar(s1), r });
  }
  return out;
}
