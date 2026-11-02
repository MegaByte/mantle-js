// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shapeStats — what ONE shape of a bundle is made of, for choosing its engine.
//
// The bundle carries these only as totals (segTypeMask, totalSegments), which is all a bundle-wide
// gate can use. A per-shape choice needs them per row, so they are walked once per geometry from the
// curve table: the same records curveRangeToContours decodes, read without building a contour.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC } from '../primitives/seg.js';

/// Per shape row:
///   `segs`   segment count
///   `types`  1 << SEG_* for each segment type the shape uses
///   `area`   the area inside its on-curve polygon, |shoelace| with holes subtracting by winding
///   `cross`  how many times an average scanline crosses the outline, over both axes:
///            (sum |dy| / height + sum |dx| / width) / 2 along the on-curve chords
///
/// `cross` is what a band walk pays per fragment, and it is 2 for ANY convex outline, however
/// scalloped its segments are, 4 for a ring and about twice the point count for a star. Chords
/// rather than control polygons, so a bulging segment does not read as a notch; an arc contributes
/// its mid-angle point.
///
/// Null when the bundle kept no curve table. Cached per geometry generation.
export function shapeSegStats(bundle) {
  if (!bundle) return null;
  const gen = bundle._geomGen | 0;
  if (bundle._shapeStats && bundle._shapeStatsGen === gen) return bundle._shapeStats;
  const cf = bundle.curveFloats,
    ranges = bundle.curveRangesByShape,
    n = bundle.numShapes | 0;
  if (!cf || !ranges || n < 1) return null;
  const segs = new Uint32Array(n),
    types = new Uint8Array(n),
    cross = new Float32Array(n),
    area = new Float32Array(n);
  for (let s = 0; s < n && s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    const end = Math.min(r.end | 0, cf.length);
    let hdr = Math.max(0, r.begin | 0),
      cnt = 0,
      mask = 0;
    let sumX = 0,
      sumY = 0,
      x0m = Infinity,
      y0m = Infinity,
      x1m = -Infinity,
      y1m = -Infinity,
      a2 = 0;
    let sx = 0,
      sy = 0,
      px = NaN,
      py = NaN;
    const chord = (ax, ay, bx, by) => {
      sumX += Math.abs(bx - ax);
      sumY += Math.abs(by - ay);
      a2 += ax * by - bx * ay;
      if (bx < x0m) x0m = bx;
      if (bx > x1m) x1m = bx;
      if (by < y0m) y0m = by;
      if (by > y1m) y1m = by;
    };
    while (hdr + 4 <= end) {
      // Same stop rule as curveRangeToContours: a header is a small integer, anything else is past the curves.
      const hw = cf[hdr];
      if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
      const raw = hw | 0,
        t = raw & 3,
        d = hdr + 4;
      let x0,
        y0,
        x1,
        y1,
        mx = NaN,
        my = NaN;
      if (t === SEG_LINE) {
        x0 = cf[d];
        y0 = cf[d + 1];
        x1 = cf[d + 2];
        y1 = cf[d + 3];
        hdr = d + 8;
      } else if (t === SEG_QUAD) {
        x0 = cf[d];
        y0 = cf[d + 1];
        x1 = cf[d + 4];
        y1 = cf[d + 5];
        hdr = d + 12;
      } else if (t === SEG_CUBIC) {
        x0 = cf[d];
        y0 = cf[d + 1];
        x1 = cf[d + 6];
        y1 = cf[d + 7];
        hdr = d + 12;
      } else {
        // (cx, cy, rx, ry) + (theta0, theta1, phi)
        const cx = cf[d],
          cy = cf[d + 1],
          rx = cf[d + 2],
          ry = cf[d + 3];
        const th0 = cf[d + 4],
          th1 = cf[d + 5],
          phi = cf[d + 6];
        const cp = Math.cos(phi),
          sp = Math.sin(phi);
        const at = (th) => {
          const u = rx * Math.cos(th),
            v = ry * Math.sin(th);
          return [cx + u * cp - v * sp, cy + u * sp + v * cp];
        };
        const pm = at(0.5 * (th0 + th1));
        // the ends are the stored vertices; the middle, for the chord area, from the center form
        x0 = cf[d + 8];
        y0 = cf[d + 9];
        mx = pm[0];
        my = pm[1];
        x1 = cf[d + 10];
        y1 = cf[d + 11];
        hdr = d + 16;
      }
      const eps = 1e-6 * (Math.abs(x0) + Math.abs(y0) + 1);
      if (raw & 8 || px !== px || Math.abs(x0 - px) > eps || Math.abs(y0 - py) > eps) {
        if (px === px) chord(px, py, sx, sy); // close the previous subpath
        sx = x0;
        sy = y0;
        chord(x0, y0, x0, y0);
      }
      if (mx === mx) {
        chord(x0, y0, mx, my);
        chord(mx, my, x1, y1);
      } else chord(x0, y0, x1, y1);
      px = x1;
      py = y1;
      cnt++;
      mask |= 1 << t;
    }
    if (px === px) chord(px, py, sx, sy);
    const w = x1m - x0m,
      h = y1m - y0m;
    segs[s] = cnt;
    types[s] = mask;
    area[s] = 0.5 * Math.abs(a2);
    cross[s] = w > 0 && h > 0 ? 0.5 * (sumY / h + sumX / w) : 0;
  }
  bundle._shapeStatsGen = gen;
  return (bundle._shapeStats = { segs, types, cross, area });
}
