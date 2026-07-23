#version 300 es

precision highp float;

uniform sampler2D uTex;
uniform vec4  uTint;
uniform float uAlpha;

uniform mat4 uColorMatrix;
uniform vec4 uColorMatrixOffset;
uniform int  uColorMatrixEnabled;

in  vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);
  if (uColorMatrixEnabled != 0) {

    vec4 c = vec4(src.a > 0.0 ? src.rgb / src.a : vec3(0.0), src.a);
    c = clamp(uColorMatrix * c + uColorMatrixOffset, 0.0, 1.0);
    src = vec4(c.rgb * c.a, c.a);
  }

  float a = uTint.a * uAlpha;
  fragColor = vec4(src.rgb * uTint.rgb * a, src.a * a);
}
