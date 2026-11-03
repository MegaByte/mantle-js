// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does the patch union reach the shape's BOUNDARY? A grid sweep cannot see a sub-pixel band --
// on a 50-unit glyph at G=128 the grid step is three pixels wide -- so this samples along the
// outline itself, a fixed fraction of a pixel inside, which is where the AA ramp has to come from.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const importSvg = (await import('../src/svg/importer.js')).default;
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { pathToCycles } = await import('../src/geom/cpatchGraph.js');
const { convertContour, inPatch, insideContour } = await import('../src/renderer/cpatchConvert.js');
const { segPt, segTangent } = await import('../src/geom/cpatchImplicit.js');

const sec = await importSvg(readFileSync(process.argv[2], 'utf8'), { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const N = +(process.env.N || 512);
const bb = sec.globalBBox || sec.bbox;
const W = bb[2] - bb[0],
  H = bb[3] - bb[1];
const arX = Math.min(1, W / H);
const pxEm = W / (N * arX); // em per device pixel
const IN = +(process.env.INSET || 0.3); // how far inside, in pixels
let tot = 0,
  miss = 0;
const bad = [];
for (let S = 0; S < sec.curveRangesByShape.length; S++) {
  const r = sec.curveRangesByShape[S];
  if (!r) continue;
  let list = null;
  try {
    list = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    continue;
  }
  if (!list || !list.length) continue;
  let cy = null;
  try {
    cy = pathToCycles(list, false);
  } catch {}
  const use = cy && cy.length ? cy : list;
  const pats = [];
  for (const c of use) {
    try {
      const rr = convertContour(c, { maxCurves: 8 });
      if (rr && rr.patches) pats.push(...rr.patches);
    } catch {}
  }
  const src = [];
  for (const c of list) for (const g of c) src.push(g);
  for (const c of list)
    for (const sg of c) {
      for (let t = 0; t <= 40; t++) {
        const u = t / 40,
          p = segPt(sg, u),
          tn = segTangent(sg, u);
        const L = Math.hypot(tn[0], tn[1]) || 1;
        // inward normal: try both, keep the one the shape contains
        for (const s of [1, -1]) {
          const nx = (-s * tn[1]) / L,
            ny = (s * tn[0]) / L;
          const qx = p[0] + nx * IN * pxEm,
            qy = p[1] + ny * IN * pxEm;
          if (!insideContour(src, qx, qy)) continue;
          tot++;
          let hit = false;
          for (const pp of pats)
            if (inPatch(pp, qx, qy)) {
              hit = true;
              break;
            }
          if (!hit) {
            miss++;
            if (bad.length < 5) bad.push([qx.toFixed(2), qy.toFixed(2)]);
          }
          break;
        }
      }
    }
}
console.log(
  `${process.argv[2].split('/').pop()}  inset ${IN}px: ${miss}/${tot} boundary samples inside the shape that NO patch covers (${((100 * miss) / Math.max(1, tot)).toFixed(1)}%)`,
);
if (bad.length) console.log('  e.g. ' + bad.map((b) => `(${b[0]},${b[1]})`).join(' '));
