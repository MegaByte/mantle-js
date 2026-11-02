// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Smoke test: load Arial.ttf, parse, dump glyph for 'A'.
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

const fontPath = process.argv[2] || '/System/Library/Fonts/Supplemental/Arial.ttf';
const bytes = new Uint8Array(readFileSync(fontPath));
const font = new MantleFontAsset(bytes);

const A = 0x41;
const segs = font.getGlyphSegs(A);
const m = font.getMetrics(A);

console.log('font:', fontPath);
console.log('unitsPerEm:', font.unitsPerEm);
console.log('ascent/descent/lineGap:', font.ascent, font.descent, font.lineGap);
console.log(`U+${A.toString(16).toUpperCase()} ('A'): ${segs ? segs.length : 0} segs`);
console.log('metrics:', JSON.stringify(m));
if (segs) {
  console.log('first 3 segs:');
  for (let i = 0; i < Math.min(3, segs.length); i++) {
    console.log(' ', JSON.stringify(segs[i]));
  }
}
