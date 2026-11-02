// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aatPreferSmoke -- a font with both AAT (morx, kerx) and OpenType (GSUB, GPOS) data is shaped by the AAT tables by default
// (`preferAat`, default true); `preferAat: false` keeps GSUB/GPOS; `compat: 'harfbuzz'` always prefers AAT.
// Fixture test/fixtures/fonts/aatPrefer.ttf (genAatPreferFont.py): glyphs 1 a, 2 b, 3 a.gsub, 4 a.morx, advance 600;
// GSUB liga a -> a.gsub, morx a -> a.morx; GPOS kern b b -100, kerx b b -200.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { layoutSlots } from '../../src/font/textLayout.js';
import { layoutFromStyle } from '../../src/font/textSections.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync(new URL('../fixtures/fonts/aatPrefer.ttf', import.meta.url))),
);
assert.ok(
  font.morx.hasMorx && font.kerx.hasKerx && font.gsub.hasTable && font.gpos.hasTable,
  'fixture carries all four tables',
);
const run = (text, opts) =>
  layoutSlots([{ text, style: defaultStyle() }], font, opts).filter((s) => !s.isDirective);
const gl = (text, opts) => run(text, opts).map((s) => s.glyphId);
const pen2 = (opts) => Math.round(run('bb', opts)[1].penX * 1000);

assert.deepEqual(gl('a', {}), [4], 'default: morx');
assert.deepEqual(gl('a', { preferAat: true }), [4]);
assert.deepEqual(gl('a', { preferAat: false }), [3], 'preferAat:false: GSUB');
assert.deepEqual(gl('a', { compat: 'harfbuzz' }), [4], 'harfbuzz: morx');
assert.deepEqual(
  gl('a', { compat: 'harfbuzz', preferAat: false }),
  [4],
  'harfbuzz always prefers AAT',
);
assert.equal(pen2({}), 400, 'default: kerx -200');
assert.equal(pen2({ preferAat: false }), 500, 'preferAat:false: GPOS -100');
assert.equal(pen2({ compat: 'harfbuzz' }), 400, 'harfbuzz: kerx');
assert.equal(
  layoutFromStyle({ fontSizePx: 16, preferAat: false }).preferAat,
  false,
  'style.preferAat reaches the layout',
);
assert.ok(!('preferAat' in layoutFromStyle({ fontSizePx: 16 })), 'unset stays unset');
assert.equal(
  layoutFromStyle({ fontSizePx: 16, useJstf: false }).useJstf,
  false,
  'style.useJstf reaches the layout',
);

// Actual mixed-table fonts: GPOS value records must not leak into the selected kerx route.
const positionFont = (name) =>
  new MantleFontAsset(
    new Uint8Array(readFileSync(new URL('../fixtures/fonts/' + name + '.ttf', import.meta.url))),
  );
const positioned = positionFont('aatPosition'),
  noMorx = positionFont('aatPositionNoMorx');
assert.ok(
  positioned.hasAatSubstitution &&
    positioned.kerx.hasKerx &&
    positioned.gpos.hasPositionValues(false),
);
assert.ok(
  !noMorx.hasAatSubstitution && noMorx.kerx.hasKerx && noMorx.gsub.hasTable && noMorx.gpos.hasTable,
);
const positionSlots = (f, text, options = {}) =>
  layoutSlots([{ text, style: defaultStyle() }], f, options).filter((s) => !s.isDirective);
const xy = (slots) => slots.map((s) => [Math.round(s.penX * 1000), Math.round(s.penY * 1000)]);
assert.deepEqual(xy(positionSlots(positioned, 'b')), [[0, 0]], 'AAT excludes GPOS SinglePos');
assert.deepEqual(
  xy(positionSlots(positioned, 'bb', { compat: 'harfbuzz' })),
  [
    [0, 0],
    [400, 0],
  ],
  'AAT excludes both PairPos placements',
);
assert.deepEqual(
  xy(positionSlots(positioned, 'bb', { preferAat: false })),
  [
    [40, -50],
    [600, -75],
  ],
  'explicit OpenType preserves both value records',
);
assert.deepEqual(
  xy(positionSlots(noMorx, 'bb', { compat: 'harfbuzz' })),
  [
    [40, -50],
    [600, -75],
  ],
  'HarfBuzz keeps GPOS with GSUB and no morx',
);
assert.deepEqual(
  xy(positionSlots(noMorx, 'bb')),
  [
    [0, 0],
    [400, 0],
  ],
  'default explicitly prefers kerx',
);
assert.deepEqual(
  xy(positionSlots(positioned, 'bb', { disabledFeatures: ['kern'] })),
  [
    [0, 0],
    [600, 0],
  ],
  'disabled kerning does not enable GPOS',
);
const context1 = positionFont('aatContext1'),
  context4 = positionFont('aatContext4');
assert.ok(context1.kerx.hasContextualKerning && context4.kerx.hasContextualKerning);
assert.deepEqual(
  xy(positionSlots(context1, 'ab', { compat: 'harfbuzz' })),
  [
    [-150, 0],
    [450, 0],
  ],
  'contextual kerning is active',
);
assert.deepEqual(
  xy(positionSlots(context1, 'ab', { compat: 'harfbuzz', disabledFeatures: ['kern'] })),
  [
    [0, 0],
    [600, 0],
  ],
  'disabled kern excludes contextual format1',
);
assert.deepEqual(
  xy(positionSlots(context4, 'ab', { compat: 'harfbuzz', disabledFeatures: ['kern'] })),
  [
    [0, 0],
    [300, -100],
  ],
  'disabled kern preserves format4 attachment',
);

const legacyContext = positionFont('aatLegacyContext');
assert.ok(!legacyContext.kerx.hasKerx && legacyContext.legacyKern.hasStateKerning);
assert.deepEqual(
  xy(positionSlots(legacyContext, 'ab', { compat: 'harfbuzz' })),
  [
    [-150, 0],
    [450, 0],
  ],
  'legacy contextual kerning is active',
);
assert.deepEqual(
  xy(positionSlots(legacyContext, 'ab', { compat: 'harfbuzz', disabledFeatures: ['kern'] })),
  [
    [0, 0],
    [600, 0],
  ],
  'disabled kern excludes legacy contextual adjustment',
);

console.log('ok aatPrefer');
