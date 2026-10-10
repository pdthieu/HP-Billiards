// The arena round the table in 3D (docs/CLIENT.md, "Arena"): the floor of
// play with its carpet, the LED boards round it, the players' chairs, two
// television cameras, and the stands beyond, dark but for the lights along
// their rows. No one is in it yet. Everything is built here from Three.js
// shapes and canvas paint, so nothing is downloaded. view3d.js draws this
// scene first, with lights of its own, then the table's scene over it, so
// the table keeps its lamps and its look.
//
// Axes as in view3d.js: table x is x, table y is z, up is +y, the bed at
// y = 0 and the floor at k.floor.
import * as THREE from '/vendor/three-r186/three.min.js';

const BG = '#05070a';                // the dark beyond the light
const BOARD_H = 1.0;                 // the LED boards' height above the floor (app.js BOARD_TOP)
const BOARD_T = 0.1;                 // and thickness
const LED_LO = 0.14, LED_HI = 0.96;  // their screens, above the floor
const AISLE = 1.4;                   // from the boards to the stands
const ROWS = 7, TREAD = 0.85, RISE = 0.4, STEP0 = 0.4; // the stands' tiers, the first STEP0 high
const SEAT_W = 0.52;                 // seat to seat along a row
const STAIR_EVERY = 7;               // seats between two stairways
const PAGES = 4;                     // what the boards show in turn (paintBoard)
const PAGE_MS = 9000, SLIDE_MS = 800;
const LED_PX = 256;                  // the boards' pixels per metre
const FONT = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';
const CARPET = '#1e2631', ZONE = '#232d3a', LINE = '#a8844a';
const INK = '#f2efe6', BRASS = '#e3b450', GREEN = '#63c393';
const SLOGAN = { '8ball': 'CALL YOUR SHOT', '9ball': 'LOWEST BALL FIRST', '3cushion': 'THREE CUSHIONS' };
const GAME = { '8ball': '8-BALL', '9ball': '9-BALL', '3cushion': '3-CUSHION' };

// createArena builds the arena and returns it. k:
//   W, H, RAIL (the table), floor (its height), boards ({x0, x1, y0, y1}:
//   the boards' inner faces, table metres, x0 < x1 along x, y0 < y1 along
//   z), legs ([{x, y}] where the table stands on the floor), lamps (the x
//   of the table's two lamps), carom, info (what the boards show: see
//   setInfo), level (a Graphics level), env (the table's reflections, for
//   the metal), anisotropy and reduceMotion().
export function createArena(k) {
  const { W, H, RAIL } = k;
  const F = k.floor;
  const B = k.boards;
  const cx = W / 2, cz = H / 2;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 9, 26);
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };
  // heavy: what Low leaves out, the stands with their lights
  const heavy = new THREE.Group();
  scene.add(heavy);

  // --- light ------------------------------------------------------------
  // The table's lamps again, without shadows, for the floor round it; a wash
  // from high above lights the rest of the floor of play as for
  // television; the stands get what spills from a light high over the
  // middle, and a faint sky.
  scene.add(new THREE.HemisphereLight('#9db3d6', '#0a0b0e', 0.45));
  const spill = new THREE.PointLight('#dfe6f2', 70, 0, 2);
  spill.position.set(cx, F + 6.5, cz);
  heavy.add(spill);
  for (const x of k.lamps) {
    const lamp = new THREE.SpotLight('#fff1dc', 9, 0, 0.95, 0.75, 2);
    lamp.position.set(x, 1.15, cz);
    lamp.target.position.set(x, 0, cz);
    scene.add(lamp, lamp.target);
  }
  const reach = Math.hypot(B.x1 - B.x0, B.y1 - B.y0) / 2;
  const wash = new THREE.SpotLight('#eef1f6', 90, 0, Math.atan2(reach, 7.5), 0.55, 2);
  wash.position.set(cx, F + 7.5, cz);
  wash.target.position.set(cx, F, cz);
  scene.add(wash, wash.target);

  // --- floor ------------------------------------------------------------
  const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(60, 60)), keep(new THREE.MeshLambertMaterial({ color: '#0b0d11' })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, F - 0.01, cz);
  scene.add(ground);
  const props = layout();
  const carpetTex = keep(new THREE.CanvasTexture(paintCarpet(k, props, k.level === 'low' ? 140 : 220)));
  carpetTex.colorSpace = THREE.SRGBColorSpace;
  carpetTex.anisotropy = k.anisotropy;
  const carpet = new THREE.Mesh(keep(new THREE.PlaneGeometry(B.x1 - B.x0, B.y1 - B.y0)), keep(new THREE.MeshStandardMaterial({ map: carpetTex, roughness: 0.95 })));
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set((B.x0 + B.x1) / 2, F, (B.y0 + B.y1) / 2);
  scene.add(carpet);

  // --- boards -----------------------------------------------------------
  // Four boards round the floor of play, their screens facing in: the long
  // ones run the whole length, the ends fit between them, a post at each
  // corner. Both long boards show one picture and both ends another, a page
  // at a time (paintBoard), sliding up to the next every PAGE_MS.
  const frame = keep(new THREE.MeshStandardMaterial({ color: '#111419', roughness: 0.55, metalness: 0.3 }));
  const sides = [
    { a: [B.x0 - BOARD_T, B.y0], b: [B.x1 + BOARD_T, B.y0], into: [0, 1], kind: 'long' },
    { a: [B.x1 + BOARD_T, B.y1], b: [B.x0 - BOARD_T, B.y1], into: [0, -1], kind: 'long' },
    { a: [B.x0, B.y1], b: [B.x0, B.y0], into: [1, 0], kind: 'end' },
    { a: [B.x1, B.y0], b: [B.x1, B.y1], into: [-1, 0], kind: 'end' },
  ];
  const at = (x, y, z, ry = 0) => new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
  const frames = [], faces = { long: [], end: [] };
  for (const s of sides) {
    const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], len = Math.hypot(dx, dz);
    const mx = (s.a[0] + s.b[0]) / 2, mz = (s.a[1] + s.b[1]) / 2;
    frames.push({ geo: new THREE.BoxGeometry(len, BOARD_H, BOARD_T), matrix: at(mx - s.into[0] * BOARD_T / 2, F + BOARD_H / 2, mz - s.into[1] * BOARD_T / 2, -Math.atan2(dz, dx)) });
    faces[s.kind].len = len;
    faces[s.kind].push({ geo: new THREE.PlaneGeometry(len - 0.04, LED_HI - LED_LO), matrix: at(mx + s.into[0] * 0.002, F + (LED_LO + LED_HI) / 2, mz + s.into[1] * 0.002, Math.atan2(s.into[0], s.into[1])) });
  }
  for (const [x, z] of [[B.x0, B.y0], [B.x1, B.y0], [B.x0, B.y1], [B.x1, B.y1]]) {
    frames.push({ geo: new THREE.BoxGeometry(BOARD_T * 1.6, BOARD_H + 0.04, BOARD_T * 1.6), matrix: at(x + Math.sign(x - cx) * BOARD_T / 2, F + (BOARD_H + 0.04) / 2, z + Math.sign(z - cz) * BOARD_T / 2) });
  }
  scene.add(new THREE.Mesh(keep(merge(frames)), frame));
  const ledTex = {};
  for (const kind of ['long', 'end']) {
    const c = document.createElement('canvas');
    c.width = Math.round(faces[kind].len * LED_PX);
    c.height = Math.round((LED_HI - LED_LO) * LED_PX) * PAGES;
    const t = keep(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = k.anisotropy;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 1 / PAGES);
    t.offset.y = 1 - 1 / PAGES;
    ledTex[kind] = { tex: t, canvas: c, len: faces[kind].len };
    scene.add(new THREE.Mesh(keep(merge(faces[kind])), keep(new THREE.MeshBasicMaterial({ map: t, toneMapped: false }))));
  }
  let info = null;
  function setInfo(next) {
    const key = JSON.stringify(next);
    if (info === key) return;
    info = key;
    for (const kind of ['long', 'end']) {
      const l = ledTex[kind];
      paintBoard(l.canvas, l.len, next, kind);
      l.tex.needsUpdate = true;
    }
  }
  setInfo(k.info);
  // the boards' letters may come before their font: paint them again with it
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`700 64px ${FONT}`).then(() => { const was = info; info = null; setInfo(JSON.parse(was)); }).catch(() => {});
  }

  // --- the players' corners and the cameras -----------------------------
  // Each piece is a few meshes, its parts merged by material (build).
  const leather = keep(new THREE.MeshStandardMaterial({ color: '#3a3c42', roughness: 0.42 }));
  const chrome = keep(new THREE.MeshStandardMaterial({ color: '#d4d7dc', roughness: 0.22, metalness: 1 }));
  const blackTop = keep(new THREE.MeshStandardMaterial({ color: '#121418', roughness: 0.3, metalness: 0.2 }));
  const clear = keep(new THREE.MeshStandardMaterial({ color: '#cfe3f2', roughness: 0.08, transparent: true, opacity: 0.45, depthWrite: false }));
  const cap = keep(new THREE.MeshStandardMaterial({ color: '#1f6fb2', roughness: 0.4 }));
  const towel = keep(new THREE.MeshStandardMaterial({ color: '#ece8df', roughness: 1 }));
  const chalk = keep(new THREE.MeshStandardMaterial({ color: '#2f6db5', roughness: 0.9 }));
  const gear = keep(new THREE.MeshStandardMaterial({ color: '#25282d', roughness: 0.45, metalness: 0.5 }));
  const glassFront = keep(new THREE.MeshStandardMaterial({ color: '#1a2635', roughness: 0.05, metalness: 0.6 }));
  const tally = keep(new THREE.MeshBasicMaterial({ color: '#ff3b30', toneMapped: false }));
  // the metal shows the table's reflections (k.env) and nothing else does
  for (const m of [chrome, gear, glassFront]) { m.envMap = k.env; m.envMapIntensity = 0.7; }
  const hide = []; // {obj, at, r}: hidden while the camera is inside or close
  // part: a shape of build's, moved to (x, y, z) and turned by (rx, ry, rz)
  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => ({
    geo, mat, matrix: new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z),
  });
  const cyl = (r0, r1, h, n = 24) => new THREE.CylinderGeometry(r0, r1, h, n);
  for (const p of props.chairs) {
    place(build([
      part(cyl(0.27, 0.27, 0.025, 40), chrome, 0, 0.0125, 0),
      part(cyl(0.028, 0.028, 0.37), chrome, 0, 0.21, 0),
      part(new THREE.BoxGeometry(0.54, 0.1, 0.52), leather, 0, 0.44, 0.01),
      part(new THREE.BoxGeometry(0.54, 0.4, 0.09), leather, 0, 0.7, -0.24, -0.16),
      part(new THREE.BoxGeometry(0.06, 0.05, 0.42), leather, 0.3, 0.6, -0.01),
      part(new THREE.BoxGeometry(0.06, 0.05, 0.42), leather, -0.3, 0.6, -0.01),
      part(cyl(0.012, 0.012, 0.12, 10), chrome, 0.3, 0.52, 0.12),
      part(cyl(0.012, 0.012, 0.12, 10), chrome, -0.3, 0.52, 0.12),
    ]), p, 0.6, 0.5);
  }
  for (const p of props.tables) {
    place(build([
      part(cyl(0.19, 0.19, 0.015, 36), chrome, 0, 0.0075, 0),
      part(cyl(0.02, 0.02, 0.6, 12), chrome, 0, 0.31, 0),
      part(cyl(0.22, 0.22, 0.025, 40), blackTop, 0, 0.62, 0),
      part(cyl(0.033, 0.033, 0.19, 20), clear, 0.07, 0.73, -0.05),
      part(cyl(0.015, 0.03, 0.035, 16), clear, 0.07, 0.84, -0.05),
      part(cyl(0.035, 0.03, 0.1, 20), clear, -0.08, 0.683, -0.06),
      part(cyl(0.017, 0.017, 0.02, 16), cap, 0.07, 0.868, -0.05),
      part(new THREE.BoxGeometry(0.2, 0.035, 0.15), towel, -0.02, 0.65, 0.09, 0, 0.3),
      part(new THREE.BoxGeometry(0.022, 0.022, 0.022), chalk, 0.12, 0.644, 0.08, 0, 0.6),
    ]), p, 0.7, 0.3);
  }
  for (const p of props.cameras) {
    const top = 1.2, parts = [];
    const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
    for (let i = 0; i < 3; i++) { // the tripod's legs
      const a = i * Math.PI * 2 / 3 + Math.PI / 2;
      const foot = new THREE.Vector3(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42), head = new THREE.Vector3(0, top, 0);
      q.setFromUnitVectors(up, head.clone().sub(foot).normalize());
      parts.push({ geo: cyl(0.011, 0.014, foot.distanceTo(head), 8), mat: gear, matrix: new THREE.Matrix4().makeRotationFromQuaternion(q).setPosition(foot.add(head).multiplyScalar(0.5)) });
    }
    // the camera itself, tipped down toward the table
    const tip = new THREE.Matrix4().makeRotationX(p.tilt).setPosition(0, top + 0.05, 0);
    for (const c of [
      part(new THREE.BoxGeometry(0.12, 0.07, 0.14), gear, 0, 0, 0),
      part(new THREE.BoxGeometry(0.15, 0.2, 0.38), gear, 0, 0.13, -0.02),
      part(cyl(0.055, 0.055, 0.3, 24), gear, 0, 0.12, 0.3, Math.PI / 2),
      part(new THREE.BoxGeometry(0.17, 0.13, 0.07), gear, 0, 0.12, 0.47),
      part(new THREE.BoxGeometry(0.1, 0.07, 0.12), gear, -0.11, 0.26, -0.12),
      part(new THREE.CircleGeometry(0.05, 24), glassFront, 0, 0.12, 0.506),
      part(new THREE.BoxGeometry(0.03, 0.018, 0.02), tally, 0, 0.24, 0.12),
      part(cyl(0.009, 0.009, 0.5, 8), chrome, 0.07, -0.06, -0.26, Math.PI / 2 - 0.35),
    ]) {
      c.matrix.premultiply(tip);
      parts.push(c);
    }
    place(build(parts), p, 0.8, 0.6);
  }
  // build merges parts ({geo, mat, matrix}) by material: one mesh each.
  function build(parts) {
    const g = new THREE.Group();
    const by = new Map();
    for (const p of parts) by.set(p.mat, [...(by.get(p.mat) || []), p]);
    for (const [mat, list] of by) g.add(new THREE.Mesh(keep(merge(list)), mat));
    return g;
  }
  // place sets group g on the floor at p, facing p.face (radians about y,
  // 0 toward +z), hidden near the camera (r round a centre h up).
  function place(g, p, h, r) {
    g.position.set(p.x, F, p.y);
    g.rotation.y = p.face;
    scene.add(g);
    hide.push({ obj: g, at: new THREE.Vector3(p.x, F + h, p.y), r });
  }

  // --- stands -----------------------------------------------------------
  // Beyond an aisle behind each board, ROWS tiers of seats facing the
  // table, a stairway every STAIR_EVERY seats; the corners stay open. The
  // tiers, the seats (instanced), the lights along the tiers' edges, the
  // lights on the stairways' steps and the rails are a draw each.
  {
    const tiers = [], strips = [], steps = [], rails = [];
    const seats = [];
    const up = new THREE.Vector3(0, 1, 0);
    const stands = [
      { mid: [cx, B.y0 - BOARD_T - AISLE], out: [0, -1], len: B.x1 - B.x0 + 0.4 },
      { mid: [cx, B.y1 + BOARD_T + AISLE], out: [0, 1], len: B.x1 - B.x0 + 0.4 },
      { mid: [B.x0 - BOARD_T - AISLE, cz], out: [-1, 0], len: B.y1 - B.y0 + 0.4 },
      { mid: [B.x1 + BOARD_T + AISLE, cz], out: [1, 0], len: B.y1 - B.y0 + 0.4 },
    ];
    const profile = new THREE.Shape();
    profile.moveTo(0, 0);
    for (let i = 0; i < ROWS; i++) {
      profile.lineTo(i * TREAD, STEP0 + i * RISE);
      profile.lineTo((i + 1) * TREAD, STEP0 + i * RISE);
    }
    profile.lineTo(ROWS * TREAD, 0);
    profile.closePath();
    for (const s of stands) {
      const out = new THREE.Vector3(s.out[0], 0, s.out[1]);
      const along = new THREE.Vector3().crossVectors(out, up); // out, up, along: right-handed
      const origin = new THREE.Vector3(s.mid[0], F, s.mid[1]).addScaledVector(along, -s.len / 2);
      // at: the stand's frame moved d out from its front, a along it, h up
      const at = (d, a, h) => new THREE.Matrix4().makeBasis(out, up, along)
        .setPosition(origin.clone().addScaledVector(out, d).addScaledVector(along, a).addScaledVector(up, h));
      tiers.push({ geo: new THREE.ExtrudeGeometry(profile, { depth: s.len, bevelEnabled: false }), matrix: at(0, 0, 0) });
      // seats in slots along the rows, a stairway every STAIR_EVERY
      const slots = Math.floor((s.len - 0.4) / SEAT_W);
      const first = (s.len - slots * SEAT_W) / 2 + SEAT_W / 2;
      for (let i = 0; i < ROWS; i++) {
        const y = STEP0 + i * RISE;
        strips.push({ geo: new THREE.BoxGeometry(0.012, 0.014, s.len), matrix: at(i * TREAD - 0.004, s.len / 2, y - 0.012) });
        for (let j = 0; j < slots; j++) {
          const a = first + j * SEAT_W;
          if (j % (STAIR_EVERY + 1) === STAIR_EVERY) steps.push({ geo: new THREE.BoxGeometry(0.01, 0.018, 0.12), matrix: at(i * TREAD - 0.004, a, y - 0.06) });
          else seats.push({ out, at: origin.clone().addScaledVector(out, i * TREAD + 0.45).addScaledVector(along, a).addScaledVector(up, y) });
        }
      }
      // a rail along the front of the first tier
      rails.push({ geo: new THREE.BoxGeometry(0.035, 0.035, s.len), matrix: at(0.05, s.len / 2, STEP0 + 0.95) });
      for (let a = 0.3; a < s.len; a += 1.6) rails.push({ geo: new THREE.BoxGeometry(0.03, 0.95, 0.03), matrix: at(0.05, a, STEP0 + 0.475) });
    }
    heavy.add(new THREE.Mesh(keep(merge(tiers)), keep(new THREE.MeshLambertMaterial({ color: '#171c25', emissive: '#06080b' }))));
    heavy.add(new THREE.Mesh(keep(merge(strips)), keep(new THREE.MeshBasicMaterial({ color: '#2f78ad', toneMapped: false }))));
    heavy.add(new THREE.Mesh(keep(merge(steps)), keep(new THREE.MeshBasicMaterial({ color: '#ffd6a0', toneMapped: false }))));
    heavy.add(new THREE.Mesh(keep(merge(rails)), keep(new THREE.MeshStandardMaterial({ color: '#2a2f37', roughness: 0.4, metalness: 0.7 }))));
    const seatMesh = new THREE.InstancedMesh(keep(seatGeometry()), keep(new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#080b12' })), seats.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    const rnd = random(7);
    seats.forEach((s, i) => {
      const front = s.out.clone().negate();
      const right = new THREE.Vector3().crossVectors(up, front);
      m.makeBasis(right, up, front).setPosition(s.at);
      seatMesh.setMatrixAt(i, m);
      // dark blue seats, a few a shade off, as seats fade unevenly
      col.set('#26324a').offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
      seatMesh.setColorAt(i, col);
    });
    heavy.add(seatMesh);
  }

  // --- each frame -------------------------------------------------------
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  function update(now, camera) {
    // the boards' pages: one shown PAGE_MS, then the next slides up over
    // SLIDE_MS (a cut with reduced motion)
    const t = now / PAGE_MS, i = Math.floor(t);
    const slide = Math.max(0, Math.min(1, ((t - i) * PAGE_MS - (PAGE_MS - SLIDE_MS)) / SLIDE_MS));
    const page = k.reduceMotion() ? i + Math.round(slide) : i + ease(slide);
    for (const kind in ledTex) ledTex[kind].tex.offset.y = 1 - ((page % PAGES) + 1) / PAGES;
    for (const h of hide) h.obj.visible = camera.position.distanceTo(h.at) > h.r + 0.25;
  }

  function setLevel(name) { heavy.visible = name !== 'low'; }
  setLevel(k.level);

  function dispose() {
    for (const d of disposables) d.dispose();
  }

  return { scene, update, setInfo, setLevel, dispose };

  // layout places the chairs, the side tables and the cameras, one to a
  // corner of the floor of play, clear of the boards' middles: a player's
  // chair, its table beside it, in two opposite corners, a camera in each
  // of the other two; all face the middle of the table.
  function layout() {
    const ox = W / 2 + RAIL, oz = H / 2 + RAIL; // the table's half size
    const out = { chairs: [], tables: [], cameras: [] };
    const toward = (p) => { p.face = Math.atan2(cx - p.x, cz - p.y); return p; };
    for (const s of [-1, 1]) {
      // the chairs: head end near side, foot end far side
      const x = cx + s * (ox + 0.95), z = cz - s * (oz + 0.95);
      const chair = toward({ x, y: z });
      out.chairs.push(chair);
      out.tables.push(toward({ x: x + Math.cos(chair.face) * 0.62, y: z - Math.sin(chair.face) * 0.62 }));
      // the cameras: the other two corners
      const cam = toward({ x: cx + s * Math.min(ox + 1.35, B.x1 - cx - 0.6), y: cz + s * Math.min(oz + 1.15, B.y1 - cz - 0.6) });
      cam.tilt = Math.atan2(1.4 + F, Math.hypot(cx - cam.x, cz - cam.y)); // down from the lens toward the cloth
      out.cameras.push(cam);
    }
    return out;
  }
}

// paintCarpet draws the floor of play from above at P px per metre: a
// dark blue carpet, a lighter zone round the table where the players walk,
// brass lines inside the boards, the game's mark at each end, and the
// shadows of the table and of what stands on it.
function paintCarpet(k, props, P) {
  const B = k.boards, { W, H, RAIL } = k;
  const w = B.x1 - B.x0, d = B.y1 - B.y0;
  const c = document.createElement('canvas');
  c.width = Math.round(w * P);
  c.height = Math.round(d * P);
  const g = c.getContext('2d');
  g.setTransform(P, 0, 0, P, -B.x0 * P, -B.y0 * P); // table metres
  g.fillStyle = CARPET;
  g.fillRect(B.x0, B.y0, w, d);
  // the zone round the table
  const zone = 1.1;
  const zx0 = -RAIL - zone, zx1 = W + RAIL + zone, zy0 = -RAIL - zone, zy1 = H + RAIL + zone;
  g.fillStyle = ZONE;
  rounded(g, zx0, zy0, zx1 - zx0, zy1 - zy0, 0.45);
  g.fill();
  g.strokeStyle = LINE;
  g.globalAlpha = 0.8;
  g.lineWidth = 0.018;
  g.stroke();
  g.globalAlpha = 1;
  // brass lines inside the boards, and a darker band under them
  g.strokeStyle = '#141a22';
  g.lineWidth = 0.6;
  g.strokeRect(B.x0, B.y0, w, d);
  g.strokeStyle = LINE;
  g.lineWidth = 0.035;
  g.strokeRect(B.x0 + 0.5, B.y0 + 0.5, w - 1, d - 1);
  g.lineWidth = 0.012;
  g.strokeRect(B.x0 + 0.58, B.y0 + 0.58, w - 1.16, d - 1.16);
  // the marks at the ends, read from the near side
  for (const x of [(zx0 + B.x0 + 0.5) / 2, (zx1 + B.x1 - 0.5) / 2]) {
    const y = H / 2, r = Math.min(0.34, (zx0 - B.x0 - 0.5) / 2 - 0.04);
    g.fillStyle = '#18202a';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = LINE; g.lineWidth = 0.02; g.stroke();
    g.lineWidth = 0.006;
    g.beginPath(); g.arc(x, y, r - 0.035, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#d9cfb8';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitText(g, k.carom ? 'CAROM' : 'POOL', x, y + r * 0.04, r * 1.45, r * 0.62, '700');
  }
  // the shadows: the table's, darker under its legs, then the furniture's
  soft(g, P, 0.2, 0.55, () => rounded(g, -RAIL + 0.04, -RAIL + 0.04, W + 2 * RAIL - 0.08, H + 2 * RAIL - 0.08, 0.08));
  for (const l of k.legs) soft(g, P, 0.05, 0.5, () => { g.beginPath(); g.arc(l.x, l.y, 0.1, 0, Math.PI * 2); });
  for (const p of props.chairs) soft(g, P, 0.08, 0.45, () => { g.beginPath(); g.arc(p.x, p.y, 0.3, 0, Math.PI * 2); });
  for (const p of props.tables) soft(g, P, 0.06, 0.4, () => { g.beginPath(); g.arc(p.x, p.y, 0.21, 0, Math.PI * 2); });
  for (const p of props.cameras) soft(g, P, 0.12, 0.35, () => { g.beginPath(); g.arc(p.x, p.y, 0.32, 0, Math.PI * 2); });
  // the carpet's fibre: a tile of noise over it all
  const n = document.createElement('canvas');
  n.width = n.height = 256;
  const ng = n.getContext('2d');
  const img = ng.createImageData(256, 256);
  const rnd = random(3);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rnd() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = rnd() * 22;
  }
  ng.putImageData(img, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = g.createPattern(n, 'repeat');
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// soft fills the path that draw lays down, blurred by blur metres, as a
// shadow alpha dark. The shape itself is drawn far off the canvas and only
// its shadow falls on it (ctx.filter is missing from older Safari).
function soft(g, P, blur, alpha, draw) {
  g.save();
  g.shadowColor = `rgba(0, 0, 0, ${alpha})`;
  g.shadowBlur = blur * P;
  g.shadowOffsetX = 1000 * P;
  g.translate(-1000, 0);
  draw();
  g.fillStyle = '#000';
  g.fill();
  g.restore();
}

function rounded(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// fitText writes s centred on (x, y) in the board font, as big as h but no
// wider than w.
function fitText(g, s, x, y, w, h, weight = '700') {
  let size = h;
  g.font = `${weight} ${size}px ${FONT}`;
  const wide = g.measureText(s).width;
  if (wide > w) { size *= w / wide; g.font = `${weight} ${size}px ${FONT}`; }
  g.fillText(s, x, y);
  return size;
}

// paintBoard draws the PAGES pages of a board len metres long, one under
// the other. Each has a main band in its upper part, the part that shows
// over the far rail from behind the cue, and a line of small print under
// it. The pages: the match (the names either side of the score, or who is
// there), the game's mark, the room's code, and a word on the game; the
// small print names the table too. info: {mode, names, score (null without
// a match), race, practice, room, table}.
function paintBoard(c, len, info, kind) {
  const g = c.getContext('2d');
  const u = c.height / PAGES, pw = c.width; // sizes below are fractions of u, a page's height
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, pw, c.height);
  const game = GAME[info.mode] || '8-BALL';
  const names = info.names.map((n) => (n || '').toUpperCase());
  const goal = info.race ? (info.mode === '3cushion' ? `${info.race} POINTS` : `RACE TO ${info.race}`) : '';
  const print = [info.practice ? 'PRACTICE' : '', game, goal, info.room ? `ROOM ${info.room}` : '', (info.table || '').toUpperCase()].filter(Boolean).join('     \u2022     ');
  const glow = (color, blur = 0.07) => { g.fillStyle = color; g.shadowColor = color; g.shadowBlur = u * blur; };
  // tiles: n copies of a picture along the board, each drawn by f at its middle x
  const tiles = (width, f) => {
    const n = Math.max(1, Math.round(pw / width));
    for (let i = 0; i < n; i++) f((i + 0.5) * pw / n);
  };
  for (let p = 0; p < PAGES; p++) {
    const y0 = p * u;
    const mid = y0 + u * 0.34, low = y0 + u * 0.8;
    const bg = g.createLinearGradient(0, y0, 0, y0 + u);
    bg.addColorStop(0, '#0c121a');
    bg.addColorStop(0.62, '#070a0f');
    bg.addColorStop(1, '#040609');
    g.fillStyle = bg;
    g.fillRect(0, y0, pw, u);
    g.save();
    g.beginPath();
    g.rect(0, y0, pw, u);
    g.clip();
    g.fillStyle = 'rgba(227, 180, 80, 0.6)';
    g.fillRect(0, y0 + u * 0.03, pw, Math.max(1, u * 0.012));
    g.fillStyle = 'rgba(227, 180, 80, 0.35)';
    g.fillRect(0, y0 + u * 0.665, pw, Math.max(1, u * 0.008));
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    if (p === 0) {
      if (info.practice || !names[0] || !names[1]) {
        // practice, or one player waiting: who is there, the game either side
        const who = info.practice ? 'PRACTICE' : names[0] || names[1] || 'POOL';
        glow(INK);
        fitText(g, who, pw / 2, mid, pw * 0.5, u * 0.42);
        const half = g.measureText(who).width / 2;
        glow(BRASS);
        for (const side of [-1, 1]) fitText(g, game, pw / 2 + side * (half + u * 1.2), mid, u * 1.5, u * 0.26);
      } else {
        // the score in a brass box, a name either side of it
        const bw = u * 1.6, bh = u * 0.46;
        g.fillStyle = '#121a24';
        rounded(g, pw / 2 - bw / 2, mid - bh / 2, bw, bh, u * 0.06);
        g.fill();
        g.strokeStyle = BRASS;
        g.lineWidth = u * 0.02;
        g.stroke();
        glow(INK);
        fitText(g, info.score ? `${info.score[0]}  \u2013  ${info.score[1]}` : 'VS', pw / 2, mid + u * 0.015, bw * 0.84, u * 0.38);
        const room = Math.min(pw * 0.3, u * 4);
        g.textAlign = 'right';
        fitText(g, names[0], pw / 2 - bw / 2 - u * 0.25, mid, room, u * 0.4);
        g.textAlign = 'left';
        fitText(g, names[1], pw / 2 + bw / 2 + u * 0.25, mid, room, u * 0.4);
        if (kind === 'long') {
          glow(BRASS);
          g.textAlign = 'center';
          for (const side of [-1, 1]) fitText(g, side < 0 ? game : goal || game, pw / 2 + side * pw * 0.39, mid, pw * 0.16, u * 0.26);
        }
      }
    } else if (p === 1) {
      // the mark: a ball, POOL, the game
      tiles(u * 4.4, (x) => {
        drawBall(g, x - u * 1.3, mid, u * 0.2, info.mode);
        glow(INK);
        g.textAlign = 'left';
        fitText(g, info.mode === '3cushion' ? 'CAROM' : 'POOL', x - u * 0.98, mid, u * 1.4, u * 0.44);
        glow(BRASS);
        fitText(g, game, x + u * 0.62, mid, u * 1.3, u * 0.24);
      });
    } else if (p === 2) {
      tiles(u * 4.8, (x) => {
        glow(GREEN);
        g.textAlign = 'right';
        fitText(g, 'ROOM', x - u * 0.1, mid, u * 1.2, u * 0.26);
        glow(INK);
        g.textAlign = 'left';
        fitText(g, info.room || '\u2014', x + u * 0.06, mid, u * 2.1, u * 0.44);
      });
    } else {
      tiles(u * 6.4, (x) => {
        glow(BRASS);
        g.textAlign = 'center';
        fitText(g, SLOGAN[info.mode] || SLOGAN['8ball'], x, mid, u * 4.6, u * 0.34);
        g.shadowBlur = 0;
        drawBall(g, x + u * 3.2, mid, u * 0.1, info.mode);
      });
    }
    // the small print, the same on every page
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(242, 239, 230, 0.55)';
    g.textAlign = 'center';
    g.font = `600 ${u * 0.13}px ${FONT}`;
    tiles(g.measureText(print).width + u * 1.2, (x) => g.fillText(print, x, low));
    g.restore();
  }
  // the LEDs: a faint grid over the picture
  g.fillStyle = 'rgba(0, 0, 0, 0.22)';
  for (let x = 0; x < pw; x += 3) g.fillRect(x, 0, 1, c.height);
  for (let y = 0; y < c.height; y += 3) g.fillRect(0, y, pw, 1);
}

// drawBall draws a small ball for the game: the 8, the 9 or a carom red.
function drawBall(g, x, y, r, mode) {
  g.save();
  g.shadowBlur = 0;
  const base = mode === '9ball' ? '#f2efe6' : mode === '3cushion' ? '#cc3326' : '#111316';
  g.fillStyle = base;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  if (mode === '9ball') {
    g.save();
    g.clip();
    g.fillStyle = '#f2c12e';
    g.fillRect(x - r, y - r * 0.55, 2 * r, r * 1.1);
    g.restore();
  }
  if (mode !== '3cushion') {
    g.fillStyle = '#faf7ef';
    g.beginPath(); g.arc(x, y, r * 0.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111316';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${r * 0.75}px ${FONT}`;
    g.fillText(mode === '9ball' ? '9' : '8', x, y + r * 0.04);
  }
  g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  g.lineWidth = Math.max(1, r * 0.06);
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.restore();
}

// seatGeometry is one stand seat, its front toward +z: a pan on a post and
// a back leaning a little.
function seatGeometry() {
  const t = (x, y, z, rx = 0) => new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z);
  return merge([
    { geo: new THREE.BoxGeometry(0.06, 0.38, 0.06), matrix: t(0, 0.19, -0.08) },
    { geo: new THREE.BoxGeometry(0.44, 0.05, 0.4), matrix: t(0, 0.42, 0.02) },
    { geo: new THREE.BoxGeometry(0.44, 0.42, 0.05), matrix: t(0, 0.65, -0.19, -0.16) },
  ]);
}

// merge joins geometries, each moved by its matrix, into one (positions,
// normals, and texture coordinates when they all have them): one draw for
// many shapes. The parts are disposed of.
export function merge(parts) {
  let n = 0, m = 0;
  for (const { geo } of parts) {
    n += geo.attributes.position.count;
    m += geo.index ? geo.index.count : geo.attributes.position.count;
  }
  const uvs = parts.every(({ geo }) => geo.attributes.uv);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = uvs ? new Float32Array(n * 2) : null;
  const idx = new Uint32Array(m);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  let vo = 0, io = 0;
  for (const { geo, matrix } of parts) {
    const p = geo.attributes.position, q = geo.attributes.normal;
    nm.getNormalMatrix(matrix);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      v.fromBufferAttribute(q, i).applyMatrix3(nm).normalize();
      nor[(vo + i) * 3] = v.x; nor[(vo + i) * 3 + 1] = v.y; nor[(vo + i) * 3 + 2] = v.z;
      if (uv) { uv[(vo + i) * 2] = geo.attributes.uv.getX(i); uv[(vo + i) * 2 + 1] = geo.attributes.uv.getY(i); }
    }
    const count = geo.index ? geo.index.count : p.count;
    for (let i = 0; i < count; i++) idx[io + i] = vo + (geo.index ? geo.index.getX(i) : i);
    vo += p.count;
    io += count;
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// random: a small seeded generator (mulberry32), so the arena is the same
// every time.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
