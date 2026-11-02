// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8').replace(
  /stroke\s*=\s*"[^"]*"/g,
  'stroke="none"',
);
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const r = sec.curveRangesByShape.find(Boolean);
const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
const m = packCPatchShape(cs, 0, { evenOdd: false });
const hist = new Map();
for (let i = 0; i < m.texels.length; i += 28) {
  const k = m.texels[i + 3];
  hist.set(k, (hist.get(k) || 0) + 1);
}
console.log(
  'dropped',
  m.dropped,
  'cells',
  m.cells,
  'unresolved',
  m.unresolved,
  'blocks',
  m.texels.length / 28,
  'verts',
  m.verts.length / 24,
);
console.log(
  'block kinds:',
  [...hist]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => k + ':' + v)
    .join(' '),
);
