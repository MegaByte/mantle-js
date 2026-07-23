#version 300 es

precision highp float;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform float uScale;
uniform vec2  uTexel;
uniform vec4  uIn1Map;
uniform vec4  uIn2Map;
uniform int   uXChan;
uniform int   uYChan;
in vec2 vUV;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

float chSelect(vec4 c, int ch) {
  if (ch == 0) return c.r;
  if (ch == 1) return c.g;
  if (ch == 2) return c.b;
  return c.a;
}

void main() {
  vec4 mPre = sampleIn(uIn2, mapIn(vUV, uIn2Map));

  vec3 mRgb = mPre.a > 0.0 ? mPre.rgb / mPre.a : mPre.rgb;
  vec4 m = vec4(mRgb, mPre.a);
  float dx = (chSelect(m, uXChan) - 0.5) * uScale;
  float dy = (chSelect(m, uYChan) - 0.5) * uScale;
  vec2 disp = vec2(dx, dy) * uTexel;

  vec2 sUV = mapIn(vUV, uIn1Map) + disp;
  fragColor = sampleIn(uIn1, sUV);
}
