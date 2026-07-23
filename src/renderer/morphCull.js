// morphCull.js — occlusion culling for a MORPH, decided analytically over the whole
// animation rather than sampled at a few times.
//
// THE PROBLEM. A morph lerps every control point, so "hidden at t=0" says nothing
// about t=1: an occluder that shrinks away exposes what it was covering. Testing the
// two endpoints is UNSOUND — the occluder can shrink faster than the shape it hides
// and expose it mid-morph. Sampling t is unsound for the same reason, and picking a
// safe step needs a Lipschitz bound nobody wants to defend.
//
// THE REDUCTION. Containment can only break where the two BOUNDARIES cross: by
// continuity, I(t) cannot escape J(t) without ∂I passing through ∂J. So the whole
// question is whether the morphing boundaries ever meet. Write a morphing segment as
//
//     S(u,t) = (1−t)·A₀(u) + t·A₁(u)
//
// (A₀ = Bézier over the SOURCE control points, A₁ over the DESTINATION), and the same
// for the occluder's B(v,t). A crossing is S(u,t) = B(v,t), i.e.
//
//     (1−t)·[A₀(u) − B₀(v)]  +  t·[A₁(u) − B₁(v)]  =  0
//              ───────────            ───────────
//                 P(u,v)                 Q(u,v)
//
// Because t enters LINEARLY, this says exactly: the straight segment from P(u,v) to
// Q(u,v) passes through the origin. Which is two conditions on (u,v) ALONE:
//
//     F(u,v) = cross(P, Q) = 0     ← the origin is on the line PQ
//     G(u,v) = dot(P, Q)   ≤ 0     ← it lies BETWEEN them, i.e. t ∈ [0,1]
//
// t is eliminated. No sampling, no step size, no Lipschitz constant.
//
// DECIDING IT. F and G are polynomials in (u,v) — bidegree (2n, 2m); for cubic vs
// cubic that is 6×6. Put them in BERNSTEIN form over the unit square and use the
// convex-hull property:
//
//   • every Bernstein coefficient of F strictly the same sign ⇒ F has no zero on the
//     box ⇒ this segment pair NEVER crosses, for any t. Certified in one shot.
//   • every coefficient of G strictly positive ⇒ the origin is never between P and Q
//     ⇒ any crossing would need t outside [0,1]. Also certified.
//
// Only when both are inconclusive do we subdivide the (u,v) square and recurse — and
// that only happens near genuine contact. If no pair can cross, and the shape is
// contained at BOTH endpoints, it is contained for every t in between, and culling it
// is sound.
//
// CONSERVATIVE BY CONSTRUCTION. Anything we cannot certify — an arc (not polynomial),
// a tangency, a pair that will not resolve within the subdivision budget — simply is
// not culled. The cost of failing to decide is one draw, never a wrong pixel.

import { SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../hitTest/curveGeom.js';
import { segsOf, isPlainOpaque, hasFilter, isContained } from './occlusionCull.js';

const MAX_SHAPES = 512;
const MAX_DEPTH = 6;          // (u,v) subdivisions before we give up and keep the draw
const BINOM = [];             // BINOM[n][k]
for (let n = 0; n <= 12; n++) {
  BINOM[n] = [1];
  for (let k = 1; k <= n; k++) BINOM[n][k] = BINOM[n][k - 1] * (n - k + 1) / k;
}

/** Bernstein control points of a segment: [[x,y], …]. Null for a non-polynomial arc. */
function ctrlOf(s) {
  if (s.t === SEG_ARC) return null;                        // rational — not a polynomial in u
  if (s.t === SEG_CUBIC) return [[s.x0, s.y0], [s.c1x, s.c1y], [s.c2x, s.c2y], [s.x1, s.y1]];
  if (s.t === SEG_QUAD)  return [[s.x0, s.y0], [s.cx, s.cy], [s.x1, s.y1]];
  return [[s.x0, s.y0], [s.x1, s.y1]];                     // line
}

/**
 * Tensor-Bernstein product of two bidegree-(n,m) coefficient grids → bidegree (2n,2m).
 *   h_pq = Σ_{i+k=p, j+l=q} [C(n,i)C(n,k)/C(2n,p)] · [C(m,j)C(m,l)/C(2m,q)] · f_ij·g_kl
 */
function bernMul(f, g, n, m, out) {
  const M2 = 2 * m, N2 = 2 * n;
  out.fill(0);
  for (let i = 0; i <= n; i++) for (let k = 0; k <= n; k++) {
    const p = i + k;
    const wu = (BINOM[n][i] * BINOM[n][k]) / BINOM[N2][p];
    for (let j = 0; j <= m; j++) for (let l = 0; l <= m; l++) {
      const q = j + l;
      const wv = (BINOM[m][j] * BINOM[m][l]) / BINOM[M2][q];
      out[p * (M2 + 1) + q] += wu * wv * f[i * (m + 1) + j] * g[k * (m + 1) + l];
    }
  }
  return out;
}

/** de Casteljau split of a tensor-Bernstein grid at 0.5 along u (degree N). */
function splitU(c, N, M, lo, hi) {
  const W = M + 1;
  const work = new Float64Array(N + 1);
  for (let q = 0; q <= M; q++) {
    for (let p = 0; p <= N; p++) work[p] = c[p * W + q];
    const last = work[N];
    lo[0 * W + q] = work[0];
    for (let r = 1; r <= N; r++) {
      for (let p = 0; p <= N - r; p++) work[p] = 0.5 * (work[p] + work[p + 1]);
      lo[r * W + q] = work[0];                 // left half's control points
      hi[(N - r) * W + q] = work[N - r];       // right half's, filled from the far end
    }
    hi[N * W + q] = last;
  }
}

/** de Casteljau split of a tensor-Bernstein grid at 0.5 along v (degree M). */
function splitV(c, N, M, lo, hi) {
  const W = M + 1;
  for (let p = 0; p <= N; p++) {
    const row = new Float64Array(M + 1);
    for (let q = 0; q <= M; q++) row[q] = c[p * W + q];
    const work = row.slice();
    lo[p * W + 0] = work[0];
    for (let r = 1; r <= M; r++) {
      for (let q = 0; q <= M - r; q++) work[q] = 0.5 * (work[q] + work[q + 1]);
      lo[p * W + r] = work[0];
      hi[p * W + (M - r)] = work[M - r];
    }
    hi[p * W + M] = row[M];
  }
}

/** All coefficients strictly one sign? (convex hull ⇒ the polynomial has no zero) */
function sameSign(c) {
  let pos = false, neg = false;
  for (let i = 0; i < c.length; i++) {
    if (c[i] > 0) pos = true; else if (c[i] < 0) neg = true; else return false;   // a zero coeff decides nothing
    if (pos && neg) return false;
  }
  return true;
}
function allPositive(c) {
  for (let i = 0; i < c.length; i++) if (c[i] <= 0) return false;
  return true;
}

/** Can F=0 ∧ G≤0 be ruled out on this (u,v) box? */
function certifyBox(F, G, N, M, depth) {
  if (sameSign(F)) return true;      // boundaries never meet on this box
  if (allPositive(G)) return true;   // they could only meet at t outside [0,1]
  if (depth >= MAX_DEPTH) return false;
  const sz = (N + 1) * (M + 1);
  const Fa = new Float64Array(sz), Fb = new Float64Array(sz);
  const Ga = new Float64Array(sz), Gb = new Float64Array(sz);
  splitU(F, N, M, Fa, Fb); splitU(G, N, M, Ga, Gb);
  for (const [Fh, Gh] of [[Fa, Ga], [Fb, Gb]]) {
    const Fl = new Float64Array(sz), Fr = new Float64Array(sz);
    const Gl = new Float64Array(sz), Gr = new Float64Array(sz);
    splitV(Fh, N, M, Fl, Fr); splitV(Gh, N, M, Gl, Gr);
    if (!certifyBox(Fl, Gl, N, M, depth + 1)) return false;
    if (!certifyBox(Fr, Gr, N, M, depth + 1)) return false;
  }
  return true;
}

const _same = (a, b) => a.length === b.length
  && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9);

/**
 * Can the morphing segment (a0→a1) ever meet the morphing segment (b0→b1), for some
 * t ∈ [0,1]? Returns TRUE when it provably cannot.
 */
export function certifyNoCross(a0, a1, b0, b1) {
  const A0 = ctrlOf(a0), A1 = ctrlOf(a1), B0 = ctrlOf(b0), B1 = ctrlOf(b1);
  if (!A0 || !A1 || !B0 || !B1) return false;              // arc — not polynomial
  if (A0.length !== A1.length || B0.length !== B1.length) return false;   // topology changed
  // COINCIDENT for the whole morph (the shared-edge case: a duplicated ridge under its
  // occluder). The boundaries touch but never CROSS, so containment survives — and the
  // sign tests can never discharge it, because F ≡ 0.
  if (_same(A0, B0) && _same(A1, B1)) return true;

  const n = A0.length - 1, m = B0.length - 1;
  const W = m + 1, sz = (n + 1) * W;
  // P = A₀(u) − B₀(v), Q = A₁(u) − B₁(v), as bidegree-(n,m) grids. (Both Bernstein
  // bases are partitions of unity, so a function of u alone has coefficients constant
  // in v, and vice versa.)
  const Px = new Float64Array(sz), Py = new Float64Array(sz);
  const Qx = new Float64Array(sz), Qy = new Float64Array(sz);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const k = i * W + j;
    Px[k] = A0[i][0] - B0[j][0];  Py[k] = A0[i][1] - B0[j][1];
    Qx[k] = A1[i][0] - B1[j][0];  Qy[k] = A1[i][1] - B1[j][1];
  }
  const N2 = 2 * n, M2 = 2 * m, sz2 = (N2 + 1) * (M2 + 1);
  const t1 = new Float64Array(sz2), t2 = new Float64Array(sz2);
  const F = new Float64Array(sz2), G = new Float64Array(sz2);
  bernMul(Px, Qy, n, m, t1); bernMul(Py, Qx, n, m, t2);
  for (let i = 0; i < sz2; i++) F[i] = t1[i] - t2[i];      // cross(P, Q)
  bernMul(Px, Qx, n, m, t1); bernMul(Py, Qy, n, m, t2);
  for (let i = 0; i < sz2; i++) G[i] = t1[i] + t2[i];      // dot(P, Q)

  return certifyBox(F, G, N2, M2, 0);
}

/** Shape i's boundary can never cross shape j's, at any t. */
function noCrossAnyT(si0, si1, sj0, sj1) {
  if (si0.length !== si1.length || sj0.length !== sj1.length) return false;
  for (let a = 0; a < si0.length; a++) {
    for (let b = 0; b < sj0.length; b++) {
      if (!certifyNoCross(si0[a], si1[a], sj0[b], sj1[b])) return false;
    }
  }
  return true;
}

function bboxOf(segs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s.x0, s.x1); x1 = Math.max(x1, s.x0, s.x1);
    y0 = Math.min(y0, s.y0, s.y1); y1 = Math.max(y1, s.y0, s.y1);
  }
  return [x0, y0, x1, y1];
}

/**
 * Shapes a later opaque shape hides for the WHOLE morph, and which are therefore safe
 * to drop from the draw list for every t.
 *
 * cv0/cv1  curve floats at t=0 and t=1 (mergedCurveF32 / dstCurveF32)
 * ranges   per-shape {begin,end} into BOTH (matched shapes lerp texel-for-texel)
 * meta0/1  per-shape meta at each pose; a shape must be a plain opaque occluder in BOTH
 */
export function computeMorphOccludedShapes(cv0, cv1, ranges, meta0, meta1, n, stride) {
  const culled = new Set();
  if (!cv0 || !cv1 || !meta0 || !meta1 || !(n > 1) || n > MAX_SHAPES) return culled;
  if (!Array.isArray(ranges) || ranges.length < n) return culled;

  const cache0 = new Array(n).fill(undefined), cache1 = new Array(n).fill(undefined);
  const seg0 = (i) => (cache0[i] === undefined ? (cache0[i] = segsOf(i, cv0, ranges)) : cache0[i]);
  const seg1 = (i) => (cache1[i] === undefined ? (cache1[i] = segsOf(i, cv1, ranges)) : cache1[i]);
  // A shape with no range is a fade-in/fade-out (unmatched) — it has no t=1 geometry to
  // reason about, so neither cull it nor trust it as an occluder.
  const matched = (i) => !!(ranges[i] && ranges[i].end > ranges[i].begin);

  for (let j = n - 1; j >= 1; j--) {
    if (!matched(j)) continue;
    // Opaque at BOTH ends: an occluder that fades out hides nothing at t=1.
    if (!isPlainOpaque(meta0, stride, j) || !isPlainOpaque(meta1, stride, j)) continue;
    const sj0 = seg0(j), sj1 = seg1(j);
    if (!sj0 || !sj1) continue;

    for (let i = j - 1; i >= 0; i--) {
      if (culled.has(i) || !matched(i)) continue;
      if (hasFilter(meta0, stride, i) || hasFilter(meta1, stride, i)) continue;
      const si0 = seg0(i), si1 = seg1(i);
      if (!si0 || !si1) continue;

      const [ix0, iy0, ix1, iy1] = bboxOf(si0);
      const [jx0, jy0, jx1, jy1] = bboxOf(sj0);
      const eps = Math.max(1e-5, 1e-4 * Math.max(jx1 - jx0, jy1 - jy0));
      // Contained at BOTH endpoints…
      if (!isContained(si0, sj0, eps, ix0, iy0, ix1, iy1)) continue;
      const [ax0, ay0, ax1, ay1] = bboxOf(si1);
      const [bx0, by0, bx1, by1] = bboxOf(sj1);
      const eps1 = Math.max(1e-5, 1e-4 * Math.max(bx1 - bx0, by1 - by0));
      if (!isContained(si1, sj1, eps1, ax0, ay0, ax1, ay1)) continue;
      // …and the boundaries provably never cross in between. Endpoints alone are NOT
      // enough: an occluder can shrink faster than what it hides and expose it midway,
      // then cover it again.
      if (!noCrossAnyT(si0, si1, sj0, sj1)) continue;

      culled.add(i);
    }
  }
  return culled;
}
