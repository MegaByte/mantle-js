// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/cpatchMorphSegments.mjs — how CPatch morph planning cost and accuracy scale with the
// contour's segment count. The planning half is pure CPU, so it is measured here rather than described.
//
//   node probes/perf/cpatchMorphSegments.mjs                       # the cheap rungs, ~1 minute
//   KS=4,6,8,12,16 CAP=300000 node probes/perf/cpatchMorphSegments.mjs   # the full ladder, minutes
//
// ── MEASURED, AND THE RESULT IS NOT A CURVE, IT IS A CLIFF ──────────────────────────────────
//
//    K   split ms   plan ms    total       ms/segment   plan segments   patches
//    4          1        78        79            19.6               1         1
//    6          0    54,173    54,173  (689x)  9,028.9             195        11
//    8          0   103,864   103,864  (1.9x) 12,983.1             461        15
//
// Between four segments and six, planning goes from 79 ms to 54 SECONDS, and the plan goes
// from ONE certified span to 195. That is the shape the planner's own comments describe: a
// plan "of 40 segments had most of them one minStep wide, each paying 24 certificate pairs to
// discover it". The per-segment certificate cost is roughly flat; what explodes is the NUMBER
// OF SEGMENTS the t axis has to be cut into before each one certifies, and that is set by how
// far one decomposition can travel — which shrinks as the pieces get shorter.
//
// So "planning cost falls apart with segment count" understates it. It is not a gradient to be
// optimized; at six cubic segments this fixture already plans in a time no page survives, and
// probes/_cpatchMorphRender.mjs records the same thing from the other side ("the wide pair
// below plans in 40 segments and about 75 seconds, which no page timeout survives").
//
// The fixture is the one probes/_cpatchTexelDegree.mjs uses — a K-sided bowed blob morphing to
// a larger, rotated one — with K swept. Everything below `planMorph` is the real planner:
// `splitForMorph`, `convertContour` per plan segment, and both certificates.
//
// ── WHY IT FALLS APART, WITH THE LOOPS ──────────────────────────────────────────────────────
//
// `planMorph` walks the t axis and, for each plan segment, runs a full decomposition
// (`convertContour`), then gallops and bisects (up to 24 bisection steps) calling `certifiedOn`
// at each step. `certifiedOn` loops over every patch and runs both certificates on each — the
// clip direction and the leak direction, always both, because gating on the clip certificate
// alone is unsound.
//
//   certifyMorphClip is O(n^2) in curves per patch: an ordered double loop over n(n-1) pairs,
//   and per pair it builds a (degS+1)x(degT+1) tensor grid THREE times (value plus two
//   gradients) where a cubic against a cubic gives degS = degT = 9 — 100 sample points per
//   grid, each a full polynomial evaluation — then subdivides in both s and t to depth 14, up
//   to 2^14 boxes per pair, splitting every grid at each step.
//
//   certifyMorphLeak is worse: per curve it builds FOURTEEN graded regions eagerly, and for
//   each (curve, region, constraint) triple builds three more bivariate grids, then subdivides
//   in t to depth 16.
//
// The file's own measured statements: "0.5s at 16, 3.7s at 20, 49s at 24" for the depth cap;
// "239,772 boxes over a span of 0.002 and 895,662 over a span of 0.05" on ONE patch;
// "1,166,130 t-intervals on one region of one patch" when left running; "3.2s for one patch"
// before the dead-constraint filter. And planning DOES NOT PARALLELIZE within a pair — one plan
// is one job, because the certificate is a depth-first search.
//
// The converter caps curves per patch at 8, which bounds n, but nothing bounds the patch count
// P, and P grows with the contour's segment count. That is the mechanism this ladder measures.
//
// ── THE ACCURACY HALF ───────────────────────────────────────────────────────────────────────
//
// It is not independent of the above, which is the part worth stating plainly:
//
//   * ONE BAR FOR THE whole PLAN. `morphTolPx` scales `CP_TOL_DEFAULT` by the union EXTENT of
//     the two poses and nothing else. Two contours at the same extent, one with 8 segments and
//     one with 32, are held to the IDENTICAL absolute tolerance while each patch is a quarter
//     the size — so the bar is effectively four times looser relative to the feature. The same
//     bar reaches both certificates, `validatePatch` on every sampled pose, and, through
//     `leakMargin`, the source decomposition itself.
//   * THE CERTIFICATE PROPOSES AND SAMPLING DISPOSES, and where they disagree the plan HALVES
//     DOWN TO THE MINIMUM STEP AND SHIPS THE SEGMENT ANYWAY ("a region nothing can certify
//     still has to be drawn"). At high segment counts that floor is reached more often, so the
//     plan ships more uncertified poses — which is the accuracy failure, and it is a
//     consequence of the cost.
//   * THE exact-IN-t COEFFICIENT SET IS CONDITIONAL. Every packed coefficient is exactly degree
//     <= 2 in t only while the segment's conditioning constants are FROZEN; `freezeLayoutNorms`
//     freezes them, and a curve whose frozen chord pair no longer holds DECLINES rather than
//     recompute ("recomputing the maxima here would produce a line that is right for this pose
//     and wrong for the segment"). More segments means shorter, straighter pieces, means more
//     frozen declines, means dropped patches. The counter already exists:
//     `globalThis.__CP_FROZEN_DECLINES`.
//   * PAIRING IS POSITIONAL and its degeneracy bar is one float32 ulp of the PAIR's extent — so
//     at 32 segments a segment is 4x shorter against an unchanged bar, and a drop that fires in
//     one pose and not the other pairs segment i of A with a different segment of B and morphs
//     the wrong geometry, silently.
import { performance } from 'perf_hooks';

const { convertContour } = await import('../../src/renderer/cpatchConvert.js');
const { planMorph, splitForMorph } = await import('../../src/renderer/cpatchMorphCert.js');

// Default to the two cheap rungs. The cliff is already visible between them, and the higher
// ones take minutes each — a probe that costs five minutes to answer a question it has already
// answered does not get run.
const KS = (process.env.KS || '4,6')
  .split(',')
  .map((x) => +x)
  .filter((x) => x > 2);
const CAP = +(process.env.CAP || 60000); // stop the ladder once one K passes this, in ms
const KIND = process.env.KIND || 'cubic';

/// The _cpatchTexelDegree fixture, with the segment count as a parameter.
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
const convert = (cs) => {
  try {
    return convertContour(cs, {
      maxCurves: 8,
      tolPx: 0.05,
      noCurveCuts: true,
      forceBezout: true,
      leakMargin: 0,
    });
  } catch {
    return null;
  }
};

console.log(
  `\n== planMorph cost vs segment count (${KIND}, one bowed contour -> a larger rotated one) ==`,
);
console.log(
  '   K    split ms   plan ms    total    ms/segment   plan segments   patches (first seg)   frozen declines',
);
let prev = null;
for (const K of KS) {
  const A0 = blob(0, 1.0, KIND, K),
    B0 = blob(1, 1.0, KIND, K);
  globalThis.__CP_FROZEN_DECLINES = 0;
  let A,
    B,
    plan,
    tSplit = 0,
    tPlan = 0;
  const t0 = performance.now();
  try {
    [A, B] = splitForMorph(A0, B0);
  } catch {
    A = null;
  }
  tSplit = performance.now() - t0;
  if (!A) {
    console.log(`   ${String(K).padStart(2)}   split failed`);
    continue;
  }
  const t1 = performance.now();
  try {
    plan = planMorph(A, B, convert, { tolPx: 0.05 });
  } catch (e) {
    plan = null;
  }
  tPlan = performance.now() - t1;
  const total = tSplit + tPlan;
  const segs = plan ? plan.length : 0;
  const patches = plan && plan[0] && plan[0].layout ? plan[0].layout.length : 0;
  const fz = globalThis.__CP_FROZEN_DECLINES | 0;
  const growth = prev ? ` (${(total / prev).toFixed(2)}x)` : '';
  console.log(
    `   ${String(K).padStart(2)}   ${tSplit.toFixed(0).padStart(8)}  ${tPlan.toFixed(0).padStart(8)}` +
      `  ${total.toFixed(0).padStart(7)}${growth.padEnd(9)}  ${(total / K).toFixed(1).padStart(8)}` +
      `   ${String(segs).padStart(11)}   ${String(patches).padStart(17)}   ${String(fz).padStart(15)}`,
  );
  prev = total;
  if (total > CAP) {
    console.log(`   -- stopping: ${total.toFixed(0)} ms passed the ${CAP} ms cap`);
    break;
  }
}
console.log('   "plan segments" is the t axis cut into certified spans; each one paid a full');
console.log('   decomposition plus a gallop and up to 24 bisections, each of those running BOTH');
console.log('   certificates over EVERY patch. A plan of many one-minStep segments is the');
console.log('   pathological shape the file names: "most of them one minStep wide, each paying');
console.log('   24 certificate pairs to discover it".');

console.log(`
== WHAT IS MISSING, AND IT IS NOT A GPU ======================================================

THE PLANNER REPORTS NOTHING. \`planMorph\` returns segments and \`cpatch.worker.js\` has the plan
in hand at the moment it answers, but the only thing that reaches the renderer is
\`bundle._cpatchPlanMs\` -- one wall time for the whole pooled round trip, including dispatch.
Four fields on the worker's planJob return would make planning cost measurable in production
rather than in a probe:

    { segments: plan.length, clipPairs, leakRegions, ms }

\`certifyMorphClip\` already returns \`{ ok, pairs, certified, inconclusive, failures }\` and
\`certifyMorphLeak\` \`{ ok, regions, certified, failures }\`, so the two counters exist and are
thrown away at every call site. Adding them is cheap, and it is what
turns "falls apart with segment count" into a number an app can see.

== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU  Where the ACCURACY goes at high segment count.
  driver: probes/_cpatchMorphSegs.mjs, which already sweeps SEGS=8,16,24,32 x TS=0,0.25,..,1
          against Slug and reports wrong / worst / built / drew / stomps / why per row, plus
          plan+warm ms and frozen-pair declines per segs. The balance bench's claim to check is
          "s8 clean and s32 structurally wrong (12.6k px at 256, 216k at 1024)".
  READ THE SPLIT, not the total. Three different things produce a wrong pixel here and the
  probe already separates them:
    [ ] built/drew -- did the CPatch route run at all? A morph that fell to LB reads as clean.
    [ ] frozen-pair declines -- dropped patches, i.e. missing ink, not bad ink.
    [ ] wrong/worst at t strictly between 0 and 1 -- the certificate shipping an uncertified
        pose, which is the accuracy claim proper. At t=0 and t=1 the poses are static
        decompositions and a failure there is NOT a morph failure.
  then: re-run with tolPx pinned to the value the 8-segment case derives, so the bar stops
  scaling with extent. If s32 cleans up, the defect is the ONE-BAR-PER-PAIR tolerance and the
  fix is to scale the bar by the patch, not the pair. If it does not, the defect is the
  certificate's degree bound and the fix is the minStep floor.
  fill in: s8 wrong ____   s16 ____   s24 ____   s32 ____
           frozen declines s8 ____  s32 ____   |  pinned-tol s32 wrong ____
           verdict: tolerance / certificate / pairing
`);
