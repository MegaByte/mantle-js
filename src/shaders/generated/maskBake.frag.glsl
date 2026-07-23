#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;

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

uniform sampler2D uDashTex;
uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;
uniform sampler2D uImageTex;
uniform vec2      uImageAtlasSize;
uniform sampler2D uFilterTex;
uniform vec4      uGlobalBBox;

uniform int  uMaskChildRow1Based;
uniform int  uMaskIsLuminance;

uniform int  uMaskOwnRow;

uniform highp sampler2DArray uMaskRTArrayPong;
uniform highp isampler2D     uMaskRowToLayerTexBake;
uniform vec2                 uViewportSize;

uniform sampler2D uOverrideTex;
uniform int       uHasOverrides;

in  vec2 vEmCoord;
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

int gradientSpreadToExtend(int spread) {

  if (spread == 1) return 2;
  if (spread == 2) return 1;
  return 0;
}

#ifndef MANTLE_NO_GRADIENT

vec4 sampleGradient(int gid, vec2 emCoord, vec4 shapeBB) {
  int row = gid - 1;
  vec4 g0 = texelFetch(uGradientTex, ivec2(GR_G0, row), 0);
  vec4 g1 = texelFetch(uGradientTex, ivec2(GR_G1, row), 0);
  vec4 g2 = texelFetch(uGradientTex, ivec2(GR_G2, row), 0);
  vec4 g3 = texelFetch(uGradientTex, ivec2(GR_G3, row), 0);
  int gType = int(g0.x + 0.5);
  int spread = int(g0.y + 0.5);
  float unitsFlag = g0.z;

  int stopsOffset = int(g2.z + 0.5);

  int stopsCount  = int(g2.w >= 0.0 ? g2.w + 0.5 : g2.w - 0.5);
  vec2 gp = emCoord;
  if (unitsFlag > 0.5) {
    vec2 bboxMin = shapeBB.xy;
    vec2 bboxSize = max(shapeBB.zw - bboxMin, vec2(1e-6));
    gp = (emCoord - bboxMin) / bboxSize;
  }
  float ax = g1.x, ay = g1.y, bx = g1.z, by = g1.w;
  float ex = g2.x, ey = g2.y;
  vec2 gpos = vec2(ax * gp.x + bx * gp.y + ex,
                   ay * gp.x + by * gp.y + ey);
  float t;
  if (gType == 0) {
    vec2 p1 = g3.xy;
    vec2 p2 = g3.zw;
    vec2 d = p2 - p1;
    float dd = max(dot(d, d), 1e-12);
    t = dot(gpos - p1, d) / dd;
  } else {
    vec2 c = g3.xy;
    float r = g3.z;
    float fxFrac = g3.w;
    float fyFrac = g0.w;
    vec2 f = c + vec2(fxFrac, fyFrac) * r;
    vec2 d = gpos - f;
    vec2 cf = c - f;
    float A = dot(d, d);
    float B = 2.0 * dot(cf, d);
    float C = dot(cf, cf) - r * r;
    float disc = B * B - 4.0 * A * C;
    if (disc < 0.0 || A < 1e-12) return vec4(0);
    float tParam = (B + sqrt(disc)) / (2.0 * A);
    t = 1.0 / tParam;
  }
  return sampleStops(t, stopsOffset, stopsCount, gradientSpreadToExtend(spread));
}
#endif

#ifndef MANTLE_NO_IMAGE
vec4 sampleChildImage(vec2 tileEm, vec4 imageRect, vec4 atlasSlot) {
  float u = (tileEm.x - imageRect.x) / max(imageRect.z, 1e-6);
  float v = (tileEm.y - imageRect.y) / max(imageRect.w, 1e-6);
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0);
  float atlasU = (u * atlasSlot.y) / max(uImageAtlasSize.x, 1.0);
  float atlasV = (atlasSlot.x + v * atlasSlot.z) / max(uImageAtlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {

    atlasU = (floor(atlasU * uImageAtlasSize.x) + 0.5) / max(uImageAtlasSize.x, 1.0);
    atlasV = (floor(atlasV * uImageAtlasSize.y) + 0.5) / max(uImageAtlasSize.y, 1.0);
  }
  return texture(uImageTex, vec2(atlasU, atlasV));
}

vec4 sampleTopLevelImage(vec2 emPos, vec4 imageRect, vec4 atlasSlot) {
  float u = (emPos.x - imageRect.x) / max(imageRect.z, 1e-6);
  float v = (emPos.y - imageRect.y) / max(imageRect.w, 1e-6);
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) {

    u = fract(u); if (u < 0.0) u += 1.0;
    v = fract(v); if (v < 0.0) v += 1.0;
  } else if (kind == 3) {

    u = abs(fract(u * 0.5) - 0.5) * 2.0;
    v = abs(fract(v * 0.5) - 0.5) * 2.0;
  } else {

    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0);
  }
  float atlasU = (u * atlasSlot.y) / max(uImageAtlasSize.x, 1.0);
  float atlasV = (atlasSlot.x + v * atlasSlot.z) / max(uImageAtlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    atlasU = (floor(atlasU * uImageAtlasSize.x) + 0.5) / max(uImageAtlasSize.x, 1.0);
    atlasV = (floor(atlasV * uImageAtlasSize.y) + 0.5) / max(uImageAtlasSize.y, 1.0);
  }
  return texture(uImageTex, vec2(atlasU, atlasV));
}
#endif

#define SLUG_NEWTON 5
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

bool dashCovered(int dashId, float dist) {
  if (dashId <= 0) return true;
  int row = dashId - 1;
  vec4 hdr = texelFetch(uDashTex, ivec2(DASH_HDR, row), 0);
  float cycleLen = hdr.r;
  int   count    = int(hdr.g + 0.5);
  float offset   = hdr.b;
  if (cycleLen <= 0.0 || count <= 0) return true;
  float d = mod(dist + offset, cycleLen);
  float accum = 0.0;
  for (int k = 0; k < 32; k++) {
    if (k >= count) break;
    int texelIdx = 1 + (k >> 2);
    int compIdx  = k & 3;
    vec4 texel = texelFetch(uDashTex, ivec2(texelIdx, row), 0);
    float v = (compIdx == 0) ? texel.x : (compIdx == 1) ? texel.y : (compIdx == 2) ? texel.z : texel.w;
    if (d < accum + v) return (k & 1) == 0;
    accum += v;
  }
  return true;
}

float perpDistToArc(vec2 q, vec2 tan, float kappa) {
  vec2 L = vec2(-tan.y, tan.x);
  if (abs(kappa) < 1e-6) return abs(dot(q, L));
  float R = 1.0 / kappa;
  vec2 CC = R * L;
  return abs(length(q - CC) - abs(R));
}

float strokeCapsJoinsDash(
    float t, float thisD, vec2 pStart, vec2 pEnd, vec2 dStart, vec2 dEnd,
    bool freeStart, bool freeEnd, int startCap, int endCap,
    int joinStyle, float miterLimit, float halfW,
    vec2 inTan, vec2 outTan, float startPrevReach, float endNextReach,
    int dashId, float startDist, float arcLenAtT, vec4 curv, float minDIn) {
  bool drop = false;
  if (t < 1e-4) {
    if (freeStart) {
      if (startCap == 0) {

        float tL0 = max(length(dStart), 1e-12);
        float aOut = dot(-pStart, -(dStart / tL0));
        thisD = max(thisD, halfW + aOut);
      }
      else if (startCap == 2) {
        float tL = max(length(dStart), 1e-12);
        vec2 segTan = dStart / tL;
        vec2 ep = pStart;
        float a = dot(-ep, -segTan);
        if (a < 0.0 || a > halfW) drop = true;
        else { float perp = length(-ep - (-segTan) * a); thisD = min(thisD, perp); }
      }
    } else if (joinStyle == 0 || joinStyle == 3) {
      float tL = max(length(dStart), 1e-12);
      vec2 segTan = dStart / tL;
      vec2 epStart = pStart;
      if (startPrevReach < 1e8 && dot(-epStart, inTan) < 0.0) drop = true;
      float c = dot(-segTan, inTan);

      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
      float maxMiter = halfW * miterLimit;
      if (joinStyle == 3) miterLen = min(miterLen, maxMiter);
      else if (miterLen > maxMiter) miterLen = -1.0;
      if (miterLen >= 0.0 && miterLen <= maxMiter) {
        vec2 ep = pStart;
        vec2 along = -segTan;
        float a = dot(-ep, along);
        if (a >= 0.0 && a <= miterLen) {
          float perpThis  = length(-ep - along * a);
          vec2  nIn       = vec2(-inTan.y, inTan.x);
          float perpOther = abs(dot(-ep, nIn));
          thisD = min(thisD, max(perpThis, perpOther));
        }
      }
    } else if (joinStyle == 4) {

      vec2 segTan = dStart / max(length(dStart), 1e-12);
      vec2 ep = pStart;
      if (startPrevReach < 1e8 && dot(-ep, inTan) < 0.0) drop = true;
      float c = dot(-segTan, inTan);

      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
      if (miterLen > halfW * miterLimit) {

        float cr = inTan.x * segTan.y - inTan.y * segTan.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(segTan.y, -segTan.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl;
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
      } else if (dot(-ep, -segTan) >= 0.0) {
        float perpThis  = perpDistToArc(-ep, segTan, curv.x);
        float perpOther = perpDistToArc(-ep, inTan, curv.z);
        thisD = min(thisD, max(perpThis, perpOther));
      }
    } else {
      vec2 ep = pStart;
      if (dot(-ep, inTan) < 0.0) drop = true;
      else if (joinStyle == 2) {

        vec2 tB = dStart / max(length(dStart), 1e-12);
        float cr = inTan.x * tB.y - inTan.y * tB.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(tB.y, -tB.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl;
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
      }
    }
  }
  if (t > 1.0 - 1e-4) {
    if (freeEnd) {
      if (endCap == 0) {

        float tL1 = max(length(dEnd), 1e-12);
        float aOut = dot(-pEnd, dEnd / tL1);
        thisD = max(thisD, halfW + aOut);
      }
      else if (endCap == 2) {
        float tL = max(length(dEnd), 1e-12);
        vec2 segTan = dEnd / tL;
        vec2 ep = pEnd;
        float a = dot(-ep, segTan);
        if (a < 0.0 || a > halfW) drop = true;
        else { float perp = length(-ep - segTan * a); thisD = min(thisD, perp); }
      }
    } else if (joinStyle == 0 || joinStyle == 3) {
      float tL = max(length(dEnd), 1e-12);
      vec2 segTan = dEnd / tL;
      vec2 epEnd = pEnd;
      if (endNextReach < 1e8 && dot(-epEnd, outTan) > 0.0) drop = true;
      float c = dot(segTan, -outTan);

      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
      float maxMiter = halfW * miterLimit;
      if (joinStyle == 3) miterLen = min(miterLen, maxMiter);
      else if (miterLen > maxMiter) miterLen = -1.0;
      if (miterLen >= 0.0 && miterLen <= maxMiter) {
        vec2 ep = pEnd;
        vec2 along = segTan;
        float a = dot(-ep, along);
        if (a >= 0.0 && a <= miterLen) {
          float perpThis  = length(-ep - along * a);
          vec2  nOut      = vec2(-outTan.y, outTan.x);
          float perpOther = abs(dot(-ep, nOut));
          thisD = min(thisD, max(perpThis, perpOther));
        }
      }
    } else if (joinStyle == 4) {

      vec2 segTan = dEnd / max(length(dEnd), 1e-12);
      vec2 ep = pEnd;
      if (endNextReach < 1e8 && dot(-ep, outTan) > 0.0) drop = true;
      float c = dot(segTan, -outTan);

      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
      if (miterLen > halfW * miterLimit) {
        float cr = segTan.x * outTan.y - segTan.y * outTan.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(segTan.y, -segTan.x), nB = sd * vec2(outTan.y, -outTan.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl;
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
      } else if (dot(-ep, segTan) >= 0.0) {
        float perpThis  = perpDistToArc(-ep, segTan, curv.y);
        float perpOther = perpDistToArc(-ep, outTan, curv.w);
        thisD = min(thisD, max(perpThis, perpOther));
      }
    } else {
      vec2 ep = pEnd;
      if (dot(-ep, outTan) > 0.0) drop = true;
      else if (joinStyle == 2) {

        vec2 tA = dEnd / max(length(dEnd), 1e-12);
        float cr = tA.x * outTan.y - tA.y * outTan.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(tA.y, -tA.x), nB = sd * vec2(outTan.y, -outTan.x);
        vec2 nb = nA + nB; float bl = length(nb);

        if (bl > 1e-4) { vec2 bis = nb / bl;
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
      }
    }
  }
  if (!drop && dashId > 0) {
    if (!dashCovered(dashId, startDist + arcLenAtT)) drop = true;
  }
  if (drop) return minDIn;
  return min(minDIn, thisD);
}

float strokeCubicAccum(vec4 p12, vec4 p34,
                           bool freeStart, bool freeEnd,
                           int startCap, int endCap,
                           int joinStyle, float miterLimit,
                           float halfW,
                           vec2 inTan, vec2 outTan,
                           int dashId, float startDist,
                           float startPrevReach, float endNextReach,
                           vec4 curv, float minDIn) {
  vec4 cx = cubicCoeff(p12.x, p12.z, p34.x, p34.z);
  vec4 cy = cubicCoeff(p12.y, p12.w, p34.y, p34.w);
  float bT = 0.0, bS = 1e20;
  for (int k = 0; k <= 8; k++) {
    float t = float(k) / 8.0;
    float pxv = evalC(cx, t);
    float pyv = evalC(cy, t);
    float d2 = pxv * pxv + pyv * pyv;
    if (d2 < bS) { bS = d2; bT = t; }
  }
  float startVelSq = cx.z * cx.z + cy.z * cy.z;
  float endVelX = cx.z + 2.0 * cx.y + 3.0 * cx.x;
  float endVelY = cy.z + 2.0 * cy.y + 3.0 * cy.x;
  float endVelSq = endVelX * endVelX + endVelY * endVelY;
  if (startVelSq < 1e-9 || endVelSq < 1e-9) {
    for (int kx = 0; kx < 8; kx++) {
      float t = (2.0 * float(kx) + 1.0) / 16.0;
      float pxv = evalC(cx, t);
      float pyv = evalC(cy, t);
      float d2 = pxv * pxv + pyv * pyv;
      if (d2 < bS) { bS = d2; bT = t; }
    }
  }
  float t = bT;
  for (int j = 0; j < 3; j++) {
    float pxv = evalC(cx, t);
    float pyv = evalC(cy, t);
    float dxv = evalCD(cx, t);
    float dyv = evalCD(cy, t);
    float f = pxv * dxv + pyv * dyv;
    float ddxv = 6.0 * cx.x * t + 2.0 * cx.y;
    float ddyv = 6.0 * cy.x * t + 2.0 * cy.y;
    float df = dxv * dxv + dyv * dyv + pxv * ddxv + pyv * ddyv;
    if (abs(df) < 1e-9) break;
    t = clamp(t - f / df, 0.0, 1.0);
  }
  float pxv = evalC(cx, t);
  float pyv = evalC(cy, t);
  float thisD = sqrt(pxv * pxv + pyv * pyv);
  vec2 pEnd = vec2(cx.x + cx.y + cx.z + cx.w, cy.x + cy.y + cy.z + cy.w);
  vec2 dStart = vec2(evalCD(cx, 0.0), evalCD(cy, 0.0));
  vec2 dEnd   = vec2(evalCD(cx, 1.0), evalCD(cy, 1.0));
  float arcLenAtT = (dashId > 0) ? slugCubicArcLen(cx, cy, clamp(t, 0.0, 1.0)) : 0.0;
  return strokeCapsJoinsDash(t, thisD, vec2(cx.w, cy.w), pEnd, dStart, dEnd,
                             freeStart, freeEnd, startCap, endCap,
                             joinStyle, miterLimit, halfW, inTan, outTan,
                             startPrevReach, endNextReach, dashId, startDist,
                             arcLenAtT, curv, minDIn);
}

float quadArcLen(vec2 p1, vec2 p2, vec2 p3, float t) {
  vec2 A = p1 - 2.0 * p2 + p3;
  vec2 B = p2 - p1;
  float Aq = dot(A, A), Bq = 2.0 * dot(A, B), Cq = dot(B, B);
  if (Aq < 1e-12) return length(p3 - p1) * t;
  float sqrtA = sqrt(Aq), disc = 4.0 * Aq * Cq - Bq * Bq;
  float ut = max(Aq * t * t + Bq * t + Cq, 0.0), sut = sqrt(ut);
  float argt = 2.0 * sqrtA * sut + 2.0 * Aq * t + Bq;
  float Ft = 2.0 * (((2.0 * Aq * t + Bq) * sut) / (4.0 * Aq)
           + ((argt > 1e-12) ? (disc / (8.0 * Aq * sqrtA)) * log(argt) : 0.0));
  float su0 = sqrt(max(Cq, 0.0));
  float arg0 = 2.0 * sqrtA * su0 + Bq;
  float F0 = 2.0 * ((Bq * su0) / (4.0 * Aq)
           + ((arg0 > 1e-12) ? (disc / (8.0 * Aq * sqrtA)) * log(arg0) : 0.0));
  return Ft - F0;
}

float quadClosestT(vec2 A, vec2 B, vec2 C) {
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
  float bt = 0.0, bs = 1e30;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    float tt = clamp(cand[i], 0.0, 1.0);
    vec2 qv = (A * tt + B) * tt + C;
    float d2 = dot(qv, qv);
    if (d2 < bs) { bs = d2; bt = tt; }
  }
  return bt;
}

float strokeQuadAccum(vec4 p12, vec2 p3,
                      bool freeStart, bool freeEnd,
                      int startCap, int endCap,
                      int joinStyle, float miterLimit, float halfW,
                      vec2 inTan, vec2 outTan,
                      int dashId, float startDist,
                      float startPrevReach, float endNextReach,
                      vec4 curv, float minDIn) {
  vec2 p1 = p12.xy, p2 = p12.zw;
  vec2 A = p1 - 2.0 * p2 + p3;
  vec2 B = 2.0 * (p2 - p1);
  vec2 C = p1;
  float t = quadClosestT(A, B, C);
  vec2 q = (A * t + B) * t + C;
  float thisD = length(q);
  vec2 dStart = B;
  if (dot(dStart, dStart) < 1e-18) dStart = p3 - p1;
  vec2 dEnd = 2.0 * A + B;
  if (dot(dEnd, dEnd) < 1e-18) dEnd = p3 - p1;
  float arcLenAtT = (dashId > 0) ? quadArcLen(p1, p2, p3, clamp(t, 0.0, 1.0)) : 0.0;
  return strokeCapsJoinsDash(t, thisD, p1, p3, dStart, dEnd,
                             freeStart, freeEnd, startCap, endCap,
                             joinStyle, miterLimit, halfW, inTan, outTan,
                             startPrevReach, endNextReach, dashId, startDist,
                             arcLenAtT, curv, minDIn);
}

vec4 texFetch(ivec2 xy) { xy.y += xy.x >> 12; xy.x &= 4095; return texelFetch(uCurveData, xy, 0); }
vec4 bFetch(ivec2 xy) { return texelFetch(uBandData, xy, 0); }

void arcSample(vec4 d1, float cp, float sp, float th, out vec2 p, out float dx, out float dy) {
  float ct = cos(th), st = sin(th);
  float ax = cp * d1.z, bx = sp * d1.w;
  float ay = sp * d1.z, by = cp * d1.w;
  p  = vec2(d1.x + ax * ct - bx * st,
            d1.y + ay * ct + by * st);
  dx = -ax * st - bx * ct;
  dy = -ay * st + by * ct;
}
ivec2 bLoc(ivec2 gl, int off) { ivec2 l=ivec2(gl.x+off, gl.y); l.y+=l.x>>12; l.x&=4095; return l; }

vec2 bandEntry(ivec2 gl, int arrIdx, int eIdx) {
  vec4 t = bFetch(bLoc(gl, arrIdx + (eIdx >> 1)));
  return (eIdx & 1) == 0 ? t.xy : t.zw;
}

ivec2 segLocXY(float loc) { int L = int(loc); return ivec2(L & 4095, L >> 12); }

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

float distToEllipse(vec2 ab, vec2 pIn, out vec2 foot) {
  vec2 sgn = sign(pIn);
  vec2 p = abs(pIn);
  bool swap = p.x > p.y;
  if (swap) { p = p.yx; ab = ab.yx; }
  float l = ab.y * ab.y - ab.x * ab.x;

  if (abs(l) < 1e-9 * max(ab.x * ab.x, ab.y * ab.y)) {
    vec2 fq = ab.x * normalize(p + vec2(1e-20));
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

float arcArcLen(vec4 d1, vec4 d2, float t) {
  float dth = d2.y - d2.x;
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float th = d2.x + dth * (t * SLUG_GL16_N[i]);
    float st = sin(th), ct = cos(th);
    sum += SLUG_GL16_W[i] * sqrt(d1.z * d1.z * st * st + d1.w * d1.w * ct * ct);
  }
  return t * abs(dth) * sum;
}

float strokeBandAccum(ivec2 gl, int hdrSlot,
                          vec2 c, float halfW,
                          int startCap, int endCap,
                          int joinStyle, float miterLimit,
                          int dashId, float minDIn) {
  vec4 cnts = bFetch(bLoc(gl, hdrSlot));
  int nLine  = int(cnts.x);
  int nQuad  = int(cnts.y);
  int nCubic = int(cnts.z);
  int nArc   = int(cnts.w);
  int arrIdx = int(bFetch(bLoc(gl, hdrSlot + 1)).x);
  int hOff = 0;
  float minD = minDIn;

  float sBreak = c.x - halfW;
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 pts = texFetch(dL);

    vec4 jn = texFetch(ivec2(dL.x + 1, dL.y));
    vec2 inTan  = jn.xy;
    vec2 outTan = jn.zw;
    vec2 a = pts.xy;
    vec2 b = pts.zw;
    vec2 ab = b - a;
    float abLen2 = max(dot(ab, ab), 1e-20);
    float abLen = sqrt(abLen2);
    float tRaw = dot(c - a, ab) / abLen2;
    vec2 segTan = ab / abLen;
    bool drop = false;

    float thisD = -1.0;
    if (tRaw < 0.0) {
      if (freeStart) {
        if (startCap == 0) {

          thisD = max(length(c - a), halfW + dot(c - a, -segTan));
        }
        else if (startCap == 2) {

          float along = dot(c - a, -segTan);
          if (along < 0.0 || along > halfW) drop = true;
          else thisD = length((c - a) + segTan * along);
        }

      } else {

        bool ourTerritory = dot(c - a, inTan) >= 0.0;
        if (ourTerritory && joinStyle == 2) {

          float cr = inTan.x * segTan.y - inTan.y * segTan.x;
          float sd = (cr >= 0.0) ? 1.0 : -1.0;
          vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(segTan.y, -segTan.x);
          vec2 nb = nA + nB; float bl = length(nb);
          if (bl > 1e-4) { vec2 bis = nb / bl;
            thisD = max(length(c - a), halfW + dot(c - a, bis) - halfW * dot(nA, bis)); }
        }
        if (ourTerritory) {
          float along = dot(c - a, -segTan);
          float capAlong = 0.0;

          if (joinStyle == 0 || joinStyle == 4) {

            float cosBetween = dot(-segTan, inTan);
            float sinHalf = sqrt(max(0.5 * (1.0 - cosBetween), 1e-9));
            float miterLen = halfW / max(sinHalf, 1e-6);
            if (miterLen <= halfW * miterLimit) capAlong = miterLen;
          }
          if (along <= capAlong) {
            float perpThis = length((c - a) + segTan * along);

            vec2 nIn = vec2(-inTan.y, inTan.x);
            float perpOther = abs(dot(c - a, nIn));

            thisD = max(perpThis, perpOther);
          }
        }
      }
    }
    if (tRaw > 1.0) {
      if (freeEnd) {
        if (endCap == 0) {

          thisD = max(length(c - b), halfW + dot(c - b, segTan));
        }
        else if (endCap == 2) {
          float along = dot(c - b, segTan);
          if (along < 0.0 || along > halfW) drop = true;
          else thisD = length((c - b) - segTan * along);
        }
      } else {
        bool ourTerritory = dot(c - b, -outTan) >= 0.0;
        if (ourTerritory && joinStyle == 2) {

          float cr = segTan.x * outTan.y - segTan.y * outTan.x;
          float sd = (cr >= 0.0) ? 1.0 : -1.0;
          vec2 nA = sd * vec2(segTan.y, -segTan.x), nB = sd * vec2(outTan.y, -outTan.x);
          vec2 nb = nA + nB; float bl = length(nb);
          if (bl > 1e-4) { vec2 bis = nb / bl;
            thisD = max(length(c - b), halfW + dot(c - b, bis) - halfW * dot(nA, bis)); }
        }
        if (ourTerritory) {
          float along = dot(c - b, segTan);
          float capAlong = 0.0;

          if (joinStyle == 0 || joinStyle == 4) {

            float cosBetween = dot(segTan, -outTan);
            float sinHalf = sqrt(max(0.5 * (1.0 - cosBetween), 1e-9));
            float miterLen = halfW / max(sinHalf, 1e-6);
            if (miterLen <= halfW * miterLimit) capAlong = miterLen;
          }
          if (along <= capAlong) {
            float perpThis = length((c - b) - segTan * along);
            vec2 nOut = vec2(-outTan.y, outTan.x);
            float perpOther = abs(dot(c - b, nOut));
            thisD = max(perpThis, perpOther);
          }
        }
      }
    }
    if (drop) continue;
    float tC = clamp(tRaw, 0.0, 1.0);
    if (dashId > 0) {
      float pathDist = hdr.w + tC * abLen;
      if (!dashCovered(dashId, pathDist)) continue;
    }
    if (thisD < 0.0) {
      vec2 closestPt = mix(a, b, tC);
      thisD = length(c - closestPt);
    }
    minD = min(minD, thisD);
  }
  hOff += nLine;

  for (int i = 0; i < 1024; i++) {
    if (i >= nQuad) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 p12 = texFetch(dL) - vec4(c, c);
    vec4 q3t = texFetch(ivec2(dL.x + 1, dL.y));
    vec2 q3  = q3t.xy - c;
    vec2 joinReach = q3t.zw;
    vec4 jn = texFetch(ivec2(dL.x + 2, dL.y));

    vec4 curv = (joinStyle == 4) ? texFetch(ivec2(dL.x + 3, dL.y)) : vec4(0.0);
    minD = strokeQuadAccum(p12, q3, freeStart, freeEnd,
                           startCap, endCap,
                           joinStyle, miterLimit, halfW,
                           jn.xy, jn.zw, dashId, hdr.w,
                           joinReach.x, joinReach.y, curv, minD);
  }
  hOff += nQuad;

  for (int i = 0; i < 1024; i++) {
    if (i >= nCubic) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 p12 = texFetch(dL) - vec4(c, c);
    vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
    vec4 jn = texFetch(ivec2(dL.x + 2, dL.y));
    vec4 curv = (joinStyle == 4) ? texFetch(ivec2(dL.x + 3, dL.y)) : vec4(0.0);
    minD = strokeCubicAccum(p12, p34, freeStart, freeEnd,
                                startCap, endCap,
                                joinStyle, miterLimit, halfW,
                                jn.xy, jn.zw, dashId, hdr.w,
                                1e9, 1e9, curv, minD);
  }
  hOff += nCubic;

  for (int i = 0; i < 1024; i++) {
    if (i >= nArc) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 d1 = texFetch(dL);
    vec4 d2 = texFetch(ivec2(dL.x + 1, dL.y));
    vec4 jn = texFetch(ivec2(dL.x + 2, dL.y));
    vec4 curv = (joinStyle == 4) ? texFetch(ivec2(dL.x + 3, dL.y)) : vec4(0.0);

    vec2 pc = c - d1.xy;
    float cphi = cos(d2.z), sphi = sin(d2.z);
    vec2 pR = vec2(pc.x*cphi + pc.y*sphi, -pc.x*sphi + pc.y*cphi);
    vec2 ep0 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.x);
    vec2 ep1 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.y);
    float dE = min(length(c - ep0), length(c - ep1));

    vec2 foot;
    float dEdge = distToEllipse(d1.zw, pR, foot);
    float tAng = atan(foot.y / max(d1.w, 1e-9), foot.x / max(d1.z, 1e-9));
    bool inRange = arcInRange(tAng, d2.x, d2.y);
    float arcD = inRange ? min(dEdge, dE) : dE;

    float dth = d2.y - d2.x;
    vec2 dStart = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.x), arcDyDtheta(d1.z, d1.w, d2.z, d2.x)) * dth;
    vec2 dEnd   = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.y), arcDyDtheta(d1.z, d1.w, d2.z, d2.y)) * dth;
    float tArc;
    if (inRange && dEdge <= dE) {
      float dd = hlslFmod(tAng - d2.x, TWO_PI);
      if (dd < 0.0) dd += TWO_PI;
      if (dth < 0.0 && dd > 0.0) dd -= TWO_PI;
      tArc = clamp(dd / dth, 0.0, 1.0);
    } else {
      tArc = (length(c - ep0) <= length(c - ep1)) ? 0.0 : 1.0;
    }
    float arcLenAtT = (dashId > 0) ? arcArcLen(d1, d2, tArc) : 0.0;
    minD = strokeCapsJoinsDash(tArc, arcD, ep0 - c, ep1 - c, dStart, dEnd,
                               freeStart, freeEnd, startCap, endCap,
                               joinStyle, miterLimit, halfW, jn.xy, jn.zw,
                               1e9, 1e9, dashId, hdr.w, arcLenAtT, curv, minD);
  }

  return minD;
}

float strokeMinDist(vec2 c, ivec4 GD, vec4 shapeBB, float halfW,
                        int startCap, int endCap,
                        int joinStyle, float miterLimit,
                        int dashId) {
  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  int hdr = bandIdx.y * 2;
  return strokeBandAccum(gl, hdr, c, halfW,
                             startCap, endCap,
                             joinStyle, miterLimit, dashId, 1e20);
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
  float rb = 0.5 / b.y;
  float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  float q  = b.y + (b.y >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0 && abs(q) > 1e-30) ? p12.y / q : tBig;
  float t1 = b.y >= 0.0 ? tSml : tBig;
  float t2 = b.y >= 0.0 ? tBig : tSml;
  if (abs(a.y) < 1.0/65536.0) { t1 = p12.y * rb; t2 = t1; }
  return vec4((a.x * t1 - b.x * 2.0) * t1 + p12.x,
              (a.x * t2 - b.x * 2.0) * t2 + p12.x,
              t1, t2);
}

vec4 slugSolveVertQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.x;
  float rb = 0.5 / b.x;
  float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  float q  = b.x + (b.x >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0 && abs(q) > 1e-30) ? p12.x / q : tBig;
  float t1 = b.x >= 0.0 ? tSml : tBig;
  float t2 = b.x >= 0.0 ? tBig : tSml;
  if (abs(a.x) < 1.0/65536.0) { t1 = p12.x * rb; t2 = t1; }
  return vec4((a.y * t1 - b.y * 2.0) * t1 + p12.y,
              (a.y * t2 - b.y * 2.0) * t2 + p12.y,
              t1, t2);
}
void solveCubicBisect(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t) {
  r = vec3(1e20); t = vec3(-1.0);
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

  float bds[4];
  bds[0] = 0.0;
  int nb = 1;
  if (split1 > 0.0) { bds[nb] = split1; nb++; }
  if (split2 > 0.0) { bds[nb] = split2; nb++; }
  bds[nb] = 1.0; nb++;

  int slot = 0;
  for (int i = 0; i < 3; i++) {
    if (i + 1 >= nb) break;
    float lo = bds[i], hi = bds[i + 1];
    float yLo = evalC(cy, lo);
    float yHi = evalC(cy, hi);
    bool sLo = yLo > 0.0;
    bool sHi = yHi > 0.0;

    const float EPS = 1e-6;
    if (abs(yLo) < EPS && abs(yHi) >= EPS) sLo = !sHi;
    else if (abs(yHi) < EPS && abs(yLo) >= EPS) sHi = !sLo;
    if (sLo == sHi) continue;

    float fLo = evalC(cy, lo) - 0.0, fHi = evalC(cy, hi) - 0.0;
    float sden = fHi - fLo;
    float xr = (abs(sden) > 1e-12) ? clamp(lo - fLo * (hi - lo) / sden, lo, hi)
                                   : 0.5 * (lo + hi);
    for (int k = 0; k < SLUG_NEWTON; k++) {
      float fy = evalC(cy, xr);
      float fdy = evalCD(cy, xr);
      if (abs(fdy) < 1e-12) break;
      float xn = xr - fy / fdy;
      xr = clamp(xn, lo, hi);
    }
    if (slot < 3) {
      t[slot] = xr;
      r[slot] = evalC(cx, xr);
      slot++;
    }
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

float bparamOf(vec2 p) {
  if (abs(p.y + 0.5) < 1e-4) return clamp(p.x + 0.5, 0.0, 1.0);
  if (abs(p.x - 0.5) < 1e-4) return 1.0 + clamp(p.y + 0.5, 0.0, 1.0);
  if (abs(p.y - 0.5) < 1e-4) return 2.0 + clamp(0.5 - p.x, 0.0, 1.0);
  return 3.0 + clamp(0.5 - p.y, 0.0, 1.0);
}
vec2 cornerOf(int j) {
  return j == 0 ? vec2(0.5, -0.5) : (j == 1 ? vec2(0.5, 0.5) : (j == 2 ? vec2(-0.5, 0.5) : vec2(-0.5, -0.5)));
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
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A; float L2 = dot(d, d); if (L2 < 1e-20) continue;
    float t = clamp(dot(-A, d) / L2, 0.0, 1.0);
    vec2 c = A + t * d; float dd = dot(c, c);
    if (dd < best) { best = dd; bA = A; bd2 = d; found = true; }
  }

  if (!found || best > 2.0) return -1.0;
  vec2 nOut = normalize(vec2(bd2.y, -bd2.x));
  return exactBoxCov(nOut, dot(nOut, bA));
}

vec2 qAtC(vec2 A, vec2 C, vec2 B, float t) {
  float u = 1.0 - t;
  return u * u * A + 2.0 * u * t * C + t * t * B;
}
vec2 qTanC(vec2 A, vec2 C, vec2 B, float t) {
  float u = 1.0 - t;
  return 2.0 * (u * (C - A) + t * (B - C));
}
vec2 qSubCtrlC(vec2 A, vec2 C, vec2 B, float u, float v) {
  return (1.0 - u) * (1.0 - v) * A + (u * (1.0 - v) + v * (1.0 - u)) * C + (u * v) * B;
}

float quadArcSide(vec2 A, vec2 C, vec2 B, vec2 p) {
  vec2 e1 = C - A, e2 = B - A, r = p - A;
  float det = e1.x * e2.y - e1.y * e2.x;
  if (abs(det) < 1e-20) return 0.0;
  float a = (r.x * e2.y - r.y * e2.x) / det;
  float b = (e1.x * r.y - e1.y * r.x) / det;
  float u = 0.5 * a + b, v = b;
  return (u * u - v) * det;
}
float conicChainBoxCov(vec2 p0, vec2 c0, vec2 p1, vec2 c1, vec2 p2, float forceInside) {
  if (forceInside > 1.5) {
    vec2 lo = min(min(min(p0, c0), min(p1, c1)), p2);
    vec2 hi = max(max(max(p0, c0), max(p1, c1)), p2);
    if (hi.x < -0.500001 || lo.x > 0.500001 || hi.y < -0.500001 || lo.y > 0.500001) return 1.0;
  }
  vec2 poly[16];
  vec2 tanAt[16];
  bool isEntry[16];
  int n = 0;
  float corr = 0.0;
  for (int s = 0; s < 2; s++) {
    vec2 A = s == 0 ? p0 : p1;
    vec2 C = s == 0 ? c0 : c1;
    vec2 B = s == 0 ? p1 : p2;
    if (dot(B - A, B - A) < 1e-12 && dot(C - A, C - A) < 1e-12) continue;
    vec2 lo = min(A, min(C, B)), hi = max(A, max(C, B));
    if (hi.x < -0.500001 || lo.x > 0.500001 || hi.y < -0.500001 || lo.y > 0.500001) continue;

    float ts[10];
    int m = 0;
    ts[m++] = 0.0; ts[m++] = 1.0;
    for (int ax = 0; ax < 2; ax++) {
      float Aa = ax == 0 ? A.x : A.y, Ca = ax == 0 ? C.x : C.y, Ba = ax == 0 ? B.x : B.y;
      float qa = Aa - 2.0 * Ca + Ba, qb = 2.0 * (Ca - Aa);
      for (int li = 0; li < 2; li++) {
        float qc = Aa - (li == 0 ? -0.5 : 0.5);
        if (abs(qa) < 1e-14) {
          if (abs(qb) > 1e-14) { float t = -qc / qb; if (t > 1e-9 && t < 1.0 - 1e-9 && m < 10) ts[m++] = t; }
        } else {
          float disc = qb * qb - 4.0 * qa * qc;
          if (disc >= 0.0) {
            float sq = sqrt(disc);
            float qq = -0.5 * (qb + (qb >= 0.0 ? sq : -sq));
            float r0 = qq / qa, r1 = abs(qq) > 1e-30 ? qc / qq : 1e9;
            if (r0 > 1e-9 && r0 < 1.0 - 1e-9 && m < 10) ts[m++] = r0;
            if (r1 > 1e-9 && r1 < 1.0 - 1e-9 && m < 10) ts[m++] = r1;
          }
        }
      }
    }
    for (int i = 1; i < 10; i++) {
      if (i >= m) break;
      float key = ts[i]; int j = i - 1;
      for (int k = 0; k < 10; k++) { if (j < 0 || ts[j] <= key) break; ts[j + 1] = ts[j]; j--; }
      ts[j + 1] = key;
    }
    for (int i = 0; i < 9; i++) {
      if (i + 1 >= m) break;
      float u = ts[i], v = ts[i + 1];
      if (v - u < 1e-12) continue;
      vec2 mid = qAtC(A, C, B, 0.5 * (u + v));
      if (max(abs(mid.x), abs(mid.y)) > 0.5 + 1e-9) continue;
      vec2 P0 = qAtC(A, C, B, u), P2 = qAtC(A, C, B, v);
      vec2 P1 = qSubCtrlC(A, C, B, u, v);
      corr += (2.0 / 3.0) * ((P1.x - P0.x) * (P2.y - P0.y) - (P1.y - P0.y) * (P2.x - P0.x));
      bool join = n > 0 && dot(poly[n - 1] - P0, poly[n - 1] - P0) < 1e-18;
      if (!join && n < 16) { poly[n] = P0; tanAt[n] = qTanC(A, C, B, u); isEntry[n] = true; n++; }
      if (n < 16) { poly[n] = P2; tanAt[n] = qTanC(A, C, B, v); isEntry[n] = false; n++; }
    }
  }
  if (n < 2) {

    float dA = 1e30, dB = 1e30;
    { vec2 d = p1 - p0; float L2 = dot(d, d);
      if (L2 > 1e-20) { vec2 c = p0 + clamp(dot(-p0, d) / L2, 0.0, 1.0) * d; dA = dot(c, c); } }
    { vec2 d = p2 - p1; float L2 = dot(d, d);
      if (L2 > 1e-20) { vec2 c = p1 + clamp(dot(-p1, d) / L2, 0.0, 1.0) * d; dB = dot(c, c); } }

    if (forceInside > 1.5) return 1.0;
    float near2 = min(dA, dB);
    if (near2 > 1.0) return forceInside > 0.5 ? 1.0 : 0.0;
    float sd = dA <= dB ? quadArcSide(p0, c0, p1, vec2(0.0)) : quadArcSide(p1, c1, p2, vec2(0.0));
    if (sd == 0.0) sd = dA <= dB ? quadArcSide(p1, c1, p2, vec2(0.0)) : quadArcSide(p0, c0, p1, vec2(0.0));
    if (sd != 0.0) return sd < 0.0 ? 1.0 : 0.0;
    return forceInside > 0.5 ? 1.0 : 0.0;
  }

  if (max(abs(poly[n - 1].x), abs(poly[n - 1].y)) < 0.5 - 1e-4 && n < 16) {
    vec2 dn = normalize(tanAt[n - 1]);
    float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
    float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
    poly[n] = poly[n - 1] + dn * min(tx, ty); tanAt[n] = tanAt[n - 1]; isEntry[n] = false; n++;
  }
  if (max(abs(poly[0].x), abs(poly[0].y)) < 0.5 - 1e-4 && n < 16) {
    vec2 dn = normalize(-tanAt[0]);
    float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
    float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
    vec2 E2 = poly[0] + dn * min(tx, ty);
    for (int i = 15; i >= 1; i--) if (i <= n) { poly[i] = poly[i - 1]; tanAt[i] = tanAt[i - 1]; isEntry[i] = isEntry[i - 1]; }

    poly[0] = E2; isEntry[0] = true; isEntry[1] = false; n++;
  }

  float area = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= n) break;
    int jn = (i + 1 == n) ? 0 : i + 1;
    vec2 a = poly[i], b = poly[jn];
    bool gap = (jn == 0) || isEntry[jn];
    if (!gap) { area += a.x * b.y - a.y * b.x; continue; }
    vec2 dX = tanAt[i];
    vec2 leftN = vec2(-dX.y, dX.x);
    vec2 tCCW;
    if (abs(a.y + 0.5) < 1e-4 && a.x < 0.5 - 1e-4) tCCW = vec2(1.0, 0.0);
    else if (abs(a.x - 0.5) < 1e-4 && a.y < 0.5 - 1e-4) tCCW = vec2(0.0, 1.0);
    else if (abs(a.y - 0.5) < 1e-4 && a.x > -0.5 + 1e-4) tCCW = vec2(-1.0, 0.0);
    else tCCW = vec2(0.0, -1.0);
    bool ccw = dot(tCCW, leftN) >= 0.0;
    float pa = bparamOf(a), pb = bparamOf(b);
    vec2 prev = a;
    if (ccw) { float pbW = pb < pa ? pb + 4.0 : pb;
      for (int j = 0; j < 8; j++) { float cp = float(j + 1);
        if (cp > pa + 1e-5 && cp < pbW - 1e-5) { vec2 cnr = cornerOf(j - (j / 4) * 4);
          area += prev.x * cnr.y - prev.y * cnr.x; prev = cnr; } }
    } else { float pbW = pb > pa ? pb - 4.0 : pb;
      for (int j = 7; j >= 0; j--) { float cp = float(j + 1) - 4.0;
        if (cp < pa - 1e-5 && cp > pbW + 1e-5) { vec2 cnr = cornerOf(j - (j / 4) * 4);
          area += prev.x * cnr.y - prev.y * cnr.x; prev = cnr; } }
    }
    area += prev.x * b.y - prev.y * b.x;
  }
  return clamp(abs(area + corr) * 0.5, 0.0, 1.0);
}

float chainBoxCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4, float forceInside) {
  vec2 poly[12];
  int n = 0;
  vec2 X = vec2(0.0);
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
    vec2 A2 = A + t0 * d, B2 = A + t1 * d;
    if (n == 0) { poly[0] = A2; n = 1; }
    else if (dot(poly[n - 1] - A2, poly[n - 1] - A2) > 1e-10 && n < 12) { poly[n] = A2; n++; }
    if (n < 12) { poly[n] = B2; n++; }
    X = B2;
  }

  if (n < 2) {
    if (forceInside > 1.5) { float mc = chainMissCov(p0, p1, p2, p3, p4);
      return mc < 0.0 ? 1.0 : mc; }
    return (forceInside > 0.5 || chainFillSide(p0, p1, p2, p3, p4)) ? 1.0 : 0.0;
  }

  {
    vec2 dEnd = poly[n - 1] - poly[n - 2];
    if (max(abs(poly[n - 1].x), abs(poly[n - 1].y)) < 0.5 - 1e-4 && dot(dEnd, dEnd) > 1e-12 && n < 12) {
      vec2 dn = normalize(dEnd);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
      poly[n] = poly[n - 1] + dn * min(tx, ty); n++;
      X = poly[n - 1];
    }
    vec2 dBeg = poly[1] - poly[0];
    if (max(abs(poly[0].x), abs(poly[0].y)) < 0.5 - 1e-4 && dot(dBeg, dBeg) > 1e-12 && n < 12) {
      vec2 dn = normalize(-dBeg);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
      vec2 E2 = poly[0] + dn * min(tx, ty);
      for (int i = 11; i >= 1; i--) if (i <= n) poly[i] = poly[i - 1];
      poly[0] = E2; n++;
    }
  }
  vec2 E = poly[0];
  vec2 dX = poly[n - 1] - poly[n - 2];
  vec2 leftN = vec2(-dX.y, dX.x);
  vec2 tCCW;
  if (abs(X.y + 0.5) < 1e-4 && X.x < 0.5 - 1e-4) tCCW = vec2(1.0, 0.0);
  else if (abs(X.x - 0.5) < 1e-4 && X.y < 0.5 - 1e-4) tCCW = vec2(0.0, 1.0);
  else if (abs(X.y - 0.5) < 1e-4 && X.x > -0.5 + 1e-4) tCCW = vec2(-1.0, 0.0);
  else tCCW = vec2(0.0, -1.0);
  bool ccw = dot(tCCW, leftN) >= 0.0;

  float pa = bparamOf(X), pb = bparamOf(E);
  if (ccw) { float pbW = pb < pa ? pb + 4.0 : pb;
    for (int j = 0; j < 8; j++) { float cp = float(j + 1);
      if (cp > pa + 1e-5 && cp < pbW - 1e-5 && n < 12) { poly[n] = cornerOf(j - (j / 4) * 4); n++; } }
  } else { float pbW = pb > pa ? pb - 4.0 : pb;
    for (int j = 7; j >= 0; j--) { float cp = float(j + 1) - 4.0;
      if (cp < pa - 1e-5 && cp > pbW + 1e-5 && n < 12) { poly[n] = cornerOf(j - (j / 4) * 4); n++; } }
  }
  float area = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    vec2 a = poly[i], b = poly[(i + 1 == n) ? 0 : i + 1];
    area += a.x * b.y - a.y * b.x;
  }
  return clamp(abs(area) * 0.5, 0.0, 1.0);
}

vec2 quadTanPx(vec4 p12, vec2 p3, float t, vec2 px) {
  vec2 d = 2.0 * ((p12.zw - p12.xy) * (1.0 - t) + (p3 - p12.zw) * t);
  return d * px;
}
vec2 cubicTanPx(vec4 p12, vec4 p34, float t, vec2 px) {
  float u = 1.0 - t;
  vec2 d = 3.0 * ((p12.zw - p12.xy) * (u * u) + (p34.xy - p12.zw) * (2.0 * u * t) + (p34.zw - p34.xy) * (t * t));
  return d * px;
}

vec3 exLine(vec2 tanPx, vec2 ptPx) {
  vec2 n = vec2(tanPx.y, -tanPx.x);
  return vec3(n, dot(n, ptPx));
}

#ifdef MANTLE_EXACT_EDGE
#define EX_H(V3) { exNH++; if (exNH == 1) { vec3 _v = (V3); \
  if (dot(_v.xy, _v.xy) < 1e-18) exOther = true; else { exNrmH = _v.xy; exDH = _v.z; } } }
#define EX_V(V3) { exNV++; if (exNV == 1) { vec3 _v = (V3); \
  if (dot(_v.xy, _v.xy) < 1e-18) exOther = true; else { exNrmV = _v.xy; exDV = _v.z; } } }
#else

#define EX_H(V3) {}
#define EX_V(V3) {}
#endif

#ifdef MANTLE_SLOPE_AA
#define SL_H(RI) { float _r = (RI); if (abs(_r) < abs(slH)) slH = _r; }
#define SL_V(RI) { float _r = (RI); if (abs(_r) < abs(slV)) slV = _r; }
#else
#define SL_H(RI) {}
#define SL_V(RI) {}
#endif

vec4 fillLinear(vec2 c, vec2 px, ivec4 GD, vec4 shapeBB, out vec4 exInfo, out vec2 slInfo) {

  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  float xcov = 0.0, ycov = 0.0, xwgt = 0.0, ywgt = 0.0;

#ifdef MANTLE_EXACT_EDGE
  int exNH = 0, exNV = 0; bool exOther = false;
  vec2 exNrmH = vec2(0.0), exNrmV = vec2(0.0); float exDH = 0.0, exDV = 0.0;
#endif
#ifdef MANTLE_SLOPE_AA
  float slH = 1e30, slV = 1e30;
#endif

  float hBreak = c.x * px.x - 0.5;
  float vBreak = c.y * px.y - 0.5;

  {
    int hdr = bandIdx.y * 2;
    vec4 hCnts = bFetch(bLoc(gl, hdr));
    int hLineN  = int(hCnts.x);
    int hQuadN  = int(hCnts.y);
    int hCubicN = int(hCnts.z);
    int hArcN   = int(hCnts.w);
    int arrIdx  = int(bFetch(bLoc(gl, hdr + 1)).x);
    int hOff = 0;

#ifndef MANTLE_NO_LINE

    for (int i = 0; i < 1024; i++) {
      if (i >= hLineN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p = texFetch(dL) - vec4(c, c);
      if (max(p.x, p.z) * px.x < -0.5) continue;

      bool p1Neg = p.y < 0.0;
      bool p2Neg = p.w < 0.0;
      if (p1Neg == p2Neg) continue;
      float dy = p.w - p.y;
      if (abs(dy) < 1.0 / 65536.0) continue;
      float t  = -p.y / dy;
      float rx = mix(p.x, p.z, t);
      float ri = rx * px.x;

      float sgn = p2Neg ? 1.0 : -1.0;
      xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
      xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      if (abs(ri) < 1.0) {
        vec2 A = vec2(p.x * px.x, p.y * px.y);
        vec2 B = vec2(p.z * px.x, p.w * px.y);
        EX_H(exLine(B - A, A));
      }
    }
#endif
    hOff += hLineN;

#ifndef MANTLE_NO_QUAD

    for (int i = 0; i < 1024; i++) {
      if (i >= hQuadN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.x, p12.z), p3.x) * px.x < -0.5) continue;
      uint code = calcRootCode2(p12.y, p12.w, p3.y);
      if (code == 0u) continue;
      vec4 rt = slugSolveHorizQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.x;
        xcov += clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);

        if (abs(ri) < 1.0) EX_H(exLine(quadTanPx(p12, p3, rt.z, px), vec2(ri, 0.0)));
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.x;
        xcov -= clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
        if (abs(ri) < 1.0) EX_H(exLine(quadTanPx(p12, p3, rt.w, px), vec2(ri, 0.0)));
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    hOff += hQuadN;

#ifndef MANTLE_NO_CUBIC

    for (int i = 0; i < 1024; i++) {
      if (i >= hCubicN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
      if (max(max(p12.x, p12.z), max(p34.x, p34.z)) * px.x < -0.5) continue;
      vec3 rs, ts;
      solveCubicBisect(p12, p34, false, rs, ts);
      vec4 cy = cubicCoeff(p12.y, p12.w, p34.y, p34.w);
      for (int j = 0; j < 3; j++) {
        if (ts[j] < 0.0 || ts[j] >= 1.0 || rs[j] >= 1e10 || rs[j] != rs[j]) continue;
        float ri  = rs[j] * px.x;

        float sgn = (evalCD(cy, ts[j]) < 0.0) ? 1.0 : -1.0;
        xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
        if (abs(ri) < 1.0) EX_H(exLine(cubicTanPx(p12, p34, ts[j], px), vec2(ri, 0.0)));
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    hOff += hCubicN;

#ifndef MANTLE_NO_ARC

    for (int i = 0; i < 1024; i++) {
      if (i >= hArcN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);

      vec2 pS9, pE9; float s9x, s9y, e9x, e9y;
      arcSample(d1, cp, sp, d2.x, pS9, s9x, s9y);
      arcSample(d1, cp, sp, d2.y, pE9, e9x, e9y);
      float yS9 = pS9.y - c.y, yE9 = pE9.y - c.y;
      if (abs(yS9) < 1e-3 && abs(yE9) >= 1e-3 && yE9 < 0.0) {
        float r9 = (pS9.x - c.x) * px.x;
        xcov += clamp(r9 + 0.5, 0.0, 1.0); SL_H(r9);
        xwgt = max(xwgt, clamp(1.0 - abs(r9) * 2.0, 0.0, 1.0));
      }
      if (abs(yE9) < 1e-3 && abs(yS9) >= 1e-3 && yS9 < 0.0) {
        float r9 = (pE9.x - c.x) * px.x;
        xcov -= clamp(r9 + 0.5, 0.0, 1.0); SL_H(r9);
        xwgt = max(xwgt, clamp(1.0 - abs(r9) * 2.0, 0.0, 1.0));
      }
      float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t1, p, ddx, ddy);
            float ri = (p.x - c.x) * px.x;

            float sgn = arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
            if (abs(ri) < 1.0) EX_H(exLine(vec2(ddx, ddy) * px, vec2(ri, (p.y - c.y) * px.y)));
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t2, p, ddx, ddy);
            float ri = (p.x - c.x) * px.x;
            float sgn = arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
            if (abs(ri) < 1.0) EX_H(exLine(vec2(ddx, ddy) * px, vec2(ri, (p.y - c.y) * px.y)));
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
#endif
  }

  {
    int hdr = bandsY * 2 + bandIdx.x * 2;
    vec4 vCnts = bFetch(bLoc(gl, hdr));
    int vLineN  = int(vCnts.x);
    int vQuadN  = int(vCnts.y);
    int vCubicN = int(vCnts.z);
    int vArcN   = int(vCnts.w);
    int arrIdx  = int(bFetch(bLoc(gl, hdr + 1)).x);
    int vOff = 0;

#ifndef MANTLE_NO_LINE

    for (int i = 0; i < 1024; i++) {
      if (i >= vLineN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p = texFetch(dL) - vec4(c, c);
      if (max(p.y, p.w) * px.y < -0.5) continue;

      bool p1Neg = p.x < 0.0;
      bool p2Neg = p.z < 0.0;
      if (p1Neg == p2Neg) continue;
      float dx = p.z - p.x;
      if (abs(dx) < 1.0 / 65536.0) continue;
      float t  = -p.x / dx;
      float ry = mix(p.y, p.w, t);
      float ri = ry * px.y;
      float sgn = p2Neg ? -1.0 : 1.0;
      ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);

      if (abs(ri) < 1.0) {
        vec2 A2 = vec2(p.x * px.x, p.y * px.y);
        vec2 B2 = vec2(p.z * px.x, p.w * px.y);
        EX_V(exLine(B2 - A2, A2));
      }
      ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
    }
#endif
    vOff += vLineN;

#ifndef MANTLE_NO_QUAD

    for (int i = 0; i < 1024; i++) {
      if (i >= vQuadN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.y, p12.w), p3.y) * px.y < -0.5) continue;

      uint code = calcRootCode2(p12.x, p12.z, p3.x);
      if (code == 0u) continue;
      vec4 rt = slugSolveVertQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.y;
        ycov -= clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
        if (abs(ri) < 1.0) EX_V(exLine(quadTanPx(p12, p3, rt.z, px), vec2(0.0, ri)));
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.y;
        ycov += clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
        if (abs(ri) < 1.0) EX_V(exLine(quadTanPx(p12, p3, rt.w, px), vec2(0.0, ri)));
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    vOff += vQuadN;

#ifndef MANTLE_NO_CUBIC

    for (int i = 0; i < 1024; i++) {
      if (i >= vCubicN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
      if (max(max(p12.y, p12.w), max(p34.y, p34.w)) * px.y < -0.5) continue;
      vec3 rs, ts;
      solveCubicBisect(p12, p34, true, rs, ts);
      vec4 cx = cubicCoeff(p12.x, p12.z, p34.x, p34.z);
      for (int j = 0; j < 3; j++) {
        if (ts[j] < 0.0 || ts[j] >= 1.0 || rs[j] >= 1e10 || rs[j] != rs[j]) continue;
        float ri  = rs[j] * px.y;
        float sgn = (evalCD(cx, ts[j]) >= 0.0) ? 1.0 : -1.0;
        ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
        if (abs(ri) < 1.0) EX_V(exLine(cubicTanPx(p12, p34, ts[j], px), vec2(0.0, ri)));
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    vOff += vCubicN;

#ifndef MANTLE_NO_ARC

    for (int i = 0; i < 1024; i++) {
      if (i >= vArcN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      float A = cp * d1.z, B = -sp * d1.w, C = -(d1.x - c.x);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {

          float ang = (B == 0.0) ? (A >= 0.0 ? 0.0 : TWO_PI * 0.5) : atan(B, A);
          float b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t1, p, ddx, ddy);
            float ri = (p.y - c.y) * px.y;
            float sgn = arcDir * ((ddx >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
            if (abs(ri) < 1.0) EX_V(exLine(vec2(ddx, ddy) * px, vec2((p.x - c.x) * px.x, ri)));
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t2, p, ddx, ddy);
            float ri = (p.y - c.y) * px.y;
            float sgn = arcDir * ((ddx >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
            if (abs(ri) < 1.0) EX_V(exLine(vec2(ddx, ddy) * px, vec2((p.x - c.x) * px.x, ri)));
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
#endif
  }

#ifdef MANTLE_EXACT_EDGE
  vec2 exNrm = exNrmH; float exD = exDH; float exCode = 0.0;
  if (exOther || exNH > 1 || exNV > 1) exCode = -1.0;
  else if (exNH == 1 && exNV == 1) {
    float l1 = length(exNrmH), l2 = length(exNrmV), pp = l1 * l2;
    float crs = abs(exNrmH.x * exNrmV.y - exNrmH.y * exNrmV.x);
    bool same = crs <= 0.174 * pp && abs(abs(exDH) * l2 - abs(exDV) * l1) <= 0.35 * pp;
    if (!same) exCode = -1.0;
    else {
      exCode = 1.0;
      if (abs(exDV) * l1 < abs(exDH) * l2) { exNrm = exNrmV; exD = exDV; }
    }
  } else if (exNH == 1) exCode = 1.0;
  else if (exNV == 1) { exNrm = exNrmV; exD = exDV; exCode = 1.0; }
  exInfo = vec4(exNrm, exD, exCode);
#else
  exInfo = vec4(0.0);
#endif
#ifdef MANTLE_SLOPE_AA
  slInfo = vec2(slH, slV);
#else
  slInfo = vec2(1e30);
#endif
  return vec4(xcov, ycov, xwgt, ywgt);
}

#if defined(MANTLE_GWN) || defined(MANTLE_HARD_MIXED)

#if defined(MANTLE_HARD_TREE) || defined(MANTLE_HARD_MIXED) || (defined(MANTLE_GWN) && !defined(MANTLE_GWN_SDF))
#define GWN_WINDING_ONLY 1
#endif

#if !defined(MANTLE_HARD_MIXED) || defined(MANTLE_HARD_TREE)

const float GWN_TAU = 6.283185307179586;

float gwnChord(vec2 p, vec2 A, vec2 B) {
  vec2 a = A - p, b = B - p;
  return atan(a.x * b.y - a.y * b.x, dot(a, b)) / GWN_TAU;
}

struct GwnSdfCand {
  float dpx;

  float sFill;

  vec2 nf;
  vec2 tv;
  float endNear;
  vec2 V;
};

float gwnCross(vec2 a, vec2 b) {
  if ((a.y < 0.0) == (b.y < 0.0)) return 0.0;
  float dy = b.y - a.y;
  float t = a.x * dy - a.y * (b.x - a.x);
  return (t * dy > 0.0) ? sign(dy) : 0.0;
}

float gwnBoxCov2(vec2 n1, float d1, vec2 n2, float d2) {
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

float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);

float gwnSegEval(vec2 c, vec2 px, ivec2 sL, int type, float sigma, out GwnSdfCand cand) {
  cand.dpx = 1e30; cand.sFill = 0.0; cand.nf = vec2(0.0);
  cand.tv = vec2(0.0); cand.endNear = 0.0; cand.V = vec2(0.0);
  if (type == 6) {

    vec4 p01 = texFetch(sL);
    vec4 p23 = texFetch(ivec2(sL.x + 1, sL.y));
    float wSeg = hardCrossCubic(c, p01 - vec4(c, c), p23 - vec4(c, c));
    vec2 A = p01.xy, B = p23.zw, t = B - A;
    float L2 = dot(t, t);
    if (L2 < 1e-20) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);
    float f = dot(n, c - A);
    vec2 gPx = n / px;
    float gpx = length(gPx);
    if (gpx < 1e-12) return wSeg;
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
    float L2 = dot(t, t);
    if (L2 < 1e-20) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);
    float f = dot(n, c - A);
    vec2 gPx = n / px;
    float gpx = length(gPx);
    if (gpx < 1e-12) return wSeg;
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
    float tproj = cl2 > 1e-20 ? dot(c - P0, chord) / cl2 : 0.5;

    float d = (P1.y - P2.y) * (P0.x - P2.x) + (P2.x - P1.x) * (P0.y - P2.y);
    float l = 0.0, m = 0.0, n_ = 0.0, u = 0.0, v = 0.0;
    vec2 gL = vec2(0.0), gm = vec2(0.0), gn = vec2(0.0);
    bool haveBary = abs(d) >= 1e-20;
    if (haveBary) {
      gL = vec2(P1.y - P2.y, P2.x - P1.x) / d;
      gm = vec2(P2.y - P0.y, P0.x - P2.x) / d;
      l = dot(gL, c - P2); m = dot(gm, c - P2);
      n_ = 1.0 - l - m;
      gn = -gL - gm;
      u = m * 0.5 + n_; v = n_;

      if (l >= 0.0 && m >= 0.0 && n_ >= 0.0 && (u * u - v) < 0.0) {
        float sideP = (P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x;
        wSeg += sign(sideP);
      }
    }
    vec2 gEm; float f; float rank = -1.0;
    if (tproj < 0.0 || tproj > 1.0) {

      vec2 V  = tproj < 0.0 ? P0 : P2;
      vec2 tg = tproj < 0.0 ? P1 - P0 : P2 - P1;
      float tl2 = dot(tg, tg);
      if (tl2 < 1e-20) { tg = chord; tl2 = cl2; }
      vec2 n = vec2(-tg.y, tg.x) * inversesqrt(max(tl2, 1e-20));
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
    if (gpx < 1e-12) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;

    if (rank < 0.0 && cl2 > 1e-20) {
      float cl9 = sqrt(cl2);
      float devS9 = ((c.x - P0.x) * chord.y - (c.y - P0.y) * chord.x) / cl9;
      float ctrlDev = abs((P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x) / cl9;
      float slabPx = (abs(devS9) - 0.5 * ctrlDev) / max(min(1.0 / px.x, 1.0 / px.y), 1e-12);
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
    if (cl2 < 1e-20) return wSeg;
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

      if (min(tc.z, tc.w) <= 1e-4 * max(max(tc.z, tc.w), 1e-9)) {
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

    if (tproj > 0.0 && tproj < 1.0 && devS * luneAdd > 0.0 && abs(devS) <= maxDev
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
    if (gpx < 1e-12) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;

    float slabPx = (abs(devS) - maxDev) / max(min(1.0 / px.x, 1.0 / px.y), 1e-12);
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

float renderFillGWNSDF(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1, bandsX = GD.z + 1;
  vec4 hdr = bFetch(bLoc(gl, (bandsY + bandsX) * 2));
  int nodeBase = int(hdr.x), nodeCount = int(abs(hdr.y)), refBase = int(hdr.z);
  float sigma = hdr.y >= 0.0 ? 1.0 : -1.0;
  if (nodeCount <= 0) return 0.0;

  vec2 emPerPx = 1.0 / max(px, vec2(1e-6));
  float cellR = 0.70710678 * max(emPerPx.x, emPerPx.y);
  vec4 ext = bFetch(bLoc(gl, refBase + int(hdr.w)));

#ifndef MANTLE_GWN_NOEXIT

  int gridBase = int(ext.z);
  if (gridBase > 0) {
    int gwh = int(ext.w);
    int GW = gwh / 256, GH = gwh - (gwh / 256) * 256;
    vec2 bbSz = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
    vec2 g = (c - shapeBB.xy) / bbSz * vec2(float(GW), float(GH));
    int gx = int(floor(g.x)), gy = int(floor(g.y));
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) {
      int ci = gy * GW + gx;
      vec4 cell = bFetch(bLoc(gl, gridBase + ci / 2));
      vec2 wm = ci - (ci / 2) * 2 == 0 ? cell.xy : cell.zw;
      if (wm.y > cellR) {
        float awg = abs(wm.x);
        if (!evenOdd) return step(0.5, awg);
        float mg = mod(awg, 2.0);
        return (mg >= 0.5 && mg < 1.5) ? 1.0 : 0.0;
      }
    }
  }
#endif

  float w = 0.0;
  GwnSdfCand c1, c2;
  c1.dpx = 1e30; c1.sFill = 0.0; c1.nf = vec2(0.0); c1.tv = vec2(0.0); c1.endNear = 0.0; c1.V = vec2(0.0);
  c2 = c1;

  int GB = 0, byP = 0, nbB = -1, rbBase = 0;
#ifndef MANTLE_GWN_NOEXIT
  GB = int(ext.y); rbBase = int(ext.x);
  if (GB > 0) {
    float bandH = max(shapeBB.w - shapeBB.y, 1e-6) / float(GB);
    if (bandH <= 2.0 * cellR) { GB = 0; }
    else {
      byP = clamp(int((c.y - shapeBB.y) / bandH), 0, GB - 1);
      float yloc = c.y - shapeBB.y - float(byP) * bandH;
      if (yloc < cellR && byP > 0) nbB = byP - 1;
      else if (bandH - yloc < cellR && byP < GB - 1) nbB = byP + 1;
    }
  }
#endif

  for (int pass = 0; pass < 2; pass++) {
    int eBase = 0, eCount = 1;
    if (GB > 0) {
      int bandIdx = pass == 0 ? byP : nbB;
      vec4 bh = bFetch(bLoc(gl, rbBase + bandIdx / 2));
      vec2 bc = bandIdx - (bandIdx / 2) * 2 == 0 ? bh.xy : bh.zw;
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
        rootI = ex / 4;
        int fl = ex - rootI * 4;
        if (pass == 1 && ((nbB < byP && fl - (fl / 2) * 2 == 1) || (nbB > byP && fl >= 2)))
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
          if (abs(dcv.y) <= B.z && B.x + B.z > c.x) w += gwnCross(A.xy - c, A.zw - c);
          ni = B.w >= 0.0 ? int(B.w) : ni + 1;
          continue;
        }
        if (B.w < 0.0) {

          int v = int(-B.w) - 1;
          int rc = v - (v / 64) * 64, rs = v / 64;
          for (int k = 0; k < 32; k++) {
            if (k >= rc) break;
            vec4 R = bFetch(bLoc(gl, refBase + rs + k));
            GwnSdfCand cd;

            float sgP = R.w;
            w += gwnSegEval(c, px, ivec2(int(R.x), int(R.y)), int(R.z), sgP == 0.0 ? 1.0 : sgP, cd);
#ifndef GWN_WINDING_ONLY
            if (sgP != 0.0) {
              if (cd.dpx < c1.dpx) { c2 = c1; c1 = cd; }
              else if (cd.dpx < c2.dpx) { c2 = cd; }
            }
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
  float aw = abs(w);
  float inside = evenOdd ? ((mod(aw, 2.0) >= 0.5 && mod(aw, 2.0) < 1.5) ? 1.0 : 0.0) : step(0.5, aw);
#ifdef GWN_WINDING_ONLY

  return inside;
#endif
  if (c1.dpx > 0.70710678) return inside;

  bool single = c2.dpx > 0.70710678;
  float f1 = (single && ((c1.sFill >= 0.0) != (inside > 0.5))) ? -1.0 : 1.0;
  float cA = exactBoxCov(-c1.nf * f1, c1.sFill * f1);
  if (single) return cA;

  float cB = exactBoxCov(-c2.nf, c2.sFill);

  bool reflex = false;
  bool corner = c1.endNear != 0.0 && c2.endNear != 0.0 && c1.endNear != c2.endNear;
  if (corner) {
    vec2 dV = (c1.V - c2.V) * px;
    corner = dot(dV, dV) < 0.01;
    if (corner) {
      vec2 tIn = c1.endNear > 0.0 ? c1.tv : c2.tv;
      vec2 tOut = c1.endNear > 0.0 ? c2.tv : c1.tv;
      float turn = tIn.x * tOut.y - tIn.y * tOut.x;
      reflex = turn * sigma < 0.0;
    }
  }
  if (!corner) reflex = (c1.sFill > 0.0) != (c2.sFill > 0.0) && inside > 0.5;
  float inter = gwnBoxCov2(-c1.nf, c1.sFill, -c2.nf, c2.sFill);
  return reflex ? (cA + cB - inter) : inter;
}

#endif

float hardCrossLine(vec2 c, vec2 A, vec2 B) {
  float dy = B.y - A.y;
  if (abs(dy) < 1e-30) return 0.0;
  float t = (c.y - A.y) / dy;
  if (t < 0.0 || t >= 1.0) return 0.0;
  float x = A.x + t * (B.x - A.x);
  return (x > c.x) ? (dy > 0.0 ? 1.0 : -1.0) : 0.0;
}

float hardCrossQuad(vec2 c, vec2 P0, vec2 P1, vec2 P2) {
  float a = P0.y - 2.0 * P1.y + P2.y;
  float b = 2.0 * (P1.y - P0.y);
  float cc = P0.y - c.y;
  float w = 0.0;
  float ax = P0.x - 2.0 * P1.x + P2.x, bx = 2.0 * (P1.x - P0.x);
  if (abs(a) < 1e-20) {
    if (abs(b) < 1e-30) return 0.0;
    float t = -cc / b;
    if (t >= 0.0 && t < 1.0) { float x = ax * t * t + bx * t + P0.x;
      if (x > c.x) w += (b > 0.0 ? 1.0 : -1.0); }
    return w;
  }
  float disc = b * b - 4.0 * a * cc;
  if (disc < 0.0) return 0.0;
  float sd = sqrt(disc);
  for (int r = 0; r < 2; r++) {
    float t = (r == 0 ? (-b + sd) : (-b - sd)) / (2.0 * a);
    if (t < 0.0 || t >= 1.0) continue;
    float x = ax * t * t + bx * t + P0.x;
    if (x <= c.x) continue;
    float dydt = 2.0 * a * t + b;
    w += dydt > 0.0 ? 1.0 : -1.0;
  }
  return w;
}

float hardCrossCubic(vec2 c, vec4 p12, vec4 p34) {
  vec3 rs, ts;
  solveCubicBisect(p12, p34, false, rs, ts);
  vec4 cy = cubicCoeff(p12.y, p12.w, p34.y, p34.w);
  float w = 0.0;
  for (int j = 0; j < 3; j++) {
    if (ts[j] < 0.0 || ts[j] >= 1.0 || rs[j] >= 1e10 || rs[j] != rs[j]) continue;
    if (rs[j] <= 0.0) continue;
    w += (evalCD(cy, ts[j]) > 0.0) ? 1.0 : -1.0;
  }
  return w;
}

float hardCrossArc(vec2 c, vec4 d1, vec4 d2) {
  float sp = sin(d2.z), cp = cos(d2.z);
  float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
  float Rlen = sqrt(A * A + B * B);
  if (Rlen <= 1e-10) return 0.0;
  float ratio = C / Rlen;
  if (abs(ratio) >= 0.99999) return 0.0;
  float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
  float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
  float w = 0.0;
  for (int k = 0; k < 2; k++) {
    float th = (k == 0) ? (ang + b2) : (ang - b2);
    if (!arcInRange(th, d2.x, d2.y)) continue;
    vec2 pnt; float ddx, ddy; arcSample(d1, cp, sp, th, pnt, ddx, ddy);
    if (pnt.x <= c.x) continue;
    w += arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
  }
  return w;
}

float renderFillHardBand(vec2 c, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  int by = clamp(int((c.y - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int hdr = by * 2;
  vec4 cnts = bFetch(bLoc(gl, hdr));
  int nLine = int(cnts.x), nQuad = int(cnts.y);
  int arrIdx = int(bFetch(bLoc(gl, hdr + 1)).x);
  float w = 0.0;
  int hOff = 0;

#ifndef MANTLE_NO_LINE
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    w += hardCrossLine(c, pe.xy, pe.zw);
  }
#endif
  hOff += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < 1024; i++) {
    if (i >= nQuad) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 p3 = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    w += hardCrossQuad(c, p12.xy, p12.zw, p3);
  }
#endif
  hOff += nQuad;
#ifndef MANTLE_NO_CUBIC
  int nCubic = int(cnts.z);
  for (int i = 0; i < 1024; i++) {
    if (i >= nCubic) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 p12 = texFetch(dL) - vec4(c, c);
    vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
    w += hardCrossCubic(c, p12, p34);
  }
  hOff += nCubic;
#else
  hOff += int(cnts.z);
#endif
#ifndef MANTLE_NO_ARC
  int nArc = int(cnts.w);
  for (int i = 0; i < 1024; i++) {
    if (i >= nArc) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    w += hardCrossArc(c, texFetch(dL), texFetch(ivec2(dL.x + 1, dL.y)));
  }
#endif
  float aw = abs(w);
  if (!evenOdd) return step(0.5, aw);
  float m = mod(aw, 2.0);
  return (m >= 0.5 && m < 1.5) ? 1.0 : 0.0;
}

#endif

#ifdef MANTLE_AAC

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

#define AAC_NEWTON 6

float aacSolveC(vec4 C, float ta, float tb, float V) {
  float lo = min(ta, tb), hi = max(ta, tb);
  if (abs(C.x) < 1e-12) {
    float qa = C.y, qb = C.z, qc = C.w - V;
    if (abs(qa) < AAC_EPS)
      return clamp(abs(qb) > AAC_EPS ? -qc / qb : lo, lo, hi);
    float sq = sqrt(max(qb * qb - 4.0 * qa * qc, 0.0));
    float q  = -0.5 * (qb + (qb < 0.0 ? -sq : sq));
    float r1 = q / qa;
    float r2 = abs(q) > AAC_EPS ? qc / q : r1;
    float t  = (r1 >= lo - 1e-4 && r1 <= hi + 1e-4) ? r1 : r2;
    return clamp(t, lo, hi);
  }
#ifdef MANTLE_NO_CUBIC
  return 0.5 * (lo + hi);
#else
  float fa = evalC(C, lo) - V, fb = evalC(C, hi) - V, den = fb - fa;
  float t = (abs(den) > AAC_EPS) ? clamp(lo - fa * (hi - lo) / den, lo, hi)
                                 : 0.5 * (lo + hi);
  for (int k = 0; k < AAC_NEWTON; k++) {
    float f = evalC(C, t) - V;
    float d = evalCD(C, t);
    if (abs(d) < 1e-12) break;
    t = clamp(t - f / d, lo, hi);
  }
  return t;
#endif
}

vec3 aacAntiF0(vec4 CX, vec4 CY) {
  float a0 = CX.w, a1 = CX.z, a2 = CX.y;
  float e0 = CY.z, e1 = 2.0 * CY.y, e2 = 3.0 * CY.x;
  return vec3(a0 * e0,
              (a0 * e1 + a1 * e0) * 0.5,
              (a0 * e2 + a1 * e1 + a2 * e0) / 3.0);
}
vec3 aacAntiF1(vec4 CX, vec4 CY) {
  float a1 = CX.z, a2 = CX.y, a3 = CX.x;
  float e0 = CY.z, e1 = 2.0 * CY.y, e2 = 3.0 * CY.x;
  return vec3((a1 * e2 + a2 * e1 + a3 * e0) * 0.25,
              (a2 * e2 + a3 * e1) * 0.2,
              (a3 * e2) / 6.0);
}
float aacAnti(vec3 F0, vec3 F1, float t) {
  return t * (F0.x + t * (F0.y + t * (F0.z + t * (F1.x + t * (F1.y + t * F1.z)))));
}

float aacZoneI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float a, float b) {
  if (b - a < 1e-12) return 0.0;
  float xm = evalC(CX, 0.5 * (a + b));
  if (xm <= 0.0) return 0.0;
  if (xm >= 1.0) return evalC(CY, b) - evalC(CY, a);
  return aacAnti(F0, F1, b) - aacAnti(F0, F1, a);
}

float aacXMonoI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float a, float b) {
  if (b - a < 1e-12) return 0.0;
  float xa = evalC(CX, a), xb = evalC(CX, b);
  float xlo = min(xa, xb), xhi = max(xa, xb);
  if (xhi <= 0.0) return 0.0;
  if (xlo >= 1.0) return evalC(CY, b) - evalC(CY, a);
  if (xlo >= 0.0 && xhi <= 1.0) return aacAnti(F0, F1, b) - aacAnti(F0, F1, a);
  float c0 = 1e9, c1 = 1e9;
  if (xlo < 0.0 && xhi > 0.0) c0 = aacSolveC(CX, a, b, 0.0);
  if (xlo < 1.0 && xhi > 1.0) c1 = aacSolveC(CX, a, b, 1.0);
  float m0 = min(c0, c1), m1 = max(c0, c1);
  float acc = 0.0, prev = a;
  if (m0 < 1e8) { acc += aacZoneI2(CX, CY, F0, F1, prev, m0); prev = m0; }
  if (m1 < 1e8) { acc += aacZoneI2(CX, CY, F0, F1, prev, m1); prev = m1; }
  return acc + aacZoneI2(CX, CY, F0, F1, prev, b);
}

float aacExactI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float u0, float u1) {
  vec2 ex = aacQuadRoots(3.0 * CX.x, 2.0 * CX.y, CX.z);
  float e0 = ex.x, e1 = ex.y;
  float s0 = (e0 > u0 + 1e-7 && e0 < u1 - 1e-7) ? e0 : 1e9;
  float s1 = (e1 > u0 + 1e-7 && e1 < u1 - 1e-7) ? e1 : 1e9;
  if (s1 < s0) { float tmp = s0; s0 = s1; s1 = tmp; }
  float acc = 0.0, prev = u0;
  if (s0 < 1e8) { acc += aacXMonoI2(CX, CY, F0, F1, prev, s0); prev = s0; }
  if (s1 < 1e8) { acc += aacXMonoI2(CX, CY, F0, F1, prev, s1); prev = s1; }
  return acc + aacXMonoI2(CX, CY, F0, F1, prev, u1);
}

float aacClampI(float w0, float w1) {
  float d = w0 - w1;
  if (abs(d) < 1e-9) return clamp(0.5 * (w0 + w1), 0.0, 1.0);
  float a0 = max(w0, 0.0),       a1 = max(w1, 0.0);
  float b0 = max(w0 - 1.0, 0.0), b1 = max(w1 - 1.0, 0.0);
  return ((a0 * a0 - a1 * a1) - (b0 * b0 - b1 * b1)) / (2.0 * d);
}

float aacBezMonoContrib(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float ta, float tb, float q0, float q1) {
  float ya = evalC(CY, ta), yb = evalC(CY, tb);
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  float tLo, tHi;
  if (inc) {
    tLo = (ya >= q0) ? ta : aacSolveC(CY, ta, tb, q0);
    tHi = (yb <= q1) ? tb : aacSolveC(CY, ta, tb, q1);
  } else {
    tLo = (yb >= q0) ? tb : aacSolveC(CY, ta, tb, q0);
    tHi = (ya <= q1) ? ta : aacSolveC(CY, ta, tb, q1);
  }
  float u0 = min(tLo, tHi), u1 = max(tLo, tHi);
  if (u1 - u0 < 1e-12) return 0.0;
  return -aacExactI2(CX, CY, F0, F1, u0, u1);
}

float aacCurveContrib(vec4 CX, vec4 CY, float q0, float q1) {
  vec3 F0 = aacAntiF0(CX, CY), F1 = aacAntiF1(CX, CY);
  vec2 ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);
  float s0 = (ey.x > 1e-6 && ey.x < 1.0 - 1e-6) ? ey.x : 2.0;
  float s1 = (ey.y > 1e-6 && ey.y < 1.0 - 1e-6) ? ey.y : 2.0;
  float run = 0.0, prev = 0.0;
  if (s0 < 1.5) { run += aacBezMonoContrib(CX, CY, F0, F1, prev, s0, q0, q1); prev = s0; }
  if (s1 < 1.5) { run += aacBezMonoContrib(CX, CY, F0, F1, prev, s1, q0, q1); prev = s1; }
  return run + aacBezMonoContrib(CX, CY, F0, F1, prev, 1.0, q0, q1);
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

float aacQuadContrib(vec2 P0, vec2 P1, vec2 P2, float q0, float q1) {
  if (max(P0.y, max(P1.y, P2.y)) <= q0 ||
      min(P0.y, min(P1.y, P2.y)) >= q1) return 0.0;
  if (min(P0.x, min(P1.x, P2.x)) >= 1.0) return aacRightD(P0.y, P2.y, q0, q1);
  return aacCurveContrib(aacQuadCoeff(P0.x, P1.x, P2.x),
                         aacQuadCoeff(P0.y, P1.y, P2.y), q0, q1);
}
float aacCubicContrib(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float q0, float q1) {
  if (max(max(P0.y, P1.y), max(P2.y, P3.y)) <= q0 ||
      min(min(P0.y, P1.y), min(P2.y, P3.y)) >= q1) return 0.0;
  if (min(min(P0.x, P1.x), min(P2.x, P3.x)) >= 1.0) return aacRightD(P0.y, P3.y, q0, q1);
  return aacCurveContrib(aacCubicCoeff(P0.x, P1.x, P2.x, P3.x),
                         aacCubicCoeff(P0.y, P1.y, P2.y, P3.y), q0, q1);
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

float aacTrigF(vec3 X, vec3 Y, float th) {
  float c = cos(th), s = sin(th);
  return X.x * (Y.y * c + Y.z * s)
       + (X.z * Y.z - X.y * Y.y) * 0.5 * s * s
       + (X.y * Y.z - X.z * Y.y) * 0.5 * th
       + (X.y * Y.z + X.z * Y.y) * 0.5 * s * c;
}

float aacTrigSolve(float C, float R, float phi, float V, float a, float b) {
  float r = clamp((V - C) / max(R, 1e-9), -1.0, 1.0);
  float ac = acos(r);
  float lo = min(a, b), hi = max(a, b);
  for (int k = 0; k < 2; k++) {
    float th = phi + (k == 0 ? ac : -ac);
    th += ceil((lo - th) / TWO_PI) * TWO_PI;
    if (th <= hi + 1e-4) return clamp(th, lo, hi);
  }
  return 0.5 * (lo + hi);
}

float aacArcZoneI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xm = aacTrigEvalR(X.x, RX, pX, 0.5 * (a + b));
  if (xm <= 0.0) return 0.0;
  if (xm >= 1.0) return aacTrigEvalR(Y.x, RY, pY, b) - aacTrigEvalR(Y.x, RY, pY, a);
  return aacTrigF(X, Y, b) - aacTrigF(X, Y, a);
}

float aacArcXMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xa = aacTrigEvalR(X.x, RX, pX, a), xb = aacTrigEvalR(X.x, RX, pX, b);
  float xlo = min(xa, xb), xhi = max(xa, xb);
  if (xhi <= 0.0) return 0.0;
  if (xlo >= 1.0) return aacTrigEvalR(Y.x, RY, pY, b) - aacTrigEvalR(Y.x, RY, pY, a);
  if (xlo >= 0.0 && xhi <= 1.0) return aacTrigF(X, Y, b) - aacTrigF(X, Y, a);
  bool h0 = (xlo < 0.0 && xhi > 0.0);
  bool h1 = (xlo < 1.0 && xhi > 1.0);
  float t0 = h0 ? aacTrigSolve(X.x, RX, pX, 0.0, a, b) : a;
  float t1 = h1 ? aacTrigSolve(X.x, RX, pX, 1.0, a, b) : a;
  bool fwd = b > a;
  float acc = 0.0, prev = a;
  if (h0 && h1) {
    float m0 = fwd ? min(t0, t1) : max(t0, t1);
    float m1 = fwd ? max(t0, t1) : min(t0, t1);
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m0); prev = m0;
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m1); prev = m1;
  } else if (h0 || h1) {
    float m = h0 ? t0 : t1;
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m); prev = m;
  }
  return acc + aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, b);
}

float aacArcMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b) {
  vec2 ex = aacPhaseExtrema(pX, min(a, b), max(a, b));
  float g0 = ex.x, g1 = ex.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = b > a;
  float acc = 0.0, prev = a;
  if (n == 1) { acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, g0); prev = g0; }
  else if (n == 2) {
    float m0 = fwd ? g0 : g1, m1 = fwd ? g1 : g0;
    acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, m0); prev = m0;
    acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, m1); prev = m1;
  }
  return acc + aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, b);
}

float aacArcMonoContrib(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float q0, float q1) {
  float ya = aacTrigEvalR(Y.x, RY, pY, a), yb = aacTrigEvalR(Y.x, RY, pY, b);
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  float uA = inc ? ((ya >= q0) ? a : aacTrigSolve(Y.x, RY, pY, q0, a, b))
                 : ((ya <= q1) ? a : aacTrigSolve(Y.x, RY, pY, q1, a, b));
  float uB = inc ? ((yb <= q1) ? b : aacTrigSolve(Y.x, RY, pY, q1, a, b))
                 : ((yb >= q0) ? b : aacTrigSolve(Y.x, RY, pY, q0, a, b));
  if (abs(uB - uA) < 1e-12) return 0.0;
  return -aacArcMonoI2(X, Y, RX, pX, RY, pY, uA, uB);
}

float aacArcContrib(vec4 d1, vec4 d2, vec2 c, vec2 px, float q0, float q1) {
  float dth = d2.y - d2.x;
  if (abs(dth) < 1e-9) return 0.0;
  float sp = sin(d2.z), cp = cos(d2.z);
  float th0 = d2.x, th1 = d2.y;
  vec3 X = vec3((d1.x - c.x) * px.x + 0.5,  px.x * cp * d1.z, -px.x * sp * d1.w);
  vec3 Y = vec3((d1.y - c.y) * px.y + 0.5,  px.y * sp * d1.z,  px.y * cp * d1.w);

  float Ry = abs(Y.y) + abs(Y.z);
  if (Y.x + Ry <= q0 || Y.x - Ry >= q1) return 0.0;

  float Rx = abs(X.y) + abs(X.z);
  if (X.x + Rx <= 0.0) return 0.0;
  if (X.x - Rx >= 1.0)
    return aacRightD(aacTrigEval(Y, th0), aacTrigEval(Y, th1), q0, q1);

  float RX = sqrt(X.y * X.y + X.z * X.z), pX = atan(X.z, X.y);
  float RY = sqrt(Y.y * Y.y + Y.z * Y.z), pY = atan(Y.z, Y.y);

  vec2 ey = aacPhaseExtrema(pY, min(th0, th1), max(th0, th1));
  float g0 = ey.x, g1 = ey.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;

  {
    float ya = aacTrigEvalR(Y.x, RY, pY, th0), yb = aacTrigEvalR(Y.x, RY, pY, th1);
    float ymin = min(ya, yb), ymax = max(ya, yb);
    if (n >= 1) { float v = aacTrigEvalR(Y.x, RY, pY, g0); ymin = min(ymin, v); ymax = max(ymax, v); }
    if (n >= 2) { float v = aacTrigEvalR(Y.x, RY, pY, g1); ymin = min(ymin, v); ymax = max(ymax, v); }
    if (ymax <= q0 || ymin >= q1) return 0.0;
  }

  bool fwd = dth > 0.0;
  float run = 0.0, prev = th0;
  if (n == 1) { run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, g0, q0, q1); prev = g0; }
  else if (n == 2) {
    float m0 = fwd ? g0 : g1, m1 = fwd ? g1 : g0;
    run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, m0, q0, q1); prev = m0;
    run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, m1, q0, q1); prev = m1;
  }
  return run + aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, th1, q0, q1);
}

#endif

float aacFold(float run, bool evenOdd) {
  if (!evenOdd) return min(abs(run), 1.0);
  float m = run - 2.0 * floor(run * 0.5);
  float cc = m <= 1.0 ? m : 2.0 - m;
  return clamp(cc, 0.0, 1.0);
}

float aacWalkBand(ivec2 gl, int bandY, vec2 c, vec2 px, float xBreak, float q0, float q1) {
  int hdr = bandY * 2;
  vec4 cnts = bFetch(bLoc(gl, hdr));
  int nLine = int(cnts.x), nQuad = int(cnts.y), nCubic = int(cnts.z), nArc = int(cnts.w);
  int arrIdx = int(bFetch(bLoc(gl, hdr + 1)).x);
  int hOff = 0;
  float run = 0.0;

#ifndef MANTLE_NO_LINE
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    run += aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), q0, q1);
  }
#endif
  hOff += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < 1024; i++) {
    if (i >= nQuad) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 p3  = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    run += aacQuadContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p3, c, px), q0, q1);
  }
#endif
  hOff += nQuad;
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < 1024; i++) {
    if (i >= nCubic) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec4 p34 = texFetch(ivec2(sL.x + 2, sL.y));
    run += aacCubicContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p34.xy, c, px), aacPL(p34.zw, c, px), q0, q1);
  }
#endif
  hOff += nCubic;
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < 1024; i++) {
    if (i >= nArc) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 d1 = texFetch(ivec2(sL.x + 1, sL.y));
    vec4 d2 = texFetch(ivec2(sL.x + 2, sL.y));
    run += aacArcContrib(d1, d2, c, px, q0, q1);
  }
#endif
  return run;
}

float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));

  float hy = 0.5 / max(abs(px.y), 1e-12);
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

  for (int bi = 0; bi < 96; bi++) {
    int bandY = b0 + bi * bandStride;
    if (bandY > b1) break;
    float q0 = 0.0, q1 = 1.0;
    if (!pairCovers) {

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

#endif

float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  vec4 exInfo;
  vec2 slInfo;
  vec4 L = fillLinear(c, px, GD, shapeBB, exInfo, slInfo);
  float wsum = max(L.z + L.w, 1.0 / 65536.0);

  float mag = max(abs(L.x * L.z + L.y * L.w) / wsum, min(abs(L.x), abs(L.y)));

  float est = evenOdd ? (1.0 - abs(1.0 - fract(mag * 0.5) * 2.0)) : clamp(mag, 0.0, 1.0);

#ifdef MANTLE_EXACT_EDGE
  if (exInfo.w == 1.0 && (evenOdd || mag < 1.25)) {
    float _L = max(length(exInfo.xy), 1e-9);
    float ec = exactBoxCov(exInfo.xy / _L, exInfo.z / _L);
    return (abs(ec - est) <= abs((1.0 - ec) - est)) ? ec : 1.0 - ec;
  }
#endif
#ifdef MANTLE_SLOPE_AA

  if ((evenOdd || mag < 1.25) && est > 0.002 && est < 0.998
      && abs(slInfo.x) < 8.0 && abs(slInfo.y) < 8.0) {
    vec2 n0 = vec2(slInfo.y, slInfo.x);
    float L0 = length(n0);
    if (L0 > 1e-6) {
      vec2 n = n0 / L0;
      float d = slInfo.x * slInfo.y / L0;
      float cH = clamp(abs(L.x), 0.0, 1.0), cV = clamp(abs(L.y), 0.0, 1.0);
      float pH = clamp(0.5 + (n.x > 0.0 ? slInfo.x : -slInfo.x), 0.0, 1.0);
      float pV = clamp(0.5 + (n.y > 0.0 ? slInfo.y : -slInfo.y), 0.0, 1.0);
      float e1 = abs(pH - cH) + abs(pV - cV);
      float e2 = abs(1.0 - pH - cH) + abs(1.0 - pV - cV);
      if (min(e1, e2) < 0.02) {
        float ec = exactBoxCov(n, d);
        return e1 <= e2 ? ec : 1.0 - ec;
      }
    }
  }
#endif
  return est;
}

vec2 transformClipCoord(vec2 emCoord, int row) {

#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return emCoord;
#else
  if (uHasOverrides != 1) return emCoord;
  vec4 ovAff = texelFetch(uOverrideTex, ivec2(OV_AFFINE, row), 0);
  vec4 ovP   = texelFetch(uOverrideTex, ivec2(OV_POS_VIS, row), 0);

  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;
  if (abs(det) < 1e-12) return emCoord;
  float invDet = 1.0 / det;
  vec2 d = emCoord - ovP.xy;
  return vec2(invDet * ( ovAff.w * d.x - ovAff.y * d.y),
              invDet * (-ovAff.z * d.x + ovAff.x * d.y));
#endif
}

void main() {
  int row = uMaskChildRow1Based - 1;
  if (row < 0) discard;
  vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, row), 0);
  vec4 cFill  = texelFetch(uMetaTex, ivec2(MT_FILL, row), 0);
  vec4 cStroke = texelFetch(uMetaTex, ivec2(MT_STROKE, row), 0);
  vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, row), 0);
  vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, row), 0);
  vec4 cCapJoin = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, row), 0);
  vec4 cGrad7 = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, row), 0);
  vec4 cIso   = texelFetch(uMetaTex, ivec2(MT_FILTER_BLEND, row), 0);
  vec4 cImgRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, row), 0);
  vec4 cAtlas   = texelFetch(uMetaTex, ivec2(MT_ATLAS, row), 0);
  int  cFillGradId   = int(cGrad7.x + 0.5);
  int  cStrokeGradId = int(cGrad7.y + 0.5);
  int  cImgId        = int(cIso.w + 0.5);
  float cSW          = cStrokePad.x;
  ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                    int(cGlyph.z), int(cGlyph.w));
  bool cEvenOdd = cStrokePad.y > 0.5;

  vec2 ePx   = max(fwidth(vEmCoord), vec2(1e-6));
  vec2 pxInv = 1.0 / ePx;

  vec2 sCoord = transformClipCoord(vEmCoord, row);

  float cov;
  vec4 paint;
  if (cSW > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {

    int   cDashId   = int(cStrokePad.w + 0.5);
    int   startCap  = int(cCapJoin.x + 0.5);
    int   joinStyle = int(cCapJoin.y + 0.5);
    float miterLim  = cCapJoin.z;
    int   endCapEnc = int(texelFetch(uMetaTex, ivec2(MT_PRIM, row), 0).z + 0.5);
    int   endCap    = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
    float halfW     = cSW * 0.5;
    float minD = strokeMinDist(sCoord, cGD, cBB, halfW,
                                   startCap, endCap,
                                   joinStyle, miterLim, cDashId);
    float pxSize    = 0.5 * (ePx.x + ePx.y);
    float halfWMin  = 0.5 * pxSize;
    float halfWVis  = max(halfW, halfWMin);
    float weightFade = halfW / halfWVis;
    float distFromEdge = minD - halfWVis;
    cov = (distFromEdge <= 0.5 * pxSize)
      ? clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0) * weightFade
      : 0.0;
    paint = (cStrokeGradId > 0)
      ? sampleGradient(cStrokeGradId, sCoord, cBB)
      : cStroke;
  } else {
    cov = renderFill(sCoord, pxInv, cGD, cEvenOdd, cBB);
    if (cImgId > 0) {
      paint = sampleChildImage(sCoord, cImgRect, cAtlas);
    } else if (cFillGradId > 0) {
      paint = sampleGradient(cFillGradId, sCoord, cBB);
    } else {
      paint = cFill;
    }
  }

  if (cov <= 0.0) discard;

  int innerMaskId = int(cGrad7.w + 0.5);
  if (innerMaskId > 0 && innerMaskId != uMaskOwnRow) {
    int innerLayer = texelFetch(uMaskRowToLayerTexBake, ivec2(MRL_ROW, innerMaskId - 1), 0).r;
    if (innerLayer >= 0) {
      vec2 muv = gl_FragCoord.xy / uViewportSize;
      cov *= clamp(texture(uMaskRTArrayPong, vec3(muv, float(innerLayer))).r, 0.0, 1.0);
      if (cov <= 0.0) discard;
    }
  }
  float weight = (uMaskIsLuminance != 0)
    ? dot(paint.rgb, vec3(0.2126, 0.7152, 0.0722)) * paint.a
    : paint.a;
  float a = cov * weight;
  fragColor = vec4(a, a, a, a);
}
