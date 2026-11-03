// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Import CSS blend modes and legacy Flash operators into distinct metadata codes.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}

const META_STRIDE = 48;
const META_BLENDMODE = 33; // texel 8.y = blendMode (float at offset 33)

async function importBlend(value) {
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="red" style="mix-blend-mode: ${value}"/>
</svg>`;
  const sections = await importSvg(svg, {});
  if (!sections || sections.numShapes < 1) {
    fail(`importer produced no shapes for mix-blend-mode="${value}"`);
    return -1;
  }
  const m = new Float32Array(sections.meta, 32);
  return Math.floor(m[META_BLENDMODE] + 0.5);
}

const CASES = [
  // CSS Compositing 1
  ['normal', 0],
  ['multiply', 1],
  ['screen', 2],
  ['overlay', 3],
  ['darken', 4],
  ['lighten', 5],
  ['color-dodge', 6],
  ['color-burn', 7],
  ['hard-light', 8],
  ['soft-light', 9],
  ['difference', 10],
  ['exclusion', 11],
  ['hue', 12],
  ['saturation', 13],
  ['color', 14],
  ['luminosity', 15],
  // CSS plus-lighter has clamped additive alpha; Flash add keeps its legacy alpha.
  ['plus-lighter', 19],
  ['add', 16],
  ['plus-darker', 17],
  ['subtract', 17],
  ['invert', 18],
  // Flash AS3 coverage operators (SWF-only; SVG has no native syntax)
  ['alpha', 20],
  ['erase', 21],
  // Unknown → normal (0)
  ['bogus-future', 0],
];

for (const [value, expected] of CASES) {
  const got = await importBlend(value);
  if (got === expected) ok(`mix-blend-mode "${value}" → ${got}`);
  else fail(`mix-blend-mode "${value}" → ${got} (expected ${expected})`);
}

console.log();
console.log(failures === 0 ? 'BLEND-MODE PASS' : `BLEND-MODE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
