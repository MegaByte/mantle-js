#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// PaintSweepGradient — COLRv1 conic/sweep gradient. Sweeps from
// startAngle to endAngle around `center`. At pixel q,
//   θ = atan2(q.y - center.y, q.x - center.x) (degrees, CCW from +x)
//   t = (θ - startAngle) / (endAngle - startAngle)
// then apply extend mode and look up stops. See `_gradientHelpers.glsl`.

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int  uStopsOffset;
uniform int  uStopCount;
uniform vec3 uPaintMapX;   // vUV -> the gradient's own coordinates: q = (dot(uPaintMapX, (vUV, 1)),
uniform vec3 uPaintMapY;   //   dot(uPaintMapY, (vUV, 1))) -- colrPaintShared.bindPaintMap
uniform vec2 uCenter;
uniform float uStartAngle;
uniform float uEndAngle;
uniform int  uExtend;
out vec4 fragColor;

#define GRAD_STOPS_COLR
@@GRADIENT_HELPERS@@

void main() {
  vec2 q = vec2(dot(uPaintMapX, vec3(vUV, 1.0)), dot(uPaintMapY, vec3(vUV, 1.0)));
  vec2 v = q - uCenter;
  // Match the curve kernels on the vertical axis, including signed zero.
  float angle = v.x == 0.0 ? sign(v.y) * 1.5707963267948966 : atan(v.y, v.x);
  float deg = degrees(angle);
  if (deg < 0.0) deg += 360.0;
  float span = uEndAngle - uStartAngle;
  float t = (abs(span) > 1e-6) ? (deg - uStartAngle) / span : 0.0;
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend, vec2(dFdx(t), dFdy(t)));   // unwrapped; uniform flow
  fragColor = vec4(c.rgb * c.a, c.a);
}
