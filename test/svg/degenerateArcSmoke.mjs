// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { arcToNative, arcToCubics } from '../../src/svg/segment.js';
import { arcRecordToCenter } from '../../src/core/morphCore.js';

let failures = 0;
const EPS = 1e-5;
const nearPt = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const check = (label, condition) => {
  if (condition) console.log('ok', label);
  else {
    console.error('FAIL', label);
    failures++;
  }
};

const cases = [
  { p1: [0, 0], p2: [100, 100], rx: 0, ry: 20, phi: 0 },
  { p1: [5, 80], p2: [110, -10], rx: 20, ry: 0, phi: 0 },
  { p1: [-20, 15], p2: [70, 35], rx: 0, ry: 30, phi: 47 },
  { p1: [4, 9], p2: [90, -30], rx: 0, ry: 0, phi: 12 },
];

for (const [i, c] of cases.entries()) {
  const arc = arcToNative(c.p1, c.rx, c.ry, c.phi, 0, 1, c.p2);
  check(
    `native case ${i} preserves both chord endpoints`,
    nearPt(arc.p1, c.p1) && nearPt(arc.p4, c.p2),
  );

  const cubics = arcToCubics(c.p1, c.rx, c.ry, c.phi, 0, 1, c.p2);
  check(
    `cubic case ${i} preserves both chord endpoints`,
    nearPt(cubics[0].p1, c.p1) && nearPt(cubics[cubics.length - 1].p4, c.p2),
  );

  const b = new Float32Array(16);
  b[4] = c.p1[0];
  b[5] = c.p1[1];
  b[6] = c.p2[0];
  b[7] = c.p2[1];
  b[8] = c.rx;
  b[9] = c.ry;
  b[10] = (c.phi * Math.PI) / 180;
  b[11] = 2;
  arcRecordToCenter(b, 0);
  const cp = Math.cos(b[10]),
    sp = Math.sin(b[10]);
  const at = (t) => [
    b[4] + cp * b[6] * Math.cos(t) - sp * b[7] * Math.sin(t),
    b[5] + sp * b[6] * Math.cos(t) + cp * b[7] * Math.sin(t),
  ];
  check(
    `morph case ${i} preserves both chord endpoints`,
    nearPt(at(b[8]), c.p1) && nearPt(at(b[9]), c.p2),
  );
}

const point = arcToNative([3, 7], 0, 0, 0, 0, 1, [3, 7]);
check(
  'coincident zero-radius arc stays a point',
  nearPt(point.p1, [3, 7]) && nearPt(point.p4, [3, 7]),
);

console.log();
if (failures) {
  console.error(`DEGENERATE-ARC FAIL (${failures})`);
  process.exit(1);
}
console.log('DEGENERATE-ARC PASS');
