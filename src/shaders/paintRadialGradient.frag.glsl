#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// PaintRadialGradient — COLRv1 radial gradient. Two circles:
//   c0 with radius r0 (start), c1 with radius r1 (end).
// At point q, find t such that q lies on the circle interpolated
// between (c0, r0) and (c1, r1) at parameter t:
//   center(t) = (1-t) c0 + t c1
//   radius(t) = (1-t) r0 + t r1
//   |q - center(t)| = radius(t)
// Squaring gives A·t² + B·t + C = 0 with
//   d = c1 - c0, dr = r1 - r0, e = q - c0
//   A = dot(d, d) - dr²
//   B = -2·(dot(d, e) + r0·dr)
//   C = dot(e, e) - r0²
// Take the LARGEST t whose interpolated radius is non-negative (the two-point
// conical rule of canvas / Skia / the COLRv1 spec). A solution with r(t) < 0 is
// the mirror cone beyond the apex and is never painted, in every extend mode:
// when the larger root has a negative radius the smaller one is tried before the
// pixel is declared outside. See `_gradientHelpers.glsl` for the shared stops
// LUT helpers (same texture as SVG coverage).

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int  uStopsOffset;
uniform int  uStopCount;
uniform vec3 uPaintMapX;   // vUV -> the gradient's own coordinates: q = (dot(uPaintMapX, (vUV, 1)),
uniform vec3 uPaintMapY;   //   dot(uPaintMapY, (vUV, 1))) -- colrPaintShared.bindPaintMap
uniform vec2 uC0;
uniform float uR0;
uniform vec2 uC1;
uniform float uR1;
uniform int  uExtend;
out vec4 fragColor;

#define GRAD_STOPS_COLR
@@GRADIENT_HELPERS@@

// The two-circle parameter at q; ok is false where no solution has a non-negative radius. `cone` is true when
// the circles are not nested (A > 0): the gradient then paints a cone, `disc` is the root discriminant (positive
// inside the cone, zero on its edge) and, just outside the edge, the returned t is the edge's own double root, so
// the caller can antialias the edge rather than cut it.
float radialT(vec2 q, out bool ok, out float disc, out bool cone, out vec2 grad) {
  ok = true; disc = 1.0; cone = false; grad = vec2(0.0);
  vec2 d = uC1 - uC0;
  vec2 e = q - uC0;
  float dr = uR1 - uR0;
  float A = dot(d, d) - dr * dr;
  float B = -2.0 * (dot(d, e) + uR0 * dr);
  float C = dot(e, e) - uR0 * uR0;
  if (abs(A) < 1e-6) {
    // Linear in t (the focus lies on the end circle, or the circles are the same size and concentric).
    if (abs(B) <= 1e-6) { ok = false; return 0.0; }
    float t = -C / B;
    ok = (uR0 + t * dr >= 0.0);
    return t;
  }
  cone = A > 0.0;
  disc = B * B - 4.0 * A * C;
  grad = -4.0 * B * d - 8.0 * A * e;   // d(disc)/dq, exact: dB/de = -2d, dC/de = 2e
  if (disc < 0.0) {
    if (!cone) { ok = false; return 0.0; }
    float td = -B / (2.0 * A);
    ok = (uR0 + td * dr >= 0.0);
    return td;
  }
  float sd = sqrt(disc);
  float t0 = (-B - sd) / (2.0 * A);
  float t1 = (-B + sd) / (2.0 * A);
  float hi = max(t0, t1), lo = min(t0, t1);
  if (uR0 + hi * dr >= 0.0) return hi;
  if (uR0 + lo * dr >= 0.0) return lo;
  ok = false;
  return 0.0;
}

void main() {
  vec2 q = vec2(dot(uPaintMapX, vec3(vUV, 1.0)), dot(uPaintMapY, vec3(vUV, 1.0)));
  // Before any early return: the derivative is undefined after one.
  vec2 qDx = dFdx(q), qDy = dFdy(q);
  bool ok, cone;
  float disc;
  vec2 grad;
  float t = radialT(q, ok, disc, cone, grad);
  if (!ok) { fragColor = vec4(0.0); return; }
  // The neighbors serve two box filters: REPEAT's seam over the pixel's steps in UNWRAPPED t (a neighbor outside
  // the cone contributes nothing), and a cone's EDGE over the discriminant's steps -- its gradient is exact, and
  // it is linear across a pixel there, so the covered fraction is the same trapezoid tail the seam uses.
  vec2 dt = vec2(0.0);
  if (uExtend == 1) {
    bool okX, okY, cX, cY;
    float dX, dY;
    vec2 gX, gY;
    float tX = radialT(q + qDx, okX, dX, cX, gX), tY = radialT(q + qDy, okY, dY, cY, gY);
    dt = vec2(okX ? tX - t : 0.0, okY ? tY - t : 0.0);
  }
  float coneCov = 1.0;
  if (cone) {
    float sa = abs(dot(grad, qDx)), sb = abs(dot(grad, qDy));
    float SA = max(sa, sb), SB = min(sa, sb);
    coneCov = (SA > 0.0) ? stopsFootprintTail(disc + 0.5 * (SA + SB), SA, SB) : (disc >= 0.0 ? 1.0 : 0.0);
  }
  if (coneCov <= 0.0) { fragColor = vec4(0.0); return; }
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend, dt);
  c.a *= coneCov;
  fragColor = vec4(c.rgb * c.a, c.a);
}
