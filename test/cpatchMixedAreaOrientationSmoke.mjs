// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independent straight-edge polygons expose mixed Green-convention errors.
import assert from 'node:assert/strict';
import { certifySimplePolynomialPaint } from '../src/core/polynomialPaint.js';
const area = (loop) => {
  const o = loop[0].P[0];
  let a = 0;
  for (const c of loop) {
    const p = c.P[0],
      q = c.P.at(-1);
    a += (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  }
  return a / 2;
};
const contour = (points, cubic, quad) =>
  points.map((p, i) => {
    const q = points[(i + 1) % points.length],
      mix = (t) => p.map((v, j) => v + (q[j] - v) * t);
    return i === cubic
      ? { t: 'cubic', P: [p, mix(1 / 3), mix(2 / 3), q] }
      : i === quad
        ? { t: 'quad', P: [p, mix(0.5), q] }
        : { t: 'line', P: [p, q] };
  });
const outerPoints = [
    [0, 0],
    [30, 0],
    [30, 40],
    [0, 40],
  ],
  innerPoints = [
    [5, 5],
    [15, 14],
    [25, 33],
    [15, 24],
  ];
let cases = 0;
for (const evenOdd of [false, true])
  for (const reverse of [false, true])
    for (const shift of [0, 1, 2, 3])
      for (const scale of [1e-4, 1, 1e4])
        for (const origin of [0, 1e8]) {
          const map = (p) => p.map((v) => v * scale + origin);
          let outer = contour(outerPoints.map(map), -1, -1),
            inner = contour(innerPoints.map(map), 2, 1);
          if (reverse) {
            outer = outer
              .slice()
              .reverse()
              .map((c) => ({ ...c, P: c.P.slice().reverse() }));
            inner = inner
              .slice()
              .reverse()
              .map((c) => ({ ...c, P: c.P.slice().reverse() }));
          }
          inner = inner.slice(shift).concat(inner.slice(0, shift));
          const original = JSON.stringify([outer, inner]),
            cert = certifySimplePolynomialPaint([outer, inner], evenOdd);
          assert(cert, 'certificate ' + JSON.stringify({ evenOdd, reverse, shift, scale, origin }));
          assert.equal(cert.curves.length, evenOdd ? 8 : 4);
          assert(area(cert.curves.slice(0, 4)) > 0, 'outer orientation');
          if (evenOdd) assert(area(cert.curves.slice(4)) < 0, 'hole orientation');
          assert.equal(
            JSON.stringify([outer, inner]),
            original,
            'authored native controls unchanged',
          );
          // The no-op preflight must agree with the fully certified change. Globally
          // reversed contours can be left alone, but a redundant boundary/hole cannot.
          const changed = certifySimplePolynomialPaint([outer, inner], evenOdd, {
            changesOnly: true,
          });
          assert(changed);
          assert.deepEqual(
            changed.curves.map((c) => c.P),
            cert.curves.map((c) => c.P),
          );
          cases++;
        }
console.log(
  'cpatchMixedAreaOrientationSmoke PASS: ' +
    cases +
    ' independent polygon controls with native quadratic/cubic spans, both fill rules, reversals, starting points, scales and origins',
);
