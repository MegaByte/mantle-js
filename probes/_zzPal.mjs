// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8').replace(
  /stroke\s*=\s*"[^"]*"/g,
  'stroke="none"',
);
const sec = await importSvg(SVG, { preserveViewport: true });
const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = m.metaFloats,
  ST = m.floatsPerShape;
for (const s of (process.env.SHAPES || '12,13,14,15,16,17,105').split(',').map(Number)) {
  const o = s * ST;
  console.log(
    `s${s}: rgb(${Math.round(MF[o + 4] * 255)},${Math.round(MF[o + 5] * 255)},${Math.round(MF[o + 6] * 255)}) a=${MF[o + 7].toFixed(2)} evenOdd=${MF[o + 13] > 0.5}`,
  );
}
