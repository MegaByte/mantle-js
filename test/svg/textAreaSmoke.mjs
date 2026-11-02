// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textAreaSmoke.mjs — verifies SVG 1.2 Tiny <textArea> support: a
// block-flow text element with auto-wrap inside (x, y, w, h). Routes
// through opts.svgTextLayout with maxWidthEm = width / fontSize so
// the layout engine word-wraps.

import { readFileSync, existsSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(arialPath)) {
  console.log('Skip textArea smoke: Arial not found');
  process.exit(0);
}
const font = new MantleFontAsset(new Uint8Array(readFileSync(arialPath)));
font.getMetrics(0x20);

// Wrap buildSvgTextGlyphs to match the svgTextLayout signature with
// optional maxWidthEm.
const layoutFn = (family, text, x, y, fontSize, maxWidthEm) =>
  buildSvgTextGlyphs(text, font, x, y, fontSize, null, maxWidthEm || 0);

// ----- T1: buildSvgTextGlyphs honors maxWidthEm --------------------
{
  const noWrap = buildSvgTextGlyphs(
    'one two three four five six seven eight',
    font,
    0,
    0,
    16,
    null,
    0,
  );
  const wrap = buildSvgTextGlyphs(
    'one two three four five six seven eight',
    font,
    0,
    0,
    16,
    null,
    6,
  );
  if (noWrap.glyphs.length === 0) fail('T1 no-wrap empty');
  else if (wrap.glyphs.length === 0) fail('T1 wrap empty');
  else {
    // With wrap, some glyphs should land on a lower line (greater y).
    const noY = new Set(noWrap.glyphs.map((g) => Math.round(g.segs[0].p1[1])));
    const wY = new Set(wrap.glyphs.map((g) => Math.round(g.segs[0].p1[1])));
    if (wY.size <= noY.size)
      fail(`T1 wrap did NOT create new lines: ${wY.size} vs no-wrap ${noY.size}`);
    else ok(`T1 maxWidthEm wraps: ${wY.size} distinct Y vs ${noY.size} without wrap`);
  }
}

// ----- T2: <textArea> with wrap emits multi-line shapes ------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <textArea x="10" y="20" width="50" height="100" font-size="12">one two three four five six seven eight</textArea>
</svg>`;
  const bundle = await importSvg(svg, { svgTextLayout: layoutFn });
  if (bundle.numShapes < 5) fail(`T2 expected ≥5 glyph shapes, got ${bundle.numShapes}`);
  else ok(`T2 <textArea> emitted ${bundle.numShapes} glyph shapes`);
}

// ----- T3: <textArea width=0> emits nothing (degenerate) -----------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <textArea x="0" y="0" width="0" height="50">hello</textArea>
  <rect x="10" y="10" width="80" height="80" fill="red"/>
</svg>`;
  const bundle = await importSvg(svg, { svgTextLayout: layoutFn });
  // Only the rect should render.
  if (bundle.numShapes !== 1)
    fail(`T3 width=0 should skip text, got ${bundle.numShapes} shapes (expected 1 rect)`);
  else ok('T3 <textArea width="0"> skips gracefully');
}

// ----- T4: no svgTextLayout opt → graceful warn skip ---------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <textArea x="0" y="0" width="50" height="50">hello world</textArea>
  <rect x="10" y="10" width="80" height="80" fill="red"/>
</svg>`;
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  try {
    const bundle = await importSvg(svg, {});
    if (!warned) fail('T4 expected console.warn for missing svgTextLayout');
    if (bundle.numShapes !== 1) fail(`T4 rect should still render, got ${bundle.numShapes}`);
    else ok('T4 no svgTextLayout → graceful warn + skip text (rect renders)');
  } finally {
    console.warn = origWarn;
  }
}

if (failures > 0) {
  console.error(`\nTEXTAREA FAIL (${failures})`);
  process.exit(1);
}
console.log('\nTEXTAREA PASS');
