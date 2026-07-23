#version 300 es

precision highp float;
in vec2 vUv;
uniform sampler2D uCoverage;
uniform vec4 uColor;
out vec4 o;
void main() {
  float cov = texture(uCoverage, vUv).r;
  if (cov <= 0.0) discard;
  float a = uColor.a * cov;
  o = vec4(uColor.rgb * a, a);
}
