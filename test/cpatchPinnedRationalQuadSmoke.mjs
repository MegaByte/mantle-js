// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchPinnedRationalQuadSmoke -- an explicitly pinned CPatch build must pack rational-quadratic (native arc) shapes.
//
// THE TRAP. The prepared static-program pack returns null for any segment that is not a line, quad or cubic, so on that pack
// alone a native-arc circle (rquad segments) packs nothing under a CPatch pin: awaitEngine(bundle, 'cpatch') resolves false and
// the pinned engine never draws. Only the auto policy may decline an uncertified paint; a pin falls back to the general pack.
// A tree without that fallback FAILS: the pinned pack of a four-piece rquad circle is null.
import assert from 'node:assert/strict';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';

const w = Math.SQRT1_2;
const circle = () => [
  [
    {
      t: 'rquad',
      P: [
        [26, 16],
        [26, 6],
        [16, 6],
      ],
      w,
    },
    {
      t: 'rquad',
      P: [
        [16, 6],
        [6, 6],
        [6, 16],
      ],
      w,
    },
    {
      t: 'rquad',
      P: [
        [6, 16],
        [6, 26],
        [16, 26],
      ],
      w,
    },
    {
      t: 'rquad',
      P: [
        [16, 26],
        [26, 26],
        [26, 16],
      ],
      w,
    },
  ],
];
const pinned = packCPatchShape(circle(), 0, { _preparedStaticProgram: true, pool: false });
assert(
  pinned && pinned.vertexCount > 0,
  'a pinned CPatch pack of a rational-quadratic circle draws',
);
const auto = packCPatchShape(circle(), 0, {
  _preparedStaticProgram: true,
  pool: false,
  autoPolicy: true,
});
assert.equal(auto, null, 'the auto policy may still decline an uncertified paint');
console.log('cpatchPinnedRationalQuadSmoke PASS');
