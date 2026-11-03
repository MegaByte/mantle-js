#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int uStopsOffset;
uniform int uStopCount;
uniform vec2 uBboxOrigin;
uniform vec2 uBboxSize;
uniform vec2 uP0;
uniform vec2 uP1;
uniform vec2 uP2;
uniform int  uExtend;
out vec4 fragColor;

#ifndef MANTLE_NO_GRADIENT
float applyExtend(float t, int mode) {
  if (mode == 1) {
    return fract(t);
  }
  if (mode == 2) {
    float u = fract(t * 0.5);
    return u < 0.5 ? u * 2.0 : (1.0 - u) * 2.0;
  }
  return clamp(t, 0.0, 1.0);
}

ivec2 gradStopTexel(int i) { return ivec2(i & 2047, i >> 11); }

float gradStopOffset(vec4 b) { return b.x + b.y * (1.0 / 255.0) + b.z * (1.0 / 65025.0); }

vec4 sampleStopsRaw(float t, int stopsOffset, int stopsCount) {
  if (stopsCount == 0) return vec4(0.0);
  bool oneTexel = stopsCount < 0;
  int count = abs(stopsCount);
  int base = stopsOffset;
  if (count == 1) {
    vec4 c = texelFetch(uGradientStops, gradStopTexel(base), 0);
    return oneTexel ? vec4(c.rgb, 1.0) : c;
  }
  int lo = 0, hi = count - 1;
  for (int it = 0; it < 16; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    float mo = oneTexel
      ? texelFetch(uGradientStops, gradStopTexel(base + mid), 0).a
      : gradStopOffset(texelFetch(uGradientStops, gradStopTexel(base + mid * 2 + 1), 0));
    if (mo < t) lo = mid + 1; else hi = mid;
  }
  vec4 curC = texelFetch(uGradientStops, gradStopTexel(base + (oneTexel ? lo : lo * 2)), 0);
  vec4 cur = oneTexel ? vec4(curC.rgb, 1.0) : curC;
  float curOff = oneTexel ? curC.a
                          : gradStopOffset(texelFetch(uGradientStops, gradStopTexel(base + lo * 2 + 1), 0));
  if (lo == 0) return cur;
  if (curOff < t) return cur;
  vec4 prevC = texelFetch(uGradientStops, gradStopTexel(base + (oneTexel ? (lo - 1) : (lo - 1) * 2)), 0);
  vec4 prev = oneTexel ? vec4(prevC.rgb, 1.0) : prevC;
  float prevOff = oneTexel ? prevC.a
                           : gradStopOffset(texelFetch(uGradientStops, gradStopTexel(base + (lo - 1) * 2 + 1), 0));
  float span = max(curOff - prevOff, 1e-6);
  float k = (t - prevOff) / span;
  return mix(prev, cur, k);
}

float stopsFootprintTail(float s, float A, float B) {
  if (s <= 0.0) return 0.0;
  if (s >= A + B) return 1.0;
  if (B <= 0.0) return s / A;
  if (s <= B) return s * s / (2.0 * A * B);
  if (s <= A) return (s - 0.5 * B) / A;
  float r = A + B - s;
  return 1.0 - r * r / (2.0 * A * B);
}

vec4 sampleStops(float t, int stopsOffset, int stopsCount, int mode, vec2 dt) {
  if (stopsCount == 0) return vec4(0.0);
  if (mode == 0) {

    return sampleStopsRaw(clamp(t, 0.0, 1.0), stopsOffset, stopsCount);
  }
  float u = applyExtend(t, mode);

  if (mode != 1) return sampleStopsRaw(u, stopsOffset, stopsCount);

  float A = max(abs(dt.x), abs(dt.y)), B = min(abs(dt.x), abs(dt.y)), fw = A + B;

  if (fw <= 0.0 || fw > 0.25) return sampleStopsRaw(u, stopsOffset, stopsCount);
  float dEdge = min(u, 1.0 - u);
  float s = 0.5 * fw - dEdge;
  if (s <= 0.0) return sampleStopsRaw(u, stopsOffset, stopsCount);
  float far = stopsFootprintTail(s, A, B);

  vec4 here = sampleStopsRaw(u, stopsOffset, stopsCount);
  float uOther = (u < 0.5) ? 1.0 - s / 3.0 : s / 3.0;
  vec4 there = sampleStopsRaw(uOther, stopsOffset, stopsCount);
  return mix(here, there, far);
}
#endif

void main() {
  vec2 q = uBboxOrigin + vUV * uBboxSize;
  vec2 axis = uP1 - uP0;
  vec2 perpRef = uP2 - uP0;
  vec2 perp = vec2(perpRef.y, -perpRef.x);
  float perpLen = length(perp);
  vec2 axisDir = perpLen > 1e-6 ? perp / perpLen : normalize(axis);
  float axisProj = dot(axis, axisDir);
  if (axisProj < 0.0) { axisDir = -axisDir; axisProj = -axisProj; }
  float t = (axisProj > 1e-6) ? dot(q - uP0, axisDir) / axisProj : 0.0;
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend, vec2(dFdx(t), dFdy(t)));
  fragColor = vec4(c.rgb * c.a, c.a);
}
