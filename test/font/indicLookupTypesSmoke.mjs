// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicLookupTypesSmoke — the Indic GSUB dispatch applies every lookup type.
//
// A per-syllable dispatch that hand-rolls its own walk and reaches lookup
// types 1 and 4 only substitutes nothing for features encoded in chaining
// context (type 6), which is how most fonts encode 'pres' and 'psts':
// Devanagari Sangam MN, Kannada, Tamil, Telugu, Gujarati, Oriya, Sinhala and
// Arial Unicode all put 'psts' in a type-6 lookup, and Kannada's 'half' and
// Tamil's 'rphf' live there alone. The dispatch runs applyFeatureToSeqTracked, the same engine the USE pass uses, which covers
// types 1-8 and reports which input glyph each output came from.
//
// Part A pins each lookup type through the dispatch on a synthesized font, so
// the coverage does not depend on which fonts a machine has. Part B is
// recorded HarfBuzz glyph ids for real strings in real fonts: hb-shape 14.4.0
// and uharfbuzz 14.2.1 shaped every row and only rows they agreed on were
// kept. Each font is recorded with its byte size, so a machine with a
// different build of a font skips it rather than failing — glyph ids belong
// to one build of one font.
//
// GAPS holds rows HarfBuzz and Mantle still disagree on. None of them is a
// lookup type, and they fail nothing here. The base search asks the font (see
// indicShaper.js) and the dispatch masks half/blwf/abvf/pstf/pref/rphf against
// the base it returns, and the reph decision asks the font, not only the
// codepoints, so those rows are in REF.
//
// The three in GAPS are each a DIFFERENT missing step, not the base:
// Unicode decomposition of a nukta-composed consonant (Oriya), the final
// reordering that places a below-base form after a following matra
// (Kannada), and old-spec (OpenType v1) Indic, where the font registers
// 'deva' rather than 'dev2' and the halant is written after the consonant
// (Arial Unicode). Each row says which.
import { readFileSync, statSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { layoutSlots } from '../../src/font/textLayout.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerIndicShaping } from '../../src/font/scripts/indic.js';
registerIndicShaping();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);
const shape = (font, text) =>
  layoutSlots([{ text, style: defaultStyle() }], font, {}).map((s) => s.glyphId);

// =====================================================================
// Part A — synthesized Devanagari font, one lookup type per feature.
// =====================================================================

import { buildIndicGsubFont, CP, GID } from './_indicGsubFixture.mjs';

{
  const font = new MantleFontAsset(buildIndicGsubFont());
  const str = (...names) => names.map((n) => String.fromCodePoint(CP[n])).join('');
  // [label, text, expected gids]. Each case's context is disjoint from
  // every other's, so a case can only pass by its own lookup firing.
  const CASES = [
    ['type 6 format 3, post-reorder (psts)', str('KA', 'AA'), [GID.KA, 20]],
    // The pre-base matra reorder puts I first; the chain rule matches it
    // there, so this also pins that features run AFTER the reorder.
    ['type 6 format 1, post-reorder (pres)', str('KA', 'I'), [21, GID.KA]],
    ['type 5 format 3, post-reorder (blws)', str('TA', 'VIRAMA', 'YA'), [GID.TA, GID.VIRAMA, 22]],
    ['type 2 multiple, post-reorder (abvs)', str('NA'), [25, 26]],
    ['type 3 alternate, post-reorder (haln)', str('SSA'), [27]],
    ['type 6 format 3, pre-reorder (half)', str('MA', 'VIRAMA', 'KA'), [28, GID.VIRAMA, GID.KA]],
    [
      'type 8 reverse chain, pre-reorder (cjct)',
      str('KA', 'VIRAMA', 'RA'),
      [GID.KA, GID.VIRAMA, 30],
    ],
    // ...and the same lookup type under 'blwf' does NOT fire, which is not
    // a gap in the dispatch. A below-base form is claimed with a two-glyph
    // would-substitute probe; a reverse chain replaces one glyph and so
    // answers no; the consonant is therefore the base, and 'blwf' belongs
    // to the glyphs AFTER the base. hb-shape 14.4.0 on this same font
    // leaves it unsubstituted too.
    [
      'type 8 under blwf is masked off (matches HarfBuzz)',
      str('KA', 'VIRAMA', 'TA'),
      [GID.KA, GID.VIRAMA, GID.TA],
    ],
  ];
  for (const [label, text, want] of CASES) {
    const got = shape(font, text);
    if (got.join() === want.join()) ok(`A ${label}`);
    else fail(`A ${label}: [${got}] want [${want}]`);
  }
}

// =====================================================================
// Part B — recorded HarfBuzz glyph ids on macOS system fonts.
// =====================================================================

const REF = [
  {
    script: 'Devanagari',
    font: '/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc',
    size: 1021020,
    rows: [
      ['\u0939\u093f\u0928\u094d\u0926\u0940', [1292, 172, 957, 1221]], // हिन्दी
      ['\u092d\u093e\u0930\u0924', [160, 175, 163, 151]], // भारत
      ['\u0915\u094d\u0937', [391]], // क्ष
      ['\u0926\u094d\u0935\u093e\u0930', [312, 175, 163]], // द्वार
      ['\u092a\u094d\u0930\u0947\u092e', [339, 1283, 161]], // प्रेम
      ['\u0935\u093f\u0926\u094d\u092f\u093e', [1293, 168, 413, 175]], // विद्या
      ['\u0936\u094d\u0930\u0940', [406, 1220]], // श्री
      ['\u0930\u094d\u0915', [136, 1257]], // र्क
      ['\u0915\u094d\u0915', [854]], // क्क
      ['\u092a\u094d\u0930', [339]], // प्र
    ],
  },
  {
    script: 'Devanagari(ITF)',
    font: '/System/Library/Fonts/Supplemental/ITFDevanagari.ttc',
    size: 800948,
    rows: [
      ['\u0939\u093f\u0928\u094d\u0926\u0940', [776, 83, 573, 29]], // हिन्दी
      ['\u092d\u093e\u0930\u0924', [74, 27, 77, 66]], // भारत
      ['\u0915\u094d\u0937', [85]], // क्ष
      ['\u0926\u094d\u0935\u093e\u0930', [553, 27, 77]], // द्वार
      ['\u092a\u094d\u0930\u0947\u092e', [254, 36, 75]], // प्रेम
      ['\u0935\u093f\u0926\u094d\u092f\u093e', [777, 79, 552, 27]], // विद्या
      ['\u0936\u094d\u0930\u0940', [262, 29]], // श्री
      ['\u0930\u094d\u0915', [51, 161]], // र्क
    ],
  },
  {
    script: 'Bengali',
    font: '/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc',
    size: 435872,
    rows: [
      ['\u09ac\u09be\u0982\u09b2\u09be', [155, 167, 119, 160, 167]], // বাংলা
      ['\u0995\u09cd\u09b7', [212]], // ক্ষ
      ['\u0995\u09c3\u09b7\u09cd\u09a3', [133, 172, 533]], // কৃষ্ণ
      ['\u09b0\u09cd\u0995', [133, 216]], // র্ক
      ['\u0995\u09cd\u09b0', [319]], // ক্র
      ['\u09a4\u09cd\u09b0', [330]], // ত্র
      ['\u09aa\u09cd\u09b0\u09c7\u09ae', [214, 335, 157]], // প্রেম
      // 'half' unmasked would take the cluster before 'pstf'. The base search
      // puts the base on the da, which withholds 'half' from it and leaves
      // 'pstf' to the ya.
      ['\u09ac\u09bf\u09a6\u09cd\u09af\u09be', [168, 155, 150, 218, 167]], // বিদ্যা
    ],
  },
  {
    script: 'Gujarati',
    font: '/System/Library/Fonts/Supplemental/Gujarati Sangam MN.ttc',
    size: 541436,
    rows: [
      ['\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0', [808, 171, 139, 158, 168, 147, 170]], // ગુજરાતી
      ['\u0a95\u0acd\u0ab7', [213]], // ક્ષ
      ['\u0ab5\u0abf\u0aa6\u0acd\u0aaf\u0abe', [749, 161, 307, 168]], // વિદ્યા
      ['\u0ab0\u0acd\u0a95', [132, 200]], // ર્ક
      ['\u0aaa\u0acd\u0ab0\u0ac7\u0aae', [331, 176, 156]], // પ્રેમ
      ['\u0a95\u0acd\u0a95', [202]], // ક્ક
    ],
  },
  {
    script: 'Gurmukhi',
    font: '/System/Library/Fonts/Supplemental/Gurmukhi Sangam MN.ttc',
    size: 139016,
    rows: [
      ['\u0a2a\u0a70\u0a1c\u0a3e\u0a2c\u0a40', [150, 225, 137, 164, 152, 166]], // ਪੰਜਾਬੀ
      ['\u0a38\u0a4d\u0a30\u0a40', [203, 166]], // ਸ੍ਰੀ
      ['\u0a17\u0a41\u0a30\u0a2e\u0a41\u0a16\u0a40', [132, 221, 156, 154, 221, 131, 166]], // ਗੁਰਮੁਖੀ
      ['\u0a15\u0a4d\u0a30', [198]], // ਕ੍ਰ
      ['\u0a30\u0a4d\u0a15', [340, 130]], // ਰ੍ਕ — no 'rphf' in this font, so no reph reorder
    ],
  },
  {
    script: 'Oriya',
    font: '/System/Library/Fonts/Supplemental/Oriya Sangam MN.ttc',
    size: 181016,
    rows: [
      ['\u0b13\u0b21\u0b3c\u0b3f\u0b06', [129, 181, 168, 120]], // ଓଡ଼ିଆ
      ['\u0b15\u0b4d\u0b37', [208]], // କ୍ଷ
      ['\u0b30\u0b4d\u0b15', [131, 210]], // ର୍କ
      ['\u0b15\u0b4d\u0b30', [319]], // କ୍ର
    ],
  },
  {
    script: 'Tamil',
    font: '/System/Library/Fonts/Supplemental/Tamil Sangam MN.ttc',
    size: 349356,
    rows: [
      ['\u0ba4\u0bae\u0bbf\u0bb4\u0bcd', [452, 543, 475]], // தமிழ்
      ['\u0b95\u0bcd\u0bb7', [490]], // க்ஷ
      ['\u0bb8\u0bcd\u0bb0\u0bc0', [579]], // ஸ்ரீ
      ['\u0b95\u0bcd\u0b95', [488, 445]], // க்க
      ['\u0bb5\u0bbf\u0b9f\u0bcd\u0b9f\u0bae\u0bcd', [574, 597, 450, 476]], // விட்டம்
    ],
  },
  {
    script: 'Telugu',
    font: '/System/Library/Fonts/Supplemental/Telugu Sangam MN.ttc',
    size: 303008,
    rows: [
      ['\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41', [420, 660, 638]], // తెలుగు
      ['\u0c15\u0c4d\u0c37', [211]], // క్ష
      ['\u0c35\u0c3f\u0c26\u0c4d\u0c2f', [357, 151, 238]], // విద్య
      ['\u0c15\u0c4d\u0c15', [134, 213]], // క్క
      ['\u0c2a\u0c4d\u0c30', [154, 239]], // ప్ర
    ],
  },
  {
    script: 'Kannada',
    font: '/System/Library/Fonts/Supplemental/Kannada Sangam MN.ttc',
    size: 292540,
    rows: [
      ['\u0c95\u0ca8\u0ccd\u0ca8\u0ca1', [135, 154, 265, 147]], // ಕನ್ನಡ
      ['\u0c95\u0ccd\u0cb7', [205]], // ಕ್ಷ
      ['\u0c95\u0ccd\u0c95', [135, 246]], // ಕ್ಕ
      ['\u0caa\u0ccd\u0cb0', [155, 272]], // ಪ್ರ
    ],
  },
  {
    script: 'Sinhala',
    font: '/System/Library/Fonts/Supplemental/Sinhala Sangam MN.ttc',
    size: 752820,
    rows: [
      ['\u0dc3\u0dd2\u0d82\u0dc4\u0dbd', [374, 180, 147, 142]], // සිංහල
      ['\u0d9a\u0dca\u0dc2', [247, 145]], // ක්ෂ
      // Sinhala's ZWJ joins where Devanagari's blocks, and its base
      // search is its own — a forward walk that stops at a ZWJ-preceded
      // consonant. The cluster also has to survive the ZWJ to reach 'vatu'.
      ['\u0dc1\u0dca\u200d\u0dbb\u0dd3', [499]], // ශ්‍රී
    ],
  },
  {
    script: 'Malayalam(ArialUni)',
    font: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    size: 23278008,
    rows: [
      ['\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02', [2066, 2070, 2067, 2078, 2071, 2026]], // മലയാളം
      ['\u0d15\u0d4d\u0d37', [2042, 2090, 2075]], // ക്ഷ
      ['\u0d35\u0d3f\u0d26\u0d4d\u0d2f', [2073, 2079, 2059, 2090, 2067]], // വിദ്യ
      ['\u0d15\u0d4d\u0d15', [2042, 2090, 2042]], // ക്ക
      ['\u0d28\u0d4d\u0d24', [2061, 2090, 2057]], // ന്ത
    ],
  },
  {
    script: 'Devanagari(ArialUni)',
    font: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    size: 23278008,
    rows: [
      ['\u0939\u093f\u0928\u094d\u0926\u0940', [1439, 1435, 7008, 1416, 1440]], // हिन्दी
      ['\u0915\u094d\u0937', [6979]], // क्ष
      ['\u092d\u093e\u0930\u0924', [1423, 1438, 1426, 1414]], // भारत
      ['\u0926\u094d\u0935\u093e\u0930', [7367, 1438, 1426]], // द्वार
    ],
  },
  {
    script: 'Tamil(ArialUni)',
    font: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    size: 23278008,
    rows: [
      ['\u0ba4\u0bae\u0bbf\u0bb4\u0bcd', [1826, 1830, 1842, 8129]], // தமிழ்
      ['\u0b95\u0bcd\u0bb7', [8064]], // க்ஷ
      ['\u0bb8\u0bcd\u0bb0\u0bc0', [8111]], // ஸ்ரீ
    ],
  },
];

// Rows HarfBuzz and Mantle still disagree on, for the three missing steps
// named in the header. They report, they do not fail — and if one starts
// matching, the line says to move it up into REF.
const GAPS = [
  {
    script: 'Oriya',
    font: '/System/Library/Fonts/Supplemental/Oriya Sangam MN.ttc',
    size: 181016,
    rows: [
      ['\u0b2c\u0b3f\u0b26\u0b4d\u0b5f\u0b3e', [153, 168, 148, 232, 167]], // ବିଦ୍ୟା — NOT the base: U+0B5F YYA stays composed here, and the font's below-base form is keyed on YA + NUKTA. Spelled decomposed, this row already matches
    ],
  },
  {
    script: 'Kannada',
    font: '/System/Library/Fonts/Supplemental/Kannada Sangam MN.ttc',
    size: 292540,
    rows: [
      ['\u0cb5\u0cbf\u0ca6\u0ccd\u0caf\u0cbe', [351, 561, 300, 528, 271]], // ವಿದ್ಯಾ — NOT the base: same glyphs, different ORDER. HarfBuzz's final reordering puts the below-base ya after the aa matra; there is no final reordering pass here
    ],
  },
  {
    script: 'Devanagari(ArialUni)',
    font: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    size: 23278008,
    rows: [
      ['\u092a\u094d\u0930\u0947\u092e', [7079, 1447, 1424]], // प्रेम — NOT the base: Arial Unicode registers 'deva' and 'taml' only, so it is an old-spec (v1) font, where the halant is written AFTER the consonant and has to be moved there before the basic substitutions run
    ],
  },
];

let checked = 0,
  skipped = 0;
const load = ({ font: file, size }) => {
  if (!existsSync(file) || statSync(file).size !== size) return null;
  return new MantleFontAsset(new Uint8Array(readFileSync(file)));
};

for (const group of REF) {
  const font = load(group);
  if (!font) {
    skipped += group.rows.length;
    console.log(`skip ${group.script}: missing or not the recorded build`);
    continue;
  }
  let same = 0;
  for (const [text, want] of group.rows) {
    checked++;
    const got = shape(font, text);
    if (got.join() === want.join()) same++;
    else fail(`B ${group.script} ${text}: shaped [${got.join('|')}], HarfBuzz [${want.join('|')}]`);
  }
  if (same === group.rows.length)
    ok(`B ${group.script}: ${same}/${group.rows.length} match HarfBuzz`);
}

for (const group of GAPS) {
  const font = load(group);
  if (!font) continue;
  for (const [text, want] of group.rows) {
    const got = shape(font, text);
    if (got.join() === want.join())
      console.log(`gap closed: ${group.script} ${text} now matches HarfBuzz — move it into REF`);
    else
      console.log(
        `known gap: ${group.script} ${text} shaped [${got.join('|')}], HarfBuzz [${want.join('|')}]`,
      );
  }
}

console.log();
console.log(
  failures
    ? `INDIC-LOOKUP-TYPES FAIL (${failures})`
    : `INDIC-LOOKUP-TYPES PASS (${checked} HarfBuzz rows, ${skipped} skipped)`,
);
process.exit(failures ? 1 : 0);
