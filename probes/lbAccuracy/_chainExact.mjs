// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _chainExact — the exact box coverage of a straight chain's fill, the reference chainBoxCov is checked against
// (probes/lbAccuracy/_kernelSelfTest.mjs, test/lbChainPieceWalkSmoke.mjs).
//
// The chain is five points, fill on its LEFT, in CELL coordinates with the pixel box [-1/2, 1/2]^2. Continued along its
// end segments as rays and closed far away on its left it is a polygon, so area(box ∩ fill) is a polygon clip, exact,
// with no supersampling. That is the truth only where the kernel's contract and the polygon's agree, so a chain is a
// CASE only when
//   * it crosses the box (a clipped run of positive length: a miss or a touch is chainMissCov's and forceInside's);
//   * with its rays it is a simple path, tested with the rays INFINITE -- two nearly parallel end rays that converge
//     cross far away, and then the path has no one left side (a ray test cut at a finite length passed such chains and
//     scored the kernel's local answer against the complement);
//   * neither ray that starts OUTSIDE the box meets it: the kernel's chain is its four segments, continued along an end
//     only from an end inside the box, and a ray that re-enters the box is the reference's fiction, not the outline.

/// The Liang-Barsky parameter interval of segment AB inside the box, or null when it misses or only touches.
export function clipSeg(A, B) {
  const d = [B[0] - A[0], B[1] - A[1]];
  let t0 = 0,
    t1 = 1;
  for (const [q, r] of [
    [-d[0], A[0] + 0.5],
    [d[0], 0.5 - A[0]],
    [-d[1], A[1] + 0.5],
    [d[1], 0.5 - A[1]],
  ]) {
    if (q === 0) {
      if (r < 0) return null;
      continue;
    }
    const u = r / q;
    if (q < 0) {
      if (u > t1) return null;
      if (u > t0) t0 = u;
    } else {
      if (u < t0) return null;
      if (u < t1) t1 = u;
    }
  }
  return t1 > t0 + 1e-12 ? [t0, t1] : null;
}

const unit = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
};
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

/// How many disjoint runs the chain clips into the box as, or 0 when it is not a case (see the header).
export function crossingRuns(P) {
  let runs = 0,
    prevEnd = null;
  for (let i = 0; i < 4; i++) {
    const c = clipSeg(P[i], P[i + 1]);
    if (!c) {
      prevEnd = null;
      continue;
    }
    if (!(prevEnd === 1 && c[0] === 0)) runs++;
    prevEnd = c[1];
  }
  if (!runs) return 0;
  // the path's pieces in order: the start ray (P0 backward), the four segments, the end ray (P4 forward)
  const r0 = unit([P[0][0] - P[1][0], P[0][1] - P[1][1]]),
    r4 = unit([P[4][0] - P[3][0], P[4][1] - P[3][1]]);
  const pieces = [{ A: P[0], d: r0, t: Infinity }];
  for (let i = 0; i < 4; i++)
    pieces.push({ A: P[i], d: [P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]], t: 1 });
  pieces.push({ A: P[4], d: r4, t: Infinity });
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 2; j < pieces.length; j++) {
      const a = pieces[i],
        b = pieces[j],
        den = cross(a.d, b.d);
      if (den === 0) continue;
      const w = [b.A[0] - a.A[0], b.A[1] - a.A[1]];
      const s = cross(w, b.d) / den,
        u = cross(w, a.d) / den;
      if (s > 0 && s < a.t && u > 0 && u < b.t) return 0;
    }
  const inBox = (q) => Math.abs(q[0]) <= 0.5 && Math.abs(q[1]) <= 0.5;
  const far = (Q, d) => [Q[0] + d[0] * 1e3, Q[1] + d[1] * 1e3];
  if (!inBox(P[0]) && clipSeg(P[0], far(P[0], r0))) return 0;
  if (!inBox(P[4]) && clipSeg(P[4], far(P[4], r4))) return 0;
  return runs;
}

/// area(box ∩ fill): the chain continued along its end segments and closed counterclockwise far away.
export function exactChainArea(P) {
  const g0 = unit([P[1][0] - P[0][0], P[1][1] - P[0][1]]),
    g1 = unit([P[4][0] - P[3][0], P[4][1] - P[3][1]]),
    R = 1e3;
  const poly = [
    [P[0][0] - g0[0] * R, P[0][1] - g0[1] * R],
    ...P,
    [P[4][0] + g1[0] * R, P[4][1] + g1[1] * R],
  ];
  const aE = Math.atan2(g1[1], g1[0]),
    aS = Math.atan2(-g0[1], -g0[0]);
  let sw = aS - aE;
  sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (let k = 1; k < 64; k++) {
    const a = aE + (sw * k) / 64;
    poly.push([Math.cos(a) * 2 * R, Math.sin(a) * 2 * R]);
  }
  let pg = poly;
  for (const [ax, sg] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ]) {
    const inside = (q) => sg * q[ax] <= 0.5,
      out = [];
    for (let i = 0; i < pg.length; i++) {
      const a = pg[i],
        b = pg[(i + 1) % pg.length],
        ia = inside(a),
        ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const u = (sg * 0.5 - a[ax]) / (b[ax] - a[ax]);
        out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      }
    }
    pg = out;
    if (!pg.length) return 0;
  }
  let a = 0;
  for (let i = 0; i < pg.length; i++) {
    const p = pg[i],
      q = pg[(i + 1) % pg.length];
    a += p[0] * q[1] - p[1] * q[0];
  }
  return Math.abs(a) / 2;
}

/// Random cases: `draws` chains of five points, a random walk of steps up to 1 cell from a start within 1.5 cells of the
/// pixel, kept when they are cases. `round` maps each point (e.g. to float32). Deterministic in `seed`.
export function randomCrossingChains(draws, seed = 0x2545f491, round = (p) => p) {
  let s = seed;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const out = [];
  for (let t = 0; t < draws; t++) {
    const P = [];
    let x = (rnd() - 0.5) * 3,
      y = (rnd() - 0.5) * 3;
    for (let i = 0; i < 5; i++) {
      P.push(round([x, y]));
      x += (rnd() - 0.5) * 2;
      y += (rnd() - 0.5) * 2;
    }
    const runs = crossingRuns(P);
    if (runs) out.push({ pts: P, runs, want: exactChainArea(P) });
  }
  return out;
}
