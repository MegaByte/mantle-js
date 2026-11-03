// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphPlanCostSmoke — a morph plan REPORTS what it proved and what it cost, and it cannot
// run away.
//
// WHAT THE PROBLEM IS. `planMorph` walks t forward, certifying one decomposition as far as it reaches and
// redecomposing where it stops. That is a CLIFF and not a gradient: on a cubic blob
// K=4 plans in 79 ms and one segment, K=6 in 54,173 ms and 195 segments, K=8 in 103,864 ms and 461.
//
// THE OBVIOUS CAUSE IS WRONG, and the counters are what say so. It reads "the per-segment
// certificate cost is flat; what explodes is how many spans the t axis is cut into". On the blob
// family, within one run:
//
//     K=4    1 segment    1 certificate call         68 boxes        26 ms
//     K=6   10 segments  55 certificate calls  1,710,274 boxes    23,185 ms
//
// Segments go up 10x and the time 900x, so the segment count cannot be the cause. What explodes is
// the SUBDIVISION INSIDE one certificate: boxes per call 68 -> 31,096, a factor of 457. `pairs`
// and `regions` -- the two numbers the certifiers return -- do not see it either, because they count
// proofs ATTEMPTED (12 and 56 at K=4, 1,062 and 2,030 at K=6) and not the boxes popped to settle them.
// The box count is the number that tracks the time, and it is returned, accumulated and BUDGETED.
//
// Four things this pins:
//
//   REPORTED  `certifyMorphClip` and `certifyMorphLeak` return `pairs` and `regions` -- how much
//             each proof cost -- and the plan reports them, so a slow plan can be told from a hard one.
//   FORCED    where the certificate and the sampled poses disagree, the plan halves to `minStep`
//             and SHIPS the segment anyway. That is the right call (something has to be drawn
//             there), and the plan marks it, so it is distinguishable from a proved segment.
//   COUNTED   the boxes, which is the unit the time is actually spent in.
//   BOUNDED   a box budget caps the search, so a pathological pair fails in a quarter of a second
//             with the reason instead of blocking a worker for two minutes -- and it is checked
//             INSIDE the subdivision, because between calls it is not a bound at all: one call pops
//             31,000 boxes, so a caller asking for 20,000 would get 155,694.
//
//             The DEFAULT is a runaway guard and not the bound, deliberately. The tightest budget
//             that changes nothing that plans today is set by cpatchMorphPlanSmoke's own worst case,
//             cubic rot 2, which needs 13,221,578 boxes and 57.8 s for 338 segments -- so a budget
//             that actually bounds the cliff would also drop a morph that plans today, and that is a
//             drawn-output decision nobody can take from a node lane.
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { planMorph, splitForMorph } from '../src/renderer/cpatchMorphCert.js';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// The same blob family cpatchMorphPlanSmoke uses: it grows, bows further and rotates, which is
// enough motion that one decomposition cannot serve the whole morph.
const blob = (t, K, phase) => {
  const R = 40 + 22 * t,
    cx = 100,
    cy = 100;
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1);
    const bow = 0.22 + 0.16 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push({
      t: 'cubic',
      P: [
        A,
        [A[0] + (mx - A[0]) * 0.66, A[1] + (my - A[1]) * 0.66],
        [B[0] + (mx - B[0]) * 0.66, B[1] + (my - B[1]) * 0.66],
        B,
      ],
    });
  }
  return out;
};
const convert = (curves, o) => convertContour(curves, { maxCurves: 8, tolPx: 0.05, ...o });

// THE TIME BOUND IS OFF HERE (`maxPlanMs: 0`). planMorph declines a plan that has not landed in
// 5,000 ms, and what this smoke pins are the WORK counters and the box budget; the deadline is
// pinned by cpatchMorphPlanBoundSmoke.
function plan(K, phase, opts) {
  const [A, B] = splitForMorph(blob(0, K, phase), blob(1, K, phase));
  const report = {};
  const t0 = Date.now();
  const p = planMorph(A, B, convert, { maxPlanMs: 0, ...opts, report });
  return { p, report, ms: Date.now() - t0 };
}

// ── 1. the plan carries its certificate ──────────────────────────────────────────────────────
{
  const { p, report, ms } = plan(4, 0.35, {});
  ok(!!p, `K=4 plans (${p ? p.length : 0} segments, ${ms} ms)`);
  if (p) {
    ok(
      p.cert && typeof p.cert.certCalls === 'number',
      `the plan reports its certificate work (certCalls ${p.cert && p.cert.certCalls})`,
    );
    ok(
      p.cert && p.cert.clipPairs > 0,
      `...including certifyMorphClip's own \`pairs\` (${p.cert && p.cert.clipPairs})`,
    );
    ok(
      p.cert && typeof p.cert.leakRegions === 'number',
      `...and certifyMorphLeak's \`regions\` (${p.cert && p.cert.leakRegions})`,
    );
    ok(
      p.every((s) => s.forced === false),
      'every returned segment passed its continuum certificate and interior checks',
    );
    ok(p.cert.forced === 0, 'no forced segments are returned');
  }
  console.log(
    `  .. K=4: ${p ? p.length : '-'} segments, ${report.certCalls} certificate calls, ` +
      `${report.clipBoxes} clip boxes, ${report.leakBoxes} leak boxes, ${report.forced} forced, ${ms} ms`,
  );
}

// ── 2. an unproved interval is refused ───────────────────────────────────────────────────────
// cpatchMorphCertificationSmoke pins it: a family whose certificate rejects an interval plans to
// null with `uncertified`, through the proof rather than either work limit, and ships nothing.

// ── 3. and it is BOUNDED ─────────────────────────────────────────────────────────────────────
// A budget small enough to bite on a plan that otherwise succeeds: the plan must come back null
// with the reason, rather than spending the whole search.
{
  const { p, report, ms } = plan(4, 0.35, { maxCertWork: 8 });
  ok(
    p === null,
    `a certificate-WORK budget stops the search (${ms} ms, ` +
      `${report.clipBoxes + report.leakBoxes} boxes of ${report.workBudget})`,
  );
  ok(report.overBudget === true, '...and says why: overBudget');
  // TEETH: the same pair without the budget does NOT come back null, so the assertions above are
  // about the budget and not about the pair being unplannable.
  const free = plan(4, 0.35, {});
  ok(free.p !== null, `...where the same pair plans fine without one (${free.ms} ms)`);
  ok(
    report.clipBoxes + report.leakBoxes < free.report.clipBoxes + free.report.leakBoxes,
    `...and the bound stops certificate work (${report.clipBoxes + report.leakBoxes} boxes against ${free.report.clipBoxes + free.report.leakBoxes})`,
  );
}

console.log(fail ? `CPATCH-MORPH-PLAN-COST FAIL (${fail})` : 'CPATCH-MORPH-PLAN-COST OK');
process.exit(fail ? 1 : 0);
