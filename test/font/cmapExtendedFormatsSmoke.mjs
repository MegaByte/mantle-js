// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cmapExtendedFormatsSmoke.mjs — cmap coverage beyond the classic
// 4/6/12 Unicode subtables: Windows Symbol (3,0) U+F000 PUA fallback,
// format 13 many-to-one, and format 14 Unicode Variation Sequences.
//
// Each sub-test gates on its font; missing fonts are skipped (CI-portable).

import { readFileSync, existsSync } from 'fs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { MantleFontAsset, buildTextRun } from '../../src/font/index.js';

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);
const have = (p) => existsSync(p);

// ---- Windows Symbol (3,0): 'A' resolves via the 0xF000 PUA fallback ----
{
  const p = '/System/Library/Fonts/Supplemental/Webdings.ttf';
  if (have(p)) {
    const t = parseTtfTables(new Uint8Array(readFileSync(p)));
    if (!t._cmapSymbol) fail('Symbol: Webdings not flagged (3,0) symbol');
    else if (t.codepointToGlyphIndex(0x41) === 0)
      fail('Symbol: A did not resolve via F000 fallback');
    else ok(`Symbol (3,0) F000 fallback: A → gid ${t.codepointToGlyphIndex(0x41)}`);
  } else console.log('skip Symbol: no Webdings');
}

// ---- Format 13 (many-to-one): adjacent codepoints share a glyph ----
{
  const p = '/System/Library/Fonts/LastResort.otf';
  if (have(p)) {
    const t = parseTtfTables(new Uint8Array(readFileSync(p)));
    if (t._cmapFormat !== 13) fail(`fmt13: expected format 13, got ${t._cmapFormat}`);
    else {
      const a = t.codepointToGlyphIndex(0x4e2d),
        b = t.codepointToGlyphIndex(0x4e2e);
      if (a === 0 || a !== b) fail(`fmt13: adjacent CJK should map to one glyph (${a} vs ${b})`);
      else ok(`fmt13 many-to-one: U+4E2D=U+4E2E=gid ${a}`);
    }
  } else console.log('skip fmt13: no LastResort');
}

// ---- Format 14 UVS: base+selector picks an explicit variant glyph ----
{
  const p = '/System/Library/Fonts/Supplemental/STIXTwoMath.otf';
  if (have(p)) {
    const font = new MantleFontAsset(new Uint8Array(readFileSync(p)));
    if (!font.hasVariationSelectors) fail('UVS: STIX should have a format-14 subtable');
    else {
      const def = font.codepointToGlyphId(0x30);
      const variant = font.codepointToVariationGlyphId(0x30, 0xfe00);
      if (variant === 0 || variant === def)
        fail(`UVS: 0x30+VS1 should yield a distinct variant (def=${def}, var=${variant})`);
      else if (font.codepointToVariationGlyphId(0x41, 0xfe0f) !== 0)
        fail('UVS: unregistered sequence should return 0');
      else ok(`UVS: 0x30+VS1 → variant gid ${variant} (default ${def})`);
    }
  } else console.log('skip UVS: no STIXTwoMath');
}

// ---- Formats 8 (mixed 16/32-bit) & 10 (trimmed 32-bit) via synthetic
//      sfnt buffers (no system font ships these). Guards the dispatch +
//      header-offset arithmetic. ----
{
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const pad4 = (a) => {
    while (a.length % 4) a.push(0);
    return a;
  };
  const buildFont = (subBytes, plat, enc) => {
    const head = new Array(54).fill(0);
    head[18] = 0x07;
    head[19] = 0xd0;
    const hhea = new Array(36).fill(0);
    hhea[35] = 1;
    const maxp = [...u32(0x00005000), ...u16(300)];
    const cmap = [...u16(0), ...u16(1), ...u16(plat), ...u16(enc), ...u32(12), ...subBytes];
    const tables = [
      ['head', head],
      ['hhea', hhea],
      ['maxp', maxp],
      ['cmap', cmap],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let off = 12 + tables.length * 16;
    const dir = [],
      body = [];
    for (const [tag, data] of tables) {
      const pd = pad4([...data]);
      for (let i = 0; i < 4; i++) dir.push(tag.charCodeAt(i));
      dir.push(...u32(0), ...u32(off), ...u32(data.length));
      body.push(...pd);
      off += pd.length;
    }
    return new Uint8Array([
      ...u32(0x00010000),
      ...u16(tables.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...dir,
      ...body,
    ]);
  };
  // Format 10: start 0x41, glyphs [10,20,30].
  const f10 = [
    ...u16(10),
    ...u16(0),
    ...u32(26),
    ...u32(0),
    ...u32(0x41),
    ...u32(3),
    ...u16(10),
    ...u16(20),
    ...u16(30),
  ];
  const t10 = parseTtfTables(buildFont(f10, 3, 10));
  if (
    t10.codepointToGlyphIndex(0x41) !== 10 ||
    t10.codepointToGlyphIndex(0x43) !== 30 ||
    t10.codepointToGlyphIndex(0x44) !== 0
  )
    fail('fmt10: trimmed 32-bit lookup wrong');
  else ok('fmt10 trimmed 32-bit array');
  // Format 8: is32 all zero, one group 0x41..0x43 → startGlyph 10.
  const is32 = new Array(8192).fill(0);
  const f8 = [
    ...u16(8),
    ...u16(0),
    ...u32(0),
    ...u32(0),
    ...is32,
    ...u32(1),
    ...u32(0x41),
    ...u32(0x43),
    ...u32(10),
  ];
  const t8 = parseTtfTables(buildFont(f8, 3, 10));
  if (
    t8.codepointToGlyphIndex(0x41) !== 10 ||
    t8.codepointToGlyphIndex(0x43) !== 12 ||
    t8.codepointToGlyphIndex(0x45) !== 0
  )
    fail('fmt8: mixed 16/32-bit lookup wrong');
  else ok('fmt8 mixed 16/32-bit coverage');
}

console.log(failures ? `\nCMAP-EXT FAIL (${failures})` : '\nCMAP-EXT PASS');
process.exit(failures ? 1 : 0);
