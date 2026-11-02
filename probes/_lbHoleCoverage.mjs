// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/_lbHoleCoverage.mjs — the same mesh-level under-fill localizer as _lbMeshCoverage, but
// fed a HOLED shape directly instead of a glyph dump.
//
// Chasing unifiedFillFeatureSmoke's long-standing `evenOdd` failure, which is not about even-odd:
// Loop-Blinn paints a hole one pixel too large (Slug 207/255 at the boundary, LB 0), under either
// fill rule. This asks the question one level below the shader — does the MESH cover the ink, or
// is the geometry itself missing along the inner contour? A miss here is a build bug; no misses
// would move the search to per-fragment coverage.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { rayWinding } from '../src/geom/lbContour.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = (p1, p2, p3, p4) => ({ type: 2, p1, p2, p3, p4 });
const K = 0.5522847498307936;
const circle = (cx, cy, r) => {
  // a TRUE circle, kappa controls
  const k = r * K;
  return [
    C([cx, cy - r], [cx + k, cy - r], [cx + r, cy - k], [cx + r, cy]),
    C([cx + r, cy], [cx + r, cy + k], [cx + k, cy + r], [cx, cy + r]),
    C([cx, cy + r], [cx - k, cy + r], [cx - r, cy + k], [cx - r, cy]),
    C([cx - r, cy], [cx - r, cy - k], [cx - k, cy - r], [cx, cy - r]),
  ];
};
const rev = (segs) =>
  segs
    .slice()
    .reverse()
    .map((s) => C(s.p4, s.p3, s.p2, s.p1));
// The SMOKE'S fixture: fat squircles, not circles. That matters — a true circle pair is consumed
// by extractAnnuli into an SDF ring and never builds a mesh at all (this localizer then reports
// everything uncovered, which is what it did first). fitCircularContour rejects these at ~10%
// deviation against its 0.002*r bar, so they take the real Loop-Blinn build.
const SQ_OUT = [
  C([20, 4], [31, 4], [36, 9], [36, 20]),
  C([36, 20], [36, 31], [31, 36], [20, 36]),
  C([20, 36], [9, 36], [4, 31], [4, 20]),
  C([4, 20], [4, 9], [9, 4], [20, 4]),
];
const SQ_IN = [
  C([20, 12], [26, 12], [28, 14], [28, 20]),
  C([28, 20], [28, 26], [26, 28], [20, 28]),
  C([20, 28], [14, 28], [12, 26], [12, 20]),
  C([12, 20], [12, 14], [14, 12], [20, 12]),
];
const SHAPE = process.env.SHAPE || 'squircle';
const OUTER = SHAPE === 'circle' ? circle(20, 20, 16) : SQ_OUT;
// REVERSED inner contour: opposite winding is the classic nonzero hole. The same defect shows
// under evenodd with a same-wound inner, so the rule is not what decides it.
const INNER = SHAPE === 'circle' ? circle(20, 20, 8) : SQ_IN;
const contours = [OUTER, process.env.SAME_WOUND ? INNER : rev(INNER)];
const evenodd = process.env.SAME_WOUND ? 'evenodd' : false;

console.time('build');
const built = buildLbShape(contours, true, evenodd);
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
// WHICH CONTOUR did each curve triangle come from? The render says the inner boundary has no
// curve fragment at all — only interior ones, stopping ~1px outside the arc — so the question is
// whether the inner contour produced curve geometry and it fails to rasterize, or never produced
// any. Centroid radius separates them: the inner contour lives near r=8, the outer near r=16.
{
  const cen = (t) => [(t[0] + t[2] + t[4]) / 3, (t[1] + t[3] + t[5]) / 3];
  const bucket = { innerCubic: 0, outerCubic: 0, innerInterior: 0, outerInterior: 0 };
  for (const c of mesh.cubics || [])
    if (c.hull)
      for (let i = 0; i + 5 < c.hull.length; i += 6) {
        const [cx, cy] = cen(Array.from(c.hull).slice(i, i + 6));
        Math.hypot(cx - 20, cy - 20) < 12 ? bucket.innerCubic++ : bucket.outerCubic++;
      }
  if (mesh.interior)
    for (let i = 0; i + 5 < mesh.interior.length; i += 6) {
      const [cx, cy] = cen(Array.from(mesh.interior).slice(i, i + 6));
      Math.hypot(cx - 20, cy - 20) < 12 ? bucket.innerInterior++ : bucket.outerInterior++;
    }
  console.log(
    'curve tris near the INNER contour:',
    bucket.innerCubic,
    ' near the OUTER:',
    bucket.outerCubic,
  );
  console.log(
    'interior tris near INNER:',
    bucket.innerInterior,
    ' near OUTER:',
    bucket.outerInterior,
  );
}
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
