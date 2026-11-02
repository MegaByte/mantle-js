#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

precision highp float;
uniform sampler2D uTex;
uniform vec4 uInMap;
in vec2 vUV;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

void main() {
  vec2 uv = fract(mapIn(vUV, uInMap));
  if (uv.x < 0.0) uv.x += 1.0;
  if (uv.y < 0.0) uv.y += 1.0;
  fragColor = texture(uTex, uv);
}
