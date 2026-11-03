// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// An independent winding number for the Slug ray-walk smokes. The decoded segments are flattened to polylines, the
// winding number is an angle sum over them, and a point is answered only when it lies more than `margin` from the
// outline: nearer, a walker's own rounding may decide it.
//
// Two flattenings answer it. Every point is measured on a coarse one first, and is measured again on the fine one
// (`pieces` per curve) only when its coarse distance is within the two flattenings' chord errors of the margin.
// Elsewhere both put the point on the same side of the margin, and a point farther from the outline than either chord
// error has the same winding number on both. So every answer is the fine flattening's, at about the coarse one's cost.

const SEG_LINE = 0,
  SEG_QUAD = 1,
  SEG_CUBIC = 2,
  SEG_ARC = 3;

// One segment as a polyline of n pieces, and a bound on its distance from the curve: a chord over a parameter step h
// stays within h^2 / 8 * max|B''| of the curve.
function flatten(s, n) {
  const o = [];
  if (s.t === SEG_LINE) {
    o.push([s.x0, s.y0], [s.x1, s.y1]);
    return { pts: o, err: 0 };
  }
  if (s.t === SEG_QUAD) {
    for (let k = 0; k <= n; k++) {
      const t = k / n,
        u = 1 - t;
      o.push([
        u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1,
        u * u * s.y0 + 2 * u * t * s.cy + t * t * s.y1,
      ]);
    }
    const dd = 2 * Math.hypot(s.x0 - 2 * s.cx + s.x1, s.y0 - 2 * s.cy + s.y1);
    return { pts: o, err: dd / (8 * n * n) };
  }
  if (s.t === SEG_CUBIC) {
    for (let k = 0; k <= n; k++) {
      const t = k / n,
        u = 1 - t,
        w0 = u * u * u,
        w1 = 3 * u * u * t,
        w2 = 3 * u * t * t,
        w3 = t * t * t;
      o.push([
        w0 * s.x0 + w1 * s.c1x + w2 * s.c2x + w3 * s.x1,
        w0 * s.y0 + w1 * s.c1y + w2 * s.c2y + w3 * s.y1,
      ]);
    }
    const dd =
      6 *
      Math.max(
        Math.hypot(s.x0 - 2 * s.c1x + s.c2x, s.y0 - 2 * s.c1y + s.c2y),
        Math.hypot(s.c1x - 2 * s.c2x + s.x1, s.c1y - 2 * s.c2y + s.y1),
      );
    return { pts: o, err: dd / (8 * n * n) };
  }
  if (s.t === SEG_ARC) {
    for (let k = 0; k <= n; k++) {
      const th = s.th0 + ((s.th1 - s.th0) * k) / n;
      o.push([
        s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
        s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp,
      ]);
    }
    const h = (s.th1 - s.th0) / n;
    return { pts: o, err: (h * h * Math.max(Math.abs(s.rx), Math.abs(s.ry))) / 8 };
  }
  throw new Error(`windingReference: unknown segment type ${s.t}`);
}

let dist = Infinity,
  wsum = 0;
function measure(pl, x, y) {
  dist = Infinity;
  wsum = 0;
  for (const p of pl)
    for (let j = 0; j + 1 < p.length; j++) {
      const ax = p[j][0] - x,
        ay = p[j][1] - y,
        bx = p[j + 1][0] - x,
        by = p[j + 1][1] - y;
      wsum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      const dx = bx - ax,
        dy = by - ay,
        L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      dist = Math.min(dist, Math.hypot(ax + t * dx, ay + t * dy));
    }
}

/// The winding number of (x, y) about the decoded segments `segs`, or null when the point lies within `margin` of the
/// outline. `pieces` is the fine flattening of each curve, `coarse` the first one.
export function windingReference(segs, { pieces, coarse = 48, margin = 1.5 }) {
  const fine = segs.map((s) => flatten(s, pieces)),
    rough = segs.map((s) => flatten(s, Math.min(coarse, pieces)));
  const finePl = fine.map((f) => f.pts),
    roughPl = rough.map((f) => f.pts);
  // the slack covers the rounding of the two distance computations
  const band =
    Math.max(0, ...fine.map((f) => f.err)) + Math.max(0, ...rough.map((f) => f.err)) + 1e-9;
  return (x, y) => {
    measure(roughPl, x, y);
    if (Math.abs(dist - margin) <= band) measure(finePl, x, y);
    if (dist <= margin) return null;
    return Math.round(wsum / (2 * Math.PI));
  };
}
