// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcRotationOptionSmoke -- arcRotation: 'shortest' is the opt-in for poses written with a running angle: the destination's ellipse is spelled the nearest way to the
// source's, so 350 to 10 passes through 0 and not 180. The default, and 'spec', lerp the numbers (SVG 2, 9.3.2). A morph, a shape timeline, a sprite timeline and a native
// timeline all take it, and compat: 'chrome' reaches the timelines too. Timelines over the same poses share a pair morph only when they agree on the options.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
import { createShapeTimeline, createSpriteTimeline } from '../src/animation/shapeAnimation.js';
import { sampleMorphPose } from '../src/core/morphPose.js';
import { createNativeMorph, createNativeTimeline } from '../src/fallback/nativeMorph.js';
import { arcMorphNeedsCpuLerp } from '../src/renderer/arcMorphGate.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const path = (d) => svg(`<path id="p" d="${d}" fill="#f00"/>`);
const opts = { preserveViewport: true, retainSource: true };
const { gl } = createFakeGl();
const bun = async (d) => createBundle(gl, await importSvg(path(d), opts));
const arc = (rx, ry, rot, flags = '0 1') => `M30 64A${rx} ${ry} ${rot} ${flags} 98 64Z`;
const RAD = Math.PI / 180;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-3, `${label}: ${a} and ${b}`);
const phiOf = (m) => {
  const ms = m.bundle._morphSrc;
  return sampleMorphPose(m.bundle).curve[ms.arcOffsets[0] + 10] / RAD;
};
const nativeD = (n) =>
  n.bundle.__streamPathD ? n.bundle.__streamPathD[0] : n.overrides.get(0).pathD;
let checked = 0;

// A morph: the rotation at t, on the CPU lerp and the GPU route's planes, and in the native morph's d.
for (const [a, b, wantSpec, wantShort, name] of [
  [arc(40, 12, 350), arc(40, 12, 10), 180, 360, '350 to 10'],
  [arc(40, 12, 0), arc(40, 12, 360), 180, 0, 'a whole turn'],
  [arc(40, 12, 0), arc(40, 12, 180), 90, 0, 'a half turn'],
  [arc(40, 12, 20), arc(40, 12, 40), 30, 30, 'twenty degrees: the two rules agree'],
]) {
  for (const [option, want] of [
    [undefined, wantSpec],
    ['spec', wantSpec],
    ['shortest', wantShort],
  ])
    for (const cpuLerp of [true, false]) {
      const m = createShapeMorph(gl, await bun(a), await bun(b), { cpuLerp, arcRotation: option });
      if (!cpuLerp) m.bundle._morphSrc.gpuSmallPlanes = true;
      m.setT(0.5);
      near(phiOf(m), want, `${name}, ${option}, cpuLerp ${cpuLerp}: the rotation at t = 0.5`);
      m.dispose();
      checked++;
    }
  for (const [option, want] of [
    [undefined, wantSpec],
    ['shortest', wantShort],
  ]) {
    const n = createNativeMorph(await importSvg(path(a), opts), await importSvg(path(b), opts), {
      arcRotation: option,
    });
    n.setT(0.5);
    const d = nativeD(n);
    near(+/A\S+ \S+ (\S+) /.exec(d)[1], want, `${name}, ${option}, native (${d})`);
    n.dispose();
    checked++;
  }
}
// The same ellipse with its radii swapped at a quarter turn: 'shortest' does not move it.
{
  const m = createShapeMorph(gl, await bun(arc(40, 12, 0)), await bun(arc(12, 40, 90)), {
    cpuLerp: true,
    arcRotation: 'shortest',
  });
  m.setT(0.5);
  const ms = m.bundle._morphSrc,
    off = ms.arcOffsets[0],
    c = sampleMorphPose(m.bundle).curve;
  near(c[off + 10], 0, 'radii swapped: the rotation');
  near(c[off + 6] / c[off + 7], 40 / 12, 'radii swapped: the radii');
  m.dispose();
  checked++;
}
// The route gate: a half turn is the same ellipse under 'shortest', so a mesh can draw it; under the numbers it spins.
{
  const pair = (th0, phi) => {
    const c = new Float32Array(20);
    c[6] = 10;
    c[7] = 20;
    c[8] = th0;
    c[9] = th0 + 1;
    c[10] = phi;
    return c;
  };
  const ms = (arcRotationShortest) => ({
    arcOffsets: [0],
    mergedCurveF32: pair(0.2, 0.3),
    dstCurveF32: pair(0.2 - Math.PI, 0.3 + Math.PI),
    arcRotationShortest,
  });
  assert.ok(
    arcMorphNeedsCpuLerp(ms(false)),
    'the numbers: a control-point lerp cannot draw a spin',
  );
  assert.ok(!arcMorphNeedsCpuLerp(ms(true)), 'shortest: the same ellipse, and a mesh draws it');
  checked++;
}
// A shape timeline.
{
  const A = await bun(arc(40, 12, 350)),
    B = await bun(arc(40, 12, 10));
  const keys = [
    { time: 0, bundleIndex: 0, interp: 'linear' },
    { time: 1, bundleIndex: 1, interp: 'linear' },
  ];
  const plain = createShapeTimeline(gl, [A, B], keys),
    plain2 = createShapeTimeline(gl, [A, B], keys);
  const short = createShapeTimeline(gl, [A, B], keys, { arcRotation: 'shortest' }),
    short2 = createShapeTimeline(gl, [A, B], keys, { arcRotation: 'shortest' });
  const steps = createShapeTimeline(gl, [A, B], keys, { compat: 'chrome' });
  for (const tl of [plain, plain2, short, short2, steps]) tl.setTime(0.5);
  near(phiOf(plain.currentMorph), 180, 'a timeline by default');
  near(phiOf(short.currentMorph), 360, 'a timeline with shortest');
  assert.equal(plain.currentMorph, plain2.currentMorph, 'two plain timelines share the pair');
  assert.equal(short.currentMorph, short2.currentMorph, 'two shortest timelines share the pair');
  assert.notEqual(plain.currentMorph, short.currentMorph, 'a timeline with other options does not');
  assert.notEqual(plain.currentMorph, steps.currentMorph, 'nor does compat');
  short.dispose();
  short2.setTime(0.25);
  near(phiOf(short2.currentMorph), 355, 'the pair outlives one of its users');
  for (const tl of [plain, plain2, short2, steps]) tl.dispose();
  checked++;
}
// compat: 'chrome' through a timeline: the flag steps at 0.5.
{
  const A = await bun(arc(40, 40, 0, '0 0')),
    B = await bun(arc(40, 40, 0, '0 1'));
  const keys = [
    { time: 0, bundleIndex: 0, interp: 'linear' },
    { time: 1, bundleIndex: 1, interp: 'linear' },
  ];
  const sweepAt = (tl, t) => {
    tl.setTime(t);
    const m = tl.currentMorph,
      off = m.bundle._morphSrc.arcOffsets[0],
      c = sampleMorphPose(m.bundle).curve;
    return c[off + 9] > c[off + 8] ? 1 : 0;
  };
  const spec = createShapeTimeline(gl, [A, B], keys),
    chrome = createShapeTimeline(gl, [A, B], keys, { compat: 'chrome' });
  assert.equal(sweepAt(spec, 0.25), 1, 'a timeline by default: the flag is 1 between the poses');
  assert.equal(sweepAt(chrome, 0.25), 0, 'compat chrome: 0 before the middle');
  assert.equal(sweepAt(chrome, 0.75), 1, 'compat chrome: 1 after it');
  spec.dispose();
  chrome.dispose();
  checked++;
}
// A sprite timeline.
{
  const sheet = createBundle(
    gl,
    await importSvg(
      svg(
        `<g id="a"><path id="p" d="${arc(40, 12, 350)}" fill="#f00"/></g><g id="b"><path id="p2" d="${arc(40, 12, 10)}" fill="#f00"/></g>`,
      ),
      opts,
    ),
  );
  const refs = [
    { bundle: sheet, sprite: 'a' },
    { bundle: sheet, sprite: 'b' },
  ];
  const keys = [
    { time: 0, refIndex: 0, interp: 'linear' },
    { time: 1, refIndex: 1, interp: 'linear' },
  ];
  const plain = createSpriteTimeline(gl, refs, keys),
    short = createSpriteTimeline(gl, refs, keys, { arcRotation: 'shortest' });
  plain.setTime(0.5);
  short.setTime(0.5);
  const off0 = plain.currentMorph.bundle._morphSrc.arcOffsets,
    off1 = short.currentMorph.bundle._morphSrc.arcOffsets;
  assert.ok(off0.length && off1.length, 'the sprite pair morphs its arc');
  near(phiOf(plain.currentMorph), 180, 'a sprite timeline by default');
  near(phiOf(short.currentMorph), 360, 'a sprite timeline with shortest');
  plain.dispose();
  short.dispose();
  checked++;
}
// A native timeline.
{
  const A = await importSvg(path(arc(40, 12, 350)), opts),
    B = await importSvg(path(arc(40, 12, 10)), opts);
  const keys = [
    { time: 0, bundleIndex: 0, interp: 'linear' },
    { time: 1, bundleIndex: 1, interp: 'linear' },
  ];
  for (const [o, want] of [
    [undefined, 180],
    [{ arcRotation: 'shortest' }, 360],
  ]) {
    const tl = createNativeTimeline([A, B], keys, o);
    const m = tl.setTime(0.5) || tl.currentMorph;
    const d = nativeD(m);
    near(
      +/A\S+ \S+ (\S+) /.exec(d)[1],
      want,
      `a native timeline, ${o ? 'shortest' : 'default'} (${d})`,
    );
    tl.dispose();
    checked++;
  }
}
console.log(`morphArcRotationOptionSmoke PASS (${checked} cases)`);
process.exit(0);
