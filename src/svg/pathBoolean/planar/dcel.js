// dcel.js — Doubly-Connected Edge List construction from a set of
// elementary (non-crossing-except-at-endpoints) segments. Used to
// represent the planar subdivision of the bundle's union, from which
// the outer silhouette boundary is extracted.
//
// DCEL data structures:
//
//   Vertex:   { x, y, key, halfEdges[] }
//             halfEdges = outgoing half-edges from this vertex,
//             ordered by tangent angle (CCW from +x axis).
//
//   HalfEdge: { origin, twin, next, prev, face, seg, dir, ...prov }
//             origin   = source vertex
//             twin     = opposite-direction half-edge (one pair per
//                        elementary segment).
//             next     = next half-edge along the same face boundary
//                        (CCW around face interior).
//             prev     = previous half-edge along the face boundary.
//             face     = incident face (left of the half-edge).
//             seg      = underlying geometric segment.
//             dir      = +1 if half-edge runs along seg from p1 to p4;
//                        -1 if reversed.
//             provenance fields (shapeIdx, subpathIdx, fillRule,
//             origDirection) copied from the segment-set inputs.
//
//   Face:     { halfEdge, isOuter }
//             halfEdge = a representative half-edge of this face's
//                        boundary cycle.
//             isOuter  = true for the single unbounded outer face;
//                        false for all bounded faces.

import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../../segment.js';
import { pointKey } from './segmentSet.js';

const EPS = 1e-9;

/** Build a DCEL from an array of elementary segments (one per
 *  intersectAndSplit output). Returns { vertices, halfEdges, faces }.
 *
 *  Steps:
 *    1. Bucket endpoints into vertices (snap by pointKey).
 *    2. Build 2 half-edges per segment (forward + backward).
 *    3. Around each vertex, order outgoing half-edges by tangent
 *       angle. Set next/prev pointers via the "next CCW twin"
 *       rule: for half-edge h, h.next = twin of the half-edge
 *       immediately CW from h around h's destination vertex.
 *    4. Walk half-edge cycles to identify faces.
 *    5. Mark the unbounded face (the cycle with negative signed area).
 */
export function buildDCEL(elementarySegs) {
  // ---- Phase 1: bucket endpoints into vertices ----
  const vertMap = new Map();
  const vertices = [];

  function vertexFor(point) {
    const key = pointKey(point);
    let v = vertMap.get(key);
    if (!v) {
      v = { x: point[0], y: point[1], key, halfEdges: [] };
      vertMap.set(key, v);
      vertices.push(v);
    }
    return v;
  }

  // ---- Phase 2: build half-edges ----
  const halfEdges = [];
  for (const entry of elementarySegs) {
    const s = entry.seg;
    if (!s) continue;
    const start = segStart(s);
    const end = segEnd(s);
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < EPS) continue; // zero-length

    const v0 = vertexFor(start);
    const v1 = vertexFor(end);
    if (v0 === v1) continue; // degenerate loop

    const fwd = {
      origin: v0,
      seg: s,
      dir: +1,
      twin: null, next: null, prev: null, face: null,
      shapeIdx: entry.shapeIdx,
      subpathIdx: entry.subpathIdx,
      fillRule: entry.fillRule,
      origDirection: entry.origDirection,
    };
    const bwd = {
      origin: v1,
      seg: s,
      dir: -1,
      twin: null, next: null, prev: null, face: null,
      shapeIdx: entry.shapeIdx,
      subpathIdx: entry.subpathIdx,
      fillRule: entry.fillRule,
      origDirection: entry.origDirection,
    };
    fwd.twin = bwd;
    bwd.twin = fwd;
    halfEdges.push(fwd, bwd);
    v0.halfEdges.push(fwd);
    v1.halfEdges.push(bwd);
  }

  // ---- Phase 3: order outgoing half-edges around each vertex ----
  for (const v of vertices) {
    for (const h of v.halfEdges) {
      h.tangentAngle = outgoingTangentAngle(h);
    }
    v.halfEdges.sort((a, b) => a.tangentAngle - b.tangentAngle);
  }

  // Build next/prev: for each half-edge h ending at vertex v, find
  // the outgoing half-edge that immediately precedes h.twin in CCW
  // order around v. That's h.next.
  for (const v of vertices) {
    const outs = v.halfEdges;
    if (outs.length === 0) continue;
    const n = outs.length;
    for (let i = 0; i < n; i++) {
      const outHe = outs[i];           // outgoing from v
      // Arriving at v along twin(out_next) (the incoming half-edge whose
      // outgoing twin is the CCW-NEXT ray), the boundary of the face
      // between the two rays leaves along outHe:
      //   next(twin(out_{i+1})) = out_i    (de Berg's CW-successor rule)
      // The two pairings are identical at degree-2 vertices (every simple
      // contour), so only CROSSING vertices (degree 4+, exactly the
      // self-overlap-resolve case) distinguish them — the CCW pairing
      // walked straight through crossings and fused the faces.
      const nextIdx = (i + 1) % n;
      const nextOut = outs[nextIdx];
      nextOut.twin.next = outHe;
      outHe.prev = nextOut.twin;
    }
  }

  // ---- Phase 4: walk half-edge cycles to identify faces ----
  const faces = [];
  for (const h of halfEdges) {
    if (h.face) continue;
    const face = { halfEdge: h, isOuter: false };
    faces.push(face);
    let cur = h;
    let safety = halfEdges.length + 1;
    while (cur && !cur.face && safety-- > 0) {
      cur.face = face;
      cur = cur.next;
    }
  }

  // ---- Phase 5: mark unbounded face(s) ----
  //
  // Bounded faces have CCW boundary cycles → positive signed area.
  // Each connected component of the planar graph has ONE
  // unbounded-face cycle traced CW from outside → negative signed
  // area. For a connected DCEL there's exactly one such cycle; for
  // a disconnected DCEL (e.g. two disjoint shapes) there's one per
  // component. All of them belong to the same plane-level
  // unbounded face topologically, so we mark each as `isOuter`.
  //
  // Robustness: for a single point or a graph with all degenerate
  // edges, the signed area is 0 — those faces don't matter for
  // silhouette extraction.
  for (const f of faces) {
    const a = faceSignedArea(f);
    if (a < -EPS) f.isOuter = true;
  }

  return { vertices, halfEdges, faces };
}

/** Outgoing tangent direction (angle in radians, [-π, π]) of a
 *  half-edge from its origin vertex. For fwd half-edges, the tangent
 *  is the segment's tangent at its start (p1). For bwd half-edges,
 *  the tangent is the segment's REVERSED tangent at its end (p4).
 */
function outgoingTangentAngle(h) {
  const s = h.seg;
  const dir = h.dir;
  let tx, ty;
  switch (s.type) {
    case SEG_LINE: {
      const dx = s.p2[0] - s.p1[0], dy = s.p2[1] - s.p1[1];
      tx = dir * dx;
      ty = dir * dy;
      break;
    }
    case SEG_QUAD: {
      // Tangent at start: 2(p2 - p1). Tangent at end: 2(p3 - p2).
      if (dir > 0) {
        tx = 2 * (s.p2[0] - s.p1[0]);
        ty = 2 * (s.p2[1] - s.p1[1]);
      } else {
        tx = -2 * (s.p3[0] - s.p2[0]);
        ty = -2 * (s.p3[1] - s.p2[1]);
      }
      // Handle degenerate (p2 == p1 or p2 == p3).
      if (Math.abs(tx) < EPS && Math.abs(ty) < EPS) {
        if (dir > 0) { tx = s.p3[0] - s.p1[0]; ty = s.p3[1] - s.p1[1]; }
        else         { tx = -(s.p1[0] - s.p3[0]); ty = -(s.p1[1] - s.p3[1]); }
      }
      break;
    }
    case SEG_CUBIC: {
      if (dir > 0) {
        tx = 3 * (s.p2[0] - s.p1[0]);
        ty = 3 * (s.p2[1] - s.p1[1]);
      } else {
        tx = -3 * (s.p4[0] - s.p3[0]);
        ty = -3 * (s.p4[1] - s.p3[1]);
      }
      // Degenerate (p2 == p1 or p3 == p4).
      if (Math.abs(tx) < EPS && Math.abs(ty) < EPS) {
        if (dir > 0) { tx = s.p4[0] - s.p1[0]; ty = s.p4[1] - s.p1[1]; }
        else         { tx = -(s.p1[0] - s.p4[0]); ty = -(s.p1[1] - s.p4[1]); }
      }
      break;
    }
    case SEG_ARC: {
      // Tangent at start θ = θ_start: derivative of (cx + rx·cos(θ)·cp - ry·sin(θ)·sp, ...)
      //   dx/dθ = -rx·sin(θ)·cp - ry·cos(θ)·sp
      //   dy/dθ = -rx·sin(θ)·sp + ry·cos(θ)·cp
      // Multiply by sign(theta_end - theta_start) to get tangent along
      // the sweep direction.
      const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
      const theta = (dir > 0) ? s.theta_start : s.theta_end;
      const sweepSign = (s.theta_end >= s.theta_start) ? 1 : -1;
      const cs = Math.cos(theta), ss = Math.sin(theta);
      const dxdt = -s.rx * ss * cp - s.ry * cs * sp;
      const dydt = -s.rx * ss * sp + s.ry * cs * cp;
      tx = dir * sweepSign * dxdt;
      ty = dir * sweepSign * dydt;
      break;
    }
    default:
      tx = 1; ty = 0;
  }
  return Math.atan2(ty, tx);
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

/** Signed area of a face by walking its half-edge cycle and applying
 *  the shoelace formula on the half-edges' origin vertices. */
function faceSignedArea(face) {
  let area = 0;
  let cur = face.halfEdge;
  let safety = 100000;
  do {
    const x0 = cur.origin.x, y0 = cur.origin.y;
    const x1 = cur.twin.origin.x, y1 = cur.twin.origin.y;
    area += (x0 * y1 - x1 * y0);
    cur = cur.next;
  } while (cur && cur !== face.halfEdge && safety-- > 0);
  return area * 0.5;
}

export { faceSignedArea };
