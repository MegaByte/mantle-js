#version 300 es

precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
out vec4 fragColor;
void main() {
  vec2 uv = fract(vUV);
  if (uv.x < 0.0) uv.x += 1.0;
  if (uv.y < 0.0) uv.y += 1.0;
  fragColor = texture(uTex, uv);
}
