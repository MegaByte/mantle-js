// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbChainAtHole — dump the interior face's CHAIN at the pixel Loop-Blinn loses.
//
// The under-fill is proved to be chainBoxCov on an INTERIOR face reporting the boundary pixel
// outside (bypassing that AA fills the ring). The chain is oriented in JS by orientLeft, which
// derives the direction from each edge's recorded normal; the shader then decides inside/outside
// from that direction alone (chainFillSide). So the question is whether the chain handed to the
// face adjacent to a HOLE points the way the shader expects — answerable here, on the CPU, by
// replicating chainFillSide against the dumped points.
import { buildLbShape } from '../src/renderer/lbBuildCore.js';

const C = (p1, p2, p3, p4) => ({ type: 2, p1, p2, p3, p4 });
const SQ_OUT = [
  C([20, 4], [31, 4], [36, 9], [36, 20]),
  C([36, 20], [36, 31], [31, 36], [20, 36]),
  C([20, 36], [9, 36], [4, 31], [4, 20]),
  C([4, 20], [4, 9], [9, 4], [20, 4]),
];
const SQ_IN = [
  C([20, 12], [26, 12], [28, 14], [28, 20]),
  C([28, 20], [28, 26], [26, 28], [20, 28]),
  C([20, 28], [14, 28], [12, 26], [12, 20]),
  C([12, 20], [12, 14], [14, 12], [20, 12]),
];
const rev = (segs) =>
  segs
    .slice()
    .reverse()
    .map((s) => C(s.p4, s.p3, s.p2, s.p1));
const built = buildLbShape([SQ_OUT, rev(SQ_IN)], true, false);
const mesh = built && built.raw ? built.raw : built;
const A = mesh.interiorChainA,
  B = mesh.interiorChainB,
  Cc = mesh.interiorChainC;
console.log(
  '  chains present:',
  !!A,
  !!B,
  !!Cc,
  ' interior verts:',
  mesh.interior ? mesh.interior.length / 2 : 0,
);
if (!A) {
  console.log('  no interior chains — nothing to inspect');
  process.exit(0);
}

// The failing fragment sits just OUTSIDE the hole on the +x axis: the hole's edge is x=28, y=20.
const Q = [28.06, 20];
const inTri = (p, a, b, c) => {
  const s = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const d1 = s(a, b, p),
    d2 = s(b, c, p),
    d3 = s(c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const iv = mesh.interior;
let found = -1;
for (let t = 0; t + 5 < iv.length; t += 6) {
  if (inTri(Q, [iv[t], iv[t + 1]], [iv[t + 2], iv[t + 3]], [iv[t + 4], iv[t + 5]])) {
    found = t / 2;
    break;
  }
}
if (found < 0) {
  console.log('  no interior triangle contains', Q);
  process.exit(0);
}
console.log(
  '  face vertex index',
  found,
  ' triangle',
  [
    [iv[found * 2], iv[found * 2 + 1]],
    [iv[found * 2 + 2], iv[found * 2 + 3]],
    [iv[found * 2 + 4], iv[found * 2 + 5]],
  ].map((p) => p.map((v) => +v.toFixed(2))),
);
const P = [
  [A[found * 4], A[found * 4 + 1]],
  [A[found * 4 + 2], A[found * 4 + 3]],
  [B[found * 4], B[found * 4 + 1]],
  [B[found * 4 + 2], B[found * 4 + 3]],
  [Cc[found * 4], Cc[found * 4 + 1]],
];
console.log(
  '  chain P0..P4:',
  P.map((p) => p.map((v) => +v.toFixed(3))),
);
console.log('  chain MODE (chainC.z):', Cc[found * 4 + 2]);
// chainFillSide, replicated: nearest chain segment to the pixel, then which side the pixel is on.
const rel = P.map((p) => [p[0] - Q[0], p[1] - Q[1]]);
let best = 1e30,
  side = true,
  which = -1;
for (let s = 0; s < 4; s++) {
  const a = rel[s],
    b = rel[s + 1];
  const d = [b[0] - a[0], b[1] - a[1]],
    L2 = d[0] * d[0] + d[1] * d[1];
  if (L2 < 1e-20) continue;
  const t = Math.max(0, Math.min(1, (-(a[0] * d[0]) - a[1] * d[1]) / L2));
  const c = [a[0] + t * d[0], a[1] + t * d[1]],
    dd = c[0] * c[0] + c[1] * c[1];
  if (dd < best) {
    best = dd;
    side = d[1] * a[0] - d[0] * a[1] >= 0;
    which = s;
  }
}
console.log('  nearest chain segment:', which, ' distance:', Math.sqrt(best).toFixed(4));
console.log(
  '  chainFillSide says INSIDE:',
  side,
  '   <-- the pixel IS inside the fill, so true is correct',
);

// ── chainBoxCov, replicated, on the real chain ────────────────────────────────
// The shader gives this face's boundary pixel coverage 0. With the chain in hand the whole
// function can be run on the CPU and its intermediates printed, which is the only way to see WHICH
// step produces the zero. Box coords: (P - fragment) * invE, invE = 8 px/em at this render scale.
const bparamOf = (p) => {
  if (Math.abs(p[1] + 0.5) < 1e-4) return Math.min(1, Math.max(0, p[0] + 0.5));
  if (Math.abs(p[0] - 0.5) < 1e-4) return 1 + Math.min(1, Math.max(0, p[1] + 0.5));
  if (Math.abs(p[1] - 0.5) < 1e-4) return 2 + Math.min(1, Math.max(0, 0.5 - p[0]));
  return 3 + Math.min(1, Math.max(0, 0.5 - p[1]));
};
const cornerOf = (j) =>
  j === 0 ? [0.5, -0.5] : j === 1 ? [0.5, 0.5] : j === 2 ? [-0.5, 0.5] : [-0.5, -0.5];
function chainBoxCov(pts) {
  const poly = [];
  let X = [0, 0];
  for (let s = 0; s < 4; s++) {
    const A = pts[s],
      B = pts[s + 1];
    const d = [B[0] - A[0], B[1] - A[1]];
    if (d[0] * d[0] + d[1] * d[1] < 1e-12) continue;
    const lo = [Math.min(A[0], B[0]), Math.min(A[1], B[1])],
      hi = [Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    if (hi[0] < -0.500001 || lo[0] > 0.500001 || hi[1] < -0.500001 || lo[1] > 0.500001) continue;
    let t0 = 0,
      t1 = 1,
      ok = true;
    for (let k = 0; k < 4; k++) {
      const P = k === 0 ? -d[0] : k === 1 ? d[0] : k === 2 ? -d[1] : d[1];
      const Q = k === 0 ? A[0] + 0.5 : k === 1 ? 0.5 - A[0] : k === 2 ? A[1] + 0.5 : 0.5 - A[1];
      if (Math.abs(P) < 1e-12) {
        if (Q < 0) ok = false;
      } else {
        const r = Q / P;
        if (P < 0) {
          if (r > t1) ok = false;
          else if (r > t0) t0 = r;
        } else {
          if (r < t0) ok = false;
          else if (r < t1) t1 = r;
        }
      }
    }
    if (!ok || t1 < t0) continue;
    const A2 = [A[0] + t0 * d[0], A[1] + t0 * d[1]],
      B2 = [A[0] + t1 * d[0], A[1] + t1 * d[1]];
    if (!poly.length) poly.push(A2);
    else {
      const p = poly[poly.length - 1];
      if ((p[0] - A2[0]) ** 2 + (p[1] - A2[1]) ** 2 > 1e-10 && poly.length < 12) poly.push(A2);
    }
    if (poly.length < 12) poly.push(B2);
    X = B2;
  }
  if (poly.length < 2) return { cov: null, why: 'MISS (n<2)' };
  let n = poly.length;
  const dEnd = [poly[n - 1][0] - poly[n - 2][0], poly[n - 1][1] - poly[n - 2][1]];
  if (
    Math.max(Math.abs(poly[n - 1][0]), Math.abs(poly[n - 1][1])) < 0.5 - 1e-4 &&
    dEnd[0] ** 2 + dEnd[1] ** 2 > 1e-12 &&
    n < 12
  ) {
    const L = Math.hypot(dEnd[0], dEnd[1]),
      dn = [dEnd[0] / L, dEnd[1] / L];
    const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - poly[n - 1][0]) / dn[0] : 1e9;
    const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - poly[n - 1][1]) / dn[1] : 1e9;
    const m = Math.min(tx, ty);
    poly.push([poly[n - 1][0] + dn[0] * m, poly[n - 1][1] + dn[1] * m]);
    n++;
    X = poly[n - 1];
  }
  const dBeg = [poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]];
  if (
    Math.max(Math.abs(poly[0][0]), Math.abs(poly[0][1])) < 0.5 - 1e-4 &&
    dBeg[0] ** 2 + dBeg[1] ** 2 > 1e-12 &&
    n < 12
  ) {
    const L = Math.hypot(dBeg[0], dBeg[1]),
      dn = [-dBeg[0] / L, -dBeg[1] / L];
    const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - poly[0][0]) / dn[0] : 1e9;
    const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - poly[0][1]) / dn[1] : 1e9;
    const m = Math.min(tx, ty);
    poly.unshift([poly[0][0] + dn[0] * m, poly[0][1] + dn[1] * m]);
    n++;
  }
  const E = poly[0];
  const dX = [poly[n - 1][0] - poly[n - 2][0], poly[n - 1][1] - poly[n - 2][1]];
  const leftN = [-dX[1], dX[0]];
  let tCCW;
  if (Math.abs(X[1] + 0.5) < 1e-4 && X[0] < 0.5 - 1e-4) tCCW = [1, 0];
  else if (Math.abs(X[0] - 0.5) < 1e-4 && X[1] < 0.5 - 1e-4) tCCW = [0, 1];
  else if (Math.abs(X[1] - 0.5) < 1e-4 && X[0] > -0.5 + 1e-4) tCCW = [-1, 0];
  else tCCW = [0, -1];
  const ccw = tCCW[0] * leftN[0] + tCCW[1] * leftN[1] >= 0;
  const pa = bparamOf(X),
    pb = bparamOf(E);
  if (ccw) {
    const pbW = pb < pa ? pb + 4 : pb;
    for (let j = 0; j < 8; j++) {
      const cp = (j % 4) + 1 <= pa ? (j % 4) + 1 + 4 * Math.floor(j / 4) : (j % 4) + 1;
      if (cp > pa + 1e-5 && cp < pbW - 1e-5 && poly.length < 12) poly.push(cornerOf(j % 4));
    }
  } else {
    const pbW = pb > pa ? pb - 4 : pb;
    for (let j = 7; j >= 0; j--) {
      const cp = (j % 4) + 1;
      if (cp < pa - 1e-5 && cp > pbW + 1e-5 && poly.length < 12) poly.push(cornerOf(j % 4));
    }
  }
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return {
    cov: Math.min(1, Math.max(0, Math.abs(area) * 0.5)),
    why: 'polygon',
    n: poly.length,
    ccw,
    pa,
    pb,
  };
}
console.log('\n  chainBoxCov across the hole boundary (fill is x > 28 here, invE = 8 px/em):');
for (let fx = 27.7; fx <= 28.35; fx += 0.0625) {
  const rel = P.map((p) => [(p[0] - fx) * 8, (p[1] - 20) * 8]);
  const r = chainBoxCov(rel);
  console.log(
    '    em x ' +
      fx.toFixed(4) +
      '  (r=' +
      (fx - 20).toFixed(3) +
      ')  cov ' +
      (r.cov === null ? 'MISS' : r.cov.toFixed(3)) +
      '   ' +
      r.why +
      (r.ccw !== undefined ? '  ccw=' + r.ccw : ''),
  );
}
