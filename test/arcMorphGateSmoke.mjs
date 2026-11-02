// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcMorphGateSmoke -- the arc-morph route gate: a morph whose poses change an arc's rotation (the number: turning by pi still spins), flags, change its authored radius-scale factor or change its
// radii ratio lerps control points differently from SVG's arc interpolation, so it takes the CPU-lerp route; a circle that only grows, a pure translation and a
// morph with no arcs stay on the GPU lerp. Pure: angles and ratios.
import { arcMorphNeedsCpuLerp } from '../src/renderer/arcMorphGate.js';
let bad = 0;
const ok = (c, m) => {
  if (!c) {
    bad++;
    console.error('FAIL', m);
  }
};
const arc = (rx, ry, phi, rs) => {
  const a = new Float32Array(12);
  a[6] = rx;
  a[7] = ry;
  a[10] = phi;
  a[11] = rs;
  return a;
};
const ms = (a, b) => ({ arcOffsets: [0], mergedCurveF32: a, dstCurveF32: b });
ok(
  !arcMorphNeedsCpuLerp(null) &&
    !arcMorphNeedsCpuLerp({}) &&
    !arcMorphNeedsCpuLerp({ arcOffsets: [] }),
  'no arcs',
);
ok(!arcMorphNeedsCpuLerp(ms(arc(10, 10, 0, 0), arc(40, 40, 0, 0))), 'circle grows');
ok(!arcMorphNeedsCpuLerp(ms(arc(10, 20, 0.3, 0), arc(40, 80, 0.3, 0))), 'same ratio, same angle');
ok(
  arcMorphNeedsCpuLerp(ms(arc(10, 20, 0.3, 0), arc(40, 80, 0.3 + Math.PI, 0))),
  'rotation by pi is the same ellipse, and it spins on its way there',
);
ok(arcMorphNeedsCpuLerp(ms(arc(10, 20, 0, 0), arc(10, 20, 0.5, 0))), 'rotates');
ok(arcMorphNeedsCpuLerp(ms(arc(10, 20, 0, 0), arc(10, 40, 0, 0))), 'ratio changes');
ok(arcMorphNeedsCpuLerp(ms(arc(10, 10, 0, 0), arc(10, 10, 0, 2))), 'radius-scale factor changes');
ok(!arcMorphNeedsCpuLerp(ms(arc(10, 10, 0, 2), arc(10, 10, 0, 2))), 'same factor');
const angles = (a, th0, th1) => {
  a[8] = th0;
  a[9] = th1;
  return a;
};
ok(
  arcMorphNeedsCpuLerp(ms(angles(arc(10, 10, 0, 0), 0, 1), angles(arc(10, 10, 0, 0), 0, 2))),
  'the sweep changes',
);
ok(
  arcMorphNeedsCpuLerp(
    ms(angles(arc(10, 10, 0, 0), 0, 1), angles(arc(10, 10, 0, 0), Math.PI, Math.PI + 1)),
  ),
  'the sweep starts elsewhere',
);
ok(
  !arcMorphNeedsCpuLerp(
    ms(angles(arc(10, 10, 0, 0), 0, 1), angles(arc(30, 30, 0, 0), 2 * Math.PI, 2 * Math.PI + 1)),
  ),
  'one start angle spelled a turn apart',
);
ok(
  arcMorphNeedsCpuLerp(ms(angles(arc(10, 10, 0, 0), 0, 4), angles(arc(10, 10, 0, 0), 0, -2.28))),
  'the flags change',
);
ok(arcMorphNeedsCpuLerp({ arcOffsets: [0] }), 'missing planes take the exact route');
if (bad) process.exit(1);
console.log('arcMorphGateSmoke ok');
