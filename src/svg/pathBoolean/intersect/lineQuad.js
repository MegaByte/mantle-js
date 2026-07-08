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
  const Bx = bP1[0],            By = bP1[1];
  const Cx = 2*(bP2[0]-bP1[0]), Cy = 2*(bP2[1]-bP1[1]);
  const Dx = bP1[0]-2*bP2[0]+bP3[0];
  const Dy = bP1[1]-2*bP2[1]+bP3[1];
  // f(s) = n · (b(s) - a0). Solve f(s) = 0.
  //   f(s) = (nx·Dx + ny·Dy)·s² + (nx·Cx + ny·Cy)·s + (nx·(Bx-a0.x) + ny·(By-a0.y))
  const A2 = nx*Dx + ny*Dy;
  const A1 = nx*Cx + ny*Cy;
  const A0 = nx*(Bx-aP1[0]) + ny*(By-aP1[1]);
  const roots = solveQuadratic(A2, A1, A0);
  const out = [];
  // Line parametric form length² for projecting back to tA.
  const lineLen2 = ax*ax + ay*ay;
  if (lineLen2 < EPS) return out;
  for (const s of roots) {
    if (s < -EPS || s > 1 + EPS) continue;
    const sC = Math.max(0, Math.min(1, s));
    // Evaluate quadratic at sC.
    const x = ((Dx*sC) + Cx)*sC + Bx;
    const y = ((Dy*sC) + Cy)*sC + By;
    // Project onto line to get tA.
    const tA = ((x - aP1[0])*ax + (y - aP1[1])*ay) / lineLen2;
    if (tA < -EPS || tA > 1 + EPS) continue;
    const tAC = Math.max(0, Math.min(1, tA));
    out.push({
      tA: tAC, tB: sC, x, y,
      endpointA: tAC < EPS || tAC > 1 - EPS,
      endpointB: sC < EPS || sC > 1 - EPS,
    });
  }
  return out;
}

