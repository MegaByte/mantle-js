// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _partitionTjunctions — the partition's hull crescents never pass through `healCracks`, so do
// they leave T-junctions, and does anything drop through them?
//
// `healCracks` is called from `buildLoopBlinnMesh` only (lbFastMesh.js, and the ramped path in
// loopBlinn.js). `lbPartition.js` does not call it at all. So a partition-built shape keeps every
// T-junction the carve leaves, and a dropped pixel is a real T-junction at
// distance ZERO: a vertex of one face lying strictly ON another face's edge, where the two
// rasterizations disagree by one pixel row.
//
// WHAT IS COUNTED, per shape:
//   tjunc   a mesh vertex lying strictly INSIDE another face's edge (not at either end), within
//           the builder's own vertex quantum of that edge -- the exact condition that makes a
//           shared boundary non-conforming. Scale-free: the quantum is `emUnitsOf().res`.
//   route   which builder produced the mesh, so the fast path (healed) and the partition
//           (unhealed) can be compared rather than asserted about.
//   miss    px^2 of paint the mesh does not put down over pixels the path covers FULLY, from the
//           same solo raster the AA audit uses -- the only thing that decides whether a T-junction
//           is a defect or bookkeeping.
//
//   node probes/lbAccuracy/_partitionTjunctions.mjs [file.svg ...]    CANVAS=512
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { loadSvg, shapesOf, viewOf, buildMesh, rasterMesh, ROOT } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';
import { decodeVert } from './_lbKernel.mjs';

console.warn = () => {};
const { emUnitsOf } = await import('../../src/geom/lbContour.js');
const CANVAS = +(process.env.CANVAS || 512);
const SLICES = +(process.env.SLICES || 64);

let files = process.argv.slice(2);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench')];
}

/// Vertices lying strictly inside another face's edge. O(V * E) with a grid over the edges.
function tjunctions(pk, res) {
  const V = [],
    E = [];
  const n = pk.vertexCount;
  for (let t = 0; t + 2 < n; t += 3) {
    const P = [0, 1, 2].map((q) => decodeVert(pk.verts, t + q).pos);
    for (const p of P) V.push(p);
    for (let k = 0; k < 3; k++) E.push([P[k], P[(k + 1) % 3]]);
  }
  if (!E.length) return 0;
  const cell = Math.max(res * 64, 1e-12);
  const grid = new Map();
  const ck = (x, y) => Math.floor(x / cell) * 262147 + Math.floor(y / cell);
  for (let i = 0; i < E.length; i++) {
    const [A, B] = E[i];
    const x0 = Math.floor(Math.min(A[0], B[0]) / cell),
      x1 = Math.floor(Math.max(A[0], B[0]) / cell);
    const y0 = Math.floor(Math.min(A[1], B[1]) / cell),
      y1 = Math.floor(Math.max(A[1], B[1]) / cell);
    if (x1 - x0 > 512 || y1 - y0 > 512) continue; // a degenerate span: skip
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = x * 262147 + y;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(i);
      }
  }
  const seen = new Set();
  let hits = 0;
  for (const p of V) {
    const a = grid.get(ck(p[0], p[1]));
    if (!a) continue;
    for (const ei of a) {
      const [A, B] = E[ei];
      const dx = B[0] - A[0],
        dy = B[1] - A[1],
        L2 = dx * dx + dy * dy;
      if (L2 < res * res) continue;
      const L = Math.sqrt(L2);
      // strictly interior to the edge: at least one quantum from either end
      const s = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
      if (s * L < res || (1 - s) * L < res) continue;
      const cx = A[0] + s * dx - p[0],
        cy = A[1] + s * dy - p[1];
      if (cx * cx + cy * cy > res * res) continue;
      const key = `${Math.round(p[0] / res)},${Math.round(p[1] / res)},${ei}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits++;
    }
  }
  return hits;
}

const kit = await refKit();
console.log(
  `CANVAS=${CANVAS}\n  asset                          shape   route            verts  T-junctions   miss px^2`,
);
let totP = 0,
  totF = 0,
  tjP = 0,
  tjF = 0,
  missP = 0,
  missF = 0,
  shapesP = 0,
  shapesF = 0;
for (const f of files) {
  let bundle = null;
  try {
    bundle = await loadSvg(f);
  } catch {
    continue;
  }
  let shapes = [],
    bbox = null;
  try {
    ({ shapes, bbox } = await shapesOf(bundle));
  } catch {
    continue;
  }
  if (!shapes.length) continue;
  const view = viewOf(bbox, CANVAS);
  for (const sh of shapes) {
    let built = null;
    try {
      built = await buildMesh(sh);
    } catch {
      built = null;
    }
    if (!built) continue;
    const route = built.raw._route || (built.raw.interiorChainA ? 'partition' : 'fast');
    const res = emUnitsOf(sh.contours).res;
    const tj = tjunctions(built.pk, res);
    const part = /partition|carve/.test(route);
    if (part) {
      shapesP++;
      tjP += tj;
      totP++;
    } else {
      shapesF++;
      tjF += tj;
      totF++;
    }
    if (!tj) continue;
    // Only score a shape that HAS a T-junction: that is the population the item is about.
    const cv = kit.contoursToConverter(sh.contours, null);
    let miss = 0;
    if (cv) {
      const curves = kit.closed(cv);
      const acc = new Float64Array(CANVAS * CANVAS).fill(1);
      rasterMesh(built.pk, view, acc, {}, null, null, null);
      const rc = new Map();
      for (let j = 0; j < CANVAS; j++) {
        rc.clear();
        for (let i = 0; i < CANVAS; i++) {
          const ex = exactCov(kit.rowSpans, curves, i, j, view, SLICES, sh.evenOdd, rc);
          if (ex >= 1 - 1e-6) {
            const mo = 1 - acc[j * CANVAS + i];
            if (mo < 1) miss += 1 - mo;
          }
        }
      }
    }
    if (part) missP += miss;
    else missF += miss;
    console.log(
      `  ${f.split('/').pop().padEnd(30)} ${String(sh.s).padStart(5)}   ${route.padEnd(15)}  ${String(built.pk.vertexCount).padStart(5)}` +
        `  ${String(tj).padStart(11)}   ${miss.toFixed(3).padStart(9)}`,
    );
  }
}
console.log(
  `\n  PARTITION meshes: ${shapesP} shapes, ${tjP} T-junctions, ${missP.toFixed(2)} px^2 missing on the ones that have any`,
);
console.log(
  `  FAST (healed)   : ${shapesF} shapes, ${tjF} T-junctions, ${missF.toFixed(2)} px^2 missing on the ones that have any`,
);
console.log(`
  READ IT AS A PAIR. The fast path runs healCracks and the partition does not, so the fast column is
  the control: a T-junction count there is the healer's residue, and the partition's is the question.
  The miss column is what decides whether it matters -- a T-junction that drops no pixel is
  bookkeeping, and a dropped pixel IS one at distance zero.`);
