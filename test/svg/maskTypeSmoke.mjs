// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskTypeSmoke.mjs — verifies SVG <mask mask-type="alpha"> vs
// the default mask-type="luminance" produces distinct bundle flags.
//
// The runtime mask compositor reads the `isolation` byte from the
// mask-bracketing meta texels to choose between luma-coefficient
// blending (luminance, default) and direct A-channel blending
// (alpha). Both paths use the same R8 mask RT; the difference is
// in the sample-resolve shader.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

const META_STRIDE = 48; // floats per shape
const META_FLAGS = 27; // float offset of flagsShape (texel 6.w)
const META_ISOLATE = 34; // float offset of isolation  (texel 8.z)

const FLAG_MASK_BEGIN = 1 << 8;
const FLAG_MASK_END = 1 << 9;

function metaFloatsOf(bundle) {
  // bundle.meta is a 32-byte header + per-shape 48-float records.
  return new Float32Array(bundle.meta, 32);
}

function buildSvg(maskTypeAttr) {
  const attr = maskTypeAttr ? ` mask-type="${maskTypeAttr}"` : '';
  return `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <mask id="m1"${attr}>
      <rect x="0" y="0" width="100" height="100" fill="white"/>
    </mask>
  </defs>
  <rect x="10" y="10" width="80" height="80" fill="red" mask="url(#m1)"/>
</svg>`;
}

function findMaskBeginRow(bundle) {
  const m = metaFloatsOf(bundle);
  const n = bundle.numShapes;
  for (let i = 0; i < n; i++) {
    const flags = m[i * META_STRIDE + META_FLAGS] | 0;
    if (flags & FLAG_MASK_BEGIN) return i;
  }
  return -1;
}

// ---- T1: default (no mask-type) → luminance (isolation = 1) -------
{
  const bundle = await importSvg(buildSvg(null), {});
  const row = findMaskBeginRow(bundle);
  if (row < 0) fail('T1 default mask: no MASK_BEGIN row found');
  else {
    const iso = metaFloatsOf(bundle)[row * META_STRIDE + META_ISOLATE];
    if (iso !== 1) fail(`T1 default isolation expected 1 (luminance), got ${iso}`);
    else ok('T1 default mask (no attr) emits isolation=1 (luminance)');
  }
}

// ---- T2: mask-type="luminance" → isolation = 1 --------------------
{
  const bundle = await importSvg(buildSvg('luminance'), {});
  const row = findMaskBeginRow(bundle);
  if (row < 0) fail('T2 luminance mask: no MASK_BEGIN row found');
  else {
    const iso = metaFloatsOf(bundle)[row * META_STRIDE + META_ISOLATE];
    if (iso !== 1) fail(`T2 luminance isolation expected 1, got ${iso}`);
    else ok('T2 mask-type="luminance" emits isolation=1');
  }
}

// ---- T3: mask-type="alpha" → isolation = 0 ------------------------
{
  const bundle = await importSvg(buildSvg('alpha'), {});
  const row = findMaskBeginRow(bundle);
  if (row < 0) fail('T3 alpha mask: no MASK_BEGIN row found');
  else {
    const iso = metaFloatsOf(bundle)[row * META_STRIDE + META_ISOLATE];
    if (iso !== 0) fail(`T3 alpha isolation expected 0, got ${iso}`);
    else ok('T3 mask-type="alpha" emits isolation=0 (different from luminance)');
  }
}

// ---- T4: case-insensitive parsing ---------------------------------
{
  const bundle = await importSvg(buildSvg('ALPHA'), {});
  const row = findMaskBeginRow(bundle);
  if (row < 0) fail('T4 ALPHA mask: no MASK_BEGIN row');
  else {
    const iso = metaFloatsOf(bundle)[row * META_STRIDE + META_ISOLATE];
    if (iso !== 0) fail(`T4 case-insensitive ALPHA expected 0, got ${iso}`);
    else ok('T4 mask-type="ALPHA" case-insensitive');
  }
}

// ---- T5: alpha and luminance bundles differ at the iso byte ------
{
  const bA = await importSvg(buildSvg('alpha'), {});
  const bL = await importSvg(buildSvg('luminance'), {});
  const fA = metaFloatsOf(bA),
    fL = metaFloatsOf(bL);
  let differs = false;
  for (let i = 0; i < Math.min(bA.numShapes, bL.numShapes); i++) {
    const ia = fA[i * META_STRIDE + META_ISOLATE];
    const il = fL[i * META_STRIDE + META_ISOLATE];
    if (ia !== il) {
      differs = true;
      break;
    }
  }
  if (!differs) fail('T5 alpha vs luminance bundles do NOT differ on isolation byte');
  else ok('T5 alpha vs luminance produce distinct bundle flags');
}

for (const [style, attr, expected] of [
  ['', 'style="mask-type:alpha"', 0],
  ['<style>#m1 {mask-type:alpha!important}</style>', 'mask-type="luminance"', 0],
  ['<style>#m1 {mask-type:luminance!important}</style>', 'style="mask-type:alpha!important"', 0],
  ['', 'style="--k:alpha!important;mask-type:var(--k)"', 0],
  ['', 'style="mask-type:initial"', 1],
]) {
  const text = buildSvg(null)
    .replace('<defs>', style + '<defs>')
    .replace('<mask id="m1"', '<mask id="m1" ' + attr);
  const b = await importSvg(text),
    row = findMaskBeginRow(b);
  if (row >= 0 && metaFloatsOf(b)[row * META_STRIDE + META_ISOLATE] === expected)
    ok('computed mask-type cascade');
  else fail(`computed mask-type ${attr}`);
}

if (failures > 0) {
  console.error(`\nMASK-TYPE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nMASK-TYPE PASS');
