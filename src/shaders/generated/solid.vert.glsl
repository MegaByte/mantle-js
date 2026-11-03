#version 300 es

layout(location=0) in vec2 aPos;
uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
void main() {
  vec2 uv = (aPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  gl_Position = vec4(plane.x, -plane.y, 0.0, 1.0);
}
