// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
  const lineLen2 = ax * ax + ay * ay;
  if (!(lineLen2 > 0)) return []; // a divide guard: a line that is a point never gets here (intersect/index.js)
  const nx = -ay;
  const ny = ax;
  // WORK RELATIVE TO THE LINE'S START. The control points are differenced from a0 first: a pair sitting far from
  // the origin (offset >> its own size) otherwise rounds b(1) = B + C + D + E by an ulp of the OFFSET, which moves
  // the root of a line that ends ON the cubic by ~1e-10 of the parameter and, projected onto a line far shorter
  // than the cubic, lands the crossing 1e-6 of the line from its vertex. Differences of nearby doubles are
  // exact, so the answer does not depend on where the pair is.
  const q1x = bP1[0] - aP1[0],
    q1y = bP1[1] - aP1[1];
  const q2x = bP2[0] - aP1[0],
    q2y = bP2[1] - aP1[1];
  const q3x = bP3[0] - aP1[0],
    q3y = bP3[1] - aP1[1];
  const q4x = bP4[0] - aP1[0],
    q4y = bP4[1] - aP1[1];
  const Bx = q1x,
    By = q1y;
  const Cx = 3 * (q2x - q1x),
    Cy = 3 * (q2y - q1y);
  const Dx = 3 * (q1x - 2 * q2x + q3x),
    Dy = 3 * (q1y - 2 * q2y + q3y);
  const Ex = -q1x + 3 * q2x - 3 * q3x + q4x;
  const Ey = -q1y + 3 * q2y - 3 * q3y + q4y;
  // f(s) = n · (b(s) - a0) is cubic in s:
  //   coef3 = n · E
  //   coef2 = n · D
  //   coef1 = n · C
  //   coef0 = n · (B - a0)
  const c3 = nx * Ex + ny * Ey;
  const c2 = nx * Dx + ny * Dy;
  const c1 = nx * Cx + ny * Cy;
  const c0 = nx * Bx + ny * By;
  const roots = solveCubic(c3, c2, c1, c0);
  const out = [];
  for (const s of roots) {
    if (s < -EPS || s > 1 + EPS) continue;
    const sC = Math.max(0, Math.min(1, s));
    const rx = ((Ex * sC + Dx) * sC + Cx) * sC + Bx;
    const ry = ((Ey * sC + Dy) * sC + Cy) * sC + By;
    const x = rx + aP1[0],
      y = ry + aP1[1];
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
