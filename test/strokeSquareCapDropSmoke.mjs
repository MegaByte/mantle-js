// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeSquareCapDropSmoke — a SQUARE cap never drops a segment whose closest point is genuinely
// interior (_strokeMath.glsl, strokeCapsJoinsDash).
//
// THE SHAPE, FROM SVG 2. https://www.w3.org/TR/svg-strokes/, "Computing the shape of the stroke":
// the body is "all points that lie on the line perpendicular to the subpath at that distance and
// which are within distance stroke-width/2 of the point on the subpath at that position", and a
// square cap adds "a rectangle ... extending stroke-width/2 beyond the end". A cap is therefore a
// UNION with the body, so the cap branch of a distance kernel may only ever LOWER the distance it
// was handed. It may never raise it, and it may certainly never DISCARD the segment.
//
// THE HAZARD. The cap branches run under `t < 1e-4` (and `t > 1 - 1e-4` at the far end), and a
// square-cap branch that reads
//
//     float a = dot(-ep, -segTan);            // how far the pixel lies PAST the cap plane
//     if (a < 0.0) drop = true;               // <-- the whole segment, discarded
//     else { ... thisD = min(thisD, max(perp, a)); }
//
// throws the segment away for a pixel in FRONT of the cap plane instead of keeping the body
// distance the accumulator already computed for it.
//
// WHY IT IS UNREACHABLE IN exact ARITHMETIC, AND REACHABLE AS WRITTEN. If the closest point really
// is the start vertex, the first-order condition for a minimum at the left end of [0, 1] is
//
//     d/dt |C(t) - q|^2 |_(t=0) >= 0   <=>   dot(q - C(0), C'(0)) <= 0   <=>   a >= 0,
//
// which is exactly the `else` arm: at a genuine endpoint minimum the drop cannot fire. What makes
// it fire is that `t < 1e-4` is a PARAMETER-SPACE TOLERANCE, not the statement "t == 0": it also
// admits a closest point at t in (0, 1e-4), and there the pixel is INTERIOR to the segment, `a` is
// a rounding away from zero, and its sign is noise. The same slack is harmless in every other
// branch under the gate, because every other branch modifies a distance; this one alone would
// discard one. (Such centers are the same under all five join styles, so no join rule explains them.)
//
// THE RULE is `if (a >= 0.0)`, with no else — in front of the plane the cap has nothing to say and
// the body distance stands. It cannot add ink anywhere, because what it keeps is a min() over a
// distance the segment already earned.
//
// This smoke checks, on test/_strokeCurveRef.mjs's CPU model of the shader tail (shared by the quad,
// cubic and arc accumulators exactly as the one GLSL function is) against the exact SVG 2 shape:
//   (a) the derivation: every center the drop rule drops has a STRICTLY INTERIOR closest point
//       in (0, 1e-4) and lies within a half-width of the segment — the drop never fires where the
//       closest point really is the vertex;
//   (b) the cost and the direction: over square-capped quads, cubics and arcs at all five joins the
//       under-paint against SVG 2 falls and the centers painted OUTSIDE it do not move at all;
//   (c) the named worst case, deep inside the stroke and dropped entirely;
//   (d) the shader text: both cap branches, in the source and in all four generated shaders.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  makeCurveCases,
  pixelsCurve,
  minDistCurve,
  svgInsideCurve,
  quadClosestT,
  sub,
  dot,
  len,
  mul,
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
const SQUARE = 2; // the cap style this row is about
const JOINS = [0, 1, 2, 3, 4];

// A closed chain has no free end, so no cap: it cannot reach the branch and only costs time.
const quads = [...makeCurveCases(0x2c17, 300), ...makeCurveCases(0x4f31, 300)].filter(
  (c) => !c.closed,
);
const cubics = makeCubicCases(0x3d19, 70).filter((c) => !c.closed);
const arcs = makeArcCases(0x7c41, 60).filter((c) => !c.closed);
const quadsJ = quads.slice(0, 150); // the join sweep in (b), at a lane-sized cost

// ---- (a) the derivation: the drop only ever fires at an INTERIOR closest point -------------------
// A quad's closest point is a root of a cubic and is solved in closed form here, so the parameter
// this checks is the parameter the branch actually gated on — no Newton residual in the way.
{
  let dropped = 0,
    atVertex = 0,
    outsideTube = 0,
    worstT = 0,
    minT = Infinity;
  for (const cs of quads) {
    for (const c of pixelsCurve(cs)) {
      for (const s of cs.segs) {
        if (!s.freeStart && !s.freeEnd) continue;
        const A = [s.p0[0] - 2 * s.p1[0] + s.p2[0], s.p0[1] - 2 * s.p1[1] + s.p2[1]];
        const B = mul(sub(s.p1, s.p0), 2),
          C = sub(s.p0, c);
        const t = quadClosestT(A, B, C);
        const atStart = s.freeStart && t < 1e-4;
        if (!atStart && !(s.freeEnd && t > 1 - 1e-4)) continue;
        // The OUTWARD direction at that end, so `dot(q, tan)` is the branch's own `a`.
        const tan = atStart ? mul(s.tanStart, -1) : s.tanEnd;
        const q = sub(c, atStart ? s.p0 : s.p2);
        if (dot(q, tan) >= 0) continue; // past the plane: not the drop
        dropped++;
        // the closest point is STRICTLY interior — the vertex is not the minimum
        if (t <= 0 || t >= 1) atVertex++;
        const qv = [(A[0] * t + B[0]) * t + C[0], (A[1] * t + B[1]) * t + C[1]];
        if (len(qv) > cs.halfW) outsideTube++;
        worstT = Math.max(worstT, Math.min(t, 1 - t));
        minT = Math.min(minT, Math.min(t, 1 - t));
      }
    }
  }
  ok(
    dropped > 0 && atVertex === 0,
    `(a) the drop fires at ${dropped} square-cap centres and at NONE of them is the closest point the vertex ` +
      `(${atVertex} at t exactly 0 or 1) — a genuine endpoint minimum has dot(q - C(0), C'(0)) <= 0, which IS a >= 0`,
  );
  ok(
    dropped > 0 && worstT > 0 && worstT < 1e-4,
    `(a) every one is inside the gate's slack: the closest-point parameter runs ${minT.toExponential(1)} to ` +
      `${worstT.toExponential(1)} from the end, all strictly inside (0, 1e-4)`,
  );
  ok(
    dropped - outsideTube > 0,
    `(a) and ${dropped - outsideTube} of the ${dropped} lie WITHIN a half-width of the segment's own body — ` +
      `those are the ones the branch cost ink on; past a half-width the segment was painting nothing anyway`,
  );
}

// ---- (b) the cost, by direction, against the exact SVG 2 shape -----------------------------------
function sweep(cases, joinStyle, pix, minD, svgIn) {
  const acc = { n: 0, moved: new Set(), under: [0, 0], out: [0, 0], deepest: null };
  for (let ci = 0; ci < cases.length; ci++) {
    const cs = cases[ci];
    for (const c of pix(cs)) {
      const inSvg = svgIn(c, cs, joinStyle);
      const dFix = minD('fixed', c, cs, joinStyle),
        dPre = minD('squareCapFrontDrop', c, cs, joinStyle);
      const a = dFix <= cs.halfW,
        b = dPre <= cs.halfW;
      acc.n++;
      if (a !== b) acc.moved.add(`${ci}:${c[0].toFixed(6)}:${c[1].toFixed(6)}`);
      if (inSvg) {
        if (!a) acc.under[1]++;
        if (!b) acc.under[0]++;
      } else {
        if (a) acc.out[1]++;
        if (b) acc.out[0]++;
      }
      if (inSvg && !b && a && (!acc.deepest || dFix / cs.halfW < acc.deepest.rel))
        acc.deepest = { rel: dFix / cs.halfW, d: dFix, halfW: cs.halfW, c: c.slice() };
    }
  }
  return acc;
}
const KINDS = [
  [
    'quads ',
    quadsJ,
    pixelsCurve,
    (r, c, cs, j) => minDistCurve(r, c, cs.segs, cs.halfW, SQUARE, j, cs.miterLimit, SQUARE).minD,
    (c, cs, j) => svgInsideCurve(c, cs.segs, cs.closed, cs.halfW, SQUARE, j, cs.miterLimit, SQUARE),
  ],
  [
    'cubics',
    cubics,
    pixelsChain,
    (r, c, cs, j) => minDistChain(r, c, cs.segs, cs.halfW, SQUARE, j, cs.miterLimit, SQUARE).minD,
    (c, cs, j) =>
      svgInsideGeneric(c, cs.segs, cs.closed, cs.halfW, SQUARE, j, cs.miterLimit, SQUARE),
  ],
  [
    'arcs  ',
    arcs,
    pixelsChain,
    (r, c, cs, j) => minDistChain(r, c, cs.segs, cs.halfW, SQUARE, j, cs.miterLimit, SQUARE).minD,
    (c, cs, j) =>
      svgInsideGeneric(c, cs.segs, cs.closed, cs.halfW, SQUARE, j, cs.miterLimit, SQUARE),
  ],
];
const byKind = [];
for (const [label, cases, pix, minD, svgIn] of KINDS) {
  const perJoin = JOINS.map((j) => sweep(cases, j, pix, minD, svgIn));
  for (let i = 0; i < JOINS.length; i++)
    console.log(
      `       ${label} join ${JOINS[i]}: ${perJoin[i].n} centres, ${perJoin[i].moved.size} move — ` +
        `unpainted inside ${perJoin[i].under[0]} -> ${perJoin[i].under[1]}, ` +
        `painted outside ${perJoin[i].out[0]} -> ${perJoin[i].out[1]}`,
    );
  byKind.push([label.trim(), perJoin]);
}
ok(
  byKind.every(([, p]) => p.every((a) => a.moved.size > 0 && a.under[1] < a.under[0])),
  `(b) repairs under-paint on all three segment kinds at every join style: ` +
    byKind.map(([k, p]) => `${k} ${p[0].under[0]}->${p[0].under[1]}`).join(', ') +
    ' (join 0 shown)',
);
ok(
  byKind.every(([, p]) => p.every((a) => a.out[1] === a.out[0])),
  `(b) and adds NO ink anywhere — the centres painted outside the SVG 2 shape are unchanged at all ` +
    `${JOINS.length * byKind.length} kind/join cells, which is what a min() over a distance the body already had must do`,
);
ok(
  byKind.every(([, p]) => p.every((a) => a.moved.size === a.under[0] - a.under[1])),
  `(b) every centre that moves is one of them: ` +
    byKind.map(([k, p]) => `${k} ${p.map((a) => a.moved.size).join('/')}`).join(', '),
);
// THE PROOF THAT IT IS A CAP QUESTION, NOT A JOIN ONE. The centers the drop costs are THE same under all
// five join styles — exactly what a defect in the cap looks like and what no join rule can produce. The whole moved SET is join-independent here for quads and
// cubics. On arcs it is not quite: a few of the centers the cap repairs are masked under some join
// styles, because there the JOIN branch independently raises the distance past a half-width, so the
// membership does not move however the cap answers. Every arc join style still moves a common core.
{
  const stats = byKind.map(([k, p]) => {
    const union = new Set(),
      inter = new Set(p[0].moved);
    for (const a of p) {
      for (const m of a.moved) union.add(m);
      for (const m of inter) if (!a.moved.has(m)) inter.delete(m);
    }
    return [k, union.size, inter.size];
  });
  const exact = stats.filter(([k]) => k === 'quads' || k === 'cubics');
  ok(
    stats.every(([, , i]) => i > 0) && exact.every(([, u, i]) => u === i),
    `(b) and the set of centres it moves is JOIN-INDEPENDENT — ` +
      stats.map(([k, u, i]) => `${k} ${u} union / ${i} under all five`).join(', ') +
      `. No join rule can single out one fixed set of centres under every join style; it is the cap`,
  );
}

// ---- (c) the named case: deep inside the stroke, dropped entirely --------------------------------
{
  const worst = byKind
    .flatMap(([k, p]) => p.map((a) => [k, a.deepest]))
    .filter(([, d]) => d)
    .sort((x, y) => x[1].rel - y[1].rel)[0];
  ok(
    worst ? worst[1].rel < 0.5 : false,
    worst
      ? `(c) the worst centre the drop cost is ${worst[1].d.toFixed(3)} from the centreline of a half-width ` +
          `${worst[1].halfW} stroke (${(worst[1].rel * 100).toFixed(1)}% of the way out, on ${worst[0]}) — ` +
          `not a fringe pixel, the whole segment`
      : '(c) no centre repaired at all — this tree still drops',
  );
}

// ---- (d) the shader text ------------------------------------------------------------------------
{
  const files = [
    'src/shaders/_strokeMath.glsl',
    'src/shaders/generated/mantle.frag.glsl',
    'src/shaders/generated/splitStroke.frag.glsl',
    'src/shaders/generated/maskBake.frag.glsl',
    'src/shaders/generated/aacPoints.vert.glsl',
  ];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    // one copy of the cap rules serves both ends (`if (t < 1e-4 || t > 1.0 - 1e-4)`), so ONE branch is both
    const kept = (src.match(/if \(a >= 0\.0\) \{ float perp = length/g) || []).length;
    const oneCopy = /if \(t < 1e-4 \|\| t > 1\.0 - 1e-4\) \{/.test(src);
    const drops = (
      src.match(/float a = dot\(-ep, -?(?:segTan|uOwn)\);\s*\n\s*if \(a < 0\.0\) drop = true;/g) ||
      []
    ).length;
    ok(
      kept === (oneCopy ? 1 : 2) && drops === 0,
      `(d) ${f}: the square-cap branch${oneCopy ? ' (one copy for both ends)' : 'es'} keep${oneCopy ? 's' : ''} the body distance (${kept}) and none drops (${drops})`,
    );
  }
}

if (fail) {
  console.error(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log('\nstrokeSquareCapDropSmoke: all checks passed');
