// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textLayoutWidthSmoke.mjs — fixed layout-box align (as in TextMeshPro).
//
// style.layoutWidthEm makes a text bundle's globalBBox the layout box
// [0,0,W,H] (not ink-tight), and `align` positions glyphs WITHIN it:
//   - right  → ink sits flush against the box's right edge
//   - center → ink centered in the box
//   - left   → ink at the box's left edge
// Default (no layoutWidthEm) stays ink-tight. Exercises the full
// textBundle.buildTextSections path (no GL) and inspects the resulting
// globalBBox + per-shape ink bboxes.

import assert from 'assert';
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildTextSections } from '../src/textBundle.js';
import { fontFixture, readAsset } from './_assets.mjs';

const fontBytes = readAsset(fontFixture('roboto-regular.ttf'));
const font = new MantleFontAsset(new Uint8Array(fontBytes));
await font.ready;

const TEXT = 'Span 3';
const W = 12; // layout box width in em — comfortably wider than the ink.

const build = (style) => buildTextSections(font, TEXT, { fill: [0, 0, 0, 1], ...style }, false);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok ' + name);
  else {
    failures++;
    console.error('FAIL: ' + name + (extra ? ' — ' + extra : ''));
  }
};

// Per-shape meta packs its ink bbox at floats [xmin,ymin,xmax,ymax]
// (meta.js texel 0), stride metaFloatsPerShape. Union for the run's
// horizontal ink extent.
function minMaxInkX(raw) {
  const m = raw.metaFloats,
    stride = raw.metaFloatsPerShape;
  let lo = Infinity,
    hi = -Infinity;
  for (let s = 0; s < raw.numShapes; s++) {
    lo = Math.min(lo, m[s * stride + 0]);
    hi = Math.max(hi, m[s * stride + 2]);
  }
  return [lo, hi];
}

// --- Ink-tight (default): globalBBox at (0,0), ~advance wide, align=right
//     does NOT widen it.
const inkTight = (await build({ align: 'right' })).bundleSrc;
const inkW = inkTight.globalBBox[2];
check(
  'ink-tight default: globalBBox origin (0,0)',
  inkTight.globalBBox[0] === 0 && inkTight.globalBBox[1] === 0,
  JSON.stringify(inkTight.globalBBox),
);
assert(inkW > 0 && inkW < W, 'fixture sanity: ink width within box');

// --- Box mode, three alignments. globalBBox must equal the layout box.
const boxLeft = (await build({ align: 'left', layoutWidthEm: W })).bundleSrc;
const boxCenter = (await build({ align: 'center', layoutWidthEm: W })).bundleSrc;
const boxRight = (await build({ align: 'right', layoutWidthEm: W })).bundleSrc;

for (const [name, b] of [
  ['left', boxLeft],
  ['center', boxCenter],
  ['right', boxRight],
]) {
  check(
    `box ${name}: globalBBox width == layout width`,
    Math.abs(b.globalBBox[2] - W) < 1e-6,
    JSON.stringify(b.globalBBox),
  );
  check(
    `box ${name}: globalBBox origin (0,0)`,
    b.globalBBox[0] === 0 && b.globalBBox[1] === 0,
    JSON.stringify(b.globalBBox),
  );
}

// --- The alignment offset must reach the GLYPHS, not just the box.
const [lL] = minMaxInkX(boxLeft);
const [, rR] = minMaxInkX(boxRight);
const [cL, cR] = minMaxInkX(boxCenter);

check('box left: ink starts near box left (x≈0)', lL < W * 0.25, 'minX=' + lL.toFixed(3));
check('box right: ink ends near box right (x≈W)', rR > W * 0.75, 'maxX=' + rR.toFixed(3));
check(
  'box center: ink midpoint near box center',
  Math.abs((cL + cR) / 2 - W / 2) < W * 0.1,
  'mid=' + ((cL + cR) / 2).toFixed(3),
);
check('box right ink is right of left ink', rR - lL > W * 0.5);

// --- Box ink fits vertically within [0, H] (top shifted to y=0).
const H = boxRight.globalBBox[3];
let yLo = Infinity,
  yHi = -Infinity;
for (let s = 0; s < boxRight.numShapes; s++) {
  yLo = Math.min(yLo, boxRight.metaFloats[s * boxRight.metaFloatsPerShape + 1]);
  yHi = Math.max(yHi, boxRight.metaFloats[s * boxRight.metaFloatsPerShape + 3]);
}
check(
  'box: ink y within [0, H]',
  yLo >= -1e-3 && yHi <= H + 1e-3,
  `y∈[${yLo.toFixed(3)},${yHi.toFixed(3)}] H=${H.toFixed(3)}`,
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nTEXT-LAYOUT-WIDTH PASS');
process.exit(failures ? 1 : 0);
