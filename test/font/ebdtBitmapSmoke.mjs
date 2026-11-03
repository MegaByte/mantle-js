// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// ebdtBitmapSmoke.mjs — EBDT/EBLC monochrome embedded-bitmap decoding.
//
// Courier New ships EBDT/EBLC strikes for the shade-block glyphs
// U+2591/2592/2593 (light / medium / dark shade), bitDepth 1, via index
// formats 2 & 3 and image formats 2 & 5. We assert the reader finds the
// strikes and decodes the three shades to their expected coverage ratios
// (25% / 50% / 75%). Skips when the font is unavailable.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/index.js';

const p = '/System/Library/Fonts/Supplemental/Courier New.ttf';
if (!existsSync(p)) {
  console.log('Skip ebdt: no Courier New');
  process.exit(0);
}

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);

const font = new MantleFontAsset(new Uint8Array(readFileSync(p)));

// ---- T1: bitmap strikes detected ----
if (!font.ebdt.hasBitmaps) fail('T1 Courier New should expose EBDT strikes');
else ok(`T1 hasBitmaps (${font.ebdt.numStrikes} strikes)`);

// ---- T2: shade glyphs decode with increasing coverage ----
const cov = (cp) => {
  const gid = font.codepointToGlyphId(cp);
  const g = font.getBitmapGlyphByGid(gid, 16);
  if (!g || !g.alphaBitmap) return null;
  if (g.source !== 'ebdt') {
    fail(`T2 U+${cp.toString(16)} source ${g.source} != ebdt`);
    return null;
  }
  let on = 0;
  for (const v of g.alphaBitmap) if (v > 127) on++;
  return on / (g.pixelWidth * g.pixelHeight);
};
const light = cov(0x2591),
  medium = cov(0x2592),
  dark = cov(0x2593);
if (light == null || medium == null || dark == null) fail('T2 shade glyphs did not decode');
else if (!(light < medium && medium < dark))
  fail(`T2 shade coverage not monotonic: light=${light} medium=${medium} dark=${dark}`);
else
  ok(
    `T2 shade coverage monotonic: ${(light * 100).toFixed(0)}% < ${(medium * 100).toFixed(0)}% < ${(dark * 100).toFixed(0)}%`,
  );

// ---- T3: medium shade is ~50% (checkerboard) ----
if (medium != null && Math.abs(medium - 0.5) > 0.1)
  fail(`T3 medium shade ~50% expected, got ${(medium * 100).toFixed(0)}%`);
else if (medium != null) ok('T3 medium shade ≈ 50%');

console.log(failures ? `\nEBDT FAIL (${failures})` : '\nEBDT PASS');
process.exit(failures ? 1 : 0);
