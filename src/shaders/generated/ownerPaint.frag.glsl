#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 fragColor;

uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;

const int MT_BBOX         = 0;
const int MT_FILL         = 1;
const int MT_STROKE       = 2;
const int MT_STROKE_PARAMS = 3;
const int MT_GLYPH_BAND   = 4;
const int MT_SOLID        = 5;

const int MT_CAP_JOIN     = 6;
const int MT_PAINT_ID     = 7;
const int MT_FILTER_BLEND = 8;
const int MT_IMAGE_RECT   = 9;
const int MT_ATLAS        = 10;
const int MT_PRIM         = 11;

const int FS_STROKE_LOCAL = 4;

const int FT_R0   = 0;
const int FT_R1   = 1;
const int FT_R2   = 2;
const int FT_R3   = 3;
const int FT_OFF  = 4;
const int FT_META = 5;

const int GR_G0 = 0;  const int GR_G1 = 1;  const int GR_G2 = 2;  const int GR_G3 = 3;

const int OV_AFFINE   = 0;
const int OV_POS_VIS  = 1;
const int OV_TINT     = 2;
const int OV_FILL     = 3;
const int OV_STROKE   = 4;
const int OV_STROKE_W = 5;

const int DASH_HDR = 0;

const int MRL_ROW = 0;

ivec2 metaAt(int c, int r)   { return ivec2(c + 12 * (r >> 12), r & 4095); }
ivec2 gradAt(int c, int r)   { return ivec2(c + 4 * (r >> 12), r & 4095); }
ivec2 dashAt(int c, int r)   { return ivec2(c + 16 * (r >> 12), r & 4095); }
ivec2 filterAt(int c, int r) { return ivec2(c + 6 * (r >> 12), r & 4095); }
ivec2 ovAt(int c, int r)     { return ivec2(c + 6 * (r >> 12), r & 4095); }
ivec2 mrlAt(int c, int r)    { return ivec2(c + 2 * (r >> 12), r & 4095); }

int metaRowsOf(ivec2 sz) { return sz.y * (sz.x / 12); }

float strokeWidthMultiplier(int flags, vec2 footprint) {
  bool h = (flags & (1 << 13)) != 0, v = (flags & (1 << 14)) != 0;
  if (h && !v) return footprint.x;
  if (v && !h) return footprint.y;
  return (flags & (1 | (1 << 13) | (1 << 14))) != 0 ? 0.5 * (footprint.x + footprint.y) : 1.0;
}

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

int gradientSpreadToExtend(int spread) {

  if (spread == 1) return 2;
  if (spread == 2) return 1;
  return 0;
}

#ifndef MANTLE_NO_GRADIENT

float gradientT(vec2 gpos, int gType, vec4 g0, vec4 g3, out bool ok, out bool cone, out float disc) {
  ok = true; cone = false; disc = 1.0;
  if (gType == 0) {
    vec2 p1 = g3.xy;
    vec2 p2 = g3.zw;
    vec2 d = p2 - p1;
    float dd = dot(d, d);
    return dot(gpos - p1, d) / dd;
  }
  vec2 c = g3.xy;
  float r = g3.z;
  float fxFrac = g3.w;
  float fyFrac = g0.w;

  vec2 frac = vec2(fxFrac, fyFrac);
  float invR = 1.0 / r;
  vec2 d = (gpos - c) * invR - frac;
  vec2 cf = -frac;

  float frHalf = g0.y - floor(g0.y + 0.5);
  if (frHalf > 0.0) {

    float fq = 2.0 * frHalf;
    float fr = fq / (1.0 - fq);
    float dr = 1.0 - fr;
    float qa = dot(cf, cf) - dr * dr;
    float qb = dot(d, cf) + fr * dr;
    float qc = dot(d, d) - fr * fr;
    float qd = qb * qb - qa * qc;
    disc = 4.0 * qd;
    cone = qa > 0.0;

    if (dr == 0.0 && qa == 0.0 && qb == 0.0) return qc < 0.0 ? 0.0 : 1.0;
    if (qd < 0.0) {

      if (!cone) { ok = false; return 0.0; }
      float te = qb / qa;
      if (!(fr + te * dr >= 0.0)) { ok = false; return 0.0; }
      return te;
    }
    float sq = sqrt(qd);
    float m = qb + (qb >= 0.0 ? sq : -sq);
    float t1 = m != 0.0 ? qc / m : 0.0;
    bool ok1 = m != 0.0 && fr + t1 * dr >= 0.0;
    float t2 = 0.0;

    bool ok2 = m != 0.0 && abs(qa) > 1.0e-6 * (dot(cf, cf) + dr * dr) && abs(qa) * 1.0e12 > abs(m);
    if (ok2) { t2 = m / qa; ok2 = fr + t2 * dr >= 0.0; }
    if (!ok1 && !ok2) { ok = false; return 0.0; }
    if (ok1 && ok2) return max(t1, t2);
    return ok1 ? t1 : t2;
  }
  float A = dot(d, d);
  float B = 2.0 * dot(cf, d);
  float C = dot(cf, cf) - 1.0;
  disc = B * B - 4.0 * A * C;
  if (C > 0.0) {

    cone = true;
    float tc = (0.5 * B + 0.5 * sqrt(max(disc, 0.0))) / C;
    if (!(tc >= 0.0)) { ok = false; return 0.0; }
    return tc;
  }
  if (C == 0.0) {
    cone = true; disc = B;
    return B > 0.0 ? A / B : 0.0;
  }
  if (A == 0.0) return 0.0;
  if (disc < 0.0) { ok = false; return 0.0; }

  return (2.0 * A) / (B + sqrt(disc));
}

vec4 sampleGradient(int gid, vec2 emCoord, vec4 shapeBB, vec2 emDx, vec2 emDy) {
  int row = gid - 1;
  vec4 g0 = texelFetch(uGradientTex, gradAt(GR_G0, row), 0);
  vec4 g1 = texelFetch(uGradientTex, gradAt(GR_G1, row), 0);
  vec4 g2 = texelFetch(uGradientTex, gradAt(GR_G2, row), 0);
  vec4 g3 = texelFetch(uGradientTex, gradAt(GR_G3, row), 0);
  int gType = int(g0.x + 0.5);
  int spread = int(g0.y + 0.5);
  float unitsFlag = g0.z;

  int stopsOffset = int(g2.z + 0.5);

  int stopsCount  = int(g2.w >= 0.0 ? g2.w + 0.5 : g2.w - 0.5);
  if ((gType == 0 && all(equal(g3.xy, g3.zw))) || (gType != 0 && g3.z == 0.0))
    return sampleStopsRaw(2.0, stopsOffset, stopsCount);
  vec2 gp = emCoord, gdx = emDx, gdy = emDy;
  if (unitsFlag > 0.5) {
    vec2 bboxMin = shapeBB.xy;

    vec2 bboxSize = shapeBB.zw - bboxMin;
    bboxSize = vec2(bboxSize.x > 0.0 ? bboxSize.x : 1.0, bboxSize.y > 0.0 ? bboxSize.y : 1.0);
    gp = (emCoord - bboxMin) / bboxSize;
    gdx = emDx / bboxSize; gdy = emDy / bboxSize;
  }
  float ax = g1.x, ay = g1.y, bx = g1.z, by = g1.w;
  float ex = g2.x, ey = g2.y;
  vec2 gpos = vec2(ax * gp.x + bx * gp.y + ex,
                   ay * gp.x + by * gp.y + ey);
  bool ok, cone; float disc;
  float t = gradientT(gpos, gType, g0, g3, ok, cone, disc);
  if (!ok) return vec4(0);
  int mode = gradientSpreadToExtend(spread);

  if (gType != 0 && mode == 1 && t < 0.5 && g0.y == floor(g0.y + 0.5)) mode = 0;

  vec2 dt = vec2(0.0);
  float coneCov = 1.0;
  if (mode == 1 || cone) {
    bool okX, okY, cX, cY; float dX, dY;
    float tX = gradientT(gpos + vec2(ax * gdx.x + bx * gdx.y, ay * gdx.x + by * gdx.y), gType, g0, g3, okX, cX, dX);
    float tY = gradientT(gpos + vec2(ax * gdy.x + bx * gdy.y, ay * gdy.x + by * gdy.y), gType, g0, g3, okY, cY, dY);
    if (mode == 1) dt = vec2(okX ? tX - t : 0.0, okY ? tY - t : 0.0);
    if (cone) {
      float sa = abs(dX - disc), sb = abs(dY - disc);
      float SA = max(sa, sb), SB = min(sa, sb);
      coneCov = (SA > 0.0) ? stopsFootprintTail(disc + 0.5 * (SA + SB), SA, SB) : (disc >= 0.0 ? 1.0 : 0.0);
    }
  }
  if (coneCov <= 0.0) return vec4(0);
  vec4 c = sampleStops(t, stopsOffset, stopsCount, mode, dt);
  return vec4(c.rgb, c.a * coneCov);
}
#endif

uniform int  uGradId;
uniform vec3 uEmX;
uniform vec3 uEmY;
uniform vec3 uRect;

void main() {

  vec2 px = vec2(gl_FragCoord.x + uRect.x, uRect.z - (gl_FragCoord.y + uRect.y));
  vec2 em = vec2(dot(uEmX, vec3(px, 1.0)), dot(uEmY, vec3(px, 1.0)));

  vec2 emDx = vec2(uEmX.x, uEmY.x), emDy = vec2(uEmX.y, uEmY.y);
  vec4 c = sampleGradient(uGradId, em, vec4(0.0), emDx, emDy);
  fragColor = vec4(c.rgb * c.a, c.a);
}
