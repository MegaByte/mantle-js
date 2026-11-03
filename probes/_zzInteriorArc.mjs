// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzInteriorArc — outline curves that are not edges of the FILL. Under nonzero winding a shape can
// cover both sides of one of its own curves (overlapping subpaths), and two patches then meet along
// it. Both ramp it as an edge, and OVER adds their two shares to less than the ink -- the same
// deficit a seam would cause, on a curve nobody thought of as a seam.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { insideContour, patchBBox } from '../src/renderer/cpatchConvert.js';
import { segPt, segTangent } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
let curves = 0,
  interior = 0,
  shapesWith = 0,
  whole = 0;
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const list = contoursToConverter(
    curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
    null,
  );
  if (!list || !list.length) continue;
  const all = [];
  for (const c of list) {
    for (const g of c) all.push(g);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
  }
  const patches = [];
  try {
    packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {
    continue;
  }
  if (!patches.length) continue;
  const bb = patchBBox(all);
  const eps = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 2e-4;
  const seen = new Set();
  let any = 0;
  for (const p of patches)
    for (const sg of p.curves) {
      if (sg.cut) continue;
      const id = sg.P.map((q) => q.join(',')).join(';');
      if (seen.has(id)) continue;
      seen.add(id);
      curves++;
      // ALONG THE whole CURVE, not at its midpoint. A curve can be an edge of the fill over part
      // of its length and interior over the rest, wherever another subpath overlaps it partway.
      let hits = 0;
      for (let q = 1; q < 8; q++) {
        const tt = q / 8,
          m = segPt(sg, tt),
          t = segTangent(sg, tt);
        const L = Math.hypot(t[0], t[1]);
        if (!(L > 0)) continue;
        const nx = -t[1] / L,
          ny = t[0] / L;
        if (
          insideContour(all, m[0] + nx * eps, m[1] + ny * eps) &&
          insideContour(all, m[0] - nx * eps, m[1] - ny * eps)
        )
          hits++;
      }
      if (hits) {
        interior++;
        any++;
        if (hits >= 7) whole++;
      }
    }
  if (any) shapesWith++;
}
console.log(`${curves} distinct outline curves in packed patches`);
console.log(
  `  ${interior} have the fill on BOTH sides (${((100 * interior) / Math.max(1, curves)).toFixed(1)}%), across ${shapesWith} shapes`,
);
