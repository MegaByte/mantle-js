// lbCubicMath.js — pure cubic/quadratic implicit math: Bezout resultant
// frames, Loop-Blinn klmn classification, inflection/loop analysis, de
// Casteljau subdivision, the shared subdivision plan, and the hull's
// affine texcoord frame. No GL, no module state; used by the partition
// builder, the morph pair transform, and the packer.
import { pointInTri } from './lbEarcut.js';

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
const _m3inv = (f) => [f[0], f[0] + f[1] / 3, f[0] + 2 * f[1] / 3 + f[2] / 3, f[0] + f[1] + f[2] + f[3]];

// ---- exact cubic implicit (Bezout resultant, normalized frame) -------------
export function bezoutCubicImplicit(P) {
  const cx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4, cy = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
  let s = 1e-6; for (const p of P) s = Math.max(s, Math.abs(p[0] - cx), Math.abs(p[1] - cy));
  const X = P.map(p => (p[0] - cx) / s), Y = P.map(p => (p[1] - cy) / s);
  const Xm = [X[0], -3*X[0]+3*X[1], 3*X[0]-6*X[1]+3*X[2], -X[0]+3*X[1]-3*X[2]+X[3]];
  const Ym = [Y[0], -3*Y[0]+3*Y[1], 3*Y[0]-6*Y[1]+3*Y[2], -Y[0]+3*Y[1]-3*Y[2]+Y[3]];
  const br = (i, j) => Xm[i] * Ym[j] - Xm[j] * Ym[i];
  const b03 = br(0, 3), b12 = br(1, 2);
  return {
    cx, cy, s,
    m00: { a: -br(0, 1), b: Ym[1], c: -Xm[1] },
    m01: { a: -br(0, 2), b: Ym[2], c: -Xm[2] },
    m02: { a: -b03, b: Ym[3], c: -Xm[3] },
    m11a: -b03 - b12,                 // m11 shares (b,c) with m02
    m12: -br(1, 3), m22: -br(2, 3),
  };
}

export function evalBezout(F, px, py) {
  const x = (px - F.cx) / F.s, y = (py - F.cy) / F.s;
  const M00 = F.m00.a + F.m00.b * x + F.m00.c * y, M01 = F.m01.a + F.m01.b * x + F.m01.c * y, M02 = F.m02.a + F.m02.b * x + F.m02.c * y;
  const M11 = F.m11a + F.m02.b * x + F.m02.c * y;
  return M00 * (M11 * F.m22 - F.m12 * F.m12) - M01 * (M01 * F.m22 - F.m12 * M02) + M02 * (M01 * F.m12 - M11 * M02);
}

export function cubicKLMN(P) {
  const b0 = P[0], b1 = P[1], b2 = P[2], b3 = P[3];
  const C1 = [-3 * b0[0] + 3 * b1[0], -3 * b0[1] + 3 * b1[1]];
  const C2 = [3 * b0[0] - 6 * b1[0] + 3 * b2[0], 3 * b0[1] - 6 * b1[1] + 3 * b2[1]];
  const C3 = [-b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0], -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1]];
  let d1 = _cross2(C2, C3), d2 = _cross2(C3, C1), d3 = _cross2(C1, C2);
  const scale = Math.abs(d1) + Math.abs(d2) + Math.abs(d3) + 1e-12;
  const disc0 = 3 * d2 * d2 - 4 * d1 * d3;
  if (Math.abs(d1) < 1e-7 * scale || Math.abs(disc0) < 1e-6 * scale * scale) return null;  // cusp / degenerate → Bezout
  // Normalize d's to O(1) before cubing — k³−lm is scale-invariant, and this
  // keeps the fp32 attributes (and the GPU-recompute path) well-conditioned.
  const inv = 1 / scale; d1 *= inv; d2 *= inv; d3 *= inv;
  const disc = 3 * d2 * d2 - 4 * d1 * d3;
  let k, l, m;
  if (disc > 0) {                                   // serpentine
    const r = Math.sqrt(disc / 3), tl = d2 + r, sl = 2 * d1, tm = d2 - r, sm = 2 * d1;
    k = _m3inv([tl * tm, -sm * tl - sl * tm, sl * sm, 0]);
    l = _m3inv([tl * tl * tl, -3 * sl * tl * tl, 3 * sl * sl * tl, -sl * sl * sl]);
    m = _m3inv([tm * tm * tm, -3 * sm * tm * tm, 3 * sm * sm * tm, -sm * sm * sm]);
    if (d1 < 0) { k = k.map(v => -v); l = l.map(v => -v); }   // orientation (α = 32/3·d1³·H, H<0)
  } else {                                          // loop
    const r = Math.sqrt(-disc), td = d2 + r, sd = 2 * d1, te = d2 - r, se = 2 * d1;
    k = _m3inv([td * te, -se * td - sd * te, sd * se, 0]);
    l = _m3inv([td * td * te, -se * td * td - 2 * sd * td * te, te * sd * sd + 2 * se * sd * td, -sd * sd * se]);
    m = _m3inv([td * te * te, -sd * te * te - 2 * se * td * te, td * se * se + 2 * sd * se * te, -sd * se * se]);
    // orientation handled empirically by cubicSignKLMN (klmn = c·Bezout).
  }
  return { k, l, m };
}

// Affine reconstruction of a klmn channel (values at the 4 control points are
// affine-consistent) → evaluate at an arbitrary (x,y). Solves A+Bx+Cy through
// control points 0,1,2 (the hull's base triangle).
export function affineEval(vals, P, x, y) {
  const p0 = P[0], p1 = P[1], p2 = P[2];
  const det = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
  if (Math.abs(det) < 1e-12) return vals[0];
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
  const ref = concave ? [(cm[0] + ctrlMid[0]) / 2, (cm[1] + ctrlMid[1]) / 2]
                      : [(cm[0] + chordMid[0]) / 2, (cm[1] + chordMid[1]) / 2];
  // The klmn (k,l,m) are interpolated linearly across the RENDERED hull triangle,
  // so f=k³−lm must be evaluated with the barycentric basis of the SAME triangle
  // — NOT a fixed P[0..2]. The hull is P[hull[…]] (3 pts, or a 4-pt quad split
  // into [0,1,2]+[0,2,3]); pick the sub-triangle containing ref. Using the wrong
  // basis (e.g. when a control point is INSIDE the hull, so hull≠[0,1,2]) flips
  // the sign for concave / S-curve cubics — the CFF-glyph over/under-fill bug.
  const h = cubicHull(P);
  const tris = h.length === 3 ? [[h[0], h[1], h[2]]] : [[h[0], h[1], h[2]], [h[0], h[2], h[3]]];
  let t = tris[0];
  for (const tr of tris) if (pointInTri(ref, P[tr[0]], P[tr[1]], P[tr[2]])) { t = tr; break; }
  const HP = [P[t[0]], P[t[1]], P[t[2]]];
  const K = affineEval([klmn.k[t[0]], klmn.k[t[1]], klmn.k[t[2]]], HP, ref[0], ref[1]);
  const L = affineEval([klmn.l[t[0]], klmn.l[t[1]], klmn.l[t[2]]], HP, ref[0], ref[1]);
  const M = affineEval([klmn.m[t[0]], klmn.m[t[1]], klmn.m[t[2]]], HP, ref[0], ref[1]);
  return -Math.sign(K * K * K - L * M);
}

// ---- exact cubic feature analysis (inflections, loop/cusp) ------------------
export function quadRoots01(a, b, c) {
  const out = []; if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) { const t = -c / b; if (t > 1e-6 && t < 1 - 1e-6) out.push(t); } return out; }
  const disc = b * b - 4 * a * c; if (disc < 0) return out; const sq = Math.sqrt(disc);
  for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]) if (t > 1e-6 && t < 1 - 1e-6) out.push(t);
  return out;
}

// inflection params: B'(t)×B''(t)=0 → 3(c2×c3)t² + 3(c1×c3)t + (c1×c2)=0.
export function cubicInflections(P) {
  const ax = -P[0][0]+3*P[1][0]-3*P[2][0]+P[3][0], bx = 3*P[0][0]-6*P[1][0]+3*P[2][0], cx = -3*P[0][0]+3*P[1][0];
  const ay = -P[0][1]+3*P[1][1]-3*P[2][1]+P[3][1], by = 3*P[0][1]-6*P[1][1]+3*P[2][1], cy = -3*P[0][1]+3*P[1][1];
  const A2 = bx*ay - by*ax, A1 = cx*ay - cy*ax, A0 = cx*by - cy*bx;
  return quadRoots01(3 * A2, 3 * A1, A0).sort((u, v) => u - v);
}

// self-intersection (loop) within [0,1]: solve B(s)=B(t), s≠t. Returns the two
// interior double-point parameters { lo, hi } (lo<hi), or null if the cubic is
// loop-free. Splitting the cubic at lo AND hi yields three simple (non-self-
// intersecting) pieces — the tails [0,lo], [hi,1] and the loop body [lo,hi] —
// each of which the ordinary klmn/Bezout crescent + CDT winding renders exactly.
export function cubicLoopParams(P) {
  const c1 = [3*(P[1][0]-P[0][0]), 3*(P[1][1]-P[0][1])];
  const c2 = [3*(P[0][0]-2*P[1][0]+P[2][0]), 3*(P[0][1]-2*P[1][1]+P[2][1])];
  const c3 = [-P[0][0]+3*P[1][0]-3*P[2][0]+P[3][0], -P[0][1]+3*P[1][1]-3*P[2][1]+P[3][1]];
  const denom = c3[1]*c2[0] - c3[0]*c2[1];
  if (Math.abs(denom) < 1e-9) return null;
  const p = (c3[0]*c1[1] - c3[1]*c1[0]) / denom;
  const useX = Math.abs(c3[0]) >= Math.abs(c3[1]);
  const r = useX ? -(c2[0]*p + c1[0]) / c3[0] : -(c2[1]*p + c1[1]) / c3[1];
  const q = p*p - r, discST = p*p - 4*q;
  if (discST < 0) return null;
  const sq = Math.sqrt(discST), s = (p + sq) / 2, t = (p - sq) / 2;
  const inSpan = v => v > 1e-4 && v < 1 - 1e-4;
  if (inSpan(s) && inSpan(t) && Math.abs(s - t) > 1e-3) return { lo: Math.min(s, t), hi: Math.max(s, t) };
  if (discST < 1e-6 && inSpan(p / 2)) { const m = p / 2; return { lo: m, hi: m }; }
  return null;
}

export function cubicLoop(P) { return !!cubicLoopParams(P); }

export function splitCubic(P, t) {
  const L = (A, B) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
  const ab = L(P[0], P[1]), bc = L(P[1], P[2]), cd = L(P[2], P[3]), abc = L(ab, bc), bcd = L(bc, cd), m = L(abc, bcd);
  return [[P[0], ab, abc, m], [m, bcd, cd, P[3]]];
}

export function splitCubicMulti(P, ts) {
  const out = []; let cur = P, last = 0;
  for (const t of ts) { const lt = (t - last) / (1 - last); if (lt <= 1e-6 || lt >= 1 - 1e-6) continue; const [l, r] = splitCubic(cur, lt); out.push(l); cur = r; last = t; }
  out.push(cur); return out;
}

export function cubicHull(P) {
  for (let i = 0; i < 4; i++) { const o = [0, 1, 2, 3].filter(j => j !== i); if (pointInTri(P[i], P[o[0]], P[o[1]], P[o[2]])) return o; }
  const cx = (P[0][0]+P[1][0]+P[2][0]+P[3][0]) / 4, cy = (P[0][1]+P[1][1]+P[2][1]+P[3][1]) / 4;
  return [0, 1, 2, 3].sort((a, b) => Math.atan2(P[a][1] - cy, P[a][0] - cx) - Math.atan2(P[b][1] - cy, P[b][0] - cx));
}

// PARTITION CUBIC SPLIT PLAN (pure): the t-values buildLoopBlinnPartition subdivides a
// cubic at — inflections first, then fat-turn (tangent turn ≳100°) halving to
// depth 3. Factored out so the morph PAIR builder can apply the SAME split
// t-values to the destination endpoint (piece-for-piece correspondence) — one
// code path, not a copy. Returns { ts, fatTs } (global t's, sorted; fatTs =
// the non-inflection halvings, whose descendants route straight to Bezout).
export function partitionCubicSplitTs(P0) {
  const turn = (P) => {
    const t0x = P[1][0] - P[0][0], t0y = P[1][1] - P[0][1];
    const t1x = P[3][0] - P[2][0], t1y = P[3][1] - P[2][1];
    const d0 = Math.hypot(t0x, t0y), d1 = Math.hypot(t1x, t1y);
    if (d0 < 1e-12 || d1 < 1e-12) return 1;
    return (t0x * t1x + t0y * t1y) / (d0 * d1);
  };
  const infl = cubicInflections(P0);
  const ts = [], fatTs = [];
  const ranges = [];
  {
    let prev = 0;
    for (const t of infl) { ranges.push([prev, t, 0]); prev = t; }
    ranges.push([prev, 1, 0]);
    for (const t of infl) ts.push(t);
  }
  while (ranges.length) {
    const [t0, t1, d] = ranges.pop();
    const piece = cubicSlice(P0, t0, t1);
    if (d < 3 && turn(piece) < -0.17) {
      const tm = (t0 + t1) / 2;
      ts.push(tm); fatTs.push(tm);
      ranges.push([t0, tm, d + 1], [tm, t1, d + 1]);
    }
  }
  ts.sort((a, b) => a - b);
  return { ts, fatTs: new Set(fatTs) };
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
  const ax = h.a[0], ay = h.a[1];
  const v0x = h.c[0] - ax, v0y = h.c[1] - ay, v1x = h.b[0] - ax, v1y = h.b[1] - ay;
  const den = v0x * v1y - v0y * v1x;
  if (Math.abs(den) < 1e-18) return null;
  const v2x = px - ax, v2y = py - ay;
  const w1 = (v2x * v1y - v2y * v1x) / den;   // weight of c
  const w2 = (v0x * v2y - v0y * v2x) / den;   // weight of b
  const w0 = 1 - w1 - w2;
  const hw = h.w || 1;
  if (hw === 1) return [0.5 * w1 + w2, w2, 0];                     // integral: a=(0,0), c=(1/2,0), b=(1,1)
  const iw = 1 / hw;
  // rational rows: a=(0,0,1), c=(iw/2, 0, iw), b=(1,1,1) — f = u²−v·r
  return [0.5 * iw * w1 + w2, w2, w0 + iw * w1 + w2];
}

// keep-side sign for a cubic piece, tied to the convex/concave classification
// (chord-side crescent for convex, control-side for concave).
export function cubicSign(P, F, concave) {
  const cm = cubicPt(P, 0.5);
  const chordMid = [(P[0][0] + P[3][0]) / 2, (P[0][1] + P[3][1]) / 2];
  const ctrlMid = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
  const ref = concave ? [(cm[0] + ctrlMid[0]) / 2, (cm[1] + ctrlMid[1]) / 2]
                      : [(cm[0] + chordMid[0]) / 2, (cm[1] + chordMid[1]) / 2];
  return -Math.sign(evalBezout(F, ref[0], ref[1]));
}

export const cubicPt = (P, t) => { const u = 1 - t; return [
  u*u*u*P[0][0] + 3*u*u*t*P[1][0] + 3*u*t*t*P[2][0] + t*t*t*P[3][0],
  u*u*u*P[0][1] + 3*u*u*t*P[1][1] + 3*u*t*t*P[2][1] + t*t*t*P[3][1]]; };

