#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

precision highp float;
in vec2 vUv;
uniform sampler2D uCoverage;
uniform vec4 uColor;        // straight RGBA paint
out vec4 o;
void main() {
  float cov = texture(uCoverage, vUv).r;
  if (cov <= 0.0) discard;
  float a = uColor.a * cov;
  o = vec4(uColor.rgb * a, a);
}
