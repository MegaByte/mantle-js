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
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC, mkLine, mkQuad, mkCubic,
} from '../primitives/seg.js';
export { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC, mkLine, mkQuad, mkCubic };

// ---- stroke caps + joins ----
export const CAP_BUTT = 0, CAP_ROUND = 1, CAP_SQUARE = 2;
export const JOIN_MITER = 0, JOIN_ROUND = 1, JOIN_BEVEL = 2, JOIN_MITER_CLIP = 3, JOIN_ARCS = 4;
export const CAP_ENUM = { butt: CAP_BUTT, round: CAP_ROUND, square: CAP_SQUARE };
// SVG 2 join modes:
//   miter-clip — clip the miter spike at miterLimit (not bevel fallback)
//   arcs       — circular fillet of radius stroke-width/2 (shader: round disc)
export const JOIN_ENUM = {
  miter:        JOIN_MITER,
  'miter-clip': JOIN_MITER_CLIP,
  round:        JOIN_ROUND,
  arcs:         JOIN_ARCS,
  bevel:        JOIN_BEVEL,
};

/// Construct an arc segment. p1/p4 (endpoints) are lazily computed on
/// first read then cached as plain data properties, so hot paths
/// (segCtrlBboxInto, pathBbox, segStart/segEnd) that read them many
/// times per arc don't re-allocate an [x, y] array per read.
export function mkArc(cx, cy, rx, ry, thetaStart, thetaEnd, phi, largeArc, sweep) {
  const seg = {
    type: SEG_ARC, cx, cy, rx, ry,
    theta_start: thetaStart, theta_end: thetaEnd, phi,
    large_arc_flag: largeArc | 0, sweep_flag: sweep | 0,
  };
  Object.defineProperty(seg, 'p1', {
    configurable: true,
    get() {
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const ct = Math.cos(thetaStart), st = Math.sin(thetaStart);
      const v = [cx + cp*rx*ct - sp*ry*st, cy + sp*rx*ct + cp*ry*st];
      Object.defineProperty(seg, 'p1', { value: v, writable: false, enumerable: true });
      return v;
    },
  });
  Object.defineProperty(seg, 'p4', {
    configurable: true,
    get() {
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const ct = Math.cos(thetaEnd), st = Math.sin(thetaEnd);
      const v = [cx + cp*rx*ct - sp*ry*st, cy + sp*rx*ct + cp*ry*st];
      Object.defineProperty(seg, 'p4', { value: v, writable: false, enumerable: true });
      return v;
    },
  });
  return seg;
}

// ---- start/end accessors ----

const _ZERO_PT = [0, 0];

export function segStartEnd(s) {
  if (s.type === SEG_LINE)  return [s.p1, s.p2];
  if (s.type === SEG_QUAD)  return [s.p1, s.p3];
  if (s.type === SEG_CUBIC) return [s.p1, s.p4];
  if (s.type === SEG_ARC)   return [s.p1, s.p4];
  return [[0,0],[0,0]];
}

/// Scalar accessor — skips the wrapper [p1, p2] tuple from segStartEnd
/// when callers only need start. Hot in splitSubpaths/Into and the
/// seg-pairing loop.
export function segStart(s) {
  if (s.type === SEG_LINE || s.type === SEG_QUAD || s.type === SEG_CUBIC || s.type === SEG_ARC) return s.p1;
  return _ZERO_PT;
}
export function segEnd(s) {
  if (s.type === SEG_LINE)  return s.p2;
  if (s.type === SEG_QUAD)  return s.p3;
  if (s.type === SEG_CUBIC) return s.p4;
  if (s.type === SEG_ARC)   return s.p4;
  return _ZERO_PT;
}

// Format one coordinate for a path `d` string: round to 1e-4 (compact, no
// visible drift). Module-scoped (not a per-call closure — segsToPathD runs per
// shape per frame on the native streaming road) with an integer fast path that
// skips the ×1e4 round/÷ + float toString for whole numbers.
function fmtCoord(n) {
  if (Number.isInteger(n)) return '' + n;
  return (Math.round(n * 1e4) / 1e4).toString();
}

/// Serialize a list of segments (the `{ type, p1..p4 }` form the mk*
/// factories produce) to an SVG path `d` string. Starts a new subpath
/// with `M` wherever the next segment's start is discontinuous from the
/// previous segment's end, and closes each subpath with `Z` (glyph
/// outlines and fills are closed loops). Used to bake `<text>` glyph
/// shapes into the retained svgSource so the native-SVG fallback's
/// element list matches the bundle's shape list 1:1. Coordinates are
/// rounded to 1e-4 to keep the string compact without visible drift.
export function segsToPathD(segs) {
  if (!segs || !segs.length) return '';
  let d = '';
  let penX = NaN, penY = NaN;
  let open = false;
  const f = fmtCoord;
  for (const s of segs) {
    const a = segStart(s), b = segEnd(s);
    if (isNaN(penX) || Math.abs(a[0] - penX) > 1e-4 || Math.abs(a[1] - penY) > 1e-4) {
      if (open) d += 'Z';
      d += 'M' + f(a[0]) + ' ' + f(a[1]);
      open = true;
    }
    if (s.type === SEG_LINE) {
      d += 'L' + f(b[0]) + ' ' + f(b[1]);
    } else if (s.type === SEG_QUAD) {
      d += 'Q' + f(s.p2[0]) + ' ' + f(s.p2[1]) + ' ' + f(b[0]) + ' ' + f(b[1]);
    } else if (s.type === SEG_CUBIC) {
      d += 'C' + f(s.p2[0]) + ' ' + f(s.p2[1]) + ' ' + f(s.p3[0]) + ' ' + f(s.p3[1])
              + ' ' + f(b[0]) + ' ' + f(b[1]);
    } else if (s.type === SEG_ARC) {
      const rotDeg = (s.phi || 0) * 180 / Math.PI;
      d += 'A' + f(s.rx) + ' ' + f(s.ry) + ' ' + f(rotDeg) + ' '
              + (s.large_arc_flag ? 1 : 0) + ' ' + (s.sweep_flag ? 1 : 0) + ' '
              + f(b[0]) + ' ' + f(b[1]);
    }
    penX = b[0]; penY = b[1];
  }
  if (open) d += 'Z';
  return d;
}

// ---- arc helpers ----

/// SVG endpoint parameterisation → center parameterisation, per
/// SVG path spec Appendix F.6.5. Returns { cx, cy, rx, ry, phi,
/// theta1, dtheta }. Handles the "out-of-range radii" correction
/// (lambda scaling per F.6.6).
export function arcEndpointToCenter(p1, rx, ry, phiDeg, large, sweep, p2) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  let phi = phiDeg * Math.PI / 180;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  // SVG renders a zero-radius arc as its endpoint chord. Keep an arc record for
  // morph topology, but encode that chord as a half-turn degenerate ellipse.
  if (rx === 0 || ry === 0) {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const chord = Math.hypot(dx, dy);
    if (chord === 0) {
      return { cx: p1[0], cy: p1[1], rx: 0, ry: 0, phi, theta1: 0,
               dtheta: sweep ? Math.PI : -Math.PI };
    }
    const cx = (p1[0] + p2[0]) * 0.5, cy = (p1[1] + p2[1]) * 0.5;
    const angle = Math.atan2(dy, dx), r = chord * 0.5;
    if (ry === 0) {
      phi = angle;
      return { cx, cy, rx: r, ry: 0, phi, theta1: Math.PI,
               dtheta: sweep ? Math.PI : -Math.PI };
    }
    phi = angle - Math.PI * 0.5;
    return { cx, cy, rx: 0, ry: r, phi, theta1: -Math.PI * 0.5,
             dtheta: sweep ? Math.PI : -Math.PI };
  }
  const mx = (p1[0]-p2[0]) * 0.5;
  const my = (p1[1]-p2[1]) * 0.5;
  const x1p =  cp*mx + sp*my;
  const y1p = -sp*mx + cp*my;
  let lam = (x1p/rx)**2 + (y1p/ry)**2;
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p;
  const den = rx*rx*y1p*y1p + ry*ry*x1p*x1p;
  let sq = Math.sqrt(Math.max(num/den, 0));
  if (large === sweep) sq = -sq;
  const cxp =  sq * rx*y1p / ry;
  const cyp = -sq * ry*x1p / rx;
  const cx = cp*cxp - sp*cyp + (p1[0]+p2[0]) * 0.5;
  const cy = sp*cxp + cp*cyp + (p1[1]+p2[1]) * 0.5;
  const vecAng = (ux, uy, vx, vy) => {
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (n === 0) return 0;
    const c = Math.max(-1, Math.min(1, (ux*vx + uy*vy) / n));
    const a = Math.acos(c);
    return (ux*vy - uy*vx < 0) ? -a : a;
  };
  const theta1 = vecAng(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
  let dtheta = vecAng((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
  if (!sweep && dtheta > 0) dtheta -= 2*Math.PI;
  if (sweep  && dtheta < 0) dtheta += 2*Math.PI;
  return { cx, cy, rx, ry, phi, theta1, dtheta };
}

/// Longest sweep a single native ARC record is allowed to span.
///
/// Nothing about the RASTERIZER needs this — it ray-casts an arc of any sweep
/// exactly. The MORPH does. A morph interpolates an arc in ENDPOINT form
/// (p1, p4, rx, ry, phi, flags) — the form the SVG author wrote — because that
/// is the only exact form whose componentwise lerp keeps an arc's endpoints
/// welded to its neighbours' (see morphCore.prepareArcMorph). Endpoint form
/// cannot express a CLOSED arc: at a full turn p1 == p4 and the two points no
/// longer pick out an ellipse. SVG has the same hole, which is why authors write
/// a circle as two half-arcs.
///
/// Mantle does NOT — shape.js emits a <circle>/<ellipse> as a single 360-degree
/// arc. So cap the sweep at a half turn here and such an arc lands as two
/// records, restoring the same well-conditioned endpoint form an author would
/// have written by hand.
///
/// Splitting an arc into arcs is EXACT — the pieces trace the identical ellipse,
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
  for (let i = 0; i < n; i++) {
    const t0 = s.theta_start + step * i;
    // Land the last piece exactly on theta_end — no accumulated drift, so the
    // arc still closes on whatever segment follows it.
    const t1 = i === n - 1 ? s.theta_end : t0 + step;
    // Every piece is under a half-turn, so large_arc is 0 by construction; the
    // sweep direction is the sign of the (unchanged) step.
    out[i] = mkArc(s.cx, s.cy, s.rx, s.ry, t0, t1, s.phi, 0, step > 0 ? 1 : 0);
    if (s.is_fill_only) out[i].is_fill_only = s.is_fill_only;
  }
  // The first piece inherits the subpath-start marker — splitting a segment must
  // not move where a subpath begins.
  if (s.subStart) out[0].subStart = true;
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
  if (!hasWide) return segs;   // overwhelmingly the common case — don't re-alloc
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
/// written as a single arc, which has no endpoint form at all (p1==p4 no longer picks out an
/// ellipse). Those are authored/split elsewhere as two half-arcs (see MAX_ARC_SPAN).
export function arcToNative(p1, rx, ry, phiDeg, large, sweep, p2) {
  if (rx !== 0 && ry !== 0 && p1[0] === p2[0] && p1[1] === p2[1]) return mkLine(p1, p2);
  const c = arcEndpointToCenter(p1, rx, ry, phiDeg, large, sweep, p2);
  return mkArc(c.cx, c.cy, c.rx, c.ry, c.theta1, c.theta1 + c.dtheta, c.phi, large, sweep);
}

/// Cubic-Bezier approximation of an SVG arc. Splits into ≤90° quadrants
/// to keep the per-segment Bezier error well below 1e-3 per the
/// standard 4-Bezier-per-circle bound.
///
/// Zero-radius arcs become collinear cubics instead of a line, preserving topology
/// when a transformed morph pose grows into a non-degenerate arc.
export function arcToCubics(p1, rx, ry, phiDeg, large, sweep, p2) {
  if (rx !== 0 && ry !== 0 && p1[0] === p2[0] && p1[1] === p2[1]) return [mkLine(p1, p2)];
  const c = arcEndpointToCenter(p1, rx, ry, phiDeg, large, sweep, p2);
  const n = Math.max(1, Math.ceil(Math.abs(c.dtheta) / (Math.PI/2)));
  const dt = c.dtheta / n;
  const out = [];
  const cp = Math.cos(c.phi), sp = Math.sin(c.phi);
  for (let i = 0; i < n; i++) {
    const t0 = c.theta1 + i*dt, t1 = t0 + dt;
    const alpha = Math.sin(dt) * (Math.sqrt(4 + 3*Math.tan(dt*0.5)**2) - 1) / 3;
    const p0x = c.cx + c.rx*cp*Math.cos(t0) - c.ry*sp*Math.sin(t0);
    const p0y = c.cy + c.rx*sp*Math.cos(t0) + c.ry*cp*Math.sin(t0);
    const p3x = c.cx + c.rx*cp*Math.cos(t1) - c.ry*sp*Math.sin(t1);
    const p3y = c.cy + c.rx*sp*Math.cos(t1) + c.ry*cp*Math.sin(t1);
    const dp0x = -c.rx*cp*Math.sin(t0) - c.ry*sp*Math.cos(t0);
    const dp0y = -c.rx*sp*Math.sin(t0) + c.ry*cp*Math.cos(t0);
    const dp3x = -c.rx*cp*Math.sin(t1) - c.ry*sp*Math.cos(t1);
    const dp3y = -c.rx*sp*Math.sin(t1) + c.ry*cp*Math.cos(t1);
    out.push(mkCubic(
      [p0x, p0y],
      [p0x + alpha*dp0x, p0y + alpha*dp0y],
      [p3x - alpha*dp3x, p3y - alpha*dp3y],
      [p3x, p3y],
    ));
  }
  return out;
}
