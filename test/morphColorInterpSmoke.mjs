// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphColorInterpSmoke -- colors and opacities interpolate the way CSS Color 4 and independent properties do:
//   * `fill` and `fill-opacity` are separate properties: red to blue at fill-opacity 0 is purple at half the opacity (128,0,128,128) at t = .5.
//   * a color with alpha 0 of its own (`transparent`, `rgba(0,0,255,0)`) has no hue to interpolate toward (premultiplied): red fades as red.
// The morph keeps a fully transparent paint as a row only for poses imported with keepInvisibleShapes (importer.js); the effective row color
// at t is the lerp of the two poses' rows (the renderer's lerp slots), so that is what is checked here.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createShapeMorph } from '../src/index.js';
console.warn = () => {};

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));
const doc = (attrs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect id="a" x="0" y="0" width="16" height="16" ${attrs}/></svg>`;
const TS = [0, 0.25, 0.5, 0.75, 1];

// The fill color of row 0 at t, as the renderer's lerp makes it: [r, g, b, a].
async function rowAt(a, b, opts) {
  const { gl } = makeFakeWebgl2(16, 16);
  const A = createBundle(gl, await importSvg(doc(a), opts)),
    B = createBundle(gl, await importSvg(doc(b), opts));
  const m = createShapeMorph(gl, A, B, { cpuLerp: true });
  const ms = m.bundle._morphSrc,
    st = ms.metaStride;
  return {
    n: m.bundle.numShapes,
    at: (t) => [4, 5, 6, 7].map((k) => ms.mergedMetaF32[k] * (1 - t) + ms.dstMetaF32[k] * t),
    st,
  };
}
const near = (g, w) => g.every((v, i) => Math.abs(v - w[i]) < 1e-6);
const KEEP = { keepInvisibleShapes: true };

{
  const r = await rowAt('fill="#ff0000"', 'fill="#0000ff" fill-opacity="0"', KEEP);
  check(r.n === 1, 'red to blue at fill-opacity 0 keeps one row');
  for (const t of TS) {
    const want = [1 - t, 0, t, 1 - t];
    check(
      near(r.at(t), want),
      `red -> blue fill-opacity 0, t=${t}: ${r.at(t).map((v) => +v.toFixed(3))} is ${want.map((v) => +v.toFixed(3))} (fill and fill-opacity interpolate separately)`,
    );
  }
}
for (const dst of ['rgba(0,0,255,0)', 'transparent']) {
  const r = await rowAt('fill="#ff0000"', `fill="${dst}"`, KEEP);
  for (const t of TS) {
    const want = [1, 0, 0, 1 - t];
    check(
      near(r.at(t), want),
      `red -> ${dst}, t=${t}: ${r.at(t).map((v) => +v.toFixed(3))} is ${want} (a color with alpha 0 has no hue: premultiplied)`,
    );
  }
  const back = await rowAt(`fill="${dst}"`, 'fill="#ff0000"', KEEP);
  for (const t of TS) check(near(back.at(t), [1, 0, 0, t]), `${dst} -> red, t=${t}: the hue holds`);
}
{
  // Both ends opaque colors, nothing transparent: a straight lerp.
  const r = await rowAt('fill="#ff0000"', 'fill="#0000ff"', KEEP);
  for (const t of TS) check(near(r.at(t), [1 - t, 0, t, 1]), `red -> blue opaque, t=${t}`);
  const o = await rowAt('fill="#ff0000"', 'fill="#ff0000" fill-opacity=".5"', KEEP);
  check(
    near(o.at(0.5), [1, 0, 0, 0.75]),
    'red -> red at fill-opacity .5: opacity lerps (.75 at t=.5)',
  );
}
if (failures) {
  console.error(`morphColorInterpSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nmorphColorInterpSmoke: color and opacity interpolate independently, a hueless color holds the other hue',
);
