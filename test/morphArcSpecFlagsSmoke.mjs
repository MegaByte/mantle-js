// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcSpecFlagsSmoke -- SVG 2, 9.3.2 on an arc morph: "Flags and booleans must be interpolated as fractions between zero and one, with any non-zero
// value considered to be a value of one/true." A flag that differs between the poses is 1 at every pose between them, each flag for itself; only the exact
// end whose own flag is 0 has 0. compat: 'chrome' steps each flag at t = 0.5, where Chrome's d animation does (Chrome 147, CSS: 0 and 1 both read 1 there).
// CPU lerp, the GPU route's CPU twin, the hit pose and the native morph; a control-point lerp cannot draw it (arcMorphGate).
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
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path id="p" d="${d}" fill="#f00"/></svg>`;
const opts = { preserveViewport: true, retainSource: true };
const { gl } = createFakeGl();
const arc = (r, large, sweep) => `M30 64A${r} ${r} 0 ${large} ${sweep} 98 64Z`;
const flagsOf = (plane, off) => {
  const dth = plane[off + 9] - plane[off + 8];
  return [Math.abs(dth) > Math.PI ? 1 : 0, dth > 0 ? 1 : 0];
};
const at = (from, to, t, compat) =>
  from.map((f, i) => {
    if (t === 0) return f;
    if (t === 1) return to[i];
    if (compat !== 'chrome') return f || to[i] ? 1 : 0;
    return f + (to[i] - f) * t >= 0.5 ? 1 : 0;
  });
const POSES = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1];
let checked = 0;
for (const [from, to, r0, r1] of [
  [[0, 1], [0, 0], 40, 40],
  [[0, 0], [0, 1], 40, 40],
  [[1, 1], [0, 1], 40, 40],
  [[0, 1], [1, 1], 40, 40],
  [[1, 0], [0, 1], 40, 40],
  [[0, 1], [1, 0], 40, 40],
  [[0, 0], [1, 1], 40, 40],
  [[0, 0], [1, 1], 36, 60],
  [[0, 1], [0, 0], 60, 36],
]) {
  const name = `${from} to ${to}, radii ${r0} and ${r1}`,
    a = arc(r0, ...from),
    b = arc(r1, ...to);
  for (const compat of [undefined, 'chrome'])
    for (const route of ['cpu', 'gpu']) {
      const A = createBundle(gl, await importSvg(svg(a), opts)),
        B = createBundle(gl, await importSvg(svg(b), opts));
      const morph = createShapeMorph(gl, A, B, { cpuLerp: route === 'cpu', compat });
      const ms = morph.bundle._morphSrc;
      if (route === 'gpu') ms.gpuSmallPlanes = true;
      const off = ms.arcOffsets[0];
      assert.ok(arcMorphNeedsCpuLerp(ms), `${name}: a control-point lerp cannot draw this`);
      let upload = null;
      const texSub = gl.texSubImage2D;
      gl.texSubImage2D = (...args) => {
        const d = args[args.length - 1];
        if (d instanceof Float32Array && d.length > off + 12 && args[4] === 4096)
          upload = d.slice();
        return texSub.apply(gl, args);
      };
      // t = 0 needs a pose before it, or setT skips
      for (const t of POSES) {
        upload = null;
        morph.setT(t);
        const want = at(from, to, t, compat),
          label = `${name}, ${compat || 'spec'}, ${route}, t = ${t}`;
        assert.deepEqual(
          flagsOf(sampleMorphPose(morph.bundle).curve, off),
          want,
          `${label}: the hit pose`,
        );
        // the GPU route's interior poses go through the fixup pass, whose inputs are the planes; only a stepping flag or an end pose comes through this upload
        if (upload && (route === 'cpu' || compat === 'chrome' || t === 0 || t === 1))
          assert.deepEqual(flagsOf(upload, off), want, `${label}: the curve plane`);
        else if (route === 'gpu' && t > 0 && t < 1)
          assert.equal(
            ms.srcEpCurveF32[off + 11],
            ms.dstEpCurveF32[off + 11],
            `${label}: one flag value in both planes`,
          );
        if (route === 'gpu' && !compat && t > 0 && t < 1)
          assert.equal(
            ms.srcEpCurveF32[off + 11],
            want[0] | (want[1] << 1),
            `${label}: the fixup pass's flags`,
          );
        checked++;
      }
      gl.texSubImage2D = texSub;
      morph.dispose();
    }
  for (const compat of [undefined, 'chrome']) {
    const native = createNativeMorph(await importSvg(svg(a), opts), await importSvg(svg(b), opts), {
      compat,
    });
    for (const t of POSES) {
      native.setT(t);
      const d = native.bundle.__streamPathD
        ? native.bundle.__streamPathD[0]
        : native.overrides.get(0).pathD;
      const m = /A\S+ \S+ \S+ ([01]) ([01]) /.exec(d),
        want = at(from, to, t, compat);
      assert.deepEqual(
        [+m[1], +m[2]],
        want,
        `${name}, ${compat || 'spec'}, native, t = ${t} (${d})`,
      );
      checked++;
    }
    native.dispose();
  }
}
console.log(`morphArcSpecFlagsSmoke PASS (${checked} poses)`);
process.exit(0);
