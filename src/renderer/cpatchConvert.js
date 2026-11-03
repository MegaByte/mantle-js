// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Decompose a simple closed contour into CPatches (Dokter et al., 2019).
// Each patch is the intersection of its curves' implicit half-spaces, clipped
// to a control hull. Validation checks containment and unwanted curve extensions.
// Invalid patches are cut along candidate lines or curve chords; subdivision
// can tighten a hull without changing the curve. Node and pair-test budgets
// bound the search. A failed certificate returns null for the caller's fallback.
// Self-intersections and compound fill rules are resolved before conversion.

import {
  segSlice,
  segPt,
  segTangent,
  segStart,
  segEnd,
  segRev,
  segImplicit,
  segImplicitPacked,
  segTightBBox,
  implEval,
  implMagAt,
  implGrad,
  implHess,
  implAlongSeg,
  bezMinAt,
  bezRoots01,
  bezEval,
  affEval,
  affBez,
  affRootsOnSeg,
  extensionDomain,
  farFromBoth,
  intersectSets,
  isRat,
  K_IMPL,
  K_PK,
  K_FAR,
  K_ALONG,
  K_PAIR,
  K_FROM,
  segId,
  implHullRange,
  implHullLo,
  implHullHi,
  implHullMag,
  bernToPower,
  rootsSorted,
  polyTrim,
  polyRealRoots,
} from '../geom/cpatchImplicit.js';
import { cubicInflections, cubicLoopCuts } from '../geom/lbCubicMath.js';
import { pathToCycles } from '../geom/cpatchGraph.js';
import { mantleDebugHook } from '../core/diagnostics.js';

const EPS = 1e-9;

const TERM_SEARCH = 6;
const TERM_SUB_CAP = 12;
const NODE_SPLIT_CAP = 8;

export const cpStats = {
  validate: 0,
  leak: 0,
  score: 0,
  cuts: 0,
  nodes: 0,
  bez: 0,
  pairs: 0,
  pruned: 0,
  composed: 0,
  leakHit: 0,
  leakBound: 0,
  leakComp: 0,
  feasBound: 0,
  feasComp: 0,
  feasUni: 0,
  feasMixed: 0,
  farHit: 0,
  farMiss: 0,
  parHit: 0,
  parMiss: 0,
  hintHit: 0,
  hintMiss: 0,
};
/// Pair tests a conversion may spend per decomposition node of its node budget (see the work budget in the search).
export const CP_PAIR_BUDGET_PER_NODE = 256;
export const cpStatsReset = () => {
  for (const k in cpStats) cpStats[k] = 0;
};

// ---- geometry helpers -----------------------------------------------------------
export function patchBBox(curves) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const seg of curves) {
    const b = segTightBBox(seg);
    if (b[0] < x0) x0 = b[0];
    if (b[2] > x1) x1 = b[2];
    if (b[1] < y0) y0 = b[1];
    if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}

/// Exact nonzero-winding spans of the contour on the horizontal line y. Crossings come from
/// affRootsOnSeg — real roots of an affine functional along each Bezier — so this is the true
/// curve, not a flattening, and it is the ground truth both the interior-point search and the
/// converter's own audit are built on.
/// The row's affine functional composed with the segment: affRootsOnSeg([0, 1, -y], seg) with the
/// coefficients 0*x + 1*y_i + (-y) formed in that order, and no functional array built per row.
// Scratch rows: the coefficients and the roots live only until the caller has walked them.
const _rowA = [0, 0, 0, 0],
  _rowOut = [];
function rowRoots(seg, y) {
  if (isRat(seg)) return affRootsOnSeg([0, 1, -y], seg);
  const P = seg.P,
    n = P.length,
    A = _rowA;
  A.length = n;
  for (let i = 0; i < n; i++) A[i] = 0 * P[i][0] + 1 * P[i][1] + -y;
  return bezRoots01(A, 1e-9, _rowOut);
}

const RS_CAP = 256;
/// A span narrower than this fraction of the row's own crossing extent is noise, not a span. It is
/// relative because a fixed width in world units means something different for a glyph and for a map.
const SPAN_EPS = 1e-12;
const _rsX = new Float64Array(RS_CAP),
  _rsDir = new Int8Array(RS_CAP);
///
/// Half-open `ylo <= y < yhi` settles all of it with exact comparisons and no tolerance:
///   through a vertex     the segment below is excluded at its top, the one above included at its
///                        bottom -- one crossing
///   a vertex at a peak    both segments hold it as their top -- no crossing, which is right: the
///                        row grazes the outline
///   a vertex at a dip     both hold it as their bottom -- two crossings at one x, a zero-width span
/// No pad is needed to keep the crossing of a row landing exactly on a control value: the exact
/// test keeps that row, because a segment's lower end is inclusive. Where a bbox extreme is a solved interior extremum rather than a control value
/// it can round low, and a row inside that last ulp loses both of an arch's crossings together --
/// which leaves the winding balanced.
///
/// ...AND IT SETTLES A VERTEX only FOR A y-MONOTONE SEGMENT, which is what rowCross below exists
/// for. Where a curve bulges past its own endpoint the row through that vertex is INTERIOR to the
/// curve's y-range, so this gate admits both sides and each reports the crossing.

/// THE CROSSINGS OF ONE SEGMENT WITH THE ROW, under the vertex rule.
///
/// The half-open y-range test above settles a vertex only for a segment that is y-MONOTONE. Where
/// a curve bulges PAST its own endpoint, the row through that endpoint is interior to the curve's
/// y-range, so the segment ending there and the segment starting there both report the crossing and
/// the winding gains two where the outline passes once. One row in a shape then reads a notch as
/// filled while every neighboring row reads it empty.

function ctlExtent(P) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let k = 0; k < P.length; k++) {
    const q = P[k];
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  return x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
}
function segExtent(seg) {
  return seg && seg.P ? ctlExtent(seg.P) : 0;
}
function loopExtent(loop) {
  let e = 0;
  for (let k = 0; k < loop.length; k++) {
    const v = segExtent(loop[k]);
    if (v > e) e = v;
  }
  return e;
}
const T_VERTEX = 1e-4;
export function rowCross(seg, y, emit) {
  const P = seg.P,
    y0 = P[0][1],
    y1 = P[P.length - 1][1];
  const ts = rowRoots(seg, y);
  for (let k = 0; k < ts.length; k++) {
    let t = ts[k];
    // The row is exactly the endpoint's y -- adjacent segments carry that value bit for bit, so
    // both sides of the vertex agree on when this fires -- and the root near that end is therefore
    // the vertex's. Only the vertex rule may decide it.
    if (y === y0 && t < T_VERTEX) t = 0;
    else if (y === y1 && t > 1 - T_VERTEX) t = 1;
    const tan = segTangent(seg, t);
    if (t === 0 && y === y0) {
      if (!(tan[1] > 0)) continue;
    } else if (t === 1 && y === y1) {
      if (!(tan[1] < 0)) continue;
    } else if (!(Math.abs(tan[1]) > 1e-12 * Math.hypot(tan[0], tan[1]))) continue; // horizontal
    emit(segPt(seg, t)[0], tan[1] > 0 ? 1 : -1);
  }
}

/// THE FILL ORACLE, AND IT ANSWERS FOR ONE RULE AT A TIME. `evenOdd` is optional and defaults to
/// NONZERO, so every caller that predates it is byte-identical; a caller measuring an even-odd
/// shape has to pass it, because the two regions are not the same and one contains the other. A
/// point inside under even-odd has an ODD winding number, which is never zero, so the even-odd
/// region is a SUBSET of the nonzero one -- and a decomposition of an even-odd shape scored against
/// nonzero spans is charged for every sample in the difference as interior it failed to paint. On
/// the corpus that is the whole of a ring's hole.
export function rowSpans(curves, y, evenOdd = false) {
  let m = 0,
    overflow = false;
  for (let ci = 0; ci < curves.length && !overflow; ci++) {
    const seg = curves[ci];
    const bb = segTightBBox(seg);
    if (y < bb[1] || y >= bb[3]) continue;
    rowCross(seg, y, (x, dir) => {
      if (m >= RS_CAP) {
        overflow = true;
        return;
      }
      let j = m;
      while (j > 0 && x < _rsX[j - 1]) {
        _rsX[j] = _rsX[j - 1];
        _rsDir[j] = _rsDir[j - 1];
        j--;
      }
      _rsX[j] = x;
      _rsDir[j] = dir;
      m++;
    });
  }
  if (overflow) return rowSpansGeneric(curves, y, evenOdd);
  const spans = [];
  let w = 0,
    start = 0;
  const xSpan = m > 1 ? Math.abs(_rsX[m - 1] - _rsX[0]) : 1;
  for (let k = 0; k < m; k++) {
    const cx = _rsX[k],
      pw = w;
    w = evenOdd ? w ^ 1 : w + _rsDir[k];
    if (pw === 0 && w !== 0) start = cx;
    // A span's width against the row's own extent. In world units this keeps a hairline span at one
    // scale and drops it at another, and a dropped span moves the winding.
    else if (pw !== 0 && w === 0 && cx - start > SPAN_EPS * xSpan) spans.push([start, cx]);
  }
  return spans;
}

function rowSpansGeneric(curves, y, evenOdd = false) {
  const xs = [];
  for (const seg of curves) {
    const bb = segTightBBox(seg);
    const ylo = bb[1],
      yhi = bb[3];
    if (y < ylo || y >= yhi) continue; // half-open; see the note above
    rowCross(seg, y, (x, dir) => xs.push({ x, dir }));
  }
  xs.sort((a, b) => a.x - b.x);
  const spans = [];
  let w = 0,
    start = 0;
  const xSpan = xs.length > 1 ? Math.abs(xs[xs.length - 1].x - xs[0].x) : 1;
  for (const c of xs) {
    const pw = w;
    w = evenOdd ? w ^ 1 : w + c.dir;
    if (pw === 0 && w !== 0) start = c.x;
    else if (pw !== 0 && w === 0 && c.x - start > SPAN_EPS * xSpan) spans.push([start, c.x]);
  }
  return spans;
}

/// Select an interior point from the widest resolved span. Offset scan rows
/// reduce endpoint coincidences; the half-open crossing rule resolves vertices.

// A recorded row lets replay recover the same interior sample without
// scanning all 23 rows. interiorPointRow reports the selected row.
let _ipRow = 0;
export const interiorPointRow = () => _ipRow;
// Rank the 23 scan rows using control-polygon crossings, then solve the
// selected rows against the actual curves. This ranking is only a heuristic.
const RN = 23;
const _rowY = new Float64Array(RN),
  _rowW = new Float64Array(RN);
const _rowX = new Float64Array(RN * 24),
  _rowN = new Int32Array(RN); // 24 crossings a row is plenty
const _ipOrd = new Int32Array(RN);
const RC = 24;
function rankRows(curves, y0, y1) {
  for (let i = 0; i < RN; i++) {
    const k = i + 1;
    _rowY[i] = y0 + (y1 - y0) * (k / 24 + 0.0037 * Math.sin(k * 2.399));
    _rowN[i] = 0;
    _rowW[i] = 0;
  }
  const drop = (ya, xa, yb, xb) => {
    let lo = ya,
      hi = yb;
    if (lo > hi) {
      lo = yb;
      hi = ya;
    }
    // the rows this edge spans, in ascending y
    let i = 0;
    while (i < RN && _rowY[i] <= lo) i++;
    for (; i < RN && _rowY[i] < hi; i++) {
      const n = _rowN[i];
      if (n >= RC) continue; // pathological: the ranking is a hint, not a proof
      _rowX[i * RC + n] = xa + ((xb - xa) * (_rowY[i] - ya)) / (yb - ya);
      _rowN[i] = n + 1;
    }
  };
  for (let ci = 0; ci < curves.length; ci++) {
    const P = curves[ci].P;
    for (let i = 0; i + 1 < P.length; i++) drop(P[i][1], P[i][0], P[i + 1][1], P[i + 1][0]);
    const L = P[P.length - 1],
      Q = curves[(ci + 1) % curves.length].P[0];
    drop(L[1], L[0], Q[1], Q[0]);
  }
  for (let i = 0; i < RN; i++) {
    const n = _rowN[i];
    if (n < 2) continue;
    const base = i * RC;
    // insertion sort: n is a handful
    for (let a2 = 1; a2 < n; a2++) {
      const v = _rowX[base + a2];
      let j = a2 - 1;
      while (j >= 0 && _rowX[base + j] > v) {
        _rowX[base + j + 1] = _rowX[base + j];
        j--;
      }
      _rowX[base + j + 1] = v;
    }
    let w = 0;
    for (let a2 = 0; a2 + 1 < n; a2 += 2) {
      const d = _rowX[base + a2 + 1] - _rowX[base + a2];
      if (d > w) w = d;
    }
    _rowW[i] = w;
  }
}

/// Set while converting a decomposition that must survive a morph: see leakMargin.
let _fullRows = false;

export function interiorPoint(curves, row) {
  const [x0, y0, x1, y1] = patchBBox(curves);
  let best = null,
    bestW = 0,
    bestRow = 0;
  if (row) {
    const y = y0 + (y1 - y0) * (row / 24 + 0.0037 * Math.sin(row * 2.399));
    const w = rowWidest(curves, y);
    _ipRow = w > 0 ? row : 0;
    return w > 0 ? [(_rwA + _rwB) / 2, y] : null;
  }
  //
  const TOP = _fullRows ? RN : mantleDebugHook('__CP_PROBE_TOP') | 0 || 8;
  rankRows(curves, y0, y1);
  // Quantize near-equal widths relative to the box; break ties by row index.
  const wq = (x1 - x0) * 2 ** -30 || 1;
  const ord = _ipOrd;
  for (let i = 0; i < RN; i++) ord[i] = i + 1;
  ord.sort((p, q) => Math.floor(_rowW[q - 1] / wq) - Math.floor(_rowW[p - 1] / wq) || p - q);
  let bestK = 0;
  const probe = (i) => {
    const w = rowWidest(curves, _rowY[i - 1]),
      k = Math.floor(w / wq);
    if (w > 0 && (k > bestK || !best)) {
      bestW = w;
      bestK = k;
      bestRow = i;
      best = [(_rwA + _rwB) / 2, _rowY[i - 1]];
    }
  };
  const top = Math.min(TOP, RN);
  for (let k = 0; k < top; k++) probe(ord[k]);
  // The polygon over-states a row it does not really reach (it bounds the region, it is not the
  // region), so a ranking that produced nothing is a ranking to abandon: probe the rest rather
  // than answer null and lose the loop.
  if (!best) for (let k = top; k < RN; k++) probe(ord[k]);
  _ipRow = bestRow;
  return best;
}
// The widest span rowSpans would have returned for this row: the same crossings, the same walk,
// only the first span attaining the maximum width kept (in _rwA/_rwB) instead of a list built.
let _rwA = 0,
  _rwB = 0;
function rowWidest(curves, y) {
  let m = 0,
    overflow = false;
  for (let ci = 0; ci < curves.length && !overflow; ci++) {
    const seg = curves[ci];
    const bb = segTightBBox(seg);
    const ylo = bb[1],
      yhi = bb[3];

    const pad = 1e-6 * (yhi - ylo);
    if (y < ylo - pad || y > yhi + pad) continue;
    rowCross(seg, y, (x, dir) => {
      if (m >= RS_CAP) {
        overflow = true;
        return;
      }
      let j = m;
      while (j > 0 && x < _rsX[j - 1]) {
        _rsX[j] = _rsX[j - 1];
        _rsDir[j] = _rsDir[j - 1];
        j--;
      }
      _rsX[j] = x;
      _rsDir[j] = dir;
      m++;
    });
  }
  if (overflow) {
    let bw = 0;
    for (const [a, b] of rowSpansGeneric(curves, y))
      if (b - a > bw) {
        bw = b - a;
        _rwA = a;
        _rwB = b;
      }
    return bw;
  }
  let w = 0,
    start = 0,
    bw = 0;
  const xSpan = m > 1 ? Math.abs(_rsX[m - 1] - _rsX[0]) : 1;
  for (let k = 0; k < m; k++) {
    const cx = _rsX[k],
      pw = w;
    w += _rsDir[k];
    if (pw === 0 && w !== 0) start = cx;
    else if (pw !== 0 && w === 0 && cx - start > SPAN_EPS * xSpan) {
      if (cx - start > bw) {
        bw = cx - start;
        _rwA = start;
        _rwB = cx;
      }
    }
  }
  return bw;
}

const inside = (curves, x, y) => {
  for (const [a, b] of rowSpans(curves, y)) if (x >= a && x <= b) return true;
  return false;
};

export function insideRule(curves, x, y, evenOdd) {
  if (!evenOdd) return inside(curves, x, y);
  let n = 0;
  for (const seg of curves)
    rowCross(seg, y, (cx) => {
      if (cx <= x) n++;
    });
  return (n & 1) === 1;
}

/// Minimum-area ORIENTED bounding box of the patch, as four affine half-space constraints.

/// Rotating calipers on the convex hull — the minimum-area rectangle always has a side
/// collinear with a hull edge.
export function patchOBB(curves) {
  const pts = [];
  for (const seg of curves) {
    const n = seg.P.length - 1;
    for (let i = 0; i <= 8; i++) pts.push(segPt(seg, i / 8));
    const b = segTightBBox(seg);
    if (n >= 2) pts.push([b[0], b[1]], [b[2], b[3]], [b[0], b[3]], [b[2], b[1]]);
  }
  const H = convexHull(pts);
  if (H.length < 2) return null;
  const hEps = 1e-12 * ctlExtent(H);
  let best = null;
  for (let i = 0; i < H.length; i++) {
    const a = H[i],
      b = H[(i + 1) % H.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      L = Math.hypot(dx, dy);
    if (L < hEps) continue;
    const ux = dx / L,
      uy = dy / L;
    let u0 = Infinity,
      u1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (const p of H) {
      const u = p[0] * ux + p[1] * uy,
        v = -p[0] * uy + p[1] * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { ux, uy, u0, u1, v0, v1, area };
  }
  if (!best) return null;
  const { ux, uy, u0, u1, v0, v1 } = best;
  // Against the box's own size. An additive constant would make this dilation a constant for
  // anything smaller than a unit, so the same box at a sixteenth of the scale would be dilated
  // sixteen times as far in its own terms -- the hull dilation below is relative for the same reason.
  const E = 1e-9 * (Math.abs(u1 - u0) + Math.abs(v1 - v0));
  return {
    area: best.area,
    lines: [
      [ux, uy, -(u0 - E)],
      [-ux, -uy, u1 + E],
      [-uy, ux, -(v0 - E)],
      [uy, -ux, v1 + E],
    ],
    corners: [0, 1, 2, 3].map((k) => {
      const u = k === 0 || k === 3 ? u0 : u1,
        v = k < 2 ? v0 : v1;
      return [u * ux - v * uy, u * uy + v * ux];
    }),
  };
}

// Support planes must bound the actual curves, not sampled chords. Compute
// affine extrema at curve endpoints and derivative roots; a sampled secant
// can exclude the bulge between samples. Validation and rendering use the
// same inward hull planes.
// Support/contact tolerances scale with segment extent rather than position.
// Read diagnostic switches at call time so workers can apply message flags.
const affFlatRel = () => mantleDebugHook('__CP_AFF_FLAT_REL') ?? 5e-6;
const coverTolRel = () => mantleDebugHook('__CP_COVER_TOL_REL') ?? 2.5e-6;

export function segAffMin(seg, nx, ny) {
  // A rational's homogeneous coefficients are the value times its weight, not the value, so those
  // fall back to the CONTROL values: a rational with positive weights lies in their convex hull,
  // so their min is a lower bound and the plane still contains the arc.
  if (isRat(seg)) {
    let m = Infinity;
    for (const q of seg.P) m = Math.min(m, nx * q[0] + ny * q[1]);
    return { m, along: false };
  }
  const B = affBez([nx, ny, 0], seg);
  const last = B.length - 1;
  let m = Math.min(B[0], B[last]);
  // THE COEFFICIENTS' own SPREAD, with no constant. B holds the affine functional at the control
  // points, so its values carry the drawing's scale AND its position -- `max |B|` is dominated by
  // wherever the shape sits, and `+ 1` then takes over entirely below unit size. Either way this
  // flatness test asked a different question of the same segment at a different size, and its
  // answer is what tells patchCoverLines whether a CUT runs along a hull plane -- a different
  // row KIND on the wire and a different ramp in the kernel.
  const flat = affFlatRel() * ctlExtent(seg.P);
  // Both endpoints on the supporting line: the line runs along the segment's chord. A straight cut
  // lies in it; a CURVED cut leaves it at once and touches only at its ends, but the hull edge
  // there is still the seam, and a seam is the one place the reach has a second job -- two patches
  // sharing a cut each have to cross it or the seam belongs to neither.
  let along = Math.abs(B[0] - B[last]) <= flat;
  if (B.length < 3) return { m, along };
  const d = new Array(B.length - 1);
  for (let i = 0; i < d.length; i++) d[i] = B[i + 1] - B[i];
  for (const t of bezRoots01(d)) {
    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
    const v = bezEval(B, t);
    if (v < m) {
      m = v;
      along = true;
    } else if (v <= m + flat) along = true;
  }
  return { m, along };
}

/// `samples` > 0 asks for the hull the KERNEL clips against: the sample points pick the plane
/// DIRECTIONS and the arcs themselves fix the offsets, and each plane carries whether the kernel
/// dilates it. A plane the patch's boundary runs along has an AA band outside it and must be
/// dilated; a plane that only bridges two corners bounds nothing but the constraints' extension
/// past the corner, where every one of them reads solid, and dilating that one paints ink outside
/// the shape. The two are told apart exactly -- the support's argmin is interior or it is an
/// endpoint -- so nothing here is a tolerance.
/** @returns {Array<number[] & {outlineAlong?:boolean}>} */
export function patchCoverLines(curves, samples) {
  const H = patchCoverHull(curves, samples);
  if (!H) return null;
  let cx = 0,
    cy = 0;
  for (const p of H) {
    cx += p[0];
    cy += p[1];
  }
  cx /= H.length;
  cy /= H.length;
  const hExt = ctlExtent(H);
  const out = [];
  for (let i = 0; i < H.length; i++) {
    const a = H[i],
      b = H[(i + 1) % H.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      L = Math.hypot(dx, dy);
    if (L < 1e-12 * hExt) continue;
    let nx = -dy / L,
      ny = dx / L;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    // AGAINST THE HULL'S own SIZE, not against where it sits. |a| is an absolute position, so the
    // same hull translated away from the origin dilated by more -- and the `+ 1` made the whole
    // term constant below unit scale.
    const E = 1e-9 * hExt;

    const tight = samples > 0;
    let lo = Infinity;
    const mins = [],
      alongs = [];
    for (const seg of curves) {
      const r = segAffMin(seg, nx, ny);
      mins.push(r.m);
      alongs.push(r.along);
      if (r.m < lo) lo = r.m;
    }
    if (!Number.isFinite(lo)) {
      out.push([nx, ny, -(nx * a[0] + ny * a[1]) + E]);
      continue;
    }
    const off = (tight ? -lo : -(nx * a[0] + ny * a[1])) + E;

    const tol = coverTolRel() * hExt;

    let kind = 0,
      sup = -1;
    for (let ci = 0; ci < curves.length; ci++) {
      if (!(mins[ci] <= lo + tol) || !alongs[ci]) continue;

      if (curves[ci].cut) {
        kind = 1;
        break;
      }
      if (sup < 0) sup = ci;
    }
    if (kind === 0 && sup >= 0) kind = 2;
    // WHETHER THE SHAPE'S OUTLINE RUNS ALONG this PLANE, asked apart from the kind. The kind is the kernel's
    // question -- hard or ramped -- and a cut wins it. Whether an AA band lies OUTSIDE the plane is the cover's
    // question, and a cut lying in the same line as an outline arc does not take the arc's band away. See
    // `outlineHere` in cpatchPack.
    let outlineAlong = false;
    for (let ci = 0; ci < curves.length && !outlineAlong; ci++)
      if (mins[ci] <= lo + tol && alongs[ci] && !curves[ci].cut) outlineAlong = true;

    if (kind === 2) {
      const tx = -ny,
        ty = nx;
      let s0 = Infinity,
        s1 = -Infinity;
      for (let q = 0; q <= 8; q++) {
        const pt = segPt(curves[sup], q / 8),
          u = pt[0] * tx + pt[1] * ty;
        if (u < s0) s0 = u;
        if (u > s1) s1 = u;
      }
      // AND WHICH CURVE SUPPORTS IT, so a consumer can ask the ARC how far away the boundary is
      // rather than asking this plane. The plane is TANGENT to that arc: beside the tangency the arc
      // curves away, so the plane is nearer the fragment than the boundary is and attenuates ink the
      // shape covers whole. See cpatchCov's RAMP_ARC_HULL.
      out.push(
        Object.assign([nx, ny, off, kind, s0, s1, sup], outlineAlong ? { outlineAlong } : null),
      );
    } else out.push(Object.assign([nx, ny, off, kind], outlineAlong ? { outlineAlong } : null));
  }
  return out.length >= 3 ? out : null;
}

/// The convex cover of a patch: its control points when `samples` is 0 or omitted, else the curves
/// sampled at `samples` points apiece.
///
export function patchCoverHull(curves, samples) {
  const pts = [];
  const N = samples != null ? samples | 0 : 0;
  for (const seg of curves) {
    if (N > 0 && seg.t !== 'line') for (let k = 0; k <= N; k++) pts.push(segPt(seg, k / N));
    else for (const q of seg.P) pts.push(q);
  }
  const H = convexHull(pts);
  return H.length >= 3 ? H : null;
}

function convexHull(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [],
    up = [];
  for (const p of P) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  lo.pop();
  up.pop();
  return lo.concat(up);
}

/// Static cubic slices share the source implicit to avoid poorly conditioned
/// re-derivations from short control polygons. Morphs retain piece-local conditioning.
const K_SRCIMPL = Symbol('cp.srcImpl'),
  K_SRCIMPLB = Symbol('cp.srcImplBez');
function segImplicitMemo(seg) {
  let v = seg[K_IMPL];
  if (v === undefined) {
    const sp = seg._srcP;
    // Morph pieces acquire their own frozen conditioning for interval replay.
    // Keep that representation during planning; source reuse is static-only.
    if (!_fullRows && seg.t === 'cubic' && sp && sp !== seg.P && !seg.nrm && !seg.cut) {
      const key = seg._bez ? K_SRCIMPLB : K_SRCIMPL;
      v = sp[key];
      if (v === undefined) {
        v =
          segImplicit(seg._bez ? { t: 'cubic', P: sp, _bez: true } : { t: 'cubic', P: sp }) || null;
        sp[key] = v;
      }
      if (!v) v = segImplicit(seg) || null;
    } else v = segImplicit(seg) || null;
    seg[K_IMPL] = v;
  }
  return v;
}

/// The PACKED implicit, memoized on the segment like the implicit it comes from.
///
/// Per SEGMENT, not per frame: a per-frame cache is nearly the same as no cache, because every
/// candidate loop of every trial cut builds a new frame, and cannotViolate reads the packed form of
/// every curve on every one of them -- so the wire form would be rebuilt many times per distinct
/// curve, re-deriving the implicit from scratch each time rather than taking the memo next door.
/// Read-only at all four sites (two interval bounds, the critical-point solve, and pack time).
function segImplicitPackedMemo(seg) {
  let v = seg[K_PK];
  if (v === undefined) {
    v = segImplicitPacked(seg) || null;
    seg[K_PK] = v;
  }
  return v;
}

/// The interior point of a loop, cached on the loop itself.
///
/// interiorPoint is the most expensive thing framePatch does -- 23 probe rows of exact crossings
/// -- and the search frames the same loop more than once: every winning candidate's sub-loops
/// are framed to SCORE the cut, then framed again when they come off the work stack. Those are
/// the same array objects (cutPatchByLine's loops are passed through by reference, and only
/// marker properties are ever attached), so identity is a sound key and the contents cannot
/// drift under it.
const K_IP = Symbol('cp.inPt'),
  K_IPROW = Symbol('cp.inPtRow'),
  K_LEAK = Symbol('cp.leak'),
  K_BBOX = Symbol('cp.bbox'),
  K_COVER = Symbol('cp.cover');
const K_EXT = Symbol('cp.ext');
const K_FAREX = Symbol('cp.farExit'),
  K_PONE = Symbol('cp.paramOnExt');
function interiorPointMemo(curves) {
  let v = curves[K_IP];
  if (v === undefined) {
    v = interiorPoint(curves) || null;
    curves[K_IP] = v;
    curves[K_IPROW] = _ipRow;
  }
  return v;
}

// Candidate scoring may reuse the parent sample row. If the cut removes
// that row, scan all rows. Accepted patches are framed again with the full
// scan; the hinted sample is not cached as their final interior point.
function interiorPointHinted(curves, hint) {
  if (!hint) return interiorPointMemo(curves);
  const y = hint[1];
  const w = rowWidest(curves, y);
  if (w > 0) {
    cpStats.hintHit++;
    return [(_rwA + _rwB) / 2, y];
  }
  cpStats.hintMiss++;

  return interiorPointMemo(curves);
}

export function framePatch(curves, inPt, cheap, hint) {
  if (cheap && !inPt) {
    const f = cheapFrame(curves);
    if (f) return f;
  }
  const at = inPt || (hint ? interiorPointHinted(curves, hint) : interiorPointMemo(curves));
  if (!at) return null;
  const impls = [];
  for (const seg of curves) {
    const impl = segImplicitMemo(seg);
    if (!impl) return null; // degenerate klmn — caller falls back
    const v = implEval(impl, at[0], at[1]);
    // `packed` stays LAZY -- a frame that is scored and thrown away should not build a wire
    // form it never reads -- but the derivation behind it is memoized per SEGMENT, so a
    // curve that does get asked pays once for the whole conversion rather than once per frame.
    impls.push({
      impl,
      s: v >= 0 ? 1 : -1,
      _seg: seg,
      _pk: undefined,
      get packed() {
        if (this._pk === undefined) this._pk = segImplicitPackedMemo(this._seg);
        return this._pk;
      },
    });
  }
  // `obb` likewise: leakOf prefers `cover`, and only pack time needs the box. `cover`
  // IS needed during scoring, so it stays eager -- and cached on the loop, since the search
  // frames the same loop more than once (to score the cut that made it, and again when it
  // comes off the work stack) and both are pure functions of the curves.
  let bbox = curves[K_BBOX];
  if (bbox === undefined) {
    bbox = patchBBox(curves);
    curves[K_BBOX] = bbox;
  }
  // `cover` is LAZY too, and memoized on the loop: the search reads it on every scored frame, a
  // replayed frame never does.
  return {
    curves,
    impls,
    inside: at,
    bbox,
    get cover() {
      let c = curves[K_COVER];
      if (c === undefined) {
        c = patchCoverLines(curves);
        curves[K_COVER] = c;
      }
      return c;
    },
    _obb: undefined,
    get obb() {
      if (this._obb === undefined) this._obb = patchOBB(this.curves);
      return this._obb;
    },
  };
}

function cheapFrame(curves) {
  const n = curves.length;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    s2 = 0;
  const px = _cfPx,
    py = _cfPy;
  let m = 0;
  for (let k = 0; k < n; k++) {
    const sg = curves[k];
    for (let q = 0; q < 6; q++) {
      const p = segPt(sg, q / 6);
      if (m >= px.length) return null;
      px[m] = p[0];
      py[m] = p[1];
      m++;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  }
  for (let k = 0, j = m - 1; k < m; j = k++) s2 += px[j] * py[k] - px[k] * py[j];
  if (!(s2 !== 0)) return null;
  const orient = s2 > 0 ? 1 : -1;
  const ext = Math.max(x1 - x0, y1 - y0);
  if (!(ext > 0)) return null;
  const off = 1e-4 * ext;
  const impls = [];
  for (let k = 0; k < n; k++) {
    const seg = curves[k];
    const impl = segImplicitMemo(seg);
    if (!impl) return null;
    const p = segPt(seg, 0.5),
      tg = segTangent(seg, 0.5);
    const L = Math.hypot(tg[0], tg[1]);
    if (!(L > 0)) return null;
    // left normal of the direction of travel, inward for a counter-clockwise loop
    const nx = (-tg[1] / L) * orient,
      ny = (tg[0] / L) * orient;
    const v = implEval(impl, p[0] + nx * off, p[1] + ny * off);
    if (!(Math.abs(v) > 0)) return null;
    const s = v > 0 ? 1 : -1;
    impls.push({
      impl,
      s,
      _seg: seg,
      _pk: undefined,
      get packed() {
        if (this._pk === undefined) this._pk = segImplicitPackedMemo(this._seg);
        return this._pk;
      },
    });
  }
  let bbox = curves[K_BBOX];
  if (bbox === undefined) {
    bbox = patchBBox(curves);
    curves[K_BBOX] = bbox;
  }
  return {
    curves,
    impls,
    bbox,
    _cheap: true,
    get inside() {
      return interiorPointMemo(curves);
    }, // rarely read while scoring
    get cover() {
      let c = curves[K_COVER];
      if (c === undefined) {
        c = patchCoverLines(curves);
        curves[K_COVER] = c;
      }
      return c;
    },
    _obb: undefined,
    get obb() {
      if (this._obb === undefined) this._obb = patchOBB(this.curves);
      return this._obb;
    },
  };
}

const _cfPx = new Float64Array(6 * 64),
  _cfPy = new Float64Array(6 * 64); // cheapFrame's outline samples

export const patchEval = (patch, i, x, y) => patch.impls[i].s * implEval(patch.impls[i].impl, x, y);

/// The conjunction, INSIDE THE BOUNDING BOX — which is part of the primitive, not a wrapper
/// around it: the paper defines a CPatch as a region bounded by up to N curves "inside a
/// bounding box represented as four lines". It is not free housekeeping. Validity as tested
/// below only proves patch SUBSET conjunction; the reverse can fail when the implicits'
/// intersection has a second component somewhere else in the plane, and the box is what
/// discards it. On the GPU it costs nothing at all — the box IS the quad being drawn.
/// `box` asks against the patch's BOX (its OBB's four lines) instead of its cover hull -- the row
/// gate's question, which leakOfInner passes down under `ask.box` (see patchLeaksInBox).
export const inPatch = (patch, x, y, box = false) => {
  const b = patch.bbox;
  if (b && (x < b[0] || x > b[2] || y < b[1] || y > b[3])) return false; // cheap reject only
  const cov = box && patch.obb ? patch.obb.lines : patch.cover || (patch.obb && patch.obb.lines);
  if (cov) for (const h of cov) if (affEval(h, x, y) < 0) return false;
  for (let i = 0; i < patch.impls.length; i++) if (patchEval(patch, i, x, y) < 0) return false;
  return true;
};

/// Membership with a MARGIN, in the implicit's own units scaled by |grad f| — i.e. a signed
/// pixel distance from the boundary. Two patches that share a cut line both answer "inside"
/// for a sample sitting exactly on it, and a 45-degree cut passes through whole diagonals of
/// pixel centers, so a naive overlap count reports tens of pixels of double coverage that are
/// ties, not area. Callers auditing overlap should use a margin; the renderer needs the usual
/// half-open fill rule at a seam, which is a separate concern from patch validity.
/// margin > 0 demands the sample be that many pixels INSIDE every half-space; margin < 0
/// tolerates that much outside. Zero reproduces inPatch.
export const inPatchBy = (patch, x, y, margin = 0) => {
  const b = patch.bbox;
  if (b && (x < b[0] + margin || x > b[2] - margin || y < b[1] + margin || y > b[3] - margin))
    return false;
  for (let i = 0; i < patch.impls.length; i++) {
    const { impl, s } = patch.impls[i];
    const v = s * implEval(impl, x, y);
    const g = implGrad(impl, x, y),
      gl = Math.hypot(g[0], g[1]);

    if (!(gl > 0)) {
      if (v < 0) return false;
      continue;
    }
    if (v / gl < margin) return false;
  }
  return true;
};

// ---- validity -------------------------------------------------------------------
/// Does every bounding curve's half-space contain the whole patch?
///
/// Certificate, not sample: the patch is bounded by its own curves, so it suffices to show
/// f_i >= 0 along every OTHER bounding curve — a univariate condition on the exact composed
/// Bezier. (Sufficient because every implicit here is unicursal: the klmn cubic and the
/// quadratic are rational curves, so {f<0} has no component that could hide inside the patch
/// without crossing its boundary. `gridCheck` re-tests that assumption directly.)
///
/// Depth is |f|/|grad f| — a pixel distance — because f itself is not comparable across
/// curve types: on the same geometry the klmn cubic implicit runs ~4 decades below the line
/// implicit, so a raw epsilon on f is four different tolerances wearing one name.
/// implAlongSeg(implicit of A, B) memoised on the two CURVE objects.
///
/// Composing one curve's implicit along another is the parent of affBez, bezMul and bezSplit, and
/// together they are the largest cost in a conversion. It is a pure function of the pair — the
/// implicit is determined by the curve, conditioning constants included, since those live on it —
/// and a node evaluates many candidate cuts whose pieces share most of their curves BY REFERENCE:
/// cutPatchByLine only slices the curves its line actually crosses and passes the rest through.
/// So the same pair is composed again and again within one decision.
///
/// WeakMaps, so a curve dropped by the search takes its row with it.
/// The POWER-BASIS composition, memoized the same way and for the same reason: leakOf composes
/// curve j's implicit along curve i's unbounded extension for every ordered pair of every patch
/// it is asked about, and that polynomial -- degree NINE for a cubic implicit along a cubic --
/// depends only on the pair. `impl` comes from segImplicitMemo, so the curve determines it.
///
/// Keyed (extended curve, implicit's own curve). Callers that DILATE the implicit by a margin
/// hold a different function and must not read this.
/// Used by the search's ask and not by the gate's. These clip leakOfInner's feasible set by the
/// bar before it places its probes, which the search's tuning assumes and which is NOT monotone in
/// the bar -- see leakOfInner's `ask.monotone`.

/// farFromBoth, memoized on the segment.
///
/// It is asked for the stretches of a curve standing farther than `tol` from its own endpoints,
/// so despite taking them as arguments it is a pure function of the segment and the tolerance --
/// and it is not cheap: squaring the coordinate polynomials makes it degree six, and it isolates
/// that polynomial's real roots twice, once per endpoint. leakOf asks it for every curve of every
/// patch it is handed, and the search hands it the same artwork curves over and over.
///
/// `tol` is fixed for a conversion but is not ours to assume, so the cell remembers which one it
/// answered for and recomputes if asked for another.
/// The same for an arbitrary PAIR OF POINTS -- a sibling's two ends, where the extension leaves
/// the patch through a same-curve neighbor. farFromBothMemo above only covers the segment's own
/// endpoints, so this case isolated a degree-six polynomial's roots twice per ask, and the search
/// asks it for the same sibling of the same curve in every loop the two share. Keyed by the four
/// coordinates and the tolerance; the set is shared with every caller, exactly as the endpoint
/// memo's is, and callers treat these sets as immutable.
function farFromExitsMemo(seg, A, B, tol) {
  let m = seg[K_FAREX];
  if (m === undefined) {
    m = new Map();
    seg[K_FAREX] = m;
  }
  const key = A[0] + ',' + A[1] + ',' + B[0] + ',' + B[1] + ',' + tol;
  let v = m.get(key);
  if (v === undefined) {
    cpStats.farMiss++;
    v = farFromBoth(seg, A, B, tol);
    m.set(key, v);
  } else cpStats.farHit++;
  return v;
}

function farFromBothMemo(seg, tol) {
  const c = seg[K_FAR];
  if (c !== undefined && c.tol === tol) return c.set;
  const set = farFromBoth(seg, segStart(seg), segEnd(seg), tol);
  seg[K_FAR] = { tol, set };
  return set;
}

/// The part of `set` (sorted, disjoint parameter intervals of `seg`) on which s * impl is
/// non-negative along seg's extension.
///
/// Each stretch is sliced out of the curve by the blossom, which extrapolates exactly, and the
/// implicit is composed along the slice in the Bernstein basis -- the same exact composition
/// validatePatch uses on the arcs themselves. The hull property then answers most stretches
/// without a root: all coefficients on the admitted side keeps the stretch whole, all on the
/// other side drops it, and only a mixed stretch is cut at the composition's roots in (0, 1).
/// `slices`: a per-call cache of the stretch slices keyed by their interval, so the j loop
/// slices each stretch of curve i once rather than once per j.
function feasibleAlong(set, impl, seg, s, slices) {
  const out = [];
  for (let q = 0; q < set.length; q++) {
    const a = set[q][0],
      b = set[q][1];
    if (!(b > a)) continue;
    let sl = slices && slices.get(set[q]);
    if (sl === undefined) {
      sl = segSlice(seg, a, b);
      if (slices) slices.set(set[q], sl);
    }

    implHullRange(impl, sl);
    const hlo = implHullLo(),
      hhi = implHullHi();
    if (s > 0 ? hlo >= 0 : hhi <= 0) {
      cpStats.feasBound++;
      out.push(set[q]);
      continue;
    } // survives whole
    if (s > 0 ? hhi <= 0 : hlo >= 0) {
      cpStats.feasBound++;
      continue;
    } // nothing survives
    // Compose the implicit along the segment when its sign remains unresolved.
    cpStats.feasComp++;
    const B = implAlongSeg(impl, sl);
    let allPos = true,
      allNeg = true;
    for (let k = 0; k < B.length; k++) {
      const v = B[k] * s;
      if (v < 0) allPos = false;
      if (v > 0) allNeg = false;
    }
    if (allPos) {
      cpStats.feasUni++;
      out.push(set[q]);
      continue;
    } // the stretch survives whole: same object
    if (allNeg) {
      cpStats.feasUni++;
      continue;
    }
    cpStats.feasMixed++;
    if (s < 0) for (let k = 0; k < B.length; k++) B[k] = -B[k];
    const ivs = nonNegIntervals(B);
    for (let k = 0; k < ivs.length; k++)
      out.push([a + (b - a) * ivs[k][0], a + (b - a) * ivs[k][1]]);
  }
  return out;
}

/// Proof that max |f o seg| OVER THE ARC IS AT LEAST thr, without composing anything.
///
/// Two bounds, cheapest first. A Bezier's value at any parameter is a convex combination of its
/// Bernstein coefficients -- non-negative weights summing to one -- so |B(t)| <= max |B_k| for
/// every t in [0, 1], and ONE evaluation of the implicit at a point of the arc is a lower bound
/// on the maximum coefficient. The endpoints are exact coefficients themselves. That settles the
/// adjacent pairs, which is nearly all of them and which the interval bound below can never
/// settle: two curves of a patch share a vertex, f_j is exactly zero there, so the coefficient
/// range always straddles zero however far apart the rest of the curves are.
///
/// Only then the control-point interval bound, which is the one that also covers rational
/// segments -- where the composition is a numerator over a weight power and a point value is
/// not a coefficient bound at all.
function arcFarFrom(impl, seg, thr) {
  if (!isRat(seg)) {
    const P = seg.P,
      A = P[0],
      B = P[P.length - 1];
    if (Math.abs(implEval(impl, A[0], A[1])) >= thr) return true;
    if (Math.abs(implEval(impl, B[0], B[1])) >= thr) return true;
    const m = segPt(seg, 0.5);
    if (Math.abs(implEval(impl, m[0], m[1])) >= thr) return true;
  }
  implHullRange(impl, seg);
  return implHullLo() > thr || implHullHi() < -thr;
}

/// The pair's composition IF IT IS ALREADY MEMOISED, else undefined. leakOfInner wants one
/// number out of it and can often prove that number another way -- but when the clip test has
/// already composed the pair the exact array is sitting there for nothing.
function alongPeek(a, b) {
  const m = a[K_ALONG];
  return m === undefined ? undefined : m.get(segId(b));
}

function alongMemo(a, impl, b) {
  let m = a[K_ALONG];
  if (m === undefined) {
    m = new Map();
    a[K_ALONG] = m;
  }
  const id = segId(b);
  let v = m.get(id);
  if (v === undefined) {
    v = implAlongSeg(impl, b);
    m.set(id, v);
  }
  return v;
}

/// THE CLIP TEST OF ONE ORDERED PAIR, memoized on the pair.
///
/// "Does curve j lie in curve i's half-space" is a function of three things only: curve i (its
/// implicit and packed form come from the segment memo), the SIGN the patch reads that implicit
/// with, and curve j. The search asks it for every pair of every loop of every candidate cut,
/// and a candidate's loops share nearly every curve with their parent by reference -- so the same
/// question is asked, on the same objects with the same sign, many times over per node. Both of
/// the O(N^2) loops here read this one memo.
///
/// Returns `false` when the pair cannot violate (the interval bound clears it, no coefficient is
/// negative, or the minimum is non-negative), else { t, dep, p } -- the minimum's parameter, its
/// depth in pixels and the point -- for the caller to threshold as it always did.
function pairClip(patch, i, j, bbj) {
  const ci = patch.curves[i],
    cj = patch.curves[j],
    s = patch.impls[i].s;
  let m = ci[K_PAIR];
  if (m === undefined) {
    m = new Map();
    ci[K_PAIR] = m;
  }
  const key = segId(cj) * 2 + (s > 0 ? 1 : 0);
  let v = m.get(key);
  if (v !== undefined) {
    cpStats.pairs++;
    return v;
  }
  v = pairClipInner(patch, i, j, bbj);
  m.set(key, v);
  return v;
}
function pairClipInner(patch, i, j, bbj) {
  cpStats.pairs++;
  if (cannotViolate(patch, i, bbj)) {
    cpStats.pruned++;
    return false;
  }
  // THE CONTROL-POLYGON BOUND, before the composition. The box bound above takes the implicit's
  // extremes over curve j's axis-aligned box; this takes each affine functional's extremes over
  // j's control points, which the curve's hull is inside of, and is therefore tighter -- and it
  // is a proof about the same Bernstein coefficients the composition would produce, so a pair it
  // clears is one the composed hull test would have cleared. Three dot products a functional.
  {
    const { impl, s } = patch.impls[i];
    implHullRange(impl, patch.curves[j]);
    // CLEAR OF ZERO BY MORE THAN THE HULL RANGE'S own NOISE, for the reason ivClearsZero gives:
    // a bound that lands on zero is a bound that proves nothing, and the resultant's coefficients
    // differ in the last places between two sizes of the same curve. Pruning on it lost a
    // violation eight units deep.
    const _hl = implHullLo(),
      _hh = implHullHi();
    const _hm = 1e-12 * Math.max(Math.abs(_hl), Math.abs(_hh));
    if (s > 0 ? _hl > _hm : _hh < -_hm) {
      cpStats.pruned++;
      return false;
    }
  }
  const zeroBar = 1e-12 * implHullMag();
  cpStats.composed++;

  const { impl, s } = patch.impls[i];
  const B = alongMemo(patch.curves[i], impl, patch.curves[j]);
  // NOT CLEARLY POSITIVE COUNTS AS POSSIBLY NEGATIVE, the same rule ivClearsZero states for the
  // box bound: the convex-hull property proves non-negativity only if the coefficients really are
  // non-negative, and one that computes as exactly 0 at one size and -1e-27 at another proves
  // nothing either way. Refusing to prune there costs one composition; pruning wrongly loses the
  // violation for good.
  let bMag = 0;
  for (let k = 0; k < B.length; k++) {
    const a = Math.abs(B[k]);
    if (a > bMag) bMag = a;
  }
  const negBar = 1e-12 * bMag;
  let anyNeg = false;
  for (let k = 0; k < B.length; k++)
    if (B[k] * s < negBar) {
      anyNeg = true;
      break;
    }
  if (!anyNeg) return false;

  const { min, t } = bezMinAt(B, 1e-12 * (bMag || 1), s);
  // Ignore residuals below the relative roundoff threshold before dividing by a near-zero gradient.
  if (min >= -zeroBar) return false;
  const p = segPt(patch.curves[j], t);
  const g = implGrad(impl, p[0], p[1]);
  const gl = Math.hypot(g[0], g[1]);
  const dep = gl > 0 ? -min / gl : Infinity; // a zero divisor, not a magnitude: see above
  return { t, dep, p };
}

/// THE PAIR SWEEP, with what the PARENT loop already established.
///
/// A loop the search is asked about is nearly always a piece of a loop it has already
/// validated: a candidate cut slices the two curves the line crosses and passes every other
/// curve through by reference. For a pair of those pass-through curves, read with the same
/// signs the parent read them with, the clip test is the same pure function of the same
/// objects, so its answer is the parent's answer. The parent recorded which of its pairs
/// violate (a handful) and with what depth; every other inherited pair is known clean and is
/// not visited at all. What is left to test is the pairs that touch a NEW curve -- a slice, a
/// seam -- or a curve whose sign the piece reads differently, which is O(new x n) rather than
/// O(n^2). On a 167-curve loop that is the difference between ~600 pair tests and ~28,000 per
/// candidate piece.
///
/// `visit(i, j, r)` sees every pair that can violate, r = { t, dep, p }, in the order the plain
/// double loop visits them -- i ascending, j ascending -- which matters: the worst violation is
/// the first of the deepest, and two pairs meeting at a shared vertex report the same depth.
/// Returning true stops the sweep.
const K_PAR = Symbol('cp.parent');
const _swJ = [];
function pairSweep(patch, visit) {
  const curves = patch.curves,
    n = curves.length;
  const par = curves[K_PAR];
  if (par === undefined) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const r = pairClip(patch, i, j, segTightBBox(curves[j]));
        if (r && visit(i, j, r)) return true;
      }
    }
    return false;
  }
  const inh = new Int8Array(n),
    ids = new Array(n);
  let idx = null,
    anyNew = false;
  for (let i = 0; i < n; i++) {
    const id = segId(curves[i]);
    ids[i] = id;
    const s = par.sign.get(id);
    if (s !== undefined && s === patch.impls[i].s) {
      inh[i] = 1;
      if (idx === null) idx = new Map();
      idx.set(id, i);
    } else anyNew = true;
  }
  const newJ = _swJ;
  newJ.length = 0;
  if (anyNew) for (let j = 0; j < n; j++) if (inh[j] === 0) newJ.push(j);
  for (let i = 0; i < n; i++) {
    if (inh[i] === 0) {
      // A new curve: every pair it is in is new.
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const r = pairClip(patch, i, j, segTightBBox(curves[j]));
        if (r && visit(i, j, r)) return true;
      }
      continue;
    }
    // An inherited curve: its pairs with new curves are tested; its pairs with inherited
    // curves are the parent's, and only the violating ones are visited. The two sequences are
    // merged so j still ascends.
    const vl = par.byA.get(ids[i]);
    let vk = 0,
      vj = -1,
      vv = null;
    const nextV = () => {
      vj = -1;
      vv = null;
      while (vl && vk < vl.length) {
        const v = vl[vk++],
          j = idx.get(v.b);
        if (j !== undefined) {
          vj = j;
          vv = v;
          break;
        }
      }
    };
    if (vl) {
      // the parent's list is in the parent's j order, not this loop's: sort the present ones
      if (vl.length > 1) {
        const present = [];
        for (let k = 0; k < vl.length; k++) {
          const j = idx.get(vl[k].b);
          if (j !== undefined) present.push([j, vl[k]]);
        }
        present.sort((x, y) => x[0] - y[0]);
        let pk = 0;
        for (let q = 0; q < newJ.length || pk < present.length;) {
          const nj = q < newJ.length ? newJ[q] : Infinity,
            pj = pk < present.length ? present[pk][0] : Infinity;
          if (nj < pj) {
            q++;
            if (nj === i) continue;
            const r = pairClip(patch, i, nj, segTightBBox(curves[nj]));
            if (r && visit(i, nj, r)) return true;
          } else {
            const v = present[pk][1];
            pk++;
            if (visit(i, pj, v)) return true;
          }
        }
        continue;
      }
      nextV();
    }
    for (let q = 0; q < newJ.length || vj >= 0;) {
      const nj = q < newJ.length ? newJ[q] : Infinity;
      if (nj < (vj >= 0 ? vj : Infinity)) {
        q++;
        if (nj === i) continue;
        const r = pairClip(patch, i, nj, segTightBBox(curves[nj]));
        if (r && visit(i, nj, r)) return true;
      } else {
        const v = vv,
          j = vj;
        nextV();
        if (visit(i, j, v)) return true;
      }
    }
  }
  return false;
}

/// The record a validated loop hands its pieces: each curve's sign as this loop read it, and
/// the violating pairs with their depths, grouped by the curve whose implicit is violated.
/// Keyed by segment identity, so it references no frame.
export function parentRecord(frame, viol) {
  const sign = new Map(),
    byA = new Map();
  const curves = frame.curves;
  for (let i = 0; i < curves.length; i++) sign.set(segId(curves[i]), frame.impls[i].s);
  if (viol)
    for (let k = 0; k < viol.length; k++) {
      const v = viol[k];
      let l = byA.get(v.a);
      if (l === undefined) {
        l = [];
        byA.set(v.a, l);
      }
      l.push(v);
    }
  return { sign, byA };
}

export function adoptParent(loops, par) {
  if (!par) return loops;
  for (let k = 0; k < loops.length; k++) loops[k][K_PAR] = par;
  return loops;
}

let CLIP_TESTS = true;

/// Which step invented area. Every loop the search enqueues is a piece of the shape, whatever the
/// step -- a line cut, a curve cut, a subdivision, a terminal decomposition, a resolve -- so an
/// interior point of any of them is interior to the ORIGINAL contour. That is an invariant with no
/// tolerance in it, and the one thing that names the step rather than the symptom: it catches an
/// ear cut whose chord crosses a notch, and through it a winding miscount one row wide.
///
/// Read ONCE, at module scope. The check sits in wpush, which is the hottest line in the
/// conversion, and a globalThis lookup there is not free -- a probe sets it before importing.
const _LOOP_AUDIT = globalThis.__CP_LOOP_AUDIT || null;

/// Two violation depths within this fraction of each other are one depth (see `note` below).
const DEPTH_TIE_REL = 1e-8;
export function validatePatch(patch, tolPx0 = tolAbs(), margin = 0) {
  cpStats.validate++;
  const tolPx = tolPx0;
  let worst = null;
  // Accumulate the baseline score during validation to avoid validating the
  // same uncut frame again when ranking candidates.
  let sPairs = 0,
    sDepth = 0;
  // Keep the first offender among nearly equal depths so rounding does not reorder cuts.
  const note = (d) => {
    if (d.depth > tolPx && (!worst || d.depth > worst.depth * (1 + DEPTH_TIE_REL))) worst = d;
  };
  const viol = [];
  const curves = patch.curves;
  if (CLIP_TESTS)
    pairSweep(patch, (i, j, r) => {
      const dep = r.dep;
      if (dep > tolPx) {
        sPairs++;
        sDepth += dep;
        viol.push({ a: segId(curves[i]), b: segId(curves[j]), t: r.t, dep, p: r.p });
      }
      note({ kind: 'clip', i, j, t: r.t, depth: dep, point: r.p });
      return false;
    });
  // ...and the interior minimum the boundary sweep above cannot reach.
  for (let i = 0; i < patch.curves.length; i++) {
    const pk = patch.impls[i].packed;
    const cps = implCritical(pk, patch.bbox);
    if (!cps) continue;
    for (const q of cps) {
      if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
      const f = patchEval(patch, i, q[0], q[1]);
      // Ignore near-zero critical values at implicit singularities.
      if (f >= -1e-12 * implMagAt(patch.impls[i].impl, q[0], q[1])) continue;
      if (pk.kind === 4) {
        const depth = criticalDipDepth(patch.impls[i], q[0], q[1], f);
        if (depth > tolPx && inside(patch.curves, q[0], q[1]))
          note({ kind: 'clip', i, j: i, t: 0.5, depth, point: q, interior: true });
        continue;
      }
      if (!inside(patch.curves, q[0], q[1])) continue; // the dip is outside the patch
      const g = implGrad(patch.impls[i].impl, q[0], q[1]);
      const gl = Math.hypot(g[0], g[1]) * Math.abs(patch.impls[i].s);
      // At a critical point the gradient vanishes, so -f/|grad| is useless as a depth. The
      // violation is the value itself, scaled by the patch so it is comparable to the others.
      const scale = Math.max(patch.bbox[2] - patch.bbox[0], patch.bbox[3] - patch.bbox[1]) || 1;

      const lin = gl > 0 ? -f / gl : Infinity;
      const depth = lin <= scale ? lin : Math.min(scale, Math.cbrt(-f) * scale);
      note({ kind: 'clip', i, j: i, t: 0.5, depth, point: q, interior: true });
    }
  }
  const lk = leakOf(patch, tolPx, margin);
  if (lk) {
    sPairs++;
    sDepth += lk.depth;
    note(lk);
  }
  return { ok: !worst, worst, score: { pairs: sPairs, depth: sDepth }, viol };
}

/// Can curve j EVEN VIOLATE CURVE i? A conservative interval bound answers it for the price of
/// a few multiplies, where the honest answer — composing i's implicit along j in the Bernstein
/// basis — is a degree-9 polynomial construction. Every implicit is a sum of products of AFFINE
/// functionals, an affine over a box takes its extremes at the corners, and products compose by
/// interval rules; so if the bound over j's own bounding box is already non-negative, the
/// composition's minimum is too and there is nothing to find.
///
/// This is the same interval machinery gridSplitPatch uses on cells, pointed at curve boxes
/// instead. It matters because both O(N^2) loops in this file — validatePatch's and scoreOf's —
/// test every curve against every other, and on a long loop almost every pair is two curves
/// nowhere near each other.
/// Interval arithmetic over curve j's bounding box: if the implicit cannot go negative anywhere
/// in the box, it cannot go negative on the curve, and the composition is not needed.

/// A tighter bound would have to be tight where the curve APPROACHES the zero set, which a box
/// subdivision is not.
/// cannotViolate over SEVERAL boxes: true only when the implicit clears zero on every one.
function cannotViolateBoxes(patch, i, boxes) {
  const pk = patch.impls[i].packed;
  if (!pk) return false;
  const s = patch.impls[i].s;
  for (const b of boxes) {
    if (!ivClearsZero(packedInterval(pk, s, b[0], b[1], b[2], b[3]))) return false;
  }
  return true;
}

function cannotViolate(patch, i, jbb) {
  const pk = patch.impls[i].packed;
  if (!pk) return false;
  return ivClearsZero(packedInterval(pk, patch.impls[i].s, jbb[0], jbb[1], jbb[2], jbb[3], false));
}

/// Interior critical points of an implicit, solved exactly.

/// The right one is calculus. An unconstrained minimum satisfies grad f = 0, and in the packed
/// form every implicit is a short sum of products of AFFINE functionals, so that system is small
/// and closed-form:
///
///   kind 1 (A0^2 - A1)      grad is affine and generically never zero — a parabola has no
///                           critical point, so quadratics cannot dip. Nothing to do.
///   kind 5 (A0^2 - A1*A2)   grad is affine: one 2x2 solve, at most one point.
///   kind 3 (A0^3 - A1*A2)   grad is quadratic, but a0y*df/dx - a0x*df/dy cancels the A0^2 term
///                           and leaves an affine constraint. Intersect that line with either
///                           component and it is a quadratic in one parameter: at most two.
///   kind 4 (Bezout)         the same move across A2's level lines; see bezoutCritical. At most
///                           two, and it needs the patch's box for a frame.
///
/// At most two candidates per curve, no subdivision, no tolerance to tune.
export function implCritical(pk, bbox) {
  if (!pk) return null;
  if (pk.kind === 4) return bbox ? bezoutCritical(pk, bbox) : null;
  const a = pk.a;
  if (pk.kind === 5) {
    const [a0x, a0y, a0c] = a[0],
      [a1x, a1y, a1c] = a[1],
      [a2x, a2y, a2c] = a[2];
    const m00 = 2 * a0x * a0x - 2 * a1x * a2x;
    const m01 = 2 * a0x * a0y - a2x * a1y - a1x * a2y;
    const r0 = -(2 * a0x * a0c - a2x * a1c - a1x * a2c);
    const m10 = 2 * a0y * a0x - a2y * a1x - a1y * a2x;
    const m11 = 2 * a0y * a0y - 2 * a1y * a2y;
    const r1 = -(2 * a0y * a0c - a2y * a1c - a1y * a2c);
    const det = m00 * m11 - m01 * m10;
    // Singular relative to the terms it canceled from. A determinant of implicit coefficients
    // carries their units, so an absolute floor asks a different question of every drawing.
    if (!(Math.abs(det) > 1e-15 * (Math.abs(m00 * m11) + Math.abs(m01 * m10)))) return null;
    return [[(r0 * m11 - m01 * r1) / det, (m00 * r1 - r0 * m10) / det]];
  }
  if (pk.kind !== 3) return null;
  const [a0x, a0y, a0c] = a[0],
    [a1x, a1y, a1c] = a[1],
    [a2x, a2y, a2c] = a[2];
  // a0y*df/dx - a0x*df/dy kills the 3*A0^2 term, leaving A1*K2 + A2*K1 = 0.
  const K2 = a2x * a0y - a2y * a0x;
  const K1 = a1x * a0y - a1y * a0x;
  const Lx = K2 * a1x + K1 * a2x,
    Ly = K2 * a1y + K1 * a2y,
    Lc = K2 * a1c + K1 * a2c;
  const L2 = Lx * Lx + Ly * Ly;

  const LxM = Math.abs(K2 * a1x) + Math.abs(K1 * a2x),
    LyM = Math.abs(K2 * a1y) + Math.abs(K1 * a2y);
  const LM2 = LxM * LxM + LyM * LyM;
  if (!(L2 > 1e-24 * LM2)) return null;
  const px = (-Lc * Lx) / L2,
    py = (-Lc * Ly) / L2; // a point on the line
  const dn = Math.sqrt(L2),
    dx = -Ly / dn,
    dy = Lx / dn; // and its direction
  const at = (A) => [A[0] * px + A[1] * py + A[2], A[0] * dx + A[1] * dy];
  const [u0, u1] = at(a[0]),
    [v0, v1] = at(a[1]),
    [w0, w1] = at(a[2]);
  // Use whichever component is better conditioned.
  const useX = Math.abs(a0x) >= Math.abs(a0y);
  const g0 = useX ? a0x : a0y,
    g1 = useX ? a1x : a1y,
    g2 = useX ? a2x : a2y;
  const A = 3 * g0 * u1 * u1;
  const B = 6 * g0 * u0 * u1 - g2 * v1 - g1 * w1;
  const C = 3 * g0 * u0 * u0 - g2 * v0 - g1 * w0;
  const ts = [];

  const T = bbox ? Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) : 0;
  const Tn = T > 0 ? T : Math.hypot(px, py) || 1;
  const AT = Math.abs(A) * Tn * Tn,
    BT = Math.abs(B) * Tn;
  const abc = AT + BT + Math.abs(C);
  if (!(AT > 1e-15 * abc)) {
    if (BT > 1e-15 * abc) ts.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    ts.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
  }
  return ts.filter((t) => Number.isFinite(t)).map((t) => [px + dx * t, py + dy * t]);
}

/// KIND 4 IS SOLVED, NOT WITNESSED. Its packed value is
///   f = C1*A0*A3 - C0^2*A0 - C1*A1^2 + 2*C0*A1*A2 - A3*A2^2
/// and its gradient is two conics, which reads as a quartic resultant. It is not a quartic. A3 is M11, which shares M02's linear part (only
/// the constant differs), so the one cubic term, A3*A2^2, varies across A2's level lines alone.
/// In a frame whose beta axis runs ALONG those level lines, beta^2 comes only from A0*A3 and A1^2,
/// with constant coefficients, so
///   df/dbeta  = B1*beta + B0(alpha)          B1 constant
///   df/dalpha = P0(alpha) + P1(alpha)*beta   P1 = dB0/dalpha
/// and beta = -B0/B1 turns B1*P0 - P1*B0 = 0 into a QUADRATIC in alpha: at most two points, as for
/// kind 3. (An A3 not parallel to A2 would make it a cubic, handled the same way; no construction
/// produces one.)

function bezoutCritical(pk, bb) {
  const w = bb[2] - bb[0],
    hh = bb[3] - bb[1];
  if (!(w > 0) || !(hh > 0)) return null; // no interior, so no interior dip
  const a = pk.a,
    C0 = pk.c[0],
    C1 = pk.c[1];
  const ox = 0.5 * (bb[0] + bb[2]),
    oy = 0.5 * (bb[1] + bb[3]),
    h = 0.5 * Math.max(w, hh);
  const L = Math.hypot(a[2][0], a[2][1]);
  const nx = L > 0 ? a[2][0] / L : 1,
    ny = L > 0 ? a[2][1] / L : 0;
  // Each functional as c + n*alpha + t*beta. A t that is rounding against the products it was formed
  // from is zero: A2's own t is zero by construction, and A3's by the shared linear part.
  const cOf = (r) => r[0] * ox + r[1] * oy + r[2];
  const nOf = (r) => h * (r[0] * nx + r[1] * ny);
  const tOf = (r) => {
    const t = h * (r[1] * nx - r[0] * ny);
    return Math.abs(t) <= 1e-12 * h * (Math.abs(r[1] * nx) + Math.abs(r[0] * ny)) ? 0 : t;
  };
  const c0 = cOf(a[0]),
    n0 = nOf(a[0]),
    t0 = tOf(a[0]);
  const c1 = cOf(a[1]),
    n1 = nOf(a[1]),
    t1 = tOf(a[1]);
  const c2 = cOf(a[2]),
    n2 = nOf(a[2]);
  const c3 = cOf(a[3]),
    n3 = nOf(a[3]),
    t3 = tOf(a[3]);
  const B1 = 2 * C1 * (t0 * t3 - t1 * t1);
  const B00 =
    C1 * (t0 * c3 + c0 * t3) - C0 * C0 * t0 - 2 * C1 * t1 * c1 + 2 * C0 * t1 * c2 - t3 * c2 * c2;
  const B01 = C1 * (t0 * n3 + n0 * t3) - 2 * C1 * t1 * n1 + 2 * C0 * t1 * n2 - 2 * t3 * c2 * n2;
  const B02 = -t3 * n2 * n2;
  // P0 is d/dalpha of f along beta = 0, a cubic g1*alpha + g2*alpha^2 + g3*alpha^3 plus a constant.
  const g1 =
    C1 * (c0 * n3 + n0 * c3) -
    C0 * C0 * n0 -
    2 * C1 * c1 * n1 +
    2 * C0 * (c1 * n2 + n1 * c2) -
    (2 * c3 * c2 * n2 + n3 * c2 * c2);
  const g2 = C1 * n0 * n3 - C1 * n1 * n1 + 2 * C0 * n1 * n2 - (c3 * n2 * n2 + 2 * n3 * c2 * n2);
  const g3 = -n3 * n2 * n2;
  const P00 = g1,
    P01 = 2 * g2,
    P02 = 3 * g3;
  const P10 = B01,
    P11 = 2 * B02;
  const out = [];
  // Only points that can be in the box: every point of it is within sqrt(2) of the center.
  const push = (al, be) => {
    if (!Number.isFinite(al) || !Number.isFinite(be) || al * al + be * be > 2.25) return;
    out.push([ox + h * (al * nx - be * ny), oy + h * (al * ny + be * nx)]);
  };
  if (!(Math.abs(B1) > 1e-12 * (Math.abs(2 * C1 * t0 * t3) + Math.abs(2 * C1 * t1 * t1)))) {
    // f IS AT MOST LINEAR IN BETA, so df/dbeta = B0(alpha) fixes alpha and df/dalpha is linear in
    // beta there. A B0 that vanishes identically means f does not vary along beta at all: every
    // negative region is a strip, which reaches the boundary, and there is no isolated point.
    for (const al of polyRealRoots([B00, B01, B02])) {
      const p1 = P10 + P11 * al;
      if (!(Math.abs(p1) > 1e-12 * (Math.abs(P10) + Math.abs(P11 * al)))) continue;
      push(al, -(P00 + P01 * al + P02 * al * al) / p1);
    }
    return out.length ? out : null;
  }
  const R0 = B1 * P00 - P10 * B00;
  const R1 = B1 * P01 - (P10 * B01 + P11 * B00);
  const R2 = B1 * P02 - (P10 * B02 + P11 * B01);
  const R3 = -P11 * B02;
  const roots = polyRealRoots([R0, R1, R2, R3]);
  // A double root whose discriminant rounded below zero is two critical points merging, and one of
  // them is a minimum until they do. Negative only to within the terms it canceled from is zero.
  if (!roots.length && R3 === 0 && R2 !== 0) {
    const disc = R1 * R1 - 4 * R2 * R0;
    if (disc < 0 && -disc <= 1e-12 * (R1 * R1 + Math.abs(4 * R2 * R0))) roots.push(-R1 / (2 * R2));
  }
  for (const al of roots) push(al, -(B00 + B01 * al + B02 * al * al) / B1);
  return out.length ? out : null;
}

/// HOW DEEP A KIND-4 CRITICAL POINT DIPS, as a length: 0 when it does not dip at all.

const ZERO_REL = 1e-12;
export function criticalDipDepth(entry, x, y, f) {
  const impl = entry.impl;
  let mag = 0;
  for (const term of impl.terms) {
    let p = Math.abs(term.c);
    for (const a of term.fs) p *= Math.abs(a[0] * x) + Math.abs(a[1] * y) + Math.abs(a[2]);
    mag += p;
  }
  if (!(-f > ZERO_REL * mag)) return 0;
  const H = implHess(impl, x, y),
    s = entry.s;
  const hxx = s * H[0],
    hxy = s * H[1],
    hyy = s * H[2];
  const lmax = 0.5 * (hxx + hyy) + Math.hypot(0.5 * (hxx - hyy), hxy);
  return lmax > 0 ? Math.sqrt((-2 * f) / lmax) : 0;
}

/// The OTHER direction, and the one that a boundary-only test cannot see: is the half-space
/// conjunction contained IN the patch, or does it claim area the patch does not have?

/// The test: a point is on the boundary of the conjunction exactly when it lies on some
/// f_i = 0 and satisfies every other constraint. The zero set of f_i is the curve's own
/// algebraic curve, which the Bezier parameterizes beyond [0,1] as well as inside it — so
/// extend curve i, intersect the other constraints along it, and require the feasible set to
/// be the arc and nothing more. Anything feasible outside [0,1] is boundary the conjunction
/// has and the patch does not: a leak.
/// LEAKS ARE A PROPERTY OF THE LOOP, so they are cached on it.
///
/// Everything leakOfInner reads -- the cover, the box, the implicits, the interior point -- is
/// derived from the curves, so the answer depends only on (loop, tolPx, margin). The search asks
/// twice for the same loop as a matter of course: once to SCORE the cut that produced it, and
/// again when the loop comes off the work stack to be validated. framePatch rebuilds the frame
/// each time but hands through the same curves array, so identity keys this exactly as it keys
/// the interior point.
/// THE SEARCH'S ASK, and its width policy stated rather than inherited.

function leakOf(patch, tolPx, margin = 0) {
  const key = patch.curves;

  let signs = 0;
  for (let i = 0; i < patch.impls.length; i++) signs = signs * 2 + (patch.impls[i].s > 0 ? 1 : 0);
  const cell = key[K_LEAK];
  if (cell !== undefined && cell.tol === tolPx && cell.margin === margin && cell.signs === signs)
    return cell.lk;
  const lk = leakOfInner(patch, tolPx, margin);
  key[K_LEAK] = { tol: tolPx, margin, signs, lk };
  return lk;
}

/// Provenance key shared by slices of one algebraic curve; null for lines.
const K_ALG = Symbol('cp.alg');
function algKey(seg) {
  if (!seg || seg.t === 'line') return null;
  let v = seg[K_ALG];
  if (v === undefined) {
    const sp = seg.t === 'cubic' && seg.P && seg.P.length === 4 ? seg._srcP || seg.P : null;
    v = sp ? 'c' + sp.join(';') : seg._src ? 'k' + seg._src.k : null;
    seg[K_ALG] = v;
  }
  return v;
}

/// The parameter of `seg`'s extension at which it passes through Q, for a Q known to lie on
/// seg's algebraic curve; null when no root of x(t) = Qx or y(t) = Qy lands within tolerance.
/// Memoised on the segment by the point: the leak test asks for a sibling's two ends, and the
/// same sibling of the same curve recurs in every loop the two appear in together. Two power-basis
/// root isolations an ask, and null is a real answer worth remembering.
function paramOnExtensionMemo(seg, Q) {
  let m = seg[K_PONE];
  if (m === undefined) {
    m = new Map();
    seg[K_PONE] = m;
  }
  const key = Q[0] + ',' + Q[1];
  let v = m.get(key);
  if (v === undefined) {
    cpStats.parMiss++;
    v = paramOnExtension(seg, Q);
    m.set(key, v);
  } else cpStats.parHit++;
  return v;
}

function paramOnExtension(seg, Q) {
  const cx = bernToPower(affBez([1, 0, -Q[0]], seg)),
    cy = bernToPower(affBez([0, 1, -Q[1]], seg));
  const cands = rootsSorted(polyTrim(cx)).concat(rootsSorted(polyTrim(cy)));
  let best = null,
    bd = Infinity;
  for (let k = 0; k < cands.length; k++) {
    const t = cands[k];
    if (!Number.isFinite(t)) continue;
    const p = segPt(seg, t),
      d = Math.hypot(p[0] - Q[0], p[1] - Q[1]);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  // Polish extension parameters geometrically before applying the positional tolerance.
  if (best !== null) {
    let t = best;
    for (let it = 0; it < 8; it++) {
      const p = segPt(seg, t),
        d = segTangent(seg, t),
        den = d[0] * d[0] + d[1] * d[1];
      if (!(den > 0)) break;
      const step = ((p[0] - Q[0]) * d[0] + (p[1] - Q[1]) * d[1]) / den;
      if (!Number.isFinite(step)) break;
      t -= step;
      if (Math.abs(step) <= 1e-15 * (1 + Math.abs(t))) break;
    }
    const p = segPt(seg, t),
      d = Math.hypot(p[0] - Q[0], p[1] - Q[1]);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  // The segment's own size. hypot(Q) is where the point sits, not how big the geometry is, so the
  // identical curve translated across the canvas accepted a looser match -- and the `+ 1` made the
  // bound constant for anything smaller than a unit.
  return best !== null && bd <= 1e-6 * segExtent(seg) ? best : null;
}
/// `set` with the interval [a, b] removed.
function subtractRange(set, a, b) {
  const out = [];
  for (let k = 0; k < set.length; k++) {
    const s0 = set[k][0],
      s1 = set[k][1];
    if (s1 <= a || s0 >= b) {
      out.push(set[k]);
      continue;
    }
    if (a - s0 > 1e-12) out.push([s0, a]);
    if (s1 - b > 1e-12) out.push([b, s1]);
  }
  return out;
}

const withinArc = (dom) => {
  for (let k = 0; k < dom.length; k++) {
    const iv = dom[k];
    if (!(iv[0] > -1e-9 && iv[1] < 1 + 1e-9)) return false;
  }
  return true;
};

const _leakOrder = []; // leakOfInner's constraint order, cheapest implicit first
/// DOES this PATCH'S HALF-SPACE INTERSECTION REACH PAST THE PATCH, ANYWHERE INSIDE ITS own BOX?
///
/// The renderer's cheap fence is the patch's box (Dokter et al.'s four lines, two dot products in a
/// varying). The box is LOOSER than the convex cover the search validates against, so the guarantee
/// and the enforcement do not meet: a patch may be leak-free inside its hull and still leak in the
/// gap between hull and box. That gap is where the fence-free route's residual wrong pixels live.

/// Its own memo, keyed separately from leakOf's: the two answer different questions about the same
/// patch and must not share a cell.
const K_LEAKBOX = Symbol('cp.leakBox');
export function patchLeaksInBox(patch, tolPx0 = null) {
  if (!patch || !patch.obb || !patch.impls || !patch.curves) return true; // unknown: fence it
  // THE GATE HAS NO POLICY BAR, AND MEASUREMENT IS WHY.

  // What is left is a NUMERICAL floor, and it exists only to keep the probe off the patch's own
  // ends -- reach 0 is the boundary, not a leak. The patch's own scale is that floor, the same
  // leakRel() x extent the probe step takes, so the gate carries ONE length, it is the patch's, and
  // it is not a policy: nothing to compare against a constant, and equivariant under any scaling
  // of the drawing. `tolPx0` stays for the probes and the smoke, which sweep it on purpose.
  const _e = Math.max(patch.bbox[2] - patch.bbox[0], patch.bbox[3] - patch.bbox[1]);
  const _own = _e > 0 && Number.isFinite(_e) ? leakRel() * _e : tolAbs();
  const tolPx = tolPx0 != null ? tolPx0 : _own;
  const key = patch.curves;
  let signs = 0;
  for (let i = 0; i < patch.impls.length; i++) signs = signs * 2 + (patch.impls[i].s > 0 ? 1 : 0);
  const cell = key[K_LEAKBOX];
  if (cell !== undefined && cell.tol === tolPx && cell.signs === signs) return cell.v;
  let lk = null;
  // THE GATE'S PROBES STEP BY THE PATCH'S own SCALE, never by the bar. See leakOfInner's header:
  // the step is a WIDTH policy, and this question has no width policy -- ink a tenth of a pixel
  // wide is ink outside the patch. Tying it to the bar is what made the gate non-monotone.
  // THE PROBES STEP BY THE PATCH'S own SCALE TOO, never by the bar -- see leakOfInner's header:
  // the step is a WIDTH policy, and this question has no width policy, since ink a tenth of a
  // pixel wide is ink outside the patch. Reading it off the bar is what made the gate non-monotone.
  try {
    lk = leakOfInner(patch, tolPx, 0, GATE_ASK(_own));
  } catch {
    lk = { depth: Infinity };
  }

  const v = !!lk;
  key[K_LEAKBOX] = { tol: tolPx, signs, v };
  return v;
}

/// `ask` IS WHICH LEAK THE CALLER WANTS REPORTED, and the two callers want different ones.
/// (Exported for the monotonicity probe and smoke, which need the DEPTH and not just the verdict
/// patchLeaksInBox returns; nothing in the renderer calls it by this name.)
///
/// A patch can have several leaks, and this returns the FIRST it finds. Every one it can return
/// has depth >= tolPx, so every answer is SOUND whatever `ask` says; what `ask` decides is which
/// of them comes back, and that is not a detail. The SEARCH ranks cut candidates by the depth and
/// is tuned on the answers it gets. The GATE wants only a boolean, and wants it monotone in the
/// bar and independent of any width policy. Three fields:
///
///   ask.nudgePx    the DEFAULT for the two fields below. Defaults to tolPx, which is what the
///                  search asks for.
///
///   ask.samePx     the scale for "are these two constraints the same algebraic curve" (thr). Not
///                  a width and not the caller's bar: it is the size at which a composition along
///                  curve i's own arc counts as zero.
///
///   ask.minWidthPx the caller's WIDTH POLICY: how narrow a sliver it is willing to leave uncut.
///                  Stepping half of it off a stretch and asking inPatch answers "is the region at
///                  least that WIDE here", so at 0.05 it declines to cut for a sliver 0.02 across
///                  whatever its depth -- a morphing blob can carry leaks 8 to 15 deep that are
///                  0.004 to 0.025 wide, and those are the ones the search deliberately does not
///                  cut for. That is a POLICY, stated as one.

///   ask.box        validate against the patch's BOX (its OBB's four lines) rather than its cover
///                  hull, in the extension domain and in every membership probe. The row gate's
///                  question (patchLeaksInBox): a finished patch is valid against its hull by
///                  construction, and what the renderer fences with is the box. It is an argument
///                  so that it holds for this call alone: a re-entrant or concurrent conversion
///                  never sees another caller's choice.

/**
 * @param {any} patch
 * @param {number} tolPx
 * @param {number} [margin]
 * @param {{ nudgePx?: number, samePx?: number, minWidthPx?: number,
 *           measuredWidth?: boolean, monotone?: boolean, anyStretch?: boolean, box?: boolean }} [ask]
 */
export function leakOfInner(patch, tolPx, margin = 0, ask = EMPTY_ASK) {
  const nudgePx = ask.nudgePx != null ? ask.nudgePx : tolPx;
  // TWO SEPARATE QUESTIONS, TWO FIELDS: "are these two constraints the same algebraic curve"
  // (thr) and "does the conjunction hold area just inside curve i here" (the probe step). The
  // second is a WIDTH POLICY: it says how narrow a sliver a caller is willing to leave uncut. Tying
  // it to the accepted defect size is a defensible policy for the SEARCH and no policy at all for
  // anyone else, so each is its own field, both defaulting to nudgePx (the search's value).
  const SAME_PX = ask.samePx != null ? ask.samePx : nudgePx;
  const MIN_W = ask.minWidthPx != null ? ask.minWidthPx : nudgePx;

  const MEASURED = ask.measuredWidth === true;
  const MONOTONE = ask.monotone === true;
  const ANY_STRETCH = ask.anyStretch === true;
  const BOX = ask.box === true;
  cpStats.leak++;
  const bb = patch.bbox;
  const bboxLines = [
    [1, 0, -bb[0]],
    [-1, 0, bb[2]],
    [0, 1, -bb[1]],
    [0, -1, bb[3]],
  ];

  const box =
    BOX && patch.obb ? patch.obb.lines : patch.cover || (patch.obb ? patch.obb.lines : bboxLines);
  // THE BOUNDING BOX FIRST, as a filter. The cover hull is the tight bound and the one the
  // domain is derived from below -- but it has as many edges as the loop has extreme control
  // points, and each is a root solve along the extension. The box is four. The set the box
  // admits contains the set the hull admits, so if nothing of the extension enters the BOX
  // beyond the arc, nothing enters the hull beyond it either, and the curve is skipped on the
  // same test it would have been skipped on. Only a curve whose extension does reach into the
  // box pays for the hull.
  //
  // DILATED, so the containment holds numerically and not just geometrically: the hull's lines
  // carry a 1e-9 slack of their own, and a box drawn exactly on the extremes could exclude a
  // point the slackened hull admits. A box wider than that slack by three orders cannot.
  const useFilter = box !== bboxLines;
  const bE = useFilter ? 1e-6 * (Math.abs(bb[2] - bb[0]) + Math.abs(bb[3] - bb[1])) : 0;
  const filterLines = useFilter
    ? [
        [1, 0, -bb[0] + bE],
        [-1, 0, bb[2] + bE],
        [0, 1, -bb[1] + bE],
        [0, -1, bb[3] + bE],
      ]
    : null;
  for (let i = 0; i < patch.curves.length; i++) {
    const seg = patch.curves[i];
    if (useFilter) {
      const domB = extensionDomain(seg, filterLines);
      if (domB && withinArc(domB)) continue;
    }

    const dom = extensionDomain(seg, box);
    if (!dom) continue;
    if (withinArc(dom)) continue;
    // Where the extension actually runs off the arc. Only these stretches can be a leak, and
    // having them as boxes turns the j-loop below into the same interval question cannotViolate
    // asks in the clip direction: if curve j's implicit cannot go negative anywhere the
    // extension goes, intersecting with it cannot remove any of these stretches, cannot empty
    // the set and cannot change the depth -- so the degree-9 composition and its root solve are
    // computable and pointless. Bounding the OUTSIDE stretches rather than all of `dom` keeps
    // the box tight: the arc itself is patch boundary and can never be the leak.
    const outBoxes = [];
    for (const [a, b] of dom) {
      for (const [w0, w1] of [
        [a, Math.min(b, 0)],
        [Math.max(a, 1), b],
      ]) {
        if (!(w1 - w0 > 1e-12)) continue;
        try {
          outBoxes.push(segTightBBox(segSlice(seg, w0, w1)));
        } catch {
          outBoxes.length = 0;
        }
        if (!outBoxes.length) break;
      }
      if (!outBoxes.length) break; // could not bound a stretch: make no claim, test every j
    }
    let set = dom,
      onSameCurve = false;

    const exits = [];
    // Stretch slices of curve i, shared across the j loop: intersecting never creates a new
    // interval object unless it cuts one, so an uncut stretch keeps its slice.
    const slices = new Map();
    // Cheapest constraints first. The feasible set is an intersection, so the order of the
    // constraints does not change it -- but it changes how many are composed before the set is
    // empty. A line composes along a stretch to degree 3 (closed form); a cubic to degree 9
    // (isolation), and the seams next to the arc are lines that usually end the extension at
    // once. Index order ran the cubics first on most loops.
    const jOrder = _leakOrder;
    jOrder.length = 0;
    for (let j = 0; j < patch.curves.length; j++)
      if (j !== i && patch.impls[j].impl.deg === 1) jOrder.push(j);
    for (let j = 0; j < patch.curves.length; j++)
      if (j !== i && patch.impls[j].impl.deg === 2) jOrder.push(j);
    for (let j = 0; j < patch.curves.length; j++)
      if (j !== i && patch.impls[j].impl.deg > 2) jOrder.push(j);
    for (let jj = 0; jj < jOrder.length && set.length; jj++) {
      const j = jOrder[jj];
      const { impl, s } = patch.impls[j];
      // MARGIN: does the extension come within `margin` of being admitted, rather than merely
      // being admitted? A decomposition that only just avoids a leak is valid and useless to a
      // morph -- the cut line the search places is the one passing CLOSEST to the offender, so the
      // patch that comes out of that can clear its own extension by nanopixels and be pixels inside
      // it a ten-thousandth of a morph step later. A line implicit carries a unit
      // normal, so its value IS the signed distance and shifting the constant dilates it exactly;
      // that is also where the fragility comes from, since the curve constraints are the artwork
      // and only the cut lines are placed by the search.
      // The margin only ever DILATES the half-space (s*use = s*impl + margin, margin >= 0), so a
      // bound that clears zero for impl clears it for the dilated one too.
      if (outBoxes.length && cannotViolateBoxes(patch, j, outBoxes)) continue;
      const use =
        margin > 0 && impl.deg === 1 && impl.terms.length === 1
          ? (() => {
              const [a, b, c0] = impl.terms[0].fs[0],
                k = impl.terms[0].c;
              return Math.abs(Math.hypot(a, b) - 1) < 1e-9 && k
                ? { deg: 1, terms: [{ c: k, fs: [[a, b, c0 + (s * margin) / k]] }] }
                : impl;
            })()
          : impl;
      // CURVE i'S EXTENSION RUNS ALONG CURVE j, which is what two pieces of one cubic look like
      // -- split at an inflection, or separated by a cut. They bound the patch along the same
      // algebraic curve, so every point of i's extension is on the patch's own boundary and
      // encloses no area at all. The sign there is decided by rounding, which is why this is not
      // a tolerance to widen: the noise can read negative at one pose, a clean patch, and positive
      // a millionth of a morph step later, the same patch reporting a leak several units deep.

      const mid0 = segPt(seg, 0.5);
      let gr0 = implGrad(impl, mid0[0], mid0[1]);
      let gl0 = Math.hypot(gr0[0], gr0[1]);
      if (!(gl0 > 0)) {
        gr0 = implGrad(impl, patch.inside[0], patch.inside[1]);
        gl0 = Math.hypot(gr0[0], gr0[1]);
      }
      const thr = 1e-3 * SAME_PX * gl0;
      // DOES THE COMPOSITION NEED TO EXIST? It is wanted for one number -- max |f_j| over curve
      // i's arc -- and only to ask whether that number is BELOW thr, which is the signature of
      // the two curves being the same algebraic curve. That is a rare configuration and a
      // degree-nine composition to find out. The control-point interval bound contains every
      // Bernstein coefficient of the exact composition, so a bound clear of zero by thr proves
      // every coefficient exceeds thr in absolute value, hence so does their maximum, and the
      // question is settled without composing. The memo is consulted first: where the clip test
      // has already composed this pair the exact array costs nothing and is used as before.
      let fmax = -1;
      const memArc = alongPeek(patch.curves[j], seg);
      if (memArc !== undefined) {
        cpStats.leakHit++;
        fmax = 0;
        for (let k = 0; k < memArc.length; k++) {
          const av = memArc[k] < 0 ? -memArc[k] : memArc[k];
          if (av > fmax) fmax = av;
        }
      } else {
        cpStats.leakBound++;
        if (!(gl0 > 0) || !arcFarFrom(impl, seg, thr)) {
          cpStats.leakComp++;
          const Barc = alongMemo(patch.curves[j], impl, seg);
          fmax = 0;
          for (let k = 0; k < Barc.length; k++) {
            const av = Barc[k] < 0 ? -Barc[k] : Barc[k];
            if (av > fmax) fmax = av;
          }
        }
      }

      const gl = gl0;
      if (gl > 0 && fmax >= 0 && fmax < thr) {
        const A2 = segStart(patch.curves[j]),
          B2 = segEnd(patch.curves[j]);
        // Shared provenance gives endpoint parameters without extension inversion.
        const ps = seg._src,
          pj = patch.curves[j]._src;
        const sib =
          ps && pj && ps.k === pj.k && ps.b !== ps.a && algKey(patch.curves[j]) === algKey(seg);
        const ta = sib ? (pj.a - ps.a) / (ps.b - ps.a) : paramOnExtensionMemo(seg, A2);
        const tb = sib ? (pj.b - ps.a) / (ps.b - ps.a) : paramOnExtensionMemo(seg, B2);
        if (ta === null || tb === null) {
          onSameCurve = true;
          break;
        } // cannot place the arc: as before
        set = subtractRange(set, Math.min(ta, tb) - 1e-6, Math.max(ta, tb) + 1e-6);
        exits.push(A2, B2);
        continue;
      }

      set = feasibleAlong(set, use, seg, s, slices);
    }
    if (onSameCurve || !set.length) continue;
    // How far outside the patch does the leak actually reach? Distance from the arc's nearest
    // endpoint is a fair, conservative stand-in and is what the cut needs to beat -- and it is
    // an INTERVAL question, not a point one. Probing one parameter of a feasible stretch such as
    // [1.0003, 1.6667] can report the depth at 1.33 and miss a violation at 1.56.
    const A = segStart(seg),
      B = segEnd(seg);
    //
    if (!MONOTONE) {
      set = intersectSets(set, farFromBothMemo(seg, tolPx));
      for (let q = 0; q + 1 < exits.length && set.length; q += 2)
        set = intersectSets(set, farFromExitsMemo(seg, exits[q], exits[q + 1], tolPx));
    }
    const reach = (p) => {
      let d = Math.min(Math.hypot(p[0] - A[0], p[1] - A[1]), Math.hypot(p[0] - B[0], p[1] - B[1]));
      for (let q = 0; q < exits.length; q++) {
        const e = exits[q];
        const de = Math.hypot(p[0] - e[0], p[1] - e[1]);
        if (de < d) d = de;
      }
      return d;
    };
    for (const [a, b] of set) {
      // Only the part off the real arc is a leak.
      for (const [w0, w1] of [
        [a, Math.min(b, 0)],
        [Math.max(a, 1), b],
      ]) {
        if (!(w1 - w0 > 1e-12)) continue;
        // A LEAK CLAIMS AREA, OR IT IS NOT ONE. The stretch is feasible for every constraint
        // that was asked -- but a constraint set aside as "the same algebraic curve" can be a
        // DIFFERENT curve whose implicit merely coincides with curve i's along this stretch (two
        // near-straight pieces meeting at a corner, as on a morphing blob), and that
        // constraint bounds the conjunction exactly here: the extension is its zero set, and
        // just off it on curve i's inside the conjunction is empty. Nudge a point off the stretch
        // into curve i's half-space by half the tolerance; if the conjunction does not contain
        // it, this stretch is boundary of an empty region and there is nothing to cut for.
        //
        // And the claimed area must be wrong: a stretch of the extension can run along the loop's
        // own boundary where it coincides with another curve to within rounding (a morphing blob's
        // corners: the extension of one side lies along the next side for a few units). Inside it
        // the conjunction rightly holds the shape; there is nothing wrong to cut. A leak is a
        // stretch whose inner side is outside the loop (over-claim), or whose outer side is inside
        // the loop (a far branch through the interior, an under-claim); a stretch with the loop on
        // its inside and not on its outside is the boundary.

        // HOW WIDE IT IS, AS A NUMBER, and not whether it is wider than a bar. The step above
        // answers "is the region at least 0.5 * MIN_W across here", which is a yes or a no about a
        // width the caller already picked -- it does not give the width itself, the thing that
        // decides whether a leak is worth a cut. This walks curve i's inward normal
        // until the conjunction stops containing the ray, by bracketing and bisection, in the
        // Patch's own length units and with no tolerance of its own. Capped at the patch's bbox
        // diagonal: past that it is not measuring a leak's width, it is measuring the patch.
        // Called ONCE, on the leak that is actually returned, so the search's hot path keeps its
        // single probe.
        const patchDiag = bb ? Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) : 0;
        const stepIn = (q0, gi, gl2, L) => {
          const f = (L * patch.impls[i].s) / gl2;
          return inPatch(patch, q0[0] + gi[0] * f, q0[1] + gi[1] * f, BOX);
        };
        // At a singularity, use the tangent normal and compare implicit values on both sides.
        /** @returns {[number[], number]} */
        const inward = (q0, uu) => {
          const tg = segTangent(seg, uu),
            tl = Math.hypot(tg[0], tg[1]);
          if (!(tl > 0)) {
            const gi = implGrad(patch.impls[i].impl, q0[0], q0[1]);
            return [gi, Math.hypot(gi[0], gi[1])];
          }
          const nx = -tg[1] / tl,
            ny = tg[0] / tl,
            h = 0.5 * MIN_W,
            si = patch.impls[i].s;
          const fp = si * implEval(patch.impls[i].impl, q0[0] + nx * h, q0[1] + ny * h);
          const fm = si * implEval(patch.impls[i].impl, q0[0] - nx * h, q0[1] - ny * h);
          return fp >= fm ? [[nx * si, ny * si], 1] : [[-nx * si, -ny * si], 1];
        };

        const widthAt = (uu) => {
          const q0 = segPt(seg, uu);
          const [gi, gl2] = inward(q0, uu);
          if (!(gl2 > 0) || !(patchDiag > 0)) return 0;
          let lo = patchDiag * Math.pow(2, -30);
          if (!stepIn(q0, gi, gl2, lo)) return 0;
          let hi = 0;
          for (let k = 0; k < 30; k++) {
            const nx = lo * 2;
            if (nx >= patchDiag) {
              if (stepIn(q0, gi, gl2, patchDiag)) return patchDiag;
              hi = patchDiag;
              break;
            }
            if (stepIn(q0, gi, gl2, nx)) lo = nx;
            else {
              hi = nx;
              break;
            }
          }
          if (!(hi > lo)) return lo;
          for (let k = 0; k < 10; k++) {
            const m = 0.5 * (lo + hi);
            if (stepIn(q0, gi, gl2, m)) lo = m;
            else hi = m;
          }
          return lo;
        };
        const emptyAt = (uu) => {
          const q0 = segPt(seg, uu);
          const [gi, gl2] = inward(q0, uu);
          if (!(gl2 > 0)) return false; // no direction to step: make no claim
          const dd = (0.5 * MIN_W * patch.impls[i].s) / gl2;
          const qx = q0[0] + gi[0] * dd,
            qy = q0[1] + gi[1] * dd;

          if (MEASURED ? widthAt(uu) < 0.5 * MIN_W : !inPatch(patch, qx, qy, BOX)) return true;
          return (
            inside(patch.curves, qx, qy) &&
            !inside(patch.curves, q0[0] - gi[0] * dd, q0[1] - gi[1] * dd)
          );
        };
        // The ends are where the leak runs deepest, and the cut search ranks defects by exactly
        // that number. Under the monotone ask a probe counts only if it stands the bar clear of
        // the boundary, which is the only place tolPx enters the verdict and it enters
        // monotonically; under the search's ask the set is already clipped to that, so the
        // midpoint decides emptiness and the ends only carry the depth.
        let u = NaN,
          p = null,
          depth = -Infinity;
        if (MONOTONE) {
          for (const e of leakProbes(w0, w1)) {
            const q = segPt(seg, e),
              dq = reach(q);
            if (!(dq > depth) || !(dq >= tolPx)) continue;
            if (!ANY_STRETCH && emptyAt(e)) continue;
            depth = dq;
            u = e;
            p = q;
          }
          if (!p) continue;
        } else {
          if (emptyAt((w0 + w1) / 2)) continue;
          for (const e of [(w0 + w1) / 2, w0, w1]) {
            const q = segPt(seg, e),
              dq = reach(q);
            if (!(dq > depth)) continue;
            depth = dq;
            u = e;
            p = q;
          }
        }
        // Width beside depth. `depth` is how far past its own arc the leak reaches; `width` is how
        // much of the conjunction stands behind it there. They are independent -- the morph blob
        // carries leaks 8 to 15 DEEP that are 0.004 to 0.025 WIDE -- and a caller that reads only
        // the depth cannot tell a wedge of wrong ink from a hairline that rounds away.
        return {
          kind: 'leak',
          i,
          j: i,
          t: u,
          depth,
          width: widthAt(u),
          point: p,
          past: u < 0 ? 0 : 1,
        };
      }
    }
  }
  return null;
}

/// The window the CUT SEARCHES look for structure in, past a curve's own ends.
///
/// It is a constant. Growing T until the control hull of `segSlice(seg, -T, 0)` clears the patch
/// box cannot work: that slice ends at the curve's own start point — on the patch boundary, so
/// inside the box by construction — and every curve would take the cap. The cap is the window the
/// searches are tuned against; the leak test, which needs the span to be MEANINGFUL, derives its
/// own exactly (extensionDomain) instead of composing over a window 65x wider than the arc.
/// A TOLERANCE FOR A SET OF CURVES, in the units their coordinates are in.
///
/// Two terms, because there are two ways to be too small to matter. A tolerance has to be small
/// against what the curves SPAN -- that is what "these two points are the same" means -- and it
/// cannot go below the precision actually available at the coordinates they sit at, which is the
/// one thing that legitimately depends on WHERE they are. A form like `|coordinate| + 1` is
/// neither: the constant term dominates for anything drawn smaller than a unit, so the same
/// geometry would get a different test at a different size, and the extent is not consulted.
///
/// Taking the max of the two keeps the value these tests are tuned to on artwork laid out a few
/// hundred units from the origin (where the magnitude dominates) and gives a shape sitting AT the
/// origin its own extent rather than a bare 1.
function geomScale(curves) {
  let mag = 0,
    x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let k = 0; k < curves.length; k++) {
    const P = curves[k].P;
    for (let q = 0; q < P.length; q++) {
      const p = P[q];
      if (Math.abs(p[0]) > mag) mag = Math.abs(p[0]);
      if (Math.abs(p[1]) > mag) mag = Math.abs(p[1]);
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return x1 >= x0 ? Math.max(mag, x1 - x0, y1 - y0) : mag;
}
const EXT_SPAN = 32;
/** @overload @param {object} [seg] @param {number[]} [bb] @returns {number} */
function extensionSpan() {
  return EXT_SPAN;
}
const ARC_SAMPLES = [
  1 / 64,
  1 / 32,
  1 / 16,
  1 / 8,
  1 / 4,
  3 / 8,
  1 / 2,
  5 / 8,
  3 / 4,
  7 / 8,
  15 / 16,
  31 / 32,
  63 / 64,
];

/// Does the seam arc properly cross any curve of the loop, away from its own two ends? Both
/// are flattened to 16 pieces; a crossing within `endEps` of either arc end is the arc meeting
/// the boundary where it is supposed to.
/// `ja`, `jb`: the curves the arc's two ends sit on; their contact with the arc's first and last
/// piece is the arc meeting the boundary where it should, not a crossing. Every test is a
/// PROPER crossing with both cross products clear of zero, so the polylines merely touching at
/// a shared point (a seed node and its neighbor) do not count.
const _acA = new Float64Array(34),
  _acB = new Float64Array(34);
function arcCrossesLoop(arc, curves, ja, jb, scale) {
  const A = _acA,
    B = _acB;
  for (let k = 0; k <= 16; k++) {
    const p = segPt(arc, k / 16);
    A[2 * k] = p[0];
    A[2 * k + 1] = p[1];
  }
  // The d's below are CROSS PRODUCTS -- areas -- so the bound is the square of a length. See
  // geomScale for why that length is neither a bare coordinate magnitude nor a constant.
  const eps = 1e-12 * scale * scale;
  for (let c = 0; c < curves.length; c++) {
    const seg = curves[c];
    for (let k = 0; k <= 16; k++) {
      const p = segPt(seg, k / 16);
      B[2 * k] = p[0];
      B[2 * k + 1] = p[1];
    }
    for (let i = 0; i < 16; i++) {
      if ((i === 0 && c === ja) || (i === 15 && c === jb)) continue;
      const p1x = A[2 * i],
        p1y = A[2 * i + 1],
        p2x = A[2 * i + 2],
        p2y = A[2 * i + 3];
      for (let j = 0; j < 16; j++) {
        const q1x = B[2 * j],
          q1y = B[2 * j + 1],
          q2x = B[2 * j + 2],
          q2y = B[2 * j + 3];
        const d1 = (p2x - p1x) * (q1y - p1y) - (p2y - p1y) * (q1x - p1x);
        const d2 = (p2x - p1x) * (q2y - p1y) - (p2y - p1y) * (q2x - p1x);
        if (!((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))) continue;
        const d3 = (q2x - q1x) * (p1y - q1y) - (q2y - q1y) * (p1x - q1x);
        const d4 = (q2x - q1x) * (p2y - q1y) - (q2y - q1y) * (p2x - q1x);
        if (!((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) continue;
        return true;
      }
    }
  }
  return false;
}

/// The sub-intervals of [0,1] on which a scalar Bezier is >= 0.
/// Does a HOLE reach into this patch? A shape's filled region is its outer contour MINUS its
/// holes, but a patch is an intersection of half-spaces — it has no way to express a
/// subtraction. So a patch that overlaps a hole is simply INVALID, and the cut search that
/// already exists is what fixes it.

/// A hole strictly CONTAINING the patch crosses none of its edges, so this sees nothing; that
/// case is the interior-point test in convertContour, and the two are complementary — a patch
/// near enough to a hole boundary for the point test to be ambiguous is one whose boundary
/// this test catches.
function holeIntrusion(patch, holes) {
  for (let hi = 0; hi < holes.length; hi++) {
    for (const hseg of holes[hi]) {
      let feas = [[0, 1]];
      for (let j = 0; j < patch.curves.length && feas.length; j++) {
        const { impl, s } = patch.impls[j];
        const coeffs = implAlongSeg(impl, hseg).map((v) => v * s);
        const out = [];
        for (const iv of nonNegIntervals(coeffs))
          for (const f of feas) {
            const a = Math.max(iv[0], f[0]),
              b = Math.min(iv[1], f[1]);
            if (b - a > 1e-6) out.push([a, b]);
          }
        feas = out;
      }
      if (feas.length) {
        const [a, b] = feas[0],
          t = (a + b) / 2;
        return {
          kind: 'hole',
          i: 0,
          j: 0,
          t,
          depth: Infinity,
          point: segPt(holes[hi][0] && hseg, t),
        };
      }
    }
  }
  return null;
}

/// Exported for the morph certificate, which solves the same 1-D question the leak test does --
/// where along a curve every constraint can still be non-negative -- only with interval-valued
/// coefficients standing for a whole span of poses.
export function nonNegIntervals(coeffs) {
  const rs = bezRoots01(coeffs);
  const cuts = [0, ...rs, 1],
    out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k],
      b = cuts[k + 1];
    if (b - a < 1e-9) continue;
    if (bezEval(coeffs, (a + b) / 2) >= 0) {
      if (out.length && a - out[out.length - 1][1] < 1e-9) out[out.length - 1][1] = b;
      else out.push([a, b]);
    }
  }
  return out;
}

/// Direct audit of the CLAIM — grid-sample the bbox and compare the half-space conjunction
/// against exact ray-crossing spans. Independent of validatePatch's reasoning, so it is what
/// catches a wrong assumption in it rather than agreeing with it.
export function gridCheck(patch, n = 24) {
  const [x0, y0, x1, y1] = patchBBox(patch.curves);
  let bad = 0,
    tot = 0,
    worstI = -1,
    worstKind = null,
    worstPoint = null;
  // Offsets differ between the axes on purpose. With the same 0.5 on both, every sample of a
  // patch whose edge runs corner-to-corner lands exactly on that edge, where the two exact
  // methods disagree at the last bit — 16 of 256 samples on a triangle, which would read as a
  // converter defect when it is the grid.
  for (let r = 0; r < n; r++) {
    const y = y0 + (y1 - y0) * ((r + 0.3183) / n);
    const spans = rowSpans(patch.curves, y);
    for (let c = 0; c < n; c++) {
      const x = x0 + (x1 - x0) * ((c + 0.2718) / n);
      let ref = false;
      for (const [a, b] of spans)
        if (x >= a && x <= b) {
          ref = true;
          break;
        }
      tot++;
      if (inPatch(patch, x, y) !== ref) {
        bad++;
        // THE FIRST BAD SAMPLE NAMES AN OFFENDER, so the search has a curve to act on rather
        // than a bare count. A sample the loop holds but the patch rejects has some constraint
        // negative there -- that curve's implicit is wrong deep inside, the cubic case the
        // boundary tests cannot see -- and it is the one to halve or cut against. A sample the
        // patch claims outside the loop has every constraint positive: the nearest constraint
        // (smallest value against its gradient) is the curve whose extension admits it.
        if (worstI < 0) {
          worstPoint = [x, y];
          if (ref) {
            for (let i = 0; i < patch.impls.length; i++)
              if (patchEval(patch, i, x, y) < 0) {
                worstI = i;
                worstKind = 'grid';
                break;
              }
          } else {
            let best = Infinity;
            for (let i = 0; i < patch.impls.length; i++) {
              const g = implGrad(patch.impls[i].impl, x, y),
                gl = Math.hypot(g[0], g[1]) || 1;
              const d = patchEval(patch, i, x, y) / gl;
              if (d < best) {
                best = d;
                worstI = i;
              }
            }
            worstKind = 'leak';
          }
          if (worstI < 0) worstI = 0;
        }
      }
    }
  }
  return { bad, tot, i: worstI, kind: worstKind, point: worstPoint };
}

// ---- cutting --------------------------------------------------------------------
/// Split a patch along the line h == 0, keeping both sides. Returns { keep, drop } as lists
/// of closed curve loops, or null when the boundary crossings cannot be paired (a tangency,
/// or a cut through a vertex) — in which case the caller tries a different line rather than
/// emitting a loop it cannot justify.
export function cutPatchByLine(curves, h, inPt) {
  const subs = [];
  for (const seg of curves) {
    const ts = affRootsOnSeg(h, seg);

    if (!ts.length) {
      subs.push(seg);
      continue;
    }

    let prev = 0,
      sliced = false;
    for (const t of ts) {
      if (t - prev > 1e-5 && 1 - t > 1e-5) {
        subs.push(segSlice(seg, prev, t));
        prev = t;
        sliced = true;
      }
    }
    subs.push(sliced ? segSlice(seg, prev, 1) : seg);
  }
  if (!subs.length) return null;
  //
  // The segment belongs with the side the patch's INTERIOR is on, which is the side that keeps
  // it as a real boundary rather than an interior seam.
  const scale = geomScale(curves);
  const onLineEps = 1e-9 * scale;
  // The interior point is only consulted for a segment ON the line, which is rare -- so `inPt`
  // may be a thunk, and a replay that has no frame for this node does not build one for nothing.
  let insideSide = 0;
  const insideSideOf = () => {
    if (insideSide === 0) {
      const ip = typeof inPt === 'function' ? inPt() : inPt;
      insideSide = ip ? (affEval(h, ip[0], ip[1]) >= 0 ? 1 : -1) : 1;
    }
    return insideSide;
  };
  const sideOf = (seg) => {
    const m = segPt(seg, 0.5);
    const v = affEval(h, m[0], m[1]);
    if (Math.abs(v) <= onLineEps) return insideSideOf();
    return v >= 0 ? 1 : -1;
  };
  const sides = subs.map(sideOf);
  const dir = [-h[1], h[0]];
  const dl = Math.hypot(dir[0], dir[1]) || 1;
  const proj = (p) => (p[0] * dir[0] + p[1] * dir[1]) / dl;

  const assemble = (want) => {
    const n = subs.length,
      isW = sides.map((s) => s === want);
    if (isW.every((v) => v)) return [curves.slice()];
    if (!isW.some((v) => v)) return [];
    const chains = [];
    for (let i = 0; i < n; i++) {
      if (!isW[i] || isW[(i - 1 + n) % n]) continue;
      const c = [];
      let j = i;
      do {
        c.push(subs[j]);
        j = (j + 1) % n;
      } while (isW[j] && j !== i);
      chains.push(c);
    }
    if (!chains.length) return null;
    // Every chain begins and ends ON the cut line. Sorting those endpoints along the line
    // makes them alternate in/out of the region, so consecutive PAIRS bound the segments of
    // the line that are interior — which is where the closing edges go.
    const marks = [];
    chains.forEach((c, ci) => {
      marks.push({ s: proj(segStart(c[0])), p: segStart(c[0]), ci, kind: 'start' });
      marks.push({ s: proj(segEnd(c[c.length - 1])), p: segEnd(c[c.length - 1]), ci, kind: 'end' });
    });
    marks.sort((a, b) => a.s - b.s);
    if (marks.length % 2) return null;
    const nextChain = new Map();
    for (let k = 0; k < marks.length; k += 2) {
      const a = marks[k],
        b = marks[k + 1];
      if (a.kind === b.kind) return null; // not a clean alternation
      const [e, s] = a.kind === 'end' ? [a, b] : [b, a];
      nextChain.set(e.ci, { to: s.ci, from: e.p, at: s.p });
    }
    const out = [],
      used = new Set();
    for (let ci = 0; ci < chains.length; ci++) {
      if (used.has(ci)) continue;
      const loop = [];
      let cur = ci,
        guard = chains.length + 1;
      while (guard-- > 0) {
        used.add(cur);
        for (const s of chains[cur]) loop.push(s);
        const link = nextChain.get(cur);
        if (!link) return null;

        if (Math.hypot(link.at[0] - link.from[0], link.at[1] - link.from[1]) > 1e-6 * scale)
          loop.push({ t: 'line', P: [link.from, link.at], cut: true });
        cur = link.to;
        if (cur === ci) break;
      }
      if (loop.length) out.push(loop);
    }
    return out;
  };

  const keep0 = assemble(1),
    drop0 = assemble(-1);
  if (keep0 === null || drop0 === null) return null;
  // Remove exact two-edge retracings before framing; they enclose no area.
  const lens = (l) => l.length === 2 && _exactReverse(l[0], l[1]);
  const keep = keep0.some(lens) ? keep0.filter((l) => !lens(l)) : keep0;
  const drop = drop0.some(lens) ? drop0.filter((l) => !lens(l)) : drop0;
  // On a pinched loop the alternation can pair the wrong ends: a line through a bridge crosses both of
  // its coincident sides at one point, and the tie in the sort decides which chains close together.
  if (loopPinched(curves) && piecesOverlap([...keep, ...drop])) return null;
  return { keep, drop };
}

/// The parameters at which a polynomial segment passes nearest p, among the roots of x(u) = px
/// and y(u) = py: one of them is p's own parameter whenever p is on the segment's curve.
function invertCandidates(seg, p) {
  const cx = bernToPower(affBez([1, 0, -p[0]], seg)),
    cy = bernToPower(affBez([0, 1, -p[1]], seg));
  return rootsSorted(polyTrim(cx))
    .concat(rootsSorted(polyTrim(cy)))
    .filter((u) => Number.isFinite(u));
}

/// Pin known construction endpoints and stationary endpoint coefficients to zero
/// without mutating the cached composition.
function pinOnCurve(A, c, on) {
  const P = c.P,
    n = P.length - 1,
    m = A.length - 1;
  const s0 = on.has(P[0] + ''),
    s1 = on.has(P[n] + '');
  if (!s0 && !s1) return A;
  const B = A.slice();
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  if (s0) {
    B[0] = 0;
    if (n >= 2 && c.t !== 'rquad' && eq(P[1], P[0]) && m >= 1) B[1] = 0;
  }
  if (s1) {
    B[m] = 0;
    if (n >= 2 && c.t !== 'rquad' && eq(P[n - 1], P[n]) && m >= 1) B[m - 1] = 0;
  }
  return B;
}

/// Stage (e) of the paper: split a patch along a CURVE rather than a line.
///
/// cutPatchByLine can only separate a violation that some straight line separates. A LEAK is
/// not one of those. The area it wrongly claims is bounded by the offending curve's own
/// extension re-entering the patch, and in general no line divides that region from the patch
/// without also slicing the patch. So the cut edge has to be the extension arc itself. Both
/// halves are then bounded by that curve on the extension as well as on the real arc, which is
/// exactly what stops the conjunction claiming area past the curve's ends.
///
/// The extension is exact, not a fit: segSlice evaluates the blossom outside [0,1], so E is
/// the same algebraic curve carried beyond its parameter range. That also means implE vanishes
/// identically along curve i, so curve i is skipped and its two end nodes are seeded as
/// crossings instead — the paper's case 8a, where the extension leaves from a node.

/// Returns { keep, drop } shaped like cutPatchByLine, or null when no arc of E separates
/// anything — a tangency, or an extension that never re-enters.
/// `pair` names the two crossings to cut between -- (curve j, index k among that curve's accepted
/// crossings; the seed nodes are j = i, k = 0/1) -- as a previous cut reported them in its
/// result's `pair`. Given, only those two curves' crossings are computed and the arc tests are
/// skipped: the decision was made when the pair was recorded. That is what a replayed trace uses.
export function cutPatchByCurve(curves, i, bb, pair) {
  const seg = curves[i];
  // A line's extension is its own supporting line, which is precisely the cut cutPatchByLine
  // already makes. Nothing here to add, and the implicit of a line has no interior arc.
  if (!seg || seg.t === 'line') return null;
  const T = extensionSpan(seg, bb || patchBBox(curves));
  if (!T) return null;
  // The extension and its crossings are memoized on the curve. The span is a constant, so E is
  // a function of the segment; and the crossings of E with another curve j -- two compositions,
  // two root solves and a Newton refinement per match -- depend on the pair alone. The search
  // asks this for every curve of a leaking loop, and the same pairs recur in every loop those
  // curves share; rebuilt per call, uncached, it would be about a tenth of a conversion. Only
  // the tolerance a match is accepted at depends on the loop, so the raw
  // matches ride with their distance and the caller applies its own threshold.
  let ext = seg[K_EXT];
  if (ext === undefined) {
    const E = segSlice(seg, -T, 1 + T);
    const span = 1 + 2 * T;
    // The points known to lie on E exactly: curve i's own ends and its source's.
    const on = new Set([segStart(seg) + '', segEnd(seg) + '']);
    if (seg._srcP) {
      on.add(seg._srcP[0] + '');
      on.add(seg._srcP[seg._srcP.length - 1] + '');
    }
    ext = {
      E,
      implE: segImplicitMemo(E),
      lo: T / span,
      hi: (1 + T) / span,
      cross: new Map(),
      coin: new Map(),
      on,
    };
    seg[K_EXT] = ext;
  }
  const { E, implE, lo, hi } = ext;
  if (!implE) return null;
  const n = curves.length;

  const scale = geomScale(curves);
  const ptEps = 1e-6 * scale;

  /** @type {Array<{j:number,t:number,u:number,p:number[],node?:boolean,k:number}>} */
  const cross = [
    { j: i, t: 0, u: lo, p: segStart(seg), node: true, k: 0 },
    { j: i, t: 1, u: hi, p: segEnd(seg), node: true, k: 1 },
  ];
  // Seed coincident source slices by provenance; solving their zero composition finds rounding roots.
  const src = seg._src,
    key = algKey(seg);
  const s0 = segStart(seg),
    s1 = segEnd(seg);
  const onE = (q) => {
    // Curve i's own ends are E's points at lo and hi exactly; inverting them could answer the
    // other parameter of a double point instead.
    if (q[0] === s0[0] && q[1] === s0[1]) return lo;
    if (q[0] === s1[0] && q[1] === s1[1]) return hi;
    if (isRat(E)) return NaN;
    // At a double point, prefer the projected parameter nearest this arc.
    let best = NaN,
      bm = Infinity;
    for (const u0 of invertCandidates(E, q)) {
      let bu = u0;
      for (let it = 0; it < 24; it++) {
        const r = segPt(E, bu),
          d = segTangent(E, bu),
          den = d[0] * d[0] + d[1] * d[1];
        if (!(den > 0)) break;
        const step = ((r[0] - q[0]) * d[0] + (r[1] - q[1]) * d[1]) / den;
        if (!Number.isFinite(step)) break;
        bu -= step;
        if (Math.abs(step) < 1e-15) break;
      }
      const r = segPt(E, bu);
      if (!(Math.hypot(r[0] - q[0], r[1] - q[1]) <= ptEps)) continue;
      const m = Math.abs(bu - 0.5);
      if (m < bm - 1e-9) {
        bm = m;
        best = bu;
      }
    }
    return best;
  };
  const sibU = (s) => {
    if (!E._src.map) {
      const tt = (s - src.a) / (src.b - src.a);
      return (tt + T) / (1 + 2 * T);
    }
    // E's source map already includes its extension interval. Its inverse
    // returns E's canonical parameter without another affine extension.
    const map = E._src.map;
    if (!Number.isFinite(s)) return -map[3] / map[2];
    const denominator = map[2] * s - map[0];
    return denominator ? (map[1] - map[3] * s) / denominator : NaN;
  };
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const cj = curves[j];
    // Treat compositions below the relative term-magnitude threshold as coincident.
    let onCurve = key !== null && algKey(cj) === key;
    if (!onCurve && cj.t !== 'line') {
      let oc = ext.coin.get(segId(cj));
      if (oc === undefined) {
        oc = false;
        const A = alongMemo(E, implE, cj);
        implHullRange(implE, cj);
        const bar = 1e-12 * implHullMag();
        let amax = 0;
        for (let q = 0; q < A.length; q++) {
          const v = A[q] < 0 ? -A[q] : A[q];
          if (v > amax) amax = v;
        }
        if (bar > 0 && amax <= bar) oc = true;
        ext.coin.set(segId(cj), oc);
      }
      onCurve = oc;
    }
    if (onCurve) {
      // Placed by provenance when both are slices of one input curve, else by projecting its ends
      // onto E.
      const same = src && cj._src && cj._src.k === src.k && src.b !== src.a && algKey(cj) === key;
      const u0 = same ? sibU(cj._src.a) : onE(segStart(cj)),
        u1 = same ? sibU(cj._src.b) : onE(segEnd(cj));
      if (u0 > 0 && u0 < 1) cross.push({ j, t: 0, u: u0, p: segStart(cj), node: true, k: 0 });
      if (u1 > 0 && u1 < 1) cross.push({ j, t: 1, u: u1, p: segEnd(cj), node: true, k: 1 });
      continue;
    }
    // A replay solves only the two curves its pair names -- and the curve before each, whose end
    // root names the vertex the named curve leaves (see below).
    if (
      pair &&
      j !== pair.aj &&
      j !== pair.bj &&
      (j + 1) % n !== pair.aj &&
      (j + 1) % n !== pair.bj
    )
      continue;
    let matches = ext.cross.get(segId(cj));
    if (matches === undefined) {
      matches = null;

      const implJ = segImplicitMemo(cj);
      if (implJ) {
        const tRoots = bezRoots01(pinOnCurve(alongMemo(E, implE, cj), cj, ext.on));
        if (tRoots.length) {
          // Invert polynomial extension coordinates, then project. Rational extensions retain composition.
          const uRoots = isRat(E) ? bezRoots01(alongMemo(cj, implJ, E)) : null;
          if (!uRoots || uRoots.length) {
            matches = [];
            for (const t0 of tRoots) {
              // Map endpoint-band roots to exact vertices to avoid sliver cuts.
              const t = t0 <= 2e-6 ? 0 : t0 >= 1 - 2e-6 ? 1 : t0;
              const p = t === 0 ? segStart(cj) : t === 1 ? segEnd(cj) : segPt(cj, t);
              let bu = null,
                bd = Infinity;
              const us = uRoots || invertCandidates(E, p);
              for (const u of us) {
                if (!(u > 0 && u < 1)) continue;
                const q = segPt(E, u);
                const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (d < bd) {
                  bd = d;
                  bu = u;
                }
              }
              // An unmatched root is a zero of the implicit that is NOT on E's own arc — the
              // algebraic curve has branches the Bezier does not trace, and cutting along one of
              // those would invent an edge the patch never had. The distance rides along; the
              // caller decides at its own scale.
              if (bu === null) continue;

              const bu0 = bu;
              for (let it = 0; it < 24; it++) {
                const q = segPt(E, bu),
                  d = segTangent(E, bu);
                const den = d[0] * d[0] + d[1] * d[1];
                if (!(den > 1e-30)) break;
                const step = ((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1]) / den;
                bu -= step;
                if (Math.abs(step) < 1e-15) break;
              }
              // Judged by where the projection landed, not by the root it started from.
              {
                const q1 = segPt(E, bu),
                  d1 = Math.hypot(q1[0] - p[0], q1[1] - p[1]);
                if (!(d1 <= Math.max(bd, ptEps)) || !(bu > 0 && bu < 1)) bu = bu0;
                else if (d1 < bd) bd = d1;
              }
              matches.push({ t, u: bu, p, bd });
            }
          }
        }
      }
      ext.cross.set(segId(cj), matches);
    }
    if (!matches) continue;
    for (const mt of matches) {
      if (mt.bd > ptEps) continue;
      // A VERTEX IS NAMED BY THE CURVE THAT LEAVES IT. E through the joint of curves j and j+1 is one
      // crossing, which the two curves' solves report as an end root of either, both, or (by
      // rounding) only one of them -- three spellings of the same point that paired with different
      // neighbors. Duplicates are dropped below.
      if (mt.t === 1) {
        const jn = (j + 1) % n;
        cross.push({ j: jn, t: 0, u: mt.u, p: segStart(curves[jn]), k: -1 });
      } else cross.push({ j, t: mt.t, u: mt.u, p: mt.p, k: -1 });
    }
  }
  // A crossing ON a node is the node. The curve that starts where a sibling ends meets E there by
  // construction, and its root and the node then sorted by rounding -- the same point under two
  // names, which named different pieces. Likewise a vertex reported twice.
  {
    let w = 0;
    for (let c = 0; c < cross.length; c++) {
      const x = cross[c];
      let dup = false;
      if (!x.node)
        for (let d = 0; d < cross.length && !dup; d++) {
          const y = cross[d];
          if (y === x) continue;
          // Closer to a node than the pair walk below can separate (1e-6 of E) is at the node too.
          if (
            y.node
              ? Math.hypot(x.p[0] - y.p[0], x.p[1] - y.p[1]) <= ptEps || Math.abs(x.u - y.u) < 1e-6
              : d < c && x.t === 0 && y.t === 0 && y.j === x.j
          )
            dup = true;
        }
      if (!dup) cross[w++] = x;
    }
    cross.length = w;
  }
  // A crossing's name is its rank among its curve's crossings that survive, counted after the
  // duplicates above are gone, so a root found on one copy of the art and not another cannot
  // renumber the rest.
  {
    let pj = -1,
      kk = 0;
    for (let c = 0; c < cross.length; c++) {
      const x = cross[c];
      if (x.node) continue;
      if (x.j !== pj) {
        pj = x.j;
        kk = 0;
      }
      x.k = kk++;
    }
  }
  if (cross.length < 3) return null; // only the two seed nodes: nothing re-enters
  cross.sort((a, b) => a.u - b.u);

  // Walk the boundary forward from one crossing to the next, splitting the two curves the
  // crossings sit on.
  const forward = (a, b) => {
    const chain = [];
    if (a.j === b.j && b.t > a.t + 1e-9) {
      chain.push(segSlice(curves[a.j], a.t, b.t));
      return chain;
    }
    if (a.t < 1 - 1e-9) chain.push(segSlice(curves[a.j], a.t, 1));
    for (let k = (a.j + 1) % n, guard = 0; k !== b.j && guard <= n; k = (k + 1) % n, guard++)
      chain.push(curves[k]);
    if (b.t > 1e-9) chain.push(segSlice(curves[b.j], 0, b.t));
    return chain;
  };
  const extent = (l) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s2 of l)
      for (const q of s2.P) {
        x0 = Math.min(x0, q[0]);
        x1 = Math.max(x1, q[0]);
        y0 = Math.min(y0, q[1]);
        y1 = Math.max(y1, q[1]);
      }
    return Math.max(x1 - x0, y1 - y0);
  };

  // The two halves, once a pair of crossings has been accepted.
  const build = (a, b) => {
    const eMin = 1e-9 * extent(curves);
    const chainAB = forward(a, b).filter((s2) => s2 && extent([s2]) > eMin);
    const chainBA = forward(b, a).filter((s2) => s2 && extent([s2]) > eMin);
    if (!chainAB.length || !chainBA.length) return null;
    // `cut: true` marks a seam the converter introduced rather than an edge of the shape: the
    // two halves share it, and antialiasing both sides of a shared seam composites two ~0.5
    // coverages to 0.75 under OVER instead of 1.
    //
    // The reverse is built by reversing the control points, not by slicing E a second time:
    // the two halves then carry bit-identical seam geometry, where re-slicing would leave them
    // disagreeing by rounding along an edge they are supposed to share exactly.
    const fwdArc = { ...segSlice(E, a.u, b.u), cut: true };
    // segRev, not a spread with the points reversed: the spread carries `_src` across unchanged,
    // so the provenance still reads a -> b while the geometry now runs b -> a. Rebuilt on another
    // pose that piece comes back backwards, and the patch closes on the wrong points.
    const revArc = segRev(fwdArc);
    revArc.cut = true;

    const pkS = segImplicitPackedMemo(seg),
      imS = segImplicitMemo(seg);
    if (pkS && imS) {
      fwdArc[K_PK] = pkS;
      revArc[K_PK] = pkS;
      fwdArc[K_IMPL] = imS;
      revArc[K_IMPL] = imS;
    }
    const loop1 = chainAB.concat([revArc]);
    const loop2 = chainBA.concat([fwdArc]);
    if (loop1.length < 2 || loop2.length < 2) return null;
    if (loop1.length >= n + 2 && loop2.length >= n + 2) return null; // neither side shrank
    // A SIDE THAT RUNS ALONG ITS own CURVE both WAYS IS NO CUT (see selfOpposed): where
    // the chain between the two crossings is the curve's own sibling, E there IS that chain, one side
    // is a lens and the other the loop again. Nor is a side narrower than one float32 step (see
    // belowFloat32): where the chain is another curve a rounding off E, the same. Refused here, so
    // the search takes the next pair rather than enqueueing a lens and the loop it came from.
    if (selfOpposed(loop1) || selfOpposed(loop2)) return null;
    if (belowFloat32(loop1) || belowFloat32(loop2)) return null;
    return { keep: [loop1], drop: [loop2], pair: { aj: a.j, ak: a.k, bj: b.j, bk: b.k } };
  };
  if (pair) {
    const a = cross.find((c) => c.j === pair.aj && c.k === pair.ak);
    const b = cross.find((c) => c.j === pair.bj && c.k === pair.bk);
    return a && b ? build(a, b) : null;
  }
  for (let c = 0; c + 1 < cross.length; c++) {
    const a = cross[c],
      b = cross[c + 1];
    if (b.u - a.u < 1e-6) continue;
    // The span between the two seed nodes with nothing in between IS curve i. Cutting along it
    // reproduces the patch.
    if (a.node && b.node) continue;
    const arc = segSlice(E, a.u, b.u);

    let onArc = true;
    for (let k = 0; k < ARC_SAMPLES.length && onArc; k++) {
      const m = segPt(arc, ARC_SAMPLES[k]);
      if (!inside(curves, m[0], m[1])) onArc = false;
    }
    if (!onArc) continue; // the arc runs outside: it separates nothing
    // And it must not cross the boundary in between. Sampling the arc's interior cannot see a
    // crossing that goes out and back between two samples, and an extension leaving its node
    // along the neighboring curve does exactly that, several times within a few units --
    // grazing crossings the two root solves fail to pair. A patch with such a seam had a loop
    // that crossed itself 98 times and a 2-unit wedge of ink outside the outline that every
    // per-patch test called clean. Flattened, the test is exact enough: a crossing the polylines
    // miss is one the ramp cannot show either.
    if (arcCrossesLoop(arc, curves, a.j, b.j, scale)) continue;
    const r = build(a, b);
    if (r) return r;
  }
  return null;
}

// ---- grid split (Dokter's hierarchy, without compute) ----------------------------
/// Split a patch's cover into a G x G grid of cells, each carrying only the curves that can
/// still affect it. This is the paper's hierarchy adapted to what WebGL2 has: Dokter skips
/// curve testing for sub-tiles proven interior, which needs a compute pass to build; the same
/// saving is available at CONVERSION time if each cell carries its own curve list instead of
/// the patch's.
///
/// A CPatch fragment pays N implicit evaluations wherever it lands, and in a large patch most
/// fragments are deep interior where every constraint is satisfied by a mile. Per cell:
///
///   some curve is negative over the whole cell  -> the cell is outside; emit nothing
///   a curve is positive by more than the AA reach -> that curve cannot affect this cell; drop
///                                                    it from the cell's list
///   nothing left in the list                    -> solid interior; the kernel's loop does not
///                                                  execute at all
///
/// Bounds come from interval arithmetic on the packed form. Every implicit is a sum of products
/// of AFFINE functionals, and an affine over a box takes its extremes at the corners, so the
/// products compose by interval rules. Conservative by construction: a cell is only dropped or
/// simplified when the bound PROVES it, so the output is the same picture with less work.
/// `opts.movePx` — how far the geometry may MOVE before these cells are used again, and
/// `opts.cover` / `opts.coverLines` — a cover to split instead of this pose's own.
///
/// Both exist for morphs. The two decisions a cell makes are "this constraint fails over all of
/// me, so I am outside" and "this constraint holds over me by more than the AA reach, so it
/// cannot affect me" — and both are read at ONE pose. Across a span of poses they stay true if
/// each is asked with the motion folded in: a point of the patch moves by at most the largest
/// control-point displacement between the span's ends, and iv.gmax is already the gradient bound
/// this file uses to turn an implicit value into pixels. With that margin the cells are fixed for
/// the whole span, which is what lets a morph keep the split at all — without it the cell COUNT
/// moves with the geometry and every frame is a rebuild rather than a rewrite.
export function gridSplitPatch(frame, G, aaPx, opts) {
  const movePx = (opts && opts.movePx) || 0;
  const packs = frame.impls.map((im) => im.packed);
  if (packs.some((p) => !p)) return null;
  const H = (opts && opts.cover) || patchCoverHull(frame.curves);
  if (!H) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of H) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  // The HULL's own extent, kept before gridBox overwrites the grid's. A cell that owns past its
  // box owns out to here and no further -- nothing outside the hull is ever painted.
  const hx0 = x0,
    hy0 = y0,
    hx1 = x1,
    hy1 = y1;

  if (opts && opts.gridBox) {
    x0 = opts.gridBox[0];
    y0 = opts.gridBox[1];
    x1 = opts.gridBox[2];
    y1 = opts.gridBox[3];
  }
  const cw = (x1 - x0) / G,
    ch = (y1 - y0) / G;
  const hullLines = (opts && opts.coverLines) || patchCoverLines(frame.curves);
  if (!hullLines) return null;
  const cells = [],
    grid = new Array(G * G).fill(null);
  for (let gy = 0; gy < G; gy++)
    for (let gx = 0; gx < G; gx++) {
      // Derive both copies of a shared grid edge from the same expression.
      // Floating-point addition of a cell width need not reproduce that edge.
      const bx0 = x0 + gx * cw,
        by0 = y0 + gy * ch,
        bx1 = x0 + (gx + 1) * cw,
        by1 = y0 + (gy + 1) * ch;
      let outside = false;
      for (let i = 0; i < packs.length && !outside; i++) {
        const iv = packedInterval(packs[i], frame.impls[i].s, bx0, by0, bx1, by1);
        if (iv.max < -movePx * iv.gmax) {
          outside = true;
          break;
        } // fails over the whole cell,
        // by more than the geometry can move
      }
      if (outside) continue;

      if (
        !clipToHull(
          [
            [bx0, by0],
            [bx1, by0],
            [bx1, by1],
            [bx0, by1],
          ],
          hullLines,
        )
      )
        continue;
      grid[gy * G + gx] = { box: [bx0, by0, bx1, by1], gx, gy };
    }
  // A SIDE IS "OUTER" WHEN IT HAS NO NEIGHBOR — not when it is on the grid's edge.
  //
  // Cells are dropped where the patch does not reach them (`outside`, or an empty clip), so a
  // cell in the middle of the grid can still have nothing beyond one of its sides. The renderer
  // treats an outer side as it does the patch's own outline: unbounded ownership, and full
  // dilation so the AA ramp has room. An INTERNAL side is a seam, where the neighbor continues
  // the shape and only the cell whose LO edge is that seam may overshoot it.
  //
  // Keying this on `gx === 0 || gx === G-1` instead — the grid's extent — would treat a seam
  // whose neighbor has been dropped as internal, so neither side would cover it.
  const OPEN = 1e30;
  for (const c of grid) {
    if (!c) continue;
    const has = (dx, dy) => {
      const nx = c.gx + dx,
        ny = c.gy + dy;
      return nx >= 0 && ny >= 0 && nx < G && ny < G && !!grid[ny * G + nx];
    };
    c.nbrLoX = has(-1, 0);
    c.nbrLoY = has(0, -1);
    c.nbrHiX = has(1, 0);
    c.nbrHiY = has(0, 1);
    c.ownBox = [
      c.nbrLoX ? c.box[0] : -OPEN,
      c.nbrLoY ? c.box[1] : -OPEN,
      c.nbrHiX ? c.box[2] : OPEN,
      c.nbrHiY ? c.box[3] : OPEN,
    ];
    // WHAT IT OWNS IS WHAT IT MUST DRAW, AND WHAT ITS CONSTRAINTS MUST COVER.

    // Out to the HULL, not to infinity: the hull bounds the patch, so a fragment beyond it is
    // painted by nobody whether this cell claims it or not.
    const ex0 = c.nbrLoX ? c.box[0] : Math.min(c.box[0], hx0);
    const ey0 = c.nbrLoY ? c.box[1] : Math.min(c.box[1], hy0);
    const ex1 = c.nbrHiX ? c.box[2] : Math.max(c.box[2], hx1);
    const ey1 = c.nbrHiY ? c.box[3] : Math.max(c.box[3], hy1);
    const keep = [];
    for (let i = 0; i < packs.length; i++) {
      const iv = packedInterval(packs[i], frame.impls[i].s, ex0, ey0, ex1, ey1);
      if (iv.min > (aaPx + movePx) * iv.gmax) continue; // satisfied over everything this cell owns
      keep.push(i);
    }
    c.curves = keep;
    c.poly = clipToHull(
      [
        [ex0, ey0],
        [ex1, ey0],
        [ex1, ey1],
        [ex0, ey1],
      ],
      hullLines,
    );
    if (!c.poly || c.poly.length < 3) continue;
    cells.push(c);
  }
  return cells;
}

/// Sutherland-Hodgman against a CONVEX hull's inward half-planes. Exact, and it cannot produce
/// a polygon larger than either input, which is the property the leak fix depends on.
function clipToHull(poly, lines) {
  let out = poly;
  for (const h of lines) {
    if (!out.length) return null;
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i],
        b = out[(i + 1) % out.length];
      const da = h[0] * a[0] + h[1] * a[1] + h[2];
      const db = h[0] * b[0] + h[1] * b[1] + h[2];
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    out = next;
  }
  return out.length >= 3 ? out : null;
}

// Scalar interval arithmetic avoids temporary affine objects in the
// candidate-pair bound.
const ivAdd = (a, b) => ({ min: a.min + b.min, max: a.max + b.max });
const ivMul = (a, b) => {
  const v = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max];
  return { min: Math.min(...v), max: Math.max(...v) };
};
/// An affine functional over an axis-aligned box: extremes at the corners, so the bound is
/// exact rather than merely valid.
const ivAff = (f, bx0, by0, bx1, by1) => {
  const a = f[0],
    b = f[1];
  const xl = a >= 0 ? a * bx0 : a * bx1,
    xh = a >= 0 ? a * bx1 : a * bx0;
  const yl = b >= 0 ? b * by0 : b * by1,
    yh = b >= 0 ? b * by1 : b * by0;
  return { min: xl + yl + f[2], max: xh + yh + f[2] };
};
const ivSq = (a) =>
  a.min > 0
    ? { min: a.min * a.min, max: a.max * a.max }
    : a.max < 0
      ? { min: a.max * a.max, max: a.min * a.min }
      : { min: 0, max: Math.max(a.min * a.min, a.max * a.max) };
// scalar forms: each writes (_m, _M)
let _m = 0,
  _M = 0;
function ivAffS(f, bx0, by0, bx1, by1) {
  const a = f[0],
    b = f[1];
  const xl = a >= 0 ? a * bx0 : a * bx1,
    xh = a >= 0 ? a * bx1 : a * bx0;
  const yl = b >= 0 ? b * by0 : b * by1,
    yh = b >= 0 ? b * by1 : b * by0;
  _m = xl + yl + f[2];
  _M = xh + yh + f[2];
}
function ivSqS(mn, mx) {
  if (mn > 0) {
    _m = mn * mn;
    _M = mx * mx;
  } else if (mx < 0) {
    _m = mx * mx;
    _M = mn * mn;
  } else {
    _m = 0;
    _M = Math.max(mn * mn, mx * mx);
  }
}
function ivMulS(am, aM, bm, bM) {
  const v0 = am * bm,
    v1 = am * bM,
    v2 = aM * bm,
    v3 = aM * bM;
  _m = Math.min(v0, v1, v2, v3);
  _M = Math.max(v0, v1, v2, v3);
}
/// DOES this INTERVAL PROVE THE IMPLICIT STAYS NON-NEGATIVE ON THE BOX?

const ivClearsZero = (iv) => iv.min > 1e-12 * Math.max(Math.abs(iv.min), Math.abs(iv.max));
const _ivOut = { min: 0, max: 0, gmax: 0 };

/// Interval of the SIGNED implicit over a cell, plus an upper bound on |grad f| there — the
/// two together turn "how positive is this constraint" into a pixel distance the AA reach can
/// be compared against. Returns a SHARED record: read it before the next call.
/// `needG` false skips the gradient bound: the pair prune reads only `min`, and |grad| costs
/// a hypot per functional.
const gmOf = (a, k, s) => Math.hypot(a[k][0], a[k][1]) * s;
function packedInterval(pk, sgn, bx0, by0, bx1, by1, needG = true) {
  const a = pk.a,
    kind = pk.kind;
  const gm = needG ? (k, s) => gmOf(a, k, s) : () => 0;
  let ivm, ivM, gmax;
  ivAffS(a[0], bx0, by0, bx1, by1);
  const a0m = _m,
    a0M = _M;
  if (kind === 0 || kind === 2) {
    ivm = a0m;
    ivM = a0M;
    gmax = gm(0, 1);
  } else {
    ivAffS(a[1], bx0, by0, bx1, by1);
    const a1m = _m,
      a1M = _M;
    const abs0 = Math.max(Math.abs(a0m), Math.abs(a0M));
    if (kind === 1) {
      ivSqS(a0m, a0M);
      ivm = _m + -a1M;
      ivM = _M + -a1m;
      gmax = gm(0, 2 * abs0) + gm(1, 1);
    } else {
      ivAffS(a[2], bx0, by0, bx1, by1);
      const a2m = _m,
        a2M = _M;
      const abs1 = Math.max(Math.abs(a1m), Math.abs(a1M)),
        abs2 = Math.max(Math.abs(a2m), Math.abs(a2M));
      if (kind === 5) {
        ivMulS(a1m, a1M, a2m, a2M);
        const pm = _m,
          pM = _M;
        ivSqS(a0m, a0M);
        ivm = _m + -pM;
        ivM = _M + -pm;
        gmax = gm(0, 2 * abs0) + gm(1, abs2) + gm(2, abs1);
      } else if (kind === 3) {
        const cm = a0m ** 3,
          cM = a0M ** 3; // cube is monotonic
        ivMulS(a1m, a1M, a2m, a2M);
        ivm = cm + -_M;
        ivM = cM + -_m;
        gmax = gm(0, 3 * abs0 ** 2) + gm(1, abs2) + gm(2, abs1);
      } else {
        ivAffS(a[3], bx0, by0, bx1, by1);
        const a3m = _m,
          a3M = _M;
        const abs3 = Math.max(Math.abs(a3m), Math.abs(a3M));
        const C0 = pk.c[0],
          C1 = pk.c[1];
        // ivMul(ivMul({C1,C1}, A0), A3)
        ivMulS(C1, C1, a0m, a0M);
        ivMulS(_m, _M, a3m, a3M);
        const t1m = _m,
          t1M = _M;
        // ivMul({-C0*C0,-C0*C0}, A0)
        ivMulS(-C0 * C0, -C0 * C0, a0m, a0M);
        const t2m = _m,
          t2M = _M;
        const s1m = t1m + t2m,
          s1M = t1M + t2M; // ivAdd(t1, t2)
        // ivMul({-C1,-C1}, ivSq(A1))
        ivSqS(a1m, a1M);
        const sq1m = _m,
          sq1M = _M;
        ivMulS(-C1, -C1, sq1m, sq1M);
        const t3m = _m,
          t3M = _M;
        // ivMul({2*C0,2*C0}, ivMul(A1, A2))
        ivMulS(a1m, a1M, a2m, a2M);
        ivMulS(2 * C0, 2 * C0, _m, _M);
        const t4m = _m,
          t4M = _M;
        const s2m = t3m + t4m,
          s2M = t3M + t4M; // ivAdd(t3, t4)
        // { min: -ivMul(A3, ivSq(A2)).max, max: -ivMul(A3, ivSq(A2)).min }
        ivSqS(a2m, a2M);
        const sq2m = _m,
          sq2M = _M;
        ivMulS(a3m, a3M, sq2m, sq2M);
        const t5m = -_M,
          t5M = -_m;
        const s3m = s2m + t5m,
          s3M = s2M + t5M; // ivAdd(s2, t5)
        ivm = s1m + s3m;
        ivM = s1M + s3M; // ivAdd(s1, s3)
        const absSq2 = Math.max(Math.abs(sq2m), Math.abs(sq2M));
        gmax =
          gm(0, Math.abs(C1) * abs3 + C0 * C0) +
          gm(3, Math.abs(C1) * abs0 + absSq2) +
          gm(1, 2 * Math.abs(C1) * abs1 + 2 * Math.abs(C0) * abs2) +
          gm(2, 2 * Math.abs(C0) * abs1 + 2 * abs3 * abs2);
      }
    }
  }
  if (sgn >= 0) {
    _ivOut.min = ivm;
    _ivOut.max = ivM;
  } else {
    _ivOut.min = -ivM;
    _ivOut.max = -ivm;
  }
  _ivOut.gmax = gmax; // a bound on |grad|, which scales with the drawing: no absolute floor
  return _ivOut;
}

///
/// The reason is in scoreOf's caller: the bound starts at the DO-nothing score, not at
/// infinity, so the very first candidate is already pruned against something meaningful and a
/// better first guess has nothing left to save. Ordering pays when the first bound is weak;
/// here it is strong from the start.
/// `tanTol`, under a MORPH (a non-zero leakMargin), is the plan's accepted defect size: see the note
/// at the end, where it removes the candidates a layout cannot carry to another pose.
function cutCandidates(patch, w, wide, tanTol = 0) {
  const seg = patch.curves[w.i],
    out = [],
    fan = [];
  const patchExt = loopExtent(patch.curves);

  let _tag = '';
  const lineThrough = (p, d) => {
    // The direction comes from a tangent or a hull edge of this loop, so the loop's extent is its
    // scale; a direction shorter than that by 1e-12 carries no usable angle.
    const L = Math.hypot(d[0], d[1]);
    if (!(L >= 1e-12 * patchExt)) return null;
    const nx = -d[1] / L,
      ny = d[0] / L;
    /** @type {number[] & {tag?:string}} */
    const h = [nx, ny, -(nx * p[0] + ny * p[1])];
    h.tag = _tag;
    return h;
  };
  const A = segStart(seg),
    B = segEnd(seg);
  let _end = 0;
  for (const [p, t] of [
    [A, segTangent(seg, 0)],
    [B, segTangent(seg, 1)],
  ]) {
    _tag = 'tan' + _end;
    const h = lineThrough(p, t);
    if (h) out.push(h);
    _tag = 'nrm' + _end;
    _end++;
    // ...and the NORMAL at the same endpoint. A leak lives past an end of the arc, so the line
    // that separates "before this endpoint" from "beyond it" is the one perpendicular to the
    // curve there — the tangent, which is what an extension CROSSING needs, is the wrong line
    // for an extension that simply carries on.
    const hn = lineThrough(p, [-t[1], t[0]]);
    if (hn) out.push(hn);
  }
  _tag = 'chord';
  const ch = lineThrough(A, [B[0] - A[0], B[1] - A[1]]);
  if (ch) out.push(ch);
  //
  // Every candidate above comes from the OFFENDING curve, which is where the violation was
  // detected and not necessarily where the region divides best. Lifting that assumption helps
  // the CURVE cut (fewer patches, less over-fill); for the lines it does not:
  //
  //   scored always      the pool grows with the loop and the search runs the heap out
  //   as a LAST RESORT   only when the narrow pool found nothing: slightly MORE patches and curve
  //                      references, over-fill unchanged -- a few blind chord cuts become many
  //                      wide ones, and each costs more than it saves
  //
  // A chord cut is crude but it TERMINATES — one side loses the curve as a constraint entirely.
  // A far-away tangent separates without simplifying, so the pieces come back needing more cuts.
  // The wide candidates stay available behind `wide` (opt-in).
  if (wide) {
    for (let ci = 0; ci < patch.curves.length; ci++) {
      if (ci === w.i) continue;
      const s2 = patch.curves[ci],
        A2 = segStart(s2),
        B2 = segEnd(s2);
      for (const [p, t, nm] of [
        [A2, segTangent(s2, 0), 'a'],
        [B2, segTangent(s2, 1), 'b'],
      ]) {
        _tag = 'w' + ci + 'tan' + nm;
        const h = lineThrough(p, t);
        if (h) out.push(h);
        _tag = 'w' + ci + 'nrm' + nm;
        const hn = lineThrough(p, [-t[1], t[0]]);
        if (hn) out.push(hn);
      }
      _tag = 'w' + ci + 'chord';
      const hc2 = lineThrough(A2, [B2[0] - A2[0], B2[1] - A2[1]]);
      if (hc2) out.push(hc2);
    }
  }

  let _which = 0;
  for (const seg2 of [seg, patch.curves[w.j]]) {
    for (let k = 0; k + 1 < seg2.P.length; k++) {
      const p = seg2.P[k],
        q = seg2.P[k + 1];
      _tag = 'hull' + _which + ':' + k;
      const h = lineThrough(p, [q[0] - p[0], q[1] - p[1]]);
      if (h) out.push(h);
    }
    _which++;
  }
  // A leak knows exactly WHERE it is, and the candidates above do not use that. leakOf reports
  // the offending point and which end of the arc it lies past, so the cut that separates the
  // two is the one through that endpoint perpendicular to the direction of the leak. Without
  // this a leak arrives with w.j == w.i, every vertex-chord candidate below degenerates to a
  // point, and the search has nothing aimed at the actual defect — and CUT SEAMS are where most
  // such leaks sit.
  if (w.kind === 'leak' && w.point) {
    const v = w.past ? B : A;
    const d = [w.point[0] - v[0], w.point[1] - v[1]];
    _tag = 'leakV';
    const h = lineThrough(v, [-d[1], d[0]]);
    if (h) out.push(h);
    // ...and the same separator placed at the midpoint between them, for a leak that starts
    // right at the vertex where a perpendicular through it cuts nothing off.
    const mid = [(v[0] + w.point[0]) / 2, (v[1] + w.point[1]) / 2];
    _tag = 'leakM';
    const h2 = lineThrough(mid, [-d[1], d[0]]);
    if (h2) out.push(h2);
    // STAGE (f), extension correction: ROTATE the separator about the anchor. The perpendicular
    // is the right line only when the false region sits squarely past the endpoint; when it is
    // off to one side, the perpendicular either misses it or takes real patch with it, and the
    // search had nothing else aimed at the defect.
    //
    // The paper rotates from a random start and narrows the angle until the cut fits. A fixed
    // fan is used instead, because a decomposition has to be reproducible: the morph tape
    // replays candidates BY INDEX, and a random start would renumber them.
    //
    // Three steps of pi/8 each way, swept on the corpus (patches / invalid):
    //   none 3288/13   k1 3267/15   k2 3252/13   k3 3191/12   k4 3209/12   k6 3209/12
    // Past 3 it plateaus, and for a reason worth keeping: 3pi/8 is already nearly parallel to
    // the leak direction, and a separator parallel to the leak separates nothing.
    const L = Math.hypot(d[0], d[1]) || 1;
    const ux = d[0] / L,
      uy = d[1] / L;
    for (let k = 1; k <= 3; k++) {
      for (const sgn of [1, -1]) {
        const a = (sgn * k * Math.PI) / 8,
          ca = Math.cos(a),
          sa = Math.sin(a);
        const rd = [ux * ca - uy * sa, ux * sa + uy * ca];
        _tag = 'fanV:' + k + ':' + sgn;
        const hr = lineThrough(v, [-rd[1], rd[0]]);
        if (hr) fan.push(hr);
        _tag = 'fanM:' + k + ':' + sgn;
        const hm = lineThrough(mid, [-rd[1], rd[0]]);
        if (hm) fan.push(hm);
      }
    }
  }
  const other = patch.curves[w.j];
  let _vq = 0;
  for (const q of [segStart(other), segEnd(other)])
    for (const p of [A, B]) {
      _tag = 'vchord:' + _vq++;
      const h = lineThrough(p, [q[0] - p[0], q[1] - p[1]]);
      if (h) out.push(h);
    }
  // Near-duplicates are common (a line's tangent IS the line; a quad's hull edge can parallel
  // its chord) and each survivor costs a full re-validation of every resulting loop.
  /** @type {Array<number[] & {tag?:string}> & {narrow?:number}} */
  const uniq = [];

  let dbb = patch.curves[K_BBOX];
  if (dbb === undefined) {
    dbb = patchBBox(patch.curves);
    patch.curves[K_BBOX] = dbb;
  }
  const dEps = 1e-6 * (Math.max(dbb[2] - dbb[0], dbb[3] - dbb[1]) || 1);
  const dup = (into, h) =>
    into.some((g) => {
      const c = g[0] * h[0] + g[1] * h[1];
      return Math.abs(c) > 0.9999 && Math.abs(g[2] - h[2] * Math.sign(c)) < dEps;
    });
  // UNDER A MORPH, NO CUT ALONG AN ARC'S own END TANGENT. Such a line meets that arc
  // at its end with a zero angle, so the seam it becomes carries straight on along the arc -- and
  // the layout transfers a seam by its two ENDPOINTS (extractLayout), which cannot carry a tangency
  // to any other pose. The smallest motion turns the seam against the arc, and its extension then
  // runs along the arc on the patch's side for as far as the arc stays flat. splitForMorph cuts
  // every cubic at its inflections, so the arc is at its FLATTEST exactly there: a patch leak-free
  // at t0 can leak units deep at t0 + 0.001. certifyMorphLeak refuses every span such a layout is
  // handed (rightly -- the leak is real), so planMorph would emit a minStep segment, re-convert, get
  // the same tangent back, and walk the morph a 512th at a time: hundreds of segments and millions
  // of boxes on a cubic blob, and on imported (float32) coordinates no plan inside a minute.
  //
  // Which candidates those are is a question about GEOMETRY, not about tags: 'tan0'/'tan1' and the
  // first and last control-hull edges are the end tangents by definition, and a cubic's MIDDLE hull
  // edge is one too wherever that end is an inflection -- which is where splitForMorph puts every
  // end it makes. And "the tangent" is judged at the plan's own bar, because the certificate cannot
  // tell two lines apart that stay within it: a candidate passing within `tanTol` of an arc's end
  // and turning away from that arc's tangent by less than `tanTol` across the whole patch is, to
  // everything downstream, the tangent itself. Both halves scale with the drawing, so the verdict
  // does not change with the size it is authored at. A static conversion passes 0 and is unchanged.
  //
  let alongEndTangent = null;
  if (tanTol > 0) {
    const ends = [];
    for (const c of patch.curves) {
      for (const u of [0, 1]) {
        const e = u ? segEnd(c) : segStart(c),
          t = segTangent(c, u),
          L = Math.hypot(t[0], t[1]);
        if (L > 0) ends.push([e, t[0] / L, t[1] / L]);
      }
    }
    const span = Math.max(dbb[2] - dbb[0], dbb[3] - dbb[1]);
    alongEndTangent = (h) =>
      ends.some(
        ([e, tx, ty]) =>
          Math.abs(h[0] * e[0] + h[1] * e[1] + h[2]) <= tanTol &&
          Math.abs(h[0] * tx + h[1] * ty) * span <= tanTol,
      );
  }
  const allowed = (h) => !alongEndTangent || !alongEndTangent(h);
  for (const h of out) if (allowed(h) && !dup(uniq, h)) uniq.push(h);

  const narrow = uniq.length;
  for (const h of fan) if (allowed(h) && !dup(uniq, h)) uniq.push(h);
  uniq.narrow = narrow;
  return uniq;
}

function chordCut(seg) {
  const A = segStart(seg),
    B = segEnd(seg);
  const dx = B[0] - A[0],
    dy = B[1] - A[1],
    L = Math.hypot(dx, dy);
  if (L < 1e-12 * segExtent(seg)) return null;
  return [-dy / L, dx / L, -((-dy / L) * A[0] + (dx / L) * A[1])];
}

// Mark speculative candidate scoring separately from accepted-patch work.
function scoreOf(loops, tolPx, best, margin = 0, withLeak = true, cheap = false, hint = null) {
  const was = _inScore;
  _inScore = true;
  try {
    return scoreOfInner(loops, tolPx, best, margin, withLeak, cheap, hint);
  } finally {
    _inScore = was;
  }
}
let _inScore = false;
export const cpInScore = () => _inScore;
function scoreOfInner(loops, tolPx, best, margin = 0, withLeak = true, cheap = false, hint = null) {
  cpStats.score++;
  let pairs = 0,
    depth = 0;

  const tie = TIE_REL * tolPx;
  const worseThanBest = () =>
    best && (pairs > best.pairs || (pairs === best.pairs && depth >= best.depth - tie));
  //
  const frames = [];
  for (const l of loops) {
    const f = framePatch(l, undefined, cheap, hint);
    if (!f) return null;
    frames.push(f);
    // The same pair sweep validatePatch USES, inheriting the parent's answers for every pair of
    // pass-through curves -- see pairSweep. This is the hotter of the two loops by an order of
    // magnitude, since it runs for every loop of every candidate cut.
    const stop = !CLIP_TESTS
      ? false
      : pairSweep(f, (i, j, r) => {
          const d = r.dep;
          if (d > tolPx) {
            pairs++;
            depth += d;
            if (worseThanBest()) return true;
          }
          return false;
        });
    if (stop) return null;
  }
  if (worseThanBest()) return null;

  if (withLeak)
    for (const f of frames) {
      const lk = leakOf(f, tolPx, margin);
      if (lk) {
        pairs++;
        depth += lk.depth;
        if (worseThanBest()) return null;
      }
    }
  return { pairs, depth };
}

/// How close two scores must be to count as tied, as a fraction of the conversion's own tolerance.
/// 1e-9 and 1e-12 of a flat 0.05 bar, kept in proportion so the ranking is unchanged at that bar.
/// ...and, since a depth SUM carries the rounding of every depth in it, as a fraction of the sum
/// too. Two cuts that leave the same violations untouched score the same sum computed through
/// different frames, which differed by 9e-10 against a 4e-10 bar on a sum of 44 and picked a
/// different cut on a copy of the art perturbed by 1e-14.
const TIE_REL = 2e-11,
  TIE_LESS_REL = 2e-8,
  SCORE_TIE_REL = 1e-8;
const scoreLess = (a, b, tolPx) =>
  a.pairs < b.pairs ||
  (a.pairs === b.pairs &&
    a.depth < b.depth - Math.max(TIE_LESS_REL * (tolPx || 0.05), SCORE_TIE_REL * b.depth)); ///
function subdivideCurve(curves, i) {
  const seg = curves[i];
  if (seg.t === 'line') return null;
  const out = curves.slice();
  out.splice(i, 1, segSlice(seg, 0, 0.5), segSlice(seg, 0.5, 1));
  return out;
}

/// Terminal decomposition: the fallback the search falls back TO, built rather than searched.
///
/// It is not a thing that "cannot fail", for two reasons, both handled. A cubic attached to its
/// chord whole is not a crescent: a crescent is only Loop-Blinn's primitive once the cubic is cut
/// at its inflections and double point, so every cubic is split first. And even split, a cubic's
/// algebraic curve can run back through its own control hull, which is the patch's cover — so a
/// piece that still does not validate is halved (see TERM_SUB_CAP), shrinking that hull until the
/// far branch is outside it.
///
/// It is the Loop-Blinn decomposition, expressed as CPatches — which it can be, because both of
/// its pieces already are one. A convex polygon IS the intersection of its edge half-planes,
/// exactly, so every triangle of a triangulation is a valid patch with three line constraints.
/// And a crescent between an arc and its chord, bounded by the curve's control hull, is
/// Loop-Blinn's own primitive.
///
///   chords -> polygon -> ear clip           every triangle is a valid patch
///   curve bulging OUT of the polygon        emit its crescent as a patch (union adds it)
///   curve bulging IN                        add its constraint to the triangles on its chord
///                                           (union cannot subtract, so the bite is taken by
///                                            intersecting rather than by removing)
///
/// So the floor of this converter is the engine it is trying to replace, and never worse.
/** @param {any[] & {_termLevel?:number}} loop
 * @returns {Array<any[] & {_terminal?:boolean,_termSub?:number,_termSearch?:number}>} */
export function terminalDecompose(loop) {
  // Split every cubic at its inflections and double point first. This is the whole reason the
  // terminal is allowed to be called valid by construction: the decomposition hands each curve
  // to its own chord as a crescent, and a crescent is
  // Loop-Blinn's primitive, which is only correct once the cubic has been cut at its
  // inflections and loop cuts. Attached whole, a cubic that changes curvature sign inside
  // [0,1] has an algebraic branch running back through its own crescent.

  const flat = [];
  for (const seg of loop) {
    if (seg.t !== 'cubic') {
      flat.push(seg);
      continue;
    }
    const ts = cubicInflections(seg.P)
      .concat(cubicLoopCuts(seg.P))
      .filter((t) => t > 1e-4 && t < 1 - 1e-4)
      .sort((a, b) => a - b);
    let pr = 0;
    for (const t of ts)
      if (t - pr > 1e-4) {
        flat.push(segSlice(seg, pr, t));
        pr = t;
      }
    flat.push(pr > 0 ? segSlice(seg, pr, 1) : seg);
  }
  loop = flat;
  const pts = [],
    chordOwner = new Map();
  for (let i = 0; i < loop.length; i++) {
    const a = segStart(loop[i]);
    chordOwner.set(pts.length, i);
    pts.push(a);
  }
  if (pts.length < 3) return null;
  const tris = earClip(pts);
  if (!tris) return null;

  //
  const loopArea = polyArea(pts);
  const bulge = loop.map((seg) => {
    if (seg.t === 'line') return 0;
    const K = 24,
      samp = [];
    for (let i = 0; i <= K; i++) samp.push(segPt(seg, i / K));
    const a = polyArea(samp); // closed by the chord from end back to start
    // An area scales as the square of the coordinates, so its own extent is the scale to judge it
    // by -- an absolute floor calls a small shape's bulge flat and a large shape's rounding a bulge.
    let sx0 = Infinity,
      sy0 = Infinity,
      sx1 = -Infinity,
      sy1 = -Infinity;
    for (const q of samp) {
      if (q[0] < sx0) sx0 = q[0];
      if (q[0] > sx1) sx1 = q[0];
      if (q[1] < sy0) sy0 = q[1];
      if (q[1] > sy1) sy1 = q[1];
    }
    const ex = sx1 - sx0,
      ey = sy1 - sy0;
    if (!(Math.abs(a) > 1e-15 * Math.max(ex * ex, ey * ey, ex * ey))) return 0;
    return a > 0 === loopArea > 0 ? 1 : -1;
  });

  const out = [];
  for (const [i0, i1, i2] of tris) {
    const curves = [];
    const idx = [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ];
    for (const [a, b] of idx) {
      // An edge of the triangulation that IS a chord of a concave curve carries that curve's
      // constraint instead of a plain line, which is how the bite gets taken.
      //
      // Both directions. Ear clipping emits an edge in whichever winding the triangle has, so
      // testing only (a -> a+1) misses every chord that comes back reversed, the constraint is
      // never applied, and the triangle covers the bite the curve was supposed to remove. The
      // patches all stay individually valid — each matches its own contour exactly — while
      // their UNION exceeds the shape, so gridCheck reports 0 while the drawing gains extra ink.
      let owner;
      if (chordOwner.get(a) !== undefined && (a + 1) % pts.length === b) owner = chordOwner.get(a);
      else if (chordOwner.get(b) !== undefined && (b + 1) % pts.length === a)
        owner = chordOwner.get(b);
      // A TRIANGULATION DIAGONAL IS A SEAM, NOT AN OUTLINE.
      //
      // Emitted as a plain line, an interior diagonal -- shared with the triangle on the other
      // side of it -- would be antialiased by both patches. Each reads about half coverage on the
      // pixels the diagonal crosses and OVER composites them to 1-(1-0.5)(1-0.5) = 0.75, which
      // draws a hairline gap along every diagonal: a fan of light spokes across a polygon's
      // interior, wholly-interior pixels at 0.749 instead of 1.000. `cut: true` hands each such
      // pixel to one side.
      //
      // Only an edge that is CONSECUTIVE in the contour is a real piece of the outline, where the
      // ramp is the right answer; every other edge of a triangle is a diagonal the triangulation
      // introduced.
      const onContour = (a + 1) % pts.length === b || (b + 1) % pts.length === a;
      // A CHORD ACROSS A CONVEX BULGE IS A SEAM TOO, and `onContour` cannot see that: `pts` is the
      // DECIMATED polygon, so a consecutive pair in it can span nine edges of the real contour --
      // 39.38em against a contour edge's 4.32em on a 64-gon. The bulge between chord and contour is
      // emitted as its own patch below, carrying this very chord with `cut: true`. Emitting it here
      // as an outline would leave the two sides disagreeing: the bulge hard-steps the seam and
      // rejects the pixel, while this side RAMPS it and reports 0.77, so the pixel would end up
      // under-filled with nothing to make up the difference -- a dashed hairline along the diagonal.
      //
      const src =
        (a + 1) % pts.length === b ? loop[a] : (b + 1) % pts.length === a ? loop[b] : null;
      if (owner !== undefined && bulge[owner] === -1) curves.push(loop[owner]);
      else if (onContour && src && src.cut)
        curves.push({ t: 'line', P: [pts[a], pts[b]], cut: true });
      else if (onContour) curves.push({ t: 'line', P: [pts[a], pts[b]] });
      else curves.push({ t: 'line', P: [pts[a], pts[b]], cut: true });
    }
    out.push(curves);
  }
  for (let i = 0; i < loop.length; i++) {
    if (bulge[i] !== 1) continue;
    const a = segStart(loop[i]),
      b = segEnd(loop[i]);
    out.push([loop[i], { t: 'line', P: [b, a], cut: true }]);
  }
  //
  // The repair is to halve every curve and decompose the finer loop: a crescent's sagitta
  // falls with the square of its chord, so a few halvings put every crescent on its own side
  // of its chord and the chord polygon back to the loop's orientation. Subdivision in service
  // of an exact construction: the pieces are the same curves, and a loop that still does not
  // partition after four rounds is refused rather than emitted wrong.
  const curvedArea = (() => {
    const s = [];
    for (const sg of loop) for (let k = 0; k < 16; k++) s.push(segPt(sg, k / 16));
    return Math.abs(polyArea(s));
  })();
  let sum = 0;
  for (const piece of out) {
    const s = [];
    for (const sg of piece) for (let k = 0; k < 16; k++) s.push(segPt(sg, k / 16));
    sum += Math.abs(polyArea(s));
  }
  const partitions =
    Math.abs(sum - curvedArea) <= 2e-3 * Math.abs(curvedArea) &&
    loopArea > 0 === polyArea(pts.length ? pts : [[0, 0]]) > 0;
  if (!partitions) {
    // Only a SMALL loop is refined: every halving doubles the pieces the caller then validates
    // and repairs, and the narrow feature this is for is a sliver of a few curves. A large loop
    // that does not partition is refused, which the caller turns into a Loop-Blinn fallback
    // for the shape -- correct pixels over a wrong decomposition.
    const level = loop._termLevel | 0;
    if (level >= 3 || loop.length > 24 || !loop.some((s) => s.t !== 'line')) return null;
    /** @type {any[] & {_termLevel?:number}} */
    const finer = [];
    for (const sg of loop) {
      if (sg.t === 'line') {
        finer.push(sg);
        continue;
      }
      const h1 = segSlice(sg, 0, 0.5),
        h2 = segSlice(sg, 0.5, 1);
      if (sg.cut) {
        h1.cut = true;
        h2.cut = true;
      }
      finer.push(h1, h2);
    }
    finer._termLevel = level + 1;
    return terminalDecompose(finer);
  }
  return out;
}

const polyArea = (poly) => {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
};

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-30) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/// Ear clipping on the chord polygon. Orientation-agnostic: the signed area picks the sign so a
/// clockwise contour is not silently treated as having no ears at all.
function earClip(poly) {
  const n = poly.length;
  if (n < 3) return null;
  let area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++)
    area2 += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  const sgn = area2 >= 0 ? 1 : -1;
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const cross = (o, a, b) => sgn * ((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]));
  const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const out = [];
  let guard = 4 * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const A = poly[i0],
        B = poly[i1],
        C = poly[i2];
      if (cross(A, B, C) <= 0) continue; // reflex
      let ok = true;
      for (const m of idx) {
        if (m === i0 || m === i1 || m === i2) continue;
        if (inTri(poly[m], A, B, C)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null; // not a simple polygon
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out.length ? out : null;
}

// ===================================================================================
// STAGE (d): THE PAPER'S EAR CLIP
// ===================================================================================
// Dokter et al. cut a patch down to MaxCurves with an ear clip: mark a run of edges, connect its
// endpoints with a line, and split the run off when that line intersects no edge. The converter
// in this file is validity-driven rather than constructive, but its cutting reuses this stage as
// the paper writes it.

/// Stage (d), verbatim from the paper's pseudocode.
///
///   while Patch has more than MaxCurves curves
///     for N <- MaxCurves-1 to 1
///       for all edges: mark edge and next N-1, connect endpoints with a line,
///                      if the line intersects no edge, split the run off as a new patch
///     if still too long: split the longest edge in the middle and add a node
/// `forced` -- a pick a previous run reported on its result (`pick`: { e, N } for a run cut,
/// { split } for the node split) -- skips the search for a clear run, which is O(n^2) root
/// solves per attempt on a long cycle, and slices the same pieces. A replayed trace uses it.
const _BINOM = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1], [1, 5, 10, 10, 5, 1]];

/// ∮(x dy − y dx) over ONE Bezier segment, exactly and in closed form.
///
/// x is degree n and y' degree n−1, so the integrand is degree 2n−1 and
/// ∫₀¹ Bᵢⁿ Bⱼⁿ⁻¹ dt = C(n,i)·C(n−1,j) / (2n·C(2n−1,i+j)) — the standard Bernstein product identity.
/// At most 12 terms for a cubic, no sampling, and it reduces to the familiar cross product x₀y₁−x₁y₀
/// on a line. A RATIONAL segment's integrand is not polynomial, so the identity does not apply and
/// those fall back to a chord sum — which is an approximation of the area and an exact statement
/// about the sign, which is all the caller wants.
function segSweep(seg) {
  if (isRat(seg)) {
    const K = 16;
    let a = 0,
      p = segPt(seg, 0);
    for (let k = 1; k <= K; k++) {
      const q = segPt(seg, k / K);
      a += p[0] * q[1] - q[0] * p[1];
      p = q;
    }
    return a;
  }
  const P = seg.P,
    n = P.length - 1;
  if (n === 1) return P[0][0] * P[1][1] - P[1][0] * P[0][1];
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const ci = _BINOM[n][i],
      xi = P[i][0],
      yi = P[i][1];
    for (let j = 0; j < n; j++) {
      const dx = P[j + 1][0] - P[j][0],
        dy = P[j + 1][1] - P[j][1];
      s += ((xi * dy - yi * dx) * ci * _BINOM[n - 1][j]) / _BINOM[2 * n - 1][i + j];
    }
  }
  return s / 2;
}

/// Signed area of a closed curve loop. Used for its SIGN only — which is what says whether a loop
/// is wound the same way as the loop it was cut from. Exact for polynomial segments (see segSweep),
/// so the sign is never a question of sampling density; loopHasArea is what rejects slivers.
export function loopSignedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) a += segSweep(loop[i]);
  return a / 2;
}

/// Whether a loop passes through one of its own vertices twice -- a bridge's two ends, where a hole hangs
/// off a bridged loop by a slit of zero width. Such a loop is not simple, and the tests that make a split of
/// a simple loop sound (a chord that crosses nothing, pieces wound like their parent) do not make a split of
/// this one sound: see piecesOverlap. Exact: a bridge reuses its endpoints' coordinates.
function loopPinched(loop) {
  const seen = new Set();
  for (const s of loop) {
    const p = segStart(s),
      k = p[0] + ',' + p[1];
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/// Whether the pieces of a split overlap: a vertex of one strictly inside another (nonzero), other than
/// the vertices they share -- a cut's own ends, and on a bridged loop the bridge's. The pieces of a sound
/// split are disjoint, so this is exactly the failure. It is the one a pinched loop has: a cut through the
/// pinch can close a piece AROUND the hole that hangs there, the hole's own curves going to the other
/// piece, and each piece still comes back wound like its parent overall -- one with a negative lobe where
/// the hole is, the other positive over it. Each then validates against its own curves, and the hole
/// paints solid.
function piecesOverlap(pieces) {
  if (pieces.length < 2) return false;
  const keys = pieces.map((pc) => {
    const k = new Set();
    for (const s of pc) {
      const p = segStart(s);
      k.add(p[0] + ',' + p[1]);
    }
    return k;
  });
  for (let a = 0; a < pieces.length; a++)
    for (let b = 0; b < pieces.length; b++) {
      if (a === b) continue;
      for (const s of pieces[b]) {
        const p = segStart(s);
        if (keys[a].has(p[0] + ',' + p[1])) continue;
        if (inside(pieces[a], p[0], p[1])) return true;
      }
    }
  return false;
}

/** @returns {Array<any[] & {_fromEar?:boolean}> & {pick?:{e?:number,N?:number,split?:number}}} */
export function earCut(loop, maxCurves, forced) {
  const n = loop.length;
  if (n <= maxCurves) return null;
  const at = (k) => loop[((k % n) + n) % n];
  if (forced && forced.e !== undefined) {
    const e = forced.e,
      N = forced.N;
    const a = segStart(at(e)),
      b = segEnd(at(e + N - 1));
    const piece = [],
      rest = [];
    for (let k = 0; k < N; k++) piece.push(at(e + k));
    piece.push({ t: 'line', P: [b, a], cut: true });
    for (let k = N; k < n; k++) rest.push(at(e + k));
    rest.push({ t: 'line', P: [a, b], cut: true });
    const out = /** @type {any[][] & {pick?:{e?:number,N?:number}}} */ ([piece, rest]);
    out.pick = { e, N };
    return out;
  }
  if (forced && forced.split !== undefined) {
    const li = forced.split;
    const out = loop.slice();
    out.splice(li, 1, segSlice(loop[li], 0, 0.5), segSlice(loop[li], 0.5, 1));
    out._nodeSplits = (loop._nodeSplits | 0) + 1;
    const r = /** @type {any[][] & {pick?:{split?:number}}} */ ([out]);
    r.pick = { split: li };
    return r;
  }
  const chordMin = 1e-9 * loopExtent(loop); // hoisted: `clear` runs per candidate chord per level
  const clear = (a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      L = Math.hypot(dx, dy);
    // A chord shorter than this share of the loop has a normal made of rounding, and an ear built
    // on it is the collinear-chord defect. In world units 1e-9 is a real length for a glyph laid
    // out in em units and nothing at all for a map in projected meters.
    if (!(L >= chordMin)) return false;
    const h = [-dy / L, dx / L, -((-dy / L) * a[0] + (dx / L) * a[1])];
    const ux = dx / L,
      uy = dy / L;

    const pad9 =
      1e-12 * (Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])) + L);
    const cx0 = Math.min(a[0], b[0]) - pad9,
      cx1 = Math.max(a[0], b[0]) + pad9;
    const cy0 = Math.min(a[1], b[1]) - pad9,
      cy1 = Math.max(a[1], b[1]) + pad9;
    for (let k = 0; k < n; k++) {
      const sb = segTightBBox(at(k));
      if (sb[2] < cx0 || sb[0] > cx1 || sb[3] < cy0 || sb[1] > cy1) continue;

      let onLine = true;
      for (const q of at(k).P) {
        if (Math.abs(h[0] * q[0] + h[1] * q[1] + h[2]) > 1e-9 * L) {
          onLine = false;
          break;
        }
      }
      if (onLine) {
        const Pk = at(k).P,
          e0 = Pk[0],
          e1 = Pk[Pk.length - 1];
        const ua = ((e0[0] - a[0]) * ux + (e0[1] - a[1]) * uy) / L;
        const ub = ((e1[0] - a[0]) * ux + (e1[1] - a[1]) * uy) / L;
        if (Math.min(ua, ub) < 1 - 1e-6 && Math.max(ua, ub) > 1e-6) return false; // it overlaps
      }
      for (const t of affRootsOnSeg(h, at(k))) {
        const q = segPt(at(k), t);
        const u = ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / L;
        if (u <= 1e-6 || u >= 1 - 1e-6) continue;

        if (Math.hypot(q[0] - a[0], q[1] - a[1]) < 1e-9 * L) continue;
        if (Math.hypot(q[0] - b[0], q[1] - b[1]) < 1e-9 * L) continue;
        return false;
      }
    }
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return inside(loop, m[0], m[1]);
  };

  let parentArea = null;
  for (let N = maxCurves - 1; N >= 2; N--) {
    if (N > n - 2) continue;
    for (let e = 0; e < n; e++) {
      const a = segStart(at(e)),
        b = segEnd(at(e + N - 1));
      if (!clear(a, b)) continue;
      const piece = [],
        rest = [];
      for (let k = 0; k < N; k++) piece.push(at(e + k));
      piece.push({ t: 'line', P: [b, a], cut: true });
      for (let k = N; k < n; k++) rest.push(at(e + k));
      rest.push({ t: 'line', P: [a, b], cut: true });
      if (piece.length < 2 || rest.length < 2) continue;
      // An interior chord does not say which side the ear is on.
      //
      // `clear` proves the chord crosses nothing and that its MIDPOINT is inside the loop, and that
      // is genuinely all it can prove: the midpoint lies ON the ear's own boundary, so it is inside
      // the loop whichever side the ear falls on. Where the loop is simple and convex-ish the run
      // between two vertices is the inside one and the question never arises. On a loop with a
      // NOTCH it does, and the notch is not exotic -- resolveNesting hands the converter rings it
      // has split or bridged, so every shape with a hole arrives as a loop whose boundary doubles
      // back around that hole. A run of consecutive segments can then be the notch's own boundary,
      // and the ear it closes off IS the hole.
      //
      // Since the chord crosses nothing, the ear is a simple closed curve and its interior is
      // wholly inside the loop or wholly outside -- it cannot straddle, because straddling means
      // crossing the boundary. So one bit decides it, and ORIENTATION is that bit, exactly: a piece
      // wound against its parent encloses what the parent excludes. No epsilon, no sample point
      // nudged off a boundary, and it rejects a figure-eight (zero signed area) with the same test.

      if (parentArea === null) parentArea = loopSignedArea(loop);
      if (
        parentArea !== 0 &&
        (loopSignedArea(piece) * parentArea <= 0 || loopSignedArea(rest) * parentArea <= 0)
      )
        continue;
      // ...AND THE ORIENTATION IS ONE BIT only WHILE THE LOOP IS SIMPLE, and a bridged loop is not (see
      // piecesOverlap): a chord from its pinch crosses nothing and can still close an ear around a hole.
      if (loopPinched(loop) && piecesOverlap([piece, rest])) continue;
      const out = /** @type {any[][] & {pick?:{e?:number,N?:number}}} */ ([piece, rest]);
      out.pick = { e, N };
      if (globalThis.__CP_EAR_DUMP)
        globalThis.__CP_EAR_DUMP.push({ e, N, a, b, loop, piece, rest });
      return out;
    }
  }
  // "split longest edge in the middle and add new node"
  let li = -1,
    lb = 0;
  for (let k = 0; k < n; k++) {
    const A = segStart(loop[k]),
      B = segEnd(loop[k]);
    const d = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (d > lb && loop[k].t !== 'line') {
      lb = d;
      li = k;
    }
  }
  if (li < 0) return null;
  //
  // Bounded here, so a loop that cannot be eared falls through to the caller's own fallback
  // instead of growing without end.
  if ((loop._nodeSplits | 0) >= NODE_SPLIT_CAP) return null;
  const out = loop.slice();
  out.splice(li, 1, segSlice(loop[li], 0, 0.5), segSlice(loop[li], 0.5, 1));
  out._nodeSplits = (loop._nodeSplits | 0) + 1;
  const r = /** @type {any[][] & {pick?:{split?:number}}} */ ([out]);
  r.pick = { split: li };
  return r;
}

/// THE VALIDITY TOLERANCE IN UNITS OF THE ARTWORK, not in absolute em.

/// The reference is the scale the epsilons in this file are tuned at, the octave every contour is
/// converted in (contourFrame), so a contour arriving at that size gets the unscaled tolerance.
const TOL_REF_EXT = 256;
/// THE ACCEPTED DEFECT SIZE, and it is a POLICY rather than an epsilon: how far inside a shape a
/// patch may fall short and still be called valid. Anything above zero is a hole BY DESIGN --
/// invisible at the scale artwork is normally drawn, and visible the moment it is zoomed, which is
/// what makes it worth buying down rather than tuning.

/// A flat bar in ARTWORK UNITS is already scale-invariant in the sense that matters -- scale the
/// drawing and scale the bar with it, which is what every caller doing that test does -- and it
/// holds every patch of a shape to the same RENDERED bar, which is the thing being bought.
///
/// The default; `__CP_TOL_ABS` overrides it, read at call time (tolAbs) so it reaches workers.
export const CP_TOL_DEFAULT = 0.02;
const tolAbs = () => mantleDebugHook('__CP_TOL_ABS') || CP_TOL_DEFAULT;
/// The ROW GATE's probe step, as a fraction of the PATCH's extent -- the `nudgePx` patchLeaksInBox
/// hands leakOfInner in place of the caller's bar, which is what makes the gate monotone and
/// scale-free. The fraction is the one the search's bar already is of the contour it converts
/// (CP_TOL_DEFAULT / TOL_REF_EXT), so a patch that IS its whole contour is probed with exactly the
/// number the search would have used, and a smaller patch is probed proportionally finer.
const leakRel = () => mantleDebugHook('__CP_LEAK_REL') || tolAbs() / TOL_REF_EXT;
/// leakOfInner's default ask is the SEARCH's. Frozen and shared, so the default costs no object.
const EMPTY_ASK = Object.freeze({});
/// ...and the ROW GATE's, which takes a probe step the bar cannot move, places its probes on the
/// feasible set rather than on a clipped one, and declines the emptiness escape. See leakOfInner.
const GATE_ASK = (nudgePx) => ({ nudgePx, monotone: true, anyStretch: true, box: true });
/// How many points of a leak stretch the emptiness test asks at: both ends, then that many
/// interior ones. See `emptyAt` in leakOfInner.
const leakProbes = (w0, w1) => {
  const n =
    mantleDebugHook('__CP_LEAK_PROBE_N') != null
      ? Math.max(3, mantleDebugHook('__CP_LEAK_PROBE_N') | 0)
      : 3;
  const out = [w0, w1],
    m = n - 2;
  for (let k = 1; k <= m; k++) out.push(w0 + ((w1 - w0) * k) / (m + 1));
  return out;
};
function defaultTolPx(curves, opts) {
  if (opts && opts.tolPx != null) return opts.tolPx;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  if (curves)
    for (const c of curves)
      for (const p of c.P) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
  const ext = Math.max(x1 - x0, y1 - y0);
  return ext > 0 && Number.isFinite(ext) ? tolAbs() * (ext / TOL_REF_EXT) : tolAbs();
}

/// THE same BAR FOR A MORPH, WHICH IS A PAIR AND NOT A POSE.

/// ONE BAR FOR THE PAIR, from the extent of both poses together. Not per pose: a pose's extent moves
/// continuously through the morph, so a per-pose bar would make the accepted defect size jump at
/// every plan-segment boundary and would hold the same patch to two different standards at its two
/// ends. Both poses' control points are in the same drawing at the same viewport scale, so their
/// union is the thing that scales when the artwork does -- and it is symmetric in A and B, which
/// matters because nothing else about a plan distinguishes them.
export function morphTolPx(...curveLists) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const cs of curveLists)
    if (cs)
      for (const c of cs)
        for (const p of c.P) {
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
  const ext = Math.max(x1 - x0, y1 - y0);
  return ext > 0 && Number.isFinite(ext) ? tolAbs() * (ext / TOL_REF_EXT) : tolAbs();
}

/// STAGE (e)'s SPECIAL CASE: "Curves that have loops need special treatment, if a complete loop
/// is formed by the extension. In this case, an additional patch only consisting of the loop
/// might be needed." — Dokter et al., §Self-intersection cutting.
///
/// A cubic of loop type has a double point, and the front end already splits curves at theirs,
/// so no curve ARRIVES with one inside [0,1]. The extension is a different matter: carried past
/// its ends, the same cubic closes a loop, and the implicit's sign inverts inside it. Where that
/// loop falls inside the shape, the conjunction excludes its interior and the region renders
/// EMPTY — a hole the boundary tests cannot see, because validatePatch's clip direction only
/// ever samples along the other curves and this defect is strictly interior.

/// The repair is the paper's: hand back the loop as its own patch. It is bounded by curve i on
/// both halves, so it is valid by construction.
function extensionLoopPatch(seg, bb) {
  if (seg.t !== 'cubic') return null; // only a cubic has a double point
  const T = extensionSpan(seg, bb);
  if (!T) return null;
  const E = segSlice(seg, -T, 1 + T);
  const lc = cubicLoopCuts(E.P)
    .filter((t) => t > 1e-6 && t < 1 - 1e-6)
    .sort((a, b) => a - b);
  if (lc.length < 2) return null;
  const L = segSlice(E, lc[0], lc[1]);
  const a = segStart(L),
    b = segEnd(L);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6 * segExtent(L)) return null;
  // The converter's work loop rejects a loop of fewer than two curves, so halve it. Both halves
  // lie on the same algebraic curve, which is what makes the pair a patch at all.
  return [segSlice(L, 0, 0.5), segSlice(L, 0.5, 1)];
}

/// Centroid of a closed arc, as a stand-in for a point inside it.
function loopCentroid(halves) {
  let cx = 0,
    cy = 0,
    n = 0;
  for (const h of halves)
    for (let k = 0; k < 8; k++) {
      const q = segPt(h, k / 8);
      cx += q[0];
      cy += q[1];
      n++;
    }
  return n ? [cx / n, cy / n] : null;
}

/// Emit a patch for every extension loop that leaves a hole in the finished set.
///
function addLoopPatches(patches, stats, opts) {
  const extra = [],
    seen = [];
  for (const p of patches) {
    for (let i = 0; i < p.curves.length; i++) {
      const halves = extensionLoopPatch(p.curves[i], p.bbox);
      if (!halves) continue;
      if (belowFloat32(halves)) continue; // a loop no float32 fragment can tell from its edge
      const c = loopCentroid(halves);
      if (!c) continue;
      if (!inside(p.curves, c[0], c[1])) continue; // the loop is not in this patch's region
      if (inPatch(p, c[0], c[1])) continue; // the conjunction already covers it
      // The same loop is reachable from more than one patch sharing that curve.
      if (seen.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 1e-6 * loopExtent(p.curves)))
        continue;
      // The trace must say what happened to this loop, since the replay cannot tell a refused
      // sub-conversion from one that ran: the nested records are unwound and one 'skip' stands in.
      const mark = opts.trace ? opts.trace.length : 0;
      const sub = convertContour(halves, { ...opts, record: null, follow: null, _loopPatch: true });
      if (!sub || !sub.patches.length) {
        if (opts.trace) {
          opts.trace.length = mark;
          opts.trace.push({ op: 'skip' });
        }
        continue;
      }
      seen.push(c);
      for (const f of sub.patches) extra.push(f);
    }
  }
  if (extra.length) stats.loopPatches = extra.length;
  for (const f of extra) patches.push(f);
}

///
/// Cheap to remove and always right: dropping both halves leaves the loop closed, because the
/// pair starts and ends at the same point by definition.
export function stripSpurs(loop) {
  if (!loop || loop.length < 3) return loop;
  let l = loop;
  for (let guard = 0; guard < l.length && l.length > 2; guard++) {
    let cut = -1;
    for (let i = 0; i < l.length; i++) {
      const a = l[i],
        b = l[(i + 1) % l.length];
      const A = segStart(a),
        B = segEnd(b);

      const sc = Math.max(Math.abs(A[0]) + Math.abs(A[1]), ctlExtent(a.P) + ctlExtent(b.P));
      if (Math.hypot(A[0] - B[0], A[1] - B[1]) > 1e-7 * sc) continue;
      const ma = segPt(a, 0.5),
        mb = segPt(b, 0.5);
      if (Math.hypot(ma[0] - mb[0], ma[1] - mb[1]) > 1e-7 * sc) continue;
      cut = i;
      break;
    }
    if (cut < 0) break;
    const j = (cut + 1) % l.length;
    l = l.filter((_, k) => k !== cut && k !== j);
  }
  return l;
}

function resolveLoop(loop) {
  try {
    const cyc = pathToCycles([loop], false);
    if (!cyc || !cyc.length) return null;
    if (cyc.length === 1 && cyc[0].length === loop.length) return null;
    let mag = 0,
      x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of loop)
      for (const q of c.P) {
        if (Math.abs(q[0]) > mag) mag = Math.abs(q[0]);
        if (Math.abs(q[1]) > mag) mag = Math.abs(q[1]);
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    const tol = Math.max(1e-6 * Math.max(x1 - x0, y1 - y0), 4e-15 * mag);
    for (const c of cyc) {
      const a = segStart(c[0]),
        b = segEnd(c[c.length - 1]);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > tol) return null;
    }
    return cyc;
  } catch {
    return null;
  }
}

/// TWICE THE SIGNED AREA A LOOP BOUNDS, by Green's theorem on its pieces: a quadratic form in the
/// control points for lines, quadratics and cubics, and for a conic its chord plus the segment
/// between chord and arc, the control triangle times a closed form in the weight. Joints are
/// closed with their chords, so a loop left open by a hair does not read its origin as area.
const _cr2 = (a, b) => a[0] * b[1] - a[1] * b[0];
function conicSegmentRatio(w) {
  const d = w - 1;
  if (Math.abs(d) < 1e-4) return 2 / 3 + (4 / 15) * d; // the closed forms cancel here
  if (w < 1) {
    const q = Math.sqrt(1 - w * w);
    return (w / (q * q)) * (Math.acos(w) / q - w);
  }
  const q = Math.sqrt(w * w - 1);
  return (w / (q * q)) * (w - Math.acosh(w) / q);
}
function loopArea2(l) {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const g = l[i],
      P = g.P,
      Q = l[(i + 1) % l.length].P;
    a += _cr2(P[P.length - 1], Q[0]);
    if (g.t === 'line') a += _cr2(P[0], P[P.length - 1]);
    else if (g.t === 'rquad')
      a +=
        _cr2(P[0], P[2]) +
        conicSegmentRatio(g.w == null ? 1 : g.w) *
          _cr2([P[1][0] - P[0][0], P[1][1] - P[0][1]], [P[2][0] - P[0][0], P[2][1] - P[0][1]]);
    else if (P.length === 3)
      a += (2 * (_cr2(P[0], P[1]) + _cr2(P[1], P[2])) + _cr2(P[0], P[2])) / 3;
    else
      a +=
        (6 * _cr2(P[0], P[1]) +
          3 * _cr2(P[0], P[2]) +
          _cr2(P[0], P[3]) +
          3 * _cr2(P[1], P[2]) +
          3 * _cr2(P[1], P[3]) +
          6 * _cr2(P[2], P[3])) /
        10;
  }
  return a;
}

function belowFloat32(l) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of l)
    for (const p of c.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const ext = Math.max(x1 - x0, y1 - y0),
    mag = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1), ext);
  return Math.abs(loopArea2(l)) * 0.5 <= 5.960464477539063e-8 * mag * ext;
}

const _exactReverse = (a, b) => {
  if (
    a.t !== b.t ||
    a.P.length !== b.P.length ||
    (a.w == null ? 1 : a.w) !== (b.w == null ? 1 : b.w)
  )
    return false;
  for (let k = 0, n = a.P.length - 1; k <= n; k++)
    if (a.P[k][0] !== b.P[n - k][0] || a.P[k][1] !== b.P[n - k][1]) return false;
  return true;
};
function selfOpposed(l) {
  for (let i = 0; i < l.length; i++) {
    if (l[i].t !== 'line')
      for (let j = i + 1; j < l.length; j++) if (_exactReverse(l[i], l[j])) return true;
    const p = l[i]._src;
    if (!p || l[i].t === 'line') continue;
    const pd = p.b - p.a;
    for (let j = i + 1; j < l.length; j++) {
      const q = l[j]._src;
      if (!q || q.k !== p.k || l[j].t === 'line') continue;
      const qd = q.b - q.a;
      if (!(pd * qd < 0)) continue; // one forward, one back
      const lo = Math.max(Math.min(p.a, p.b), Math.min(q.a, q.b)),
        hi = Math.min(Math.max(p.a, p.b), Math.max(q.a, q.b));
      if (hi - lo >= 0.5 * Math.min(Math.abs(pd), Math.abs(qd))) return true;
    }
  }
  return false;
}

export function loopHasArea(l) {
  if (l.length < 2) return false;
  // A lens bounds nothing either (selfOpposed), though the band test below would pass it: the band
  // is taken across chords, and a curve run out and back is as wide as its own sagitta.
  if (selfOpposed(l)) return false;
  if (l.length < 3 && !l.some((s) => s.t !== 'line')) return false;
  const pts = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let k = 0; k < l.length; k++) {
    const sg = l[k];
    for (let q = 0; q < 4; q++) {
      const p = segPt(sg, q / 4);
      pts.push(p);
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  }
  const ext = Math.max(x1 - x0, y1 - y0);
  if (!(ext > 0)) return false;
  // A loop lying in a band of width w has |signed area| at most w times the band's length, and
  // the length is at most the diagonal of its box -- so a signed area above that bound PROVES the
  // loop is no sliver, in one pass, and only the rare thin loop pays the band scan below. The
  // cancellation that made signed area unsafe as a sliver TEST runs the other way: lobes can
  // only shrink it, never inflate it past the bound.
  let s2 = 0;
  for (let q = 0, m = pts.length; q < m; q++) {
    const a = pts[q],
      b = pts[(q + 1) % m];
    s2 += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(s2) * 0.5 > 1e-5 * ext * ext * Math.SQRT2) return true;
  let width = Infinity;
  for (let k = 0; k < l.length && width > 1e-5 * ext; k++) {
    const A = segStart(l[k]),
      B = segEnd(l[k]);
    const dx = B[0] - A[0],
      dy = B[1] - A[1],
      L = Math.hypot(dx, dy);
    if (!(L > 1e-12 * ext)) continue;
    const nx = -dy / L,
      ny = dx / L;
    let lo = Infinity,
      hi = -Infinity;
    for (let q = 0; q < pts.length; q++) {
      const v = nx * pts[q][0] + ny * pts[q][1];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < width) width = hi - lo;
  }
  return width > 1e-5 * ext;
}

function rootCurves(curves, forceBezout) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of curves)
    for (const p of c.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const eps = 1e-7 * Math.max(x1 - x0, y1 - y0);
  const out = [];
  for (let k = 0; k < curves.length; k++) {
    const c = curves[k],
      P = c.P;
    let ex = 0;
    for (let a = 0; a < P.length; a++)
      for (let b = a + 1; b < P.length; b++) {
        const dx = Math.abs(P[a][0] - P[b][0]),
          dy = Math.abs(P[a][1] - P[b][1]);
        if (dx > ex) ex = dx;
        if (dy > ex) ex = dy;
      }
    if (!(ex > eps)) continue;
    const tagged = c._src ? { ...c } : { ...c, _src: { k, a: 0, b: 1 } };
    if (forceBezout && c.t === 'cubic') tagged._bez = true;
    out.push(tagged);
  }
  return out;
}

/// The loop without its point-like segments (extent under a hair of the loop's own), which have
/// no implicit; null when nothing is point-like. Their ends coincide, so the loop stays closed.
function slimLoop(loop) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of loop)
    for (const p of c.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const eps = 1e-9 * Math.max(x1 - x0, y1 - y0);
  const out = [];
  for (const c of loop) {
    const P = c.P;
    let ex = 0;
    for (let a = 0; a < P.length; a++)
      for (let b = a + 1; b < P.length; b++) {
        const dx = Math.abs(P[a][0] - P[b][0]),
          dy = Math.abs(P[a][1] - P[b][1]);
        if (dx > ex) ex = dx;
        if (dy > ex) ex = dy;
      }
    if (ex > eps) out.push(c);
  }
  return out.length < loop.length ? out : null;
}

/// The count-first pieces of a contour: the ear cuts convertContour would make at its root, with
/// the same tagging, stripping and root-only rule. Null when the contour needs no cutting (or has
/// no area); the pieces carry `_src` provenance into the converter like any tagged input. It is
/// the split contourSplit below takes. Converting the pieces SEPARATELY is not the same
/// decomposition as converting the contour whole -- each piece is searched alone, with its own
/// leak state -- which is why the split has to be taken on every route or on none.
export function countFirstPieces(curves, maxCurves = 8) {
  const rooted = stripSpurs(rootCurves(curves, false));
  if (rooted.length <= maxCurves || !loopHasArea(rooted)) return null;

  const work = [rooted],
    pieces = [];
  let guard = 4096;
  while (work.length && guard-- > 0) {
    const l = work.pop();
    if (l.length <= maxCurves) {
      pieces.push(l);
      continue;
    }
    const ec = earCut(l, maxCurves);
    if (!ec) {
      pieces.push(l);
      continue;
    }
    for (const p0 of ec) {
      const p = stripSpurs(p0);
      if (p.length >= 2 && loopHasArea(p)) work.push(p);
    }
  }
  return pieces.length > 1 ? pieces : null;
}

/// A LARGE CONTOUR IS CONVERTED AS ITS COUNT-FIRST PIECES, ON every ROUTE.

/// Only the static search splits. A morph tape (`record`/`follow`) and a morph layout (a non-zero
/// `leakMargin`) replay or certify ONE search over the whole contour, and `countFirst` off asks for
/// the plain search.

// Split static contours with more curves than this.
export const CP_SPLIT_ABOVE = 48;
export function contourSplit(curves, opts0 = {}) {
  const _ov = mantleDebugHook('__CP_OPTS');
  const opts = _ov ? { ..._ov, ...opts0 } : opts0;
  if (!curves || !(curves.length > CP_SPLIT_ABOVE)) return null;
  if (
    opts.record ||
    opts.follow ||
    (opts.leakMargin || 0) > 0 ||
    opts.countFirst === 0 ||
    opts.countFirst === false
  )
    return null;
  const n = opts.maxCurves || 8;
  let pieces = null;
  try {
    pieces = framedPieces(curves, n);
  } catch {
    pieces = null;
  }
  return pieces ? { pieces, n, tolPx: defaultTolPx(curves, opts) } : null;
}
/// countFirstPieces taken in the contour's frame and handed back in the caller's coordinates, so the
/// split is as free of where the contour sits as its conversion. Each piece is then
/// converted in its own frame.
function framedPieces(curves, n) {
  const F = contourFrame(curves);
  if (!F) return countFirstPieces(curves, n);
  const pieces = countFirstPieces(_toFrame(curves, F), n);
  return pieces ? pieces.map((l) => _fromFrame(l, F)) : null;
}
/// The pieces' conversions as one: patches in piece order, numeric stats summed, flags kept.
export function mergeSplit(parts) {
  const patches = [],
    stats = { parts: parts.length };
  for (const r of parts) {
    for (const p of r.patches) patches.push(p);
    const st = r.stats || {};
    for (const k of Object.keys(st)) {
      const v = st[k];
      if (typeof v === 'number') stats[k] = (stats[k] || 0) + v;
      else if (v === true) stats[k] = true;
    }
  }
  return { patches, stats };
}
/// convertContour, split where contourSplit says. A trace (for a bake) opens with one `split`
/// record -- the ear bound and the piece count, from which replayContour re-derives the pieces --
/// and carries each piece's records in order. If any piece refuses, the contour converts whole,
/// with the trace rewound: the pool falls back the same way, so a refusal is decided identically.
export function convertContourSplit(curves, opts = {}) {
  const sp = contourSplit(curves, opts);
  if (sp) {
    const trace = opts.trace || null,
      mark = trace ? trace.length : 0;
    if (trace) trace.push({ op: 'split', n: sp.n, parts: sp.pieces.length });
    const parts = [];
    for (const piece of sp.pieces) {
      let r = null;
      try {
        r = convertContour(piece, { ...opts, tolPx: sp.tolPx });
      } catch {
        r = null;
      }
      if (!r || !r.patches) break;
      parts.push(r);
    }
    if (parts.length === sp.pieces.length) return mergeSplit(parts);
    if (trace) trace.length = mark;
  }
  return convertContour(curves, opts);
}

/// Convert one simple closed contour into valid CPatches.

const SEARCH_FAST = { candOrder: 'wins', lineTop: 3, leakScore: 'leaky' };

// Normalize into a translated, power-of-two-scaled contour frame. Exact
// translations and power-of-two rescaling then supply identical search
// inputs; rounded changes to the source can still change tie decisions.
// Tolerances, leak margins and holes travel with the geometry. Returned
// constraints use the inverse frame. Replay derives the frame from the
// exact source bits rather than storing another numeric transform.
const _nrmSeg = (c, k, ox, oy) => {
  const P = c.P.map((p) => [(p[0] - ox) * k, (p[1] - oy) * k]);

  const out = { t: c.t, P };
  if (c.cut) out.cut = true;
  if (c.w !== undefined) out.w = c.w;
  if (c._convexEnd) out._convexEnd = c._convexEnd;
  if (c._bez) out._bez = true; // a flag, not geometry: it forces the Bezout form
  if (c._src) out._src = c._src;
  if (c._srcP) out._srcP = c._srcP.map((p) => [(p[0] - ox) * k, (p[1] - oy) * k]);
  return out;
};
/// The frame: { k, ox, oy }, with frame coordinates (p - (ox, oy)) * k; null for a contour with no
/// finite extent, which converts where it is.
const _fxF = new Float64Array(1),
  _fxU = new Uint32Array(_fxF.buffer);
function contourFrame(curves) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of curves)
    for (const p of c.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const ext = Math.max(x1 - x0, y1 - y0);
  if (!(ext > 0) || !Number.isFinite(ext) || !Number.isFinite(x0) || !Number.isFinite(y0))
    return null;
  // ext = m * 2^E with m in [1, 2), READ OFF THE BITS: a power-of-two scale moves E and leaves m, so
  // the frame's scale moves by exactly that power. log2 is not guaranteed to.
  _fxF[0] = ext;
  const be = (_fxU[1] >>> 20) & 2047;
  if (be === 0) return null; // subnormal: nothing to scale to
  _fxU[1] = (_fxU[1] & 0x800fffff) | (1023 << 20);
  const k = Math.pow(2, (_fxF[0] <= Math.SQRT2 ? 8 : 7) - (be - 1023));
  if (!(k > 0) || !Number.isFinite(k)) return null;
  return { k, ox: x0, oy: y0 };
}
const _toFrame = (cs, F) => cs.map((c) => _nrmSeg(c, F.k, F.ox, F.oy));
const _fromFrame = (cs, F) => cs.map((c) => _nrmSeg(c, 1 / F.k, -F.ox * F.k, -F.oy * F.k));

const _mapAff = (f, F) => [f[0] * F.k, f[1] * F.k, f[2] - f[0] * F.k * F.ox - f[1] * F.k * F.oy];
function unframePatches(patches, F) {
  const back = [];
  for (const p of patches) {
    const cs = _fromFrame(p.curves, F);
    for (let i = 0; i < cs.length; i++) {
      const im = p.impls[i];
      cs[i][K_IMPL] = im.impl
        ? {
            ...im.impl,
            terms: im.impl.terms.map((t) => ({ c: t.c, fs: t.fs.map((a) => _mapAff(a, F)) })),
          }
        : null;
      const pk = im.packed;
      cs[i][K_PK] = pk ? { ...pk, a: pk.a.map((a) => _mapAff(a, F)), c: pk.c.slice() } : null;
    }
    const fr = framePatch(cs, [p.inside[0] / F.k + F.ox, p.inside[1] / F.k + F.oy]);
    if (!fr) return null;
    for (let i = 0; i < fr.impls.length; i++) fr.impls[i].s = p.impls[i].s;
    if (p._terminal) fr._terminal = true;
    back.push(fr);
  }
  return back;
}
/// Patches translated by -O, CONSTRAINTS AND ALL: the packer's contour frame for the kernel.
/// The same mapping unframePatches takes from a conversion frame back to the caller's, with
/// k = 1 and the offset negated.
export const translatePatches = (patches, O) =>
  unframePatches(patches, { k: 1, ox: -O[0], oy: -O[1] });
/// convertContour in the contour's frame (see above): map in, convert, map back.
function convertFramed(curves, opts) {
  const F = contourFrame(curves);
  const inner = { ...opts, _framed: true };
  if (!F) return convertContour(curves, inner);
  inner.tolPx = (opts.tolPx != null ? opts.tolPx : defaultTolPx(curves, opts)) * F.k;
  if (opts.leakMargin) inner.leakMargin = opts.leakMargin * F.k;
  if (opts.holes) inner.holes = opts.holes.map((h) => _toFrame(h, F));
  inner._frame = F;

  const mark = opts.trace ? opts.trace.length : -1;
  const r = convertContour(_toFrame(curves, F), inner);
  if (!r || !r.patches) return r;
  const back = unframePatches(r.patches, F);
  if (!back) {
    if (mark >= 0) opts.trace.length = mark;
    return null;
  }
  if (mark >= 0) opts.trace.splice(mark, 0, { op: 'frame' });
  return { patches: back, stats: r.stats };
}

export function convertContour(curves, opts0 = {}) {
  const _ov = mantleDebugHook('__CP_OPTS');
  const opts1 = _ov ? { ..._ov, ...opts0 } : opts0;
  const opts = opts1.search === 'fast' && !opts1._plainRetry ? { ...SEARCH_FAST, ...opts1 } : opts1;
  if (!opts._framed) return convertFramed(curves, opts); // see convertFramed
  const record = opts.record || null;
  const follow = opts.follow || null;
  let tapeAt = 0;
  let tapeBroke = false;

  const maxCurves = opts.maxCurves || 8;
  const tolPx = defaultTolPx(curves, opts);
  const maxDepth = opts.maxDepth || 24;
  // Grid resolution for the interior check; 0 disables it.
  const interiorN = opts.interiorN != null ? opts.interiorN : 8;

  const firstFit = opts.firstFit === true;

  const directed = opts.directed === true;
  // HOLES. A shape's filled region is its outer contour MINUS these, and an
  // intersection of half-spaces cannot express a subtraction — so a patch that
  // overlaps a hole is invalid and the existing cut search resolves it, while a
  // patch wholly inside one is dropped.
  const holes = opts.holes || [];
  // Flattened once per conversion for the containment test (see below), not per patch.
  const holePolys = holes.map((h) => {
    const poly = [];
    for (const sg of h) for (let k = 0; k < 24; k++) poly.push(segPt(sg, k / 24));
    return poly;
  });
  const inAnyHole = (pt) => {
    for (const poly of holePolys) {
      let inside = false;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const xi = poly[a][0],
          yi = poly[a][1],
          xj = poly[b][0],
          yj = poly[b][1];
        if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
  // Robustness slack for the leak test. Zero on the default path -- a static shape wants the
  // tightest patch that is correct -- and non-zero when a decomposition has to survive being
  // applied to a NEARBY pose, which is what a morph layout is.
  const leakMargin = opts.leakMargin || 0;

  _fullRows = leakMargin > 0;
  // Count-first ear clipping is ON BY DEFAULT at maxCurves (see the work loop); opts.countFirst
  // = 0 or false turns it off. A contour the count-first pass refuses is converted again without
  // it (below), so the default cannot refuse anything the plain search converts.
  // Not under a morph tape: `record`/`follow` replay the search's decisions on another pose by
  // tape entry, and an ear cut is not one -- with it on, the follow pose desynced (morph plan
  // smoke: a pose invalid, 1.13% over-fill). Morphs keep the plain search.
  // ...nor for a MORPH LAYOUT, which is what a non-zero leakMargin means (a decomposition that
  // has to survive a nearby pose): a layout of ear-clipped chords transfers worse across poses,
  // and the planner's own converter wrapper may not forward an explicit countFirst.
  const countFirst =
    record || follow || leakMargin > 0
      ? 0
      : opts.countFirst === undefined
        ? maxCurves
        : opts.countFirst | 0;
  // opts.clipTests = false runs the extension test alone (see CLIP_TESTS); a nested conversion
  // (addLoopPatches) re-enters here with the same opts, and the flag is restored on the way out.
  const clipTestsBefore = CLIP_TESTS;
  CLIP_TESTS = opts.clipTests !== false;

  // Each rung starts from the ORIGINAL options and rewinds the trace, so a bake carries only
  // the attempt that succeeded. Nothing here runs unless a conversion has already failed.
  const traceMark0 = opts.trace ? opts.trace.length : 0;
  const rewind = () => {
    if (opts.trace) opts.trace.length = traceMark0;
  };
  const o = {
    maxCurves,
    tolPx,
    maxDepth,
    interiorN,
    firstFit,
    directed,
    holes,
    holePolys,
    inAnyHole,
    leakMargin,
    countFirst,
    record,
    follow,
    frame: opts._frame || null,
  };
  try {
    const first = convertContourInner(curves, opts, o);
    if (first || opts._plainRetry || record || follow) return first;
    const fast =
      countFirst ||
      firstFit ||
      opts.lineTop | 0 ||
      (opts.candOrder || 'wins') !== 'index' ||
      (opts.leakScore || 'leaky') !== 'full';
    if (fast) {
      rewind();
      const plain = convertContour(curves, {
        ...opts,
        countFirst: 0,
        firstFit: false,
        lineTop: 0,
        candOrder: 'index',
        leakScore: 'full',
        fitBar: undefined,
        _plainRetry: true,
      });
      if (plain && plain.patches) {
        if (plain.stats) plain.stats.retriedFull = true;
        return plain;
      }
    }
    // Rung two: A FINER TOLERANCE. tolPx says how large a defect a decomposition may keep, and
    // a contour whose features are small relative to it can have no valid decomposition at that
    // setting at all -- the search reports one invalid patch and refuses the whole contour.
    // Asking for a tighter answer is always available: it costs patches (two patches, one of
    // them invalid, can become three that are clean) and it cannot give a
    // worse one, since every patch is then validated against a STRICTER bound than the caller
    // asked for. The node budget still bounds the search, so this cannot run away.
    if (!opts._fineRetry) {
      const fine = (opts.tolPx != null ? opts.tolPx : defaultTolPx(curves, opts)) * 0.01;
      rewind();
      const t = convertContour(curves, { ...opts, tolPx: fine, _fineRetry: true });
      if (t && t.patches) {
        if (t.stats) t.stats.retriedFine = true;
        return t;
      }
    }
    rewind();
    return null;
  } finally {
    CLIP_TESTS = clipTestsBefore;
  }
}

function convertContourInner(curves, opts, o) {
  // Set the moment this contour meets a LEAK offender: from then on its candidates are scored
  // with their leaks (see scoreLeak), because leak-shaped geometry is a property of the artwork
  // and not of the node the search happens to be standing on.
  let sawLeak = false;
  const {
    maxCurves,
    tolPx,
    maxDepth,
    interiorN,
    firstFit,
    directed,
    holes,
    holePolys,
    inAnyHole,
    leakMargin,
    countFirst,
    record,
    follow,
    frame: F0,
  } = o;
  let tapeAt = 0;
  let tapeBroke = false;
  const traceMark = opts.trace ? opts.trace.length : 0;
  let budget = opts.budget || 8192;
  //
  const patches = [],
    stats = {
      cuts: 0,
      chordCuts: 0,
      unresolved: 0,
      degenerate: 0,
      maxDepth: 0,
      stuck: opts.collectStuck ? [] : null,
    };

  const rooted = stripSpurs(rootCurves(curves, opts.forceBezout));
  const work = [];
  // Optional area audit: every cut must preserve the parent signed area.
  const _AA = globalThis.__CP_AREA_AUDIT
    ? (globalThis.__CP_AREA_OUT = globalThis.__CP_AREA_OUT || {})
    : null;
  const _aaArea = (l) => {
    let s2 = 0;
    const pts = [];
    const NQ = globalThis.__CP_AREA_N || 8;
    for (const sg of l) for (let q = 0; q < NQ; q++) pts.push(segPt(sg, q / NQ));
    for (let q = 0, m = pts.length; q < m; q++) {
      const a = pts[q],
        b = pts[(q + 1) % m];
      s2 += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s2) * 0.5;
  };
  let _aaCur = null,
    _aaKids = 0,
    _aaOp = null;
  const _aaFlush = () => {
    if (!_AA || _aaCur === null || _aaKids === 0) {
      _aaCur = null;
      _aaKids = 0;
      _aaOp = null;
      return;
    }
    const lost = _aaCur - _aaKids;
    if (_aaCur > 0 && lost / _aaCur > 1e-6) {
      const k = _aaOp || '(none)';
      const e = _AA[k] || (_AA[k] = { n: 0, lost: 0, worst: 0 });
      e.n++;
      e.lost += lost;
      e.worst = Math.max(e.worst, lost / _aaCur);
    }
    _aaCur = null;
    _aaKids = 0;
    _aaOp = null;
  };
  const wpush = (v) => {
    if (_AA) _aaKids += _aaArea(Array.isArray(v) ? v[0] : v);
    // Every loop the search enqueues is a piece of the shape. Whatever the step -- a line cut, a
    // curve cut, a subdivision, a terminal decomposition, a resolve -- the pieces partition their
    // parent, so an interior point of any of them is interior to the ORIGINAL contour. That is an
    // invariant with no tolerance in it, and the one thing that says WHICH step invented area. Off
    // unless a probe asks: it costs an interiorPoint and a winding test per enqueued loop.
    const AU = _LOOP_AUDIT;
    if (AU && AU.src) {
      const l = Array.isArray(v) ? v[0] : v;

      const bad = l && l.length >= 2 ? AU.frac(l) : 0;
      if (bad > 0.02 && !AU.parentBad)
        AU.push({
          op: _aaOp || AU.op || '?',
          n: l.length,
          bad,
          q: interiorPoint(l),
          parent: AU.parentN,
        });
    }
    return work.push(v);
  };

  const hasArea = loopHasArea; // see loopHasArea: slivers and two-line loops bound nothing
  // Trace one branch decision per work-list node so replay can reconstruct
  // the decomposition without searching or rescoring candidates.
  const trace = opts.trace || null;
  const tr = (rec) => {
    if (_AA || _LOOP_AUDIT) _aaOp = rec.op;
    // Into the node stream too when a probe asks, so a decision and the node it was made on read
    // in one ordered list rather than two that have to be aligned by guesswork.
    if (trace) trace.push(rec);
  };
  // A kept patch records which row its interior point came from (see interiorPoint's `row`).
  const trKeep = (loop) => tr({ op: 'keep', row: loop[K_IPROW] | 0 });
  // A line candidate is a CONSTRUCTION on the offending pair (tangent, normal, hull edge, chord
  // between their vertices), so its record is three small integers -- except the leak separators,
  // which are built at the leak's point and carry it.
  const trLine = (w, h, ci) =>
    tr(
      w.kind === 'leak' && w.point && h && h.tag && (h.tag[0] === 'l' || h.tag[0] === 'f')
        ? {
            op: 'line',
            i: w.i,
            j: w.j,
            tag: h.tag,
            cand: ci,
            lk: 1,
            past: w.past ? 1 : 0,
            point: [w.point[0], w.point[1]],
          }
        : { op: 'line', i: w.i, j: w.j, tag: h && h.tag, cand: ci },
    );
  // The root too. The graph front end can hand over a cycle that is itself a sliver (a ring
  // split whose two halves nearly coincide); it bounds no ink, and converting it is a refusal
  // waiting to happen. An empty decomposition is the right answer for it, and is a success.
  if (rooted.length >= 2 && hasArea(rooted)) wpush([rooted, 0]);
  else stats.emptyRoot = true;
  const push = (loops, depth) => {
    for (const l0 of loops) {
      const l = stripSpurs(l0);
      // A stripped loop is a subset of its curves: the parent record still applies to it.
      if (l !== l0 && l0[K_PAR] !== undefined) l[K_PAR] = l0[K_PAR];
      if (l !== l0 && l0._fromEar) l._fromEar = true;
      // WHICH PIECES SURVIVED, and why the others did not. A cut can produce the same pieces on
      // two runs and still enqueue a different number of them, and the decision record says
      // nothing about that -- it names the cut, not its result.
      if (l.length >= 2 && hasArea(l)) wpush([l, depth + 1]);
    }
  };
  const sameLoop = (a, b) => a.length === b.length;

  // Cuts can re-enqueue work without increasing depth. Bound nodes and pair
  // tests independently; exhaustion declines the entire contour so the caller
  // can use a complete fallback rather than a partial decomposition.
  let nodeBudget = mantleDebugHook('__CP_NODE_BUDGET') ?? 256 + 32 * curves.length;

  const pairBase = cpStats.pairs;
  const pairBudget = (mantleDebugHook('__CP_PAIR_BUDGET') ?? CP_PAIR_BUDGET_PER_NODE) * nodeBudget;
  if (globalThis.__CP_CALLS != null) globalThis.__CP_CALLS++;
  if (globalThis.__CP_CALL_CAP != null && globalThis.__CP_CALLS > globalThis.__CP_CALL_CAP)
    throw new Error('CP_CALL_CAP'); // diagnostic: is the cost call VOLUME?
  while (work.length) {
    if (nodeBudget-- <= 0 || cpStats.pairs - pairBase > pairBudget) {
      stats.budgetExhausted = true;
      if (cpStats.pairs - pairBase > pairBudget) stats.workExhausted = true;
      // DIAGNOSTIC: the branch tally at the moment the budget blew, which is what says WHICH
      // branch multiplies. Opt-in; costs nothing when the array is absent.
      if (globalThis.__CP_STATS) globalThis.__CP_STATS.push({ n: curves.length, ...stats });
      return null;
    }

    // Work can concentrate in one branch; node and pair budgets bound it.

    stats.nodes = (stats.nodes | 0) + 1; // decomposition nodes visited (budget below)
    _aaFlush();
    const [loop, depth] = work.pop();
    if (_AA) {
      _aaCur = _aaArea(loop);
      _aaKids = 0;
      _aaOp = null;
    }
    {
      const AU = _LOOP_AUDIT;
      if (AU && AU.src) {
        AU.parentBad = AU.frac(loop) > 0.02;
        AU.parentN = loop.length;
        AU.parentLoop = loop;
      }
    }
    if (globalThis.__CP_SIZES) globalThis.__CP_SIZES.push(loop.length);
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    if (loop.length < 2) continue;

    cpStats.nodes++;

    if (
      countFirst &&
      loop.length > countFirst &&
      (depth === 0 || loop._fromEar) &&
      !loop._earDone
    ) {
      const ec = earCut(loop, countFirst);
      if (ec) {
        stats.earCuts = (stats.earCuts | 0) + 1;
        tr(
          ec.pick && ec.pick.e !== undefined
            ? { op: 'ear', n: countFirst, e: ec.pick.e, N: ec.pick.N }
            : { op: 'ear', n: countFirst, split: ec.pick ? ec.pick.split : -1 },
        );
        for (const l of ec) l._fromEar = true;
        push(ec, depth - 1);
        continue;
      }
      loop._earDone = true;
    }

    const frame = framePatch(loop);
    if (frame && loop._terminal) frame._terminal = true; // provenance, for diagnostics
    if (!frame) {
      if (interiorPointMemo(loop)) {
        const slim = slimLoop(loop);
        if (slim && slim.length >= 2 && slim.length < loop.length) {
          stats.slimmed = (stats.slimmed | 0) + 1;
          tr({ op: 'slim' });
          wpush([slim, depth]);
          continue;
        }
        stats.invalid = (stats.invalid | 0) + 1;
      }
      stats.degenerate++;
      tr({ op: 'drop' });
      continue;
    }
    /** @type {Partial<ReturnType<typeof validatePatch>> & {ok:boolean}} */
    let v = validatePatch(frame, tolPx, leakMargin);
    let interiorOnly = false;
    // What this loop hands its pieces: its signs and its violating pairs, so a piece's pair sweep
    // tests only the pairs a cut changed (pairSweep). Built on demand, from the algebraic
    // verdict -- the hole and interior downgrades below replace `v` but not the pair results.
    const v0 = v;
    let par = null;
    const parOf = () => par || (par = parentRecord(frame, v0.viol));
    // Preserve the algebraic verdict before hole/interior checks downgrade it.
    // Those checks require further cutting but do not change the pair scores.
    const algOk = v.ok;
    // Interior check. validatePatch is a BOUNDARY test: it asks whether each curve's
    // implicit behaves along the patch's edges. It cannot see a curve whose implicit
    // goes the wrong way DEEP INSIDE — which a cubic's does routinely, because
    // k^3 - l*m is only a valid half-space near the curve, not globally.
    //
    // gridCheck samples the interior, which catches it. Only run on ACCEPTANCE (not per
    // cut candidate), so it costs one grid per patch kept.
    // HOLES, and THE ORDER HERE IS THE whole THING. Ask "does a hole boundary reach
    // into this patch?" FIRST. Only if none does can an interior point inside a hole
    // mean the patch is CONTAINED in one; while a hole's boundary still crosses the
    // patch, that same point merely says the hole is inside the PATCH.
    //
    let holeHit = null;
    if (holes.length) holeHit = holeIntrusion(frame, holes);
    if (holeHit) {
      stats.holeRejects = (stats.holeRejects | 0) + 1;
      v = { ok: false, worst: holeHit }; // cut until no hole reaches in
    } else if (holes.length && frame.inside && inAnyHole(frame.inside)) {
      // No hole boundary crosses it and its interior is inside a hole ⇒ the patch lies
      // wholly within the hole and bounds no filled area.
      stats.holeDropped = (stats.holeDropped | 0) + 1;
      tr({ op: 'drop' });
      continue;
    }
    if (v.ok && interiorN > 0) {
      const gc = gridCheck(frame, interiorN);
      if (gc && gc.bad > 0) {
        stats.interiorRejects = (stats.interiorRejects | 0) + 1;
        interiorOnly = true;
        // Fall through to the cut search WITH THE OFFENDER the grid found. A bare {i: 0, j: 1}
        // would point the halving at whatever comes first -- a seam line, which cannot be halved --
        // and leave a [seam, cubic, seam] crescent that only this check rejects with no move.
        const named = gc.i >= 0 && !record && !follow;
        v = {
          ok: false,
          worst:
            v.worst ||
            (named ? { kind: gc.kind, i: gc.i, j: gc.i, point: gc.point, depth: 0 } : null),
        };
      }
    }
    if (v.ok && loop.length <= maxCurves) {
      trKeep(loop);
      patches.push(frame);
      continue;
    } // pre-decision: no tape entry
    if (depth >= maxDepth || budget-- <= 0) {
      // The allowance is spent, not renewed: `_termSearch` counts down and the pieces stay
      // `_terminal`, so nothing here can decompose or re-budget a second time.
      if (!loop._terminal) {
        const dec = terminalDecompose(loop);
        if (globalThis.__CP_TERM_HOOK) globalThis.__CP_TERM_HOOK(loop, dec, 'cap', v);
        if (dec && dec.length) {
          stats.terminal = (stats.terminal | 0) + 1;
          stats.cappedTerminal = (stats.cappedTerminal | 0) + 1;
          tr({ op: 'term' });
          const allow = loop._termSearch === undefined ? TERM_SEARCH : loop._termSearch;
          for (const l of dec) {
            l._terminal = true;
            l._termSub = loop._termSub | 0;
            l._termSearch = allow;
            if (l.length >= 2 && hasArea(l)) wpush([l, allow > 0 ? depth - allow : depth]);
          }
          continue;
        }
        stats.terminalNull = (stats.terminalNull | 0) + 1;
        if (!loop._resolved) {
          const simple = resolveLoop(loop);
          if (simple) {
            stats.selfResolved = (stats.selfResolved | 0) + 1;
            tr({ op: 'resolve' });
            for (const l of simple) {
              l._resolved = true;
              if (l.length >= 2 && hasArea(l)) wpush([l, depth]);
            }
            continue;
          }
        }

        if ((loop._extended | 0) < 3) {
          loop._extended = (loop._extended | 0) + 1;
          stats.capExtended = (stats.capExtended | 0) + 1;
          tr({ op: 'extend' });
          wpush([loop, depth - 8]);
          continue;
        }
      } else if (!v.ok && (loop._termSub | 0) < TERM_SUB_CAP) {
        // A terminal piece that still does not validate. Subdividing is the repair, and it is
        // the one place in this file where subdivision does real work. Halving a Bezier does not
        // change its implicit — the sub-arcs lie on the same algebraic curve — but the patch's
        // COVER is the control hull, and halving shrinks the hull. A leaking crescent leaks
        // because a far branch of its own cubic runs back through that hull; tighten the hull
        // and the branch is outside it.
        //
        // Cleared of `_terminal` on the way back so the smaller loop is decomposed again rather
        // than merely re-tested, and counted so this cannot spin.
        const wi = (v.worst && v.worst.i) | 0;

        const si = loop[wi] && loop[wi].t !== 'line' ? wi : loop.findIndex((c) => c.t !== 'line');
        const sub = si >= 0 ? subdivideCurve(loop, si) : null;
        if (sub) {
          sub._termSub = (loop._termSub | 0) + 1;
          stats.termSubdiv = (stats.termSubdiv | 0) + 1;
          tr({ op: 'sub', i: si });
          wpush([sub, depth]);
          continue;
        }
      }
      stats.unresolved++;
      stats.unresolvedCap = (stats.unresolvedCap | 0) + 1;
      trKeep(loop);
      if (!algOk) stats.invalid = (stats.invalid | 0) + 1;
      if (stats.stuck && stats.stuck.length < 64)
        stats.stuck.push({ loop, worst: v.worst, kind: v.worst && v.worst.kind, cap: true });
      patches.push(frame);
      continue;
    }

    let worst = v.worst || { i: 0, j: 1 % loop.length };
    // Per-node diagnostic: the loop this node is cutting and the violation it is cutting for.
    // The trace records the CHOSEN CUT, which is one step downstream -- when two runs of the same
    // search disagree, this says whether they disagreed about the offender or about the candidate.
    const step = follow ? follow[tapeAt] : null;
    if (follow && !step) {
      tapeBroke = true;
      if (!stats.tapeBrokeAt)
        stats.tapeBrokeAt = { at: tapeAt, want: 'end-of-tape', got: 'more work' };
      break;
    }
    // Replaying the src's violation is what keeps the candidate list aligned; the
    // dst's own validation may disagree, and that disagreement is the drift.
    // A tape's point is in the caller's coordinates: each pose converts in its own frame (see
    // convertFramed), so a point recorded in one frame means nothing in the other's.
    if (step && step.worst)
      worst =
        F0 && step.worst.point
          ? {
              ...step.worst,
              point: [(step.worst.point[0] - F0.ox) * F0.k, (step.worst.point[1] - F0.oy) * F0.k],
            }
          : step.worst;
    const note = (branch, extra) => {
      if (step && step.branch !== branch) {
        tapeBroke = true;
        if (!stats.tapeBrokeAt) stats.tapeBrokeAt = { at: tapeAt, want: step.branch, got: branch };
      }
      const wp =
        worst.point && F0
          ? [worst.point[0] / F0.k + F0.ox, worst.point[1] / F0.k + F0.oy]
          : worst.point;
      if (record)
        record.push({
          branch,
          worst: { i: worst.i, j: worst.j, kind: worst.kind, past: worst.past, point: wp },
          ...extra,
        });
      tapeAt++;
    };
    // The baseline IS what validatePatch just summed over this very frame -- same clip pairs,
    // same leak, same tolerance and margin -- so asking scoreOf to rebuild it would be one full
    // re-walk of the node's own patch per cutting node.
    const base = v.ok
      ? { pairs: 0, depth: 0 }
      : v.score || scoreOf([loop], tolPx, undefined, leakMargin);

    const cheapFrames = opts.cheapFrames === true;

    if (worst.kind === 'leak') sawLeak = true;
    const scoreLeak = (opts.leakScore || 'leaky') === 'leaky' ? sawLeak : true;

    let best = null;
    let bestIdx = -1;
    let bestCurve = false;

    // Curve cuts are considered only for leak violations and static searches.
    if (worst.kind === 'leak' && !record && !follow && !opts.noCurveCuts) {
      // Try one cut per source algebraic curve and rank the resulting pieces.
      // scoreTop optionally limits how many structural candidates are scored;
      // zero retains all candidates. Geometric distance alone is not the score.
      const tried = [];
      const ONE = opts.curveCandidates === 1; // for measuring what this costs
      // ONE CUT PER ALGEBRAIC CURVE. Slices of one input curve extend to the same curve, so their
      // cuts are one cut computed from different control points, and the ranking between them
      // would be decided by rounding. The first in loop order stands for its siblings.
      const seenSrc = new Set();
      for (let i2 = 0; i2 < loop.length; i2++) {
        if (ONE && i2 !== worst.i) continue;
        if (i2 !== worst.i && loop[i2].t === 'line') continue; // a line's extension is itself
        const k2 = algKey(loop[i2]);
        if (k2 !== null) {
          if (seenSrc.has(k2)) continue;
          seenSrc.add(k2);
        }
        const rc = cutPatchByCurve(loop, i2, frame.bbox);
        if (!rc || !rc.keep.length || !rc.drop.length) continue;
        const all = rc.keep.concat(rc.drop);
        if (all.some((l) => l.length < 2) || all.every((l) => sameLoop(l, loop))) continue;
        adoptParent(all, parOf());
        tried.push({ rc, all, big: Math.max(...all.map((l) => l.length)), ci: i2 });
      }
      tried.sort((x, y) => x.big - y.big);

      const SCORE_TOP = opts.scoreTop === undefined ? 0 : opts.scoreTop | 0;
      for (const c of tried.slice(0, SCORE_TOP > 0 ? SCORE_TOP : tried.length)) {
        const sc = v.ok
          ? c.big
          : scoreOf(c.all, tolPx, undefined, leakMargin, scoreLeak, cheapFrames, frame.inside);
        const better = v.ok
          ? /** @type {number} */ (sc) < loop.length &&
            (!best || /** @type {number} */ (sc) < /** @type {number} */ (best.sc))
          : sc && scoreLess(sc, base, tolPx) && (!best || scoreLess(sc, best.sc, tolPx));
        if (better) {
          best = { r: c.rc, sc, ci: c.ci };
          bestCurve = true;
          bestIdx = -1;
        }
      }
    }
    const cands = cutCandidates(frame, worst, false, leakMargin);
    if (step) {
      // FOLLOW: take the recorded candidate, not a re-derived best.
      if (step.branch === 1) {
        // By tag first. The index is only a hint: the list is deduplicated geometrically, so a
        // different number of near-duplicates can collapse on this pose and shift everything
        // after them.
        let h = step.tag ? cands.find((c) => c.tag === step.tag) : null;
        if (!h) h = cands[step.cand];
        const r = h ? cutPatchByLine(loop, h, frame.inside) : null;
        if (!r || !r.keep.length || !r.drop.length) {
          tapeBroke = true;
          if (!stats.tapeBrokeAt)
            stats.tapeBrokeAt = { at: tapeAt, want: 'branch 1 cut', got: 'cut failed' };
          break;
        }
        trLine(worst, h, step.cand);
        tapeAt++;
        stats.cuts++;
        push(adoptParent(r.keep.concat(r.drop), parOf()), depth);
        continue;
      }
    } else
      // Directed cuts choose the separating line nearest the offender.
      if (directed && !v.ok && worst && worst.point) {
        const wp = worst.point,
          ip = frame.inside;
        // Minimize offender-to-line distance among lines separating it from
        // the interior sample, without validating candidate subloops.
        let dBest = Infinity,
          dIdx = -1;
        for (let ci = 0; ci < cands.length; ci++) {
          const h = cands[ci];
          const sw = affEval(h, wp[0], wp[1]),
            si = affEval(h, ip[0], ip[1]);
          if (!(sw * si < 0)) continue; // does not separate the offender
          const nl = Math.hypot(h[0], h[1]) || 1;
          const d = Math.abs(sw) / nl; // distance from the line to the offender
          if (d < dBest) {
            dBest = d;
            dIdx = ci;
          }
        }
        if (dIdx >= 0) {
          cpStats.cuts++;
          const r = cutPatchByLine(loop, cands[dIdx], frame.inside);
          const all = r && r.keep.length && r.drop.length ? r.keep.concat(r.drop) : null;
          if (all && !all.some((l) => l.length < 2) && !all.every((l) => sameLoop(l, loop))) {
            note(1, { cand: dIdx });
            trLine(worst, cands[dIdx], dIdx);
            stats.directedCuts = (stats.directedCuts | 0) + 1;
            stats.cuts++;
            push(adoptParent(all, parOf()), depth);
            best = null;
            bestIdx = -2; // handled; skip the scored search
          }
        }
        if (bestIdx === -2) continue;
      }
    //
    let order = cands,
      narrowEnd = cands.narrow === undefined ? cands.length : cands.narrow;

    if (opts.candOrder === 'sep' && v0.viol && v0.viol.length) {
      const rankW = (t) =>
        !t
          ? 9
          : t === 'chord'
            ? 0
            : t[0] === 't'
              ? 1
              : t[0] === 'n'
                ? 2
                : t[0] === 'v'
                  ? 3
                  : t[0] === 'h'
                    ? 4
                    : t[0] === 'l'
                      ? 5
                      : 6;
      const byId = new Map();
      for (let i = 0; i < loop.length; i++) byId.set(segId(loop[i]), loop[i]);
      const pts = new Map();
      const samples = (c) => {
        let a2 = pts.get(c);
        if (!a2) {
          a2 = [segStart(c), segPt(c, 0.5), segEnd(c)];
          pts.set(c, a2);
        }
        return a2;
      };
      const pairs = [];
      for (const vv of v0.viol) {
        const A2 = byId.get(vv.a),
          B2 = byId.get(vv.b);
        if (A2 && B2 && A2 !== B2) pairs.push([samples(A2), samples(B2)]);
      }
      const seps = (h) => {
        let n = 0;
        for (let k = 0; k < pairs.length; k++) {
          const [P0, P1] = pairs[k];
          let lo0 = Infinity,
            hi0 = -Infinity,
            lo1 = Infinity,
            hi1 = -Infinity;
          for (let q = 0; q < 3; q++) {
            const p = P0[q],
              w = h[0] * p[0] + h[1] * p[1] + h[2];
            if (w < lo0) lo0 = w;
            if (w > hi0) hi0 = w;
          }
          for (let q = 0; q < 3; q++) {
            const p = P1[q],
              w = h[0] * p[0] + h[1] * p[1] + h[2];
            if (w < lo1) lo1 = w;
            if (w > hi1) hi1 = w;
          }
          if ((hi0 <= 0 && lo1 >= 0) || (hi1 <= 0 && lo0 >= 0)) n++;
        }
        return n;
      };
      const narrow = cands
        .slice(0, narrowEnd)
        .map((h, k) => /** @type {[typeof h,number,number]} */ ([h, k, seps(h)]))
        .sort((x, y) => y[2] - x[2] || rankW(x[0].tag) - rankW(y[0].tag) || x[1] - y[1])
        .map((p) => p[0]);
      order = narrow.concat(cands.slice(narrowEnd));
      order.narrow = narrowEnd;
    } else if ((opts.candOrder || (leakMargin > 0 ? 'index' : 'wins')) === 'wins') {
      const rank = (t) =>
        !t
          ? 9
          : t === 'chord'
            ? 0
            : t[0] === 't'
              ? 1
              : t[0] === 'n'
                ? 2
                : t[0] === 'v'
                  ? 3
                  : t[0] === 'h'
                    ? 4
                    : t[0] === 'l'
                      ? 5
                      : 6;
      const narrow = cands
        .slice(0, narrowEnd)
        .map((h, k) => /** @type {[typeof h,number]} */ ([h, k]))
        .sort((x, y) => rank(x[0].tag) - rank(y[0].tag) || x[1] - y[1])
        .map((p) => p[0]);
      order = narrow.concat(cands.slice(narrowEnd));
      order.narrow = narrowEnd;
    }
    const lineTop = opts.lineTop | 0;
    const _q = globalThis.__CPQ;
    const _q0 = _q ? _q.scored | 0 : 0;
    if (_q) _q.searches = (_q.searches | 0) + 1;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (let ci = pass ? narrowEnd : 0; ci < (pass ? order.length : narrowEnd); ci++) {
        if (lineTop && !pass && ci >= lineTop && best) break;
        const h = order[ci];
        cpStats.cuts++;
        const r = cutPatchByLine(loop, h, frame.inside);
        if (!r || !r.keep.length || !r.drop.length) continue;
        const all = r.keep.concat(r.drop);
        if (all.some((l) => l.length < 2) || all.every((l) => sameLoop(l, loop))) continue;
        adoptParent(all, parOf());
        if (v.ok) {
          const sc = Math.max(...all.map((l) => l.length));
          if (
            /** @type {number} */ (sc) < loop.length &&
            (!best || /** @type {number} */ (sc) < /** @type {number} */ (best.sc))
          ) {
            best = { r, sc };
            bestIdx = ci;
            bestCurve = false;
          }
        } else {
          // The bound is the tighter of "must beat the incumbent" and "must beat doing nothing".
          const bound = best ? (scoreLess(best.sc, base, tolPx) ? best.sc : base) : base;
          const sc = scoreOf(all, tolPx, bound, leakMargin, scoreLeak, cheapFrames, frame.inside);
          if (sc && scoreLess(sc, base, tolPx) && (!best || scoreLess(sc, best.sc, tolPx))) {
            best = { r, sc };
            bestIdx = ci;
            bestCurve = false;
          }
          if (globalThis.__CPQ) {
            globalThis.__CPQ.scored++;
          }

          if (
            best &&
            best.sc &&
            /** @type {ReturnType<typeof scoreOf>} */ (best.sc).pairs === 0 &&
            /** @type {ReturnType<typeof scoreOf>} */ (best.sc).depth === 0
          ) {
            ci = 1e9;
            break;
          }
          if (
            best &&
            firstFit &&
            (!opts.fitBar || /** @type {ReturnType<typeof scoreOf>} */ (best.sc).pairs < base.pairs)
          )
            break; // good enough: stop scoring the rest
        }
      }
    }
    if (globalThis.__CPQ && best && !bestCurve) {
      const q = globalThis.__CPQ;
      q.wins++;
      q.rank.push(bestIdx);
      q.cands.push(cands.length);
    }
    if (_q) {
      if (!_q.per) _q.per = [];
      _q.per.push([cands.length, (_q.scored | 0) - _q0, best && !bestCurve ? bestIdx : -1]);
    }
    if (best) {
      if (bestCurve) {
        note(8);
        tr({ op: 'curve', i: best.ci, pr: best.r.pair });
        stats.curveCuts = (stats.curveCuts | 0) + 1;
      } else {
        note(1, { cand: bestIdx, tag: best.r && order[bestIdx] ? order[bestIdx].tag : undefined });
        trLine(worst, order[bestIdx], bestIdx);
      }
      stats.cuts++;
      push(best.r.keep.concat(best.r.drop), depth);
      continue;
    }

    if (loop[worst.i].t === 'line') {
      const A2 = segStart(loop[worst.i]),
        B2 = segEnd(loop[worst.i]);
      const dx = B2[0] - A2[0],
        dy = B2[1] - A2[1],
        L2 = Math.hypot(dx, dy);
      if (L2 > 1e-12 * loopExtent(loop)) {
        const hs = [-dy / L2, dx / L2, -((-dy / L2) * A2[0] + (dx / L2) * A2[1])];
        const r = cutPatchByLine(loop, hs, frame.inside);
        if (r && r.keep.length && r.drop.length) {
          const all = r.keep.concat(r.drop);
          if (!all.some((l) => l.length < 2) && !all.every((l) => sameLoop(l, loop))) {
            note(2);
            tr({ op: 'own', i: worst.i });
            stats.lineCuts = (stats.lineCuts | 0) + 1;
            push(adoptParent(all, parOf()), depth);
            continue;
          }
        }
      }
    }

    // Try the offending curve extension before its chord. Reject a cut that
    // makes no progress. Curve cuts are excluded from recorded/followed morph
    // plans because their intersection parameters can move with the pose.
    if (loop[worst.i].t !== 'line' && !record && !follow && !opts.noCurveCuts) {
      const rcv = cutPatchByCurve(loop, worst.i, frame.bbox);
      if (rcv && rcv.keep.length && rcv.drop.length) {
        const allv = rcv.keep.concat(rcv.drop);
        if (!allv.some((l) => l.length < 2) && !allv.every((l) => l.length === loop.length)) {
          note(6);
          tr({ op: 'curve', i: worst.i, pr: rcv.pair });
          stats.curveFallbacks = (stats.curveFallbacks | 0) + 1;
          push(adoptParent(allv, parOf()), depth);
          continue;
        }
      }
    }

    // A chord cut isolates the curve crescent from the remaining constraints.
    const curvedCount = loop.filter((s) => s.t !== 'line').length;
    const hc = loop[worst.i].t === 'line' || curvedCount <= 1 ? null : chordCut(loop[worst.i]);
    if (hc) {
      const r = cutPatchByLine(loop, hc, frame.inside);
      if (r && r.keep.length && r.drop.length) {
        const all = r.keep.concat(r.drop);
        if (!all.some((l) => l.length < 2)) {
          note(3);
          tr({ op: 'chord', i: worst.i });
          stats.chordCuts++;
          push(adoptParent(all, parOf()), depth);
          continue;
        }
      }
    }
    if (v.ok) {
      note(4);
      trKeep(loop);
      patches.push(frame);
      continue;
    }
    // Subdivision preserves the implicit region; an interior-only rejection needs a separating cut.
    if (!interiorOnly) {
      const sub = subdivideCurve(loop, worst.i);
      if (sub) {
        note(5);
        tr({ op: 'sub', i: worst.i });
        stats.subdivisions = (stats.subdivisions | 0) + 1;
        adoptParent([sub], parOf());
        wpush([sub, depth + 1]);
        continue;
      }
    }
    // 4. TERMINAL: decompose the Loop-Blinn way. Valid by construction, so nothing below it
    //    can be unresolved for a reason the search failed to find.
    if (!loop._terminal) {
      const dec = terminalDecompose(loop);
      if (globalThis.__CP_TERM_HOOK) globalThis.__CP_TERM_HOOK(loop, dec, 'exhausted', v);
      if (!dec || !dec.length) stats.terminalNull = (stats.terminalNull | 0) + 1;
      if (dec && dec.length) {
        stats.terminal = (stats.terminal | 0) + 1;
        note(6);
        tr({ op: 'term' });
        for (const l of dec) {
          l._terminal = true;
          if (l.length >= 2 && hasArea(l)) wpush([l, depth + 1]);
        }
        continue;
      }
    }

    if (!loop._resolved) {
      const simple = resolveLoop(loop);
      if (simple) {
        stats.selfResolved = (stats.selfResolved | 0) + 1;
        note(9);
        tr({ op: 'resolve' });
        for (const l of simple) {
          l._resolved = true;
          if (l.length >= 2 && hasArea(l)) wpush([l, depth + 1]);
        }
        continue;
      }
    }
    note(7);
    trKeep(loop);
    stats.unresolved++;
    stats.unresolvedExhausted = (stats.unresolvedExhausted | 0) + 1;
    if (!algOk) stats.invalid = (stats.invalid | 0) + 1;
    if (stats.stuck && stats.stuck.length < 64)
      stats.stuck.push({ loop, worst, kind: worst && worst.kind });
    patches.push(frame);
  }
  // A tape that could not be honored yields nothing, so a caller can never composite
  // a dst that decomposed differently from its src.
  if (follow && tapeBroke) {
    if (opts.onTapeBreak) opts.onTapeBreak(stats.tapeBrokeAt || { at: -1 });
    return null;
  }
  // The paper's stage (e) loop case, applied to the finished set. Not while already inside one,
  // or a loop whose own extension loops would recurse without end.
  if (!opts._loopPatch) addLoopPatches(patches, stats, opts);
  if (record) stats.tape = record.length;
  // Invalid patches decline unless a diagnostic explicitly asks for them.
  if (stats.invalid && !opts.allowInvalid) {
    return null;
  }
  return { patches, stats };
}

/// REPLAY a decomposition from its trace (see `opts.trace` on convertContour): the search's
/// decisions -- which branch, which curve, which constructed candidate, at each node -- with
/// none of the search. No scoring, no validation, no leak test; each node costs its frame and
/// one cut. The cuts run against the caller's own geometry, so a trace baked at build time from
/// float64 control points reproduces the decomposition on whatever the runtime decoded, and a
/// seam lands where the runtime's curves actually cross the cut rather than where a baked
/// coordinate says they did.
///
/// Returns { patches, stats }, or NULL when the trace does not fit the geometry (a recorded
/// cut that finds nothing to cut on this input) -- the caller converts from scratch.
export function replayContour(curves, trace, opts = {}) {
  const cur = opts._cursor || { at: 0 };
  // A SPLIT CONTOUR (convertContourSplit): re-derive the pieces from this geometry and the recorded
  // ear bound, then replay each on the shared cursor. A piece count that disagrees is a trace made
  // from other geometry, and misfits like any other.
  if (
    !opts._loopPatch &&
    !opts._normReplay &&
    !opts._piece &&
    trace[cur.at] &&
    trace[cur.at].op === 'split'
  ) {
    const rec = trace[cur.at++];
    let pieces = null;
    try {
      pieces = framedPieces(curves, rec.n);
    } catch {
      pieces = null;
    }
    if (!pieces || pieces.length !== rec.parts) {
      if (opts.stats) opts.stats.fail = 'split at ' + (cur.at - 1);
      return null;
    }
    const parts = [];
    for (const piece of pieces) {
      const r = replayContour(piece, trace, { ...opts, _cursor: cur, _piece: true });
      if (!r) return null;
      parts.push(r);
    }
    if (cur.at !== trace.length) {
      if (opts.stats)
        opts.stats.fail = 'desync: ' + (trace.length - cur.at) + ' records unread after the split';
      return null;
    }
    return mergeSplit(parts);
  }
  // The frame the search ran in: the contour's own, which a `frame` record says to
  // derive from these curves -- the bake is keyed on their exact bits, so it is the recorded one --
  // or, from an older bake whose conversions are not all framed, a `norm` record carrying the frame the
  // refusal ladder's normalized rung chose. Move into it, replay, map the patches back: the
  // three steps convertFramed takes, so the replayed decomposition is the recorded one.
  const rop = !opts._loopPatch && !opts._normReplay && trace[cur.at] ? trace[cur.at].op : null;
  if (rop === 'frame' || rop === 'norm') {
    const rec = trace[cur.at++];
    const F = rop === 'frame' ? contourFrame(curves) : { k: rec.k, ox: rec.ox, oy: rec.oy };
    if (!F || !(F.k > 0) || !isFinite(F.k) || !isFinite(F.ox) || !isFinite(F.oy)) {
      if (opts.stats) opts.stats.fail = rop + ' at ' + (cur.at - 1);
      return null;
    }
    const inner = replayContour(_toFrame(curves, F), trace, {
      ...opts,
      _cursor: cur,
      _normReplay: true,
    });
    if (!inner) return null;
    const back = unframePatches(inner.patches, F);
    if (!back) {
      if (opts.stats) opts.stats.fail = rop + ' back';
      return null;
    }
    return { patches: back, stats: inner.stats };
  }
  const patches = [];
  // A replay that fails must say WHERE, and one that ends with records unread has desynced --
  // some node took a different number of pieces than the trace expected -- which is the failure
  // mode of a trace applied to geometry it was not recorded on, and it is silent otherwise.
  const fail = (why) => {
    if (opts.stats) opts.stats.fail = why + ' at ' + (cur.at - 1);
    return null;
  };
  const rooted = stripSpurs(rootCurves(curves, opts.forceBezout));
  const work = [];
  if (rooted.length >= 2 && loopHasArea(rooted)) work.push(rooted);
  const push = (loops) => {
    for (const l0 of loops) {
      const l = stripSpurs(l0);
      if (l.length >= 2 && loopHasArea(l)) work.push(l);
    }
  };
  const pushRaw = (loops) => {
    for (const l of loops) if (l.length >= 2 && loopHasArea(l)) work.push(l);
  };
  const bboxOf = (loop) => {
    let b = loop[K_BBOX];
    if (b === undefined) {
      b = patchBBox(loop);
      loop[K_BBOX] = b;
    }
    return b;
  };
  const cutLine = (loop, h) => {
    if (!h) return false;
    const r = cutPatchByLine(loop, h, () => interiorPointMemo(loop));
    if (!r || !r.keep.length || !r.drop.length) return false;
    push(r.keep.concat(r.drop));
    return true;
  };
  while (work.length) {
    const loop = work.pop();
    if (loop.length < 2) continue;
    const rec = trace[cur.at++];
    if (!rec) return fail('trace exhausted');
    switch (rec.op) {
      case 'drop':
        continue;
      case 'extend': {
        work.push(loop);
        continue;
      } // the cap gave the search more room: same loop, next record
      case 'ear': {
        // the recorded pick, so the replay slices instead of searching for a clear run
        const forced =
          rec.e !== undefined
            ? { e: rec.e, N: rec.N }
            : rec.split >= 0
              ? { split: rec.split }
              : undefined;
        const ec = earCut(loop, rec.n, forced);
        if (!ec) return fail('ear');
        push(ec);
        continue;
      }
      case 'slim': {
        const s = slimLoop(loop);
        if (!s) return fail('slim');
        work.push(s);
        continue;
      }
      case 'keep': {
        const f = framePatch(loop, rec.row ? interiorPoint(loop, rec.row) : undefined);
        if (!f) return fail('frame');
        patches.push(f);
        continue;
      }
      case 'line': {
        // cutCandidates reads only the curves of the offending pair; no frame is needed.
        const cands = cutCandidates(
          { curves: loop },
          {
            i: rec.i,
            j: rec.j,
            kind: rec.lk ? 'leak' : 'clip',
            past: !!rec.past,
            point: rec.point,
          },
          false,
        );
        let h = rec.tag ? cands.find((c) => c.tag === rec.tag) : null;
        if (!h && rec.cand != null) h = cands[rec.cand];
        if (!cutLine(loop, h)) return fail('line ' + rec.tag);
        continue;
      }
      case 'own': {
        const A2 = segStart(loop[rec.i]),
          B2 = segEnd(loop[rec.i]);
        const dx = B2[0] - A2[0],
          dy = B2[1] - A2[1],
          L2 = Math.hypot(dx, dy);
        if (!(L2 > 1e-12 * loopExtent(loop))) return fail('own');
        if (!cutLine(loop, [-dy / L2, dx / L2, -((-dy / L2) * A2[0] + (dx / L2) * A2[1])]))
          return fail('own');
        continue;
      }
      case 'chord': {
        if (!cutLine(loop, chordCut(loop[rec.i]))) return fail('chord');
        continue;
      }
      case 'curve': {
        const rc = cutPatchByCurve(loop, rec.i, bboxOf(loop), rec.pr || undefined);
        if (!rc || !rc.keep.length || !rc.drop.length) return fail('curve');
        push(rc.keep.concat(rc.drop));
        continue;
      }
      case 'sub': {
        const sub = subdivideCurve(loop, rec.i);
        if (!sub) return fail('sub');
        work.push(sub);
        continue;
      }
      case 'term': {
        const dec = terminalDecompose(loop);
        if (!dec || !dec.length) return fail('term');
        pushRaw(dec);
        continue;
      }
      case 'resolve': {
        const simple = resolveLoop(loop);
        if (!simple) return fail('resolve');
        pushRaw(simple);
        continue;
      }
      default:
        return fail('op ' + rec.op);
    }
  }
  // The paper's stage (e) loop case, exactly as addLoopPatches runs it: the same tests decide
  // whether a loop is attempted, and the trace says whether its conversion produced anything.
  if (!opts._loopPatch) {
    const extra = [],
      seen = [];
    for (const p of patches) {
      for (let i = 0; i < p.curves.length; i++) {
        const halves = extensionLoopPatch(p.curves[i], p.bbox);
        if (!halves) continue;
        if (belowFloat32(halves)) continue; // as addLoopPatches: no record was written for it
        const c = loopCentroid(halves);
        if (!c) continue;
        if (!inside(p.curves, c[0], c[1])) continue;
        if (inPatch(p, c[0], c[1])) continue;
        if (seen.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 1e-6 * loopExtent(p.curves)))
          continue;
        if (trace[cur.at] && trace[cur.at].op === 'skip') {
          cur.at++;
          continue;
        }
        const sub = replayContour(halves, trace, { ...opts, _loopPatch: true, _cursor: cur });
        if (!sub) return null;
        seen.push(c);
        for (const f of sub.patches) extra.push(f);
      }
    }
    for (const f of extra) patches.push(f);
    // A split's piece stops where its own records do; the split checks the whole trace after the last.
    if (!opts._piece && cur.at !== trace.length)
      return fail('desync: ' + (trace.length - cur.at) + ' records unread');
  }
  return { patches, stats: { replayed: cur.at } };
}

/// The contour fill test, for probes that measure a decomposition against ground truth.
export const insideContour = inside;
