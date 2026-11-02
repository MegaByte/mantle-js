#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feColorMatrix as a generic full-screen pass for the filter-graph
// walker, operating on an arbitrary input RT between graph nodes.

// Uniforms:
//   uM0..uM3 — the four 4-vector rows of the matrix
//   uMOff    — per-row bias column (alpha-row bias in .w)
precision highp float;
uniform sampler2D uTex;
uniform bool uLinearZeroBorder;
uniform int uCsIn;     // input color-space conversion (see @@FILTER_RECT@@ csConvert): 0 none, 1 sRGB->linear, 2 linear->sRGB
uniform int uCsOut;    // the same for the RESULT, applied to its color before it is premultiplied (2: a linearRGB matrix writes sRGB)
uniform vec4 uInMap;   // vUV → input uv (see @@FILTER_RECT@@)
uniform vec4 uM0;
uniform vec4 uM1;
uniform vec4 uM2;
uniform vec4 uM3;
uniform vec4 uMOff;
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  vec4 src;
  if (uLinearZeroBorder) {
    // Bilinear reconstruction includes zero-valued texels beyond the image.
    // CLAMP_TO_EDGE alone would extend the first/last texel into that border.
    vec2 size = vec2(textureSize(uTex, 0));
    vec2 p = uv * size;
    vec2 weight = clamp(min(p, size - p) + 0.5, 0.0, 1.0);
    src = texture(uTex, uv) * (weight.x * weight.y);
  } else {
    src = sampleIn(uTex, uv);
  }
  src = csConvert(src, uCsIn);
  // Source is premultiplied (filter-graph invariant). Unpremultiply,
  // matrix-transform, re-premultiply.
  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  vec4 c = vec4(rgb, src.a);
  vec4 o;
  o.r = dot(uM0, c) + uMOff.x;
  o.g = dot(uM1, c) + uMOff.y;
  o.b = dot(uM2, c) + uMOff.z;
  o.a = dot(uM3, c) + uMOff.w;
  o = clamp(o, 0.0, 1.0);
  if (uCsOut == 2) o.rgb = csLinearToSrgb(o.rgb);
  else if (uCsOut == 1) o.rgb = csSrgbToLinear(o.rgb);
  fragColor = vec4(o.rgb * o.a, o.a);
}
