// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shared GLSL helpers for CSS Compositing & Blending Level 1 blend modes
// (feBlend, COLRv1 PaintComposite, final-FB mix-blend-mode compositor).
//
// Operates on UNPREMULTIPLIED RGB; alpha is composed separately by the
// caller (src-over follows). Output of blend* is unpremultiplied RGB.
// Concatenated by src/shaders/index.js via the @@BLEND_HELPERS@@ marker.

vec3 unpre(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : c.rgb; }

vec3 blendSeparable(int mode, vec3 src, vec3 dst) {
  if (mode == 1)  return src * dst;                              // multiply
  if (mode == 2)  return src + dst - src * dst;                  // screen
  if (mode == 3) {                                                // overlay
    vec3 lo = 2.0 * src * dst;
    vec3 hi = 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
    return mix(lo, hi, step(0.5, dst));
  }
  if (mode == 4)  return min(src, dst);                          // darken
  if (mode == 5)  return max(src, dst);                          // lighten
  if (mode == 6) {                                                // color-dodge
    // Spec guard order: Cb==0 -> 0, else Cs==1 -> 1, else min(1, Cb/(1-Cs)).
    // The Cb (dst) guard must win over the Cs==1 guard.
    vec3 d6 = mix(min(vec3(1.0), dst / max(1.0 - src, 1e-6)),
                  vec3(1.0), step(1.0, src));
    return mix(d6, vec3(0.0), step(dst, vec3(0.0)));
  }
  if (mode == 7) {                                                // color-burn
    // Spec guard order: Cb==1 -> 1, else Cs==0 -> 0, else 1-min(1,(1-Cb)/Cs).
    // The Cb (dst) guard must win over the Cs==0 guard.
    vec3 b7 = mix(1.0 - min(vec3(1.0), (1.0 - dst) / max(src, 1e-6)),
                  vec3(0.0), step(src, vec3(0.0)));
    return mix(b7, vec3(1.0), step(1.0, dst));
  }
  if (mode == 8) {                                                // hard-light
    vec3 lo = 2.0 * src * dst;
    vec3 hi = 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
    return mix(lo, hi, step(0.5, src));
  }
  if (mode == 9) {                                                // soft-light
    vec3 d = mix(((16.0*dst - 12.0)*dst + 4.0)*dst, sqrt(dst), step(0.25, dst));
    vec3 lo = dst - (1.0 - 2.0*src) * dst * (1.0 - dst);
    vec3 hi = dst + (2.0*src - 1.0) * (d - dst);
    return mix(lo, hi, step(0.5, src));
  }
  if (mode == 10) return abs(dst - src);                         // difference
  if (mode == 11) return src + dst - 2.0 * src * dst;            // exclusion
  // Flash AS3 BlendMode extensions. Saturating arithmetic keeps the
  // output in [0,1] so the src-over downstream stays well-defined.
  if (mode == 16) return min(src + dst, vec3(1.0));               // add
  if (mode == 17) return max(dst - src, vec3(0.0));               // subtract
  if (mode == 18) return vec3(1.0) - dst;                         // invert (ignores src.rgb)
  return src;  // normal fallback (mode 0)
}

// Non-separable HSL helpers per W3C Compositing & Blending § 10.
float lum(vec3 c) { return 0.3*c.r + 0.59*c.g + 0.11*c.b; }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0)  c = l + ((c - l) * l) / (l - n);
  if (x > 1.0)  c = l + ((c - l) * (1.0 - l)) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float cmin = min(min(c.r, c.g), c.b);
  float cmax = max(max(c.r, c.g), c.b);
  if (cmax - cmin > 0.0) return (c - cmin) * (s / (cmax - cmin));
  return vec3(0.0);
}
vec3 blendNonSeparable(int mode, vec3 src, vec3 dst) {
  if (mode == 12) return setLum(setSat(src, sat(dst)), lum(dst));  // hue
  if (mode == 13) return setLum(setSat(dst, sat(src)), lum(dst));  // saturation
  if (mode == 14) return setLum(src, lum(dst));                    // color
  if (mode == 15) return setLum(dst, lum(src));                    // luminosity
  return src;
}

// One-stop dispatch for both halves.
//   0          = normal (pass-through src)
//   1..11      = separable (CSS Compositing 1)
//   12..15     = non-separable (HSL — hue/saturation/color/luminosity)
//   16..18     = Flash AS3 extras (add, subtract, invert)
vec3 blendDispatch(int mode, vec3 src, vec3 dst) {
  return (mode >= 12 && mode <= 15)
    ? blendNonSeparable(mode, src, dst)
    : blendSeparable(mode, src, dst);
}
