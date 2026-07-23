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
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  segStart, segEnd,
} from './segment.js';
import { segBboxInto } from './bbox.js';
// Pure cubic math for the GWN run tree's piece expansion (no GL, no module state).
import { cubicKLMN, cubicInflections, cubicLoopParams, splitCubic, splitCubicMulti } from '../renderer/lbCubicMath.js';
import { solveCubic } from './pathBoolean/polyRoots.js';

const TEXTURE_WIDTH = 4096;

export function makeTexelBuffer() {
  // Float64Array-backed growable buffer. Each texel occupies 4 floats
  // at index (texelIdx*4 .. texelIdx*4+3). texelToBytes downcasts to
  // f32 for the wire format. Flat storage (vs an [r,g,b,a] sub-array
  // per texel) avoids per-texel allocation.
  return {
    floats: new Float64Array(1024),
    count: 0,
    capacity: 256, // texels (i.e. floats.length / 4)
  };
}

export function texelEnsure(buf, needTexels) {
  if (needTexels <= buf.capacity) return;
  let cap = buf.capacity;
  while (cap < needTexels) cap *= 2;
  const grown = new Float64Array(cap * 4);
  grown.set(buf.floats);
  buf.floats = grown;
  buf.capacity = cap;
}

export function texelAppend(buf, r, g, b, a) {
  const idx = buf.count;
  texelEnsure(buf, idx + 1);
  const o = idx * 4;
  buf.floats[o]   = r;
  buf.floats[o+1] = g;
  buf.floats[o+2] = b;
  buf.floats[o+3] = a;
  buf.count = idx + 1;
  return idx;
}

export function texelSet(buf, texelIdx, r, g, b, a) {
  texelEnsure(buf, texelIdx + 1);
  const o = texelIdx * 4;
  buf.floats[o]   = r;
  buf.floats[o+1] = g;
  buf.floats[o+2] = b;
  buf.floats[o+3] = a;
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
// the hit test compute the within-segment length L(t) the SAME way, so
// dash boundaries stay continuous across segment seams and exact on curves.
export function segArcLen(s) {
  return _segLenAt(s, 1);
}

// Encode one segment record (header + data texels + join tangents). Returns
// the header texel index.
// startDist: cumulative arc-length from subpath start (0 if dashing disabled).
export const kJoinReachInf = 1e9;
export function encodeSeg(seg, curveBuf, freeStart, freeEnd, inTan, outTan, startDist = 0,
                          startPrevReach = kJoinReachInf, endNextReach = kJoinReachInf, curv = null) {
  let segType = seg.type & 3;
  if (seg.is_fill_only) segType += 4;
  const hdr = texelAppend(curveBuf,
    segType, freeStart ? 1 : 0, freeEnd ? 1 : 0, startDist);
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
    texelAppend(curveBuf, seg.theta_start, seg.theta_end, seg.phi, 0);
  }
  // Join texel: (inTan.x, inTan.y, outTan.x, outTan.y). Zero vectors = free.
  texelAppend(curveBuf, inTan[0], inTan[1], outTan[0], outTan[1]);
  // Arcs-join curvature texel — only emitted when the stroke uses
  // stroke-linejoin:arcs. (kSelfStart, kSelfEnd, kPrevEnd, kNextStart) signed
  // centerline curvatures at the join. Appended AFTER the join texel so every
  // existing reader's offsets are unchanged; only the arcs branch reads it.
  if (curv) texelAppend(curveBuf, curv[0], curv[1], curv[2], curv[3]);
  return hdr;
}

export function segTangentAt(s, atStart) {
  const t = atStart ? 0 : 1;
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0]; dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const mt = 1 - t;
    dx = 2*mt*(s.p2[0]-s.p1[0]) + 2*t*(s.p3[0]-s.p2[0]);
    dy = 2*mt*(s.p2[1]-s.p1[1]) + 2*t*(s.p3[1]-s.p2[1]);
    // SVG "s" / "t" continuation cubics often emit p2 == p1, making
    // the standard derivative zero at t=0. Fall back to the chord
    // direction so the miter geometry has a defined tangent.
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = s.p3[0] - s.p1[0];
      dy = s.p3[1] - s.p1[1];
    }
  } else if (s.type === SEG_CUBIC) {
    const mt = 1 - t;
    dx = 3*mt*mt*(s.p2[0]-s.p1[0]) + 6*mt*t*(s.p3[0]-s.p2[0]) + 3*t*t*(s.p4[0]-s.p3[0]);
    dy = 3*mt*mt*(s.p2[1]-s.p1[1]) + 6*mt*t*(s.p3[1]-s.p2[1]) + 3*t*t*(s.p4[1]-s.p3[1]);
    // SVG "s" continuation cubic at t=0 often has p2 == p1, making
    // the derivative zero. Fall back to the second-order term
    // 6*(p3-p2), then to the chord direction (p4-p1).
    if (Math.hypot(dx, dy) < 1e-9) {
      if (atStart) {
        dx = s.p3[0] - s.p2[0]; dy = s.p3[1] - s.p2[1];
        if (Math.hypot(dx, dy) < 1e-9) {
          dx = s.p4[0] - s.p1[0]; dy = s.p4[1] - s.p1[1];
        }
      } else {
        // At t=1, fall back to (p4-p3) (already in primary), then chord.
        dx = s.p3[0] - s.p2[0]; dy = s.p3[1] - s.p2[1];
        if (Math.hypot(dx, dy) < 1e-9) {
          dx = s.p4[0] - s.p1[0]; dy = s.p4[1] - s.p1[1];
        }
      }
    }
  } else if (s.type === SEG_ARC) {
    const theta = atStart ? s.theta_start : s.theta_end;
    const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp*s.rx*st - sp*s.ry*ct) * dth;
    dy = (-sp*s.rx*st + cp*s.ry*ct) * dth;
  } else {
    return [0, 0];
  }
  const mag = Math.hypot(dx, dy);
  if (mag < 1e-12) return [0, 0];
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
    if (atStart) { d1x = 2 * (s.p2[0] - s.p1[0]); d1y = 2 * (s.p2[1] - s.p1[1]); }
    else         { d1x = 2 * (s.p3[0] - s.p2[0]); d1y = 2 * (s.p3[1] - s.p2[1]); }
    d2x = 2 * (s.p1[0] - 2 * s.p2[0] + s.p3[0]);
    d2y = 2 * (s.p1[1] - 2 * s.p2[1] + s.p3[1]);
  } else if (s.type === SEG_CUBIC) {
    if (atStart) {
      d1x = 3 * (s.p2[0] - s.p1[0]); d1y = 3 * (s.p2[1] - s.p1[1]);
      d2x = 6 * (s.p1[0] - 2 * s.p2[0] + s.p3[0]);
      d2y = 6 * (s.p1[1] - 2 * s.p2[1] + s.p3[1]);
    } else {
      d1x = 3 * (s.p4[0] - s.p3[0]); d1y = 3 * (s.p4[1] - s.p3[1]);
      d2x = 6 * (s.p2[0] - 2 * s.p3[0] + s.p4[0]);
      d2y = 6 * (s.p2[1] - 2 * s.p3[1] + s.p4[1]);
    }
  } else if (s.type === SEG_ARC) {
    const theta = atStart ? s.theta_start : s.theta_end;
    const st = Math.sin(theta), ct = Math.cos(theta);
    const denom = Math.pow(s.rx * s.rx * st * st + s.ry * s.ry * ct * ct, 1.5);
    if (denom < 1e-12) return 0;
    // Rotation phi preserves curvature; sign follows the sweep direction.
    const dth = s.theta_end - s.theta_start;
    return Math.sign(dth) * (s.rx * s.ry) / denom;
  } else {
    return 0;
  }
  const d1mag = Math.hypot(d1x, d1y);
  if (d1mag < 1e-9) return 0;              // cusp / degenerate → treat as straight
  return (d1x * d2y - d1y * d2x) / (d1mag * d1mag * d1mag);
}

// Non-allocating overload of segTangentAt: writes (tx, ty) at
// out[off], out[off+1]. Hot in buildTexturesShape, where the per-seg
// 2-element-array result of segTangentAt would otherwise pile up.
export function segTangentAtInto(s, atStart, out, off) {
  const t = atStart ? 0 : 1;
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0]; dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const mt = 1 - t;
    dx = 2*mt*(s.p2[0]-s.p1[0]) + 2*t*(s.p3[0]-s.p2[0]);
    dy = 2*mt*(s.p2[1]-s.p1[1]) + 2*t*(s.p3[1]-s.p2[1]);
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = s.p3[0] - s.p1[0];
      dy = s.p3[1] - s.p1[1];
    }
  } else if (s.type === SEG_CUBIC) {
    const mt = 1 - t;
    dx = 3*mt*mt*(s.p2[0]-s.p1[0]) + 6*mt*t*(s.p3[0]-s.p2[0]) + 3*t*t*(s.p4[0]-s.p3[0]);
    dy = 3*mt*mt*(s.p2[1]-s.p1[1]) + 6*mt*t*(s.p3[1]-s.p2[1]) + 3*t*t*(s.p4[1]-s.p3[1]);
    if (Math.hypot(dx, dy) < 1e-9) {
      dx = s.p3[0] - s.p2[0]; dy = s.p3[1] - s.p2[1];
      if (Math.hypot(dx, dy) < 1e-9) {
        dx = s.p4[0] - s.p1[0]; dy = s.p4[1] - s.p1[1];
      }
    }
  } else if (s.type === SEG_ARC) {
    const theta = atStart ? s.theta_start : s.theta_end;
    const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp*s.rx*st - sp*s.ry*ct) * dth;
    dy = (-sp*s.rx*st + cp*s.ry*ct) * dth;
  } else {
    out[off] = 0; out[off+1] = 0; return;
  }
  const mag = Math.hypot(dx, dy);
  if (mag < 1e-12) { out[off] = 0; out[off+1] = 0; return; }
  out[off]   = dx / mag;
  out[off+1] = dy / mag;
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
    return [s.p1[0] + (s.p2[0] - s.p1[0]) * t,
            s.p1[1] + (s.p2[1] - s.p1[1]) * t];
  }
  if (s.type === SEG_QUAD) {
    const u = 1 - t;
    return [u*u*s.p1[0] + 2*u*t*s.p2[0] + t*t*s.p3[0],
            u*u*s.p1[1] + 2*u*t*s.p2[1] + t*t*s.p3[1]];
  }
  if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    return [u*u*u*s.p1[0] + 3*u*u*t*s.p2[0] + 3*u*t*t*s.p3[0] + t*t*t*s.p4[0],
            u*u*u*s.p1[1] + 3*u*u*t*s.p2[1] + 3*u*t*t*s.p3[1] + t*t*t*s.p4[1]];
  }
  if (s.type === SEG_ARC) {
    const theta = s.theta_start + (s.theta_end - s.theta_start) * t;
    const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    return [s.cx + cp*s.rx*ct - sp*s.ry*st,
            s.cy + sp*s.rx*ct + cp*s.ry*st];
  }
  return [0, 0];
}

export function _segTangentAtT(s, t) {
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0]; dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const u = 1 - t;
    dx = 2*u*(s.p2[0]-s.p1[0]) + 2*t*(s.p3[0]-s.p2[0]);
    dy = 2*u*(s.p2[1]-s.p1[1]) + 2*t*(s.p3[1]-s.p2[1]);
  } else if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    dx = 3*u*u*(s.p2[0]-s.p1[0]) + 6*u*t*(s.p3[0]-s.p2[0]) + 3*t*t*(s.p4[0]-s.p3[0]);
    dy = 3*u*u*(s.p2[1]-s.p1[1]) + 6*u*t*(s.p3[1]-s.p2[1]) + 3*t*t*(s.p4[1]-s.p3[1]);
  } else if (s.type === SEG_ARC) {
    const theta = s.theta_start + (s.theta_end - s.theta_start) * t;
    const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp*s.rx*st - sp*s.ry*ct) * dth;
    dy = (-sp*s.rx*st + cp*s.ry*ct) * dth;
  } else {
    return [1, 0];
  }
  const mag = Math.hypot(dx, dy);
  if (mag < 1e-12) return [1, 0];
  return [dx / mag, dy / mag];
}

// 16-point Gauss–Legendre on [0,1]: nodes and weights. Exact for
// polynomials up to degree 31; rms speed-integrand error for a sqrt of
// a degree-4 polynomial is < 1e-12 in practice.
const _GL16_NODES = [
  0.005299532504175033, 0.027712488463383711, 0.067184398806084128,
  0.122297795822498470, 0.191061877798678115, 0.270991611171386573,
  0.359198224610370696, 0.452493745081181231, 0.547506254918818769,
  0.640801775389629304, 0.729008388828613427, 0.808938122201321885,
  0.877702204177501530, 0.932815601193915872, 0.972287511536616289,
  0.994700467495824967,
];
const _GL16_WEIGHTS = [
  0.013576229705877047, 0.031126761969323946, 0.047579255841246392,
  0.062314485627766936, 0.074797994408288365, 0.084578259697501269,
  0.091301707522461794, 0.094725305227534248, 0.094725305227534248,
  0.091301707522461794, 0.084578259697501269, 0.074797994408288365,
  0.062314485627766936, 0.047579255841246392, 0.031126761969323946,
  0.013576229705877047,
];

// |p'(t)| for any seg type — exact analytic derivative magnitude.
export function _segSpeed(s, t) {
  let dx, dy;
  if (s.type === SEG_LINE) {
    dx = s.p2[0] - s.p1[0]; dy = s.p2[1] - s.p1[1];
  } else if (s.type === SEG_QUAD) {
    const u = 1 - t;
    dx = 2*u*(s.p2[0]-s.p1[0]) + 2*t*(s.p3[0]-s.p2[0]);
    dy = 2*u*(s.p2[1]-s.p1[1]) + 2*t*(s.p3[1]-s.p2[1]);
  } else if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    dx = 3*u*u*(s.p2[0]-s.p1[0]) + 6*u*t*(s.p3[0]-s.p2[0]) + 3*t*t*(s.p4[0]-s.p3[0]);
    dy = 3*u*u*(s.p2[1]-s.p1[1]) + 6*u*t*(s.p3[1]-s.p2[1]) + 3*t*t*(s.p4[1]-s.p3[1]);
  } else if (s.type === SEG_ARC) {
    const theta = s.theta_start + (s.theta_end - s.theta_start) * t;
    const cp = Math.cos(s.phi), sp = Math.sin(s.phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const dth = s.theta_end - s.theta_start;
    dx = (-cp*s.rx*st - sp*s.ry*ct) * dth;
    dy = (-sp*s.rx*st + cp*s.ry*ct) * dth;
  } else {
    return 0;
  }
  return Math.hypot(dx, dy);
}

// Closed-form line and quad arc-length from 0 to t.
export function _lineLenAt(s, t) {
  return Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) * t;
}
// Quadratic Bézier arc-length: p'(t) = 2((1-t)(P1-P0) + t(P2-P1)).
// |p'(t)|² = a t² + b t + c, then ∫√(at²+bt+c) dt has closed form.
export function _quadLenAt(s, t) {
  const ax = s.p1[0] - 2*s.p2[0] + s.p3[0];
  const ay = s.p1[1] - 2*s.p2[1] + s.p3[1];
  const bx = s.p2[0] - s.p1[0];
  const by = s.p2[1] - s.p1[1];
  // p'(t)/2 = (a t + b)  ⇒  |p'(t)|² = 4(A t² + B t + C)
  const A = ax*ax + ay*ay;
  const B = 2*(ax*bx + ay*by);
  const C = bx*bx + by*by;
  // Degenerate: nearly a straight line (A ≈ 0). Fall back to chord.
  if (A < 1e-12) {
    return Math.hypot(s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]) * t;
  }
  // ∫√(At²+Bt+C) dt at t. Standard antiderivative:
  //   F(t) = ((2At+B) * sqrt(At²+Bt+C)) / (4A)
  //        + ((4AC - B²) / (8A^{3/2})) * ln(2√A·√(At²+Bt+C) + 2At + B)
  // Multiplied by 2 because |p'(t)| = 2√(A t²+B t+C).
  function F(tt) {
    const u = A*tt*tt + B*tt + C;
    if (u < 0) return 0; // numerical safety
    const sqrtU = Math.sqrt(u);
    const sqrtA = Math.sqrt(A);
    const term1 = ((2*A*tt + B) * sqrtU) / (4*A);
    const disc = 4*A*C - B*B;
    const arg = 2*sqrtA*sqrtU + 2*A*tt + B;
    const term2 = (arg > 1e-12) ? (disc / (8 * Math.pow(A, 1.5))) * Math.log(arg) : 0;
    return 2 * (term1 + term2);
  }
  return F(t) - F(0);
}

// Gauss–Legendre 16-point arc-length integration on [0, t].
export function _glLenAt(s, t) {
  // Substitute u = t * x, du = t dx, integrate ∫₀^t |p'(u)| du
  //   = t · ∫₀¹ |p'(t·x)| dx
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    sum += _GL16_WEIGHTS[i] * _segSpeed(s, t * _GL16_NODES[i]);
  }
  return t * sum;
}

export function _segLenAt(s, t) {
  if (t <= 0) return 0;
  if (s.type === SEG_LINE)  return _lineLenAt(s, t);
  if (s.type === SEG_QUAD)  return _quadLenAt(s, t);
  // Cubics + arcs: Gauss–Legendre 16.
  return _glLenAt(s, t);
}
const _segLenTotal = (s) => _segLenAt(s, 1);

// Solve _segLenAt(s, t) = sTarget for t ∈ [0, 1] via clamped Newton.
// L'(t) = |p'(t)| ≥ 0, so Newton converges monotonically. We seed from
// the proportional ratio sTarget / total — close to truth for moderate
// curvature, and the clamp keeps us inside [0, 1] even if a Newton
// step overshoots.
export function _segLenInvert(s, sTarget, total) {
  if (sTarget <= 0) return 0;
  if (sTarget >= total) return 1;
  if (s.type === SEG_LINE) return sTarget / total;
  // Proportional seed.
  let t = sTarget / total;
  for (let iter = 0; iter < 8; iter++) {
    const L = _segLenAt(s, t);
    const dL = _segSpeed(s, t);
    if (dL < 1e-12) break;
    const dt = (sTarget - L) / dL;
    let tNext = t + dt;
    if (tNext < 0) tNext = 0;
    else if (tNext > 1) tNext = 1;
    if (Math.abs(tNext - t) < 1e-9) { t = tNext; break; }
    t = tNext;
  }
  return t;
}

export function buildPathArcLengthLut(segs) {
  // Per-seg total length + running cumulative. Sampling at query
  // time is O(log nSegs) bracket search + O(8) Newton iters.
  const lens = new Float64Array(segs.length);
  const cum  = new Float64Array(segs.length + 1);
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
  let lo = 0, hi = lut.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lut.cum[mid + 1] <= s) lo = mid + 1; else hi = mid;
  }
  const segIdx = lo;
  const seg = lut.segs[segIdx];
  const localS = s - lut.cum[segIdx];
  const t = _segLenInvert(seg, localS, lut.lens[segIdx]);
  const p = _segPointAt(seg, t);
  const tan = _segTangentAtT(seg, t);
  return { x: p[0], y: p[1], tx: tan[0], ty: tan[1] };
}

// Filter degenerate segments, wire free-endpoint flags + neighbour tangents,
// write curve texels + single-band header entries. Returns meta fragment with
// glyphLoc / band maxima.
// `fillOnly` — when true, the produced curve buffer is read ONLY by the fill
// winding ray-cast (never the stroker), so the per-segment STROKE metadata —
// endpoint pairing (free ends / neighbours), join tangents, arc-length and
// dash start-distances — is unused and skipped. Texel COUNT and layout are
// unchanged (those fields are just left zero), so morph's deterministic
// per-shape size is preserved. Skips the O(N²) pairing + three O(N) passes,
// the dominant cost on fill-heavy assets. Callers building a fill-only curve
// range (the importer's fill emit, emitShape, updateBundleGeometry for an
// unstroked shape) pass true.
// GWN tier-3 grid base: cells ≈ base² per shape (square cells via sqrt(aspect)).
// 24 (up from 16) is the render/memory KNEE for tree-hard fills: it captures
// nearly the whole interior-skip win (−4% @1024, −8% @2048; probes/_gwnSize) at
// +16% band memory, whereas 32/48 buy ~1% more for +38%/+102%. Affordable now
// that the tier-3 build defers off the import path (async, see buildTexturesShape
// deferTier3Out) — the win is modest because tree-hard content is stroke-covered,
// so the stroke's fixed render cost dilutes the fill-skip.
const _GWN_GRID_BASE = 24;
// GWN tree TIER-3 occupancy cells. Pure (no GL, no buffers) so it runs BOTH in
// the synchronous bake and, for the async tree path, in a post-load idle pass
// off the render hot-path (see bundle.js _fillTreeGrids). Returns a Float64Array
// of gridW*gridH*2 = (wSum, margin) per cell. This is ~85% of the whole tree
// build (probes/_treeAB), so deferring it removes most of the tree-bake stall.
export function computeGwnOccupancyCells(polySegs, bbX0, bbY0, bbW, bbH, gridW, gridH) {
  const NS = polySegs.length / 5;
  const cw = bbW / gridW, ch = bbH / gridH;
  const halfDiag = Math.hypot(cw, ch) / 2;
  const cells = new Float64Array(gridW * gridH * 2);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = bbX0 + (gx + 0.5) * cw, cy = bbY0 + (gy + 0.5) * ch;
      let wSum = 0, dMin = Infinity;
      for (let s = 0; s < NS; s++) {
        const s5 = s * 5;
        const ax = polySegs[s5], ay = polySegs[s5 + 1];
        const bx = polySegs[s5 + 2], by = polySegs[s5 + 3], pad = polySegs[s5 + 4];
        const dx = bx - ax, dy = by - ay;
        // Nearest-approach distance for the certified margin. distSq + deferred
        // sqrt: a chord lowers dMin only if segDist < dMin + pad, i.e.
        // distSq < (dMin+pad)² — so the sqrt runs only on an actual min-update.
        let t = (dx * (cx - ax) + dy * (cy - ay)) / (dx * dx + dy * dy + 1e-30);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = cx - (ax + t * dx), qy = cy - (ay + t * dy);
        const distSq = qx * qx + qy * qy;
        const lim = dMin + pad;
        if (lim > 0 && distSq < lim * lim) { const d = Math.sqrt(distSq) - pad; if (d < dMin) dMin = d; }
        if ((ay < cy) !== (by < cy)) {
          const xi = ax + (cy - ay) / dy * dx;
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
export function buildTexturesShape(segs, bandsX, bandsY, bbox, curveBuf, bandBuf, strokePadEm = 0, fillOnly = false, emitCurvature = false, pairBands = false, gwnTree = false, deferTier3Out = null, evenOdd = false) {
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
  // Genuinely-invalid segs (NaN coordinates etc.) should be caught at
  // parse time, not here.

  const EP = 1e-5;
  const N = segs.length;

  // Flat parallel arrays for the pair-up + tangent + dash results. For a
  // fill-only buffer these stay zero (the fields they feed — header
  // free-ends/startDist, the join-tangent texel, quad reach — are stroke-only
  // and unread by the fill walk), and all the work below is skipped.
  const freeStart = new Uint8Array(N);
  const freeEnd   = new Uint8Array(N);
  const prevOf = new Int32Array(N);
  const nextOf = new Int32Array(N);
  const startTanF = new Float64Array(N * 2);
  const endTanF   = new Float64Array(N * 2);
  const segLens = new Float64Array(N);
  const startDists = new Float64Array(N);

  if (fillOnly) {
    prevOf.fill(-1);            // no neighbours → encodeSeg writes zero joins
    nextOf.fill(-1);
  } else {
    // Flatten endpoints (4 floats/seg: sx, sy, ex, ey) for the pairing loop.
    const endptF = new Float64Array(N * 4);
    for (let i = 0; i < N; i++) {
      const sp = segStart(segs[i]);
      const ep = segEnd(segs[i]);
      endptF[i*4]   = sp[0]; endptF[i*4+1] = sp[1];
      endptF[i*4+2] = ep[0]; endptF[i*4+3] = ep[1];
    }
    // Pairing is O(N²) per shape (semantics: last matching j wins) since the
    // hash-map shortcut isn't exact across the EP tolerance band. N is
    // per-shape and small in practice, so the quadratic is fine.
    for (let i = 0; i < N; i++) {
      const sx = endptF[i*4],   sy = endptF[i*4+1];
      const ex = endptF[i*4+2], ey = endptF[i*4+3];
      let startFree = 1, endFree = 1;
      let prev = -1, next = -1;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const jex = endptF[j*4+2], jey = endptF[j*4+3];
        if (Math.abs(jex - sx) < EP && Math.abs(jey - sy) < EP) { startFree = 0; prev = j; }
        const jsx = endptF[j*4],   jsy = endptF[j*4+1];
        if (Math.abs(jsx - ex) < EP && Math.abs(jsy - ey) < EP) { endFree   = 0; next = j; }
      }
      // A single segment whose own start meets its own end is a closed loop
      // (a full-circle/ellipse arc, or a self-closing curve): it joins itself at
      // the seam. Mark it non-free + self-neighbour so the stroke takes the
      // (tangent-continuous) join branch there instead of a cap — otherwise a
      // circle/ellipse would butt-cap-notch at the seam.
      if (startFree && endFree && Math.abs(sx - ex) < EP && Math.abs(sy - ey) < EP) {
        startFree = 0; endFree = 0; prev = i; next = i;
      }
      freeStart[i] = startFree;
      freeEnd[i]   = endFree;
      prevOf[i] = prev;
      nextOf[i] = next;
    }
    // Tangents (each seg's start at [2i], end at [2i+1]).
    for (let i = 0; i < N; i++) {
      segTangentAtInto(segs[i], true,  startTanF, i*2);
      segTangentAtInto(segs[i], false, endTanF,   i*2);
    }
    // Per-segment cumulative arc-length from the start of its subpath (for
    // stroke-dasharray): path distance at param t on seg i is
    // startDist[i] + t*segLen[i]. Walk forward from each free-start segment
    // following next-neighbour to honour traversal order regardless of index.
    for (let i = 0; i < N; i++) segLens[i] = segArcLen(segs[i]);
    const visited = new Uint8Array(N);
    for (let seed = 0; seed < N; seed++) {
      if (visited[seed] || !freeStart[seed]) continue;
      let cur = seed, accum = 0;
      while (cur >= 0 && !visited[cur]) {
        visited[cur] = 1;
        startDists[cur] = accum;
        accum += segLens[cur];
        cur = nextOf[cur];
      }
    }
    for (let seed = 0; seed < N; seed++) {
      if (visited[seed]) continue;
      let cur = seed, accum = 0;
      while (cur >= 0 && !visited[cur]) {
        visited[cur] = 1;
        startDists[cur] = accum;
        accum += segLens[cur];
        cur = nextOf[cur];
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
  for (let i = 0; i < N; i++) {
    const fs = freeStart[i] === 1;
    const fe = freeEnd[i] === 1;
    const pi = prevOf[i], ni = nextOf[i];
    if (pi >= 0) { inTBuf[0]  = endTanF[pi*2];   inTBuf[1]  = endTanF[pi*2+1]; }
    else         { inTBuf[0]  = 0;               inTBuf[1]  = 0; }
    if (ni >= 0) { outTBuf[0] = startTanF[ni*2]; outTBuf[1] = startTanF[ni*2+1]; }
    else         { outTBuf[0] = 0;               outTBuf[1] = 0; }
    const endNextReach = (ni >= 0 && freeEnd[ni] === 1) ? segLens[ni] : kJoinReachInf;
    const startPrevReach = (pi >= 0 && freeStart[pi] === 1) ? segLens[pi] : kJoinReachInf;
    segTypes[i] = segs[i].type;
    typeMask |= (1 << (segs[i].type & 3));
    // For stroke-linejoin:arcs, carry the signed centerline curvatures at the
    // join: this seg's own start/end, plus the neighbours' shared-vertex ends.
    let curv = null;
    if (emitCurvature) {
      curv = [
        segEndpointCurvature(segs[i], true),
        segEndpointCurvature(segs[i], false),
        pi >= 0 ? segEndpointCurvature(segs[pi], false) : 0,
        ni >= 0 ? segEndpointCurvature(segs[ni], true) : 0,
      ];
    }
    segHdrIdx.push(encodeSeg(segs[i], curveBuf, fs, fe, inTBuf, outTBuf, startDists[i], startPrevReach, endNextReach, curv));
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
    // Tight wins twice, both free at render time: the break fires earlier, and
    // — much bigger — a segment is binned into only the bands its curve really
    // crosses. A bulgy cubic's hull can span bands the curve never enters,
    // lengthening every fragment's walk; the win grows with shape size, for
    // Slug and AAC alike.
    segBboxInto(segs[i], segBbsF, i*4);
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
  // Shader reads:
  //    H header at glyphLoc.x + bandIndex.y         → matches our [bandIdx.y]
  //    V header at glyphLoc.x + bandMax.y + 1 + bandIndex.x  → matches our [bandsY + bandIdx.x]
  // (bandMax.y == bandsY - 1, so bandMax.y + 1 == bandsY ✓)
  const [bbX0, bbY0, bbX1, bbY1] = bbox;
  const bbW = Math.max(bbX1 - bbX0, 1e-6);
  const bbH = Math.max(bbY1 - bbY0, 1e-6);
  // Per band: collect overlapping segments, then sort by (segType
  // ascending, breakAxis descending). Type-grouping lets the shader
  // walk one type at a time as 4 monomorphic sub-loops — eliminates
  // per-segment branch divergence across warp lanes. Within each type
  // group, descending breakAxis preserves the per-pixel early-out:
  // when a sub-loop hits a segment whose maxX/maxY can't reach the
  // pixel, all later same-type segments also can't, so break is safe
  // (within that sub-loop only).
  const sortByTypeThenBreakAxis = (list, axis /* 2=maxX, 3=maxY */) => {
    list.sort((a, b) => {
      const tA = segTypes[a], tB = segTypes[b];
      if (tA !== tB) return tA - tB;
      const dA = segBbsF[a*4 + axis], dB = segBbsF[b*4 + axis];
      if (dA !== dB) return dB - dA;
      return a - b;
    });
  };
  // For stroke shapes, dilate each segment's bbox by halfW (strokePadEm)
  // when testing band membership. A pixel near the visible stroke edge
  // (within halfW of the path) sits in a band whose y-range may not
  // overlap the segment's curve-tight bbox — but the segment IS the
  // closest one to that pixel. Dilating by halfW guarantees the segment
  // shows up in every band a stroke-pixel for it could land in.
  // For fills (strokePadEm == 0) this is a no-op and band membership
  // matches the band-walk requirement exactly.
  // The stripe boundary is computed as `bbY0 + by*bbH/bandsY`
  // (i.e. (by*bbH)/bandsY) verbatim. Pre-dividing bandH = bbH/bandsY
  // and multiplying by*bandH would differ in the last ULP and could
  // flip a >=/<= band-membership boundary test, so it is NOT done.
  // PAIR BANDS. H band `by` lists every segment overlapping stripe by OR stripe
  // by+1 — i.e. the union of two adjacent stripes, which is just the membership
  // test with its upper bound pushed one stripe down. The union is deduplicated
  // for free (each segment is tested once per band).
  //
  // Why: AAC's cell is one pixel tall and can straddle a stripe boundary, forcing
  // a SECOND band walk (two more header fetches plus a loop iteration). That
  // costs 27-40% on real content, and it is per-band FIXED cost, not per-segment,
  // so nothing about rejecting segments helps. With pair bands, a fragment picks
  // its band from the cell's TOP edge; the cell then lies inside stripes
  // {b, b+1}, which this one list already covers, so a straddling fragment does
  // ONE walk with the full cell window. Cells spanning more stripes step b += 2,
  // and stripe-pairs tile disjointly so nothing is double-counted.
  //
  // Cost: a modest increase in band entries at the configured k (dedup is why it
  // is not 2x). Extra segments in a band simply miss the cell in
  // y and are rejected by the existing hull cull.
  //
  // Slug also reads these lists (its H ray picks the band from c.y). A superset
  // stays CORRECT for it — the extra segments do not cross its ray — it just
  // walks a little further.
  const hBandSegs = [];
  for (let by = 0; by < bandsY; by++) {
    // pairBands: band `by` covers stripes {by, by+1} — see the note above. Without
    // it a band is a single stripe (the layout Slug wants).
    const yLo = bbY0 + (by) * bbH / bandsY;
    const yHi = bbY0 + Math.min(by + (pairBands ? 2 : 1), bandsY) * bbH / bandsY;
    const list = [];
    for (let i = 0; i < N; i++) {
      if (segBbsF[i*4+3] + strokePadEm >= yLo && segBbsF[i*4+1] - strokePadEm <= yHi) list.push(i);
    }
    sortByTypeThenBreakAxis(list, 2 /* maxX */);
    hBandSegs.push(list);
  }
  const vBandSegs = [];
  for (let bx = 0; bx < bandsX; bx++) {
    const xLo = bbX0 + (bx    ) * bbW / bandsX;
    const xHi = bbX0 + (bx + 1) * bbW / bandsX;
    const list = [];
    for (let i = 0; i < N; i++) {
      if (segBbsF[i*4+2] + strokePadEm >= xLo && segBbsF[i*4] - strokePadEm <= xHi) list.push(i);
    }
    sortByTypeThenBreakAxis(list, 3 /* maxY */);
    vBandSegs.push(list);
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
  for (let i = 0; i < (bandsY + bandsX) * headerSlotsPerBand + (gwnTree ? 1 : 0); i++) texelAppend(bandBuf, 0, 0, 0, 0);

  // bandBuf segment-list layout: TWO entries per texel, (loc0, brk0, loc1, brk1).
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
  // The walk is fetch-bound; pairing halves the distinct texels a walk touches. Per-entry
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
    countScratch[0] = 0; countScratch[1] = 0; countScratch[2] = 0; countScratch[3] = 0;
    let pLoc = 0, pBrk = 0, half = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const idx = segHdrIdx[i];
      if (idx >= 16777216) {
        throw new Error('mantle: curve plane exceeds 4096 rows (2^24 texels) — packed band ' +
                        'entries cannot address segment headers past that point');
      }
      // Bake strokePadEm into breakAxis so the shader's early-break
      // (`entryBrk - c.x < -halfW`) correctly considers a seg's cap /
      // miter extension past its control bbox. Without this, a pixel
      // inside a free-cap or miter wedge that lies past the seg's
      // control maxX gets the seg skipped → notch at one corner of
      // the cap. For fills strokePadEm is 0 so this is a no-op.
      const breakAxis = segBbsF[i*4 + axis] + strokePadEm;
      countScratch[segTypes[i] & 3]++;
      if (half === 0) { pLoc = idx; pBrk = breakAxis; half = 1; }
      else { texelAppend(bandBuf, pLoc, pBrk, idx, breakAxis); half = 0; }
    }
    // Odd count: pad the tail half with a sentinel that breaks any walk immediately,
    // so a count/offset bug reads a harmless entry instead of garbage.
    if (half === 1) texelAppend(bandBuf, pLoc, pBrk, 0, -1e30);
    return arrIdx;
  };

  // Wide-only header layout: each band header is 2 adjacent texels:
  //   texel0 = (nLine, nQuad, nCubic, nArc) — plain floats
  //   texel1 = (arrIdx, 0, 0, 0)            — plain floats
  // H bands occupy slots [0 .. bandsY*2); V bands [bandsY*2 ..
  // (bandsY+bandsX)*2). Shader walks four monomorphic sub-loops
  // back-to-back, each with its own break.
  for (let by = 0; by < bandsY; by++) {
    const list = hBandSegs[by];
    const arrIdx = writeBandList(list, 2 /* maxX */);  // fills countScratch
    texelSet(bandBuf, hdrBase + by * 2 + 0,
             countScratch[0], countScratch[1], countScratch[2], countScratch[3]);
    texelSet(bandBuf, hdrBase + by * 2 + 1, arrIdx, 0, 0, 0);
  }
  const vBase = hdrBase + bandsY * headerSlotsPerBand;
  for (let bx = 0; bx < bandsX; bx++) {
    const list = vBandSegs[bx];
    const arrIdx = writeBandList(list, 3 /* maxY */);  // fills countScratch
    texelSet(bandBuf, vBase + bx * 2 + 0,
             countScratch[0], countScratch[1], countScratch[2], countScratch[3]);
    texelSet(bandBuf, vBase + bx * 2 + 1, arrIdx, 0, 0, 0);
  }

  // ---- GWN RUN TREE (opt-in) -------------------------------------------------
  // Bands are the wrong structure for a winding number: winding is GLOBAL, so a pixel must see
  // every segment, and a y-stripe index prunes nothing. The right structure is a hierarchy over
  // CONTIGUOUS RUNS of the contour, because the winding contribution of a run collapses EXACTLY
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
    const pieces = [];                                 // {s, e, bb:[4], hx, hy, ty}
    // CERTIFIED polyline for the occupancy grid (tier-3 early exit): flat (ax, ay, bx, by, pad)
    // sub-chords with a per-chord pad that provably bounds the curve's deviation from the chord
    // (hull / sagitta arguments per type). A grid cell whose center is farther than pad from
    // every sub-chord has the polyline's EXACT winding: curve and polyline are homotopic inside
    // the pad tube, and the tube misses the cell center.
    const polySegs = [];
    const polyPush = (a, b, pad) => { polySegs.push(a[0], a[1], b[0], b[1], pad); _piecePad = pad; };
    const padTo = (len) => {
      while ((curveBuf.count % TEXTURE_WIDTH) + len > TEXTURE_WIDTH) texelAppend(curveBuf, 0, 0, 0, 0);
    };
    let _piecePad = 0;                                 // set by polyPush, consumed by pushPiece
    // mid/tan: a point ON the curve and its direction of travel there. The ink-side probe steps a
    // hair off the boundary along the normal, so it has to start on the boundary — the CHORD
    // midpoint can be a whole sagitta away from it (a quarter-circle chord is ~20 units off a
    // 70-unit arc), which puts both probes on the same side and decides nothing.
    const pushPiece = (s, e, bb, idx, ty, mid, tan) => {
      pieces.push({ s, e, bb, hx: idx % TEXTURE_WIDTH, hy: Math.floor(idx / TEXTURE_WIDTH), ty,
                    pad: _piecePad, sigma: 0,
                    mid: mid || [0.5 * (s[0] + e[0]), 0.5 * (s[1] + e[1])],
                    tan: tan || [e[0] - s[0], e[1] - s[1]] });
    };
    // degenerate curve piece -> a synthetic LINE record (header texel + endpoint texel, the
    // type-0 reader's layout)
    const emitLinePiece = (a, b) => {
      padTo(2);
      const h = texelAppend(curveBuf, 0, 0, 0, 0);
      texelAppend(curveBuf, a[0], a[1], b[0], b[1]);
      polyPush(a, b, 0);
      pushPiece(a, b, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], h, 0,
                [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])], [b[0] - a[0], b[1] - a[1]]);
    };
    // Cubic at t = 1/2: the on-curve point and its direction of travel. Used only by the ink-side
    // probe, which must start ON the boundary.
    const cubicMidTan = (P) => {
      const m = [0, 1].map(i => 0.125 * P[0][i] + 0.375 * P[1][i] + 0.375 * P[2][i] + 0.125 * P[3][i]);
      // B'(1/2) ∝ (P3 + P2 − P1 − P0); only the DIRECTION matters here
      const t = [0, 1].map(i => P[3][i] + P[2][i] - P[1][i] - P[0][i]);
      return [m, t];
    };
    const emitCubicPiece = (P, klmn) => {
      const chx = P[3][0] - P[0][0], chy = P[3][1] - P[0][1];
      const cl = Math.hypot(chx, chy);
      if (!klmn || cl < 1e-12) { emitLinePiece(P[0], P[3]); return; }
      // affine rows from the most non-degenerate control-point triple
      let best = -1, bi = 0;
      const tris = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
      for (let t = 0; t < 4; t++) {
        const [a, b, c] = tris[t];
        const ar = Math.abs((P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]));
        if (ar > best) { best = ar; bi = t; }
      }
      if (best < 1e-9 * cl * cl) { emitLinePiece(P[0], P[3]); return; }
      const [ia, ib, ic] = tris[bi];
      const solveRow = (vals) => {
        // row (rx, ry, rc) with rx*x + ry*y + rc = val at the three points
        const x1 = P[ia][0], y1 = P[ia][1], x2 = P[ib][0], y2 = P[ib][1], x3 = P[ic][0], y3 = P[ic][1];
        const det = x1 * (y2 - y3) - y1 * (x2 - x3) + (x2 * y3 - x3 * y2);
        if (Math.abs(det) < 1e-18) return null;
        const v1 = vals[ia], v2 = vals[ib], v3 = vals[ic];
        const rx = (v1 * (y2 - y3) + v2 * (y3 - y1) + v3 * (y1 - y2)) / det;
        const ry = (v1 * (x3 - x2) + v2 * (x1 - x3) + v3 * (x2 - x1)) / det;
        const rc = (v1 * (x2 * y3 - x3 * y2) + v2 * (x3 * y1 - x1 * y3) + v3 * (x1 * y2 - x2 * y1)) / det;
        return [rx, ry, rc];
      };
      const rk = solveRow(klmn.k), rl = solveRow(klmn.l), rm = solveRow(klmn.m);
      if (!rk || !rl || !rm) { emitLinePiece(P[0], P[3]); return; }
      // lune metadata: signed perpendicular deviation frame along the chord. NB: the cubic's
      // lune term is GONE from the shader (the winding is exact now) — luneAdd/fMidSign remain only
      // because the record shape is shared with the arc piece, which still winds by chord + lune
      // (an arc's lune IS cheaply exact: the far arm of the ellipse is a whole minor axis away).
      const dev = (p) => ((p[0] - P[0][0]) * chy - (p[1] - P[0][1]) * chx) / cl;
      const mid = [0.125 * P[0][0] + 0.375 * P[1][0] + 0.375 * P[2][0] + 0.125 * P[3][0],
                   0.125 * P[0][1] + 0.375 * P[1][1] + 0.375 * P[2][1] + 0.125 * P[3][1]];
      const dMid = dev(mid);
      const luneAdd = dMid >= 0 ? 1 : -1;             // matches the quad's sign(sideP) convention
      const maxDev = Math.max(Math.abs(dev(P[1])), Math.abs(dev(P[2])), Math.abs(dMid)) * 1.0001 + 1e-12;
      // f's sign strictly between chord and curve, from the rows themselves
      const q = [(P[0][0] + P[3][0]) / 2 * 0.5 + mid[0] * 0.5, (P[0][1] + P[3][1]) / 2 * 0.5 + mid[1] * 0.5];
      const kq = rk[0] * q[0] + rk[1] * q[1] + rk[2];
      const lq = rl[0] * q[0] + rl[1] * q[1] + rl[2];
      const mq = rm[0] * q[0] + rm[1] * q[1] + rm[2];
      const fMidSign = (kq * kq * kq - lq * mq) >= 0 ? 1 : -1;
      const unit = (x, y, fx, fy) => { const L = Math.hypot(x, y); return L > 1e-12 ? [x / L, y / L] : [fx, fy]; };
      const t0 = unit(P[1][0] - P[0][0], P[1][1] - P[0][1], chx / cl, chy / cl);
      const t1 = unit(P[3][0] - P[2][0], P[3][1] - P[2][1], chx / cl, chy / cl);
      // luneAdd == 0 is the shader's flag for "this one does not get the cheap lune — wind it with
      // the exact ray crossing", and such a piece carries a 6th texel with its control points.
      const cheap = luneIsExact(P, chx, chy, cl, luneAdd, maxDev);
      const luneW = cheap ? luneAdd : 0;
      padTo(cheap ? 5 : 6);
      const h = texelAppend(curveBuf, P[0][0], P[0][1], P[3][0], P[3][1]);
      texelAppend(curveBuf, rk[0], rk[1], rk[2], luneW);
      texelAppend(curveBuf, rl[0], rl[1], rl[2], fMidSign);
      texelAppend(curveBuf, rm[0], rm[1], rm[2], maxDev);
      texelAppend(curveBuf, t0[0], t0[1], t1[0], t1[1]);
      if (!cheap) texelAppend(curveBuf, P[1][0], P[1][1], P[2][0], P[2][1]);   // raw control points
      // polyline: quarter-split; each sub-cubic's control-point deviation from its own chord is
      // a certified pad (curve ⊂ hull ⊂ chord slab of that width)
      const [hL, hR] = splitCubic(P, 0.5);
      for (const half of [hL, hR]) for (const Q of splitCubic(half, 0.5)) {
        const qx = Q[3][0] - Q[0][0], qy = Q[3][1] - Q[0][1], ql = Math.hypot(qx, qy);
        const dv = (p) => (ql > 1e-12 ? Math.abs((p[0] - Q[0][0]) * qy - (p[1] - Q[0][1]) * qx) / ql
                                      : Math.hypot(p[0] - Q[0][0], p[1] - Q[0][1]));
        polyPush(Q[0], Q[3], Math.max(dv(Q[1]), dv(Q[2])) * 1.0001 + 1e-12);
      }
      // TIGHT bound: chord bbox + the measured max deviation (the control bbox over-fattens
      // the node circles; see the quad case above)
      const [_cm, _ct] = cubicMidTan(P);
      pushPiece(P[0], P[3], [Math.min(P[0][0], P[3][0]) - maxDev, Math.min(P[0][1], P[3][1]) - maxDev,
                             Math.max(P[0][0], P[3][0]) + maxDev, Math.max(P[0][1], P[3][1]) + maxDev], h, 4,
                _cm, _ct);
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
      if (!(cl2 > 1e-20) || !(maxDev > 0)) return false;
      const tprojOf = (q) => ((q[0] - P[0][0]) * chx + (q[1] - P[0][1]) * chy) / cl2;
      const t1 = tprojOf(P[1]), t2 = tprojOf(P[2]);
      if (!(t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1)) return false;           // (B)
      // (A): B(t) - P0 in the (tproj, dev) frame — both cubic polynomials in t
      const bx = [0, 3 * (P[1][0] - P[0][0]), 3 * (P[0][0] - 2 * P[1][0] + P[2][0]),
                  -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0]];
      const by = [0, 3 * (P[1][1] - P[0][1]), 3 * (P[0][1] - 2 * P[1][1] + P[2][1]),
                  -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1]];
      const h = [], g = [];
      for (let i = 0; i < 4; i++) {
        h.push((bx[i] * chx + by[i] * chy) / cl2);                              // tproj(B(t))
        g.push((bx[i] * chy - by[i] * chx) / cl);                               // dev(B(t))
      }
      const ev = (c, t) => c[0] + t * (c[1] + t * (c[2] + t * c[3]));
      const bps = [0, 1];
      bps.push(...solveCubic(h[3], h[2], h[1], h[0]));
      bps.push(...solveCubic(h[3], h[2], h[1], h[0] - 1));
      bps.push(...solveCubic(g[3], g[2], g[1], g[0]));
      bps.push(...solveCubic(g[3] * luneAdd, g[2] * luneAdd, g[1] * luneAdd, g[0] * luneAdd - maxDev));
      const B = bps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
      const M = 0.05;                                     // the extension must CLEAR the region
      for (let i = 0; i <= B.length; i++) {               // one probe per interval, tails included
        const lo = i === 0 ? B[0] - 1 : B[i - 1];
        const hi = i === B.length ? B[B.length - 1] + 1 : B[i];
        const t = i === 0 ? lo : (i === B.length ? hi : (lo + hi) / 2);
        if (t >= -1e-9 && t <= 1 + 1e-9) continue;        // the piece's own arc: that IS the lune
        const hv = ev(h, t), gv = ev(g, t) * luneAdd;
        if (hv > -M && hv < 1 + M && gv > -M * maxDev && gv <= maxDev * (1 + M)) return false;
      }
      return true;
    };
    // type-6 EXACT cubic piece: a cusp or self-intersecting loop cubic has no single valid
    // Loop-Blinn branch (cubicKLMN → null), so the type-4 chord+lune winding miscounts it. This
    // record carries the RAW control points and the shader winds it with hardCrossCubic — the
    // exact +x ray-crossing (Slug's cubic solver), which handles cusps/loops. Winding-only: no
    // SDF candidate is produced, so it belongs to the tree-hard (GWN_WINDING_ONLY) route.
    const emitCubicHardPiece = (P) => {
      padTo(2);
      const h = texelAppend(curveBuf, P[0][0], P[0][1], P[1][0], P[1][1]);   // (P0, P1)
      texelAppend(curveBuf, P[2][0], P[2][1], P[3][0], P[3][1]);             // (P2, P3)
      // certified occupancy polyline: quarter-split, each sub-chord padded by its own control
      // deviation (curve ⊂ hull ⊂ chord slab of that width) — same bound emitCubicPiece uses.
      const [hL, hR] = splitCubic(P, 0.5);
      for (const half of [hL, hR]) for (const Q of splitCubic(half, 0.5)) {
        const qx = Q[3][0] - Q[0][0], qy = Q[3][1] - Q[0][1], ql = Math.hypot(qx, qy);
        const dv = (p) => (ql > 1e-12 ? Math.abs((p[0] - Q[0][0]) * qy - (p[1] - Q[0][1]) * qx) / ql
                                      : Math.hypot(p[0] - Q[0][0], p[1] - Q[0][1]));
        polyPush(Q[0], Q[3], Math.max(dv(Q[1]), dv(Q[2])) * 1.0001 + 1e-12);
      }
      // control-hull bbox (conservative — a cusp/loop can bulge past the chord slab)
      const xs = [P[0][0], P[1][0], P[2][0], P[3][0]], ys = [P[0][1], P[1][1], P[2][1], P[3][1]];
      const [_hm, _ht] = cubicMidTan(P);
      pushPiece(P[0], P[3], [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], h, 6, _hm, _ht);
    };
    // A cubic leaf goes to the exact type-6 hard piece (raw control points wound by the exact
    // ray-crossing hardCrossCubic) instead of the type-4 single-branch implicit when EITHER it has
    // no single-branch implicit (cusp, klmn null — old line fallback was 504 px wrong) OR its parent
    // is a self-intersecting LOOP (forceHard). A loop's type-4 klm implicit can't represent the
    // double coverage where the two strands overlap (5946 px wrong); type-6 winds it exactly.
    const emitCubicLeaf = (P, klmn, forceHard) => {
      if (klmn && !forceHard) { emitCubicPiece(P, klmn); return; }
      const chx = P[3][0] - P[0][0], chy = P[3][1] - P[0][1];
      if (Math.hypot(chx, chy) < 1e-12) { emitLinePiece(P[0], P[3]); return; }   // truly degenerate
      emitCubicHardPiece(P);
    };
    const flatSplit = (P, depth, forceHard) => {
      const chx = P[3][0] - P[0][0], chy = P[3][1] - P[0][1];
      const cl = Math.hypot(chx, chy);
      const d1 = cl > 1e-12 ? Math.abs((P[1][0] - P[0][0]) * chy - (P[1][1] - P[0][1]) * chx) / cl : 0;
      const d2 = cl > 1e-12 ? Math.abs((P[2][0] - P[0][0]) * chy - (P[2][1] - P[0][1]) * chx) / cl : 0;
      const flat = Math.max(d1, d2) <= 0.14 * cl;
      const klmn = flat || depth >= 4 ? cubicKLMN(P) : null;
      // A single-branch piece becomes type-4; a cusp/loop piece (klmn null, or forceHard for a
      // self-intersecting parent) becomes an exact type-6 hard piece — no line fallback, no klm.
      if ((flat && klmn) || depth >= 8) { emitCubicLeaf(P, klmn, forceHard); return; }
      if (flat && depth >= 4) { emitCubicLeaf(P, klmn, forceHard); return; }
      const [L, R] = splitCubic(P, 0.5);
      flatSplit(L, depth + 1, forceHard);
      flatSplit(R, depth + 1, forceHard);
    };
    const emitArcPieces = (sg) => {
      const co = Math.cos(sg.phi), si = Math.sin(sg.phi);
      const pt = (th) => {
        const ex = sg.rx * Math.cos(th), ey = sg.ry * Math.sin(th);
        return [sg.cx + co * ex - si * ey, sg.cy + si * ex + co * ey];
      };
      const dir = sg.theta_end >= sg.theta_start ? 1 : -1;
      const total = Math.abs(sg.theta_end - sg.theta_start);
      const nPieces = Math.max(1, Math.ceil(total / (Math.PI / 2 - 1e-6)));
      for (let pi = 0; pi < nPieces; pi++) {
        const th0 = sg.theta_start + dir * total * pi / nPieces;
        const th1 = sg.theta_start + dir * total * (pi + 1) / nPieces;
        // the seg's STORED endpoints at the outer ends — recomputed floats would differ in
        // the last ulp and read as false contour breaks in the forest builder
        const E0 = pi === 0 ? [sg.p1[0], sg.p1[1]] : pt(th0);
        const E1 = pi === nPieces - 1 ? [sg.p4[0], sg.p4[1]] : pt(th1);
        const chx = E1[0] - E0[0], chy = E1[1] - E0[1];
        const cl = Math.hypot(chx, chy);
        if (cl < 1e-12) continue;
        const dev = (p) => ((p[0] - E0[0]) * chy - (p[1] - E0[1]) * chx) / cl;
        // deviation extremum sampled (ellipse arcs peak off the parameter midpoint)
        let maxDev = 0, dMidSigned = 0;
        for (let ss = 1; ss < 8; ss++) {
          const dv = dev(pt(th0 + (th1 - th0) * ss / 8));
          if (ss === 4) dMidSigned = dv;
          maxDev = Math.max(maxDev, Math.abs(dv));
        }
        maxDev = maxDev * 1.02 + 1e-12;
        const luneAdd = dMidSigned >= 0 ? 1 : -1;
        const tan = (th) => {
          const ex = -sg.rx * Math.sin(th) * dir, ey = sg.ry * Math.cos(th) * dir;
          const tx = co * ex - si * ey, ty = si * ex + co * ey;
          const L = Math.hypot(tx, ty);
          return L > 1e-12 ? [tx / L, ty / L] : [chx / cl, chy / cl];
        };
        const t0 = tan(th0), t1 = tan(th1);
        padTo(4);
        const h = texelAppend(curveBuf, E0[0], E0[1], E1[0], E1[1]);
        texelAppend(curveBuf, sg.cx, sg.cy, sg.rx, sg.ry);
        texelAppend(curveBuf, co, si, luneAdd, maxDev);
        texelAppend(curveBuf, t0[0], t0[1], t1[0], t1[1]);
        // polyline: 4 sub-chords; ellipse-arc sagitta ≤ max(rx, ry) * (1 - cos(dθ/2)) certified
        // via the unit-circle scaling argument (rotation preserves distance, diag(rx, ry)
        // multiplies it by at most max(rx, ry))
        {
          const dth = (th1 - th0) / 4;
          const aPad = Math.max(sg.rx, sg.ry) * (1 - Math.cos(Math.abs(dth) / 2)) * 1.001 + 1e-12;
          let prev = E0;
          for (let ss = 1; ss <= 4; ss++) {
            const nxt = ss === 4 ? E1 : pt(th0 + dth * ss);
            polyPush(prev, nxt, aPad);
            prev = nxt;
          }
        }
        // bbox: chord bbox padded by the deviation
        const bx0 = Math.min(E0[0], E1[0]) - maxDev, by0 = Math.min(E0[1], E1[1]) - maxDev;
        const bx1 = Math.max(E0[0], E1[0]) + maxDev, by1 = Math.max(E0[1], E1[1]) + maxDev;
        const _thm = 0.5 * (th0 + th1);
        const _am = pt(_thm);
        const _dex = -sg.rx * Math.sin(_thm), _dey = sg.ry * Math.cos(_thm);
        const _at = [(co * _dex - si * _dey) * dir, (si * _dex + co * _dey) * dir];
        pushPiece(E0, E1, [bx0, by0, bx1, by1], h, 5, _am, _at);
      }
    };
    for (let k = 0; k < N; k++) {
      const ty = segTypes[k];
      if (ty === SEG_CUBIC) {
        const P0c = [segs[k].p1, segs[k].p2, segs[k].p3, segs[k].p4];
        // Split at inflections. A self-intersecting LOOP cubic emits its pieces as exact type-6
        // hard pieces (forceHard) — the type-4 klm implicit can't represent the two strands' double
        // coverage. The winding is then exact on the tree; only a sub-pixel hard-vs-AA residual
        // remains at the self-crossing (the one fill edge the covering stroke can't mask), which is
        // acceptable on the no-AA tree-hard route. Non-stroke-covered loops never take this path.
        const infl = cubicInflections(P0c);
        const isLoop = !!cubicLoopParams(P0c);
        for (const piece of splitCubicMulti(P0c, infl)) flatSplit(piece, 0, isLoop);
      } else if (ty === SEG_ARC) {
        emitArcPieces(segs[k]);
      } else {
        const hi = segHdrIdx[k];
        let bbP = [segBbsF[k * 4], segBbsF[k * 4 + 1], segBbsF[k * 4 + 2], segBbsF[k * 4 + 3]];
        if (ty === SEG_QUAD) {
          // TIGHT bound: the curve deviates at most ctrlDev/2 from its chord (exact for
          // quads) — the control-hull bbox over-fattens the node circles and every fattened
          // circle is descent + leaf work for pixels that are nowhere near the boundary.
          const A = segs[k].p1, C = segs[k].p2, B = segs[k].p3;
          const chx = B[0] - A[0], chy = B[1] - A[1];
          const cl = Math.hypot(chx, chy);
          const dev = cl > 1e-12 ? Math.abs((C[0] - A[0]) * chy - (C[1] - A[1]) * chx) / cl * 0.5 : Math.hypot(C[0] - A[0], C[1] - A[1]) * 0.5;
          bbP = [Math.min(A[0], B[0]) - dev, Math.min(A[1], B[1]) - dev,
                 Math.max(A[0], B[0]) + dev, Math.max(A[1], B[1]) + dev];
          // polyline: 4 sub-chords; a quad's chord deviation scales EXACTLY with h² (constant
          // second derivative), so each quarter deviates ≤ dev/16 from its chord
          const qp = (t) => [(1 - t) * (1 - t) * A[0] + 2 * (1 - t) * t * C[0] + t * t * B[0],
                             (1 - t) * (1 - t) * A[1] + 2 * (1 - t) * t * C[1] + t * t * B[1]];
          const qPad = dev / 16 * 1.001 + 1e-12;
          let prev = A;
          for (let ss = 1; ss <= 4; ss++) {
            const nxt = ss === 4 ? B : qp(ss / 4);
            polyPush(prev, nxt, qPad);
            prev = nxt;
          }
        } else {
          polyPush(startOf(k), endOf(k), 0);
        }
        pushPiece(startOf(k), endOf(k), bbP, hi, ty);
      }
    }
    const NP = pieces.length;

    // ---- INK SIDE, per contour, decided at BUILD time --------------------------------------
    //
    // The kernel needs to know, for each boundary piece, which side of the direction of travel the
    // ink lies on. A single shape-level shoelace sign is insufficient.
    //
    // That holds only when a shape's contours are wound CONSISTENTLY — outer one way, holes the
    // other. An even-odd ring's inner circle is wound the SAME way as its outer (that is exactly
    // what makes it a hole by PARITY rather than by winding), so there ink is on the RIGHT, one
    // global sign cannot say so, and the coverage ramp ran backwards along it: a white seam inside
    // the ink, and stipple where the inverted ramp met a neighbouring one.
    //
    // It need not be guessed at. Crossing a contour changes the winding number by exactly ONE, so
    // for a point on contour C:
    //
    //     w(just left of C) = w_other(C) + (C is CCW ? 1 : 0)
    //
    // where w_other is the winding contributed by every OTHER contour. Run that through the fill
    // rule and you have the answer — exactly, for holes, for even-odd, and for CORNERS, which no
    // runtime rule can decide (at a convex tip the pixel centre can be on the ink side of one edge
    // and still be outside the ink).
    //
    // w_other is evaluated at a point ON contour C, where the other contours are FAR — so their
    // certified chord polygons give it exactly, with no curve maths at all. (The first version of
    // this asked the shape's fill rule at a point offset from the CHORD midpoint by the piece's
    // deviation bound. Two mistakes: the chord midpoint can be a whole sagitta off the curve, and
    // the deviation bound is a bound, not a hair — on a 70-unit arc it is ~20 units. Both probes
    // landed on the same side, every contour fell back to the shoelace, and the bug survived.)
    const contourSigma = () => {
      const EPSJ = 1e-9;
      const runs = [];                                    // [start, end] piece index per contour
      let cs = 0;
      for (let k = 0; k < NP; k++) {
        const nxt = (k + 1 < NP) ? pieces[k + 1] : null;
        const joins = nxt && Math.abs(pieces[k].e[0] - nxt.s[0]) < EPSJ && Math.abs(pieces[k].e[1] - nxt.s[1]) < EPSJ;
        if (!joins) { runs.push([cs, k]); cs = k + 1; }
      }
      // signed crossings of the +x ray by one contour's chord polygon
      const chordWinding = (lo, hi, px, py) => {
        let w = 0;
        for (let j = lo; j <= hi; j++) {
          const a = pieces[j].s, b = pieces[j].e;
          const y0 = a[1], y1 = b[1];
          if ((y0 > py) === (y1 > py)) continue;           // no crossing of the horizontal ray
          const t = (py - y0) / (y1 - y0);
          if (a[0] + t * (b[0] - a[0]) > px) w += (y1 > y0) ? 1 : -1;
        }
        return w;
      };
      for (let ci = 0; ci < runs.length; ci++) {
        const [lo, hi] = runs[ci];
        let a2 = 0;
        for (let j = lo; j <= hi; j++) a2 += pieces[j].s[0] * pieces[j].e[1] - pieces[j].s[1] * pieces[j].e[0];
        const ccw = a2 >= 0;
        // a point ON this contour, nudged off the ray's exact y so a tangency cannot count
        const P = pieces[lo].mid;
        const py = P[1] + 1e-7;
        let wOther = 0;
        for (let cj = 0; cj < runs.length; cj++)
          if (cj !== ci) wOther += chordWinding(runs[cj][0], runs[cj][1], P[0], py);
        // The two sides of this contour, in winding: crossing it changes the number by one.
        const wLeft = wOther + (ccw ? 1 : 0);
        const wRight = wLeft - 1;
        const fill = (w) => (evenOdd ? ((w & 1) === 1) : (w !== 0));
        const inkLeft = fill(wLeft), inkRight = fill(wRight);
        // THREE states, not two. When both sides are filled — a contour wound like its parent
        // under NONZERO, where the winding steps 1 → 2 — the contour is not a boundary at all and
        // has no ink side: the kernel must count its winding but paint NO coverage ramp across it,
        // or it draws a seam through the middle of a solid shape. Same when both sides are empty.
        // sigma = 0 says exactly that.
        const sigma = (inkLeft === inkRight) ? 0 : (inkLeft ? 1 : -1);
        for (let j = lo; j <= hi; j++) pieces[j].sigma = sigma;
      }
    };
    contourSigma();

    // Nodes are emitted in DFS PREORDER with ESCAPE links (internal code = the index to jump
    // to when the subtree is skipped), so the internal code is a single index ≤ nodeCount —
    // no left*4096+right packing, no 4095-node cap, no adaptive leaf growth.
    const LEAF_MAX = 4;
    const nodes = [];                                  // {s,e,cx,cy,r,leaf,l,rt,refStart,refCount}
    const refs = [];                                   // [hx, hy, type, inkSide]
    const build = (i, j) => {                          // piece run [i, j)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = i; k < j; k++) {
        const bb = pieces[k].bb;
        x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]);
        x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]);
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const r = Math.hypot(x1 - x0, y1 - y0) / 2;
      const node = { s: pieces[i].s, e: pieces[j - 1].e, cx, cy, r, leaf: 0, l: 0, rt: 0, refStart: 0, refCount: 0 };
      const idx = nodes.length; nodes.push(node);
      if (j - i <= LEAF_MAX) {
        // refs holds FOUR floats per entry (hx, hy, type, INK SIDE) and the shader indexes it by
        // TEXEL, so the start must be divided by 4. Getting this wrong makes every leaf read
        // garbage segments (or none), and the far-field chords then paper over most of the damage.
        node.leaf = 1; node.refStart = refs.length / 4; node.refCount = j - i;
        for (let k = i; k < j; k++) refs.push(pieces[k].hx, pieces[k].hy, pieces[k].ty, pieces[k].sigma);
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
      // TOLERANT junction test. Exact equality FALSELY split closed contours whenever a
      // parsed endpoint met a computed one (arc endpoints re-derived from center + angles
      // differ in the last f64 ulp) — and a false break is not benign: the split runs land
      // under CONTAINER nodes, whose degenerate-chord far-collapse is only exact for CLOSED
      // contours. An open run's skipped crossings then leak winding over the whole region
      // outside the container circle (the capsule@512 left-lobe fill). A genuine
      // sub-tolerance gap would leak only within the gap's own y-interval — invisible
      // either way, so the tolerance is safe in both directions.
      const jTol = 1e-9 * (Math.abs(bbX1 - bbX0) + Math.abs(bbY1 - bbY0) + 1);
      let s0 = 0;
      for (let k = 0; k < NP; k++) {
        if (k > s0) {
          const e = pieces[k - 1].e, b = pieces[k].s;
          if (Math.abs(e[0] - b[0]) > jTol || Math.abs(e[1] - b[1]) > jTol) { contourStart.push(s0); s0 = k; }
        }
      }
      contourStart.push(s0);
    }
    let roots = contourStart.map((s, ci) => build(s, ci + 1 < contourStart.length ? contourStart[ci + 1] : NP));
    while (roots.length > 1) {
      const next = [];
      for (let k = 0; k + 1 < roots.length; k += 2) {
        const a = nodes[roots[k]], b = nodes[roots[k + 1]];
        const cx = (a.cx + b.cx) / 2, cy = (a.cy + b.cy) / 2;
        const r = Math.max(Math.hypot(a.cx - cx, a.cy - cy) + a.r, Math.hypot(b.cx - cx, b.cy - cy) + b.r);
        const node = { s: [cx, cy], e: [cx, cy], cx, cy, r, leaf: 0, l: roots[k], rt: roots[k + 1], refStart: 0, refCount: 0 };
        next.push(nodes.length); nodes.push(node);
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
    for (let k = 0; k < refs.length; k += 4) texelAppend(bandBuf, refs[k], refs[k + 1], refs[k + 2], refs[k + 3]);
    // ---- EARLY-EXIT EXTENSION (tiers 2 + 3) --------------------------------------------
    // One EXT texel sits at the deterministic slot refBase + refCount:
    //   (rootBandBase, bandCount GB, gridBase, gridW * 256 + gridH)   (0 = section absent)
    // followed by the sections it points to. Appended, so readers of the old layout are
    // untouched.
    const extSlot = bandBuf.count;                     // absolute; written after sections
    texelAppend(bandBuf, 0, 0, 0, 0);
    let rbBase = 0, GB = 0, gridBase = 0, gridW = 0, gridH = 0;
    const bbW = Math.max(bbX1 - bbX0, 1e-9), bbH = Math.max(bbY1 - bbY0, 1e-9);
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
        const gridAbsTexel = bandBuf.count;                 // absolute band texel of cell 0
        if (deferTier3Out) {
          // Reserve the exact same texel count, zeroed (margin 0 ⇒ dormant), and
          // hand the build inputs to the idle pass. polySegs is copied because the
          // shared bandBuf/geometry churns as later shapes bake.
          const nTexels = Math.ceil(gridW * gridH / 2);
          for (let i = 0; i < nTexels; i++) texelAppend(bandBuf, 0, 0, 0, 0);
          deferTier3Out.push({ absTexel: gridAbsTexel, gridW, gridH,
                               bbX0, bbY0, bbW, bbH, polySegs: polySegs.slice() });
        } else {
          const cells = computeGwnOccupancyCells(polySegs, bbX0, bbY0, bbW, bbH, gridW, gridH);
          for (let i = 0; i < gridW * gridH; i += 2) {
            texelAppend(bandBuf, cells[i * 2], cells[i * 2 + 1],
                        i + 1 < gridW * gridH ? cells[i * 2 + 2] : 0,
                        i + 1 < gridW * gridH ? cells[i * 2 + 3] : 0);
          }
        }
      }
    }
    if (NP >= 16) {
      // TIER 2: y-banded, x-sorted CUT lists — the Slug band early-exit transplanted onto the
      // tree. The cut is a frontier partition (~K subtree roots, largest radius split first);
      // winding is a +x-ray crossing count, and every chord and lune of a run lies inside its
      // circle, so a run whose circle is off the pixel's row or entirely left of it
      // contributes EXACTLY zero — banding by y and breaking on sorted maxX skips only zeros.
      const esc = (i) => (flat[i].leaf ? i + 1 : flat[i].escape);
      const cut = [0];
      const K = Math.min(96, Math.max(16, Math.ceil(flat.length / 8)));
      while (cut.length < K) {
        let bi = -1, br = -1;
        for (let q = 0; q < cut.length; q++) {
          const n = flat[cut[q]];
          if (!n.leaf && n.r > br) { br = n.r; bi = q; }
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
        const y0 = n.cy - n.r, y1 = n.cy + n.r, mx = n.cx + n.r;
        const bLo = Math.max(0, Math.floor((y0 - bbY0) / bandH));
        const bHi = Math.min(GB - 1, Math.floor((y1 - bbY0) / bandH));
        // adjacency flags (prev/next band membership) are ENCODE-TIME truth — the kernel's
        // neighbor-band dedupe must not re-derive membership from f32 band arithmetic
        for (let b = bLo; b <= bHi; b++) {
          bandLists[b].push({ ni: i, mx, y0, y1, fl: (b > bLo ? 2 : 0) + (b < bHi ? 1 : 0) });
        }
      }
      rbBase = bandBuf.count - glyphLocIdx;
      const rbSlot = bandBuf.count;                    // ceil(GB/2) header texels, 2 bands each
      for (let i = 0; i < Math.ceil(GB / 2); i++) texelAppend(bandBuf, 0, 0, 0, 0);
      const bandHdr = new Float64Array(GB * 2);
      for (let b = 0; b < GB; b++) {
        const list = bandLists[b].sort((p, q) => q.mx - p.mx);   // desc maxX: sorted break
        bandHdr[b * 2] = bandBuf.count - glyphLocIdx;
        bandHdr[b * 2 + 1] = list.length;
        for (const e of list) texelAppend(bandBuf, e.ni * 4 + e.fl, e.mx, e.y0, e.y1);
      }
      for (let b = 0; b < GB; b += 2) {
        texelSet(bandBuf, rbSlot + b / 2, bandHdr[b * 2], bandHdr[b * 2 + 1],
                 b + 1 < GB ? bandHdr[b * 2 + 2] : 0, b + 1 < GB ? bandHdr[b * 2 + 3] : 0);
      }
    }
    texelSet(bandBuf, extSlot, rbBase, GB > 0 && rbBase > 0 ? GB : 0, gridBase, gridW * 256 + gridH);

    // The shape-wide shoelace sign is still written to the header: it is the fallback the kernel
    // uses for any piece whose per-piece sign is missing (0).
    let area2 = 0;
    for (let k = 0; k < NP; k++) {
      const a = pieces[k].s, b = pieces[k].e;
      area2 += a[0] * b[1] - a[1] * b[0];
    }
    const orient = area2 >= 0 ? 1 : -1;
    texelSet(bandBuf, gwnHeaderSlot, nodeBase, orient * nodes.length, refBase, refs.length / 4);
  }

  return {
    glyphLoc: [glyphLocX, glyphLocY],
    bandMaxX: bandsX - 1,
    bandMaxY: bandsY - 1,
    bbox: bbox.slice(),
    numSegments: segs.length,
    typeMask,
    curveEndF,                      // the shape's curves end HERE; the GWN tree lives past it
    gwnNodes: gwnHeaderSlot >= 0 ? 1 : 0,
  };
}
