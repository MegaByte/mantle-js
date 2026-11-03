// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/textures.js — curve + band texture encoders, segment-tangent and
// arc-length helpers, and buildTexturesShape that emits a shape's
// RGBA32F curve/band-list data into the bundle's shared buffers.
//
// The texel-buffer abstraction is a growable Float64Array that flushes
// to RGBA32F via texelToBytes; curveBuf packs per-segment quartets
// while bandBuf packs the per-band index lists the fill fragment shader
// walks for ray-cast. segTangentAt + buildPathArcLengthLut +
// samplePathAt support <textPath> and dash-pattern offset computation.
//
// TEXTURE_WIDTH = 4096 is the bundle's curve/band texture width (the
// maximum the WebGL2 spec guarantees on every conformant impl);
// importer wraps offsets via MantleCalcBandLoc on the GPU side.

import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  segStart,
  segEnd,
  pointsMeet,
  jointMag,
  isZeroLengthSeg,
  mkLine,
} from './segment.js';
import { segBboxInto, curveTightBboxCubicInto } from './bbox.js';
// Pure cubic math for the GWN run tree's piece expansion (no GL, no module state).
import {
  cubicKLMN,
  cubicInflections,
  cubicLoopParams,
  splitCubic,
  splitCubicMulti,
} from '../geom/lbCubicMath.js';
import { solveCubic } from './pathBoolean/polyRoots.js';
import { transformSegInto } from './transform.js';
import { cubicCuspT } from './cubicCusp.js';
import { raySegCrossExact, rayWindingExact, buildSegWindingTree } from '../geom/lbContour.js';
import { treeWinding } from '../geom/windingTree.js';
import { arcToRQuads } from '../geom/cpatchImplicit.js';
import { SEG_RQUAD } from '../primitives/seg.js';
import { mantleDebugHook } from '../core/diagnostics.js';

const TEXTURE_WIDTH = 4096;

/// The crossing-axis lanes: bit 0 of texel 1's .y in every band header (H, V and AAC
/// level bands alike) of a structure whose entries carry them. A band entry is (loc, breakAxis, z, w);
/// with the bit set, (z, w) is the segment's (min, max) on the band's CROSSING axis -- y for an H list,
/// x for a V list -- and a fill walker rejects an entry whose range misses its ray before fetching the
/// segment. Without it (z, w) is (the far bound on the break axis, 0), which the STROKE walker reads.
/// Band 0's .y otherwise holds the AAC level slot, which is even by construction, so `& ~1` recovers it
/// and the shader's `/ 2` already ignores the bit. Every bundle written has the bit clear.
/// Readers: _coverage.glsl bandHasRayLanes, hitTest/bandWinding.js, core/morphCore.js (which clears
/// it), and test/_glslEmu.mjs scaleFillData.
export const BAND_HDR_RAY_LANES = 1;

const ARC_LANE_REL = 2 ** -10;

/**
 * @param {Float64ArrayConstructor | Float32ArrayConstructor} [Storage]
 * @param {number} [capacityTexels]
 */
export function makeTexelBuffer(Storage = Float64Array, capacityTexels = 256) {
  // Growable texel buffer, 4 floats per texel at index (texelIdx*4 .. +3). Storage is Float64Array by default; a buffer that is
  // only ever WRITTEN here and narrowed to float32 at the end (the band buffer: no reader sees it before texelToBytes) can pass
  // Float32Array: rounding at the store is the rounding the final downcast would do, so the bytes are identical, and the buffer
  // is half the size. `capacityTexels` is a starting capacity (a hint: growth still doubles). texelToBytes downcasts to f32
  // for the wire format. Flat storage (vs an [r,g,b,a] sub-array per texel) avoids per-texel allocation.
  const cap = Math.max(256, capacityTexels | 0);
  return {
    floats: new Storage(cap * 4),
    count: 0,
    capacity: cap, // texels (i.e. floats.length / 4)
  };
}

export function texelEnsure(buf, needTexels) {
  if (needTexels <= buf.capacity) return;
  let cap = buf.capacity;
  while (cap < needTexels) cap *= 2;
  const grown = new buf.floats.constructor(cap * 4);
  grown.set(buf.floats);
  buf.floats = grown;
  buf.capacity = cap;
}

export function texelAppend(buf, r, g, b, a) {
  const idx = buf.count;
  texelEnsure(buf, idx + 1);
  const o = idx * 4;
  buf.floats[o] = r;
  buf.floats[o + 1] = g;
  buf.floats[o + 2] = b;
  buf.floats[o + 3] = a;
  buf.count = idx + 1;
  return idx;
}

export function texelSet(buf, texelIdx, r, g, b, a) {
  texelEnsure(buf, texelIdx + 1);
  const o = texelIdx * 4;
  buf.floats[o] = r;
  buf.floats[o + 1] = g;
  buf.floats[o + 2] = b;
  buf.floats[o + 3] = a;
  if (texelIdx >= buf.count) buf.count = texelIdx + 1;
}

export function texelXYOf(_buf, idx) {
  return [idx % TEXTURE_WIDTH, Math.floor(idx / TEXTURE_WIDTH)];
}

// Convert an in-memory texel buffer to a raw byte view. Both curve
// and band buffers are float32; integer values in band texels are
// stored as plain (float)val and recovered via (uint)floatVal in the
// shader. A uint32-packed encoding is avoided because GLES3 does not
// reliably round-trip a uint reinterpret of a float through the sampler.
export function texelToBytes(buf) {
  // Downcast float64 storage → float32 wire format via one contiguous
  // Float32Array.set().
  const n = buf.count * 4;
  const out = new ArrayBuffer(n * 4);
  const view = new Float32Array(out);
  view.set(buf.floats.subarray(0, n));
  return new Uint8Array(out);
}

// TRUE arc-length of a segment in em-space — the cumulative `startDist`
// stamped into each seg's header for dash positioning. Lines/quads are
// closed-form; cubics/arcs use Gauss–Legendre 16. The stroke shaders and
// the hit test compute the within-segment length L(t) the same way, so
// dash boundaries stay continuous across segment seams and exact on curves.
export function segArcLen(s, frame = null) {
  return _segLenAt(s, 1, frame);
}

// Encode one segment record (header + data texels + join tangents). Returns
// the header texel index.
// startDist: cumulative arc-length from subpath start (0 if dashing disabled).
export const kJoinReachInf = 1e9;
export function encodeSeg(
  seg,
  curveBuf,
  freeStart,
  freeEnd,
  inTan,
  outTan,
  startDist = 0,
  startPrevReach = kJoinReachInf,
  endNextReach = kJoinReachInf,
  curv = null,
  skipInStroke = false,
  seamStartLen = 0,
  seamEndLen = 0,
  seamFreeStart = false,
  seamFreeEnd = false,
) {
  // Header .x packs three things: the type in bits 0-1, is_fill_only in bit 2,
  // and SUBPATH START in bit 3. The last is structure the geometry cannot carry:
  // a closed subpath ends where it began, so a second subpath starting at that
  // same point is indistinguishable from the first continuing. Decoders that
  // guessed from point-coincidence merged them — a fan of wedges around a shared
  // apex became ONE contour and the Loop-Blinn partition built zero interior, so
  // the shape rendered blank. Readers must MASK this field, never compare it.
  let segType = seg.type & 3;
  if (seg.is_fill_only || skipInStroke) segType += 4;
  if (seg.subStart) segType += 8;
  // THE CLOSED-DASHED-CONTOUR SEAM. The free-end fields are 0 (joined) or 1 (free); a joined end that is the SEAM of a closed
  // contour drawn with a dash pattern carries instead -L, L the contour's arc length (in stroke units, as startDist is): the first segment
  // of the contour in its start field, the last in its end field. Every reader that tests `> 0.5` for "free" still reads joined, so an
  // older reader draws what it always drew (and the row's flagsShape has FS_DASH_SEAM set, so it can tell); a seam-aware one reads the
  // length, which it needs to tell whether the dash on at the end continues into the one on at the start.
  // Under the spec's reading (compat 'spec', the default) the seam of a closed dashed contour is two dash ends: its two segments carry 2 in those fields -- a FREE end to
  // every `> 0.5` reader, and, unlike an open path's 1, still a closed contour to a reader that rebuilds paths from the plane (animation/currentCurvePose.js).
  const fsField = freeStart ? 1 : seamFreeStart ? 2 : seamStartLen > 0 ? -seamStartLen : 0;
  const feField = freeEnd ? 1 : seamFreeEnd ? 2 : seamEndLen > 0 ? -seamEndLen : 0;
  const hdr = texelAppend(curveBuf, segType, fsField, feField, startDist);
  if (seg.type === SEG_LINE) {
    texelAppend(curveBuf, seg.p1[0], seg.p1[1], seg.p2[0], seg.p2[1]);
  } else if (seg.type === SEG_QUAD) {
    texelAppend(curveBuf, seg.p1[0], seg.p1[1], seg.p2[0], seg.p2[1]);
    texelAppend(curveBuf, seg.p3[0], seg.p3[1], startPrevReach, endNextReach);
  } else if (seg.type === SEG_CUBIC) {
    texelAppend(curveBuf, seg.p1[0], seg.p1[1], seg.p2[0], seg.p2[1]);
    texelAppend(curveBuf, seg.p3[0], seg.p3[1], seg.p4[0], seg.p4[1]);
  } else if (seg.type === SEG_ARC) {
    texelAppend(curveBuf, seg.cx, seg.cy, seg.rx, seg.ry);
    // w = the factor F.6.6 scaled the authored radii by (0: none). A morph's endpoint form divides it back out; the
    // fill and stroke kernels never read it. Negative (with 1 for no scale): a half turn authored with the large-arc flag. At a half
    // turn both flags name this arc, so the sweep cannot say which was written, and a morph needs it the moment the chord shortens.
    {
      const w = seg.radiusScale > 1 ? seg.radiusScale : 0;
      const halfTurn = Math.abs(Math.abs(seg.theta_end - seg.theta_start) - Math.PI) < 4e-6;
      texelAppend(
        curveBuf,
        seg.theta_start,
        seg.theta_end,
        seg.phi,
        halfTurn && seg.large_arc_flag ? -(w || 1) : w,
      );
    }
    // The arc's own endpoints: (start.x, start.y, end.x, end.y) in PATH order -- the path's vertices,
    // the very floats the segments beside the arc store for them (segment.js mkArc). Rebuilt from the center form
    // instead, a vertex would come back off its neighbor's value by the rounding of cos and sin, and a pixel row through
    // it would count the vertex twice or not at all. So an arc record is five texels: header, (cx, cy, rx, ry),
    // (th0, th1, phi, _), these endpoints, then the join texel (and the arcs-join curvature texel after it).
    // d2.w stays free: a morph's endpoint form writes its arc flags there.
    texelAppend(curveBuf, seg.p1[0], seg.p1[1], seg.p4[0], seg.p4[1]);
  }
  // Join texel: (inTan.x, inTan.y, outTan.x, outTan.y). Zero vectors = free.
  texelAppend(curveBuf, inTan[0], inTan[1], outTan[0], outTan[1]);

  if (curv) texelAppend(curveBuf, curv[0], curv[1], curv[2], curv[3]);
  return hdr;
}

/// The crossing-axis lanes of each segment (BAND_HDR_RAY_LANES), flattened (minX, minY, maxX, maxY) like the
/// encoder's segBbsF.
///
/// A line, quad or cubic takes its CONTROL HULL, never its tight box: every walker's crossing test is a
/// sign pattern of the ray-centered control coordinates (the line walker's end signs, calcRootCode2, the
/// cubic hull reject), so a ray through the hull but past the curve still reaches the solver -- a bulging
/// quad's code admits two roots there that cancel in the winding but not in the AA state (xwgt, slH) --
/// while a hull on one side of the ray, 0 counting as non-negative, contributes nothing in any walker. The
/// stored float32 values ARE the min and max of the curve texels: rounding is monotone, so rounding the
/// float64 minimum gives the minimum of the rounded coordinates.
///
/// An arc takes its tight extent padded by the membership pad and ARC_LANE_REL (see there): its walkers
/// count crossings from float32 samples, not from a hull. Math.min/max, so a NaN coordinate yields a NaN
/// lane, which no comparison rejects.
function controlHullLanes(segs, segTypes, segBbsF, arcPadX, arcPadY) {
  const N = segs.length,
    out = new Float64Array(N * 4);
  for (let i = 0; i < N; i++) {
    const s = segs[i],
      o = i * 4;
    if (segTypes[i] === SEG_ARC) {
      const rr = ARC_LANE_REL * (Math.abs(s.rx) + Math.abs(s.ry));
      out[o] = segBbsF[o] - arcPadX[i] - rr;
      out[o + 1] = segBbsF[o + 1] - arcPadY[i] - rr;
      out[o + 2] = segBbsF[o + 2] + arcPadX[i] + rr;
      out[o + 3] = segBbsF[o + 3] + arcPadY[i] + rr;
      continue;
    }
    const pts =
      segTypes[i] === SEG_LINE
        ? [s.p1, s.p2]
        : segTypes[i] === SEG_QUAD
          ? [s.p1, s.p2, s.p3]
          : [s.p1, s.p2, s.p3, s.p4];
    let x0 = pts[0][0],
      y0 = pts[0][1],
      x1 = x0,
      y1 = y0;
    for (let k = 1; k < pts.length; k++) {
      x0 = Math.min(x0, pts[k][0]);
      x1 = Math.max(x1, pts[k][0]);
      y0 = Math.min(y0, pts[k][1]);
      y1 = Math.max(y1, pts[k][1]);
    }
    out[o] = x0;
    out[o + 1] = y0;
    out[o + 2] = x1;
    out[o + 3] = y1;
  }
  return out;
}

function _ctrlSpan(s) {
  const pts =
    s.type === SEG_LINE
      ? [s.p1, s.p2]
      : s.type === SEG_QUAD
        ? [s.p1, s.p2, s.p3]
        : [s.p1, s.p2, s.p3, s.p4];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
}
const DEG_REL = 1e-9; // a derivative under this fraction of the segment's span has no direction
/// A vector no longer than the rounding of the segment's coordinates has no direction either (a closing
/// line whose ends differ only by rounding): 64 ulps of the largest coordinate.
function _roundingLen(s) {
  if (s.type === SEG_ARC)
    return (
      64 *
      Number.EPSILON *
      (Math.max(Math.abs(s.cx), Math.abs(s.cy)) + Math.max(Math.abs(s.rx), Math.abs(s.ry)))
    );
  let m = 0;
  for (const p of [s.p1, s.p2, s.p3, s.p4]) if (p) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  return 64 * Number.EPSILON * m;
}

export function segTangentAt(s, atStart) {
  const t = atStart ? 0 : 1;
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0];
    dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const mt = 1 - t;
    dx = 2 * mt * (s.p2[0] - s.p1[0]) + 2 * t * (s.p3[0] - s.p2[0]);
    dy = 2 * mt * (s.p2[1] - s.p1[1]) + 2 * t * (s.p3[1] - s.p2[1]);
    // SVG "s" / "t" continuation cubics often emit p2 == p1, making
    // the standard derivative zero at t=0. Fall back to the chord
    // direction so the miter geometry has a defined tangent.
    if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
      dx = s.p3[0] - s.p1[0];
      dy = s.p3[1] - s.p1[1];
    }
  } else if (s.type === SEG_CUBIC) {
    const mt = 1 - t;
    dx =
      3 * mt * mt * (s.p2[0] - s.p1[0]) +
      6 * mt * t * (s.p3[0] - s.p2[0]) +
      3 * t * t * (s.p4[0] - s.p3[0]);
    dy =
      3 * mt * mt * (s.p2[1] - s.p1[1]) +
      6 * mt * t * (s.p3[1] - s.p2[1]) +
      3 * t * t * (s.p4[1] - s.p3[1]);
    // SVG "s" continuation cubic at t=0 often has p2 == p1, making
    // the derivative zero. Fall back to the second-order term
    // 6*(p3-p2), then to the chord direction (p4-p1).
    if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
      if (atStart) {
        dx = s.p3[0] - s.p2[0];
        dy = s.p3[1] - s.p2[1];
        if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
          dx = s.p4[0] - s.p1[0];
          dy = s.p4[1] - s.p1[1];
        }
      } else {
        // At t=1, fall back to (p4-p3) (already in primary), then chord.
        dx = s.p3[0] - s.p2[0];
        dy = s.p3[1] - s.p2[1];
        if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
          dx = s.p4[0] - s.p1[0];
          dy = s.p4[1] - s.p1[1];
        }
      }
    }
  } else if (s.type === SEG_ARC && (s.rx === 0 || s.ry === 0)) {
    // A zero-radius arc is SVG's straight line between its ends (arcEndpointToCenter keeps it as a half-turn of a
    // degenerate ellipse, which turns round AT its ends: its velocity there is a rounding, and had no direction). Its
    // ends run along its chord, from its center form as the shader forms it (a caller's arc may carry no
    // p1 / p4: incrementalStroke's).
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const du = s.rx * (Math.cos(s.theta_end) - Math.cos(s.theta_start)),
      dv = s.ry * (Math.sin(s.theta_end) - Math.sin(s.theta_start));
    dx = cp * du - sp * dv;
    dy = sp * du + cp * dv;
  } else if (s.type === SEG_ARC) {
    const theta = atStart ? s.theta_start : s.theta_end;
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const ct = Math.cos(theta),
      st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp * s.rx * st - sp * s.ry * ct) * dth;
    dy = (-sp * s.rx * st + cp * s.ry * ct) * dth;
  } else {
    return [0, 0];
  }
  const mag = Math.hypot(dx, dy);
  if (!(mag > _roundingLen(s))) return [0, 0];
  return [dx / mag, dy / mag];
}

// Signed centerline curvature κ = cross(B', B'') / |B'|³ at a segment
// endpoint (κ>0 bends left of the tangent). Feeds the SVG2 `arcs` join, which
// extends each stroke edge as an arc of the edge's curvature; the shader
// derives the edge curvature κ_edge = κ / (1 − halfW·κ) at render time from
// this. Straight lines (and degenerate cusps) return 0 → the arcs join reduces
// to a miter. Uses the same derivative conventions as segTangentAt.
export function segEndpointCurvature(s, atStart) {
  let d1x, d1y, d2x, d2y;
  if (s.type === SEG_LINE) {
    return 0;
  } else if (s.type === SEG_QUAD) {
    if (atStart) {
      d1x = 2 * (s.p2[0] - s.p1[0]);
      d1y = 2 * (s.p2[1] - s.p1[1]);
    } else {
      d1x = 2 * (s.p3[0] - s.p2[0]);
      d1y = 2 * (s.p3[1] - s.p2[1]);
    }
    d2x = 2 * (s.p1[0] - 2 * s.p2[0] + s.p3[0]);
    d2y = 2 * (s.p1[1] - 2 * s.p2[1] + s.p3[1]);
  } else if (s.type === SEG_CUBIC) {
    if (atStart) {
      d1x = 3 * (s.p2[0] - s.p1[0]);
      d1y = 3 * (s.p2[1] - s.p1[1]);
      d2x = 6 * (s.p1[0] - 2 * s.p2[0] + s.p3[0]);
      d2y = 6 * (s.p1[1] - 2 * s.p2[1] + s.p3[1]);
    } else {
      d1x = 3 * (s.p4[0] - s.p3[0]);
      d1y = 3 * (s.p4[1] - s.p3[1]);
      d2x = 6 * (s.p2[0] - 2 * s.p3[0] + s.p4[0]);
      d2y = 6 * (s.p2[1] - 2 * s.p3[1] + s.p4[1]);
    }
  } else if (s.type === SEG_ARC) {
    const theta = atStart ? s.theta_start : s.theta_end;
    const st = Math.sin(theta),
      ct = Math.cos(theta);
    const denom = Math.pow(s.rx * s.rx * st * st + s.ry * s.ry * ct * ct, 1.5);
    if (!(denom > 0)) return 0;
    const dth = s.theta_end - s.theta_start;
    return (Math.sign(dth) * (s.rx * s.ry)) / denom;
  } else {
    return 0;
  }
  const d1mag = Math.hypot(d1x, d1y);
  if (!(d1mag > DEG_REL * _ctrlSpan(s))) return 0; // cusp / degenerate → treat as straight
  return (d1x * d2y - d1y * d2x) / (d1mag * d1mag * d1mag);
}

// Non-allocating overload of segTangentAt: writes (tx, ty) at
// out[off], out[off+1]. Hot in buildTexturesShape, where the per-seg
// 2-element-array result of segTangentAt would otherwise pile up.
export function segTangentAtInto(s, atStart, out, off) {
  const t = atStart ? 0 : 1;
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0];
    dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const mt = 1 - t;
    dx = 2 * mt * (s.p2[0] - s.p1[0]) + 2 * t * (s.p3[0] - s.p2[0]);
    dy = 2 * mt * (s.p2[1] - s.p1[1]) + 2 * t * (s.p3[1] - s.p2[1]);
    if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
      dx = s.p3[0] - s.p1[0];
      dy = s.p3[1] - s.p1[1];
    }
  } else if (s.type === SEG_CUBIC) {
    const mt = 1 - t;
    dx =
      3 * mt * mt * (s.p2[0] - s.p1[0]) +
      6 * mt * t * (s.p3[0] - s.p2[0]) +
      3 * t * t * (s.p4[0] - s.p3[0]);
    dy =
      3 * mt * mt * (s.p2[1] - s.p1[1]) +
      6 * mt * t * (s.p3[1] - s.p2[1]) +
      3 * t * t * (s.p4[1] - s.p3[1]);
    if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
      dx = s.p3[0] - s.p2[0];
      dy = s.p3[1] - s.p2[1];
      if (!(Math.hypot(dx, dy) > DEG_REL * _ctrlSpan(s))) {
        dx = s.p4[0] - s.p1[0];
        dy = s.p4[1] - s.p1[1];
      }
    }
  } else if (s.type === SEG_ARC && (s.rx === 0 || s.ry === 0)) {
    // A zero-radius arc is SVG's straight line between its ends (arcEndpointToCenter keeps it as a half-turn of a
    // degenerate ellipse, which turns round AT its ends: its velocity there is a rounding, and had no direction). Its
    // ends run along its chord, from its center form as the shader forms it (a caller's arc may carry no
    // p1 / p4: incrementalStroke's).
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const du = s.rx * (Math.cos(s.theta_end) - Math.cos(s.theta_start)),
      dv = s.ry * (Math.sin(s.theta_end) - Math.sin(s.theta_start));
    dx = cp * du - sp * dv;
    dy = sp * du + cp * dv;
  } else if (s.type === SEG_ARC) {
    const theta = atStart ? s.theta_start : s.theta_end;
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const ct = Math.cos(theta),
      st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp * s.rx * st - sp * s.ry * ct) * dth;
    dy = (-sp * s.rx * st + cp * s.ry * ct) * dth;
  } else {
    out[off] = 0;
    out[off + 1] = 0;
    return;
  }
  const mag = Math.hypot(dx, dy);
  if (!(mag > _roundingLen(s))) {
    out[off] = 0;
    out[off + 1] = 0;
    return;
  }
  out[off] = dx / mag;
  out[off + 1] = dy / mag;
}

// Arc-length parameterization for <textPath>.
//
//   • Lines: closed form.
//   • Quads: speed integrand is √(at²+bt+c); closed-form antiderivative
//     (Eberly / Wolfram). Direct evaluation.
//   • Cubics: speed integrand is √(quartic); no elementary integral.
//     Gauss–Legendre 16-point quadrature (exact for polynomials up to
//     degree 31; the sqrt of a degree-4 polynomial is well-approximated
//     to machine precision by 16 GL points over [0,1]).
//   • Arcs: speed integrand is √(rx²sin²θ+ry²cos²θ)·|dθ/dt|.
//     Circular arcs reduce to closed form; ellipses use the same GL16.
//
// Inversion (s → t) uses clamped Newton (the Yuksel cubic-solve
// pattern): seeded from the current bracket, with
// derivative L'(t) = |p'(t)| computed analytically.
//
// LUT structure: per seg, precomputed total length (for fast
// "which seg contains s" search). t-on-that-seg via Newton from a
// proportional seed.
export function _segPointAt(s, t) {
  if (s.type === SEG_LINE) {
    return [s.p1[0] + (s.p2[0] - s.p1[0]) * t, s.p1[1] + (s.p2[1] - s.p1[1]) * t];
  }
  if (s.type === SEG_QUAD) {
    const u = 1 - t;
    return [
      u * u * s.p1[0] + 2 * u * t * s.p2[0] + t * t * s.p3[0],
      u * u * s.p1[1] + 2 * u * t * s.p2[1] + t * t * s.p3[1],
    ];
  }
  if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    return [
      u * u * u * s.p1[0] + 3 * u * u * t * s.p2[0] + 3 * u * t * t * s.p3[0] + t * t * t * s.p4[0],
      u * u * u * s.p1[1] + 3 * u * u * t * s.p2[1] + 3 * u * t * t * s.p3[1] + t * t * t * s.p4[1],
    ];
  }
  if (s.type === SEG_ARC) {
    const theta = s.theta_start + (s.theta_end - s.theta_start) * t;
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const ct = Math.cos(theta),
      st = Math.sin(theta);
    return [s.cx + cp * s.rx * ct - sp * s.ry * st, s.cy + sp * s.rx * ct + cp * s.ry * st];
  }
  return [0, 0];
}

export function _segTangentAtT(s, t) {
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0];
    dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const u = 1 - t;
    dx = 2 * u * (s.p2[0] - s.p1[0]) + 2 * t * (s.p3[0] - s.p2[0]);
    dy = 2 * u * (s.p2[1] - s.p1[1]) + 2 * t * (s.p3[1] - s.p2[1]);
  } else if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    dx =
      3 * u * u * (s.p2[0] - s.p1[0]) +
      6 * u * t * (s.p3[0] - s.p2[0]) +
      3 * t * t * (s.p4[0] - s.p3[0]);
    dy =
      3 * u * u * (s.p2[1] - s.p1[1]) +
      6 * u * t * (s.p3[1] - s.p2[1]) +
      3 * t * t * (s.p4[1] - s.p3[1]);
  } else if (s.type === SEG_ARC) {
    const theta = s.theta_start + (s.theta_end - s.theta_start) * t;
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const ct = Math.cos(theta),
      st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp * s.rx * st - sp * s.ry * ct) * dth;
    dy = (-sp * s.rx * st + cp * s.ry * ct) * dth;
  } else {
    return [1, 0];
  }
  const mag = Math.hypot(dx, dy);
  if (!(mag > _roundingLen(s))) return [1, 0];
  return [dx / mag, dy / mag];
}

// 16-point Gauss–Legendre on [0,1]: nodes and weights. Exact for
// polynomials up to degree 31; rms speed-integrand error for a sqrt of
// a degree-4 polynomial is < 1e-12 in practice.
const _GL16_NODES = [
  0.005299532504175033, 0.027712488463383711, 0.067184398806084128, 0.12229779582249847,
  0.191061877798678115, 0.270991611171386573, 0.359198224610370696, 0.452493745081181231,
  0.547506254918818769, 0.640801775389629304, 0.729008388828613427, 0.808938122201321885,
  0.87770220417750153, 0.932815601193915872, 0.972287511536616289, 0.994700467495824967,
];
const _GL16_WEIGHTS = [
  0.013576229705877047, 0.031126761969323946, 0.047579255841246392, 0.062314485627766936,
  0.074797994408288365, 0.084578259697501269, 0.091301707522461794, 0.094725305227534248,
  0.094725305227534248, 0.091301707522461794, 0.084578259697501269, 0.074797994408288365,
  0.062314485627766936, 0.047579255841246392, 0.031126761969323946, 0.013576229705877047,
];

// A linear stroke frame maps derivatives without translating or rebuilding
// segments. This keeps changing-pose length evaluation free of segment copies.
function metricLength(x, y, frame) {
  return frame
    ? Math.hypot(frame[0] * x + frame[2] * y, frame[1] * x + frame[3] * y)
    : Math.hypot(x, y);
}

// |p'(t)| for any seg type — exact analytic derivative magnitude.
export function _segSpeed(s, t, frame = null) {
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0];
    dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const u = 1 - t;
    dx = 2 * u * (s.p2[0] - s.p1[0]) + 2 * t * (s.p3[0] - s.p2[0]);
    dy = 2 * u * (s.p2[1] - s.p1[1]) + 2 * t * (s.p3[1] - s.p2[1]);
  } else if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    dx =
      3 * u * u * (s.p2[0] - s.p1[0]) +
      6 * u * t * (s.p3[0] - s.p2[0]) +
      3 * t * t * (s.p4[0] - s.p3[0]);
    dy =
      3 * u * u * (s.p2[1] - s.p1[1]) +
      6 * u * t * (s.p3[1] - s.p2[1]) +
      3 * t * t * (s.p4[1] - s.p3[1]);
  } else if (s.type === SEG_ARC) {
    const theta = s.theta_start + (s.theta_end - s.theta_start) * t;
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi);
    const ct = Math.cos(theta),
      st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp * s.rx * st - sp * s.ry * ct) * dth;
    dy = (-sp * s.rx * st + cp * s.ry * ct) * dth;
  } else {
    return 0;
  }
  return metricLength(dx, dy, frame);
}

// Closed-form line and quad arc-length from 0 to t.
export function _lineLenAt(s, t, frame = null) {
  return metricLength(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1], frame) * t;
}
// Quadratic Bézier arc-length: p'(t) = 2((1-t)(P1-P0) + t(P2-P1)).
// |p'(t)|² = a t² + b t + c, then ∫√(at²+bt+c) dt has closed form.
export function _quadLenAt(s, t, frame = null) {
  let ax = s.p1[0] - 2 * s.p2[0] + s.p3[0];
  let ay = s.p1[1] - 2 * s.p2[1] + s.p3[1];
  let bx = s.p2[0] - s.p1[0];
  let by = s.p2[1] - s.p1[1];
  if (frame) {
    const x = ax,
      y = ay,
      u = bx,
      v = by;
    ax = frame[0] * x + frame[2] * y;
    ay = frame[1] * x + frame[3] * y;
    bx = frame[0] * u + frame[2] * v;
    by = frame[1] * u + frame[3] * v;
  }
  // p'(t)/2 = (a t + b)  ⇒  |p'(t)|² = 4(A t² + B t + C)
  const A = ax * ax + ay * ay;
  const B = 2 * (ax * bx + ay * by);
  const C = bx * bx + by * by;
  // Degenerate: nearly a straight line (A ≈ 0). Fall back to chord.
  // Both cut-offs relative to the terms they guard, as the hit test's copy (hitTest/curveGeom.js) is: the
  // Relative comparisons keep the chord/log decisions independent of scale.
  if (A <= 1e-12 * C) {
    return metricLength(s.p3[0] - s.p1[0], s.p3[1] - s.p1[1], frame) * t;
  }
  // ∫√(At²+Bt+C) dt at t. Standard antiderivative:
  //   F(t) = ((2At+B) * sqrt(At²+Bt+C)) / (4A)
  //        + ((4AC - B²) / (8A^{3/2})) * ln(2√A·√(At²+Bt+C) + 2At + B)
  // Multiplied by 2 because |p'(t)| = 2√(A t²+B t+C).
  function F(tt) {
    const u = A * tt * tt + B * tt + C;
    if (u < 0) return 0; // numerical safety
    const sqrtU = Math.sqrt(u);
    const sqrtA = Math.sqrt(A);
    const term1 = ((2 * A * tt + B) * sqrtU) / (4 * A);
    const disc = 4 * A * C - B * B;
    const arg = 2 * sqrtA * sqrtU + 2 * A * tt + B;
    const term2 =
      arg > 1e-12 * (2 * sqrtA * sqrtU + Math.abs(2 * A * tt + B))
        ? (disc / (8 * Math.pow(A, 1.5))) * Math.log(arg)
        : 0;
    return 2 * (term1 + term2);
  }
  return F(t) - F(0);
}

// Gauss–Legendre 16-point arc-length integration on [0, t].
export function _glLenAt(s, t, frame = null) {
  // Substitute u = t * x, du = t dx, integrate ∫₀^t |p'(u)| du
  //   = t · ∫₀¹ |p'(t·x)| dx
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    sum += _GL16_WEIGHTS[i] * _segSpeed(s, t * _GL16_NODES[i], frame);
  }
  return t * sum;
}

export function _segLenAt(s, t, frame = null) {
  if (t <= 0) return 0;
  if (s.type === SEG_LINE) return _lineLenAt(s, t, frame);
  if (s.type === SEG_QUAD) return _quadLenAt(s, t, frame);
  // Cubics + arcs: Gauss–Legendre 16.
  return _glLenAt(s, t, frame);
}
const _segLenTotal = (s) => _segLenAt(s, 1);

export function _segLenInvert(s, sTarget, total) {
  if (sTarget <= 0) return 0;
  if (sTarget >= total) return 1;
  if (s.type === SEG_LINE) return sTarget / total;
  // Proportional seed.
  let t = sTarget / total;
  for (let iter = 0; iter < 8; iter++) {
    const L = _segLenAt(s, t);
    const dL = _segSpeed(s, t);
    if (!(dL > 0)) break;
    const dt = (sTarget - L) / dL;
    let tNext = t + dt;
    if (tNext < 0) tNext = 0;
    else if (tNext > 1) tNext = 1;
    if (Math.abs(tNext - t) < 1e-9) {
      t = tNext;
      break;
    }
    t = tNext;
  }
  return t;
}

export function buildPathArcLengthLut(segs) {
  // Per-seg total length + running cumulative. Sampling at query
  // time is O(log nSegs) bracket search + O(8) Newton iters.
  const lens = new Float64Array(segs.length);
  const cum = new Float64Array(segs.length + 1);
  let total = 0;
  for (let i = 0; i < segs.length; i++) {
    lens[i] = _segLenTotal(segs[i]);
    cum[i] = total;
    total += lens[i];
  }
  cum[segs.length] = total;
  return { segs, lens, cum, total };
}

export function samplePathAt(lut, s) {
  // Clamp to endpoints.
  if (s <= 0) {
    const seg = lut.segs[0];
    const p = _segPointAt(seg, 0);
    const tan = _segTangentAtT(seg, 0);
    return { x: p[0], y: p[1], tx: tan[0], ty: tan[1] };
  }
  if (s >= lut.total) {
    const seg = lut.segs[lut.segs.length - 1];
    const p = _segPointAt(seg, 1);
    const tan = _segTangentAtT(seg, 1);
    return { x: p[0], y: p[1], tx: tan[0], ty: tan[1] };
  }
  // Binary-search the seg that contains s. cum[i] is the cumulative
  // length up to (but not including) seg i.
  let lo = 0,
    hi = lut.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lut.cum[mid + 1] <= s) lo = mid + 1;
    else hi = mid;
  }
  const segIdx = lo;
  const seg = lut.segs[segIdx];
  const localS = s - lut.cum[segIdx];
  const t = _segLenInvert(seg, localS, lut.lens[segIdx]);
  const p = _segPointAt(seg, t);
  const tan = _segTangentAtT(seg, t);
  return { x: p[0], y: p[1], tx: tan[0], ty: tan[1] };
}

// Filter degenerate segments, wire free-endpoint flags + neighbor tangents,
// write curve texels + single-band header entries. Returns meta fragment with
// glyphLoc / band maxima.
// `fillOnly` — when true, the produced curve buffer is read only by the fill
// winding ray-cast (never the stroker), so the per-segment STROKE metadata —
// endpoint pairing (free ends / neighbors), join tangents, arc-length and
// dash start-distances — is unused and skipped. Texel COUNT and layout are
// unchanged (those fields are just left zero), so morph's deterministic
// per-shape size is preserved. Skips the O(N²) pairing + three O(N) passes,
// the dominant cost on fill-heavy assets. Callers building a fill-only curve
// range (the importer's fill emit, emitShape, updateBundleGeometry for an
// unstroked shape) pass true.
// GWN tier-3 grid base: cells ≈ base² per shape (square cells via sqrt(aspect)).
// 24 is the render/memory KNEE for tree-hard fills: against 16 it captures
// nearly the whole interior-skip win (−4% @1024, −8% @2048; probes/_gwnSize) at
// +16% band memory, whereas 32/48 buy ~1% more for +38%/+102%. Affordable
// because the tier-3 build defers off the import path (async, see buildTexturesShape
// deferTier3Out) — the win is modest because tree-hard content is stroke-covered,
// so the stroke's fixed render cost dilutes the fill-skip.
const _GWN_GRID_BASE = 24;
// GWN tree TIER-3 occupancy cells. Pure (no GL, no buffers) so it runs both in
// the synchronous bake and, for the async tree path, in a post-load idle pass
// off the render hot-path (see bundle.js _fillTreeGrids). Returns a Float64Array
// of gridW*gridH*2 = (wSum, margin) per cell. This is ~85% of the whole tree
// build, so deferring it removes most of the tree-bake stall.
export function computeGwnOccupancyCells(polySegs, bbX0, bbY0, bbW, bbH, gridW, gridH) {
  const NS = polySegs.length / 5;
  const cw = bbW / gridW,
    ch = bbH / gridH;
  const halfDiag = Math.hypot(cw, ch) / 2;
  const cells = new Float64Array(gridW * gridH * 2);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = bbX0 + (gx + 0.5) * cw,
        cy = bbY0 + (gy + 0.5) * ch;
      let wSum = 0,
        dMin = Infinity;
      for (let s = 0; s < NS; s++) {
        const s5 = s * 5;
        const ax = polySegs[s5],
          ay = polySegs[s5 + 1];
        const bx = polySegs[s5 + 2],
          by = polySegs[s5 + 3],
          pad = polySegs[s5 + 4];
        const dx = bx - ax,
          dy = by - ay;
        // Nearest-approach distance for the certified margin. distSq + deferred
        // sqrt: a chord lowers dMin only if segDist < dMin + pad, i.e.
        // distSq < (dMin+pad)² — so the sqrt runs only on an actual min-update.
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? (dx * (cx - ax) + dy * (cy - ay)) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = cx - (ax + t * dx),
          qy = cy - (ay + t * dy);
        const distSq = qx * qx + qy * qy;
        const lim = dMin + pad;
        if (lim > 0 && distSq < lim * lim) {
          const d = Math.sqrt(distSq) - pad;
          if (d < dMin) dMin = d;
        }
        if (ay < cy !== by < cy) {
          const xi = ax + ((cy - ay) / dy) * dx;
          if (xi > cx) wSum += dy > 0 ? 1 : -1;
        }
      }
      const margin = dMin - halfDiag * 1.001;
      cells[(gy * gridW + gx) * 2] = wSum;
      cells[(gy * gridW + gx) * 2 + 1] = margin > 0 ? margin : 0;
    }
  }
  return cells;
}

// gwnTree: pack a hierarchical run tree for the closed-form winding kernel. Off by
// default — it is a second spatial structure and only renderFillGWN reads it.
// deferTier3Out: when an array is passed, the TIER-3 grid is RESERVED zeroed and
// its build inputs pushed here instead of built inline — an idle pass fills it
// after first draw. Zeroed cells have margin 0, so the shader's `margin > cellR`
// gate never fires → the fragment falls through to tier-2 (correct, unaccelerated)
// until the real cells land. Null → synchronous build (the default).
// rayLanes: write the crossing-axis lanes (BAND_HDR_RAY_LANES). only for a structure no stroke walker
// reads -- the stroke walker reads z as its far bound -- so a caller passes it for fill-only rows.
// dashSeam: false, 'free' or 'merge'. 'free': this stroke row is DASHED and takes the spec's reading (SVG 2 13.5.7 lays the dashes along each subpath from its start to its
// end, each with its own caps and joins only between the segments inside a dash): the two segments that meet at the seam of each closed contour are written as
// FREE ends (header fields 2, 2: a free end to every `> 0.5` reader, still a closed contour to a path rebuild), like an open path's ends, so a dash that is on there is capped and the vertex is joined by nothing. 'merge' (importSvg compat: 'chrome'):
// Each closed contour of it (a ring of joined segments with no free end) then carries its arc length in
// the free-end field of the two segments that meet at its seam (encodeSeg), so the dash that is on at the contour's end can continue into the one on
// at its start. The return value's `dashSeam` says whether any contour did; the row's flagsShape then gets FS_DASH_SEAM. A row without it is byte for
// byte the same as a dash-free encoding.
// strokeFrame: a stroke row drawn in STROKE SPACE (bundle/strokeFrame.js) passes its frame N (column-major).
// The segments are still written in document space, but every quantity the walker reads in STROKE terms -- each
// segment's startDist (dashing), the arcs join's curvatures, and the miter ratio the meta's limit is clamped to --
// is taken from the segments mapped through N, because that is the space the walker measures them in. The join
// tangents stay in document space with the geometry; the walker maps them.
export function buildTexturesShape(
  segs,
  bandsX,
  bandsY,
  bbox,
  curveBuf,
  bandBuf,
  strokePadEm = 0,
  fillOnly = false,
  emitCurvature = false,
  pairBands = false,
  gwnTree = false,
  deferTier3Out = null,
  evenOdd = false,
  aacLevels = false,
  rayLanes = false,
  strokeFrame = null,
  zeroLen = null,
  dashSeam = /** @type {boolean|'free'|'merge'} */ (false),
) {
  // The bundle ORIGIN the segments are stored relative to (the build context sets it on its curve buffer): a zero-length test is made
  // at the ulps of the DOCUMENT coordinates (segment.js isZeroLengthSeg). Joints (pointsMeet) are judged at the STORED magnitude: a
  // tolerance of float32 ulps of document coordinates 1e4 out is 5e-3, and 1e-3 art would read every joint as met.
  const docOrigin = curveBuf.docOrigin || null;
  // Near-zero-bbox segments are NOT dropped here. Dropping them would
  // make per-shape curveFloats.length depend on whether any author-emitted
  // or synthetic segment happened to land near the degenerate
  // threshold (1e-7 em on either axis) — different across visually-
  // similar poses, so shape-morph's topology-match path would fail
  // unpredictably. Cost of keeping them: a few extra texels per shape
  // (each near-zero-bbox seg contributes ~0 to the fill walker's
  // winding crossings anyway). Benefit: deterministic per-shape size,
  // which createShapeMorph requires (deterministic importer output).
  //
  // STROKE only: zero-length segments. A segment whose points all coincide has no direction, so it cannot be paired
  // or capped like its neighbors (SVG 2: it contributes nothing to the outline of a subpath that has any length).
  //   * inside a subpath that has length it is SKIPPED: left out of the pairing so its neighbors join each other, and
  //     written with the fill-only bit so the stroke walk passes over it. The record stays (a morph matches records
  //     positionally, so the count must not depend on whether a pose has a repeated point).
  //   * a subpath made only of such segments (`M x y L x y`, `l0 0 z`, `M x y Z`, `A0 0 ..` to the same point) is a ZERO-LENGTH
  //     SUBPATH (SVG 1.1 11.4): its first record stands for it, the rest are skipped, and `zeroLen` = {cap, halfW, ux, uy}
  //     says what it paints: nothing for a butt cap, a disc for a round one (the shader's cap of a zero-length record),
  //     the square for a square one -- the record becomes a line of length ~2^-11 half widths along the path's direction there
  //     (zeroLen.tangent; SVG 2) or the user-space x axis (ux, uy; compat 'chrome'), whose square end caps are that square.
  // Without `zeroLen` (a rebuild from stored records) the representative is left as it is.
  const skipSeg = !fillOnly ? new Uint8Array(segs.length) : null;
  let degIdx = null;
  if (!fillOnly) {
    for (let i = 0; i < segs.length; i++)
      if (isZeroLengthSeg(segs[i], docOrigin)) {
        (degIdx || (degIdx = [])).push(i);
      }
  }
  if (degIdx) {
    // sub ids by `subStart`, as the pairing below reads them
    const subId = new Int32Array(segs.length);
    for (let i = 0, id = 0; i < segs.length; i++) {
      if (segs[i].subStart === true && i > 0) id++;
      subId[i] = id;
    }
    const hasLength = new Map();
    for (let i = 0; i < segs.length; i++)
      if (!hasLength.has(subId[i])) hasLength.set(subId[i], false);
    for (let i = 0; i < segs.length; i++)
      if (!isZeroLengthSeg(segs[i], docOrigin)) hasLength.set(subId[i], true);
    const repSeen = new Set();
    const origSegs = segs;
    // The direction a zero-length subpath's square cap is aligned to (SVG 2 path implementation notes, zero-length segments): the end
    // direction of the closest preceding segment that has length (any subpath of the path), else the start direction of the closest
    // following one, else the user-space x axis (the whole path has no length). Chrome / Skia: always the user-space x axis (!zeroLen.tangent).
    const squareDir = (i) => {
      if (zeroLen.tangent) {
        for (let j = i - 1; j >= 0; j--) {
          const o = origSegs[j];
          if (o.is_fill_only || isZeroLengthSeg(o, docOrigin)) continue;
          const t = segTangentAt(o, false);
          if (t[0] || t[1]) return t;
        }
        for (let j = i + 1; j < origSegs.length; j++) {
          const o = origSegs[j];
          if (o.is_fill_only || isZeroLengthSeg(o, docOrigin)) continue;
          const t = segTangentAt(o, true);
          if (t[0] || t[1]) return t;
        }
      }
      return [zeroLen.ux, zeroLen.uy];
    };
    let copied = false;
    for (const i of degIdx) {
      const id = subId[i];
      if (hasLength.get(id) !== false) {
        skipSeg[i] = 1;
        continue;
      }
      if (zeroLen && zeroLen.cap === 0) {
        skipSeg[i] = 1;
        continue;
      }
      if (repSeen.has(id)) {
        skipSeg[i] = 1;
        continue;
      }
      repSeen.add(id);
      skipSeg[i] = 2; // the representative: kept, drawn, paired with nothing
      if (zeroLen && zeroLen.cap === 2) {
        const a = segStart(segs[i]);
        const mag = Math.max(Math.abs(a[0]), Math.abs(a[1]));
        // half the length on each side of the point: at least 2^-11 half widths, and at least 8 float32 steps of the point
        const d = Math.max(zeroLen.halfW * 2 ** -11, mag * 2 ** -20);
        const [ux, uy] = squareDir(i);
        const q = mkLine(
          [a[0] - d * 0.5 * ux, a[1] - d * 0.5 * uy],
          [a[0] + d * 0.5 * ux, a[1] + d * 0.5 * uy],
        );
        if (segs[i].subStart) q.subStart = true;
        if (segs[i].openEnd) q.openEnd = true;
        if (!copied) {
          segs = segs.slice();
          copied = true;
        }
        segs[i] = q;
      }
    }
  }
  const N = segs.length;

  // Flat parallel arrays for the pair-up + tangent + dash results. For a
  // fill-only buffer these stay zero (the fields they feed — header
  // free-ends/startDist, the join-tangent texel, quad reach — are stroke-only
  // and unread by the fill walk), and all the work below is skipped.
  const freeStart = new Uint8Array(N);
  const freeEnd = new Uint8Array(N);
  const prevOf = new Int32Array(N);
  const nextOf = new Int32Array(N);
  const startTanF = new Float64Array(N * 2);
  const endTanF = new Float64Array(N * 2);
  const segLens = new Float64Array(N);
  const startDists = new Float64Array(N);
  const seamFirstLen = dashSeam === 'merge' ? new Float64Array(N) : null; // a closed dashed contour's length, on its first and its last segment
  const seamLastLen = dashSeam === 'merge' ? new Float64Array(N) : null;
  let anySeam = false,
    anyFree = false;
  const seamFreeFirst = dashSeam === 'free' ? new Uint8Array(N) : null,
    seamFreeLast = dashSeam === 'free' ? new Uint8Array(N) : null;
  // The segments in stroke space (see strokeFrame above): one per input, mapped by N with no translation (only
  // lengths, directions and curvatures are read from them). The input itself when there is no frame.
  let sSegs = segs;
  if (strokeFrame && !fillOnly) {
    const Nm = [strokeFrame[0], strokeFrame[1], strokeFrame[2], strokeFrame[3], 0, 0];
    sSegs = new Array(N);
    for (let i = 0; i < N; i++) {
      const out = [];
      transformSegInto(segs[i], Nm, out);
      sSegs[i] = out.length === 1 ? out[0] : segs[i]; // N is never singular, so an arc stays one arc
    }
  }
  // A document-space direction as the stroke-space UNIT direction it maps to (the zero vector stays zero).
  const toStroke = (x, y) => {
    if (sSegs === segs) return [x, y];
    const u = strokeFrame[0] * x + strokeFrame[2] * y,
      v = strokeFrame[1] * x + strokeFrame[3] * y;
    const l = Math.hypot(u, v);
    return l > 0 ? [u / l, v / l] : [0, 0];
  };

  if (fillOnly) {
    prevOf.fill(-1); // no neighbors → encodeSeg writes zero joins
    nextOf.fill(-1);
  } else {
    // Flatten endpoints (4 floats/seg: sx, sy, ex, ey) for the pairing loop.
    const endptF = new Float64Array(N * 4);
    const magOf = segs.map((s) => jointMag(s));
    // Authored subpaths: a join exists only between segments of one subpath. Two subpaths that merely TOUCH (an `M` at the previous
    // end) get butt caps in the SVG model; pairing them by coincidence would put a round join of radius w/2 at the touch, and only
    // while the ends were within pointsMeet, so a relative 4e-7 perturbation would turn it off. The parser marks each authored
    // subpath's first segment (`subStart`).
    const subOf = new Int32Array(N);
    for (let i = 0, id = 0; i < N; i++) {
      if (segs[i].subStart === true && i > 0) id++;
      subOf[i] = id;
    }
    // Zero-length segments are skipped (above): the first and last segment that HAS length stand for the subpath's ends,
    // and a trailing zero-length segment's `openEnd` belongs to the last one that has length.
    const effFirst = new Uint8Array(N),
      effOpen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      effFirst[i] = i === 0 || segs[i].subStart === true ? 1 : 0;
      effOpen[i] = segs[i].openEnd === true ? 1 : 0;
    }
    if (degIdx) {
      const firstSeen = new Set(),
        lastLive = new Map();
      for (let i = 0; i < N; i++) {
        if (skipSeg[i] === 0) {
          if (!firstSeen.has(subOf[i])) {
            firstSeen.add(subOf[i]);
            effFirst[i] = 1;
          }
          lastLive.set(subOf[i], i);
        } else if (segs[i].openEnd === true && lastLive.has(subOf[i]))
          effOpen[lastLive.get(subOf[i])] = 1;
      }
    }
    const isSubFirst = (k) => effFirst[k] === 1;
    for (let i = 0; i < N; i++) {
      const sp = segStart(segs[i]);
      const ep = segEnd(segs[i]);
      endptF[i * 4] = sp[0];
      endptF[i * 4 + 1] = sp[1];
      endptF[i * 4 + 2] = ep[0];
      endptF[i * 4 + 3] = ep[1];
    }
    // Pairing is O(N²) per shape (semantics: last matching j wins) since the
    // hash-map shortcut isn't exact across the EP tolerance band. N is
    // per-shape and small in practice, so the quadratic is fine.
    for (let i = 0; i < N; i++) {
      const sx = endptF[i * 4],
        sy = endptF[i * 4 + 1];
      const ex = endptF[i * 4 + 2],
        ey = endptF[i * 4 + 3];
      let startFree = 1,
        endFree = 1;
      let prev = -1,
        next = -1;
      // (a skipped record, and the record that stands for a zero-length subpath, pair with nothing: free at both ends)
      if (skipSeg[i]) {
        freeStart[i] = 1;
        freeEnd[i] = 1;
        prevOf[i] = -1;
        nextOf[i] = -1;
        continue;
      }
      for (let j = 0; j < N; j++) {
        if (j === i || subOf[j] !== subOf[i] || skipSeg[j]) continue;
        const jex = endptF[j * 4 + 2],
          jey = endptF[j * 4 + 3];
        // the end of an OPEN authored subpath does not join that subpath's start (path.js openEnd)
        if (
          pointsMeet([jex, jey], [sx, sy], magOf[j], magOf[i]) &&
          !(effOpen[j] === 1 && isSubFirst(i))
        ) {
          startFree = 0;
          prev = j;
        }
        const jsx = endptF[j * 4],
          jsy = endptF[j * 4 + 1];
        if (
          pointsMeet([jsx, jsy], [ex, ey], magOf[j], magOf[i]) &&
          !(effOpen[i] === 1 && isSubFirst(j))
        ) {
          endFree = 0;
          next = j;
        }
      }
      // A single segment whose own start meets its own end is a closed loop
      // (a full-circle/ellipse arc, or a self-closing curve): it joins itself at
      // the seam. Mark it non-free + self-neighbor so the stroke takes the
      // (tangent-continuous) join branch there instead of a cap — otherwise a
      // circle/ellipse would butt-cap-notch at the seam.
      if (
        startFree &&
        endFree &&
        effOpen[i] !== 1 &&
        pointsMeet([sx, sy], [ex, ey], magOf[i], magOf[i])
      ) {
        startFree = 0;
        endFree = 0;
        prev = i;
        next = i;
      }
      freeStart[i] = startFree;
      freeEnd[i] = endFree;
      prevOf[i] = prev;
      nextOf[i] = next;
    }
    // Tangents (each seg's start at [2i], end at [2i+1]).
    for (let i = 0; i < N; i++) {
      segTangentAtInto(segs[i], true, startTanF, i * 2);
      segTangentAtInto(segs[i], false, endTanF, i * 2);
    }
    // Per-segment cumulative arc-length from the start of its subpath (for
    // stroke-dasharray): path distance at param t on seg i is
    // startDist[i] + t*segLen[i]. Walk forward from each free-start segment
    // following next-neighbor to honor traversal order regardless of index.
    for (let i = 0; i < N; i++) segLens[i] = segArcLen(sSegs[i]);
    const visited = new Uint8Array(N);
    for (let seed = 0; seed < N; seed++) {
      if (visited[seed] || !freeStart[seed]) continue;
      let cur = seed,
        accum = 0;
      while (cur >= 0 && !visited[cur]) {
        visited[cur] = 1;
        startDists[cur] = accum;
        accum += segLens[cur];
        cur = nextOf[cur];
      }
    }
    for (let seed = 0; seed < N; seed++) {
      if (visited[seed]) continue;
      let cur = seed,
        accum = 0,
        last = -1;
      while (cur >= 0 && !visited[cur]) {
        visited[cur] = 1;
        startDists[cur] = accum;
        accum += segLens[cur];
        last = cur;
        cur = nextOf[cur];
      }
      // The walk came back to its seed: a closed contour, and `accum` is its length.
      if (dashSeam && cur === seed && last >= 0 && accum > 0) {
        if (dashSeam === 'merge') {
          seamFirstLen[seed] = accum;
          seamLastLen[last] = accum;
          anySeam = true;
        } else {
          seamFreeFirst[seed] = 1;
          seamFreeLast[last] = 1;
          anyFree = true;
        } // 'free': the seam is two dash ends
      }
    }
  }

  const glyphLocIdx = bandBuf.count;
  const glyphLocX = glyphLocIdx % TEXTURE_WIDTH;
  const glyphLocY = Math.floor(glyphLocIdx / TEXTURE_WIDTH);

  const segHdrIdx = [];
  // Curve-tight bbox per seg, flattened as Float64Array[4N] — entry
  // (minX, minY, maxX, maxY) at [i*4 .. i*4+3]. See the segBboxInto call
  // below for why tight rather than the control-polygon hull.
  const segBbsF = new Float64Array(N * 4);
  // Per-seg type cached once. The band machinery below (sort comparator,
  // per-band counts, per-band-list writer) reads segs[i].type many times
  // each — once per comparison in the O(M log M) sort and once per
  // band-list entry — across ~2·sqrt(32N) bands. Caching the property
  // chain into a flat Int32Array removes those repeated array-index +
  // object-property lookups from the inner loops.
  const segTypes = new Int32Array(N);
  // Which of LINE/QUAD/CUBIC/ARC this shape uses. The walker's sub-loops are
  // type-grouped, so a bundle that never uses a type can compile that kernel OUT —
  // and AAC's cost on small shapes is register pressure, not work.
  let typeMask = 0;
  // Reusable 2-element scratch tuples for encodeSeg's tangent params.
  // Allocated once per shape rather than once per seg.
  const inTBuf = [0, 0];
  const outTBuf = [0, 0];
  /// THE LARGEST MITER RATIO this SHAPE actually TURNS, 1/cos(phi/2) over its real joins.

  let maxMiterRatio = 1;
  for (let i = 0; i < N; i++) {
    const fs = freeStart[i] === 1;
    const fe = freeEnd[i] === 1;
    const pi = prevOf[i],
      ni = nextOf[i];
    if (pi >= 0) {
      inTBuf[0] = endTanF[pi * 2];
      inTBuf[1] = endTanF[pi * 2 + 1];
    } else {
      inTBuf[0] = 0;
      inTBuf[1] = 0;
    }
    if (ni >= 0) {
      outTBuf[0] = startTanF[ni * 2];
      outTBuf[1] = startTanF[ni * 2 + 1];
    } else {
      outTBuf[0] = 0;
      outTBuf[1] = 0;
    }
    if (ni >= 0) {
      // phi is the turn between this seg's outgoing tangent and the next's incoming one;
      // the miter ratio is 1/cos(phi/2), which is 1 when straight and diverges at a reversal.
      // in STROKE space: the turn the walker measures (a non-conformal frame changes angles)
      const [ax, ay] = toStroke(endTanF[i * 2], endTanF[i * 2 + 1]);
      const [bx, by] = toStroke(startTanF[ni * 2], startTanF[ni * 2 + 1]);
      const la = Math.hypot(ax, ay),
        lb = Math.hypot(bx, by);
      if (la > 0 && lb > 0) {
        const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
        const cosHalf = Math.sqrt(Math.max(0, (1 + dot) * 0.5));
        const ratio = cosHalf > 1e-6 ? 1 / cosHalf : Infinity;
        if (ratio > maxMiterRatio && Number.isFinite(ratio)) maxMiterRatio = ratio;
      }
    }
    const endNextReach = ni >= 0 && freeEnd[ni] === 1 ? segLens[ni] : kJoinReachInf;
    const startPrevReach = pi >= 0 && freeStart[pi] === 1 ? segLens[pi] : kJoinReachInf;
    segTypes[i] = segs[i].type;
    typeMask |= 1 << (segs[i].type & 3);
    // For stroke-linejoin:arcs, carry the signed centerline curvatures at the
    // join: this seg's own start/end, plus the neighbors' shared-vertex ends.
    let curv = null;
    if (emitCurvature) {
      curv = [
        segEndpointCurvature(sSegs[i], true),
        segEndpointCurvature(sSegs[i], false),
        pi >= 0 ? segEndpointCurvature(sSegs[pi], false) : 0,
        ni >= 0 ? segEndpointCurvature(sSegs[ni], true) : 0,
      ];
    }
    segHdrIdx.push(
      encodeSeg(
        segs[i],
        curveBuf,
        fs,
        fe,
        inTBuf,
        outTBuf,
        startDists[i],
        startPrevReach,
        endNextReach,
        curv,
        skipSeg !== null && skipSeg[i] === 1,
        seamFirstLen ? seamFirstLen[i] : 0,
        seamLastLen ? seamLastLen[i] : 0,
        seamFreeFirst ? seamFreeFirst[i] === 1 : false,
        seamFreeLast ? seamFreeLast[i] === 1 : false,
      ),
    );
    // CURVE-TIGHT bbox, not the control-polygon hull. This one array feeds all
    // three band-machinery consumers — the sort key, band membership, and the
    // `breakAxis` (.z) the shader breaks on — and they must agree, or the
    // early-out is unsound: sorting by one measure while breaking on a larger
    // one lets the walker break on a segment that a later, still-contributing
    // segment outranks (visible as pixel-aligned rectangular gaps).
    //
    // They agree here: the shader's `break` reads segRaw.z, which IS this
    // value. (The separate in-shader `continue` guards do test the control
    // points directly, but a control-poly max only ever OVER-estimates the
    // curve, so skipping on it stays conservative regardless.)
    //
    segBboxInto(segs[i], segBbsF, i * 4);
  }

  // Multi-band layout: bandsY horizontal bands (each holds segments
  // whose y-range overlaps the band's y-stripe, sorted by maxX
  // descending for early-out break) + bandsX vertical bands (segments
  // whose x-range overlaps the band's x-stripe, sorted by maxY
  // descending). A pixel's horizontal-ray walk only walks the H band
  // for its row → this drops the per-pixel iteration count
  // from O(N) to O(N/bandsY) on average.
  //
  // Layout in bandBuf, starting at glyphLocIdx:
  //    [0]                          H band 0 header (count, arrIdx)
  //    [1]                          H band 1 header
  //    ...
  //    [bandsY - 1]                 H band (bandsY-1) header
  //    [bandsY]                     V band 0 header
  //    ...
  //    [bandsY + bandsX - 1]        V band (bandsX-1) header
  //    then the segment-list arrays packed contiguously, each entry
  //    is one (hx, hy, 0, 0) texel.
  //
  const [bbX0, bbY0, bbX1, bbY1] = bbox;
  // An arc is binned with a relative pad on each axis. Every arc walker counts an arc's crossings from its endpoint
  // SIDES, the ends read as stored, and evaluates everything between from the center form, a rounding (1.2e-7
  // of |center| + |rx| + |ry| on the crossing axis) off the curve -- so the band must list the arc wherever that
  // evaluation can reach. The pad also keeps a vertex's row in the list: a tight bbox from the center form put a
  // ring's vertex at 125 at 124.99999999999997, the stripe starting at 125 dropped the arc arriving there, and the row
  // through the vertex read blank (the column, on the V walker). The pad is 2e-5 of the same sum -- twice the
  // arcOnRayTol window the walkers decided endpoints by -- far wider than that rounding needs. Listing an arc
  // in a band it cannot cross in costs a walk step and never a crossing (its ends do not straddle any row there), so
  // the pad stays as computed above and every band layout with it.
  const arcPadX = new Float64Array(N),
    arcPadY = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (segTypes[i] !== SEG_ARC) continue;
    const s = segs[i],
      r = Math.abs(s.rx) + Math.abs(s.ry);
    arcPadX[i] = 2e-5 * (Math.abs(s.cx) + r);
    arcPadY[i] = 2e-5 * (Math.abs(s.cy) + r);
  }
  // The crossing-axis lanes (BAND_HDR_RAY_LANES), per segment, when this structure carries them.
  const laneF = rayLanes ? controlHullLanes(segs, segTypes, segBbsF, arcPadX, arcPadY) : null;
  const laneBit = rayLanes ? BAND_HDR_RAY_LANES : 0;

  const bandExtW = bbX1 - bbX0,
    bandExtH = bbY1 - bbY0;
  const bbW = bandExtW > 0 ? bandExtW : bandExtH > 0 ? bandExtH : 1;
  const bbH = bandExtH > 0 ? bandExtH : bandExtW > 0 ? bandExtW : 1;
  // Every segment is binned with the stripe mapping's rounding. A walker takes its stripe as
  // (c - bb) / size * bands in float32 from the META box, while the boundaries below are formed in float64 from the box
  // handed here; the two can disagree by a few float32 ulps of the box's coordinates. A ray exactly ON a boundary -- a
  // row or column through a vertex, where the box divides evenly -- then went to a stripe whose list did not hold the
  // segment that counts the crossing there (the shared-endpoint rule gives it to one side only), and its winding came out
  // one short: each circle of noAaStrokeCover__grid_N_8_0, the column through its center, read 0 inside for 1, at every
  // scale. So every segment is listed in each stripe it comes within 64 float32 ulps of -- of the box's coordinates and
  // size, so relative and the same at any scale. Listed where no ray of the stripe crosses it, a segment costs a walk step
  // and never a crossing (it is the arc pad's argument above, for the rounding every type shares).
  const bandPadX = 64 * 2 ** -24 * Math.max(Math.abs(bbX0), Math.abs(bbX1), bbW);
  const bandPadY = 64 * 2 ** -24 * Math.max(Math.abs(bbY0), Math.abs(bbY1), bbH);
  // Per band: collect overlapping segments, then sort by (segType
  // ascending, breakAxis descending). Type-grouping lets the shader
  // walk one type at a time as 4 monomorphic sub-loops — eliminates
  // per-segment branch divergence across warp lanes. Within each type
  // group, descending breakAxis preserves the per-pixel early-out:
  // when a sub-loop hits a segment whose maxX/maxY can't reach the
  // pixel, all later same-type segments also can't, so break is safe
  // (within that sub-loop only).
  // The order is total (ties break on the index), so any correct sort gives the same list. Band lists are short, and a
  // call to the comparator per step dominated the build (COLR runs with placed outlines carry ~20% more entries): a
  // straight insertion sort with the comparison inline handles the short lists, Array.sort the long ones.
  const sortByTypeThenBreakAxis = (list, axis /* 2=maxX, 3=maxY */) => {
    const n = list.length;
    if (n < 2) return;
    if (n > 32) {
      list.sort((a, b) => {
        const tA = segTypes[a],
          tB = segTypes[b];
        if (tA !== tB) return tA - tB;
        const dA = segBbsF[a * 4 + axis],
          dB = segBbsF[b * 4 + axis];
        if (dA !== dB) return dB - dA;
        return a - b;
      });
      return;
    }
    for (let i = 1; i < n; i++) {
      const v = list[i],
        tV = segTypes[v],
        dV = segBbsF[v * 4 + axis];
      let j = i - 1;
      for (; j >= 0; j--) {
        const u = list[j],
          tU = segTypes[u];
        // does u sort after v?  (type ascending, break axis descending, index ascending)
        if (tU < tV) break;
        if (tU === tV) {
          const dU = segBbsF[u * 4 + axis];
          if (dU > dV) break;
          if (dU === dV && u < v) break;
        }
        list[j + 1] = u;
      }
      list[j + 1] = v;
    }
  };
  //
  // Slug also reads these lists (its H ray picks the band from c.y). A superset
  // stays CORRECT for it — the extra segments do not cross its ray — it just
  // walks a little further.
  const hBandSegs = [];
  for (let by = 0; by < bandsY; by++) {
    // pairBands: band `by` covers stripes {by, by+1} — see the note above. Without
    // it a band is a single stripe (the layout Slug wants).
    const yLo = bbY0 + (by * bbH) / bandsY;
    const yHi = bbY0 + (Math.min(by + (pairBands ? 2 : 1), bandsY) * bbH) / bandsY;
    const list = [];
    for (let i = 0; i < N; i++) {
      if (
        segBbsF[i * 4 + 3] + strokePadEm + arcPadY[i] + bandPadY >= yLo &&
        segBbsF[i * 4 + 1] - strokePadEm - arcPadY[i] - bandPadY <= yHi
      )
        list.push(i);
    }
    sortByTypeThenBreakAxis(list, 2 /* maxX */);
    hBandSegs.push(list);
  }
  const vBandSegs = [];
  for (let bx = 0; bx < bandsX; bx++) {
    const xLo = bbX0 + (bx * bbW) / bandsX;
    const xHi = bbX0 + ((bx + 1) * bbW) / bandsX;
    const list = [];
    for (let i = 0; i < N; i++) {
      if (
        segBbsF[i * 4 + 2] + strokePadEm + arcPadX[i] + bandPadX >= xLo &&
        segBbsF[i * 4] - strokePadEm - arcPadX[i] - bandPadX <= xHi
      )
        list.push(i);
    }
    sortByTypeThenBreakAxis(list, 3 /* maxY */);
    vBandSegs.push(list);
  }
  //
  // Level l repeats the H pair bands with stripes 2^l fine stripes tall: its band b lists every
  // segment overlapping fine stripes [b<<l, (b+2)<<l), by the same membership test and boundary
  // formula as the fine bands, until a level has at most two bands and so covers the whole shape.
  // A cell spanning fine stripes [b0, b1] lies inside level l's pair b0>>l as soon as
  // (b1>>l) <= (b0>>l)+1, so the shader walks ONE list at the smallest such level: the segments
  // near that cell, once each, at any size. Bundles that carry no levels keep the stripe walk.
  //
  // Levels start at AAC_LEVEL_FIRST = 2. Level 1 would be 41% of the level memory (over 42 real assets
  // the levels take the band buffer from 3.56 to 6.11 MiB) and buys the least: a cell spanning three or
  // four stripes walks two pair lists, which is not where the cost grew, so the shader keeps that
  // walk and turns to a level only when a cell would need more than two.
  const AAC_LEVEL_FIRST = 2;
  const levelSegs = [];
  let nLevels = 0;
  if (aacLevels && bandsY > 2) {
    for (let l = AAC_LEVEL_FIRST; ; l++) {
      const nb = (bandsY + (1 << l) - 1) >> l;
      for (let b = 0; b < nb; b++) {
        const yLo = bbY0 + ((b << l) * bbH) / bandsY;
        const yHi = bbY0 + (Math.min((b + 2) << l, bandsY) * bbH) / bandsY;
        const list = [];
        for (let i = 0; i < N; i++) {
          if (
            segBbsF[i * 4 + 3] + strokePadEm + arcPadY[i] + bandPadY >= yLo &&
            segBbsF[i * 4 + 1] - strokePadEm - arcPadY[i] - bandPadY <= yHi
          )
            list.push(i);
        }
        sortByTypeThenBreakAxis(list, 2 /* maxX */);
        levelSegs.push(list);
      }
      nLevels = l;
      if (nb <= 2) break;
    }
  }

  // Always wide: 2 texels per band header (texel0 = per-type counts
  // as plain floats; texel1.x = segment-list offset), the
  // GLES3-portable shader layout. A narrow mode (1 texel, 8-bit packed
  // counts) is avoided because the unpacking would require a uint
  // reinterpret of an RGBAFloat texel, which is not portable (mediump
  // samplers can be emitted by default on some targets).
  // Per-type counts are accumulated inside writeBandList's single pass
  // over each band list into this reusable 4-wide scratch, so no second
  // pass or per-band allocation is needed.
  const countScratch = [0, 0, 0, 0];
  const headerSlotsPerBand = 2;

  const hdrBase = glyphLocIdx;
  // Reserve all band-header slots first so the segment-list arrays
  // start at a stable offset.
  // (+1 when gwnTree: one texel for the run-tree header, reserved HERE. Writing it after the band
  // lists would clobber the first list — the lists begin at the first texel past the headers.)
  // (+ the level headers, after the GWN texel and padded to an EVEN slot so a level band's header sits
  // at `virtual band index * 2` like every other band; band 0's header texel 1 records that slot, the
  // TOP level and the FIRST level in its otherwise-unused .y, .z and .w.)
  const baseSlots = (bandsY + bandsX) * headerSlotsPerBand + (gwnTree ? 1 : 0);
  const levelSlot = nLevels ? baseSlots + (baseSlots & 1) : 0;
  const headerSlots = nLevels ? levelSlot + levelSegs.length * headerSlotsPerBand : baseSlots;
  for (let i = 0; i < headerSlots; i++) texelAppend(bandBuf, 0, 0, 0, 0);

  // bandBuf segment-list layout: ONE entry per texel, (loc, break_axis, z, w).
  //   loc        — the segment header's LINEAR curve-plane texel index (row*4096 + col).
  //                Exact in f32 while the curve plane stays under 4096 rows (2^24 texels,
  //                ~268 MB RGBA32F — the floor most mobile GPUs' MAX_TEXTURE_SIZE already
  //                imposes, and the same f32-exact-index contract the band plane's arrIdx
  //                has always relied on); guarded loudly below. The shader unpacks
  //                (loc & 4095, loc >> 12), reproducing (hx, hy) bit-exactly on both
  //                sides of a 4096-column row wrap.
  //   break_axis — for H bands: segment's maxX; for V bands: maxY. Lets the shader
  //                early-out from the band walk by comparing this to renderCoord.axis
  //                WITHOUT first loading the curve's control points. Combined with the
  //                descending sort, the shader breaks as soon as it walks past all
  //                rightmost / topmost segments.
  //   z, w       — WITHOUT lanes (a stroke's structure, a stroked shape's shared one): the far bound
  //                on the break axis (minX - pad, minY - pad) and 0; the stroke walker rejects a
  //                segment lying wholly past its reach from z. WITH lanes (BAND_HDR_RAY_LANES, a
  //                fill-only structure): the segment's (min, max) on the CROSSING axis, which no
  //                stroke walker reads -- the control hull of a line, quad or cubic, the padded
  //                tight extent of an arc (controlHullLanes). A fill walker skips an entry whose
  //                range misses its ray without fetching the segment.
  // The walk is fetch-bound. Per-entry
  // segType is NOT stored — the lists are type-grouped (sortByTypeThenBreakAxis) and every
  // walker is count-segmented into monomorphic per-type sub-loops, so type is positional.
  // bandBuf is float-encoded; integer values (loc, counts, offsets) are stored as plain
  // (float)val and recovered via int(floatVal) in the shader — no asuint() bit-reinterpret.

  // Writes the band's segment-list texels AND tallies per-type counts
  // into countScratch in the same pass. Returns the list's start offset.
  const writeBandList = (list, axis /* 2=maxX or 3=maxY */) => {
    const arrIdx = bandBuf.count - glyphLocIdx;
    if (arrIdx >= 16777216) {
      throw new Error('mantle: band list offset exceeds the exact float32 integer range');
    }
    countScratch[0] = 0;
    countScratch[1] = 0;
    countScratch[2] = 0;
    countScratch[3] = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const idx = segHdrIdx[i];
      if (idx >= 16777216) {
        throw new Error(
          'mantle: curve plane exceeds 4096 rows (2^24 texels) — packed band ' +
            'entries cannot address segment headers past that point',
        );
      }
      // Bake strokePadEm into breakAxis so the shader's early-break
      // (`entryBrk - c.x < -halfW`) correctly considers a seg's cap /
      // miter extension past its control bbox. Without this, a pixel
      // inside a free-cap or miter wedge that lies past the seg's
      // control maxX gets the seg skipped → notch at one corner of
      // the cap. For fills strokePadEm is 0 so this is a no-op.
      const breakAxis = segBbsF[i * 4 + axis] + strokePadEm;
      // FAR bound: the opposite end of the seg's extent on the break axis.
      // The list is sorted by breakAxis DESCENDING and the walk breaks once
      // that falls behind the pixel, which bounds one side only — a seg lying
      // entirely PAST the pixel on the other side would still be fetched in full.
      // Carrying its far edge lets the walk reject it from the band entry
      // alone, before touching the segment's header/control texels.
      const farAxis = segBbsF[i * 4 + (axis - 2)] - strokePadEm;
      countScratch[segTypes[i] & 3]++;
      // A structure with lanes carries the crossing-axis range instead (the crossing axis is y for an
      // H list, x for a V list); nothing reads its far bound, which only the stroke walker wants.
      if (laneF) {
        const c = axis === 2 ? 1 : 0; // laneF is (minX, minY, maxX, maxY)
        texelAppend(bandBuf, idx, breakAxis, laneF[i * 4 + c], laneF[i * 4 + 2 + c]);
      } else texelAppend(bandBuf, idx, breakAxis, farAxis, 0);
    }
    return arrIdx;
  };

  // Wide-only header layout: each band header is 2 adjacent texels:
  //   texel0 = (nLine, nQuad, nCubic, nArc) — plain floats
  //   texel1 = (arrIdx, flags, 0, 0)        — plain floats
  // H bands occupy slots [0 .. bandsY*2); V bands [bandsY*2 ..
  // (bandsY+bandsX)*2). Shader walks four monomorphic sub-loops
  // back-to-back, each with its own break. `flags` is BAND_HDR_RAY_LANES
  // or 0 on every header, the level headers included; band 0 adds it to
  // the (even) level slot it also carries in .y.
  for (let by = 0; by < bandsY; by++) {
    const list = hBandSegs[by];
    const arrIdx = writeBandList(list, 2 /* maxX */); // fills countScratch
    texelSet(
      bandBuf,
      hdrBase + by * 2 + 0,
      countScratch[0],
      countScratch[1],
      countScratch[2],
      countScratch[3],
    );
    texelSet(
      bandBuf,
      hdrBase + by * 2 + 1,
      arrIdx,
      (by === 0 ? levelSlot : 0) + laneBit,
      by === 0 ? nLevels : 0,
      by === 0 && nLevels ? AAC_LEVEL_FIRST : 0,
    );
  }
  const vBase = hdrBase + bandsY * headerSlotsPerBand;
  for (let bx = 0; bx < bandsX; bx++) {
    const list = vBandSegs[bx];
    const arrIdx = writeBandList(list, 3 /* maxY */); // fills countScratch
    texelSet(
      bandBuf,
      vBase + bx * 2 + 0,
      countScratch[0],
      countScratch[1],
      countScratch[2],
      countScratch[3],
    );
    texelSet(bandBuf, vBase + bx * 2 + 1, arrIdx, laneBit, 0, 0);
  }
  for (let k = 0; k < levelSegs.length; k++) {
    const arrIdx = writeBandList(levelSegs[k], 2 /* maxX */); // fills countScratch
    texelSet(
      bandBuf,
      hdrBase + levelSlot + k * 2 + 0,
      countScratch[0],
      countScratch[1],
      countScratch[2],
      countScratch[3],
    );
    texelSet(bandBuf, hdrBase + levelSlot + k * 2 + 1, arrIdx, laneBit, 0, 0);
  }

  // ---- GWN RUN TREE (opt-in) -------------------------------------------------
  // Bands are the wrong structure for a winding number: winding is GLOBAL, so a pixel must see
  // every segment, and a y-stripe index prunes nothing. The right structure is a hierarchy over
  // Contiguous runs of the contour, because the winding contribution of a run collapses exactly
  // (not approximately) when the pixel is outside the run's bounding circle:
  //   * the arc<->chord lunes all lie inside the curve's convex hull ⊂ its bbox ⊂ the circle, so
  //     every bulge term is zero; and
  //   * the per-segment chord angles telescope — the run's points subtend < pi from an outside
  //     point, so no 2pi wrap — leaving ONE atan2 between the run's first and last on-curve point.
  // So a far run costs 1 atan2 regardless of how many segments it holds. This is the exact core of
  // the fast-winding-number hierarchy (Barill et al.), with no far-field approximation needed.
  //
  // Packed after the V bands, all indices relative to glyphLocIdx (like arrIdx):
  //   header  (1 texel): (nodeBase, ±nodeCount [sign = contour handedness], refBase, refCount)
  //   node    (2 texels, DFS preorder): A=(startX,startY,endX,endY) chord
  //                                     B=(cx,cy,radius,code) — code >= 0: internal, escape
  //                                     index; code < 0: leaf, -(refStart*64+refCount+1)
  //   ref     (1 texel): (hx, hy, segType, 0)   -- a leaf's segment, by curve-texel coords
  //   ext     (1 texel, at refBase+refCount): (rootBandBase, GB, gridBase, gridW*256+gridH)
  //     then GB/2 root-band header texels (base,count pairs), the per-band x-sorted cut
  //     entries (nodeIdx*4+adjFlags, maxX, y0, y1), and the occupancy grid (2 cells/texel).
  let gwnHeaderSlot = -1;
  let gwnUnsafe = false;
  // Capture the curve range before appending GWN piece records to the same buffer;
  // downstream geometry readers must not interpret tree data as curve segments.
  const curveEndF = curveBuf.count * 4;
  if (gwnTree && N > 0) {
    const endOf = (i) => segEnd(segs[i]);
    const startOf = (i) => segStart(segs[i]);
    // ---- PIECE EXPANSION. The tree's leaves address PIECES, not segments: lines and quads
    // pass through as refs to their standard curve texels; CUBICS split (inflections + the
    // LB flatness criterion, so each piece holds a single implicit branch) into records
    // carrying the affine k/l/m rows of the Loop-Blinn implicit; ARCS split into <= 90-degree
    // sweeps carrying the exact ellipse implicit. Piece records append to the curve buffer
    // (row-wrap padded — a record must not straddle a texture row) and are addressed like
    // any segment texel. Types: 4 = cubic piece, 5 = arc piece.
    const pieces = [];
    let _pieceMag = 0; // the segment's jointMag, for the joint tests
    // A CURVE CAN HOOK PAST ITS CHORD'S ENDS, so neither "chord bbox +- the perpendicular deviation" (the node circles'
    // bound) nor "the perpendicular deviation" (the occupancy grid's pad around a sub-chord) bounds it. A quad
    // M400 400 Q-300 250 110 250 reaches x = -41 while its chord bbox +- deviation stops at x = 16: the node circle
    // would miss the bulge, and a pixel beside it would take the chord's crossing and read outside. The curve lies in
    // its control hull, so the hull's overshoot past the sub-chord's ends bounds the rest:
    // the distance from any hull point to the SEGMENT is at most hypot(perpendicular, overshoot). A curve that does not
    // hook has no overshoot, and its pad is the perpendicular bound alone, bit for bit.
    const _overshoot = (a, b, ctrl) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        L2 = dx * dx + dy * dy;
      if (!(L2 > 0)) return 0;
      const L = Math.sqrt(L2);
      let o = 0;
      for (const p of ctrl) {
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
        if (t < 0) o = Math.max(o, -t * L);
        else if (t > 1) o = Math.max(o, (t - 1) * L);
      }
      return o;
    };
    const _spanOf = (P) => {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const p of P) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      return Math.max(x1 - x0, y1 - y0);
    };
    // CERTIFIED polyline for the occupancy grid (tier-3 early exit): flat (ax, ay, bx, by, pad)
    // sub-chords with a per-chord pad that provably bounds the curve's deviation from the chord
    // (hull / sagitta arguments per type). A grid cell whose center is farther than pad from
    // every sub-chord has the polyline's exact winding: curve and polyline are homotopic inside
    // the pad tube, and the tube misses the cell center.
    const polySegs = [];
    const polyPush = (a, b, pad) => {
      polySegs.push(a[0], a[1], b[0], b[1], pad);
      _piecePad = pad;
    };
    const padTo = (len) => {
      while ((curveBuf.count % TEXTURE_WIDTH) + len > TEXTURE_WIDTH)
        texelAppend(curveBuf, 0, 0, 0, 0);
    };
    let _piecePad = 0;
    let _pieceSmooth = 0;
    let _pieceLoop = false; // the piece is of a self-intersecting cubic (it may cross its own)
    // A split point is smooth when the curve keeps its direction through it. A cusp reverses it, so the test is the SIGN of
    // the two tangents' dot product -- no angle tolerance: at a real inflection or midpoint split the tangents agree.
    const _tanEnd = (P) => {
      const a = [P[3][0] - P[2][0], P[3][1] - P[2][1]];
      return Math.hypot(a[0], a[1]) > DEG_REL * _spanOf(P)
        ? a
        : [P[3][0] - P[1][0], P[3][1] - P[1][1]];
    };
    const _tanStart = (P) => {
      const a = [P[1][0] - P[0][0], P[1][1] - P[0][1]];
      return Math.hypot(a[0], a[1]) > DEG_REL * _spanOf(P)
        ? a
        : [P[2][0] - P[0][0], P[2][1] - P[0][1]];
    };
    const _smoothThrough = (Pl, Pr) => {
      const a = _tanEnd(Pl),
        b = _tanStart(Pr);
      return a[0] * b[0] + a[1] * b[1] > 0;
    };
    let _polyMark = 0; // where the next piece's sub-chords start in polySegs
    // The curve and its direction of travel at a parameter t -- [x, y, dx/dt, dy/dt] -- set by the emitter before
    // pushPiece: the ink-side test below probes across the curve at points ON it, which the per-contour
    // rule's probe point, a passthrough quad's chord midpoint, is not. Null: no side (sigma 0).
    let _pieceEv = null;
    const _evLine = (a, b) => (t) => [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
      b[0] - a[0],
      b[1] - a[1],
    ];
    const _evQuad = (A, C, B) => (t) => {
      const u = 1 - t;
      return [
        u * u * A[0] + 2 * u * t * C[0] + t * t * B[0],
        u * u * A[1] + 2 * u * t * C[1] + t * t * B[1],
        2 * (u * (C[0] - A[0]) + t * (B[0] - C[0])),
        2 * (u * (C[1] - A[1]) + t * (B[1] - C[1])),
      ];
    };
    const _evCubic = (P) => (t) => {
      const u = 1 - t;
      return [0, 1]
        .map(
          (i) =>
            u * u * u * P[0][i] +
            3 * u * u * t * P[1][i] +
            3 * u * t * t * P[2][i] +
            t * t * t * P[3][i],
        )
        .concat(
          [0, 1].map(
            (i) =>
              3 *
              (u * u * (P[1][i] - P[0][i]) +
                2 * u * t * (P[2][i] - P[1][i]) +
                t * t * (P[3][i] - P[2][i])),
          ),
        );
    };
    const pushPiece = (s, e, bb, idx, ty) => {
      const pa = _polyMark;
      _polyMark = polySegs.length / 5;
      pieces.push({
        s,
        e,
        bb,
        hx: idx % TEXTURE_WIDTH,
        hy: Math.floor(idx / TEXTURE_WIDTH),
        ty,
        pad: _piecePad,
        sigma: 0,
        sm: _pieceSmooth,
        mag: _pieceMag,
        pa,
        pb: _polyMark,
        ev: _pieceEv,
        lp: _pieceLoop,
      });
      _pieceEv = null;
    };
    // degenerate curve piece -> a synthetic LINE record (header texel + endpoint texel, the
    // type-0 reader's layout)
    const emitLinePiece = (a, b) => {
      padTo(2);
      const h = texelAppend(curveBuf, 0, 0, 0, 0);
      texelAppend(curveBuf, a[0], a[1], b[0], b[1]);
      polyPush(a, b, 0);
      _pieceEv = _evLine(a, b);
      pushPiece(
        a,
        b,
        [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        h,
        0,
      );
    };
    const emitCubicPiece = (P, klmn) => {
      const chx = P[3][0] - P[0][0],
        chy = P[3][1] - P[0][1];
      const cl = Math.hypot(chx, chy);
      if (!klmn || !(cl > 0)) {
        emitLinePiece(P[0], P[3]);
        return;
      }
      // affine rows from the most non-degenerate control-point triple
      let best = -1,
        bi = 0;
      const tris = [
        [0, 1, 2],
        [0, 1, 3],
        [0, 2, 3],
        [1, 2, 3],
      ];
      for (let t = 0; t < 4; t++) {
        const [a, b, c] = tris[t];
        const ar = Math.abs(
          (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]),
        );
        if (ar > best) {
          best = ar;
          bi = t;
        }
      }
      if (best < 1e-9 * cl * cl) {
        emitLinePiece(P[0], P[3]);
        return;
      }
      const [ia, ib, ic] = tris[bi];
      const solveRow = (vals) => {
        // row (rx, ry, rc) with rx*x + ry*y + rc = val at the three points
        const x1 = P[ia][0],
          y1 = P[ia][1],
          x2 = P[ib][0],
          y2 = P[ib][1],
          x3 = P[ic][0],
          y3 = P[ic][1];
        const det = x1 * (y2 - y3) - y1 * (x2 - x3) + (x2 * y3 - x3 * y2);
        if (!(Math.abs(det) > 1e-6 * best)) return null; // det is +-best, up to rounding: only a canceled one is refused
        const v1 = vals[ia],
          v2 = vals[ib],
          v3 = vals[ic];
        const rx = (v1 * (y2 - y3) + v2 * (y3 - y1) + v3 * (y1 - y2)) / det;
        const ry = (v1 * (x3 - x2) + v2 * (x1 - x3) + v3 * (x2 - x1)) / det;
        const rc =
          (v1 * (x2 * y3 - x3 * y2) + v2 * (x3 * y1 - x1 * y3) + v3 * (x1 * y2 - x2 * y1)) / det;
        return [rx, ry, rc];
      };
      const rk = solveRow(klmn.k),
        rl = solveRow(klmn.l),
        rm = solveRow(klmn.m);
      if (!rk || !rl || !rm) {
        emitLinePiece(P[0], P[3]);
        return;
      }
      // lune metadata: signed perpendicular deviation frame along the chord. NB: the cubic's
      // lune term is not in the shader (the winding is exact) — luneAdd/fMidSign remain only
      // because the record shape is shared with the arc piece, which still winds by chord + lune
      // (an arc's lune IS cheaply exact: the far arm of the ellipse is a whole minor axis away).
      const dev = (p) => ((p[0] - P[0][0]) * chy - (p[1] - P[0][1]) * chx) / cl;
      const mid = [
        0.125 * P[0][0] + 0.375 * P[1][0] + 0.375 * P[2][0] + 0.125 * P[3][0],
        0.125 * P[0][1] + 0.375 * P[1][1] + 0.375 * P[2][1] + 0.125 * P[3][1],
      ];
      const dMid = dev(mid);
      const luneAdd = dMid >= 0 ? 1 : -1; // matches the quad's sign(sideP) convention
      const maxDev =
        Math.max(Math.abs(dev(P[1])), Math.abs(dev(P[2])), Math.abs(dMid)) * 1.0001 + 1e-12 * cl;
      // f's sign strictly between chord and curve, from the rows themselves
      const q = [
        ((P[0][0] + P[3][0]) / 2) * 0.5 + mid[0] * 0.5,
        ((P[0][1] + P[3][1]) / 2) * 0.5 + mid[1] * 0.5,
      ];
      const kq = rk[0] * q[0] + rk[1] * q[1] + rk[2];
      const lq = rl[0] * q[0] + rl[1] * q[1] + rl[2];
      const mq = rm[0] * q[0] + rm[1] * q[1] + rm[2];
      const fMidSign = kq * kq * kq - lq * mq >= 0 ? 1 : -1;
      const unit = (x, y, fx, fy) => {
        const L = Math.hypot(x, y);
        return L > DEG_REL * cl ? [x / L, y / L] : [fx, fy];
      };
      const t0 = unit(P[1][0] - P[0][0], P[1][1] - P[0][1], chx / cl, chy / cl);
      const t1 = unit(P[3][0] - P[2][0], P[3][1] - P[2][1], chx / cl, chy / cl);
      // luneAdd == 0 is the shader's flag for "this one does not get the cheap lune — wind it with
      // the exact ray crossing", and such a piece carries a 6th texel with its control points.
      const cheap = luneIsExact(P, chx, chy, cl, luneAdd, maxDev);
      const luneW = cheap ? luneAdd : 0;
      // The raw control points ride along on every piece, cheap or not: the kernel's exact-area pass integrates the curve
      // itself over a pixel it lies in, and the winding reads them where the lune is not exact.
      padTo(6);
      const h = texelAppend(curveBuf, P[0][0], P[0][1], P[3][0], P[3][1]);
      texelAppend(curveBuf, rk[0], rk[1], rk[2], luneW);
      texelAppend(curveBuf, rl[0], rl[1], rl[2], fMidSign);
      texelAppend(curveBuf, rm[0], rm[1], rm[2], maxDev);
      texelAppend(curveBuf, t0[0], t0[1], t1[0], t1[1]);
      texelAppend(curveBuf, P[1][0], P[1][1], P[2][0], P[2][1]); // raw control points
      // polyline: quarter-split; each sub-cubic's control-point deviation from its own chord is
      // a certified pad (curve ⊂ hull ⊂ chord slab of that width)
      const [hL, hR] = splitCubic(P, 0.5);
      for (const half of [hL, hR])
        for (const Q of splitCubic(half, 0.5)) {
          const qx = Q[3][0] - Q[0][0],
            qy = Q[3][1] - Q[0][1],
            ql = Math.hypot(qx, qy);
          const dv = (p) =>
            ql > 0
              ? Math.abs((p[0] - Q[0][0]) * qy - (p[1] - Q[0][1]) * qx) / ql
              : Math.hypot(p[0] - Q[0][0], p[1] - Q[0][1]);
          polyPush(
            Q[0],
            Q[3],
            Math.hypot(Math.max(dv(Q[1]), dv(Q[2])), _overshoot(Q[0], Q[3], [Q[1], Q[2]])) *
              1.0001 +
              1e-12 * _spanOf(Q),
          );
        }

      const pb = [
        Math.min(P[0][0], P[3][0]) - maxDev,
        Math.min(P[0][1], P[3][1]) - maxDev,
        Math.max(P[0][0], P[3][0]) + maxDev,
        Math.max(P[0][1], P[3][1]) + maxDev,
      ];
      if (!cheap) {
        const tb = [0, 0, 0, 0];
        curveTightBboxCubicInto(P[0], P[1], P[2], P[3], tb, 0);
        pb[0] = Math.min(pb[0], tb[0]);
        pb[1] = Math.min(pb[1], tb[1]);
        pb[2] = Math.max(pb[2], tb[2]);
        pb[3] = Math.max(pb[3], tb[3]);
      }
      _pieceEv = _evCubic(P);
      pushPiece(P[0], P[3], pb, h, 4);
    };
    // Can this cubic piece keep the CHEAP winding (chord crossing + lune term), or must the shader
    // wind it with the exact ray crossing?
    //
    // The lune term adds ±1 when the pixel lies between the chord and the curve, and it decides
    // "between" with: in the chord SPAN, on the bulge side, inside the |dev| <= maxDev slab, and the
    // implicit says inside. That is exact only if two things hold, and each fails on real content:
    //
    //   (A) the curve's own EXTENSION (t outside [0,1]) must stay out of the slab region. A Bézier's
    //       implicit does not stop at its endpoints — it is the whole algebraic cubic — so where the
    //       extension curls back through the slab, the implicit's sign flips a SECOND time and reads
    //       "inside" again on the far side of the curve. The lune then fires outside the lune and
    //       adds a phantom ±1: a flipped REGION, not a shading error.
    //
    //   (B) the lune must lie inside the chord span, or the span gate vetoes a real correction. A
    //       piece can be "flat" (flatSplit measures only PERPENDICULAR deviation) and still hook
    //       backward past its own endpoint. Curve ⊂ control hull, so it is enough that both inner
    //       control points project into the span.
    //
    // Both are decidable here, exactly: tproj(B(t)) and dev(B(t)) are CUBIC polynomials in t, so the
    // t-set that lies in the slab region is bounded by the roots of four cubics. Between consecutive
    // roots the predicate is constant, so testing one t per interval settles it. A piece that clears
    // both keeps the cheap path; the rest wind exactly. Erring toward "unsafe"
    // only costs that piece a solve, so every degenerate case answers false.
    const luneIsExact = (P, chx, chy, cl, luneAdd, maxDev) => {
      const cl2 = cl * cl;
      if (!(cl2 > 0) || !(maxDev > 0)) return false;
      const tprojOf = (q) => ((q[0] - P[0][0]) * chx + (q[1] - P[0][1]) * chy) / cl2;
      const t1 = tprojOf(P[1]),
        t2 = tprojOf(P[2]);
      if (!(t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1)) return false; // (B)
      // (A): B(t) - P0 in the (tproj, dev) frame — both cubic polynomials in t
      const bx = [
        0,
        3 * (P[1][0] - P[0][0]),
        3 * (P[0][0] - 2 * P[1][0] + P[2][0]),
        -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0],
      ];
      const by = [
        0,
        3 * (P[1][1] - P[0][1]),
        3 * (P[0][1] - 2 * P[1][1] + P[2][1]),
        -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
      ];
      const h = [],
        g = [];
      for (let i = 0; i < 4; i++) {
        h.push((bx[i] * chx + by[i] * chy) / cl2); // tproj(B(t))
        g.push((bx[i] * chy - by[i] * chx) / cl); // dev(B(t))
      }
      const ev = (c, t) => c[0] + t * (c[1] + t * (c[2] + t * c[3]));
      const bps = [0, 1];
      bps.push(...solveCubic(h[3], h[2], h[1], h[0]));
      bps.push(...solveCubic(h[3], h[2], h[1], h[0] - 1));
      bps.push(...solveCubic(g[3], g[2], g[1], g[0]));
      bps.push(
        ...solveCubic(g[3] * luneAdd, g[2] * luneAdd, g[1] * luneAdd, g[0] * luneAdd - maxDev),
      );
      const B = bps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
      const M = 0.05; // the extension must CLEAR the region
      for (let i = 0; i <= B.length; i++) {
        // one probe per interval, tails included
        const lo = i === 0 ? B[0] - 1 : B[i - 1];
        const hi = i === B.length ? B[B.length - 1] + 1 : B[i];
        const t = i === 0 ? lo : i === B.length ? hi : (lo + hi) / 2;
        if (t >= -1e-9 && t <= 1 + 1e-9) continue; // the piece's own arc: that IS the lune
        const hv = ev(h, t),
          gv = ev(g, t) * luneAdd;
        if (hv > -M && hv < 1 + M && gv > -M * maxDev && gv <= maxDev * (1 + M)) return false;
      }
      return true;
    };
    // type-6 exact cubic piece: a cusp or self-intersecting loop cubic has no single valid
    // Loop-Blinn branch (cubicKLMN → null), so the type-4 chord+lune winding miscounts it. This
    // record carries the RAW control points and the shader winds it with hardCrossCubic — the
    // exact +x ray-crossing (Slug's cubic solver), which handles cusps/loops. Winding-only: no
    // SDF candidate is produced, so it belongs to the tree-hard (GWN_WINDING_ONLY) route.
    const emitCubicHardPiece = (P) => {
      padTo(2);
      const h = texelAppend(curveBuf, P[0][0], P[0][1], P[1][0], P[1][1]); // (P0, P1)
      texelAppend(curveBuf, P[2][0], P[2][1], P[3][0], P[3][1]); // (P2, P3)
      // certified occupancy polyline: quarter-split, each sub-chord padded by its own control
      // deviation (curve ⊂ hull ⊂ chord slab of that width) — same bound emitCubicPiece uses.
      const [hL, hR] = splitCubic(P, 0.5);
      for (const half of [hL, hR])
        for (const Q of splitCubic(half, 0.5)) {
          const qx = Q[3][0] - Q[0][0],
            qy = Q[3][1] - Q[0][1],
            ql = Math.hypot(qx, qy);
          const dv = (p) =>
            ql > 0
              ? Math.abs((p[0] - Q[0][0]) * qy - (p[1] - Q[0][1]) * qx) / ql
              : Math.hypot(p[0] - Q[0][0], p[1] - Q[0][1]);
          polyPush(
            Q[0],
            Q[3],
            Math.hypot(Math.max(dv(Q[1]), dv(Q[2])), _overshoot(Q[0], Q[3], [Q[1], Q[2]])) *
              1.0001 +
              1e-12 * _spanOf(Q),
          );
        }
      // control-hull bbox (conservative — a cusp/loop can bulge past the chord slab)
      const xs = [P[0][0], P[1][0], P[2][0], P[3][0]],
        ys = [P[0][1], P[1][1], P[2][1], P[3][1]];
      _pieceEv = _evCubic(P);
      pushPiece(
        P[0],
        P[3],
        [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        h,
        6,
      );
    };

    const emitCubicLeaf = (P, klmn, forceHard) => {
      if (klmn && !forceHard) {
        emitCubicPiece(P, klmn);
        return;
      }
      const chx = P[3][0] - P[0][0],
        chy = P[3][1] - P[0][1];
      if (!(Math.hypot(chx, chy) > 0)) {
        emitLinePiece(P[0], P[3]);
        return;
      } // truly degenerate
      emitCubicHardPiece(P);
    };
    const flatSplit = (P, depth, forceHard, sm = 0) => {
      const chx = P[3][0] - P[0][0],
        chy = P[3][1] - P[0][1];
      const cl = Math.hypot(chx, chy);
      const d1 = cl > 0 ? Math.abs((P[1][0] - P[0][0]) * chy - (P[1][1] - P[0][1]) * chx) / cl : 0;
      const d2 = cl > 0 ? Math.abs((P[2][0] - P[0][0]) * chy - (P[2][1] - P[0][1]) * chx) / cl : 0;
      const flat = Math.max(d1, d2) <= 0.14 * cl;
      const klmn = flat || depth >= 4 ? cubicKLMN(P) : null;
      // A single-branch piece becomes type-4; a cusp/loop piece (klmn null, or forceHard for a
      // self-intersecting parent) becomes an exact type-6 hard piece — no line fallback, no klm.
      if ((flat && klmn) || depth >= 8 || (flat && depth >= 4)) {
        _pieceSmooth = sm;
        emitCubicLeaf(P, klmn, forceHard);
        _pieceSmooth = 0;
        return;
      }
      const [L, R] = splitCubic(P, 0.5);
      const mid = _smoothThrough(L, R) ? 1 : 0;
      flatSplit(L, depth + 1, forceHard, (sm & 1) | (mid << 1));
      flatSplit(R, depth + 1, forceHard, mid | (sm & 2));
    };
    const emitArcPieces = (sg) => {
      const co = Math.cos(sg.phi),
        si = Math.sin(sg.phi);
      const pt = (th) => {
        const ex = sg.rx * Math.cos(th),
          ey = sg.ry * Math.sin(th);
        return [sg.cx + co * ex - si * ey, sg.cy + si * ex + co * ey];
      };
      const dir = sg.theta_end >= sg.theta_start ? 1 : -1;
      const total = Math.abs(sg.theta_end - sg.theta_start);
      // Pieces of AT MOST a quarter turn. The epsilon must widen the bound, not
      // narrow it: with `PI/2 - eps` an exactly-quarter arc divides to 1.0000006
      // and ceils to TWO pieces — and an exact quarter is the most common arc in
      // vector art (every circle quadrant, every rounded-rect corner), so this
      // doubled the tree's pieces, nodes, refs and band bytes for no benefit.
      const nPieces = Math.max(1, Math.ceil(total / (Math.PI / 2 + 1e-6)));
      for (let pi = 0; pi < nPieces; pi++) {
        const th0 = sg.theta_start + (dir * total * pi) / nPieces;
        const th1 = sg.theta_start + (dir * total * (pi + 1)) / nPieces;
        // the seg's STORED endpoints at the outer ends — recomputed floats would differ in
        // the last ulp and read as false contour breaks in the forest builder
        const E0 = pi === 0 ? [sg.p1[0], sg.p1[1]] : pt(th0);
        const E1 = pi === nPieces - 1 ? [sg.p4[0], sg.p4[1]] : pt(th1);
        const chx = E1[0] - E0[0],
          chy = E1[1] - E0[1];
        const cl = Math.hypot(chx, chy);
        if (!(cl > 0)) continue;
        const dev = (p) => ((p[0] - E0[0]) * chy - (p[1] - E0[1]) * chx) / cl;
        // deviation extremum sampled (ellipse arcs peak off the parameter midpoint)
        let maxDev = 0,
          dMidSigned = 0;
        for (let ss = 1; ss < 8; ss++) {
          const dv = dev(pt(th0 + ((th1 - th0) * ss) / 8));
          if (ss === 4) dMidSigned = dv;
          maxDev = Math.max(maxDev, Math.abs(dv));
        }
        maxDev = maxDev * 1.02 + 1e-12 * cl;
        const luneAdd = dMidSigned >= 0 ? 1 : -1;
        const tan = (th) => {
          const ex = -sg.rx * Math.sin(th) * dir,
            ey = sg.ry * Math.cos(th) * dir;
          const tx = co * ex - si * ey,
            ty = si * ex + co * ey;
          const L = Math.hypot(tx, ty);
          return L > DEG_REL * Math.max(sg.rx, sg.ry) ? [tx / L, ty / L] : [chx / cl, chy / cl];
        };
        const t0 = tan(th0),
          t1 = tan(th1);
        padTo(5);
        const h = texelAppend(curveBuf, E0[0], E0[1], E1[0], E1[1]);
        texelAppend(curveBuf, sg.cx, sg.cy, sg.rx, sg.ry);
        texelAppend(curveBuf, co, si, luneAdd, maxDev);
        texelAppend(curveBuf, t0[0], t0[1], t1[0], t1[1]);
        texelAppend(curveBuf, th0, th1, sg.phi, 0); // the piece's angles, for the kernel's exact-area pass
        // polyline: 4 sub-chords; ellipse-arc sagitta ≤ max(rx, ry) * (1 - cos(dθ/2)) certified
        // via the unit-circle scaling argument (rotation preserves distance, diag(rx, ry)
        // multiplies it by at most max(rx, ry))
        {
          const dth = (th1 - th0) / 4;
          const aPad = Math.max(sg.rx, sg.ry) * ((1 - Math.cos(Math.abs(dth) / 2)) * 1.001 + 1e-12);
          let prev = E0;
          for (let ss = 1; ss <= 4; ss++) {
            const nxt = ss === 4 ? E1 : pt(th0 + dth * ss);
            polyPush(prev, nxt, aPad);
            prev = nxt;
          }
        }
        // bbox: chord bbox padded by the deviation
        const bx0 = Math.min(E0[0], E1[0]) - maxDev,
          by0 = Math.min(E0[1], E1[1]) - maxDev;
        const bx1 = Math.max(E0[0], E1[0]) + maxDev,
          by1 = Math.max(E0[1], E1[1]) + maxDev;
        _pieceSmooth = (pi > 0 ? 1 : 0) | (pi < nPieces - 1 ? 2 : 0); // an ellipse is smooth through its quarter splits
        _pieceEv = (t) => {
          const th = th0 + t * (th1 - th0),
            p = pt(th),
            ex = -sg.rx * Math.sin(th) * (th1 - th0),
            ey = sg.ry * Math.cos(th) * (th1 - th0);
          return [p[0], p[1], co * ex - si * ey, si * ex + co * ey];
        };
        pushPiece(E0, E1, [bx0, by0, bx1, by1], h, 5);
        _pieceSmooth = 0;
      }
    };
    for (let k = 0; k < N; k++) {
      const ty = segTypes[k];
      _pieceMag = jointMag(segs[k]);
      if (ty === SEG_CUBIC) {
        const P0c = [segs[k].p1, segs[k].p2, segs[k].p3, segs[k].p4];
        // A self-closing cubic (start == end), a loop and a cusp are the curves the GWN+SDF ANTI-ALIASED path cannot fill (its type-6
        // hard pieces exist only in tree-hard mode): a teardrop comes out blank. The bundle records that so the renderer vetoes the kernel.
        if (
          (segs[k].p1[0] === segs[k].p4[0] && segs[k].p1[1] === segs[k].p4[1]) ||
          cubicCuspT(segs[k]) >= 0
        )
          gwnUnsafe = true;
        // Split at inflections. A self-intersecting LOOP cubic emits its pieces as exact type-6
        // hard pieces (forceHard) — the type-4 klm implicit can't represent the two strands' double
        // coverage. The winding is then exact on the tree; only a sub-pixel hard-vs-AA residual
        // remains at the self-crossing (the one fill edge the covering stroke can't mask), which is
        // acceptable on the no-AA tree-hard route. Non-stroke-covered loops never take this path.
        const infl = cubicInflections(P0c, true);
        const isLoop = !!cubicLoopParams(P0c, true);
        if (isLoop) gwnUnsafe = true;
        const parts = splitCubicMulti(P0c, infl);
        _pieceLoop = isLoop;
        for (let pi = 0; pi < parts.length; pi++) {
          const sS = pi > 0 && _smoothThrough(parts[pi - 1], parts[pi]) ? 1 : 0;
          const sE = pi < parts.length - 1 && _smoothThrough(parts[pi], parts[pi + 1]) ? 2 : 0;
          flatSplit(parts[pi], 0, isLoop, sS | sE);
        }
        _pieceLoop = false;
      } else if (ty === SEG_ARC) {
        emitArcPieces(segs[k]);
      } else {
        const hi = segHdrIdx[k];
        let bbP = [segBbsF[k * 4], segBbsF[k * 4 + 1], segBbsF[k * 4 + 2], segBbsF[k * 4 + 3]];
        if (ty === SEG_QUAD) {
          // TIGHT bound: the curve's own extrema (segBbsF, bbox.js). The chord bbox +- ctrlDev/2 bounds the curve's
          // PERPENDICULAR deviation but not a quad that hooks past its chord's ends (see _overshoot); the quad's
          // lune test runs over its whole control triangle, so the node circle must hold the whole curve. For a quad that
          // does not hook the tight box lies inside the chord-based one.
          const A = segs[k].p1,
            C = segs[k].p2,
            B = segs[k].p3;
          const chx = B[0] - A[0],
            chy = B[1] - A[1];
          const cl = Math.hypot(chx, chy);
          const dev =
            cl > 0
              ? (Math.abs((C[0] - A[0]) * chy - (C[1] - A[1]) * chx) / cl) * 0.5
              : Math.hypot(C[0] - A[0], C[1] - A[1]) * 0.5;
          // polyline: 4 sub-chords; a quad's chord deviation scales exactly with h² (constant
          // second derivative), so each quarter deviates ≤ dev/16 from its chord
          const qp = (t) => [
            (1 - t) * (1 - t) * A[0] + 2 * (1 - t) * t * C[0] + t * t * B[0],
            (1 - t) * (1 - t) * A[1] + 2 * (1 - t) * t * C[1] + t * t * B[1],
          ];

          const qd = (t) => [
            2 * ((1 - t) * (C[0] - A[0]) + t * (B[0] - C[0])),
            2 * ((1 - t) * (C[1] - A[1]) + t * (B[1] - C[1])),
          ];
          let prev = A;
          for (let ss = 1; ss <= 4; ss++) {
            const nxt = ss === 4 ? B : qp(ss / 4);
            const a = (ss - 1) / 4,
              d = qd(a),
              ctrl = [prev[0] + d[0] / 8, prev[1] + d[1] / 8];
            const sx = nxt[0] - prev[0],
              sy = nxt[1] - prev[1],
              sl = Math.hypot(sx, sy);
            const perp =
              sl > 0
                ? (Math.abs((ctrl[0] - prev[0]) * sy - (ctrl[1] - prev[1]) * sx) / sl) * 0.5
                : Math.hypot(ctrl[0] - prev[0], ctrl[1] - prev[1]);
            polyPush(
              prev,
              nxt,
              Math.hypot(perp, _overshoot(prev, nxt, [ctrl])) * 1.001 + 1e-12 * cl,
            );
            prev = nxt;
          }
        } else {
          polyPush(startOf(k), endOf(k), 0);
        }
        _pieceEv =
          ty === SEG_QUAD
            ? _evQuad(segs[k].p1, segs[k].p2, segs[k].p3)
            : ty === SEG_LINE
              ? _evLine(startOf(k), endOf(k))
              : null;
        pushPiece(startOf(k), endOf(k), bbP, hi, ty);
      }
    }
    const NP = pieces.length;

    // ---- INK SIDE, per PIECE, decided at BUILD time by the exact inside test ---------------------------------------

    // One piece can have more than one side. Where another curve crosses it the winding beside it steps, and its ink side
    // flips (even-odd), or it stops being a boundary (nonzero, 1 -> 2). So it is asked at t = 1/4, 1/2 and 3/4, and a piece
    // whose answers differ is MIXED: sigma +-2, the sign the t = 1/2 answer's (else the first side found). The kernel
    // models no two-plane pixel with it, and a one-plane pixel only where the side there, from the exact winding, is that
    // sign (gwnModelCov); the rest it integrates exactly. One probe is not enough: a pentagram drawn as one even-odd path
    // (_cnstar) crosses each edge AT its midpoint, both of its lines read "no boundary" there, and the kernel would drop
    // them -- 0 where the exact coverage is 0.375. A change can still hide between the probes (rare: mostly at the ends of
    // a loop cubic's pieces), and the kernel's check of the nearest piece's side is what catches it.
    {
      const X = [];
      for (const sg of segs) {
        if (sg.type !== SEG_ARC) {
          X.push(sg);
          continue;
        }
        const rq = arcToRQuads(sg);
        // a degenerate ellipse (a zero radius) has no rational form; it runs along the chord between its ends, which is
        // what its crossings are
        if (rq.length)
          for (const r of rq)
            X.push({ type: SEG_RQUAD, p1: r.P[0], p2: r.P[1], p3: r.P[2], w: r.w });
        else X.push({ type: SEG_LINE, p1: sg.p1, p2: sg.p4 });
      }
      const tree = buildSegWindingTree(X, raySegCrossExact);
      const inFill = (x, y) => {
        const w = tree ? treeWinding(tree, x, y) : rayWindingExact(X, x, y);
        return evenOdd ? (w & 1) !== 0 : w !== 0;
      };
      // +1 ink left of travel, -1 right, 0 both or neither; null where the piece has no direction at t
      const sideAt = (ev, t) => {
        const [x, y, dx, dy] = ev(t),
          L = 0.5 * Math.hypot(dx, dy);
        // A piece whose probes could not leave its own point -- the hair under ~2^10 float64 ulps of its coordinates, a
        // quarter of a float32 ulp of span -- has no direction to take a side across: a closing line between two ends
        // that differ only by rounding, or a cusp's stationary point. Anything longer is a boundary the kernel can see
        // at some zoom, and keeps its side.
        if (!(L > 2 ** -26 * Math.max(Math.abs(x), Math.abs(y)))) return null;
        const d = 2 ** -17,
          nx = -dy * d,
          ny = dx * d; // left of travel, 2^-16 L away (|(dx, dy)| is 2L)
        const inL = inFill(x + nx, y + ny),
          inR = inFill(x - nx, y - ny);
        return inL === inR ? 0 : inL ? 1 : -1;
      };

      const crossable = new Uint8Array(NP);
      {
        const ord = Array.from({ length: NP }, (_, i) => i).sort(
          (a, b) => pieces[a].bb[0] - pieces[b].bb[0],
        );
        const same = (u, v) => u[0] === v[0] && u[1] === v[1];
        let budget = 64 * NP;
        sweep: for (let a = 0; a < NP; a++) {
          const i = ord[a],
            A = pieces[i];
          if (A.lp) crossable[i] = 1;
          for (let b = a + 1; b < NP; b++) {
            const j = ord[b],
              B = pieces[j];
            if (!(B.bb[0] <= A.bb[2])) break;
            if (--budget < 0) {
              crossable.fill(1);
              break sweep;
            }
            if (B.bb[1] > A.bb[3] || B.bb[3] < A.bb[1]) continue;
            // two pieces of one curve split where it runs on smoothly meet only there (a loop is `lp`); pieces at a
            // joint between segments can meet again -- a spike out and back crosses its own neighbor
            if (
              (same(A.e, B.s) && A.sm & 2 && B.sm & 1) ||
              (same(A.s, B.e) && A.sm & 1 && B.sm & 2)
            )
              continue;
            crossable[i] = crossable[j] = 1;
          }
        }
      }
      for (let k = 0; k < NP; k++) {
        const p = pieces[k];
        p.sigma = 0;
        if (!p.ev) continue;
        const sM = sideAt(p.ev, 0.5),
          sA = crossable[k] ? sideAt(p.ev, 0.25) : null,
          sB = crossable[k] ? sideAt(p.ev, 0.75) : null;
        const got = [sM, sA, sB].filter((v) => v !== null);
        if (!got.length) continue; // no direction anywhere: no side, and so no ramp
        const one = got.every((v) => v === got[0]);
        const sgn = sM || got.find((v) => v !== 0) || 0;
        p.sigma = one ? got[0] : 2 * sgn; // mixed: +-2 (a mix of 0s and one sign carries that sign)
      }
    }
    // A TEST HOOK (read only under __MANTLE_DEBUG__): every piece with the ink side it was given, and the segments it
    // came from.
    {
      const hook = mantleDebugHook('__GWN_SIGMA_AUDIT');
      if (hook) hook(pieces, segs, evenOdd);
    }

    // Nodes are emitted in DFS PREORDER with ESCAPE links (internal code = the index to jump
    // to when the subtree is skipped), so the internal code is a single index ≤ nodeCount —
    // no left*4096+right packing, no 4095-node cap, no adaptive leaf growth.
    const LEAF_MAX = 4;
    const nodes = []; // {s,e,cx,cy,r,leaf,l,rt,refStart,refCount}
    const refs = []; // [hx, hy, type, inkSide]
    const build = (i, j) => {
      // piece run [i, j)
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let k = i; k < j; k++) {
        const bb = pieces[k].bb;
        x0 = Math.min(x0, bb[0]);
        y0 = Math.min(y0, bb[1]);
        x1 = Math.max(x1, bb[2]);
        y1 = Math.max(y1, bb[3]);
      }
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
      const r = Math.hypot(x1 - x0, y1 - y0) / 2;
      const node = {
        s: pieces[i].s,
        e: pieces[j - 1].e,
        cx,
        cy,
        r,
        leaf: 0,
        l: 0,
        rt: 0,
        refStart: 0,
        refCount: 0,
      };
      const idx = nodes.length;
      nodes.push(node);
      if (j - i <= LEAF_MAX) {
        // refs holds FOUR floats per entry (hx, hy, type, INK SIDE) and the shader indexes it by
        // TEXEL, so the start must be divided by 4. Getting this wrong makes every leaf read
        // garbage segments (or none), and the far-field chords then paper over most of the damage.
        node.leaf = 1;
        node.refStart = refs.length / 4;
        node.refCount = j - i;
        // The type texel carries the smooth-end flags above the type: type + 16 * (bit0 start | bit1 end).
        for (let k = i; k < j; k++)
          refs.push(
            pieces[k].hx,
            pieces[k].hy,
            pieces[k].ty + 16 * ((pieces[k].sm | 0) & 3),
            pieces[k].sigma,
          );
      } else {
        const mid = (i + j) >> 1;
        node.l = build(i, mid);
        node.rt = build(mid, j);
      }
      return idx;
    };
    // PER-CONTOUR FORESTS, chained under synthetic CONTAINER nodes. A node's far-field
    // collapse (its chord stands in for the whole run) is only exact for a CONTIGUOUS run of
    // one contour — a node straddling two contours telescopes across the gap between them and
    // miscounts the winding. Containers carry a DEGENERATE chord (s == e), whose crossing/
    // subtended angle is exactly zero — correct, because a far pixel's winding from an
    // entirely-contained set of CLOSED contours is exactly zero. No shader special-case.
    const contourStart = [];
    {
      let s0 = 0;
      for (let k = 0; k < NP; k++) {
        if (k > s0) {
          if (!pointsMeet(pieces[k - 1].e, pieces[k].s, pieces[k - 1].mag, pieces[k].mag)) {
            contourStart.push(s0);
            s0 = k;
          }
        }
      }
      contourStart.push(s0);
    }
    let roots = contourStart.map((s, ci) =>
      build(s, ci + 1 < contourStart.length ? contourStart[ci + 1] : NP),
    );
    while (roots.length > 1) {
      const next = [];
      for (let k = 0; k + 1 < roots.length; k += 2) {
        const a = nodes[roots[k]],
          b = nodes[roots[k + 1]];
        const cx = (a.cx + b.cx) / 2,
          cy = (a.cy + b.cy) / 2;
        const r = Math.max(
          Math.hypot(a.cx - cx, a.cy - cy) + a.r,
          Math.hypot(b.cx - cx, b.cy - cy) + b.r,
        );
        const node = {
          s: [cx, cy],
          e: [cx, cy],
          cx,
          cy,
          r,
          leaf: 0,
          l: roots[k],
          rt: roots[k + 1],
          refStart: 0,
          refCount: 0,
        };
        next.push(nodes.length);
        nodes.push(node);
      }
      if (roots.length & 1) next.push(roots[roots.length - 1]);
      roots = next;
    }
    // Flatten to DFS PREORDER with ESCAPE links: a node's left child is implicitly the next
    // index, and an internal node stores the index PAST its subtree. The shader traversal
    // becomes a single linear cursor — no stack (an int[48] array in the fragment shader is
    // local-memory traffic and an occupancy tax), no depth cap, no dropped-subtree escape
    // hatch when the stack fills.
    const flat = [];
    const flatten = (oi) => {
      const n = nodes[oi];
      flat.push(n);
      if (!n.leaf) {
        flatten(n.l);
        flatten(n.rt);
        n.escape = flat.length;
      }
    };
    flatten(roots[0]);
    // The header texel was reserved with the band headers (see above).
    // Nodes pack into TWO texels (the descent is fetch-bound; this is 1/3 fewer):
    //   A = (s.x, s.y, e.x, e.y) chord; B = (cx, cy, r, code) with
    //   code >= 0: internal, the PREORDER ESCAPE index (jump target when skipping the subtree);
    //   code <  0: leaf, -(refStart * 64 + refCount + 1); a skipped leaf's escape is index + 1.
    gwnHeaderSlot = vBase + bandsX * headerSlotsPerBand;
    const nodeBase = bandBuf.count - glyphLocIdx;
    for (const n of flat) {
      texelAppend(bandBuf, n.s[0], n.s[1], n.e[0], n.e[1]);
      const code = n.leaf ? -(n.refStart * 64 + n.refCount + 1) : n.escape;
      texelAppend(bandBuf, n.cx, n.cy, n.r, code);
    }
    const refBase = bandBuf.count - glyphLocIdx;
    for (let k = 0; k < refs.length; k += 4)
      texelAppend(bandBuf, refs[k], refs[k + 1], refs[k + 2], refs[k + 3]);
    // ---- EARLY-EXIT EXTENSION (tiers 2 + 3) --------------------------------------------
    // One EXT texel sits at the deterministic slot refBase + refCount:
    //   (rootBandBase, bandCount GB, gridBase, gridW * 256 + gridH)   (0 = section absent)
    // followed by the sections it points to. Appended, so readers of the layout without
    // it are untouched.
    const extSlot = bandBuf.count; // absolute; written after sections
    texelAppend(bandBuf, 0, 0, 0, 0);
    let rbBase = 0,
      GB = 0,
      gridBase = 0,
      gridW = 0,
      gridH = 0;
    // The box the grid and the tier-2 bands divide, formed exactly as the kernel forms it (_coverage.glsl gwnBoxSize):
    // a zero extent borrows the other, a point uses 1. Any other floor here (max(extent, 1e-9), say, against 1e-6 in the
    // kernel) would let a shape under the floor find its cells in a different box from the one they were built in.
    const extW = bbX1 - bbX0,
      extH = bbY1 - bbY0;
    const bbW = extW > 0 ? extW : extH > 0 ? extH : 1,
      bbH = extH > 0 ? extH : extW > 0 ? extW : 1;
    // The certified polyline is closed at every joint. Two pieces that meet (pointsMeet, as the contours above were
    // found) can store their shared vertex a rounding apart -- two arcs rebuilt from their center form end at
    // (50, 29.999999999999996) and start at (50, 30.000000000000007) -- and the grid's exact ray crossing slips
    // through that gap: a cell centered on y = 30 (the middle row of any symmetric shape) would certify the winding
    // outside the fill for a whole row of cells. So the next piece's first sub-chord starts where the last one ended,
    // its pad grown by the move.
    {
      const snap = (k, j) => {
        const P = pieces[k],
          Q = pieces[j];
        if (
          !(Q.pb > Q.pa) ||
          (P.e[0] === Q.s[0] && P.e[1] === Q.s[1]) ||
          !pointsMeet(P.e, Q.s, P.mag, Q.mag)
        )
          return;
        const i = Q.pa * 5,
          d = Math.hypot(polySegs[i] - P.e[0], polySegs[i + 1] - P.e[1]);
        polySegs[i] = P.e[0];
        polySegs[i + 1] = P.e[1];
        polySegs[i + 4] += d;
      };
      for (let ci = 0; ci < contourStart.length; ci++) {
        const a = contourStart[ci],
          b = ci + 1 < contourStart.length ? contourStart[ci + 1] : NP;
        for (let k = a; k + 1 < b; k++) snap(k, k + 1);
        if (b - a > 1) snap(b - 1, a); // the contour's closing joint
      }
    }
    // TIER 3 first and UNGATED: the occupancy grid is the interior-pixel fix (one fetch
    // replaces the whole walk), and interior-heavy large draws of SIMPLE shapes are exactly
    // where GWN lost to AAC — a piece-count gate would exempt them. ~128 texels + a small
    // build pass; cells near the boundary just stay undecided.
    {
      const NS = polySegs.length / 5;
      if (NS > 0) {
        const asp = Math.sqrt(bbW / bbH);
        gridW = Math.max(2, Math.min(64, Math.round(_GWN_GRID_BASE * asp)));
        gridH = Math.max(2, Math.min(64, Math.round(_GWN_GRID_BASE / asp)));
        gridBase = bandBuf.count - glyphLocIdx;
        const gridAbsTexel = bandBuf.count; // absolute band texel of cell 0
        if (deferTier3Out) {
          // Reserve the exact same texel count, zeroed (margin 0 ⇒ dormant), and
          // hand the build inputs to the idle pass. polySegs is copied because the
          // shared bandBuf/geometry churns as later shapes bake.
          const nTexels = Math.ceil((gridW * gridH) / 2);
          for (let i = 0; i < nTexels; i++) texelAppend(bandBuf, 0, 0, 0, 0);
          deferTier3Out.push({
            absTexel: gridAbsTexel,
            gridW,
            gridH,
            bbX0,
            bbY0,
            bbW,
            bbH,
            polySegs: polySegs.slice(),
          });
        } else {
          const cells = computeGwnOccupancyCells(polySegs, bbX0, bbY0, bbW, bbH, gridW, gridH);
          for (let i = 0; i < gridW * gridH; i += 2) {
            texelAppend(
              bandBuf,
              cells[i * 2],
              cells[i * 2 + 1],
              i + 1 < gridW * gridH ? cells[i * 2 + 2] : 0,
              i + 1 < gridW * gridH ? cells[i * 2 + 3] : 0,
            );
          }
        }
      }
    }
    if (NP >= 16) {
      // TIER 2: y-banded, x-sorted CUT lists — the Slug band early-exit transplanted onto the
      // tree. The cut is a frontier partition (~K subtree roots, largest radius split first);
      // winding is a +x-ray crossing count, and every chord and lune of a run lies inside its
      // circle, so a run whose circle is off the pixel's row or entirely left of it
      // contributes exactly zero — banding by y and breaking on sorted maxX skips only zeros.
      const esc = (i) => (flat[i].leaf ? i + 1 : flat[i].escape);
      const cut = [0];
      const K = Math.min(96, Math.max(16, Math.ceil(flat.length / 8)));
      while (cut.length < K) {
        let bi = -1,
          br = -1;
        for (let q = 0; q < cut.length; q++) {
          const n = flat[cut[q]];
          if (!n.leaf && n.r > br) {
            br = n.r;
            bi = q;
          }
        }
        if (bi < 0) break;
        const i = cut[bi];
        cut.splice(bi, 1, i + 1, esc(i + 1));
      }
      GB = Math.max(2, Math.min(32, Math.ceil(cut.length / 4)));
      const bandH = bbH / GB;
      const bandLists = Array.from({ length: GB }, () => []);
      for (const i of cut) {
        const n = flat[i];
        const y0 = n.cy - n.r,
          y1 = n.cy + n.r,
          mx = n.cx + n.r;
        const bLo = Math.max(0, Math.floor((y0 - bbY0) / bandH));
        const bHi = Math.min(GB - 1, Math.floor((y1 - bbY0) / bandH));
        // adjacency flags (prev/next band membership) are ENCODE-TIME truth — the kernel's
        // neighbor-band dedupe must not re-derive membership from f32 band arithmetic
        for (let b = bLo; b <= bHi; b++) {
          bandLists[b].push({ ni: i, mx, y0, y1, fl: (b > bLo ? 2 : 0) + (b < bHi ? 1 : 0) });
        }
      }
      rbBase = bandBuf.count - glyphLocIdx;
      const rbSlot = bandBuf.count; // ceil(GB/2) header texels, 2 bands each
      for (let i = 0; i < Math.ceil(GB / 2); i++) texelAppend(bandBuf, 0, 0, 0, 0);
      const bandHdr = new Float64Array(GB * 2);
      for (let b = 0; b < GB; b++) {
        const list = bandLists[b].sort((p, q) => q.mx - p.mx); // desc maxX: sorted break
        bandHdr[b * 2] = bandBuf.count - glyphLocIdx;
        bandHdr[b * 2 + 1] = list.length;
        for (const e of list) texelAppend(bandBuf, e.ni * 4 + e.fl, e.mx, e.y0, e.y1);
      }
      for (let b = 0; b < GB; b += 2) {
        texelSet(
          bandBuf,
          rbSlot + b / 2,
          bandHdr[b * 2],
          bandHdr[b * 2 + 1],
          b + 1 < GB ? bandHdr[b * 2 + 2] : 0,
          b + 1 < GB ? bandHdr[b * 2 + 3] : 0,
        );
      }
    }
    texelSet(
      bandBuf,
      extSlot,
      rbBase,
      GB > 0 && rbBase > 0 ? GB : 0,
      gridBase,
      gridW * 256 + gridH,
    );

    // The shape-wide shoelace sign is still written to the header: it is the fallback the kernel
    // uses for any piece whose per-piece sign is missing (0).
    let area2 = 0;
    for (let k = 0; k < NP; k++) {
      const a = pieces[k].s,
        b = pieces[k].e;
      area2 += a[0] * b[1] - a[1] * b[0];
    }
    const orient = area2 >= 0 ? 1 : -1;
    texelSet(bandBuf, gwnHeaderSlot, nodeBase, orient * nodes.length, refBase, refs.length / 4);
  }

  return {
    glyphLoc: [glyphLocX, glyphLocY],
    /// For the meta's miter limit: see maxMiterRatio above. The CALLER clamps it to the declared
    /// limit -- a shape may well turn harder than its limit allows. Those joins bevel between two
    /// line segments and still draw round where a curve takes part (see metaMiterLimit).
    maxMiterRatio,
    bandMaxX: bandsX - 1,
    bandMaxY: bandsY - 1,
    bbox: bbox.slice(),
    numSegments: segs.length,
    typeMask,
    curveEndF, // the shape's curves end HERE; the GWN tree lives past it
    gwnNodes: gwnHeaderSlot >= 0 ? 1 : 0,
    gwnUnsafe, // the tree holds a self-closing cubic, loop or cusp (see the piece expansion)
    dashSeam: anySeam,
    dashSeamFree: anyFree, // a closed dashed contour wrote its length into its seam segments (the row gets FS_DASH_SEAM)
  };
}
