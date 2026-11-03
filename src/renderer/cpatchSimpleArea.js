// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { CPK_AREA, CPK_AREA_RIGHT } from './cpatchPack.js';
import { certifySimplePolynomialPaint } from '../core/polynomialPaint.js';
export { certifySimplePolynomialPaint };
export function packSimplePolynomialPaint(cert, baseBlock = 0, opts = {}) {
  const curves = cert.curves;
  let lo0 = Infinity,
    lo1 = Infinity,
    hi0 = -Infinity,
    hi1 = -Infinity;
  let hasCubicArea = false;
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    if (c.t === 'cubic') hasCubicArea = true;
    const P = c.P;
    for (let k = 0; k < P.length; k++) {
      const x = P[k][0],
        y = P[k][1];
      if (x < lo0) lo0 = x;
      if (x > hi0) hi0 = x;
      if (y < lo1) lo1 = y;
      if (y > hi1) hi1 = y;
    }
  }
  if (opts.areaBounds) [lo0, lo1, hi0, hi1] = opts.areaBounds;
  const ox = opts.areaFrame ? opts.areaFrame[0] : Math.fround(lo0),
    oy = opts.areaFrame ? opts.areaFrame[1] : Math.fround(lo1);
  const texels = new Float32Array(curves.length * 28),
    verts = new Float32Array(6 * 24);
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i],
      at = i * 28;
    texels[at + 3] =
      CPK_AREA +
      (c._convexEnd < 0 ? CPK_AREA_RIGHT : 0) +
      (c.t === 'cubic' ? 34 : c.t === 'quad' ? 33 : 0);
    const P = c.P;
    for (let k = 0; k < P.length; k++) {
      texels[at + 20 + k * 2] = P[k][0] - ox;
      texels[at + 21 + k * 2] = P[k][1] - oy;
    }
  }
  const bx = [lo0 - ox, hi0 - ox, hi0 - ox, lo0 - ox];
  const by = [lo1 - oy, lo1 - oy, hi1 - oy, hi1 - oy];
  const dx = [-1, 1, 1, -1],
    dy = [-1, -1, 1, 1];
  const idx = [0, 1, 2, 0, 2, 3];
  for (let i = 0; i < 6; i++) {
    const k = idx[i],
      at = i * 24;
    verts[at] = bx[k];
    verts[at + 1] = by[k];
    verts[at + 2] = dx[k];
    verts[at + 3] = dy[k];
    verts[at + 4] = 2000;
    verts[at + 5] = 14;
    verts[at + 6] = 1;
    verts[at + 17] = ox;
    verts[at + 18] = oy;
    verts[at + 19] = baseBlock;
    verts[at + 20] = curves.length;
  }
  if (opts.onPatches) opts.onPatches([{ curves, bbox: [lo0, lo1, hi0, hi1] }], null);
  return {
    texels,
    verts,
    vertexCount: 6,
    cpatch: true,
    cpatchAreaOnly: true,
    areaCurves: curves.length,
    kindMask: 1 << 14,
    hasQuadraticArea: true,
    hasCubicArea,
    patches: 1,
    dropped: 0,
    cells: 1,
    unresolved: 0,
    allSeam: 0,
    comp: 0,
    kinds: {},
  };
}
