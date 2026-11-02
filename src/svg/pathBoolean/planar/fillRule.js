// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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

import { mkLine, SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../../segment.js';
import { intersectSegments } from '../intersect/index.js';
import { subdivideYMonotone } from '../subdivide.js';

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
  const x0 = p[0],
    y0 = p[1];
  // Far-x bound: extend past the shape's max x by a margin. The
  // intersection kernels are dimensionless.
  //
  // The ray must clear the shape ENTIRELY, or it stops inside and misses
  // crossings — which silently flips an inside/outside verdict.

  // So: take the extent over control points too, and pad by the shape's own
  // size. A Bezier is contained in its control hull, so this provably clears it.
  let maxX = x0,
    minX = x0,
    minY = y0,
    maxY = y0;
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

  // Piece by y-monotone piece, which is what the vertex rule below and the direction of a crossing both rest on. Whole
  // curves break both. A curve's tangent can be horizontal at the very vertex the ray goes through (a smooth step, or the
  // midpoint of a vertical edge level with a corner of a rounded shape), which gives that crossing no direction and
  // nonzero loses it: a filled triangle with one curved side would read as empty. And a curve that leaves the ray, turns,
  // and crosses it again would be counted at the vertex and again at the crossing.
  let total = 0; // signed for nonzero, |count| for evenodd
  for (const whole of segs)
    for (const seg of subdivideYMonotone(whole)) {
      const hits = intersectSegments(ray, seg);
      const segY0 = segStart(seg)[1],
        segY1 = segEnd(seg)[1];
      for (const h of hits) {
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
          // If the segment LIES ALONG the ray, it is a horizontal sub-segment of the ray itself — skip.
          // "On the ray" within the tolerance the kernels give this pair (the ray and the segment): 1e-9
          // of their extent, or the precision of the coordinates -- not an absolute 1e-9, which depends on
          // the size of the drawing handed in.
          //
          // Its endpoints are not the segment. Asking only whether both ENDS are on the ray is the chord
          // standing in for the curve: a cubic that leaves the ray and comes back has both ends on it, and
          // so does a closed contour's SEAM, where the start and the end are the same point. Skipping both
          // outright would leave the crossing at that vertex uncounted and read the parity backwards --
          // a <circle> (one full-turn arc, seam at theta = pi) would report every point on the ray through its
          // center, out to infinity on the seam side, as INSIDE it. A Bezier lies inside its control hull, so it
          // is on the ray exactly when all of its control points are; an arc with both ends on the ray still
          // bulges off it, and a full turn has both ends at the same point.
          const tolY = Math.max(
            1e-9 * (farX - minX + maxY - minY),
            32e-15 * Math.max(Math.abs(y0), Math.abs(segY0), Math.abs(segY1)),
          );
          let alongRay = Math.abs(segY0 - y0) <= tolY && Math.abs(segY1 - y0) <= tolY;
          if (alongRay && seg.type !== SEG_LINE) {
            if (seg.type === SEG_ARC) alongRay = false;
            else
              for (const q of [seg.p2, seg.p3, seg.p4]) {
                if (q && Math.abs(q[1] - y0) > tolY) {
                  alongRay = false;
                  break;
                }
              }
          }
          if (alongRay) continue;
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

        if (fillRule === 'nonzero') {
          total += Math.sign(segY1 - segY0); // a monotone piece runs one way
        } else {
          total += 1;
        }
        // A monotone piece meets a level ray once. A kernel can report that one meeting twice: a triple root, where a curve leaves
        // the ray flat, comes back as two hits at one parameter, and counting both flips the parity.
        break;
      }
    }

  if (fillRule === 'nonzero') return total !== 0;
  return (total & 1) === 1;
}

function segStart(s) {
  if (s.type === SEG_LINE) return s.p1;
  if (s.type === SEG_QUAD) return s.p1;
  if (s.type === SEG_CUBIC) return s.p1;
  if (s.type === SEG_ARC) return s.p1;
  return [0, 0];
}
function segEnd(s) {
  if (s.type === SEG_LINE) return s.p2;
  if (s.type === SEG_QUAD) return s.p3;
  if (s.type === SEG_CUBIC) return s.p4;
  if (s.type === SEG_ARC) return s.p4;
  return [0, 0];
}
