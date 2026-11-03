// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchCrossExactSmoke — a clipper hit that IS an exact crossing takes the exact crossing's
// parameters.
//
// THE TRAP. cpatchGraph.exactCrossings composes each curve's implicit along the other, pairs the
// roots, and polishes the pair with Gauss-Newton until a(t) and b(u) meet to closeEps. It then
// checks whether the Bezier clipper already reported this crossing; dropping its own root there and
// letting the graph cut at the clipper's parameters -- which may be up to CLIP_SAME_ROOT (1e-4)
// away in parameter -- would throw the more accurate number away. So the hit takes the exact root.
//
// WHY IT IS NOT MERELY COSMETIC. flattenGraph cuts curve A at tA and curve B at tB INDEPENDENTLY,
// so the two pieces' endpoints land wherever those parameters put them. Nodes merge only within
// 1e-11 of the drawing's diagonal, so a crossing whose two cut points are further apart than that
// enters the arrangement as a SINK and a SOURCE a micron away, the boundary walk dies at one and
// starts orphaned at the other, and repairBoundary has to sew them back together (extractCycles'
// note counts 161 such nodes on tiger). Over the corpus: 24 clipper hits match an exact
// root, and 7 of them leave a gap wider than the graph can merge. The exact root's gap is 3.7e-13
// nominal pixels against the hit's 1.5e-12 median and 5.5e-5 worst -- a crossing that never splits
// needs no repair.
//
// WHAT IS PINNED
//   substituted  a hit that IS this crossing comes back holding the exact root's parameters, and
//                the gap between the two curves' cut points collapses by orders of magnitude
//   still one    the crossing is still not returned twice: the hit is corrected, not supplemented
//   not another  a hit that is NOT this crossing is left alone and the crossing is still reported
//   no hits      with no clipper list at all, nothing changes
//   scale        the substitution holds at every size, since the whole point is a tolerance that
//                scales with the pair
import { exactCrossings } from '../src/geom/cpatchGraph.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const at = (P, t) => {
  P = P.map((p) => p.slice());
  for (let n = P.length - 1; n > 0; n--)
    for (let i = 0; i < n; i++)
      P[i] = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t];
  return P[0];
};
const tp = (P) => ({ t: P.length === 2 ? 'line' : P.length === 3 ? 'quad' : 'cubic', P });
/// A clipper-like hit: the crossing's own parameters moved by (dA, dB), with the reported point
/// the midpoint of the two curve points -- which is what a clipper returns and why the two cut
/// points do not coincide.
const hitNear = (A, B, c, dA, dB) => {
  const tA = c.tA + dA,
    tB = c.tB + dB,
    p = at(A, tA),
    q = at(B, tB);
  return { tA, tB, x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 };
};
const gap = (A, B, h) => {
  const p = at(A, h.tA),
    q = at(B, h.tB);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
};

const SCALES = [1, 1 / 64, 64, 1024];

console.log('a clipper hit that is this crossing is corrected to the exact root');
{
  let bad = 0,
    n = 0,
    worstBefore = 0,
    worstAfter = 0;
  for (const f of SCALES) {
    const W = (p) => [p[0] * f + 3 * f, p[1] * f - 7 * f];
    const A = [
      [-10, 0],
      [0, 9],
      [10, 0],
    ].map(W);
    const B = [
      [-3, -2],
      [-1, 9],
      [2, 1],
      [4, 8],
    ].map(W);
    const [c] = exactCrossings(tp(A), tp(B), null) || [];
    if (!c) {
      bad++;
      n++;
      continue;
    }
    const h = hitNear(A, B, c, 8e-6, -5e-6);
    const before = gap(A, B, h) / (20 * f);
    const got = exactCrossings(tp(A), tp(B), [h]);
    const after = gap(A, B, h) / (20 * f);
    n++;
    worstBefore = Math.max(worstBefore, before);
    worstAfter = Math.max(worstAfter, after);
    // returned nothing (the hit holds the crossing), and the hit holds the exact parameters
    if (!(got && got.length === 0)) {
      bad++;
      continue;
    }
    if (!(h.tA === c.tA && h.tB === c.tB)) {
      bad++;
      continue;
    }
    if (!(after < before * 1e-3)) bad++;
  }
  check(bad === 0, `the hit carries the exact root at all ${n} sizes (${bad} bad)`);
  check(
    worstAfter < 1e-10 && worstBefore > 1e-6,
    `and the two cut points close from ${worstBefore.toExponential(2)} to ${worstAfter.toExponential(2)} of the pair`,
  );
}

console.log('a hit that is NOT this crossing is untouched');
{
  const W = (p) => [p[0], p[1]];
  const A = [
    [-10, 0],
    [0, 9],
    [10, 0],
  ].map(W);
  const B = [
    [-3, -2],
    [-1, 9],
    [2, 1],
    [4, 8],
  ].map(W);
  const [c] = exactCrossings(tp(A), tp(B), null) || [];
  check(!!c, 'the pair has a crossing');
  // Snapped parameters: a hit at (0.2, 0) is a different place on both curves.
  const h = { tA: 0.2, tB: 0, x: at(A, 0.2)[0], y: at(A, 0.2)[1] };
  const snap = { ...h };
  const got = exactCrossings(tp(A), tp(B), [h]);
  check(!!got && got.length === 1, `the crossing is still reported (${got ? got.length : 'none'})`);
  check(
    h.tA === snap.tA && h.tB === snap.tB && h.x === snap.x && h.y === snap.y,
    'and the foreign hit is not rewritten',
  );
}

console.log('with no clipper hits there is nothing to correct');
{
  const A = [
    [-10, 0],
    [0, 9],
    [10, 0],
  ];
  const B = [
    [-3, -2],
    [-1, 9],
    [2, 1],
    [4, 8],
  ];
  const a = exactCrossings(tp(A), tp(B), null) || [];
  const b = exactCrossings(tp(A), tp(B), []) || [];
  check(
    a.length === 1 && b.length === 1 && a[0].tA === b[0].tA && a[0].tB === b[0].tB,
    `null and [] give the same single crossing (${a.length}, ${b.length})`,
  );
}

console.log('the substitution is not vacuous: the hit arrives off the exact root and leaves on it');
{
  // The rewrite is what moves the clipper's parameters, and that is asserted directly here: the hit
  // is built off the exact root, so a call that left it alone would fail the second check.
  const A = [
    [-10, 0],
    [0, 9],
    [10, 0],
  ];
  const B = [
    [-3, -2],
    [-1, 9],
    [2, 1],
    [4, 8],
  ];
  const [c] = exactCrossings(tp(A), tp(B), null) || [];
  const h = hitNear(A, B, c, 8e-6, -5e-6);
  check(h.tA !== c.tA && h.tB !== c.tB, 'the clipper-like hit starts off the exact root');
  const got = exactCrossings(tp(A), tp(B), [h]);
  check(!!got && got.length === 0, 'the hit still suppresses the crossing');
  check(h.tA === c.tA && h.tB === c.tB, "and leaves holding the exact root's parameters");
}

// A contour that retraces a curve (out along a cubic and back along the same geometry) holds two COINCIDENT curves: polished from any
// seed they close at some point of the overlap, and none of those points is a crossing.
console.log('coincident curves are not crossed');
for (const k of [2 ** -20, 1, 2 ** 20]) {
  const P0 = [0, 0],
    P1 = [3 * k, 4 * k],
    P2 = [6 * k, -1 * k],
    P3 = [10 * k, 5 * k];
  const out = { t: 'cubic', P: [P0, P1, P2, P3] },
    back = { t: 'cubic', P: [P3, P2, P1, P0] };
  const x = exactCrossings(out, back, null, true);
  check(
    !x || x.length === 0,
    `exactCrossings reports no crossing between a cubic and its reverse (size ${k})`,
  );
}

if (fail) {
  console.log(`FAIL cpatchCrossExactSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS cpatchCrossExactSmoke');
