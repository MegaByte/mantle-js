// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markupTagsSmoke.mjs — markup tag smoke tests.
//
// Covers: <sub>, <sup>, <br>, <noparse>, <pos>, <line-height>, <rotate>.

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

// ---- T1: <sub> composes size 0.8 + voffset -0.14 ----
{
  const spans = parseMarkup('<sub>X</sub>', defaultStyle());
  if (Math.abs(spans[0].style.sizeScale - 0.8) > 1e-6)
    fail(`T1 sub size ${spans[0].style.sizeScale}`);
  else if (Math.abs(spans[0].style.voffsetEm - -0.14) > 1e-6)
    fail(`T1 sub voffset ${spans[0].style.voffsetEm}`);
  else ok('T1 <sub> size+voffset composition');
}

// ---- T2: <sup> composes size 0.8 + voffset +0.4 ----
{
  const spans = parseMarkup('<sup>X</sup>', defaultStyle());
  if (Math.abs(spans[0].style.sizeScale - 0.8) > 1e-6)
    fail(`T2 sup size ${spans[0].style.sizeScale}`);
  else if (Math.abs(spans[0].style.voffsetEm - 0.4) > 1e-6)
    fail(`T2 sup voffset ${spans[0].style.voffsetEm}`);
  else ok('T2 <sup> size+voffset composition');
}

// ---- T3: <br> emits a literal newline ----
{
  const spans = parseMarkup('A<br>B', defaultStyle());
  // Expect: single span "A\nB" (or two spans "A\n" and "B" — either works
  // since the flush happens at tag boundaries). Easier check: total text
  // joined contains "\n".
  const joined = spans.map((s) => s.text).join('');
  if (!joined.includes('\n')) fail(`T3 br no newline; joined="${joined}"`);
  else ok('T3 <br> emits newline');
}

// ---- T4: <noparse> passes inner as literal ----
{
  const spans = parseMarkup('<noparse><color=#f00>not parsed</color></noparse>', defaultStyle());
  // Inside <noparse>, the <color> tag should NOT recolor; it appears in text.
  if (spans.length !== 1) fail(`T4 noparse span count ${spans.length}`);
  else if (!spans[0].text.includes('<color=#f00>')) fail(`T4 noparse text "${spans[0].text}"`);
  else if (spans[0].style.color[0] !== 0) fail(`T4 noparse color should stay default (black)`);
  else ok('T4 <noparse> passes literal');
}

// ---- T5: <pos=2> jumps the pen ----
{
  // "AB<pos=2>C" — A,B at their natural positions; C jumps to x≈2em.
  const a = await buildFromMarkup('ABC', font);
  const b = await buildFromMarkup('AB<pos=2>C', font);
  // The 'C' is the 3rd shape (idx 2). Read its bbox xmin from meta.
  const stride = b.metaFloatsPerShape;
  const cXmin = b.metaFloats[2 * stride + 0];
  if (cXmin < 1.9 || cXmin > 2.2) fail(`T5 pos C xmin=${cXmin.toFixed(3)} expected ~2`);
  else ok(`T5 <pos=2> C xmin=${cXmin.toFixed(3)}`);
}

// ---- T6: <line-height=2> doubles line spacing ----
{
  const layout = { maxWidthEm: 2 };
  // "AAA BBB" with maxWidth=2 wraps onto 2 lines. line-height=2 makes the
  // second-line baseline ~2em down (vs ~1.15em with natural Arial).
  const natural = await buildFromMarkup('AAA BBB', font, [0, 0, 0, 1], layout);
  const tall = await buildFromMarkup(
    '<line-height=2>AAA BBB</line-height>',
    font,
    [0, 0, 0, 1],
    layout,
  );
  const hN = natural.globalBBox[3];
  const hT = tall.globalBBox[3];
  if (hT <= hN + 0.3) fail(`T6 line-height tall=${hT.toFixed(3)} natural=${hN.toFixed(3)}`);
  else ok(`T6 <line-height=2> tall=${hT.toFixed(3)} natural=${hN.toFixed(3)}`);
}

// ---- T7: <rotate=90> rotates the glyph (height ↔ width swap) ----
{
  const natural = await buildTextRun('I', font);
  const rotated = await buildFromMarkup('<rotate=90>I</rotate>', font);
  const wN = natural.globalBBox[2];
  const hN = natural.globalBBox[3];
  const wR = rotated.globalBBox[2];
  const hR = rotated.globalBBox[3];
  // After 90° rotation, what was tall becomes wide. So rotated W ≈ natural H,
  // rotated H ≈ natural W (with some allowance for stroke).
  if (Math.abs(wR - hN) > 0.1) fail(`T7 rotated W=${wR.toFixed(3)} vs natural H=${hN.toFixed(3)}`);
  else if (Math.abs(hR - wN) > 0.1)
    fail(`T7 rotated H=${hR.toFixed(3)} vs natural W=${wN.toFixed(3)}`);
  else
    ok(
      `T7 <rotate=90> swaps W/H (W: ${wN.toFixed(3)}→${wR.toFixed(3)}, H: ${hN.toFixed(3)}→${hR.toFixed(3)})`,
    );
}

// ---- T8: <rotate=0> is identity ----
{
  const natural = await buildTextRun('A', font);
  const id = await buildFromMarkup('<rotate=0>A</rotate>', font);
  const wN = natural.globalBBox[2];
  const wI = id.globalBBox[2];
  if (Math.abs(wN - wI) > 1e-3) fail(`T8 rotate=0 not identity ${wN} vs ${wI}`);
  else ok(`T8 <rotate=0> identity`);
}

console.log();
console.log(failures === 0 ? 'MARKUP-TAGS PASS' : `MARKUP-TAGS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
