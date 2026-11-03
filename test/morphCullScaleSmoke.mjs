// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphCullScaleSmoke -- the morph cull's boundary certificate gives one answer at any scale.
//
// Two morphing segments that cross mid-morph must not certify. The shortcut for an edge shared for the whole morph must not compare points to an absolute 1e-9: at a
// small enough scale every pair of segments would read as coincident, and a shape an occluder exposes midway would be certified hidden and dropped from the draw list. CPU, on the certifier.
import assert from 'node:assert/strict';
import { certifyNoCross } from '../src/renderer/morphCull.js';
const line = (x0, y0, x1, y1) => ({ t: 0, x0, y0, x1, y1 });
for (const k of [1, 2 ** -10, 2 ** -20, 2 ** -30, 2 ** -40, 2 ** -60, 2 ** 20]) {
  // A sweeps down across B: above it at t = 0, below it at t = 1.
  const a0 = line(0, 10 * k, 10 * k, 10 * k),
    a1 = line(0, -10 * k, 10 * k, -10 * k),
    b = line(0, 0, 10 * k, 0);
  assert.equal(
    certifyNoCross(a0, a1, b, b),
    false,
    `scale ${k}: segments that cross mid-morph do not certify`,
  );
  // The shared edge still certifies, at every scale.
  const s0 = line(k, 2 * k, 7 * k, 3 * k),
    s1 = line(2 * k, 5 * k, 9 * k, 4 * k);
  assert.equal(
    certifyNoCross(s0, s1, { ...s0 }, { ...s1 }),
    true,
    `scale ${k}: an edge shared for the whole morph certifies`,
  );
}
console.log('morphCullScaleSmoke PASS');
