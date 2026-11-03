#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// aacPoints.frag.glsl — writes the color x coverage its vertex shader computed (aacPoints.vert.glsl). A grid point that
// missed the shape carries zero coverage and is discarded, as the fill shader discards a zero-coverage fragment.
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {
  // Below half an RGBA8 step this premultiplied paint rounds to zero.
  // Retain larger faint contributions so successive shapes can accumulate.
  if (vColor.a < 0.5 / 255.0) discard;
  fragColor = vColor;
}
