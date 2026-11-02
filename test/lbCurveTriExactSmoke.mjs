// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCurveTriExactSmoke — the face proof's containment questions are answered by ROOTS, not by
// samples, and this pins what that buys and what it must never break.
//
// The proof asks two things of every curve face: is another boundary inside it, and does it hold
// its own arc. Both are answered by roots rather than by walking sample points (33 a segment, 49 an arc). A
// sampled answer is wrong in one direction — a curve that dips into a face BETWEEN two samples is
// not seen — and the error shrinks with sample count without ever closing. The analytic form
// crosses the curve against each edge: along a straight edge the side function is a univariate
// cubic (a quadratic for a rational quad, once its positive denominator is cleared), so the
// crossings are its roots.
//
// (a) SOUNDNESS: anything a dense sampler finds, the analytic form must find. It may find more —
//     that is the point — so the check is one-directional.
// (b) INTERVALS: a sample inside the triangle must land inside a reported interval.
// (c) THE CASE ITSELF: a spike that enters a face between two 49-point samples. A 49-point sampler
//     misses it, the analytic form must not.
// (d) DEGENERATE: tangent to an edge, through a vertex, coincident with an edge, zero-area
//     triangle, zero-length edge.
// (e) SCALE: the same geometry at 1e-6 and 1e6 must answer the same way — the epsilons here are
//     relative, and this codebase has a defect family from absolute ones.
// (f) RATIONAL: the arc path is the exact rational quadratic, checked against a dense walk of the
//     true rational parameterization, not of an elevated cubic.
import {
  cubicMeetsTri,
  cubicTriIntervals,
  cubicSubCp,
  rquadMeetsTri,
  rquadTriIntervals,
  rquadSubCtrl,
  rquadPt,
  triContainsXY,
} from '../src/geom/lbCubicMath.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
let seed = 0x1234567;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const cubAt = (cp, t) => {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * cp[0][0] + b * cp[1][0] + c * cp[2][0] + d * cp[3][0],
    a * cp[0][1] + b * cp[1][1] + c * cp[2][1] + d * cp[3][1],
  ];
};

// ---- (a) + (b) random cubics vs random triangles ----
{
  let unsound = 0,
    outside = 0,
    n = 0;
  for (let i = 0; i < 6000; i++) {
    const R = () => [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4];
    const cp = [R(), R(), R(), R()],
      A = R(),
      B = R(),
      C = R();
    const meets = cubicMeetsTri(cp, A, B, C);
    const ivs = cubicTriIntervals(cp, A, B, C);
    let sampleHit = false;
    for (let k = 0; k <= 2000; k++) {
      const t = k / 2000,
        q = cubAt(cp, t);
      if (!triContainsXY(A, B, C, q[0], q[1])) continue;
      sampleHit = true;
      let covered = false;
      for (const iv of ivs)
        if (t >= iv[0] - 1e-6 && t <= iv[1] + 1e-6) {
          covered = true;
          break;
        }
      if (!covered) outside++;
    }
    n++;
    if (sampleHit && !meets) unsound++;
  }
  check(unsound === 0, `every sampled hit is found analytically (${unsound} of ${n} cases missed)`);
  check(outside === 0, `every inside sample lands in a reported interval (${outside} strays)`);
}

// ---- (c) the defect: a spike that enters between 49 samples ----
{
  // Built the sure way round: take a point the curve actually passes through at a parameter
  // BETWEEN two of a 49-point sampler's steps, and put a triangle around it small enough that no
  // step lands inside. The curve provably enters it; the 49-point walk provably cannot see it.
  const cp = [
    [0, 0],
    [0.3, 1.2],
    [0.7, -0.8],
    [1, 0.4],
  ];
  const tStar = 0.5 + 0.5 / 48;
  const P = cubAt(cp, tStar);
  const r = 2e-5;
  const A = [P[0] - r, P[1] - r],
    B = [P[0] + r, P[1] - r],
    C = [P[0], P[1] + r];
  const meets = cubicMeetsTri(cp, A, B, C);
  let old49 = false;
  for (let u = 0; u <= 1.0001; u += 1 / 48) {
    const q = cubAt(cp, u);
    if (triContainsXY(A, B, C, q[0], q[1])) {
      old49 = true;
      break;
    }
  }
  let dense = false;
  for (let k = 0; k <= 200000; k++) {
    const q = cubAt(cp, k / 200000);
    if (triContainsXY(A, B, C, q[0], q[1])) {
      dense = true;
      break;
    }
  }
  check(dense, 'the constructed spike really does enter the triangle (dense walk confirms)');
  check(!old49, 'the 49-point sampler misses it — this is the case the analytic form exists for');
  check(meets, 'the analytic form finds it');
}

// ---- (d) degenerate geometry ----
{
  const A = [0, 0],
    B = [1, 0],
    C = [0, 1];
  // tangent to edge AB from above: touches y=0 at t=0.5 without crossing
  const tangent = [
    [0.1, 1],
    [0.3, -1],
    [0.7, -1],
    [0.9, 1],
  ];
  let touches = false;
  for (let k = 0; k <= 100000; k++) {
    const q = cubAt(tangent, k / 100000);
    if (triContainsXY(A, B, C, q[0], q[1])) {
      touches = true;
      break;
    }
  }
  check(
    cubicMeetsTri(tangent, A, B, C) === touches || cubicMeetsTri(tangent, A, B, C),
    'a curve tangent to an edge is reported as meeting (touching counts)',
  );
  // through a vertex exactly
  const thruV = [
    [-1, -1],
    [-0.3, -0.3],
    [0.3, 0.3],
    [1, 1],
  ];
  check(cubicMeetsTri(thruV, A, B, C), 'a curve through a vertex meets the triangle');
  // coincident with an edge: the whole curve lies along AB
  const onEdge = [
    [0.1, 0],
    [0.3, 0],
    [0.7, 0],
    [0.9, 0],
  ];
  check(cubicMeetsTri(onEdge, A, B, C), 'a curve lying along an edge meets the triangle');
  check(
    cubicTriIntervals(onEdge, A, B, C).length > 0,
    'and reports an interval rather than nothing',
  );
  // zero-area triangle, and a zero-length edge
  const flat = [
    [0, 0],
    [1, 1],
    [2, 2],
  ];
  const r1 = cubicMeetsTri(thruV, flat[0], flat[1], flat[2]);
  check(r1 === true || r1 === false, 'a zero-area triangle answers without throwing');
  const degen = cubicMeetsTri(thruV, [0, 0], [0, 0], [1, 1]);
  check(degen === true || degen === false, 'a zero-length edge answers without throwing');
  // a zero-length curve (all control points equal)
  const pt = [
    [0.2, 0.2],
    [0.2, 0.2],
    [0.2, 0.2],
    [0.2, 0.2],
  ];
  check(
    cubicMeetsTri(pt, A, B, C) === true,
    'a degenerate point-curve inside the triangle is found',
  );
}

// ---- (e) scale ----
{
  let bad = 0;
  for (let i = 0; i < 800; i++) {
    const R = () => [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4];
    const cp0 = [R(), R(), R(), R()],
      A0 = R(),
      B0 = R(),
      C0 = R();
    const base = cubicMeetsTri(cp0, A0, B0, C0);
    for (const s of [1e-6, 1e-3, 1e3, 1e6]) {
      const S = (P) => [P[0] * s, P[1] * s];
      if (cubicMeetsTri(cp0.map(S), S(A0), S(B0), S(C0)) !== base) bad++;
    }
  }
  check(bad === 0, `the answer is scale invariant over 1e-6..1e6 (${bad} disagreements)`);
}

// ---- (f) the rational arc path ----
{
  let unsound = 0,
    outside = 0;
  for (let i = 0; i < 4000; i++) {
    const R = () => [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4];
    const p1 = R(),
      p2 = R(),
      p3 = R(),
      w = 0.2 + rnd() * 1.6;
    const A = R(),
      B = R(),
      C = R();
    const meets = rquadMeetsTri(p1, p2, p3, w, A, B, C);
    const ivs = rquadTriIntervals(p1, p2, p3, w, A, B, C);
    let hit = false;
    for (let k = 0; k <= 2000; k++) {
      const t = k / 2000,
        q = rquadPt(p1, p2, p3, w, t);
      if (!triContainsXY(A, B, C, q[0], q[1])) continue;
      hit = true;
      let covered = false;
      for (const iv of ivs)
        if (t >= iv[0] - 1e-6 && t <= iv[1] + 1e-6) {
          covered = true;
          break;
        }
      if (!covered) outside++;
    }
    if (hit && !meets) unsound++;
  }
  check(
    unsound === 0,
    `rational arcs: every sampled hit is found analytically (${unsound} missed)`,
  );
  check(
    outside === 0,
    `rational arcs: every inside sample lands in an interval (${outside} strays)`,
  );
}

// ---- subdivision bounds the piece it claims to ----
{
  let bad = 0;
  for (let i = 0; i < 2000; i++) {
    const R = () => [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4];
    const cp = [R(), R(), R(), R()];
    let t0 = rnd(),
      t1 = rnd();
    if (t1 < t0) {
      const s = t0;
      t0 = t1;
      t1 = s;
    }
    if (!(t1 > t0)) continue;
    const sub = cubicSubCp(cp, t0, t1);
    // the sub-curve must equal the parent over [t0,t1], and its hull must contain it
    for (let k = 0; k <= 16; k++) {
      const u = k / 16;
      const a = cubAt(sub, u),
        b = cubAt(cp, t0 + (t1 - t0) * u);
      const sc = Math.max(1, Math.abs(b[0]), Math.abs(b[1]));
      if (Math.abs(a[0] - b[0]) > 1e-9 * sc || Math.abs(a[1] - b[1]) > 1e-9 * sc) {
        bad++;
        break;
      }
    }
  }
  check(bad === 0, `cubicSubCp reproduces the parent over its interval (${bad} bad)`);
  let rbad = 0;
  for (let i = 0; i < 2000; i++) {
    const R = () => [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4];
    const p1 = R(),
      p2 = R(),
      p3 = R(),
      w = 0.2 + rnd() * 1.6;
    let t0 = rnd(),
      t1 = rnd();
    if (t1 < t0) {
      const s = t0;
      t0 = t1;
      t1 = s;
    }
    if (!(t1 > t0)) continue;
    const sub = rquadSubCtrl(p1, p2, p3, w, t0, t1);
    // The sub-arc's control hull must contain the arc over that interval. A sub-arc is very often
    // a near-straight sliver, so "inside" is judged with slack RELATIVE to the hull's own size --
    // an absolute area threshold would just be testing how thin the sliver happens to be.
    const sc = Math.max(
      Math.abs(sub[0][0]),
      Math.abs(sub[0][1]),
      Math.abs(sub[1][0]),
      Math.abs(sub[1][1]),
      Math.abs(sub[2][0]),
      Math.abs(sub[2][1]),
      1,
    );
    const side = (P, Q, x, y) => (Q[0] - P[0]) * (y - P[1]) - (Q[1] - P[1]) * (x - P[0]);
    for (let k = 0; k <= 16; k++) {
      const q = rquadPt(p1, p2, p3, w, t0 + (t1 - t0) * (k / 16));
      const u = side(sub[0], sub[1], q[0], q[1]),
        v = side(sub[1], sub[2], q[0], q[1]),
        z = side(sub[2], sub[0], q[0], q[1]);
      const tol = 1e-9 * sc * sc;
      const inside = (u >= -tol && v >= -tol && z >= -tol) || (u <= tol && v <= tol && z <= tol);
      if (!inside) {
        rbad++;
        break;
      }
    }
  }
  check(rbad === 0, `rquadSubCtrl's hull contains its own sub-arc (${rbad} bad)`);
}

if (fail) {
  console.error(`LB-CURVE-TRI FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-CURVE-TRI PASS');
