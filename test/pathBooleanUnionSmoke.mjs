// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanUnionSmoke — end-to-end union path extraction.

import { mkLine } from '../src/svg/segment.js';
import { unionPaths } from '../src/svg/pathBoolean/union.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

// ----- 1. Single closed triangle → silhouette = the triangle -----
{
  const shapes = [
    {
      segs: [mkLine([0, 0], [10, 0]), mkLine([10, 0], [5, 10]), mkLine([5, 10], [0, 0])],
      fillRule: 'nonzero',
    },
  ];
  const sil = unionPaths(shapes);
  if (sil.length === 3) ok('single triangle: silhouette = 3 segments');
  else fail(`single triangle expected 3 segments, got ${sil.length}`);
}

// ----- 2. Two overlapping squares → silhouette = the union outline (~8 edges) -----
{
  // Square A: (0,0)-(10,10).
  // Square B: (5,5)-(15,15).
  // Union outline: starts at (0,0), goes right to (10,0), up to (10,5),
  // right to (15,5), up to (15,15), left to (5,15), down to (5,10),
  // left to (0,10), down to (0,0). 8 edges total.
  const shapeA = {
    segs: [
      mkLine([0, 0], [10, 0]),
      mkLine([10, 0], [10, 10]),
      mkLine([10, 10], [0, 10]),
      mkLine([0, 10], [0, 0]),
    ],
    fillRule: 'nonzero',
  };
  const shapeB = {
    segs: [
      mkLine([5, 5], [15, 5]),
      mkLine([15, 5], [15, 15]),
      mkLine([15, 15], [5, 15]),
      mkLine([5, 15], [5, 5]),
    ],
    fillRule: 'nonzero',
  };
  const sil = unionPaths([shapeA, shapeB]);
  if (sil.length >= 6 && sil.length <= 12) {
    ok(`two overlapping squares: silhouette has ${sil.length} segments (expected ~8)`);
  } else {
    fail(`overlap silhouette expected ~8 segments, got ${sil.length}`);
  }
}

// ----- 3. Two disjoint squares → silhouette has 2 separate cycles, 8 segments total -----
{
  const shapeA = {
    segs: [
      mkLine([0, 0], [5, 0]),
      mkLine([5, 0], [5, 5]),
      mkLine([5, 5], [0, 5]),
      mkLine([0, 5], [0, 0]),
    ],
    fillRule: 'nonzero',
  };
  const shapeB = {
    segs: [
      mkLine([10, 10], [15, 10]),
      mkLine([15, 10], [15, 15]),
      mkLine([15, 15], [10, 15]),
      mkLine([10, 15], [10, 10]),
    ],
    fillRule: 'nonzero',
  };
  const sil = unionPaths([shapeA, shapeB]);
  if (sil.length === 8) ok('two disjoint squares: silhouette = 8 segments (two cycles)');
  else fail(`disjoint expected 8, got ${sil.length}`);
}

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN UNION FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN UNION PASS');
