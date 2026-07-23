// fillRule.js — point-in-shape test per the fill rule. Used by the
// silhouette extractor to classify each DCEL face as inside or
// outside the union of the original shapes.
//
// Algorithm: cast a horizontal ray from the test point to +infinity.
// For each segment in the shape, find ray-segment intersections via
// intersectSegments (treating the ray as a horizontal line segment
// extending well past the shape's bbox).
//
//   Nonzero rule: count signed crossings (segment going downward
//   counts +1, upward counts -1, or vice versa). Inside if total ≠ 0.
//
//   Even-odd rule: count crossings as ±1. Inside if odd count.
//
// We need the SIGNED direction of crossing for nonzero, which depends
// on whether the segment's y is increasing or decreasing across the
// crossing point. After y-monotone subdivision, each segment is
// strictly one or the other.

import { mkLine, SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../../segment.js';
import { intersectSegments } from '../intersect/index.js';

const EPS = 1e-9;

/** Test whether point `p` is inside a shape defined by segs (an
 *  array of segments — assumed to form one or more closed contours).
 *  fillRule is 'nonzero' or 'evenodd'.
 *
 *  @param {[number, number]} p
 *  @param {Array<object>} segs
 *  @param {string} fillRule
 *  @returns {boolean}
 */
export function pointInShape(p, segs, fillRule) {
  // Cast a horizontal ray from p extending to far +x. Use a
  // long line segment so it intersects everything.
  const x0 = p[0], y0 = p[1];
  // Far-x bound: extend past the shape's max x by a margin. The
  // intersection kernels are dimensionless.
  //
  // The ray must clear the shape ENTIRELY, or it stops inside and misses
  // crossings — which silently flips an inside/outside verdict.
  //
  // Two scale-blind mistakes to avoid here, both of the family that has bitten
  // repeatedly in this codebase: measuring a curve by its ENDPOINTS (a Bezier
  // reaches to its control hull, not its endpoints — measured 23.7 units past
  // the endpoint extent on real content), and then padding by an ABSOLUTE
  // constant (100 was fine for that content and would not be for the same art
  // authored at 10x coordinates).
  //
  // So: take the extent over control points too, and pad by the shape's own
  // size. A Bezier is contained in its control hull, so this provably clears it.
  let maxX = x0, minX = x0, minY = y0, maxY = y0;
  for (const s of segs) {
    for (const p of [s.p1, s.p2, s.p3, s.p4]) {
      if (!p) continue;
      if (p[0] > maxX) maxX = p[0];
      if (p[0] < minX) minX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[1] < minY) minY = p[1];
    }
    // An arc is not bounded by its control points; use the full radius box.
    if (s.type === SEG_ARC) {
      const r = Math.max(s.rx, s.ry);
      if (s.cx + r > maxX) maxX = s.cx + r;
      if (s.cx - r < minX) minX = s.cx - r;
      if (s.cy + r > maxY) maxY = s.cy + r;
      if (s.cy - r < minY) minY = s.cy - r;
    }
  }
  const farX = maxX + (Math.hypot(maxX - minX, maxY - minY) || 1);
  const rayP1 = [x0, y0];
  const rayP2 = [farX, y0];
  const ray = mkLine(rayP1, rayP2);

  let total = 0;       // signed for nonzero, |count| for evenodd
  for (const seg of segs) {
    const hits = intersectSegments(ray, seg);
    for (const h of hits) {
      // Filter: ray param tA must be > 0 (we only count crossings to
      // the right of p). The kernel returns tA in [0, 1].
      if (h.tA < EPS) continue;
      // Skip exactly-on-ray endpoints to avoid double-counting at
      // segment vertices. The y-monotone preprocessing ensures
      // segments don't touch the ray tangentially in their interior.
      if (h.endpointB) {
        // Crossing at a segment endpoint — handle by considering only
        // the segment whose y-range strictly straddles y0 from above-
        // or-below toward the other side. Skip if endpoint is "below"
        // the ray (the next segment in the path will pick it up at
        // its start).
        const segY0 = segStart(seg)[1];
        const segY1 = segEnd(seg)[1];
        // If both endpoints are on the ray, this is a horizontal
        // sub-segment along the ray itself — skip.
        if (Math.abs(segY0 - y0) < EPS && Math.abs(segY1 - y0) < EPS) continue;
        // If the endpoint matching the crossing is the segment's
        // upper endpoint (and lower endpoint is below the ray), count
        // as a "from below" crossing. If lower endpoint (upper above
        // ray), skip.
        if (h.tB < EPS) {
          // Crossing at segment start. Skip if seg goes downward
          // (start higher than end) — the previous segment in the
          // path already counted this endpoint.
          if (segY0 < segY1) continue;
        } else if (h.tB > 1 - EPS) {
          // Crossing at segment end.
          if (segY1 < segY0) continue;
        }
      }
      // Determine crossing direction: does y(t) increase or decrease
      // as we cross the ray? At the crossing parameter tB, the
      // segment's y-component dy/dt sign tells us.
      const dySign = ySignAtParam(seg, h.tB);
      if (fillRule === 'nonzero') {
        total += dySign;       // +1 if upward, -1 if downward (or
                                // sign-swap depending on convention)
      } else {
        total += 1;
      }
    }
  }

  if (fillRule === 'nonzero') return total !== 0;
  return (total & 1) === 1;
}

/** Sign of dy/dt for a segment at parameter t. Returns +1, -1, or 0. */
function ySignAtParam(s, t) {
  let dyDt;
  switch (s.type) {
    case SEG_LINE:
      dyDt = s.p2[1] - s.p1[1];
      break;
    case SEG_QUAD: {
      // y(t) = ay + by·t + cy·t². dy/dt = by + 2·cy·t.
      const by = 2 * (s.p2[1] - s.p1[1]);
      const cy = s.p1[1] - 2 * s.p2[1] + s.p3[1];
      dyDt = by + 2 * cy * t;
      break;
    }
    case SEG_CUBIC: {
      const by = 3 * (s.p2[1] - s.p1[1]);
      const cy = 3 * (s.p1[1] - 2 * s.p2[1] + s.p3[1]);
      const dy = -s.p1[1] + 3 * s.p2[1] - 3 * s.p3[1] + s.p4[1];
      dyDt = by + 2 * cy * t + 3 * dy * t * t;
      break;
    }
    case SEG_ARC: {
      // y(θ) = cy + sp·rx·cos(θ) + cp·ry·sin(θ).
      // dy/dθ = -sp·rx·sin(θ) + cp·ry·cos(θ).
      // tB ∈ [0, 1] is normalized along the sweep.
      const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
      const theta = s.theta_start + t * (s.theta_end - s.theta_start);
      const cs = Math.cos(theta), ss = Math.sin(theta);
      dyDt = -sp * s.rx * ss + cp * s.ry * cs;
      // Multiply by sweep sign if theta_end < theta_start (reverse-sweep).
      if (s.theta_end < s.theta_start) dyDt = -dyDt;
      break;
    }
    default:
      dyDt = 0;
  }
  if (dyDt > EPS) return 1;
  if (dyDt < -EPS) return -1;
  return 0;
}

function segStart(s) {
  if (s.type === SEG_LINE)  return s.p1;
  if (s.type === SEG_QUAD)  return s.p1;
  if (s.type === SEG_CUBIC) return s.p1;
  if (s.type === SEG_ARC)   return s.p1;
  return [0, 0];
}
function segEnd(s) {
  if (s.type === SEG_LINE)  return s.p2;
  if (s.type === SEG_QUAD)  return s.p3;
  if (s.type === SEG_CUBIC) return s.p4;
  if (s.type === SEG_ARC)   return s.p4;
  return [0, 0];
}
