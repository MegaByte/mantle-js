// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// predicates.js — exact-sign geometric predicates (orient2d, incircle).
//
// The constrained Delaunay triangulator (cdt.js) must NOT compute orientation
// or the in-circle test with plain double determinants gated by an absolute EPS.
// That is the classic robustness anti-pattern: near-degenerate inputs
// (collinear control points, near-coincident glyph/curve vertices, near-cocircular
// vertices, intersection-split Steiner points) can flip the SIGN of the
// determinant, corrupting topology — the "8's waist chord" cavity livelock (torn-
// sliver dead stripe) and the earcut "wrong wedges" both trace to orientation sign
// errors. An epsilon test can also flip on near-degenerate input, so the sign has
// to be exact rather than thresholded.
//
// So both predicates return the exact sign, via Shewchuk's adaptive-precision floating-point
// arithmetic (Jonathan Richard Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast
// Robust Geometric Predicates," Discrete & Computational Geometry 18(3), 305-363, 1997 —
// https://doi.org/10.1007/PL00009321). Reimplemented from the paper; no code copied.
//
// The cascade: a plain floating-point evaluation with a rigorous error bound decides the common
// case (~99.9% — probes/_predicateHeat.mjs). Below that bound the determinant is recomputed with
// progressively longer EXPANSIONS — arrays of doubles whose sum is exactly the true value —
// stopping the moment the sign is certain. The final level is exact, so the sign always is.
//
// The primitives are error-FREE transformations: twoSum/twoDiff/twoProduct return (hi, lo) whose
// sum equals the true result with no rounding. Everything else is bookkeeping on those.
//
// Why not a BigInt exact evaluation: BigInt is exact too, but it ALLOCATES, on ~1 call in 800
// during a mesh build. Adaptive expansions are allocation-free (module scratch), ~30x faster on
// the uncertain distribution, and — unlike a double-double tier — they decide the TRUE
// degeneracies (exactly-collinear input, which is what glyph outlines' hard cases are) instead
// of punting on them.
//
// Sign conventions match cdt.js exactly:
//   orient2d(a,b,c)   > 0  iff  a,b,c counterclockwise
//   incircle(a,b,c,d) > 0  iff  d strictly inside the circumcircle of CCW a,b,c
//
// The filter and the exact result agree, so the fast path and the exact path take the same branch.

const epsilon = 1.1102230246251565e-16; // 2^-53
const splitter = 134217729; // 2^27 + 1 (Dekker)
const resulterrbound = (3 + 8 * epsilon) * epsilon;
const ccwerrboundA = (3 + 16 * epsilon) * epsilon;
const ccwerrboundB = (2 + 12 * epsilon) * epsilon;
const ccwerrboundC = (9 + 64 * epsilon) * epsilon * epsilon;
const iccerrboundA = (10 + 96 * epsilon) * epsilon;
const iccerrboundB = (4 + 48 * epsilon) * epsilon;
const iccerrboundC = (44 + 576 * epsilon) * epsilon * epsilon;

// Which tier decided. `*Exact` counts the fully-expanded evaluations. Nothing here allocates.
export const predicateStats = {
  orient2d: 0,
  orient2dAdapt: 0,
  orient2dExact: 0,
  incircle: 0,
  incircleAdapt: 0,
  incircleExact: 0,
  incircleFull: 0,
};
export function resetPredicateStats() {
  predicateStats.orient2d = 0;
  predicateStats.orient2dAdapt = 0;
  predicateStats.orient2dExact = 0;
  predicateStats.incircle = 0;
  predicateStats.incircleAdapt = 0;
  predicateStats.incircleExact = 0;
  predicateStats.incircleFull = 0;
}

// ---- error-free transformations --------------------------------------------
// Each writes its low word to `_lo` and returns the high word, so the hot paths stay
// allocation-free (no tuples).
let _lo = 0;

function twoSum(a, b) {
  const x = a + b;
  const bv = x - a,
    av = x - bv;
  _lo = a - av + (b - bv);
  return x;
}
function twoDiff(a, b) {
  const x = a - b;
  const bv = a - x,
    av = x + bv;
  _lo = a - av + (bv - b);
  return x;
}
// requires |a| >= |b|
function fastTwoSum(a, b) {
  const x = a + b;
  _lo = b - (x - a);
  return x;
}
function twoProduct(a, b) {
  const x = a * b;
  const c = splitter * a,
    ahi = c - (c - a),
    alo = a - ahi;
  const d = splitter * b,
    bhi = d - (d - b),
    blo = b - bhi;
  _lo = alo * blo - (x - ahi * bhi - alo * bhi - ahi * blo);
  return x;
}

// (a1+a0) - (b1+b0), as the 4-word expansion x[0..3] (increasing magnitude).
// Two chained two_one_diff steps, exactly as in the paper.
function twoTwoDiff(a1, a0, b1, b0, x) {
  // two_one_diff(a1, a0, b0) -> (j, r, x0)
  const i0 = twoDiff(a0, b0);
  x[0] = _lo;
  const j = twoSum(a1, i0);
  const r = _lo;
  // two_one_diff(j, r, b1) -> (x3, x2, x1)
  const i1 = twoDiff(r, b1);
  x[1] = _lo;
  const x3 = twoSum(j, i1);
  x[2] = _lo;
  x[3] = x3;
}

// ---- expansion arithmetic (non-overlapping, increasing magnitude) -----------
function estimate(elen, e) {
  let Q = e[0];
  for (let i = 1; i < elen; i++) Q += e[i];
  return Q;
}

// h = e * b, zero-eliminated. Returns hlen.
function scaleExpansion(elen, e, b, h) {
  let Q = twoProduct(e[0], b);
  let hlen = 0;
  if (_lo !== 0) h[hlen++] = _lo;
  for (let i = 1; i < elen; i++) {
    const product1 = twoProduct(e[i], b),
      product0 = _lo;
    const sum = twoSum(Q, product0);
    if (_lo !== 0) h[hlen++] = _lo;
    Q = fastTwoSum(product1, sum);
    if (_lo !== 0) h[hlen++] = _lo;
  }
  if (Q !== 0 || hlen === 0) h[hlen++] = Q;
  return hlen;
}

// h = e + f, zero-eliminated (fast_expansion_sum_zeroelim). Returns hlen.
function expansionSum(elen, e, flen, f, h) {
  let enow = e[0],
    fnow = f[0];
  let eindex = 0,
    findex = 0;
  let Q;
  if (fnow > enow === fnow > -enow) {
    Q = enow;
    enow = e[++eindex];
  } else {
    Q = fnow;
    fnow = f[++findex];
  }
  let hlen = 0;
  if (eindex < elen && findex < flen) {
    if (fnow > enow === fnow > -enow) {
      Q = fastTwoSum(enow, Q);
      enow = e[++eindex];
    } else {
      Q = fastTwoSum(fnow, Q);
      fnow = f[++findex];
    }
    if (_lo !== 0) h[hlen++] = _lo;
    while (eindex < elen && findex < flen) {
      if (fnow > enow === fnow > -enow) {
        Q = twoSum(Q, enow);
        enow = e[++eindex];
      } else {
        Q = twoSum(Q, fnow);
        fnow = f[++findex];
      }
      if (_lo !== 0) h[hlen++] = _lo;
    }
  }
  while (eindex < elen) {
    Q = twoSum(Q, enow);
    enow = e[++eindex];
    if (_lo !== 0) h[hlen++] = _lo;
  }
  while (findex < flen) {
    Q = twoSum(Q, fnow);
    fnow = f[++findex];
    if (_lo !== 0) h[hlen++] = _lo;
  }
  if (Q !== 0 || hlen === 0) h[hlen++] = Q;
  return hlen;
}

// ---- generic expansion product ---------------------------------------------
// h = e * f, exactly. Shewchuk gives a specialized routine per predicate; this is the general
// form (scale e by each word of f and sum), which is O(elen*flen) but needs no bespoke code per
// determinant. It is only reached by incircle's rare final level, where clarity
// is preferable to a hand-fused special case.
const _mA = new Float64Array(2048),
  _mB = new Float64Array(2048),
  _mS = new Float64Array(2048);
function expMul(elen, e, flen, f, h) {
  let alen = 0; // accumulator in _mA
  for (let i = 0; i < flen; i++) {
    const slen = scaleExpansion(elen, e, f[i], _mS);
    alen = expansionSum(alen === 0 ? 1 : alen, alen === 0 ? _zero : _mA, slen, _mS, _mB);
    for (let k = 0; k < alen; k++) _mA[k] = _mB[k];
  }
  for (let k = 0; k < alen; k++) h[k] = _mA[k];
  return alen;
}
const _zero = new Float64Array([0]);
function expNeg(elen, e, h) {
  for (let i = 0; i < elen; i++) h[i] = -e[i];
  return elen;
}

// Exact lifted in-circle determinant, in expansions. Returns the SIGN.
//   | ax ay ax²+ay² |
//   | bx by bx²+by² |   with (ax,ay) = a - d, etc.
//   | cx cy cx²+cy² |
// Expansions are non-overlapping and increasing in magnitude, so the LAST word carries the sign.
const _ex = [
  new Float64Array(2),
  new Float64Array(2),
  new Float64Array(2),
  new Float64Array(2),
  new Float64Array(2),
  new Float64Array(2),
];
const _t1 = new Float64Array(2048),
  _t2 = new Float64Array(2048),
  _t3 = new Float64Array(2048);
const _lift = new Float64Array(2048),
  _minor = new Float64Array(2048);
const _acc = new Float64Array(4096),
  _acc2 = new Float64Array(4096);
function exactDiff2(a, b, out) {
  const hi = twoDiff(a, b);
  out[0] = _lo;
  out[1] = hi;
  return out[1] === 0 && out[0] === 0 ? 1 : 2;
}

function incircleExactExpansion(pa, pb, pc, pd) {
  const axl = exactDiff2(pa[0], pd[0], _ex[0]),
    ayl = exactDiff2(pa[1], pd[1], _ex[1]);
  const bxl = exactDiff2(pb[0], pd[0], _ex[2]),
    byl = exactDiff2(pb[1], pd[1], _ex[3]);
  const cxl = exactDiff2(pc[0], pd[0], _ex[4]),
    cyl = exactDiff2(pc[1], pd[1], _ex[5]);
  const AX = _ex[0],
    AY = _ex[1],
    BX = _ex[2],
    BY = _ex[3],
    CX = _ex[4],
    CY = _ex[5];

  let acclen = 0;
  // term(lift of P, minor of the other two) accumulated into _acc
  const addTerm = (px, pxl, py, pyl, qx, qxl, qy, qyl, rx, rxl, ry, ryl) => {
    // lift = px² + py²
    const l1 = expMul(pxl, px, pxl, px, _t1);
    const l2 = expMul(pyl, py, pyl, py, _t2);
    const liftlen = expansionSum(l1, _t1, l2, _t2, _lift);
    // minor = qx*ry - qy*rx
    const m1 = expMul(qxl, qx, ryl, ry, _t1);
    const m2 = expMul(qyl, qy, rxl, rx, _t2);
    const m2n = expNeg(m2, _t2, _t3);
    const minorlen = expansionSum(m1, _t1, m2n, _t3, _minor);
    // acc += lift * minor
    const plen = expMul(liftlen, _lift, minorlen, _minor, _t1);
    acclen = expansionSum(acclen === 0 ? 1 : acclen, acclen === 0 ? _zero : _acc, plen, _t1, _acc2);
    for (let k = 0; k < acclen; k++) _acc[k] = _acc2[k];
  };
  addTerm(AX, axl, AY, ayl, BX, bxl, BY, byl, CX, cxl, CY, cyl); // +alift*(bx*cy - by*cx)
  addTerm(BX, bxl, BY, byl, CX, cxl, CY, cyl, AX, axl, AY, ayl); // +blift*(cx*ay - cy*ax)
  addTerm(CX, cxl, CY, cyl, AX, axl, AY, ayl, BX, bxl, BY, byl); // +clift*(ax*by - ay*bx)

  const top = _acc[acclen - 1];
  return top > 0 ? 1 : top < 0 ? -1 : 0;
}

// ---- scratch (module-level: allocation-free in steady state) ----------------
const _B = new Float64Array(4),
  _u = new Float64Array(4);
const _C1 = new Float64Array(8),
  _C2 = new Float64Array(12),
  _D = new Float64Array(16);
const _bc = new Float64Array(4),
  _ca = new Float64Array(4),
  _ab = new Float64Array(4);
const _axbc = new Float64Array(8),
  _axxbc = new Float64Array(16);
const _aybc = new Float64Array(8),
  _ayybc = new Float64Array(16),
  _adet = new Float64Array(32);
const _bxca = new Float64Array(8),
  _bxxca = new Float64Array(16);
const _byca = new Float64Array(8),
  _byyca = new Float64Array(16),
  _bdet = new Float64Array(32);
const _cxab = new Float64Array(8),
  _cxxab = new Float64Array(16);
const _cyab = new Float64Array(8),
  _cyyab = new Float64Array(16),
  _cdet = new Float64Array(32);
const _abdet = new Float64Array(64),
  _fin = new Float64Array(96);

/**
 * Exact-sign 2D orientation of point arrays a, b, c.
 * > 0 if a,b,c counterclockwise, < 0 clockwise, 0 collinear (cdt.js convention).
 */
export function orient2d(a, b, c) {
  return orient2dXY(a[0], a[1], b[0], b[1], c[0], c[1]);
}

/**
 * orient2d on raw coordinates. Identical numerics — orient2d delegates here, so there is one
 * filter, not two that could drift apart. Callers holding points in flat typed arrays (cdt.js's
 * delaunay) use this to avoid materializing an [x,y] pair per predicate call; at ~10⁶ calls/sec
 * on a streamed build those pairs were pure garbage.
 */
export function orient2dXY(ax, ay, bx, by, cx, cy) {
  predicateStats.orient2d++;
  const detleft = (ay - cy) * (bx - cx);
  const detright = (ax - cx) * (by - cy);
  const det = detleft - detright; // CW-positive; negate for CCW
  // Opposite-signed products cannot catastrophically cancel → sign is reliable.
  if (detleft === 0 || detright === 0 || detleft > 0 !== detright > 0) return -det;
  const detsum = Math.abs(detleft + detright);
  if (Math.abs(det) >= ccwerrboundA * detsum) return -det;
  // orient2dAdapt returns the CCW-POSITIVE determinant (Shewchuk's orientation), which is what
  // this function returns. The filter above computes the CW-positive one and negates it. Do NOT
  // negate the adaptive result too — that inverts every orientation the filter could not decide.
  return orient2dAdapt(ax, ay, bx, by, cx, cy, detsum);
}

// Returns the CCW-positive determinant, sign-exact: acx*bcy - acy*bcx.
function orient2dAdapt(ax, ay, bx, by, cx, cy, detsum) {
  predicateStats.orient2dAdapt++;
  const acx = ax - cx,
    bcx = bx - cx,
    acy = ay - cy,
    bcy = by - cy;

  const dl1 = twoProduct(acx, bcy),
    dl0 = _lo;
  const dr1 = twoProduct(acy, bcx),
    dr0 = _lo;
  twoTwoDiff(dl1, dl0, dr1, dr0, _B);

  let det = estimate(4, _B);
  if (Math.abs(det) >= ccwerrboundB * detsum) return det;

  // exact tails of the input differences
  twoDiff(ax, cx);
  const acxtail = _lo;
  twoDiff(bx, cx);
  const bcxtail = _lo;
  twoDiff(ay, cy);
  const acytail = _lo;
  twoDiff(by, cy);
  const bcytail = _lo;
  if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0) return det; // B was exact

  const errbound = ccwerrboundC * detsum + resulterrbound * Math.abs(det);
  det += acx * bcytail + bcy * acxtail - (acy * bcxtail + bcx * acytail);
  if (Math.abs(det) >= errbound) return det;

  predicateStats.orient2dExact++;
  let s1 = twoProduct(acxtail, bcy),
    s0 = _lo;
  let t1 = twoProduct(acytail, bcx),
    t0 = _lo;
  twoTwoDiff(s1, s0, t1, t0, _u);
  const c1len = expansionSum(4, _B, 4, _u, _C1);

  s1 = twoProduct(acx, bcytail);
  s0 = _lo;
  t1 = twoProduct(acy, bcxtail);
  t0 = _lo;
  twoTwoDiff(s1, s0, t1, t0, _u);
  const c2len = expansionSum(c1len, _C1, 4, _u, _C2);

  s1 = twoProduct(acxtail, bcytail);
  s0 = _lo;
  t1 = twoProduct(acytail, bcxtail);
  t0 = _lo;
  twoTwoDiff(s1, s0, t1, t0, _u);
  const dlen = expansionSum(c2len, _C2, 4, _u, _D);

  return _D[dlen - 1]; // most significant word carries the sign
}

/**
 * Exact-sign in-circle test.
 * > 0 if d is strictly inside the circumcircle of CCW triangle abc, < 0 outside,
 * 0 cocircular (cdt.js convention).
 */
export function incircle(a, b, c, d) {
  return incircleXY(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]);
}

/**
 * incircle on raw coordinates — see orient2dXY. The fast filter (which decides ~99.9% of calls)
 * is allocation-free here. Only the adaptive path materializes [x,y] pairs, to reuse
 * incircleAdapt unchanged: it runs ~1 call in 800, so the pairs cost nothing measurable and
 * keeping ONE adaptive implementation matters more than shaving them.
 */
export function incircleXY(ax, ay, bx, by, cx, cy, dx, dy) {
  predicateStats.incircle++;
  const adx = ax - dx,
    ady = ay - dy;
  const bdx = bx - dx,
    bdy = by - dy;
  const cdx = cx - dx,
    cdy = cy - dy;

  const bdxcdy = bdx * cdy,
    cdxbdy = cdx * bdy;
  const cdxady = cdx * ady,
    adxcdy = adx * cdy;
  const adxbdy = adx * bdy,
    bdxady = bdx * ady;
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;

  const det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * blift +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
  if (Math.abs(det) > iccerrboundA * permanent) return det;
  return incircleAdapt([ax, ay], [bx, by], [cx, cy], [dx, dy], permanent);
}

function incircleAdapt(pa, pb, pc, pd, permanent) {
  predicateStats.incircleAdapt++;
  const adx = pa[0] - pd[0],
    bdx = pb[0] - pd[0],
    cdx = pc[0] - pd[0];
  const ady = pa[1] - pd[1],
    bdy = pb[1] - pd[1],
    cdy = pc[1] - pd[1];

  // A-level in expansions: |bc|·(adx²+ady²) + |ca|·(bdx²+bdy²) + |ab|·(cdx²+cdy²)
  let p1 = twoProduct(bdx, cdy),
    p0 = _lo;
  let q1 = twoProduct(cdx, bdy),
    q0 = _lo;
  twoTwoDiff(p1, p0, q1, q0, _bc);
  let l = scaleExpansion(4, _bc, adx, _axbc);
  const axxbclen = scaleExpansion(l, _axbc, adx, _axxbc);
  l = scaleExpansion(4, _bc, ady, _aybc);
  const ayybclen = scaleExpansion(l, _aybc, ady, _ayybc);
  const alen = expansionSum(axxbclen, _axxbc, ayybclen, _ayybc, _adet);

  p1 = twoProduct(cdx, ady);
  p0 = _lo;
  q1 = twoProduct(adx, cdy);
  q0 = _lo;
  twoTwoDiff(p1, p0, q1, q0, _ca);
  l = scaleExpansion(4, _ca, bdx, _bxca);
  const bxxcalen = scaleExpansion(l, _bxca, bdx, _bxxca);
  l = scaleExpansion(4, _ca, bdy, _byca);
  const byycalen = scaleExpansion(l, _byca, bdy, _byyca);
  const blen = expansionSum(bxxcalen, _bxxca, byycalen, _byyca, _bdet);

  p1 = twoProduct(adx, bdy);
  p0 = _lo;
  q1 = twoProduct(bdx, ady);
  q0 = _lo;
  twoTwoDiff(p1, p0, q1, q0, _ab);
  l = scaleExpansion(4, _ab, cdx, _cxab);
  const cxxablen = scaleExpansion(l, _cxab, cdx, _cxxab);
  l = scaleExpansion(4, _ab, cdy, _cyab);
  const cyyablen = scaleExpansion(l, _cyab, cdy, _cyyab);
  const clen = expansionSum(cxxablen, _cxxab, cyyablen, _cyyab, _cdet);

  const ablen = expansionSum(alen, _adet, blen, _bdet, _abdet);
  const finlen = expansionSum(ablen, _abdet, clen, _cdet, _fin);

  let det = estimate(finlen, _fin);
  if (Math.abs(det) >= iccerrboundB * permanent) return det;

  twoDiff(pa[0], pd[0]);
  const adxtail = _lo;
  twoDiff(pa[1], pd[1]);
  const adytail = _lo;
  twoDiff(pb[0], pd[0]);
  const bdxtail = _lo;
  twoDiff(pb[1], pd[1]);
  const bdytail = _lo;
  twoDiff(pc[0], pd[0]);
  const cdxtail = _lo;
  twoDiff(pc[1], pd[1]);
  const cdytail = _lo;
  // Every input difference was exact ⇒ the expansion above IS the exact determinant.
  if (
    adxtail === 0 &&
    bdxtail === 0 &&
    cdxtail === 0 &&
    adytail === 0 &&
    bdytail === 0 &&
    cdytail === 0
  )
    return det;

  predicateStats.incircleExact++;
  const errbound = iccerrboundC * permanent + resulterrbound * Math.abs(det);
  const abdet_ = adx * bdy - bdx * ady;
  const bcdet_ = bdx * cdy - cdx * bdy;
  const cadet_ = cdx * ady - adx * cdy;
  det +=
    (adx * adx + ady * ady) * (bdx * cdytail + cdy * bdxtail - (bdy * cdxtail + cdx * bdytail)) +
    2 * (adx * adxtail + ady * adytail) * bcdet_ +
    ((bdx * bdx + bdy * bdy) * (cdx * adytail + ady * cdxtail - (cdy * adxtail + adx * cdytail)) +
      2 * (bdx * bdxtail + bdy * bdytail) * cadet_) +
    ((cdx * cdx + cdy * cdy) * (adx * bdytail + bdy * adxtail - (ady * bdxtail + bdx * adytail)) +
      2 * (cdx * cdxtail + cdy * cdytail) * abdet_);
  if (Math.abs(det) >= errbound) return det;

  // Last resort: the same determinant, evaluated exactly in expansions. Reached when all six
  // input tails are nonzero and the C bound fails, such as cocircular points with
  // extreme coordinate ranges. No BigInt and no allocation.
  predicateStats.incircleFull++;
  return incircleExactExpansion(pa, pb, pc, pd);
}
