// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Development comparison with the JS shader distance model; this does not execute on a GPU.
import assert from 'node:assert/strict';
import { pointOnStroke } from '../src/hitTest/curveGeom.js';
import { minDist, makeStrokeCases, pixels } from './_strokeShapeRef.mjs';
let comparisons = 0,
  disagreements = 0;
for (const cs of makeStrokeCases()) {
  const hs = cs.segs.map((s) => ({
    t: 0,
    x0: s.a[0],
    y0: s.a[1],
    x1: s.b[0],
    y1: s.b[1],
    f: false,
    sd: 0,
    freeS: s.freeStart,
    freeE: s.freeEnd,
    itx: s.inTan[0],
    ity: s.inTan[1],
    otx: s.outTan[0],
    oty: s.outTan[1],
    kSS: 0,
    kSE: 0,
    kPE: 0,
    kNS: 0,
  }));
  const pairs = cs.closed
    ? [[cs.cap, cs.cap]]
    : Array.from({ length: 9 }, (_, i) => [Math.floor(i / 3), i % 3]);
  for (const [sc, ec] of pairs)
    for (const c of pixels(cs)) {
      const hit = pointOnStroke(
        hs,
        c[0],
        c[1],
        cs.halfW,
        sc,
        cs.joinStyle,
        cs.miterLimit,
        null,
        0,
        ec,
      );
      const painted =
        minDist('fixed', c, cs.segs, cs.halfW, sc, cs.joinStyle, cs.miterLimit, ec).minD <=
        cs.halfW;
      comparisons++;
      if (hit !== painted) disagreements++;
    }
}
assert.equal(
  disagreements,
  0,
  `CPU hit test / shader model disagreements in ${comparisons} comparisons`,
);
console.log(`HIT-STROKE-SHADER-MODEL PASS (${comparisons} comparisons; development diagnostic)`);
