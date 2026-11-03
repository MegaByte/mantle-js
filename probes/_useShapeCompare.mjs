// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _useShapeCompare — Mantle's glyph ids for Khmer and Myanmar text against HarfBuzz's on the same system font.
//
// The reference is a JSON file of { script: { font, size, rows: [[text, [gid...]]] } } written by uharfbuzz (see the
// release status doc, #50). Usage: HBREF=/path/hbref.json node probes/_useShapeCompare.mjs
import { readFileSync, statSync } from 'fs';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { layoutSlots } from '../src/font/textLayout.js';
import { defaultStyle } from '../src/font/markupParser.js';
import { registerUseShaping } from '../src/font/scripts/use.js';
registerUseShaping();
const ref = JSON.parse(readFileSync(process.env.HBREF, 'utf8'));
let match = 0,
  total = 0;
for (const [tag, { font: file, size, rows }] of Object.entries(ref)) {
  if (statSync(file).size !== size) {
    console.log(`${tag}: font changed (${file}), skipped`);
    continue;
  }
  const font = new MantleFontAsset(new Uint8Array(readFileSync(file)));
  for (const [text, want] of rows) {
    const got = layoutSlots([{ text, style: defaultStyle() }], font, {}).map((s) => s.glyphId);
    const same = got.length === want.length && got.every((g, i) => g === want[i]);
    total++;
    if (same) match++;
    console.log(
      `${same ? 'same' : 'DIFF'} ${tag} ${text.padEnd(10)} mantle [${got.join('|')}]  harfbuzz [${want.join('|')}]`,
    );
  }
}
console.log(`\n${match} of ${total} strings shape to HarfBuzz's glyph ids`);
