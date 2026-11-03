#version 300 es

precision highp float;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform float uScale;
uniform vec2  uTexel;
uniform int   uDispUseM;
uniform vec4  uDispM;
uniform vec4  uIn1Map;
uniform vec4  uIn2Map;
uniform vec4  uXSel;
uniform vec4  uYSel;
uniform int   uCsIn2;
in vec2 vUV;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

vec3 csSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 csLinearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec4 csConvert(vec4 p, int mode) {
  if (mode == 0 || p.a <= 0.0) return p;
  vec3 c = clamp(p.rgb / p.a, 0.0, 1.0);
  c = mode == 1 ? csSrgbToLinear(c) : csLinearToSrgb(c);
  return vec4(c * p.a, p.a);
}

void main() {
  vec4 mPre = csConvert(sampleIn(uIn2, mapIn(vUV, uIn2Map)), uCsIn2);

  vec3 mRgb = mPre.a > 0.0 ? mPre.rgb / mPre.a : mPre.rgb;
  vec4 m = vec4(mRgb, mPre.a);
  float dx = (dot(m, uXSel) - 0.5) * uScale;
  float dy = (dot(m, uYSel) - 0.5) * uScale;
  vec2 disp = (uDispUseM != 0 ? vec2(uDispM.x * dx + uDispM.z * dy, uDispM.y * dx + uDispM.w * dy) : vec2(dx, -dy)) * uTexel;

  vec2 sUV = mapIn(vUV, uIn1Map) + disp;
  fragColor = sampleIn(uIn1, sUV);
}
