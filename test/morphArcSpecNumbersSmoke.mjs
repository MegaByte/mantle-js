// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcSpecNumbersSmoke -- SVG 2, 9.3.2 on an arc morph: "each parameter to each path data command must be interpolated separately as real numbers".
// The x-axis-rotation is a number: 350 to 10 passes through 180, it does not take the short way; a pose spelling the same ellipse with its radii swapped at
// a quarter turn goes through a circle. A transform keeps the number (it does not fold it into a half turn either way). CPU lerp, the GPU route's CPU twin,
// the hit pose and the native morph. Rendered against Chrome in morphArcSpecRenderSmoke.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
import { sampleMorphPose } from '../src/core/morphPose.js';
import { createNativeMorph } from '../src/fallback/nativeMorph.js';
import { arcMorphNeedsCpuLerp } from '../src/renderer/arcMorphGate.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const svg = (d, wrap) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${wrap ? `<g transform="${wrap}">` : ''}<path id="p" d="${d}" fill="#f00"/>${wrap ? '</g>' : ''}</svg>`;
const opts = { preserveViewport: true, retainSource: true };
const { gl } = createFakeGl();
const arc = (rx, ry, rot) => `M30 64A${rx} ${ry} ${rot} 0 1 98 64Z`;
const RAD = Math.PI / 180;
let checked = 0;
for (const [a, b, wrap, turn, name] of [
  [[40, 12, 0], [40, 12, 90], '', 0, 'a quarter turn'],
  [[40, 12, 350], [40, 12, 10], '', 0, '350 to 10 is 340 apart'],
  [[40, 12, -170], [40, 12, 170], '', 0, '-170 to 170'],
  [[40, 12, 0], [40, 12, 360], '', 0, 'a whole turn'],
  [[40, 12, 0], [12, 40, 90], '', 0, 'the same ellipse with its radii swapped'],
  [[40, 12, 350], [40, 12, 10], 'scale(.75)', 0, 'under a scale'],
  [[40, 12, 300], [40, 12, 20], 'rotate(30 64 64)', 30, 'under a rotation'],
  [
    [40, 12, 170],
    [40, 12, 200],
    'translate(3 4) scale(2)',
    0,
    'across the half turn, under a transform',
  ],
]) {
  const from = arc(...a),
    to = arc(...b);
  for (const route of ['cpu', 'gpu']) {
    const A = createBundle(gl, await importSvg(svg(from, wrap), opts)),
      B = createBundle(gl, await importSvg(svg(to, wrap), opts));
    const morph = createShapeMorph(gl, A, B, route === 'cpu' ? { cpuLerp: true } : undefined);
    const ms = morph.bundle._morphSrc;
    if (route === 'gpu') ms.gpuSmallPlanes = true;
    const off = ms.arcOffsets[0];
    assert.ok(off > 0, `${name}: the arc is morphed in endpoint form`);
    assert.ok(
      arcMorphNeedsCpuLerp(ms) || a[2] === b[2],
      `${name}: a control-point lerp cannot draw this`,
    );
    for (const t of [0.25, 0.5, 0.75]) {
      morph.setT(t);
      const pose = sampleMorphPose(morph.bundle);
      const phi = (a[2] + (b[2] - a[2]) * t + turn) * RAD;
      assert.ok(
        Math.abs(pose.curve[off + 10] - phi) < 1e-4,
        `${name}, ${route}: the rotation at t = ${t} is ${pose.curve[off + 10] / RAD}, the numbers say ${phi / RAD}`,
      );
      const rx = a[0] + (b[0] - a[0]) * t,
        ry = a[1] + (b[1] - a[1]) * t;
      assert.ok(
        Math.abs(pose.curve[off + 6] / pose.curve[off + 7] - rx / ry) < 1e-3,
        `${name}, ${route}: the radii at t = ${t} are ${pose.curve[off + 6]} and ${pose.curve[off + 7]}, the numbers say ${rx} and ${ry}`,
      );
      checked++;
    }
    morph.dispose();
  }
  if (!wrap) {
    const native = createNativeMorph(
      await importSvg(svg(from), opts),
      await importSvg(svg(to), opts),
    );
    native.setT(0.25);
    const d = native.bundle.__streamPathD
      ? native.bundle.__streamPathD[0]
      : native.overrides.get(0).pathD;
    const m = /A(\S+) (\S+) (\S+) /.exec(d);
    assert.ok(
      m && Math.abs(+m[3] - (a[2] + (b[2] - a[2]) * 0.25)) < 1e-2,
      `${name}: the native morph's rotation (${d})`,
    );
    assert.ok(
      Math.abs(+m[1] - (a[0] + (b[0] - a[0]) * 0.25)) < 1e-2,
      `${name}: the native morph's rx (${d})`,
    );
    native.dispose();
    checked++;
  }
}
console.log(`morphArcSpecNumbersSmoke PASS (${checked} poses)`);
process.exit(0);
