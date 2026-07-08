// svgTextAnchorPerTspanSmoke.mjs — SVG 2 chunk model: a <tspan> with
// absolute x= starts a new text-positioning chunk; text-anchor on that
// tspan governs the chunk's alignment independently of the root
// <text>'s anchor.

import { readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

const arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const META_HEADER_BYTES = 32;
const asMetaF32 = (bundle) =>
  new Float32Array(bundle.meta, META_HEADER_BYTES,
    bundle.numShapes * bundle.metaFloatsPerShape);
// bbox is (xmin, ymin, xmax, ymax) at f0-3.
const xmin = (b, mf, i) => mf[i * b.metaFloatsPerShape + 0];
const xmax = (b, mf, i) => mf[i * b.metaFloatsPerShape + 2];

// T1: root anchor=middle, one chunk only (sanity).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="100" y="50" font-family="Arial" font-size="48" fill="black" text-anchor="middle">ABC</text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  const mf = asMetaF32(b);
  // Run centered at x=100. Width is 3*~width/glyph. Just check that
  // first glyph's xmin < 100 and last glyph's xmax > 100.
  const x0 = xmin(b, mf, 0);
  const xN = xmax(b, mf, b.numShapes - 1);
  const center = (x0 + xN) / 2;
  if (Math.abs(center - 100) > 5) fail(`T1 expected center ~100, got ${center.toFixed(2)} (x0=${x0.toFixed(2)} xN=${xN.toFixed(2)})`);
  else ok(`T1 root middle: center=${center.toFixed(2)}, half-width ${((xN-x0)/2).toFixed(2)}`);
}

// T2: root anchor=start, child tspan x=300 anchor=middle.
// Expect: 'A' at x≈100 (root start), 'BC' centered at x=300.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100">
  <text x="100" y="50" font-family="Arial" font-size="48" fill="black" text-anchor="start">A<tspan x="300" text-anchor="middle">BC</tspan></text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 3) fail(`T2 expected 3 shapes, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    // Glyphs are in order: A, B, C.
    const aMin = xmin(b, mf, 0);
    const bMin = xmin(b, mf, 1), cMax = xmax(b, mf, 2);
    // A: at x=100 (root anchor=start, no shift).
    if (Math.abs(aMin - 100) > 5) fail(`T2 'A' xmin=${aMin.toFixed(2)} (expected ~100)`);
    // BC: centered at 300.
    const bcCenter = (bMin + cMax) / 2;
    if (Math.abs(bcCenter - 300) > 5) fail(`T2 'BC' center=${bcCenter.toFixed(2)} (expected ~300)`);
    if (failures === 0) ok(`T2 mixed root-start + tspan-middle: A@${aMin.toFixed(1)}, BC center @${bcCenter.toFixed(1)}`);
  }
}

// T3: root anchor=middle, child tspan x=400 anchor=end.
// Expect: 'A' centered at x=100 (single-glyph chunk),
//         'BC' ending at x=400.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100">
  <text x="100" y="50" font-family="Arial" font-size="48" fill="black" text-anchor="middle">A<tspan x="400" text-anchor="end">BC</tspan></text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 3) fail(`T3 expected 3 shapes, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    const aMin = xmin(b, mf, 0), aMax = xmax(b, mf, 0);
    const cMax = xmax(b, mf, 2);
    const aCenter = (aMin + aMax) / 2;
    if (Math.abs(aCenter - 100) > 5) fail(`T3 'A' center=${aCenter.toFixed(2)} (expected ~100)`);
    if (Math.abs(cMax - 400) > 5) fail(`T3 'BC' end=${cMax.toFixed(2)} (expected ~400)`);
    if (failures === 0) ok(`T3 root-middle + tspan-end: A center@${aCenter.toFixed(1)}, BC ends@${cMax.toFixed(1)}`);
  }
}

// T4: tspan inherits root's anchor when its own is absent.
// Root middle. Child tspan x=300 with NO text-anchor → inherits
// middle. Expect: 'A' centered at 100, 'BC' centered at 300.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100">
  <text x="100" y="50" font-family="Arial" font-size="48" fill="black" text-anchor="middle">A<tspan x="300">BC</tspan></text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 3) fail(`T4 expected 3 shapes, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    const aCenter = (xmin(b, mf, 0) + xmax(b, mf, 0)) / 2;
    const bcCenter = (xmin(b, mf, 1) + xmax(b, mf, 2)) / 2;
    if (Math.abs(aCenter - 100) > 5) fail(`T4 'A' center=${aCenter.toFixed(2)} (expected ~100)`);
    if (Math.abs(bcCenter - 300) > 5) fail(`T4 'BC' center=${bcCenter.toFixed(2)} (expected ~300)`);
    if (failures === 0) ok(`T4 tspan inherits middle: A@${aCenter.toFixed(1)}, BC@${bcCenter.toFixed(1)}`);
  }
}

// T5: tspan WITHOUT absolute x does NOT start a new chunk —
// inheriting the parent chunk's anchor. Root anchor=middle,
// 'ABCDE' with middle tspan around 'BCD' → single chunk centered
// at 100, total width spans A..E.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="100" y="50" font-family="Arial" font-size="48" fill="black" text-anchor="middle">A<tspan fill="red">BCD</tspan>E</text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 5) fail(`T5 expected 5 shapes, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    const x0 = xmin(b, mf, 0);
    const xN = xmax(b, mf, 4);
    const center = (x0 + xN) / 2;
    if (Math.abs(center - 100) > 5) fail(`T5 expected single-chunk center ~100, got ${center.toFixed(2)}`);
    else ok(`T5 styled-only tspan keeps parent chunk: ABCDE centered@${center.toFixed(1)}`);
  }
}

console.log();
console.log(failures === 0 ? 'SVG-ANCHOR-PER-TSPAN PASS' : `SVG-ANCHOR-PER-TSPAN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
