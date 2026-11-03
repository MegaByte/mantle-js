#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec2  uDir;
uniform int   uRadius;
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

uniform vec2 uInPast;
vec4 sampleKept(vec2 uv) {
  vec2 e = vec2(1.0) - uInPast, s = step(vec2(0.0), uv) * step(uv, e);
  return texture(uTex, min(uv, e - 0.5 * uTexel)) * (s.x * s.y);
}

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  if (uRadius <= 0) { fragColor = sampleKept(uv); return; }
  vec4 acc = sampleKept(uv);

  int pairs = min(uRadius / 2, 128);
  bool tail = uRadius <= 256 && uRadius - 2 * pairs == 1;
  for (int k = 0; k < 128; ++k) {
    if (k >= pairs) break;

    vec2 d = uDir * uTexel * (float(2 * k + 1) + 0.5);
    acc += sampleKept(uv + d) * 2.0;
    acc += sampleKept(uv - d) * 2.0;
  }
  if (tail) {

    vec2 d = uDir * uTexel * float(uRadius);
    acc += sampleKept(uv + d) * 1.0;
    acc += sampleKept(uv - d) * 1.0;
  }

  fragColor = acc / float(1 + 4 * pairs + (tail ? 2 : 0));
}
