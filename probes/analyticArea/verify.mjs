// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { boundaryArea, point } from './area.mjs';
import { pathToCycles } from '../../src/geom/cpatchGraph.js';
import { cellCoverage } from '../fillperf/cellCoverage.mjs';

let checks = 0,
  maxError = 0;
function near(actual, expected, tol, label) {
  checks++;
  maxError = Math.max(maxError, Math.abs(actual - expected));
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${label}: ${actual} != ${expected}, error ${Math.abs(actual - expected)}, tolerance ${tol}`,
  );
}
const line = (a, b) => ({ t: 'line', P: [a, b] });
const polygon = (P) => P.map((a, i) => line(a, P[(i + 1) % P.length]));
const rect = (x0, y0, x1, y1) =>
  polygon([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
const reverse = (c) =>
  c
    .slice()
    .reverse()
    .map((s) => (s.t === 'arc' ? { ...s, a: s.b, b: s.a } : { ...s, P: s.P.slice().reverse() }));
const circle = (r, reverse = false) => [
  { t: 'arc', c: [0.5, 0.5], u: [r, 0], v: [0, r], a: 0, b: reverse ? -2 * Math.PI : 2 * Math.PI },
];

// Independent oracle: clip a densely sampled polygon, then shoelace in pixel-local
// coordinates. This approximates a curve, so require convergence as well as agreement.
function clipArea(P, x, y) {
  let p = P.map((q) => [q[0] - x, q[1] - y]);
  for (const [k, edge, side] of [
    [0, 0, 1],
    [0, 1, -1],
    [1, 0, 1],
    [1, 1, -1],
  ]) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i],
        b = p[(i + 1) % p.length],
        ia = side * (a[k] - edge) >= 0,
        ib = side * (b[k] - edge) >= 0;
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (edge - a[k]) / (b[k] - a[k]);
        out.push(a.map((v, j) => v + t * (b[j] - v)));
      }
    }
    p = out;
  }
  return (
    p.reduce((sum, a, i) => {
      const b = p[(i + 1) % p.length];
      return sum + a[0] * b[1] - a[1] * b[0];
    }, 0) / 2
  );
}
const flatten = (c, n) =>
  c.flatMap((s) =>
    Array.from({ length: s.t === 'line' ? 1 : n }, (_, i) =>
      point(s, i / (s.t === 'line' ? 1 : n)),
    ),
  );

const square = rect(0, 0, 1, 1);
for (const [x, y] of [
  [0, 0],
  [0.25, 0.5],
  [-0.4, -0.6],
  [1, 0],
  [0, 1],
]) {
  near(
    boundaryArea(square, x, y),
    Math.max(0, 1 - Math.abs(x)) * Math.max(0, 1 - Math.abs(y)),
    1e-13,
    'rectangle',
  );
}
near(
  boundaryArea(
    polygon([
      [0, 0],
      [1, 0],
      [0, 1],
    ]),
    0,
    0,
  ),
  0.5,
  1e-13,
  'triangle',
);
// Polynomial y(x), x=t: integral is the mean of the Bernstein ordinates.
for (const ordinates of [
  [0.2, 0.8],
  [0.2, 0.9, 0.4],
  [0.1, 0.9, 0.2, 0.7],
]) {
  const top = {
    t: ordinates.length === 2 ? 'line' : ordinates.length === 3 ? 'quad' : 'cubic',
    P: ordinates.map((y, i) => [i / (ordinates.length - 1), y]),
  };
  const c = [
    line([0, 0], [1, 0]),
    line([1, 0], top.P.at(-1)),
    ...reverse([top]),
    line(top.P[0], [0, 0]),
  ];
  near(
    boundaryArea(c, 0, 0),
    ordinates.reduce((a, b) => a + b) / ordinates.length,
    1e-13,
    'polynomial graph integral',
  );
}
near(boundaryArea(circle(0.25), 0, 0), Math.PI / 16, 2e-14, 'subpixel circle');
near(
  boundaryArea([...circle(0.45), ...circle(0.1, true)], 0, 0),
  Math.PI * (0.45 ** 2 - 0.1 ** 2),
  2e-14,
  'curved hole',
);
const w = Math.SQRT1_2;
const rq = {
  t: 'rquad',
  w,
  P: [
    [1, 0],
    [1, 1],
    [0, 1],
  ],
};
near(
  boundaryArea([line([0, 0], [1, 0]), rq, line([0, 1], [0, 0])], 0, 0),
  Math.PI / 4,
  2e-14,
  'rational quarter circle',
);

// A 0/1 boundary is a real precondition: final abs/clamp is NOT a fill-rule resolver.
const A = rect(0.05, 0.1, 0.45, 0.6),
  B = rect(0.25, 0.1, 0.65, 0.6);
const raw = boundaryArea([...A, ...B], 0, 0);
near(raw, 0.4, 1e-13, 'raw winding integral');
const referenceSegments = [...A, ...B].map((s) => ({
  t: 0,
  x0: s.P[0][0],
  y0: s.P[0][1],
  x1: s.P[1][0],
  y1: s.P[1][1],
}));
const existingNonzero = cellCoverage(referenceSegments, [0.5, 0.5], [1, 1], false);
const existingEvenodd = cellCoverage(referenceSegments, [0.5, 0.5], [1, 1], true);
// Pin the limitation in the EXISTING reference. These are observed wrong answers,
// not acceptance tests for production. Both should change if that oracle is fixed.
near(existingNonzero, 0.4, 1e-13, 'existing raw-winding reference, nonzero');
near(existingEvenodd, 0.4, 1e-13, 'existing raw-winding reference, evenodd');
near(
  boundaryArea(pathToCycles([A, B], false).flat(), 0, 0),
  0.3,
  1e-10,
  'nonzero overlap resolved',
);
near(boundaryArea(pathToCycles([A, B], true).flat(), 0, 0), 0.2, 1e-10, 'evenodd overlap resolved');
assert.ok(Math.abs(Math.min(1, Math.abs(raw)) - 0.3) > 0.09);
checks++;
const hole = [...rect(0.05, 0.05, 0.95, 0.95), ...reverse(rect(0.25, 0.25, 0.75, 0.75))];
near(boundaryArea(hole, 0, 0), 0.56, 1e-13, 'opposite winding hole');
const left = boundaryArea(rect(0, 0, 0.5, 1), 0, 0),
  right = boundaryArea(rect(0.5, 0, 1, 1), 0, 0);
near(left + right, 1, 1e-13, 'adjacent areas add');
near(left + right - left * right, 0.75, 1e-13, 'source-over loses coverage');
const enclosing = rect(-10, -10, 10, 10);
near(
  boundaryArea(enclosing, 0, 0),
  1,
  1e-13,
  'interior needs distant-boundary/backdrop contribution',
);
const localOnly = enclosing.filter(
  (s) =>
    Math.max(...s.P.map((p) => p[0])) >= 0 &&
    Math.min(...s.P.map((p) => p[0])) <= 1 &&
    Math.max(...s.P.map((p) => p[1])) >= 0 &&
    Math.min(...s.P.map((p) => p[1])) <= 1,
);
near(boundaryArea(localOnly, 0, 0), 0, 1e-13, 'dropping all distant edges loses interior');

// Affine ellipse plus cubic inflection, cusp/zero-handle, and narrow loop cases.
const cases = [
  [{ t: 'arc', c: [0.3, 0.5], u: [1.3, 0.45], v: [0.2, 0.7], a: 0, b: 2 * Math.PI }],
  [
    {
      t: 'cubic',
      P: [
        [-1, 0.2],
        [2, 2],
        [-1, -1],
        [2, 0.8],
      ],
    },
    line([2, 0.8], [2, -1]),
    line([2, -1], [-1, -1]),
    line([-1, -1], [-1, 0.2]),
  ],
  [
    {
      t: 'cubic',
      P: [
        [0, 0],
        [0, 0],
        [1, 1],
        [1, 0],
      ],
    },
    line([1, 0], [0, 0]),
  ],
  [
    {
      t: 'cubic',
      P: [
        [0.3, 0.2],
        [0.31, 2],
        [0.32, -1],
        [0.3, 0.2],
      ],
    },
  ],
  [rq, line([0, 1], [1, 0])],
];
let seed = 47831;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (let i = 0; i < 20; i++) {
  const P = Array.from({ length: 4 }, () => [random() * 3 - 1, random() * 3 - 1]);
  cases.push([{ t: 'cubic', P }, line(P[3], P[0])]);
}
let maxDenseDelta = 0,
  maxCurveError = 0;
for (const c of cases) {
  const coarse = flatten(c, 2048),
    fine = flatten(c, 8192);
  for (let i = 0; i < 12; i++) {
    const x = random() * 2 - 1,
      y = random() * 2 - 1;
    const a = boundaryArea(c, x, y),
      ref = clipArea(fine, x, y),
      old = clipArea(coarse, x, y);
    maxDenseDelta = Math.max(maxDenseDelta, Math.abs(ref - old));
    maxCurveError = Math.max(maxCurveError, Math.abs(a - ref));
    near(a, ref, 2e-7, 'dense independently clipped polygon');
    near(boundaryArea(reverse(c), x, y), -a, 2e-12, 'reverse orientation');
  }
}

// Same physical pixel under a change of authored units and a translation. This
// tests conditioning, not an unlimited-zoom or float32 GPU guarantee.
for (const c of cases.slice(0, 5))
  for (const exponent of [-16, -8, 0, 8, 16]) {
    const k = 2 ** exponent,
      tx = 1024 * k,
      ty = -2048 * k;
    const transformed = c.map((s) =>
      s.t === 'arc'
        ? {
            ...s,
            c: [s.c[0] * k + tx, s.c[1] * k + ty],
            u: s.u.map((v) => v * k),
            v: s.v.map((v) => v * k),
          }
        : { ...s, P: s.P.map((p) => [p[0] * k + tx, p[1] * k + ty]) },
    );
    near(
      boundaryArea(transformed, tx, ty, k),
      boundaryArea(c, 0, 0),
      2e-10,
      'authored scale/translation',
    );
  }
// Large device-space curves through one pixel, compared with a known polynomial
// graph integral on the small parameter interval. B(t)=(S t, S t^3).
for (const S of [1, 16, 256, 4096, 65536]) {
  const c = [
    line([0, 0], [S, 0]),
    line([S, 0], [S, S]),
    {
      t: 'cubic',
      P: [
        [S, S],
        [(2 * S) / 3, 0],
        [S / 3, 0],
        [0, 0],
      ],
    },
  ];
  near(boundaryArea(c, 0, 0), 1 / (4 * S * S), 2e-12, 'device-scale cubic');
}
const result = {
  checks,
  maxError,
  maxCurveError,
  maxDenseDelta,
  rawWinding: raw,
  nonzeroCoverage: 0.3,
  evenOddCoverage: 0.2,
  existingReferenceNonzero: existingNonzero,
  existingReferenceEvenodd: existingEvenodd,
  seamSourceOver: 0.75,
  seamUnion: 1,
  scope: 'float64 CPU analytic-area proof; no GPU timings or production changes',
};
console.log(JSON.stringify(result, null, 2));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
