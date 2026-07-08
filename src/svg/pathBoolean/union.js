// union.js — top-level entry point for path-boolean union.
// Given a set of filled shapes (each shape = an array of segments
// representing one or more closed contours), compute the outer
// silhouette of their union as an array of segments.
//
// Pipeline:
//   1. y-monotone subdivision of every input segment.
//   2. Pairwise intersection + segment splitting.
//   3. DCEL construction.
//   4. Per-face inside/outside classification using the original
//      shapes' fill rules.
//   5. Outer-boundary half-edge traversal: walk the boundary between
//      inside and outside, emitting one segment per boundary half-edge.
//
// The output is a list of original-primitive segments (no flattening
// or approximation) tracing the outer silhouette contour of the
// union. Native SEG_LINE/QUAD/CUBIC/ARC are preserved through the
// entire pipeline.

import { subdivideYMonotone } from './subdivide.js';
import { intersectAndSplit } from './planar/segmentSet.js';
import { buildDCEL } from './planar/dcel.js';
import { pointInShape } from './planar/fillRule.js';

const EPS = 1e-9;

/** Compute the outer silhouette of the union of one or more filled
 *  shapes.
 *
 *  @param {Array<{segs: Array<object>, fillRule: 'nonzero'|'evenodd'}>} shapes
 *  @returns {Array<object>}  — array of segments forming the
 *      silhouette (in order, each segment's end == next segment's
 *      start, last segment's end == first segment's start).
 */
export function unionPaths(shapes) {
  if (!shapes || shapes.length === 0) return [];

  // ---- Step 1: y-monotone subdivision ----
  // Tag each segment with its source shape index.
  const tagged = [];
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    for (const s of shape.segs) {
      const monos = subdivideYMonotone(s);
      for (const m of monos) {
        tagged.push({
          seg: m,
          shapeIdx: i,
          subpathIdx: 0,  // not used at this stage
          origDirection: 1,
          fillRule: shape.fillRule,
        });
      }
    }
  }

  if (tagged.length === 0) return [];

  // ---- Step 2: pairwise intersection + segment splitting ----
  const elementary = intersectAndSplit(tagged);

  // ---- Step 3: DCEL ----
  const dcel = buildDCEL(elementary);
  if (dcel.faces.length === 0) return [];

  // ---- Step 4: classify each face as inside-union or outside ----
  // For each non-outer face, pick an interior point and test against
  // every original shape.
  const insideFaces = new Set();
  for (const f of dcel.faces) {
    if (f.isOuter) continue;
    const p = faceInteriorPoint(f);
    if (!p) continue;
    // Inside union iff inside ANY original shape.
    for (let i = 0; i < shapes.length; i++) {
      if (pointInShape(p, shapes[i].segs, shapes[i].fillRule)) {
        insideFaces.add(f);
        break;
      }
    }
  }

  // ---- Step 5: extract outer boundary ----
  // Boundary half-edges: those whose .face is inside-union and whose
  // .twin.face is NOT (i.e. outside-union, which may be the outer
  // face or any other "between" face).
  const boundaryHEs = new Set();
  for (const h of dcel.halfEdges) {
    const insideHere = insideFaces.has(h.face);
    const insideThere = insideFaces.has(h.twin.face);
    if (insideHere && !insideThere) boundaryHEs.add(h);
  }

  // Trace boundary cycles: pick any unvisited boundary half-edge,
  // follow .next pointers (which stay on the face boundary), collect
  // the underlying segments. Repeat for each disconnected component.
  const visited = new Set();
  const out = [];
  for (const start of boundaryHEs) {
    if (visited.has(start)) continue;
    let cur = start;
    let safety = boundaryHEs.size + 10;
    while (cur && !visited.has(cur) && safety-- > 0) {
      visited.add(cur);
      out.push(orientSegment(cur));
      cur = cur.next;
      // Skip non-boundary half-edges (the .next chain on a face's
      // boundary might hop through non-boundary edges if the face
      // has multiple inside/outside transitions — but for a clean
      // silhouette these don't occur).
      while (cur && !boundaryHEs.has(cur)) {
        if (visited.has(cur)) break;
        cur = cur.next;
      }
    }
  }
  return out;
}

/** Get the underlying geometric segment from a half-edge, oriented
 *  so that the segment runs from h.origin to h.twin.origin (matching
 *  the direction of traversal during boundary walk). If h.dir is -1
 *  the segment needs to be reversed.
 */
function orientSegment(h) {
  if (h.dir > 0) return h.seg;
  return reverseSeg(h.seg);
}

function reverseSeg(s) {
  const t = s.type;
  if (t === 0 /* SEG_LINE */)  return { type: 0, p1: s.p2, p2: s.p1, is_fill_only: s.is_fill_only };
  if (t === 1 /* SEG_QUAD */)  return { type: 1, p1: s.p3, p2: s.p2, p3: s.p1 };
  if (t === 2 /* SEG_CUBIC */) return { type: 2, p1: s.p4, p2: s.p3, p3: s.p2, p4: s.p1 };
  if (t === 3 /* SEG_ARC */) {
    return {
      type: 3, cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry,
      theta_start: s.theta_end, theta_end: s.theta_start, phi: s.phi,
      large_arc_flag: s.large_arc_flag,
      sweep_flag: s.sweep_flag ? 0 : 1,
      p1: s.p4, p4: s.p1,
    };
  }
  return s;
}

/** Return a point provably interior to the FACE (used only to classify
 *  the face inside/outside the original shapes via the fill rule). The
 *  vertex centroid is wrong for non-convex faces — it can land in a
 *  notch outside the face — which silently drops concave glyph/SVG
 *  outlines from the union. The DCEL builds bounded faces with CCW
 *  boundary cycles, so the interior lies to the LEFT of each half-edge.
 *  Take the longest boundary edge (numerically most stable), step a
 *  small epsilon along its inward normal (-dy, dx) from its midpoint.
 */
function faceInteriorPoint(face) {
  let cur = face.halfEdge;
  if (!cur) return null;
  let safety = 100000;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let n = 0, best = null, bestLen = -1;
  do {
    const ax = cur.origin.x, ay = cur.origin.y;
    if (ax < minx) minx = ax; if (ax > maxx) maxx = ax;
    if (ay < miny) miny = ay; if (ay > maxy) maxy = ay;
    const bx = cur.twin.origin.x, by = cur.twin.origin.y;
    const len = Math.hypot(bx - ax, by - ay);
    if (len > bestLen) { bestLen = len; best = cur; }
    n++;
    cur = cur.next;
  } while (cur && cur !== face.halfEdge && safety-- > 0);
  if (n === 0 || !best) return null;
  const diag = Math.hypot(maxx - minx, maxy - miny) || 1;
  const eps = diag * 1e-4;
  const ax = best.origin.x, ay = best.origin.y;
  const bx = best.twin.origin.x, by = best.twin.origin.y;
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  return [(ax + bx) / 2 - (dy / len) * eps, (ay + by) / 2 + (dx / len) * eps];
}
