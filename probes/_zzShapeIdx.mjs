// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzShapeIdx — the meta's shape indices and their fills, because there are TWO index spaces and
// every CPatch defect report in this tree quotes one of them without saying which.
//
// The importer's meta carries one row per shape INCLUDING the unfilled ones (fill:none strokes sit
// there with alpha 0). The renderer's bundle carries only the FILLED ones. An asset of 62 meta
// rows and 58 filled ones has, from the fifth unfilled element onward, two numberings that differ by four --
// and "s39" from a frame probe is then a different shape from the renderer's 39.
//
// That is not pedantry. It can make a per-shape coverage check vacuous: _cpatchShapeFill asked about
// shape numbers in the wrong space answers "covered perfectly" about four other shapes. Ask this
// first, then ask the coverage probe.
import { readFileSync } from 'fs';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const sec = await importSvg(readFileSync(process.argv[2], 'utf8'), { preserveViewport: true });
const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = m.metaFloats,
  ST = m.floatsPerShape | 0;
const hex = (o) =>
  '#' +
  [4, 5, 6]
    .map((k) =>
      Math.round(MF[o + k] * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase();
let filled = 0;
for (let s = 0; s < m.numShapes; s++) if (MF[s * ST + 7] > 0) filled++;
console.log('meta shapes', m.numShapes, ' with alpha>0:', filled);
for (let s = 30; s < Math.min(46, m.numShapes); s++) {
  const o = s * ST;
  console.log(`  shape ${String(s).padStart(3)}  ${hex(o)}  a=${MF[o + 7].toFixed(2)}`);
}
console.log('numShapes', m.numShapes);
