// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbCombineGolden.mjs — combined-VBO (depth-claim ordinal bake) parity golden.
// Packs shapes, assigns per-shape color + draw order, replicates the morphDraw
// combined builder, emits the combined VBO for byte-diff against BuildCombinedLbVbo.
import { writeFileSync } from 'fs';
import { buildLoopBlinnPartition } from '../src/renderer/lbPartition.js';
import { packLoopBlinnMesh, LB_VERT_FLOATS } from '../src/renderer/lbPack.js';
import { mkLine, mkQuad, mkCubic } from '../src/primitives/seg.js';

const RVF = LB_VERT_FLOATS + 5;
const shapes = [
  [
    [
      mkLine([0, 0], [30, 0]),
      mkLine([30, 0], [30, 30]),
      mkLine([30, 30], [0, 30]),
      mkLine([0, 30], [0, 0]),
    ],
  ],
  [
    [
      mkLine([0, 0], [30, 0]),
      mkQuad([30, 0], [42, 15], [30, 30]),
      mkLine([30, 30], [0, 30]),
      mkLine([0, 30], [0, 0]),
    ],
  ],
  [
    [
      mkCubic([0, 20], [8, 4], [22, 4], [30, 20]),
      mkLine([30, 20], [30, 30]),
      mkLine([30, 30], [0, 30]),
      mkLine([0, 30], [0, 20]),
    ],
  ],
];
const packed = shapes.map((c) =>
  packLoopBlinnMesh(buildLoopBlinnPartition(c, { fillRule: 'nonzero' })),
);
const colors = [
  [1, 0, 0, 1],
  [0, 0.5, 0.25, 0.8],
  [0.2, 0.4, 0.9, 1],
];
const order = [0, 2, 1]; // deliberately out of index order to exercise the ordinal

// replicate the morphDraw combined builder
let totalVerts = 0;
for (const s of order) totalVerts += packed[s].vertexCount;
const verts = new Float32Array(totalVerts * RVF);
let o = 0,
  ord9 = 0;
for (const s of order) {
  const m = packed[s],
    src = m.verts;
  const [r, g, bl, a] = colors[s];
  const kf9 = Math.min(ord9++, 2047) / 8192;
  for (let vi = 0; vi < m.vertexCount; vi++) {
    const si = vi * LB_VERT_FLOATS;
    for (let k = 0; k < LB_VERT_FLOATS; k++) verts[o + k] = src[si + k];
    verts[o + 5] = src[si + 5] + kf9;
    verts[o + 24] = r;
    verts[o + 25] = g;
    verts[o + 26] = bl;
    verts[o + 27] = a;
    verts[o + 28] = s;
    o += RVF;
  }
}

writeFileSync(
  new URL('../../csharp_tests/lb-parity/goldens/combine.json', import.meta.url),
  JSON.stringify({
    version: 1,
    shapes: shapes.map((shape) =>
      shape.map((contour) =>
        contour.map((s) => ({
          t: s.type,
          p1: s.p1,
          p2: s.p2 || null,
          p3: s.p3 || null,
          p4: s.p4 || null,
          w: s.w ?? null,
        })),
      ),
    ),
    colors,
    order,
    totalVerts,
    verts: Array.from(verts),
  }),
);
console.log('emitted combine golden:', totalVerts, 'verts,', totalVerts * RVF, 'floats');
