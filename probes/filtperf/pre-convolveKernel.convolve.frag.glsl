#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

precision highp float;
uniform sampler2D uTex;
uniform sampler2D uKernelTex;
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec2  uOrder;
uniform vec2  uTarget;
uniform float uDivisor;
uniform float uBias;
uniform int   uKernelRow;
uniform int   uEdgeMode;
uniform int   uPreserveAlpha;
in vec2 vUV;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

float kernelAt(int r, int c, int orderX) {
  int idx = r * orderX + c;
  int texel = idx / 4;
  int chan  = idx - texel * 4;
  vec4 t = texelFetch(uKernelTex, ivec2(texel, uKernelRow), 0);
  if (chan == 0) return t.x;
  if (chan == 1) return t.y;
  if (chan == 2) return t.z;
  return t.w;
}

vec4 sampleEdge(vec2 uv) {
  if (uEdgeMode == 1) {
    return texture(uTex, fract(uv));
  }
  if (uEdgeMode == 2) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
      return vec4(0.0);
    return texture(uTex, uv);
  }

  return texture(uTex, clamp(uv, vec2(0.0), vec2(1.0)));
}

void main() {
  vec2 uv0 = mapIn(vUV, uInMap);
  int orderX = int(uOrder.x + 0.5);
  int orderY = int(uOrder.y + 0.5);
  int targetX = int(uTarget.x + 0.5);
  int targetY = int(uTarget.y + 0.5);
  vec4 acc = vec4(0.0);
  vec3 accStraight = vec3(0.0);

  for (int j = 0; j < 5; j++) {
    if (j >= orderY) break;
    for (int i = 0; i < 5; i++) {
      if (i >= orderX) break;

      float k = kernelAt(orderY - 1 - j, orderX - 1 - i, orderX);
      vec2 off = vec2(float(i - targetX), -float(j - targetY)) * uTexel;
      vec4 s = sampleEdge(uv0 + off);
      acc += k * s;
      accStraight += k * (s.a > 0.0 ? s.rgb / s.a : s.rgb);
    }
  }
  vec4 outc;
  if (uPreserveAlpha == 1) {

    float a = sampleEdge(uv0).a;
    vec3 rgb = clamp(accStraight / max(uDivisor, 1e-6) + vec3(uBias), 0.0, 1.0);
    outc = vec4(rgb * a, a);
  } else {

    outc = acc / max(uDivisor, 1e-6) + vec4(uBias);
  }

  outc = clamp(outc, vec4(0.0), vec4(1.0));
  fragColor = vec4(min(outc.rgb, vec3(outc.a)), outc.a);
}
