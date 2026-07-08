#version 300 es

layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aDst;
layout(location = 2) in vec3 aWM0;
layout(location = 3) in vec3 aWM1;
layout(location = 4) in vec3 aWM2;
layout(location = 5) in vec4 aTint;

uniform vec2 uViewport;
uniform vec4 uSrcRect;   

out vec2 vUV;
out vec4 vTint;

void main() {
  vec2 px = aDst.xy + aPos * aDst.zw;          
  mat3 wm = mat3(aWM0, aWM1, aWM2);            
  vec3 wp = wm * vec3(px, 1.0);
  px = wp.xy / wp.z;
  vec2 ndc = vec2(
    (px.x / max(uViewport.x, 1.0)) * 2.0 - 1.0,
    1.0 - (px.y / max(uViewport.y, 1.0)) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV   = uSrcRect.xy + aPos * uSrcRect.zw;
  vTint = aTint;
}
