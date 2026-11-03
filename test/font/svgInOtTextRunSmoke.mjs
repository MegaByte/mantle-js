// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgInOtTextRunSmoke.mjs — end-to-end: textRun with an SVG-in-OT
// font emits the glyph's SVG document as Mantle shapes.

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
if (typeof globalThis.XMLSerializer === 'undefined') globalThis.XMLSerializer = XMLSerializer;

import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { registerSvgInOtImport } from '../../src/font/color/svgInOtImport.js';
registerSvgInOtImport();
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun } from '../../src/font/textRun.js';
import { buildSvgInOtTestFont } from './_svgInOtFontFixture.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// T1: font carries an 'SVG ' table — capability check.
{
  const bytes = buildSvgInOtTestFont();
  const font = new MantleFontAsset(bytes);
  if (!font.hasSvgGlyphs) fail('T1 hasSvgGlyphs false');
  else if (!font.svgInOt.hasSvg) fail('T1 reader hasSvg false');
  else if (font.svgInOt.numEntries !== 1) fail(`T1 numEntries=${font.svgInOt.numEntries}`);
  else ok(`T1 fixture builds: hasSvgGlyphs, 1 SVG record`);
}

// T2: getSvgGlyph(codepoint) returns the doc payload.
{
  const bytes = buildSvgInOtTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const sv = font.getSvgGlyph(0x41);
  if (!sv) fail('T2 getSvgGlyph(A) null');
  else if (sv.subElementId !== 'glyph1') fail(`T2 subElementId=${sv.subElementId}`);
  else if (sv.isGzipped) fail('T2 marked gzipped');
  else {
    const text = new TextDecoder().decode(sv.svgBytes);
    if (!text.includes('fill="red"')) fail(`T2 doc missing 'red' fill:\n${text}`);
    else ok(`T2 getSvgGlyph(A) → ${sv.svgBytes.length} bytes, subId=${sv.subElementId}`);
  }
}

// T3: textRun emits the glyph's SVG content as Mantle shapes.
{
  const bytes = buildSvgInOtTestFont();
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  if (!bundle) fail('T3 bundle null');
  else if (bundle.numShapes < 1)
    fail(`T3 expected >= 1 shape (the imported circle), got ${bundle.numShapes}`);
  else {
    // The single shape should be filled red (the SVG fill="red")
    // — the textRun's run color (black) is irrelevant for SVG-in-OT
    // since the SVG documents carry their own colors.
    const m = bundle.metas?.[0];
    // bundle.metaFloats is the packed float view — check first shape's
    // fill via the per-shape stride (48 floats).
    const F = bundle.metaFloats;
    if (!F || F.length < 48) fail(`T3 metaFloats short: ${F?.length}`);
    else {
      // Fill RGBA lives at offsets 4..7 of the meta-row (texel 1 RGBA
      // = fillColor per MantleSvgMeta layout). Per the JS encoder,
      // offsets are: [bbox(4), fillRgba(4), strokeRgba(4), ...].
      // Read fillRgba bytes — the importer stored red as [1, 0, 0, 1].
      const r = F[4],
        g = F[5],
        b = F[6];
      // Tolerate the importer's color parsing — "red" → [1, 0, 0, 1].
      if (r < 0.9 || g > 0.1 || b > 0.1)
        fail(`T3 shape 0 fill rgba=[${r},${g},${b}], expected red`);
      else ok(`T3 textRun('A') → ${bundle.numShapes} shape(s), fill red`);
    }
  }
}

// T4: the imported glyph's shape lands near the pen position (pen=0).
// At fontSize=1, pen=0, the circle from the fixture sits in em-space
// centered at (0.5, -0.5) (SVG design units with +Y down) — so the shape bbox should cover roughly that area.
{
  const bytes = buildSvgInOtTestFont();
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  if (!bundle || !bundle.globalBBox) fail(`T4 bundle missing globalBBox`);
  else {
    const [, , w, h] = bundle.globalBBox;
    // Circle has em-diameter = upem/2 / upem = 0.5 in em units; scaled
    // by fontSize=1 → 0.5 em wide. Both dimensions should be ≈ 0.5.
    if (w < 0.4 || w > 0.6 || h < 0.4 || h > 0.6)
      fail(`T4 bbox dims (${w.toFixed(3)} × ${h.toFixed(3)}) outside [0.4, 0.6]`);
    else ok(`T4 bundle bbox ${w.toFixed(3)} × ${h.toFixed(3)} ≈ circle diameter (em)`);
  }
}

// Repeated imports append exactly one glyph, retaining baseline orientation.
{
  const font = new MantleFontAsset(buildSvgInOtTestFont());
  const one = await buildTextRun('A', font, [0, 0, 0, 1]);
  const two = await buildTextRun('AA', font, [0, 0, 0, 1]);
  if (two.numShapes !== 2 * one.numShapes)
    fail('repeated SVG glyph duplicates earlier painted rows');
  else ok('repeated SVG glyph appends exactly its own painted rows');
  if (!(one.globalBBox[1] > 0)) fail('positive SVG glyph Y was flipped above the baseline');
  else ok('SVG glyph keeps its baseline-relative downward Y coordinates');
}

// Shared imports preserve earlier resource rows and their resolved references.
{
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
    '<linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
    '<clipPath id="c"><rect x="10" y="-200" width="80" height="200"/></clipPath>' +
    '<mask id="m"><rect x="10" y="-200" width="100" height="200" fill="white"/></mask><filter id="f"><feOffset dx="2"/></filter></defs>' +
    '<g id="glyph1"><rect x="10" y="-200" width="100" height="200" fill="url(#g)" clip-path="url(#c)" mask="url(#m)" filter="url(#f)" stroke="blue" stroke-width="10" stroke-dasharray="5 3"/></g></svg>';
  const font = new MantleFontAsset(buildSvgInOtTestFont({ svgText }));
  const one = await buildTextRun('A', font, [0, 0, 0, 1]);
  const two = await buildTextRun('AA', font, [0, 0, 0, 1]);
  const painted = (b) =>
    Array.from({ length: b.numShapes }, (_, i) => i).filter(
      (i) => !(b.metaFloats[i * 48 + 27] & (64 | 128 | 256)),
    );
  if (painted(two).length !== 2 * painted(one).length)
    fail('rich SVG append duplicated painted rows');
  else ok('rich SVG append emits each painted row once');
  const a = painted(one)[0] * 48,
    b = painted(two)[0] * 48;
  if ([28, 29, 30, 31].some((k) => one.metaFloats[a + k] !== two.metaFloats[b + k]))
    fail('append rewrote earlier gradient/clip/mask references');
  else ok('append retains earlier gradient/clip/mask references');
  if (!(
    two.gradients?.byteLength > 0 &&
    two.gradientStops?.byteLength > 0 &&
    two.dashes?.byteLength > 0 &&
    two.filterTab?.byteLength > 0 &&
    two.filterGraphs?.some(Boolean)
  ))
    fail('rich SVG font lost resource tables');
  else ok('rich SVG font retains gradient, dash and filter tables');
  if (!(
    two.clipperRows?.c &&
    two.clipperRows?.m &&
    two.spriteRanges?.glyph1 &&
    two.shapeIds.length === two.numShapes
  ))
    fail('rich SVG font lost addressing maps');
  else ok('rich SVG font retains clip, mask, named and shape addressing');
}

// Host foreground supplies currentColor without replacing authored colors.
{
  const foreground = [0, 1, 0, 0.5];
  for (const [paint, local, expected] of [
    ['currentColor', '', foreground],
    ['red', '', [1, 0, 0, 1]],
    ['currentColor', ' color="blue"', [0, 0, 1, 1]],
  ]) {
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg"${local}><g id="glyph1"><rect width="100" height="100" fill="${paint}"/></g></svg>`;
    const font = new MantleFontAsset(buildSvgInOtTestFont({ svgText }));
    const run = await buildTextRun('A', font, foreground);
    if (expected.some((v, i) => Math.abs(run.metaFloats[4 + i] - v) > 1e-6))
      fail('SVG foreground or authored color precedence');
    else ok('SVG foreground and authored color precedence');
  }
  const { default: importSvg } = await import('../../src/svg/importer.js');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="currentColor"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>';
  const colored = await importSvg(svg, { initialColor: 'rgba(0,255,0,.5)' }),
    normal = await importSvg(svg);
  const a = new Uint8Array(colored.gradientStops),
    b = new Uint8Array(normal.gradientStops);
  if (a[0] || a[1] !== 255 || a[2] || Math.abs(a[3] - 128) > 1 || b[0] || b[1] || b[2])
    fail('gradient currentColor host or import isolation');
  else ok('gradient currentColor inherits the host and stays local to its document');
}

// OpenType roots use the em-square viewport, even when glyph1 is the root.
{
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg" id="glyph1" viewBox="0 1000 1000 1000" style="overflow:hidden;clip:rect(0,0,1,1)"><rect x="100" y="1100" width="100" height="200"/></svg>';
  const font = new MantleFontAsset(buildSvgInOtTestFont({ svgText }));
  const run = await buildTextRun('A', font, [1, 0, 0, 1]);
  if ([0.1, 0.1, 0.1, 0.2].some((v, i) => Math.abs(run.globalBBox[i] - v) > 1e-6))
    fail('root SVG glyph viewport and outer placement');
  else ok('root SVG glyph viewBox maps into the em square without viewport clipping');
}

console.log();
console.log(failures === 0 ? 'SVG-IN-OT-TEXTRUN PASS' : `SVG-IN-OT-TEXTRUN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
