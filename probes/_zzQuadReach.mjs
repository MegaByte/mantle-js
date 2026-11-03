// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzQuadReach — every shape's CPatch mesh, asked which of its triangles reach a fragment and what
// the patch behind each says there. A quad that reaches a fragment its patch rejects is harmless; a
// quad that reaches one its patch ACCEPTS, outside the shape, is ink on the wrong pixel.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
// THE FLOAT64 PLANE, which is what the build converts (cpatchCurvePlane). Converting the
// float32 wire plane instead rounds the inputs first and gives a DIFFERENT decomposition -- so a
// probe that reads it is modelling a shape the renderer never packed.
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const SC = sec.viewBox[2] / N;
const PTS = (process.env.PTS || '257,327').split(' ').map((q) => q.split(',').map(Number));
const built = [];
for (let s = 0; s < (sec.curveRangesByShape || []).length; s++) {
  const r = sec.curveRangesByShape[s];
  if (!r) continue;
  if (!(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  const ps = [];
  let m = null;
  try {
    m = packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    m = null;
  }
  if (!m) continue;
  built.push({ s, m, ps, ST: m.verts.length / m.vertexCount });
}
console.log(`${built.length} shapes packed`);
for (const [i, j] of PTS) {
  const cx = (i + 0.5) * SC,
    cy = (N - 1 - j + 0.5) * SC;
  const out = [];
  for (const b of built) {
    let reach = 0;
    for (let t = 0; t + 2 < b.m.vertexCount; t += 3) {
      const P = [0, 1, 2].map((u) => {
        const o = (t + u) * b.ST;
        return [
          b.m.verts[o] + b.m.verts[o + 17] + b.m.verts[o + 2] * 1.5 * SC,
          b.m.verts[o + 1] + b.m.verts[o + 18] + b.m.verts[o + 3] * 1.5 * SC,
        ];
      });
      const d = (a, c, e) => (c[0] - a[0]) * (e[1] - a[1]) - (e[0] - a[0]) * (c[1] - a[1]);
      const d1 = d(P[0], P[1], [cx, cy]),
        d2 = d(P[1], P[2], [cx, cy]),
        d3 = d(P[2], P[0], [cx, cy]);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) reach++;
    }
    if (!reach) continue;
    let best = 0;
    for (const p of b.ps) {
      const c = patchCoverage(p, cx, cy, SC);
      if (c > best) best = c;
    }
    out.push(`s${b.s}(${reach} tri, model ${best.toFixed(2)})`);
  }
  console.log(`(${i},${j}) em (${cx.toFixed(2)},${cy.toFixed(2)}) quads reach: ${out.join('  ')}`);
}
