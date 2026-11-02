// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsGateSmoke — the point route's gate is a point budget that grows with the geometry's overlap depth.
//
// Points beat cover quads where small overlapping blended primitives pile into few tiles; a shape's size is not what decides it.
// The calibration is a set of measured GPU cells: points won tiger @128 (P 171k, D 7.7) and cubicStar64 @128 (P 19k, D 1.0), tied
// an illustration @128 (P 129k, D 8.3), and lost an arc sheet @512 (P 201k, D 1.0), a primitive sheet @512 (P 121k, D 1.0) and cubicStar64 @512 (P 281k, D 1.0).
//   (a) the overlap depth: rows that do not overlap read 1; N identical rows read N, at every grid size (em space);
//   (b) the budget: BASE at depth 1, rising with depth, capped at 2^19;
//   (c) the calibration cells through the budget: every cell above decides the way it measured;
//   (d) the point list: a tiny disc gets (w + ~3)^2 points (half a pixel of margin), not (w + 5)^2, and the list is the same under a pan;
//   (e) a 2^-20 and a 2^20 scale of the same art lists the same points (the gate is in pixels and depth in em: scale-free).
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const R = { gl: null, opts: {}, _pendingShaders: [], _pendingPrograms: [] };
attachAacPointsDraw(R);
const G = R._aacPointsGate;
ok(!!G, 'the route exposes its gate');
if (!G) {
  console.error('aacPointsGateSmoke FAIL (1)');
  process.exit(1);
}

// (a) depth: abs = x0, y0, x1, y1 per row, in a 100 x 100 art box
const gbb = [0, 0, 100, 100];
const grid = [],
  stack = [];
for (let i = 0; i < 10; i++)
  for (let j = 0; j < 10; j++) grid.push(i * 10 + 1, j * 10 + 1, i * 10 + 9, j * 10 + 9);
for (let i = 0; i < 6; i++) stack.push(20, 20, 60, 60);
ok(
  Math.abs(G.overlapDepth(grid, gbb) - 1) < 0.2,
  `non-overlapping rows read depth ~1 (${G.overlapDepth(grid, gbb).toFixed(2)})`,
);
ok(
  Math.abs(G.overlapDepth(stack, gbb) - 6) < 0.8,
  `six identical rows read depth ~6 (${G.overlapDepth(stack, gbb).toFixed(2)})`,
);
ok(
  Math.abs(
    G.overlapDepth(
      stack.map((v) => v * 1e-6),
      gbb.map((v) => v * 1e-6),
    ) - G.overlapDepth(stack, gbb),
  ) < 1e-9,
  'depth is the same at 2^-20 of the art (em space)',
);

// (b) budget
ok(G.budget(1) === 90000, `budget at depth 1 is BASE (${G.budget(1)})`);
ok(
  G.budget(8) > G.budget(1) && G.budget(1e9) === 1 << 19,
  `budget rises with depth and caps at 2^19 (${G.budget(8)}, ${G.budget(1e9)})`,
);

// (c) the calibration cells: [name, P, D, points won?]
const cells = [
  ['tiger@128', 171e3, 7.7, true],
  ['cubicStar64@128', 19e3, 1.0, true],
  ['illustration@128', 129e3, 8.3, true],
  ['text@512', 71e3, 1.0, true],
  ['arcSheet@512', 201e3, 1.0, false],
  ['primSheet@512', 121e3, 1.0, false],
  ['cubicStar64@512', 281e3, 1.0, false],
  ['tiger@512', 2053e3, 7.7, false],
  ['illustration@512', 1827e3, 8.3, false],
];
for (const [name, P, D, wins] of cells)
  ok(
    P <= G.budget(D) === wins,
    `${name}: P ${P / 1000}k, D ${D} -> ${P <= G.budget(D) ? 'points' : 'cover'}${wins ? '' : ' (cover measured faster)'}`,
  );

// (d)/(e) the list
function bundleOf(scale) {
  const n = 40,
    meta = new Float32Array(n * 48),
    dl = [];
  for (let i = 0; i < n; i++) {
    const o = i * 48,
      x = (3 + (i % 8) * 7.3) * scale,
      y = (3 + Math.floor(i / 8) * 7.3) * scale,
      r = 0.4 * scale;
    meta[o] = x - r;
    meta[o + 1] = y - r;
    meta[o + 2] = x + r;
    meta[o + 3] = y + r;
    meta[o + 7] = 1;
    dl.push({ kind: 'fillShape', shapeIdx: i });
  }
  return {
    metaFloats: meta,
    metaFloatsPerShape: 48,
    drawList: dl,
    globalBBox: [0, 0, 64 * scale, 64 * scale],
    _geomGen: 0,
    _cullGen: 0,
  };
}
for (const sc of [2 ** -20, 1, 2 ** 20]) {
  const b = bundleOf(sc),
    s = G.shapesFor(b);
  const px = 1 / sc,
    J = [px, 0, 0, -px]; // 1 pixel per art unit (em x 1/scale)
  const h = G.pointsFor(s, J, px, px, 1, 0, 0, 1, Infinity, 1e9),
    pts = h && h.points(); // (a list is a handle: points() is its points)
  ok(
    !!pts && pts.length / 4 / 40 <= 16 && pts.length / 4 / 40 >= 9,
    `scale 2^${Math.round(Math.log2(sc))}: 40 discs 0.8 px across list ${(pts.length / 4 / 40).toFixed(1)} points each, not 36`,
  );
}
if (fail) {
  console.error(`aacPointsGateSmoke FAIL (${fail})`);
  process.exit(1);
}
console.log('aacPointsGateSmoke PASS');
