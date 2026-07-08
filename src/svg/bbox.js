// svg/bbox.js — segment + path bounding-box math + subpath splitting.
//
// Two distinct bbox flavours:
//   segCtrlBbox       — control-polygon bbox (cheap, loose; conservative
//                       bound that includes off-curve control points).
//   segBbox /
//   arcTightBbox /
//   curveTightBbox*   — curve-tight bbox (precise; finds dP/dt = 0 axis
//                       extrema and arc-major-axis crossings).
//
// pathBbox composes per-segment curve-tight bboxes. splitSubpathsWithClose
// splits a flat seg list at every M command (or implicit start) so the
// stroke/fill walker can reason about each closed contour independently.
// polygonSignedArea is the shoelace helper used by the cover-quad
// even-odd determination + the inscribed-rect optimization.

import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  mkLine,
  segStart, segEnd, segStartEnd,
} from './segment.js';

export function segCtrlBbox(s) {
  // Allocating wrapper; hot consumers prefer segCtrlBboxInto.
  const out = [0, 0, 0, 0];
  segCtrlBboxInto(s, out, 0);
  return out;
}

// Non-allocating overload: writes (minX, minY, maxX, maxY) at out[off..off+3].
export function segCtrlBboxInto(s, out, off) {
  if (s.type === SEG_ARC) {
    const rx = Math.abs(s.rx), ry = Math.abs(s.ry);
    const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
    const wx = Math.hypot(rx*cp, ry*sp);
    const wy = Math.hypot(rx*sp, ry*cp);
    out[off]   = s.cx - wx;
    out[off+1] = s.cy - wy;
    out[off+2] = s.cx + wx;
    out[off+3] = s.cy + wy;
    return;
  }
  let minX = +Infinity, minY = +Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  if (s.p1) {
    const x = s.p1[0], y = s.p1[1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (s.p2) {
    const x = s.p2[0], y = s.p2[1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (s.p3) {
    const x = s.p3[0], y = s.p3[1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (s.p4) {
    const x = s.p4[0], y = s.p4[1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  out[off]   = minX;
  out[off+1] = minY;
  out[off+2] = maxX;
  out[off+3] = maxY;
}

export function segBbox(s) {
  // Allocating wrapper. Hot callers prefer segBboxInto.
  if (s.type === SEG_LINE) {
    const x0 = s.p1[0], y0 = s.p1[1], x1 = s.p2[0], y1 = s.p2[1];
    return [Math.min(x0,x1), Math.min(y0,y1), Math.max(x0,x1), Math.max(y0,y1)];
  }
  if (s.type === SEG_ARC)   return arcTightBbox(s);
  if (s.type === SEG_QUAD)  return curveTightBboxQuad(s.p1, s.p2, s.p3);
  if (s.type === SEG_CUBIC) return curveTightBboxCubic(s.p1, s.p2, s.p3, s.p4);
  // Fallback: control-polygon bbox (rare — synthetic segs).
  let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (p) => {
    if (!p) return;
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  };
  consider(s.p1); consider(s.p2); consider(s.p3); consider(s.p4);
  return [minX, minY, maxX, maxY];
}

// Non-allocating overload: writes (minX, minY, maxX, maxY) at
// out[off..off+3]. For LINE, computes inline (the common case in
// stroked tiger paths). For QUAD/CUBIC/ARC, falls back to the
// allocating helpers and copies — those helpers each cost one
// 4-array per call which still beats the segBbox + destructure
// pattern at the caller. Saves the segBbox return allocation +
// the caller's destructure iterator overhead.
export function segBboxInto(s, out, off) {
  if (s.type === SEG_LINE) {
    const x0 = s.p1[0], y0 = s.p1[1], x1 = s.p2[0], y1 = s.p2[1];
    out[off]   = x0 < x1 ? x0 : x1;
    out[off+1] = y0 < y1 ? y0 : y1;
    out[off+2] = x0 > x1 ? x0 : x1;
    out[off+3] = y0 > y1 ? y0 : y1;
    return;
  }
  if (s.type === SEG_QUAD)  { curveTightBboxQuadInto(s.p1, s.p2, s.p3, out, off); return; }
  if (s.type === SEG_CUBIC) { curveTightBboxCubicInto(s.p1, s.p2, s.p3, s.p4, out, off); return; }
  // ARC + degenerate fallback still allocate (less hot).
  const bb = segBbox(s);
  out[off] = bb[0]; out[off+1] = bb[1]; out[off+2] = bb[2]; out[off+3] = bb[3];
}

// Tight axis-aligned bbox of an SVG arc subset. The previous formula
// returned the bbox of the whole rotated ellipse, which for short
// arcs vastly overestimates the curve extent (e.g., a 30 deg arc of
// a circle with cx well outside the viewBox returned a bbox covering
// the whole ellipse, not just the arc). Sample the arc at endpoints
// + axis extrema in the [theta_start, theta_end] range and return
// min/max.
export function arcTightBbox(s) {
  const rx = s.rx, ry = s.ry, cp = Math.cos(s.phi), sp = Math.sin(s.phi);
  const evalArc = (theta) => {
    const ct = Math.cos(theta), st = Math.sin(theta);
    return [s.cx + cp*rx*ct - sp*ry*st, s.cy + sp*rx*ct + cp*ry*st];
  };
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  const consider = (theta) => {
    const p = evalArc(theta);
    if (p[0] < lo[0]) lo[0] = p[0]; if (p[0] > hi[0]) hi[0] = p[0];
    if (p[1] < lo[1]) lo[1] = p[1]; if (p[1] > hi[1]) hi[1] = p[1];
  };
  consider(s.theta_start);
  consider(s.theta_end);
  // Axis extrema of the rotated ellipse occur where d/dtheta of the
  // x or y component is zero. For x(theta) = cx + cp*rx*cos - sp*ry*sin,
  // dx/dtheta = -cp*rx*sin - sp*ry*cos = 0 -> tan(theta) = -sp*ry/(cp*rx).
  // Similar for y. There are two solutions per axis (theta and theta+pi);
  // include both within the arc's angular range.
  const pushIf = (theta) => {
    // Normalize to nearest period within [theta_start - 2pi, theta_end + 2pi].
    const t0 = s.theta_start, t1 = s.theta_end;
    const lo_t = Math.min(t0, t1), hi_t = Math.max(t0, t1);
    let th = theta;
    while (th < lo_t) th += 2*Math.PI;
    while (th > hi_t) th -= 2*Math.PI;
    if (th >= lo_t && th <= hi_t) consider(th);
  };
  // x extrema: tan(th) = -sp*ry / (cp*rx)
  if (Math.abs(cp*rx) > 1e-12 || Math.abs(sp*ry) > 1e-12) {
    const thX = Math.atan2(-sp*ry, cp*rx);
    pushIf(thX);
    pushIf(thX + Math.PI);
  }
  // y extrema: dy/dtheta = -sp*rx*sin + cp*ry*cos = 0 -> tan = cp*ry/(sp*rx)
  if (Math.abs(sp*rx) > 1e-12 || Math.abs(cp*ry) > 1e-12) {
    const thY = Math.atan2(cp*ry, sp*rx);
    pushIf(thY);
    pushIf(thY + Math.PI);
  }
  return [lo[0], lo[1], hi[0], hi[1]];
}

// Quadratic Bezier curve-tight bbox. P(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2.
// dP/dt = 2*(P1-P0) + 2*t*(P2 - 2P1 + P0). Zero at t = (P0-P1)/(P0-2P1+P2)
// per axis. Evaluate at endpoints and any interior root in (0,1).
export function curveTightBboxQuad(p0, p1, p2) {
  const out = [0, 0, 0, 0];
  curveTightBboxQuadInto(p0, p1, p2, out, 0);
  return out;
}

export function curveTightBboxQuadInto(p0, p1, p2, out, off) {
  // Inlined per-axis extremum search; each axis writes lo/hi into
  // out[off+axis] / out[off+axis+2]. No [lo, hi] tuple allocations.
  for (let axis = 0; axis < 2; axis++) {
    const a0 = p0[axis], a1 = p1[axis], a2 = p2[axis];
    let lo = a0 < a2 ? a0 : a2;
    let hi = a0 > a2 ? a0 : a2;
    const denom = a0 - 2*a1 + a2;
    if (Math.abs(denom) > 1e-12) {
      const t = (a0 - a1) / denom;
      if (t > 0 && t < 1) {
        const v = (1-t)*(1-t)*a0 + 2*(1-t)*t*a1 + t*t*a2;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    out[off + axis]     = lo;
    out[off + axis + 2] = hi;
  }
}

// Cubic Bezier curve-tight bbox. P(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 +
// 3(1-t)t^2 P2 + t^3 P3. dP/dt = 3*[(1-t)^2 (P1-P0) + 2(1-t)t (P2-P1) +
// t^2 (P3-P2)] = 3*[a t^2 + b t + c] where a = -P0+3P1-3P2+P3,
// b = 2(P0-2P1+P2), c = P1-P0. Solve quadratic per axis, evaluate at
// roots in (0,1) plus endpoints.
export function curveTightBboxCubic(p0, p1, p2, p3) {
  const out = [0, 0, 0, 0];
  curveTightBboxCubicInto(p0, p1, p2, p3, out, 0);
  return [out[0], out[1], out[2], out[3]];
}

export function curveTightBboxCubicInto(p0, p1, p2, p3, out, off) {
  for (let axis = 0; axis < 2; axis++) {
    const a0 = p0[axis], a1 = p1[axis], a2 = p2[axis], a3 = p3[axis];
    let lo = a0 < a3 ? a0 : a3;
    let hi = a0 > a3 ? a0 : a3;
    const A = -a0 + 3*a1 - 3*a2 + a3;
    const B = 2*(a0 - 2*a1 + a2);
    const C = a1 - a0;
    // Inlined root evaluation (was a per-axis `consider` closure that
    // captured mutable lo/hi — that closure showed up as real self-time
    // and forced V8 to box lo/hi). t0/t1 default to NaN so the
    // `t > 0 && t < 1` guard rejects "no root" without a separate flag.
    // Same root order (+sqrt then -sqrt); min/max is order-independent
    // so output is bit-identical.
    let t0 = NaN, t1 = NaN;
    if (Math.abs(A) < 1e-12) {
      if (Math.abs(B) > 1e-12) t0 = -C / B;
    } else {
      const disc = B*B - 4*A*C;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        t0 = (-B + sq) / (2*A);
        t1 = (-B - sq) / (2*A);
      }
    }
    if (t0 > 0 && t0 < 1) {
      const u = 1 - t0;
      const v = u*u*u*a0 + 3*u*u*t0*a1 + 3*u*t0*t0*a2 + t0*t0*t0*a3;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (t1 > 0 && t1 < 1) {
      const u = 1 - t1;
      const v = u*u*u*a0 + 3*u*u*t1*a1 + 3*u*t1*t1*a2 + t1*t1*t1*a3;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    out[off + axis]     = lo;
    out[off + axis + 2] = hi;
  }
}

export function pathBbox(segs) {
  let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
  const bb4 = [0, 0, 0, 0];
  for (const s of segs) {
    segBboxInto(s, bb4, 0);
    if (bb4[0] < x0) x0 = bb4[0]; if (bb4[1] < y0) y0 = bb4[1];
    if (bb4[2] > x1) x1 = bb4[2]; if (bb4[3] > y1) y1 = bb4[3];
  }
  return [x0, y0, x1, y1];
}

export function splitSubpathsWithClose(segs) {
  if (!segs.length) return [];
  const subs = [[segs[0]]];
  for (let i = 1; i < segs.length; i++) {
    const prevEnd = segEnd(segs[i-1]);
    const curStart = segStart(segs[i]);
    if (Math.abs(prevEnd[0] - curStart[0]) > 1e-4 || Math.abs(prevEnd[1] - curStart[1]) > 1e-4) {
      subs.push([]);
    }
    subs[subs.length-1].push(segs[i]);
  }
  // Synthetic close is ALWAYS emitted (even when endpoints coincide
  // exactly) so two paths with identical Q/L topology produce the same
  // curveFloats.length regardless of whether their endpoints happen
  // to land within the 1e-4 close-detection band or not. Pre-fix this
  // tolerance check made shape-morph topology matching fail for pose
  // pairs that straddled the threshold (importer determinism). The
  // degenerate-
  // case (lp == fp) emits a zero-length fill-only line, which costs 3
  // texels = 12 curve floats and contributes nothing to the fill walk;
  // buildTexturesShape exempts fill-only lines from the degenerate
  // filter to preserve the deterministic count.
  return subs.map(sub => {
    if (!sub.length) return sub;
    const fp = segStart(sub[0]);
    const lp = segEnd(sub[sub.length-1]);
    return sub.concat([mkLine(lp, fp, true)]);
  });
}

// Non-allocating variant that writes the flat closed-subpath list directly
// into a caller-supplied array — skips the Seg[][] intermediate that
// callers immediately `.flat()` away.
export function splitSubpathsWithCloseInto(segs, out) {
  if (!segs.length) return;
  let subStart = out.length;
  out.push(segs[0]);
  // Always-emit synthetic close — see splitSubpathsWithClose for the
  // shape-morph determinism rationale.
  const closeSubpath = () => {
    if (out.length === subStart) return;
    const fp = segStart(out[subStart]);
    const lp = segEnd(out[out.length-1]);
    out.push(mkLine(lp, fp, true));
  };
  for (let i = 1; i < segs.length; i++) {
    const prevEnd = segEnd(segs[i-1]);
    const curStart = segStart(segs[i]);
    if (Math.abs(prevEnd[0] - curStart[0]) > 1e-4 || Math.abs(prevEnd[1] - curStart[1]) > 1e-4) {
      closeSubpath();
      subStart = out.length;
    }
    out.push(segs[i]);
  }
  closeSubpath();
}

// ------------------------------------------------------------
// Cover-quad builder
// ------------------------------------------------------------

// Per-vertex layout (12 floats):
//    0- 1 : pos.xy (em-space)
//    2- 3 : cp0
//    4- 5 : cp1
//    6- 7 : cp2
//    8- 9 : cp3
//   10    : kind (`nointerpolation`, all 3 verts of any triangle agree)
//             0 = line / no-curve fan only
//             1 = arc
//             2 = quad
//             3 = cubic
//   11    : zone (interpolated linearly across the triangle)
//             +1.0 at the fan triangle's apex (p0_subpath)
//              0.0 at chord-endpoint verts (boundary between fan & hull)
//             -1.0 at hull-interior verts
//             For lines & arcs: all 3 fan verts emit zone=+1.0 since
//             they do not share verts with their hull (lines have no
//             hull; arcs use a bbox hull at different em-positions).
//             For quad/cubic: the chord-endpoint verts emit IDENTICAL
//             attributes (cp0..3, kind, zone=0) in BOTH the fan and
//             hull triangles so the cover-quad builder's
//             bitwise-equal vertex-dedup collapses them into a single
//             shared mesh vertex. Result: the chord edge becomes a
//             true shared mesh edge — the rasterizer's top-left rule
//             assigns each chord pixel to exactly one of the two
//             triangles, eliminating the diagonal-chord seam that
//             arises when fan and hull are independent triangles.
//
// The stencil shader's keep/discard rule:
//     if (zone > 0) keep                      // strict fan interior
//     else dispatch on kind for crescent test  // hull interior + chord
// `zone` is interpolated, so this is an analytic threshold rather than
// a `nointerpolation` per-triangle flag — which is what allows the
// shared chord-endpoint vertex to participate in BOTH the fan
// (zone interpolates from 0 at chord toward +1 at apex) AND the hull
// (zone interpolates from 0 at chord toward -1 at hull interior).
// Signed area of a closed polygon (flat [x,y,x,y,...] coords). Sign
// indicates winding: positive → CCW in y-up, negative → CW. SVG is
// y-down so the sign-vs-direction relationship inverts.
export function polygonSignedArea(flatXY) {
  let a = 0;
  for (let i = 0; i < flatXY.length; i += 2) {
    const x0 = flatXY[i], y0 = flatXY[i + 1];
    const ni = (i + 2) % flatXY.length;
    const x1 = flatXY[ni], y1 = flatXY[ni + 1];
    a += x0 * y1 - x1 * y0;
  }
  return 0.5 * a;
}
