// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gposValueRecordSmoke -- GPOS value-record fields beyond the x advance, against HarfBuzz.
// Font: test/fixtures/fonts/gposValues.ttf (fontTools, genGposValueFonts.py): SinglePos fmt 1/2, PairPos fmt 1 (both value
// records) and fmt 2, xPlacement / yPlacement / yAdvance, VariationIndex and ppem Device tables, and a mark-to-base whose
// base anchor carries VariationIndex Device tables. Expected values are HarfBuzz's (uharfbuzz), [x_offset, y_offset] and
// cumulative pen position, in font units; HarfBuzz rounds
// every adjustment to an integer, Mantle keeps the fraction, so the tolerance is 1 unit.
//   * placement is an offset of the glyph, the pen is untouched; the first pair glyph's record moves the glyph before it
//   * the second pair record applies to the second glyph (placement, x advance, y advance)
//   * ppem-size Device tables contribute nothing without a ppem (HarfBuzz with no ppem set), and HarfBuzz's pixels*upem/ppem
//     once one is set (GposReader.setDevicePpem)
//   * horizontal text ignores yAdvance; upright vertical text grows the advance (HarfBuzz ttb with kern enabled)
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MantleFontAsset } from '../../src/font/index.js';
import { GposReader } from '../../src/font/gposReader.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';
registerVariableFontReaders();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/gposValues.ttf'))),
);
const lay = (text, wght, extra = {}) =>
  _layoutSlotsForTest([{ text, style: defaultStyle() }], font, { varCoords: { wght }, ...extra });
const ZERO = lay('o', 400)[0]; // a glyph with no adjustments: the baseline of the layout
const U = 1000;
/// [[x_offset, y_offset]...] of the glyphs, in font units, y up, pen = cumulative x advance of the glyphs before
const offsets = (text, wght, extra) => {
  const sl = lay(text, wght, extra);
  return sl.map((s) => [s.penX * U, (ZERO.penY - s.penY) * U]);
};
const near = (got, want, what) => {
  assert.equal(got.length, want.length, `${what}: glyph count`);
  got.forEach((g, i) =>
    assert.ok(
      Math.abs(g[0] - want[i][0]) <= 1.001 && Math.abs(g[1] - want[i][1]) <= 1.001,
      `${what}: glyph ${i} at (${g.map((v) => v.toFixed(2))}), HarfBuzz (${want[i]})`,
    ),
  );
};
// HarfBuzz: [pen x + x_offset, y_offset]; pens by cumulative x_advance (A+mark: the mark has no advance)
near(offsets('A', 400), [[30, -20]], 'SinglePos fmt1 xPla/yPla at wght 400');
near(offsets('B', 400), [[10, 0]], 'SinglePos fmt2 B at 400');
near(offsets('B', 650), [[14, 0]], 'B: VariationIndex xPla +3.5 at 650 (HarfBuzz 14)');
near(offsets('B', 900), [[17, 0]], 'B: VariationIndex xPla +7 at 900');
near(offsets('C', 400), [[0, 5]], 'SinglePos fmt2 C: yPla');
near(
  offsets('VA', 400),
  [
    [12, 8],
    [560 + 21, -16],
  ],
  'PairPos fmt1 at 400: V value1 offsets, A value2 + its SinglePos',
);
near(
  offsets('VA', 900),
  [
    [6, 8],
    [560 + 21, -13],
  ],
  'PairPos fmt1 at 900: VariationIndex on value1 xPla (-6) and value2 yPla (+3)',
);
near(
  offsets('To', 400),
  [
    [20, 0],
    [575, -12],
  ],
  'PairPos fmt2 at 400: xAdv -25, value2 yPla',
);
near(
  offsets('To', 900),
  [
    [20, 0],
    [585, -12],
  ],
  'PairPos fmt2 at 900: xAdv VariationIndex +10',
);
// the second record's x advance lengthens A (the advance after it): 'VAB' puts B after V(560)+A(611)
near(
  offsets('VAB', 400).slice(2),
  [[560 + 611 + 10, 0]],
  'second record x advance moves the next glyph',
);
// mark-to-base: the base anchor's x/y Device tables follow the instance, the base's own offset is inherited
near(
  offsets('A\u20d7', 400),
  [
    [30, -20],
    [600 - 270, 680],
  ],
  'mark on A at 400 (HarfBuzz x_offset -270 after the 600 pen)',
);
near(
  offsets('A⃗', 900),
  [
    [30, -20],
    [600 - 250, 650],
  ],
  'mark on A at 900: anchor deltas +20 / -30',
);
near(
  offsets('A⃗', 650),
  [
    [30, -20],
    [600 - 260, 665],
  ],
  'mark on A at 650',
);

// ppem-size Device tables: nothing without a ppem; HarfBuzz's pixels * upem / ppem once one is set
const withPpem = (ppem, text, wght = 900) => {
  font.gpos.setDevicePpem(ppem);
  try {
    return offsets(text, wght);
  } finally {
    font.gpos.setDevicePpem(0);
  }
};
near(offsets('C', 900), [[0, 5]], 'no ppem: the yPlacement Device table adds nothing');
near(
  offsets('To', 900),
  [
    [20, 0],
    [585, -12],
  ],
  'no ppem: the xPlacement Device table adds nothing',
);
near(withPpem(14, 'C'), [[0, 147]], 'ppem 14: yPla Device +2 px = +142.9 units (HarfBuzz 147)');
near(withPpem(12, 'C'), [[0, -78]], 'ppem 12: -1 px = -83.3 units (HarfBuzz -78)');
near(withPpem(16, 'C'), [[0, 5]], 'ppem 16: pixel delta 0');
near(withPpem(10, 'C'), [[0, 5]], 'ppem 10: outside the table (12..16)');
near(
  withPpem(11, 'To'),
  [
    [-70, 0],
    [585, -12],
  ],
  'ppem 11: xPla Device -1 px = -90.9 units (HarfBuzz -70)',
);
near(
  withPpem(12, 'To'),
  [
    [270, 0],
    [585, -12],
  ],
  'ppem 12: xPla Device +3 px = +250 units (HarfBuzz 270)',
);
near(
  withPpem(10, 'To'),
  [
    [220, 0],
    [585, -12],
  ],
  'ppem 10: xPla Device +2 px = +200 units (HarfBuzz 220)',
);
assert.equal(font.gpos._devPpem, 0, 'the ppem is restored');

// vertical: horizontal text ignores yAdvance (A's +15, V's +6)
{
  const h = lay('AA', 400),
    h0 = lay('oo', 400);
  assert.ok(
    Math.abs(h[1].penX - h[0].penX - (h0[1].penX - h0[0].penX)) < 1e-9,
    'horizontal: yAdvance does not touch the x pen',
  );
  const up = (t) => lay(t, 400, { inlineVertical: 'upright' });
  const a = up('A'),
    c = up('C'),
    o = up('o');
  // HarfBuzz ttb with kern enabled: y_advance -1015 for A (SinglePos yAdv +15), -1008 for C (+8), -1000 plain
  assert.ok(
    Math.abs((a[0].advance - o[0].advance) * U - 15) < 1e-6,
    `upright A advance +15 (got ${(a[0].advance - o[0].advance) * U})`,
  );
  assert.ok(Math.abs((c[0].advance - o[0].advance) * U - 8) < 1e-6, 'upright C advance +8');
  assert.ok(
    Math.abs((up('VA')[1].advance - o[0].advance) * U - 12) < 1e-6,
    'upright VA: A gets SinglePos +15 and the pair second record -3',
  );
  // HarfBuzz applies no x kerning in a vertical run: the second glyph sits one advance after the first
  const to = up('To');
  assert.ok(
    Math.abs(to[1].penX - up('oo')[1].penX) < 1e-9,
    'upright To: the x kern does not move the flow (second glyph at ' + to[1].penX + ')',
  );
  const hTo = lay('To', 400),
    hOo = lay('oo', 400);
  assert.ok(Math.abs(hTo[1].penX - hOo[1].penX) > 1e-6, 'horizontal To is still kerned (control)');
  // mixed: a sideways pair keeps its kerning
  const mixedTo = lay('To', 400, { inlineVertical: 'mixed' });
  assert.ok(
    Math.abs(mixedTo[1].penX - lay('oo', 400, { inlineVertical: 'mixed' })[1].penX) > 1e-6,
    'mixed: a sideways Latin pair is still kerned',
  );
}
// A pair whose PairPos declares a second value record consumes the second glyph (HarfBuzz): that glyph starts no pair in the same lookup.
// The fixture has no such chain, so the pair lookup is stubbed on the real font: every (o, o) pair kerns -50 units, with and without a
// second record. Without one a run of three kerns twice; with one the second pair is consumed, so it kerns once.
{
  // (on the class, since a layout pass reads the reader itself and not the guard `font.gpos` answers with)
  const reader = GposReader.prototype;
  const saved = [
    reader.getPairValues,
    reader.hasPositionValues,
    font.getPairKerningFu,
    font.hasAnyKerning,
  ];
  let second = false;
  reader.getPairValues = () => {
    const v = new Float64Array(9);
    v[2] = -50;
    v[8] = second ? 1 : 0;
    return v;
  };
  reader.hasPositionValues = () => true;
  font.getPairKerningFu = () => -50;
  try {
    Object.defineProperty(font, 'hasAnyKerning', { value: true, configurable: true });
    const plain = lay('ooo', 400),
      pair = (flag) => {
        second = flag;
        const l = lay('ooo', 400);
        return l[2].penX - 2 * l[0].advance;
      };
    const free = pair(false),
      consumed = pair(true);
    assert.ok(
      Math.abs(free - (2 * -50) / U) < 1e-9,
      'two pairs kern twice without a second record (got ' + free * U + ')',
    );
    assert.ok(
      Math.abs(consumed - -50 / U) < 1e-9,
      'a pair with a second value record consumes the second glyph: one kern (got ' +
        consumed * U +
        ')',
    );
    void plain;
  } finally {
    reader.getPairValues = saved[0];
    reader.hasPositionValues = saved[1];
    font.getPairKerningFu = saved[2];
    delete font.hasAnyKerning;
  }
}
console.log('ok gposValueRecord');
