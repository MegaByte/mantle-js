// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/cpatchMorphBoxCensus.mjs — IS THERE A WORSE MORPH THAN `cubic rot 2`?
//
// The morph plan's box budget ships as a RUNAWAY GUARD, not as the bound: the default `__CP_MORPH_WORK_BUDGET`
// is 64e6, about 5x the worst case anybody had measured (cpatchMorphPlanSmoke's `cubic rot 2`,
// 13,221,578 boxes and 57.8 s for 338 segments). A guard sized off ONE asset is a guess until the
// corpus is asked, and the consequence of guessing low is not a slow frame, it is a morph the tree
// plans coming back null -- a drawn-output change. So this asks.
//
//   node probes/perf/cpatchMorphBoxCensus.mjs                 # the K=4 and K=6 ladder, the default
//   KS=4,6,8 node probes/perf/cpatchMorphBoxCensus.mjs        # ...with K=8, which is minutes
//   BUDGET=13221578 node probes/perf/cpatchMorphBoxCensus.mjs # cap each case at the recorded worst
//
// HOW IT STAYS BOUNDED. Every case runs with `maxCertWork` set to BUDGET, which is checked INSIDE
// the subdivision, so a case that would run away stops at the cap and reports `overBudget` instead
// of blocking the survey for two minutes. A case that finishes reports its exact box count. The
// survey's answer is therefore two lists: the exact counts, and the cases that hit the cap -- and a
// case at the cap is by definition at least as expensive as the recorded worst.
//
// THE CORPUS. The morph shapes this tree actually plans are the blob family the plan smokes and
// probes/perf/cpatchMorphSegments.mjs use -- a K-sided bowed contour growing, bowing further and
// rotating -- across its three curve kinds, its three rotations and K. That family is where the
// recorded worst case comes from, so widening it in K and kind is the comparison that means
// something. Real-asset morph pairs are NOT here: probes/morphScale/_zzMorphScale.mjs already
// records that end-to-end planning on those is MINUTES per pair, and a survey that cannot finish
// answers nothing.
import { convertContour } from '../../src/renderer/cpatchConvert.js';
import { planMorph, splitForMorph } from '../../src/renderer/cpatchMorphCert.js';

// The recorded worst case, and what the default guard is 5x of.
const RECORDED_WORST = 13221578;
const BUDGET = +(process.env.BUDGET || 64e6);
const KS = (process.env.KS || '4,6').split(',').map(Number);
const PHASES = (process.env.PHASES || '0,1,2').split(',').map(Number);
const KINDS = (process.env.KINDS || 'quad,rquad,cubic').split(',');

// cpatchMorphPlanSmoke's own fixture, verbatim in shape: the recorded worst case has to be a case
// of this survey or the comparison is between two different things.
const blob = (t, phase, kind, K) => {
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
      B = at(j + 1),
      bow = 0.3 + 0.14 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    if (kind === 'cubic') {
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
    } else if (kind === 'rquad') out.push({ t: 'rquad', P: [A, [mx, my], B], w: 0.75 + 0.1 * t });
    else out.push({ t: 'quad', P: [A, [mx, my], B] });
  }
  return out;
};
const convert = (cs, o) => {
  try {
    return convertContour(cs, {
      maxCurves: 8,
      tolPx: 0.05,
      noCurveCuts: true,
      forceBezout: true,
      leakMargin: (o && o.leakMargin) || 0,
    });
  } catch {
    return null;
  }
};

console.log(
  `== morph box survey: is anything worse than \`cubic rot 2\` (${RECORDED_WORST.toLocaleString()} boxes)? ==`,
);
console.log(
  `   budget ${BUDGET.toLocaleString()} boxes per case, checked inside the subdivision\n`,
);
console.log('   K  kind   rot   segments      boxes        ms  forced   state');

const rows = [];
for (const K of KS) {
  for (const kind of KINDS) {
    for (const phase of PHASES) {
      const [A, B] = splitForMorph(blob(0, phase, kind, K), blob(1, phase, kind, K));
      const report = {};
      const t0 = Date.now();
      let plan = null;
      try {
        plan = planMorph(A, B, convert, { tolPx: 0.05, report, maxCertWork: BUDGET });
      } catch {
        /* counted as no plan */
      }
      const ms = Date.now() - t0;
      const boxes = (report.clipBoxes | 0) + (report.leakBoxes | 0);
      // THREE WAYS TO STOP, and only one of them is an answer. `overBudget` is the box cap, which
      // makes the count a lower bound; `exhausted` is maxSegments (512) running out, which makes it
      // a lower bound too and returns NULL; a plan at exactly 512 segments finished on its last
      // allowed step, so it is an answer with no headroom left and is called out.
      const segs = plan ? plan.length : report.segments | 0;
      const state = report.overBudget
        ? 'OVER BUDGET'
        : report.exhausted
          ? 'EXHAUSTED (>= this)'
          : !plan
            ? 'no plan'
            : segs >= 512
              ? 'planned AT THE SEGMENT CAP'
              : 'planned';
      rows.push({
        K,
        kind,
        phase,
        segments: segs,
        boxes,
        ms,
        over: !!report.overBudget,
        exhausted: !!report.exhausted,
        forced: report.forced | 0,
      });
      console.log(
        `  ${String(K).padStart(2)}  ${kind.padEnd(5)}  ${String(phase).padEnd(3)}  ` +
          `${String(segs).padStart(8)}  ${boxes.toLocaleString().padStart(12)}  ` +
          `${String(ms).padStart(8)}  ${String(report.forced | 0).padStart(6)}   ${state}`,
      );
    }
  }
}

const over = rows.filter((r) => r.over || r.exhausted);
const worst = rows.reduce((a, b) => (b.boxes > a.boxes ? b : a), rows[0]);
console.log(
  `\n   worst that FINISHED: K=${worst.K} ${worst.kind} rot ${worst.phase} — ` +
    `${worst.boxes.toLocaleString()} boxes, ${worst.ms} ms, ${worst.segments} segments`,
);
console.log(
  `   against the recorded worst ${RECORDED_WORST.toLocaleString()}: ` +
    `${(worst.boxes / RECORDED_WORST).toFixed(3)}x`,
);
console.log(
  `   cases whose count is a LOWER BOUND (box cap or segment cap): ${over.length}` +
    `${over.length ? ' — ' + over.map((r) => `K=${r.K} ${r.kind} rot ${r.phase}`).join(', ') : ''}`,
);
const atCap = rows.filter((r) => r.segments >= 512 && !r.exhausted);
console.log(
  `   cases that planned on their LAST allowed segment (512): ${atCap.length}` +
    `${atCap.length ? ' — ' + atCap.map((r) => `K=${r.K} ${r.kind} rot ${r.phase}`).join(', ') : ''}`,
);
console.log(
  `   the shipped default guard is 64,000,000 boxes, ${(64e6 / Math.max(worst.boxes, 1)).toFixed(1)}x this survey's worst`,
);
