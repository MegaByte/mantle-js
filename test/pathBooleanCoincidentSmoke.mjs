// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanCoincidentSmoke — two curves along the same underlying curve get a defined answer: the
// ends of their shared stretch, never NaN and never samples of the stretch.
//
// THE HAZARDS. Substituting one parabola into the other's implicit vanishes identically on a shared
// parabola, and Ferrari then divides by zero: four NaN hits for an identical, reversed, overlapping or
// merely end-to-end pair. A Bezier clipper recursing on a shared stretch never shrinks it and, before
// its Bezout guard can fire, runs out of node budget holding nine points sampled 1e-4 apart -- which
// cpatchGraph accepts, since nine is Bezout's bound. NaN is not harmless either: shapeResolve reads
// any hit away from a shared vertex as a self-crossing, so a contour holding two halves of one
// parabola would be sent through the union.
//
// (a) every configuration of two stretches of one quad, one cubic, and one quad written as a cubic
//     (identical, reversed, contained, overlapping, end to end, disjoint), through intersectSegments
//     in both argument orders: exactly the overlap's ends (or the touch point, or nothing), no NaN
// (b) a looped cubic against a stretch of itself through ONE branch of the double point: the ends,
//     plus the double point where the other branch crosses
// (c) the answer does not move with scale or offset, 1e-6..1e6
// (d) curves NEAR each other are not coincident: a stretch bent by 1e-6 and 1e-8 of its extent
// (e) the consumers: intersectAndSplit cuts an overlap at its ends and nowhere else, and
//     resolveSelfOverlap leaves a contour of two parabola halves alone
import { intersectSegments } from '../src/svg/pathBoolean/intersect/index.js';
import { sameCurveHits } from '../src/svg/pathBoolean/intersect/coincident.js';
import { intersectAndSplit } from '../src/svg/pathBoolean/planar/segmentSet.js';
import { resolveSelfOverlap } from '../src/renderer/shapeResolve.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const quad = (a, b, c) => ({ type: 1, p1: a, p2: b, p3: c });
const cub = (a, b, c, d) => ({ type: 2, p1: a, p2: b, p3: c, p4: d });
const line = (a, b) => ({ type: 0, p1: a, p2: b });
const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const ctrl = (s) => [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
const mk = (P) => (P.length === 3 ? quad(...P) : cub(...P));
// The stretch [t0, t1] of a curve, exactly, by blossoming; t0 > t1 gives the reversed stretch.
function stretch(s, t0, t1) {
  const P = ctrl(s);
  if (P.length === 3) {
    const bl = (u, v) => L(L(P[0], P[1], u), L(P[1], P[2], u), v);
    return quad(bl(t0, t0), bl(t0, t1), bl(t1, t1));
  }
  const bl = (u, v, w) => {
    const a = L(P[0], P[1], u),
      b = L(P[1], P[2], u),
      c = L(P[2], P[3], u);
    return L(L(a, b, v), L(b, c, v), w);
  };
  return cub(bl(t0, t0, t0), bl(t0, t0, t1), bl(t0, t1, t1), bl(t1, t1, t1));
}
const elevate = (q) => cub(q.p1, L(q.p1, q.p2, 2 / 3), L(q.p3, q.p2, 2 / 3), q.p3);
const xform = (s, f, ox, oy) => mk(ctrl(s).map((p) => [p[0] * f + ox, p[1] * f + oy]));

// Expected (tA, tB) for stretch A = [a0,a1] and B = [b0,b1] of one curve: the ends of the overlap
// of the two parameter intervals, mapped into each stretch's own parameter.
function expected(a0, a1, b0, b1) {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1)),
    hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  if (lo > hi) return [];
  const pa = (g) => (g - a0) / (a1 - a0),
    pb = (g) => (g - b0) / (b1 - b0);
  return lo === hi
    ? [[pa(lo), pb(lo)]]
    : [
        [pa(lo), pb(lo)],
        [pa(hi), pb(hi)],
      ];
}
function sameSet(got, want, eps = 1e-7) {
  if (got.some((h) => !Number.isFinite(h.tA) || !Number.isFinite(h.tB))) return false;
  if (got.length !== want.length) return false;
  const used = new Set();
  for (const [a, b] of want) {
    const i = got.findIndex(
      (h, k) => !used.has(k) && Math.abs(h.tA - a) <= eps && Math.abs(h.tB - b) <= eps,
    );
    if (i < 0) return false;
    used.add(i);
  }
  return true;
}
const fmt = (hits) =>
  hits
    .map(
      (h) =>
        `(${Number.isFinite(h.tA) ? h.tA.toFixed(4) : h.tA},${Number.isFinite(h.tB) ? h.tB.toFixed(4) : h.tB})`,
    )
    .join(' ') || 'none';

const Q = quad([-10, 0], [0, 9], [10, 0]);
const C = cub([-10, 0], [-5, 8], [5, -8], [10, 0]);
const configs = [
  ['identical', 0, 1, 0, 1],
  ['reversed', 0, 1, 1, 0],
  ['contained', 0, 1, 0.25, 0.75],
  ['contained, reversed', 0, 1, 0.8, 0.3],
  ['overlapping', 0, 0.6, 0.4, 1],
  ['end to end', 0, 0.5, 0.5, 1],
  ['end to end, reversed', 0, 0.5, 1, 0.5],
  ['disjoint', 0, 0.3, 0.6, 1],
];
function runConfigs(f, ox, oy, log) {
  let bad = 0;
  const kinds = [
    ['quad x quad', Q, (s) => s, (s) => s],
    ['quad x cubic (the quad elevated)', Q, (s) => s, elevate],
    ['cubic x cubic', C, (s) => s, (s) => s],
    ['cubic x cubic (both elevated quads)', Q, elevate, elevate],
  ];
  for (const [kind, base, wrapA, wrapB] of kinds)
    for (const [name, a0, a1, b0, b1] of configs) {
      const A = xform(wrapA(stretch(base, a0, a1)), f, ox, oy),
        B = xform(wrapB(stretch(base, b0, b1)), f, ox, oy);
      const want = expected(a0, a1, b0, b1);
      const ab = intersectSegments(A, B),
        ba = intersectSegments(B, A);
      // A pair of stretches that only meet end to end may also be reported with nothing at all by the
      // clipper, which has always been free to drop a shared endpoint; what it may not do is invent.
      const touchOnly =
        want.length === 1 && [want[0][0], want[0][1]].every((t) => t === 0 || t === 1);
      const ok = (hits, w) => sameSet(hits, w) || (touchOnly && hits.length === 0);
      const good =
        ok(ab, want) &&
        ok(
          ba,
          want.map(([s, u]) => [u, s]),
        );
      if (!good) bad++;
      if (log || !good)
        check(
          good,
          `${kind}, ${name}: ${fmt(ab)} (expected ${want.map(([s, u]) => `(${s.toFixed(4)},${u.toFixed(4)})`).join(' ') || 'none'})`,
        );
    }
  return bad;
}

console.log('(a) stretches of one curve');
runConfigs(1, 0, 0, true);

console.log('(b) a looped cubic against one branch of itself');
{
  const K = cub([0, 0], [30, 30], [-20, 30], [10, 0]);
  // The double point, independently: K(s) = K(t) with s != t.
  const c1 = [3 * 30, 3 * 30],
    c2 = [3 * (0 - 60 - 20), 3 * (0 - 60 + 30)],
    c3 = [-0 + 90 + 60 + 10, -0 + 90 - 90 + 0];
  const cr = (u, v) => u[0] * v[1] - u[1] * v[0];
  const sig = -cr(c1, c3) / cr(c2, c3),
    pi = sig * sig + (c1[0] + c2[0] * sig) / c3[0];
  const r = Math.sqrt(sig * sig - 4 * pi),
    d1 = (sig - r) / 2,
    d2 = (sig + r) / 2;
  const m = (d1 + d2) / 2; // B = K[0, m] passes the double point once, at d1
  const B = stretch(K, 0, m);
  const hits = intersectSegments(K, B);
  check(
    d1 > 0 &&
      d2 < 1 &&
      sameSet(hits, [
        [0, 0],
        [m, 1],
        [d2, d1 / m],
      ]),
    `K x K[0, ${m.toFixed(3)}]: ${fmt(hits)} (expected the ends and (${d2.toFixed(4)},${(d1 / m).toFixed(4)}))`,
  );
}

console.log('(c) scale and offset');
for (const f of [1e-6, 1e-3, 1e3, 1e6])
  for (const [ox, oy] of [
    [0, 0],
    [7.3e3 * f, -2.9e4 * f],
  ]) {
    const bad = runConfigs(f, ox, oy, false);
    check(
      bad === 0,
      `scale ${f}, offset (${ox}, ${oy}): all ${4 * configs.length} pairs answer the same`,
    );
  }

console.log('(d) near, not coincident');
for (const d of [1e-6, 1e-8]) {
  const B0 = stretch(C, 0.25, 0.75);
  // Push the interior control points apart across the curve: B meets C at its ends and once in the
  // middle, and is nowhere the same curve.
  const n = [0, d * 20];
  const B = cub(
    B0.p1,
    [B0.p2[0] + n[0], B0.p2[1] + n[1]],
    [B0.p3[0] - n[0], B0.p3[1] - n[1]],
    B0.p4,
  );
  check(
    sameCurveHits(ctrl(C), ctrl(B)) === null,
    `a stretch bent by ${d} of its extent is not a shared stretch`,
  );
  const Bq0 = stretch(Q, 0.25, 0.75);
  const Bq = quad(Bq0.p1, [Bq0.p2[0], Bq0.p2[1] + d * 20], Bq0.p3);
  const hq = intersectSegments(Q, Bq);
  check(
    hq.every((h) => Number.isFinite(h.tA) && Number.isFinite(h.tB)) && hq.length <= 4,
    `quad x quad bent by ${d}: finite, at most Bezout's 4 (${fmt(hq)})`,
  );
}

console.log('(e) consumers');
{
  const tag = (seg) => ({ seg, shapeIdx: 0, subpathIdx: 0, origDirection: 1, fillRule: 'nonzero' });
  const pieces = intersectAndSplit([tag(Q), tag(elevate(Q))]);
  check(
    pieces.length === 2,
    `intersectAndSplit(quad, the same quad as a cubic) leaves both whole: ${pieces.length} pieces`,
  );
  const over = intersectAndSplit([tag(C), tag(stretch(C, 0.25, 0.75))]);
  check(
    over.length === 4,
    `intersectAndSplit(cubic, its middle half) cuts the cubic at the stretch's two ends: ${over.length} pieces`,
  );
  const Qa = stretch(Q, 0, 0.5),
    Qb = stretch(Q, 0.5, 1);
  const contour = [[Qa, Qb, line(Q.p3, Q.p1)]];
  check(
    resolveSelfOverlap(contour, 'nonzero') === contour,
    'resolveSelfOverlap leaves two halves of one parabola alone',
  );
}

if (fail) {
  console.error(`PATH-BOOLEAN COINCIDENT FAIL (${fail})`);
  process.exit(1);
}
console.log('PATH-BOOLEAN COINCIDENT PASS');
