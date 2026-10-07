// The table in 3D (docs/CLIENT.md, "3D view"). This module only draws:
// app.js keeps the game, works out what is on the table and hands a frame
// to render() every animation frame. It is loaded on demand, the first time
// the 3D view is turned on.
//
// Axes: the table's x stays x, its y (down the screen in 2D) is world z,
// and "into the slate" is world −y, so up is +y and the bed is at y = 0.
import * as THREE from '/vendor/three-r186/three.min.js';

const CUSHION_H = 0.040; // cushion top above the bed
const RAIL_H = 0.044;    // rail top above the bed
const FOV = 42;          // vertical field of view, degrees; more on a tall screen
const FOV_TALL = 60;
const CUE_TILT = 6 * Math.PI / 180;

// createView3D draws into canvas and returns the view. k carries the
// table's measures and look from app.js:
//   W, H, R, RAIL, CUSHION, HEAD, cushions (TABLE.cushions), holes ({x, y, r}
//   per pocket), felt (a canvas of the 2D table from above, RAIL beyond the
//   cushions on every side), colors, ballColors, cueSegments, cueLength,
//   reduceMotion() and onLost().
// It throws when WebGL is not available.
export function createView3D(canvas, k) {
  const { W, H, R, RAIL } = k;
  const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL 2 is not available');
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); k.onLost(); });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b0e12');
  scene.fog = new THREE.Fog('#0b0e12', 4, 9);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 20);

  const V = (x, y, h = 0) => new THREE.Vector3(x, h, y);
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };

  // --- lights -----------------------------------------------------------
  scene.add(new THREE.HemisphereLight('#fff4e0', '#1a1a1a', 0.55));
  for (const x of [W * 0.28, W * 0.72]) {
    const lamp = new THREE.SpotLight('#fff1dc', 9, 0, 0.95, 0.75, 2);
    lamp.position.set(x, 1.15, H / 2);
    lamp.target.position.set(x, 0, H / 2);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(1024, 1024);
    lamp.shadow.camera.near = 0.6;
    lamp.shadow.camera.far = 1.6;
    lamp.shadow.bias = -0.0004;
    lamp.shadow.radius = 4;
    scene.add(lamp, lamp.target);
  }
  // reflections: a dark room with the lamp's panel overhead
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 6), new THREE.MeshBasicMaterial({ color: '#202326', side: THREE.BackSide }));
  box.position.y = 1.2;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  panel.material.color.multiplyScalar(6);
  panel.position.set(0, 1.4, 0);
  panel.rotation.x = Math.PI / 2;
  room.add(box, panel);
  const env = pmrem.fromScene(room, 0.03).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  box.geometry.dispose(); panel.geometry.dispose(); box.material.dispose(); panel.material.dispose();
  pmrem.dispose();
  keep(env);

  // --- table ------------------------------------------------------------
  // The cushion line with the pockets cut in: walking the rectangle behind
  // the cushions, each pocket's circle replaces the part of the walk inside
  // it, by its inner arc (the bed: the cloth stops at the hole) or its outer
  // arc (the rail: the wood goes round it).
  const C = k.CUSHION;
  function outline(outward) {
    const x0 = -C, y0 = -C, x1 = W + C, y1 = H + C;
    const per = [ // clockwise from the middle of the left edge, clear of pockets
      [x0, H / 2, x0, y0], [x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, H / 2],
    ];
    const pts = [];
    const inside = (x, y) => k.holes.findIndex((h) => Math.hypot(x - h.x, y - h.y) < h.r);
    const edge = (a, b, hole) => { // bisect the crossing between a (outside) and b (inside)
      let lo = a, hi = b;
      for (let i = 0; i < 30; i++) {
        const m = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
        if (Math.hypot(m[0] - hole.x, m[1] - hole.y) < hole.r) hi = m; else lo = m;
      }
      return lo;
    };
    let prev = null, entry = null, inHole = -1;
    for (const [ax, ay, bx, by] of per) {
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.005));
      for (let i = 0; i <= n; i++) {
        const p = [ax + (bx - ax) * i / n, ay + (by - ay) * i / n];
        const h = inside(p[0], p[1]);
        if (inHole < 0 && h < 0) {
          if (!prev || i > 0) pts.push(p);
        } else if (inHole < 0 && h >= 0) {
          entry = edge(prev, p, k.holes[h]);
          inHole = h;
        } else if (inHole >= 0 && h < 0) {
          const hole = k.holes[inHole];
          const exit = edge(p, prev, hole);
          pts.push(...arc(hole, entry, exit, outward));
          pts.push(p);
          inHole = -1;
        }
        prev = p;
      }
    }
    const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(fx - lx, fy - ly) < 1e-6) pts.pop();
    return pts.map(([x, y]) => new THREE.Vector2(x, -y)); // shapes are built in (x, −y); see flat()
  }
  function arc(h, from, to, outward) {
    const a1 = Math.atan2(from[1] - h.y, from[0] - h.x);
    let a2 = Math.atan2(to[1] - h.y, to[0] - h.x);
    let sweep = a2 - a1;
    while (sweep <= 0) sweep += Math.PI * 2;
    const mid = (sw) => [h.x + h.r * Math.cos(a1 + sw / 2), h.y + h.r * Math.sin(a1 + sw / 2)];
    const far = (p) => Math.hypot(p[0] - W / 2, p[1] - H / 2);
    const other = sweep - Math.PI * 2;
    if ((far(mid(sweep)) > far(mid(other))) !== outward) sweep = other;
    const out = [];
    const n = 28;
    for (let i = 0; i <= n; i++) {
      const a = a1 + sweep * i / n;
      out.push([h.x + h.r * Math.cos(a), h.y + h.r * Math.sin(a)]);
    }
    return out;
  }
  // flat lays a geometry built in the shape plane (x, −y) on the table: the
  // shape's z becomes height.
  const flat = (geo) => geo.rotateX(-Math.PI / 2);

  const felt = keep(new THREE.CanvasTexture(k.felt));
  felt.colorSpace = THREE.SRGBColorSpace;
  felt.flipY = false;
  felt.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const bedGeo = keep(flat(new THREE.ShapeGeometry(new THREE.Shape(outline(false)))));
  { // texture coordinates: the felt canvas spans the table plus RAIL
    const pos = bedGeo.attributes.position, uv = bedGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + RAIL) / (W + 2 * RAIL), (pos.getZ(i) + RAIL) / (H + 2 * RAIL));
  }
  const bed = new THREE.Mesh(bedGeo, keep(new THREE.MeshStandardMaterial({ map: felt, roughness: 0.95, metalness: 0 })));
  bed.receiveShadow = true;
  scene.add(bed);

  const railShape = new THREE.Shape();
  { const r = 0.06, a = -RAIL, b = W + RAIL, c = -(H + RAIL), d = RAIL; // (x, −y)
    railShape.moveTo(a + r, c); railShape.lineTo(b - r, c); railShape.quadraticCurveTo(b, c, b, c + r);
    railShape.lineTo(b, d - r); railShape.quadraticCurveTo(b, d, b - r, d); railShape.lineTo(a + r, d);
    railShape.quadraticCurveTo(a, d, a, d - r); railShape.lineTo(a, c + r); railShape.quadraticCurveTo(a, c, a + r, c); }
  railShape.holes.push(new THREE.Path(outline(true)));
  const railGeo = keep(flat(new THREE.ExtrudeGeometry(railShape, {
    depth: RAIL_H - 0.004, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 2, curveSegments: 12,
  })));
  const wood = keep(new THREE.MeshPhysicalMaterial({ color: k.colors.rail, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.25 }));
  const rail = new THREE.Mesh(railGeo, wood);
  rail.castShadow = true;
  rail.receiveShadow = true;
  scene.add(rail);
  // the apron under the rail: four boards at the outer edge, clear of the
  // pockets (a solid block would show through the holes); a floor far below
  const apronMat = keep(new THREE.MeshStandardMaterial({ color: k.colors.railBottom, roughness: 0.6 }));
  const board = 0.008;
  for (const [w, d, x, z] of [
    [W + 2 * RAIL, board, W / 2, -RAIL + board / 2], [W + 2 * RAIL, board, W / 2, H + RAIL - board / 2],
    [board, H + 2 * RAIL, -RAIL + board / 2, H / 2], [board, H + 2 * RAIL, W + RAIL - board / 2, H / 2],
  ]) {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, 0.2, d)), apronMat);
    m.position.set(x, -0.104, z);
    scene.add(m);
  }
  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(14, 14)), keep(new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 1 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, -0.78, H / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // cushions: the 2D quads (nose, jaws, back) raised to cushion height
  const clothSide = keep(new THREE.MeshStandardMaterial({ color: k.colors.cushion, roughness: 0.92 }));
  for (const c of k.cushions) {
    const lf = C / Math.abs(c.jawFrom.x * c.inward.x + c.jawFrom.y * c.inward.y);
    const lt = C / Math.abs(c.jawTo.x * c.inward.x + c.jawTo.y * c.inward.y);
    const q = [c.from, c.to, { x: c.to.x + c.jawTo.x * lt, y: c.to.y + c.jawTo.y * lt }, { x: c.from.x + c.jawFrom.x * lf, y: c.from.y + c.jawFrom.y * lf }];
    const geo = keep(flat(new THREE.ExtrudeGeometry(new THREE.Shape(q.map((p) => new THREE.Vector2(p.x, -p.y))), { depth: CUSHION_H, bevelEnabled: false })));
    const m = new THREE.Mesh(geo, clothSide);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
  // pockets: a dark liner below each hole
  const liner = keep(new THREE.MeshStandardMaterial({ color: '#060708', roughness: 1, side: THREE.DoubleSide }));
  const leather = keep(new THREE.MeshStandardMaterial({ color: '#0d0c0b', roughness: 0.55, side: THREE.DoubleSide }));
  for (const h of k.holes) {
    const cup = new THREE.Mesh(keep(new THREE.CylinderGeometry(h.r, h.r * 0.9, 0.16, 32, 1, true)), liner);
    cup.position.set(h.x, -0.08, h.y);
    // leather facing the wood where the rail goes round the hole: the part
    // of the circle outside the cushion line (a cylinder's angle θ puts a
    // point at x = sin θ, z = cos θ)
    const out = (th) => { const x = h.x + h.r * Math.sin(th), y = h.y + h.r * Math.cos(th); return x < -C || y < -C || x > W + C || y > H + C; };
    const from = Math.atan2(W / 2 - h.x, H / 2 - h.y); // toward the table: inside
    let a = null, b = null;
    for (let i = 0; i <= 360; i++) {
      const th = from + i * Math.PI / 180;
      if (out(th)) { if (a === null) a = th; b = th; }
    }
    if (a !== null) {
      const facing = new THREE.Mesh(keep(new THREE.CylinderGeometry(h.r + 0.0005, h.r + 0.0005, RAIL_H + 0.001, 40, 1, true, a, b - a)), leather);
      facing.position.set(h.x, (RAIL_H + 0.001) / 2, h.y);
      scene.add(facing);
    }
    const bottom = new THREE.Mesh(keep(new THREE.CircleGeometry(h.r * 0.9, 32)), liner);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(h.x, -0.16, h.y);
    scene.add(cup, bottom);
  }
  // sights on the rail
  const sightGeo = keep(flat(new THREE.ShapeGeometry(new THREE.Shape([[-1, 0], [0, -1], [1, 0], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y))))));
  const sightMat = keep(new THREE.MeshStandardMaterial({ color: k.colors.sight, roughness: 0.35, metalness: 0.1 }));
  const sight = (x, y, alongX) => {
    const m = new THREE.Mesh(sightGeo, sightMat);
    m.scale.set(alongX ? 0.011 : 0.007, 1, alongX ? 0.007 : 0.011);
    m.position.set(x, RAIL_H + 0.0006, y);
    scene.add(m);
  };
  for (const i of [1, 2, 3, 5, 6, 7]) { sight(W / 8 * i, -0.0725, true); sight(W / 8 * i, H + 0.0725, true); }
  for (const i of [1, 2, 3]) { sight(-0.0725, H / 4 * i, false); sight(W + 0.0725, H / 4 * i, false); }

  // --- balls ------------------------------------------------------------
  // Each ball's markings are painted once on an equirectangular texture in
  // the sphere's own frame L. A stripe's frame is turned (P) so its number
  // discs sit on the texture's equator, away from the seam and the poles.
  // The 2D view keeps a ball frame b per ball (table ← b); the mesh turns by
  // M·O·P, M taking table axes to world axes, so both views show a ball the
  // same way up.
  const ballGeo = keep(new THREE.SphereGeometry(R, 48, 32));
  const balls = new Map();
  const STRIPE_P = [0, 0, 1, 0, 1, 0, -1, 0, 0]; // b = P·L, row-major
  for (let id = 0; id <= 15; id++) {
    const tex = keep(new THREE.CanvasTexture(ballCanvas(id)));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = keep(new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.05 }));
    const mesh = new THREE.Mesh(ballGeo, mat);
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    scene.add(mesh);
    balls.set(id, mesh);
  }
  function ballCanvas(id) {
    const TW = 512, TH = 256;
    const c = document.createElement('canvas');
    c.width = TW; c.height = TH;
    const g = c.getContext('2d');
    const img = g.createImageData(TW, TH);
    const px = img.data;
    const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const ivory = rgb(k.colors.ivory), discC = rgb(k.colors.disc), dot = rgb('#B4322A'), ink = rgb(k.colors.ink);
    const base = id === 0 || id > 8 ? ivory : rgb(k.ballColors[id]);
    const band = id > 8 ? rgb(k.ballColors[id - 8]) : null;
    const cosDisc = 0.877, cosDot = 0.985, rho = Math.sqrt(1 - cosDisc * cosDisc);
    const glyph = id > 0 ? numberGlyph(id) : null;
    const G = glyph ? glyph.width : 0;
    const discs = id > 8 ? [[1, 0, 0], [-1, 0, 0]] : [[0, 0, 1], [0, 0, -1]];
    const up = id > 8 ? [0, 0, -1] : [0, -1, 0];
    const P = id > 8 ? STRIPE_P : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let j = 0; j < TH; j++) {
      const th = ((j + 0.5) / TH) * Math.PI;
      for (let i = 0; i < TW; i++) {
        const ph = ((i + 0.5) / TW) * Math.PI * 2;
        const L = [-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th)];
        const b = [P[0] * L[0] + P[1] * L[1] + P[2] * L[2], P[3] * L[0] + P[4] * L[1] + P[5] * L[2], P[6] * L[0] + P[7] * L[1] + P[8] * L[2]];
        let col = base;
        if (id === 0) {
          if (Math.abs(b[0]) > cosDot || Math.abs(b[1]) > cosDot || Math.abs(b[2]) > cosDot) col = dot;
        } else {
          if (band && Math.abs(b[2]) <= 0.58) col = band;
          for (const d of discs) {
            if (b[0] * d[0] + b[1] * d[1] + b[2] * d[2] <= cosDisc) continue;
            col = discC;
            // the number, upright to whoever looks at the disc from outside
            const right = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
            const sx = (b[0] * right[0] + b[1] * right[1] + b[2] * right[2]) / rho;
            const sy = (b[0] * up[0] + b[1] * up[1] + b[2] * up[2]) / rho;
            const gx = Math.floor((sx * 0.5 + 0.5) * G), gy = Math.floor((0.5 - sy * 0.5) * G);
            if (gx >= 0 && gy >= 0 && gx < G && gy < G) {
              const a = glyph.alpha[gy * G + gx] / 255;
              if (a > 0) col = [col[0] + (ink[0] - col[0]) * a, col[1] + (ink[1] - col[1]) * a, col[2] + (ink[2] - col[2]) * a];
            }
          }
        }
        const q = (j * TW + i) * 4;
        px[q] = col[0]; px[q + 1] = col[1]; px[q + 2] = col[2]; px[q + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function numberGlyph(id) {
    const G = 96;
    const c = document.createElement('canvas');
    c.width = c.height = G;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.font = `700 ${Math.round(G * 0.64)}px "Source Sans 3", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(id), G / 2, G / 2 + G * 0.04);
    const data = g.getImageData(0, 0, G, G).data;
    const alpha = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) alpha[i] = data[i * 4 + 3];
    return { width: G, alpha };
  }
  const rot = new THREE.Matrix4();
  // placeBall sets mesh's matrix: position p (table metres) raised by up,
  // turned by the 2D orientation o (row-major, table ← ball).
  function placeBall(mesh, id, p, o, up, scale) {
    const P = id > 8 ? STRIPE_P : null;
    // M·O: rows of O permuted, (x, y, z) → (x, −z, y)
    const m = [o[0], o[1], o[2], -o[6], -o[7], -o[8], o[3], o[4], o[5]];
    let r = m;
    if (P) {
      r = new Array(9);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = m[i * 3] * P[j] + m[i * 3 + 1] * P[3 + j] + m[i * 3 + 2] * P[6 + j];
    }
    const s = scale ?? 1;
    rot.set(r[0] * s, r[1] * s, r[2] * s, p.x, r[3] * s, r[4] * s, r[5] * s, R + up, r[6] * s, r[7] * s, r[8] * s, p.y, 0, 0, 0, 1);
    mesh.matrix.copy(rot);
    mesh.matrixWorldNeedsUpdate = true;
  }

  // --- cue --------------------------------------------------------------
  const cueTex = (() => {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    const g = c.getContext('2d');
    for (const [a, b, colour] of k.cueSegments) {
      const y0 = a / k.cueLength * 512, y1 = b / k.cueLength * 512;
      if (Array.isArray(colour)) {
        const grad = g.createLinearGradient(0, y0, 0, y1);
        grad.addColorStop(0, colour[0]); grad.addColorStop(1, colour[1]);
        g.fillStyle = grad;
      } else g.fillStyle = colour;
      g.fillRect(0, y0, 4, y1 - y0 + 1);
    }
    const t = keep(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const cueMat = keep(new THREE.MeshPhysicalMaterial({ map: cueTex, roughness: 0.35, clearcoat: 0.6, transparent: true }));
  const cue = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.0065, 0.0145, k.cueLength, 24, 1)), cueMat);
  cue.castShadow = true;
  scene.add(cue);
  const yAxis = new THREE.Vector3(0, 1, 0);
  function placeCue(c) {
    cue.visible = !!c && c.alpha > 0;
    if (!cue.visible) return;
    const ux = -c.dir.x, uy = -c.dir.y; // tip → butt, on the table
    const cos = Math.cos(CUE_TILT), sin = Math.sin(CUE_TILT);
    const s = c.back + k.cueLength / 2;
    cue.position.set(c.x + ux * s * cos, R + s * sin, c.y + uy * s * cos);
    cue.quaternion.setFromUnitVectors(yAxis, new THREE.Vector3(-ux * cos, -sin, -uy * cos));
    cueMat.opacity = c.alpha;
    cueMat.depthWrite = c.alpha > 0.99;
  }

  // --- guide, rings, washes: flat marks just above the cloth --------------
  // Strips holds quads for line segments, rebuilt every frame.
  function strips(max) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 4 * 3);
    const col = new Float32Array(max * 4 * 4);
    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    keep(geo);
    const mat = keep(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
    let n = 0;
    const tmp = new THREE.Color();
    return {
      begin() { n = 0; },
      quad(ax, ay, bx, by, w, color, alpha, h = 0.0007) {
        if (n >= max) return;
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * w / 2, ny = dx / l * w / 2;
        pos.set([ax + nx, h, ay + ny, ax - nx, h, ay - ny, bx + nx, h, by + ny, bx - nx, h, by - ny], n * 12);
        tmp.set(color).convertSRGBToLinear();
        for (let v = 0; v < 4; v++) col.set([tmp.r, tmp.g, tmp.b, alpha], n * 16 + v * 4);
        n++;
      },
      line(a, b, w, color, alpha, dash) {
        if (!dash) { this.quad(a.x, a.y, b.x, b.y, w, color, alpha); return; }
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
        if (l < 1e-6) return;
        const ux = dx / l, uy = dy / l;
        for (let s = 0; s < l; s += dash[0] + dash[1]) {
          const e = Math.min(l, s + dash[0]);
          this.quad(a.x + ux * s, a.y + uy * s, a.x + ux * e, a.y + uy * e, w, color, alpha);
        }
      },
      circle(x, y, r, w, color, alpha, h) {
        const seg = 48;
        for (let i = 0; i < seg; i++) {
          const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
          this.quad(x + r * Math.cos(a0), y + r * Math.sin(a0), x + r * Math.cos(a1), y + r * Math.sin(a1), w, color, alpha, h);
        }
      },
      end() {
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        geo.setDrawRange(0, n * 6);
      },
    };
  }
  const marks = strips(1600);
  const ghost = new THREE.Mesh(ballGeo, keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.1, depthWrite: false })));
  ghost.renderOrder = 3;
  scene.add(ghost);
  const kitchen = new THREE.Mesh(keep(new THREE.PlaneGeometry(k.HEAD, H)), keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.06, depthWrite: false })));
  kitchen.rotation.x = -Math.PI / 2;
  kitchen.position.set(k.HEAD / 2, 0.0004, H / 2);
  scene.add(kitchen);

  // --- camera -----------------------------------------------------------
  const cam = { pos: new THREE.Vector3(W / 2, 2.4, H / 2 + 2), look: new THREE.Vector3(W / 2, 0, H / 2), up: new THREE.Vector3(0, 1, 0), mode: '', since: 0, last: 0, yaw: 0, fresh: true };
  const size = { w: 1, h: 1, dpr: 1 };
  function pose(c) {
    const aspect = size.w / size.h;
    const t = Math.tan(camera.fov * Math.PI / 360);
    switch (c.mode) {
      case 'aim': {
        const dx = Math.cos(c.angle), dy = Math.sin(c.angle);
        const tall = aspect < 1;
        // the look point is below the cloth to tip the view down: the far
        // rail near the top edge, little room above it
        const back = tall ? 0.95 : 0.9, hgt = tall ? 0.75 : 0.36, ahead = tall ? 1.1 : 1.0, below = tall ? 0.45 : 0.16;
        return { pos: V(c.cue.x - dx * back, c.cue.y - dy * back, hgt), look: V(c.cue.x + dx * ahead, c.cue.y + dy * ahead, -below), up: new THREE.Vector3(0, 1, 0) };
      }
      case 'chase': {
        const dx = c.dir.x, dy = c.dir.y;
        return { pos: V(c.p.x - dx * 0.6, c.p.y - dy * 0.6, 0.32), look: V(c.p.x + dx * 0.45, c.p.y + dy * 0.45, 0), up: new THREE.Vector3(0, 1, 0) };
      }
      case 'follow': {
        const b = c.box;
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        const rad = Math.max(0.45, Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + 0.15);
        const dist = rad / Math.min(t, t * aspect) * 1.05;
        const pitch = 58 * Math.PI / 180;
        const dx = Math.cos(c.angle), dy = Math.sin(c.angle);
        return { pos: V(cx - dx * dist * Math.cos(pitch), cy - dy * dist * Math.cos(pitch), dist * Math.sin(pitch)), look: V(cx, cy, 0), up: new THREE.Vector3(0, 1, 0) };
      }
      case 'top': {
        const fw = W + 2 * RAIL, fh = H + 2 * RAIL;
        const portrait = aspect < 1;
        const across = portrait ? fh : fw, along = portrait ? fw : fh; // screen width, screen height
        const hgt = Math.max(along / 2 / t, across / 2 / (t * aspect)) * 1.03 + RAIL_H;
        return { pos: V(W / 2, H / 2, hgt), look: V(W / 2, H / 2, 0), up: portrait ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1) };
      }
      default: { // overview: three quarters from the side facing the screen
        const portrait = aspect < 1;
        const dist = (portrait ? 3.6 : 2.7) / Math.max(0.75, Math.min(1.6, aspect));
        const pos = portrait ? V(-dist * 0.55, H / 2, dist * 0.8) : V(W / 2, H / 2 + dist * 0.62, dist * 0.78);
        return { pos, look: V(W / 2, H / 2, -0.05), up: new THREE.Vector3(0, 1, 0) };
      }
    }
  }
  function moveCamera(c, now) {
    const dt = cam.last ? Math.min(0.5, (now - cam.last) / 1000) : 1;
    cam.last = now;
    if (c.mode !== cam.mode) { cam.mode = c.mode; cam.since = now; }
    const target = pose(c);
    const settling = now - cam.since < 900;
    const tau = cam.fresh || k.reduceMotion() ? 0 : settling ? 0.2 : c.mode === 'aim' ? 0.05 : c.mode === 'chase' ? 0.25 : 0.3;
    const f = tau ? 1 - Math.exp(-dt / tau) : 1;
    cam.pos.lerp(target.pos, f);
    cam.look.lerp(target.look, f);
    cam.up.lerp(target.up, f).normalize();
    cam.fresh = false;
    cam.settled = cam.pos.distanceTo(target.pos) < 0.003 && cam.look.distanceTo(target.look) < 0.003;
    camera.position.copy(cam.pos);
    camera.up.copy(cam.up);
    camera.lookAt(cam.look);
    camera.updateMatrixWorld();
  }

  // --- frame ------------------------------------------------------------
  const timing = { n: 0, start: 0, done: false, low: false };
  function render(frame, now) {
    for (const [id, mesh] of balls) {
      const p = frame.balls.get(id);
      mesh.visible = !!p;
      if (!p) continue;
      const lift = frame.lifted && frame.lifted.id === id ? frame.lifted.lift * 0.03 : 0;
      placeBall(mesh, id, p, frame.orient(id), lift);
    }
    for (const d of frame.drops) {
      const mesh = balls.get(d.id);
      if (!mesh || frame.balls.has(d.id)) continue;
      mesh.visible = d.alpha > 0;
      placeBall(mesh, d.id, d, frame.orient(d.id), -d.sink);
    }
    placeCue(frame.cue);
    marks.begin();
    ghost.visible = false;
    if (frame.guide) {
      const g = frame.guide, a = g.alpha;
      const [path, ...rest] = g.lines;
      marks.line(path.a, path.b, path.w * 1.4, path.color, path.alpha * a, path.dash);
      for (const l of rest) marks.line(l.a, l.b, l.w * 1.4, l.color, l.alpha * a, l.dash);
      marks.circle(g.ghost.x, g.ghost.y, R, 0.002, g.ghost.color, 0.7 * a);
      ghost.visible = true;
      ghost.position.set(g.ghost.x, R, g.ghost.y);
      ghost.material.opacity = 0.12 * a;
    }
    for (const r of frame.rings) marks.circle(r.x, r.y, r.r, r.w, r.color, r.alpha, 0.0009);
    if (frame.kitchenLine) marks.line({ x: k.HEAD, y: 0 }, { x: k.HEAD, y: H }, 0.003, k.colors.ok, 0.75, [0.016, 0.010]);
    marks.end();
    kitchen.visible = !!frame.kitchenLine;
    moveCamera(frame.cam, now);
    renderer.render(scene, camera);
    // A slow device (software rendering, an old phone) drops to plain
    // shadows at 1× after the first two seconds.
    if (!timing.done) {
      if (!timing.start) timing.start = now;
      else if (++timing.n >= 10 && now - timing.start > 2000) {
        timing.done = true;
        if ((now - timing.start) / timing.n > 25) setQuality(true);
      }
    }
  }
  function setQuality(low) {
    timing.done = true;
    timing.low = low;
    renderer.shadowMap.type = low ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    renderer.shadowMap.needsUpdate = true;
    resize(size.w, size.h, size.dpr);
  }

  // --- coordinates ------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // pick: CSS px within the canvas → table metres, on the plane through the
  // balls' centres. Above the horizon it returns a far point that way.
  function pick(px, py) {
    ndc.set((px / size.w) * 2 - 1, -(py / size.h) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let t = d.y < -1e-4 ? (R - o.y) / d.y : Infinity;
    if (!(t < 40)) {
      const l = Math.hypot(d.x, d.z) || 1;
      return { x: o.x + d.x / l * 40, y: o.z + d.z / l * 40 };
    }
    return { x: o.x + d.x * t, y: o.z + d.z * t };
  }
  const tmp = new THREE.Vector3();
  function project(p, h = R) {
    tmp.set(p.x, h, p.y).project(camera);
    return { x: (tmp.x + 1) / 2 * size.w, y: (1 - tmp.y) / 2 * size.h };
  }
  const right = new THREE.Vector3();
  // pxPerM: how many CSS px a metre spans at p, across the view.
  function pxPerM(p) {
    const a = project(p);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    tmp.set(p.x + right.x * 0.05, R + right.y * 0.05, p.y + right.z * 0.05).project(camera);
    const bx = (tmp.x + 1) / 2 * size.w, by = (1 - tmp.y) / 2 * size.h;
    return Math.max(1, Math.hypot(bx - a.x, by - a.y) / 0.05);
  }

  function resize(w, h, dpr) {
    Object.assign(size, { w, h, dpr });
    camera.aspect = w / h;
    camera.fov = w < h ? FOV_TALL : FOV;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(timing.low ? 1 : Math.min(2, dpr));
    renderer.setSize(w, h, false);
    cam.fresh = true;
  }

  function dispose() {
    for (const d of disposables) d.dispose();
    renderer.dispose();
  }

  return {
    render, pick, project, pxPerM, resize, dispose, setQuality,
    get mode() { return cam.mode; },
    get settled() { return !!cam.settled; },
    get lowQuality() { return timing.low; },
  };
}
