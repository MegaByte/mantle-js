// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await importSvg(readFileSync(ROOT + '/examples/tiger.svg', 'utf8'));
// bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by 8 floats and sends most
// shapes down the CDT partition, so a build measured that way is 20x the real one. Strip it, as the tests do.
const input = {
  curveFloats: new Float32Array(bundle.curves),
  metaFloats: bundle.meta ? new Float32Array(bundle.meta, 32) : null,
  metaFloatsPerShape: bundle.metaFloatsPerShape,
  ranges: bundle.curveRangesByShape,
  numShapes: bundle.numShapes,
};
const t = performance.now();
buildLbBundle(input);
console.log((performance.now() - t).toFixed(0));
