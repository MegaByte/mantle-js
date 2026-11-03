// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Markup tag smoke tests: <scale>, <line-indent>, <margin>, <margin-left>, <margin-right>.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun, buildFromMarkup } from '../../src/font/textRun.js';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ---- T1: <scale=2> doubles geometry but advance unchanged ----
{
  // Single "I" — narrow vertical glyph. After <scale=2>, geometry is
  // ~2× wide AND ~2× tall, but advance is unchanged (same as 'I').
  const natural = await buildTextRun('I', font);
  const scaled = await buildFromMarkup('<scale=2>I</scale>', font);
  const wN = natural.globalBBox[2];
  const hN = natural.globalBBox[3];
  const wS = scaled.globalBBox[2];
  const hS = scaled.globalBBox[3];
  if (Math.abs(wS / wN - 2) > 0.05) fail(`T1 scale W ratio ${(wS / wN).toFixed(3)}`);
  else if (Math.abs(hS / hN - 2) > 0.05) fail(`T1 scale H ratio ${(hS / hN).toFixed(3)}`);
  else ok(`T1 <scale=2> W ratio=${(wS / wN).toFixed(3)} H ratio=${(hS / hN).toFixed(3)}`);
}

// ---- T2: <scale=2> on multi-char keeps advance constant ----
{
  // Advance is unchanged under scale; read it from the gap between
  // glyph 0's xmin and glyph 1's xmin (geometry width does change).
  const natural = await buildFromMarkup('II', font);
  const scaled = await buildFromMarkup('<scale=2>II</scale>', font);
  const stride = natural.metaFloatsPerShape;
  const xMin0N = natural.metaFloats[0 * stride + 0];
  const xMin1N = natural.metaFloats[1 * stride + 0];
  const advN = xMin1N - xMin0N;
  const xMin0S = scaled.metaFloats[0 * stride + 0];
  const xMin1S = scaled.metaFloats[1 * stride + 0];
  const advS = xMin1S - xMin0S;
  if (Math.abs(advS - advN) > 0.05)
    fail(`T2 advance differs natural=${advN.toFixed(3)} scaled=${advS.toFixed(3)}`);
  else ok(`T2 <scale=2> preserves advance (natural=${advN.toFixed(3)} scaled=${advS.toFixed(3)})`);
}

// ---- T3: <scale=50%> halves geometry ----
{
  const natural = await buildTextRun('A', font);
  const small = await buildFromMarkup('<scale=50%>A</scale>', font);
  const hN = natural.globalBBox[3];
  const hS = small.globalBBox[3];
  if (Math.abs(hS / hN - 0.5) > 0.05) fail(`T3 scale 50% H ratio ${(hS / hN).toFixed(3)}`);
  else ok(`T3 <scale=50%> H ratio=${(hS / hN).toFixed(3)}`);
}

// ---- T4: <line-indent=1> shifts current line only ----
{
  // Without wrap: "AB" with <line-indent=1> places A at x≈1, B at x≈1+adv.
  const plain = await buildTextRun('AB', font);
  const li = await buildFromMarkup('<line-indent=1>AB', font);
  const pxA = plain.globalBBox[0];
  const liA = li.globalBBox[0];
  if (Math.abs(liA - pxA - 1) > 0.1)
    fail(
      `T4 line-indent: plain xmin=${pxA.toFixed(3)} li xmin=${liA.toFixed(3)} (expected delta ~1)`,
    );
  else ok(`T4 <line-indent=1> shifts first line dx=${(liA - pxA).toFixed(3)}`);
}

// ---- T5: <line-indent> does NOT persist to next line ----
{
  // With wrap, force a line break and verify second line starts at 0
  // (no leftover indent).
  const layout = { maxWidthEm: 2 };
  const b = await buildFromMarkup('<line-indent=1>AAA BBB', font, [0, 0, 0, 1], layout);
  // First line should start at x≈1 (line-indent applied).
  // Second line should start at x≈0 (line-indent reset by line break).
  // Need to find a glyph from each line. Read all glyph xmin/ymins.
  const stride = b.metaFloatsPerShape;
  const firstLineY = b.metaFloats[0 * stride + 1];
  let secondLineFirstX = Infinity;
  let secondLineFound = false;
  for (let i = 0; i < b.numShapes; i++) {
    const yMin = b.metaFloats[i * stride + 1];
    if (Math.abs(yMin - firstLineY) > 0.3) {
      // Different line!
      const xMin = b.metaFloats[i * stride + 0];
      if (xMin < secondLineFirstX) {
        secondLineFirstX = xMin;
        secondLineFound = true;
      }
    }
  }
  if (!secondLineFound) fail(`T5 line-indent: only one line found`);
  else if (secondLineFirstX > 0.3)
    fail(
      `T5 line-indent persisted: second-line xmin=${secondLineFirstX.toFixed(3)} (should be ~0)`,
    );
  else ok(`T5 <line-indent> single-shot, second-line xmin=${secondLineFirstX.toFixed(3)}`);
}

// ---- T6: <margin-left=1> shifts ALL lines ----
{
  const layout = { maxWidthEm: 3 };
  const plain = await buildFromMarkup('AAA BBB', font, [0, 0, 0, 1], layout);
  const ml = await buildFromMarkup('<margin-left=1>AAA BBB', font, [0, 0, 0, 1], layout);
  const pxA = plain.globalBBox[0];
  const mlA = ml.globalBBox[0];
  if (Math.abs(mlA - pxA - 1) > 0.1)
    fail(`T6 margin-left: plain=${pxA.toFixed(3)} ml=${mlA.toFixed(3)}`);
  else ok(`T6 <margin-left=1> dx=${(mlA - pxA).toFixed(3)}`);
}

// ---- T7: <margin-right> reduces effective max-width (forces earlier wrap) ----
{
  // "AAA BBB" at maxWidth=5 fits on one line (~4.3em); margin-right=3
  // drops the usable width to 2em, forcing a wrap between the words.
  const layout = { maxWidthEm: 5 };
  const plain = await buildFromMarkup('AAA BBB', font, [0, 0, 0, 1], layout);
  const mr = await buildFromMarkup('<margin-right=3>AAA BBB', font, [0, 0, 0, 1], layout);
  const hP = plain.globalBBox[3];
  const hM = mr.globalBBox[3];
  if (hM <= hP + 0.3)
    fail(`T7 margin-right didn't wrap: plain h=${hP.toFixed(3)} mr h=${hM.toFixed(3)}`);
  else ok(`T7 <margin-right=3> forces wrap: plain h=${hP.toFixed(3)} → mr h=${hM.toFixed(3)}`);
}

// ---- T8: <margin=1> sets both ----
{
  const layout = { maxWidthEm: 4 };
  const plain = await buildFromMarkup('AAA BBB', font, [0, 0, 0, 1], layout);
  const m = await buildFromMarkup('<margin=1>AAA BBB</margin>', font, [0, 0, 0, 1], layout);
  const pxA = plain.globalBBox[0];
  const mxA = m.globalBBox[0];
  // Left-shift by ~1em (margin-left=1).
  if (Math.abs(mxA - pxA - 1) > 0.1)
    fail(`T8 margin: left shift expected ~1, got ${(mxA - pxA).toFixed(3)}`);
  else ok(`T8 <margin=1> left shift dx=${(mxA - pxA).toFixed(3)}`);
}

// ---- T9: parser surface: <line-indent> emits directive ----
{
  const spans = parseMarkup('<line-indent=2>X', defaultStyle());
  if (!spans[0].directive?.hasLineIndent) fail('T9 line-indent directive');
  else if (spans[0].directive.lineIndentEm !== 2)
    fail(`T9 lineIndentEm ${spans[0].directive.lineIndentEm}`);
  else ok('T9 <line-indent> directive');
}

// ---- T10: parser: <scale=2> sets glyphScale on style ----
{
  const spans = parseMarkup('<scale=2>X</scale>', defaultStyle());
  if (Math.abs(spans[0].style.glyphScale - 2) > 1e-6)
    fail(`T10 glyphScale ${spans[0].style.glyphScale}`);
  else ok('T10 <scale=2> sets glyphScale');
}

console.log();
console.log(
  failures === 0 ? 'MARKUP-INDENT-MARGIN PASS' : `MARKUP-INDENT-MARGIN FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
