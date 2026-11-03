// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gateBarsSmoke -- each size gate and its critical scale are ONE definition: the bar function returns exactly the unit px2 at which the gate function flips.
// Pure (no GL): the classic AAC gate (coverKernelPolicy), the stroke strip gate (unifiedFillDraw), the strip break points.
import { aacClassicPick, aacClassicBar } from '../src/renderer/coverKernelPolicy.js';
import { stripTake, stripBar, stripBreaks } from '../src/renderer/unifiedFillDraw.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
let seed = 7;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
let bad = 0;
for (let i = 0; i < 2000; i++) {
  const area = 0.5 + rnd() * 5000,
    floor = 100 + rnd() * 90000,
    bar = aacClassicBar(area, floor);
  if (aacClassicPick(area, floor, bar * 0.99999) || !aacClassicPick(area, floor, bar * 1.00001))
    bad++;
}
ok(bad === 0, `the classic AAC gate flips exactly at aacClassicBar (${bad} wrong of 2000)`);
ok(
  aacClassicBar(0, 100) === Infinity &&
    aacClassicBar(10, Infinity) === Infinity &&
    !aacClassicPick(0, 100, 1e9) &&
    !aacClassicPick(10, Infinity, 1e9),
  'no area or an unreachable floor (arcs) never picks AAC',
);
bad = 0;
for (let i = 0; i < 2000; i++) {
  const st = { count: 4 + Math.floor(rnd() * 400), quadArea: 10 + rnd() * 9000, stripArea: 0 },
    T = 1 + rnd() * 200;
  st.stripArea = st.quadArea * rnd() * 0.95;
  const bar = stripBar(st, T);
  if (stripTake(st, bar * 0.99999, T) || !stripTake(st, bar * 1.00001, T)) bad++;
}
ok(bad === 0, `the strip gate flips exactly at stripBar (${bad} wrong of 2000)`);
ok(
  stripBar({ count: 8, quadArea: 10, stripArea: 12 }, 64) === Infinity &&
    !stripTake({ count: 8, quadArea: 10, stripArea: 12 }, 1e9, 64),
  'a strip that saves no area never wins',
);
// break points: three rows with bars 10, 20, 20 (one overlapping): the set of strip rows changes at 10 and 20 and nowhere else
const mk = (bar, overlap) => ({
  _strip: { count: 10, quadArea: (10 * 64) / bar + 5, stripArea: 5, overlap },
});
const br = stripBreaks([mk(10, false), mk(20, true), mk(20, false)], 64, () => true, 1, 1000);
ok(
  br.length === 2 && Math.abs(br[0].k2 - 10) < 1e-6 && Math.abs(br[1].k2 - 20) < 1e-6,
  `strip break points at the bars where the set of rows on changes (${br.map((b) => b.k2.toFixed(3))})`,
);
ok(
  stripBreaks([mk(10, false), mk(10, false)], 64, () => true, 1, 1000).length === 1,
  'rows with the same bar are one break',
);
ok(
  stripBreaks([mk(5000, false)], 64, () => true, 1, 1000).length === 0,
  'a bar outside the range is no break',
);
console.log(fail ? `gateBarsSmoke FAIL (${fail})` : 'gateBarsSmoke PASS');
process.exit(fail ? 1 : 0);
