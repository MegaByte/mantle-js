// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzThinOne — one interior pixel a constraint took coverage from, in full: what the kernel
// measured, where it projected to, and where the arc actually is.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov } from '../src/renderer/cpatchCov.js';
import { insideContour, patchBBox, rowSpans } from '../src/renderer/cpatchConvert.js';
import { segPt, segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const SI = +process.argv[3],
  PX = +(process.env.PX || 256);
const r = sections.curveRangesByShape[SI];
const list = contoursToConverter(
  curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
  null,
);
const all = [];
for (const c of list) {
  for (const g of c) all.push(g);
  const a = segPt(c[0], 0),
    b = segPt(c[c.length - 1], 1);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
}
const patches = [];
packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
const bb = patchBBox(all);
const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
const em = (span * 1.08) / PX,
  x0 = bb[0] - span * 0.04,
  y0 = bb[1] - span * 0.04;
const GLX = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GLW = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
  0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];
const SUB = 8;
const refCov = (x, y) => {
  let acc = 0;
  for (let sN = 0; sN < SUB; sN++) {
    const ya = y - em / 2 + (sN / SUB) * em,
      yh = em / SUB;
    for (let g = 0; g < 8; g++) {
      const yy = ya + (yh * (GLX[g] + 1)) / 2,
        w = GLW[g] / 2 / SUB;
      let L = 0;
      for (const sp of rowSpans(all, yy)) {
        const lo = Math.max(sp[0], x - em / 2),
          hi = Math.min(sp[1], x + em / 2);
        if (hi > lo) L += hi - lo;
      }
      acc += w * (L / em);
    }
  }
  return acc;
};
const arcDist = (sg, x, y) => {
  let d = Infinity;
  for (let k = 0; k <= 400; k++) {
    const p = segPt(sg, k / 400);
    d = Math.min(d, Math.hypot(p[0] - x, p[1] - y));
  }
  return d;
};
let found = 0;
for (let py = 0; py < PX && found < +(process.env.N || 3); py++)
  for (let px = 0; px < PX && found < +(process.env.N || 3); px++) {
    const x = x0 + (px + 0.5) * em,
      y = y0 + (py + 0.5) * em;
    if (!insideContour(all, x, y)) continue;
    // FULLY COVERED MEANS THE AREA IS ONE, and four corners do not say that -- a notch can cut into
    // the middle of a pixel whose corners are all inside. Measured: a pixel this test called whole
    // is 0.8026 covered. The area is what the audit's reference computes, so compute it here too:
    // exact spans in x, Gauss-Legendre in y.
    if (refCov(x, y) < 1 - 1e-6) continue;
    let open = 1;
    for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, em)));
    const cov = 1 - open;
    if (cov > 0.9) continue;
    found++;
    console.log(
      `\npixel (${px},${py}) em (${x.toFixed(2)},${y.toFixed(2)}): composite ${cov.toFixed(3)}, true coverage ${refCov(x, y).toFixed(4)}`,
    );
    for (const p of patches) {
      const pc = patchCoverage(p, x, y, em);
      if (pc <= 0) continue;
      console.log(`  patch of ${p.curves.length} curves: coverage ${pc.toFixed(3)}`);
      for (let k = 0; k < p.impls.length; k++) {
        const im = p.impls[k],
          sg = p.curves[k];
        if (!im.packed) continue;
        const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        const res = {};
        const c = curveCov(im.packed, sgn, !!sg.cut, segTightBBox(sg), x, y, em, res);
        if (c > 0.999) continue;
        const dArc = arcDist(sg, x, y) / em;
        const dProj = res.projX != null ? arcDist(sg, res.projX, res.projY) / em : NaN;
        console.log(
          `    ${sg.cut ? 'CUT ' : 'edge'} ${sg.t.padEnd(5)} cov ${c.toFixed(3)}  sd ${(res.sd ?? NaN).toFixed(3)}px` +
            `  boxPx ${(res.boxPx ?? NaN).toFixed(3)}  fragment is ${dArc.toFixed(2)}px from its arc,` +
            ` its projection ${dProj.toFixed(2)}px`,
        );
      }
    }
  }
