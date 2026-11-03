// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gsubNestedShiftSmoke.mjs -- SequenceLookupRecords after a nested lookup changes the sequence length.
//
// The records "are processed in order, and each applies to the results of the actions indicated by the preceding record"
// (OpenType, Common Table Formats). A sequence index therefore counts the sequence as it stands, as in HarfBuzz: after a multiple
// substitution its outputs each hold a position, and after a ligature the positions of its components are gone. Expectations are the
// hb-shape output for the fonts of test/fixtures/fonts/genShapingRegressFonts.py. (An index into the ORIGINAL sequence draws wrong
// glyphs in Noto Nastaliq Urdu.)
//
// GL-free (fast node lane).
import { readFileSync } from 'node:fs';
import { MantleFontAsset } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';

const load = (name) =>
  new MantleFontAsset(
    new Uint8Array(readFileSync(new URL(`../fixtures/fonts/${name}`, import.meta.url))),
  );
const shape = (name, text) =>
  _layoutSlotsForTest([{ text, style: { ...defaultStyle() } }], load(name), {})
    .map((s) => s.glyphId)
    .join(' ');
let failures = 0;
const check = (got, want, label) => {
  if (got === want) console.log('ok', label);
  else {
    failures++;
    console.error('FAIL', label, 'got', got, 'want', want);
  }
};
// Glyph order: 1 a, 2 b, 3 c, 4 d, 5 x, 6 y, 7 Y, 8 B, 9 C, 10 lig, 11 Z.
// a b c, records (0, a -> x y), (1, single): position 1 is now y. hb [x|Y|b|c|d]
check(
  shape('shapeNestMulti.ttf', 'abcd'),
  '5 7 2 3 4',
  'after a multiple substitution the next index reaches its second output',
);
// a b c d, records (0, a b -> lig), (2, single), (3, single): position 2 is now d, position 3 no longer exists. hb below.
check(
  shape('shapeNestLiga.ttf', 'abcd'),
  '10 3 11',
  'after a ligature the next index counts past it',
);
if (failures) {
  console.error(`\nGSUB-NESTED-SHIFT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nGSUB-NESTED-SHIFT PASS');
