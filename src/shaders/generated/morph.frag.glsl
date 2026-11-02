#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec2  uDir;
uniform float uRadius;
uniform int   uOperator;
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
  if (uRadius < 0.5) { fragColor = sampleIn(uTex, uv); return; }

  int r = int(min(ceil(uRadius), 64.0));

  vec4 acc = sampleIn(uTex, uv);
  if (uOperator == 1) {
    for (int i = 1; i <= 64; ++i) {
      if (i > r) break;
      vec2 d = uDir * uTexel * float(i);
      acc = max(acc, max(sampleIn(uTex, uv + d), sampleIn(uTex, uv - d)));
    }
  } else {
    for (int i = 1; i <= 64; ++i) {
      if (i > r) break;
      vec2 d = uDir * uTexel * float(i);
      acc = min(acc, min(sampleIn(uTex, uv + d), sampleIn(uTex, uv - d)));
    }
  }
  fragColor = acc;
}
