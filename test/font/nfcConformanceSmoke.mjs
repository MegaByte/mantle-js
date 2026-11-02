// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nfcConformanceSmoke.mjs — the OFFICIAL UAX #15 conformance suite for NFC.
//
// nfc.js composes through decomposition + canonical ordering + Hangul, and
// reading those rules and agreeing with them is weak evidence. Unicode
// publishes NormalizationTest.txt precisely so an implementation can be checked
// against every case the committee thought mattered, and it is already cached
// under scripts/unicode/.ucd-cache for the property-table codegen, so this
// costs nothing to run, and a change in the JS implementation has something to fail.
//
// NormalizationTest.txt format, semicolon-separated, five columns:
//   source ; NFC ; NFD ; NFKC ; NFKD
// The invariants for a canonical composer are
//   NFC(c1) == NFC(c2) == NFC(c3) == c2   and   NFC(c4) == NFC(c5) == c4
// (columns 4/5 are the COMPATIBILITY forms, which NFC must leave alone once
// they are already compatibility-decomposed: NFC of them is c4, not c2.)
// Lines in @Part1 are the per-codepoint sweep; the rest are targeted cases.
//
// Reports the pass rate and the first few failures with their input, so a
// regression names the case that broke rather than just a count.

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { toNFCCodepoints } from '../../src/font/unicode/nfc.js';
import { skip } from '../_assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '../../scripts/unicode/.ucd-cache/NormalizationTest.txt');
if (!existsSync(FILE)) {
  skip(
    'scripts/unicode/.ucd-cache/NormalizationTest.txt is absent — run `npm run fetch:fixtures` ' +
      '(which delegates to scripts/unicode/fetchUcd.mjs)',
  );
}

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const hex = (s) =>
  s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((h) => parseInt(h, 16));
const show = (cps) => cps.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join(' ');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

let total = 0,
  pass = 0;
const bad = [];
// Every code point NOT named in @Part1 must be unchanged by NFC (the file's own
// closing invariant). Track which ones appear so the sweep can check the rest.
const named = new Set();

for (const line of readFileSync(FILE, 'utf8').split('\n')) {
  const t = line.split('#')[0].trim();
  if (!t || t.startsWith('@')) continue;
  const f = t.split(';');
  if (f.length < 5) continue;
  const [c1, c2, c3, c4, c5] = [hex(f[0]), hex(f[1]), hex(f[2]), hex(f[3]), hex(f[4])];
  if (c1.length === 1) named.add(c1[0]);
  for (const [src, want, which] of [
    [c1, c2, 'c1'],
    [c2, c2, 'c2'],
    [c3, c2, 'c3'],
    [c4, c4, 'c4'],
    [c5, c4, 'c5'],
  ]) {
    total++;
    const got = toNFCCodepoints(src);
    if (same(got, want)) pass++;
    else if (bad.length < 5)
      bad.push(`NFC(${which}=${show(src)}) = ${show(got)}, want ${show(want)}`);
  }
}

ok(`${total} conformance assertions parsed`);
if (pass === total) ok(`NFC matches UAX #15 on every case (${total})`);
else fail(`NFC: ${total - pass} of ${total} wrong\n  ${bad.join('\n  ')}`);

// The unnamed-code-point invariant: X not in Part1 ⇒ NFC(X) == X.
let swept = 0,
  sweepBad = 0;
const sweepShow = [];
for (let cp = 0; cp < 0x110000; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates
  if (named.has(cp)) continue;
  swept++;
  const got = toNFCCodepoints([cp]);
  if (got.length !== 1 || got[0] !== cp) {
    sweepBad++;
    if (sweepShow.length < 5) sweepShow.push(`NFC(${show([cp])}) = ${show(got)}`);
  }
}
if (!sweepBad) ok(`every code point outside @Part1 is unchanged by NFC (${swept})`);
else fail(`${sweepBad} of ${swept} unnamed code points changed\n  ${sweepShow.join('\n  ')}`);

if (failures) {
  console.error(`NFC-CONFORMANCE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nNFC-CONFORMANCE PASS');
