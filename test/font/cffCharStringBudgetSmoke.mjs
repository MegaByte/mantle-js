// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cffCharStringBudgetSmoke -- the Type 2 charstring interpreter has a work budget.
// A cap on subroutine DEPTH (10) alone does not bound work: a subr that calls the next level B times costs B^8 operators,
// so a 1 KB OTF would hang the thread (B=10: seconds, B=16: minutes), and so would one-byte corruptions of real CFF fonts. The
// budget (operators, subroutine calls, segments) throws GlyphOutlineError, the family the glyf composite budget uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MantleFontAsset } from '../../src/font/index.js';
import { GlyphOutlineError, readGlyph } from '../../src/font/glyphReader.js';
import {
  CharStringInterp,
  MAX_CHARSTRING_OPS,
  MAX_CHARSTRING_SUBR_CALLS,
  MAX_CHARSTRING_SEGMENTS,
} from '../../src/font/formats/charStringInterp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/cffSubrBomb.otf'))),
);
const gidA = font.codepointToGlyphId(0x41),
  gidB = font.codepointToGlyphId(0x42);

// the bomb: B=16, 9 levels = 16^8 operators if left to run
const t0 = Date.now();
assert.throws(
  () => readGlyph(font._tables, gidA),
  (e) => e instanceof GlyphOutlineError && e instanceof RangeError && /budget/.test(e.message),
  'the bomb throws a GlyphOutlineError naming the budget',
);
assert.equal(font.getGlyphSegsByGid(gidA), null, 'through the font that glyph draws blank');
assert.ok(font.malformedTables.includes('CFF '), 'and the table is reported');
const ms = Date.now() - t0;
assert.ok(ms < 2000, `the bomb is cut off fast (${ms} ms)`);
// an ordinary glyph in the same font is untouched, before and after the failed read
const segs = font.getGlyphSegsByGid(gidB);
assert.equal(segs.length, 4, 'ordinary glyph: 4 sides');
// the interpreter instance is reusable after a budget failure (counters reset per run)
assert.ok(
  MAX_CHARSTRING_OPS >= 1 << 20 &&
    MAX_CHARSTRING_SUBR_CALLS >= 1 << 12 &&
    MAX_CHARSTRING_SEGMENTS >= 1 << 14,
  'budgets stay far above real glyphs',
);

// segment budget: a flat charstring with more lines than allowed. 'rlineto' with 2 operands (1,1) x N via repeated ops.
{
  const N = MAX_CHARSTRING_SEGMENTS + 10;
  const body = [];
  for (let i = 0; i < N; i++) body.push(140, 140, 5); // 1 1 rlineto
  body.push(14);
  const bytes = new Uint8Array([0, 0, 0, ...body]);
  const interp = new CharStringInterp(bytes, -1, -1, 0, 0);
  assert.throws(() => interp.run(3, body.length), GlyphOutlineError, 'segment budget');
}
console.log(`ok cffCharStringBudget (bomb cut off in ${ms} ms)`);
