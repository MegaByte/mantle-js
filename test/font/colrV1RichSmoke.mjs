// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrV1RichSmoke.mjs — exercises the extended COLR v1 Paint formats:
// PaintGlyph (10), PaintColrGlyph (11), PaintTransform (12),
// PaintRotate (22), PaintComposite (32), in addition to the
// PaintColrLayers (1) + PaintSolid (2) already covered by
// colrV1ReaderSmoke.mjs.
//
// Fixture (see buildColrV1Rich in _colrFontFixture.mjs):
//   Base gid 1 → PaintGlyph(gid=2)
//                  └ PaintTransform(0.5x, +100/+50)
//                       └ PaintColrLayers
//                            ├ PaintSolid(palIdx=0, α=1.0)
//                            └ PaintSolid(palIdx=1, α=0.5)
//   Base gid 2 → PaintColrGlyph(gid=1)
//   Base gid 3 → PaintComposite(mode=7 HARD_LIGHT)
//                  ├ src: PaintRotate(45°)
//                  │        └ PaintSolid(palIdx=0)
//                  └ dst: PaintSolid(palIdx=1)

import { buildColrTestFont } from './_colrFontFixture.mjs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { ColrReader } from '../../src/font/color/colrReader.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) < eps;
}

const font = buildColrTestFont({ colrV1Rich: true });
const tables = parseTtfTables(font);
const colr = new ColrReader(tables);

assert(colr.hasColrV1, 'hasColrV1 true');
assert(colr.numBaseGlyphsV1 === 3, `numBaseGlyphsV1 = 3, got ${colr.numBaseGlyphsV1}`);

// --- Glyph 1: PaintGlyph → PaintTransform → PaintColrLayers → 2 solids
{
  const root = colr.getPaint(1);
  assert(root !== null, 'glyph 1 paint non-null');
  assert(root.format === 10, `glyph 1 root format = 10 (PaintGlyph), got ${root.format}`);
  assert(root.glyphId === 2, `glyph 1 root.glyphId = 2, got ${root.glyphId}`);
  const xf = root.child;
  assert(xf.format === 12, `glyph 1 child format = 12 (Transform), got ${xf.format}`);
  // affine = [xx, yx, xy, yy, dx, dy]
  assert(approx(xf.affine[0], 0.5), `xx ≈ 0.5, got ${xf.affine[0]}`);
  assert(approx(xf.affine[3], 0.5), `yy ≈ 0.5, got ${xf.affine[3]}`);
  assert(approx(xf.affine[4], 100), `dx ≈ 100, got ${xf.affine[4]}`);
  assert(approx(xf.affine[5], 50), `dy ≈ 50, got ${xf.affine[5]}`);
  const layers = xf.child;
  assert(layers.format === 1, `transform.child format = 1 (Layers), got ${layers.format}`);
  assert(layers.layers.length === 2, `layers.layers.length = 2, got ${layers.layers.length}`);
  const l0 = layers.layers[0],
    l1 = layers.layers[1];
  assert(
    l0.format === 2 && l0.paletteIndex === 0 && approx(l0.alpha, 1.0),
    'layer 0 is PaintSolid red α=1.0',
  );
  assert(
    l1.format === 2 && l1.paletteIndex === 1 && approx(l1.alpha, 0.5),
    'layer 1 is PaintSolid green α=0.5',
  );
}

// --- Glyph 2: PaintColrGlyph(1) — reference to glyph 1's paint
{
  const root = colr.getPaint(2);
  assert(root !== null, 'glyph 2 paint non-null');
  assert(root.format === 11, `glyph 2 root format = 11 (PaintColrGlyph), got ${root.format}`);
  assert(root.glyphId === 1, `glyph 2 ref glyphId = 1, got ${root.glyphId}`);
}

// --- Glyph 3: PaintComposite(mode=7) with PaintRotate src, PaintSolid dst
{
  const root = colr.getPaint(3);
  assert(root !== null, 'glyph 3 paint non-null');
  assert(root.format === 32, `glyph 3 root format = 32 (Composite), got ${root.format}`);
  assert(root.mode === 7, `composite mode = 7 (HARD_LIGHT), got ${root.mode}`);
  const src = root.src,
    dst = root.dst;
  assert(src.format === 24, `composite src format = 24 (Rotate), got ${src.format}`);
  assert(approx(src.angleDeg, 45), `rotate angle ≈ 45°, got ${src.angleDeg}`);
  assert(src.child.format === 2 && src.child.paletteIndex === 0, 'rotate child is PaintSolid red');
  assert(dst.format === 2 && dst.paletteIndex === 1, 'composite dst is PaintSolid green');
}

console.log('---');
if (failures) console.error(`COLR-V1-RICH FAIL (${failures})`);
else console.log('COLR-V1-RICH PASS');
process.exit(failures ? 1 : 0);
