// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/segment.js — path segment primitives.
//
// Segment objects are lightweight JS values tagged with
// a numeric `type` (SEG_LINE/QUAD/CUBIC/ARC). The factories canonicalise
// shape so every consumer can branch on `.type` without surprises.
//
// `arcEndpointToCenter` / `arcToNative` / `arcToCubics` live here because
// they emit segment objects directly.

// ---- segment type tags + constructors ----
// Single source of truth: primitives/seg.js (shared with the font glyph
// readers). Re-exported here for the `svg/segment.js` import path.
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  mkLine,
  mkQuad,
  mkCubic,
} from '../primitives/seg.js';
export { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC, mkLine, mkQuad, mkCubic };

/** @typedef {import('../primitives/seg.js').Point2} Point2 */
/**
 * @typedef {object} ArcSegment An elliptical arc in center form. `p1` and `p4` are its endpoints (read-only data properties, derived from
 * the center form on first read when the caller did not pass them).
 * @property {number} type SEG_ARC
 * @property {number} cx the center x
 * @property {number} cy the center y
 * @property {number} rx the x radius (already scaled by F.6.6)
 * @property {number} ry the y radius (already scaled by F.6.6)
 * @property {number} theta_start the start angle (radians), before the phi rotation
 * @property {number} theta_end the end angle (radians)
 * @property {number} phi the x-axis rotation (radians)
 * @property {number} large_arc_flag 0 or 1
 * @property {number} sweep_flag 0 or 1
 * @property {number} [radiusScale] the F.6.6 factor when the authored radii were scaled up (greater than 1)
 * @property {Point2} p1 the start point
 * @property {Point2} p4 the end point
 * @property {boolean} [is_fill_only] set by a caller that marks a fill-only edge
 * @property {boolean} [subStart] set on the first segment of a subpath
 * @property {boolean} [openEnd] set on the last segment of an open subpath
 * @property {*} [src] the provenance tag path booleans carry across a transform
 */
/**
 * @typedef {object} ArcCenterForm The center parameterization of an SVG arc (arcEndpointToCenter).
 * @property {number} cx the center x
 * @property {number} cy the center y
 * @property {number} rx the x radius
 * @property {number} ry the y radius
 * @property {number} phi the x-axis rotation, radians
 * @property {number} theta1 the start angle, radians
 * @property {number} dtheta the signed sweep, radians
 */

// ---- stroke caps + joins ----
export const CAP_BUTT = 0,
  CAP_ROUND = 1,
  CAP_SQUARE = 2;
export const JOIN_MITER = 0,
  JOIN_ROUND = 1,
  JOIN_BEVEL = 2,
  JOIN_MITER_CLIP = 3,
  JOIN_ARCS = 4;
export const CAP_ENUM = { butt: CAP_BUTT, round: CAP_ROUND, square: CAP_SQUARE };
// SVG 2 join modes:
//   miter-clip — clip the miter spike at miterLimit (not bevel fallback)
//   arcs       — circular fillet of radius stroke-width/2 (shader: round disc)
export const JOIN_ENUM = {
  miter: JOIN_MITER,
  'miter-clip': JOIN_MITER_CLIP,
  round: JOIN_ROUND,
  arcs: JOIN_ARCS,
  bevel: JOIN_BEVEL,
};

/// Construct an arc segment. p1/p4 (endpoints) are lazily computed on
/// first read then cached as plain data properties, so hot paths
/// (segCtrlBboxInto, pathBbox, segStart/segEnd) that read them many
/// times per arc don't re-allocate an [x, y] array per read.
///
/// THE PATH'S own ENDPOINTS, WHEN THERE ARE ANY. An arc drawn from a path command starts at the pen and
/// ends at the command's point -- the very numbers the segments beside it store -- so a caller that has them passes
/// them (`p1`, `p4`), and they are kept as given. Derived from the center form instead, they come back off the path's
/// vertex by the rounding of cos and sin, and two segments sharing a vertex no longer share its value: the encoder
/// stores these endpoints in the arc's record, and every walker takes its end signs from them.
/**
 * @param {number} cx the center x
 * @param {number} cy the center y
 * @param {number} rx the x radius (already scaled)
 * @param {number} ry the y radius (already scaled)
 * @param {number} thetaStart the start angle in radians
 * @param {number} thetaEnd the end angle in radians
 * @param {number} phi x-axis rotation in radians
 * @param {number|boolean} largeArc the SVG large-arc flag
 * @param {number|boolean} sweep the SVG sweep flag
 * @param {Point2|null} [p1] the path's own start point, kept as given
 * @param {Point2|null} [p4] the path's own end point, kept as given
 * @param {number} [radiusScale] the F.6.6 scale factor applied to the authored radii (1 when none)
 * @returns {ArcSegment}
 */
export function mkArc(
  cx,
  cy,
  rx,
  ry,
  thetaStart,
  thetaEnd,
  phi,
  largeArc,
  sweep,
  p1 = null,
  p4 = null,
  radiusScale = 1,
) {
  const seg = /** @type {ArcSegment} */ (
    /** @type {unknown} */ ({
      type: SEG_ARC,
      cx,
      cy,
      rx,
      ry,
      theta_start: thetaStart,
      theta_end: thetaEnd,
      phi,
      large_arc_flag: Number(largeArc) | 0,
      sweep_flag: Number(sweep) | 0,
    })
  );
  // The factor F.6.6 scaled the AUTHORED radii up by (rx, ry above are already scaled). A morph interpolates the authored numbers
  // and normalizes at each pose, as SVG path animation does, so it needs them back: authored = rx / radiusScale.
  if (radiusScale > 1) seg.radiusScale = radiusScale;
  if (p1) Object.defineProperty(seg, 'p1', { value: p1, writable: false, enumerable: true });
  if (p4) Object.defineProperty(seg, 'p4', { value: p4, writable: false, enumerable: true });
  if (!p1)
    Object.defineProperty(seg, 'p1', {
      configurable: true,
      get() {
        const cp = Math.cos(phi),
          sp = Math.sin(phi);
        const ct = Math.cos(thetaStart),
          st = Math.sin(thetaStart);
        const v = [cx + cp * rx * ct - sp * ry * st, cy + sp * rx * ct + cp * ry * st];
        Object.defineProperty(seg, 'p1', { value: v, writable: false, enumerable: true });
        return v;
      },
    });
  if (!p4)
    Object.defineProperty(seg, 'p4', {
      configurable: true,
      get() {
        const cp = Math.cos(phi),
          sp = Math.sin(phi);
        const ct = Math.cos(thetaEnd),
          st = Math.sin(thetaEnd);
        const v = [cx + cp * rx * ct - sp * ry * st, cy + sp * rx * ct + cp * ry * st];
        Object.defineProperty(seg, 'p4', { value: v, writable: false, enumerable: true });
        return v;
      },
    });
  return seg;
}

// ---- finite float32 range ----

/// The largest coordinate a segment may carry into the float32 tables: 2^125, a quarter of the float32 maximum, so that a
/// bounding box (a center plus a radius, a sum of two such coordinates) stays finite too.
export const F32_COORD_MAX = 2 ** 125;

/// The segments with every coordinate clamped to +-F32_COORD_MAX (the list itself, untouched, when none is beyond it -- the
/// ordinary case costs one scan). A coordinate past float32 would be stored as Infinity in the curve table and the row's bounding box,
/// and take the whole bundle's bounds and its neighbors' bands with it; clamped, the shape is wrong only where it is already beyond
/// anything float32 can place. `info.clamped` says whether anything was.
export function clampSegsToF32(segs, info = null) {
  const M = F32_COORD_MAX;
  const bad = (v) => v > M || v < -M;
  const badP = (p) => p && (bad(p[0]) || bad(p[1]));
  let first = -1;
  for (let i = 0; i < segs.length && first < 0; i++) {
    const s = segs[i];
    if (s.type === SEG_ARC) {
      if (bad(s.cx) || bad(s.cy) || bad(s.rx) || bad(s.ry) || badP(s.p1) || badP(s.p4)) first = i;
    } else if (badP(s.p1) || badP(s.p2) || badP(s.p3) || badP(s.p4)) first = i;
  }
  if (first < 0) return segs;
  if (info) info.clamped = true;
  const c = (v) => (v > M ? M : v < -M ? -M : v);
  const cp = (p) => (p ? [c(p[0]), c(p[1])] : p);
  const out = segs.slice();
  for (let i = first; i < segs.length; i++) {
    const s = segs[i];
    let t;
    if (s.type === SEG_ARC) {
      t = mkArc(
        c(s.cx),
        c(s.cy),
        c(s.rx),
        c(s.ry),
        s.theta_start,
        s.theta_end,
        s.phi,
        s.large_arc_flag,
        s.sweep_flag,
        cp(s.p1),
        cp(s.p4),
        s.radiusScale || 1,
      );
      if (s.is_fill_only) t.is_fill_only = s.is_fill_only;
      if (s.subStart) t.subStart = true;
      if (s.openEnd) t.openEnd = true;
    } else {
      t = { ...s };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (s[k]) t[k] = cp(s[k]);
    }
    out[i] = t;
  }
  return out;
}

// ---- start/end accessors ----

/// A segment with no length and no direction: every point it is made of is the same point. (An arc with non-zero radii
/// that starts where it ends is a closed loop, not this; a zero-radius arc is the chord between its endpoints.)
///
/// A fill-only segment (the synthetic line that closes a contour back onto its start, svg/fillNormalize.js) is never one: it is
/// fill structure, already ignored by the stroke walk, and its neighbors have always paired through it.
///
/// "The same point" is judged at the precision the points were COMPUTED with: a few float64 ulps of their document coordinates (ZERO_REL).
/// A closing point that one transform lands on the pen by rounding and another misses by one ulp is the same point; exact equality would
/// make the answer depend on where the art sits (a bundle stored near its origin, `org`, has finer ulps than the same art at its document
/// position, and would read a one-ulp closing line as a segment with a direction).
export const ZERO_REL = 2 ** -49;
export function isZeroLengthSeg(s, org = null) {
  if (s.is_fill_only) return false;
  const ox = org ? org[0] : 0,
    oy = org ? org[1] : 0;
  const same = (p, q) => {
    if (p[0] === q[0] && p[1] === q[1]) return true;
    const tol =
      ZERO_REL *
      Math.max(Math.abs(p[0] + ox), Math.abs(p[1] + oy), Math.abs(q[0] + ox), Math.abs(q[1] + oy));
    return Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
  };
  if (s.type === SEG_LINE) return same(s.p1, s.p2);
  if (s.type === SEG_QUAD) return same(s.p1, s.p2) && same(s.p1, s.p3);
  if (s.type === SEG_CUBIC) return same(s.p1, s.p2) && same(s.p1, s.p3) && same(s.p1, s.p4);
  if (s.type === SEG_ARC) return s.rx === 0 && s.ry === 0 && same(s.p1, s.p4);
  return false;
}

const _ZERO_PT = [0, 0];
// A swept angle at or past this is a full revolution, whose endpoints coincide.
// The slack only needs to stay below the smallest gap a caller means to leave
// open, and a 1e-6 rad gap is already far below one emitted digit.
const FULL_SWEEP = Math.PI * 2 - 1e-6;

export function segStartEnd(s) {
  if (s.type === SEG_LINE) return [s.p1, s.p2];
  if (s.type === SEG_QUAD) return [s.p1, s.p3];
  if (s.type === SEG_CUBIC) return [s.p1, s.p4];
  if (s.type === SEG_ARC) return [s.p1, s.p4];
  return [
    [0, 0],
    [0, 0],
  ];
}

/// Scalar accessor — skips the wrapper [p1, p2] tuple from segStartEnd
/// when callers only need start. Hot in splitSubpaths/Into and the
/// seg-pairing loop.
export function segStart(s) {
  if (s.type === SEG_LINE || s.type === SEG_QUAD || s.type === SEG_CUBIC || s.type === SEG_ARC)
    return s.p1;
  return _ZERO_PT;
}
export function segEnd(s) {
  if (s.type === SEG_LINE) return s.p2;
  if (s.type === SEG_QUAD) return s.p3;
  if (s.type === SEG_CUBIC) return s.p4;
  if (s.type === SEG_ARC) return s.p4;
  return _ZERO_PT;
}

export const JOINT_REL = 4 * 2 ** -23;
/// What an arc endpoint's error is proportional to (0 for a record that stores its endpoints).
export function jointMag(s) {
  return s && s.type === SEG_ARC
    ? Math.max(Math.abs(s.cx), Math.abs(s.cy)) + Math.max(Math.abs(s.rx), Math.abs(s.ry))
    : 0;
}
export function pointsMeet(p, q, magP = 0, magQ = 0) {
  const tol =
    JOINT_REL *
    Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(q[0]), Math.abs(q[1]), magP, magQ);
  return Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
}

// Format one coordinate for a path `d` string: round to 10^-digits (compact, no visible drift).
// Module-scoped (not a per-call closure — segsToPathD runs per shape per frame on the native
// streaming road) with an integer fast path for whole numbers. `digits` is 4 for a path a unit or
// more across -- a fixed 1e-4 there -- and grows as the path shrinks: a fixed 1e-4 would round a path
// drawn at 2^-20 to a point.
function fmtCoord(n, digits = 4) {
  if (Number.isInteger(n)) return '' + n;
  const k = 10 ** digits;
  return (Math.round(n * k) / k).toString();
}

/// Serialize a list of segments (the `{ type, p1..p4 }` form the mk*
/// factories produce) to an SVG path `d` string. Starts a new subpath
/// with `M` wherever the next segment's start is discontinuous from the
/// previous segment's end, and closes each subpath with `Z` (glyph
/// outlines and fills are closed loops). Used to bake `<text>` glyph
/// shapes into the retained svgSource so the native-SVG fallback's
/// element list matches the bundle's shape list 1:1. Coordinates are
/// rounded to 1e-4 by default; roundTrip retains coordinates for subsequent transforms.
export function segsToPathD(segs, roundTrip = false) {
  if (!segs || !segs.length) return '';
  let d = '';
  let penX = NaN,
    penY = NaN,
    penMag = 0;
  let open = false;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs) {
    const pts =
      s.type === SEG_ARC
        ? [
            [s.cx - Math.max(s.rx, s.ry), s.cy - Math.max(s.rx, s.ry)],
            [s.cx + Math.max(s.rx, s.ry), s.cy + Math.max(s.rx, s.ry)],
          ]
        : [s.p1, s.p2, s.p3, s.p4];
    for (const p of pts) {
      if (!p) continue;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  }
  const ext = Math.max(x1 - x0, y1 - y0);
  const digits = ext > 0 && ext < 1 ? Math.min(300, 4 - Math.floor(Math.log10(ext))) : 4;
  const f = roundTrip ? String : (n) => fmtCoord(n, digits);
  for (const s of segs) {
    const a = segStart(s),
      b = segEnd(s);
    if (isNaN(penX) || !pointsMeet(a, [penX, penY], jointMag(s), penMag)) {
      if (open) d += 'Z';
      d += 'M' + f(a[0]) + ' ' + f(a[1]);
      open = true;
    }
    if (s.type === SEG_LINE) {
      d += 'L' + f(b[0]) + ' ' + f(b[1]);
    } else if (s.type === SEG_QUAD) {
      d += 'Q' + f(s.p2[0]) + ' ' + f(s.p2[1]) + ' ' + f(b[0]) + ' ' + f(b[1]);
    } else if (s.type === SEG_CUBIC) {
      d +=
        'C' +
        f(s.p2[0]) +
        ' ' +
        f(s.p2[1]) +
        ' ' +
        f(s.p3[0]) +
        ' ' +
        f(s.p3[1]) +
        ' ' +
        f(b[0]) +
        ' ' +
        f(b[1]);
    } else if (s.type === SEG_ARC) {
      const rotDeg = ((s.phi || 0) * 180) / Math.PI;
      const sweepAng = (s.theta_end || 0) - (s.theta_start || 0);
      if (Math.abs(sweepAng) >= FULL_SWEEP) {
        // A whole revolution ends where it began, and SVG §F.6.2 says an `A`
        // whose endpoints are identical "is equivalent to omitting the
        // elliptical arc segment entirely" — the shape would simply not draw.
        // svg/shape.js encodes every <circle> and <ellipse> as ONE arc over
        // [-PI, PI], so this is the common case, not a corner one.
        //
        // Two half sweeps put the endpoints a diameter apart, where no rounding
        // can merge them. Splitting HERE covers every consumer at once — native
        // streaming, the WebGL stream's path cache, and glyph-to-path — instead
        // of each having to remember.
        const mid = (s.theta_start || 0) + sweepAng / 2;
        const cp = Math.cos(s.phi || 0),
          sp = Math.sin(s.phi || 0);
        const at = (t) => [
          s.cx + cp * s.rx * Math.cos(t) - sp * s.ry * Math.sin(t),
          s.cy + sp * s.rx * Math.cos(t) + cp * s.ry * Math.sin(t),
        ];
        const m = at(mid);
        const half = s.sweep_flag ? 1 : 0;
        // Each half spans exactly PI, so neither is a "large" arc.
        d +=
          'A' +
          f(s.rx) +
          ' ' +
          f(s.ry) +
          ' ' +
          f(rotDeg) +
          ' 0 ' +
          half +
          ' ' +
          f(m[0]) +
          ' ' +
          f(m[1]) +
          'A' +
          f(s.rx) +
          ' ' +
          f(s.ry) +
          ' ' +
          f(rotDeg) +
          ' 0 ' +
          half +
          ' ' +
          f(b[0]) +
          ' ' +
          f(b[1]);
      } else {
        d +=
          'A' +
          f(s.rx) +
          ' ' +
          f(s.ry) +
          ' ' +
          f(rotDeg) +
          ' ' +
          (s.large_arc_flag ? 1 : 0) +
          ' ' +
          (s.sweep_flag ? 1 : 0) +
          ' ' +
          f(b[0]) +
          ' ' +
          f(b[1]);
      }
    }
    penX = b[0];
    penY = b[1];
    penMag = jointMag(s);
  }
  if (open) d += 'Z';
  return d;
}

// ---- arc helpers ----

/// SVG endpoint parameterization → center parameterization, per
/// SVG path spec Appendix F.6.5. Returns { cx, cy, rx, ry, phi,
/// theta1, dtheta }. Handles the "out-of-range radii" correction
/// (lambda scaling per F.6.6).
/**
 * @param {Point2} p1 the start point
 * @param {number} rx the x radius
 * @param {number} ry the y radius
 * @param {number} phiDeg the x-axis rotation in degrees
 * @param {number|boolean} large the large-arc flag
 * @param {number|boolean} sweep the sweep flag
 * @param {Point2} p2 the end point
 * @returns {ArcCenterForm}
 */
export function arcEndpointToCenter(p1, rx, ry, phiDeg, large, sweep, p2) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  let phi = (phiDeg * Math.PI) / 180;
  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  // SVG renders a zero-radius arc as its endpoint chord. Keep an arc record for
  // morph topology, but encode that chord as a half-turn degenerate ellipse.
  if (rx === 0 || ry === 0) {
    const dx = p2[0] - p1[0],
      dy = p2[1] - p1[1];
    const chord = Math.hypot(dx, dy);
    if (chord === 0) {
      return {
        cx: p1[0],
        cy: p1[1],
        rx: 0,
        ry: 0,
        phi,
        theta1: 0,
        dtheta: sweep ? Math.PI : -Math.PI,
      };
    }
    const cx = (p1[0] + p2[0]) * 0.5,
      cy = (p1[1] + p2[1]) * 0.5;
    const angle = Math.atan2(dy, dx),
      r = chord * 0.5;
    if (ry === 0) {
      phi = angle;
      return { cx, cy, rx: r, ry: 0, phi, theta1: Math.PI, dtheta: sweep ? Math.PI : -Math.PI };
    }
    phi = angle - Math.PI * 0.5;
    return {
      cx,
      cy,
      rx: 0,
      ry: r,
      phi,
      theta1: -Math.PI * 0.5,
      dtheta: sweep ? Math.PI : -Math.PI,
    };
  }
  const mx = (p1[0] - p2[0]) * 0.5;
  const my = (p1[1] - p2[1]) * 0.5;
  const x1p = cp * mx + sp * my;
  const y1p = -sp * mx + cp * my;
  // F.6.5 as written serves every arc whose radius is within a factor of 8192 of its chord (a sweep over ~1e-4 rad, where acos keeps
  // 7e-9 relative to the chord) and whose radii keep rx^2*ry^2 representable: it is the form the importer has always used, so ordinary art
  // converts bit for bit as before. The rest take the unit-coordinate form below.
  {
    const rmax = Math.max(rx, ry),
      rmin = Math.min(rx, ry),
      chord = 2 * Math.hypot(mx, my);
    if (rmax <= 8192 * chord && rmax < 1e70 && rmin > 1e-70)
      return arcEndpointToCenterDirect(rx, ry, phi, cp, sp, large, sweep, p1, p2, x1p, y1p);
  }
  // Everything below runs on the half chord in UNIT-ELLIPSE coordinates, (u, v) = (x1p/rx, y1p/ry), whose length h is 1
  // when the radii are just large enough. Forming rx^2*ry^2 (as F.6.5 writes it) overflows for radii past 1e77 and the
  // angles through acos lose the sweep of an arc whose radius dwarfs its chord; in unit coordinates the radius drops out,
  // and atan2(cross, dot) is exact at every sweep.
  let u = x1p / rx,
    v = y1p / ry;
  const l2 = u * u + v * v;
  let h = Number.isFinite(l2) && l2 > 0 ? Math.sqrt(l2) : Math.hypot(u, v);
  if (!Number.isFinite(h)) {
    // radii so small against the chord that the ratio overflows: the radii are scaled up to the chord anyway
    rx = Math.abs(x1p) || 1;
    ry = Math.abs(y1p) || 1;
    u = x1p / rx;
    v = y1p / ry;
    h = Math.hypot(u, v);
  }
  if (h > 1) {
    rx *= h;
    ry *= h;
    u /= h;
    v /= h;
    h = 1;
  } // F.6.6: scale the radii up to the chord
  // unit direction of the half chord (any direction when the endpoints coincide: there is no arc to place)
  const nu = h > 0 ? u / h : 1,
    nv = h > 0 ? v / h : 0;
  // distance of the center from the chord midpoint, in unit coordinates: sqrt(1 - h^2), on the side the flags pick
  const w = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, 1 - h * h));
  const cxp = w * rx * nv;
  const cyp = -w * ry * nu;
  const cx = cp * cxp - sp * cyp + (p1[0] + p2[0]) * 0.5;
  const cy = sp * cxp + cp * cyp + (p1[1] + p2[1]) * 0.5;
  // start vector (u - w*nv, v + w*nu) and end vector (-u - w*nv, -v + w*nu), from the center, in unit coordinates
  const sx = u - w * nv,
    sy = v + w * nu;
  const ex = -u - w * nv,
    ey = -v + w * nu;
  const theta1 = Math.atan2(sy, sx);
  const cross = sx * ey - sy * ex;
  let dtheta = Math.atan2(cross === 0 ? 0 : cross, sx * ex + sy * ey); // a zero cross is +0: the half turn is +PI
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, theta1, dtheta };
}

/// F.6.5 / F.6.6 as the spec writes them (see arcEndpointToCenter for when this form is used).
function arcEndpointToCenterDirect(rx, ry, phi, cp, sp, large, sweep, p1, p2, x1p, y1p) {
  let lam = (x1p / rx) ** 2 + (y1p / ry) ** 2;
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let sq = Math.sqrt(Math.max(num / den, 0));
  if (large === sweep) sq = -sq;
  const cxp = (sq * rx * y1p) / ry;
  const cyp = (-sq * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (p1[0] + p2[0]) * 0.5;
  const cy = sp * cxp + cp * cyp + (p1[1] + p2[1]) * 0.5;
  const vecAng = (ux, uy, vx, vy) => {
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (n === 0) return 0;
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n));
    const a = Math.acos(c);
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta1 = vecAng(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = vecAng((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, theta1, dtheta };
}

/// An arc whose bulge off its chord is below float32 resolution of the chord is its chord. The center form stores the sweep as
/// two float32 angles and the center as a float32 point, so a radius far beyond the chord (a sweep under 2^-22 rad) leaves the
/// body of the arc to rounding -- the shipped walk drew nothing for R = 1e8 and a wrong arc for 1e7. The sagitta is at most
/// max(rx, ry) * dtheta^2 / 8; at or under 2^-22 of the chord the line is the arc to float32 precision, at every scale.
export function arcIsFlat(c, p1, p2) {
  const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const d = Math.abs(c.dtheta);
  return chord > 0 && (Math.max(c.rx, c.ry) * d * d) / 8 <= chord * 2 ** -22;
}

/// Longest sweep a single native ARC record is allowed to span.
///
/// Nothing about the RASTERIZER needs this — it ray-casts an arc of any sweep
/// exactly. The MORPH does. A morph interpolates an arc in ENDPOINT form
/// (p1, p4, rx, ry, phi, flags) — the form the SVG author wrote — because that
/// is the only exact form whose componentwise lerp keeps an arc's endpoints
/// welded to its neighbors' (see morphCore.prepareArcMorph). Endpoint form
/// cannot express a CLOSED arc: at a full turn p1 == p4 and the two points no
/// longer pick out an ellipse. SVG has the same hole, which is why authors write
/// a circle as two half-arcs.
///
/// Mantle does NOT — shape.js emits a <circle>/<ellipse> as a single 360-degree
/// arc. So cap the sweep at a half turn here and such an arc lands as two
/// records, restoring the same well-conditioned endpoint form an author would
/// have written by hand.
///
/// Splitting an arc into arcs is exact — the pieces trace the identical ellipse,
/// so nothing about static rendering changes. The only cost is one extra segment
/// record per closed ellipse.
export const MAX_ARC_SPAN = Math.PI;

/// Split an arc into pieces each spanning at most MAX_ARC_SPAN. Exact: same
/// ellipse, same endpoints, same sweep direction. Non-arcs pass through.
export function splitArcSpan(s, maxSpan = MAX_ARC_SPAN) {
  if (s.type !== SEG_ARC) return [s];
  const dtheta = s.theta_end - s.theta_start;
  const n = Math.ceil(Math.abs(dtheta) / maxSpan - 1e-9);
  if (n <= 1) return [s];
  const step = dtheta / n;
  const out = new Array(n);
  // Each split angle and its point once, shared by the two pieces that meet there, so they share the vertex's value
  // exactly; the ends are the arc's own. The last piece lands exactly on theta_end -- no accumulated drift.
  const th = (i) => (i === n ? s.theta_end : s.theta_start + step * i);
  const cp = Math.cos(s.phi),
    sp = Math.sin(s.phi);
  const at = (t) => {
    const ct = Math.cos(t),
      st = Math.sin(t);
    return [s.cx + cp * s.rx * ct - sp * s.ry * st, s.cy + sp * s.rx * ct + cp * s.ry * st];
  };
  let pPrev = s.p1;
  for (let i = 0; i < n; i++) {
    const pNext = i === n - 1 ? s.p4 : at(th(i + 1));
    // Every piece is under a half-turn, so large_arc is 0 by construction; the
    // sweep direction is the sign of the (unchanged) step.
    out[i] = mkArc(
      s.cx,
      s.cy,
      s.rx,
      s.ry,
      th(i),
      th(i + 1),
      s.phi,
      0,
      step > 0 ? 1 : 0,
      pPrev,
      pNext,
    );
    if (s.is_fill_only) out[i].is_fill_only = s.is_fill_only;
    pPrev = pNext;
  }
  // The first piece inherits the subpath-start marker — splitting a segment must
  // not move where a subpath begins.
  if (s.subStart) out[0].subStart = true;
  if (s.openEnd) out[out.length - 1].openEnd = true; // and where an open subpath ends (path.js)
  return out;
}

/// Apply splitArcSpan across a whole segment list.
export function splitArcSpans(segs, maxSpan = MAX_ARC_SPAN) {
  let hasWide = false;
  for (const s of segs) {
    if (s.type === SEG_ARC && Math.abs(s.theta_end - s.theta_start) > maxSpan + 1e-9) {
      hasWide = true;
      break;
    }
  }
  if (!hasWide) return segs; // overwhelmingly the common case — don't re-alloc
  const out = [];
  for (const s of segs) {
    if (s.type === SEG_ARC) out.push(...splitArcSpan(s, maxSpan));
    else out.push(s);
  }
  return out;
}

/// Build a native SVG_ARC segment from endpoint-form parameters.
///
/// A zero-radius arc remains an ARC to preserve morph topology.
/// arcEndpointToCenter encodes the SVG-required chord as a degenerate ellipse.
///
/// The one case that still becomes a line: coincident endpoints WITH non-zero radii — a full circle
/// written as a single arc, which has no endpoint form at all (p1==p4 does not pick out an
/// ellipse). Those are authored/split elsewhere as two half-arcs (see MAX_ARC_SPAN).
export function arcToNative(p1, rx, ry, phiDeg, large, sweep, p2) {
  if (rx !== 0 && ry !== 0 && p1[0] === p2[0] && p1[1] === p2[1]) return mkLine(p1, p2);
  const c = arcEndpointToCenter(p1, rx, ry, phiDeg, large, sweep, p2);
  if (rx !== 0 && ry !== 0 && arcIsFlat(c, p1, p2)) return mkLine(p1, p2);
  // the path's own points, which the neighbors store
  // F.6.6 scales both radii by one factor, so one number restores the authored pair
  const radiusScale = rx !== 0 && ry !== 0 ? c.rx / Math.abs(rx) : 1;
  return mkArc(
    c.cx,
    c.cy,
    c.rx,
    c.ry,
    c.theta1,
    c.theta1 + c.dtheta,
    c.phi,
    large,
    sweep,
    [p1[0], p1[1]],
    [p2[0], p2[1]],
    radiusScale,
  );
}

/// Cubic-Bezier approximation of an SVG arc. Splits into <=90 degree pieces, each with the standard handle length
/// 4/3*tan(dt/4) of the swept angle dt; the radial error of a 90 degree piece is 2.7e-4 of the radius (a circle of 4 pieces),
/// and falls roughly as dt^6 below that.
///
/// Zero-radius arcs become collinear cubics instead of a line, preserving topology
/// when a transformed morph pose grows into a non-degenerate arc.
/**
 * @param {Point2} p1 the start point
 * @param {number} rx the x radius
 * @param {number} ry the y radius
 * @param {number} phiDeg the x-axis rotation in degrees
 * @param {number|boolean} large the large-arc flag
 * @param {number|boolean} sweep the sweep flag
 * @param {Point2} p2 the end point
 * @returns {Array<import('../primitives/seg.js').LineSegment | import('../primitives/seg.js').CubicSegment>}
 */
export function arcToCubics(p1, rx, ry, phiDeg, large, sweep, p2) {
  if (rx !== 0 && ry !== 0 && p1[0] === p2[0] && p1[1] === p2[1]) return [mkLine(p1, p2)];
  const c = arcEndpointToCenter(p1, rx, ry, phiDeg, large, sweep, p2);
  if (rx !== 0 && ry !== 0 && arcIsFlat(c, p1, p2)) return [mkLine(p1, p2)];
  const n = Math.max(1, Math.ceil(Math.abs(c.dtheta) / (Math.PI / 2)));
  const dt = c.dtheta / n;
  const out = [];
  const cp = Math.cos(c.phi),
    sp = Math.sin(c.phi);
  for (let i = 0; i < n; i++) {
    const t0 = c.theta1 + i * dt,
      t1 = t0 + dt;
    const alpha = (4 / 3) * Math.tan(dt / 4);
    const p0x = c.cx + c.rx * cp * Math.cos(t0) - c.ry * sp * Math.sin(t0);
    const p0y = c.cy + c.rx * sp * Math.cos(t0) + c.ry * cp * Math.sin(t0);
    const p3x = c.cx + c.rx * cp * Math.cos(t1) - c.ry * sp * Math.sin(t1);
    const p3y = c.cy + c.rx * sp * Math.cos(t1) + c.ry * cp * Math.sin(t1);
    const dp0x = -c.rx * cp * Math.sin(t0) - c.ry * sp * Math.cos(t0);
    const dp0y = -c.rx * sp * Math.sin(t0) + c.ry * cp * Math.cos(t0);
    const dp3x = -c.rx * cp * Math.sin(t1) - c.ry * sp * Math.cos(t1);
    const dp3y = -c.rx * sp * Math.sin(t1) + c.ry * cp * Math.cos(t1);
    out.push(
      mkCubic(
        [p0x, p0y],
        [p0x + alpha * dp0x, p0y + alpha * dp0y],
        [p3x - alpha * dp3x, p3y - alpha * dp3y],
        [p3x, p3y],
      ),
    );
  }
  return out;
}
