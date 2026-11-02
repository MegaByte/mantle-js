// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// keepInvisibleShapesSmoke.mjs — importer's keepInvisibleShapes opt.
//
// By default a fully-transparent fill (alpha 0) is CULLED — the shape emits
// no fill row and (if also stroke-less) vanishes from the bundle. That makes
// a pose's shape SET depend on its per-pose paint: a shape that fades in via
// fill-opacity (0 → n) is absent in early poses and present later, so
// consecutive shape-timeline / morph poses get DIFFERENT topology and the
// morph can't establish a stable correspondence (apex grows-then-shrinks,
// glyphs pop in). keepInvisibleShapes keeps the shape at alpha 0 so the
// topology is uniform across poses. `fill="none"` (no fill at all) stays
// culled.
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';
import { fontFixture, readAsset } from './_assets.mjs';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const font = new MantleFontAsset(new Uint8Array(readAsset(fontFixture('roboto-regular.ttf'))));

const svg = (fop) =>
  `<svg viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">` +
  `<text x="5" y="40" font-family="Roboto" font-size="30" fill="#000" fill-opacity="${fop}">color</text></svg>`;

const base = {
  fonts: { Roboto: font },
  svgTextLayout: buildSvgTextGlyphs,
  keepInvisibleShapes: false,
}; // the optimizing mode
const keep = { fonts: { Roboto: font }, svgTextLayout: buildSvgTextGlyphs }; // the default keeps

// Optimizing mode (keepInvisibleShapes: false): alpha-0 pose culls the glyphs → topology differs from opaque pose.
const c0 = await importSvg(svg('0.000'), base);
const c1 = await importSvg(svg('0.551'), base);
if (c0.numShapes < c1.numShapes)
  ok(`keepInvisibleShapes:false culls alpha-0 fills (t0=${c0.numShapes} < t.55=${c1.numShapes})`);
else fail(`expected the optimizing mode to cull alpha-0 (t0=${c0.numShapes} t.55=${c1.numShapes})`);

// Default: uniform topology across the fade.
const k0 = await importSvg(svg('0.000'), keep);
const k1 = await importSvg(svg('0.551'), keep);
if (k0.numShapes === k1.numShapes && k0.numShapes === c1.numShapes)
  ok(`keepInvisibleShapes: uniform topology (${k0.numShapes}==${k1.numShapes}) across the fade`);
else
  fail(
    `keepInvisibleShapes not uniform: t0=${k0.numShapes} t.55=${k1.numShapes} opaque=${c1.numShapes}`,
  );

// The kept shape renders TRANSPARENT (fill alpha 0), so a morph lerps its
// opacity; it doesn't pop in as opaque.
const mf = k0.metaFloats || (k0.meta ? new Float32Array(k0.meta, 32) : null);
if (mf && mf[7] === 0)
  ok('kept alpha-0 shape stores fill alpha 0 (transparent; morph lerps opacity)');
else fail(`kept shape fill alpha not 0: ${mf ? mf[7] : 'no meta'}`);

// fill="none" stays culled by default (stroke-only path); 'all' keeps it.
const pn = await importSvg(
  '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M5 5 L45 45" fill="none" stroke="#000" stroke-width="2"/></svg>',
  keep,
);
if (pn.numShapes === 1) ok('fill="none" not resurrected by keepInvisibleShapes (stroke-only)');
else fail(`fill=none should stay 1 stroke-only shape, got ${pn.numShapes}`);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nkeepInvisibleShapesSmoke: all checks passed');
