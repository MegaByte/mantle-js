#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform bool uLinearZeroBorder;
uniform int uCsIn;
uniform int uCsOut;
uniform vec4 uInMap;
uniform vec4 uM0;
uniform vec4 uM1;
uniform vec4 uM2;
uniform vec4 uM3;
uniform vec4 uMOff;
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
  vec2 uv = mapIn(vUV, uInMap);
  vec4 src;
  if (uLinearZeroBorder) {

    vec2 size = vec2(textureSize(uTex, 0));
    vec2 p = uv * size;
    vec2 weight = clamp(min(p, size - p) + 0.5, 0.0, 1.0);
    src = texture(uTex, uv) * (weight.x * weight.y);
  } else {
    src = sampleIn(uTex, uv);
  }
  src = csConvert(src, uCsIn);

  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  vec4 c = vec4(rgb, src.a);
  vec4 o;
  o.r = dot(uM0, c) + uMOff.x;
  o.g = dot(uM1, c) + uMOff.y;
  o.b = dot(uM2, c) + uMOff.z;
  o.a = dot(uM3, c) + uMOff.w;
  o = clamp(o, 0.0, 1.0);
  if (uCsOut == 2) o.rgb = csLinearToSrgb(o.rgb);
  else if (uCsOut == 1) o.rgb = csSrgbToLinear(o.rgb);
  fragColor = vec4(o.rgb * o.a, o.a);
}
