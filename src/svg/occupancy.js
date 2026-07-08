// svg/occupancy.js — conservative interior occupancy grid for the fill walk
// fast path. For an interior-heavy fill (e.g. near-fullscreen curves) most
// fragments are deep inside the shape, where the dual-ray coverage walk does a
// lot of work only to return 1.0. This builds a coarse G×G grid marking cells
// that are PROVABLY fully interior, so the renderer can skip the walk for
// fragments in those cells.
//
// CORRECTNESS (output must stay identical to the walk):
//   A cell is SOLID_IN only if it AND all 8 neighbours contain no fill
//   boundary (no seg's tight bbox overlaps them) AND the cell centre is inside
//   the fill. The 1-cell erosion guarantees the nearest boundary is ≥ 1 cell
//   away from any fragment in a SOLID_IN cell. The renderer then gates the
//   skip at draw time on `cellSize ≥ 1.5·emPerPx`, so the (≤1px) coverage AA
//   ramp can never reach the boundary — the walk would return exactly 1.0
//   there anyway. At extreme zoom-out the gate fails and the walk runs (no
//   error). Because the output is identical whether or not the skip fires,
//   this is JS-only and does NOT affect JS↔C# pixel parity.
//
// The boundary test rasterizes each seg as fine CHORDS (a single full-circle
// arc must not collapse to one giant bbox); a cell no chord-bbox touches is
// provably boundary-free. Over-conservative chord bboxes only cost SOLID_IN
// cells (less speed-up), never correctness.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from './segment.js';

// Rough em-space span of a seg (for choosing a flatten count fine enough that
// chords stay under half a cell — a single full-circle arc must NOT be treated
// as one giant bbox covering the whole shape).
function segSpan(s) {
  if (s.type === SEG_LINE) return Math.hypot(s.p2[0]-s.p1[0], s.p2[1]-s.p1[1]);
  if (s.type === SEG_ARC) {
    const r = Math.max(Math.abs(s.rx), Math.abs(s.ry));
    return r * Math.abs(s.theta_end - s.theta_start);
  }
  // quad/cubic: control-polygon length (an upper bound on arc length).
  const p = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0]-p[i-1][0], p[i][1]-p[i-1][1]);
  return L;
}

// Sample a native seg into a flat list of [x,y] points (endpoints + interior
// samples for curves/arcs). Used only for the cell-centre inside test, which
// is evaluated far (≥1 cell) from any boundary, so a moderate sample count is
// more than enough — this never decides a near-boundary case.
function flattenInto(s, pts, n) {
  if (s.type === SEG_LINE) {
    // Subdivide diagonal lines too: a single chord's bbox is a big square for a
    // 45° edge and would over-mark the whole diagonal half as boundary.
    const [ax, ay] = s.p1, [bx, by] = s.p2;
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([ax + (bx-ax)*t, ay + (by-ay)*t]); }
    return;
  }
  if (s.type === SEG_QUAD) {
    const [ax, ay] = s.p1, [bx, by] = s.p2, [cx, cy] = s.p3;
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push([u*u*ax + 2*u*t*bx + t*t*cx, u*u*ay + 2*u*t*by + t*t*cy]);
    }
    return;
  }
  if (s.type === SEG_CUBIC) {
    const [ax, ay] = s.p1, [bx, by] = s.p2, [cx, cy] = s.p3, [dx, dy] = s.p4;
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const w0 = u*u*u, w1 = 3*u*u*t, w2 = 3*u*t*t, w3 = t*t*t;
      pts.push([w0*ax + w1*bx + w2*cx + w3*dx, w0*ay + w1*by + w2*cy + w3*dy]);
    }
    return;
  }
  // SEG_ARC: walk theta from thetaStart→thetaEnd.
  const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
  for (let i = 0; i <= n; i++) {
    const th = s.theta_start + (s.theta_end - s.theta_start) * (i / n);
    const ex = s.rx * Math.cos(th), ey = s.ry * Math.sin(th);
    pts.push([s.cx + ex*cp - ey*sp, s.cy + ex*sp + ey*cp]);
  }
}

// Even-odd / nonzero ray-crossing winding over the flattened boundary, given
// as one point-run PER SEG. Chords are taken only WITHIN a run, so the implicit
// jump between two segs (coincident inside a closed subpath; a real gap between
// separate subpaths like an annulus's outer/inner rings) is never counted. The
// test point is always ≥1 cell from the boundary, so flattening error can't
// flip it.
function insideRuns(runs, px, py, evenOdd) {
  let cross = 0, wind = 0;
  for (let r = 0; r < runs.length; r++) {
    const pts = runs[r];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const ay = a[1], by = b[1];
      if ((ay > py) === (by > py)) continue;
      const t = (py - ay) / (by - ay);
      if (a[0] + t * (b[0] - a[0]) > px) { cross++; wind += (by > ay) ? 1 : -1; }
    }
  }
  return evenOdd ? (cross & 1) === 1 : wind !== 0;
}

/**
 * Build a conservative interior occupancy grid for a fill path.
 * @param {Array} segs   native importer segments (the shape's fill outline)
 * @param {number[]} bbox [xmin,ymin,xmax,ymax] em-space (the shape bbox)
 * @param {boolean} evenOdd fill rule
 * @param {object} [opts] { grid=16, minBboxAreaFrac, minInteriorFrac }
 * @returns {{G:number, bits:Uint8Array, interiorFrac:number,
 *            cellW:number, cellH:number}|null} null = not worth a grid.
 */
export function buildOccupancyGrid(segs, bbox, evenOdd, opts = {}) {
  const G = opts.grid || 16;
  if (!segs || segs.length === 0) return null;
  const x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3];
  const bw = x1 - x0, bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0)) return null;
  const cw = bw / G, ch = bh / G;
  const minCell = Math.min(cw, ch);

  // 1) boundary cells: rasterize each seg as fine CHORDS (so a single big arc
  //    / curve doesn't get treated as one giant bbox). A chord's tight bbox
  //    is marked across the cells it spans — conservative (a chord bbox is a
  //    superset of the chord) but tight because chords are < half a cell.
  //    Flatten finely enough per seg AND reuse the same samples for the inside
  //    test (so both agree on where the boundary is).
  const boundary = new Uint8Array(G * G);
  const runs = [];                              // one flattened point-run per seg
  const markSpan = (ax, ay, bx, by) => {
    let gx0 = Math.floor((Math.min(ax, bx) - x0) / cw), gx1 = Math.floor((Math.max(ax, bx) - x0) / cw);
    let gy0 = Math.floor((Math.min(ay, by) - y0) / ch), gy1 = Math.floor((Math.max(ay, by) - y0) / ch);
    if (gx0 < 0) gx0 = 0; if (gy0 < 0) gy0 = 0;
    if (gx1 > G - 1) gx1 = G - 1; if (gy1 > G - 1) gy1 = G - 1;
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) boundary[gy * G + gx] = 1;
  };
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    // ≥2 chords per cell the seg spans, capped for safety.
    const n = Math.max(1, Math.min(4096, Math.ceil(segSpan(s) / (minCell * 0.5))));
    const run = [];
    flattenInto(s, run, n);
    runs.push(run);
    for (let i = 0; i + 1 < run.length; i++)
      markSpan(run[i][0], run[i][1], run[i + 1][0], run[i + 1][1]);
  }

  // 3) SOLID_IN = self + 8 neighbours all clear (1-cell erosion) AND centre
  //    inside. Edge cells border the (boundary-bearing) bbox edge, so the
  //    neighbour check naturally excludes them.
  const bits = new Uint8Array(G * G);
  let solid = 0;
  const clear = (gx, gy) =>
    gx >= 0 && gx < G && gy >= 0 && gy < G && boundary[gy * G + gx] === 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      if (!clear(gx, gy)) continue;
      if (!clear(gx-1, gy) || !clear(gx+1, gy) || !clear(gx, gy-1) || !clear(gx, gy+1)
        || !clear(gx-1, gy-1) || !clear(gx+1, gy-1) || !clear(gx-1, gy+1) || !clear(gx+1, gy+1))
        continue;
      const ccx = x0 + (gx + 0.5) * cw, ccy = y0 + (gy + 0.5) * ch;
      if (insideRuns(runs, ccx, ccy, evenOdd)) { bits[gy * G + gx] = 1; solid++; }
    }
  }

  const interiorFrac = solid / (G * G);
  if (interiorFrac < (opts.minInteriorFrac ?? 0.15)) return null;
  return { G, bits, interiorFrac, cellW: cw, cellH: ch };
}
