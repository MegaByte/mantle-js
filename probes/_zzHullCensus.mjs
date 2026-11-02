// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzHullCensus — how many hull planes a fragment evaluates, and how many it could.
//
// The cover is a triangle FAN over the hull polygon, so each triangle's outer boundary is ONE hull
// edge and its corners involve at most its two neighbours. Every fragment nevertheless loops the
// whole patch's plane list. This prices the difference: the mean planes per patch against the 3 a
// triangle can actually be fenced by.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape, CP_HULL_ROW_SAMPLES } from '../src/renderer/cpatchPack.js';
import { patchCoverLines } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const SAMP = +(process.env.SAMPLES || CP_HULL_ROW_SAMPLES);
let nPatch = 0,
  nPlane = 0,
  nHard = 0,
  nRamp = 0,
  nPoly = 0,
  maxPlane = 0;
const hist = new Map();
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  const ps = [];
  try {
    packCPatchShape(cs, 0, { evenOdd, onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  for (const p of ps) {
    const hl = patchCoverLines(p.curves, SAMP);
    if (!hl) continue;
    nPatch++;
    nPlane += hl.length;
    nPoly += p.curves.length;
    if (hl.length > maxPlane) maxPlane = hl.length;
    for (const h of hl) {
      if (h[3] === 2) nRamp++;
      else nHard++;
    }
    hist.set(hl.length, (hist.get(hl.length) || 0) + 1);
  }
}
const rows = [...hist].sort((a, b) => a[0] - b[0]);
console.log(
  `${SAMP} samples/curve:  ${nPatch} patches, mean ${(nPlane / nPatch).toFixed(1)} hull planes each (max ${maxPlane})`,
);
console.log(
  `  hard ${nHard} (${((100 * nHard) / nPlane).toFixed(0)}%)  ramped ${nRamp} (${((100 * nRamp) / nPlane).toFixed(0)}%)  mean curves/patch ${(nPoly / nPatch).toFixed(1)}`,
);
console.log(
  `  blocks per patch now: ${(nPlane / nPatch / 4).toFixed(1)} packed + ${(nRamp / nPatch).toFixed(1)} ramped`,
);
console.log(`  distribution: ${rows.map(([k, v]) => k + ':' + v).join(' ')}`);
