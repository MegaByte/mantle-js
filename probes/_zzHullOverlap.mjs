// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzHullOverlap — the invariant Loop-Blinn's fill rests on, and how often this asset breaks it.
//
// A curve piece paints (its face) INTERSECT (its own implicit < 0). That equals the shape's ink
// only while the face carries ONE arc: two arcs through the same region need the intersection of
// two half-spaces, and a Loop-Blinn face has room for one implicit. The builder knows the hulls
// overlap -- it resolves ownership by nearest chord -- so in an overlap region one arc is painted
// and the other is simply not represented, which is over-paint by construction rather than by any
// numerical accident.
//
// The invariant: control hulls of non-adjacent segments must be DISJOINT. Convex hulls, so the
// separating-axis test on their edge normals is exact and decides it outright.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const GUILTY = new Set((process.env.GUILTY || '').split(',').filter(Boolean).map(Number));

// Separating-axis on two convex point sets. Exact up to floating point, and a shared endpoint
// touches rather than overlaps, so a strictly-positive gap on any axis separates.
function overlaps(A, B) {
  for (const [P, Q] of [
    [A, B],
    [B, A],
  ]) {
    for (let i = 0; i < P.length; i++) {
      const a = P[i],
        b = P[(i + 1) % P.length];
      let nx = -(b[1] - a[1]),
        ny = b[0] - a[0];
      const L = Math.hypot(nx, ny);
      if (!(L > 0)) continue;
      nx /= L;
      ny /= L;
      let p0 = Infinity,
        p1 = -Infinity,
        q0 = Infinity,
        q1 = -Infinity;
      for (const p of P) {
        const d = nx * p[0] + ny * p[1];
        if (d < p0) p0 = d;
        if (d > p1) p1 = d;
      }
      for (const q of Q) {
        const d = nx * q[0] + ny * q[1];
        if (d < q0) q0 = d;
        if (d > q1) q1 = d;
      }
      const gap = Math.max(q0 - p1, p0 - q1);
      if (gap > 1e-9 * Math.max(1, Math.abs(p1 - p0))) return false;
    }
  }
  return true;
}
function hullOf(sg) {
  const P = sg.P.map((p) => [p[0], p[1]]);
  // Andrew monotone chain; four points at most, so this is trivial and exact.
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [],
    up = [];
  for (const p of P) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  lo.pop();
  up.pop();
  const h = lo.concat(up);
  return h.length >= 3 ? h : P;
}

const rows = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  let cv = null;
  try {
    cv = contoursToConverter(cs, null);
  } catch {
    continue;
  }
  if (!cv || !cv.length) continue;
  // Curved segments only: a LINE has no crescent and no implicit, so its hull is not a painter.
  const segs = [];
  for (const c of cv) for (const sg of c) if (sg.t !== 'line') segs.push(sg);
  if (segs.length < 2) {
    rows.push({ s, pairs: 0, segs: segs.length });
    continue;
  }
  const H = segs.map(hullOf);
  const ends = segs.map((sg) => [sg.P[0], sg.P[sg.P.length - 1]]);
  const shares = (i, j) =>
    ends[i].some((a) => ends[j].some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7));
  let pairs = 0;
  for (let i = 0; i < H.length; i++)
    for (let j = i + 1; j < H.length; j++) {
      if (shares(i, j)) continue; // neighbours meet at a point, which is not an overlap
      if (overlaps(H[i], H[j])) pairs++;
    }
  rows.push({ s, pairs, segs: segs.length });
}
const flagged = rows.filter((r) => r.pairs > 0);
console.log(
  `${rows.length} shapes; ${flagged.length} have two non-adjacent curve hulls that OVERLAP`,
);
if (GUILTY.size) {
  const g = rows.filter((r) => GUILTY.has(r.s)),
    c = rows.filter((r) => !GUILTY.has(r.s));
  const hit = g.filter((r) => r.pairs > 0).length,
    fp = c.filter((r) => r.pairs > 0).length;
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
      .sort((a, b) => b.pairs - a.pairs)
      .slice(0, 12)
      .map((r) => `s${r.s}:${r.pairs}pairs/${r.segs}segs`)
      .join(' '),
);
