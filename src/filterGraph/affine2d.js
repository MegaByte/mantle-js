// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// affine2d.js -- 2-D affine maps in the COLRv1 / filter-graph order [xx, yx, xy, yy, dx, dy]:
//
//   x' = xx*x + xy*y + dx
//   y' = yx*x + yy*y + dy
//
// A colr paint graph lives in its own PAINT space (a glyph's design grid, y up), its render targets in
// canvas pixels (y down), and each target's quad in vUV (0..1 across the target, y up). The maps between
// them are affine, so a pass that needs one is handed a composition of these rather than a box.

export const AFF_ID = Object.freeze([1, 0, 0, 1, 0, 0]);

/// a ∘ b: apply b, then a.
export function affMul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/// The inverse, or null for a singular (or non-finite) map. Exact zero only: a map that scales by 1e-9 is
/// still invertible, and a tolerance here would be a scale-dependent answer.
export function affInv(m) {
  const det = m[0] * m[3] - m[2] * m[1];
  if (!(det !== 0) || !Number.isFinite(det)) return null;
  const i = 1 / det;
  return [
    m[3] * i,
    -m[1] * i,
    -m[2] * i,
    m[0] * i,
    (m[2] * m[5] - m[3] * m[4]) * i,
    (m[1] * m[4] - m[0] * m[5]) * i,
  ];
}

export function affApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/// The axis-aligned bound of box {x, y, w, h} mapped through m.
export function affBox(m, b) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [cx, cy] of [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ]) {
    const [px, py] = affApply(m, cx, cy);
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
