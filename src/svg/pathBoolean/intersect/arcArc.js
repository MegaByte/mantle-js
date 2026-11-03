// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcArc — exact intersection of two arcs (each a portion of a rotated
// ellipse), up to 4 points.
//
// Substitute ellipse B's parametric form into A's implicit equation,
// giving a degree-2 polynomial in (cos θ, sin θ). The Weierstrass
// substitution u = tan(θ/2) — cos θ = (1-u²)/(1+u²), sin θ = 2u/(1+u²) —
// then clears to a degree-4 polynomial in u, solved via Ferrari. Each
// real u gives θ = 2·atan(u); filter for θ in arc B's sweep range.
//
// Weierstrass misses θ = π (u → ∞), so that case is tested explicitly.

import { solveQuartic } from '../polyRoots.js';
import { sameEllipseHits } from './coincident.js';

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

export function intersectArcArc(arcA, arcB) {
  const cxA = arcA.cx,
    cyA = arcA.cy,
    rxA = arcA.rx,
    ryA = arcA.ry,
    phiA = arcA.phi;
  const cxB = arcB.cx,
    cyB = arcB.cy,
    rxB = arcB.rx,
    ryB = arcB.ry,
    phiB = arcB.phi;
  if (rxA < EPS || ryA < EPS || rxB < EPS || ryB < EPS) return [];
  // On one ellipse the substitution below vanishes identically and its roots are rounding noise, no
  // answer for two arcs sharing a stretch. Decided on points of B, so an
  // ellipse written with other radii order, frame angle or theta offset is still the same curve.
  const same = sameEllipseHits(arcA, arcB);
  if (same) return same;

  const cpA = Math.cos(phiA),
    spA = Math.sin(phiA);
  const cpB = Math.cos(phiB),
    spB = Math.sin(phiB);
  const rxA2 = rxA * rxA,
    ryA2 = ryA * ryA;

  // B parametric in terms of cos θ and sin θ:
  //   x(θ) = cxB + (cpB·rxB)·cos θ + (-spB·ryB)·sin θ
  //   y(θ) = cyB + (spB·rxB)·cos θ + ( cpB·ryB)·sin θ
  // Let:
  const Ax = cpB * rxB,
    Bx = -spB * ryB;
  const Ay = spB * rxB,
    By = cpB * ryB;
  // So (x - cxA) = (cxB - cxA) + Ax·cos + Bx·sin
  //    (y - cyA) = (cyB - cyA) + Ay·cos + By·sin
  const dCx = cxB - cxA;
  const dCy = cyB - cyA;

  // X' = cpA·(x - cxA) + spA·(y - cyA)
  //    = cpA·dCx + spA·dCy + (cpA·Ax + spA·Ay)·cos + (cpA·Bx + spA·By)·sin
  // Y' = -spA·(x - cxA) + cpA·(y - cyA)
  //    = -spA·dCx + cpA·dCy + (-spA·Ax + cpA·Ay)·cos + (-spA·Bx + cpA·By)·sin

  const Xp0 = cpA * dCx + spA * dCy;
  const XpC = cpA * Ax + spA * Ay;
  const XpS = cpA * Bx + spA * By;

  const Yp0 = -spA * dCx + cpA * dCy;
  const YpC = -spA * Ax + cpA * Ay;
  const YpS = -spA * Bx + cpA * By;

  // F(θ) = ryA² · (Xp0 + XpC·cos + XpS·sin)²
  //       + rxA² · (Yp0 + YpC·cos + YpS·sin)²
  //       - rxA²·ryA²
  //
  // Let c = cos θ, s = sin θ. Both Xp = Xp0 + XpC·c + XpS·s and
  // Yp = Yp0 + YpC·c + YpS·s. The squared terms expand to:
  //   Xp² = Xp0² + XpC²·c² + XpS²·s² + 2·Xp0·XpC·c + 2·Xp0·XpS·s + 2·XpC·XpS·c·s
  // Multiplying by ryA² and summing with rxA²·Yp² gives a polynomial in
  // {1, c, s, c², s², c·s}.

  // Easier: collect F(θ) as A·c² + B·c·s + C·s² + D·c + E·s + F (using
  // s² = 1 - c² to combine the c²/s²/1 terms):
  //   F = A·c² + B·c·s + C·(1 - c²) + D·c + E·s + F_const
  //     = (A - C)·c² + B·c·s + D·c + E·s + (C + F_const)
  // So coefficients of c², cs, c, s, 1 → 5 trig coefficients.
  //
  // Substitute Weierstrass:
  //   c = (1-u²)/(1+u²),  s = 2u/(1+u²),  c² = (1-u²)²/(1+u²)²,
  //   cs = 2u(1-u²)/(1+u²)²
  // Multiply F by (1+u²)² to clear denominators:
  //   F·(1+u²)² = (A-C)·(1-u²)² + B·2u(1-u²) + D·(1-u²)(1+u²) + E·2u(1+u²) + (C+F_const)·(1+u²)²
  //
  // Each piece is a polynomial in u of degree ≤ 4. Compute coefficients.

  // Step 1: Compute the trig-form coefficients of F:
  //   F(θ) = α·c² + β·c·s + γ·s² + δ·c + ε·s + ζ
  // where (raw from expansion):
  const alpha_raw = ryA2 * XpC * XpC + rxA2 * YpC * YpC;
  const beta_raw = ryA2 * 2 * XpC * XpS + rxA2 * 2 * YpC * YpS;
  const gamma_raw = ryA2 * XpS * XpS + rxA2 * YpS * YpS;
  const delta_raw = ryA2 * 2 * Xp0 * XpC + rxA2 * 2 * Yp0 * YpC;
  const eps_raw = ryA2 * 2 * Xp0 * XpS + rxA2 * 2 * Yp0 * YpS;
  const zeta_raw = ryA2 * Xp0 * Xp0 + rxA2 * Yp0 * Yp0 - rxA2 * ryA2;

  // Step 2: Apply s² = 1 - c² to fold gamma into alpha and zeta:
  //   gamma·s² = gamma·(1 - c²) = -gamma·c² + gamma
  const A = alpha_raw - gamma_raw;
  const B = beta_raw;
  const D = delta_raw;
  const E = eps_raw;
  const F = zeta_raw + gamma_raw;
  // (C term — coefficient of s² — is now zero.)
  // So F(θ) = A·c² + B·c·s + D·c + E·s + F.

  // Step 3: Weierstrass substitution.
  // c = (1-u²)/(1+u²), s = 2u/(1+u²).
  // Multiply by (1+u²)² to clear denominators.
  //
  // F·(1+u²)² = A·(1-u²)² + B·2u·(1-u²) + D·(1-u²)(1+u²) + E·2u·(1+u²) + F·(1+u²)²
  //
  // Expand each:
  //   A·(1-u²)² = A·(1 - 2u² + u⁴) = A - 2Au² + A·u⁴
  //   B·2u·(1-u²) = 2Bu - 2B·u³
  //   D·(1-u²)(1+u²) = D·(1-u⁴) = D - D·u⁴
  //   E·2u·(1+u²) = 2Eu + 2E·u³
  //   F·(1+u²)² = F·(1 + 2u² + u⁴) = F + 2F·u² + F·u⁴
  //
  // Collect coefficients of u^0..u^4:
  const c0 = A + D + F;
  const c1 = 2 * B + 2 * E;
  const c2 = -2 * A + 2 * F;
  const c3 = -2 * B + 2 * E;
  const c4 = A - D + F;

  // Solve the quartic c4·u⁴ + c3·u³ + c2·u² + c1·u + c0 = 0.
  const uRoots = solveQuartic(c4, c3, c2, c1, c0);

  const sweepA = arcA.theta_end - arcA.theta_start;
  const tLoA = Math.min(arcA.theta_start, arcA.theta_end);
  const tHiA = Math.max(arcA.theta_start, arcA.theta_end);
  const sweepB = arcB.theta_end - arcB.theta_start;
  const tLoB = Math.min(arcB.theta_start, arcB.theta_end);
  const tHiB = Math.max(arcB.theta_start, arcB.theta_end);

  const out = [];

  const tryAddTheta = (theta) => {
    // Compute (x, y) on B at θ.
    const c = Math.cos(theta),
      s = Math.sin(theta);
    const x = cxB + Ax * c + Bx * s;
    const y = cyB + Ay * c + By * s;

    const Xp = cpA * (x - cxA) + spA * (y - cyA);
    const Yp = -spA * (x - cxA) + cpA * (y - cyA);
    const onA = ryA2 * Xp * Xp + rxA2 * Yp * Yp - rxA2 * ryA2;

    const gradHalf = Math.hypot(ryA2 * Xp, rxA2 * Yp);
    const minR = Math.min(Math.max(rxA, ryA), Math.max(rxB, ryB));
    if (!(Math.abs(onA) <= 2 * gradHalf * 5e-7 * minR)) return;

    // Filter B's sweep range.
    let thetaB = theta;
    while (thetaB < tLoB - EPS) thetaB += TWO_PI;
    while (thetaB > tHiB + EPS) thetaB -= TWO_PI;
    if (thetaB < tLoB - EPS || thetaB > tHiB + EPS) return;
    const tB = sweepB === 0 ? 0 : (thetaB - arcB.theta_start) / sweepB;
    if (tB < -EPS || tB > 1 + EPS) return;

    // Compute A's theta for this point and filter. Xp/Yp were
    // computed above for the on-ellipse check; reuse them.
    const thetaAraw = Math.atan2(Yp / ryA, Xp / rxA);
    let thetaA = thetaAraw;
    while (thetaA < tLoA - EPS) thetaA += TWO_PI;
    while (thetaA > tHiA + EPS) thetaA -= TWO_PI;
    if (thetaA < tLoA - EPS || thetaA > tHiA + EPS) return;
    const tA = sweepA === 0 ? 0 : (thetaA - arcA.theta_start) / sweepA;
    if (tA < -EPS || tA > 1 + EPS) return;
    const tAC = Math.max(0, Math.min(1, tA));
    const tBC = Math.max(0, Math.min(1, tB));
    let dup = false;
    for (const prev of out) {
      if (Math.abs(prev.tA - tAC) < 1e-5 && Math.abs(prev.tB - tBC) < 1e-5) {
        dup = true;
        break;
      }
    }
    if (dup) return;
    out.push({
      tA: tAC,
      tB: tBC,
      x,
      y,
      endpointA: tAC < EPS || tAC > 1 - EPS,
      endpointB: tBC < EPS || tBC > 1 - EPS,
    });
  };

  for (const u of uRoots) {
    const theta = 2 * Math.atan(u);
    tryAddTheta(theta);
  }
  // Check θ = π separately (u → ∞ limit).
  // The Weierstrass substitution misses θ = π. Test it explicitly.
  tryAddTheta(Math.PI);

  return out;
}
