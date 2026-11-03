// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bezierClip.js — exact curve×curve intersection via Bezier clipping
// (Sederberg & Nishita, "Curve intersection using Bezier clipping",
// CAD 1990). Used by quad×cubic, cubic×cubic, and via specialized
// kernels for arc cases.
//
// Algorithm:

//   When clipping fails to shrink either range significantly, subdivide
//   the curve with the larger remaining range in half and recurse on
//   each half against B. Termination: ranges narrow to within EPS,
//   then a single intersection is recorded.
//
// Returns intersection records `{ tA, tB, x, y, endpointA, endpointB }`.

import { sameCurveHits } from './intersect/coincident.js';

const EPS_RANGE = 1e-7;
const DEDUPE_T = 1e-4; // two reports are the same root within this in both parameters
const EPS = 1e-9;
const MIN_SHRINK = 0.2; // need to shrink by ≥20% per pair of clips
const MAX_DEPTH = 50;
// TOTAL NODES, BECAUSE DEPTH IS NOT A BOUND ON WORK. Every non-shrinking step subdivides and
// recurses on both halves, so the tree branches -- and MAX_DEPTH alone admits 2^50 of these. The
// comment below it claims the subdivision "prevents exponential branching"; it chooses which range
// to split, which keeps the tree shallow, and does not stop it being a tree.

// A node budget rather than a clock, because the result has to be DETERMINISTIC: the conversion is
// cached and must be deterministic, so the same input must give the
// same intersections on every machine and every run. Traversal order is fixed, so a budget is.
//
const MAX_NODES = 200000;
let _nodes = 0;

// AND THE REAL GUARANTEE IS BEZOUT'S, NOT A BUDGET. Two Bezier curves of degree <= 3 that are not
// the same curve meet in AT MOST 9 POINTS: their implicits are degree 3, and 3 x 3 = 9. So a
// recursion that has already found far more than nine distinct crossings is not counting crossings
// -- it is SAMPLING A CONTINUUM, which is the one configuration where no subdivision scheme can
// converge. Every node contains roots, so nothing is ever pruned, and the tree runs to its depth
// limit in full.

// Returning nothing for such a pair is the established contract, not a new policy: the whole-curve
// case (controlPointsCoincide) already returns empty, and cpatchGraph independently drops any pair
// reporting more than MAX_PAIR_HITS = 9 for the same stated reason -- "coincident curves have no
// isolated crossing to cut at, and cutting at sampled points of an overlap invents structure the
// geometry does not have". This moves that judgment to where it can also stop the work.

const MAX_ROOTS = 9;
let _coincide = false;

/// Diagnostic: calls that ran out of NODE budget, and calls that detected a continuum. The first
/// should be zero -- if it is not, some pair explodes without emitting and wants its own look.
export function bezierClipBudgetHits() {
  return _hits;
}
export function bezierClipCoincideHits() {
  return _coincideHits;
}
let _hits = 0,
  _coincideHits = 0;

function sharedEnds(ctrlA, ctrlB) {
  const out = [];
  const nA = ctrlA.length - 1,
    nB = ctrlB.length - 1;
  for (const ia of [0, nA])
    for (const ib of [0, nB]) {
      const a = ctrlA[ia],
        b = ctrlB[ib];
      if (a[0] !== b[0] || a[1] !== b[1]) continue;
      out.push({
        tA: ia ? 1 : 0,
        tB: ib ? 1 : 0,
        x: a[0],
        y: a[1],
        endpointA: true,
        endpointB: true,
      });
    }
  return out;
}

export function intersectBezierClip(ctrlA, ctrlB) {
  const same = sameCurveHits(ctrlA, ctrlB);
  if (same) return same;
  const out = sharedEnds(ctrlA, ctrlB);
  _nodes = MAX_NODES;
  _coincide = false;
  recurse(ctrlA, 0, 1, ctrlB, 0, 1, 0, out);
  if (_nodes <= 0) _hits++;
  if (_coincide) {
    _coincideHits++;
    return [];
  }
  return dedupe(out);
}

function recurse(ctrlA, s0, s1, ctrlB, t0, t1, depth, out) {
  if (depth > MAX_DEPTH || _nodes-- <= 0 || _coincide) return;
  //
  // KNOWN DEFECT, LEFT IN PLACE: this runs at every node, before the
  // convergence test, on sub-curves already zoomed onto a crossing, and its
  // 1e-7 is absolute. Two pieces shrinking onto any crossing pass it, so the
  // crossing is dropped: 16% of 90-degree crossings found, 7% at half a
  // degree; firing only at depth 0 finds 100% down to 0.1 degree. Every
  // arrangement builder routes around it with exact implicit composition
  // (intersect/exact.js for unions, exactCrossings in cpatchGraph). Changing
  // it moves the Loop-Blinn and CPatch cut points.
  if (controlPointsCoincide(ctrlA, ctrlB)) return;
  const sRange = s1 - s0;
  const tRange = t1 - t0;

  // Termination — both ranges narrow.
  if (sRange < EPS_RANGE && tRange < EPS_RANGE) {
    const sMid = 0.5 * (s0 + s1);
    const tMid = 0.5 * (t0 + t1);
    const pA = evalBezier(ctrlA, 0.5);
    const pB = evalBezier(ctrlB, 0.5);
    // Reject false hits: the two evaluations must agree.
    if (Math.hypot(pA[0] - pB[0], pA[1] - pB[1]) > 1e-3) return;
    // Endpoint epsilon must be looser than the recursion's
    // EPS_RANGE so that an intersection at exactly t=0 or t=1
    // (after Bezier-clipping converged in finite recursion to a
    // tiny but nonzero offset) is still classified as an endpoint.
    const EP_EPS = 1e-5;
    // DEDUPE'S own PREDICATE, applied on arrival. The list stays deduped, so `out.length` IS the
    // distinct-root count and the Bezout test below is exact rather than approximate.
    for (const prev of out)
      if (Math.abs(prev.tA - sMid) < DEDUPE_T && Math.abs(prev.tB - tMid) < DEDUPE_T) return;
    if (out.length >= MAX_ROOTS) {
      _coincide = true;
      return;
    }
    out.push({
      tA: sMid,
      tB: tMid,
      x: 0.5 * (pA[0] + pB[0]),
      y: 0.5 * (pA[1] + pB[1]),
      endpointA: sMid < EP_EPS || sMid > 1 - EP_EPS,
      endpointB: tMid < EP_EPS || tMid > 1 - EP_EPS,
    });
    return;
  }

  // Bounding-box reject.
  if (!bboxOverlap(ctrlA, ctrlB)) return;

  // Clip A against B's fat-line. The result is a sub-range of [0, 1]
  // on A's local parameter; null means A is entirely outside the strip.
  const aClip = clipAgainstFatLine(ctrlA, ctrlB);
  if (!aClip) return;
  const [aLo, aHi] = aClip;
  const newSRange = (aHi - aLo) * sRange;
  // If A shrank a lot, just use the new range and swap to clip B.
  // If A didn't shrink, subdivide A in half (no recursion-doubling)
  // and recurse on each half against B.
  if (aHi - aLo > 1 - MIN_SHRINK) {
    // Less than MIN_SHRINK reduction; subdivide whichever range is
    // larger. Prevents exponential branching at tangent/multi-root
    // configurations.
    if (sRange >= tRange) {
      const sMid = 0.5 * (s0 + s1);
      const aLoSub = subCurve(ctrlA, 0, 0.5);
      const aHiSub = subCurve(ctrlA, 0.5, 1);
      recurse(aLoSub, s0, sMid, ctrlB, t0, t1, depth + 1, out);
      recurse(aHiSub, sMid, s1, ctrlB, t0, t1, depth + 1, out);
      return;
    } else {
      const tMid = 0.5 * (t0 + t1);
      const bLoSub = subCurve(ctrlB, 0, 0.5);
      const bHiSub = subCurve(ctrlB, 0.5, 1);
      recurse(ctrlA, s0, s1, bLoSub, t0, tMid, depth + 1, out);
      recurse(ctrlA, s0, s1, bHiSub, tMid, t1, depth + 1, out);
      return;
    }
  }
  // A shrank substantially. Reduce A to the clipped range.
  const aSub = subCurve(ctrlA, aLo, aHi);
  const newS0 = s0 + aLo * sRange;
  const newS1 = s0 + aHi * sRange;

  // Now clip B against A's (newly tight) fat-line.
  const bClip = clipAgainstFatLine(ctrlB, aSub);
  if (!bClip) return;
  const [bLo, bHi] = bClip;
  if (bHi - bLo > 1 - MIN_SHRINK) {
    // B didn't shrink — subdivide whichever is larger.
    if (newS1 - newS0 >= tRange) {
      const sMid = 0.5 * (newS0 + newS1);
      const aLoSub = subCurve(aSub, 0, 0.5);
      const aHiSub = subCurve(aSub, 0.5, 1);
      recurse(aLoSub, newS0, sMid, ctrlB, t0, t1, depth + 1, out);
      recurse(aHiSub, sMid, newS1, ctrlB, t0, t1, depth + 1, out);
      return;
    } else {
      const tMid = 0.5 * (t0 + t1);
      const bLoSub = subCurve(ctrlB, 0, 0.5);
      const bHiSub = subCurve(ctrlB, 0.5, 1);
      recurse(aSub, newS0, newS1, bLoSub, t0, tMid, depth + 1, out);
      recurse(aSub, newS0, newS1, bHiSub, tMid, t1, depth + 1, out);
      return;
    }
  }
  const bSub = subCurve(ctrlB, bLo, bHi);
  const newT0 = t0 + bLo * tRange;
  const newT1 = t0 + bHi * tRange;
  recurse(aSub, newS0, newS1, bSub, newT0, newT1, depth + 1, out);
}

// AABB rejection: if control polygons' axis-aligned bounds don't
// overlap, no intersection.
function bboxOverlap(ctrlA, ctrlB) {
  let aXmin = +Infinity,
    aYmin = +Infinity,
    aXmax = -Infinity,
    aYmax = -Infinity;
  for (const p of ctrlA) {
    if (p[0] < aXmin) aXmin = p[0];
    if (p[0] > aXmax) aXmax = p[0];
    if (p[1] < aYmin) aYmin = p[1];
    if (p[1] > aYmax) aYmax = p[1];
  }
  let bXmin = +Infinity,
    bYmin = +Infinity,
    bXmax = -Infinity,
    bYmax = -Infinity;
  for (const p of ctrlB) {
    if (p[0] < bXmin) bXmin = p[0];
    if (p[0] > bXmax) bXmax = p[0];
    if (p[1] < bYmin) bYmin = p[1];
    if (p[1] > bYmax) bYmax = p[1];
  }
  return (
    aXmin <= bXmax + EPS && bXmin <= aXmax + EPS && aYmin <= bYmax + EPS && bYmin <= aYmax + EPS
  );
}

// De Casteljau evaluation at parameter t.
function evalBezier(ctrl, t) {
  const n = ctrl.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = ctrl[i][0];
    ys[i] = ctrl[i][1];
  }
  for (let level = 1; level < n; level++) {
    for (let i = 0; i < n - level; i++) {
      xs[i] = xs[i] + t * (xs[i + 1] - xs[i]);
      ys[i] = ys[i] + t * (ys[i + 1] - ys[i]);
    }
  }
  return [xs[0], ys[0]];
}

// De Casteljau split at t; returns [leftHalf, rightHalf] each with
// same degree as input.
function splitAt(ctrl, t) {
  const n = ctrl.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = ctrl[i][0];
    ys[i] = ctrl[i][1];
  }
  const left = new Array(n);
  const right = new Array(n);
  left[0] = [xs[0], ys[0]];
  right[n - 1] = [xs[n - 1], ys[n - 1]];
  for (let level = 1; level < n; level++) {
    for (let i = 0; i < n - level; i++) {
      xs[i] = xs[i] + t * (xs[i + 1] - xs[i]);
      ys[i] = ys[i] + t * (ys[i + 1] - ys[i]);
    }
    left[level] = [xs[0], ys[0]];
    right[n - 1 - level] = [xs[n - 1 - level], ys[n - 1 - level]];
  }
  return [left, right];
}

// Extract a Bezier sub-curve over [u, v] ⊂ [0, 1].
function subCurve(ctrl, u, v) {
  if (u < EPS && v > 1 - EPS) return ctrl;
  if (u < EPS) return splitAt(ctrl, v)[0];
  const right = splitAt(ctrl, u)[1];
  if (v > 1 - EPS) return right;
  const vLocal = (v - u) / (1 - u);
  return splitAt(right, vLocal)[0];
}

// Fat-line of curve B: signed-distance bounds of its interior control
// points from its chord.
function fatLine(ctrlB) {
  const p0 = ctrlB[0];
  const pN = ctrlB[ctrlB.length - 1];
  const dx = pN[0] - p0[0];
  const dy = pN[1] - p0[1];
  const len = Math.hypot(dx, dy);
  let nx, ny;
  if (len < EPS) {
    let pickDx = 0,
      pickDy = 0;
    for (let i = 1; i < ctrlB.length; i++) {
      const dxi = ctrlB[i][0] - p0[0];
      const dyi = ctrlB[i][1] - p0[1];
      const lenI = Math.hypot(dxi, dyi);
      if (lenI > EPS) {
        pickDx = dxi / lenI;
        pickDy = dyi / lenI;
        break;
      }
    }
    nx = -pickDy;
    ny = pickDx;
  } else {
    nx = -dy / len;
    ny = dx / len;
  }
  let dMin = 0,
    dMax = 0;
  for (let i = 1; i < ctrlB.length - 1; i++) {
    const d = nx * (ctrlB[i][0] - p0[0]) + ny * (ctrlB[i][1] - p0[1]);
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  return { nx, ny, dMin, dMax, p0x: p0[0], p0y: p0[1] };
}

// Clip curve A's parameter range [0, 1] against B's fat-line.
// Returns null if no overlap; else [aLo, aHi] (sub-range of [0, 1]).
function clipAgainstFatLine(ctrlA, ctrlB) {
  const fl = fatLine(ctrlB);
  const n = ctrlA.length;
  // Distance polynomial values at A's control points.
  const dCoeffs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    dCoeffs[i] = fl.nx * (ctrlA[i][0] - fl.p0x) + fl.ny * (ctrlA[i][1] - fl.p0y);
  }
  // Graph the distance polynomial: control polygon nodes are
  // (i/(n-1), dCoeffs[i]). Intersect this polygon with the
  // horizontal strip d ∈ [dMin, dMax] — the s-range where the
  // strip-crossing happens narrows A's parameter.
  const points = new Array(n);
  for (let i = 0; i < n; i++) points[i] = [i / (n - 1), dCoeffs[i]];
  // Compute the convex hull and find s where the strip lines cross
  // each hull edge.
  const hull = convexHull(points);
  let xMin = +Infinity,
    xMax = -Infinity;
  // Pre-populate from any hull vertex inside the strip.
  for (const h of hull) {
    if (h[1] >= fl.dMin - EPS && h[1] <= fl.dMax + EPS) {
      if (h[0] < xMin) xMin = h[0];
      if (h[0] > xMax) xMax = h[0];
    }
  }
  // Add crossings of each hull edge with d = dMin and d = dMax.
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const xLo = a[0],
      yLo = a[1],
      xHi = b[0],
      yHi = b[1];
    for (const d of [fl.dMin, fl.dMax]) {
      if ((yLo - d) * (yHi - d) <= 0 && Math.abs(yHi - yLo) > EPS) {
        const t = (d - yLo) / (yHi - yLo);
        const x = xLo + t * (xHi - xLo);
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
  }
  if (xMin === +Infinity) return null;
  xMin = Math.max(0, Math.min(1, xMin));
  xMax = Math.max(0, Math.min(1, xMax));
  if (xMax < xMin) return null;
  return [xMin, xMax];
}

// Andrew's monotone-chain convex hull. Returns CCW hull vertices.
// The sole caller (clipAgainstFatLine) passes the distance-polygon control
// nodes (i/(n-1), dCoeffs[i]), whose x = i/(n-1) is already strictly ascending
// with distinct x — so the monotone chain needs no sort (it would be a no-op).
function convexHull(points) {
  const pts = points;
  const n = pts.length;
  if (n < 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function controlPointsCoincide(ctrlA, ctrlB) {
  if (ctrlA.length !== ctrlB.length) return false;
  for (let i = 0; i < ctrlA.length; i++) {
    if (Math.abs(ctrlA[i][0] - ctrlB[i][0]) > 1e-7) return false;
    if (Math.abs(ctrlA[i][1] - ctrlB[i][1]) > 1e-7) return false;
  }
  return true;
}

function dedupe(records) {
  const out = [];
  for (const r of records) {
    let dup = false;
    for (const prev of out) {
      if (Math.abs(prev.tA - r.tA) < DEDUPE_T && Math.abs(prev.tB - r.tB) < DEDUPE_T) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(r);
  }
  return out;
}
