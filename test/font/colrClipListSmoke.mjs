// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrClipListSmoke -- COLRv1 ClipList. Fonts written by fontTools.colorLib (test/fixtures/fonts/colrSpecClip.ttf,
// colrSpecClipVar.ttf; genColrClipFonts.py), the expected boxes and nesting from HarfBuzz's paint callbacks (it pushes a
// clip rectangle for the base glyph and for every PaintColrGlyph target), read through uharfbuzz.
//   * ClipList format 1, Clip ranges (E..F share one record), ClipBox format 1 and format 2 (var) at wght = 0 / 1
//   * colrPaintToGraph wraps the base glyph's paint, and each PaintColrGlyph target's, in a rectangular PaintGlyph
//   * the bundle emits the box as a mask row placed with the paint (translate / rotate), adds no ink to globalBBox
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { ColrReader } from '../../src/font/color/colrReader.js';
import { colrPaintToGraph } from '../../src/font/color/colrPaintToGraph.js';
import { registerColorEmojiReaders } from '../../src/font/color/index.js';
import { MantleFontAsset, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
globalThis.DOMParser ??= DOMParser;
globalThis.XMLSerializer ??= XMLSerializer;
registerColorEmojiReaders();

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/fonts');
const bytes = (n) => new Uint8Array(readFileSync(path.join(FX, n)));
const colr = new ColrReader(parseTtfTables(bytes('colrSpecClip.ttf')));
// glyph order: .notdef box A B C D E F G -> gids 0 1 2..8
const gid = (ch) => 2 + 'ABCDEFG'.indexOf(ch);

// ---- the reader
assert.deepEqual(colr.getClipBox(gid('A')), [200, 100, 500, 400], 'A: format 1 box');
assert.equal(colr.getClipBox(gid('B')), null, 'B: no Clip record');
assert.equal(colr.getClipBox(gid('C')), null, 'C: no Clip record');
assert.deepEqual(colr.getClipBox(gid('D')), [250, 150, 650, 500], 'D: its own box');
assert.deepEqual(colr.getClipBox(gid('E')), [150, 50, 450, 350], 'E: range start');
assert.deepEqual(
  colr.getClipBox(gid('F')),
  [150, 50, 450, 350],
  'F: range end shares the Clip record',
);
assert.equal(colr.getClipBox(gid('G')), null, 'G: no Clip record');
assert.equal(colr.getClipBox(0), null, '.notdef: not a color glyph');

const vf = new ColrReader(parseTtfTables(bytes('colrSpecClipVar.ttf')));
assert.deepEqual(
  vf.getClipBox(2, null),
  [200, 100, 500, 400],
  'ClipBox format 2 without coords: the static box',
);
assert.deepEqual(vf.getClipBox(2, [0]), [200, 100, 500, 400], 'wght 0: no delta');
assert.deepEqual(
  vf.getClipBox(2, [1]),
  [150, 50, 600, 500],
  'wght 1: HarfBuzz (150,50,600,500) = deltas -50 -50 +100 +100',
);
assert.deepEqual(vf.getClipBox(2, [0.5]), [175, 75, 550, 450], 'wght 0.5: half the deltas');

// ---- the graph
const graphOf = (ch) => colrPaintToGraph(colr.getPaint(gid(ch)), colr, null, gid(ch));
const clipNodes = (g) => g.nodes.filter((n) => n.type === 'PaintGlyph' && n.params.clipBox);
assert.deepEqual(
  clipNodes(graphOf('A')).map((n) => n.params.clipBox),
  [[200, 100, 500, 400]],
  'A: one clip',
);
assert.equal(
  graphOf('A').nodes[graphOf('A').rootOut].params.clipBox !== undefined,
  true,
  'A: the clip is the root',
);
assert.equal(clipNodes(graphOf('C')).length, 0, 'C: no clip node');
assert.deepEqual(
  clipNodes(graphOf('D'))
    .map((n) => n.params.clipBox)
    .sort(),
  [
    [200, 100, 500, 400],
    [250, 150, 650, 500],
  ].sort(),
  "D: its box and the referenced glyph's",
);
{
  const g = graphOf('B'); // Translate(ColrGlyph A): the box is inside the translate
  const root = g.nodes[g.rootOut];
  assert.equal(root.type, 'PaintTransform', 'B: root is the translate');
  assert.equal(clipNodes(g).length, 1, "B: the referenced glyph's box");
}
// without the base glyph id the root is not clipped, the references still are
assert.equal(
  clipNodes(colrPaintToGraph(colr.getPaint(gid('A')), colr)).length,
  0,
  'no rootGlyphId: no root clip',
);

// ---- the bundle: the box is a mask row placed with the paint, and adds no ink
const font = new MantleFontAsset(bytes('colrSpecClip.ttf'));
const build = (t) =>
  buildStyled([{ text: t, style: { ...defaultStyle(), color: [0, 0, 0, 1] } }], font, {});
const bA = await build('A'),
  bC = await build('C'),
  bD = await build('D'),
  bB = await build('B');
const masks = (b) => b.colrGraphs[0].masks;
assert.ok('clip#0' in masks(bA), 'A: a clip mask row');
assert.ok(!Object.keys(masks(bC)).some((k) => String(k).startsWith('clip')), 'C: none');
assert.deepEqual(
  Object.keys(masks(bD))
    .filter((k) => String(k).startsWith('clip'))
    .sort(),
  ['clip#0', 'clip#1'],
  'D: two clip rows',
);
assert.deepEqual(
  Array.from(bA.globalBBox),
  Array.from(bC.globalBBox),
  'a clip box adds no ink to globalBBox (A and C paint the same box)',
);
const nodeKeys = (b) =>
  b.colrGraphs[0].graph.nodes.filter((n) => n.type === 'PaintGlyph').map((n) => n.params.maskKey);
assert.ok(nodeKeys(bA).includes('clip#0'), 'A: the PaintGlyph node names the clip row');
assert.deepEqual(
  Array.from(bC.colrHit.rows ? Object.keys(bC.colrHit.rows) : []),
  Array.from(Object.keys(bA.colrHit.rows)),
  'the clip row answers no hit (same hit rows as the unclipped glyph)',
);
// B: the translate is applied to the box (the mask row is a placed silhouette, own key)
assert.ok(
  'clip#0' in masks(bB) && '1#0' in masks(bB),
  'B: the box and the glyph are both placed rows',
);
console.log('ok colrClipList');
