// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Faux-italic shear + faux-bold stroke fallback when <i> / <b> spans
// have no real BoldFont / ItalicFont wired on the layout options.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildFromMarkup } from '../../src/font/textRun.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(FONT)) {
  ok('all tests skipped (Arial not present)');
  console.log();
  console.log('SYNTHETIC-FALLBACK PASS (skipped)');
  process.exit(0);
}

const bytes = new Uint8Array(readFileSync(FONT));
const font = new MantleFontAsset(bytes);
void font.name; // force init

// Read fill/stroke from meta i (32 floats per shape — packed layout
// in textrun's bundle):
//   [0..3]  bbox (xmin, ymin, xmax, ymax)
//   [4..7]  fillRgba
//   [8..11] strokeRgba
//   [12]    strokeWidth
function metaSlice(bundle, shapeIdx) {
  const stride = 48; // floats per shape
  const off = shapeIdx * stride;
  const m = bundle.metaFloats;
  return {
    bbox: [m[off], m[off + 1], m[off + 2], m[off + 3]],
    fill: [m[off + 4], m[off + 5], m[off + 6], m[off + 7]],
    stroke: [m[off + 8], m[off + 9], m[off + 10], m[off + 11]],
    strokeWidth: m[off + 12],
  };
}

// ----- T1: plain "H" vs "<i>H</i>" — italic should shear glyph -----
// We use 'H' rather than 'A' because A's widest x is at the baseline
// (the feet), where shear contribution is 0 — italic-A bbox width
// happens to be identical to upright. H's verticals run full-height
// so shear visibly widens its bbox.
{
  const plain = await buildFromMarkup('H', font, [0, 0, 0, 1]);
  const italic = await buildFromMarkup('<i>H</i>', font, [0, 0, 0, 1]);
  if (plain.numShapes !== 1 || italic.numShapes !== 1)
    fail(`T1 shape counts: plain=${plain.numShapes} italic=${italic.numShapes}`);
  else {
    const mP = metaSlice(plain, 0);
    const mI = metaSlice(italic, 0);
    const wP = mP.bbox[2] - mP.bbox[0];
    const wI = mI.bbox[2] - mI.bbox[0];
    if (wI <= wP + 0.01)
      fail(`T1 italic bbox width ${wI.toFixed(3)} not wider than upright ${wP.toFixed(3)}`);
    else
      ok(
        `T1 synthetic italic shears 'H': bbox width ${wP.toFixed(3)} → ${wI.toFixed(3)} em (+${((wI / wP - 1) * 100).toFixed(1)}%)`,
      );
  }
}

// ----- T2: plain "A" vs "<b>A</b>" — bold should add stroke ---------
{
  const plain = await buildFromMarkup('A', font, [0, 0, 0, 1]);
  const bold = await buildFromMarkup('<b>A</b>', font, [0, 0, 0, 1]);
  if (plain.numShapes !== 1 || bold.numShapes !== 1)
    fail(`T2 shape counts: plain=${plain.numShapes} bold=${bold.numShapes}`);
  else {
    const mP = metaSlice(plain, 0);
    const mB = metaSlice(bold, 0);
    if (mP.strokeWidth > 0) fail(`T2 plain glyph has stroke width ${mP.strokeWidth} (should be 0)`);
    else if (mB.strokeWidth <= 0)
      fail(`T2 bold glyph has no stroke width (got ${mB.strokeWidth}); synthetic bold not applied`);
    else ok(`T2 synthetic bold strokes 'A': plain sw=0 → bold sw=${mB.strokeWidth.toFixed(4)} em`);
  }
}

// ----- T3: bold + italic combined when neither variant is wired -----
{
  const bi = await buildFromMarkup('<b><i>H</i></b>', font, [0, 0, 0, 1]);
  const m = metaSlice(bi, 0);
  if (m.strokeWidth <= 0) fail(`T3 bold+italic: stroke ${m.strokeWidth} (expected > 0 for bold)`);
  else {
    // Also expect shear → wider bbox than plain.
    const plain = await buildFromMarkup('H', font, [0, 0, 0, 1]);
    const mP = metaSlice(plain, 0);
    const wP = mP.bbox[2] - mP.bbox[0];
    const wBI = m.bbox[2] - m.bbox[0];
    if (wBI <= wP + 0.01)
      fail(`T3 bold+italic bbox width ${wBI.toFixed(3)} not wider than upright ${wP.toFixed(3)}`);
    else
      ok(
        `T3 bold+italic: stroke=${m.strokeWidth.toFixed(4)}, bbox widened ${wP.toFixed(3)}→${wBI.toFixed(3)}`,
      );
  }
}

// ----- T4: real italic font wired → NO synthesis applied -----------
{
  const italicFontPath = '/System/Library/Fonts/Supplemental/Arial Italic.ttf';
  if (!existsSync(italicFontPath)) {
    ok('T4 skipped (Arial Italic not present)');
  } else {
    const italicBytes = new Uint8Array(readFileSync(italicFontPath));
    const italicFont = new MantleFontAsset(italicBytes);
    // Render via real-italic-wired layout — should NOT shear synthetically.
    const real = await buildFromMarkup('<i>A</i>', font, [0, 0, 0, 1], { italicFont });
    // The glyph used should be from Arial Italic (already slanted).
    // bbox width may still differ from upright Arial (because Italic
    // is a different face) — we verify that strokeWidth is 0 (no
    // synth-bold accidentally fires) and metas look like a normal
    // glyph emit.
    const m = metaSlice(real, 0);
    if (m.strokeWidth > 0) fail(`T4 real italic glyph has unwanted stroke ${m.strokeWidth}`);
    else ok(`T4 real italic wired → no synthetic stroke applied`);
  }
}

console.log();
console.log(failures === 0 ? 'SYNTHETIC-FALLBACK PASS' : `SYNTHETIC-FALLBACK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
