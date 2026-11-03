// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
import { segAreaTerm } from './planar/segGeom.js';
import { intersectSegments } from './intersect/index.js';
import { segStart, segEnd, mkLine, SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../segment.js';
import { canonicalScale, scaleSegBy } from './canonical.js';

export { canonicalScale, scaleSegBy };

/** Compute the outer silhouette of the union of one or more filled
 *  shapes.
 *
 *  @param {Array<{segs: Array<object>, fillRule: 'nonzero'|'evenodd'}>} shapes
 *  @returns {Array<object>}  — array of segments forming the
 *      silhouette (in order, each segment's end == next segment's
 *      start, last segment's end == first segment's start).
 */
/// `opts.intersect` — a pair intersector to use in place of intersectSegments. Every real caller
/// passes intersect/exact.js's intersectSegmentsExact: the default sends curve pairs to the bare
/// Bezier clipper, which drops crossings of every angle, and a dropped crossing usually empties
/// the whole union. Same contract: (segA, segB) -> [{ tA, tB, x, y }].
///
/// `shape.regions` — an OPTIONAL visible region for that shape: a list of AND groups, each group a list of
/// `{ segs, fillRule }` parts whose UNION is that group's region. The shape contributes to the union only where
/// it is inside every group. A clipped shape's clip is one group (a <clipPath>'s children union, SVG 1.1
/// §14.3.5) and a clip-of-clip adds another; the caller decides what a region means. Absent = unrestricted,
/// which is byte-for-byte the same as passing no regions.
export function unionPaths(shapes, opts) {
  if (!shapes || shapes.length === 0) return [];

  // ---- Step 0: normalize to a canonical extent (see canonicalScale) ----
  // The extent is the SHAPES' -- a region may reach far outside the drawing (an artboard clip), and the
  // epsilons the factor exists for are statements about the drawing's size, not the clip's.
  const _f = canonicalScale(shapes);
  if (_f !== 1) {
    // A region part scales with the shapes it restricts, and the same part object must come out as the same
    // object: the arrangement takes each distinct part exactly once, by identity.
    const scaledPart = new Map();
    const scalePart = (pt) => {
      let s = scaledPart.get(pt);
      if (!s) {
        s = { segs: (pt.segs || []).map((sg) => scaleSegBy(sg, _f)), fillRule: pt.fillRule };
        scaledPart.set(pt, s);
      }
      return s;
    };
    const scaled = shapes.map((sh) => ({
      ...sh,
      segs: (sh.segs || []).map((sg) => scaleSegBy(sg, _f)),
      regions: sh.regions ? sh.regions.map((grp) => grp.map(scalePart)) : sh.regions,
    }));
    // The caller's own intersector sees the same scaled geometry, and its crossing points come
    // back in those coordinates, so the whole pipeline stays in one frame.
    const out = unionPaths(scaled, opts);
    return out.map((sg) => scaleSegBy(sg, 1 / _f));
  }

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
          subpathIdx: 0, // not used at this stage
          origDirection: 1,
          fillRule: shape.fillRule,
        });
      }
    }
  }

  // Visible-region boundaries. A restricted shape contributes only where its region keeps it, so the region's
  // edges have to be edges of the ARRANGEMENT: without them a face straddles the region boundary and one
  // interior point decides for the whole of it. Each DISTINCT part goes in once, by identity -- one clip shared
  // by forty shapes is one set of edges -- and is tagged shapeIdx -1 so the inside test never counts it as ink
  // of its own. (shapeIdx / fillRule are carried as provenance through segmentSet and the DCEL; nothing
  // classifies on them, so -1 is inert.)
  const regionParts = new Set();
  for (const sh of shapes)
    for (const grp of sh.regions || []) for (const pt of grp) regionParts.add(pt);
  for (const pt of regionParts) {
    for (const s of pt.segs || []) {
      for (const m of subdivideYMonotone(s)) {
        tagged.push({
          seg: m,
          shapeIdx: -1,
          subpathIdx: 0,
          origDirection: 1,
          fillRule: pt.fillRule,
        });
      }
    }
  }

  if (tagged.length === 0) return [];

  // ---- Step 2: pairwise intersection + segment splitting ----
  const elementary = intersectAndSplit(tagged, opts && opts.intersect);

  // ---- Step 3: DCEL ----
  const dcel = buildDCEL(elementary);
  if (dcel.faces.length === 0) return [];

  // ---- Step 4: classify each face as inside-union or outside ----
  // For each non-outer face, pick an interior point and test against
  // every original shape.
  const insideFaces = new Set();
  /// Inside every AND group of `sh`'s visible region (each group being the union of its parts). No region = no
  /// restriction, which is the only case that existed before.
  const visibleAt = (sh, p) => {
    const rs = sh.regions;
    if (!rs || !rs.length) return true;
    for (const grp of rs) {
      let any = false;
      for (const pt of grp)
        if (pointInShape(p, pt.segs, pt.fillRule)) {
          any = true;
          break;
        }
      if (!any) return false;
    }
    return true;
  };
  const edgeBoxes = [];
  for (const h of dcel.halfEdges) {
    if (h.dir < 0) continue;
    edgeBoxes.push({ seg: h.seg, box: segBox(h.seg) });
  }
  for (const f of dcel.faces) {
    if (f.isOuter) continue;
    const p = faceInteriorPoint(f, edgeBoxes);
    if (!p) continue;
    // Inside union iff inside ANY original shape, where that shape's region keeps it.
    for (let i = 0; i < shapes.length; i++) {
      if (pointInShape(p, shapes[i].segs, shapes[i].fillRule) && visibleAt(shapes[i], p)) {
        insideFaces.add(f);
        break;
      }
    }
  }

  // ---- Step 4b: an unbounded cycle is only the plane's if nothing surrounds it ----
  // A piece of the graph that touches no other -- a disc wholly inside another, a ring's hole with a
  // dot in it -- has its own clockwise outer cycle, marked isOuter like the plane's; left unclassified,
  // the inner disc's rim would come back as a hole in the union. What that cycle faces is
  // the smallest bounded face of ANOTHER piece that contains it, and it shares that face's answer.
  // Containment is exact: a vertex of the piece is tested against the face's own boundary by ray
  // crossings, and it cannot lie on that boundary, since pieces that met would be one piece.
  const outers = dcel.faces.filter((f) => f.isOuter);
  if (outers.length > 1) {
    const parent = new Map();
    const find = (v) => {
      let r = v;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
      return r;
    };
    for (const v of dcel.vertices) parent.set(v, v);
    for (const h of dcel.halfEdges) {
      const a = find(h.origin),
        b = find(h.twin.origin);
      if (a !== b) parent.set(a, b);
    }
    const bounded = dcel.faces
      .filter((f) => !f.isOuter && f.area > 0)
      .map((f) => {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity,
          cur = f.halfEdge,
          n = 0;
        const segs = [];
        do {
          const s = cur.seg;
          const pts =
            s.type === SEG_ARC
              ? [
                  [s.cx - Math.max(s.rx, s.ry), s.cy - Math.max(s.rx, s.ry)],
                  [s.cx + Math.max(s.rx, s.ry), s.cy + Math.max(s.rx, s.ry)],
                ]
              : [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
          for (const q of pts) {
            if (q[0] < x0) x0 = q[0];
            if (q[0] > x1) x1 = q[0];
            if (q[1] < y0) y0 = q[1];
            if (q[1] > y1) y1 = q[1];
          }
          segs.push(orientSegment(cur));
          cur = cur.next;
          n++;
        } while (cur && cur !== f.halfEdge && n < 100000);
        return { f, comp: find(f.halfEdge.origin), box: [x0, y0, x1, y1], segs };
      });
    for (const O of outers) {
      const v = O.halfEdge.origin,
        k = find(v);
      // A point of the piece that is not a vertex: pieces drawn around one center have their seams on one level, and a ray through another
      // piece's vertices is the one ray the crossing rule has to break a tie on.
      const on = segPointTangent(O.halfEdge.seg, 0.381966) || [v.x, v.y];
      let best = null;
      for (const B of bounded) {
        if (B.comp === k || (best && B.f.area >= best.f.area)) continue;
        if (on[0] < B.box[0] || on[0] > B.box[2] || on[1] < B.box[1] || on[1] > B.box[3]) continue;
        if (pointInShape([on[0], on[1]], B.segs, 'evenodd')) best = B;
      }
      if (best && insideFaces.has(best.f)) insideFaces.add(O);
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

  // Trace boundary cycles: pick any unvisited boundary half-edge and walk
  // the REGION boundary. The union region can span several DCEL faces that
  // meet at shared vertices (a self-crossing outline splits into faces at
  // every crossing), so a face-local `.next` chain is not enough: when
  // `.next` lands on an interior half-edge (both sides inside the union),
  // rotate around the vertex through the interior — `twin.next` — until
  // the walk re-emerges on a boundary half-edge. This is the standard
  // region-boundary traversal; for a simple silhouette it degenerates to
  // plain `.next`.
  const visited = new Set();
  const out = [];
  const hopGuard = dcel.halfEdges.length + 10;
  for (const start of boundaryHEs) {
    if (visited.has(start)) continue;
    let cur = start;
    let safety = boundaryHEs.size + 10;
    while (cur && !visited.has(cur) && safety-- > 0) {
      visited.add(cur);
      out.push(orientSegment(cur));
      let nxt = cur.next;
      let guard = hopGuard;
      while (nxt && !boundaryHEs.has(nxt) && guard-- > 0) nxt = nxt.twin.next;
      cur = nxt;
    }
  }
  return out;
}

/** Split a union result into its individual closed contours, dropping the
 *  degenerate ones.
 *
 *  `unionPaths` returns the boundary as ONE flat segment list even when the
 *  union has several pieces — the cycles are simply concatenated, and each
 *  new cycle is implied by a discontinuity (its start does not meet the
 *  previous cycle's end). That is enough for the fill and stroke pipelines,
 *  which re-split on discontinuity anyway, but it means callers cannot see
 *  the piece structure, and it hides a wart: input shapes that ABUT or share
 *  coincident edges (abutting solids, a shape split along a seam) throw off
 *  zero-area sliver cycles — "there and back" contours of 2 segments that
 *  enclose nothing. A real train silhouette comes out as 2 meaningful blobs
 *  plus ~22 slivers. They are invisible when the outline is painted BEHIND
 *  the art, but a thick stroke turns each one into a lens/dot, so they are a
 *  latent artifact and pure waste.
 *
 *  @param {object} [opts]  passed to unionPaths (`intersect`)
 *  @returns {Array<Array<object>>} one array of segments per closed contour
 */
export function unionContours(shapes, opts) {
  const segs = unionPaths(shapes, opts);
  // Cycle breaks are detected by DISCONTINUITY, so this needs a tolerance that
  // scales with the geometry. Consecutive segments within a cycle meet at points
  // computed by different routes (a monotone split on one side, an intersection
  // solve on the other) and agree only to solver precision, while a real cycle
  // break is a macroscopic jump — orders apart, but only if the epsilon tracks
  // the shape's size. An absolute 1e-6 reads as "same point" for art authored at
  // 1e5 coordinates and as "new cycle" for art authored at 1e-3.
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const s of segs)
    for (const p of [segStart(s), segEnd(s)]) {
      if (p[0] < bx0) bx0 = p[0];
      if (p[0] > bx1) bx1 = p[0];
      if (p[1] < by0) by0 = p[1];
      if (p[1] > by1) by1 = p[1];
    }
  const diag = Math.hypot(bx1 - bx0, by1 - by0) || 1;
  const joinEps = 1e-6 * diag;

  const contours = [];
  let cur = null,
    pen = null;
  for (const s of segs) {
    const a = segStart(s),
      b = segEnd(s);
    if (!pen || Math.abs(a[0] - pen[0]) > joinEps || Math.abs(a[1] - pen[1]) > joinEps) {
      cur = [];
      contours.push(cur);
    }
    cur.push(s);
    pen = b;
  }
  // Drop anything that encloses no area.
  //
  // Two corrections here. "Fewer than 3 segments cannot bound a region" is only
  // true of STRAIGHT segments — two curves bound a lens, and a circle can arrive
  // as two arcs, so a segment-count test would discard valid contours outright. And
  // the shoelace over endpoints ignores the curve's own contribution, which is
  // exactly the chord-for-curve substitution that has caused trouble elsewhere
  // in this file: it reports ZERO for a lens whose endpoints are collinear.
  //
  // areaExact adds the closed-form Green's-theorem term per segment, and the
  // threshold scales with the shape.
  const areaEps = 1e-9 * diag * diag;
  return contours.filter((c) => {
    if (c.length < 2) return false;
    if (c.length < 3 && c.every((s) => s.type === SEG_LINE)) return false;
    return areaExact(c) > areaEps;
  });
}

/*
Area enclosed by a contour, exactly: ½∮(x dy − y dx) with each segment
 *  integrated in closed form from its power-basis coefficients. No flattening,
 *  so it is scale-free and exact for every segment kind.
 */
function areaExact(c) {
  let A = 0;
  for (const s of c) {
    const P = [s.p1, s.p2, s.p3, s.p4];
    let n;
    if (s.type === SEG_LINE) n = 1;
    else if (s.type === SEG_QUAD) n = 2;
    else if (s.type === SEG_CUBIC) n = 3;
    else {
      A += 2 * segAreaTerm(s, 1, 0, 0);
      continue;
    }
    const px = [],
      py = [];
    let ok = true;
    for (let i = 0; i <= n; i++) {
      if (!P[i]) {
        ok = false;
        break;
      }
      px.push(P[i][0]);
      py.push(P[i][1]);
    }
    if (!ok) continue;
    const bx = bez2pow(px, n),
      by = bez2pow(py, n);
    for (let i = 0; i <= n; i++)
      for (let j = 1; j <= n; j++) A += (bx[i] * j * by[j] - by[i] * j * bx[j]) / (i + j);
  }
  return Math.abs(A) / 2;
}

/** Bernstein → power basis coefficients. */
function bez2pow(b, n) {
  const C = (a, k) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (a - i)) / (i + 1);
    return r;
  };
  const out = [];
  for (let k = 0; k <= n; k++) {
    let acc = 0;
    for (let i = 0; i <= k; i++) acc += ((k - i) % 2 ? -1 : 1) * C(k, i) * b[i];
    out.push(C(n, k) * acc);
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
  if (t === 0 /* SEG_LINE */) return { type: 0, p1: s.p2, p2: s.p1, is_fill_only: s.is_fill_only };
  if (t === 1 /* SEG_QUAD */) return { type: 1, p1: s.p3, p2: s.p2, p3: s.p1 };
  if (t === 2 /* SEG_CUBIC */) return { type: 2, p1: s.p4, p2: s.p3, p3: s.p2, p4: s.p1 };
  if (t === 3 /* SEG_ARC */) {
    return {
      type: 3,
      cx: s.cx,
      cy: s.cy,
      rx: s.rx,
      ry: s.ry,
      theta_start: s.theta_end,
      theta_end: s.theta_start,
      phi: s.phi,
      large_arc_flag: s.large_arc_flag,
      sweep_flag: s.sweep_flag ? 0 : 1,
      p1: s.p4,
      p4: s.p1,
    };
  }
  return s;
}

/** A point strictly inside `face` (used only to classify the face
 *  inside/outside the original shapes via the fill rule). The vertex
 *  centroid would be wrong for non-convex faces — it can land in a notch
 *  outside the face — and silently drop concave glyph/SVG outlines from
 *  the union. The DCEL builds bounded faces with CCW boundary cycles, so
 *  the interior lies to the LEFT of each half-edge.
 *
 *  Take the longest boundary edge (numerically most stable) and evaluate
 *  its segment at t=0.5 — exactly ON the face's boundary — then step along
 *  the true curve NORMAL there. The face lies to the left of its
 *  half-edges, so the left normal steps into it.
 *
 *  @param {object} face
 *  @returns {[number, number]|null} null when the face has no usable boundary


 */
function faceInteriorPoint(face, edgeBoxes) {
  let cur = face.halfEdge;
  if (!cur) return null;
  let safety = 100000;
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity;
  let n = 0,
    best = null,
    bestLen = -1;
  do {
    const ax = cur.origin.x,
      ay = cur.origin.y;
    if (ax < minx) minx = ax;
    if (ax > maxx) maxx = ax;
    if (ay < miny) miny = ay;
    if (ay > maxy) maxy = ay;
    const bx = cur.twin.origin.x,
      by = cur.twin.origin.y;
    const len = Math.hypot(bx - ax, by - ay);
    if (len > bestLen) {
      bestLen = len;
      best = cur;
    }
    n++;
    cur = cur.next;
  } while (cur && cur !== face.halfEdge && safety-- > 0);
  if (n === 0 || !best) return null;
  const diag = Math.hypot(maxx - minx, maxy - miny) || 1;
  const eps = diag * 1e-4;

  const pt = segPointTangent(best.seg, 0.5);
  let px, py, tx, ty;
  if (pt) {
    px = pt[0];
    py = pt[1];
    tx = pt[2];
    ty = pt[3];
    if (best.dir < 0) {
      tx = -tx;
      ty = -ty;
    } // half-edge runs against the segment
  } else {
    const ax = best.origin.x,
      ay = best.origin.y;
    const bx = best.twin.origin.x,
      by = best.twin.origin.y;
    px = (ax + bx) / 2;
    py = (ay + by) / 2;
    tx = bx - ax;
    ty = by - ay;
  }
  const tl = Math.hypot(tx, ty) || 1;
  const nx = -ty / tl,
    ny = tx / tl;
  // The step is a ten-thousandth of the face, and a face can be narrower than that: a long hairline rectangle, or the wall
  // of a thin frame. Stepped past its far side, the point answers for the neighbor, and the face is dropped or kept
  // on the neighbor's verdict. So stop halfway to whatever the step would run into, at the size of the gap and not the
  // size of the face.
  const qx = px + nx * eps,
    qy = py + ny * eps;
  const x0 = Math.min(px, qx),
    x1 = Math.max(px, qx),
    y0 = Math.min(py, qy),
    y1 = Math.max(py, qy);
  let first = 1;
  let ray = null;
  for (const e of edgeBoxes) {
    if (e.box[0] > x1 || e.box[2] < x0 || e.box[1] > y1 || e.box[3] < y0) continue;
    if (!ray) ray = mkLine([px, py], [qx, qy]);
    // The ray starts ON the edge it leaves, so that hit is the start itself, at a tA that is only the rounding of the
    // coordinates over a step this short. Read as a wall, it would collapse the step onto the edge and the face would
    // take its verdict from rounding. It is known by the edge's own parameter, which does not depend on the face's size.
    for (const h of intersectSegments(ray, e.seg)) {
      if (e.seg === best.seg && Math.abs(h.tB - 0.5) < 1e-6) continue;
      if (h.tA > 1e-9 && h.tA < first) first = h.tA;
    }
  }
  const step = first < 1 ? eps * first * 0.5 : eps;
  return [px + nx * step, py + ny * step];
}

/** [x0, y0, x1, y1] holding a segment: the control hull, and an arc's whole ellipse. */
function segBox(s) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const q of [s.p1, s.p2, s.p3, s.p4]) {
    if (!q) continue;
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  if (s.type === SEG_ARC) {
    const r = Math.max(s.rx, s.ry);
    if (s.cx - r < x0) x0 = s.cx - r;
    if (s.cx + r > x1) x1 = s.cx + r;
    if (s.cy - r < y0) y0 = s.cy - r;
    if (s.cy + r > y1) y1 = s.cy + r;
  }
  return [x0, y0, x1, y1];
}

/** [x, y, dx, dy] of a segment at parameter t. Null for a kind it cannot
 *  evaluate, which makes the caller fall back to the chord. */
function segPointTangent(s, t) {
  if (!s) return null;
  const u = 1 - t;
  if (s.type === SEG_LINE) {
    const a = s.p1,
      b = s.p2;
    if (!a || !b) return null;
    return [a[0] * u + b[0] * t, a[1] * u + b[1] * t, b[0] - a[0], b[1] - a[1]];
  }
  if (s.type === SEG_QUAD) {
    const a = s.p1,
      c = s.p2,
      b = s.p3;
    if (!a || !c || !b) return null;
    return [
      u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
      2 * (u * (c[0] - a[0]) + t * (b[0] - c[0])),
      2 * (u * (c[1] - a[1]) + t * (b[1] - c[1])),
    ];
  }
  if (s.type === SEG_CUBIC) {
    const a = s.p1,
      c = s.p2,
      d = s.p3,
      b = s.p4;
    if (!a || !c || !d || !b) return null;
    return [
      u * u * u * a[0] + 3 * u * u * t * c[0] + 3 * u * t * t * d[0] + t * t * t * b[0],
      u * u * u * a[1] + 3 * u * u * t * c[1] + 3 * u * t * t * d[1] + t * t * t * b[1],
      3 * (u * u * (c[0] - a[0]) + 2 * u * t * (d[0] - c[0]) + t * t * (b[0] - d[0])),
      3 * (u * u * (c[1] - a[1]) + 2 * u * t * (d[1] - c[1]) + t * t * (b[1] - d[1])),
    ];
  }
  if (s.type === SEG_ARC) {
    // theta_start / theta_end, the names mkArc gives them. This read thetaStart / thetaEnd, which no
    // segment carries: the point came back NaN, every face whose longest edge is an arc failed its
    // inside test, and a circle drawn with arcs had an empty union. The tangent is taken along the
    // sweep, so a negative sweep points it the way t runs.
    const sweep = s.theta_end - s.theta_start;
    const th = s.theta_start + sweep * t;
    const ph = s.phi || 0,
      cp = Math.cos(ph),
      sp = Math.sin(ph);
    const cx = Math.cos(th),
      sy = Math.sin(th);
    const x = s.rx * cx,
      y = s.ry * sy;
    const dxr = -s.rx * sy * sweep,
      dyr = s.ry * cx * sweep;
    return [
      s.cx + x * cp - y * sp,
      s.cy + x * sp + y * cp,
      dxr * cp - dyr * sp,
      dxr * sp + dyr * cp,
    ];
  }
  return null;
}
