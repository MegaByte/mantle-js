// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { lbScene } from './_lbSceneData.mjs';
import {
  _setUcIdxLimitForTest,
  _setUcIdx32LimitForTest,
} from '../src/renderer/unifiedFillVerts.js';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 Q50 0 90 10 L90 90 Q50 100 10 90Z"/></svg>';
const normal = await lbScene(svg);
assert(normal.stream.defs.includes('MANTLE_LB_CURVE_TEX'));
try {
  // the 16-bit limit alone moves the scene to the 32-bit layout, still on the curve texture
  _setUcIdxLimitForTest(1);
  const wide32 = await lbScene(svg);
  assert(wide32.stream.defs.includes('MANTLE_LB_CURVE_TEX'));
  assert.equal(wide32.stream.stride, 14);
  assert.deepEqual(wide32.entryOfTri, normal.entryOfTri);
  // ...and both limits past the bundle take the wide float layout
  _setUcIdx32LimitForTest(1);
  const overflow = await lbScene(svg),
    wide = await lbScene(svg, { layout: 'wide' });
  assert(!overflow.stream.defs.includes('MANTLE_LB_CURVE_TEX'));
  assert.deepEqual(overflow.stream, wide.stream);
  assert.deepEqual(overflow.entryOfTri, wide.entryOfTri);
  console.log(
    'LB scene overflow fallback PASS: 32-bit layout past the 16-bit limit, exact wide stream and triangle ownership past both',
  );
} finally {
  _setUcIdxLimitForTest(0);
  _setUcIdx32LimitForTest(0);
}
