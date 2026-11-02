// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzOcclusionCull — run the occlusion cull OFFLINE on an asset and print what it culls.
//
// The cull has an inline 'coincident' half and a worker 'full' half that lands asynchronously, so on the GPU a
// wrong decision only shows under a build slow enough for the worker to answer first. This reproduces both
// halves in plain node, from the same inputs createBundle hands the worker, so a fix can be iterated without a
// browser and without racing a worker.
import { readFileSync } from 'fs';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { computeOccludedShapes } = await import('../src/renderer/occlusionCull.js');
const sec = await importSvg(readFileSync(process.argv[2], 'utf8'));
const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const cv = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const cvF = new Float32Array(sec.curves);
const ranges = (sec.curveRangesByShape || []).map((r) => ({ begin: r.begin | 0, end: r.end | 0 }));
console.log(`meta rows ${m.numShapes}  stride ${m.floatsPerShape}  ranges ${ranges.length}`);
for (const mode of ['coincident', 'full']) {
  for (const [name, plane] of [
    ['float32', cvF],
    ['float64', cv],
  ]) {
    let set = null;
    try {
      set = computeOccludedShapes(plane, ranges, m.metaFloats, m.numShapes, m.floatsPerShape, mode);
    } catch (e) {
      set = 'threw ' + e.message;
    }
    console.log(
      `  ${mode.padEnd(10)} ${name}: ${set instanceof Set ? JSON.stringify([...set].sort((a, b) => a - b)) : set}`,
    );
  }
}

// ---- WHO culled WHOM, and under which fill rule ------------------------------------------------------------
// computeOccludedShapes returns only the set. Replicate its pair search with the exported helpers so each
// culled row names its occluder, then ask the one question the containment test does not: under the
// OCCLUDER'S own fill rule, are there points inside the culled shape that the occluder leaves empty?
const { segsOf, isPlainOpaque, isContained } = await import('../src/renderer/occlusionCull.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');
const MF = m.metaFloats,
  ST = m.floatsPerShape,
  n = m.numShapes;
const bbx = (i) => [MF[i * ST], MF[i * ST + 1], MF[i * ST + 2], MF[i * ST + 3]];
const eoOf = (i) => MF[i * ST + 13] > 0.5;
const full = computeOccludedShapes(cvF, ranges, MF, n, ST, 'full');
console.log(
  '\nculled row -> occluder (rule) : interior samples inside the shape but EMPTY in the occluder, nonzero-tested / own-rule-tested',
);
for (const i of [...full].sort((a, b) => a - b)) {
  const bi = bbx(i),
    si = segsOf(i, cvF, ranges);
  let found = null;
  for (let j = n - 1; j > i && !found; j--) {
    if (!isPlainOpaque(MF, ST, j)) continue;
    const bj = bbx(j);
    const eps = Math.max(1e-5, 1e-4 * Math.max(bj[2] - bj[0], bj[3] - bj[1]));
    if (bi[0] < bj[0] - eps || bi[1] < bj[1] - eps || bi[2] > bj[2] + eps || bi[3] > bj[3] + eps)
      continue;
    const sj = segsOf(j, cvF, ranges);
    if (!si || !sj) continue;
    if (isContained(si, sj, eps, bi[0], bi[1], bi[2], bi[3])) found = { j, sj };
  }
  if (!found) {
    console.log(`  row ${i}: no single occluder reproduced`);
    continue;
  }
  const { j, sj } = found,
    G = 24;
  let emptyNZ = 0,
    emptyOwn = 0,
    inside = 0;
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++) {
      const x = bi[0] + ((bi[2] - bi[0]) * (gx + 0.5)) / G,
        y = bi[1] + ((bi[3] - bi[1]) * (gy + 0.5)) / G;
      if (!pointInFill(si, x, y, eoOf(i), null)) continue;
      inside++;
      if (!pointInFill(sj, x, y, false, null)) emptyNZ++;
      if (!pointInFill(sj, x, y, eoOf(j), null)) emptyOwn++;
    }
  console.log(
    `  row ${String(i).padStart(2)} -> ${String(j).padStart(2)} (${eoOf(j) ? 'evenodd' : 'nonzero'}) : ${emptyNZ} / ${emptyOwn} of ${inside} interior samples`,
  );
}
