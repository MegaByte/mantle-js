// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coversDrawSmoke -- coversDraw(programKey, neededKey, mode): a program covers a draw state iff it includes everything the state needs and omits nothing it uses
// (sceneUnion.js). Table cases for each clause, and a randomized equivalence of the one function (modes 'exact' and 'net') with the two predicates it generalizes
// (isWarmSuperset, isNetFor), the oracle. Pure: no GL.
import { coversDraw, isWarmSuperset, isNetFor } from '../src/renderer/sceneUnion.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const k = (...d) => d.sort().join('|');
const K = 'MANTLE_AAC',
  R = 'MANTLE_ROTATED_MAP',
  PB = 'MANTLE_AAC_PAIR_BANDS',
  LB = 'MANTLE_LB_FILL',
  M = 'MANTLE_NO_MASK',
  S = 'MANTLE_NO_STROKE',
  G = 'MANTLE_NO_GRADIENT';
// presence
ok(
  coversDraw(k(K), k(K, M)),
  'a program that omits nothing covers a state that omits the mask (more code left in, same pixels)',
);
ok(!coversDraw(k(K, M), k(K)), 'a program that omits the mask does not cover a state that uses it');
ok(
  !coversDraw(k(K, G), k(K, M)),
  'a program omitting the gradient does not cover a state that does not omit it',
);
ok(
  !coversDraw(k(LB), k(K)),
  'a different kernel class covers nothing (presence must include what the state needs)',
);
ok(
  !coversDraw(k(K, R), k(K)) && coversDraw(k(K, R), k(K), 'net'),
  'the rotated footprint is a benign extra only for a net',
);
ok(
  coversDraw(k(K), k(), 'net') && !coversDraw(k(K), k()),
  'the AAC kernel stands in for Slug in net mode only',
);
ok(!coversDraw(k(K), k(), 'net', false), 'allowAacNet false forbids it');
ok(
  !coversDraw(k(K, PB), k(K)) && coversDraw(k(K), k(K, PB)),
  'a pair-band program needs a pair-band state; a stripe program is exact on one',
);
ok(
  coversDraw(k(K, 'MANTLE_NO_RECOLOR'), k(K, 'MANTLE_NO_RECOLOR')) &&
    coversDraw(k(K, 'MANTLE_NO_CHANNEL_LERP'), k(K, 'MANTLE_NO_RECOLOR')),
  'NO_RECOLOR implies its three parts',
);
ok(
  !coversDraw(k(K, 'MANTLE_CPATCH_X'), k(K)) && !coversDraw(k(K), k(K, 'MANTLE_CPATCH_X')),
  'a CPatch key is a pass selector: it never covers or is covered',
);
ok(
  !isWarmSuperset(k(K, M), k(K, M)),
  'the warm superset is a strict relation (a key is not its own superset)',
);
// randomized equivalence with the two predicates
const POOL = [
  K,
  R,
  PB,
  LB,
  'MANTLE_HARD',
  'MANTLE_COVER_KERNEL',
  M,
  S,
  G,
  'MANTLE_NO_IMAGE',
  'MANTLE_NO_PATTERN',
  'MANTLE_NO_FILTER',
  'MANTLE_NO_RECOLOR',
  'MANTLE_NO_CHANNEL_LERP',
  'MANTLE_NO_PALETTE',
  'MANTLE_NO_COLOR_MATRIX',
  'MANTLE_NO_ARC',
  'MANTLE_LB_NO_DISC',
  'MANTLE_COVER_PAINT_ONLY',
  'MANTLE_CPATCH_AREA',
];
const isRestrictive = (d) =>
  /^MANTLE_(NO_|LB_NO_|CPATCH_NO_)/.test(d) ||
  d === 'MANTLE_CPATCH_QUADRATIC_AREA_ONLY' ||
  d === 'MANTLE_COVER_PAINT_ONLY';
const KC = new Set([
  'MANTLE_AAC',
  'MANTLE_HARD',
  'MANTLE_HARD_TREE',
  'MANTLE_GWN',
  'MANTLE_HARD_MIXED',
  'MANTLE_COVER_KERNEL',
  'MANTLE_LB_FILL',
  'MANTLE_LB_FILL_COV',
  'MANTLE_LB_MORPH',
  'MANTLE_LB_CURVE_TEX',
  'MANTLE_AAC_PAIR_BANDS',
  'MANTLE_ROTATED_MAP',
  'MANTLE_NO_COVER_FILL',
  'MANTLE_COVER_PAINT_ONLY',
]);
const RP = ['MANTLE_NO_CHANNEL_LERP', 'MANTLE_NO_PALETTE', 'MANTLE_NO_COLOR_MATRIX'];
const isOm = (d) => isRestrictive(d) && !KC.has(d),
  split = (x) => (x ? x.split('|') : []);
function oracleSuperset(entryKey, wantKey) {
  if (entryKey === wantKey) return false;
  const e = split(entryKey),
    w = split(wantKey);
  for (const d of e) if (d.startsWith('MANTLE_CPATCH')) return false;
  for (const d of w) if (d.startsWith('MANTLE_CPATCH')) return false;
  const wantSet = new Set(w);
  if (wantSet.has('MANTLE_NO_RECOLOR')) for (const d of RP) wantSet.add(d);
  const ePres = new Set(),
    wPres = new Set();
  for (const d of e) {
    if (isOm(d)) {
      if (!wantSet.has(d)) return false;
    } else if (d !== 'MANTLE_AAC_PAIR_BANDS') ePres.add(d);
  }
  for (const d of w) if (!isOm(d) && d !== 'MANTLE_AAC_PAIR_BANDS') wPres.add(d);
  if (ePres.size !== wPres.size) return false;
  for (const d of ePres) if (!wPres.has(d)) return false;
  if (e.includes('MANTLE_AAC_PAIR_BANDS') && !wantSet.has('MANTLE_AAC_PAIR_BANDS')) return false;
  return true;
}
function oracleNet(netKey, wantKey, allowAacNet = true) {
  const e = split(netKey),
    w = split(wantKey);
  for (const d of e) if (d.startsWith('MANTLE_CPATCH')) return false;
  for (const d of w) if (d.startsWith('MANTLE_CPATCH')) return false;
  const ePres = new Set(e.filter((d) => !isOm(d) && d !== 'MANTLE_AAC_PAIR_BANDS')),
    wPres = new Set(w.filter((d) => !isOm(d) && d !== 'MANTLE_AAC_PAIR_BANDS'));
  for (const d of wPres) if (!ePres.has(d)) return false;
  for (const d of ePres)
    if (!wPres.has(d) && d !== 'MANTLE_ROTATED_MAP' && !(d === 'MANTLE_AAC' && allowAacNet))
      return false;
  if (e.includes('MANTLE_AAC_PAIR_BANDS') && !w.includes('MANTLE_AAC_PAIR_BANDS')) return false;
  const wantSet = new Set(w);
  if (wantSet.has('MANTLE_NO_RECOLOR')) for (const d of RP) wantSet.add(d);
  for (const d of e) if (isOm(d) && !wantSet.has(d)) return false;
  return true;
}
let seed = 20260101,
  bad = 0,
  yes = 0;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const pick = () => k(...POOL.filter(() => rnd() < 0.35));
for (let i = 0; i < 40000; i++) {
  const a = pick(),
    aac = rnd() < 0.5;
  // half the pairs: the state is the program with extra omissions added (the covering direction), so the relation's yes side is exercised
  const b =
    i % 2
      ? k(
          ...new Set([
            ...a.split('|').filter(Boolean),
            ...POOL.filter((d) => isOm(d) && rnd() < 0.3),
          ]),
        )
      : pick();
  if (isWarmSuperset(a, b) !== oracleSuperset(a, b)) bad++;
  if (isNetFor(a, b, aac) !== oracleNet(a, b, aac)) bad++;
  if (oracleSuperset(a, b)) yes++;
}
ok(
  bad === 0,
  `40000 random key pairs: coversDraw (exact and net) equals the replaced predicates (${bad} differ; ${yes} covering pairs seen)`,
);
console.log(fail ? `coversDrawSmoke FAIL (${fail})` : 'coversDrawSmoke PASS');
process.exit(fail ? 1 : 0);
