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
// Each primitive also gets a splitter to produce sub-segments at a
// parameter value. For Beziers we use De Casteljau; for arcs we just
// reparameterize the theta range.

import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  mkLine, mkQuad, mkCubic, mkArc,
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
  if (seg.type === SEG_LINE) return [seg];   // always monotone

  const tCrit = yMonotoneCriticalParams(seg);
  if (tCrit.length === 0) return [seg];
  return splitAtParams(seg, tCrit);
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
      if (Math.abs(cy) > EPS) {
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
      const cp = Math.cos(phi), sp = Math.sin(phi);
      // Two cases:
      //   sp·rx ≈ 0  → cp·ry·cos(θ) = 0 → θ = ±π/2.
      //   else       → tan(θ) = cp·ry / (sp·rx); two θ per period.
      let candAngles;
      if (Math.abs(sp * rx) < EPS) {
        if (Math.abs(cp * ry) < EPS) candAngles = [];
        else candAngles = [Math.PI / 2, -Math.PI / 2];
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
      return [
        mkLine([seg.p1[0], seg.p1[1]], [mx, my]),
        mkLine([mx, my], [seg.p2[0], seg.p2[1]]),
      ];
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
      return [
        mkArc(seg.cx, seg.cy, seg.rx, seg.ry, t0, thetaMid, seg.phi,
              seg.large_arc_flag, seg.sweep_flag),
        mkArc(seg.cx, seg.cy, seg.rx, seg.ry, thetaMid, t1, seg.phi,
              seg.large_arc_flag, seg.sweep_flag),
      ];
    }
  }
  return [seg, seg];
}

/** Split a single segment at one parameter value (used to subdivide
 *  at a discovered intersection point). Returns [left, right]; one
 *  side is null when t is at an endpoint.
 */
export function splitSegAt(seg, t) {
  if (t < EPS) return [null, seg];
  if (t > 1 - EPS) return [seg, null];
  return splitOne(seg, t);
}
