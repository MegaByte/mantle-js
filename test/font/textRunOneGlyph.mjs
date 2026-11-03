// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Single-glyph debug: dump every bandBuf texel for 'l'.
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
// The bundle-wire plumbing comes from the modules that own it. It is not on the public surface:
// importer.js re-exported it for sibling subsystems, but importer.js IS the @kontek/mantle/svg
// subpath, so that re-export made the texel format and the meta packer public by accident.
import { pathBbox, segBbox, mkLine, mkCubic, SEG_LINE, SEG_CUBIC } from '../../src/svg/importer.js';
import { makeTexelBuffer, texelAppend, buildTexturesShape } from '../../src/svg/textures.js';

const font = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
font.getMetrics(0x20);
const invUpem = 1 / font.unitsPerEm;

const src = font.getGlyphSegs(0x6c); // 'l'
const segs = src.map((s) => {
  if (s.type === SEG_LINE)
    return mkLine([s.p1[0] * invUpem, -s.p1[1] * invUpem], [s.p2[0] * invUpem, -s.p2[1] * invUpem]);
  if (s.type === SEG_CUBIC)
    return mkCubic(
      [s.p1[0] * invUpem, -s.p1[1] * invUpem],
      [s.p2[0] * invUpem, -s.p2[1] * invUpem],
      [s.p3[0] * invUpem, -s.p3[1] * invUpem],
      [s.p4[0] * invUpem, -s.p4[1] * invUpem],
    );
  return null;
});
console.log('segs (', segs.length, '):');
for (const s of segs) console.log(' ', JSON.stringify(s));

const bb = pathBbox(segs);
console.log('bbox:', bb);

const curveBuf = makeTexelBuffer();
const bandBuf = makeTexelBuffer();
texelAppend(curveBuf, 0, 0, 0, 0);

const info = buildTexturesShape(segs, 8, 8, bb, curveBuf, bandBuf);
console.log('info:', info);
console.log('curveBuf size:', curveBuf.count);
console.log('bandBuf size:', bandBuf.count);
console.log('bandBuf contents:');
for (let i = 0; i < bandBuf.count; i++) {
  const o = i * 4;
  console.log(
    `  [${i.toString().padStart(3)}]`,
    [bandBuf.floats[o], bandBuf.floats[o + 1], bandBuf.floats[o + 2], bandBuf.floats[o + 3]]
      .map((v) => v.toFixed(0))
      .join(', '),
  );
}
