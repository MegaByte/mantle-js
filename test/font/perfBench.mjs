// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// perfBench.mjs — measure bundle-build performance.
//
// Three axes:
//   - text length (10 / 100 / 1000 chars)
//   - font format (TTF / CFF / woff2-then-TT)
//   - cache state (cold first-pass vs warm re-build)
//
// Reports ms per build and ms per glyph.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { performance } from 'perf_hooks';
import { MantleFontAsset, decodeIfWoff2 } from '../../src/font/fontAsset.js';
import { buildTextRun } from '../../src/font/textRun.js';
import { registerWoff2Reader } from '../../src/font/formats/woff2.js';
import { fontFixture, have, missingHint, noteSkip } from '../_assets.mjs';
registerWoff2Reader();

const HERE = dirname(fileURLToPath(import.meta.url));

const SAMPLES = [
  { label: 'short  ', text: 'Hello, World!' },
  { label: 'medium ', text: 'The quick brown fox jumps over the lazy dog. '.repeat(2).trim() },
  { label: 'long   ', text: 'The quick brown fox jumps over the lazy dog. '.repeat(20).trim() },
];

const FONTS = [
  { name: 'Arial (TTF)', path: '/System/Library/Fonts/Supplemental/Arial.ttf' },
  { name: 'STIX (CFF)', path: '/System/Library/Fonts/Supplemental/STIXGeneral.otf' },
  { name: 'Roboto (woff2)', path: fontFixture('roboto-regular.woff2') },
];

console.log(
  `${'font'.padEnd(18)}  ${'sample'.padEnd(8)}  ${'len'.padStart(5)}  ${'cold(ms)'.padStart(9)}  ${'warm(ms)'.padStart(9)}  ${'µs/glyph cold'.padStart(15)}  ${'µs/glyph warm'.padStart(15)}`,
);
console.log('-'.repeat(95));

for (const fnt of FONTS) {
  // Roboto is fetched, not vendored; the two system faces still give a timing baseline, so the
  // bench keeps running and reports SKIP instead of dying on an ENOENT.
  if (!have(fnt.path)) {
    console.log(`${fnt.name.padEnd(18)}  SKIP`);
    noteSkip(missingHint(fnt.path));
    continue;
  }
  let bytes = new Uint8Array(readFileSync(fnt.path));
  bytes = await decodeIfWoff2(bytes);
  const font = new MantleFontAsset(bytes);

  for (const sample of SAMPLES) {
    // Force cache + tables to load first via a no-op call.
    font.getMetrics(0x20);

    // Warm up the glyph cache by rendering once.
    const wmup = await buildTextRun(sample.text, font);
    const nGlyphs = wmup.numShapes;

    // Drop the glyph cache to time a "cold" build of this string
    // (everything starts from the codepoint → cmap → glyf path).
    font._cache.clear();
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await buildTextRun(sample.text, font);
    const tCold = (performance.now() - t0) / 5;

    // Re-time with warm cache.
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) await buildTextRun(sample.text, font);
    const tWarm = (performance.now() - t1) / 50;

    const usGlyphCold = (tCold * 1000) / Math.max(nGlyphs, 1);
    const usGlyphWarm = (tWarm * 1000) / Math.max(nGlyphs, 1);
    console.log(
      `${fnt.name.padEnd(18)}  ${sample.label}  ${sample.text.length.toString().padStart(5)}  ${tCold.toFixed(2).padStart(9)}  ${tWarm.toFixed(2).padStart(9)}  ${usGlyphCold.toFixed(1).padStart(15)}  ${usGlyphWarm.toFixed(1).padStart(15)}`,
    );
  }
  console.log();
}
