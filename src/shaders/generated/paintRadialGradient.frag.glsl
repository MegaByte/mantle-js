#version 300 es

precision highp float;
in vec2 vUV;
uniform sampler2D uGradientStops;
uniform int  uStopsOffset;
uniform int  uStopCount;
uniform vec3 uPaintMapX;
uniform vec3 uPaintMapY;
uniform vec2 uC0;
uniform float uR0;
uniform vec2 uC1;
uniform float uR1;
uniform int  uExtend;
out vec4 fragColor;

#define GRAD_STOPS_COLR

#ifndef MANTLE_NO_GRADIENT

#ifdef GRAD_STOPS_COLR
uniform int uStopsChrome;
vec3 stopsToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), greaterThan(c, vec3(0.04045))); }
vec3 stopsToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, greaterThan(c, vec3(0.0031308))); }
vec4 stopsMix(vec4 a, vec4 b, float k) {
  if (uStopsChrome != 0) return mix(a, b, k);
  vec4 m = mix(vec4(stopsToLinear(a.rgb) * a.a, a.a), vec4(stopsToLinear(b.rgb) * b.a, b.a), k);
  return vec4(m.a > 0.0 ? stopsToSrgb(clamp(m.rgb / m.a, 0.0, 1.0)) : vec3(0.0), m.a);
}
#else
#define stopsMix mix
#endif

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

  vec4 hiT = texelFetch(uGradientStops, gradStopTexel(base + (oneTexel ? hi : hi * 2 + 1)), 0);
  vec4 prvT = hiT;
  for (int it = 0; it < 16; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    vec4 mT = texelFetch(uGradientStops, gradStopTexel(base + (oneTexel ? mid : mid * 2 + 1)), 0);
    float mo = oneTexel ? mT.a : gradStopOffset(mT);
    if (mo < t) { lo = mid + 1; prvT = mT; } else { hi = mid; hiT = mT; }
  }

  vec4 curC  = oneTexel ? hiT  : texelFetch(uGradientStops, gradStopTexel(base + lo * 2), 0);
  vec4 prevC = oneTexel ? prvT : texelFetch(uGradientStops, gradStopTexel(base + max(lo - 1, 0) * 2), 0);
  vec4 cur = oneTexel ? vec4(curC.rgb, 1.0) : curC;
  float curOff = oneTexel ? hiT.a : gradStopOffset(hiT);
  if (lo == 0) return cur;
  if (curOff < t) return cur;
  vec4 prev = oneTexel ? vec4(prevC.rgb, 1.0) : prevC;
  float prevOff = oneTexel ? prvT.a : gradStopOffset(prvT);
  float span = max(curOff - prevOff, 1e-6);
  float k = (t - prevOff) / span;
  return stopsMix(prev, cur, k);
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
  float u = applyExtend(t, mode);
  vec4 here = sampleStopsRaw(u, stopsOffset, stopsCount);

  if (mode != 1) return here;

  float A = max(abs(dt.x), abs(dt.y)), B = min(abs(dt.x), abs(dt.y)), fw = A + B;

  if (fw <= 0.0 || fw > 0.25) return here;
  float dEdge = min(u, 1.0 - u);
  float s = 0.5 * fw - dEdge;
  if (s <= 0.0) return here;
  float far = stopsFootprintTail(s, A, B);

  float uOther = (u < 0.5) ? 1.0 - s / 3.0 : s / 3.0;
  vec4 there = sampleStopsRaw(uOther, stopsOffset, stopsCount);
  return stopsMix(here, there, far);
}
#endif

float radialT(vec2 q, out bool ok, out float disc, out bool cone, out vec2 grad) {
  ok = true; disc = 1.0; cone = false; grad = vec2(0.0);
  vec2 d = uC1 - uC0;
  vec2 e = q - uC0;
  float dr = uR1 - uR0;
  float A = dot(d, d) - dr * dr;
  float B = -2.0 * (dot(d, e) + uR0 * dr);
  float C = dot(e, e) - uR0 * uR0;
  if (abs(A) < 1e-6) {

    if (abs(B) <= 1e-6) { ok = false; return 0.0; }
    float t = -C / B;
    ok = (uR0 + t * dr >= 0.0);
    return t;
  }
  cone = A > 0.0;
  disc = B * B - 4.0 * A * C;
  grad = -4.0 * B * d - 8.0 * A * e;
  if (disc < 0.0) {
    if (!cone) { ok = false; return 0.0; }
    float td = -B / (2.0 * A);
    ok = (uR0 + td * dr >= 0.0);
    return td;
  }
  float sd = sqrt(disc);
  float t0 = (-B - sd) / (2.0 * A);
  float t1 = (-B + sd) / (2.0 * A);
  float hi = max(t0, t1), lo = min(t0, t1);
  if (uR0 + hi * dr >= 0.0) return hi;
  if (uR0 + lo * dr >= 0.0) return lo;
  ok = false;
  return 0.0;
}

void main() {
  vec2 q = vec2(dot(uPaintMapX, vec3(vUV, 1.0)), dot(uPaintMapY, vec3(vUV, 1.0)));

  vec2 qDx = dFdx(q), qDy = dFdy(q);
  bool ok, cone;
  float disc;
  vec2 grad;
  float t = radialT(q, ok, disc, cone, grad);
  if (!ok) { fragColor = vec4(0.0); return; }

  vec2 dt = vec2(0.0);
  if (uExtend == 1) {
    bool okX, okY, cX, cY;
    float dX, dY;
    vec2 gX, gY;
    float tX = radialT(q + qDx, okX, dX, cX, gX), tY = radialT(q + qDy, okY, dY, cY, gY);
    dt = vec2(okX ? tX - t : 0.0, okY ? tY - t : 0.0);
  }
  float coneCov = 1.0;
  if (cone) {
    float sa = abs(dot(grad, qDx)), sb = abs(dot(grad, qDy));
    float SA = max(sa, sb), SB = min(sa, sb);
    coneCov = (SA > 0.0) ? stopsFootprintTail(disc + 0.5 * (SA + SB), SA, SB) : (disc >= 0.0 ? 1.0 : 0.0);
  }
  if (coneCov <= 0.0) { fragColor = vec4(0.0); return; }
  vec4 c = sampleStops(t, uStopsOffset, uStopCount, uExtend, dt);
  c.a *= coneCov;
  fragColor = vec4(c.rgb * c.a, c.a);
}
