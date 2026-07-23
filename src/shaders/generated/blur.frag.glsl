#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec2  uDir;
uniform float uSigma;
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
  if (uSigma <= 0.5) { fragColor = sampleIn(uTex, uv); return; }
  float twoS2 = 2.0 * uSigma * uSigma;

  int radius = int(min(ceil(uSigma * 3.0), 32.0));

  vec4 acc = sampleIn(uTex, uv);
  float wsum = 1.0;

  for (int k = 0; k < 16; ++k) {
    int i0 = 2 * k + 1;
    int i1 = i0 + 1;
    if (i0 > radius) break;
    float w0 = exp(-float(i0 * i0) / twoS2);

    float w1 = (i1 <= radius) ? exp(-float(i1 * i1) / twoS2) : 0.0;
    float wPair = w0 + w1;

    float offset = (float(i0) * w0 + float(i1) * w1) / wPair;
    vec2 d = uDir * uTexel * offset;
    acc += sampleIn(uTex, uv + d) * wPair;
    acc += sampleIn(uTex, uv - d) * wPair;
    wsum += 2.0 * wPair;
  }
  fragColor = acc / wsum;
}
