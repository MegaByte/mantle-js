// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies bidi textRun integration.
//
// Confirms per-line slots are reordered into visual order when
// layoutSlots() resolves an RTL or mixed paragraph. Uses
// buildSvgTextGlyphs() (the SVG-text helper) because it returns one
// entry per emitted glyph with `codepoint` and `penX`, which lets us
// assert visual ordering without a full bundle inspection.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { registerBidi } from '../../src/font/typography/bidi.js';
registerBidi();

const hebFont = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/SFHebrew.ttf')),
);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ---- T1: pure ASCII penX strictly increases ----
{
  const { glyphs } = buildSvgTextGlyphs('Hello', hebFont, 0, 0, 100);
  let mono = true;
  for (let i = 1; i < glyphs.length; i++)
    if (glyphs[i].penX <= glyphs[i - 1].penX) {
      mono = false;
      break;
    }
  if (!mono) fail('T1 ASCII not monotone increasing penX');
  else ok(`T1 ASCII Hello: ${glyphs.length} glyphs, penX strictly increasing`);
}

// ---- T2: pure Hebrew — last codepoint logically first emerges as
//          leftmost x visually (reorder swapped logical→visual). ----
{
  // "שלום" = ש (0x05E9) + ל (0x05DC) + ו (0x05D5) + ם (0x05DD).
  // Logical: ש ל ו ם.  Visual L→R: ם ו ל ש.
  // So in the glyphs array (which is visual order, increasing penX),
  // codepoint[0] should be ם (0x05DD) and codepoint[3] should be ש (0x05E9).
  const { glyphs } = buildSvgTextGlyphs('שלום', hebFont, 0, 0, 100);
  if (glyphs.length !== 4) {
    fail(`T2 expected 4 Hebrew glyphs, got ${glyphs.length}`);
  } else if (glyphs[0].codepoint !== 0x05dd || glyphs[3].codepoint !== 0x05e9) {
    fail(
      `T2 Hebrew not visually reordered: first=${glyphs[0].codepoint.toString(16)} last=${glyphs[3].codepoint.toString(16)} (want first=5dd / last=5e9)`,
    );
  } else {
    let mono = true;
    for (let i = 1; i < glyphs.length; i++)
      if (glyphs[i].penX <= glyphs[i - 1].penX) {
        mono = false;
        break;
      }
    if (!mono) fail('T2 Hebrew not monotone increasing penX');
    else ok(`T2 Hebrew שלום reordered: ם ו ל ש (visual L→R)`);
  }
}

// ---- T3: Mixed "abc שלום" — Latin first, Hebrew run reversed only. ----
{
  // Logical: a b c sp ש ל ו ם.
  // LTR base. Visual: a b c sp ם ו ל ש.
  const { glyphs } = buildSvgTextGlyphs('abc שלום', hebFont, 0, 0, 100);
  // SFHebrew may not have Latin glyphs — check what we got.
  // For the test, just confirm the LAST glyph (rightmost x) is ש (start of Hebrew logical).
  let hebGlyphs = glyphs.filter((g) => g.codepoint >= 0x0590 && g.codepoint <= 0x05ff);
  if (hebGlyphs.length === 0) {
    fail('T3 no Hebrew glyphs emitted');
  } else if (hebGlyphs[0].codepoint !== 0x05dd) {
    fail(`T3 leftmost Hebrew not ם: got ${hebGlyphs[0].codepoint.toString(16)}`);
  } else if (hebGlyphs[hebGlyphs.length - 1].codepoint !== 0x05e9) {
    fail(
      `T3 rightmost Hebrew not ש: got ${hebGlyphs[hebGlyphs.length - 1].codepoint.toString(16)}`,
    );
  } else ok(`T3 mixed Latin+Hebrew: Hebrew reversed in place`);
}

// ---- T4: explicit baseDirection override (layout option) ----
//         Hard-set LTR on Hebrew text — reorder still applies (RTL run
//         under LTR base reverses), but xOff alignment stays left.
{
  // We can't easily exercise xOff here (no maxWidth), but we can at
  // least check that with no override, single-word Hebrew gets ם first.
  const { glyphs } = buildSvgTextGlyphs('שלום', hebFont, 0, 0, 100);
  if (glyphs.length === 4 && glyphs[0].codepoint === 0x05dd)
    ok('T4 Auto base + Hebrew text → ם first');
  else fail(`T4 Auto base reorder broken`);
}

console.log();
console.log(failures === 0 ? 'BIDI-TEXTRUN PASS' : `BIDI-TEXTRUN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
