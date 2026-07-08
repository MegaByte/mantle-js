#version 300 es
// loopBlinnComposite.frag.glsl — multiply paint by the Loop-Blinn coverage
// and emit premultiplied color for OVER compositing (blendFunc ONE,
// ONE_MINUS_SRC_ALPHA). uColor is straight (non-premultiplied) RGBA; we
// premultiply here after scaling alpha by coverage. Single coverage sample;
// the coverage buffer already carries the analytic AA + additive union.
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
