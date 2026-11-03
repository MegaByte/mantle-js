// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Curvature records belong to the current geometry, including its stroke frame.
export function recordCurvature(curve, off, type, atStart, frame) {
  if (type === 0 || off < 0) return 0;
  let dx, dy, ax, ay;
  const [a, b, c, d] = frame;
  if (type === 3) {
    const rx = curve[off + 6],
      ry = curve[off + 7],
      theta = curve[off + (atStart ? 8 : 9)],
      phi = curve[off + 10];
    const sweep = curve[off + 9] - curve[off + 8];
    if (!rx || !ry || !sweep) return 0;
    const cp = Math.cos(phi),
      sp = Math.sin(phi),
      ct = Math.cos(theta),
      st = Math.sin(theta);
    const vx = -cp * rx * st - sp * ry * ct,
      vy = -sp * rx * st + cp * ry * ct;
    const wx = -cp * rx * ct + sp * ry * st,
      wy = -sp * rx * ct - cp * ry * st;
    dx = a * vx + c * vy;
    dy = b * vx + d * vy;
    ax = a * wx + c * wy;
    ay = b * wx + d * wy;
    if (sweep < 0) {
      dx = -dx;
      dy = -dy;
    }
  } else {
    const x0 = curve[off + 4],
      y0 = curve[off + 5],
      x1 = curve[off + 6],
      y1 = curve[off + 7],
      x2 = curve[off + 8],
      y2 = curve[off + 9];
    const p0x = a * x0 + c * y0,
      p0y = b * x0 + d * y0,
      p1x = a * x1 + c * y1,
      p1y = b * x1 + d * y1,
      p2x = a * x2 + c * y2,
      p2y = b * x2 + d * y2;
    let loX = Math.min(p0x, p1x, p2x),
      loY = Math.min(p0y, p1y, p2y),
      hiX = Math.max(p0x, p1x, p2x),
      hiY = Math.max(p0y, p1y, p2y);
    if (type === 1) {
      dx = 2 * (atStart ? p1x - p0x : p2x - p1x);
      dy = 2 * (atStart ? p1y - p0y : p2y - p1y);
      ax = 2 * (p0x - 2 * p1x + p2x);
      ay = 2 * (p0y - 2 * p1y + p2y);
    } else {
      const x3 = curve[off + 10],
        y3 = curve[off + 11],
        p3x = a * x3 + c * y3,
        p3y = b * x3 + d * y3;
      loX = Math.min(loX, p3x);
      loY = Math.min(loY, p3y);
      hiX = Math.max(hiX, p3x);
      hiY = Math.max(hiY, p3y);
      dx = 3 * (atStart ? p1x - p0x : p3x - p2x);
      dy = 3 * (atStart ? p1y - p0y : p3y - p2y);
      ax = 6 * (atStart ? p0x - 2 * p1x + p2x : p1x - 2 * p2x + p3x);
      ay = 6 * (atStart ? p0y - 2 * p1y + p2y : p1y - 2 * p2y + p3y);
    }
    if (!(Math.hypot(dx, dy) > 1e-9 * Math.max(hiX - loX, hiY - loY))) return 0;
  }
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return 0;
  // Normalize before the cross product instead of cubing a coordinate scale.
  return ((dx / length) * (ay / length) - (dy / length) * (ax / length)) / length;
}

export function rebuildMorphCurvatures(curve, rows) {
  if (!rows) return;
  for (const r of rows) {
    curve[r.out] = recordCurvature(curve, r.off, r.type, true, r.frame);
    curve[r.out + 1] = recordCurvature(curve, r.off, r.type, false, r.frame);
    curve[r.out + 2] = recordCurvature(curve, r.prev, r.prevType, false, r.frame);
    curve[r.out + 3] = recordCurvature(curve, r.next, r.nextType, true, r.frame);
  }
}
