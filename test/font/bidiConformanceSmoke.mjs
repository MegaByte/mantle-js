// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bidiConformanceSmoke.mjs — the OFFICIAL UAX #9 conformance suite.
//
// bidi.js implements the full rule set (P2/P3, X1-X10, W1-W7, N0-N2, I1/I2,
// L1/L2, bracket pairs, isolates). Reading those rules and agreeing with them
// is weak evidence; Unicode publishes BidiCharacterTest.txt precisely so an
// implementation can be checked against every case the committee thought
// mattered. It is already cached under scripts/unicode/.ucd-cache for the
// property-table codegen, so this costs nothing to run.
//
// BidiCharacterTest.txt format, semicolon-separated:
//   codepoints ; paragraph-direction ; resolved-paragraph-level ;
//   resolved-levels ; visual-order
// where paragraph-direction is 0=LTR, 1=RTL, 2=auto, a level of 'x' means the
// character is removed (explicit formatting / BN) and is absent from the
// visual order.
//
// Reports pass rate and the first few failures with their input, so a
// regression names the rule that broke rather than just a count.

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveLevels, reorderLine, BaseDirection } from '../../src/font/bidi.js';
import { skip } from '../_assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '../../scripts/unicode/.ucd-cache/BidiCharacterTest.txt');
if (!existsSync(FILE)) {
  skip(
    'scripts/unicode/.ucd-cache/BidiCharacterTest.txt is absent — run `npm run fetch:fixtures` ' +
      '(which delegates to scripts/unicode/fetchUcd.mjs)',
  );
}

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// BidiCharacterTest's paragraph-direction column is 0=LTR, 1=RTL, 2=auto.
// BaseDirection is NUMERIC ({Auto:0, Ltr:1, Rtl:2}) — passing the strings
// 'ltr'/'rtl' matches neither branch of resolveBaseDirection, so every case
// would silently run as AUTO (about half pass). Map the columns properly.
const DIR = [BaseDirection.Ltr, BaseDirection.Rtl, BaseDirection.Auto];
let total = 0,
  levelsOk = 0,
  orderOk = 0;
const badLevels = [],
  badOrder = [];

for (const line of readFileSync(FILE, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const f = t.split(';');
  if (f.length < 5) continue;

  const cps = f[0]
    .trim()
    .split(/\s+/)
    .map((h) => parseInt(h, 16));
  const paraDir = Number(f[1]);
  const wantLevels = f[3].trim().length ? f[3].trim().split(/\s+/) : [];
  const wantOrder = f[4].trim().length ? f[4].trim().split(/\s+/).map(Number) : [];
  total++;

  const baseDir = DIR[paraDir];
  let gotLevels;
  try {
    gotLevels = resolveLevels(cps, baseDir);
  } catch (e) {
    if (badLevels.length < 4) badLevels.push({ t, why: 'threw: ' + e.message });
    continue;
  }

  // Levels: 'x' entries are removed characters — the suite does not constrain
  // their level, so compare only the positions it pins.
  let lvlMatch = gotLevels.length === wantLevels.length;
  if (lvlMatch) {
    for (let i = 0; i < wantLevels.length; i++) {
      if (wantLevels[i] === 'x') continue;
      if (gotLevels[i] !== Number(wantLevels[i])) {
        lvlMatch = false;
        break;
      }
    }
  }
  if (lvlMatch) levelsOk++;
  else if (badLevels.length < 4) {
    badLevels.push({
      t,
      why: `levels ${JSON.stringify(Array.from(gotLevels))} want ${f[3].trim()}`,
    });
  }

  // Visual order: reorderLine gives a permutation over ALL positions; the
  // suite lists only the retained ones, so drop the 'x' positions before
  // comparing.
  const removed = new Set();
  for (let i = 0; i < wantLevels.length; i++) if (wantLevels[i] === 'x') removed.add(i);
  const gotOrder = Array.from(reorderLine(gotLevels)).filter((i) => !removed.has(i));
  const ordMatch =
    gotOrder.length === wantOrder.length && gotOrder.every((v, i) => v === wantOrder[i]);
  if (ordMatch) orderOk++;
  else if (badOrder.length < 4) {
    badOrder.push({
      t,
      why: `order ${JSON.stringify(gotOrder)} want ${JSON.stringify(wantOrder)}`,
    });
  }
}

console.log(`  BidiCharacterTest.txt: ${total} cases`);
console.log(`  levels ${levelsOk}/${total} (${((levelsOk / total) * 100).toFixed(2)}%)`);
console.log(`  order  ${orderOk}/${total} (${((orderOk / total) * 100).toFixed(2)}%)`);

if (total < 90000)
  fail(`only ${total} cases parsed — the suite file looks truncated, this would be vacuous`);
else ok(`${total} conformance cases parsed`);

// Full conformance is the bar: these are the cases Unicode publishes as
// definitive. Anything less means a rule is wrong for real text.
if (levelsOk === total) ok('resolved levels match UAX #9 on every case');
else {
  fail(`resolved levels differ on ${total - levelsOk} case(s)`);
  for (const b of badLevels) console.error('   ', b.t.slice(0, 100), '\n      ', b.why);
}
if (orderOk === total) ok('visual reorder matches UAX #9 on every case');
else {
  fail(`visual order differs on ${total - orderOk} case(s)`);
  for (const b of badOrder) console.error('   ', b.t.slice(0, 100), '\n      ', b.why);
}

console.log();
console.log(failures === 0 ? 'BIDI-CONFORMANCE PASS' : `BIDI-CONFORMANCE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
