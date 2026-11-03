// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextSynthVerticalSmoke.mjs — bold/italic synthesis fallback +
// vertical writing-mode end-to-end.
//
// Synthesis: when the SVG requests bold or italic but the layout
// adapter is wired with only a base font (no boldFont/italicFont
// variants), buildSvgTextGlyphs falls back to:
//   bold   → emit each glyph with a same-color stroke at ~0.04 em
//            width on top of the fill (visual bolding).
//   italic → shear each glyph by 12° (top of glyph leans right).
//
// Vertical: writing-mode: vertical-rl/vertical-lr advances pen DOWN
// the column; text-orientation: mixed rotates Latin glyphs 90° CW
// while CJK ideographs ride upright.
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);

const STRIDE = 48;
const META_SW = 12; // texel 3.x — stroke width (em-space)
const META_FILL_A = 7; // texel 1.w — fill alpha
const META_STR_A = 11; // texel 2.w — stroke alpha
const META_FLAGS = 27;
const FLAG_LAYER = 0x100;

function visibleRows(s) {
  const mf = new Float32Array(s.meta, 32);
  const out = [];
  for (let i = 0; i < s.numShapes; i++) {
    const flags = (mf[i * STRIDE + META_FLAGS] + 0.5) | 0;
    if ((flags & FLAG_LAYER) !== 0) continue;
    out.push({
      idx: i,
      sw: mf[i * STRIDE + META_SW],
      fillA: mf[i * STRIDE + META_FILL_A],
      strokeA: mf[i * STRIDE + META_STR_A],
      bbox: [mf[i * STRIDE + 0], mf[i * STRIDE + 1], mf[i * STRIDE + 2], mf[i * STRIDE + 3]],
      id: s.shapeIds[i],
    });
  }
  return out;
}

const opts = { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs };

// ---- T1: italic shear changes the glyph bbox ----------------------
{
  const plain = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__plain.svg', import.meta.url),
    'utf8',
  );
  const italic = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__italic.svg', import.meta.url),
    'utf8',
  );
  const rPlain = visibleRows(await importSvg(plain, opts));
  const rItalic = visibleRows(await importSvg(italic, opts));
  if (rPlain.length === 0 || rItalic.length === 0) {
    fail(`T1 no glyphs emitted (plain=${rPlain.length}, italic=${rItalic.length})`);
  } else {
    // Italic glyph: top-right corner pushed RIGHT. Bbox xmax should
    // be GREATER than plain by approximately tan(12°) × glyph height.
    const widerByEm = rItalic[0].bbox[2] - rPlain[0].bbox[2];
    if (widerByEm > 0.5)
      ok(`T1 italic shear pushes glyph bbox right by ${widerByEm.toFixed(2)} (≈ tan(12°)×height)`);
    else fail(`T1 italic shear delta x=${widerByEm.toFixed(2)} (expected > 0.5)`);
  }
}

// ---- T2: bold synthesis adds stroke to glyphs ---------------------
{
  const plain = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__plain.svg', import.meta.url),
    'utf8',
  );
  const bold = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__bold.svg', import.meta.url),
    'utf8',
  );
  const rPlain = visibleRows(await importSvg(plain, opts));
  const rBold = visibleRows(await importSvg(bold, opts));
  // Plain glyphs have sw=0; bold-synthesised glyphs have sw>0 AND
  // stroke alpha > 0 (= the fill color repeated on the stroke slot).
  const plainHasNoStroke = rPlain.every((r) => r.sw === 0);
  const boldHasStroke = rBold.some((r) => r.sw > 0 && r.strokeA > 0.5);
  if (plainHasNoStroke && boldHasStroke)
    ok(`T2 bold synthesis adds same-color stroke (sw=${rBold[0].sw.toFixed(3)})`);
  else
    fail(
      `T2 bold synth: plain sw=${rPlain[0]?.sw}, bold sw=${rBold[0]?.sw} strokeA=${rBold[0]?.strokeA}`,
    );
}

// ---- T3: variant font wins over synthesis ------------------------
{
  // Wrap buildSvgTextGlyphs so we can inject a fake "boldFont"
  // variant. Adapter pattern: when styleOpts.variantFonts.boldFont
  // is set, that font is used instead of synth.
  const adapter = (text, font, x, y, fontSize, fallbacks, maxWidthEm, styleOpts) => {
    const wantBold =
      styleOpts && /^(bold|bolder|[6789]\d\d|1000)$/i.test(String(styleOpts.fontWeight || ''));
    const styleOptsX = wantBold
      ? { ...styleOpts, variantFonts: { boldFont: arial } } // real fonts would differ; use base here
      : styleOpts;
    return buildSvgTextGlyphs(text, font, x, y, fontSize, fallbacks, maxWidthEm, styleOptsX);
  };
  const optsVar = { fonts: { Arial: arial }, svgTextLayout: adapter };
  const bold = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__bold.svg', import.meta.url),
    'utf8',
  );
  const rBold = visibleRows(await importSvg(bold, optsVar));
  // With variantFonts.boldFont wired, synth-bold should NOT fire — sw=0.
  const noSynthStroke = rBold.every((r) => r.sw === 0);
  if (noSynthStroke) ok(`T3 variant boldFont wins → no synth stroke (sw=0)`);
  else fail(`T3 variant should suppress synth but sw=${rBold[0]?.sw}`);
}

// ---- T4: vertical writing-mode advances pen DOWN ----------------
{
  const horizontal = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__horizontal.svg', import.meta.url),
    'utf8',
  );
  const vertical = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__vertical.svg', import.meta.url),
    'utf8',
  );
  const rH = visibleRows(await importSvg(horizontal, opts));
  const rV = visibleRows(await importSvg(vertical, opts));
  // Horizontal: glyphs spread along X, bbox.x increases monotonically.
  // Vertical: glyphs spread along Y, bbox.y increases monotonically.
  if (rH.length < 2 || rV.length < 2) {
    fail(`T4 not enough glyphs (rH=${rH.length}, rV=${rV.length})`);
  } else {
    const hxDelta = rH[1].bbox[0] - rH[0].bbox[0];
    const hyDelta = rH[1].bbox[1] - rH[0].bbox[1];
    const vxDelta = rV[1].bbox[0] - rV[0].bbox[0];
    const vyDelta = rV[1].bbox[1] - rV[0].bbox[1];
    const okH = Math.abs(hxDelta) > Math.abs(hyDelta); // X dominates horizontally
    const okV = Math.abs(vyDelta) > Math.abs(vxDelta); // Y dominates vertically
    if (okH && okV)
      ok(
        `T4 vertical writing-mode: glyphs stack DOWN (dy=${vyDelta.toFixed(2)} vs dx=${vxDelta.toFixed(2)})`,
      );
    else
      fail(
        `T4 vertical layout: horizontal Δx=${hxDelta.toFixed(2)} Δy=${hyDelta.toFixed(2)}; vertical Δx=${vxDelta.toFixed(2)} Δy=${vyDelta.toFixed(2)}`,
      );
  }
}

// ---- T5: synthesis can be disabled ----------------------------
{
  const adapter = (text, font, x, y, fontSize, fallbacks, maxWidthEm, styleOpts) => {
    const styleOptsX = { ...styleOpts, synthesizeBold: false, synthesizeItalic: false };
    return buildSvgTextGlyphs(text, font, x, y, fontSize, fallbacks, maxWidthEm, styleOptsX);
  };
  const o = { fonts: { Arial: arial }, svgTextLayout: adapter };
  const bold = readFileSync(
    new URL('../examples/smoke/svgTextSynthVertical__bold.svg', import.meta.url),
    'utf8',
  );
  const rBold = visibleRows(await importSvg(bold, o));
  const noStroke = rBold.every((r) => r.sw === 0);
  if (noStroke) ok(`T5 synthesizeBold=false suppresses synth (font-synthesis: none parity)`);
  else fail(`T5 synth=false but sw=${rBold[0]?.sw}`);
}

console.log();
console.log(
  failures === 0 ? 'SVG-TEXT-SYNTH-VERTICAL PASS' : `SVG-TEXT-SYNTH-VERTICAL FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
