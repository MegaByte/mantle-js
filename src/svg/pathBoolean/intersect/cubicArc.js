// cubicArc — exact intersection of a cubic Bezier with an arc.
//
// Strategy: transform the cubic to the arc's local frame (centered at
// (cx, cy), rotated by -phi, scaled by 1/rx in x and 1/ry in y). In
// that frame the arc is a portion of the unit circle. A cubic Bezier
// under a linear transform stays a cubic Bezier.
//
// Substitute the local-frame cubic into |c(s)|² = 1 → power-form
// degree-6 polynomial in s. No closed form (degree ≥ 5), so use
// the variation-diminishing Bernstein-subdivision root finder
// (solvePolyInUnitInterval).
//
// Up to 6 intersections.

import { solvePolyInUnitInterval } from '../polyRoots.js';

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

export function intersectCubicArc(cP1, cP2, cP3, cP4, arc) {
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
  const p1L = toLocal(cP1);
  const p2L = toLocal(cP2);
  const p3L = toLocal(cP3);
  const p4L = toLocal(cP4);

  // Power-form cubic: c(s) = a + b·s + c·s² + d·s³.
  const ax = p1L[0],                              ay = p1L[1];
  const bx = 3*(p2L[0]-p1L[0]),                   by = 3*(p2L[1]-p1L[1]);
  const cx_ = 3*(p1L[0]-2*p2L[0]+p3L[0]),         cy_ = 3*(p1L[1]-2*p2L[1]+p3L[1]);
  const dx_ = -p1L[0]+3*p2L[0]-3*p3L[0]+p4L[0];
  const dy_ = -p1L[1]+3*p2L[1]-3*p3L[1]+p4L[1];

  // |c(s)|² - 1 = X(s)² + Y(s)² - 1, where each square is a degree-6
  // polynomial. Compute via convolution.
  // X(s) = ax + bx·s + cx_·s² + dx_·s³ → coefficients are [ax, bx, cx_, dx_].
  const xCoef = [ax, bx, cx_, dx_];
  const yCoef = [ay, by, cy_, dy_];
  // X² coefficients (degree 6, 7 terms).
  const x2 = squarePoly(xCoef);
  const y2 = squarePoly(yCoef);
  // Sum: x2[k] + y2[k] for k=0..6. Subtract 1 from c0.
  const poly = new Array(7);
  for (let k = 0; k < 7; k++) poly[k] = x2[k] + y2[k];
  poly[0] -= 1;

  const roots = solvePolyInUnitInterval(poly);

  const sweep = t1 - t0;
  const tLo = Math.min(t0, t1);
  const tHi = Math.max(t0, t1);

  const out = [];
  for (const s of roots) {
    if (s < -EPS || s > 1 + EPS) continue;
    const sC = Math.max(0, Math.min(1, s));
    // Local-frame point.
    const lx = ((dx_*sC + cx_)*sC + bx)*sC + ax;
    const ly = ((dy_*sC + cy_)*sC + by)*sC + ay;
    // Angle on unit circle.
    let theta = Math.atan2(ly, lx);
    let normalized = theta;
    while (normalized < tLo) normalized += TWO_PI;
    while (normalized > tHi) normalized -= TWO_PI;
    if (normalized < tLo - EPS || normalized > tHi + EPS) continue;
    const tArc = (sweep === 0) ? 0 : (normalized - t0) / sweep;
    if (tArc < -EPS || tArc > 1 + EPS) continue;
    const wXL = lx * rx;
    const wYL = ly * ry;
    const x = cp*wXL - sp*wYL + cx;
    const y = sp*wXL + cp*wYL + cy;
    const tArcC = Math.max(0, Math.min(1, tArc));
    let dup = false;
    for (const prev of out) {
      if (Math.abs(prev.tA - sC) < 1e-5 && Math.abs(prev.tB - tArcC) < 1e-5) {
        dup = true; break;
      }
    }
    if (dup) continue;
    out.push({
      tA: sC, tB: tArcC, x, y,
      endpointA: sC < EPS || sC > 1 - EPS,
      endpointB: tArcC < EPS || tArcC > 1 - EPS,
    });
  }
  return out;
}

// Compute coefficients of p(s)² where p is a cubic in power form.
// Input: [a, b, c, d] (degree 3). Output: 7 coefficients (degree 6).
function squarePoly(p) {
  const a = p[0], b = p[1], c = p[2], d = p[3];
  return [
    a*a,                          // s^0
    2*a*b,                        // s^1
    2*a*c + b*b,                  // s^2
    2*a*d + 2*b*c,                // s^3
    2*b*d + c*c,                  // s^4
    2*c*d,                        // s^5
    d*d,                          // s^6
  ];
}
