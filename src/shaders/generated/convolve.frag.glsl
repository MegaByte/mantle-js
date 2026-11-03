#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform float uKernel[25];
uniform vec2  uTexel;
uniform vec4  uInMap;
uniform vec2  uOrder;
uniform vec2  uTarget;
uniform float uDivisor;
uniform float uBias;
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

  vec4 outc;
  if (uPreserveAlpha == 1) {

    vec3 accStraight = vec3(0.0);
    for (int j = 0; j < 5; j++) {
      if (j >= orderY) break;
      for (int i = 0; i < 5; i++) {
        if (i >= orderX) break;
        vec4 s = sampleEdge(uv0 + vec2(float(i - targetX), -float(j - targetY)) * uTexel);
        accStraight += uKernel[j * 5 + i] * (s.a > 0.0 ? s.rgb / s.a : s.rgb);
      }
    }
    float a = sampleEdge(uv0).a;

    vec3 rgb = clamp(accStraight / max(uDivisor, 1e-6) + vec3(uBias), 0.0, 1.0);
    outc = vec4(rgb * a, a);
  } else {

    vec4 acc = vec4(0.0);
    for (int j = 0; j < 5; j++) {
      if (j >= orderY) break;
      for (int i = 0; i < 5; i++) {
        if (i >= orderX) break;
        acc += uKernel[j * 5 + i] * sampleEdge(uv0 + vec2(float(i - targetX), -float(j - targetY)) * uTexel);
      }
    }
    outc = acc / max(uDivisor, 1e-6) + vec4(uBias);
  }

  outc = clamp(outc, vec4(0.0), vec4(1.0));
  fragColor = vec4(min(outc.rgb, vec3(outc.a)), outc.a);
}
