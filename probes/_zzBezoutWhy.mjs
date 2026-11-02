// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBezoutWhy — WHY these cubics fall to the Bezout resultant, in Loop-Blinn's own classification.
//
// Every pixel Loop-Blinn paints outside a path on tiger is covered by a CUBIC_BEZ crescent and
// nothing else (probes/_zzPaintKind.mjs), and the Bezout form is the fallback cubicKLMN takes when
// |d1| or the discriminant is small against the curve's own scale. But those are not unclassifiable
// curves: in the paper they are the QUADRATIC and CUSP rows of the classification table, each with
// an exact implicit of its own. Falling back to a resultant -- an algebraic curve carrying branches
// the Bezier never traces -- is a choice, not a necessity, and this measures which row each
// declining curve actually belongs to.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
// __LB_KLMN_MIN is a test hook the builder reads only under __MANTLE_DEBUG__
if (globalThis.__LB_KLMN_MIN > 0) globalThis.__MANTLE_DEBUG__ = true;
const KLMN_MIN =
  globalThis.__LB_KLMN_MIN > 0 ? globalThis.__LB_KLMN_MIN : +(process.env.KLMN_MIN || 1e-3);

let tot = 0,
  decl = 0,
  straight = 0;
const allD1 = [],
  allDisc = [],
  relAll = [];
const cls = new Map();
const flat = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  let cv = null;
  try {
    cv = contoursToConverter(cs, null);
  } catch {
    continue;
  }
  if (!cv) continue;
  for (const c of cv)
    for (const sg of c) {
      if (sg.t !== 'cubic' || sg.P.length !== 4) continue;
      tot++;
      const [b0, b1, b2, b3] = sg.P;
      const C1 = [3 * (b1[0] - b0[0]), 3 * (b1[1] - b0[1])];
      const C2 = [3 * b0[0] - 6 * b1[0] + 3 * b2[0], 3 * b0[1] - 6 * b1[1] + 3 * b2[1]];
      const C3 = [-b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0], -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1]];
      const d1 = cross(C2, C3),
        d2 = cross(C3, C1),
        d3 = cross(C1, C2);
      // d1, d2, d3 are cross products of the curve's difference vectors, so they carry LENGTH
      // SQUARED: against the segment's own extent squared they say whether the control points are
      // collinear, which is a straight line drawn as a cubic -- no curve, no crescent, and no
      // implicit needed at all.
      let ex0 = 0;
      for (const p of sg.P)
        for (const q of sg.P) ex0 = Math.max(ex0, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
      const dRel = ex0 > 0 ? (Math.abs(d1) + Math.abs(d2) + Math.abs(d3)) / (ex0 * ex0) : 0;
      if (dRel < 1e-6) straight++;
      relAll.push(dRel);
      const scale = Math.abs(d1) + Math.abs(d2) + Math.abs(d3);
      if (!(scale > 0)) {
        cls.set('all d zero (a LINE)', (cls.get('all d zero (a LINE)') || 0) + 1);
        decl++;
        continue;
      }
      const disc0 = 3 * d2 * d2 - 4 * d1 * d3;
      const smallD1 = Math.abs(d1) < KLMN_MIN * scale;
      const smallDisc = Math.abs(disc0) < KLMN_MIN * 10 * scale * scale;
      allD1.push(Math.abs(d1) / scale);
      allDisc.push(Math.abs(disc0) / (scale * scale));
      if (!smallD1 && !smallDisc) continue;
      decl++;
      // Loop-Blinn's rows: d1 = 0 with d2 = 0 is a LINE or QUADRATIC; d1 = 0 with d2 != 0 is the
      // quadratic/cusp-at-infinity row; a vanishing discriminant with d1 != 0 is the CUSP row.
      const smallD2 = Math.abs(d2) < KLMN_MIN * scale;
      const key =
        smallD1 && smallD2
          ? 'd1~0 and d2~0  -> LINE / QUADRATIC row'
          : smallD1
            ? 'd1~0, d2 real   -> QUADRATIC (cusp at infinity) row'
            : 'disc~0, d1 real -> CUSP row';
      cls.set(key, (cls.get(key) || 0) + 1);
      // How flat is it really? The cubic term against the curve's own extent says whether the
      // degree-3 part is geometry or rounding.
      let ex = 0;
      for (const p of sg.P)
        for (const q of sg.P) ex = Math.max(ex, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
      if (ex > 0) flat.push(Math.hypot(C3[0], C3[1]) / ex);
    }
}
console.log(
  `${tot} cubic segments, ${decl} decline cubicKLMN and fall to the Bezout resultant (${((100 * decl) / Math.max(1, tot)).toFixed(1)}%)`,
);
for (const [k, v] of [...cls].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(44)} ${v}`);
flat.sort((a, b) => a - b);
const q = (f) =>
  flat.length ? flat[Math.min(flat.length - 1, Math.floor(f * flat.length))].toFixed(4) : 'n/a';
console.log(`  |C3| over the curve's own extent (how much degree-3 there is at all):`);
console.log(`    median ${q(0.5)}   p90 ${q(0.9)}   max ${q(1)}`);

// The two quantities the decline turns on, over every cubic -- so "the bar is too tight" and "the
// curves really are degenerate" can be told apart.
const qq = (a, f) => {
  a.sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))].toExponential(2) : 'n/a';
};
console.log(
  `  |d1|/scale over all ${allD1.length} cubics:      p10 ${qq(allD1, 0.1)}  median ${qq(allD1, 0.5)}  p90 ${qq(allD1, 0.9)}`,
);
console.log(
  `  |disc|/scale^2 over all ${allDisc.length} cubics: p10 ${qq(allDisc, 0.1)}  median ${qq(allDisc, 0.5)}  p90 ${qq(allDisc, 0.9)}`,
);

console.log(
  `  control points COLLINEAR (a straight line written as a cubic): ${straight} of ${tot} (${((100 * straight) / Math.max(1, tot)).toFixed(1)}%)`,
);
console.log(
  `  |d|sum / extent^2:  p10 ${qq(relAll, 0.1)}  median ${qq(relAll, 0.5)}  p90 ${qq(relAll, 0.9)}`,
);
