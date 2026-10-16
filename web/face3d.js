// face3d.js: reads the face in a photo, on the device, for Your player
// (app.js; CLIENT.md, "Your player"). MediaPipe's Face Landmarker
// (vendor/mediapipe-1.0.1, Apache 2.0) finds 478 points on the face; from
// them come the face's measures, each a factor on the body's usual (as
// body3d.js FACE), and from the pixels round them the skin's, the eyes' and
// the hair's colours. The photo never leaves the page: nothing is sent.
import { FaceLandmarker } from '/vendor/mediapipe-1.0.1/vision_bundle.mjs';
import { FACE_RANGES } from '/body3d.js';

const BASE = '/vendor/mediapipe-1.0.1/';
let reader = null;
// load starts the reader, once: about 15 MB the first time, which the
// browser then keeps (vendor/ is cached for a year).
export function load() {
  if (!reader) {
    reader = FaceLandmarker.createFromOptions(
      { wasmLoaderPath: BASE + 'vision_wasm_internal.js', wasmBinaryPath: BASE + 'vision_wasm_internal.wasm' },
      { baseOptions: { modelAssetPath: BASE + 'face_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 4 },
    ).catch((err) => { reader = null; throw err; });
  }
  return reader;
}

// The face's points used (MediaPipe's face mesh; "right" is the face's own):
// the irises' middles, the face's sides at the cheekbones and lower down,
// the jaw's corners, the chin, the eyes' corners, the nose's wings, the
// mouth's corners and the lips' edges, the cheeks and the forehead.
const IRIS_R = 468, IRIS_L = 473, IRIS_R_EDGE = 469, IRIS_L_EDGE = 474;
const SIDE_R = 234, SIDE_L = 454, LOW_R = 93, LOW_L = 323, JAW_R = 172, JAW_L = 397, CHIN = 152, TOP = 10;
const EYE_R_OUT = 33, EYE_R_IN = 133, EYE_L_IN = 362, EYE_L_OUT = 263;
const NOSE_R = 129, NOSE_L = 358, MOUTH_R = 61, MOUTH_L = 291, LIP_TOP = 0, LIP_BOTTOM = 17, LIP_IN_TOP = 13, LIP_IN_BOTTOM = 14;
const CHEEK_R = 50, CHEEK_L = 280, BROW = 151;
// AVERAGE: each measure's ratio on an average adult face, and how strongly a
// difference from it shows on the player (the player is stylised: a little
// more than true)
const AVERAGE = {
  w: [2.2, 1.5], jaw: [0.78, 2.5], chin: [0.95, 1.5], cheek: [0.93, 3], eye: [0.45, 1.2],
  gap: [0.235, 1], nose: [0.55, 1.5], mouth: [0.8, 1.2], lips: [0.25, 1.2],
};

// readFace finds the biggest face in canvas (the photo, drawn) and reads it:
// null when there is none; else {points: [{x, y}] in canvas pixels, box,
// look: {skin, hairColor, eyes, face}}, the measures on usual, the face's
// measures for the body chosen (body3d.js FACE[body]).
export async function readFace(canvas, usual) {
  const lm = await load();
  const faces = lm.detect(canvas).faceLandmarks || [];
  if (!faces.length) return null;
  const W = canvas.width, H = canvas.height;
  let best = null, widest = 0;
  for (const f of faces) {
    const w = Math.abs(f[SIDE_L].x - f[SIDE_R].x) * W;
    if (w > widest) { widest = w; best = f; }
  }
  const P = best.map((p) => ({ x: p.x * W, y: p.y * H }));
  const d = (a, b) => Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y);
  const mid = (a, b) => ({ x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2 });
  const ipd = d(IRIS_R, IRIS_L) || 1, faceW = d(SIDE_R, SIDE_L) || 1;
  const m = mid(LIP_IN_TOP, LIP_IN_BOTTOM);
  const ratios = {
    w: faceW / ipd,
    jaw: d(JAW_R, JAW_L) / faceW,
    chin: Math.hypot(m.x - P[CHIN].x, m.y - P[CHIN].y) / ipd,
    cheek: d(LOW_R, LOW_L) / faceW,
    eye: (d(EYE_R_OUT, EYE_R_IN) + d(EYE_L_IN, EYE_L_OUT)) / 2 / ipd,
    gap: d(EYE_R_IN, EYE_L_IN) / faceW,
    nose: d(NOSE_R, NOSE_L) / ipd,
    mouth: d(MOUTH_R, MOUTH_L) / ipd,
    lips: Math.max(0, d(LIP_TOP, LIP_BOTTOM) - d(LIP_IN_TOP, LIP_IN_BOTTOM)) / ipd,
  };
  const face = {};
  for (const [k, [avg, gain]] of Object.entries(AVERAGE)) {
    const [lo, hi] = FACE_RANGES[k];
    const v = (usual[k] ?? 1) * (ratios[k] / avg) ** gain;
    face[k] = Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
  }

  // colours: the pixels round the points, the glints and the deepest
  // shadows left out (unless there is nothing else: black hair)
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, W, H).data;
  const sample = (cx, cy, r0, r1 = r0) => {
    const kept = [0, 0, 0, 0], all = [0, 0, 0, 0];
    const step = Math.max(1, Math.floor(r1 / 6));
    for (let y = Math.floor(cy - r1); y <= cy + r1; y += step) {
      for (let x = Math.floor(cx - r1); x <= cx + r1; x += step) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const rr = Math.hypot(x - cx, y - cy);
        if (rr > r1 || rr < (r0 === r1 ? 0 : r0)) continue;
        const i = (y * W + x) * 4, c = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255], l = luma(c);
        all[0] += c[0]; all[1] += c[1]; all[2] += c[2]; all[3]++;
        if (l <= 0.93 && l >= 0.04) { kept[0] += c[0]; kept[1] += c[1]; kept[2] += c[2]; kept[3]++; }
      }
    }
    const s = kept[3] ? kept : all;
    return s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : null;
  };
  const avg = (list) => {
    const ok = list.filter(Boolean);
    return ok.length ? [0, 1, 2].map((i) => ok.reduce((a, c) => a + c[i], 0) / ok.length) : null;
  };
  // the skin, lifted a little: a photo's light leaves it darker than it
  // is, and the player is lit again
  const skin0 = avg([sample(P[CHEEK_R].x, P[CHEEK_R].y, faceW * 0.05), sample(P[CHEEK_L].x, P[CHEEK_L].y, faceW * 0.05), sample(P[BROW].x, P[BROW].y, faceW * 0.04)]);
  const skin = skin0 && skin0.map((v) => v * Math.min(1.15, 1 / Math.max(...skin0)));
  const irisR = (d(IRIS_R, IRIS_R_EDGE) + d(IRIS_L, IRIS_L_EDGE)) / 2;
  let eyes = avg([sample(P[IRIS_R].x, P[IRIS_R].y, irisR * 0.45, irisR * 0.9), sample(P[IRIS_L].x, P[IRIS_L].y, irisR * 0.45, irisR * 0.9)]);
  if (eyes) eyes = liven(eyes);
  // the hair: walking up from the forehead along the face's up, the first
  // patch that is not skin is the hairline, and the hair a little above it,
  // clear of the two's blend (none found: a high forehead, the photo cut
  // short, no hair; the player keeps theirs). Skin is the forehead's tint,
  // however lit: hair is darker, or (fair, grey) of another tint.
  const brow = sample(P[BROW].x, P[BROW].y, faceW * 0.04) || skin0;
  const tint = (c) => { const s = c[0] + c[1] + c[2] || 1; return [c[0] / s, c[1] / s]; };
  const notSkin = (c) => {
    if (!brow) return true;
    const a = tint(c), b = tint(brow);
    return luma(brow) - luma(c) > 0.12 || Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.04;
  };
  const upX = P[TOP].x - P[CHIN].x, upY = P[TOP].y - P[CHIN].y, hr = faceW * 0.035;
  const inside = (t) => P[TOP].y + upY * t - hr >= 0;
  const patch = (t) => sample(P[TOP].x + upX * t, P[TOP].y + upY * t, hr);
  let hairColor = null;
  for (let t = 0.03; t < 0.46 && inside(t); t += 0.03) {
    const c = patch(t);
    if (!c || !notSkin(c)) continue;
    const above = inside(t + 0.06) && patch(t + 0.06);
    hairColor = above && notSkin(above) ? above : c;
    break;
  }

  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  return {
    points: P,
    box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
    look: { skin: skin && hex(skin), hairColor: hairColor && hex(hairColor), eyes: eyes && hex(eyes), face },
  };
}

// liven: an iris in a photo reads darker and greyer than it looks; lift it
// to a colour the player's eye can show
function liven([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  const target = Math.min(0.42, Math.max(0.2, l * 1.6));
  const k = l > 0 ? target / l : 1;
  const c = [r * k, g * k, b * k];
  const grey = (c[0] + c[1] + c[2]) / 3;
  return c.map((v) => Math.min(1, Math.max(0, grey + (v - grey) * 1.3)));
}
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
