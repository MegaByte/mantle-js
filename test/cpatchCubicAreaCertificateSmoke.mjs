// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Native cubic preparation must certify the entire paint, including nesting.
import assert from 'node:assert/strict';
import { certifySimplePolynomialPaint as certify } from '../src/renderer/cpatchSimpleArea.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
const line = (a, b) => ({ t: 'line', P: [a, b] });
const circle = (r) =>
  [
    [
      [r, 0],
      [r, r * 0.55],
      [r * 0.55, r],
      [0, r],
    ],
    [
      [0, r],
      [-r * 0.55, r],
      [-r, r * 0.55],
      [-r, 0],
    ],
    [
      [-r, 0],
      [-r, -r * 0.55],
      [-r * 0.55, -r],
      [0, -r],
    ],
    [
      [0, -r],
      [r * 0.55, -r],
      [r, -r * 0.55],
      [r, 0],
    ],
  ].map((P) => ({ t: 'cubic', P }));
const outer = circle(10),
  inner = circle(3),
  rev = (cs) =>
    cs
      .slice()
      .reverse()
      .map((c) => ({ ...c, P: c.P.slice().reverse() }));
assert.equal(certify([outer, inner]).curves.length, 4, 'same-winding interior is not a boundary');
assert.equal(certify([outer, inner], true).curves.length, 8, 'even-odd keeps the hole');
assert.equal(certify([outer, rev(inner)]).curves.length, 8, 'nonzero reversed hole');
for (const offset of [0, 1e6, -1e6]) {
  const shifted = [outer, rev(inner)].map((cs) =>
    cs.map((c) => ({ ...c, P: c.P.map((p) => p.map((v) => v + offset)) })),
  );
  assert.equal(certify(shifted).curves.length, 8, 'translated nesting');
}
const bend = {
  t: 'cubic',
  P: [
    [0, 0],
    [2, 1],
    [-1, 2],
    [1, 3],
  ],
};
const loop = [
  bend,
  line([1, 3], [4, 3]),
  line([4, 3], [4, -1]),
  line([4, -1], [0, -1]),
  line([0, -1], [0, 0]),
];
const bendCert = certify([loop]);
assert.equal(bendCert.curves.length, loop.length, 'proof subdivisions do not add GPU records');
const packedBend = bendCert.curves.find((c) => c.t === 'cubic').P;
assert(
  packedBend.every((p, i) => p.every((v, j) => v === bend.P[i][j])) ||
    packedBend.every((p, i) => p.every((v, j) => v === bend.P[3 - i][j])),
  'authored native cubic retained',
);
const live = packCPatchShape([outer, rev(inner)]);
for (const opts of [{ traceOut: new Map() }, { traces: new Map() }]) {
  const baked = packCPatchShape([outer, rev(inner)], 0, opts);
  assert.deepEqual(baked.texels, live.texels);
  assert.deepEqual(baked.verts, live.verts);
}
const crossing = inner.map((c) => ({ ...c, P: c.P.map(([x, y]) => [x + 9, y]) }));
for (const cs of [
  [outer, outer],
  [outer, crossing],
  [outer.slice(0, 3)],
  [
    [
      {
        ...bend,
        P: [
          [0, 0],
          [2, 1],
          [-1, 2],
          [0, 0],
        ],
      },
      ...loop.slice(1),
    ],
  ],
])
  assert.equal(
    certify(cs),
    null,
    'unresolved contact, crossing, open contour or degenerate cubic declines',
  );
assert.equal(
  certify([
    [
      ...outer,
      {
        t: 'arc',
        P: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
  ]),
  null,
);
// Exact repeated controls do not invalidate a strictly monotone curve.
for (const scale of [2 ** -20, 1, 2 ** 20])
  for (const mode of ['start', 'end', 'both', 'middle']) {
    const zero = circle(10).map((c) => {
      const P = c.P.map((p) => p.map((v) => v * scale));
      if (mode === 'start' || mode === 'both') P[1] = P[0].slice();
      if (mode === 'end' || mode === 'both') P[2] = P[3].slice();
      if (mode === 'middle') P[2] = P[1].slice();
      return { t: 'cubic', P };
    });
    assert.equal(certify([zero]).curves.length, 4, 'repeated control remains injective');
    assert.equal(certify([zero, zero]), null, 'duplicate boundaries still decline');
    assert.equal(certify([zero.slice(0, 3)]), null, 'open boundaries still decline');
    const collapsed = zero.map((c) => ({ ...c, P: c.P.map(() => c.P[0]) }));
    assert.equal(certify([collapsed]), null, 'collapsed curves still decline');
  }
console.log(
  'cpatchCubicAreaCertificateSmoke PASS: cubic nesting, exact subdivision, translations and conservative declines',
);
