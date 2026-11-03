// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';
const R = { gl: null, opts: {}, _pendingShaders: [], _pendingPrograms: [] };
attachAacPointsDraw(R);
const fresh = () => ({
  rows: Uint16Array.of(0),
  paint: Uint8Array.of(1),
  box: Float64Array.of(0, 0, 4, 3, 4, 3),
  ext: Float32Array.of(4, 3),
  animated: true,
});
const s = fresh(),
  J = [2.7, 0, 0, 2.7];
const ask = (S) => R._aacPointsGate.pointsFor(S, J, 1, 1, J[0], 0, 0, J[3], Infinity, 1e6);
const bucketed = ask(s);
R.setFillPolicyOptions({ aacPointsBucket: false });
const exact = ask(s),
  reference = ask(fresh());
assert.deepEqual(
  exact.points(),
  reference.points(),
  'a policy change must replace the cached bucketed list',
); // (a list is a handle: points() is its points)
assert(exact.n < bucketed.n, 'test crosses the bucket-size boundary');
R.setFillPolicyOptions({ aacPointsBucket: true });
assert.equal(ask(s), bucketed, 'the previous bucket can be reused');
console.log('aacPointsPolicyToggleSmoke PASS');
