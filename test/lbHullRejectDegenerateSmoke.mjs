// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbHullRejectDegenerateSmoke — the ray-crossing hull rejects in lbContour must be
// OUTPUT-IDENTICAL to solving every segment, including on the degenerate class that a
// convex-hull argument gets wrong in floating point.
//
// THE TRAP this GUARDS. "A Bezier lies in the convex hull of its control points" is a
// statement about exact arithmetic. With every control x EQUAL to the ray's x, the Bernstein
// combination sums weights that are only approximately 1, so the evaluated point can land a
// few ulps ABOVE the ray origin and an un-rejected solve counts a crossing there. A reject
// written as `all control x <= x` deletes those crossings (10-20% of that class),
// and still present 1-2 ulps STRICTLY below, so strictness alone does not save it. The ray
// origin on this path is a mesh vertex, and axis-aligned or generated art puts whole control
// polygons exactly on it, so this is reachable rather than theoretical.
//
// The test carries its own reference (the same solvers, no rejects) rather than a diff against
// another tree.
//
// (a) every control x exactly on the ray origin's x, and 1/2/4/16 ulps below it
// (b) y-side near tangency: control y strictly above the ray, curve dipping to within ulps
// (c) the rotated frame (rayWindingDir) over the directions the face classifier actually casts
// (d) ordinary random segments — the reject must not over-fire on the common case
// (e) the same degenerate cases at 1e-6 and 1e6 scale: the slack is RELATIVE, so it must hold
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_RQUAD,
  mkLine,
  mkQuad,
  mkCubic,
  mkRQuad,
} from '../src/primitives/seg.js';
import { raySegCross, rayWindingDir } from '../src/geom/lbContour.js';
import { solveQuadratic, solveCubicInUnit } from '../src/svg/pathBoolean/polyRoots.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// exact ulp steps: Math.nextafter does not exist here, and an approximate step would let the
// degenerate class drift off the very boundary this test is about.
const _f64 = new Float64Array(1),
  _i64 = new BigInt64Array(_f64.buffer);
const step = (v, n, dir) => {
  if (!Number.isFinite(v) || v === 0) return v;
  _f64[0] = v;
  _i64[0] += BigInt(n) * (v > 0 === dir > 0 ? 1n : -1n);
  return _f64[0];
};
const up = (v, n) => step(v, n, 1);
const dn = (v, n) => step(v, n, -1);

// ---- reference: the same arithmetic with NO hull reject ----
function refSegCross(s, x, y) {
  let wsum = 0;
  const hit = (tx, t, dir) => {
    if (t >= 0 && t < 1 && tx > x && dir !== 0) wsum += dir > 0 ? 1 : -1;
  };
  if (s.type === SEG_LINE) {
    const y1 = s.p1[1],
      dy = s.p2[1] - y1;
    if (Math.abs(dy) < 1e-15) return 0;
    const t = (y - y1) / dy;
    hit(s.p1[0] + t * (s.p2[0] - s.p1[0]), t, dy);
    return wsum;
  }
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
    const w = s.type === SEG_RQUAD ? s.w : 1,
      d1 = s.p1[1] - y,
      d2 = s.p2[1] - y,
      d3 = s.p3[1] - y;
    const A2 = d1 - 2 * w * d2 + d3,
      B2 = 2 * (w * d2 - d1);
    for (const t of solveQuadratic(A2, B2, d1)) {
      const u = 1 - t,
        a = u * u,
        b = 2 * w * u * t,
        c = t * t,
        den = a + b + c;
      if (Math.abs(den) > 1e-15)
        hit((a * s.p1[0] + b * s.p2[0] + c * s.p3[0]) / den, t, 2 * A2 * t + B2);
    }
    return wsum;
  }
  const y1 = s.p1[1],
    y2 = s.p2[1],
    y3 = s.p3[1],
    y4 = s.p4[1];
  const a3 = -y1 + 3 * y2 - 3 * y3 + y4,
    b3 = 3 * (y1 - 2 * y2 + y3),
    c3 = 3 * (y2 - y1);
  for (const t of solveCubicInUnit(a3, b3, c3, y1 - y)) {
    const u = 1 - t;
    hit(
      u * u * u * s.p1[0] + 3 * u * u * t * s.p2[0] + 3 * u * t * t * s.p3[0] + t * t * t * s.p4[0],
      t,
      3 * a3 * t * t + 2 * b3 * t + c3,
    );
  }
  return wsum;
}

function refWindingDir(segs, x, y, dx, dy) {
  let wsum = 0;
  const px9 = (X9, Y9) => dx * (X9 - x) + dy * (Y9 - y);
  const py9 = (X9, Y9) => -dy * (X9 - x) + dx * (Y9 - y);
  const hit = (tx, t, dir) => {
    if (t >= 0 && t < 1 && tx > 0 && dir !== 0) wsum += dir > 0 ? 1 : -1;
  };
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      const y1 = py9(s.p1[0], s.p1[1]),
        y2 = py9(s.p2[0], s.p2[1]),
        dyq = y2 - y1;
      if (Math.abs(dyq) < 1e-15) continue;
      const t = -y1 / dyq;
      hit(px9(s.p1[0], s.p1[1]) + t * (px9(s.p2[0], s.p2[1]) - px9(s.p1[0], s.p1[1])), t, dyq);
      continue;
    }
    if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
      const w = s.type === SEG_RQUAD ? s.w : 1;
      const d1 = py9(s.p1[0], s.p1[1]),
        d2 = py9(s.p2[0], s.p2[1]),
        d3 = py9(s.p3[0], s.p3[1]);
      const A2 = d1 - 2 * w * d2 + d3,
        B2 = 2 * (w * d2 - d1);
      const x1 = px9(s.p1[0], s.p1[1]),
        x2 = px9(s.p2[0], s.p2[1]),
        x3 = px9(s.p3[0], s.p3[1]);
      for (const t of solveQuadratic(A2, B2, d1)) {
        const u = 1 - t,
          a = u * u,
          b = 2 * w * u * t,
          c = t * t,
          den = a + b + c;
        if (Math.abs(den) > 1e-15) hit((a * x1 + b * x2 + c * x3) / den, t, 2 * A2 * t + B2);
      }
      continue;
    }
    const y1 = py9(s.p1[0], s.p1[1]),
      y2 = py9(s.p2[0], s.p2[1]),
      y3 = py9(s.p3[0], s.p3[1]),
      y4 = py9(s.p4[0], s.p4[1]);
    const a3 = -y1 + 3 * y2 - 3 * y3 + y4,
      b3 = 3 * (y1 - 2 * y2 + y3),
      c3 = 3 * (y2 - y1);
    const x1 = px9(s.p1[0], s.p1[1]),
      x2 = px9(s.p2[0], s.p2[1]),
      x3 = px9(s.p3[0], s.p3[1]),
      x4 = px9(s.p4[0], s.p4[1]);
    for (const t of solveCubicInUnit(a3, b3, c3, y1)) {
      const u = 1 - t;
      hit(
        u * u * u * x1 + 3 * u * u * t * x2 + 3 * u * t * t * x3 + t * t * t * x4,
        t,
        3 * a3 * t * t + 2 * b3 * t + c3,
      );
    }
  }
  return wsum;
}

// a segment whose control x are all X, y straddling the ray so a root exists
const straddle = (X, y, kind, S) => {
  const lo = y - S * (0.1 + rnd()),
    hi = y + S * (0.1 + rnd());
  if (kind === 0) return mkQuad([X, lo], [X, (lo + hi) / 2], [X, hi]);
  if (kind === 1)
    return mkCubic([X, lo], [X, lo + (hi - lo) / 3], [X, lo + (2 * (hi - lo)) / 3], [X, hi]);
  if (kind === 2) return mkRQuad([X, lo], [X, (lo + hi) / 2], [X, hi], 0.5 + rnd() * 0.5);
  return mkLine([X, lo], [X, hi]);
};

// ---- (a) + (e): control x on the ray origin, and just below it, at three scales ----
for (const S of [1e-6, 1, 1e6]) {
  let bad = 0,
    n = 0;
  for (let i = 0; i < 4000; i++) {
    const px = (rnd() - 0.5) * 4 * S,
      py = (rnd() - 0.5) * 4 * S;
    for (let kind = 0; kind < 4; kind++) {
      for (const X of [px, dn(px, 1), dn(px, 2), dn(px, 4), dn(px, 16)]) {
        const s = straddle(X, py, kind, S);
        n++;
        if (raySegCross(s, px, py) !== refSegCross(s, px, py)) bad++;
      }
    }
  }
  check(bad === 0, `control x on/near the ray origin, scale ${S}: ${bad} of ${n} disagree`);
}

// ---- (b) y-side near tangency: all control y strictly above, curve dipping to within ulps ----
{
  let bad = 0,
    n = 0;
  for (let i = 0; i < 4000; i++) {
    const px = (rnd() - 0.5) * 4,
      py = (rnd() - 0.5) * 4,
      X0 = px + 0.5 + rnd();
    for (const k of [1, 2, 3, 8, 64]) {
      const lo = up(py, k),
        hi = up(py, k * 3 + 2);
      for (const kind of [0, 1, 2]) {
        const s =
          kind === 0
            ? mkQuad([X0, hi], [X0 + 0.4, lo], [X0 + 0.8, hi])
            : kind === 1
              ? mkCubic([X0, hi], [X0 + 0.3, lo], [X0 + 0.6, lo], [X0 + 0.9, hi])
              : mkRQuad([X0, hi], [X0 + 0.4, lo], [X0 + 0.8, hi], 0.5 + rnd() * 0.5);
        n++;
        if (raySegCross(s, px, py) !== refSegCross(s, px, py)) bad++;
        n++;
        if (rayWindingDir([s], px, py, 1, 0) !== refWindingDir([s], px, py, 1, 0)) bad++;
      }
    }
  }
  check(bad === 0, `y-side near tangency (1-64 ulps above the ray): ${bad} of ${n} disagree`);
}

// ---- (c) the rotated frame, over the directions the face classifier casts ----
{
  const DIRS = [
    [1, 0],
    [0, 1],
    [0.9271838545667874, 0.37460659341591207],
    [-0.29552020666133955, 0.9553364891256061],
    [0.6216099682706644, -0.7833269096274834],
  ];
  let bad = 0,
    n = 0;
  for (let i = 0; i < 3000; i++) {
    const px = (rnd() - 0.5) * 4,
      py = (rnd() - 0.5) * 4;
    for (const [dx, dy] of DIRS) {
      const perp = (t) => [px + -dy * t, py + dx * t];
      const s0 = -(0.1 + rnd()),
        s1 = 0.1 + rnd(),
        P = (u) => perp(s0 + (s1 - s0) * u);
      for (const kind of [0, 1, 2, 3]) {
        const seg =
          kind === 1
            ? mkCubic(P(0), P(1 / 3), P(2 / 3), P(1))
            : kind === 0
              ? mkQuad(P(0), P(0.5), P(1))
              : kind === 2
                ? mkRQuad(P(0), P(0.5), P(1), 0.5 + rnd() * 0.5)
                : mkLine(P(0), P(1));
        n++;
        if (rayWindingDir([seg], px, py, dx, dy) !== refWindingDir([seg], px, py, dx, dy)) bad++;
      }
    }
  }
  check(bad === 0, `rotated frame, control polygon on the ray: ${bad} of ${n} disagree`);
}

// ---- (d) ordinary segments: the reject must not over-fire on the common case ----
{
  let bad = 0,
    n = 0,
    nz = 0;
  for (let i = 0; i < 20000; i++) {
    const px = (rnd() - 0.5) * 4,
      py = (rnd() - 0.5) * 4;
    const R = () => [(rnd() - 0.5) * 6, (rnd() - 0.5) * 6];
    const kind = i & 3;
    const s =
      kind === 1
        ? mkCubic(R(), R(), R(), R())
        : kind === 0
          ? mkQuad(R(), R(), R())
          : kind === 2
            ? mkRQuad(R(), R(), R(), 0.3 + rnd())
            : mkLine(R(), R());
    const a = raySegCross(s, px, py),
      b = refSegCross(s, px, py);
    n++;
    if (a !== b) bad++;
    if (b !== 0) nz++;
    const c = rayWindingDir([s], px, py, 0.6216099682706644, -0.7833269096274834);
    const d = refWindingDir([s], px, py, 0.6216099682706644, -0.7833269096274834);
    n++;
    if (c !== d) bad++;
  }
  check(bad === 0, `random segments: ${bad} of ${n} disagree`);
  check(
    nz > 1000,
    `the random set actually crosses the ray (${nz} non-zero), so agreement is not vacuous`,
  );
}

if (fail) {
  console.error(`LB-HULL-REJECT FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-HULL-REJECT PASS');
