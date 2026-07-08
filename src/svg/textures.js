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
import { segCtrlBbox, segCtrlBboxInto, segBboxInto } from './bbox.js';

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
export function buildTexturesShape(segs, bandsX, bandsY, bbox, curveBuf, bandBuf, strokePadEm = 0, fillOnly = false, emitCurvature = false) {
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
    // per-shape (tiger's biggest is ~200 segs), so the quadratic is fine.
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
  // Control-poly bbox per seg, flattened as Float64Array[4N] — entry
  // (minX, minY, maxX, maxY) at [i*4 .. i*4+3]. Replaces the per-seg
  // 4-element arrays from segCtrlBbox().
  const segBbsF = new Float64Array(N * 4);
  // Per-seg type cached once. The band machinery below (sort comparator,
  // per-band counts, per-band-list writer) reads segs[i].type many times
  // each — once per comparison in the O(M log M) sort and once per
  // band-list entry — across ~2·sqrt(32N) bands. Caching the property
  // chain into a flat Int32Array removes those repeated array-index +
  // object-property lookups from the inner loops.
  const segTypes = new Int32Array(N);
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
    // The shader's per-segment early-exit check (e.g. for cubic H pass:
    //   if (max(p1.x, p2.x, p3.x, p4.x) * pixelsPerEm.x < -0.5) break;)
    // uses the control-polygon maxX/maxY, not curve-tight extents.
    // Sort + band-membership must use the SAME measure or the early-out
    // is unsound: a segment with curve-tight maxX < ray.x but control-
    // polygon maxX > ray.x would still satisfy the shader's break and
    // skip later segments that we should have visited (visible as
    // pixel-aligned rectangular gaps in the silhouette).
    segCtrlBboxInto(segs[i], segBbsF, i*4);
  }

  // Multi-band layout: bandsY horizontal bands (each holds segments
  // whose y-range overlaps the band's y-stripe, sorted by maxX
  // descending for early-out break) + bandsX vertical bands (segments
  // whose x-range overlaps the band's x-stripe, sorted by maxY
  // descending). A pixel's horizontal-ray walk only walks the H band
  // for its row → for tiger this drops the per-pixel iteration count
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
  const hBandSegs = [];
  for (let by = 0; by < bandsY; by++) {
    const yLo = bbY0 + (by    ) * bbH / bandsY;
    const yHi = bbY0 + (by + 1) * bbH / bandsY;
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
  for (let i = 0; i < (bandsY + bandsX) * headerSlotsPerBand; i++) texelAppend(bandBuf, 0, 0, 0, 0);

  // bandBuf segment record layout (4 floats):
  //   [0] uint hx          — curveBuf x-coord of segment header
  //   [1] uint hy          — curveBuf y-coord of segment header
  //   [2] float break_axis — for H bands: segment's maxX; for V
  //                          bands: segment's maxY. Lets the shader
  //                          early-out from the band walk by
  //                          comparing this to renderCoord.axis WITHOUT
  //                          first loading the curve's control points
  //                          (saves one texture fetch per skipped seg).
  //                          Combined with the descending sort, the
  //                          shader breaks as soon as it walks past
  //                          all rightmost / topmost segments.
  //   [3] reserved
  // bandBuf is float-encoded; integer values (segLoc, counts,
  // offsets, segType) are stored as plain (float)val and recovered
  // via (uint)floatVal in the shader — no asuint() bit-reinterpret.

  // Writes the band's segment-list texels AND tallies per-type counts
  // into countScratch in the same pass. Returns the list's start offset.
  const writeBandList = (list, axis /* 2=maxX or 3=maxY */) => {
    const arrIdx = bandBuf.count - glyphLocIdx;
    countScratch[0] = 0; countScratch[1] = 0; countScratch[2] = 0; countScratch[3] = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      // Inline texelXYOf — skips its [hx, hy] 2-array per band-list entry.
      const idx = segHdrIdx[i];
      const hx = idx % TEXTURE_WIDTH;
      const hy = Math.floor(idx / TEXTURE_WIDTH);
      // Bake strokePadEm into breakAxis so the shader's early-break
      // (`segRaw.z - c.x < -halfW`) correctly considers a seg's cap /
      // miter extension past its control bbox. Without this, a pixel
      // inside a free-cap or miter wedge that lies past the seg's
      // control maxX gets the seg skipped → notch at one corner of
      // the cap. For fills strokePadEm is 0 so this is a no-op.
      const breakAxis = segBbsF[i*4 + axis] + strokePadEm;
      // .w packs segType in low 2 bits — lets the shader skip the
      // per-segment curveData header fetch. Upper bits reserved.
      const segType = segTypes[i] & 3;
      countScratch[segType]++;
      texelAppend(bandBuf, hx, hy, breakAxis, segType);
    }
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

  return {
    glyphLoc: [glyphLocX, glyphLocY],
    bandMaxX: bandsX - 1,
    bandMaxY: bandsY - 1,
    bbox: bbox.slice(),
    numSegments: segs.length,
  };
}
