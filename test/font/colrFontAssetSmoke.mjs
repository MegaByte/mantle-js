// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrFontAssetSmoke.mjs — builds an in-memory sfnt with COLR v0 + CPAL
// via _colrFontFixture, feeds it through MantleFontAsset, and verifies the
// getColoredGlyph integration end-to-end.

import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildColrTestFont } from './_colrFontFixture.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// T1: font with COLR → hasColor true.
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  font.getMetrics(0x41); // forces _ensure()
  if (!font.hasColor) fail('T1 hasColor false');
  else if (font.colr.version !== 0) fail(`T1 version=${font.colr.version}`);
  else if (font.colr.numBaseGlyphs !== 1) fail(`T1 numBaseGlyphs=${font.colr.numBaseGlyphs}`);
  else
    ok(
      `T1 hasColor true; v${font.colr.version}, ${font.colr.numBaseGlyphs} base, ${font.colr.numPaletteEntries} palette`,
    );
}

// T2: getColoredGlyph(codepoint) returns 2 layers with segs.
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const layers = font.getColoredGlyph(0x41);
  if (!layers) fail('T2 layers null');
  else if (layers.length !== 2) fail(`T2 expected 2 layers, got ${layers.length}`);
  else if (!layers[0].segs || layers[0].segs.length === 0) fail(`T2 layer 0 has no segs`);
  else if (!layers[1].segs || layers[1].segs.length === 0) fail(`T2 layer 1 has no segs`);
  else
    ok(
      `T2 0x41 → 2 layers: layer0 ${layers[0].segs.length} segs (rgba ${JSON.stringify(layers[0].rgba)}), layer1 ${layers[1].segs.length} segs (rgba ${JSON.stringify(layers[1].rgba)})`,
    );
}

// T3: getColoredGlyphByGid agrees with getColoredGlyph.
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const a = font.getColoredGlyph(0x41);
  const gid = font.codepointToGlyphId(0x41);
  const b = font.getColoredGlyphByGid(gid);
  if (a.length !== b.length) fail(`T3 length mismatch ${a.length} vs ${b.length}`);
  else if (a[0].glyphId !== b[0].glyphId) fail(`T3 glyphId mismatch`);
  else if (JSON.stringify(a[0].rgba) !== JSON.stringify(b[0].rgba)) fail(`T3 rgba mismatch`);
  else ok(`T3 by-codepoint and by-gid agree (gid=${gid}, layers=${a.length})`);
}

// T4: layer 0 rgba is red, layer 1 rgba is green (test font's CPAL).
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const layers = font.getColoredGlyph(0x41);
  const [r0, g0, b0, a0] = layers[0].rgba;
  const [r1, g1, b1, a1] = layers[1].rgba;
  if (
    Math.abs(r0 - 1) > 1e-3 ||
    Math.abs(g0) > 1e-3 ||
    Math.abs(b0) > 1e-3 ||
    Math.abs(a0 - 1) > 1e-3
  )
    fail(`T4 layer 0 rgba ${[r0, g0, b0, a0]} (expected red)`);
  else if (
    Math.abs(r1) > 1e-3 ||
    Math.abs(g1 - 1) > 1e-3 ||
    Math.abs(b1) > 1e-3 ||
    Math.abs(a1 - 1) > 1e-3
  )
    fail(`T4 layer 1 rgba ${[r1, g1, b1, a1]} (expected green)`);
  else ok(`T4 palette decode through full path: red + green`);
}

// T5: getColoredGlyph for a codepoint NOT in the cmap returns null.
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  font.getMetrics(0x41);
  const miss = font.getColoredGlyph(0x42); // not mapped
  if (miss !== null) fail(`T5 expected null, got ${miss && miss.length} layers`);
  else ok('T5 unmapped codepoint → null');
}

// T6: font WITHOUT COLR → hasColor false, getColoredGlyph null.
// (Use the real Arial.ttf since it's monochrome.)
{
  const { readFileSync } = await import('fs');
  const arial = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
  );
  arial.getMetrics(0x41);
  if (arial.hasColor) fail('T6 Arial hasColor true');
  else if (arial.getColoredGlyph(0x41) !== null) fail('T6 Arial getColoredGlyph non-null');
  else ok('T6 Arial (no COLR) → hasColor false, getColoredGlyph null');
}

// T7: bbox sanity — each layer's segs are bounded by the test font's
// square dimensions (gid 2 is 50..350; gid 3 is 100..700).
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const layers = font.getColoredGlyph(0x41);
  function bbox(segs) {
    let xmin = Infinity,
      xmax = -Infinity,
      ymin = Infinity,
      ymax = -Infinity;
    for (const s of segs) {
      const pts =
        s.type === 0
          ? [s.p1, s.p2]
          : s.type === 1
            ? [s.p1, s.p2, s.p3]
            : s.type === 2
              ? [s.p1, s.p2, s.p3, s.p4]
              : [s.p1, s.p4];
      for (const p of pts) {
        if (p[0] < xmin) xmin = p[0];
        if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      }
    }
    return [xmin, ymin, xmax, ymax];
  }
  const bb0 = bbox(layers[0].segs);
  const bb1 = bbox(layers[1].segs);
  // glyphReader returns segs in raw font-unit coords (em-normalization
  // happens downstream at layout time). Our fixture: layer 0 is a
  // square 50..350 font units; layer 1 is 100..700. Confirm verbatim.
  const ok0 = Math.abs(bb0[0] - 50) < 1 && Math.abs(bb0[2] - 350) < 1;
  const ok1 = Math.abs(bb1[0] - 100) < 1 && Math.abs(bb1[2] - 700) < 1;
  if (!ok0) fail(`T7 layer 0 bbox ${bb0.map((v) => v.toFixed(1))} (expected x in [50, 350])`);
  else if (!ok1) fail(`T7 layer 1 bbox ${bb1.map((v) => v.toFixed(1))} (expected x in [100, 700])`);
  else
    ok(
      `T7 per-layer bbox correct: L0 [${bb0.map((v) => v.toFixed(1)).join(', ')}], L1 [${bb1.map((v) => v.toFixed(1)).join(', ')}]`,
    );
}

console.log();
console.log(failures === 0 ? 'COLR-FONTASSET PASS' : `COLR-FONTASSET FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
