// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aacReverseIdentity — validate the AAC integrand reversal.
//
// Claim: clamp(1-Xl,0,1) === 1 - clamp(Xl,0,1), and Sum_seg INT_{Yl in [0,1]} dYl
// telescopes to 0 over any CLOSED contour (it is clamp(y_end)-clamp(y_start), a
// pure function of the segment endpoints). Therefore
//
//     run  =  Sum INT clamp(1-Xl) dYl  ==  -Sum INT clamp(Xl) dYl
//
// exactly. In the reversed form a segment entirely LEFT of the cell contributes
// ZERO (clamp(Xl)=0), and left-of-cell is exactly the suffix of Slug's
// maxX-descending order -> the break-early prune comes back.
//
// Checks, per random cell over random closed contours (lines+quads+cubics):
//   1. F1 (current) == F2 (reversed)                     [the identity]
//   2. F2 with left-of-cell segments DROPPED == F2       [break-early is legal]
//   3. fold(F1) == brute-force supersampled area          [both are ground truth]

const SEG = { LINE: 0, QUAD: 1, CUBIC: 2 };

function bez(seg, t) {
  const P = seg.P,
    u = 1 - t;
  if (seg.k === SEG.CUBIC)
    return [
      u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
    ];
  if (seg.k === SEG.QUAD)
    return [
      u * u * P[0][0] + 2 * u * t * P[1][0] + t * t * P[2][0],
      u * u * P[0][1] + 2 * u * t * P[1][1] + t * t * P[2][1],
    ];
  return [P[0][0] + t * (P[1][0] - P[0][0]), P[0][1] + t * (P[1][1] - P[0][1])];
}
function dbez(seg, t) {
  // analytic derivative
  const P = seg.P,
    u = 1 - t;
  if (seg.k === SEG.CUBIC)
    return [
      3 * u * u * (P[1][0] - P[0][0]) +
        6 * u * t * (P[2][0] - P[1][0]) +
        3 * t * t * (P[3][0] - P[2][0]),
      3 * u * u * (P[1][1] - P[0][1]) +
        6 * u * t * (P[2][1] - P[1][1]) +
        3 * t * t * (P[3][1] - P[2][1]),
    ];
  if (seg.k === SEG.QUAD)
    return [
      2 * u * (P[1][0] - P[0][0]) + 2 * t * (P[2][0] - P[1][0]),
      2 * u * (P[1][1] - P[0][1]) + 2 * t * (P[2][1] - P[1][1]),
    ];
  return [P[1][0] - P[0][0], P[1][1] - P[0][1]];
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// pixel-local transform: cell [0,1]^2 centerd on c, one pixel across
const toPL = (p, c, px) => [(p[0] - c[0]) * px[0] + 0.5, (p[1] - c[1]) * px[1] + 0.5];

// Fine midpoint quadrature of  INT g(Xl) * [Yl in (0,1)] * dYl  over one segment.
// gMode 0: g = clamp(1-Xl,0,1)   (current)   gMode 1: g = clamp(Xl,0,1) (reversed)
function segIntegral(seg, c, px, gMode, N = 400000) {
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const p = bez(seg, t),
      d = dbez(seg, t);
    const Xl = (p[0] - c[0]) * px[0] + 0.5,
      Yl = (p[1] - c[1]) * px[1] + 0.5;
    if (Yl <= 0 || Yl >= 1) continue; // d(clamp(y)) = 0 outside the cell
    const dYl = (d[1] * px[1]) / N; // dYl/dt * dt
    acc += (gMode === 0 ? clamp01(1 - Xl) : clamp01(Xl)) * dYl;
  }
  return acc;
}

// max Xl over the segment's CONTROL points (the convex-hull bound Slug stores as
// segRaw.z / breakAxis) -- this is what the break-early test uses.
function ctrlMaxXl(seg, c, px) {
  return Math.max(...seg.P.map((p) => toPL(p, c, px)[0]));
}

const fold = (run) => Math.min(Math.abs(run), 1);

// ---- brute-force reference: supersampled point-in-shape by nonzero winding ----
function flatten(segs, per = 64) {
  const pts = [];
  for (const s of segs) for (let i = 0; i < per; i++) pts.push(bez(s, i / per));
  return pts;
}
function windingAt(poly, x, y) {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    if (a[1] <= y) {
      if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) w++;
    } else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) w--;
  }
  return w;
}
function bruteCoverage(segs, c, px, S = 400) {
  const poly = flatten(segs);
  const hw = 0.5 / px[0],
    hh = 0.5 / px[1]; // half-pixel in em
  let hit = 0;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const x = c[0] - hw + ((i + 0.5) / S) * 2 * hw;
      const y = c[1] - hh + ((j + 0.5) / S) * 2 * hh;
      if (windingAt(poly, x, y) !== 0) hit++;
    }
  return hit / (S * S);
}

// ---- random closed contour: a wobbled star, mixed segment kinds ----
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function randomContour(nPts) {
  const V = [];
  for (let i = 0; i < nPts; i++) {
    const a = (i / nPts) * 2 * Math.PI,
      r = 30 + 50 * rnd();
    V.push([64 + r * Math.cos(a), 64 + r * Math.sin(a)]);
  }
  const segs = [];
  for (let i = 0; i < nPts; i++) {
    const A = V[i],
      B = V[(i + 1) % nPts],
      k = Math.floor(rnd() * 3);
    const lerp = (u) => [
      A[0] + (B[0] - A[0]) * u + (rnd() - 0.5) * 30,
      A[1] + (B[1] - A[1]) * u + (rnd() - 0.5) * 30,
    ];
    if (k === SEG.LINE) segs.push({ k, P: [A, B] });
    else if (k === SEG.QUAD) segs.push({ k, P: [A, lerp(0.5), B] });
    else segs.push({ k, P: [A, lerp(1 / 3), lerp(2 / 3), B] });
  }
  return segs; // closed: consecutive endpoints shared, last -> first
}

// D(S), computed ANALYTICALLY from the segment endpoints only:
//   INT_{Yl in [0,1]} dYl  =  clamp(Yl_end,0,1) - clamp(Yl_start,0,1)
// (clamp(Yl(t)) is a function of t, so the integral of its differential
// telescopes -- true for curves too, regardless of y-monotonicity).
function segD(seg, c, px) {
  const a = toPL(seg.P[0], c, px),
    b = toPL(seg.P[seg.P.length - 1], c, px);
  return clamp01(b[1]) - clamp01(a[1]);
}
// Same quantity via the same quadrature as segIntegral, so the pointwise clamp
// identity can be checked free of estimator bias.
function segDnum(seg, c, px, N = 400000) {
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N,
      p = bez(seg, t),
      d = dbez(seg, t);
    const Yl = (p[1] - c[1]) * px[1] + 0.5;
    if (Yl <= 0 || Yl >= 1) continue;
    acc += (d[1] * px[1]) / N;
  }
  return acc;
}

const px = [1, 1]; // 1 unit per pixel
let worstClamp = 0,
  worstTele = 0,
  worstIdent = 0,
  worstPrune = 0,
  worstRef = 0;
let n = 0,
  nPruned = 0,
  nTotal = 0,
  quadNoise = 0;

for (let trial = 0; trial < 6; trial++) {
  const segs = randomContour(5 + Math.floor(rnd() * 4));
  for (let s = 0; s < 12; s++) {
    const c = [20 + rnd() * 90, 20 + rnd() * 90];

    let f1 = 0,
      f2 = 0,
      f2pruned = 0,
      sumD = 0;
    for (const seg of segs) {
      const i1 = segIntegral(seg, c, px, 0);
      const i2 = segIntegral(seg, c, px, 1);
      // (a) POINTWISE clamp identity: clamp(1-Xl) + clamp(Xl) === 1, so
      //     I1(S) + I2(S) === D(S) under the *same* quadrature. Estimator-free.
      worstClamp = Math.max(worstClamp, Math.abs(i1 + i2 - segDnum(seg, c, px)));
      f1 += i1;
      f2 += -i2;
      sumD += segD(seg, c, px); // analytic, endpoints only
      nTotal++;
      // break-early: segment entirely left of the cell (ctrl maxXl < 0) -> I2 == 0
      if (ctrlMaxXl(seg, c, px) < 0) {
        nPruned++;
        continue;
      }
      f2pruned += -i2;
    }

    // (b) TELESCOPING: sum of D over a closed contour is exactly zero.
    worstTele = Math.max(worstTele, Math.abs(sumD));

    const ref = bruteCoverage(segs, c, px);
    worstIdent = Math.max(worstIdent, Math.abs(f1 - f2));
    worstPrune = Math.max(worstPrune, Math.abs(f2 - f2pruned));
    worstRef = Math.max(worstRef, Math.abs(fold(f1) - ref));
    quadNoise = Math.max(quadNoise, Math.abs(fold(f1) - ref));
    n++;
  }
}

const px255 = (v) => (v * 255).toFixed(3);
console.log(`cells tested          : ${n}`);
console.log(
  `segments pruned       : ${nPruned}/${nTotal} (${((100 * nPruned) / nTotal).toFixed(1)}%)`,
);
console.log(`\n-- the two algebraic claims (exact, estimator-free) --`);
console.log(`max |I1 + I2 - D|     : ${worstClamp.toExponential(3)}   [clamp(1-x) = 1-clamp(x)]`);
console.log(
  `max |sum D|           : ${worstTele.toExponential(3)}   [telescopes over closed contour]`,
);
console.log(`\n-- consequences (carry the quadrature's own noise) --`);
console.log(`max |F1 - F2|         : ${worstIdent.toExponential(3)}   (${px255(worstIdent)}/255)`);
console.log(`max |F2 - F2_pruned|  : ${worstPrune.toExponential(3)}   (${px255(worstPrune)}/255)`);
console.log(
  `max |fold(F1) - brute|: ${worstRef.toExponential(3)}   (${px255(worstRef)}/255)  <- estimator noise floor`,
);

// F1 == F2 can only be asserted to the estimator's own accuracy, which the
// F1-vs-brute residual measures. Anything at or below that floor is noise.
const floor = Math.max(quadNoise, 1e-9) * 2;
const clampOK = worstClamp < 1e-9,
  teleOK = worstTele < 1e-9;
const identOK = worstIdent < floor,
  pruneOK = worstPrune === 0,
  refOK = worstRef < 3e-3;
console.log(`\nclamp identity  I1+I2 == D    : ${clampOK ? 'PASS' : 'FAIL'}`);
console.log(`telescoping     sum D == 0    : ${teleOK ? 'PASS' : 'FAIL'}`);
console.log(`  => F1 == F2 (within ${floor.toExponential(1)}) : ${identOK ? 'PASS' : 'FAIL'}`);
console.log(`break-early is lossless       : ${pruneOK ? 'PASS (bit-exact)' : 'FAIL'}`);
console.log(`fold(F1) == brute-force area  : ${refOK ? 'PASS' : 'FAIL'}`);
process.exit(clampOK && teleOK && identOK && pruneOK && refOK ? 0 : 1);
