// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbCoverage.glsl — the LB kind dispatch, as COVERAGE.

// Spliced textually (@@LB_COVERAGE@@), so it reads the includer's varyings
// directly instead of threading ~39 components through a signature.
//
// Returns coverage in [0,1], or discards where the fragment is another piece's
// turf (discard is legal from any function). LB_COV_WROTE_O is the debug-build
// sentinel meaning "this path already wrote `o` itself".
// No absolute floor in the gradient. Dividing by max(length(grad), 1e-6) would bind where a pixel is ~6e-7 em
// (a drawing at 2^-20) and rescale the edge's distance and normal by whatever the floor is. The floor is only a guard against an exactly zero gradient, so it is the smallest normal float32 that can be
// squared (1e-30), and the curvature is taken from the unit normal -- (Hess n.n)/|grad| -- so nothing cubes the
// gradient: |grad|^3 underflows float32 below |grad| ~ 1e-13, long before this floor.
// Coverage of a locally-straight edge, from the implicit f and its screen gradient.
// f > 0 is OUTSIDE the fill, so the fill is {p : f + ∇f·p <= 0} = {n·p <= -f/|∇f|}.
// The exact box area (~10 flops) is near-exact at every angle; a blended pair of 1D
// axis-ray coverages is exact only for axis-aligned edges (mean 10.6/255 error at 45°).
float slugCov(float f, vec2 grad) {
  float g = max(length(grad), 1e-30);
  return exactBoxCov(grad / g, -f / g);
}

// A corner combiner that is blended out costs the same as one that is used. Both the kind-10 and
// kind-12 neighbor blocks end in `mix(own, ex, g)`, where g is the corner PROXIMITY gate -- zero
// wherever the fragment is not near that end, which is most of any edge strip or curve band. The
// two exact box-coverage evaluations that build `ex` would run anyway and then be multiplied by zero.
// Gating on g is exact, not an approximation: mix(x, y, 0.0) is x*1 + y*0 = x for finite y.
#define LB_CORNER_GATE(g) ((g) > 0.0)

// Curve coverage: exact box area of the tangent half-plane, plus a mean
// curvature bias (κ/24) so convex bowls don't solid-fill the inner AA fringe.
// κ is the screen-space level-set curvature (∇²f projected); for an outward
// gradient (f>0 outside) a convex outline has κ>0 and the correction pulls
// coverage back toward the true arc. Cubic circles use the DISC SDF path;
// general quadratic outlines still use this correction.
float curveCov(float f, float fx, float fy, float fxx, float fyy, float fxy) {
  vec2 grad = vec2(fx, fy);
  float g = max(length(grad), 1e-30);
  vec2 nn = grad / g;
  float kPx = (fxx * nn.y * nn.y - 2.0 * fxy * nn.x * nn.y + fyy * nn.x * nn.x) / g;
  // Clamp: huge κ at degenerate gradients is noise, not geometry.
  kPx = clamp(kPx, -2.0, 2.0);
  return exactBoxCov(grad / g, -f / g - kPx / 24.0);
}

// ...AND THE same THING WHERE κ IS CONSTANT ALONG THE LEVEL SET, which is a circle or an annulus
// and nothing else: the recognized SDF primitives.
//
// κ/24 is the arc's mean deviation from its tangent over a chord of length ONE CENTERED ON THE FOOT
// of the perpendicular — a horizontal edge cutting straight across a pixel. Neither half of that is
// generally true. exactBoxCov integrates the half-plane {n·p ≤ d} over the unit box, and the run it
// integrates along is the segment of that line inside the box: parameterize the line as d·n + x·t
// with t = perp(n), clip x against the two slabs, and the arc's mean deviation over [x1, x2] is
// κ(x1² + x1x2 + x2²)/6 — because ∫κx²/2 dx over the chord, divided by the chord length, IS the
// offset that reproduces that area (dA/dd is exactly the chord length, in both of exactBoxCov's
// branches). Centered and unit-long, the moment is 1/24 and this is the form used.
//
// Why only here. The moment weights the chord's ENDS by x², so it is exact only if κ holds out
// there. A circle's does. A Bézier band's does not: on a parabola of curvature 0.1 to 0.8 per pixel
// the moment form is measurably WORSE than κ/24 (0.000448 against 0.000328, 0.006506 against
// 0.006016), because κ at the foot over-states the curve out in the tails. curveCov above is
// therefore untouched, and no Loop-Blinn curve band moves.
//
float arcCov(float f, float fx, float fy, float fxx, float fyy, float fxy) {
  vec2 grad = vec2(fx, fy);
  float g = max(length(grad), 1e-30);
  vec2 n = grad / g;
  float kPx = clamp((fxx * n.y * n.y - 2.0 * fxy * n.x * n.y + fyy * n.x * n.x) / g, -2.0, 2.0);
  float d = -f / g;
  // The chord's x-range, from the two slab clips. |n| == 1, so at most one component is zero and
  // that axis simply imposes no bound (or rejects the line outright).
  float lo = -1e9, hi = 1e9;
  if (abs(n.y) > 1e-9) { float u0 = (d * n.x - 0.5) / n.y, u1 = (d * n.x + 0.5) / n.y; lo = max(lo, min(u0, u1)); hi = min(hi, max(u0, u1)); }
  else if (abs(d * n.x) > 0.5) { lo = 1.0; hi = -1.0; }
  if (abs(n.x) > 1e-9) { float v0 = (-0.5 - d * n.y) / n.x, v1 = (0.5 - d * n.y) / n.x; lo = max(lo, min(v0, v1)); hi = min(hi, max(v0, v1)); }
  else if (abs(d * n.y) > 0.5) { lo = 1.0; hi = -1.0; }
  float mom = (hi > lo) ? (lo * lo + lo * hi + hi * hi) / 6.0 : 0.0;
  return exactBoxCov(n, d - kPx * mom);
}

// LB_COV_WROTE_O and LBCOV_OUT are the unified fill's shared coverage protocol and live with the
// shared varyings (@@LB_VARYINGS@@) — both routes through this stream need them, and CPatch's
// kernel is spliced before this file.

// The chain kernels' cell: em -> device pixel, the whole linear map. chainBoxCov
// clips the chain against the unit box of ONE DEVICE PIXEL, so every point has to reach pixel
// space through the map the vertex stage draws with: basePx and the world matrix's linear part,
// conjugated by the plane's y-flip so an unmirrored draw keeps em's orientation. One scalar,
// vEmPerPx, cannot describe a skew or a non-uniform scale and does not turn the box under a
// rotation -- and on a chain face taken along the chain's first POINT, the scale would move with
// where the drawing sits. A mirrored matrix is reflected once
// more on the way out: the unit box is symmetric, and the chain's fill side is em's orientation.
// Without a world matrix the chain keeps its scalar (byte-identical: the map is basePx alone).
mat2 lbChainCellMap() {
  float basePx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  mat2 W = mat2(uWorldM[0].xy, uWorldM[1].xy);
  mat2 F = mat2(1.0, 0.0, 0.0, -1.0);
  mat2 C = (F * W * F) * (1.0 / basePx);
  if (determinant(C) < 0.0) { C[0].y = -C[0].y; C[1].y = -C[1].y; }
  return C;
}
vec2 lbChainCell(vec2 p, float invE, mat2 C) {
  return (uHasWorldM == 0) ? (p - vEm) * invE : C * (p - vEm);
}
// Distance from p to the triangle a convex curve piece lies in: its chord a->b and the point q where
// its two end tangents meet (a quadratic's control point). Everything is relative to a, so a piece far
// from the origin loses nothing to cancellation. chordD is the distance to the chord itself, which is
// the answer when the tangents are near parallel or meet further out than the chord is long. The
// triangle contains the chord, so this is never more than chordD.
float lbTangentTriDist(vec2 p, vec2 ab, vec2 nA, vec2 nB, float chordD) {
  float det = nA.x * nB.y - nA.y * nB.x;
  float L = length(ab);
  if (!(abs(det) > 1e-3) || !(L > 0.0)) return chordD;
  vec2 q = vec2(-nA.y, nA.x) * (dot(nB, ab) / det);
  if (length(q - 0.5 * ab) > L) return chordD;
  vec2 qb = ab - q, pq = p - q, pb = p - ab;
  float s1 = q.x * p.y - q.y * p.x, s2 = qb.x * pq.y - qb.y * pq.x, s3 = ab.y * pb.x - ab.x * pb.y;
  if ((s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0)) return 0.0;
  float dAq = length(p - q * clamp(dot(p, q) / max(dot(q, q), 1e-30), 0.0, 1.0));
  float dQb = length(pq - qb * clamp(dot(pq, qb) / max(dot(qb, qb), 1e-30), 0.0, 1.0));
  return min(chordD, min(dAq, dQb));
}

// THE PIXEL BOX'S SHARE OF A HALF-PLANE {p : n . p <= c} (em), exact under any affine em -> pixel map: g = n . em - c is
// affine over the pixel, and its per-pixel slope is read from the em derivatives. n need not be a
// unit vector: the set, and so the share, is the same for any positive scale of (n, c). DECIDED FIRST (
// cost): the box reaches s = (|d.x| + |d.y|) / 2 along g, so g <= -s is a box wholly inside and g >= s one wholly
// outside -- exactBoxCov's own saturation, read before the normalization it needs; most fragments stop there.
float lbHalfPlaneBoxCov(vec2 n, float c, vec2 emx, vec2 emy) {
  vec2 d = vec2(dot(n, emx), dot(n, emy));
  float g = dot(n, vEm) - c, s = 0.5 * (abs(d.x) + abs(d.y));
  if (g <= -s) return 1.0;
  if (g >= s) return 0.0;
  float L = length(d);
  return exactBoxCov(d / L, -g / L);
}
// ...and of TWO: a box wholly outside either holds none of it, and a plane the box lies wholly inside cuts nothing, so
// the other one's share is the answer; the two-plane clip runs only where both cut the box.
float lbHalfPlanesBoxCov2(vec2 n1, float c1, vec2 n2, float c2, vec2 emx, vec2 emy) {
  vec2 d1 = vec2(dot(n1, emx), dot(n1, emy)), d2 = vec2(dot(n2, emx), dot(n2, emy));
  float g1 = dot(n1, vEm) - c1, g2 = dot(n2, vEm) - c2;
  float s1 = 0.5 * (abs(d1.x) + abs(d1.y)), s2 = 0.5 * (abs(d2.x) + abs(d2.y));
  bool in1 = g1 <= -s1, in2 = g2 <= -s2;
  if ((!in1 && g1 >= s1) || (!in2 && g2 >= s2)) return 0.0;
  if (in1) return lbHalfPlaneBoxCov(n2, c2, emx, emy);
  if (in2) return lbHalfPlaneBoxCov(n1, c1, emx, emy);
  float L1 = length(d1), L2 = length(d2);
  return exactBoxCov2(d1 / L1, -g1 / L1, d2 / L2, -g2 / L2);
}

#ifndef MANTLE_LB_NO_CUBIC_CHAIN
// ── exact CUBIC CHAIN ─────────────────────────────────────────
// area(box ∩ fill) where the local outline is ONE CUBIC Bezier and one straight
// segment (fill on the LEFT, the chain continued along its end tangents): the
// half-chords a → m → b of a CONCAVE piece lie on its air side, and no polyline
// through the piece's points is exact there. STREAMING, with no arrays: the chain
// is walked once and two sums carry the answer. By Green's theorem the area is
// ½∮(x dy − y dx) around the region, which is the chain's part inside the box and
// the border's part inside the fill:
//   * the chain, one sub-arc [u, v] at a time: its chord's Q(u) × Q(v), plus the
//     exact area between sub-arc and chord, 0.3 h (2 (d0 − d1) × c − h d0 × d1),
//     h = (v − u)/3, d0 = B'(u), d1 = B'(v), c = Q(v) − Q(u);
//   * the border: x dy − y dx is ½ ds on every side, so it is half the LENGTH of
//     border inside the fill -- with p the counterclockwise border parameter
//     (chainBorderParam's), Σ entry p − Σ exit p + 4 [the least-p crossing is an entry].
// area = ½ chain + ¼ border. ROBUST IN FLOAT32: the crossings are not a cubic's
// closed-form roots, whose depressed form loses every digit when the cubic term
// is small against the rest (a control point on its end would return the complement).
// Each segment is cut at its x and y extrema; on a piece monotone in both, the
// part inside the box is ONE interval, each end one slab crossing, found by a
// safeguarded Newton iteration inside a sign-change bracket. A piece end is
// classified once, from one stored point, for both pieces that share it, so the
// crossings alternate. DECIDED FIRST: a segment whose control box or fat line
// misses the box, or a piece whose end-point box (its exact bounding box) does,
// costs a few compares.
// COMPONENTIZED: the packer records whether any face carries a cubic chain (lbPack
// hasCubicChain) and the variant drops this block when none does. It lives HERE rather
// than in _boxCov.glsl because that file is assembled into every program that clips a
// box, and only this one reads a cubic chain. The CPU twin is probes/lbAccuracy/_lbBoxCov.mjs cubicChainBoxCov.
float cbEval(vec4 co, float t) { return ((co.x * t + co.y) * t + co.z) * t + co.w; }
float cbEvalD(vec4 co, float t) { return (3.0 * co.x * t + 2.0 * co.y) * t + co.z; }

float cbSolve(vec4 co, float L, float t0, float t1, float f0, float f1) {
  float tolF = 1e-6 * (1.0 + abs(co.x) + abs(co.y) + abs(co.z) + abs(co.w - L));
  float t = t0 + (t1 - t0) * clamp(f0 / (f0 - f1), 0.0, 1.0);
  for (int it = 0; it < 16; it++) {
    float ft = cbEval(co, t) - L;
    if (abs(ft) <= tolF) break;
    if ((ft < 0.0) == (f0 < 0.0)) { t0 = t; f0 = ft; } else t1 = t;
    float d = cbEvalD(co, t), dd = 6.0 * co.x * t + 2.0 * co.y;
    float den = 2.0 * d * d - ft * dd;
    float tn = den != 0.0 ? t - 2.0 * ft * d / den : -1.0;
    if (!(tn > t0 && tn < t1)) tn = 0.5 * (t0 + t1);
    t = tn;
  }
  return t;
}
// The directions a chain continues in past its ends (a control point on its end
// hands the tangent to the next one), asked for only where a chain ends in the box.
vec2 cbDirStart(vec2 A, vec2 C1, vec2 C2, vec2 B) {
  vec2 g = C1 - A;
  if (dot(g, g) <= 1e-24) g = C2 - A;
  if (dot(g, g) <= 1e-24) g = B - A;
  return g;
}
vec2 cbDirEnd(vec2 A, vec2 C1, vec2 C2, vec2 B) {
  vec2 g = B - C2;
  if (dot(g, g) <= 1e-24) g = B - C1;
  if (dot(g, g) <= 1e-24) g = B - A;
  return g;
}
// The roots in (0, 1) of A t² + B t + C, stably (2 = none): a coordinate's extrema.
vec2 cbExtrema(float A, float B, float C) {
  float disc = B * B - 4.0 * A * C;
  if (disc < 0.0) return vec2(2.0);
  float q = -0.5 * (B + (B >= 0.0 ? sqrt(disc) : -sqrt(disc)));
  float r1 = A != 0.0 ? q / A : 2.0, r2 = q != 0.0 ? C / q : 2.0;
  return vec2(r1 > 0.0 && r1 < 1.0 ? r1 : 2.0, r2 > 0.0 && r2 < 1.0 ? r2 : 2.0);
}
// A crossing on side 0 bottom, 1 right, 2 top, 3 left: the running border sums.
void cbEvent(vec2 q, int side, bool entry, inout float bsum, inout float minP, inout bool minEntry) {
  float p = side == 0 ? q.x + 0.5 : (side == 1 ? 1.5 + q.y : (side == 2 ? 2.5 - q.x : 3.5 - q.y));
  bsum += entry ? p : -p;
  if (p < minP) { minP = p; minEntry = entry; }
}
// From q (in the box) along the unit direction dn to the border: (point, side, distance).
vec4 cbToBorder(vec2 q, vec2 dn) {
  float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - q.x) / dn.x : 1e9;
  float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - q.y) / dn.y : 1e9;
  if (tx <= ty) return vec4(dn.x > 0.0 ? 0.5 : -0.5, clamp(q.y + dn.y * tx, -0.5, 0.5), dn.x > 0.0 ? 1.0 : 3.0, tx);
  return vec4(clamp(q.x + dn.x * ty, -0.5, 0.5), dn.y > 0.0 ? 0.5 : -0.5, dn.y > 0.0 ? 2.0 : 0.0, ty);
}
// p0..p4: the cubic p0 C p1 C p2 → p3 then the line p3 → p4 (lineFirst false, the
// builder's sentinel 4), or the line p0 → p1 then the cubic p1 C p2 C p3 → p4
// (lineFirst true, sentinel 5); in CELL coordinates. forceInside as chainBoxCov.
float cubicChainBoxCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4, bool lineFirst, float forceInside) {
  vec2 cA = lineFirst ? p1 : p0, cC1 = lineFirst ? p2 : p1, cC2 = lineFirst ? p3 : p2, cB = lineFirst ? p4 : p3;
  vec2 lA = lineFirst ? p0 : p3, lB = lineFirst ? p1 : p4;
  vec2 cd = cB - cA, c1d = cC1 - cA, c2d = cC2 - cA, ld = lB - lA;
  bool cubOn = !(dot(cd, cd) < 1e-12 && dot(c1d, c1d) < 1e-12 && dot(c2d, c2d) < 1e-12), linOn = !(dot(ld, ld) < 1e-12);
  // Segment s = 0 comes first along the chain; it starts at the first present, ends at the last.
  int sFirst = (lineFirst ? linOn : cubOn) ? 0 : 1, sLast = (lineFirst ? cubOn : linOn) ? 1 : 0;
  float area2 = 0.0, bsum = 0.0, minP = 8.0;
  bool minEntry = false, hit = false, open = false, pend = false;
  vec2 pendQ = vec2(0.0);
  int pendSide = -1;
  for (int s = 0; s < 2; s++) {
    bool cub = lineFirst ? s == 1 : s == 0;
    if (!(cub ? cubOn : linOn)) continue;
    vec2 A = cub ? cA : lA, B = cub ? cB : lB, C1 = cub ? cC1 : lA, C2 = cub ? cC2 : lB;
    vec2 lo = min(min(A, B), min(C1, C2)), hi = max(max(A, B), max(C1, C2));
    if (hi.x < -0.5 || lo.x > 0.5 || hi.y < -0.5 || lo.y > 0.5) continue;
    // ...and its FAT LINE (Sederberg): the arc keeps within 3/4 of its control
    // points' distances from its chord (4/9 when they are on opposite sides), so a
    // box wholly past that slab misses it; a line's slab has no width. A segment
    // with an end in the box is never cut here: a chain arriving inside finds it.
    if (max(abs(A.x), abs(A.y)) > 0.5 && max(abs(B.x), abs(B.y)) > 0.5) {
      vec2 n = vec2(A.y - B.y, B.x - A.x);
      float d1 = dot(n, C1 - A), d2 = dot(n, C2 - A);
      float fl = d1 * d2 > 0.0 ? 0.75 : 0.4444444444444444;
      float cd = -dot(n, A), sup = 0.5 * (abs(n.x) + abs(n.y));
      if (cd - sup > fl * max(0.0, max(d1, d2)) || cd + sup < fl * min(0.0, min(d1, d2))) continue;
    }
    // Power basis per coordinate (t³, t², t, 1); a line has no t² or t³ term.
    vec2 k3 = cub ? -A + 3.0 * C1 - 3.0 * C2 + B : vec2(0.0), k2 = cub ? 3.0 * A - 6.0 * C1 + 3.0 * C2 : vec2(0.0);
    vec2 k1 = cub ? 3.0 * (C1 - A) : B - A;
    vec4 cx = vec4(k3.x, k2.x, k1.x, A.x), cy = vec4(k3.y, k2.y, k1.y, A.y);
    // The pieces: cut at the x and y extrema, in order (a 4-value sorting network).
    vec2 ex = cub ? cbExtrema(3.0 * cx.x, 2.0 * cx.y, cx.z) : vec2(2.0), ey = cub ? cbExtrema(3.0 * cy.x, 2.0 * cy.y, cy.z) : vec2(2.0);
    float sa = min(ex.x, ex.y), sb = max(ex.x, ex.y), sc = min(ey.x, ey.y), sd = max(ey.x, ey.y);
    float sm1 = max(sa, sc), sm2 = min(sb, sd);
    vec4 sp = vec4(min(sa, sc), min(sm1, sm2), max(sm1, sm2), max(sb, sd));
    float ta = 0.0;
    vec2 Pa = A;
    for (int k = 0; k < 5; k++) {
      float tb = k == 0 ? sp.x : (k == 1 ? sp.y : (k == 2 ? sp.z : (k == 3 ? sp.w : 1.0)));
      tb = min(tb, 1.0);
      if (!(tb > ta)) continue;
      vec2 Pb = tb < 1.0 ? vec2(cbEval(cx, tb), cbEval(cy, tb)) : B;
      float t0 = ta;
      vec2 Q0a = Pa;
      ta = tb; Pa = Pb;
      if (max(Q0a.x, Pb.x) < -0.5 || min(Q0a.x, Pb.x) > 0.5 || max(Q0a.y, Pb.y) < -0.5 || min(Q0a.y, Pb.y) > 0.5) continue;
      // The x slab: x is monotone, so |x| <= ½ on [tl, th], each end a crossing or the piece's own.
      float tl = t0, th = tb, fa = Q0a.x, fb = Pb.x;
      int lSide = -1, hSide = -1;
      if (fb >= fa) {
        if (fa < -0.5) { tl = cbSolve(cx, -0.5, t0, tb, fa + 0.5, fb + 0.5); lSide = 3; }
        if (fb > 0.5) { th = cbSolve(cx, 0.5, t0, tb, fa - 0.5, fb - 0.5); hSide = 1; }
      } else {
        if (fa > 0.5) { tl = cbSolve(cx, 0.5, t0, tb, fa - 0.5, fb - 0.5); lSide = 1; }
        if (fb < -0.5) { th = cbSolve(cx, -0.5, t0, tb, fa + 0.5, fb + 0.5); hSide = 3; }
      }
      // ...and inside it the y slab, from y at its two ends (y is monotone too).
      float ya = lSide < 0 ? Q0a.y : cbEval(cy, tl), yb = hSide < 0 ? Pb.y : cbEval(cy, th);
      float u = tl, v = th;
      int uSide = lSide, vSide = hSide;
      if (yb >= ya) {
        if (yb < -0.5 || ya > 0.5) continue;
        if (ya < -0.5) { u = cbSolve(cy, -0.5, tl, th, ya + 0.5, yb + 0.5); uSide = 0; }
        if (yb > 0.5) { v = cbSolve(cy, 0.5, tl, th, ya - 0.5, yb - 0.5); vSide = 2; }
      } else {
        if (ya < -0.5 || yb > 0.5) continue;
        if (ya > 0.5) { u = cbSolve(cy, 0.5, tl, th, ya - 0.5, yb - 0.5); uSide = 2; }
        if (yb < -0.5) { v = cbSolve(cy, -0.5, tl, th, ya + 0.5, yb + 0.5); vSide = 0; }
      }
      // The crossing points: the line's own coordinate, and the other one -- already in hand (ya, yb) where the x
      // slab crossing is the interval's end.
      vec2 Q0 = Q0a, Q3 = Pb;
      if (uSide == 1 || uSide == 3) Q0 = vec2(uSide == 1 ? 0.5 : -0.5, clamp(ya, -0.5, 0.5));
      else if (uSide >= 0) Q0 = vec2(clamp(cbEval(cx, u), -0.5, 0.5), uSide == 2 ? 0.5 : -0.5);
      if (vSide == 1 || vSide == 3) Q3 = vec2(vSide == 1 ? 0.5 : -0.5, clamp(yb, -0.5, 0.5));
      else if (vSide >= 0) Q3 = vec2(clamp(cbEval(cx, v), -0.5, 0.5), vSide == 2 ? 0.5 : -0.5);
      bool zero = !(v > u);
      // Where the interval starts. One of no length is the chain touching the border
      // at a point: no area, and its crossings are a pair to drop (it arrived and
      // left at once) or the entry of a chain that goes on inside from the next
      // piece -- held until that piece shows which.
      bool atEnd = tb == 1.0 && s == sLast;
      if (uSide >= 0) {
        if (zero) {
          if (vSide >= 0) continue;
          if (!atEnd) { pend = true; pendQ = Q0; pendSide = uSide; continue; }
          // The chain arrives at the border exactly at its END: its tangent may still cross the box.
          vec4 r = cbToBorder(Q0, normalize(cbDirEnd(A, C1, C2, B)));
          if (!(r.w >= 1e-6)) continue;
          cbEvent(Q0, uSide, true, bsum, minP, minEntry);
          area2 += Q0.x * r.y - Q0.y * r.x;
          cbEvent(r.xy, int(r.z), false, bsum, minP, minEntry);
          hit = true;
          continue;
        }
        cbEvent(Q0, uSide, true, bsum, minP, minEntry);
      } else if (!(t0 == 0.0 && s == sFirst)) {
        if (zero) { if (vSide >= 0 && open) { cbEvent(Q3, vSide, false, bsum, minP, minEntry); open = false; } pend = false; continue; }
        if (pend) { cbEvent(pendQ, pendSide, true, bsum, minP, minEntry); pend = false; }
      } else {
        // The chain STARTS inside -- or on the border, leaving at once, where its tangent may still cross the box.
        vec4 r = cbToBorder(Q0, normalize(-cbDirStart(A, C1, C2, B)));
        if (zero) {
          if (!(vSide >= 0 && r.w >= 1e-6)) continue;
          cbEvent(r.xy, int(r.z), true, bsum, minP, minEntry);
          area2 += r.x * Q3.y - r.y * Q3.x;
          cbEvent(Q3, vSide, false, bsum, minP, minEntry);
          hit = true;
          continue;
        }
        area2 += r.x * Q0.y - r.y * Q0.x;
        cbEvent(r.xy, int(r.z), true, bsum, minP, minEntry);
      }
      open = true; hit = true;
      area2 += Q0.x * Q3.y - Q0.y * Q3.x;
      if (cub) {
        vec2 d0 = vec2(cbEvalD(cx, u), cbEvalD(cy, u)), d1 = vec2(cbEvalD(cx, v), cbEvalD(cy, v)), c = Q3 - Q0, dd = d0 - d1;
        float h = (v - u) / 3.0;
        area2 += 0.3 * h * (2.0 * (dd.x * c.y - dd.y * c.x) - h * (d0.x * d1.y - d0.y * d1.x));
      }
      // ...AND WHERE IT ENDS: a crossing, the chain's own end inside the box, or the next piece.
      if (vSide >= 0) { cbEvent(Q3, vSide, false, bsum, minP, minEntry); open = false; }
      else if (atEnd) {
        vec4 r = cbToBorder(Q3, normalize(cbDirEnd(A, C1, C2, B)));
        area2 += Q3.x * r.y - Q3.y * r.x;
        cbEvent(r.xy, int(r.z), false, bsum, minP, minEntry);
        open = false;
      }
    }
  }
  if (!hit) {
    if (forceInside < 1.5) return forceInside > 0.5 ? 1.0 : 0.0;
    // A box the arc misses lies wholly on one side of it, and an interior face's
    // pixel is on the fill side: its answer is 1. The straight segment keeps
    // chainBoxCov's linear miss where its nearest point is its own interior -- at
    // its joint with the arc the arc answers, and past its open end nothing does.
    vec2 A = lineFirst ? p0 : p3, B = lineFirst ? p1 : p4;
    vec2 d = B - A; float L2 = dot(d, d);
    if (L2 < 1e-20) return 1.0;
    float tu = dot(-A, d) / L2;
    if (!(tu > 0.0 && tu < 1.0)) return 1.0;
    vec2 c = A + tu * d;
    if (dot(c, c) > 2.0) return 1.0;
    vec2 nOut = normalize(vec2(d.y, -d.x));
    return exactBoxCov(nOut, dot(nOut, A));
  }
  return clamp(0.5 * area2 + 0.25 * (bsum + (minEntry ? 4.0 : 0.0)), 0.0, 1.0);
}
#endif  // MANTLE_LB_NO_CUBIC_CHAIN

float lbCoverage() {
#ifdef MANTLE_CPATCH
  // A DIFFERENT ENGINE, sharing this stream — asked in CPatch's own terms, not as a Loop-Blinn
  // kind. Everything past this point is Loop-Blinn's and knows nothing about CPatch.
  if (CP_IS_CPATCH_VERTEX) return cpatchCoverage();
#endif

#ifndef MANTLE_LB_NO_EDGE_STRIP
  if (LB_IS_EDGE_STRIP) {
    vec2 p1k = cCen, p2k = vec2(cScale, cHalf);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-30);
    vec2 nOwn = vec2(-tdk.y, tdk.x) * vSign;
    float fOwn = dot(nOwn, vEm - p1k);
    float codeA = floor((vSeam + 0.5) / 16.0), codeB = vSeam - codeA * 16.0;
    float tyA = floor((codeA + 0.5) / 4.0) - 1.0; bool curveA = mod(codeA, 4.0) >= 1.5;
    float tsA = mod(codeA, 2.0);
    float tyB = floor((codeB + 0.5) / 4.0) - 1.0; bool curveB = mod(codeB, 4.0) >= 1.5;
    float tsB = mod(codeB, 2.0);
    vec2 rA = vEm - p1k, rB = vEm - p2k;
    vec2 wA, wB;

    vec4 q10 = (gl_FragCoord.xyxy + uFragOrigin.xyxy - vec4(vLB1.xy, vLB2.xy)) * vec4(vLB1.zw, vLB2.zw);
    vec2 s10 = q10.xz + q10.yw;
    bool shA10 = dot(vLB1.zw, vLB1.zw) > 0.0, shB10 = dot(vLB2.zw, vLB2.zw) > 0.0;
    if (curveA) { wA = vec2(-vNa.y, vNa.x) * (tsA > 0.5 ? 1.0 : -1.0);
      if (dot(rA, wA) >= 0.0 && length(rA) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else {
      // Line neighbor. Acute tips (nOwn·nN < −0.35): bisector |nOwn+nN| collapses —
      // START owns the exterior tip bulb (no bisector cull there); END cedes it.
      float nDotA = dot(nOwn, vNa);
      bool acuteA = tyA > 0.5 && nDotA < -0.35;
      vec2 sumA = nOwn + vNa;
      bool degenA = dot(sumA, sumA) < 0.08;
      bool tipA = acuteA && fOwn > 0.0 && length(rA) < 2.2 * vEmPerPx;
      if (!(tipA && (acuteA || degenA))) {
        if (shA10) {
          if (s10.x < 0.0) discard;
        } else {
          wA = degenA ? vec2(-nOwn.y, nOwn.x) : vec2(-sumA.y, sumA.x);
          if (dot(wA, tdk) < 0.0) wA = -wA;
          if (dot(rA, wA) < 0.0) discard;
        }
      }
    }
    if (curveB) { wB = vec2(-vNb.y, vNb.x) * (tsB > 0.5 ? 1.0 : -1.0);
      if (dot(rB, wB) >= 0.0 && length(rB) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else {
      float nDotB = dot(nOwn, vNb);
      bool acuteB = tyB > 0.5 && nDotB < -0.35;

      if (acuteB && fOwn > 0.0 && dot(vNb, rB) > 0.0 && length(rB) < 2.2 * vEmPerPx) discard;
      else if (shB10) {
        if (s10.y >= 0.0) discard;
      } else {
        vec2 sumB = nOwn + vNb;
        bool degenB = dot(sumB, sumB) < 0.08;
        wB = degenB ? vec2(-nOwn.y, nOwn.x) : vec2(-sumB.y, sumB.x);
        if (dot(wB, tdk) < 0.0) wB = -wB;
        if (dot(rB, wB) >= 0.0) discard;
      }
    }
    float fA = dot(vNa, rA) - 0.5 * vTC.y * dot(rA, rA);
    float fB = dot(vNb, rB) - 0.5 * vTC.z * dot(rB, rB);

    float tipGateA = (tyA > 0.5 && !curveA && dot(nOwn, vNa) < -0.35) ? 2.2 : 2.0;
    float tipGateB = (tyB > 0.5 && !curveB && dot(nOwn, vNb) < -0.35) ? 2.2 : 2.0;
    float gA = clamp((tipGateA - length(rA) / vEmPerPx) / 1.5, 0.0, 1.0);
    float gB = clamp((tipGateB - length(rB) / vEmPerPx) / 1.5, 0.0, 1.0);

    float sOwn = fOwn < -0.012 * vEmPerPx ? 1.0 : 0.0;
    float sA = fA < 0.0 ? 1.0 : 0.0, sB = fB < 0.0 ? 1.0 : 0.0;
    float sAe = tyA > 0.5 ? (gA > 0.01 ? sA : 1.0) : (gA > 0.01 ? sA : 0.0);
    float sBe = tyB > 0.5 ? (gB > 0.01 ? sB : 1.0) : (gB > 0.01 ? sB : 0.0);
    float insid = sOwn;
    insid = tyA > 0.5 ? min(insid, sAe) : (tyA < -0.5 ? max(insid, sAe) : insid);
    insid = tyB > 0.5 ? min(insid, sBe) : (tyB < -0.5 ? max(insid, sBe) : insid);
    if (insid > 0.5) discard;
    // Corner coverage via the exact two-plane box area (exactBoxCov2), the same
    // kernel INTERIOR uses: intersection (convex/tip) and union (reflex) of the own
    // and neighbor half-planes are computed directly, so acute tips, near-parallel
    // continuations and nested cuts all fall out of one formula — no per-case
    // covA+covB−1 / min / kp-mix interpolation. The gA/gB proximity gate keeps its
    // original coverage-space semantics: the exact combined result blends back to
    // the ungated own coverage away from the corner, where the neighbor's
    // boundary does not exist. Chained ends compose by inclusion–exclusion
    // against the pristine own coverage (exact when only one end is near, the
    // common case).
    float invPx10 = 1.0 / max(vEmPerPx, 1e-30);
    float dOwn10 = -fOwn * invPx10;
    float c10 = exactBoxCov(nOwn, dOwn10);
    float cOwnP10 = c10;
    if (abs(tyA) > 0.5 && LB_CORNER_GATE(gA)) {
      vec2 nA10 = vNa / max(length(vNa), 1e-9);
      float dA10 = -fA * invPx10;
      float cA10 = exactBoxCov(nA10, dA10);
      float interA = exactBoxCov2(nOwn, dOwn10, nA10, dA10);
      float kpA = max(0.0, dot(nOwn, vNa));
      float exA = tyA > 0.0
        ? mix(clamp(c10 + interA - cOwnP10, 0.0, 1.0), min(c10, cA10), kpA)
        : mix(clamp(c10 + cA10 - interA, 0.0, 1.0), max(c10, cA10), kpA);
      c10 = mix(c10, exA, gA);
    }
    if (abs(tyB) > 0.5 && LB_CORNER_GATE(gB)) {
      vec2 nB10 = vNb / max(length(vNb), 1e-9);
      float dB10 = -fB * invPx10;
      float cB10 = exactBoxCov(nB10, dB10);
      float interB = exactBoxCov2(nOwn, dOwn10, nB10, dB10);
      float kpB = max(0.0, dot(nOwn, vNb));
      float exB = tyB > 0.0
        ? mix(clamp(c10 + interB - cOwnP10, 0.0, 1.0), min(c10, cB10), kpB)
        : mix(clamp(c10 + cB10 - interB, 0.0, 1.0), max(c10, cB10), kpB);
      c10 = mix(c10, exB, gB);
    }
    // KIND-10 CLAIM RULE (the depth-claim contract): an edge strip fragment
    // that emits ~nothing must not WRITE DEPTH — its zero-coverage zones (the
    // chained-corner union/intersection identities) would otherwise claim
    // junction pixels at the piece tier and reject the interior's full
    // coverage beneath, punching holes at stem junctions.
    if (c10 < 0.004) discard;
    // No fill-side cession (`fOwn < 0 && c10 < 0.999 -> discard`, leaving fill-side partials to the
    // interior mesh). This quad lies wholly on the air side of its edge -- its inner vertices ARE the
    // edge's endpoints and the vertex stage pushes only along the outward normal and the tangent -- so fOwn < 0 is only
    // ever a pixel center ON the edge, read a hair inside by the interpolation, and the rasterizer gives that center to
    // exactly one of the two primitives that share the edge. When it chooses this strip, ceding it would leave the pixel with
    // no painter along edges whose pixel centers sit exactly on them. Ownership is the rasterizer's partition.
    return c10;
  }
#endif
#ifndef MANTLE_NO_BEZOUT
  // Unified curve band (CURVE_BAND): quads/rquads and cubic exterior rings.
  // Quad: aTC=(Ũ,Ṽ,R). Cubic (|vSign|≥8192): aTC=(k,l,m), Δklm via aC0 packHalf;
  // optional end chaining when aC3=(a,b) is packed.
  // COMPONENTIZED (MANTLE_LB_NO_CURVE_BAND). This is the LARGEST per-kind block in
  // the kernel (~192 of 677 lines), omittable like DISC, EDGE_STRIP and CHAIN_STRIP. It
  // sits inside MANTLE_NO_BEZOUT, but that flag drops the whole Bezout tier rather than
  // this kind, so without its own guard a bundle with no band pieces would pay for it.
#ifndef MANTLE_LB_NO_CURVE_BAND
  if (LB_IS_CURVE_BAND) {
    float mag12 = abs(vSign);
    float s12 = vSign >= 0.0 ? 1.0 : -1.0;
    bool cubic12 = false;
    if (mag12 >= 8192.0) { cubic12 = true; mag12 -= 8192.0; }
    if (mag12 >= 4096.0) mag12 -= 4096.0;
    float spanB12 = 0.0, spanA12 = 0.0;
    if (mag12 >= 2048.0) { spanB12 = 1.0; mag12 -= 2048.0; }
    if (mag12 >= 1024.0) { spanA12 = 1.0; mag12 -= 1024.0; }
    float codeA = floor((mag12 + 0.5) / 16.0), codeB = mag12 - codeA * 16.0;
    float tyA = floor((codeA + 0.5) / 4.0) - 1.0; bool curveA = mod(codeA, 4.0) >= 1.5;
    float tyB = floor((codeB + 0.5) / 4.0) - 1.0; bool curveB = mod(codeB, 4.0) >= 1.5;
    vec2 a12 = cCen, b12 = vec2(cScale, cHalf);
    vec2 rA = vEm - a12, rB = vEm - b12;
    vec2 nA12 = cM01.yz, nB12 = cM02.xy;
    // aC2 = (packHalf(nOwnA), packHalf(nOwnB), κA, κB) — κ mixed for morph pairs.
    vec2 nOA = unpackHalf2x16(floatBitsToUint(cM02.z));
    vec2 nOB = unpackHalf2x16(floatBitsToUint(cM11a));
    float kA12 = cM12, kB12 = cM22;
    bool ends12 = cubic12 && dot(a12, a12) + dot(b12, b12) > 0.0;

    vec3 tx12d = dFdx(vTC), ty12d = dFdy(vTC);

    vec2 emx12 = dFdx(vEm), emy12 = dFdy(vEm);
    // The band's bound. The ring reaches the box filter's own distance (lbBoxReach), so a pixel whose box
    // only grazes the hull edge reaches this fragment; what it may claim is bounded by the box's exact share of a region
    // its own piece's ink is known to lie in:
    //   mode 1, a klm ring: n . p <= c, the arc's support along the ring's unit normal (the packer's cubicSupport9);
    //   mode 2, a quad band: a CONVEX arc's ink is its conic's inside, a convex set, so it lies inside the tangent
    //     half-planes at both ends (through a and b, with the arc's own outward normals there); a CONCAVE arc's ink
    //     lies on the control side of its chord.
    // Mode 0 (a morph draw, whose bound would need both poses' support): unbounded, as before.
    float bound12 = 1.0;
    if (vLB0.w > 0.5 && vLB0.w < 1.5) {
      bound12 = lbHalfPlaneBoxCov(vLB0.xy, vLB0.z, emx12, emy12);
    } else if (vLB0.w > 1.5 && dot(nOA, nOA) > 0.0 && dot(nOB, nOB) > 0.0 && dot(b12 - a12, b12 - a12) > 0.0) {
      // (Planes are scale-free, so the normals go in as they are.)
      if (dot(nOA, b12 - a12) < 0.0) {
        bound12 = lbHalfPlanesBoxCov2(nOA, dot(nOA, a12), nOB, dot(nOB, b12), emx12, emy12);
      } else {
        vec2 ch12 = b12 - a12, nC12 = vec2(ch12.y, -ch12.x);
        if (dot(nC12, nOA) < 0.0) nC12 = -nC12;   // outward, as the arc's own normal at a
        bound12 = lbHalfPlaneBoxCov(nC12, dot(nC12, a12), emx12, emy12);
      }
    }
    if (cubic12 && !ends12) {
      float k12 = vTC.x, l12 = vTC.y, m12 = vTC.z;
      float f12c = s12 * (k12 * k12 * k12 - l12 * m12);
      vec3 tx12c = tx12d, ty12c = ty12d;
      float fx12c = s12 * (3.0 * k12 * k12 * tx12c.x - (tx12c.y * m12 + l12 * tx12c.z));
      float fy12c = s12 * (3.0 * k12 * k12 * ty12c.x - (ty12c.y * m12 + l12 * ty12c.z));
      float fxx12c = s12 * (6.0 * k12 * tx12c.x * tx12c.x - 2.0 * tx12c.y * tx12c.z);
      float fyy12c = s12 * (6.0 * k12 * ty12c.x * ty12c.x - 2.0 * ty12c.y * ty12c.z);
      float fxy12c = s12 * (6.0 * k12 * tx12c.x * ty12c.x - (tx12c.y * ty12c.z + ty12c.y * tx12c.z));
      float c12c = min(curveCov(f12c, fx12c, fy12c, fxx12c, fyy12c, fxy12c), bound12);
      if (c12c < 0.999 && f12c < 0.0) discard;
      if (c12c < 0.004) discard;
      return c12c;
    }

    float u12 = vTC.x, v12 = vTC.y, r12 = vTC.z;
    // The hull's turf: the control triangle's closed image in the piece's own frame (u, v) = (U, V) / R, the same triangle for every
    // weight. A band's R is pushed with U and V (the vertex stage, static and morph alike: both poses of a pair share the weight,
    // so one factor serves every lerped frame), so the test is exact.
    if (!cubic12 && r12 > 0.0) {
      float hu12 = u12 / r12, hv12 = v12 / r12;
      if (hv12 >= 0.0 && hu12 >= hv12 && 1.0 - 2.0 * hu12 + hv12 >= 0.0) discard;
    }
    vec2 sA12 = vec2(-nOA.y, nOA.x) * (spanA12 > 0.5 ? 1.0 : -1.0);   // into-arc tangent at a
    vec2 sB12 = vec2(-nOB.y, nOB.x) * (spanB12 > 0.5 ? 1.0 : -1.0);   // into-arc tangent at b
    // A PIECE THAT TURNS PAST A RIGHT ANGLE (end normals more than 90 degrees apart). The end tests below cut a pixel behind an
    // end's normal line, and the pixels whose nearest arc point lies in the piece are the ones between the two end normal
    // lines only while it turns less than 90 degrees: past that the arc itself crosses the normal line at its own start, and
    // the region its outward normals sweep wraps around that line (an 80:1 ellipse's tip arc turns about 160 degrees within a
    // fraction of its length, and its flank pixels lay behind the start's normal line). The swept region is exact on each side
    // of the normal line at the arc point whose normal bisects the two end normals -- each half turns less than 90 degrees, so
    // the half-plane of its own end holds -- so an end test applies on its own side of that line only (aSide12, bSide12).
    // That point is the conic's, in closed form. A rational quad with end tangents u = c - a, v = b - c and weight w has its
    // tangent at parameter s along p1 u + p2 v, p1 = (1-s)(w(1-s)+s), p2 = s(1-s+ws), so the bisecting normal (equal and
    // opposite on the two end tangents) has p1 |u| = p2 |v|: a quadratic in r = s/(1-s), and the point is
    // a + (u (2wr+r^2) + v r^2) / (1+2wr+r^2). The control point c is where the end tangents meet; w is read off the field's own
    // frame (U = 1/(2w) at c, and U is affine in the plane). No stored datum and no tolerance: a lerped morph piece reads the
    // frame it is drawn in.
    bool aSide12 = true, bSide12 = true;
    if (!cubic12 && dot(nOA, nOB) < 0.0) {
      vec2 ab12 = b12 - a12;
      float sinT12 = sB12.x * sA12.y - sB12.y * sA12.x;                // sin of the angle between the end tangents
      float detEm12 = emx12.x * emy12.y - emx12.y * emy12.x;
      float lam12 = (sB12.x * ab12.y - sB12.y * ab12.x) / sinT12;      // a to c along sA
      vec2 c12 = a12 + lam12 * sA12;
      vec2 gU12 = vec2(tx12d.x * emy12.y - emx12.y * ty12d.x, emx12.x * ty12d.x - emy12.x * tx12d.x) / detEm12;   // dU/d(em)
      float uc12 = u12 + dot(gU12, c12 - vEm);
      vec2 nM12 = nOA + nOB;
      float k0 = length(c12 - a12), k1 = length(b12 - c12);
      if (uc12 > 0.0 && lam12 > 0.0 && dot(nM12, nM12) > 0.0 && k0 > 0.0 && k1 > 0.0) {
        float w12 = 0.5 / uc12;
        nM12 = normalize(nM12);
        float dk12 = k0 - k1;
        float r12m = (dk12 + sqrt(dk12 * dk12 + 4.0 * k0 * k1 * w12 * w12)) / (2.0 * k1 * w12);
        float wr12 = 1.0 + 2.0 * w12 * r12m + r12m * r12m;
        vec2 qm12 = ((2.0 * w12 * r12m + r12m * r12m) * (c12 - a12) + r12m * r12m * (b12 - c12)) / wr12;   // the point, from a
        float off12 = nM12.x * qm12.y - nM12.y * qm12.x;
        float sgnB12 = (nM12.x * ab12.y - nM12.y * ab12.x) - off12 < 0.0 ? -1.0 : 1.0;   // the side b is on
        float side12 = ((nM12.x * rA.y - nM12.y * rA.x) - off12) * sgnB12;                // this pixel's, positive toward b
        aSide12 = side12 <= 0.0;
        bSide12 = side12 > 0.0;
      }
    }
    // Own field: quad f = Ũ²−Ṽ·R; cubic f = k³−lm. Curvature-aware coverage.
    float f12, fx12, fy12, fxx12, fyy12, fxy12;
    if (cubic12) {
      float k12 = u12, l12 = v12, m12 = r12;
      f12 = s12 * (k12 * k12 * k12 - l12 * m12);
      vec3 tx12 = tx12d, ty12 = ty12d;
      fx12 = s12 * (3.0 * k12 * k12 * tx12.x - (tx12.y * m12 + l12 * tx12.z));
      fy12 = s12 * (3.0 * k12 * k12 * ty12.x - (ty12.y * m12 + l12 * ty12.z));
      fxx12 = s12 * (6.0 * k12 * tx12.x * tx12.x - 2.0 * tx12.y * tx12.z);
      fyy12 = s12 * (6.0 * k12 * ty12.x * ty12.x - 2.0 * ty12.y * ty12.z);
      fxy12 = s12 * (6.0 * k12 * tx12.x * ty12.x - (tx12.y * ty12.z + ty12.y * tx12.z));
    } else {
      f12 = s12 * (u12 * u12 - v12 * r12);
      vec3 tx12 = tx12d, ty12 = ty12d;
      fx12 = s12 * (2.0 * u12 * tx12.x - (tx12.y * r12 + v12 * tx12.z));
      fy12 = s12 * (2.0 * u12 * ty12.x - (ty12.y * r12 + v12 * ty12.z));
      fxx12 = s12 * (2.0 * tx12.x * tx12.x - 2.0 * tx12.y * tx12.z);
      fyy12 = s12 * (2.0 * ty12.x * ty12.x - 2.0 * ty12.y * ty12.z);
      fxy12 = s12 * (2.0 * tx12.x * ty12.x - (tx12.y * ty12.z + ty12.y * tx12.z));
    }
    float dpx12 = f12 / max(length(vec2(fx12, fy12)), 1e-30);   // signed px distance to the arc
    // END PARTITIONS + CORNER COVERAGE (Loop §5.1 geometry, Mantle exactBoxCov AA).
    //
    // Packer sets |type|>0 only for sharp banded-curve neighbors (chain). Line ends
    // stay type 0 → span-clip, matching CURVE_BAND and complementary to EDGE_STRIP's cession
    // at the arc tangent plane. Chaining line ends through a bisector∩line combine
    // under-covered tip bulbs outside the line half-plane but on the arc exterior.
    //
    // Partition: watertight bisector perp(nOwn+nN) when normals are not antiparallel
    // (|nOwn+nN|²→0); else own span. In-span own model: Loop f → curveCov.
    // Wedge own model: osculating line (quadratic extrapolation wraps).
    // Corner coverage: intersecting-lines combine (EDGE_STRIP/12) via slugCov.
    bool chainA = abs(tyA) > 0.5, chainB = abs(tyB) > 0.5;
    if (!chainA) { if (aSide12 && dot(rA, sA12) < 0.0) discard; }
    else if (aSide12) {
      vec2 bisA = nOA + nA12;
      if (dot(bisA, bisA) > 1e-6) {
        vec2 wA12 = vec2(-bisA.y, bisA.x);
        if (dot(rA, wA12) * dot(wA12, sA12) < 0.0) discard;
      } else if (dot(rA, sA12) < 0.0) discard;
    }
    if (!chainB) { if (bSide12 && dot(rB, sB12) < 0.0) discard; }
    else if (bSide12) {
      vec2 bisB = nOB + nB12;
      if (dot(bisB, bisB) > 1e-6) {
        vec2 wB12 = vec2(-bisB.y, bisB.x);
        if (dot(rB, wB12) * dot(wB12, sB12) <= 0.0) discard;
      } else if (dot(rB, sB12) < 0.0) discard;
    }
    bool wgA = chainA && aSide12 && dot(rA, sA12) < 0.0;
    bool wgB = chainB && bSide12 && dot(rB, sB12) < 0.0;
    // Own boundary as a box-coverage PLANE (normal + pixel offset): in-span, the
    // curvature-adjusted tangent curveCov integrates (same offset −f/|∇f| − κ/24);
    // in a wedge, the osculating line. Keeping the plane form (not just its
    // coverage) lets the end combine below use the exact two-plane box area.
    float fA12 = dot(nA12, rA) - 0.5 * kA12 * dot(rA, rA);
    float fB12 = dot(nB12, rB) - 0.5 * kB12 * dot(rB, rB);
    float gL12 = max(length(vec2(fx12, fy12)), 1e-30);   // no absolute floor; the curvature from the unit normal
    vec2 nG12 = vec2(fx12, fy12) / gL12;
    float kOwnS12 = (fxx12 * nG12.y * nG12.y - 2.0 * fxy12 * nG12.x * nG12.y + fyy12 * nG12.x * nG12.x) / gL12;
    float kOwnPx = abs(kOwnS12);
    float fOwn12;
    vec2 nOwn12;
    float dOwn12;
    if (wgA || wgB) {
      vec2 nOw = wgA ? nOA : nOB;
      vec2 rw = wgA ? rA : rB;
      fOwn12 = dot(nOw, rw);
      vec2 gOw = vec2(dot(nOw, emx12), dot(nOw, emy12));   // the osculating line in the window frame
      float gOwL = max(length(gOw), 1e-30);
      nOwn12 = gOw / gOwL;
      dOwn12 = -fOwn12 / gOwL;
    } else {
      fOwn12 = f12;
      nOwn12 = vec2(fx12, fy12) / gL12;
      dOwn12 = -f12 / gL12 - clamp(kOwnS12, -2.0, 2.0) / 24.0;
    }
    float cOwn12 = min(exactBoxCov(nOwn12, dOwn12), bound12);
    float rgA12 = 0.5 / max(max(abs(kA12) * vEmPerPx, 1e-6), kOwnPx);
    float rgB12 = 0.5 / max(max(abs(kB12) * vEmPerPx, 1e-6), kOwnPx);
    float gA12 = clamp(rgA12 - length(rA) / vEmPerPx, 0.0, 1.0);
    float gB12 = clamp(rgB12 - length(rB) / vEmPerPx, 0.0, 1.0);
    bool cnA = abs(tyA) > 0.5, cnB = abs(tyB) > 0.5;
    float sOwn12 = fOwn12 < 0.0 ? 1.0 : 0.0;
    float sA12i = fA12 < 0.0 ? 1.0 : 0.0, sB12i = fB12 < 0.0 ? 1.0 : 0.0;
    float sAe12 = tyA > 0.5 ? (gA12 > 0.0 ? sA12i : 1.0) : (gA12 > 0.0 ? sA12i : 0.0);
    float sBe12 = tyB > 0.5 ? (gB12 > 0.0 ? sB12i : 1.0) : (gB12 > 0.0 ? sB12i : 0.0);
    float insid12 = sOwn12;
    if (cnA) insid12 = tyA > 0.5 ? min(insid12, sAe12) : max(insid12, sAe12);
    if (cnB) insid12 = tyB > 0.5 ? min(insid12, sBe12) : max(insid12, sBe12);
    if (insid12 > 0.5) discard;
    // End combine: exact two-plane box area (see EDGE_STRIP) — intersection for
    // convex chains, union for reflex, neighbor plane gated to its inert
    // identity away from the corner, inclusion–exclusion for chained ends.
    // End combine. Two models per end, selected by normal parallelism kp:
    // nearly-parallel normals mean the neighbor plane is the same boundary the
    // own field already integrates (a tangent-continuous continuation) — min /
    // max is the one-boundary answer, and intersecting the two planes would
    // double-cut the pixel. Genuinely distinct normals mean a real corner —
    // there the exact two-plane box area (exactBoxCov2) is used rather than a
    // covA+covB−1 approximation, which overcounts acute tips. The gA/gB
    // proximity gate blends the whole result back to the own coverage away
    // from the corner; chained ends compose by inclusion–exclusion against the
    // pristine own coverage.
    float c12 = cOwn12;
    if (cnA && LB_CORNER_GATE(gA12)) {
      vec2 gA12w = vec2(dot(nA12, emx12), dot(nA12, emy12));   // the neighbor's plane in the window frame
      float gA12L = max(length(gA12w), 1e-30);
      vec2 nAn12 = gA12w / gA12L;
      float dA12 = -fA12 / gA12L;
      float cA12 = exactBoxCov(nAn12, dA12);
      float interA12 = min(exactBoxCov2(nOwn12, dOwn12, nAn12, dA12), cOwn12);
      if (tyA < 0.0) {
        // The neighbor's boundary STARTS at the shared vertex: behind its span-start line its
        // plane bounds nothing, so a reflex union counts the neighbor's region on its own side
        // of that line only. Unrestricted, a near-tangent neighbor's plane would run
        // back past the vertex through the own arc's exterior band and paint stray ink there.
        // Exact for straight ends: there the neighbor's region
        // behind the line already lies inside the own side, so the cut removes nothing real.
        // The span-start line is built in EM from the neighbor's em unit normal, then mapped into the window frame
        // like every em plane here -- the perpendicular of the window-frame normal would be y-mirrored.
        vec2 sNA12 = vec2(-nA12.y, nA12.x) * ((spanA12 > 0.5 ? -1.0 : 1.0) / max(length(nA12), 1e-9));
        vec2 gFA12 = vec2(dot(sNA12, emx12), dot(sNA12, emy12));
        float gFA12L = max(length(gFA12), 1e-30);
        vec2 nFA12 = -gFA12 / gFA12L;
        float dFA12 = dot(rA, sNA12) / gFA12L;
        cA12 = exactBoxCov2(nAn12, dA12, nFA12, dFA12);
        interA12 = min(exactBoxCov3(nOwn12, dOwn12, nAn12, dA12, nFA12, dFA12), cOwn12);
      }
      float kpA12 = max(0.0, dot(nOA, nA12));
      float exA12 = tyA > 0.0
        ? mix(clamp(c12 + interA12 - cOwn12, 0.0, 1.0), min(c12, cA12), kpA12)
        : mix(clamp(c12 + cA12 - interA12, 0.0, 1.0), max(c12, cA12), kpA12);
      c12 = mix(c12, exA12, gA12);
    }
    if (cnB && LB_CORNER_GATE(gB12)) {
      vec2 gB12w = vec2(dot(nB12, emx12), dot(nB12, emy12));
      float gB12L = max(length(gB12w), 1e-30);
      vec2 nBn12 = gB12w / gB12L;
      float dB12 = -fB12 / gB12L;
      float cB12 = exactBoxCov(nBn12, dB12);
      float interB12 = min(exactBoxCov2(nOwn12, dOwn12, nBn12, dB12), cOwn12);
      if (tyB < 0.0) {
        vec2 sNB12 = vec2(-nB12.y, nB12.x) * ((spanB12 > 0.5 ? -1.0 : 1.0) / max(length(nB12), 1e-9));
        vec2 gFB12 = vec2(dot(sNB12, emx12), dot(sNB12, emy12));
        float gFB12L = max(length(gFB12), 1e-30);
        vec2 nFB12 = -gFB12 / gFB12L;
        float dFB12 = dot(rB, sNB12) / gFB12L;
        cB12 = exactBoxCov2(nBn12, dB12, nFB12, dFB12);
        interB12 = min(exactBoxCov3(nOwn12, dOwn12, nBn12, dB12, nFB12, dFB12), cOwn12);
      }
      float kpB12 = max(0.0, dot(nOB, nB12));
      float exB12 = tyB > 0.0
        ? mix(clamp(c12 + interB12 - cOwn12, 0.0, 1.0), min(c12, cB12), kpB12)
        : mix(clamp(c12 + cB12 - interB12, 0.0, 1.0), max(c12, cB12), kpB12);
      c12 = mix(c12, exB12, gB12);
    }
    if (c12 <= 0.0) discard;
    /* In-span exterior-band contract: fill-side partials are interior turf.
       Wedges use the two-plane ownership test above instead. */
    if (!wgA && !wgB && f12 < 0.0 && c12 < 0.999) discard;
    /* Counter-hole chord ribbons extrude into the empty region; UV
       extrapolation can then paint mid-gray far past the arc while dpx still
       reads "near". Gate on s12<0: nested counters use sign -1 when ink sits
       on the control side; outer bowls keep their bulge AA past the chord.
       FAR FROM THE REGION THE ARC CAN OCCUPY, not from its chord. The sign does not
       say which side the ink is on -- an even-odd ring's OUTER bowl carries s12 < 0 -- and the
       chord stood in for the curve: near an arc's end, where it runs along its end tangent at 45
       degrees or more to the chord, a pixel a tenth of a pixel outside the arc read 1.8 px from
       the chord and lost its antialiasing (96 levels at every extreme point of lbMorphEvenOdd's
       outer ring at t = 0.03). The tangent triangle contains the chord, so this discards a subset
       of what the chord did: pixels past the arc's ENDS, where the extrapolation lives. */
    if (!wgA && !wgB && fOwn12 >= 0.0 && s12 < 0.0) {
      vec2 ab = b12 - a12;
      float abL2 = max(dot(ab, ab), 1e-37);
      float t = clamp(dot(rA, ab) / abL2, 0.0, 1.0);
      float dChord = lbTangentTriDist(rA, ab, nOA, nOB, length(rA - ab * t)) / max(vEmPerPx, 1e-30);
      if (dChord > 1.5 && abs(dpx12) < 1.0) discard;
      if (dChord > 1.2 && abs(dpx12) < 0.7 && c12 < 0.95) discard;
    }
    /*

 */
    if (!wgA && !wgB && fOwn12 >= 0.0) {
      vec2 uA12 = vec2(-nA12.y, nA12.x) * (mod(codeA, 2.0) > 0.5 ? 1.0 : -1.0);
      vec2 uB12 = vec2(-nB12.y, nB12.x) * (mod(codeB, 2.0) > 0.5 ? 1.0 : -1.0);
      if (!cnA && gA12 > 0.0 && dot(sA12, nA12) > 0.0 && fA12 < 0.0 && dot(rA, uA12) >= 0.0) discard;
      if (!cnB && gB12 > 0.0 && dot(sB12, nB12) > 0.0 && fB12 < 0.0 && dot(rB, uB12) >= 0.0) discard;
    }
    return c12;
  }
#endif
#endif
  // KIND 13 — THIN CHAIN STRIP: a ±band quad hugging one outline edge, carrying
  // that edge's local chain (P0=cCen, P1=(cScale,cHalf), P2=vLine2.xy,
  // P3=(vLine2.z,vLineT)). Analytic poly-clip coverage, exact per-edge; piece tier
  // rejects the solid coarse interior where it draws.
#ifndef MANTLE_LB_NO_CHAIN_STRIP
  if (LB_IS_CHAIN_STRIP) {
    float invE = 1.0 / max(vEmPerPx, 1e-30);
    mat2 cellM = lbChainCellMap();
    vec2 c0 = lbChainCell(cCen, invE, cellM);
    vec2 c1 = lbChainCell(vec2(cScale, cHalf), invE, cellM);
    vec2 c2 = lbChainCell(vLine2.xy, invE, cellM);
    vec2 c3 = lbChainCell(vec2(vLine2.z, vLineT), invE, cellM);
    return chainBoxCov(c0, c1, c2, c3, c3, 0.0);   // strips: 4 pts, exterior-aware miss
  }
#endif
  // Interior triangle: solid, unless it carries a straight boundary-edge line
  // (cCen,cScale from aC3) — then ramp the INNER AA half across it with the same
  // Slug dual-ray coverage the outward strip uses for the outer half (f>0 outside).
  // They meet at ½ on the edge → a centered analytic ramp with no interior inset.
  if (LB_IS_INTERIOR) {
    // ANALYTIC POLY-CLIP (vTC.x = 2 sentinel): the four flat slots carry the
    // triangle's local outline chain as POINTS (P0=cCen, P1=(cScale,cHalf),
    // P2=vLine2.xy, P3=(vLine2.z,vLineT)). Map each into the pixel cell with an
    // pixel cell through the full em→pixel map (lbChainCellMap), then clip: exact
    // coverage under any affine draw, no corner-type combos.
    if (vTC.x > 1.5) {
      // ANALYTIC map, not dFdx: dFdx blows up on thin CDT faces. See lbChainCellMap.
      float invE = 1.0 / max(vEmPerPx, 1e-30);
      mat2 cellM = lbChainCellMap();
      vec2 c0 = lbChainCell(cCen, invE, cellM);
      vec2 c1 = lbChainCell(vec2(cScale, cHalf), invE, cellM);
      vec2 c2 = lbChainCell(vLine2.xy, invE, cellM);
      vec2 c3 = lbChainCell(vec2(vLine2.z, vLineT), invE, cellM);
      vec2 c4 = lbChainCell(vTC.yz, invE, cellM);           // P4 (aTC.yz)
      // CUBIC mode (sentinels 4 and 5): the five points are ONE CUBIC's four and a
      // straight neighbor, after it (4) or before it (5) -- a piece's arc, which no polyline
      // through its points follows. COMPONENTIZED (MANTLE_LB_NO_CUBIC_CHAIN, from lbPack
      // hasCubicChain). It is the face's only chain kernel: the straight one on the same five
      // points would be work thrown away.
      float cov;
#ifndef MANTLE_LB_NO_CUBIC_CHAIN
      if (vTC.x > 3.5) cov = cubicChainBoxCov(c0, c1, c2, c3, c4, vTC.x > 4.5, 2.0);
      else
#endif
      cov = chainBoxCov(c0, c1, c2, c3, c4, 2.0);   // own chain: linear-miss mode
#ifndef MANTLE_NO_BEZOUT
      // A coarse face can reach a SECOND, disconnected outline arc that chain 1
      // cannot represent; without this its fragments miss and fill solid. Chain 2
      // bounds the fill from that side, so the local fill is the INTERSECTION of
      // the two — min() is exact when only one arc crosses the box (the common
      // case, the other returning 1) and a tight upper bound when both do.
      // All-zero chain 2 ⇒ degenerate segments ⇒ 1.0 ⇒ min() changes nothing.
      if (any(notEqual(vCh2A, vec4(0.0))) || any(notEqual(vCh2B, vec4(0.0)))) {
        vec2 d0 = lbChainCell(vCh2A.xy, invE, cellM);
        vec2 d1 = lbChainCell(vCh2A.zw, invE, cellM);
        vec2 d2 = lbChainCell(vCh2B.xy, invE, cellM);
        vec2 d3 = lbChainCell(vCh2B.zw, invE, cellM);
#ifndef MANTLE_LB_NO_CUBIC_CHAIN
        // aSeamM = 1: chain 2 is ONE CUBIC, d0 C d1 C d2 -> d3.
        cov = min(cov, vSeam > 0.5 ? cubicChainBoxCov(d0, d1, d2, d3, d3, false, 1.0) : chainBoxCov(d0, d1, d2, d3, d3, 1.0));
#else
        cov = min(cov, chainBoxCov(d0, d1, d2, d3, d3, 1.0));
#endif
      }
#endif
#ifdef MANTLE_LB_NO_CHAIN_COV
      // MEASUREMENT ARM, never a render path: skip the chain's analytic AA and treat the interior
      // face as solid. It separates a chain-orientation defect from the curve kernels: where an
      // INTERIOR-kind face adjacent to an inner contour reports a boundary pixel OUTSIDE (a one
      // pixel empty ring at a CURVED hole's boundary, as unifiedFillFeatureSmoke's `evenOdd` case
      // checks), this define fills the ring in exactly -- orientation, not the curve kernels, not a
      // discard, and not missing geometry.
      return LBCOV_OUT(1.0);
#endif
      return LBCOV_OUT(cov);
    }
    if (dot(cCen, cCen) > 1e-9) {
      float fi = dot(cCen, vEm) - cScale;
      // ∇fi ANALYTICALLY, not dFdx(fi). cCen is the flat unit edge normal, so ∇fi is
      // exactly cCen scaled to pixels (1/emPerPx). dFdx(fi) instead reads across the
      // 2×2 derivative quad — and at a sharp corner the CDT fans thin SLIVER
      // triangles whose helper pixels extrapolate garbage, blowing up the gradient
      // so slugCov collapses to ~0. That erodes the fill along the sliver: a "linear
      // cut" / diagonal slash across the glyph on real GPUs;
      // SwiftShader masks it. Analytic ∇fi is identical inside a triangle but immune.
      // cCen is the UNIT edge normal (and vLine2.xy the second line's), so the ramp is exactBoxCov of that normal
      // at the pixel offset -fi / vEmPerPx directly, with no square root or divides re-deriving both from
      // cCen * vEmPerPx. These are the very planes exactBoxCov2 below intersects.
      float invPxL = 1.0 / max(vEmPerPx, 1e-30);
      float cA = exactBoxCov(cCen, -fi * invPxL);
      // SECOND boundary line (vLine2 = nx,ny,c; vLineT = corner type). A pixel box cut by
      // TWO lines — a thin stroke (both stroke edges in one box) or a corner — needs the
      // combined coverage, not one line's. Use exact two-plane box area (exactBoxCov2):
      // covA+covB−1 overcounts acute tips where the true box area is partial.
      // Convex/stroke (fill = intersection): area(A∩B); reflex (fill = union): A∪B.
      if (abs(vLineT) > 0.5) {
        float fiB = dot(vLine2.xy, vEm) - vLine2.z;
        float cB = exactBoxCov(vLine2.xy, -fiB * invPxL);
        float invPx = invPxL;
        // A half-plane that saturates over the box leaves the other one's area: exact, and it skips
        // the two-pass clip on the ~100% of line+2 fragments whose box sees at most one of the lines.
        float inter = (cA <= 0.0 || cB <= 0.0) ? 0.0 : cA >= 1.0 ? cB : cB >= 1.0 ? cA
                    : exactBoxCov2(cCen, -fi * invPx, vLine2.xy, -fiB * invPx);
        cA = vLineT > 0.0 ? inter : (cA + cB - inter);
      }
      // THIRD line (vTC.xyz; type in cHalf): sliver faces can be cut by three edges. Far →
      // saturates → inert under the same chain. Approximate chain with the cheap formula
      // once the dominant pair is exact (third edges are usually near-orthogonal stems).
      if (abs(cHalf) > 0.5 && dot(vTC.xy, vTC.xy) > 1e-9) {
        float cC = exactBoxCov(vTC.xy, -(dot(vTC.xy, vEm) - vTC.z) * invPxL);   // unit too: the same line records
        cA = cHalf > 0.0 ? max(0.0, cA + cC - 1.0) : cA + cC - cA * cC;
      }
      return cA;
    } else return 1.0;
  }

  float f;
  vec2 f4gEm = vec2(0.0);
// Must match the vertex setup's push, or the bound and the geometry disagree.
#ifndef LB_BEZ_RING
#define LB_BEZ_RING 0.25
#endif
  bool f4has = false;
  if (vKind < LBK_CUBIC + 0.5) {
    // Cubic (Loop-Blinn klmn, p1000-loop §4.4): k,l,m interpolated in vTC;
    // implicit f = k³ − l·m (n≡1 for integral cubics). ~3 mul + 1 sub.
    // (INTERIOR returned above, so reaching here means CUBIC.)
    f = vSign * (vTC.x * vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < LBK_CUBIC_BEZ + 0.5) {

#if !defined(MANTLE_NO_BEZOUT) && !defined(MANTLE_LB_NO_CUBIC_BEZ)
#ifndef MANTLE_LB_NO_CUBIC_CHAIN
    // A RING THAT CARRIES ITS ARC (vSeam = 10): aC0 / aC1 hold the piece's four control points, fill on
    // the left, and the coverage is the pixel box's exact share of the ink side of the arc (continued along its end
    // tangents) -- the cubic chain kernel, with no resultant and so none of its second branch, which would paint past
    // the arc wherever the ring's reach met it. A ring's pixel center lies outside a hull edge no other face shares,
    // which is on the arc's air side, so the fill-side claim rule below has nothing to decide here.
    if (vSeam > 9.5) {
      float invE4 = 1.0 / max(vEmPerPx, 1e-30);
      mat2 cellM4 = lbChainCellMap();
      float covArc = cubicChainBoxCov(lbChainCell(vLB0.xy, invE4, cellM4), lbChainCell(vLB0.zw, invE4, cellM4),
                                      lbChainCell(vLB1.xy, invE4, cellM4), lbChainCell(vLB1.zw, invE4, cellM4),
                                      lbChainCell(vLB1.zw, invE4, cellM4), false, 0.0);
      if (covArc < 0.004) discard;
      return LBCOV_OUT(covArc);
    }
#endif
    // Cubic-bezout fallback (cusp / d1≈0): exact 3×3 Bezout determinant.
    vec2 n = (vEm - cCen) / cScale;
    float lin02 = cM02.y * n.x + cM02.z * n.y;   // M02, M11 share m02's (b,c)
    float M00 = cM00.x + dot(cM00.yz, n);
    float M01 = cM01.x + dot(cM01.yz, n);
    float M02 = cM02.x + lin02;
    float M11 = cM11a  + lin02;
    float det = M00 * (M11 * cM22 - cM12 * cM12)
              - M01 * (M01 * cM22 - cM12 * M02)
              + M02 * (M01 * cM12 - M11 * M02);
    f = vSign * det;
    // exact gradient via cofactor differentiation (the det is an analytic cubic in n;
    // dFdx(f) is a per-quad constant approximation whose error would show as a CUBIC_BEZ
    // AA wobble). M12/M22 constant; M02 and M11 share lin02's linear part.
    float d00 = M11 * cM22 - cM12 * cM12;
    float d01 = -2.0 * M01 * cM22 + 2.0 * M02 * cM12;
    float d02 = 2.0 * M01 * cM12 - 2.0 * M02 * M11;
    float d11 = M00 * cM22 - M02 * M02;
    vec2 gN = d00 * cM00.yz + d01 * cM01.yz + (d02 + d11) * cM02.yz;
    f4gEm = vSign * gN / cScale;
    f4has = true;
#else
    // LEAN variant: no CUBIC_BEZ verts exist in this bundle — unreachable.
    f = 1.0;
#endif
  } else if (vKind < LBK_ARC + 0.5) {
    // Rational quadratic (arc, Loop-Blinn §3.2): homogeneous texcoords
    // vTC = (Ũ,Ṽ,R); implicit f = Ũ²−Ṽ·R (integral quad is the R≡1 case). Exact
    // for elliptical arcs — no cubic approximation. Cheap: 2 mul + 1 sub.
    // |vSign| == 3 flags a LONE CRESCENT (no INTERIOR interior in this mesh) — the
    // sign-magnitude idiom CURVE_BAND uses; take only its sign for the implicit.
    f = (vSign > 0.0 ? 1.0 : -1.0) * (vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < LBK_DISC + 0.5) {
    // COMPONENTIZED (MANTLE_LB_NO_DISC): the BRANCH stays and only its body goes,
    // because removing an `else if` from the middle of a chain would weld the
    // neighboring conditions together. Same reason MANTLE_NO_BEZOUT empties
    // CUBIC_BEZ's body rather than deleting its arm.
#ifndef MANTLE_LB_NO_DISC
    // Circular / annulus / elliptical SDF (DISC; legacy kind 6 still accepted).
    // Ellipse (cHalf < −1.5): aC0=(ry,cosφ,sinφ), cScale=rx — unit-circle pullback.
    // Disc (−1.5 ≤ cHalf < 0, or legacy kind 6): f = |p−C| − r.
    // Ring (cHalf ≥ 0): f = ||p−C| − rMid| − halfW; one primitive, no wedges.
    //
    // ANALYTIC gradient + curvature (no dFdx of f): every level set here is a
    // circle/ellipse through the fragment, so ∇f and the (rank-1) Hessian
    // H = w·WWᵀ are closed-form. Feeding them into the same curvature-aware
    // coverage the curve kinds use removes the tangent-line over-coverage on
    // the inner fringe of small/high-curvature discs — the correction the
    // first-order slugCov path could not express.
    vec2 d7 = vEm - cCen;
    vec2 G7, W7;
    float w7;
    if (cHalf < -1.5) {
      float rx7 = max(cScale, 1e-30), ry7 = max(vNa.x, 1e-30);
      float c7 = vNa.y, s7 = vNb.x;
      vec2 q7 = vec2((d7.x * c7 + d7.y * s7) / rx7, (-d7.x * s7 + d7.y * c7) / ry7);
      float Lq7 = max(length(q7), 1e-9);
      f = vSign * (Lq7 - 1.0);
      vec2 qh7 = q7 / Lq7, th7 = vec2(-qh7.y, qh7.x);
      G7 = vSign * vec2(qh7.x * c7 / rx7 - qh7.y * s7 / ry7, qh7.x * s7 / rx7 + qh7.y * c7 / ry7);
      W7 = vec2(th7.x * c7 / rx7 - th7.y * s7 / ry7, th7.x * s7 / rx7 + th7.y * c7 / ry7);
      w7 = vSign / Lq7;
    } else {
      float L7 = max(length(d7), 1e-30);
      vec2 dh7 = d7 / L7;
      float sig7 = 1.0, halfW7 = 0.0;
      if (LB_IS(LBK_DISC) && cHalf >= 0.0) { sig7 = L7 >= cScale ? 1.0 : -1.0; halfW7 = cHalf; }
      f = vSign * (sig7 * (L7 - cScale) - halfW7);
      G7 = (vSign * sig7) * dh7;
      W7 = vec2(-dh7.y, dh7.x);
      w7 = vSign * sig7 / L7;
    }
    // Chain rule through the affine em→px map: dFdx(vEm) is the exact
    // per-primitive Jacobian column (vEm is affine in screen space).
    vec2 emx7 = dFdx(vEm), emy7 = dFdy(vEm);
    float fx7 = dot(G7, emx7), fy7 = dot(G7, emy7);
    float wx7 = dot(W7, emx7), wy7 = dot(W7, emy7);
    // A circle or an annulus has the same κ everywhere on the level set, so the curvature offset
    // can be the exact moment over the chord this pixel cuts (arcCov); an ELLIPSE's varies
    // along it, and there the moment's x² weighting of the chord's ends over-states the curve, so
    // it keeps the centered κ/24. Both branches are already distinguished above by cHalf.
    float cov7 = (cHalf < -1.5) ? curveCov(f, fx7, fy7, w7 * wx7 * wx7, w7 * wy7 * wy7, w7 * wx7 * wy7)
                                : arcCov(f, fx7, fy7, w7 * wx7 * wx7, w7 * wy7 * wy7, w7 * wx7 * wy7);
    // Near-zero claims write depth at the piece tier and reject solid interior
    // beneath (same contract as the shared tail's cov < 0.004 gate).
    if (cov7 < 0.004) discard;
    return LBCOV_OUT(cov7);
#else
    f = 1.0;   // unreachable: no DISC vertex exists in a disc-free mesh
#endif
  } else {
    // Unreachable: kinds 0/7/10/12 return early above, and the packer emits no
    // other kind (1/3/8/9/11 have no emitter and no handler).
    f = 0.0;
  }
  // Coverage. Curve kinds (2 cubic · 5 rquad) use the CURVATURE-AWARE per-axis
  // coverage: their texcoords are affine in screen space, so f is exactly
  // quadratic along each axis and curveCov measures the true kept length within
  // the pixel — removing the tangent-line over-coverage on convex arcs. The
  // needed derivatives come from the texcoord screen gradients (exact for
  // affine tc; the crescent hull triangles aren't slivers, so dFdx is clean here).
  float cov;
  bool isCubic = LB_IS_CUBIC;
  bool isBez = LB_IS(LBK_CUBIC_BEZ);
  bool isRquad = LB_IS_ARC;

  vec3 txT = dFdx(vTC), tyT = dFdy(vTC);
  vec2 emxT = dFdx(vEm), emyT = dFdy(vEm);
  // The Bezout crescent's gradient-field derivatives, taken only on a Bezout primitive: f4has is set
  // by the kind alone, a flat value, so every fragment of a primitive takes the same side of this test and the
  // derivatives stay in that primitive's uniform flow; elsewhere they would be dFdx of a zero vector. There is no
  // dFdx(f) / dFdy(f) fallback (below).
  vec2 g4xT = vec2(0.0), g4yT = vec2(0.0);
  if (f4has) { g4xT = dFdx(f4gEm); g4yT = dFdy(f4gEm); }
  if (isCubic && vSeam > 0.5 && vSeam < 5.0) {

    vec2 a = cCen, b = vec2(cScale, cHalf);
    // Reached only by RING-LESS cubic pieces (morph meshes); static pieces carry an exterior
    // ring and never set vSeam. Slack, but SMALL: neighboring pieces are tangent-continuous, so
    // their clip planes COINCIDE, and a generous slack makes both paint the seam band while the
    // route's OVER double-counts it (a 4-cubic circle read 0.981/255 with 8 bad pixels at 0.5px
    // vs 0.556 with none at <= 0.10). 0.05 keeps a margin against an fp-tilted plane.
    float clipEpsC = 0.05 * vEmPerPx;
    if (dot(vEm - a, vNa) < -clipEpsC || dot(vEm - b, vNb) < -clipEpsC) discard;
  } else if (isRquad) {
    // rquad (ellipse/arc) keeps the chord-span clip — control point not threaded (rare).
    vec2 a = cCen, b = vec2(cScale, cHalf), ch = b - a;
    if (dot(ch, ch) > 0.0 && (dot(vEm - a, ch) < 0.0 || dot(vEm - b, ch) > 0.0)) discard;
  }
  if (isCubic || isRquad) {
    vec3 tx = txT, ty = tyT;               // ∂(texcoords)/∂(screen px) — exact (affine), taken above
    float fx, fy, fxx, fyy, fxy;
    if (isCubic) {                         // f = s·(k³−l·m); 2nd-order fit (drop t³)
      float k = vTC.x, l = vTC.y, m = vTC.z;
      fx = vSign * (3.0 * k * k * tx.x - (tx.y * m + l * tx.z));
      fy = vSign * (3.0 * k * k * ty.x - (ty.y * m + l * ty.z));
      fxx = vSign * (6.0 * k * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (6.0 * k * ty.x * ty.x - 2.0 * ty.y * ty.z);
      fxy = vSign * (6.0 * k * tx.x * ty.x - (tx.y * ty.z + ty.y * tx.z));
    } else {                               // f = s·(Ũ²−Ṽ·R)
      float s5 = vSign > 0.0 ? 1.0 : -1.0;   // magnitude is the lone-crescent flag
      float U = vTC.x, V = vTC.y, Rr = vTC.z;
      fx = s5 * (2.0 * U * tx.x - (tx.y * Rr + V * tx.z));
      fy = s5 * (2.0 * U * ty.x - (ty.y * Rr + V * ty.z));
      fxx = s5 * (2.0 * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = s5 * (2.0 * ty.x * ty.x - 2.0 * ty.y * ty.z);
      fxy = s5 * (2.0 * tx.x * ty.x - (tx.y * ty.z + ty.y * tx.z));
    }
    cov = curveCov(f, fx, fy, fxx, fyy, fxy);
    if (isRquad && abs(vSign) > 2.0) {
      // CHORD EDGE OF A LONE CRESCENT — the missing half of the straight-edge AA.

      // No new vertex data is needed: in canonical Loop-Blinn texcoords the arc
      // endpoints are (0,0) and (1,1), so the chord is exactly V = U, and that
      // holds homogeneously for rational quads (u=U/R, v=V/R). The crescent
      // interior has g < 0, the same sense as f, so it min()s straight in.
      //
      // GATED, and it must be: applying it unconditionally fails 13/97 smokes
      // (road IoU 0.46, curved-band "wrong wedges" IoU 0.77) — those rely on the
      // crescent painting solid across a chord that is NOT a shape boundary.
      float s5 = vSign > 0.0 ? 1.0 : -1.0;
      float gC = s5 * (vTC.y - vTC.x);
      vec2  gG = s5 * vec2(tx.y - tx.x, ty.y - ty.x);
      cov = min(cov, slugCov(gC, gG));
    }
  } else {
    if (f4has) {
      // PAST ITS own ARC, ON THE SIDE THE INK IS NOT ON, this CRESCENT MAY NOT PAINT.
      //
      //
      // The half-plane rides aTC, which a kind-4 vertex does not otherwise read. It is placed at
      // the arc's own extreme and released by the filter's reach, so the crescent keeps its AA band
      // and only the far branch -- pixels away, not a fraction of one -- is cut off.

      bool keepOn4 = dot(vTC.xy, vTC.xy) > 0.0;
      float keep4 = 1.0;
#ifndef MANTLE_LB_MORPH
      // A ring fragment is bounded by the box's share of the keep half-plane AND the hull edge it was pushed from
      // (n4 in aC3.w, its offset in vEmPerPx: _lbVertexSetup.glsl).
      vec2 n4f = vSeam > 5.0 ? unpackHalf2x16(floatBitsToUint(vLB3.w)) : vec2(0.0);
      if (dot(n4f, n4f) > 0.0) {
        vec2 u4f = normalize(n4f);
        keep4 = keepOn4 ? lbHalfPlanesBoxCov2(vTC.xy, vTC.z, u4f, vEmPerPx, emxT, emyT) : lbHalfPlaneBoxCov(u4f, vEmPerPx, emxT, emyT);
      } else
#endif
      if (keepOn4) keep4 = lbHalfPlaneBoxCov(vTC.xy, vTC.z, emxT, emyT);
      if (keep4 <= 0.0) { cov = 0.0; }
      else {
      // kind-4: exact analytic gradient (cofactor) + curvature from the gradient
      // field's screen derivatives → the same curvature-aware coverage the quad
      // kinds use. First-order slugCov left a 0.3-0.4 band on curved partials.
      vec2 emx = emxT, emy = emyT;
      float fx4 = dot(f4gEm, emx), fy4 = dot(f4gEm, emy);
      float fxx4 = dot(g4xT, emx), fyy4 = dot(g4yT, emy);
      float fxy4 = dot(g4yT, emx);
      cov = min(curveCov(f, fx4, fy4, fxx4, fyy4, fxy4), keep4);
#ifdef MANTLE_DEBUG_K4
      float dpx = f / max(length(vec2(fx4, fy4)), 1e-12);
      o = vec4(clamp(0.5 + dpx * 0.25, 0.0, 1.0), clamp(0.5 + fxx4 * 2.0, 0.0, 1.0), cov, 1.0);
      return LB_COV_WROTE_O;
#endif
      }
    } else {
      // No live kind reaches this (kinds 2 and 5 take the curve path above, kind 4 the Bezout path, and every
      // other kind returns before the tail). A first-order tangent-line fallback here would keep dFdx(f) and
      // dFdy(f) alive on every tail fragment; an unexpected vertex paints nothing, which is what such a fallback
      // would return for the kinds that can fall here in the omit variants (f = 0 and a zero gradient).
      cov = 0.0;
    }
  }

  if ((isCubic || isBez) && vSeam > 5.0 && cov < 0.999 && f < 0.0) discard;

  if (cov < 0.004) discard;
  return LBCOV_OUT(cov);
}
