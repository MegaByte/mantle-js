// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchPackCost — of a CPatch bundle build, how much is CONVERSION and how much is PACKING?
//
// Conversion speed is only worth what conversion is worth: the build also has to turn every
// patch into the GPU wire form -- grid-splitting each patch's cover, emitting texels and
// vertices -- so this times the two against each other. If packing is the larger half, work on the search is
// aimed at the wrong place.
//
// Uses the same precomputed-conversion path the pooled build uses (opts.conv), so the packing
// arm measures packing alone rather than packing plus a second conversion.
import { tigerCycles } from './_cpatchCycles.mjs';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import {
  packCPatchContour,
  cpatchConvKey,
  cpatchConvSettings,
} from '../src/renderer/cpatchPack.js';

const OPTS = { maxCurves: 8, tolPx: 0.05, holes: null };
const GRID = +(process.env.GRID || 4);
const contours = tigerCycles().cycles;

// 1. conversion alone
let convMs = 0,
  patches = 0;
const convs = [];
for (const cs of contours) {
  const t = performance.now();
  let r = null;
  try {
    r = convertContour(cs, OPTS);
  } catch {
    r = null;
  }
  convMs += performance.now() - t;
  convs.push(r);
  if (r) patches += r.patches.length;
}

// 2. packing alone, handed the conversion the first pass produced
let packMs = 0,
  texels = 0,
  verts = 0,
  packed = 0,
  block = 0;
const cache = new Map();
for (let i = 0; i < contours.length; i++) {
  if (!convs[i]) continue;
  cache.clear();
  cache.set(cpatchConvKey(contours[i], null, cpatchConvSettings(OPTS)), convs[i]);
  const t = performance.now();
  let out = null;
  try {
    out = packCPatchContour(contours[i], block, { ...OPTS, grid: GRID, convCache: cache });
  } catch {
    out = null;
  }
  packMs += performance.now() - t;
  if (out) {
    texels += out.texels.length;
    verts += out.vertexCount;
    packed++;
    block += out.texels.length / 4;
  }
}

const tot = convMs + packMs;
const pc = (x) => ((100 * x) / tot).toFixed(1) + '%';
console.log(`\n  tiger: ${contours.length} contours, ${patches} patches, grid ${GRID}x${GRID}\n`);
console.log(`  convert   ${convMs.toFixed(0).padStart(6)}ms  (${pc(convMs)})`);
console.log(
  `  pack      ${packMs.toFixed(0).padStart(6)}ms  (${pc(packMs)})   ${packed} contours packed`,
);
console.log(`  total     ${tot.toFixed(0).padStart(6)}ms`);
console.log(`\n  wire form: ${texels.toLocaleString()} texels, ${verts.toLocaleString()} vertices`);
console.log(`  ${((packMs / Math.max(patches, 1)) * 1000).toFixed(1)}us of packing per patch`);
