// svg/cubicCusp.js — cusp detection + split for cubic segments.
//
// A cusp (B'(t) = 0: the velocity vanishes mid-curve) is a DOUBLE root of the ray equation the
// fill kernels solve, and a double root is exactly the case a sign-based crossing count cannot
// decide — "crosses" vs "touches" comes down to floating-point noise, so a cusp tip frays into
// alternating covered/uncovered pixels. Splitting at the cusp makes it a segment ENDPOINT, which
// every kernel already has a rule for.
//
// This is deliberately NOT done at parse. It changes the segment count from geometry, and a
// shape-morph pairs poses by structure and tweens only equal-length ranges — a split present in
// one pose and absent in its partner would desync the counts and drop that shape to a crossfade.
// So the split lives where it cannot leak into correspondence: Loop-Blinn's STATIC mesh builder
// (gated off for morph meshes, which keep matched topology), while GWN splits its own tree pieces.
//
// Self-contained (no imports) so the renderer can pull it in without dragging the SVG parser.
import { SEG_CUBIC } from '../primitives/seg.js';

// de Casteljau split at t → [left, right] cubics.
function splitCubicAt(seg, t) {
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const q1 = lerp(seg.p1, seg.p2, t);
  const q2 = lerp(seg.p2, seg.p3, t);
  const q3 = lerp(seg.p3, seg.p4, t);
  const r1 = lerp(q1, q2, t);
  const r2 = lerp(q2, q3, t);
  const s  = lerp(r1, r2, t);
  return [
    { type: SEG_CUBIC, p1: seg.p1, p2: q1, p3: r1, p4: s },
    { type: SEG_CUBIC, p1: s,      p2: r2, p3: q3, p4: seg.p4 },
  ];
}

/// The parameter of a cubic's interior cusp, or -1. A cusp is where the derivative VANISHES — both
/// components at once — so solve x'(t) = 0 and keep a root at which y'(t) is also zero. B'(t)/3 =
/// A·t² + B·t + C with A = d3 − 2d2 + d1, B = 2(d2 − d1), C = d1 (dk = successive control-point
/// differences). Tolerance is relative to the control polygon, so it scales with the shape instead
/// of being an absolute epsilon in em units.
export function cubicCuspT(s) {
  const d1x = s.p2[0] - s.p1[0], d1y = s.p2[1] - s.p1[1];
  const d2x = s.p3[0] - s.p2[0], d2y = s.p3[1] - s.p2[1];
  const d3x = s.p4[0] - s.p3[0], d3y = s.p4[1] - s.p3[1];
  const scale = Math.hypot(d1x, d1y) + Math.hypot(d2x, d2y) + Math.hypot(d3x, d3y);
  if (!(scale > 0)) return -1;
  const tol = 1e-6 * scale;
  const Ax = d3x - 2 * d2x + d1x, Bx = 2 * (d2x - d1x), Cx = d1x;
  const Ay = d3y - 2 * d2y + d1y, By = 2 * (d2y - d1y), Cy = d1y;
  // Solve the axis with the better-conditioned quadratic; test the other for vanishing too.
  const useX = Math.abs(Ax) + Math.abs(Bx) >= Math.abs(Ay) + Math.abs(By);
  const [A, B, C, oA, oB, oC] = useX ? [Ax, Bx, Cx, Ay, By, Cy] : [Ay, By, Cy, Ax, Bx, Cx];
  const roots = [];
  if (Math.abs(A) < 1e-12 * (Math.abs(B) + 1e-12)) {
    if (Math.abs(B) > 1e-12) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    roots.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
  }
  const EPS = 1e-4;                                 // a cusp AT an endpoint is already a vertex
  for (const t of roots) {
    if (!(t > EPS && t < 1 - EPS)) continue;
    if (Math.abs((oA * t + oB) * t + oC) * 3 <= tol) return t;
  }
  return -1;
}

/// Split every cubic in a segment list at its interior cusp (if any) into two cubics meeting AT
/// the cusp. Returns the input unchanged when nothing splits. Exact and geometry-preserving; only
/// the segment count changes — which is why the callers that use it are render-internal (see the
/// module header).
export function splitCubicCusps(segs) {
  let out = null;                                   // allocate only if something actually splits
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const t = (s.type === SEG_CUBIC) ? cubicCuspT(s) : -1;
    if (t < 0) { if (out) out.push(s); continue; }
    if (!out) out = segs.slice(0, i);
    const [a, b] = splitCubicAt(s, t);
    if (s.subStart) a.subStart = true;              // splitting must not move where a subpath begins
    out.push(a, b);
  }
  return out || segs;
}
