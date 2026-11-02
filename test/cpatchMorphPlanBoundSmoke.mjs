// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphPlanBoundSmoke — a CPatch morph plan lands, or declines, in bounded time.
//
// THE TRAP. The worker's plan recipe (morphTolPx, convertContour with noCurveCuts/forceBezout and a
// leak margin, splitForMorph, planMorph) can take 1.8 s on a 6-cubic ring whose bow grows in t -- and
// not finish inside a minute on the same ring once its coordinates come through an SVG import
// (float32, or three decimals). The certificate's work per call is the same either way (~10,000
// boxes); what differs is how many segments the planner cuts: 4 against 512.
//
// The cause is one cut candidate. The converter offers an arc's own END TANGENT as a cut line, and
// a seam along a tangent cannot be carried to another pose by its two endpoints, which is how a
// layout transfers a seam: it meets the arc at a zero angle, the smallest motion turns it against
// the arc, and splitForMorph has put that arc's end at an inflection, where the arc is flattest --
// so the seam's extension runs along the arc on the patch's side for tens of units. Every layout
// holding one leaks at every pose but its own; the certificate refuses every span; the planner
// ships a minStep segment, re-converts, gets the tangent back, and walks the morph a 512th at a
// time (on exact float64 curves one re-conversion, three minSteps in, can happen to choose a different
// cut, after three segments of the same defect). So under a morph the converter does not offer a line
// within the plan's own bar of an arc's end tangent.
//
// What is left is a residue of NEAR-degenerate junctions (a few tenths of a degree off a tangent)
// that the certificate still refuses a step at a time, so the planner also carries a time bound:
// planMorph's `maxPlanMs`, 5,000 ms by default, after which it declines cleanly (null, `overTime`)
// and the caller keeps its engine.
//
// WHAT this PINS, each case in a child process under a HARD 20 s wall (a planner with no bound runs
// for minutes, and a smoke that waits for it is not a smoke):
//   1. the imported 6-cubic ring (importSvg's float32 curves -> curveRangeToContours ->
//      toCurvesPair, as morphPairs builds them) plans within the 5,000 ms default, and every one of
//      its segments re-certifies on its own -- clip and leak, over the segment's whole span;
//   2. the same ring on exact float64 curves plans, certified the same way (with the tangent offered it
//      plans in 4 segments whose first three do NOT certify -- shipped at minStep uncertified);
//   3. the same ring rounded to float32 (Math.fround), and to three decimals, plans the same way;
//   4. the time bound: the imported 12-cubic ring, which still walks ~200 segments in ~54 s, comes
//      back NULL with `overTime` within its bound (1,500 ms here) plus one unit of work.
// A planner that offers the tangent and has no time bound FAILS: case 1 and the float32 case hit the
// 20 s wall, case 2's segments do not certify, and case 4 has no bound to meet.
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SELF = fileURLToPath(import.meta.url);
const HARD_MS = 20000; // the wall a child is killed at: four times the planner's own bound
const PLAN_MS = 5000; // planMorph's default `maxPlanMs`, which a plan must land inside
const DECLINE_MS = 1500; // the bound case 4 hands the planner
const DECLINE_SLACK = 2500; // one conversion plus one certificate pair or region past the bound

// ---- the child: one case, one JSON line ------------------------------------------------------
if (process.argv[2] === '--case') {
  const name = process.argv[3];
  const { DOMParser, XMLSerializer } = await import('@xmldom/xmldom');
  globalThis.DOMParser = DOMParser;
  globalThis.XMLSerializer = XMLSerializer;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { curveRangeToContours } = await import('../src/geom/lbContour.js');
  const { _toCurvesPair } = await import('../src/renderer/cpatchMorphBuild.js');
  const { convertContour, morphTolPx } = await import('../src/renderer/cpatchConvert.js');
  const C = await import('../src/renderer/cpatchMorphCert.js');

  // The ring: K cubics round a center, radius 40 -> 62, bow 0.30 -> 0.44.
  const ring = (t, K) => {
    const R = 40 + 22 * t,
      at = (j) => [
        100 + R * Math.cos((2 * Math.PI * j) / K),
        100 + R * Math.sin((2 * Math.PI * j) / K),
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
  const toSvg = (cs) => {
    const f = (v) => v.toFixed(3);
    let d = `M${f(cs[0].P[0][0])} ${f(cs[0].P[0][1])}`;
    for (const c of cs)
      d += ` C${f(c.P[1][0])} ${f(c.P[1][1])} ${f(c.P[2][0])} ${f(c.P[2][1])} ${f(c.P[3][0])} ${f(c.P[3][1])}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${d} Z"/></svg>`;
  };
  const imported = async (K) => {
    const a = await importSvg(toSvg(ring(0, K))),
      b = await importSvg(toSvg(ring(1, K)));
    const r = a.curveRangesByShape[0];
    const pair = _toCurvesPair(
      curveRangeToContours(new Float32Array(a.curves), r.begin, r.end)[0],
      curveRangeToContours(new Float32Array(b.curves), r.begin, r.end)[0],
    );
    return [pair.A, pair.B];
  };
  const mapP = (cs, fn) => cs.map((c) => ({ t: c.t, P: c.P.map((q) => [fn(q[0]), fn(q[1])]) }));
  let pairAB;
  if (name === 'imported6') pairAB = await imported(6);
  else if (name === 'imported12') pairAB = await imported(12);
  else if (name === 'f64') pairAB = [ring(0, 6), ring(1, 6)];
  else if (name === 'f32') pairAB = [mapP(ring(0, 6), Math.fround), mapP(ring(1, 6), Math.fround)];
  else if (name === 'fixed3')
    pairAB = [mapP(ring(0, 6), (v) => +v.toFixed(3)), mapP(ring(1, 6), (v) => +v.toFixed(3))];
  // THE WORKER'S RECIPE, as cpatch.worker.js's planJob runs it.
  const tolPx = morphTolPx(pairAB[0], pairAB[1]);
  const convert = (cs, o) => {
    try {
      return convertContour(cs, {
        maxCurves: 8,
        tolPx,
        noCurveCuts: true,
        forceBezout: true,
        leakMargin: (o && o.leakMargin) || 0,
      });
    } catch {
      return null;
    }
  };
  const [A, B] = C.splitForMorph(pairAB[0], pairAB[1]);
  const report = {};
  const t0 = Date.now();
  const plan = C.planMorph(A, B, convert, {
    tolPx,
    report,
    ...(name === 'imported12' ? { maxPlanMs: DECLINE_MS } : {}),
  });
  const ms = Date.now() - t0;
  // every SEGMENT, RE-CERTIFIED ON ITS own: both certificates over the segment's whole span, which is
  // what a segment claims. A segment the planner shipped at minStep because nothing certified it
  // reads false here even though it drew a valid pose at each end.
  const poseAt = (t) =>
    A.map((c, i) => ({
      t: c.t,
      cut: c.cut,
      w: c.w,
      P: c.P.map((q, k) => [q[0] + (B[i].P[k][0] - q[0]) * t, q[1] + (B[i].P[k][1] - q[1]) * t]),
    }));
  const uncertified = [];
  if (plan) {
    for (const s of plan) {
      const LA = C.applyLayout(s.layout, poseAt(s.t0)),
        LB = C.applyLayout(s.layout, poseAt(s.t1));
      let good = !!LA && !!LB && LA.length === LB.length;
      for (let i = 0; good && i < LA.length; i++) {
        const c = C.certifyMorphClip(LA[i], LB[i], { tolPx }),
          l = C.certifyMorphLeak(LA[i], LB[i], { tolPx });
        good = c.ok && l.ok;
      }
      if (!good) uncertified.push(`${s.t0.toFixed(5)}-${s.t1.toFixed(5)}`);
    }
  }
  console.log(
    JSON.stringify({
      name,
      planned: !!plan,
      segments: plan ? plan.length : report.segments | 0,
      ms,
      elapsedMs: report.elapsedMs,
      overTime: report.overTime === true,
      overBudget: report.overBudget === true,
      forced: report.forced | 0,
      uncertified,
    }),
  );
  process.exit(0);
}

// ---- the parent: every case under the wall ---------------------------------------------------
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const run = (name) => {
  const r = spawnSync(process.execPath, [SELF, '--case', name], {
    encoding: 'utf8',
    timeout: HARD_MS,
  });
  if (r.error || r.status !== 0) {
    const why =
      r.error && r.error.code === 'ETIMEDOUT'
        ? `did not return inside the ${HARD_MS} ms wall`
        : `exited ${r.status}: ${(r.stderr || '').split('\n').slice(-4).join(' | ')}`;
    return { name, dead: why };
  }
  const line = (r.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { name, dead: 'no result line: ' + line };
  }
};

for (const name of ['imported6', 'f64', 'f32', 'fixed3']) {
  const r = run(name);
  if (r.dead) {
    ok(false, `${name}: the plan ${r.dead}`);
    continue;
  }
  console.log(`  .. ${name}: ${r.segments} segment(s) in ${r.ms} ms, ${r.forced} forced`);
  ok(r.planned, `${name}: the 6-cubic ring PLANS`);
  ok(r.ms <= PLAN_MS, `${name}: ...inside the planner's ${PLAN_MS} ms bound (${r.ms} ms)`);
  ok(
    r.uncertified.length === 0,
    `${name}: ...and every segment certifies over its own span${r.uncertified.length ? ' — NOT: ' + r.uncertified.slice(0, 4).join(', ') : ''}`,
  );
}
{
  const r = run('imported12');
  if (r.dead) ok(false, `imported12: the bounded plan ${r.dead}`);
  else {
    console.log(
      `  .. imported12: ${r.planned ? r.segments + ' segment(s)' : 'declined'} after ${r.ms} ms (bound ${DECLINE_MS})`,
    );
    ok(
      !r.planned && r.overTime,
      `imported12: a plan that cannot land in ${DECLINE_MS} ms declines, and says it was the TIME bound`,
    );
    ok(
      r.ms <= DECLINE_MS + DECLINE_SLACK,
      `imported12: ...and returns within the bound plus one unit of work (${r.ms} ms)`,
    );
  }
}

console.log(fail ? `cpatchMorphPlanBoundSmoke FAIL (${fail})` : 'cpatchMorphPlanBoundSmoke PASS');
process.exit(fail ? 1 : 0);
