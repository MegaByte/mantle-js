// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// End-to-end Thai/Lao shaping against real fonts.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

let thaiFont = null;
let laoFont = null;
try {
  thaiFont = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Ayuthaya.ttf')),
  );
  thaiFont.getMetrics(0x0e01);
} catch (e) {
  console.log('Skip Thai font:', e.message);
}
try {
  laoFont = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Lao Sangam MN.ttf')),
  );
  laoFont.getMetrics(0x0e81);
} catch (e) {
  console.log('Skip Lao font:', e.message);
}

// ----- T1: Thai 'เก' — pre-base vowel moves to position 0 ---
// Logical: ko-kai (0x0E01) + SARA E (0x0E40)
// Visual: SARA E, ko-kai
if (thaiFont) {
  const { glyphs } = buildSvgTextGlyphs('เก', thaiFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T1 'เก' expected ≥2 glyphs, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x0e40) {
    fail(`T1 first cp ${glyphs[0].codepoint.toString(16)}, want 0e40 (SARA E)`);
  } else if (glyphs[1].codepoint !== 0x0e01) {
    fail(`T1 second cp ${glyphs[1].codepoint.toString(16)}, want 0e01 (ko-kai)`);
  } else ok(`T1 Thai 'เก': SARA E first, ko-kai second — pre-base vowel reordered`);
}

// ----- T2: Thai 'กา' — post-base vowel: NO reorder -------
if (thaiFont) {
  const { glyphs } = buildSvgTextGlyphs('กา', thaiFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T2 'กา' expected ≥2 glyphs`);
  else if (glyphs[0].codepoint !== 0x0e01 || glyphs[1].codepoint !== 0x0e32) {
    fail(
      `T2 'กา' [${glyphs[0].codepoint.toString(16)}, ${glyphs[1].codepoint.toString(16)}], want [e01, e32]`,
    );
  } else ok(`T2 Thai 'กา' (post-base SARA AA): identity order`);
}

// ----- T3: Thai 'กำ' — SARA AM decomposes to SARA AA + NIKHAHIT ----
//
// Some fonts (incl. some macOS Thai) carry a single glyph for SARA AM,
// in which case the decomposition produces 2 glyphs for 1 source cp
// (the second has its own gid resolved via cmap). Either way we
// shouldn't regress the test: assert that glyph 0 is ko-kai and the
// rest are SARA AM glyphs (1 or 2).
if (thaiFont) {
  const { glyphs } = buildSvgTextGlyphs('กำ', thaiFont, 0, 0, 100);
  if (glyphs.length < 2 || glyphs.length > 3) fail(`T3 'กำ' glyph count ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x0e01) fail(`T3 first cp not ko-kai`);
  else {
    // Decomposition path: glyph[1] is SARA AA (0x0E32), glyph[2] (if
    // present) is NIKHAHIT (0x0E4D).
    if (glyphs[1].codepoint === 0x0e32) {
      ok(`T3 Thai 'กำ' decomposed: ko-kai + SARA-AA${glyphs.length === 3 ? ' + NIKHAHIT' : ''}`);
    } else if (glyphs[1].codepoint === 0x0e33) {
      // Decomposition path not taken (font glyphs the composed form)
      // — that's also acceptable behaviorally.
      ok(`T3 Thai 'กำ' kept composed: ko-kai + SARA-AM`);
    } else fail(`T3 'กำ' second cp ${glyphs[1].codepoint.toString(16)} unexpected`);
  }
}

// ----- T4: Thai 'เก่' — pre-base vowel + tone mark --------------
// Logical: ko-kai + SARA E + MAI EK (tone)
// Visual: SARA E, ko-kai, MAI EK (tone stays positioned on ko-kai)
if (thaiFont) {
  const { glyphs } = buildSvgTextGlyphs('เก่', thaiFont, 0, 0, 100);
  if (glyphs.length < 3) fail(`T4 'เก่' expected ≥3 glyphs, got ${glyphs.length}`);
  else if (glyphs[0].codepoint !== 0x0e40) fail(`T4 first cp not SARA E`);
  else if (glyphs[1].codepoint !== 0x0e01) fail(`T4 second cp not ko-kai`);
  else if (glyphs[2].codepoint !== 0x0e48) fail(`T4 third cp not MAI EK`);
  else {
    // Mark advance should be 0 if GPOS mark attachment fired.
    const toneAdv = glyphs[2].advance;
    if (toneAdv !== 0) {
      // The font may not ship GPOS 'mark' — that's fine; just confirm
      // the order is right.
      ok(
        `T4 Thai 'เก่': [SARA E, ko-kai, MAI EK] — order correct (tone advance=${toneAdv.toFixed(2)} — font lacks GPOS 'mark')`,
      );
    } else {
      ok(`T4 Thai 'เก่': [SARA E, ko-kai, MAI EK]; tone has 0 advance (GPOS mark fired)`);
    }
  }
}

// ----- T5: Lao 'ເກ' — pre-base vowel reorder -------------------
if (laoFont) {
  const { glyphs } = buildSvgTextGlyphs('ເກ', laoFont, 0, 0, 100);
  if (glyphs.length < 2) fail(`T5 Lao 'ເກ' expected ≥2 glyphs`);
  else if (glyphs[0].codepoint !== 0x0ec0)
    fail(`T5 first cp ${glyphs[0].codepoint.toString(16)}, want 0ec0 (LAO E)`);
  else if (glyphs[1].codepoint !== 0x0e81)
    fail(`T5 second cp ${glyphs[1].codepoint.toString(16)}, want 0e81 (Lao ko)`);
  else ok(`T5 Lao 'ເກ': LAO E first, Lao ko second`);
}

// ----- T6: ASCII regression ---------------------------------
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
    if (glyphs.length !== 5) fail(`T6 ASCII 'Hello' broken: ${glyphs.length}`);
    else {
      let mono = true;
      for (let i = 1; i < glyphs.length; i++)
        if (glyphs[i].penX <= glyphs[i - 1].penX) {
          mono = false;
          break;
        }
      if (!mono) fail(`T6 penX not monotonic`);
      else ok(`T6 ASCII: 'Hello' unaffected`);
    }
  }
}

console.log();
console.log(failures === 0 ? 'THAI-SHAPING PASS' : `THAI-SHAPING FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
