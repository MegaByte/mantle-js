// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbRowCover — judge a shape's kind-0 LINE ROWS against the truth, so a mesh whose rows moved can
// be shown to be right rather than merely different.
//
// The interior split moves exactly one scale-1 mesh:
// importerScaleInvariant__svgDoc_0_0_64_64_path_d_M10_10.svg #0. It keeps its triangles (same count,
// same positions) and changes only the LINE ROWS three faces carry -- at an absolute `ownD <= 0.02` those
// faces go on to findSecondLine and pick up a second ramp line, and at an absolute `area < 0.002` a
// chip takes the reflex-union model; both constants are one float32 ulp of the shape's extent, so
// neither fires. The covered REGION is identical, so miss and over cannot move by construction; what
// can move is the RAMP, and that is what this measures.
//
// For every pixel of an NxN raster the probe computes
//   cov_mesh   the kind-0 model _lbCoverage.glsl evaluates, from the PACKED rows: one line -> the
//              area of the pixel box on its fill side; a second row with type +1 -> the box area on
//              both fill sides (intersection); type -1 -> their union; a third row by the same rule.
//              Areas are exact (the box clipped by each half-plane and shoelaced), which is what
//              exactBoxCov2 computes; faces are combined by MAX, as the draw does.
//   cov_true   area(pixel box INTERSECT path), by SxS supersampling of the path's own winding
// and reports mean |cov_mesh - cov_true| and max |...| over the painted pixels, plus the miss/over
// coverageMiss defines. Run it once per tree and compare the two tables: the arm nearer the truth is
// the better mesh.
//
// SCALE=k multiplies every contour coordinate by k before the build and divides the raster by k, so
// the same outline is measured at a different authored size. That is how an em-tuned decision is
// told from a correct one: a tolerance that is right will give the same table at both sizes.
//
//   node probes/lbEmTuned/_lbRowCover.mjs [file.svg#shape ...]        N=1024 S=16 SCALE=1
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours, rayWinding } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../../src/primitives/seg.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const N = +(process.env.N || 1024),
  S = +(process.env.S || 16);
const SPECS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['examples/smoke/importerScaleInvariant__svgDoc_0_0_64_64_path_d_M10_10.svg#0'];

// ---------------------------------------------------------------- exact box areas
/// Area of the unit box [-1/2,1/2]^2 clipped by the half-planes n.p <= c (each given as [nx,ny,c] in
/// CELL coordinates, the pixel center at the origin). Sutherland-Hodgman + shoelace: exact.
function boxArea(halves) {
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  for (const h of halves) {
    if (!poly.length) return 0;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i],
        B = poly[(i + 1) % poly.length];
      const fa = h[0] * A[0] + h[1] * A[1] - h[2],
        fb = h[0] * B[0] + h[1] * B[1] - h[2];
      if (fa <= 0) out.push(A);
      if (fa <= 0 !== fb <= 0) {
        const u = fa / (fa - fb);
        out.push([A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])]);
      }
    }
    poly = out;
  }
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    a += poly[i][0] * q[1] - q[0] * poly[i][1];
  }
  return Math.min(1, Math.max(0, Math.abs(a) * 0.5));
}
const inTri = (px, py, t, I) => {
  const ax = I[t],
    ay = I[t + 1],
    bx = I[t + 2],
    by = I[t + 3],
    cx = I[t + 4],
    cy = I[t + 5];
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
/// A row (nx, ny, c) in em, at pixel center (x, y) of size px, as a half-plane in cell coordinates.
const halfOf = (nx, ny, c, x, y, px) => [nx, ny, (c - (nx * x + ny * y)) / px];
function meshCov(m, x, y, px) {
  const I = m.interior,
    E = m.interiorEdges,
    E2 = m.interiorEdges2,
    E3 = m.interiorEdges3;
  if (!I) return 0;
  let best = 0;
  for (let t = 0, e = 0; t < I.length; t += 6, e += 9) {
    if (!inTri(x, y, t, I)) continue;
    let cov = 1;
    if (E && (E[e] !== 0 || E[e + 1] !== 0 || E[e + 2] !== 0)) {
      const h1 = halfOf(E[e], E[e + 1], E[e + 2], x, y, px);
      cov = boxArea([h1]);
      const o2 = (t / 6) * 12;
      if (E2 && (E2[o2] !== 0 || E2[o2 + 1] !== 0 || E2[o2 + 2] !== 0) && E2[o2 + 3] !== 0) {
        const h2 = halfOf(E2[o2], E2[o2 + 1], E2[o2 + 2], x, y, px);
        const cB = boxArea([h2]),
          inter = boxArea([h1, h2]);
        cov = E2[o2 + 3] > 0 ? inter : cov + cB - inter;
      }
      if (E3 && (E3[o2] !== 0 || E3[o2 + 1] !== 0 || E3[o2 + 2] !== 0) && E3[o2 + 3] !== 0) {
        const cC = boxArea([halfOf(E3[o2], E3[o2 + 1], E3[o2 + 2], x, y, px)]);
        cov = E3[o2 + 3] > 0 ? Math.max(0, cov + cC - 1) : cov + cC - cov * cC;
      }
    }
    if (cov > best) best = cov;
  }
  return best;
}

console.log(`raster ${N}x${N}, truth by ${S}x${S} supersampling`);
console.log(
  'shape                                                        faces  rows2  painted   mean|err|     max|err|    miss%    over%',
);
for (const SPEC of SPECS) {
  const [file, si] = SPEC.split('#');
  let bundle;
  try {
    bundle = await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8'));
  } catch {
    continue;
  }
  const meta = new Float32Array(bundle.meta, 32),
    mst = bundle.metaFloatsPerShape;
  const cf = new Float32Array(bundle.curves);
  const s = +si,
    r = bundle.curveRangesByShape[s],
    bb = s * mst;
  const transSolid =
    meta[bb + 7] < 0.996 &&
    Math.floor(meta[bb + 28] + 0.5) === 0 &&
    (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
  const evenOdd = meta[bb + 13] > 0.5;
  const SC = +(process.env.SCALE || 1);
  const cs0 = curveRangeToContours(cf, r.begin, r.end);
  // FRESH segments, not a spread copy: a spread carries the builders' memoised implicit and packed
  // forms along under symbols, and the scaled run would then read the unscaled shape's.
  const cs =
    SC === 1
      ? cs0
      : cs0.map((c) =>
          c.map((sg) => {
            const P = (q) => q && [q[0] * SC, q[1] * SC];
            if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
            if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
            if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
            return mkRQuad(
              P(sg.p1),
              P(sg.p2),
              P(sg.p3),
              sg.w,
              sg.circle
                ? { cx: sg.circle.cx * SC, cy: sg.circle.cy * SC, r: sg.circle.r * SC }
                : null,
            );
          }),
        );
  const built = buildLbShape(cs, transSolid, evenOdd);
  const m = built && built.raw;
  if (!m || !m.interior) {
    console.log(`${SPEC}: no interior`);
    continue;
  }
  const nF = m.interior.length / 6;
  let rows2 = 0;
  for (let f = 0; f < nF; f++) {
    const o2 = f * 12;
    if (m.interiorEdges2 && m.interiorEdges2[o2 + 3] !== 0) rows2++;
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of cs)
    for (const sg of c)
      for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!p) continue;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
  const gw = (x1 - x0) * 0.1,
    gh = (y1 - y0) * 0.1;
  x0 -= gw;
  x1 += gw;
  y0 -= gh;
  y1 += gh;
  const dx = (x1 - x0) / N,
    dy = (y1 - y0) / N,
    px = Math.max(dx, dy);
  const wind = (x, y) => {
    let w = 0;
    for (const c of cs) w += rayWinding(c, x, y);
    return evenOdd ? (w & 1) !== 0 : w !== 0;
  };
  let n = 0,
    sum = 0,
    mx = 0,
    miss = 0,
    over = 0;
  for (let j = 0; j < N; j++) {
    const y = y0 + (j + 0.5) * dy;
    for (let i = 0; i < N; i++) {
      const x = x0 + (i + 0.5) * dx;
      const cM = meshCov(m, x, y, px);
      let k = 0;
      for (let b = 0; b < S; b++)
        for (let a = 0; a < S; a++)
          if (wind(x + ((a + 0.5) / S - 0.5) * dx, y + ((b + 0.5) / S - 0.5) * dy)) k++;
      const cT = k / (S * S);
      if (cM === 0 && cT === 0) continue;
      n++;
      const err = Math.abs(cM - cT);
      sum += err;
      if (err > mx) mx = err;
      if (cT >= 0.5 && cM < 0.5) miss++;
      if (cT < 0.5 && cM >= 0.5) over++;
    }
  }
  const pc = (v) => ((100 * v) / Math.max(1, n)).toFixed(4);
  console.log(
    `${SPEC.replace('examples/', '').padEnd(58)} ${String(nF).padStart(5)} ${String(rows2).padStart(6)} ${String(n).padStart(8)} ${(sum / Math.max(1, n)).toFixed(6).padStart(11)} ${mx.toFixed(6).padStart(12)} ${pc(miss).padStart(8)} ${pc(over).padStart(8)}`,
  );
}
