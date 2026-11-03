#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
precision highp float;
precision highp sampler2DArray;
uniform sampler2D uCacheTex;
uniform sampler2DArray uMasks;
uniform vec2 uLayers;
uniform vec2 uViewport;
uniform vec4 uTint;
in vec2 vUV;
out vec4 fragColor;
#ifdef FILTER_CS_OUT
// A filter result tagged linearRGB (filterGraph/colorSpace.js): converted to sRGB as it is composited. Compiled only into the variant program
// a linear result is drawn with, so the program every other blit uses carries nothing.
vec4 csToSrgb(vec4 p) {
  if (p.a <= 0.0) return p;
  vec3 c = clamp(p.rgb / p.a, 0.0, 1.0);
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  return vec4(c * p.a, p.a);
}
#endif
void main() {
  vec2 uv = gl_FragCoord.xy / uViewport;
  float coverage = 1.0;
  if (uLayers.x >= 0.0) coverage *= texture(uMasks, vec3(uv, uLayers.x)).r;
  if (uLayers.y >= 0.0) coverage *= texture(uMasks, vec3(uv, uLayers.y)).r;
  vec4 color = texture(uCacheTex, vUV);
#ifdef FILTER_CS_OUT
  color = csToSrgb(color);
#endif
  fragColor = color * uTint * coverage;
}
