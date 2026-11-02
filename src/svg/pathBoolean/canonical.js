// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// canonical.js — put geometry at a canonical size before a kernel that carries world-unit
// epsilons looks at it.
//
// Shared by the boolean union and the intersection kernels, and kept in its own module so neither
// has to import the other.
import { mkArc, SEG_ARC } from '../segment.js';

/// THE KERNEL WORKS ON A CANONICAL EXTENT, and this is what puts it there.
///
/// Every stage that consumes this carries epsilons in WORLD UNITS -- 1e-9 for a degenerate determinant, 1e-5
/// for a point key, 1e-3 for a Bezier-clip endpoint match, 1e-7 for "the same control point".
/// Those are statements about a drawing roughly one unit across. Hand the same geometry in at a
/// sixteenth of the size and they mean sixteen times as much, so segments merge that did not,
/// crossings vanish, and the union comes back with a different number of contours. That is not a
/// precision problem; it is the same shape getting a different answer for its size, and the
/// self-overlap resolver (shapeResolve) rides on it, so it changed which Loop-Blinn meshes built.
///
/// Fixing thirty epsilons across a dozen files would be thirty chances to get one wrong. Normalizing
/// the INPUT fixes all of them at once, and it is free: the factor is a POWER OF TWO, so scaling
/// in and back out is exact in binary floating point -- every coordinate returns bit-identical,
/// and no stage in between can tell it was not given the numbers directly.
export function canonicalScale(segLists) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const list of segLists)
    for (const sg of (list && list.segs) || list || []) {
      for (const k of ['p1', 'p2', 'p3', 'p4']) {
        const q = sg[k];
        if (!q) continue;
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
      // An arc's extent is its radii, not its ends. A full turn has both ends at one point: its extent would read as zero, or
      // as the rounding of its seam, which would scale a unit circle by 2^52 and leave its seam open.
      if (sg.type === SEG_ARC) {
        const r = Math.max(sg.rx, sg.ry);
        if (sg.cx - r < x0) x0 = sg.cx - r;
        if (sg.cx + r > x1) x1 = sg.cx + r;
        if (sg.cy - r < y0) y0 = sg.cy - r;
        if (sg.cy + r > y1) y1 = sg.cy + r;
      }
    }
  const ext = x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
  if (!(ext > 0) || !isFinite(ext)) return 1;
  // The power of two that lands the extent in [1, 2). Math.log2 can be an ulp off at an exact
  // power of two, so the result is corrected rather than trusted.
  let f = Math.pow(2, -Math.floor(Math.log2(ext)));
  if (!isFinite(f) || f === 0) return 1;
  if (ext * f >= 2) f *= 0.5;
  else if (ext * f < 1) f *= 2;
  return f;
}
const _sp = (p, f) => (p ? [p[0] * f, p[1] * f] : p);
/// One segment at a different size. Arcs scale through their center and radii -- the angles are
/// already dimensionless -- and go back through mkArc with their endpoints scaled as every other
/// segment's points are, so a vertex an arc shares with its neighbor keeps one value.
export function scaleSegBy(sg, f) {
  if (f === 1) return sg;
  if (sg.type === SEG_ARC) {
    const o = mkArc(
      sg.cx * f,
      sg.cy * f,
      sg.rx * f,
      sg.ry * f,
      sg.theta_start,
      sg.theta_end,
      sg.phi,
      sg.large_arc_flag,
      sg.sweep_flag,
      _sp(sg.p1, f),
      _sp(sg.p4, f),
    );
    if (sg.src !== undefined) o.src = sg.src;
    return o;
  }
  const o = { ...sg };
  for (const k of ['p1', 'p2', 'p3', 'p4']) if (sg[k]) o[k] = _sp(sg[k], f);
  return o;
}
