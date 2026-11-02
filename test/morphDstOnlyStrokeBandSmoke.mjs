// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphDstOnlyStrokeBandSmoke -- a stroke only the destination has keeps its band pad in the morph.
//
// The importer widens a segment's break value by the stroke's reach, and the band walk trusts it. A morph rebuilds a destination-only row's bands in its own plane, and without
// that pad the walk stops short of a square cap's corner: at t = 1 the corner is gone, where the destination drawn alone has it.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const opts = { preserveViewport: true, retainSource: true };
const { gl } = createFakeGl();
const STROKE =
  '<path id="b" fill="none" stroke="#000" stroke-width="14" stroke-linecap="square" d="M60 90L110 40"/>';
const A = createBundle(
  gl,
  await importSvg(svg('<path id="a" fill="#36c" d="M10 10H40V40H10Z"/>'), opts),
);
const B = createBundle(
  gl,
  await importSvg(svg('<path id="a" fill="#36c" d="M12 12H44V44H12Z"/>' + STROKE), opts),
);
const m = createShapeMorph(gl, A, B);
// The largest finite break in a band plane's last entries is the destination-only line's H entry, whatever its address.
const breaks = (b) => {
  const f = b.bandFloats || new Float32Array(b.bands);
  let hi = -Infinity;
  for (let i = 0; i + 3 < f.length; i += 4)
    if (f[i + 3] === 0 && f[i + 1] > hi && f[i + 1] < 1e6) hi = f[i + 1];
  return hi;
};
const own = breaks(B),
  merged = breaks(m.bundle);
assert.ok(own > 110, `the premise: the destination's own break ${own} stands past the line's end`);
assert.ok(
  merged >= own - 1e-3,
  `the morph's break ${merged} stops short of the destination's ${own}`,
);
m.dispose();
console.log('morphDstOnlyStrokeBandSmoke: PASS');
