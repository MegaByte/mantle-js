// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextAnchorSmoke.mjs — text-anchor + tspan absolute x/y +
// xml:space="preserve".

import { readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const importOpts = { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs };

const META_HEADER_BYTES = 32;
const asMetaF32 = (bundle) =>
  new Float32Array(bundle.meta, META_HEADER_BYTES, bundle.numShapes * bundle.metaFloatsPerShape);
const readXmin = (bundle, mf, i) => mf[i * bundle.metaFloatsPerShape];
const readXmax = (bundle, mf, i) => mf[i * bundle.metaFloatsPerShape + 2];

// ---- T1: text-anchor=middle centers run at anchor X ----
{
  // anchor x=100. "Hello" (5 glyphs @24pt ≈ 60px wide).
  // start: glyphs start at x=100
  // middle: glyphs centered at x=100 → first glyph xmin ≈ 100 - 30 = 70
  const start = await importSvg(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="100" y="50" font-family="Arial" font-size="24" fill="black" text-anchor="start">Hello</text>
</svg>`,
    importOpts,
  );
  const mid = await importSvg(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="100" y="50" font-family="Arial" font-size="24" fill="black" text-anchor="middle">Hello</text>
</svg>`,
    importOpts,
  );
  if (start.numShapes !== 5 || mid.numShapes !== 5)
    fail(`T1 numShapes ${start.numShapes}/${mid.numShapes}`);
  else {
    const sMf = asMetaF32(start);
    const mMf = asMetaF32(mid);
    const startFirstX = readXmin(start, sMf, 0);
    const startLastXmax = readXmax(start, sMf, 4);
    const midFirstX = readXmin(mid, mMf, 0);
    const midLastXmax = readXmax(mid, mMf, 4);
    const runWidth = startLastXmax - startFirstX;
    // middle anchor: center of run sits at x=100 → midpoint == 100.
    const midCenter = (midFirstX + midLastXmax) / 2;
    if (Math.abs(midCenter - 100) > 1)
      fail(`T1 middle anchor: center=${midCenter.toFixed(2)} (expected ~100)`);
    else
      ok(
        `T1 text-anchor=middle: run width=${runWidth.toFixed(2)}, centered at x=${midCenter.toFixed(2)}`,
      );
  }
}

// ---- T2: text-anchor=end places run END at anchor ----
{
  const end = await importSvg(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="200" y="50" font-family="Arial" font-size="24" fill="black" text-anchor="end">Hello</text>
</svg>`,
    importOpts,
  );
  if (end.numShapes !== 5) fail(`T2 expected 5 shapes, got ${end.numShapes}`);
  else {
    const mf = asMetaF32(end);
    const lastXmax = readXmax(end, mf, 4);
    if (Math.abs(lastXmax - 200) > 2)
      fail(`T2 end anchor: last xmax=${lastXmax.toFixed(2)} (expected ~200)`);
    else ok(`T2 text-anchor=end: run ends at x=${lastXmax.toFixed(2)}`);
  }
}

// ---- T3: <tspan x=N> absolute override resets pen ----
{
  // "A<tspan x=200>B" — A at x≈10, B at x≈200 (NOT 10+adv(A)).
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">A<tspan x="200">B</tspan></text>
</svg>`;
  const b = await importSvg(svg, importOpts);
  if (b.numShapes !== 2) fail(`T3 numShapes ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    const xA = readXmin(b, mf, 0);
    const xB = readXmin(b, mf, 1);
    // A near 10, B near 200.
    if (Math.abs(xB - 200) > 2) fail(`T3 tspan x: B xmin=${xB.toFixed(2)} (expected ~200)`);
    else if (xA > 12) fail(`T3 A moved unexpectedly to ${xA.toFixed(2)}`);
    else ok(`T3 <tspan x=200>: A at ${xA.toFixed(2)}, B at ${xB.toFixed(2)}`);
  }
}

// ---- T4: xml:space="preserve" keeps whitespace ----
{
  // "A    B" (multi-space) collapses to "A B" by default. With
  // xml:space=preserve, the spaces stay → run is wider.
  const collapsed = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">A    B</text>
</svg>`;
  const preserved = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black" xml:space="preserve">A    B</text>
</svg>`;
  const b1 = await importSvg(collapsed, importOpts);
  const b2 = await importSvg(preserved, importOpts);
  if (b1.numShapes !== 2 || b2.numShapes !== 2)
    fail(`T4 numShapes ${b1.numShapes}/${b2.numShapes}`);
  else {
    const mf1 = asMetaF32(b1);
    const mf2 = asMetaF32(b2);
    const xB1 = readXmin(b1, mf1, 1);
    const xB2 = readXmin(b2, mf2, 1);
    // Preserved should push B further right by ~3 extra spaces × space-width.
    if (xB2 - xB1 < 5)
      fail(`T4 xml:space=preserve: B shift only ${(xB2 - xB1).toFixed(2)} (expected ≥5px)`);
    else
      ok(
        `T4 xml:space=preserve: B xmin ${xB1.toFixed(2)} (collapsed) → ${xB2.toFixed(2)} (preserved)`,
      );
  }
}

// ---- T5: text-anchor=middle with mixed tspans ----
{
  // "AB<tspan font-size=48>C</tspan>DE" — total width spans the big C.
  // text-anchor=middle should center the whole composed run.
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
  <text x="200" y="100" font-family="Arial" font-size="24" fill="black" text-anchor="middle">AB<tspan font-size="48">C</tspan>DE</text>
</svg>`;
  const b = await importSvg(svg, importOpts);
  if (b.numShapes !== 5) fail(`T5 numShapes ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    const firstX = readXmin(b, mf, 0);
    const lastXmax = readXmax(b, mf, 4);
    const center = (firstX + lastXmax) / 2;
    if (Math.abs(center - 200) > 2)
      fail(`T5 mixed-tspan center=${center.toFixed(2)} (expected ~200)`);
    else ok(`T5 text-anchor=middle with mixed tspan: center at x=${center.toFixed(2)}`);
  }
}

console.log();
console.log(failures === 0 ? 'SVG-ANCHOR PASS' : `SVG-ANCHOR FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
