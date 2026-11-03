// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Build a text run for "Hello, World!" and dump shape/bbox info.
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun } from '../../src/font/textRun.js';

const fontPath = process.argv[2] || '/System/Library/Fonts/Supplemental/Arial.ttf';
const text = process.argv[3] || 'Hello, World!';

const bytes = new Uint8Array(readFileSync(fontPath));
const font = new MantleFontAsset(bytes);
const bundle = await buildTextRun(text, font);

console.log(`'${text}' → ${bundle.numShapes} shapes`);
console.log('bbox:', bundle.globalBBox.map((v) => v.toFixed(3)).join(', '));
console.log('curveTexels:', bundle.curveTexels.length / 4, 'texels');
console.log('bandTexels:', bundle.bandTexels.length / 4, 'texels');
console.log(
  'metaFloats:',
  bundle.metaFloats.length,
  'floats =',
  bundle.metaFloats.length / 48,
  'shapes × 48',
);
