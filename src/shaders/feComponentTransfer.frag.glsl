#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feComponentTransfer — per-channel 1D LUT remap. SVG Filter Effects §16.


precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform vec4 uInMap;          // vUV → uIn uv (see @@FILTER_RECT@@)
uniform sampler2D uLUT;       // 256×4 RGBA8
uniform int uCsIn;            // input color-space conversion (csConvert)
out vec4 fragColor;

@@FILTER_RECT@@

float lookup(int row, float x) {
  // Clamp + scale to texel coordinate.
  int i = clamp(int(x * 255.0 + 0.5), 0, 255);
  return texelFetch(uLUT, ivec2(i, row), 0).r;
}

void main() {
  vec4 srcPre = csConvert(sampleIn(uIn, mapIn(vUV, uInMap)), uCsIn);
  vec3 srcRgb = srcPre.a > 0.0 ? srcPre.rgb / srcPre.a : srcPre.rgb;
  float r = lookup(0, srcRgb.r);
  float g = lookup(1, srcRgb.g);
  float b = lookup(2, srcRgb.b);
  float a = lookup(3, srcPre.a);
  fragColor = vec4(r * a, g * a, b * a, a);
}
