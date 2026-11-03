// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzJoint — the geometry AT a joint that both engines get wrong. A count of bad pixels near
// joints says the seam is the mechanism; it does not say WHICH seam or what shape it has. This
// prints the two segments meeting at the nearest joint, the turn between them, and the exact
// coverage of the pixel, so the defect can be reasoned about rather than guessed at.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const bb = sec.viewBox || [0, 0, 900, 900];
const emX = (i) => bb[0] + ((i + 0.5) / N) * bb[2];
const emY = (j) => bb[1] + (1 - (j + 0.5) / N) * bb[3];
const SCX = bb[2] / N,
  SCY = bb[3] / N;
const at = (sg, t) => {
  const P = sg.P,
    n = P.length - 1;
  let pts = P.map((q) => q.slice());
  for (let r = 0; r < n; r++)
    for (let k = 0; k < n - r; k++)
      pts[k] = [
        pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t,
        pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t,
      ];
  return pts[0];
};
const tan = (sg, t) => {
  const a = at(sg, Math.max(0, t - 1e-5)),
    b = at(sg, Math.min(1, t + 1e-5));
  return [b[0] - a[0], b[1] - a[1]];
};
for (const spec of (process.env.PTS || '220,370').split(' ')) {
  const [pi, pj, si] = spec.split(',').map(Number);
  const cx = emX(pi),
    cy = emY(pj);
  let best = null;
  for (let s = 0; s < meta.numShapes; s++) {
    if (si !== undefined && s !== si) continue;
    const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
    if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
    let cs = null;
    try {
      cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
    } catch {
      continue;
    }
    if (!cs) continue;
    for (const c of cs)
      for (let k = 0; k < c.length; k++) {
        const P0 = c[k].P[0];
        const d = Math.hypot(P0[0] - cx, P0[1] - cy) / SCX;
        if (!best || d < best.d) best = { d, s, c, k };
      }
  }
  if (!best) {
    console.log(`${spec}: no joint`);
    continue;
  }
  const { c, k, s, d } = best;
  const prev = c[(k - 1 + c.length) % c.length],
    cur = c[k];
  const tIn = tan(prev, 1),
    tOut = tan(cur, 0);
  const cross = tIn[0] * tOut[1] - tIn[1] * tOut[0];
  const dot = tIn[0] * tOut[0] + tIn[1] * tOut[1];
  const turn = (Math.atan2(cross, dot) * 180) / Math.PI;
  // Signed area of the contour: the interior side depends on its orientation.
  let A = 0;
  for (const sg of c) {
    const a = sg.P[0],
      b = sg.P[sg.P.length - 1];
    A += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = A > 0;
  const conv = (ccw ? turn > 0 : turn < 0) ? 'CONVEX' : 'REFLEX';
  console.log(
    `px(${pi},${pj}) em(${cx.toFixed(2)},${cy.toFixed(2)})  nearest joint: s${s} seg ${k} of ${c.length}` +
      `  at ${d.toFixed(3)}px  turn ${turn.toFixed(1)}deg  contour ${ccw ? 'CCW' : 'CW'}  => ${conv} corner`,
  );
  console.log(
    `    in  seg ${(k - 1 + c.length) % c.length}: ${prev.P.length - 1} deg  ${prev.P.map((q) => `(${q[0].toFixed(1)},${q[1].toFixed(1)})`).join(' ')}`,
  );
  console.log(
    `    out seg ${k}: ${cur.P.length - 1} deg  ${cur.P.map((q) => `(${q[0].toFixed(1)},${q[1].toFixed(1)})`).join(' ')}`,
  );
  // Exact coverage of that pixel by the shape, by 17-point Gauss in y.
  const r2 = sec.curveRangesByShape[s];
  const cs2 = contoursToConverter(curveRangeToContours(cf, r2.begin | 0, r2.end | 0), null);
  const all = [];
  for (const cc of cs2) for (const sg of cc) all.push(sg);
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let t2 = 0;
  const M = 33;
  for (let g = 0; g < M; g++) {
    const y = cy + SCY * ((g + 0.5) / M - 0.5);
    let spans;
    if (!evenOdd) spans = rowSpans(all, y) || [];
    else {
      const xs = [];
      for (const sg of all) rowCross(sg, y, (x) => xs.push(x));
      xs.sort((a2, b2) => a2 - b2);
      spans = [];
      for (let z = 0; z + 1 < xs.length; z += 2) spans.push([xs[z], xs[z + 1]]);
    }
    let c3 = 0;
    for (const sp of spans)
      c3 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
    t2 += c3 / SCX / M;
  }
  console.log(`    exact coverage of this pixel by s${s}: ${t2.toFixed(4)}`);
}
