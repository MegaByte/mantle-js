// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gvarIupSmoke.mjs — IUP (Interpolation of Untouched Points) delta inference.
// Validates inferIupDeltas directly on synthetic contours: clamp-below,
// clamp-above, linear interpolation, single-touched (uniform), zero-touched,
// and equal-coord/unequal-delta → 0. The C# runtime's MantleGvarTable.InferIupDeltas
// is held to the same goldens.

import { inferIupDeltas } from '../../src/font/variations/gvarReader.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// Run one contour case. pts: [{x,y, dx?,dy?}] where dx/dy present ⇒ touched.
// Returns the full inferred [dx,dy] per point. nPoints = pts.length; the 4
// phantom slots stay untouched (0).
function runContour(pts) {
  const nPoints = pts.length;
  const total = nPoints + 4;
  const dx = new Float64Array(total);
  const dy = new Float64Array(total);
  const ox = new Float64Array(total);
  const oy = new Float64Array(total);
  const touched = new Uint8Array(total);
  for (let i = 0; i < nPoints; i++) {
    ox[i] = pts[i].x;
    oy[i] = pts[i].y;
    if (pts[i].dx !== undefined) {
      dx[i] = pts[i].dx;
      dy[i] = pts[i].dy;
      touched[i] = 1;
    }
  }
  inferIupDeltas(dx, dy, touched, ox, oy, [nPoints - 1], nPoints);
  return { dx, dy };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
function expect(label, got, want) {
  for (let i = 0; i < want.length; i++) {
    if (!near(got.dx[i], want[i][0]) || !near(got.dy[i], want[i][1]))
      return fail(
        `${label} p${i} = (${got.dx[i]}, ${got.dy[i]}), want (${want[i][0]}, ${want[i][1]})`,
      );
  }
  ok(label);
}

// T1: square, touch p0 & p2 → p1/p3 clamp to the nearer touched delta.
expect(
  'T1 square clamp',
  runContour([
    { x: 0, y: 0, dx: 10, dy: 10 },
    { x: 100, y: 0 },
    { x: 100, y: 100, dx: 30, dy: 30 },
    { x: 0, y: 100 },
  ]),
  [
    [10, 10],
    [30, 10],
    [30, 30],
    [10, 30],
  ],
);

// T2: collinear, untouched midpoint interpolates linearly (x: 0→100 ⇒ 50).
expect(
  'T2 linear midpoint',
  runContour([
    { x: 0, y: 0, dx: 0, dy: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0, dx: 100, dy: 0 },
  ]),
  [
    [0, 0],
    [50, 0],
    [100, 0],
  ],
);

// T3: single touched point → every point in the contour gets its delta.
expect(
  'T3 single touched uniform',
  runContour([
    { x: 0, y: 0 },
    { x: 50, y: 0, dx: 7, dy: -3 },
    { x: 99, y: 0 },
  ]),
  [
    [7, -3],
    [7, -3],
    [7, -3],
  ],
);

// T4: no touched points → all deltas stay 0.
expect(
  'T4 zero touched',
  runContour([
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
  ]),
  [
    [0, 0],
    [0, 0],
    [0, 0],
  ],
);

// T5: equal coord on an axis, UNEQUAL deltas → 0 on that axis; the other axis
// still interpolates. (p0/p2 share x=50; p1.dx must be 0, p1.dy lerps 5→25.)
expect(
  'T5 equal-coord unequal-delta',
  runContour([
    { x: 50, y: 0, dx: 10, dy: 5 },
    { x: 50, y: 50 },
    { x: 50, y: 100, dx: 20, dy: 25 },
  ]),
  [
    [10, 5],
    [0, 15],
    [20, 25],
  ],
);

// Metric phantom points are independent of outline-contour interpolation.
{
  const dx = new Float64Array(7),
    dy = new Float64Array(7),
    touched = new Uint8Array(7),
    ox = new Float64Array(7),
    oy = new Float64Array(7);
  dx[3] = 20;
  dy[3] = -5;
  touched[3] = 1;
  inferIupDeltas(dx, dy, touched, ox, oy, [2], 3);
  if (Array.from(dx).join() !== '0,0,0,20,0,0,0' || Array.from(dy).join() !== '0,0,0,-5,0,0,0')
    fail('phantom deltas spread to untouched points');
}

console.log();
if (failures === 0) {
  console.log('GVAR-IUP PASS');
  process.exit(0);
}
console.log(`GVAR-IUP FAIL (${failures})`);
process.exit(1);
