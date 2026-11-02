// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shared GLSL helpers for ALL gradient sampling (COLRv1 linear/radial/sweep
// paints and the SVG inline fill path). Concatenated by src/shaders/index.js
// via @@GRADIENT_HELPERS@@. All callers share:
//   uniform sampler2D uGradientStops;  // stop LUT, 1 or 2 RGBA8 texels/stop
//
// sampleStops(t, stopsOffset, stopsCount, mode, fw):
//   1. Apply extend mode (0 = pad, 1 = repeat, 2 = reflect).
//   2. Find the bracketing stops and linearly interpolate.
// Returns STRAIGHT (rgb, alpha); the caller premultiplies.

#ifndef MANTLE_NO_GRADIENT
// The interpolation between two STRAIGHT colors. SVG interpolates them as they are. OpenType (CPAL, Interpolation of colors) has a COLR
// gradient interpolate linear-light values with alpha premultiplied into them, alpha itself as it is, then un-premultiply and re-apply the
// sRGB transfer. A COLR paint program defines GRAD_STOPS_COLR. The math runs per fragment on the stops' own 8-bit sRGB values, so nothing is
// quantized in linear light (a linear 8-bit table would band every dark tone); the result is written sRGB-encoded, at one level of 8 bits as
// any other color. uStopsChrome is new MantleFontAsset(bytes, { compat: 'chrome' }): a uniform, so that mode costs no program of its own and
// no draw waits on a link for it. Chrome interpolates the sRGB-encoded values, not premultiplied, which is the mix SVG uses.
#ifdef GRAD_STOPS_COLR
uniform int uStopsChrome;
vec3 stopsToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), greaterThan(c, vec3(0.04045))); }
vec3 stopsToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, greaterThan(c, vec3(0.0031308))); }
vec4 stopsMix(vec4 a, vec4 b, float k) {
  if (uStopsChrome != 0) return mix(a, b, k);
  vec4 m = mix(vec4(stopsToLinear(a.rgb) * a.a, a.a), vec4(stopsToLinear(b.rgb) * b.a, b.a), k);
  return vec4(m.a > 0.0 ? stopsToSrgb(clamp(m.rgb / m.a, 0.0, 1.0)) : vec3(0.0), m.a);
}
#else
#define stopsMix mix
#endif

float applyExtend(float t, int mode) {
  if (mode == 1) {                                                // REPEAT
    return fract(t);
  }
  if (mode == 2) {                                                // REFLECT
    float u = fract(t * 0.5);
    return u < 0.5 ? u * 2.0 : (1.0 - u) * 2.0;
  }
  return clamp(t, 0.0, 1.0);                                      // PAD
}

/// Stop-LUT texel i. The LUT is rows of 2048 texels (bundle/layout.js
/// GRAD_STOPS_LUT_W), so texel i sits at (i % 2048, i / 2048); a LUT of at most
/// 2048 texels is a single row and every i lands on (i, 0), as it always did.
ivec2 gradStopTexel(int i) { return ivec2(i & 2047, i >> 11); }

/// A 2-texel stop's offset from its offset texel b = (hi, mid, lo, 0) / 255:
/// hi/255 + mid/255^2 + lo/255^3. A gradient of at most 256 stops writes mid =
/// lo = 0, so this is exactly b.x for it; a longer one needs the extra digits to
/// keep more than 256 positions apart.
float gradStopOffset(vec4 b) { return b.x + b.y * (1.0 / 255.0) + b.z * (1.0 / 65025.0); }

/// Sample the stops LUT at a position already in [0,1] (no extend wrap),
/// linearly ramping between adjacent stops. Returns STRAIGHT (rgb, alpha);
/// the caller premultiplies, so per-stop alpha reaches the composited output.
///
/// `stopsOffset` is the TEXEL offset into uGradientStops. `stopsCount` is
/// signed: count > 0 = 2-texel layout (straight RGBA + a separate offset
/// texel); count < 0 = 1-texel opaque fast path (one texel = (rgb, offset),
/// implicit alpha 1), which halves the LUT for all-opaque gradients.
///
/// Lower-bound binary search: O(log N) dependent fetches. The two guards
/// below recover the exact t<=first / in-bracket / t>last outcomes (incl.
/// hard stops). The loop runs while the bracket is open, so N stops take
/// ceil(log2 N) probes (8 for 256, as before); the bound of 16 is the
/// 65536-stop cap (bundle/layout.js GRAD_STOPS_MAX).
///
vec4 sampleStopsRaw(float t, int stopsOffset, int stopsCount) {
  if (stopsCount == 0) return vec4(0.0);
  bool oneTexel = stopsCount < 0;
  int count = abs(stopsCount);
  int base = stopsOffset;
  if (count == 1) {
    vec4 c = texelFetch(uGradientStops, gradStopTexel(base), 0);
    return oneTexel ? vec4(c.rgb, 1.0) : c;
  }
  int lo = 0, hi = count - 1;
  // The probed texel: (rgb, offset) in the 1-texel layout, the offset texel in the 2-texel one.
  vec4 hiT = texelFetch(uGradientStops, gradStopTexel(base + (oneTexel ? hi : hi * 2 + 1)), 0);  // at hi
  vec4 prvT = hiT;                                                                                // at lo - 1
  for (int it = 0; it < 16; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    vec4 mT = texelFetch(uGradientStops, gradStopTexel(base + (oneTexel ? mid : mid * 2 + 1)), 0);
    float mo = oneTexel ? mT.a : gradStopOffset(mT); // one fetch per probe either way
    if (mo < t) { lo = mid + 1; prvT = mT; } else { hi = mid; hiT = mT; }
  }
  // Converged: lo == hi, so the stop at lo is hiT's. The 2-texel color texels at lo and lo - 1 are
  // independent of each other; the second is read even where the guards below return first, so that
  // both issue together (lo - 1 clamped to a real stop when lo is 0).
  vec4 curC  = oneTexel ? hiT  : texelFetch(uGradientStops, gradStopTexel(base + lo * 2), 0);
  vec4 prevC = oneTexel ? prvT : texelFetch(uGradientStops, gradStopTexel(base + max(lo - 1, 0) * 2), 0);
  vec4 cur = oneTexel ? vec4(curC.rgb, 1.0) : curC;
  float curOff = oneTexel ? hiT.a : gradStopOffset(hiT);
  if (lo == 0) return cur;                          // t <= first stop
  if (curOff < t) return cur;                       // t > last stop (lo == count-1)
  vec4 prev = oneTexel ? vec4(prevC.rgb, 1.0) : prevC;
  float prevOff = oneTexel ? prvT.a : gradStopOffset(prvT);
  float span = max(curOff - prevOff, 1e-6);
  float k = (t - prevOff) / span;
  return stopsMix(prev, cur, k);                    // straight (rgb, alpha)
}


float stopsFootprintTail(float s, float A, float B) {
  if (s <= 0.0) return 0.0;
  if (s >= A + B) return 1.0;
  if (B <= 0.0) return s / A;
  if (s <= B) return s * s / (2.0 * A * B);
  if (s <= A) return (s - 0.5 * B) / A;
  float r = A + B - s;
  return 1.0 - r * r / (2.0 * A * B);
}

// dt is the pixel's step in UNWRAPPED t along each screen axis (dt/dx, dt/dy), supplied by the
// caller: most callers run in divergent control flow (the pattern loop, a radial gradient's early
// return, per-shape branches of a unified draw), where a derivative taken here would be undefined
//.
vec4 sampleStops(float t, int stopsOffset, int stopsCount, int mode, vec2 dt) {
  if (stopsCount == 0) return vec4(0.0);
  float u = applyExtend(t, mode);
  vec4 here = sampleStopsRaw(u, stopsOffset, stopsCount);
  // PAD: no seam, clamp is continuous. REFLECT runs back the same way at its seam: no
  // discontinuity, nothing to filter.
  if (mode != 1) return here;

  float A = max(abs(dt.x), abs(dt.y)), B = min(abs(dt.x), abs(dt.y)), fw = A + B;
  // Past a quarter of the gradient per pixel it is heavily under-sampled: plain sampling.
  if (fw <= 0.0 || fw > 0.25) return here;
  float dEdge = min(u, 1.0 - u);                      // distance to the nearest seam, in t
  float s = 0.5 * fw - dEdge;                         // how far the footprint reaches past it
  if (s <= 0.0) return here;
  float far = stopsFootprintTail(s, A, B);
  // The far side is sampled a third of its reach past the seam, near its centroid, rather than at
  // the seam itself; the near side at the center. Blend all four channels: the stop sampler returns
  // straight (rgb, alpha) and the alpha must cross-fade too.
  float uOther = (u < 0.5) ? 1.0 - s / 3.0 : s / 3.0;
  vec4 there = sampleStopsRaw(uOther, stopsOffset, stopsCount);
  return stopsMix(here, there, far);
}
#endif
