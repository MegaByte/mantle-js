// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphBudgetHeadroomSmoke — the morph box budget's headroom is measured against the CORPUS,
// not against one asset.
//
// THE QUESTION. The planner's box budget is a runaway guard. Sized off ONE case -- cpatchMorphPlanSmoke's
// own worst, cubic rot 2, 13,221,578 boxes and 57.8 s for 338 segments -- it is a guess, and guessing low
// does not make a frame slow, it makes `planMorph` return null on a morph that plans today: a drawn-output
// change nobody can take from a node lane. So the budget is sized against the corpus
// (probes/perf/cpatchMorphBoxCensus.mjs), over the blob family's three kinds, three rotations and K:
//
//     K  kind   rot   segments        boxes   forced
//     4  cubic  2            2       58,112        0
//     6  cubic  0            4      260,593        0
//     6  cubic  1            7      460,555        0
//     6  cubic  2          338   13,221,578            <- cpatchMorphPlanSmoke's worst, reproduced exactly
//     8  cubic  2          276   15,548,298        1
//     8  cubic  0          512   22,050,020       21    <- at maxSegments, its LAST allowed step
//     8  cubic  1          512   27,151,689        7    <- the corpus worst, 2.05x that
//
// (quad and rquad never exceed 58k boxes at any K; the cliff is entirely the cubic family.)
//
// THE CORPUS HAS A WORSE MORPH, and it is twice as bad. So the shipped 64e6 is 2.36x the corpus
// worst, not ~5x, and tightening the budget below ~27.2e6 would drop a morph that plans today. The
// corpus scan reproduces `cubic rot 2` to the box, so the two numbers are comparable and the ratio
// is real rather than an instrument difference.
//
// AND THE BOX BUDGET IS NOT THE BINDING CAP ANYWAY on the worst cases: K=8 cubic rot 0 and rot 1
// both plan in exactly 512 segments, which IS `maxSegments`. They finish on their last allowed
// step. One more segment and `planMorph` returns null -- so on the corpus's two hardest morphs the
// thing between a plan and no plan is the SEGMENT cap, at zero headroom, and the box budget is the
// second-tightest guard. That is what a tightening pass has to be told before it touches either --
// and 21 and 7 of those 512 segments are FORCED (the certificate and the sampled poses disagree
// and the segment ships anyway), so the two hardest morphs are also the two least proved.
//
// WHAT this PINS: the source records the CORPUS worst and the default budget clears it (so the
// justification cannot silently go back to one asset), and -- live, in under two seconds -- that
// the budget really is what stops a plan.
//
// A source that records 13,221,578 as the worst and calls 64e6 "~5x that worst case", with no
// corpus figure, FAILS.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { planMorph, splitForMorph } from '../src/renderer/cpatchMorphCert.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const CORPUS_WORST = 27151689; // K=8 cubic rot 1, probes/perf/cpatchMorphBoxCensus.mjs
const MAX_SEGMENTS = 512;

// ---- the source records the corpus, and the guard clears it -----------------------------------
{
  const src = readFileSync(path.join(ROOT, 'src/renderer/cpatchMorphCert.js'), 'utf8');
  const def = src.match(/__CP_MORPH_WORK_BUDGET'?\)?\s*:\s*([\d.e+]+)/);
  ok(!!def, 'the default work budget is a literal in cpatchMorphCert.js');
  const budget = def ? Number(def[1]) : 0;
  ok(budget > 0, `the default is ${budget.toLocaleString()} boxes`);
  ok(
    src.includes(String(CORPUS_WORST)) || src.includes(CORPUS_WORST.toLocaleString('en-US')),
    `the note records the CORPUS worst (${CORPUS_WORST.toLocaleString()}), not just one asset's`,
  );
  ok(
    budget > CORPUS_WORST,
    `the guard clears the corpus worst: ${budget.toLocaleString()} > ${CORPUS_WORST.toLocaleString()} ` +
      `(${(budget / CORPUS_WORST).toFixed(2)}x, against the "~5x" the note claimed against one asset)`,
  );
  ok(
    /maxSegments\s*!=\s*null\s*\?\s*opts\.maxSegments\s*:\s*512/.test(src),
    `maxSegments is still ${MAX_SEGMENTS} — the corpus's two hardest morphs plan on exactly that many, so a change here is a drawn-output change`,
  );
  ok(
    /SEGMENT cap|maxSegments.*zero headroom|last allowed|512 segments/i.test(src),
    'the note says the segment cap is the binding one on the worst cases, so a tightening pass reads it first',
  );
}

// ---- and the budget really does stop a plan ---------------------------------------------------
// K=4 cubic rot 2, the cheapest case with a non-trivial box count (58,112 in the corpus scan).
{
  const blob = (t, phase, K) => {
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
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
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
  const run = (maxCertWork) => {
    const [A, B] = splitForMorph(blob(0, 2, 4), blob(1, 2, 4));
    const report = {};
    // The TIME bound off, so the box budget is the only one that can stop this plan.
    const plan = planMorph(A, B, convert, {
      tolPx: 0.05,
      report,
      maxPlanMs: 0,
      ...(maxCertWork ? { maxCertWork } : {}),
    });
    return { plan, report, boxes: (report.clipBoxes | 0) + (report.leakBoxes | 0) };
  };
  const free = run(0);
  ok(
    !!free.plan,
    `K=4 cubic rot 2 plans under the default budget (${free.plan ? free.plan.length : 0} segments, ${free.boxes.toLocaleString()} boxes)`,
  );
  ok(free.boxes > 1000, '...and it is not a trivial case — the guard has something to bite on');
  const capped = run(1000);
  ok(capped.report.overBudget === true, 'a budget of 1,000 boxes reports overBudget');
  ok(capped.plan === null, '...and returns NO PLAN rather than a half-certified one');
  ok(
    capped.boxes <= 1000 + 65536,
    `...and stops INSIDE the subdivision (${capped.boxes.toLocaleString()} boxes, not the ${free.boxes.toLocaleString()} an unbounded run pops)`,
  );
}

console.log(
  fail ? `cpatchMorphBudgetHeadroomSmoke FAIL (${fail})` : 'cpatchMorphBudgetHeadroomSmoke PASS',
);
process.exit(fail ? 1 : 0);
