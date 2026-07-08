// lineLine — segment-segment intersection for two SEG_LINE primitives.
//
// Returns 0 or 1 intersection records. Each record is
//   { tA, tB, x, y, endpointA, endpointB }
// where tA/tB ∈ [0, 1] are the parameters on each segment and
// endpointA/endpointB are true if the intersection lies at a
// segment endpoint (within EPS).
//
// Two lines a(t) = a0 + t·(a1-a0), b(s) = b0 + s·(b1-b0) intersect
// when the 2×2 system
//   (a1-a0)·t - (b1-b0)·s = (b0-a0)
// has a solution in [0, 1] × [0, 1]. Closed form via Cramer.
//
// Collinear / parallel cases:
//   parallel non-collinear  → no intersection.
//   parallel collinear      → either no intersection (disjoint) or a
//                             segment-overlap of one. The overlap
//                             case isn't handled here — it's a
//                             degenerate input that the planar-
//                             subdivision stage cleans up via
//                             coincident-segment merging.

const EPS = 1e-9;

export function intersectLineLine(aP1, aP2, bP1, bP2) {
  const ax = aP2[0] - aP1[0];
  const ay = aP2[1] - aP1[1];
  const bx = bP2[0] - bP1[0];
  const by = bP2[1] - bP1[1];
  const det = ax * by - ay * bx;  // = -cross(b - a)
  if (Math.abs(det) < EPS) return [];  // parallel
  const dx = bP1[0] - aP1[0];
  const dy = bP1[1] - aP1[1];
  // (a1-a0) · t = (b0-a0) + (b1-b0) · s
  // Solve via Cramer.
  const t = (dx * by - dy * bx) / det;
  const s = (dx * ay - dy * ax) / det;
  if (t < -EPS || t > 1 + EPS) return [];
  if (s < -EPS || s > 1 + EPS) return [];
  const tC = Math.max(0, Math.min(1, t));
  const sC = Math.max(0, Math.min(1, s));
  return [{
    tA: tC, tB: sC,
    x: aP1[0] + tC * ax,
    y: aP1[1] + tC * ay,
    endpointA: tC < EPS || tC > 1 - EPS,
    endpointB: sC < EPS || sC > 1 - EPS,
  }];
}
