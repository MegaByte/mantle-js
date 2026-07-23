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

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  if (uRadius <= 0) { fragColor = sampleIn(uTex, uv); return; }
  vec4 acc = sampleIn(uTex, uv);

  float n = 1.0;
  for (int k = 0; k < 32; ++k) {
    int off = 2 * k + 1;
    if (off > uRadius) break;

    float pairCount;
    float fOff;
    if (off + 1 <= uRadius) {
      fOff = float(off) + 0.5;
      pairCount = 2.0;
    } else {
      fOff = float(off);
      pairCount = 1.0;
    }
    vec2 d = uDir * uTexel * fOff;

    acc += sampleIn(uTex, uv + d) * pairCount;
    acc += sampleIn(uTex, uv - d) * pairCount;
    n += 2.0 * pairCount;
  }
  fragColor = acc / n;
}
