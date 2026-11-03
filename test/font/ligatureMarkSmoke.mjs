// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// ligatureMarkSmoke.mjs — a mark written INSIDE a ligature must survive it,
// and attach to the component it was written after.
//
// GSUB type 4 under an IgnoreMarks lookup matches components across the marks
// between them, so the match SPAN is wider than the component count. A layout
// pass that advances by that span and emits only the ligature deletes those
// marks outright: Arabic lam-FATHA-alef (لَا — ordinary, not a corner case)
// would render as a bare lam-alef with the vowel gone.
//
// gsubReader reports compPos so the skipped marks can be told apart from the
// components, re-emitted after the ligature glyph, and tagged with the 0-based
// component they followed — which MarkLigPos uses (a trailing mark takes the
// final component).
//
// Uses a system Arabic font (this is about a real font's rlig + IgnoreMarks
// tables, which no synthetic fixture here has); skips when absent.

import { existsSync, readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerArabicShaping } from '../../src/font/scripts/arabic.js';
import { measureGlyphs } from '../../src/font/textRun.js';

const FONT = '/System/Library/Fonts/SFArabic.ttf';
if (!existsSync(FONT)) {
  console.log('SKIP ligatureMarkSmoke — no system Arabic font at ' + FONT);
  process.exit(0);
}
registerArabicShaping();

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const font = new MantleFontAsset(new Uint8Array(readFileSync(FONT)));
const count = async (text) => (await measureGlyphs([{ text, style: {} }], font, {})).glyphs.length;

// U+0644 lam, U+0627 alef, U+064E fatha, U+064F damma.
const LAM = 'ل',
  ALEF = 'ا',
  FATHA = 'َ',
  DAMMA = 'ُ';

// ---- T1: the ligature still forms -------------------------------------
// If this gives 2, ligation itself is broken, and the mark
// counts below would pass for the wrong reason.
{
  const n = await count(LAM + ALEF);
  if (n === 1) ok('T1 lam+alef still ligates to one glyph');
  else fail(`T1 lam+alef gave ${n} glyphs, expected the ligature (1)`);
}

// ---- T2: a mark BETWEEN the components survives ------------------------
{
  const n = await count(LAM + FATHA + ALEF);
  if (n === 2) ok('T2 lam+FATHA+alef keeps the mark (ligature + mark)');
  else if (n === 1) fail('T2 the mark inside the ligature was DELETED (this is the bug)');
  else fail(`T2 expected 2 glyphs, got ${n} — the ligature may have failed to form`);
}

// ---- T3: a mark after the ligature is unaffected ------------------------
{
  const n = await count(LAM + ALEF + FATHA);
  if (n === 2) ok('T3 a mark after the ligature is unchanged');
  else fail(`T3 expected 2 glyphs, got ${n}`);
}

// ---- T4: marks on both sides ------------------------------------------
{
  const n = await count(LAM + FATHA + ALEF + DAMMA);
  if (n === 3) ok('T4 an inside mark and a trailing mark both survive');
  else fail(`T4 expected 3 glyphs, got ${n}`);
}

// ---- T5: non-ligating text is untouched --------------------------------
// The re-emit path must not duplicate or drop glyphs when nothing ligates.
{
  // beh is respelled as dotless beh + dot mark by SFArabic's rclt (HarfBuzz: 4 glyphs), so 'بيت' is four.
  const checks = [
    ['بيت', 4],
    [LAM, 1],
    [ALEF, 1],
    [FATHA, 1],
  ];
  const wrong = [];
  for (const [t, want] of checks) {
    const n = await count(t);
    if (n !== want) wrong.push(`${JSON.stringify(t)} -> ${n}, want ${want}`);
  }
  if (!wrong.length) ok('T5 non-ligating Arabic is unchanged (no dupes, no drops)');
  else for (const w of wrong) fail(`T5 ${w}`);
}

// ---- T6: Latin ligatures (no marks) are unchanged -----------------------
// The contiguous no-filter match path returns no compPos; that branch must
// shape as it does without marks.
{
  const n = await count('fi');
  if (n >= 1 && n <= 2) ok(`T6 Latin "fi" unchanged (${n} glyph(s))`);
  else fail(`T6 Latin "fi" gave ${n} glyphs`);
}

console.log();
console.log(failures === 0 ? 'LIGATURE-MARK PASS' : `LIGATURE-MARK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
