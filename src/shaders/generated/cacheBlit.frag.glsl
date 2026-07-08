#version 300 es

precision highp float;
uniform sampler2D uCacheTex;
uniform vec4 uTint;       
in vec2 vUV;
out vec4 fragColor;
void main() {
  vec4 c = texture(uCacheTex, vUV);
  fragColor = c * uTint;
}
