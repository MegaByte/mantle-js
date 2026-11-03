// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzS82 — one shape, one point: which of its cover quads reaches the fragment, and what does the
// patch behind that quad say there? The mesh is what the GPU rasterises, so this asks the mesh.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter, shapeEvenOdd } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape, CP_BLOCK_TEXELS } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { patchCoverHull } from '../src/renderer/cpatchConvert.js';

const N = +(process.env.N || 512);
const S = +(process.env.S || 82);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
// THE FLOAT64 PLANE, which is what the build converts (cpatchCurvePlane). Converting the
// float32 wire plane instead rounds the inputs first and gives a DIFFERENT decomposition -- so a
// probe that reads it is modelling a shape the renderer never packed.
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const vb = sec.viewBox,
  SC = vb[2] / N;
const r = sec.curveRangesByShape[S];
const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
const ps = [];
const m = packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
console.log(
  `shape ${S}: ${cs.length} contours, ${ps.length} patches, mesh ${m ? m.vertexCount : 0} verts,` +
    ` ${m ? m.texels.length / (CP_BLOCK_TEXELS * 4) : 0} blocks`,
);
let bx0 = Infinity,
  by0 = Infinity,
  bx1 = -Infinity,
  by1 = -Infinity;
for (const c of cs)
  for (const sg of c)
    for (const P of sg.P) {
      if (P[0] < bx0) bx0 = P[0];
      if (P[0] > bx1) bx1 = P[0];
      if (P[1] < by0) by0 = P[1];
      if (P[1] > by1) by1 = P[1];
    }
console.log(
  `  path bbox  [${bx0.toFixed(1)}, ${by0.toFixed(1)}] .. [${bx1.toFixed(1)}, ${by1.toFixed(1)}]`,
);
// THE MESH'S own EXTENT, dilation included: v[0..1] is the vertex and v[2..3] the px-space offset
// direction the vertex shader scales by 1.5px. A quad that reaches a fragment the patch rejects is
// harmless; one that reaches a fragment the patch ACCEPTS is the leak.
const ST = m.verts.length / m.vertexCount;
let mx0 = Infinity,
  my0 = Infinity,
  mx1 = -Infinity,
  my1 = -Infinity;
for (let v = 0; v < m.vertexCount; v++) {
  const o = v * ST,
    x = m.verts[o] + m.verts[o + 17] + m.verts[o + 2] * 1.5 * SC,
    y = m.verts[o + 1] + m.verts[o + 18] + m.verts[o + 3] * 1.5 * SC;
  if (x < mx0) mx0 = x;
  if (x > mx1) mx1 = x;
  if (y < my0) my0 = y;
  if (y > my1) my1 = y;
}
console.log(
  `  mesh bbox  [${mx0.toFixed(1)}, ${my0.toFixed(1)}] .. [${mx1.toFixed(1)}, ${my1.toFixed(1)}]  (stride ${ST})`,
);
for (const q of (process.env.PTS || '257,327').split(' ')) {
  const [i, j] = q.split(',').map(Number);
  const cx = (i + 0.5) * SC,
    cy = (N - 1 - j + 0.5) * SC;
  // which TRIANGLE of the mesh contains it, dilated as the vertex shader dilates it
  const hit = [];
  for (let t = 0; t + 2 < m.vertexCount; t += 3) {
    const P = [0, 1, 2].map((u) => {
      const o = (t + u) * ST;
      return [
        m.verts[o] + m.verts[o + 17] + m.verts[o + 2] * 1.5 * SC,
        m.verts[o + 1] + m.verts[o + 18] + m.verts[o + 3] * 1.5 * SC,
      ];
    });
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    const d1 = d(P[0], P[1], [cx, cy]),
      d2 = d(P[1], P[2], [cx, cy]),
      d3 = d(P[2], P[0], [cx, cy]);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0))
      hit.push({ t, first: m.verts[t * ST + 19], n: m.verts[t * ST + 20] });
  }
  console.log(
    `  (${i},${j}) em (${cx.toFixed(2)},${cy.toFixed(2)}): ${hit.length} triangles reach it` +
      hit
        .slice(0, 4)
        .map((h) => ` [tri ${h.t / 3} first ${h.first} blocks ${h.n}]`)
        .join(''),
  );
  let best = 0,
    which = -1;
  for (let k = 0; k < ps.length; k++) {
    const c = patchCoverage(ps[k], cx, cy, SC);
    if (c > best) {
      best = c;
      which = k;
    }
  }
  console.log(`     model: best patch ${which} cov ${best.toFixed(3)}`);
  // and the patch whose hull is NEAREST, so a quad that reaches far is visible as such
  let nd = Infinity,
    np = -1;
  for (let k = 0; k < ps.length; k++) {
    const H = patchCoverHull(ps[k].curves, 16);
    if (!H) continue;
    let far = -Infinity,
      ccx = 0,
      ccy = 0;
    for (const p2 of H) {
      ccx += p2[0];
      ccy += p2[1];
    }
    ccx /= H.length;
    ccy /= H.length;
    for (let u = 0; u < H.length; u++) {
      const a = H[u],
        b = H[(u + 1) % H.length];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        L = Math.hypot(dx, dy);
      if (L < 1e-12) continue;
      let nx = -dy / L,
        ny = dx / L;
      if (nx * (ccx - a[0]) + ny * (ccy - a[1]) < 0) {
        nx = -nx;
        ny = -ny;
      }
      const sd = -(nx * (cx - a[0]) + ny * (cy - a[1])) / SC;
      if (sd > far) far = sd;
    }
    if (far < nd) {
      nd = far;
      np = k;
    }
  }
  console.log(`     nearest patch hull: patch ${np} at ${nd.toFixed(2)}px outside`);
}
