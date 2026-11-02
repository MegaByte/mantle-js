// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBandDrop.mjs — DOES ANY PRIMITIVE REACH THE PIXELS ON THE OUTLINE?
//
// A Loop-Blinn fragment can only ever SUBTRACT coverage, so a pixel center no
// primitive's footprint contains is not antialiased — it is dropped, and nothing
// downstream can recover it. This counts those pixels directly, on the CPU, with
// no GPU: for every pixel center within half a pixel of a shape's outline, ask
// whether any triangle of that shape's packed mesh contains it AFTER the vertex
// stage's dilation (rings, strips and disc pushes all move the vertex, so a test
// against the raw mesh coordinates answers a different question).
//
// It reports three numbers per asset:
//   DROP-OUT  band pixel centers OUTSIDE the fill that no footprint contains
//   DROP-IN   the same inside the fill (an interior hole, a different defect)
//   REACH     the largest distance outside the fill at which a footprint still
//             reaches, in pixels. A control hull stands well clear of its own
//             curve, so this is mostly hull and not band — it is here to catch a
//             change that suddenly extends footprints, not to price over-paint.
//   ALIEN     curve faces whose hull holds a piece of the outline that is NOT
//             their own arc. That is the over-paint PRECONDITION — a face carries
//             one curve's implicit, so where another boundary crosses it the ink
//             is decided by a curve the face has never heard of. This is the
//             invariant anything that reduces subdivision has to keep.
//
// Usage:  node probes/_lbBandDrop.mjs [asset.svg ...] [--px=512] [--band=0.5]
// With no asset it runs the even-odd cubic ring the unified-fill feature smoke
// draws, at the size that smoke draws it.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';

globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours, lbFrameOrigin } = await import('../src/renderer/loopBlinn.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } = await import('../src/primitives/seg.js');
const { cubicTriIntervals, rquadTriIntervals, cubicSubCp, rquadSubCtrl } =
  await import('../src/geom/lbCubicMath.js');

const args = process.argv.slice(2);
const PX = +(args.find((a) => a.startsWith('--px='))?.slice(5) || 512);
const BAND = +(args.find((a) => a.startsWith('--band='))?.slice(7) || 0.5);
const assets = args.filter((a) => !a.startsWith('--'));

// The smoke's own shape, so the defect this probe looks for is reproducible
// with no asset on the command line.
const RING_D =
  'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z' +
  ' M20 12 C26 12 28 14 28 20 C28 26 26 28 20 28 C14 28 12 26 12 20 C12 14 14 12 20 12 Z';
const RING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  `<path fill="#3060c0" fill-rule="evenodd" d="${RING_D}"/></svg>`;

// --- the vertex stage, on the CPU ----------------------------------------
// Mirrors _lbVertexSetup.glsl. The push constants are the shader's defaults; the
// world matrix is identity here, so emPerPxFor() collapses to basePx.
const LB_BEZ_RING = 0.25,
  LB_KLM_RING = 0.25,
  LB_DISC_PUSH = 2.0,
  LB_STRIP_NEXT = 0.8,
  LB_STRIP_TEXT = 3.2;
const LB_VERT_FLOATS = 24;
const _u32 = new Uint32Array(1),
  _f32 = new Float32Array(_u32.buffer);
function half16(h) {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >> 10) & 0x1f,
    m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (m + 1024) * 2 ** (e - 25);
}
function unpackHalf2x16(f) {
  _f32[0] = f;
  const u = _u32[0];
  return [half16(u & 0xffff), half16(u >>> 16)];
}

function dilatedTris(V, nVerts, basePx) {
  const vpos = (i) => {
    const o = i * LB_VERT_FLOATS;
    const px = V[o],
      py = V[o + 1];
    const kind = Math.floor(V[o + 5] + 1e-4),
      sign = V[o + 6],
      seam = V[o + 23];
    if (kind === 4) {
      if (seam > 5.0) {
        const n = unpackHalf2x16(V[o + 22]);
        if (n[0] * n[0] + n[1] * n[1] > 0)
          return [px + n[0] * LB_BEZ_RING * basePx, py + n[1] * LB_BEZ_RING * basePx];
      }
    } else if (kind === 7) {
      const ox = px - V[o + 19],
        oy = py - V[o + 20],
        L = Math.max(Math.hypot(ox, oy), 1e-9);
      return [px + (ox / L) * LB_DISC_PUSH * basePx, py + (oy / L) * LB_DISC_PUSH * basePx];
    } else if (kind === 10) {
      const ax = V[o + 19],
        ay = V[o + 20],
        bx = V[o + 21],
        by = V[o + 22];
      const dx = bx - ax,
        dy = by - ay,
        L = Math.max(Math.hypot(dx, dy), 1e-9);
      const tdx = dx / L,
        tdy = dy / L,
        nx = -tdy * sign,
        ny = tdx * sign;
      const role = V[o + 2],
        tR = ((role % 2) + 2) % 2,
        sR = Math.floor(role / 2 + 0.25);
      const bX = tR < 0.5 ? ax : bx,
        bY = tR < 0.5 ? ay : by;
      const t = (tR < 0.5 ? -LB_STRIP_TEXT : LB_STRIP_TEXT) * (sR < 0.5 ? 0 : basePx);
      const n = (sR < 0.5 ? 0 : LB_STRIP_NEXT) * basePx;
      return [bX + tdx * t + nx * n, bY + tdy * t + ny * n];
    } else if (kind === 12) {
      const a = LB_KLM_RING * basePx;
      return [px + V[o + 7] * a, py + V[o + 8] * a];
    }
    return [px, py];
  };
  const out = [];
  for (let i = 0; i + 2 < nVerts; i += 3) out.push([vpos(i), vpos(i + 1), vpos(i + 2)]);
  return out;
}

const inTri = (T, x, y) => {
  const s = (A, B) => (B[0] - A[0]) * (y - A[1]) - (B[1] - A[1]) * (x - A[0]);
  const d1 = s(T[0], T[1]),
    d2 = s(T[1], T[2]),
    d3 = s(T[2], T[0]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

// --- the outline, densely ------------------------------------------------
// Flattened fine enough that the nearest-point distance it yields is good to a
// few thousandths of a pixel, which is far below the half-pixel band this asks
// about. Sampling the CURVE, not the mesh, so the reference is the path.
function flatten(contours, emPerPx) {
  const polys = [];
  for (const c of contours) {
    const pts = [];
    for (const s of c) {
      const cp =
        s.type === SEG_CUBIC
          ? [s.p1, s.p2, s.p3, s.p4]
          : s.type === SEG_QUAD || s.type === SEG_RQUAD
            ? [s.p1, s.p2, s.p3]
            : [s.p1, s.p2];
      if (!cp[cp.length - 1]) continue;
      let ext = 0;
      for (const q of cp) ext = Math.max(ext, Math.hypot(q[0] - cp[0][0], q[1] - cp[0][1]));
      const n = cp.length === 2 ? 1 : Math.max(2, Math.min(4096, Math.ceil((ext / emPerPx) * 4)));
      const w = s.type === SEG_RQUAD ? s.w || 1 : 1;
      for (let k = 0; k < n; k++) {
        const t = k / n,
          u = 1 - t;
        let x, y;
        if (cp.length === 4) {
          x =
            u * u * u * cp[0][0] +
            3 * u * u * t * cp[1][0] +
            3 * u * t * t * cp[2][0] +
            t * t * t * cp[3][0];
          y =
            u * u * u * cp[0][1] +
            3 * u * u * t * cp[1][1] +
            3 * u * t * t * cp[2][1] +
            t * t * t * cp[3][1];
        } else if (cp.length === 3) {
          const wb = u * u + 2 * w * u * t + t * t;
          x = (u * u * cp[0][0] + 2 * w * u * t * cp[1][0] + t * t * cp[2][0]) / wb;
          y = (u * u * cp[0][1] + 2 * w * u * t * cp[1][1] + t * t * cp[2][1]) / wb;
        } else {
          x = u * cp[0][0] + t * cp[1][0];
          y = u * cp[0][1] + t * cp[1][1];
        }
        pts.push([x, y]);
      }
      pts.push([cp[cp.length - 1][0], cp[cp.length - 1][1]]);
    }
    if (pts.length > 1) polys.push(pts);
  }
  return polys;
}

const bez3 = (cp, t) => {
  const u = 1 - t;
  return [
    u * u * u * cp[0][0] +
      3 * u * u * t * cp[1][0] +
      3 * u * t * t * cp[2][0] +
      t * t * t * cp[3][0],
    u * u * u * cp[0][1] +
      3 * u * u * t * cp[1][1] +
      3 * u * t * t * cp[2][1] +
      t * t * t * cp[3][1],
  ];
};
// THE SEGMENT'S own CURVE. `s.p4 ? [p1,p2,p3,p4] : [p1,p1,p2,p2]` is the segment for a LINE but
// the chord from the start point to the CONTROL point for a QUADRATIC or an ARC -- a probe using
// it walks a curve the outline does not contain and cannot see a quadratic or an arc intruding
// on anything. An instrument with the bug it is measuring for reports zero.
const asCubic = (s) => (s.p4 ? [s.p1, s.p2, s.p3, s.p4] : [s.p1, s.p1, s.p2 || s.p1, s.p2 || s.p1]);
const segCtrl = (s) =>
  s.p4 ? [s.p1, s.p2, s.p3, s.p4] : s.p3 ? [s.p1, s.p2, s.p3] : [s.p1, s.p2 || s.p1];
// A quadratic and an arc are the rational quadratic over their own three points (w = 1 for the
// plain one); a cubic and a line keep the walk they already had.
const segPtAt = (s, t) => {
  if (s.p4) return bez3([s.p1, s.p2, s.p3, s.p4], t);
  if (!s.p3) return bez3([s.p1, s.p1, s.p2 || s.p1, s.p2 || s.p1], t);
  const w = s.type === SEG_RQUAD ? s.w || 1 : 1;
  const u = 1 - t,
    a = u * u,
    b = 2 * w * u * t,
    c = t * t,
    D = a + b + c;
  if (!(Math.abs(D) > 0)) return [s.p1[0], s.p1[1]];
  return [
    (a * s.p1[0] + b * s.p2[0] + c * s.p3[0]) / D,
    (a * s.p1[1] + b * s.p2[1] + c * s.p3[1]) / D,
  ];
};

// A curve face holds ONE curve's implicit, so the model is sound only where its
// hull holds nothing of the shape but its own arc. This asks the built mesh the
// question the split plan asks the plan — same sampling and the same exemptions,
// so a neighbour that meets this curve at a point is not counted as an intruder.
function alienFaces(raw, contours) {
  const faces = (raw.cubics || []).filter((c) => c.hull && c.hull.length >= 6 && c.seg9);
  if (!faces.length) return 0;
  const segs = contours.flat().filter((s) => s.p1 && (s.p4 || s.p2 || s.p3));
  const ends = segs.map((s) => [s.p1, s.p4 || s.p3 || s.p2]);
  // `seg9` IS NOT IN THE FRAME THE FACE IS IN. The builder runs at the shape's
  // own origin and translates the finished mesh back, and `translateLoopBlinnRaw` deliberately
  // leaves `seg9` behind in the build frame -- it is the INPUT the mesh was built from. Its note
  // says the only consumer outside the builder is the morph pair; this probe is a second one, and
  // reading it raw makes every face look like it holds a foreign boundary (on tiger, nearly every
  // face instead of about one in ten). The offset is recoverable exactly, because the builder took
  // it from these same contours.
  const [fox9, foy9] = lbFrameOrigin(contours);
  const unF9 = (p) => (p ? [p[0] + fox9, p[1] + foy9] : p);
  let bad = 0;
  for (const f of faces) {
    const A9 = unF9(f.seg9.p1),
      B9 = unF9(f.seg9.p4 || f.seg9.p3 || f.seg9.p2);
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7;
    let ext = 0;
    for (const q of segCtrl(f.seg9))
      ext = Math.max(ext, Math.abs(q[0] + fox9 - A9[0]), Math.abs(q[1] + foy9 - A9[1]));
    const tol = 1e-9 * ext;
    const T = [
      [f.hull[0], f.hull[1]],
      [f.hull[2], f.hull[3]],
      [f.hull[4], f.hull[5]],
    ];
    let hit = false;
    for (let si = 0; si < segs.length && !hit; si++) {
      // "own segment" by geometry: the probe's contours and the builder's differ by
      // the even-odd reorientation, so identity is not available here.
      if (
        (same(ends[si][0], A9) && same(ends[si][1], B9)) ||
        (same(ends[si][0], B9) && same(ends[si][1], A9))
      )
        continue;
      const skipA = same(ends[si][0], A9) || same(ends[si][0], B9);
      const skipB = same(ends[si][1], A9) || same(ends[si][1], B9);
      // exact, not sampled. Walking 21 points and asking inTri is blind in the same way a sampled
      // containment test is: a curve that enters a face between two steps is not seen. On a
      // constructed case -- a quadratic dipping into a cubic's face -- such a walk reports 0 where
      // the root solve reports 3, so the instrument could neither confirm nor
      // refute a change to the thing it is measuring. The predicates are exact root solves of the
      // curve against the face's edges (lbCubicMath), and the rational arc stays rational.
      const o = segs[si];
      const cub = !!o.p4,
        qd = !cub && !!o.p3;
      // exact bbox reject: a control hull disjoint from the face cannot meet it
      const ctrl = segCtrl(o);
      let sx0 = Infinity,
        sy0 = Infinity,
        sx1 = -Infinity,
        sy1 = -Infinity;
      for (const P of ctrl) {
        if (P[0] < sx0) sx0 = P[0];
        if (P[0] > sx1) sx1 = P[0];
        if (P[1] < sy0) sy0 = P[1];
        if (P[1] > sy1) sy1 = P[1];
      }
      const fx0 = Math.min(T[0][0], T[1][0], T[2][0]),
        fx1 = Math.max(T[0][0], T[1][0], T[2][0]);
      const fy0 = Math.min(T[0][1], T[1][1], T[2][1]),
        fy1 = Math.max(T[0][1], T[1][1], T[2][1]);
      if (sx1 < fx0 || sx0 > fx1 || sy1 < fy0 || sy0 > fy1) continue;
      const ivs = cub
        ? cubicTriIntervals([o.p1, o.p2, o.p3, o.p4], T[0], T[1], T[2])
        : qd
          ? rquadTriIntervals(
              o.p1,
              o.p2,
              o.p3,
              o.type === SEG_RQUAD ? o.w || 1 : 1,
              T[0],
              T[1],
              T[2],
            )
          : cubicTriIntervals([o.p1, o.p1, o.p2 || o.p1, o.p2 || o.p1], T[0], T[1], T[2]);
      const tLo = skipA ? 0.05 : 0,
        tHi = skipB ? 0.95 : 1;
      for (const iv of ivs) {
        if (!(iv[1] >= tLo && iv[0] <= tHi)) continue; // the joint meeting, as before
        // and the coincidence exemption: a portion that never leaves a whisker of this curve's
        // own endpoints is the meeting itself, not an intrusion
        const sub = cub
          ? cubicSubCp([o.p1, o.p2, o.p3, o.p4], iv[0], iv[1])
          : qd
            ? rquadSubCtrl(o.p1, o.p2, o.p3, o.type === SEG_RQUAD ? o.w || 1 : 1, iv[0], iv[1])
            : cubicSubCp([o.p1, o.p1, o.p2 || o.p1, o.p2 || o.p1], iv[0], iv[1]);
        let nearA = true,
          nearB = true;
        for (const P of sub) {
          if (Math.hypot(P[0] - A9[0], P[1] - A9[1]) > tol) nearA = false;
          if (Math.hypot(P[0] - B9[0], P[1] - B9[1]) > tol) nearB = false;
        }
        if (!nearA && !nearB) {
          hit = true;
          break;
        }
      }
    }
    if (hit) bad++;
  }
  return bad;
}

// A uniform bin over boxes, cell = CELL pixels. Only a 3x3 neighbourhood has to
// be searched for anything within one cell of a point, which is what keeps a
// 240-shape asset out of quadratic time.
const CELL = 2;
function binBoxes(boxes, ox, oy, cell) {
  const g = new Map();
  for (let n = 0; n < boxes.length; n++) {
    const b = boxes[n];
    const i0 = Math.floor((b[0] - ox) / cell),
      i1 = Math.floor((b[2] - ox) / cell);
    const j0 = Math.floor((b[1] - oy) / cell),
      j1 = Math.floor((b[3] - oy) / cell);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = i * 4194304 + j;
        let a = g.get(k);
        if (!a) g.set(k, (a = []));
        a.push(n);
      }
  }
  return g;
}
function near(g, ox, oy, cell, x, y, out) {
  out.length = 0;
  const i = Math.floor((x - ox) / cell),
    j = Math.floor((y - oy) / cell);
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const a = g.get((i + di) * 4194304 + (j + dj));
      if (a) for (const n of a) out.push(n);
    }
  return out;
}

async function run(name, svgSrc) {
  const bundle = await importSvg(svgSrc);
  const meta = bundle.meta ? new Float32Array(bundle.meta, 32) : null; // 32-BYTE HEADER
  const mst = bundle.metaFloatsPerShape;
  const curveFloats = new Float32Array(bundle.curves);
  // The renderer fits the CONTENT bbox to the viewport, so that is the scale a
  // dilation constant is measured against.
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    for (const c of curveRangeToContours(curveFloats, r.begin, r.end))
      for (const sg of c)
        for (const P of [sg.p1, sg.p2, sg.p3, sg.p4])
          if (P) {
            if (P[0] < x0) x0 = P[0];
            if (P[0] > x1) x1 = P[0];
            if (P[1] < y0) y0 = P[1];
            if (P[1] > y1) y1 = P[1];
          }
  }
  const emPerPx = Math.max(x1 - x0, y1 - y0) / PX;
  let bandN = 0,
    dropOut = 0,
    dropIn = 0,
    reach = 0,
    shapes = 0,
    meshed = 0,
    verts = 0,
    alien = 0,
    curveFaces = 0;
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    shapes++;
    const bb = meta && mst ? s * mst : -1;
    const transSolid =
      bb >= 0 &&
      meta[bb + 7] < 0.996 &&
      Math.floor(meta[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    const evenodd = !!(meta && meta[s * mst + 13] > 0.5);
    let contours = null;
    try {
      contours = curveRangeToContours(curveFloats, r.begin, r.end);
    } catch {
      continue;
    }
    let built = null;
    try {
      built = buildLbShape(contours, transSolid, evenodd);
    } catch {
      built = null;
    }
    if (!built || !built.pk || !built.pk.vertexCount) continue; // Slug draws it; not this probe's question
    meshed++;
    verts += built.pk.vertexCount;
    const tris = dilatedTris(built.pk.verts, built.pk.vertexCount, emPerPx);
    const polys = flatten(contours, emPerPx);
    if (!polys.length) continue;
    curveFaces += (built.raw.cubics || []).length;
    alien += alienFaces(built.raw, contours);
    // Only the pixels this shape's outline can reach.
    let sx0 = Infinity,
      sy0 = Infinity,
      sx1 = -Infinity,
      sy1 = -Infinity;
    for (const p of polys)
      for (const q of p) {
        if (q[0] < sx0) sx0 = q[0];
        if (q[0] > sx1) sx1 = q[0];
        if (q[1] < sy0) sy0 = q[1];
        if (q[1] > sy1) sy1 = q[1];
      }
    const pad = (BAND + 2) * emPerPx;
    const i0 = Math.floor((sx0 - pad - x0) / emPerPx),
      i1 = Math.ceil((sx1 + pad - x0) / emPerPx);
    const j0 = Math.floor((sy0 - pad - y0) / emPerPx),
      j1 = Math.ceil((sy1 + pad - y0) / emPerPx);
    const cell = CELL * emPerPx;
    const links = []; // flattened outline as segments, with boxes
    for (const p of polys)
      for (let a = 0, b = p.length - 1; a < p.length; b = a++)
        links.push([p[b][0], p[b][1], p[a][0], p[a][1]]);
    const linkG = binBoxes(
      links.map((l) => [
        Math.min(l[0], l[2]),
        Math.min(l[1], l[3]),
        Math.max(l[0], l[2]),
        Math.max(l[1], l[3]),
      ]),
      x0,
      y0,
      cell,
    );
    const triG = binBoxes(
      tris.map((T) => [
        Math.min(T[0][0], T[1][0], T[2][0]),
        Math.min(T[0][1], T[1][1], T[2][1]),
        Math.max(T[0][0], T[1][0], T[2][0]),
        Math.max(T[0][1], T[1][1], T[2][1]),
      ]),
      x0,
      y0,
      cell,
    );
    const cand = [];
    for (let j = j0; j <= j1; j++) {
      const ey = y0 + (j + 0.5) * emPerPx;
      // One crossing list per row, so inside/outside costs a binary search per pixel.
      const xs = [];
      for (const l of links) {
        const yi = l[3],
          yj = l[1];
        if (yi > ey !== yj > ey)
          xs.push([l[0] + ((ey - yj) / (yi - yj)) * (l[2] - l[0]), yi > yj ? 1 : -1]);
      }
      xs.sort((a, b) => a[0] - b[0]);
      for (let i = i0; i <= i1; i++) {
        const ex = x0 + (i + 0.5) * emPerPx;
        let best = Infinity;
        for (const n of near(linkG, x0, y0, cell, ex, ey, cand)) {
          const l = links[n];
          const vx = l[2] - l[0],
            vy = l[3] - l[1],
            L2 = vx * vx + vy * vy;
          let t = L2 > 0 ? ((ex - l[0]) * vx + (ey - l[1]) * vy) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = ex - l[0] - t * vx,
            dy = ey - l[1] - t * vy,
            d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
        const dPx = Math.sqrt(best) / emPerPx;
        if (dPx > BAND + 1.5) continue;
        let w = 0;
        for (const c of xs) {
          if (c[0] <= ex) w += c[1];
          else break;
        }
        const inside = evenodd ? (w & 1) === 1 : w !== 0;
        let hit = false;
        for (const n of near(triG, x0, y0, cell, ex, ey, cand))
          if (inTri(tris[n], ex, ey)) {
            hit = true;
            break;
          }
        if (!inside && hit && dPx > reach) reach = dPx;
        if (dPx > BAND) continue;
        bandN++;
        if (!hit) {
          if (inside) dropIn++;
          else dropOut++;
        }
      }
    }
  }
  const pc = (n) => (bandN ? ((100 * n) / bandN).toFixed(3) + '%' : '-');
  console.log(`${name}  px=${PX} band=${BAND}px  shapes=${meshed}/${shapes} verts=${verts}`);
  console.log(
    `   band pixels ${bandN}   DROP-OUT ${dropOut} (${pc(dropOut)})   DROP-IN ${dropIn} (${pc(dropIn)})` +
      `   REACH ${reach.toFixed(3)}px   ALIEN ${alien}/${curveFaces}`,
  );
  return { bandN, dropOut, dropIn, reach, verts, alien, curveFaces };
}

if (!assets.length) await run('evenOdd-ring', RING_SVG);
else
  for (const a of assets) {
    const p = path.isAbsolute(a) ? a : path.resolve(ROOT, a);
    try {
      await run(path.basename(p), readFileSync(p, 'utf8'));
    } catch (ex) {
      console.log(
        `${path.basename(p)}  SKIPPED: ${String((ex && ex.message) || ex).slice(0, 120)}`,
      );
    }
  }
