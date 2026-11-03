// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchImplicit — the scalar-Bezier algebra a CPatch converter needs.
//
// Building a CPatch (a region whose interior is the intersection of its bounding curves'
// half-spaces) from an arbitrary path needs two exact predicates that a sampler cannot supply:
//
//   1. "does implicit f_i stay non-negative along curve j?"   (patch VALIDITY)
//   2. "where does the line h cross curve j?"                 (patch CUTTING)
//
// Both reduce to one object. Every implicit here is a sum of PRODUCTS OF AFFINE functionals —
// line: -l, quad: u^2-v, cubic: k^3-lm, and the Bezout resultant expands into five such
// products — and an affine functional composed with a degree-n Bezier is a scalar Bezier of
// degree n whose Bernstein coefficients are just the functional at the CONTROL POINTS.
// Multiply those out in the Bernstein basis and f_i o seg_j is an exact scalar Bezier of degree
// <= 3n. Its convex-hull property then answers both questions with a certificate rather than a
// sample: all coefficients >= 0 PROVES f_i >= 0 over the whole span, and a hull strictly off
// zero PROVES there is no crossing.
//
//mjs for what the converter built on this concluded.
// No GL, no module state.
import { cubicKLMN, cubicDegreeReduce, bezoutCubicImplicit, cubicDScale } from './lbCubicMath.js';

import { solveCubic, solveCubicInUnit, solveQuadratic } from '../svg/pathBoolean/polyRoots.js';
import { mantleDebugHook } from '../core/diagnostics.js';

// ---- rational quadratics (arcs, ellipse segments) -------------------------------
// An rquad is { t:'rquad', P:[A,M,B], w } with weights (1, w, 1). Everything below works on
// its HOMOGENEOUS control points [Wx, Wy, W]: de Casteljau, blossoms and affine composition
// are all linear, so they are the same algorithms one component wider, and the projection to
// (x/w, y/w) happens only at the end. W stays strictly positive for w > 0, which is what lets
// the sign tests below multiply through by a power of it.
/// A native SVG arc (SEG_ARC: center, radii, theta range, rotation) as exact rational
/// quadratics. An ellipse is an affine image of a circle and rational Beziers are
/// affine-invariant, so the construction is done on the unit circle — where the middle control
/// point sits at the mid-angle scaled by 1/cos(h) and the weight is cos(h), h being the half
/// span — and then mapped through the ellipse's affine. No flattening, no approximation.
///
/// Split at 90 degrees because the form degenerates as the span approaches 180 (cos(h) -> 0,
/// the tangents become parallel and the middle control point runs to infinity).
export function arcToRQuads(seg, maxSpan = Math.PI / 2) {
  const { cx, cy, rx, ry, phi } = seg;
  const t0 = seg.theta_start,
    t1 = seg.theta_end;
  const span = t1 - t0;
  if (!(Math.abs(span) > 1e-12) || !(rx > 0) || !(ry > 0)) return [];
  const n = Math.max(1, Math.ceil(Math.abs(span) / maxSpan));
  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  const map = (x, y) => [cx + cp * rx * x - sp * ry * y, cy + sp * rx * x + cp * ry * y];
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = t0 + (span * k) / n,
      b = t0 + (span * (k + 1)) / n;
    const h = (b - a) / 2,
      m = (a + b) / 2;
    const w = Math.cos(h);
    if (!(Math.abs(w) > 1e-9)) return [];
    const A = map(Math.cos(a), Math.sin(a));
    const B = map(Math.cos(b), Math.sin(b));
    const M = map(Math.cos(m) / w, Math.sin(m) / w);
    out.push({ t: 'rquad', P: [A, M, B], w: Math.abs(w) });
  }
  return out;
}

export const isRat = (seg) => seg.t === 'rquad';
/// Each seam's COMPANION: a Map on the patch from its cut curve to the outline curve that runs
/// closest along that seam on the far side of it -- the curve a patch cannot see and a pixel
/// straddling the seam still has in it. The packer rides it in the seam's own row.
export const K_COMP = Symbol('cp.comp');
/// The origin of the frame the kernel evaluates a patch in, on the patch the packer
/// hands out: [0, 0] where it packs in world em. The CPU model takes positions relative to it where the
/// kernel's arithmetic depends on their magnitude.
export const K_FRAME = Symbol('cp.frame');
export function ratH(seg) {
  const w = seg.w == null ? 1 : seg.w,
    P = seg.P;
  return [
    [P[0][0], P[0][1], 1],
    [P[1][0] * w, P[1][1] * w, w],
    [P[2][0], P[2][1], 1],
  ];
}
const deCast = (pts, t) => {
  let c = pts.map((p) => p.slice());
  while (c.length > 1) {
    const nx = [];
    for (let i = 0; i < c.length - 1; i++) nx.push(c[i].map((v, k) => v + (c[i + 1][k] - v) * t));
    c = nx;
  }
  return c[0];
};
const ratFromH = (H) => {
  const pr = (h) => [h[0] / h[2], h[1] / h[2]];
  return {
    t: 'rquad',
    P: [pr(H[0]), pr(H[1]), pr(H[2])],
    w: H[1][2] / Math.sqrt(H[0][2] * H[2][2]),
    _H: H,
  };
};

// ---- segment primitives (any degree, any t — INCLUDING t outside [0,1]) ----------
// de Casteljau is an extrapolator as well as an interpolator, which is what lets the
// converter cut a patch along the EXTENSION of one of its own bounding curves.

/// Blossom (polar form) of the segment — de Casteljau with a DIFFERENT parameter at each
/// level. Symmetric in its arguments, so the sub-Bézier over any [t0,t1] drops out with no
/// special cases: t0 == 1 and t1 > 1 (the extension the converter cuts along) are ordinary
/// arguments here, where the split-then-reparameterize form divides by zero.
function blossom(P, ts) {
  let pts = P.map((p) => [p[0], p[1]]);
  for (const t of ts) {
    const nx = [];
    for (let i = 0; i < pts.length - 1; i++)
      nx.push([
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
      ]);
    pts = nx;
  }
  return pts[0];
}

/// The blossom of a polynomial segment for the (t0, t1) slice, one point per output control
/// point, on scalars: the same lerps the generic blossom above performs, in the same order,
/// with the multiset [t0 x (n-i), t1 x i] applied level by level -- t0 first.
const _blX = new Float64Array(5),
  _blY = new Float64Array(5);
function sliceControlPoints(P, t0, t1) {
  const n = P.length - 1,
    out = new Array(n + 1);
  const X = _blX,
    Y = _blY;
  for (let i = 0; i <= n; i++) {
    for (let k = 0; k <= n; k++) {
      X[k] = P[k][0];
      Y[k] = P[k][1];
    }
    let len = n + 1;
    for (let lv = 0; lv < n; lv++) {
      const t = lv < n - i ? t0 : t1;
      for (let k = 0; k < len - 1; k++) {
        X[k] = X[k] + (X[k + 1] - X[k]) * t;
        Y[k] = Y[k] + (Y[k + 1] - Y[k]) * t;
      }
      len--;
    }
    out[i] = [X[0], Y[0]];
  }
  return out;
}

export function segSlice(seg, t0, t1) {
  if (isRat(seg)) {
    const H = ratH(seg),
      n2 = 2,
      out2 = [];
    for (let i = 0; i <= n2; i++) {
      const ts = [];
      for (let j = 0; j < n2 - i; j++) ts.push(t0);
      for (let j = 0; j < i; j++) ts.push(t1);
      let c = H.map((p) => p.slice());
      for (const t of ts) {
        const nx = [];
        for (let k = 0; k < c.length - 1; k++)
          nx.push(c[k].map((v, q) => v + (c[k + 1][q] - v) * t));
        c = nx;
      }
      out2.push(c[0]);
    }
    {
      const r = ratFromH(out2);
      if (seg._bez) r._bez = true;
      return withProv(r, seg, t0, t1);
    }
  }
  const n = seg.P.length - 1;
  let out;
  if (n <= 4) out = sliceControlPoints(seg.P, t0, t1);
  else {
    out = [];
    for (let i = 0; i <= n; i++) {
      const ts = [];
      for (let j = 0; j < n - i; j++) ts.push(t0);
      for (let j = 0; j < i; j++) ts.push(t1);
      out.push(blossom(seg.P, ts));
    }
  }
  // The ends of a slice at t = 0 / t = 1 ARE THE PARENT'S own POINTS, exactly. The lerp chain applies `a + (b - a) * 1`, which is
  // not `b` in floating point (30.741201302805756 against 30.74120130280576), so the last piece of a split cubic ended an ulp
  // from the point the next curve starts at. A joint that is not bit-equal is a gap to every exact test downstream: the whole
  // polynomial-paint certificate (core/polynomialPaint.js, `eq` at each joint) declined a 64-cubic star whose numbers were
  // perturbed by 6e-8, and the shape fell from one exact area paint to 158 decomposed cells.
  if (t0 === 0) out[0] = seg.P[0].slice();
  if (t1 === 1) out[n] = seg.P[n].slice();
  return withProv({ t: seg.t, cut: seg.cut, _bez: seg._bez, P: out }, seg, t0, t1);
}

function normalizeSourceMap(m) {
  if (!m.every(Number.isFinite)) return m;
  const largest = Math.max(...m.map(Math.abs));
  if (!(largest > 0)) return m;
  // A common power-of-two scale preserves the projective map and bounds
  // subsequent matrix products without adding another rounding division.
  const exponent = Math.max(-1022, Math.min(1023, Math.floor(Math.log2(largest))));
  const scale = 2 ** -exponent;
  return m.map((x) => x * scale);
}

/// PROVENANCE: which ORIGINAL curve a piece came from, over which parameter range.
///
/// A decomposition described as a sequence of decisions does not transfer between two poses of a
/// morph — a cut line derived from the same construction can miss the other pose's loop entirely,
/// and then the replay simply fails. Described parametrically it always transfers: slice the same
/// curve over the same range on the other pose and the combinatorial structure is identical by
/// construction, so the patches pair without anything having to succeed.
///
/// Composes through nesting, and holds outside [0,1] as well, because segSlice extrapolates by
/// the blossom — which is what lets a CURVED seam, itself a slice of an extension, reconstruct
/// the same way as any other piece.
export function withProv(out, seg, t0, t1) {
  // The parent's control points ride along. A slice lies on the same algebraic curve as the curve
  // it was cut from, so the parent's implicit describes it exactly -- and the parent's is often
  // very much cheaper. cubicKLMN is numerically marginal on a short slice (its control points
  // crowd together and the discriminant goes near-degenerate), so the slice falls to the Bezout
  // resultant: five terms instead of two, all four texels instead of three, and no room left for
  // the arc's bounding box, which is what lets a curve stop constraining off its own arc. On a
  // cubic ring, slices are what fall to Bezout, while the ORIGINAL cubics pack cheap.
  //
  // Only the geometry is carried, not a derived implicit: the packer re-derives under whatever
  // normalization the caller is using, and a frozen morph scale must not be inherited from a
  // different pose.
  const parentP = seg._srcP || (seg.t === 'cubic' && seg.P && seg.P.length === 4 ? seg.P : null);
  if (parentP) out._srcP = parentP;
  out[K_FROM] = seg;
  inheritCutImplicit(out, seg);
  const p = seg._src;
  if (!p) return out;
  if (!isRat(seg) && !p.map) {
    const at = (u) => p.a + (p.b - p.a) * u;
    out._src = { k: p.k, a: at(t0), b: at(t1) };
    return out;
  }
  // Normalizing a rational slice's endpoint weights reparameterizes it by a
  // Möbius map. Compose that map rather than interpolating source endpoints.
  const parent = normalizeSourceMap(p.map || [p.b - p.a, p.a, 0, 1]);
  const weightAt = (t) => (1 - t) * (1 - t) + 2 * (seg.w == null ? 1 : seg.w) * t * (1 - t) + t * t;
  const w0 = weightAt(t0),
    w2 = weightAt(t1);
  const ratio = isRat(seg)
    ? Math.sign(w0) === Math.sign(w2)
      ? Math.sqrt(Math.abs(w0)) / Math.sqrt(Math.abs(w2))
      : NaN
    : 1;
  const local = normalizeSourceMap(
    ratio > 1
      ? [t1 - t0 / ratio, t0 / ratio, 1 - 1 / ratio, 1 / ratio]
      : [t1 * ratio - t0, t0, ratio - 1, 1],
  );
  const composed = normalizeSourceMap([
    parent[0] * local[0] + parent[1] * local[2],
    parent[0] * local[1] + parent[1] * local[3],
    parent[2] * local[0] + parent[3] * local[2],
    parent[2] * local[1] + parent[3] * local[3],
  ]);
  const at = (u) => (composed[0] * u + composed[1]) / (composed[2] * u + composed[3]);
  out._src = { k: p.k, a: at(0), b: at(1), map: composed };
  return out;
}

/// de Casteljau, written out per degree. The generic loop below allocated one array per
/// level per call, and this is called from every row of every interior-point probe and every
/// crossing the cut search assembles -- the same lerps, in the same order, on scalars.
export function segPt(seg, t) {
  if (isRat(seg)) {
    const h = deCast(ratH(seg), t);
    return [h[0] / h[2], h[1] / h[2]];
  }
  const P = seg.P,
    n = P.length;
  if (n === 2) {
    const a = P[0],
      b = P[1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  if (n === 3) {
    const a = P[0],
      b = P[1],
      c = P[2];
    const x0 = a[0] + (b[0] - a[0]) * t,
      y0 = a[1] + (b[1] - a[1]) * t;
    const x1 = b[0] + (c[0] - b[0]) * t,
      y1 = b[1] + (c[1] - b[1]) * t;
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  }
  if (n === 4) {
    const a = P[0],
      b = P[1],
      c = P[2],
      d = P[3];
    const x0 = a[0] + (b[0] - a[0]) * t,
      y0 = a[1] + (b[1] - a[1]) * t;
    const x1 = b[0] + (c[0] - b[0]) * t,
      y1 = b[1] + (c[1] - b[1]) * t;
    const x2 = c[0] + (d[0] - c[0]) * t,
      y2 = c[1] + (d[1] - c[1]) * t;
    const u0 = x0 + (x1 - x0) * t,
      v0 = y0 + (y1 - y0) * t;
    const u1 = x1 + (x2 - x1) * t,
      v1 = y1 + (y2 - y1) * t;
    return [u0 + (u1 - u0) * t, v0 + (v1 - v0) * t];
  }
  let pts = P;
  while (pts.length > 1) {
    const nx = [];
    for (let i = 0; i < pts.length - 1; i++)
      nx.push([
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
      ]);
    pts = nx;
  }
  return pts[0];
}

/// Tangent direction at t. Falls forward through coincident control points so a
/// doubled endpoint (the degenerate family that dominates real fonts) still yields a
/// direction rather than (0,0).
export function segTangent(seg, t) {
  if (isRat(seg)) {
    const H = ratH(seg);
    const d = [];
    for (let i = 0; i < 2; i++) d.push(H[i + 1].map((v, k) => 2 * (v - H[i][k])));
    const p = deCast(H, t),
      dp = deCast(d, t);
    return [dp[0] * p[2] - p[0] * dp[2], dp[1] * p[2] - p[1] * dp[2]];
  }
  const P = seg.P,
    n = P.length - 1;

  let cScale = 0;
  for (let i = 0; i <= n; i++) {
    const ax = Math.abs(P[i][0]),
      ay = Math.abs(P[i][1]);
    if (ax > cScale) cScale = ax;
    if (ay > cScale) cScale = ay;
  }
  const vanish = 1e-12 * cScale;
  // Per-degree scalar form of the generic loop underneath: derivative polygon, then de
  // Casteljau on it. Same operations in the same order. The degenerate fallback (a vanishing
  // tangent) is rare and takes the generic path, which builds the polygon it scans.
  if (n === 1) {
    const vx = 1 * (P[1][0] - P[0][0]),
      vy = 1 * (P[1][1] - P[0][1]);
    if (!(Math.hypot(vx, vy) < vanish)) return [vx, vy];
  } else if (n === 2) {
    const d0x = 2 * (P[1][0] - P[0][0]),
      d0y = 2 * (P[1][1] - P[0][1]);
    const d1x = 2 * (P[2][0] - P[1][0]),
      d1y = 2 * (P[2][1] - P[1][1]);
    const vx = d0x + (d1x - d0x) * t,
      vy = d0y + (d1y - d0y) * t;
    if (!(Math.hypot(vx, vy) < vanish)) return [vx, vy];
  } else if (n === 3) {
    const d0x = 3 * (P[1][0] - P[0][0]),
      d0y = 3 * (P[1][1] - P[0][1]);
    const d1x = 3 * (P[2][0] - P[1][0]),
      d1y = 3 * (P[2][1] - P[1][1]);
    const d2x = 3 * (P[3][0] - P[2][0]),
      d2y = 3 * (P[3][1] - P[2][1]);
    const e0x = d0x + (d1x - d0x) * t,
      e0y = d0y + (d1y - d0y) * t;
    const e1x = d1x + (d2x - d1x) * t,
      e1y = d1y + (d2y - d1y) * t;
    const vx = e0x + (e1x - e0x) * t,
      vy = e0y + (e1y - e0y) * t;
    if (!(Math.hypot(vx, vy) < vanish)) return [vx, vy];
  }
  const d = [];
  for (let i = 0; i < n; i++) d.push([n * (P[i + 1][0] - P[i][0]), n * (P[i + 1][1] - P[i][1])]);
  let pts = d;
  while (pts.length > 1) {
    const nx = [];
    for (let i = 0; i < pts.length - 1; i++)
      nx.push([
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
      ]);
    pts = nx;
  }
  let v = pts[0];
  if (Math.hypot(v[0], v[1]) < vanish)
    for (const c of t < 0.5 ? d : d.slice().reverse())
      if (Math.hypot(c[0], c[1]) > vanish) {
        v = c;
        break;
      }
  return v;
}

/// TIGHT bounding box of the segment — endpoints plus the interior extrema of x(t) and y(t),
/// which are the roots of the derivative's Bernstein coefficients. Worth the roots: the
/// control-point box of a cubic with far-flung handles is enormously larger than the arc, and
/// the box is a real constraint of the primitive (a CPatch is bounded by its curves INSIDE a
/// box), not bookkeeping. A loose box both admits spurious claimed area and pays for shading
/// fragments the patch can never cover.
/// MEMOIZED. rowSpans asks for one per curve on every probe row -- 23 rows per frame, tens of
/// thousands of frames -- so the box is computed once per segment and read thousands of times.
/// A WeakMap, so a segment the search discards takes its entry with it.
/// MEMOS LIVE ON THE SEGMENT, under SYMBOL keys. A WeakMap lookup is a hash probe on every
/// call; a property read is a field load, and the converter reads these millions of times. A
/// symbol key keeps the memo out of structured clones (a worker posts patches back as their
/// curves) and out of JSON, and object spread copies it only onto a copy that shares the same
/// control points -- for which the memo is still right.
export const K_BB = Symbol('cp.bb');
export const K_IMPL = Symbol('cp.impl');
export const K_PK = Symbol('cp.packed');
export const K_FAR = Symbol('cp.far');
export const K_ID = Symbol('cp.id');
/// The segment a slice was cut from (set by segSlice), so a piece can inherit what was known
/// about its source -- the sign its implicit is read with, for one.
export const K_FROM = Symbol('cp.from');
export const K_ALONG = Symbol('cp.along');
export const K_ALONGP = Symbol('cp.alongPoly');
export const K_PAIR = Symbol('cp.pair');
let _nextSegId = 1;
/// A small integer identity for a segment object, minted on first use: what a per-pair memo
/// keys its Map on, since a Map keyed by a small integer is a fast path and a nested WeakMap
/// is two hash probes.
export function segId(seg) {
  let id = seg[K_ID];
  if (id === undefined) {
    id = _nextSegId++;
    seg[K_ID] = id;
  }
  return id;
}
export function segTightBBox(seg) {
  const hit = seg[K_BB];
  if (hit !== undefined) return hit;
  const bb = segTightBBoxOf(seg);
  seg[K_BB] = bb;
  return bb;
}
function segTightBBoxOf(seg) {
  // A rational segment's extrema are NOT the roots of its projected control polygon's
  // derivative, so the polynomial path below would return a box that can be too SMALL — and a
  // cover that clips the shape is worse than a loose one. The control-point box always
  // contains the curve (positive weights, convex-hull property), so use it.
  if (isRat(seg)) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const q of seg.P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    return [x0, y0, x1, y1];
  }
  const P = seg.P,
    n = P.length - 1;
  let x0 = Math.min(P[0][0], P[n][0]),
    x1 = Math.max(P[0][0], P[n][0]);
  let y0 = Math.min(P[0][1], P[n][1]),
    y1 = Math.max(P[0][1], P[n][1]);
  if (n >= 2)
    for (const ax of [0, 1]) {
      const d = [];
      for (let i = 0; i < n; i++) d.push(n * (P[i + 1][ax] - P[i][ax]));
      for (const t of bezRoots01(d)) {
        const v = segPt(seg, t)[ax];
        if (ax === 0) {
          if (v < x0) x0 = v;
          if (v > x1) x1 = v;
        } else {
          if (v < y0) y0 = v;
          if (v > y1) y1 = v;
        }
      }
    }
  return [x0, y0, x1, y1];
}

export const segStart = (seg) => seg.P[0];
export const segEnd = (seg) => seg.P[seg.P.length - 1];
export const segRev = (seg) => {
  // `w` MUST come along. A rational quadratic's weight is what makes it the arc it is, and a
  // reversed arc keeps it — dropping it silently turns the piece into a plain quadratic.
  const out = { t: seg.t, cut: seg.cut, _bez: seg._bez, P: seg.P.slice().reverse() };
  if (seg.w != null) out.w = seg.w;
  if (seg._src) {
    const p = seg._src;
    out._src = { k: p.k, a: p.b, b: p.a };
    if (p.map) {
      const m = p.map;
      out._src.map = normalizeSourceMap([-m[0], m[0] + m[1], -m[2], m[2] + m[3]]);
    }
  }
  inheritCutImplicit(out, seg);
  return out;
};

function inheritCutImplicit(out, seg) {
  if (!seg.cut || seg.nrm) return;
  if (seg[K_PK] === undefined) seg[K_PK] = segImplicitPacked(seg) || null;
  if (seg[K_IMPL] === undefined) seg[K_IMPL] = segImplicit(seg) || null;
  out[K_PK] = seg[K_PK];
  out[K_IMPL] = seg[K_IMPL];
}

// ---- scalar Bernstein algebra ---------------------------------------------------
const _binom = [[1]];
const _binomRecip = [[1]];
/// The binomial ROW, not a single coefficient. bezMul's inner loop wants C(m,i), C(n,j) and
/// 1/C(m+n,i+j), and looking each up through a function call — with the table-growth check
/// re-run every time — would cost about 5% of conversion on its own, for arithmetic that is a table.
function binomRow(n) {
  while (_binom.length <= n) {
    const prev = _binom[_binom.length - 1],
      row = [1];
    for (let i = 1; i < prev.length; i++) row.push(prev[i - 1] + prev[i]);
    row.push(1);
    _binom.push(row);
    _binomRecip.push(row.map((v) => 1 / v));
  }
  return _binom[n];
}
function binom(n, k) {
  return binomRow(n)[k];
}

const _mulW = [];
function mulWeights(m, n) {
  let row = _mulW[m];
  if (row === undefined) {
    row = [];
    _mulW[m] = row;
  }
  let w = row[n];
  if (w !== undefined) return w;
  const mn = m + n;
  binomRow(mn);
  const bm = _binom[m],
    bn = _binom[n],
    bmn = _binom[mn];
  w = new Float64Array((m + 1) * (n + 1));
  for (let i = 0; i <= m; i++)
    for (let j = 0; j <= n; j++) w[i * (n + 1) + j] = (bm[i] * bn[j]) / bmn[i + j];
  row[n] = w;
  return w;
}
export function bezMul(A, B) {
  const m = A.length - 1,
    n = B.length - 1,
    mn = m + n;
  const out = new Array(mn + 1).fill(0);
  const w = mulWeights(m, n),
    n1 = n + 1;
  for (let i = 0; i <= m; i++) {
    const ai = A[i],
      wi = i * n1;
    for (let j = 0; j <= n; j++) out[i + j] += w[wi + j] * ai * B[j];
  }
  return out;
}
/// A x [1, 1, ..., 1] (degree elevation by n through the product): the same accumulation with
/// B[j] = 1, so each term is (w * ai) * 1 -- the multiply by one is written out to keep the
/// operation sequence identical to the general product.
function bezMulOnes(A, n) {
  const m = A.length - 1,
    mn = m + n;
  const out = new Array(mn + 1).fill(0);
  const w = mulWeights(m, n),
    n1 = n + 1;
  for (let i = 0; i <= m; i++) {
    const ai = A[i],
      wi = i * n1;
    for (let j = 0; j <= n; j++) out[i + j] += w[wi + j] * ai * 1;
  }
  return out;
}

export function bezElevate(A, deg) {
  let c = A;
  while (c.length - 1 < deg) {
    const n = c.length - 1,
      out = [c[0]];
    for (let i = 1; i <= n; i++) out.push((i / (n + 1)) * c[i - 1] + (1 - i / (n + 1)) * c[i]);
    out.push(c[n]);
    c = out;
  }
  return c;
}

export function bezAdd(A, B) {
  const d = Math.max(A.length, B.length) - 1;
  const a = bezElevate(A, d),
    b = bezElevate(B, d);
  return a.map((v, i) => v + b[i]);
}

export function bezSplit(A, t) {
  // In-place de Casteljau: one scratch array, swept forward so c[i+1] is still the previous
  // level when it is read. The obvious version allocates a fresh array PER LEVEL, and with this
  // called from every subdivision node that is a fifth of conversion time plus most of the GC.
  const n = A.length;
  const c = A.slice(),
    left = new Array(n),
    right = new Array(n);
  let len = n,
    li = 0,
    ri = 0;
  left[li++] = c[0];
  right[ri++] = c[len - 1];
  while (len > 1) {
    for (let i = 0; i < len - 1; i++) c[i] += (c[i + 1] - c[i]) * t;
    len--;
    left[li++] = c[0];
    right[ri++] = c[len - 1];
  }
  right.reverse();
  return [left, right];
}

/// bezEval is bezSplit's in-place sweep read at its last level -- the same lerps in the same
/// order on a scratch row, with no left/right arrays built. Bit-identical to splitting.
const _evScratch = new Float64Array(64);
export function bezEval(A, t) {
  const n = A.length;
  if (n > 64) return bezSplit(A, t)[0][n - 1];
  const c = _evScratch;
  for (let i = 0; i < n; i++) c[i] = A[i];
  for (let len = n; len > 1; len--) for (let i = 0; i < len - 1; i++) c[i] += (c[i + 1] - c[i]) * t;
  return c[0];
}
/// The derivative's value at t, without building the derivative polygon: its Bernstein
/// coefficients are n*(A[i+1]-A[i]), written into the scratch row and swept the same way.
const _evScratch2 = new Float64Array(64);
function bezEvalDeriv(A, t) {
  const n = A.length - 1;
  if (n <= 0) return 0;
  if (n > 64) {
    const d = [];
    for (let i = 0; i < n; i++) d.push(n * (A[i + 1] - A[i]));
    return bezEval(d, t);
  }
  const c = _evScratch2;
  for (let i = 0; i < n; i++) c[i] = n * (A[i + 1] - A[i]);
  for (let len = n; len > 1; len--) for (let i = 0; i < len - 1; i++) c[i] += (c[i + 1] - c[i]) * t;
  return c[0];
}

const BM_W = 16,
  BM_FRAMES = 96;
const _bmRows = new Float64Array(BM_W * BM_FRAMES);
const _bmT0 = new Float64Array(BM_FRAMES),
  _bmT1 = new Float64Array(BM_FRAMES);
const _bmC = new Float64Array(BM_W);
export function bezMinAt(A, tol = 1e-12, sg = 1) {
  const n = A.length;
  if (n > BM_W) return bezMinAtGeneric(A, tol, sg);
  let best = A[0] * sg,
    bestT = 0;
  const last = n - 1;
  if (A[last] * sg < best) {
    best = A[last] * sg;
    bestT = 1;
  }
  const S = _bmRows,
    c = _bmC;
  for (let i = 0; i < n; i++) S[i] = A[i];
  _bmT0[0] = 0;
  _bmT1[0] = 1;
  let sp = 1;
  let guard = 8192;
  while (sp > 0 && guard-- > 0) {
    sp--;
    const base = sp * BM_W,
      t0 = _bmT0[sp],
      t1 = _bmT1[sp];
    let lo = Infinity;
    for (let i = 0; i < n; i++) {
      const w = S[base + i] * sg;
      if (w < lo) lo = w;
    }
    if (lo >= best - tol) continue; // hull bound: nothing better here
    const tm = (t0 + t1) / 2;
    if (t1 - t0 < 1e-8) {
      if (lo < best) {
        best = lo;
        bestT = tm;
      }
      continue;
    }
    if (sp + 2 > BM_FRAMES) return bezMinAtGeneric(A, tol, sg);
    // Split at 1/2: the popped row (at `base`, which is where the left child lands) is copied
    // to a scratch row and swept in place; left takes c[0] per level, right c[len-1] per level
    // in reverse -- exactly bezSplit's two outputs.
    const L = base,
      R = base + BM_W;
    for (let i = 0; i < n; i++) c[i] = S[base + i];
    let len = n,
      li = 0,
      ri = 0;
    S[L + li++] = c[0];
    S[R + (last - ri++)] = c[len - 1];
    while (len > 1) {
      for (let i = 0; i < len - 1; i++) c[i] += (c[i + 1] - c[i]) * 0.5;
      len--;
      S[L + li++] = c[0];
      S[R + (last - ri++)] = c[len - 1];
    }
    if (S[L + last] * sg < best) {
      best = S[L + last] * sg;
      bestT = tm;
    }
    _bmT0[sp] = t0;
    _bmT1[sp] = tm;
    _bmT0[sp + 1] = tm;
    _bmT1[sp + 1] = t1;
    sp += 2;
  }
  return { min: best, t: bestT };
}
function bezMinAtGeneric(A, tol, sg) {
  let best = A[0] * sg,
    bestT = 0;
  const last = A.length - 1;
  if (A[last] * sg < best) {
    best = A[last] * sg;
    bestT = 1;
  }
  const stack = [[A, 0, 1]];
  let guard = 8192;
  while (stack.length && guard-- > 0) {
    const [c, t0, t1] = stack.pop();
    let lo = Infinity;
    for (const v of c) {
      const w = v * sg;
      if (w < lo) lo = w;
    }
    if (lo >= best - tol) continue;
    const tm = (t0 + t1) / 2;
    if (t1 - t0 < 1e-8) {
      if (lo < best) {
        best = lo;
        bestT = tm;
      }
      continue;
    }
    const [l, r] = bezSplit(c, 0.5);
    if (l[last] * sg < best) {
      best = l[last] * sg;
      bestT = tm;
    }
    stack.push([l, t0, tm], [r, tm, t1]);
  }
  return { min: best, t: bestT };
}

/// Roots in (0,1). Subdivision with the sign-free hull test: a node whose coefficients
/// are all one sign PROVABLY has no root, so this enumerates every crossing instead of
/// finding whichever ones a sample grid happened to straddle.
/// Newton polish in the BERNSTEIN basis. Closed forms are derived in the power basis, which
/// loses accuracy when the conversion is ill-conditioned; two Newton steps against the
/// original coefficients put the root back where the hull says it is.
///
/// Reject Newton steps that increase the residual beyond the evaluation-roundoff allowance.
function polish(A, t) {
  // Against the coefficients' own magnitude. An implicit's values carry the coordinate scale
  // raised to its degree, so a fixed 1e-30 is a different statement about flatness for a glyph
  // than for a map, and Newton either polishes or does not depending on how big the art is.
  let _am = 0,
    _as = 0;
  for (let q = 0; q < A.length; q++) {
    const v = Math.abs(A[q]);
    _as += v;
    if (v > _am) _am = v;
  }
  const noise = 2 * (A.length - 1) * Number.EPSILON * _as;
  for (let k = 0; k < 2; k++) {
    if (!(t > 0 && t < 1)) return t;
    const f = bezEval(A, t);
    const df = bezEvalDeriv(A, t);
    if (!(Math.abs(df) > 1e-30 * _am)) return t;
    const nt = t - f / df;
    if (!(nt > 0 && nt < 1)) return t;
    const nf = Math.abs(bezEval(A, nt));
    if (nf > noise && nf > Math.abs(f)) return t;
    t = nt;
  }
  return t;
}

/// Closed form for degrees 1-3, which is where essentially all of this work lives: profiled
/// over a real conversion workload, 99.7% of bezRoots01 calls are degree 1, 2 or 3 and they
/// account for 95.5% of every subdivision node. Degree 1 matters most — subdivision would bisect a
/// LINEAR polynomial ~24 times to find a root that is one division.
///
/// Returns null when it declines, so the caller falls back to subdivision: a vanishing leading
/// coefficient is a lower-degree polynomial in disguise and the closed form for the nominal
/// degree would be ill-conditioned rather than merely slower.
function closedRoots(A0) {
  const nr = closedRootsInto(A0);
  return nr < 0 ? null : _cr.slice(0, nr);
}

// THE ROOTS COME BACK IN THESE, not in a fresh array. A conversion solves 1.56 million of these
// (45% degree 1, 44% degree 3), and allocating two short-lived arrays per solve -- the normalized
// coefficients and the result -- would put the garbage collector at a tenth of a profile. The
// arithmetic below is operation-for-operation what closedRoots and polyRoots' solveQuadratic /
// solveCubic do, so the roots are bit-identical; only the arrays are gone. Not reentrant, and
// need not be: the only caller consumes them before it solves anything else.
const _cr = [0, 0, 0];
const CR_EPS = 1e-9; // polyRoots' EPS, mirrored rather than imported so the tests read together

/// Roots of the degree-1..3 Bernstein polynomial A0 into _cr; returns how many, or -1 to
/// DECLINE (a vanishing leading coefficient), which sends the caller to subdivision.
function closedRootsInto(A0) {
  const n = A0.length - 1;

  if (n < 1 || n > 3) return -1;
  let scale = 1e-300;
  for (let i = 0; i <= n; i++) {
    const a = A0[i] < 0 ? -A0[i] : A0[i];
    if (a > scale) scale = a;
  }

  const a0 = A0[0] / scale,
    a1 = A0[1] / scale;
  const a2 = n >= 2 ? A0[2] / scale : 0,
    a3 = n >= 3 ? A0[3] / scale : 0;
  if (n === 1) {
    const d = a0 - a1;
    if (Math.abs(d) < 1e-14) return 0;
    _cr[0] = a0 / d;
    return 1;
  }
  // Bernstein -> power basis, then the closed form. Both restrict to real roots, which is all
  // this ever wants.
  if (n === 2) {
    const a = a0 - 2 * a1 + a2,
      b = 2 * (a1 - a0),
      c = a0;
    if (Math.abs(a) < 1e-14 && Math.abs(b) < 1e-14) return -1;
    return _quadInto(a, b, c);
  }
  const a = -a0 + 3 * a1 - 3 * a2 + a3;
  const b = 3 * a0 - 6 * a1 + 3 * a2;
  const c = -3 * a0 + 3 * a1,
    d = a0;
  if (Math.abs(a) < 1e-14 && Math.abs(b) < 1e-14 && Math.abs(c) < 1e-14) return -1;

  return _cubicInto(a, b, c, d);
}

/// A*t^2 + B*t + C into _cr, Citardauq-pivoted. polyRoots.solveQuadratic without the array.
function _quadInto(A, B, C) {
  if (Math.abs(A) < CR_EPS) {
    if (Math.abs(B) < CR_EPS) return 0;
    _cr[0] = -C / B;
    return 1;
  }
  const disc = B * B - 4 * A * C;
  if (disc < -CR_EPS) return 0;
  if (disc < CR_EPS) {
    _cr[0] = -B / (2 * A);
    return 1;
  }
  const sd = Math.sqrt(disc);
  const q = -0.5 * (B + Math.sign(B || 1) * sd);
  const r1 = q / A;
  const r2 = Math.abs(q) < CR_EPS ? r1 : C / q;
  _cr[0] = r1;
  _cr[1] = r2;
  return 2;
}

/// A*t^3 + B*t^2 + C*t + D into _cr, Cardano with the trigonometric branch. polyRoots.solveCubic
/// without the array.
function _cubicInto(A, B, C, D) {
  if (Math.abs(A) < CR_EPS) return _quadInto(B, C, D);
  const p = B / A,
    q = C / A,
    r = D / A;
  const P = q - (p * p) / 3;
  const Q = (2 * p * p * p) / 27 - (p * q) / 3 + r;
  const half = Q * 0.5;
  const disc = half * half + (P * P * P) / 27;
  const shift = p / 3;
  if (disc > CR_EPS) {
    const sd = Math.sqrt(disc);
    const u = Math.cbrt(-half + sd);
    const v = Math.cbrt(-half - sd);
    _cr[0] = u + v - shift;
    return 1;
  } else if (disc < -CR_EPS) {
    const rho = Math.sqrt((-P * P * P) / 27);
    const theta = Math.acos(Math.max(-1, Math.min(1, -half / rho)));
    const t = 2 * Math.cbrt(rho);
    _cr[0] = t * Math.cos(theta / 3) - shift;
    _cr[1] = t * Math.cos((theta + 2 * Math.PI) / 3) - shift;
    _cr[2] = t * Math.cos((theta + 4 * Math.PI) / 3) - shift;
    return 3;
  }
  const u = Math.cbrt(-half);
  _cr[0] = 2 * u - shift;
  _cr[1] = -u - shift;
  return 2;
}

export const _auditMismatch = [];
const AUDIT =
  typeof process !== 'undefined' && process.env && process.env.CPATCH_AUDIT_ROOTS === '1';

/// `out`, when given, receives the roots in place of a fresh array (the closed-form path only; the
/// subdivision path returns its own list). For a caller that consumes the roots at once.
export function bezRoots01(A, tol = 1e-9, out) {
  // Factor exact Bernstein endpoint zeros before solving, retaining the existing endpoint-band convention.
  const nA = A.length - 1;
  if (nA >= 1 && (A[0] === 0 || A[nA] === 0) && A.some((v) => v !== 0)) {
    let B = A,
      at0 = false,
      at1 = false;
    while (B.length > 1 && B[0] === 0) {
      at0 = true;
      const n = B.length - 1,
        g = new Array(n);
      for (let j = 0; j < n; j++) g[j] = (B[j + 1] * n) / (j + 1);
      B = g;
    }
    while (B.length > 1 && B[B.length - 1] === 0) {
      at1 = true;
      const n = B.length - 1,
        g = new Array(n);
      for (let i = 0; i < n; i++) g[i] = (B[i] * n) / (n - i);
      B = g;
    }
    const inner = B.length > 1 ? bezRoots01(B, tol) : [];
    const all = [];
    if (at0) all.push(2e-6);
    for (const t of inner) all.push(t);
    if (at1) all.push(1 - 2e-6);
    let ded;
    if (out) {
      out.length = 0;
      ded = out;
    } else ded = [];
    for (const t of all) if (!ded.length || t - ded[ded.length - 1] > 1e-5) ded.push(t);
    return ded;
  }
  // DIAGNOSTIC, one global read when unarmed. __CP_BEZCOUNT counts solves by degree;
  // __CP_PHASECOUNT (armed alongside it, carrying cpInScore) splits them into the search's
  // SPECULATIVE solving and the solving that decides an accepted patch -- which is how the
  // 73/27 split that motivated the row hint in framePatch is known.
  if (globalThis.__CP_BEZCOUNT) {
    const c = globalThis.__CP_BEZCOUNT;
    c[A.length - 1] = (c[A.length - 1] | 0) + 1;
    const p = globalThis.__CP_PHASECOUNT;
    if (p) {
      if (p.inScore()) p.score++;
      else p.other++;
    }
  }
  if (AUDIT) {
    const cf0 = closedRoots(A);
    if (cf0) {
      const ded = [];
      for (const r0 of cf0.slice().sort((x, y) => x - y)) {
        const t = polish(A, r0);
        if (t > 1e-7 && t < 1 - 1e-7 && (!ded.length || t - ded[ded.length - 1] > 1e-5))
          ded.push(t);
      }
      const sub = bezRootsSubdiv(A, tol);
      const bad = ded.length !== sub.length || ded.some((v, i) => Math.abs(v - sub[i]) > 1e-5);
      if (bad && _auditMismatch.length < 8)
        _auditMismatch.push({ deg: A.length - 1, A: A.slice(), closed: ded, subdiv: sub });
    }
  }
  const nr = closedRootsInto(A);
  if (nr >= 0) {
    // At most three roots, sitting in _cr: order them in place with the same comparisons.
    if (nr === 2) {
      if (_cr[1] < _cr[0]) {
        const q = _cr[0];
        _cr[0] = _cr[1];
        _cr[1] = q;
      }
    } else if (nr === 3) {
      if (_cr[1] < _cr[0]) {
        const q = _cr[0];
        _cr[0] = _cr[1];
        _cr[1] = q;
      }
      if (_cr[2] < _cr[1]) {
        const q = _cr[1];
        _cr[1] = _cr[2];
        _cr[2] = q;
        if (_cr[1] < _cr[0]) {
          const q2 = _cr[0];
          _cr[0] = _cr[1];
          _cr[1] = q2;
        }
      }
    }
    let ded;
    if (out) {
      out.length = 0;
      ded = out;
    } else ded = [];
    // Validate proposed roots against the original Bernstein polynomial. Residual
    // or nonzero-end sign-parity failures fall back to hull subdivision.
    let mag = 0;
    for (let q = 0; q < A.length; q++) mag += Math.abs(A[q]);
    const bar = 1e-4 * mag;
    let bad = false,
      inner = 0;
    for (let ri = 0; ri < nr; ri++) {
      let t = polish(A, _cr[ri]);
      if (!(t > -1e-6 && t < 1 + 1e-6)) continue;
      t = Math.min(Math.max(t, 2e-6), 1 - 2e-6);
      if (Math.abs(bezEval(A, t)) > bar) {
        bad = true;
        break;
      }
      if (!ded.length || t - ded[ded.length - 1] > 1e-5) {
        ded.push(t);
        if (t > 2e-6 && t < 1 - 2e-6) inner++;
      }
    }
    const a0 = A[0],
      an = A[A.length - 1];
    if (
      !bad &&
      Math.abs(a0) > bar &&
      Math.abs(an) > bar &&
      ded.length === inner &&
      (a0 < 0 !== an < 0) !== ((inner & 1) === 1)
    )
      bad = true;
    if (bad) {
      const sub = bezRootsSubdiv(A, tol);
      if (out) {
        out.length = 0;
        for (const t of sub) out.push(t);
        return out;
      }
      return sub;
    }
    return ded;
  }
  return bezRootsSubdiv(A, tol);
}

/// BEZIER CLIPPING (Sederberg & Nishita) for the degrees the closed forms decline — 4 and up,
/// which here means the composed implicits: f_i along seg_j is degree 3n, so a cubic implicit
/// along a cubic curve is degree NINE.
///
/// Bisection halves the interval each step, so it converges linearly and needs ~30 levels to
/// reach 1e-9. Clipping instead intersects the control polygon's CONVEX HULL with the t-axis
/// and discards everything outside — the hull property guarantees no root is lost — which
/// converges quadratically for a simple root. Only when a step fails to remove much of the
/// interval (the signature of two roots close together) does it fall back to splitting at the
/// midpoint, which is what keeps multiple roots from stalling it.

function bezRootsSubdiv(A, tol = 1e-9) {
  const out = [];
  const n = A.length - 1;
  const stack = [[A, 0, 1, 0]];
  let guard = 4096;
  // The tolerance is relative to the polynomial's own coefficients. `mn` and `mx` bound the
  // polynomial's VALUES, which scale with the artwork -- so an absolute tol decides "this interval
  // holds no root" differently on a small drawing and a large one, and the roots decide where
  // curves are split. This is why a contour scaled by an exact power of two -- lossless through
  // every add and multiply, so nothing but a comparison against a constant can move -- decomposed
  // into a different set of patches at x8 and the same one at x2 and x4.
  let aMag = 0;
  for (const v of A) {
    const a = Math.abs(v);
    if (a > aMag) aMag = a;
  }
  const tolA = tol * (aMag > 0 ? aMag : 1);
  while (stack.length && guard-- > 0) {
    const [c, t0, t1, d] = stack.pop();
    let mn = Infinity,
      mx = -Infinity;
    for (const v of c) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn > tolA || mx < -tolA) continue; // hull strictly off zero: no root
    if (t1 - t0 < 1e-9 || d > 60) {
      out.push((t0 + t1) / 2);
      continue;
    }

    // Convex hull of the control points (i/n, c_i), intersected with y = 0. Both bounding
    // chains are walked rather than the full hull: for this purpose the extreme crossings are
    // all that is needed, and they lie on the upper and lower chains.
    let lo = 1,
      hi = 0,
      any = false;
    for (let i = 0; i <= n; i++) {
      for (let j = i + 1; j <= n; j++) {
        const yi = c[i],
          yj = c[j];
        if (yi > 0 === yj > 0) continue;
        const xi = i / n,
          xj = j / n;
        const t = xi + (xj - xi) * (yi / (yi - yj));
        if (t < lo) lo = t;
        if (t > hi) hi = t;
        any = true;
      }
    }
    if (!any) continue; // hull does not reach the axis
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
    if (!(hi >= lo)) continue;

    const span = hi - lo;
    if (span > 0.8) {
      // Clip removed almost nothing — the classic sign of two nearby roots. Split instead, so
      // the pair separates rather than the clip spinning on the same interval.
      const [l, r] = bezSplit(c, 0.5),
        tm = (t0 + t1) / 2;
      stack.push([l, t0, tm, d + 1], [r, tm, t1, d + 1]);
      continue;
    }
    const nt0 = t0 + (t1 - t0) * lo,
      nt1 = t0 + (t1 - t0) * hi;
    if (!(nt1 - nt0 < t1 - t0 - 1e-15)) {
      out.push((t0 + t1) / 2);
      continue;
    }
    let seg = c;
    if (lo > 0) seg = bezSplit(seg, lo)[1];
    if (hi < 1) seg = bezSplit(seg, (hi - lo) / (1 - lo))[0];
    stack.push([seg, nt0, nt1, d + 1]);
  }
  out.sort((a, b) => a - b);
  const ded = [];
  for (const t of out)
    if (t > 1e-7 && t < 1 - 1e-7 && (!ded.length || t - ded[ded.length - 1] > 1e-5)) ded.push(t);
  return ded;
}

// ---- affine functionals and segment implicits -----------------------------------
// An affine functional is [a,b,c] meaning a·x + b·y + c.
export const affEval = (f, x, y) => f[0] * x + f[1] * y + f[2];

/// Fit the affine functional through three (point, value) pairs. Picks nothing — the
/// caller supplies a well-conditioned triangle.
/// A DETERMINANT IS TWICE AN AREA, so the test that it is nonzero must be relative to the SQUARE of
/// the triangle's own size or it means something different on every drawing. Written absolutely it
/// declined a well-formed triangle purely for being small, and the caller then fell through to the
/// collinear fallback -- a LINE standing in for a curve. At 1e-14 relative this is strictly more
/// permissive than bestTriple's own 1e-10, so a triple bestTriple accepted always builds here.
/// Read at call time, so a flag a pooled conversion forwards reaches the worker (which imports this
/// module before it applies the message's flags); likewise triEps below.
const detEps = () => mantleDebugHook('__CP_DET_EPS') || 1e-14;
const _triL2 = (p0, p1, p2) => {
  const a = (p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2;
  const b = (p2[0] - p0[0]) ** 2 + (p2[1] - p0[1]) ** 2;
  const c = (p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2;
  return Math.max(a, b, c);
};
function affFrom3(p0, v0, p1, v1, p2, v2) {
  const det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (!(Math.abs(det) > detEps() * _triL2(p0, p1, p2))) return null;
  const a = ((v1 - v0) * (p2[1] - p0[1]) - (v2 - v0) * (p1[1] - p0[1])) / det;
  const b = ((v2 - v0) * (p1[0] - p0[0]) - (v1 - v0) * (p2[0] - p0[0])) / det;
  return [a, b, v0 - a * p0[0] - b * p0[1]];
}

/// affFrom3 times its own determinant: the same affine functional, undivided.
///
/// f = u^2 - v*r is read for its SIGN and for f/|grad f|, and both are invariant under a positive
/// scale. Undividing every factor scales f by det^2 > 0, so nothing downstream can tell — but the
/// coefficients stop being rational in t and become degree 2, which is what a morph segment needs
/// to be reconstructed from static planes instead of repacked every frame.
function affFrom3U(p0, v0, p1, v1, p2, v2) {
  const det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (!(Math.abs(det) > detEps() * _triL2(p0, p1, p2))) return null; // see affFrom3
  const a = (v1 - v0) * (p2[1] - p0[1]) - (v2 - v0) * (p1[1] - p0[1]);
  const b = (v2 - v0) * (p1[0] - p0[0]) - (v1 - v0) * (p2[0] - p0[0]);
  return { f: [a, b, det * v0 - a * p0[0] - b * p0[1]], det };
}

const triEps = () => mantleDebugHook('__CP_TRI_EPS') || 1e-10;
function bestTriple(P) {
  let best = null,
    bestA = 0,
    L2 = 0;
  for (let i = 0; i < P.length; i++)
    for (let j = i + 1; j < P.length; j++) {
      const dx = P[j][0] - P[i][0],
        dy = P[j][1] - P[i][1];
      const d2 = dx * dx + dy * dy;
      if (d2 > L2) L2 = d2;
      for (let k = j + 1; k < P.length; k++) {
        const A = Math.abs(dx * (P[k][1] - P[i][1]) - (P[k][0] - P[i][0]) * dy);
        if (A > bestA) {
          bestA = A;
          best = [i, j, k];
        }
      }
    }
  return bestA > triEps() * L2 ? best : null;
}

/// The implicit of a bounding segment as a sum of products of affine functionals:
///   line  f = -l              (the paper's k=0, m=1 encoding — one linear term)
///   quad  f = u² - v          (Loop-Blinn's quadratic, u/v affine over the control triangle)
///   cubic f = k³ - l·m        (Loop-Blinn's integral cubic)
/// Returns { terms:[{c, fs:[aff…]}], deg } or null when the segment is degenerate.
/// `seg._bez` FORCES THE BEZOUT FORM for a cubic. klmn is the better classifier — its sign
/// follows the drawn arc, which is the whole reason Loop-Blinn uses it — but it is chosen by a
/// DISCRETE test on the cubic's type, and that test is not continuous as a morph deforms the
/// curve. A certificate has to reason about the same function the renderer evaluates, and only
/// the resultant is polynomial in the control points; so a morph decomposition asks for Bezout
/// and the converter cuts until the patches are valid under THAT function.
///
function collinearImplicit(P, nrm) {
  let ai = 0,
    bi = P.length - 1;
  let best = Math.hypot(P[bi][0] - P[ai][0], P[bi][1] - P[ai][1]);
  for (let i = 0; i < P.length; i++)
    for (let j = i + 1; j < P.length; j++) {
      const d = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]);
      if (d > best) {
        best = d;
        ai = i;
        bi = j;
      }
    }
  if (!(best > 0)) return null; // every control point is the same point: a zero divisor
  // FROZEN: the chord's endpoints and its length are both maxima, so both switch as the pose
  // moves. Held fixed across a morph segment they are linear in t, and so is the line.
  // The frozen pair must address this pose. cpair is captured when the segment is planned, and a
  // pose reaching here with fewer control points would index past the end -- P[bi] undefined, and
  // the next line reads [0] off it. The throw would be swallowed on the first frame of a morph and
  // CPatch would silently fall back to LB.
  //
  // Declining is the only sound answer: the frozen pair is what makes this line LINEAR IN t, which
  // is the whole certificate. Recomputing the maxima here would produce a line that is right for
  // this pose and wrong for the segment, which is a wrong picture rather than a slower one.
  if (nrm && nrm.cpair) {
    const a9 = nrm.cpair[0],
      b9 = nrm.cpair[1];
    if (!(a9 >= 0 && a9 < P.length && b9 >= 0 && b9 < P.length)) {
      globalThis.__CP_FROZEN_DECLINES = (globalThis.__CP_FROZEN_DECLINES | 0) + 1;
      return null;
    }
    ai = a9;
    bi = b9;
  }
  const A = P[ai],
    B = P[bi];
  const dx = B[0] - A[0],
    dy = B[1] - A[1];
  const len = nrm && nrm.clen > 0 ? nrm.clen : best;
  const nx = -dy / len,
    ny = dx / len;
  const off = -(nx * A[0] + ny * A[1]);

  for (const q of P) if (Math.abs(nx * q[0] + ny * q[1] + off) > 1e-9 * best) return null;
  return { terms: [{ c: -1, fs: [[nx, ny, off]] }], deg: 1 };
}

/// The conditioning constants segImplicit would DERIVE for this seg, captured so a later pose
/// can reuse them instead of deriving its own.
///
/// Every one of them is a max or a sum of absolute values — a chord length, a bounding scale, a
/// coefficient magnitude — chosen only to keep the arithmetic well-conditioned. Any positive
/// value is correct, but the value CHANGES with the pose, and dividing by something that kinks
/// is what makes a morphing curve's packed implicit fail to be a polynomial in t. Frozen for the
/// span of a morph segment, the same coefficients come out degree 2 in t exactly, which is what
/// lets a whole segment be reconstructed from three static planes instead of repacked per frame.
export function segNorm(seg) {
  const P = seg.P,
    nrm = {};
  if (seg.t === 'line') {
    const A = P[0],
      B = P[P.length - 1];
    nrm.len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    return nrm;
  }
  // The collinear fallback can be reached from any kind, so its chord is captured for any kind.
  let ai = 0,
    bi = P.length - 1;
  let best = Math.hypot(P[bi][0] - P[ai][0], P[bi][1] - P[ai][1]);
  for (let i = 0; i < P.length; i++)
    for (let j = i + 1; j < P.length; j++) {
      const d = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]);
      if (d > best) {
        best = d;
        ai = i;
        bi = j;
      }
    }
  nrm.clen = best;
  nrm.cpair = [ai, bi];
  if (P.length === 4) {
    const F = bezoutCubicImplicit(P);
    if (F && F.s > 0) {
      nrm.s = F.s;
      nrm.bscale = Math.abs(F.m22) + Math.abs(F.m12) + 1e-30;
    }
    nrm.kscale = cubicDScale(P);
  }
  return nrm;
}

export function segImplicit(seg) {
  const P = seg.P,
    nrm = seg.nrm;
  if (seg.t === 'line') {
    const A = P[0],
      B = P[P.length - 1];
    const dx = B[0] - A[0],
      dy = B[1] - A[1],
      L = Math.hypot(dx, dy);
    if (!(L > 0)) return null; // a zero divisor below, not a magnitude: L scales
    const len = nrm && nrm.len > 0 ? nrm.len : L;
    // DERIVED IN A CANONICAL ENDPOINT ORDER, so the two patches sharing a seam get bit-identical
    // coefficients and their signed distances are exact negatives.
    //
    const flip = B[0] < A[0] || (B[0] === A[0] && B[1] < A[1]);
    const S = flip ? B : A,
      E = flip ? A : B;
    const ex = E[0] - S[0],
      ey = E[1] - S[1];
    let nx = -ey / len,
      ny = ex / len,
      c = -(nx * S[0] + ny * S[1]);
    if (flip) {
      nx = -nx;
      ny = -ny;
      c = -c;
    }
    return { terms: [{ c: -1, fs: [[nx, ny, c]] }], deg: 1 };
  }
  if (seg.t === 'rquad') {
    // Loop-Blinn's RATIONAL quadratic: f = u^2 - v*r, with (u,v,r) affine and taking
    //   A -> (0, 0, 1)   M -> (1/2w, 0, 1/w)   B -> (1, 1, 1)
    // at the control points (weights 1, w, 1). Both terms have two factors, so the
    // homogenisation in implAlongSeg is uniform across them.
    const w = seg.w == null ? 1 : seg.w;
    if (!(w > 1e-9)) return null;
    const u = affFrom3(P[0], 0, P[1], 0.5 / w, P[2], 1);
    const v = affFrom3(P[0], 0, P[1], 0, P[2], 1);
    const r = affFrom3(P[0], 1, P[1], 1 / w, P[2], 1);
    if (!u || !v || !r) return collinearImplicit(P, nrm);
    return {
      terms: [
        { c: 1, fs: [u, u] },
        { c: -1, fs: [v, r] },
      ],
      deg: 2,
    };
  }
  if (seg.t === 'quad') {
    const tri = bestTriple(P);
    if (!tri) return collinearImplicit(P, nrm);
    const u = affFrom3(P[0], 0, P[1], 0.5, P[2], 1);
    const v = affFrom3(P[0], 0, P[1], 0, P[2], 1);
    if (!u || !v) return collinearImplicit(P, nrm);
    return {
      terms: [
        { c: 1, fs: [u, u] },
        { c: -1, fs: [v] },
      ],
      deg: 2,
    };
  }
  const q = cubicDegreeReduce(P);
  if (q) return segImplicit({ t: 'quad', P: [P[0], q, P[3]] }); // a cubic with C3 == 0 IS a quadratic
  if (seg._bez) return bezoutTerms(P, nrm);

  const klmn = cubicKLMN(P, nrm && nrm.kscale);
  if (klmn) {
    const tri = bestTriple(P);
    if (tri) {
      const [i, j, k] = tri;
      const mk = (ch) => affFrom3(P[i], ch[i], P[j], ch[j], P[k], ch[k]);
      const K = mk(klmn.k),
        L = mk(klmn.l),
        M = mk(klmn.m);
      if (K && L && M)
        return {
          terms: [
            { c: 1, fs: [K, K, K] },
            { c: -1, fs: [L, M] },
          ],
          deg: 3,
        };
    }
  }
  return bezoutTerms(P, nrm) || collinearImplicit(P, nrm); // cusp / loop / klmn declined
}

///
/// The 3x3 determinant expands to five products of AFFINE entries (m12 and m22 are constants),
/// which is precisely the shape the Bernstein composition needs:
///   det = m22*M00*M11 - m12^2*M00 - m22*M01^2 + 2*m12*M01*M02 - M11*M02^2
export function bezoutTerms(P, nrm) {
  const F = bezoutCubicImplicit(P, nrm && nrm.s);
  if (!F || !(F.s > 0)) return null;
  const un = (e) => [e.b / F.s, e.c / F.s, e.a - (e.b * F.cx + e.c * F.cy) / F.s];
  const M00 = un(F.m00),
    M01 = un(F.m01),
    M02 = un(F.m02);
  const M11 = un({ a: F.m11a, b: F.m02.b, c: F.m02.c });
  // A uniform positive factor over all five terms, so it cannot change the sign this implicit is
  // read for. Frozen across a morph segment it stops being a kink in t; see bezoutCubicImplicit.
  const scale = nrm && nrm.bscale > 0 ? nrm.bscale : Math.abs(F.m22) + Math.abs(F.m12) + 1e-30;
  return {
    terms: [
      { c: F.m22 / scale, fs: [M00, M11] },
      { c: (-F.m12 * F.m12) / scale, fs: [M00] },
      { c: -F.m22 / scale, fs: [M01, M01] },
      { c: (2 * F.m12) / scale, fs: [M01, M02] },
      { c: -1 / scale, fs: [M11, M02, M02] },
    ],
    deg: 3,
  };
}

/// Gradient of the implicit — the product rule over affine factors. Used to convert an
/// implicit VALUE into a PIXEL DEPTH: f is not a distance, and the klmn cubic implicit runs
/// ~4 orders of magnitude smaller than the line implicit on the same geometry, so a raw
/// epsilon on f means something different for every curve type. f/|grad f| is comparable.
const _gradVals = new Float64Array(8);
export function implGrad(impl, x, y) {
  let gx = 0,
    gy = 0;
  const terms = impl.terms,
    vals = _gradVals;
  for (let k = 0; k < terms.length; k++) {
    const term = terms[k],
      fs = term.fs,
      nf = fs.length;
    for (let i = 0; i < nf; i++) {
      const f = fs[i];
      vals[i] = f[0] * x + f[1] * y + f[2];
    }
    for (let i = 0; i < nf; i++) {
      let p = term.c;
      for (let j = 0; j < nf; j++) if (j !== i) p *= vals[j];
      gx += p * fs[i][0];
      gy += p * fs[i][1];
    }
  }
  return [gx, gy];
}

export function implHess(impl, x, y) {
  let hxx = 0,
    hxy = 0,
    hyy = 0;
  const terms = impl.terms,
    vals = _gradVals;
  for (let k = 0; k < terms.length; k++) {
    const term = terms[k],
      fs = term.fs,
      nf = fs.length;
    for (let i = 0; i < nf; i++) {
      const f = fs[i];
      vals[i] = f[0] * x + f[1] * y + f[2];
    }
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < nf; j++) {
        if (j === i) continue;
        let p = term.c;
        for (let m = 0; m < nf; m++) if (m !== i && m !== j) p *= vals[m];
        hxx += p * fs[i][0] * fs[j][0];
        hxy += p * fs[i][0] * fs[j][1];
        hyy += p * fs[i][1] * fs[j][1];
      }
    }
  }
  return [hxx, hxy, hyy];
}

/// PACKED form: every implicit here is a sum of products of AFFINE functionals, so one fixed
/// layout covers all four curve types and the fragment shader needs one dispatch instead of a
/// per-type derivation. Four affines and two scalars, with a kind tag:
///
///   CPK_LINE  0  f = A0                       (also the CUT seam, kind 2, drawn hard)
///   CPK_QUAD  1  f = A0^2 - A1                (Loop-Blinn u^2 - v)
///   CPK_KLMN  3  f = A0^3 - A1*A2             (Loop-Blinn k^3 - l*m)
///   CPK_BEZ   4  f = C1*A0*A3 - C0^2*A0 - C1*A1^2 + 2*C0*A1*A2 - A3*A2^2
///                  with A0..A3 = M00, M01, M02, M11 and C0, C1 = m12, m22
///
/// This also moves the quadratic's (u,v) solve to conversion time, so the shader does not invert a
/// control-triangle barycentric per fragment to recover coefficients that are constant per
/// curve.
export const CPK_LINE = 0,
  CPK_QUAD = 1,
  CPK_CUT = 2,
  CPK_KLMN = 3,
  CPK_BEZ = 4,
  CPK_RQUAD = 5;

const packLine = (impl) => ({
  kind: CPK_LINE,
  a: [impl.terms[0].fs[0].map((v) => -v), [0, 0, 0], [0, 0, 0], [0, 0, 0]],
  c: [0, 0],
});

function bezoutOriginP(P) {
  const b0 = P[0],
    b1 = P[1],
    b2 = P[2],
    b3 = P[3];
  const c1x = 3 * (b1[0] - b0[0]),
    c1y = 3 * (b1[1] - b0[1]);
  const c2x = 3 * (b0[0] - 2 * b1[0] + b2[0]),
    c2y = 3 * (b0[1] - 2 * b1[1] + b2[1]);
  const c3x = -b0[0] + 3 * b1[0] - 3 * b2[0] + b3[0],
    c3y = -b0[1] + 3 * b1[1] - 3 * b2[1] + b3[1];
  const d1 = c2x * c3y - c2y * c3x,
    d2 = c3x * c1y - c3y * c1x;
  // d1 = 0 puts the double point at infinity along the sign of d2 (+-Infinity clamps to that end);
  // d1 = d2 = 0 has no center at all (NaN), and P0 is as good an origin as any.
  const tau = d2 / (2 * d1);
  if (!(tau > 0)) return P;
  if (tau >= 1) return [b3, b2, b1, b0];
  return sliceControlPoints(P, tau, tau < 0.5 ? 1 : 0);
}

const K_SOURCE_PACK = Symbol('cp.sourcePack'),
  K_SOURCE_PACK_BEZ = Symbol('cp.sourcePackBez');
export function segImplicitPacked(seg) {
  const Z = [0, 0, 0];
  const P = seg.P;
  if (seg.t === 'line') {
    const impl = segImplicit(seg);
    if (!impl) return null;
    return packLine(impl);
  }
  if (seg.t === 'quad') {
    // UNDIVIDED, for a morph. u^2 - v is the one form whose two terms carry different powers of
    // the determinant, so undividing it is not a uniform scale — v has to absorb the det the
    // squared term keeps. Written as the rational-quadratic kernel with r = det (a constant
    // functional), that is exactly u^2 - v*r, which the shader already evaluates.
    if (seg.nrm && bestTriple(P)) {
      const U = affFrom3U(P[0], 0, P[1], 0.5, P[2], 1),
        V = affFrom3U(P[0], 0, P[1], 0, P[2], 1);
      if (U && V) return { kind: CPK_RQUAD, a: [U.f, V.f, [0, 0, U.det], Z], c: [0, 0] };
    }
    const impl = segImplicit(seg);
    if (!impl) return null;
    if (impl.deg === 1) return packLine(impl);
    if (impl.terms.length !== 2) return null;
    return { kind: CPK_QUAD, a: [impl.terms[0].fs[0], impl.terms[1].fs[0], Z, Z], c: [0, 0] };
  }
  if (seg.t === 'rquad') {
    // All three factors share one determinant, so undividing scales f by det^2 and nothing else.
    const w = seg.w == null ? 1 : seg.w;
    if (seg.nrm && w > 1e-9) {
      const U = affFrom3U(P[0], 0, P[1], 0.5 / w, P[2], 1),
        V = affFrom3U(P[0], 0, P[1], 0, P[2], 1),
        Rr = affFrom3U(P[0], 1, P[1], 1 / w, P[2], 1);
      if (U && V && Rr) return { kind: CPK_RQUAD, a: [U.f, V.f, Rr.f, Z], c: [0, 0] };
    }
    const impl = segImplicit(seg);
    if (!impl) return null;
    if (impl.deg === 1) return packLine(impl);
    // f = u^2 - v*r shares the shape of the klmn cubic one degree down, so the kernel reuses
    // the same three affine slots.
    return {
      kind: CPK_RQUAD,
      a: [impl.terms[0].fs[0], impl.terms[1].fs[0], impl.terms[1].fs[1], Z],
      c: [0, 0],
    };
  }
  // Static slices use one source representation in both conversion and packing.
  // Re-deriving a short slice can select a different, poorly conditioned KLMN
  // form even when conversion validated the source's implicit. Morphs instead
  // retain each piece's frozen normalization.
  if (!seg.nrm && seg._srcP && seg._srcP !== P) {
    const source = seg._srcP,
      key = seg._bez ? K_SOURCE_PACK_BEZ : K_SOURCE_PACK;
    let parent = source[key];
    if (parent === undefined) {
      parent = segImplicitPacked({ t: 'cubic', P: source, _bez: seg._bez }) || null;
      source[key] = parent;
    }
    if (parent && (parent.kind === CPK_KLMN || parent.kind === CPK_BEZ)) return parent;
  }
  const q = cubicDegreeReduce(P);
  if (q) return segImplicitPacked({ t: 'quad', P: [P[0], q, P[3]], nrm: seg.nrm });
  const impl = segImplicit(seg);
  if (!impl) return null;
  if (impl.deg === 1) return packLine(impl); // a cubic drawn along a straight line
  // A klmn implicit is two terms (k^3 and l*m); the Bezout resultant is five. The term count
  // is the discriminator because segImplicit already fell back to Bezout when cubicKLMN
  // declined — re-deriving that decision here would be a second place for it to drift.
  if (impl.terms.length === 2) {
    return {
      kind: CPK_KLMN,
      a: [impl.terms[0].fs[0], impl.terms[1].fs[0], impl.terms[1].fs[1], Z],
      c: [0, 0],
    };
  }

  // Under a morph normalization the origin stays at P0: a pose-dependent origin would make the
  // packed coefficients stop being polynomials in the morph's t, the same kink the frozen s removes.
  const F = bezoutCubicImplicit(seg.nrm ? P : bezoutOriginP(P), seg.nrm && seg.nrm.s);
  if (!F || !(F.s > 0)) return null;
  const un = (e) => [e.b / F.s, e.c / F.s, e.a - (e.b * F.cx + e.c * F.cy) / F.s];

  return {
    kind: CPK_BEZ,
    a: [un(F.m00), un(F.m01), un(F.m02), un({ a: F.m11a, b: F.m02.b, c: F.m02.c })],
    c: [F.m12, F.m22],
  };
}

/// Evaluate the packed form. MUST match the fragment shader term for term — the orientation
/// sign is derived from this, and a sign taken from differently-ordered algebra flips a curve
/// and clips the patch silently.
/// The packed form as the GPU will evaluate it: coefficients rounded to float32 the way the texture
/// stores them, and every operation rounded the way the shader performs it. Mirrors CP_EVAL in
/// _cpatchCoverage.glsl term for term.
///
const _F = Math.fround;
export function packedEvalF32(pk, x0, y0) {
  const a = pk.a,
    k = pk.kind;
  const x = _F(x0),
    y = _F(y0);
  const aff = (r) => _F(_F(_F(_F(a[r][0]) * x) + _F(_F(a[r][1]) * y)) + _F(a[r][2]));
  const A0 = aff(0);
  if (k === CPK_LINE || k === CPK_CUT) return A0;
  const A1 = aff(1);
  if (k === CPK_QUAD) return _F(_F(A0 * A0) - A1);
  const A2 = aff(2);
  if (k === CPK_RQUAD) return _F(_F(A0 * A0) - _F(A1 * A2));
  if (k === CPK_KLMN) return _F(_F(_F(A0 * A0) * A0) - _F(A1 * A2));
  const A3 = aff(3);
  const C0 = _F(pk.c[0]),
    C1 = _F(pk.c[1]);
  const t1 = _F(_F(C1 * A0) * A3);
  const t2 = _F(_F(C0 * C0) * A0);
  const t3 = _F(C1 * _F(A1 * A1));
  const t4 = _F(_F(_F(2 * C0) * A1) * A2);
  const t5 = _F(A3 * _F(A2 * A2));
  return _F(_F(_F(_F(t1 - t2) - t3) + t4) - t5);
}

export function packedEval(pk, x, y) {
  const e = (f) => f[0] * x + f[1] * y + f[2];
  const A0 = e(pk.a[0]);
  if (pk.kind === CPK_LINE || pk.kind === CPK_CUT) return A0;
  const A1 = e(pk.a[1]);
  if (pk.kind === CPK_QUAD) return A0 * A0 - A1;
  const A2 = e(pk.a[2]);
  if (pk.kind === CPK_RQUAD) return A0 * A0 - A1 * A2;
  if (pk.kind === CPK_KLMN) return A0 * A0 * A0 - A1 * A2;
  const A3 = e(pk.a[3]),
    C0 = pk.c[0],
    C1 = pk.c[1];
  return C1 * A0 * A3 - C0 * C0 * A0 - C1 * A1 * A1 + 2.0 * C0 * A1 * A2 - A3 * A2 * A2;
}

export function implEval(impl, x, y) {
  let s = 0;
  for (const t of impl.terms) {
    let p = t.c;
    for (const f of t.fs) p *= affEval(f, x, y);
    s += p;
  }
  return s;
}

/// The magnitude implEval's sum is formed from at (x, y), before its terms cancel: every term and
/// every affine factor taken in absolute value, products and sums alike. A value within a small
/// multiple of rounding of this is zero to the precision the implicit can be evaluated at.
export function implMagAt(impl, x, y) {
  const ax = Math.abs(x),
    ay = Math.abs(y);
  let s = 0;
  for (const t of impl.terms) {
    let p = Math.abs(t.c);
    for (const f of t.fs) p *= Math.abs(f[0]) * ax + Math.abs(f[1]) * ay + Math.abs(f[2]);
    s += p;
  }
  return s;
}

export function implAlongSeg(impl, seg) {
  // Terms can hold different numbers of affine factors (k^3 has three, l*m two). Over a
  // POLYNOMIAL segment that is harmless. Over a RATIONAL one each factor carries a 1/W, so
  // terms of different degree are divided by different powers and adding them directly is
  // simply the wrong function. Multiply every term up to the largest factor count with
  // W^(maxk-k): W > 0 for positive weights, so this scales f by a positive amount and leaves
  // every root and every sign exactly where it was.
  const terms = impl.terms;
  let maxk = 0;
  for (let k = 0; k < terms.length; k++) if (terms[k].fs.length > maxk) maxk = terms[k].fs.length;
  // A polynomial segment's weight row is all ones, and the elevation it stands for has its own
  // loop below; only a rational segment carries a real weight polynomial.
  const W = isRat(seg) ? wBez(seg) : null;
  // ONE COMPOSITION PER FUNCTIONAL, not one per occurrence: k^3 - lm names k three times, and
  // running affBez for each mention would repeat it. Unlike the weight multiply below -- which over a
  // POLYNOMIAL segment is not identity but DEGREE ELEVATION, and is load-bearing, since terms of
  // unequal degree cannot be added in the Bernstein basis -- this shares an identical array.
  // Two parallel arrays, not a Map: an implicit names at most a handful of functionals, and a
  // linear scan over five entries is cheaper than a hash on every mention.
  const lf = [],
    lv = [];
  const lift = (f) => {
    for (let i = 0; i < lf.length; i++) if (lf[i] === f) return lv[i];
    const v = affBez(f, seg);
    lf.push(f);
    lv.push(v);
    return v;
  };
  let acc = null;
  for (let k = 0; k < terms.length; k++) {
    const term = terms[k],
      fs = term.fs,
      c = term.c;
    let prod;
    if (!fs.length) prod = [c];
    else {
      // [c] x B, written out. bezMul with a degree-0 left operand forms
      // (1 * C(n,j) / C(n,j)) * c * B[j] and accumulates it onto 0; the leading ratio is
      // exactly 1, so this is the same value per coefficient without the general loop.
      const B0 = lift(fs[0]);
      prod = new Array(B0.length);
      for (let j = 0; j < B0.length; j++) prod[j] = 0 + c * B0[j];
      for (let q = 1; q < fs.length; q++) prod = bezMul(prod, lift(fs[q]));
    }
    //
    // Elevating through bezAdd and multiplying through by the weight reach the same polynomial
    // by different roundings, and this converter decides patch validity on signs that live in
    // those last bits -- the file is full of places where a value near zero decides whether a
    // patch is clean or leaks. Keep the multiply.
    if (W === null)
      for (let i = fs.length; i < maxk; i++) prod = bezMulOnes(prod, seg.P.length - 1);
    else for (let i = fs.length; i < maxk; i++) prod = bezMul(prod, W);
    acc = acc ? bezAdd(acc, prod) : prod;
  }
  return acc;
}

/// Crossings of the affine functional h with a segment — the cut predicate. h∘seg has
/// Bernstein coefficients h(P_i) directly, no composition needed.
///
/// Snap affine coefficients within eight float64 epsilons of their term magnitudes
/// to zero, avoiding cancellation-induced crossings beside construction endpoints.
const AFF_ZERO = 8 * Number.EPSILON;
function affBezOnLine(h, seg) {
  const out = affBez(h, seg);
  const rat = isRat(seg),
    pts = rat ? ratH(seg) : seg.P;
  const a = Math.abs(h[0]),
    b = Math.abs(h[1]),
    c = Math.abs(h[2]);
  for (let i = 0; i < out.length; i++) {
    const p = pts[i],
      m = a * Math.abs(p[0]) + b * Math.abs(p[1]) + c * (rat ? Math.abs(p[2]) : 1);
    if (Math.abs(out[i]) <= AFF_ZERO * m) out[i] = 0;
  }
  return out;
}
export const affRootsOnSeg = (h, seg) => bezRoots01(affBezOnLine(h, seg));

/// A proof that an implicit keeps one sign along a segment, from the control points alone.
///
/// Each affine functional of the implicit takes its extremes over the control polygon at the
/// control points (it is affine, and the segment lies in the polygon's hull), so a product of
/// functionals is bounded by the interval product of those ranges, and the implicit -- a sum of
/// such products -- by their sum. Every Bernstein coefficient of the exact composition lies
/// inside this bound, so when the bound clears zero the composed hull test would too, and the
/// composition need not be formed. Three dot products per functional against a degree-nine
/// Bernstein product. Writes [_hLo, _hHi]; the sign convention is the composition's own
/// (rational segments: the numerator, with the positive weight's range folded in).
///
/// Also writes the TERMS' own MAGNITUDE, Σ max|term| over the hull: what the composition's
/// coefficients are formed from before the terms cancel, and so the scale of its rounding.
let _hLo = 0,
  _hHi = 0,
  _hMag = 0;
export function implHullRange(impl, seg) {
  const rat = isRat(seg);
  const pts = rat ? ratH(seg) : seg.P;
  const n = pts.length;
  let wlo = 1,
    whi = 1;
  if (rat) {
    wlo = Infinity;
    whi = -Infinity;
    for (let i = 0; i < n; i++) {
      const w = pts[i][2];
      if (w < wlo) wlo = w;
      if (w > whi) whi = w;
    }
  }
  const terms = impl.terms;
  let maxk = 0;
  for (let k = 0; k < terms.length; k++) if (terms[k].fs.length > maxk) maxk = terms[k].fs.length;
  let lo = 0,
    hi = 0,
    mag = 0;
  for (let k = 0; k < terms.length; k++) {
    const term = terms[k],
      fs = term.fs;
    let tlo = term.c,
      thi = term.c;
    for (let q = 0; q < fs.length; q++) {
      const f = fs[q];
      let fmin = Infinity,
        fmax = -Infinity;
      if (rat)
        for (let i = 0; i < n; i++) {
          const p = pts[i],
            v = f[0] * p[0] + f[1] * p[1] + f[2] * p[2];
          if (v < fmin) fmin = v;
          if (v > fmax) fmax = v;
        }
      else
        for (let i = 0; i < n; i++) {
          const p = pts[i],
            v = f[0] * p[0] + f[1] * p[1] + f[2];
          if (v < fmin) fmin = v;
          if (v > fmax) fmax = v;
        }
      const v0 = tlo * fmin,
        v1 = tlo * fmax,
        v2 = thi * fmin,
        v3 = thi * fmax;
      tlo = Math.min(v0, v1, v2, v3);
      thi = Math.max(v0, v1, v2, v3);
    }
    for (let q = fs.length; q < maxk; q++) {
      const v0 = tlo * wlo,
        v1 = tlo * whi,
        v2 = thi * wlo,
        v3 = thi * whi;
      tlo = Math.min(v0, v1, v2, v3);
      thi = Math.max(v0, v1, v2, v3);
    }
    lo += tlo;
    hi += thi;
    mag += Math.max(-tlo, thi, tlo, -thi);
  }
  _hLo = lo;
  _hHi = hi;
  _hMag = mag;
}
export const implHullLo = () => _hLo;
export const implHullHi = () => _hHi;
export const implHullMag = () => _hMag;

/// h composed with the segment, as a scalar Bezier. For a polynomial Bezier the coefficients
/// are h at the control points; for a RATIONAL one they are h applied to the HOMOGENEOUS
/// control points — h(seg(t)) = H(t)/W(t), and W > 0, so H alone carries every root and the
/// sign. Same trick, one component wider.
export function affBez(h, seg) {
  if (isRat(seg)) return ratH(seg).map((q) => h[0] * q[0] + h[1] * q[1] + h[2] * q[2]);
  const P = seg.P,
    n = P.length,
    out = new Array(n);
  const a = h[0],
    b = h[1],
    c = h[2];
  for (let i = 0; i < n; i++) {
    const p = P[i];
    out[i] = a * p[0] + b * p[1] + c;
  }
  return out;
}

/// The homogeneous weight as a scalar Bezier (all ones for a polynomial segment). The
/// all-ones rows are shared constants: bezMul only ever reads its operands.
const _ONES = [[1], [1, 1], [1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1, 1]];
export const wBez = (seg) =>
  isRat(seg)
    ? ratH(seg).map((q) => q[2])
    : seg.P.length < _ONES.length
      ? _ONES[seg.P.length - 1]
      : seg.P.map(() => 1);

// ---- exact extension domain -------------------------------------------------------------
/// Bernstein coefficients over [0,1] to power-basis coefficients, c[k] the coefficient of u^k.
///
/// The Bezier's polynomial does not stop at its endpoints; the power form is the same curve read
/// over the whole real line, which is what an EXTENSION is.
export function bernToPower(b) {
  const n = b.length - 1,
    c = new Array(n + 1).fill(0);
  for (let k = 0; k <= n; k++) {
    let s = 0;
    for (let i = 0; i <= k; i++) s += ((k - i) & 1 ? -1 : 1) * binom(k, i) * b[i];
    c[k] = binom(n, k) * s;
  }
  return c;
}

const polyEvalPow = (c, u) => {
  let v = 0;
  for (let i = c.length - 1; i >= 0; i--) v = v * u + c[i];
  return v;
};
// One array, not two: slice().map() built an intermediate of the same length on every call, and
// this is inside polyRealRoots' recursion.
const polyDerivPow = (c) => {
  const n = c.length - 1,
    out = new Array(n > 0 ? n : 0);
  for (let i = 0; i < n; i++) out[i] = c[i + 1] * (i + 1);
  return out;
};
const polyMulPow = (a, b) => {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
};
const polyTrim = (c) => {
  let m = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i] < 0 ? -c[i] : c[i];
    if (a > m) m = a;
  }
  let n = c.length - 1;
  while (n > 0 && Math.abs(c[n]) <= 1e-13 * m) n--;
  return n + 1 === c.length ? c : c.slice(0, n + 1); // nothing trimmed: no copy
};

/// Every real root, by recursive isolation on the derivative.
///
/// The derivative's roots split the line into intervals the polynomial is MONOTONE on, so each
/// holds at most one root and a sign change locates it exactly. Degree here never exceeds four —
/// a rational quadratic's numerator times its weight — and the recursion bottoms out at the
/// linear case, so no closed form or companion matrix is needed.
export function polyRealRoots(c0) {
  return rootsTrimmed(polyTrim(c0));
}

/// The same solver, for callers that already hold a TRIMMED polynomial -- which is most of them:
/// nonNegSet trims and then hands the same array here, and the recursion below trims a
/// DERIVATIVE, whose leading coefficient is n*c[n] and so is non-zero whenever its parent was
/// trimmed. Together that is about two thirds of 1.87M calls with nothing to find.
///
/// The saving is a few percent of a conversion, less than a CPU profile suggests: polyTrim shows a
/// high self time, but self time on a small hot function that V8 inlines is not a measurement --
/// an A/B is.
export function rootsTrimmed(c) {
  if (globalThis.__CP_ISOCOUNT) globalThis.__CP_ISOCOUNT.n++; // diagnostic: power-basis isolations
  const n = c.length - 1;
  if (n <= 0) return [];
  // AN exact ZERO CONSTANT TERM IS A ROOT AT ZERO, factored out rather than searched for. A
  // composition of one curve's implicit along another that shares its endpoint vanishes there
  // exactly (the endpoint is a control point, and the functional at it is the coefficient), and
  // with higher contact the first few coefficients vanish together: x^3 times a quadratic is
  // the shape of the cases that run the refinement to its iteration cap, a triple root being
  // the one thing an interpolating method cannot converge on quickly. Dividing by x is exact.
  if (c[0] === 0) {
    let m = 1;
    while (m < n && c[m] === 0) m++;
    if (m >= n) return [0];
    const rest = rootsTrimmed(c.slice(m));
    rest.push(0);
    return rest;
  }
  if (n === 1) return [-c[0] / c[1]];
  // Closed forms for quadratic and cubic. The isolation below is general and costs a recursion
  // on the derivative plus ~52 bisections per bracket, each a Horner evaluation — the single
  // largest cost in a conversion if used here. Degree here never exceeds four and is nearly always two
  // or three, so those two get solved outright.
  //
  if (n === 2) {
    const a = c[2],
      b = c[1],
      cc = c[0];
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return [];
    if (disc === 0) return [-b / (2 * a)];
    // The stable pairing: forming both roots from the same subtraction loses the small one.
    const sq = Math.sqrt(disc),
      q = -0.5 * (b + (b < 0 ? -sq : sq));
    return q === 0 ? [0] : [q / a, cc / q];
  }
  if (n === 3) {
    const a = c[3],
      b = c[2] / a,
      cc = c[1] / a,
      d = c[0] / a;
    const p = cc - (b * b) / 3,
      q = (2 * b * b * b) / 27 - (b * cc) / 3 + d;
    const sh = -b / 3,
      disc = (q * q) / 4 + (p * p * p) / 27;
    if (disc > 0) {
      // one real root
      const sd = Math.sqrt(disc);
      const u = Math.cbrt(-q / 2 + sd),
        v2 = Math.cbrt(-q / 2 - sd);
      return [u + v2 + sh];
    }
    if (disc === 0) {
      const u = Math.cbrt(-q / 2);
      return q === 0 ? [sh] : [2 * u + sh, -u + sh];
    }
    // Three real roots: the trigonometric form, which needs no complex arithmetic.
    const r = Math.sqrt((-p * p * p) / 27),
      phi = Math.acos(Math.max(-1, Math.min(1, -q / (2 * r))));
    const t = 2 * Math.sqrt(-p / 3);
    return [
      t * Math.cos(phi / 3) + sh,
      t * Math.cos((phi + 2 * Math.PI) / 3) + sh,
      t * Math.cos((phi + 4 * Math.PI) / 3) + sh,
    ];
  }
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(c[i]));
  const R = 1 + m / Math.abs(c[n]); // Cauchy: every real root is inside
  // One array. filter + sort + spread built three, per node of the recursion.
  const dr = rootsTrimmed(polyDerivPow(c)); // a trimmed polynomial's derivative is trimmed
  const pts = [-R];
  for (let i = 0; i < dr.length; i++) if (dr[i] > -R && dr[i] < R) pts.push(dr[i]);
  pts.sort((a, b) => a - b);
  pts.push(R);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    let a = pts[i],
      b = pts[i + 1];
    const fa = polyEvalPow(c, a),
      fb = polyEvalPow(c, b);
    if (fa === 0) {
      out.push(a);
      continue;
    }
    if (fa * fb > 0) continue;
    if (fb === 0) {
      if (i + 2 === pts.length) out.push(b);
      continue;
    }
    out.push(refineBracket(c, n, a, b, fa, fb));
  }
  return out;
}

/// One root of a MONOTONE stretch, by Brent's method.
///
function refineBracket(c, n, a, b, fa, fb) {
  // A HUGE BRACKET IS PROBED, NOT BISECTED. The outermost brackets run to the Cauchy bound,
  // which is 1 + max|c_i|/|c_n| and can be 1e5 for a composition whose leading coefficient
  // happens to be small -- while the root sits within a unit or two of the finite end, where
  // the geometry is. Interpolating across such a bracket is useless (the far value is
  // astronomical) and bisecting it costs ~17 halvings before the root is even in view. Walking
  // out from the finite end in doubling steps finds a bracket the width of the root's own
  // distance in a few evaluations instead.
  if (b - a > 8 * (1 + Math.min(Math.abs(a), Math.abs(b)))) {
    const fromA = Math.abs(a) <= Math.abs(b);
    const e = fromA ? a : b,
      fe = fromA ? fa : fb,
      dir = fromA ? 1 : -1;
    const far = fromA ? b : a,
      ffar = fromA ? fb : fa;
    let h = 0.5 * (1 + Math.abs(e)),
      prev = e,
      fprev = fe,
      x = e,
      fx = fe;
    for (let k = 0; k < 64; k++) {
      x = e + dir * h;
      if (dir > 0 ? x >= far : x <= far) {
        x = far;
        fx = ffar;
        break;
      }
      fx = c[n];
      for (let i = n - 1; i >= 0; i--) fx = fx * x + c[i];
      if (fx === 0) return x;
      if (fx < 0 !== fe < 0) break; // the sign flips between prev and x
      prev = x;
      fprev = fx;
      h *= 2;
    }
    if (dir > 0) {
      a = prev;
      fa = fprev;
      b = x;
      fb = fx;
    } else {
      a = x;
      fa = fx;
      b = prev;
      fb = fprev;
    }
  }
  // zeroin: b is the current best estimate, [b, cc] the bracket, a the previous iterate.
  let cc = a,
    fc = fa,
    d = b - a,
    e = d;
  for (let it = 0; it < 100; it++) {
    if (fb > 0 === fc > 0) {
      cc = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = cc;
      cc = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    // THE TOLERANCE IS THE CONSUMER'S, NOT THE FLOAT'S. These roots cut the parameter line into
    // the intervals the leak test intersects and measures, and every comparison downstream is
    // at 1e-9 or coarser; resolving a root to 1e-12 leaves three orders of margin, and costs
    // about a third of the iterations that resolving it to the last bit does.
    const tol1 = 1e-12 * Math.abs(b) + 1e-14;
    const xm = 0.5 * (cc - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p, q;
      if (a === cc) {
        p = 2 * xm * s;
        q = 1 - s;
      } // secant
      else {
        // inverse quadratic
        const q0 = fa / fc,
          r = fb / fc;
        p = s * (2 * xm * q0 * (q0 - r) - (b - a) * (r - 1));
        q = (q0 - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      else p = -p;
      const min1 = 3 * xm * q - Math.abs(tol1 * q),
        min2 = Math.abs(e * q);
      if (2 * p < (min1 < min2 ? min1 : min2)) {
        e = d;
        d = p / q;
      } // interpolation accepted
      else {
        d = xm;
        e = d;
      } // bisection
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    if (Math.abs(d) > tol1) b += d;
    else b += xm > 0 ? tol1 : -tol1;
    // Horner, with a running bound on its own rounding error alongside. A power-basis
    // polynomial of degree nine is ill-conditioned near its roots: inside a band around each
    // one the computed value is rounding noise and its sign a coin toss, and driving the
    // bracket to the last ulp through that band is ~15 bisections per root for digits that do
    // not exist. Once |f| is inside the error bound the root is resolved as well as the
    // polynomial can resolve it.
    fb = c[n];
    let ab = Math.abs(fb);
    const bx = Math.abs(b);
    for (let i = n - 1; i >= 0; i--) {
      fb = fb * b + c[i];
      ab = ab * bx + Math.abs(c[i]);
    }
    if (Math.abs(fb) <= ab * (n + 1) * 1.2e-16) return b;
  }
  return b;
}

/// The real roots of a trimmed polynomial, sorted ascending -- the cut points of nonNegSet,
/// exposed so a caller wanting both signs' sets can isolate once and probe twice.
export function rootsSorted(c) {
  const rts = rootsTrimmed(c);
  rts.sort((a, b) => a - b);
  return rts;
}

/// The non-negative set of sign * c, given c's roots. Negating a polynomial does not move its
/// roots, and Horner on negated coefficients is exactly the negation of Horner on the original,
/// so the second sign is a probe per interval rather than a second isolation.
export function nonNegSetFromRoots(c, rts, sign) {
  if (c.length === 1) return sign * c[0] >= 0 ? [[-Infinity, Infinity]] : [];
  const out = [];
  let a = -Infinity;
  for (let i = 0; i <= rts.length; i++) {
    const b = i < rts.length ? rts[i] : Infinity;
    const probe = a === -Infinity ? b - 1 : b === Infinity ? a + 1 : (a + b) / 2;
    if (!(sign * polyEvalPow(c, probe) < 0)) {
      if (out.length && out[out.length - 1][1] === a)
        out[out.length - 1][1] = b; // touching root
      else out.push([a, b]);
    }
    a = b;
  }
  return out;
}

/// The intervals of the real line on which a power-basis polynomial is non-negative.
/// Unbounded ends are reported as +/-Infinity; the caller's intersection is what bounds them.
export function nonNegSet(c0) {
  const c = polyTrim(c0);
  if (c.length === 1) return c[0] >= 0 ? [[-Infinity, Infinity]] : [];
  return nonNegSetFromRoots(c, rootsSorted(c), 1);
}
export { polyTrim };

export const intersectSets = (A, B) => {
  const out = [];
  for (const [a0, a1] of A)
    for (const [b0, b1] of B) {
      const lo = Math.max(a0, b0),
        hi = Math.min(a1, b1);
      if (hi > lo) out.push([lo, hi]);
    }
  return out.sort((p, q) => p[0] - q[0]);
};

/// An implicit composed along a segment's UNBOUNDED extension, as one power-basis polynomial.

/// Term degrees are equalized with the weight exactly as implAlongSeg does it, for the same
/// reason: terms carrying different powers of W are different functions until they are.
export function implAlongPoly(impl, seg) {
  let maxk = 0;
  for (const t of impl.terms) if (t.fs.length > maxk) maxk = t.fs.length;

  const rat = isRat(seg);
  const W = rat ? bernToPower(wBez(seg)) : null;
  // ONE POWER-BASIS LIFT PER FUNCTIONAL, not one per occurrence. An implicit is a sum of
  // PRODUCTS of affine functionals and the same functional recurs -- k^3 - lm names k three
  // times in one term -- so lifting per mention would redo it for each one.
  const lifted = new Map();
  const lift = (f) => {
    let v = lifted.get(f);
    if (v === undefined) {
      v = bernToPower(affBez(f, seg));
      lifted.set(f, v);
    }
    return v;
  };
  let acc = null;
  for (const term of impl.terms) {
    let prod = [term.c];
    for (const f of term.fs) prod = polyMulPow(prod, lift(f));
    if (rat) for (let i = term.fs.length; i < maxk; i++) prod = polyMulPow(prod, W);
    acc = acc ? polyAdd(acc, prod) : prod;
  }
  // A rational segment divides the result by W^maxk, and W is only positive over [0,1] -- past
  // the ends it can change sign and take the whole comparison with it. An even power is positive
  // either way; an odd one needs the weight folded back in, which costs two degrees and keeps
  // every sign right where the curve actually is.
  return rat && maxk % 2 ? polyMulPow(acc, W) : acc;
}

/// WHERE a curve's unbounded extension can lie inside a convex cover, exactly.

/// Asked exactly, it is a root problem. Each cover half-plane composed along the curve is a
/// polynomial in the parameter, the curve is inside the cover only where every one of them is
/// non-negative, and a bounded cover against a non-constant polynomial makes that set bounded.
/// Returning it as INTERVALS rather than one wide span is also what keeps the composition well
/// conditioned: each is tight around a stretch the curve really does spend inside the cover.
///
/// Null when the set could not be bounded — a degenerate segment, whose extension is not a
/// curve at all. The caller makes no claim rather than a bound it did not establish.
export function extensionDomain(seg, box) {
  const den = wBez(seg);
  const rat = isRat(seg);
  const dp = rat ? bernToPower(den) : null;
  let set = [[-Infinity, Infinity]];
  for (const h of box) {
    // num/den >= 0 is num*den >= 0 away from the weight's own zeros, where the rational curve
    // runs to infinity and is outside any bounded cover regardless.
    const np = bernToPower(affBez(h, seg));
    set = intersectSets(set, nonNegSet(rat ? polyMulPow(np, dp) : np));
    if (!set.length) return [];
  }
  for (const iv of set) if (!Number.isFinite(iv[0]) || !Number.isFinite(iv[1])) return null;
  return set;
}

/// The stretches of a curve's parameter that stand farther than `tol` from both given points.

/// Squared distance to a point is a polynomial in the parameter (a rational's numerator over its
/// weight squared), so "farther than tol" is a polynomial inequality and its solution set is
/// exact. Intersecting the two gives every stretch that is a leak, with no point sampled.
export function farFromBoth(seg, A, B, tol) {
  const rat = isRat(seg);
  const H = rat ? ratH(seg) : null;
  const nx = bernToPower(rat ? H.map((q) => q[0]) : seg.P.map((p) => p[0]));
  const ny = bernToPower(rat ? H.map((q) => q[1]) : seg.P.map((p) => p[1]));
  const d = rat ? bernToPower(H.map((q) => q[2])) : [1];
  const sub = (a, b) => {
    const n = Math.max(a.length, b.length),
      o = new Array(n).fill(0);
    for (let i = 0; i < n; i++) o[i] = (a[i] || 0) - (b[i] || 0);
    return o;
  };
  const sc = (a, k) => a.map((v) => v * k);
  const dd = polyMulPow(d, d);
  const far = (P) => {
    const ex = sub(nx, sc(d, P[0])),
      ey = sub(ny, sc(d, P[1]));
    return nonNegSet(sub(polyAdd(polyMulPow(ex, ex), polyMulPow(ey, ey)), sc(dd, tol * tol)));
  };
  return intersectSets(far(A), far(B));
}
const polyAdd = (a, b) => {
  const n = Math.max(a.length, b.length),
    o = new Array(n).fill(0);
  for (let i = 0; i < n; i++) o[i] = (a[i] || 0) + (b[i] || 0);
  return o;
};

// A finite convex quadratic takes its side on the authored arc, where the
// implicit gradient is unambiguous, rather than at a remote patch interior.
export function convexQuadraticSign(seg, pk) {
  const P = seg.P,
    x = (P[0][0] + 2 * P[1][0] + P[2][0]) / 4,
    y = (P[0][1] + 2 * P[1][1] + P[2][1]) / 4;
  const a = pk.a,
    v = a[0][0] * x + a[0][1] * y + a[0][2];
  const gx = 2 * v * a[0][0] - a[1][0],
    gy = 2 * v * a[0][1] - a[1][1];
  return seg._convexEnd * ((P[2][0] - P[0][0]) * gy - (P[2][1] - P[0][1]) * gx) >= 0 ? 1 : -1;
}
