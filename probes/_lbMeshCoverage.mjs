#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// probes/_lbMeshCoverage.mjs — node-side mesh coverage check: build a glyph's
// LB mesh from dumped contours and report interior sample points (CPU winding
// says INK) that no emitted fill geometry covers (interior tris, curve-hull
// tris, curveTris) — the mesh-level under-fill localizer.
// Usage: node probes/_lbMeshCoverage.mjs D
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { rayWinding } from '../src/geom/lbContour.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(path.join(ROOT, 'probes/_glyphContours.json'), 'utf8'));
const ch = process.argv[2] || 'D';
const shapes = data[ch];
if (!shapes) {
  console.error('no dump for', ch);
  process.exit(1);
}

const revive = (c) =>
  c.map((s) => {
    const o = { type: s.type, p1: s.p1, p2: s.p2 };
    if (s.p3) o.p3 = s.p3;
    if (s.p4) o.p4 = s.p4;
    if (s.w != null) o.w = s.w;
    return o;
  });
const contours = shapes[0].map(revive);

console.time('build');
const built = buildLbShape(contours, true, false);
const mesh = built && built.raw ? built.raw : built;
console.timeEnd('build');
if (!mesh || mesh.slug) {
  console.log('SLUG sentinel — no mesh');
  process.exit(0);
}

// gather fill-side triangles: interior + quad hulls + cubic hulls + curveTris
const tris = [];
const pushFlat = (arr) => {
  for (let i = 0; i + 5 < arr.length; i += 6)
    tris.push([arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5]]);
};
if (mesh.interior) pushFlat(mesh.interior);
let nQ = 0,
  nC = 0,
  nCirc = 0;
for (const q of mesh.quads || []) {
  nQ++;
  if (q.tri) pushFlat(Array.from(q.tri));
}
for (const c of mesh.cubics || []) {
  nC++;
  if (c.hull) pushFlat(Array.from(c.hull));
}
if (mesh.circles) nCirc = mesh.circles.length;
console.log(
  'interior tris:',
  (mesh.interior ? mesh.interior.length / 6 : 0) | 0,
  'quads:',
  nQ,
  'cubics:',
  nC,
  'circles:',
  nCirc,
  'edges:',
  (mesh.edges || []).length,
  'fallback:',
  (mesh.fallback || []).length,
);

const inTri = (px, py, t) => {
  const [ax, ay, bx, by, cx, cy] = t;
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (
    (s1 >= -1e-12 && s2 >= -1e-12 && s3 >= -1e-12) || (s1 <= 1e-12 && s2 <= 1e-12 && s3 <= 1e-12)
  );
};

// bbox + sample grid
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
for (const c of contours)
  for (const s of c)
    for (const p of [s.p1, s.p2, s.p3, s.p4]) {
      if (!p) continue;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
const G = 160;
const dx = (x1 - x0) / G,
  dy = (y1 - y0) / G;
const miss = [];
let inkN = 0;
for (let gy = 0; gy <= G; gy++)
  for (let gx = 0; gx <= G; gx++) {
    const px = x0 + gx * dx,
      py = y0 + gy * dy;
    let wsum = 0;
    for (const c of contours) wsum += rayWinding(c, px, py);
    if (wsum === 0) continue;
    inkN++;
    let covered = false;
    for (const t of tris) {
      if (inTri(px, py, t)) {
        covered = true;
        break;
      }
    }
    if (!covered) miss.push([+px.toFixed(4), +py.toFixed(4)]);
  }
console.log('ink samples:', inkN, 'UNCOVERED:', miss.length);
// ASCII mask of misses over the sample grid
{
  const rows = [];
  for (let gy = 0; gy <= G; gy += 2) {
    let row = '';
    for (let gx = 0; gx <= G; gx += 2) {
      const px = x0 + gx * dx,
        py = y0 + gy * dy;
      let wsum = 0;
      for (const c of contours) wsum += rayWinding(c, px, py);
      if (wsum === 0) {
        row += '.';
        continue;
      }
      let covered = false;
      for (const t of tris) {
        if (inTri(px, py, t)) {
          covered = true;
          break;
        }
      }
      row += covered ? '#' : Math.abs(wsum) > 1 ? 'W' : 'o';
    }
    rows.push(row);
  }
  console.log(rows.join('\n'));
}
if (miss.length) {
  // cluster summary: bbox of misses
  let mx0 = Infinity,
    my0 = Infinity,
    mx1 = -Infinity,
    my1 = -Infinity;
  for (const [px, py] of miss) {
    if (px < mx0) mx0 = px;
    if (px > mx1) mx1 = px;
    if (py < my0) my0 = py;
    if (py > my1) my1 = py;
  }
  console.log(
    'miss bbox:',
    [mx0, my0, mx1, my1].map((v) => +v.toFixed(3)),
  );
  console.log('first misses:', JSON.stringify(miss.slice(0, 8)));
}
// vertex-count tally via the returned pack
const pk = built && built.pk;
if (pk && pk.verts) {
  const kinds = {};
  for (let i = 0; i < pk.vertexCount; i++) {
    const k = Math.floor(pk.verts[i * 24 + 5] + 0.001);
    kinds[k] = (kinds[k] || 0) + 1;
  }
  console.log('packed verts:', pk.vertexCount, 'kinds:', JSON.stringify(kinds));
}
