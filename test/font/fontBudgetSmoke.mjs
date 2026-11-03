// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fontBudgetSmoke -- fonts small enough to send in a request that ask for unbounded work. Each case either hung the thread or
// exhausted the heap (an abort nothing can catch) and must now finish: with a sensible result where one exists, else a
// GlyphOutlineError, the family the glyf and CFF budgets throw. A regression here hangs, and the lane's per-step cap reports it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MantleFontAsset } from '../../src/font/index.js';
import { GlyphOutlineError } from '../../src/font/glyphReader.js';
import { colrPaintToGraph } from '../../src/font/color/colrPaintToGraph.js';
import { ColrReader } from '../../src/font/color/colrReader.js';
import { MathReader, MAX_ASSEMBLY_PARTS } from '../../src/font/math/mathReader.js';
import { MAX_SHAPED_GLYPHS } from '../../src/font/gsubReader.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';

const bytesOf = (name) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/fonts/${name}`, import.meta.url)));
const font = (name) => new MantleFontAsset(bytesOf(name));
const layout = (f, text) => _layoutSlotsForTest([{ text, style: { ...defaultStyle() } }], f, {});
const tableOf = (bytes, tag) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < v.getUint16(4); i++) {
    const r = 12 + i * 16;
    if (String.fromCharCode(...bytes.subarray(r, r + 4)) === tag)
      return { v, off: v.getUint32(r + 8) };
  }
  throw new Error(`no ${tag} table in the fixture`);
};

// GSUB: a context lookup that names itself, 64 records a level. hb-shape: the glyphs unchanged.
assert.equal(
  layout(font('shapeBombRecurse.ttf'), 'aaaa').length,
  4,
  'self-recursive context lookup',
);
console.log('ok GSUB recursion');

// GSUB: 2000 records, each a multiple substitution by 400.
{
  const n = layout(font('shapeBombGrow.ttf'), 'a').length;
  assert.ok(n > 1 && n <= MAX_SHAPED_GLYPHS, `growth stops (${n} glyphs)`);
  console.log('ok GSUB growth', n);
}

// AAT: a subtable of length 0 repeated 2^32 times. The chain is dropped from there on.
{
  const bytes = bytesOf('aatPrefer.ttf');
  const { v, off } = tableOf(bytes, 'morx');
  const chain = off + 8;
  v.setUint32(chain + 12, 0xfffffff0);
  v.setUint32(chain + 16 + v.getUint32(chain + 8) * 12, 0);
  assert.equal(layout(new MantleFontAsset(bytes), 'ab').length, 2, 'zero-length morx subtable');
  console.log('ok morx walk');
}
{
  const bytes = bytesOf('aatPrefer.ttf');
  const { v, off } = tableOf(bytes, 'kerx');
  v.setUint32(off + 4, 0xfffffff0);
  v.setUint32(off + 8, 0);
  assert.equal(layout(new MantleFontAsset(bytes), 'ab').length, 2, 'zero-length kerx subtable');
  console.log('ok kerx walk');
}

// COLRv1: 40 levels of PaintComposite sharing one child, 2^40 edges in 320 bytes.
{
  const f = font('colrPaintBomb.ttf');
  const gid = f.codepointToGlyphId(0x61);
  assert.throws(
    () => new ColrReader(f._tables).getPaint(gid),
    GlyphOutlineError,
    'shared paint children',
  );
  assert.equal(f.getColrV1GraphByGid(gid), null, 'through the font the table is dropped');
  assert.ok(f.malformedTables.includes('COLR') && !f.hasColrV1, 'and the font goes on without it');
  console.log('ok COLR paint tree');
}
// PaintColrGlyph: glyphs that each paint the next one twice (no cycle). A stand-in reader: only the graph converter is under test.
{
  const reader = {
    getPaint: (gid) =>
      gid < 30
        ? {
            format: 32,
            mode: 3,
            src: { format: 11, glyphId: gid + 1 },
            dst: { format: 11, glyphId: gid + 1 },
          }
        : { format: 2, paletteIndex: 0, alpha: 1 },
  };
  assert.throws(
    () => colrPaintToGraph({ format: 11, glyphId: 1 }, reader),
    GlyphOutlineError,
    'shared glyph references',
  );
  console.log('ok COLR glyph references');
}
// PaintColrGlyph within reach still converts.
{
  const reader = {
    getPaint: (gid) =>
      gid < 6
        ? {
            format: 32,
            mode: 3,
            src: { format: 11, glyphId: gid + 1 },
            dst: { format: 11, glyphId: gid + 1 },
          }
        : { format: 2, paletteIndex: 0, alpha: 1 },
  };
  const g = colrPaintToGraph({ format: 11, glyphId: 1 }, reader);
  assert.ok(g.nodes.length > 60, 'an ordinary shared paint');
}

// MATH: an assembly of 1000 extender entries repeated once per unit of a tall target. A stand-in reader for the table lookups.
{
  const parts = Array.from({ length: 1000 }, () => ({
    glyphID: 1,
    startConn: 0,
    endConn: 0,
    fullAdvance: 1,
    isExtender: true,
  }));
  const stub = {
    getMathVariants: () => ({ assembly: { parts } }),
    _view: new DataView(new ArrayBuffer(2)),
    _mathVariantsOff: 0,
  };
  assert.equal(
    MathReader.prototype.buildAssembly.call(stub, 1, 130000, 'v'),
    null,
    'too many pieces',
  );
  const few = Array.from({ length: 3 }, (_, i) => ({
    glyphID: i,
    startConn: 0,
    endConn: 0,
    fullAdvance: 100,
    isExtender: i === 1,
  }));
  const asm = MathReader.prototype.buildAssembly.call(
    { ...stub, getMathVariants: () => ({ assembly: { parts: few } }) },
    1,
    1000,
    'v',
  );
  assert.ok(
    asm.parts.length < MAX_ASSEMBLY_PARTS && asm.parts.length >= 10,
    'an ordinary assembly',
  );
  console.log('ok MATH assembly');
}
// name: a record that runs past the end of the file costs that name, not the font.
{
  const bytes = bytesOf('shapeDlig.ttf');
  const { v, off } = tableOf(bytes, 'name');
  const strings = v.getUint16(off + 4);
  for (let i = 0; i < v.getUint16(off + 2); i++)
    v.setUint16(off + 6 + i * 12 + 10, 0xfff0 - strings);
  const f = new MantleFontAsset(bytes);
  assert.equal(layout(f, 'abc').length, 3, 'the font still shapes');
  assert.equal(typeof f.familyName, 'string', 'with a name that is at worst empty');
  console.log('ok name record');
}
console.log('\nFONT-BUDGET PASS');
