// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// quadQuad — exact intersection of two quadratic Beziers.
//
// Algorithm: implicitize curve B as a conic f_B(x, y) = 0, substitute
// curve A's parametric form into f_B, solve the resulting degree-4
// polynomial in t_A via Ferrari. Up to 4 intersections.
//
// Parametric form for a quadratic Bezier with control (P0, P1, P2):
//   c(s) = P0 + 2(P1-P0)·s + (P0 - 2P1 + P2)·s²
//        = (a0, b0) + (a1, b1)·s + (a2, b2)·s²
// where
//   a0 = P0.x, a1 = 2(P1.x - P0.x), a2 = P0.x - 2P1.x + P2.x
// (and similarly for b's with the y components).
//
// Implicit form (when Δ = a1·b2 - a2·b1 ≠ 0):
//   f(x, y) = (b2·(x - a0) - a2·(y - b0))²
//           - Δ · (a1·(y - b0) - b1·(x - a0))
//
// Derivation: from the parametric form,
//   x - a0 = a1·s + a2·s²
//   y - b0 = b1·s + b2·s²
// Solve the 2×2 linear system in (s, s²):
//   s   = ( b2·(x-a0) - a2·(y-b0)) / Δ
//   s²  = (-b1·(x-a0) + a1·(y-b0)) / Δ
// Then s² = s·s gives the implicit equation above.
//
// Degenerate case (Δ ≈ 0): the quadratic is actually a line (collinear
// control points). Fall back to line × quadratic via lineQuad.

import { solveQuartic } from '../polyRoots.js';
import { intersectLineQuad } from './lineQuad.js';
import { liesOnParabola, sameCurveHits } from './coincident.js';

const EPS = 1e-9;

export function intersectQuadQuad(aP1, aP2, aP3, bP1, bP2, bP3) {
  // IMPLICITIZE THE LARGER, SUBSTITUTE THE SMALLER. B's implicit along A is a quartic whose values are
  // B's implicit wherever A goes; when B is small against A they are huge except near B, and the two
  // crossings that sit inside B's little region are the roots of a difference of large numbers -- a
  // quad 1e-4 of its partner's size lost both. Along a small A the same implicit barely changes, and
  // nothing cancels.
  const ext = (p, q, r) =>
    Math.max(p[0], q[0], r[0]) -
    Math.min(p[0], q[0], r[0]) +
    Math.max(p[1], q[1], r[1]) -
    Math.min(p[1], q[1], r[1]);
  if (ext(aP1, aP2, aP3) > ext(bP1, bP2, bP3)) {
    return quadQuadImplicitB(bP1, bP2, bP3, aP1, aP2, aP3).map((r) => ({
      tA: r.tB,
      tB: r.tA,
      x: r.x,
      y: r.y,
      endpointA: r.endpointB,
      endpointB: r.endpointA,
      ...(r.sameCurve ? { sameCurve: true } : null),
    }));
  }
  return quadQuadImplicitB(aP1, aP2, aP3, bP1, bP2, bP3);
}

function quadQuadImplicitB(aP1, aP2, aP3, bP1, bP2, bP3) {
  // Power-form coefficients for curve B.
  const Ba0 = bP1[0],
    Bb0 = bP1[1];
  const Ba1 = 2 * (bP2[0] - bP1[0]),
    Bb1 = 2 * (bP2[1] - bP1[1]);
  const Ba2 = bP1[0] - 2 * bP2[0] + bP3[0],
    Bb2 = bP1[1] - 2 * bP2[1] + bP3[1];
  const Bdet = Ba1 * Bb2 - Ba2 * Bb1;
  // An absolute 1e-9 that is relative to the pair: B is the larger quad, so wherever the two can meet
  // (their boxes overlap) B spans at least half the pair's canonical extent, and this calls B straight
  // only when its bulge is ~1e-9 of the pair -- where chord and curve agree to the kernels' precision
  // anyway, and a straight quad with rounding noise in its middle point stays straight.
  if (Math.abs(Bdet) < EPS) {
    // B is degenerate (collinear control points → straight line).
    // Use the chord endpoints as the line.
    return intersectLineQuad(bP1, bP3, aP1, aP2, aP3).map((r) => ({
      tA: r.tB,
      tB: r.tA,
      x: r.x,
      y: r.y,
      endpointA: r.endpointB,
      endpointB: r.endpointA,
    }));
  }

  // On b's own parabola the quartic below vanishes identically and Ferrari divides by its zero
  // leading coefficient: NaN hits, or roots of rounding noise. A shared parabola has no isolated
  // crossing to find, only where the two stretches overlap or meet (see coincident.js).
  if (liesOnParabola([aP1, aP2, aP3], [bP1, bP2, bP3]))
    return sameCurveHits([aP1, aP2, aP3], [bP1, bP2, bP3], true);

  // Power-form coefficients for curve A.
  const Aa0 = aP1[0],
    Ab0 = aP1[1];
  const Aa1 = 2 * (aP2[0] - aP1[0]),
    Ab1 = 2 * (aP2[1] - aP1[1]);
  const Aa2 = aP1[0] - 2 * aP2[0] + aP3[0],
    Ab2 = aP1[1] - 2 * aP2[1] + aP3[1];

  // Substitute A(s) into B's implicit form. Let dx = A.x(s) - Ba0,
  // dy = A.y(s) - Bb0. Both dx and dy are quadratic in s. So
  //   inside = (Bb2·dx - Ba2·dy)² - Bdet·(Ba1·dy - Bb1·dx)
  // is degree 4 in s.

  // dx = A.x(s) - Ba0 = (Aa0 - Ba0) + Aa1·s + Aa2·s²
  const dx0 = Aa0 - Ba0,
    dx1 = Aa1,
    dx2 = Aa2;
  const dy0 = Ab0 - Bb0,
    dy1 = Ab1,
    dy2 = Ab2;

  // Term U = Bb2·dx - Ba2·dy (quadratic in s, coefficients U0, U1, U2)
  const U0 = Bb2 * dx0 - Ba2 * dy0;
  const U1 = Bb2 * dx1 - Ba2 * dy1;
  const U2 = Bb2 * dx2 - Ba2 * dy2;

  // U² = (U0 + U1·s + U2·s²)² is quartic in s:
  //   c0 = U0²
  //   c1 = 2·U0·U1
  //   c2 = 2·U0·U2 + U1²
  //   c3 = 2·U1·U2
  //   c4 = U2²
  const UU0 = U0 * U0;
  const UU1 = 2 * U0 * U1;
  const UU2 = 2 * U0 * U2 + U1 * U1;
  const UU3 = 2 * U1 * U2;
  const UU4 = U2 * U2;

  // Term V = Ba1·dy - Bb1·dx (quadratic in s)
  const V0 = Ba1 * dy0 - Bb1 * dx0;
  const V1 = Ba1 * dy1 - Bb1 * dx1;
  const V2 = Ba1 * dy2 - Bb1 * dx2;

  // Full polynomial: c = UU - Bdet · V, with V padded to degree 4
  // (V·s^0, V·s^1, V·s^2; no s^3, s^4 contributions).
  const c0 = UU0 - Bdet * V0;
  const c1 = UU1 - Bdet * V1;
  const c2 = UU2 - Bdet * V2;
  const c3 = UU3;
  const c4 = UU4;

  const roots = solveQuartic(c4, c3, c2, c1, c0);
  const out = [];
  for (const tA of roots) {
    if (tA < -EPS || tA > 1 + EPS) continue;
    const tAC = Math.max(0, Math.min(1, tA));
    // A(tAC) = world point.
    const x = (Aa2 * tAC + Aa1) * tAC + Aa0;
    const y = (Ab2 * tAC + Ab1) * tAC + Ab0;
    // Recover tB on curve B by re-solving the 2×2 linear system:
    //   s   = ( Bb2·(x-Ba0) - Ba2·(y-Bb0)) / Bdet
    const tB = (Bb2 * (x - Ba0) - Ba2 * (y - Bb0)) / Bdet;
    if (tB < -EPS || tB > 1 + EPS) continue;
    const tBC = Math.max(0, Math.min(1, tB));
    // De-dupe near-coincident roots (Ferrari can return doubles).
    let dup = false;
    for (const prev of out) {
      if (Math.abs(prev.tA - tAC) < 1e-5 && Math.abs(prev.tB - tBC) < 1e-5) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    out.push({
      tA: tAC,
      tB: tBC,
      x,
      y,
      endpointA: tAC < EPS || tAC > 1 - EPS,
      endpointB: tBC < EPS || tBC > 1 - EPS,
    });
  }
  return out;
}
