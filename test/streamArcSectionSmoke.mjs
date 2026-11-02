// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamArcSectionSmoke — a streamed section made of arcs gets an analytic mesh.
//
// A lightweight (_lbStream) bundle has no cover quads, so a section that becomes a slug sentinel draws nothing. Arcs
// must not be refused (contoursFromSegs returning null), and a half disc must not read as "zero area" from the chord
// alone. An arc streams as the rational quads the decoder makes of it; a zero-radius arc is its chord.
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { createBundle, buildStreamableSections, updateBundleGeometry } from '../src/index.js';
import { mkLine } from '../src/primitives/seg.js';
import { mkArc } from '../src/svg/segment.js';

let failures = 0;
const check = (c, m) => {
  if (c) console.log('ok ' + m);
  else {
    failures++;
    console.error('FAIL: ' + m);
  }
};
const { gl } = makeFakeWebgl2(120, 120);
const rect = (x, y, w, h) => [
  mkLine([x, y], [x + w, y]),
  mkLine([x + w, y], [x + w, y + h]),
  mkLine([x + w, y + h], [x, y + h]),
  mkLine([x, y + h], [x, y]),
];
const half = [
  mkArc(60, 60, 20, 20, Math.PI, 2 * Math.PI, 0, 0, 1, [40, 60], [80, 60]),
  mkLine([80, 60], [40, 60]),
];
const circle = [
  mkArc(60, 60, 20, 20, 0, Math.PI, 0, 0, 1, [80, 60], [40, 60]),
  mkArc(60, 60, 20, 20, Math.PI, 2 * Math.PI, 0, 0, 1, [40, 60], [80, 60]),
];
const flat = [
  mkArc(60, 60, 0, 20, 0, Math.PI, 0, 0, 1, [60, 40], [60, 80]),
  mkLine([60, 80], [60, 40]),
];
const run = (shape) => {
  const init = [
    { segs: rect(10, 45, 30, 30), fill: [1, 0, 0, 1] },
    { segs: shape, fill: [0, 0, 1, 1] },
  ];
  const b = createBundle(
    gl,
    buildStreamableSections(init, [0, 0, 120, 120], { lightweight: true }),
  );
  const r = updateBundleGeometry(gl, b, [init[0].segs, shape], {
    fills: [
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ],
  });
  return { r, m: b._lbMeshes };
};
for (const [name, shape, want] of [
  ['half disc', half, true],
  ['circle of two arcs', circle, true],
  ['zero-radius arc (a line)', flat, false],
]) {
  const { r, m } = run(shape);
  const served = !!(m && m[1] && !m[1].slug && m[1].vertexCount > 0);
  check(
    r.ok && served === want,
    `${name}: ${want ? 'has an analytic mesh' : 'draws nothing, as a zero-area shape does'} (${served ? m[1].vertexCount + ' vertices' : 'sentinel'})`,
  );
}
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('\nstreamArcSectionSmoke: passed');
