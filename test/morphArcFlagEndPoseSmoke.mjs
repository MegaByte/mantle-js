// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcFlagEndPoseSmoke -- an arc whose two poses disagree on sweep lands on each pose at t = 0 and t = 1.
//
// The flags cannot ride the lerp, so one pose's are held across the morph (core/morphCore.js holdArcFlags), but not at the ends: there a smile to a frown
// on one radius would stay a smile at t = 1, and with a fatter destination the source would be drawn as its mirror image at t = 0. CPU lerp, the GPU route's
// CPU twin, the hit pose and the native morph.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
import { sampleMorphPose } from '../src/core/morphPose.js';
import { createNativeMorph } from '../src/fallback/nativeMorph.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="p" d="${d}" fill="#f00"/></svg>`;
const opts = { preserveViewport: true, retainSource: true };
const { gl } = createFakeGl();
const sections = async (d) => importSvg(svg(d), opts);
const sweepOf = (plane, off) => Math.sign(plane[off + 9] - plane[off + 8]);
let checked = 0;
for (const [from, to, name] of [
  ['M10 50 A20 20 0 0 1 50 50 Z', 'M10 50 A20 20 0 0 0 50 50 Z', 'one radius'],
  ['M10 50 A20 20 0 0 1 50 50 Z', 'M10 50 A40 40 0 0 0 50 50 Z', 'a fatter destination'],
  ['M10 50 A40 40 0 0 1 50 50 Z', 'M10 50 A20 20 0 0 0 50 50 Z', 'a fatter source'],
]) {
  for (const route of ['cpu', 'gpu']) {
    const A = createBundle(gl, await sections(from)),
      B = createBundle(gl, await sections(to));
    const morph = createShapeMorph(gl, A, B, route === 'cpu' ? { cpuLerp: true } : undefined);
    const ms = morph.bundle._morphSrc;
    if (route === 'gpu') ms.gpuSmallPlanes = true;
    const off = ms.arcOffsets[0];
    assert.ok(off > 0, 'the premise: the arc is morphed in endpoint form');
    assert.equal(sweepOf(ms.mergedCurveF32, off), 1);
    assert.equal(sweepOf(ms.dstCurveF32, off), -1);
    let upload = null;
    const texSub = gl.texSubImage2D;
    gl.texSubImage2D = (...a) => {
      const d = a[a.length - 1];
      if (d instanceof Float32Array && d.length > off + 12 && a[4] === 4096) upload = d.slice();
      return texSub.apply(gl, a);
    };
    for (const t of [1, 0]) {
      upload = null;
      morph.setT(t === 0 ? 0.5 : 1);
      if (t === 0) {
        upload = null;
        morph.setT(0);
      }
      const want = t === 0 ? ms.mergedCurveF32 : ms.dstCurveF32;
      assert.ok(upload, `${name}, ${route}: t = ${t} uploaded the curve plane`);
      for (let k = 4; k < 12; k++)
        assert.ok(
          Math.abs(upload[off + k] - want[off + k]) < 1e-5,
          `${name}, ${route}: t = ${t}, arc field ${k}: ${upload[off + k]} and ${want[off + k]}`,
        );
      const pose = sampleMorphPose(morph.bundle);
      for (let k = 4; k < 12; k++)
        assert.ok(
          Math.abs(pose.curve[off + k] - want[off + k]) < 1e-5,
          `${name}: the hit pose at t = ${t}, arc field ${k}`,
        );
      checked++;
    }
    gl.texSubImage2D = texSub;
    morph.dispose();
  }
  const native = createNativeMorph(await sections(from), await sections(to));
  const dAt = (t) => {
    native.setT(t);
    return native.bundle.__streamPathD
      ? native.bundle.__streamPathD[0]
      : native.overrides.get(0).pathD;
  };
  const [start, end] = [dAt(0), dAt(1)];
  assert.match(
    start,
    /A\S+ \S+ \S+ [01] 1 /,
    `${name}: the native source keeps its sweep (${start})`,
  );
  assert.match(
    end,
    /A\S+ \S+ \S+ [01] 0 /,
    `${name}: the native destination has its own sweep (${end})`,
  );
  native.dispose();
  checked++;
}
console.log(`morphArcFlagEndPoseSmoke PASS (${checked} end poses)`);
process.exit(0);
