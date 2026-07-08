#version 300 es
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
// Take the larger root (outward cone). See `_gradientHelpers.glsl`
// for the shared stops LUT helpers (same texture as SVG coverage).

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int  uStopsOffset;
uniform int  uStopCount;
uniform vec2 uBboxOrigin;
uniform vec2 uBboxSize;
uniform vec2 uC0;
uniform float uR0;
uniform vec2 uC1;
uniform float uR1;
uniform int  uExtend;
out vec4 fragColor;

@@GRADIENT_HELPERS@@

void main() {
  vec2 q = uBboxOrigin + vUV * uBboxSize;
  vec2 d = uC1 - uC0;
  vec2 e = q - uC0;
  float dr = uR1 - uR0;
  float A = dot(d, d) - dr * dr;
  float B = -2.0 * (dot(d, e) + uR0 * dr);
  float C = dot(e, e) - uR0 * uR0;
  float t;
  if (abs(A) < 1e-6) {
    t = (abs(B) > 1e-6) ? -C / B : 0.0;
  } else {
    float disc = B * B - 4.0 * A * C;
    if (disc < 0.0) { fragColor = vec4(0.0); return; }
    float sd = sqrt(disc);
    float t0 = (-B - sd) / (2.0 * A);
    float t1 = (-B + sd) / (2.0 * A);
    t = max(t0, t1);
  }
  // Negative-radius (back-cone) → transparent in PAD mode.
  float rt = uR0 + t * dr;
  if (rt < 0.0 && uExtend == 0) { fragColor = vec4(0.0); return; }
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend);
  fragColor = vec4(c.rgb * c.a, c.a);
}
