// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/occupancy.js — conservative interior occupancy grid for the fill walk.
// SOLID_IN cells are 1-cell-eroded from any boundary; the renderer gates skip
// on cellSize ≥ 1.5·emPerPx so AA never reaches a boundary. The optimization
// is output-identical to the full coverage walk.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from './segment.js';

function segSpan(s) {
  if (s.type === SEG_LINE) return Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]);
  if (s.type === SEG_ARC) {
    const r = Math.max(Math.abs(s.rx), Math.abs(s.ry));
    return r * Math.abs(s.theta_end - s.theta_start);
  }
  let L = 0,
    prev = null;
  for (const P of [s.p1, s.p2, s.p3, s.p4]) {
    if (!P) continue;
    if (prev) L += Math.hypot(P[0] - prev[0], P[1] - prev[1]);
    prev = P;
  }
  return L;
}

/** Append n+1 samples of seg `s` as interleaved xy into flat `xy` array. */
function flattenInto(s, xy, n) {
  if (s.type === SEG_LINE) {
    const ax = s.p1[0],
      ay = s.p1[1],
      bx = s.p2[0],
      by = s.p2[1];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      xy.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    return;
  }
  if (s.type === SEG_QUAD) {
    const ax = s.p1[0],
      ay = s.p1[1],
      bx = s.p2[0],
      by = s.p2[1],
      cx = s.p3[0],
      cy = s.p3[1];
    for (let i = 0; i <= n; i++) {
      const t = i / n,
        u = 1 - t;
      xy.push(u * u * ax + 2 * u * t * bx + t * t * cx, u * u * ay + 2 * u * t * by + t * t * cy);
    }
    return;
  }
  if (s.type === SEG_CUBIC) {
    const ax = s.p1[0],
      ay = s.p1[1],
      bx = s.p2[0],
      by = s.p2[1];
    const cx = s.p3[0],
      cy = s.p3[1],
      dx = s.p4[0],
      dy = s.p4[1];
    for (let i = 0; i <= n; i++) {
      const t = i / n,
        u = 1 - t;
      const w0 = u * u * u,
        w1 = 3 * u * u * t,
        w2 = 3 * u * t * t,
        w3 = t * t * t;
      xy.push(w0 * ax + w1 * bx + w2 * cx + w3 * dx, w0 * ay + w1 * by + w2 * cy + w3 * dy);
    }
    return;
  }
  const cp = Math.cos(s.phi),
    sp = Math.sin(s.phi);
  for (let i = 0; i <= n; i++) {
    const th = s.theta_start + (s.theta_end - s.theta_start) * (i / n);
    const ex = s.rx * Math.cos(th),
      ey = s.ry * Math.sin(th);
    xy.push(s.cx + ex * cp - ey * sp, s.cy + ex * sp + ey * cp);
  }
}

/** Ray-crossing over flat xy runs (2 floats/point). Chords stay within a run. */
function insideRuns(runs, px, py, evenOdd) {
  let cross = 0,
    wind = 0;
  for (let r = 0; r < runs.length; r++) {
    const xy = runs[r];
    for (let i = 0; i + 3 < xy.length; i += 2) {
      const ax = xy[i],
        ay = xy[i + 1],
        bx = xy[i + 2],
        by = xy[i + 3];
      if (ay > py === by > py) continue;
      const t = (py - ay) / (by - ay);
      if (ax + t * (bx - ax) > px) {
        cross++;
        wind += by > ay ? 1 : -1;
      }
    }
  }
  return evenOdd ? (cross & 1) === 1 : wind !== 0;
}

/**
 * Build a conservative interior occupancy grid for a fill path.
 * @param {Array} segs   native importer segments (the shape's fill outline)
 * @param {number[]} bbox [xmin,ymin,xmax,ymax] em-space (the shape bbox)
 * @param {boolean} evenOdd fill rule
 * @param {object} [opts] { grid=32, minBboxAreaFrac, minInteriorFrac }
 * @returns {{G:number, GW:number, GH:number, bits:Uint8Array,
 *            interiorFrac:number, cellW:number, cellH:number}|null}
 *   null = not worth a grid. GW/GH are the grid's column/row counts (both
 *   equal G today, but consumers index `bits` as `gy * GW + gx`, so they are
 *   part of the contract rather than derivable trivia).
 */
export function buildOccupancyGrid(segs, bbox, evenOdd, opts = {}) {
  if (!segs || segs.length === 0) return null;
  const x0 = bbox[0],
    y0 = bbox[1],
    x1 = bbox[2],
    y1 = bbox[3];
  const bw = x1 - x0,
    bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0)) return null;
  const G = opts.grid || 24;
  const GW = G,
    GH = G;
  const cw = bw / GW,
    ch = bh / GH;
  const minCell = Math.min(cw, ch);

  const boundary = new Uint8Array(GW * GH);
  const runs = [];
  const markSpan = (ax, ay, bx, by) => {
    let gx0 = Math.floor((Math.min(ax, bx) - x0) / cw),
      gx1 = Math.floor((Math.max(ax, bx) - x0) / cw);
    let gy0 = Math.floor((Math.min(ay, by) - y0) / ch),
      gy1 = Math.floor((Math.max(ay, by) - y0) / ch);
    if (gx0 < 0) gx0 = 0;
    if (gy0 < 0) gy0 = 0;
    if (gx1 > GW - 1) gx1 = GW - 1;
    if (gy1 > GH - 1) gy1 = GH - 1;
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) boundary[gy * GW + gx] = 1;
  };
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const n = Math.max(1, Math.min(4096, Math.ceil(segSpan(s) / (minCell * 0.5))));
    const run = [];
    flattenInto(s, run, n);
    runs.push(run);
    for (let i = 0; i + 3 < run.length; i += 2)
      markSpan(run[i], run[i + 1], run[i + 2], run[i + 3]);
  }

  const bits = new Uint8Array(GW * GH);
  let solid = 0;
  const clear = (gx, gy) =>
    gx >= 0 && gx < GW && gy >= 0 && gy < GH && boundary[gy * GW + gx] === 0;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (!clear(gx, gy)) continue;
      if (
        !clear(gx - 1, gy) ||
        !clear(gx + 1, gy) ||
        !clear(gx, gy - 1) ||
        !clear(gx, gy + 1) ||
        !clear(gx - 1, gy - 1) ||
        !clear(gx + 1, gy - 1) ||
        !clear(gx - 1, gy + 1) ||
        !clear(gx + 1, gy + 1)
      )
        continue;
      const ccx = x0 + (gx + 0.5) * cw,
        ccy = y0 + (gy + 0.5) * ch;
      if (insideRuns(runs, ccx, ccy, evenOdd)) {
        bits[gy * GW + gx] = 1;
        solid++;
      }
    }
  }

  const interiorFrac = solid / (GW * GH);
  if (interiorFrac < (opts.minInteriorFrac ?? 0.15)) return null;
  return { G, GW, GH, bits, interiorFrac, cellW: cw, cellH: ch };
}
