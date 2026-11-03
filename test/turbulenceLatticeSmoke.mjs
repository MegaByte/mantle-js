// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Production CPU lattice packing against the independent Filter Effects reference algorithm.
import assert from 'node:assert/strict';
import { turbulenceLattice, packLatticeTexels } from '../src/filterGraph/turbulenceLattice.js';
import { specInit } from './_turbulenceSpecOracle.mjs';
for (const seed of [0, 1, 42, -7, 3.9, -2.5, 2147483647, 4294967296]) {
  const spec = specInit(Math.trunc(seed)),
    mine = turbulenceLattice(seed),
    tex = packLatticeTexels(mine);
  for (let m = 0; m < 256; m++) {
    assert.equal(mine.selector[m], spec.uLatticeSelector[m]);
    assert.equal(tex[m * 4], spec.uLatticeSelector[m]);
    for (let c = 0; c < 4; c++) {
      const g = spec.fGradient[c][spec.uLatticeSelector[m]];
      assert.ok(Number.isFinite(g[0]) && Number.isFinite(g[1]));
      assert.ok(Math.abs(tex[(256 + m) * 4 + c] - g[0]) <= 6e-8);
      assert.ok(Math.abs(tex[(512 + m) * 4 + c] - g[1]) <= 6e-8);
    }
  }
}
const same = (a, b) =>
  turbulenceLattice(a).selector.every((v, i) => v === turbulenceLattice(b).selector[i]);
assert.ok(same(0, 1) && same(3.9, 3) && same(-2.5, 3) && same(-2, 3) && !same(4, 3));
console.log('TURBULENCE-LATTICE PASS');
