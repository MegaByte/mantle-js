// curveGeom.js — segment decode, closest-point, dash gate, cap/join stroke band.

import {
  solveQuadratic, solveCubic, solvePolyInUnitInterval, solveQuartic,
} from '../svg/pathBoolean/polyRoots.js';

// Gauss–Legendre 16 nodes/weights on [0,1]. Must match the encoder and the
// stroke shaders so the hit test gates dashes by the identical true arc
// length the renderer draws.
const GL16_N = [
  0.005299532504175033, 0.027712488463383711, 0.067184398806084128,
  0.122297795822498470, 0.191061877798678115, 0.270991611171386573,
  0.359198224610370696, 0.452493745081181231, 0.547506254918818769,
  0.640801775389629304, 0.729008388828613427, 0.808938122201321885,
  0.877702204177501530, 0.932815601193915872, 0.972287511536616289,
  0.994700467495824967,
];
const GL16_W = [
  0.013576229705877047, 0.031126761969323946, 0.047579255841246392,
  0.062314485627766936, 0.074797994408288365, 0.084578259697501269,
  0.091301707522461794, 0.094725305227534248, 0.094725305227534248,
  0.091301707522461794, 0.084578259697501269, 0.074797994408288365,
  0.062314485627766936, 0.047579255841246392, 0.031126761969323946,
  0.013576229705877047,
];

// Curve buffer: must match renderer/bundle.js TEX_W. Each segment record
// is header(4 floats) + data + join(4).
export const CURVE_TEX_W = 4096;
export const SEG_LINE = 0, SEG_QUAD = 1, SEG_CUBIC = 2, SEG_ARC = 3;

export const JOIN_MITER = 0, JOIN_ROUND = 1, JOIN_BEVEL = 2, JOIN_MITER_CLIP = 3, JOIN_ARCS = 4;

const CAP_BUTT = 0, CAP_SQUARE = 2;     // (CAP_ROUND = 1 is the default disc)
const WH_INT = 0, WH_START = 1, WH_END = 2;

const META_TEXEL_4 = 16;   // t4.xy: per-shape curve-range texel coord (gx, gy)

/** Locate the bundle's flat curve-float buffer across the input shapes. */
export function curveView(bundle) {
  if (!bundle) return null;
  if (bundle.curveFloats instanceof Float32Array) return bundle.curveFloats;   // createBundle
  if (bundle.curveTexels instanceof Float32Array) return bundle.curveTexels;    // textRun
  if (bundle.curves && bundle.curves.byteLength != null) return new Float32Array(bundle.curves); // sections
  return null;
}

/** Per-shape `{begin,end}` float ranges — provided, or derived from meta. */
export function curveRangesOf(bundle, meta, n, stride, curveLen) {
  if (Array.isArray(bundle.curveRangesByShape) && bundle.curveRangesByShape.length === n)
    return bundle.curveRangesByShape;
  const ranges = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * stride;
    const gx = meta[b + META_TEXEL_4] | 0;
    const gy = meta[b + META_TEXEL_4 + 1] | 0;
    ranges[i] = { begin: 4 * (gy * CURVE_TEX_W + gx), end: 0 };
  }
  for (let i = 0; i < n - 1; i++) ranges[i].end = ranges[i + 1].begin;
  if (n > 0) ranges[n - 1].end = curveLen;
  return ranges;
}

/**
 * Decode a shape's curve range into NATIVE segments (no flattening). Each
 * seg is `{ t, ...points, f }` with `t` = SEG_LINE/QUAD/CUBIC/ARC; `f`
 * (fill-only) marks an open-subpath closure or an is_fill_only segment —
 * counted in the fill winding, excluded from the stroke band.
 */
export function decodeSegs(cv, begin, end, joinStyle = 0) {
  // Arcs strokes carry an extra per-segment curvature texel after the join
  // texel; account for it in the sequential stride AND read its values.
  const hasCurv = joinStyle === JOIN_ARCS;
  const segs = [];
  const E = Math.min(end | 0, cv.length);
  let hdr = begin | 0; if (hdr < 0) hdr = 0;
  let penX = NaN, penY = NaN, subX = 0, subY = 0, open = false;
  const EPS = 1e-4;
  while (hdr + 8 <= E) {                       // header(4) + ≥1 data texel(4)
    const raw  = cv[hdr] | 0;
    const type = raw & 3;
    const fo   = (raw & 4) !== 0;              // is_fill_only
    // Header texel: (segType, freeStart, freeEnd, startDist). The join
    // texel (inTanX,inTanY,outTanX,outTanY) follows the data texel(s) —
    // precomputed neighbour tangents for cap/join. Both consumed by the
    // stroke band (caps at free ends, joins at interior vertices).
    const freeS = cv[hdr + 1] > 0.5, freeE = cv[hdr + 2] > 0.5;
    const sd = cv[hdr + 3];                     // cumulative startDist (dashing)
    const d = hdr + 4;
    const jt = (type === SEG_LINE) ? hdr + 8 : hdr + 12;
    const itx = cv[jt], ity = cv[jt + 1], otx = cv[jt + 2], oty = cv[jt + 3];
    // Arcs-join curvatures (kSelfStart, kSelfEnd, kPrevEnd, kNextStart); 0 when
    // the stroke isn't arcs (no texel present). `cadv` extends the stride.
    const kSS = hasCurv ? cv[jt + 4] : 0, kSE = hasCurv ? cv[jt + 5] : 0;
    const kPE = hasCurv ? cv[jt + 6] : 0, kNS = hasCurv ? cv[jt + 7] : 0;
    const cadv = hasCurv ? 4 : 0;
    let seg, sx, sy, ex, ey;
    if (type === SEG_LINE) {
      sx = cv[d]; sy = cv[d + 1]; ex = cv[d + 2]; ey = cv[d + 3];
      seg = { t: SEG_LINE, x0: sx, y0: sy, x1: ex, y1: ey, f: fo, freeS, freeE, sd, itx, ity, otx, oty, kSS, kSE, kPE, kNS };
      hdr = d + 8 + cadv;
    } else if (type === SEG_QUAD) {
      sx = cv[d]; sy = cv[d + 1];
      const cx = cv[d + 2], cy = cv[d + 3]; ex = cv[d + 4]; ey = cv[d + 5];
      seg = { t: SEG_QUAD, x0: sx, y0: sy, cx, cy, x1: ex, y1: ey, f: fo, freeS, freeE, sd, itx, ity, otx, oty, kSS, kSE, kPE, kNS };
      hdr = d + 12 + cadv;
    } else if (type === SEG_CUBIC) {
      sx = cv[d]; sy = cv[d + 1];
      const c1x = cv[d + 2], c1y = cv[d + 3], c2x = cv[d + 4], c2y = cv[d + 5];
      ex = cv[d + 6]; ey = cv[d + 7];
      seg = { t: SEG_CUBIC, x0: sx, y0: sy, c1x, c1y, c2x, c2y, x1: ex, y1: ey, f: fo, freeS, freeE, sd, itx, ity, otx, oty, kSS, kSE, kPE, kNS };
      hdr = d + 12 + cadv;
    } else {                                   // SEG_ARC (center form)
      const cx = cv[d], cy = cv[d + 1], rx = cv[d + 2], ry = cv[d + 3];
      const th0 = cv[d + 4], th1 = cv[d + 5], phi = cv[d + 6];
      const cp = Math.cos(phi), sp = Math.sin(phi);
      sx = cx + rx * Math.cos(th0) * cp - ry * Math.sin(th0) * sp;
      sy = cy + rx * Math.cos(th0) * sp + ry * Math.sin(th0) * cp;
      ex = cx + rx * Math.cos(th1) * cp - ry * Math.sin(th1) * sp;
      ey = cy + rx * Math.cos(th1) * sp + ry * Math.sin(th1) * cp;
      seg = { t: SEG_ARC, cx, cy, rx, ry, th0, th1, cp, sp, x0: sx, y0: sy, x1: ex, y1: ey, f: fo, freeS, freeE, sd, itx, ity, otx, oty, kSS, kSE, kPE, kNS };
      hdr = d + 12 + cadv;
    }
    // Subpath break: close the previous (fill-only line) if the pen jumped.
    if (isNaN(penX) || Math.abs(sx - penX) > EPS || Math.abs(sy - penY) > EPS) {
      if (open && (Math.abs(penX - subX) > EPS || Math.abs(penY - subY) > EPS))
        segs.push({ t: SEG_LINE, x0: penX, y0: penY, x1: subX, y1: subY, f: true });
      subX = sx; subY = sy; open = true;
    }
    segs.push(seg);
    penX = ex; penY = ey;
  }
  if (open && (Math.abs(penX - subX) > EPS || Math.abs(penY - subY) > EPS))
    segs.push({ t: SEG_LINE, x0: penX, y0: penY, x1: subX, y1: subY, f: true });
  return segs;
}

// ── Stroke: exact min point→curve distance + SVG caps/joins ──
// The closest point on a seg is its endpoints ∪ interior critical points
// (roots of d/dt|curve(t)−P|²) — no sampling. When the nearest approach is
// an interior point it's the parallel band (always in the stroke). When it
// is an endpoint we apply the cap (free end: butt/round/square) or the join
// (interior vertex: miter/round/bevel) using freeStart/freeEnd + the
// precomputed neighbour tangents. Must match the stroke shader's coverage
// (incl. its bevel==round simplification).

// Perpendicular distance from q (relative to the join vertex) to an edge's
// extended centerline arc — the osculating circle of signed curvature `kappa`
// tangent to (Tx,Ty) at the vertex; a straight line when kappa≈0. Mirrors
// _strokeMath.glsl::perpDistToArc (the ±halfW band is the SVG2 arcs edge).
function perpDistToArc(qx, qy, Tx, Ty, kappa) {
  const Lx = -Ty, Ly = Tx;                          // left normal
  if (Math.abs(kappa) < 1e-6) return Math.abs(qx * Lx + qy * Ly);
  const R = 1 / kappa;                               // signed radius
  const CCx = R * Lx, CCy = R * Ly;                  // osculating center (vertex at origin)
  return Math.abs(Math.hypot(qx - CCx, qy - CCy) - Math.abs(R));
}

// Exact bevel chord distance at a join vertex.
function exactBevelChordDist(qx, qy, halfW, inTanX, inTanY, segTanX, segTanY) {
  const cr = inTanX * segTanY - inTanY * segTanX;
  const sd = cr >= 0 ? 1 : -1;
  const nAx = sd * inTanY, nAy = -sd * inTanX;
  const nBx = sd * segTanY, nBy = -sd * segTanX;
  const nbx = nAx + nBx, nby = nAy + nBy;
  const bl = Math.hypot(nbx, nby);
  if (bl <= 1e-4) return 0;
  const bisx = nbx / bl, bisy = nby / bl;
  return halfW - (qx * bisx + qy * bisy) - halfW * (nAx * bisx + nAy * bisy);
}

// ── Arc length (em-space) over the decoded native seg ──────────────────
// The dash gate must measure distance the same way the renderer draws it
// (true arc length on curves, not chord), or the hit band and the visible
// dashes would drift apart on quads/cubics/arcs.
function _segSpeed(s, t) {
  let dx, dy;
  if (s.t === SEG_LINE) { dx = s.x1 - s.x0; dy = s.y1 - s.y0; }
  else if (s.t === SEG_QUAD) {
    const u = 1 - t;
    dx = 2*u*(s.cx - s.x0) + 2*t*(s.x1 - s.cx);
    dy = 2*u*(s.cy - s.y0) + 2*t*(s.y1 - s.cy);
  } else if (s.t === SEG_CUBIC) {
    const u = 1 - t;
    dx = 3*u*u*(s.c1x - s.x0) + 6*u*t*(s.c2x - s.c1x) + 3*t*t*(s.x1 - s.c2x);
    dy = 3*u*u*(s.c1y - s.y0) + 6*u*t*(s.c2y - s.c1y) + 3*t*t*(s.y1 - s.c2y);
  } else {                                            // SEG_ARC
    const th = s.th0 + (s.th1 - s.th0) * t, dth = s.th1 - s.th0;
    const ct = Math.cos(th), st = Math.sin(th);
    dx = (-s.cp*s.rx*st - s.sp*s.ry*ct) * dth;
    dy = (-s.sp*s.rx*st + s.cp*s.ry*ct) * dth;
  }
  return Math.hypot(dx, dy);
}
function _quadLenAt(s, t) {                            // closed form (exact)
  const ax = s.x0 - 2*s.cx + s.x1, ay = s.y0 - 2*s.cy + s.y1;
  const bx = s.cx - s.x0, by = s.cy - s.y0;
  const A = ax*ax + ay*ay, B = 2*(ax*bx + ay*by), C = bx*bx + by*by;
  if (A < 1e-12) return Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * t;
  const F = (tt) => {
    const u = A*tt*tt + B*tt + C;
    if (u < 0) return 0;
    const sqrtU = Math.sqrt(u), sqrtA = Math.sqrt(A);
    const term1 = ((2*A*tt + B) * sqrtU) / (4*A);
    const disc = 4*A*C - B*B;
    const arg = 2*sqrtA*sqrtU + 2*A*tt + B;
    const term2 = (arg > 1e-12) ? (disc / (8 * Math.pow(A, 1.5))) * Math.log(arg) : 0;
    return 2 * (term1 + term2);
  };
  return F(t) - F(0);
}
function segLenAt(s, t) {
  if (t <= 0) return 0;
  if (t > 1) t = 1;
  if (s.t === SEG_LINE) return Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * t;
  if (s.t === SEG_QUAD) return _quadLenAt(s, t);
  let sum = 0;                                        // cubic + arc: GL-16
  for (let i = 0; i < 16; i++) sum += GL16_W[i] * _segSpeed(s, t * GL16_N[i]);
  return t * sum;
}

// Dash table (16 texels = 64 floats/row, row = dashId-1): row0=(cycleLen,
// count, offset). Pattern values at float 4+k; even k = dash, odd = gap.
export function dashView(bundle) {
  if (!bundle) return null;
  if (bundle.dashFloats instanceof Float32Array) return bundle.dashFloats;
  if (bundle.dashes && bundle.dashes.byteLength != null) return new Float32Array(bundle.dashes);
  return null;
}
function dashCovered(dashF, dashId, dist) {
  if (!dashF || dashId <= 0) return true;
  const base = (dashId - 1) * 64;
  if (base + 4 > dashF.length) return true;
  const cycleLen = dashF[base], count = (dashF[base + 1] + 0.5) | 0, offset = dashF[base + 2];
  if (cycleLen <= 0 || count <= 0) return true;
  let d = (dist + offset) % cycleLen; if (d < 0) d += cycleLen;
  let accum = 0;
  for (let k = 0; k < count && k < 32; k++) {
    const v = dashF[base + 4 + k];
    if (d < accum + v) return (k & 1) === 0;
    accum += v;
  }
  return true;
}
// em-per-screen-pixel from the worldMatrix scale — for non-scaling-stroke,
// the rendered band is a constant SCREEN width, so its em half-width is
// halfW·emPerPx.
export function emPerPxOf(world) {
  if (!world) return 1;
  const sx = Math.hypot(world[0], world[1]), sy = Math.hypot(world[3], world[4]);
  const ex = sx > 1e-12 ? 1 / sx : 1, ey = sy > 1e-12 ? 1 / sy : 1;
  return 0.5 * (ex + ey);
}

function sq(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function unit(x, y) { const L = Math.hypot(x, y); return L > 1e-12 ? [x / L, y / L] : [0, 0]; }
function arcPt(s, th) {
  return [s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
          s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp];
}

// Forward (increasing-t) unit tangent at the start / end of a seg.
function tangentStart(s) {
  if (s.t === SEG_LINE) return unit(s.x1 - s.x0, s.y1 - s.y0);
  if (s.t === SEG_QUAD) {
    let dx = s.cx - s.x0, dy = s.cy - s.y0;
    if (dx * dx + dy * dy < 1e-18) { dx = s.x1 - s.x0; dy = s.y1 - s.y0; }
    return unit(dx, dy);
  }
  if (s.t === SEG_CUBIC) {
    let dx = s.c1x - s.x0, dy = s.c1y - s.y0;
    if (dx * dx + dy * dy < 1e-18) { dx = s.c2x - s.x0; dy = s.c2y - s.y0; }
    if (dx * dx + dy * dy < 1e-18) { dx = s.x1 - s.x0; dy = s.y1 - s.y0; }
    return unit(dx, dy);
  }
  const dir = (s.th1 >= s.th0) ? 1 : -1;
  return unit((-s.rx * Math.sin(s.th0) * s.cp - s.ry * Math.cos(s.th0) * s.sp) * dir,
              (-s.rx * Math.sin(s.th0) * s.sp + s.ry * Math.cos(s.th0) * s.cp) * dir);
}
function tangentEnd(s) {
  if (s.t === SEG_LINE) return unit(s.x1 - s.x0, s.y1 - s.y0);
  if (s.t === SEG_QUAD) {
    let dx = s.x1 - s.cx, dy = s.y1 - s.cy;
    if (dx * dx + dy * dy < 1e-18) { dx = s.x1 - s.x0; dy = s.y1 - s.y0; }
    return unit(dx, dy);
  }
  if (s.t === SEG_CUBIC) {
    let dx = s.x1 - s.c2x, dy = s.y1 - s.c2y;
    if (dx * dx + dy * dy < 1e-18) { dx = s.x1 - s.c1x; dy = s.y1 - s.c1y; }
    if (dx * dx + dy * dy < 1e-18) { dx = s.x1 - s.x0; dy = s.y1 - s.y0; }
    return unit(dx, dy);
  }
  const dir = (s.th1 >= s.th0) ? 1 : -1;
  return unit((-s.rx * Math.sin(s.th1) * s.cp - s.ry * Math.cos(s.th1) * s.sp) * dir,
              (-s.rx * Math.sin(s.th1) * s.sp + s.ry * Math.cos(s.th1) * s.cp) * dir);
}

// Closest approach: { d2 (squared distance), where }. `where` classifies
// the nearest point as interior / start vertex / end vertex (when an
// interior foot exists it is ≤ the endpoint distance, so the nearest
// point is at a vertex only for points genuinely beyond that end).
function closest(s, px, py) {
  const dS = sq(px, py, s.x0, s.y0), dE = sq(px, py, s.x1, s.y1);
  let dI = Infinity, tI = 0;          // tI = interior closest-point param (dashing)
  if (s.t === SEG_LINE) {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len2 = dx * dx + dy * dy;
    if (len2 > 0) { const t = ((px - s.x0) * dx + (py - s.y0) * dy) / len2;
      if (t > 0 && t < 1) { dI = sq(px, py, s.x0 + t * dx, s.y0 + t * dy); tI = t; } }
  } else if (s.t === SEG_QUAD) {
    const a1x = 2 * (s.cx - s.x0), a1y = 2 * (s.cy - s.y0);
    const a2x = s.x0 - 2 * s.cx + s.x1, a2y = s.y0 - 2 * s.cy + s.y1;
    const d0x = s.x0 - px, d0y = s.y0 - py;
    const c3 = 2 * (a2x * a2x + a2y * a2y), c2 = 3 * (a1x * a2x + a1y * a2y);
    const c1 = 2 * (d0x * a2x + d0y * a2y) + (a1x * a1x + a1y * a1y), c0 = d0x * a1x + d0y * a1y;
    for (const t of solveCubic(c3, c2, c1, c0)) {
      if (t <= 0 || t >= 1) continue;
      const dd = sq(px, py, s.x0 + a1x * t + a2x * t * t, s.y0 + a1y * t + a2y * t * t);
      if (dd < dI) { dI = dd; tI = t; }
    }
  } else if (s.t === SEG_CUBIC) {
    const a1x = 3 * (s.c1x - s.x0), a1y = 3 * (s.c1y - s.y0);
    const a2x = 3 * (s.x0 - 2 * s.c1x + s.c2x), a2y = 3 * (s.y0 - 2 * s.c1y + s.c2y);
    const a3x = -s.x0 + 3 * s.c1x - 3 * s.c2x + s.x1, a3y = -s.y0 + 3 * s.c1y - 3 * s.c2y + s.y1;
    const d0x = s.x0 - px, d0y = s.y0 - py;
    const f0 = d0x * a1x + d0y * a1y;
    const f1 = 2 * (d0x * a2x + d0y * a2y) + (a1x * a1x + a1y * a1y);
    const f2 = 3 * (d0x * a3x + d0y * a3y) + 3 * (a1x * a2x + a1y * a2y);
    const f3 = 4 * (a1x * a3x + a1y * a3y) + 2 * (a2x * a2x + a2y * a2y);
    const f4 = 5 * (a2x * a3x + a2y * a3y), f5 = 3 * (a3x * a3x + a3y * a3y);
    for (const t of solvePolyInUnitInterval([f0, f1, f2, f3, f4, f5])) {
      if (t <= 0 || t >= 1) continue;
      const dd = sq(px, py, s.x0 + a1x * t + a2x * t * t + a3x * t * t * t,
                           s.y0 + a1y * t + a2y * t * t + a3y * t * t * t);
      if (dd < dI) { dI = dd; tI = t; }
    }
  } else {                                   // SEG_ARC
    const lo = Math.min(s.th0, s.th1), hi = Math.max(s.th0, s.th1);
    const consider = (th) => {
      while (th < lo) th += 2 * Math.PI;
      while (th >= lo + 2 * Math.PI) th -= 2 * Math.PI;
      if (th > hi || th - lo < 1e-9 || hi - th < 1e-9) return;   // interior only
      const p = arcPt(s, th); const dd = sq(px, py, p[0], p[1]);
      if (dd < dI) { dI = dd; tI = (th - s.th0) / (s.th1 - s.th0); }
    };
    const Dx = s.cx - px, Dy = s.cy - py;
    const a = Dx * s.cp + Dy * s.sp, b = -Dx * s.sp + Dy * s.cp;
    if (Math.abs(s.rx - s.ry) < 1e-9) {
      consider(Math.atan2(-b, -a));
    } else {
      const K = s.ry * s.ry - s.rx * s.rx;
      for (const w of solveQuartic(-s.ry * b, -2 * K - 2 * s.rx * a, 0, 2 * K - 2 * s.rx * a, s.ry * b))
        consider(2 * Math.atan(w));
      consider(Math.PI);
    }
  }
  if (dI <= dS && dI <= dE) return { d2: dI, where: WH_INT, t: tI };
  if (dS <= dE) return { d2: dS, where: WH_START, t: 0 };
  return { d2: dE, where: WH_END, t: 1 };
}

// Cap (free end) / join (interior vertex) at the nearest vertex. Returns
// the effective distance (Infinity = not in the band there). `vertDist`
// is the natural distance to the vertex (round cap / round-bevel disc).
function capJoinDist(s, px, py, halfW, atStart, vertDist, capStyle, joinStyle, miterLimit) {
  const Vx = atStart ? s.x0 : s.x1, Vy = atStart ? s.y0 : s.y1;
  const qx = px - Vx, qy = py - Vy;
  const T = atStart ? tangentStart(s) : tangentEnd(s);
  const Tx = T[0], Ty = T[1];
  if (atStart ? s.freeS : s.freeE) {                 // ── cap ──
    const ox = atStart ? -Tx : Tx, oy = atStart ? -Ty : Ty;   // outward (beyond) dir
    const a = qx * ox + qy * oy;                       // projection beyond the end
    if (capStyle === CAP_BUTT)                          // flat: clip at the end plane
      return a > 0 ? Infinity : vertDist;
    if (capStyle !== CAP_SQUARE) return vertDist;       // round half-disc
    if (a < 0 || a > halfW) return Infinity;            // square: halfW box extension
    return Math.hypot(qx - ox * a, qy - oy * a);
  }
  // ── join ──
  const Nx = atStart ? s.itx : s.otx, Ny = atStart ? s.ity : s.oty;
  if (joinStyle === JOIN_BEVEL) {
    const inTanX = atStart ? Nx : Tx, inTanY = atStart ? Ny : Ty;
    const segTanX = atStart ? Tx : Nx, segTanY = atStart ? Ty : Ny;
    if (atStart) {
      if (qx * (-inTanX) + qy * (-inTanY) < 0) return Infinity;
    } else if (qx * segTanX + qy * segTanY > 0) {
      return Infinity;
    }
    return Math.max(vertDist, exactBevelChordDist(qx, qy, halfW, inTanX, inTanY, segTanX, segTanY));
  }
  if (joinStyle === JOIN_ROUND) return vertDist;
  if (joinStyle === JOIN_ARCS) {
    // SVG2 arcs: extend each edge as an arc of its own curvature (the ±halfW
    // band of its osculating circle) and fill the wedge where both bands
    // overlap — the exact render geometry. Past miterLimit → bevel fallback.
    const sinHalf = Math.sqrt(Math.max(0.5 * (1 - Math.abs(Tx * Nx + Ty * Ny)), 0));
    const tipDist = sinHalf > 1e-6 ? halfW / sinHalf : Infinity;
    if (tipDist > halfW * miterLimit) {
      const inTanX = atStart ? Nx : Tx, inTanY = atStart ? Ny : Ty;
      const segTanX = atStart ? Tx : Nx, segTanY = atStart ? Ty : Ny;
      if (atStart) { if (qx * -inTanX + qy * -inTanY < 0) return Infinity; }
      else if (qx * segTanX + qy * segTanY > 0) return Infinity;
      return Math.max(vertDist, exactBevelChordDist(qx, qy, halfW, inTanX, inTanY, segTanX, segTanY));
    }
    // Curvatures at this vertex: this seg's (kSS/kSE) + the neighbour's (kPE/kNS).
    const kThis  = atStart ? s.kSS : s.kSE;
    const kOther = atStart ? s.kPE : s.kNS;
    const d1 = perpDistToArc(qx, qy, Tx, Ty, kThis);
    const d2 = perpDistToArc(qx, qy, Nx, Ny, kOther);
    if (d1 <= halfW && d2 <= halfW) return Math.max(d1, d2);
    return vertDist;
  }
  if (joinStyle === JOIN_MITER || joinStyle === JOIN_MITER_CLIP) {
    // Miter: the wedge is the region within halfW of BOTH segment lines
    // through the vertex (this seg's tangent T and the neighbour's N). That
    // intersection is bounded to the miter tip automatically; outside it,
    // fall back to the disc. miter-clip caps the tip at miterLimit·halfW
    // instead of falling back to round/bevel.
    const d1 = Math.abs(qx * -Ty + qy * Tx);            // ⊥ dist to this seg's line
    const d2 = Math.abs(qx * -Ny + qy * Nx);            // ⊥ dist to neighbour's line
    const sinHalf = Math.sqrt(Math.max(0.5 * (1 - Math.abs(Tx * Nx + Ty * Ny)), 0));
    const tipDist = sinHalf > 1e-6 ? halfW / sinHalf : Infinity;   // vertex→miter tip
    const maxTip = halfW * miterLimit;
    // miter-clip retains the spike but CLIPS it at miterLimit·halfW along the
    // bisector (it does NOT fall back to bevel like plain miter). Inside the
    // wedge the bisector distance is s = (d1+d2)/(2·sinHalf) exactly, so the
    // clip s ≤ maxTip is d1+d2 ≤ 2·maxTip·sinHalf — matching the shader's
    // miterLen = min(halfW/cosHalf, halfW·miterLimit) clamp (_strokeMath.glsl).
    // The ×sinHalf form stays finite as the join sharpens (sinHalf→0 shrinks
    // the retained sliver, never divides). Under the limit (maxTip ≥ tipDist)
    // it reduces to full miter since d1+d2 ≤ 2·halfW ≤ 2·maxTip·sinHalf.
    const useMiter = joinStyle === JOIN_MITER_CLIP
      ? (d1 <= halfW && d2 <= halfW && d1 + d2 <= 2 * maxTip * sinHalf)
      : (tipDist <= maxTip && d1 <= halfW && d2 <= halfW);
    if (useMiter) return Math.max(d1, d2);
    return vertDist;
  }
  return vertDist;
}

/** Point within `halfW` of the stroke (caps + joins + dasharray gaps). */
export function pointOnStroke(segs, px, py, halfW, capStyle, joinStyle, miterLimit, dashF, dashId) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.f) continue;
    const c = closest(s, px, py);
    let d;
    if (c.where === WH_INT) d = Math.sqrt(c.d2);
    else d = capJoinDist(s, px, py, halfW, c.where === WH_START, Math.sqrt(c.d2),
                         capStyle, joinStyle, miterLimit);
    if (d > halfW) continue;
    // Dasharray: the renderer drops this seg's contribution when the
    // closest-point param falls in a GAP. Gate by the SAME true arc-length
    // distance (startDist + segLen(t)) the encoder/shaders use.
    if (dashId > 0) {
      const t = c.t < 0 ? 0 : (c.t > 1 ? 1 : c.t);
      const pathDist = (s.sd || 0) + segLenAt(s, t);
      if (!dashCovered(dashF, dashId, pathDist)) continue;
    }
    return true;
  }
  return false;
}
