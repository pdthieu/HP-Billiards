// body.js: the two players as solids (sdf.js), in their bind pose: standing,
// arms 45° down (an A), on the floor at y = 0, facing +z, their left at +x.
// No Three.js here: build() returns the joints, the bones and each part's
// solid, box, step and colouring; rig.js makes them meshes and poses them.
import * as S from './sdf.js';

const { abs, max, min, sqrt, sin, cos, PI, atan2 } = Math;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// The two looks. Lengths in metres; widths are half widths.
export const MAN = {
  id: 'man', height: 1.78,
  shoulder: 0.183, hip: 0.088,
  pelvis: [0.164, 0.108], waist: [0.149, 0.098], ribs: [0.158, 0.104], chest: [0.166, 0.104],
  bust: 0, pecs: 1, neck: 0.058,
  arm: [0.05, 0.042, 0.036], leg: [0.09, 0.066, 0.058], hand: 1,
  head: { size: 1.06, jaw: 1, brow: 1, chin: 1, lips: 1, eye: 1, nose: 1, cheek: 1, open: 0.31, tilt: 0.05 },
  hair: 'short', tie: true,
  skin: '#d9a681', hairColor: '#17120f', browColor: '#1c1410', lip: '#b97a66', iris: '#3b2414',
  shirt: '#f0eee9', vest: '#a17a33', vestBack: '#4e3b1a', trousers: '#1c1f24', satin: '#101114', shoe: '#0d0d0f', sole: '#24170f', button: '#2a231e',
};
export const WOMAN = {
  id: 'woman', height: 1.66,
  shoulder: 0.163, hip: 0.094,
  pelvis: [0.17, 0.11], waist: [0.124, 0.088], ribs: [0.138, 0.093], chest: [0.148, 0.095],
  bust: 1, pecs: 0, neck: 0.049,
  arm: [0.044, 0.036, 0.031], leg: [0.087, 0.06, 0.051], hand: 0.9,
  head: { size: 1.0, jaw: 0.6, brow: 0.4, chin: 0.78, lips: 1.06, eye: 1.1, nose: 0.78, cheek: 1.02, open: 0.36, tilt: 0.14 },
  hair: 'pony', tie: true,
  skin: '#e7c2a2', hairColor: '#15100d', browColor: '#2a1c15', lip: '#b9545c', iris: '#3b2414',
  shirt: '#f0eee9', vest: '#2b55b0', vestBack: '#13254d', trousers: '#1c1f24', satin: '#101114', shoe: '#0d0d0f', sole: '#24170f', button: '#1c1d22',
};

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
  J.headO = [0, 1.62 * s, 0.004]; // the head's own origin, between the ears
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
    S.cone(neckBase, [p.shoulder * 0.9, y(1.384), -0.02], 0.041 * ws, 0.036 * ws),
    S.cone(neckBase, [-p.shoulder * 0.9, y(1.384), -0.02], 0.041 * ws, 0.036 * ws),
    S.sphere(S.add(J.shoulderL, [-0.006, -0.01, 0]), p.arm[0] * 0.93), S.sphere(S.add(J.shoulderR, [0.006, -0.01, 0]), p.arm[0] * 0.93),
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

  const sleeve = (side) => {
    const sh = J['shoulder' + side], el = J['elbow' + side], wr = J['wrist' + side];
    const end = S.sub(wr, S.scale(S.norm(S.sub(wr, el)), 0.03));
    return S.chain([sh, el, end], p.arm, 0.02);
  };
  const sleeves = S.union(0, sleeve('L'), sleeve('R'));
  const shirt = S.union(0.028, torsoVest, sleeves);

  const legPart = (side) => {
    const hp = J['hip' + side], kn = J['knee' + side], an = J['ankle' + side];
    return S.chain([hp, kn, [an[0], 0.03, an[2] + 0.012]], p.leg, 0.03);
  };
  const trousers = S.meet(0.004, S.union(0.04,
    S.ellipsoid([0, y(0.955), 0], [px + 0.003, y(0.107), pz + 0.003]),
    S.ellipsoid([0.066, y(0.905), -0.052], [0.084, y(0.088), 0.07]), S.ellipsoid([-0.066, y(0.905), -0.052], [0.084, y(0.088), 0.07]),
    legPart('L'), legPart('R')), S.half([0, 1, 0], y(1.04)), S.half([0, -1, 0], -0.036));

  const layers = [{ name: 'shirt', shape: shirt }, { name: 'trousers', shape: trousers }];
  const C = { vest: hex(p.vest), back: hex(p.vestBack) };
  const welt = (sx) => S.box([sx * 0.08, y(1.075), 0], [0.028, 0.0032, 0.3]);
  const welts = [welt(1), welt(-1)];
  // the vertex colour is the waistcoat's everywhere (its satin back, the
  // pockets, where its fronts meet); the shader decides from mask() what
  // shows: the waistcoat, the shirt or the trousers, with crisp edges
  const color = (layer, X, Y, Z) => {
    let c = mix(C.back, C.vest, smooth(-0.05, -0.02, Z));
    if (Z > 0 && welts.some((w) => w.f(X, Y, Z) < 0)) c = mix(c, [0, 0, 0], 0.4);
    if (Z > 0 && abs(X) < 0.0016 && Y < vBottom + 0.004) c = mix(c, [0, 0, 0], 0.35);
    return c;
  };
  const mask = (X, Y, Z) => {
    const t = torsoVest.f(X, Y, Z);
    return [region(X, Y, Z), trousers.f(X, Y, Z) - min(t, sleeves.f(X, Y, Z)), sleeves.f(X, Y, Z) - t];
  };
  const shape = S.union(0, shirt, trousers);
  const lo = [-(J.wristL[0] + 0.07), 0.02, -0.2], hi = [J.wristL[0] + 0.07, y(1.49), 0.2];
  return { shape, layers, color, mask, lo, hi, vBottom, torso: torsoVest, shirt: hex(p.shirt), trousers: hex(p.trousers) };
}

// --- head, face, hair ---------------------------------------------------
// The head's own frame: from between the ears, x to the left, y up, z ahead.
// The face in thirds: hairline 0.09, brow 0.034, the nose's base −0.027,
// the chin −0.093; the eyes on 0.0155, an eye's width apart.
function headParts(p, J) {
  const q = p.head, hs = q.size, o = J.headO, woman = p.id === 'woman';
  const P = (x, yy, z) => [o[0] + x * hs, o[1] + yy * hs, o[2] + z * hs];
  const E = (c, r, m) => S.ellipsoid(P(...c), r.map((v) => v * hs), m);
  const Sp = (c, r) => S.sphere(P(...c), r * hs);
  const Cn = (a, b, ra, rb) => S.cone(P(...a), P(...b), ra * hs, (rb ?? ra) * hs);
  const both = (fn) => [fn(1), fn(-1)];
  const rel = (X, Y, Z) => [(X - o[0]) / hs, (Y - o[1]) / hs, (Z - o[2]) / hs];

  const skull = S.union(0.03,
    E([0, 0.04, -0.01], [0.076, 0.097, 0.098]),
    E([0, 0.04, 0.035], [0.068, 0.062, 0.066]));
  const jw = q.jaw, ck = q.cheek;
  const face = S.union(0.022,
    E([0, -0.006, 0.047], [0.066 * ck, 0.042, 0.055]),
    ...both((sx) => E([sx * 0.034, -0.022, 0.064], [0.022 * ck, 0.02, 0.02])),
    Cn([0, -0.024, 0.036], [0, -0.074, 0.058], 0.057 * (0.86 + 0.14 * jw), 0.026 * (0.85 + 0.15 * jw)),
    ...both((sx) => Cn([sx * 0.058, -0.03, -0.01], [sx * 0.022 * (0.85 + 0.15 * jw), -0.083, 0.064], 0.017 * (0.8 + 0.2 * jw), 0.013)),
    E([0, -0.082 + 0.003 * (1 - q.chin), 0.074], [0.022 * q.chin, 0.017, 0.016]),
    E([0, -0.04, 0.071], [0.026 * (0.85 + 0.15 * jw), 0.02, 0.023]));
  const brow = S.union(0.012, ...both((sx) => Cn([0, 0.034, 0.094], [sx * 0.048, 0.037, 0.078], 0.004 + 0.0045 * q.brow, 0.004 + 0.0035 * q.brow)));
  const nz = q.nose;
  const nose = S.union(0.006,
    Cn([0, 0.021, 0.094], [0, -0.012, 0.092 + 0.02 * nz], 0.0062, 0.0084 * (0.92 + 0.08 * nz)),
    Sp([0, -0.016, 0.091 + 0.02 * nz], 0.0097 * (0.92 + 0.08 * nz)),
    ...both((sx) => Sp([sx * 0.0104 * (0.92 + 0.08 * nz), -0.0215, 0.1], 0.0071)));
  const lp = q.lips, mw = woman ? 0.0192 : 0.0208;
  const lipU = E([0, -0.0372, 0.0952], [mw, 0.0043 * lp, 0.0072]);
  const lipL = E([0, -0.0478, 0.0922], [mw * 0.88, 0.0053 * lp, 0.0076]);

  // eyes: the ball, a hollow round it, and lids (a shell over the ball with
  // an almond cut from it, measured in angles from the eye's middle)
  const eyeR = 0.0125 * q.eye;
  const eyeC = [[0.0296, 0.0165, 0.0728], [-0.0296, 0.0165, 0.0728]];
  const W = 0.8, U = q.open, L = q.open * 0.78, LID = eyeR + 0.0009;
  const angular = (i) => (x, yy, z) => {
    const c = eyeC[i], sx = i ? -1 : 1;
    const dx = (x - c[0]) * sx, dy = yy - c[1], dz = z - c[2];
    const r = sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
    const th = atan2(dx, dz), ph = Math.asin(dy / r) - q.tilt * th;
    const t = Math.min(1, abs(th) / W);
    const up = U * (1 - t * t) ** 0.5 + 0.03, lo = -L * (1 - t * t) ** 0.75 + 0.03;
    return { r, th, ph, up, lo, out: max(abs(th) - W, max(ph - up, lo - ph)) };
  };
  const eyeAng = [angular(0), angular(1)];
  const lids = eyeC.map((c, i) => S.fn((X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const a = eyeAng[i](x, yy, z);
    const shell = abs(a.r - (LID + 0.0006)) - 0.0016;
    const cutv = -a.out * a.r, k = 0.0008;
    const hh = max(k - abs(shell - cutv), 0) / k;
    return (max(shell, cutv) + hh * hh * k * 0.25) * hs;
  }, [...P(...c), (LID + 0.004) * hs]));
  const hollows = eyeC.map((c) => E([c[0], c[1] + 0.001, 0.088], [0.0165, 0.012, 0.0085]));
  const ear = (sx) => S.cut(0.004,
    E([sx * 0.0735, 0.0, -0.01], [0.0085, 0.028, 0.017], S.euler(0.15, sx * 0.35, 0)),
    E([sx * 0.0805, -0.003, -0.008], [0.004, 0.011, 0.0075], S.euler(0.15, sx * 0.35, 0)));
  const ears = both(ear);
  const neck = S.cone(P(0, -0.035, -0.026), [o[0], J.neck[1] - 0.025, J.neck[2]], p.neck, p.neck * 1.06);

  let head = S.union(0.012, skull, face, brow);
  head = S.cut(0.008, head, ...hollows);
  head = S.cut(0.0005, head, ...eyeC.map((c) => Sp(c, LID - 0.0001)));
  head = S.union(0.003, head, ...lids);
  head = S.union(0.005, head, nose);
  head = S.union(0.0075, head, lipU, lipL);
  head = S.cut(0.002, head, E([0, -0.0424, 0.0985], [mw * 0.95, 0.0011, 0.004]));
  head = S.union(0.004, head, ...ears);
  head = S.union(0.03, head, neck);
  // a point on the face's surface straight ahead of (x, y)
  const onFace = (x, yy) => { let z = 0.16; while (z > 0 && head.f(...P(x, yy, z)) > 0) z -= 0.0003; return [x, yy, z]; };

  const H = hair(p, P, E, Cn, skull, hs, ears);
  const shape = S.union(0, head, H.shape);

  const skin = hex(p.skin), hairC = hex(p.hairColor);
  const bw = woman ? 1 : 1.1;
  const browLines = both((sx) => S.chain(
    (woman ? [[0.012, 0.0345], [0.025, 0.039], [0.038, 0.0395], [0.05, 0.0355]] : [[0.011, 0.0345], [0.029, 0.0375], [0.049, 0.0345]]).map(([x, yy]) => P(...onFace(sx * x, yy))),
    (woman ? [0.0018, 0.0021, 0.0018, 0.0009] : [0.0026, 0.003, 0.0012]).map((v) => v * bw * hs), 0));
  const color = (X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    let c = skin;
    const ch = Math.exp(-(((abs(x) - 0.042) / 0.02) ** 2 + ((yy + 0.018) / 0.02) ** 2)) * (z > 0.04 ? 1 : 0);
    c = mix(c, [c[0] * 1.02, c[1] * 0.85, c[2] * 0.8], 0.3 * ch);
    const k = H.cover(X, Y, Z);
    if (k > 0) c = mix(c, mix(hairC, hairC.map((v) => v * 0.55), H.dark(X, Y, Z)), k);
    return c;
  };
  // masks for the skin's shader: brows, the lash lines, the lips (each
  // negative where it shows)
  const mask = (X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const brows = min(browLines[0].f(X, Y, Z), browLines[1].f(X, Y, Z)) / hs;
    let lash = 0.01;
    for (let i = 0; i < 2; i++) {
      const a = eyeAng[i](x, yy, z);
      if (abs(a.r - LID) > 0.004 || abs(a.th) > W + 0.25) continue;
      // a band just above the upper lid's edge, thinning to the corners
      const band = 0.16 * (1 - 0.6 * (abs(a.th) / W) ** 2) + (a.th > 0 ? 0.05 * smooth(0.3, 0.8, a.th / W) : 0);
      const d = max(a.up - a.ph, a.ph - a.up - band) * a.r;
      lash = min(lash, d);
    }
    // the lips' colour, drawn on the face: two ovals, the upper with a
    // little dip in the middle; the line between them with the lashes
    const ell = (cy, a, b) => (sqrt((x / a) ** 2 + ((yy - cy) / b) ** 2) - 1) * min(a, b);
    const upper = ell(-0.0373 - 0.001 * Math.exp(-((x / 0.004) ** 2)), mw, 0.0041 * lp);
    const lower = ell(-0.0478, mw * 0.86, 0.005 * lp);
    const lips = z > 0.08 ? min(upper, lower) : 0.01;
    const line = z > 0.08 && abs(x) < mw * 0.97 ? abs(yy + 0.0424) - 0.0005 * (1 - (x / mw) ** 2) - 0.00025 : 0.01;
    return [brows, min(lash, line), lips];
  };
  const isHair = (X, Y, Z) => H.cover(X, Y, Z) > 0.55;
  const lo = P(-0.108, -0.24, -0.135), hi = P(0.108, 0.145, 0.135);
  if (p.hair === 'pony') { lo[1] = o[1] - 0.29 * hs; lo[2] = o[2] - 0.2 * hs; }
  return { shape, layers: [{ name: 'skin', shape }], color: (l, X, Y, Z) => color(X, Y, Z), mask, hairAt: isHair, lo, hi, eyes: eyeC.map((c) => P(...c)), eyeR: eyeR * hs };
}

// hair: a shell over the skull, thick on top and thinning to nothing at
// the hairline, so it meets the skin softly; grooves for its strands
function hair(p, P, E, Cn, skull, hs, ears) {
  const o = P(0, 0, 0);
  const rel = (X, Y, Z) => [(X - o[0]) / hs, (Y - o[1]) / hs, (Z - o[2]) / hs];
  const pony = p.hair === 'pony';
  // the hairline's height by the angle round the head (0 in front)
  const line = pony
    ? [[0, 0.09], [0.5, 0.079], [0.95, 0.05], [1.22, 0.032], [1.48, 0.046], [1.85, 0.0], [2.3, -0.045], [3.2, -0.07]]
    : [[0, 0.088], [0.42, 0.083], [0.62, 0.07], [0.88, 0.062], [1.04, 0.012], [1.2, 0.004], [1.33, 0.038], [1.72, 0.036], [2.02, -0.015], [2.5, -0.045], [3.2, -0.058]];
  const lineAt = (a) => {
    for (let i = 1; i < line.length; i++) if (a <= line[i][0]) {
      const [a0, h0] = line[i - 1], [a1, h1] = line[i];
      return h0 + (h1 - h0) * smooth(0, 1, (a - a0) / (a1 - a0));
    }
    return line[line.length - 1][1];
  };
  const coverRel = (x, yy, z) => smooth(-0.003, 0.007, yy - lineAt(abs(atan2(x, z))));
  // short: close at the sides, volume on top towards the front, swept up
  const thick = pony
    ? (x, yy, z) => 0.0042 + 0.0024 * smooth(0.0, 0.1, yy) + 0.003 * smooth(0.06, 0.12, yy) * smooth(0.0, -0.08, z)
    : (x, yy, z) => 0.0016 + 0.013 * smooth(0.055, 0.115, yy) * (0.4 + 0.6 * smooth(-0.08, 0.06, z)) * (1 - 0.25 * smooth(0.02, 0.07, x));
  const tie = [0, 0.075, -0.107];
  const groove = (x, yy, z) => {
    let a;
    if (pony) {
      const ax = S.norm(S.sub(tie, [0, 0.03, 0])), v = S.sub([x, yy, z], [0, 0.03, 0]);
      const u = S.sub(v, S.scale(ax, S.dot(v, ax)));
      a = atan2(u[0], S.dot(u, S.norm(S.cross(ax, [1, 0, 0])))) * 40 + sin(S.dot(v, ax) * 70) * 0.7;
    } else {
      a = atan2(x - 0.004, yy - 0.01) * 38 + sin(z * 60 + x * 30) * 0.9 + sin(z * 23) * 0.6;
    }
    return 0.5 + 0.5 * sin(a);
  };
  // the shell rises from nothing at the hairline, more slowly where it is
  // thick, and stops below it (else it would fill the face)
  const cap = S.fn((X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    const above = yy - lineAt(abs(atan2(x, z))), full = thick(x, yy, z);
    const t = full * smooth(-0.001, 0.004 + 0.016 * smooth(0.004, 0.014, full), above);
    const d = skull.f(X, Y, Z) - (t - 0.0008 * smooth(0.002, 0.008, t) * groove(x, yy, z)) * hs;
    return max(d, (-above - 0.003) * hs);
  }, [o[0], o[1] + 0.03 * hs, o[2], 0.15 * hs]);
  let shape = S.cut(0.004, cap, ...ears.map((e) => S.grow(e, 0.0035)));
  let extra = null;
  if (!pony) {
    shape = S.cut(0.004, shape, Cn([0.033, 0.126, 0.066], [0.036, 0.129, 0.012], 0.0012));
  } else {
    shape = S.cut(0.004, shape, Cn([0, 0.115, 0.066], [0, 0.131, 0.02], 0.0009));
    const pts = [[0, 0.075, -0.104], [0, 0.06, -0.136], [0, 0.012, -0.153], [0, -0.058, -0.149], [0, -0.128, -0.131], [0, -0.19, -0.113]];
    const rad = [0.013, 0.021, 0.024, 0.021, 0.014, 0.0045];
    const tail = S.chain(pts.map((v) => P(...v)), rad.map((v) => v * hs), 0.012);
    extra = S.fn((X, Y, Z) => {
      const [x, yy, z] = rel(X, Y, Z);
      const a = atan2(x, z + 0.14) * 16 + yy * 24;
      return tail.f(X, Y, Z) + 0.0012 * hs * (0.5 + 0.5 * sin(a));
    }, tail.b);
    shape = S.union(0.01, shape, extra);
    shape = S.union(0.0015, shape, S.torus(P(0, 0.07, -0.112), 0.0142 * hs, 0.0043 * hs, S.axes([0, 0.55, -0.83])));
  }
  const cover = (X, Y, Z) => {
    const [x, yy, z] = rel(X, Y, Z);
    if (extra && extra.f(X, Y, Z) < 0.0015 * hs) return 1;
    const k = coverRel(x, yy, z);
    return pony ? k : k * (0.8 + 0.2 * smooth(0.004, 0.009, thick(x, yy, z)));
  };
  const dark = (X, Y, Z) => { const [x, yy, z] = rel(X, Y, Z); return 0.5 * (1 - groove(x, yy, z)); };
  return { shape, cover, dark };
}

// --- hands --------------------------------------------------------------
// A hand in its own frame: the wrist at the origin, the fingers along +y,
// the thumb's side +x, the back of the hand +z (a left hand). The pose is
// each joint's bend in radians (towards the palm) and the fingers' spread.
export const HAND_POSES = {
  relaxed: { f: [[0.3, 0.42, 0.22], [0.35, 0.5, 0.25], [0.4, 0.55, 0.28], [0.45, 0.6, 0.3]], spread: 0.05, thumb: { yaw: 0.55, pitch: 0.35, bend: [0.2, 0.25] } },
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
  parts.push(S.box(K([0.0, 0.048, 0.0]), K([0.04, 0.046, 0.0125]), S.euler(-arch * 0.5, 0, 0), 0.011 * k));
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
    parts.push(S.chain(pts, fg.r.map((v) => v * k), 0.004));
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
  const skin = hex(p.skin), nail = mix(hex(p.skin), [1, 0.93, 0.9], 0.45);
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
  const a = J.ankleL, s = p.height / 1.78, woman = p.id === 'woman', w = woman ? 0.9 : 1;
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
  const s = p.height / 1.78, c = [0, J.neck[1] + 0.02 * s, -0.025], ax = S.norm([0, 1, -0.3]);
  const R = p.neck + 0.0062, h = 0.033 * s;
  const band = S.tube(S.sub(c, S.scale(ax, h / 2)), S.add(c, S.scale(ax, h / 2)), R - 0.0026, R + 0.0026, 0.0012);
  const front = [0, c[1] - 0.3 * R * 0.96 - 0.004, c[2] + R * 0.96];
  const wings = [1, -1].map((sx) => S.ellipsoid([sx * 0.019, front[1] - 0.012, front[2] + 0.002], [0.02, 0.012, 0.0032], S.euler(-0.32, sx * 0.4, sx * 0.55)));
  const collar = S.union(0.004, band, ...wings);
  const parts = [{ name: 'shirt', shape: collar }];
  if (p.tie) {
    const k = p.id === 'woman' ? 0.85 : 1, tz = front[2] + 0.008, ty = front[1] - 0.009;
    const slab = S.box([0, ty, tz], [0.07, 0.05, 0.0062], null, 0.002);
    const lobes = S.meet(0.002, S.union(0.004,
      S.cone([0.004, ty, tz], [0.036 * k, ty + 0.001, tz - 0.003], 0.006, 0.016 * k),
      S.cone([-0.004, ty, tz], [-0.036 * k, ty + 0.001, tz - 0.003], 0.006, 0.016 * k)), slab);
    parts.push({ name: 'satin', shape: S.union(0.003, lobes, S.box([0, ty, tz + 0.0015], [0.0072, 0.009, 0.0072], null, 0.004)) });
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
  return {
    p, J,
    body: { ...body, h: 0.0052 },
    head: { ...headParts(p, J), h: 0.002 },
    shoe: { ...shoeShape(p, J), h: 0.0032 },
    cuff: { ...cuffShape(p, J), h: 0.002 },
    collar: { ...collarShape(p, J), h: 0.0016 },
    hands: Object.fromEntries(Object.keys(HAND_POSES).map((k) => [k, handShape(p, k)])),
    buttons,
  };
}

// colour every vertex of a mesh: which layer it lies on, its paint, and
// the masks its shader reads
export function paint(part, m) {
  const n = m.pos.length / 3, col = new Float32Array(n * 3), layer = new Uint8Array(n);
  const mask = part.mask ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
    let best = 0, bd = Infinity;
    part.layers.forEach((l, j) => { const d = l.shape.f(x, y, z); if (d < bd - 1e-5) { bd = d; best = j; } });
    layer[i] = part.hairAt ? (part.hairAt(x, y, z) ? 1 : 0) : best;
    const c = part.color(part.layers[best].name, x, y, z);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    if (mask) { const v = part.mask(x, y, z); mask[i * 3] = v[0]; mask[i * 3 + 1] = v[1]; mask[i * 3 + 2] = v[2]; }
  }
  return { ...m, col, layer, mask };
}
