#version 300 es

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform sampler2D uMask;
out vec4 fragColor;

void main() {
  vec4 c = texture(uIn, vUV);
  float m = texture(uMask, vUV).a;
  fragColor = c * m;
}
