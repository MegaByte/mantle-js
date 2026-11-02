// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgBundleSize.mjs — measure per-section + per-shape byte cost of
// an imported SVG bundle.
//
// Reports every ArrayBuffer field on the importer output, in bytes,
// sorted descending, plus per-shape averages for the fields that
// scale linearly with shape count (curves, bands, meta, solid,
// curveGeom).
//
// Usage: node test/svgBundleSize.mjs

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
import { importSvg } from '../src/index.js';
import { missingHint, noteSkip } from './_assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FIXTURES = [{ label: 'tiger', svgPath: path.join(ROOT, 'examples/tiger.svg') }];

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

for (const f of FIXTURES) {
  if (!existsSync(f.svgPath)) {
    noteSkip(missingHint(f.svgPath));
    continue;
  }
  const svg = readFileSync(f.svgPath, 'utf8');
  const b = await importSvg(svg);

  const rows = [];
  let total = 0;
  for (const [k, v] of Object.entries(b)) {
    if (v instanceof ArrayBuffer) {
      rows.push({ field: k, bytes: v.byteLength });
      total += v.byteLength;
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes);

  const n = b.numShapes;
  console.log();
  console.log(`== ${f.label} (${n} shapes) ==`);
  console.log();
  console.log(
    `${'section'.padEnd(18)} ${'bytes'.padStart(10)}  ${'% total'.padStart(8)}  ${'B/shape'.padStart(8)}`,
  );
  console.log('-'.repeat(54));
  for (const r of rows) {
    const pct = ((r.bytes / total) * 100).toFixed(1);
    const perShape = (r.bytes / n).toFixed(1);
    console.log(
      `${r.field.padEnd(18)} ${String(r.bytes).padStart(10)}  ${pct.padStart(7)}%  ${perShape.padStart(8)}`,
    );
  }
  console.log('-'.repeat(54));
  console.log(
    `${'TOTAL'.padEnd(18)} ${String(total).padStart(10)}  ${'100.0%'.padStart(8)}  ${(total / n).toFixed(1).padStart(8)}`,
  );
  console.log();
  console.log(
    `pretty: total ${fmtBytes(total)} across ${n} shapes (${fmtBytes(total / n)}/shape avg)`,
  );
}
