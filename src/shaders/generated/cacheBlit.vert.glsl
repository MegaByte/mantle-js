#version 300 es

layout(location=0) in vec2 aPos;
uniform vec4 uInMap;
out vec2 vUV;
void main() {
  vUV = (aPos * 0.5 + 0.5) * uInMap.xy + uInMap.zw;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
