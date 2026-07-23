#version 300 es

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int  uStopsOffset;
uniform int  uStopCount;
uniform vec2 uBboxOrigin;
uniform vec2 uBboxSize;
uniform vec2 uCenter;
uniform float uStartAngle;
uniform float uEndAngle;
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

vec4 sampleStopsRaw(float t, int stopsOffset, int stopsCount) {
  if (stopsCount == 0) return vec4(0.0);
  bool oneTexel = stopsCount < 0;
  int count = abs(stopsCount);
  int base = stopsOffset;
  if (count == 1) {
    vec4 c = texelFetch(uGradientStops, ivec2(base, 0), 0);
    return oneTexel ? vec4(c.rgb, 1.0) : c;
  }
  int lo = 0, hi = count - 1;
  for (int it = 0; it < 9; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    float mo = oneTexel
      ? texelFetch(uGradientStops, ivec2(base + mid, 0), 0).a
      : texelFetch(uGradientStops, ivec2(base + mid * 2 + 1, 0), 0).x;
    if (mo < t) lo = mid + 1; else hi = mid;
  }
  vec4 curC = texelFetch(uGradientStops, ivec2(base + (oneTexel ? lo : lo * 2), 0), 0);
  vec4 cur = oneTexel ? vec4(curC.rgb, 1.0) : curC;
  float curOff = oneTexel ? curC.a
                          : texelFetch(uGradientStops, ivec2(base + lo * 2 + 1, 0), 0).x;
  if (lo == 0) return cur;
  if (curOff < t) return cur;
  vec4 prevC = texelFetch(uGradientStops, ivec2(base + (oneTexel ? (lo - 1) : (lo - 1) * 2), 0), 0);
  vec4 prev = oneTexel ? vec4(prevC.rgb, 1.0) : prevC;
  float prevOff = oneTexel ? prevC.a
                           : texelFetch(uGradientStops, ivec2(base + (lo - 1) * 2 + 1, 0), 0).x;
  float span = max(curOff - prevOff, 1e-6);
  float k = (t - prevOff) / span;
  return mix(prev, cur, k);
}

vec4 sampleStops(float t, int stopsOffset, int stopsCount, int mode) {
  if (stopsCount == 0) return vec4(0.0);
  if (mode == 0) {

    return sampleStopsRaw(clamp(t, 0.0, 1.0), stopsOffset, stopsCount);
  }

  float u = applyExtend(t, mode);
  float fw = fwidth(u);

  if (fw <= 0.0 || fw > 0.25) return sampleStopsRaw(u, stopsOffset, stopsCount);
  float halfW = 0.5 * fw;

  float dEdge = min(u, 1.0 - u);
  if (dEdge >= halfW) return sampleStopsRaw(u, stopsOffset, stopsCount);

  vec4 here = sampleStopsRaw(u, stopsOffset, stopsCount);
  vec4 there;
  if (mode == 1) {

    float uOther = (u < 0.5) ? 1.0 : 0.0;
    there = sampleStopsRaw(uOther, stopsOffset, stopsCount);
  } else {

    return here;
  }

  float k = 0.5 + 0.5 * (dEdge / halfW);
  return mix(there, here, k);
}
#endif

void main() {
  vec2 q = uBboxOrigin + vUV * uBboxSize;
  vec2 v = q - uCenter;
  float deg = degrees(atan(v.y, v.x));
  if (deg < 0.0) deg += 360.0;
  float span = uEndAngle - uStartAngle;
  float t = (abs(span) > 1e-6) ? (deg - uStartAngle) / span : 0.0;
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend);
  fragColor = vec4(c.rgb * c.a, c.a);
}
