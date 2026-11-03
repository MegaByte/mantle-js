// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// useFeatureSmoke — Khmer and Myanmar text shapes to the glyphs HarfBuzz produces from the same font.
//
// Review #50: USE scripts got a cluster reorder and no GSUB feature pass. A COENG or VIRAMA stack drew as separate spacing
// glyphs, the reorder put a pre-base vowel inside the stack (it took the LAST consonant as the base), Khmer COENG+RO stayed
// after the base, Myanmar kinzi went to the end of the cluster instead of after the base, and Khmer split vowels had no
// pre-base part. Against HarfBuzz on the fonts below, 4 of the first 22 strings matched.
//
// The reference is HarfBuzz's glyph ids (uharfbuzz 0.51.7, default features, script and direction guessed) for macOS
// system fonts, recorded with each font's byte size: a font that is missing or has changed size skips its script rather
// than failing, because glyph ids belong to one build of a font. Tibetan is not covered: every installed Tibetan font
// shapes through AAT morx or carries no Tibetan GSUB.
import { readFileSync, statSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { layoutSlots } from '../../src/font/textLayout.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerUseShaping } from '../../src/font/scripts/use.js';
registerUseShaping();

const REF = {
  khmr: {
    font: '/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf',
    size: 140296,
    rows: [
      ['ក្ខ', [114, 229]],
      ['ក្ខេ', [179, 114, 229]],
      ['ស្ត្រី', [254, 145, 243, 170]],
      ['កេ', [179, 114]],
      ['កា', [280, 701]],
      ['ខ្មែរ', [180, 115, 252, 140]],
      ['ភាសាខ្មែរ', [303, 701, 311, 701, 180, 115, 252, 140]],
      ['ព្រះ', [254, 136, 185]],
      ['ស្រី', [254, 145, 170]],
      ['ក្រុង', [254, 114, 173, 118]],
      ['អ្នក', [148, 247, 114]],
      ['ញ៉ាំ', [289, 692, 701, 184]],
      ['ក្រេ', [179, 254, 114]],
      ['ក្រ', [254, 114]],
      ['ក្ខ្រ', [424, 114, 229]],
      ['ក្រែ', [180, 254, 114]],
      ['ក្រៅ', [179, 254, 315, 701]],
      ['កើ', [179, 114, 369]],
      ['កឿ', [179, 114, 370]],
      ['កៀ', [179, 114, 371]],
      ['កោ', [179, 280, 701]],
      ['កៅ', [179, 315, 701]],
      ['សួស្តី', [145, 175, 145, 243, 170]],
      ['ប្រទេសកម្ពុជា', [254, 134, 179, 131, 145, 114, 138, 250, 395, 287, 701]],
    ],
  },
  mymr: {
    font: '/System/Library/Fonts/NotoSansMyanmar.ttc',
    size: 1693624,
    rows: [
      ['ကေ', [372, 4]],
      ['ကြ', [198, 4]],
      ['င်္ဂ', [6, 189]],
      ['မြန်မာ', [47, 29, 24, 381, 29, 368]],
      ['ကျွန်ုပ်', [4, 366, 262, 381, 209, 25, 381]],
      ['သင်္ချိုင်း', [34, 5, 189, 382, 369, 210, 8, 381, 379]],
      ['ပြည်', [47, 25, 14, 381]],
      ['ဗမာ', [27, 29, 368]],
      ['မင်္ဂလာပါ', [29, 6, 189, 32, 368, 25, 367]],
      ['စက္ကူ', [9, 4, 211, 361]],
      ['င်္ချိ', [5, 189, 382, 369]],
      ['င်္ခြ', [199, 5, 189]],
      ['င်္ခေ', [372, 5, 189]],
      ['င်္ခု', [5, 189, 209]],
      ['ကြေ', [372, 198, 4]],
      ['မြို့', [199, 29, 369, 399]],
      ['ကျေးဇူး', [372, 4, 382, 379, 11, 360, 379]],
    ],
  },
};

let failures = 0,
  checked = 0;
for (const [script, { font: file, size, rows }] of Object.entries(REF)) {
  if (!existsSync(file) || statSync(file).size !== size) {
    console.log(`skip ${script}: ${file} is missing or not the recorded build`);
    continue;
  }
  const font = new MantleFontAsset(new Uint8Array(readFileSync(file)));
  for (const [text, want] of rows) {
    const got = layoutSlots([{ text, style: defaultStyle() }], font, {}).map((s) => s.glyphId);
    checked++;
    if (got.join() === want.join()) console.log(`ok ${script} ${text} [${got.join('|')}]`);
    else {
      failures++;
      console.error(
        `FAIL: ${script} ${text} shaped [${got.join('|')}], HarfBuzz [${want.join('|')}]`,
      );
    }
  }
}
console.log();
console.log(
  failures
    ? `USE-FEATURE FAIL (${failures} of ${checked})`
    : `USE-FEATURE PASS (${checked} strings${checked ? '' : ', all skipped'})`,
);
process.exit(failures ? 1 : 0);
