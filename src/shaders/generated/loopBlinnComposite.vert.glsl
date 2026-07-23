#version 300 es

layout(location=0) in vec2 aPos;

uniform vec2 uCovScale;
out vec2 vUv;
void main() {
  vUv = (aPos * 0.5 + 0.5) * uCovScale;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
