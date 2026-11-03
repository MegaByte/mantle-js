// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcHalfTurnSmoke -- three things a morph must read right about an arc: a half turn at one pose, radii F.6.6 scales, and a pose that outgrows both ends.
//
// A half turn: the large-arc flag read back from float32 angles is rounding, and a semicircle shrinking its chord would draw as the big complement
// of its circle on whichever pose the bit falls that way. Scaled radii: a band break value that bounds the radii as authored stops the fill's walk short
// of an eccentric arc (at every t, t = 0 included), and the picture loses the arc. A large arc that stands taller between its poses than at either must not
// be cropped by the static cover quad. Here, the numbers behind those pictures.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
import { sampleMorphPose } from '../src/core/morphPose.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path id="p" d="${d}" fill="#f00"/></svg>`;
const opts = { preserveViewport: true, retainSource: true };
const { gl } = createFakeGl();
const morphOf = async (a, b) =>
  createShapeMorph(
    gl,
    createBundle(gl, await importSvg(svg(a), opts)),
    createBundle(gl, await importSvg(svg(b), opts)),
    { cpuLerp: true },
  );
const sweepAt = (morph, off, t) => {
  morph.setT(t);
  const c = sampleMorphPose(morph.bundle).curve;
  return Math.abs(c[off + 9] - c[off + 8]);
};

// The chord shrinks under one radius, the flags say small: under pi at every pose between. Across many start points, because the bit is rounding.
let misread = 0,
  n = 0;
for (let x0 = 20; x0 < 60; x0 += 1.37)
  for (const [from, to] of [
    [`M${x0} 64A24 24 0 0 1 ${x0 + 48} 64Z`, `M${x0 + 20} 64A24 24 0 0 1 ${x0 + 28} 64Z`],
    [`M${x0 + 20} 64A24 24 0 0 1 ${x0 + 28} 64Z`, `M${x0} 64A24 24 0 0 1 ${x0 + 48} 64Z`],
    [`M${x0} 64A24 24 0 0 1 ${x0 + 48} 64Z`, `M${x0 + 48} 64A24 24 0 0 1 ${x0} 64Z`],
  ]) {
    const m = await morphOf(from, to),
      off = m.bundle._morphSrc.arcOffsets[0];
    assert.ok(off > 0, 'the premise: the arc is morphed in endpoint form');
    for (const t of [0.25, 0.75]) {
      n++;
      if (sweepAt(m, off, t) > Math.PI + 1e-3) misread++;
    }
    m.dispose();
  }
assert.equal(misread, 0, `${misread} of ${n} poses of a small arc took the large one`);
// A half turn facing a large arc takes its flag.
{
  const m = await morphOf('M40 64A24 24 0 1 1 88 64Z', 'M60 64A12 12 0 1 1 68 64Z'),
    off = m.bundle._morphSrc.arcOffsets[0];
  assert.ok(
    sweepAt(m, off, 0.5) > Math.PI,
    'a half turn facing a large arc is the large arc between them',
  );
  m.dispose();
}
// Both poses half turns, authored large: the record says so, and a pose between with a shorter chord is the large arc.
{
  const m = await morphOf('M40 64A24 24 0 1 1 88 64Z', 'M88 64A24 24 0 1 1 40 64Z'),
    off = m.bundle._morphSrc.arcOffsets[0];
  assert.ok(
    sweepAt(m, off, 0.25) > Math.PI,
    'two half turns authored large are the large arc between them',
  );
  m.dispose();
}
console.log(`  ok ${n} poses of a half-turn morph stay on the arc the path names`);

// The H band's break value for the arc reaches the arc at every pose.
const breaksFor = (m, off) => {
  const b = m.bundle.bandFloats || new Float32Array(m.bundle.bands),
    loc = off / 4,
    hits = [];
  for (let i = 0; i + 3 < b.length; i += 4) if (b[i] === loc && b[i + 1] !== 0) hits.push(b[i + 1]);
  return hits.slice(-2); // the rewritten region is last: H entry, V entry
};
for (const [name, a, b, wantX] of [
  [
    'bulging right',
    'M30 54A8 1 0 0 1 30 64L20 64L20 54Z',
    'M30 50A8 1 0 0 1 30 62L20 62L20 50Z',
    70,
  ],
  [
    'a radius growing out of zero',
    'M30 54A0 8 0 0 1 30 64L20 64L20 54Z',
    'M30 50A8 8 0 0 1 30 62L20 62L20 50Z',
    38,
  ],
]) {
  const m = await morphOf(a, b),
    ms = m.bundle._morphSrc,
    off = ms.arcOffsets[0];
  assert.ok(off > 0, `${name}: the premise`);
  const [hBreak] = breaksFor(m, off);
  assert.ok(
    hBreak >= wantX,
    `${name}: the break value ${hBreak} stops short of the arc's ${wantX}`,
  );
  m.dispose();
  console.log(`  ok ${name}: break ${hBreak} at or past ${wantX}`);
}
// The large arc of one radius stands taller between its poses than at either: the cover quad reaches it.
{
  const m = await morphOf('M40 64A24 24 0 1 1 88 64Z', 'M60 64A12 12 0 1 1 68 64Z');
  const q = m.bundle.coverQuadFloats || new Float32Array(m.bundle.curveGeom);
  let top = Infinity;
  for (let v = 0; v < q[0]; v++) top = Math.min(top, q[12 + v * 12 + 1]);
  m.setT(0.25);
  const bb = sampleMorphPose(m.bundle).meta;
  assert.ok(top <= bb[1], `the cover quad's top ${top} crops the pose's top ${bb[1]}`);
  m.dispose();
  console.log(`  ok the cover quad's top ${top} holds the pose's ${bb[1]}`);
}
// A morph with no arc past its poses keeps the union of its two poses for a cover.
{
  const m = await morphOf(
    'M40 64A24 24 0 0 1 88 64L88 80L40 80Z',
    'M40 64A24 24 0 0 1 88 64L88 80L40 80Z',
  );
  const q = m.bundle.coverQuadFloats || new Float32Array(m.bundle.curveGeom);
  let top = Infinity;
  for (let v = 0; v < q[0]; v++) top = Math.min(top, q[12 + v * 12 + 1]);
  assert.ok(Math.abs(top - 40) < 1e-3, `an arc that does not move keeps its cover (${top})`);
  m.dispose();
}
// Radii that hold their chord are not touched: the walk keeps its early stop.
{
  const m = await morphOf('M40 64A30 30 0 0 1 88 64Z', 'M44 64A32 32 0 0 1 84 64Z'),
    off = m.bundle._morphSrc.arcOffsets[0];
  const [hBreak] = breaksFor(m, off);
  assert.ok(hBreak <= 88 + 64 + 1e-3, `an ordinary arc keeps its break (${hBreak})`);
  m.dispose();
}
console.log('morphArcHalfTurnSmoke: PASS');
