// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _assets.mjs — the one place a smoke asks for an asset git does not carry.
//
// (Not to be confused with test/_fixtures.mjs, which emits a GENERATED smoke SVG into
// examples/smoke/. This file is about assets that live outside the repository entirely.)
//
// Three kinds of asset the lane needs live outside the repository:
//
//   * the fonts (Roboto, Apache-2.0)          test/font/fixtures/   FETCHABLE
//   * the Ghostscript tiger (AGPL/GPL)        examples/tiger.svg    FETCHABLE
//   * the benchmark corpus                    examples/_bench/      never FETCHABLE
//
// The first two are pinned by sha256 in scripts/fetchTestFixtures.mjs and land in
// gitignored paths; `npm run fetch:fixtures` (also `pretest`) puts them there. The third
// is proprietary artwork that is local-only by policy, so no manifest can ever supply it.
//
// WHY A HELPER AND NOT `readFileSync`. In a fresh checkout that has not fetched, a bare read
// opens the lane with ENOENT stack traces that look exactly like code failures. Guarding the
// read with `process.exit(0)` is worse: the lane then prints PASS while the assertions that
// need the asset never ran.
//
// So: a missing asset exits SKIP_EXIT (77, the autotools convention), which the runners
// count and print in their own section, and the message names the asset AND how to get it
// in one line. 77 is chosen because it is not a signal code and no smoke returns it for any
// other reason.
//
// Two shapes:
//
//   skip(reason)      — nothing in this file can run. Exits 77 immediately; put it above
//                       the first assertion (and, in a render smoke, above launchBrowser).
//   noteSkip(reason)  — one SECTION cannot run, the rest still should. The assertions that
//                       do not need the asset still execute and still fail loudly; at exit,
//                       a run that would have ended 0 ends 77 instead with the reasons
//                       printed. (Verified on node 26: reassigning process.exitCode from an
//                       'exit' handler wins over both a natural exit and `process.exit(0)`.)
//
// A smoke must never report PASS for work it did not do — that is the whole point of the
// exit code. Use noteSkip over skip when real coverage survives the missing asset.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Exit status a smoke returns when it could not run for want of an out-of-tree asset. */
export const SKIP_EXIT = 77;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** js.kontek.mantle/ */
export const PKG_ROOT = path.resolve(HERE, '..');

const FETCH_HINT = 'run `npm run fetch:fixtures` (scripts/fetchTestFixtures.mjs)';
const BENCH_HINT =
  'the examples/_bench corpus is proprietary artwork, local-only and never fetchable; ' +
  'copy the SVGs into js.kontek.mantle/examples/_bench/ to run this case';

const SELF = path.basename(process.argv[1] || 'smoke').replace(/\.mjs$/, '');

/** Absolute path of a fetched font fixture, e.g. fontFixture('roboto-regular.ttf'). */
export const fontFixture = (name) => path.join(PKG_ROOT, 'test', 'font', 'fixtures', name);
/** Absolute path of an asset under examples/, e.g. example('tiger.svg'). */
export const example = (rel) => path.join(PKG_ROOT, 'examples', rel);
/** Absolute path inside the proprietary benchmark corpus, e.g. benchAsset('scene.svg'). */
export const benchAsset = (rel) => path.join(PKG_ROOT, 'examples', '_bench', rel);

/** Names of benchmark-corpus assets a run asks for: MANTLE_BENCH_NAMES, comma-separated, each a file under examples/_bench/
 *  (`.svg` optional). Empty when unset, so no run names a proprietary asset by default. */
export const benchNames = () =>
  (process.env.MANTLE_BENCH_NAMES || '')
    .split(',')
    .map((s) => s.trim().replace(/\.svg$/, ''))
    .filter(Boolean);
/** Printed when MANTLE_BENCH_NAMES is unset and a run's benchmark-corpus leg is skipped. */
export const BENCH_UNSET =
  'SKIP the examples/_bench leg: set MANTLE_BENCH_NAMES to comma-separated asset names under examples/_bench/';

/** True when the asset is on disk. */
export const have = (abs) => existsSync(abs);

/** The one-line pointer printed for a missing asset: what is absent and how to get it. */
export function missingHint(abs) {
  const rel = path.relative(PKG_ROOT, abs);
  const how = rel.startsWith(path.join('examples', '_bench')) ? BENCH_HINT : FETCH_HINT;
  return `${rel} is absent — ${how}`;
}

/** Nothing in this file can run: print the pointer and exit 77. Never returns. */
export function skip(reason) {
  console.log(`SKIP ${SELF}: ${reason}`);
  process.exit(SKIP_EXIT);
}

const _noted = [];
let _hooked = false;

/**
 * One section could not run. The rest of the file still runs (and still fails loudly on a
 * real defect); a run that would have ended 0 ends 77 instead, so the lane can never read
 * this as a pass.
 */
export function noteSkip(reason) {
  _noted.push(reason);
  if (_hooked) return;
  _hooked = true;
  process.on('exit', (code) => {
    if (code !== 0) return; // a real failure keeps its own status
    for (const r of _noted) console.log(`SKIP ${SELF}: ${r}`);
    process.exitCode = SKIP_EXIT;
  });
}

/** `abs` if present, else skip the whole file with the standard pointer. */
export function requireAsset(abs) {
  if (!existsSync(abs)) skip(missingHint(abs));
  return abs;
}

/** `abs` if present, else note the section as skipped and return null. */
export function optionalAsset(abs) {
  if (existsSync(abs)) return abs;
  noteSkip(missingHint(abs));
  return null;
}

/** Bytes of a required asset (Buffer, or a string when an encoding is given). */
export function readAsset(abs, encoding) {
  return readFileSync(requireAsset(abs), encoding);
}
