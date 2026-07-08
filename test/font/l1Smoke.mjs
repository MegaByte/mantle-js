// l1Smoke.mjs — pragmatic Unicode core.
//
// Verifies:
//   - TR#14 LB13 don't-break-before CJK closing punctuation
//   - TR#14 LB14 don't-break-after CJK opening punctuation
//   - NFC normalization on input strings (handles NFD-encoded text)

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled, buildTextRun } from '../../src/font/textRun.js';
import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

const arial  = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
const gothic = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/AppleGothic.ttf')));
arial.getMetrics(0x41);
gothic.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const build = async (text, font, opts) => await buildStyled([{ text, style: defaultStyle() }], font, opts || {});

// ---- T1: NFC collapses precomposed vs decomposed to same glyph count ----
{
  const nfc = 'café';            // precomposed U+00E9
  const nfd = 'café';           // e + U+0301 combining acute
  const a = await buildTextRun(nfc, arial);
  const b = await buildTextRun(nfd, arial);
  if (a.numShapes !== b.numShapes) fail(`T1 NFC vs NFD shape count ${a.numShapes} vs ${b.numShapes}`);
  else if (Math.abs((a.globalBBox[2]) - (b.globalBBox[2])) > 1e-3)
    fail(`T1 NFC vs NFD width differs`);
  else ok(`T1 NFC ↔ NFD parity: ${a.numShapes} shapes, w=${(a.globalBBox[2]).toFixed(3)}`);
}

// ---- T2: NFC affects multiple precomposed letters (façade) ----
{
  const nfc = 'façade';
  const nfd = 'façade';  // c + cedilla
  const a = await buildTextRun(nfc, arial);
  const b = await buildTextRun(nfd, arial);
  if (a.numShapes !== b.numShapes) fail(`T2 façade shape count ${a.numShapes} vs ${b.numShapes}`);
  else ok(`T2 façade NFC ↔ NFD: ${a.numShapes} shapes`);
}

// ---- T3: pre-NFC text passes through unchanged ----
{
  const text = 'hello';   // pure ASCII, already NFC
  const b = await buildTextRun(text, arial);
  if (b.numShapes !== 5) fail(`T3 ASCII no-op: ${b.numShapes}`);
  else ok(`T3 NFC is no-op on pure ASCII`);
}

// ---- T4: LB13 — break does NOT happen BEFORE 。 (CJK full stop) ----
{
  // "あいうえ。お" at maxWidth=4.5 fits 4 CJK chars (~4em) + period (0.5em).
  // Without LB13: wrap could fire AT 。, putting period at start of line 2.
  // With LB13:    period is non-breakable, so wrap goes elsewhere — 。
  //               stays after え on line 1; only お wraps to line 2.
  //
  // Glyph-bbox ymin varies by character shape (a period's bbox top is at
  // line baseline, an ascender's bbox top is high above baseline), so
  // we infer line membership from the X coordinate: line-start glyphs
  // have the smallest X on their line, and 。 (U+3002) should NOT be
  // line-start for any wrap point.
  const text = 'あいうえ。お';
  const b = await build(text, gothic, { maxWidthEm: 4.5 });
  const stride = b.metaFloatsPerShape;
  let periodIdx = -1;
  for (let i = 0; i < b.numShapes; i++) {
    if (b.shapeIds[i].includes('u3002')) { periodIdx = i; break; }
  }
  if (periodIdx < 0) fail(`T4 period glyph not found`);
  else {
    // The period's preceding-in-source glyph is え (index 3). LB13 means
    // wrap can't split the え→。 pair. So in the output bundle, the
    // glyph immediately before the period in source-order must have an
    // xmin LESS than the period's xmin (they're horizontally adjacent
    // on the same line). If the period got wrapped to line-start,
    // its xmin would be smaller than え's.
    const myX = b.metaFloats[periodIdx*stride + 0];
    const prevX = b.metaFloats[(periodIdx - 1)*stride + 0];
    if (prevX > myX) fail(`T4 LB13 violated — 。 wrapped to line-start (xmin ${myX.toFixed(3)} < え xmin ${prevX.toFixed(3)})`);
    else ok(`T4 LB13: 。 stays with preceding え (xmin ${prevX.toFixed(3)} → ${myX.toFixed(3)})`);
  }
}

// ---- T5: LB14 — break does NOT happen AFTER 「 (CJK open quote) ----
{
  // "あいう「えお" at maxWidth=4.5 — wrap can't land between 「 and the
  // glyph that follows it. If LB14 were violated, the 「 would end
  // line 1 alone and え would start line 2.
  //
  // Easier check via source-order x adjacency: the glyph immediately
  // AFTER 「 in source (え, index 4) should have a LARGER x than 「
  // (they're adjacent on the same line). If LB14 broke after 「, え
  // would land at the start of a new line and have a smaller x.
  const text = 'あいう「えお';
  const b = await build(text, gothic, { maxWidthEm: 4.5 });
  const stride = b.metaFloatsPerShape;
  let openIdx = -1;
  for (let i = 0; i < b.numShapes; i++) {
    if (b.shapeIds[i].includes('u300C')) { openIdx = i; break; }
  }
  if (openIdx < 0 || openIdx >= b.numShapes - 1) fail(`T5 open-quote / follower not found`);
  else {
    const myXmin = b.metaFloats[openIdx*stride + 0];
    const nextXmin = b.metaFloats[(openIdx + 1)*stride + 0];
    if (nextXmin < myXmin) fail(`T5 LB14 violated — え wrapped to line-start (xmin ${nextXmin.toFixed(3)} < 「 xmin ${myXmin.toFixed(3)})`);
    else ok(`T5 LB14: え stays after 「 (xmin ${myXmin.toFixed(3)} → ${nextXmin.toFixed(3)})`);
  }
}

// ---- T6: ASCII space wrap still works (regression) ----
{
  const single = await buildTextRun('AAA BBB', arial);
  const wrapped = await build('AAA BBB', arial, { maxWidthEm: 2 });
  const hS = single.globalBBox[3];
  const hW = wrapped.globalBBox[3];
  if (hW < hS * 1.5) fail(`T6 ASCII wrap regression: hW=${hW.toFixed(3)} hS=${hS.toFixed(3)}`);
  else ok(`T6 ASCII space wrap intact`);
}

// ---- T7: NFC composes through markup spans (each span normalized) ----
{
  const spans = parseMarkup('caf<color=#f00>é</color>', defaultStyle());
  // The é here is NFD in the source — markup parsing keeps it as-is in
  // span.text; NFC happens at layout time. Test that the resulting
  // bundle from a NFD-containing markup yields same shape count as the
  // pure-NFC version.
  const b1 = await buildStyled(spans, arial, {});
  const b2 = await buildTextRun('café', arial);
  if (b1.numShapes !== b2.numShapes) fail(`T7 markup-NFC: ${b1.numShapes} vs ${b2.numShapes}`);
  else ok(`T7 NFC works inside markup spans`);
}

console.log();
console.log(failures === 0 ? 'L1 PASS' : `L1 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
