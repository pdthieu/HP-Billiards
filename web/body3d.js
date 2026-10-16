// body3d.js: the players of the 3D view (CLIENT.md, "3D view") as solids
// (sdf3d.js), in their bind pose: standing, arms 45° down (an A), on the
// floor at y = 0, facing +z, their left at +x. No Three.js and no page
// here, so mesh3d-worker.js can run it: meshLook() turns a look into its
// meshes' arrays; players3d.js makes them geometries, colours and poses
// them. The style is stylised: a head a little large for the body, big
// eyes, a small nose, a mouth drawn more than carved, hair in clean clumps.
import * as S from '/sdf3d.js';

const { abs, max, min, sqrt, sin, cos, PI, atan2 } = Math;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smax = (a, b, k) => { const h = max(k - abs(a - b), 0) / k; return max(a, b) + h * h * k * 0.25; };
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const toHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// --- the look -------------------------------------------------------------
// A look is a few choices: the body, the colours, the hair, the face's
// measures and the side, whose colour the waistcoat takes. They are what a
// photo can fill in and all the other player needs to be sent. makeLook()
// adds the rest: the body's measures (lengths in metres; widths are half
// widths) and the dress.
const BODY = {
  man: {
    height: 1.78, headSize: 1.26,
    shoulder: 0.184, hip: 0.088,
    pelvis: [0.162, 0.106], waist: [0.148, 0.097], ribs: [0.158, 0.104], chest: [0.167, 0.105],
    bust: 0, pecs: 1, neck: 0.053,
    arm: [0.044, 0.038, 0.033], leg: [0.088, 0.064, 0.056], hand: 0.86,
  },
  woman: {
    height: 1.66, headSize: 1.21,
    shoulder: 0.161, hip: 0.094,
    pelvis: [0.168, 0.11], waist: [0.122, 0.087], ribs: [0.136, 0.092], chest: [0.146, 0.094],
    bust: 1, pecs: 0, neck: 0.045,
    arm: [0.037, 0.032, 0.028], leg: [0.085, 0.059, 0.05], hand: 0.78,
  },
};
// The face's measures, 1 being the body's usual: w the face's width, jaw
// its width at the jaw, chin, cheek (fullness), eye (size), gap (between
// the eyes), tilt (their outer corners up), open, nose, mouth (width), lips
// (fullness), brow (thickness), arch, smile (the corners up), lash (the
// lash line's weight), tint (the lips' colour), blush.
export const FACE = {
  man: { w: 1, jaw: 1, chin: 1, cheek: 1, eye: 1, gap: 1, tilt: 0.06, open: 1, nose: 0.9, mouth: 1, lips: 0.6, brow: 1, arch: 0.45, smile: 0.35, lash: 0.85, tint: 0.25, blush: 0.08, beard: 0 },
  woman: { w: 0.97, jaw: 0.72, chin: 0.88, cheek: 1.1, eye: 1.06, gap: 1, tilt: 0.12, open: 1.04, nose: 0.72, mouth: 0.9, lips: 1.08, brow: 0.62, arch: 0.65, smile: 0.4, lash: 1.25, tint: 0.85, blush: 0.2, beard: 0 },
};
export const HAIR_STYLES = { man: ['short', 'quiff', 'buzz'], woman: ['pony', 'bun'] };
// FACE_RANGES: how far each measure a player may set goes, in the editor
// and on the server (internal/protocol FaceRanges)
export const FACE_RANGES = {
  w: [0.85, 1.15], jaw: [0.4, 1.3], chin: [0.7, 1.3], cheek: [0.8, 1.25], eye: [0.85, 1.2],
  gap: [0.9, 1.1], nose: [0.65, 1.3], mouth: [0.8, 1.2], lips: [0.5, 1.3], beard: [0, 1],
};
// the sides: p0 the accent's gold, p1 ball 2's blue
const SIDES = [
  { vest: '#a17a33', vestBack: '#4e3b1a', button: '#2a231e' },
  { vest: '#2b55b0', vestBack: '#13254d', button: '#1c1d22' },
];
const DRESS = { shirt: '#f0eee9', trousers: '#1c1f24', satin: '#101114', shoe: '#0d0d0f', sole: '#24170f' };

export function makeLook(o = {}) {
  const body = o.body === 'woman' ? 'woman' : 'man';
  const woman = body === 'woman';
  const skin = o.skin || (woman ? '#efc4a4' : '#d6a27f');
  const hairColor = o.hairColor || '#17110d';
  const sk = hex(skin), hc = hex(hairColor);
  return {
    id: o.id || body, body, ...BODY[body],
    height: o.height || BODY[body].height,
    face: { ...FACE[body], ...(o.face || {}) },
    hair: o.hair || (woman ? 'pony' : 'short'),
    skin, hairColor,
    // brows a little lighter than dark hair, darker than light hair
    browColor: o.browColor || toHex(mix(hc, [0.12, 0.08, 0.06], 0.35)),
    iris: o.eyes || '#5a3a20',
    // the lips: the skin, redder; hers coloured
    lip: o.lip || toHex(woman ? mix(sk.map((v) => v * 0.85), [0.72, 0.27, 0.32], 0.65) : mix(sk.map((v) => v * 0.88), [0.55, 0.28, 0.26], 0.45)),
    glasses: o.glasses || 0,
    // facial hair is part of the face's measures (beard: 0 none, 0.5 stubble, 1 short)
    tie: true, ...DRESS, ...SIDES[o.side ?? (woman ? 1 : 0)],
  };
}
export const MAN = makeLook({ body: 'man' });
export const WOMAN = makeLook({ body: 'woman' });

// BONES: name, parent, joint (a key of joints()). Every bone starts at its
// joint with no turn, so in the bind pose its axes are the world's.
export const BONES = [
  ['pelvis', null, 'pelvis'], ['spine1', 'pelvis', 'spine1'], ['spine2', 'spine1', 'spine2'], ['chest', 'spine2', 'chest'],
  ['neck', 'chest', 'neck'], ['head', 'neck', 'head'],
  ['clav.L', 'chest', 'clavL'], ['arm.L', 'clav.L', 'shoulderL'], ['fore.L', 'arm.L', 'elbowL'], ['hand.L', 'fore.L', 'wristL'],
  ['clav.R', 'chest', 'clavR'], ['arm.R', 'clav.R', 'shoulderR'], ['fore.R', 'arm.R', 'elbowR'], ['hand.R', 'fore.R', 'wristR'],
  ['thigh.L', 'pelvis', 'hipL'], ['shin.L', 'thigh.L', 'kneeL'], ['foot.L', 'shin.L', 'ankleL'],
  ['thigh.R', 'pelvis', 'hipR'], ['shin.R', 'thigh.R', 'kneeR'], ['foot.R', 'shin.R', 'ankleR'],
];

export const ARM_A = 45 * PI / 180; // the bind pose's arms, down from level

export function joints(p) {
  const s = p.height / 1.78, J = {};
  J.pelvis = [0, 0.985 * s, 0];
  J.spine1 = [0, 1.09 * s, -0.004];
  J.spine2 = [0, 1.2 * s, -0.01];
  J.chest = [0, 1.31 * s, -0.012];
  J.neck = [0, 1.466 * s, -0.028];
  J.head = [0, 1.566 * s, -0.014];
  // the head's own origin, between the ears; a larger head sits a little
  // higher, so the neck still shows
  J.headO = [0, 1.62 * s + 0.1 * (p.headSize - 1.17), 0.004];
  J.clavL = [0.022, 1.44 * s, -0.004];
  J.shoulderL = [p.shoulder, 1.424 * s, -0.014];
  const ua = 0.29 * s, fa = 0.255 * s, d = [sin(ARM_A), -cos(ARM_A), 0];
  J.elbowL = S.add(J.shoulderL, S.scale(d, ua));
  J.wristL = S.add(J.elbowL, S.scale(d, fa));
  J.hipL = [p.hip, 0.935 * s, 0.004];
  J.kneeL = [p.hip + 0.006, 0.505 * s, 0.012];
  J.ankleL = [p.hip + 0.012, 0.083 * s, -0.012];
  for (const k of Object.keys(J)) if (k.endsWith('L')) { const v = J[k]; J[k.slice(0, -1) + 'R'] = [-v[0], v[1], v[2]]; }
  J.armDir = d; J.upper = ua; J.fore = fa;
  return J;
}

// --- the body: shirt, waistcoat, trousers ------------------------------
function bodyParts(p, J) {
  const s = p.height / 1.78, y = (v) => v * s, ws = p.shoulder / 0.183;
  const [chx, chz] = p.chest, [rbx, rbz] = p.ribs, [wx, wz] = p.waist, [px, pz] = p.pelvis;
  const neckBase = [0, y(1.434), -0.03];
  const torsoParts = [
    S.ellipsoid([0, y(0.955), 0], [px, y(0.105), pz]),
    S.ellipsoid([0, y(1.065), 0.004], [wx, y(0.09), wz]),
    S.ellipsoid([0, y(1.19), 0.006], [rbx, y(0.105), rbz]),
    S.ellipsoid([0, y(1.295), 0.002], [chx, y(0.1), chz]),
    S.ellipsoid([0, y(1.37), -0.014], [chx * 0.94, y(0.06), chz * 0.82]),
    // the shoulders' slope, from the neck out to the arm
    S.cone(neckBase, [p.shoulder * 0.88, y(1.39), -0.02], 0.04 * ws, 0.033 * ws),
    S.cone(neckBase, [-p.shoulder * 0.88, y(1.39), -0.02], 0.04 * ws, 0.033 * ws),
    S.sphere(S.add(J.shoulderL, [-0.012, -0.014, 0]), p.arm[0] * 0.78), S.sphere(S.add(J.shoulderR, [0.012, -0.014, 0]), p.arm[0] * 0.78),
    S.ellipsoid([0.082, y(1.325), -0.066], [0.066, y(0.08), 0.04]), S.ellipsoid([-0.082, y(1.325), -0.066], [0.066, y(0.08), 0.04]),
  ];
  if (p.pecs) torsoParts.push(S.ellipsoid([0.064, y(1.3), 0.05], [0.066, 0.054, 0.05]), S.ellipsoid([-0.064, y(1.3), 0.05], [0.066, 0.054, 0.05]));
  if (p.bust) {
    const m = (sx) => S.euler(0.25, sx * 0.18, 0);
    torsoParts.push(S.ellipsoid([0.053, y(1.235), 0.058], [0.059, 0.054, 0.05], m(1)), S.ellipsoid([-0.053, y(1.235), 0.058], [0.059, 0.054, 0.05], m(-1)));
  }
  const torso = S.union(0.05, ...torsoParts);

  // the waistcoat: where on the torso it lies (region < 0); its edges go
  // round the armholes, the back of the neck and down the V in front
  const vBottom = y(1.232), hemBack = y(1.0), hemFront = y(0.992), point = 0.036;
  const armhole = (sx) => S.ellipsoid([sx * (p.shoulder + 0.006), y(1.348), -0.012], [0.07 * ws, y(0.096), 0.085]);
  const holes = [armhole(1), armhole(-1)];
  const region = (X, Y, Z) => {
    const front = smooth(-0.04, 0.04, Z);
    const hem = hemBack + (hemFront - hemBack) * front - front * point * max(0, 1 - abs(X) / 0.085);
    let d = hem - Y;
    d = max(d, -max(0.004 - Z, vBottom + 2.55 * abs(X) - Y));
    for (const h of holes) d = max(d, -h.f(X, Y, Z));
    const nk = max(sqrt(X * X + (Z + 0.028) ** 2) - (p.neck + 0.022), y(1.40) - Y);
    return max(d, -nk);
  };
  const VT = 0.0055;
  const vestAmount = (X, Y, Z) => smooth(0.0035, -0.0025, region(X, Y, Z));
  const torsoVest = S.fn((X, Y, Z) => torso.f(X, Y, Z) - VT * vestAmount(X, Y, Z), [torso.b[0], torso.b[1], torso.b[2], torso.b[3] + VT]);

  // a sleeve starts a little under and in from the shoulder's joint, so it
  // tops out level with the shoulder's line rather than over it
  const sleeve = (side) => {
    const sx = side === 'L' ? 1 : -1;
    const sh = S.add(J['shoulder' + side], [-0.008 * sx, -0.02, 0]), el = J['elbow' + side], wr = J['wrist' + side];
    const end = S.sub(wr, S.scale(S.norm(S.sub(wr, el)), 0.03));
    return S.chain([sh, el, end], p.arm, 0.02);
  };
  const sleeves = S.union(0, sleeve('L'), sleeve('R'));
  const shirt = S.union(0.022, torsoVest, sleeves);

  const legPart = (side) => {
    const hp = J['hip' + side], kn = J['knee' + side], an = J['ankle' + side];
    return S.chain([hp, kn, [an[0], 0.03, an[2] + 0.012]], p.leg, 0.03);
  };
  const trousers = S.meet(0.004, S.union(0.04,
    S.ellipsoid([0, y(0.955), 0], [px + 0.003, y(0.107), pz + 0.003]),
    S.ellipsoid([0.066, y(0.905), -0.052], [0.084, y(0.088), 0.07]), S.ellipsoid([-0.066, y(0.905), -0.052], [0.084, y(0.088), 0.07]),
    legPart('L'), legPart('R')), S.half([0, 1, 0], y(1.04)), S.half([0, -1, 0], -0.036));

  const layers = [{ name: 'shirt', shape: shirt }, { name: 'trousers', shape: trousers }];
  // the vertex colour is how far round to the waistcoat's front a point is
  // (0 its satin back, 1 its front), the same in all three channels; the
  // shader takes the side's colours from it and decides from mask() what
  // shows: the waistcoat, the shirt or the trousers, with crisp edges, and
  // draws the pockets and where the fronts meet (players3d.js, from `vest`)
  const color = (layer, X, Y, Z) => { const t = smooth(-0.05, -0.02, Z); return [t, t, t]; };
  const mask = (X, Y, Z) => {
    const t = torsoVest.f(X, Y, Z);
    return [region(X, Y, Z), trousers.f(X, Y, Z) - min(t, sleeves.f(X, Y, Z)), sleeves.f(X, Y, Z) - t];
  };
  const shape = S.union(0, shirt, trousers);
  const lo = [-(J.wristL[0] + 0.07), 0.02, -0.2], hi = [J.wristL[0] + 0.07, y(1.49), 0.2];
  return { shape, layers, color, mask, lo, hi, vBottom, torso: torsoVest, shirt: hex(p.shirt), trousers: hex(p.trousers), vest: { welt: [0.08, y(1.075), 0.028, 0.0032], seam: vBottom + 0.004 } };
}

// --- head and face --------------------------------------------------------
// The head's own frame: from between the ears, x to the left, y up, z ahead,
// in units the head's size scales. A round cranium over a smaller, softer
// face; the eyes on the head's middle, the brows high over them. The brows,
// the lash lines and the lips are not modelled (modelled lips crease the
// mouth's corners): the face's shader draws them from `features` (players3d.js),
// crisp at any distance.
function headParts(p, J) {
  const q = p.face, hs = p.headSize, o = J.headO, woman = p.body === 'woman';
  const P = (x, yy, z) => [o[0] + x * hs, o[1] + yy * hs, o[2] + z * hs];
  const E = (c, r, m) => S.ellipsoid(P(...c), r.map((v) => v * hs), m);
  const Sp = (c, r) => S.sphere(P(...c), r * hs);
  const Cn = (a, b, ra, rb) => S.cone(P(...a), P(...b), ra * hs, (rb ?? ra) * hs);
  const both = (fn) => [fn(1), fn(-1)];
  const rel = (X, Y, Z) => [(X - o[0]) / hs, (Y - o[1]) / hs, (Z - o[2]) / hs];
  const w = q.w, ck = q.cheek, jaw = 0.9 + 0.1 * q.jaw;

  const skull = S.union(0.03,
    E([0, 0.036, -0.012], [0.079 * w, 0.096, 0.096]),
    E([0, 0.042, 0.028], [0.07 * w, 0.066, 0.07]));
  // the face: the cheeks' mass, and under it one smooth taper to the chin;
  // his jaw has corners under the ears
  const faceParts = [
    E([0, -0.004, 0.04], [0.066 * w * ck, 0.046, 0.058]),
    Cn([0, -0.03, 0.034], [0, -0.07 - 0.008 * (q.chin - 1), 0.05], 0.05 * w * jaw, 0.022 * (0.9 + 0.1 * q.chin)),
    E([0, -0.078 - 0.012 * (q.chin - 1), 0.055], [0.02 * (0.6 + 0.4 * q.chin) * jaw, 0.016, 0.019]),
    // a little forward round the mouth
    E([0, -0.046, 0.058], [0.03 * q.mouth, 0.02, 0.023]),
  ];
  if (q.jaw > 0.6) faceParts.push(...both((sx) => Cn([sx * 0.05 * w, -0.036, -0.012], [sx * 0.026 * w, -0.077, 0.038], 0.015 * q.jaw, 0.013 * q.jaw)));
  const face = S.union(0.032, ...faceParts);
  // a soft ridge for the brows to lie on
  const ridge = S.union(0.014, ...both((sx) => Cn([0, 0.028, 0.088], [sx * 0.048, 0.03, 0.073], 0.0055, 0.0045)));
  let head = S.union(0.016, skull, face, ridge);

  // the eyes: balls in sockets cut into the face; the lids line each socket,
  // thick above and slim below, open in an almond (in angles from the eye's
  // middle: th across, ph up), so they lie flush with the face round them
  const eyeR = 0.0196 * q.eye, GAP = 0.0006, LTU = 0.0042, LTL = 0.0022;
  const ex = 0.0328 * q.gap * w, ey = 0.002;
  const front = (x, yy, s) => { let z = 0.16; while (z > 0 && s.f(...P(x, yy, z)) > 0) z -= 0.0002; return z; };
  const ez = front(ex, ey, head) - (eyeR + GAP + LTU) * 0.9;
  const eyeC = [[ex, ey, ez], [-ex, ey, ez]];
  const Wd = 1.0, U = 0.46 * q.open, L = 0.44 * q.open;
  const angular = (i) => (x, yy, z) => {
    const c = eyeC[i], sx = i ? -1 : 1;
    const dx = (x - c[0]) * sx, dy = yy - c[1], dz = z - c[2];
    const r = sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
    const th = atan2(dx, dz), ph = Math.asin(dy / r) - q.tilt * th;
    const t = Math.min(1, abs(th) / Wd);
      const up = U * (1 - t * t) ** 0.6 + 0.02, lo = -L * (1 - t * t) ** 0.9 + 0.02;
    // the corners rounded
    return { r, th, ph, up, lo, out: smax(smax(ph - up, lo - ph, 0.06), abs(th) - Wd, 0.08) };
  };
  const eyeAng = [angular(0), angular(1)];
  const lidT = (ph) => LTL + (LTU - LTL) * smooth(-0.25, 0.25, ph);
  const lidR = eyeR + GAP + LTU;
  const sockets = eyeC.map((c, i) => S.fn((X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const a = eyeAng[i](x, yy, z);
    return (a.r - (eyeR + GAP + lidT(a.ph))) * hs;
  }, [...P(...c), (lidR + 0.002) * hs]));
  const lids = eyeC.map((c, i) => S.fn((X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const a = eyeAng[i](x, yy, z);
    const LT = lidT(a.ph);
    const shell = abs(a.r - (eyeR + GAP + LT / 2)) - LT / 2;
    return smax(shell, -a.out * a.r, 0.0026) * hs;
  }, [...P(...c), (lidR + 0.004) * hs]));

  const nz = q.nose, nk = sqrt(nz);
  const nose = S.union(0.006,
    Cn([0, 0.012, 0.09], [0, -0.012, 0.094 + 0.009 * nz], 0.0046 * nk, 0.0066 * nk),
    Sp([0, -0.0145, 0.093 + 0.009 * nz], 0.0082 * nk),
    ...both((sx) => Sp([sx * 0.0086 * nk, -0.0195, 0.089 + 0.004 * nz], 0.0054 * nk)));
  const mw = 0.0175 * q.mouth * (woman ? 0.95 : 1), my = -0.041;
  const ear = (sx) => S.cut(0.004,
    E([sx * 0.0765 * w, 0.0, -0.01], [0.009, 0.029, 0.018], S.euler(0.15, sx * 0.35, 0)),
    E([sx * 0.0838 * w, -0.003, -0.008], [0.0042, 0.0115, 0.0078], S.euler(0.15, sx * 0.35, 0)));
  const ears = both(ear);
  const neck = S.cone(P(0, -0.04, -0.026), [o[0], J.neck[1] - 0.025, J.neck[2]], p.neck, p.neck * 1.06);

  head = S.cut(0.004, head, ...sockets);
  head = S.union(0.003, head, ...lids);
  head = S.union(0.006, head, nose);
  head = S.union(0.004, head, ...ears);
  head = S.union(0.03, head, neck);
  // where the face's surface is, straight ahead of (x, y)
  const onFace = (x, yy) => front(x, yy, head);

  // the vertex colour is a factor on the skin's colour (the material's):
  // warmer where the skin is thin, the cheeks, the nose, the ears
  const skin = [1, 1, 1];
  const color = (l, X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    let c = skin;
    const warm = Math.exp(-(((abs(x) - 0.04) / 0.024) ** 2 + ((yy + 0.022) / 0.022) ** 2)) * (z > 0.03 ? 1 : 0)
      + Math.exp(-((x / 0.012) ** 2 + ((yy + 0.012) / 0.014) ** 2)) * (z > 0.08 ? 0.6 : 0)
      + (abs(x) > 0.07 ? 0.5 : 0);
    c = mix(c, [c[0] * 1.03, c[1] * 0.86, c[2] * 0.8], 0.22 * min(1, warm));
    // a little darker under the jaw and down the neck
    c = mix(c, [c[0] * 0.82, c[1] * 0.74, c[2] * 0.72], 0.5 * smooth(-0.07, -0.12, yy) * smooth(0.06, -0.02, z));
    return c;
  };
  const bt = 0.75 + 0.25 * q.brow, arch = q.arch;
  const features = {
    o, hs,
    eye: [ex, ey, ez], eyeR, lidR,
    lid: [Wd, U, L, q.tilt],
    // the brows: five points (x, y, half width) on a curve from the nose out
    // the head of the brow as high as its tail, so it reads calm, not cross
    brow: browCurve([0.011, 0.029], [0.034, 0.037 + 0.004 * arch], [0.053, 0.03 + 0.002 * arch], [0.0021 * bt, 0.0018 * bt, 0.0006 * bt]),
    mouth: [my, mw, q.smile, woman ? 0.0006 : 0.00042],
    lips: [0.0038 * q.lips, 0.0055 * q.lips],
    cheek: [0.04 * w, -0.022, 0.021],
    amounts: [q.tint, q.blush, q.lash, q.beard],
    woman,
  };
  const lo = [o[0] - 0.105 * hs, J.neck[1] - 0.04, o[2] - 0.125 * hs], hi = [o[0] + 0.105 * hs, o[1] + 0.15 * hs, o[2] + 0.13 * hs];
  return { shape: head, skull, ears, layers: [{ name: 'skin', shape: head }], color, lo, hi, eyes: eyeC.map((c) => P(...c)), eyeR: eyeR * hs, features, onFace, P };
}

// a quadratic curve from a through b's pull to c, as five points with
// their half widths (wa at a, wb in the middle, wc at c)
function browCurve(a, b, c, [wa, wb, wc]) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4, u = 1 - t;
    const x = u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], y = u * u * a[1] + 2 * u * t * b[1] + t * t * c[1];
    const w = t < 0.5 ? wa + (wb - wa) * smooth(0, 0.5, t) : wb + (wc - wb) * smooth(0.5, 1, t);
    pts.push([x, y, w]);
  }
  return pts;
}

// --- hair -----------------------------------------------------------------
// A shell over the skull, from a little inside it out to the hair's
// surface, ending at the hairline in a clean edge. A style gives the
// hairline (its height by the angle round the head, 0 in front), the
// thickness, the clumps' grooves, the strands' way (for the highlight in
// players3d.js) and any tail, bun or quiff.
const LINES = {
  short: [[0, 0.087], [0.42, 0.083], [0.62, 0.071], [0.88, 0.062], [1.04, 0.016], [1.2, 0.006], [1.33, 0.037], [1.72, 0.035], [2.02, -0.014], [2.5, -0.044], [3.2, -0.057]],
  buzz: [[0, 0.093], [0.4, 0.088], [0.66, 0.072], [0.9, 0.06], [1.05, 0.02], [1.2, 0.01], [1.33, 0.036], [1.72, 0.034], [2.02, -0.01], [2.5, -0.04], [3.2, -0.052]],
  pony: [[0, 0.09], [0.5, 0.079], [0.95, 0.05], [1.22, 0.032], [1.48, 0.046], [1.85, 0.0], [2.3, -0.045], [3.2, -0.07]],
};
LINES.quiff = LINES.short;
LINES.bun = LINES.pony;

function hairParts(p, J, H) {
  const hs = p.headSize, o = J.headO, style = p.hair, skull = H.skull;
  const P = H.P;
  const E = (c, r, m) => S.ellipsoid(P(...c), r.map((v) => v * hs), m);
  const rel = (X, Y, Z) => [(X - o[0]) / hs, (Y - o[1]) / hs, (Z - o[2]) / hs];
  const line = LINES[style] || LINES.short;
  const lineAt = (a) => {
    for (let i = 1; i < line.length; i++) if (a <= line[i][0]) {
      const [a0, h0] = line[i - 1], [a1, h1] = line[i];
      return h0 + (h1 - h0) * smooth(0, 1, (a - a0) / (a1 - a0));
    }
    return line[line.length - 1][1];
  };
  const above = (x, yy, z) => yy - lineAt(abs(atan2(x, z)));
  const pony = style === 'pony', bun = style === 'bun', back = pony || bun;
  const partX = 0.032;
  const tie = [0, 0.077, -0.104];
  const valley = (ph) => (0.5 + 0.5 * cos(ph)) ** 6;
  // the hair grows out of the hairline: thin there, full a few centimetres in
  const ramp = (x, yy, z) => smooth(0, 0.026, above(x, yy, z));
  let thick, groove, flow;
  if (back) {
    // pulled back smooth to the tie, in a few broad clumps
    thick = (x, yy, z) => 0.0028 + ramp(x, yy, z) * (0.0018 + 0.0014 * smooth(0.0, 0.1, yy) + 0.002 * smooth(0.05, 0.12, yy) * smooth(0.02, -0.08, z));
    const ax0 = [0, 0.03, 0];
    groove = (x, yy, z) => {
      const ax = S.norm(S.sub(tie, ax0)), v = S.sub([x, yy, z], ax0);
      const u = S.sub(v, S.scale(ax, S.dot(v, ax)));
      return valley(atan2(u[0], S.dot(u, S.norm(S.cross(ax, [1, 0, 0])))) * 15 + sin(S.dot(v, ax) * 40) * 0.5) * ramp(x, yy, z);
    };
    flow = (x, yy, z) => S.norm(S.sub(tie, [x, yy, z]));
  } else if (style === 'buzz') {
    thick = (x, yy, z) => 0.0022 + 0.0008 * ramp(x, yy, z);
    groove = () => 0;
    flow = () => S.norm([0, -0.6, -1]);
  } else {
    // short, parted on the left: full on top and towards the front, a lift
    // behind the front on the right of the parting, close at the sides; the
    // clumps run back, bending to the right
    const k = style === 'quiff' ? 1.6 : 1;
    thick = (x, yy, z) => {
      const top = smooth(0.03, 0.105, yy), fwd = 0.45 + 0.55 * smooth(-0.08, 0.05, z);
      const lift = Math.exp(-(((x + 0.012) / 0.042) ** 2 + ((z - 0.045) / 0.036) ** 2)) * smooth(0.06, 0.1, yy);
      return 0.0028 + ramp(x, yy, z) * (0.0092 * top * fwd + 0.0045 * k * lift);
    };
    groove = (x, yy, z) => {
      const lines = valley((x + 0.28 * z) * 190 + 0.8 * sin(z * 30)) * smooth(0.04, 0.09, yy);
      const part = Math.exp(-(((x - partX) / 0.0035) ** 2)) * smooth(0.07, 0.11, yy) * smooth(-0.04, 0.0, z) * 1.2;
      return Math.min(1.3, lines + part) * ramp(x, yy, z);
    };
    flow = (x, yy, z) => {
      const top = smooth(0.02, 0.07, yy);
      const t = x < partX ? [-0.3, 0.0, -0.95] : [0.45, -0.3, -0.8];
      return S.norm(S.lerp([0, -1, -0.35], t, top));
    };
  }
  const DEPTH = 0.0015;
  const shellOf = (X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const sk = skull.f(X, Y, Z) / hs;
    const t = thick(x, yy, z) - DEPTH * groove(x, yy, z);
    let d = max(sk - t, -(sk + 0.006));
    d = smax(d, -above(x, yy, z) - 0.0005, 0.0045);
    return d * hs;
  };
  let shape = S.fn(shellOf, [o[0], o[1] + 0.03 * hs, o[2], 0.15 * hs]);
  shape = S.cut(0.004, shape, ...H.ears.map((e) => S.grow(e, 0.0035)));
  let extra = null, tailFlow = null;
  if (pony) {
    const pts = [[0, 0.077, -0.1], [0, 0.07, -0.138], [0, 0.026, -0.163], [0, -0.044, -0.162], [0, -0.115, -0.143], [0.004, -0.19, -0.118]];
    const rad = [0.014, 0.023, 0.026, 0.023, 0.016, 0.0055];
    const tail = S.chain(pts.map((v) => P(...v)), rad.map((v) => v * hs), 0.012);
    extra = S.fn((X, Y, Z) => {
      const [x, yy, z] = rel(X, Y, Z);
      return tail.f(X, Y, Z) + 0.0018 * hs * valley(atan2(x, z + 0.15) * 11 + yy * 18);
    }, tail.b);
    tailFlow = (x, yy, z) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) { const d = S.len(S.sub(S.lerp(pts[i], pts[i + 1], 0.5), [x, yy, z])); if (d < bd) { bd = d; best = i; } }
      return S.norm(S.sub(pts[best + 1], pts[best]));
    };
    shape = S.union(0.01, shape, extra);
    shape = S.union(0.0015, shape, S.torus(P(0, 0.073, -0.108), 0.0142 * hs, 0.0045 * hs, S.axes([0, 0.55, -0.83])));
  }
  if (bun) {
    const c = [0, 0.09, -0.112];
    const knot = S.sphere(P(...c), 0.031 * hs);
    extra = S.fn((X, Y, Z) => {
      const [x, yy, z] = rel(X, Y, Z);
      const v = S.sub([x, yy, z], c);
      return knot.f(X, Y, Z) + 0.0016 * hs * valley(atan2(v[0], v[1]) * 3 + S.len(v) * 260);
    }, knot.b);
    tailFlow = (x, yy, z) => { const v = S.sub([x, yy, z], c); return S.norm(S.cross(v, [0, 0.4, -1])); };
    shape = S.union(0.012, shape, extra);
  }
  const C = [1, 1, 1]; // a factor on the hair's colour (the material's): darker in the grooves
  const color = (l, X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const g = extra && extra.f(X, Y, Z) < 0.002 * hs ? 0.3 : groove(x, yy, z);
    return mix(C, C.map((v) => v * 0.5), 0.6 * g);
  };
  const flowAt = (X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    if (extra && tailFlow && extra.f(X, Y, Z) < 0.003 * hs) return tailFlow(x, yy, z);
    return flow(x, yy, z);
  };
  const lo = P(-0.105, -0.075, -0.13), hi = P(0.105, 0.165, 0.13);
  if (pony) { lo[1] = o[1] - 0.215 * hs; lo[2] = o[2] - 0.2 * hs; }
  if (bun) lo[2] = o[2] - 0.16 * hs;
  return { shape, layers: [{ name: 'hair', shape }], color, flow: flowAt, lo, hi };
}

// --- hands --------------------------------------------------------------
// A hand in its own frame: the wrist at the origin, the fingers along +y,
// the thumb's side +x, the back of the hand +z (a left hand). The pose is
// each joint's bend in radians (towards the palm) and the fingers' spread.
export const HAND_POSES = {
  relaxed: { f: [[0.32, 0.55, 0.3], [0.38, 0.62, 0.32], [0.45, 0.68, 0.34], [0.52, 0.72, 0.36]], spread: -0.02, thumb: { yaw: 0.72, pitch: 0.45, bend: [0.18, 0.22] } },
  bridge: { f: [[0.18, 0.2, 0.1], [0.2, 0.22, 0.12], [0.22, 0.25, 0.12], [0.25, 0.28, 0.14]], spread: 0.16, thumb: { yaw: 0.62, pitch: -0.62, bend: [0.12, 0.18] }, arch: 0.12 },
  grip: { f: [[1.0, 1.25, 0.55], [1.1, 1.3, 0.6], [1.2, 1.35, 0.6], [1.3, 1.35, 0.6]], spread: 0.02, thumb: { yaw: 0.85, pitch: 0.75, bend: [0.35, 0.45] } },
};
const FINGERS = [
  { base: [0.028, 0.092, 0.0], len: [0.043, 0.025, 0.02], r: [0.0094, 0.0084, 0.0077, 0.007], splay: 0.07 },
  { base: [0.0085, 0.097, 0.0005], len: [0.047, 0.028, 0.021], r: [0.0098, 0.0088, 0.008, 0.0072], splay: 0.0 },
  { base: [-0.0105, 0.094, 0.0], len: [0.044, 0.027, 0.021], r: [0.0092, 0.0083, 0.0076, 0.0069], splay: -0.07 },
  { base: [-0.027, 0.087, -0.001], len: [0.035, 0.021, 0.018], r: [0.0083, 0.0074, 0.0068, 0.0062], splay: -0.16 },
];
export function handShape(p, poseName) {
  const pose = HAND_POSES[poseName], k = p.hand;
  const K = (v) => S.scale(v, k);
  const parts = [];
  const arch = pose.arch || 0;
  parts.push(S.box(K([0.0, 0.048, 0.0]), K([0.04, 0.046, 0.0145]), S.euler(-arch * 0.5, 0, 0), 0.012 * k));
  parts.push(S.ellipsoid(K([0.02, 0.03, -0.009]), K([0.02, 0.028, 0.012]), S.euler(0, 0, -0.3)));
  parts.push(S.ellipsoid(K([-0.024, 0.04, -0.006]), K([0.015, 0.038, 0.011])));
  // the wrist: wider than it is thick
  parts.push(S.ellipsoid(K([0, -0.006, 0.0]), K([0.028, 0.026, 0.018])));
  parts.push(S.ellipsoid(K([0, -0.034, 0.0]), K([0.026, 0.022, 0.019])));
  const tips = [];
  FINGERS.forEach((fg, i) => {
    const bend = pose.f[i];
    const spread = fg.splay * (1 + pose.spread * 6) + (i - 1.5) * pose.spread * 0.12;
    let dir = S.rotate([0, 1, 0], [0, 0, 1], -spread);
    const side = S.norm(S.cross(dir, [0, 0, 1]));
    let at = S.add(K(fg.base), [0, 0, -arch * 0.04 * k]);
    dir = S.rotate(dir, side, -arch);
    const pts = [at];
    for (let j = 0; j < 3; j++) {
      dir = S.rotate(dir, side, -bend[j]);
      at = S.add(at, S.scale(dir, fg.len[j] * k));
      pts.push(at);
    }
    parts.push(S.chain(pts, fg.r.map((v) => v * k * 1.08), 0.004));
    tips.push({ at, dir, r: fg.r[3] * k });
  });
  const th = pose.thumb;
  let dir = S.norm([cos(th.yaw), sin(th.yaw), 0]);
  dir = S.norm(S.rotate(dir, [0, 1, 0], th.pitch)); // > 0: across the palm; < 0: up off its back
  let at = K([0.02, 0.02, -0.006]);
  const tpts = [at];
  const tlen = [0.044, 0.032, 0.026], trad = [0.0125, 0.0102, 0.0092, 0.0083];
  const axis = S.norm(S.cross(dir, [0, 0, 1]));
  for (let j = 0; j < 3; j++) {
    if (j > 0) dir = S.rotate(dir, axis, -th.bend[j - 1]);
    at = S.add(at, S.scale(dir, tlen[j] * k));
    tpts.push(at);
  }
  parts.push(S.chain(tpts, trad.map((v) => v * k), 0.006));
  tips.push({ at, dir, r: trad[3] * k });
  const shape = S.union(0.009 * k, ...parts);
  const skin = [1, 1, 1], nail = [1.18, 1.1, 1.06]; // factors on the skin's colour
  const color = (layer, X, Y, Z) => {
    for (const t of tips) {
      const dx = X - t.at[0], dy = Y - t.at[1], dz = Z - t.at[2];
      const along = dx * t.dir[0] + dy * t.dir[1] + dz * t.dir[2];
      if (along > -0.012 * k && along < 0.004 && dz > t.r * 0.25 && dx * dx + dy * dy + dz * dz < (0.013 * k) ** 2) return nail;
    }
    return skin;
  };
  // the bridge's groove: between the raised thumb and the first knuckle
  const groove = S.add(S.lerp(tpts[1], tpts[2], 0.6), [0, 0, 0]);
  const knuckle = S.add(K(FINGERS[0].base), [0, 0, 0.009 * k]);
  const g = S.lerp(groove, knuckle, 0.45);
  return { shape, layers: [{ name: 'skin', shape }], color, lo: K([-0.075, -0.035, -0.08]), hi: K([0.11, 0.2, 0.08]), h: 0.0017, groove: [g[0], g[1], g[2] + 0.008 * k] };
}
// where a hand holds things, in its frame: the cue lies along `along`
// through `at` when the hand grips; the bridge's groove for the cue.
export const GRIP = { at: [0.0, 0.089, -0.035], along: S.norm([1, 0.08, 0]) };
export const BRIDGE = { groove: [0.036, 0.098, 0.036], palm: -0.024 };

// --- shoes, cuffs, collar, buttons -----------------------------------
function shoeShape(p, J) {
  const a = J.ankleL, s = p.height / 1.78, woman = p.body === 'woman', w = woman ? 0.9 : 1;
  const heel = woman ? 0.034 : 0.025, out = S.euler(0, 0.1, 0);
  const at = (x, yy, z) => [a[0] + x * w + z * 0.1, yy, a[2] + z];
  const upper = S.union(0.022,
    S.ellipsoid(at(0.004, 0.036, 0.122 * s), [0.043 * w, 0.028, 0.07 * s], out),
    S.ellipsoid(at(0.0, 0.062, 0.045 * s), [0.042 * w, 0.042, 0.08 * s], out),
    S.ellipsoid(at(-0.002, 0.06, -0.05 * s), [0.037 * w, 0.048, 0.05 * s], out));
  // the sole follows the upper's outline, a little proud of it
  const outline = S.fn((X, Y, Z) => upper.f(X, 0.03, Z), upper.b);
  const sole = S.meet(0.002, S.grow(outline, 0.0025), S.half([0, 1, 0], 0.013), S.half([0, -1, 0], 0));
  const heelBlock = S.meet(0.002, S.grow(outline, 0.0012), S.half([0, 1, 0], heel), S.half([0, -1, 0], 0), S.half([0, 0, 1], a[2] - 0.022));
  const shoe = S.cut(0.006, S.union(0.004, upper, sole, heelBlock), S.cone([a[0], 0.085 * s + 0.012, a[2] - 0.012], [a[0], 0.3, a[2] - 0.02], 0.035 * w, 0.04));
  const C = hex(p.shoe), Cs = hex(p.sole);
  return { shape: shoe, layers: [{ name: 'leather', shape: shoe }], color: (l, X, Y, Z) => (Y < 0.0135 || (Y < heel + 0.0005 && Z < a[2] - 0.022) ? Cs : C), lo: [a[0] - 0.07, -0.01, a[2] - 0.12], hi: [a[0] + 0.08, 0.13, a[2] + 0.23] };
}
function cuffShape(p, J) {
  const el = J.elbowL, wr = J.wristL, d = S.norm(S.sub(wr, el));
  const r = p.arm[2];
  const shape = S.tube(S.sub(wr, S.scale(d, 0.07)), S.sub(wr, S.scale(d, 0.006)), r - 0.0012, r + 0.0045, 0.0014);
  return { shape, layers: [{ name: 'shirt', shape }], color: () => hex(p.shirt), lo: S.sub(wr, [0.09, 0.09, 0.09]), hi: S.add(wr, [0.09, 0.09, 0.09]) };
}
function collarShape(p, J) {
  const s = p.height / 1.78, c = [0, J.neck[1] + 0.012 * s, -0.024], ax = S.norm([0, 1, -0.32]);
  const R = p.neck + 0.0068, h = 0.026 * s;
  // a band a little wider at its foot, so it sits on the shoulders
  const band = S.fn((X, Y, Z) => {
    const v = S.sub([X, Y, Z], c), a = S.dot(v, ax);
    const rr = S.len(S.sub(v, S.scale(ax, a))), Rr = R + 0.004 * smooth(h / 2, -h / 2, a);
    const q0 = abs(rr - Rr) - 0.0016, q1 = abs(a) - h / 2 + 0.0012;
    return sqrt(max(q0, 0) ** 2 + max(q1, 0) ** 2) + min(max(q0, q1), 0) - 0.0012;
  }, [c[0], c[1], c[2], R + 0.03]);
  const front = [0, c[1] - 0.3 * R * 0.96 - 0.004, c[2] + R * 0.96];
  const wings = [1, -1].map((sx) => S.ellipsoid([sx * 0.019, front[1] - 0.011, front[2] + 0.002], [0.02, 0.012, 0.0032], S.euler(-0.32, sx * 0.4, sx * 0.55)));
  const collar = S.union(0.004, band, ...wings);
  const parts = [{ name: 'shirt', shape: collar }];
  if (p.tie) {
    const k = p.body === 'woman' ? 0.88 : 1.05, tz = front[2] + 0.008, ty = front[1] - 0.009;
    const slab = S.box([0, ty, tz], [0.07, 0.05, 0.0068], null, 0.002);
    const lobes = S.meet(0.002, S.union(0.004,
      S.cone([0.004, ty, tz], [0.037 * k, ty + 0.001, tz - 0.003], 0.006, 0.017 * k),
      S.cone([-0.004, ty, tz], [-0.037 * k, ty + 0.001, tz - 0.003], 0.006, 0.017 * k)), slab);
    parts.push({ name: 'satin', shape: S.union(0.003, lobes, S.box([0, ty, tz + 0.0015], [0.0076, 0.0095, 0.0076], null, 0.004)) });
  }
  const shape = S.union(0, ...parts.map((x) => x.shape));
  const C = { shirt: hex(p.shirt), satin: hex(p.satin) };
  return { shape, layers: parts, color: (l) => C[l], lo: [-0.1, c[1] - 0.075, c[2] - 0.1], hi: [0.1, c[1] + 0.05, c[2] + 0.115] };
}

export function build(p) {
  const J = joints(p);
  const body = bodyParts(p, J);
  // the buttons: on the waistcoat's front, from the V down
  const s = p.height / 1.78, buttons = [];
  for (let i = 0; i < 5; i++) {
    const yy = body.vBottom - 0.016 * s - i * 0.05 * s;
    let z = 0.25;
    while (z > 0 && body.shape.f(0, yy, z) > 0) z -= 0.0005;
    buttons.push([0, yy, z + 0.0008]);
  }
  const head = headParts(p, J);
  return {
    p, J,
    body: { ...body, h: 0.0052 },
    head: { ...head, h: 0.0018 },
    hair: { ...hairParts(p, J, head), h: 0.0017 },
    shoe: { ...shoeShape(p, J), h: 0.0032 },
    cuff: { ...cuffShape(p, J), h: 0.002 },
    collar: { ...collarShape(p, J), h: 0.0016 },
    hands: Object.fromEntries(Object.keys(HAND_POSES).map((k) => [k, handShape(p, k)])),
    buttons,
  };
}

// colour every vertex of a mesh: which layer it lies on, its paint, the
// masks its shader reads and the hair's way
export function paint(part, m) {
  const n = m.pos.length / 3, col = new Float32Array(n * 3), layer = new Uint8Array(n);
  const mask = part.mask ? new Float32Array(n * 3) : null;
  const flow = part.flow ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
    let best = 0, bd = Infinity;
    part.layers.forEach((l, j) => { const d = l.shape.f(x, y, z); if (d < bd - 1e-5) { bd = d; best = j; } });
    layer[i] = best;
    const c = part.color(part.layers[best].name, x, y, z);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    if (mask) { const v = part.mask(x, y, z); mask[i * 3] = v[0]; mask[i * 3 + 1] = v[1]; mask[i * 3 + 2] = v[2]; }
    if (flow) { const v = part.flow(x, y, z); flow[i * 3] = v[0]; flow[i * 3 + 1] = v[1]; flow[i * 3 + 2] = v[2]; }
  }
  return { ...m, col, layer, mask, flow };
}

// --- meshes ---------------------------------------------------------------
// meshLook turns a look into the arrays of its meshes, each part at coarse
// times its own step (2.2 is the game's weight: about 160k triangles), the
// head and hair at headCoarse (finer where the face is seen close). Only
// the look's shape counts (its body, measures, face and hair): the colours
// are the materials' (players3d.js), so one mesh serves any colouring and
// either seat (lookKey). Skinned parts carry their bones and weights; the
// rigid ones say which bone they ride on and where it was in the bind pose.
export function meshLook(p, coarse = 1, headCoarse = coarse) {
  const B = build(p), J = B.J;
  const part = (q, k = coarse) => paint(q, S.mesh(q.shape, q.lo, q.hi, q.h * k));
  const names = BONES.map((b) => b[0]);
  const segs = boneSegments(J);
  const parts = {};
  const bm = part(B.body);
  parts.body = pack(bm, [0, 0], 'raw', skinWeights(bm, segs.filter((s) => s.bone !== 'head'), names));
  const hm = part(B.head, headCoarse);
  const headSegs = segs.filter((s) => ['chest', 'neck', 'head'].includes(s.bone));
  parts.head = pack(hm, [0], 'factor', skinWeights(hm, headSegs, names));
  parts.hair = { ...pack(part(B.hair, headCoarse), [0], 'factor'), bone: 'head', at: J.head };
  const shoe = part(B.shoe);
  parts.shoeL = { ...pack(shoe, [0], 'srgb'), bone: 'foot.L', at: J.ankleL };
  parts.shoeR = { ...pack(S.mirrorX(shoe), [0], 'srgb'), bone: 'foot.R', at: J.ankleR };
  const cuff = part(B.cuff);
  parts.cuffL = { ...pack(cuff, [0], 'srgb'), bone: 'fore.L', at: J.elbowL };
  parts.cuffR = { ...pack(S.mirrorX(cuff), [0], 'srgb'), bone: 'fore.R', at: J.elbowR };
  parts.collar = { ...pack(part(B.collar), B.collar.layers.map((l) => (l.name === 'satin' ? 1 : 0)), 'srgb'), bone: 'neck', at: J.neck };
  const hands = { L: {}, R: {} };
  for (const [pose, q] of Object.entries(B.hands)) {
    const m = part(q);
    hands.L[pose] = { ...pack(toBind(m, 'L', J), [0], 'factor'), bone: 'hand.L', at: J.wristL };
    hands.R[pose] = { ...pack(toBind({ ...m, pos: mirrorCanon(m.pos), nrm: mirrorCanon(m.nrm) }, 'R', J), [0], 'factor'), bone: 'hand.R', at: J.wristR };
  }
  return {
    J, parts, hands, buttons: B.buttons, vest: B.body.vest,
    eyes: B.head.eyes, eyeR: B.head.eyeR, features: B.head.features, groove: B.hands.bridge.groove,
  };
}
// lookKey names a look's meshes: two looks with one key share them. The
// beard and the face's paint (the lips' tint, the blush, the lashes) are
// the face's shader's, not the mesh's.
export function lookKey(p, coarse, headCoarse = coarse) {
  const { beard, tint, blush, lash, ...shape } = p.face;
  return JSON.stringify([p.body, p.height, p.headSize, p.hair, shape, coarse, headCoarse]);
}
// transfers lists the buffers of meshLook's arrays, to hand them from the
// worker to the page without a copy.
export function transfers(data) {
  const out = new Set();
  const add = (d) => { for (const k of ['pos', 'nrm', 'col', 'idx', 'mask', 'flow', 'skinIndex', 'skinWeight']) if (d[k]) out.add(d[k].buffer); };
  for (const d of Object.values(data.parts)) add(d);
  for (const side of Object.values(data.hands)) for (const d of Object.values(side)) add(d);
  return [...out];
}

// boneSegments: each bone pulls the skin near the line from its joint to
// the next, falling off past its radius (skinWeights)
function boneSegments(J) {
  const up = (j, dy) => S.add(J[j], [0, dy, 0]);
  const segs = [
    { bone: 'pelvis', a: [0, J.hipL[1] - 0.06, 0], b: J.spine1, r: 0.15, sigma: 0.025 },
    { bone: 'spine1', a: J.spine1, b: J.spine2, r: 0.13, sigma: 0.025 },
    { bone: 'spine2', a: J.spine2, b: J.chest, r: 0.14, sigma: 0.025 },
    { bone: 'chest', a: J.chest, b: S.lerp(J.chest, J.neck, 0.8), r: 0.15, sigma: 0.025 },
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
  return segs;
}
// skinWeights: the four bones that pull a vertex most, by the index of
// names, and how much each does
function skinWeights(m, segs, names) {
  const n = m.pos.length / 3, index = new Uint16Array(n * 4), weight = new Float32Array(n * 4);
  const w = new Float64Array(segs.length), order = [...w.keys()];
  for (let i = 0; i < n; i++) {
    const p = [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
    for (let s = 0; s < segs.length; s++) {
      const { a, b, r, sigma } = segs[s];
      const ab = S.sub(b, a), t = Math.max(0, Math.min(1, S.dot(S.sub(p, a), ab) / S.dot(ab, ab)));
      const d = S.len(S.sub(p, S.add(a, S.scale(ab, t))));
      w[s] = Math.exp(-Math.max(0, d - r) / sigma);
    }
    order.sort((x, y) => w[y] - w[x]);
    const k = Math.min(4, order.length); // the slots left over weigh nothing
    let sum = 0;
    for (let j = 0; j < k; j++) sum += w[order[j]];
    for (let j = 0; j < k; j++) { index[i * 4 + j] = names.indexOf(segs[order[j]].bone); weight[i * 4 + j] = w[order[j]] / sum; }
  }
  return { index, weight };
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// pack readies a painted mesh for a geometry: its colours in linear light
// ('srgb' a colour, 'factor' a factor on the material's colour, 'raw' as
// they are), its triangles sorted by material class (classOf: a layer's),
// one group a class.
function pack(m, classOf, kind, weights) {
  const col = new Float32Array(m.col.length);
  for (let i = 0; i < col.length; i++) col[i] = kind === 'srgb' ? srgbToLinear(m.col[i]) : kind === 'factor' ? m.col[i] ** 2.2 : m.col[i];
  const tris = m.idx.length / 3, by = Array.from({ length: Math.max(...classOf) + 1 }, () => []);
  for (let t = 0; t < tris; t++) {
    const a = m.idx[t * 3], b = m.idx[t * 3 + 1], c = m.idx[t * 3 + 2];
    const la = m.layer[a], lb = m.layer[b], lc = m.layer[c];
    const l = la === lb || la === lc ? la : lb === lc ? lb : la;
    by[classOf[l]].push(a, b, c);
  }
  const idx = new Uint32Array(m.idx.length), groups = [];
  let at = 0;
  by.forEach((list, ci) => { idx.set(list, at); if (list.length) groups.push([at, list.length, ci]); at += list.length; });
  const out = { pos: m.pos, nrm: m.nrm, col, idx, groups };
  if (m.mask) out.mask = m.mask;
  if (m.flow) out.flow = m.flow;
  if (weights) { out.skinIndex = weights.index; out.skinWeight = weights.weight; }
  return out;
}
// handFrame: a hand's own frame in the bind pose, its fingers along d, its
// thumb's side t, the back of the hand n, the wrist at w
export function handFrame(J, side) {
  const sx = side === 'L' ? 1 : -1;
  const d = [J.armDir[0] * sx, J.armDir[1], J.armDir[2]];
  const t = [0, 0, 1];
  const n = side === 'L' ? S.cross(t, d) : S.scale(S.cross(t, d), -1);
  return { d, t, n, w: J['wrist' + side] };
}
// toBind turns a hand built in its own frame to the bind pose's
function toBind(m, side, J) {
  const F = handFrame(J, side), pos = new Float32Array(m.pos.length), nrm = new Float32Array(m.nrm.length);
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
}
// the canonical hand is a left one; a right one mirrors its x in that frame
function mirrorCanon(a) { const b = a.slice(); for (let i = 0; i < b.length; i += 3) b[i] = -b[i]; return b; }
