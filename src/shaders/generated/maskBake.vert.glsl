#version 300 es

precision highp float;

layout(location=0) in vec2 aUV;
uniform vec4 uMaskEmBBox;
uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
out vec2 vEmCoord;

void main() {
  vec2 emPos = mix(uMaskEmBBox.xy, uMaskEmBBox.zw, aUV);
  vEmCoord = emPos;
  vec2 uv    = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;

  gl_Position = vec4(plane.x, -plane.y, 0.0, 1.0);
}
