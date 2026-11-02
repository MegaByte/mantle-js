// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lineQuad — intersect a line a(t) = a0 + t·(a1-a0) with a quadratic
// Bezier b(s) = (1-s)²·b0 + 2(1-s)s·b1 + s²·b2.
//
// Substitute into the implicit line equation:
//   nx·(x - a0.x) + ny·(y - a0.y) = 0,  with (nx, ny) = perp(a1-a0).
// Result is a quadratic in s; solve, accept roots in [0, 1], map
// back to tA via the parametric form on a.
//
// Up to 2 intersections.

import { solveQuadratic } from '../polyRoots.js';

const EPS = 1e-9;

export function intersectLineQuad(aP1, aP2, bP1, bP2, bP3) {
  const ax = aP2[0] - aP1[0];
  const ay = aP2[1] - aP1[1];
  // Line implicit normal (perp to direction).
  const nx = -ay;
  const ny = ax;
  // Quadratic Bezier in power form: b(s) = B + s·C + s²·D where
  //   B = b0
  //   C = 2(b1 - b0)
  //   D = b0 - 2·b1 + b2
  // Worked relative to the line's start (as lineCubic.js): the end of the curve is summed from differences, not
  // rounded by an ulp of the pair's offset from the origin.
  const q1x = bP1[0] - aP1[0],
    q1y = bP1[1] - aP1[1];
  const q2x = bP2[0] - aP1[0],
    q2y = bP2[1] - aP1[1];
  const q3x = bP3[0] - aP1[0],
    q3y = bP3[1] - aP1[1];
  const Bx = q1x,
    By = q1y;
  const Cx = 2 * (q2x - q1x),
    Cy = 2 * (q2y - q1y);
  const Dx = q1x - 2 * q2x + q3x;
  const Dy = q1y - 2 * q2y + q3y;
  // f(s) = n · (b(s) - a0). Solve f(s) = 0.
  //   f(s) = (nx·Dx + ny·Dy)·s² + (nx·Cx + ny·Cy)·s + (nx·(Bx-a0.x) + ny·(By-a0.y))
  const A2 = nx * Dx + ny * Dy;
  const A1 = nx * Cx + ny * Cy;
  const A0 = nx * Bx + ny * By;
  const roots = solveQuadratic(A2, A1, A0);
  const out = [];
  // Line parametric form length² for projecting back to tA.
  const lineLen2 = ax * ax + ay * ay;
  if (!(lineLen2 > 0)) return out; // a divide guard: a line that is a point never gets here (intersect/index.js)
  for (const s of roots) {
    if (s < -EPS || s > 1 + EPS) continue;
    const sC = Math.max(0, Math.min(1, s));
    // Evaluate quadratic at sC.
    const rx = (Dx * sC + Cx) * sC + Bx;
    const ry = (Dy * sC + Cy) * sC + By;
    const x = rx + aP1[0],
      y = ry + aP1[1];
    // Project onto line to get tA.
    const tA = (rx * ax + ry * ay) / lineLen2;
    if (tA < -EPS || tA > 1 + EPS) continue;
    const tAC = Math.max(0, Math.min(1, tA));
    out.push({
      tA: tAC,
      tB: sC,
      x,
      y,
      endpointA: tAC < EPS || tAC > 1 - EPS,
      endpointB: sC < EPS || sC > 1 - EPS,
    });
  }
  return out;
}
