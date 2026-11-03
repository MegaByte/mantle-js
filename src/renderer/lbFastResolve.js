// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbFastResolve.js — make a contour set one the FAST Loop-Blinn builder draws correctly, or say why not.

// And three things the builder cannot take at all: a CUSP (cubicLoop reports it, and the shape would
// go to the fallback -- on a lightweight stream, not drawn), which is split at its parameter so each side
// is an ordinary piece; a genuine LOOP, which is declined; and a contour that returns to a vertex it
// already passed through (three triangles sharing an apex, written as one subpath), which is cut into
// its loops there -- winding is additive over the loops, so the fill is unchanged under either rule.
//
// Everything is exact or a subdivision of the curve itself: the side tests use the exact orientation
// predicate, the splits are de Casteljau (homogeneous for rational quads), and nothing is flattened.
// What it cannot make drawable it DECLINES with the reason ('crossing', 'touch', 'loop', 'no side'), and
// buildLoopBlinnMesh then runs resolveSelfOverlap and asks once more (see there).
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD, mkLine } from '../primitives/seg.js';
import { orient2d } from '../geom/predicates.js';
import {
  cubicInflections,
  cubicLoopCuts,
  cubicLoop,
  cubicDegreeReduce,
  splitCubic,
} from '../geom/lbCubicMath.js';
import { cubicCuspT } from '../svg/cubicCusp.js';
import { rayWindingExact, _kox, _koy, _koScale } from '../geom/lbContour.js';
import { mantleDebugHook } from '../core/diagnostics.js';

/// How deep one curve may be halved before an overlap is taken to be a real crossing (2^-18 of its
/// length: past any plausible tangency the float32 geometry can express). Relative, never a distance.
const MAX_DEPTH = 18;

const endOf = (s) => s.p4 || s.p3 || s.p2;
const isCurve = (s) => s.type !== SEG_LINE;

/// Halve a segment at t = 1/2, exactly (homogeneous for a rational quad). The halves keep every other
/// field of the parent (a subpath start stays on the first half only).
function halve(s) {
  if (s.type === SEG_CUBIC) {
    const [a, b] = splitCubic([s.p1, s.p2, s.p3, s.p4], 0.5);
    const L = { ...s, p1: a[0], p2: a[1], p3: a[2], p4: a[3] },
      R = { ...s, p1: b[0], p2: b[1], p3: b[2], p4: b[3] };
    delete R.subStart;
    return [L, R];
  }
  const w = s.type === SEG_RQUAD ? s.w || 1 : 1,
    a = s.p1,
    c = s.p2,
    b = s.p3,
    k = 1 + w;
  const m = [(a[0] + 2 * w * c[0] + b[0]) / (2 * k), (a[1] + 2 * w * c[1] + b[1]) / (2 * k)];
  const L = { ...s, p1: a, p2: [(a[0] + w * c[0]) / k, (a[1] + w * c[1]) / k], p3: m };
  const R = { ...s, p1: [m[0], m[1]], p2: [(w * c[0] + b[0]) / k, (w * c[1] + b[1]) / k], p3: b };
  delete R.subStart;
  // A circle tag describes the whole arc's circle, which both halves still lie on -- keep it.
  if (s.type === SEG_RQUAD) {
    L.w = Math.sqrt(k / 2);
    R.w = L.w;
  }
  return [L, R];
}

/// Are all of a curve's control points on the line through its ends (exactly)?
function collinearCurve(s) {
  const a = s.p1,
    b = endOf(s);
  if (a[0] === b[0] && a[1] === b[1]) return false;
  const inner = s.type === SEG_CUBIC ? [s.p2, s.p3] : [s.p2];
  for (const q of inner) if (orient2d(a, b, q) !== 0) return false;
  return true;
}

/// One contour with every curve whose control points are all on its chord's line replaced by that line (see the resolver below for why a folded
/// one may be), or the same array when it has none. A zero-length one goes. Exact: the orientation predicate on the stored points.
export function straightenCollinearCurves(c) {
  let out = null;
  for (let i = 0; i < c.length; i++) {
    const s = c[i];
    if (!s || s.type === SEG_LINE || !collinearCurve(s)) {
      if (out) out.push(s);
      continue;
    }
    if (!out) out = c.slice(0, i);
    const L = mkLine(s.p1, endOf(s));
    if (s.subStart) L.subStart = true;
    out.push(L);
  }
  return out || c;
}

/// Split a cubic segment at the given parameters (sorted, strictly inside (0, 1)).
function splitCubicSeg(s, ts) {
  const out = [];
  let cur = [s.p1, s.p2, s.p3, s.p4],
    last = 0;
  for (const t of ts) {
    const lt = (t - last) / (1 - last);
    if (!(lt > 1e-6 && lt < 1 - 1e-6)) continue;
    const [l, r] = splitCubic(cur, lt);
    out.push(l);
    cur = r;
    last = t;
  }
  out.push(cur);
  return out.map((P, i) => {
    const o = { ...s, p1: P[0], p2: P[1], p3: P[2], p4: P[3] };
    if (i) delete o.subStart;
    return o;
  });
}

/// The convex polygon a piece's crescent and rim edges live in, counterclockwise-or-degenerate: a line's
/// two ends, a quad's control triangle, a cubic's control hull (or, where the builder will draw the
/// cubic as the quadratic it is, that quadratic's triangle).
function hullOf(s, isStatic) {
  if (s.type === SEG_LINE) return [s.p1, s.p2];
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) return convex([s.p1, s.p2, s.p3]);
  const P = [s.p1, s.p2, s.p3, s.p4];
  const Q = isStatic ? cubicDegreeReduce(P) : null;
  return convex(Q ? [s.p1, Q, s.p4] : P);
}
/// Convex hull (Andrew's monotone chain, exact orientation), counterclockwise.
function convex(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const u = [];
  const lower = [],
    upper = [];
  for (const q of p) {
    while (lower.length >= 2 && orient2d(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && orient2d(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  for (const q of lower.concat(upper)) u.push(q);
  return u.length ? u : [p[0]];
}
/// Do two convex polygons (or segments, or points) share a point other than a common boundary? Weak
/// separation by the exact orientation predicate: separated when some edge's line has one polygon on
/// its closed inner side and the other on its closed outer side. Touching at a vertex or along an edge
/// is separation -- adjacent pieces meet at their shared end, and that is not an overlap.
function overlaps(A, B) {
  return !separatedBy(A, B) && !separatedBy(B, A);
}
function separatedBy(A, B) {
  const n = A.length;
  if (n === 1) return false;
  if (n === 2) {
    // A segment: B on one closed side of its line.
    let pos = false,
      neg = false;
    for (const q of B) {
      const o = orient2d(A[0], A[1], q);
      if (o > 0) pos = true;
      else if (o < 0) neg = true;
    }
    if (!(pos && neg)) {
      // Collinear with the segment's line: separated along it unless the ranges overlap.
      if (!pos && !neg) return !collinearOverlap(A, B);
      return true;
    }
    return false;
  }
  for (let i = 0; i < n; i++) {
    const a = A[i],
      b = A[(i + 1) % n];
    let inside = false;
    for (const q of B)
      if (orient2d(a, b, q) > 0) {
        inside = true;
        break;
      }
    if (!inside) return true;
  }
  return false;
}
function collinearOverlap(A, B) {
  const dx = A[1][0] - A[0][0],
    dy = A[1][1] - A[0][1];
  const pr = (p) => (p[0] - A[0][0]) * dx + (p[1] - A[0][1]) * dy;
  const a0 = Math.min(pr(A[0]), pr(A[1])),
    a1 = Math.max(pr(A[0]), pr(A[1]));
  let b0 = Infinity,
    b1 = -Infinity;
  for (const q of B) {
    const v = pr(q);
    if (v < b0) b0 = v;
    if (v > b1) b1 = v;
  }
  return Math.min(a1, b1) > Math.max(a0, b0);
}
const bboxOf = (H) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of H) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
};

/// A piece the builder cannot give a side to: a curve whose ends coincide, or a cubic whose control
/// polygon is not a convex quadrilateral in order (its handles cross, so the rim through them would).
function needsHalving(s) {
  if (s.type === SEG_LINE) return false;
  const a = s.p1,
    b = endOf(s);
  if (a[0] === b[0] && a[1] === b[1]) return true;
  return false;
}
/// Is a cubic's control polygon not convex in order (its handles cross)? Only a CONCAVE piece's rim runs through
/// its control points, so only there does a fold make the rim cross itself.
function foldedCubic(s) {
  if (s.type !== SEG_CUBIC) return false;
  const P = [s.p1, s.p2, s.p3, s.p4];
  let pos = 0,
    neg = 0;
  for (let i = 0; i < 4; i++) {
    const o = orient2d(P[i], P[(i + 1) % 4], P[(i + 2) % 4]);
    if (o > 0) pos++;
    else if (o < 0) neg++;
  }
  return pos > 0 && neg > 0;
}

/// One float32 ulp at a point's magnitude: the spacing of the coordinates the curve table stores, and so
/// the resolution below which two outline points are the same point. Relative, never a distance.
const ulp32 = (p) => 2 ** -23 * Math.max(Math.abs(p[0]), Math.abs(p[1]));
const samePt = (a, b) => {
  const u = Math.max(ulp32(a), ulp32(b));
  return Math.abs(a[0] - b[0]) <= u && Math.abs(a[1] - b[1]) <= u;
};
/// A copy of `s` ending at `e`.
function withEnd(s, e) {
  const o = { ...s };
  if (s.type === SEG_CUBIC) o.p4 = e;
  else if (s.type === SEG_LINE) o.p2 = e;
  else o.p3 = e;
  return o;
}
/// Close up a contour's sub-ulp lines. An arc's end is computed (cos and sin, in float64) where the
/// subpath's start is read, so a `Z` after an arc draws a closing line a fraction of an ulp long (a pill:
/// 3.6e-7 at 40.5, a thirteenth of an ulp) -- which the arc's last control edge, collinear with the
/// outline past the start, then overlaps by that fraction, and the exact overlap test never separates
/// them: the pill declined as a crossing. A line within one float32 ulp of a point IS a point: it is
/// dropped, and the segment before it ends where it ended.
function closeUlpLines(c) {
  let out = null;
  for (let i = 0; i < c.length; i++) {
    const s = c[i];
    if (s.type === SEG_LINE && samePt(s.p1, s.p2) && (out ? out.length : i) > 0) {
      if (!out) out = c.slice(0, i);
      out[out.length - 1] = withEnd(out[out.length - 1], s.p2);
      continue;
    }
    if (out) out.push(s);
  }
  return out || c;
}

/// Cut a contour into its loops wherever it returns to a vertex it already passed through, and drop
/// zero-length lines (they carry no geometry, and a closing one would otherwise be a loop of its own).
/// Returns an array of contours. "The same vertex" is the same point AS THE MESH STORES IT, in float32: a
/// crossing that resolveSelfOverlap computed twice comes back as two float64 points a few ulps of float64
/// apart (the even-odd pentagram's spikes), which are one vertex of the stored mesh.
function splitPinches(c) {
  const key = (p) => Math.fround(p[0]) + ',' + Math.fround(p[1]);
  const out = [],
    segs = [],
    idx = new Map();
  let n = 0; // vertices on the open path
  for (const s of c) {
    const e = endOf(s);
    // A line from a vertex to the same vertex (the same float32 point: a `Z` after an arc, which ends a
    // fraction of an ulp from its subpath's start) carries no geometry and would be a loop of its own.
    if (s.type === SEG_LINE && key(s.p1) === key(e)) continue;
    if (!segs.length) {
      idx.clear();
      idx.set(key(s.p1), 0);
      n = 1;
    }
    segs.push(s);
    const k = key(e);
    if (idx.has(k)) {
      const i = idx.get(k);
      const loop = segs.splice(i);
      for (const [kk, v] of idx) if (v > i) idx.delete(kk);
      n = i + 1;
      out.push(loop);
    } else {
      idx.set(k, n++);
    }
  }
  if (segs.length) out.push(segs);
  return out;
}

/// Every pinched contour cut into its loops (splitPinches), or the same array when no contour returns to a
/// vertex it already passed through -- so a caller that applies it to every shape changes nothing on the
/// shapes it does not concern. Winding is additive over the loops, so the fill is unchanged under either
/// rule. (Uncut, three triangles sharing an apex, written as one subpath, would draw as one of them.)
export function cutPinches(contours) {
  if (!contours) return contours;
  let out = null;
  for (let i = 0; i < contours.length; i++) {
    const c = contours[i],
      parts = splitPinches(c);
    if (parts.length <= 1) {
      if (out) out.push(c);
      continue;
    }
    if (!out) out = contours.slice(0, i);
    for (const p of parts) out.push(p);
  }
  return out || contours;
}

/// The same curve, in either direction, control point for control point.
function sameCurve(a, b) {
  if (a.type !== b.type || (a.w || 1) !== (b.w || 1)) return false;
  const P = a.p4 ? [a.p1, a.p2, a.p3, a.p4] : [a.p1, a.p2, a.p3],
    Q = b.p4 ? [b.p1, b.p2, b.p3, b.p4] : [b.p1, b.p2, b.p3];
  const eq = (p, q) => !!p && !!q && p[0] === q[0] && p[1] === q[1];
  return P.every((p, i) => eq(p, Q[i])) || P.every((p, i) => eq(p, Q[Q.length - 1 - i]));
}

/// Does curve `c`'s chord lie along line `l` for a positive length? Exact: collinearity by the orientation
/// predicate, overlap by projection.
function chordOnLine(c, l) {
  const a = c.p1,
    b = endOf(c);
  if (orient2d(l.p1, l.p2, a) !== 0 || orient2d(l.p1, l.p2, b) !== 0) return false;
  return collinearOverlap([l.p1, l.p2], [a, b]);
}

/// Does an on-curve end of `s` lie on the boundary of the hull `H` of `o` (not at one of o's own ends)? Two
/// pieces that TOUCH there are weakly separated, so the overlap test passes them, but the outline meets
/// itself: a T-junction, which resolveSelfOverlap resolves and this module does not.
function touches(s, H, o) {
  const oa = o.p1,
    ob = endOf(o);
  for (const p of [s.p1, endOf(s)]) {
    if ((p[0] === oa[0] && p[1] === oa[1]) || (p[0] === ob[0] && p[1] === ob[1])) continue;
    for (let i = 0, n = H.length; i < n; i++) {
      const a = H[i],
        b = H[(i + 1) % n];
      if (orient2d(a, b, p) !== 0) continue;
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        t = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
      if (t >= 0 && t <= dx * dx + dy * dy) return true;
      if (n === 2) break;
    }
  }
  return false;
}

/// Returns `{ contours }` -- the input, or a new set with curves split, pinches cut and non-boundary
/// contours dropped -- or `{ decline }` with the reason the fast builder cannot draw it correctly:
/// 'loop', 'no side', 'crossing' (two pieces that never separate: the outline crosses itself), or
/// 'touch' (it meets itself at a point; not reported when `allowTouch`). A crossing or a touch is what
/// resolveSelfOverlap exists for, so the caller runs it and asks again, once.
/// `isStatic` is the builder's own flag (cubic degree reduction is static-only there, so here too).
export function resolveFastContours(contours, fillRule, isStatic, allowTouch = false) {
  if (!contours || !contours.length) return { contours };
  const evenodd = fillRule === 'evenodd';
  // ---- per segment: loops decline, cusps / inflections / loop double points split ----
  let cs = [];
  for (const cIn of contours) {
    const c = [],
      c0 = closeUlpLines(cIn);
    for (const s of c0) {
      // A curve whose control points all coincide is a point: no area, no edge -- nothing to draw.
      if (
        s.type !== SEG_LINE &&
        [s.p2, s.p3, s.p4].every((q) => !q || (q[0] === s.p1[0] && q[1] === s.p1[1]))
      )
        continue;
      // A curve whose control points are all ON its chord's line is a LINE: a folded one retraces its
      // overshoot in both directions, so it winds exactly as the straight edge does. Drawn as a curve it
      // has no crescent and no straight-edge strip, and nothing paints the outer half of its edge.
      if (s.type !== SEG_LINE && collinearCurve(s)) {
        const e = endOf(s);
        if (e[0] !== s.p1[0] || e[1] !== s.p1[1]) {
          const L = mkLine(s.p1, e);
          if (s.subStart) L.subStart = true;
          c.push(L);
        }
        continue;
      }
      if (s.type !== SEG_CUBIC) {
        c.push(s);
        continue;
      }
      const P = [s.p1, s.p2, s.p3, s.p4];
      if (isStatic && cubicDegreeReduce(P)) {
        c.push(s);
        continue;
      }
      const ct = cubicCuspT(s);
      if (ct < 0 && cubicLoop(P)) return { decline: 'loop' };
      const ts = cubicInflections(P).concat(cubicLoopCuts(P));
      if (ct >= 0) ts.push(ct);
      ts.sort((a, b) => a - b);
      for (const q of ts.length ? splitCubicSeg(s, ts) : [s]) c.push(q);
    }
    for (const p of splitPinches(c)) cs.push(p);
  }
  // ---- pieces without a side are halved first ----
  const depthOf = new Map();
  const halveFix = (c) => {
    const out = [];
    const work = [];
    for (let i = c.length - 1; i >= 0; i--) work.push([c[i], 0]);
    while (work.length) {
      const [s, d] = work.pop();
      if (needsHalving(s)) {
        if (d >= MAX_DEPTH) return null;
        const [a, b] = halve(s);
        work.push([b, d + 1], [a, d + 1]);
        continue;
      }
      depthOf.set(s, d);
      out.push(s);
    }
    return out;
  };
  for (let i = 0; i < cs.length; i++) {
    const f = halveFix(cs[i]);
    if (!f) return { decline: 'no side' };
    cs[i] = f;
  }
  // ---- overlap resolution: sweep by bbox x, halve the larger curve of any overlapping pair ----
  // Two curves that coincide never separate, and two a hair apart separate only near MAX_DEPTH, so halving them doubles the outline
  // round after round: a path of two copies of a three-cubic contour took 30 s. A copy declines the moment it is seen; the budget
  // catches the near copies. A crossing is what this outcome means to the caller: it resolves the outline or takes another route.
  let budget = -1;
  for (let round = 0; ; round++) {
    const els = [];
    cs.forEach((c, ci) =>
      c.forEach((s, si) => {
        const e = endOf(s);
        if (s.type === SEG_LINE && s.p1[0] === e[0] && s.p1[1] === e[1]) return; // zero-length: no extent
        const H = hullOf(s, isStatic);
        els.push({ ci, si, s, H, bb: bboxOf(H) });
      }),
    );
    if (budget < 0) budget = Math.max(1024, els.length * 16);
    if (els.length > budget) return { decline: 'crossing', pieces: els.length };
    els.sort((a, b) => a.bb[0] - b.bb[0]);
    const toSplit = new Set();
    for (let i = 0; i < els.length; i++) {
      const A = els[i];
      for (let j = i + 1; j < els.length && els[j].bb[0] <= A.bb[2]; j++) {
        const B = els[j];
        if (B.bb[1] > A.bb[3] || B.bb[3] < A.bb[1]) continue;
        if (!overlaps(A.H, B.H)) {
          if (!allowTouch && (touches(A.s, B.H, B.s) || touches(B.s, A.H, A.s)))
            return { decline: 'touch' };
          // A curve's chord on a straight edge. Touching along an edge tiles -- no pixel is painted twice --
          // but a convex crescent reaches to its chord and its coverage knows only its own curve, so where
          // the chord lies ON a line of the outline (a closed arch and its closing line, _fatcubic2) every
          // pixel along that line reads the curve's 1.0 instead of the line's ramp. Split the curve. (Two
          // curves sharing a chord, a lens, are left alone: the chord is not a boundary there. Nor is a
          // cusp's pair of control edges on its tangent line: they meet the other piece, not a line.)
          if (isCurve(A.s) && !isCurve(B.s) && chordOnLine(A.s, B.s)) toSplit.add(A.s);
          else if (isCurve(B.s) && !isCurve(A.s) && chordOnLine(B.s, A.s)) toSplit.add(B.s);
          continue;
        }
        if (!isCurve(A.s) && !isCurve(B.s)) return { decline: 'crossing' };
        if (sameCurve(A.s, B.s)) return { decline: 'crossing', pieces: els.length };
        const sa = isCurve(A.s) ? diag(A.bb) : -1,
          sb = isCurve(B.s) ? diag(B.bb) : -1;
        toSplit.add(sa >= sb ? A.s : B.s);
      }
    }
    if (!toSplit.size) break;
    for (let ci = 0; ci < cs.length; ci++) {
      if (!cs[ci].some((s) => toSplit.has(s))) continue;
      const out = [];
      for (const s of cs[ci]) {
        if (!toSplit.has(s)) {
          out.push(s);
          continue;
        }
        const d = (depthOf.get(s) | 0) + 1;
        if (d > MAX_DEPTH) return { decline: 'crossing' };
        for (const h of halve(s)) {
          depthOf.set(h, d);
          out.push(h);
        }
      }
      cs[ci] = out;
    }
  }
  // ---- each contour's fill side, exactly; drop the contours that are no boundary ----
  // Winding over CLOSED contours: an open one is filled as if closed, so close it for the count.
  const all = [];
  for (const c of cs) {
    for (const s of c) all.push(s);
    const e = endOf(c[c.length - 1]);
    if (e[0] !== c[0].p1[0] || e[1] !== c[0].p1[1])
      all.push({ type: SEG_LINE, p1: e, p2: c[0].p1 });
  }
  const inFill = (p) => {
    const w = rayWindingExact(all, p[0], p[1]);
    return evenodd ? (w & 1) !== 0 : w !== 0;
  };

  const kept = [],
    sides = [];
  for (const c of cs) {
    let best = null,
      bl = -1;
    for (const s of c) {
      const e = endOf(s),
        l = Math.hypot(e[0] - s.p1[0], e[1] - s.p1[1]);
      if (l > bl) {
        bl = l;
        best = s;
      }
    }
    if (!best || !(bl > 0)) {
      kept.push(c);
      sides.push(0);
      continue;
    }
    const [q, d] = pointAndTangent(best, 0.5);
    const L = Math.hypot(d[0], d[1]);
    if (!(L > 0)) {
      kept.push(c);
      sides.push(0);
      continue;
    }
    const eps = bl * 2 ** -20,
      nx = (-d[1] / L) * eps,
      ny = (d[0] / L) * eps;
    const l = inFill([q[0] + nx, q[1] + ny]),
      r = inFill([q[0] - nx, q[1] - ny]);
    if (l === r) continue;
    kept.push(c);
    sides.push(l ? 1 : -1);
  }
  {
    // A folded cubic is halved only where the fold matters: a concave piece, whose rim runs through its control
    // points. A convex piece's rim is its chord and its crescent is the control points' convex hull, which a fold
    // does not change. Done
    // now that the side is known; sub-hulls lie inside the parent's, so no overlap the sweep settled comes back.
    // Concave as buildRims decides it: the control points' midpoint on the fill side of the chord.
    for (let ci = 0; ci < kept.length; ci++) {
      const sd = sides[ci],
        out = [],
        src = kept[ci];
      let changed = false;
      const work = [];
      for (let i = src.length - 1; i >= 0; i--) work.push([src[i], depthOf.get(src[i]) | 0]);
      while (work.length) {
        const [q, d] = work.pop();
        if (foldedCubic(q) && !(isStatic && cubicDegreeReduce([q.p1, q.p2, q.p3, q.p4]))) {
          const m = [(q.p2[0] + q.p3[0]) / 2, (q.p2[1] + q.p3[1]) / 2],
            o = orient2d(q.p1, q.p4, m);
          if (sd === 0 || (o > 0 ? 1 : o < 0 ? -1 : 0) === sd) {
            if (d >= MAX_DEPTH) return { decline: 'no side' };
            const [a, b] = halve(q);
            work.push([b, d + 1], [a, d + 1]);
            changed = true;
            continue;
          }
        }
        out.push(q);
      }
      if (changed) kept[ci] = out;
    }
  }
  return { contours: kept, sides, inFill };
}
const diag = (bb) => Math.hypot(bb[2] - bb[0], bb[3] - bb[1]);

/// A point on a segment and its (unnormalized) tangent at t.
function pointAndTangent(s, t) {
  const u = 1 - t;
  if (s.type === SEG_LINE)
    return [
      [s.p1[0] + (s.p2[0] - s.p1[0]) * t, s.p1[1] + (s.p2[1] - s.p1[1]) * t],
      [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]],
    ];
  if (s.type === SEG_CUBIC) {
    const [a, b, c, d] = [s.p1, s.p2, s.p3, s.p4];
    const p = [0, 1].map(
      (k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k],
    );
    const v = [0, 1].map(
      (k) => 3 * (u * u * (b[k] - a[k]) + 2 * u * t * (c[k] - b[k]) + t * t * (d[k] - c[k])),
    );
    return [p, v];
  }
  // Rational quad N(t) / D(t): B' = (N' - B D') / D.
  const w = s.type === SEG_RQUAD ? s.w || 1 : 1,
    a = s.p1,
    b = s.p2,
    c = s.p3;
  const D = u * u + 2 * u * t * w + t * t,
    dD = -2 * u + 2 * w * (u - t) + 2 * t;
  const p = [0, 1].map((k) => (u * u * a[k] + 2 * u * t * w * b[k] + t * t * c[k]) / D);
  const v = [0, 1].map(
    (k) => (-2 * u * a[k] + 2 * w * (u - t) * b[k] + 2 * t * c[k] - p[k] * dD) / D,
  );
  return [p, v];
}

/// THE CORRECT BUILD'S CHAIN FACES, built for its own input. lbFastMesh's interiorChainsFromTris
/// serves the partition too and is being reworked there; this is the same construction, face for
/// face and float for float, specialized to what the correct build hands it:
///
///   - VERTICES BY DENSE ID. The rim triangulation's faces and the chain edges share a small vertex set, so each
///     quantized vertex key gets a dense integer once and every edge pair is one number (id * 2^26 + id) --
///     where the general builder builds a string per pair for every "is this edge spanned" question, and keeps
///     its side map as a map of maps.
///   - NEAR EDGES BY BOUNDING BOX. A face's outline reach (an edge within R_NEAR of a side) is decided by the
///     same distance test, asked only of edges whose box comes within R_NEAR of the face's: an edge with an end
///     within R_NEAR of a side lies in that side's box grown by R_NEAR, so the box test rejects nothing the
///     distance test would take (it is widened by a thousandth to stay clear of rounding). Order is kept, so the
///     touched set is the same set in the same order.
///   - NO DIAGNOSTIC HOOKS (the general builder's __lbChainTrace and __CHAIN_DEBUG).
///
export function rimChainsFromTris(coords, tris, edges) {
  const chainA = new Float32Array(tris.length * 4); // P0, P1
  const chainB = new Float32Array(tris.length * 4); // P2, P3
  const chainC = new Float32Array(tris.length * 4); // P4, P5
  const chainD = new Float32Array(tris.length * 4); // CHAIN 2: Q0, Q1 → aC1
  const chainE = new Float32Array(tris.length * 4); // CHAIN 2: Q2, Q3 → aC2
  const badFaces = new Uint8Array((tris.length / 3) | 0);
  let incomplete = false,
    hasChain2 = false;
  if (!edges || !edges.length)
    return { chainA, chainB, chainC, chainD, chainE, incomplete, hasChain2, badFaces };
  // VERTEX IDS, carried: every point this builder handles is an edge end (whose ids are taken once, here) or a
  // face corner (keyed once per face), so no point is ever looked up by identity again.
  const idOfKey = new Map();
  const idAt = (x, y) => {
    const k =
      Math.round((Math.fround(x) - _kox) * _koScale) * 2097152 +
      Math.round((Math.fround(y) - _koy) * _koScale);
    let v = idOfKey.get(k);
    if (v === undefined) {
      v = idOfKey.size;
      idOfKey.set(k, v);
    }
    return v;
  };
  // A directed pair of ids is one number, a*PAIR+b. The only points this call meets are edge ends and face corners,
  // so ids stay under 2*edges + corners; under 2^15 the pair is a small integer, which the maps and sets below hash
  // fastest. Otherwise (and past that) 2^26, exact to 2^52.
  const nE = edges.length;
  const PAIR = 2 * nE + tris.length < 32768 ? 32768 : 67108864;
  const ea = new Int32Array(nE),
    eb = new Int32Array(nE);
  const sideMap = new Map(); // directed pair -> edge index (both directions, last write wins)
  const vertEdges = []; // id -> [edge indices], in edge order
  for (let i = 0; i < nE; i++) {
    const e = edges[i];
    // A chain's consecutive edges share their point arrays, and the same array is the same key.
    const k1 = i > 0 && e.p1 === edges[i - 1].p2 ? eb[i - 1] : idAt(e.p1[0], e.p1[1]),
      k2 = idAt(e.p2[0], e.p2[1]);
    ea[i] = k1;
    eb[i] = k2;
    sideMap.set(k1 * PAIR + k2, i);
    sideMap.set(k2 * PAIR + k1, i);
    (vertEdges[k1] || (vertEdges[k1] = [])).push(i);
    (vertEdges[k2] || (vertEdges[k2] = [])).push(i);
  }
  const sideGet = (a, b) => sideMap.get(a * PAIR + b); // an edge INDEX, or undefined
  const edgesAt = (v) => vertEdges[v] || EMPTY;
  const ekeyOf = (i) => ea[i] * PAIR + eb[i];
  // Orient edge i so FILL is on the LEFT of A→B (lbFastMesh orientLeft): [A, B, idA, idB].
  const orientLeft = (i, cen) => {
    const e = edges[i],
      dx = e.p2[0] - e.p1[0],
      dy = e.p2[1] - e.p1[1];
    if (cen) {
      const cr = dx * (cen[1] - e.p1[1]) - dy * (cen[0] - e.p1[0]);
      const scale = Math.hypot(dx, dy) * (Math.hypot(cen[0] - e.p1[0], cen[1] - e.p1[1]) || 1);
      if (scale > 0 && Math.abs(cr) > 1e-9 * scale)
        return cr > 0 ? [e.p1, e.p2, ea[i], eb[i]] : [e.p2, e.p1, eb[i], ea[i]];
    }
    return -dy * e.nx + dx * e.ny < 0 ? [e.p1, e.p2, ea[i], eb[i]] : [e.p2, e.p1, eb[i], ea[i]];
  };
  let _cx0 = Infinity,
    _cy0 = Infinity,
    _cx1 = -Infinity,
    _cy1 = -Infinity;
  for (const q of coords) {
    if (!q) continue;
    if (q[0] < _cx0) _cx0 = q[0];
    if (q[0] > _cx1) _cx1 = q[0];
    if (q[1] < _cy0) _cy0 = q[1];
    if (q[1] > _cy1) _cy1 = q[1];
  }
  const R_EXT = _cx1 >= _cx0 ? Math.max(_cx1 - _cx0, _cy1 - _cy0) || 1 : 1;
  const R_REACH = (mantleDebugHook('__LB_R_REACH') || 0.01) * R_EXT,
    R_TURN = mantleDebugHook('__LB_R_TURN') || 0.45,
    R_HOPS = mantleDebugHook('__LB_R_HOPS') || 8;
  const R_MICRO = 0.005 * R_EXT;
  // Returns [{pt, id, ek}] chunks in walk order (ek = edge indices absorbed since the previous point).
  const walkOut = (vk0, exclude, backward, maxPts = 1, cen = null) => {
    let vk = vk0,
      cur = null,
      curId = -1,
      span = 0,
      turn = 0,
      chordSpan = 0,
      pdx = 0,
      pdy = 0;
    const seen = new Set();
    let ek = [];
    const out = [];
    for (let h = 0; h < R_HOPS; h++) {
      let next = null,
        nextId = -1,
        edge = -1,
        from = null;
      for (const i of edgesAt(vk)) {
        if (exclude.has(i) || seen.has(i)) continue;
        const s = orientLeft(i, cen);
        if (backward ? s[3] === vk : s[2] === vk) {
          next = backward ? s[0] : s[1];
          nextId = backward ? s[2] : s[3];
          from = backward ? s[1] : s[0];
          edge = i;
          break;
        }
      }
      if (!next) break;
      const dx = next[0] - from[0],
        dy = next[1] - from[1],
        L = Math.hypot(dx, dy);
      if (L > 1e-12 * R_EXT) {
        if (cur) {
          const dot = (pdx * dx + pdy * dy) / L;
          turn += Math.acos(Math.max(-1, Math.min(1, dot)));
          if (turn > R_TURN) {
            if (chordSpan > R_MICRO || out.length + 1 >= maxPts) break;
            out.push({ pt: cur, id: curId, ek });
            ek = [];
            turn = 0;
            chordSpan = 0;
          }
        }
        pdx = dx / L;
        pdy = dy / L;
        span += L;
        chordSpan += L;
      }
      seen.add(edge);
      ek.push(edge);
      cur = next;
      curId = nextId;
      vk = nextId;
      if (span >= R_REACH) break;
    }
    if (cur) out.push({ pt: cur, id: curId, ek });
    return out.length ? out : null;
  };
  const precede = (vk, exclude, maxPts, cen) => walkOut(vk, exclude, true, maxPts, cen);
  const follow = (vk, exclude, maxPts, cen) => walkOut(vk, exclude, false, maxPts, cen);
  // Link oriented sides into one chain: {pts, ids}.
  const orderChain = (ss) => {
    const n = ss.length;
    if (!n) return { pts: [], ids: [] };
    if (n === 1) {
      const s = ss[0];
      return { pts: [s[0], s[1]], ids: [s[2], s[3]] };
    }
    let startIdx = 0;
    for (let i = 0; i < n; i++) {
      const id = ss[i][2];
      let isEnd = false;
      for (let j = 0; j < n; j++) {
        if (ss[j][3] === id) {
          isEnd = true;
          break;
        }
      }
      if (!isEnd) {
        startIdx = i;
        break;
      }
    }
    const used = new Uint8Array(n);
    used[startIdx] = 1;
    let cur = ss[startIdx];
    const pts = [cur[0], cur[1]],
      ids = [cur[2], cur[3]];
    for (let step = 1; step < n; step++) {
      let nxIdx = -1;
      for (let j = 0; j < n; j++) {
        if (!used[j] && ss[j][2] === cur[3]) {
          nxIdx = j;
          break;
        }
      }
      if (nxIdx < 0) break;
      used[nxIdx] = 1;
      cur = ss[nxIdx];
      pts.push(cur[1]);
      ids.push(cur[3]);
    }
    return { pts, ids };
  };
  const R_NEAR = (mantleDebugHook('__LB_R_NEAR') || 0.006) * R_EXT;
  const segSegNear = (a1, a2, b1, b2, r) => {
    const d2 = (p, q1, q2) => {
      const dx = q2[0] - q1[0],
        dy = q2[1] - q1[1];
      const L2 = dx * dx + dy * dy || 1e-30;
      const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
      const cx = q1[0] + t * dx - p[0],
        cy = q1[1] + t * dy - p[1];
      return cx * cx + cy * cy;
    };
    const rr = r * r;
    return (
      d2(a1, b1, b2) <= rr || d2(a2, b1, b2) <= rr || d2(b1, a1, a2) <= rr || d2(b2, a1, a2) <= rr
    );
  };
  const ebox = new Float64Array(nE * 4);
  for (let i = 0; i < nE; i++) {
    const e = edges[i];
    ebox[4 * i] = Math.min(e.p1[0], e.p2[0]);
    ebox[4 * i + 1] = Math.min(e.p1[1], e.p2[1]);
    ebox[4 * i + 2] = Math.max(e.p1[0], e.p2[0]);
    ebox[4 * i + 3] = Math.max(e.p1[1], e.p2[1]);
  }
  const RB = R_NEAR * 1.001;
  const touchedFor = (K, own, P) => {
    const es = new Set(own);
    for (const vk of K) for (const i of edgesAt(vk)) es.add(i);
    const fx0 = Math.min(P[0][0], P[1][0], P[2][0]) - RB,
      fx1 = Math.max(P[0][0], P[1][0], P[2][0]) + RB;
    const fy0 = Math.min(P[0][1], P[1][1], P[2][1]) - RB,
      fy1 = Math.max(P[0][1], P[1][1], P[2][1]) + RB;
    for (let i = 0; i < nE; i++) {
      if (
        ebox[4 * i] > fx1 ||
        ebox[4 * i + 2] < fx0 ||
        ebox[4 * i + 1] > fy1 ||
        ebox[4 * i + 3] < fy0
      )
        continue;
      if (es.has(i)) continue;
      const e = edges[i];
      for (let s2 = 0; s2 < 3; s2++) {
        if (segSegNear(e.p1, e.p2, P[s2], P[(s2 + 1) % 3], R_NEAR)) {
          es.add(i);
          break;
        }
      }
    }
    return [...es];
  };
  const chainEdgeKeys = (ids) => {
    const s = new Set();
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i],
        b = ids[i + 1];
      if (a === b) continue;
      s.add(a * PAIR + b);
      s.add(b * PAIR + a);
    }
    return s;
  };
  const groupRuns = (list) => {
    if (!list.length) return [];
    const parent = list.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const firstAt = new Map();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const k1 = ea[e],
        j1 = firstAt.get(k1);
      if (j1 === undefined) firstAt.set(k1, i);
      else {
        const ra = find(i),
          rb = find(j1);
        if (ra !== rb) parent[ra] = rb;
      }
      const k2 = eb[e],
        j2 = firstAt.get(k2);
      if (j2 === undefined) firstAt.set(k2, i);
      else {
        const ra = find(i),
          rb = find(j2);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    const byRoot = new Map();
    list.forEach((e, i) => {
      const r = find(i);
      let g = byRoot.get(r);
      if (!g) byRoot.set(r, (g = []));
      g.push(e);
    });
    return [...byRoot.values()];
  };
  const runNearCen = (runs, cen) => {
    let best = runs[0],
      bd = Infinity;
    for (const r of runs) {
      let d = Infinity;
      for (const i of r) {
        const e = edges[i];
        for (const p of [e.p1, e.p2]) {
          const dx = p[0] - cen[0],
            dy = p[1] - cen[1];
          d = Math.min(d, dx * dx + dy * dy);
        }
      }
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  };
  // Window n points of a run around the face: {pts, ids, keys}.
  const nearWindow = (pts, ids, n, cen) => {
    if (pts.length <= n) {
      const ks = new Set();
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = ids[i],
          b = ids[i + 1];
        ks.add(a * PAIR + b);
        ks.add(b * PAIR + a);
      }
      return { pts, ids, keys: ks };
    }
    let best = 0,
      bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - cen[0],
        dy = pts[i][1] - cen[1],
        d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const nc = n - 2;
    const lo = Math.max(0, Math.min(pts.length - nc, best - (nc >> 1)));
    const hi = lo + nc - 1;
    const walkList = (idx, dir) => {
      let span = 0,
        turn = 0,
        i = idx,
        pdx = 0,
        pdy = 0,
        first = true;
      for (;;) {
        const j = i + dir;
        if (j < 0 || j >= pts.length) break;
        const dx = pts[j][0] - pts[i][0],
          dy = pts[j][1] - pts[i][1],
          L = Math.hypot(dx, dy);
        if (L > 1e-12 * R_EXT) {
          if (!first) {
            const dot = (pdx * dx + pdy * dy) / L;
            turn += Math.acos(Math.max(-1, Math.min(1, dot)));
            if (turn > R_TURN) break;
          }
          pdx = dx / L;
          pdy = dy / L;
          span += L;
          first = false;
        }
        i = j;
        if (span >= R_REACH) break;
      }
      return i;
    };
    const pLo = walkList(lo, -1),
      pHi = walkList(hi, +1);
    const out = [],
      oid = [];
    if (pLo < lo) {
      out.push(pts[pLo]);
      oid.push(ids[pLo]);
    }
    for (let i = lo; i <= hi; i++) {
      out.push(pts[i]);
      oid.push(ids[i]);
    }
    if (pHi > hi) {
      out.push(pts[pHi]);
      oid.push(ids[pHi]);
    }
    const keys = new Set();
    for (let i = pLo; i < pHi; i++) {
      const a = ids[i],
        b = ids[i + 1];
      keys.add(a * PAIR + b);
      keys.add(b * PAIR + a);
    }
    return { pts: out, ids: oid, keys };
  };
  for (let t = 0; t < tris.length; t += 3) {
    const P = [coords[tris[t]], coords[tris[t + 1]], coords[tris[t + 2]]];
    const K = [idAt(P[0][0], P[0][1]), idAt(P[1][0], P[1][1]), idAt(P[2][0], P[2][1])];
    const cen = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
    const sides = [];
    const own = new Set();
    for (let s = 0; s < 3; s++) {
      const i = sideGet(K[s], K[(s + 1) % 3]);
      if (i !== undefined && !own.has(i)) {
        own.add(i);
        sides.push(orientLeft(i, cen));
      }
    }
    const touched = touchedFor(K, own, P);
    if (!touched.length) continue; // true deep interior → all-zero → 1
    const walked = new Set();
    let pts, ids;
    if (sides.length) {
      const chain = orderChain(sides);
      const budget = Math.max(0, 5 - chain.pts.length);
      const preL = budget ? precede(chain.ids[0], own, budget, cen) : null;
      const postL = budget ? follow(chain.ids[chain.ids.length - 1], own, budget, cen) : null;
      const d2cen = (p) => {
        const dx = p[0] - cen[0],
          dy = p[1] - cen[1];
        return dx * dx + dy * dy;
      };
      let nPre = 0,
        nPost = 0;
      if (preL && budget >= 1 && (budget >= 2 || !postL)) nPre = 1;
      if (postL && budget >= 1 && (budget >= 2 || !preL)) nPost = 1;
      let spare = budget - nPre - nPost;
      while (spare > 0) {
        const da = preL && nPre < preL.length ? d2cen(preL[nPre].pt) : Infinity;
        const db = postL && nPost < postL.length ? d2cen(postL[nPost].pt) : Infinity;
        if (da === Infinity && db === Infinity) break;
        if (da <= db) nPre++;
        else nPost++;
        spare--;
      }
      pts = [];
      ids = [];
      for (let i = nPre - 1; i >= 0; i--) {
        pts.push(preL[i].pt);
        ids.push(preL[i].id);
      }
      for (let i = 0; i < chain.pts.length; i++) {
        pts.push(chain.pts[i]);
        ids.push(chain.ids[i]);
      }
      for (let i = 0; i < nPost; i++) {
        pts.push(postL[i].pt);
        ids.push(postL[i].id);
      }
      for (let i = 0; i < nPre; i++) for (const e of preL[i].ek) walked.add(ekeyOf(e));
      for (let i = 0; i < nPost; i++) for (const e of postL[i].ek) walked.add(ekeyOf(e));
    } else {
      const runs = groupRuns(touched);
      let best = runs[0];
      for (const r of runs) if (r.length > best.length) best = r;
      const oc = orderChain(best.map((i) => orientLeft(i, cen)));
      const w1 = nearWindow(oc.pts, oc.ids, 5, cen);
      pts = w1.pts.map((p) => p.slice());
      ids = w1.ids.slice();
      for (const k of w1.keys) walked.add(k);
    }
    const c1keys = chainEdgeKeys(ids);
    const rem = touched.filter((i) => {
      const k = ekeyOf(i);
      return !c1keys.has(k) && !walked.has(k);
    });
    let pts2 = null,
      leftover = rem;
    if (rem.length) {
      const run = orderChain(runNearCen(groupRuns(rem), cen).map((i) => orientLeft(i, cen)));
      const runPts = run.pts,
        runIds = run.ids;
      const remSet = new Set(rem);
      if (runPts.length) {
        const fol2 = follow(runIds[runIds.length - 1], remSet, 4, cen);
        if (fol2)
          for (const c of fol2) {
            runPts.push(c.pt);
            runIds.push(c.id);
          }
        const pre2 = precede(runIds[0], remSet, 4, cen);
        if (pre2)
          for (let i = 0; i < pre2.length; i++) {
            runPts.unshift(pre2[i].pt);
            runIds.unshift(pre2[i].id);
          }
      }
      const w2 = nearWindow(runPts, runIds, 4, cen);
      pts2 = w2.pts.map((p) => p.slice());
      const c2keys = chainEdgeKeys(w2.ids);
      leftover = rem.filter((i) => {
        const k = ekeyOf(i);
        return !c2keys.has(k) && !w2.keys.has(k);
      });
    }
    if (leftover.length) {
      incomplete = true;
      badFaces[(t / 3) | 0] = 1;
    }
    while (pts.length < 6) pts.push(pts[pts.length - 1]);
    const q = pts2 || [];
    while (q.length && q.length < 4) q.push(q[q.length - 1]);
    if (pts2) hasChain2 = true;
    for (let k = 0; k < 3; k++) {
      const o = (t + k) * 4;
      chainA[o] = pts[0][0];
      chainA[o + 1] = pts[0][1];
      chainA[o + 2] = pts[1][0];
      chainA[o + 3] = pts[1][1];
      chainB[o] = pts[2][0];
      chainB[o + 1] = pts[2][1];
      chainB[o + 2] = pts[3][0];
      chainB[o + 3] = pts[3][1];
      chainC[o] = pts[4][0];
      chainC[o + 1] = pts[4][1];
      chainC[o + 2] = 2.0;
      chainC[o + 3] = 0.0;
      if (q.length) {
        chainD[o] = q[0][0];
        chainD[o + 1] = q[0][1];
        chainD[o + 2] = q[1][0];
        chainD[o + 3] = q[1][1];
        chainE[o] = q[2][0];
        chainE[o + 1] = q[2][1];
        chainE[o + 2] = q[3][0];
        chainE[o + 3] = q[3][1];
      }
    }
  }
  return { chainA, chainB, chainC, chainD, chainE, incomplete, hasChain2, badFaces };
}
const EMPTY = Object.freeze([]);
