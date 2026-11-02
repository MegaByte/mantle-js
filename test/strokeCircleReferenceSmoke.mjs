// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The circular stroke oracle's analytic roots must agree with the
// 96-bracket/40-bisection scan oracle. Keep the scan selectable for this cross-check.
import assert from 'node:assert/strict';
import { arcSegs, svgInsideGeneric } from './_strokeCubicArcRef.mjs';

let seed = 0x7b4211,
  checked = 0;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (const sign of [-1, 1])
  for (const sweep of [0.05, 1, Math.PI, 4.2, 6, 2 * Math.PI, 4 * Math.PI])
    for (const radius of [0.3, 1, 4, 20])
      for (const cap of [0, 1, 2]) {
        const start = random() * 6 - 3,
          phi = random() * 6 - 3,
          halfW = radius * [0.25, 1, 2][cap];
        const segments = arcSegs(
          [
            {
              cx: 0.17,
              cy: -0.23,
              rx: radius,
              ry: radius,
              phi,
              th0: start,
              th1: start + sign * sweep,
            },
          ],
          false,
        );
        for (let i = 0; i < 40; i++) {
          const angle = random() * 2 * Math.PI,
            rho = (radius + halfW) * random() * 1.25;
          const p =
            i === 0 ? [0.17, -0.23] : [0.17 + rho * Math.cos(angle), -0.23 + rho * Math.sin(angle)];
          const fast = svgInsideGeneric(p, segments, false, halfW, cap, 0, 4, cap, true);
          const scan = svgInsideGeneric(p, segments, false, halfW, cap, 0, 4, cap, false);
          // At the center, hw==R is an exact boundary. Re-evaluating a rotated
          // radius by trig lets the scan's length land on either adjacent double.
          if (i === 0 && halfW === radius) assert.equal(fast, true);
          else
            assert.equal(
              fast,
              scan,
              JSON.stringify({ p, radius, halfW, phi, start, sign, sweep, cap }),
            );
          checked++;
        }
      }
// Exactly circular is the only specialization. Near circles and ellipses retain
// the scan; test both sweep directions and rotations through the same API.
for (const ratio of [1 + 2 ** -30, 1 - 2 ** -30, 2, 0.5])
  for (const sign of [-1, 1]) {
    const segments = arcSegs(
      [
        {
          cx: 0.17,
          cy: -0.23,
          rx: 2,
          ry: 2 * ratio,
          phi: 0.37,
          th0: -0.41,
          th1: -0.41 + sign * 4.2,
        },
      ],
      false,
    );
    for (let i = 0; i < 40; i++) {
      const p = [random() * 8 - 4, random() * 8 - 4];
      assert.equal(
        svgInsideGeneric(p, segments, false, 0.7, 1, 0, 4, 1, true),
        svgInsideGeneric(p, segments, false, 0.7, 1, 0, 4, 1, false),
      );
      checked++;
    }
  }
console.log(
  `STROKE-CIRCLE-REFERENCE PASS — ${checked} exact/near-circle/ellipse membership checks, original scan retained, both sweeps, caps, center and multiple turns.`,
);
