// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { sampleMorphGradientParams } from '../core/morphImageFrames.js';
import { withPreparation } from '../renderer/memoryLedger.js';
import { hasRetainedSvgSource } from '../core/exportSource.js';
import { rebuildMorphCurvatures } from '../core/morphCurvatures.js';
import { prepareMorphDashMetrics, updateMorphDashMetrics } from '../core/morphDashMetrics.js';
import {
  deleteGlResource,
  resourceGeneration,
  resourceScope,
  trackGlResource,
  createTrackedProgram,
} from '../renderer/contextResources.js';
/**
 * @typedef {object} ShapeMorphOptions
 * @property {boolean} [cpuLerp=false] Force CPU curve interpolation; small planes may use it automatically.
 * @property {boolean} [alignFullTurnDirection=false] Match a full-turn arc's direction
 *   to its paired partial arc. Can change dash phase and compound-path winding.
 * @property {'spec'|'chrome'} [compat='spec'] An arc flag that differs between the poses: 'spec' is 1 at every pose between them (SVG 2, 9.3.2);
 *   'chrome' steps it at t = 0.5, as Chrome's `d` animation does.
 * @property {'spec'|'shortest'} [arcRotation='spec'] An arc's rotation: 'spec' lerps the number each pose states, so poses written with a running angle spin;
 *   'shortest' spells the destination's ellipse the nearest way to the source's first.
 */
// Name-based shape morphing. Matched shapes interpolate compatible curve planes;
// unmatched source and target shapes fade through per-shape visibility overrides.
// Shapes without ids match by position.

import { createBundle, makeTex, makeTableTex } from '../renderer/bundle.js';
import {
  tableDims,
  tableTexel,
  packTable,
  uploadTableRows,
  GRAD_COLS,
  META_COLS,
} from '../renderer/tableLayout.js';
import { buildDrawList } from '../renderer/bundle.js';
import { requestOcclusionCull } from '../renderer/occlusionWorkerPool.js';
import { mantleDebugFlag } from '../core/diagnostics.js';
import { noteExternalGlWrite } from '../core/glEpoch.js';
import {
  gradientStopsLutSize,
  padGradientStopsLut,
  META_GLYPH_LOC_X,
  META_GLYPH_LOC_Y,
  META_BAND_MAX_X,
  META_BAND_MAX_Y,
} from '../bundle/layout.js';
import { createOverrideTable } from './overrides.js';
import { sampleMorphPose } from '../core/morphPose.js';

import {
  getLerpPass,
  tryLerpPass,
  releaseLerpPass,
  beginLerpPass,
} from '../renderer/morphLerpPass.js';
import { gateFor } from '../renderer/gpuGate.js';
import { auxWarmers } from '../renderer/auxWarm.js';

// Repair arc representation, join tangents and current-pose dash prefixes after
// interpolation. The prepared arguments distinguish endpoint and center-form
// arcs. This pass reads static endpoint planes, never its live output texture.
const _fixupPassByGl = new WeakMap();

export const FIX_ARC_C = 0; // write (cx, cy, rx, ry)
export const FIX_ARC_T = 1; // write (theta_s, theta_e, phi, 0)
// Curvature kinds are 4 + segment type, with bit 3 for endpoint-form arcs.
export const FIX_CURV = 4;
export const FIX_DASH = 3;
export const FIX_JOIN = 2; // write (inTan.xy, outTan.xy)

const FIXUP_VS = `#version 300 es
precision highp float; precision highp int;
layout(location=1) in vec2 aDistance;       // (startDist, the closed dashed contour's length at the seam ends, else 0)
flat out vec2 vDistance;
layout(location=2) in vec4 aStrokeFrame;
flat out vec4 vStrokeFrame;
layout(location=0) in ivec4 aFix;   // (outTexel, kind, argA, argB)
flat out ivec4 vFix;
uniform int uW, uH;
void main() {
  vFix = aFix; vDistance = aDistance; vStrokeFrame = aStrokeFrame;
  int i = aFix.x;
  vec2 p = (vec2(float(i % uW), float(i / uW)) + 0.5) / vec2(float(uW), float(uH));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const FIXUP_FS = `#version 300 es
precision highp float; precision highp int;
flat in ivec4 vFix;
flat in vec2 vDistance;
#ifdef MANTLE_CURVATURE_FIXUP
flat in vec4 vStrokeFrame;
#endif
uniform highp sampler2D uA, uB;
uniform float uT;
uniform int uW;
out vec4 o;

// The lerped value of one texel — mixed HERE from the two static planes, which is
// what keeps this pass independent of the mix that already ran.
vec4 fx(int texel) {
  ivec2 c = ivec2(texel % uW, texel / uW);
  return mix(texelFetch(uA, c, 0), texelFetch(uB, c, 0), uT);
}

float fxMax(vec2 v) { return max(abs(v.x), abs(v.y)); }
float fxLength(vec2 v) {
  float m = fxMax(v);
  return m > 0.0 ? m * length(v / m) : 0.0;
}

// SVG F.6.5 endpoint -> center, including the F.6.6 radii correction. Mid-lerp the
// endpoints move independently of the radii, so the correction genuinely fires —
// and scaling the radii up to span the chord is exactly the right answer when it does.
// Returns (cx, cy, rx, ry) in .xyzw and writes (theta_s, theta_e) to th.
vec4 arcCenter(int hdr, out vec2 th, out float outPhi) {
  vec4 d0 = fx(hdr + 1);              // p1.xy, p4.xy
  vec4 d1 = fx(hdr + 2);              // rx, ry, phi, flags
  vec2 p1 = d0.xy, p4 = d0.zw;
  float rx = abs(d1.x), ry = abs(d1.y), phi = d1.z;
  outPhi = phi;
  int flags = int(d1.w + 0.5);
  float large = float(flags & 1), sweep = float((flags >> 1) & 1);
  float cp = cos(phi), sp = sin(phi);
  vec2 m = (p1 - p4) * 0.5;
  float x1p =  cp * m.x + sp * m.y;
  float y1p = -sp * m.x + cp * m.y;
  if (rx == 0.0 || ry == 0.0) {
    vec2 chord = p4 - p1;
    float len = fxLength(chord);
    if (len == 0.0) { th = vec2(0.0); return vec4(p1, 0.0, 0.0); }
    vec2 c = (p1 + p4) * 0.5;
    float angle = atan(chord.y, chord.x);
    float t0;
    if (ry == 0.0) { rx = len * 0.5; ry = 0.0; phi = angle; t0 = 3.14159265358979324; }
    else { rx = 0.0; ry = len * 0.5; phi = angle - 1.57079632679489662; t0 = -1.57079632679489662; }
    float dt = sweep > 0.5 ? 3.14159265358979324 : -3.14159265358979324;
    th = vec2(t0, t0 + dt); outPhi = phi;
    return vec4(c, rx, ry);
  }
  float lam = (x1p / rx) * (x1p / rx) + (y1p / ry) * (y1p / ry);
  if (lam > 1.0) { float s = sqrt(lam); rx *= s; ry *= s; }
  vec2 q = vec2(x1p / rx, y1p / ry);
  float q2 = dot(q, q);
  // F.6.6 scaled the radii to span the chord exactly, so the center is on it and 1 - q2 is float32 noise, which rx would scale up.
  float sq = (lam <= 1.0 && q2 > 0.0) ? sqrt(max((1.0 - q2) / q2, 0.0)) : 0.0;
  if (large == sweep) sq = -sq;
  float cxp =  sq * rx * (y1p / ry);
  float cyp = -sq * ry * (x1p / rx);
  vec2 c = vec2(cp * cxp - sp * cyp, sp * cxp + cp * cyp) + (p1 + p4) * 0.5;
  vec2 u = vec2((x1p - cxp) / rx, (y1p - cyp) / ry);
  vec2 v = vec2((-x1p - cxp) / rx, (-y1p - cyp) / ry);
  // At a rotation of pi, sin(phi) can be exactly 0 and u.x -0, and atan(+1, -0) read -pi/2 on ANGLE/Metal (with a chord along y): the arc started at its far end
  // and bulged the wrong way. The branch survives the compiler (cover shaders have the same one).
  float t0 = u.x == 0.0 ? (u.y >= 0.0 ? 1.57079632679489662 : -1.57079632679489662) : atan(u.y, u.x);
  // Coincident end points: F.6.2 omits the arc. atan(0, 0) has no answer to give, and read a sweep on ANGLE/Metal.
  float dt = q2 > 0.0 ? atan(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y) : 0.0;
  if (sweep < 0.5 && dt > 0.0) dt -= 6.28318530717958647;
  if (sweep > 0.5 && dt < 0.0) dt += 6.28318530717958647;
  th = vec2(t0, t0 + dt);
  return vec4(c, rx, ry);
}

// Unit tangent of the segment whose header is at texel hdr, at its start or end.
// Same derivative conventions (and degenerate fallbacks) as textures.js segTangentAt.
vec2 segTangent(int hdr, bool atStart) {
  // -1 is a free end; lower values encode endpoint-form arc headers.
  bool endpointArc = hdr < -1;
  if (endpointArc) hdr = -hdr - 2;
  int ty = int(fx(hdr).x + 0.5) & 3;
  vec2 d;
  float roundScale = 0.0;
  if (ty == 3) {                                  // ARC
    vec2 th; float phi; vec4 cr;
    if (endpointArc) cr = arcCenter(hdr, th, phi);
    else { cr = fx(hdr + 1); vec4 angles = fx(hdr + 2); th = angles.xy; phi = angles.z; }
    float rx = cr.z, ry = cr.w;
    if (rx == 0.0 || ry == 0.0) {
      vec4 ends = endpointArc ? fx(hdr + 1) : fx(hdr + 3);
      d = ends.zw - ends.xy;
    } else {
      float t = atStart ? th.x : th.y;
      float dth = th.y - th.x;
      float cp = cos(phi), sp = sin(phi), ct = cos(t), st = sin(t);
      d = vec2((-cp * rx * st - sp * ry * ct) * dth,
               (-sp * rx * st + cp * ry * ct) * dth);
    }
    roundScale = fxMax(cr.xy) + fxMax(cr.zw);
  } else if (ty == 0) {                           // LINE
    vec4 a = fx(hdr + 1);
    d = a.zw - a.xy;
    roundScale = max(fxMax(a.xy), fxMax(a.zw));
  } else {                                        // QUAD / CUBIC
    vec4 a = fx(hdr + 1), b = fx(hdr + 2);
    vec2 p1 = a.xy, p2 = a.zw, p3 = b.xy, p4 = b.zw;
    float u = atStart ? 0.0 : 1.0, mu = 1.0 - u;
    vec2 lo = min(min(p1, p2), p3), hi = max(max(p1, p2), p3);
    if (ty == 2) { lo = min(lo, p4); hi = max(hi, p4); }
    float dirMin = 1e-9 * max(hi.x - lo.x, hi.y - lo.y);
    roundScale = max(max(fxMax(p1), fxMax(p2)), fxMax(p3));
    if (ty == 2) roundScale = max(roundScale, fxMax(p4));
    if (ty == 1) {
      d = 2.0 * mu * (p2 - p1) + 2.0 * u * (p3 - p2);
      if (!(fxLength(d) > dirMin)) d = p3 - p1;
    } else {
      d = 3.0*mu*mu*(p2-p1) + 6.0*mu*u*(p3-p2) + 3.0*u*u*(p4-p3);
      if (!(fxLength(d) > dirMin)) { d = p3 - p2; if (!(fxLength(d) > dirMin)) d = p4 - p1; }
    }
  }
  float m = fxMax(d);
  if (!(m > 0.0)) return vec2(0.0);
  vec2 v = d / m;
  float n = length(v);
  if (roundScale > 0.0 && (m / roundScale) * n <= 1.4210854715202004e-14) return vec2(0.0);
  return v / n;
}

#ifdef MANTLE_CURVATURE_FIXUP
// Exact binary scaling prevents products of raw coordinate scales.
float fxScaleExponent(float x, int power) {
  uint bits=floatBitsToUint(x),signBit=bits&0x80000000u,mantissa=bits&0x007fffffu;
  int exponent=int((bits>>23)&255u);
  if(exponent==255 || (exponent==0 && mantissa==0u))return x;
  if(exponent==0){
    exponent=1;
    for(int i=0;i<23 && (mantissa&0x00800000u)==0u;i++){mantissa<<=1;exponent--;}
    mantissa&=0x007fffffu;
  }
  exponent+=power;
  if(exponent>=255)return uintBitsToFloat(signBit|0x7f800000u);
  if(exponent>0)return uintBitsToFloat(signBit|(uint(exponent)<<23)|mantissa);
  if(exponent < -23)return uintBitsToFloat(signBit);
  uint significand=0x00800000u|mantissa;
  int shift=1-exponent;
  uint rounded=significand>>shift,remainder=significand&((1u<<shift)-1u),halfway=1u<<(shift-1);
  if(remainder>halfway || (remainder==halfway && (rounded&1u)!=0u))rounded++;
  return uintBitsToFloat(signBit|rounded);
}

float segCurvature(int hdr, bool atStart) {
  if (hdr == -1) return 0.0;
  bool endpointArc = hdr < -1;
  if (endpointArc) hdr = -hdr - 2;
  int ty = int(fx(hdr).x) & 3;
  if (ty == 0) return 0.0;
  mat2 N = mat2(vStrokeFrame.xy, vStrokeFrame.zw);
  vec2 d, a;
  if (ty == 3) {
    vec2 th; float phi; vec4 cr;
    if (endpointArc) cr = arcCenter(hdr, th, phi);
    else { cr=fx(hdr+1); vec4 angles=fx(hdr+2); th=angles.xy; phi=angles.z; }
    if (cr.z == 0.0 || cr.w == 0.0 || th.x == th.y) return 0.0;
    float theta=atStart?th.x:th.y,ct=cos(theta),st=sin(theta),cp=cos(phi),sp=sin(phi);
    d=N*vec2(-cp*cr.z*st-sp*cr.w*ct,-sp*cr.z*st+cp*cr.w*ct);
    a=N*vec2(-cp*cr.z*ct+sp*cr.w*st,-sp*cr.z*ct-cp*cr.w*st);
    if(th.y<th.x)d=-d;
  } else {
    vec4 p=fx(hdr+1),q=fx(hdr+2);
    vec2 p0=N*p.xy,p1=N*p.zw,p2=N*q.xy,p3=N*q.zw;
    vec2 lo=min(min(p0,p1),p2),hi=max(max(p0,p1),p2);
    if (ty==1) {d=2.0*(atStart?p1-p0:p2-p1);a=2.0*(p0-2.0*p1+p2);}
    else {lo=min(lo,p3);hi=max(hi,p3);d=3.0*(atStart?p1-p0:p3-p2);a=6.0*(atStart?p0-2.0*p1+p2:p1-2.0*p2+p3);}
    if (!(fxLength(d)>1e-9*max(hi.x-lo.x,hi.y-lo.y))) return 0.0;
  }
  float m=fxMax(d);
  if (!(m>0.0)) return 0.0;
  int power=127-int((floatBitsToUint(m)>>23)&255u);
  vec2 u=vec2(fxScaleExponent(d.x,power),fxScaleExponent(d.y,power));
  vec2 v=vec2(fxScaleExponent(a.x,power),fxScaleExponent(a.y,power));
  float n=length(u);
  float curvature=(u.x*v.y-u.y*v.x)/(n*n*n);
  return fxScaleExponent(curvature,power);
}

#endif

void main() {
  int kind = vFix.y;
  #ifdef MANTLE_CURVATURE_FIXUP
  if (kind >= ${FIX_CURV}) {
    int ty=(kind-${FIX_CURV})&3;
    int hdr=vFix.x-(ty==0?3:ty==3?5:4);
    if((kind&8)!=0)hdr=-hdr-2;
    o=vec4(segCurvature(hdr,true),segCurvature(hdr,false),segCurvature(vFix.z,false),segCurvature(vFix.w,true));
  } else
  #endif
  if (kind == ${FIX_DASH}) {
    // startDist at the pose; and, on the first (w bit 0) / last (bit 1) segment of a closed dashed contour, its length as -L in the free-end field the
    // encoder puts it in (svg/textures.js encodeSeg). vDistance.y is 0 where the pose has none: the lerped field (an end pose's own) stays.
    vec4 h = fx(vFix.z);
    o = vec4(h.x, ((vFix.w & 1) != 0 && vDistance.y > 0.0) ? -vDistance.y : h.y, ((vFix.w & 2) != 0 && vDistance.y > 0.0) ? -vDistance.y : h.z, vDistance.x);
  } else if (kind == ${FIX_JOIN}) {
    vec2 inT  = vFix.z != -1 ? segTangent(vFix.z, false) : vec2(0.0);
    vec2 outT = vFix.w != -1 ? segTangent(vFix.w, true)  : vec2(0.0);
    o = vec4(inT, outT);
  } else {
    vec2 th; float phi; vec4 cr = arcCenter(vFix.z, th, phi);
    o = (kind == ${FIX_ARC_C}) ? cr : vec4(th, phi, 0.0);
  }
}`;

/// The blocking form (non-blocking mode off): compiles, links and validates on the spot, waiting for the driver.
function getFixupPassBlocking(gl, curvature) {
  let variants = _fixupPassByGl.get(gl);
  if (!variants) {
    variants = new Map();
    _fixupPassByGl.set(gl, variants);
  }
  let p = variants.get(curvature);
  const generation = resourceGeneration(gl);
  if (p && p.generation === generation) return p;
  const prog = createTrackedProgram(gl);
  let vs = null,
    fs = null;
  const sh = (type, src) => {
    const s = trackGlResource(gl, gl.createShader(type));
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(s);
      deleteGlResource(gl, 'Shader', s);
      throw new Error('fixupPass: ' + info);
    }
    return s;
  };
  try {
    vs = sh(gl.VERTEX_SHADER, FIXUP_VS);
    fs = sh(
      gl.FRAGMENT_SHADER,
      curvature
        ? FIXUP_FS.replace('#version 300 es', '#version 300 es\n#define MANTLE_CURVATURE_FIXUP')
        : FIXUP_FS,
    );
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('fixupPass link: ' + gl.getProgramInfoLog(prog));
  } catch (error) {
    deleteGlResource(gl, 'Program', prog);
    throw error;
  } finally {
    if (vs) deleteGlResource(gl, 'Shader', vs);
    if (fs) deleteGlResource(gl, 'Shader', fs);
  }
  p = {
    prog,
    generation,
    users: 0,
    curvature,
    uA: gl.getUniformLocation(prog, 'uA'),
    uB: gl.getUniformLocation(prog, 'uB'),
    uT: gl.getUniformLocation(prog, 'uT'),
    uW: gl.getUniformLocation(prog, 'uW'),
    uH: gl.getUniformLocation(prog, 'uH'),
  };
  variants.set(curvature, p);
  return p;
}

/// The fixup helper for a curvature variant, or null while its link is unfinished or the GPU thread is behind (gpuGate.js). The first ask
/// compiles and links it and asks nothing of it; a later ask validates it once it is ready. Nothing waits for the driver.
function tryFixupPass(gl, curvature) {
  if (!gateFor(gl).nb) return getFixupPassBlocking(gl, curvature); // blocking mode: build and wait
  let variants = _fixupPassByGl.get(gl);
  if (!variants) {
    variants = new Map();
    _fixupPassByGl.set(gl, variants);
  }
  let p = variants.get(curvature);
  const generation = resourceGeneration(gl);
  if (p && p.generation === generation && !p.pending) return p;
  if (!p || p.generation !== generation) {
    const prog = createTrackedProgram(gl);
    let vs = null,
      fs = null;
    try {
      const sh = (type, src) => {
        const s = trackGlResource(gl, gl.createShader(type));
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      vs = sh(gl.VERTEX_SHADER, FIXUP_VS);
      fs = sh(
        gl.FRAGMENT_SHADER,
        curvature
          ? FIXUP_FS.replace('#version 300 es', '#version 300 es\n#define MANTLE_CURVATURE_FIXUP')
          : FIXUP_FS,
      );
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
    } catch (error) {
      deleteGlResource(gl, 'Program', prog);
      throw error;
    } finally {
      // The program keeps its shaders; their status is read only if the link fails.
      if (vs) deleteGlResource(gl, 'Shader', vs);
      if (fs) deleteGlResource(gl, 'Shader', fs);
    }
    p = { prog, generation, users: 0, curvature, pending: true };
    variants.set(curvature, p);
  }
  if (!gateFor(gl).ready(p.prog)) return null;
  if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
    const logs = [gl.getProgramInfoLog(p.prog)];
    for (const sh of (gl.getAttachedShaders && gl.getAttachedShaders(p.prog)) || [])
      logs.push(gl.getShaderInfoLog(sh));
    deleteGlResource(gl, 'Program', p.prog);
    variants.delete(curvature);
    throw new Error('fixupPass link: ' + logs.join(' '));
  }
  p.uA = gl.getUniformLocation(p.prog, 'uA');
  p.uB = gl.getUniformLocation(p.prog, 'uB');
  p.uT = gl.getUniformLocation(p.prog, 'uT');
  p.uW = gl.getUniformLocation(p.prog, 'uW');
  p.uH = gl.getUniformLocation(p.prog, 'uH');
  p.pending = false;
  return p;
}

/// Build the pipelines of the lerp and fixup passes before any morph needs them: each is drawn once into a 2x2 target of every plane format a morph writes
/// (RGBA32F curves/meta/gradients, RGBA8 gradient stops), the fixup as one point. Returns true once everything has drawn; false while a program still links.
const _passesWarmed = new WeakSet();
function warmMorphPasses(gl, _programReady, gpuClear) {
  if (_passesWarmed.has(resourceScope(gl))) return true; // (per context generation: a restored context has none of these pipelines)
  const lp = tryLerpPass(gl);
  const fp = lp ? tryFixupPass(gl, false) : null,
    fpc = fp ? tryFixupPass(gl, true) : null;
  if (!lp || !fp || !fpc) return false;
  // checkFramebufferStatus is a synchronous round trip to the GPU process: behind a pipeline build in flight it holds the page for the build's length (195 ms measured),
  // so the warm asks again until the GPU thread is clear (the same rule as every other query of the loading call), before it creates anything.
  if (gpuClear && !gpuClear()) return false;
  const ext = gl.getExtension('EXT_color_buffer_float');
  const mk = (internal, format, type) => {
    const tex = trackGlResource(gl, gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 2, 2, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  };
  const vao = trackGlResource(gl, gl.createVertexArray()),
    vb = trackGlResource(gl, gl.createBuffer(), 'morph');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Int32Array([0, 0, 0, 0]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 4, gl.INT, 0, 0);
  gl.bindVertexArray(null);
  const fbo = trackGlResource(gl, gl.createFramebuffer());
  const src = mk(gl.RGBA32F, gl.RGBA, gl.FLOAT);
  try {
    // STEP 1: every format's framebuffer status, before any draw. The query is a synchronous round trip to the GPU process; asked after the first format's draws it
    // would wait behind the pipelines those draws queued (the gate above saw a clear GPU thread, the loop would make it busy).
    const targets = [];
    for (const [internal, format, type] of [
      [gl.RGBA32F, gl.RGBA, gl.FLOAT],
      [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    ]) {
      if (internal === gl.RGBA32F && !ext) continue;
      const dst = mk(internal, format, type);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) targets.push(dst);
    }
    // STEP 2: the draws.
    for (const dst of targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      gl.viewport(0, 0, 2, 2);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(lp.prog);
      gl.activeTexture(gl.TEXTURE14);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(lp.uA, 14);
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(lp.uB, 15);
      gl.uniform1f(lp.uT, 0.5);
      gl.bindVertexArray(lp.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (const p of [fp, fpc]) {
        gl.useProgram(p.prog);
        gl.uniform1i(p.uA, 14);
        gl.uniform1i(p.uB, 15);
        gl.uniform1f(p.uT, 0.5);
        gl.uniform1i(p.uW, 2);
        gl.uniform1i(p.uH, 2);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.POINTS, 0, 1);
      }
      gl.bindVertexArray(null);
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    noteExternalGlWrite();
  }
  // The warmer HOLDS the three programs for the context's life: a morph that is disposed or rebuilt (a resize rebuilds them) would otherwise take their last
  // reference, delete them, and the next setT would link them again in play (112 pipelines after ready in a resize drag of a morph-heavy scene).
  lp.users++;
  fp.users++;
  fpc.users++;
  _passesWarmed.add(resourceScope(gl));
  return true;
}
auxWarmers.add(warmMorphPasses);

function releaseFixupPass(gl, p) {
  if (!p || --p.users > 0) return;
  deleteGlResource(gl, 'Program', p.prog);
  const variants = _fixupPassByGl.get(gl);
  if (variants && variants.get(p.curvature) === p) {
    variants.delete(p.curvature);
    if (!variants.size) _fixupPassByGl.delete(gl);
  }
}

// Pure (gl-free) morph machinery lives in the core so the no-WebGL
// fallback can reuse it without importing this GL module.
import {
  resolveSpriteRange,
  buildMorphPlan,
  composeMorphSections,
  resetVisibility,
  updateVisibility,
  arcRecordToCenter,
  applyArcFlagSteps,
  rebuildJoinTangents,
  restoreArcEndPoses,
} from '../core/morphCore.js';
import { morphRowHasArcs, widenMorphRowForArcs } from '../core/morphArcBounds.js';

// DefineMorphShape2 morphable meta slots, lerped src→dst per matched shape:
//   0..3 bbox (xmin, ymin, xmax, ymax) · 4..7 fillColor RGBA · 8..11 strokeColor RGBA
//   12 strokeWidth (texel 3.x) · 20..23 a pattern carrier's inverse (texel 5; held at src on every other pairing, morphCore.js) ·
//   36..39 imageRect (texel 9). Everything else
// stays at src.
const MORPH_LERP_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 21, 22, 23, 36, 37, 38, 39];

// Float-render-target completeness is a CONTEXT capability (constant once RGBA32F
// is known color-renderable), but checkFramebufferStatus is a sync driver query
// (~ms each on Metal). Cache the verdict per (gl, internalFormat) so buildLerpTarget
// pays it ONCE, not per morph — a scene of many morphs would otherwise spend a large share of a second on redundant checks.
const _floatFboOk = new WeakMap(); // gl → Map(internalFormat → boolean)

/// A bundle seen through its authored band regions: for every row in authoredBandsByShape the meta row's glyphLoc and band maxima are the
/// authored ones (the importer built the drawn bands from a normalized fill list, fillNormalize.js). Same object when there are none.
function withAuthoredBands(b) {
  const ab = b && b.authoredBandsByShape;
  if (!ab || !b.metaFloats) return b;
  const stride = b.metaFloatsPerShape || 48,
    meta = new Float32Array(b.metaFloats);
  for (let i = 0; i < ab.length; i++) {
    const a = ab[i];
    if (!a) continue;
    const o = i * stride;
    meta[o + META_GLYPH_LOC_X] = a.glyphLoc[0];
    meta[o + META_GLYPH_LOC_Y] = a.glyphLoc[1];
    meta[o + META_BAND_MAX_X] = a.bandMaxX;
    meta[o + META_BAND_MAX_Y] = a.bandMaxY;
  }
  const v = Object.create(b);
  v.metaFloats = meta;
  return v;
}

/**
 * Build a morph handle from two source bundles. Both bundles must be
 * createBundle outputs (exposing `shapeIds`, `metaFloats`, etc.).
 *
 * A morph's own `.bundle` may be either bundle: it is sampled at its current t when this morph is built (a snapshot, not a live
 * link: a later `setT` on it does not move this one). Generated hidden rows are retained at t = 0. Changing visibility,
 * gradients or filter opacity at a t above 0 cannot be sampled; use t = 0 or chain the original bundles. User overrides
 * must be restored to their generated values before chaining; arbitrary transforms and paint overrides are not baked.
 *
 * Matched shapes interpolate curves, bounds, paint colors, stroke width and
 * image rectangles. Structural metadata retains the source value, including
 * gradient, filter, blend, clip and mask bindings. Matching clip children can
 * deform the clip geometry. Target-only clip and mask bindings are remapped
 * into the merged layer table.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} srcBundle
 * @param {object} dstBundle
 * @param {ShapeMorphOptions} [opts]
 * @param {boolean} [opts.cpuLerp] lerp poses on the CPU instead of the GPU
 *   pre-pass.
 * @param {boolean} [opts.alignFullTurnDirection=false] Align a full-turn arc's
 *   direction to its paired partial arc. May change dash phase and winding.
 * @param {'spec'|'chrome'} [opts.compat='spec'] How an arc flag that differs between the poses interpolates.
 * @param {'spec'|'shortest'} [opts.arcRotation='spec'] How an arc's rotation interpolates: the number each pose states, or the shorter way round.
 */
export function createShapeMorph(gl, srcBundle, dstBundle, opts) {
  if (!gl) throw new Error('createShapeMorph: gl required');
  if (!srcBundle || !dstBundle)
    throw new Error('createShapeMorph: both source and target bundles required');
  // Mark both poses as morph SOURCES, so the renderer's automatic prewarm skips them (renderer option `warmMorphSources`). Only here, not
  // in createSpriteMorph: a sprite morph's poses are usually one sheet that is also drawn on its own.
  try {
    srcBundle._morphSourcePose = true;
    dstBundle._morphSourcePose = true;
  } catch {
    /* a frozen bundle just keeps its prewarm */
  }
  // Whole-bundle morph = sprite morph with no range restriction.
  return _buildMorph(gl, srcBundle, dstBundle, null, null, opts);
}

/**
 * Morph ONE sprite (a top-level <g id> / lone id'd top-level shape from a
 * sheet, via bundle.spriteRanges) against another. Same handle API as
 * createShapeMorph (bundle / setT / dispose). The morph bundle renders only
 * the sprite; the rest of the sheet is carried but hidden.
 *
 *   const morph = createSpriteMorph(gl,
 *     { bundle: sheet, sprite: 'hero_idle' },     // sprite = id OR [first,last]
 *     { bundle: sheet, sprite: 'hero_run'  });    // dst.bundle may === src.bundle
 *   renderer.drawBundle(morph.bundle, { worldMatrix });
 *   morph.setT(0.5);
 *
 * Shapes within the two sprites match by shapeId (then positionally) and
 * curve-lerp when their per-shape topology matches; mismatched pairs
 * crossfade. For a true geometric morph the two poses should share matched
 * per-shape topology (same shape count + curve sizes, ideally same ids).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{bundle:object, sprite:(string|[number,number])}} srcRef
 * @param {{bundle:object, sprite:(string|[number,number])}} dstRef
 * @param {ShapeMorphOptions} [opts] Options accepted by createShapeMorph.
 */
export function createSpriteMorph(gl, srcRef, dstRef, opts) {
  if (!gl) throw new Error('createSpriteMorph: gl required');
  if (!srcRef || !srcRef.bundle || !dstRef || !dstRef.bundle)
    throw new Error('createSpriteMorph: srcRef.bundle and dstRef.bundle required');
  const srcRange = resolveSpriteRange(srcRef.bundle, srcRef.sprite, 'src');
  const dstRange = resolveSpriteRange(dstRef.bundle, dstRef.sprite, 'dst');
  // Same-bundle overlapping ranges are a malformed request (a sprite can't
  // morph against itself / an overlapping span).
  if (srcRef.bundle === dstRef.bundle && srcRange[0] <= dstRange[1] && dstRange[0] <= srcRange[1]) {
    throw new Error(
      'createSpriteMorph: src and dst sprites overlap in the ' +
        'same bundle (ranges [' +
        srcRange +
        '] and [' +
        dstRange +
        ']); ' +
        'morph two DISTINCT sprites, or use separate bundles.',
    );
  }
  return _buildMorph(gl, srcRef.bundle, dstRef.bundle, srcRange, dstRange, opts);
}

// Shared core for whole-bundle (createShapeMorph) and per-sprite
// (createSpriteMorph) morphs. srcRange / dstRange are inclusive
// [first, last] shape-index ranges, or null = the whole bundle. When a
// range is set, only that sprite's shapes participate (the morph bundle
// contains just those rows + dst-only appends); the curve / band /
// curveGeom / gradient / filter / atlas planes are forwarded whole from
// src so the meta rows' absolute indices into them stay valid (slicing
// those would require re-indexing every side table).
const NO_EXPORT_SOURCE = Object.freeze({ svgSource: null });

// Snapshot a morph endpoint at its current pose. Generated zero visibility is
// retained separately from metadata; unsupported fades and overrides are rejected.
function morphPoseSource(b, side) {
  const ms = b && b._morphSrc;
  if (!ms) return b;
  const t = +ms.t || 0;
  const packed = b._morphOverrides && b._morphOverrides.packedBuffer;
  const generatedFades =
    ms.endpointVisibilityMoves ||
    (ms.matchedSrcIdxs && ms.matchedSrcIdxs.length < (b.numShapes | 0));
  if (packed)
    for (let row = 0; row < b.numShapes; row++) {
      const o = row * 24;
      const initial = ms.initialHiddenRows && ms.initialHiddenRows.has(row) ? 0 : 1;
      if (
        packed[o] !== 1 ||
        packed[o + 1] !== 0 ||
        packed[o + 2] !== 0 ||
        packed[o + 3] !== 1 ||
        packed[o + 4] !== 0 ||
        packed[o + 5] !== 0 ||
        packed[o + 7] !== 0 ||
        packed[o + 8] !== 1 ||
        packed[o + 9] !== 1 ||
        packed[o + 10] !== 1 ||
        packed[o + 11] !== 1 ||
        ((!(t > 0) || !generatedFades) && packed[o + 6] !== initial)
      ) {
        throw new Error(
          'createShapeMorph: the ' +
            side +
            ' has overrides a chained morph cannot snapshot. Clear user transforms, colors, tint, visibility and group overrides, or chain the original bundles.',
        );
      }
    }
  if (!(t > 0)) {
    if (!ms.initialHiddenRows) return b;
    // The generated fade table is immutable here: the shallow pose retains its endpoint zeros.
    const view = Object.create(b);
    view._morphEndpointHidden = ms.initialHiddenRows;
    return view;
  }
  const moving = [];
  if (ms.matchedSrcIdxs && ms.matchedSrcIdxs.length < (b.numShapes | 0))
    moving.push('shapes that fade in or out');
  if (ms.endpointVisibilityMoves) moving.push('shapes that fade in or out');
  if (ms.paintMovesWithT) moving.push('gradients that change');
  if (ms.filterOpacityPairs)
    for (const [, pair] of ms.filterOpacityPairs)
      if (pair[0] !== pair[1]) {
        moving.push('filter opacity');
        break;
      }
  const pose = moving.length ? null : sampleMorphPose(b);
  const curveLen = b.curveFloats instanceof Float32Array ? b.curveFloats.length : 0;
  const metaLen = b.metaFloats ? b.metaFloats.length : 0;
  if (
    moving.length ||
    !pose ||
    !pose.curve ||
    !pose.meta ||
    pose.curve.length < curveLen ||
    pose.meta.length < metaLen
  ) {
    throw new Error(
      'createShapeMorph: the ' +
        side +
        ' is a morph bundle at t = ' +
        t +
        (moving.length
          ? ' with ' + moving.join(' and ') + ', which a chained morph cannot start from'
          : ' whose pose cannot be sampled') +
        '. Set its t to 0 first, or chain the original bundles (createShapeTimeline takes N poses).',
    );
  }
  const view = Object.create(b);
  view.curveFloats = pose.curve.slice(0, curveLen); // copies: the pose cache reuses its planes
  view.metaFloats = pose.meta.slice(0, metaLen);
  view._morphSrc = null;
  if (ms.initialHiddenRows) view._morphEndpointHidden = ms.initialHiddenRows;
  return view;
}

function _buildMorph(gl, srcBundle, dstBundle, srcRange, dstRange, opts) {
  return withPreparation('createShapeMorph', gl, () =>
    _buildMorphImpl(gl, srcBundle, dstBundle, srcRange, dstRange, opts),
  );
}

function _buildMorphImpl(gl, srcBundle, dstBundle, srcRange, dstRange, opts) {
  srcBundle = morphPoseSource(srcBundle, 'source');
  dstBundle = morphPoseSource(dstBundle, 'destination');
  // a shape whose bands were built without a contained contour morphs from its AUTHORED bands
  srcBundle = withAuthoredBands(srcBundle);
  dstBundle = withAuthoredBands(dstBundle);
  // 1. Categorize shapes by id (or positional index for blank ids),
  //    scoped to the sprite ranges when set.
  const plan = buildMorphPlan(srcBundle, dstBundle, srcRange, dstRange);

  const sections = composeMorphSections(srcBundle, dstBundle, plan, opts);
  // The STATIC cull must not run here: it decides what is hidden from the geometry as
  // authored, and these sections are only the t=0 pose — setT lerps every control
  // point, so a shape buried at t=0 can be fully exposed at t=1. The morph gets its
  // own cull instead (below), which decides containment across the whole animation.
  // Recolor is a BUNDLE property, and a morph INHERITS it from its poses: content
  // that is recolored at t=0 and t=1 is recolored at every t between. The morph
  // bundle is rebuilt on each bracket transition, so without this the fill variant
  // would be re-derived — and self-healed, mid-play — on every new bracket.
  const recolor = !!((srcBundle && srcBundle.recolor) || (dstBundle && dstBundle.recolor));
  const bundle = createBundle(gl, sections, { occlusionCull: false, recolor });
  // No-AA (band-hard) eligibility for a stroke-covered morph: the covering stroke hides the fill's
  // AA band throughout the morph, so band-hard fits (the per-frame band the fill pass already
  // rebuilds carries it — no extra cost). Require both endpoints covered, else the fill edge shows
  // mid-morph. Do not rebuild the GWN tree per frame; cubic and arc morphs use
  // band-hard only at low segment counts, otherwise AAC.
  if (srcBundle && dstBundle && srcBundle.noAaFill && dstBundle.noAaFill) {
    bundle.noAaFill = true;
    bundle.minStrokeEmW =
      Math.min(srcBundle.minStrokeEmW || 0, dstBundle.minStrokeEmW || 0) ||
      srcBundle.minStrokeEmW ||
      dstBundle.minStrokeEmW ||
      0;
  }

  // Mark the bundle so the renderer's GPU-resident Loop-Blinn morph route
  // (opt-in via renderer.setLoopBlinnMorphFill) can build per-shape morph meshes
  // from the STATIC endpoints and lerp on the GPU, replacing this setT's
  // per-frame CPU lerp + texture uploads. Only morphs whose shapes ALL matched
  // (no fade in/out) are routable. `t` is updated every setT; `skipUploads` is
  // flipped on by the renderer once it routes.
  // Matched shapes' native ranges in the merged source/destination planes,
  // in float units. Fixed fades retain their separate exact ranges below.
  const _morphCurveRanges = [];
  for (const m of plan.matched) _morphCurveRanges[m.srcIdx] = { begin: m.srcBegin, end: m.srcEnd };
  // Runtime endpoint fades cannot be opaque occluders throughout the morph.
  if (plan.endpointVisibilityPairs)
    for (const [row] of plan.endpointVisibilityPairs) {
      if (_morphCurveRanges[row]) _morphCurveRanges[row].canOcclude = false;
    }
  const dashMetricPlan = prepareMorphDashMetrics(sections);
  const filterOpacityPairs = new Map();
  const filterOpacity = (b, row) => {
    const fid = Math.round(b.metaFloats[row * (b.metaFloatsPerShape || 48) + 32]);
    const data = b.lastFilterFloats || (b.filterTab ? new Float32Array(b.filterTab) : null);
    return fid > 0 && data ? 1 - data[(fid - 1) * 24 + 23] : 1;
  };
  const stepAt = new Map();
  for (const e of sections._morphBindingSteps || []) if (e.slot === 32) stepAt.set(e.row, e.at);
  for (const match of plan.matched) {
    const pair = [
      filterOpacity(plan.srcView || srcBundle, match.srcIdx),
      filterOpacity(plan.dstView || dstBundle, match.dstIdx),
    ];
    if (stepAt.has(match.srcIdx)) pair.push(stepAt.get(match.srcIdx)); // the filter switches here: its own opacity switches with it
    filterOpacityPairs.set(match.srcIdx, pair);
  }
  const paintMovesWithT =
    (sections._gradParamPlan || []).some(
      (row) =>
        row.imageFrames ||
        row.lerpSlots.some((slot) => {
          const i = row.baseF + slot;
          return sections._srcGradParamsF[i] !== sections._dstGradParamsF[i];
        }),
    ) ||
    (sections._gradStopPlan || []).some((row) => {
      for (let k = 0; k < row.byteLength; k++)
        if (
          sections._srcGradStopsB[row.srcByteOffset + k] !==
          sections._dstGradStopsB[row.dstByteOffset + k]
        )
          return true;
      return false;
    });
  // Metadata motion comes from the slots the GPU actually interpolates (MORPH_LERP_SLOTS) on the matched rows, never
  // from resource addresses (gradient/image/clip ids), which are immutable between the endpoints. A prepared fill
  // draws its geometry from its own endpoint streams, so it needs the raw curve plane only for a stroke band walk or a
  // clip, mask or filter composition (rows whose headers carry them).
  const metaStride = sections._metaStride | 0,
    sourceMeta = sections._mergedMetaF32,
    targetMeta = sections._dstAlignedMetaF32;
  let metaMovesWithT = false,
    preparedCurveIndependent = plan.matched.length === (bundle.numShapes | 0);
  for (const srcIdx of sections._matchedSrcIdxs || []) {
    const base = srcIdx * metaStride;
    for (const slot of MORPH_LERP_SLOTS) {
      if (sourceMeta[base + slot] !== targetMeta[base + slot]) metaMovesWithT = true;
    }
    for (const meta of [sourceMeta, targetMeta]) {
      if (meta[base + 11] > 0 && meta[base + 12] > 0) preparedCurveIndependent = false;
      for (const slot of [30, 31, 32, 33, 34, 43, 45])
        if (meta[base + slot] !== 0) preparedCurveIndependent = false;
    }
  }
  // A destination clip or mask binding lands as a texel patch at t = 1, from setT's meta section: a draw that skips the
  // uploads would never land it.
  if ((sections._morphBindingSteps || []).length) {
    metaMovesWithT = true;
    preparedCurveIndependent = false;
  }
  bundle._morphSrc = {
    metaMovesWithT,
    preparedCurveIndependent,
    paintMovesWithT,
    filterOpacityPairs,
    gradientParams: sections._srcGradParamsF,
    targetGradientParams: sections._dstGradParamsF,
    gradientStops: sections._srcGradStopsB,
    targetGradientStops: sections._dstGradStopsB,
    gradientParamPlan: sections._gradParamPlan,
    gradientStopPlan: sections._gradStopPlan,
    dashMetricPlan,
    mergedCurveF32: sections._mergedCurveF32,
    dstCurveF32: sections._dstCurveF32,
    // Endpoint-form planes for arc-bearing morphs (center-form lerp tears the
    // contour). Hit tests use these the same way setT's CPU lerp does.
    srcEpCurveF32: sections._srcEpCurveF32 || null,
    dstEpCurveF32: sections._dstEpCurveF32 || null,
    arcOffsets: sections._arcOffsets || null,
    arcEndPoseRanges: sections._arcEndPoseRanges,
    arcFlagSteps: sections._arcFlagSteps,
    arcRotationShortest: opts?.arcRotation === 'shortest',
    joinTable: sections._joinTable || null,
    curvatureRows: sections._curvatureRows,
    curveRanges: _morphCurveRanges,
    // Unmatched geometry is fixed; these ranges survive endpoint disposal.
    fixedCurveRanges: sections._fixedCurveRanges,
    mergedMetaF32: sections._mergedMetaF32,
    dstMetaF32: sections._dstAlignedMetaF32,
    metaStride: sections._metaStride,
    matchedSrcIdxs: sections._matchedSrcIdxs || null,
    bindingSteps: sections._morphBindingSteps || [],
    matchedSrcSet: sections._matchedSrcIdxs ? new Set(sections._matchedSrcIdxs) : null,
    // Arcs do NOT disqualify this route. It reads the two CENTER-form planes,
    // decodes each pose's contours exactly, and lerps the resulting MESH
    // VERTICES — it never interpolates arc PARAMETERS, so it has none of the
    // trouble that forces setT's own lerp into endpoint form (prepareArcMorph).
    endpointVisibilityMoves: !!(
      plan.endpointVisibilityPairs &&
      plan.endpointVisibilityPairs.some((pair) => pair[1] !== pair[2])
    ),
    matchedAll: plan.matched.length === (bundle.numShapes | 0),
    t: 0,
    skipUploads: false,
  };
  // So hit tests can honor fade-in/out without the caller threading overrides.
  try {
    Object.defineProperty(bundle, '_morphOverrides', {
      value: null,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* ignore */
  }

  // 2b. MORPH OCCLUSION CULL, off the main thread. A shape a later opaque shape hides
  //     for the whole morph is never seen, so drawing it only costs — and, along a
  //     shared edge, conflates its color into the antialiased boundary exactly as in
  //     the static case. Endpoint testing would be UNSOUND (an occluder can shrink
  //     faster than what it hides and expose it midway), so morphCull.js eliminates t
  //     analytically and certifies that the boundaries never cross for ANY t. Anything
  //     it cannot certify keeps its draw. Landing late is harmless: until then the
  //     morph simply draws a few shapes nobody can see.
  // _morphCullPending is true from here until the reply has been applied or discarded; a caller (and the smokes) wait
  // on it instead of a fixed delay. requestOcclusionCull always answers, so it always clears.
  bundle._morphCullPending = true;
  requestOcclusionCull(
    {
      cv: sections._mergedCurveF32,
      cv1: sections._dstCurveF32, // cv1 ⇒ a morph job
      meta: sections._mergedMetaF32,
      meta1: sections._dstAlignedMetaF32,
      n: bundle.numShapes | 0,
      stride: sections._metaStride | 0,
      ranges: _morphCurveRanges,
    },
    (culled) => {
      bundle._morphCullPending = false;
      if (bundle._disposed || !culled || !culled.length) return;
      const set = new Set(culled);
      bundle._culledShapes = set;
      bundle.drawList = buildDrawList(
        bundle.metaFloats,
        bundle.numShapes,
        bundle.metaFloatsPerShape,
        bundle.chunkByShape,
        bundle.filterGraphs,
        set,
        bundle._drawOrder,
        bundle._drawAltMeta,
      );
    },
  );

  // 3. Private override table for fade-in / fade-out. Initial state
  //    matches t = 0: src + matched fully visible, dst-only invisible.
  const overrides = createOverrideTable(gl, bundle);
  resetVisibility(overrides, plan, /* t = */ 0);
  bundle._morphOverrides = overrides;
  // No extra container for an ordinary fully matched endpoint.
  let initialHiddenRows = null;
  const initialPacked = overrides.packedBuffer;
  // resetVisibility can produce a zero only from an unmatched destination, a sprite exclusion, or a retained endpoint zero.
  if (
    plan.dstOnly.length ||
    (plan.hidden && plan.hidden.length) ||
    plan.endpointSourceHidden ||
    plan.endpointVisibilityPairs
  )
    for (let row = 0; row < bundle.numShapes; row++)
      if (initialPacked[row * 24 + 6] === 0) {
        if (!initialHiddenRows) initialHiddenRows = new Set();
        initialHiddenRows.add(row);
      }
  bundle._morphSrc.initialHiddenRows = initialHiddenRows;

  let metaPing = null,
    metaPingI = 0;
  let lerpCurves = null;
  // Parallel scratch for the gradient-stops byte plane. Lazily
  // allocated the first time setT needs to upload non-baseline stops.
  let lerpStopsBytes = null;
  // DefineMorphShape2 lerp scratches (meta + gradient params).
  // lerpMeta: same shape as `_mergedMetaF32`, which re-uploads the
  // bundle's meta texture per setT.
  let lerpMeta = null;
  let lerpGradParams = null;
  let lastT = 0;
  let disposed = false;
  // ── GPU texture-lerp targets ──────────────────────────────────────────
  // Each plane (curve / gradient-stops / meta / gradient-params) is morphed by
  // a render-to-texture pre-pass: mix(srcTex, dstTex, t) → the live texture, no
  // per-frame CPU lerp + texSubImage2D. `dst` is the t=1 FULL plane (src with
  // only the morphing slots overlaid by dst values), so mix reproduces the
  // per-slot lerp. Falls back to a CPU lerp+upload when the render target isn't
  // available (EXT_color_buffer_float absent). Built lazily on first setT.
  // `undefined` = not built, `null` = no data, object = built.
  let _ltCurve, _ltStops, _ltMeta, _ltGrad;
  let _lerpPass = null,
    _fixupPass = null;
  try {
    beginLerpPass(gl);
  } catch {
    /* best-effort: the first setT builds it */
  }
  /// The rect covering every [srcBegin, srcEnd) float range, in texels (4 floats each). Null when
  /// the ranges cover so much of the plane that a rect is no saving, or when there are none.
  function dirtyRect(ranges, W, H) {
    if (!ranges || !ranges.length || !(W > 0) || !(H > 0)) return null;
    let lo = Infinity,
      hi = -Infinity;
    for (const m of ranges) {
      if (m.srcBegin < lo) lo = m.srcBegin;
      if (m.srcEnd > hi) hi = m.srcEnd;
    }
    if (!(hi > lo)) return null;
    const t0 = Math.floor(lo / 4),
      t1 = Math.min(W * H, Math.ceil(hi / 4));
    const y0 = Math.floor(t0 / W),
      y1 = Math.floor((t1 - 1) / W);
    const rect =
      y0 === y1
        ? { x: t0 - y0 * W, y: y0, w: t1 - t0, h: 1 }
        : { x: 0, y: y0, w: W, h: y1 - y0 + 1 };
    // Not worth a narrower viewport if it is most of the plane anyway.
    return rect.w * rect.h >= W * H * 0.9 ? null : rect;
  }

  /// `dirty` is the sub-rect of the plane whose two sides actually DIFFER — everything outside it
  /// mixes a value with itself and writes back what was already there.
  ///
  /// The curve plane is 4096 texels wide and a morph of four curves changes NINETEEN of them, so
  /// a whole-plane pass would shade over 200x what it writes, twice a frame, on every Slug
  /// morph. Passing null keeps the whole plane, which is what the callers that have not worked
  /// out their own span do.
  function buildLerpTarget(liveTex, src, dst, W, H, internal, format, type, cpuFallback, dirty) {
    // CPU fallback when GPU float render targets can't be set up: the
    // explicit opt (opts.cpuLerp — parity tests compare both paths), or a
    // stub/limited GL context (no getExtension) where the cpuFallback's
    // plain texSubImage2D upload still works.
    if ((opts && opts.cpuLerp) || typeof gl.getExtension !== 'function')
      return { gpu: false, cpuFallback };
    // A SMALL PLANE never USES THE GPU PATH, so do not build it one. Attaching the live texture
    // to a framebuffer makes it a render target as well as a sampler source for the rest of the
    // morph's life, and the per-frame texSubImage2D that then writes it has to be hazard-checked
    // against that. Building the target and never running it would also cost two textures of every
    // plane it was built for. `gpuSmallPlanes` still forces the pass, and asks for the target it
    // needs by skipping this.
    if (W * H <= SMALL_PLANE_TEXELS && !(bundle._morphSrc && bundle._morphSrc.gpuSmallPlanes))
      return { gpu: false, cpuFallback };
    gl.getExtension('EXT_color_buffer_float');
    const srcTex = makeTex(gl, src, W, H, internal, format, type);
    const dstTex = makeTex(gl, dst, W, H, internal, format, type);
    const fbo = trackGlResource(gl, gl.createFramebuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, liveTex, 0);
    // Completeness is constant per (context, format) — check once, cache the verdict.
    let fboCache = _floatFboOk.get(gl);
    if (!fboCache) {
      fboCache = new Map();
      _floatFboOk.set(gl, fboCache);
    }
    let ok = fboCache.get(internal);
    if (ok === undefined) {
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      fboCache.set(internal, ok);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      deleteGlResource(gl, 'Framebuffer', fbo);
      deleteGlResource(gl, 'Texture', srcTex);
      deleteGlResource(gl, 'Texture', dstTex);
      return { gpu: false, cpuFallback };
    }
    return { gpu: true, srcTex, dstTex, fbo, W, H, cpuFallback, dirty: dirty || null };
  }
  // Uploads use unit14 and invalidate the fill unit shadow through glEpoch.
  // Restore active unit0 afterward; stubs use their single texture unit.
  const uploadTex = (tex, upload) => {
    const hasAT = typeof gl.activeTexture === 'function';
    if (!hasAT) {
      // stub context: nothing shadows anything
      gl.bindTexture(gl.TEXTURE_2D, tex);
      upload();
      gl.bindTexture(gl.TEXTURE_2D, null);
      noteExternalGlWrite();
      return;
    }

    gl.activeTexture(gl.TEXTURE14);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // A/B INSTRUMENT: the same bytes, uploaded again. Output-identical, so the delta over dup=0
    // prices ONE paint upload with everything else held fixed.
    const dup = (bundle._morphSrc && bundle._morphSrc.dupUpload) | 0;
    for (let d = 0; d < dup; d++) upload();
    upload();
    gl.activeTexture(gl.TEXTURE0);
    noteExternalGlWrite();
  };

  // Small planes use CPU interpolation to avoid framebuffer/program transitions.
  // Larger curve planes use the GPU. The gpuSmallPlanes diagnostic flag forces
  // the GPU path for small-plane accuracy and timing comparisons.
  const SMALL_PLANE_TEXELS = 4096;

  function runLerpTarget(tgt, t) {
    // every path through here writes GL state the renderer shadows — the CPU one binds a texture
    // and moves the active unit just as the GPU one does — so every path has to announce it.
    // A CPU fallback that did not would render a blank shape: the renderer would go on
    // believing unit 14 held what it had put there.
    if (!tgt.gpu) {
      tgt.cpuFallback(t);
      return;
    }
    // Checked HERE rather than in buildLerpTarget because the targets are memoized on first use,
    // which for a CPatch morph happens before the route has announced itself.
    if (
      tgt.cpuFallback &&
      tgt.W * tgt.H <= SMALL_PLANE_TEXELS &&
      !(bundle._morphSrc && bundle._morphSrc.gpuSmallPlanes)
    ) {
      tgt.cpuFallback(t);
      return;
    }
    // THE PASSES ARE ASKED FOR, NOT WAITED FOR. A helper that is still linking (or behind pipeline builds queued ahead of any query on it) is not
    // touched: the CPU interpolation writes the same texels this frame (counted in the source's `lerpCpuStandIns`), and the GPU takes over the
    // first frame the programs are ready.
    const lp = tryLerpPass(gl);
    const fpTry =
      lp && tgt.fix && tgt.fix.count ? tryFixupPass(gl, sections._curvatureRows.length > 0) : null;
    if (!lp || (tgt.fix && tgt.fix.count && !fpTry)) {
      if (tgt.cpuFallback) {
        if (bundle._morphSrc)
          bundle._morphSrc.lerpCpuStandIns = (bundle._morphSrc.lerpCpuStandIns | 0) + 1;
        tgt.cpuFallback(t);
        return;
      }
      // (no CPU twin for this target: it keeps its last COMPLETE pose until both passes are ready. Running the mix without its fixup would leave arcs in
      // endpoint form and join tangents unnormalized in the plane -- a fragmenting shape.)
      return;
    }
    if (!_lerpPass) {
      _lerpPass = lp;
      lp.users++;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    const d = tgt.dirty;
    if (d) gl.viewport(d.x, d.y, d.w, d.h);
    else gl.viewport(0, 0, tgt.W, tgt.H);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(lp.prog);
    gl.activeTexture(gl.TEXTURE14);
    gl.bindTexture(gl.TEXTURE_2D, tgt.srcTex);
    gl.uniform1i(lp.uA, 14);
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, tgt.dstTex);
    gl.uniform1i(lp.uB, 15);
    gl.uniform1f(lp.uT, t);
    gl.bindVertexArray(lp.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    // Pass 2: overwrite the texels the plain mix cannot get right — arc data
    // (endpoint form -> center form) and stroke join tangents (recomputed from
    // the lerped geometry). Same FBO, same t, but it re-mixes from the STATIC
    // planes rather than reading what pass 1 just wrote, so the two passes are
    // independent and no ping-pong is needed.
    if (tgt.fix && tgt.fix.count) {
      // The fixup pass places its POINTS from texel indices over the whole plane, so it needs the
      // full viewport back regardless of how narrow the mix above was.
      if (d) gl.viewport(0, 0, tgt.W, tgt.H);
      const fp = fpTry || tryFixupPass(gl, sections._curvatureRows.length > 0);
      if (!fp) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        noteExternalGlWrite();
        return;
      }
      if (!_fixupPass) {
        _fixupPass = fp;
        fp.users++;
      }
      gl.useProgram(fp.prog);
      gl.activeTexture(gl.TEXTURE14);
      gl.bindTexture(gl.TEXTURE_2D, tgt.srcTex);
      gl.uniform1i(fp.uA, 14);
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, tgt.dstTex);
      gl.uniform1i(fp.uB, 15);
      gl.uniform1f(fp.uT, t);
      gl.uniform1i(fp.uW, tgt.W);
      gl.uniform1i(fp.uH, tgt.H);
      gl.bindVertexArray(tgt.fix.vao);
      gl.drawArrays(gl.POINTS, 0, tgt.fix.count);
      gl.bindVertexArray(null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    // A PUBLIC entry point driven with the consumer's own gl, so it can land
    // between (or during) renderer frames. It rewrote viewport, blend, depth,
    // scissor, program, VAO and texture units 14/15 — none of which reach the
    // renderer's shadows. Bump AFTER the writes: doing it first lets anything
    // that syncs in between repopulate the shadow, and these then land
    // invisibly. See core/glEpoch.js.
    noteExternalGlWrite();
  }

  /** One point per texel the mix gets wrong. Attributes are (outTexel, kind,
   *  argA, argB): for an arc, argA is its record's HEADER texel; for a join,
   *  argA/argB identify neighboring headers: -1 is free, values below -1
   *  encode endpoint-form arcs as -header-2, and other values are direct. */
  // Curvature points additionally carry the source stroke frame. Their
  // derivatives are evaluated on the GPU; the frame buffer is preparation-only.
  function buildFixupPoints(arcOffsets, joinTable, dashPlan, curvatureRows) {
    const nArc = arcOffsets ? arcOffsets.length : 0;
    const nJoin = joinTable ? joinTable.length / 6 : 0;
    const nDash = dashPlan ? dashPlan.values.length >> 1 : 0;
    const nCurv = curvatureRows.length;
    const count = nArc * 2 + nJoin + nDash + nCurv;
    if (!count) return null;
    const a = new Int32Array(count * 4);
    const endpointArcs = new Set(arcOffsets || []);
    const tangentArg = (off) => (off < 0 ? -1 : endpointArcs.has(off) ? -(off >> 2) - 2 : off >> 2);
    let k = 0;
    for (let i = 0; i < nArc; i++) {
      const hdr = arcOffsets[i] >> 2; // float offset -> texel
      a[k++] = hdr + 1;
      a[k++] = FIX_ARC_C;
      a[k++] = hdr;
      a[k++] = 0;
      a[k++] = hdr + 2;
      a[k++] = FIX_ARC_T;
      a[k++] = hdr;
      a[k++] = 0;
    }
    for (let i = 0; i < nJoin; i++) {
      // Row 0 is already the JOIN texel's float slot (buildJoinTable resolved the
      // line-vs-rest record-size difference); prev/next are HEADER float offsets.
      const prev = joinTable[i * 6 + 2];
      const next = joinTable[i * 6 + 4];
      a[k++] = joinTable[i * 6] >> 2;
      a[k++] = FIX_JOIN;
      a[k++] = tangentArg(prev);
      a[k++] = tangentArg(next);
    }
    const distanceOffset = nArc * 2 + nJoin;
    let dashAt = 0;
    if (dashPlan)
      for (const row of dashPlan.rows)
        for (const off of row.offsets) {
          a[k++] = off >> 2;
          a[k++] = FIX_DASH;
          a[k++] = off >> 2;
          a[k++] = dashPlan.flags[dashAt++];
        }
    const frames = nCurv ? new Float32Array(count * 4) : null;
    for (const r of curvatureRows) {
      const index = k / 4;
      a[k++] = r.out >> 2;
      a[k++] = FIX_CURV + r.type + (endpointArcs.has(r.off) ? 8 : 0);
      a[k++] = tangentArg(r.prev);
      a[k++] = tangentArg(r.next);
      frames.set(r.frame, index * 4);
    }
    const vao = trackGlResource(gl, gl.createVertexArray());
    const vb = trackGlResource(gl, gl.createBuffer(), 'morph');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 4, gl.INT, 0, 0);
    let distanceBuffer = null;
    if (nDash) {
      distanceBuffer = trackGlResource(gl, gl.createBuffer(), 'morph');
      gl.bindBuffer(gl.ARRAY_BUFFER, distanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, count * 8, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    }
    let frameBuffer = null;
    if (frames) {
      frameBuffer = trackGlResource(gl, gl.createBuffer(), 'morph');
      gl.bindBuffer(gl.ARRAY_BUFFER, frameBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, frames, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    return { vao, vb, count, distanceBuffer, distanceOffset, frameBuffer };
  }

  // Clip/mask bindings switch at the destination endpoint; filters switch at their declared threshold.
  const bindingSteps = sections._morphBindingSteps || [];
  let metaCpuUpload = false,
    stepState = 0;
  const stepOn = (e, t) => t >= (e.at ?? 1);
  const stepThresholds = [...new Set(bindingSteps.map((e) => e.at ?? 1))].sort((a, b) => a - b);
  function bindingState(t) {
    let lo = 0,
      hi = stepThresholds.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (t >= stepThresholds[mid]) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  // GPU mixing restores source bindings each update. Precompute the texels to patch in each interval.
  const bindingPatches = [
    [],
    ...stepThresholds.map((t) => {
      const patches = new Map(),
        stride = sections._metaStride;
      for (const e of bindingSteps) {
        if (!stepOn(e, t)) continue;
        const tex = e.slot >>> 2,
          key = e.row * 64 + tex;
        let patch = patches.get(key);
        if (!patch) {
          const base = e.row * stride + tex * 4;
          patch = { row: e.row, tex, data: sections._mergedMetaF32.slice(base, base + 4) };
          patches.set(key, patch);
        }
        patch.data[e.slot & 3] = e.value;
      }
      return [...patches.values()];
    }),
  ];
  function syncBindingFloats(t) {
    const state = bindingState(t);
    if (state === stepState) return;
    stepState = state;
    const merged = sections._mergedMetaF32,
      live = bundle.metaFloats,
      stride = sections._metaStride;
    for (const e of bindingSteps)
      live[e.row * stride + e.slot] = stepOn(e, t) ? e.value : merged[e.row * stride + e.slot];
    patchFilterOps();
  }
  // The draw list's ops carry the filter id they were built with (renderer/bundle.js buildDrawList): a row whose filter steps takes the
  // new one on the ops it drew with, and the group-run marks that were read from the previous ones are read again.
  let filterRows = null;
  function patchFilterOps() {
    if (!filterRows)
      filterRows = new Set(bindingSteps.filter((e) => e.slot === 32).map((e) => e.row));
    if (!filterRows.size || !bundle.drawList) return;
    const live = bundle.metaFloats,
      st = sections._metaStride,
      graphs = bundle.filterGraphs;
    for (const op of bundle.drawList) {
      if (op.kind === 'groupEnd' || !filterRows.has(op.shapeIdx)) continue;
      const id = Math.round(live[op.shapeIdx * st + 32]);
      if (op.kind === 'groupBegin') {
        op.filterId = id;
        continue;
      }
      delete op.filterId;
      delete op.filterGraphId;
      if (id > 0) {
        if (graphs && graphs[id - 1]) op.filterGraphId = id;
        else op.filterId = id;
      }
    }
    bundle._atlasMarks = null;
  }
  function patchBindingTexels() {
    for (const patch of bindingPatches[stepState]) {
      uploadTex(bundle.metaTex, () => {
        const [tx, ty] = tableTexel(META_COLS, patch.tex, patch.row);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, ty, 1, 1, gl.RGBA, gl.FLOAT, patch.data);
      });
    }
  }

  // The GPU mix lerps the bbox slots linearly, which is smaller than an arc's extent mid-morph (morphArcBounds.js): the
  // rows that carry arcs get their box texel (texel 0) rewritten with the widened box.
  let arcBoundRows = null,
    arcBoundScratch = null;
  function patchArcBoundTexels(tt) {
    if (!(tt > 0 && tt < 1)) return;
    const ms = bundle._morphSrc,
      stride = sections._metaStride | 0,
      merged = sections._mergedMetaF32,
      dstM = sections._dstAlignedMetaF32;
    if (!arcBoundRows) {
      arcBoundRows = (sections._matchedSrcIdxs || []).filter((r) => morphRowHasArcs(ms, r));
      arcBoundScratch = new Float32Array(stride);
    }
    for (const row of arcBoundRows) {
      const base = row * stride,
        ti = 1 - tt;
      for (const s of MORPH_LERP_SLOTS)
        arcBoundScratch[s] = merged[base + s] * ti + dstM[base + s] * tt;
      if (!widenMorphRowForArcs(ms, arcBoundScratch, 0, row, tt)) continue;
      uploadTex(bundle.metaTex, () => {
        {
          const [tx, ty] = tableTexel(META_COLS, 0, row);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            tx,
            ty,
            1,
            1,
            gl.RGBA,
            gl.FLOAT,
            arcBoundScratch.subarray(0, 4),
          );
        }
      });
    }
  }

  /** Upload the morph state for parameter t. */
  function setT(t) {
    if (disposed) return;
    t = clamp01(t);
    if (t === lastT && t !== 0) return;
    lastT = t;
    bundle._morphSrc.t = t;
    if (bindingSteps.length) syncBindingFloats(t);
    // Prepared geometry with constant metadata and paint needs no texture update.
    // Keep unmatched-shape visibility current even when uploads are skipped.
    if (bundle._morphSrc.skipUploads) {
      updateVisibility(overrides, plan, t);
      return;
    }
    // 1. Curves (matched shapes).

    if (plan.matched.length && !bundle._morphSrc.skipCurveUploads) {
      if (_ltCurve === undefined) {
        const W = sections._curveW,
          H = sections._curveH;
        // An arc-bearing morph interpolates the ENDPOINT-form planes, not the
        // center-form ones: a componentwise lerp of center form pulls an arc's
        // endpoints off the contour and the fill tears (morphCore.prepareArcMorph).
        // Stroked segments likewise carry their neighbors' UNIT tangents in the
        // join texel, and a lerp of two unit vectors is neither unit nor tangent
        // to the lerped curve (buildJoinTable).
        //
        // Neither is fatal to the GPU route: both are repaired by the FIXUP pass,
        // which re-mixes the two static planes itself and overwrites just those
        // texels (see getFixupPass). So the mix stays on the GPU, and the CPU
        // closure below is only the fallback for contexts with no float FBO.
        const arcs = sections._arcOffsets;
        const joins = sections._joinTable;
        const hasArcs = !!(arcs && arcs.length);
        const hasJoins = !!(joins && joins.length);
        const merged = hasArcs ? sections._srcEpCurveF32 : sections._mergedCurveF32;
        const dstPlane = hasArcs ? sections._dstEpCurveF32 : sections._dstCurveF32;
        const t1 = merged.slice();
        for (const m of plan.matched) t1.set(dstPlane.subarray(m.srcBegin, m.srcEnd), m.srcBegin);
        const cpuLerp = (tt) => {
          if (!lerpCurves) lerpCurves = new Float32Array(merged.length);
          lerpCurves.set(merged);
          for (const m of plan.matched) {
            const d = dstPlane.subarray(m.srcBegin, m.srcEnd),
              s = merged.subarray(m.srcBegin, m.srcEnd),
              o = lerpCurves.subarray(m.srcBegin, m.srcEnd);
            for (let i = 0; i < o.length; i++) o[i] = s[i] * (1 - tt) + d[i] * tt;
          }
          // Endpoint form -> center form, in place, for every arc the morph carries.
          applyArcFlagSteps(lerpCurves, sections._arcFlagSteps, tt);
          if (hasArcs) for (let i = 0; i < arcs.length; i++) arcRecordToCenter(lerpCurves, arcs[i]);
          // THEN the joins: an arc's tangent is only defined once it is back in
          // center form.
          if (hasJoins) rebuildJoinTangents(lerpCurves, joins);
          rebuildMorphCurvatures(lerpCurves, sections._curvatureRows);
          if (dashMetricPlan) updateMorphDashMetrics(dashMetricPlan, tt, lerpCurves);
          restoreArcEndPoses(
            lerpCurves,
            sections._arcEndPoseRanges,
            tt,
            sections._mergedCurveF32,
            sections._dstCurveF32,
          );
          uploadTex(bundle.curveTex, () => {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, lerpCurves);
          });
        };
        // THE SPAN THAT MOVES. Only matched shapes' curves differ between the two planes, and
        // they sit in known float ranges; everything else mixes a value with itself. A span
        // inside one row is that row's slice, a wider one rounds out to whole rows — the only
        // other shape whose stride matches the plane.
        _ltCurve = buildLerpTarget(
          bundle.curveTex,
          merged,
          t1,
          W,
          H,
          gl.RGBA32F,
          gl.RGBA,
          gl.FLOAT,
          cpuLerp,
          dirtyRect(plan.matched, W, H),
        );
        // The fixup pass rides the GPU route only; the CPU closure does the same
        // repairs itself, in JS.
        if (_ltCurve.gpu)
          _ltCurve.fix = buildFixupPoints(arcs, joins, dashMetricPlan, sections._curvatureRows);
      }
      if (
        _ltCurve.gpu &&
        dashMetricPlan &&
        (_ltCurve.W * _ltCurve.H > SMALL_PLANE_TEXELS || bundle._morphSrc.gpuSmallPlanes)
      ) {
        const values = updateMorphDashMetrics(dashMetricPlan, t);
        gl.bindBuffer(gl.ARRAY_BUFFER, _ltCurve.fix.distanceBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, _ltCurve.fix.distanceOffset * 8, values);
      }
      // A/B INSTRUMENT: the same mix, run again into the same target. Output-identical, so the
      // delta over dup=0 prices ONE curve-plane lerp pass with everything else held fixed.
      for (let d = 0, n = (bundle._morphSrc && bundle._morphSrc.dupCurveLerp) | 0; d < n; d++)
        runLerpTarget(_ltCurve, t);
      // The fixup pass rebuilds arcs under the planes' one flag value; an end pose whose own flags differ comes from the CPU twin, and so does every pose of a stepping flag (compat: 'chrome').
      if (
        sections._arcEndPoseRanges &&
        (t === 0 || t === 1 || sections._arcFlagSteps) &&
        _ltCurve.cpuFallback
      )
        _ltCurve.cpuFallback(t);
      else runLerpTarget(_ltCurve, t);
    }
    // 2. Gradient stops (RGBA8 — color-renderable without the float ext).
    if (
      sections._gradStopPlan &&
      sections._gradStopPlan.length &&
      sections._srcGradStopsB &&
      sections._dstGradStopsB &&
      bundle.gradientStopsTex
    ) {
      if (_ltStops === undefined) {
        // The LUT texture is rows of GRAD_STOPS_LUT_W texels (bundle/layout.js), so both planes
        // go up padded to its whole rows; the lerp touches only the matched stops' bytes.
        const src = padGradientStopsLut(sections._srcGradStopsB);
        const [W, H] = gradientStopsLutSize(sections._srcGradStopsB.length >>> 2);
        const t1 = src.slice();
        for (const r of sections._gradStopPlan)
          for (let k = 0; k < r.byteLength; k++)
            t1[r.srcByteOffset + k] = sections._dstGradStopsB[r.dstByteOffset + k];
        _ltStops = buildLerpTarget(
          bundle.gradientStopsTex,
          src,
          t1,
          W,
          H,
          gl.RGBA8,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          (tt) => {
            if (!lerpStopsBytes) lerpStopsBytes = new Uint8Array(src.length);
            lerpStopsBytes.set(src);
            const ti = 1 - tt;
            for (const r of sections._gradStopPlan)
              for (let k = 0; k < r.byteLength; k++)
                lerpStopsBytes[r.srcByteOffset + k] =
                  (src[r.srcByteOffset + k] * ti +
                    sections._dstGradStopsB[r.dstByteOffset + k] * tt +
                    0.5) |
                  0;
            uploadTex(bundle.gradientStopsTex, () => {
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                W,
                H,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                lerpStopsBytes,
              );
            });
          },
        );
      }
      runLerpTarget(_ltStops, t);
    }
    // 3. Meta plane (only the morphable slots differ src↔dst; structural slots
    // — ids/glyphLoc/flags — are identical in src & dst so mix leaves them).
    // Diagnostic skip; disabling metadata interpolation changes visible bounds.
    if (
      plan.matched.length &&
      bundle.metaTex &&
      sections._mergedMetaF32 &&
      sections._dstAlignedMetaF32 &&
      !(bundle._morphSrc && bundle._morphSrc.skipMetaLerp)
    ) {
      if (_ltMeta === undefined) {
        const merged = sections._mergedMetaF32,
          stride = sections._metaStride,
          FULL_META_W = 12,
          mh = (merged.length / (FULL_META_W * 4)) | 0;
        if (mh > 0) {
          const t1 = merged.slice();
          for (const srcIdx of sections._matchedSrcIdxs) {
            const base = srcIdx * stride;
            for (const s of MORPH_LERP_SLOTS) t1[base + s] = sections._dstAlignedMetaF32[base + s];
          }
          const metaDims = tableDims(FULL_META_W, mh); // > 4096 shapes: the table wraps in bands (renderer/tableLayout.js)
          _ltMeta = buildLerpTarget(
            bundle.metaTex,
            packTable(merged, FULL_META_W, mh),
            packTable(t1, FULL_META_W, mh),
            metaDims.w,
            metaDims.h,
            gl.RGBA32F,
            gl.RGBA,
            gl.FLOAT,
            (tt) => {
              if (!lerpMeta) lerpMeta = new Float32Array(merged.length);
              lerpMeta.set(merged);
              const ti = 1 - tt;
              metaCpuUpload = true;
              for (const srcIdx of sections._matchedSrcIdxs) {
                const base = srcIdx * stride;
                for (const s of MORPH_LERP_SLOTS) {
                  const o = base + s;
                  lerpMeta[o] = merged[o] * ti + sections._dstAlignedMetaF32[o] * tt;
                }
              }
              for (const e of bindingSteps)
                if (stepOn(e, tt)) lerpMeta[e.row * stride + e.slot] = e.value;
              // Rotate metadata textures to avoid overwriting the previous draw's
              // input. Texture identity also invalidates the fill binding cache.
              if (metaPing && metaPing.length > 1) {
                metaPingI = (metaPingI + 1) % metaPing.length;
                const tx = metaPing[metaPingI];
                uploadTex(tx, () => {
                  uploadTableRows(gl, FULL_META_W, 0, mh - 1, lerpMeta);
                });
                bundle.metaTex = tx;
              } else {
                uploadTex(bundle.metaTex, () => {
                  uploadTableRows(gl, FULL_META_W, 0, mh - 1, lerpMeta);
                });
              }
            },
          );

          const nPing =
            bundle._morphSrc && bundle._morphSrc.metaPingPong != null
              ? bundle._morphSrc.metaPingPong | 0
              : 3;
          if (nPing > 1 && mh > 0 && !metaPing) {
            metaPing = [bundle.metaTex];
            bundle._metaRing = metaPing; // so the bundle's dispose frees the extra planes
            for (let i = 1; i < nPing; i++)
              metaPing.push(makeTableTex(gl, merged, FULL_META_W, mh));
            metaPingI = 0;
          }
        } else _ltMeta = null;
      }
      if (_ltMeta) {
        metaCpuUpload = false;
        runLerpTarget(_ltMeta, t);
        // The GPU pass writes the texture its framebuffer was built on, the ring's first. A CPU stand-in (the helper still linking) rotates
        // the live plane away from it, and it would stay frozen at that pose for good.
        if (_ltMeta.gpu && !metaCpuUpload && metaPing && bundle.metaTex !== metaPing[0]) {
          metaPingI = 0;
          bundle.metaTex = metaPing[0];
        }
        // The GPU mix keeps source bindings; active steps are applied afterward.
        if (bindingSteps.length && !metaCpuUpload && stepState > 0) patchBindingTexels();
        patchArcBoundTexels(t);
      }
    }
    // 4. Gradient params (gradient_transform + focal + axis endpoints).
    if (
      sections._gradParamPlan &&
      sections._gradParamPlan.length &&
      sections._srcGradParamsF &&
      sections._dstGradParamsF &&
      bundle.gradientTex
    ) {
      if (_ltGrad === undefined) {
        const src = sections._srcGradParamsF,
          gradCount = src.length >>> 4;
        if (gradCount > 0) {
          const t1 = src.slice();
          for (const p of sections._gradParamPlan)
            for (const s of p.lerpSlots) t1[p.baseF + s] = sections._dstGradParamsF[p.baseF + s];
          const imageFrames = sections._gradParamPlan.some((p) => p.imageFrames);
          const fallback = (tt) => {
            if (!lerpGradParams) lerpGradParams = new Float32Array(src.length);
            sampleMorphGradientParams(
              lerpGradParams,
              src,
              sections._dstGradParamsF,
              sections._gradParamPlan,
              tt,
            );
            uploadTex(bundle.gradientTex, () => {
              uploadTableRows(gl, GRAD_COLS, 0, gradCount - 1, lerpGradParams);
            });
          };
          _ltGrad = imageFrames
            ? { gpu: false, cpuFallback: fallback }
            : buildLerpTarget(
                bundle.gradientTex,
                packTable(src, GRAD_COLS, gradCount),
                packTable(t1, GRAD_COLS, gradCount),
                tableDims(GRAD_COLS, gradCount).w,
                tableDims(GRAD_COLS, gradCount).h,
                gl.RGBA32F,
                gl.RGBA,
                gl.FLOAT,
                fallback,
              );
        } else _ltGrad = null;
      }
      if (_ltGrad) runLerpTarget(_ltGrad, t);
    }
    // Visibility fade for src-only / dst-only.
    updateVisibility(overrides, plan, t);
  }
  // (the draw applies a user's pose through it: renderer drawBundle `morphT`, for a morph several timelines share)
  Object.defineProperty(bundle, '_morphSetT', {
    value: setT,
    configurable: true,
    writable: true,
    enumerable: false,
  });

  // Re-run the curve lerp for the current t (setT returns early for an unchanged t). The CPatch morph re-specifies the curve
  // texture, whose base rows it seeds from pose A, and turns the lerp back on for a bundle whose Slug rows read it.
  bundle._morphSrc.relerp = () => {
    const tt = lastT;
    lastT = NaN;
    setT(tt);
  };

  /** Release all GL resources owned by the morph. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (overrides) overrides.dispose();
    bundle._morphOverrides = null;
    if (bundle && bundle._morphSrc) bundle._morphSrc = null;
    for (const tgt of [_ltCurve, _ltStops, _ltMeta, _ltGrad]) {
      if (tgt && tgt.gpu) {
        deleteGlResource(gl, 'Framebuffer', tgt.fbo);
        deleteGlResource(gl, 'Texture', tgt.srcTex);
        deleteGlResource(gl, 'Texture', tgt.dstTex);
      }
      if (tgt && tgt.fix) {
        deleteGlResource(gl, 'VertexArray', tgt.fix.vao);
        deleteGlResource(gl, 'Buffer', tgt.fix.vb);
        deleteGlResource(gl, 'Buffer', tgt.fix.distanceBuffer);
        deleteGlResource(gl, 'Buffer', tgt.fix.frameBuffer);
      }
    }
    releaseLerpPass(gl, _lerpPass);
    releaseFixupPass(gl, _fixupPass);
    _lerpPass = _fixupPass = null;
    if (bundle && bundle.dispose) bundle.dispose();
  }

  // SVG-export back-reference (request-time reconstruction). The morph
  // bakes interpolated geometry into the GPU curve texture, so the lerped
  // path lives only on the GPU — there is no CPU `d` string to serialize.
  // Stash just the inputs the export path needs to rebuild it on demand:
  // the two source bundles, the optional sprite ranges, and a live read of
  // the current parameter. renderer.exportFrameSVG() reads this, builds a
  // native morph (CPU `curveRangeToPathD`) for the same src/dst, and ticks
  // it to `t`. Non-enumerable so it doesn't perturb bundle iteration.
  const keepSources = hasRetainedSvgSource(srcBundle);
  try {
    Object.defineProperty(bundle, '__exportMorph', {
      value: {
        // The export rebuilds a native morph from the two sources, which needs their retained markup (createNativeMorph throws
        // without `svgSource`). A source imported without retainSource can never be exported, so holding it here only kept its
        // CPU planes and GL textures alive for the morph's whole life (~65 MB of 112 on the six-pair scene). A frozen stand-in
        // with no svgSource makes createNativeMorph throw exactly as before.
        srcBundle: keepSources ? srcBundle : NO_EXPORT_SOURCE,
        dstBundle: keepSources ? dstBundle : NO_EXPORT_SOURCE,
        // null range = whole-bundle morph (createNativeMorph treats an
        // undefined sprite the same way); a set range is the inclusive
        // [first,last] shape span, which createNativeMorph accepts as a
        // sprite selector.
        compat: opts && opts.compat,
        arcRotation: opts && opts.arcRotation,
        srcSprite: srcRange || undefined,
        dstSprite: dstRange || undefined,
        get t() {
          return lastT;
        },
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* frozen bundle — export falls back to the static src pose */
  }

  // NON-BLOCKING MODE: the lerp targets (their textures are uploads of the whole plane, hundreds of ms behind a GPU job) and the helper programs are
  // built now, while the app is still preparing content, not at the first setT in play. setT(0) is the morph's own initial state.
  if (gateFor(gl).nb) {
    try {
      setT(0);
    } catch {
      /* the first setT in play builds it */
    }
  }
  // The loading call (strictPlay) draws the morph's lerp and fixup passes once more when their programs are ready, so their pipelines are built before
  // play: at creation the programs were still linking and the CPU interpolation wrote the texels.
  bundle._morphWarm = () => {
    if (disposed) return true;
    const m = bundle._morphSrc,
      c0 = m.lerpCpuStandIns | 0;
    try {
      m.relerp();
    } catch {
      return false;
    }
    return (m.lerpCpuStandIns | 0) === c0;
  }; // true once a pass ran on the GPU (no CPU stand-in)

  return {
    get bundle() {
      return bundle;
    },
    get overrides() {
      return overrides;
    },
    get plan() {
      return plan;
    },
    get t() {
      return lastT;
    },
    // True once the GPU curve-lerp path is active (RGBA32F render target
    // available), false if it fell back to the CPU lerp + upload.
    get usesGpuCurveLerp() {
      return !!(_ltCurve && _ltCurve.gpu);
    },
    setT,
    dispose,
  };
}

// ---- Plan construction ---------------------------------------------

/**
 * Categorize each shape in src/dst into matched / src-only / dst-only.
 *
 * Matched: same shapeId (when both ids non-empty) AND same byte count
 * in the curve buffer (a proxy for matched per-shape geometry size —
 * an identical-curve-buffer-length check at the per-shape level).
 *
 * Empty-string ids are matched positionally up to the shorter bundle.
 *
 * Returns:
 *   {
 *     matched:    [{srcIdx, dstIdx, srcBegin, srcEnd, dstBegin, dstEnd}],
 *     srcOnly:    [{srcIdx}],
 *     dstOnly:    [{dstIdx}],
 *     finalShapeCount,
 *   }
 */

/// The morph parameter as a number in [0, 1]: a numeric string coerces, NaN reads as 0, +-Infinity clamp.
function clamp01(x) {
  x = +x;
  return x > 1 ? 1 : x > 0 ? x : 0;
}

// ── Internal surface for the no-WebGL fallback ─────────────────────────
// The pure-CPU pieces of the morph (no gl): plan building, section
// composition, sprite-range resolution, and the visibility driver. The
// native morph reuses them so the matching/lerp logic has a single source
// of truth — it differs only in emitting path `d` instead of uploading the
// lerped curve buffer to a texture. Not part of the public package API.
// New code can import from ../core/morphCore.js directly.
export {
  buildMorphPlan as _morphBuildPlan,
  composeMorphSections as _morphComposeSections,
  resolveSpriteRange as _morphResolveSpriteRange,
  updateVisibility as _morphUpdateVisibility,
} from '../core/morphCore.js';
