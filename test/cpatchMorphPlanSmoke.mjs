// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphPlanSmoke — a CPatch morph plan is CERTIFIED, not sampled.
//
// Two poses of a shape do not decompose the same way, so a morph needs one decomposition that
// stays valid across a whole span of poses. Checking that by sampling t is no proof — the
// invalid poses live between the samples — so planMorph asks for a certificate over the
// continuum: a bivariate Bernstein bound in (curve parameter, morph parameter), in both the clip
// direction and the leak direction, subdivided until each box is settled.
//
// What this pins:
//   T1  fixed-weight curve families plan, including CUBIC. Four separate traps refuse the cubic
//       family: a certificate that measures against each grid's own largest coefficient instead
//       of in pixels, an orientation read from three sampled poses (which calls an honest sign
//       flip a contradiction), a static cover, and a source decomposition whose cut lines clear
//       their own extensions by 39 NANOPIXELS.
//   T2  the plans are actually valid — poses sampled far more finely than the planner ever
//       looks. This is not what makes them correct, it is what catches the certificate being
//       wrong (a plan with 3 bad poses in 401, say).
//   T4  the layout COVERS the shape. Every patch being valid does not say the patches tile
//       anything -- a layout that lost half of them passes T2 and paints half a shape.
//   T5  a frame is a rewrite, not a rebuild. A segment is PLANNED once — cells, curve lists and
//       triangles — and every pose inside it writes coefficients into those fixed slots. The
//       cells survive the span because gridSplitPatch's two drop tests carry the geometry's
//       motion; abandoning them instead costs 3.7x on the GPU.
//   T3  a certificate that cannot settle a pair says so. `inconclusive` is not `certified`, and
//       counting only outright failures lets bad poses through.
import {
  convertContour,
  framePatch,
  validatePatch,
  inPatch,
  insideContour,
} from '../src/renderer/cpatchConvert.js';
import {
  planMorph,
  layoutAt,
  applyLayout,
  splitForMorph,
  certifyMorphClip,
} from '../src/renderer/cpatchMorphCert.js';
import { packCPatchMorphFrame, planCPatchMorphSegment } from '../src/renderer/cpatchPack.js';

let pass = 0,
  fail = 0;
const ok = (m) => {
  console.log('ok ' + m);
  pass++;
};
const bad = (m) => {
  console.log('FAIL ' + m);
  fail++;
};

const K = 6;
// A blob that grows, bows further, and (at phase != 0) rotates as it goes -- enough motion that
// one decomposition cannot serve the whole morph, which is the case worth pinning.
const blob = (t, phase, kind) => {
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
    } else if (kind === 'rquad') out.push({ t: 'rquad', P: [A, [mx, my], B], w: 0.75 });
    else out.push({ t: 'quad', P: [A, [mx, my], B] });
  }
  return out;
};

// The source pose is converted with a LEAK MARGIN: a decomposition that merely avoids leaking is
// valid and useless here, because it is about to be applied to poses the converter never saw.
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

for (const kind of ['quad', 'rquad', 'cubic']) {
  for (const phase of [0, 1.0, 2.0]) {
    const [A, B] = splitForMorph(blob(0, phase, kind), blob(1, phase, kind));
    if (kind === 'rquad') {
      // The former fixture changed weights .75 -> .85 while its reference pose
      // silently retained .75. That tested a different curve from the requested
      // destination. This unsupported polynomial model must decline.
      const changed = B.map((c) => ({ ...c, w: 0.85 })),
        report = {};
      const refused = planMorph(
        A,
        changed,
        () => {
          throw Error('Changed weights reached conversion');
        },
        { tolPx: 0.05, report },
      );
      if (refused === null && report.unsupportedWeights)
        ok(`T1 rquad rot ${phase}: changing weights decline before conversion`);
      else bad(`T1 rquad rot ${phase}: changing weights falsely certified`);
    }
    // Time bound off (planMorph's `maxPlanMs`): what this pins is the plan, not how fast a machine makes it.
    const plan = planMorph(A, B, convert, { tolPx: 0.05, maxPlanMs: 0 });
    if (!plan) {
      bad(`T1 ${kind} rot ${phase}: no plan`);
      continue;
    }
    ok(`T1 ${kind} rot ${phase}: ${plan.length} segment(s)`);

    let invalid = 0;
    for (let k = 0; k <= 200; k++) {
      const t = k / 200;
      const pose = A.map((c, i) => ({
        t: c.t,
        cut: c.cut,
        w: c.w,
        _bez: c._bez,
        P: c.P.map((q, m) => [q[0] + (B[i].P[m][0] - q[0]) * t, q[1] + (B[i].P[m][1] - q[1]) * t]),
      }));
      const ps = applyLayout(layoutAt(plan, t), pose);
      if (!ps) {
        invalid++;
        continue;
      }
      for (const l of ps) {
        const f = framePatch(l);
        if (!f || !validatePatch(f, 0.05).ok) {
          invalid++;
          break;
        }
      }
    }
    if (invalid === 0) ok(`T2 ${kind} rot ${phase}: 201/201 sampled poses valid`);
    else bad(`T2 ${kind} rot ${phase}: ${invalid}/201 sampled poses INVALID`);

    // T4/T5 on the ends and the middle of every segment, which is where a layout is most and
    // least stretched.
    let worstCover = 1,
      breaks = 0,
      worstOver = 0,
      prev = null,
      prevSeg = -1,
      segPlan = null;
    for (const seg of plan)
      for (const t of [seg.t0, (seg.t0 + seg.t1) / 2, seg.t1]) {
        const pose = poseAt(A, B, t);
        // THE SEGMENT IS WHICHEVER ONE layoutAt PICKED, not the one being iterated. At a boundary
        // the two touch -- seg.t1 === next.t0 -- and layoutAt returns the first that contains t, so
        // taking the index from the loop reports a structure break where the layout never changed.
        const lay = layoutAt(plan, t);
        const si = plan.findIndex((p) => p.layout === lay);
        const loops = applyLayout(lay, pose);
        const patches = loops ? loops.map((l) => framePatch(l)) : null;
        if (!patches || patches.some((p) => !p)) {
          breaks++;
          continue;
        }
        let ink = 0,
          got = 0,
          over = 0;
        // 150, not 90: at 90 the shape's boundary cells are a percent of the ink on their own, and
        // the check would be measuring the grid rather than the layout.
        const G = 150;
        for (let gy = 0; gy < G; gy++) {
          const y = 20 + 160 * ((gy + 0.5) / G);
          for (let gx = 0; gx < G; gx++) {
            const x = 20 + 160 * ((gx + 0.5) / G);
            const truth = insideContour(pose, x, y);
            let hit = false;
            for (const p of patches)
              if (inPatch(p, x, y)) {
                hit = true;
                break;
              }
            if (truth) {
              ink++;
              if (hit) got++;
            } else if (hit) over++;
          }
        }
        worstCover = Math.min(worstCover, got / Math.max(1, ink));
        worstOver = Math.max(worstOver, over / Math.max(1, ink));
        if (si !== prevSeg || !segPlan) {
          const fr = (tt) => {
            const ls = applyLayout(lay, poseAt(A, B, tt));
            if (!ls) return null;
            const o = [];
            for (const l of ls) {
              const f = framePatch(l);
              if (!f) return null;
              o.push(f);
            }
            return o;
          };
          const a2 = fr(plan[si].t0),
            b2 = fr(plan[si].t1);
          segPlan = a2 && b2 ? planCPatchMorphSegment(a2, b2, 0, {}) : null;
          prev = null;
        }
        if (!segPlan) {
          breaks++;
          continue;
        }
        const pk = packCPatchMorphFrame(patches, segPlan, si === prevSeg ? prev : null);
        if (!pk) {
          breaks++;
          continue;
        }
        if (si === prevSeg && prev && (pk.texels !== prev.texels || pk.verts !== prev.verts))
          breaks++;
        prev = pk;
        prevSeg = si;
      }
    if (worstCover > 0.99 && worstOver < 0.01)
      ok(
        `T4 ${kind} rot ${phase}: covers ${(100 * worstCover).toFixed(1)}% at worst, over ${(100 * worstOver).toFixed(2)}%`,
      );
    else
      bad(
        `T4 ${kind} rot ${phase}: covers only ${(100 * worstCover).toFixed(1)}%, over ${(100 * worstOver).toFixed(2)}%`,
      );
    if (breaks === 0)
      ok(`T5 ${kind} rot ${phase}: frame packing reuses its arrays within every segment`);
    else bad(`T5 ${kind} rot ${phase}: ${breaks} structure break(s)`);
  }
}

function poseAt(A, B, t) {
  return A.map((c, i) => ({
    t: c.t,
    cut: c.cut,
    w: c.w,
    _bez: c._bez,
    P: c.P.map((q, m) => [q[0] + (B[i].P[m][0] - q[0]) * t, q[1] + (B[i].P[m][1] - q[1]) * t]),
  }));
}

{
  // A patch whose orientation cannot be established is not a certified patch. Feeding the clip
  // certificate a degenerate pair -- every control point identical, so there is no interior and
  // no side to be on -- must come back not-ok rather than vacuously certified.
  const dot = [
    {
      t: 'line',
      P: [
        [5, 5],
        [5, 5],
      ],
    },
    {
      t: 'line',
      P: [
        [5, 5],
        [5, 5],
      ],
    },
  ];
  const c = certifyMorphClip(dot, dot, { tolPx: 0.05 });
  if (!c.ok) ok('T3 a pair that cannot be settled reports not-ok');
  else bad('T3 a degenerate pair was certified');
}

console.log(`\nCPATCH MORPH PLAN ${fail ? 'FAIL' : 'PASS'} (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
