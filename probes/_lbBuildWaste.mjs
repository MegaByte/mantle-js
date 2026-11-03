// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBuildWaste.mjs — how much of a bundle's Loop-Blinn build the per-shape policy can never draw.
//
// Under 'auto' a shape takes its mesh only when lbShapePolicy picks it, and lbShapeMayPick is the
// size-INDEPENDENT half of that answer: a stroke row, a clip / mask / inline-filter row, a row with
// no fill, and (under the default rule) a row with no cubic and no arc can never be picked at any
// scale. A mesh built for one of those is built, paid for, and passed over on every draw for the
// life of the bundle.
//
// A/B, in one process: arm A builds every shape (what the worker and prepareBundle did), arm B
// passes lbBuildSkipMask as the build's `skip`. Reports the shapes, milliseconds and packed bytes
// each spends, and then checks the claim that matters — the PICKED set is identical, so the gate
// removed only meshes nothing was going to draw.
//
// bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by eight floats,
// which changes the fill rule, the stroke flag and the primitive kind every predicate here reads.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { lbBuildSkipMask, lbShapePicks, lbBundleMayPick } =
  await import('../src/renderer/lbShapePolicy.js');

import { benchNames, BENCH_UNSET } from '../test/_assets.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.slice(2).length && !benchNames().length) console.log(BENCH_UNSET);
const ASSETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['examples/tiger.svg', ...benchNames().map((n) => `examples/_bench/${n}.svg`)];
/// Sizes the picked set is compared at: the gate must be size-free, and the compact-convex rule in
/// lbShapePolicy is the one part of the pick that is not.
const SIZES = [128, 512, 2048];
const rendererAt = (N) => ({ viewportSize: () => [N, N], arScale: () => [1, 1], draw: {} });

const realMeshes = (packed) => packed.filter((m) => m && !m.slug && (m.vertexCount | 0) > 0).length;
const packedBytes = (packed) =>
  packed.reduce((n, m) => n + (m && m.verts ? m.verts.byteLength : 0), 0);

let tA = 0,
  tB = 0,
  bytesA = 0,
  bytesB = 0,
  meshA = 0,
  meshB = 0,
  shapes = 0,
  mismatched = 0;

for (const rel of ASSETS) {
  const file = path.join(ROOT, rel);
  if (!existsSync(file)) {
    console.log(`(skip ${rel} — not present)`);
    continue;
  }
  const sec = await importSvg(readFileSync(file, 'utf8'));
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const input = {
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  };
  const bundle = {
    curveFloats: input.curveFloats,
    curveRangesByShape: input.ranges,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    numShapes: sec.numShapes,
    segTypeMask: sec.segTypeMask,
    _geomGen: 0,
  };
  const skip = lbBuildSkipMask(bundle);
  const skipped = skip ? skip.reduce((n, v) => n + v, 0) : 0;

  const a0 = performance.now();
  const A = buildLbBundle(input);
  const aMs = performance.now() - a0;
  // A/A first: the second unskipped build prices this process's own warm-up, so an arm that skips
  // nothing (cubic_onion) is read against that floor rather than against arm A's cold number.
  const a1 = performance.now();
  buildLbBundle(input);
  const aaMs = performance.now() - a1;
  const b0 = performance.now();
  const B = buildLbBundle({ ...input, skip });
  const bMs = performance.now() - b0;

  // The claim: every shape the policy picks has the same mesh in both arms.
  let bad = 0;
  for (const N of SIZES) {
    const pa = lbShapePicks(rendererAt(N), { ...bundle, _lbPickCache: null }, A.packed);
    const pb = lbShapePicks(rendererAt(N), { ...bundle, _lbPickCache: null }, B.packed);
    for (let s = 0; s < bundle.numShapes; s++) {
      const ta = pa ? pa[s] : 0,
        tb = pb ? pb[s] : 0;
      if (ta !== tb) {
        bad++;
        continue;
      }
      if (!ta) continue;
      const ma = A.packed[s],
        mb = B.packed[s];
      if (!ma || !mb || (ma.vertexCount | 0) !== (mb.vertexCount | 0)) bad++;
    }
  }
  mismatched += bad;

  const name = path.basename(rel, '.svg');
  console.log(
    `${name.padEnd(14)} shapes ${String(bundle.numShapes).padStart(4)}` +
      `  bundleMayPick ${lbBundleMayPick(bundle) ? 'yes' : 'no '}  skipped ${String(skipped).padStart(4)}` +
      `  |  build ${aMs.toFixed(1).padStart(7)} (A/A ${aaMs.toFixed(1).padStart(7)}) -> ${bMs.toFixed(1).padStart(7)} ms` +
      `  meshes ${String(realMeshes(A.packed)).padStart(4)} -> ${String(realMeshes(B.packed)).padStart(4)}` +
      `  bytes ${(packedBytes(A.packed) / 1024).toFixed(0).padStart(6)} -> ${(packedBytes(B.packed) / 1024).toFixed(0).padStart(6)} KB` +
      `  picks ${bad ? 'DIFFER (' + bad + ')' : 'identical'}`,
  );

  shapes += bundle.numShapes;
  tA += aaMs;
  tB += bMs;
  bytesA += packedBytes(A.packed);
  bytesB += packedBytes(B.packed);
  meshA += realMeshes(A.packed);
  meshB += realMeshes(B.packed);
}

const pct = (a, b) => (b > 0 ? ((100 * (b - a)) / b).toFixed(1) : '0.0');
console.log(`\nTOTAL ${shapes} shapes`);
console.log(
  `  build time    ${tA.toFixed(1)} -> ${tB.toFixed(1)} ms   (-${pct(tB, tA)}%)  [A/A arm vs gated]`,
);
console.log(`  meshes built  ${meshA} -> ${meshB}            (-${pct(meshB, meshA)}%)`);
console.log(
  `  packed bytes  ${(bytesA / 1024).toFixed(0)} -> ${(bytesB / 1024).toFixed(0)} KB  (-${pct(bytesB, bytesA)}%)`,
);
console.log(
  mismatched
    ? `\nDRAWN SET DIFFERS on ${mismatched} shape/size pairs — the gate removed a mesh the policy picks`
    : `\ndrawn set identical at ${SIZES.join(', ')} px: the gate removed only meshes nothing draws`,
);
