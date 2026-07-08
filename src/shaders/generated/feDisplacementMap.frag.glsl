#version 300 es

precision highp float;
uniform sampler2D uIn1;     
uniform sampler2D uIn2;     
uniform float uScale;       
uniform vec2  uTexel;       
uniform int   uXChan;
uniform int   uYChan;
in vec2 vUV;
out vec4 fragColor;

float chSelect(vec4 c, int ch) {
  if (ch == 0) return c.r;
  if (ch == 1) return c.g;
  if (ch == 2) return c.b;
  return c.a;
}

void main() {
  vec4 mPre = texture(uIn2, vUV);
  
  vec3 mRgb = mPre.a > 0.0 ? mPre.rgb / mPre.a : mPre.rgb;
  vec4 m = vec4(mRgb, mPre.a);
  float dx = (chSelect(m, uXChan) - 0.5) * uScale;
  float dy = (chSelect(m, uYChan) - 0.5) * uScale;
  vec2 disp = vec2(dx, dy) * uTexel;
  vec2 sUV = vUV + disp;
  
  
  
  fragColor = texture(uIn1, sUV);
}
