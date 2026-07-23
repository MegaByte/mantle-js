#version 300 es

precision highp float;

uniform sampler2D uTex;

in  vec2 vUV;
in  vec4 vTint;
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);
  float a = vTint.a;
  fragColor = vec4(src.rgb * vTint.rgb * a, src.a * a);
}
