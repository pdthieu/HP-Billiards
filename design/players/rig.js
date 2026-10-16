// rig.js: a player as Three.js meshes on a skeleton, and the poses: standing
// with the cue, sitting on the chair, and down on a shot (solved from the
// cue). Coordinates are the player's own: the floor at y = 0, facing +z.
import * as THREE from '/vendor/three-r186/three.min.js';
import * as S from './sdf.js';
import { build, paint, BONES, GRIP, BRIDGE } from './body.js';

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const CUE_SEGMENTS = [
  [0, 0.010, '#2F5F8A'], [0.010, 0.030, '#F2EEE3'], [0.030, 0.720, ['#EEE1C4', '#C9A56C']],
  [0.720, 0.735, '#D8C59C'], [0.735, 0.900, '#6B4325'], [0.900, 1.130, '#1C1916'], [1.130, 1.200, '#2A1A0F'],
];
export const CUE_LEN = 1.2;
export const BED = 0.78; // the bed's height above the floor (view3d.js FLOOR)

// --- materials ----------------------------------------------------------
// masked: a material whose colour the vertex's masks (aMask, signed: the
// thing shows where its value is below 0) can change in the shader, so the
// edges are as sharp as the screen, not as the mesh
// With `only` (two bone indices), a skinned mesh can show just the skin
// those bones carry: the arm on the cloth, seen through the shooter's eyes.
function masked(base, uniforms, glsl, only = null) {
  const m = new THREE.MeshPhysicalMaterial(base);
  const uOnly = { value: 0 };
  m.userData.only = uOnly;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.uniforms.uOnly = uOnly;
    const decl = Object.keys(uniforms).map((k) => `uniform vec3 ${k};`).join('\n');
    const pick = only ? `vOnly = 0.0; for (int i = 0; i < 4; i++) { float b = skinIndex[i]; if (abs(b - ${only[0].toFixed(1)}) < 0.5 || abs(b - ${only[1].toFixed(1)}) < 0.5) vOnly += skinWeight[i]; }` : 'vOnly = 1.0;';
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aMask;\nvarying vec3 vMask;\nvarying float vOnly;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMask = aMask;\n${only ? '#ifdef USE_SKINNING\n' + pick + '\n#else\nvOnly = 1.0;\n#endif' : pick}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${decl}\nuniform float uOnly;\nvarying vec3 vMask;\nvarying float vOnly;\nfloat shows(float v) { float w = max(fwidth(v), 1e-5) * 0.8; return 1.0 - smoothstep(-w, w, v); }`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (uOnly > 0.5 && vOnly < 0.5) discard;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + glsl);
  };
  m.customProgramCacheKey = () => glsl + (only ? 'only' : '');
  return m;
}
function materials(look, armBones) {
  const col = (h) => ({ value: new THREE.Color(h) });
  // the body: the vertex colour is the waistcoat's; x: in the waistcoat,
  // y: on the trousers, z: on the torso (not a sleeve)
  const cloth = masked({ vertexColors: true, roughness: 0.78, sheen: 0.45, sheenRoughness: 0.55, sheenColor: new THREE.Color('#9a9a9a') },
    { uShirt: col(look.shirt), uTrousers: col(look.trousers) },
    `float vest = shows(vMask.x) * shows(-vMask.z);
    vec3 top = mix(uShirt, diffuseColor.rgb, vest);
    diffuseColor.rgb = mix(top, uTrousers, shows(vMask.y));`, armBones);
  const glow = new THREE.Color(look.skin).multiplyScalar(0.07);
  const skin = masked({ vertexColors: true, roughness: 0.52, sheen: 0.25, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffd2bf'), emissive: glow },
    { uBrow: col(look.browColor), uLash: col('#120d0b'), uLip: col(look.lip) },
    `diffuseColor.rgb = mix(diffuseColor.rgb, uLip, shows(vMask.z) * 0.8);
    diffuseColor.rgb = mix(diffuseColor.rgb, uBrow, shows(vMask.x) * 0.82);
    diffuseColor.rgb = mix(diffuseColor.rgb, uLash, shows(vMask.y) * 0.95);`);
  const plainSkin = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.52, sheen: 0.25, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffd2bf'), emissive: glow });
  const shirt = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.78, sheen: 0.45, sheenRoughness: 0.55, sheenColor: new THREE.Color('#9a9a9a') });
  const hair = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.58, sheen: 0.5, sheenRoughness: 0.5, sheenColor: new THREE.Color('#3a302a') });
  const leather = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.28, clearcoat: 0.9, clearcoatRoughness: 0.12 });
  const satin = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, sheen: 0.7, sheenRoughness: 0.3, sheenColor: new THREE.Color('#5a5a66') });
  return { cloth, skin, plainSkin, shirt, hair, leather, satin };
}

function eyeTexture(iris) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  // the white, shaded towards the top where the lid overhangs it
  const sc = g.createLinearGradient(0, 0, 0, 256);
  sc.addColorStop(0, '#8d8079'); sc.addColorStop(0.36, '#d9d0c6'); sc.addColorStop(0.6, '#e6ded5'); sc.addColorStop(1, '#cfc5ba');
  g.fillStyle = sc; g.fillRect(0, 0, 512, 256);
  const cx = 128, cy = 128, r = 47;
  const ir = g.createRadialGradient(cx, cy, 4, cx, cy, r);
  ir.addColorStop(0, '#050403'); ir.addColorStop(0.34, '#050403'); ir.addColorStop(0.38, iris);
  ir.addColorStop(0.7, iris); ir.addColorStop(0.9, '#1e130c'); ir.addColorStop(1, '#0d0806');
  g.fillStyle = ir; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,214,170,0.10)'; g.lineWidth = 1.2;
  for (let a = 0; a < Math.PI * 2; a += 0.14) { g.beginPath(); g.moveTo(cx + Math.cos(a) * 18, cy + Math.sin(a) * 18); g.lineTo(cx + Math.cos(a) * 40, cy + Math.sin(a) * 40); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cueTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  for (const [a, b, colour] of CUE_SEGMENTS) {
    const y0 = a / CUE_LEN * 512, y1 = b / CUE_LEN * 512;
    if (Array.isArray(colour)) {
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, colour[0]); gr.addColorStop(1, colour[1]);
      g.fillStyle = gr;
    } else g.fillStyle = colour;
    g.fillRect(0, y0, 4, y1 - y0 + 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// makeCue: a cue whose origin is its tip, pointing along its +z
export function makeCue() {
  const geo = new THREE.CylinderGeometry(0.0065, 0.0145, CUE_LEN, 24, 1);
  geo.translate(0, -CUE_LEN / 2, 0); // tip at the origin, butt down −y
  geo.rotateX(-Math.PI / 2);         // −y → +z… then the butt is at +z
  geo.rotateY(Math.PI);               // butt at −z, tip at the origin
  const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ map: cueTexture(), roughness: 0.35, clearcoat: 0.6 }));
  m.castShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

// --- geometry -----------------------------------------------------------
function geometry(m, classes, weights) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
  const col = new Float32Array(m.col.length);
  for (let i = 0; i < col.length; i++) col[i] = srgbToLinear(m.col[i]);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (m.mask) g.setAttribute('aMask', new THREE.BufferAttribute(m.mask, 3));
  if (weights) {
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(weights.index, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights.weight, 4));
  }
  // triangles sorted by material class, one group per class
  const tris = m.idx.length / 3, byClass = classes.map(() => []);
  for (let t = 0; t < tris; t++) {
    const a = m.idx[t * 3], b = m.idx[t * 3 + 1], c = m.idx[t * 3 + 2];
    const la = m.layer[a], lb = m.layer[b], lc = m.layer[c];
    const l = la === lb || la === lc ? la : lb === lc ? lb : la;
    byClass[m.classOf[l]].push(a, b, c);
  }
  const idx = new Uint32Array(m.idx.length);
  let at = 0;
  byClass.forEach((list, ci) => { idx.set(list, at); if (list.length) g.addGroup(at, list.length, ci); at += list.length; });
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function meshPart(part) {
  return paint(part, S.mesh(part.shape, part.lo, part.hi, part.h));
}

// skin weights: each bone pulls the skin near the line from its joint to
// the next, falling off past its radius
function skinWeights(m, segs, names) {
  const n = m.pos.length / 3, index = new Uint16Array(n * 4), weight = new Float32Array(n * 4);
  const w = new Float64Array(segs.length);
  for (let i = 0; i < n; i++) {
    const p = [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
    for (let s = 0; s < segs.length; s++) {
      const { a, b, r, sigma } = segs[s];
      const ab = S.sub(b, a), t = Math.max(0, Math.min(1, S.dot(S.sub(p, a), ab) / S.dot(ab, ab)));
      const d = S.len(S.sub(p, S.add(a, S.scale(ab, t))));
      w[s] = Math.exp(-Math.max(0, d - r) / sigma);
    }
    const order = [...w.keys()].sort((x, y) => w[y] - w[x]).slice(0, 4);
    let sum = 0;
    for (const o of order) sum += w[o];
    order.forEach((o, j) => { index[i * 4 + j] = names.indexOf(segs[o].bone); weight[i * 4 + j] = w[o] / sum; });
  }
  return { index, weight };
}

// --- the player ---------------------------------------------------------
export function createPlayer(look) {
  const B = build(look), J = B.J;
  const M = materials(look, [BONES.findIndex((b) => b[0] === 'fore.L'), BONES.findIndex((b) => b[0] === 'hand.L')]);
  const root = new THREE.Group();
  root.name = look.id;

  // skeleton
  const bones = {}, list = [], names = BONES.map((b) => b[0]);
  for (const [name, parent, joint] of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    const jp = J[joint], pp = parent ? J[BONES.find((x) => x[0] === parent)[2]] : [0, 0, 0];
    b.position.set(jp[0] - pp[0], jp[1] - pp[1], jp[2] - pp[2]);
    bones[name] = b;
    list.push(b);
    if (parent) bones[parent].add(b);
  }
  root.add(bones.pelvis);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);

  const up = (j, dy) => S.add(J[j], [0, dy, 0]);
  const torsoR = { pelvis: 0.15, spine1: 0.13, spine2: 0.14, chest: 0.15 };
  const segs = [
    { bone: 'pelvis', a: [0, J.hipL[1] - 0.06, 0], b: J.spine1, r: torsoR.pelvis, sigma: 0.025 },
    { bone: 'spine1', a: J.spine1, b: J.spine2, r: torsoR.spine1, sigma: 0.025 },
    { bone: 'spine2', a: J.spine2, b: J.chest, r: torsoR.spine2, sigma: 0.025 },
    { bone: 'chest', a: J.chest, b: S.lerp(J.chest, J.neck, 0.8), r: torsoR.chest, sigma: 0.025 },
    { bone: 'neck', a: J.neck, b: J.head, r: 0.045, sigma: 0.02 },
    { bone: 'head', a: J.head, b: up('head', 0.18), r: 0.085, sigma: 0.02 },
  ];
  for (const s of ['L', 'R']) {
    segs.push(
      { bone: 'clav.' + s, a: J['clav' + s], b: J['shoulder' + s], r: 0.035, sigma: 0.02 },
      { bone: 'arm.' + s, a: J['shoulder' + s], b: J['elbow' + s], r: 0.045, sigma: 0.022 },
      { bone: 'fore.' + s, a: J['elbow' + s], b: J['wrist' + s], r: 0.038, sigma: 0.022 },
      { bone: 'thigh.' + s, a: J['hip' + s], b: J['knee' + s], r: 0.075, sigma: 0.025 },
      { bone: 'shin.' + s, a: J['knee' + s], b: J['ankle' + s], r: 0.055, sigma: 0.025 });
  }

  const shadowy = (o) => { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; return o; };
  // body
  const bm = meshPart(B.body);
  bm.classOf = [0, 0, 0];
  const body = shadowy(new THREE.SkinnedMesh(geometry(bm, ['cloth'], skinWeights(bm, segs.filter((s) => s.bone !== 'head'), names)), [M.cloth]));
  root.add(body);
  body.bind(skeleton, body.matrixWorld);
  // head and neck
  const hm = meshPart(B.head);
  hm.classOf = [0, 1];
  const headSegs = segs.filter((s) => ['chest', 'neck', 'head'].includes(s.bone)).map((s) => s.bone === 'head' ? { ...s, a: S.add(J.head, [0, 0.0, 0]) } : s);
  const head = shadowy(new THREE.SkinnedMesh(geometry(hm, ['skin', 'hair'], skinWeights(hm, headSegs, names)), [M.skin, M.hair]));
  root.add(head);
  head.bind(skeleton, head.matrixWorld);

  // rigid parts ride on their bone; built where they sit in the bind pose
  const attach = (bone, g, mats, at) => {
    const mesh = shadowy(new THREE.Mesh(g, mats));
    mesh.position.set(-at[0], -at[1], -at[2]);
    bones[bone].add(mesh);
    return mesh;
  };
  const one = (part, cls) => { const m = meshPart(part); m.classOf = part.layers.map(() => 0); return { m, g: geometry(m, [cls]) }; };
  const shoe = one(B.shoe, 'leather');
  attach('foot.L', shoe.g, [M.leather], J.ankleL);
  attach('foot.R', geometry(S.mirrorX(shoe.m), ['leather']), [M.leather], J.ankleR);
  const cuff = one(B.cuff, 'cloth');
  attach('fore.L', cuff.g, [M.shirt], J.elbowL);
  attach('fore.R', geometry(S.mirrorX(cuff.m), ['cloth']), [M.shirt], J.elbowR);
  const cm = meshPart(B.collar);
  cm.classOf = B.collar.layers.map((l) => (l.name === 'satin' ? 1 : 0));
  attach('neck', geometry(cm, ['cloth', 'satin']), [M.shirt, M.satin], J.neck);
  // buttons
  const btnGeo = new THREE.SphereGeometry(0.0068, 16, 8);
  btnGeo.scale(1, 1, 0.38);
  const btnMat = new THREE.MeshPhysicalMaterial({ color: look.button, roughness: 0.3, clearcoat: 0.5 });
  B.buttons.forEach((b, i) => {
    const bone = b[1] > J.spine2[1] ? 'spine2' : b[1] > J.spine1[1] ? 'spine1' : 'pelvis';
    const m = new THREE.Mesh(btnGeo, btnMat);
    const o = J[bone];
    m.position.set(b[0] - o[0], b[1] - o[1], b[2] - o[2]);
    m.castShadow = true;
    bones[bone].add(m);
  });
  // eyes
  const eyeGeo = new THREE.SphereGeometry(B.head.eyeR, 32, 16);
  const eyeMat = new THREE.MeshPhysicalMaterial({ map: eyeTexture(look.iris), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.04 });
  const eyes = B.head.eyes.map((c) => {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    const o = J.head;
    e.position.set(c[0] - o[0], c[1] - o[1], c[2] - o[2]);
    bones.head.add(e);
    return e;
  });

  // hands: built in the hand's own frame, turned to the bind pose's
  const handFrame = (side) => {
    const sx = side === 'L' ? 1 : -1;
    const d = [J.armDir[0] * sx, J.armDir[1], J.armDir[2]];
    const t = [0, 0, 1];
    const n = side === 'L' ? S.cross(t, d) : S.scale(S.cross(t, d), -1);
    return { d, t, n, w: J['wrist' + side] };
  };
  const toBind = (m, side) => {
    const F = handFrame(side), pos = new Float32Array(m.pos.length), nrm = new Float32Array(m.nrm.length);
    const sx = side === 'L' ? 1 : -1;
    for (let i = 0; i < m.pos.length; i += 3) {
      const x = m.pos[i] * sx, y = m.pos[i + 1], z = m.pos[i + 2];
      const nx = m.nrm[i] * sx, ny = m.nrm[i + 1], nz = m.nrm[i + 2];
      // canonical x is the thumb's side, which for the right hand mirrors
      for (let k = 0; k < 3; k++) {
        pos[i + k] = F.w[k] + x * sx * F.t[k] * sx + y * F.d[k] + z * F.n[k];
        nrm[i + k] = nx * sx * F.t[k] * sx + ny * F.d[k] + nz * F.n[k];
      }
    }
    const idx = m.idx.slice();
    if (side === 'R') for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    return { ...m, pos, nrm, idx };
  };
  const hands = { L: {}, R: {} };
  for (const [pose, part] of Object.entries(B.hands)) {
    const m = meshPart(part);
    m.classOf = [0];
    for (const side of ['L', 'R']) {
      const mm = toBind(side === 'L' ? m : { ...m, pos: mirrorCanon(m.pos), nrm: mirrorCanon(m.nrm) }, side);
      const mesh = attach('hand.' + side, geometry(mm, ['skin']), [M.plainSkin], J['wrist' + side]);
      mesh.visible = pose === 'relaxed';
      hands[side][pose] = mesh;
    }
  }

  const player = { look, root, bones, skeleton, J, B, hands, eyes, body, head, materials: M };
  player.handFrame = handFrame;
  // more light from the room on them than on the cloth: they stand outside
  // the lamps' pool (envMapIntensity is per material)
  // firstPerson: only the bridge arm, its hand and its cuff show
  const rigid = [];
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) rigid.push(o); });
  const leftArm = new Set([...Object.values(hands.L), ...bones['fore.L'].children.filter((o) => o.isMesh)]);
  let fp = false;
  const refresh = () => {
    M.cloth.userData.only.value = fp ? 1 : 0;
    head.visible = !fp;
    for (const o of rigid) o.visible = o.userData.wanted !== false && (!fp || leftArm.has(o));
  };
  player.firstPerson = (on) => { fp = on; refresh(); };
  player.setHand = (side, pose) => { for (const [k, m] of Object.entries(hands[side])) m.userData.wanted = k === pose; refresh(); };
  player.setHand('L', 'relaxed'); player.setHand('R', 'relaxed');
  player.setRoomLight = (v) => { for (const m of Object.values(M)) m.envMapIntensity = v; eyeMat.envMapIntensity = v; btnMat.envMapIntensity = v; };
  return player;
}
// the canonical hand is a left one; a right one mirrors its x in that frame
function mirrorCanon(a) { const b = a.slice(); for (let i = 0; i < b.length; i += 3) b[i] = -b[i]; return b; }

// --- posing -------------------------------------------------------------
// All in the player's own space (its root's). A bone's turn there is the
// product of its parents' and its own; in the bind pose every one is none.
const tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
function charQuat(player, bone) {
  const q = new THREE.Quaternion();
  for (let b = bone; b && b !== player.root; b = b.parent) q.premultiply(b.quaternion);
  return q;
}
function charPos(player, bone) {
  player.root.updateMatrixWorld(true);
  tmpM.copy(player.root.matrixWorld).invert().multiply(bone.matrixWorld);
  return new THREE.Vector3().setFromMatrixPosition(tmpM);
}
function setCharQuat(player, bone, q) {
  const pq = bone.parent && bone.parent !== player.root ? charQuat(player, bone.parent) : new THREE.Quaternion();
  bone.quaternion.copy(pq.invert().multiply(q));
}
const bindDir = (player, a, b) => V3(S.norm(S.sub(player.J[b], player.J[a])));
// twoBone: turns the upper and lower bone so the end reaches target, the
// middle joint bending towards pole; returns the middle joint's place
function twoBone(player, upper, lower, jA, jB, jC, target, pole) {
  const A = charPos(player, player.bones[upper]);
  const la = S.len(S.sub(player.J[jB], player.J[jA])), lb = S.len(S.sub(player.J[jC], player.J[jB]));
  const T = target.clone(), d = T.clone().sub(A);
  const L = Math.min(la + lb - 1e-4, Math.max(Math.abs(la - lb) + 1e-4, d.length()));
  d.normalize();
  const ca = (la * la + L * L - lb * lb) / (2 * la * L), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
  const pv = pole.clone().sub(A);
  pv.sub(d.clone().multiplyScalar(pv.dot(d))).normalize();
  const mid = A.clone().add(d.clone().multiplyScalar(la * ca)).add(pv.multiplyScalar(la * sa));
  const end = A.clone().add(d.multiplyScalar(L));
  const u1 = mid.clone().sub(A).normalize();
  const q1 = new THREE.Quaternion().setFromUnitVectors(bindDir(player, jA, jB), u1);
  setCharQuat(player, player.bones[upper], q1);
  const cur = bindDir(player, jB, jC).applyQuaternion(q1);
  const u2 = end.clone().sub(mid).normalize();
  const q2 = new THREE.Quaternion().setFromUnitVectors(cur, u2).multiply(q1);
  setCharQuat(player, player.bones[lower], q2);
  return mid;
}
// frameQuat: the turn taking the bind pair (a0, b0) to (a1, b1)
function frameQuat(a0, b0, a1, b1) {
  const basis = (a, b) => {
    const x = a.clone().normalize(), z = new THREE.Vector3().crossVectors(x, b).normalize(), y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const m = basis(a1, b1).multiply(basis(a0, b0).transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
// set a hand: its fingers along `distal`, its thumb's side along `thumb`
function placeHand(player, side, distal, thumb) {
  const F = player.handFrame(side);
  const q = frameQuat(V3(F.d), V3(F.t), distal, thumb);
  setCharQuat(player, player.bones['hand.' + side], q);
}
// where a point in a hand's own frame is in the player's space, given the
// hand's turn q and wrist w
function handPoint(player, side, q, w, local) {
  const F = player.handFrame(side), sx = side === 'L' ? 1 : -1;
  const p = S.add(S.add(S.scale(F.t, local[0] * sx * sx), S.scale(F.d, local[1])), S.scale(F.n, local[2]));
  return V3(p).applyQuaternion(q).add(w);
}
function handQuat(player, side, distal, thumb) {
  const F = player.handFrame(side);
  return frameQuat(V3(F.d), V3(F.t), distal, thumb);
}
// a vector of the hand's own frame, in the bind pose
function handVec(player, side, v) {
  const F = player.handFrame(side);
  return V3(S.add(S.add(S.scale(F.t, v[0]), S.scale(F.d, v[1])), S.scale(F.n, v[2])));
}
// gripQuat: the hand turned so its grip runs along cueDir (towards the
// tip), the fingers as near distal as that allows
export function gripQuat(player, side, cueDir, distal) {
  return frameQuat(handVec(player, side, GRIP.along), handVec(player, side, [0, 1, 0]), cueDir, distal);
}

export function resetPose(player) {
  for (const b of Object.values(player.bones)) b.quaternion.identity();
  const J = player.J;
  player.bones.pelvis.position.set(J.pelvis[0], J.pelvis[1], J.pelvis[2]);
}
// trunk: pelvis at hips (the middle of the hip joints), turned by qP; the
// chest turned by qC, the spine between them
function trunk(player, hips, qP, qC) {
  const J = player.J, b = player.bones;
  const hipMid = S.lerp(J.hipL, J.hipR, 0.5);
  const off = V3(S.sub(J.pelvis, hipMid)).applyQuaternion(qP);
  b.pelvis.position.copy(hips.clone().add(off));
  setCharQuat(player, b.pelvis, qP);
  setCharQuat(player, b.spine1, qP.clone().slerp(qC, 0.34));
  setCharQuat(player, b.spine2, qP.clone().slerp(qC, 0.68));
  setCharQuat(player, b.chest, qC);
}
// lookAt: neck and head share the turn that points the face at target
function look(player, target, share = 0.4, roll = 0) {
  const b = player.bones;
  player.root.updateMatrixWorld(true);
  const hp = charPos(player, b.head).add(new THREE.Vector3(0, 0.06, 0));
  const fwd = target.clone().sub(hp).normalize();
  const qC = charQuat(player, b.chest);
  // the face's forward is +z, up +y; keep the head upright-ish
  const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(qC).lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
  const qWant = frameQuat(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), fwd, upv);
  if (roll) qWant.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  const qN = qC.clone().slerp(qWant, share);
  setCharQuat(player, b.neck, qN);
  setCharQuat(player, b.head, qWant);
  for (const e of player.eyes) { e.parent.updateMatrixWorld(true); e.lookAt(player.root.localToWorld(target.clone())); }
}
// foot: ankle on target, the sole flat, pointing along dir
function foot(player, side, ankle, dir, kneePole) {
  const s = side;
  twoBone(player, 'thigh.' + s, 'shin.' + s, 'hip' + s, 'knee' + s, 'ankle' + s, ankle, kneePole);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().setY(0).normalize());
  setCharQuat(player, player.bones['foot.' + s], q);
}

// standing, the cue upright in the right hand, its butt by the right foot
export function stand(player, cue) {
  resetPose(player);
  const J = player.J, h = player.look.height / 1.78;
  const hips = V3(S.lerp(J.hipL, J.hipR, 0.5)).add(new THREE.Vector3(-0.018, -0.012, 0));
  const qP = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, 0.06, 0.03));
  const qC = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.05, -0.02, -0.025));
  trunk(player, hips, qP, qC);
  player.root.updateMatrixWorld(true);
  foot(player, 'R', new THREE.Vector3(J.ankleR[0] - 0.012, J.ankleL[1], J.ankleR[2] + 0.0), new THREE.Vector3(-0.15, 0, 1), new THREE.Vector3(-0.1, 0.5, 1));
  foot(player, 'L', new THREE.Vector3(J.ankleL[0] + 0.045, J.ankleL[1] + 0.004, J.ankleL[2] + 0.035), new THREE.Vector3(0.35, 0, 1), new THREE.Vector3(0.1, 0.5, 2));
  // the cue: butt on the floor beside the right foot, leaning a little out
  const butt = new THREE.Vector3(J.ankleR[0] - 0.13 * h, 0.0, J.ankleR[2] + 0.1);
  const cueDir = new THREE.Vector3(0.05, 1, -0.02).normalize();
  const tip = butt.clone().add(cueDir.clone().multiplyScalar(CUE_LEN));
  if (cue) { cue.position.copy(tip); cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cueDir); }
  // the right hand round the cue at the height of the hip
  const gripAt = butt.clone().add(cueDir.clone().multiplyScalar(0.98 * h));
  const qh = gripQuat(player, 'R', cueDir, new THREE.Vector3(0.45, 0, 0.9).normalize());
  const wristR = gripAt.clone().sub(handPoint(player, 'R', qh, new THREE.Vector3(), GRIP.at));
  twoBone(player, 'arm.R', 'fore.R', 'shoulderR', 'elbowR', 'wristR', wristR, new THREE.Vector3(-0.6, 0.6, -1));
  setCharQuat(player, player.bones['hand.R'], qh);
  player.setHand('R', 'grip');
  // the left arm hangs, a little out
  player.root.updateMatrixWorld(true);
  const shL = charPos(player, player.bones['arm.L']);
  twoBone(player, 'arm.L', 'fore.L', 'shoulderL', 'elbowL', 'wristL', shL.clone().add(new THREE.Vector3(0.06, -0.52 * h, 0.04)), shL.clone().add(new THREE.Vector3(0.2, -0.3, -0.5)));
  player.root.updateMatrixWorld(true);
  // the hand hangs on from the forearm, its palm to the thigh
  const elL = charPos(player, player.bones['fore.L']), wrL = charPos(player, player.bones['hand.L']);
  const along = wrL.clone().sub(elL).normalize();
  setCharQuat(player, player.bones['hand.L'], handQuat(player, 'L', along, new THREE.Vector3(0.1, 0, 1).normalize()));
  player.setHand('L', 'relaxed');
  player.root.updateMatrixWorld(true);
  look(player, new THREE.Vector3(0.1, 1.55 * h, 2.5), 0.35);
  player.root.updateMatrixWorld(true);
}

// on the chair (its seat seatH above the floor, its back behind, facing
// +z): sitting back, the cue upright between the knees in both hands
export function sit(player, cue, seatH = 0.49) {
  resetPose(player);
  const J = player.J, h = player.look.height / 1.78;
  const hips = new THREE.Vector3(0, seatH + 0.075, -0.06);
  const qP = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0, 0));
  const qC = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.02, 0.04, 0));
  trunk(player, hips, qP, qC);
  player.root.updateMatrixWorld(true);
  const kz = 0.4 * h;
  foot(player, 'L', new THREE.Vector3(J.hipL[0] + 0.03, J.ankleL[1], kz + 0.03), new THREE.Vector3(0.15, 0, 1), new THREE.Vector3(0.1, 1.2, 3));
  foot(player, 'R', new THREE.Vector3(J.hipR[0] - 0.03, J.ankleR[1], kz + 0.05), new THREE.Vector3(-0.15, 0, 1), new THREE.Vector3(-0.1, 1.2, 3));
  // the cue's butt on the floor between the feet, leaning back to the chest
  const butt = new THREE.Vector3(0.0, 0, kz + 0.1);
  const cueDir = new THREE.Vector3(0.0, 1, -0.22).normalize();
  if (cue) { cue.position.copy(butt.clone().add(cueDir.clone().multiplyScalar(CUE_LEN))); cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cueDir); }
  const g1 = butt.clone().add(cueDir.clone().multiplyScalar(0.82 * h));
  const g2 = butt.clone().add(cueDir.clone().multiplyScalar(0.72 * h));
  const qR = gripQuat(player, 'R', cueDir, new THREE.Vector3(0.55, 0, 0.85).normalize());
  const qL = gripQuat(player, 'L', cueDir, new THREE.Vector3(-0.55, 0, 0.85).normalize());
  const wR = g1.clone().sub(handPoint(player, 'R', qR, new THREE.Vector3(), GRIP.at));
  const wL = g2.clone().sub(handPoint(player, 'L', qL, new THREE.Vector3(), GRIP.at));
  twoBone(player, 'arm.R', 'fore.R', 'shoulderR', 'elbowR', 'wristR', wR, new THREE.Vector3(-0.6, 0.0, -0.1));
  setCharQuat(player, player.bones['hand.R'], qR);
  twoBone(player, 'arm.L', 'fore.L', 'shoulderL', 'elbowL', 'wristL', wL, new THREE.Vector3(0.6, 0.0, -0.1));
  setCharQuat(player, player.bones['hand.L'], qL);
  player.setHand('R', 'grip');
  player.setHand('L', 'grip');
  player.root.updateMatrixWorld(true);
  look(player, new THREE.Vector3(-0.3, 0.9, 2.5), 0.4);
  player.root.updateMatrixWorld(true);
}

// down on a shot. The cue ball sits at ball (player space, its centre), the
// shot along +z; elev raises the butt; pull is how far the cue is drawn
// back from the ball (stroke: 0 at the ball). The player stands behind it.
export function stance(player, cue, o = {}) {
  resetPose(player);
  const J = player.J, h = player.look.height / 1.78;
  const R = 0.028575, elev = (o.elev ?? 0) + 6 * Math.PI / 180, pull = o.pull ?? 0.03;
  const ball = o.ball || new THREE.Vector3(0, BED + R, 1.0);
  const f = new THREE.Vector3(0, 0, 1); // along the shot
  const back = new THREE.Vector3(0, Math.sin(elev), -Math.cos(elev)); // from the tip up to the butt
  const onCue = (s) => ball.clone().add(back.clone().multiplyScalar(s)); // s behind the ball's centre
  const tip = onCue(R + pull);
  if (cue) { cue.position.copy(tip); cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), back.clone().negate()); }
  const bed = BED;
  // where the body goes, behind the ball: s back along the shot, x to the
  // left of the cue line, y above the bed
  const at = (s, x, y) => new THREE.Vector3(ball.x + x, bed + y, ball.z - s);
  const hipMid = at(1.08 * h, 0.155, 0.085 * h + (h - 1) * 0.4);
  // pelvis: tipped forward, turned open to the left
  const turn = 0.3;
  const qP = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.15, -turn * 1.1, 0, 'YXZ'));
  const qC = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.47, -turn, 0.1, 'YXZ'));
  trunk(player, hipMid, qP, qC);
  player.root.updateMatrixWorld(true);
  // legs: the right foot under the cue, turned out; the left ahead, apart
  foot(player, 'R', at(1.2 * h, 0.03, -bed + J.ankleL[1]), new THREE.Vector3(-0.75, 0, 0.66), at(1.4, -0.3, 0.2));
  foot(player, 'L', at(0.84 * h, 0.47, -bed + J.ankleL[1]), new THREE.Vector3(0.45, 0, 1), at(0.4, 0.6, 0.2));
  player.root.updateMatrixWorld(true);
  // the bridge: the left hand flat on the cloth, the groove under the cue
  const bridgeS = 0.22;
  const groove = onCue(bridgeS);
  const qL = handQuat(player, 'L', new THREE.Vector3(-0.28, 0, 1).normalize(), new THREE.Vector3(-1, 0, -0.28).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0));
  // fingers down on the cloth: the hand's back faces up (its +z), so the
  // palm's plane is level; the groove point then sets the wrist
  const wL = groove.clone().sub(handPoint(player, 'L', qL, new THREE.Vector3(), player.B.hands.bridge.groove));
  twoBone(player, 'arm.L', 'fore.L', 'shoulderL', 'elbowL', 'wristL', wL, at(0.5, 0.7, -0.2));
  setCharQuat(player, player.bones['hand.L'], qL);
  player.setHand('L', 'bridge');
  // the grip: the right hand on the butt, the forearm hanging
  const gripS = 1.02 * h + pull;
  const g = onCue(gripS);
  const qR = gripQuat(player, 'R', back.clone().negate(), new THREE.Vector3(0.12, -1, 0).normalize());
  const wR = g.clone().sub(handPoint(player, 'R', qR, new THREE.Vector3(), GRIP.at));
  twoBone(player, 'arm.R', 'fore.R', 'shoulderR', 'elbowR', 'wristR', wR, at(1.1, -0.07, 0.9));
  setCharQuat(player, player.bones['hand.R'], qR);
  player.setHand('R', 'grip');
  player.root.updateMatrixWorld(true);
  // eyes along the cue, to the ball and past it
  look(player, ball.clone().add(f.clone().multiplyScalar(1.4)).setY(bed + 0.02), 0.12);
  player.root.updateMatrixWorld(true);
  return { tip, ball };
}
