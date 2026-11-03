// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzTiling — do the patches TILE the shape? Geometry only, no implicits.
//
// A patch's curves form a closed loop, so a point is in the patch's REGION if that loop's winding
// says so. If a point inside the shape is in no patch's region, the converter failed to tile it and
// no kernel change can paint it. If it IS in one and the kernel still says nothing, the fault is
// the other side of the wire.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { insideContour, patchBBox, rowSpans } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const ONLY = process.argv[3] != null ? +process.argv[3] : null;
const N = +(process.env.N || 220);
const inLoop = (loop, x, y) => {
  for (const sp of rowSpans(loop, y)) if (x >= sp[0] && x <= sp[1]) return true;
  return false;
};
let gaps = 0,
  kernelOnly = 0,
  tot = 0,
  outRegion = 0,
  outHalf = 0;
const worst = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  if (ONLY != null && si !== ONLY) continue;
  const list = contoursToConverter(
    curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
    null,
  );
  if (!list || !list.length) continue;
  const all = [];
  for (const c of list) {
    for (const g of c) all.push(g);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
  }
  const patches = [];
  try {
    packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {
    continue;
  }
  if (!patches.length) continue;
  const bb = patchBBox(all),
    span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const em = span / 512,
    step = (span * 1.02) / N;
  let sGap = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = bb[0] - span * 0.01 + (i + 0.5) * step,
        y = bb[1] - span * 0.01 + (j + 0.5) * step;
      const inShape = insideContour(all, x, y);
      let inAny = false;
      for (const p of patches)
        if (inLoop(p.curves, x, y)) {
          inAny = true;
          break;
        }
      let open = 1;
      for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, em)));
      const painted = 1 - open > 0.5;
      if (inShape) {
        tot++;
        if (!inAny) {
          gaps++;
          sGap++;
          if (worst.length < 6) worst.push({ si, x, y, painted });
        } else if (!painted) kernelOnly++;
      } else if (painted) {
        // Painted where the shape is not. In a patch's REGION means the converter built a patch
        // that reaches outside the shape; in none means the half-spaces reach past the region the
        // patch was meant to be.
        if (inAny) outRegion++;
        else outHalf++;
      }
    }
  if (sGap && ONLY == null && worst.length < 6) {
    /* recorded above */
  }
}
console.log(`${tot} interior samples across the asset`);
console.log(`  ${gaps} lie in NO patch's region -- the converter did not tile them`);
console.log(`  ${kernelOnly} lie in a patch's region but the kernel paints under half`);
console.log(
  `OUTSIDE the shape and painted: ${outRegion} inside some patch's REGION (the converter ` +
    `built a patch reaching out), ${outHalf} inside none (the half-spaces reach past their patch)`,
);
for (const w of worst)
  console.log(
    `    shape ${w.si} at em (${w.x.toFixed(3)},${w.y.toFixed(3)})${w.painted ? ' (painted anyway)' : ''}`,
  );
