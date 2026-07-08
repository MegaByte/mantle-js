// quadArc — exact intersection of a quadratic Bezier with an arc.
//
// Algorithm: transform the quad's control points into the arc's
// local frame (centered at (cx, cy), rotated by -phi, scaled by
// 1/rx in x and 1/ry in y). In that frame the arc is a portion of
// the unit circle. The quadratic stays a quadratic (linear
// transforms of quadratic Beziers are quadratic Beziers).
//
// Substitute the transformed quad into |p|² = 1, getting a degree-4
// polynomial in s. Solve via Ferrari, filter for in-sweep θ.
// Transform results back to world coordinates.
//
// Up to 4 intersections.

import { solveQuartic } from '../polyRoots.js';

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

export function intersectQuadArc(qP1, qP2, qP3, arc) {
  const { cx, cy, rx, ry, phi, theta_start: t0, theta_end: t1 } = arc;
  if (rx < EPS || ry < EPS) return [];
  const cp = Math.cos(phi), sp = Math.sin(phi);

  const toLocal = (p) => {
    const dx = p[0] - cx, dy = p[1] - cy;
    return [
      ( cp*dx + sp*dy) / rx,
      (-sp*dx + cp*dy) / ry,
    ];
  };
  const p1L = toLocal(qP1);
  const p2L = toLocal(qP2);
  const p3L = toLocal(qP3);

  // Quadratic in local frame, power form:
  //   c(s) = a + b·s + c·s²
  const ax = p1L[0],                          ay = p1L[1];
  const bx = 2*(p2L[0]-p1L[0]),               by = 2*(p2L[1]-p1L[1]);
  const cx_ = p1L[0]-2*p2L[0]+p3L[0],         cy_ = p1L[1]-2*p2L[1]+p3L[1];

  // |c(s)|² = (ax + bx·s + cx_·s²)² + (ay + by·s + cy_·s²)² = 1
  // Expand:
  //   (ax + bx·s + cx_·s²)² =
  //     ax² + 2·ax·bx·s + (2·ax·cx_ + bx²)·s² + 2·bx·cx_·s³ + cx_²·s⁴
  // similarly for y. Sum then subtract 1.
  const A4 = cx_*cx_ + cy_*cy_;
  const A3 = 2*(bx*cx_ + by*cy_);
  const A2 = 2*(ax*cx_ + ay*cy_) + (bx*bx + by*by);
  const A1 = 2*(ax*bx + ay*by);
  const A0 = ax*ax + ay*ay - 1;

  const roots = solveQuartic(A4, A3, A2, A1, A0);

  const sweep = t1 - t0;
  const tLo = Math.min(t0, t1);
  const tHi = Math.max(t0, t1);

  const out = [];
  for (const s of roots) {
    if (s < -EPS || s > 1 + EPS) continue;
    const sC = Math.max(0, Math.min(1, s));
    // Local-frame point.
    const lx = ax + bx*sC + cx_*sC*sC;
    const ly = ay + by*sC + cy_*sC*sC;
    // Angle on unit circle.
    let theta = Math.atan2(ly, lx);
    let normalized = theta;
    while (normalized < tLo) normalized += TWO_PI;
    while (normalized > tHi) normalized -= TWO_PI;
    if (normalized < tLo - EPS || normalized > tHi + EPS) continue;
    const tArc = (sweep === 0) ? 0 : (normalized - t0) / sweep;
    if (tArc < -EPS || tArc > 1 + EPS) continue;
    // Transform back to world.
    const wXL = lx * rx;
    const wYL = ly * ry;
    const x = cp*wXL - sp*wYL + cx;
    const y = sp*wXL + cp*wYL + cy;
    const tQ = sC;
    const tArcC = Math.max(0, Math.min(1, tArc));
    // Dedupe near-coincident roots (Ferrari may double-up).
    let dup = false;
    for (const prev of out) {
      if (Math.abs(prev.tA - tQ) < 1e-5 && Math.abs(prev.tB - tArcC) < 1e-5) {
        dup = true; break;
      }
    }
    if (dup) continue;
    out.push({
      tA: tQ, tB: tArcC, x, y,
      endpointA: tQ < EPS || tQ > 1 - EPS,
      endpointB: tArcC < EPS || tArcC > 1 - EPS,
    });
  }
  return out;
}
