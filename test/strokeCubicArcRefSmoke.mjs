// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCubicArcRefSmoke — the stroke references reach CUBICS and ARCS.
//
// The quad stroke references (test/_strokeShapeRef.mjs for the line branch, test/_strokeCurveRef.mjs
// for the curve one) cover the one segment type whose closest point is never in doubt: a quad's is a
// root of a CUBIC, solvable in closed form. The butt-end plane and the miter-clip, bevel-past-limit
// and arcs cut need checking on the other two accumulators, which are not like that:
//
//   * strokeCubicAccum's closest point is a root of a QUINTIC; a seeded solver starts from a 9-sample
//     grid and runs three Newton steps (see (e) for the exact route). Newton converges to whatever basin
//     it starts in, and the basin decides `t` — which is what selects the cap branch, the join branch or the
//     body (see _strokeMath.glsl).
//   * strokeArcAccum's is exact already (distToEllipse is a closed-form ellipse SDF), so an arc row
//     has no solver question at all.
//
// test/_strokeCubicArcRef.mjs carries both types through the same capsJoinsDash the quad port uses,
// with a cubic's closest point available either exactly (bracketed to float64) or as the seeded
// solver computes it (its 'shipped' arm).
//
//   (a) the instrument is sound: a QUAD degree-elevated to a CUBIC answers identically under the
//       exact solver, and svgInsideGeneric equals svgInsideCurve on the same chains;
//   (b) re-run on cubic and arc chains — by COVERAGE, because that fix cannot move membership
//       by construction (its term only fires where the pixel is already inside);
//   (c) re-run on cubic and arc chains, for miter and miter-clip;
//   (d) itself: what the seeded cubic solver's basins cost;
//   (e) what an exact solver buys, in pixels, and which one is exact.
import { makeCurveCases, pixelsCurve, minDistCurve, svgInsideCurve } from './_strokeCurveRef.mjs';
import {
  cubicSegs,
  makeCubicCases,
  makeArcCases,
  pixelsChain,
  minDistChain,
  coverageChain,
  svgInsideGeneric,
} from './_strokeCubicArcRef.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();

// Sized for the node lane: these sweeps are O(pixels x segments x bracketed root solve), and the
// exact solver is 256 brackets deep. The counts below hold every conclusion by a wide margin;
// probes/_strokeRestInk.mjs-style breadth belongs in a probe, not a smoke.
const cubics = makeCubicCases(0x3d19, 40);
const arcs = makeArcCases(0x7c41, 35);

/** painted outside / unpainted inside, against the exact SVG 2 shape. */
function sweep(set, rule, join, capOverride = null) {
  let n = 0,
    over = 0,
    miss = 0;
  for (const cs of set) {
    const cap = capOverride != null ? capOverride : cs.cap;
    for (const c of pixelsChain(cs)) {
      const sv = svgInsideGeneric(c, cs.segs, cs.closed, cs.halfW, cap, join, cs.miterLimit);
      const p =
        minDistChain(rule, c, cs.segs, cs.halfW, cap, join, cs.miterLimit, cap, 'exact').minD <=
        cs.halfW;
      n++;
      if (p && !sv) over++;
      if (!p && sv) miss++;
    }
  }
  return { n, over, miss };
}

// ---- (a) the instrument -------------------------------------------------------------------------
{
  const elevate = ([p0, p1, p2]) => [
    p0,
    [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])],
    [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])],
    p2,
  ];
  const set = makeCurveCases(0x2c17, 70).filter((cs) => cs.segs.length >= 2 || cs.closed);
  let n = 0,
    viaExact = 0,
    viaShipped = 0,
    viaShape = 0;
  for (const JOIN of [3])
    for (const cs of set) {
      const csegs = cubicSegs(cs.Q.map(elevate), cs.closed);
      for (const c of pixelsCurve(cs)) {
        const q =
          minDistCurve('fixed', c, cs.segs, cs.halfW, cs.cap, JOIN, cs.miterLimit).minD <= cs.halfW;
        const ce =
          minDistChain('fixed', c, csegs, cs.halfW, cs.cap, JOIN, cs.miterLimit, cs.cap, 'exact')
            .minD <= cs.halfW;
        const cs2 =
          minDistChain('fixed', c, csegs, cs.halfW, cs.cap, JOIN, cs.miterLimit, cs.cap, 'shipped')
            .minD <= cs.halfW;
        n++;
        if (q !== ce) viaExact++;
        if (q !== cs2) viaShipped++;
        if (
          svgInsideCurve(c, cs.segs, cs.closed, cs.halfW, cs.cap, JOIN, cs.miterLimit) !==
          svgInsideGeneric(c, csegs, cs.closed, cs.halfW, cs.cap, JOIN, cs.miterLimit)
        )
          viaShape++;
      }
    }
  ok(
    n > 1.5e5 && viaExact === 0,
    `(a) a quad degree-elevated to a cubic answers identically under the EXACT solver at all ${n} centers — the cap/join tail really is one shared rule`,
  );
  ok(viaShape === 0, '(a) and svgInsideGeneric is svgInsideCurve on the same chains');
  ok(
    viaShipped > 0,
    `(a) with the SHIPPED solver it does not: ${viaShipped} centers move, on curves that are neither loops nor cusps`,
  );
}

// ---- (b) the butt-end plane on cubics and arcs, by COVERAGE --------------------------------------
{
  const SS = 6;
  for (const [name, set] of [
    ['cubics', cubics.filter((cs) => !cs.closed)],
    ['arcs', arcs],
  ]) {
    let np = 0,
      exact = 0;
    const err = { buttPastEnd: 0, fixed: 0 },
      ink = { buttPastEnd: 0, fixed: 0 };
    for (const cs of set) {
      const last = cs.segs[cs.segs.length - 1];
      const ends = [cs.segs[0].p0, last.type === 'arc' ? last.p1 : last.p3];
      for (const c of pixelsChain(cs)) {
        if (!ends.some((v) => Math.hypot(c[0] - v[0], c[1] - v[1]) <= 2 * cs.halfW + 1.5)) continue;
        let a = 0;
        for (let i = 0; i < SS; i++)
          for (let j = 0; j < SS; j++)
            if (
              svgInsideGeneric(
                [c[0] - 0.5 + (i + 0.5) / SS, c[1] - 0.5 + (j + 0.5) / SS],
                cs.segs,
                cs.closed,
                cs.halfW,
                0,
                1,
                cs.miterLimit,
              )
            )
              a++;
        a /= SS * SS;
        exact += a;
        np++;
        for (const rule of ['buttPastEnd', 'fixed']) {
          const cov = coverageChain(rule, c, cs.segs, cs.halfW, 0, 1, cs.miterLimit, 0, 'exact');
          err[rule] += Math.abs(cov - a);
          ink[rule] += cov;
        }
      }
    }
    ok(
      np > 5000 && err.fixed < err.buttPastEnd,
      `(b) HOLDS on ${name}: ${np} pixels within 2 half-widths of a free butt end, exact area ${exact.toFixed(1)}` +
        ` — summed |coverage - exact| ${err.buttPastEnd.toFixed(1)} -> ${err.fixed.toFixed(1)}, ink ${ink.buttPastEnd.toFixed(1)} -> ${ink.fixed.toFixed(1)}`,
    );
  }
}

// ---- (c) the miter-clip fix on cubics and arcs ----------------------------------------------------
{
  const JOINS = { 0: 'miter', 3: 'miter-clip' };
  for (const [name, set] of [
    ['cubics', cubics],
    ['arcs', arcs],
  ]) {
    for (const join of [0, 3]) {
      const before = sweep(set, 'miterClipClamp', join);
      const after = sweep(set, 'fixed', join);
      ok(
        after.over === 0 && before.over > 0,
        `(c) HOLDS on ${name}, ${JOINS[join]}: of ${before.n} centers, painted outside the SVG 2 shape ${before.over} -> ${after.over} (unpainted inside ${before.miss} -> ${after.miss})`,
      );
    }
  }
  // joinStyle 4 is NOT claimed here: between CURVED segments SVG 2's arcs join is a different
  // construction from the miter-clip svgInsideGeneric falls back to, which is a known gap.
  const a4 = sweep(cubics, 'miterClipClamp', 4),
    b4 = sweep(cubics, 'fixed', 4);
  console.log(
    `       arcs joins on cubics, against SVG 2's miter-clip FALLBACK (a known gap, not a claim):` +
      ` ${a4.over}/${a4.miss} -> ${b4.over}/${b4.miss} of ${a4.n}`,
  );
}

// ---- (d) the seeded cubic solver's basins --------------------------------------------------------
{
  const byKind = {};
  for (const cs of cubics) {
    const b = (byKind[cs.kind] ??= {
      cases: 0,
      n: 0,
      moved: 0,
      dMoved: 0,
      dropSplit: 0,
      preDropSplit: 0,
      worstD: 0,
    });
    b.cases++;
    for (const c of pixelsChain(cs)) {
      b.n++;
      const e = minDistChain(
        'fixed',
        c,
        cs.segs,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
        cs.cap,
        'exact',
      ).minD;
      const s = minDistChain(
        'fixed',
        c,
        cs.segs,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
        cs.cap,
        'shipped',
      ).minD;
      if (e <= cs.halfW !== s <= cs.halfW) b.moved++;
      // One arm dropped every segment and the other did not — a cap branch firing on one side
      // of the basin and not the other. The only branch that can do it is the square cap's
      // `a < 0 -> drop` (the only thing under the `t < 1e-4` gate that could DISCARD a body hit rather
      // than modify its distance), which the current cap does not have, so the arms differ only in
      // DISTANCE. Only a square cap can produce a split, so the drop arm is scored on those cases alone.
      if (cs.cap === 2) {
        const ep = minDistChain(
          'squareCapFrontDrop',
          c,
          cs.segs,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
          cs.cap,
          'exact',
        ).minD;
        const sp = minDistChain(
          'squareCapFrontDrop',
          c,
          cs.segs,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
          cs.cap,
          'shipped',
        ).minD;
        if (ep > 1e20 !== sp > 1e20) b.preDropSplit++;
      }
      if (e > 1e20 !== s > 1e20) {
        b.dropSplit++;
        continue;
      }
      const d = Math.abs(e - s) / cs.halfW;
      if (d > 0.01) b.dMoved++;
      b.worstD = Math.max(b.worstD, d);
    }
  }
  for (const [k, v] of Object.entries(byKind))
    console.log(
      `       ${k.padEnd(6)} ${v.cases} chains, ${v.n} centers: membership moves at ${v.moved}` +
        `, the distance moves by over 1% of a half-width at ${v.dMoved}` +
        `, one arm drops and the other does not at ${v.dropSplit}, worst |dD| ${v.worstD.toFixed(2)} half-widths`,
    );
  const tot = Object.values(byKind).reduce(
    (a, v) => ({
      n: a.n + v.n,
      moved: a.moved + v.moved,
      dMoved: a.dMoved + v.dMoved,
      drop: a.drop + v.dropSplit,
      preDrop: a.preDrop + v.preDropSplit,
    }),
    { n: 0, moved: 0, dMoved: 0, drop: 0, preDrop: 0 },
  );
  ok(
    tot.moved > 0,
    `(d) CONFIRMED: over ${tot.n} centers the seeded cubic solver moves MEMBERSHIP at ${tot.moved} against the exact one, and the distance at ${tot.dMoved}`,
  );
  ok(
    tot.drop === 0 && tot.preDrop > 0,
    `(d) the two arms do not disagree about whether the segment CONTRIBUTES AT ALL — ${tot.preDrop} such splits under the drop rule, ${tot.drop} under the current one. The square cap's ` +
      `\`a < 0 -> drop\` is the only branch under the \`t < 1e-4\` gate that could DISCARD a body hit, so a wrong-basin t would make a whole segment vanish; the basins differ only in DISTANCE`,
  );
  ok(
    byKind.plain && byKind.plain.moved > 0,
    `(d) not only on loops and cusps: ${byKind.plain.moved} of the membership moves are on ordinary curves`,
  );
  const rate = (k) => (100 * byKind[k].moved) / byKind[k].n;
  ok(
    byKind.loop && byKind.cusp && rate('loop') > rate('plain') && rate('cusp') > rate('plain'),
    `(d) and the families _strokeMath.glsl names are the worst: loops ${rate('loop').toFixed(3)}% and cusps ${rate('cusp').toFixed(3)}% of centers against ${rate('plain').toFixed(3)}% on plain curves`,
  );
}

// ---- (e) what an exact solver buys, and which exact solver ---------------------------------------
//
// (d) measures the solver against itself. This measures it against the SHAPE, which is the number a
// decision needs: how many pixel centers would change verdict against the exact SVG 2 stroke if the
// closest point were exact.
//
// The routes compared (probes/_quinticSolveRoutes.mjs, CPU-only):
//
//   route                     worst dist err   poly evals/call
//   seed+Newton                  3.334e+1            12.0
//   sign-scan + bisect           1.819e+0            47.3
//   cheb-trunc + 2 Newton        3.192e+1            12.4
//   f'-quartic (Ferrari)         5.497e+1            33.8
//   DESCENDING CHAIN             1.644e-9           135.2        <- the analytic one
//
// MORE SAMPLING IS NOT THE ANSWER and neither is a better bracket: more Newton steps stay tens of em
// off, and a sign-change bracket is not exact either, since a TANGENCY is a double root and no sign
// test can see it. The route that IS exact is the descending chain — f''' of a quintic is
// QUADRATIC, so solve that in closed form, and each level's roots bracket the next level's, so
// every bracket is monotone and one bisection per bracket cannot miss a root. Subdivision serves an
// analytic solution there: the only closed form needed is the quadratic, and the bisection refines
// an interval already proven to hold exactly one root. strokeCubicDescendSmoke pins it as the
// shader's cubic solver. The `'shipped'` solver arm of test/_strokeCubicArcRef.mjs is the seeded one.
{
  let n = 0,
    sOver = 0,
    sMiss = 0,
    eOver = 0,
    eMiss = 0;
  const byKind = {};
  for (const cs of cubics) {
    const b = (byKind[cs.kind] ??= { n: 0, sMiss: 0, eMiss: 0 });
    for (const c of pixelsChain(cs)) {
      const sv = svgInsideGeneric(
        c,
        cs.segs,
        cs.closed,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      const sh =
        minDistChain(
          'fixed',
          c,
          cs.segs,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
          cs.cap,
          'shipped',
        ).minD <= cs.halfW;
      const ex =
        minDistChain(
          'fixed',
          c,
          cs.segs,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
          cs.cap,
          'exact',
        ).minD <= cs.halfW;
      n++;
      b.n++;
      if (sh && !sv) sOver++;
      if (!sh && sv) {
        sMiss++;
        b.sMiss++;
      }
      if (ex && !sv) eOver++;
      if (!ex && sv) {
        eMiss++;
        b.eMiss++;
      }
    }
  }
  for (const [k, v] of Object.entries(byKind))
    console.log(
      `       ${k.padEnd(6)} ${v.n} centers: unpainted ${v.sMiss} seeded -> ${v.eMiss} exact`,
    );
  ok(
    sMiss > eMiss * 2,
    `(e) the payoff in pixels: over ${n} centers an exact cubic closest point takes the under-paint against SVG 2 from ${sMiss} to ${eMiss} and the over-paint from ${sOver} to ${eOver}`,
  );
  ok(
    byKind.cusp && byKind.loop && byKind.plain && byKind.plain.sMiss > byKind.plain.eMiss,
    `(e) and it is not confined to loops and cusps: ordinary curves alone go ${byKind.plain.sMiss} -> ${byKind.plain.eMiss}`,
  );
}

console.log(
  `${fail ? 'STROKE-CUBIC-ARC-REF FAIL' : 'STROKE-CUBIC-ARC-REF PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
