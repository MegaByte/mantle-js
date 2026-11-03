// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// breakConformanceSmoke.mjs — the OFFICIAL UAX #29 and UAX #14 conformance
// suites for grapheme clustering and line breaking.
//
// graphemes.js implements GB1-GB999 (including GB9c InCB and GB11 ExtPict ZWJ)
// and lineBreak.js implements LB1-LB31; reading those rules and agreeing with
// them is weak evidence. Unicode publishes GraphemeBreakTest.txt and
// LineBreakTest.txt precisely so an implementation can be checked against every
// case the committee thought mattered, and both are already cached under
// scripts/unicode/.ucd-cache for the property-table codegen, so a change in the
// JS implementation — or a Unicode version bump — has something to fail.
//
// Both files share one format: a line of code points separated by ÷ (break)
// and × (no break), starting and ending with a mark, then a # comment naming
// the rule that decides each position. The first mark is sot and the last eot,
// which both algorithms report as their own boundary conventions:
//   graphemeBoundaries returns indices [0..n], so position i is a break iff i
//   is in that set; lineBreakActions returns n+1 actions where entry 0 is sot
//   (PROHIBITED by construction) and entry n is eot (MANDATORY).
// So the comparison skips position 0 for line breaking (the file marks sot ×)
// and compares every interior position plus eot.
//
// Reports the pass rate per suite and the first few failures with the rule the
// file names, so a regression says which rule broke rather than just a count.

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { graphemeBoundaries } from '../../src/font/unicode/graphemes.js';
import { lineBreakActions, PROHIBITED } from '../../src/font/unicode/lineBreak.js';
import { skip } from '../_assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '../../scripts/unicode/.ucd-cache');
const GB = join(CACHE, 'GraphemeBreakTest.txt');
const LB = join(CACHE, 'LineBreakTest.txt');
if (!existsSync(GB) || !existsSync(LB)) {
  skip(
    'scripts/unicode/.ucd-cache/GraphemeBreakTest.txt / LineBreakTest.txt are absent — run ' +
      '`npm run fetch:fixtures` (which delegates to scripts/unicode/fetchUcd.mjs)',
  );
}

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);
const show = (cps) => cps.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join(' ');

// "÷ 000D × 000A ÷" -> { cps: [0x0D, 0x0A], breaks: [true, false, true] }
// breaks[i] is the mark BEFORE code point i, and breaks[n] is eot.
function parseCase(line) {
  const [data, comment = ''] = line.split('#');
  const toks = data.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const cps = [],
    breaks = [];
  for (const tok of toks) {
    if (tok === '÷') breaks.push(true);
    else if (tok === '×') breaks.push(false);
    else cps.push(parseInt(tok, 16));
  }
  if (breaks.length !== cps.length + 1) return null;
  return { cps, breaks, rule: comment.trim() };
}

function run(file, name, breaksOf, { skipSot }) {
  let total = 0,
    pass = 0;
  const bad = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('@')) continue;
    const c = parseCase(t);
    if (!c) continue;
    total++;
    let got;
    try {
      got = breaksOf(c.cps);
    } catch (e) {
      if (bad.length < 5) bad.push(`${show(c.cps)} threw ${e.message}`);
      continue;
    }
    let same = true;
    for (let i = skipSot ? 1 : 0; i <= c.cps.length; i++) {
      if (got[i] !== c.breaks[i]) {
        same = false;
        break;
      }
    }
    if (same) pass++;
    else if (bad.length < 5) {
      const want = c.breaks.map((b) => (b ? '÷' : '×'));
      const mine = got.map((b) => (b ? '÷' : '×'));
      bad.push(
        `${show(c.cps)}\n      want ${want.join(' ')}  got ${mine.join(' ')}\n      ${c.rule}`,
      );
    }
  }
  ok(`${name}: ${total} conformance cases parsed`);
  if (pass === total) ok(`${name}: matches on every case (${total})`);
  else fail(`${name}: ${total - pass} of ${total} wrong\n  ${bad.join('\n  ')}`);
  return { total, pass };
}

run(
  GB,
  'grapheme (UAX #29)',
  (cps) => {
    const set = new Set(graphemeBoundaries(cps));
    const out = [];
    for (let i = 0; i <= cps.length; i++) out.push(set.has(i));
    return out;
  },
  { skipSot: false },
);

run(
  LB,
  'line break (UAX #14)',
  (cps) => {
    const acts = lineBreakActions(cps);
    return acts.map((a) => a !== PROHIBITED);
  },
  { skipSot: true },
);

if (failures) {
  console.error(`BREAK-CONFORMANCE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nBREAK-CONFORMANCE PASS');
