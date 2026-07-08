#version 300 es
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
uniform vec2 uBboxOrigin;
uniform vec2 uBboxSize;
uniform vec2 uCenter;
uniform float uStartAngle;
uniform float uEndAngle;
uniform int  uExtend;
out vec4 fragColor;

@@GRADIENT_HELPERS@@

void main() {
  vec2 q = uBboxOrigin + vUV * uBboxSize;
  vec2 v = q - uCenter;
  float deg = degrees(atan(v.y, v.x));
  if (deg < 0.0) deg += 360.0;
  float span = uEndAngle - uStartAngle;
  float t = (abs(span) > 1e-6) ? (deg - uStartAngle) / span : 0.0;
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend);
  fragColor = vec4(c.rgb * c.a, c.a);
}
