// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCoverArea — how many times CPatch shades each pixel of the artwork.
//
// The kernel's cost is fragments x constraints, and the fragment count is not the shape's area:
// every patch draws its own convex cover, the covers are dilated to hold the AA band, and patches
// of one shape overlap by construction. This prices that -- cover area against ink area -- so the
// two halves of the fragment cost can be attacked separately instead of guessed at.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
let coverArea = 0,
  inkArea = 0,
  nCells = 0,
  curveSum = 0,
  nPatch = 0;
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  let m = null;
  globalThis.__CP_CURVE_HIST = [];
  try {
    m = packCPatchShape(cs, 0, { evenOdd });
  } catch {
    continue;
  }
  if (!m) continue;
  for (const n of globalThis.__CP_CURVE_HIST) {
    nCells++;
    curveSum += n;
  }
  // The drawn geometry: triangles of the cover fans, in em^2.
  const V = m.verts,
    ST = 24;
  for (let i = 0; i + 3 * ST <= V.length; i += 3 * ST) {
    const ax = V[i],
      ay = V[i + 1],
      bx = V[i + ST],
      by = V[i + ST + 1],
      cx2 = V[i + 2 * ST],
      cy2 = V[i + 2 * ST + 1];
    coverArea += Math.abs((bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax)) / 2;
  }
  // The shape's own area, by the same oracle the reference uses.
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let y0 = Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  const ROWS = 96,
    dy = (y1 - y0) / ROWS;
  if (!(dy > 0)) continue;
  for (let k = 0; k < ROWS; k++) {
    const y = y0 + (k + 0.5) * dy;
    for (const sp of rowSpans(all, y) || []) inkArea += (sp[1] - sp[0]) * dy;
  }
  nPatch += m.verts.length / (24 * 3) / 1;
}
console.log(
  `cover area ${coverArea.toExponential(3)} em^2 over ink ${inkArea.toExponential(3)} em^2` +
    `  ->  ${(coverArea / inkArea).toFixed(2)}x OVERDRAW`,
);
console.log(`cells ${nCells}, mean curves per cell ${(curveSum / nCells).toFixed(2)}`);
console.log(`triangles ${nPatch.toFixed(0)}  (mean ${(nPatch / nCells).toFixed(1)} per cell)`);
