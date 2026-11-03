// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const SVG = readFileSync(
  process.env.SVG || (console.error('SVG=<file.svg> is required'), process.exit(2)),
  'utf8',
)
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float64Array(sec.curves64);
const lists = [];
for (const r of sec.curveRangesByShape || []) {
  if (!r) continue;
  let l = null;
  try {
    l = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {}
  if (l && l.length) lists.push(l);
}
for (let pass = 0; pass < 2; pass++) {
  const t0 = Date.now();
  let n = 0;
  for (const l of lists) {
    try {
      if (packCPatchShape(l, 0, {})) n++;
    } catch {}
  }
  console.log(`  pass ${pass}: ${n} shapes packed in ${Date.now() - t0} ms`);
}
