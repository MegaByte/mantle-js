// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbContour.js — bundle-curve decode and contour-space analysis: the packed
// curve table → seg contours, exact ray-winding tests (straight + directional),
// arc → rational-quad conversion, circle/annulus fits, per-contour interior
// calibration, and the per-seg tangent/curvature/end metadata the strip and
// cap machinery consume. Owns the quantized vertex-key origin (_kox/_koy):
// every builder that registers points keys against this shared frame.
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_RQUAD,
  SEG_ARC,
  mkLine,
  mkQuad,
  mkCubic,
  mkRQuad,
} from '../primitives/seg.js';
import { buildWindingTree, treeWinding } from './windingTree.js';
export { treeWinding } from './windingTree.js';
import { solveQuadratic, solveCubicInUnit } from '../svg/pathBoolean/polyRoots.js';
import { orient2dXY } from './predicates.js';

// Per-build ORIGIN for the point-identity quantization keys (Math.round(p*64)).
// The keys merge coincident vertices + match triangle edges to contour edges, but
// an ABSOLUTE grid straddles rounding boundaries differently at different offsets,
// so the same glyph triangulated at x=0.47 (a 'v' inside "Even?") merged different
// points than at x=0 (a lone 'v') — dropping its crescents and cracking the fill
// into a visible diagonal slash. Keying RELATIVE to the shape's own min makes the
// quantization position-independent (identical to the at-origin build) without
// moving any output vertex. Each top-level builder sets this before it keys.
export let _kox = 0,
  _koy = 0,
  _koScale = 64;

// Joint continuity in the float32 curve plane: 4 ulps of the magnitudes at the joint (see curveRangeToContours).
const F32_JOINT = 4 * 2 ** -23;

export const LB_BAND_SHARP_TURN = 0.3;

// TRAVEL-FRAME verification of a contour's interiorSign: the edgeEndMeta consumers
// (kind-10 cap-strips, kind-12 bands) need "+1 ⇔ fill on the left-perp of the travel
// direction" exactly — their outward normals and convex/reflex corner types are derived
// from it. calibrateInterior's sliver probe answers the ctrl-side question, whose
// relation to the travel frame depends on which seg it lands on; the CDT builder has
// verifies it against the longest LINE seg ("a wrong sign puts every kind-10 strip
// on the INK side"), but a LINE-LESS contour (glyph bowls: the '8') has no line to
// verify against, and unverified its bands could inherit inverted normals/corner types
// (waist pixels claimed at a small fraction of their true coverage). This probe generalizes the
// verification to any seg type: sample a point on the longest segs, take the SECANT
// tangent there, and ask inFill on both perp sides; a determinate answer pins the sign.
export function verifyInteriorSign(segs, inFill, interiorSign) {
  const cand = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i],
      e = s.p4 || s.p3 || s.p2;
    cand.push([i, Math.hypot(e[0] - s.p1[0], e[1] - s.p1[1])]);
  }
  cand.sort((A, B) => B[1] - A[1]);
  for (const [i, L] of cand.slice(0, 4)) {
    if (!(L > 0)) continue;
    const s = segs[i];
    for (const t of [0.5, 0.25, 0.75]) {
      const p0 = segPt(s, t - 0.01),
        p1 = segPt(s, t + 0.01);
      let dx = p1[0] - p0[0],
        dy = p1[1] - p0[1];
      const dl = Math.hypot(dx, dy);
      if (!(dl > 0)) continue;
      dx /= dl;
      dy /= dl;
      const p = segPt(s, t);
      for (const rel of [0.02, 0.006]) {
        const off = L * rel;
        // claimed fill side = left-perp (−dy,dx) times the sign under test
        const nx = -dy * (interiorSign > 0 ? 1 : -1),
          ny = dx * (interiorSign > 0 ? 1 : -1);
        const inIn = inFill([p[0] + nx * off, p[1] + ny * off]);
        const inOut = inFill([p[0] - nx * off, p[1] - ny * off]);
        if (inIn !== inOut) return inIn ? interiorSign : -interiorSign;
      }
    }
  }
  return interiorSign;
}

// ── THE SHAPE'S own LENGTH UNIT ──────────────────────────────────────────────────
// Every tolerance in the Loop-Blinn build that is a LENGTH is written against `emSpan()`, the
// shape's own extent. _koScale (set by _setKeyOrigin below, which every builder runs first) is the
// vertex-key quantizer: 65536 buckets across the shape's bbox diagonal, SNAPPED TO A POWER OF TWO.
// So 65536 / _koScale IS that diagonal rounded to a power of two, and scaling the drawing by 2^k
// scales the diagonal by exactly 2^k and _koScale by exactly 2^-k -- the unit is exactly
// equivariant, and `x > c * emSpan()` therefore decides the same thing at every size, which an
// absolute constant does not.md for the per-site derivation
// and the corpus measurement behind each coefficient; test/lbEmTunedLengthScaleSmoke.mjs pins them.
//
//   emSpan()   the shape's extent
//   emEps()    ONE FLOAT32 ULP OF IT (span * 2^-24). A length below this is not a length: two
//              positions this close are the same float32 position in the packed mesh. This is the
//              "numerically zero" floor -- the 1e-4 / 1e-6 / 1e-9 class of constant.
//   emRes()    the vertex-key quantum (span * 2^-16): two vertices closer than this key to the same
//              bucket and ARE the same vertex to this builder, so an area below emRes()^2 is a face
//              the mesh cannot resolve.
//   emFuzz()   float64 noise in a CROSS PRODUCT of such coordinates (span^2 * 2^-48): the degeneracy
//              floor for the dens, squared lengths and clipped-polygon areas that guard a division.
export const emSpan = () => 65536 / _koScale;
export const emEps = () => (65536 / _koScale) * 2 ** -24;
export const emRes = () => (65536 / _koScale) * 2 ** -16;
export const emFuzz = () => {
  const s = 65536 / _koScale;
  return s * s * 2 ** -48;
};

/// The shape's own frame origin: the box `_setKeyOrigin` quantizes into, without touching module
/// state. This is the point a build should be carried out RELATIVE TO — see
/// `translateContours` below.
export function lbFrameOrigin(contours) {
  let ox = Infinity,
    oy = Infinity;
  for (const c of contours)
    for (const s of c) {
      if (!s) continue;
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < ox) ox = p[0];
        if (p[1] < oy) oy = p[1];
      }
    }
  return [isFinite(ox) ? ox : 0, isFinite(oy) ? oy : 0];
}

/// every CONTOUR CLOSED, as SVG fills a path: a contour whose last point is not its first takes the
/// straight line back. The importer already closes the subpaths of a FILLED path; an open one reaches the fill builders
/// only from a row whose fill is none (its stroke's path), and there a winding is not even defined -- it depends on the
/// ray: the builder's ink probe and the winding tree (which reads a far contour as closed) disagreed, and three ray
/// directions disagreed with each other. Closing it answers what the fill would paint if an override ever raised its
/// opacity, the same region the importer closes for a filled path, and one answer for every ray. Returns the same array
/// when every contour is closed, so a caller that checks identity (the partition's cut plans) sees no change.
export function closeOpenContours(contours) {
  if (!contours) return contours;
  const endOf = (g) => (g.type === SEG_LINE ? g.p2 : g.type === SEG_CUBIC ? g.p4 : g.p3);
  let out = null;
  for (let i = 0; i < contours.length; i++) {
    const c = contours[i];
    if (!c || !c.length) continue;
    const a = c[0].p1,
      e = endOf(c[c.length - 1]);
    if (!a || !e || (a[0] === e[0] && a[1] === e[1])) continue;
    if (!out) out = contours.slice();
    out[i] = c.concat([mkLine([e[0], e[1]], [a[0], a[1]])]);
  }
  return out || contours;
}

/// A COPY OF THE CONTOURS MOVED BY (dx, dy), carrying every field a segment holds.
///
/// Why it exists. The builder stores its mesh in FLOAT32, so the resolution it works at is one ulp
/// of the ABSOLUTE coordinate: 1.2e-7 at the origin, 1.9e-6 at x = 16, 6.1e-5 at x = 1000. Ties the
/// geometry makes exactly — a triangle centroid whose depth to one wall is exactly a third of its
/// depth to another, which is the tie `ownD > 3*nearD` decides in lbInteriorSplit — are then broken
/// by whichever way that ulp happens to fall, so the same drawing gets a different antialiasing
/// model depending on where it was laid out (identical bars on either side of a float64 binade
/// get different net ink). No tolerance fixes that: the
/// noise IS the storage format. Building at the shape's own origin and translating the result back
/// does, because every decision is then taken on the same bits whatever the placement.
///
/// The RATIONAL QUAD'S `circle` METADATA MOVES WITH IT. `{cx, cy, r}` is what makes a circular arc
/// render as an exact SDF sector (kind 7) rather than a per-piece crescent; left behind, a
/// translated build would put every such sector at the wrong center — geometry, not bookkeeping.
export function translateContours(contours, dx, dy) {
  if (!contours || (dx === 0 && dy === 0)) return contours;
  const P = (p) => (p ? [p[0] + dx, p[1] + dy] : p);
  return contours.map((c) =>
    c.map((s) => {
      if (!s) return s;
      const o = { ...s };
      if (s.p1) o.p1 = P(s.p1);
      if (s.p2) o.p2 = P(s.p2);
      if (s.p3) o.p3 = P(s.p3);
      if (s.p4) o.p4 = P(s.p4);
      if (s.circle) o.circle = { ...s.circle, cx: s.circle.cx + dx, cy: s.circle.cy + dy };
      return o;
    }),
  );
}

/// THE same FOUR UNITS FOR A SHAPE THAT IS NOT THE LIVE ONE, without moving the key origin.
///
export function emUnitsOf(contours) {
  let ox = Infinity,
    oy = Infinity,
    ox1 = -Infinity,
    oy1 = -Infinity;
  for (const c of contours)
    for (const s of c) {
      if (!s) continue;
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < ox) ox = p[0];
        if (p[0] > ox1) ox1 = p[0];
        if (p[1] < oy) oy = p[1];
        if (p[1] > oy1) oy1 = p[1];
      }
    }
  const x0 = isFinite(ox) ? ox : 0,
    y0 = isFinite(oy) ? oy : 0;
  const diag = Math.hypot((isFinite(ox1) ? ox1 : 1) - x0, (isFinite(oy1) ? oy1 : 1) - y0);
  const span = 65536 / (diag > 0 ? Math.pow(2, Math.round(Math.log2(65536 / diag))) : 64);
  return { span, eps: span * 2 ** -24, res: span * 2 ** -16, fuzz: span * span * 2 ** -48 };
}

export function _setKeyOrigin(contours) {
  let ox = Infinity,
    oy = Infinity,
    ox1 = -Infinity,
    oy1 = -Infinity;
  // every CONTROL POINT, not just each segment's START. The p1-only box is degenerate for a
  // one-segment contour -- an open quad or cubic filled as if closed -- and `diag > 0` would then
  // fall to an ABSOLUTE _koScale = 64, i.e. a 1024-unit stand-in for the shape whatever its real
  // size. Every tolerance written against 65536/_koScale would inherit that, so those shapes would
  // keep em-tuned lengths at every scale. The box is also what the vertex key quantizes into, and a
  // control point outside it would be keyed against a box that does not contain it.
  for (const c of contours)
    for (const s of c) {
      if (!s) continue;
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < ox) ox = p[0];
        if (p[0] > ox1) ox1 = p[0];
        if (p[1] < oy) oy = p[1];
        if (p[1] > oy1) oy1 = p[1];
      }
    }
  _kox = isFinite(ox) ? ox : 0;
  _koy = isFinite(oy) ? oy : 0;
  // Scale-AWARE quantization: a fixed ×64 would give text-normalized (0..1) contours just 64
  // buckets across the glyph — distinct apex vertices within ~1.5px would merge into
  // degenerate geometry (coverage cracks in A or w). ~64k buckets across the shape keeps
  // dedup semantics for genuinely-coincident points at any coordinate scale.
  const diag = Math.hypot((isFinite(ox1) ? ox1 : 1) - _kox, (isFinite(oy1) ? oy1 : 1) - _koy);
  // Snapped to a power of two. The quantizer has to be scale-AWARE (see above) but dividing by the
  // diagonal directly is not scale-EQUIVARIANT: 65536/diag and 65536/(2*diag) are not related by a
  // factor of two in the last bits, so `round((x - ox) * scale)` can land on a different bucket for
  // the same vertex at a different drawing size -- and this key is what decides whether two
  // vertices are the same vertex. Multiplying by a power of two is exact, so snapping keeps the
  // ~64k buckets the comment argues for and makes the bucket a vertex falls in independent of size.
  _koScale = diag > 0 ? Math.pow(2, Math.round(Math.log2(65536 / diag))) : 64;
}

// NONZERO-winding sibling: identical crossing acceptance, but each hit adds the
// crossing DIRECTION — the sign of dP/dt of the (already solved) vertical-distance
// polynomial at t (denominators are positive on t∈[0,1], so this is sign(dy/dt)).
// TrueType fills by winding; the even-odd parity test reads a SELF-OVERLAPPING
// outline's overlap as a hole (spiral terminals: e/6/8/9), vetoing every interior
// classification exactly where Slug renders solid.
// Signed +x-ray crossings of ONE segment at (x, y) — rayWinding's per-segment body,
// factored so the winding tree (windingTree.js) can evaluate near leaves with the exact
// same solvers the linear walk uses.
// dir === 0 = the ray grazes a y-extremum (apex): the curve TOUCHES, it does
// not cross, and counting it ±1 would miscount the winding (the coverage
// walker skips the apex the same way).
// Slack for the hull rejects below, RELATIVE to the magnitudes actually fed to the
// arithmetic, so it means the same thing at any scale (this codebase has a defect family
// from absolute epsilons). A hull reject is only sound if it fires when the full solve could
// not have scored, and "could not have scored" is a statement about the FLOATING-POINT
// evaluation, not the exact curve: with every control x equal to the ray's x, the Bernstein
// combination u*u*x0 + 2*u*t*cx + t*t*x1 sums weights that are only approximately 1, so it
// can land a few ulps ABOVE x and `tx > x` fires. That happens in a sizable share of such
// degenerate cases, and still 1-2 ulps strictly below -- so a strict comparison is NOT enough on its own.
// The forms here (Bernstein evaluation, and the power-basis coefficients a3/b3/c3 built by
// differencing raw coordinates) carry error of order a few times eps against the largest
// magnitude involved; 1e-12 is ~200x that, and the only cost of being generous is that a
// near-coincident segment takes the solver it would have taken anyway.
const HULL_REL = 1e-12;

export function raySegCross(s, x, y) {
  let wsum = 0;
  const hit = (tx, t, dir) => {
    if (t >= 0 && t < 1 && tx > x && dir !== 0) wsum += dir > 0 ? 1 : -1;
  };
  if (s.type === SEG_LINE) {
    const y1 = s.p1[1],
      dy = s.p2[1] - y1;
    if (dy === 0) return 0;
    const t = (y - y1) / dy;
    hit(s.p1[0] + t * (s.p2[0] - s.p1[0]), t, dy);
    return wsum;
  }
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
    const w = s.type === SEG_RQUAD ? s.w : 1,
      d1 = s.p1[1] - y,
      d2 = s.p2[1] - y,
      d3 = s.p3[1] - y;
    // Hull reject. A Bezier lies in the convex hull of its control points, and a rational quad
    // with w > 0 is a convex combination too, so a control polygon clear of the ray -- by the
    // relative slack above, not merely on the far side of it -- has no root to find, and one
    // clear to the LEFT cannot satisfy `tx > x`. NaN fails every comparison, so a NaN control
    // point falls through to the solver as before.
    if (w > 0) {
      const sy =
        HULL_REL * Math.max(Math.abs(y), Math.abs(s.p1[1]), Math.abs(s.p2[1]), Math.abs(s.p3[1]));
      if ((d1 > sy && d2 > sy && d3 > sy) || (d1 < -sy && d2 < -sy && d3 < -sy)) return 0;
      const sx =
        HULL_REL * Math.max(Math.abs(x), Math.abs(s.p1[0]), Math.abs(s.p2[0]), Math.abs(s.p3[0]));
      if (s.p1[0] <= x - sx && s.p2[0] <= x - sx && s.p3[0] <= x - sx) return 0;
    }
    const A2 = d1 - 2 * w * d2 + d3,
      B2 = 2 * (w * d2 - d1);
    for (const t of solveQuadratic(A2, B2, d1)) {
      const u = 1 - t,
        a = u * u,
        b = 2 * w * u * t,
        c = t * t,
        den = a + b + c;
      if (Math.abs(den) > 1e-15)
        hit((a * s.p1[0] + b * s.p2[0] + c * s.p3[0]) / den, t, 2 * A2 * t + B2);
    }
    return wsum;
  }
  const y1 = s.p1[1],
    y2 = s.p2[1],
    y3 = s.p3[1],
    y4 = s.p4[1];
  const q1 = y1 - y,
    q2 = y2 - y,
    q3 = y3 - y,
    q4 = y4 - y; // hull reject, as above
  const sy =
    HULL_REL * Math.max(Math.abs(y), Math.abs(y1), Math.abs(y2), Math.abs(y3), Math.abs(y4));
  if ((q1 > sy && q2 > sy && q3 > sy && q4 > sy) || (q1 < -sy && q2 < -sy && q3 < -sy && q4 < -sy))
    return 0;
  const sx =
    HULL_REL *
    Math.max(
      Math.abs(x),
      Math.abs(s.p1[0]),
      Math.abs(s.p2[0]),
      Math.abs(s.p3[0]),
      Math.abs(s.p4[0]),
    );
  if (s.p1[0] <= x - sx && s.p2[0] <= x - sx && s.p3[0] <= x - sx && s.p4[0] <= x - sx) return 0;
  const a3 = -y1 + 3 * y2 - 3 * y3 + y4,
    b3 = 3 * (y1 - 2 * y2 + y3),
    c3 = 3 * (y2 - y1);
  for (const t of solveCubicInUnit(a3, b3, c3, y1 - y)) {
    const u = 1 - t;
    hit(
      u * u * u * s.p1[0] + 3 * u * u * t * s.p2[0] + 3 * u * t * t * s.p3[0] + t * t * t * s.p4[0],
      t,
      3 * a3 * t * t + 2 * b3 * t + c3,
    );
  }
  return wsum;
}

export function rayWinding(segs, x, y) {
  let wsum = 0;
  for (const s of segs) wsum += raySegCross(s, x, y);
  return wsum;
}

//
//   a point AT height y is below the ray: every side test is the strict `> y` on exact coordinates,
//     so a vertex, a horizontal run or an extremum at y is counted as the infinitesimally raised ray
//     meets it, and the far-chord rule of windingTree.js (`(y0 > yr) !== (y1 > yr)`) is the same rule;
//   a crossing at exactly x is to the right when the curve runs right as it rises (x at y + eps is
//     x + eps dx/dy), and a line's crossing is decided by the exact orientation predicate.
//
// The segment is split where its height turns (the roots of y'(t), from the scale-free solver), so
// each piece crosses the ray at most once, and that crossing is found by bisection on the piece. No
// length is compared with a constant anywhere, so a drawing scaled by 2^k gets the same answers.
function bernY(d, w, t) {
  // the numerator of y(t) - y: d are control heights less y, w the rquad weight or 0 for a cubic
  const u = 1 - t;
  return w
    ? d[0] * u * u + 2 * w * d[1] * u * t + d[2] * t * t
    : d[0] * u * u * u + 3 * d[1] * u * u * t + 3 * d[2] * u * t * t + d[3] * t * t * t;
}
export function raySegCrossExact(s, x, y) {
  if (s.type === SEG_LINE) {
    const a = s.p1[1] > y,
      b = s.p2[1] > y;
    if (a === b) return 0;
    const dir = b ? 1 : -1,
      o = orient2dXY(s.p1[0], s.p1[1], s.p2[0], s.p2[1], x, y) * dir;
    return o > 0 || (o === 0 && (s.p2[0] - s.p1[0]) * dir > 0) ? dir : 0;
  }
  const quad = s.type === SEG_QUAD || s.type === SEG_RQUAD;
  const w = quad ? (s.type === SEG_RQUAD ? s.w : 1) : 0;
  // Hull rejects, exact: Bernstein coefficients all above (all not above) keep the whole curve there,
  // and one all strictly left of x cannot cross to its right. (A rational quad needs w > 0 for either.)
  // Most probes end here, so they allocate nothing.
  if (!quad || w > 0) {
    const a0 = s.p1[1] - y > 0,
      a1 = s.p2[1] - y > 0,
      a2 = s.p3[1] - y > 0,
      a3 = quad ? a2 : s.p4[1] - y > 0;
    if (a0 === a1 && a1 === a2 && a2 === a3) return 0;
    if (s.p1[0] < x && s.p2[0] < x && s.p3[0] < x && (quad || s.p4[0] < x)) return 0;
  }
  const P = quad ? [s.p1, s.p2, s.p3] : [s.p1, s.p2, s.p3, s.p4];
  const d = P.map((p) => p[1] - y);
  const X = (t) => {
    const u = 1 - t;
    if (!quad)
      return (
        u * u * u * P[0][0] +
        3 * u * u * t * P[1][0] +
        3 * u * t * t * P[2][0] +
        t * t * t * P[3][0]
      );
    const a = u * u,
      b = 2 * w * u * t,
      c = t * t;
    return (a * P[0][0] + b * P[1][0] + c * P[2][0]) / (a + b + c);
  };
  // where the height turns: roots of the numerator's derivative (power basis), inside (0, 1)
  const cuts = [0];
  const roots = quad
    ? solveQuadratic(0, 2 * (d[0] - 2 * w * d[1] + d[2]), 2 * (w * d[1] - d[0]))
    : solveQuadratic(
        3 * (-d[0] + 3 * d[1] - 3 * d[2] + d[3]),
        6 * (d[0] - 2 * d[1] + d[2]),
        3 * (d[1] - d[0]),
      );
  if (roots.length === 2 && roots[1] < roots[0]) roots.reverse();
  for (const r of roots) if (r > 0 && r < 1 && r > cuts[cuts.length - 1]) cuts.push(r);
  cuts.push(1);
  let wsum = 0;
  const last = d[d.length - 1];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const ta = cuts[k],
      tb = cuts[k + 1];
    const pa = ta === 0 ? d[0] : bernY(d, w, ta),
      pb = tb === 1 ? last : bernY(d, w, tb);
    const above = pb > 0;
    if (pa > 0 === above) continue;
    // The crossing, bracketed: P(lo) on pa's side, P(hi) on pb's. False position with the Illinois
    // halving, and a bisection step whenever it stalls, until the bracket cannot shrink in float64.
    let lo = ta,
      hi = tb,
      flo = pa,
      fhi = pb,
      keep = 0;
    for (let it = 0; it < 200; it++) {
      let t = it % 4 === 3 ? 0.5 * (lo + hi) : (lo * fhi - hi * flo) / (fhi - flo);
      if (!(t > lo && t < hi)) t = 0.5 * (lo + hi);
      if (!(t > lo && t < hi)) break;
      const ft = bernY(d, w, t);
      if (ft > 0 === above) {
        hi = t;
        fhi = ft;
        if (keep === -1) flo *= 0.5;
        keep = -1;
      } else {
        lo = t;
        flo = ft;
        if (keep === 1) fhi *= 0.5;
        keep = 1;
      }
    }
    const t = 0.5 * (lo + hi),
      tx = X(t),
      dir = above ? 1 : -1;
    if (tx > x) wsum += dir;
    else if (tx === x) {
      const h = Math.max(hi - lo, 2 ** -40),
        dx = X(Math.min(1, t + h)) - X(Math.max(0, t - h));
      if (dx * dir > 0) wsum += dir;
    }
  }
  return wsum;
}
/// The exact side test's winding: every segment's `raySegCrossExact`.
export function rayWindingExact(segs, x, y) {
  let wsum = 0;
  for (const s of segs) wsum += raySegCrossExact(s, x, y);
  return wsum;
}

// Build a winding tree over renderer segs (see windingTree.js): the CDT builder's inkAt
// probes call rayWinding once per curved segment (side bits) plus calibration/verify —
// O(N^2) per build on curved shapes without it. Returns null below the cutoff where the
// linear walk wins.
export function buildSegWindingTree(segs, cross = raySegCross) {
  if (!segs || segs.length < 48) return null;
  const endP = (s) => (s.type === SEG_LINE ? s.p2 : s.type === SEG_CUBIC ? s.p4 : s.p3);
  return buildWindingTree(segs.length, {
    start: (i) => segs[i].p1,
    end: (i) => endP(segs[i]),
    bbox: (i) => {
      const s = segs[i];
      let x0 = s.p1[0],
        y0 = s.p1[1],
        x1 = x0,
        y1 = y0;
      for (const p of [s.p2, s.p3, s.p4]) {
        if (!p) break;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
      return [x0, y0, x1, y1];
    },
    cross: (i, x, yr) => cross(segs[i], x, yr),
  });
}

// rayWinding along an ARBITRARY direction d (unit): project control points
// onto (d, perp(d)) about the query point and reuse the same monotone-root
// logic. Razor ink slivers (the '8' waist: two near-tangent arcs of one
// contour) tie along any single ray; probing 2-3 directions and voting is
// robust where nudging the query point is not (the sliver is thinner than
// any safe nudge).
export function rayWindingDir(segs, x, y, dx, dy) {
  let wsum = 0;
  const px9 = (X9, Y9) => dx * (X9 - x) + dy * (Y9 - y);
  const py9 = (X9, Y9) => -dy * (X9 - x) + dx * (Y9 - y);
  const hit = (tx, t, dir) => {
    if (t >= 0 && t < 1 && tx > 0 && dir !== 0) wsum += dir > 0 ? 1 : -1;
  };
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      const y1 = py9(s.p1[0], s.p1[1]),
        y2 = py9(s.p2[0], s.p2[1]),
        dyq = y2 - y1;
      if (dyq === 0) continue;
      const t = -y1 / dyq;
      hit(px9(s.p1[0], s.p1[1]) + t * (px9(s.p2[0], s.p2[1]) - px9(s.p1[0], s.p1[1])), t, dyq);
      continue;
    }
    if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
      const w = s.type === SEG_RQUAD ? s.w : 1;
      const d1 = py9(s.p1[0], s.p1[1]),
        d2 = py9(s.p2[0], s.p2[1]),
        d3 = py9(s.p3[0], s.p3[1]);

      const sy = HULL_REL * Math.max(Math.abs(d1), Math.abs(d2), Math.abs(d3));
      if (w > 0 && ((d1 > sy && d2 > sy && d3 > sy) || (d1 < -sy && d2 < -sy && d3 < -sy)))
        continue;
      const A2 = d1 - 2 * w * d2 + d3,
        B2 = 2 * (w * d2 - d1);
      const x1 = px9(s.p1[0], s.p1[1]),
        x2 = px9(s.p2[0], s.p2[1]),
        x3 = px9(s.p3[0], s.p3[1]);
      // The x side needs NO slack here, and this is the one place that is exact rather than
      // merely generous: the frame is pre-shifted, so the test is against 0. With every rotated
      // x <= 0 and Bernstein weights >= 0 for t in [0,1], every term of the combination is <= 0,
      // IEEE addition of non-positives is exactly non-positive, and the rational quad's divide by
      // den > 0 keeps the sign -- so `tx > 0` cannot fire. raySegCross gets no such guarantee
      // because it evaluates raw coordinates and compares against x itself.
      if (w > 0 && x1 <= 0 && x2 <= 0 && x3 <= 0) continue;
      for (const t of solveQuadratic(A2, B2, d1)) {
        const u = 1 - t,
          a = u * u,
          b = 2 * w * u * t,
          c = t * t,
          den = a + b + c;
        if (Math.abs(den) > 1e-15) hit((a * x1 + b * x2 + c * x3) / den, t, 2 * A2 * t + B2);
      }
      continue;
    }
    const y1 = py9(s.p1[0], s.p1[1]),
      y2 = py9(s.p2[0], s.p2[1]),
      y3 = py9(s.p3[0], s.p3[1]),
      y4 = py9(s.p4[0], s.p4[1]);
    const syc = HULL_REL * Math.max(Math.abs(y1), Math.abs(y2), Math.abs(y3), Math.abs(y4));
    if (
      (y1 > syc && y2 > syc && y3 > syc && y4 > syc) ||
      (y1 < -syc && y2 < -syc && y3 < -syc && y4 < -syc)
    )
      continue;
    const a3 = -y1 + 3 * y2 - 3 * y3 + y4,
      b3 = 3 * (y1 - 2 * y2 + y3),
      c3 = 3 * (y2 - y1);
    const x1 = px9(s.p1[0], s.p1[1]),
      x2 = px9(s.p2[0], s.p2[1]),
      x3 = px9(s.p3[0], s.p3[1]),
      x4 = px9(s.p4[0], s.p4[1]);
    if (x1 <= 0 && x2 <= 0 && x3 <= 0 && x4 <= 0) continue; // exact, by the sign argument above
    for (const t of solveCubicInUnit(a3, b3, c3, y1)) {
      const u = 1 - t;
      hit(
        u * u * u * x1 + 3 * u * u * t * x2 + 3 * u * t * t * x3 + t * t * t * x4,
        t,
        3 * a3 * t * t + 2 * b3 * t + c3,
      );
    }
  }
  return wsum;
}

export function arcToRationalQuads(cx, cy, rx, ry, th0, th1, phi) {
  const cosP = Math.cos(phi),
    sinP = Math.sin(phi);
  const A = (u, vv) => {
    const x = rx * u,
      y = ry * vv;
    return [cx + x * cosP - y * sinP, cy + x * sinP + y * cosP];
  };
  const total = th1 - th0;
  // A piece count that does not sit on a knife edge. The rule is "at most a quarter turn per piece", and a HALF
  // TURN — the commonest arc there is, two of them make every circle — puts the ratio at exactly 2, where ceil
  // answers 2 or 3 on the last ulp. The angles arrive from the curve plane as FLOAT32, and every rebuild
  // recomputes them through atan2, so which side of the edge an arc lands on is decided by where the drawing
  // happens to be: the same half circle turned by different angles can come out 2 pieces or 3, and in one drawing
  // two identical circles can come out 3 and 2. Different piece counts are different crescents, a
  // different partition and different triangles, so a pixel at a moved joint can flip almost fully — a
  // representation change with no geometry behind it.
  //
  // So give the ratio a few float32 ulps of slack before rounding up, RELATIVE to the ratio, never absolute
  // (F32_JOINT is the same 4 * 2^-23 the joint test above uses). This cannot cost anything: the real
  // constraint is only that a piece stay under a HALF turn, where w = cos(|dth|/2) reaches zero; a quarter is
  // already a 2x margin and a part in a million of one is nothing. It buys the intended answer — a half turn
  // is 2 quarter-turn pieces, not 3 — at every size, position and rotation.
  const ratio = Math.abs(total) / (Math.PI / 2);
  const n = Math.max(1, Math.ceil(ratio - F32_JOINT * ratio));
  const dth = total / n,
    w = Math.cos(Math.abs(dth) / 2);
  // CIRCULAR arc (equal radii, no rotation) → carry {cx,cy,r} so the builder can
  // render an exact seam-free circular-SDF sector instead of per-piece crescents.
  // RELATIVE TO THE RADII, with no `+ 1`: the constant term dominates below unit scale, so the same
  // ellipse is "circular enough" at one size and not at another -- and whether it is decides an
  // exact SDF sector against per-piece crescents, which is a visible difference.
  const circle =
    Math.abs(rx - ry) < 1e-6 * (Math.abs(rx) + Math.abs(ry)) ? { cx, cy, r: rx } : null;
  const segs = [];
  let a0 = th0;
  for (let i = 0; i < n; i++) {
    const a1 = a0 + dth,
      am = (a0 + a1) / 2;
    const P0 = A(Math.cos(a0), Math.sin(a0)),
      P2 = A(Math.cos(a1), Math.sin(a1));
    const P1 = A(Math.cos(am) / w, Math.sin(am) / w); // tangent intersection on the ellipse
    segs.push(mkRQuad(P0, P1, P2, w, circle));
    a0 = a1;
  }
  return segs;
}

// Circle and ellipse recognition moved to shapeRecognize.js — it is a fact about the shape, not
// about Loop-Blinn, and CPatch and the route selector have as much use for it. Re-exported here
// so existing importers are unaffected; extractAnnuli below still consumes fitCircularContour.
import {
  sdfPrimitivesDisabled,
  circleFromContours,
  ellipseFromContours,
  fitCircularContour,
  fitEllipticalContour,
  fitCircle,
  fitEllipse,
} from './shapeRecognize.js';
export {
  circleFromContours,
  ellipseFromContours,
  fitCircularContour,
  fitEllipticalContour,
  fitCircle,
  fitEllipse,
};

export function extractAnnuli(contours, fillRule) {
  // The annulus is an SDF primitive too, so it answers to the same switch — otherwise a run with
  // the primitives "off" still collapses rings and the comparison is only half controlled.
  if (sdfPrimitivesDisabled()) return { annuli: [], rest: contours };
  const fits = contours.map((segs) => fitCircularContour(segs));
  // signed area per contour: an annulus is a RING (the inner = a hole). Under
  // NONZERO a same-wound nested circle pair is a SOLID DISC (the inner contour
  // is an invisible boundary) — pairing it as an annulus carved a phantom hole.
  // Evenodd keeps pairing regardless (nesting alone makes the hole there).
  const areas = contours.map((segs) => {
    let a2 = 0;
    for (const sg of segs) {
      const q = sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
      a2 += sg.p1[0] * q[1] - q[0] * sg.p1[1];
    }
    return a2;
  });
  const used = new Set(),
    annuli = [];
  for (let i = 0; i < fits.length; i++) {
    if (!fits[i] || used.has(i)) continue;
    for (let j = i + 1; j < fits.length; j++) {
      if (!fits[j] || used.has(j)) continue;
      if (fillRule !== 'evenodd' && areas[i] * areas[j] > 0) continue; // same-wound → no hole under nonzero
      // RELATIVE tolerance only: an absolute em term paired DISJOINT
      // small circles (glyph contours live in 0..1 em — two dots < 0.5em
      // apart would become a phantom ring).
      // ...and no looser than a circle is recognized (0.002 r, shapeRecognize.js): the annulus is drawn around one center, so two circles
      // farther apart would be painted concentric, up to a few percent of the radius from where the path puts the inner one.
      const tol = 0.002 * fits[i].r;
      if (Math.abs(fits[i].cx - fits[j].cx) < tol && Math.abs(fits[i].cy - fits[j].cy) < tol) {
        const rO = Math.max(fits[i].r, fits[j].r),
          rI = Math.min(fits[i].r, fits[j].r);
        annuli.push({ cx: fits[i].cx, cy: fits[i].cy, rMid: (rO + rI) / 2, halfW: (rO - rI) / 2 });
        used.add(i);
        used.add(j);
        break;
      }
    }
  }
  return annuli.length
    ? { annuli, rest: contours.filter((_, k) => !used.has(k)) }
    : { annuli: [], rest: contours };
}

// Emit a circular arc's crescent as a kind-7 SECTOR fan: triangles from the center
// out past the radius, angularly limited to [p1,p3]. The circular SDF clips the
// outer edge to the exact arc; the angular limit stops it filling the rest of the
// disc; and adjacent co-circular sectors SHARE the radial edge to their common
// endpoint, so they tile with NO geometric gap AND one identical field — the seam
// undercount the control-triangle crescents left. Pushed as kind-7 quad entries.
export function emitCircleSector(quads, circle, p1, p3, sign) {
  const { cx, cy, r } = circle;
  const th1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  let sweep = Math.atan2(p3[1] - cy, p3[0] - cx) - th1;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  // No world-unit pad. The fan is packed as DISC, and the DISC vertex setup pushes every vertex out by
  // LB_DISC_PUSH pixels radially from the center (the center itself does not move), which is where the
  // outer AA band is covered, at any zoom. A flat world-unit pad here would give a different polygon
  // for the same arc at every drawing size -- 2 units is a tenth of a radius-20 arc at scale 1 and
  // 2^20 radii at 2^-20.
  //
  const K = 2,
    m = 0.5 * r;
  const Rout = (r + m) / Math.cos(Math.abs(sweep) / (2 * K) || 1e-3); // outer polygon encloses r+m
  const P = (i) => {
    const t = th1 + sweep * (i / K);
    return [cx + Rout * Math.cos(t), cy + Rout * Math.sin(t)];
  };
  for (let i = 0; i < K; i++) {
    const a = P(i),
      b = P(i + 1);
    quads.push({ tri: new Float32Array([cx, cy, a[0], a[1], b[0], b[1]]), sign, circle });
  }
}

/// Check whether a sector wedge lies inside the fill. emitCircleSector fans from the circle's center, and the kernel paints every pixel of
/// the disc inside that angle: the arc's crescent plus the triangle (center, p1, p3). On a convex shape that triangle is ink
/// the rim triangulation paints anyway. Where other outline reaches into it -- the notches between an arc star's spikes --
/// the sector paints outside the path (arc_n1_s64_star @1024: 2,248 px). Exact on the control polygons, which contain their
/// curves: the center is in the fill, no other segment's control point lies inside the triangle, and no control-polygon
/// edge properly crosses its two radial edges. A curve can enter only by crossing those or by leaving a point inside.
export function sectorInsideFill(contours, arcSeg, circle, p1, p3, inFill) {
  const cx = circle.cx,
    cy = circle.cy;
  if (!inFill([cx, cy])) return false;
  const orient = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const area = orient(cx, cy, p1[0], p1[1], p3[0], p3[1]);
  const eps = 1e-9 * circle.r * circle.r;
  if (!(Math.abs(area) > eps)) return false;
  const sg = area > 0 ? 1 : -1;
  const inside = (P) =>
    sg * orient(cx, cy, p1[0], p1[1], P[0], P[1]) > eps &&
    sg * orient(p1[0], p1[1], p3[0], p3[1], P[0], P[1]) > eps &&
    sg * orient(p3[0], p3[1], cx, cy, P[0], P[1]) > eps;
  const crosses = (A, B, E) => {
    const d1 = orient(A[0], A[1], B[0], B[1], cx, cy),
      d2 = orient(A[0], A[1], B[0], B[1], E[0], E[1]);
    const d3 = orient(cx, cy, E[0], E[1], A[0], A[1]),
      d4 = orient(cx, cy, E[0], E[1], B[0], B[1]);
    return (
      ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
    );
  };
  for (const segs of contours) {
    for (const t of segs) {
      if (t === arcSeg) continue;
      const pts =
        t.type === SEG_LINE
          ? [t.p1, t.p2]
          : t.type === SEG_CUBIC
            ? [t.p1, t.p2, t.p3, t.p4]
            : [t.p1, t.p2, t.p3];
      for (const P of pts) if (inside(P)) return false;
      for (let k = 0; k + 1 < pts.length; k++) {
        if (crosses(pts[k], pts[k + 1], p1) || crosses(pts[k], pts[k + 1], p3)) return false;
      }
    }
  }
  return true;
}

// Decode one shape's slice of a bundle curve buffer (the same RGBA32F layout
// curveRangeToPathD walks) into em-space contours — [outer, ...holes], each a
// Seg array — so the renderer can build an LB mesh from an already-uploaded
// bundle without re-importing. Arcs become exact rational-quadratic segs (no
// cubic approximation); returns null only on a degenerate/empty range.
//
// A ZERO-RADIUS ARC IS ITS CHORD (SVG 2 paths, out-of-range arc parameters: rx or ry 0 is "a straight line segment
// joining the endpoints"), and it decodes to one line between its stored ends. The importer keeps it as an
// arc record for morph topology -- a half-turn of a degenerate ellipse -- and as rational quads that would be two
// collinear pieces meeting at the chord's midpoint: a vertex the line does not have, so the mesh, its chains and its
// corners would differ from the line's and the fill would draw a few pixels differently from `L`. `pairF32`, the other
// pose's curve plane of a MORPH, keeps the half-turn where that pose's arc at the same record is not zero-radius: the
// two poses must decode to one topology to be paired.
export function curveRangeToContours(curveF32, beginFloat, endFloat, pairF32 = null) {
  const end = Math.min(endFloat | 0, curveF32.length);
  let hdr = Math.max(0, beginFloat | 0);
  const contours = [];
  let cur = null;
  let penX = NaN,
    penY = NaN;
  // Where a subpath BEGINS is read from bit 3 of the segment header, not guessed
  // from geometry. A closed subpath ends where it began, so a second subpath
  // starting at that same point is continuous with the pen and no start-vs-pen
  // test can see the break: a fan of wedges sharing an apex merged into ONE
  // contour and the partition built ZERO interior triangles — the shape rendered
  // blank. encodeSeg carries the parser's authored marker through instead.
  let subStart = false;

  let penMag = 0;
  const jointOpen = (ax, ay, bx, by, magA, magB) => {
    const tol =
      F32_JOINT * Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by), magA, magB);
    return Math.abs(ax - bx) > tol || Math.abs(ay - by) > tol;
  };
  while (hdr + 4 <= end) {
    // A header is a packed small integer -- two type bits plus flags -- so anything else in that
    // slot is not a segment record and the range has run past the shape's curves. Exact, not a
    // tolerance: a real header is an integral value in [0, 16). Each range ends at the next
    // shape's begin so the walk does not over-read. Walking past the records invents contours
    // out of an arc's own center and radii, so the decoder stops at the first value that is
    // not a segment header.
    const hw = curveF32[hdr];
    if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
    const raw = hw | 0;
    const segType = raw & 3;
    subStart = (raw & 8) !== 0;
    const d = hdr + 4;
    let sx, sy, ex, ey, seg;
    if (segType === SEG_LINE) {
      sx = curveF32[d];
      sy = curveF32[d + 1];
      ex = curveF32[d + 2];
      ey = curveF32[d + 3];
      seg = mkLine([sx, sy], [ex, ey]);
      hdr = d + 8;
    } else if (segType === SEG_QUAD) {
      sx = curveF32[d];
      sy = curveF32[d + 1];
      const cx = curveF32[d + 2],
        cy = curveF32[d + 3];
      ex = curveF32[d + 4];
      ey = curveF32[d + 5];
      seg = mkQuad([sx, sy], [cx, cy], [ex, ey]);
      hdr = d + 12;
    } else if (segType === SEG_CUBIC) {
      sx = curveF32[d];
      sy = curveF32[d + 1];
      const c2x = curveF32[d + 2],
        c2y = curveF32[d + 3],
        c3x = curveF32[d + 4],
        c3y = curveF32[d + 5];
      ex = curveF32[d + 6];
      ey = curveF32[d + 7];
      seg = mkCubic([sx, sy], [c2x, c2y], [c3x, c3y], [ex, ey]);
      hdr = d + 12;
    } else {
      // SEG_ARC: (cx,cy,rx,ry) + (theta0,theta1,phi,_) → rational quads
      const cx = curveF32[d],
        cy = curveF32[d + 1],
        rx = curveF32[d + 2],
        ry = curveF32[d + 3];
      const th0 = curveF32[d + 4],
        th1 = curveF32[d + 5],
        phi = curveF32[d + 6];
      hdr = d + 16; // (cx, cy, rx, ry), (th0, th1, phi), the endpoints, the join
      // The ends are the stored vertices: the path's own points, which the neighbors store, so the contour
      // closes exactly. The first and last pieces take them in place of their rebuilt ends (an ulp or so away).
      sx = curveF32[d + 8];
      sy = curveF32[d + 9];
      ex = curveF32[d + 10];
      ey = curveF32[d + 11];
      if ((rx === 0 || ry === 0) && !(pairF32 && pairF32[d + 2] !== 0 && pairF32[d + 3] !== 0)) {
        // A zero-radius arc: its chord (see above), decoded as the line it is.
        seg = mkLine([sx, sy], [ex, ey]);
        if (subStart || isNaN(penX) || jointOpen(sx, sy, penX, penY, 0, penMag)) {
          cur = [];
          contours.push(cur);
        }
        cur.push(seg);
        penX = ex;
        penY = ey;
        penMag = 0;
        continue;
      }
      const rqs = arcToRationalQuads(cx, cy, rx, ry, th0, th1, phi);
      if (!rqs.length) continue;
      const last = rqs[rqs.length - 1];
      rqs[0].p1 = [sx, sy];
      last.p3 = [ex, ey];
      const startMag = 0,
        endMag = 0;
      if (subStart || isNaN(penX) || jointOpen(sx, sy, penX, penY, startMag, penMag)) {
        cur = [];
        contours.push(cur);
      }
      for (const rq of rqs) cur.push(rq);
      penX = ex;
      penY = ey;
      penMag = endMag;
      continue;
    }
    if (subStart || isNaN(penX) || jointOpen(sx, sy, penX, penY, 0, penMag)) {
      cur = [];
      contours.push(cur); // new subpath
    }
    cur.push(seg);
    penX = ex;
    penY = ey;
    penMag = 0;
  }
  return finishContours(contours);
}

/// The decoder's last two steps, shared with contoursFromSegs so a contour list built from JS segments is
/// the one the curve table decodes to: close each chain's joins onto the pen, and drop zero-extent
/// contours. A snapped segment is REPLACED by a copy, never mutated, so a caller's segments are untouched.
function finishContours(contours) {
  // A DECODED CONTOUR IS A CHAIN, SO MAKE IT ONE.
  //
  // The decoder already knows which segments continue the pen -- that is the test just above, and
  // it is a fact about the path rather than an inference from proximity. Unless that is written
  // back, two things leave a join open. An ARC is stored as center, radii and
  // angles and its endpoints are RECOMPUTED here, while its neighbors store theirs; the two agree
  // to about 1e-13 in double. And the curve plane is FLOAT32, which rounds each of those two
  // doubles separately -- so a 1e-13 disagreement becomes a whole ulp, 1.8e-5 on coordinates
  // around 180.
  //
  // Snapping the start onto the pen costs nothing anyone can see -- the threshold is a few float32
  // ulps of the coordinate magnitude, which is the precision the plane HAS -- and it removes the
  // need for consumers to read a wider plane just to keep their joins.
  // No floor on the magnitude: `mag = 1` made the snap an absolute 9.5e-7 on anything under a unit,
  // which at 2^-20 is a hundredth of the coordinates.
  {
    let mag = 0;
    for (const c of contours)
      for (const sg of c)
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          const ax = Math.abs(p[0]),
            ay = Math.abs(p[1]);
          if (ax > mag) mag = ax;
          if (ay > mag) mag = ay;
        }
    const snapTol = 8 * 1.1920928955078125e-7 * mag;
    const endOf = (sg) => sg.p4 || sg.p3 || sg.p2 || sg.p1;
    for (const c of contours) {
      if (c.length < 2) continue;
      for (let i = 0; i < c.length; i++) {
        const e = endOf(c[i]);
        const nx = c[(i + 1) % c.length];
        const a = nx.p1;
        if (a[0] === e[0] && a[1] === e[1]) continue;
        if (Math.hypot(a[0] - e[0], a[1] - e[1]) > snapTol) continue; // a real break, not rounding
        c[(i + 1) % c.length] = { ...nx, p1: [e[0], e[1]] };
      }
    }
  }

  // Drop ZERO-EXTENT contours (every point coincident). A shape's curve range
  // ends at the buffer's total float count, which includes trailing zero
  // PADDING; that padding reads back as degenerate SEG_LINE [0,0]→[0,0]
  // segments and groups into a spurious empty contour. Left in, it inflates
  // contours.length — defeating the single-contour LB fast path (the only route
  // that degree-reduces a corner cubic) so the shape is forced onto the CDT
  // partition, where a degree-reducible cubic renders as a kind-4 Bezout
  // crescent and UNDER-fills (a corner-control squircle would draw only its
  // interior diamond). A zero-extent contour carries no area, so
  // dropping it changes no fill; real geometry always has extent.
  const real = contours.filter((c) => {
    let xlo = Infinity,
      ylo = Infinity,
      xhi = -Infinity,
      yhi = -Infinity;
    for (const s of c)
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        if (!p) continue;
        if (p[0] < xlo) xlo = p[0];
        if (p[0] > xhi) xhi = p[0];
        if (p[1] < ylo) ylo = p[1];
        if (p[1] > yhi) yhi = p[1];
      }
    // exactly zero: padding is bit-identical zeros, and an absolute 1e-9 dropped real contours at 2^-20.
    return xhi - xlo > 0 || yhi - ylo > 0;
  });
  return real.length ? real : null;
}

/// A shape's JS segment list as the contours the builder takes, by the DECODER'S rules -- so a shape
/// streamed from segments (streamGeometry) is chained exactly as the same shape decoded from a bundle's
/// curve table (curveRangeToContours): a segment starts a new contour at an authored subpath start
/// (`subStart`) or where its start leaves the pen by more than a few float32 ulps of the magnitudes at
/// the joint, then the joins are closed onto the pen and zero-extent contours dropped. Relative, like
/// the decoder: the stream's absolute 1e-5 merged every subpath of a drawing authored at 2^-20 into one
/// contour and split a 2^20 one at rounding. An arc becomes its rational quads, as the decoder makes them (its ends pinned to the
/// stored vertices), or its chord when a radius is zero.
export function contoursFromSegs(segs) {
  const contours = [];
  let cur = null;
  let penX = NaN,
    penY = NaN;
  const pieces = [];
  for (const sg of segs) {
    if (!sg) return null;
    if (sg.type !== SEG_ARC) {
      pieces.push(sg);
      continue;
    }
    if (sg.rx === 0 || sg.ry === 0) {
      const l = mkLine(sg.p1, sg.p4);
      if (sg.subStart) l.subStart = true;
      pieces.push(l);
      continue;
    }
    const rqs = arcToRationalQuads(
      sg.cx,
      sg.cy,
      sg.rx,
      sg.ry,
      sg.theta_start,
      sg.theta_end,
      sg.phi,
    );
    if (!rqs.length) continue;
    rqs[0].p1 = sg.p1;
    rqs[rqs.length - 1].p3 = sg.p4;
    if (sg.subStart) rqs[0].subStart = true;
    for (const rq of rqs) pieces.push(rq);
  }
  for (const sg of pieces) {
    const a = sg.p1,
      e = sg.p4 || sg.p3 || sg.p2;
    const tol =
      F32_JOINT *
      Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(penX) || 0, Math.abs(penY) || 0);
    if (sg.subStart || isNaN(penX) || Math.abs(a[0] - penX) > tol || Math.abs(a[1] - penY) > tol) {
      cur = [];
      contours.push(cur);
    }
    cur.push(sg);
    penX = e[0];
    penY = e[1];
  }
  return contours.length ? finishContours(contours) : null;
}

export function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1],
      xj = poly[j][0],
      yj = poly[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- segment normalization -------------------------------------------------
// Accepts importer segs ({type, p1..p4}); a curve primitive list per contour.
export function segCtrlMid(s) {
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) return s.p2;
  if (s.type === SEG_CUBIC) return [(s.p2[0] + s.p3[0]) / 2, (s.p2[1] + s.p3[1]) / 2];
  return null;
}

export function chordEnds(s) {
  if (s.type === SEG_LINE) return s.p2;
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) return s.p3;
  return s.p4;
}

// On-curve midpoint (t=½) of a segment; null for a line (adds nothing between
// its endpoints). Used to de-degenerate a chord ring — a contour of arcs sharing
// endpoints (a vesica: two arcs, same two vertices) collapses to a zero-area
// line, which breaks the pointInPoly fill test that drives sign calibration.
export function segMidpoint(s) {
  if (s.type === SEG_LINE) return null;
  if (s.type === SEG_QUAD)
    return [(s.p1[0] + 2 * s.p2[0] + s.p3[0]) / 4, (s.p1[1] + 2 * s.p2[1] + s.p3[1]) / 4];
  if (s.type === SEG_RQUAD) {
    const w = s.w,
      dn = 2 + 2 * w;
    return [(s.p1[0] + 2 * w * s.p2[0] + s.p3[0]) / dn, (s.p1[1] + 2 * w * s.p2[1] + s.p3[1]) / dn];
  }
  return [
    (s.p1[0] + 3 * s.p2[0] + 3 * s.p3[0] + s.p4[0]) / 8,
    (s.p1[1] + 3 * s.p2[1] + 3 * s.p3[1] + s.p4[1]) / 8,
  ];
}

export function ringSignedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a) / 2;
}

// Chord ring for the even-odd fill test. Endpoints only, UNLESS that collapses
// to (near-)zero area — then re-derive with on-curve midpoints so the polygon has
// real area. Only degenerate contours change; every non-degenerate ring stays
// byte-identical (the fill calibration is tuned to the chord, so don't disturb it).
export function chordRing(segs) {
  const ring = [];
  for (const s of segs) ring.push(s.p1);
  let xlo = Infinity,
    ylo = Infinity,
    xhi = -Infinity,
    yhi = -Infinity;
  for (const p of ring) {
    if (p[0] < xlo) xlo = p[0];
    if (p[0] > xhi) xhi = p[0];
    if (p[1] < ylo) ylo = p[1];
    if (p[1] > yhi) yhi = p[1];
  }

  const diag2 = Math.max((xhi - xlo) * (xhi - xlo) + (yhi - ylo) * (yhi - ylo), 1e-12);
  if (ringSignedArea(ring) >= 1e-4 * diag2) return ring;
  const dense = [];
  for (const s of segs) {
    dense.push(s.p1);
    const m = segMidpoint(s);
    if (m) dense.push(m);
  }
  return dense;
}

/// Reverse one segment's direction. Arcs are already rational quads by the time
/// contours reach LB, so four types cover the space.
export function reverseSeg(s) {
  if (s.type === SEG_LINE) return mkLine(s.p2, s.p1, s.is_fill_only);
  if (s.type === SEG_QUAD) return mkQuad(s.p3, s.p2, s.p1);
  if (s.type === SEG_RQUAD) return mkRQuad(s.p3, s.p2, s.p1, s.w, s.circle);
  return mkCubic(s.p4, s.p3, s.p2, s.p1);
}

/// The chain invariant: fill lies to the LEFT of a contour's direction of travel.
/// Every consumer of chain geometry leans on it — chainMissCov derives its outward
/// normal from the chain DIRECTION alone (`nOut = (d.y, -d.x)`, no orientation tag),
/// so a contour that travels the wrong way reports the fill side as empty.

/// Reversal is sound precisely because the rule is parity: `inFill` counts crossings
/// mod 2, and reversing a contour flips the SIGN of each of its crossings, never the
/// COUNT. So the fill region is bit-identical before and after, and the only thing
/// that changes is the direction the chains are handed to the shader.
/// Returns a NEW contour array — never writes through to the caller's. The array
/// handed in is shared with other consumers (the morph pair builder reads the same
/// contours to pair source against destination), and reversing one in place made
/// every holed morph decline the LB route outright.
export function orientContoursForFill(contours, inFill) {
  const out = contours.slice();
  for (let ci = 0; ci < contours.length; ci++) {
    const segs = contours[ci];
    if (!segs || segs.length < 2) continue;
    // Vote across segments: a single probe can land badly (a tiny segment, an
    // offset that overshoots the local curvature), and one bad read would invert
    // a whole contour. Probe on the CURVE, not the chord — the sliver between a
    // fat arc and its chord reads as the wrong side, which is the same trap
    // calibrateInterior documents.
    let votes = 0;
    for (let si = 0; si < segs.length && Math.abs(votes) < 3; si++) {
      const s = segs[si];
      const m = segPt(s, 0.5),
        a = segPt(s, 0.5 - 1e-3),
        b = segPt(s, 0.5 + 1e-3);
      const tx = b[0] - a[0],
        ty = b[1] - a[1],
        L = Math.hypot(tx, ty);
      if (!(L > 0)) continue;
      const c0 = s.p1,
        c1 = s.type === SEG_CUBIC ? s.p4 : s.type === SEG_LINE ? s.p2 : s.p3;
      const chord = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
      // No floor: an absolute one would step past the ink of a small enough shape (a ring 6 units wide drawn at 2^-36), both probes would read outside, and the contour would get no vote and keep its direction.
      const eps = chord * 1e-3;
      const nx = ty / L,
        ny = -tx / L; // outward under the invariant
      const out = inFill([m[0] + nx * eps, m[1] + ny * eps]);
      const inn = inFill([m[0] - nx * eps, m[1] - ny * eps]);
      if (out === inn) continue; // straddles nothing: no opinion
      votes += inn ? 1 : -1; // inn === true ⇒ invariant holds
    }
    if (votes < 0) out[ci] = segs.slice().reverse().map(reverseSeg);
  }
  return out;
}

export function calibrateInterior(segs, inFill) {
  // interiorSign semantics (unchanged): +1 ⇔ a control point on the LEFT of its
  // chord (positive cross) sits on the FILL side. The original probe sampled
  // 0.01·L beside the CHORD — for fat arcs the chord sags far from the outline
  // and both sides of it can read HOLE (droplet-class same-wound evenodd inner
  // contours), silently returning -1 and inverting every inner-boundary
  // crescent (solid paint over the hole: the "flat edges" class).
  // The unambiguous probe: the midpoint BETWEEN the chord midpoint and the
  // curve midpoint always lies inside the crescent sliver, so inFill(there)
  // answers "is the control-point side of the chord filled" directly — the
  // exact question consumers (sideInFill on ctrl points) ask.
  for (const s of segs) {
    const a = s.p1,
      b = chordEnds(s);
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      L = Math.hypot(dx, dy);
    if (!(L > 0)) continue;
    const cmx = (a[0] + b[0]) / 2,
      cmy = (a[1] + b[1]) / 2;
    let qx = null,
      qy = null,
      ctl = null;
    if (s.type === SEG_QUAD) {
      qx = 0.25 * a[0] + 0.5 * s.p2[0] + 0.25 * b[0];
      qy = 0.25 * a[1] + 0.5 * s.p2[1] + 0.25 * b[1];
      ctl = s.p2;
    } else if (s.type === SEG_RQUAD) {
      const w = s.w || 1,
        d = 2 + 2 * w;
      qx = (a[0] + 2 * w * s.p2[0] + b[0]) / d;
      qy = (a[1] + 2 * w * s.p2[1] + b[1]) / d;
      ctl = s.p2;
    } else if (s.type === SEG_CUBIC) {
      qx = 0.125 * a[0] + 0.375 * s.p2[0] + 0.375 * s.p3[0] + 0.125 * b[0];
      qy = 0.125 * a[1] + 0.375 * s.p2[1] + 0.375 * s.p3[1] + 0.125 * b[1];
      ctl = [(s.p2[0] + s.p3[0]) / 2, (s.p2[1] + s.p3[1]) / 2];
    }
    if (ctl) {
      const cross = (b[0] - a[0]) * (ctl[1] - a[1]) - (b[1] - a[1]) * (ctl[0] - a[0]);
      if (Math.abs(cross) < 1e-3 * L * L) continue; // razor-ish: probe would sit on the ring edge
      const crossSign = cross > 0 ? 1 : -1;
      // 25% of the way from chord-mid to curve-mid: inside the sliver AND on the
      // chord side of the t=1/2 CHORD-RING polyline (inFill tests chord rings,
      // not true curves — a half-way probe straddles the ring edge for fat arcs).
      const filled = inFill([cmx + (qx - cmx) * 0.25, cmy + (qy - cmy) * 0.25]);
      return filled ? crossSign : -crossSign;
    }
    // straight seg: the chord IS the boundary — the original two-sided probe works
    const px = -dy / L,
      py = dx / L,
      off = 0.01 * L;
    const plus = inFill([cmx + px * off, cmy + py * off]);
    const minus = inFill([cmx - px * off, cmy - py * off]);
    if (plus === minus) continue;
    return plus ? 1 : -1;
  }
  return 0;
}

// Local "is the control point on the fill side of its chord" — replaces a
// global inFill(ctrl) with an O(1) cross-product side test using the
// per-contour interiorSign. chord a→b, control c.
export function sideInFill(a, b, c, interiorSign) {
  const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return (cr > 0 ? 1 : cr < 0 ? -1 : 0) === interiorSign;
}

// Endpoint tangents for a segment (used by edgeEndMeta / band tip packing).
export function segTangents(s) {
  // outward-agnostic tangents at the segment's start and end on-curve points
  if (s.type === SEG_LINE) {
    const d = [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]];
    return { t0: d, t1: d, end: s.p2, curve: false };
  }
  // "TOO SHORT TO GIVE A DIRECTION" IS RELATIVE TO THE SEGMENT. In world units the same curve
  // takes the first control leg at one drawing size and the fallback at another, and these
  // tangents become the band's end normals on the wire -- so the packed bundle differs on a mesh
  // that is otherwise bit-identical.
  const ex = ctlSpan(s),
    eps = 1e-9 * ex;
  if (s.type === SEG_CUBIC) {
    let t0 = [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]];
    if (Math.hypot(t0[0], t0[1]) < eps) t0 = [s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]];
    let t1 = [s.p4[0] - s.p3[0], s.p4[1] - s.p3[1]];
    if (Math.hypot(t1[0], t1[1]) < eps) t1 = [s.p4[0] - s.p2[0], s.p4[1] - s.p2[1]];
    return { t0, t1, end: s.p4, curve: true };
  }
  // quad / rquad
  let t0 = [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]];
  if (Math.hypot(t0[0], t0[1]) < eps) t0 = [s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]];
  let t1 = [s.p3[0] - s.p2[0], s.p3[1] - s.p2[1]];
  if (Math.hypot(t1[0], t1[1]) < eps) t1 = [s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]];
  return { t0, t1, end: s.p3, curve: true };
}

/// The span of a segment's control points, for the degeneracy guards above and below.
function ctlSpan(s) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const P of [s.p1, s.p2, s.p3, s.p4]) {
    if (!P) continue;
    if (P[0] < x0) x0 = P[0];
    if (P[0] > x1) x1 = P[0];
    if (P[1] < y0) y0 = P[1];
    if (P[1] > y1) y1 = P[1];
  }
  return x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
}

// Signed curvature of a Bézier at an endpoint (which=0 start, 1 end): κ = (B′×B″)/|B′|³.
export function segCurvature(s, which) {
  let d1, d2; // B′, B″ (constant for quad; linear-in-t for cubic → eval at endpoint)
  if (s.type === SEG_LINE) return 0;
  if (s.type === SEG_CUBIC) {
    const P0 = s.p1,
      P1 = s.p2,
      P2 = s.p3,
      P3 = s.p4;
    if (which === 0) {
      d1 = [3 * (P1[0] - P0[0]), 3 * (P1[1] - P0[1])];
      d2 = [6 * (P2[0] - 2 * P1[0] + P0[0]), 6 * (P2[1] - 2 * P1[1] + P0[1])];
    } else {
      d1 = [3 * (P3[0] - P2[0]), 3 * (P3[1] - P2[1])];
      d2 = [6 * (P3[0] - 2 * P2[0] + P1[0]), 6 * (P3[1] - 2 * P2[1] + P1[1])];
    }
  } else {
    // quad / rquad — treat as the integral quad (rquad κ differs slightly; fine for the ~1px cap)
    const P0 = s.p1,
      P1 = s.p2,
      P2 = s.p3;
    d1 =
      which === 0
        ? [2 * (P1[0] - P0[0]), 2 * (P1[1] - P0[1])]
        : [2 * (P2[0] - P1[0]), 2 * (P2[1] - P1[1])];
    d2 = [2 * (P2[0] - 2 * P1[0] + P0[0]), 2 * (P2[1] - 2 * P1[1] + P0[1])];
  }
  // A curvature is 1/length, and the guard that says the derivative has no direction has to be a
  // length: relative to the segment's own span, not a world-unit constant.
  const L = Math.hypot(d1[0], d1[1]);
  if (!(L > 1e-9 * ctlSpan(s))) return 0;
  return (d1[0] * d2[1] - d1[1] * d2[0]) / (L * L * L);
}

// Point on a segment at parameter t (enough for curvature fits).
export function segPt(sg, t) {
  if (sg.type === SEG_LINE)
    return [sg.p1[0] + t * (sg.p2[0] - sg.p1[0]), sg.p1[1] + t * (sg.p2[1] - sg.p1[1])];
  if (sg.type === SEG_CUBIC) {
    const u = 1 - t;
    return [
      u * u * u * sg.p1[0] +
        3 * u * u * t * sg.p2[0] +
        3 * u * t * t * sg.p3[0] +
        t * t * t * sg.p4[0],
      u * u * u * sg.p1[1] +
        3 * u * u * t * sg.p2[1] +
        3 * u * t * t * sg.p3[1] +
        t * t * t * sg.p4[1],
    ];
  }
  const u = 1 - t,
    w = sg.type === SEG_RQUAD ? sg.w || 1 : 1,
    d = u * u + 2 * u * t * w + t * t;
  return [
    (u * u * sg.p1[0] + 2 * u * t * w * sg.p2[0] + t * t * sg.p3[0]) / d,
    (u * u * sg.p1[1] + 2 * u * t * w * sg.p2[1] + t * t * sg.p3[1]) / d,
  ];
}

// End metadata for a segment's band primitive (the kind-10 cap-strip; the kind-12 curve
// band): at each endpoint, the NEIGHBOR segment's outward tangent normal, an osculating
// curvature fitted radially about the corner (κ = 2·dev/r², 0 for line neighbors), the
// corner type (+1 convex · −1 reflex · 0 straight), and whether the neighbor is a curve
// (partition against the arc's tangent plane / bisector instead of the line-line bisector).
// Generic over the own segment type too: the own end tangent and endpoint come from the
// segTangents row (which===1 on a curve is the on-curve END point, not the control point).
export function edgeEndMeta(segs, tg, si, which, interiorSign) {
  const n = segs.length;
  // THE NEIGHBOR ACROSS A CORNER IS THE NEAREST SEGMENT THAT HAS A DIRECTION. A zero-length line (importers close every
  // subpath with one, back onto its start point) is no boundary at all: its tangent is (0, 0), so taking it for the
  // neighbor typed the corner "collinear", dropped its shared plane and left the strip the coverage of its own edge
  // alone -- the exact two-plane area never ran, and a pixel whose box held only the corner kept the full half-plane
  // share. Exactly zero, not a tolerance: the partition drops precisely these edges (identical endpoints), and any
  // other length, however small, still has a direction at every scale.
  const step = which === 0 ? n - 1 : 1;
  const adjacent = (si + step) % n;
  let nb = adjacent;
  for (
    let k = 1;
    k < n && segs[nb].type === SEG_LINE && tg[nb].t0[0] === 0 && tg[nb].t0[1] === 0;
    k++
  )
    nb = (nb + step) % n;
  // Only a straight corner is resolved across it: the exact two-plane area is what a line-line corner needs. A curve on
  // either side keeps the band-chaining metadata it was packed with (a sliver's curve-neighbor tip is its own question).
  if (segs[nb].type !== SEG_LINE || segs[si].type !== SEG_LINE) nb = adjacent;
  const V = which === 0 ? segs[si].p1 : tg[si].end || segs[si].p2;
  const tOwnR = which === 0 ? tg[si].t0 : tg[si].t1,
    tNbR = which === 0 ? tg[nb].t1 : tg[nb].t0;
  const Lo = Math.hypot(tOwnR[0], tOwnR[1]) || 1,
    Ln = Math.hypot(tNbR[0], tNbR[1]) || 1;
  const to = [tOwnR[0] / Lo, tOwnR[1] / Lo],
    tn = [tNbR[0] / Ln, tNbR[1] / Ln];
  const sgn = interiorSign > 0 ? 1 : -1;
  const nN = [tn[1] * sgn, -tn[0] * sgn]; // neighbor outward normal at V
  // turn across the corner in travel order (in → out)
  const tin = which === 0 ? tn : to,
    tout = which === 0 ? to : tn;
  const cross = (tin[0] * tout[1] - tin[1] * tout[0]) * interiorSign;
  const type = cross > 0.02 ? 1 : cross < -0.02 ? -1 : 0;
  const samp = segPt(segs[nb], which === 0 ? 0.9 : 0.1);
  const dev = nN[0] * (samp[0] - V[0]) + nN[1] * (samp[1] - V[1]);
  const r2 = (samp[0] - V[0]) * (samp[0] - V[0]) + (samp[1] - V[1]) * (samp[1] - V[1]);

  const Mk =
    Math.max(Math.abs(V[0]), Math.abs(V[1]), Math.abs(samp[0]), Math.abs(samp[1])) * 2 ** -23;
  const k = r2 > Mk * Mk ? (2 * dev) / r2 : 0;
  // Direction INTO the neighbor's span from V, as a sign on perp(nN) — packed exactly so
  // the fragment's partition plane never depends on an ill-conditioned canonicalization
  // (at ~90° corners perp(nN) ⊥ the edge and a tie-break flip discards the whole band).
  const into = which === 0 ? [-tn[0], -tn[1]] : [tn[0], tn[1]];
  const tsign = into[0] * -nN[1] + into[1] * nN[0] > 0 ? 1 : 0;
  //
  // So the plane is decided HERE, once per corner, from the two travel-order tangents (tin, tout) and the outgoing
  // segment's start point. This segment's end and the next segment's start are two calls with the same (tin, tout)
  // and the same point, so both strips carry the same bits, and the vertex stage maps them into the frame the
  // fragment's center is exact in (gl_FragCoord). `cw` is the plane's normal, pointing to the outgoing edge's side.
  // null keeps the strip's own plane: a curve on either side, a zero-length edge, or a hairpin (the threshold is the
  // shader's |nOwn + nN|^2 < 0.08, which is the same number for the tangents).
  let cw = null,
    cc = null;
  if (
    segs[si].type === SEG_LINE &&
    segs[nb].type === SEG_LINE &&
    Math.hypot(tOwnR[0], tOwnR[1]) > 0 &&
    Math.hypot(tNbR[0], tNbR[1]) > 0
  ) {
    const sx = tin[0] + tout[0],
      sy = tin[1] + tout[1],
      s2 = sx * sx + sy * sy;
    if (s2 >= 0.08) {
      const sL = Math.sqrt(s2);
      cw = [sx / sL, sy / sL];
      cc = which === 0 ? segs[si].p1 : segs[nb].p1;
    }
  }
  // qn: neighbor is bandable under kind-12 (quad / rquad / cubic).
  // turn: sharp turns (|turn| ≥ LB_BAND_SHARP_TURN) pack full sampled κ;
  // shallower bandable joints still chain but with κ≡0.
  return {
    nN,
    k,
    type,
    curve: segs[nb].type !== SEG_LINE,
    tsign,
    qn: segs[nb].type === SEG_QUAD || segs[nb].type === SEG_RQUAD || segs[nb].type === SEG_CUBIC,
    turn: cross,
    cw,
    cc,
  };
}

// Barycentric coords of p in triangle (a,b,c).
// FAT arcs use the RING strip (15 verts); SHALLOW arcs keep the padded-bbox
// strip (6). Pack derives fatness via live fatArc — hull.fat still drives CDT
// tip-clip exemption and morph-pair strip-plan agreement.
export function fatArc(ax, ay, cx, cy, bx, by) {
  return (
    Math.abs((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) >=
    0.02 * ((bx - ax) * (bx - ax) + (by - ay) * (by - ay))
  );
}
