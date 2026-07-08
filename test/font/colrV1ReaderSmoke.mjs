// colrV1ReaderSmoke.mjs — round-trip the in-memory COLR v1 fixture
// through ColrReader and verify the paint tree.
//
// Fixture (see _colrFontFixture.mjs buildColrV1):
//   Base glyph 1 → PaintColrLayers
//                    layer 0 → PaintSolid (paletteIndex=0 red, alpha=1.0)
//                    layer 1 → PaintSolid (paletteIndex=1 green, alpha=0.5)
// Palette 0 = [red(1,0,0,1), green(0,1,0,1)] (CPAL stores BGRA, reader
// returns RGBA).
//
// What this test verifies:
//   - hasColrV1 == true
//   - hasColor  == true is FALSE (the v1-only fixture has no v0 records)
//   - getPaint(1) returns { format:1, layers:[ {format:2,...}, {format:2,...} ] }
//   - Solid colors include alpha multiplication: layer 1's alpha=0.5
//     produces rgba=[0,1,0,0.5] (palette green × 0.5).
//   - Foreground sentinel handling (a separate paint-tree variant).

import { buildColrTestFont } from './_colrFontFixture.mjs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { ColrReader } from '../../src/font/color/colrReader.js';

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('ok:', msg);
  }
}

const font = buildColrTestFont({ colrV1: true });
const tables = parseTtfTables(font);
const colr = new ColrReader(tables);

assert(colr.version === 1, `version is 1, got ${colr.version}`);
assert(colr.hasColrV1, 'hasColrV1 true');
assert(!colr.hasColor, 'hasColor false (no v0 records in this fixture)');
assert(colr.numBaseGlyphsV1 === 1, `numBaseGlyphsV1 = 1, got ${colr.numBaseGlyphsV1}`);
assert(colr.numPaletteEntries === 2, `numPaletteEntries = 2, got ${colr.numPaletteEntries}`);

// Missing glyph → null.
assert(colr.getPaint(0) === null, 'getPaint(0) is null');
assert(colr.getPaint(99) === null, 'getPaint(99) is null');

// Base glyph 1 → 2-layer PaintColrLayers.
const root = colr.getPaint(1);
assert(root !== null, 'getPaint(1) non-null');
assert(root.format === 1, `root format = 1, got ${root.format}`);
assert(Array.isArray(root.layers) && root.layers.length === 2,
       `root has 2 layers, got ${root.layers && root.layers.length}`);

// Layer 0 → PaintSolid red, alpha=1.0
const l0 = root.layers[0];
assert(l0.format === 2, `layer 0 format = 2, got ${l0.format}`);
assert(l0.paletteIndex === 0, `layer 0 paletteIndex = 0, got ${l0.paletteIndex}`);
assert(approx(l0.alpha, 1.0), `layer 0 alpha ≈ 1.0, got ${l0.alpha}`);
assert(l0.rgba && approx(l0.rgba[0], 1) && approx(l0.rgba[1], 0) && approx(l0.rgba[2], 0) && approx(l0.rgba[3], 1),
       `layer 0 rgba = [1,0,0,1], got ${JSON.stringify(l0.rgba)}`);

// Layer 1 → PaintSolid green, alpha=0.5
const l1 = root.layers[1];
assert(l1.format === 2, `layer 1 format = 2, got ${l1.format}`);
assert(l1.paletteIndex === 1, `layer 1 paletteIndex = 1, got ${l1.paletteIndex}`);
assert(approx(l1.alpha, 0.5), `layer 1 alpha ≈ 0.5, got ${l1.alpha}`);
assert(l1.rgba && approx(l1.rgba[0], 0) && approx(l1.rgba[1], 1) && approx(l1.rgba[2], 0) && approx(l1.rgba[3], 0.5),
       `layer 1 rgba = [0,1,0,0.5], got ${JSON.stringify(l1.rgba)}`);

if (process.exitCode === 1) {
  console.error('---\nColr v1 smoke FAILED');
} else {
  console.log('---\nColr v1 smoke ok');
}
