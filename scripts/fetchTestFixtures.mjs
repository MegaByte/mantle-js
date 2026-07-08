#!/usr/bin/env node
// fetchTestFixtures.mjs — download third-party test fixtures we don't vendor.
//
// The font smokes need a real hinted font with kerning/GSUB (Roboto,
// Apache-2.0) plus a woff2 with a transformed hmtx. Rather than committing
// Google's files to this repo, fetch them once from pinned, versioned URLs
// and verify by sha256. Files land in test/font/fixtures/ (gitignored);
// re-running is a no-op when the hashes already match.
//
//   node scripts/fetchTestFixtures.mjs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/font/fixtures');
const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples');

const FIXTURES = [
  {
    name: 'roboto-regular.ttf',
    url: 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Me5Q.ttf',
    sha256: '7277cfb805def6410f317129b8e1f78bdd47d1a4e24c233077d06e88a36e57ae',
  },
  {
    name: 'roboto-regular.woff2',
    url: 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2',
    sha256: 'f6734f8177112c0839b961f96d813fcb189d81b60e96c33278c1983b6f419615',
  },
  {
    // The classic Ghostscript tiger (via Wikimedia Commons). Derived from
    // Ghostscript's examples/tiger.eps — Ghostscript is AGPL/GPL-licensed,
    // so the file is NOT vendored in this repo; it is fetched locally for
    // the perf benches (svgImportBench / svgRenderBench / svgBundleSize),
    // which skip it gracefully when absent.
    name: 'tiger.svg',
    dir: 'examples',
    url: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Ghostscript_Tiger.svg',
    sha256: '5211e169283f43ab8ad7ea7998d917d5fbb3c568ac85c1a0217e86792822684d',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(DIR, { recursive: true });
let failures = 0;
for (const f of FIXTURES) {
  const dest = path.join(f.dir === 'examples' ? EXAMPLES : DIR, f.name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === f.sha256) {
    console.log(`ok ${f.name} (cached)`);
    continue;
  }
  try {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== f.sha256) throw new Error(`sha256 mismatch: got ${got}`);
    writeFileSync(dest, buf);
    console.log(`fetched ${f.name} (${buf.length} bytes)`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${f.name}: ${e.message} (${f.url})`);
  }
}
if (failures) {
  console.error('\nfetchTestFixtures: some fixtures missing — font smokes that need them will fail.');
  process.exit(1);
}
console.log('\nfetchTestFixtures: all fixtures present');
