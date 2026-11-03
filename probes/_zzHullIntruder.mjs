// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzHullIntruder — is the over-paint the ten-point audit misses caused by ANOTHER PART OF THE
// SHAPE passing through a crescent's hull triangle?
//
// A Loop-Blinn hull crescent paints the region between its chord and its arc. That is the shape's
// ink only while nothing else of the shape's boundary runs through the triangle: the model has one
// curve per piece and no way to represent a second edge cutting across it. On a thin feature the
// FAR SIDE of the shape is inside the crescent's own hull, and the piece paints straight over it --
// which is exactly what tiger's shape 181 draws, a solid wedge alongside a thin diagonal band,
// widening along the curve.
//
// Exact: a Bezier crosses a triangle iff it meets one of the three edges, or lies wholly inside
// (its start point inside is enough, given no crossing). Meeting a LINE is a univariate cubic in
// the segment's own parameter -- exact roots, no sampling.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { solveCubicInUnit } from '../src/svg/pathBoolean/polyRoots.js';
import { segPt } from '../src/geom/cpatchImplicit.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);

// The segment's coordinates as a cubic in t (a line/quad is the degenerate case), so the signed
// distance to a line is one cubic in t and its roots are exact.
function segCubicXY(sg) {
  const P = sg.P;
  if (P.length === 4) return P;
  if (P.length === 3)
    return [
      P[0],
      [P[0][0] + (2 / 3) * (P[1][0] - P[0][0]), P[0][1] + (2 / 3) * (P[1][1] - P[0][1])],
      [P[2][0] + (2 / 3) * (P[1][0] - P[2][0]), P[2][1] + (2 / 3) * (P[1][1] - P[2][1])],
      P[2],
    ];
  return [P[0], P[0], P[1], P[1]];
}
function crossesTriangle(sg, H, n) {
  const C = segCubicXY(sg);
  for (let i = 0; i < n; i++) {
    const ax = H[2 * i],
      ay = H[2 * i + 1];
    const bx = H[(2 * i + 2) % (2 * n)],
      by = H[(2 * i + 3) % (2 * n)];
    let nx = -(by - ay),
      ny = bx - ax;
    const L = Math.hypot(nx, ny);
    if (!(L > 0)) continue;
    nx /= L;
    ny /= L;
    // Signed distance of the segment to the edge's line, as a cubic in t (Bernstein -> power).
    const d = C.map((p) => nx * (p[0] - ax) + ny * (p[1] - ay));
    const a3 = -d[0] + 3 * d[1] - 3 * d[2] + d[3];
    const b3 = 3 * d[0] - 6 * d[1] + 3 * d[2];
    const c3 = -3 * d[0] + 3 * d[1];
    for (const t of solveCubicInUnit(a3, b3, c3, d[0]) || []) {
      const q = segPt(sg, t);
      // ...and the hit must be BETWEEN the edge's endpoints, not on its extension.
      const u =
        ((q[0] - ax) * (bx - ax) + (q[1] - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
      if (u > 1e-9 && u < 1 - 1e-9 && t > 1e-9 && t < 1 - 1e-9) return true;
    }
  }
  return false;
}

const GUILTY = new Set((process.env.GUILTY || '').split(',').filter(Boolean).map(Number));
const rows = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (!m || !m.cubics || !m.cubics.length) continue;
  let segs = null;
  try {
    const cvv = contoursToConverter(cs, null);
    segs = [];
    for (const c of cvv) for (const sg of c) segs.push(sg);
  } catch {
    continue;
  }
  let hit = 0;
  for (const c9 of m.cubics) {
    const H = c9.hull,
      n = H.length / 2;
    if (n < 3) continue;
    // The piece's own arc is in the triangle by construction; so is whatever shares an endpoint
    // with it, which meets the hull only at a corner. Judge on the rest.
    const own = c9.cp ? [c9.cp[0], c9.cp[3]] : [];
    const near = (p) => own.some((e) => Math.hypot(p[0] - e[0], p[1] - e[1]) < 1e-7);
    for (const sg of segs) {
      const A = segPt(sg, 0),
        B = segPt(sg, 1);
      if (near(A) || near(B)) continue;
      if (crossesTriangle(sg, H, n)) {
        hit++;
        break;
      }
    }
  }
  rows.push({ s, hit, pieces: m.cubics.length });
}
const flagged = rows.filter((r) => r.hit > 0);
console.log(
  `${rows.length} LB-routed shapes; ${flagged.length} have a crescent whose hull another part of the shape runs through`,
);
if (GUILTY.size) {
  const g = rows.filter((r) => GUILTY.has(r.s)),
    c = rows.filter((r) => !GUILTY.has(r.s));
  const hit = g.filter((r) => r.hit > 0).length,
    fp = c.filter((r) => r.hit > 0).length;
  console.log(
    `  of the ${g.length} shapes MEASURED to over-paint alone, it flags ${hit} (${((100 * hit) / Math.max(1, g.length)).toFixed(0)}%)`,
  );
  console.log(
    `  of the ${c.length} measured CLEAN, it flags ${fp} (${((100 * fp) / Math.max(1, c.length)).toFixed(0)}%)`,
  );
}
console.log(
  '  worst: ' +
    flagged
      .sort((a, b) => b.hit - a.hit)
      .slice(0, 12)
      .map((r) => `s${r.s}:${r.hit}/${r.pieces}`)
      .join(' '),
);
