// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Experimental star-shaped polynomial morph preparation. No CPatch conversion
// or implicit certificate: each piece is one original curve and two radii.
import { polynomialMorphShapes, controlBounds } from './morphPreparation.js';
import { pathData } from './serialize.mjs';

const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => a.map((v, k) => v - b[k]);
const choose = (n, k) => {
  let v = 1;
  for (let j = 1; j <= k; j++) v = (v * (n - j + 1)) / j;
  return v;
};
function split(coeff) {
  const left = [coeff[0]],
    right = [coeff.at(-1)];
  let row = coeff;
  while (row.length > 1) {
    row = row.slice(1).map((v, k) => (row[k] + v) / 2);
    left.push(row[0]);
    right.push(row.at(-1));
  }
  return [left, right.reverse()];
}
function positiveTensor(rows, guard, depth = 0, deadline = Infinity) {
  if (performance.now() > deadline) throw Error('Radial fan preparation deadline');
  if (rows.flat().every((v) => v > guard)) return true;
  if (depth === 12 || rows.flat().every((v) => v <= guard)) return false;
  // Alternate subdivisions in u and t. Positive Bernstein coefficients bound
  // the polynomial everywhere in the rectangle, not just at sampled poses.
  if (depth % 2 === 0) {
    const parts = rows.map(split);
    return [0, 1].every((k) =>
      positiveTensor(
        parts.map((p) => p[k]),
        guard,
        depth + 1,
        deadline,
      ),
    );
  }
  const parts = rows[0].map((_, u) => split(rows.map((r) => r[u])));
  return [0, 1].every((k) =>
    positiveTensor(
      rows.map((_, t) => parts.map((p) => p[k][t])),
      guard,
      depth + 1,
      deadline,
    ),
  );
}
function angularCoefficients(A, B) {
  const n = A.length - 1,
    Q = [A, B],
    D = Q.map((ps) => ps.slice(1).map((p, k) => sub(p, ps[k]).map((v) => n * v)));
  const rows = Array.from({ length: 3 }, () => Array(2 * n).fill(0));
  for (let t = 0; t < 2; t++)
    for (let z = 0; z < 2; z++)
      for (let i = 0; i <= n; i++)
        for (let j = 0; j < n; j++)
          rows[t + z][i + j] +=
            (cross(Q[t][i], D[z][j]) * choose(n, i) * choose(n - 1, j)) /
            choose(2 * n - 1, i + j) /
            choose(2, t + z);
  return rows;
}
function crossSpan(a, b) {
  return [cross(a[0], b[0]), (cross(a[0], b[1]) + cross(a[1], b[0])) / 2, cross(a[1], b[1])];
}
export function certifyRadialMorph(A, B, anchorA, anchorB, deadline = Infinity) {
  const box = controlBounds(A, B),
    extent = Math.max(box[2] - box[0], box[3] - box[1]);
  // Reserve a margin for f32 import/interpolation; exact shared endpoint rays
  // are exempt from their own cone test, not from angular monotonicity.
  const guard = extent * extent * 2 ** -20;
  const relative = A.map((c, i) => [
    c.P.map((p) => sub(p, anchorA)),
    B[i].P.map((p) => sub(p, anchorB)),
  ]);
  const area = relative.reduce((v, q) => v + cross(q[0][0], q[0].at(-1)), 0),
    sign = Math.sign(area);
  if (!sign) throw Error('Fan orientation is unproved');
  let turn = 0;
  for (let i = 0; i < A.length; i++) {
    const next = (i + 1) % A.length;
    for (const cs of [A, B])
      if (cs[i].P.at(-1).some((v, k) => v !== cs[next].P[0][k])) throw Error('Open fan contour');
    const [lo, hi] = relative[i],
      start = [lo[0], hi[0]],
      end = [lo.at(-1), hi.at(-1)];
    const endpoint = crossSpan(start, end).map((v) => sign * v);
    if (
      !positiveTensor(
        endpoint.map((v) => [v]),
        guard,
        0,
        deadline,
      )
    )
      throw Error('Fan endpoint sector is unproved');
    for (let k = 1; k + 1 < lo.length; k++) {
      const q = [lo[k], hi[k]];
      for (const c of [crossSpan(start, q), crossSpan(q, end)])
        if (
          !positiveTensor(
            c.map((v) => [sign * v]),
            guard,
            0,
            deadline,
          )
        )
          throw Error('Curve controls leave the fan sector');
    }
    if (
      !positiveTensor(
        angularCoefficients(lo, hi).map((r) => r.map((v) => sign * v)),
        guard,
        0,
        deadline,
      )
    )
      throw Error('Radial monotonicity is unproved');
    turn += Math.atan2(
      sign * cross(lo[0], lo.at(-1)),
      lo[0][0] * lo.at(-1)[0] + lo[0][1] * lo.at(-1)[1],
    );
  }
  // Every curve stays in its <pi endpoint cone and increases in angle. A
  // single initial turn and strictly positive endpoint sectors establish that
  // those sectors partition one full turn for all t. Within a sector the
  // curve intersects each ray once, so each curved wedge is simple and the
  // wedges have disjoint interiors and sum to the original fill.
  if (Math.abs(turn - 2 * Math.PI) > 2 ** -35) throw Error('Fan does not wind once');
  return { orientation: sign, guard };
}
export function prepareRadialPolynomialMorph(sectionsA, sectionsB, options = {}) {
  const start = performance.now(),
    deadline = start + (options.maxPreparationMs ?? 20);
  const shapes = polynomialMorphShapes(sectionsA, sectionsB),
    groupsLo = [],
    groupsHi = [],
    proofs = [];
  for (const s of shapes) {
    const A = s.originalA,
      B = s.originalB;
    const anchor = (cs) =>
      [0, 1].map((k) => Math.fround(cs.reduce((v, c) => v + c.P[0][k], 0) / cs.length));
    const a = anchor(A),
      b = anchor(B);
    proofs.push({ shape: s.shape, ...certifyRadialMorph(A, B, a, b, deadline) });
    const wedge = (c, p) => [c, { t: 'line', P: [c.P.at(-1), p] }, { t: 'line', P: [p, c.P[0]] }];
    const lo = A.map((c) => wedge(c, a)),
      hi = B.map((c) => wedge(c, b));
    const pieceBboxes = lo.map((cs, i) => controlBounds(cs, hi[i])),
      bbox = controlBounds(...lo, ...hi);
    const piecePoints = lo.map((cs, i) => [...cs, ...hi[i]].flatMap((c) => c.P));
    for (const [cells, groups] of [
      [lo, groupsLo],
      [hi, groupsHi],
    ])
      groups.push({
        shape: s.shape,
        pieces: cells.length,
        color: s.color,
        bbox,
        pieceBboxes,
        piecePoints,
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg">' +
          cells
            .map(
              (cs, i) =>
                `<path id="morph_${s.shape}_${i}" fill="white" fill-opacity="0.5" d="${pathData([cs])}"/>`,
            )
            .join('') +
          '</svg>',
      });
  }
  if (performance.now() > deadline) throw Error('Radial fan preparation deadline');
  return {
    intervals: [{ t0: 0, t1: 1, groupsLo, groupsHi }],
    stats: {
      totalMs: performance.now() - start,
      intervals: 1,
      shapes: shapes.length,
      maxPieces: groupsLo.reduce((n, g) => n + g.pieces, 0),
      proofs,
      scope:
        'F32 geometry; tensor Bernstein sector and radial monotonicity proof over all u,t; one fixed fan interval; serialization; import/upload separate',
    },
  };
}
