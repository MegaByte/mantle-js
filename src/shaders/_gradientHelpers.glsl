// Shared GLSL helpers for ALL gradient sampling (COLRv1 linear/radial/sweep
// paints and the SVG inline fill path). Concatenated by src/shaders/index.js
// via @@GRADIENT_HELPERS@@. All callers share:
//   uniform sampler2D uGradientStops;  // stop LUT, 1 or 2 RGBA8 texels/stop
//
// sampleStops(t, stopsOffset, stopsCount, mode):
//   1. Apply extend mode (0 = pad, 1 = repeat, 2 = reflect).
//   2. Find the bracketing stops and linearly interpolate.
// Returns STRAIGHT (rgb, alpha); the caller premultiplies.

#ifndef MANTLE_NO_GRADIENT
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
/// hard stops). 9 iters = ceil(log2(256)) + margin (max 256 stops).
vec4 sampleStopsRaw(float t, int stopsOffset, int stopsCount) {
  if (stopsCount == 0) return vec4(0.0);
  bool oneTexel = stopsCount < 0;
  int count = abs(stopsCount);
  int base = stopsOffset;
  if (count == 1) {
    vec4 c = texelFetch(uGradientStops, ivec2(base, 0), 0);
    return oneTexel ? vec4(c.rgb, 1.0) : c;
  }
  int lo = 0, hi = count - 1;
  for (int it = 0; it < 9; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    float mo = oneTexel                              // one fetch per probe either way
      ? texelFetch(uGradientStops, ivec2(base + mid, 0), 0).a
      : texelFetch(uGradientStops, ivec2(base + mid * 2 + 1, 0), 0).x;
    if (mo < t) lo = mid + 1; else hi = mid;
  }
  vec4 curC = texelFetch(uGradientStops, ivec2(base + (oneTexel ? lo : lo * 2), 0), 0);
  vec4 cur = oneTexel ? vec4(curC.rgb, 1.0) : curC;
  float curOff = oneTexel ? curC.a
                          : texelFetch(uGradientStops, ivec2(base + lo * 2 + 1, 0), 0).x;
  if (lo == 0) return cur;                          // t <= first stop
  if (curOff < t) return cur;                       // t > last stop (lo == count-1)
  vec4 prevC = texelFetch(uGradientStops, ivec2(base + (oneTexel ? (lo - 1) : (lo - 1) * 2), 0), 0);
  vec4 prev = oneTexel ? vec4(prevC.rgb, 1.0) : prevC;
  float prevOff = oneTexel ? prevC.a
                           : texelFetch(uGradientStops, ivec2(base + (lo - 1) * 2 + 1, 0), 0).x;
  float span = max(curOff - prevOff, 1e-6);
  float k = (t - prevOff) / span;
  return mix(prev, cur, k);                         // straight (rgb, alpha)
}

vec4 sampleStops(float t, int stopsOffset, int stopsCount, int mode) {
  if (stopsCount == 0) return vec4(0.0);              // < 0 = 1-texel opaque fast path
  if (mode == 0) {
    // PAD: no seam, clamp is continuous.
    return sampleStopsRaw(clamp(t, 0.0, 1.0), stopsOffset, stopsCount);
  }
  // Edge-AA for REPEAT / REFLECT: at the wrap seam the gradient's last
  // stop and first stop sit ulps apart in t-space but can carry very
  // different colors, producing a hard 1-pixel hairline. Sample both
  // sides of the seam and blend across the pixel's t-width.
  //
  // The trick is to compute fwidth on the WRAPPED coordinate so the
  // window scales with pixel density in render space. fwidth on
  // applyExtend(t) is well-defined everywhere except the seam itself
  // (where it spikes to ~1.0); we cap it to avoid blowout.
  float u = applyExtend(t, mode);
  float fw = fwidth(u);
  // Cap fw so that near the seam we don't widen the window to the
  // whole gradient. Anything past 0.25 (a quarter of the gradient
  // length per pixel) means the gradient is heavily under-sampled —
  // fall back to plain sampling, the seam itself is the smallest
  // artifact at that point.
  if (fw <= 0.0 || fw > 0.25) return sampleStopsRaw(u, stopsOffset, stopsCount);
  float halfW = 0.5 * fw;
  // Distance to the nearest seam in [0,1]. For REPEAT and REFLECT the
  // seams are at u=0 and u=1.
  float dEdge = min(u, 1.0 - u);
  if (dEdge >= halfW) return sampleStopsRaw(u, stopsOffset, stopsCount);
  // Two-sided sample. For REPEAT, the across-seam color is sampled at
  // the OTHER end of the gradient (u→0 side wraps to u≈1, and vice
  // versa). For REFLECT, the gradient runs back the same way, so the
  // across-seam color is sampled at the SAME u — there's no
  // discontinuity. We still take the average to smooth quantization
  // jitter.
  vec4 here = sampleStopsRaw(u, stopsOffset, stopsCount);
  vec4 there;
  if (mode == 1) {
    // REPEAT: cross to the opposite end of [0,1].
    float uOther = (u < 0.5) ? 1.0 : 0.0;
    there = sampleStopsRaw(uOther, stopsOffset, stopsCount);
  } else {
    // REFLECT: across-seam is the same color (mirror image). Just
    // return the in-bounds sample.
    return here;
  }
  // Blend factor: at the exact seam (dEdge=0) → 0.5; at dEdge=halfW
  // → 1.0 (fully on the in-bounds side). Blend all 4 channels — the stop
  // sampler returns straight (rgb, alpha) and the alpha must cross-fade
  // at the seam too.
  float k = 0.5 + 0.5 * (dEdge / halfW);
  return mix(there, here, k);
}
#endif
