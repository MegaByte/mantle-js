// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphAliasResourceIdsSmoke -- a row of a rebuilt mask run reads the same resources as the row it mirrors.
//
// Alias rows (core/morphBindings.js) are copied from their origin row before the paint steps give that row its merged gradient, dash, filter and image ids.
// A destination-only mask child's alias must not keep the destination's own number, which in the merged tables is another paint: at t = 1 the mask would read the source's gradient.
// CPU, on the planes.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const G = (id, c) =>
  `<linearGradient id="${id}"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#000"/></linearGradient>`;
const A =
  svg(`<defs>${G('s', '#f00')}<mask id="m"><rect id="c1" x="0" y="0" width="50" height="50" fill="#fff"/></mask></defs>
  <rect id="own" x="60" y="60" width="20" height="20" fill="url(#s)" stroke="#000" stroke-width="1" stroke-dasharray="1 1"/>
  <rect id="art" x="0" y="0" width="100" height="100" fill="#0a0" mask="url(#m)"/>`);
const B =
  svg(`<defs>${G('d', '#00f')}<mask id="m"><rect id="c1" x="0" y="0" width="50" height="50" fill="#fff"/>
  <rect id="c2" x="50" y="50" width="40" height="40" fill="url(#d)" stroke="#fff" stroke-width="2" stroke-dasharray="3 3"/></mask></defs>
  <rect id="own" x="60" y="60" width="20" height="20" fill="#123"/>
  <rect id="art" x="0" y="0" width="100" height="100" fill="#0a0" mask="url(#m)"/>`);
const { gl } = createFakeGl();
const opts = { preserveViewport: true };
const morph = createShapeMorph(
  gl,
  createBundle(gl, await importSvg(A, opts)),
  createBundle(gl, await importSvg(B, opts)),
);
const b = morph.bundle,
  st = b.metaFloatsPerShape,
  m = b.metaFloats;
const aliases = b._morphBindingAliases || [];
let checked = 0,
  gradient = 0,
  dash = 0;
aliases.forEach((rows, origin) => {
  for (const row of rows) {
    for (const slot of [15, 28, 29, 32, 35, 47])
      assert.equal(
        m[row * st + slot],
        m[origin * st + slot],
        `alias ${row} of row ${origin}, slot ${slot}`,
      );
    if (m[origin * st + 28] > 0) gradient++;
    if (m[origin * st + 15] > 0) dash++;
    checked++;
  }
});
assert.ok(checked >= 2, 'the premise: the destination run was rebuilt from aliases');
assert.ok(
  gradient >= 1 && dash >= 1,
  `the premise: the aliases mirror a gradient (${gradient}) and a dash (${dash})`,
);
morph.dispose();
console.log(`morphAliasResourceIdsSmoke PASS (${checked} alias rows)`);
