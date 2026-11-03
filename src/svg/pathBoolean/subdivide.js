// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// subdivide.js — split a segment into y-monotone sub-segments by
// subdividing at every parameter value where dy/dt = 0.
//
// y-monotone segments (dy/dt has constant sign on (0, 1)) are
// required by the planar-subdivision sweep so that each segment is
// either strictly entering or strictly leaving the sweep line at any
// given y. Non-monotone segments produce ambiguous sweep events
// (a segment can be both above and below the sweep line at the same
// y) which makes the sweep's segment-comparator unable to give a
// total order.
//
// Per-primitive y-critical-point math:
//   LINE:   never (unless horizontal — handled separately).
//   QUAD:   y(s) = by + 2·cy·s = 0 → s = -by / (2·cy). At most 1 root.
//   CUBIC:  y'(s) = by + 2·cy·s + 3·dy·s² = 0 → quadratic. ≤ 2 roots.
//   ARC:    dy/dθ = -sp·rx·sin θ + cp·ry·cos θ = 0 → tan θ = cp·ry / (sp·rx).
//           2 solutions per period (θ and θ+π); filter to sweep range.
//

import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  mkLine,
  mkQuad,
  mkCubic,
  mkArc,
} from '../segment.js';
import { solveQuadratic } from './polyRoots.js';

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

/** Subdivide a segment into y-monotone sub-segments. Returns an
 *  array of new segments — typically 1-3 for Beziers, up to 3 for
 *  arcs (sweep crossing 2 y-extrema). Original segment unchanged.
 *
 *  @param {object} seg — segment to split (LINE/QUAD/CUBIC/ARC).
 *  @returns {Array<object>}
 */
export function subdivideYMonotone(seg) {
  if (!seg) return [];
  if (seg.type === SEG_LINE) return [seg]; // always monotone
  const straight = collinearAsLines(seg);
  if (straight) return straight;

  // A cubic's own double point is a vertex. Both branches lie on one algebraic curve, so the exact composition of one piece's
  // implicit along the other is zero everywhere and has no root to find; it has to be cut here, closed form, or the
  // arrangement keeps a crossing inside its edges.
  const tCrit = yMonotoneCriticalParams(seg);
  if (seg.type === SEG_CUBIC) {
    const loop = cubicLoopParams(seg);
    if (loop) {
      for (const t of loop) if (!tCrit.some((c) => Math.abs(c - t) <= 1e-6)) tCrit.push(t);
      tCrit.sort((a, b) => a - b);
    }
  }
  if (tCrit.length === 0) return [seg];
  return splitAtParams(seg, tCrit);
}

/** The two parameters where a cubic passes its own double point, when both lie inside the segment; else null.
 *  With C1, C2, C3 the power-basis coefficients, s = t1 + t2 and p = t1 * t2 solve
 *  C1 + C2 s + C3 (s^2 - p) = 0, which is linear in s and p once crossed with C3. Dimensionless: every cross product
 *  carries the square of the size, and only ratios of them are read. */
function cubicLoopParams(seg) {
  const a = seg.p1,
    b = seg.p2,
    c = seg.p3,
    d = seg.p4;
  const c1x = 3 * (b[0] - a[0]),
    c1y = 3 * (b[1] - a[1]);
  const c2x = 3 * (a[0] - 2 * b[0] + c[0]),
    c2y = 3 * (a[1] - 2 * b[1] + c[1]);
  const c3x = d[0] - a[0] + 3 * (b[0] - c[0]),
    c3y = d[1] - a[1] + 3 * (b[1] - c[1]);
  const cr23 = c2x * c3y - c2y * c3x;
  if (!(Math.abs(cr23) > 1e-12 * Math.hypot(c2x, c2y) * Math.hypot(c3x, c3y))) return null;
  const s = -(c1x * c3y - c1y * c3x) / cr23;
  const p =
    s * s + (Math.abs(c3x) >= Math.abs(c3y) ? (c1x + c2x * s) / c3x : (c1y + c2y * s) / c3y);
  const disc = s * s - 4 * p;
  if (!(disc > 0)) return null;
  const r = Math.sqrt(disc),
    t1 = (s - r) / 2,
    t2 = (s + r) / 2;
  return t1 > EPS && t2 < 1 - EPS && t2 - t1 > 1e-6 ? [t1, t2] : null;
}

/** A curve whose control points are collinear is a straight run that may fold back on itself. As a curve it holds a turning
 *  point no y-split finds when the run is level, and the pieces either side of a fold lie on each other, which no curve
 *  kernel reports as coincident. As lines, cut at the turning points, it is the same ink and the arrangement knows what to
 *  do with it. Null when the curve is not straight. The tolerance is the rounding of the coordinates, so any scale. */
function collinearAsLines(seg) {
  const P =
    seg.type === SEG_QUAD
      ? [seg.p1, seg.p2, seg.p3]
      : seg.type === SEG_CUBIC
        ? [seg.p1, seg.p2, seg.p3, seg.p4]
        : null;
  if (!P) return null;
  let far = P[0],
    fd = 0,
    mag = 0;
  for (const q of P) {
    const e = Math.hypot(q[0] - P[0][0], q[1] - P[0][1]);
    if (e > fd) {
      fd = e;
      far = q;
    }
    mag = Math.max(mag, Math.abs(q[0]), Math.abs(q[1]));
  }
  if (!(fd > 0)) return null;
  const dx = (far[0] - P[0][0]) / fd,
    dy = (far[1] - P[0][1]) / fd;
  for (const q of P)
    if (Math.abs((q[0] - P[0][0]) * dy - (q[1] - P[0][1]) * dx) > 64 * Number.EPSILON * mag)
      return null;
  // The position along the run is a polynomial of the same degree; its turning points are the roots of the derivative.
  const u = P.map((q) => (q[0] - P[0][0]) * dx + (q[1] - P[0][1]) * dy);
  let ts;
  if (P.length === 3) {
    const c = u[0] - 2 * u[1] + u[2];
    ts = Math.abs(c) > 0 ? [(u[0] - u[1]) / c] : [];
  } else
    ts = solveQuadratic(
      3 * (-u[0] + 3 * u[1] - 3 * u[2] + u[3]),
      6 * (u[0] - 2 * u[1] + u[2]),
      3 * (u[1] - u[0]),
    );
  ts = ts.filter((t) => t > EPS && t < 1 - EPS).sort((a, b) => a - b);
  const at = (t) => {
    const v = 1 - t;
    return P.length === 3
      ? [
          v * v * P[0][0] + 2 * v * t * P[1][0] + t * t * P[2][0],
          v * v * P[0][1] + 2 * v * t * P[1][1] + t * t * P[2][1],
        ]
      : [
          v * v * v * P[0][0] +
            3 * v * v * t * P[1][0] +
            3 * v * t * t * P[2][0] +
            t * t * t * P[3][0],
          v * v * v * P[0][1] +
            3 * v * v * t * P[1][1] +
            3 * v * t * t * P[2][1] +
            t * t * t * P[3][1],
        ];
  };
  const out = [];
  let a = P[0];
  for (const t of ts) {
    const b = at(t);
    if (b[0] !== a[0] || b[1] !== a[1]) {
      out.push(mkLine(a, b));
      a = b;
    }
  }
  const z = P[P.length - 1];
  if (z[0] !== a[0] || z[1] !== a[1]) out.push(mkLine(a, z));
  return out;
}

/** Compute interior-of-[0,1] critical parameters where dy/dt = 0. */
function yMonotoneCriticalParams(seg) {
  const out = [];
  switch (seg.type) {
    case SEG_QUAD: {
      // Power-form: y(s) = ay + by·s + cy·s² where
      //   ay = p1.y, by = 2(p2.y - p1.y), cy = p1.y - 2p2.y + p3.y.
      const by = 2 * (seg.p2[1] - seg.p1[1]);
      const cy = seg.p1[1] - 2 * seg.p2[1] + seg.p3[1];
      // dy/ds = by + 2·cy·s = 0 → s = -by / (2·cy).
      // cy is judged against the precision of the y coordinates it is made from, not an absolute 1e-9:
      // a curved quad a few 1e-5 of the union's size has a genuine cy under that and would keep its
      // y-extremum inside a "monotone" piece. A cy smaller than |by| / 2 puts s outside (0, 1) by itself.
      if (
        Math.abs(cy) >
        64 * Number.EPSILON * (Math.abs(seg.p1[1]) + 2 * Math.abs(seg.p2[1]) + Math.abs(seg.p3[1]))
      ) {
        const s = -by / (2 * cy);
        if (s > EPS && s < 1 - EPS) out.push(s);
      }
      break;
    }
    case SEG_CUBIC: {
      // Power-form coefs (matches segToPolyXY in bezierClip.js).
      const by = 3 * (seg.p2[1] - seg.p1[1]);
      const cy = 3 * (seg.p1[1] - 2 * seg.p2[1] + seg.p3[1]);
      const dy = -seg.p1[1] + 3 * seg.p2[1] - 3 * seg.p3[1] + seg.p4[1];
      // y'(s) = by + 2·cy·s + 3·dy·s² = 0 → quadratic in s.
      for (const s of solveQuadratic(3 * dy, 2 * cy, by)) {
        if (s > EPS && s < 1 - EPS) out.push(s);
      }
      break;
    }
    case SEG_ARC: {
      // y(θ) = cy + sp·rx·cos θ + cp·ry·sin θ
      // dy/dθ = -sp·rx·sin θ + cp·ry·cos θ = 0
      // → tan θ_crit = cp·ry / (sp·rx)
      const { rx, ry, phi, theta_start: t0, theta_end: t1 } = seg;
      const cp = Math.cos(phi),
        sp = Math.sin(phi);

      let candAngles;
      if (!(rx > 0 && ry > 0)) {
        candAngles = [];
      } else {
        const baseTheta = Math.atan2(cp * ry, sp * rx);
        candAngles = [baseTheta, baseTheta + Math.PI];
      }
      // Filter angles to the arc's sweep range, then convert to
      // parameter t ∈ (0, 1).
      const sweep = t1 - t0;
      if (Math.abs(sweep) < EPS) break;
      const tLo = Math.min(t0, t1);
      const tHi = Math.max(t0, t1);
      for (const baseTheta of candAngles) {
        // Normalize baseTheta into the sweep range.
        let th = baseTheta;
        while (th < tLo) th += TWO_PI;
        while (th > tHi) th -= TWO_PI;
        if (th < tLo - EPS || th > tHi + EPS) continue;
        const t = (th - t0) / sweep;
        if (t > EPS && t < 1 - EPS) out.push(t);
      }
      break;
    }
  }
  // Sort and de-duplicate.
  out.sort((a, b) => a - b);
  const uniq = [];
  for (const t of out) {
    if (uniq.length === 0 || t - uniq[uniq.length - 1] > 1e-6) uniq.push(t);
  }
  return uniq;
}

/** Split a segment at a sorted list of parameter values in (0, 1).
 *  Returns N+1 sub-segments where N = ts.length.
 */
function splitAtParams(seg, ts) {
  if (ts.length === 0) return [seg];
  let current = seg;
  const out = [];
  let prevT = 0;
  for (const t of ts) {
    // Re-parameterize t into the current sub-segment's local frame.
    const localT = (t - prevT) / (1 - prevT);
    const [left, right] = splitOne(current, localT);
    out.push(left);
    current = right;
    prevT = t;
  }
  out.push(current);
  return out;
}

/** Split a single segment at local parameter t ∈ (0, 1).
 *  Returns [leftSubSeg, rightSubSeg], each of the same type. */
function splitOne(seg, t) {
  switch (seg.type) {
    case SEG_LINE: {
      const mx = seg.p1[0] + t * (seg.p2[0] - seg.p1[0]);
      const my = seg.p1[1] + t * (seg.p2[1] - seg.p1[1]);
      return [mkLine([seg.p1[0], seg.p1[1]], [mx, my]), mkLine([mx, my], [seg.p2[0], seg.p2[1]])];
    }
    case SEG_QUAD: {
      // De Casteljau on 3 points.
      const ax = seg.p1[0] + t * (seg.p2[0] - seg.p1[0]);
      const ay = seg.p1[1] + t * (seg.p2[1] - seg.p1[1]);
      const bx = seg.p2[0] + t * (seg.p3[0] - seg.p2[0]);
      const by = seg.p2[1] + t * (seg.p3[1] - seg.p2[1]);
      const mx = ax + t * (bx - ax);
      const my = ay + t * (by - ay);
      return [
        mkQuad([seg.p1[0], seg.p1[1]], [ax, ay], [mx, my]),
        mkQuad([mx, my], [bx, by], [seg.p3[0], seg.p3[1]]),
      ];
    }
    case SEG_CUBIC: {
      const ax = seg.p1[0] + t * (seg.p2[0] - seg.p1[0]);
      const ay = seg.p1[1] + t * (seg.p2[1] - seg.p1[1]);
      const bx = seg.p2[0] + t * (seg.p3[0] - seg.p2[0]);
      const by = seg.p2[1] + t * (seg.p3[1] - seg.p2[1]);
      const cx_ = seg.p3[0] + t * (seg.p4[0] - seg.p3[0]);
      const cy_ = seg.p3[1] + t * (seg.p4[1] - seg.p3[1]);
      const dx = ax + t * (bx - ax);
      const dy = ay + t * (by - ay);
      const ex = bx + t * (cx_ - bx);
      const ey = by + t * (cy_ - by);
      const mx = dx + t * (ex - dx);
      const my = dy + t * (ey - dy);
      return [
        mkCubic([seg.p1[0], seg.p1[1]], [ax, ay], [dx, dy], [mx, my]),
        mkCubic([mx, my], [ex, ey], [cx_, cy_], [seg.p4[0], seg.p4[1]]),
      ];
    }
    case SEG_ARC: {
      // Split arc by re-parameterizing theta range.
      const t0 = seg.theta_start;
      const t1 = seg.theta_end;
      const thetaMid = t0 + t * (t1 - t0);
      const mid = mkArc(
        seg.cx,
        seg.cy,
        seg.rx,
        seg.ry,
        thetaMid,
        thetaMid,
        seg.phi,
        0,
        seg.sweep_flag,
      ).p1; // shared
      return [
        mkArc(
          seg.cx,
          seg.cy,
          seg.rx,
          seg.ry,
          t0,
          thetaMid,
          seg.phi,
          seg.large_arc_flag,
          seg.sweep_flag,
          seg.p1,
          mid,
        ),
        mkArc(
          seg.cx,
          seg.cy,
          seg.rx,
          seg.ry,
          thetaMid,
          t1,
          seg.phi,
          seg.large_arc_flag,
          seg.sweep_flag,
          mid,
          seg.p4,
        ),
      ];
    }
  }
  return [seg, seg];
}

/*

 */
export function splitSegAt(seg, t) {
  if (t < EPS) return [null, seg];
  if (t > 1 - EPS) return [seg, null];
  return splitOne(seg, t);
}
