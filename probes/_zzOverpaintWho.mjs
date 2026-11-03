// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzOverpaintWho — at a point the exact composite says belongs to one shape, WHICH shape's patches
// claim it? Runs the CPU model of every shape at the point and names any that cover it while their
// own path does not.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { patchCoverHull, patchCoverLines } from '../src/renderer/cpatchConvert.js';
import { CP_KERNEL_HULL_SAMPLES } from '../src/renderer/cpatchPack.js';
import { rowSpans, patchBBox } from '../src/renderer/cpatchConvert.js';

const N = +(process.env.N || 512);
const SRC = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
const SVG = readFileSync(SRC, 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
// THE FLOAT64 PLANE, which is what the build converts (cpatchCurvePlane). Converting the
// float32 wire plane instead rounds the inputs first and gives a DIFFERENT decomposition -- so a
// probe that reads it is modelling a shape the renderer never packed.
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const vb = sec.viewBox || [0, 0, 900, 900];
const SC = vb[2] / N,
  em = SC;
const PTS = (process.env.PTS || '450,389 132,426 86,293 96,197 245,334 232,333')
  .split(' ')
  .map((s) => s.split(',').map(Number));
const shapes = [];
for (let s = 0; s < (sec.curveRangesByShape || []).length; s++) {
  const r = sec.curveRangesByShape[s];
  if (!r) {
    shapes.push(null);
    continue;
  }
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) {
    shapes.push(null);
    continue;
  }
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  const ps = [];
  try {
    packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    /* as the build does */
  }
  shapes.push({ segs: all, patches: ps, bb: patchBBox(all) });
}
console.log(`${shapes.filter(Boolean).length} shapes modelled`);
for (const [i, j] of PTS) {
  const cx = vb[0] + (i + 0.5) * SC,
    cy = vb[1] + (N - 1 - j + 0.5) * SC;
  const claim = [];
  for (let s = 0; s < shapes.length; s++) {
    const sh = shapes[s];
    if (!sh || !sh.patches.length) continue;
    let best = 0,
      which = -1,
      nak = 0,
      inHull = '';
    for (let k = 0; k < sh.patches.length; k++) {
      const c = patchCoverage(sh.patches[k], cx, cy, em);
      if (c > best) {
        best = c;
        which = k;
      }
      // CONSTRAINTS only, and how far outside its own hull the point is. Together they say whether
      // a patch would paint here if the cover let it, which is what the GPU's dilated quad decides.
      globalThis.__CP_NO_HULL = true;
      const c2 = patchCoverage(sh.patches[k], cx, cy, em);
      globalThis.__CP_NO_HULL = false;
      if (c2 > 0.002) {
        const H = patchCoverHull(sh.patches[k].curves, CP_KERNEL_HULL_SAMPLES);
        let d = -Infinity;
        if (H) {
          let ccx = 0,
            ccy = 0;
          for (const q of H) {
            ccx += q[0];
            ccy += q[1];
          }
          ccx /= H.length;
          ccy /= H.length;
          for (let t2 = 0; t2 < H.length; t2++) {
            const a = H[t2],
              b = H[(t2 + 1) % H.length];
            const dx2 = b[0] - a[0],
              dy2 = b[1] - a[1],
              L2 = Math.hypot(dx2, dy2);
            if (L2 < 1e-12) continue;
            let nx = -dy2 / L2,
              ny = dx2 / L2;
            if (nx * (ccx - a[0]) + ny * (ccy - a[1]) < 0) {
              nx = -nx;
              ny = -ny;
            }
            const sd = -(nx * (cx - a[0]) + ny * (cy - a[1])) / em; // px OUTSIDE the hull
            if (sd > d) d = sd;
          }
        }
        if (nak < 3) inHull += ` [p${k} noHull=${c2.toFixed(2)} outHull=${d.toFixed(2)}px]`;
        nak++;
      }
    }
    if (best <= 0.002 && !nak) continue;
    // does the shape's own path contain it?
    let inside = 0;
    for (const sp of rowSpans(sh.segs, cy) || []) if (cx >= sp[0] && cx <= sp[1]) inside = 1;
    const outBox = cx < sh.bb[0] || cx > sh.bb[2] || cy < sh.bb[1] || cy > sh.bb[3];
    claim.push(
      `s${s}${inside ? '' : outBox ? ' OUTSIDE-BBOX' : ' OUTSIDE-PATH'}:${best.toFixed(3)}(patch ${which}/${sh.patches.length})${nak ? ' nohull=' + nak + inHull : ''}`,
    );
  }
  console.log(`(${i},${j}) em (${cx.toFixed(2)},${cy.toFixed(2)}) ->\n    ${claim.join('\n    ')}`);
}
