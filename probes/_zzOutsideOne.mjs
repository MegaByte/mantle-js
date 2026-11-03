// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzOutsideOne — the pixels a shape's patches paint outside its own path: where, which patch,
// how far out, and what the patch's own loop says about the point.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { rowSpans, insideContour, patchBBox } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const N = +(process.env.N || 384);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
for (const S of (process.env.S || '1,42,166').split(',').map(Number)) {
  const r = sec.curveRangesByShape[S];
  if (!r) continue;
  const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  const ps = [];
  packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  // THE same BOX THE CORPUS SWEEP USES -- control points, not the tight box. They differ by a
  // rounding on a curved shape, which moves every sample position, and a defect one sample wide
  // shows in one probe and not the other.
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      if (P[0] < bx0) bx0 = P[0];
      if (P[0] > bx1) bx1 = P[0];
      if (P[1] < by0) by0 = P[1];
      if (P[1] > by1) by1 = P[1];
    }
  const bb = [bx0, by0, bx1, by1];
  const SC = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / N;
  const hits = [];
  for (let j = Math.floor((bb[1] - 2 * SC) / SC); j <= Math.ceil((bb[3] + 2 * SC) / SC); j++) {
    const cy = (j + 0.5) * SC,
      spans = rowSpans(all, cy) || [];
    for (let i = Math.floor((bb[0] - 2 * SC) / SC); i <= Math.ceil((bb[2] + 2 * SC) / SC); i++) {
      const cx = (i + 0.5) * SC;
      let far = true,
        clear = Infinity;
      for (const sp of spans) {
        if (cx > sp[0] - 1.5 * SC && cx < sp[1] + 1.5 * SC) far = false;
        clear = Math.min(clear, Math.abs(cx - sp[0]), Math.abs(cx - sp[1]));
      }
      if (!far) continue;
      let cov = 0,
        which = -1;
      for (let k = 0; k < ps.length; k++) {
        const c = patchCoverage(ps[k], cx, cy, SC);
        if (c > cov) {
          cov = c;
          which = k;
        }
      }
      if (cov > 0.5) hits.push({ cx, cy, cov, which, clearPx: clear / SC });
    }
  }
  console.log(
    `s${S}: ${ps.length} patches, ${cs.length} contours, extent ${(bb[2] - bb[0]).toFixed(2)} x ${(bb[3] - bb[1]).toFixed(2)} em, ${hits.length} px outside`,
  );
  for (const h of hits.slice(0, 4)) {
    const p = ps[h.which];
    const inLoop = insideContour(p.curves, h.cx, h.cy);
    console.log(
      `   (${h.cx.toFixed(4)}, ${h.cy.toFixed(4)}) cov ${h.cov.toFixed(3)} from patch ${h.which}` +
        ` (${p.curves.length} curves, ${p.curves.filter((c) => c.cut).length} cuts);` +
        ` ${h.clearPx.toFixed(2)}px clear of the path; the patch's own loop says ${inLoop ? 'INSIDE' : 'outside'}`,
    );
    for (let q = 0; q < p.curves.length; q++) {
      const sg = p.curves[q];
      console.log(
        `       [${q}] ${sg.t}${sg.cut ? ' CUT' : ''} ` +
          sg.P.map((P) => `(${P[0].toFixed(3)},${P[1].toFixed(3)})`).join(' '),
      );
    }
  }
}
