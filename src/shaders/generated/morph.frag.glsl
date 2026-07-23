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

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  if (uRadius < 0.5) { fragColor = sampleIn(uTex, uv); return; }

  int r = int(min(ceil(uRadius), 64.0));

  vec4 acc = sampleIn(uTex, uv);
  for (int i = 1; i <= 64; ++i) {
    if (i > r) break;
    vec2 d = uDir * uTexel * float(i);
    vec4 p = sampleIn(uTex, uv + d);
    vec4 n = sampleIn(uTex, uv - d);
    if (uOperator == 1) {
      acc = max(acc, max(p, n));
    } else {
      acc = min(acc, min(p, n));
    }
  }
  fragColor = acc;
}
