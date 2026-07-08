#version 300 es
// PaintLinearGradient — COLRv1 linear gradient. Per spec the gradient
// axis is defined by three points (p0, p1, p2): p0 = start, p1 = end,
// and p2 = rotation control along an axis perpendicular to (p1 - p0).
// Most fonts ship p2 = p0 + perp(p1 - p0) (canonical); a non-canonical
// p2 rotates the gradient without changing length.
//
// At pixel q, project (q - p0) onto axisDir = perp(p2 - p0).normalized
// (oriented along p1) and divide by axisLen = component of (p1 - p0)
// along axisDir → t ∈ [0, ∞), then apply extend mode and look up the
// stops LUT.
//
// Stops LUT format and helpers live in `_gradientHelpers.glsl`, which
// the shader loader prepends at the @@GRADIENT_HELPERS@@ marker.
// uniform sampler2D uGradientStops is declared in the preamble — it's
// the SAME shared bundle texture the SVG fill walker (ray-cast) reads from.
// uStopsOffset/uStopCount pick this gradient's slice.
//
// Output is premultiplied RGBA (CSS Filter Effects §11 invariant).

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int uStopsOffset;
uniform int uStopCount;
uniform vec2 uBboxOrigin;
uniform vec2 uBboxSize;
uniform vec2 uP0;
uniform vec2 uP1;
uniform vec2 uP2;
uniform int  uExtend;
out vec4 fragColor;

@@GRADIENT_HELPERS@@

void main() {
  vec2 q = uBboxOrigin + vUV * uBboxSize;
  vec2 axis = uP1 - uP0;
  vec2 perpRef = uP2 - uP0;
  vec2 perp = vec2(perpRef.y, -perpRef.x);   // 90° CW
  float perpLen = length(perp);
  vec2 axisDir = perpLen > 1e-6 ? perp / perpLen : normalize(axis);
  float axisProj = dot(axis, axisDir);
  if (axisProj < 0.0) { axisDir = -axisDir; axisProj = -axisProj; }
  float t = (axisProj > 1e-6) ? dot(q - uP0, axisDir) / axisProj : 0.0;
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend);
  fragColor = vec4(c.rgb * c.a, c.a);
}
