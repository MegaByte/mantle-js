// Rich-text tag smoke tests: parser + layout + assembly for
//   <u>/<s>/<mark>, <cspace>/<mspace>/<space>, <width>,
//   <lowercase>/<uppercase>/<allcaps>, <nobr>, <align=...>, <indent=N>.
// Each test exercises a single behavior so failures point at one place.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun, buildFromMarkup, buildStyled } from '../../src/font/textRun.js';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf'))
);
let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ---- T1: parser produces extended style fields ----
{
  const spans = parseMarkup('<u>X</u>', defaultStyle());
  if (spans.length !== 1) fail(`T1 span count ${spans.length}`);
  if (!spans[0].style.underline) fail('T1 underline flag');
  ok(`T1 <u> sets underline`);
}

// ---- T2: <mark> with default color ----
{
  const spans = parseMarkup('<mark>X</mark>', defaultStyle());
  if (!spans[0].style.mark) fail('T2 mark flag');
  if (spans[0].style.markColor[2] !== 0) fail('T2 default markColor blue=0');
  ok(`T2 <mark> default color`);
}

// ---- T3: <mark=#color> override ----
{
  const spans = parseMarkup('<mark=#f00>X</mark>', defaultStyle());
  if (spans[0].style.markColor[0] !== 1) fail(`T3 mark color r=${spans[0].style.markColor[0]}`);
  if (spans[0].style.markColor[1] !== 0) fail('T3 mark color g');
  ok(`T3 <mark=#color> override`);
}

// ---- T4: <width=50%> halves widthScale ----
{
  const spans = parseMarkup('<width=50%>X</width>', defaultStyle());
  if (Math.abs(spans[0].style.widthScale - 0.5) > 1e-6) fail(`T4 widthScale ${spans[0].style.widthScale}`);
  ok(`T4 <width=50%>`);
}

// ---- T5: <width=2> absolute ----
{
  const spans = parseMarkup('<width=2>X</width>', defaultStyle());
  if (Math.abs(spans[0].style.widthScale - 2) > 1e-6) fail(`T5 widthScale ${spans[0].style.widthScale}`);
  ok(`T5 <width=2>`);
}

// ---- T6: <lowercase> + <uppercase> + <allcaps> case transforms ----
{
  const lower = parseMarkup('<lowercase>HeLLo</lowercase>', defaultStyle());
  if (lower[0].text !== 'hello') fail(`T6.lower "${lower[0].text}"`);
  const upper = parseMarkup('<uppercase>HeLLo</uppercase>', defaultStyle());
  if (upper[0].text !== 'HELLO') fail(`T6.upper "${upper[0].text}"`);
  const caps  = parseMarkup('<allcaps>x</allcaps>', defaultStyle());
  if (caps[0].text !== 'X') fail(`T6.allcaps "${caps[0].text}"`);
  ok(`T6 case transforms`);
}

// ---- T7: <nobr> sets nobr flag on inner span ----
{
  const spans = parseMarkup('a<nobr>b c</nobr>d', defaultStyle());
  if (spans.length !== 3) fail(`T7 span count ${spans.length}`);
  if (spans[0].style.nobr) fail('T7 outer should not nobr');
  if (!spans[1].style.nobr) fail('T7 inner should nobr');
  ok(`T7 <nobr>`);
}

// ---- T8: <space=2> injects synthetic NBSP span with mspaceEm=2 ----
{
  const spans = parseMarkup('A<space=2>B', defaultStyle());
  // Expect: ['A' span, ' ' inject span (mspace=2), 'B' span]
  if (spans.length !== 3) fail(`T8 span count ${spans.length}`);
  if (spans[1].style.mspaceEm !== 2) fail(`T8 mspace ${spans[1].style.mspaceEm}`);
  if (spans[1].text !== ' ') fail(`T8 inject text codepoint=${spans[1].text.charCodeAt(0).toString(16)}`);
  ok(`T8 <space=2>`);
}

// ---- T9: <align=center> produces a directive span ----
{
  const spans = parseMarkup('<align=center>X</align>', defaultStyle());
  // Expect: directive (open), 'X' span, directive (close restoring null).
  if (spans.length !== 3) fail(`T9 span count ${spans.length}`);
  if (!spans[0].directive?.hasAlign) fail('T9 open directive');
  if (spans[0].directive.align !== 'center') fail(`T9 align ${spans[0].directive.align}`);
  if (spans[1].text !== 'X') fail(`T9 text span`);
  if (!spans[2].directive?.hasAlign) fail('T9 close directive');
  ok(`T9 <align=center>`);
}

// ---- T10: <indent=N> produces directive ----
{
  const spans = parseMarkup('<indent=2>X</indent>', defaultStyle());
  if (!spans[0].directive?.hasIndent) fail('T10 indent open');
  if (spans[0].directive.indentEm !== 2) fail(`T10 indent ${spans[0].directive.indentEm}`);
  ok(`T10 <indent=2>`);
}

// ---- T11: <u> emits a single underline rect on top of the glyph(s) ----
{
  const plain = await buildFromMarkup('Hi', font);
  const ulined = await buildFromMarkup('<u>Hi</u>', font);
  if (ulined.numShapes !== plain.numShapes + 1)
    fail(`T11 expect +1 shape; plain=${plain.numShapes} ul=${ulined.numShapes}`);
  // Underline rect is the last shape (appended after glyphs).
  const stride = ulined.metaFloatsPerShape;
  const last = ulined.numShapes - 1;
  const bb = [
    ulined.metaFloats[last*stride+0], ulined.metaFloats[last*stride+1],
    ulined.metaFloats[last*stride+2], ulined.metaFloats[last*stride+3],
  ];
  // Wider than tall + spans both H and i horizontally.
  if (bb[2] - bb[0] < 0.5) fail(`T11 underline too narrow ${bb[2]-bb[0]}`);
  if (bb[3] - bb[1] > 0.2) fail(`T11 underline too tall ${bb[3]-bb[1]}`);
  ok(`T11 <u> underline rect width=${(bb[2]-bb[0]).toFixed(3)} height=${(bb[3]-bb[1]).toFixed(3)}`);
}

// ---- T12: <mark> emits a rect BEFORE glyphs ----
{
  const marked = await buildFromMarkup('<mark>Hi</mark>', font);
  // mark is first; then 2 glyphs ⇒ 3 shapes.
  if (marked.numShapes !== 3) fail(`T12 expect 3 shapes; got ${marked.numShapes}`);
  // The first shape should be the mark rect (full ascent..descent height).
  const stride = marked.metaFloatsPerShape;
  const bb = [
    marked.metaFloats[0], marked.metaFloats[1],
    marked.metaFloats[2], marked.metaFloats[3],
  ];
  const h = bb[3] - bb[1];
  if (h < 0.9) fail(`T12 mark rect too short ${h.toFixed(3)} (expected ~1.1em)`);
  ok(`T12 <mark> rect first, height=${h.toFixed(3)}em`);
}

// ---- T13: <s> emits a strikethrough rect after glyphs ----
{
  const struck = await buildFromMarkup('<s>Hi</s>', font);
  if (struck.numShapes !== 3) fail(`T13 expect 3 shapes; got ${struck.numShapes}`);
  // strike at y ≈ -0.27em (above baseline = negative in +Y-down)
  const stride = struck.metaFloatsPerShape;
  const last = struck.numShapes - 1;
  const bb = [
    struck.metaFloats[last*stride+0], struck.metaFloats[last*stride+1],
    struck.metaFloats[last*stride+2], struck.metaFloats[last*stride+3],
  ];
  // strike rect mid-y must lie between baseline (0) and the underline (which sits below baseline).
  const midY = (bb[1] + bb[3]) * 0.5;
  if (midY > 0) fail(`T13 strike midY=${midY.toFixed(3)} should be < 0 (above baseline)`);
  ok(`T13 <s> strike midY=${midY.toFixed(3)}em`);
}

// ---- T14: <width=200%> doubles bbox X extent vs natural ----
{
  const natural = await buildTextRun('I', font);
  const wide    = await buildFromMarkup('<width=200%>I</width>', font);
  const wn = natural.globalBBox[2];
  const ww = wide.globalBBox[2];
  if (Math.abs(ww / wn - 2) > 0.05) fail(`T14 width ratio ${(ww/wn).toFixed(3)} expected ~2`);
  ok(`T14 <width=200%> w/n ratio=${(ww/wn).toFixed(3)}`);
}

// ---- T15: <mspace=1> overrides advance ----
{
  // 3 chars at mspace=1em each ⇒ total width ≈ 3em
  const mono = await buildFromMarkup('<mspace=1>iii</mspace>', font);
  const w = mono.globalBBox[2];
  // mspace forces advance to 1em per glyph but glyph WIDTH is unchanged;
  // bbox spans first glyph's xmin to (2em + last glyph's xmax). For 'i'
  // the glyph is narrow (~0.08em wide), so total bbox ≈ 2em + ~0.08em.
  if (w < 1.9 || w > 2.5) fail(`T15 mspace bbox w=${w.toFixed(3)} not in [1.9,2.5]`);
  ok(`T15 <mspace=1> w=${w.toFixed(3)}`);
}

// ---- T16: <cspace=1> adds 1em after each glyph ----
{
  const plain = await buildTextRun('AB', font);
  const csp   = await buildFromMarkup('<cspace=1>AB</cspace>', font);
  const wp = plain.globalBBox[2];
  const wc = csp.globalBBox[2];
  // cspace adds 1em after EACH glyph; bbox grows by ~2em for 2 glyphs
  // (1em added between, the 1em added after the last doesn't change
  // the right glyph bbox extent — but our impl pushes the bbox).
  if (wc - wp < 0.8 || wc - wp > 2.2) fail(`T16 cspace delta=${(wc-wp).toFixed(3)} not ~1-2`);
  ok(`T16 <cspace=1> delta=${(wc-wp).toFixed(3)}`);
}

// ---- T17: <nobr> prevents wrap at its inner space ----
{
  // Phrase "AAA BBB CCC" at maxWidth=2 should wrap at one of the spaces.
  // With <nobr>BBB CCC</nobr> the space inside nobr should NOT be a
  // wrap candidate, so the wrap happens at "AAA |BBB CCC".
  const layout = { maxWidthEm: 2, align: 'left' };
  const free   = await buildFromMarkup('AAA BBB CCC', font, [0,0,0,1], layout);
  const nobr   = await buildFromMarkup('AAA <nobr>BBB CCC</nobr>', font, [0,0,0,1], layout);
  const hF = free.globalBBox[3];
  const hN = nobr.globalBBox[3];
  // <nobr> phrase exceeds maxWidth, so wrap can only happen at first
  // space → result is 2 lines. Free version may wrap into 3.
  if (!(hN < hF + 0.01)) fail(`T17 nobr h=${hN.toFixed(3)} should be <= free h=${hF.toFixed(3)}`);
  ok(`T17 <nobr> hN=${hN.toFixed(3)} hF=${hF.toFixed(3)}`);
}

// ---- T18: <indent=1> pushes line start ----
{
  const layout = { maxWidthEm: 4 };
  // Without indent: H is at x≈0. With indent=1 directive at the start,
  // H sits at x≈1em.
  const a = await buildFromMarkup('H', font, [0,0,0,1], layout);
  const b = await buildFromMarkup('<indent=1>H', font, [0,0,0,1], layout);
  const ax = a.globalBBox[0];
  const bx = b.globalBBox[0];
  if (bx - ax < 0.8) fail(`T18 indent delta=${(bx-ax).toFixed(3)} expected ~1`);
  ok(`T18 <indent=1> dx=${(bx-ax).toFixed(3)}`);
}

console.log();
console.log(failures === 0 ? 'F3-ext PASS' : `F3-ext FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
