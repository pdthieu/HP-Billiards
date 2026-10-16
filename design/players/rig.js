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
// With `only` (bone indices), a skinned mesh can show just the skin those
// bones carry: the arm on the cloth, seen through the shooter's eyes.
// The upper arm fades out in a dither from just over the elbow (arm: the
// bind pose's elbow and the arm's way down), so the sleeve never shows an end.
function masked(base, uniforms, glsl, only = null, arm = null) {
  const m = new THREE.MeshPhysicalMaterial(base);
  const uOnly = { value: 0 };
  m.userData.only = uOnly;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.uniforms.uOnly = uOnly;
    sh.uniforms.uElbow = { value: new THREE.Vector3(...(arm ? arm.elbow : [0, 0, 0])) };
    sh.uniforms.uArmDir = { value: new THREE.Vector3(...(arm ? arm.dir : [0, -1, 0])) };
    const decl = Object.entries(uniforms).map(([k, u]) => `uniform ${u.value.isVector4 ? 'vec4' : 'vec3'} ${k};`).join('\n');
    const pick = only ? `vOnly = 0.0; for (int i = 0; i < 4; i++) { float b = skinIndex[i]; if (${only.map((k) => `abs(b - ${k.toFixed(1)}) < 0.5`).join(' || ')}) vOnly += skinWeight[i]; }` : 'vOnly = 1.0;';
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aMask;\nvarying vec3 vMask;\nvarying vec3 vBind;\nvarying float vOnly;\nvarying float vArmT;\nuniform vec3 uElbow;\nuniform vec3 uArmDir;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMask = aMask;\nvBind = position;\nvArmT = dot(position - uElbow, -uArmDir);\n${only ? '#ifdef USE_SKINNING\n' + pick + '\n#else\nvOnly = 1.0;\n#endif' : pick}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${decl}\nuniform float uOnly;\nvarying vec3 vMask;\nvarying vec3 vBind;\nvarying float vOnly;\nfloat shows(float v) { float w = max(fwidth(v), 1e-5) * 0.8; return 1.0 - smoothstep(-w, w, v); }
varying float vArmT;
float bayer4(vec2 p) { ivec2 q = ivec2(mod(p, 4.0)); float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.); return (m[q.x + q.y * 4] + 0.5) / 16.0; }`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (uOnly > 0.5 && (vOnly < 0.5 || 1.0 - smoothstep(0.0, 0.12, vArmT) < bayer4(gl_FragCoord.xy))) discard;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + glsl);
  };
  m.customProgramCacheKey = () => glsl + (only ? 'only' : '');
  return m;
}
// the face: the brows, the lash lines, the lips and the blush are drawn by
// the shader from the head's measures (body.js features) at each pixel's
// place in the bind pose, so they are as crisp as the screen however
// coarse the mesh; a little warm light at the skin's edges
const FACE_DECL = `varying vec3 vBind;
uniform vec3 uHO; uniform float uHS;
uniform vec3 uEye; uniform vec2 uEyeR; uniform vec4 uLid;
uniform vec3 uB[5];
uniform vec4 uMouth; uniform vec2 uLips; uniform vec3 uCheek; uniform vec4 uAmt; uniform float uWoman;
uniform vec3 uBrowC; uniform vec3 uLashC; uniform vec3 uLipC; uniform vec3 uLineC; uniform vec3 uBlushC; uniform vec3 uBeardC; uniform vec3 uShadeC;
float shows(float v) { float w = max(fwidth(v), 1e-6) * 0.75; return 1.0 - smoothstep(-w, w, v); }
// the distance to the segment ab (in xy), less its half width (z) there
float seg(vec2 p, vec3 a, vec3 b) {
  vec2 pa = p - a.xy, ba = b.xy - a.xy;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(a.z, b.z, h);
}`;
const FACE_PAINT = `{
  vec3 hp = (vBind - uHO) / uHS;
  float ax = abs(hp.x);
  vec2 fp = vec2(ax, hp.y);
  // the cheeks' colour
  vec2 bc = (fp - uCheek.xy) / uCheek.z;
  diffuseColor.rgb = mix(diffuseColor.rgb, uBlushC, uAmt.y * exp(-dot(bc, bc)) * smoothstep(0.04, 0.07, hp.z));
  // the lips: the mouth's line, the upper lip over it (a dip in the middle),
  // the fuller lower one under it
  float mx = hp.x / uMouth.y, mc = clamp(mx, -1.0, 1.0);
  float yc = uMouth.x + uMouth.z * 0.0034 * mc * mc;
  float top = yc + uLips.x * pow(max(0.0, 1.0 - mc * mc), 0.75) - 0.0009 * exp(-pow(hp.x / 0.0042, 2.0));
  float lx = hp.x / (uMouth.y * 0.84);
  float bot = yc - uLips.y * pow(max(0.0, 1.0 - lx * lx), 0.6);
  float upperD = max(max(yc - hp.y, hp.y - top), abs(hp.x) - uMouth.y);
  float lowerD = max(max(hp.y - yc, bot - hp.y), abs(hp.x) - uMouth.y * 0.84);
  float onMouth = smoothstep(0.066, 0.078, hp.z);
  float lips = shows(min(upperD, lowerD)) * onMouth;
  // stubble or a beard: the jaw, the chin and over the lip
  float bTop = mix(-0.03, 0.006, smoothstep(0.028, 0.072, ax));
  float beard = uAmt.w * smoothstep(0.004, -0.004, hp.y - bTop) * smoothstep(-0.118, -0.104, hp.y) * smoothstep(-0.03, 0.0, hp.z) * (1.0 - lips);
  diffuseColor.rgb = mix(diffuseColor.rgb, uBeardC, beard * 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, uLipC, lips * uAmt.x);
  // a soft shade under the lower lip, for its fullness
  float under = exp(-pow((hp.y - (bot - 0.0028)) / 0.0026, 2.0)) * (1.0 - smoothstep(0.6, 1.0, abs(lx))) * onMouth;
  diffuseColor.rgb *= 1.0 - 0.1 * under;
  float lineD = max(abs(hp.y - yc) - uMouth.w * (1.0 - pow(min(1.0, abs(mx)), 4.0)) - 0.00016, abs(hp.x) - uMouth.y * 1.03);
  diffuseColor.rgb = mix(diffuseColor.rgb, uLineC, shows(lineD) * onMouth * 0.92);
  // the brows
  float bd = min(min(seg(fp, uB[0], uB[1]), seg(fp, uB[1], uB[2])), min(seg(fp, uB[2], uB[3]), seg(fp, uB[3], uB[4])));
  diffuseColor.rgb = mix(diffuseColor.rgb, uBrowC, shows(bd) * smoothstep(0.042, 0.058, hp.z) * 0.96);
  // the lash lines: a band over the upper lid's edge, thicker to the
  // outer corner, and a flick out from it for her; a faint one under the
  // lower lid's outer half
  vec3 e = vec3(ax - uEye.x, hp.y - uEye.y, hp.z - uEye.z);
  float r = max(length(e), 1e-6);
  float th = atan(e.x, e.z);
  float ph = asin(clamp(e.y / r, -1.0, 1.0)) - uLid.w * th;
  float t = min(1.0, abs(th) / uLid.x);
  float up = uLid.y * pow(1.0 - t * t, 0.6) + 0.02;
  float lo = -uLid.z * pow(1.0 - t * t, 0.9) + 0.02;
  float near = (1.0 - smoothstep(0.005, 0.0075, abs(r - uEyeR.y))) * step(-0.006, e.z);
  float band = (0.1 + (0.03 + 0.06 * uWoman) * smoothstep(0.1, 1.0, th / uLid.x)) * uAmt.z;
  float ld = max(max(up - 0.05 - ph, ph - up - band), abs(th) - uLid.x - 0.02) * r;
  // the lid's shade, more for her, up to a soft crease
  float shade = smoothstep(up - 0.02, up + 0.05, ph) * (1.0 - smoothstep(up + 0.16, up + 0.34, ph)) * (1.0 - smoothstep(uLid.x, uLid.x + 0.25, abs(th)));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uShadeC, shade * near);
  if (uWoman > 0.5) {
    float t0 = 0.8, u0 = uLid.y * pow(1.0 - t0 * t0, 0.6) + 0.02;
    vec2 a = vec2(uLid.x * t0, u0 + band * 0.5), b = vec2(uLid.x + 0.3, 0.26);
    vec2 pa = vec2(th, ph) - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    ld = min(ld, (length(pa - ba * h) - band * 0.5 * (1.0 - h)) * r);
  }
  float lower = max(max(ph - lo, lo - 0.045 - ph), max(0.3 * uLid.x - th, th - uLid.x)) * r;
  diffuseColor.rgb = mix(diffuseColor.rgb, uLashC, max(shows(ld), shows(lower) * 0.4) * near);
}`;
const SKIN_EDGE = `{
  float nv = max(dot(normal, normalize(vViewPosition)), 0.0);
  outgoingLight += diffuseColor.rgb * pow(1.0 - nv, 3.0) * 0.16;
}`;
function faceMaterial(look, F, glow) {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.56, sheen: 0.3, sheenRoughness: 0.45, sheenColor: new THREE.Color('#ffc8b0'), emissive: glow });
  const col = (h) => ({ value: new THREE.Color(h) });
  const v3 = (a) => ({ value: new THREE.Vector3(a[0], a[1], a[2]) });
  const lineColor = new THREE.Color(look.lip).multiplyScalar(F.woman ? 0.45 : 0.6);
  const u = {
    uHO: v3(F.o), uHS: { value: F.hs },
    uEye: v3(F.eye), uEyeR: { value: new THREE.Vector2(F.eyeR, F.lidR) }, uLid: { value: new THREE.Vector4(...F.lid) },
    uB: { value: F.brow.map((b) => new THREE.Vector3(b[0], b[1], b[2])) },
    uMouth: { value: new THREE.Vector4(...F.mouth) }, uLips: { value: new THREE.Vector2(...F.lips) }, uCheek: v3(F.cheek),
    uAmt: { value: new THREE.Vector4(...F.amounts) }, uWoman: { value: F.woman ? 1 : 0 },
    uBrowC: col(look.browColor), uLashC: col('#120c0a'), uLipC: col(look.lip), uLineC: { value: lineColor },
    uBlushC: col('#e2735f'), uBeardC: col(new THREE.Color(look.hairColor).lerp(new THREE.Color(look.skin), 0.35)),
    uShadeC: { value: F.woman ? new THREE.Color(0.76, 0.62, 0.64) : new THREE.Color(0.93, 0.89, 0.87) },
  };
  m.userData.face = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + FACE_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FACE_PAINT)
      .replace('#include <opaque_fragment>', SKIN_EDGE + '\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'face';
  return m;
}
// hair: a highlight along the strands (Kajiya and Kay's), from a light
// above and in front, so the clumps read and the head shines a little
function hairMaterial(look) {
  const base = new THREE.Color(look.hairColor);
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.82, sheen: 0.2, sheenRoughness: 0.6, sheenColor: base.clone().lerp(new THREE.Color('#ffffff'), 0.2) });
  const u = {
    uHairL: { value: new THREE.Vector3(0.25, 1, 0.5).normalize() },
    uSpec: { value: base.clone().lerp(new THREE.Color('#e8ecf4'), 0.55).multiplyScalar(0.13) },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aFlow;\nvarying vec3 vFlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlow = normalize((modelViewMatrix * vec4(aFlow, 0.0)).xyz);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFlow;\nuniform vec3 uHairL;\nuniform vec3 uSpec;')
      .replace('#include <opaque_fragment>', `{
        vec3 T = normalize(vFlow - normal * dot(vFlow, normal) + 1e-5);
        vec3 V = normalize(vViewPosition);
        vec3 L = normalize((viewMatrix * vec4(uHairL, 0.0)).xyz);
        vec3 Hh = normalize(L + V);
        float s1 = dot(normalize(T + normal * 0.12), Hh), s2 = dot(normalize(T - normal * 0.2), Hh);
        float k1 = pow(sqrt(max(0.0, 1.0 - s1 * s1)), 60.0), k2 = pow(sqrt(max(0.0, 1.0 - s2 * s2)), 20.0);
        float lit = smoothstep(-0.2, 0.5, dot(normal, L));
        outgoingLight += (uSpec * k1 + diffuseColor.rgb * 0.3 * k2) * lit;
      }
      #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'hair';
  return m;
}
function materials(look, armBones, F, arm, vest) {
  const col = (h) => ({ value: new THREE.Color(h) });
  // the body: the vertex colour is the waistcoat's; x: in the waistcoat,
  // y: on the trousers, z: on the torso (not a sleeve)
  // the pockets' welts and the line where the fronts meet, from the bind
  // pose's place (vBind), so they are as crisp as the waistcoat's edges
  const cloth = masked({ vertexColors: true, roughness: 0.78, sheen: 0.45, sheenRoughness: 0.55, sheenColor: new THREE.Color('#9a9a9a') },
    { uShirt: col(look.shirt), uTrousers: col(look.trousers), uWelt: { value: new THREE.Vector4(...vest.welt) }, uSeam: { value: new THREE.Vector3(vest.seam, 0, 0) } },
    `float vest = shows(vMask.x) * shows(-vMask.z);
    float front = step(0.0, vBind.z);
    float welt = max(abs(abs(vBind.x) - uWelt.x) - uWelt.z, abs(vBind.y - uWelt.y) - uWelt.w);
    float seam = max(abs(vBind.x) - 0.0012, vBind.y - uSeam.x);
    diffuseColor.rgb *= 1.0 - 0.45 * max(shows(welt), shows(seam)) * front;
    vec3 top = mix(uShirt, diffuseColor.rgb, vest);
    diffuseColor.rgb = mix(top, uTrousers, shows(vMask.y));`, armBones, arm);
  const glow = new THREE.Color(look.skin).multiplyScalar(0.06);
  const skin = faceMaterial(look, F, glow);
  const plainSkin = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.56, sheen: 0.3, sheenRoughness: 0.45, sheenColor: new THREE.Color('#ffc8b0'), emissive: glow });
  const shirt = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.78, sheen: 0.45, sheenRoughness: 0.55, sheenColor: new THREE.Color('#9a9a9a') });
  const hair = hairMaterial(look);
  const leather = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.28, clearcoat: 0.9, clearcoatRoughness: 0.12 });
  const satin = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, sheen: 0.7, sheenRoughness: 0.3, sheenColor: new THREE.Color('#5a5a66') });
  return { cloth, skin, plainSkin, shirt, hair, leather, satin };
}

// an eye's paint, wrapped round its ball (the iris on +z): a warm white
// shaded under the lid, a big iris darker at its rim and lighter by the
// pupil, and two catchlights up on the left
function eyeTexture(iris) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const sc = g.createLinearGradient(0, 0, 0, 512);
  sc.addColorStop(0, '#a99b92'); sc.addColorStop(0.3, '#e4dcd3'); sc.addColorStop(0.42, '#f7f2eb'); sc.addColorStop(0.64, '#f4efe8'); sc.addColorStop(1, '#d6cbc1');
  g.fillStyle = sc; g.fillRect(0, 0, 1024, 512);
  const cx = 256, cy = 256, R = 114; // 0.7 rad round
  const base = new THREE.Color(iris), hexOf = (c) => '#' + c.getHexString();
  const light = hexOf(base.clone().lerp(new THREE.Color('#ffffff'), 0.28)), dark = hexOf(base.clone().multiplyScalar(0.45));
  const ir = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  ir.addColorStop(0, '#050404'); ir.addColorStop(0.43, '#050404'); ir.addColorStop(0.47, light);
  ir.addColorStop(0.72, iris); ir.addColorStop(0.9, dark); ir.addColorStop(1, '#0c0807');
  g.fillStyle = ir; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // fine streaks, and the lid's shade over the iris's top
  g.save(); g.beginPath(); g.arc(cx, cy, R * 0.92, 0, Math.PI * 2); g.clip();
  g.strokeStyle = 'rgba(255,236,210,0.09)'; g.lineWidth = 2;
  for (let a = 0; a < Math.PI * 2; a += 0.11) { g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5); g.lineTo(cx + Math.cos(a) * R * 0.88, cy + Math.sin(a) * R * 0.88); g.stroke(); }
  const shade = g.createLinearGradient(0, cy - R, 0, cy + R);
  shade.addColorStop(0, 'rgba(0,0,0,0.45)'); shade.addColorStop(0.45, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(255,255,255,0.06)');
  g.fillStyle = shade; g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  g.restore();
  g.fillStyle = 'rgba(255,255,255,0.96)';
  g.beginPath(); g.ellipse(cx - R * 0.34, cy - R * 0.36, R * 0.19, R * 0.17, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.beginPath(); g.ellipse(cx + R * 0.3, cy + R * 0.36, R * 0.07, R * 0.065, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
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
  if (m.flow) g.setAttribute('aFlow', new THREE.BufferAttribute(m.flow, 3));
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

// coarse: how many times the parts' own steps; far away (in the game) the
// shapes hold up at about twice the step, and the face's paint stays crisp
function meshPart(part, coarse = 1) {
  return paint(part, S.mesh(part.shape, part.lo, part.hi, part.h * coarse));
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
export function createPlayer(look, opts = {}) {
  const B = build(look), J = B.J, K = opts.coarse || 1;
  const M = materials(look, ['arm.L', 'fore.L', 'hand.L'].map((n) => BONES.findIndex((b) => b[0] === n)), B.head.features, { elbow: J.elbowL, dir: J.armDir }, B.body.vest);
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
  const bm = meshPart(B.body, K);
  bm.classOf = [0, 0, 0];
  const body = shadowy(new THREE.SkinnedMesh(geometry(bm, ['cloth'], skinWeights(bm, segs.filter((s) => s.bone !== 'head'), names)), [M.cloth]));
  root.add(body);
  body.bind(skeleton, body.matrixWorld);
  // head and neck
  const hm = meshPart(B.head, K);
  hm.classOf = [0];
  const headSegs = segs.filter((s) => ['chest', 'neck', 'head'].includes(s.bone)).map((s) => s.bone === 'head' ? { ...s, a: S.add(J.head, [0, 0.0, 0]) } : s);
  const head = shadowy(new THREE.SkinnedMesh(geometry(hm, ['skin'], skinWeights(hm, headSegs, names)), [M.skin]));
  root.add(head);
  head.bind(skeleton, head.matrixWorld);

  // rigid parts ride on their bone; built where they sit in the bind pose
  const attach = (bone, g, mats, at) => {
    const mesh = shadowy(new THREE.Mesh(g, mats));
    mesh.position.set(-at[0], -at[1], -at[2]);
    bones[bone].add(mesh);
    return mesh;
  };
  const one = (part, cls) => { const m = meshPart(part, K); m.classOf = part.layers.map(() => 0); return { m, g: geometry(m, [cls]) }; };
  const shoe = one(B.shoe, 'leather');
  attach('foot.L', shoe.g, [M.leather], J.ankleL);
  attach('foot.R', geometry(S.mirrorX(shoe.m), ['leather']), [M.leather], J.ankleR);
  const cuff = one(B.cuff, 'cloth');
  attach('fore.L', cuff.g, [M.shirt], J.elbowL);
  attach('fore.R', geometry(S.mirrorX(cuff.m), ['cloth']), [M.shirt], J.elbowR);
  const cm = meshPart(B.collar, K);
  cm.classOf = B.collar.layers.map((l) => (l.name === 'satin' ? 1 : 0));
  attach('neck', geometry(cm, ['cloth', 'satin']), [M.shirt, M.satin], J.neck);
  // the hair: its own mesh on the head, so the hairline is as sharp as
  // where it meets the skin
  const hair = one(B.hair, 'hair');
  const hairMesh = attach('head', hair.g, [M.hair], J.head);
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
  const eyeGeo = new THREE.SphereGeometry(B.head.eyeR, 48, 24);
  const eyeMat = new THREE.MeshPhysicalMaterial({ map: eyeTexture(look.iris), roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.03 });
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
    const m = meshPart(part, K);
    m.classOf = [0];
    for (const side of ['L', 'R']) {
      const mm = toBind(side === 'L' ? m : { ...m, pos: mirrorCanon(m.pos), nrm: mirrorCanon(m.nrm) }, side);
      const mesh = attach('hand.' + side, geometry(mm, ['skin']), [M.plainSkin], J['wrist' + side]);
      mesh.visible = pose === 'relaxed';
      hands[side][pose] = mesh;
    }
  }

  const player = { look, root, bones, skeleton, J, B, hands, eyes, body, head, hair: hairMesh, materials: M };
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
  // the eyes turn the rest of the way, but not far, or too much white shows
  const want = player.root.localToWorld(target.clone()), wp = new THREE.Vector3(), hq = new THREE.Quaternion();
  for (const e of player.eyes) {
    e.parent.updateMatrixWorld(true);
    e.getWorldPosition(wp);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(e.parent.getWorldQuaternion(hq));
    const to = want.clone().sub(wp).normalize(), ang = fwd.angleTo(to), lim = 0.26;
    e.lookAt(wp.clone().add(ang > lim ? fwd.lerp(to, lim / ang).normalize() : to));
  }
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
  // the left arm hangs by the side, the elbow a little bent
  player.root.updateMatrixWorld(true);
  const shL = charPos(player, player.bones['arm.L']);
  twoBone(player, 'arm.L', 'fore.L', 'shoulderL', 'elbowL', 'wristL', shL.clone().add(new THREE.Vector3(0.035, -0.5 * h, 0.07)), shL.clone().add(new THREE.Vector3(0.12, -0.3, -0.6)));
  player.root.updateMatrixWorld(true);
  // the hand hangs on from the forearm, its palm to the thigh
  const elL = charPos(player, player.bones['fore.L']), wrL = charPos(player, player.bones['hand.L']);
  const along = wrL.clone().sub(elL).normalize().add(new THREE.Vector3(0, -1.2, -0.25)).normalize();
  setCharQuat(player, player.bones['hand.L'], handQuat(player, 'L', along, new THREE.Vector3(0.15, 0, 1).normalize()));
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
  // twisted round the spine so the cue arm's shoulder rides higher than the
  // bridge arm's (a turn about the bind pose's y, before the tip forward)
  const twist = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t);
  const qP = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.15, -turn * 1.1, 0, 'YXZ')).multiply(twist(-0.12));
  const qC = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.47, -turn, 0.1, 'YXZ')).multiply(twist(-0.38));
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
  // the grip: the right hand on the butt, under the elbow, so at rest the
  // forearm hangs straight down from it and swings back on the stroke
  const qR = gripQuat(player, 'R', back.clone().negate(), new THREE.Vector3(0.12, -1, 0).normalize());
  const handOff = handPoint(player, 'R', qR, new THREE.Vector3(), GRIP.at);
  const shR = charPos(player, player.bones['arm.R']);
  let rest = 0.95 * h;
  for (let i = 0; i < 4; i++) {
    const elbowY = onCue(rest).y - handOff.y + J.fore;
    const rise = Math.min(J.upper * 0.94, Math.max(0, elbowY - shR.y));
    rest = (ball.z - shR.z) + Math.sqrt(J.upper * J.upper - rise * rise) - handOff.z;
  }
  const g = onCue(rest + pull);
  const wR = g.clone().sub(handOff);
  twoBone(player, 'arm.R', 'fore.R', 'shoulderR', 'elbowR', 'wristR', wR, shR.clone().add(new THREE.Vector3(-0.08, 0.6, -0.2)));
  setCharQuat(player, player.bones['hand.R'], qR);
  player.setHand('R', 'grip');
  player.root.updateMatrixWorld(true);
  // eyes along the cue, to the ball and past it
  look(player, ball.clone().add(f.clone().multiplyScalar(1.4)).setY(bed + 0.02), 0.12);
  player.root.updateMatrixWorld(true);
  return { tip, ball };
}
