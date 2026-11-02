// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPatchInside — the most basic invariant a patch has: its own interior point is inside the
// shape. A patch that fails this is not a piece of the shape at all, and no kernel treatment of
// its constraints can stop it painting where the shape is not.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { insideContour, patchBBox } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
let patchesN = 0,
  outside = 0,
  shapesBad = 0,
  allCut = 0,
  allCutOutside = 0;
const bad = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
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
  let sBad = 0;
  for (const p of patches) {
    patchesN++;
    const onlyCuts = p.curves.every((sg) => sg.cut);
    if (onlyCuts) allCut++;
    if (!insideContour(all, p.inside[0], p.inside[1])) {
      outside++;
      sBad++;
      if (onlyCuts) allCutOutside++;
      if (bad.length < 8)
        bad.push({
          si,
          n: p.curves.length,
          onlyCuts,
          at: `(${p.inside[0].toFixed(1)},${p.inside[1].toFixed(1)})`,
        });
    }
  }
  if (sBad) shapesBad++;
}
console.log(
  `${patchesN} patches; ${outside} have an interior point OUTSIDE the shape (${((100 * outside) / patchesN).toFixed(2)}%), across ${shapesBad} shapes`,
);
console.log(
  `  ${allCut} patches are bounded ENTIRELY by cuts; ${allCutOutside} of those are outside`,
);
for (const b of bad)
  console.log(`    shape ${b.si}: ${b.n} curves${b.onlyCuts ? ' (all cuts)' : ''} at ${b.at}`);
