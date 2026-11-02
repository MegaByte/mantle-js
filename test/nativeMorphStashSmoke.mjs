// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeMorphStashSmoke -- the native morph's auto-apply stashes are on the bundle it hands out, and leave a pose when the morph does.
//
// 1. A morph from an empty source hands out a copy of the source, so the table is stashed on the copy: stashed on the original before the copy is made, drawBundle(morph.bundle)
//    would find no table and draw nothing, and dispose would leave the table on the original.
// 2. A native timeline moving to a new bracket disposes the previous one: otherwise drawing that pose afterwards shows the previous bracket's last t. CPU, on the stashes the native scene reads.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import importSvg from '../src/svg/importer.js';
import { createNativeMorph, createNativeTimeline } from '../src/fallback/nativeMorph.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const opts = { retainSource: true, preserveViewport: true };
const rect = (x) => `<rect id="a" x="${x}" y="1" width="9" height="9" fill="#f00"/>`;

const empty = await importSvg(svg(''), opts),
  one = await importSvg(svg(rect(1)), opts);
const morph = createNativeMorph(empty, one);
assert.equal(
  morph.bundle.__nativeMorphOverrides,
  morph.overrides,
  'the bundle the morph hands out carries its table',
);
assert.ok(
  morph.overrides.extraShapes.length === 1,
  'the premise: the destination shape is an extra',
);
assert.deepEqual(
  Array.from(morph.bundle.globalBBox),
  Array.from(one.globalBBox),
  'the empty source draws in the destination frame',
);
morph.dispose();
assert.equal(
  empty.__nativeMorphOverrides,
  undefined,
  'the source pose carries no table after dispose',
);
assert.equal(morph.bundle.__nativeMorphOverrides, undefined, 'nor does the copy');

const A = await importSvg(svg(rect(0)), opts),
  B = await importSvg(svg(rect(20)), opts),
  C = await importSvg(svg(rect(40)), opts);
const T = createNativeTimeline(
  [A, B, C],
  [
    { time: 0, bundleIndex: 0 },
    { time: 1, bundleIndex: 1 },
    { time: 2, bundleIndex: 2 },
  ],
);
T.setTime(0.5);
assert.ok(
  A.__nativeMorphOverrides && A.__streamPathD,
  'the premise: the first bracket stashed on its source pose',
);
T.setTime(1.5);
assert.equal(T.bundle, B, 'the premise: the timeline moved to the next bracket');
assert.equal(A.__nativeMorphOverrides, undefined, 'the pose it left has no table');
assert.equal(A.__streamPathD, undefined, 'and no geometry');
T.setTime(0.25);
assert.equal(T.bundle, A);
assert.equal(B.__nativeMorphOverrides, undefined, 'moving back clears the later bracket');
assert.ok(
  A.__streamPathD[0].includes('M5'),
  `and the first bracket is live again (${A.__streamPathD[0]})`,
);
T.dispose();
assert.equal(A.__nativeMorphOverrides, undefined, 'the timeline leaves nothing');
console.log('nativeMorphStashSmoke PASS');
process.exit(0);
