// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
import { segPoint, segAreaTerm, monotoneReach, pointAtDistance } from './segGeom.js';

const EPS = 1e-9;

/** Build a DCEL from an array of elementary segments (one per
 *  intersectAndSplit output). Returns { vertices, halfEdges, faces }.
 *
 *  Steps:
 *    1. Bucket endpoints into vertices (merge by distance).
 *    2. Build 2 half-edges per segment (forward + backward).
 *    3. Around each vertex, order outgoing half-edges by tangent
 *       angle. Set next/prev pointers via the "next CCW twin"
 *       rule: for half-edge h, h.next = twin of the half-edge
 *       immediately CW from h around h's destination vertex.
 *    4. Walk half-edge cycles to identify faces.
 *    5. Mark the unbounded face (the cycle with negative signed area).
 */
export function buildDCEL(elementarySegs) {
  // ---- Step 1: bucket endpoints into vertices ----
  const vertMap = new Map();
  const vertices = [];

  const VTOL = 1e-5;
  function vertexFor(point) {
    const ix = Math.floor(point[0] / VTOL),
      iy = Math.floor(point[1] / VTOL);
    let best = null,
      bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = vertMap.get(ix + dx + ',' + (iy + dy));
        if (!bucket) continue;
        for (const u of bucket) {
          const d = Math.max(Math.abs(u.x - point[0]), Math.abs(u.y - point[1]));
          if (d <= VTOL && d < bestD) {
            best = u;
            bestD = d;
          }
        }
      }
    if (best) return best;
    const key = ix + ',' + iy;
    const v = { x: point[0], y: point[1], key, id: vertices.length, halfEdges: [] };
    const bucket = vertMap.get(key);
    if (bucket) bucket.push(v);
    else vertMap.set(key, [v]);
    vertices.push(v);
    return v;
  }

  // ---- Step 2: build half-edges ----
  //
  // One edge per piece of curve. Two inputs that run along the same curve between the same two
  // vertices -- a shape and its duplicate, two shapes sharing an edge, a contour doubling back on
  // itself -- are one boundary, not two. Kept as two they tie at both ends to every order, so no
  // ordering can place them and the face between them encloses nothing; merged, an edge with the
  // same face on both sides simply never reaches the union's boundary. The pieces arrive with the
  // same endpoints because the intersector cuts an overlap at its ends, so the test is four points:
  // both ends and the curves at t = 1/3 and 2/3, which for curves of degree <= 3 walked between
  // the same endpoints is identity. Within the input's own extent, and the precision its
  // coordinates carry.
  let _x0 = Infinity,
    _y0 = Infinity,
    _x1 = -Infinity,
    _y1 = -Infinity,
    _mag = 0;
  for (const entry of elementarySegs) {
    if (!entry.seg) continue;
    for (const p of [segStart(entry.seg), segEnd(entry.seg)]) {
      if (p[0] < _x0) _x0 = p[0];
      if (p[0] > _x1) _x1 = p[0];
      if (p[1] < _y0) _y0 = p[1];
      if (p[1] > _y1) _y1 = p[1];
      _mag = Math.max(_mag, Math.abs(p[0]), Math.abs(p[1]));
    }
  }
  const sameTol = Math.max(1e-9 * (Math.hypot(_x1 - _x0, _y1 - _y0) || 0), 32e-15 * _mag);
  const between = new Map();
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
    const pairKey = v0.id < v1.id ? v0.id * 4294967296 + v1.id : v1.id * 4294967296 + v0.id;
    const already = between.get(pairKey);
    if (
      already &&
      already.some((h) => {
        const d = h.origin === v0 ? 1 : -1;
        for (const t of [1 / 3, 2 / 3]) {
          const a = segPoint(s, t, 1),
            b = segPoint(h.seg, t, d);
          if (!(Math.hypot(a[0] - b[0], a[1] - b[1]) <= sameTol)) return false;
        }
        return true;
      })
    )
      continue;

    const fwd = {
      origin: v0,
      seg: s,
      dir: +1,
      twin: null,
      next: null,
      prev: null,
      face: null,
      shapeIdx: entry.shapeIdx,
      subpathIdx: entry.subpathIdx,
      fillRule: entry.fillRule,
      origDirection: entry.origDirection,
    };
    const bwd = {
      origin: v1,
      seg: s,
      dir: -1,
      twin: null,
      next: null,
      prev: null,
      face: null,
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
    if (already) already.push(fwd);
    else between.set(pairKey, [fwd]);
  }

  // ---- Step 3: order outgoing half-edges around each vertex ----
  //
  // THE ORDER IS WHERE THE EDGES RUN, NOT only WHICH WAY THEY LEAVE. Sorting by the tangent angle at
  // the vertex decides nothing where two edges leave in the same direction -- two curves touching,
  // which the intersector splits at the touch -- and there rounding picked the order and fused a
  // face with its neighbor: two discs touching externally unioned to nothing at 24 of 25 scales.
  //
  // So where the order matters (three or more edges) it is read on a circle around the vertex,
  // radius rho, small enough that every edge is still moving AWAY from the vertex when it gets
  // there (segGeom.monotoneReach, a bound rather than a search). Edges of a planar graph do not
  // cross except at vertices, so inside that disc each edge is a simple arc from the center to the
  // circle, and the cyclic order of those arcs' ends on the circle IS their order at the center --
  // exactly, at a tangency or anywhere else, with no tolerance on the angle. At a vertex of degree
  // two there is one cyclic order, so nothing is read.
  for (const v of vertices) {
    for (const h of v.halfEdges) {
      h.tangentAngle = outgoingTangentAngle(h);
    }
    if (v.halfEdges.length >= 3) {
      const reach = v.halfEdges.map((h) => monotoneReach(h.seg, h.dir));
      let rho = Infinity;
      for (const r of reach) if (r.r < rho) rho = r.r;
      rho *= 0.5;
      if (rho > 0 && isFinite(rho)) {
        v.halfEdges.forEach((h, i) => {
          const p = pointAtDistance(h.seg, h.dir, v.x, v.y, rho, reach[i].t);
          h.tangentAngle = Math.atan2(p[1] - v.y, p[0] - v.x);
        });
      }
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
      const outHe = outs[i]; // outgoing from v
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

  // ---- Step 4: walk half-edge cycles to identify faces ----
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

  // ---- Step 5: mark unbounded face(s) ----

  // Robustness: for a single point or a graph with all degenerate
  // edges, the signed area is 0 — those faces don't matter for
  // silhouette extraction.
  //
  // BY THE AREA THE CURVES ENCLOSE, not the polygon of the vertices. A face's edges are curves, and
  // where one bulges past the chord between its vertices the two can disagree in sign: a 3-edge
  // sliver between two overlapping blobs -- two crossings and one curve's own extremum -- has a
  // clockwise vertex triangle but encloses its area counter-clockwise, so the vertex polygon would
  // mark it unbounded, never classify it, and leave a notch in the union. segAreaTerm is closed form per
  // segment kind, so the sign here is the region's.
  for (const f of faces) {
    f.area = faceSignedArea(f);
    if (f.area < -f.areaTol) f.isOuter = true;
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
      const dx = s.p2[0] - s.p1[0],
        dy = s.p2[1] - s.p1[1];
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
        if (dir > 0) {
          tx = s.p3[0] - s.p1[0];
          ty = s.p3[1] - s.p1[1];
        } else {
          tx = -(s.p1[0] - s.p3[0]);
          ty = -(s.p1[1] - s.p3[1]);
        }
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
        if (dir > 0) {
          tx = s.p4[0] - s.p1[0];
          ty = s.p4[1] - s.p1[1];
        } else {
          tx = -(s.p1[0] - s.p4[0]);
          ty = -(s.p1[1] - s.p4[1]);
        }
      }
      break;
    }
    case SEG_ARC: {
      // Tangent at start θ = θ_start: derivative of (cx + rx·cos(θ)·cp - ry·sin(θ)·sp, ...)
      //   dx/dθ = -rx·sin(θ)·cp - ry·cos(θ)·sp
      //   dy/dθ = -rx·sin(θ)·sp + ry·cos(θ)·cp
      // Multiply by sign(theta_end - theta_start) to get tangent along
      // the sweep direction.
      const cp = Math.cos(s.phi),
        sp = Math.sin(s.phi);
      const theta = dir > 0 ? s.theta_start : s.theta_end;
      const sweepSign = s.theta_end >= s.theta_start ? 1 : -1;
      const cs = Math.cos(theta),
        ss = Math.sin(theta);
      const dxdt = -s.rx * ss * cp - s.ry * cs * sp;
      const dydt = -s.rx * ss * sp + s.ry * cs * cp;
      tx = dir * sweepSign * dxdt;
      ty = dir * sweepSign * dydt;
      break;
    }
    default:
      tx = 1;
      ty = 0;
  }
  return Math.atan2(ty, tx);
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

/** Signed area a face's half-edge cycle encloses, exactly: each segment's closed-form term
 *  (segGeom.segAreaTerm), about the cycle's first vertex so the products carry the face's extent
 *  rather than its offset. Also leaves `face.areaTol`, the rounding those terms can carry, so a
 *  sign is only read when it is larger than that. */
function faceSignedArea(face) {
  let area = 0,
    mag = 0;
  let cur = face.halfEdge;
  let safety = 100000;
  const ox = cur.origin.x,
    oy = cur.origin.y;
  do {
    const a = segAreaTerm(cur.seg, cur.dir, ox, oy);
    area += a;
    mag += Math.abs(a);
    cur = cur.next;
  } while (cur && cur !== face.halfEdge && safety-- > 0);
  face.areaTol = 64 * Number.EPSILON * mag;
  return area;
}

export { faceSignedArea };
