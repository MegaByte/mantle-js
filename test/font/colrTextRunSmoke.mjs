// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrTextRunSmoke.mjs — verifies MantleTextRun emits N Mantle shapes per
// colored glyph (one per COLR layer) using the in-memory COLR test font.

import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled, buildFromMarkup } from '../../src/font/textRun.js';
import { buildColrTestFont } from './_colrFontFixture.mjs';
import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const META_HEADER_BYTES = 32;
const asMetaF32 = (b) =>
  new Float32Array(b.metaFloats.buffer, b.metaFloats.byteOffset, b.metaFloats.length);

// Read fill RGBA at slot f4..f7 of the i-th meta row (48-float stride).
function fillAt(b, i) {
  const mf = asMetaF32(b);
  const s = b.metaFloatsPerShape;
  return [mf[i * s + 4], mf[i * s + 5], mf[i * s + 6], mf[i * s + 7]];
}

// T1: a 1-glyph color string produces 2 shapes (one per COLR layer).
{
  const font = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41 }));
  const b = await buildStyled([{ text: 'A', style: { color: [0, 0, 0, 1], sizeScale: 1 } }], font);
  if (b.numShapes !== 2) fail(`T1 expected 2 shapes (one per layer), got ${b.numShapes}`);
  else ok(`T1 colored 'A' → ${b.numShapes} shapes (2 layers)`);
}

// T2: layer colors hit the meta rows. Layer 0 = red, layer 1 = green.
{
  const font = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41 }));
  const b = await buildStyled([{ text: 'A', style: { color: [0, 0, 0, 1], sizeScale: 1 } }], font);
  if (b.numShapes !== 2) {
    fail(`T2 needs 2 shapes; got ${b.numShapes}`);
  } else {
    const [r0, g0, b0, a0] = fillAt(b, 0);
    const [r1, g1, b1, a1] = fillAt(b, 1);
    if (Math.abs(r0 - 1) > 1e-3 || Math.abs(g0) > 1e-3 || Math.abs(b0) > 1e-3)
      fail(`T2 shape0 fill ${[r0, g0, b0, a0]} (expected red)`);
    else if (Math.abs(r1) > 1e-3 || Math.abs(g1 - 1) > 1e-3 || Math.abs(b1) > 1e-3)
      fail(`T2 shape1 fill ${[r1, g1, b1, a1]} (expected green)`);
    else ok(`T2 layer colors: shape0=red shape1=green`);
  }
}

// T3: a 2-codepoint string with both colored produces 4 shapes.
// (Build a fixture where two codepoints both map to gid 1 — easy
// since cmap only knows codepoint 0x41. Use the same string twice.)
{
  const font = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41 }));
  const b = await buildStyled([{ text: 'AA', style: { color: [0, 0, 0, 1], sizeScale: 1 } }], font);
  if (b.numShapes !== 4) fail(`T3 expected 4 shapes (2 glyphs × 2 layers), got ${b.numShapes}`);
  else ok(`T3 'AA' → 4 shapes (2 glyphs × 2 layers)`);
}

// T4: the run's color does NOT override palette colors (this fixture
// has no foreground-sentinel layers). buildStyled used black; layer
// shapes should still be red/green from the palette.
{
  const font = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41 }));
  const b = await buildStyled(
    [{ text: 'A', style: { color: [0, 0, 1, 1], sizeScale: 1 } /* blue run color */ }],
    font,
  );
  const [r0, g0, bl0] = fillAt(b, 0);
  const [r1, g1, bl1] = fillAt(b, 1);
  if (Math.abs(bl0) > 0.1) fail(`T4 shape0 blue=${bl0} (palette should win)`);
  else if (Math.abs(bl1) > 0.1) fail(`T4 shape1 blue=${bl1} (palette should win)`);
  else ok(`T4 palette colors override run color (run was blue, layers stayed red+green)`);
}

// T5: monochrome path unchanged. Use Arial — one shape per glyph.
{
  const { readFileSync } = await import('fs');
  const arial = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
  );
  const b = await buildFromMarkup('ABC', arial, [0, 0, 0, 1]);
  if (b.numShapes !== 3) fail(`T5 monochrome 'ABC' → ${b.numShapes} shapes (expected 3)`);
  else ok(`T5 monochrome path unchanged: 3 shapes for 'ABC'`);
}

console.log();
console.log(failures === 0 ? 'COLR-TEXTRUN PASS' : `COLR-TEXTRUN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
