// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchGraph.js — the front of the CPatch conversion pipeline: turn a path's raw
// subpaths into clean, uniformly-filled CYCLES before any patching happens.

// Three stages, matching the paper:
//
//   flattenGraph   compute every curve-curve intersection and break curves at them,
//                  so no edge crosses another and overlaps become shared nodes
//   scoreFill      shoot two rays per edge (normal, at the midpoint) and record the
//                  fill on each side; an edge with the same fill on both sides is not
//                  a boundary of anything and is removed
//   extractCycles  walk the surviving edges, at each node taking the smallest
//                  outgoing angle on the filled side, until the walk closes
//
// Output is cycles in the converter's own {t, P} form, ready for convertContour.
import { intersectSegments } from '../svg/pathBoolean/intersect/index.js';
import {
  segSlice,
  segPt,
  segTangent,
  segStart,
  segEnd,
  segRev,
  segImplicit,
  implAlongSeg,
  bezRoots01,
  affRootsOnSeg,
  isRat,
  segTightBBox,
} from './cpatchImplicit.js';
import { cubicLoopCuts } from './lbCubicMath.js';
import { mantleDebugHook } from '../core/diagnostics.js';

const T_TO_SEG = { line: 0, quad: 1, cubic: 2, rquad: 4 };
/// The intersection kernels speak the importer's seg shape; the converter speaks
/// {t, P}. One adapter rather than two parallel representations.
const toLB = (s) => ({
  type: T_TO_SEG[s.t],
  p1: s.P[0],
  p2: s.P[1],
  p3: s.P[2],
  p4: s.P[3],
  w: s.w,
});

const EPS = 1e-7;
const key2 = (p) => `${Math.round(p[0] / EPS)},${Math.round(p[1] / EPS)}`;

/// Break every curve at every intersection with every other curve, including
/// self-intersections. Returns flat edge records; nodes are de-duplicated by
/// position so two curves meeting anywhere become one node.
/// Bezout's bound for two cubics: nine. A longer intersection list means the pair coincides rather
/// than crosses, and there is nothing to cut at.
const MAX_PAIR_HITS = 9;
/// The Bezier clipper's own window for "the same root" (DEDUPE_T in svg/pathBoolean/bezierClip.js).
const CLIP_SAME_ROOT = 1e-4;
/// The winding walk's hair, as a fraction of `reach` (twice the geometry's diagonal). Chosen so
/// that on the ~900-unit artwork these tests were tuned on it is the 1e-9 they were tuned to, and
/// every other size then gets the same test rather than a harsher or a laxer one.
const RAY_EPS_REL = 1e-9 / 2546;

const _sameP = (u, v) => {
  if (!u || !v) return false;
  // No constant term. The sum of the magnitudes IS the scale here, and it already scales with the
  // drawing; the `+ 1` only takes over below unit size, which turns the relative test the comment
  // above argues for back into an absolute one exactly where it matters most.
  const e = 1e-12 * (Math.abs(u[0]) + Math.abs(u[1]) + Math.abs(v[0]) + Math.abs(v[1]));
  return Math.abs(u[0] - v[0]) <= e && Math.abs(u[1] - v[1]) <= e;
};
function degenerateSeg(sg) {
  const P = sg && sg.P;
  if (!P || P.length < 2) return true;
  const a = P[0],
    b = P[P.length - 1];
  if (sg.t === 'cubic') return _sameP(a, b) && _sameP(a, P[1]) && _sameP(a, P[2]);
  return _sameP(a, b);
}

/// `cutsIn` -- the cut parameters per segment a previous flatten of the same geometry produced
/// (`cutsOut` collects them) -- skips the pairwise intersection sweep, which is nearly all of the
/// front end's time and whose result is a few float64s per crossing. Everything after the sweep
/// is a deterministic function of those parameters, so the graph, and the cycles, come out
/// bit-identical. A list of the wrong length is not for this geometry and is ignored.
function boxesOverlap(a, b) {
  let ax0 = Infinity,
    ay0 = Infinity,
    ax1 = -Infinity,
    ay1 = -Infinity,
    bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const p of a.P) {
    if (p[0] < ax0) ax0 = p[0];
    if (p[0] > ax1) ax1 = p[0];
    if (p[1] < ay0) ay0 = p[1];
    if (p[1] > ay1) ay1 = p[1];
  }
  for (const p of b.P) {
    if (p[0] < bx0) bx0 = p[0];
    if (p[0] > bx1) bx1 = p[0];
    if (p[1] < by0) by0 = p[1];
    if (p[1] > by1) by1 = p[1];
  }
  const e = 1e-9 * Math.max(ax1 - ax0, ay1 - ay0, bx1 - bx0, by1 - by0);
  return !(ax1 < bx0 - e || bx1 < ax0 - e || ay1 < by0 - e || by1 < ay0 - e);
}

/// Crossings of two curves by exact IMPLICIT COMPOSITION: the zeros of f_a along b and of f_b
/// along a, paired by position, then polished on the pair (Gauss-Newton on a(t) = b(u), with a
/// projection fallback where the curves are near-tangent and the system near-singular). Only
/// crossings the clipper's `known` list does not already hold are returned. A pair that will
/// not close to machine precision is a tangency, not a crossing, and is left out.
/// Do the convex hulls of two control polygons overlap? Separating-axis test over both polygons'
/// edge normals: exact for convex sets, and a Bezier lies inside its control hull, so two curves
/// whose hulls are disjoint cannot cross. Cheap, and it is what keeps the exact test affordable:
/// boxes overlap for most diagonal neighbors whose hulls do not, and the composition it saves
/// costs a thousand times more.
export function hullsOverlap(P, Q) {
  const axes = (R, out) => {
    for (let i = 0, n = R.length; i < n; i++) {
      const A = R[i],
        B = R[(i + 1) % n];
      const nx = -(B[1] - A[1]),
        ny = B[0] - A[0];
      if (nx !== 0 || ny !== 0) out.push(nx, ny);
    }
  };
  const ax = [];
  axes(P, ax);
  axes(Q, ax);
  for (let k = 0; k < ax.length; k += 2) {
    const nx = ax[k],
      ny = ax[k + 1];
    let p0 = Infinity,
      p1 = -Infinity,
      q0 = Infinity,
      q1 = -Infinity;
    for (const p of P) {
      const v = p[0] * nx + p[1] * ny;
      if (v < p0) p0 = v;
      if (v > p1) p1 = v;
    }
    for (const q of Q) {
      const v = q[0] * nx + q[1] * ny;
      if (v < q0) q0 = v;
      if (v > q1) q1 = v;
    }
    const e = 1e-12 * (Math.abs(p0) + Math.abs(p1) + Math.abs(q0) + Math.abs(q1));
    if (p1 < q0 - e || q1 < p0 - e) return false;
  }
  return true;
}

/// `wide` asks for the crossings the established pairing can lose (see the seeds below); it is for a caller that checks what it builds.
export function exactCrossings(a, b, known, wide = false) {
  if (!hullsOverlap(a.P, b.P)) return null;
  const fa = segImplicit(a),
    fb = segImplicit(b);
  if (!fa || !fb) return null;
  let tb, ta;
  try {
    tb = bezRoots01(implAlongSeg(fa, b));
    ta = bezRoots01(implAlongSeg(fb, a));
    if (wide ? !tb.length && !ta.length : !tb.length || !ta.length) return null;
  } catch {
    return null;
  }
  // TOLERANCES SCALE WITH THE PAIR'S EXTENT, NOT ITS POSITION. Relative to the coordinates'
  // magnitude they grew with the offset of a shape, and a glyph-scale contour (bumps 0.004
  // apart) at x = 12 paired roots of different crossings, cut a phantom one in, and meshed
  // differently from the same glyph at the origin (lbTranslationInvarianceSmoke). The
  // floating-point floor is the only thing that legitimately depends on magnitude.
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    mag = 0;
  for (const p of a.P) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
    mag = Math.max(mag, Math.abs(p[0]), Math.abs(p[1]));
  }
  for (const p of b.P) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
    mag = Math.max(mag, Math.abs(p[0]), Math.abs(p[1]));
  }
  const ext = Math.max(x1 - x0, y1 - y0);
  if (!(ext > 0)) return null;
  const extOf = (S) => {
    let u0 = Infinity,
      v0 = Infinity,
      u1 = -Infinity,
      v1 = -Infinity;
    for (const p of S.P) {
      if (p[0] < u0) u0 = p[0];
      if (p[0] > u1) u1 = p[0];
      if (p[1] < v0) v0 = p[1];
      if (p[1] > v1) v1 = p[1];
    }
    return Math.max(u1 - u0, v1 - v0);
  };
  const extA = extOf(a),
    extB = extOf(b);

  const fpFloor = 4e-15 * mag;
  const pairEps = 1e-3 * ext,
    closeEps = Math.max(1e-12 * ext, fpFloor),
    touchEps = Math.max(1e-9 * ext, 8 * fpFloor);
  // Gauss-Newton on a(t) = b(u) from (t, u): where it closes to closeEps, or null when it leaves the curves.
  const polish = (t, u) => {
    for (let it = 0; it < 24; it++) {
      const A = segPt(a, t),
        B = segPt(b, u);
      const rx = A[0] - B[0],
        ry = A[1] - B[1];
      if (Math.hypot(rx, ry) < closeEps) break;
      const da = segTangent(a, t),
        db = segTangent(b, u);
      const det = da[0] * -db[1] - da[1] * -db[0];
      if (Math.abs(det) > 1e-12 * (Math.hypot(da[0], da[1]) * Math.hypot(db[0], db[1]) + 1e-300)) {
        // J = [da, -db]; solve J [dt du]^T = -r
        const dt = (-rx * -db[1] - -ry * -db[0]) / det;
        const du = (da[0] * -ry - da[1] * -rx) / det;
        t += dt;
        u += du;
      } else {
        // near-tangent: alternate projections, each a 1-D Newton step on the other curve
        const la = da[0] * da[0] + da[1] * da[1],
          lb = db[0] * db[0] + db[1] * db[1];
        if (la > 0) t -= (rx * da[0] + ry * da[1]) / la;
        const A2 = segPt(a, t),
          B2 = segPt(b, u);
        if (lb > 0) u += ((A2[0] - B2[0]) * db[0] + (A2[1] - B2[1]) * db[1]) / lb;
      }
      if (!(t > -0.5 && t < 1.5 && u > -0.5 && u < 1.5)) return null;
    }
    return [t, u];
  };
  const out = [];
  // THE TWO ROOT SETS ARE each A SEED, not one the other's partner. An implicit that vanishes to even order along a curve (a cubic
  // with a repeated control point) meets a crossing as a DOUBLE root of its composition, whose sign never changes and which the
  // solver loses to rounding in some copies of a drawing and not in others, though the other composition holds the crossing as a
  // simple root. And a crossing a hair from a shared vertex pairs, by position within reach, with the vertex's own root and is
  // never polished. So the pairing by position stays (it is the established seed), and every root also seeds the polish from
  // the nearest point of the other curve; crossings that two seeds reach are one.
  const nearest = (S, pt) => {
    let bu = 0,
      bdist = Infinity;
    for (let k = 0; k <= 32; k++) {
      const q = segPt(S, k / 32);
      const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
      if (d < bdist) {
        bdist = d;
        bu = k / 32;
      }
    }
    return bu;
  };
  const seeds = [];
  for (const u0 of tb) {
    const p = segPt(b, u0);
    let t0 = -1,
      bd = Infinity;
    for (const t1 of ta) {
      const q = segPt(a, t1);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        t0 = t1;
      }
    }
    if (t0 >= 0 && bd <= pairEps) seeds.push([t0, u0, true]);
  }
  if (wide) {
    for (const u0 of tb) seeds.push([nearest(a, segPt(b, u0)), u0, false]);
    for (const t1 of ta) seeds.push([t1, nearest(b, segPt(a, t1)), false]);
  }
  // Every seed is polished first; seeds that reach one crossing keep the closest-fitting result, so a hit the clipper already holds
  // is corrected by the best root and never by a worse seed's.
  // A seed the established pairing did not give is believed only where the curves CROSS: two curves that coincide over an interval
  // (a contour that retraces itself) polish from any seed to some point of the overlap, and a tangent contact is no crossing. The
  // crossing's sine must clear what the position can be known to, the square root of the arithmetic's epsilon (dimensionless).
  const transversal = (t, u) => {
    const da = segTangent(a, t),
      db = segTangent(b, u);
    const la = Math.hypot(da[0], da[1]),
      lb = Math.hypot(db[0], db[1]);
    return (
      la > 0 &&
      lb > 0 &&
      Math.abs(da[0] * db[1] - da[1] * db[0]) > Math.sqrt(Number.EPSILON) * la * lb
    );
  };
  const cands = [];
  for (const [t0, u0, established] of seeds) {
    const tu = polish(t0, u0);
    if (!tu) continue;
    const Ag = segPt(a, tu[0]),
      Bg = segPt(b, tu[1]),
      gap = Math.hypot(Ag[0] - Bg[0], Ag[1] - Bg[1]);
    const dup = cands.find((c) => Math.abs(c[0] - tu[0]) <= 1e-7 && Math.abs(c[1] - tu[1]) <= 1e-7);
    if (!dup) {
      if (established || transversal(tu[0], tu[1])) cands.push([tu[0], tu[1], gap]);
    } else if (gap < dup[2]) {
      dup[0] = tu[0];
      dup[1] = tu[1];
      dup[2] = gap;
    }
  }
  for (const [t, u] of cands) {
    const A = segPt(a, t),
      B = segPt(b, u);
    if (Math.hypot(A[0] - B[0], A[1] - B[1]) > touchEps) continue; // a touch, not a crossing
    if (!(t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS)) continue;
    const X = (A[0] + B[0]) / 2,
      Y = (A[1] + B[1]) / 2;
    // DEDUPLICATE against the segments' own ends and against the clipper's hits. A vertex is
    // already a node: nothing to cut. The clipper reports a crossing at a vertex with snapped
    // parameters (0.2000/0.0000 for a hit that is really 1.0/0.0 on a glyph-scale quad), and letting
    // that through twice split position-dependently and changed a Loop-Blinn mesh with the shape's
    // offset (lbTranslationInvarianceSmoke).

    const within = (p, e) => Math.abs(p[0] - X) <= e && Math.abs(p[1] - Y) <= e;
    const endA = Math.max(1e-6 * extA, touchEps),
      endB = Math.max(1e-6 * extB, touchEps);
    if (
      within(a.P[0], endA) ||
      within(a.P[a.P.length - 1], endA) ||
      within(b.P[0], endB) ||
      within(b.P[b.P.length - 1], endB)
    )
      continue;

    if (known && known.length) {
      const da = segTangent(a, t),
        db = segTangent(b, u);
      const sa = Math.hypot(da[0], da[1]),
        sb = Math.hypot(db[0], db[1]);
      const isThis = (h) => {
        if (!(Math.abs(h.tA - t) <= CLIP_SAME_ROOT && Math.abs(h.tB - u) <= CLIP_SAME_ROOT))
          return false;
        const q = polish(h.tA, h.tB);
        if (!q) return false;
        const Ah = segPt(a, q[0]),
          Bh = segPt(b, q[1]);
        return (
          Math.hypot(Ah[0] - Bh[0], Ah[1] - Bh[1]) <= touchEps &&
          within(Ah, touchEps) &&
          Math.abs(q[0] - t) * sa <= touchEps &&
          Math.abs(q[1] - u) * sb <= touchEps
        );
      };
      const hit = known.find(isThis);
      if (hit) {
        //
        // It is a substitution and not an extra crossing: the hit object IS what flattenGraph
        // reads, so overwriting it in place is the whole change.

        if (globalThis.__CP_CROSS_AUDIT) {
          const Ah = segPt(a, hit.tA),
            Bh = segPt(b, hit.tB);
          globalThis.__CP_CROSS_AUDIT.push({
            ext,
            extA,
            extB,
            touchEps,
            dtA: Math.abs(hit.tA - t),
            dtB: Math.abs(hit.tB - u),
            // How far apart the two curves' own cut points are -- the gap the exact root closes.
            gapHit: Math.hypot(Ah[0] - Bh[0], Ah[1] - Bh[1]),
            gapExact: Math.hypot(A[0] - B[0], A[1] - B[1]),
            // And how far the hit's cut lands from the exact one, along each curve.
            moveA: Math.abs(hit.tA - t) * sa,
            moveB: Math.abs(hit.tB - u) * sb,
          });
        }
        hit.tA = t;
        hit.tB = u;
        hit.x = X;
        hit.y = Y;
        continue;
      }
    }
    out.push({ tA: t, tB: u, x: X, y: Y });
  }
  return out;
}

export function flattenGraph(contours, cutsIn, cutsOut, wide = false) {
  const segs = [];
  for (const c of contours) for (const s of c) segs.push(s);
  const n = segs.length;
  if (!n) return { edges: [], nodes: [] };
  const baked = !!(cutsIn && cutsIn.length === n);

  // Cut parameters per segment, endpoints excluded (they are already nodes).
  // Each segment's own extent, for the endpoint test below: the question "is this cut at the end"
  // is about this curve, so the scale has to be this curve's, not the drawing's.
  const segExt = segs.map((sg) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const q of sg.P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    return Math.hypot(x1 - x0, y1 - y0);
  });
  const atEnd = (k, t) => {
    const e = segExt[k];
    if (!(e > 0)) return false;
    const tol = 1e-6 * e;
    const p = segPt(segs[k], t),
      a = segPt(segs[k], 0),
      b = segPt(segs[k], 1);
    return (
      Math.hypot(p[0] - a[0], p[1] - a[1]) <= tol || Math.hypot(p[0] - b[0], p[1] - b[1]) <= tol
    );
  };
  const cuts = segs.map(() => []);
  // A CURVE CAN CROSS ITSELF, and the pairwise sweep below never compares a segment
  // with itself. A looped cubic passes through its own double point, so the cycle walk
  // would run past that crossing as if it were interior and extract a figure-eight —
  // one "cycle" enclosing two regions of opposite handedness. Split it at the double
  // point and each lobe becomes its own cycle. cubicLoopCuts returns [] for
  // serpentines and cusps, so this costs nothing on curves that do not loop.
  const loopPair = new Map(); // segment index → the two double-point params
  for (let i = 0; i < n; i++) {
    if (segs[i].t !== 'cubic') continue;
    let ts = null;
    try {
      ts = cubicLoopCuts(segs[i].P);
    } catch {
      ts = null;
    }
    if (!ts) continue;
    const inside = ts.filter((t) => t > EPS && t < 1 - EPS).sort((a, b) => a - b);
    if (!baked) for (const t of inside) cuts[i].push(t);
    if (inside.length === 2) loopPair.set(i, inside);
  }
  if (baked) for (let i = 0; i < n; i++) cuts[i] = cutsIn[i] ? cutsIn[i].slice() : [];
  for (let i = 0; i < n && !baked; i++) {
    for (let j = i + 1; j < n; j++) {
      // A degenerate segment is never handed to the intersector. intersectSegments does not return
      // on one — it exhausts memory rather than spinning. The case a real asset carries is a quad whose THREE control points are identical, a literal
      // point, immediately followed by an ordinary cubic starting at that same point. Either
      // segment alone flattens in about a millisecond; the pair together exhausts memory, and the
      // whole contour flattens in milliseconds once the pair is skipped.
      //
      // A SPIKE IS NOT THE same THING, and the difference matters enough to state: a quad with
      // coincident endpoints but a distinct control point is handled by the intersector unaided, as
      // is one whose endpoints are merely close (tested from 1e-12 to 1e-2 apart, all under a
      // millisecond). A test that assumes the two are the same passes with this guard removed;
      // test/graphDegenerateSmoke.mjs uses the real coordinates.
      //
      //
      // Skipping is correct, not merely safe. A zero-area segment has no isolated crossing to
      // contribute — a line or quad whose endpoints coincide retraces itself, B(t) = B(1-t) — so
      // there is nowhere to cut. A CUBIC with coincident endpoints is a genuine loop with area and
      // is left alone unless all four control points collapse.
      //
      // AND IT BELONGS HERE, at the graph, rather than in the callers that drop such segments
      // before packing: a MORPH deliberately KEEPS one, because correspondence between poses is
      // positional and dropping it on the side where it collapses misaligns the pairing. The graph
      // is the shared choke point, so guarding it protects every route in — the morph route
      // included, which a caller-side drop by construction cannot.
      if (degenerateSeg(segs[i]) || degenerateSeg(segs[j])) continue;
      let hits = null;
      try {
        hits = intersectSegments(toLB(segs[i]), toLB(segs[j]));
      } catch {
        hits = null;
      }
      // TWO CURVES CROSS AT POINTS, OR THEY COINCIDE. Two Beziers of degree <= 3 meet in at most 9
      // points by Bezout, so a longer list is not a crossing count — it is a CONTINUUM being
      // sampled, which is what a pair of overlapping collinear curves produces. Taking those cuts
      // would make this function allocate without bound: a zero-length quad, a spike that doubles
      // back along its neighbor, runs pathToCycles out of memory on a contour that takes
      // milliseconds without it.
      //
      // It belongs HERE, at the graph's own boundary, and not in the callers that drop degenerate
      // segments before packing: a MORPH deliberately KEEPS such a segment, because correspondence
      // between poses is positional and dropping it on one side misaligns the pairing.
      if (hits && hits.length > MAX_PAIR_HITS) hits = null;

      // Polish line-curve crossings too, so both cut pieces share one arrangement node.
      if (!(segs[i].t === 'line' && segs[j].t === 'line') && boxesOverlap(segs[i], segs[j])) {
        const extra = exactCrossings(segs[i], segs[j], hits, wide);
        if (extra && extra.length) hits = (hits || []).concat(extra);
      }
      if (!hits || !hits.length) continue;
      for (const h of hits) {
        //
        // In SPACE the decision is not close at all: that cut sits 6e-8 of the segment's extent
        // from its end, while the nearest genuine cut on this contour is 0.03 of it. Five orders of
        // magnitude of daylight, so any threshold in between decides the same way on both ports and
        // no solver noise can flip it.

        if (h.tA > EPS && h.tA < 1 - EPS && !atEnd(i, h.tA)) cuts[i].push(h.tA);
        if (h.tB > EPS && h.tB < 1 - EPS && !atEnd(j, h.tB)) cuts[j].push(h.tB);
      }
    }
  }
  if (cutsOut) for (let i = 0; i < n; i++) cutsOut.push(cuts[i].slice());

  let gx0 = Infinity,
    gy0 = Infinity,
    gx1 = -Infinity,
    gy1 = -Infinity;
  for (const sg of segs)
    for (const q of sg.P) {
      if (q[0] < gx0) gx0 = q[0];
      if (q[0] > gx1) gx1 = q[0];
      if (q[1] < gy0) gy0 = q[1];
      if (q[1] > gy1) gy1 = q[1];
    }

  const tol = 1e-11 * (Math.hypot(gx1 - gx0, gy1 - gy0) || 1);
  const nodes = [],
    buckets = new Map();
  // Numeric bucket keys. The cell coordinates run to 1e13 at this tolerance, so a string key would
  // be built for every lookup, nine per node, making this merge a large share of a prebaked build.
  // A hash of the pair may collide across distant cells; that only adds candidates, and every
  // candidate is verified by distance, so the merge is exactly the one the strings gave.
  const cellKey = (cx, cy) =>
    (Math.imul(cx | 0, 73856093) ^
      Math.imul(cy | 0, 19349663) ^
      Math.imul((cx / 4294967296) | 0, 83492791) ^
      Math.imul((cy / 4294967296) | 0, 49979687)) |
    0;
  const nodeOf = (p) => {
    const cx = Math.round(p[0] / tol),
      cy = Math.round(p[1] / tol);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const b = buckets.get(cellKey(cx + dx, cy + dy));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const q = nodes[b[i]];
          if (Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol) return b[i];
        }
      }
    const id = nodes.length;
    nodes.push(p);
    const k = cellKey(cx, cy);
    const b = buckets.get(k);
    if (b) b.push(id);
    else buckets.set(k, [id]);
    return id;
  };

  const edges = [];
  for (let i = 0; i < n; i++) {
    // Deduplicate on the parameter grid but slice at the retained actual root.
    // Rounding the cut itself separates the two sides of a crossing.
    const ts = [],
      seenCut = new Set();
    for (const t of cuts[i].slice().sort((a, b) => a - b)) {
      const key = Math.round(t / EPS);
      if (seenCut.has(key)) continue;
      seenCut.add(key);
      ts.push(t);
    }
    let prev = 0;
    const pieces = [];
    for (const t of ts) {
      if (t - prev > 1e-5) {
        pieces.push(segSlice(segs[i], prev, t));
        prev = t;
      }
    }
    pieces.push(prev > 0 ? segSlice(segs[i], prev, 1) : segs[i]);

    const lp = loopPair.get(i);
    if (lp && pieces.length >= 3) {
      const a = segEnd(pieces[0]),
        b = segStart(pieces[2]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      pieces[0].P[pieces[0].P.length - 1] = mid;
      pieces[1].P[0] = mid;
      pieces[1].P[pieces[1].P.length - 1] = mid;
      pieces[2].P[0] = mid;
    }
    for (const pc of pieces) {
      const a = nodeOf(segStart(pc)),
        b = nodeOf(segEnd(pc));
      if (a === b) {
        // A piece whose ends meet is either a genuine CLOSED sub-curve — the lobe a
        // looped cubic encloses between its two double-point parameters — or a
        // zero-extent sliver left by a cut. Dropping both loses the lobe entirely
        // (a figure-eight would come back with three edges instead of four).
        // Extent tells them apart.
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (const q of pc.P) {
          if (q[0] < x0) x0 = q[0];
          if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1];
          if (q[1] > y1) y1 = q[1];
        }
        if (Math.hypot(x1 - x0, y1 - y0) <= tol * 4) continue; // sliver
        // Split a closed sub-curve in half. It is a legitimate one-edge cycle, but the
        // converter's work loop rejects a loop of fewer than two curves, so the lobe
        // would extract correctly and then convert to nothing. Two halves carry the
        // same geometry and give the walk a real node to turn at.
        const h1 = segSlice(pc, 0, 0.5),
          h2 = segSlice(pc, 0.5, 1);
        const mid = nodeOf(segEnd(h1));
        edges.push({ seg: h1, a, b: mid });
        edges.push({ seg: h2, a: mid, b });
        continue;
      }
      edges.push({ seg: pc, a, b });
    }
  }
  return { edges, nodes };
}

/// Fill on each side of every edge, by shooting a ray normal to the edge at its
/// midpoint. The paper's point exactly: this is TWO evaluations per EDGE rather than
/// one per sample, so it is cheap however large the drawing is.

export function scoreFill(graph, contours, evenOdd = false) {
  // The converter's own {t, P, w} form, not the intersector's: the row is solved directly below,
  // so nothing here needs the adapter -- and the adapter is what could not express a rquad.
  const all = [];
  for (const c of contours) for (const s of c) all.push(s);

  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const s of all)
    for (const q of s.P) {
      if (q[0] < bx0) bx0 = q[0];
      if (q[0] > bx1) bx1 = q[0];
      if (q[1] < by0) by0 = q[1];
      if (q[1] > by1) by1 = q[1];
    }
  const reach = 2 * (Math.hypot(bx1 - bx0, by1 - by0) || 1);
  // A segment the ray cannot reach is not handed to the intersector. A Bezier lies inside its
  // control-point box, so a segment whose box lies wholly above or below the ray's row, or wholly
  // behind its origin, has no crossing in front of it to count -- and the intersector is a Bezier
  // clipper that, run on every segment for two rays per edge, would be most of the front end's
  // time once the pairwise sweep is baked. Exact: the skipped calls could only have returned hits
  // the tests below discard. The margin is against a tangent touch at a box edge.
  const boxes = all.map((s) => {
    let x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const q of s.P) {
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    return [x1, y0, y1];
  });
  const rayEps = 1e-7 * reach;
  // CROSSINGS OF THE ROW, SOLVED DIRECTLY, not handed to the pair intersector.

  const rowA = [];
  const wind = (px, py) => {
    let w = 0;
    for (let si = 0; si < all.length; si++) {
      const s = all[si],
        b = boxes[si];
      if (py < b[1] - rayEps || py > b[2] + rayEps || b[0] < px) continue;
      let ts;
      if (isRat(s)) ts = affRootsOnSeg([0, 1, -py], s);
      else {
        rowA.length = s.P.length;
        for (let i = 0; i < s.P.length; i++) rowA[i] = s.P[i][1] - py;
        // THE ROW'S COEFFICIENTS ARE WORLD DISTANCES, so the solver's tolerance has to be one
        // too. A flat 1e-9 is a fifth of a thousandth of a contour 6e-5 across and nothing at all
        // on one 900 across, which is the same crossing found at one size and missed at another.
        //
        // CALIBRATED, not merely made relative: the coefficient reproduces the tuned 1e-9 on the
        // ~900-unit artwork it was tuned against (reach is twice the diagonal, ~2546 there), so
        // every asset gets the test that one asset gets at that size rather than a looser one.
        // Scaling to `reach` outright is 1800x looser and paints pixels wrongly.
        ts = bezRoots01(rowA, RAY_EPS_REL * reach);
      }
      for (let k = 0; k < ts.length; k++) {
        const t = ts[k];
        if (t <= EPS || t >= 1 - EPS) continue; // skip endpoint grazes
        const tg = segTangent(s, t);

        if (!(Math.abs(tg[1]) > 1e-12 * Math.hypot(tg[0], tg[1]))) continue;
        // IN FRONT OF THE ORIGIN, tested in world x rather than a ray parameter -- and by a
        // margin taken from the geometry, since "in front" is a statement about a distance.
        if (!(segPt(s, t)[0] > px + RAY_EPS_REL * reach)) continue;
        w += tg[1] > 0 ? 1 : -1;
      }
    }
    return w;
  };
  const filled = (w) => (evenOdd ? (w & 1) === 1 : w !== 0);
  const kept = [],
    dropped = [];
  for (const e of graph.edges) {
    const m = segPt(e.seg, 0.5),
      tg = segTangent(e.seg, 0.5);
    const L = Math.hypot(tg[0], tg[1]) || 1;
    const nx = -tg[1] / L,
      ny = tg[0] / L;

    const d = probeOff() * reach;
    const fl = filled(wind(m[0] + nx * d, m[1] + ny * d));
    const fr = filled(wind(m[0] - nx * d, m[1] - ny * d));
    if (fl === fr) {
      dropped.push(e);
      continue;
    } // not a boundary: drop it (repairBoundary may take it back)
    e.leftFilled = fl;
    kept.push(e);
  }
  return { edges: kept, nodes: graph.nodes, dropped, probe: probeOff() * reach };
}

/// How far off an edge the fill is probed, as a fraction of the arrangement's diagonal. Small
/// enough to sit inside any feature the geometry can express, large enough to clear the edge
/// itself by orders of magnitude in double precision. Read at call time, so a flag a pooled
/// conversion forwards reaches the worker, which imports this module before it applies the flags.
const probeOff = () => mantleDebugHook('__CP_PROBE_OFF') ?? 1e-6;

function segTangentLB(s, t) {
  const P = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
  const T = P.length === 2 ? 'line' : P.length === 3 ? 'quad' : 'cubic';
  return segTangent({ t: T, P }, t);
}

/// Walk the surviving edges into closed cycles, at each node taking the smallest
/// outgoing angle from the incoming direction on the filled side. Every edge is used
/// once per direction it bounds, so touching cycles separate cleanly.
// The graph extractCycles WALKS HAS TO BE A BOUNDARY, and this is the one property that says so.
//
// scoreFill keeps an edge only where the fill differs across it and orients it with the filled side
// on the LEFT, so a node has exactly as many boundary edges arriving as leaving. Any greedy walk
// that always leaves on an unused out-edge must then return to where it began -- that is the Euler
// argument, and it is why extractCycles is allowed to be as simple as it is. Where the invariant
// holds, the walk cannot produce an open chain.

function repairBoundary(edges, nodes, dropped, probe) {
  const imbalance = () => {
    const ind = new Map(),
      outd = new Map();
    for (const e of edges) {
      const from = e.leftFilled ? e.a : e.b,
        to = e.leftFilled ? e.b : e.a;
      outd.set(from, (outd.get(from) || 0) + 1);
      ind.set(to, (ind.get(to) || 0) + 1);
    }
    const im = new Map();
    for (const n of new Set([...ind.keys(), ...outd.keys()])) {
      const d = (ind.get(n) || 0) - (outd.get(n) || 0);
      if (d !== 0) im.set(n, d);
    }
    return im;
  };
  let im = imbalance();
  if (!im.size) return;

  // AN EDGE THE PROBE CALLED NOT-A-BOUNDARY MAY BE ONE THAT BALANCES TWO NODES. The probe stands a fixed fraction of the drawing away
  // from an edge midpoint, so an edge shorter than twice that (the end of a curve that crosses its neighbor a hair from their shared
  // vertex: a lens 1e-6 of the drawing across) has both probes outside whatever it bounds and reads the same fill on both sides.
  // The boundary must balance, and a chain of such edges that joins a node with surplus arrivals to one with surplus departures is
  // the way to balance it that moves no coordinate: it is authored geometry, so it is taken back, oriented from the surplus to the
  // deficit, the shortest chain first. Nodes are never merged for this, which would leave a gap between consecutive curves of a cycle.
  if (dropped && dropped.length && probe > 0) {
    const adj = new Map();
    for (const e of dropped) {
      const A = nodes[e.a],
        B = nodes[e.b];
      if (!A || !B) continue;
      const w = Math.hypot(A[0] - B[0], A[1] - B[1]);
      if (!(w <= 2 * probe)) continue; // a longer edge is classified reliably: it is not one of these
      for (const [u, v] of [
        [e.a, e.b],
        [e.b, e.a],
      ])
        (adj.get(u) || adj.set(u, []).get(u)).push({ e, to: v, w });
    }
    const used = new Set();
    for (const [src] of [...im]) {
      while ((im.get(src) || 0) > 0) {
        // Dijkstra over the dropped edges from the surplus node to the nearest node in deficit
        const dist = new Map([[src, 0]]),
          prev = new Map(),
          open = [src];
        let goal = -1;
        while (open.length) {
          let bi = 0;
          for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
          const u = open.splice(bi, 1)[0];
          if (u !== src && (im.get(u) || 0) < 0) {
            goal = u;
            break;
          }
          for (const { e, to, w } of adj.get(u) || []) {
            if (used.has(e)) continue;
            const nd = dist.get(u) + w;
            if (nd > 2 * probe) continue;
            if (!dist.has(to) || nd < dist.get(to)) {
              dist.set(to, nd);
              prev.set(to, { e, from: u });
              if (!open.includes(to)) open.push(to);
            }
          }
        }
        if (goal < 0) break;
        for (let n = goal; n !== src;) {
          const { e, from } = prev.get(n);
          e.leftFilled = e.a === from; // the edge runs from the surplus side toward the deficit
          used.add(e);
          edges.push(e);
          n = from;
        }
        im.set(src, (im.get(src) || 0) - 1);
        im.set(goal, (im.get(goal) || 0) + 1);
      }
    }
    for (const [n, d] of [...im]) if (d === 0) im.delete(n);
    if (!im.size) return;
  }

  let diag = 0;
  {
    let mnx = Infinity,
      mny = Infinity,
      mxx = -Infinity,
      mxy = -Infinity;
    for (const p of nodes) {
      if (!p) continue;
      if (p[0] < mnx) mnx = p[0];
      if (p[0] > mxx) mxx = p[0];
      if (p[1] < mny) mny = p[1];
      if (p[1] > mxy) mxy = p[1];
    }
    diag = Math.hypot(mxx - mnx, mxy - mny) || 1;
  }

  const eps = 1e-7 * diag; // no absolute floor: diag is the drawing's, and 1 when it has none
  const par = new Map();
  const find = (a) => {
    while (par.get(a) !== undefined && par.get(a) !== a) a = par.get(a);
    return a;
  };
  for (const [a, da] of im) {
    if (da <= 0) continue; // pair each sink with its nearest source
    const pa = nodes[a];
    if (!pa) continue;
    let best = -1,
      bestD = eps;
    for (const [b, db] of im) {
      if (db >= 0 || find(b) === find(a)) continue;
      const pb = nodes[b];
      if (!pb) continue;
      const dd = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (dd <= bestD) {
        bestD = dd;
        best = b;
      }
    }
    if (best >= 0) {
      const ra = find(a),
        rb = find(best);
      if (ra !== rb) par.set(rb, ra);
    }
  }
  if (par.size) {
    for (const e of edges) {
      e.a = find(e.a);
      e.b = find(e.b);
    }
    im = imbalance();
    if (!im.size) return;
  }

  //
  // Shrinking the probe does not settle it -- the row-span oracle answers left-filled at a quarter
  // of that edge's extent and right-filled at a twentieth, so any fixed fraction is a guess about
  // how close the neighboring geometry runs. The topology is not a guess: an edge whose tail is a
  // SOURCE and whose head is a SINK cannot be oriented that way on a boundary, and reversing it
  // takes both nodes to balance at once.
  for (let pass = 0; pass < edges.length + 1; pass++) {
    let flipped = false;
    for (const e of edges) {
      const from = e.leftFilled ? e.a : e.b,
        to = e.leftFilled ? e.b : e.a;
      if ((im.get(from) || 0) >= 0 || (im.get(to) || 0) <= 0) continue;
      e.leftFilled = !e.leftFilled;
      im.set(from, (im.get(from) || 0) + 2);
      im.set(to, (im.get(to) || 0) - 2);
      flipped = true;
    }
    if (!flipped) break;
    im = imbalance();
    if (!im.size) return;
  }
}

export function extractCycles(graph) {
  const { edges, nodes, dropped, probe } = graph;
  if (!edges.length) return [];
  repairBoundary(edges, nodes, dropped, probe);
  // Directed half-edges: an edge bounds the fill on ONE side, so it is traversed in
  // the direction that keeps the fill to a consistent hand.
  const out = new Map(); // node → half-edges leaving it
  const halves = [];
  for (const e of edges) {
    const fwd = { seg: e.seg, from: e.a, to: e.b, used: false };
    const rev = { seg: revSeg(e.seg), from: e.b, to: e.a, used: false };
    halves.push(e.leftFilled ? fwd : rev);
  }
  for (const h of halves) {
    if (!out.has(h.from)) out.set(h.from, []);
    out.get(h.from).push(h);
  }
  const ang = (v) => Math.atan2(v[1], v[0]);
  const cycles = [];
  //
  // A chain has to be entered at its head. That is the node with more edges leaving than arriving,
  // and repairBoundary has already removed every imbalance that was an artifact, so the ones left
  // are genuine: a contour whose path is open by more than rounding. Walking from there covers the
  // chain in one piece so it can be converted as one contour instead of being thrown away.
  //
  // The partition is STABLE and a balanced graph has no source, so a graph that is already a
  // boundary is walked in exactly its input order.
  const deg = new Map();
  for (const h of halves) {
    deg.set(h.from, (deg.get(h.from) || 0) + 1);
    deg.set(h.to, (deg.get(h.to) || 0) - 1);
  }
  const starts = halves
    .filter((h) => (deg.get(h.from) || 0) > 0)
    .concat(halves.filter((h) => (deg.get(h.from) || 0) <= 0));
  for (const start of starts) {
    if (start.used) continue;
    const cyc = [];
    let h = start;
    for (let guard = 0; guard < 10000; guard++) {
      if (h.used) break;
      h.used = true;
      cyc.push(h.seg);
      const cand = out.get(h.to);
      if (!cand || !cand.length) break;

      const inDir = segTangent(h.seg, 1);
      const inA = ang([-inDir[0], -inDir[1]]);
      let best = null,
        bestT = Infinity;
      for (const c of cand) {
        if (c.used) continue;
        const o = segTangent(c.seg, 0);
        let d = inA - ang(o);
        while (d <= 0) d += Math.PI * 2;
        while (d > Math.PI * 2) d -= Math.PI * 2;
        if (d < bestT) {
          bestT = d;
          best = c;
        }
      }
      if (!best) break;
      h = best;
      if (h === start) break;
    }
    // A closed sub-curve is a cycle of one. Requiring two edges silently discarded the
    // lobe a looped cubic encloses — it is a single edge whose ends are the same node,
    // so the walk pushes it, finds no unused successor, and stops at length one.
    if (cyc.length >= 2 || (cyc.length === 1 && start.from === start.to)) cycles.push(cyc);
  }
  return cycles;
}

const revSeg = (s) => ({ t: s.t, cut: s.cut, P: s.P.slice().reverse(), w: s.w });

/// Whether the segment a-b MEETS ANY CURVE OF `loops` strictly between its ends, exactly: the roots of
/// its line along each curve, as earCut's chord test takes them. A bridge or a ring's cut is a straight
/// line the arrangement adds, and one that crosses a curve makes a cycle that crosses itself -- a lobe of
/// it winds the wrong way and the converter, which takes a cycle as a simple loop, paints what it encloses.
///
/// It is exact rather than a 12-point flattening of each curve, which would be a sampled answer to a
/// yes/no question: a curve that bulges across the line between two samples would not be seen.
export function lineMeetsLoops(a, b, loops) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L = Math.hypot(dx, dy);
  if (!(L > 0)) return true;
  const ux = dx / L,
    uy = dy / L;
  const h = [-uy, ux, -(-uy * a[0] + ux * a[1])];
  // The box pad covers rounding in the boxes, relative to the coordinates (see earCut's).
  const pad =
    1e-12 * (Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) + L);
  const x0 = Math.min(a[0], b[0]) - pad,
    x1 = Math.max(a[0], b[0]) + pad;
  const y0 = Math.min(a[1], b[1]) - pad,
    y1 = Math.max(a[1], b[1]) + pad;
  for (const segs of loops)
    for (const s of segs) {
      const sb = segTightBBox(s);
      if (sb[2] < x0 || sb[0] > x1 || sb[3] < y0 || sb[1] > y1) continue;
      // A segment lying along the line has no isolated roots and still overlaps it (see earCut).
      let onLine = true;
      for (const q of s.P)
        if (Math.abs(h[0] * q[0] + h[1] * q[1] + h[2]) > 1e-9 * L) {
          onLine = false;
          break;
        }
      if (onLine) {
        const e0 = s.P[0],
          e1 = s.P[s.P.length - 1];
        const ua = ((e0[0] - a[0]) * ux + (e0[1] - a[1]) * uy) / L,
          ub = ((e1[0] - a[0]) * ux + (e1[1] - a[1]) * uy) / L;
        if (Math.min(ua, ub) < 1 - 1e-6 && Math.max(ua, ub) > 1e-6) return true;
        continue;
      }
      for (const t of affRootsOnSeg(h, s)) {
        // A root at a segment's end is that end: bezRoots01 puts it ~2e-6 inside, and a line
        // leaving from the segment's end vertex would otherwise read as crossing its own endpoint.
        const q = t < 1e-5 ? s.P[0] : t > 1 - 1e-5 ? s.P[s.P.length - 1] : segPt(s, t);
        const u = ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / L;
        if (u > 1e-6 && u < 1 - 1e-6) return true;
      }
    }
  return false;
}

/// SPLIT A RING INTO TWO TOUCHING CYCLES — the paper's words, and not the same thing as
/// bridging it into one.
///
/// Returns [cycleA, cycleB], or null when two non-crossing connections cannot be placed.
function splitRing(outer, hole, others = []) {
  const ptOf = (seg) => seg.P[0];
  const flatten = (segs) => {
    const out = [];
    for (const sg of segs) for (let k = 0; k < 12; k++) out.push(segPt(sg, k / 12));
    return out;
  };
  const area2 = (segs) => {
    const pts = flatten(segs);
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return a;
  };
  // The hole must be walked OPPOSITE to its container, or the two halves double back on
  // themselves and enclose nothing. Same reasoning bridgeHoles documents at length.
  const H =
    area2(outer) >= 0 === area2(hole) >= 0
      ? hole
          .slice()
          .reverse()
          .map((sg) => segRev(sg))
      : hole.slice();
  if (outer.length < 2 || H.length < 2) return null;

  const seg2 = (a, b, c, d) => {
    // do segments ab and cd properly cross?
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(a, b, c),
      d2 = o(a, b, d),
      d3 = o(c, d, a),
      d4 = o(c, d, b);
    return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
  };
  // THE CUTS MUST CLEAR every HOLE still IN THE RING, not only this one: resolveRing hands the holes
  // after this one to whichever half contains them, and a cut that runs through one of them leaves that
  // half crossing itself.
  const loops = [outer, H, ...others];
  const crosses = (a, b) => lineMeetsLoops(a, b, loops);

  const cands = [];
  for (let i = 0; i < outer.length; i++)
    for (let j = 0; j < H.length; j++) {
      const a = ptOf(outer[i]),
        b = ptOf(H[j]);
      cands.push({ i, j, d2: (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 });
    }
  cands.sort((x, y) => x.d2 - y.d2);

  let A = null;
  for (const c of cands) {
    if (!crosses(ptOf(outer[c.i]), ptOf(H[c.j]))) {
      A = c;
      break;
    }
  }
  if (!A) return null;
  const aO = ptOf(outer[A.i]),
    aH = ptOf(H[A.j]);
  // The SECOND connection must not cross the first, and must leave a real arc on both
  // contours — sharing an endpoint with the first would make one half degenerate.
  let B = null;
  for (const c of cands) {
    if (c === A || c.i === A.i || c.j === A.j) continue;
    const bO = ptOf(outer[c.i]),
      bH = ptOf(H[c.j]);
    if (seg2(aO, aH, bO, bH)) continue;
    if (crosses(bO, bH)) continue;
    B = c;
    break;
  }
  if (!B) return null;
  const bO = ptOf(outer[B.i]),
    bH = ptOf(H[B.j]);

  const arc = (arr, from, to) => {
    const out = [];
    for (let k = from; k !== to; k = (k + 1) % arr.length) out.push(arr[k]);
    return out;
  };
  const cut = (p, q) => ({ t: 'line', P: [p, q], cut: true });
  const c1 = arc(outer, A.i, B.i).concat([cut(bO, bH)], arc(H, B.j, A.j), [cut(aH, aO)]);
  const c2 = arc(outer, B.i, A.i).concat([cut(aO, aH)], arc(H, A.j, B.j), [cut(bH, bO)]);
  if (c1.length < 3 || c2.length < 3) return null;
  return [c1, c2];
}

/// One hole at a time: split the ring, then hand each remaining hole to whichever half now
/// contains it. This is the paper's "first connect the inner cycles and then make the connection
/// to the outermost cycle" arrived at from the other end — the recursion never has to reason
/// about several holes at once.
function resolveRing(outer, holes, _d = 0) {
  if (_d > 64) return null;
  if (!holes.length) return [outer];
  // THE FIRST HOLE THAT SPLITS, not holes[0]: the cuts must clear every hole (splitRing), and one walled
  // in by the others has no clear pair of cuts while a hole nearer the outer does.
  let two = null,
    rest = null;
  for (let k = 0; k < holes.length && !two; k++) {
    rest = holes.filter((_, i) => i !== k);
    two = splitRing(outer, holes[k], rest);
  }
  if (!two) return null;
  if (!rest.length) return two;
  const polyOf = (segs) => {
    const o = [];
    for (const sg of segs) for (let k = 0; k < 12; k++) o.push(segPt(sg, k / 12));
    return o;
  };
  const inPoly = (pt, poly) => {
    let hit = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const xi = poly[a][0],
        yi = poly[a][1],
        xj = poly[b][0],
        yj = poly[b][1];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
        hit = !hit;
    }
    return hit;
  };
  const out = [];
  const claimed = new Set();
  for (const half of two) {
    const poly = polyOf(half);
    const mine = rest.filter((h) => !claimed.has(h) && inPoly(segPt(h[0], 0.5), poly));
    for (const h of mine) claimed.add(h);
    const sub = resolveRing(half, mine, _d + 1);
    if (!sub) return null;
    for (const c of sub) out.push(c);
  }
  // A hole neither half claimed would be silently dropped, and a dropped hole is painted ink.
  if (claimed.size !== rest.length) return null;
  return out;
}

/// The rest of the paper's stage (c): NESTED CYCLES.
///
/// Cycle extraction on its own returns a ring as TWO cycles, outer and inner, and a converter
/// handed the inner one emits it as a filled patch — the hole gets painted (a square with a
/// square hole, under both fill rules, shows it). This is the stage that stops that, and it
/// belongs here rather than in the packer: a caller of pathToCycles is entitled to cycles that
/// mean what they say.
function resolveNesting(cycles, evenOdd) {
  if (cycles.length < 2) return cycles;
  const out = [];
  for (const g of groupContours(cycles, evenOdd)) {
    if (!g.holes.length) {
      out.push(g.outer);
      continue;
    }
    const split = resolveRing(g.outer, g.holes);
    if (split) {
      for (const c of split) out.push(c);
      continue;
    }
    const bridged = bridgeHoles(g.outer, g.holes);
    if (bridged) {
      out.push(bridged);
      continue;
    }
    // No bridge could be routed. Emitting the outer ALONE would fill the hole, so hand back
    // the pieces and let the caller's hole-as-constraint path deal with them.
    out.push(g.outer);
    for (const h of g.holes) out.push(h);
  }
  return out;
}

/// The whole front end: raw subpaths → clean cycles.
export function pathToCycles(
  contours,
  evenOdd = false,
  cutsIn = null,
  cutsOut = null,
  wide = false,
) {
  //
  // HERE, in the front end, rather than in the callers that build contours: this is the stage that
  // needs a cycle, and a caller that reaches the arrangement directly cannot forget to do it.
  //
  // 1e-6 is the same closing tolerance ConvertShape's input is closed with, so closing here is
  // idempotent with it. Below that the closing line is a HAIR, and a hair is worse than the
  // gap it fills: scoreFill decides which side of an edge is filled by probing 1e-4 x the
  // midpoint's distance from the origin off it, so a segment shorter than that is classified from
  // outside its own neighborhood and comes back reversed.
  // ...AND THE GAP IS RELATIVE TO THE CONTOUR. Whether a subpath counts as already closed is a
  // STRUCTURAL decision -- it changes the arrangement, the cycles and the patch count -- and a gap
  // in world units decides it differently for the same artwork at two sizes. The coefficient gives
  // 1e-6 for a contour ~900 units across, the size it was tuned on; every other size gets the same
  // test rather than a harsher or a laxer one.
  contours = contours.map((c) => {
    if (!c || !c.length) return c;
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of c)
      for (const q of sg.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    const ext = Math.max(x1 - x0, y1 - y0) || 1;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1.111e-9 * ext) return c;
    return c.concat([{ t: 'line', P: [b, a] }]);
  });
  const g = flattenGraph(contours, cutsIn, cutsOut, wide);
  if (!g.edges.length) return [];
  const s = scoreFill(g, contours, evenOdd);
  if (!s.edges.length) return [];
  s.edges = oneOfEachCoincident(s.edges);
  return resolveNesting(extractCycles(s), evenOdd);
}

/// COINCIDENT BOUNDARY EDGES ARE ONE EDGE. Copies of a stretch of outline that survive the fill test (three copies under even-odd,
/// two contours sharing part of an edge under nonzero) all separate ink from air; keeping each would send the walk round the
/// same line once per copy or double it back along it: a triangle drawn three times with a hole would lose the hole, and two
/// triangles sharing an apex and a stretch of edge would lose a triangle. The ends are the graph's nodes and the midpoint tells one curve from
/// another between the same two nodes; it is compared at a millionth of the edge's own chord.
function oneOfEachCoincident(edges) {
  const byEnds = new Map();
  const out = [];
  for (const e of edges) {
    const P = e.seg.P,
      a = P[0],
      b = P[P.length - 1];
    const k = e.a < e.b ? e.a * 67108864 + e.b : e.b * 67108864 + e.a;
    const m = segPt(e.seg, 0.5),
      tol = 1e-6 * Math.hypot(b[0] - a[0], b[1] - a[1]);
    let l = byEnds.get(k);
    if (!l) byEnds.set(k, (l = []));
    if (l.some((q) => Math.hypot(q[0] - m[0], q[1] - m[1]) <= tol)) continue;
    l.push(m);
    out.push(e);
  }
  return out;
}

/// other leaves empty, so the same file renders differently under the wrong one.
export function groupContours(contours, evenOdd = false) {
  const n = contours.length;
  if (n <= 1) return contours.length ? [{ outer: contours[0], holes: [] }] : [];
  const polys = contours.map((c, ci) => {
    const poly = [];
    for (const sg of c) for (let k = 0; k < 24; k++) poly.push(segPt(sg, k / 24));
    return poly;
  });
  const inPoly = (pt, poly) => {
    let inside = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const xi = poly[a][0],
        yi = poly[a][1],
        xj = poly[b][0],
        yj = poly[b][1];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  };
  const rep = contours.map((c) => segPt(c[0], 0.5));
  // Signed area gives each contour's winding direction — the shoelace over the same
  // flattening used for containment, so the two agree by construction.
  const wind = polys.map((poly) => {
    let a2 = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      a2 += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    return a2 >= 0 ? 1 : -1;
  });
  const depth = new Array(n).fill(0);
  const parent = new Array(n).fill(-1);
  // CONTAINMENT ONCE, NOT PER PAIR. Recounting, for every (i, j) considered, how many contours
  // contain j is an O(n^3) scan of point-in-polygon over a 24-point flattening: harmless on a
  // shape's handful of subpaths, but on a path's whole extracted cycle set it does not finish.
  // The matrix gives the identical answer in O(n^2), and the box test skips most of the tests outright.
  const bbs = polys.map((poly) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const q of poly) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    return [x0, y0, x1, y1];
  });
  const contains = [];
  for (let j = 0; j < n; j++) {
    const row = new Uint8Array(n),
      B = bbs[j];
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const p = rep[i];
      if (p[0] < B[0] || p[0] > B[2] || p[1] < B[1] || p[1] > B[3]) continue;
      row[i] = inPoly(p, polys[j]) ? 1 : 0;
    }
    contains.push(row);
  }
  const containedBy = new Array(n).fill(0);
  for (let j = 0; j < n; j++)
    for (let k = 0; k < n; k++) if (k !== j && contains[k][j]) containedBy[j]++;
  for (let i = 0; i < n; i++) {
    let best = -1,
      bestCount = -1;
    for (let j = 0; j < n; j++) {
      if (!contains[j][i]) continue;
      depth[i]++;
      // innermost container = the one contained by the most others
      if (containedBy[j] > bestCount) {
        bestCount = containedBy[j];
        best = j;
      }
    }
    parent[i] = best;
  }
  // isHole under the ACTIVE rule.
  const isHole = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (parent[i] < 0) continue; // top level is never a hole
    isHole[i] = evenOdd ? depth[i] % 2 === 1 : wind[i] !== wind[parent[i]];
  }
  const groups = [];
  const idx = new Map();
  for (let i = 0; i < n; i++) {
    if (isHole[i]) continue;
    idx.set(i, groups.length);
    groups.push({ outer: contours[i], holes: [] });
  }
  for (let i = 0; i < n; i++) {
    if (!isHole[i]) continue;
    // Attach to the nearest ancestor that is itself FILLED — under nonzero a hole can
    // sit inside another hole, and hanging it off a hole would subtract from nothing.
    //
    // The walk must be cycle-proof. `parent` is only a tree when the contours are properly
    // nested, and two cycles pulled out of a SELF-INTERSECTING path need not be: each can
    // contain the other's sample point, giving parent[x] = y and parent[y] = x, and this loop
    // then never ends. A shape's own subpaths do not do this, but cycle extraction feeds
    // groupContours its own output, which can. Mutual containment is not nesting, so bail
    // out and let both stand on their own.
    let a = parent[i],
      guard = n;
    while (a >= 0 && isHole[a] && guard-- > 0) a = parent[a];
    if (guard <= 0) a = -1;
    const g = a >= 0 ? idx.get(a) : undefined;
    if (g != null) groups[g].holes.push(contours[i]);
    else groups.push({ outer: contours[i], holes: [] }); // orphan: render rather than lose
  }
  return groups;
}

/// BRIDGE each hole into its outer cycle, which is what the CPatch paper does rather
/// than treating a hole as a constraint on patches:
///
/// A bridge is one straight segment traversed both ways, so it encloses zero area and
/// changes no coverage; the hole is walked in the opposite direction, which makes the
/// combined cycle wind consistently and leaves the hole's interior outside it. After
/// this there are no holes left — the ordinary single-cycle machinery applies, and the
/// cutter never has to find a radial cut it has no candidate for.

export function bridgeHoles(outer, holes) {
  let cyc = outer.slice();
  const ptOf = (seg) => seg.P[0];
  // Against every loop still in the shape: the cycle as it stands and every hole not yet in it. Testing
  // the cycle and this hole only would let a bridge taken early run across a hole bridged later.
  // ...WHICH MAKES THE ORDER MATTER: a hole walled in by others has no clear line to the cycle until one
  // of them is in it. So each round bridges the first hole that can be bridged, and the loop fails only
  // when a whole round bridges none.
  const left = holes.filter((h) => h && h.length >= 2);
  while (left.length) {
    let took = -1;
    for (let hi = 0; hi < left.length && took < 0; hi++) {
      const hole = left[hi];
      const loops = [cyc, ...left];
      // Candidate endpoint pairs, nearest first.
      const cands = [];
      for (let i = 0; i < cyc.length; i++)
        for (let j = 0; j < hole.length; j++) {
          const a = ptOf(cyc[i]),
            b = ptOf(hole[j]);
          cands.push({ i, j, d2: (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 });
        }
      cands.sort((x, y) => x.d2 - y.d2);
      for (const c of cands) {
        const a = ptOf(cyc[c.i]),
          b = ptOf(hole[c.j]);
        if (lineMeetsLoops(a, b, loops)) continue;

        const wsign = (segs) => {
          let a2 = 0,
            pts = [];
          for (const sg of segs) for (let k = 0; k < 12; k++) pts.push(segPt(sg, k / 12));
          for (let i = 0, j2 = pts.length - 1; i < pts.length; j2 = i++)
            a2 += pts[j2][0] * pts[i][1] - pts[i][0] * pts[j2][1];
          return a2 >= 0 ? 1 : -1;
        };
        const sameWind = wsign(cyc) === wsign(hole);
        const rot = [];
        for (let k = 0; k < hole.length; k++) {
          rot.push(
            sameWind
              ? hole[(c.j - 1 - k + hole.length * 2) % hole.length]
              : hole[(c.j + k) % hole.length],
          );
        }
        const rev = sameWind ? rot.map((sg) => segRev(sg)) : rot;
        cyc = cyc
          .slice(0, c.i)
          // MARKED AS CUT SEAMS, not as real edges. A bridge is an internal boundary the
          // converter introduced, shared by the patches on either side — exactly what
          // `cut` already means here, and what makes the shader draw it as a hard step
          // instead of antialiasing both sides to 0.75 along the slit.
          .concat([{ t: 'line', P: [a, b], cut: true }]) // out along the bridge
          .concat(rev) // around the hole, opposite sense
          .concat([{ t: 'line', P: [b, a], cut: true }]) // and back
          .concat(cyc.slice(c.i));
        took = hi;
        break;
      }
    }
    if (took < 0) return null; // no hole has a non-crossing bridge: leave it to the caller
    left.splice(took, 1);
  }
  return cyc;
}
