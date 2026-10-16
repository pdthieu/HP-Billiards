// sheet.js: a stage for looking at the players: ?scene=sheet|face|heads|stance|hands|variety|portrait&view=…
import * as THREE from '/vendor/three-r186/three.min.js';
import { createPlayer, stand, sit, stance, idle, makeCue, resetPose, BED } from './rig.js';
import { MAN, WOMAN, HAND_POSES, handShape, GRIP, BRIDGE, makeLook } from './body.js';
import * as S from './sdf.js';

const q = new URLSearchParams(location.search);
const sceneName = q.get('scene') || 'sheet', view = q.get('view') || 'front';
const W = 2.54, H = 1.27, R = 0.028575, RAIL = 0.1;

const canvas = document.querySelector('canvas');
// &bg=none: a clear background, for pictures laid over the app's own
const clear = q.get('bg') === 'none';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: clear });
renderer.setPixelRatio(Number(q.get('dpr') || 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(q.get('exp') || 1.0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = clear ? null : new THREE.Color('#06080c');
if (clear) { renderer.setClearColor(0x000000, 0); document.documentElement.style.background = document.body.style.background = 'transparent'; }
const camera = new THREE.PerspectiveCamera(Number(q.get('fov') || 30), innerWidth / innerHeight, 0.02, 60);

// reflections: a dark hall, a bright panel overhead, warm and cool boards
{
  const pm = new THREE.PMREMGenerator(renderer), room = new THREE.Scene();
  const add = (geo, color, k, x, y, z, rx = 0, ry = 0) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.material.color.multiplyScalar(k); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); room.add(m);
  };
  add(new THREE.BoxGeometry(16, 8, 16), '#1d2128', 1, 0, 2, 0);
  add(new THREE.PlaneGeometry(16, 16), '#141820', 1, 0, -0.01, 0, -Math.PI / 2);
  add(new THREE.PlaneGeometry(2.4, 0.6), '#ffffff', 6, 0, 3, 0, Math.PI / 2);
  add(new THREE.PlaneGeometry(6, 0.7), '#8a6d3a', 1.6, 0, 0.5, -3.2);
  add(new THREE.PlaneGeometry(6, 0.7), '#8a6d3a', 1.6, 0, 0.5, 3.2);
  add(new THREE.PlaneGeometry(4, 2), '#6f86b0', 0.8, -4, 2, 0, 0, Math.PI / 2);
  scene.environment = pm.fromScene(room, 0.03).texture;
  scene.environmentIntensity = 0.6;
}

const floorTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(256, 256, 20, 256, 256, 256);
  gr.addColorStop(0, '#2a3340'); gr.addColorStop(0.5, '#1a212b'); gr.addColorStop(1, '#0a0d12');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

function showcaseLights(target = new THREE.Vector3(0, 1, 0), spread = 2) {
  scene.add(new THREE.HemisphereLight('#c9d6ee', '#20180f', 0.45));
  const key = new THREE.DirectionalLight('#ffe6cc', 2.6);
  key.position.set(-2.2, 4.2, 3.4).add(target);
  key.target.position.copy(target);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -spread, right: spread, top: spread, bottom: -spread, near: 0.5, far: 12 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
  scene.add(key, key.target);
  const rim1 = new THREE.DirectionalLight('#a9c4ff', 2.2); rim1.position.set(3, 3, -3.5).add(target); rim1.target.position.copy(target); scene.add(rim1, rim1.target);
  const rim2 = new THREE.DirectionalLight('#ffcf9a', 1.2); rim2.position.set(-3.5, 2.5, -2.5).add(target); rim2.target.position.copy(target); scene.add(rim2, rim2.target);
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.45); fill.position.set(3, 1.2, 3).add(target); fill.target.position.copy(target); scene.add(fill, fill.target);
}
function floor(size = 9) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true; scene.add(m);
}
function lookFrom(pos, at) { camera.position.copy(pos); camera.lookAt(at); }

// a stand-in table: cloth, cushions, rails, cabinet and legs (as app.js
// LOOKS.diamond), bed at BED, centred on the origin
function table() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: '#1F5C9E', roughness: 0.92 });
  const cush = new THREE.MeshStandardMaterial({ color: '#17467a', roughness: 0.9 });
  const rail = new THREE.MeshPhysicalMaterial({ color: '#4C2F1B', roughness: 0.32, clearcoat: 0.8 });
  const railTop = new THREE.MeshPhysicalMaterial({ color: '#6A4428', roughness: 0.3, clearcoat: 0.8 });
  const cab = new THREE.MeshStandardMaterial({ color: '#18181B', roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: '#050505', roughness: 0.8 });
  const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  box(W + 0.02, 0.03, H + 0.02, cloth, 0, BED - 0.015, 0);
  const C = 0.045, rh = 0.044;
  for (const s of [-1, 1]) {
    box(W, 0.038, C, cush, 0, BED + 0.019, s * (H / 2 + C / 2));
    box(C, 0.038, H, cush, s * (W / 2 + C / 2), BED + 0.019, 0);
    box(W + 2 * RAIL, rh, RAIL - C, rail, 0, BED + rh / 2, s * (H / 2 + C + (RAIL - C) / 2));
    box(RAIL - C, rh, H + 2 * C, rail, s * (W / 2 + C + (RAIL - C) / 2), BED + rh / 2, 0);
    box(W + 2 * RAIL, 0.004, RAIL - C, railTop, 0, BED + rh + 0.002, s * (H / 2 + C + (RAIL - C) / 2));
    box(RAIL - C, 0.004, H + 2 * C, railTop, s * (W / 2 + C + (RAIL - C) / 2), BED + rh + 0.002, 0);
  }
  box(W + 2 * RAIL - 0.04, 0.22, H + 2 * RAIL - 0.04, cab, 0, BED - 0.13, 0);
  for (const x of [-W / 2, 0, W / 2]) for (const s of [-1, 1]) {
    if (x === 0) continue;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, BED - 0.24, 20), cab);
    leg.position.set(x * 0.92, (BED - 0.24) / 2, s * (H / 2 - 0.05)); leg.castShadow = true; g.add(leg);
  }
  for (const [x, z] of [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1]]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.05, 28), black);
    p.position.set(x * (W / 2 + 0.02), BED + 0.02, z * (H / 2 + 0.02)); g.add(p);
  }
  scene.add(g);
  return g;
}
function lamps() {
  scene.add(new THREE.HemisphereLight('#fff4e0', '#1a1a1a', 0.5));
  for (const x of [-W * 0.22, W * 0.22]) {
    const lamp = new THREE.SpotLight('#fff1dc', 9, 0, 0.95, 0.75, 2);
    lamp.position.set(x, BED + 1.15, 0); lamp.target.position.set(x, BED, 0);
    lamp.castShadow = true; lamp.shadow.mapSize.set(2048, 2048); lamp.shadow.camera.near = 0.3; lamp.shadow.camera.far = 3;
    lamp.shadow.bias = -0.0003; lamp.shadow.radius = 4;
    scene.add(lamp, lamp.target);
  }
}
// the players' chair, as arena3d.js builds it, facing +z from p
function chair(x, z, face) {
  const g = new THREE.Group();
  const chrome = new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 1, roughness: 0.25 });
  const leather = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.45 });
  const add = (geo, mat, px, py, pz, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.rotation.x = rx; m.castShadow = m.receiveShadow = true; g.add(m); };
  const cyl = (r0, r1, h, n = 24) => new THREE.CylinderGeometry(r0, r1, h, n);
  add(cyl(0.27, 0.27, 0.025, 40), chrome, 0, 0.0125, 0);
  add(cyl(0.028, 0.028, 0.37), chrome, 0, 0.21, 0);
  add(new THREE.BoxGeometry(0.54, 0.1, 0.52), leather, 0, 0.44, 0.01);
  add(new THREE.BoxGeometry(0.54, 0.4, 0.09), leather, 0, 0.7, -0.24, -0.16);
  add(new THREE.BoxGeometry(0.06, 0.05, 0.42), leather, 0.3, 0.6, -0.01);
  add(new THREE.BoxGeometry(0.06, 0.05, 0.42), leather, -0.3, 0.6, -0.01);
  add(cyl(0.012, 0.012, 0.12, 10), chrome, 0.3, 0.52, 0.12);
  add(cyl(0.012, 0.012, 0.12, 10), chrome, -0.3, 0.52, 0.12);
  g.position.set(x, 0, z); g.rotation.y = face;
  scene.add(g);
  return g;
}
function ball(x, z, color = '#f4f1e8') {
  const b = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 16), new THREE.MeshPhysicalMaterial({ color, roughness: 0.15, clearcoat: 1 }));
  b.position.set(x, BED + R, z); b.castShadow = true; scene.add(b); return b;
}

const t0 = performance.now();
const looks = { man: MAN, woman: WOMAN };
const coarse = Number(q.get('coarse') || 1);
const make = (id) => { const pl = createPlayer(looks[id], { coarse }); scene.add(pl.root); const cue = makeCue(); pl.root.add(cue); return { pl, cue }; };

if (sceneName === 'sheet') {
  showcaseLights(new THREE.Vector3(0, 1, 0), 2.2);
  floor();
  const a = make('man'), b = make('woman');
  a.pl.root.position.set(-0.48, 0, 0); b.pl.root.position.set(0.48, 0, 0);
  a.pl.root.rotation.y = 0.18; b.pl.root.rotation.y = -0.18;
  stand(a.pl, a.cue); stand(b.pl, b.cue);
  a.pl.setRoomLight(1); b.pl.setRoomLight(1);
  {
    const J = {}, v = new THREE.Vector3();
    a.pl.root.updateMatrixWorld(true);
    for (const n of ['arm.L', 'fore.L', 'hand.L', 'chest', 'pelvis']) { a.pl.bones[n].getWorldPosition(v); J[n] = v.toArray().map((x) => x.toFixed(3)).join(' '); }
    const tip = new THREE.Vector3(0, 0.15, 0); a.pl.bones['hand.L'].localToWorld(tip); J.handTipLocalY = tip.toArray().map((x) => x.toFixed(3)).join(' ');
    window.__joints = J;
  }
  const yaw = { front: 0, three: 0.62, side: 1.45, back: Math.PI }[view] ?? 0;
  const d = Number(q.get('dist') || 5.6);
  lookFrom(new THREE.Vector3(Math.sin(yaw) * d, 1.05, Math.cos(yaw) * d), new THREE.Vector3(0, 0.9, 0));
  if (view === 'lhand' || view === 'rhand') {
    const w = new THREE.Vector3(); a.pl.bones[view === 'lhand' ? 'hand.L' : 'hand.R'].getWorldPosition(w);
    lookFrom(w.clone().add(new THREE.Vector3(0.25, 0.1, 0.9)), w.clone().add(new THREE.Vector3(0, -0.06, 0)));
  }
} else if (sceneName === 'stance') {
  lamps();
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: '#1e2631', roughness: 0.95 }));
  fl.rotation.x = -Math.PI / 2; fl.receiveShadow = true; scene.add(fl);
  scene.add(new THREE.HemisphereLight('#9fb3d6', '#0c0e12', 0.25));
  table();
  const shooter = make(q.get('who') || 'man'), waiter = make(q.get('who') === 'woman' ? 'man' : 'woman');
  const bz = H / 2 - Number(q.get('fromRail') || 0.8), bx = Number(q.get('bx') || -0.35);
  const yaw = Number(q.get('yaw') || Math.PI), dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const cueBall = ball(bx, bz);
  ball(bx + dir.x * 0.7 - 0.06, bz + dir.z * 0.7, '#e2b300');
  shooter.pl.root.rotation.y = yaw;
  shooter.pl.root.position.set(bx - dir.x * 1.0, 0, bz - dir.z * 1.0);
  const pull = Number(q.get('pull') || 0.03);
  stance(shooter.pl, shooter.cue, { pull, ball: new THREE.Vector3(0, BED + R, 1.0) });
  window.__pose = (p) => stance(shooter.pl, shooter.cue, { pull: p, ball: new THREE.Vector3(0, BED + R, 1.0) });
  // where the joints ended up, as (s behind the ball, x left of the cue, h above the bed)
  {
    const J = {}, b = shooter.pl.bones, v = new THREE.Vector3();
    shooter.pl.root.updateMatrixWorld(true);
    for (const n of ['pelvis', 'chest', 'neck', 'head', 'arm.L', 'fore.L', 'hand.L', 'arm.R', 'fore.R', 'hand.R', 'thigh.R', 'shin.R', 'foot.R', 'thigh.L', 'shin.L', 'foot.L']) {
      b[n].getWorldPosition(v);
      J[n] = [(v.z - bz).toFixed(3), (bx - v.x).toFixed(3), (v.y - BED).toFixed(3)].join(' ');
    }
    window.__joints = J;
  }
  // the waiting player in the far corner's chair, facing the table
  const cx = W / 2 + RAIL + 0.95, cz = -(H / 2 + RAIL + 0.95), face = Math.atan2(-cx, -cz);
  chair(cx, cz, face);
  waiter.pl.root.position.set(cx + Math.sin(face) * 0.05, 0, cz + Math.cos(face) * 0.05);
  waiter.pl.root.rotation.y = face;
  sit(waiter.pl, waiter.cue);
  shooter.pl.setRoomLight(1.6); waiter.pl.setRoomLight(1.6);
  const views = {
    side: [new THREE.Vector3(bx + 2.3, 1.25, bz + 0.85), new THREE.Vector3(bx, 0.95, bz + 0.45)],
    behind: [new THREE.Vector3(bx + 0.5, 1.9, bz + 2.6), new THREE.Vector3(bx, 0.9, bz + 0.3)],
    front: [new THREE.Vector3(bx - 0.5, 1.15, bz - 1.6), new THREE.Vector3(bx, 0.95, bz + 0.5)],
    bridge: [new THREE.Vector3(bx + 0.55, BED + 0.28, bz - 0.15), new THREE.Vector3(bx, BED + 0.05, bz + 0.25)],
    aim: [new THREE.Vector3(bx - dir.x * 0.9, BED + 0.36, bz - dir.z * 0.9), new THREE.Vector3(bx + dir.x * 1.0, BED - 0.16, bz + dir.z * 1.0)],
    wide: [new THREE.Vector3(3.6, 2.4, 3.2), new THREE.Vector3(0.3, 0.8, -0.2)],
    chair: [new THREE.Vector3(cx - 1.4, 1.2, cz + 1.5), new THREE.Vector3(cx, 0.8, cz)],
  };
  const [pos, at] = views[view] || views.side;
  lookFrom(pos, at);
  if (view === 'aim') {
    // the camera is the shooter's eyes: only the bridge arm shows
    camera.fov = 42;
    shooter.pl.firstPerson(true);
  }
} else if (sceneName === 'hands') {
  showcaseLights(new THREE.Vector3(0, 0, 0), 0.4);
  const pl = createPlayer(q.get('who') === 'woman' ? WOMAN : MAN);
  // show the canonical hands: build their meshes straight from body.js
  const mat = pl.materials.plainSkin;
  let i = 0;
  for (const pose of Object.keys(HAND_POSES)) {
    const part = handShape(pl.look, pose);
    const m = S.mesh(part.shape, part.lo, part.hi, 0.0017);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    const c = new Float32Array(m.pos.length).fill(0.62);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set((i - 1) * 0.22, 0, 0);
    scene.add(mesh);
    if (pose === 'grip') {
      const cy = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.3, 24), new THREE.MeshStandardMaterial({ color: '#6B4325' }));
      cy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...GRIP.along));
      cy.position.set((i - 1) * 0.22 + GRIP.at[0], GRIP.at[1], GRIP.at[2]);
      scene.add(cy);
    }
    if (pose === 'bridge') {
      const cy = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.3, 16), new THREE.MeshStandardMaterial({ color: '#EEE1C4' }));
      cy.position.set((i - 1) * 0.22 + BRIDGE.groove[0], BRIDGE.groove[1], BRIDGE.groove[2]);
      cy.rotation.x = Math.PI / 2; // along the hand's z? the cue runs along y (the fingers)
      cy.rotation.set(0, 0, 0);
      scene.add(cy);
    }
    i++;
  }
  const yaw = { front: 0, back: Math.PI, side: Math.PI / 2, top: 0 }[view] ?? 0;
  if (view === 'top') lookFrom(new THREE.Vector3(0, 0.1, 0.9), new THREE.Vector3(0, 0.08, 0));
  else if (view === 'palm') lookFrom(new THREE.Vector3(0, 0.1, -0.9), new THREE.Vector3(0, 0.08, 0));
  else if (view === 'along') lookFrom(new THREE.Vector3(0.22 + 0.5, 0.09 + 0.04, -0.035), new THREE.Vector3(0.22, 0.09, -0.035));
  else lookFrom(new THREE.Vector3(Math.sin(yaw + 0.5) * 0.9, 0.25, Math.cos(yaw + 0.5) * 0.9), new THREE.Vector3(0, 0.08, 0));
} else if (sceneName === 'heads') {
  showcaseLights(new THREE.Vector3(0, 1.55, 0), 1);
  const a = make('man'), b = make('woman');
  a.pl.root.position.set(-0.17, 0, 0); b.pl.root.position.set(0.17, 0.1, 0);
  stand(a.pl, a.cue); stand(b.pl, b.cue);
  a.cue.visible = b.cue.visible = false;
  const yaw = { front: 0, three: 0.6, side: 1.5, back: Math.PI }[view] ?? 0;
  lookFrom(new THREE.Vector3(Math.sin(yaw) * 1.5, 1.66, Math.cos(yaw) * 1.5), new THREE.Vector3(0, 1.64, 0));
}
// ?scene=variety: six looks a photo could set, heads and shoulders
if (sceneName === 'variety') {
  showcaseLights(new THREE.Vector3(0, 1.5, 0), 2.4);
  const looks = [
    { body: 'man', skin: '#f1c9a8', hair: 'quiff', hairColor: '#6b4a2b', eyes: '#3d6f9e', face: { w: 1.02, jaw: 1.1 } },
    { body: 'woman', skin: '#c98d64', hair: 'bun', hairColor: '#2a1a12', eyes: '#5a3a20', face: { cheek: 1.15, eye: 1.1 } },
    { body: 'man', skin: '#8d5a3c', hair: 'buzz', hairColor: '#141010', eyes: '#3a2414', face: { w: 1.05, jaw: 1.15, nose: 1.1, lips: 1.0, beard: 0.55 } },
    { body: 'woman', skin: '#f6d3bc', hair: 'pony', hairColor: '#c9a063', eyes: '#4e7a52', face: { w: 0.94, chin: 0.85, eye: 1.12 } },
    { body: 'man', skin: '#e0b08e', hair: 'short', hairColor: '#9a4a26', eyes: '#6b4f2a', face: { w: 0.96, jaw: 0.9, gap: 1.05 } },
    { body: 'woman', skin: '#6e4630', hair: 'pony', hairColor: '#100c0a', eyes: '#2e1c12', face: { lips: 1.2, nose: 0.85 } },
  ];
  looks.forEach((o, i) => {
    const pl = createPlayer(makeLook({ ...o, id: 'v' + i, side: i % 2 }), { coarse });
    scene.add(pl.root);
    pl.root.position.set((i - 2.5) * 0.54, 0, 0);
    stand(pl, null);
    pl.setRoomLight(1);
  });
  lookFrom(new THREE.Vector3(0, 1.45, 3.9), new THREE.Vector3(0, 1.32, 0));
}
// ?scene=portrait&look={json for makeLook}&view=head|bust|full: one player
// with nothing in the hands, as the player's own screen would show them
if (sceneName === 'portrait') {
  showcaseLights(new THREE.Vector3(0, 1.2, 0), 1.6);
  const pl = createPlayer(makeLook(JSON.parse(q.get('look') || '{}')), { coarse });
  scene.add(pl.root);
  idle(pl);
  pl.setRoomLight(1);
  pl.root.rotation.y = Number(q.get('yaw') || 0.35);
  if (view === 'full') {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.4 }));
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true; scene.add(g);
  }
  pl.root.updateMatrixWorld(true);
  const hd = new THREE.Vector3(); pl.bones.head.getWorldPosition(hd);
  const [d, eye, at] = { head: [0.86, hd.y + 0.1, hd.y + 0.085], bust: [1.45, hd.y - 0.04, hd.y - 0.07], full: [4.4, pl.look.height * 0.56, pl.look.height * 0.5] }[view] || [1.45, hd.y - 0.04, hd.y - 0.07];
  lookFrom(new THREE.Vector3(0, eye, d), new THREE.Vector3(0, at, 0));
}
let multi = null;
if (sceneName === 'face') {
  showcaseLights(new THREE.Vector3(0, 1.6, 0), 0.5);
  const a = make(q.get('who') || 'man');
  resetPose(a.pl); a.cue.visible = false;
  a.pl.root.updateMatrixWorld(true);
  const c = new THREE.Vector3(); a.pl.bones.head.getWorldPosition(c); c.add(new THREE.Vector3(0, 0.055, 0.02));
  if (q.get('clay')) for (const m of Object.values(a.pl.materials)) { m.vertexColors = false; m.color = new THREE.Color('#b9b2aa'); m.needsUpdate = true; }
  const d = Number(q.get('dist') || 0.62);
  multi = (q.get('views') || 'front,three,side').split(',').map((v) => {
    const yaw = { front: 0, three: 0.62, side: 1.5, back: Math.PI, low: 0.3 }[v] ?? 0;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.02, 20);
    cam.position.set(c.x + Math.sin(yaw) * d, c.y + (v === 'low' ? -0.12 : 0.0), c.z + Math.cos(yaw) * d);
    cam.lookAt(c);
    return cam;
  });
}
camera.aspect = innerWidth / innerHeight;
camera.updateProjectionMatrix();
const built = performance.now() - t0;
let frames = 0;
// ?frames=N: the stroke drawn back and through, N pictures for an animation
if (sceneName === 'stance' && q.get('frames')) {
  const N = Number(q.get('frames')), shots = [];
  window.__frames = shots;
  const shooter = scene.children.find((o) => o.name === (q.get('who') || 'man'));
  window.__animate = async () => {
    for (let i = 0; i < N; i++) {
      const t = i / N, pull = 0.035 + 0.17 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
      window.__pose(pull);
      renderer.render(scene, camera);
      shots.push(canvas.toDataURL('image/jpeg', 0.92));
      await new Promise((r) => setTimeout(r, 0));
    }
    return shots.length;
  };
}
function frame() {
  if (multi) {
    const w = innerWidth / multi.length, h = innerHeight;
    renderer.setScissorTest(true);
    multi.forEach((cam, i) => {
      cam.aspect = w / h; cam.updateProjectionMatrix();
      renderer.setViewport(i * w, 0, w, h); renderer.setScissor(i * w, 0, w, h);
      renderer.render(scene, cam);
    });
    renderer.setScissorTest(false);
  } else renderer.render(scene, camera);
  if (++frames < 4) requestAnimationFrame(frame);
  else { window.__ready = true; window.__built = Math.round(built); }
}
requestAnimationFrame(frame);
