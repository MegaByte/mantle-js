#version 300 es

precision highp float;
#define BLUR_MAX_PAIRS 128
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec2  uDir;
uniform float uW0;
uniform int   uTapCount;
uniform vec4  uTaps[BLUR_MAX_PAIRS / 2];
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

#ifdef BLUR_CS_OUT

#define BLUR_RESULT(a) csConvert(a, 2)
#else
#define BLUR_RESULT(a) (a)
#endif

#ifdef BLUR_CS_IN

uniform int uCsIn;
vec4 tapIn(vec2 uv) { return csConvert(sampleIn(uTex, uv), uCsIn); }
void main() {
  vec2 uv = mapIn(vUV, uInMap);
  vec2 stepUv = uDir * uTexel;
  vec4 acc = tapIn(uv) * uW0;
  for (int k = 0; k < BLUR_MAX_PAIRS / 2; ++k) {
    if (2 * k >= uTapCount) break;
    vec4 t = uTaps[k];
    float i0 = floor(t.x), f = t.x - i0;
    vec2 d0 = stepUv * i0, d1 = stepUv * (i0 + 1.0);
    acc += (tapIn(uv + d0) + tapIn(uv - d0)) * (t.y * (1.0 - f)) + (tapIn(uv + d1) + tapIn(uv - d1)) * (t.y * f);
    if (2 * k + 1 >= uTapCount) break;
    i0 = floor(t.z); f = t.z - i0;
    d0 = stepUv * i0; d1 = stepUv * (i0 + 1.0);
    acc += (tapIn(uv + d0) + tapIn(uv - d0)) * (t.w * (1.0 - f)) + (tapIn(uv + d1) + tapIn(uv - d1)) * (t.w * f);
  }
  fragColor = BLUR_RESULT(acc);
}
#else

uniform vec2 uInPast;
vec4 sampleKept(vec2 uv) {
  vec2 e = vec2(1.0) - uInPast, s = step(vec2(0.0), uv) * step(uv, e);
  return texture(uTex, min(uv, e - 0.5 * uTexel)) * (s.x * s.y);
}
void main() {
  vec2 uv = mapIn(vUV, uInMap);
  vec2 stepUv = uDir * uTexel;
  vec4 acc = sampleKept(uv) * uW0;
  for (int k = 0; k < BLUR_MAX_PAIRS / 2; ++k) {
    if (2 * k >= uTapCount) break;
    vec4 t = uTaps[k];
    vec2 d = stepUv * t.x;
    acc += (sampleKept(uv + d) + sampleKept(uv - d)) * t.y;
    if (2 * k + 1 >= uTapCount) break;
    d = stepUv * t.z;
    acc += (sampleKept(uv + d) + sampleKept(uv - d)) * t.w;
  }
  fragColor = BLUR_RESULT(acc);
}
#endif
