// svgInOtTextRunSmoke.mjs — end-to-end: textRun with an SVG-in-OT
// font emits the glyph's SVG document as Mantle shapes.

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
if (typeof globalThis.XMLSerializer === 'undefined') globalThis.XMLSerializer = XMLSerializer;

import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun } from '../../src/font/textRun.js';
import { buildSvgInOtTestFont } from './_svgInOtFontFixture.mjs';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

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
      const r = F[4], g = F[5], b = F[6];
      // Tolerate the importer's color parsing — "red" → [1, 0, 0, 1].
      if (r < 0.9 || g > 0.1 || b > 0.1)
        fail(`T3 shape 0 fill rgba=[${r},${g},${b}], expected red`);
      else ok(`T3 textRun('A') → ${bundle.numShapes} shape(s), fill red`);
    }
  }
}

// T4: the imported glyph's shape lands near the pen position (pen=0).
// At fontSize=1, pen=0, the circle from the fixture sits in em-space
// centered at (0.5, -0.5) (font design units with +Y down after the
// textrun's flip) — so the shape bbox should cover roughly that area.
{
  const bytes = buildSvgInOtTestFont();
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  if (!bundle || !bundle.globalBBox)
    fail(`T4 bundle missing globalBBox`);
  else {
    const [, , w, h] = bundle.globalBBox;
    // Circle has em-diameter = upem/2 / upem = 0.5 in em units; scaled
    // by fontSize=1 → 0.5 em wide. Both dimensions should be ≈ 0.5.
    if (w < 0.4 || w > 0.6 || h < 0.4 || h > 0.6)
      fail(`T4 bbox dims (${w.toFixed(3)} × ${h.toFixed(3)}) outside [0.4, 0.6]`);
    else ok(`T4 bundle bbox ${w.toFixed(3)} × ${h.toFixed(3)} ≈ circle diameter (em)`);
  }
}

console.log();
console.log(failures === 0 ? 'SVG-IN-OT-TEXTRUN PASS' : `SVG-IN-OT-TEXTRUN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
