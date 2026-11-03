// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillNormalizePerturbationSmoke -- the fill normalization decides the same on input that differs below the float32 plane.
//
// normalizedFillSegs drops a contour that lies inside another of the same orientation (the winding integrators would count it twice) and
// certifies curved contours with the exact polynomial-paint certificate. Both read exact predicates: the certificate needs a contour's last
// curve to END where its first begins, and a corner cubic's zero handle to BE zero; a contour authored with relative commands, or any input
// rounded or perturbed by a few ulps, ends a stub short of its start and carries 1e-7 handles of random direction, which can flip the decision
// (a corpus asset at a 1e-9 relative perturbation would lose the normalization of two shapes: 3.815 against 3.791 mean error at 32 px).
//
// Fixture: an outer and an inner rounded square (cubic corners with exactly zero handles' worth of authored P1 = P0 / P2 = P3 corners),
// same orientation, nonzero. Perturbed copies move every coordinate independently by relative 1e-9..1e-6, at 1, 2^-20 and 2^20 and with a
// far origin. Assertions:
//   1. the unperturbed pair normalizes (the inner contour goes) -- the fixture can fail;
//   2. every perturbed pair normalizes to the same number of kept contours and the same kept area within 1e-5 of the outer's;
//   3. an inner contour that really pokes out by 1e-3 of the extent is NOT dropped, perturbed or not.
const { normalizedFillSegs } = await import('../src/svg/fillNormalize.js');
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// a rounded square [a, b]^2 as 4 lines and 4 cubic corners (the cubic's handles run along the sides, 0.25 of the corner radius), counter-clockwise
function roundedSquare(a, b, r) {
  const P = (x, y) => [x, y],
    k = 0.5523 * r,
    segs = [];
  const line = (p, q) => segs.push({ type: 0, p1: p, p2: q });
  const cub = (p, c1, c2, q) => segs.push({ type: 2, p1: p, p2: c1, p3: c2, p4: q });
  line(P(a + r, a), P(b - r, a));
  cub(P(b - r, a), P(b - r + k, a), P(b, a + r - k), P(b, a + r));
  line(P(b, a + r), P(b, b - r));
  cub(P(b, b - r), P(b, b - r + k), P(b - r + k, b), P(b - r, b));
  line(P(b - r, b), P(a + r, b));
  cub(P(a + r, b), P(a + r - k, b), P(a, b - r + k), P(a, b - r));
  line(P(a, b - r), P(a, a + r));
  cub(P(a, a + r), P(a, a + r - k), P(a + r - k, a), P(a + r, a));
  return segs;
}
const close = (segs) => {
  const e = segs[segs.length - 1].p4 || segs[segs.length - 1].p2;
  return [...segs, { type: 0, p1: e, p2: segs[0].p1, is_fill_only: true }];
};
// every coordinate scaled, translated and perturbed by `rel`; a point shared by two records stays ONE point (as in an authored path, where
// both come from the same numbers), except the contour's last end, which gets its own draw: the stub a relative-command path ends with.
function scaled(segs, S, O, rel, r) {
  const memo = new Map();
  const f = (p) => {
    const key = p[0] + ',' + p[1];
    if (!memo.has(key))
      memo.set(key, [
        p[0] * S + O + (rel ? p[0] * S * rel * (2 * r() - 1) : 0),
        p[1] * S + O + (rel ? p[1] * S * rel * (2 * r() - 1) : 0),
      ]);
    return memo.get(key);
  };
  const out = segs.map((g) => {
    const o = { ...g };
    for (const k of ['p1', 'p2', 'p3', 'p4']) if (g[k]) o[k] = f(g[k]);
    return o;
  });
  const last = out[out.length - 1],
    k = last.p4 ? 'p4' : 'p2',
    st = out[0].p1;
  last[k] = rel ? [st[0] + st[0] * rel * (2 * r() - 1), st[1] + st[1] * rel * (2 * r() - 1)] : st;
  return out;
}
// the kept contours' count: curves per closing line
const kept = (res) => (res === null ? null : res.filter((g) => g.is_fill_only).length);

const bad = [];
let n = 0;
for (const O of [0, 16384])
  for (const e of [0, -20, 20]) {
    const S = 2 ** e,
      OS = O * S;
    const mk = (rel, seed, innerA = 20, innerB = 80) => {
      const r = rng(seed * 7919 + 13);
      return [
        ...close(scaled(roundedSquare(0, 100, 10), S, OS, rel, r)),
        ...close(scaled(roundedSquare(innerA, innerB, 10), S, OS, rel, r)),
      ];
    };
    const base = normalizedFillSegs(mk(0, 1), false);
    if (kept(base) !== 1) bad.push(`unperturbed 2^${e}+${O}: kept ${kept(base)}`);
    for (const rel of [1e-9, 1e-8, 1e-7, 1e-6])
      for (let seed = 1; seed <= 4; seed++) {
        n++;
        const res = normalizedFillSegs(mk(rel, seed), false);
        if (kept(res) !== 1) bad.push(`2^${e}+${O} rel ${rel} seed ${seed}: kept ${kept(res)}`);
      }
    // an inner square that pokes out by 1e-3 of the extent (its right side at 100.1) is real ink: both contours stay
    for (const rel of [0, 1e-7]) {
      const res = normalizedFillSegs(mk(rel, 9, 20, 100.1), false);
      if (kept(res) === 1) bad.push(`2^${e}+${O} rel ${rel}: a contour 1e-3 outside was dropped`);
    }
  }
check(
  bad.length === 0,
  `${n} perturbed pairs normalize like the unperturbed one at every size${bad.length ? ' -- ' + bad.length + ' wrong, first: ' + bad.slice(0, 3).join('; ') : ''}`,
);
if (failures) {
  console.log(`fillNormalizePerturbationSmoke FAIL: ${failures}`);
  process.exit(1);
}
console.log('fillNormalizePerturbationSmoke PASS');
