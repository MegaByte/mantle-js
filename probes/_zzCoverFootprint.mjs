// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCoverFootprint — DOES THE COVER GEOMETRY RASTERIZE every PIXEL THE SHAPE TOUCHES?
//
// A fragment exists only where a pixel CENTER falls inside a drawn triangle. A pixel whose square the fill
// reaches but whose center no triangle contains is never shaded, whatever the kernel would have said -- an
// AA error no shader change can touch, and the one the fence-free route shows on an illustration with long shallow
// edges: a whole row along a shallow edge comes back at a tenth of its coverage while the dilated route gets it right.
//
// No GPU. Packs each shape the way buildCPatchBundle does, places every vertex the way
// _cpatchVertexSetup.glsl does (pos + aTC.xy * 1.5 * emPerPx), and marks the pixel centers each triangle
// contains. Against it, the pixels the fill actually touches: center inside under the shape's own fill
// rule, or an outline segment crossing the pixel's square. A pixel that needs a fragment and has none is a
// HOLE; its lost coverage is supersampled so a corner sliver is not counted as a missing edge.
//
//   node probes/_zzCoverFootprint.mjs file.svg            N=1024  SHAPES=48,22  KNOBS='__CP_FAN_SEAM=0.2;...'
//
// KNOBS sets packer knobs before the modules load; unset, it packs the default fence-free route.
//
//   BBOX='x,y,w,h' ARX= ARY=   use _zzEnginePaint's frame (its "content bbox ... arX ... arY" line), so hole and pixel
//                              coordinates are that probe's dump indices: columns left to right, rows BOTTOM-UP
//   ATTR=coarse | edge         class each hole by the hull plane it sits beyond -- its kind, whether an outline runs
//                              along it, where on the edge, how deep, and what the edge meets at the nearer end
//   PIXELS='x,y x,y'           print every cover triangle holding those pixel centers, with the patch box distance
//   HOLES_OUT=file.json        dump the hole list, to intersect with a GPU dump
//
// WHAT IT CANNOT SEE: a pixel one patch draws but a SECOND patch should also have drawn. A seam that ramps near the
// outline needs both neighbours' fragments, and "some triangle of this shape holds the center" says nothing about
// that. The EDGEW line counts patches whose plane list failed to line up with the hull (the 1.5px-on-every-edge
// fallback).
import { readFileSync, writeFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;

const FILE = process.argv[2];
const N = +(process.env.N || 1024);
const KNOBS = process.env.KNOBS ?? '';
// Set BEFORE the renderer modules load, in case any of them reads a knob at module scope.
// The packer's knobs are test hooks, read only under __MANTLE_DEBUG__.
if (KNOBS !== 'none' && KNOBS.split(';').some(Boolean)) globalThis.__MANTLE_DEBUG__ = true;
if (KNOBS !== 'none')
  for (const kv of KNOBS.split(';').filter(Boolean)) {
    const [k, v] = kv.split('=');
    globalThis[k] = v === 'true' ? true : v === 'false' ? false : +v;
  }
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter, headlessCPatchBundle, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { circleFromContours, ellipseFromContours } = await import('../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { patchCoverLines, patchCoverHull } = await import('../src/renderer/cpatchConvert.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } = await import('../src/primitives/seg.js');
// How many patches had their skirt reach per edge KIND, and how many fell back to 1.5px on every edge because the
// plane list did not line up with the hull.
globalThis.__CP_EDGEW_STAT = { matched: 0, lengthMismatch: 0, noPlanes: 0 };

const sec = await importSvg(readFileSync(FILE, 'utf8'), { preserveViewport: true });
const bundle = headlessCPatchBundle(sec);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = meta.metaFloats,
  ST = meta.floatsPerShape | 0;
const cf = cpatchCurvePlane(bundle);
const ranges = bundle.curveRangesByShape;
const PIX = process.env.PIXELS
  ? process.env.PIXELS.trim()
      .split(/\s+/)
      .map((q) => q.split(',').map(Number))
  : null;
const only = process.env.SHAPES ? new Set(process.env.SHAPES.split(',').map(Number)) : null;

// A segment as a polyline fine enough that its chord error is far below a pixel.
const evalSeg = (sg, t) => {
  const u = 1 - t;
  if (sg.type === SEG_LINE) return [sg.p1[0] * u + sg.p2[0] * t, sg.p1[1] * u + sg.p2[1] * t];
  if (sg.type === SEG_QUAD)
    return [0, 1].map((k) => u * u * sg.p1[k] + 2 * u * t * sg.p2[k] + t * t * sg.p3[k]);
  if (sg.type === SEG_RQUAD) {
    const w = sg.w,
      d = u * u + 2 * u * t * w + t * t;
    return [0, 1].map((k) => (u * u * sg.p1[k] + 2 * u * t * w * sg.p2[k] + t * t * sg.p3[k]) / d);
  }
  return [0, 1].map(
    (k) =>
      u * u * u * sg.p1[k] +
      3 * u * u * t * sg.p2[k] +
      3 * u * t * t * sg.p3[k] +
      t * t * t * sg.p4[k],
  );
};
const ctrl = (sg) => [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean);

// The frame: the union of the filled shapes' control points fitted to N. The GPU probe fits the renderer's
// content bbox instead, so pixel coordinates here are not the frame's -- this finds CLASSES of hole.
let bx0 = Infinity,
  by0 = Infinity,
  bx1 = -Infinity,
  by1 = -Infinity;
for (let s = 0; s < ranges.length; s++) {
  if (!(MF[s * ST + 7] > 0) || !ranges[s]) continue;
  let cs;
  try {
    cs = curveRangeToContours(cf, ranges[s].begin, ranges[s].end);
  } catch {
    continue;
  }
  for (const c of cs || [])
    for (const sg of c)
      for (const p of ctrl(sg)) {
        bx0 = Math.min(bx0, p[0]);
        by0 = Math.min(by0, p[1]);
        bx1 = Math.max(bx1, p[0]);
        by1 = Math.max(by1, p[1]);
      }
}
let EMPX = Math.max(bx1 - bx0, by1 - by0) / N;
let toPx = (p) => [(p[0] - bx0) / EMPX, (p[1] - by0) / EMPX];
let fromPx = (x, y) => [bx0 + x * EMPX, by0 + y * EMPX];
// BBOX='x,y,w,h' ARX= ARY=: _zzEnginePaint's own frame (its "content bbox ... arX ... arY" line), so a hole here is
// the same pixel index as in that probe's dumps -- columns left to right, rows BOTTOM-UP.
if (process.env.BBOX) {
  const [q0, q1, q2, q3] = process.env.BBOX.split(',').map(Number),
    aX = +(process.env.ARX || 1),
    aY = +(process.env.ARY || 1);
  EMPX = q2 / (aX * N);
  toPx = (p) => [
    (N / 2) * (aX * ((2 * (p[0] - q0)) / q2 - 1) + 1),
    (N / 2) * (1 - aY * ((2 * (p[1] - q1)) / q3 - 1)),
  ];
  fromPx = (x, y) => [
    q0 + ((((2 * x) / N - 1) / aX + 1) / 2) * q2,
    q1 + ((1 - ((2 * y) / N - 1) / aY) / 2) * q3,
  ];
}
console.log(`${FILE.split('/').pop()}  N=${N}  em/px ${EMPX.toFixed(5)}  knobs ${KNOBS}`);

const tot = { shapes: 0, refused: 0, needs: 0, holes: 0, h10: 0, h30: 0, lost: 0 };
const classes = new Map();
const bump = (k, lost) => {
  const e = classes.get(k) || { n: 0, lost: 0, h30: 0 };
  e.n++;
  e.lost += lost;
  if (lost > 0.3) e.h30++;
  classes.set(k, e);
};
const worst = [];

for (let s = 0; s < ranges.length; s++) {
  if (only && !only.has(s)) continue;
  if (!(MF[s * ST + 7] > 0) || !ranges[s]) continue;
  let contours;
  try {
    contours = curveRangeToContours(cf, ranges[s].begin, ranges[s].end);
  } catch {
    continue;
  }
  if (!contours || !contours.length) continue;
  if (circleFromContours(contours) || ellipseFromContours(contours)) continue; // a primitive draws itself
  const cs = contoursToConverter(contours, null);
  if (!cs) continue;
  const evenOdd = shapeEvenOdd(bundle, s);
  let m = null;
  const patches = [];
  try {
    m = packCPatchShape(cs, 0, {
      maxCurves: 8,
      evenOdd,
      pool: false,
      search: 'full',
      onPatches: (ps) => patches.push(...ps),
    });
  } catch {
    m = null;
  }
  // WHICH HULL EDGE failed to reach a hole: the plane of the nearest patch that the center sits just outside,
  // its kind as patchCoverLines hands it to the packer, and the flags of the curves that run along it.
  const planes = patches.map((p) => {
    try {
      return patchCoverLines(p.curves, 0) || [];
    } catch {
      return [];
    }
  });
  const attribute = (xp, yp) => {
    const [X, Y] = fromPx(xp, yp);
    let best = null;
    for (let pi = 0; pi < patches.length; pi++) {
      const hl = planes[pi];
      if (!hl.length) continue;
      let minV = Infinity,
        arg = -1;
      for (let k = 0; k < hl.length; k++) {
        const v = hl[k][0] * X + hl[k][1] * Y + hl[k][2];
        if (v < minV) {
          minV = v;
          arg = k;
        }
      }
      if (!(minV < 0) || minV < -1.0 * EMPX) continue; // inside this hull, or more than 1px outside it
      if (!best || minV > best.v) best = { v: minV, pi, k: arg };
    }
    if (!best) return 'no hull within 1px';
    const pl = planes[best.pi][best.k],
      p = patches[best.pi];
    const along = [];
    for (const c of p.curves) {
      const P = c.P || [];
      if (P.length && P.every((q) => Math.abs(pl[0] * q[0] + pl[1] * q[1] + pl[2]) < 0.02 * EMPX))
        along.push(`${c.t}${c.cut ? ' cut' : ''}`);
    }
    if (process.env.ATTR === 'edge') {
      // WHERE ON THE EDGE: along it or past an end, how deep outside it, and what the edge meets at the nearer end.
      const H = patchCoverHull(p.curves, 0) || [];
      const onPl = (q, P2) => Math.abs(P2[0] * q[0] + P2[1] * q[1] + P2[2]) < 1e-6 * EMPX;
      let e = -1;
      for (let k = 0; k < H.length; k++)
        if (onPl(H[k], pl) && onPl(H[(k + 1) % H.length], pl)) {
          e = k;
          break;
        }
      if (e < 0)
        return `kind ${pl[3]}${pl.outlineAlong ? ' outl' : ''}  (no hull edge on the plane)`;
      const A = H[e],
        B = H[(e + 1) % H.length];
      const ex = B[0] - A[0],
        ey = B[1] - A[1],
        L = Math.hypot(ex, ey);
      const t = ((X - A[0]) * ex + (Y - A[1]) * ey) / (L * L);
      const along = (t * L) / EMPX,
        lenPx = L / EMPX,
        depth = -best.v / EMPX;
      const endB = t > 0.5;
      const pos =
        t < 0 || t > 1
          ? 'PAST an end'
          : Math.min(along, lenPx - along) < 1
            ? 'within 1px of an end'
            : 'MID-edge';
      const nb = endB ? [B, H[(e + 2) % H.length]] : [H[(e + H.length - 1) % H.length], A];
      const npl = planes[best.pi].find((P2) => onPl(nb[0], P2) && onPl(nb[1], P2));
      const nbr = npl ? `nbr kind ${npl[3]}${npl.outlineAlong ? ' outl' : ''}` : 'nbr ?';
      const nx2 = nb[1][0] - nb[0][0],
        ny2 = nb[1][1] - nb[0][1];
      const turn = (Math.abs(Math.atan2(ex * ny2 - ey * nx2, ex * nx2 + ey * ny2)) * 180) / Math.PI;
      const tb =
        turn < 20 ? 'turn<20' : turn < 60 ? 'turn20-60' : turn < 120 ? 'turn60-120' : 'turn>120';
      return `kind ${pl[3]}${pl.outlineAlong ? ' outl' : '     '}  ${pos.padEnd(20)} depth ${depth < 0.35 ? '<0.35' : depth < 0.7 ? '0.35-0.7' : '>0.7'}  ${nbr.padEnd(16)} ${pos === 'MID-edge' ? '' : tb}`;
    }
    if (process.env.ATTR === 'coarse') {
      const o = p.curves.some(
        (c) =>
          !c.cut &&
          (c.P || []).every((q) => Math.abs(pl[0] * q[0] + pl[1] * q[1] + pl[2]) < 0.02 * EMPX),
      );
      const ct = p.curves.some(
        (c) =>
          c.cut &&
          (c.P || []).every((q) => Math.abs(pl[0] * q[0] + pl[1] * q[1] + pl[2]) < 0.02 * EMPX),
      );
      return `kind ${pl[3]}  ${o ? 'OUTLINE along' : 'no outline along'}${ct ? ' + CUT along' : ''}`;
    }
    return `kind ${pl[3]} [${along.join(' / ') || 'no curve on the plane'}]`;
  };
  tot.shapes++;
  if (!m || !m.verts || !m.vertexCount) {
    tot.refused++;
    continue;
  }

  // Outline, flattened, in pixels. Each edge remembers its segment type and whether it ends at a vertex.
  const edges = [];
  const verts0 = [];
  for (const c of contours)
    for (const sg of c) {
      const P = ctrl(sg).map(toPx);
      let L = 0;
      for (let k = 1; k < P.length; k++)
        L += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
      const n = Math.max(1, Math.ceil(L / 0.2));
      let prev = toPx(evalSeg(sg, 0));
      verts0.push(prev);
      for (let k = 1; k <= n; k++) {
        const cur = toPx(evalSeg(sg, k / n));
        edges.push([prev[0], prev[1], cur[0], cur[1], sg.type]);
        prev = cur;
      }
    }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const e of edges) {
    x0 = Math.min(x0, e[0], e[2]);
    x1 = Math.max(x1, e[0], e[2]);
    y0 = Math.min(y0, e[1], e[3]);
    y1 = Math.max(y1, e[1], e[3]);
  }
  const ox = Math.floor(x0) - 3,
    oy = Math.floor(y0) - 3;
  const W = Math.ceil(x1) + 3 - ox,
    H = Math.ceil(y1) + 3 - oy;
  const need = new Uint8Array(W * H),
    drawn = new Uint8Array(W * H);

  const windingAt = (x, y) => {
    let w = 0;
    for (const e of edges) {
      const [ax, ay, bx, by] = e;
      if (ay <= y !== by <= y) {
        const xx = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (xx > x) w += by > ay ? 1 : -1;
      }
    }
    return w;
  };
  const inFill = (x, y) => {
    const w = windingAt(x, y);
    return evenOdd ? (w & 1) !== 0 : w !== 0;
  };

  // Centers inside the fill, one scanline per pixel row.
  for (let j = 0; j < H; j++) {
    const y = oy + j + 0.5;
    const xs = [];
    for (const e of edges) {
      const [ax, ay, bx, by] = e;
      if (ay <= y !== by <= y) xs.push([ax + ((y - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let w = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      w += xs[k][1];
      if (evenOdd ? (w & 1) === 0 : w === 0) continue;
      for (
        let i = Math.max(0, Math.ceil(xs[k][0] - 0.5 - ox));
        i < W && ox + i + 0.5 < xs[k + 1][0];
        i++
      )
        need[j * W + i] = 1;
    }
  }
  // Squares an outline edge passes through (Liang-Barsky against the unit square).
  const hitsSquare = (ax, ay, bx, by, sx, sy) => {
    let t0 = 0,
      t1 = 1;
    const dx = bx - ax,
      dy = by - ay;
    for (const [p, q] of [
      [-dx, ax - sx],
      [dx, sx + 1 - ax],
      [-dy, ay - sy],
      [dy, sy + 1 - ay],
    ]) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
    return t0 < t1;
  };
  for (const [ax, ay, bx, by] of edges) {
    for (let j = Math.floor(Math.min(ay, by)) - oy; j <= Math.floor(Math.max(ay, by)) - oy; j++)
      for (let i = Math.floor(Math.min(ax, bx)) - ox; i <= Math.floor(Math.max(ax, bx)) - ox; i++)
        if (i >= 0 && j >= 0 && i < W && j < H && hitsSquare(ax, ay, bx, by, ox + i, oy + j))
          need[j * W + i] = 1;
  }

  // The cover, as the vertex stage places it.
  const stride = m.verts.length / m.vertexCount,
    V = m.verts;
  let nFan = 0,
    nSkirt = 0;
  for (let t = 0; t + 2 < m.vertexCount; t += 3) {
    const P = [0, 1, 2].map((k) => {
      const o = (t + k) * stride;
      return toPx([
        V[o] + V[o + 17] + V[o + 2] * 1.5 * EMPX,
        V[o + 1] + V[o + 18] + V[o + 3] * 1.5 * EMPX,
      ]);
    });
    const fan =
      V[t * stride + 4] > 500 && V[(t + 1) * stride + 4] > 500 && V[(t + 2) * stride + 4] > 500;
    if (fan) nFan++;
    else nSkirt++;
    const area =
      (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (!(Math.abs(area) > 1e-12)) continue;
    const sg = area > 0 ? 1 : -1;
    // PIXELS='x,y x,y': every triangle whose drawn area holds one of these pixel centers (probe frame, rows bottom-up).
    if (PIX)
      for (const [pi_, pj_] of PIX) {
        const x = pi_ + 0.5,
          y = pj_ + 0.5;
        let ins = true;
        for (let k = 0; k < 3 && ins; k++) {
          const a = P[k],
            b = P[(k + 1) % 3];
          if (sg * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) < -1e-9) ins = false;
        }
        if (ins) {
          // The patch's BOX distance at this center, in px, as _cpatchCoverage.glsl's box step computes it (positive inside).
          const o = t * stride,
            ax = V[o + 11],
            ay = V[o + 12];
          let bdTxt = 'nobox';
          if (ax * ax + ay * ay > 1e-12) {
            const [X, Y] = fromPx(x, y),
              bu = ax * X + ay * Y,
              bv = -ay * X + ax * Y;
            bdTxt =
              'box ' +
              (
                Math.min(bu - V[o + 13], V[o + 14] - bu, bv - V[o + 15], V[o + 16] - bv) / EMPX
              ).toFixed(3) +
              'px';
          }
          console.log(
            `PIX (${pi_},${pj_}) s${s} block ${V[o + 19]} ${fan ? 'fan  ' : 'skirt'} ${bdTxt} ` +
              P.map(
                (q, k) =>
                  `(${q[0].toFixed(1)},${q[1].toFixed(1)} z${V[(t + k) * stride + 4].toFixed(2)})`,
              ).join(' '),
          );
        }
      }
    const ix0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]) - ox - 1));
    const ix1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0]) - ox + 1));
    const iy0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]) - oy - 1));
    const iy1 = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1]) - oy + 1));
    for (let j = iy0; j <= iy1; j++)
      for (let i = ix0; i <= ix1; i++) {
        const x = ox + i + 0.5,
          y = oy + j + 0.5;
        let inside = true;
        for (let k = 0; k < 3 && inside; k++) {
          const a = P[k],
            b = P[(k + 1) % 3];
          if (sg * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) < -1e-9)
            inside = false;
        }
        if (inside) drawn[j * W + i] = 1;
      }
  }

  let sN = 0,
    sH = 0,
    sL = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const q = j * W + i;
      if (!need[q]) continue;
      sN++;
      if (drawn[q]) continue;
      // Lost coverage: 8x8 supersample of the fill over the pixel.
      let c = 0;
      for (let b = 0; b < 8; b++)
        for (let a = 0; a < 8; a++)
          c += inFill(ox + i + (a + 0.5) / 8, oy + j + (b + 0.5) / 8) ? 1 : 0;
      const lost = c / 64;
      if (lost <= 0) continue;
      sH++;
      sL += lost;
      const x = ox + i + 0.5,
        y = oy + j + 0.5;
      const cIn = inFill(x, y);
      let dv = Infinity;
      for (const v of verts0) dv = Math.min(dv, Math.hypot(v[0] - x, v[1] - y));
      let de = Infinity,
        ty = -1;
      for (const e of edges) {
        const [ax, ay, bx, by] = e,
          dx = bx - ax,
          dy = by - ay,
          L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        const d = Math.hypot(ax + u * dx - x, ay + u * dy - y);
        if (d < de) {
          de = d;
          ty = e[4];
        }
      }
      const tyN = ['line', 'quad', 'cubic', '?', 'rquad'][ty] || String(ty);
      const key = process.env.ATTR
        ? `${process.env.ATTR === 'coarse' || process.env.ATTR === 'edge' ? '' : tyN.padEnd(5) + ' '}${attribute(x, y)}`
        : `${cIn ? 'centre IN ' : 'centre OUT'}  ${dv < 1.5 ? 'at a vertex' : 'mid-segment'}  ${tyN}`;
      bump(key, lost);
      if (lost > 0.1) tot.h10++;
      if (lost > 0.3) tot.h30++;
      worst.push({
        s,
        i: ox + i,
        j: oy + j,
        x: +x.toFixed(1),
        y: +y.toFixed(1),
        lost: +lost.toFixed(2),
        de: +de.toFixed(2),
        key,
      });
    }
  tot.needs += sN;
  tot.holes += sH;
  tot.lost += sL;
  if (sH || only)
    console.log(
      `  shape ${String(s).padStart(3)}  tris fan ${nFan} skirt ${nSkirt}  needs ${sN}  HOLES ${sH}  lost ${sL.toFixed(2)} px`,
    );
}
console.log(
  `TOTAL shapes ${tot.shapes} (refused ${tot.refused})  pixels needing a fragment ${tot.needs}  HOLES ${tot.holes}  lost>0.1 ${tot.h10}  lost>0.3 ${tot.h30}  lost coverage ${tot.lost.toFixed(2)} px`,
);
for (const [k, e] of [...classes].sort((a, b) => b[1].lost - a[1].lost))
  console.log(
    `   ${k.padEnd(process.env.ATTR ? 70 : 40)} n ${String(e.n).padStart(5)}  lost>0.3 ${String(e.h30).padStart(4)}  lost ${e.lost.toFixed(2)}`,
  );
if (process.env.HOLES_OUT) writeFileSync(process.env.HOLES_OUT, JSON.stringify(worst));
console.log('EDGEW', JSON.stringify(globalThis.__CP_EDGEW_STAT));
worst.sort((a, b) => b.lost - a.lost);
for (const w of worst.slice(0, +(process.env.TOP || 12)))
  console.log(`   s${w.s} (${w.x},${w.y}) lost ${w.lost} dist-to-outline ${w.de}px  ${w.key}`);
