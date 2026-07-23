#version 300 es

layout(location = 0) in vec2 aPos;

uniform vec4 uDstRect;
uniform vec4 uSrcRect;
uniform vec2 uViewport;
uniform mat3 uWorldM;

out vec2 vUV;

void main() {

  vec2 px = uDstRect.xy + aPos * uDstRect.zw;

  vec3 wp = uWorldM * vec3(px, 1.0);
  px = wp.xy / wp.z;

  vec2 ndc = vec2(
    (px.x / max(uViewport.x, 1.0)) * 2.0 - 1.0,
    1.0 - (px.y / max(uViewport.y, 1.0)) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);

  vUV = uSrcRect.xy + aPos * uSrcRect.zw;
}
