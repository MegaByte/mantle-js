#version 300 es

#define MANTLE_AAC
#define MANTLE_NO_IMAGE
#ifndef MANTLE_POINTS_GRADIENT
#define MANTLE_NO_GRADIENT
#endif

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;

uniform sampler2D uDashTex;
uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;
uniform sampler2D uSecondaryImageTex;
uniform vec2 uSecondaryImageAtlasSize;
uniform sampler2D uImageTex;
uniform vec2      uImageAtlasSize;
uniform sampler2D uFilterTex;
uniform vec4      uGlobalBBox;

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

#ifndef MANTLE_NO_IMAGE

void imageLocalCoordinates(int mapId, inout vec2 pos, inout vec2 dx, inout vec2 dy) {
#ifndef MANTLE_NO_GRADIENT
  if (mapId > 0) {
    vec4 m = texelFetch(uGradientTex, gradAt(GR_G1, mapId - 1), 0);
    vec2 t = texelFetch(uGradientTex, gradAt(GR_G2, mapId - 1), 0).xy;
    mat2 linear = mat2(m.xy, m.zw);
    pos = linear * pos + t; dx = linear * dx; dy = linear * dy;
  }
#endif
}

vec4 imageTexelStraight(vec4 t) {
  return vec4(t.a > 0.0 ? min(t.rgb / t.a, vec3(1.0)) : vec3(0.0), t.a);
}

vec4 sampleChildImage(vec2 tileEm, vec4 imageRect, vec4 atlasSlot, vec2 tileDx, vec2 tileDy) {
  bool secondary = (int(atlasSlot.w + 0.5) & 8) != 0;
  vec2 atlasSize = secondary ? uSecondaryImageAtlasSize : uImageAtlasSize;

  vec2 rs = max(imageRect.zw, vec2(1e-30));
  float u = (tileEm.x - imageRect.x) / rs.x;
  float v = (tileEm.y - imageRect.y) / rs.y;
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) { u = fract(u); v = fract(v); }
  else if (kind == 3) {
    u = 1.0 - abs(fract(u * 0.5) - 0.5) * 2.0;
    v = 1.0 - abs(fract(v * 0.5) - 0.5) * 2.0;
  } else if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0);
  float atlasU = clamp(u * atlasSlot.y, 0.5, max(0.5, atlasSlot.y - 0.5)) / max(atlasSize.x, 1.0);
  float atlasV = clamp(atlasSlot.x + v * atlasSlot.z, atlasSlot.x + 0.5,
    atlasSlot.x + max(0.5, atlasSlot.z - 0.5)) / max(atlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {

    atlasU = (floor(atlasU * atlasSize.x) + 0.5) / max(atlasSize.x, 1.0);
    atlasV = (floor(atlasV * atlasSize.y) + 0.5) / max(atlasSize.y, 1.0);
  }
  vec2 aScale = atlasSlot.yz / (rs * max(atlasSize, vec2(1.0)));
  return imageTexelStraight(secondary ? textureGrad(uSecondaryImageTex, vec2(atlasU, atlasV), tileDx * aScale, tileDy * aScale) : textureGrad(uImageTex, vec2(atlasU, atlasV), tileDx * aScale, tileDy * aScale));}

vec4 sampleTopLevelImage(vec2 emPos, vec4 imageRect, vec4 atlasSlot, vec2 emDx, vec2 emDy) {
  bool secondary = (int(atlasSlot.w + 0.5) & 8) != 0;
  vec2 atlasSize = secondary ? uSecondaryImageAtlasSize : uImageAtlasSize;

  vec2 rs = max(imageRect.zw, vec2(1e-30));
  float u = (emPos.x - imageRect.x) / rs.x;
  float v = (emPos.y - imageRect.y) / rs.y;
  vec2 uvDx = emDx / rs, uvDy = emDy / rs;

  vec2 uvPx = abs(uvDx) + abs(uvDy);
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) {

    u = fract(u); if (u < 0.0) u += 1.0;
    v = fract(v); if (v < 0.0) v += 1.0;
  } else if (kind == 3) {

    u = 1.0 - abs(fract(u * 0.5) - 0.5) * 2.0;
    v = 1.0 - abs(fract(v * 0.5) - 0.5) * 2.0;
  } else {

    vec2 slack = 2.0 * uvPx;
    if (u < -slack.x || u > 1.0 + slack.x || v < -slack.y || v > 1.0 + slack.y) return vec4(0);
    u = clamp(u, 0.0, 1.0);
    v = clamp(v, 0.0, 1.0);
  }
  float atlasU = clamp(u * atlasSlot.y, 0.5, max(0.5, atlasSlot.y - 0.5)) / max(atlasSize.x, 1.0);
  float atlasV = clamp(atlasSlot.x + v * atlasSlot.z, atlasSlot.x + 0.5,
    atlasSlot.x + max(0.5, atlasSlot.z - 0.5)) / max(atlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    atlasU = (floor(atlasU * atlasSize.x) + 0.5) / max(atlasSize.x, 1.0);
    atlasV = (floor(atlasV * atlasSize.y) + 0.5) / max(atlasSize.y, 1.0);
  }
  vec2 aScale = atlasSlot.yz / max(atlasSize, vec2(1.0));
  return imageTexelStraight(secondary ? textureGrad(uSecondaryImageTex, vec2(atlasU, atlasV), uvDx * aScale, uvDy * aScale) : textureGrad(uImageTex, vec2(atlasU, atlasV), uvDx * aScale, uvDy * aScale));}

vec4 sampleMappedChildImage(vec2 pos, vec4 rect, vec4 atlas, vec2 dx, vec2 dy, int mapId) {
  imageLocalCoordinates(mapId, pos, dx, dy);
  return sampleChildImage(pos, rect, atlas, dx, dy);
}
vec4 sampleMappedTopLevelImage(vec2 pos, vec4 rect, vec4 atlas, vec2 dx, vec2 dy, int mapId) {
  imageLocalCoordinates(mapId, pos, dx, dy);
  return sampleTopLevelImage(pos, rect, atlas, dx, dy);
}

#endif

#ifndef SLUG_NEWTON
#define SLUG_NEWTON 5
#endif
#define SEG_LINE 0u
#define SEG_QUAD 1u
#define SEG_CUBIC 2u
#define SEG_ARC 3u

vec4 cubicCoeff(float p1, float p2, float p3, float p4) {
  return vec4(-p1+3.0*p2-3.0*p3+p4, 3.0*(p1-2.0*p2+p3), 3.0*(p2-p1), p1);
}

float evalC(vec4 c, float t) { return ((c.x*t+c.y)*t+c.z)*t+c.w; }
float evalCD(vec4 c, float t) { return (3.0*c.x*t + 2.0*c.y)*t + c.z; }

const float SLUG_GL16_N[16] = float[16](
  0.005299532504175033, 0.027712488463383711, 0.067184398806084128,
  0.122297795822498470, 0.191061877798678115, 0.270991611171386573,
  0.359198224610370696, 0.452493745081181231, 0.547506254918818769,
  0.640801775389629304, 0.729008388828613427, 0.808938122201321885,
  0.877702204177501530, 0.932815601193915872, 0.972287511536616289,
  0.994700467495824967);
const float SLUG_GL16_W[16] = float[16](
  0.013576229705877047, 0.031126761969323946, 0.047579255841246392,
  0.062314485627766936, 0.074797994408288365, 0.084578259697501269,
  0.091301707522461794, 0.094725305227534248, 0.094725305227534248,
  0.091301707522461794, 0.084578259697501269, 0.074797994408288365,
  0.062314485627766936, 0.047579255841246392, 0.031126761969323946,
  0.013576229705877047);
float slugCubicArcLen(vec4 cx, vec4 cy, float t) {
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float u = t * SLUG_GL16_N[i];
    float dx = (3.0 * cx.x * u + 2.0 * cx.y) * u + cx.z;
    float dy = (3.0 * cy.x * u + 2.0 * cy.y) * u + cy.z;
    sum += SLUG_GL16_W[i] * sqrt(dx * dx + dy * dy);
  }
  return t * sum;
}

vec3 seSide(vec2 q, vec2 t, float halfW) {
  vec2 pn = vec2(-t.y, t.x);
  float s = dot(q, pn);
  return vec3(s < 0.0 ? -pn : pn, abs(s) - halfW);
}

vec4 seSlab(vec2 q, vec2 t, float halfW, float reach) {
  vec3 s = seSide(q, t, halfW);
  return vec4(s, -s.z - 2.0 * halfW > -reach ? 9.0 : 1.0);
}

float seKappa(vec2 d1, vec2 d2, float err) {
  float l2 = dot(d1, d1);
  float c = d1.x * d2.y - d1.y * d2.x;
  if (!(l2 > 0.0) || abs(c) <= err) return 0.0;
  vec2 t = d1 * inversesqrt(l2);
  return (t.x * d2.y - t.y * d2.x) / l2;
}

float seKappaErr(float m, vec2 d1, vec2 d2) { return 16.0 * 1.1920929e-7 * m * (length(d1) + length(d2)); }

void seAnd(inout vec4 P, inout vec4 Q, vec2 n, float e, float reach) {
#ifdef MANTLE_STROKE_EXACT
  if (!(dot(n, n) > 0.5) || e <= -reach) return;
  if (P.w == 0.0) { P = vec4(n, e, 1.0); Q = vec4(0.0); }
  else if (P.w == 1.0) {
    if (e > P.z) { Q = vec4(P.xyz, 0.0); P = vec4(n, e, 2.0); } else { Q = vec4(n, e, 0.0); P = vec4(P.xyz, 2.0); }
  } else if (P.w == 2.0) {
    if (e > P.z) { Q = vec4(P.xyz, 0.0); P = vec4(n, e, 2.0); } else if (e > Q.z) Q = vec4(n, e, 0.0);
  } else if (P.w == 9.0) {
    if (!(dot(Q.xy, Q.xy) > 0.5) || e > Q.z) Q = vec4(n, e, 0.0);
  } else if (e > P.z) { Q = vec4(P.xyz, 0.0); P = vec4(n, e, 2.0); }
#endif
}
void seAnd(inout vec4 P, inout vec4 Q, vec3 ne, float reach) { seAnd(P, Q, ne.xy, ne.z, reach); }

void seOr(inout vec4 P, inout vec4 Q, vec2 n, float e, float reach) {
#ifdef MANTLE_STROKE_EXACT
  if ((P.w == 1.0 || (P.w == 9.0 && !(dot(Q.xy, Q.xy) > 0.5))) && dot(n, n) > 0.5 && e >= P.z && e < reach) {
    Q = vec4(n, e, 0.0); P = vec4(P.xyz, 3.0);
  }
#endif
}

void seDisc(out vec4 P, out vec4 Q, vec2 q, vec2 u, float halfW) {
#ifdef MANTLE_STROKE_EXACT
  float r = length(q);
  if (r > 0.0) { P = vec4(q / r, r - halfW, 4.0); Q = vec4(u, dot(q, u), 0.0); }
  else { P = vec4(0.0); Q = vec4(0.0); }
#else
  P = vec4(0.0); Q = vec4(0.0);
#endif
}

vec2 seArcN(vec2 q, vec2 tan, float kappa) {
  vec2 L = vec2(-tan.y, tan.x);
  if (kappa == 0.0) return dot(q, L) < 0.0 ? -L : L;
  vec2 w = kappa * q - L;
  float lw = length(w);
  return lw > 0.0 ? (kappa * dot(q, q) - 2.0 * dot(q, L) < 0.0 ? -w : w) / lw : vec2(0.0);
}

const int DASH_MAX_ENTRIES = 60;
float strokeDashScale = 1.0;
float strokeDashCycleG = 0.0, strokeDashOnG = 0.0;
float dashValue(int row, int k) {
  vec4 texel = texelFetch(uDashTex, dashAt(1 + (k >> 2), row), 0);
  int c = k & 3;
  return (c == 0) ? texel.x : (c == 1) ? texel.y : (c == 2) ? texel.z : texel.w;
}

float strokeSeamL = 0.0;
bool strokeSeamFirst = false, strokeSeamLast = false;
bool strokeSeamMergeLo = false, strokeSeamMergeHi = false;
float strokeSeamTol = 0.0;
void strokeSeamSet(float hy, float hz) {
  strokeSeamFirst = hy < 0.0;
  strokeSeamLast = hz < 0.0;
  strokeSeamL = strokeSeamFirst ? -hy : (strokeSeamLast ? -hz : 0.0);
  strokeSeamMergeLo = false;
  strokeSeamMergeHi = false;
  strokeSeamTol = 0.0;
}

bool strokeSeamOn(int row, int count, float cycleLen, float d, bool after, float tol) {
  if (after) { if (d >= cycleLen - tol) d -= cycleLen; }
  else if (d <= tol) d += cycleLen;
  float accum = 0.0;
  bool on = false;
  for (int k = 0; k < DASH_MAX_ENTRIES; k++) {
    if (k >= count) break;
    float v = dashValue(row, k) * strokeDashScale;
    if ((k & 1) == 0 && v > 0.0) {
      if (after ? (d >= accum - tol && d < accum + v - tol) : (d > accum + tol && d <= accum + v + tol)) on = true;
    }
    accum += v;
  }
  return on;
}

void strokeSeamResolve(int dashId, float seR, inout bool freeStart, inout bool freeEnd) {
  if (dashId <= 0 || !(strokeSeamL > 0.0)) return;
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, dashAt(DASH_HDR, row), 0);
  float cycleLen = hdr.r * strokeDashScale;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b * strokeDashScale;
  if (cycleLen <= 0.0 || count <= 0 || 2.0 * cycleLen < 1.41421356 * seR) return;
  strokeSeamTol = min(2.4e-6 * (strokeSeamL + abs(offset) + cycleLen), 1e-3 * cycleLen);
  bool onStart = strokeSeamOn(row, count, cycleLen, mod(offset, cycleLen), true, 0.0);
  bool onEnd = strokeSeamOn(row, count, cycleLen, mod(strokeSeamL + offset, cycleLen), false, strokeSeamTol);
  bool merged = onStart && onEnd;
  if (strokeSeamFirst) { if (merged) strokeSeamMergeLo = true; else freeStart = true; }
  if (strokeSeamLast) { if (merged) strokeSeamMergeHi = true; else freeEnd = true; }
}

void dashBoundary(float b, float type, float d, float ds, float dist, float cycleLen, float sLo, float sHi, inout vec3 best,
                  inout float best2) {
  float f = b - d;
  if (f < 0.0) f += cycleLen;
  for (int r = 0; r < 2; r++) {
    float sb = ds + (r == 0 ? f : f - cycleLen);
    float delta = sb - dist;
    float side = type != 0.0 ? type : (delta >= 0.0 ? -1.0 : 1.0);
    bool onPath = type == 0.0 ? (sb >= sLo && sb <= sHi)
                : side < 0.0  ? (sb >= sLo && sb < sHi) : (sb > sLo && sb <= sHi);

    if (onPath && type != 0.0 && ((strokeSeamMergeLo && side < 0.0 && sb <= sLo + strokeSeamTol) || (strokeSeamMergeHi && side > 0.0 && sb >= sHi - strokeSeamTol)
        || (strokeSeamLast && side < 0.0 && sb >= sHi - strokeSeamTol) || (strokeSeamFirst && side > 0.0 && sb <= sLo + strokeSeamTol))) onPath = false;
    if (onPath) {
      if (abs(delta) < best.x) { best2 = best.x; best = vec3(abs(delta), side, type == 0.0 ? 1.0 : 0.0); }
      else if (abs(delta) < best2) best2 = abs(delta);
    }
  }
}

vec2 dashCapReach(int dashId, float dist, bool zeroDashEmpty) {
  vec2 r = vec2(1e30);
  if (dashId <= 0) return r;
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, dashAt(DASH_HDR, row), 0);
  float cycleLen = hdr.r * strokeDashScale;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b * strokeDashScale;
  if (cycleLen <= 0.0 || count <= 0) return r;
  float d = mod(dist + offset, cycleLen);
  float accum = 0.0;
  for (int k = 0; k < DASH_MAX_ENTRIES; k++) {
    if (k >= count) break;
    float v = dashValue(row, k) * strokeDashScale;
    if ((k & 1) == 0 && (v > 0.0 || !zeroDashEmpty)) {
      float behind = mod(d - (accum + v), cycleLen);
      float ahead = mod(accum - d, cycleLen);
      r = vec2(min(r.x, behind), min(r.y, ahead));
    }
    accum += v;
  }
  return r;
}

vec2 dashOut(int dashId, float dist, bool zeroDashEmpty, float sLo, float sHi, out vec2 more) {
  more = vec2(1e30, 0.0);
  if (dashId <= 0) return vec2(-1e30, 0.0);
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, dashAt(DASH_HDR, row), 0);
  float cycleLen = hdr.r * strokeDashScale;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b * strokeDashScale;
  if (cycleLen <= 0.0 || count <= 0) return vec2(-1e30, 0.0);
  float ds = clamp(dist, sLo, sHi);
  float d = mod(ds + offset, cycleLen);
  float accum = 0.0;
  vec3 best = vec3(1e30, 0.0, 0.0);
  float best2 = 1e30;
  int firstCov = -1, prevCov = -1;
  bool inside = false;
  strokeDashCycleG = cycleLen;
  strokeDashOnG = 0.0;
  for (int k = 0; k < DASH_MAX_ENTRIES; k++) {
    if (k >= count) break;
    float v = dashValue(row, k) * strokeDashScale;
    int cov = (k & 1) == 0 ? 1 : 0;
    if (cov == 1) strokeDashOnG += v;
    if (v > 0.0) {
      if (d >= accum && d < accum + v) inside = cov == 1;
      if (firstCov < 0) firstCov = cov;

      if (prevCov >= 0 && prevCov != cov) dashBoundary(accum, cov == 1 ? -1.0 : 1.0, d, ds, dist, cycleLen, sLo, sHi, best, best2);
      prevCov = cov;
    } else if (cov == 1 && !zeroDashEmpty) {
      dashBoundary(accum, 0.0, d, ds, dist, cycleLen, sLo, sHi, best, best2);
    }
    accum += v;
  }

  if (firstCov >= 0 && prevCov != firstCov) dashBoundary(0.0, firstCov == 1 ? -1.0 : 1.0, d, ds, dist, cycleLen, sLo, sHi, best, best2);

  if (strokeSeamLast && ds >= sHi) inside = strokeSeamOn(row, count, cycleLen, d, false, strokeSeamTol);
  more = vec2(best2, best.z);
  if (best.x >= 1e30) return vec2(inside ? -1e30 : 1e30, 0.0);
  return vec2(inside ? -best.x : best.x, best.y);
}

float strokeDashDist(float thisD, inout vec2 g, vec2 tanT, float halfW, int dashId, float pathDist,
                     int startCap, int endCap, float sLo, float sHi, float seR, inout vec4 eP, inout vec4 eQ) {
  vec2 more;
  vec2 os = dashOut(dashId, pathDist, startCap == 0 && endCap == 0, sLo, sHi, more);

  float pxSz = 1.41421356 * seR;
  if (strokeDashCycleG > 0.0 && 2.0 * strokeDashCycleG < pxSz) {
    float onLen = strokeDashOnG + ((startCap != 0 ? halfW : 0.0) + (endCap != 0 ? halfW : 0.0));
    float duty = clamp(onLen / strokeDashCycleG, 0.0, 1.0);
    if (duty >= 1.0) return thisD;
    eP = vec4(0.0); eQ = vec4(0.0); g = vec2(0.0);
    return max(thisD, halfW + pxSz * (0.5 - duty));
  }
  float o = os.x;
  if (o <= -1e29) return thisD;
  vec2 gp = os.y * tanT;
  int cap = os.y < 0.0 ? startCap : endCap;
  if (cap == 1) {

    if (o < 1e29 && o > -seR && dot(g, g) > 0.5) {
      if (more.x >= halfW + seR) seDisc(eP, eQ, thisD * g + o * gp, more.y > 0.5 ? vec2(0.0) : gp, halfW);
      else { eP = vec4(0.0); eQ = vec4(0.0); }
    } else if (o > 0.0) {

      eP = vec4(0.0); eQ = vec4(0.0);
    }
    if (o > 0.0) {
      float r = length(vec2(thisD, o));
      g = (dot(g, g) > 0.5 && r > 0.0) ? (thisD * g + o * gp) / r : vec2(0.0);
      thisD = r;
    }
  } else {
    float r = cap == 2 ? o : halfW + o;
    seAnd(eP, eQ, gp, r - halfW, seR);
    if (r > thisD) { thisD = r; g = gp; }
  }
  return thisD;
}

float perpDistToArc(vec2 q, vec2 tan, float kappa) {
  vec2 L = vec2(-tan.y, tan.x);
  if (kappa == 0.0) return abs(dot(q, L));
  return abs(kappa * dot(q, q) - 2.0 * dot(q, L)) / (length(kappa * q - L) + 1.0);
}

float strokeArcsReachFactor(float miterLimit) {
  float ml = max(miterLimit, 1.0);
  return sqrt(ml * ml + 1.0);
}

vec2 strokeUnit(vec2 d) { float l = length(d); return l > 0.0 ? d / l : d; }

bool strokeEndCandidate(bool freeStart, bool freeEnd, int startCap, int endCap, int joinStyle, int dashId, int e) {
  if (dashId > 0 || (freeStart && startCap == 0) || (freeEnd && endCap == 0)) return true;
  bool joined = joinStyle != 1 && joinStyle != 2;
  return e == 0 ? (freeStart ? startCap == 2 : joined) : (freeEnd ? endCap == 2 : joined);
}

float strokeCapsJoinsDash(
    float t, float thisD, vec2 pStart, vec2 pEnd, vec2 dStart, vec2 dEnd,
    bool freeStart, bool freeEnd, int startCap, int endCap,
    int joinStyle, float miterLimit, float halfW,
    vec2 inTan, vec2 outTan,
    int dashId, float startDist, float arcLenAtT, vec4 curv, float minDIn,
    inout vec2 gradIO, vec2 tanT, float dashEnd, float seR, out vec4 eP, out vec4 eQ) {
  bool drop = false;
  bool roundEnd = false;
  vec2 latV = vec2(0.0);

  eP = (dot(gradIO, gradIO) > 0.5) ? vec4(gradIO, thisD - halfW, -thisD - halfW > -seR ? 9.0 : 1.0) : vec4(0.0);
  eQ = vec4(0.0);

  if (t < 1e-4 || t > 1.0 - 1e-4) {
    bool atS = t < 1e-4;
    vec2 ep = atS ? pStart : pEnd;
    vec2 tOwn = strokeUnit(atS ? dStart : dEnd);
    vec2 uOwn = atS ? -tOwn : tOwn;
    vec2 tOth = atS ? inTan : outTan;
    vec2 uOth = atS ? inTan : -outTan;
    vec2 din = atS ? inTan : tOwn, dout = atS ? tOwn : outTan;
    bool freeV = atS ? freeStart : freeEnd;
    int capV = atS ? startCap : endCap;
    float kOwn = atS ? curv.x : curv.y, kOth = atS ? curv.z : curv.w;
    bool outWedge = atS ? dot(-ep, inTan) < 0.0 : dot(-ep, outTan) > 0.0;
    if (freeV) {

      eP = seSlab(-ep, tOwn, halfW, seR); eQ = vec4(0.0);
      float aR = dot(-ep, uOwn);
      roundEnd = capV == 1;
      if (roundEnd) latV = ep - tOwn * dot(ep, tOwn);
      if (capV == 0) seAnd(eP, eQ, uOwn, aR, seR);
      else if (capV == 2) { if (aR >= 0.0) seAnd(eP, eQ, uOwn, aR - halfW, seR); }
      else seDisc(eP, eQ, -ep, uOwn, halfW);
      if (capV == 0) {

        float aOut = dot(-ep, uOwn);
        thisD = max(thisD, halfW + aOut);
      }
      else if (capV == 2) {

        float a = dot(-ep, uOwn);
        if (a >= 0.0) { float perp = length(-ep - uOwn * a); thisD = min(thisD, max(perp, a)); }
      }
    } else if ((joinStyle == 0 || joinStyle == 3 || joinStyle == 4) && outWedge) {

      float aJ = dot(-ep, uOwn);
      if (aJ > 0.0) thisD = max(thisD, halfW + aJ);
      eP = seSlab(-ep, tOwn, halfW, seR); eQ = vec4(0.0);
      if (aJ > 0.0) seAnd(eP, eQ, uOwn, aJ, seR);
    } else if (joinStyle == 0 || joinStyle == 3) {
      float c = dot(uOwn, uOth);

      float sinHalf = 0.5 * length(uOwn - uOth);
      float miterLen = halfW / max(sinHalf, 1.17549435e-38);
      float maxMiter = halfW * miterLimit;
      float mlClip = halfW * max(miterLimit, 1.0);
      bool fits = miterLen <= maxMiter;
      vec2 along = uOwn;
      float a = dot(-ep, along);

      float cosHalfJ = sqrt(max(0.5 * (1.0 + c), 0.0));
      float perpThis  = length(-ep - along * a);
      vec2  nOth      = vec2(-tOth.y, tOth.x);
      float perpOther = abs(dot(-ep, nOth));

      eP = vec4(0.0); eQ = vec4(0.0);
      seAnd(eP, eQ, seSide(-ep, tOwn, halfW), seR); seAnd(eP, eQ, seSide(-ep, tOth, halfW), seR);

      if (joinStyle == 0 && !fits) {
        float cr = din.x * dout.y - din.y * dout.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(din.y, -din.x), nB = sd * vec2(dout.y, -dout.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl; seAnd(eP, eQ, bis, dot(-ep, bis) - halfW * dot(nA, bis), seR);
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
        else { seAnd(eP, eQ, uOwn, dot(-ep, uOwn), seR); thisD = max(thisD, halfW + dot(-ep, uOwn)); }
      }
      float capAlong = fits ? miterLen * cosHalfJ : 0.0;
      if (a >= 0.0 && a <= capAlong) {
        thisD = min(thisD, max(perpThis, perpOther));
      } else if (joinStyle == 3 && !fits) {

        vec2 tipDir = din - dout;
        float tipLen = length(tipDir);
        float dClip = max(perpThis, perpOther);
        if (tipLen > 1e-4) { dClip = max(dClip, halfW + dot(-ep, tipDir) / tipLen - mlClip);
          seAnd(eP, eQ, tipDir / tipLen, dot(-ep, tipDir) / tipLen - mlClip, seR); }

        dClip = max(dClip, halfW + length(-ep) - halfW * strokeArcsReachFactor(miterLimit));
        if (length(ep) > 0.0) seAnd(eP, eQ, -ep / length(ep), length(ep) - halfW * strokeArcsReachFactor(miterLimit), seR);
        thisD = dClip;
      }
    } else if (joinStyle == 4) {

      float c = dot(uOwn, uOth);

      float sinHalf = 0.5 * length(uOwn - uOth);
      float miterLen = halfW / max(sinHalf, 1.17549435e-38);
      bool fits = miterLen <= halfW * miterLimit;

      float alongA = dot(-ep, uOwn);
      float cosHalfA = sqrt(max(0.5 * (1.0 + c), 0.0));
      float perpThis  = perpDistToArc(-ep, tOwn, kOwn);
      float perpOther = perpDistToArc(-ep, tOth, kOth);

      eP = vec4(0.0); eQ = vec4(0.0);
      seAnd(eP, eQ, seArcN(-ep, tOwn, kOwn), perpThis - halfW, seR); seAnd(eP, eQ, seArcN(-ep, tOth, kOth), perpOther - halfW, seR);

      float dArc = max(max(perpThis, perpOther),
                       halfW + length(-ep) - halfW * strokeArcsReachFactor(miterLimit));

      if (length(ep) > 0.0) seAnd(eP, eQ, -ep / length(ep), length(ep) - halfW * strokeArcsReachFactor(miterLimit), seR);
      float capAlong = fits ? miterLen * cosHalfA : 0.0;
      if (alongA >= 0.0 && alongA <= capAlong) {
        thisD = min(thisD, dArc);
      } else if (!fits) {

        vec2 tipDir = din - dout;
        float tipLen = length(tipDir);
        float dc = dArc;
        if (tipLen > 1e-4) {
          dc = max(dc, halfW + dot(-ep, tipDir) / tipLen - halfW * max(miterLimit, 1.0));
          seAnd(eP, eQ, tipDir / tipLen, dot(-ep, tipDir) / tipLen - halfW * max(miterLimit, 1.0), seR); }
        thisD = dc;
      }

      if (kOwn != 0.0 || kOth != 0.0) eP = vec4(eP.xyz, min(eP.w, 1.0));
    } else {

      bool behindJoin = outWedge;
      if (behindJoin && (joinStyle == 1 || joinStyle == 2)) {
        eP = seSlab(-ep, tOwn, halfW, seR); eQ = vec4(0.0);
        if (dot(-ep, uOwn) > 0.0) seAnd(eP, eQ, uOwn, dot(-ep, uOwn), seR);
      }
      if (behindJoin && joinStyle != 1 && joinStyle != 2) drop = true;
      else if (behindJoin) thisD = dot(-ep, uOwn) > 0.0 ? max(min(thisD, length(ep)), halfW + dot(-ep, uOwn)) : min(thisD, length(ep));
      else if (joinStyle == 1) {

        vec2 uF = atS ? uOth : uOwn, uS = atS ? uOwn : uOth;
        vec2 uJ = dot(-ep, uF) <= dot(-ep, uS) ? uF : uS;
        seDisc(eP, eQ, -ep, uJ, halfW);
      }
      else if (joinStyle == 2) {

        float cr = din.x * dout.y - din.y * dout.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(din.y, -din.x), nB = sd * vec2(dout.y, -dout.x);
        vec2 nb = nA + nB; float bl = length(nb);

        eP = vec4(0.0); eQ = vec4(0.0);
        seAnd(eP, eQ, seSide(-ep, tOwn, halfW), seR); seAnd(eP, eQ, seSide(-ep, tOth, halfW), seR);
        if (bl > 1e-4) { vec2 bis = nb / bl; seAnd(eP, eQ, bis, dot(-ep, bis) - halfW * dot(nA, bis), seR);
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
        else { seAnd(eP, eQ, uOwn, dot(-ep, uOwn), seR); thisD = max(thisD, halfW + dot(-ep, uOwn)); }
      }
    }
  }

  if (!drop && t > 1e-4 && t < 1.0 - 1e-4) {
    vec2 cpF = -thisD * gradIO;
    float endD = -1e30;
    if (freeStart && startCap == 0) {
      vec2 sn = strokeUnit(dStart);
      vec2 qv = -pStart;
      float aOut = dot(qv, -sn), lat = dot(qv, vec2(-sn.y, sn.x)), kL = curv.x * lat;
      bool own = aOut <= 0.0 && length(cpF - pStart) <= 2.0 * seR - aOut && length(dStart) * t <= 2.0 * seR - aOut;
      if (own && abs(lat) <= halfW && kL <= 1.0) endD = halfW + aOut;

      if (own && abs(lat) <= halfW + seR && kL <= 1.0) seAnd(eP, eQ, -sn, aOut, seR);
    }
    if (freeEnd && endCap == 0) {
      vec2 en = strokeUnit(dEnd);
      vec2 qv = -pEnd;
      float aOut = dot(qv, en), lat = dot(qv, vec2(-en.y, en.x)), kL = curv.y * lat;
      bool own = aOut <= 0.0 && length(cpF - pEnd) <= 2.0 * seR - aOut && length(dEnd) * (1.0 - t) <= 2.0 * seR - aOut;
      if (own && abs(lat) <= halfW && kL <= 1.0) endD = max(endD, halfW + aOut);
      if (own && abs(lat) <= halfW + seR && kL <= 1.0) seAnd(eP, eQ, en, aOut, seR);
    }
    if (endD > thisD) { thisD = endD; gradIO = vec2(0.0); }

    bool atEndU = freeStart || (!freeEnd && t >= 0.5);
    if ((eP.w == 1.0 || eP.w == 9.0) && (atEndU ? !freeEnd : !freeStart)) {
      vec2 own = strokeUnit(atEndU ? dEnd : dStart), nbU = atEndU ? outTan : inTan, qU = -(atEndU ? pEnd : pStart);
      float turn = atEndU ? own.x * nbU.y - own.y * nbU.x : nbU.x * own.y - nbU.y * own.x;
      if (abs(turn) > 1.0 / 64.0 && dot(qU, vec2(-own.y, own.x)) * turn > 0.0) {
        vec2 pnU = vec2(-nbU.y, nbU.x) * (turn > 0.0 ? 1.0 : -1.0);
        seOr(eP, eQ, pnU, dot(qU, pnU) - halfW, seR);
      }
    }
  }

  float dSpill = 1e30;
  if (dashId > 0 && (t < 1e-4 || t > 1.0 - 1e-4)) {
    bool atSp = t < 1e-4;
    vec2 epSp = atSp ? pStart : pEnd;
    vec2 tSp = strokeUnit(atSp ? dStart : dEnd);
    int capSp = atSp ? startCap : endCap;
    float aSp = dot(-epSp, tSp);
    if (!(atSp ? freeStart : freeEnd) && capSp != 0 && (atSp ? aSp < 0.0 : aSp > 0.0)) {
      float latSp = length(-epSp - tSp * aSp);
      vec2 rSp = dashCapReach(dashId, startDist + arcLenAtT + aSp, startCap == 0 && endCap == 0);
      float oSp = atSp ? rSp.y : rSp.x;

      bool seamHere = (atSp ? strokeSeamMergeLo : strokeSeamMergeHi) && abs(oSp - abs(aSp)) <= strokeSeamTol;
      if (oSp >= abs(aSp) * 0.999995 && oSp < 1e29 && !seamHere) dSpill = capSp == 2 ? max(latSp, oSp) : length(vec2(latSp, oSp));
    }
  }
  if (drop) { eP = vec4(0.0); eQ = vec4(0.0); return min(minDIn, dSpill); }
  if (dashId > 0) {

    float along = t <= 0.0 ? dot(-pStart, strokeUnit(dStart)) : t >= 1.0 ? dot(-pEnd, strokeUnit(dEnd)) : 0.0;

    float dIn = thisD;
    vec2 gIn = gradIO;
    if (roundEnd && along != 0.0) {
      float lat = length(latV);
      dIn = lat;
      gradIO = lat > 0.0 ? latV / lat : vec2(0.0);
    }
    float dOut = strokeDashDist(dIn, gradIO, tanT, halfW, dashId, startDist + arcLenAtT + along, startCap, endCap,
                                startDist, dashEnd, seR, eP, eQ);
    if (dOut == dIn && roundEnd && along != 0.0) gradIO = gIn;
    else thisD = dOut;
  }

  if (eP.w == 1.0 && abs(eP.z - (thisD - halfW)) > (1.0 / 1024.0) * seR) { eP = vec4(0.0); eQ = vec4(0.0); }
  if (dSpill < thisD) { eP = vec4(0.0); eQ = vec4(0.0); gradIO = vec2(0.0); thisD = dSpill; }
  return min(minDIn, thisD);
}

float d2AtT(vec4 cx, vec4 cy, float t) { float x = evalC(cx, t), y = evalC(cy, t); return x * x + y * y; }

float cdPoly(float c5, float c4, float c3, float c2, float c1, float c0, int lv, float t) {
  if (lv == 3) return (60.0 * c5 * t + 24.0 * c4) * t + 6.0 * c3;
  if (lv == 2) return ((20.0 * c5 * t + 12.0 * c4) * t + 6.0 * c3) * t + 2.0 * c2;
  if (lv == 1) return (((5.0 * c5 * t + 4.0 * c4) * t + 3.0 * c3) * t + 2.0 * c2) * t + c1;
  return ((((c5 * t + c4) * t + c3) * t + c2) * t + c1) * t + c0;
}

float cubicClosestDescend2(vec4 cx, vec4 cy, out float tIn) {

  vec4 cm = max(abs(cx), abs(cy));
  uint cE = min(floatBitsToUint(max(cm.x, max(cm.y, cm.z))) & 0x7F800000u, 0x7E800000u);
  float cK = cE == 0u ? 1.0 : uintBitsToFloat(0x7F000000u - cE);
  cx *= cK; cy *= cK;

  float c5 = 3.0 * (cx.x * cx.x + cy.x * cy.x);
  float c4 = 5.0 * (cx.x * cx.y + cy.x * cy.y);
  float c3 = 4.0 * (cx.x * cx.z + cy.x * cy.z) + 2.0 * (cx.y * cx.y + cy.y * cy.y);
  float c2 = 3.0 * (cx.y * cx.z + cy.y * cy.z) + 3.0 * (cx.x * cx.w + cy.x * cy.w);
  float c1 = (cx.z * cx.z + cy.z * cy.z) + 2.0 * (cx.y * cx.w + cy.y * cy.w);
  float c0 = cx.w * cx.z + cy.w * cy.z;

  float rts[6];
  int nr = 0;

  {
    float A = 60.0 * c5, B = 24.0 * c4, C = 6.0 * c3;
    float sc = max(abs(A), max(abs(B), abs(C)));
    if (sc > 0.0) {
      if (abs(A) <= 1e-12 * sc) {
        if (abs(B) > 1e-12 * sc) { float r = -C / B; if (r > 0.0 && r < 1.0) rts[nr++] = r; }
      } else {
        float dq = B * B - 4.0 * A * C;
        if (dq >= 0.0) {
          float sq = sqrt(dq);
          float q = -0.5 * (B + (B >= 0.0 ? sq : -sq));
          float r0 = q / A;
          float r1 = (abs(q) > 0.0) ? C / q : r0;
          float lo = min(r0, r1), hi = max(r0, r1);
          if (lo > 0.0 && lo < 1.0) rts[nr++] = lo;
          if (hi > lo && hi > 0.0 && hi < 1.0) rts[nr++] = hi;
        }
      }
    }
  }

  for (int lv = 2; lv >= 0; lv--) {
    float nxt[6];
    int nn = 0;
    float lo = 0.0, flo = cdPoly(c5, c4, c3, c2, c1, c0, lv, 0.0);
    for (int i = 0; i <= 6; i++) {
      if (i > nr) break;
      float hi = (i == nr) ? 1.0 : rts[i];
      float fhi = cdPoly(c5, c4, c3, c2, c1, c0, lv, hi);

      if (flo == 0.0 && lo > 0.0 && nn < 6) nxt[nn++] = lo;
      if (flo * fhi < 0.0) {

        float a = lo, b = hi, fa = flo;
        for (int k = 0; k < 24; k++) {
          float m = 0.5 * (a + b);
          float fm = cdPoly(c5, c4, c3, c2, c1, c0, lv, m);
          if (fa * fm <= 0.0) b = m; else { a = m; fa = fm; }
        }
        if (nn < 6) nxt[nn++] = 0.5 * (a + b);
      }
      lo = hi; flo = fhi;
    }
    nr = nn;
    for (int i = 0; i < 6; i++) rts[i] = nxt[i];
  }

  float d0 = d2AtT(cx, cy, 0.0), d1 = d2AtT(cx, cy, 1.0);
  float bt = (d0 <= d1) ? 0.0 : 1.0;
  float bs = min(d0, d1), bi = 1e30;
  tIn = -1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= nr) break;
    float tt = clamp(rts[i], 0.0, 1.0);
    float dd = d2AtT(cx, cy, tt);
    if (dd < bs) { bs = dd; bt = tt; }
    if (rts[i] > 0.0 && rts[i] < 1.0 && dd < bi) { bi = dd; tIn = rts[i]; }
  }
  return bt;
}
float cubicClosestDescend(vec4 cx, vec4 cy) { float tIn; return cubicClosestDescend2(cx, cy, tIn); }

float curveAtan2(float y, float x) {
  return x == 0.0 ? sign(y) * 1.5707963267948966 : atan(y, x);
}

vec2 evalArc(float cx, float cy, float rx, float ry, float phi, float th) {
  float ct=cos(th), st=sin(th), cp=cos(phi), sp=sin(phi);
  return vec2(cx+cp*rx*ct-sp*ry*st, cy+sp*rx*ct+cp*ry*st);
}
float arcDyDtheta(float rx, float ry, float phi, float th) {
  float ct = cos(th), st = sin(th), cp = cos(phi), sp = sin(phi);
  return -sp * rx * st + cp * ry * ct;
}
float arcDxDtheta(float rx, float ry, float phi, float th) {
  float ct = cos(th), st = sin(th), cp = cos(phi), sp = sin(phi);
  return -cp * rx * st - sp * ry * ct;
}
const float TWO_PI = 6.28318530717958647692;
float hlslFmod(float x, float m) { return x - m * trunc(x / m); }

vec2 ellipseFootNearCircle(vec2 ab, vec2 p) {
  bool xMajor = ab.x >= ab.y;
  float e0 = xMajor ? ab.x : ab.y, e1 = xMajor ? ab.y : ab.x;
  float y0 = xMajor ? p.x : p.y, y1 = xMajor ? p.y : p.x;
  float x0, x1;
  if (y1 > 0.0) {
    if (y0 > 0.0) {

      float z0 = y0 / e0, z1 = y1 / e1, g = z0 * z0 + z1 * z1 - 1.0;
      if (g != 0.0) {
        float d = (e0 - e1) * (e0 + e1) / (e1 * e1), n0 = z0 + d * z0;
        float u0 = z1, u1 = g < 0.0 ? 1.0 : length(vec2(n0, z1));

        float u = n0 < d ? u0 : u1;
        for (int i = 0; i < 64; i++) {
          float q0 = n0 / (u + d), q1 = z1 / u;
          float gs = q0 * q0 + q1 * q1 - 1.0;
          if (gs > 0.0) u0 = u; else if (gs < 0.0) u1 = u; else break;

          float next = u + u * gs / (2.0 * (q0 * q0 * u / (u + d) + q1 * q1));
          if (next == u) break;
          if (!(next > u0 && next < u1)) next = .5 * (u0 + u1);
          if (next == u || next == u0 || next == u1) break;
          u = next;
        }
        x0 = (y0 + d * y0) / (u + d); x1 = y1 / u;
      } else { x0 = y0; x1 = y1; }
    } else { x0 = 0.0; x1 = e1; }
  } else {
    float num = e0 * y0, den = (e0 - e1) * (e0 + e1);
    if (num < den) { float xd = num / den; x0 = e0 * xd; x1 = e1 * sqrt(max(1.0 - xd * xd, 0.0)); }
    else { x0 = e0; x1 = 0.0; }
  }
  return xMajor ? vec2(x0, x1) : vec2(x1, x0);
}

float distToEllipse(vec2 ab, vec2 pIn, out vec2 foot) {

  vec2 sgn = vec2(pIn.x < 0.0 ? -1.0 : 1.0, pIn.y < 0.0 ? -1.0 : 1.0);
  vec2 p = abs(pIn);
  bool swap = p.x > p.y;
  if (swap) { p = p.yx; ab = ab.yx; }
  float l = ab.y * ab.y - ab.x * ab.x;

  if (l == 0.0) {

    float pm = max(p.x, p.y);
    vec2 fq = pm > 0.0 ? ab.x * normalize(p / pm) : vec2(ab.x, 0.0);
    vec2 fo = swap ? fq.yx : fq.xy;
    foot = sgn * fo;
    return length(pIn - foot);
  }
  if (abs(ab.y - ab.x) < (1.0 / 64.0) * max(ab.x, ab.y)) {
    vec2 fq = ellipseFootNearCircle(ab, p);
    vec2 fo = swap ? fq.yx : fq.xy;
    foot = sgn * fo;
    return length(pIn - foot);
  }
  float m = ab.x * p.x / l; float m2 = m * m;
  float n = ab.y * p.y / l; float n2 = n * n;
  float c = (m2 + n2 - 1.0) / 3.0; float c3 = c * c * c;
  float q = c3 + m2 * n2 * 2.0;
  float d = c3 + m2 * n2;
  float g = m + m * n2;
  float co;
  if (d < 0.0) {
    float h = acos(clamp(q / c3, -1.0, 1.0)) / 3.0;
    float s = cos(h);
    float t = sin(h) * sqrt(3.0);
    float rx = sqrt(max(-c * (s + t + 2.0) + m2, 0.0));
    float ry = sqrt(max(-c * (s - t + 2.0) + m2, 0.0));
    co = (ry + sign(l) * rx + abs(g) / (rx * ry + 1e-20) - m) / 2.0;
  } else {
    float h = 2.0 * m * n * sqrt(d);
    float s = sign(q + h) * pow(abs(q + h), 1.0 / 3.0);
    float u = sign(q - h) * pow(abs(q - h), 1.0 / 3.0);
    float rx = -s - u - c * 4.0 + 2.0 * m2;
    float ry = (s - u) * sqrt(3.0);
    float rm = sqrt(rx * rx + ry * ry);
    co = (ry / sqrt(max(rm - rx, 1e-20)) + 2.0 * g / (rm + 1e-20) - m) / 2.0;
  }
  co = clamp(co, 0.0, 1.0);
  vec2 fq = vec2(ab.x * co, ab.y * sqrt(max(1.0 - co * co, 0.0)));
  vec2 fo = swap ? fq.yx : fq.xy;
  foot = sgn * fo;
  return length(pIn - foot);
}

bool arcInRange(float t, float tS, float tE) {
  if (abs(tE - tS) >= TWO_PI) return true;
  float dur = tE - tS;
  float d = hlslFmod(t - tS, TWO_PI);
  if (d < 0.0) d += TWO_PI;
  if (dur > 0.0) return d < dur;
  if (d > 0.0) d -= TWO_PI;
  return d > dur;
}

float arcFootAngle(vec2 radii, vec2 foot, float tS, float tE, out bool inRange) {
  if (radii.x != 0.0 && radii.y != 0.0) {

    float fx = foot.x * radii.y, fy = foot.y * radii.x;
    float t = fx == 0.0 ? (fy == 0.0 ? 0.0 : (fy < 0.0 ? -0.25 * TWO_PI : 0.25 * TWO_PI)) : atan(fy, fx);
    inRange = arcInRange(t, tS, tE);
    return t;
  }
  if (radii.x == 0.0 && radii.y == 0.0) { inRange = true; return tS; }
  float a = radii.x != 0.0 ? acos(clamp(foot.x / radii.x, -1.0, 1.0)) : asin(clamp(foot.y / radii.y, -1.0, 1.0));
  float b = radii.x != 0.0 ? -a : 0.5 * TWO_PI - a;
  bool ia = arcInRange(a, tS, tE);
  inRange = ia || arcInRange(b, tS, tE);
  return ia ? a : b;
}

float arcClosestFoot(vec2 radii, vec2 p, float tS, float tE,
                     out vec2 foot, out float angle, out bool inRange) {
  float distance = distToEllipse(radii, p, foot);
  angle = arcFootAngle(radii, foot, tS, tE, inRange);
  if (inRange || min(radii.x, radii.y) == 0.0 || radii.x == radii.y) return distance;
  bool swapAxes = radii.x < radii.y;
  float scale = max(radii.x, radii.y), b = min(radii.x, radii.y) / scale;
  vec2 q = (swapAxes ? p.yx : p) / scale;
  float delta = (1.0 - b) * (1.0 + b);
  float A = abs(q.x) / delta, B = b * abs(q.y) / delta;
  if (A >= 1.0 || B >= 1.0) return distance;
  vec2 candidate;
  if (B == 0.0) {
    candidate = vec2(A * (q.x < 0.0 ? -1.0 : 1.0), -b * sqrt(max(0.0, 1.0 - A * A)));
  } else if (A == 0.0) {
    candidate = vec2(0.0, q.y < 0.0 ? b : -b);
  } else {
    float a23 = pow(A, 2.0 / 3.0), b23 = pow(B, 2.0 / 3.0);
    if (a23 + b23 >= 1.0) return distance;
    float lo = B, hi = b23 / (a23 + b23), v = lo;
    for (int i = 0; i < 32; i++) {
      float x = A / (1.0 - v), y = B / v;
      float f = x * x + y * y - 1.0;
      if (f == 0.0) break;
      if (f > 0.0) lo = v; else hi = v;
      float derivative = 2.0 * (x * x / (1.0 - v) - y * y / v);
      float next = v - f / derivative;
      if (next == v) break;
      if (!(next > lo && next < hi)) next = .5 * (lo + hi);
      if (next == v || next == lo || next == hi) break;
      v = next;
    }
    candidate = vec2(A / (1.0 - v) * (q.x < 0.0 ? -1.0 : 1.0),
      -b * B / v * (q.y < 0.0 ? -1.0 : 1.0));
  }
  candidate = (swapAxes ? candidate.yx : candidate) * scale;
  bool candidateInRange;
  float candidateAngle = arcFootAngle(radii, candidate, tS, tE, candidateInRange);
  if (candidateInRange) {
    foot = candidate; angle = candidateAngle; inRange = true;
    return length(p - candidate);
  }
  return distance;
}

float arcArcLen(vec4 d1, vec4 d2, float t) {
  float dth = d2.y - d2.x;

  if (d1.z == d1.w) return t * abs(dth) * abs(d1.z);
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float th = d2.x + dth * (t * SLUG_GL16_N[i]);
    float st = sin(th), ct = cos(th);
    sum += SLUG_GL16_W[i] * sqrt(d1.z * d1.z * st * st + d1.w * d1.w * ct * ct);
  }
  return t * abs(dth) * sum;
}

float strokeArcAccum(vec2 pc, vec2 radii, float phi, float th0, float th1,
                     bool freeStart, bool freeEnd,
                     int startCap, int endCap,
                     int joinStyle, float miterLimit, float halfW,
                     vec2 inTan, vec2 outTan,
                     int dashId, float startDist,
                     vec4 curv, float minDIn, out vec2 gradOut, float seR, out vec4 edgeP, out vec4 edgeQ) {
  gradOut = vec2(0.0);
  float cphi = cos(phi), sphi = sin(phi);
  vec2 pR = vec2(pc.x * cphi + pc.y * sphi, -pc.x * sphi + pc.y * cphi);

  vec2 ep0 = evalArc(0.0, 0.0, radii.x, radii.y, phi, th0) - pc;
  vec2 ep1 = evalArc(0.0, 0.0, radii.x, radii.y, phi, th1) - pc;
  float dE = min(length(ep0), length(ep1));
  vec2 foot;
  bool inRange;
  float tAng;
  float dEdge = arcClosestFoot(radii, pR, th0, th1, foot, tAng, inRange);
  if (inRange && dEdge > dE) inRange = false;
  float arcD = inRange ? min(dEdge, dE) : dE;

  if (inRange && dEdge > 0.0) {
    vec2 gl2 = (pR - foot) / dEdge;
    gradOut = vec2(gl2.x * cphi - gl2.y * sphi, gl2.x * sphi + gl2.y * cphi);
  }
  float dth = th1 - th0;
  vec2 dStart = vec2(arcDxDtheta(radii.x, radii.y, phi, th0),
                     arcDyDtheta(radii.x, radii.y, phi, th0)) * dth;
  vec2 dEnd   = vec2(arcDxDtheta(radii.x, radii.y, phi, th1),
                     arcDyDtheta(radii.x, radii.y, phi, th1)) * dth;

  if (radii.x == 0.0 || radii.y == 0.0) { dStart = ep1 - ep0; dEnd = dStart; }

  if (joinStyle != 4) curv = (radii.x == 0.0 || radii.y == 0.0) ? vec4(0.0, 0.0, curv.zw)
    : vec4(seKappa(dStart, -(ep0 + pc) * dth * dth, 0.0), seKappa(dEnd, -(ep1 + pc) * dth * dth, 0.0), curv.zw);
  float tArc;
  if (inRange) {
    float dd = hlslFmod(tAng - th0, TWO_PI);
    if (dd < 0.0) dd += TWO_PI;
    if (dth < 0.0 && dd > 0.0) dd -= TWO_PI;
    tArc = clamp(dd / dth, 0.0, 1.0);
  } else {
    tArc = (length(ep0) <= length(ep1)) ? 0.0 : 1.0;
  }
  float arcLenAtT = (dashId > 0)
    ? arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), tArc) : 0.0;

  float thT = th0 + tArc * dth;
  vec2 tanT = (dashId > 0) ? strokeUnit(vec2(arcDxDtheta(radii.x, radii.y, phi, thT), arcDyDtheta(radii.x, radii.y, phi, thT)) * dth)
                           : vec2(0.0);
  vec2 g = gradOut;

  float tEnd = tArc;
  if (radii.x == 0.0 || radii.y == 0.0) {
    vec2 ch = ep1 - ep0;
    float c2 = dot(ch, ch);
    if (c2 > 0.0) tEnd = clamp(-dot(ep0, ch) / c2, 0.0, 1.0);
  }
  float md = strokeCapsJoinsDash(tEnd, arcD, ep0, ep1, dStart, dEnd,
                                 freeStart, freeEnd, startCap, endCap,
                                 joinStyle, miterLimit, halfW, inTan, outTan,
                                 dashId, startDist, arcLenAtT, curv, minDIn, g, tanT,
                                 (dashId > 0) ? startDist + arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), 1.0) : 1e30,
                                 seR, edgeP, edgeQ);

  if (radii.x != 0.0 && radii.y != 0.0) {
    for (int e = 0; e < 2; e++) {
      if ((e == 0 && tEnd < 1e-4) || (e == 1 && tEnd > 1.0 - 1e-4)) continue;
      if (tEnd >= 1e-4 && tEnd <= 1.0 - 1e-4 && !strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;
      vec2 pE = e == 0 ? ep0 : ep1, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
      if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + seR) continue;
      if (joinStyle == 4 && !(e == 0 ? freeStart : freeEnd)) continue;
      vec2 gK = vec2(0.0);
      vec4 eP2, eQ2;
      float mdK = strokeCapsJoinsDash(float(e), length(pE), ep0, ep1, dStart, dEnd,
                                      freeStart, freeEnd, startCap, endCap,
                                      joinStyle, miterLimit, halfW, inTan, outTan,
                                      dashId, startDist,
                                      (dashId > 0 && e == 1) ? arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), 1.0) : 0.0,
                                      curv, minDIn, gK, strokeUnit(e == 0 ? dStart : dEnd),
                                      (dashId > 0) ? startDist + arcArcLen(vec4(0.0, 0.0, radii.x, radii.y), vec4(th0, th1, phi, 0.0), 1.0) : 1e30,
                                      seR, eP2, eQ2);
      if (mdK < md) { md = mdK; edgeP = eP2; edgeQ = eQ2; g = gK; }
    }
  }
  gradOut = g;
  if (md >= minDIn) gradOut = vec2(0.0);
  return md;
}

float strokeCubicAccum(vec4 p12, vec4 p34,
                           bool freeStart, bool freeEnd,
                           int startCap, int endCap,
                           int joinStyle, float miterLimit,
                           float halfW,
                           vec2 inTan, vec2 outTan,
                           int dashId, float startDist,
                           vec4 curv, float minDIn, out vec2 gradOut, float seR, out vec4 edgeP, out vec4 edgeQ) {

  bool fromEnd = dot(p34.zw, p34.zw) < dot(p12.xy, p12.xy);
  vec4 q12 = fromEnd ? vec4(p34.zw, p34.xy) : p12;
  vec4 q34 = fromEnd ? vec4(p12.zw, p12.xy) : p34;
  vec4 cx = cubicCoeff(q12.x, q12.z, q34.x, q34.z);
  vec4 cy = cubicCoeff(q12.y, q12.w, q34.y, q34.w);
  float uIn;
  float u = cubicClosestDescend2(cx, cy, uIn);
  float pxv = evalC(cx, u);
  float pyv = evalC(cy, u);
  float t = fromEnd ? 1.0 - u : u;
  float thisD = sqrt(pxv * pxv + pyv * pyv);

  vec2 pEnd = p34.zw;

  vec2 lo4 = min(min(p12.xy, p12.zw), min(p34.xy, p34.zw)), hi4 = max(max(p12.xy, p12.zw), max(p34.xy, p34.zw));
  float dirMin = 1e-9 * max(hi4.x - lo4.x, hi4.y - lo4.y);
  vec2 dStart = 3.0 * (p12.zw - p12.xy);
  if (!(length(dStart) > dirMin)) dStart = p34.xy - p12.zw;
  if (!(length(dStart) > dirMin)) dStart = p34.zw - p12.xy;
  vec2 dEnd = 3.0 * (p34.zw - p34.xy);
  if (!(length(dEnd) > dirMin)) dEnd = p34.xy - p12.zw;
  if (!(length(dEnd) > dirMin)) dEnd = p34.zw - p12.xy;

  if (joinStyle != 4) {
    float m = max(max(length(p12.xy), length(p12.zw)), max(length(p34.xy), length(p34.zw)));
    vec2 a0 = 6.0 * (p12.xy - 2.0 * p12.zw + p34.xy), a1 = 6.0 * (p12.zw - 2.0 * p34.xy + p34.zw);
    curv = vec4(seKappa(dStart, a0, seKappaErr(m, dStart, a0)), seKappa(dEnd, a1, seKappaErr(m, dEnd, a1)), curv.zw);
  }

  vec2 g = (t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 0.0)
            ? (vec2(-pxv, -pyv) / thisD) : vec2(0.0);

  float arcLenAtT = (dashId > 0)
    ? slugCubicArcLen(cubicCoeff(p12.x, p12.z, p34.x, p34.z), cubicCoeff(p12.y, p12.w, p34.y, p34.w), clamp(t, 0.0, 1.0))
    : 0.0;

  vec2 tanT = vec2(0.0);
  if (dashId > 0) {
    float tc = clamp(t, 0.0, 1.0);
    tanT = strokeUnit(vec2(evalCD(cubicCoeff(p12.x, p12.z, p34.x, p34.z), tc), evalCD(cubicCoeff(p12.y, p12.w, p34.y, p34.w), tc)));
    if (dot(tanT, tanT) == 0.0) tanT = strokeUnit(tc < 0.5 ? dStart : dEnd);
  }
  float cT1 = 0.0, cT2 = 0.0, cD1 = 0.0, cD2 = 0.0, cU1 = 0.0, cU2 = 0.0;
  vec2 cQ1 = vec2(0.0), cQ2 = vec2(0.0), cG1 = vec2(0.0), cG2 = vec2(0.0);
  int nC = 1;
  if ((t < 1e-4 || t > 1.0 - 1e-4) && uIn >= 0.0) {
    vec2 qIn = vec2(evalC(cx, uIn), evalC(cy, uIn));
    float dIn = length(qIn);
    if (dIn > 0.0 && dIn < halfW + seR) { nC = 2; cT1 = fromEnd ? 1.0 - uIn : uIn; cD1 = dIn; cQ1 = qIn; cG1 = -qIn / dIn; cU1 = uIn; }
  } else if (t >= 1e-4 && t <= 1.0 - 1e-4) {
    for (int e = 0; e < 2; e++) {
      if (!strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;
      vec2 pE = e == 0 ? p12.xy : pEnd, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
      if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + seR) continue;
      float tE = float(e);
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  if (t < 1e-4 || t > 1.0 - 1e-4) {

    float tE = t < 1e-4 ? 1.0 : 0.0;
    vec2 pE = tE == 0.0 ? p12.xy : pEnd, uE = tE == 0.0 ? -strokeUnit(dStart) : strokeUnit(dEnd);

    if (dot(-pE, uE) > 0.0 && length(pE) <= halfW * (max(miterLimit, 1.0) + 1.0) + seR && (joinStyle != 4 || (tE == 0.0 ? freeStart : freeEnd))) {
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  float md = 1e30;
  float t0 = t, d0 = thisD;
  vec2 g0 = g;
  for (int k = 0; k < nC; k++) {
    float tK = k == 0 ? t0 : (k == 1 ? cT1 : cT2), dK = k == 0 ? d0 : (k == 1 ? cD1 : cD2);
    vec2 gK = k == 0 ? g0 : (k == 1 ? cG1 : cG2);
    bool endK = k > 0 && (tK == 0.0 || tK == 1.0);
    float aK = k == 0 ? arcLenAtT : ((dashId > 0) ? slugCubicArcLen(cubicCoeff(p12.x, p12.z, p34.x, p34.z), cubicCoeff(p12.y, p12.w, p34.y, p34.w), tK) : 0.0);
    vec2 tanK = tanT;
    if (k > 0) {
      tanK = vec2(0.0);
      if (dashId > 0) { tanK = endK ? strokeUnit(tK < 0.5 ? dStart : dEnd) : strokeUnit(vec2(evalCD(cubicCoeff(p12.x, p12.z, p34.x, p34.z), tK), evalCD(cubicCoeff(p12.y, p12.w, p34.y, p34.w), tK))); if (dot(tanK, tanK) == 0.0) tanK = strokeUnit(tK < 0.5 ? dStart : dEnd); }
    }
    vec4 eP2, eQ2;
    float mdK = strokeCapsJoinsDash(tK, dK, p12.xy, pEnd, dStart, dEnd,
                                    freeStart, freeEnd, startCap, endCap,
                                    joinStyle, miterLimit, halfW, inTan, outTan,
                                    dashId, startDist,
                                    aK, curv, minDIn, gK, tanK,
                                    (dashId > 0) ? startDist + slugCubicArcLen(cubicCoeff(p12.x, p12.z, p34.x, p34.z), cubicCoeff(p12.y, p12.w, p34.y, p34.w), 1.0) : 1e30,
                                    seR, eP2, eQ2);
    if (k == 0 || mdK < md) {
      md = mdK; edgeP = eP2; edgeQ = eQ2; g = gK;
      if (k > 0) { u = k == 1 ? cU1 : cU2; pxv = (k == 1 ? cQ1 : cQ2).x; pyv = (k == 1 ? cQ1 : cQ2).y; t = tK; thisD = dK; }
    }
  }
  gradOut = g;
  return md;
}

float quadArcLen(vec2 p1, vec2 p2, vec2 p3, float t) {
  vec2 A = p1 - 2.0 * p2 + p3;
  vec2 B = p2 - p1;

  float lengthScale = max(max(abs(A.x), abs(A.y)), max(abs(B.x), abs(B.y)));
  if (!(lengthScale > 0.0)) return 0.0;
  A /= lengthScale; B /= lengthScale;
  float Aq = dot(A, A), Bq = 2.0 * dot(A, B), Cq = dot(B, B);
  if (Aq <= 1e-12 * Cq) return length((p3 - p1) / lengthScale) * lengthScale * t;
  float sqrtA = sqrt(Aq), disc = 4.0 * Aq * Cq - Bq * Bq;
  float ut = max(Aq * t * t + Bq * t + Cq, 0.0), sut = sqrt(ut);
  float argt = 2.0 * sqrtA * sut + 2.0 * Aq * t + Bq;
  float Ft = 2.0 * (((2.0 * Aq * t + Bq) * sut) / (4.0 * Aq)
           + ((argt > 1e-12 * (2.0 * sqrtA * sut + abs(2.0 * Aq * t + Bq))) ? (disc / (8.0 * Aq * sqrtA)) * log(argt) : 0.0));
  float su0 = sqrt(max(Cq, 0.0));
  float arg0 = 2.0 * sqrtA * su0 + Bq;
  float F0 = 2.0 * ((Bq * su0) / (4.0 * Aq)
           + ((arg0 > 1e-12 * (2.0 * sqrtA * su0 + abs(Bq))) ? (disc / (8.0 * Aq * sqrtA)) * log(arg0) : 0.0));
  return (Ft - F0) * lengthScale;
}

float quadClosestT2(vec2 A, vec2 B, vec2 C, out float tIn) {
  float a3 = 2.0 * dot(A, A);
  float a2 = 3.0 * dot(A, B);
  float a1 = dot(B, B) + 2.0 * dot(A, C);
  float a0 = dot(B, C);
  float cand[5];
  int n = 0;
  cand[0] = 0.0; cand[1] = 1.0; n = 2;
  if (abs(a3) < 1e-12 * max(abs(a2), max(abs(a1), abs(a0)))) {
    if (abs(a2) > 1e-30) {
      float disc = a1 * a1 - 4.0 * a2 * a0;
      if (disc >= 0.0) {
        float sd = sqrt(disc);
        float qq = -0.5 * (a1 + (a1 >= 0.0 ? sd : -sd));
        cand[n++] = qq / a2;
        if (abs(qq) > 1e-30) cand[n++] = a0 / qq;
      }
    } else if (abs(a1) > 1e-30) cand[n++] = -a0 / a1;
  } else {
    float p = a2 / a3, q2 = a1 / a3, r = a0 / a3;
    float pp = q2 - p * p / 3.0;
    float qq = (2.0 * p * p * p) / 27.0 - (p * q2) / 3.0 + r;
    float shift = -p / 3.0;
    float disc = qq * qq / 4.0 + pp * pp * pp / 27.0;
    if (disc > 0.0) {
      float sd = sqrt(disc);
      float u = -qq / 2.0 + sd, v = -qq / 2.0 - sd;
      float uc = sign(u) * pow(abs(u), 1.0 / 3.0);
      float vc = sign(v) * pow(abs(v), 1.0 / 3.0);
      cand[n++] = uc + vc + shift;
    } else {
      float rr = sqrt(max(-pp * pp * pp / 27.0, 0.0));
      float phi = acos(clamp(-qq / (2.0 * max(rr, 1e-30)), -1.0, 1.0));
      float m = 2.0 * sqrt(max(-pp / 3.0, 0.0));
      cand[n++] = m * cos(phi / 3.0) + shift;
      cand[n++] = m * cos((phi + 6.2831853071795865) / 3.0) + shift;
      cand[n++] = m * cos((phi + 12.566370614359172) / 3.0) + shift;
    }
  }

  for (int i = 2; i < 5; i++) {
    if (i >= n) break;
    float t0 = cand[i];
    float ft = ((a3 * t0 + a2) * t0 + a1) * t0 + a0;
    float df = (3.0 * a3 * t0 + 2.0 * a2) * t0 + a1;
    if (abs(df) > 1e-30) cand[i] = t0 - ft / df;
  }
  float bt = 0.0, bs = 1e30, bi = 1e30;
  tIn = -1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    float tt = clamp(cand[i], 0.0, 1.0);
    vec2 qv = (A * tt + B) * tt + C;
    float d2 = dot(qv, qv);
    if (d2 < bs) { bs = d2; bt = tt; }
    if (i >= 2 && cand[i] > 0.0 && cand[i] < 1.0 && d2 < bi) { bi = d2; tIn = cand[i]; }
  }
  return bt;
}
float quadClosestT(vec2 A, vec2 B, vec2 C) { float tIn; return quadClosestT2(A, B, C, tIn); }

float strokeQuadAccum(vec4 p12, vec2 p3,
                      bool freeStart, bool freeEnd,
                      int startCap, int endCap,
                      int joinStyle, float miterLimit, float halfW,
                      vec2 inTan, vec2 outTan,
                      int dashId, float startDist,
                      vec4 curv, float minDIn, out vec2 gradOut, float seR, out vec4 edgeP, out vec4 edgeQ) {
  vec2 p1 = p12.xy, p2 = p12.zw;

  bool fromEnd = dot(p3, p3) < dot(p1, p1);
  vec2 s0 = fromEnd ? p3 : p1;
  vec2 A = p1 - 2.0 * p2 + p3;
  vec2 B = 2.0 * (p2 - s0);
  float uIn;
  float u = quadClosestT2(A, B, s0, uIn);
  vec2 q = (A * u + B) * u + s0;
  float t = fromEnd ? 1.0 - u : u;
  float thisD = length(q);

  vec2 lo3 = min(min(p1, p2), p3), hi3 = max(max(p1, p2), p3);
  float dirMin = 1e-9 * max(hi3.x - lo3.x, hi3.y - lo3.y);

  vec2 dStart = 2.0 * (p2 - p1);
  if (!(length(dStart) > dirMin)) dStart = p3 - p1;

  vec2 dEnd = 2.0 * (p3 - p2);
  if (!(length(dEnd) > dirMin)) dEnd = p3 - p1;

  if (joinStyle != 4) {
    float m = max(max(length(p1), length(p2)), length(p3));
    curv = vec4(seKappa(dStart, 2.0 * A, seKappaErr(m, dStart, 2.0 * A)), seKappa(dEnd, 2.0 * A, seKappaErr(m, dEnd, 2.0 * A)), curv.zw);
  }

  vec2 g = (t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 0.0) ? (-q / thisD) : vec2(0.0);
  float arcLenAtT = (dashId > 0) ? quadArcLen(p1, p2, p3, clamp(t, 0.0, 1.0)) : 0.0;

  vec2 tanT = vec2(0.0);
  if (dashId > 0) {
    float tc = clamp(t, 0.0, 1.0);
    tanT = strokeUnit(mix(p2 - p1, p3 - p2, tc));
    if (dot(tanT, tanT) == 0.0) tanT = strokeUnit(p3 - p1);
  }
  float cT1 = 0.0, cT2 = 0.0, cD1 = 0.0, cD2 = 0.0, cU1 = 0.0, cU2 = 0.0;
  vec2 cQ1 = vec2(0.0), cQ2 = vec2(0.0), cG1 = vec2(0.0), cG2 = vec2(0.0);
  int nC = 1;
  if ((t < 1e-4 || t > 1.0 - 1e-4) && uIn >= 0.0) {
    vec2 qIn = (A * uIn + B) * uIn + s0;
    float dIn = length(qIn);
    if (dIn > 0.0 && dIn < halfW + seR) { nC = 2; cT1 = fromEnd ? 1.0 - uIn : uIn; cD1 = dIn; cQ1 = qIn; cG1 = -qIn / dIn; cU1 = uIn; }
  } else if (t >= 1e-4 && t <= 1.0 - 1e-4) {
    for (int e = 0; e < 2; e++) {
      if (!strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;
      vec2 pE = e == 0 ? p1 : p3, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
      if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + seR) continue;
      float tE = float(e);
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  if (t < 1e-4 || t > 1.0 - 1e-4) {

    float tE = t < 1e-4 ? 1.0 : 0.0;
    vec2 pE = tE == 0.0 ? p1 : p3, uE = tE == 0.0 ? -strokeUnit(dStart) : strokeUnit(dEnd);

    if (dot(-pE, uE) > 0.0 && length(pE) <= halfW * (max(miterLimit, 1.0) + 1.0) + seR && (joinStyle != 4 || (tE == 0.0 ? freeStart : freeEnd))) {
      if (nC == 1) { cT1 = tE; cD1 = length(pE); cQ1 = pE; cU1 = fromEnd ? 1.0 - tE : tE; }
      else { cT2 = tE; cD2 = length(pE); cQ2 = pE; cU2 = fromEnd ? 1.0 - tE : tE; }
      nC++;
    }
  }
  float md = 1e30;
  float t0 = t, d0 = thisD;
  vec2 g0 = g;
  for (int k = 0; k < nC; k++) {
    float tK = k == 0 ? t0 : (k == 1 ? cT1 : cT2), dK = k == 0 ? d0 : (k == 1 ? cD1 : cD2);
    vec2 gK = k == 0 ? g0 : (k == 1 ? cG1 : cG2);
    bool endK = k > 0 && (tK == 0.0 || tK == 1.0);
    float aK = k == 0 ? arcLenAtT : ((dashId > 0) ? quadArcLen(p1, p2, p3, tK) : 0.0);
    vec2 tanK = tanT;
    if (k > 0) {
      tanK = vec2(0.0);
      if (dashId > 0) { tanK = endK ? strokeUnit(mix(p2 - p1, p3 - p2, tK)) : strokeUnit(mix(p2 - p1, p3 - p2, tK)); if (dot(tanK, tanK) == 0.0) tanK = strokeUnit(tK < 0.5 ? dStart : dEnd); }
    }
    vec4 eP2, eQ2;
    float mdK = strokeCapsJoinsDash(tK, dK, p1, p3, dStart, dEnd,
                                    freeStart, freeEnd, startCap, endCap,
                                    joinStyle, miterLimit, halfW, inTan, outTan,
                                    dashId, startDist,
                                    aK, curv, minDIn, gK, tanK,
                                    (dashId > 0) ? startDist + quadArcLen(p1, p2, p3, 1.0) : 1e30,
                                    seR, eP2, eQ2);
    if (k == 0 || mdK < md) {
      md = mdK; edgeP = eP2; edgeQ = eQ2; g = gK;
      if (k > 0) { u = k == 1 ? cU1 : cU2; q = k == 1 ? cQ1 : cQ2; t = tK; thisD = dK; }
    }
  }
  gradOut = g;
  return md;
}

vec4 texFetch(ivec2 xy) { xy.y += xy.x >> 12; xy.x &= 4095; return texelFetch(uCurveData, xy, 0); }
vec4 bFetch(ivec2 xy) { return texelFetch(uBandData, xy, 0); }

void arcPoint(vec4 d1, float cp, float sp, vec2 cs, out vec2 p, out float dx, out float dy) {
  float ct = cs.x, st = cs.y;
  float ax = cp * d1.z, bx = sp * d1.w;
  float ay = sp * d1.z, by = cp * d1.w;
  p  = vec2(d1.x + ax * ct - bx * st,
            d1.y + ay * ct + by * st);
  dx = -ax * st - bx * ct;
  dy = -ay * st + by * ct;
}
void arcSample(vec4 d1, float cp, float sp, float th, out vec2 p, out float dx, out float dy) {
  arcPoint(d1, cp, sp, vec2(cos(th), sin(th)), p, dx, dy);
}

float arcRayUlpV(vec4 d1) { return 1.2e-7 * (abs(d1.x) + abs(d1.z) + abs(d1.w)); }

float arcPieceCross(float ta, float ua, float tb, float ub, float dir) {
  bool aNeg = ua < 0.0, bNeg = ub < 0.0;
  if (aNeg == bNeg) return 0.0;
  return ((dir > 0.0) ? bNeg : aNeg) ? 2.0 : 1.0;
}

vec3 arcRayCrossings(float lo, float hi, float dir, float A, float B, float C, float uLo, float uHi,
                     bool aa, out vec4 piece, out vec3 aux) {
  piece = vec4(lo, uLo, hi, uHi); aux = vec3(0.0, uLo, uHi);
  float rs = max(abs(A), abs(B));
  float Rlen = rs > 0.0 ? rs * length(vec2(A, B) / rs) : 0.0;
  if (!(Rlen > 0.0)) return vec3(0.0);

  bool nLo = uLo < 0.0;
  if (nLo == (uHi < 0.0) && nLo == (Rlen - C < 0.0) && nLo == (-Rlen - C < 0.0)) return vec3(0.0);

  float ang = (B == 0.0) ? (A >= 0.0 ? 0.0 : 0.5 * TWO_PI) : curveAtan2(B, A);
  aux.x = ang;

  float k0 = ceil((lo - ang) / (0.5 * TWO_PI)), k1 = k0 + 1.0;
  float e0 = ang + k0 * (0.5 * TWO_PI), e1 = ang + k1 * (0.5 * TWO_PI);
  bool in0 = e0 > lo && e0 < hi, in1 = e1 > lo && e1 < hi;
  float t1 = in0 ? e0 : lo, u1 = in0 ? (((mod(k0, 2.0) < 0.5) ? Rlen : -Rlen) - C) : uLo;
  float t2 = in1 ? e1 : hi, u2 = in1 ? (((mod(k1, 2.0) < 0.5) ? Rlen : -Rlen) - C) : uHi;
  piece = vec4(t1, u1, t2, u2);
  vec3 cr = vec3(arcPieceCross(lo, uLo, t1, u1, dir),
                 arcPieceCross(t1, u1, t2, u2, dir),
                 arcPieceCross(t2, u2, hi, uHi, dir));

  if (aa && abs(C / Rlen) >= 0.99999) {
    float nearU = ((C > 0.0) ? Rlen : -Rlen) - C;
    if (cr.x > 0.0 && cr.y > 0.0 && u1 == nearU) { cr.x = 0.0; cr.y = 0.0; }
    else if (cr.y > 0.0 && cr.z > 0.0 && u2 == nearU) { cr.y = 0.0; cr.z = 0.0; }

    else if (uLo == nearU && uHi == nearU) {
      if (cr.y > 0.0 && cr.z > 0.0) { cr.y = 0.0; cr.z = 0.0; }
      else if (cr.x > 0.0 && cr.y > 0.0) { cr.x = 0.0; cr.y = 0.0; }
    }
  }
  return cr;
}

float arcPieceRoot(float ta, float tb, float ub, float ang, float b2) {
  float t = (ub < 0.0) ? (ang + b2) : (ang - b2);
  float mid = 0.5 * (ta + tb);
  t += TWO_PI * floor((mid - t) / TWO_PI + 0.5);
  return clamp(t, ta, tb);
}
vec3 arcRayRoots(float lo, float hi, float A, float B, float C, vec4 piece, vec3 aux) {
  float rs = max(abs(A), abs(B));
  float Rlen = rs > 0.0 ? rs * length(vec2(A, B) / rs) : 0.0;
  float b2 = acos(clamp(C / Rlen, -1.0, 1.0));
  return vec3(arcPieceRoot(lo, piece.x, piece.y, aux.x, b2),
              arcPieceRoot(piece.x, piece.z, piece.w, aux.x, b2),
              arcPieceRoot(piece.z, hi, aux.z, aux.x, b2));
}

vec3 arcSweep(vec4 d2) {
  float lo = min(d2.x, d2.y);
  return vec3(lo, min(max(d2.x, d2.y), lo + TWO_PI), (d2.y >= d2.x) ? 1.0 : -1.0);
}

void arcEndsLoHi(vec4 e, float dir, out vec2 pLo, out vec2 pHi) {
  pLo = (dir > 0.0) ? e.xy : e.zw;
  pHi = (dir > 0.0) ? e.zw : e.xy;
}

vec2 bandBoxSize(vec4 bb) {
  vec2 e = bb.zw - bb.xy;
  return vec2(e.x > 0.0 ? e.x : (e.y > 0.0 ? e.y : 1.0), e.y > 0.0 ? e.y : (e.x > 0.0 ? e.x : 1.0));
}
ivec2 bLoc(ivec2 gl, int off) { ivec2 l=ivec2(gl.x+off, gl.y); l.y+=l.x>>12; l.x&=4095; return l; }

uniform int uStrokeGates;

int texLin(ivec2 xy) { return (xy.y << 12) + xy.x; }
vec4 bFetchL(int i) { return texelFetch(uBandData, ivec2(i & 4095, i >> 12), 0); }
vec4 cFetchL(int i) { return texelFetch(uCurveData, ivec2(i & 4095, i >> 12), 0); }

bool bandHasRayLanes(vec4 hdr1) { return (int(hdr1.y) & 1) != 0; }

bool fillRayReject(vec4 hdr1) { return bandHasRayLanes(hdr1); }

bool rayLaneMiss(vec4 e, float r) { return e.w - r < 0.0 || e.z - r >= 0.0; }

bool strokeHullOutOfReach(vec2 lo, vec2 hi, float reach) {
  vec2 dv = max(max(lo, -hi), vec2(0.0));
  return dot(dv, dv) > reach * reach;
}

bool strokeCubicPieceOut(vec2 a, vec2 b, vec2 c, vec2 d, float reach) {
  vec2 ch = d - a;
  float len = length(ch);
  vec2 u = len > 0.0 ? ch / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  vec4 su = vec4(dot(a, u), dot(b, u), dot(c, u), dot(d, u));
  vec4 sv = vec4(dot(a, v), dot(b, v), dot(c, v), dot(d, v));
  float lu = min(min(su.x, su.y), min(su.z, su.w)), hu = max(max(su.x, su.y), max(su.z, su.w));
  float lv = min(min(sv.x, sv.y), min(sv.z, sv.w)), hv = max(max(sv.x, sv.y), max(sv.z, sv.w));
  vec2 g = vec2(max(max(lu, -hu), 0.0), max(max(lv, -hv), 0.0));
  vec4 ab = abs(vec4(a, b)), cd = abs(vec4(c, d));
  float r = reach * 1.0001 + 4e-6 * max(max(max(ab.x, ab.y), max(ab.z, ab.w)), max(max(cd.x, cd.y), max(cd.z, cd.w)));
  return dot(g, g) > r * r;
}

void strokeCubicSplit(inout vec2 a, inout vec2 b, inout vec2 c, inout vec2 d, out vec2 ra, out vec2 rb, out vec2 rc) {
  vec2 ab = 0.5 * (a + b), bc = 0.5 * (b + c), cd = 0.5 * (c + d);
  vec2 abc = 0.5 * (ab + bc), bcd = 0.5 * (bc + cd);
  vec2 m = 0.5 * (abc + bcd);
  ra = m; rb = bcd; rc = cd;
  b = ab; c = abc; d = m;
}
bool strokeCubicOutOfReach(vec4 p12, vec4 p34, float reach) {
  vec2 a = p12.xy, b = p12.zw, c = p34.xy, d = p34.zw;
  vec2 ra, rb, rc;
  strokeCubicSplit(a, b, c, d, ra, rb, rc);
  vec2 rd = p34.zw;
  vec2 qa, qb, qc;
  strokeCubicSplit(a, b, c, d, qa, qb, qc);
  vec2 qd = ra;
  if (!strokeCubicPieceOut(a, b, c, d, reach)) return false;
  if (!strokeCubicPieceOut(qa, qb, qc, qd, reach)) return false;
  strokeCubicSplit(ra, rb, rc, rd, qa, qb, qc);
  if (!strokeCubicPieceOut(ra, rb, rc, rd, reach)) return false;
  return strokeCubicPieceOut(qa, qb, qc, p34.zw, reach);
}

bool strokeQuadOutOfReach(vec2 a, vec2 b, vec2 c, float reach) {
  vec2 m1 = 0.5 * (a + b), m2 = 0.5 * (b + c), m = 0.5 * (m1 + m2);
  return strokeCubicPieceOut(a, m1, m1, m, reach) && strokeCubicPieceOut(m, m2, m2, c, reach);
}

vec2 strokeFrameMul(vec4 N, vec2 v) { return vec2(N.x * v.x + N.z * v.y, N.y * v.x + N.w * v.y); }
vec2 strokeFrameMulT(vec4 N, vec2 v) { return vec2(N.x * v.x + N.y * v.y, N.z * v.x + N.w * v.y); }

vec2 strokeFrameDir(vec4 N, vec2 t) { return strokeUnit(strokeFrameMul(N, t)); }

void strokeFrameArc(vec4 N, inout vec4 d1, inout vec4 d2) {
  float cp = cos(d2.z), sp = sin(d2.z);
  vec2 c0 = strokeFrameMul(N, vec2(cp, sp)) * d1.z;
  vec2 c1 = strokeFrameMul(N, vec2(-sp, cp)) * d1.w;
  float E = 0.5 * (c0.x + c1.y), F = 0.5 * (c0.x - c1.y), G = 0.5 * (c0.y + c1.x), H = 0.5 * (c0.y - c1.x);
  float Q = length(vec2(E, H)), R = length(vec2(F, G));

  float a1 = R > 0.0 ? curveAtan2(G, F) : 0.0, a2 = Q > 0.0 ? curveAtan2(H, E) : 0.0;
  float theta = 0.5 * (a2 - a1), sy = Q - R;
  float sgn = sy < 0.0 ? -1.0 : 1.0;
  d1 = vec4(strokeFrameMul(N, d1.xy), Q + R, abs(sy));
  d2 = vec4(sgn * (d2.x + theta), sgn * (d2.y + theta), 0.5 * (a2 + a1), d2.w);
}

float seDocKey(vec4 P, vec4 Q, vec4 N, float fallback) {
  if (P.w == 0.0) return fallback;
  float k1 = P.z / length(strokeFrameMulT(N, P.xy));
  if (P.w == 9.0 && dot(Q.xy, Q.xy) > 0.5) return max(k1, Q.z / length(strokeFrameMulT(N, Q.xy)));
  if (P.w == 1.0 || P.w == 4.0 || P.w >= 5.0) return k1;
  float k2 = Q.z / length(strokeFrameMulT(N, Q.xy));
  return P.w == 2.0 ? max(k1, k2) : min(k1, k2);
}

float strokeAaReachEm(float halfW, vec2 ePx) {
  return max(0.25 * (ePx.x + ePx.y) - halfW, 0.0) + 0.5 * length(ePx);
}

float strokeRampSatD(float halfWVis, float pxSize) {
  float p = max(pxSize, 1e-30);
  return halfWVis - 0.501 * p - 1e-6 * halfWVis;
}

void seJoinRecord(vec2 q, vec2 din, vec2 dout, bool ownIn, int joinStyle, float miterLimit, float halfW, float reach,
                  out vec4 P, out vec4 Q) {
  P = vec4(0.0); Q = vec4(0.0);
#ifdef MANTLE_STROKE_EXACT

  if (joinStyle == 1) { seDisc(P, Q, q, ownIn ? din : -dout, halfW); return; }

  float cr = din.x * dout.y - din.y * dout.x, sd = cr >= 0.0 ? 1.0 : -1.0;
  vec2 nA = sd * vec2(din.y, -din.x), nB = sd * vec2(dout.y, -dout.x);
  seAnd(P, Q, nA, dot(q, nA) - halfW, reach); seAnd(P, Q, nB, dot(q, nB) - halfW, reach);
  float sinHalf = 0.5 * length(din + dout);
  bool fits = halfW / max(sinHalf, 1.17549435e-38) <= halfW * miterLimit;
  if (joinStyle == 2 || (joinStyle == 0 && !fits)) {
    vec2 nb = nA + nB;
    float bl = length(nb);
    if (bl > 1e-4) { vec2 bis = nb / bl; seAnd(P, Q, bis, dot(q, bis) - halfW * dot(nA, bis), reach); }
  } else if ((joinStyle == 3 || joinStyle == 4) && !fits) {
    vec2 tipDir = din - dout;
    float tipLen = length(tipDir);
    if (tipLen > 1e-4) seAnd(P, Q, tipDir / tipLen, dot(q, tipDir) / tipLen - halfW * max(miterLimit, 1.0), reach);
  }
#endif
}

bool seNearOuterJoin(vec2 q, vec2 din, vec2 dout, vec2 own, vec2 uOut, vec2 cpV, float reach) {
  float cr = din.x * dout.y - din.y * dout.x;
  if (cr == 0.0 || dot(q, uOut) <= -reach || length(cpV) > 2.0 * reach + max(-dot(q, uOut), 0.0)) return false;
  vec2 nOwn = (cr >= 0.0 ? 1.0 : -1.0) * vec2(own.y, -own.x);
  return dot(q, nOwn) > 0.0;
}

float strokeBandAccum(ivec2 gl, int hdrSlot,
                          vec2 c, float halfW,
                          int startCap, int endCap,
                          int joinStyle, float miterLimit,
                          int dashId, float minDIn, out vec2 gradOut, float satD, float aaEm,
                          vec4 N, bool framed, out vec4 edgeP, out vec4 edgeQ) {
  gradOut = vec2(0.0);

  edgeP = vec4(0.0); edgeQ = vec4(0.0);

  int hdrL = texLin(gl) + hdrSlot;
  vec4 cnts = bFetchL(hdrL);
  int nLine  = int(cnts.x);
  int nQuad  = int(cnts.y);
  int nCubic = int(cnts.z);
  int nArc   = int(cnts.w);
  vec4 hdr1 = bFetchL(hdrL + 1);
  int hE = texLin(gl) + int(hdr1.x);

  bool farGate = uStrokeGates != 0 && !bandHasRayLanes(hdr1);
  float minD = minDIn;

  float _ml = max(miterLimit, 1.0);
  float _reach = halfW * max((joinStyle == 0 ? _ml
                              : (joinStyle == 3 || joinStyle == 4) ? sqrt(_ml * _ml + 1.0) : 1.0),
                             (startCap == 2 || endCap == 2) ? 1.41421356 : 1.0) + aaEm;

  float sBreak = c.x - halfW - aaEm;
  float sFar = c.x + _reach;

  float bestKey = 1e30;

  float kMaxN = length(vec2(0.5 * (N.x + N.w), 0.5 * (N.y - N.z))) + length(vec2(0.5 * (N.x - N.w), 0.5 * (N.y + N.z)));

  float minD2 = 1e20, winD = 1e20;
  vec2 secN = vec2(0.0); float secE = 1e20;
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;
    int sL = int(segRaw.x);
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    vec4 pts = cFetchL(sL + 1);

    vec4 jn = (freeStart && freeEnd) ? vec4(0.0) : cFetchL(sL + 2);
    vec2 inTan  = jn.xy;
    vec2 outTan = jn.zw;
    vec2 a = pts.xy;
    vec2 b = pts.zw;

    vec2 cq = c;
    if (framed) {
      a = strokeFrameMul(N, a - c); b = strokeFrameMul(N, b - c); cq = vec2(0.0);
      inTan = strokeFrameDir(N, inTan); outTan = strokeFrameDir(N, outTan);
    }
    vec2 ab = b - a;

    float abLen2 = dot(ab, ab);

    if (abLen2 == 0.0 && freeStart && freeEnd && startCap == 0 && endCap == 0) continue;
    float abLen = sqrt(abLen2);
    float tRaw = abLen2 > 0.0 ? dot(cq - a, ab) / abLen2 : 0.0;
    vec2 segTan = abLen > 0.0 ? ab / abLen : ab;
    bool drop = false;

    float thisD = -1.0;

    vec4 sP = vec4(0.0), sQ = vec4(0.0);
    bool joinRec = false;
    if (tRaw < 0.0) {
      if (freeStart) {
        sP = seSlab(cq - a, segTan, halfW, aaEm);
        float aR = dot(cq - a, -segTan);
        if (startCap == 0) seAnd(sP, sQ, -segTan, aR, aaEm);
        else if (startCap == 2) seAnd(sP, sQ, -segTan, aR - halfW, aaEm);
        else seDisc(sP, sQ, cq - a, -segTan, halfW);
        if (startCap == 0) {

          thisD = max(length(cq - a), halfW + dot(cq - a, -segTan));
        }
        else if (startCap == 2) {

          float along = dot(cq - a, -segTan);
          thisD = max(length((cq - a) + segTan * along), along);
        }

      } else {

        bool ourTerritory = dot(cq - a, inTan) >= 0.0;
        if (!ourTerritory) {
          thisD = max(length(cq - a), halfW + dot(cq - a, -segTan));
          sP = seSlab(cq - a, segTan, halfW, aaEm);
          seAnd(sP, sQ, -segTan, dot(cq - a, -segTan), aaEm);
        } else {
          float cosBetween = dot(-segTan, inTan);
          float sinHalf = 0.5 * length(segTan + inTan);
          float miterLen = halfW / max(sinHalf, 1.17549435e-38);

          if (joinStyle == 1) seDisc(sP, sQ, cq - a, dot(cq - a, inTan) <= dot(cq - a, -segTan) ? inTan : -segTan, halfW);
          else { seAnd(sP, sQ, seSide(cq - a, segTan, halfW), aaEm); seAnd(sP, sQ, seSide(cq - a, inTan, halfW), aaEm); }

          bool bevelHere = joinStyle == 2 || (joinStyle == 0 && !(miterLen <= halfW * miterLimit));
          if (bevelHere) {

            float cr = inTan.x * segTan.y - inTan.y * segTan.x;
            float sd = (cr >= 0.0) ? 1.0 : -1.0;
            vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(segTan.y, -segTan.x);
            vec2 nb = nA + nB; float bl = length(nb);
            if (bl > 1e-4) { vec2 bis = nb / bl;
              thisD = max(length(cq - a), halfW + dot(cq - a, bis) - halfW * dot(nA, bis));
              seAnd(sP, sQ, bis, dot(cq - a, bis) - halfW * dot(nA, bis), aaEm); }
            else {
              thisD = max(length(cq - a), halfW + dot(cq - a, -segTan));
              seAnd(sP, sQ, -segTan, dot(cq - a, -segTan), aaEm); }
          }
          float along = dot(cq - a, -segTan);
          float capAlong = 0.0;

          if (joinStyle == 0 || joinStyle == 3 || joinStyle == 4) {

            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 0.0));
            if (miterLen <= halfW * miterLimit) capAlong = miterLen * cosHalf;
          }
          if (along <= capAlong) {
            float perpThis = length((cq - a) + segTan * along);

            vec2 nIn = vec2(-inTan.y, inTan.x);
            float perpOther = abs(dot(cq - a, nIn));

            thisD = max(perpThis, perpOther);
          } else if ((joinStyle == 3 || joinStyle == 4) && !(miterLen <= halfW * miterLimit)) {

            float perpThis = length((cq - a) + segTan * along);
            float perpOther = abs(dot(cq - a, vec2(-inTan.y, inTan.x)));
            vec2 tipDir = inTan - segTan;
            float tipLen = length(tipDir);
            thisD = max(perpThis, perpOther);
            if (tipLen > 1e-4)
              thisD = max(thisD, halfW + dot(cq - a, tipDir) / tipLen - halfW * _ml);
            if (tipLen > 1e-4) seAnd(sP, sQ, tipDir / tipLen, dot(cq - a, tipDir) / tipLen - halfW * _ml, aaEm);
          }
        }
      }
    }
    if (tRaw > 1.0) {
      if (freeEnd) {
        sP = seSlab(cq - b, segTan, halfW, aaEm);
        float aR = dot(cq - b, segTan);
        if (endCap == 0) seAnd(sP, sQ, segTan, aR, aaEm);
        else if (endCap == 2) seAnd(sP, sQ, segTan, aR - halfW, aaEm);
        else seDisc(sP, sQ, cq - b, segTan, halfW);
        if (endCap == 0) {

          thisD = max(length(cq - b), halfW + dot(cq - b, segTan));
        }
        else if (endCap == 2) {

          float along = dot(cq - b, segTan);
          thisD = max(length((cq - b) - segTan * along), along);
        }
      } else {

        bool ourTerritory = dot(cq - b, -outTan) >= 0.0;
        if (!ourTerritory) {
          thisD = max(length(cq - b), halfW + dot(cq - b, segTan));
          sP = seSlab(cq - b, segTan, halfW, aaEm);
          seAnd(sP, sQ, segTan, dot(cq - b, segTan), aaEm);
        } else {

          float cosBetween = dot(segTan, -outTan);
          float sinHalf = 0.5 * length(segTan + outTan);
          float miterLen = halfW / max(sinHalf, 1.17549435e-38);
          if (joinStyle == 1) seDisc(sP, sQ, cq - b, dot(cq - b, segTan) <= dot(cq - b, -outTan) ? segTan : -outTan, halfW);
          else { seAnd(sP, sQ, seSide(cq - b, segTan, halfW), aaEm); seAnd(sP, sQ, seSide(cq - b, outTan, halfW), aaEm); }
          bool bevelHere = joinStyle == 2 || (joinStyle == 0 && !(miterLen <= halfW * miterLimit));
          if (bevelHere) {

            float cr = segTan.x * outTan.y - segTan.y * outTan.x;
            float sd = (cr >= 0.0) ? 1.0 : -1.0;
            vec2 nA = sd * vec2(segTan.y, -segTan.x), nB = sd * vec2(outTan.y, -outTan.x);
            vec2 nb = nA + nB; float bl = length(nb);
            if (bl > 1e-4) { vec2 bis = nb / bl;
              thisD = max(length(cq - b), halfW + dot(cq - b, bis) - halfW * dot(nA, bis));
              seAnd(sP, sQ, bis, dot(cq - b, bis) - halfW * dot(nA, bis), aaEm); }
            else {
              thisD = max(length(cq - b), halfW + dot(cq - b, segTan));
              seAnd(sP, sQ, segTan, dot(cq - b, segTan), aaEm); }
          }
          float along = dot(cq - b, segTan);
          float capAlong = 0.0;

          if (joinStyle == 0 || joinStyle == 3 || joinStyle == 4) {

            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 0.0));
            if (miterLen <= halfW * miterLimit) capAlong = miterLen * cosHalf;
          }
          if (along <= capAlong) {
            float perpThis = length((cq - b) - segTan * along);
            vec2 nOut = vec2(-outTan.y, outTan.x);
            float perpOther = abs(dot(cq - b, nOut));
            thisD = max(perpThis, perpOther);
          } else if ((joinStyle == 3 || joinStyle == 4) && !(miterLen <= halfW * miterLimit)) {

            float perpThis = length((cq - b) - segTan * along);
            float perpOther = abs(dot(cq - b, vec2(-outTan.y, outTan.x)));
            vec2 tipDir = segTan - outTan;
            float tipLen = length(tipDir);
            thisD = max(perpThis, perpOther);
            if (tipLen > 1e-4)
              thisD = max(thisD, halfW + dot(cq - b, tipDir) / tipLen - halfW * _ml);
            if (tipLen > 1e-4) seAnd(sP, sQ, tipDir / tipLen, dot(cq - b, tipDir) / tipLen - halfW * _ml, aaEm);
          }
        }
      }
    }

    float dSpill = 1e30;
    if (dashId > 0 && ((tRaw < 0.0 && !freeStart && startCap != 0) || (tRaw > 1.0 && !freeEnd && endCap != 0))) {
      bool atSp = tRaw < 0.0;
      vec2 vSp = cq - (atSp ? a : b);
      float aSp = dot(vSp, segTan);
      float latSp = length(vSp - segTan * aSp);
      vec2 rSp = dashCapReach(dashId, hdr.w + tRaw * abLen, startCap == 0 && endCap == 0);
      float oSp = atSp ? rSp.y : rSp.x;
      bool seamHere = (atSp ? strokeSeamMergeLo : strokeSeamMergeHi) && abs(oSp - abs(aSp)) <= strokeSeamTol;
      if (oSp >= abs(aSp) * 0.999995 && oSp < 1e29 && !seamHere) dSpill = (atSp ? startCap : endCap) == 2 ? max(latSp, oSp) : length(vec2(latSp, oSp));
    }
    if (drop) {
      if (dSpill < minD) {
        minD2 = minD; minD = dSpill; gradOut = vec2(0.0);
        if (!framed) { edgeP = vec4(0.0); edgeQ = vec4(0.0); winD = dSpill; }
        else {
          float key = seDocKey(vec4(0.0), vec4(0.0), N, dSpill > halfW ? dSpill - halfW : (dSpill - halfW) / kMaxN);
          if (key < bestKey) { bestKey = key; edgeP = vec4(0.0); edgeQ = vec4(0.0); winD = dSpill; }
        }
      }
      continue;
    }
    float tC = clamp(tRaw, 0.0, 1.0);

    bool bodyHit = thisD < 0.0;
    vec2 bodyG = vec2(0.0);
    if (bodyHit) {
      vec2 closestPt = mix(a, b, tC);
      vec2 g = cq - closestPt;
      thisD = length(g);

      bodyG = thisD > 0.0 ? g / thisD : g;

      if (sP.w == 0.0) sP = thisD > 0.0 ? vec4(bodyG, thisD - halfW, -thisD - halfW > -aaEm ? 9.0 : 1.0)
                                        : seSlab(cq - a, segTan, halfW, aaEm);

      float endD = -1.0;
      if (freeStart && startCap == 0) endD = halfW + dot(cq - a, -segTan);
      if (freeEnd && endCap == 0) endD = max(endD, halfW + dot(cq - b, segTan));

      if (freeStart && startCap == 0) seAnd(sP, sQ, -segTan, dot(cq - a, -segTan), aaEm);
      if (freeEnd && endCap == 0) seAnd(sP, sQ, segTan, dot(cq - b, segTan), aaEm);
      if (endD > thisD) { thisD = endD; bodyHit = false; }

      bool atEndU = freeStart || (!freeEnd && tRaw >= 0.5);

      if (dashId == 0 && !framed && (sP.w == 1.0 || sP.w == 9.0) && (atEndU ? !freeEnd : !freeStart)) {
        vec2 qJ = cq - (atEndU ? b : a), dIn = atEndU ? segTan : inTan, dOut = atEndU ? outTan : segTan;
        joinRec = seNearOuterJoin(qJ, dIn, dOut, segTan, atEndU ? segTan : -segTan, mix(a, b, tC) - (atEndU ? b : a), aaEm);
        if (joinRec) seJoinRecord(qJ, dIn, dOut, atEndU, joinStyle, miterLimit, halfW, aaEm, sP, sQ);
      }
      if ((sP.w == 1.0 || sP.w == 9.0) && (atEndU ? !freeEnd : !freeStart)) {
        vec2 nbU = atEndU ? outTan : inTan, qU = cq - (atEndU ? b : a);
        float turn = atEndU ? segTan.x * nbU.y - segTan.y * nbU.x : nbU.x * segTan.y - nbU.y * segTan.x;
        if (abs(turn) > 1.0 / 64.0 && dot(qU, vec2(-segTan.y, segTan.x)) * turn > 0.0) {
          vec2 pnU = vec2(-nbU.y, nbU.x) * (turn > 0.0 ? 1.0 : -1.0);
          seOr(sP, sQ, pnU, dot(qU, pnU) - halfW, aaEm);
        }
      }

      bool capEndU = tRaw >= 0.5;
      vec2 qC = cq - (capEndU ? b : a), uC = capEndU ? segTan : -segTan;
      if (dashId == 0 && !framed && (sP.w <= 1.0 || sP.w == 9.0) && !joinRec && (capEndU ? freeEnd && endCap == 1 : freeStart && startCap == 1)
          && dot(qC, uC) > -aaEm)
        seDisc(sP, sQ, qC, uC, halfW);
    }

    if (dashId > 0) {
      vec2 gD = bodyHit ? bodyG : vec2(0.0);

      float dIn = thisD;
      vec2 gIn = gD;
      bool roundEnd = (tRaw < 0.0 && freeStart && startCap == 1) || (tRaw > 1.0 && freeEnd && endCap == 1);
      if (roundEnd) {
        vec2 latV = (tRaw < 0.0 ? a : b) - cq;
        latV -= segTan * dot(latV, segTan);
        float lat = length(latV);
        dIn = lat;
        gD = lat > 0.0 ? latV / lat : vec2(0.0);
      }
      float dOut = strokeDashDist(dIn, gD, segTan, halfW, dashId, hdr.w + tRaw * abLen, startCap, endCap,
                                  hdr.w, hdr.w + abLen, aaEm, sP, sQ);
      if (dOut == dIn && roundEnd) gD = gIn;
      else thisD = dOut;
      bodyG = gD; bodyHit = dot(gD, gD) > 0.5;
    }
    if (dSpill < thisD) { thisD = dSpill; sP = vec4(0.0); sQ = vec4(0.0); bodyG = vec2(0.0); bodyHit = false; joinRec = false; }

    if (sP.w == 1.0 && !joinRec && abs(sP.z - (thisD - halfW)) > (1.0 / 1024.0) * aaEm) { sP = vec4(0.0); sQ = vec4(0.0); }
    if (thisD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = thisD; gradOut = bodyHit ? bodyG : vec2(0.0); if (!framed) { edgeP = sP; edgeQ = sQ; winD = thisD; } }
    else { if (thisD < minD2) { if (sP.w == 1.0) { secN = sP.xy; secE = sP.z; } else secE = 1e20; } minD2 = min(minD2, thisD); }
    if (framed) {
      float key = seDocKey(sP, sQ, N, thisD > halfW ? thisD - halfW : (thisD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = sP; edgeQ = sQ; winD = thisD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = sP; edgeQ = sQ; return minD; }
  }
#endif
  hE += nLine;

#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;

    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1) - vec4(c, c);
    vec4 q3t = cFetchL(sL + 2);
    vec2 q3  = q3t.xy - c;
    if (framed) { p12 = vec4(strokeFrameMul(N, p12.xy), strokeFrameMul(N, p12.zw)); q3 = strokeFrameMul(N, q3); }
    if (uStrokeGates != 0 && strokeHullOutOfReach(min(min(p12.xy, p12.zw), q3),
                             max(max(p12.xy, p12.zw), q3), _reach)) continue;
    if (uStrokeGates != 0 && strokeQuadOutOfReach(p12.xy, p12.zw, q3, _reach)) continue;
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);

    vec4 jn = cFetchL(sL + 3);
    if (framed) jn = vec4(strokeFrameDir(N, jn.xy), strokeFrameDir(N, jn.zw));

    vec4 curv = (joinStyle == 4) ? cFetchL(sL + 4) : vec4(0.0);
    vec2 _segGrad = vec2(0.0); vec4 _sP, _sQ;
    float segD = strokeQuadAccum(p12, q3, freeStart, freeEnd,
                           startCap, endCap,
                           joinStyle, miterLimit, halfW,
                           jn.xy, jn.zw, dashId, hdr.w,
                           curv, 1e20, _segGrad, aaEm, _sP, _sQ);

    if (segD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = segD; gradOut = _segGrad; if (!framed) { edgeP = _sP; edgeQ = _sQ; winD = segD; } }
    else { if (segD < minD2) { if (_sP.w == 1.0) { secN = _sP.xy; secE = _sP.z; } else secE = 1e20; } minD2 = min(minD2, segD); }
    if (framed) {
      float key = seDocKey(_sP, _sQ, N, segD > halfW ? segD - halfW : (segD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = _sP; edgeQ = _sQ; winD = segD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = _sP; edgeQ = _sQ; return minD; }
  }
#endif
  hE += nQuad;

#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;

    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1) - vec4(c, c);
    vec4 p34 = cFetchL(sL + 2) - vec4(c, c);
    if (framed) {
      p12 = vec4(strokeFrameMul(N, p12.xy), strokeFrameMul(N, p12.zw));
      p34 = vec4(strokeFrameMul(N, p34.xy), strokeFrameMul(N, p34.zw));
    }
    if (uStrokeGates != 0 && strokeHullOutOfReach(min(min(p12.xy, p12.zw), min(p34.xy, p34.zw)),
                             max(max(p12.xy, p12.zw), max(p34.xy, p34.zw)), _reach)) continue;
    if (uStrokeGates != 0 && strokeCubicOutOfReach(p12, p34, _reach)) continue;
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    vec4 jn = cFetchL(sL + 3);
    if (framed) jn = vec4(strokeFrameDir(N, jn.xy), strokeFrameDir(N, jn.zw));
    vec4 curv = (joinStyle == 4) ? cFetchL(sL + 4) : vec4(0.0);
    vec2 _segGrad = vec2(0.0); vec4 _sP, _sQ;
    float segD = strokeCubicAccum(p12, p34, freeStart, freeEnd,
                                startCap, endCap,
                                joinStyle, miterLimit, halfW,
                                jn.xy, jn.zw, dashId, hdr.w,
                                curv, 1e20, _segGrad, aaEm, _sP, _sQ);

    if (segD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = segD; gradOut = _segGrad; if (!framed) { edgeP = _sP; edgeQ = _sQ; winD = segD; } }
    else { if (segD < minD2) { if (_sP.w == 1.0) { secN = _sP.xy; secE = _sP.z; } else secE = 1e20; } minD2 = min(minD2, segD); }
    if (framed) {
      float key = seDocKey(_sP, _sQ, N, segD > halfW ? segD - halfW : (segD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = _sP; edgeQ = _sQ; winD = segD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = _sP; edgeQ = _sQ; return minD; }
  }
#endif
  hE += nCubic;

#ifndef MANTLE_NO_ARC
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;
    int sL = int(segRaw.x);
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    vec4 d1 = cFetchL(sL + 1);
    vec4 d2 = cFetchL(sL + 2);
    vec4 jn = cFetchL(sL + 4);
    vec4 curv = (joinStyle == 4) ? cFetchL(sL + 5) : vec4(0.0);

    vec2 cq = c;
    if (framed) {
      d1 = vec4(d1.xy - c, d1.zw); strokeFrameArc(N, d1, d2); cq = vec2(0.0);
      jn = vec4(strokeFrameDir(N, jn.xy), strokeFrameDir(N, jn.zw));
    }

    vec2 pc = cq - d1.xy;
    float cphi = cos(d2.z), sphi = sin(d2.z);
    vec2 pR = vec2(pc.x*cphi + pc.y*sphi, -pc.x*sphi + pc.y*cphi);

    if (uStrokeGates != 0 && d1.z > 0.0 && d1.w > 0.0) {
      float nrm = length(pR / d1.zw);
      if (min(d1.z, d1.w) * abs(nrm - 1.0) > _reach * 1.0001 + 4e-6 * (length(pR) + max(d1.z, d1.w))) continue;
    }
    vec2 ep0 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.x);
    vec2 ep1 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.y);
    float dE = min(length(cq - ep0), length(cq - ep1));

    vec2 foot;
    bool inRange;
    float tAng;
    float dEdge = arcClosestFoot(d1.zw, pR, d2.x, d2.y, foot, tAng, inRange);
    if (inRange && dEdge > dE) inRange = false;
    float arcD = inRange ? min(dEdge, dE) : dE;

    vec2 _arcGrad = vec2(0.0);
    if (inRange && dEdge > 0.0) {
      vec2 gl2 = (pR - foot) / dEdge;
      _arcGrad = vec2(gl2.x * cphi - gl2.y * sphi, gl2.x * sphi + gl2.y * cphi);
    }

    float dth = d2.y - d2.x;
    vec2 dStart = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.x), arcDyDtheta(d1.z, d1.w, d2.z, d2.x)) * dth;
    vec2 dEnd   = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.y), arcDyDtheta(d1.z, d1.w, d2.z, d2.y)) * dth;
    if (d1.z == 0.0 || d1.w == 0.0) { dStart = ep1 - ep0; dEnd = dStart; }
    float tArc;
    if (inRange) {
      float dd = hlslFmod(tAng - d2.x, TWO_PI);
      if (dd < 0.0) dd += TWO_PI;
      if (dth < 0.0 && dd > 0.0) dd -= TWO_PI;
      tArc = clamp(dd / dth, 0.0, 1.0);
    } else {
      tArc = (length(cq - ep0) <= length(cq - ep1)) ? 0.0 : 1.0;
    }
    float arcLenAtT = (dashId > 0) ? arcArcLen(d1, d2, tArc) : 0.0;

    float thT = d2.x + tArc * dth;
    vec2 tanT = (dashId > 0) ? strokeUnit(vec2(arcDxDtheta(d1.z, d1.w, d2.z, thT), arcDyDtheta(d1.z, d1.w, d2.z, thT)) * dth)
                             : vec2(0.0);
    vec4 _sP, _sQ;
    vec2 _bodyG = _arcGrad;

    float tEnd = tArc;
    if (d1.z == 0.0 || d1.w == 0.0) {
      vec2 ch = ep1 - ep0;
      float c2 = dot(ch, ch);
      if (c2 > 0.0) tEnd = clamp(dot(cq - ep0, ch) / c2, 0.0, 1.0);
    }
    float segD = strokeCapsJoinsDash(tEnd, arcD, ep0 - cq, ep1 - cq, dStart, dEnd,
                               freeStart, freeEnd, startCap, endCap,
                               joinStyle, miterLimit, halfW, jn.xy, jn.zw,
                               dashId, hdr.w, arcLenAtT, curv, 1e20, _arcGrad, tanT,
                               (dashId > 0) ? hdr.w + arcArcLen(d1, d2, 1.0) : 1e30, aaEm, _sP, _sQ);

    if (d1.z != 0.0 && d1.w != 0.0) {
      for (int e = 0; e < 2; e++) {
        if ((e == 0 && tEnd < 1e-4) || (e == 1 && tEnd > 1.0 - 1e-4)) continue;
        if (tEnd >= 1e-4 && tEnd <= 1.0 - 1e-4 && !strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;
        vec2 pE = (e == 0 ? ep0 : ep1) - cq, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
        if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + aaEm) continue;
        if (joinStyle == 4 && !(e == 0 ? freeStart : freeEnd)) continue;
        vec2 gK = vec2(0.0);
        vec4 eP2, eQ2;
        float mdK = strokeCapsJoinsDash(float(e), length(pE), ep0 - cq, ep1 - cq, dStart, dEnd,
                                        freeStart, freeEnd, startCap, endCap,
                                        joinStyle, miterLimit, halfW, jn.xy, jn.zw,
                                        dashId, hdr.w, (dashId > 0 && e == 1) ? arcArcLen(d1, d2, 1.0) : 0.0, curv, 1e20, gK,
                                        strokeUnit(e == 0 ? dStart : dEnd),
                                        (dashId > 0) ? hdr.w + arcArcLen(d1, d2, 1.0) : 1e30, aaEm, eP2, eQ2);
        if (mdK < segD) { segD = mdK; _sP = eP2; _sQ = eQ2; _arcGrad = gK; }
      }
    }

    if (abs(d1.z - d1.w) <= (1.0 / 1048576.0) * d1.z) {
      float D = length(pc), delta = min(tArc, 1.0 - tArc) * abs(dth), R = 0.5 * (d1.z + d1.w);
      vec2 uc = D > 0.0 ? pc / D : vec2(1.0, 0.0);
      bool inside = D > aaEm && aaEm < D * sin(min(delta, 1.5707963));

      bool ends = dashId == 0 && freeStart && freeEnd && startCap != 2 && endCap != 2
        && ((startCap == 0 && endCap == 0) || (R >= halfW && TWO_PI - abs(dth) >= 2.0 * asin(halfW / R)));
      if (ends) {
        _sP = vec4(uc, segD - halfW, 5.0); _sQ = vec4(R, D, 0.0, 0.0);
        if (!inside) {

          vec2 ps = ep0 - d1.xy, pe = ep1 - d1.xy, pm = evalArc(0.0, 0.0, d1.z, d1.w, d2.z, 0.5 * (d2.x + d2.y));
          float as0 = curveAtan2(ps.y, ps.x), s1 = mod(curveAtan2(pe.y, pe.x) - as0, TWO_PI), sm = mod(curveAtan2(pm.y, pm.x) - as0, TWO_PI);
          bool fwd = sm < s1;
          int c0 = fwd ? startCap : endCap, c1 = fwd ? endCap : startCap;
          _sP = vec4(uc, segD - halfW, 5.0 + float(c0) + 2.0 * float(c1));
          _sQ = vec4(R, D, fwd ? as0 : as0 + s1, fwd ? s1 : TWO_PI - s1);
        }
      } else if (inside && (_sP.w == 1.0 || _sP.w == 9.0) && _sP.x == _bodyG.x && _sP.y == _bodyG.y && _sP.z == arcD - halfW) {
        _sP = vec4(uc, _sP.z, 5.0); _sQ = vec4(R, D, 0.0, 0.0);
      }
    }
    if (segD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = segD; gradOut = _arcGrad; if (!framed) { edgeP = _sP; edgeQ = _sQ; winD = segD; } }
    else { if (segD < minD2) { if (_sP.w == 1.0) { secN = _sP.xy; secE = _sP.z; } else secE = 1e20; } minD2 = min(minD2, segD); }
    if (framed) {
      float key = seDocKey(_sP, _sQ, N, segD > halfW ? segD - halfW : (segD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = _sP; edgeQ = _sQ; winD = segD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = _sP; edgeQ = _sQ; return minD; }
  }
#endif

  if (!framed && edgeP.w == 1.0 && secE < aaEm) { edgeQ = vec4(secN, secE, 0.0); edgeP = vec4(edgeP.xyz, 3.0); }
  float otherD = winD > minD ? minD : minD2;
  if (edgeP.w == 3.0 && !(otherD <= halfW + edgeQ.z + (1.0 / 256.0) * aaEm)) edgeP = vec4(edgeP.xyz, 1.0);
  return minD;
}

float strokeWalk(vec2 c, ivec4 GD, vec4 shapeBB, vec4 N, bool framed, inout float halfW,
                 int startCap, int endCap, int joinStyle, float miterLimit,
                 int dashId, out vec2 gradOut, float satD, float aaEm, vec2 ePx, bool saturate,
                 out vec4 edgeP, out vec4 edgeQ) {
  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  if (framed) {
    float kMax = length(vec2(0.5 * (N.x + N.w), 0.5 * (N.y - N.z))) + length(vec2(0.5 * (N.x - N.w), 0.5 * (N.y + N.z)));
    vec2 ePxS = ePx * kMax;
    satD = saturate ? max(halfW - 0.5 * length(ePxS), 0.0) : -1e20;
    aaEm = strokeAaReachEm(halfW, ePxS);
  } else N = vec4(0.0);
  vec2 g;
  float d = strokeBandAccum(gl, bandIdx.y * 2, c, halfW, startCap, endCap, joinStyle, miterLimit, dashId, 1e20, g,
                            satD, aaEm, N, framed, edgeP, edgeQ);
  if (!framed) { gradOut = g; return d; }
  float s;
  if (dot(g, g) > 0.5) { vec2 gd = strokeFrameMulT(N, g); s = length(gd); gradOut = gd / s; }
  else { s = sqrt(abs(N.x * N.w - N.y * N.z)); gradOut = vec2(0.0); }
  halfW = halfW / s;
  return d / s;
}

float strokeMinDist(vec2 c, ivec4 GD, vec4 shapeBB, float halfW,
                        int startCap, int endCap,
                        int joinStyle, float miterLimit,
                        int dashId, out vec2 gradOut, float satD, float aaEm,
                        out vec4 edgeP, out vec4 edgeQ) {
  return strokeWalk(c, GD, shapeBB, vec4(0.0), false, halfW, startCap, endCap, joinStyle, miterLimit, dashId, gradOut,
                    satD, aaEm, vec2(0.0), false, edgeP, edgeQ);
}

float strokeMinDistLocal(vec2 c, ivec4 GD, vec4 shapeBB, vec4 N, inout float halfW,
                         int startCap, int endCap, int joinStyle, float miterLimit,
                         int dashId, out vec2 gradOut, vec2 ePx, bool saturate,
                         out vec4 edgeP, out vec4 edgeQ) {
  return strokeWalk(c, GD, shapeBB, N, true, halfW, startCap, endCap, joinStyle, miterLimit, dashId, gradOut,
                    0.0, 0.0, ePx, saturate, edgeP, edgeQ);
}

uint calcRootCode2(float y1, float y2, float y3) {
  uint shift = (y1 < 0.0 ? 1u : 0u)
             | (y2 < 0.0 ? 2u : 0u)
             | (y3 < 0.0 ? 4u : 0u);
  return ((0x2E74u >> shift) & 0x0101u);
}

vec4 slugSolveHorizQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.y;
  float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  float q  = b.y + (b.y >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0) ? p12.y / q : tBig;
  float t1 = b.y >= 0.0 ? tSml : tBig;
  float t2 = b.y >= 0.0 ? tBig : tSml;
  return vec4((a.x * t1 - b.x * 2.0) * t1 + p12.x,
              (a.x * t2 - b.x * 2.0) * t2 + p12.x,
              t1, t2);
}

vec4 slugSolveVertQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.x;
  float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  float q  = b.x + (b.x >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0) ? p12.x / q : tBig;
  float t1 = b.x >= 0.0 ? tSml : tBig;
  float t2 = b.x >= 0.0 ? tBig : tSml;
  return vec4((a.y * t1 - b.y * 2.0) * t1 + p12.y,
              (a.y * t2 - b.y * 2.0) * t2 + p12.y,
              t1, t2);
}
void solveCubicBisect(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t, out vec3 up) {
  r = vec3(1e20); t = vec3(-1.0); up = vec3(0.0);
  vec4 cy = cubicCoeff(vert?p12.x:p12.y, vert?p12.z:p12.w, vert?p34.x:p34.y, vert?p34.z:p34.w);
  vec4 cx = cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);

  float qa = 3.0 * cy.x;
  float qb = 2.0 * cy.y;
  float qc = cy.z;
  float split1 = -1.0, split2 = -1.0;

  if (abs(qa) <= 1e-6 * max(abs(qb), abs(qc))) {
    if (abs(qb) > 1e-30) {
      float s = -qc / qb;
      if (s > 0.0 && s < 1.0) split1 = s;
    }
  } else {
    float disc = qb*qb - 4.0*qa*qc;
    if (disc >= 0.0) {
      float sd = sqrt(disc);
      float qq = -0.5 * (qb + (qb >= 0.0 ? sd : -sd));
      float s1 = qq / qa;
      float s2 = (abs(qq) > 1e-30) ? (qc / qq) : s1;
      if (s1 > s2) { float tmp = s1; s1 = s2; s2 = tmp; }
      if (s1 > 0.0 && s1 < 1.0) split1 = s1;
      if (s2 > 0.0 && s2 < 1.0) {
        if (split1 < 0.0) split1 = s2; else split2 = s2;
      }
    }
  }

  float yEnd0 = vert ? p12.x : p12.y, yEnd1 = vert ? p34.z : p34.w;

  float d0 = vert ? p12.z - p12.x : p12.w - p12.y, d1 = vert ? p34.x - p12.z : p34.y - p12.w, d2 = vert ? p34.z - p34.x : p34.w - p34.y;
  if (d0 == 0.0 || d2 == 0.0) {
    float tEnd = (d2 == 0.0) ? 1.0 : 0.0;
    float num = (d2 == 0.0) ? d0 : 2.0 * d1, den = (d2 == 0.0) ? d0 - 2.0 * d1 : 2.0 * d1 - d2;
    float s = (d0 == d2 || den == 0.0) ? -1.0 : num / den;
    float keep = -1.0;
    if (s > 0.0 && s < 1.0) {
      keep = s;
      if (split1 > 0.0 && abs(split1 - s) < abs(split1 - tEnd)) keep = split1;
      else if (split2 > 0.0 && abs(split2 - s) < abs(split2 - tEnd)) keep = split2;
    }
    split1 = keep;
    split2 = -1.0;
  }
  float b1 = (split1 > 0.0) ? split1 : 1.0, b2 = (split2 > 0.0) ? split2 : 1.0;
  float lo = 0.0, yLo = yEnd0;
  for (int i = 0; i < 3; i++) {
    if (lo >= 1.0) break;
    float hi = (i == 0) ? b1 : ((i == 1) ? b2 : 1.0);

    float yHi = (hi < 1.0) ? evalC(cy, hi) : yEnd1;
    bool sHi = yHi >= 0.0;
    bool sLo = yLo >= 0.0;
    if (sLo != sHi) {

      float sden = yHi - yLo;
      float xr = clamp(lo - yLo * (hi - lo) / sden, lo, hi);

      float bl = lo, bh = hi;
      bool onEnd = (yHi == 0.0 || yLo == 0.0);
      if (onEnd) xr = (yHi == 0.0) ? hi : lo;
      for (int k = 0; k < SLUG_NEWTON; k++) {
        if (onEnd) break;
        float fy = evalC(cy, xr);
        if (fy == 0.0) break;
        if ((fy >= 0.0) == sLo) bl = xr; else bh = xr;
        float fdy = evalCD(cy, xr);
        float xn = (fdy != 0.0) ? xr - fy / fdy : 0.5 * (bl + bh);
        xr = (xn >= bl && xn <= bh) ? xn : 0.5 * (bl + bh);
      }
      float rr = evalC(cx, xr), uu = sHi ? 1.0 : 0.0;
      if (i == 0) { t.x = xr; r.x = rr; up.x = uu; }
      else if (i == 1) { t.y = xr; r.y = rr; up.y = uu; }
      else { t.z = xr; r.z = rr; up.z = uu; }
    }
    lo = hi; yLo = yHi;
  }
}

float exactBoxCov(vec2 n, float d) {
  float a = max(abs(n.x), abs(n.y));
  float b = min(abs(n.x), abs(n.y));
  float s = 0.5 * (a + b);
  float t = 0.5 * (a - b);
  if (d <= -s) return 0.0;
  if (d >=  s) return 1.0;
  float ab = max(2.0 * a * b, 1e-12);
  if (d <= -t) return (d + s) * (d + s) / ab;
  if (d >=  t) return 1.0 - (s - d) * (s - d) / ab;
  return 0.5 + d / max(a, 1e-12);
}

float exactBoxCov2(vec2 n1, float d1, vec2 n2, float d2) {
  vec2 poly[8];
  poly[0] = vec2(-0.5, -0.5); poly[1] = vec2(0.5, -0.5);
  poly[2] = vec2(0.5, 0.5);   poly[3] = vec2(-0.5, 0.5);
  poly[4] = vec2(0.0); poly[5] = vec2(0.0); poly[6] = vec2(0.0); poly[7] = vec2(0.0);
  int cnt = 4;
  for (int pass = 0; pass < 2; pass++) {
    vec2 n = pass == 0 ? n1 : n2;
    float d = pass == 0 ? d1 : d2;
    vec2 tmp[8];
    int m = 0;
    for (int i = 0; i < 8; i++) {
      if (i >= cnt) break;
      vec2 a = poly[i];
      vec2 b = poly[(i + 1 == cnt) ? 0 : i + 1];
      float fa = dot(n, a) - d, fb = dot(n, b) - d;
      if (fa <= 0.0 && m < 8) { tmp[m] = a; m++; }
      if ((fa < 0.0) != (fb < 0.0) && m < 8) { tmp[m] = mix(a, b, fa / (fa - fb)); m++; }
    }
    for (int i = 0; i < 8; i++) poly[i] = i < m ? tmp[i] : vec2(0.0);
    cnt = m;
    if (cnt == 0) return 0.0;
  }
  float area = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= cnt) break;
    vec2 a = poly[i], b = poly[(i + 1 == cnt) ? 0 : i + 1];
    area += a.x * b.y - a.y * b.x;
  }
  return abs(area) * 0.5;
}

float exactBoxCov3(vec2 n1, float d1, vec2 n2, float d2, vec2 n3, float d3) {
  vec2 poly[8];
  poly[0] = vec2(-0.5, -0.5); poly[1] = vec2(0.5, -0.5);
  poly[2] = vec2(0.5, 0.5);   poly[3] = vec2(-0.5, 0.5);
  poly[4] = vec2(0.0); poly[5] = vec2(0.0); poly[6] = vec2(0.0); poly[7] = vec2(0.0);
  int cnt = 4;
  for (int pass = 0; pass < 3; pass++) {
    vec2 n = pass == 0 ? n1 : (pass == 1 ? n2 : n3);
    float d = pass == 0 ? d1 : (pass == 1 ? d2 : d3);
    vec2 tmp[8];
    int m = 0;
    for (int i = 0; i < 8; i++) {
      if (i >= cnt) break;
      vec2 a = poly[i];
      vec2 b = poly[(i + 1 == cnt) ? 0 : i + 1];
      float fa = dot(n, a) - d, fb = dot(n, b) - d;
      if (fa <= 0.0 && m < 8) { tmp[m] = a; m++; }
      if ((fa < 0.0) != (fb < 0.0) && m < 8) { tmp[m] = mix(a, b, fa / (fa - fb)); m++; }
    }
    for (int i = 0; i < 8; i++) poly[i] = i < m ? tmp[i] : vec2(0.0);
    cnt = m;
    if (cnt == 0) return 0.0;
  }
  float area = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= cnt) break;
    vec2 a = poly[i], b = poly[(i + 1 == cnt) ? 0 : i + 1];
    area += a.x * b.y - a.y * b.x;
  }
  return abs(area) * 0.5;
}

bool chainFillSide(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4) {
  float best = 1e30; bool side = true;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A; float L2 = dot(d, d); if (L2 < 1e-20) continue;
    float t = clamp(dot(-A, d) / L2, 0.0, 1.0);
    vec2 c = A + t * d; float dd = dot(c, c);
    if (dd < best) { best = dd; side = (d.y * A.x - d.x * A.y) >= 0.0; }
  }
  return side;
}

float chainMissCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4) {
  float best = 1e30; vec2 bA = vec2(0.0), bd2 = vec2(0.0); bool found = false;
  int bs = -1, firstS = 9, lastS = -1; float bt = 0.0;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A; float L2 = dot(d, d); if (L2 < 1e-20) continue;
    if (s < firstS) firstS = s;
    lastS = s;
    float tu = dot(-A, d) / L2;
    float t = clamp(tu, 0.0, 1.0);
    vec2 c = A + t * d; float dd = dot(c, c);
    if (dd < best) { best = dd; bA = A; bd2 = d; found = true; bs = s; bt = tu; }
  }

  if (!found || best > 2.0) return -1.0;

  if ((bt < 0.0 && bs == firstS) || (bt > 1.0 && bs == lastS)) return -1.0;
  vec2 nOut = normalize(vec2(bd2.y, -bd2.x));
  float c1 = exactBoxCov(nOut, dot(nOut, bA));

  bool atEnd = bt > 1.0, atStart = bt < 0.0;
  if (atEnd || atStart) {
    int s2 = atEnd ? bs + 1 : bs - 1;
    vec2 A2 = vec2(0.0), d2 = vec2(0.0);
    for (int k = 0; k < 4; k++) {
      if (s2 < 0 || s2 > 3) break;
      A2 = s2 == 0 ? p0 : (s2 == 1 ? p1 : (s2 == 2 ? p2 : p3));
      d2 = (s2 == 0 ? p1 : (s2 == 1 ? p2 : (s2 == 2 ? p3 : p4))) - A2;
      if (dot(d2, d2) >= 1e-20) break;
      s2 += atEnd ? 1 : -1;
    }
    if (s2 >= 0 && s2 <= 3 && dot(d2, d2) >= 1e-20) {
      vec2 n2 = normalize(vec2(d2.y, -d2.x));
      float c2 = exactBoxCov(n2, dot(n2, A2));
      float c12 = exactBoxCov2(nOut, dot(nOut, bA), n2, dot(n2, A2));
      vec2 dIn = atEnd ? bd2 : d2, dOut = atEnd ? d2 : bd2;
      float turn = dIn.x * dOut.y - dIn.y * dOut.x;
      if (turn > 0.0) return c12;
      if (turn < 0.0) return c1 + c2 - c12;
    }
  }
  return c1;
}

float chainBorderParam(vec2 p) {
  if (abs(p.y) >= abs(p.x)) return p.y < 0.0 ? clamp(p.x + 0.5, 0.0, 1.0) : 2.0 + clamp(0.5 - p.x, 0.0, 1.0);
  return p.x > 0.0 ? 1.0 + clamp(p.y + 0.5, 0.0, 1.0) : 3.0 + clamp(0.5 - p.y, 0.0, 1.0);
}

float chainBoxCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4, float forceInside) {

  {
    vec2 lo = min(min(min(p0, p1), min(p2, p3)), p4), hi = max(max(max(p0, p1), max(p2, p3)), p4);
    float m = forceInside > 1.5 ? 1.414215 : 0.500001;
    if (hi.x < -m || lo.x > m || hi.y < -m || lo.y > m) return (forceInside > 0.5) ? 1.0 : (chainFillSide(p0, p1, p2, p3, p4) ? 1.0 : 0.0);
  }
  vec2 poly[12];
  int n = 0;

  int entryMask = 0;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A;
    if (dot(d, d) < 1e-12) continue;
    vec2 lo = min(A, B), hi = max(A, B);
    if (hi.x < -0.500001 || lo.x > 0.500001 || hi.y < -0.500001 || lo.y > 0.500001) continue;
    float t0 = 0.0, t1 = 1.0; bool ok = true;
    for (int k = 0; k < 4; k++) {
      float P = k == 0 ? -d.x : (k == 1 ? d.x : (k == 2 ? -d.y : d.y));
      float Q = k == 0 ? A.x + 0.5 : (k == 1 ? 0.5 - A.x : (k == 2 ? A.y + 0.5 : 0.5 - A.y));
      if (abs(P) < 1e-12) { if (Q < 0.0) ok = false; }
      else { float r = Q / P;
        if (P < 0.0) { if (r > t1) ok = false; else if (r > t0) t0 = r; }
        else { if (r < t0) ok = false; else if (r < t1) t1 = r; } }
    }
    if (!ok || t1 < t0) continue;

    vec2 A2 = mix(A, B, t0), B2 = mix(A, B, t1);

    if (dot(B2 - A2, B2 - A2) < 1e-12) continue;
    bool join = n > 0 && dot(poly[n - 1] - A2, poly[n - 1] - A2) <= 1e-10;
    if (!join && n < 12) { poly[n] = A2; entryMask |= 1 << n; n++; }
    if (n < 12) { poly[n] = B2; n++; }
  }

  if (n < 2) {
    if (forceInside > 1.5) { float mc = chainMissCov(p0, p1, p2, p3, p4);
      return mc < 0.0 ? 1.0 : mc; }
    return (forceInside > 0.5 || chainFillSide(p0, p1, p2, p3, p4)) ? 1.0 : 0.0;
  }

  bool ring = dot(p4 - p0, p4 - p0) < 1e-12
              && dot(poly[0] - poly[n - 1], poly[0] - poly[n - 1]) <= 1e-10 && n > 2;
  if (ring) { n--; entryMask = entryMask & ~1; }

  if (!ring) {
    vec2 dEnd = poly[n - 1] - poly[n - 2];
    if (dot(dEnd, dEnd) > 1e-12 && n < 12) {
      vec2 dn = normalize(dEnd);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
      float t = min(tx, ty);
      if (t > 0.0) { poly[n] = poly[n - 1] + dn * t; n++; }
    }
    vec2 dBeg = poly[1] - poly[0];
    if (dot(dBeg, dBeg) > 1e-12 && n < 12) {
      vec2 dn = normalize(-dBeg);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
      float t = min(tx, ty);
      if (t > 0.0) {
        vec2 E2 = poly[0] + dn * t;
        for (int i = 11; i >= 1; i--) if (i <= n) poly[i] = poly[i - 1];

        entryMask = ((entryMask << 1) | 1) & ~2;
        poly[0] = E2; n++;
      }
    }
  }

  float area2 = 0.0, bsum = 0.0, minP = 8.0;
  bool minEntry = false, anyGap = false;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    int jn = (i + 1 == n) ? 0 : i + 1;
    vec2 a = poly[i], b = poly[jn];
    bool gap = (jn == 0 && !ring) || ((entryMask >> jn) & 1) != 0;
    if (!gap) { area2 += a.x * b.y - a.y * b.x; continue; }
    anyGap = true;
    float pa = chainBorderParam(a), pb = chainBorderParam(b);
    bsum += pb - pa;
    if (pa < minP) { minP = pa; minEntry = false; }
    if (pb < minP) { minP = pb; minEntry = true; }
  }
  if (!anyGap) return clamp(0.5 * area2 + (area2 < 0.0 ? 1.0 : 0.0), 0.0, 1.0);
  return clamp(0.5 * area2 + 0.25 * (bsum + (minEntry ? 4.0 : 0.0)), 0.0, 1.0);
}

float strokeEdgeCov(float minD, float halfW, vec2 grad, vec2 ePx, bool exactAa) {
  float pxSize = 0.5 * (ePx.x + ePx.y);
  float halfWMin = 0.5 * pxSize;
  float halfWVis = max(halfW, halfWMin);
  float weightFade = halfW / halfWVis;
  float distFromEdge = minD - halfWVis;
  float cov = 0.0;
  if (exactAa && dot(grad, grad) > 0.5 && distFromEdge <= 0.75 * pxSize) {
    vec2 nUn = grad * ePx;

    float il = inversesqrt(max(dot(nUn, nUn), 1e-30));
    cov = exactBoxCov(nUn * il, -distFromEdge * il) * weightFade;
  } else if (distFromEdge <= 0.5 * pxSize) {
    cov = clamp(0.5 - distFromEdge / max(pxSize, 1e-30), 0.0, 1.0) * weightFade;
  }
  return cov;
}

#if !defined(MANTLE_NO_STROKE) && defined(MANTLE_STROKE_EXACT)
vec3 sePx(vec2 n, float e, vec4 N, vec2 ePx) {
  vec2 nd = strokeFrameMulT(N, n) * ePx;
  float il = inversesqrt(max(dot(nd, nd), 1e-30));
  return vec3(nd * il, -e * il);
}

float seSector(vec2 A, vec2 B, float r2) {
  float y = A.x * B.y - A.y * B.x, x = dot(A, B);
  return (y == 0.0 && x >= 0.0) ? 0.0 : 0.5 * r2 * curveAtan2(y, x);
}

float seCircleTri(vec2 A, vec2 B, float r2) {
  vec2 D = B - A;
  float a = dot(D, D);
  if (a == 0.0) return 0.0;
  float b = dot(A, D), c = dot(A, A) - r2;
  float disc = b * b - a * c;
  if (disc <= 0.0) return seSector(A, B, r2);
  float s = sqrt(disc), t0 = (-b - s) / a, t1 = (-b + s) / a;
  vec2 P = t0 <= 0.0 ? A : (t0 >= 1.0 ? B : A + D * t0), Q = t1 >= 1.0 ? B : (t1 <= 0.0 ? A : A + D * t1);
  return seSector(A, P, r2) + 0.5 * (P.x * Q.y - P.y * Q.x) + seSector(Q, B, r2);
}

float seDiscQuadCut(vec2 C0, vec2 C1, vec2 C2, vec2 C3, float r2, vec2 u) {
  float area = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 A = i == 0 ? C0 : (i == 1 ? C1 : (i == 2 ? C2 : C3));
    vec2 B = i == 0 ? C1 : (i == 1 ? C2 : (i == 2 ? C3 : C0));
    float fa = dot(A, u), fb = dot(B, u);
    if (fa >= 0.0 && fb >= 0.0) area += seCircleTri(A, B, r2);
    else if (fa >= 0.0) area += seCircleTri(A, mix(A, B, fa / (fa - fb)), r2);
    else if (fb >= 0.0) area += seCircleTri(mix(A, B, fa / (fa - fb)), B, r2);
  }
  return abs(area);
}

bool seCirclePlaneSafe(float r, vec2 u, vec2 hx, vec2 hy, float reach) {
  return r > 4096.0 * reach || (r > 256.0 * reach
    && reach <= 2.0 * max(abs(dot(u, hx)), abs(dot(u, hy))));
}
float seCircleShare(vec2 f, vec2 u, float D, float r, vec2 hx, vec2 hy, float reach, float boxArea, vec4 N, vec2 ePx) {
  if (r <= 0.0 || D - reach >= r) return 0.0;
  if (D + reach <= r) return 1.0;
  if (seCirclePlaneSafe(r, u, hx, hy, reach)) { vec3 h = sePx(u, D - r, N, ePx); return exactBoxCov(h.xy, h.z); }
  return seDiscQuadCut(f - hx - hy, f + hx - hy, f + hx + hy, f - hx + hy, r * r, vec2(0.0)) / boxArea;
}

float seDiscQuadWedge(vec2 C0, vec2 C1, vec2 C2, vec2 C3, float r2, vec2 m0, vec2 m1) {
  float area = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 A = i == 0 ? C0 : (i == 1 ? C1 : (i == 2 ? C2 : C3));
    vec2 B = i == 0 ? C1 : (i == 1 ? C2 : (i == 2 ? C3 : C0));
    float lo = 0.0, hi = 1.0;
    for (int k = 0; k < 2; k++) {
      vec2 m = k == 0 ? m0 : m1;
      float fa = dot(A, m), fb = dot(B, m);
      if (fa < 0.0 && fb < 0.0) hi = -1.0;
      else if (fa < 0.0) lo = max(lo, fa / (fa - fb));
      else if (fb < 0.0) hi = min(hi, fa / (fa - fb));
    }
    if (lo < hi) area += seCircleTri(mix(A, B, lo), mix(A, B, hi), r2);
  }
  return abs(area);
}

float seSectorShare(vec2 f, vec2 u, float D, float r, vec2 r0, vec2 r1, float sw, vec2 hx, vec2 hy, float reach,
                    float boxArea, vec4 N, vec2 ePx) {
  if (r <= 0.0 || D - reach >= r) return 0.0;
  bool big = sw > 3.14159265;
  vec2 a = big ? r1 : r0, b = big ? r0 : r1;
  vec2 m0 = vec2(-a.y, a.x), m1 = vec2(b.y, -b.x);
  float part;
  if (seCirclePlaneSafe(r, u, hx, hy, reach)) {
    vec3 h = sePx(u, D - r, N, ePx), w0 = sePx(-m0, -dot(m0, f), N, ePx), w1 = sePx(-m1, -dot(m1, f), N, ePx);
    part = D + reach <= r ? exactBoxCov2(w0.xy, w0.z, w1.xy, w1.z) : exactBoxCov3(h.xy, h.z, w0.xy, w0.z, w1.xy, w1.z);
  } else {
    part = seDiscQuadWedge(f - hx - hy, f + hx - hy, f + hx + hy, f - hx + hy, r * r, m0, m1) / boxArea;
  }
  return big ? seCircleShare(f, u, D, r, hx, hy, reach, boxArea, N, ePx) - part : part;
}

float seCapShare(vec2 g, vec2 ub, float r, vec2 hx, vec2 hy, float reach, float boxArea, vec4 N, vec2 ePx) {
  float dg = length(g);
  if (dg - reach >= r || dot(g, ub) <= -reach) return 0.0;
  if (seCirclePlaneSafe(r, dg > 0.0 ? g / dg : ub, hx, hy, reach)) {
    vec3 hd = sePx(dg > 0.0 ? g / dg : ub, dg - r, N, ePx), hc = sePx(-ub, -dot(g, ub), N, ePx);
    return exactBoxCov2(hd.xy, hd.z, hc.xy, hc.z);
  }
  return seDiscQuadCut(g - hx - hy, g + hx - hy, g + hx + hy, g - hx + hy, r * r, ub) / boxArea;
}

float strokeExactCov(vec4 P, vec4 Q, float halfWS, vec4 N, vec2 ePx) {
  vec3 p1 = sePx(P.xy, P.z, N, ePx);
  if (P.w == 1.0) return exactBoxCov(p1.xy, p1.z);
  if (P.w == 4.0) {

    vec2 V = -P.xy * (P.z + halfWS), u = Q.xy, pn = vec2(-u.y, u.x);
    float sl = -dot(V, pn);
    vec3 hb = dot(u, u) > 0.5 ? sePx(u, Q.z, N, ePx) : vec3(0.0, 0.0, -1.0);
    vec3 h1 = sePx(pn, sl - halfWS, N, ePx), h2 = sePx(-pn, -sl - halfWS, N, ePx);
    float slab = 0.0;
    if (hb.z > -0.7072) {
      if (h2.z >= 0.7072 && hb.z >= 0.7072) slab = exactBoxCov(h1.xy, h1.z);
      else if (h1.z >= 0.7072 && hb.z >= 0.7072) slab = exactBoxCov(h2.xy, h2.z);
      else slab = exactBoxCov3(h1.xy, h1.z, h2.xy, h2.z, hb.xy, hb.z);
    }
    float cap = 0.0;
    if (hb.z < 0.7072) {

      vec2 hx = strokeFrameMul(N, vec2(0.5 * ePx.x, 0.0)), hy = strokeFrameMul(N, vec2(0.0, 0.5 * ePx.y));
      float rho = P.z + halfWS, reach = max(length(hx + hy), length(hx - hy));
      if (rho + reach <= halfWS) cap = 1.0 - exactBoxCov(hb.xy, hb.z);
      else if (rho - reach < halfWS) {

        if (seCirclePlaneSafe(halfWS, P.xy, hx, hy, reach)) cap = exactBoxCov2(p1.xy, p1.z, -hb.xy, -hb.z);
        else {
          vec2 f = -V;
          float boxArea = 4.0 * abs(hx.x * hy.y - hx.y * hy.x);
          cap = seDiscQuadCut(f - hx - hy, f + hx - hy, f + hx + hy, f - hx + hy, halfWS * halfWS, u) / boxArea;
        }
      }
    }
    return clamp(slab + cap, 0.0, 1.0);
  }
  if (P.w == 9.0) {

    vec3 pf = sePx(-P.xy, -P.z - 2.0 * halfWS, N, ePx);
    if (!(dot(Q.xy, Q.xy) > 0.5)) return exactBoxCov2(p1.xy, p1.z, pf.xy, pf.z);
    vec3 p2 = sePx(Q.xy, Q.z, N, ePx);
    return exactBoxCov3(p1.xy, p1.z, pf.xy, pf.z, p2.xy, p2.z);
  }
  if (P.w >= 5.0) {

    float R = Q.x, D = Q.y, sw = Q.w;
    vec2 u = P.xy, f = u * D;
    vec2 hx = strokeFrameMul(N, vec2(0.5 * ePx.x, 0.0)), hy = strokeFrameMul(N, vec2(0.0, 0.5 * ePx.y));
    float reach = max(length(hx + hy), length(hx - hy)), boxArea = 4.0 * abs(hx.x * hy.y - hx.y * hy.x);
    if (sw == 0.0)
      return clamp(seCircleShare(f, u, D, R + halfWS, hx, hy, reach, boxArea, N, ePx)
                 - seCircleShare(f, u, D, R - halfWS, hx, hy, reach, boxArea, N, ePx), 0.0, 1.0);
    vec2 r0 = vec2(cos(Q.z), sin(Q.z)), r1 = vec2(cos(Q.z + sw), sin(Q.z + sw));
    float cov = seSectorShare(f, u, D, R + halfWS, r0, r1, sw, hx, hy, reach, boxArea, N, ePx)
              - seSectorShare(f, u, D, R - halfWS, r0, r1, sw, hx, hy, reach, boxArea, N, ePx);

    int caps = int(P.w + 0.5) - 5;
    if ((caps & 1) != 0) cov += seCapShare(f - R * r0, vec2(r0.y, -r0.x), halfWS, hx, hy, reach, boxArea, N, ePx);
    if ((caps & 2) != 0) cov += seCapShare(f - R * r1, vec2(-r1.y, r1.x), halfWS, hx, hy, reach, boxArea, N, ePx);
    float ro = halfWS - R;
    if (ro > 0.0) {
      cov += seSectorShare(f, u, D, ro, -r0, -r1, sw, hx, hy, reach, boxArea, N, ePx);
      if (sw > 3.14159265)
        cov -= seSectorShare(f, u, D, ro, r0, -r1, sw - 3.14159265, hx, hy, reach, boxArea, N, ePx)
             + seSectorShare(f, u, D, ro, -r0, r1, sw - 3.14159265, hx, hy, reach, boxArea, N, ePx);
    }
    return clamp(cov, 0.0, 1.0);
  }
  vec3 p2 = sePx(Q.xy, Q.z, N, ePx);
  if (P.w == 2.0) {
    if (p2.z >= 0.7072) return exactBoxCov(p1.xy, p1.z);
    if (p1.z >= 0.7072) return exactBoxCov(p2.xy, p2.z);
    if (p1.z <= -0.7072 || p2.z <= -0.7072) return 0.0;
    return exactBoxCov2(p1.xy, p1.z, p2.xy, p2.z);
  }

  if (p2.z <= -0.7072) return exactBoxCov(p1.xy, p1.z);
  if (p1.z <= -0.7072) return exactBoxCov(p2.xy, p2.z);
  if (p1.z >= 0.7072 || p2.z >= 0.7072) return 1.0;
  return 1.0 - exactBoxCov2(-p1.xy, -p1.z, -p2.xy, -p2.z);
}

#endif

#if defined(MANTLE_GWN) || defined(MANTLE_HARD) || defined(MANTLE_HARD_MIXED)

#if defined(MANTLE_HARD_TREE) || defined(MANTLE_HARD_MIXED) || (defined(MANTLE_GWN) && !defined(MANTLE_GWN_SDF))
#define GWN_WINDING_ONLY 1
#endif

#if defined(MANTLE_GWN) && defined(MANTLE_GWN_SDF) && !defined(MANTLE_HARD) && !defined(MANTLE_HARD_MIXED) && !defined(MANTLE_HARD_TREE)
#define GWN_EXACT_AREA 1
#endif

float gwnChordT(vec2 a, vec2 b) { return a.x * (b.y - a.y) - a.y * (b.x - a.x); }

float gwnCross(vec2 a, vec2 b) {
  if ((a.y < 0.0) == (b.y < 0.0)) return 0.0;
  float dy = b.y - a.y;
  float t = gwnChordT(a, b);
  return dy < 0.0 ? (t < 0.0 ? -1.0 : 0.0) : (t > 0.0 ? 1.0 : 0.0);
}

#if defined(MANTLE_HARD_TREE) || (defined(MANTLE_GWN) && !defined(MANTLE_HARD) && !defined(MANTLE_HARD_MIXED))

const float GWN_TAU = 6.283185307179586;

float gwnChord(vec2 p, vec2 A, vec2 B) {
  vec2 a = A - p, b = B - p;
  return curveAtan2(a.x * b.y - a.y * b.x, dot(a, b)) / GWN_TAU;
}

struct GwnSdfCand {
  float dpx;

  float sFill;

  vec2 nf;
  vec2 tv;
  float endNear;
  vec2 V;
  float sg;
};

float gwnChordSide(vec2 a, vec2 b) {
  float t = gwnChordT(a, b);
  if (t != 0.0) return t < 0.0 ? 1.0 : -1.0;
  float dy = b.y - a.y;
  return (dy != 0.0 ? dy : b.x - a.x) > 0.0 ? 1.0 : -1.0;
}

float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);

#ifdef GWN_EXACT_AREA

vec2 aacPL(vec2 emPt, vec2 c, vec2 px);
float aacLineContrib(vec2 A, vec2 B, float q0, float q1);
float aacQuadContrib(vec2 P0, vec2 P1, vec2 P2, float q0, float q1);
float aacCubicContrib(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float q0, float q1);
#ifndef MANTLE_NO_ARC
float aacArcContrib(vec4 d1, vec4 d2, vec4 ends, vec2 c, vec2 px, float q0, float q1);
#endif
float aacFold(float run, bool evenOdd);

float gwnPieceArea(vec2 c, vec2 px, ivec2 sL, int type) {
  if (type == 0) {
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    return aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), 0.0, 1.0);
  }
  if (type == 1) {
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 p3 = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    return aacQuadContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p3, c, px), 0.0, 1.0);
  }
  if (type == 4 || type == 6) {
    vec4 a = texFetch(sL);
    vec4 b = texFetch(ivec2(sL.x + (type == 4 ? 5 : 1), sL.y));
    vec2 P0 = a.xy, P1 = type == 4 ? b.xy : a.zw, P2 = type == 4 ? b.zw : b.xy, P3 = type == 4 ? a.zw : b.zw;
    return aacCubicContrib(aacPL(P0, c, px), aacPL(P1, c, px), aacPL(P2, c, px), aacPL(P3, c, px), 0.0, 1.0);
  }
#ifndef MANTLE_NO_ARC
  if (type == 5) {
    return aacArcContrib(texFetch(ivec2(sL.x + 1, sL.y)), texFetch(ivec2(sL.x + 4, sL.y)), texFetch(sL), c, px, 0.0, 1.0);
  }
#endif
  return 0.0;
}
#endif

float gwnSegEval(vec2 c, vec2 px, ivec2 sL, int type, float sigma, out GwnSdfCand cand) {
  cand.dpx = 1e30; cand.sFill = 0.0; cand.nf = vec2(0.0);
  cand.tv = vec2(0.0); cand.endNear = 0.0; cand.V = vec2(0.0); cand.sg = sigma;
  if (type == 6) {

    vec4 p01 = texFetch(sL);
    vec4 p23 = texFetch(ivec2(sL.x + 1, sL.y));

    float t6ylo = min(min(p01.y, p01.w), min(p23.y, p23.w)), t6yhi = max(max(p01.y, p01.w), max(p23.y, p23.w));
    float t6xlo = min(min(p01.x, p01.z), min(p23.x, p23.z)), t6xhi = max(max(p01.x, p01.z), max(p23.x, p23.z));
    float wSeg = (c.y < t6ylo || c.y > t6yhi || c.x > t6xhi) ? 0.0
               : (c.x < t6xlo ? gwnCross(p01.xy - c, p23.zw - c) : hardCrossCubic(c, p01 - vec4(c, c), p23 - vec4(c, c)));
#ifdef GWN_WINDING_ONLY
    return wSeg;
#endif
    vec2 A = p01.xy, B = p23.zw, t = B - A;
    float L2 = dot(t, t);
    if (!(L2 > 0.0)) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);
    float f = dot(n, c - A);
    vec2 gPx = n / px;
    float gpx = length(gPx);
    if (!(gpx > 0.0)) return wSeg;
    float tproj = dot(c - A, t) / L2;
    cand.dpx = abs(f) / gpx;
    if (tproj < 0.0) cand.dpx = length((c - A) * px);
    else if (tproj > 1.0) cand.dpx = length((c - B) * px);
    cand.nf = sigma * gPx / gpx;
    cand.sFill = sigma * f / gpx;
    cand.tv = t * inversesqrt(L2);
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = A; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = B; }
    return wSeg;
  }
  if (type == 0) {
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 A = pe.xy, B = pe.zw, t = B - A;
    float wSeg = gwnCross(A - c, B - c);
#ifdef GWN_WINDING_ONLY
    return wSeg;
#endif
    float L2 = dot(t, t);
    if (!(L2 > 0.0)) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);
    float f = dot(n, c - A);
    vec2 gPx = n / px;
    float gpx = length(gPx);
    if (!(gpx > 0.0)) return wSeg;
    float dPlane = abs(f) / gpx;
    float tproj = dot(c - A, t) / L2;
    cand.dpx = dPlane;
    if (tproj < 0.0) cand.dpx = length((c - A) * px);
    else if (tproj > 1.0) cand.dpx = length((c - B) * px);

    cand.nf = sigma * gPx / gpx;
    cand.sFill = sigma * f / gpx;
    cand.tv = t * inversesqrt(L2);
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = A; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = B; }
    return wSeg;
  }
  if (type == 1) {
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 P0 = p12.xy, P1 = p12.zw, P2 = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    float wSeg = gwnCross(P0 - c, P2 - c);
    vec2 chord = P2 - P0;
    float cl2 = dot(chord, chord);
    float tproj = cl2 > 0.0 ? dot(c - P0, chord) / cl2 : 0.5;

    float d = (P1.y - P2.y) * (P0.x - P2.x) + (P2.x - P1.x) * (P0.y - P2.y);
    float l = 0.0, m = 0.0, n_ = 0.0, u = 0.0, v = 0.0;
    vec2 gL = vec2(0.0), gm = vec2(0.0), gn = vec2(0.0);
    bool haveBary = d != 0.0;
    if (haveBary) {
      gL = vec2(P1.y - P2.y, P2.x - P1.x) / d;
      gm = vec2(P2.y - P0.y, P0.x - P2.x) / d;
      l = dot(gL, c - P2); m = dot(gm, c - P2);
      n_ = 1.0 - l - m;
      gn = -gL - gm;
      u = m * 0.5 + n_; v = n_;

      float sideP = (P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x;
      if (l >= 0.0 && gwnChordSide(P0 - c, P2 - c) * sideP > 0.0 && n_ >= 0.0 && (u * u - v) < 0.0) {
        wSeg += sign(sideP);
      }
    }
    vec2 gEm; float f; float rank = -1.0;
    if (tproj < 0.0 || tproj > 1.0) {

      vec2 V  = tproj < 0.0 ? P0 : P2;
      vec2 tg = tproj < 0.0 ? P1 - P0 : P2 - P1;
      float tl2 = dot(tg, tg);
      if (!(tl2 > 0.0)) { tg = chord; tl2 = cl2; }
      if (!(tl2 > 0.0)) return wSeg;
      vec2 n = vec2(-tg.y, tg.x) * inversesqrt(tl2);
      f = dot(n, c - V);
      gEm = n;
      rank = length((c - V) * px);
    } else {
      if (!haveBary) return wSeg;
      vec2 gu = gm * 0.5 + gn, gv = gn;
      f = u * u - v;
      gEm = 2.0 * u * gu - gv;
    }
    vec2 gPx = gEm / px;
    float gpx = length(gPx);
    if (!(gpx > 0.0)) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;

    if (rank < 0.0 && cl2 > 0.0) {
      float cl9 = sqrt(cl2);
      float devS9 = ((c.x - P0.x) * chord.y - (c.y - P0.y) * chord.x) / cl9;
      float ctrlDev = abs((P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x) / cl9;
      float slabPx = (abs(devS9) - 0.5 * ctrlDev) / min(1.0 / px.x, 1.0 / px.y);
      cand.dpx = max(dPlane, slabPx);
    }

    vec2 tvq = vec2(gEm.y, -gEm.x);
    if (dot(tvq, chord) < 0.0) tvq = -tvq;
    cand.tv = normalize(tvq);
    float fillSgn = sigma * ((cand.tv.x * gEm.y - cand.tv.y * gEm.x) >= 0.0 ? 1.0 : -1.0);
    cand.nf = fillSgn * gPx / gpx;
    cand.sFill = fillSgn * f / gpx;
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = P0; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = P2; }
    return wSeg;
  }
  if (type == 4 || type == 5) {

    vec4 tEnds = texFetch(sL);
    vec2 E0 = tEnds.xy, E1 = tEnds.zw;
    float wSeg = gwnCross(E0 - c, E1 - c);
    vec2 chord = E1 - E0;
    float cl2 = dot(chord, chord);
    if (!(cl2 > 0.0)) return wSeg;
    float cl = sqrt(cl2);
    float tproj = dot(c - E0, chord) / cl2;
    float devS = ((c.x - E0.x) * chord.y - (c.y - E0.y) * chord.x) / cl;
    float f; vec2 gEm;
    float luneAdd, maxDev, fRegionSgn;
    vec2 tv0, tv1;
    if (type == 4) {
      vec4 tk = texFetch(ivec2(sL.x + 1, sL.y));
      vec4 tl = texFetch(ivec2(sL.x + 2, sL.y));
      vec4 tm = texFetch(ivec2(sL.x + 3, sL.y));
      vec4 tt = texFetch(ivec2(sL.x + 4, sL.y));
      vec4 tp = texFetch(ivec2(sL.x + 5, sL.y));
      float kk = tk.x * c.x + tk.y * c.y + tk.z;
      float ll = tl.x * c.x + tl.y * c.y + tl.z;
      float mm = tm.x * c.x + tm.y * c.y + tm.z;
      f = kk * kk * kk - ll * mm;
      gEm = 3.0 * kk * kk * tk.xy - ll * tm.xy - mm * tl.xy;
      luneAdd = tk.w; fRegionSgn = tl.w; maxDev = tm.w;
      tv0 = tt.xy; tv1 = tt.zw;

      if (luneAdd == 0.0) {
        vec4 tp = texFetch(ivec2(sL.x + 5, sL.y));
        vec2 Q1 = tp.xy, Q2 = tp.zw;
        float ylo = min(min(E0.y, Q1.y), min(Q2.y, E1.y));
        float yhi = max(max(E0.y, Q1.y), max(Q2.y, E1.y));
        float xhi = max(max(E0.x, Q1.x), max(Q2.x, E1.x));
        wSeg = (c.y >= ylo && c.y <= yhi && c.x <= xhi)
             ? hardCrossCubic(c, vec4(E0, Q1) - vec4(c, c), vec4(Q2, E1) - vec4(c, c))
             : 0.0;
      }
    } else {
      vec4 tc = texFetch(ivec2(sL.x + 1, sL.y));
      vec4 tr = texFetch(ivec2(sL.x + 2, sL.y));
      vec4 tt = texFetch(ivec2(sL.x + 3, sL.y));

      if (min(tc.z, tc.w) <= 1e-4 * max(tc.z, tc.w)) {
        vec2 nrm = vec2(-chord.y, chord.x) / cl;
        f = dot(nrm, c - E0);
        gEm = nrm;
        luneAdd = 0.0; fRegionSgn = 0.0; maxDev = 0.0;
        tv0 = chord / cl; tv1 = chord / cl;
      } else {
        vec2 rel = c - tc.xy;
        vec2 q = vec2(tr.x * rel.x + tr.y * rel.y, -tr.y * rel.x + tr.x * rel.y);
        vec2 qq = q / tc.zw;
        f = dot(qq, qq) - 1.0;
        vec2 gq = 2.0 * qq / tc.zw;
        gEm = vec2(tr.x * gq.x - tr.y * gq.y, tr.y * gq.x + tr.x * gq.y);
        luneAdd = tr.z; fRegionSgn = -1.0; maxDev = tr.w;
        tv0 = tt.xy; tv1 = tt.zw;
      }
    }

    if (tproj > 0.0 && tproj < 1.0 && gwnChordSide(E0 - c, E1 - c) * luneAdd > 0.0 && abs(devS) <= maxDev
        && f * fRegionSgn > 0.0) wSeg += luneAdd;
    float rank = -1.0;
    if (tproj < 0.0 || tproj > 1.0) {
      vec2 V  = tproj < 0.0 ? E0 : E1;
      vec2 tg = tproj < 0.0 ? tv0 : tv1;
      vec2 n = vec2(-tg.y, tg.x);
      f = dot(n, c - V);
      gEm = n;
      rank = length((c - V) * px);
    }
    vec2 gPx = gEm / px;
    float gpx = length(gPx);
    if (!(gpx > 0.0)) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;

    float slabPx = (abs(devS) - maxDev) / min(1.0 / px.x, 1.0 / px.y);
    if (rank < 0.0) cand.dpx = max(dPlane, slabPx);
    vec2 tvq = vec2(gEm.y, -gEm.x);
    if (dot(tvq, chord) < 0.0) tvq = -tvq;
    cand.tv = normalize(tvq);
    float fillSgn = sigma * ((cand.tv.x * gEm.y - cand.tv.y * gEm.x) >= 0.0 ? 1.0 : -1.0);
    cand.nf = fillSgn * gPx / gpx;
    cand.sFill = fillSgn * f / gpx;
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = E0; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = E1; }
    return wSeg;
  }
  return 0.0;
}

float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);

vec2 gwnBoxSize(vec4 bb) { return bandBoxSize(bb); }

#ifdef GWN_EXACT_AREA

float gwnFillOf(float w, bool evenOdd) {
  float aw = abs(w);
  return evenOdd ? ((mod(aw, 2.0) >= 0.5 && mod(aw, 2.0) < 1.5) ? 1.0 : 0.0) : step(0.5, aw);
}

float gwnLocalSide(GwnSdfCand c, float w, bool evenOdd, float inside) {
  bool left = c.sFill * (c.sg == 0.0 ? 1.0 : sign(c.sg)) >= 0.0;
  if (gwnFillOf(left ? w - 1.0 : w + 1.0, evenOdd) == inside) return 0.0;
  return left == (inside > 0.5) ? 1.0 : -1.0;
}

float gwnModelCov(GwnSdfCand c1, GwnSdfCand c2, float w, bool evenOdd, float inside, vec2 px, out bool holds) {
  holds = true;
  if (c1.dpx > 0.70710678) return inside;
  float loc = c1.endNear == 0.0 ? gwnLocalSide(c1, w, evenOdd, inside) : 9.0;
#ifdef GWN_DIAG_SINGLE
  bool single = true;
#else
  bool single = c2.dpx > 0.70710678;
#endif
  float cA = exactBoxCov(-c1.nf, c1.sFill);
  if (single) {
    if (loc == 0.0 && c1.sg == 0.0) return inside;
    holds = loc == sign(c1.sg) && c1.sg != 0.0 && (c1.sFill >= 0.0) == (inside > 0.5);
    return cA;
  }

  holds = abs(c1.sg) == 1.0 && abs(c2.sg) == 1.0 && (loc == 9.0 || loc == c1.sg);

  bool reflex = false;
  bool corner = c1.endNear != 0.0 && c2.endNear != 0.0 && c1.endNear != c2.endNear;
  if (corner) {
    vec2 dV = (c1.V - c2.V) * px;
    corner = dot(dV, dV) < 0.01;
    if (corner) {
      vec2 tIn = c1.endNear > 0.0 ? c1.tv : c2.tv;
      vec2 tOut = c1.endNear > 0.0 ? c2.tv : c1.tv;
      float turn = tIn.x * tOut.y - tIn.y * tOut.x;
      reflex = turn * (c1.endNear > 0.0 ? c1.sg : c2.sg) < 0.0;
    }
  }

  if (!corner) { holds = holds && (c1.sFill >= 0.0) == (inside > 0.5) && (c2.sFill >= 0.0) == (inside > 0.5) && c1.endNear == 0.0; return cA; }

  bool bothIn = (c1.sFill >= 0.0) && (c2.sFill >= 0.0);
  bool anyIn  = (c1.sFill >= 0.0) || (c2.sFill >= 0.0);
  if (anyIn != bothIn) reflex = inside > 0.5;
  if (anyIn == bothIn && bothIn != (inside > 0.5)) holds = false;
  if (c1.sg != c2.sg) holds = false;
  float inter = exactBoxCov2(-c1.nf, c1.sFill, -c2.nf, c2.sFill);

  return reflex ? (cA + exactBoxCov(-c2.nf, c2.sFill) - inter) : inter;
}
#endif
float renderFillGWNSDF(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1, bandsX = GD.z + 1;
  vec4 hdr = bFetch(bLoc(gl, (bandsY + bandsX) * 2));
  int nodeBase = int(hdr.x), nodeCount = int(abs(hdr.y)), refBase = int(hdr.z);
  if (nodeCount <= 0) return 0.0;

  vec2 emPerPx = 1.0 / px;
  float cellR = 0.70710678 * max(emPerPx.x, emPerPx.y);
#ifdef GWN_WINDING_ONLY

  cellR = 0.0;
#endif
  vec4 ext = bFetch(bLoc(gl, refBase + int(hdr.w)));

  int gridBase = int(ext.z);
  if (gridBase > 0) {
    int gwh = int(ext.w);
    int GW = gwh >> 8, GH = gwh & 255;
    vec2 bbSz = gwnBoxSize(shapeBB);
    vec2 g = (c - shapeBB.xy) / bbSz * vec2(float(GW), float(GH));
    int gx = int(floor(g.x)), gy = int(floor(g.y));
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) {
      int ci = gy * GW + gx;
      vec4 cell = bFetch(bLoc(gl, gridBase + (ci >> 1)));
      vec2 wm = (ci & 1) == 0 ? cell.xy : cell.zw;
      if (wm.y > cellR) {
        float awg = abs(wm.x);
        if (!evenOdd) return step(0.5, awg);
        float mg = mod(awg, 2.0);
        return (mg >= 0.5 && mg < 1.5) ? 1.0 : 0.0;
      }
    }
  }

  float w = 0.0;
#ifdef GWN_EXACT_AREA

  vec2 hb = 0.5 * emPerPx;
  bool subPx = false;
  float run = 0.0;
#endif
  GwnSdfCand c1, c2;
  c1.dpx = 1e30; c1.sFill = 0.0; c1.nf = vec2(0.0); c1.tv = vec2(0.0); c1.endNear = 0.0; c1.V = vec2(0.0); c1.sg = 0.0;
  c2 = c1;

  int GB = 0, byP = 0, nbB = -1, rbBase = 0;
  GB = int(ext.y); rbBase = int(ext.x);
  if (GB > 0) {
    float bandH = gwnBoxSize(shapeBB).y / float(GB);
    if (bandH <= 2.0 * cellR) { GB = 0; }
    else {
      byP = clamp(int((c.y - shapeBB.y) / bandH), 0, GB - 1);
      float yloc = c.y - shapeBB.y - float(byP) * bandH;
      if (yloc < cellR && byP > 0) nbB = byP - 1;
      else if (bandH - yloc < cellR && byP < GB - 1) nbB = byP + 1;
    }
  }

#ifdef GWN_EXACT_AREA
  for (int ph = 0; ph < 2; ph++) {
  if (ph == 1 && !subPx) break;
#endif
  for (int pass = 0; pass < 2; pass++) {
    int eBase = 0, eCount = 1;
    if (GB > 0) {
      int bandIdx = pass == 0 ? byP : nbB;
      vec4 bh = bFetch(bLoc(gl, rbBase + (bandIdx >> 1)));
      vec2 bc = (bandIdx & 1) == 0 ? bh.xy : bh.zw;
      eBase = int(bc.x); eCount = int(bc.y);
    }
    for (int ei = 0; ei < 4096; ei++) {
      if (ei >= eCount) break;
      int rootI = 0;
      if (GB > 0) {
        vec4 E = bFetch(bLoc(gl, eBase + ei));
        if (E.y < c.x - cellR) break;
        if (c.y < E.z - cellR || c.y > E.w + cellR) continue;
        int ex = int(E.x);
        rootI = ex >> 2;
        int fl = ex & 3;
        if (pass == 1 && ((nbB < byP && (fl & 1) == 1) || (nbB > byP && fl >= 2)))
          continue;
      }

      int ni = rootI, sEnd = rootI + 1;
      for (int guard = 0; guard < 4096; guard++) {
        if (ni >= sEnd) break;
        int base = nodeBase + ni * 2;
        vec4 A = bFetch(bLoc(gl, base));
        vec4 B = bFetch(bLoc(gl, base + 1));
        vec2 dcv = c - B.xy;
        float rr = B.z + cellR;

        if (dot(dcv, dcv) > rr * rr) {
#ifdef GWN_EXACT_AREA
          if (ph == 1) {
            if (abs(dcv.y) <= B.z + hb.y && B.x + B.z > c.x - hb.x) run += aacLineContrib(aacPL(A.xy, c, px), aacPL(A.zw, c, px), 0.0, 1.0);
          } else
#endif
          if (abs(dcv.y) <= B.z && B.x + B.z > c.x) w += gwnCross(A.xy - c, A.zw - c);
          ni = B.w >= 0.0 ? int(B.w) : ni + 1;
          continue;
        }
#ifdef GWN_EXACT_AREA
        if (abs(dcv.x) + B.z <= hb.x && abs(dcv.y) + B.z <= hb.y) subPx = true;
#endif
        if (B.w < 0.0) {

          int v = int(-B.w) - 1;
          int rc = v & 63, rs = v >> 6;
          for (int k = 0; k < 32; k++) {
            if (k >= rc) break;
            vec4 R = bFetch(bLoc(gl, refBase + rs + k));
#ifdef GWN_EXACT_AREA
            if (ph == 1) { run += gwnPieceArea(c, px, ivec2(int(R.x), int(R.y)), int(R.z + 0.5) & 15); continue; }
#endif
            GwnSdfCand cd;

            float sgP = R.w;

            int rz = int(R.z + 0.5), pty = rz & 15;
            w += gwnSegEval(c, px, ivec2(int(R.x), int(R.y)), pty, sgP == 0.0 ? 1.0 : sign(sgP), cd);
            cd.sg = sgP;

            { int smb = rz >> 4; if ((cd.endNear < 0.0 && (smb == 1 || smb == 3)) || (cd.endNear > 0.0 && smb >= 2)) cd.endNear = 0.0; }
#if defined(GWN_DIAG_FLIP_T0) || defined(GWN_DIAG_FLIP_T1) || defined(GWN_DIAG_FLIP_T4) || defined(GWN_DIAG_FLIP_T6)

            {
              int dt = pty;
              bool flip = false;
#ifdef GWN_DIAG_FLIP_T0
              flip = flip || dt == 0;
#endif
#ifdef GWN_DIAG_FLIP_T1
              flip = flip || dt == 1;
#endif
#ifdef GWN_DIAG_FLIP_T4
              flip = flip || dt == 4;
#endif
#ifdef GWN_DIAG_FLIP_T6
              flip = flip || dt == 6;
#endif
              if (flip) { cd.nf = -cd.nf; cd.sFill = -cd.sFill; }
            }
#endif
#ifndef GWN_WINDING_ONLY

            if (cd.dpx < c1.dpx) { c2 = c1; c1 = cd; }
            else if (cd.dpx < c2.dpx) { c2 = cd; }
#endif
          }
          ni++;
          continue;
        }
        if (ni == rootI) sEnd = int(B.w);
        ni++;
      }
      if (GB <= 0) break;
    }
    if (GB <= 0 || nbB < 0) break;
  }
#ifdef GWN_EXACT_AREA
  if (ph == 1) break;

  float inside = gwnFillOf(w, evenOdd);
  bool holds;
  float cov = gwnModelCov(c1, c2, w, evenOdd, inside, px, holds);
  if (!subPx && holds) return cov;
  subPx = true;
  }
  return aacFold(run, evenOdd);
#else

  float aw = abs(w);
  return evenOdd ? ((mod(aw, 2.0) >= 0.5 && mod(aw, 2.0) < 1.5) ? 1.0 : 0.0) : step(0.5, aw);
#endif
}

#endif

float hardCrossLine(vec2 c, vec2 A, vec2 B) {

  return gwnCross(A - c, B - c);
}

float hardCrossQuad(vec2 c, vec2 P0, vec2 P1, vec2 P2) {

  vec4 p12 = vec4(P0 - c, P1 - c);
  vec2 p3 = P2 - c;
  uint code = calcRootCode2(p12.y, p12.w, p3.y);
  if (code == 0u) return 0.0;

  if (min(min(p12.x, p12.z), p3.x) > 0.0) return ((code > 1u) ? 1.0 : 0.0) - (((code & 1u) != 0u) ? 1.0 : 0.0);
  vec4 rt = slugSolveHorizQuad(p12, p3);
  float w = 0.0;
  if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x && rt.x > 0.0) w -= 1.0;
  if (code > 1u && !isinf(rt.y) && rt.y == rt.y && rt.y > 0.0) w += 1.0;
  return w;
}

float hardCrossCubic(vec2 c, vec4 p12, vec4 p34) {
  vec3 rs, ts, up;
  solveCubicBisect(p12, p34, false, rs, ts, up);
  float w = 0.0;
  for (int j = 0; j < 3; j++) {
    if (ts[j] < 0.0 || rs[j] != rs[j]) continue;
    if (rs[j] <= 0.0) continue;
    w += (up[j] > 0.5) ? 1.0 : -1.0;
  }
  return w;
}

float hardCrossArc(vec2 c, vec4 d1, vec4 d2, vec4 ends) {
  float sp = sin(d2.z), cp = cos(d2.z);
  vec3 sw = arcSweep(d2);

  vec2 pLo, pHi;
  arcEndsLoHi(ends, sw.z, pLo, pHi);

  if (d1.x - (abs(cp * d1.z) + abs(sp * d1.w)) - c.x > 4.0 * arcRayUlpV(d1)) {
    float nnLo = (pLo.y - c.y >= 0.0) ? 1.0 : 0.0, nnHi = (pHi.y - c.y >= 0.0) ? 1.0 : 0.0;
    return sw.z * (nnHi - nnLo);
  }
  vec4 pcU; vec3 axU;
  vec3 cr = arcRayCrossings(sw.x, sw.y, sw.z, sp * d1.z, cp * d1.w, -(d1.y - c.y),
                            pLo.y - c.y, pHi.y - c.y, false, pcU, axU);

  vec3 thc = (cr.x + cr.y + cr.z > 0.0) ? arcRayRoots(sw.x, sw.y, sp * d1.z, cp * d1.w, -(d1.y - c.y), pcU, axU) : vec3(sw.x);
  float w = 0.0;
  for (int j = 0; j < 3; j++) {
    if (cr[j] == 0.0) continue;
    vec2 pnt; float ddx, ddy; arcSample(d1, cp, sp, thc[j], pnt, ddx, ddy);
    if (pnt.x <= c.x) continue;
    w += (cr[j] > 1.5) ? -1.0 : 1.0;
  }
  return w;
}

float renderFillHardBand(vec2 c, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);
  int by = clamp(int((c.y - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int hdr = texLin(gl) + by * 2;
  vec4 cnts = bFetchL(hdr);
  int nLine = int(cnts.x), nQuad = int(cnts.y);
  vec4 hdr1 = bFetchL(hdr + 1);
  int hE = texLin(gl) + int(hdr1.x);

  bool rej = fillRayReject(hdr1);
  float w = 0.0;

#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    vec4 pe = cFetchL(sL + 1);
    w += hardCrossLine(c, pe.xy, pe.zw);
  }
#endif
  hE += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec2 p3 = cFetchL(sL + 2).xy;
    w += hardCrossQuad(c, p12.xy, p12.zw, p3);
  }
#endif
  hE += nQuad;
#ifndef MANTLE_NO_CUBIC
  int nCubic = int(cnts.z);
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1) - vec4(c, c);
    vec4 p34 = cFetchL(sL + 2) - vec4(c, c);

    if (min(min(p12.y, p12.w), min(p34.y, p34.w)) >= 0.0 || max(max(p12.y, p12.w), max(p34.y, p34.w)) < 0.0) continue;
    if (min(min(p12.x, p12.z), min(p34.x, p34.z)) > 0.0) {
      w += ((p34.w >= 0.0) ? 1.0 : 0.0) - ((p12.y >= 0.0) ? 1.0 : 0.0);
      continue;
    }
    w += hardCrossCubic(c, p12, p34);
  }
  hE += nCubic;
#else
  hE += int(cnts.z);
#endif
#ifndef MANTLE_NO_ARC
  int nArc = int(cnts.w);
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    w += hardCrossArc(c, cFetchL(sL + 1), cFetchL(sL + 2), cFetchL(sL + 3));
  }
#endif
  float aw = abs(w);
  if (!evenOdd) return step(0.5, aw);
  float m = mod(aw, 2.0);
  return (m >= 0.5 && m < 1.5) ? 1.0 : 0.0;
}

#endif

vec2 aacPL(vec2 emPt, vec2 c, vec2 px) { return (emPt - c) * px + 0.5; }

vec4 aacQuadCoeff(float p1, float p2, float p3) {
  return vec4(0.0, (p1 - p2) + (p3 - p2), 2.0 * (p2 - p1), p1);
}

vec4 aacCubicCoeff(float p1, float p2, float p3, float p4) {
  return vec4((p4 - p1) + 3.0 * (p2 - p3),
              3.0 * ((p1 - p2) + (p3 - p2)),
              3.0 * (p2 - p1),
              p1);
}

vec2 aacQuadRoots(float qa, float qb, float qc) {
  float disc = qb * qb - 4.0 * qa * qc;
  if (disc <= 0.0) return vec2(1e9);
  float sq = sqrt(disc);
  float q  = -0.5 * (qb + (qb < 0.0 ? -sq : sq));
  float r1 = (abs(qa) > 1e-30) ? q / qa : 1e9;
  float r2 = (abs(q)  > 1e-30) ? qc / q  : 1e9;
  return vec2(min(r1, r2), max(r1, r2));
}

#define AAC_EPS (1.0 / 65536.0)

#define AAC_ROOT_TOL (1.0 / 1048576.0)
#define AAC_ROOT_NEWTON 8
#define AAC_ROOT_STEPS 40

float aacQuadRoot(float qa, float qb, float qc, float lo, float hi) {
  if (abs(qa) < AAC_EPS) return clamp(abs(qb) > AAC_EPS ? -qc / qb : lo, lo, hi);
  float sq = sqrt(max(qb * qb - 4.0 * qa * qc, 0.0));
  float q  = -0.5 * (qb + (qb < 0.0 ? -sq : sq));
  float r1 = q / qa, r2 = abs(q) > AAC_EPS ? qc / q : r1;
  return clamp((r1 >= lo - 1e-4 && r1 <= hi + 1e-4) ? r1 : r2, lo, hi);
}

float aacSolveC(vec4 C, float ta, float tb, float V) {
  float lo = min(ta, tb), hi = max(ta, tb);
  if (abs(C.x) < 1e-12) return aacQuadRoot(C.y, C.z, C.w - V, lo, hi);
#ifdef MANTLE_NO_CUBIC
  return 0.5 * (lo + hi);
#else
  float a = lo, b = hi;
  float fa = evalC(C, a) - V, fb = evalC(C, b) - V;
  float tol = max(AAC_ROOT_TOL, (1.0 / 16777216.0) * (abs(C.x) + abs(C.y) + abs(C.z) + abs(C.w) + abs(V)));
  if (abs(fa) <= tol) return a;
  if (abs(fb) <= tol) return b;
  if ((fa < 0.0) == (fb < 0.0)) return (abs(fa) <= abs(fb)) ? a : b;
  float t = (a * fb - b * fa) / (fb - fa);
  if (!(t > a && t < b)) t = 0.5 * (a + b);
  for (int k = 0; k < AAC_ROOT_STEPS; k++) {
    float ft = evalC(C, t) - V;
    if (abs(ft) <= tol) return t;
    if ((ft < 0.0) == (fa < 0.0)) a = t; else b = t;
    float m = 0.5 * (a + b);
    if (!(m > a && m < b)) break;
    float tn = t - ft / evalCD(C, t);
    t = (k < AAC_ROOT_NEWTON && tn > a && tn < b) ? tn : m;
  }
  return 0.5 * (a + b);
#endif
}

float aacZoneInt(vec4 CX, vec4 CY, float a, float b) {
  float h = b - a, m = 0.5 * (a + b), d = 0.3872983346207417 * h;
  float t0 = m - d, t2 = m + d;
  float e2 = 3.0 * CY.x, e1 = 2.0 * CY.y;
  float i0 = evalC(CX, t0) * ((e2 * t0 + e1) * t0 + CY.z);
  float i1 = evalC(CX, m) * ((e2 * m + e1) * m + CY.z);
  float i2 = evalC(CX, t2) * ((e2 * t2 + e1) * t2 + CY.z);
  return h * ((5.0 / 18.0) * (i0 + i2) + (8.0 / 18.0) * i1);
}

float aacClampI(float w0, float w1) {
  float d = w0 - w1;

  if (abs(d) <= 1e-5 * (1.0 + abs(w0) + abs(w1))) return clamp(0.5 * (w0 + w1), 0.0, 1.0);
  float a0 = max(w0, 0.0),       a1 = max(w1, 0.0);
  float b0 = max(w0 - 1.0, 0.0), b1 = max(w1 - 1.0, 0.0);

  return ((a0 - a1) * (a0 + a1) - (b0 - b1) * (b0 + b1)) / (2.0 * d);
}

float aacRightD(float y0, float y1, float q0, float q1) {
  return -(clamp(y1, q0, q1) - clamp(y0, q0, q1));
}

float aacLineContrib(vec2 A, vec2 B, float q0, float q1) {
  float dy = B.y - A.y;
  if (abs(dy) < 1e-9) return 0.0;
  float lo = max(q0, min(A.y, B.y)), hi = min(q1, max(A.y, B.y));
  if (hi <= lo) return 0.0;
  if (min(A.x, B.x) >= 1.0) return aacRightD(A.y, B.y, q0, q1);

  float dxdy = (B.x - A.x) / dy;
  float wlo = A.x + dxdy * (lo - A.y);
  float whi = A.x + dxdy * (hi - A.y);
  float sgn = (dy > 0.0) ? 1.0 : -1.0;
  return -sgn * (hi - lo) * aacClampI(wlo, whi);
}

float aacQuadPiece(vec2 A, vec2 B, vec2 P0, float ta, float tb, vec2 pa, vec2 pb, float q0, float q1) {
  if (!(tb > ta) || max(pa.y, pb.y) <= q0 || min(pa.y, pb.y) >= q1 || max(pa.x, pb.x) <= 0.0) return 0.0;
  float ya = clamp(pa.y, q0, q1), yb = clamp(pb.y, q0, q1);
  if (min(pa.x, pb.x) >= 1.0) return ya - yb;
  float u0 = (pa.y == ya) ? ta : aacQuadRoot(A.y, B.y, P0.y - ya, ta, tb);
  float u1 = (pb.y == yb) ? tb : aacQuadRoot(A.y, B.y, P0.y - yb, ta, tb);
  float x0 = (u0 == ta) ? pa.x : (A.x * u0 + B.x) * u0 + P0.x;
  float x1 = (u1 == tb) ? pb.x : (A.x * u1 + B.x) * u1 + P0.x;
  if (max(x0, x1) <= 0.0) return 0.0;
  if (min(x0, x1) >= 1.0) return ya - yb;

  bool inOut = x0 < 0.0 || x0 > 1.0, outOut = x1 < 0.0 || x1 > 1.0;
  float t0 = inOut ? aacQuadRoot(A.x, B.x, P0.x - (x0 < 0.0 ? 0.0 : 1.0), u0, u1) : u0;
  float t1 = outOut ? aacQuadRoot(A.x, B.x, P0.x - (x1 < 0.0 ? 0.0 : 1.0), u0, u1) : u1;
  float y0 = inOut ? (A.y * t0 + B.y) * t0 + P0.y : ya;
  float y1 = outOut ? (A.y * t1 + B.y) * t1 + P0.y : yb;
  float far = ((x0 > 1.0) ? y0 - ya : 0.0) + ((x1 > 1.0) ? yb - y1 : 0.0);

  float h = t1 - t0, m = 0.5 * (t0 + t1), d = 0.28867513459481287 * h, g0 = m - d, g1 = m + d;
  float zone = 0.5 * h * (((A.x * g0 + B.x) * g0 + P0.x) * (2.0 * A.y * g0 + B.y)
                        + ((A.x * g1 + B.x) * g1 + P0.x) * (2.0 * A.y * g1 + B.y));
  return -(zone + far);
}
float aacQuadContrib(vec2 P0, vec2 P1, vec2 P2, float q0, float q1) {
  if (max(P0.y, max(P1.y, P2.y)) <= q0 ||
      min(P0.y, min(P1.y, P2.y)) >= q1) return 0.0;
  if (min(P0.x, min(P1.x, P2.x)) >= 1.0) return aacRightD(P0.y, P2.y, q0, q1);
  vec2 d0 = P0 - P1, d1 = P2 - P1;
  vec2 A = d0 + d1, B = -2.0 * d0;

  float ty = (d0.y * d1.y > 0.0) ? d0.y / A.y : 1.0, tx = (d0.x * d1.x > 0.0) ? d0.x / A.x : 1.0;
  float s0 = min(tx, ty), s1 = max(tx, ty);

  float run = 0.0, ta = 0.0;
  vec2 pa = P0;
  for (int k = 0; k < 3; k++) {
    float tb = (k == 0) ? s0 : ((k == 1) ? s1 : 1.0);
    vec2 pb = (tb < 1.0) ? (A * tb + B) * tb + P0 : P2;
    run += aacQuadPiece(A, B, P0, ta, tb, pa, pb, q0, q1);
    ta = tb; pa = pb;
  }
  return run;
}

vec4 aacSort4(vec4 v) {
  vec2 a = vec2(min(v.x, v.y), max(v.x, v.y)), b = vec2(min(v.z, v.w), max(v.z, v.w));
  float lo = min(a.x, b.x), hi = max(a.y, b.y), m0 = max(a.x, b.x), m1 = min(a.y, b.y);
  return vec4(lo, min(m0, m1), max(m0, m1), hi);
}
float aacSplitT(float t) { return (t > 1e-6 && t < 1.0 - 1e-6) ? t : 1.0; }

float aacCubicPiece(vec4 CX, vec4 CY, float ta, float tb, vec2 pa, vec2 pb, float q0, float q1) {
  if (!(tb > ta) || max(pa.y, pb.y) <= q0 || min(pa.y, pb.y) >= q1 || max(pa.x, pb.x) <= 0.0) return 0.0;
  float ya = clamp(pa.y, q0, q1), yb = clamp(pb.y, q0, q1);
  if (min(pa.x, pb.x) >= 1.0) return ya - yb;
  float u0 = (pa.y == ya) ? ta : aacSolveC(CY, ta, tb, ya);
  float u1 = (pb.y == yb) ? tb : aacSolveC(CY, ta, tb, yb);
  float x0 = (u0 == ta) ? pa.x : evalC(CX, u0), x1 = (u1 == tb) ? pb.x : evalC(CX, u1);
  if (max(x0, x1) <= 0.0) return 0.0;
  if (min(x0, x1) >= 1.0) return ya - yb;
  bool inOut = x0 < 0.0 || x0 > 1.0, outOut = x1 < 0.0 || x1 > 1.0;
  float t0 = inOut ? aacSolveC(CX, u0, u1, x0 < 0.0 ? 0.0 : 1.0) : u0;
  float t1 = outOut ? aacSolveC(CX, u0, u1, x1 < 0.0 ? 0.0 : 1.0) : u1;
  float y0 = inOut ? evalC(CY, t0) : ya, y1 = outOut ? evalC(CY, t1) : yb;
  float far = ((x0 > 1.0) ? y0 - ya : 0.0) + ((x1 > 1.0) ? yb - y1 : 0.0);
  return -(aacZoneInt(CX, CY, t0, t1) + far);
}
float aacCubicContrib(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float q0, float q1) {
  if (max(max(P0.y, P1.y), max(P2.y, P3.y)) <= q0 ||
      min(min(P0.y, P1.y), min(P2.y, P3.y)) >= q1) return 0.0;
  if (min(min(P0.x, P1.x), min(P2.x, P3.x)) >= 1.0) return aacRightD(P0.y, P3.y, q0, q1);
  vec4 CX = aacCubicCoeff(P0.x, P1.x, P2.x, P3.x), CY = aacCubicCoeff(P0.y, P1.y, P2.y, P3.y);
#ifdef MANTLE_NO_CUBIC_SPLITS
  return aacCubicPiece(CX, CY, 0.0, 1.0, P0, P3, q0, q1);
#else
  vec2 ex = aacQuadRoots(3.0 * CX.x, 2.0 * CX.y, CX.z), ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);
  vec4 s = aacSort4(vec4(aacSplitT(ex.x), aacSplitT(ex.y), aacSplitT(ey.x), aacSplitT(ey.y)));

  float run = 0.0, ta = 0.0;
  vec2 pa = P0;
  for (int k = 0; k < 5; k++) {
    float tb = (k < 4) ? s[k] : 1.0;
    vec2 pb = (tb < 1.0) ? vec2(evalC(CX, tb), evalC(CY, tb)) : P3;
    run += aacCubicPiece(CX, CY, ta, tb, pa, pb, q0, q1);
    ta = tb; pa = pb;
  }
  return run;
#endif
}

#ifndef MANTLE_NO_ARC

float aacTrigEval(vec3 P, float th) { return P.x + P.y * cos(th) + P.z * sin(th); }
float aacTrigEvalR(float C, float R, float phi, float th) { return C + R * cos(th - phi); }

vec2 aacPhaseExtrema(float phi, float lo, float hi) {
  float PI_ = TWO_PI * 0.5;
  float t0 = phi + (floor((lo - phi) / PI_) + 1.0) * PI_;
  float t1 = t0 + PI_;
  float e0 = (t0 > lo + 1e-7 && t0 < hi - 1e-7) ? t0 : 1e9;
  float e1 = (t1 > lo + 1e-7 && t1 < hi - 1e-7) ? t1 : 1e9;
  return vec2(min(e0, e1), max(e0, e1));
}

float aacTrigDF(vec3 X, vec3 Y, float a, float b) {
  float h = 0.5 * (b - a), m = 0.5 * (a + b), h2 = h * h;
  float sh = (abs(h) < 0.25) ? h * (1.0 - h2 * (1.0 / 6.0) * (1.0 - h2 * 0.05)) : sin(h);
  float ch = cos(h), sm = sin(m), cm = cos(m);
  float K1 = X.z * Y.z - X.y * Y.y, K2 = X.y * Y.z - X.z * Y.y, K3 = X.y * Y.z + X.z * Y.y;
  return 2.0 * sh * X.x * (Y.z * cm - Y.y * sm)
       + K2 * h
       + sh * ch * (2.0 * K1 * sm * cm + K3 * (cm * cm - sm * sm));
}

float aacTrigSolve(float C, float R, float phi, float V, float a, float b) {
  float r = clamp((V - C) / max(R, 1e-9), -1.0, 1.0);
  float ac = acos(r);
  float lo = min(a, b), hi = max(a, b);
  float th0 = phi + ac, th1 = phi - ac;
  th0 += ceil((lo - th0) / TWO_PI) * TWO_PI;
  th1 += ceil((lo - th1) / TWO_PI) * TWO_PI;
  if (th0 <= hi + 1e-4) return clamp(th0, lo, hi);
  if (th1 <= hi + 1e-4) return clamp(th1, lo, hi);

  float d0 = min(th0 - hi, lo + TWO_PI - th0), d1 = min(th1 - hi, lo + TWO_PI - th1);
  float th = (d0 <= d1) ? th0 : th1;
  return (th - hi <= lo + TWO_PI - th) ? hi : lo;
}

float aacArcZoneI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                   float q0, float q1) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xm = aacTrigEvalR(X.x, RX, pX, 0.5 * (a + b));
  if (xm <= 0.0) return 0.0;

  if (xm >= 1.0) return clamp(yb, q0, q1) - clamp(ya, q0, q1);
  return aacTrigDF(X, Y, a, b);
}

float aacArcXMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                    float q0, float q1) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xa = aacTrigEvalR(X.x, RX, pX, a), xb = aacTrigEvalR(X.x, RX, pX, b);
  float xlo = min(xa, xb), xhi = max(xa, xb);
  if (xhi <= 0.0) return 0.0;
  if (xlo >= 1.0) return clamp(yb, q0, q1) - clamp(ya, q0, q1);
  if (xlo >= 0.0 && xhi <= 1.0) return aacTrigDF(X, Y, a, b);
  bool h0 = (xlo < 0.0 && xhi > 0.0);
  bool h1 = (xlo < 1.0 && xhi > 1.0);
  float t0 = h0 ? aacTrigSolve(X.x, RX, pX, 0.0, a, b) : a;
  float t1 = h1 ? aacTrigSolve(X.x, RX, pX, 1.0, a, b) : a;
  bool fwd = b > a;

  float acc = 0.0, prev = a, yPrev = ya;
  if (h0 && h1) {
    float m0 = fwd ? min(t0, t1) : max(t0, t1);
    float m1 = fwd ? max(t0, t1) : min(t0, t1);
    float y0 = aacTrigEvalR(Y.x, RY, pY, m0), y1 = aacTrigEvalR(Y.x, RY, pY, m1);
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m0, yPrev, y0, q0, q1); prev = m0; yPrev = y0;
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m1, yPrev, y1, q0, q1); prev = m1; yPrev = y1;
  } else if (h0 || h1) {
    float m = h0 ? t0 : t1, ym = aacTrigEvalR(Y.x, RY, pY, m);
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m, yPrev, ym, q0, q1); prev = m; yPrev = ym;
  }
  return acc + aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, b, yPrev, yb, q0, q1);
}

float aacArcMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                   float q0, float q1) {
  vec2 ex = aacPhaseExtrema(pX, min(a, b), max(a, b));
  float g0 = ex.x, g1 = ex.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = b > a;

  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : b);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : b;
  float ym0 = (n >= 1) ? aacTrigEvalR(Y.x, RY, pY, m0) : yb, ym1 = (n == 2) ? aacTrigEvalR(Y.x, RY, pY, m1) : yb;
  float acc = 0.0, prev = a, yPrev = ya;
  for (int k = 0; k < 3; k++) {
    float nx = (k == 0) ? m0 : ((k == 1) ? m1 : b);
    float yNx = (k == 0) ? ym0 : ((k == 1) ? ym1 : yb);
    acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, nx, yPrev, yNx, q0, q1);
    prev = nx; yPrev = yNx;
  }
  return acc;
}

float aacArcMonoContrib(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                        float q0, float q1) {
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;

  bool loIn = (inc ? ya : yb) >= q0, hiIn = (inc ? yb : ya) <= q1;
  float tq0 = loIn ? (inc ? a : b) : aacTrigSolve(Y.x, RY, pY, q0, a, b);
  float tq1 = hiIn ? (inc ? b : a) : aacTrigSolve(Y.x, RY, pY, q1, a, b);

  float yq0 = loIn ? (inc ? ya : yb) : q0, yq1 = hiIn ? (inc ? yb : ya) : q1;
  float uA = inc ? tq0 : tq1, uB = inc ? tq1 : tq0;

  if (abs(uB - uA) < 1e-12) return -clamp(aacTrigEvalR(X.x, RX, pX, uA), 0.0, 1.0) * (inc ? yq1 - yq0 : yq0 - yq1);
  return -aacArcMonoI2(X, Y, RX, pX, RY, pY, uA, uB, inc ? yq0 : yq1, inc ? yq1 : yq0, q0, q1);
}

float aacArcContribXY(vec3 X, vec3 Y, float th0, float th1, vec2 yE, float q0, float q1);
float aacArcContrib(vec4 d1, vec4 d2, vec4 ends, vec2 c, vec2 px, float q0, float q1) {
  float dth = d2.y - d2.x;
  if (abs(dth) < 1e-9) return 0.0;
  float sp = sin(d2.z), cp = cos(d2.z);
  vec3 X = vec3((d1.x - c.x) * px.x + 0.5,  px.x * cp * d1.z, -px.x * sp * d1.w);
  vec3 Y = vec3((d1.y - c.y) * px.y + 0.5,  px.y * sp * d1.z,  px.y * cp * d1.w);

  vec2 yE = (vec2(ends.y, ends.w) - c.y) * px.y + 0.5;
  return aacArcContribXY(X, Y, d2.x, d2.y, yE, q0, q1);
}

float aacArcContribXY(vec3 X, vec3 Y, float th0, float th1, vec2 yE, float q0, float q1) {
  float dth = th1 - th0;

  float Ry = abs(Y.y) + abs(Y.z);
  if (Y.x + Ry <= q0 || Y.x - Ry >= q1) return 0.0;

  float Rx = abs(X.y) + abs(X.z);
  if (X.x + Rx <= 0.0) return 0.0;
  if (X.x - Rx >= 1.0)
    return aacRightD(yE.x, yE.y, q0, q1);

  float RX = sqrt(X.y * X.y + X.z * X.z), pX = curveAtan2(X.z, X.y);
  float RY = sqrt(Y.y * Y.y + Y.z * Y.z), pY = curveAtan2(Y.z, Y.y);

  vec2 ey = aacPhaseExtrema(pY, min(th0, th1), max(th0, th1));
  float g0 = ey.x, g1 = ey.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;

  float yTh0 = yE.x, yTh1 = yE.y;
  float yG0 = (n >= 1) ? aacTrigEvalR(Y.x, RY, pY, g0) : yTh1, yG1 = (n >= 2) ? aacTrigEvalR(Y.x, RY, pY, g1) : yTh1;
  {
    float ymin = min(yTh0, yTh1), ymax = max(yTh0, yTh1);
    if (n >= 1) { ymin = min(ymin, yG0); ymax = max(ymax, yG0); }
    if (n >= 2) { ymin = min(ymin, yG1); ymax = max(ymax, yG1); }
    if (ymax <= q0 || ymin >= q1) return 0.0;
  }

  bool fwd = dth > 0.0;

  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : th1);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : th1;
  float ym0 = (n == 2) ? (fwd ? yG0 : yG1) : ((n == 1) ? yG0 : yTh1);
  float ym1 = (n == 2) ? (fwd ? yG1 : yG0) : yTh1;
  float run = 0.0, prev = th0, yPrev = yTh0;
  for (int k = 0; k < 3; k++) {
    float nx = (k == 0) ? m0 : ((k == 1) ? m1 : th1);
    float yNx = (k == 0) ? ym0 : ((k == 1) ? ym1 : yTh1);
    run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, nx, yPrev, yNx, q0, q1);
    prev = nx; yPrev = yNx;
  }
  return run;
}

#endif

float aacFold(float run, bool evenOdd) {
  if (!evenOdd) return min(abs(run), 1.0);
  float m = run - 2.0 * floor(run * 0.5);
  float cc = m <= 1.0 ? m : 2.0 - m;
  return clamp(cc, 0.0, 1.0);
}

const float AAC_LANE_SLACK = 9.5367431640625e-7;
bool aacLaneMiss(vec4 e, float cy, float py, float q0, float q1) {
  float a = (e.z - cy) * py + 0.5, b = (e.w - cy) * py + 0.5;
  return max(a, b) < q0 - AAC_LANE_SLACK || min(a, b) > q1 + AAC_LANE_SLACK;
}

float aacWalkBand(ivec2 gl, int bandY, vec2 c, vec2 px, float xBreak, float q0, float q1) {
  int hdr = texLin(gl) + bandY * 2;
  vec4 cnts = bFetchL(hdr);
  int nLine = int(cnts.x), nQuad = int(cnts.y), nCubic = int(cnts.z), nArc = int(cnts.w);
  vec4 hdr1 = bFetchL(hdr + 1);
  int hE = texLin(gl) + int(hdr1.x);

  bool rej = fillRayReject(hdr1);
  float run = 0.0;

#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 pe = cFetchL(sL + 1);
    run += aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), q0, q1);
  }
#endif
  hE += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec2 p3  = cFetchL(sL + 2).xy;
    run += aacQuadContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p3, c, px), q0, q1);
  }
#endif
  hE += nQuad;
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec4 p34 = cFetchL(sL + 2);
    run += aacCubicContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p34.xy, c, px), aacPL(p34.zw, c, px), q0, q1);
  }
#endif
  hE += nCubic;
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 d1 = cFetchL(sL + 1);
    vec4 d2 = cFetchL(sL + 2);
    run += aacArcContrib(d1, d2, cFetchL(sL + 3), c, px, q0, q1);
  }
#endif
  return run;
}

float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);

  float hy = 0.5 / abs(px.y);
  float bandH = bbSize.y / float(bandsY);
  float xBreak = c.x * px.x - 0.5;
  float yA = c.y - hy, yB = c.y + hy;
  int b0 = clamp(int((yA - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int b1 = clamp(int((yB - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);

#ifdef MANTLE_AAC_PAIR_BANDS
  bool pairCovers = (b1 <= b0 + 1);
  const int bandStride = 2;
#else
  bool pairCovers = (b0 == b1);
  const int bandStride = 1;
#endif
  float run = 0.0;

  int bandSteps = (b1 - b0) / bandStride + 1;
  int bandFirst = b0;

  bool levelWalk = false;
  if (!pairCovers && bandSteps > 2) {
    vec4 lv = bFetch(bLoc(gl, 1));
    int lTop = int(lv.z);
    int l = max(int(lv.w), 1), first = int(lv.y) / 2;
    for (int k = l; k < lTop && (b1 >> l) > (b0 >> l) + 1; k++) {
      first += (bandsY + (1 << l) - 1) >> l;
      l++;
    }
    if (lTop > 0 && (b1 >> l) <= (b0 >> l) + 1) {
      levelWalk = true;
      bandFirst = first + (b0 >> l);
      bandSteps = 1;
    }
  }
  for (int bi = 0; bi < bandSteps; bi++) {
    int bandY = bandFirst + bi * bandStride;
    float q0 = 0.0, q1 = 1.0;
    if (!pairCovers && !levelWalk) {

      float e0 = (max(yA, shapeBB.y + float(bandY)     * bandH) - c.y) * px.y + 0.5;
      float e1 = (min(yB, shapeBB.y + float(bandY + bandStride) * bandH) - c.y) * px.y + 0.5;
      q0 = clamp(min(e0, e1), 0.0, 1.0);
      q1 = clamp(max(e0, e1), 0.0, 1.0);
      if (q1 - q0 < 1e-9) continue;
    }
    run += aacWalkBand(gl, bandY, c, px, xBreak, q0, q1);
  }
  return aacFold(run, evenOdd);
}

#ifdef MANTLE_ROTATED_MAP

vec2 aacPLM(vec2 emPt, vec2 c, vec2 mx, vec2 my) { vec2 d = emPt - c; return mx * d.x + my * d.y + 0.5; }

float aacWallLine(vec2 A, vec2 B, float alpha, float beta, float q0, float q1) {
  float dy = B.y - A.y;
  if (dy == 0.0) return 0.0;
  float lo = max(q0, min(A.y, B.y)), hi = min(q1, max(A.y, B.y));
  if (hi <= lo) return 0.0;
  float dxdy = (B.x - A.x) / dy;
  float ulo = A.x + dxdy * (lo - A.y) - beta * lo - alpha;
  float uhi = A.x + dxdy * (hi - A.y) - beta * hi - alpha;
  float len = (ulo > 0.0 && uhi > 0.0) ? hi - lo
            : (ulo <= 0.0 && uhi <= 0.0) ? 0.0
            : ((ulo > 0.0) ? (hi - lo) * ulo / (ulo - uhi) : (hi - lo) * uhi / (uhi - ulo));
  return (dy > 0.0) ? len : -len;
}

float aacWallPiece(vec4 CY, vec4 CU, float a, float b, float ya, float yb) {
  if (b - a < 1e-12) return 0.0;
  float ua = evalC(CU, a), ub = evalC(CU, b);
  if (ua > 0.0 && ub > 0.0) return yb - ya;
  if (ua <= 0.0 && ub <= 0.0) return 0.0;
  float ys = evalC(CY, aacSolveC(CU, a, b, 0.0));
  return (ua > 0.0) ? ys - ya : yb - ys;
}

float aacWallMono(vec4 CY, vec4 CU, float ta, float tb, float ya, float yb, float q0, float q1) {
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  float yLoEnd = inc ? ya : yb, yHiEnd = inc ? yb : ya;
  bool loIn = yLoEnd >= q0, hiIn = yHiEnd <= q1;
  float tLo = loIn ? (inc ? ta : tb) : aacSolveC(CY, ta, tb, q0);
  float tHi = hiIn ? (inc ? tb : ta) : aacSolveC(CY, ta, tb, q1);
  float yLo = loIn ? yLoEnd : q0, yHi = hiIn ? yHiEnd : q1;
  bool lo0 = tLo <= tHi;
  float u0 = lo0 ? tLo : tHi, u1 = lo0 ? tHi : tLo, y0 = lo0 ? yLo : yHi, y1 = lo0 ? yHi : yLo;
  if (u1 - u0 < 1e-12) return evalC(CU, u0) > 0.0 ? y1 - y0 : 0.0;
  vec2 ex = aacQuadRoots(3.0 * CU.x, 2.0 * CU.y, CU.z);
  float s0 = (ex.x > u0 + 1e-7 && ex.x < u1 - 1e-7) ? ex.x : u1, s1 = (ex.y > u0 + 1e-7 && ex.y < u1 - 1e-7) ? ex.y : u1;
  float m0 = min(s0, s1), m1 = max(s0, s1);
  float ym0 = (m0 < u1) ? evalC(CY, m0) : y1, ym1 = (m1 < u1) ? evalC(CY, m1) : y1;
  return aacWallPiece(CY, CU, u0, m0, y0, ym0) + aacWallPiece(CY, CU, m0, m1, ym0, ym1) + aacWallPiece(CY, CU, m1, u1, ym1, y1);
}
float aacWallCurve(vec4 CX, vec4 CY, float yEnd1, float alpha, float beta, float q0, float q1) {
  vec4 CU = CX - beta * CY - vec4(0.0, 0.0, 0.0, alpha);
  vec2 ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);
  float s0 = (ey.x > 1e-6 && ey.x < 1.0 - 1e-6) ? ey.x : 2.0;
  float s1 = (ey.y > 1e-6 && ey.y < 1.0 - 1e-6) ? ey.y : 2.0;
  float e0 = (s0 < 1.5) ? s0 : ((s1 < 1.5) ? s1 : 1.0);
  float e1 = (s0 < 1.5 && s1 < 1.5) ? s1 : 1.0;
  float ye0 = (e0 < 1.0) ? evalC(CY, e0) : yEnd1, ye1 = (e1 < 1.0) ? evalC(CY, e1) : yEnd1;
  return aacWallMono(CY, CU, 0.0, e0, CY.w, ye0, q0, q1) + aacWallMono(CY, CU, e0, e1, ye0, ye1, q0, q1)
       + aacWallMono(CY, CU, e1, 1.0, ye1, yEnd1, q0, q1);
}
float aacWallQuad(vec2 P0, vec2 P1, vec2 P2, float alpha, float beta, float q0, float q1) {
  if (max(P0.y, max(P1.y, P2.y)) <= q0 || min(P0.y, min(P1.y, P2.y)) >= q1) return 0.0;
  float u0 = P0.x - beta * P0.y - alpha, u1 = P1.x - beta * P1.y - alpha, u2 = P2.x - beta * P2.y - alpha;
  if (max(u0, max(u1, u2)) <= 0.0) return 0.0;
  if (min(u0, min(u1, u2)) > 0.0) return clamp(P2.y, q0, q1) - clamp(P0.y, q0, q1);
  return aacWallCurve(aacQuadCoeff(P0.x, P1.x, P2.x), aacQuadCoeff(P0.y, P1.y, P2.y), P2.y, alpha, beta, q0, q1);
}
float aacWallCubic(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float alpha, float beta, float q0, float q1) {
  if (max(max(P0.y, P1.y), max(P2.y, P3.y)) <= q0 || min(min(P0.y, P1.y), min(P2.y, P3.y)) >= q1) return 0.0;
  float u0 = P0.x - beta * P0.y - alpha, u1 = P1.x - beta * P1.y - alpha;
  float u2 = P2.x - beta * P2.y - alpha, u3 = P3.x - beta * P3.y - alpha;
  if (max(max(u0, u1), max(u2, u3)) <= 0.0) return 0.0;
  if (min(min(u0, u1), min(u2, u3)) > 0.0) return clamp(P3.y, q0, q1) - clamp(P0.y, q0, q1);
  return aacWallCurve(aacCubicCoeff(P0.x, P1.x, P2.x, P3.x), aacCubicCoeff(P0.y, P1.y, P2.y, P3.y), P3.y, alpha, beta, q0, q1);
}
#ifndef MANTLE_NO_ARC

float aacWallArcPiece(float UC, float RU, float pU, float YC, float RY, float pY, float a, float b, float ya, float yb) {
  if (abs(b - a) < 1e-12) return 0.0;
  float ua = aacTrigEvalR(UC, RU, pU, a), ub = aacTrigEvalR(UC, RU, pU, b);
  if (ua > 0.0 && ub > 0.0) return yb - ya;
  if (ua <= 0.0 && ub <= 0.0) return 0.0;
  float ys = aacTrigEvalR(YC, RY, pY, aacTrigSolve(UC, RU, pU, 0.0, a, b));
  return (ua > 0.0) ? ys - ya : yb - ys;
}
float aacWallArcMono(float UC, float RU, float pU, float YC, float RY, float pY, float a, float b, float ya, float yb,
                     float q0, float q1) {
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  bool loIn = (inc ? ya : yb) >= q0, hiIn = (inc ? yb : ya) <= q1;
  float tq0 = loIn ? (inc ? a : b) : aacTrigSolve(YC, RY, pY, q0, a, b);
  float tq1 = hiIn ? (inc ? b : a) : aacTrigSolve(YC, RY, pY, q1, a, b);
  float yq0 = loIn ? (inc ? ya : yb) : q0, yq1 = hiIn ? (inc ? yb : ya) : q1;
  float uA = inc ? tq0 : tq1, uB = inc ? tq1 : tq0, yA = inc ? yq0 : yq1, yB = inc ? yq1 : yq0;
  if (abs(uB - uA) < 1e-12) return aacTrigEvalR(UC, RU, pU, uA) > 0.0 ? yB - yA : 0.0;
  vec2 ex = aacPhaseExtrema(pU, min(uA, uB), max(uA, uB));
  float g0 = ex.x, g1 = ex.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = uB > uA;
  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : uB);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : uB;
  float ym0 = (n >= 1) ? aacTrigEvalR(YC, RY, pY, m0) : yB, ym1 = (n == 2) ? aacTrigEvalR(YC, RY, pY, m1) : yB;
  return aacWallArcPiece(UC, RU, pU, YC, RY, pY, uA, m0, yA, ym0) + aacWallArcPiece(UC, RU, pU, YC, RY, pY, m0, m1, ym0, ym1)
       + aacWallArcPiece(UC, RU, pU, YC, RY, pY, m1, uB, ym1, yB);
}
float aacWallArc(vec3 X, vec3 Y, float th0, float th1, vec2 yE, float alpha, float beta, float q0, float q1) {
  if (abs(th1 - th0) < 1e-9) return 0.0;
  vec3 U = X - beta * Y - vec3(alpha, 0.0, 0.0);
  float Ry = abs(Y.y) + abs(Y.z), Ru = abs(U.y) + abs(U.z);
  if (Y.x + Ry <= q0 || Y.x - Ry >= q1 || U.x + Ru <= 0.0) return 0.0;
  float RY = sqrt(Y.y * Y.y + Y.z * Y.z), pY = curveAtan2(Y.z, Y.y);
  float yTh0 = yE.x, yTh1 = yE.y;
  if (U.x - Ru > 0.0) return clamp(yTh1, q0, q1) - clamp(yTh0, q0, q1);
  float RU = sqrt(U.y * U.y + U.z * U.z), pU = curveAtan2(U.z, U.y);
  vec2 ey = aacPhaseExtrema(pY, min(th0, th1), max(th0, th1));
  float g0 = ey.x, g1 = ey.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = th1 > th0;
  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : th1);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : th1;
  float ym0 = (n >= 1) ? aacTrigEvalR(Y.x, RY, pY, m0) : yTh1, ym1 = (n == 2) ? aacTrigEvalR(Y.x, RY, pY, m1) : yTh1;
  return aacWallArcMono(U.x, RU, pU, Y.x, RY, pY, th0, m0, yTh0, ym0, q0, q1)
       + aacWallArcMono(U.x, RU, pU, Y.x, RY, pY, m0, m1, ym0, ym1, q0, q1)
       + aacWallArcMono(U.x, RU, pU, Y.x, RY, pY, m1, th1, ym1, yTh1, q0, q1);
}

vec2 aacArcEndYM(vec4 ends, vec2 c, vec2 mx, vec2 my) {
  vec2 d0 = ends.xy - c, d1 = ends.zw - c;
  return vec2((mx * d0.x + my * d0.y + 0.5).y, (mx * d1.x + my * d1.y + 0.5).y);
}
void aacArcXYM(vec4 d1, vec4 d2, vec2 c, vec2 mx, vec2 my, out vec3 X, out vec3 Y) {
  float sp = sin(d2.z), cp = cos(d2.z);
  vec2 d = d1.xy - c;
  vec2 k0 = mx * d.x + my * d.y + 0.5, kc = (mx * cp + my * sp) * d1.z, ks = (my * cp - mx * sp) * d1.w;
  X = vec3(k0.x, kc.x, ks.x);
  Y = vec3(k0.y, kc.y, ks.y);
}
#endif

float renderFillAACM(vec2 c, vec2 mx, vec2 my, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  if (mx.y == 0.0 && my.x == 0.0) return renderFillAAC(c, vec2(mx.x, my.y), GD, evenOdd, shapeBB);

  if (abs(mx.x) < abs(mx.y)) { vec2 tx = vec2(mx.y, -mx.x), ty = vec2(my.y, -my.x); mx = tx; my = ty; }
  float det = mx.x * my.y - my.x * mx.y;
  float J00 = my.y / det, J01 = -my.x / det, J10 = -mx.y / det, J11 = mx.x / det;
  vec2 pa = 1.0 / vec2(abs(J00) + abs(J01), abs(J10) + abs(J11));

  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);
  float hy = 0.5 / pa.y;
  int b0 = clamp(int((c.y - hy - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int b1 = clamp(int((c.y + hy - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
#ifdef MANTLE_AAC_PAIR_BANDS
  bool covers = (b1 <= b0 + 1);
#else
  bool covers = (b0 == b1);
#endif
  int bandY = b0;
  if (!covers) {
    vec4 lv = bFetch(bLoc(gl, 1));
    int lTop = int(lv.z);
    int l = max(int(lv.w), 1), first = int(lv.y) / 2;
    for (int k = l; k < lTop && (b1 >> l) > (b0 >> l) + 1; k++) {
      first += (bandsY + (1 << l) - 1) >> l;
      l++;
    }
    if (!(lTop > 0 && (b1 >> l) <= (b0 >> l) + 1)) return renderFillAAC(c, pa, GD, evenOdd, shapeBB);
    bandY = first + (b0 >> l);
  }

  vec2 E0 = vec2(0.5 * (J00 - J01), 0.5 * (J10 - J11)) * pa + 0.5, E1 = vec2(0.5 * (J00 + J01), 0.5 * (J10 + J11)) * pa + 0.5;
  float beta = (E1.x - E0.x) / (E1.y - E0.y), alpha = E0.x - beta * E0.y;
  float wq0 = min(E0.y, E1.y), wq1 = max(E0.y, E1.y);

  int hdr = texLin(gl) + bandY * 2;
  vec4 cnts = bFetchL(hdr);
  int nLine = int(cnts.x), nQuad = int(cnts.y), nCubic = int(cnts.z), nArc = int(cnts.w);
  vec4 hdr1 = bFetchL(hdr + 1);
  int hE = texLin(gl) + int(hdr1.x);
  bool rej = fillRayReject(hdr1);
  float xBreak = c.x * pa.x - 0.5;
  float inBox = 0.0, far = 0.0;
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    vec4 pe = cFetchL(int(segRaw.x) + 1);
    far += aacWallLine(aacPL(pe.xy, c, pa), aacPL(pe.zw, c, pa), alpha, beta, wq0, wq1);
    vec2 A = aacPLM(pe.xy, c, mx, my), B = aacPLM(pe.zw, c, mx, my);
    if (max(A.x, B.x) > 0.0 && min(A.x, B.x) < 1.0 && max(A.y, B.y) > 0.0 && min(A.y, B.y) < 1.0)
      inBox += aacLineContrib(A, B, 0.0, 1.0) + aacWallLine(A, B, 1.0, 0.0, 0.0, 1.0);
  }
#endif
  hE += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec2 p3 = cFetchL(sL + 2).xy;
    far += aacWallQuad(aacPL(p12.xy, c, pa), aacPL(p12.zw, c, pa), aacPL(p3, c, pa), alpha, beta, wq0, wq1);
    vec2 A = aacPLM(p12.xy, c, mx, my), B = aacPLM(p12.zw, c, mx, my), C = aacPLM(p3, c, mx, my);
    if (max(A.x, max(B.x, C.x)) > 0.0 && min(A.x, min(B.x, C.x)) < 1.0 && max(A.y, max(B.y, C.y)) > 0.0 && min(A.y, min(B.y, C.y)) < 1.0)
      inBox += aacQuadContrib(A, B, C, 0.0, 1.0) + aacWallQuad(A, B, C, 1.0, 0.0, 0.0, 1.0);
  }
#endif
  hE += nQuad;
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1), p34 = cFetchL(sL + 2);
    far += aacWallCubic(aacPL(p12.xy, c, pa), aacPL(p12.zw, c, pa), aacPL(p34.xy, c, pa), aacPL(p34.zw, c, pa), alpha, beta, wq0, wq1);
    vec2 A = aacPLM(p12.xy, c, mx, my), B = aacPLM(p12.zw, c, mx, my), C = aacPLM(p34.xy, c, mx, my), D = aacPLM(p34.zw, c, mx, my);
    if (max(max(A.x, B.x), max(C.x, D.x)) > 0.0 && min(min(A.x, B.x), min(C.x, D.x)) < 1.0
        && max(max(A.y, B.y), max(C.y, D.y)) > 0.0 && min(min(A.y, B.y), min(C.y, D.y)) < 1.0)
      inBox += aacCubicContrib(A, B, C, D, 0.0, 1.0) + aacWallCubic(A, B, C, D, 1.0, 0.0, 0.0, 1.0);
  }
#endif
  hE += nCubic;
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    int sL = int(segRaw.x);
    vec4 d1 = cFetchL(sL + 1), d2 = cFetchL(sL + 2), ends = cFetchL(sL + 3);
    vec3 X, Y;
    aacArcXYM(d1, d2, c, vec2(pa.x, 0.0), vec2(0.0, pa.y), X, Y);
    far += aacWallArc(X, Y, d2.x, d2.y, aacArcEndYM(ends, c, vec2(pa.x, 0.0), vec2(0.0, pa.y)), alpha, beta, wq0, wq1);
    aacArcXYM(d1, d2, c, mx, my, X, Y);
    float Rx = abs(X.y) + abs(X.z), Ry = abs(Y.y) + abs(Y.z);
    if (X.x + Rx > 0.0 && X.x - Rx < 1.0 && Y.x + Ry > 0.0 && Y.x - Ry < 1.0) {
      vec2 yE = aacArcEndYM(ends, c, mx, my);
      inBox += aacArcContribXY(X, Y, d2.x, d2.y, yE, 0.0, 1.0) + aacWallArc(X, Y, d2.x, d2.y, yE, 1.0, 0.0, 0.0, 1.0);
    }
  }
#endif
  return aacFold(inBox - far / (pa.y * abs(J11)), evenOdd);
}
#endif

float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  return renderFillAAC(c, px, GD, evenOdd, shapeBB);
}

float renderFillM(vec2 c, vec2 mx, vec2 my, ivec4 GD, bool evenOdd, vec4 shapeBB) {
#ifdef MANTLE_ROTATED_MAP
  return renderFillAACM(c, mx, my, GD, evenOdd, shapeBB);
#else
  return renderFillAAC(c, vec2(mx.x, my.y), GD, evenOdd, shapeBB);
#endif
}

#if defined(MANTLE_POINTS_CLIP) || defined(MANTLE_POINTS_MASK)
uniform sampler2D uOverrideTex;
const int uHasOverrides = 0;

vec2 transformClipCoord(vec2 emCoord, int row) {

#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return emCoord;
#else
  if (uHasOverrides != 1) return emCoord;
  vec4 ovAff = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  vec4 ovP   = texelFetch(uOverrideTex, ovAt(OV_POS_VIS, row), 0);

  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;

  if (!(abs(det) > 2.384185791015625e-7 * (abs(ovAff.x * ovAff.w) + abs(ovAff.y * ovAff.z)))) return emCoord;
  float invDet = 1.0 / det;
  vec2 d = emCoord - ovP.xy;
  return vec2(invDet * ( ovAff.w * d.x - ovAff.y * d.y),
              invDet * (-ovAff.z * d.x + ovAff.x * d.y));
#endif
}

vec2 transformClipPx(vec2 invPx, int row) {
#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return invPx;
#else
  if (uHasOverrides != 1) return invPx;
  vec4 ovAff = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  if (ovAff == vec4(1.0, 0.0, 0.0, 1.0)) return invPx;
  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;
  if (!(abs(det) > 2.384185791015625e-7 * (abs(ovAff.x * ovAff.w) + abs(ovAff.y * ovAff.z)))) return invPx;
  vec2 e = 1.0 / invPx;
  vec2 local = vec2(abs(ovAff.w) * e.x + abs(ovAff.y) * e.y, abs(ovAff.z) * e.x + abs(ovAff.x) * e.y) / abs(det);
  return 1.0 / max(local, vec2(1e-30));
#endif
}

vec2 transformClipDir(vec2 dEm, int row) {
#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return dEm;
#else
  if (uHasOverrides != 1) return dEm;
  vec4 ovAff = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;
  if (!(abs(det) > 2.384185791015625e-7 * (abs(ovAff.x * ovAff.w) + abs(ovAff.y * ovAff.z)))) return dEm;
  float invDet = 1.0 / det;
  return vec2(invDet * ( ovAff.w * dEm.x - ovAff.y * dEm.y),
              invDet * (-ovAff.z * dEm.x + ovAff.x * dEm.y));
#endif
}

vec2 transformClipEPx(vec2 dx, vec2 dy, int row) { return abs(transformClipDir(dx, row)) + abs(transformClipDir(dy, row)); }

float evalClipCoverageAtRow(vec2 emCoord, vec2 px, int firstRow) {

  float acc = 0.0;
  bool multiClip = false;
  int rows = metaRowsOf(textureSize(uMetaTex, 0));
  for (int k = 0; firstRow + k < rows; k++) {
    int cRow = firstRow + k;
    vec4 ccap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
    int cflags = int(ccap.w + 0.5);
    if (k == 0) multiClip = (cflags & 2048) != 0;
    if (multiClip && (cflags & 256) == 0) break;
    vec4 cBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
    bool cEvenOdd = cStrokePad.y > 0.5;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    vec2 localCoord = transformClipCoord(emCoord, cRow);
    float c = renderFill(localCoord, transformClipPx(px, cRow), cGD, cEvenOdd, cBB);
    acc = max(acc, c);

    if (!multiClip || acc >= 1.0 || (cflags & 4096) != 0) break;
  }
  return clamp(acc, 0.0, 1.0);
}

float evalClipCoverage(vec2 emCoord, vec2 px, int firstRow) {
  float acc = 0.0;
  bool multiClip = false;
  int rows = metaRowsOf(textureSize(uMetaTex, 0));
  for (int k = 0; firstRow + k < rows; k++) {
    int cRow = firstRow + k;
    vec4 ccap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
    int cflags = int(ccap.w + 0.5);
    if (k == 0) multiClip = (cflags & 2048) != 0;
    if (multiClip && (cflags & 256) == 0) break;
    vec4 cBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
    bool cEvenOdd = cStrokePad.y > 0.5;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    vec2 localCoord = transformClipCoord(emCoord, cRow);
    float c = renderFill(localCoord, transformClipPx(px, cRow), cGD, cEvenOdd, cBB);

    if (c > acc) {
      vec4 cMeta7 = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, cRow), 0);
      int innerClipId = int(cMeta7.z + 0.5);
      if (innerClipId > 0) c *= evalClipCoverageAtRow(emCoord, px, innerClipId - 1);
    }
    acc = max(acc, c);
    if (!multiClip || acc >= 1.0 || (cflags & 4096) != 0) break;
  }
  return clamp(acc, 0.0, 1.0);
}

#endif

uniform vec2  uCanvasAR;
uniform vec2  uViewportSize;
uniform mat3  uWorldM;
uniform float uDrawAlpha;
uniform int   uStrokeExactAa;

uniform mat4  uColorMatrix;
uniform vec4  uColorMatrixOffset;
uniform int   uColorMatrixEnabled;

#ifdef MANTLE_POINTS_GEN

uniform highp usampler2D uPtTable;
uniform int uPtEntries;
uvec4 ptTexel(int i) { return texelFetch(uPtTable, ivec2(i & 4095, i >> 12), 0); }
uvec4 pointAt(int id) {
  int j = id >> 6, q = uPtEntries + (j >> 2), c = j & 3;
  uvec4 bb = ptTexel(q);
  int lo = int(bb[c]), hi = int(c == 3 ? ptTexel(q + 1).x : bb[c + 1]);
  while (lo < hi) {
    int mid = (lo + hi + 1) >> 1;
    if (int(ptTexel(mid).x) <= id) lo = mid; else hi = mid - 1;
  }
  uvec4 e = ptTexel(lo);
  uint k = uint(id) - e.x, w = e.z;
  return uvec4(e.y & 0xffffu, (e.w & 0xffffu) + k % w, (e.w >> 16) + k / w, e.y >> 16);
}
#else
in uvec4 aPt;
#endif
out vec4 vColor;

float childFill(vec2 c, vec2 invPx, ivec4 cGD, bool evenOdd, vec4 cBB) { return renderFillAAC(c, invPx, cGD, evenOdd, cBB); }

#ifdef MANTLE_POINTS_MASK

float maskFactor(int s, vec2 emCoord, vec2 ePx, vec2 invPx, vec2 emDx, vec2 emDy) {
  int maskId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).w + 0.5);
  if (maskId <= 0) return 1.0;
  int firstRow = maskId - 1;
  vec4 firstCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, firstRow), 0);
  bool isMultiShape = (int(firstCap.w + 0.5) & 512) != 0;
  if (!isMultiShape) {
    vec4 mFill  = texelFetch(uMetaTex, metaAt(MT_FILL, firstRow), 0);
    vec4 mIso = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, firstRow), 0);
    float w = (int(mIso.z + 0.5) != 0) ? dot(mFill.rgb, vec3(0.2126, 0.7152, 0.0722)) * mFill.a : mFill.a;
    float mCov = 0.0;
    if (w != 0.0) {
      vec4 mBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, firstRow), 0);
      vec4 mGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, firstRow), 0);
      bool mEvenOdd = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, firstRow), 0).y > 0.5;
      mCov = childFill(emCoord, invPx, ivec4(int(mGlyph.x), int(mGlyph.y), int(mGlyph.z), int(mGlyph.w)), mEvenOdd, mBB);
      if (mCov > 0.0) {
        int innerClipId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, firstRow), 0).z + 0.5);
        if (innerClipId > 0) mCov *= evalClipCoverage(emCoord, invPx, innerClipId - 1);
      }
    }
    return mCov * w;
  }
  vec4 acc = vec4(0.0);
  int maskRows = metaRowsOf(textureSize(uMetaTex, 0));
  for (int k = 0; firstRow + k < maskRows; k++) {
    int cRow = firstRow + k;
    vec4 cCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
    int cFlags = int(cCap.w + 0.5);
    if ((cFlags & 256) == 0) break;
    vec4 cBB     = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
    vec4 cStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, cRow), 0);
    vec4 cGlyph  = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
    vec4 cGrad7  = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, cRow), 0);
    int cStrokeGradId = int(cGrad7.y + 0.5);
    float cSW = cStrokePad.x;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y), int(cGlyph.z), int(cGlyph.w));
    bool cEvenOdd = cStrokePad.y > 0.5;
    float cCov;
    bool cIsStroke = cSW > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0);
    if (cIsStroke) {
      int cDashId = int(cStrokePad.w + 0.5);
      strokeDashScale = (cFlags & 1) != 0 ? 0.5 * (ePx.x + ePx.y) : 1.0;
          float halfW = cSW * 0.5 * strokeWidthMultiplier(cFlags, ePx);
      int startCapM = int(cCap.x + 0.5), joinStyle = int(cCap.y + 0.5);
      float miterLim = cCap.z;
      int endCapMEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, cRow), 0).z + 0.5);
      int endCapM = (endCapMEnc == 0) ? startCapM : (endCapMEnc - 1);
      vec2 _sgDummy; vec4 _seDP, _seDQ;
      float minD;
      bool cLocalSt = (cFlags & FS_STROKE_LOCAL) != 0;
      vec4 cStN = vec4(0.0);
      if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, cRow), 0);
      minD = strokeWalk(emCoord, cGD, cBB, cStN, cLocalSt, halfW,
                        startCapM, endCapM, joinStyle, miterLim, cDashId, _sgDummy,
                        -1e20, strokeAaReachEm(halfW, ePx), ePx, false, _seDP, _seDQ);
      cCov = strokeEdgeCov(minD, halfW, vec2(0.0), ePx, false);
    } else {
      cCov = childFill(emCoord, invPx, cGD, cEvenOdd, cBB);
    }
    if (cCov > 0.0) {
      int cClipId = int(cGrad7.z + 0.5);
      if (cClipId > 0) cCov *= evalClipCoverage(emCoord, invPx, cClipId - 1);
    }
    if (cCov > 0.0) {
      int cIsLum = int(texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, cRow), 0).z + 0.5);
      vec4 cPaint;
      if (cIsStroke) {
#ifdef MANTLE_POINTS_GRADIENT
        cPaint = (cStrokeGradId > 0) ? sampleGradient(cStrokeGradId, emCoord, cBB, emDx, emDy) * cStroke : cStroke;
#else
        cPaint = cStroke;
#endif
      } else {
        int cFillGradId = int(cGrad7.x + 0.5);
        vec4 cFill = texelFetch(uMetaTex, metaAt(MT_FILL, cRow), 0);
#ifdef MANTLE_POINTS_GRADIENT
        cPaint = (cFillGradId > 0) ? sampleGradient(cFillGradId, emCoord, cBB, emDx, emDy) * cFill : cFill;
#else
        cPaint = cFill;
#endif
      }
      float a = cCov * cPaint.a;
      float v = (cIsLum != 0) ? dot(cPaint.rgb, vec3(0.2126, 0.7152, 0.0722)) * a : a;
      acc.rgb = vec3(v) + acc.rgb * (1.0 - a);
      acc.a   = v      + acc.a   * (1.0 - a);
    }
    if ((cFlags & 1024) != 0) break;
  }
  return acc.a;
}
#endif

#ifdef MANTLE_POINTS_PATTERN

vec4 patternPaint(int s, vec2 emCoord, vec2 ePx, vec2 invPx, vec2 emDx, vec2 emDy, vec4 vAtlasSlot) {
  vec4 vImageRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, s), 0);
  vec2 tileOrigin = vImageRect.xy;
  vec2 tileSize = max(vImageRect.zw, vec2(1e-30));
  vec4 vPatLinv = texelFetch(uMetaTex, metaAt(MT_SOLID, s), 0);
  mat2 patLinv = mat2(vPatLinv.x, vPatLinv.y, vPatLinv.z, vPatLinv.w);
  vec2 patCoord = patLinv * emCoord;
  vec2 patDx = patLinv * emDx, patDy = patLinv * emDy;
  vec2 cEPx = ePx, cInvPx = invPx;
  if (vPatLinv.x != 1.0 || vPatLinv.y != 0.0 || vPatLinv.z != 0.0 || vPatLinv.w != 1.0) {
    cEPx = abs(patDx) + abs(patDy);
    cInvPx = 1.0 / max(cEPx, vec2(1e-30));
  }
  vec2 rel = patCoord - tileOrigin;
  vec2 tileEm = rel - floor(rel / tileSize) * tileSize;
  int firstRow1 = int(vAtlasSlot.x + 0.5), lastRow1 = int(vAtlasSlot.y + 0.5);
  vec2 nearLo = step(tileEm, cEPx), nearHi = step(tileSize - tileEm, cEPx);
  vec4 acc = vec4(0.0);
  for (int row1 = firstRow1; row1 <= lastRow1; row1++) {
    int rowIdx = row1 - 1;
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, rowIdx), 0);
    float cStrokeWidth = cStrokePad.x;
    vec4 cStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, rowIdx), 0);
    vec4 cGrad7 = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, rowIdx), 0);
    int cStrokeGradId = int(cGrad7.y + 0.5);
    vec4 cBB = texelFetch(uMetaTex, metaAt(MT_BBOX, rowIdx), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, rowIdx), 0);
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y), int(cGlyph.z), int(cGlyph.w));
    if (cStrokeWidth > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {
      vec4 cCapJoin = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, rowIdx), 0);
      int cStartCap = int(cCapJoin.x + 0.5), cJoinStyle = int(cCapJoin.y + 0.5);
      float cMiterLimit = cCapJoin.z;
      int cEndCapEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, rowIdx), 0).z + 0.5);
      int cEndCap = (cEndCapEnc == 0) ? cStartCap : (cEndCapEnc - 1);
      int cDashId = int(cStrokePad.w + 0.5);
      strokeDashScale = (int(cCapJoin.w + 0.5) & 1) != 0 ? 0.5 * (cEPx.x + cEPx.y) : 1.0;
        float halfW = cStrokeWidth * 0.5 * strokeWidthMultiplier(int(cCapJoin.w + 0.5), cEPx);
      vec2 _sgDummy; vec4 _seDP, _seDQ;
      float minD;
      bool cLocalSt = (int(cCapJoin.w + 0.5) & FS_STROKE_LOCAL) != 0;
      vec4 cStN = vec4(0.0);
      if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, rowIdx), 0);
      minD = strokeWalk(tileEm, cGD, cBB, cStN, cLocalSt, halfW,
                        cStartCap, cEndCap, cJoinStyle, cMiterLimit, cDashId, _sgDummy,
                        -1e20, strokeAaReachEm(halfW, cEPx), cEPx, false, _seDP, _seDQ);
      float cCov = strokeEdgeCov(minD, halfW, vec2(0.0), cEPx, false);
      if (cCov <= 0.0) continue;
#ifdef MANTLE_POINTS_GRADIENT
      vec4 paint = cStrokeGradId > 0 ? sampleGradient(cStrokeGradId, tileEm, cBB, patDx, patDy) * cStroke : cStroke;
#else
      vec4 paint = cStroke;
#endif
      float a = cCov * paint.a;
      acc.rgb = paint.rgb * a + acc.rgb * (1.0 - a);
      acc.a   = a + acc.a * (1.0 - a);
    } else {
      bool cEvenOdd = cStrokePad.y > 0.5;
      float cCov = 0.0;
      for (int nb = 0; nb < 9; nb++) {
        vec2 q = tileEm;
        bool use = true;
        if (nb == 1)      { use = nearLo.x > 0.5 && cBB.z > tileSize.x - cEPx.x; q = tileEm + vec2(tileSize.x, 0.0); }
        else if (nb == 2) { use = nearHi.x > 0.5 && cBB.x < cEPx.x;               q = tileEm - vec2(tileSize.x, 0.0); }
        else if (nb == 3) { use = nearLo.y > 0.5 && cBB.w > tileSize.y - cEPx.y; q = tileEm + vec2(0.0, tileSize.y); }
        else if (nb == 4) { use = nearHi.y > 0.5 && cBB.y < cEPx.y;               q = tileEm - vec2(0.0, tileSize.y); }
          else if (nb == 5) { use = nearLo.x > .5 && nearLo.y > .5 && cBB.z > tileSize.x - cEPx.x && cBB.w > tileSize.y - cEPx.y; q = tileEm + tileSize; }
          else if (nb == 6) { use = nearLo.x > .5 && nearHi.y > .5 && cBB.z > tileSize.x - cEPx.x && cBB.y < cEPx.y; q = tileEm + vec2(tileSize.x, -tileSize.y); }
          else if (nb == 7) { use = nearHi.x > .5 && nearLo.y > .5 && cBB.x < cEPx.x && cBB.w > tileSize.y - cEPx.y; q = tileEm + vec2(-tileSize.x, tileSize.y); }
          else if (nb == 8) { use = nearHi.x > .5 && nearHi.y > .5 && cBB.x < cEPx.x && cBB.y < cEPx.y; q = tileEm - tileSize; }
        if (use) {
          float r = childFill(q, cInvPx, cGD, cEvenOdd, cBB);
          cCov = (nb == 0) ? r : cCov + r;
        }
      }
      cCov = clamp(cCov, 0.0, 1.0);
      if (cCov <= 0.0) continue;
      int cFillGradId = int(cGrad7.x + 0.5);
      vec4 cFill = texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);
#ifdef MANTLE_POINTS_GRADIENT
      vec4 paint = cFillGradId > 0 ? sampleGradient(cFillGradId, tileEm, cBB, patDx, patDy) * cFill : cFill;
#else
      vec4 paint = cFill;
#endif
      float a = cCov * paint.a;
      acc.rgb = paint.rgb * a + acc.rgb * (1.0 - a);
      acc.a   = a + acc.a * (1.0 - a);
    }
  }
  return acc;
}
#endif

vec2 emToPx(vec2 em) {
  vec2 uv = (em - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 c = uWorldM * vec3(plane.x, -plane.y, 1.0);
  return (c.xy / c.z * 0.5 + 0.5) * uViewportSize;
}

#ifdef MANTLE_POINTS_STROKE
vec4 strokeColorAt(int s, vec2 emCoord, vec2 ePx, ivec4 GD, vec4 vShapeBBox, vec2 emDx, vec2 emDy) {
  vec4 vStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, s), 0);
  vec4 vCapJoin = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, s), 0);
  vec4 t11 = texelFetch(uMetaTex, metaAt(MT_PRIM, s), 0);
  int startCap = int(vCapJoin.x + 0.5);
  int flagsShape = int(vCapJoin.w + 0.5);
  int primKind = int(t11.x + 0.5);
  int dashId = int(vStrokePad.w + 0.5);
  bool nonScalingStroke = (flagsShape & 1) != 0;
  float vStrokeWidth = vStrokePad.x;
  bool squareBB = abs((vShapeBBox.z - vShapeBBox.x) - (vShapeBBox.w - vShapeBBox.y))
                    <= 1e-3 * max(vShapeBBox.z - vShapeBBox.x, vShapeBBox.w - vShapeBBox.y);
  bool noHScale = (flagsShape & (1 << 13)) != 0;
  bool noVScale = (flagsShape & (1 << 14)) != 0;
  strokeDashScale = nonScalingStroke ? 0.5 * (ePx.x + ePx.y) : 1.0;
  if (nonScalingStroke || noHScale || noVScale) {
    float emPerPx;
    if (noHScale && noVScale) emPerPx = 0.5 * (ePx.x + ePx.y);
    else if (noHScale)        emPerPx = ePx.x;
    else if (noVScale)        emPerPx = ePx.y;
    else                      emPerPx = 0.5 * (ePx.x + ePx.y);
    vStrokeWidth *= emPerPx;
  }
  vec4 vStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, s), 0);
  vStroke.a *= uDrawAlpha;
  if (uColorMatrixEnabled != 0) vStroke = clamp(uColorMatrix * vStroke + uColorMatrixOffset, 0.0, 1.0);
  if (!(vStrokeWidth > 0.0 && vStroke.a > 0.0)) return vec4(0.0);
  int joinStyle = int(vCapJoin.y + 0.5);
  float miterLimit = vCapJoin.z;
  float halfW = vStrokeWidth * 0.5;
  int endCapEnc = int(t11.z + 0.5);
  int endCap = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
  float minD;
  vec2 strokeGrad = vec2(0.0);
  vec4 edgeP = vec4(0.0), edgeQ = vec4(0.0), edgeN = vec4(1.0, 0.0, 0.0, 1.0);
  float halfWS = halfW;
  vec2 annHe = 0.5 * (vShapeBBox.zw - vShapeBBox.xy);
  if (primKind == 4 && squareBB && dashId == 0) {
    vec2 annQ = emCoord - 0.5 * (vShapeBBox.xy + vShapeBBox.zw);
    float annR = min(annHe.x, annHe.y) - vStrokePad.x * 0.5;
    float annL = length(annQ);
    minD = abs(annL - annR);
    strokeGrad = (annL > 1e-9) ? (annQ / annL) * sign(annL - annR) : vec2(0.0);
  } else {
    bool locSt = (flagsShape & FS_STROKE_LOCAL) != 0;
    if (locSt) edgeN = texelFetch(uMetaTex, metaAt(MT_SOLID, s), 0);
    minD = strokeWalk(emCoord, GD, vShapeBBox, locSt ? edgeN : vec4(0.0), locSt, halfW,
                      startCap, endCap, joinStyle, miterLimit, dashId, strokeGrad,
                      max(halfW - 0.5 * length(ePx), 0.0), strokeAaReachEm(halfW, ePx), ePx, true, edgeP, edgeQ);
  }
#ifdef MANTLE_STROKE_EXACT
  float strokeCov = (uStrokeExactAa != 0 && edgeP.w > 0.0 && halfW >= 0.25 * (ePx.x + ePx.y))
                    ? strokeExactCov(edgeP, edgeQ, halfWS, edgeN, ePx)
                    : strokeEdgeCov(minD, halfW, strokeGrad, ePx, uStrokeExactAa != 0);
#else
  float strokeCov = strokeEdgeCov(minD, halfW, strokeGrad, ePx, uStrokeExactAa != 0);
#endif

  vec4 strokePaint = vStroke;
#ifdef MANTLE_POINTS_GRADIENT
  int vStrokeGradId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).y + 0.5);
  if (vStrokeGradId > 0 && strokeCov != 0.0) strokePaint = sampleGradient(vStrokeGradId, emCoord, vShapeBBox, emDx, emDy) * vStroke;
#endif
  float sAlpha = strokeCov * strokePaint.a;
  return vec4(strokePaint.rgb * sAlpha, sAlpha);
}
#endif

void main() {
  gl_PointSize = 1.0;
#ifdef MANTLE_POINTS_GEN
  uvec4 aPt = pointAt(gl_VertexID);
#endif
  int s = int(aPt.x);
  vec4 bb = texelFetch(uMetaTex, metaAt(MT_BBOX, s), 0);
  vec2 p00 = emToPx(bb.xy);
  vec2 p10 = emToPx(bb.zy), p01 = emToPx(bb.xw), p11 = emToPx(bb.zw);
  vec2 lo = min(min(p00, p10), min(p01, p11));

  vec2 origin = floor(lo);
  vec2 pc = origin + (vec2(aPt.yz) - 32768.0) + 0.5;

  mat2 W2 = mat2(uWorldM[0].xy, uWorldM[1].xy);
  mat2 J = mat2(0.5 * uViewportSize.x, 0.0, 0.0, 0.5 * uViewportSize.y) * W2 * mat2(1.0, 0.0, 0.0, -1.0)
         * mat2(2.0 * uCanvasAR.x / uGlobalBBox.z, 0.0, 0.0, 2.0 * uCanvasAR.y / uGlobalBBox.w);
  mat2 Ji = inverse(J);
  vec2 em = bb.xy + Ji * (pc - p00);
  vec2 ePx = abs(Ji[0]) + abs(Ji[1]);
  vec2 invPx = 1.0 / max(ePx, vec2(1e-30));
  vec4 gb = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, s), 0);
  ivec4 GD = ivec4(int(gb.x), int(gb.y), int(gb.z), int(gb.w));
  if (aPt.w == 0u) {
    bool evenOdd = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, s), 0).y > 0.5;
#ifdef MANTLE_ROTATED_MAP

    vec2 emDx = Ji[0], emDy = Ji[1];
    vec2 slMx = vec2(invPx.x, 0.0), slMy = vec2(0.0, invPx.y);
    if (emDx.y != 0.0 || emDy.x != 0.0) {
      float det = emDx.x * emDy.y - emDy.x * emDx.y;
      if (det != 0.0) {
        slMx = vec2(emDy.y, -emDx.y) / det;
        slMy = vec2(-emDy.x, emDx.x) / det;
        if (det < 0.0) { slMx.y = -slMx.y; slMy.y = -slMy.y; }
      }
    }
    float cov = renderFillAACM(em, slMx, slMy, GD, evenOdd, bb);
#else
    float cov = renderFillAAC(em, invPx, GD, evenOdd, bb);
#endif
    vec4 fill = texelFetch(uMetaTex, metaAt(MT_FILL, s), 0);
    fill.a *= uDrawAlpha;
    if (uColorMatrixEnabled != 0) fill = clamp(uColorMatrix * fill + uColorMatrixOffset, 0.0, 1.0);
#ifdef MANTLE_POINTS_GRADIENT

    int fillGradId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).x + 0.5);
    if (fillGradId > 0 && cov != 0.0) fill = sampleGradient(fillGradId, em, bb, Ji[0], Ji[1]) * fill;
#endif
    vColor = vec4(fill.rgb * fill.a, fill.a) * cov;
#ifdef MANTLE_POINTS_PATTERN
    vec4 vAtlasSlot = texelFetch(uMetaTex, metaAt(MT_ATLAS, s), 0);
    if (abs(vAtlasSlot.w - 2.0) < 0.5 && cov > 0.0) vColor = patternPaint(s, em, ePx, invPx, Ji[0], Ji[1], vAtlasSlot) * cov * vec4(fill.rgb * fill.a, fill.a);
#endif
  } else {
#ifdef MANTLE_POINTS_STROKE
    vColor = strokeColorAt(s, em, ePx, GD, bb, Ji[0], Ji[1]);
#else
    vColor = vec4(0.0);
#endif
  }
#ifdef MANTLE_POINTS_MASK

  vColor *= maskFactor(s, em, ePx, invPx, Ji[0], Ji[1]);
#endif
#ifdef MANTLE_POINTS_CLIP

  int clipId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).z + 0.5);
  if (clipId > 0) vColor *= evalClipCoverage(em, invPx, clipId - 1);
#endif
  gl_Position = vec4(pc / uViewportSize * 2.0 - 1.0, 0.0, 1.0);
}
