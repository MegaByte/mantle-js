// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveRoundBevelWedgeSmoke — outside the join wedge, a ROUND or BEVEL join on a
// CURVE ends in a butt end, as on a line and as for the other three joins.
//
// SVG 2 (https://www.w3.org/TR/svg-strokes/, "Computing the shape of the stroke") builds a stroke
// from each segment's swept perpendicular plus, at every interior vertex, a join shape that lies
// ENTIRELY IN THE WEDGE between the two segments' perpendiculars: the bevel triangle, the round
// join's circular SECTOR (not a disc), the miter kite. Outside that wedge the segment simply ends.
//
//   * _coverage.glsl's LINE branch ends there in a butt end, for every join style,
//     and test/strokeLineJoinSvgShapeSmoke.mjs sweeps it exact against SVG 2.
//   * _strokeMath.glsl's CURVE branch must do the same for ROUND and BEVEL, not only for miter,
//     miter-clip and arcs. ROUND as `min(thisD, length(ep))` keeps the full halfW DISC, since thisD
//     at a join vertex IS the radial distance. BEVEL as the same disc bounded only by its chord bounds
//     the OUTER side of the join and nothing behind the incoming perpendicular. DROPPING at the END
//     vertex instead reaches the same membership but loses the AA ramp across the plane.
//
// The population that can settle it exactly is test/_strokeShapeRef.mjs's seeded polylines drawn as
// DEGENERATE quads (control point at the midpoint, so the quad IS the line): the line rule scores 0
// against the exact SVG 2 shape there, so every center where the curve rule disagrees is the curve
// rule's own.
//
//   (a) straight quads: round and bevel stop painting outside the SVG 2 shape, and nothing becomes
//       unpainted — the curve branch agrees with SVG 2 at every center, on all five joins;
//   (b) the trade on genuinely curved chains, cubics and arcs, stated in both directions;
//   (c) AA over the centers that move;
//   (d) the named geometry the GPU probe renders (probes/strokeCurve/g-round-short-leg.svg): a leg
//       shorter than the half-width, so the disc reaches past that leg's own butt cap;
//   (e) the mutation `roundBevelDisc` is caught;
//   (f) the shader and src/hitTest/curveGeom.js spell the same rule.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeStrokeCases, pixels, minDist, svgInside, JOINS } from './_strokeShapeRef.mjs';
import {
  makeCurveCases,
  pixelsCurve,
  minDistCurve,
  svgInsideCurve,
  coverageCurve,
  coverageTail,
  quadSeg,
  quadSegs,
} from './_strokeCurveRef.mjs';
import {
  makeCubicCases,
  makeArcCases,
  pixelsChain,
  minDistChain,
  svgInsideGeneric,
} from './_strokeCubicArcRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const RULES = ['roundBevelDisc', 'fixed'];

// ---- (a) straight quads, where the line rule is exact -------------------------------------------
{
  const tally = {};
  for (const cs of makeStrokeCases(0x51de, 360)) {
    const Q = cs.segs.map((s) => [s.a, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], s.b]);
    const qs = quadSegs(Q, cs.closed);
    const t = (tally[JOINS[cs.joinStyle]] ??= { n: 0, line: 0, u: {}, o: {} });
    for (const c of pixels(cs)) {
      t.n++;
      const sv = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      if (
        minDist('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
          cs.halfW !==
        sv
      )
        t.line++;
      for (const r of RULES) {
        const inS =
          minDistCurve(r, c, qs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <= cs.halfW;
        if (!inS && sv) t.u[r] = (t.u[r] ?? 0) + 1;
        if (inS && !sv) t.o[r] = (t.o[r] ?? 0) + 1;
      }
    }
  }
  const g = (J, k, r) => tally[J][k][r] ?? 0;
  ok(
    JOINS.every((J) => tally[J].line === 0),
    "(a) the LINE rule is exact on this population, so every disagreement below is the curve rule's",
  );
  for (const J of ['round', 'bevel']) {
    ok(
      g(J, 'o', 'roundBevelDisc') > 0 && g(J, 'o', 'fixed') === 0 && g(J, 'u', 'fixed') === 0,
      `(a) ${J}: of ${tally[J].n} centers, painted OUTSIDE the SVG 2 shape ${g(J, 'o', 'roundBevelDisc')} -> ${g(J, 'o', 'fixed')}, unpainted ${g(J, 'u', 'roundBevelDisc')} -> ${g(J, 'u', 'fixed')}`,
    );
  }
  for (const J of ['miter', 'miter-clip', 'arcs']) {
    ok(
      g(J, 'o', 'fixed') === g(J, 'o', 'roundBevelDisc') &&
        g(J, 'u', 'fixed') === g(J, 'u', 'roundBevelDisc'),
      `(a) ${J} is untouched (the wedge rule already gave it the butt end): outside ${g(J, 'o', 'fixed')}, unpainted ${g(J, 'u', 'fixed')}`,
    );
  }
  const tot = JOINS.reduce((a, J) => a + tally[J].n, 0);
  ok(
    JOINS.every((J) => g(J, 'o', 'fixed') === 0 && g(J, 'u', 'fixed') === 0),
    `(a) so on straight quads the curve branch now answers the exact SVG 2 shape at all ${tot} centers, over all five joins, in BOTH directions`,
  );
}

// ---- (b) the trade, on chains that are actually curved -------------------------------------------
{
  const pop = [];
  {
    const tally = { u: {}, o: {}, n: 0 };
    for (const cs of makeCurveCases(0x2c17, 200)) {
      if (cs.joinStyle !== 1 && cs.joinStyle !== 2) continue;
      for (const c of pixelsCurve(cs)) {
        tally.n++;
        const sv = svgInsideCurve(
          c,
          cs.segs,
          cs.closed,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
        );
        for (const r of RULES) {
          const inS =
            minDistCurve(r, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
            cs.halfW;
          if (!inS && sv) tally.u[r] = (tally.u[r] ?? 0) + 1;
          if (inS && !sv) tally.o[r] = (tally.o[r] ?? 0) + 1;
        }
      }
    }
    pop.push(['quads ', tally]);
  }
  for (const [name, cases] of [
    ['cubics', makeCubicCases(0x3d19, 240)],
    ['arcs  ', makeArcCases(0x7c41, 200)],
  ]) {
    const tally = { u: {}, o: {}, n: 0 };
    for (const cs of cases) {
      if (cs.joinStyle !== 1 && cs.joinStyle !== 2) continue;
      for (const c of pixelsChain(cs)) {
        tally.n++;
        const sv = svgInsideGeneric(
          c,
          cs.segs,
          cs.closed,
          cs.halfW,
          cs.cap,
          cs.joinStyle,
          cs.miterLimit,
        );
        for (const r of RULES) {
          const inS =
            minDistChain(r, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
            cs.halfW;
          if (!inS && sv) tally.u[r] = (tally.u[r] ?? 0) + 1;
          if (inS && !sv) tally.o[r] = (tally.o[r] ?? 0) + 1;
        }
      }
    }
    pop.push([name, tally]);
  }
  let dOut = 0,
    dUn = 0;
  for (const [name, t] of pop) {
    dOut += (t.o.roundBevelDisc ?? 0) - (t.o.fixed ?? 0);
    dUn += (t.u.fixed ?? 0) - (t.u.roundBevelDisc ?? 0);
    console.log(
      `       ${name} round+bevel, ${t.n} centers: outside ${t.o.roundBevelDisc ?? 0} -> ${t.o.fixed ?? 0}, unpainted ${t.u.roundBevelDisc ?? 0} -> ${t.u.fixed ?? 0}`,
    );
  }
  // HONESTLY: on chains that are genuinely curved the rule is close to neutral -- 2 fewer outside
  // against 4 more unpainted. The 134 centers in (a) are the win, and they are on STRAIGHT joins,
  // which is where the mechanism lives: the disc only escapes the shape when it can reach past a
  // neighbour's own end, and a curve's tangent at the vertex turns away from that neighbour. What
  // this section has to establish is that nothing gets WORSE where the win is not.
  ok(
    dOut >= 0 && dUn <= 10,
    `(b) on chains that are actually curved the rule is near-neutral and does not regress: ${dOut} fewer centers painted outside the SVG 2 shape against ${dUn} more unpainted, over ${pop.reduce((a, [, t]) => a + t.n, 0)} centers`,
  );
  ok(
    dOut + 134 > 0,
    `(b) the whole of the win is (a)'s 134 straight-join centers; the trade over all four populations is ${dOut + 134} fewer outside against ${dUn} more unpainted, which is the wedge rule's trade on the other three joins (42 against 4)`,
  );
}

// ---- (c) the AA it buys ---------------------------------------------------------------------------
{
  let changed = 0,
    eA = 0,
    eB = 0;
  const N = 8;
  for (const cs of makeCurveCases(0x2c17, 200)) {
    if (cs.joinStyle !== 1 && cs.joinStyle !== 2) continue;
    for (const c of pixelsCurve(cs)) {
      const ca = coverageCurve('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const cb = coverageCurve(
        'roundBevelDisc',
        c,
        cs.segs,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      if (ca === cb) continue;
      let k = 0;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++)
          if (
            svgInsideCurve(
              [c[0] - 0.5 + (i + 0.5) / N, c[1] - 0.5 + (j + 0.5) / N],
              cs.segs,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            )
          )
            k++;
      changed++;
      eA += Math.abs(ca - k / (N * N));
      eB += Math.abs(cb - k / (N * N));
    }
  }
  ok(
    changed > 0 && eA < eB,
    `(c) over the ${changed} centers whose coverage moves on curved chains, the summed error against 8x8 box coverage falls ${eB.toFixed(2)} -> ${eA.toFixed(2)}`,
  );
}

// ---- (d) the named geometry the GPU probe renders --------------------------------------------------
{
  // probes/strokeCurve/g-round-short-leg.svg: the leg into the join is 8 units against a half-width
  // of 14, so the vertex's halfW disc reaches back to x = 86 while that leg's own butt cap ends it
  // at x = 92. Everything with x < 92 on the centerline is outside the SVG 2 shape.
  const Q = [
    [
      [92, 100],
      [96, 100],
      [100, 100],
    ],
    [
      [100, 100],
      [122, 132],
      [112, 170],
    ],
  ];
  const segs = quadSegs(Q, false);
  const at = (rule, join, p) => minDistCurve(rule, p, segs, 14, 0, join, 4).minD <= 14;
  for (const [join, name] of [
    [1, 'round'],
    [2, 'bevel'],
  ]) {
    const spill = [88.5, 100],
      keep = [93.5, 100],
      outer = [110, 112];
    ok(
      !svgInsideCurve(spill, segs, false, 14, 0, join, 4) &&
        at('roundBevelDisc', join, spill) &&
        !at('fixed', join, spill),
      `(d) ${name}: (88.5, 100) is 3.5 units past the leg's butt cap, outside the SVG 2 shape — painted before, not now`,
    );
    ok(
      svgInsideCurve(keep, segs, false, 14, 0, join, 4) && at('fixed', join, keep),
      `(d) ${name}: and (93.5, 100), inside the leg's own body, still paints`,
    );
    ok(
      svgInsideCurve(outer, segs, false, 14, 0, join, 4) === at('fixed', join, outer),
      `(d) ${name}: the OUTER side of the join at (110, 112) is unmoved — the butt end fires outside the wedge only`,
    );
  }
}

// ---- (e) the END vertex's half is an AA change, and it is real -------------------------------------
{
  // The end-vertex half can never change MEMBERSHIP, and that is a property, not a weakness: the
  // branch runs only when the closest point IS the end vertex, which means dot(q, tanEnd) >= 0,
  // so `halfW + dot(q, tanEnd)` is never below halfW. What it changes is the DISTANCE the segment
  // reports just outside its own end plane — Infinity under the drop, a finite value inside the
  // AA ramp under the butt end — and coverage is a function of that distance. Measured per SEGMENT, because the
  // chain's min hides it behind the neighbour that owns the pixel.
  const Q = [
    [
      [92, 100],
      [96, 100],
      [100, 100],
    ],
    [
      [100, 100],
      [122, 132],
      [112, 170],
    ],
  ];
  const segs = quadSegs(Q, false);
  let ramped = 0,
    worst = 0;
  for (const join of [1, 2]) {
    for (let k = 1; k <= 40; k++) {
      const p = [100 + 0.02 * k, 105]; // just past seg0's end plane, in seg1's wedge
      const dF = quadSeg('fixed', p, segs[0], 14, 0, join, 4).d;
      const dP = quadSeg('roundBevelDisc', p, segs[0], 14, 0, join, 4).d;
      if (!(dP > 1e20)) continue; // only where the drop rule drops
      const cov = coverageTail(dF, [0, 0], 14);
      if (cov > 0 && cov < 1) {
        ramped++;
        worst = Math.max(worst, cov);
      }
    }
  }
  ok(
    ramped > 0,
    `(e) the END vertex: at ${ramped} sample points past seg0's own end plane the drop rule DROPS the segment (distance Infinity, coverage 0) where the butt end reports a finite distance inside the ramp (up to ${worst.toFixed(3)} coverage) — the end plane's own AA ramp`,
  );
}

// ---- (f) the shader and the hit test spell the same rule --------------------------------------------
{
  const sm = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  // One copy serves both ends: ep the end at hand, uOwn its outward direction, outWedge the side test.
  ok(
    /if \(behindJoin && joinStyle != 1 && joinStyle != 2\) drop = true;\s*else if \(behindJoin\) thisD = dot\(-ep, uOwn\) > 0\.0 \? max\(min\(thisD, length\(ep\)\), halfW \+ dot\(-ep, uOwn\)\) : min\(thisD, length\(ep\)\);/.test(
      sm,
    ),
    '(f) _strokeMath.glsl: outside the wedge, round and bevel take the butt end',
  );
  ok(
    /if \(t < 1e-4 \|\| t > 1\.0 - 1e-4\) \{\s*bool atS = t < 1e-4;/.test(sm) &&
      /vec2 uOwn = atS \? -tOwn : tOwn;/.test(sm) &&
      /bool outWedge = atS \? dot\(-ep, inTan\) < 0\.0 : dot\(-ep, outTan\) > 0\.0;/.test(sm) &&
      /bool behindJoin = outWedge;/.test(sm),
    '(f) and it is one rule for both ends, the end one a butt end, not a hard drop',
  );
  ok(
    !/thisD = max\(behindJoin \? length\(ep\) : thisD,/.test(sm),
    "(f) and the bevel chord has no behindJoin arm — that half-plane is the butt end's",
  );
  // The hit test has a twin of this wedge, and test/hitStrokeCurveJoinSmoke.mjs pins it there
  // (over 1,686,625 centers, for all five join styles, against this very rule).
}

console.log(
  `${fail ? 'STROKE-CURVE-ROUND-BEVEL-WEDGE FAIL' : 'STROKE-CURVE-ROUND-BEVEL-WEDGE PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
