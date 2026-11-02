#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feGaussianBlur — one axis of the separable Gaussian, linear-sampled
// (Rákos 2010, "Efficient Gaussian Blur With Linear Sampling").
//
// Adjacent taps i, i+1 with weights w(i), w(i+1) fold into ONE bilinear
// fetch at the weighted offset (i·w(i) + (i+1)·w(i+1)) / (w(i) + w(i+1)),
// weighted w(i) + w(i+1): the texture unit returns exactly the two-tap sum.
// Center tap alone, then pairs (1,2), (3,4), ... on each side.
//
precision highp float;
#define BLUR_MAX_PAIRS 128   // MUST equal blurKernel.js BLUR_MAX_PAIRS
uniform sampler2D uTex;
uniform vec2  uTexel;     // 1 / inRect.size — one CANVAS pixel, in input uv
uniform vec4  uInMap;     // vUV → input uv (see @@FILTER_RECT@@)
uniform vec2  uDir;       // (1,0) horizontal, (0,1) vertical
uniform float uW0;        // center weight
uniform int   uTapCount;  // paired taps per side, 0..BLUR_MAX_PAIRS
uniform vec4  uTaps[BLUR_MAX_PAIRS / 2];   // (offset, weight) x 2 per vec4, normalized
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

#ifdef BLUR_CS_OUT
// The variant that hands its result back as sRGB (the last pass of a linearRGB blur whose result is the sRGB the target holds).
#define BLUR_RESULT(a) csConvert(a, 2)
#else
#define BLUR_RESULT(a) (a)
#endif

#ifdef BLUR_CS_IN
// The variant that converts what it reads (color-interpolation-filters, filterGraph/colorSpace.js). The hardware would average two texels
// BEFORE csConvert saw them, so each paired tap is read as its two texels: tap k sits at offset o between texels floor(o) and floor(o) + 1,
// where bilinear filtering weighs them 1 - f and f (f = o - floor(o)) -- the same weights, applied after the conversion. Pixel centers
// step by whole texels, so every fetch lands on a texel center and returns that texel exactly.
uniform int uCsIn;
vec4 tapIn(vec2 uv) { return csConvert(sampleIn(uTex, uv), uCsIn); }
void main() {
  vec2 uv = mapIn(vUV, uInMap);
  vec2 stepUv = uDir * uTexel;
  vec4 acc = tapIn(uv) * uW0;
  for (int k = 0; k < BLUR_MAX_PAIRS / 2; ++k) {
    if (2 * k >= uTapCount) break;
    vec4 t = uTaps[k];
    float i0 = floor(t.x), f = t.x - i0;
    vec2 d0 = stepUv * i0, d1 = stepUv * (i0 + 1.0);
    acc += (tapIn(uv + d0) + tapIn(uv - d0)) * (t.y * (1.0 - f)) + (tapIn(uv + d1) + tapIn(uv - d1)) * (t.y * f);
    if (2 * k + 1 >= uTapCount) break;
    i0 = floor(t.z); f = t.z - i0;
    d0 = stepUv * i0; d1 = stepUv * (i0 + 1.0);
    acc += (tapIn(uv + d0) + tapIn(uv - d0)) * (t.w * (1.0 - f)) + (tapIn(uv + d1) + tapIn(uv - d1)) * (t.w * f);
  }
  fragColor = BLUR_RESULT(acc);
}
#else
// A target can be larger than its pixels (filterGraph.js applyKeepScissor). `uInPast` is how much of the input's uv lies past them, 0 when none does. These taps sit between texels, so
// the input's edge is the pixels' edge: a tap off it reads 0, and one in its last half texel reads the last texel.
uniform vec2 uInPast;
vec4 sampleKept(vec2 uv) {
  vec2 e = vec2(1.0) - uInPast, s = step(vec2(0.0), uv) * step(uv, e);
  return texture(uTex, min(uv, e - 0.5 * uTexel)) * (s.x * s.y);
}
void main() {
  vec2 uv = mapIn(vUV, uInMap);
  vec2 stepUv = uDir * uTexel;
  vec4 acc = sampleKept(uv) * uW0;
  for (int k = 0; k < BLUR_MAX_PAIRS / 2; ++k) {
    if (2 * k >= uTapCount) break;
    vec4 t = uTaps[k];
    vec2 d = stepUv * t.x;
    acc += (sampleKept(uv + d) + sampleKept(uv - d)) * t.y;
    if (2 * k + 1 >= uTapCount) break;
    d = stepUv * t.z;
    acc += (sampleKept(uv + d) + sampleKept(uv - d)) * t.w;
  }
  fragColor = BLUR_RESULT(acc);
}
#endif
