// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Paired, randomized fresh-import survey. This measures CPU import only:
// no GL, upload, shader preparation, drawing or readback is performed.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
Object.assign(globalThis, { DOMParser, XMLSerializer });
console.warn = () => {};
const { default: importSvg } = await import('../../src/svg/importer.js');
const [assetRoot, output, roundsArg] = process.argv.slice(2);
if (!assetRoot || !output)
  throw Error('normalizePrep.mjs ASSET_ROOT OUTPUT.json [ROUNDS=18]; run with --expose-gc');
const rounds = +(roundsArg || 18),
  rows = [];
let seed = 0x7120021;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const med = (a) => {
  const b = a.slice().sort((a, b) => a - b);
  return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2;
};
const summary = (a) => ({
  median: med(a),
  min: Math.min(...a),
  p10: a.slice().sort((a, b) => a - b)[Math.floor((a.length - 1) * 0.1)],
  p90: a.slice().sort((a, b) => a - b)[Math.floor((a.length - 1) * 0.9)],
});
const assets = (process.env.NORMALIZE_ASSETS || '').split(',').filter(Boolean); // SVG paths under ASSET_ROOT
if (!assets.length) {
  console.log(
    'SKIP normalizePrep: set NORMALIZE_ASSETS to comma-separated SVG paths under ASSET_ROOT',
  );
  process.exit(0);
}
const report = {
  scope:
    'CPU fresh SVG import only; no GL/upload/compile/draw/readback; exclusive scheduler job; explicit GC outside timer; two untimed warmup rounds per asset; 18 balanced randomized construction orders by default; duplicate normalization-disabled A/A controls',
  seed: 0x7120021,
  rounds,
  rows,
};
for (const name of assets) {
  const svg = readFileSync(path.join(assetRoot, name), 'utf8'),
    samples = [],
    planes = {};
  const orders = shuffle(
    Array.from({ length: rounds }, (_, i) =>
      [
        ['a', 'b', 'normalized'],
        ['a', 'normalized', 'b'],
        ['b', 'a', 'normalized'],
        ['b', 'normalized', 'a'],
        ['normalized', 'a', 'b'],
        ['normalized', 'b', 'a'],
      ][i % 6].slice(),
    ),
  );
  for (let round = -2; round < rounds; round++) {
    const order = round < 0 ? shuffle(['a', 'b', 'normalized']) : orders[round],
      ms = {};
    for (const arm of order) {
      globalThis.gc?.();
      const start = performance.now();
      const s = await importSvg(svg, {
        preserveViewport: true,
        normalizeFill: arm === 'normalized',
      });
      ms[arm] = performance.now() - start;
      if (round === rounds - 1)
        planes[arm] = {
          normalizedShapes: s.authoredBandsByShape?.filter(Boolean).length || 0,
          hashes: Object.fromEntries(
            ['curves', 'bands', 'meta'].map((k) => [
              k,
              createHash('sha256').update(new Uint8Array(s[k])).digest('hex'),
            ]),
          ),
        };
    }
    if (round >= 0)
      samples.push({
        order,
        ms,
        aaRatio: ms.b / ms.a,
        normalizedRatio: ms.normalized / ((ms.a + ms.b) / 2),
        addedMs: ms.normalized - (ms.a + ms.b) / 2,
      });
  }
  const row = {
    name,
    samples,
    planes,
    arms: Object.fromEntries(
      ['a', 'b', 'normalized'].map((k) => [k, summary(samples.map((s) => s.ms[k]))]),
    ),
    aa: summary(samples.map((s) => s.aaRatio)),
    normalized: summary(samples.map((s) => s.normalizedRatio)),
    addedMs: summary(samples.map((s) => s.addedMs)),
  };
  rows.push(row);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      name,
      arms: row.arms,
      aa: row.aa,
      normalized: row.normalized,
      addedMs: row.addedMs,
    }),
  );
}
