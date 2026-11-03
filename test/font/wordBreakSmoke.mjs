// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// wordBreakSmoke.mjs — JS-only word-aware CJK wrap behavior.
//
// Verifies that with Intl.Segmenter('word') in play, multi-character
// Japanese words (e.g. 「今日」, 「天気」) prefer to stay together when
// a wrap point exists between them — but the per-character fallback
// still kicks in for runs the segmenter sees as one big word
// (Korean without spaces).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';

const gothic = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/AppleGothic.ttf')),
);
gothic.getMetrics(0x41);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const build = async (text, opts) =>
  await buildStyled([{ text, style: defaultStyle() }], gothic, opts || {});

// ---- T1: Japanese "今日は良い天気" word-boundary wrap ----
{
  // Words per Intl.Segmenter('word'): 今日 | は | 良い | 天気
  // At maxWidthEm=2.5, only the first two words fit (今日は ~3 chars * ~1em = 3em…
  // actually too wide already). At maxWidthEm=3, "今日は" fits (~3em), break
  // before 良い. Without word-break gating: would break between え and ば
  // mid-word. With it: breaks at word boundaries only.
  const text = '今日は良い天気';
  const b = await build(text, { maxWidthEm: 3 });

  // Find indices of 良 (U+826F) — it's a word START. After wrap,
  // 良 should be at the START of its line (xmin smaller than 今日は's xmin
  // on the same line? no — different line. So 良's xmin ≈ 0).
  const stride = b.metaFloatsPerShape;
  let goodIdx = -1;
  for (let i = 0; i < b.numShapes; i++) {
    if (b.shapeIds[i].includes('u826F')) {
      goodIdx = i;
      break;
    }
  }
  if (goodIdx < 0) fail(`T1 '良' not found`);
  else {
    const xmin = b.metaFloats[goodIdx * stride + 0];
    // 良 should be near line-start (xmin ~ 0 to 0.2em).
    if (xmin > 0.3) fail(`T1 '良' xmin=${xmin.toFixed(3)} — not at word-aware line-start`);
    else ok(`T1 Japanese wraps at word boundary: 良 xmin=${xmin.toFixed(3)} (line-start)`);
  }
}

// ---- T2: Korean string with no spaces → per-char fallback wraps ----
{
  // Intl.Segmenter sees "가나다라마바사아" as ONE word. The per-char
  // gate still fires, so the run wraps inside the word (this is the
  // intentional fallback — we accept it as preferable to overflow).
  const text = '가나다라마바사아';
  const b = await build(text, { maxWidthEm: 3 });
  // Without per-char fallback, this would overflow to one big line.
  // With the fallback, it wraps to multiple lines.
  const w = b.globalBBox[2];
  if (w > 3.1) fail(`T2 Korean run-of-one-word overflowed: w=${w.toFixed(3)}`);
  else ok(`T2 Korean (Intl sees 1 word) falls back to char-break: w=${w.toFixed(3)}`);
}

// ---- T3: Mixed Latin + Japanese — Latin space wins as natural break ----
{
  // "Hi 今日は天気" — Intl segments as Hi | space | 今日 | は | 天気.
  // The ASCII space is the cheapest break candidate (drop-style). With
  // maxWidthEm=2.5, wrap should happen at the SPACE, leaving Hi on
  // line 1 and 今日は天気 on line 2.
  const text = 'Hi 今日';
  const b = await build(text, { maxWidthEm: 2.5 });
  // Find the 今 shape (U+4ECA); it should be line-start.
  const stride = b.metaFloatsPerShape;
  let imaIdx = -1;
  for (let i = 0; i < b.numShapes; i++) {
    if (b.shapeIds[i].includes('u4ECA')) {
      imaIdx = i;
      break;
    }
  }
  if (imaIdx < 0) fail(`T3 '今' not found`);
  else {
    const xmin = b.metaFloats[imaIdx * stride + 0];
    if (xmin > 0.3) fail(`T3 '今' xmin=${xmin.toFixed(3)} not line-start`);
    else ok(`T3 mixed Latin+JP wraps at space: 今 xmin=${xmin.toFixed(3)}`);
  }
}

// ---- T4: Single CJK word too long for frame — per-char fallback ----
{
  // 今日 (2 chars) at maxWidthEm=1.5 — the word doesn't fit, so the
  // per-char fallback splits between 今 and 日. Accept this; better
  // than overflow.
  const text = '今日';
  const b = await build(text, { maxWidthEm: 1.5 });
  const w = b.globalBBox[2];
  if (w > 1.6) fail(`T4 long-word overflow w=${w.toFixed(3)}`);
  else ok(`T4 word too long → per-char split (w=${w.toFixed(3)})`);
}

console.log();
console.log(failures === 0 ? 'WORDBREAK PASS' : `WORDBREAK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
