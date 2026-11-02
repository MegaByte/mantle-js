// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPartition.js — the exact-partition builder (Loop-Blinn 2005):
// control points ARE triangulation vertices and hull edges ARE constraints,
// so every CDT face is either plain interior or (a piece of) a curve hull —
// the partition is exact by construction. The morph pair builder
// (lbPartitionPair via loopBlinn.js) derives its DST endpoint from this mesh by
// provenance transform, so the emitted provenance records (hulls9,
// cubicRecs9, steiner9) are part of the contract.
import { SEG_LINE, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { mantleDebugHook } from '../core/diagnostics.js';
import { constrainedTriangulate, segsCross, orient2d } from './cdt.js';
import { orient2dXY } from '../geom/predicates.js';
import {
  bezoutUnfaithful,
  bezoutCubicImplicit,
  evalBezout,
  rootsInUnit,
  cubicKLMN,
  cubicChordStrip,
  cubicSignKLMN,
  cubicLoop,
  cubicLoopCuts,
  cubicCuspCuts,
  splitCubicMulti,
  cubicHull,
  partitionCubicSplitTs,
  uvInHull,
  cubicSign,
  cubicPt,
  rquadPt,
  cubicSubCp,
  rquadSubCtrl,
  cubicTriIntervals,
  klmnWidestFrame9,
  klmnFrameRowsAt9,
  cubicInflections,
  cubicSignAtPoint,
} from '../geom/lbCubicMath.js';
import {
  _kox,
  _koy,
  _koScale,
  emSpan,
  emEps,
  emRes,
  _setKeyOrigin,
  closeOpenContours,
  rayWindingExact,
  raySegCrossExact,
  rayWindingDir,
  buildSegWindingTree,
  treeWinding,
  calibrateInterior,
  verifyInteriorSign,
  orientContoursForFill,
  segTangents,
  edgeEndMeta,
  fatArc,
} from '../geom/lbContour.js';
import { splitInteriorByCurve, conformMeshFaces, _healCand } from './lbInteriorSplit.js';
import {
  getPreferBezout,
  selfOrientRows,
  interiorEdgesFromTriPoints,
  interiorChainsFromTris,
  subdivideBoundaryTriPoints,
} from './lbFastMesh.js';

/// The half-plane a bezout crescent may not paint beyond: past its own arc, on the side the shape's
/// Ink is not on.

const parBar9 = (ax, ay, bx, by) => Math.hypot(ax, ay) * Math.hypot(bx, by) * 2 ** -52;

/// The cubic's derivative at t (unnormalized).
function cubicTangentAt9(P, t) {
  const u = 1 - t;
  return [
    3 *
      (u * u * (P[1][0] - P[0][0]) + 2 * u * t * (P[2][0] - P[1][0]) + t * t * (P[3][0] - P[2][0])),
    3 *
      (u * u * (P[1][1] - P[0][1]) + 2 * u * t * (P[2][1] - P[1][1]) + t * t * (P[3][1] - P[2][1])),
  ];
}
function bezoutKeepHalf9(P, concave, inkLeft) {
  const st = cubicChordStrip(P);
  if (!st) return null;
  const nx = st[0],
    ny = st[1],
    lo = st[2],
    hi = st[3],
    c0 = st[4];
  const bulgeUp = hi - c0 >= c0 - lo;
  // A serpentine piece bulges to both sides of its chord, so its bulge names
  // no side; the piece's own ink probe does (`inkLeft`: ink left of the piece's way, which is the chord normal's side).
  const inkUp = inkLeft != null ? inkLeft : concave ? bulgeUp : !bulgeUp;
  // Keep the ink side and the arc's own excursion; reject beyond the arc on the other side.
  return inkUp ? [-nx, -ny, -lo] : [nx, ny, hi];
}

///
/// Clipping the drawn face to that strip does not work, in either form. The face is a CDT triangle
/// that also carries INTERIOR ink, and the interior can lie on EITHER side: beyond the chord for a
/// convex boundary curve, and beyond the ARC for a concave one, whose crescent is outside the shape
/// altogether. Two-sided and one-sided clips measure identically -- 33 wrong pixels become 161, with
/// small shapes losing most of their ink -- because whichever side is cut, some piece's interior is
/// on it. The bound is real; the face is simply not the thing it bounds.
///
/// What is left of the idea: the strip belongs in the KERNEL, deciding whether the implicit has any
/// authority at this fragment, the way CPatch uses it. A Bezout vertex has aTC (three floats,
/// unused for kind 4) and cHalf spare, which is exactly enough to carry one. Until then the
/// over-paint audit below CATCHES these pieces rather than the geometry preventing them, at the
/// cost of declining the shape.
/// WHY THE PARTITION DECLINED, for diagnostics only. Every decline sends the shape to Slug, and
/// from the outside they are indistinguishable -- which makes "this shape builds at one size and
/// not at another" impossible to act on. Costs a string assignment on the failure path.
/// DROP the cubic pieces whose hull has collapsed toward a POINT, in place.
///
/// Every edge below a sub-pixel fraction of the shape's own cubic-hull diagonal (0.3%). Extent,
/// NOT area: a long thin crescent has tiny area and is still visible. `__LB_MIN_EDGE` (a test hook,
/// read only under `__MANTLE_DEBUG__`) is what `lbDegenerateCubicDropSmoke` A/Bs, 0 disabling the drop;
/// nullish, so an explicit 0 is honored.
///
/// Static only. A morph PAIR builds its dst cubics one-to-one against the SRC's, and a piece that
/// is degenerate at the src pose can grow into a real crescent at the dst — dropping it would
/// desync the pair and under-fill the dst end. Morph builds (`plainRows` for transient mid-frames,
/// `skipCurveInterior` for the pair) keep every piece; a genuinely degenerate over-paint there
/// still declines through the audit, which is the correct Slug morph.
///
/// IT IS CALLED TWICE, and the two calls answer different questions:

/// The order is forced and cannot be collapsed into one call: the audit must run before the mesh
/// is assembled, and the closure must run after the audit (it only ever splits, so it cannot turn
/// a proved face into an unproved one, but it would multiply the sampler's work). So the drop runs
/// at each point where the set of cubic faces has just changed and something downstream is about
/// to read it.
function dropCollapsedCubics9(cubics, opts) {
  if (!cubics || !cubics.length) return;
  if (opts && (opts.plainRows || opts.skipCurveInterior)) return;
  // AND every FACE OF exactly ZERO AREA, by the exact orientation predicate on its stored corners. Such a
  // face -- a clip polygon's repeated corner fanned into a triangle -- covers no pixel, but it SHARES an edge with the
  // real crescent beside it, and the packer rings only a hull edge no other face shares: the crescent would lose its
  // exterior ring along that edge, and every pixel whose center lay just outside the arc there would be reached by nothing.
  // Extent does not see them: their long edge is a real one.
  {
    let w9 = 0;
    for (const c9 of cubics) {
      const H9 = c9.hull;
      if (H9 && H9.length === 6 && orient2dXY(H9[0], H9[1], H9[2], H9[3], H9[4], H9[5]) === 0)
        continue;
      cubics[w9++] = c9;
    }
    cubics.length = w9;
  }
  let _dx0 = Infinity,
    _dy0 = Infinity,
    _dx1 = -Infinity,
    _dy1 = -Infinity;
  for (const c9 of cubics) {
    const h9 = c9.hull;
    if (!h9) continue;
    for (let k9 = 0; k9 < 6; k9 += 2) {
      if (h9[k9] < _dx0) _dx0 = h9[k9];
      if (h9[k9] > _dx1) _dx1 = h9[k9];
      if (h9[k9 + 1] < _dy0) _dy0 = h9[k9 + 1];
      if (h9[k9 + 1] > _dy1) _dy1 = h9[k9 + 1];
    }
  }
  if (!isFinite(_dx0)) return;
  const _diag9 = Math.hypot(_dx1 - _dx0, _dy1 - _dy0) || 1;
  const _mef9 = mantleDebugHook('__LB_MIN_EDGE') ?? 3e-3;
  const _minEdge9 = _mef9 * _diag9;
  const _kept9 = cubics.filter((c9) => {
    const H9 = c9.hull;
    if (!H9 || H9.length < 6) return true;
    const e019 = Math.hypot(H9[2] - H9[0], H9[3] - H9[1]);
    const e129 = Math.hypot(H9[4] - H9[2], H9[5] - H9[3]);
    const e209 = Math.hypot(H9[0] - H9[4], H9[1] - H9[5]);
    return Math.max(e019, e129, e209) >= _minEdge9;
  });
  if (_kept9.length !== cubics.length) {
    cubics.length = 0;
    for (const c9 of _kept9) cubics.push(c9);
  }
}

/// The span of a control-point list -- the local length every degeneracy guard here is taken
/// against. See geomScale in cpatchConvert for the same argument at length.
function ctlSpan9(P) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const q of P) {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  return x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
}
function _lbDecline(why) {
  if (typeof globalThis !== 'undefined') globalThis.__lbDeclineWhy = why;
  return null;
}

function splitLoopCuspCubics(contours) {
  let changed = false;
  const out = contours.map((segs) => {
    const o = [];
    for (const sg of segs) {
      if (sg.type === SEG_CUBIC) {
        const P = [sg.p1, sg.p2, sg.p3, sg.p4];
        let bad = false;
        try {
          bad = cubicLoop(P);
        } catch {
          bad = false;
        }
        if (bad) {
          let ts = [];
          try {
            ts = cubicCuspCuts(P);
          } catch {
            ts = [];
          }
          if (ts.length) {
            let pieces = null;
            try {
              pieces = splitCubicMulti(P, ts);
            } catch {
              pieces = null;
            }
            if (pieces && pieces.length > 1) {
              for (const pc of pieces)
                o.push({ ...sg, p1: pc[0], p2: pc[1], p3: pc[2], p4: pc[3] });
              changed = true;
              continue;
            }
          }
        }
      }
      o.push(sg);
    }
    return o;
  });
  return changed ? out : contours;
}

/// THE POINTS THE CHAIN ROUTE PUTS ON THE OUTLINE BETWEEN A PIECE'S own ENDS, one formula each, because a morph pair
/// has to put the same point on its destination's piece and read it back out of the chain arrays by its float32 bits.
/// A cubic piece contributes its on-curve midpoint (a -> m -> b) and a quad hull its subdivision points. Both are linear
/// in the control points, so the vertex stage's lerp of the two poses' points is the point of the lerped pose.
export function chainMid9(cp) {
  const u = 0.5,
    t = 0.5,
    a3 = u * u * u,
    b3 = 3 * u * u * t,
    c3 = 3 * u * t * t,
    d3 = t * t * t;
  return [
    a3 * cp[0][0] + b3 * cp[1][0] + c3 * cp[2][0] + d3 * cp[3][0],
    a3 * cp[0][1] + b3 * cp[1][1] + c3 * cp[2][1] + d3 * cp[3][1],
  ];
}
/// Whether the builders hand a cubic piece's a -> m -> b chain its piece's control points, so a face's chain can carry
/// the ARC. Always, unless the TEST HOOK `__LB_CUBIC_CHAIN = false` (read only under `__MANTLE_DEBUG__`,
/// mantleDebugHook) asks for the straight-chord arm.
export const lbCubicChainOn = () => mantleDebugHook('__LB_CUBIC_CHAIN') !== false;
/// A rational quadratic's point at t (de Casteljau with weight w).
export function chainQuadAt9(a, c, b, w, t) {
  const u = 1 - t,
    den = u * u + 2 * u * t * w + t * t;
  return [
    (u * u * a[0] + 2 * u * t * w * c[0] + t * t * b[0]) / den,
    (u * u * a[1] + 2 * u * t * w * c[1] + t * t * b[1]) / den,
  ];
}

/// The split plan for one cubic of a partition build: the t-values the builder cuts it at (`ts`), and which of them came
/// from the turn rule (`fatTs`).

/// `allSegs` is the shape's whole boundary and `self` the segment P0 came from, which is not "other boundary" to itself.
export function cubicSplitPlan9(P0, allSegs, self, keepInflections = false) {
  let others9 = null;
  const A9 = P0[0],
    B9 = P0[3];
  let ext9 = 0;
  for (const Q9 of P0) ext9 = Math.max(ext9, Math.abs(Q9[0] - A9[0]), Math.abs(Q9[1] - A9[1]));
  const tol9 = 1e-9 * ext9,
    tol29 = tol9 * tol9;

  const shares9 = (p) =>
    (Math.abs(p[0] - A9[0]) < tol9 && Math.abs(p[1] - A9[1]) < tol9) ||
    (Math.abs(p[0] - B9[0]) < tol9 && Math.abs(p[1] - B9[1]) < tol9);
  const acc9 = [];
  for (const o9 of allSegs) {
    if (o9 === self) continue;
    // 21 points of each neighbor.

    const cub9 = !!o9.p4,
      qd9 = !cub9 && !!o9.p3;
    const oa9 = o9.p1,
      ob9 = o9.p4 || o9.p3 || o9.p2;
    if (!oa9 || !ob9) continue;
    const skipA9 = shares9(oa9),
      skipB9 = shares9(ob9);
    const cp9 = cub9 ? [o9.p1, o9.p2, o9.p3, o9.p4] : [oa9, oa9, ob9, ob9];
    const qw9 = qd9 && o9.type === SEG_RQUAD ? o9.w || 1 : 1;
    for (let k9 = 0; k9 <= 20; k9++) {
      const t9 = k9 / 20;
      if (skipA9 && t9 < 0.05) continue;
      if (skipB9 && t9 > 0.95) continue;
      const q9 = qd9 ? rquadPt(o9.p1, o9.p2, o9.p3, qw9, t9) : cubicPt(cp9, t9);
      // The joint itself is not other boundary. A closepath back to the start point decodes as a zero-length line there,
      // and every sample of it IS this curve's endpoint -- a hull vertex, which the hull test counts as inside -- so,
      // counted, the first and last cubic of every such contour would be halved toward the joint to the depth limit:
      // eight pieces down to 1/256 of the curve, ill-conditioned Bezout implicits at the seam, and a visible defect
      // there (an even-odd hole's start point, a morph's top edge). Coincidence is judged against the curve's own size, so it means the same thing
      // at any scale.
      // SQUARED, not rooted: |q-A| <= tol is |q-A|^2 <= tol^2 for non-negative tol, and this is
      // the hottest line in the whole build (21 samples x every other segment, per segment).
      const dax9 = q9[0] - A9[0],
        day9 = q9[1] - A9[1];
      if (dax9 * dax9 + day9 * day9 <= tol29) continue;
      const dbx9 = q9[0] - B9[0],
        dby9 = q9[1] - B9[1];
      if (dbx9 * dbx9 + dby9 * dby9 <= tol29) continue;
      acc9.push(q9[0], q9[1]);
    }
  }
  if (acc9.length) others9 = acc9;
  const plan9 = partitionCubicSplitTs(P0, others9, keepInflections);
  // Split until the implicit is an honest distance function.

  // Subdivision fixes it, and that is a measurement rather than a hope: of 221 unfaithful
  // cubics, 139 come good after ONE split and 75 more after two, leaving 7. So the piece is
  // cut until its own implicit agrees with its own arc, which is subdivision in service of
  // an analytic solution rather than in place of one -- nothing here approximates the curve.
  const FR9 = mantleDebugHook('__LB_BEZ_FAITH_FRAC') || 0.05;
  // The test itself is lbCubicMath's bezoutUnfaithful (shared with the correct fast build); the tunables are
  // read here, per call.
  const unfaithful9 = (cp9) =>
    bezoutUnfaithful(
      cp9,
      FR9,
      mantleDebugHook('__LB_FAITH_ARC') || 16,
      mantleDebugHook('__LB_FAITH_GRID') || 6,
    );

  const DEPTH9 = mantleDebugHook('__LB_FAITH_DEPTH') || 2;
  for (let depth9 = 0; depth9 < DEPTH9; depth9++) {
    const cutF9 = splitCubicMulti(P0, plan9.ts);
    const addF9 = [];
    let prevF9 = 0;
    for (let i9 = 0; i9 < cutF9.length; i9++) {
      const tE9 = i9 < plan9.ts.length ? plan9.ts[i9] : 1;
      // Only pieces that will BE Bezout: a klmn frame's implicit is the cubic's own and has
      // no second branch. A piece from any split is forced Bezout further down.
      const willBez9 = plan9.ts.length > 0 || getPreferBezout() || !cubicKLMN(cutF9[i9]);

      const FLOOR9 = mantleDebugHook('__LB_FAITH_MIN_T') || 0.08;
      if (willBez9 && tE9 - prevF9 > FLOOR9 && unfaithful9(cutF9[i9]))
        addF9.push((prevF9 + tE9) / 2);
      prevF9 = tE9;
    }
    if (!addF9.length) break;
    for (const t9 of addF9) plan9.ts.push(t9);
    plan9.ts.sort((a9, b9) => a9 - b9);
  }
  return plan9;
}

/// The partition's vertex identity: points sharing this key are ONE triangulation vertex. Reads the
/// live key origin, so it agrees with the builder's own `key` once _setKeyOrigin has run.
const vertexKey9 = (p) =>
  Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);

/// Is this quad/rquad NEAR-FLAT? Near-flat arcs (sag well below the chord) produce degenerate hulls
/// with no usable frame, so the builder demotes them to a LINE edge on their chord and constrains
/// only the chord. One definition, shared by the builder and the hull-crossing split, so the split
/// never halves a segment whose hull the CDT will not see.
function quadFlat9(sg) {
  if (vertexKey9(sg.p1) === vertexKey9(sg.p2) || vertexKey9(sg.p2) === vertexKey9(sg.p3))
    return true;
  const chx9 = sg.p3[0] - sg.p1[0],
    chy9 = sg.p3[1] - sg.p1[1];
  const chL9 = Math.hypot(chx9, chy9);
  if (!(chL9 > 0)) return false;
  const sag9 = Math.abs(
    (sg.p2[0] - sg.p1[0]) * (chy9 / chL9) - (sg.p2[1] - sg.p1[1]) * (chx9 / chL9),
  );
  return sag9 < 0.004 * chL9;
}

/// Halve a quad or rational quad at t = 1/2, exactly. In homogeneous form the halves' control points
/// are (P0 + w C) / (1 + w) and (w C + P2) / (1 + w), the split point is (P0 + 2 w C + P2) / (2 + 2 w),
/// and both halves carry the normalized weight sqrt((1 + w) / 2) -- which is 1 for an integral quad.
function halveQuad9(sg) {
  const w = sg.type === SEG_RQUAD ? sg.w || 1 : 1;
  const a = sg.p1,
    c = sg.p2,
    b = sg.p3,
    k = 1 + w;
  const m = [(a[0] + 2 * w * c[0] + b[0]) / (2 * k), (a[1] + 2 * w * c[1] + b[1]) / (2 * k)];
  const L = { ...sg, p1: a, p2: [(a[0] + w * c[0]) / k, (a[1] + w * c[1]) / k], p3: m };
  const R = { ...sg, p1: [m[0], m[1]], p2: [(w * c[0] + b[0]) / k, (w * c[1] + b[1]) / k], p3: b };
  if (sg.type === SEG_RQUAD) {
    L.w = Math.sqrt(k / 2);
    R.w = L.w;
  }
  return [L, R];
}

///
/// The partition constrains every quad's whole control triangle, and it is exact only while those
/// triangles do not overlap: a CDT cannot honor two constraints that properly cross, so recovery
/// inserts one and cavity insertion DELETES the other. Crossing hulls are the ordinary case at a thin
/// tip -- a leaf or a horn whose two sides bulge the same way -- and on a thin ring, where one rim's
/// chord cuts through the other rim's hull. With a constraint gone, faces straddle where it was: a
/// face carrying one curve's implicit paints across the other curve (solid ink outside the path at
/// a leaf's or a horn's tip), or a face inside the ink is handed to the wrong hull and ramps to
/// nothing (under-fill).
///
/// A Steiner point at the crossing does not cure it, which is why the crossing splitter leaves
/// hull-vs-hull pairs alone: the hulls still overlap, and a face in the overlap can carry only one of
/// the two implicits (splitting every pair traded over-paint on one asset for holes on another). The
/// Loop-Blinn remedy is to subdivide the CURVES. Halving is exact, keeps the curve and its tangents,
/// and shrinks each piece's hull toward its arc by four in sagitta, so two curves that do not meet
/// stop overlapping after a few halvings. Only segments in a crossing pair are halved, and the pair
/// test is exact on the CDT's own vertex identity: hull edges that share a quantized vertex meet
/// there and do not cross, whatever a float32 ulp between two arcs' joints says.
///
/// Overlap without a crossing is the same defect one step removed. When one hull holds a vertex of the
/// other strictly inside it, no constraint is lost, but the pure hull face the CDT then builds holds a
/// piece of the other curve: crab01's shape 7 is a sliver whose inner side's control point pokes past
/// the outer side's arc, and that face carried the inner implicit across the outer arc into the air.
/// So a pair is halved when its hulls overlap at all -- an edge crossing, or a vertex of one strictly
/// inside the other -- and both are exact orientation tests on the same vertex identity.
///
/// The halvings per authored segment are capped, so a pair still overlapping after the cap (two sides
/// tangent at a shared tip) keeps the unsplit behavior. The morph pair maps each hull to its destination
/// by contour and segment index, which a split of one pose alone would desync, so the pair builds with
/// this off and splits both poses in lockstep first (splitOverlappingQuadHullsPair9).
function vertexInHull9(A9, B9) {
  const T9 = B9.E;
  for (const e9 of A9.E) {
    if (e9[2] === T9[0][2] || e9[2] === T9[1][2] || e9[2] === T9[2][2]) continue;
    const o19 = orient2d(T9[0][0], T9[1][0], e9[0]),
      o29 = orient2d(T9[1][0], T9[2][0], e9[0]),
      o39 = orient2d(T9[2][0], T9[0][0], e9[0]);
    if ((o19 > 0 && o29 > 0 && o39 > 0) || (o19 < 0 && o29 < 0 && o39 < 0)) return true;
  }
  return false;
}
/// The quads whose hulls overlap another quad's hull, on the partition's vertex identity (the live key origin).
/// `skip9(sg)` leaves a quad out of the scan altogether.
function quadHullHits9(contours, skip9) {
  const qs9 = [];
  for (const c9 of contours)
    for (const sg9 of c9) {
      if (sg9.type === SEG_LINE || sg9.type === SEG_CUBIC || !sg9.p3 || quadFlat9(sg9)) continue;
      if (skip9 && skip9(sg9)) continue;
      const a = sg9.p1,
        c = sg9.p2,
        b = sg9.p3,
        ka = vertexKey9(a),
        kc = vertexKey9(c),
        kb = vertexKey9(b);
      qs9.push({
        sg9,
        E: [
          [a, c, ka, kc],
          [c, b, kc, kb],
          [b, a, kb, ka],
        ],
        x0: Math.min(a[0], c[0], b[0]),
        x1: Math.max(a[0], c[0], b[0]),
        y0: Math.min(a[1], c[1], b[1]),
        y1: Math.max(a[1], c[1], b[1]),
      });
    }
  // Sweep on x so the pair scan touches only hulls whose boxes overlap.
  qs9.sort((p9, q9) => p9.x0 - q9.x0);
  const hit9 = new Set();
  for (let i9 = 0; i9 < qs9.length; i9++) {
    const P9 = qs9[i9];
    for (let j9 = i9 + 1; j9 < qs9.length && qs9[j9].x0 <= P9.x1; j9++) {
      const Q9 = qs9[j9];
      if (Q9.y0 > P9.y1 || Q9.y1 < P9.y0) continue;
      let overlap9 = false;
      for (const e9 of P9.E) {
        for (const f9 of Q9.E) {
          if (e9[2] === f9[2] || e9[2] === f9[3] || e9[3] === f9[2] || e9[3] === f9[3]) continue;
          if (segsCross(e9[0], e9[1], f9[0], f9[1])) {
            overlap9 = true;
            break;
          }
        }
        if (overlap9) break;
      }
      // A vertex of one hull strictly inside the other (a shared vertex is the joint, not an overlap).
      if (!overlap9) overlap9 = vertexInHull9(P9, Q9) || vertexInHull9(Q9, P9);
      if (overlap9) {
        hit9.add(P9.sg9);
        hit9.add(Q9.sg9);
      }
    }
  }
  return hit9;
}
function splitOverlappingQuadHulls9(contours) {
  const CAP9 = 4;
  const depth9 = new Map();
  let out = contours;
  for (let pass9 = 0; pass9 < CAP9; pass9++) {
    const hit9 = quadHullHits9(out);
    let any9 = false;
    const next9 = out.map((c9) => {
      const o9 = [];
      for (const sg9 of c9) {
        const d9 = depth9.get(sg9) || 0;
        if (!hit9.has(sg9) || d9 >= CAP9) {
          o9.push(sg9);
          continue;
        }
        const [L9, R9] = halveQuad9(sg9);
        depth9.set(L9, d9 + 1);
        depth9.set(R9, d9 + 1);
        o9.push(L9, R9);
        any9 = true;
      }
      return o9;
    });
    if (!any9) break;
    out = next9;
  }
  return out;
}

/// THE same SPLIT FOR A MORPH PAIR, IN LOCKSTEP ON both POSES.

/// Halving at t = 1/2 is linear in the control points for a fixed weight, and the pair requires its poses' weights to
/// agree, so the split commutes with the vertex stage's lerp: every in-between pose is exactly the split of its own
/// curves. Returns the inputs themselves when nothing overlaps, and leaves the key origin on the authored source.
///
export function splitOverlappingQuadHullsPair9(srcContours, dstContours, fillRule) {
  const CAP9 = 4;
  let S9 = srcContours,
    D9 = dstContours;
  let depth9 = S9.map((c9) => c9.map(() => 0));
  const evenodd9 = fillRule === 'evenodd';
  const invisibleOf9 = (contours) => {
    const all9 = contours.flat();
    let xa = Infinity,
      xb = -Infinity,
      ya = Infinity,
      yb = -Infinity;
    for (const sg of all9)
      for (const P of [sg.p1, sg.p2, sg.p3])
        if (P) {
          if (P[0] < xa) xa = P[0];
          if (P[0] > xb) xb = P[0];
          if (P[1] < ya) ya = P[1];
          if (P[1] > yb) yb = P[1];
        }
    const ext9 = Math.max(xb - xa, yb - ya);
    // ONE FLOAT32 ULP OF this POSE, emEps's rule (lbContour.js) against the extent already in hand:
    // the floor below which the quad's sagitta is not a length. It is judged per pose, and the two
    // poses of a morph are not the same size, so an absolute 1e-9 asked each of them a different
    // question -- and asked the same pose a different question again at a different drawing size.
    const sag9 = (ext9 > 0 ? ext9 : 1) * 2 ** -24;
    const tree9 = buildSegWindingTree(all9, raySegCrossExact);
    const ink9 = (x, y) => {
      // the builder's exact side test (inkAt below)
      const w9 = tree9 ? treeWinding(tree9, x, y) : rayWindingExact(all9, x, y);
      return evenodd9 ? (w9 & 1) === 1 : w9 !== 0;
    };
    // The builder's invisible-boundary probe (the quad branch of buildLoopBlinnPartition), on this pose.
    return (sg) => {
      const w = sg.type === SEG_RQUAD ? sg.w || 1 : 1,
        dm = 2 + 2 * w;
      const qx = (sg.p1[0] + 2 * w * sg.p2[0] + sg.p3[0]) / dm,
        qy = (sg.p1[1] + 2 * w * sg.p2[1] + sg.p3[1]) / dm;
      const nx = sg.p2[0] - qx,
        ny = sg.p2[1] - qy,
        nl = Math.hypot(nx, ny);
      if (nl < sag9) return false;
      const off = Math.min(0.25 * nl, 0.02 * ext9);
      return (
        ink9(qx + (nx / nl) * off, qy + (ny / nl) * off) &&
        ink9(qx - (nx / nl) * off, qy - (ny / nl) * off)
      );
    };
  };
  for (let pass9 = 0; pass9 < CAP9; pass9++) {
    _setKeyOrigin(srcContours);
    const hitS9 = quadHullHits9(S9, invisibleOf9(S9));
    _setKeyOrigin(dstContours);
    const hitD9 = quadHullHits9(D9, invisibleOf9(D9));
    if (!hitS9.size && !hitD9.size) break;
    let any9 = false;
    const nS9 = [],
      nD9 = [],
      nDepth9 = [];
    for (let ci9 = 0; ci9 < S9.length; ci9++) {
      const oS9 = [],
        oD9 = [],
        oN9 = [];
      for (let si9 = 0; si9 < S9[ci9].length; si9++) {
        const sg9 = S9[ci9][si9],
          dg9 = D9[ci9][si9],
          d9 = depth9[ci9][si9];
        if (d9 >= CAP9 || !(hitS9.has(sg9) || hitD9.has(dg9))) {
          oS9.push(sg9);
          oD9.push(dg9);
          oN9.push(d9);
          continue;
        }
        const [sL9, sR9] = halveQuad9(sg9),
          [dL9, dR9] = halveQuad9(dg9);
        oS9.push(sL9, sR9);
        oD9.push(dL9, dR9);
        oN9.push(d9 + 1, d9 + 1);
        any9 = true;
      }
      nS9.push(oS9);
      nD9.push(oD9);
      nDepth9.push(oN9);
    }
    if (!any9) break;
    S9 = nS9;
    D9 = nD9;
    depth9 = nDepth9;
  }
  _setKeyOrigin(srcContours);
  return [S9, D9];
}

const XSPLIT_MIN_CONSTRAINTS = 64;
function crossGrid9(constraints, pts, x0, y0, x1, y1) {
  const n9 = constraints.length;
  // Below the cutoff the plain scan wins: C^2/2 pair tests are cheaper than binning C constraints
  // and sorting a candidate list per constraint.
  //
  const min9 =
    mantleDebugHook('__LB_XSPLIT_MIN') != null
      ? +mantleDebugHook('__LB_XSPLIT_MIN')
      : XSPLIT_MIN_CONSTRAINTS;
  if (n9 < min9) return null;
  const g9 = Math.max(1, Math.min(256, Math.round(Math.sqrt(n9 / 2))));
  const cw9 = (x1 - x0 || 1) / g9,
    ch9 = (y1 - y0 || 1) / g9;
  // Clamped, so a control point outside the on-curve bbox (a cubic's p4 is not in it) still bins.
  // Clamping is monotone, so overlapping AABBs keep sharing a cell.
  const cix9 = (v) => {
    const k = Math.floor((v - x0) / cw9);
    return k < 0 ? 0 : k >= g9 ? g9 - 1 : k;
  };
  const ciy9 = (v) => {
    const k = Math.floor((v - y0) / ch9);
    return k < 0 ? 0 : k >= g9 ? g9 - 1 : k;
  };
  const cells9 = new Array(g9 * g9);
  const big9 = []; // AABBs spanning too many cells to bin one by one
  const bin9 = (idx9) => {
    const A9 = pts[constraints[idx9][0]],
      B9 = pts[constraints[idx9][1]];
    const i09 = cix9(A9[0] < B9[0] ? A9[0] : B9[0]),
      i19 = cix9(A9[0] < B9[0] ? B9[0] : A9[0]);
    const j09 = ciy9(A9[1] < B9[1] ? A9[1] : B9[1]),
      j19 = ciy9(A9[1] < B9[1] ? B9[1] : A9[1]);
    if ((i19 - i09 + 1) * (j19 - j09 + 1) > 64) {
      big9.push(idx9);
      return;
    }
    for (let j9 = j09; j9 <= j19; j9++)
      for (let i9 = i09; i9 <= i19; i9++) {
        const c9 = j9 * g9 + i9;
        (cells9[c9] || (cells9[c9] = [])).push(idx9);
      }
  };
  for (let i9 = 0; i9 < n9; i9++) bin9(i9);
  let stamp9 = new Int32Array(n9 + 1024).fill(-1); // per-query dedupe, by generation
  let qid9 = 0;
  return {
    add: (idx9) => {
      if (idx9 >= stamp9.length) {
        const s9 = new Int32Array(idx9 * 2 + 1024).fill(-1);
        s9.set(stamp9);
        stamp9 = s9;
      }
      bin9(idx9);
    },
    query: (self9, bx09, by09, bx19, by19, out9) => {
      out9.length = 0;
      const q9 = qid9++;
      const i09 = cix9(bx09),
        i19 = cix9(bx19),
        j09 = ciy9(by09),
        j19 = ciy9(by19);
      for (let j9 = j09; j9 <= j19; j9++)
        for (let i9 = i09; i9 <= i19; i9++) {
          const list9 = cells9[j9 * g9 + i9];
          if (!list9) continue;
          for (const idx9 of list9)
            if (idx9 > self9 && stamp9[idx9] !== q9) {
              stamp9[idx9] = q9;
              out9.push(idx9);
            }
        }
      for (const idx9 of big9)
        if (idx9 > self9 && stamp9[idx9] !== q9) {
          stamp9[idx9] = q9;
          out9.push(idx9);
        }
      out9.sort((p9, r9) => p9 - r9); // ascending, so the FIRST crossing is the scan's
      return out9;
    },
  };
}

export function buildLoopBlinnPartition(contours, opts) {
  contours = closeOpenContours(contours); // SVG's fill region (lbContour.js closeOpenContours)
  const authoredContours9 = contours;
  contours = splitLoopCuspCubics(contours);
  // A morph pair hands in the split plan for every cubic, keyed by contour and segment index. Those indices name the
  // contours the pair passed; a cusp split here renumbers the segments, and a plan applied to the wrong segment would
  // cut the right curve at the wrong parameters -- so the plans are taken only when nothing was renumbered.
  const plans9In =
    opts && opts.cubicPlans9 && contours === authoredContours9 ? opts.cubicPlans9 : null;
  _healCand.length = 0;
  // `keyContours`: a morph pair hands in contours it has already split (splitOverlappingQuadHullsPair9) and keys
  // vertices on the authored ones, the same origin this build takes before its own split below.
  _setKeyOrigin(opts && opts.keyContours ? splitLoopCuspCubics(opts.keyContours) : contours);

  if (!(opts && (opts.plainRows || opts.skipCurveInterior)))
    contours = splitOverlappingQuadHulls9(contours);
  let allSegs = contours.flat();
  if (!allSegs.length) return _lbDecline('no-segments');
  const evenodd = !!(opts && opts.fillRule === 'evenodd');
  // exact fill test over the REAL curves (same construction as the legacy path)
  let _xa = Infinity,
    _xb = -Infinity,
    _ya = Infinity,
    _yb = -Infinity;
  for (const sg of allSegs)
    for (const P of [sg.p1, sg.p2, sg.p3])
      if (P) {
        if (P[0] < _xa) _xa = P[0];
        if (P[0] > _xb) _xb = P[0];
        if (P[1] < _ya) _ya = P[1];
        if (P[1] > _yb) _yb = P[1];
      }

  const windSegs9 = allSegs;
  const _wTree = buildSegWindingTree(windSegs9, raySegCrossExact);
  const _windAt = _wTree
    ? (x, y) => treeWinding(_wTree, x, y)
    : (x, y) => rayWindingExact(windSegs9, x, y);
  const inkAt = evenodd ? (x, y) => (_windAt(x, y) & 1) === 1 : (x, y) => _windAt(x, y) !== 0;

  // Same-wound evenodd holes travel BACKWARDS for the chain invariant (fill on the
  // left). Parity makes the reversal free: it flips crossing signs, not counts, so
  // inkAt — and the fill region it defines — is unchanged. Nonzero never needs it.
  // NOT on the morph pair path: it pairs segment i of source with segment i of
  // destination and maps correspondence from the UN-reoriented srcContours, so a
  // reversal here desynchronizes the two and the holed morph declines LB outright.
  if (evenodd && !(opts && opts.noReorient)) {
    contours = orientContoursForFill(contours, (pp) => inkAt(pp[0], pp[1]));
    // AND THE SEGMENT LIST FOLLOWS THE REORIENTATION, because two consumers ask "is this
    // segment MY own" by IDENTITY — cubicSplitPlan9's `self`, and the over-paint proof's
    // `samp9[i9 + 2] === c9.seg9` — and a reversed contour is rebuilt out of NEW objects, so a
    // list flattened above holds none of them. Both answered no for every segment of a reversed
    // hole, which makes the curve other boundary to ITSELF: the containment rule finds its own
    // arc inside its own hull and halves it to the depth limit (97 cuts on one arc of an 8-em
    // rounded square), and every crescent lands below the area the triangulation can carry. The
    // crescents vanish, and with them the exterior rings that are the only geometry a curved
    // outline has outside itself — pixels just beyond the hole's edge are then reached by no
    // primitive at all, and their partial coverage is dropped rather than antialiased. An
    // unreversed contour keeps its objects, so a shape that never needed reorienting is
    // untouched.
    allSegs = contours.flat();
  }

  const pts = [];
  const idxOf = new Map();
  const key = (p) =>
    Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);
  const add = (p) => {
    const k = key(p);
    let i = idxOf.get(k);
    if (i === undefined) {
      i = pts.length;
      idxOf.set(k, i);
      pts.push([p[0], p[1]]);
    }
    return i;
  };
  const constraints = [];
  // STRAIGHT contour edges among the constraints, by vertex pair. The crossing splitter below needs
  // to tell a contour LINE from a curve's hull edge on quad/rquad shapes.
  const lineCons9 = new Set();
  const lck9 = (i9, j9) => (i9 < j9 ? i9 * 2097152 + j9 : j9 * 2097152 + i9);
  const hulls = []; // { a, c, b, sign } per curved seg (w=1 integral quads)
  const constraintsOnly9 = new Set(); // hull idx → INVISIBLE boundary (both sides ink): solid fill, no AA payload
  const steiner9 = []; // crossing-splitter insertions + their parent coords (morph pair correspondence)
  const centroids9 = []; // the chain refinement's split points + their faces' corners (morph pair correspondence)
  const edges = []; // straight-edge kind-0/10 payloads (same shape the pack expects)
  const stripArcs = []; // CDT fat-ring arcs (pack plans kind-12 bands from these)
  const fallback9 = []; // loop/cusp segs → the caller's per-shape Slug fallback
  let hasCurve9 = false; // any quad/rquad/cubic seg → keeps the crossing-split cubic-only (arcRing safety)
  let blendTier9 = false; // audit-marginal (fur): pieces keep BLEND compositing
  let declineAudit9 = false; // the over-paint audit's verdict, taken after the carve (see the proof)
  const cubicRecs = []; // per fan-tri cubic hull records: { vis, P(2x3 or 4), rows(K/L/M)|F, sign }
  const cubics = []; // mesh.cubics output (kind 2/4)

  // WHICH SIDE OF A CURVE IS INK, read hard against the curve and along it. A probe standing off by a fraction of the shape is
  // answered by whatever lies within that fraction, so a neighbor drawn close to the arc's midpoint, on the air side, read as
  // ink there: the arc called itself invisible (ink on both sides, a same-wound contour nested inside another) and its hull
  // painted solid over the air between the two. And one place along the arc is fooled by another subpath's vertex touching
  // it there. So when the wide probes say both sides, these stand one part in 2^24 of the shape off the arc, a hair the
  // winding's exact side tests still resolve, at three places. Ink on both sides at two of them is the invisible boundary;
  // otherwise the first place with ink on one side only gives the answer. `at(t)` gives the curve's point and its unit
  // normal, left of the direction of travel. Returns [ink left, ink right].
  const _sideOff9 = Math.max(_xb - _xa, _yb - _ya) * 5.9604644775390625e-8;
  const _hairOff9 = Math.max(_xb - _xa, _yb - _ya) / 4096;
  const curveSides9 = (at) => {
    let both9 = 0,
      one9 = null;
    for (const t9 of [0.5, 0.25, 0.75]) {
      const q9 = at(t9);
      if (!q9) continue;
      const dx9 = q9[2] * _sideOff9,
        dy9 = q9[3] * _sideOff9;
      const l9 = inkAt(q9[0] + dx9, q9[1] + dy9),
        r9 = inkAt(q9[0] - dx9, q9[1] - dy9);
      if (l9 && r9) both9++;
      else if (l9 !== r9) {
        // Air there, but ink again a hair further on: a sliver between two curves all but on each other (coordinates rounded apart).
        // Under a pixel until the shape is drawn past 4096 px, and two ramps cannot add up to the ink a pixel has around it, so
        // calling it two boundaries draws a seam at every ordinary size where the sliver itself would not show.
        const hx9 = q9[2] * _hairOff9,
          hy9 = q9[3] * _hairOff9;
        if (l9 ? inkAt(q9[0] - hx9, q9[1] - hy9) : inkAt(q9[0] + hx9, q9[1] + hy9)) both9++;
        else if (!one9) one9 = [l9, r9];
      }
    }
    return both9 >= 2 ? [true, true] : one9 || [true, true];
  };
  // Air hard against both sides at all three places: the curve's winding is canceled, by its own reverse or, under even-odd, by
  // its own copy. A one-sided crescent would paint the sliver between the arc and its chord.
  const curveNoInk9 = (at) => {
    for (const t9 of [0.5, 0.25, 0.75]) {
      const q9 = at(t9);
      if (!q9) return false;
      const dx9 = q9[2] * _sideOff9,
        dy9 = q9[3] * _sideOff9;
      if (inkAt(q9[0] + dx9, q9[1] + dy9) || inkAt(q9[0] - dx9, q9[1] - dy9)) return false;
    }
    return true;
  };

  let contourIdx9 = -1;
  for (const segs of contours) {
    contourIdx9++;
    if (!segs.length) continue;
    let interiorSign = calibrateInterior(segs, (pp) => inkAt(pp[0], pp[1]));
    // VERIFY the calibration with a direct travel-frame probe. A wrong sign here puts
    // every kind-10 strip on the INK side of straight edges — a glyph crossbar loses its
    // entire outside partial row while the inside double-blends. Any seg type is probed
    // (secant tangents), so LINE-LESS contours — glyph bowls like the '8' — are verified
    // too, and their kind-12 bands cannot inherit inverted normals/corner types.
    interiorSign = verifyInteriorSign(segs, (pp) => inkAt(pp[0], pp[1]), interiorSign);
    const outwardSign = -interiorSign;
    const tg = segs.map(segTangents);
    for (let si = 0; si < segs.length; si++) {
      const s9 = segs[si];
      if (s9.type === SEG_LINE) {
        const la9 = add(s9.p1),
          lb9 = add(s9.p2);
        // zero-length closing lines (importers emit them) collapse to a SELF-LOOP
        // constraint that corrupts the CDT (the leaf: interior vanished entirely)
        if (la9 === lb9) continue;
        constraints.push([la9, lb9]);
        lineCons9.add(lck9(la9, lb9));
        const ex = s9.p2[0] - s9.p1[0],
          ey = s9.p2[1] - s9.p1[1],
          L = Math.hypot(ex, ey);
        if (L > 0)
          edges.push({
            p1: s9.p1,
            p2: s9.p2,
            nx: (-ey / L) * outwardSign,
            ny: (ex / L) * outwardSign,
            out: outwardSign,
            ci9: contourIdx9,
            si9: si,
            e1: edgeEndMeta(segs, tg, si, 0, interiorSign),
            e2: edgeEndMeta(segs, tg, si, 1, interiorSign),
          });
        continue;
      }
      if (s9.type === SEG_CUBIC) {
        hasCurve9 = true;
        const P0 = [s9.p1, s9.p2, s9.p3, s9.p4];
        // loop/cusp cubics: same treatment as the legacy path — the seg joins
        // the per-shape Slug fallback list and its chord becomes a constraint
        // so the interior triangulation stays closed. The rest of the shape
        // stays on this builder.
        if (cubicLoop(P0)) {
          fallback9.push(s9);
          constraints.push([add(s9.p1), add(s9.p4)]);
          continue;
        }
        // near-line cubic → line edge (same gate as the legacy path)
        {
          const chx9 = s9.p4[0] - s9.p1[0],
            chy9 = s9.p4[1] - s9.p1[1];
          const ch29 = chx9 * chx9 + chy9 * chy9;
          if (ch29 > 0) {
            const d19 = Math.abs((s9.p2[0] - s9.p1[0]) * chy9 - (s9.p2[1] - s9.p1[1]) * chx9);
            const d29 = Math.abs((s9.p3[0] - s9.p1[0]) * chy9 - (s9.p3[1] - s9.p1[1]) * chx9);
            if (Math.max(d19, d29) < 2e-3 * ch29) {
              constraints.push([add(s9.p1), add(s9.p4)]);
              const L9 = Math.sqrt(ch29);
              edges.push({
                p1: s9.p1,
                p2: s9.p4,
                nx: (-chy9 / L9) * outwardSign,
                ny: (chx9 / L9) * outwardSign,
                out: outwardSign,
                ci9: contourIdx9,
                si9: si,
                flat9: 'cubic',
                e1: edgeEndMeta(segs, tg, si, 0, interiorSign),
                e2: edgeEndMeta(segs, tg, si, 1, interiorSign),
              });
              continue;
            }
          }
        }
        // The split plan: turn, containment and faithfulness cuts (cubicSplitPlan9), or the plan a morph pair merged
        // for both of its poses.
        const plan9 =
          (plans9In && plans9In.get(contourIdx9 + '|' + si)) || cubicSplitPlan9(P0, allSegs, s9);

        const pieces9 = [];
        {
          const cut9 = splitCubicMulti(P0, plan9.ts);
          let prev9 = 0;
          for (let pi9 = 0; pi9 < cut9.length; pi9++) {
            const tEnd9 = pi9 < plan9.ts.length ? plan9.ts[pi9] : 1;
            const wasFat9 = plan9.fatTs.has(prev9) || plan9.fatTs.has(tEnd9);
            pieces9.push([cut9[pi9], wasFat9]);
            prev9 = tEnd9;
          }
        }
        let pieceIdx9 = -1;
        for (const [P, wasSplit9] of pieces9) {
          pieceIdx9++;
          let invisCubic9 = false,
            inkLeft9 = null,
            airCubic9 = false;
          // exact side-bit: is the ctrl side of this single-bulge piece ink?
          // Probe along the curve NORMAL at t=½, at a distance relative to the
          // CHORD (not the ctrl sag): near-flat sub-pieces have ctrl-mid ≈ ON
          // the curve, so a sag-scaled probe landed within fp of the boundary
          // and tied randomly (the subdivided leaf shattered into ±wedges).
          //
          const cm9 = cubicPt(P, 0.5);
          const ctrlMid9 = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
          let ccx9 = false;
          {
            const tx9 = P[1][0] - P[0][0] + 2 * (P[2][0] - P[1][0]) + (P[3][0] - P[2][0]);
            const ty9 = P[1][1] - P[0][1] + 2 * (P[2][1] - P[1][1]) + (P[3][1] - P[2][1]);
            let nx9 = -ty9,
              ny9 = tx9;
            const nl9 = Math.hypot(nx9, ny9);
            const chord9 = Math.hypot(P[3][0] - P[0][0], P[3][1] - P[0][1]);

            const pe9 = emEps();
            if (nl9 > pe9 && chord9 > pe9) {
              const right9 = nx9 * (ctrlMid9[0] - cm9[0]) + ny9 * (ctrlMid9[1] - cm9[1]) < 0;
              if (right9) {
                nx9 = -nx9;
                ny9 = -ny9;
              }
              const off9 = 0.01 * chord9;
              ccx9 = inkAt(cm9[0] + (nx9 / nl9) * off9, cm9[1] + (ny9 / nl9) * off9);
              const sideAt9 = (t9) => {
                const g9 = cubicTangentAt9(P, t9),
                  gl9 = Math.hypot(g9[0], g9[1]),
                  q9 = cubicPt(P, t9);
                return gl9 > 0 ? [q9[0], q9[1], -g9[1] / gl9, g9[0] / gl9] : null;
              };
              let sides9 = [false, false];
              if (ccx9 && inkAt(cm9[0] - (nx9 / nl9) * off9, cm9[1] - (ny9 / nl9) * off9)) {
                sides9 = curveSides9(sideAt9);
                ccx9 = right9 ? sides9[1] : sides9[0];
              } else if (
                !ccx9 &&
                !inkAt(cm9[0] - (nx9 / nl9) * off9, cm9[1] - (ny9 / nl9) * off9)
              ) {
                airCubic9 = curveNoInk9(sideAt9);
              }
              inkLeft9 = ccx9 !== right9; // the probe went LEFT of the tangent unless the ctrl side is right
              // INVISIBLE BOUNDARY (both sides ink — a same-wound nested contour
              // under nonzero): same rule as the quad branch; the pieces fill
              // SOLID, no crescent frame (one-sided coverage is wrong there).
              if (sides9[0] && sides9[1]) invisCubic9 = true;
            }
          }
          // Air on both sides: the winding cancels along this arc, so it bounds nothing and paints nothing.
          if (airCubic9) {
            constraints.push([add(P[0]), add(P[3])]);
            continue;
          }
          const hull9 = cubicHull(P);
          const hi9 = hull9.map((h9) => add(P[h9]));
          for (let k9 = 0; k9 < hi9.length; k9++)
            constraints.push([hi9[k9], hi9[(k9 + 1) % hi9.length]]);
          // the fan DIAGONAL is a klmn patch boundary (k,l,m are affine per fan
          // tri, not across the quad) — constrain it or the CDT picks the other
          // diagonal and faces straddle patches (the leaf shear).
          if (hi9.length === 4) constraints.push([hi9[0], hi9[2]]);

          let klmn9 = wasSplit9 || getPreferBezout() ? null : cubicKLMN(P);
          if (klmn9) {
            const h0 = hull9[0],
              h1 = hull9[1],
              h2 = hull9[2];
            const e1x = P[h1][0] - P[h0][0],
              e1y = P[h1][1] - P[h0][1];
            const e2x = P[h2][0] - P[h0][0],
              e2y = P[h2][1] - P[h0][1];
            const det9 = e1x * e2y - e1y * e2x;
            // An AREA, so relative to the triangle's own edges: an absolute test calls the same
            // triangle degenerate at one size and healthy at another.
            if (!(Math.abs(det9) > 1e-12 * (Math.hypot(e1x, e1y) * Math.hypot(e2x, e2y))))
              klmn9 = null;
            else {
              const g9 = (arr) => {
                const d19 = arr[h1] - arr[h0],
                  d29 = arr[h2] - arr[h0];
                return [(d19 * e2y - d29 * e1y) / det9, (d29 * e1x - d19 * e2x) / det9];
              };
              const kb9 = (arr) => (arr[h0] + arr[h1] + arr[h2]) / 3;
              const gk = g9(klmn9.k),
                gl = g9(klmn9.l),
                gm = g9(klmn9.m);
              const kc = kb9(klmn9.k),
                lc = kb9(klmn9.l),
                mc = kb9(klmn9.m);
              const gfx = 3 * kc * kc * gk[0] - (gl[0] * mc + lc * gm[0]);
              const gfy = 3 * kc * kc * gk[1] - (gl[1] * mc + lc * gm[1]);
              const diag9 = Math.hypot(e1x, e1y) + Math.hypot(e2x, e2y);
              if (Math.hypot(gfx, gfy) * diag9 < 1e-3) klmn9 = null;
            }
          }
          // A serpentine piece: a morph pair whose inflection moves keeps the piece that holds it whole,
          // because the two poses would cut it at different parameters. Its hull straddles the arc, so the sign cannot be
          // read at a reference point on "the control side" or "the chord side" -- both are on both sides. It is read
          // where the ink probe itself stood: a hair off the arc's midpoint, on the side the probe found ink.
          const serp9 = cubicInflections(P).some((t) => t > 1e-6 && t < 1 - 1e-6);
          const inkRef9 =
            serp9 && inkLeft9 != null
              ? (() => {
                  const g = cubicTangentAt9(P, 0.5),
                    gl = Math.hypot(g[0], g[1]),
                    ch = Math.hypot(P[3][0] - P[0][0], P[3][1] - P[0][1]);
                  if (!(gl > 0 && ch > 0)) return null;
                  const s = ((inkLeft9 ? 1 : -1) * 0.01 * ch) / gl;
                  return [cm9[0] - g[1] * s, cm9[1] + g[0] * s];
                })()
              : null;
          const sign9 = klmn9
            ? inkRef9
              ? cubicSignAtPoint(P, klmn9, null, inkRef9) || cubicSignKLMN(P, klmn9, ccx9)
              : cubicSignKLMN(P, klmn9, ccx9)
            : 0;
          const F9 = klmn9 ? null : bezoutCubicImplicit(P);

          if (!klmn9 && !F9) {
            constraints.push([add(s9.p1), add(s9.p4)]);
            continue;
          }
          const sgn9 = klmn9
            ? sign9
            : inkRef9
              ? cubicSignAtPoint(P, null, F9, inkRef9) || cubicSign(P, F9, ccx9)
              : cubicSign(P, F9, ccx9);
          const htris9 =
            hull9.length === 3
              ? [[0, 1, 2]]
              : [
                  [0, 1, 2],
                  [0, 2, 3],
                ];
          const pid9 = cubicRecs.length; // piece id: fan tris of one piece share a frame
          let frame9 = null;
          for (const tr9 of htris9) {
            cubicRecs.push({
              // The segment this piece was cut from. The face proof needs IDENTITY, not proximity:
              // on a hairline the far side of the shape runs a few ten-thousandths of a chord from
              // this arc, closer than any distance tolerance that still lets a neighbor meet it at
              // a shared endpoint -- so "is this point my own curve" has to be answered by which
              // segment it came from.
              seg9: s9,
              pid: pid9,
              ci9: contourIdx9,
              si9: si,
              pi9: pieceIdx9,
              invis9: invisCubic9,
              vis: [hi9[tr9[0]], hi9[tr9[1]], hi9[tr9[2]]],
              pts: [P[hull9[tr9[0]]], P[hull9[tr9[1]]], P[hull9[tr9[2]]]],
              rows: klmn9
                ? [
                    [klmn9.k[hull9[tr9[0]]], klmn9.l[hull9[tr9[0]]], klmn9.m[hull9[tr9[0]]]],
                    [klmn9.k[hull9[tr9[1]]], klmn9.l[hull9[tr9[1]]], klmn9.m[hull9[tr9[1]]]],
                    [klmn9.k[hull9[tr9[2]]], klmn9.l[hull9[tr9[2]]], klmn9.m[hull9[tr9[2]]]],
                  ]
                : null,
              F: F9,
              sign: sgn9,
              cp: P,
              // Only a Bezout piece needs it: a klmn frame's implicit is the cubic's own and has no
              // second branch to fence. Computed once per piece, not per face.
              keep9: F9 ? bezoutKeepHalf9(P, ccx9, serp9 ? inkLeft9 : null) : null,
              // The piece's rows are read over its widest control triangle, not this fan triangle (klmnWidestFrame9).
              frame9: klmn9 ? frame9 || (frame9 = klmnWidestFrame9(P, klmn9, parBar9)) : null,
              // Which side of the piece's direction is ink, from the same probe (null: too small to ask). A morph
              // pair reads it to pick the chain; a side is a fact of the outline that holds at every t of a pair.
              inkLeft9,
              // Kind-12 end meta: real at contour-segment ends; type-0 stub at split joints.
              e1:
                pieceIdx9 === 0
                  ? edgeEndMeta(segs, tg, si, 0, interiorSign)
                  : { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 },
              e2:
                pieceIdx9 === pieces9.length - 1
                  ? edgeEndMeta(segs, tg, si, 1, interiorSign)
                  : { nN: [0, 0], k: 0, type: 0, curve: true, tsign: 1, qn: true, turn: 0 },
              a: P[0],
              b: P[3],
              // A DEGENERATE TANGENT, AGAINST THE PIECE'S own SIZE. These end normals ride the
              // kind-12 band on the wire, and an absolute 1e-12 picks a different fallback control
              // point for the same curve at a different drawing size -- the packed normal would then
              // change on a mesh that is otherwise bit-identical.
              na: (() => {
                const ex9 = ctlSpan9(P);
                const u = (x, y) => {
                  const L = Math.hypot(x, y);
                  return L > 1e-12 * ex9 ? [x / L, y / L] : null;
                };
                return (
                  u(P[1][0] - P[0][0], P[1][1] - P[0][1]) ||
                  u(P[2][0] - P[0][0], P[2][1] - P[0][1]) ||
                  u(P[3][0] - P[0][0], P[3][1] - P[0][1])
                );
              })(),
              nb: (() => {
                const ex9 = ctlSpan9(P);
                const u = (x, y) => {
                  const L = Math.hypot(x, y);
                  return L > 1e-12 * ex9 ? [x / L, y / L] : null;
                };
                const tB =
                  u(P[3][0] - P[2][0], P[3][1] - P[2][1]) ||
                  u(P[3][0] - P[1][0], P[3][1] - P[1][1]) ||
                  u(P[3][0] - P[0][0], P[3][1] - P[0][1]);
                return tB ? [-tB[0], -tB[1]] : null;
              })(),
            });
          }
        }
        continue;
      }
      // quad/rquad: ctrl is a vertex; hull edges are constraints (the Loop-Blinn paper's key move)
      hasCurve9 = true;
      const w9q = s9.type === SEG_RQUAD ? s9.w || 1 : 1;
      const a = add(s9.p1),
        c = add(s9.p2),
        b = add(s9.p3);
      // near-flat arcs (sag ≪ chord) produce degenerate hulls: no usable frame,
      // no strip geometry — binary boundaries with no AA anywhere ('a' bowl-top).
      // Demote to a LINE edge: sub-LSB positional error, full kind-10/cap AA.
      // `a === c` is key equality, so quadFlat9 (which asks the key directly) is the same test.
      const flat9 = quadFlat9(s9);
      if (flat9) {
        constraints.push([a, b]);
        lineCons9.add(lck9(a, b));
        const ex9 = s9.p3[0] - s9.p1[0],
          ey9 = s9.p3[1] - s9.p1[1],
          L9 = Math.hypot(ex9, ey9);
        if (L9 > 0)
          edges.push({
            p1: s9.p1,
            p2: s9.p3,
            nx: (-ey9 / L9) * outwardSign,
            ny: (ex9 / L9) * outwardSign,
            out: outwardSign,
            ci9: contourIdx9,
            si9: si,
            flat9: 'arc',
            e1: edgeEndMeta(segs, tg, si, 0, interiorSign),
            e2: edgeEndMeta(segs, tg, si, 1, interiorSign),
          });
        continue;
      }
      // the FULL hull boundary is constrained — the hull triangle is then bounded
      // by exactly its three edges, so no outside face can cross into it (an
      // unconstrained chord let interior faces poke past the curve: '0' 4→901px).
      constraints.push([a, c], [c, b], [a, b]);
      // ONE exact side-bit for the whole segment: is the ctrl side of the curve
      // ink? Probe the curve midpoint nudged toward the ctrl point.
      const dmid9 = 2 + 2 * w9q;
      const qmx = (s9.p1[0] + 2 * w9q * s9.p2[0] + s9.p3[0]) / dmid9;
      const qmy = (s9.p1[1] + 2 * w9q * s9.p2[1] + s9.p3[1]) / dmid9;
      let nx9 = s9.p2[0] - qmx,
        ny9 = s9.p2[1] - qmy;
      const nl9 = Math.hypot(nx9, ny9);
      let sign;
      // The quad's own sagitta, in the shape's units for the same reason the cubic branch above
      // gives: below one float32 ulp of the extent the two probe points are one packed position,
      // so the invisible-boundary test has nothing to read. The pair builder's twin uses the dst
      // pose's `emD9.eps` for the same reason.
      if (nl9 < emEps()) sign = 1;
      else {
        const off9 = Math.min(0.25 * nl9, 0.02 * Math.max(_xb - _xa, _yb - _ya));
        let inkCtrl = inkAt(qmx + (nx9 / nl9) * off9, qmy + (ny9 / nl9) * off9);
        const sideAt9 = (t9) => {
          const u9 = 1 - t9,
            dn9 = u9 * u9 + 2 * u9 * t9 * w9q + t9 * t9;
          // The tangent of a conic at t is along the line joining its two de Casteljau points there.
          const ad9 = u9 + t9 * w9q,
            bd9 = u9 * w9q + t9;
          const tx9 =
            (u9 * w9q * s9.p2[0] + t9 * s9.p3[0]) / bd9 -
            (u9 * s9.p1[0] + t9 * w9q * s9.p2[0]) / ad9;
          const ty9 =
            (u9 * w9q * s9.p2[1] + t9 * s9.p3[1]) / bd9 -
            (u9 * s9.p1[1] + t9 * w9q * s9.p2[1]) / ad9;
          const tl9 = Math.hypot(tx9, ty9);
          return tl9 > 0
            ? [
                (u9 * u9 * s9.p1[0] + 2 * u9 * t9 * w9q * s9.p2[0] + t9 * t9 * s9.p3[0]) / dn9,
                (u9 * u9 * s9.p1[1] + 2 * u9 * t9 * w9q * s9.p2[1] + t9 * t9 * s9.p3[1]) / dn9,
                -ty9 / tl9,
                tx9 / tl9,
              ]
            : null;
        };
        let sides9 = [false, false];
        if (
          !inkCtrl &&
          !inkAt(qmx - (nx9 / nl9) * off9, qmy - (ny9 / nl9) * off9) &&
          curveNoInk9(sideAt9)
        ) {
          // Air on both sides: the winding cancels along this arc, so it bounds nothing and paints nothing.
          constraints.length -= 3;
          constraints.push([a, b]);
          continue;
        }
        if (inkCtrl && inkAt(qmx - (nx9 / nl9) * off9, qmy - (ny9 / nl9) * off9)) {
          sides9 = curveSides9(sideAt9);
          // The control point is left of the direction of travel when it is left of the chord.
          const ctrlLeft9 =
            (s9.p3[0] - s9.p1[0]) * (s9.p2[1] - s9.p1[1]) -
              (s9.p3[1] - s9.p1[1]) * (s9.p2[0] - s9.p1[0]) >
            0;
          inkCtrl = ctrlLeft9 ? sides9[0] : sides9[1];
        }
        // INVISIBLE BOUNDARY (both sides ink): a same-wound nested contour under
        // NONZERO contributes no edge — winding is ≠0 on both sides of its curve.
        // Any one-sided crescent here is wrong by construction (one side always
        // ramps/discards → a white lune band bit into the qring's solid disc).
        // The hull paints as SOLID interior and the seg carries no AA payload
        // (no strip; the constraint stays so the partition is still bounded).
        if (sides9[0] && sides9[1]) {
          constraintsOnly9.add(hulls.length); // pass-1 skips membership for this hull
          hulls.push({
            a: [s9.p1[0], s9.p1[1]],
            c: [s9.p2[0], s9.p2[1]],
            b: [s9.p3[0], s9.p3[1]],
            ai: a,
            ci: c,
            bi: b,
            sign: 1,
            w: w9q,
            si9: si,
            invis9: true,
            fat: fatArc(s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]),
            ci9: contourIdx9,
          });
          continue;
        }
        // standard frame: ctrl side = f_raw > 0; sliver side = f_raw < 0.
        // paint the ink side: ink on ctrl side → sign -1 (paint f_raw>0);
        // ink on sliver side → sign +1 (paint f_raw<0).
        sign = inkCtrl ? -1 : 1;
      }
      hulls.push({
        a: [s9.p1[0], s9.p1[1]],
        c: [s9.p2[0], s9.p2[1]],
        b: [s9.p3[0], s9.p3[1]],
        ai: a,
        ci: c,
        bi: b,
        sign,
        w: w9q,
        si9: si,
        fat: fatArc(s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]),
        ci9: contourIdx9,
      });
      // e1/e2: kind-12 band end metadata (neighbor normal/curvature/type per end).
      stripArcs.push({
        tri: new Float32Array([s9.p1[0], s9.p1[1], s9.p2[0], s9.p2[1], s9.p3[0], s9.p3[1]]),
        sign,
        w: w9q,
        ci9: contourIdx9,
        si9: si,
        e1: edgeEndMeta(segs, tg, si, 0, interiorSign),
        e2: edgeEndMeta(segs, tg, si, 1, interiorSign),
      });
    }
  }
  if (!pts.length) return _lbDecline('no-points');
  // PROPER-HOLED shapes (glyph counters: '0', 'o', '8' waists): an OPPOSITE-
  // wound contour nested in another = the classic nonzero hole, which the
  // legacy path is pixel-tuned for (including self-pinch waists this
  // classification drops). Bail to it. same-wound nesting (a droplet's
  // evenodd ring) and coincident-edge composites (tiled regions)
  // are exactly the classes the overlay model shredded — they stay here.
  {
    let hasDup9 = false;
    {
      const em9 = new Set();
      outer9: for (const c9 of contours)
        for (const sg9 of c9) {
          if (sg9.type !== SEG_LINE) continue;
          const k9 = key(sg9.p1) + '|' + key(sg9.p2),
            r9 = key(sg9.p2) + '|' + key(sg9.p1);
          if (em9.has(r9) || em9.has(k9)) {
            hasDup9 = true;
            break outer9;
          }
          em9.add(k9);
        }
    }
    if (!hasDup9 && contours.length > 1) {
      const info9 = contours.map((c9) => {
        let x0 = Infinity,
          x1 = -Infinity,
          y0 = Infinity,
          y1 = -Infinity,
          ar9 = 0;
        for (const sg9 of c9) {
          const P9 = sg9.p1,
            Q9 = sg9.type === SEG_LINE ? sg9.p2 : sg9.p3;
          ar9 += P9[0] * Q9[1] - Q9[0] * P9[1];
          for (const R9 of [sg9.p1, sg9.p2, sg9.p3])
            if (R9) {
              if (R9[0] < x0) x0 = R9[0];
              if (R9[0] > x1) x1 = R9[0];
              if (R9[1] < y0) y0 = R9[1];
              if (R9[1] > y1) y1 = R9[1];
            }
        }
        return { bb: [x0, y0, x1, y1], w: Math.sign(ar9) };
      });
      // ≥2 opposite-wound counters nested in ONE outer ('8', 'B', '%') → the
      // waist between counters is a MULTI-boundary pinch (a pixel crossed by
      // two independent boundaries needs composed coverage; one face carries
      // one frame) — the legacy additive stack renders those; bail. SINGLE
      // counters ('0', 'o', 'a', 'd') render BETTER here (the '0' at 0.05 vs
      // the legacy path's 4px audit residue).
      for (let i9 = 0; i9 < info9.length; i9++) {
        let counters9 = 0;
        for (let j9 = 0; j9 < info9.length; j9++) {
          if (i9 === j9) continue;
          const A9 = info9[i9].bb,
            B9 = info9[j9].bb;
          if (!(
            B9[0] >= A9[0] &&
            B9[1] >= A9[1] &&
            B9[2] <= A9[2] &&
            B9[3] <= A9[3] &&
            info9[j9].w !== 0 &&
            info9[j9].w === -info9[i9].w
          ))
            continue;
          counters9++;
          // A counter within roughly 10% of the outer boundary on every side
          // is thinner than the split machinery's reach; interior faces can
          // leak past the outer curve, so retain the fallback route.
          const ow9 = A9[2] - A9[0],
            oh9 = A9[3] - A9[1];
          const m9 = 0.1 * Math.max(ow9, oh9);
          // curve bands only: the leak class is CURVE frames drifting in a thin
          // band. Pure-line frames (picture frames, diagonal frames) are exact
          // via the kind-0/edge machinery and stay here.
          if (
            B9[0] - A9[0] < m9 &&
            B9[1] - A9[1] < m9 &&
            A9[2] - B9[2] < m9 &&
            A9[3] - B9[3] < m9
          ) {
            let curved9 = false;
            outer8: for (const c8 of contours)
              for (const s8 of c8) {
                if (s8.type !== SEG_LINE) {
                  curved9 = true;
                  break outer8;
                }
              }
            if (curved9) return _lbDecline('curved-hole-edge');
          }
        }
      }
    }
  }
  // COINCIDENT-EDGE composites (abutting cell subpaths): a straight edge whose
  // exact reverse appears in another subpath is INTERNAL — not a boundary. It
  // stays a CDT constraint, but must carry no AA payload (edge rows/bands
  // would dip every shared grout line to ~0.7 coverage).
  {
    const seen9 = new Map();
    for (let i9 = 0; i9 < edges.length; i9++) {
      const e9 = edges[i9];
      const k9 = key(e9.p1) + '|' + key(e9.p2),
        r9 = key(e9.p2) + '|' + key(e9.p1);
      if (seen9.has(r9)) {
        edges[seen9.get(r9)] = null;
        edges[i9] = null;
      } else seen9.set(k9, i9);
    }
    let w9 = 0;
    for (let i9 = 0; i9 < edges.length; i9++) if (edges[i9]) edges[w9++] = edges[i9];
    edges.length = w9;
  }
  // Crossing constraints: cubic hull perimeters include long closing chords
  // (kappa circle quadrants → a diamond through an evenodd ring's band) that
  // properly cross other hull edges — a CDT cannot honor both and drops faces
  // around the crossing (the cubicRing wedge slashes). Split every properly-
  // crossing pair at the intersection, same as the fast path. Fires for CUBIC
  // shapes (hull closing chords) and for ALL-STRAIGHT shapes (self-crossing
  // outlines — pentagram/bowtie — whose contour edges genuinely cross; these are
  // pure contour constraints so there are no quad/rquad hull edges to disturb).
  // Quad/rquad shapes stay excluded: their hull edges never properly cross and the
  // split points broke rquad-ring exactness (arcRing).
  // Split every properly-crossing pair found per sweep (a constraint that
  // splits moves to the next i — its halves get re-scanned next pass).
  // One split per pass with a restart would make this O(passes·C²) AND cap
  // TOTAL splits at the pass count (8): shapes with more crossings (dense
  // cubic closing-chords, complex self-crossing outlines) would leave crossings
  // unsplit, and the CDT would drop faces around them with no fallback.
  // A quad hull edge can cross a contour line: a concave quad whose control point pokes past a
  // straight edge of the same outline (a hook under a long top edge). Left unsplit, the
  // CDT cannot honor both, cavity insertion deletes the LINE, and the hull faces straddling where it
  // was paint the quad's implicit on the air side of it. So on quad/rquad shapes the pass runs for
  // pairs with a contour line in them; hull-vs-hull pairs stay unsplit (arcRing).
  const quadOnly9 = !(cubicRecs.length || !hasCurve9);
  const cand9 = []; // reused candidate list (see crossGrid9)
  for (let pass9 = 0; pass9 < (!quadOnly9 || lineCons9.size ? 32 : 0); pass9++) {
    let nSplit9 = 0;
    const xg9 = crossGrid9(constraints, pts, _xa, _ya, _xb, _yb);
    for (let i9 = 0; i9 < constraints.length; i9++) {
      const [a9, b9] = constraints[i9];
      const A9 = pts[a9],
        B9 = pts[b9];
      // Constraint i9's bbox, hoisted out of the inner scan: two segments whose
      // AABBs are disjoint cannot cross, so the reject below skips the intersection
      // math (2 divisions) for the vast majority of pairs on segment-heavy shapes —
      // an exact filter, so the same crossings are found in the same order.
      const ax09 = A9[0] < B9[0] ? A9[0] : B9[0],
        ax19 = A9[0] < B9[0] ? B9[0] : A9[0];
      const ay09 = A9[1] < B9[1] ? A9[1] : B9[1],
        ay19 = A9[1] < B9[1] ? B9[1] : A9[1];
      // Whether constraint i9 is a contour LINE does not depend on j9, and lineCons9 only gains
      // entries at a split, which ends this scan — so the test is hoisted out of it.
      const iLine9 = quadOnly9 ? lineCons9.has(lck9(a9, b9)) : false;
      const list9 = xg9 ? xg9.query(i9, ax09, ay09, ax19, ay19, cand9) : null;
      const nn9 = list9 ? list9.length : constraints.length;
      for (let k9 = list9 ? 0 : i9 + 1; k9 < nn9; k9++) {
        const j9 = list9 ? list9[k9] : k9;
        const [c9, d9] = constraints[j9];
        if (c9 === a9 || c9 === b9 || d9 === a9 || d9 === b9) continue;
        if (quadOnly9 && !iLine9 && !lineCons9.has(lck9(c9, d9))) continue;
        const C9 = pts[c9],
          D9 = pts[d9];
        if (
          ax19 < (C9[0] < D9[0] ? C9[0] : D9[0]) ||
          (C9[0] < D9[0] ? D9[0] : C9[0]) < ax09 ||
          ay19 < (C9[1] < D9[1] ? C9[1] : D9[1]) ||
          (C9[1] < D9[1] ? D9[1] : C9[1]) < ay09
        )
          continue;
        const r9x = B9[0] - A9[0],
          r9y = B9[1] - A9[1],
          s9x = D9[0] - C9[0],
          s9y = D9[1] - C9[1];
        const den9 = r9x * s9y - r9y * s9x;

        if (
          !(Math.abs(den9) > 1e-18 * Math.sqrt((r9x * r9x + r9y * r9y) * (s9x * s9x + s9y * s9y)))
        )
          continue;
        const t9 = ((C9[0] - A9[0]) * s9y - (C9[1] - A9[1]) * s9x) / den9;
        const u9 = ((C9[0] - A9[0]) * r9y - (C9[1] - A9[1]) * r9x) / den9;
        if (t9 <= 1e-9 || t9 >= 1 - 1e-9 || u9 <= 1e-9 || u9 >= 1 - 1e-9) continue;
        const X9 = [A9[0] + t9 * r9x, A9[1] + t9 * r9y];
        const xi9 = pts.length;
        pts.push(X9);
        // provenance for the morph pair: the DST twin of this Steiner point is
        // the intersection of the same two constraints on the dst endpoint
        // (parents recorded by coordinate; cascading splits resolve in order)
        steiner9.push({
          pt: X9,
          pa: [A9[0], A9[1]],
          pb: [B9[0], B9[1]],
          pc: [C9[0], C9[1]],
          pd: [D9[0], D9[1]],
        });
        if (lineCons9.has(lck9(a9, b9))) {
          lineCons9.add(lck9(a9, xi9));
          lineCons9.add(lck9(xi9, b9));
        }
        if (lineCons9.has(lck9(c9, d9))) {
          lineCons9.add(lck9(c9, xi9));
          lineCons9.add(lck9(xi9, d9));
        }
        constraints[i9] = [a9, xi9];
        constraints.push([xi9, b9]);
        constraints[j9] = [c9, xi9];
        constraints.push([xi9, d9]);
        // The halves are new INDICES, so they must be binned; the two that were cut only shrank,
        // and their existing bins still cover them.
        if (xg9) {
          xg9.add(constraints.length - 2);
          xg9.add(constraints.length - 1);
        }
        nSplit9++;
        break; // constraint i9 changed — its halves re-scan next pass
      }
    }
    if (!nSplit9) break;
  }
  const ekey9First = (i9, j9) => (i9 < j9 ? i9 * 2097152 + j9 : j9 * 2097152 + i9);
  let cdtRes = null;
  try {
    cdtRes = constrainedTriangulate(pts, constraints);
  } catch {
    cdtRes = null;
  }
  // THE TRIANGULATION CAN LOSE INK OFF ITS RIM. The super-triangle's triangles are dropped, and nothing later can make a triangle
  // out of none. A triangle of three real points survives only while its circumcircle misses the super-vertices, and points along a
  // gentle arc have a huge circumcircle: at the usual 20 extents a polygon about 100 to 1 lost most of its area with no decline
  // (95% of a 6000 by 60 fan). So an open edge of the triangulation with ink beyond it triangulates again with the super-triangle
  // 2^32 extents off, where the arc would need a sagitta under 2^-34 of its chord, below a float32 vertex. The predicates are exact,
  // so the distance costs no correctness; only the edges of a shape this happens to pay for the second pass.
  if (cdtRes && cdtRes.tris) {
    const once9 = new Map();
    for (const t9 of cdtRes.tris)
      for (let e9 = 0; e9 < 3; e9++) {
        const a9 = t9[e9],
          b9 = t9[(e9 + 1) % 3],
          k9 = ekey9First(a9, b9);
        if (once9.has(k9)) once9.delete(k9);
        else once9.set(k9, [a9, b9]);
      }
    const off9 = Math.max(_xb - _xa, _yb - _ya) * 5.9604644775390625e-8;
    let lost9 = false;
    for (const [a9, b9] of once9.values()) {
      const A9 = pts[a9],
        B9 = pts[b9],
        dx9 = B9[0] - A9[0],
        dy9 = B9[1] - A9[1],
        L9 = Math.hypot(dx9, dy9);
      if (!(L9 > 0)) continue;
      // Triangles are CCW, so the open side is on the right of a -> b.
      if (inkAt((A9[0] + B9[0]) / 2 + (dy9 / L9) * off9, (A9[1] + B9[1]) / 2 - (dx9 / L9) * off9)) {
        lost9 = true;
        break;
      }
    }
    // A constraint no triangle touches at all is the same loss with no open edge to show it.
    if (!lost9) {
      const on9 = new Set();
      for (const t9 of cdtRes.tris)
        for (let e9 = 0; e9 < 3; e9++) on9.add(ekey9First(t9[e9], t9[(e9 + 1) % 3]));
      for (const [a9, b9] of constraints) {
        if (a9 === b9 || on9.has(ekey9First(a9, b9))) continue;
        const A9 = pts[a9],
          B9 = pts[b9],
          dx9 = B9[0] - A9[0],
          dy9 = B9[1] - A9[1],
          L9 = Math.hypot(dx9, dy9);
        if (!(L9 > 0)) continue;
        const mx9 = (A9[0] + B9[0]) / 2,
          my9 = (A9[1] + B9[1]) / 2,
          nx9 = (dy9 / L9) * off9,
          ny9 = -(dx9 / L9) * off9;
        if (inkAt(mx9 + nx9, my9 + ny9) || inkAt(mx9 - nx9, my9 - ny9)) {
          lost9 = true;
          break;
        }
      }
    }
    if (lost9) {
      let far9 = null;
      try {
        far9 = constrainedTriangulate(pts, constraints, { superScale: 4294967296 });
      } catch {
        far9 = null;
      }
      if (far9 && far9.tris && far9.tris.length) cdtRes = far9;
    }
  }
  if (!cdtRes || !cdtRes.tris || !cdtRes.tris.length) return _lbDecline('cdt-empty');

  // hull membership via a small grid over hull bboxes
  // The grid cell is 1/64 of the shape, with no absolute floor: a floored cell is a coarser grid,
  // and a different bucketing, for the same shape drawn small.
  const _span9 = (_xb - _xa + _yb - _ya) / 64,
    cell = _span9 > 0 ? _span9 : 1;
  const hGrid = new Map();
  const hullByVerts = new Map();
  hulls.forEach((h, hi) =>
    hullByVerts.set([h.ai, h.ci, h.bi].sort((x9, y9) => x9 - y9).join(','), hi),
  );
  const cubicByVerts = new Map();
  cubicRecs.forEach((r9, ri9) =>
    cubicByVerts.set([...r9.vis].sort((x9, y9) => x9 - y9).join(','), ri9),
  );
  const cubicGrid = new Map();
  cubicRecs.forEach((r9, ri9) => {
    const xs9 = r9.pts.map((P9) => P9[0]),
      ys9 = r9.pts.map((P9) => P9[1]);
    const x09 = Math.floor(Math.min(...xs9) / cell),
      x19 = Math.floor(Math.max(...xs9) / cell);
    const y09 = Math.floor(Math.min(...ys9) / cell),
      y19 = Math.floor(Math.max(...ys9) / cell);
    for (let cy9 = y09; cy9 <= y19; cy9++)
      for (let cx9 = x09; cx9 <= x19; cx9++) {
        const k9 = cx9 * 262147 + cy9;
        let l9 = cubicGrid.get(k9);
        if (!l9) cubicGrid.set(k9, (l9 = []));
        l9.push(ri9);
      }
  });
  // affine barycentric row interpolation: over the piece's widest control triangle, else its fan tri.
  // A fan tri this degenerate still drops its face, as it always has: which faces a piece emits is not the question
  // the frame answers, only what rows they carry.
  const cubicRowsAt = (r9, px9, py9) => {
    const A9 = r9.pts[0],
      B9 = r9.pts[1],
      C9 = r9.pts[2];
    const v0x = B9[0] - A9[0],
      v0y = B9[1] - A9[1],
      v1x = C9[0] - A9[0],
      v1y = C9[1] - A9[1];
    const den9 = v0x * v1y - v0y * v1x;
    if (!(Math.abs(den9) > 1e-18 * Math.sqrt((v0x * v0x + v0y * v0y) * (v1x * v1x + v1y * v1y))))
      return _lbDecline('den-degenerate');
    if (r9.frame9) return klmnFrameRowsAt9(r9.frame9, px9, py9);
    const v2x = px9 - A9[0],
      v2y = py9 - A9[1];
    const w1 = (v2x * v1y - v2y * v1x) / den9,
      w2 = (v0x * v2y - v0y * v2x) / den9,
      w0 = 1 - w1 - w2;
    return [
      w0 * r9.rows[0][0] + w1 * r9.rows[1][0] + w2 * r9.rows[2][0],
      w0 * r9.rows[0][1] + w1 * r9.rows[1][1] + w2 * r9.rows[2][1],
      w0 * r9.rows[0][2] + w1 * r9.rows[1][2] + w2 * r9.rows[2][2],
    ];
  };

  // ---- THIN-CHANNEL whole-face AIR drop ---------------------------------
  // A member face can lie entirely on a nearby same-CONTOUR boundary's AIR side
  // (whisker faces beyond a thin channel's far wall: the '8' waist, thin glyph
  // rings, the '?' hook). emitClipped9 drops such faces using the exact
  // per-boundary implicit inkSideF9. STRADDLING faces are not reshaped by a chord
  // clip: flattening the boundary to a fixed number of em-space chords would be a
  // scale-bounded approximation with no device error bound.
  const inkSideF9 = (kind9, i9, x9, y9) => {
    if (kind9 === 0) {
      const h9 = hulls[i9];
      const t9 = uvIn(h9, x9, y9);
      if (!t9) return 0;
      const f9 = (h9.w || 1) !== 1 ? t9[0] * t9[0] - t9[1] * t9[2] : t9[0] * t9[0] - t9[1];
      return h9.sign * f9;
    }
    const r9 = cubicRecs[i9];
    if (r9.rows) {
      const rr9 = cubicRowsAt(r9, x9, y9);
      return rr9 ? r9.sign * (rr9[0] * rr9[0] * rr9[0] - rr9[1] * rr9[2]) : 0;
    }
    return r9.sign * evalBezout(r9.F, x9, y9);
  };
  const endKeys9 = (kind9, i9) =>
    kind9 === 0
      ? [key(hulls[i9].a), key(hulls[i9].b)]
      : [key(cubicRecs[i9].cp[0]), key(cubicRecs[i9].cp[3])];
  // Emit a member face, dropping it when it lies WHOLLY on a nearby same-contour
  // boundary's air side.
  const emitClipped9 = (kind9, own9, A9, B9, C9, emit9) => {
    const x09 = Math.min(A9[0], B9[0], C9[0]),
      x19 = Math.max(A9[0], B9[0], C9[0]);
    const y09 = Math.min(A9[1], B9[1], C9[1]),
      y19 = Math.max(A9[1], B9[1], C9[1]);
    const cands9 = new Set();
    for (let cy9 = Math.floor(y09 / cell); cy9 <= Math.floor(y19 / cell); cy9++)
      for (let cx9 = Math.floor(x09 / cell); cx9 <= Math.floor(x19 / cell); cx9++) {
        const k9 = cx9 * 262147 + cy9;
        const lq9 = hGrid.get(k9);
        if (lq9) for (const i9 of lq9) cands9.add(i9 * 2);
        const lc9 = cubicGrid.get(k9);
        if (lc9) for (const i9 of lc9) cands9.add(i9 * 2 + 1);
      }
    const ownKeys9 = endKeys9(kind9, own9);
    const poly9 = [
      [A9[0], A9[1]],
      [B9[0], B9[1]],
      [C9[0], C9[1]],
    ];
    for (const enc9 of cands9) {
      const ck9 = enc9 & 1,
        ci9 = enc9 >> 1;
      if (ck9 === (kind9 === 0 ? 0 : 1) && ci9 === own9) continue;
      if (ck9 === 1 && kind9 === 1 && cubicRecs[ci9].pid === cubicRecs[own9].pid) continue;
      // same-CONTOUR channels only (the '?' hook: one contour's two sides).
      // Cross-contour overlaps (glyph rings, the droplet) are handled exactly
      // by the membership tiers + split machinery and the clip only hurt them.
      // Cross-shape channels are painter's-order territory, unreachable by any
      // per-shape builder.
      const ownCi9 = kind9 === 0 ? hulls[own9].ci9 : cubicRecs[own9].ci9;
      const candCi9 = ck9 === 0 ? hulls[ci9].ci9 : cubicRecs[ci9].ci9;
      if (ownCi9 !== candCi9) continue;
      const ek9 = endKeys9(ck9, ci9);
      {
        // ADJACENT boundaries (shared curve endpoint) are exempt only at a
        // SMOOTH join — the chain continues through and the curves can't form
        // a channel there. At a TIP the outline doubles back, the away-tangents
        // point the same way, and the two adjacent sides must clip each other.
        const sh9 =
          ek9[0] === ownKeys9[0] || ek9[0] === ownKeys9[1]
            ? ek9[0]
            : ek9[1] === ownKeys9[0] || ek9[1] === ownKeys9[1]
              ? ek9[1]
              : -1;
        if (sh9 !== -1) {
          const away9 = (kk9, ii9, atKey9) => {
            let P0, P1, P2;
            if (kk9 === 0) {
              const h9 = hulls[ii9];
              if (key(h9.a) === atKey9) {
                P0 = h9.a;
                P1 = h9.c;
                P2 = h9.b;
              } else {
                P0 = h9.b;
                P1 = h9.c;
                P2 = h9.a;
              }
            } else {
              const cp9 = cubicRecs[ii9].cp;
              if (key(cp9[0]) === atKey9) {
                P0 = cp9[0];
                P1 = cp9[1];
                P2 = cp9[2];
              } else {
                P0 = cp9[3];
                P1 = cp9[2];
                P2 = cp9[1];
              }
            }
            let dx9 = P1[0] - P0[0],
              dy9 = P1[1] - P0[1];
            const ex9 = P2[0] - P0[0],
              ey9 = P2[1] - P0[1];
            if (dx9 * dx9 + dy9 * dy9 < 1e-18 * (ex9 * ex9 + ey9 * ey9)) {
              dx9 = ex9;
              dy9 = ey9;
            }
            const L9 = Math.hypot(dx9, dy9) || 1;
            return [dx9 / L9, dy9 / L9];
          };
          const a19 = away9(kind9 === 0 ? 0 : 1, own9, sh9);
          const a29 = away9(ck9, ci9, sh9);
          // FAT (±2 both-sides) owners keep the blanket exemption: their beyond-side
          // ramp CO-OPERATES with the neighbor at a tip (the droplet's point lost
          // 148px when clipped). Thin ±1 owners (whisker cubics) get the tangent
          // test: a tip-join means the sides run parallel and MUST clip.
          if (kind9 === 0 && hulls[own9].fat && (hulls[own9].w || 1) === 1) continue;
          if (a19[0] * a29[0] + a19[1] * a29[1] < -0.5) continue; // smooth chain → exempt
          // tip/corner join → fall through: the candidate MAY clip
        }
      }
      // the candidate must GENUINELY overlap this face — its own hull tri must
      // contain a face point (a channel/waist). Grid-grazed neighbors whose
      // frames are extrapolated garbage here would clip legit ink.
      {
        // DEEP overlap only: the face CENTROID must sit barycentrically inside
        // the candidate's tri with margin. Grazing overlaps (adjacent serration
        // bumps) reached the fp-variant winding fallbacks and flipped a piece
        // across translations (the position-independence smoke); barycentric
        // margins are translation-invariant, so this gate is offset-stable.
        const T9 = ck9 === 0 ? [hulls[ci9].a, hulls[ci9].c, hulls[ci9].b] : cubicRecs[ci9].pts;
        const gx9 = (A9[0] + B9[0] + C9[0]) / 3,
          gy9 = (A9[1] + B9[1] + C9[1]) / 3;
        {
          const u09 = T9[1][0] - T9[0][0],
            u19 = T9[1][1] - T9[0][1];
          const v09 = T9[2][0] - T9[0][0],
            v19 = T9[2][1] - T9[0][1];
          const dn9 = u09 * v19 - u19 * v09;
          if (
            !(Math.abs(dn9) > 1e-18 * Math.sqrt((u09 * u09 + u19 * u19) * (v09 * v09 + v19 * v19)))
          )
            continue;
          const w19 =
            ((gx9 - T9[0][0]) * (T9[2][1] - T9[0][1]) - (gy9 - T9[0][1]) * (T9[2][0] - T9[0][0])) /
            dn9;
          const w29 =
            ((T9[1][0] - T9[0][0]) * (gy9 - T9[0][1]) - (T9[1][1] - T9[0][1]) * (gx9 - T9[0][0])) /
            dn9;
          const w09 = 1 - w19 - w29;
          if (Math.min(w09, w19, w29) < 0.02) continue;
        }
      }
      // whole-FACE verdict first: a face lying entirely on the candidate's AIR
      // side never has the candidate's curve CROSSING it, so the segment clip
      // (rightly gated on crossings after the '0'-ring infinite-line overcut)
      // never fires — yet every sample of the face is air by the neighbor
      // that genuinely bounds the ink there (the whisker faces beyond the far
      // side). The overlap gate above already anchors the face to the
      // candidate's hull, so the frame evaluation is in its valid zone.
      {
        // Span guard: the frame is only trustworthy inside the candidate's own
        // fan tri — at a V-tip (the droplet's point) the arms diverge and the
        // far face corners read garbage-air, dropping legit ink (148px at the
        // drop tip). Whole-face verdicts require the whole face inside the
        // candidate's tri; otherwise only the crossing-gated segment clip runs.
        const T9 = ck9 === 0 ? [hulls[ci9].a, hulls[ci9].c, hulls[ci9].b] : cubicRecs[ci9].pts;

        const tA9 = Math.abs(
          (T9[1][0] - T9[0][0]) * (T9[2][1] - T9[0][1]) -
            (T9[1][1] - T9[0][1]) * (T9[2][0] - T9[0][0]),
        );
        const tE9 = 1e-9 * (tA9 || 1);
        const inT9 = (px9, py9) => {
          const s1 =
            (T9[1][0] - T9[0][0]) * (py9 - T9[0][1]) - (T9[1][1] - T9[0][1]) * (px9 - T9[0][0]);
          const s2 =
            (T9[2][0] - T9[1][0]) * (py9 - T9[1][1]) - (T9[2][1] - T9[1][1]) * (px9 - T9[1][0]);
          const s3 =
            (T9[0][0] - T9[2][0]) * (py9 - T9[2][1]) - (T9[0][1] - T9[2][1]) * (px9 - T9[2][0]);
          return (s1 >= -tE9 && s2 >= -tE9 && s3 >= -tE9) || (s1 <= tE9 && s2 <= tE9 && s3 <= tE9);
        };
        let allIn9 = true;
        for (const P9 of poly9)
          if (!inT9(P9[0], P9[1])) {
            allIn9 = false;
            break;
          }
        if (allIn9) {
          let pos9 = 0,
            neg9 = 0;
          for (const P9 of poly9) {
            const f9 = inkSideF9(ck9, ci9, P9[0], P9[1]);
            if (f9 > 1e-6) pos9++;
            else if (f9 < -1e-6) neg9++;
          }
          // fp-noise-proof epsilons: 1e-12 flipped verdicts across translations
          // (caught by the position-independence smoke)
          if (pos9 === poly9.length) return; // face wholly on this boundary's AIR side → drop
          // neg9 === length (wholly ink) or a straddle: this candidate does not
          // drop the face — keep scanning the rest.
        }
      }
    }
    emit9(A9, B9, C9);
  };

  hulls.forEach((h, hi) => {
    const xs = [h.a[0], h.c[0], h.b[0]],
      ys = [h.a[1], h.c[1], h.b[1]];
    const x0 = Math.floor(Math.min(...xs) / cell),
      x1 = Math.floor(Math.max(...xs) / cell);
    const y0 = Math.floor(Math.min(...ys) / cell),
      y1 = Math.floor(Math.max(...ys) / cell);
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) {
        const k = cx * 262147 + cy;
        let l = hGrid.get(k);
        if (!l) hGrid.set(k, (l = []));
        l.push(hi);
      }
  });
  const inTri9 = (px, py, A, C, B) => {
    const s1 = (C[0] - A[0]) * (py - A[1]) - (C[1] - A[1]) * (px - A[0]);
    const s2 = (B[0] - C[0]) * (py - C[1]) - (B[1] - C[1]) * (px - C[0]);
    const s3 = (A[0] - B[0]) * (py - B[1]) - (A[1] - B[1]) * (px - B[0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  // standard-frame uv of a point in a hull (affine barycentric)
  const uvIn = uvInHull; // module-level (shared with the morph pair transform)

  let interior = [];
  const hullEdgeOf = new Map(); // face-edge key → hull idx, filled by pass 1 (hull members)
  const hullVertOf = new Map(); // vertex idx → hull idx (junction fans share only a vertex)
  const ekey9 = (i9, j9) => (i9 < j9 ? i9 * 2097152 + j9 : j9 * 2097152 + i9);
  const pushInt = (A9, B9, C9) => {
    interior.push(A9[0], A9[1], B9[0], B9[1], C9[0], C9[1]);
  };
  // An all-air face is not a crescent. A face landing inside a curve's hull is handed to that curve
  // and emitted with no ink test -- the implicit is trusted to carve it. But the implicit knows ONE
  // curve and a face's ink is decided by the whole outline, so a face the shape does not cover
  // anywhere still paints wherever that one half-space is negative. It is what the over-paint
  // proof's remaining declines are, every one of them.
  //
  // On the triangle that is EMITTED, not the one before clipping: emitClipped9 subdivides further, and
  // asking before the clip leaves all-air sub-faces emitted regardless. And at both cubic emission
  // sites -- the exact-vertex-match path and the containment path -- since covering only one leaves
  // the other's faces unexamined.
  //
  // Conservative: dropped only when NOT ONE sample finds ink, so a crescent straddling its arc
  // (part ink by construction) is never at risk.
  // Every segment's control points as a cubic plus a bounding box, once, so the exact test below
  // can reject the overwhelming majority of (face, segment) pairs on a box overlap.
  const _segBox9 = allSegs.map((o9) => {
    const q9 = !o9.p4 && !!o9.p3;
    const cp9 = o9.p4
      ? [o9.p1, o9.p2, o9.p3, o9.p4]
      : q9
        ? [o9.p1, o9.p2, o9.p3]
        : [o9.p1, o9.p1, o9.p2 || o9.p1, o9.p2 || o9.p1];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const q of cp9) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    return { cp: cp9, q: q9, w: q9 ? o9.w || 1 : 1, x0, y0, x1, y1 };
  });
  // Does the shape's boundary CROSS this triangle? Along a triangle edge the segment's signed
  // distance is a cubic in its own parameter, so the crossings are exact roots -- no sampling, and
  // no face holding a sliver of ink can be missed.
  const faceStraddles9 = (Pa9, Pb9, Pc9, touch9) => {
    // TOUCH MODE (quad hull sub-faces): a boundary that only meets the face at a vertex, or runs
    // along one of its edges, does not enter it -- the splitter's Steiner points sit ON a contour
    // line, and after float32 rounding that line reads as crossing the face's edges a hair from
    // their ends.
    const tEnd9 = touch9 ? 1e-4 : 1e-9;
    const fx0 = Math.min(Pa9[0], Pb9[0], Pc9[0]),
      fx1 = Math.max(Pa9[0], Pb9[0], Pc9[0]);
    const fy0 = Math.min(Pa9[1], Pb9[1], Pc9[1]),
      fy1 = Math.max(Pa9[1], Pb9[1], Pc9[1]);
    // A triangle's own containment test, for the segment that lies WHOLLY inside it: such a
    // segment crosses no edge, so edge-crossings alone would call the face boundary-free.
    const sd9 = (U9, V9, x9, y9) => (V9[0] - U9[0]) * (y9 - U9[1]) - (V9[1] - U9[1]) * (x9 - U9[0]);
    const inTri9 = (x9, y9) => {
      const s1 = sd9(Pa9, Pb9, x9, y9),
        s2 = sd9(Pb9, Pc9, x9, y9),
        s3 = sd9(Pc9, Pa9, x9, y9);
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };
    // Once no edge is crossed in its interior, a segment's open stretches between the parameters
    // where it meets the edge lines lie wholly inside the face or wholly outside, so one strict
    // containment test per stretch is exact. A crescent needs it: its own curve starts and ends on
    // two of the face's vertices and runs through the interior, and when those vertices round in
    // float32 the endpoint test above misses it -- the lbHoleParity ring lost two inner-edge
    // crescents to the all-air drop. Strict means clear of every edge by more than the float32
    // rounding of the face, so a contour line lying along an edge still does not enter it.
    const or9 = Math.sign(sd9(Pa9, Pb9, Pc9[0], Pc9[1]));
    const ulp9 =
      16 * 1.2e-7 * Math.max(Math.abs(fx0), Math.abs(fx1), Math.abs(fy0), Math.abs(fy1), 1e-30);
    const strictIn9 = (x9, y9) => {
      if (!or9) return false;
      for (const [U9, V9] of [
        [Pa9, Pb9],
        [Pb9, Pc9],
        [Pc9, Pa9],
      ]) {
        const L9 = Math.hypot(V9[0] - U9[0], V9[1] - U9[1]);
        if (!(or9 * sd9(U9, V9, x9, y9) > L9 * Math.max(ulp9, (touch9 ? 1e-5 : 1e-9) * L9)))
          return false;
      }
      return true;
    };
    const stretchIn9 = (cut9, at9) => {
      cut9.push(0, 1);
      cut9.sort((a9, b9) => a9 - b9);
      for (let k9 = 1; k9 < cut9.length; k9++) {
        if (!(cut9[k9] - cut9[k9 - 1] > 1e-9)) continue;
        const P9 = at9((cut9[k9 - 1] + cut9[k9]) / 2);
        if (strictIn9(P9[0], P9[1])) return true;
      }
      return false;
    };
    // A SEGMENT'S ENDPOINT ON THE FACE'S RIM DOES NOT PUT IT INSIDE, in touch mode. The partition's
    // vertices ARE the outline's joints, so a contour line routinely ends at a vertex of a hull
    // sub-face it never enters; a closed containment test would call every such face straddled and
    // the all-air drop would never fire. A notch inside one long quad's hull, bounded by lines that
    // all end on the notch faces' vertices, would then keep faces carrying the quad's implicit and
    // paint solid ink in the notch. A segment that does run into the face
    // from its rim is still seen, exactly: its first stretch after the rim is the stretch test's,
    // and an endpoint strictly inside the face remains a straddle on its own.
    const endIn9 = touch9 ? strictIn9 : inTri9;
    for (const sb9 of _segBox9) {
      if (sb9.x1 < fx0 || sb9.x0 > fx1 || sb9.y1 < fy0 || sb9.y0 > fy1) continue;
      const C9 = sb9.cp;
      if (sb9.q) {
        const Q0 = C9[0],
          Q1 = C9[1],
          Q2 = C9[2],
          wq = sb9.w;
        if (endIn9(Q0[0], Q0[1]) || endIn9(Q2[0], Q2[1])) return true;
        const cut9 = [];
        for (const [U9, V9] of [
          [Pa9, Pb9],
          [Pb9, Pc9],
          [Pc9, Pa9],
        ]) {
          let nx9 = -(V9[1] - U9[1]),
            ny9 = V9[0] - U9[0];
          const L9 = Math.hypot(nx9, ny9);
          if (!(L9 > 0)) continue;
          nx9 /= L9;
          ny9 /= L9;
          const d0 = nx9 * (Q0[0] - U9[0]) + ny9 * (Q0[1] - U9[1]);
          const d1 = nx9 * (Q1[0] - U9[0]) + ny9 * (Q1[1] - U9[1]);
          const d2 = nx9 * (Q2[0] - U9[0]) + ny9 * (Q2[1] - U9[1]);
          if (touch9 && Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2)) <= 1e-5 * L9) continue;
          // numerator of the rational signed distance: (1-t)^2 d0 + 2t(1-t) w d1 + t^2 d2 (denominator > 0)
          for (const t9 of rootsInUnit(0, d0 - 2 * wq * d1 + d2, 2 * wq * d1 - 2 * d0, d0)) {
            const u9 = 1 - t9,
              dn9 = u9 * u9 + 2 * u9 * t9 * wq + t9 * t9;
            const qx9 = (u9 * u9 * Q0[0] + 2 * u9 * t9 * wq * Q1[0] + t9 * t9 * Q2[0]) / dn9;
            const qy9 = (u9 * u9 * Q0[1] + 2 * u9 * t9 * wq * Q1[1] + t9 * t9 * Q2[1]) / dn9;
            const ex9 = V9[0] - U9[0],
              ey9 = V9[1] - U9[1];
            const tt9 =
              ((qx9 - U9[0]) * ex9 + (qy9 - U9[1]) * ey9) / (ex9 * ex9 + ey9 * ey9 || 1e-30);
            if (tt9 > tEnd9 && tt9 < 1 - tEnd9) return true;
            cut9.push(t9);
          }
        }
        if (
          stretchIn9(cut9, (t9) => {
            const u9 = 1 - t9,
              dn9 = u9 * u9 + 2 * u9 * t9 * wq + t9 * t9;
            return [
              (u9 * u9 * Q0[0] + 2 * u9 * t9 * wq * Q1[0] + t9 * t9 * Q2[0]) / dn9,
              (u9 * u9 * Q0[1] + 2 * u9 * t9 * wq * Q1[1] + t9 * t9 * Q2[1]) / dn9,
            ];
          })
        )
          return true;
        continue;
      }
      if (endIn9(C9[0][0], C9[0][1]) || endIn9(C9[3][0], C9[3][1])) return true;
      const cut9 = [];
      for (const [U9, V9] of [
        [Pa9, Pb9],
        [Pb9, Pc9],
        [Pc9, Pa9],
      ]) {
        let nx9 = -(V9[1] - U9[1]),
          ny9 = V9[0] - U9[0];
        const L9 = Math.hypot(nx9, ny9);
        if (!(L9 > 0)) continue;
        nx9 /= L9;
        ny9 /= L9;
        const d9 = C9.map((q9) => nx9 * (q9[0] - U9[0]) + ny9 * (q9[1] - U9[1]));
        if (
          touch9 &&
          Math.max(Math.abs(d9[0]), Math.abs(d9[1]), Math.abs(d9[2]), Math.abs(d9[3])) <= 1e-5 * L9
        )
          continue;
        const a3 = -d9[0] + 3 * d9[1] - 3 * d9[2] + d9[3];
        const b3 = 3 * d9[0] - 6 * d9[1] + 3 * d9[2];
        const c3 = -3 * d9[0] + 3 * d9[1];
        for (const t9 of rootsInUnit(a3, b3, c3, d9[0])) {
          const u9 = 1 - t9;
          const qx9 =
            u9 * u9 * u9 * C9[0][0] +
            3 * u9 * u9 * t9 * C9[1][0] +
            3 * u9 * t9 * t9 * C9[2][0] +
            t9 * t9 * t9 * C9[3][0];
          const qy9 =
            u9 * u9 * u9 * C9[0][1] +
            3 * u9 * u9 * t9 * C9[1][1] +
            3 * u9 * t9 * t9 * C9[2][1] +
            t9 * t9 * t9 * C9[3][1];
          const ex9 = V9[0] - U9[0],
            ey9 = V9[1] - U9[1];
          const tt9 =
            ((qx9 - U9[0]) * ex9 + (qy9 - U9[1]) * ey9) / (ex9 * ex9 + ey9 * ey9 || 1e-30);
          if (tt9 > tEnd9 && tt9 < 1 - tEnd9) return true;
          cut9.push(t9);
        }
      }
      if (
        stretchIn9(cut9, (t9) => {
          const u9 = 1 - t9;
          return [
            u9 * u9 * u9 * C9[0][0] +
              3 * u9 * u9 * t9 * C9[1][0] +
              3 * u9 * t9 * t9 * C9[2][0] +
              t9 * t9 * t9 * C9[3][0],
            u9 * u9 * u9 * C9[0][1] +
              3 * u9 * u9 * t9 * C9[1][1] +
              3 * u9 * t9 * t9 * C9[2][1] +
              t9 * t9 * t9 * C9[3][1],
          ];
        })
      )
        return true;
    }
    return false;
  };

  const f32 = (v) => Math.fround(v);
  const airFace9 = (Pa0, Pb0, Pc0, touch9) => {
    const Pa9 = [f32(Pa0[0]), f32(Pa0[1])],
      Pb9 = [f32(Pb0[0]), f32(Pb0[1])],
      Pc9 = [f32(Pc0[0]), f32(Pc0[1])];

    if (faceStraddles9(Pa9, Pb9, Pc9, touch9)) return false;
    return !inkAt((Pa9[0] + Pb9[0] + Pc9[0]) / 3, (Pa9[1] + Pb9[1] + Pc9[1]) / 3);
  };
  const quads = [];
  const plain9 = []; // pass-2 queue: faces not inside any hull
  for (const t of cdtRes.tris) {
    const A = pts[t[0]],
      B = pts[t[1]],
      C = pts[t[2]];
    const cx = (A[0] + B[0] + C[0]) / 3,
      cy = (A[1] + B[1] + C[1]) / 3;
    // cubic hull membership: exact fan-tri vertex match, else containment with
    // barycentric row adoption (subdivided hulls); Bezout F needs no rows.
    {
      const cvk9 = [t[0], t[1], t[2]].sort((x9, y9) => x9 - y9).join(',');
      const cri9 = cubicByVerts.get(cvk9);
      if (cri9 !== undefined && cubicRecs[cri9].invis9) {
        pushInt(A, B, C);
        continue;
      }
      if (cri9 !== undefined) {
        const r9 = cubicRecs[cri9];
        emitClipped9(1, cri9, A, B, C, (Pa9, Pb9, Pc9) => {
          if (airFace9(Pa9, Pb9, Pc9)) return;
          if (r9.rows) {
            // At the vertex as stored: the hull below is float32, and rows read at the float64 point describe a
            // curve displaced by that rounding from the one the stored face carries.
            const f32 = Math.fround;
            const ra9 = cubicRowsAt(r9, f32(Pa9[0]), f32(Pa9[1])),
              rb9 = cubicRowsAt(r9, f32(Pb9[0]), f32(Pb9[1])),
              rc9 = cubicRowsAt(r9, f32(Pc9[0]), f32(Pc9[1]));
            if (!ra9 || !rb9 || !rc9) return;
            cubics.push({
              hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
              klmn: new Float32Array([...ra9, ...rb9, ...rc9]),
              _frame9: r9.frame9,
              sign: r9.sign,
              cp: r9.cp,
              _ri9: cri9,
              seg9: r9.seg9,
              inkLeft: r9.inkLeft9,
              e1: r9.e1,
              e2: r9.e2,
              a: r9.a,
              b: r9.b,
              na: r9.na,
              nb: r9.nb,
            });
          } else {
            cubics.push({
              hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
              F: r9.F,
              sign: r9.sign,
              cp: r9.cp,
              _ri9: cri9,
              seg9: r9.seg9,
              keep: r9.keep9,
              inkLeft: r9.inkLeft9,
              e1: r9.e1,
              e2: r9.e2,
              a: r9.a,
              b: r9.b,
              na: r9.na,
              nb: r9.nb,
            });
          }
        });
        continue;
      }
      const cl9 = cubicGrid.get(Math.floor(cx / cell) * 262147 + Math.floor(cy / cell));
      let hit9 = -1;
      // tiered resolution (thin shapes have OVERLAPPING hulls from both sides):
      // whole-face containment with fp slack, SMALLEST fan tri wins; centroid
      // first-wins only as the fallback.
      if (cl9) {
        let bestAr9 = Infinity;
        for (const ri9 of cl9) {
          const r9 = cubicRecs[ri9];
          if (!inTri9(cx, cy, r9.pts[0], r9.pts[1], r9.pts[2])) continue;
          const ar9 = Math.abs(
            (r9.pts[1][0] - r9.pts[0][0]) * (r9.pts[2][1] - r9.pts[0][1]) -
              (r9.pts[1][1] - r9.pts[0][1]) * (r9.pts[2][0] - r9.pts[0][0]),
          );
          // No additive floor. `ar9` and the s-values below are both twice-areas, so `1e-7 * ar9`
          // is already the right dimensionless slack; the constant only takes over once the
          // drawing is small enough, and then the same face is contained at one size and not at
          // another. A genuinely zero-area triangle wants an exact test, which is what it gets.
          const sl9 = 1e-7 * ar9;
          const inE9 = (px9, py9) => {
            const s1 =
              (r9.pts[1][0] - r9.pts[0][0]) * (py9 - r9.pts[0][1]) -
              (r9.pts[1][1] - r9.pts[0][1]) * (px9 - r9.pts[0][0]);
            const s2 =
              (r9.pts[2][0] - r9.pts[1][0]) * (py9 - r9.pts[1][1]) -
              (r9.pts[2][1] - r9.pts[1][1]) * (px9 - r9.pts[1][0]);
            const s3 =
              (r9.pts[0][0] - r9.pts[2][0]) * (py9 - r9.pts[2][1]) -
              (r9.pts[0][1] - r9.pts[2][1]) * (px9 - r9.pts[2][0]);
            return (
              (s1 >= -sl9 && s2 >= -sl9 && s3 >= -sl9) || (s1 <= sl9 && s2 <= sl9 && s3 <= sl9)
            );
          };
          if (!inE9(A[0], A[1]) || !inE9(B[0], B[1]) || !inE9(C[0], C[1])) continue;
          if (ar9 < bestAr9) {
            bestAr9 = ar9;
            hit9 = ri9;
          }
        }
        // fallback: centroid-only, SMALLEST containing rec wins — first-wins
        // picked an overlapping neighbor's frame for subdivided faces and the
        // wrong-frame side read beyond-curve (cov→0: the leaf's white zones).
        if (hit9 < 0) {
          let ba9 = Infinity;
          for (const ri9 of cl9) {
            const r9 = cubicRecs[ri9];
            if (!inTri9(cx, cy, r9.pts[0], r9.pts[1], r9.pts[2])) continue;
            const ar9 = Math.abs(
              (r9.pts[1][0] - r9.pts[0][0]) * (r9.pts[2][1] - r9.pts[0][1]) -
                (r9.pts[1][1] - r9.pts[0][1]) * (r9.pts[2][0] - r9.pts[0][0]),
            );
            if (ar9 < ba9) {
              ba9 = ar9;
              hit9 = ri9;
            }
          }
        }
      }
      if (hit9 >= 0 && cubicRecs[hit9].invis9) {
        pushInt(A, B, C);
        continue;
      }
      if (hit9 >= 0) {
        const r9 = cubicRecs[hit9];
        let emitted9 = false;
        emitClipped9(1, hit9, A, B, C, (Pa9, Pb9, Pc9) => {
          if (airFace9(Pa9, Pb9, Pc9)) return;
          if (r9.rows) {
            // At the vertex as stored: the hull below is float32, and rows read at the float64 point describe a
            // curve displaced by that rounding from the one the stored face carries.
            const f32 = Math.fround;
            const ra9 = cubicRowsAt(r9, f32(Pa9[0]), f32(Pa9[1])),
              rb9 = cubicRowsAt(r9, f32(Pb9[0]), f32(Pb9[1])),
              rc9 = cubicRowsAt(r9, f32(Pc9[0]), f32(Pc9[1]));
            if (!ra9 || !rb9 || !rc9) return;
            cubics.push({
              hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
              klmn: new Float32Array([...ra9, ...rb9, ...rc9]),
              _frame9: r9.frame9,
              sign: r9.sign,
              cp: r9.cp,
              _ri9: hit9,
              seg9: r9.seg9,
              inkLeft: r9.inkLeft9,
              e1: r9.e1,
              e2: r9.e2,
              a: r9.a,
              b: r9.b,
              na: r9.na,
              nb: r9.nb,
            });
            emitted9 = true;
          } else {
            cubics.push({
              hull: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
              F: r9.F,
              sign: r9.sign,
              cp: r9.cp,
              _ri9: hit9,
              seg9: r9.seg9,
              keep: r9.keep9,
              inkLeft: r9.inkLeft9,
              e1: r9.e1,
              e2: r9.e2,
              a: r9.a,
              b: r9.b,
              na: r9.na,
              nb: r9.nb,
            });
            emitted9 = true;
          }
        });
        continue;
      }
    }
    // hull membership. Hulls OVERLAP across contours (a glyph's outer hull can
    // contain the whole counter hull), so first-containing-wins misassigns the
    // frame ('0': counter faces adopted the OUTER hull's sign). Resolution order:
    // (1) exact vertex-index match (the pure hull face), (2) whole-face
    // containment with the SMALLEST hull winning (tightest frame).
    let hin = -1;
    {
      const vs9 = [t[0], t[1], t[2]].sort((x9, y9) => x9 - y9).join(',');
      const byIdx9 = hullByVerts.get(vs9);
      if (byIdx9 !== undefined) hin = byIdx9;
      else {
        let bestArea9 = Infinity;
        const cellList = hGrid.get(Math.floor(cx / cell) * 262147 + Math.floor(cy / cell));
        if (cellList)
          for (const hi of cellList) {
            const h = hulls[hi];
            if (!inTri9(cx, cy, h.a, h.c, h.b)) continue;
            // vertex containment with relative slack: subdivided-face verts sit ON
            // hull edges and fp puts them ±1e-12 outside (strict reject → unclaimed
            // faces → droplet holes).
            const sl9 =
              1e-7 *
              Math.abs(
                (h.c[0] - h.a[0]) * (h.b[1] - h.a[1]) - (h.c[1] - h.a[1]) * (h.b[0] - h.a[0]),
              );
            const inE9 = (px9, py9) => {
              const s1 = (h.c[0] - h.a[0]) * (py9 - h.a[1]) - (h.c[1] - h.a[1]) * (px9 - h.a[0]);
              const s2 = (h.b[0] - h.c[0]) * (py9 - h.c[1]) - (h.b[1] - h.c[1]) * (px9 - h.c[0]);
              const s3 = (h.a[0] - h.b[0]) * (py9 - h.b[1]) - (h.a[1] - h.b[1]) * (px9 - h.b[0]);
              return (
                (s1 >= -sl9 && s2 >= -sl9 && s3 >= -sl9) || (s1 <= sl9 && s2 <= sl9 && s3 <= sl9)
              );
            };
            if (!inE9(A[0], A[1]) || !inE9(B[0], B[1]) || !inE9(C[0], C[1])) continue;
            // among containing hulls (thin rings: a face sits inside both the
            // inner and outer arc's hull), the face belongs to the arc whose
            // CHORD is nearest — smallest-area picked the INNER hull for outer-
            // band faces and painted past the outer curve (thin-ring '0' 7px).
            const mx9 = (h.a[0] + h.b[0]) / 2,
              my9 = (h.a[1] + h.b[1]) / 2;
            const d9 = (mx9 - cx) * (mx9 - cx) + (my9 - cy) * (my9 - cy);
            if (d9 < bestArea9) {
              bestArea9 = d9;
              hin = hi;
            }
          }
        // nothing passed whole-face containment (fp-shifted verts after CDT
        // recovery): centroid-only first-wins — the original behavior — as the
        // safety net; unclaimed-face fallout is worse than a rare frame mismatch.
        if (hin < 0 && cellList)
          for (const hi of cellList) {
            const h = hulls[hi];
            if (inTri9(cx, cy, h.a, h.c, h.b)) {
              hin = hi;
              break;
            }
          }
      }
    }
    if (hin >= 0 && constraintsOnly9.has(hin)) {
      // INVISIBLE boundary (both sides ink): the hull region is plain solid.
      pushInt(A, B, C);
      continue;
    }
    if (
      hin >= 0 &&
      !(opts && (opts.plainRows || opts.skipCurveInterior)) &&
      inkSideF9(0, hin, cx, cy) > 0 &&
      !airFace9(A, B, C, true) &&
      !faceStraddles9(A, B, C, true)
    ) {
      // A FOREIGN CONTOUR'S INK IN this HULL. The curve does not enter this face, the face is ink, and the
      // curve's implicit calls it air: another subpath's fill lies in the control triangle, on the far side of
      // the arc, and the implicit would carve it away. No curve bounds this face, so it is plain ink.
      plain9.push([t, A, B, C, cx, cy]);
      continue;
    }
    if (hin >= 0) {
      const h = hulls[hin];
      const t0 = uvIn(h, A[0], A[1]),
        t1 = uvIn(h, B[0], B[1]),
        t2 = uvIn(h, C[0], C[1]);
      if (t0 && t1 && t2) {
        emitClipped9(0, hin, A, B, C, (Pa9, Pb9, Pc9) => {
          const ta9 = uvIn(h, Pa9[0], Pa9[1]),
            tb9 = uvIn(h, Pb9[0], Pb9[1]),
            tc9 = uvIn(h, Pc9[0], Pc9[1]);
          if (!ta9 || !tb9 || !tc9) return;
          if (airFace9(Pa9, Pb9, Pc9, true)) return;
          // Fatness for tip-clip exemption lives on the hull (`h.fat`); pack
          // uses live fatArc for ring vs bbox — no per-quad `_fat` stamp.
          quads.push({
            tri: new Float32Array([Pa9[0], Pa9[1], Pb9[0], Pb9[1], Pc9[0], Pc9[1]]),
            sign: h.sign,
            w: h.w || 1,
            _hi9: hin,
            tc: new Float32Array([
              ta9[0],
              ta9[1],
              ta9[2],
              tb9[0],
              tb9[1],
              tb9[2],
              tc9[0],
              tc9[1],
              tc9[2],
            ]),
          });
        });
        hullEdgeOf.set(ekey9(t[0], t[1]), hin);
        hullEdgeOf.set(ekey9(t[1], t[2]), hin);
        hullEdgeOf.set(ekey9(t[2], t[0]), hin);
        for (const vi9 of t) if (!hullVertOf.has(vi9)) hullVertOf.set(vi9, hin);
        continue;
      }
    }
    plain9.push([t, A, B, C, cx, cy]);
  }
  // ---- pass 2: plain faces. Faces sharing an edge with a HULL MEMBER adopt
  // that hull's frame (structural adjacency — an index-key chord lookup would miss
  // subdivided hulls); oversized adoptees fan-split; the rest classify by
  // exact probes.
  for (const [t, A, B, C, cx, cy] of plain9) {
    // Unclaimed face: 4 exact probes (centroid + vert→centroid midpoints).
    // All-ink → plain interior. All-air → dropped (razor air wedges between
    // consecutive hull edges at seam vertices — single-ray ties painted them
    // solid). MIXED → the face STRADDLES the outline outside any hull (the seam
    // wedge between consecutive arcs): attach it to the NEAREST hull's frame —
    // barycentric tc extrapolates cleanly and curveCov supplies the ramp, the
    // face's own boundary acts as the clip (equivalent to a tangent-clip
    // extension; without this every seam-adjacent boundary pixel would lose its
    // outside AA).
    {
      // each probe casts its own ray direction: with one shared axis ray, a
      // razor face hugging a boundary ties the same way at all four probes
      // (correlated) and goes solid past the outer curve (a thin ring such as '0').
      const inkD9 = (x9, y9, k9) => {
        // The axis probe is `_windAt`'s query exactly (same segs, the same exact side test), so it takes the
        // winding TREE when one was built instead of re-walking every segment. The other three
        // cast rotated rays: the tree prunes by y-interval against an axis-aligned bbox, which
        // says nothing about a rotated ray, so they stay on the linear walk by construction.
        // All four read windSegs9 — the list as AUTHORED. These probes are what DECIDES the
        // even-odd reorientation, so they must not read the reoriented segments `allSegs`
        // carries at this point, and `_windAt`'s tree is built over windSegs9 for the same reason.
        const w9 =
          k9 === 0
            ? _windAt(x9, y9)
            : k9 === 1
              ? rayWindingDir(windSegs9, x9, y9, 0.9271838545667874, 0.37460659341591207)
              : k9 === 2
                ? rayWindingDir(windSegs9, x9, y9, -0.29552020666133955, 0.9553364891256061)
                : rayWindingDir(windSegs9, x9, y9, 0.6216099682706644, -0.7833269096274834);
        return evenodd ? (w9 & 1) === 1 : w9 !== 0;
      };
      let ink9 = inkD9(cx, cy, 0) ? 1 : 0;
      ink9 += inkD9((A[0] + cx) / 2, (A[1] + cy) / 2, 1) ? 1 : 0;
      ink9 += inkD9((B[0] + cx) / 2, (B[1] + cy) / 2, 2) ? 1 : 0;
      ink9 += inkD9((C[0] + cx) / 2, (C[1] + cy) / 2, 3) ? 1 : 0;
      if (ink9 >= 4) {
        pushInt(A, B, C);
        continue;
      }
      if (ink9 === 0) continue;
      // mixed: nearest hull by chord-midpoint distance (grid cells first, global fallback)
      let best9 = -1,
        bd9 = Infinity;
      const scanH9 = (hi9) => {
        const h9 = hulls[hi9];
        const mx9 = (h9.a[0] + h9.b[0]) / 2,
          my9 = (h9.a[1] + h9.b[1]) / 2;
        const d9 = (mx9 - cx) * (mx9 - cx) + (my9 - cy) * (my9 - cy);
        if (d9 < bd9) {
          bd9 = d9;
          best9 = hi9;
        }
      };
      const cl9 = hGrid.get(Math.floor(cx / cell) * 262147 + Math.floor(cy / cell));
      if (cl9) for (const hi9 of cl9) scanH9(hi9);
      if (best9 < 0) for (let hi9 = 0; hi9 < hulls.length; hi9++) scanH9(hi9);
      if (best9 >= 0 && constraintsOnly9.has(best9)) {
        if (ink9 >= 2) pushInt(A, B, C);
        continue;
      }
      if (best9 >= 0) {
        const h9 = hulls[best9];
        const t09 = uvIn(h9, A[0], A[1]),
          t19 = uvIn(h9, B[0], B[1]),
          t29 = uvIn(h9, C[0], C[1]);
        if (t09 && t19 && t29) {
          // Straddler face carries the boundary ramp on whichever side it pokes
          // (extent is the clip). Kind-12 owns exterior AA when bands are present.
          quads.push({
            tri: new Float32Array([A[0], A[1], B[0], B[1], C[0], C[1]]),
            sign: h9.sign,
            w: h9.w || 1,
            _hi9: best9,
            tc: new Float32Array([
              t09[0],
              t09[1],
              t09[2],
              t19[0],
              t19[1],
              t19[2],
              t29[0],
              t29[1],
              t29[2],
            ]),
          });
          continue;
        }
      }
      if (ink9 >= 2) pushInt(A, B, C);
    }
  }
  // Band post-pass: split large interior faces at the arcs' AA band and adopt
  // near-curve pieces. The splitter is builder-agnostic (flat tris + arc
  // records in), so the partition path can share it without re-deriving gates.
  // Cubic channel self-audit: sample each piece's paint verdict (centroid + 3
  // vert-mids) against exact winding. If >15% of samples mispaint, the shape
  // needs composed coverage that this builder cannot express and draws via Slug.
  if (cubics.length) {
    // DROP near-degenerate cubic pieces (hull collapsed toward a POINT). Such a
    // sub-sliver covers ~0 arc length, so removing it leaves no crack — but its
    // implicit is numerically unstable at ~0 extent, so it emits spurious f<0 samples.
    // Kept in the mesh those become an over-paint that GROWS with zoom (a degenerate
    // triangle's area scales with the reuse scale); left in the audit they FALSELY
    // decline the whole shape to Slug (1st_Fish: 3 collapsed pieces → 2 lost shapes).
    // Extent, NOT area (a long thin crescent has tiny area yet is visible), below a
    // sub-pixel fraction of the shape. Mutating the const array drops them from the
    // returned mesh too, so they never render at any zoom.
    //
    // Static only. A morph PAIR builds its dst cubics one-to-one against this src's
    // cubics (buildLoopBlinnPartitionPair), and a piece that is degenerate at the SRC
    // pose can grow into a real crescent at the DST pose — dropping it here would
    // desync the pair and under-fill the dst end of the morph. Morph builds (they pass
    // plainRows for transient mid-frames or skipCurveInterior for the pair) keep every
    // piece to preserve the src↔dst correspondence; a genuinely-degenerate over-paint
    // there still declines via the audit below (→ correct Slug morph).
    dropCollapsedCubics9(cubics, opts);
    // Sample each cubic piece's paint verdict (centroid + vert-mids) against exact
    // winding: a piece painting AIR (f<0 && !inkAt) is a defect.
    const scanCubics9 = (cubs) => {
      let bad = 0,
        tot = 0;
      // A piece's own implicit SCALE, and the shape's. k³ − l·m has no fixed magnitude — it moves
      // with the frame — so an absolute dead band means a different thing on every piece, and a
      // piece whose frame is orders of magnitude flatter than its siblings is DEGENERATE: its
      // verdict is noise, exactly as a huge κ at a vanishing gradient is noise in the kernel.
      // Judged relatively, the four samples that declined a whole 16-cubic contour to Slug sit at
      // 1.0e-8 on frames three decades below the shape's — nothing at all.
      const scaleOf9 = (c9) => {
        if (!c9.klmn) return 0;
        let m = 0;
        for (let r9 = 0; r9 < 3; r9++) {
          const kk = c9.klmn[r9 * 3],
            ll = c9.klmn[r9 * 3 + 1],
            mm = c9.klmn[r9 * 3 + 2];
          m = Math.max(m, Math.abs(kk * kk * kk), Math.abs(ll * mm));
        }
        return m;
      };
      let shapeSc9 = 0;
      for (const c9 of cubs) shapeSc9 = Math.max(shapeSc9, scaleOf9(c9));
      for (const c9 of cubs) {
        const H9 = c9.hull;
        const gx9 = (H9[0] + H9[2] + H9[4]) / 3,
          gy9 = (H9[1] + H9[3] + H9[5]) / 3;
        const dxa9 = H9[2] - H9[0],
          dya9 = H9[3] - H9[1],
          dxb9 = H9[4] - H9[0],
          dyb9 = H9[5] - H9[1];
        const den9 = dxa9 * dyb9 - dya9 * dxb9;
        const denBar9 =
          1e-18 * Math.sqrt((dxa9 * dxa9 + dya9 * dya9) * (dxb9 * dxb9 + dyb9 * dyb9));

        const _pts9 = [
          [gx9, gy9],
          [(H9[0] + gx9) / 2, (H9[1] + gy9) / 2],
          [(H9[2] + gx9) / 2, (H9[3] + gy9) / 2],
          [(H9[4] + gx9) / 2, (H9[5] + gy9) / 2],
          [((H9[0] + H9[2]) / 2) * 0.7 + gx9 * 0.3, ((H9[1] + H9[3]) / 2) * 0.7 + gy9 * 0.3],
          [((H9[2] + H9[4]) / 2) * 0.7 + gx9 * 0.3, ((H9[3] + H9[5]) / 2) * 0.7 + gy9 * 0.3],
          [((H9[4] + H9[0]) / 2) * 0.7 + gx9 * 0.3, ((H9[5] + H9[1]) / 2) * 0.7 + gy9 * 0.3],
          [H9[0] * 0.85 + gx9 * 0.15, H9[1] * 0.85 + gy9 * 0.15],
          [H9[2] * 0.85 + gx9 * 0.15, H9[3] * 0.85 + gy9 * 0.15],
          [H9[4] * 0.85 + gx9 * 0.15, H9[5] * 0.85 + gy9 * 0.15],
        ];
        for (const [px9, py9] of _pts9) {
          let f9;
          if (c9.klmn) {
            if (!(Math.abs(den9) > denBar9)) continue;
            const w19 = ((px9 - H9[0]) * (H9[5] - H9[1]) - (py9 - H9[1]) * (H9[4] - H9[0])) / den9;
            const w29 = ((H9[2] - H9[0]) * (py9 - H9[1]) - (H9[3] - H9[1]) * (px9 - H9[0])) / den9;
            const w09 = 1 - w19 - w29;
            const T9 = c9.klmn;
            const k9 = w09 * T9[0] + w19 * T9[3] + w29 * T9[6],
              l9 = w09 * T9[1] + w19 * T9[4] + w29 * T9[7],
              m9 = w09 * T9[2] + w19 * T9[5] + w29 * T9[8];
            f9 = c9.sign * (k9 * k9 * k9 - l9 * m9);
          } else f9 = c9.sign * evalBezout(c9.F, px9, py9);
          //
          if (Math.abs(f9) < 1e-4 * Math.max(scaleOf9(c9), 1e-30)) continue;
          tot++;

          const degen9 = !!c9.klmn && shapeSc9 > 0 && scaleOf9(c9) < 1e-3 * shapeSc9;
          // ...AND THE AUDIT MUST ASK THE same QUESTION THE KERNEL ANSWERS. A Bezout crescent
          // carries a half-plane past which it does not paint (see bezoutKeepHalf9), so a sample
          // beyond it is over-paint the renderer will never produce -- and counting it declines a
          // shape that would have drawn correctly. Tested without the kernel's 1.5px release: the
          // audit is resolution-independent, and the release is sub-pixel slack the renderer adds
          // to keep the AA band, not area anyone can see.
          const kp9 = c9.keep;
          if (kp9 && kp9[0] * px9 + kp9[1] * py9 > kp9[2]) continue;
          if (f9 < 0 && !inkAt(px9, py9) && !degen9) {
            bad++;
            // WHERE it over-paints, not just how often. The audit's verdict is a count, and a
            // count cannot tell a crescent whose hull pokes outside the shape from two crescents
            // co-covering each other — different defects with different fixes. Recorded only when
            // someone asks (the global is opt-in), so the audit stays allocation-free by default.
            if (typeof globalThis !== 'undefined' && globalThis.__lbAuditTrace) {
              (globalThis.__lbAuditBad || (globalThis.__lbAuditBad = [])).push({
                hasKeep: !!kp9,
                keepD: kp9 ? kp9[0] * px9 + kp9[1] * py9 - kp9[2] : null,
                // How deep INSIDE its own half-space the piece holds this sample, in em. A sample
                // the piece merely ramps across is a fraction of a pixel deep; one it paints solid
                // is not. This is what separates "the audit is over-strict about the AA band" from
                // "this piece really does put ink where the shape has none".
                dEm: (() => {
                  if (c9.klmn || !c9.F) return null;
                  const h = 1e-5 * (Math.abs(px9) + Math.abs(py9) + 1);
                  const gx =
                    (c9.sign * evalBezout(c9.F, px9 + h, py9) -
                      c9.sign * evalBezout(c9.F, px9 - h, py9)) /
                    (2 * h);
                  const gy =
                    (c9.sign * evalBezout(c9.F, px9, py9 + h) -
                      c9.sign * evalBezout(c9.F, px9, py9 - h)) /
                    (2 * h);
                  const gl = Math.hypot(gx, gy);
                  return gl > 0 ? Math.abs(f9) / gl : null;
                })(),
                chord: c9.cp
                  ? Math.hypot(c9.cp[3][0] - c9.cp[0][0], c9.cp[3][1] - c9.cp[0][1])
                  : null,
                hull: [H9[0], H9[1], H9[2], H9[3], H9[4], H9[5]],
                p: [px9, py9],
                f: f9,
                kind: c9.klmn ? 'klmn' : 'bezout',
              });
            }
          }
        }
      }
      return { bad, tot };
    };
    const { bad: bad9, tot: tot9 } = scanCubics9(cubics);
    if (typeof globalThis !== 'undefined' && globalThis.__lbAuditTrace) {
      globalThis.__lbAuditTot = tot9;
      globalThis.__lbAuditBadN = bad9;
      globalThis.__lbAuditPieces = cubics.length;
    }

    declineAudit9 = tot9 >= 8 && bad9 > 0 && !mantleDebugHook('__lbAuditOff');

    blendTier9 = bad9 > 0;
  }

  // DEPTH-CARVE interior: kind-0 solids + hull crescents + kind-12 bands.
  // Chord-adjacent interior faces must ramp by the arc (font bowls): bare
  // solids paint 1.0 just inside the chord while AAC is ~50%. Pass hull
  // chords into splitInteriorByCurve (same as fast-mesh) so those faces
  // become kind-5 curveTris.
  //
  // plainRows: no corner-row pass (segment morph mid-frames).
  // skipCurveInterior: corner rows with EMPTY arc maps — morph pairs
  // transform quads via hull `_hi9`, and fill-side curveTris have no hull,
  // so appending them makes pair build return null → Slug (lbHoleParity).
  // Split corner triangles carrying ≥2 STRAIGHT boundary edges so every edge
  // gets its own inner ramp (both the chain and line-row branches pack one
  // ramp/chain per face). Skipped for the morph opts (their pair build depends
  // on a fixed src↔dst vertex correspondence). See subdivideBoundaryTriPoints.
  if (!(opts && (opts.plainRows || opts.skipCurveInterior)))
    interior = subdivideBoundaryTriPoints(interior, edges);
  // A translucent solid must use the non-overlapping partition, but a simple
  // convex contour does not need analytic interior chains. Its curve bands
  // already provide AA, while running a chain kernel over the large interior
  // faces is substantially more expensive. Keep chains for every shape with
  // a reflex corner, concave curve, hole, or non-static build.
  const simpleConvexTranslucent9 =
    !!(opts && opts.transSolid) &&
    contours.length === 1 &&
    cubicRecs.length === 0 &&
    hulls.some((h9) => !h9.invis9) &&
    hulls.every((h9) => h9.invis9 || (h9.sign || 1) >= 0) &&
    edges.every((e9) => (!e9.e1 || e9.e1.turn >= -1e-6) && (!e9.e2 || e9.e2.turn >= -1e-6)) &&
    stripArcs.every((a9) => (!a9.e1 || a9.e1.turn >= -1e-6) && (!a9.e2 || a9.e2.turn >= -1e-6));
  // Whether this shape takes the analytic chain route below, asked once so a morph pair can ask for the same answer.
  //
  if (simpleConvexTranslucent9 && contours[0].length <= 64) {
    const poly9 = [];
    for (const s9 of contours[0]) {
      const p9 = [Math.fround(s9.p1[0]), Math.fround(s9.p1[1])];
      const prev9 = poly9[poly9.length - 1];
      if (!prev9 || p9[0] !== prev9[0] || p9[1] !== prev9[1]) poly9.push(p9);
    }
    if (poly9.length > 1 && poly9[0][0] === poly9.at(-1)[0] && poly9[0][1] === poly9.at(-1)[1])
      poly9.pop();
    let ar9 = 0,
      oldAr9 = 0,
      cx9 = 0,
      cy9 = 0;
    for (let i9 = 0; i9 < poly9.length; i9++) {
      const a9 = poly9[i9],
        b9 = poly9[(i9 + 1) % poly9.length];
      ar9 += a9[0] * b9[1] - a9[1] * b9[0];
      cx9 += a9[0];
      cy9 += a9[1];
    }
    for (let i9 = 0; i9 < interior.length; i9 += 6)
      oldAr9 += Math.abs(
        (interior[i9 + 2] - interior[i9]) * (interior[i9 + 5] - interior[i9 + 1]) -
          (interior[i9 + 3] - interior[i9 + 1]) * (interior[i9 + 4] - interior[i9]),
      );
    let cert9 = poly9.length >= 3 && Math.abs(Math.abs(ar9) - oldAr9) <= 8 * emEps() * emSpan();
    const ori9 = Math.sign(ar9);
    for (let i9 = 0; i9 < poly9.length && cert9; i9++) {
      const a9 = poly9[i9],
        b9 = poly9[(i9 + 1) % poly9.length];
      for (const p9 of poly9)
        if (ori9 * ((b9[0] - a9[0]) * (p9[1] - a9[1]) - (b9[1] - a9[1]) * (p9[0] - a9[0])) < 0) {
          cert9 = false;
          break;
        }
    }
    if (cert9) {
      cx9 /= poly9.length;
      cy9 /= poly9.length;
      const fan9 = [];
      for (let i9 = 0; i9 < poly9.length; i9++)
        fan9.push(...poly9[i9], ...poly9[(i9 + 1) % poly9.length], cx9, cy9);
      interior = fan9;
    }
  }
  const chainable9 = !simpleConvexTranslucent9;
  // A MORPH PAIR TAKES THE CHAINS TOO (`pairChains9`), wherever the static build would. Its two row modes below have no
  // curve in them at all: a pixel whose center is inside a chord and whose box straddles the arc beyond it gets no
  // crescent fragment to reject it, and the interior painted it solid -- the over-fill the chain route exists to stop,
  // on every frame of every curved morph, t = 0 included. The chains add no vertex, so the pair's topology is unchanged;
  // every chain point is an outline point with a provenance the pair can place on its destination (see chainMid9).
  const pairChain9 = !!(opts && opts.pairChains9 && chainable9);
  let rowsPlan9;
  if (opts && opts.plainRows && !pairChain9) {
    rowsPlan9 = {
      solid: new Float32Array(interior),
      solidEdges: selfOrientRows(
        interiorEdgesFromTriPoints(new Float32Array(interior), edges),
        interior,
      ),
      solidEdges2: null,
      solidEdges3: null,
      curveTris: [],
    };
  } else if (opts && opts.skipCurveInterior && !pairChain9) {
    rowsPlan9 = splitInteriorByCurve(
      new Float32Array(interior),
      selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
      new Map(),
      new Map(),
      true,
      edges,
    );
  } else if (chainable9) {
    const pePS9 = emEps(); // one float32 ulp of the shape's extent
    //   * A WHOLLY INVISIBLE straight edge (ink on both sides: a same-wound contour nested under nonzero, or
    //     two contours meeting along a side) is not outline, and a chain that carries it tells every
    //     face beside it that the fill stops there. The hull loop below already skips invisible
    //     curves (`invis9`). Without it a rect inside a same-wound rect -- a solid rect -- would lose
    //     ink over its interior pixels (glslEmuFidelity checks this). Probed at three points along the edge, so
    //     an edge that is outline over part of its length stays.
    //   * WHICH SIDE IS INK, on a straight outline's chain, which is built from lines only, is read off the
    //     fill beside the edge (interiorChainsFromTris, `line9`) rather than off the face's centroid, which
    //     stands on the wrong side of an edge's line when the face is not beside that edge:
    //     lbDiagonalFrameParity's frame corner read 0.21 where the path covers 0.94, its chain 2 reversed.
    //
    const allStraight9 = !hulls.length && !cubicRecs.length;
    /** @type {Array<{p1:number[], p2:number[], nx:number, ny:number, c?:number[], cp?:number[][], line9?:boolean}>} */
    const chainEdges9 = [];
    for (const e of edges) {
      const dx = e.p2[0] - e.p1[0],
        dy = e.p2[1] - e.p1[1],
        L = Math.hypot(dx, dy);
      // A morph pair builds one chain for every pose, and an edge covered at this pose need not be at the other, so beside curves it stays.
      if (L > pePS9 && (allStraight9 || !pairChain9)) {
        const o = 0.01 * L,
          ox = (-dy / L) * o,
          oy = (dx / L) * o;
        let invis = true;
        for (const t of [0.1, 0.5, 0.9]) {
          const qx = e.p1[0] + t * dx,
            qy = e.p1[1] + t * dy;
          if (!(inkAt(qx + ox, qy + oy) && inkAt(qx - ox, qy - oy))) {
            invis = false;
            break;
          }
          // Beside curves, also no further off than the sliver curveSides9 reads as ink: a real neighbor keeps the edge's ramp.
          if (!allStraight9 && o > _hairOff9) {
            const hx = (-dy / L) * _hairOff9,
              hy = (dx / L) * _hairOff9;
            if (!(inkAt(qx + hx, qy + hy) && inkAt(qx - hx, qy - hy))) {
              invis = false;
              break;
            }
          }
        }
        if (invis) continue;
      }
      if (!allStraight9) {
        chainEdges9.push(e);
        continue;
      }
      chainEdges9.push(Object.assign({}, e, { line9: true }));
    }
    const pushPE9 = (P1, P2, T, toward, cp) => {
      const dx = P2[0] - P1[0],
        dy = P2[1] - P1[1],
        L = Math.hypot(dx, dy);
      if (L < pePS9) return; // shorter than a float32 ulp of the shape: not an edge
      let nx = -dy / L,
        ny = dx / L;
      const side = nx * (T[0] - P1[0]) + ny * (T[1] - P1[1]);
      if (side > 0 !== toward) {
        nx = -nx;
        ny = -ny;
      }
      // The normal describes the chord, which is all the ordering/orientation logic uses. `cp`, the CUBIC piece this
      // edge is a half-chord of (its four control points, fill on the left), lets a face's chain carry the piece's
      // arc instead (the cubic chain).
      chainEdges9.push(
        /** @type {any} */ (
          cp
            ? { p1: P1, p2: P2, nx, ny, cp, ownSide9: pairChain9 }
            : { p1: P1, p2: P2, nx, ny, ownSide9: pairChain9 }
        ),
      );
    };
    const qAt9 = chainQuadAt9; // rational-quad point at t
    for (const h9 of /** @type {Array<typeof hulls[number] & {_chainN9?:number}>} */ (hulls)) {
      if (h9.invis9) continue;
      const w9 = h9.w || 1;
      const m9 = qAt9(h9.a, h9.c, h9.b, w9, 0.5);
      const toward9 = (h9.sign || 1) >= 0; // convex: outward = toward ctrl
      // Bound polyline error by the hull sagitta. Power-of-two subdivision
      // keeps neighboring pieces stable under small geometry changes.
      const mx9 = (h9.a[0] + h9.b[0]) / 2,
        my9 = (h9.a[1] + h9.b[1]) / 2;
      const sag9 = Math.hypot(m9[0] - mx9, m9[1] - my9);

      //
      //     asset                     span/65536    absolute 0.00025      span/4096
      //     aacPointsRoute__SVG_FILL  0.00418  42   0.00276  29      0.00126   8
      //     glslEmuFidelity__SVG      0.00056 212   0.00063 224      0.00040 183
      //     lbTranslucentStripBlend   0.00140  92   0.00185 162      0.00074  52
      //     shapeAnimationMultiCurve  0.00218 614   0.00218 619      0.00213 593
      //     noAaStrokeCover grid_N    0.00006  56   0.00010  88      0.00004   8
      //
      // span/4096 puts the
      // chain within an EIGHTH OF A PIXEL of the curve at a 512-px raster.
      // __LB_HULL_TOL (absolute) and __LB_HULL_TOL_REL (a fraction of the extent) override the tolerance.
      const span9 = emSpan();
      const tol9 =
        mantleDebugHook('__LB_HULL_TOL') ||
        span9 * (mantleDebugHook('__LB_HULL_TOL_REL') || 2 ** -12);
      let n9 = 2;
      // The cap does not bind. n9 needs 64*sqrt(sag9/span9) to meet this budget and a hull's
      // sagitta never exceeds its own shape, so 64 is reached only by the bowiest hulls and the
      // budget is met there anyway. It stays as a work bound, not as a silent accuracy limit.
      while (n9 < (mantleDebugHook('__LB_HULL_CAP') || 64) && sag9 / (n9 * n9) > tol9) n9 *= 2;
      // MEASUREMENT HOOK (off unless a probe sets it): probes/lbEmTuned/_lbChainCover.mjs reads the
      // hull and the n it chose, to show how far this chain lands from the true curve.
      if (globalThis.__LB_HULLDUMP)
        globalThis.__LB_HULLDUMP({
          a: h9.a,
          c: h9.c,
          b: h9.b,
          w: w9,
          sign: h9.sign,
          sag: sag9,
          n: n9,
          span: span9,
          tol: tol9,
        });
      h9._chainN9 = n9; // provenance: the morph pair places these points on its destination
      let prev9 = h9.a;
      for (let i9 = 1; i9 <= n9; i9++) {
        const nxt9 = i9 === n9 ? h9.b : qAt9(h9.a, h9.c, h9.b, w9, i9 / n9);
        pushPE9(prev9, nxt9, h9.c, toward9);
        prev9 = nxt9;
      }
    }

    for (const c9 of /** @type {Array<typeof cubicRecs[number] & {_chainHull9?:boolean,_chainMid9?:number[]}>} */ (
      cubicRecs
    )) {
      //
      if (c9.invis9 || !c9.a || !c9.b || !c9.pts || c9.pts.length < 3) continue;
      //
      const outPt9 = (P1, P2) => {
        const dx9 = P2[0] - P1[0],
          dy9 = P2[1] - P1[1],
          L9 = Math.hypot(dx9, dy9) || 1;
        const nx9 = -dy9 / L9,
          ny9 = dx9 / L9;
        const mx9 = (P1[0] + P2[0]) / 2,
          my9 = (P1[1] + P2[1]) / 2,
          e9 = 1e-3 * L9;
        if (c9.inkLeft9 == null) return null;
        // (nx9, ny9) is the LEFT normal of P1 -> P2, which runs the piece's way: the air is on the right of
        // a piece whose ink is on its left.
        return c9.inkLeft9 ? [mx9 - nx9 * e9, my9 - ny9 * e9] : [mx9 + nx9 * e9, my9 + ny9 * e9];
      };
      const cp9 = c9.cp;
      if (cp9 && cp9.length === 4) {
        // Points ON the curve, exact (de Casteljau). The chain is the polyline a→m→b, and each
        // piece is oriented by a curve point strictly BETWEEN its own endpoints — which is off
        // that piece's chord, on the side the curve bulges. Using the fan triangle's middle
        // vertex instead can sit on the wrong side and flips the chain's outward normal.
        // A chain never lies inside the fill. a -> m -> b is on the AIR side of a concave
        // piece (the arc bulges into the ink) and on the INK side of a convex one, where it stands inside
        // the arc by up to a quarter of its half-arcs' sagitta -- 1.2 em on a quarter circle 32 em across,
        // and the interior's chain then clips real ink wherever it reaches the arc, at every joint. A
        // convex piece of a MORPH PAIR takes its CONTROL POLYGON instead, which holds the arc (a
        // Bezier lies in its hull) and leaves it along the end tangents, so near a joint it stands off by the square
        // of the distance.

        // Convex at every t, NOT AT THE SOURCE. A pair's chain points are lerped with the piece, and a piece that
        // straightens and turns concave through the morph (a flip) puts its control polygon INSIDE the arc on the
        // far side of the straight pose -- 116 ink pixels lost at the destination of the flip morph, where a -> m -> b
        // loses none. The polygon holds the arc on its ink side while both control points are on the AIR side of
        // the chord and it turns toward the ink at both of them (a convex hull whose air-side boundary is the
        // polygon). Each of the four is a cross product of two vectors that are each linear in t, so a quadratic
        // in t with an exact minimum over [0, 1]; a piece with any of them not strictly positive somewhere keeps
        // a -> m -> b, which is outside wherever the piece is concave.
        //
        // Which side is air comes from the piece's own ink probe (`inkLeft9`), as the chain edges' sides do (above).
        // The outline-wide shoelace sign that preceded it named the flip morph's ink side air, and every concave
        // piece took the polygon.
        let hullC9 = false;
        const cpD9 =
          c9.inkLeft9 == null
            ? null
            : !pairChain9
              ? mantleDebugHook('__LB_STATIC_HULL') === true
                ? cp9
                : null
              : opts.pairDstPiece9
                ? opts.pairDstPiece9(c9.ci9, c9.si9, c9.pi9)
                : null;
        if (cpD9) {
          // min over t in [0, 1] of s * cross(u(t), v(t)), u and v lerped from their source to their destination
          const crMin9 = (uS, uD, vS, vD, s) => {
            const cr = (u, v) => u[0] * v[1] - u[1] * v[0];
            const du = [uD[0] - uS[0], uD[1] - uS[1]],
              dv = [vD[0] - vS[0], vD[1] - vS[1]];
            const q0 = s * cr(uS, vS),
              q1 = s * (cr(uS, dv) + cr(du, vS)),
              q2 = s * cr(du, dv);
            let m = Math.min(q0, q0 + q1 + q2);
            const tv = q2 > 0 ? -q1 / (2 * q2) : -1;
            if (tv > 0 && tv < 1) m = Math.min(m, q0 + tv * (q1 + tv * q2));
            return m;
          };
          const d9 = (P, i, j) => [P[j][0] - P[i][0], P[j][1] - P[i][1]];
          const sT9 = c9.inkLeft9 ? 1 : -1; // a turn toward the ink; the air side of the chord is -sT9
          hullC9 =
            crMin9(d9(cp9, 0, 3), d9(cpD9, 0, 3), d9(cp9, 0, 1), d9(cpD9, 0, 1), -sT9) > 0 &&
            crMin9(d9(cp9, 0, 3), d9(cpD9, 0, 3), d9(cp9, 0, 2), d9(cpD9, 0, 2), -sT9) > 0 &&
            crMin9(d9(cp9, 0, 1), d9(cpD9, 0, 1), d9(cp9, 1, 2), d9(cpD9, 1, 2), sT9) > 0 &&
            crMin9(d9(cp9, 1, 2), d9(cpD9, 1, 2), d9(cp9, 2, 3), d9(cpD9, 2, 3), sT9) > 0;
        }
        c9._chainHull9 = hullC9; // provenance: a hull chain's points are the piece's own control points
        const ptsC9 = hullC9
          ? [c9.a, cp9[1], cp9[2], c9.b]
          : [c9.a, (c9._chainMid9 = chainMid9(cp9)), c9.b];
        // The chords a -> m -> b CARRY THEIR PIECE. On a concave piece they lie on the AIR side of the
        // arc and no polyline through a and b is exact; the piece's control points let a face's chain take the arc
        // itself (cubicChainBoxCov), and a face that does not keeps the chords.
        // ORIENTED BY THE PIECE'S own INK PROBE, fill on the left: the chain assembly orients an edge by the asking
        // face's centroid, which a chord far from that face can put on the wrong side, and an arc read backwards
        // is the complement of its ink.
        const pc9 =
          !hullC9 && lbCubicChainOn() && c9.inkLeft9 != null
            ? c9.inkLeft9
              ? [c9.a, cp9[1], cp9[2], c9.b]
              : [c9.b, cp9[2], cp9[1], c9.a]
            : null;
        const n0C9 = chainEdges9.length;
        for (let i9 = 1; i9 < ptsC9.length; i9++) {
          const oC9 = outPt9(ptsC9[i9 - 1], ptsC9[i9]);
          if (oC9) pushPE9(ptsC9[i9 - 1], ptsC9[i9], oC9, true, pc9);
        }
        // A probe's view of one piece's chain edges (lbStaticChainSmoke checks their sides against the exact winding).
        if (globalThis.__LB_CHAINEDGEDUMP)
          globalThis.__LB_CHAINEDGEDUMP({ cp: cp9, edges: chainEdges9.slice(n0C9) });
      } else {
        const o0 = outPt9(c9.a, c9.b);
        if (o0) pushPE9(c9.a, c9.b, o0, true);
      }
    }
    const coords9 = [],
      tris9 = [];
    for (let i9 = 0; i9 + 1 < interior.length; i9 += 2) {
      coords9.push([interior[i9], interior[i9 + 1]]);
      tris9.push(tris9.length);
    }
    let ch9 = interiorChainsFromTris(
      coords9,
      tris9,
      chainEdges9,
      allStraight9 ? inkAt : null,
      pairChain9,
    );
    // A FACE NEITHER CHAIN SERVES (`badFaces`: more outline than its two chains span, found by the chain builder) is split at its centroid into three faces, each of which reaches less of the
    // outline. The point is inside the face, so no edge is cut and no crack opens. A morph pair places it
    // on its destination as the centroid of the corners' images (lbPartitionPair): linear in the corners, so it is each
    // pose's centroid at every t. Up to three rounds: a face still bad after them is one the route may not draw (lbMorphCore). Not for a pair with a
    // concave quad hull: there a sub-face of a thick arc ring is left bare (lbPairQuadHullSplitSmoke).
    for (
      let rr9 = 0;
      rr9 < 3 && pairChain9 && hulls.every((h9) => !(h9.sign < 0)) && ch9.badFaces.some((x9) => x9);
      rr9++
    ) {
      const nI = [],
        split = [],
        keep = [];
      for (let f = 0; f < ch9.badFaces.length; f++) {
        const o = f * 6,
          ax = interior[o],
          ay = interior[o + 1],
          bx = interior[o + 2],
          by = interior[o + 3],
          cx = interior[o + 4],
          cy = interior[o + 5];
        if (!ch9.badFaces[f]) {
          keep.push([f, nI.length / 6]);
          nI.push(ax, ay, bx, by, cx, cy);
          continue;
        }
        const gx = Math.fround((ax + bx + cx) / 3),
          gy = Math.fround((ay + by + cy) / 3);
        centroids9.push({ pt: [gx, gy], a: [ax, ay], b: [bx, by], c: [cx, cy] });
        split.push(nI.length / 6);
        nI.push(ax, ay, bx, by, gx, gy, bx, by, cx, cy, gx, gy, cx, cy, ax, ay, gx, gy);
      }
      // The new faces' chains: every point goes in (a face's chain depends on the extent of all of them), only the new
      // faces are asked.
      const sc9 = [],
        st9 = [];
      for (let i9 = 0; i9 + 1 < nI.length; i9 += 2) sc9.push([nI[i9], nI[i9 + 1]]);
      for (const f of split) for (let k = 0; k < 9; k++) st9.push(f * 3 + k);
      const chS9 = interiorChainsFromTris(
        sc9,
        st9,
        chainEdges9,
        allStraight9 ? inkAt : null,
        pairChain9,
      );
      const nF = nI.length / 6,
        rows = (n) => new Float32Array(n * 12);
      const out = {
        chainA: rows(nF),
        chainB: rows(nF),
        chainC: rows(nF),
        chainD: rows(nF),
        chainE: rows(nF),
        incomplete: false,
        hasChain2: ch9.hasChain2 || chS9.hasChain2,
        hasCubicChain: ch9.hasCubicChain || chS9.hasCubicChain,
        badFaces: new Uint8Array(nF),
      };
      const put = (src, sf, df) => {
        for (const k of ['chainA', 'chainB', 'chainC', 'chainD', 'chainE'])
          out[k].set(src[k].subarray(sf * 12, sf * 12 + 12), df * 12);
        out.badFaces[df] = src.badFaces[sf];
        if (src.badFaces[sf]) out.incomplete = true;
      };
      for (const [f, nf] of keep) put(ch9, f, nf);
      split.forEach((nf, q) => {
        for (let k = 0; k < 3; k++) put(chS9, q * 3 + k, nf + k);
      });
      interior = nI;
      ch9 = out;
    }
    rowsPlan9 = {
      solid: new Float32Array(interior),
      solidEdges: null,
      solidEdges2: null,
      solidEdges3: null,
      curveTris: [],
      chains9: ch9,
    };
  } else {
    const chordArcs9 = new Map(),
      vertexArcs9 = new Map();
    const ck9 = (p) =>
      Math.round((p[0] - _kox) * _koScale) * 2097152 + Math.round((p[1] - _koy) * _koScale);
    for (const h9 of /** @type {Array<typeof hulls[number] & {_chainN9?:number}>} */ (hulls)) {
      if (h9.invis9) continue;
      const arc9 = { a: h9.a, ctrl: h9.c, b: h9.b, sign: h9.sign, w: h9.w || 1 };
      const ka9 = ck9(h9.a),
        kb9 = ck9(h9.b);
      chordArcs9.set(ka9 < kb9 ? ka9 + '|' + kb9 : kb9 + '|' + ka9, arc9);
      let la9 = vertexArcs9.get(ka9);
      if (!la9) vertexArcs9.set(ka9, (la9 = []));
      la9.push(arc9);
      let lb9 = vertexArcs9.get(kb9);
      if (!lb9) vertexArcs9.set(kb9, (lb9 = []));
      lb9.push(arc9);
    }
    // A cubic is a curve too. This map is what tells splitInteriorByCurve where the boundary
    // bends, and `hulls` alone does not hold a cubic segment -- it is in `cubicRecs`. Built
    // from `hulls` alone, the map for a shape made of cubics would be EMPTY: the split would
    // have nothing to split against and emit plain line rows, every interior face straddling the
    // boundary would paint SOLID through it, and the self-audit would decline the shape to Slug.
    //
    // Keyed on the piece's own chord (a,b), which IS a CDT edge; keying on the control points
    // matches no edge and changes nothing.
    // This is not the whole job: many boundary faces still miss the curve ramp, because
    // makeCurveTri requires a face to carry both of a chord's endpoints and a cubic fan's
    // sub-chords often share only one.
    for (const c9 of /** @type {Array<typeof cubicRecs[number] & {_chainHull9?:boolean,_chainMid9?:number[]}>} */ (
      cubicRecs
    )) {
      if (c9.invis9 || !c9.pts || !c9.rows || !c9.a || !c9.b) continue;
      const carc9 = {
        cubic: true,
        pts: c9.pts,
        rows: c9.rows,
        cp: c9.cp,
        sign: c9.sign || 1,
        w: 1,
        a: c9.a,
        b: c9.b,
      };
      const kca9 = ck9(c9.a),
        kcb9 = ck9(c9.b);
      const key9 = kca9 < kcb9 ? kca9 + '|' + kcb9 : kcb9 + '|' + kca9;
      if (!chordArcs9.has(key9)) chordArcs9.set(key9, carc9);
      let lca9 = vertexArcs9.get(kca9);
      if (!lca9) vertexArcs9.set(kca9, (lca9 = []));
      lca9.push(carc9);
      let lcb9 = vertexArcs9.get(kcb9);
      if (!lcb9) vertexArcs9.set(kcb9, (lcb9 = []));
      lcb9.push(carc9);
    }
    rowsPlan9 = splitInteriorByCurve(
      new Float32Array(interior),
      selfOrientRows(interiorEdgesFromTriPoints(new Float32Array(interior), edges), interior),
      chordArcs9,
      vertexArcs9,
      true,
      edges,
    );
    if (rowsPlan9.curveTris && rowsPlan9.curveTris.length)
      for (const ct9 of rowsPlan9.curveTris) {
        const H8 = ct9.hull || ct9.tri;
        if (H8 && H8.length >= 6 && airFace9([H8[0], H8[1]], [H8[2], H8[3]], [H8[4], H8[5]]))
          continue;
        (ct9.cubic ? cubics : quads).push(ct9);
      }
  }
  const meshD9 = {
    interior:
      rowsPlan9.solid instanceof Float32Array ? rowsPlan9.solid : new Float32Array(rowsPlan9.solid),
    interiorChainA: rowsPlan9.chains9 ? rowsPlan9.chains9.chainA : undefined,
    interiorChainB: rowsPlan9.chains9 ? rowsPlan9.chains9.chainB : undefined,
    interiorChainC: rowsPlan9.chains9 ? rowsPlan9.chains9.chainC : undefined,
    interiorChainD: rowsPlan9.chains9 ? rowsPlan9.chains9.chainD : undefined,
    interiorChainE: rowsPlan9.chains9 ? rowsPlan9.chains9.chainE : undefined,
    chainIncomplete9: !!(rowsPlan9.chains9 && rowsPlan9.chains9.incomplete), // a face has outline its two chains do not span (`badFaces`); see lbMorphCore
    interiorHasChain2: rowsPlan9.chains9 ? rowsPlan9.chains9.hasChain2 : undefined,
    interiorEdges:
      rowsPlan9.solidEdges == null
        ? null
        : rowsPlan9.solidEdges instanceof Float32Array
          ? rowsPlan9.solidEdges
          : new Float32Array(rowsPlan9.solidEdges),
    interiorEdges2: rowsPlan9.solidEdges2 ? new Float32Array(rowsPlan9.solidEdges2) : null,
    interiorEdges3: rowsPlan9.solidEdges3 ? new Float32Array(rowsPlan9.solidEdges3) : null,
    quads,
    cubics,
    edges,
    fallback: fallback9,
    stripArcs,
    _topo: null,
    _blendTier9: blendTier9, // audit-marginal: the pack keeps these shapes on blend compositing
    hulls9: hulls, // per-seg hull recs: the morph pair transform reframes tc against the DST hulls
    cubicRecs9: cubicRecs, // per-fan-tri cubic recs (cp + provenance) for the pair transform
    steiner9, // crossing-splitter Steiner points + parent coords
    centroids9, // the chain refinement's split points + their faces' corners
  };
  meshD9._route = 'partition-carve';
  // THE PROOF, INSTEAD OF THE SAMPLES.
  //
  // The over-paint audit takes ten points per piece and declines the whole shape if any of them
  // paints air. It is a sampler: it misses real over-paint, and it objects MORE as pieces
  // multiply, which is what stops the containment work from paying. A face can be proved instead.
  // For one face carrying one curve's implicit f:
  //
  //   (1) CONTAINMENT -- no other part of the outline lies inside it, so the shape's ink there is
  //       exactly one side of this arc.
  //   (2) If the face holds the arc, f < 0 is that ink side and the face is sound; a second
  //       branch running alongside the arc only disturbs the antialiased band.
  //   (3) If it does NOT hold the arc, containment makes the face uniformly ink or air. Ink is
  //       interior and fine. Air is fine too unless f is negative somewhere in it -- and f along
  //       a face edge is a univariate cubic whose roots are exact, so "does it paint here" is
  //       answered rather than sampled.
  //
  if (declineAudit9) {
    const _pf9 = (w) => {
      if (typeof globalThis !== 'undefined' && globalThis.__lbProofTrace)
        globalThis.__lbProofWhy = w;
      return false;
    };
    const proved9 = (() => {
      const list9 = meshD9.cubics;
      if (!list9 || !list9.length) return _pf9('no curve faces');
      const samp9 = [];
      for (const o9 of allSegs) {
        // The segment's own curve, for the same reason as the split driver above: a quadratic
        // and an arc are the rational quadratic over their own three points, not the chord from
        // the start point to their control point. LINE sampling is unchanged.
        const cub9 = !!o9.p4,
          qd9 = !cub9 && !!o9.p3;
        const cp9 = cub9
          ? [o9.p1, o9.p2, o9.p3, o9.p4]
          : [o9.p1, o9.p1, o9.p2 || o9.p1, o9.p2 || o9.p1];
        const qw9 = qd9 && o9.type === SEG_RQUAD ? o9.w || 1 : 1;
        for (let k9 = 0; k9 <= 32; k9++) {
          const q9 = qd9 ? rquadPt(o9.p1, o9.p2, o9.p3, qw9, k9 / 32) : cubicPt(cp9, k9 / 32);
          samp9.push(q9[0], q9[1], o9);
        }
      }
      for (const c9 of list9) {
        const H9 = c9.hull;
        if (!H9 || H9.length < 6 || !c9.cp) return _pf9('face has no curve provenance');
        const A9 = [H9[0], H9[1]],
          B9 = [H9[2], H9[3]],
          C9 = [H9[4], H9[5]];
        const chord9 = Math.hypot(c9.cp[3][0] - c9.cp[0][0], c9.cp[3][1] - c9.cp[0][1]);
        if (!(chord9 > 0)) return _pf9('degenerate chord');
        const arc9 = [];
        for (let u9 = 0; u9 <= 1.0001; u9 += 1 / 48) arc9.push(cubicPt(c9.cp, u9));
        const sd9 = (P9, Q9, x9, y9) =>
          (Q9[0] - P9[0]) * (y9 - P9[1]) - (Q9[1] - P9[1]) * (x9 - P9[0]);
        // The face's own bbox, so a sample far from this triangle costs four compares instead of
        // three cross products. A point outside the bbox is outside the triangle, so inFace9 would
        // have said no; NaN fails every compare and falls through to the full test as before.
        const fbx09 = Math.min(A9[0], B9[0], C9[0]),
          fbx19 = Math.max(A9[0], B9[0], C9[0]);
        const fby09 = Math.min(A9[1], B9[1], C9[1]),
          fby19 = Math.max(A9[1], B9[1], C9[1]);
        const outBox9 = (x9, y9) => x9 < fbx09 || x9 > fbx19 || y9 < fby09 || y9 > fby19;
        const inFace9 = (x9, y9) => {
          if (outBox9(x9, y9)) return false;
          const u9 = sd9(A9, B9, x9, y9),
            v9 = sd9(B9, C9, x9, y9),
            w9 = sd9(C9, A9, x9, y9);
          return (u9 >= 0 && v9 >= 0 && w9 >= 0) || (u9 <= 0 && v9 <= 0 && w9 <= 0);
        };

        const fex9 =
          Math.max(
            Math.abs(H9[0] - H9[2]),
            Math.abs(H9[2] - H9[4]),
            Math.abs(H9[4] - H9[0]),
            Math.abs(H9[1] - H9[3]),
            Math.abs(H9[3] - H9[5]),
            Math.abs(H9[5] - H9[1]),
          ) || chord9;
        const e0x9 = c9.cp[0][0],
          e0y9 = c9.cp[0][1],
          e1x9 = c9.cp[3][0],
          e1y9 = c9.cp[3][1];
        const jt29 = 2e-2 * fex9 * (2e-2 * fex9); // the joint whisker, squared
        for (let i9 = 0; i9 < samp9.length; i9 += 3) {
          if (samp9[i9 + 2] === c9.seg9) continue;
          const qx9 = samp9[i9],
            qy9 = samp9[i9 + 1];
          if (!inFace9(qx9, qy9)) continue;
          const j0x9 = qx9 - e0x9,
            j0y9 = qy9 - e0y9;
          if (j0x9 * j0x9 + j0y9 * j0y9 < jt29) continue; // squared, as above
          const j1x9 = qx9 - e1x9,
            j1y9 = qy9 - e1y9;
          if (j1x9 * j1x9 + j1y9 * j1y9 < jt29) continue;
          return _pf9('another boundary inside the face');
        }
        let arcIn9 = false;
        for (const q9 of arc9)
          if (inFace9(q9[0], q9[1])) {
            arcIn9 = true;
            break;
          }
        if (arcIn9) continue; // (2)
        // (3) the face holds no arc: uniformly ink, or air that must not paint.
        const fAt9 = c9.klmn
          ? (() => {
              const e1x = H9[2] - H9[0],
                e1y = H9[3] - H9[1],
                e2x = H9[4] - H9[0],
                e2y = H9[5] - H9[1];
              const det9 = e1x * e2y - e1y * e2x;
              if (!(Math.abs(det9) > 0)) return null;
              const T9 = c9.klmn;
              return (x9, y9) => {
                const w19 = ((x9 - H9[0]) * e2y - (y9 - H9[1]) * e2x) / det9;
                const w29 = (e1x * (y9 - H9[1]) - e1y * (x9 - H9[0])) / det9;
                const w09 = 1 - w19 - w29;
                const K9 = w09 * T9[0] + w19 * T9[3] + w29 * T9[6];
                const L9 = w09 * T9[1] + w19 * T9[4] + w29 * T9[7];
                const M9 = w09 * T9[2] + w19 * T9[5] + w29 * T9[8];
                return c9.sign * (K9 * K9 * K9 - L9 * M9);
              };
            })()
          : c9.F
            ? (x9, y9) => c9.sign * evalBezout(c9.F, x9, y9)
            : null;
        if (!fAt9) return _pf9('no implicit');
        // The same exact test the drop uses. Asking this with a sampled grid while the drop asks
        // it exactly makes the two disagree: a face the drop keeps (the boundary crosses it) the
        // proof calls all-air and declines the shape for. One definition, used by both.
        if (!airFace9(A9, B9, C9)) continue;
        let paints9 = false;
        for (let a9 = 1; a9 < 6 && !paints9; a9++)
          for (let b9 = 1; b9 < 6 - a9; b9++) {
            const u0 = a9 / 6,
              u1 = b9 / 6,
              u2 = 1 - u0 - u1;
            if (
              fAt9(u0 * A9[0] + u1 * B9[0] + u2 * C9[0], u0 * A9[1] + u1 * B9[1] + u2 * C9[1]) < 0
            ) {
              paints9 = true;
              break;
            }
          }
        if (paints9) return _pf9('an all-air face that paints');
        // No ink and no sample painting: an edge root would still admit a sliver that paints.
        for (const [P9, Q9] of [
          [A9, B9],
          [B9, C9],
          [C9, A9],
        ]) {
          const g9 = (t9) => fAt9(P9[0] + t9 * (Q9[0] - P9[0]), P9[1] + t9 * (Q9[1] - P9[1]));
          const f09 = g9(0),
            f19 = g9(1 / 3),
            f29 = g9(2 / 3),
            f39 = g9(1);
          const aa9 = (-9 * f09 + 27 * f19 - 27 * f29 + 9 * f39) / 2;
          const bb9 = (18 * f09 - 45 * f19 + 36 * f29 - 9 * f39) / 2;
          const cc9 = (-11 * f09 + 18 * f19 - 9 * f29 + 2 * f39) / 2;
          if (!(Math.max(Math.abs(aa9), Math.abs(bb9), Math.abs(cc9), Math.abs(f09)) > 0)) continue;
          if (rootsInUnit(aa9, bb9, cc9, f09).length) return _pf9('f vanishes in an all-air face');
        }
      }
      return true;
    })();
    if (!proved9) return _lbDecline('coverage-audit');
  }
  //
  // LAST, so the coverage audit above judges the faces the CARVE produced. Splitting them is
  // exact (see conformMeshFaces) and cannot turn a proved face into an unproved one — a piece of
  // a face contains no boundary its parent did not — but it would multiply the sampler's work
  // and it is not what the proof is about.
  conformMeshFaces(meshD9);
  //
  dropCollapsedCubics9(meshD9.cubics, opts);
  // TEST HOOK (under __MANTLE_DEBUG__): the finished crescent faces with the outline and the exact ink test they were
  const tap9 = mantleDebugHook('__LB_FACE_TAP');
  if (typeof tap9 === 'function') tap9({ cubics: meshD9.cubics, allSegs, inkAt, evenodd });
  return meshD9;
}
