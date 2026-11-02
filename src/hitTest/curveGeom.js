// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// curveGeom.js — segment decode, closest-point, dash gate, cap/join stroke band.

import { MAX_MITER_RATIO } from '../bundle/strokeReach.js';
import {
  solveQuadratic,
  solveCubic,
  solvePolyInUnitInterval,
  solveQuartic,
} from '../svg/pathBoolean/polyRoots.js';
import { strokeFrameApply, strokeFrameArc } from '../bundle/strokeFrame.js';

// The dash table's capacity, 15 texels of 4 (svg/bundleFinalize.js), as _strokeMath.glsl's walks read it.
const DASH_MAX_ENTRIES = 60;

// Gauss–Legendre 16 nodes/weights on [0,1]. Must match the encoder and the
// stroke shaders so the hit test gates dashes by the identical true arc
// length the renderer draws.
const GL16_N = [
  0.005299532504175033, 0.027712488463383711, 0.067184398806084128, 0.12229779582249847,
  0.191061877798678115, 0.270991611171386573, 0.359198224610370696, 0.452493745081181231,
  0.547506254918818769, 0.640801775389629304, 0.729008388828613427, 0.808938122201321885,
  0.87770220417750153, 0.932815601193915872, 0.972287511536616289, 0.994700467495824967,
];
const GL16_W = [
  0.013576229705877047, 0.031126761969323946, 0.047579255841246392, 0.062314485627766936,
  0.074797994408288365, 0.084578259697501269, 0.091301707522461794, 0.094725305227534248,
  0.094725305227534248, 0.091301707522461794, 0.084578259697501269, 0.074797994408288365,
  0.062314485627766936, 0.047579255841246392, 0.031126761969323946, 0.013576229705877047,
];

// Curve buffer: must match renderer/bundle.js TEX_W. Each segment record
// is header(4 floats) + data + join(4).
export const CURVE_TEX_W = 4096;
export const SEG_LINE = 0,
  SEG_QUAD = 1,
  SEG_CUBIC = 2,
  SEG_ARC = 3;

export const JOIN_MITER = 0,
  JOIN_ROUND = 1,
  JOIN_BEVEL = 2,
  JOIN_MITER_CLIP = 3,
  JOIN_ARCS = 4;

const CAP_BUTT = 0,
  CAP_SQUARE = 2; // (CAP_ROUND = 1 is the default disc)
const WH_INT = 0,
  WH_START = 1,
  WH_END = 2;

const META_TEXEL_4 = 16; // t4.xy: per-shape curve-range texel coord (gx, gy)

/** Locate the bundle's flat curve-float buffer across the input shapes. */
export function curveView(bundle) {
  if (!bundle) return null;
  if (bundle.curveFloats instanceof Float32Array) return bundle.curveFloats; // createBundle
  if (bundle.curveTexels instanceof Float32Array) return bundle.curveTexels; // textRun
  if (bundle.curves && bundle.curves.byteLength != null) return new Float32Array(bundle.curves); // sections
  return null;
}

/** The bundle's BAND table floats (same flavors as curveView) — the render's own fill-walk
 *  data, which bandWinding.js walks so hit tests answer from what is DRAWN. */
export function bandView(bundle) {
  if (!bundle) return null;
  if (bundle.bandFloats instanceof Float32Array) return bundle.bandFloats;
  if (bundle.bandTexels instanceof Float32Array) return bundle.bandTexels;
  if (bundle.bands && bundle.bands.byteLength != null) return new Float32Array(bundle.bands);
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
  let hdr = begin | 0;
  if (hdr < 0) hdr = 0;
  let penX = NaN,
    penY = NaN,
    subX = 0,
    subY = 0,
    open = false,
    seamCur = 0;

  const F32_JOINT = 4 * 2 ** -23;
  let penMag = 0,
    subMag = 0;
  const jointOpen = (ax, ay, bx, by, magA, magB) => {
    const tol =
      F32_JOINT * Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by), magA, magB);
    return Math.abs(ax - bx) > tol || Math.abs(ay - by) > tol;
  };
  while (hdr + 8 <= E) {
    // header(4) + ≥1 data texel(4)
    const raw = cv[hdr] | 0;
    const type = raw & 3;
    const fo = (raw & 4) !== 0; // is_fill_only
    // Header texel: (segType, freeStart, freeEnd, startDist). The join
    // texel (inTanX,inTanY,outTanX,outTanY) follows the data texel(s) —
    // precomputed neighbor tangents for cap/join. Both consumed by the
    // stroke band (caps at free ends, joins at interior vertices).
    const freeS = cv[hdr + 1] > 0.5,
      freeE = cv[hdr + 2] > 0.5;
    // A joined end that is the seam of a closed DASHED contour carries -L (its arc length) in its free field (svg/textures.js encodeSeg); `cL`
    // below hands every segment of the contour its L.
    const seamS = cv[hdr + 1] < 0 ? -cv[hdr + 1] : 0,
      seamE = cv[hdr + 2] < 0 ? -cv[hdr + 2] : 0;
    const sd = cv[hdr + 3]; // cumulative startDist (dashing)
    const d = hdr + 4;
    // the join texel follows the data texels: one for a line, two for a quad or cubic, three for an arc (its
    // endpoints ride a texel of their own)
    const jt = type === SEG_LINE ? hdr + 8 : type === SEG_ARC ? hdr + 16 : hdr + 12;
    const itx = cv[jt],
      ity = cv[jt + 1],
      otx = cv[jt + 2],
      oty = cv[jt + 3];
    // Arcs-join curvatures (kSelfStart, kSelfEnd, kPrevEnd, kNextStart); 0 when
    // the stroke isn't arcs (no texel present). `cadv` extends the stride.
    const kSS = hasCurv ? cv[jt + 4] : 0,
      kSE = hasCurv ? cv[jt + 5] : 0;
    const kPE = hasCurv ? cv[jt + 6] : 0,
      kNS = hasCurv ? cv[jt + 7] : 0;
    const cadv = hasCurv ? 4 : 0;
    let seg,
      sx,
      sy,
      ex,
      ey,
      startMag = 0,
      endMag = 0;
    if (type === SEG_LINE) {
      sx = cv[d];
      sy = cv[d + 1];
      ex = cv[d + 2];
      ey = cv[d + 3];
      seg = {
        t: SEG_LINE,
        x0: sx,
        y0: sy,
        x1: ex,
        y1: ey,
        f: fo,
        freeS,
        freeE,
        sd,
        itx,
        ity,
        otx,
        oty,
        kSS,
        kSE,
        kPE,
        kNS,
      };
      hdr = d + 8 + cadv;
    } else if (type === SEG_QUAD) {
      sx = cv[d];
      sy = cv[d + 1];
      const cx = cv[d + 2],
        cy = cv[d + 3];
      ex = cv[d + 4];
      ey = cv[d + 5];
      seg = {
        t: SEG_QUAD,
        x0: sx,
        y0: sy,
        cx,
        cy,
        x1: ex,
        y1: ey,
        f: fo,
        freeS,
        freeE,
        sd,
        itx,
        ity,
        otx,
        oty,
        kSS,
        kSE,
        kPE,
        kNS,
      };
      hdr = d + 12 + cadv;
    } else if (type === SEG_CUBIC) {
      sx = cv[d];
      sy = cv[d + 1];
      const c1x = cv[d + 2],
        c1y = cv[d + 3],
        c2x = cv[d + 4],
        c2y = cv[d + 5];
      ex = cv[d + 6];
      ey = cv[d + 7];
      seg = {
        t: SEG_CUBIC,
        x0: sx,
        y0: sy,
        c1x,
        c1y,
        c2x,
        c2y,
        x1: ex,
        y1: ey,
        f: fo,
        freeS,
        freeE,
        sd,
        itx,
        ity,
        otx,
        oty,
        kSS,
        kSE,
        kPE,
        kNS,
      };
      hdr = d + 12 + cadv;
    } else {
      // SEG_ARC (center form)
      const cx = cv[d],
        cy = cv[d + 1],
        rx = cv[d + 2],
        ry = cv[d + 3];
      const th0 = cv[d + 4],
        th1 = cv[d + 5],
        phi = cv[d + 6];
      const cp = Math.cos(phi),
        sp = Math.sin(phi);

      sx = cv[d + 8];
      sy = cv[d + 9];
      ex = cv[d + 10];
      ey = cv[d + 11];
      seg = {
        t: SEG_ARC,
        cx,
        cy,
        rx,
        ry,
        th0,
        th1,
        cp,
        sp,
        x0: sx,
        y0: sy,
        x1: ex,
        y1: ey,
        f: fo,
        freeS,
        freeE,
        sd,
        itx,
        ity,
        otx,
        oty,
        kSS,
        kSE,
        kPE,
        kNS,
      };
      hdr = d + 16 + cadv; // (cx, cy, rx, ry), (th0, th1, phi), the endpoints, the join
    }
    // Subpath break: close the previous (fill-only line) if the pen jumped.
    if (isNaN(penX) || jointOpen(sx, sy, penX, penY, startMag, penMag)) {
      if (open && jointOpen(penX, penY, subX, subY, penMag, subMag))
        segs.push({ t: SEG_LINE, x0: penX, y0: penY, x1: subX, y1: subY, f: true });
      subX = sx;
      subY = sy;
      subMag = startMag;
      open = true;
    }
    if (seamS > 0 || seamE > 0 || seamCur > 0) {
      if (seamS > 0) seamCur = seamS;
      if (seamCur > 0) seg.cL = seamCur;
      if (seamS > 0) seg.seamS = seamS;
      if (seamE > 0) {
        seg.seamE = seamE;
        seamCur = 0;
      }
    }
    segs.push(seg);
    penX = ex;
    penY = ey;
    penMag = endMag;
  }
  if (open && jointOpen(penX, penY, subX, subY, penMag, subMag))
    segs.push({ t: SEG_LINE, x0: penX, y0: penY, x1: subX, y1: subY, f: true });
  return segs;
}

export function perpDistToArc(qx, qy, Tx, Ty, kappa) {
  const Lx = -Ty,
    Ly = Tx; // left normal
  if (kappa === 0) return Math.abs(qx * Lx + qy * Ly);
  return (
    Math.abs(kappa * (qx * qx + qy * qy) - 2 * (qx * Lx + qy * Ly)) /
    (Math.hypot(kappa * qx - Lx, kappa * qy - Ly) + 1)
  );
}

function exactBevelChordDist(qx, qy, halfW, inTanX, inTanY, segTanX, segTanY) {
  const cr = inTanX * segTanY - inTanY * segTanX;
  const sd = cr >= 0 ? 1 : -1;
  const nAx = sd * inTanY,
    nAy = -sd * inTanX;
  const nBx = sd * segTanY,
    nBy = -sd * segTanX;
  const nbx = nAx + nBx,
    nby = nAy + nBy;
  // A reversal: the two normals cancel and the bevel has no area, so the chord adds no bound --
  // the shader leaves thisD alone there and `max(vertDist, 0)` is the same thing.
  const bl = Math.hypot(nbx, nby);
  if (bl <= 1e-4) return 0;
  const bisx = nbx / bl,
    bisy = nby / bl;
  return halfW + (qx * bisx + qy * bisy) - halfW * (nAx * bisx + nAy * bisy);
}

// ── Arc length (em-space) over the decoded native seg ──────────────────
// The dash gate must measure distance the same way the renderer draws it
// (true arc length on curves, not chord), or the hit band and the visible
// dashes would drift apart on quads/cubics/arcs.
function _segSpeed(s, t) {
  let dx, dy;
  if (s.t === SEG_LINE) {
    dx = s.x1 - s.x0;
    dy = s.y1 - s.y0;
  } else if (s.t === SEG_QUAD) {
    const u = 1 - t;
    dx = 2 * u * (s.cx - s.x0) + 2 * t * (s.x1 - s.cx);
    dy = 2 * u * (s.cy - s.y0) + 2 * t * (s.y1 - s.cy);
  } else if (s.t === SEG_CUBIC) {
    const u = 1 - t;
    dx = 3 * u * u * (s.c1x - s.x0) + 6 * u * t * (s.c2x - s.c1x) + 3 * t * t * (s.x1 - s.c2x);
    dy = 3 * u * u * (s.c1y - s.y0) + 6 * u * t * (s.c2y - s.c1y) + 3 * t * t * (s.y1 - s.c2y);
  } else {
    // SEG_ARC
    const th = s.th0 + (s.th1 - s.th0) * t,
      dth = s.th1 - s.th0;
    const ct = Math.cos(th),
      st = Math.sin(th);
    dx = (-s.cp * s.rx * st - s.sp * s.ry * ct) * dth;
    dy = (-s.sp * s.rx * st + s.cp * s.ry * ct) * dth;
  }
  return Math.hypot(dx, dy);
}
function _quadLenAt(s, t) {
  // closed form (exact)
  const ax = s.x0 - 2 * s.cx + s.x1,
    ay = s.y0 - 2 * s.cy + s.y1;
  const bx = s.cx - s.x0,
    by = s.cy - s.y0;
  const A = ax * ax + ay * ay,
    B = 2 * (ax * bx + ay * by),
    C = bx * bx + by * by;

  if (A <= 1e-12 * C) return Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * t;
  const F = (tt) => {
    const u = A * tt * tt + B * tt + C;
    if (u < 0) return 0;
    const sqrtU = Math.sqrt(u),
      sqrtA = Math.sqrt(A);
    const term1 = ((2 * A * tt + B) * sqrtU) / (4 * A);
    const disc = 4 * A * C - B * B;
    const arg = 2 * sqrtA * sqrtU + 2 * A * tt + B;
    const term2 =
      arg > 1e-12 * (2 * sqrtA * sqrtU + Math.abs(2 * A * tt + B))
        ? (disc / (8 * Math.pow(A, 1.5))) * Math.log(arg)
        : 0;
    return 2 * (term1 + term2);
  };
  return F(t) - F(0);
}
function segLenAt(s, t) {
  if (t <= 0) return 0;
  if (t > 1) t = 1;
  if (s.t === SEG_LINE) return Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * t;
  if (s.t === SEG_QUAD) return _quadLenAt(s, t);
  let sum = 0; // cubic + arc: GL-16
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
/// The seam of a closed dashed contour of length L (_strokeMath.glsl strokeSeamOn / strokeSeamResolve, line for line): is the pattern on just after
/// the contour's start AND just before its end? Then the dash passes through the seam (merged), else each end is the end of the dashes on its own side
/// (a free end, a cap). { merged, onStart, onEnd, tol } -- tol: how close to a pattern boundary a position is taken to BE on it.
function seamState(dashF, dashId, L, scale) {
  const base = (dashId - 1) * 64;
  if (!dashF || dashId <= 0 || base + 4 > dashF.length) return null;
  const cycleLen = dashF[base] * scale,
    count = (dashF[base + 1] + 0.5) | 0,
    offset = dashF[base + 2] * scale;
  if (!(cycleLen > 0) || count <= 0) return null;
  const tol = Math.min(2.4e-6 * (L + Math.abs(offset) + cycleLen), 1e-3 * cycleLen);
  const mod = (v) => {
    const m = v % cycleLen;
    return m < 0 ? m + cycleLen : m;
  };
  const on = (d, after, t) => {
    if (after) {
      if (d >= cycleLen - t) d -= cycleLen;
    } else if (d <= t) d += cycleLen;
    let accum = 0,
      res = false;
    for (let k = 0; k < count && k < DASH_MAX_ENTRIES; k++) {
      const v = dashF[base + 4 + k] * scale;
      if (
        (k & 1) === 0 &&
        v > 0 &&
        (after ? d >= accum - t && d < accum + v - t : d > accum + t && d <= accum + v + t)
      )
        res = true;
      accum += v;
    }
    return res;
  };
  const onStart = on(mod(offset), true, 0),
    onEnd = on(mod(L + offset), false, tol);
  return { merged: onStart && onEnd, onStart, onEnd, tol };
}
/// The dash set as a distance: _strokeMath.glsl dashOut, line for line. [o, side]: o the signed path-length distance to
/// the nearest boundary of the union of dashes (negative inside), side +1 at a dash's END, -1 at its START. A zero-length
/// gap joins its dashes; a zero-length dash is a point, nothing at all when `zeroDashEmpty` (butt caps). Only boundaries
/// on the subpath count, path distances in [0, sHi] (sHi its length when this segment ends it, else Infinity): past an
/// end the path's own cap is the dash's. [-1e30, 0] for no pattern or no boundary inside a dash; [1e30, 0] in a gap.
/// (The shader's also hands its coverage's edge record the next boundary's distance and whether the nearest is a dot --
///; membership needs neither, so this twin stops at [o, side].)
function dashOut(dashF, dashId, dist, zeroDashEmpty, sHi, scale, seam = null) {
  if (!dashF || dashId <= 0) return [-1e30, 0];
  const base = (dashId - 1) * 64;
  if (base + 4 > dashF.length) return [-1e30, 0];
  const cycleLen = dashF[base] * scale,
    count = (dashF[base + 1] + 0.5) | 0,
    offset = dashF[base + 2] * scale;
  if (cycleLen <= 0 || count <= 0) return [-1e30, 0];
  const ds = Math.min(Math.max(dist, 0), sHi); // a point past an end takes the end's dash state
  let d = (ds + offset) % cycleLen;
  if (d < 0) d += cycleLen;
  let accum = 0,
    best = 1e30,
    bestSide = 0,
    firstCov = -1,
    prevCov = -1,
    inside = false;
  const boundary = (b, type) => {
    let f = b - d;
    if (f < 0) f += cycleLen;
    for (const img of [f, f - cycleLen]) {
      const sb = ds + img,
        delta = sb - dist,
        side = type !== 0 ? type : delta >= 0 ? -1 : 1;
      let onPath =
        type === 0 ? sb >= 0 && sb <= sHi : side < 0 ? sb >= 0 && sb < sHi : sb > 0 && sb <= sHi;
      // a closed contour's seam the dash passes through has no boundary: not the START at its start, nor the END at its end
      if (
        onPath &&
        type !== 0 &&
        seam &&
        seam.merged &&
        ((side < 0 && sb <= seam.tol) || (side > 0 && sb >= sHi - seam.tol))
      )
        onPath = false;
      // ...and a dash that would START at its end or END at its start has no length
      if (
        onPath &&
        type !== 0 &&
        seam &&
        ((side < 0 && sb >= sHi - seam.tol) || (side > 0 && sb <= seam.tol))
      )
        onPath = false;
      if (onPath && Math.abs(delta) < best) {
        best = Math.abs(delta);
        bestSide = side;
      }
    }
  };
  for (let k = 0; k < count && k < DASH_MAX_ENTRIES; k++) {
    const v = dashF[base + 4 + k] * scale,
      cov = (k & 1) === 0 ? 1 : 0;
    if (v > 0) {
      if (d >= accum && d < accum + v) inside = cov === 1;
      if (firstCov < 0) firstCov = cov;
      if (prevCov >= 0 && prevCov !== cov) boundary(accum, cov === 1 ? -1 : 1);
      prevCov = cov;
    } else if (cov === 1 && !zeroDashEmpty) boundary(accum, 0);
    accum += v;
  }
  if (firstCov >= 0 && prevCov !== firstCov) boundary(0, firstCov === 1 ? -1 : 1);
  // at the END of a closed contour the state is the one just before it (the dash ending there is on)
  if (seam && ds >= sHi) inside = seam.onEnd;
  if (best >= 1e30) return [inside ? -1e30 : 1e30, 0];
  return [inside ? -best : best, bestSide];
}
// em-per-screen-pixel from the worldMatrix scale — for non-scaling-stroke,
// the rendered band is a constant SCREEN width, so its em half-width is
// halfW·emPerPx.
export function emPerPxOf(world) {
  if (!world) return 1;
  const sx = Math.hypot(world[0], world[1]),
    sy = Math.hypot(world[3], world[4]);
  // No tolerance: an axis is degenerate only when it has no length at all (or its inverse does not fit a double). It then takes the
  // other axis's size, and a matrix with neither says nothing about a pixel.
  const ex = 1 / sx,
    ey = 1 / sy,
    okx = ex < Infinity,
    oky = ey < Infinity;
  if (okx && oky) return 0.5 * (ex + ey);
  return okx ? ex : oky ? ey : 1;
}

function sq(ax, ay, bx, by) {
  const dx = ax - bx,
    dy = ay - by;
  return dx * dx + dy * dy;
}

function segMag(s) {
  if (s.t === SEG_ARC)
    return Math.max(Math.abs(s.cx), Math.abs(s.cy)) + Math.max(Math.abs(s.rx), Math.abs(s.ry));
  let m = Math.max(Math.abs(s.x0), Math.abs(s.y0), Math.abs(s.x1), Math.abs(s.y1));
  if (s.t === SEG_QUAD) m = Math.max(m, Math.abs(s.cx), Math.abs(s.cy));
  else if (s.t === SEG_CUBIC)
    m = Math.max(m, Math.abs(s.c1x), Math.abs(s.c1y), Math.abs(s.c2x), Math.abs(s.c2y));
  return m;
}
function unit(x, y, s) {
  const L = Math.hypot(x, y);
  return L > 64 * Number.EPSILON * segMag(s) ? [x / L, y / L] : [0, 0];
}
function arcPt(s, th) {
  return [
    s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
    s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp,
  ];
}

// Forward (increasing-t) unit tangent at the start / end of a seg.
//
// A zero-radius arc is SVG's straight line between its ends (segment.js arcEndpointToCenter keeps it as a half-turn of a
// degenerate ellipse, which turns round AT its ends: its velocity there is a rounding, and had no direction, so a butt
// cap there cut nothing). Its ends run along its chord, as the encoder's (textures.js segTangentAt) and the stroke
// shader's do.
//
const quadSpan = (s) =>
  Math.max(
    Math.max(s.x0, s.cx, s.x1) - Math.min(s.x0, s.cx, s.x1),
    Math.max(s.y0, s.cy, s.y1) - Math.min(s.y0, s.cy, s.y1),
  );

const cubicSpan = (s) =>
  Math.max(
    Math.max(s.x0, s.c1x, s.c2x, s.x1) - Math.min(s.x0, s.c1x, s.c2x, s.x1),
    Math.max(s.y0, s.c1y, s.c2y, s.y1) - Math.min(s.y0, s.c1y, s.c2y, s.y1),
  );
function cubicEndDir(s, atStart) {
  const m = 1e-9 * cubicSpan(s);
  let dx = atStart ? 3 * (s.c1x - s.x0) : 3 * (s.x1 - s.c2x),
    dy = atStart ? 3 * (s.c1y - s.y0) : 3 * (s.y1 - s.c2y);
  if (!(Math.hypot(dx, dy) > m)) {
    dx = s.c2x - s.c1x;
    dy = s.c2y - s.c1y;
  }
  if (!(Math.hypot(dx, dy) > m)) {
    dx = s.x1 - s.x0;
    dy = s.y1 - s.y0;
  }
  return unit(dx, dy, s);
}
export function tangentStart(s) {
  // exported for the tests
  if (s.t === SEG_LINE) return unit(s.x1 - s.x0, s.y1 - s.y0, s);
  if (s.t === SEG_QUAD) {
    let dx = s.cx - s.x0,
      dy = s.cy - s.y0;
    if (!(2 * Math.hypot(dx, dy) > 1e-9 * quadSpan(s))) {
      dx = s.x1 - s.x0;
      dy = s.y1 - s.y0;
    }
    return unit(dx, dy, s);
  }
  if (s.t === SEG_CUBIC) return cubicEndDir(s, true);
  if (s.rx === 0 || s.ry === 0) return unit(s.x1 - s.x0, s.y1 - s.y0, s); // a zero-radius arc: its chord
  const dir = s.th1 >= s.th0 ? 1 : -1;
  return unit(
    (-s.rx * Math.sin(s.th0) * s.cp - s.ry * Math.cos(s.th0) * s.sp) * dir,
    (-s.rx * Math.sin(s.th0) * s.sp + s.ry * Math.cos(s.th0) * s.cp) * dir,
    s,
  );
}
export function tangentEnd(s) {
  if (s.t === SEG_LINE) return unit(s.x1 - s.x0, s.y1 - s.y0, s);
  if (s.t === SEG_QUAD) {
    let dx = s.x1 - s.cx,
      dy = s.y1 - s.cy;
    if (!(2 * Math.hypot(dx, dy) > 1e-9 * quadSpan(s))) {
      dx = s.x1 - s.x0;
      dy = s.y1 - s.y0;
    }
    return unit(dx, dy, s);
  }
  if (s.t === SEG_CUBIC) return cubicEndDir(s, false);
  if (s.rx === 0 || s.ry === 0) return unit(s.x1 - s.x0, s.y1 - s.y0, s);
  const dir = s.th1 >= s.th0 ? 1 : -1;
  return unit(
    (-s.rx * Math.sin(s.th1) * s.cp - s.ry * Math.cos(s.th1) * s.sp) * dir,
    (-s.rx * Math.sin(s.th1) * s.sp + s.ry * Math.cos(s.th1) * s.cp) * dir,
    s,
  );
}

// Closest approach: { d2 (squared distance), where }. `where` classifies
// the nearest point as interior / start vertex / end vertex (when an
// interior foot exists it is ≤ the endpoint distance, so the nearest
// point is at a vertex only for points genuinely beyond that end).
export function closest(s, px, py) {
  const dS = sq(px, py, s.x0, s.y0),
    dE = sq(px, py, s.x1, s.y1);
  let dI = Infinity,
    tI = 0; // tI = interior closest-point param (dashing)
  if (s.t === SEG_LINE) {
    const dx = s.x1 - s.x0,
      dy = s.y1 - s.y0,
      len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      const t = ((px - s.x0) * dx + (py - s.y0) * dy) / len2;
      if (t > 0 && t < 1) {
        dI = sq(px, py, s.x0 + t * dx, s.y0 + t * dy);
        tI = t;
      }
    }
  } else if (s.t === SEG_QUAD) {
    // FROM THE NEARER END, as the shader's strokeQuadAccum solves it. Written from the start,
    // the cubic's coefficients are direct differences there and cancel segment-sized terms at t = 1;
    // when the end handle is short (zero: the control point ON the end point) three roots crowd t = 1,
    // Cardano can return one at 1 - 4e-14 for a point past the end, it ties the endpoint's distance,
    // the interior wins the tie, and the butt cap is skipped. From the end, a zero handle makes the
    // constant and quadratic coefficients exactly zero and the root exactly 0 -- as the start's is.
    const rev = dE < dS;
    const ox = rev ? s.x1 : s.x0,
      oy = rev ? s.y1 : s.y0;
    const a1x = 2 * (s.cx - ox),
      a1y = 2 * (s.cy - oy);
    const a2x = s.x0 - 2 * s.cx + s.x1,
      a2y = s.y0 - 2 * s.cy + s.y1;
    const d0x = ox - px,
      d0y = oy - py;
    const c3 = 2 * (a2x * a2x + a2y * a2y),
      c2 = 3 * (a1x * a2x + a1y * a2y);
    const c1 = 2 * (d0x * a2x + d0y * a2y) + (a1x * a1x + a1y * a1y),
      c0 = d0x * a1x + d0y * a1y;
    for (const u of solveCubic(c3, c2, c1, c0)) {
      if (u <= 0 || u >= 1) continue;
      const dd = sq(px, py, ox + a1x * u + a2x * u * u, oy + a1y * u + a2y * u * u);
      if (dd < dI) {
        dI = dd;
        tI = rev ? 1 - u : u;
      }
    }
  } else if (s.t === SEG_CUBIC) {
    // FROM THE NEARER END, as the shader's strokeCubicAccum solves it (and as the quad above does). Written
    // from the start, the quintic's roots crowd t = 1 when the end's handle is short or zero, the solve returns
    // one a rounding inside the end for a point past it, it ties the endpoint's distance, and the butt cap is
    // skipped. From the end, a zero handle makes the low coefficients exactly zero and the root exactly 0.
    const rev = dE < dS;
    const ox = rev ? s.x1 : s.x0,
      oy = rev ? s.y1 : s.y0;
    const q1x = rev ? s.c2x : s.c1x,
      q1y = rev ? s.c2y : s.c1y,
      q2x = rev ? s.c1x : s.c2x,
      q2y = rev ? s.c1y : s.c2y;
    const ex = rev ? s.x0 : s.x1,
      ey = rev ? s.y0 : s.y1;
    const a1x = 3 * (q1x - ox),
      a1y = 3 * (q1y - oy);
    const a2x = 3 * (ox - 2 * q1x + q2x),
      a2y = 3 * (oy - 2 * q1y + q2y);
    const a3x = -ox + 3 * q1x - 3 * q2x + ex,
      a3y = -oy + 3 * q1y - 3 * q2y + ey;
    const d0x = ox - px,
      d0y = oy - py;
    const f0 = d0x * a1x + d0y * a1y;
    const f1 = 2 * (d0x * a2x + d0y * a2y) + (a1x * a1x + a1y * a1y);
    const f2 = 3 * (d0x * a3x + d0y * a3y) + 3 * (a1x * a2x + a1y * a2y);
    const f3 = 4 * (a1x * a3x + a1y * a3y) + 2 * (a2x * a2x + a2y * a2y);
    const f4 = 5 * (a2x * a3x + a2y * a3y),
      f5 = 3 * (a3x * a3x + a3y * a3y);
    for (const t of solvePolyInUnitInterval([f0, f1, f2, f3, f4, f5])) {
      if (t <= 0 || t >= 1) continue;
      const dd = sq(
        px,
        py,
        ox + a1x * t + a2x * t * t + a3x * t * t * t,
        oy + a1y * t + a2y * t * t + a3y * t * t * t,
      );
      if (dd < dI) {
        dI = dd;
        tI = rev ? 1 - t : t;
      }
    }
  } else {
    // SEG_ARC
    const lo = Math.min(s.th0, s.th1),
      hi = Math.max(s.th0, s.th1);
    const consider = (th) => {
      while (th < lo) th += 2 * Math.PI;
      while (th >= lo + 2 * Math.PI) th -= 2 * Math.PI;
      if (th > hi || th - lo < 1e-9 || hi - th < 1e-9) return; // interior only
      const p = arcPt(s, th);
      const dd = sq(px, py, p[0], p[1]);
      if (dd < dI) {
        dI = dd;
        tI = (th - s.th0) / (s.th1 - s.th0);
      }
    };
    const Dx = s.cx - px,
      Dy = s.cy - py;
    const a = Dx * s.cp + Dy * s.sp,
      b = -Dx * s.sp + Dy * s.cp;
    if (s.rx === 0 || s.ry === 0) {
      // A zero radius: the ellipse is a segment along its other axis, traced out and back, and the foot is the point of
      // it nearest the query -- TWO angles, mirror images across that axis (the shader's arcFootAngle). Where the
      // foot is where the axis turns round and the arc ENDS there (SVG's zero-radius arc, a half-turn, ends at both), it
      // is the end, and the end's cap has the point: the stored end angle is that turn's float32, a rounding past it, and
      // the quartic below and the interior test took it for the body.
      const cons = (th) => {
        for (const e of [s.th0, s.th1])
          if (
            Math.fround(th + 2 * Math.PI * Math.round((e - th) / (2 * Math.PI))) === Math.fround(e)
          )
            return;
        consider(th);
      };
      if (s.rx !== 0) {
        const t = Math.acos(Math.min(Math.max(-a / s.rx, -1), 1));
        cons(t);
        cons(-t);
      } else if (s.ry !== 0) {
        const t = Math.asin(Math.min(Math.max(-b / s.ry, -1), 1));
        cons(t);
        cons(Math.PI - t);
      }
    } else if (Math.abs(s.rx - s.ry) <= 1e-9 * Math.max(s.rx, s.ry)) {
      // a circle, relative to its size
      consider(Math.atan2(-b, -a));
    } else {
      const K = s.ry * s.ry - s.rx * s.rx;
      for (const w of solveQuartic(
        -s.ry * b,
        -2 * K - 2 * s.rx * a,
        0,
        2 * K - 2 * s.rx * a,
        s.ry * b,
      ))
        consider(2 * Math.atan(w));
      consider(Math.PI);
    }
  }
  if (dI <= dS && dI <= dE) return { d2: dI, where: WH_INT, t: tI };
  if (dS <= dE) return { d2: dS, where: WH_START, t: 0 };
  return { d2: dE, where: WH_END, t: 1 };
}

// The SVG 2 join region at the vertex between two STRAIGHT segments (painting.html, "Computing
// the shape of the stroke"), q relative to the vertex, tA the incoming direction and tB the
// outgoing one. Every join shape lies in the wedge between the two segments' perpendiculars:
// bevel = triangle(P, P1, P2); round = bevel plus the circular SECTOR from P1 to P2; miter =
// bevel plus the tip triangle when 1/sin(theta/2) <= limit, otherwise bevel; miter-clip, and arcs
// (which SVG 2 sends to miter-clip for straight segments), clip that region at limit * halfW along
// the bisector. The shader's line branch draws the same region for miter, round and bevel
// (test/strokeLineJoinSvgShapeSmoke.mjs); outside the wedge the segment ends in a butt end, so a
// point there is not the join's to claim.
function lineJoinContains(qx, qy, halfW, tAx, tAy, tBx, tBy, joinStyle, miterLimit) {
  if (qx * tAx + qy * tAy < 0 || qx * tBx + qy * tBy > 0) return false;
  const cr = tAx * tBy - tAy * tBx;
  if (cr === 0 && tAx * tBx + tAy * tBy > 0) return false; // straight on: no join area
  const sd = cr >= 0 ? 1 : -1;
  const nAx = sd * tAy,
    nAy = -sd * tAx,
    nBx = sd * tBy,
    nBy = -sd * tBx;
  if (joinStyle === JOIN_ROUND) return qx * qx + qy * qy <= halfW * halfW; // the wedge IS the sector
  const bx = nAx + nBx,
    by = nAy + nBy,
    bl = Math.hypot(bx, by);
  if (bl === 0) return false; // a reversal: bevel has no area
  const bisx = bx / bl,
    bisy = by / bl;
  const qBis = qx * bisx + qy * bisy;
  if (qBis <= halfW * (nAx * bisx + nAy * bisy)) return true; // the bevel triangle
  if (joinStyle === JOIN_BEVEL) return false;
  // sin(theta/2) of the interior angle: half the distance between (-tA) and tB (the shader's form; 1 + dot cancels near a reversal)
  const sinHalf = 0.5 * Math.hypot(tAx + tBx, tAy + tBy);
  const inKite = qx * nAx + qy * nAy <= halfW && qx * nBx + qy * nBy <= halfW;
  // the renderer stores no limit above MAX_MITER_RATIO (the reach bound, bundle/strokeReach.js), so a ratio past it bevels in both
  if (joinStyle === JOIN_MITER)
    return halfW <= Math.min(miterLimit, MAX_MITER_RATIO) * halfW * sinHalf && inKite;
  return inKite && qBis <= miterLimit * halfW; // miter-clip, arcs
}

// Cap (free end) / join (interior vertex) at the nearest vertex. Returns
// the effective distance (Infinity = not in the band there). `vertDist`
// is the natural distance to the vertex (round cap / round-bevel disc).
// `capStyle` caps a free START, `endCapStyle` a free END: the shaders take the
// pair (mantle.frag.glsl decodes meta slot 46's "same as the start cap"
// sentinel into it), and this read only the start one, so a bundle with the two
// different -- Flash LineStyle2 makes them, SVG has no syntax for it -- hit
// tested its end cap as the start's.
function capJoinDist(
  s,
  px,
  py,
  halfW,
  atStart,
  vertDist,
  capStyle,
  joinStyle,
  miterLimit,
  endCapStyle = capStyle,
) {
  const Vx = atStart ? s.x0 : s.x1,
    Vy = atStart ? s.y0 : s.y1;
  const qx = px - Vx,
    qy = py - Vy;
  const T = atStart ? tangentStart(s) : tangentEnd(s);
  const Tx = T[0],
    Ty = T[1];
  if (s.t === SEG_LINE && !(atStart ? s.freeS : s.freeE)) {
    // A straight segment's interior end: the SVG 2 join region, or nothing (0 inside, Infinity
    // outside). The disc fallback below painted a full halfW disc at the vertex, which a neighbor
    // shorter than halfW did not cover, and a round shoulder on a miter past its limit.
    const nl = Math.hypot(atStart ? s.itx : s.otx, atStart ? s.ity : s.oty) || 1;
    const Nx = (atStart ? s.itx : s.otx) / nl,
      Ny = (atStart ? s.ity : s.oty) / nl;
    const inside = atStart
      ? lineJoinContains(qx, qy, halfW, Nx, Ny, Tx, Ty, joinStyle, miterLimit)
      : lineJoinContains(qx, qy, halfW, Tx, Ty, Nx, Ny, joinStyle, miterLimit);
    return inside ? 0 : Infinity;
  }
  if (atStart ? s.freeS : s.freeE) {
    // ── cap ──
    const cap = atStart ? capStyle : endCapStyle; // each free end takes its own
    const ox = atStart ? -Tx : Tx,
      oy = atStart ? -Ty : Ty; // outward (beyond) dir
    const a = qx * ox + qy * oy; // projection beyond the end
    if (cap === CAP_BUTT)
      // flat: clip at the end plane
      return a > 0 ? Infinity : vertDist;
    if (cap !== CAP_SQUARE) return vertDist; // round half-disc
    if (a < 0 || a > halfW) return Infinity; // square: halfW box extension
    return Math.hypot(qx - ox * a, qy - oy * a);
  }
  // ── join ──
  const Nx = atStart ? s.itx : s.otx,
    Ny = atStart ? s.ity : s.oty;
  // OUTSIDE THE JOIN WEDGE, A BUTT END -- and the hit test had NO TWIN OF this AT ALL.

  // The butt end is `max(vertDist, halfW + aOut)` with aOut how far the point lies BEYOND this
  // segment's own end plane -- the same SDF the butt CAP above uses, and the shader's expression
  // written in the hit test's sign convention. A straight segment's interior end returned above,
  // through lineJoinContains, which carries the same rule as a membership test.
  {
    const nl = Math.hypot(Nx, Ny) || 1;
    const side = (qx * Nx + qy * Ny) / nl;
    if (atStart ? side < 0 : side > 0) {
      // The plane is an edge only AHEAD of it (the shader's aJ > 0.0): behind it the point is inside this segment's body and the
      // neighbor's, and the end gate's zone (1e-4 of the segment) must not read the plane as the shape's boundary.
      const aOut = atStart ? -(qx * Tx + qy * Ty) : qx * Tx + qy * Ty;
      return aOut > 0 ? Math.max(vertDist, halfW + aOut) : vertDist;
    }
  }
  if (joinStyle === JOIN_BEVEL) {
    const inTanX = atStart ? Nx : Tx,
      inTanY = atStart ? Ny : Ty;
    const segTanX = atStart ? Tx : Nx,
      segTanY = atStart ? Ty : Ny;

    return Math.max(vertDist, exactBevelChordDist(qx, qy, halfW, inTanX, inTanY, segTanX, segTanY));
  }
  if (joinStyle === JOIN_ROUND) return vertDist;
  if (joinStyle === JOIN_ARCS) {
    const own = [atStart ? -Tx : Tx, atStart ? -Ty : Ty]; // this seg's outward dir
    const other = [atStart ? Nx : -Nx, atStart ? Ny : -Ny]; // the neighbor's, outward
    const cosBetween = own[0] * other[0] + own[1] * other[1];
    // half the distance between the two outward unit vectors: no absolute floor on the angle (an exact reversal is an infinite ratio)
    const sinHalf = 0.5 * Math.hypot(own[0] - other[0], own[1] - other[1]);
    const cosHalf = Math.sqrt(Math.max(0.5 * (1 + cosBetween), 0));
    const miterLen = halfW / sinHalf;
    const ml = Math.max(miterLimit, 1);
    // Curvatures at this vertex: this seg's (kSS/kSE) + the neighbor's (kPE/kNS).
    const kThis = atStart ? s.kSS : s.kSE;
    const kOther = atStart ? s.kPE : s.kNS;
    let d1 = perpDistToArc(qx, qy, Tx, Ty, kThis);
    const d2 = perpDistToArc(qx, qy, Nx, Ny, kOther);
    // The reach cut, whenever an edge is curved at all. A threshold such as `max |kappa| >= 1e-6` would be scale-dependent
    // (kappa is 1 / length, so at 1e6 every unit-radius edge would be "straight" and lose the cut). The far band
    // intersection lies outside the vertex's normal cone, where this branch never runs, so this rarely changes a point,
    // but exact zero keeps straight edges exactly straight at every scale.
    if (kThis !== 0 || kOther !== 0)
      d1 = Math.max(d1, halfW + Math.hypot(qx, qy) - halfW * Math.sqrt(ml * ml + 1));
    const along = qx * own[0] + qy * own[1];
    if (miterLen <= halfW * Math.min(miterLimit, MAX_MITER_RATIO)) {
      if (along >= 0 && along <= miterLen * cosHalf && d1 <= halfW && d2 <= halfW)
        return Math.max(d1, d2);
      return vertDist;
    }
    const tipx = own[0] + other[0],
      tipy = own[1] + other[1],
      tl = Math.hypot(tipx, tipy);
    let dc = Math.max(d1, d2);
    if (tl > 1e-4) dc = Math.max(dc, halfW + (qx * tipx + qy * tipy) / tl - halfW * ml);
    return dc;
  }
  if (joinStyle === JOIN_MITER || joinStyle === JOIN_MITER_CLIP) {
    // Miter: the wedge is the region within halfW of both segment lines
    // through the vertex (this seg's tangent T and the neighbor's N). That
    // intersection is bounded to the miter tip automatically; outside it,
    // fall back to the disc. miter-clip caps the tip at miterLimit·halfW
    // instead of falling back to round/bevel.
    const d1 = Math.abs(qx * -Ty + qy * Tx); // ⊥ dist to this seg's line
    const d2 = Math.abs(qx * -Ny + qy * Nx); // ⊥ dist to neighbor's line
    // Miter length is halfW / sin(theta/2), WITH theta THE INTERIOR ANGLE -- and this computed
    // cos(theta/2) with an abs() on top. T and N are the two tangents in path order, so
    // cos(theta) = -dot(T, N) and sin(theta/2) = sqrt((1 + dot(T, N)) / 2). The `1 - |dot|` form is
    // the inversion _coverage.glsl and _strokeMath.glsl both carry a paragraph against: too short
    // at sharp corners, unbounded at flat ones. An abs() would hide the worse half -- at a near-reversal
    // dot -> -1 and it lands on 0, which is right by accident -- and leave the other: at a GENTLE
    // join, where the true miter is barely longer than halfW, it gives halfW / sqrt((1-dot)/2),
    // 11.5 half-widths at a 10-degree turn, so every shallow join would read as past its limit. Two other
    // functions in this file use the same form: lineJoinContains (the straight-segment join,
    // swept exactly against SVG 2 by test/hitStrokeJoinSvgShapeSmoke.mjs) and JOIN_ARCS just above.
    const sinHalf = 0.5 * Math.hypot(Tx + Nx, Ty + Ny); // half the distance between (-T) and N
    const tipDist = halfW / sinHalf; // vertex→miter tip (Infinity at an exact reversal)
    const maxTip = halfW * Math.min(miterLimit, MAX_MITER_RATIO);
    const mlj = Math.max(miterLimit, 1);
    const cosHalf = Math.sqrt(Math.max(0.5 * (1 - (Tx * Nx + Ty * Ny)), 0));

    const ownx = atStart ? -Tx : Tx,
      owny = atStart ? -Ty : Ty;
    const along = qx * ownx + qy * owny;
    const capAlong = tipDist <= maxTip ? tipDist * cosHalf : 0;
    // Inside the wedge and within the tip, the join is the strip intersection; the shader takes
    // min(vertDist, max) there, so a point inside the halfW disc stays inside.
    if (along >= 0 && along <= capAlong) return Math.min(vertDist, Math.max(d1, d2));
    if (joinStyle === JOIN_MITER_CLIP && tipDist > maxTip) {
      // PAST THE LIMIT, MITER-CLIP IS THE STRIP INTERSECTION CUT SQUARE TO THE BISECTOR at
      // miterLimit * halfW (SVG 2: "clip any part of the line join region that extends past the
      // miter limit"), plus the reach cut src/bundle/strokeReach.js's bound needs — the shader's
      // three terms, and JOIN_ARCS above already spells them this way.
      //
      const tipx = atStart ? Nx - Tx : Tx - Nx,
        tipy = atStart ? Ny - Ty : Ty - Ny;
      const tl = Math.hypot(tipx, tipy);
      let dc = Math.max(d1, d2);
      if (tl > 1e-4) dc = Math.max(dc, halfW + (qx * tipx + qy * tipy) / tl - halfW * mlj);
      // A clipped miter is still bounded. The clip fixes the bisector component only, and at a
      // near-reversal the two tangent strips are nearly parallel: their intersection runs on
      // BACKWARDS from the vertex, 80 half-widths at a 179-degree turn.
      return Math.max(dc, halfW + Math.hypot(qx, qy) - halfW * Math.sqrt(mlj * mlj + 1));
    }
    // A MITER PAST ITS LIMIT IS A BEVEL (SVG 2: "Return bevel"), not the halfW disc `vertDist`
    // leaves. Straight segments take lineJoinContains above, which has had this; a CURVE
    // reaching here kept the round shoulder, and so did the shader's curve branch.
    if (joinStyle === JOIN_MITER && tipDist > maxTip) {
      const inTanX = atStart ? Nx : Tx,
        inTanY = atStart ? Ny : Ty;
      const segTanX = atStart ? Tx : Nx,
        segTanY = atStart ? Ty : Ny;
      return Math.max(
        vertDist,
        exactBevelChordDist(qx, qy, halfW, inTanX, inTanY, segTanX, segTanY),
      );
    }
    return vertDist;
  }
  return vertDist;
}

/// A stroke row drawn in STROKE SPACE (meta flag FS_STROKE_LOCAL): its decoded document-space segments
/// mapped through the row's frame N (bundle/strokeFrame.js), as the shader's walk maps them -- points by N, an arc to
/// its image ellipse with the parameter carried pointwise, the join tangents to stroke-space unit directions. startDist
/// and the arcs-join curvatures are stroke-space already (the encoder wrote them so). Query the result with the point
/// mapped by N too; the fill-only closing lines are passed through untouched (the stroke skips them).
export function strokeFrameSegs(segs, N) {
  const P = (x, y) => strokeFrameApply(N, x, y);
  const D = (x, y) => {
    const [u, v] = P(x, y);
    const l = Math.hypot(u, v);
    return l > 0 ? [u / l, v / l] : [0, 0];
  };
  return segs.map((s) => {
    if (s.f) return s;
    const [x0, y0] = P(s.x0, s.y0),
      [x1, y1] = P(s.x1, s.y1);
    const [itx, ity] = D(s.itx, s.ity),
      [otx, oty] = D(s.otx, s.oty);
    const o = { ...s, x0, y0, x1, y1, itx, ity, otx, oty };
    if (s.t === SEG_QUAD) {
      [o.cx, o.cy] = P(s.cx, s.cy);
    } else if (s.t === SEG_CUBIC) {
      [o.c1x, o.c1y] = P(s.c1x, s.c1y);
      [o.c2x, o.c2y] = P(s.c2x, s.c2y);
    } else if (s.t === SEG_ARC) {
      const a = strokeFrameArc(N, s.cx, s.cy, s.rx, s.ry, Math.atan2(s.sp, s.cp), s.th0, s.th1);
      Object.assign(o, {
        cx: a.cx,
        cy: a.cy,
        rx: a.rx,
        ry: a.ry,
        th0: a.th0,
        th1: a.th1,
        cp: Math.cos(a.phi),
        sp: Math.sin(a.phi),
      });
    }
    return o;
  });
}

/** Point within `halfW` of the stroke (caps + joins + dasharray gaps).
 *  `endCapStyle` defaults to `capStyle`; pass both when the meta row carries an
 *  asymmetric pair. */
export function pointOnStroke(
  segs,
  px,
  py,
  halfW,
  capStyle,
  joinStyle,
  miterLimit,
  dashF,
  dashId,
  endCapStyle = capStyle,
  dashScale = 1,
) {
  const seamMemo = new Map();
  for (let i = 0; i < segs.length; i++) {
    let s = segs[i];
    if (s.f) continue;
    // A closed dashed contour's seam (see seamState): a seam end the dash does not pass through is the end of the dashes on its side, a free end.
    let seam = null;
    if (dashId > 0 && s.cL > 0) {
      seam = seamMemo.get(s.cL);
      if (seam === undefined) {
        seam = seamState(dashF, dashId, s.cL, dashScale);
        seamMemo.set(s.cL, seam);
      }
      if (seam && !seam.merged && (s.seamS > 0 || s.seamE > 0))
        s = { ...s, freeS: s.freeS || s.seamS > 0, freeE: s.freeE || s.seamE > 0 };
    }
    let c = closest(s, px, py);
    let d;
    if (c.where === WH_INT) d = Math.sqrt(c.d2);
    else {
      d = capJoinDist(
        s,
        px,
        py,
        halfW,
        c.where === WH_START,
        Math.sqrt(c.d2),
        capStyle,
        joinStyle,
        miterLimit,
        endCapStyle,
      );
      // A SEGMENT THAT CLOSES ON ITSELF (a lone full-circle arc, whose stored ends are one vertex) has one
      // vertex that is both its ends, and the join there is seen from both sides -- as a vertex between two segments
      // is, by each segment's own end. closest() names one end when the two are equally near, which a point on the
      // seam's normal always is; the other end's side of the join is asked too, so neither side's butt end drops it.
      if (s.x0 === s.x1 && s.y0 === s.y1) {
        const atStart = c.where !== WH_START;
        const d2 = capJoinDist(
          s,
          px,
          py,
          halfW,
          atStart,
          Math.sqrt(c.d2),
          capStyle,
          joinStyle,
          miterLimit,
          endCapStyle,
        );
        if (d2 < d) {
          d = d2;
          c = { d2: c.d2, where: atStart ? WH_START : WH_END, t: atStart ? 0 : 1 };
        }
      }
    }
    if (d > halfW) continue;

    if (dashId > 0) {
      const t = c.t < 0 ? 0 : c.t > 1 ? 1 : c.t;
      // past an end, the path distance carries on along the end's tangent (the renderer's rule; see dashOut)
      let along = 0;
      if (c.where === WH_START) {
        const T = tangentStart(s);
        along = (px - s.x0) * T[0] + (py - s.y0) * T[1];
      } else if (c.where === WH_END) {
        const T = tangentEnd(s);
        along = (px - s.x1) * T[0] + (py - s.y1) * T[1];
      }
      const pathDist = (s.sd || 0) + segLenAt(s, t) + along;
      const [o, side] = dashOut(
        dashF,
        dashId,
        pathDist,
        capStyle === 0 && endCapStyle === 0,
        s.cL > 0 ? s.cL : s.freeE ? (s.sd || 0) + segLenAt(s, 1) : Infinity,
        dashScale,
        seam,
      );
      if (o > -1e29) {
        const cap = side < 0 ? capStyle : endCapStyle;
        if (cap === 1) {
          if (o > 0 && Math.hypot(d, o) > halfW) continue;
        } else if ((cap === 2 ? o : halfW + o) > halfW) continue;
      }
    }
    return true;
  }
  return false;
}
