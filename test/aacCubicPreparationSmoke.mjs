// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {
  preparedMonotoneCubics as prep,
  monotoneCubicDrawEligible as eligible,
} from '../src/renderer/aacCubicPreparation.js';
let checks = 0;
const check = (v, msg) => {
  assert(v, msg);
  checks++;
};
const curve = (xs) =>
  new Float32Array([2, 0, 0, 0, ...xs.flatMap((x, i) => [x, i / 3]), 0, 0, 0, 0]);
const meta = new Float32Array(48);
const bundle = (A) => ({
  curveFloats: A,
  curveRangesByShape: [{ begin: 0, end: A.length }],
  numShapes: 1,
  metaFloats: meta,
  metaFloatsPerShape: 48,
});
const good = curve([0, 0, 1, 1]),
  bad = curve([0, 2, -1, 1]);
check(prep(bundle(good)), 'ordered controls');
check(!prep(bundle(bad)), 'loop decline');
check(prep(bundle(curve([1, 1, 0, 0]))), 'opposite coordinate directions');
check(!prep(bundle(good.subarray(0, 15))), 'truncated record');
const nan = good.slice();
nan[4] = NaN;
check(!prep(bundle(nan)), 'nonfinite');
const b = bundle(good);
check(prep(b), 'cached eligibility');
b.curveFloats = bad;
check(!prep(b), 'geometry identity invalidation');
b.curveFloats = good;
b._geomGen = 1;
check(!prep(b), 'mutable GPU mirror decline');
for (const flag of ['_disposed', '_lbStream', '_incStroke', '_nineSliceActive'])
  check(!prep({ ...bundle(good), [flag]: true }), flag);
check(eligible(bundle(good), {}), 'plain draw');
for (const M of [
  [1, 0.2, 0, 0, 1, 0, 0, 0, 1],
  [1, 0, 0.1, 0, 1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 2],
  [0, 0, 0, 0, 1, 0, 0, 0, 1],
])
  check(!eligible(bundle(good), { worldM: M }), 'unsupported map');
check(eligible(bundle(good), { worldM: [-2, 0, 0, 0, 3, 0, 4, 5, 1] }), 'axis reflection');
for (const at of [30, 31, 43]) {
  const m = meta.slice();
  m[at] = 1;
  check(!eligible({ ...bundle(good), metaFloats: m }, {}), 'secondary mapping');
}
const ve = meta.slice();
ve[27] = 1024;
check(!eligible({ ...bundle(good), metaFloats: ve }, {}), 'vector effect');
const ov = new Float32Array(24);
ov[0] = ov[3] = 1;
check(eligible(bundle(good), { overrides: ov }), 'visibility override');
ov[1] = 0.1;
check(!eligible(bundle(good), { overrides: ov }), 'rotated override');
const morph = (A, B) => ({
  ...bundle(A),
  _morphSrc: {
    mergedCurveF32: A,
    dstCurveF32: B,
    curveRanges: [{ begin: 0, end: A.length }],
    mergedMetaF32: meta,
    dstMetaF32: meta,
  },
});
const target = good.slice();
for (let i = 4; i < 12; i++) target[i] = Math.fround(target[i] * 1.5 + 0.125);
check(eligible(morph(good, target), {}), 'full interval with repeated edges');
const mutableMorph = morph(good, target);
check(prep(mutableMorph), 'initial certified morph');
mutableMorph._geomGen = 1;
check(!prep(mutableMorph), 'live geometry update invalidates a cached morph certificate');
check(!prep(morph(good, curve([1, 1, 0, 0]))), 'direction changes');
const close = curve([1, 1 + 2 ** -23, 1 + 2 ** -22, 2]);
check(!prep(morph(close, close)), 'strict nonzero gap below rounding margin');
const fade = { ...morph(good, target), numShapes: 2 };
fade._morphSrc.fixedCurveRanges = [null, { begin: 0, end: good.length }];
check(prep(fade), 'fixed fade interval');
const replace = morph(good, target);
check(prep(replace), 'initial morph');
replace._morphSrc = { ...replace._morphSrc, dstCurveF32: bad };
check(!prep(replace), 'morph source replacement');
console.log(`aacCubicPreparationSmoke PASS: ${checks} geometry/dispatch controls`);
