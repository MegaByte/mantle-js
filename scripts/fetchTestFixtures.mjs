#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Fetch test fixtures into ignored paths. Font and SVG files are pinned by SHA-256;
// Unicode conformance data uses the version and validation in unicode/fetchUcd.mjs.
// Missing fixtures are reported by the smoke runners as skips. --strict or
// MANTLE_FIXTURES_STRICT=1 makes a fetch failure fatal.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// The ONE pin, read from where fetchUcd.mjs reads it: a second copy of the number here is a second
// thing to forget to bump.
import { UCD_VERSION } from './unicode/lib/ucd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test/font/fixtures');
const EXAMPLES = path.join(ROOT, 'examples');
const UCD_CACHE = path.join(ROOT, 'scripts/unicode/.ucd-cache');

const STRICT = process.argv.includes('--strict') || process.env.MANTLE_FIXTURES_STRICT === '1';

const FIXTURES = [
  {
    // Roboto (Apache-2.0): a real hinted font with kerning/GSUB. Read by the font lane and by
    // every text smoke (textLayoutWidth, textRunMetrics, keepInvisibleShapes, ...).
    name: 'roboto-regular.ttf',
    url: 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Me5Q.ttf',
    sha256: '7277cfb805def6410f317129b8e1f78bdd47d1a4e24c233077d06e88a36e57ae',
  },
  {
    // ...and a woff2 with a TRANSFORMED hmtx, which is the only fixture that exercises the
    // woff2 reader's LSB reconstruction (woff2TransformedHmtx / woff2Collection / cffJs).
    name: 'roboto-regular.woff2',
    url: 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2',
    sha256: 'f6734f8177112c0839b961f96d813fcb189d81b60e96c33278c1983b6f419615',
  },
  {
    // The classic Ghostscript tiger (via Wikimedia Commons). Derived from Ghostscript's
    // examples/tiger.eps -- Ghostscript is AGPL/GPL-licensed, so the file is NOT vendored
    // here. It is the real-asset case for cpatchBoundary, svgImportBench, svgBundleSize and
    // (on the render lane) lbApexClip, lbDegenerateCubicDrop, engineDeclineIsolation,
    // svgRenderBench.
    name: 'tiger.svg',
    dir: 'examples',
    url: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Ghostscript_Tiger.svg',
    sha256: '5211e169283f43ab8ad7ea7998d917d5fbb3c568ac85c1a0217e86792822684d',
  },
];

// The Unicode conformance corpora the three *ConformanceSmoke files read. They are pinned by
// UCD_VERSION, not by hash, and fetchUcd.mjs enforces that pin (it refuses redirects and
// refuses a version still serving draft data). Named here so this script reports on them.
const UCD_TESTS = [
  'NormalizationTest.txt', // nfcConformanceSmoke
  'BidiCharacterTest.txt', // bidiConformanceSmoke
  'GraphemeBreakTest.txt', // breakConformanceSmoke
  'LineBreakTest.txt', // breakConformanceSmoke
];

// Assets no manifest can ever supply. Listed so a run says WHY the lane will skip, instead of
// leaving the reader to discover that _bench is not a typo for a path that should exist.
const UNFETCHABLE = [
  {
    what: 'examples/_bench/*.svg',
    why: 'proprietary benchmark artwork, local-only by policy and never tracked or fetchable',
    who: 'no smoke (lbRampCoverageSmoke reads the fetched examples/tiger.svg in its place); benchmark scripts only',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(DIR, { recursive: true });
const failures = [];

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
    failures.push(`${f.name}: ${e.message} (${f.url})`);
    console.error(`FAIL ${f.name}: ${e.message} (${f.url})`);
  }
}

// ── the Unicode conformance corpora ───────────────────────────────────────────────────────
// PRESENT IS NOT ENOUGH; IT HAS TO BE THE PINNED VERSION. These are pinned by UCD_VERSION rather
// than by hash, and testing `existsSync` alone would let a cache left behind by an older pin (or
// copied in from another checkout) read as "ok", and the three conformance smokes would then score
// the shipped tries against the WRONG corpus. That is not a skip and not a loud failure: it is a
// lane reporting real-looking numbers about a comparison nobody made. A cache one Unicode version
// behind the pin scores a handful of grapheme and line-break cases "wrong", which is what a version
// difference looks like from the inside.
//
// Every UCD data file opens with `# <Name>-<version>.txt`, so the check is that one line. A stale
// file is treated exactly as a missing one: re-fetched, and reported by name if it does not come
// back right.
const ucdVersionOf = (p) => {
  try {
    return (
      (readFileSync(p, 'utf8')
        .slice(0, 200)
        .split('\n', 1)[0]
        .match(/-(\d+\.\d+\.\d+)\.txt/) || [])[1] || null
    );
  } catch {
    return null;
  }
};
const ucdBad = (n) => {
  const p = path.join(UCD_CACHE, n);
  if (!existsSync(p)) return 'absent';
  const v = ucdVersionOf(p);
  return v === UCD_VERSION ? null : `${v || 'unversioned'}, want ${UCD_VERSION}`;
};
const ucdMissing = UCD_TESTS.filter((n) => ucdBad(n));
if (!ucdMissing.length) {
  console.log(
    `ok unicode conformance corpora (cached, UCD ${UCD_VERSION}: ${UCD_TESTS.join(', ')})`,
  );
} else if (process.env.MANTLE_SKIP_UCD === '1') {
  console.log(
    `skip unicode conformance corpora (MANTLE_SKIP_UCD=1); ` +
      ucdMissing.map((n) => `${n} (${ucdBad(n)})`).join(', '),
  );
} else {
  console.log(
    `fetching unicode conformance corpora (${ucdMissing.map((n) => `${n}: ${ucdBad(n)}`).join(', ')})`,
  );
  // fetchUcd.mjs vendors the whole pinned UCD set, of which these four are part; it owns the
  // version pin and its guards, so it is invoked rather than reimplemented. Cached afterwards.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/unicode/fetchUcd.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const still = UCD_TESTS.filter((n) => ucdBad(n));
  if (still.length) {
    const why = still.map((n) => `${n} (${ucdBad(n)})`).join(', ');
    failures.push(
      `unicode conformance corpora: ${why} ` +
        `(fetchUcd.mjs exit ${r.status === null ? 'signal ' + r.signal : r.status})`,
    );
    console.error(`FAIL unicode conformance corpora: ${why}`);
  }
}

// ── what nobody can fetch ─────────────────────────────────────────────────────────────────
for (const u of UNFETCHABLE) {
  const tag = existsSync(path.join(ROOT, u.what.replace(/\/\*.*$/, '')))
    ? 'present locally'
    : 'absent';
  console.log(`note ${u.what}: ${tag} — ${u.why}\n     needed by: ${u.who}`);
}

if (failures.length) {
  console.error(`\nfetchTestFixtures: ${failures.length} asset(s) unavailable:`);
  for (const f of failures) console.error('  ' + f);
  console.error('The smokes that need them will report SKIP (exit 77), not PASS and not FAIL.');
  if (STRICT) {
    console.error('--strict: treating that as fatal.');
    process.exit(1);
  }
  process.exit(0);
}
console.log('\nfetchTestFixtures: all fetchable fixtures present');
