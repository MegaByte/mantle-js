#version 300 es

layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aMap;
layout(location=3) in vec4 aTint;
uniform vec2 uViewport;
out vec2 vUV;
flat out vec4 vTint;
void main() {
  vUV = aPos * aMap.xy + aMap.zw;
  vTint = aTint;
  vec2 px = aRect.xy + aPos * aRect.zw;
  gl_Position = vec4(px / uViewport * 2.0 - 1.0, 0.0, 1.0);
}
