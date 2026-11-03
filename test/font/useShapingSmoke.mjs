// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// USE end-to-end shaping against real fonts.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { registerUseShaping } from '../../src/font/scripts/use.js';
registerUseShaping();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

let khmerFont = null;
let myanmarFont = null;
try {
  khmerFont = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf')),
  );
  khmerFont.getMetrics(0x1780);
} catch (e) {
  console.log('Skip Khmer:', e.message);
}
try {
  myanmarFont = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/NotoSansMyanmar.ttc')),
  );
  myanmarFont.getMetrics(0x1000);
} catch (e) {
  console.log('Skip Myanmar:', e.message);
}

// ----- T1: Khmer 'កេ' — ka + pre-base E ---------------------
// Logical: ka (0x1780) + E (0x17C1)
// Visual: E first, ka second.
if (khmerFont) {
  const { glyphs } = buildSvgTextGlyphs('កេ', khmerFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T1 'កេ' expected ≥2 glyphs, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x17c1) {
    fail(`T1 first cp ${glyphs[0].codepoint.toString(16)}, want 17c1 (Khmer E)`);
  } else if (glyphs[1].codepoint !== 0x1780) {
    fail(`T1 second cp ${glyphs[1].codepoint.toString(16)}, want 1780 (Khmer ka)`);
  } else ok(`T1 Khmer 'កេ': E first, ka second — pre-base vowel reordered`);
}

// ----- T2: Khmer 'កា' (post-base aa) — identity --------------
// Khmer Sangam MN draws ka+AA as ONE outline (a clig form of ka) and leaves AA's own glyph empty -- HarfBuzz shapes it
// the same way ([280, 701], and 701 has no contours) -- so a font with that form emits one visible glyph, ka first.
if (khmerFont) {
  const { glyphs } = buildSvgTextGlyphs('កា', khmerFont, 0, 0, 100);
  if (glyphs.length < 1) fail(`T2 'កា' drew nothing`);
  else if (glyphs[0].codepoint !== 0x1780)
    fail(`T2 'កា' first cp ${glyphs[0].codepoint.toString(16)}, want 1780 (ka)`);
  else ok(`T2 Khmer 'កា' (post-base AA): ka first, ${glyphs.length} visible glyph(s)`);
}

// ----- T3: Khmer subscript COENG cluster ---------------------
// 'ក្ខ' = ka (0x1780) + COENG (0x17D2) + kha (0x1781): stays as one
// cluster; identity order (no pre-base vowel here).
if (khmerFont) {
  const { glyphs } = buildSvgTextGlyphs('ក្ខ', khmerFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T3 'ក្ខ' expected ≥2 glyphs, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x1780) fail(`T3 first cp not ka`);
  else ok(`T3 Khmer 'ក្ខ' cluster: ${glyphs.length} glyphs (subscript joined)`);
}

// ----- T4: Khmer pre-base vowel + COENG subscript ------------
// 'កេ្ខ' = ka + COENG + kha + E (canonical Khmer)
// Logical: ka, COENG, kha, E
// Reorder: pre-matra E moves before kha (the LAST base).
// Final: ka, COENG, E, kha
if (khmerFont) {
  const { glyphs } = buildSvgTextGlyphs('ក្ខេ', khmerFont, 0, 0, 100);
  if (glyphs.length < 3) fail(`T4 'ក្ខេ' expected ≥3 glyphs, got ${glyphs.length}`);
  else {
    // Find the E and check its position is < the last consonant's position
    let ePos = -1,
      lastConsonantPos = -1;
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i].codepoint === 0x17c1) ePos = i;
      // Last consonant cp in the range 0x1780..0x17B3
      if (glyphs[i].codepoint >= 0x1780 && glyphs[i].codepoint <= 0x17b3) lastConsonantPos = i;
    }
    if (ePos < 0) fail(`T4 'ក្ខេ' E not found in glyph stream`);
    else if (lastConsonantPos < 0) fail(`T4 'ក្ខេ' no consonant in glyph stream`);
    else if (ePos > lastConsonantPos)
      fail(`T4 E (pos ${ePos}) should be BEFORE last consonant (pos ${lastConsonantPos})`);
    else
      ok(
        `T4 Khmer 'ក្ខេ': E (pos ${ePos}) renders BEFORE last consonant (pos ${lastConsonantPos})`,
      );
  }
}

// ----- T5: Myanmar 'ကေ' (ka + E pre-base) -------------------
if (myanmarFont) {
  const { glyphs } = buildSvgTextGlyphs('ကေ', myanmarFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T5 'ကေ' expected ≥2 glyphs`);
  else if (glyphs[0].codepoint !== 0x1031) {
    fail(`T5 first cp ${glyphs[0].codepoint.toString(16)}, want 1031 (Myanmar E)`);
  } else if (glyphs[1].codepoint !== 0x1000) {
    fail(`T5 second cp ${glyphs[1].codepoint.toString(16)}, want 1000 (Myanmar ka)`);
  } else ok(`T5 Myanmar 'ကေ': E first, ka second — pre-base vowel reordered`);
}

// ----- T6: ASCII regression ------------------------------------
{
  let arial = null;
  try {
    arial = new MantleFontAsset(
      new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
    );
    arial.getMetrics(0x41);
  } catch (e) {
    console.log('Skip Arial:', e.message);
  }
  if (arial) {
    const { glyphs } = buildSvgTextGlyphs('Hello', arial, 0, 0, 100);
    if (glyphs.length !== 5) fail(`T6 ASCII broken: ${glyphs.length}`);
    else {
      let mono = true;
      for (let i = 1; i < glyphs.length; i++)
        if (glyphs[i].penX <= glyphs[i - 1].penX) {
          mono = false;
          break;
        }
      if (!mono) fail(`T6 penX not monotonic`);
      else ok(`T6 ASCII 'Hello' unaffected`);
    }
  }
}

console.log();
console.log(failures === 0 ? 'USE-SHAPING PASS' : `USE-SHAPING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
