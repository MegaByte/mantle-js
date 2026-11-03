// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// ucdFixturePinSmoke — a cached Unicode conformance corpus has to be the PINNED version, and
// `pretest` has to say so.
//
// The three conformance smokes (nfcConformance, bidiConformance, breakConformance) score the
// shipped tries against corpora that are pinned by UCD_VERSION rather than by hash, because the
// file contents change with every Unicode release. `scripts/fetchTestFixtures.mjs` — which runs as
// `pretest`, i.e. before every `npm test` — must not decide the cache is good on `existsSync` ALONE.
// A cache left behind by an older pin, or copied in from a checkout of another version, would read as
//
//     ok unicode conformance corpora (cached: NormalizationTest.txt, ...)
//
// and the lane would compare 18.0.0 tries against a 17.0.0 corpus. That is the worst of the three
// possible outcomes: not a skip, not a loud failure, but real-looking numbers about a comparison
// nobody made (a handful of grapheme and line-break cases "wrong", every one a Unicode version
// difference).
//
// Every UCD data file opens with `# <Name>-<version>.txt`, so the check costs one line per file.
// The fetcher treats a stale file exactly as a missing one: re-fetch it, and name it with the
// version it actually has if it does not come back right.
//
// No GPU, no network: this reads the cache on disk and the fetcher's source.
//   (a) the fetcher reads the pin from scripts/unicode/lib/ucd.mjs rather than carrying its own
//       copy of the number, and tests the cached files' versions against it;
//   (b) whatever is cached right now IS the pinned version (or absent, which the smokes skip on);
//   (c) the three conformance smokes' corpora are the four files the fetcher names.
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { UCD_VERSION } from '../scripts/unicode/lib/ucd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const CORPORA = [
  'NormalizationTest.txt',
  'BidiCharacterTest.txt',
  'GraphemeBreakTest.txt',
  'LineBreakTest.txt',
];
const CACHE = path.join(ROOT, 'scripts/unicode/.ucd-cache');
const src = readFileSync(path.join(ROOT, 'scripts/fetchTestFixtures.mjs'), 'utf8');

// ---- (a) the fetcher checks the version, and reads the pin from one place ------------------------
{
  ok(
    /import \{ UCD_VERSION \} from '\.\/unicode\/lib\/ucd\.mjs'/.test(src),
    '(a) fetchTestFixtures imports UCD_VERSION instead of repeating the number',
  );
  ok(
    src.includes('(\\d+\\.\\d+\\.\\d+)\\.txt'),
    "(a) ...and reads each cached file's own `# <Name>-<version>.txt` header",
  );
  ok(/=== UCD_VERSION/.test(src), '(a) ...and compares it to the pin');
  // The defect in one line: the membership test must not be presence alone.
  ok(
    !/const ucdMissing = UCD_TESTS\.filter\(\(n\) => !existsSync\(/.test(src),
    '(a) and "cached" is not decided by existsSync alone — which would let a stale corpus through',
  );
}

// ---- (b) what is on disk now --------------------------------------------------------------------
{
  const rows = CORPORA.map((n) => {
    const p = path.join(CACHE, n);
    if (!existsSync(p)) return [n, null];
    const head = readFileSync(p, 'utf8').slice(0, 200).split('\n', 1)[0];
    return [n, (head.match(/-(\d+\.\d+\.\d+)\.txt/) || [])[1] || 'unversioned'];
  });
  const present = rows.filter(([, v]) => v !== null);
  const wrong = present.filter(([, v]) => v !== UCD_VERSION);
  ok(
    wrong.length === 0,
    `(b) every cached corpus is the pinned UCD ${UCD_VERSION} — ${present.length} of ${CORPORA.length} present` +
      `${wrong.length ? ', WRONG: ' + wrong.map(([n, v]) => `${n} is ${v}`).join(', ') : ''}` +
      `${present.length < CORPORA.length ? ' (absent ones make the conformance smokes SKIP, which is loud)' : ''}`,
  );
}

// ---- (c) the corpora the fetcher names are the ones the smokes read -------------------------------
{
  const listed = [...src.matchAll(/'([A-Za-z]+Test\.txt)'/g)].map((m) => m[1]);
  const missing = CORPORA.filter((n) => !listed.includes(n));
  ok(
    missing.length === 0,
    `(c) fetchTestFixtures names all ${CORPORA.length} conformance corpora` +
      `${missing.length ? ' -- missing ' + missing.join(', ') : ''}`,
  );
  for (const f of [
    'test/font/nfcConformanceSmoke.mjs',
    'test/font/bidiConformanceSmoke.mjs',
    'test/font/breakConformanceSmoke.mjs',
  ]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) {
      ok(false, `(c) ${f} is missing`);
      continue;
    }
    const s = readFileSync(p, 'utf8');
    const reads = CORPORA.filter((n) => s.includes(n));
    ok(reads.length > 0, `(c) ${path.basename(f)} reads ${reads.join(', ') || 'NO corpus'}`);
  }
}

if (fail) {
  console.error(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log('\nucdFixturePinSmoke: all checks passed');
