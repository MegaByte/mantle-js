// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitStrokeCurveJoinSmoke — the stroke hit test's CURVE joins.
//
// A straight segment's interior end takes lineJoinContains, which test/hitStrokeJoinSvgShapeSmoke.mjs
// sweeps over 360 polylines and which is exact against SVG 2. A CURVE's takes capJoinDist, pinned
// here over the seeded poly-quads of test/_strokeCurveRef.mjs. The hit test answers for the pixels
// the renderer draws, and the renderer is the side proven against the exact SVG 2 shape, so any
// difference is a split between two answers to one question, and it is this file's side to hold.
// Four rules hold it:
//
//   `exactBevelChordDist` ADDS `dot(q, bis)`. The chord joins the two outer offset points
//         halfW*nA and halfW*nB and its outward normal is the bisector, so a point on it must
//         report exactly halfW; with the sign flipped the term goes deeply negative, `max(vertDist,
//         chord)` never rises above vertDist, and the curve bevel join — and the curve MITER past
//         its limit, which falls through to the same chord — keeps the full halfW disc.
//   the START-vertex early return tests `dot(q, inTan) > 0`, the same sense as
//         _strokeMath.glsl's `behindJoin`.
//   every JOIN HAS ITS WEDGE. SVG 2 puts every join shape inside the wedge between the two
//         segments' perpendiculars and ends the segment outside it, as the renderer does on
//         lines, on curve miter/miter-clip/arcs and on curve round/bevel. Without it capJoinDist
//         falls through to `vertDist` — the disc — for all five.
//   the curve miter's half-angle is sqrt((1 + dot(T, N)) / 2), as lineJoinContains and JOIN_ARCS
//         in curveGeom.js use, not `sqrt((1 - |dot(T, N)|) / 2)` (cos(theta/2) with an abs() on
//         top). Past the limit, miter-clip clips on the bisector distance, not on `d1 + d2 <= 2 *
//         maxTip * sinHalf` — an L1 test on ABSOLUTE strip distances, which equals the bisector
//         distance only where both signed terms are positive.
//
//   (a) hit and render answer the same shape, on all five joins;
//   (b) and what is left against SVG 2 is the RENDERER's own gap, shared by both;
//   (c) the split, join by join, against the same hit test without the wedge gate;
//   (d) each rule, reverted, is caught;
//   (e) the sources say the same thing.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeCurveCases, pixelsCurve, svgInsideCurve, minDistCurve } from './_strokeCurveRef.mjs';
import { JOINS } from './_strokeShapeRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();

const GEOM_PATH = path.join(ROOT, 'src/hitTest/curveGeom.js');
const GEOM_SRC = readFileSync(GEOM_PATH, 'utf8');
const loadGeom = (src) => {
  const abs = src.replace(
    /from '(\.\.?\/[^']+)'/g,
    (m, rel) => `from '${new URL(rel, pathToFileURL(GEOM_PATH)).href}'`,
  );
  return import('data:text/javascript;base64,' + Buffer.from(abs).toString('base64'));
};
const mutant = (from, to, name) => {
  ok(GEOM_SRC.includes(from), `mutation hinge present: ${name}`);
  return loadGeom(GEOM_SRC.replace(from, to));
};
const SHIPPED = await loadGeom(GEOM_SRC);
const FLIPPED_CHORD = await mutant(
  'return halfW + (qx * bisx + qy * bisy) - halfW * (nAx * bisx + nAy * bisy);',
  'return halfW - (qx * bisx + qy * bisy) - halfW * (nAx * bisx + nAy * bisy);',
  'the chord sign',
);
const WEDGE_HINGE = `  {
    const nl = Math.hypot(Nx, Ny) || 1;
    const side = (qx * Nx + qy * Ny) / nl;
    if (atStart ? side < 0 : side > 0) {
      // The plane is an edge only AHEAD of it (the shader's aJ > 0.0): behind it the point is inside this segment's body and the
      // neighbor's, and the end gate's zone (1e-4 of the segment) must not read the plane as the shape's boundary.
      const aOut = atStart ? -(qx * Tx + qy * Ty) : (qx * Tx + qy * Ty);
      return aOut > 0 ? Math.max(vertDist, halfW + aOut) : vertDist;
    }
  }
`;
const NO_WEDGE = await mutant(
  WEDGE_HINGE,
  '  if (joinStyle === JOIN_BEVEL && !atStart && qx * Nx + qy * Ny > 0) return Infinity;\n',
  'the join wedge',
);
const SIN_HINGE = 'const sinHalf = 0.5 * Math.hypot(Tx + Nx, Ty + Ny);'; // half the distance between (-T) and N (the 1 + dot form canceled near a reversal)
const COS_HALF = await mutant(
  SIN_HINGE,
  'const sinHalf = 0.5 * Math.hypot(Tx - Nx, Ty - Ny);', // cos(theta/2): the inverted half-angle
  'the miter half-angle',
);
const CLIP_HINGE =
  'if (tl > 1e-4) dc = Math.max(dc, halfW + (qx * tipx + qy * tipy) / tl - halfW * mlj);';
const L1_CLIP = await mutant(
  CLIP_HINGE,
  'if (tl > 1e-4) dc = Math.max(dc, (d1 + d2 <= 2 * maxTip * sinHalf) ? -Infinity : Infinity);',
  'the miter-clip bisector clip',
);

const toHitSegs = (segs) =>
  segs.map((s) => ({
    t: 1,
    x0: s.p0[0],
    y0: s.p0[1],
    cx: s.p1[0],
    cy: s.p1[1],
    x1: s.p2[0],
    y1: s.p2[1],
    f: false,
    sd: 0,
    freeS: s.freeStart,
    freeE: s.freeEnd,
    itx: s.inTan[0],
    ity: s.inTan[1],
    otx: s.outTan[0],
    oty: s.outTan[1],
    kSS: s.kSS,
    kSE: s.kSE,
    kPE: s.kPE,
    kNS: s.kNS,
  }));
// Every chain with an interior vertex — a single open quad has no join to test.
const cases = makeCurveCases(0x2c17, 300)
  .concat(makeCurveCases(0x4f31, 300))
  .filter((cs) => cs.segs.length >= 2 || cs.closed);

/** Hit-vs-render and hit-vs-SVG-2 counts for one join style and one build of curveGeom. */
function sweep(geom, join, set = cases, collect = null, renderRule = 'fixed') {
  let n = 0,
    hitOut = 0,
    miss = 0,
    vsRender = 0,
    renderOut = 0,
    renderMiss = 0;
  for (const cs of set) {
    const hs = toHitSegs(cs.segs);
    for (const c of pixelsCurve(cs)) {
      const inSvg = svgInsideCurve(c, cs.segs, cs.closed, cs.halfW, cs.cap, join, cs.miterLimit);
      const painted =
        minDistCurve(renderRule, c, cs.segs, cs.halfW, cs.cap, join, cs.miterLimit).minD <=
        cs.halfW;
      const hit = geom.pointOnStroke(
        hs,
        c[0],
        c[1],
        cs.halfW,
        cs.cap,
        join,
        cs.miterLimit,
        null,
        0,
      );
      n++;
      if (hit && !inSvg) hitOut++;
      if (!hit && inSvg) miss++;
      if (hit !== painted) {
        vsRender++;
        if (collect) collect.push({ cs, c, hit, inSvg });
      }
      if (painted && !inSvg) renderOut++;
      if (!painted && inSvg) renderMiss++;
    }
  }
  return { n, hitOut, miss, vsRender, renderOut, renderMiss };
}

// ---- (a)/(b)/(c) the split, join by join ------------------------------------------------------------
const BASE = { miter: 2632, round: 95, bevel: 68, 'miter-clip': 7720, arcs: 271 };
const split = [];
for (let j = 0; j < 5; j++) {
  const name = JOINS[j],
    residual = [];
  const s = sweep(SHIPPED, j, cases, residual);
  const b = sweep(NO_WEDGE, j);
  split.push({ name, s, b, residual });
  ok(
    s.vsRender === 0 && s.vsRender < b.vsRender,
    `(c) ${name}: hit and render split at ${s.vsRender} of ${s.n} centers, against ${b.vsRender} without the wedge gate (a hit test without the four rules: ${BASE[name]})`,
  );
  ok(
    s.hitOut <= s.renderOut,
    `(b) ${name}: the hit test paints nothing outside SVG 2 that the renderer does not — hit ${s.hitOut} outside / ${s.miss} missed, render ${s.renderOut} / ${s.renderMiss}`,
  );
}
ok(
  split.every((x) => x.s.vsRender === 0),
  '(a) hit and render answer ONE shape on all five join styles — the split is 0 everywhere',
);

// ---- (a) the square-cap control: a RENDERER rule, seen from the hit side ------------------------------
// The renderer's square cap must not drop a segment whose closest point is genuinely interior. With
// that rule reverted in the renderer model alone (the 'squareCapFrontDrop' arm of test/_strokeCurveRef.mjs) and
// the hit test as shipped, the split comes back at exactly five centers, THE same FIVE under all five
// join styles: no join rule explains them, and at each the hit test and SVG 2 agree.
// test/strokeSquareCapDropSmoke.mjs owns the cap rule itself and measures what it is worth in ink.
{
  const pre = [],
    preSum = sweep(SHIPPED, 0, cases, pre, 'squareCapFrontDrop');
  const keys = new Set(pre.map((r) => `${r.c[0].toFixed(4)},${r.c[1].toFixed(4)}`));
  ok(
    preSum.vsRender === 5 && keys.size === 5,
    `(a) with the square-cap rule reverted the split comes back at ${preSum.vsRender} centers, ${keys.size} distinct — five no join rule explains`,
  );
  ok(
    pre.length > 0 && pre.every((r) => r.hit && r.inSvg),
    "(a) at every one of them the hit test says INSIDE and the exact SVG 2 shape says INSIDE, and the reverted RENDERER drops the segment — so the hit test is right and the split is the renderer's",
  );
  ok(
    pre.length > 0 && pre.every((r) => r.cs.cap === 2),
    '(a) and all five are on a SQUARE cap, none at a join: strokeCapsJoinsDash gates the cap branch on `t < 1e-4`, which also admits a closest point that is genuinely INTERIOR at t in (0, 1e-4) — there `a = dot(q, -tangent)` is a rounding away from zero, and a negative `a` DROPS the whole segment',
  );
}

// ---- (d) each rule, reverted ---------------------------------------------------------------------------
{
  // The mutation arms run on half the set; they are there to show a large delta, not to measure.
  const HALF = cases.filter((_, i) => i % 2 === 0);
  const ref = (j) => sweep(SHIPPED, j, HALF);
  const f = sweep(FLIPPED_CHORD, 2, HALF),
    r2 = ref(2);
  ok(
    f.hitOut > 2000 && f.vsRender > 2000,
    `(d) the chord sign flipped: ${f.hitOut} centers hit outside SVG 2 and ${f.vsRender} apart from the renderer, against ${r2.hitOut} / ${r2.vsRender}`,
  );
  const w = sweep(NO_WEDGE, 0, HALF),
    r0 = ref(0);
  ok(
    w.vsRender > r0.vsRender * 10,
    `(d) the join wedge removed: ${w.vsRender} centers apart from the renderer against ${r0.vsRender} — the disc comes back at every interior vertex`,
  );
  // The half-angle shows on MITER, where `tipDist <= maxTip` decides kite-or-bevel outright; on
  // miter-clip the clip line is independent of it, so it hides there (2 centers of 1.69M).
  const ch = sweep(COS_HALF, 0, HALF);
  ok(
    ch.vsRender > r0.vsRender * 10,
    `(d) the half-angle inverted: ${ch.vsRender} centers apart on MITER against ${r0.vsRender} — every shallow join reads as past its limit and bevels`,
  );
  const r3 = ref(3);
  const l1 = sweep(L1_CLIP, 3, HALF);
  ok(
    l1.vsRender > r3.vsRender * 10,
    `(d) the miter-clip clip back on |d1| + |d2|: ${l1.vsRender} centers apart against ${r3.vsRender} — the L1 form only equals the bisector distance where both signed terms are positive`,
  );
}

// ---- (e) the sources -----------------------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  ok(
    /thisD = max\(thisD, halfW \+ dot\(-ep, bis\) - halfW \* dot\(nA, bis\)\); \}/.test(gl),
    '(e) _strokeMath.glsl: the start-vertex bevel chord is halfW + dot(q, bis) - halfW * dot(nA, bis)',
  );
  // (ONE copy serves both ends: uOwn is the end's outward direction, -tOwn at the start)
  ok(
    /else if \(behindJoin\) thisD = dot\(-ep, uOwn\) > 0\.0 \? max\(min\(thisD, length\(ep\)\), halfW \+ dot\(-ep, uOwn\)\) : min\(thisD, length\(ep\)\);/.test(
      gl,
    ) && /vec2 uOwn = atS \? -tOwn : tOwn;/.test(gl),
    '(e) and outside the wedge every join style ends in a butt end there',
  );
  ok(
    GEOM_SRC.includes(WEDGE_HINGE),
    '(e) src/hitTest/curveGeom.js carries the same wedge, for every join style',
  );
  ok(
    GEOM_SRC.includes(SIN_HINGE) && GEOM_SRC.includes(CLIP_HINGE),
    "(e) and the miter half-angle and the bisector clip are the shader's, not the L1 stand-in",
  );
  ok(
    /const sinHalf = 0\.5 \* Math\.hypot\(tAx \+ tBx, tAy \+ tBy\);/.test(GEOM_SRC),
    '(e) which is the same half-angle lineJoinContains uses (half the distance between the unit vectors), in the same file',
  );
}

console.log(
  `${fail ? 'HIT-STROKE-CURVE-JOIN FAIL' : 'HIT-STROKE-CURVE-JOIN PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
