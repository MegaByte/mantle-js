// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gposVariationIndexSmoke -- GPOS value records carry VariationIndex device tables (deltaFormat 0x8000)
// into GDEF 1.3's ItemVariationStore; pair kerning and SinglePos advances must follow the active variation instance.
// With the base x advance only, a variable font kerns like its default master at every weight (on SF Pro at
// wght=700, hundreds of pairs off HarfBuzz, up to 130 font units).
// Font: test/fixtures/fonts/gposVarKern.ttf (fontTools, genGposVarFont.py). Expected widths are HarfBuzz's
// (uharfbuzz, `HB=1 python3 genGposVarFont.py out.ttf`), in 1/1000 em. HarfBuzz rounds every adjustment to an integer
// font unit; Mantle keeps the fraction, so a half-unit delta (wght=650) may differ from it by up to half a unit.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MantleFontAsset, measureText } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
registerVariableFontReaders();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/gposVarKern.ttf'))),
);
const width = (text, varCoords) =>
  measureText([{ text, style: defaultStyle() }], font, varCoords ? { varCoords } : {}).width * 1000;

const hb = {
  400: { AV: 1150, To: 1190, o: 610, AVTo: 2340 },
  650: { AV: 1135, To: 1213, o: 613, AVTo: 2348 },
  900: { AV: 1120, To: 1235, o: 615, AVTo: 2355 },
};
for (const w of [400, 650, 900])
  for (const [s, expect] of Object.entries(hb[w])) {
    const got = width(s, { wght: w });
    assert.ok(
      Math.abs(got - expect) <= 0.5 + 1e-9,
      `"${s}" at wght=${w}: ${got} font units, HarfBuzz ${expect}`,
    );
  }
for (const [s, expect] of Object.entries(hb[400]))
  assert.ok(
    Math.abs(width(s, null) - expect) < 1e-6,
    `default instance "${s}" ${width(s, null)} vs ${expect}`,
  );
// A different instance after the first one must not leave stale deltas behind.
assert.ok(
  Math.abs(width('AV', { wght: 900 }) - 1120) < 1e-6 &&
    Math.abs(width('AV', { wght: 400 }) - 1150) < 1e-6,
  'instances switch cleanly',
);
console.log('ok gposVariationIndex');
