// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleSizeClaimsSmoke.mjs - every size the documentation states is measured, and has not drifted.
//
// The README, the repository README, STRIPPING.md and docs/NATIVE_FALLBACK.md mark each bundle-size number with a
// comment right after it: `132 KB<!--size:svg-->` (min+gzip of a single-file esbuild bundle of that entry; `+N` rows are
// extra over font/text) or `2004 KB<!--src:fallback-->` (statically reachable source). This checks each against
// test/data/bundleSizes.json, which scripts/measureBundleSizes.mjs writes, to within 20%. Where esbuild is installed
// it also RE-MEASURES the marked entries from the current tree and checks the file has not gone stale. Without esbuild
// (it is not a dependency) it says so and checks the documents against the recorded numbers.
// A KB figure in those documents without a marker fails: an unmeasured size goes stale unnoticed.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEsbuild, measure, sizeOf, SIZES_FILE } from '../scripts/measureBundleSizes.mjs';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md',
  'docs/NATIVE_FALLBACK.md',
  '../README.md',
  '../STRIPPING.md',
  '../FEATURES.md',
  '../SPRITE_SHEET.md',
]
  .map((f) => path.join(PKG, f))
  .filter((f) => existsSync(f));
const rec = JSON.parse(readFileSync(SIZES_FILE, 'utf8'));
const TOL = 0.2;
const within = (claim, actual) => Math.abs(claim - actual) <= Math.max(TOL * actual, 0.6);

const claims = [];
for (const doc of DOCS) {
  const text = readFileSync(doc, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(\+?)~?(\d+(?:\.\d+)?) KB<!--(size|src):([^>]+)-->/g)) {
      claims.push({
        doc: path.basename(doc),
        line: i + 1,
        plus: m[1] === '+',
        value: Number(m[2]),
        kind: m[3],
        key: m[4],
      });
    }
    // An unmarked KB figure. Lines about Unity/IL2CPP footprints are not bundle sizes.
    for (const m of line.matchAll(/(\d+(?:\.\d+)?) KB(?!<!--)/g)) {
      if (/IL2CPP|Unity/.test(line) || /\b\d+ ?KB<!--/.test(line.slice(m.index))) continue;
      fail(`${path.basename(doc)}:${i + 1}: "${m[0]}" is a size with no <!--size:KEY--> marker`);
    }
  });
}
// a standalone package has only its own docs (10 claims); the monorepo adds the repository-root docs
claims.length >= (existsSync(path.join(PKG, '../README.md')) ? 20 : 8)
  ? ok(`${claims.length} marked size claims found in ${DOCS.length} documents`)
  : fail(`only ${claims.length} marked claims; the markers were removed`);

const actualOf = (data, c) =>
  c.kind === 'src' ? data.sizes[c.key].staticSrc / 1024 : sizeOf(data.sizes, c.key) / 1024;
for (const c of claims) {
  let actual;
  try {
    actual = actualOf(rec, c);
  } catch {
    fail(`${c.doc}:${c.line}: unknown size key '${c.key}'`);
    continue;
  }
  if (!within(c.value, actual))
    fail(
      `${c.doc}:${c.line}: claims ${c.value} KB for ${c.key}, recorded ${actual.toFixed(1)} KB (>20% apart): run scripts/measureBundleSizes.mjs --write and fix the text`,
    );
}
if (!failures) ok('every claim is within 20% of the recorded measurement');

const esbuild = await loadEsbuild(process.env.MANTLE_BUNDLER_TOOLS);
if (!esbuild) {
  console.log(
    'note: esbuild is not installed; the recorded numbers were not re-measured (set MANTLE_BUNDLER_TOOLS to a dir with esbuild to re-measure)',
  );
} else {
  const keys = new Set(
    claims
      .map((c) => c.key)
      .flatMap((k) => (k.startsWith('+') ? ['font/text', 'font/text+' + k.slice(1)] : [k])),
  );
  const now = await measure(esbuild, { only: [...keys] });
  let stale = 0;
  for (const c of claims) {
    const a = actualOf({ sizes: now }, c);
    if (!within(c.value, a)) {
      stale++;
      fail(
        `${c.doc}:${c.line}: claims ${c.value} KB for ${c.key}, the current tree measures ${a.toFixed(1)} KB`,
      );
    }
  }
  if (!stale)
    ok(
      `re-measured ${keys.size} entries with esbuild ${esbuild.version}: every claim holds on the current tree`,
    );
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('bundleSizeClaimsSmoke: PASS');
