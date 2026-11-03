// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicShapingSmoke.mjs — end-to-end textRun integration.
// Loads Apple's Devanagari + Bengali fonts and checks that:
//   - The pre-base matra reorder fires on real text
//   - Emitted glyph order has the pre-matra glyph at visual position 0
//   - Non-Indic regression: ASCII unaffected

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerCffReader } from '../../src/font/formats/cff.js';
registerCffReader();
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { registerIndicShaping } from '../../src/font/scripts/indic.js';
registerIndicShaping();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

let devaFont = null;
let bengFont = null;
try {
  devaFont = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc')),
  );
  devaFont.getMetrics(0x0915);
} catch (e) {
  console.log('Skip Deva font:', e.message);
}
try {
  bengFont = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/KohinoorBangla.ttc')),
  );
  bengFont.getMetrics(0x0995);
} catch (e) {
  console.log('Skip Beng font:', e.message);
}

// ----- T1: Devanagari 'ki' — pre-matra at position 0 in glyph stream
if (devaFont) {
  // Logical: ka(0x0915) + i(0x093F).
  // After reorder: i comes first in glyph stream.
  const { glyphs } = buildSvgTextGlyphs('कि', devaFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T1 expected ≥2 glyphs for 'कि', got ${glyphs.length}`);
  else {
    // glyphs[0] should carry codepoint 0x093F (the i-matra).
    if (glyphs[0].codepoint !== 0x093f) {
      fail(`T1 first glyph cp=${glyphs[0].codepoint.toString(16)}, want 093f (i-matra)`);
    } else if (glyphs[1].codepoint !== 0x0915) {
      fail(`T1 second glyph cp=${glyphs[1].codepoint.toString(16)}, want 0915 (ka)`);
    } else ok(`T1 'कि' (Devanagari ki): pre-matra at position 0, ka at position 1`);
  }
}

// ----- T2: Devanagari 'का' (post-matra aa) — NO reorder ----------
if (devaFont) {
  const { glyphs } = buildSvgTextGlyphs('का', devaFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T2 expected ≥2 glyphs for 'का', got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x0915 || glyphs[1].codepoint !== 0x093e) {
    fail(
      `T2 'का' order: [${glyphs[0].codepoint.toString(16)}, ${glyphs[1].codepoint.toString(16)}], want [915, 93e]`,
    );
  } else ok(`T2 'का' (Devanagari kaa, post-matra): no reorder`);
}

// ----- T3: Bengali 'কি' (pre-matra i) -----------------------------
if (bengFont) {
  // Logical: bengali ka(0x0995) + i(0x09BF)
  // After reorder: i first, ka second.
  const { glyphs } = buildSvgTextGlyphs('কি', bengFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T3 expected ≥2 glyphs for 'কি', got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x09bf) {
    fail(`T3 'কি' first cp=${glyphs[0].codepoint.toString(16)}, want 09bf (bn i-matra)`);
  } else if (glyphs[1].codepoint !== 0x0995) {
    fail(`T3 'কি' second cp=${glyphs[1].codepoint.toString(16)}, want 0995 (bn ka)`);
  } else ok(`T3 'কি' (Bengali ki): pre-matra reordered to position 0`);
}

// ----- T4: Bengali 'কে' (pre-matra e) ----------------------------
if (bengFont) {
  // Logical: ka(0x0995) + e(0x09C7). Bengali e is ALSO pre-base.
  const { glyphs } = buildSvgTextGlyphs('কে', bengFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T4 expected ≥2 glyphs for 'কে'`);
  else if (glyphs[0].codepoint !== 0x09c7) {
    fail(`T4 'কে' first cp=${glyphs[0].codepoint.toString(16)}, want 09c7 (bn e)`);
  } else ok(`T4 'কে' (Bengali ke, also pre-base): correctly reordered`);
}

// ----- T5: Devanagari 'का' + 'कि' multi-syllable --------------
if (devaFont) {
  // 'काकि' = ka + aa + ka + i.  Two syllables.
  //   Syl 1: ka + aa → no reorder
  //   Syl 2: ka + i → reorder to [i, ka]
  // Final order: ka, aa, i, ka  (codepoints: 0915, 093E, 093F, 0915)
  const { glyphs } = buildSvgTextGlyphs('काकि', devaFont, 0, 0, 100);
  if (glyphs.length < 4) fail(`T5 expected ≥4 glyphs, got ${glyphs.length}`);
  else {
    const cps = glyphs.map((g) => g.codepoint);
    const want = [0x0915, 0x093e, 0x093f, 0x0915];
    let same = cps.length >= 4;
    for (let i = 0; same && i < 4; i++) if (cps[i] !== want[i]) same = false;
    if (!same) {
      fail(`T5 'काकि' cps=[${cps.map((c) => c.toString(16)).join(',')}], want [915,93e,93f,915]`);
    } else ok(`T5 multi-syllable 'काकि' → ka, aa, [reorder: i, ka]`);
  }
}

// ----- T6: ASCII regression — Latin font unaffected by Indic path -----
{
  const arial = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
  );
  arial.getMetrics(0x41);
  const { glyphs } = buildSvgTextGlyphs('Hello', arial, 0, 0, 100);
  if (glyphs.length !== 5) fail(`T6 ASCII broken: ${glyphs.length} glyphs`);
  else {
    // Check penX monotonically increases.
    let mono = true;
    for (let i = 1; i < glyphs.length; i++)
      if (glyphs[i].penX <= glyphs[i - 1].penX) {
        mono = false;
        break;
      }
    if (!mono) fail(`T6 ASCII penX not monotonic`);
    else ok(`T6 ASCII 'Hello' unaffected`);
  }
}

console.log();
console.log(failures === 0 ? 'INDIC-SHAPING PASS' : `INDIC-SHAPING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
