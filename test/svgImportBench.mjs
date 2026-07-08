// svgImportBench.mjs — measure SVG import throughput.
//
// Drives the importer against tiger.svg and other fixtures.
//
// Usage:
//   node test/svgImportBench.mjs
//
// Reports per-file: average ms across N runs, # shapes produced.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { performance } from 'perf_hooks';

import { DOMParser } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

import { importSvg } from '../src/svg/importer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const FIXTURES = [
  { label: 'tiger',       path: join(REPO, 'examples/tiger.svg') },
];

const N_WARMUP = 5;
const N_RUNS   = 50;

console.log(`${'fixture'.padEnd(20)}  ${'bytes'.padStart(7)}  ${'shapes'.padStart(7)}  ${'avg(ms)'.padStart(8)}  ${'min(ms)'.padStart(8)}  ${'max(ms)'.padStart(8)}`);
console.log('-'.repeat(70));

for (const fx of FIXTURES) {
  if (!existsSync(fx.path)) {
    console.log(`${fx.label.padEnd(20)}  SKIP (missing: ${fx.path})`);
    continue;
  }
  const text = readFileSync(fx.path, 'utf8');

  // Warmup: lets V8 settle inline caches + JIT.
  for (let i = 0; i < N_WARMUP; i++) await importSvg(text);

  // Measured runs.
  const times = new Array(N_RUNS);
  let last;
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now();
    last = await importSvg(text);
    times[i] = performance.now() - t0;
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((s, t) => s + t, 0);
  const avg = sum / N_RUNS;
  const min = times[0];
  const max = times[N_RUNS - 1];
  const shapes = last && last.numShapes != null ? last.numShapes : '?';

  console.log(
    `${fx.label.padEnd(20)}  ${String(text.length).padStart(7)}  ${String(shapes).padStart(7)}  ` +
    `${avg.toFixed(2).padStart(8)}  ${min.toFixed(2).padStart(8)}  ${max.toFixed(2).padStart(8)}`
  );
}

console.log();
console.log('SVG-IMPORT-BENCH DONE');
