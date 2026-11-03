// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCubicMath.js — pure cubic/quadratic implicit math: Bezout resultant
// frames, Loop-Blinn klmn classification, inflection/loop analysis, de
// Casteljau subdivision, the shared subdivision plan, and the hull's
// affine texcoord frame. No GL, no module state; used by the partition
// builder, the morph pair transform, and the packer.
import { pointInTri } from './lbEarcut.js';
import { mantleDebugHook } from '../core/diagnostics.js';

// ---- Loop-Blinn klmn cubic implicit (p1000-loop §4.4, integral cubics) ------
// For an INTEGRAL cubic (w=1), the implicit is k³ − l·m (n≡1), where k,l,m are
// AFFINE functions of (x,y) — assigned to the 4 control points as texture
// coords T = M3⁻¹·F and linearly interpolated by the rasterizer. The fragment
// then needs only 3 muls + a sub vs the Bezout det's ~25 ALU.
//   d1 = C2×C3, d2 = C3×C1, d3 = C1×C2  (Ci = xy power-basis coeffs; d0≡0)
//   disc = 3d2²−4d1d3 : >0 serpentine · <0 loop · ≈0 cusp
// Returns {k,l,m} (per-control-point, length 4) for serpentine/loop, or null
// for the degenerate cases (cusp, d1≈0) so the caller keeps the exact Bezout.
// The keep-side sign is resolved by the caller (cubicSignKLMN), same as Bezout.
const _cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const _m3inv = (f) => [
  f[0],
  f[0] + f[1] / 3,
  f[0] + (2 * f[1]) / 3 + f[2] / 3,
  f[0] + f[1] + f[2] + f[3],
];

// ---- exact cubic implicit (Bezout resultant, normalized frame) -------------
/// `sFixed` overrides the conditioning scale.
///
/// `s` is a MAX of absolute values, so as the control points move it kinks — both where the abs
/// turns and where a different point takes over the max — and every coefficient here is divided
/// by it. That is what stops a morphing curve's implicit from being a polynomial in t: with s
/// frozen, cx and cy are the centroid (linear in t), the Bezout entries are degree <= 2, and the
/// packed coefficients come out degree 2 exactly. s is pure conditioning — any positive value is
/// correct — so freezing it for the span of a morph segment costs nothing and buys that.
export function bezoutCubicImplicit(P, sFixed) {
  const cx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4,
    cy = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;

  let s = 0;
  for (const p of P) s = Math.max(s, Math.abs(p[0] - cx), Math.abs(p[1] - cy));
  if (sFixed > 0) s = sFixed;
  if (!(s > 0)) return null;
  const X = P.map((p) => (p[0] - cx) / s),
    Y = P.map((p) => (p[1] - cy) / s);
  const Xm = [
    X[0],
    -3 * X[0] + 3 * X[1],
    3 * X[0] - 6 * X[1] + 3 * X[2],
    -X[0] + 3 * X[1] - 3 * X[2] + X[3],
  ];
  const Ym = [
    Y[0],
    -3 * Y[0] + 3 * Y[1],
    3 * Y[0] - 6 * Y[1] + 3 * Y[2],
    -Y[0] + 3 * Y[1] - 3 * Y[2] + Y[3],
  ];
  const br = (i, j) => Xm[i] * Ym[j] - Xm[j] * Ym[i];
  const b03 = br(0, 3),
    b12 = br(1, 2);
  return {
    cx,
    cy,
    s,
    m00: { a: -br(0, 1), b: Ym[1], c: -Xm[1] },
    m01: { a: -br(0, 2), b: Ym[2], c: -Xm[2] },
    m02: { a: -b03, b: Ym[3], c: -Xm[3] },
    m11a: -b03 - b12, // m11 shares (b,c) with m02
    m12: -br(1, 3),
    m22: -br(2, 3),
  };
}

export function evalBezout(F, px, py) {
  const x = (px - F.cx) / F.s,
    y = (py - F.cy) / F.s;
  const M00 = F.m00.a + F.m00.b * x + F.m00.c * y,
    M01 = F.m01.a + F.m01.b * x + F.m01.c * y,
    M02 = F.m02.a + F.m02.b * x + F.m02.c * y;
  const M11 = F.m11a + F.m02.b * x + F.m02.c * y;
  return (
    M00 * (M11 * F.m22 - F.m12 * F.m12) -
    M01 * (M01 * F.m22 - F.m12 * M02) +
    M02 * (M01 * F.m12 - M11 * M02)
  );
}

/// The conditioning scale cubicKLMN divides its d's by — a sum of absolute values, so it kinks
/// as the control points move. Frozen across a morph segment for the same reason as
/// bezoutCubicImplicit's `s`; see there.
export function cubicDScale(P) {
  const b0 = P[0],
    b1 = P[1],
    b2 = P[2],
    b3 = P[3];
  const C1 = [-3 * b0[0] + 3 * b1[0], -3 * b0[1] + 3 * b1[1]];
  const C2 = [3 * b0[0] - 6 * b1[0] + 3 * b2[0], 3 * b0[1] - 6 * b1[1] + 3 * b2[1]];
  const C3 = [-b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0], -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1]];
  // No additive floor, for the same reason cubicKLMN's `scale` has none: these are cross products
  // of difference vectors, so they carry the square of the drawing's scale and a constant term
  // takes over below unit size.
  return Math.abs(_cross2(C2, C3)) + Math.abs(_cross2(C3, C1)) + Math.abs(_cross2(C1, C2));
}

/// `scaleFixed` overrides the conditioning scale the d's are divided by; see cubicDScale. The
/// Degeneracy tests keep using the live scale — they decide which derivation a curve gets, and a
/// stale answer to that is a wrong implicit, not a differently-scaled one.
export function cubicKLMN(P, scaleFixed) {
  const b0 = P[0],
    b1 = P[1],
    b2 = P[2],
    b3 = P[3];
  const C1 = [-3 * b0[0] + 3 * b1[0], -3 * b0[1] + 3 * b1[1]];
  const C2 = [3 * b0[0] - 6 * b1[0] + 3 * b2[0], 3 * b0[1] - 6 * b1[1] + 3 * b2[1]];
  const C3 = [-b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0], -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1]];
  let d1 = _cross2(C2, C3),
    d2 = _cross2(C3, C1),
    d3 = _cross2(C1, C2);

  const scale = Math.abs(d1) + Math.abs(d2) + Math.abs(d3);
  if (!(scale > 0)) return null;
  const disc0 = 3 * d2 * d2 - 4 * d1 * d3;
  // DECLINE TO BEZOUT ON THE PRECISION OF THE INPUT, not on float64's. Curves reach here from a
  // Float32Array, so every control point carries ~6e-8 of relative error before d1/d2/d3 are
  // formed -- and those are differences of nearly equal products, so the cancellation amplifies
  // it by orders. A cubic whose |d1|/scale is 1e-5 passes a 1e-7 test with a d1 that is mostly
  // rounding, and cubicKLMN then returns an implicit that is not merely noisy but WRONG; the
  // converter sees real violations of it and cuts against them.

  const KLMN_MIN = mantleDebugHook('__LB_KLMN_MIN') > 0 ? mantleDebugHook('__LB_KLMN_MIN') : 1e-3;

  const d1Bar = KLMN_MIN * scale;
  const discBar = KLMN_MIN * 10 * scale * scale;
  if (Math.abs(d1) < d1Bar || Math.abs(disc0) < discBar) return null;
  const cond = scaleFixed > 0 ? scaleFixed : scale;
  // Normalize d's to O(1) before cubing — k³−lm is scale-invariant, and this
  // keeps the fp32 attributes (and the GPU-recompute path) well-conditioned.
  const inv = 1 / cond;
  d1 *= inv;
  d2 *= inv;
  d3 *= inv;
  const disc = 3 * d2 * d2 - 4 * d1 * d3;
  let k, l, m;
  if (disc > 0) {
    // serpentine
    const r = Math.sqrt(disc / 3),
      tl = d2 + r,
      sl = 2 * d1,
      tm = d2 - r,
      sm = 2 * d1;
    k = _m3inv([tl * tm, -sm * tl - sl * tm, sl * sm, 0]);
    l = _m3inv([tl * tl * tl, -3 * sl * tl * tl, 3 * sl * sl * tl, -sl * sl * sl]);
    m = _m3inv([tm * tm * tm, -3 * sm * tm * tm, 3 * sm * sm * tm, -sm * sm * sm]);
    if (d1 < 0) {
      k = k.map((v) => -v);
      l = l.map((v) => -v);
    } // orientation (α = 32/3·d1³·H, H<0)
  } else {
    // loop
    const r = Math.sqrt(-disc),
      td = d2 + r,
      sd = 2 * d1,
      te = d2 - r,
      se = 2 * d1;
    k = _m3inv([td * te, -se * td - sd * te, sd * se, 0]);
    l = _m3inv([
      td * td * te,
      -se * td * td - 2 * sd * td * te,
      te * sd * sd + 2 * se * sd * td,
      -sd * sd * se,
    ]);
    m = _m3inv([
      td * te * te,
      -sd * te * te - 2 * se * td * te,
      td * se * se + 2 * sd * se * te,
      -sd * se * se,
    ]);
    // orientation handled empirically by cubicSignKLMN (klmn = c·Bezout).
  }
  return { k, l, m };
}

/// A SERPENTINE's klmn frame at ANY d1, including d1 = 0: the point-symmetric S-curve, whose second
/// inflection is at infinity.
///
/// cubicKLMN declines |d1| below a bar, and for a serpentine the bar is not a property of the curve but of its own
/// arithmetic: it writes the two roots of the inflection polynomial d1 x^2 x + d3/3 as (d2 +- r) / (2 d1), and the
/// root taken with the minus sign CANCELS -- as d1 -> 0 it is the difference of two nearly equal numbers divided by
/// nearly zero, and both of its homogeneous coordinates vanish with d1. That is the "collapse". The same root is
/// (2 d3 / 3) / (d2 + r) by the product of the roots, which involves no cancellation and no division by d1: as a
/// homogeneous pair it is (2 d3 / 3, q) with q = d2 + sign r, and the other root is (q, 2 d1). Every coordinate is
/// finite and well conditioned for every d1, and at d1 = 0 the first factor is the constant q -- Loop-Blinn's
/// inflection-at-infinity row, as the limit of the serpentine rather than a separate case. Same rows as cubicKLMN up to
/// a positive factor wherever that one answers (k, l negated for d2 < 0, where the roots trade places), so a morph pair
/// may read one pose from each. Exact: the rows are affine-consistent over the control points and k^3 - lm vanishes
/// along the curve to float64's last bits, at d1 = 0 as elsewhere.
///
/// The DISCRIMINANT bar stays: two merged roots are a cusp, which this row does not describe. Loops go to cubicKLMN.
export function cubicKLMNSerpentine(P, scaleFixed) {
  const b0 = P[0],
    b1 = P[1],
    b2 = P[2],
    b3 = P[3];
  const C1 = [-3 * b0[0] + 3 * b1[0], -3 * b0[1] + 3 * b1[1]];
  const C2 = [3 * b0[0] - 6 * b1[0] + 3 * b2[0], 3 * b0[1] - 6 * b1[1] + 3 * b2[1]];
  const C3 = [-b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0], -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1]];
  let d1 = _cross2(C2, C3),
    d2 = _cross2(C3, C1),
    d3 = _cross2(C1, C2);
  const scale = Math.abs(d1) + Math.abs(d2) + Math.abs(d3);
  if (!(scale > 0)) return null;
  const KLMN_MIN = mantleDebugHook('__LB_KLMN_MIN') > 0 ? mantleDebugHook('__LB_KLMN_MIN') : 1e-3;
  if (Math.abs(3 * d2 * d2 - 4 * d1 * d3) < KLMN_MIN * 10 * scale * scale) return null;
  const inv = 1 / (scaleFixed > 0 ? scaleFixed : scale);
  d1 *= inv;
  d2 *= inv;
  d3 *= inv;
  const disc = 3 * d2 * d2 - 4 * d1 * d3;
  if (!(disc > 0)) return null;
  const r = Math.sqrt(disc / 3),
    q = d2 >= 0 ? d2 + r : d2 - r;
  const tl = q,
    sl = 2 * d1,
    tm = (2 * d3) / 3,
    sm = q;
  let k = _m3inv([tl * tm, -sm * tl - sl * tm, sl * sm, 0]);
  let l = _m3inv([tl * tl * tl, -3 * sl * tl * tl, 3 * sl * sl * tl, -sl * sl * sl]);
  const m = _m3inv([tm * tm * tm, -3 * sm * tm * tm, 3 * sm * sm * tm, -sm * sm * sm]);
  if (d2 < 0) {
    k = k.map((v) => -v);
    l = l.map((v) => -v);
  }
  return { k, l, m };
}

// Affine reconstruction of a klmn channel (values at the 4 control points are
// affine-consistent) → evaluate at an arbitrary (x,y). Solves A+Bx+Cy through
// control points 0,1,2 (the hull's base triangle).
export function affineEval(vals, P, x, y) {
  const p0 = P[0],
    p1 = P[1],
    p2 = P[2];
  const det = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);

  const e1x = p0[0] - p2[0],
    e1y = p0[1] - p2[1],
    e2x = p1[0] - p2[0],
    e2y = p1[1] - p2[1];
  if (!(Math.abs(det) > 1e-12 * Math.sqrt((e1x * e1x + e1y * e1y) * (e2x * e2x + e2y * e2y))))
    return vals[0];
  const wa = ((p1[1] - p2[1]) * (x - p2[0]) + (p2[0] - p1[0]) * (y - p2[1])) / det;
  const wb = ((p2[1] - p0[1]) * (x - p2[0]) + (p0[0] - p2[0]) * (y - p2[1])) / det;
  return wa * vals[0] + wb * vals[1] + (1 - wa - wb) * vals[2];
}

// Keep-side sign for the klmn implicit, tied to convex/concave (mirrors
// cubicSign): keep the crescent side (exterior of the chord for convex).
export function cubicSignKLMN(P, klmn, concave) {
  const cm = cubicPt(P, 0.5);
  const chordMid = [(P[0][0] + P[3][0]) / 2, (P[0][1] + P[3][1]) / 2];
  const ctrlMid = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
  const ref = concave
    ? [(cm[0] + ctrlMid[0]) / 2, (cm[1] + ctrlMid[1]) / 2]
    : [(cm[0] + chordMid[0]) / 2, (cm[1] + chordMid[1]) / 2];
  // The klmn (k,l,m) are interpolated linearly across the RENDERED hull triangle,
  // so f=k³−lm must be evaluated with the barycentric basis of the same triangle
  // — NOT a fixed P[0..2]. The hull is P[hull[…]] (3 pts, or a 4-pt quad split
  // into [0,1,2]+[0,2,3]); pick the sub-triangle containing ref. Using the wrong
  // basis (e.g. when a control point is INSIDE the hull, so hull≠[0,1,2]) flips
  // the sign for concave / S-curve cubics and over- or under-fills CFF glyphs.
  const h = cubicHull(P);
  const tris =
    h.length === 3
      ? [[h[0], h[1], h[2]]]
      : [
          [h[0], h[1], h[2]],
          [h[0], h[2], h[3]],
        ];
  let t = tris[0];
  for (const tr of tris)
    if (pointInTri(ref, P[tr[0]], P[tr[1]], P[tr[2]])) {
      t = tr;
      break;
    }
  const HP = [P[t[0]], P[t[1]], P[t[2]]];
  const K = affineEval([klmn.k[t[0]], klmn.k[t[1]], klmn.k[t[2]]], HP, ref[0], ref[1]);
  const L = affineEval([klmn.l[t[0]], klmn.l[t[1]], klmn.l[t[2]]], HP, ref[0], ref[1]);
  const M = affineEval([klmn.m[t[0]], klmn.m[t[1]], klmn.m[t[2]]], HP, ref[0], ref[1]);
  return -Math.sign(K * K * K - L * M);
}

export function quadRoots01(a, b, c, rel = false) {
  const m = rel
    ? Math.abs(a) + Math.abs(b) + Math.abs(c)
    : Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  const out = [];
  if (Math.abs(a) < 1e-12 * m) {
    if (Math.abs(b) > 1e-12 * m) {
      const t = -c / b;
      if (t > 1e-6 && t < 1 - 1e-6) out.push(t);
    }
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)])
    if (t > 1e-6 && t < 1 - 1e-6) out.push(t);
  return out;
}

// inflection params: B'(t)×B''(t)=0 → 3(c2×c3)t² + 3(c1×c3)t + (c1×c2)=0.
export function cubicInflections(P, rel = false) {
  const ax = -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0],
    bx = 3 * P[0][0] - 6 * P[1][0] + 3 * P[2][0],
    cx = -3 * P[0][0] + 3 * P[1][0];
  const ay = -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
    by = 3 * P[0][1] - 6 * P[1][1] + 3 * P[2][1],
    cy = -3 * P[0][1] + 3 * P[1][1];
  const A2 = bx * ay - by * ax,
    A1 = cx * ay - cy * ax,
    A0 = cx * by - cy * bx;
  return quadRoots01(3 * A2, 3 * A1, A0, rel).sort((u, v) => u - v);
}

// self-intersection (loop) within [0,1]: solve B(s)=B(t), s≠t. Returns the two
// interior double-point parameters { lo, hi } (lo<hi), or null if the cubic is
// loop-free. Splitting the cubic at lo AND hi yields three simple (non-self-
// intersecting) pieces — the tails [0,lo], [hi,1] and the loop body [lo,hi] —
// each of which the ordinary klmn/Bezout crescent + CDT winding renders exactly.
// `rel`: the parallel test (denom = c3 x c2, a length squared) is judged against |c3| |c2| -- a sine under 1e-9 --
// instead of an absolute 1e-9, which declared every loop on art under ~3e-5 across loop-free. Default: the absolute test.
export function cubicLoopParams(P, rel = false) {
  const c1 = [3 * (P[1][0] - P[0][0]), 3 * (P[1][1] - P[0][1])];
  const c2 = [3 * (P[0][0] - 2 * P[1][0] + P[2][0]), 3 * (P[0][1] - 2 * P[1][1] + P[2][1])];
  const c3 = [
    -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0],
    -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
  ];
  const denom = c3[1] * c2[0] - c3[0] * c2[1];

  if (
    !(Math.abs(denom) > (rel ? 1e-9 : 1e-12) * Math.hypot(c3[0], c3[1]) * Math.hypot(c2[0], c2[1]))
  )
    return null;
  const p = (c3[0] * c1[1] - c3[1] * c1[0]) / denom;
  const useX = Math.abs(c3[0]) >= Math.abs(c3[1]);
  const r = useX ? -(c2[0] * p + c1[0]) / c3[0] : -(c2[1] * p + c1[1]) / c3[1];
  const q = p * p - r,
    discST = p * p - 4 * q;
  if (discST < 0) return null;
  const sq = Math.sqrt(discST),
    s = (p + sq) / 2,
    t = (p - sq) / 2;
  const inSpan = (v) => v > 1e-4 && v < 1 - 1e-4;
  if (inSpan(s) && inSpan(t) && Math.abs(s - t) > 1e-3)
    return { lo: Math.min(s, t), hi: Math.max(s, t) };
  if (discST < 1e-6 && inSpan(p / 2)) {
    const m = p / 2;
    return { lo: m, hi: m };
  }
  return null;
}

export function cubicLoop(P) {
  return !!cubicLoopParams(P);
}

/// The CUSP parameter, when the segment has one in span.

/// A cusp is where the derivative VANISHES, so this minimizes |B'(t)|^2 -- a quartic, whose
/// stationary points are the roots of a cubic -- and accepts the minimum only when the tangent
/// there is negligible against the segment's own scale, which is what distinguishes a cusp from
/// an ordinary slow point.
export function cubicCuspCuts(P) {
  const dx = [3 * (P[1][0] - P[0][0]), 3 * (P[2][0] - P[1][0]), 3 * (P[3][0] - P[2][0])];
  const dy = [3 * (P[1][1] - P[0][1]), 3 * (P[2][1] - P[1][1]), 3 * (P[3][1] - P[2][1])];

  const dAt = (t) => {
    const u = 1 - t;
    const x = u * u * dx[0] + 2 * u * t * dx[1] + t * t * dx[2];
    const y = u * u * dy[0] + 2 * u * t * dy[1] + t * t * dy[2];
    return x * x + y * y;
  };
  let bt = -1,
    bv = Infinity;
  for (let i = 1; i < 64; i++) {
    const t = i / 64,
      v = dAt(t);
    if (v < bv) {
      bv = v;
      bt = t;
    }
  }
  if (bt < 0) return [];
  let lo = Math.max(1e-4, bt - 1 / 64),
    hi = Math.min(1 - 1e-4, bt + 1 / 64);
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3,
      m2 = hi - (hi - lo) / 3;
    if (dAt(m1) < dAt(m2)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  if (!(t > 1e-4 && t < 1 - 1e-4)) return [];
  // Scale: the control polygon's own length. A true cusp has a tangent orders below it.
  const L =
    Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) +
    Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]) +
    Math.hypot(P[3][0] - P[2][0], P[3][1] - P[2][1]);
  return Math.sqrt(dAt(t)) < 1e-3 * L ? [t] : [];
}

// IN-SPAN double-point parameters — the cuts Loop-Blinn 2005 requires.

export function cubicLoopCuts(P) {
  const C1 = [3 * (P[1][0] - P[0][0]), 3 * (P[1][1] - P[0][1])];
  const C2 = [3 * (P[0][0] - 2 * P[1][0] + P[2][0]), 3 * (P[0][1] - 2 * P[1][1] + P[2][1])];
  const C3 = [
    -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0],
    -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
  ];
  const d1 = _cross2(C2, C3),
    d2 = _cross2(C3, C1),
    d3 = _cross2(C1, C2);
  // No additive floor (a constant such as 1e-12 would dominate the d's -- squares of the drawing's
  // scale -- below a few units); all three zero is a line, which has no double point.
  const scale = Math.abs(d1) + Math.abs(d2) + Math.abs(d3);
  if (!(scale > 0)) return [];
  if (Math.abs(d1) < 1e-7 * scale) return []; // cusp/degenerate: cubicKLMN bails anyway
  const disc = 3 * d2 * d2 - 4 * d1 * d3;
  if (!(disc < 0)) return []; // serpentine, no double point
  const r = Math.sqrt(-disc);
  const out = [];
  for (const v of [(d2 + r) / (2 * d1), (d2 - r) / (2 * d1)])
    if (v > 1e-4 && v < 1 - 1e-4) out.push(v);
  return out.sort((a, b) => a - b);
}

export function splitCubic(P, t) {
  const L = (A, B) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  const ab = L(P[0], P[1]),
    bc = L(P[1], P[2]),
    cd = L(P[2], P[3]),
    abc = L(ab, bc),
    bcd = L(bc, cd),
    m = L(abc, bcd);
  return [
    [P[0], ab, abc, m],
    [m, bcd, cd, P[3]],
  ];
}

export function splitCubicMulti(P, ts) {
  const out = [];
  let cur = P,
    last = 0;
  for (const t of ts) {
    const lt = (t - last) / (1 - last);
    if (lt <= 1e-6 || lt >= 1 - 1e-6) continue;
    const [l, r] = splitCubic(cur, lt);
    out.push(l);
    cur = r;
    last = t;
  }
  out.push(cur);
  return out;
}

/// The cross-chord strip of a cubic: its chord's unit normal, and the curve's exact support either
/// side of the chord's own line. Returns [nx, ny, lo, hi], or null for a degenerate chord.

/// The support is exact, not the control-point bound: the functional along the cubic is a Bernstein
/// cubic, so its extremes are at the ends or at a root of the derivative, which is a quadratic.
export function cubicChordStrip(P) {
  const ax = P[3][0] - P[0][0],
    ay = P[3][1] - P[0][1];
  const L = Math.hypot(ax, ay);
  if (!(L > 0)) return null;
  const nx = -ay / L,
    ny = ax / L;
  const b0 = nx * P[0][0] + ny * P[0][1],
    b1 = nx * P[1][0] + ny * P[1][1];
  const b2 = nx * P[2][0] + ny * P[2][1],
    b3 = nx * P[3][0] + ny * P[3][1];
  const at = (t) => {
    const u = 1 - t;
    return u * u * u * b0 + 3 * u * u * t * b1 + 3 * u * t * t * b2 + t * t * t * b3;
  };
  let lo = Math.min(b0, b3),
    hi = Math.max(b0, b3);
  // B'(t) = 0, in the power basis. Relative degeneracy tests: these coefficients carry the
  // coordinate scale, so a fixed floor would be a different question at every drawing size.
  const A = 3 * (-b0 + 3 * b1 - 3 * b2 + b3),
    B = 6 * (b0 - 2 * b1 + b2),
    C = 3 * (b1 - b0);
  const mag = Math.abs(A) + Math.abs(B) + Math.abs(C);
  const roots = [];
  if (Math.abs(A) > 1e-12 * mag) {
    const D = B * B - 4 * A * C;
    if (D >= 0) {
      const sq = Math.sqrt(D);
      roots.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
    }
  } else if (Math.abs(B) > 1e-12 * mag) roots.push(-C / B);
  for (const t of roots) {
    if (!(t > 0 && t < 1)) continue;
    const v = at(t);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // ...and the CHORD's own offset, so a caller can tell which side the arc departs on.
  return [nx, ny, lo, hi, b0];
}

/// The support of a cubic ARC along a direction: max over t in [0, 1] of n . B(t) -- the endpoints and the in-span roots
/// of n . B'(t), as cubicChordStrip takes them. Exact up to floating point; `n` need not be a unit vector.
export function cubicSupport9(P, nx, ny) {
  const b0 = nx * P[0][0] + ny * P[0][1],
    b1 = nx * P[1][0] + ny * P[1][1];
  const b2 = nx * P[2][0] + ny * P[2][1],
    b3 = nx * P[3][0] + ny * P[3][1];
  let hi = Math.max(b0, b3);
  const A = 3 * (-b0 + 3 * b1 - 3 * b2 + b3),
    B = 6 * (b0 - 2 * b1 + b2),
    C = 3 * (b1 - b0);
  const mag = Math.abs(A) + Math.abs(B) + Math.abs(C);
  const roots = [];
  if (Math.abs(A) > 1e-12 * mag) {
    const D = B * B - 4 * A * C;
    if (D >= 0) {
      const sq = Math.sqrt(D);
      roots.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
    }
  } else if (Math.abs(B) > 1e-12 * mag) roots.push(-C / B);
  for (const t of roots) {
    if (!(t > 0 && t < 1)) continue;
    const u = 1 - t,
      v = u * u * u * b0 + 3 * u * u * t * b1 + 3 * u * t * t * b2 + t * t * t * b3;
    if (v > hi) hi = v;
  }
  return hi;
}

/// Whether (qx, qy) lies LEFT of the chain the cubic chain kernel integrates (_lbCoverage.glsl cubicChainBoxCov, a Bezout
/// ring's region): the arc P[0] C P[1] C P[2] -> P[3] continued past its ends along its end tangents. Exact up to floating
/// point. The chain and the arc at infinity that turns counterclockwise from its end direction back to its start direction
/// close a curve around the chain's left, whose winding is read along a ray from q -- the ray through the middle of that
/// arc, so neither end ray runs parallel to it: +1 where the ray meets the arc at infinity, and the signed crossings of
/// the two end rays (one division each) and of the cubic (its y-monotone pieces, each crossing bisected in double).
export function cubicChainLeftOf(P, qx, qy) {
  const dir = (p, q1, q2, q3) => {
    // the kernel's cbDirStart / cbDirEnd: a control point on its end hands the tangent on
    for (const q of [q1, q2, q3]) {
      const d = [q[0] - p[0], q[1] - p[1]];
      if (Math.hypot(d[0], d[1]) > 1e-12 * (Math.hypot(p[0], p[1]) + Math.hypot(q[0], q[1])))
        return d;
    }
    return [q3[0] - p[0], q3[1] - p[1]];
  };
  const gA = dir(P[0], P[1], P[2], P[3]),
    gBr = dir(P[3], P[2], P[1], P[0]);
  const tau = 2 * Math.PI,
    aB = Math.atan2(-gBr[1], -gBr[0]),
    aA = Math.atan2(-gA[1], -gA[0]);
  const sweep = (((aA - aB) % tau) + tau) % tau;
  if (!(sweep > 0)) return false; // both ends leave the same way: a hairpin closed only at its mouth, left of nothing
  // Into the frame whose +x is the ray: rotate by -(aB + sweep / 2), q at the origin.
  const th = aB + sweep / 2,
    co = Math.cos(th),
    si = Math.sin(th);
  const R = (x, y) => [co * x + si * y, -si * x + co * y];
  const [A, C1, C2, B] = P.map((p) => R(p[0] - qx, p[1] - qy));
  const g1 = R(gA[0], gA[1]),
    g2 = R(-gBr[0], -gBr[1]);
  let w = 1; // the arc at infinity, met at its middle
  // The start ray, from infinity along -g1 into A, moving along +g1; the end ray from B out along g2.
  if (g1[1] !== 0 && g1[1] < 0 !== A[1] > 0) {
    const s = A[1] / g1[1];
    if (A[0] - s * g1[0] > 0) w += g1[1] > 0 ? 1 : -1;
  }
  if (g2[1] !== 0 && B[1] > 0 !== g2[1] > 0) {
    const s = -B[1] / g2[1];
    if (B[0] + s * g2[0] > 0) w += g2[1] > 0 ? 1 : -1;
  }
  // The cubic, between its y extrema.
  const cy = [
    -A[1] + 3 * C1[1] - 3 * C2[1] + B[1],
    3 * A[1] - 6 * C1[1] + 3 * C2[1],
    3 * (C1[1] - A[1]),
    A[1],
  ];
  const cx = [
    -A[0] + 3 * C1[0] - 3 * C2[0] + B[0],
    3 * A[0] - 6 * C1[0] + 3 * C2[0],
    3 * (C1[0] - A[0]),
    A[0],
  ];
  const ev = (c, t) => ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
  const ts = [0, 1];
  {
    const a = 3 * cy[0],
      b = 2 * cy[1],
      c = cy[2],
      disc = b * b - 4 * a * c;
    if (a !== 0 && disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    } else if (a === 0 && b !== 0) ts.push(-c / b);
  }
  const cuts = ts.filter((t) => t >= 0 && t <= 1).sort((u, v) => u - v);
  for (let k = 0; k + 1 < cuts.length; k++) {
    let t0 = cuts[k],
      t1 = cuts[k + 1];
    const y0 = ev(cy, t0),
      y1 = ev(cy, t1);
    if (y0 > 0 === y1 > 0) continue;
    for (let it = 0; it < 80 && t1 - t0 > 0; it++) {
      const tm = 0.5 * (t0 + t1);
      if (tm <= t0 || tm >= t1) break;
      if (ev(cy, tm) > 0 === y0 > 0) t0 = tm;
      else t1 = tm;
    }
    if (ev(cx, 0.5 * (t0 + t1)) > 0) w += y1 > y0 ? 1 : -1;
  }
  return w !== 0;
}

export function cubicHull(P) {
  for (let i = 0; i < 4; i++) {
    const o = [0, 1, 2, 3].filter((j) => j !== i);
    if (pointInTri(P[i], P[o[0]], P[o[1]], P[o[2]])) return o;
  }
  const cx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4,
    cy = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
  return [0, 1, 2, 3].sort(
    (a, b) => Math.atan2(P[a][1] - cy, P[a][0] - cx) - Math.atan2(P[b][1] - cy, P[b][0] - cx),
  );
}

// PARTITION CUBIC SPLIT PLAN (pure): the t-values buildLoopBlinnPartition subdivides a
// cubic at — inflections first, then fat-turn (tangent turn ≳100°) halving to
// depth 3. Factored out so the morph PAIR builder can apply the same split
// t-values to the destination endpoint (piece-for-piece correspondence) — one
// code path, not a copy. Returns { ts, fatTs } (global t's, sorted; fatTs =
// the non-inflection halvings, whose descendants route straight to Bezout).
/// Roots of a*t^3 + b*t^2 + c*t + d strictly inside (0,1). Trigonometric where all three roots are
/// real, Cardano otherwise -- exact up to floating point, and local so this file keeps its one
/// import. The face proof needs them: along a straight edge a degree-3 implicit is a univariate
/// cubic, so "does f vanish here" is answered outright rather than sampled.
export function rootsInUnit(a, b, c, d) {
  const out = [];
  const push = (t) => {
    if (t > 1e-9 && t < 1 - 1e-9) out.push(t);
  };
  const m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (!(m > 0)) return out;
  if (Math.abs(a) < 1e-14 * m) {
    if (Math.abs(b) < 1e-14 * m) {
      if (Math.abs(c) > 1e-14 * m) push(-d / c);
      return out;
    }
    const disc = c * c - 4 * b * d;
    if (disc < 0) return out;
    const r = Math.sqrt(disc);
    push((-c + r) / (2 * b));
    push((-c - r) / (2 * b));
    return out;
  }
  const b1 = b / a,
    c1 = c / a,
    d1 = d / a;
  const p = c1 - (b1 * b1) / 3,
    q = (2 * b1 * b1 * b1) / 27 - (b1 * c1) / 3 + d1;
  const disc = (q * q) / 4 + (p * p * p) / 27;
  if (disc > 0) {
    const r = Math.sqrt(disc);
    push(Math.cbrt(-q / 2 + r) + Math.cbrt(-q / 2 - r) - b1 / 3);
  } else if (p < 0) {
    const rr = Math.sqrt(-p / 3);
    const ph = Math.acos(Math.max(-1, Math.min(1, (3 * q) / (2 * p * rr))));
    for (let k = 0; k < 3; k++) push(2 * rr * Math.cos((ph - 2 * Math.PI * k) / 3) - b1 / 3);
  } else push(-b1 / 3);
  return out;
}

/// exact CURVE-vs-TRIANGLE, for the face proof's two containment questions: "is another
/// boundary inside this face" and "does this face hold its own arc". Both were answered by
/// SAMPLING -- 33 points a segment and 49 a arc -- which is the one thing this codebase does
/// not allow an analytic question to be answered by, and it is wrong in a way that matters:
/// a curve that dips into a face between two samples is not seen, so a face that carries a
/// second boundary can be proved clean and a face that does hold its arc can be sent down
/// the all-air branch. Sample counts hide it rather than fix it -- the gap is proportional to
/// the sample spacing, so it shrinks and never closes.
///
/// A cubic meets a closed triangle exactly when an endpoint is inside it, or when the curve
/// crosses one of its three edges. Along a straight edge the side function is a univariate
/// cubic in t (the edge's own normal dotted into the curve), so the crossings ARE the roots
/// of that cubic and rootsInUnit answers them outright. A crossing counts only where it lands
/// within the edge's own span, which is one dot product.
const TRI_S_SLACK = 1e-12; // relative to the edge's own length: s is already normalized by it

const _triSide = (P, Q, x, y) => (Q[0] - P[0]) * (y - P[1]) - (Q[1] - P[1]) * (x - P[0]);

/// Closed triangle, same convention as the face proof's own test: a point ON an edge is in.
export function triContainsXY(A, B, C, x, y) {
  const u = _triSide(A, B, x, y),
    v = _triSide(B, C, x, y),
    w = _triSide(C, A, x, y);
  return (u >= 0 && v >= 0 && w >= 0) || (u <= 0 && v <= 0 && w <= 0);
}

const _cubicAt = (cp, t) => {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * cp[0][0] + b * cp[1][0] + c * cp[2][0] + d * cp[3][0],
    a * cp[0][1] + b * cp[1][1] + c * cp[2][1] + d * cp[3][1],
  ];
};

/// t in (0,1) where the cubic crosses edge P->Q, within that edge's span. A degenerate edge is
/// a point, and the endpoint tests already cover a curve that reaches it.
function _edgeCrossTs(cp, P, Q, out) {
  const ex = Q[0] - P[0],
    ey = Q[1] - P[1],
    L2 = ex * ex + ey * ey;
  if (!(L2 > 0)) return;
  const x0 = cp[0][0],
    x1 = cp[1][0],
    x2 = cp[2][0],
    x3 = cp[3][0];
  const y0 = cp[0][1],
    y1 = cp[1][1],
    y2 = cp[2][1],
    y3 = cp[3][1];
  const ax = x3 - 3 * x2 + 3 * x1 - x0,
    bx = 3 * (x2 - 2 * x1 + x0),
    cx = 3 * (x1 - x0);
  const ay = y3 - 3 * y2 + 3 * y1 - y0,
    by = 3 * (y2 - 2 * y1 + y0),
    cy = 3 * (y1 - y0);
  const A3 = ex * ay - ey * ax,
    B3 = ex * by - ey * bx,
    C3 = ex * cy - ey * cx;
  const D3 = ex * (y0 - P[1]) - ey * (x0 - P[0]);
  for (const t of rootsInUnit(A3, B3, C3, D3)) {
    const q = _cubicAt(cp, t);
    const s = ((q[0] - P[0]) * ex + (q[1] - P[1]) * ey) / L2;
    if (s >= -TRI_S_SLACK && s <= 1 + TRI_S_SLACK) out.push(t);
  }
}

/// Does the cubic have ANY point in the closed triangle? An endpoint inside settles it; so does
/// any edge crossing, since a crossing IS a point on the triangle's boundary. That covers the
/// tangency case for free: a curve that only grazes an edge still has a point on it.
export function cubicMeetsTri(cp, A, B, C) {
  if (triContainsXY(A, B, C, cp[0][0], cp[0][1]) || triContainsXY(A, B, C, cp[3][0], cp[3][1]))
    return true;
  const ts = [];
  _edgeCrossTs(cp, A, B, ts);
  if (ts.length) return true;
  _edgeCrossTs(cp, B, C, ts);
  if (ts.length) return true;
  _edgeCrossTs(cp, C, A, ts);
  return ts.length > 0;
}

/// The t-intervals over which the cubic lies in the closed triangle. Crossings partition [0,1];
/// a span belongs when its midpoint does. A crossing that no span claims is a TOUCH -- the curve
/// meets the triangle at one parameter without entering -- and comes back as a degenerate
/// [t, t], because a boundary that touches a face is still a boundary in that face.
export function cubicTriIntervals(cp, A, B, C) {
  const cuts = [];
  _edgeCrossTs(cp, A, B, cuts);
  _edgeCrossTs(cp, B, C, cuts);
  _edgeCrossTs(cp, C, A, cuts);
  const ts = [0, ...cuts, 1].sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i],
      t1 = ts[i + 1];
    if (!(t1 > t0)) continue;
    const m = _cubicAt(cp, 0.5 * (t0 + t1));
    if (!triContainsXY(A, B, C, m[0], m[1])) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last && last[1] >= t0) last[1] = t1;
    else out.push([t0, t1]);
  }
  for (const t of cuts) {
    let covered = false;
    for (const iv of out)
      if (t >= iv[0] && t <= iv[1]) {
        covered = true;
        break;
      }
    if (!covered) out.push([t, t]);
  }
  return out;
}

/// Closed CONVEX polygon containment, same convention as `triContainsXY`: a point ON an edge is
/// in. The face proof's hull test used this rule already; this is that rule, named and shared.
export function convexContainsXY(H, x, y) {
  if (!H || H.length < 3) return false;
  let pos = 0,
    neg = 0;
  for (let i = 0; i < H.length; i++) {
    const a = H[i],
      b = H[(i + 1) % H.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c > 0) pos++;
    else if (c < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

/// The t-intervals over which the cubic lies in the closed convex polygon -- the polygon twin of
/// `cubicTriIntervals`, by the identical argument: crossings of the straight edges partition
/// [0, 1], a span belongs when its midpoint does, and a crossing no span claims is a TOUCH and
/// comes back as a degenerate [t, t].
export function cubicConvexIntervals(cp, H) {
  if (!H || H.length < 3) return [];
  const cuts = [];
  for (let i = 0; i < H.length; i++) _edgeCrossTs(cp, H[i], H[(i + 1) % H.length], cuts);
  const ts = [0, ...cuts].concat([1]).sort((p2, q2) => p2 - q2);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i],
      t1 = ts[i + 1];
    if (!(t1 > t0)) continue;
    const m = _cubicAt(cp, 0.5 * (t0 + t1));
    if (!convexContainsXY(H, m[0], m[1])) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last && last[1] >= t0) last[1] = t1;
    else out.push([t0, t1]);
  }
  for (const t of cuts) {
    let covered = false;
    for (const iv of out)
      if (t >= iv[0] && t <= iv[1]) {
        covered = true;
        break;
      }
    if (!covered) out.push([t, t]);
  }
  return out;
}

/// The control points of the sub-curve over [t0, t1], by de Casteljau. Exact subdivision, not an
/// approximation: the caller uses the sub-hull to bound where that piece of curve can be.
export function cubicSubCp(cp, t0, t1) {
  const lerp = (P, Q, t) => [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
  const leftOf = (P, t) => {
    const a = lerp(P[0], P[1], t),
      b = lerp(P[1], P[2], t),
      c = lerp(P[2], P[3], t);
    const d = lerp(a, b, t),
      e = lerp(b, c, t);
    return [P[0], a, d, lerp(d, e, t)];
  };
  const rightOf = (P, t) => {
    const a = lerp(P[0], P[1], t),
      b = lerp(P[1], P[2], t),
      c = lerp(P[2], P[3], t);
    const d = lerp(a, b, t),
      e = lerp(b, c, t);
    return [lerp(d, e, t), e, c, P[3]];
  };
  const L = t1 < 1 ? leftOf(cp, t1) : cp;
  return t0 > 0 ? rightOf(L, t1 > 0 ? t0 / t1 : 0) : L;
}

/// The same question for a RATIONAL quadratic -- the exact arc piece lbContour emits, which is
/// not a cubic and must not be elevated into one to answer a containment question. Its side
/// function clears its own denominator: D(t) = (1-t)^2 + 2w t(1-t) + t^2 is positive on [0,1]
/// for w > 0, so the sign of sd(P, Q, R(t)) is the sign of a QUADRATIC numerator and its roots
/// are the crossings. A straight LINE routes through here as [p1, midpoint, p2] with w = 1, and
/// a plain quadratic as its own control points with w = 1; both are exact, not approximations.
export function rquadPt(p1, p2, p3, w, t) {
  const u = 1 - t,
    a = u * u,
    b = 2 * w * u * t,
    c = t * t,
    D = a + b + c;
  if (!(Math.abs(D) > 0)) return [p1[0], p1[1]];
  return [(a * p1[0] + b * p2[0] + c * p3[0]) / D, (a * p1[1] + b * p2[1] + c * p3[1]) / D];
}

function _rqEdgeCrossTs(p1, p2, p3, w, P, Q, out) {
  const ex = Q[0] - P[0],
    ey = Q[1] - P[1],
    L2 = ex * ex + ey * ey;
  if (!(L2 > 0)) return;
  const nx0 = p1[0],
    nx1 = -2 * p1[0] + 2 * w * p2[0],
    nx2 = p1[0] - 2 * w * p2[0] + p3[0];
  const ny0 = p1[1],
    ny1 = -2 * p1[1] + 2 * w * p2[1],
    ny2 = p1[1] - 2 * w * p2[1] + p3[1];
  const d0 = 1,
    d1 = -2 + 2 * w,
    d2 = 2 - 2 * w;
  const g0 = ex * (ny0 - P[1] * d0) - ey * (nx0 - P[0] * d0);
  const g1 = ex * (ny1 - P[1] * d1) - ey * (nx1 - P[0] * d1);
  const g2 = ex * (ny2 - P[1] * d2) - ey * (nx2 - P[0] * d2);
  for (const t of rootsInUnit(0, g2, g1, g0)) {
    const q = rquadPt(p1, p2, p3, w, t);
    const s = ((q[0] - P[0]) * ex + (q[1] - P[1]) * ey) / L2;
    if (s >= -TRI_S_SLACK && s <= 1 + TRI_S_SLACK) out.push(t);
  }
}

export function rquadMeetsTri(p1, p2, p3, w, A, B, C) {
  if (triContainsXY(A, B, C, p1[0], p1[1]) || triContainsXY(A, B, C, p3[0], p3[1])) return true;
  const ts = [];
  _rqEdgeCrossTs(p1, p2, p3, w, A, B, ts);
  if (ts.length) return true;
  _rqEdgeCrossTs(p1, p2, p3, w, B, C, ts);
  if (ts.length) return true;
  _rqEdgeCrossTs(p1, p2, p3, w, C, A, ts);
  return ts.length > 0;
}

export function rquadTriIntervals(p1, p2, p3, w, A, B, C) {
  const cuts = [];
  _rqEdgeCrossTs(p1, p2, p3, w, A, B, cuts);
  _rqEdgeCrossTs(p1, p2, p3, w, B, C, cuts);
  _rqEdgeCrossTs(p1, p2, p3, w, C, A, cuts);
  const ts = [0, ...cuts, 1].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i],
      t1 = ts[i + 1];
    if (!(t1 > t0)) continue;
    const m = rquadPt(p1, p2, p3, w, 0.5 * (t0 + t1));
    if (!triContainsXY(A, B, C, m[0], m[1])) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last && last[1] >= t0) last[1] = t1;
    else out.push([t0, t1]);
  }
  for (const t of cuts) {
    let covered = false;
    for (const iv of out)
      if (t >= iv[0] && t <= iv[1]) {
        covered = true;
        break;
      }
    if (!covered) out.push([t, t]);
  }
  return out;
}

/// Control points of the sub-arc over [t0, t1], by de Casteljau in HOMOGENEOUS coordinates --
/// the rational curve's own subdivision, so the piece is the same arc and its control hull
/// still contains it (the weights stay positive).
export function rquadSubCtrl(p1, p2, p3, w, t0, t1) {
  const lerp3 = (U, V, t) => [
    U[0] + (V[0] - U[0]) * t,
    U[1] + (V[1] - U[1]) * t,
    U[2] + (V[2] - U[2]) * t,
  ];
  const leftOf = (V, t) => {
    const a = lerp3(V[0], V[1], t),
      b = lerp3(V[1], V[2], t);
    return [V[0], a, lerp3(a, b, t)];
  };
  const rightOf = (V, t) => {
    const a = lerp3(V[0], V[1], t),
      b = lerp3(V[1], V[2], t);
    return [lerp3(a, b, t), b, V[2]];
  };
  let W = [
    [p1[0], p1[1], 1],
    [w * p2[0], w * p2[1], w],
    [p3[0], p3[1], 1],
  ];
  if (t1 < 1) W = leftOf(W, t1);
  if (t0 > 0) W = rightOf(W, t1 > 0 ? t0 / t1 : 0);
  return W.map((V) => (Math.abs(V[2]) > 0 ? [V[0] / V[2], V[1] / V[2]] : [V[0], V[1]]));
}

export function partitionCubicSplitTs(P0, others, keepInflections = false) {
  const turn = (P) => {
    const t0x = P[1][0] - P[0][0],
      t0y = P[1][1] - P[0][1];
    const t1x = P[3][0] - P[2][0],
      t1y = P[3][1] - P[2][1];
    const d0 = Math.hypot(t0x, t0y),
      d1 = Math.hypot(t1x, t1y);

    let ext9 = 0;
    for (let i = 1; i < 4; i++)
      ext9 = Math.max(ext9, Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]));
    const dEps9 = ext9 * 2 ** -24;
    if (d0 <= dEps9 || d1 <= dEps9) return 1;
    return (t0x * t1x + t0y * t1y) / (d0 * d1);
  };
  // Inflections AND the loop's in-span double point(s). Without the latter a cubic
  // holding part of a loop keeps its double point interior, the implicit changes sign
  // across it, and the piece over-paints — which is what the self-audit then declines.
  // Safe for morph pairs: lbPartitionPair derives this plan from the SOURCE control
  // points and applies it to both sides, so the piece count stays matched.
  // `keepInflections`: a morph pair's cubic whose inflection MOVES keeps it inside one piece on both poses (
  // (c)), because the poses would cut it at different parameters; that piece is a serpentine (lbPartition).
  const infl = (keepInflections ? [] : cubicInflections(P0))
    .concat(cubicLoopCuts(P0))
    .sort((a, b) => a - b);
  const ts = [],
    fatTs = [];
  const ranges = [];
  {
    let prev = 0;
    for (const t of infl) {
      ranges.push([prev, t, 0]);
      prev = t;
    }
    ranges.push([prev, 1, 0]);
    for (const t of infl) ts.push(t);
  }
  // THE SPLIT CRITERION IS A TURN, not a size. A piece whose end tangents turn more than about
  // 100 degrees is halved, up to three times -- so a gently-turning piece keeps a large control
  // hull however far that hull reaches across the shape, and a face inside it is handed to this
  // one curve with the whole outline ignored (see lbPartition's hull path). __LB_SPLIT_TURN and
  // __LB_SPLIT_DEPTH exist to price a more aggressive decomposition against what it costs in
  // pieces: subdividing halves the chord and cuts the sagitta about fourfold, so flattening is
  // O(1/sqrt(eps)) and the count should grow far slower than the accuracy does.
  // CONTAINMENT: split until nothing else of the shape is inside this piece's hull.
  //
  // A Loop-Blinn face carries ONE curve's implicit, so the model is only sound where a piece's
  // control hull holds nothing but its own arc -- otherwise a face inside that hull is handed to
  // this curve and painted by its half-space while the shape's ink there is decided by another
  // boundary. That is the whole of the over-paint the audit declines shapes for
  // (docs: a face owns one curve). Subdividing shrinks a hull onto its arc, so the invariant is
  // always reachable, and the fear is a geometric explosion on thin features.
  //
  if (others && others.length) {
    const inHull9 = (H, x, y) => {
      let pos = 0,
        neg = 0;
      for (let i = 0; i < H.length; i++) {
        const a = H[i],
          b = H[(i + 1) % H.length];
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (c > 0) pos++;
        else if (c < 0) neg++;
      }
      return pos === 0 || neg === 0;
    };
    const MAXD9 = 8;
    const work9 = [[0, 1, 0]];
    while (work9.length) {
      const [t0, t1, d] = work9.pop();
      if (d >= MAXD9) continue;
      const piece = cubicSlice(P0, t0, t1);
      const hi9 = cubicHull(piece);
      const H9 = hi9 && hi9.length >= 3 ? hi9.map((i2) => piece[i2]) : piece;
      let bad9 = false;
      // `others` is a flat [x, y, x, y, ...] of sample points on the neighboring segments (21 per segment); passing
      // none leaves the turn-only behavior.
      for (let i = 0; i < others.length && !bad9; i += 2)
        if (inHull9(H9, others[i], others[i + 1])) bad9 = true;
      if (!bad9) continue;
      const tm = (t0 + t1) / 2;
      ts.push(tm);
      work9.push([t0, tm, d + 1], [tm, t1, d + 1]);
    }
  }
  const _sturn =
    mantleDebugHook('__LB_SPLIT_TURN') != null ? +mantleDebugHook('__LB_SPLIT_TURN') : -0.17;
  const _sdepth =
    mantleDebugHook('__LB_SPLIT_DEPTH') != null ? mantleDebugHook('__LB_SPLIT_DEPTH') | 0 : 3;
  while (ranges.length) {
    const [t0, t1, d] = ranges.pop();
    const piece = cubicSlice(P0, t0, t1);
    if (d < _sdepth && turn(piece) < _sturn) {
      const tm = (t0 + t1) / 2;
      ts.push(tm);
      fatTs.push(tm);
      ranges.push([t0, tm, d + 1], [tm, t1, d + 1]);
    }
  }
  // Deduplicate: the containment pass and the turn pass can both ask for the same midpoint, and a
  // repeated t makes splitCubicMulti emit a zero-length piece.
  ts.sort((a, b) => a - b);
  const uniq9 = [];
  for (const t of ts) if (!uniq9.length || t - uniq9[uniq9.length - 1] > 1e-9) uniq9.push(t);
  return { ts: uniq9, fatTs: new Set(fatTs) };
}

// slice a cubic to the [t0,t1] sub-range (de Casteljau twice)
export function cubicSlice(P, t0, t1) {
  const right = t0 > 0 ? splitCubicMulti(P, [t0])[1] : P;
  if (t1 >= 1) return right;
  const tLocal = (t1 - t0) / (1 - t0);
  return splitCubicMulti(right, [tLocal])[0];
}

// hull-frame texcoords for a point (integral: (u,v); rational: homogeneous rows).
// Module-level so buildLoopBlinnPartition AND the morph pair transform share it.
export function uvInHull(h, px, py) {
  const ax = h.a[0],
    ay = h.a[1];
  const v0x = h.c[0] - ax,
    v0y = h.c[1] - ay,
    v1x = h.b[0] - ax,
    v1y = h.b[1] - ay;
  const den = v0x * v1y - v0y * v1x;
  if (!(Math.abs(den) >= 1e-18 * Math.sqrt((v0x * v0x + v0y * v0y) * (v1x * v1x + v1y * v1y))))
    return null; // an AREA: relative to its own edges. Absolute, a hull under about 2^-34 of its art would read as degenerate
  const v2x = px - ax,
    v2y = py - ay;
  const w1 = (v2x * v1y - v2y * v1x) / den; // weight of c
  const w2 = (v0x * v2y - v0y * v2x) / den; // weight of b
  const w0 = 1 - w1 - w2;
  const hw = h.w || 1;
  if (hw === 1) return [0.5 * w1 + w2, w2, 0]; // integral: a=(0,0), c=(1/2,0), b=(1,1)
  const iw = 1 / hw;
  // rational rows: a=(0,0,1), c=(iw/2, 0, iw), b=(1,1,1) — f = u²−v·r
  return [0.5 * iw * w1 + w2, w2, w0 + iw * w1 + w2];
}

// keep-side sign for a cubic piece, tied to the convex/concave classification
// (chord-side crescent for convex, control-side for concave).
/// A crescent's sign read AT a point known to be ink: negative there. For a SERPENTINE piece, whose
/// hull straddles its arc, "the control side" and "the chord side" are both on both sides, so cubicSign's and
/// cubicSignKLMN's reference points name no side; the ink probe's own point does. A klmn frame is read over the hull
/// sub-triangle holding the point (cubicSignKLMN's basis rule); a Bezout resultant is read directly. 0 when the
/// implicit is zero there.
export function cubicSignAtPoint(P, klmn, F, ref) {
  if (!klmn) return F ? -Math.sign(evalBezout(F, ref[0], ref[1])) : 0;
  const h = cubicHull(P);
  const tris =
    h.length === 3
      ? [[h[0], h[1], h[2]]]
      : [
          [h[0], h[1], h[2]],
          [h[0], h[2], h[3]],
        ];
  let t = tris[0];
  for (const tr of tris)
    if (pointInTri(ref, P[tr[0]], P[tr[1]], P[tr[2]])) {
      t = tr;
      break;
    }
  const HP = [P[t[0]], P[t[1]], P[t[2]]];
  const K = affineEval([klmn.k[t[0]], klmn.k[t[1]], klmn.k[t[2]]], HP, ref[0], ref[1]);
  const L = affineEval([klmn.l[t[0]], klmn.l[t[1]], klmn.l[t[2]]], HP, ref[0], ref[1]);
  const M = affineEval([klmn.m[t[0]], klmn.m[t[1]], klmn.m[t[2]]], HP, ref[0], ref[1]);
  return -Math.sign(K * K * K - L * M);
}
export function cubicSign(P, F, concave) {
  const cm = cubicPt(P, 0.5);
  const chordMid = [(P[0][0] + P[3][0]) / 2, (P[0][1] + P[3][1]) / 2];
  const ctrlMid = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
  const ref = concave
    ? [(cm[0] + ctrlMid[0]) / 2, (cm[1] + ctrlMid[1]) / 2]
    : [(cm[0] + chordMid[0]) / 2, (cm[1] + chordMid[1]) / 2];
  return -Math.sign(evalBezout(F, ref[0], ref[1]));
}

/// Check whether a Bezout crescent overestimates its distance. Its coverage ramps on |f| / |grad f|, which is a
/// distance to the arc only where the resultant's nearest zero IS the arc; the resultant carries branches the
/// Bezier never traces, and where one runs close the implied distance collapses while the real one does not.
/// True when, at some point of a (grid+1)-per-side lattice over the control hull's two triangles, the implied
/// distance understates the distance to the arc (sampled at nArc+1 points) by more than `frac` of the chord.
/// The partition's faithful split (lbPartition, `unfaithful9`) and the correct fast build's crescent split
/// (lbFastMesh splitCubicForCrescent) both ask it.
export function bezoutUnfaithful(cp, frac = 0.05, nArc = 16, grid = 6) {
  let F = null;
  try {
    F = bezoutCubicImplicit(cp);
  } catch {
    return false;
  }
  if (!F) return false;
  const ch = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
  if (!(ch > 0)) return false;
  const hh = 1e-5 * ch,
    lim = frac * ch;
  const arc = [];
  for (let k = 0; k <= nArc; k++) arc.push(cubicPt(cp, k / nArc));
  for (const tri of [
    [0, 1, 2],
    [0, 2, 3],
  ])
    for (let a = 0; a <= grid; a++)
      for (let b = 0; a + b <= grid; b++) {
        const wa = a / grid,
          wb = b / grid,
          wc = 1 - wa - wb;
        const x = wa * cp[tri[0]][0] + wb * cp[tri[1]][0] + wc * cp[tri[2]][0];
        const y = wa * cp[tri[0]][1] + wb * cp[tri[1]][1] + wc * cp[tri[2]][1];
        const f = evalBezout(F, x, y);
        const gx = (evalBezout(F, x + hh, y) - evalBezout(F, x - hh, y)) / (2 * hh);
        const gy = (evalBezout(F, x, y + hh) - evalBezout(F, x, y - hh)) / (2 * hh);
        const gm = Math.hypot(gx, gy);
        if (!(gm > 0)) continue;
        let ad = Infinity;
        for (const A of arc) {
          const d = (A[0] - x) * (A[0] - x) + (A[1] - y) * (A[1] - y);
          if (d < ad) ad = d;
        }
        if (Math.sqrt(ad) - Math.abs(f) / gm > lim) return true;
      }
  return false;
}

export const cubicPt = (P, t) => {
  const u = 1 - t;
  return [
    u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
    u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
  ];
};

/// A cubic whose leading coefficient vanishes IS a quadratic. Loop-Blinn's klmn
/// classification then reports d1 = d2 = 0 and cubicKLMN() bails to the exact-Bezout
/// (kind-4) crescent — whose coverage is wrong for this class: a squircle drawn as four
/// cubics with CORNER control points, e.g.
///     M 40 100 C 40 60 60 40 100 40 ...
/// has C3 = -P0 + 3P1 - 3P2 + P3 = (0,0) exactly, and rendered only its interior diamond
/// (ink 0.595 vs Slug). Degree-reduce it to a true quadratic instead: the kind-1 crescent
/// is exact, cheaper, and carries the tangent/corner partition that cubics lack.
///
/// Returns the quadratic control point Q, or null when the cubic is a genuine cubic.
/// (Both P0 + 1.5(P1-P0) and P3 + 1.5(P2-P3) give Q when C3 == 0; average them so a
/// near-degenerate cubic reduces to the least-squares quadratic rather than one endpoint's.)
export function cubicDegreeReduce(P) {
  const b0 = P[0],
    b1 = P[1],
    b2 = P[2],
    b3 = P[3];
  const c3x = -b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0];
  const c3y = -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1];
  // scale: the control polygon's total length — |C3| is a length in the same units. No additive
  // floor: a polygon of zero length is a point, and C3 is then exactly zero.
  const scale =
    Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) +
    Math.hypot(b2[0] - b1[0], b2[1] - b1[1]) +
    Math.hypot(b3[0] - b2[0], b3[1] - b2[1]);
  if (Math.hypot(c3x, c3y) > 1e-6 * scale) return null;
  const qa = [(3 * b1[0] - b0[0]) / 2, (3 * b1[1] - b0[1]) / 2];
  const qb = [(3 * b2[0] - b3[0]) / 2, (3 * b2[1] - b3[1]) / 2];
  return [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2];
}

/// The triangle a piece's klmn ROWS ARE READ OVER: { A, B, C, den, R }, R being the rows at A, B and C,
/// or null when no three of the piece's control points span the plane (`bar(u, v)` prices "span": the morph pair's
/// relative sine, lbPartitionPair.js `par9`).
///
/// k, l and m are ONE affine function of position over a whole cubic piece, so any three control points that span the
/// plane give the same rows, and which three is a question of conditioning only. The WIDEST, by area, gives every point
/// of the piece's control hull barycentric weights in [-1, 1], and a ranking of areas within one piece is the same at
/// every scale. The morph pair's destination has read its rows this way (lbPartitionPair.js dstKlmnFrame9,
/// which calls this); the static build (lbPartition.js cubicRowsAt) read them over the face's own FAN triangle, which a
/// containment split can leave a sliver.
export function klmnWidestFrame9(P, K, bar) {
  let best = null,
    bestAr = -1;
  for (const tri of [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ]) {
    const [a, b, c] = tri;
    const ar = Math.abs(
      (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]),
    );
    if (ar > bestAr) {
      bestAr = ar;
      best = tri;
    }
  }
  const [A, B, C] = [P[best[0]], P[best[1]], P[best[2]]];
  const ux = B[0] - A[0],
    uy = B[1] - A[1],
    vx = C[0] - A[0],
    vy = C[1] - A[1];
  const den = ux * vy - uy * vx;
  if (!(Math.abs(den) > bar(ux, uy, vx, vy))) return null;
  const row = (j) => [K.k[j], K.l[j], K.m[j]];
  return { A, B, C, den, R: [row(best[0]), row(best[1]), row(best[2])] };
}
/// The rows at (px, py) over a klmnWidestFrame9 frame.
export function klmnFrameRowsAt9(fr, px, py) {
  const { A, B, C, den, R } = fr;
  const w1 = ((px - A[0]) * (C[1] - A[1]) - (py - A[1]) * (C[0] - A[0])) / den;
  const w2 = ((B[0] - A[0]) * (py - A[1]) - (B[1] - A[1]) * (px - A[0])) / den;
  const w0 = 1 - w1 - w2;
  return [
    w0 * R[0][0] + w1 * R[1][0] + w2 * R[2][0],
    w0 * R[0][1] + w1 * R[1][1] + w2 * R[2][1],
    w0 * R[0][2] + w1 * R[1][2] + w2 * R[2][2],
  ];
}
