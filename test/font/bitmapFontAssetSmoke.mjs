// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bitmapFontAssetSmoke.mjs — FontAsset.getBitmapGlyph dispatch (T1-T5,
// the text builders) and, beneath it, the TTC container and sbix reader
// (T6-T9), against the real Apple Color Emoji.ttc (a 192 MB system font
// on macOS, read once for both) when installed; falls back to a SKIP
// otherwise.

import { readFileSync, existsSync } from 'fs';
import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { SbixReader } from '../../src/font/color/sbixReader.js';

const TTC_PATH = '/System/Library/Fonts/Apple Color Emoji.ttc';

if (!existsSync(TTC_PATH)) {
  console.log(`SKIP — ${TTC_PATH} not present (run on macOS)`);
  process.exit(0);
}

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const buf = new Uint8Array(readFileSync(TTC_PATH));
const font = new MantleFontAsset(buf);

// T1: Arial — no bitmaps. Capability returns false; getBitmapGlyph null.
{
  const arial = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
  );
  arial.getMetrics(0x41); // force _ensure
  if (arial.hasBitmaps) fail('T1 Arial.hasBitmaps true');
  else if (arial.getBitmapGlyph(0x41, 32) !== null) fail('T1 Arial.getBitmapGlyph non-null');
  else ok('T1 Arial: no bitmaps');
}

// T2: Apple Color Emoji — hasBitmaps true (sbix path).
{
  font.getMetrics(0x41);
  if (!font.hasBitmaps) fail('T2 Apple Color Emoji hasBitmaps false');
  else if (!font.sbix.hasBitmaps) fail('T2 sbix.hasBitmaps false');
  else ok(`T2 Apple Color Emoji: hasBitmaps via ${font.sbix.numStrikes} sbix strikes`);
}

// T3: U+1F600 (😀) → bitmap glyph with PNG bytes + em-normalized advance.
{
  const g = font.getBitmapGlyph(0x1f600, 64);
  if (!g) fail('T3 no bitmap for 😀');
  else if (g.source !== 'sbix') fail(`T3 source=${g.source}`);
  else if (!g.pngBytes || g.pngBytes.length < 100)
    fail(`T3 pngBytes len=${g.pngBytes && g.pngBytes.length}`);
  else if (g.advanceEm <= 0) fail(`T3 advanceEm=${g.advanceEm}`);
  else if (g.strikePpem <= 0) fail(`T3 strikePpem=${g.strikePpem}`);
  else
    ok(
      `T3 😀 → ${g.pngBytes.length}-byte PNG, advance ${g.advanceEm.toFixed(3)} em, strike ppem ${g.strikePpem}`,
    );
}

// T4: target ppem selects different strikes for different requests.
{
  const small = font.getBitmapGlyph(0x1f600, 20);
  const big = font.getBitmapGlyph(0x1f600, 256);
  if (!small || !big) fail('T4 missing strikes');
  else if (small.strikePpem >= big.strikePpem)
    fail(`T4 strike selection broken: ppem 20→${small.strikePpem}, ppem 256→${big.strikePpem}`);
  else
    ok(
      `T4 strike selection: target ppem 20 → strike ${small.strikePpem}, target 256 → strike ${big.strikePpem}`,
    );
}

// T5: non-emoji codepoint (latin 'A') — Apple Color Emoji has no glyph;
// getBitmapGlyph returns null (and doesn't throw).
{
  const g = font.getBitmapGlyph(0x41, 32);
  // gid 0 = .notdef returns null per spec. Don't enforce; just don't
  // crash. (Apple emoji actually maps some Latin to glyphs for digit
  // keycaps.)
  if (g !== null && (!g.pngBytes || g.pngBytes.length === 0))
    fail('T5 unmapped cp returned malformed glyph');
  ok(`T5 Latin 'A' lookup: ${g === null ? 'null' : 'glyph (font has it)'} — no crash`);
}

// Reader payloads must reach the public text builder, with shared raster storage.
{
  const { buildTextRun } = await import('../../src/font/textRun.js');
  const { buildTextSections } = await import('../../src/font/textSections.js');
  const raw = await buildTextRun('😀😀', font);
  if (raw.numShapes !== 2 || !raw.imageAtlas || raw.imageAtlasRects.length !== 1)
    fail('bitmap text emits two glyphs sharing one atlas image');
  const built = await buildTextSections(font, '😀', { fill: [1, 1, 1, 0.5] }, false, {});
  if (!built.sections.imageAtlas || built.bundleSrc.numShapes !== 1)
    fail('bitmap text sections preserve image pixels');
}

// T6: TTC container parses; face 0 has the sbix table.
{
  const t = parseTtfTables(buf);
  if (t.numGlyphs <= 0) fail(`T6 numGlyphs=${t.numGlyphs}`);
  else if (!t.sbix) fail('T6 no sbix table on face 0');
  else if (t._cmapFormat !== 12)
    fail(`T6 expected cmap format 12 (Unicode 32-bit), got ${t._cmapFormat}`);
  else
    ok(
      `T6 TTC face 0: ${t.numGlyphs} glyphs, unitsPerEm=${t.unitsPerEm}, cmap format ${t._cmapFormat}`,
    );
}

// T7: Sbix reader sees multiple strikes.
{
  const t = parseTtfTables(buf);
  const r = new SbixReader(t);
  if (!r.hasBitmaps) fail('T7 hasBitmaps false');
  else if (r.numStrikes < 2) fail(`T7 expected >=2 strikes, got ${r.numStrikes}`);
  else ok(`T7 sbix: ${r.numStrikes} strikes`);
}

// T8: 😀 (U+1F600 grinning face) → gid → PNG bytes.
{
  const t = parseTtfTables(buf);
  const r = new SbixReader(t);
  const gid = t.codepointToGlyphIndex(0x1f600);
  if (gid === 0) fail('T8 no gid for U+1F600');
  else {
    const strikeIdx = r.pickStrikeForPpem(64);
    if (strikeIdx < 0) fail('T8 no strike picked');
    else {
      const g = r.getBitmapGlyph(gid, strikeIdx);
      if (!g) fail(`T8 no bitmap for gid ${gid} strike ${strikeIdx}`);
      else if (!g.isPng) fail(`T8 non-PNG graphicType 0x${g.graphicType.toString(16)}`);
      else if (g.pngBytes.length < 100)
        fail(`T8 PNG suspiciously short: ${g.pngBytes.length} bytes`);
      else {
        // Check PNG signature.
        const sig = Array.from(g.pngBytes.slice(0, 4));
        if (sig[0] !== 0x89 || sig[1] !== 0x50 || sig[2] !== 0x4e || sig[3] !== 0x47)
          fail(`T8 PNG signature wrong: ${sig.map((b) => b.toString(16)).join(' ')}`);
        else
          ok(
            `T8 U+1F600 (😀) → gid ${gid}, strike ppem ${g.strikePpem}, ${g.pngBytes.length}-byte PNG (signature OK)`,
          );
      }
    }
  }
}

// T9: a non-emoji codepoint (latin 'A', U+0041) returns gid 0
// (Apple Color Emoji doesn't have non-emoji glyphs).
{
  const t = parseTtfTables(buf);
  const gid = t.codepointToGlyphIndex(0x41);
  if (gid !== 0) {
    // Apple Color Emoji actually DOES have a few non-emoji glyphs
    // (period, digits used in keycaps, etc) — accept either. Just
    // confirm the lookup doesn't crash.
  }
  ok(`T9 cmap lookup for U+0041 → gid ${gid} (no crash)`);
}

console.log();
console.log(failures === 0 ? 'BITMAP-FONTASSET PASS' : `BITMAP-FONTASSET FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
