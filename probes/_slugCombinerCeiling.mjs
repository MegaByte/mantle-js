// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _slugCombinerCeiling — how much of Slug's AA error is the COMBINER (2D area reconstructed
// from two 1D axis-ray coverages), and what would an exact reconstruction buy?
//
// For a single straight edge through the pixel, Slug knows:
//   rx = offset of the edge's crossing of the horizontal center line (px)
//   ry = offset of the edge's crossing of the vertical   center line (px)
// Those two points determine the line, so the exact box coverage is available in closed
// form. Slug instead blends clamp(rx+0.5) and clamp(ry+0.5) by center-proximity weights
// with a min() floor. This scores both against exact coverage over a sweep of angles and
// offsets — no GPU, pure math, so it isolates the model from everything else.
const N = 512; // offsets per angle
const SUB = 64; // reference: exact by analytic polygon clip

// exact area of {p in unit box centered at 0 : dot(p,n) <= d}  (n unit)
function exactCov(nx, ny, d) {
  // clip the square [-.5,.5]^2 by half-plane n.p <= d  → polygon area (Sutherland–Hodgman)
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i],
      B = poly[(i + 1) % poly.length];
    const da = nx * A[0] + ny * A[1] - d,
      db = nx * B[0] + ny * B[1] - d;
    if (da <= 0) out.push(A);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])]);
    }
  }
  if (out.length < 3) return out.length ? 0 : (0 - d > 0 ? 1 : 0) && 0;
  let a = 0;
  for (let i = 0; i < out.length; i++) {
    const A = out[i],
      B = out[(i + 1) % out.length];
    a += A[0] * B[1] - B[0] * A[1];
  }
  return Math.abs(a) / 2;
}

// Slug's combiner, fed the same edge (single crossing per ray)
function slugCombiner(nx, ny, d) {
  // H ray (y = 0): crossing at x = d/nx ; offset ri = x (in px)
  // V ray (x = 0): crossing at y = d/ny ; offset ri = y
  const anx = Math.abs(nx),
    any = Math.abs(ny);
  const EPS = 1e-6;
  const rx = anx > EPS ? d / nx : Infinity;
  const ry = any > EPS ? d / ny : Infinity;
  const cl = (v) => Math.min(1, Math.max(0, v));
  // xcov = clamp(ri + .5) with the sign of the crossing direction; for a single edge with
  // fill on the -n side, coverage along the ray is clamp(0.5 + rx) when nx>0.
  const xcov = isFinite(rx)
    ? cl(0.5 + (nx > 0 ? rx : -rx) * Math.sign(nx) * Math.sign(nx))
    : d > 0
      ? 1
      : 0;
  const ycov = isFinite(ry)
    ? cl(0.5 + (ny > 0 ? ry : -ry) * Math.sign(ny) * Math.sign(ny))
    : d > 0
      ? 1
      : 0;
  const xw = isFinite(rx) ? cl(1 - Math.abs(rx) * 2) : 0;
  const yw = isFinite(ry) ? cl(1 - Math.abs(ry) * 2) : 0;
  const wsum = Math.max(xw + yw, 1 / 65536);
  return Math.min(
    1,
    Math.max(
      0,
      Math.max(Math.abs(xcov * xw + ycov * yw) / wsum, Math.min(Math.abs(xcov), Math.abs(ycov))),
    ),
  );
}

// exact reconstruction from the same two crossings: (rx,0) and (0,ry) determine the line.
function exactFromCrossings(nx, ny, d) {
  return exactCov(nx, ny, d);
}

const angles = [];
for (let a = 0; a < 90; a += 1) angles.push((a * Math.PI) / 180);
let sumSlug = 0,
  maxSlug = 0,
  n = 0;
const perAngle = [];
for (const th of angles) {
  const nx = Math.cos(th),
    ny = Math.sin(th);
  // offsets where the edge actually crosses the box
  const dmax = 0.5 * (Math.abs(nx) + Math.abs(ny));
  let s = 0,
    m = 0,
    cnt = 0;
  for (let i = 0; i <= N; i++) {
    const d = -dmax + (2 * dmax * i) / N;
    const ex = exactCov(nx, ny, d);
    const sl = slugCombiner(nx, ny, d);
    const e = Math.abs(sl - ex) * 255;
    s += e;
    if (e > m) m = e;
    cnt++;
    sumSlug += e;
    if (e > maxSlug) maxSlug = e;
    n++;
  }
  perAngle.push([(th * 180) / Math.PI, s / cnt, m]);
}
console.log('Slug combiner vs EXACT half-plane box coverage (single straight edge)\n');
console.log(
  `  overall mean |error| = ${(sumSlug / n).toFixed(3)} /255      max = ${maxSlug.toFixed(3)} /255`,
);
console.log('\n  angle   mean   max   (deg, /255)');
for (const [a, mean, mx] of perAngle)
  if (a % 10 === 0 || a === 45)
    console.log(
      `  ${String(a).padStart(4)}  ${mean.toFixed(3).padStart(6)} ${mx.toFixed(3).padStart(6)}`,
    );
console.log('\n(0deg = vertical edge, 90deg = horizontal edge, 45deg = diagonal)');
console.log('An exact reconstruction from the SAME two crossings has error 0 by construction.');
