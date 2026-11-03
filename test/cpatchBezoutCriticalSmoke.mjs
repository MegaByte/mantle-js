// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchBezoutCriticalSmoke — a Bezout (kind 4) implicit's interior dips are found by SOLVING, not by
// sampling, and a singular point of the curve is not a dip.
//
// validatePatch composes each implicit along the other boundary curves, which proves containment only
// when the minimum is on the boundary; an interior minimum needs grad f = 0. Every kind is solved for it.
// A "witness" -- the most negative of a 5x5 grid over the patch's box -- is wrong in one direction,
// twice over: a dip between its samples is invisible, and so is a dip whose box holds a MORE negative
// sample outside the patch, because only that one is reported and the caller then rejects it. Kind 4's
// exact form reduces to a quadratic (see bezoutCritical).
//
// (a) SOUND AND COMPLETE against a dense oracle: every returned point is a critical point, and every
//     isolated minimum a dense grid, descent and a Newton polish find is returned.
// (b) THE DEFECT, twice: a Bezier extension's own loop inside a patch, which no witness sample lands
//     in, and the same loop MASKED by a more negative sample outside the patch. The grid witness is
//     carried here so the miss is shown rather than asserted. The patch is still refused -- by the
//     leak test, which walks that extension -- and that is pinned too.
// (c) SINGULAR POINTS ARE NOT DIPS. A loop's double point and a cusp are critical points with f = 0;
//     computed, f is a few ulps of either sign and so is the Hessian, and any ratio reads noise over
//     noise. Includes tiger's real cusp at a doubled control point, which read 2.8 deep.
// (d) DEGENERATE forms: a box with no area, a form constant along one direction, one whose beta
//     coefficient vanishes.
// (e) SCALE: the same geometry from 1e-6 to 1e6 finds the same point and a depth that scales with it.
import * as convert from '../src/renderer/cpatchConvert.js';
import {
  segSlice,
  segPt,
  segImplicit,
  segImplicitPacked,
  implEval,
  implHess,
  packedEval,
} from '../src/geom/cpatchImplicit.js';
import { cubicLoopCuts } from '../src/geom/lbCubicMath.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const { implCritical, criticalDipDepth, framePatch, validatePatch, insideContour, patchEval } =
  convert;
check(typeof implCritical === 'function', 'implCritical is exported');
check(typeof criticalDipDepth === 'function', 'criticalDipDepth is exported');
if (fail) {
  console.error(`CPATCH-BEZOUT-CRITICAL FAIL (${fail})`);
  process.exit(1);
}

let seed = 0x5eed1234;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const numGrad = (pk, x, y, e) => [
  (packedEval(pk, x + e, y) - packedEval(pk, x - e, y)) / (2 * e),
  (packedEval(pk, x, y + e) - packedEval(pk, x, y - e)) / (2 * e),
];

// ---- (a) dense oracle ----
{
  let cases = 0,
    found = 0,
    missed = 0,
    notCritical = 0;
  const box = [-3, -3, 3, 3],
    N = 150;
  for (let it = 0; it < 150; it++) {
    const R = () => [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4];
    const pk = segImplicitPacked({ t: 'cubic', P: [R(), R(), R(), R()], _bez: true });
    if (!pk || pk.kind !== 4) continue;
    cases++;
    const cps = implCritical(pk, box) || [];
    for (const q of cps) {
      const g = numGrad(pk, q[0], q[1], 1e-6),
        gs = numGrad(pk, q[0] + 0.01, q[1] + 0.01, 1e-6);
      if (Math.hypot(g[0], g[1]) > 1e-3 * Math.hypot(gs[0], gs[1])) notCritical++;
    }
    const val = new Float64Array((N + 1) * (N + 1));
    const X = (c) => box[0] + ((box[2] - box[0]) * c) / N,
      Y = (r) => box[1] + ((box[3] - box[1]) * r) / N;
    for (let r = 0; r <= N; r++)
      for (let c = 0; c <= N; c++) val[r * (N + 1) + c] = packedEval(pk, X(c), Y(r));
    for (let r = 1; r < N; r++)
      for (let c = 1; c < N; c++) {
        const v = val[r * (N + 1) + c];
        let isMin = true;
        for (let dr = -1; dr <= 1 && isMin; dr++)
          for (let dc = -1; dc <= 1; dc++)
            if ((dr || dc) && val[(r + dr) * (N + 1) + c + dc] <= v) {
              isMin = false;
              break;
            }
        if (!isMin) continue;
        // A grid minimum in a flat valley is not an isolated minimum: descend until it stops or leaves.
        let x = X(c),
          y = Y(r),
          fx = v,
          step = 0.01,
          left = false;
        for (let k = 0; k < 20000 && step > 1e-13; k++) {
          const g = numGrad(pk, x, y, 1e-7),
            gl = Math.hypot(g[0], g[1]);
          if (!(gl > 0)) break;
          const nx = x - (step * g[0]) / gl,
            ny = y - (step * g[1]) / gl,
            fn = packedEval(pk, nx, ny);
          if (fn < fx) {
            x = nx;
            y = ny;
            fx = fn;
            step *= 1.5;
          } else step *= 0.5;
          if (Math.abs(x) > 3 || Math.abs(y) > 3) {
            left = true;
            break;
          }
        }
        if (left) continue;
        // ...then NEWTON on grad f = 0 from there: descent alone creeps along a flat valley and stops
        // short of the minimum it is heading for, which read as a miss the solver did not make.
        for (let k = 0; k < 60; k++) {
          const e = 1e-5,
            g = numGrad(pk, x, y, 1e-7);
          const gx1 = numGrad(pk, x + e, y, 1e-7),
            gy1 = numGrad(pk, x, y + e, 1e-7);
          const hxx = (gx1[0] - g[0]) / e,
            hxy = (gy1[0] - g[0]) / e,
            hyy = (gy1[1] - g[1]) / e;
          const det = hxx * hyy - hxy * hxy;
          if (!(Math.abs(det) > 0)) break;
          const dx = -(hyy * g[0] - hxy * g[1]) / det,
            dy = -(hxx * g[1] - hxy * g[0]) / det;
          if (!(Math.hypot(dx, dy) < 0.1)) break;
          x += dx;
          y += dy;
          if (Math.hypot(dx, dy) < 1e-12) break;
        }
        if (cps.some((q) => Math.hypot(q[0] - x, q[1] - y) <= 1e-3)) found++;
        else missed++;
      }
  }
  check(cases > 100, `random Bezout forms exercised (${cases})`);
  check(notCritical === 0, `every returned point is a critical point (${notCritical} are not)`);
  check(
    found > 50 && missed === 0,
    `every isolated minimum the dense oracle finds is returned (${found} found, ${missed} missed)`,
  );
}

// ---- the loop patch: an arc cut just past a loop's double point, closed by a box around the loop ----
const LOOP = [
  [0, 0],
  [3, 3],
  [-2, 3],
  [1, 0],
];
const line = (a, b) => ({ t: 'line', P: [a, b] });
function loopPatch(ox, oy, R, S = 1, T = [0, 0]) {
  const P = LOOP.map((p) => [p[0] * S + T[0], p[1] * S + T[1]]);
  const [t1, t2] = cubicLoopCuts(P);
  const sl = segSlice({ t: 'cubic', P }, t2 + 0.005, 1);
  const arc = { t: 'cubic', P: sl.P.map((p) => p.slice()), _bez: true };
  let lx0 = Infinity,
    ly0 = Infinity,
    lx1 = -Infinity,
    ly1 = -Infinity;
  for (let k = 0; k <= 200; k++) {
    const p = segPt({ t: 'cubic', P }, t1 + ((t2 - t1) * k) / 200);
    lx0 = Math.min(lx0, p[0]);
    lx1 = Math.max(lx1, p[0]);
    ly0 = Math.min(ly0, p[1]);
    ly1 = Math.max(ly1, p[1]);
  }
  const cx = (lx0 + lx1) / 2 + ox * R * S,
    cy = (ly0 + ly1) / 2 + oy * R * S,
    h = R * S;
  const C = [
    [cx + h, cy - h],
    [cx + h, cy + h],
    [cx - h, cy + h],
    [cx - h, cy - h],
  ];
  const curves = [
    arc,
    line(arc.P[3], C[0]),
    line(C[0], C[1]),
    line(C[1], C[2]),
    line(C[2], C[3]),
    line(C[3], arc.P[0]),
  ];
  return { P, t1, t2, curves, frame: framePatch(curves) };
}
// THE GRID WITNESS: the most negative of an N x N interior grid over the box.
function oldWitness(frame, i, N = 6) {
  const bb = frame.bbox,
    w = bb[2] - bb[0],
    h = bb[3] - bb[1];
  let bx = 0,
    by = 0,
    bf = 0,
    insideNeg = 0;
  for (let r = 1; r < N; r++)
    for (let c = 1; c < N; c++) {
      const x = bb[0] + w * (c / N),
        y = bb[1] + h * (r / N),
        f = patchEval(frame, i, x, y);
      if (f < bf) {
        bf = f;
        bx = x;
        by = y;
      }
      if (f < 0 && insideContour(frame.curves, x, y)) insideNeg++;
    }
  return { point: bf < 0 ? [bx, by] : null, insideNeg };
}
const ext = (bb) => Math.max(bb[2] - bb[0], bb[3] - bb[1]);
// What validatePatch does with a kind-4 candidate: f < 0, a real dip, inside the patch.
function interiorDips(frame, i) {
  const out = [];
  for (const q of implCritical(frame.impls[i].packed, frame.bbox) || []) {
    const f = patchEval(frame, i, q[0], q[1]);
    if (!(f < 0)) continue;
    const d = criticalDipDepth(frame.impls[i], q[0], q[1], f);
    if (d > 0 && insideContour(frame.curves, q[0], q[1])) out.push({ q, f, d });
  }
  return out;
}

// ---- (b) the defect ----
for (const [label, ox, oy, expectInsideNeg] of [
  ['BETWEEN SAMPLES', -0.2, 0.65, false],
  ['MASKED', -0.4, 0.2, true],
]) {
  const L = loopPatch(ox, oy, 3);
  const fr = L.frame;
  check(
    !!fr && fr.impls[0].packed && fr.impls[0].packed.kind === 4,
    `${label}: the arc is a Bezout constraint`,
  );
  if (!fr) continue;
  const E = ext(fr.bbox);
  // Ground truth, dense: the loop's interior is inside the patch and on the wrong side of the arc.
  let worstF = 0,
    worstAt = null;
  for (let r = 0; r <= 400; r++)
    for (let c = 0; c <= 400; c++) {
      const x = -0.5 + (2 * c) / 400,
        y = 0.2 + (2.2 * r) / 400;
      if (!insideContour(fr.curves, x, y)) continue;
      const f = patchEval(fr, 0, x, y);
      if (f < worstF) {
        worstF = f;
        worstAt = [x, y];
      }
    }
  check(
    worstF < 0,
    `${label}: a dense walk finds the patch holding a negative region of the arc's implicit (${worstF.toExponential(3)})`,
  );
  const W = oldWitness(fr, 0);
  const wReports = !!W.point && insideContour(fr.curves, W.point[0], W.point[1]);
  check(
    !wReports,
    `${label}: the grid witness reports nothing inside the patch${W.point ? ' (its sample is outside)' : ''}`,
  );
  check(
    W.insideNeg > 0 === expectInsideNeg,
    `${label}: ${expectInsideNeg ? 'though a grid sample inside WAS negative' : 'no grid sample lands in the dip at all'} (${W.insideNeg})`,
  );
  const dips = interiorDips(fr, 0);
  check(dips.length === 1, `${label}: the exact form reports the dip (${dips.length})`);
  if (dips.length) {
    const d = dips[0];
    check(
      Math.abs(d.q[0] - 0.5) <= 1e-9 * E,
      `${label}: at the loop's axis of symmetry, x = 0.5 (${d.q[0]})`,
    );
    check(
      worstAt &&
        Math.hypot(d.q[0] - worstAt[0], d.q[1] - worstAt[1]) <= 0.01 &&
        d.f <= worstF + 1e-12,
      `${label}: at the dense walk's minimum, and no higher (${d.f.toExponential(6)})`,
    );
    check(d.d > 0.05 * E, `${label}: a real dip, ${(d.d / E).toFixed(3)} of the patch deep`);
  }
  const v = validatePatch(fr);
  check(
    !v.ok,
    `${label}: and the patch is refused (worst: ${v.worst && v.worst.kind}) -- the leak test walks this extension too`,
  );
}

// ---- (c) singular points ----
{
  // The loop's double point, as a critical point of an arc that passes through it.
  const P = LOOP;
  const [t1] = cubicLoopCuts(P);
  const node = segPt({ t: 'cubic', P }, t1);
  const seg = { t: 'cubic', P, _bez: true };
  const impl = segImplicit(seg),
    pk = segImplicitPacked(seg);
  const bb = [node[0] - 1, node[1] - 1, node[0] + 1, node[1] + 1];
  const cps = implCritical(pk, bb) || [];
  const at = cps.find((q) => Math.hypot(q[0] - node[0], q[1] - node[1]) <= 1e-6);
  check(!!at, 'the double point of a loop is found as a critical point');
  if (at)
    for (const s of [1, -1]) {
      const f = s * implEval(impl, at[0], at[1]);
      check(
        criticalDipDepth({ impl, s }, at[0], at[1], f) === 0,
        `and it is no dip, read with sign ${s} (f = ${f.toExponential(2)})`,
      );
    }
}
{
  // Tiger's shape 35: a cubic sliced from a source whose first two control points coincide -- a cusp at
  // the source's start, which is where the exact solve lands. f and both Hessian eigenvalues there are
  // rounding; without the zero test the second-order form read it 2.8 deep.
  const seg = {
    t: 'cubic',
    P: [
      [702.6848894665682, 413.4214439318748],
      [818.2022622197082, 422.1053310118249],
      [857.5320228571532, 424.705685893029],
      [857.532022858189, 424.7056858930385],
    ],
    _srcP: [
      [857.532022858, 424.705685893],
      [857.532022858, 424.705685893],
      [700.212937528, 414.30426353969995],
      [680.437698968, 421.3668487397],
    ],
  };
  // THE FORM WITH ITS PARAMETER ORIGIN AT P0, which read the cusp 2.8 deep and which a morph normalization still
  // packs (`nrm` keeps the origin: see bezoutOriginP). The shipped static form puts the origin at the double point
  //, and the cusp its solve lands on there reads f >= 0 under both signs -- so the evidence that the zero test
  // is not decoration is taken on the P0 form, where the solve still lands a rounding off the cusp.
  const impl = segImplicit(seg),
    pk = segImplicitPacked({ ...seg, nrm: {} });
  const bb = [680.4378176210819, 413.4214230001175, 857.532022858189, 424.7056858930385];
  check(pk && pk.kind === 4, 'tiger #35: the sliced cusp packs as Bezout');
  const cusp = seg._srcP[0];
  const cps = implCritical(pk, bb) || [];
  const at = cps.find((q) => Math.hypot(q[0] - cusp[0], q[1] - cusp[1]) <= 1e-6 * ext(bb));
  check(!!at, 'tiger #35: the cusp is found as a critical point');
  if (at) {
    let reported = false,
      naive = 0;
    for (const s of [1, -1]) {
      const f = s * implEval(impl, at[0], at[1]);
      if (!(f < 0)) continue;
      if (criticalDipDepth({ impl, s }, at[0], at[1], f) > 0) reported = true;
      // The same second-order distance WITHOUT the zero test: rounding over rounding. This pins a
      // rounding outcome, so if it ever stops reading deep, re-derive it rather than delete it -- it
      // is the evidence that the zero test is not decoration.
      const H = implHess(impl, at[0], at[1]).map((v) => s * v);
      const lmax = 0.5 * (H[0] + H[2]) + Math.hypot(0.5 * (H[0] - H[2]), H[1]);
      if (lmax > 0) naive = Math.max(naive, Math.sqrt((-2 * f) / lmax));
    }
    check(!reported, 'tiger #35: and it is no dip under either sign');
    check(
      naive > 1e-3 * ext(bb),
      `tiger #35: without the zero test the same point reads ${naive.toFixed(3)} deep, ${((100 * naive) / ext(bb)).toFixed(1)}% of its box`,
    );
  }
}
{
  // A cusp built the plain way: the first two control points equal.
  const seg = {
    t: 'cubic',
    P: [
      [0, 0],
      [0, 0],
      [4, 1],
      [1, 3],
    ],
    _bez: true,
  };
  const impl = segImplicit(seg),
    pk = segImplicitPacked(seg);
  const cps = implCritical(pk, [-2, -2, 5, 5]) || [];
  const at = cps.find((q) => Math.hypot(q[0], q[1]) <= 1e-6);
  check(!!at, 'a doubled-control-point cusp is found as a critical point');
  if (at)
    check(
      [1, -1].every((s) => {
        const f = s * implEval(impl, at[0], at[1]);
        return !(f < 0) || criticalDipDepth({ impl, s }, at[0], at[1], f) === 0;
      }),
      'and it is no dip',
    );
}

// ---- (d) degenerate forms ----
{
  const L = loopPatch(-0.2, 0.65, 3);
  const pk = L.frame.impls[0].packed;
  check(
    implCritical(pk, [1, 1, 1, 5]) === null && implCritical(pk, [1, 1, 5, 1]) === null,
    'a box with no area has no interior',
  );
  check(implCritical(null, [0, 0, 1, 1]) === null, 'no packed form, no points');
  // f = -(x+1)*x^2: constant along y. Every negative region is a strip, so there is no isolated point.
  check(
    implCritical(
      {
        kind: 4,
        a: [
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 1],
        ],
        c: [0, 0],
      },
      [-3, -3, 3, 3],
    ) === null,
    'a form that does not vary along one direction returns nothing',
  );
  // beta's coefficient vanishes (A1 parallel to A2), so f is linear in beta: the other branch.
  const pk2 = {
    kind: 4,
    a: [
      [0.3, 1, 0.2],
      [2, 0, -0.5],
      [1, 0, 0.25],
      [1, 0, -0.7],
    ],
    c: [0.4, 1.3],
  };
  const cps = implCritical(pk2, [-3, -3, 3, 3]) || [];
  let ok = cps.length > 0;
  for (const q of cps) {
    const g = numGrad(pk2, q[0], q[1], 1e-6),
      gs = numGrad(pk2, q[0] + 0.1, q[1] + 0.1, 1e-6);
    if (Math.hypot(g[0], g[1]) > 1e-6 * Math.hypot(gs[0], gs[1])) ok = false;
  }
  check(ok, `a form linear in beta still solves exactly (${cps.length} points)`);
}

// ---- (e) scale ----
{
  const base = loopPatch(-0.2, 0.65, 3);
  const b = interiorDips(base.frame, 0)[0];
  let bad = 0,
    singularBad = 0,
    n = 0;
  for (const S of [1e-6, 1e-3, 1e3, 1e6])
    for (const T of [
      [0, 0],
      [37 * S, -12 * S],
    ]) {
      const L = loopPatch(-0.2, 0.65, 3, S, T);
      const d = interiorDips(L.frame, 0);
      n++;
      if (d.length !== 1 || !b) bad++;
      else {
        const want = [b.q[0] * S + T[0], b.q[1] * S + T[1]];
        if (Math.hypot(d[0].q[0] - want[0], d[0].q[1] - want[1]) > 1e-9 * S * 6) bad++;
        else if (Math.abs(d[0].d / S - b.d) > 1e-6 * b.d) bad++;
      }
      // and the double point stays no dip at every scale
      const [t1] = cubicLoopCuts(L.P);
      const node = segPt({ t: 'cubic', P: L.P }, t1);
      const seg = { t: 'cubic', P: L.P, _bez: true };
      const impl = segImplicit(seg),
        pk = segImplicitPacked(seg);
      const at = (
        implCritical(pk, [node[0] - S, node[1] - S, node[0] + S, node[1] + S]) || []
      ).find((q) => Math.hypot(q[0] - node[0], q[1] - node[1]) <= 1e-6 * S);
      if (
        !at ||
        [1, -1].some((s) => {
          const f = s * implEval(impl, at[0], at[1]);
          return f < 0 && criticalDipDepth({ impl, s }, at[0], at[1], f) > 0;
        })
      )
        singularBad++;
    }
  check(
    bad === 0,
    `the dip is the same point and depth, scaled, from 1e-6 to 1e6 and translated (${bad} of ${n} differ)`,
  );
  check(
    singularBad === 0,
    `the double point is found and is no dip at every scale (${singularBad} of ${n} not)`,
  );
}

if (fail) {
  console.error(`CPATCH-BEZOUT-CRITICAL FAIL (${fail})`);
  process.exit(1);
}
console.log('CPATCH-BEZOUT-CRITICAL PASS');
