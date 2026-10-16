// sdf3d.js: solids as signed distance functions, blended like clay, and a
// mesher that turns them into triangles. Plain JS, no Three.js, so it can
// run in a worker or in node. Lengths in metres.
//
// A shape is { f(x, y, z), b: [cx, cy, cz, r] }: f is the signed distance
// (negative inside), b a sphere that holds the solid; outside it f is at
// least the distance to the sphere, which lets unions skip far parts.

const { sqrt, abs, max, min } = Math;

// --- vectors and frames -------------------------------------------------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => sqrt(dot(a, a));
export const norm = (a) => scale(a, 1 / (len(a) || 1));
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
// rotate v about unit axis k by angle t (Rodrigues)
export function rotate(v, k, t) {
  const c = Math.cos(t), s = Math.sin(t), kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}
// axes(y, xHint): three unit vectors, y along y, x as near xHint as it can
// be; returned as the rows of the matrix that takes world to local.
export function axes(y, xHint = [1, 0, 0]) {
  const Y = norm(y);
  let X = sub(xHint, scale(Y, dot(xHint, Y)));
  if (len(X) < 1e-6) X = sub([0, 0, 1], scale(Y, Y[2]));
  X = norm(X);
  const Z = cross(X, Y);
  return [X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2]];
}
// euler(x, y, z): rows of the world-to-local matrix of a frame turned by
// x, then y, then z radians about the world axes.
export function euler(ax, ay, az) {
  let X = [1, 0, 0], Y = [0, 1, 0];
  for (const [k, t] of [[[1, 0, 0], ax], [[0, 1, 0], ay], [[0, 0, 1], az]]) { X = rotate(X, k, t); Y = rotate(Y, k, t); }
  const Z = cross(X, Y);
  return [X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2]];
}

// --- primitives ---------------------------------------------------------
export function sphere(c, r) {
  const [cx, cy, cz] = c;
  return { f: (x, y, z) => { const dx = x - cx, dy = y - cy, dz = z - cz; return sqrt(dx * dx + dy * dy + dz * dz) - r; }, b: [cx, cy, cz, r] };
}

// ellipsoid: centre c, radii r along the local axes of m (rows: world to
// local; null for the world's). The distance is Quilez's bound.
export function ellipsoid(c, r, m = null) {
  const [cx, cy, cz] = c, [rx, ry, rz] = r;
  const ix = 1 / rx, iy = 1 / ry, iz = 1 / rz, ix2 = ix * ix, iy2 = iy * iy, iz2 = iz * iz, rmin = min(rx, ry, rz);
  const M = m || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const f = (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const lx = M[0] * dx + M[1] * dy + M[2] * dz, ly = M[3] * dx + M[4] * dy + M[5] * dz, lz = M[6] * dx + M[7] * dy + M[8] * dz;
    const k0 = sqrt(lx * lx * ix2 + ly * ly * iy2 + lz * lz * iz2);
    const k1 = sqrt(lx * lx * ix2 * ix2 + ly * ly * iy2 * iy2 + lz * lz * iz2 * iz2);
    return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -rmin;
  };
  return { f, b: [cx, cy, cz, max(rx, ry, rz)] };
}

// cone: a capsule from a (radius ra) to b (radius rb), the round cone of
// Quilez; |ra - rb| must stay below the length.
export function cone(a, b, ra, rb = ra) {
  const [ax, ay, az] = a;
  const bx = b[0] - ax, by = b[1] - ay, bz = b[2] - az;
  const l2 = bx * bx + by * by + bz * bz, rr = ra - rb, a2 = l2 - rr * rr, il2 = 1 / l2, srr = Math.sign(rr) * rr * rr;
  const f = (x, y, z) => {
    const px = x - ax, py = y - ay, pz = z - az;
    const yy = px * bx + py * by + pz * bz, zz = yy - l2;
    const qx = px * l2 - bx * yy, qy = py * l2 - by * yy, qz = pz * l2 - bz * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = srr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - rb;
    if (Math.sign(yy) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - ra;
    return (sqrt(x2 * a2 * il2) + yy * rr) * il2 - ra;
  };
  const L = sqrt(l2);
  return { f, b: [ax + bx / 2, ay + by / 2, az + bz / 2, L / 2 + max(ra, rb)] };
}

// chain: round cones through points p[i] with radii r[i], blended by k
export function chain(p, r, k = 0) {
  const parts = [];
  for (let i = 0; i + 1 < p.length; i++) parts.push(cone(p[i], p[i + 1], r[i], r[i + 1]));
  return union(k, ...parts);
}

// box: half extents h, corners rounded by rad, in the frame m
export function box(c, h, m = null, rad = 0) {
  const [cx, cy, cz] = c, hx = h[0] - rad, hy = h[1] - rad, hz = h[2] - rad;
  const M = m || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const f = (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const qx = abs(M[0] * dx + M[1] * dy + M[2] * dz) - hx, qy = abs(M[3] * dx + M[4] * dy + M[5] * dz) - hy, qz = abs(M[6] * dx + M[7] * dy + M[8] * dz) - hz;
    const ox = max(qx, 0), oy = max(qy, 0), oz = max(qz, 0);
    return sqrt(ox * ox + oy * oy + oz * oz) + min(max(qx, max(qy, qz)), 0) - rad;
  };
  return { f, b: [cx, cy, cz, sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2])] };
}

// torus: a ring of radius R in the local xz plane of m, tube radius r
export function torus(c, R, r, m = null) {
  const [cx, cy, cz] = c;
  const M = m || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const f = (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const lx = M[0] * dx + M[1] * dy + M[2] * dz, ly = M[3] * dx + M[4] * dy + M[5] * dz, lz = M[6] * dx + M[7] * dy + M[8] * dz;
    const q = sqrt(lx * lx + lz * lz) - R;
    return sqrt(q * q + ly * ly) - r;
  };
  return { f, b: [cx, cy, cz, R + r] };
}

// tube: a hollow cylinder from a to b, wall from ri to ro, edges rounded
export function tube(a, b, ri, ro, rad = 0.001) {
  const d = sub(b, a), L = len(d), u = norm(d), c = lerp(a, b, 0.5);
  const mid = (ri + ro) / 2, half = (ro - ri) / 2 - rad, hl = L / 2 - rad;
  const f = (x, y, z) => {
    const px = x - c[0], py = y - c[1], pz = z - c[2];
    const ax = px * u[0] + py * u[1] + pz * u[2];
    const rx = px - ax * u[0], ry = py - ax * u[1], rz = pz - ax * u[2];
    const q0 = abs(sqrt(rx * rx + ry * ry + rz * rz) - mid) - half, q1 = abs(ax) - hl;
    const o0 = max(q0, 0), o1 = max(q1, 0);
    return sqrt(o0 * o0 + o1 * o1) + min(max(q0, q1), 0) - rad;
  };
  return { f, b: [c[0], c[1], c[2], sqrt(L * L / 4 + ro * ro)] };
}

// half: the half space where n·p > d is outside (n need not be unit)
export function half(n, d) {
  const [nx, ny, nz] = norm(n), dd = d / len(n);
  return { f: (x, y, z) => nx * x + ny * y + nz * z - dd, b: [0, 0, 0, Infinity] };
}

// fn: any function, with the bound given
export const fn = (f, b = [0, 0, 0, Infinity]) => ({ f, b });

// --- combining ----------------------------------------------------------
const smin = (a, b, k) => { const h = max(k - abs(a - b), 0) / k; return min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => { const h = max(k - abs(a - b), 0) / k; return max(a, b) + h * h * k * 0.25; };

// union: the parts blended over k metres (0: a hard union). Parts whose
// bounds are farther than the running distance plus k are skipped.
export function union(k, ...parts) {
  parts = parts.filter(Boolean);
  if (parts.length === 1 && !k) return parts[0];
  const n = parts.length;
  const f = (x, y, z) => {
    let d = 1e9;
    for (let i = 0; i < n; i++) {
      const s = parts[i], b = s.b;
      if (b[3] !== Infinity) {
        const dx = x - b[0], dy = y - b[1], dz = z - b[2];
        if (sqrt(dx * dx + dy * dy + dz * dz) - b[3] > d + k) continue;
      }
      const v = s.f(x, y, z);
      d = k > 0 ? smin(d, v, k) : (v < d ? v : d);
    }
    return d;
  };
  return { f, b: enclose(parts.map((s) => s.b), k / 4) };
}
// cut: a with b taken out, the edge rounded over k
export function cut(k, a, ...bs) {
  bs = bs.filter(Boolean);
  const f = (x, y, z) => {
    let d = a.f(x, y, z);
    for (const s of bs) {
      const b = s.b;
      if (b[3] !== Infinity) {
        const dx = x - b[0], dy = y - b[1], dz = z - b[2];
        if (sqrt(dx * dx + dy * dy + dz * dz) - b[3] > k - d) continue;
      }
      const v = -s.f(x, y, z);
      d = k > 0 ? smax(d, v, k) : (v > d ? v : d);
    }
    return d;
  };
  return { f, b: a.b };
}
// meet: where a and every b overlap
export function meet(k, a, ...bs) {
  const f = (x, y, z) => {
    let d = a.f(x, y, z);
    for (const s of bs) { const v = s.f(x, y, z); d = k > 0 ? smax(d, v, k) : (v > d ? v : d); }
    return d;
  };
  return { f, b: a.b };
}
// grow: s thickened by t (a number, or a function of the point)
export function grow(s, t) {
  if (typeof t === 'number') return { f: (x, y, z) => s.f(x, y, z) - t, b: [s.b[0], s.b[1], s.b[2], s.b[3] + max(t, 0)] };
  return { f: (x, y, z) => s.f(x, y, z) - t(x, y, z), b: [s.b[0], s.b[1], s.b[2], s.b[3] + 0.03] };
}
// bend the space a shape lives in: f(warp(p))
export function warp(s, w, extra = 0.02) {
  return { f: (x, y, z) => { const p = w(x, y, z); return s.f(p[0], p[1], p[2]); }, b: [s.b[0], s.b[1], s.b[2], s.b[3] + extra] };
}

function enclose(bs, pad) {
  const fin = bs.filter((b) => b[3] !== Infinity);
  if (fin.length < bs.length || !fin.length) return [0, 0, 0, Infinity];
  let cx = 0, cy = 0, cz = 0;
  for (const b of fin) { cx += b[0]; cy += b[1]; cz += b[2]; }
  cx /= fin.length; cy /= fin.length; cz /= fin.length;
  let r = 0;
  for (const b of fin) r = max(r, sqrt((b[0] - cx) ** 2 + (b[1] - cy) ** 2 + (b[2] - cz) ** 2) + b[3]);
  return [cx, cy, cz, r + pad];
}

// --- meshing ------------------------------------------------------------
// gradient by the tetrahedron trick: four samples
export function grad(f, x, y, z, e) {
  const k0 = f(x + e, y - e, z - e), k1 = f(x - e, y - e, z + e), k2 = f(x - e, y + e, z - e), k3 = f(x + e, y + e, z + e);
  return [k0 - k1 - k2 + k3, -k0 - k1 + k2 + k3, -k0 + k1 - k2 + k3];
}

// mesh: the surface f = 0 inside the box lo..hi as triangles, by surface
// nets on a grid of step h, each vertex then pulled onto the surface.
// Returns { pos, nrm } (Float32Array, xyz per vertex) and idx (Uint32Array).
export function mesh(shape, lo, hi, h) {
  const f = shape.f;
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const sy = nx, sz = nx * ny;
  const val = new Float32Array(nx * ny * nz);
  const B = 8;
  // bricks of B³ samples: one sample at the middle decides whether the
  // surface can come near; if not, the whole brick takes that value.
  for (let bz = 0; bz < nz; bz += B) for (let by = 0; by < ny; by += B) for (let bx = 0; bx < nx; bx += B) {
    const ex = min(bx + B, nx), ey = min(by + B, ny), ez = min(bz + B, nz);
    const mx = lo[0] + (bx + ex - 1) / 2 * h, my = lo[1] + (by + ey - 1) / 2 * h, mz = lo[2] + (bz + ez - 1) / 2 * h;
    const hd = sqrt((ex - bx - 1) ** 2 + (ey - by - 1) ** 2 + (ez - bz - 1) ** 2) * h / 2;
    const d0 = f(mx, my, mz);
    if (abs(d0) > hd + 2 * h) {
      for (let k = bz; k < ez; k++) for (let j = by; j < ey; j++) val.fill(d0, bx + j * sy + k * sz, ex + j * sy + k * sz);
      continue;
    }
    for (let k = bz; k < ez; k++) {
      const z = lo[2] + k * h;
      for (let j = by; j < ey; j++) {
        const y = lo[1] + j * h, row = j * sy + k * sz;
        for (let i = bx; i < ex; i++) val[i + row] = f(lo[0] + i * h, y, z);
      }
    }
  }

  // a vertex in every cell the surface crosses: the mean of the crossings
  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
  const cell = new Int32Array(cnx * cny * cnz).fill(-1);
  const P = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const off = corner.map(([a, b, c]) => a + b * sy + c * sz);
  const v = new Float64Array(8);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
    const base = i + j * sy + k * sz;
    let inside = 0;
    for (let c = 0; c < 8; c++) { v[c] = val[base + off[c]]; if (v[c] < 0) inside |= 1 << c; }
    if (inside === 0 || inside === 255) continue;
    let sx = 0, syy = 0, szz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      const A = corner[a], Bc = corner[b];
      sx += A[0] + (Bc[0] - A[0]) * t; syy += A[1] + (Bc[1] - A[1]) * t; szz += A[2] + (Bc[2] - A[2]) * t; n++;
    }
    cell[i + j * cnx + k * cnx * cny] = P.length / 3;
    P.push(lo[0] + (i + sx / n) * h, lo[1] + (j + syy / n) * h, lo[2] + (k + szz / n) * h);
  }

  // a quad round every grid edge the surface crosses
  const I = [];
  const C = (i, j, k) => cell[i + j * cnx + k * cnx * cny];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    // split on the shorter diagonal
    const d02 = (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2;
    const d13 = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2;
    if (d02 <= d13) I.push(a, b, c, a, c, d); else I.push(b, c, d, b, d, a);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const s = i + j * sy + k * sz, a = val[s] < 0;
    if (i < cnx && j > 0 && k > 0 && j < cny && k < cnz && a !== (val[s + 1] < 0))
      quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), !a);
    if (j < cny && i > 0 && k > 0 && i < cnx && k < cnz && a !== (val[s + sy] < 0))
      quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), !a);
    if (k < cnz && i > 0 && j > 0 && i < cnx && j < cny && a !== (val[s + sz] < 0))
      quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), !a);
  }

  // pull each vertex onto the surface, then its normal from the gradient
  const nv = P.length / 3, pos = new Float32Array(P), nrm = new Float32Array(nv * 3), e = h * 0.3;
  for (let q = 0; q < nv; q++) {
    let x = pos[q * 3], y = pos[q * 3 + 1], z = pos[q * 3 + 2];
    const x0 = x, y0 = y, z0 = z;
    for (let it = 0; it < 3; it++) {
      const d = f(x, y, z);
      if (abs(d) < h * 0.01) break;
      const g = grad(f, x, y, z, e), gl = dot(g, g);
      if (gl < 1e-20) break;
      const s = d * 4 * e / gl; // grad gives 4e times the gradient
      x -= g[0] * s; y -= g[1] * s; z -= g[2] * s;
    }
    // stay near the cell (thin parts can pull a vertex across)
    const mv = sqrt((x - x0) ** 2 + (y - y0) ** 2 + (z - z0) ** 2);
    if (mv > h) { const t = h / mv; x = x0 + (x - x0) * t; y = y0 + (y - y0) * t; z = z0 + (z - z0) * t; }
    pos[q * 3] = x; pos[q * 3 + 1] = y; pos[q * 3 + 2] = z;
    const g = norm(grad(f, x, y, z, e));
    nrm[q * 3] = g[0]; nrm[q * 3 + 1] = g[1]; nrm[q * 3 + 2] = g[2];
  }
  return { pos, nrm, idx: new Uint32Array(I) };
}

// mirror a mesh across x = 0 (a left part made into the right one)
export function mirrorX(m) {
  const pos = m.pos.slice(), nrm = m.nrm.slice(), idx = m.idx.slice();
  for (let i = 0; i < pos.length; i += 3) { pos[i] = -pos[i]; nrm[i] = -nrm[i]; }
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const out = { ...m, pos, nrm, idx };
  if (m.col) out.col = m.col.slice();
  return out;
}
