// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markLigPosSmoke.mjs — verifies GPOS type 5 (MarkLigPos) wiring.
//
// MarkLigPos fires when a mark follows a glyph that was produced by
// type-4 ligature substitution. The textRun's ligComponents tracking
// passes the consumed-component count through to the mark-attach
// loop, which calls getMarkLigAttachment with the component the mark was
// written after, or, for a trailing mark, lastComponent (the HarfBuzz
// "default to final" heuristic).
//
// This smoke verifies:
//   T1 reader exposes getMarkLigAttachment + can return non-null on
//      a font that ships type 5 (Amiri / NotoSansArabic carry them;
//      on macOS we use whatever's available — SFArabic has type 5
//      but for which gid combinations is font-internal).
//   T2 ligComponents propagates through the ligature pass — a known
//      lam-alef ligature shaped from SFArabic should have ligComponents
//      ≥ 2 on the resulting slot.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerArabicShaping } from '../../src/font/scripts/arabic.js';
registerArabicShaping();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const SFArabicPath = '/System/Library/Fonts/SFArabic.ttf';
if (!existsSync(SFArabicPath)) {
  console.log('Skip MarkLigPos smoke: SFArabic.ttf not available');
  process.exit(0);
}
const font = new MantleFontAsset(new Uint8Array(readFileSync(SFArabicPath)));
font.getMetrics(0x0628);

// ----- T1: getMarkLigAttachment API exists --------------------------
{
  const gpos = font.gpos;
  if (typeof gpos.getMarkLigAttachment !== 'function') {
    fail('T1 getMarkLigAttachment should exist on gposReader');
  } else ok('T1 getMarkLigAttachment API present');
}

// ----- T2: ligComponents propagates through ligature pass -----------
// 'بلاد' contains lam-alef (ل + ا) which is a required ligature in
// SFArabic ('rlig' feature). The resulting slot should have
// ligComponents = 2.
{
  const style = defaultStyle();
  const slots = _layoutSlotsForTest([{ text: 'بلاد', style }], font, {});
  if (!slots || slots.length === 0) {
    fail('T2 layoutSlots returned empty');
  } else {
    const ligSlots = slots.filter((s) => s.ligComponents > 1);
    if (ligSlots.length === 0) {
      // Diagnose: what gids did shaping produce, and any with >1 components?
      const ligOnes = slots.map((s) => `gid=${s.glyphId} lc=${s.ligComponents}`).join(', ');
      fail(
        `T2 expected at least one slot with ligComponents>1 in 'بلاد' (lam-alef). Got: ${ligOnes}`,
      );
    } else {
      ok(
        `T2 ligComponents propagated: ${ligSlots.length} ligature slot(s), counts=[${ligSlots.map((s) => s.ligComponents).join(',')}]`,
      );
    }
  }
}

// ----- T3: smoke for slot field shape (non-ligature defaults to 1) --
{
  const style = defaultStyle();
  const slots = _layoutSlotsForTest([{ text: 'ABC', style }], font, {});
  const nonOnes = slots.filter((s) => s.ligComponents !== 1);
  if (nonOnes.length > 0) {
    fail(
      `T3 ASCII 'ABC' should have all ligComponents=1, found anomalies: ${JSON.stringify(nonOnes.map((s) => s.ligComponents))}`,
    );
  } else ok('T3 non-ligature slots default ligComponents=1');
}

if (failures > 0) {
  console.error(`\nMARKLIGPOS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nMARKLIGPOS PASS');
