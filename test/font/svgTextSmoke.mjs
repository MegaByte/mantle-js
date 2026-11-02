// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// SVG <text> element renders via the Mantle pipeline.
//
// Each glyph emerges as its own Mantle shape (own bbox, own curve+band
// data, own cover quad) so the coverage band-walker's per-fragment cost
// stays local to glyph extents. One combined shape would make band-walk
// cost scale linearly with run length.
//
// Scope: monochrome single-line <text>; no <tspan>, no textPath, no
// text-anchor adjustments.

import { readFileSync } from 'fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.XMLSerializer = XMLSerializer;
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';

// svgImporter.js uses `new DOMParser()` directly. In Node we polyfill
// it onto globalThis from xmldom before running any SVG.
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

// ---- T1: buildSvgTextGlyphs returns per-glyph shapes ----
{
  const { glyphs, advance } = buildSvgTextGlyphs('Hi', arial, 100, 200, 16);
  if (glyphs.length !== 2) fail(`T1 expected 2 glyphs, got ${glyphs.length}`);
  else if (!(advance > 0)) fail(`T1 advance ${advance} should be positive`);
  else ok(`T1 'Hi' → 2 glyphs, advance=${advance.toFixed(2)} px (user-space)`);
}

// ---- T2: Each glyph's bbox is tight (NOT spanning the whole run) ----
{
  const { glyphs } = buildSvgTextGlyphs('Hi', arial, 100, 200, 16);
  // 'H' bbox should be ≈ 11-12 px wide; 'i' ≈ 1.5 px wide. If we
  // emitted both as ONE shape, the combined bbox would be ~14 px.
  // The check: each glyph's individual span is much smaller than the
  // total.
  const bboxOf = (segs) => {
    let xmin = Infinity,
      ymin = Infinity,
      xmax = -Infinity,
      ymax = -Infinity;
    for (const s of segs) {
      const pts =
        s.type === 0 ? [s.p1, s.p2] : s.type === 1 ? [s.p1, s.p2, s.p3] : [s.p1, s.p2, s.p3, s.p4];
      for (const p of pts) {
        if (p[0] < xmin) xmin = p[0];
        if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      }
    }
    return { w: xmax - xmin, h: ymax - ymin };
  };
  const h = bboxOf(glyphs[0].segs);
  const i = bboxOf(glyphs[1].segs);
  // 'H' bbox ≈ 11px wide; 'i' bbox ≈ 1.4 px wide. Combined span ≈ 14px.
  // If both were one shape, each would have a 14px-wide bbox.
  if (h.w < 5 || h.w > 13) fail(`T2 'H' bbox w=${h.w.toFixed(2)} (expected ~9-12)`);
  else if (i.w < 0.5 || i.w > 5) fail(`T2 'i' bbox w=${i.w.toFixed(2)} (expected ~1-2)`);
  else ok(`T2 per-glyph bboxes are tight: H=${h.w.toFixed(2)}px wide, i=${i.w.toFixed(2)}px wide`);
}

// ---- T3: SVG <text> dispatched end-to-end via importSvg ----
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">Hi</text>
</svg>`;
  const bundle = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  // Expect 2 shapes (one per glyph).
  if (bundle.numShapes !== 2) fail(`T3 expected 2 shapes, got ${bundle.numShapes}`);
  else ok(`T3 SVG <text> dispatched → ${bundle.numShapes} shapes (one per glyph)`);
}

// ---- T4: <text> without registered font is skipped; rect still emits ----
{
  // Bundle requires ≥1 shape, so the test includes a <rect> guard.
  // The <text> with the unknown font should be silently skipped
  // (graceful), the rect should be emitted normally.
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect x="0" y="0" width="50" height="50" fill="red"/>
  <text x="10" y="80" font-family="UnknownFont" font-size="24">Hi</text>
</svg>`;
  const bundle = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  if (bundle.numShapes !== 1)
    fail(`T4 expected 1 shape (rect only; text skipped), got ${bundle.numShapes}`);
  else ok(`T4 unregistered font → text skipped, rect emits (${bundle.numShapes} shape)`);
}

// ---- T5: <text> alongside <rect> — both get shapes ----
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect x="0" y="0" width="100" height="50" fill="red"/>
  <text x="10" y="80" font-family="Arial" font-size="24" fill="blue">A</text>
</svg>`;
  const bundle = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  // 1 rect + 1 glyph ('A') = 2 shapes.
  if (bundle.numShapes !== 2) fail(`T5 expected 2 shapes, got ${bundle.numShapes}`);
  else ok(`T5 mixed <rect>+<text> → ${bundle.numShapes} shapes`);
}

// textArea shares the exported text layout contract and wraps in em units.
for (const nested of [false, true]) {
  const content = nested ? 'A <tspan>B</tspan> C' : 'A B C';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><g font-family="Arial" font-size="8"><textArea x="8" y="24" width="12">${content}</textArea></g></svg>`;
  const calls = [];
  const bundle = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: (...args) => {
      calls.push(args);
      return buildSvgTextGlyphs(...args);
    },
  });
  if (calls.length !== 1 || calls[0][0] !== 'A B C' || calls[0][1] !== arial || calls[0][6] !== 1.5)
    fail('textArea layout receives text, resolved font and width in em');
  const mf = new Float32Array(bundle.meta, 32);
  const y = Array.from(
    { length: bundle.numShapes },
    (_, i) => mf[i * bundle.metaFloatsPerShape + 1],
  );
  if (bundle.numShapes !== 3 || new Set(y.map((v) => Math.round(v))).size < 2)
    fail('textArea must wrap three real glyphs onto multiple lines');
  else ok(`textArea ${nested ? 'nested' : 'direct'} content uses real-font wrapping`);
}
for (const [width, text, family] of [
  [0, 'A', 'Arial'],
  [-1, 'A', 'Arial'],
  [12, '', 'Arial'],
  [12, 'A', 'Missing'],
]) {
  let calls = 0;
  const bundle = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg"><textArea width="${width}" font-family="${family}">${text}</textArea></svg>`,
    {
      fonts: { Arial: arial },
      svgTextLayout: () => {
        calls++;
        throw Error('unexpected layout');
      },
    },
  );
  if (calls || bundle.numShapes)
    fail('empty, nonpositive-width or unresolved-font textArea must skip layout');
}

// Retained textArea glyphs occupy distinct native rows and shift later leaves.
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><rect id="before" width="4" height="4"/><textArea id="area" x="8" y="24" width="64" font-family="Arial" font-size="8">ABC</textArea><rect id="after" x="100" width="4" height="4"/></svg>`;
  const bundle = await importSvg(svg, {
    retainSource: true,
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const source = new DOMParser().parseFromString(bundle.svgSource, 'image/svg+xml');
  if (
    source.getElementsByTagName('textArea').length ||
    source.getElementsByTagName('path').length !== 3
  )
    fail('textArea retained source must contain its three glyph outlines');
  if (JSON.stringify(bundle.shapeDomIndex) !== JSON.stringify([0, 1, 2, 3, 4]))
    fail(`textArea native row addressing: ${JSON.stringify(bundle.shapeDomIndex)}`);
  else ok('textArea retained glyph and following-leaf addresses');
}

console.log();
console.log(failures === 0 ? 'SVG-TEXT PASS' : `SVG-TEXT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
