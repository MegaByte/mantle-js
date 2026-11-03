// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLbWedgeWhy — is an LB wedge DROPPED GEOMETRY or a shading error? The two need different fixes
// and cost differently: geometry is triangles at build time and LB stays fast; shading is ALU per
// fragment and LB pays the way CPatch just did for its hull rows.
//
// The test is the mesh itself. Build the shape's LB mesh in node, and ask whether any triangle of
// it contains the wedge's pixel. Covered means the geometry is there and the KERNEL painted it
// wrong; not covered means the mesh never had it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const cf32 = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const vb = sec.viewBox,
  SC = vb[2] / N;
const PTS = (process.env.PTS || '332,177 342,245 336,286 177,214')
  .split(' ')
  .map((q) => q.split(',').map(Number));

for (const [px, py] of PTS) {
  const cx = vb[0] + (px + 0.5) * SC,
    cy = vb[1] + (N - 1 - py + 0.5) * SC;
  // WHICH SHAPE OWNS THE PIXEL: the topmost in document order whose path contains it.
  let owner = -1;
  for (let s = 0; s < meta.numShapes; s++) {
    const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
    if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
    let cs = null;
    try {
      cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
    } catch {
      cs = null;
    }
    if (!cs || !cs.length) continue;
    const all = [];
    for (const c of cs) for (const sg of c) all.push(sg);
    for (const sp of rowSpans(all, cy) || [])
      if (cx >= sp[0] && cx <= sp[1]) {
        owner = s;
        break;
      }
  }
  if (owner < 0) {
    console.log(`(${px},${py}) em (${cx.toFixed(2)},${cy.toFixed(2)}): no shape covers it`);
    continue;
  }
  const r = sec.curveRangesByShape[owner];
  const contours = curveRangeToContours(cf32, r.begin | 0, r.end | 0);
  const evenOdd = meta.metaFloats[owner * meta.floatsPerShape + 13] > 0.5;
  let mesh = null;
  try {
    mesh = buildLoopBlinnCDT(contours, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch (e) {
    mesh = { _err: e.message };
  }
  if (!mesh || mesh._err) {
    console.log(`(${px},${py}) s${owner}: LB build failed (${mesh && mesh._err})`);
    continue;
  }
  // Interior triangles first -- a solid wedge is interior fill, not a curve crescent.
  const tri = mesh.interior || new Float32Array(0);
  let hit = 0;
  for (let t = 0; t + 5 < tri.length; t += 6) {
    const A = [tri[t], tri[t + 1]],
      B = [tri[t + 2], tri[t + 3]],
      C = [tri[t + 4], tri[t + 5]];
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    const d1 = d(A, B, [cx, cy]),
      d2 = d(B, C, [cx, cy]),
      d3 = d(C, A, [cx, cy]);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) hit++;
  }
  const nq = (mesh.quads || []).length,
    nc = (mesh.cubics || []).length,
    nf = (mesh.fallback || []).length;
  console.log(
    `(${px},${py}) s${owner} em (${cx.toFixed(2)},${cy.toFixed(2)}): ${tri.length / 6} interior tris,` +
      ` ${nq} quads, ${nc} cubics, ${nf} fallback  ->  ${hit} interior triangle(s) contain the pixel` +
      `   ${hit ? 'GEOMETRY IS THERE (a shading error)' : 'NO GEOMETRY (dropped fill)'}`,
  );
}
