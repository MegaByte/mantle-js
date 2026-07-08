// lineCubic — intersect a line with a cubic Bezier.
//
// Cubic Bezier in power form: b(s) = B + s·C + s²·D + s³·E where
//   B = b0
//   C = 3(b1 - b0)
//   D = 3(b0 - 2·b1 + b2)
//   E = -b0 + 3·b1 - 3·b2 + b3
//
// Project line onto its perpendicular normal → implicit equation.
// Substitute b(s) → cubic in s, solve via Cardano. Roots in [0, 1].
//
// Up to 3 intersections.

import { solveCubic } from '../polyRoots.js';

const EPS = 1e-9;

export function intersectLineCubic(aP1, aP2, bP1, bP2, bP3, bP4) {
  const ax = aP2[0] - aP1[0];
  const ay = aP2[1] - aP1[1];
  const lineLen2 = ax*ax + ay*ay;
  if (lineLen2 < EPS) return [];
  const nx = -ay;
  const ny = ax;
  const Bx = bP1[0],                                By = bP1[1];
  const Cx = 3*(bP2[0]-bP1[0]),                     Cy = 3*(bP2[1]-bP1[1]);
  const Dx = 3*(bP1[0]-2*bP2[0]+bP3[0]),            Dy = 3*(bP1[1]-2*bP2[1]+bP3[1]);
  const Ex = -bP1[0]+3*bP2[0]-3*bP3[0]+bP4[0];
  const Ey = -bP1[1]+3*bP2[1]-3*bP3[1]+bP4[1];
  // f(s) = n · (b(s) - a0) is cubic in s:
  //   coef3 = n · E
  //   coef2 = n · D
  //   coef1 = n · C
  //   coef0 = n · (B - a0)
  const c3 = nx*Ex + ny*Ey;
  const c2 = nx*Dx + ny*Dy;
  const c1 = nx*Cx + ny*Cy;
  const c0 = nx*(Bx-aP1[0]) + ny*(By-aP1[1]);
  const roots = solveCubic(c3, c2, c1, c0);
  const out = [];
  for (const s of roots) {
    if (s < -EPS || s > 1 + EPS) continue;
    const sC = Math.max(0, Math.min(1, s));
    const x = (((Ex*sC) + Dx)*sC + Cx)*sC + Bx;
    const y = (((Ey*sC) + Dy)*sC + Cy)*sC + By;
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

