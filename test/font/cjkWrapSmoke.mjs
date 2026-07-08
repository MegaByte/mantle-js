// cjkWrapSmoke.mjs — CJK soft-wrap behavior.
//
// Verifies break-before-CJK so Asian text wraps inside a max-width
// frame even with no ASCII spaces.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun, buildStyled } from '../../src/font/textRun.js';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/AppleGothic.ttf'))
);
let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const build = async (text, opts) => await buildStyled([{ text, style: defaultStyle() }], font, opts);

// ---- T1: 8 Hangul syllables wrap into multiple lines ----
{
  // 가나다라마바사아 — 8 syllables, ~1em each. maxWidth=3 forces wraps.
  const text = '가나다라마바사아';
  const single = await build(text, {});
  const wrapped = await build(text, { maxWidthEm: 3 });
  if (wrapped.numShapes !== single.numShapes) fail(`T1 numShapes wrapped=${wrapped.numShapes} vs single=${single.numShapes}`);
  const wrapH = wrapped.globalBBox[3];
  const singleH = single.globalBBox[3];
  if (wrapH < singleH * 2) fail(`T1 wrap didn't add lines: wrapH=${wrapH.toFixed(3)} singleH=${singleH.toFixed(3)}`);
  else ok(`T1 Hangul wraps: single h=${singleH.toFixed(3)} wrapped h=${wrapH.toFixed(3)} (${Math.round(wrapH/singleH)}× lines)`);
}

// ---- T2: wrapped width fits inside frame ----
{
  const text = '가나다라마바사아';
  const wrapped = await build(text, { maxWidthEm: 3 });
  const w = wrapped.globalBBox[2];
  if (w > 3.0 + 0.1) fail(`T2 wrap overflowed: w=${w.toFixed(3)} > 3`);
  else ok(`T2 wrap fits frame: w=${w.toFixed(3)}`);
}

// ---- T3: CJK breaker stays on the new line (no glyph lost) ----
{
  // Plain text → 8 shapes; wrapped → still 8 shapes (nothing dropped).
  const text = '가나다라마바사아';
  const single = await build(text, {});
  const wrapped = await build(text, { maxWidthEm: 3 });
  if (single.numShapes !== 8) fail(`T3 single n=${single.numShapes}`);
  else if (wrapped.numShapes !== 8) fail(`T3 wrap dropped glyphs: n=${wrapped.numShapes}`);
  else ok(`T3 wrap preserves all 8 glyphs`);
}

// ---- T4: ASCII space wrap still works (drop the space) ----
{
  const text = 'AAA BBB';
  const single = await build(text, {});
  const wrapped = await build(text, { maxWidthEm: 2 });
  // Without wrap: 7 chars (A,A,A,space,B,B,B). Whitespace-only shape
  // emits 0 contours, so the space slot may or may not show as a shape.
  // What matters: the wrapped result should have fewer or equal shapes
  // than the single (because the space slot is dropped on wrap), AND
  // height should increase from one line to two.
  const wrapH = wrapped.globalBBox[3];
  const singleH = single.globalBBox[3];
  if (wrapH < singleH * 1.5) fail(`T4 ASCII space wrap didn't fire: wrapH=${wrapH.toFixed(3)}`);
  else ok(`T4 ASCII space wrap intact: h ${singleH.toFixed(3)} → ${wrapH.toFixed(3)}`);
}

// ---- T5: Mixed Latin + CJK — wraps at CJK boundaries ----
{
  // "Hi가나다" — 5 codepoints, no spaces. With maxWidth=2, the wrap
  // should fire at one of the Hangul boundaries.
  const text = 'Hi가나다';
  const single = await build(text, {});
  const wrapped = await build(text, { maxWidthEm: 1.5 });
  const wrapH = wrapped.globalBBox[3];
  const singleH = single.globalBBox[3];
  if (wrapH < singleH * 1.5) fail(`T5 mixed wrap didn't fire: wrapH=${wrapH.toFixed(3)}`);
  else if (wrapped.numShapes !== single.numShapes) fail(`T5 mixed lost glyphs: ${wrapped.numShapes} vs ${single.numShapes}`);
  else ok(`T5 mixed Latin+CJK wraps cleanly: ${wrapped.numShapes} shapes, h=${wrapH.toFixed(3)}`);
}

// ---- T6: <nobr> suppresses CJK break too ----
{
  const text = '가나다라마바사아';
  const layout = { maxWidthEm: 3 };
  const wrapped = await build(text, layout);
  const wrapH = wrapped.globalBBox[3];
  // Wrap inside <nobr>: should NOT wrap (no break candidates).
  // We exercise this via parseMarkup + buildStyled to get nobr style.
  // Use buildFromMarkup-equivalent path:
  const spans = parseMarkup('<nobr>' + text + '</nobr>', defaultStyle());
  const noWrap = await buildStyled(spans, font, layout);
  const noWrapH = noWrap.globalBBox[3];
  if (noWrapH > wrapH * 0.6) fail(`T6 <nobr> didn't suppress CJK wrap: noWrapH=${noWrapH.toFixed(3)} wrapH=${wrapH.toFixed(3)}`);
  else ok(`T6 <nobr> suppresses CJK break (h ${wrapH.toFixed(3)} → ${noWrapH.toFixed(3)})`);
}

// ---- T7: Hiragana + Katakana also break ----
{
  // ひらがな (4 hiragana) — should wrap at maxWidth=2.
  const text = 'ひらがな';
  const single = await build(text, {});
  const wrapped = await build(text, { maxWidthEm: 2 });
  if (wrapped.numShapes !== single.numShapes) fail(`T7 hiragana lost glyphs ${wrapped.numShapes} vs ${single.numShapes}`);
  else {
    const wrapH = wrapped.globalBBox[3];
    const singleH = single.globalBBox[3];
    if (wrapH < singleH * 1.5) fail(`T7 hiragana didn't wrap: wrapH=${wrapH.toFixed(3)}`);
    else ok(`T7 Hiragana wraps: h ${singleH.toFixed(3)} → ${wrapH.toFixed(3)}`);
  }
}

console.log();
console.log(failures === 0 ? 'CJK-WRAP PASS' : `CJK-WRAP FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
