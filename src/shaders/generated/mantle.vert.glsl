#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aNormal;

layout(location=2) in vec2 aEmCoord;

#ifdef MANTLE_LB_CURVE_TEX
layout(location=7) in vec2 aIdxPair;
#define aShapeIdx aIdxPair.x
#define aCurveIdx aIdxPair.y
#else
layout(location=7) in float aShapeIdx;
#endif

invariant gl_Position;
out vec2 vEmCoord;
flat out vec4 vAffineFootprint;
out vec4 vOverrideTint;
#ifdef MANTLE_INSTANCED
out vec4 vInstBias;
#endif

flat out int vOverrideMask;
out vec4 vOverrideFill;
out vec4 vOverrideStroke;
out float vOverrideStrokeWidth;
flat out int vInst;
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

uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
uniform vec2 uViewportSize;
uniform float uNumShapes;

uniform int uShapeIdxOverride;

uniform int uHasEmCoord;

uniform sampler2D uOverrideTex;
uniform int uHasOverrides;

uniform float uDrawAlpha;
#ifndef MANTLE_NO_FILTER
uniform float uFilterInputScale;
#endif

uniform mat3 uWorldM;
uniform int uHasWorldM;

#ifdef MANTLE_LB_FILL

#ifdef MANTLE_LB_CURVE_TEX

uniform highp sampler2D uCurveCoefTex;
uniform int uCurveCoefW;
vec4 lbCoefAt(float blockIdx, int i) {
  int t = int(blockIdx + 0.5) * 4 + i;
  return texelFetch(uCurveCoefTex, ivec2(t % uCurveCoefW, t / uCurveCoefW), 0);
}
#else
layout(location=3) in vec4 aC0;
layout(location=4) in vec4 aC1;
layout(location=5) in vec4 aC2;
layout(location=6) in vec4 aC3;
#endif
layout(location=14) in vec3 aLbTC;

layout(location=15) in vec3 aLbMeta;
#define MANTLE_IS_LB_VERT (aLbMeta.x > 0.5)

#define aFlags vec2(aLbMeta.x - 1.0, aLbMeta.y)
#define aSeamM aLbMeta.z
#ifdef MANTLE_LB_MORPH

layout(location=8)  in vec2 aPosB;
layout(location=9)  in vec3 aLbTCB;
#ifdef MANTLE_LB_CURVE_TEX
layout(location=10) in float aCurveIdxB;
#else
layout(location=10) in vec4 aC0B;
layout(location=11) in vec4 aC1B;
layout(location=12) in vec4 aC2B;
layout(location=13) in vec4 aC3B;
#endif
uniform float uMorphT;

float lbMixHalfUnit(float a, float b, float t) {
  vec2 n = mix(unpackHalf2x16(floatBitsToUint(a)), unpackHalf2x16(floatBitsToUint(b)), t);
  float L = length(n);
  return uintBitsToFloat(packHalf2x16(L > 0.0 ? n / L : n));
}
#endif

#ifdef MANTLE_LB_FILL
#ifdef MANTLE_LB_CURVE_TEX
#define LB_C0 lbCoefAt(aCurveIdx, 0)
#define LB_C1 lbCoefAt(aCurveIdx, 1)
#define LB_C2 lbCoefAt(aCurveIdx, 2)
#define LB_C3 lbCoefAt(aCurveIdx, 3)
#define LB_C0B lbCoefAt(aCurveIdxB, 0)
#define LB_C1B lbCoefAt(aCurveIdxB, 1)
#define LB_C2B lbCoefAt(aCurveIdxB, 2)
#define LB_C3B lbCoefAt(aCurveIdxB, 3)
#else
#define LB_C0 aC0
#define LB_C1 aC1
#define LB_C2 aC2
#define LB_C3 aC3
#define LB_C0B aC0B
#define LB_C1B aC1B
#define LB_C2B aC2B
#define LB_C3B aC3B
#endif
#endif
#define LB_FLAT flat out
#define LB_SMOOTH out

#define LBK_INTERIOR     0.0
#define LBK_CUBIC        2.0
#define LBK_CUBIC_BEZ    4.0
#define LBK_ARC          5.0
#define LBK_DISC         7.0
#define LBK_EDGE_STRIP  10.0
#define LBK_CURVE_BAND  12.0
#define LBK_CHAIN_STRIP 13.0

#define LB_IS(k)         (vKind > (k) - 0.5 && vKind < (k) + 0.5)
#define LB_IS_INTERIOR   (vKind < LBK_INTERIOR + 0.5)
#define LB_IS_CUBIC      LB_IS(LBK_CUBIC)
#define LB_IS_ARC        LB_IS(LBK_ARC)
#define LB_IS_DISC_ANY   (vKind > 5.5 && vKind < LBK_DISC + 0.5)
#define LB_IS_EDGE_STRIP LB_IS(LBK_EDGE_STRIP)
#define LB_IS_CURVE_BAND LB_IS(LBK_CURVE_BAND)
#define LB_IS_CHAIN_STRIP LB_IS(LBK_CHAIN_STRIP)

LB_FLAT vec4 vLB0;
LB_FLAT vec4 vLB1;
LB_FLAT vec4 vLB2;
LB_FLAT vec4 vLB3;
LB_SMOOTH vec3 vTC;
LB_FLAT float vKind;
LB_FLAT float vSign;
LB_FLAT float vEmPerPx;
LB_FLAT float vSeam;

#define cM00   vLB0.xyz
#define cM01   vec3(vLB0.w, vLB1.xy)
#define cM02   vec3(vLB1.zw, vLB2.x)
#define cM11a  vLB2.y
#define cM12   vLB2.z
#define cM22   vLB2.w

#define vCh2A  vLB1

#define cBoxA  vLB1.xy
#define cBoxU  vLB1.zw
#define cBoxV  vLB2.xy
#define vCh2B  vLB2

#define vNa    vLB0.xy
#define vNb    vLB0.zw
#define vLine2 vLB0.xyz
#define vLineT vLB0.w

#define cCen   vLB3.xy
#define cScale vLB3.z
#define cHalf  vLB3.w

const float LB_COV_WROTE_O = -2.0;
#define LBCOV_OUT(c) (c)

#undef LB_FLAT
#undef LB_SMOOTH

float emPerPxFor(vec2 dirEm, float basePx) {
  if (uHasWorldM == 0) return basePx;
  vec2 c0 = vec2(uWorldM[0][0], uWorldM[0][1]);
  vec2 c1 = vec2(uWorldM[1][0], uWorldM[1][1]);
  float l0 = length(c0), l1 = length(c1);
  float dm = max(abs(dirEm.x), abs(dirEm.y));
  if (!(dm > 0.0) ||
      (abs(l1 - l0) <= 1e-4 * max(l0, l1) && abs(dot(c0, c1)) <= 1e-4 * (l0 * l1)))
    return basePx / max(l0, 1e-30);
  vec2 u = dirEm / dm;
  vec2 pd = vec2(u.x, -u.y) / length(u);
  return basePx / max(length(c0 * pd.x + c1 * pd.y), 1e-30);
}

#ifndef CP_STREAM_TAG
#define CP_STREAM_TAG    14.0
#endif

#ifdef MANTLE_CPATCH

vec2 gCpLocal = vec2(0.0);
vec2 gCpPixelX=vec2(0.0),gCpPixelY=vec2(0.0);
bool gCpPixelValid=false;
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA

float gCpAreaEpp = 0.0;
#endif

vec2 cpatchVertexSetup(vec2 aPos, vec3 aTC, vec4 cell, float basePx, out float emPerPxOut) {

  float epp = emPerPxFor(aTC.xy, basePx);
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
  if (aTC.z > 1500.0 && aTC.z < 2500.0) epp = gCpAreaEpp;
#endif
  emPerPxOut = epp;

  gCpLocal = aPos + aTC.xy * (1.5 * epp);
  if(aTC.z>2999.5 && aTC.z<3000.5 && gCpPixelValid)
    gCpLocal=aPos+((abs(gCpPixelX)+abs(gCpPixelY))*aTC.xy)*(0.5+1.0/256.0);
  return gCpLocal;
}
#endif

vec2 lbUnpackKlmGrad(float f) {
  uint u = floatBitsToUint(f);
  float s = uintBitsToFloat(u & 0x7F800000u) * (1.0 / 1024.0);
  vec2 d = vec2(float((u >> 12) & 0x7FFu), float((u >> 1) & 0x7FFu)) * s;
  return vec2((u & 0x80000000u) != 0u ? -d.x : d.x, (u & 1u) != 0u ? -d.y : d.y);
}
#ifdef MANTLE_LB_MORPH

float lbPackKlmGrad(vec2 d) {
  vec2 a = abs(d);
  uint E = floatBitsToUint(max(a.x, a.y)) & 0x7F800000u;

  if (E == 0u || E == 0x7F800000u) return 0.0;

  float s = uintBitsToFloat(E);
  uint mk = min(uint(a.x / s * 1024.0 + 0.5), 2047u), ml = min(uint(a.y / s * 1024.0 + 0.5), 2047u);
  return uintBitsToFloat((d.x < 0.0 ? 0x80000000u : 0u) | E | (mk << 12) | (ml << 1) | (d.y < 0.0 ? 1u : 0u));
}
float lbMixKlmGrad(float a, float b, float t) {
  return lbPackKlmGrad(mix(lbUnpackKlmGrad(a), lbUnpackKlmGrad(b), t));
}
#endif

float lbBoxReach(vec2 n, float basePx) {
  if (uHasWorldM == 0) return 0.5 * basePx * (abs(n.x) + abs(n.y));
  mat2 W = mat2(uWorldM[0].xy, uWorldM[1].xy);
  mat2 Fy = mat2(1.0, 0.0, 0.0, -1.0);
  mat2 C = (Fy * W * Fy) * (1.0 / basePx);
  vec2 w = transpose(inverse(C)) * n;
  return 0.5 * (abs(w.x) + abs(w.y));
}

float lbBandReach(vec2 v, float basePx) {
  float L = length(v);
  if (!(L > 0.0)) return 0.0;
  vec2 u = v / L;
  float c = 1.0 / max(L, 1.0), s = sqrt(max(1.0 - c * c, 0.0));
  return max(lbBoxReach(vec2(c * u.x - s * u.y, s * u.x + c * u.y), basePx),
             lbBoxReach(vec2(c * u.x + s * u.y, -s * u.x + c * u.y), basePx));
}

#ifdef MANTLE_NO_BEZOUT
vec2 lbVertexSetup(vec2 aPos, vec3 aTC, vec4 aC0, vec4 aC3) {
#else
vec2 lbVertexSetup(vec2 aPos, vec3 aTC, vec4 aC0, vec4 aC1, vec4 aC2, vec4 aC3) {
#endif
  vTC = aTC;
  vKind = aFlags.x;
  vSign = aFlags.y;
  vSeam = aSeamM;

  vLB0 = aC0;
  vLB3 = aC3;
#ifndef MANTLE_NO_BEZOUT
  vLB1 = aC1;
  vLB2 = aC2;

#endif

#ifndef LB_DISC_PUSH
#define LB_DISC_PUSH 2.0
#endif
#ifndef LB_STRIP_NEXT
#define LB_STRIP_NEXT 0.8
#endif
#ifndef LB_KLM_RING
#define LB_KLM_RING 0.25
#endif
#ifndef LB_BEZ_RING
#define LB_BEZ_RING 0.25
#endif
  float basePx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);

  vEmPerPx = emPerPxFor(aTC.x > 1.5 ? vec2(0.0) : aC3.xy, basePx);
  vec2 emPos = aPos;
  if (aFlags.x > 3.5 && aFlags.x < 4.5) {

    vEmPerPx = emPerPxFor(aPos - cCen, basePx);

    if (aSeamM > 5.0) {
      vec2 n4 = unpackHalf2x16(floatBitsToUint(aC3.w));
#ifdef MANTLE_LB_MORPH
      if (dot(n4, n4) > 0.0) emPos += n4 * (LB_BEZ_RING * emPerPxFor(n4, basePx));
#else

      if (dot(n4, n4) > 0.0) {
        vec2 u4 = normalize(n4);
        vEmPerPx = dot(u4, aPos);
        emPos += u4 * lbBoxReach(u4, basePx);
      }
#endif

      if (aSeamM > 9.5) vEmPerPx = emPerPxFor(vec2(0.0), basePx);
    }
#ifdef MANTLE_CPATCH
  } else if (aFlags.x > CP_STREAM_TAG - 0.5 && aFlags.x < CP_STREAM_TAG + 0.5) {

    emPos = cpatchVertexSetup(aPos, aTC, aC0, basePx, vEmPerPx);
#endif
  } else if (aFlags.x > 6.5 && aFlags.x < 7.5) {

    vec2 out7 = aPos - aC3.xy;
    float L7 = max(length(out7), 1e-30);
    vEmPerPx = emPerPxFor(out7, basePx);
    emPos = aPos + (out7 / L7) * (LB_DISC_PUSH * emPerPxFor(out7, basePx));
  } else if (aFlags.x > 9.5 && aFlags.x < 10.5) {

    vec2 p1k = aC3.xy, p2k = vec2(aC3.z, aC3.w);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-30);
    vec2 nOutk = vec2(-tdk.y, tdk.x) * aFlags.y;
    float tR = mod(aTC.x, 2.0), sR = floor(aTC.x / 2.0 + 0.25);
    vec2 basek = tR < 0.5 ? p1k : p2k;
    vEmPerPx = emPerPxFor(nOutk, basePx);

    float tExt = 3.2, nExt = LB_STRIP_NEXT;
    if (sR >= 0.5) {
      float codeA10 = floor((aSeamM + 0.5) / 16.0), codeB10 = aSeamM - codeA10 * 16.0;
      float code10 = tR < 0.5 ? codeA10 : codeB10;
      float ty10 = floor((code10 + 0.5) / 4.0) - 1.0;
      bool curve10 = mod(code10, 4.0) >= 1.5;
      if (ty10 > 0.5 && !curve10) {
        vec2 nN10 = tR < 0.5 ? aC0.xy : aC0.zw;
        float nDot10 = dot(nOutk, nN10);
        if (nDot10 < -0.35) {
          float boost10 = 1.0 + 0.55 * clamp(-0.35 - nDot10, 0.0, 1.35);
          tExt *= boost10;
          nExt *= boost10;
        }
      }
    }

    emPos = basek + tdk * ((tR < 0.5 ? -tExt : tExt) * (sR < 0.5 ? 0.0 : emPerPxFor(tdk, basePx))) + nOutk * ((sR < 0.5 ? 0.0 : nExt) * emPerPxFor(nOutk, basePx));
  } else if (aFlags.x > 11.5 && aFlags.x < 12.5) {

#ifdef MANTLE_LB_MORPH

    bool quadBand12 = abs(aFlags.y) < 8192.0;
    float amt12 = quadBand12 ? lbBandReach(aC0.xy, basePx) : LB_KLM_RING * emPerPxFor(aC0.xy, basePx);
    vLB0 = quadBand12 ? vec4(0.0, 0.0, 0.0, 2.0) : vec4(0.0);
#else

    float L12 = length(aC0.xy);
    float amt12 = lbBandReach(aC0.xy, basePx);
    vLB0 = abs(aFlags.y) >= 8192.0 ? vec4(L12 > 0.0 ? aC0.xy / L12 : vec2(0.0), aSeamM, 1.0) : vec4(0.0, 0.0, 0.0, 2.0);
#endif
    vEmPerPx = emPerPxFor(aC0.xy, basePx);
    emPos = aPos + aC0.xy * amt12;
    if (abs(aFlags.y) >= 8192.0) {
      vec2 dkl12 = lbUnpackKlmGrad(aC0.z);
      vTC = aTC + vec3(dkl12, aC0.w) * amt12;
    } else {

      vTC = vec3(aTC.xy + aC0.zw * amt12, aTC.z + aSeamM * (aC0.z - aC0.w) * amt12);
    }
  }
  return emPos;
}

#endif

#ifdef MANTLE_COMPOSED

uniform vec4 uCoverBBox;
#endif

#ifdef MANTLE_INSTANCED
layout(location=8)  in vec3 aInstW0;
layout(location=9)  in vec3 aInstW1;
layout(location=10) in vec3 aInstW2;
layout(location=11) in float aInstAlpha;

layout(location=12) in vec4 aInstTint;

layout(location=13) in vec4 aInstBias;
#endif

vec4 emRow0() {
  float sx = uCanvasAR.x * 2.0 / uGlobalBBox.z;
  return vec4(sx, 0.0, 0.0, -uCanvasAR.x - 2.0 * uGlobalBBox.x * uCanvasAR.x / uGlobalBBox.z);
}
vec4 emRow1() {
  float sy = -uCanvasAR.y * 2.0 / uGlobalBBox.w;
  return vec4(0.0, sy, 0.0, uCanvasAR.y + 2.0 * uGlobalBBox.y * uCanvasAR.y / uGlobalBBox.w);
}
vec4 emRow3() {

  return vec4(0.0, 0.0, 0.0, 1.0);
}

uniform int uCoverAaReach;

vec2 coverQuadDilate(vec2 emPos, vec2 normal,
                vec4 m0, vec4 m1, vec4 m3,
                vec2 viewportPx) {
  if (dot(normal, normal) < 1e-12) return vec2(0.0);
  vec2 nHat = normalize(normal);
  float s = dot(m3.xy, emPos) + m3.w;
  float t = dot(m3.xy, nHat);
  float u = (s * dot(m0.xy, nHat) - t * (dot(m0.xy, emPos) + m0.w)) * viewportPx.x;
  float v = (s * dot(m1.xy, nHat) - t * (dot(m1.xy, emPos) + m1.w)) * viewportPx.y;
  float s2 = s * s;
  float st = s * t;
  float uv = u * u + v * v;
  float denom = uv - st * st;

  if (abs(denom) <= 1.1920929e-7 * (uv + st * st)) return vec2(0.0);
  float d = s2 * (st + sqrt(uv)) / denom;

  if (uCoverAaReach == 1) {
    float len = sqrt(uv);
    if (len > 0.0) d *= 1.41421356 * max(abs(u), abs(v)) / len;
  }
  return normal * d;
}

#if defined(MANTLE_LB_FILL) && !defined(MANTLE_LB_NO_EDGE_STRIP)

mat3 lbEmToClipH(vec4 r0, vec4 r1, mat2 ovB, vec2 ovP, mat3 wM, int hasWM, int shapeIdx) {
  mat3 H = mat3(r0.x, 0.0, 0.0,  0.0, r1.y, 0.0,  r0.w, r1.w, 1.0);
  if (uHasOverrides == 1) H = H * mat3(ovB[0].x, ovB[0].y, 0.0,  ovB[1].x, ovB[1].y, 0.0,  ovP.x, ovP.y, 1.0);
  if (hasWM == 1) {
    int fl = int(texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, shapeIdx), 0).w + 0.5);
    if ((fl & (1024 | 2048 | 4096)) != 0) {
      vec4 bb = texelFetch(uMetaTex, metaAt(MT_BBOX, shapeIdx), 0);
      vec2 aUV = (vec2((bb.x + bb.z) * 0.5, (bb.y + bb.w) * 0.5) - uGlobalBBox.xy) / uGlobalBBox.zw;
      vec2 aPl = (aUV * 2.0 - 1.0) * uCanvasAR, ac = vec2(aPl.x, -aPl.y);
      float m00 = wM[0][0], m10 = wM[0][1];
      float sc = max(sqrt(m00 * m00 + m10 * m10), 1e-30);
      vec2 effS = (fl & 1024) != 0 ? vec2(1.0) : vec2(sc);
      mat2 effR = (fl & 2048) != 0 ? mat2(1.0) : mat2(m00 / sc, m10 / sc, -m10 / sc, m00 / sc);
      vec2 effT = (fl & 4096) != 0 ? vec2(0.0) : wM[2].xy;
      mat2 A = effR * mat2(effS.x, 0.0, 0.0, effS.y);
      H = mat3(vec3(A[0], 0.0), vec3(A[1], 0.0), vec3(ac + effT - A * ac, 1.0)) * H;
    } else {
      H = wM * H;
    }
  }
  return H;
}

vec4 lbCornerPlanePx(vec2 c, vec2 w, mat3 H) {
  if (!(dot(w, w) > 0.0)) return vec4(0.0);
  vec3 ch = H * vec3(c, 1.0), mh = H * vec3(-w.y, w.x, 0.0), wh = H * vec3(w, 0.0);
  vec2 hv = 0.5 * uViewportSize, cn = ch.xy / ch.z;
  vec2 dm = (mh.xy - cn * mh.z) / ch.z * hv, dw = (wh.xy - cn * wh.z) / ch.z * hv;
  vec2 n = vec2(-dm.y, dm.x);
  return vec4(cn * hv + hv, dot(n, dw) < 0.0 ? -n : n);
}
#endif

void main() {
  vAffineFootprint = vec4(0.0);
  int shapeIdx = (uShapeIdxOverride >= 0) ? uShapeIdxOverride : int(aShapeIdx + 0.5);
  vInst = shapeIdx;

#ifdef MANTLE_INSTANCED
  mat3  wWorldM    = mat3(aInstW0, aInstW1, aInstW2);
  int   wHasWorldM = 1;
  float wDrawAlpha = aInstAlpha;
  vec4  wDrawTint  = aInstTint;
  vInstBias        = aInstBias;
#else
  mat3  wWorldM    = uWorldM;
  int   wHasWorldM = uHasWorldM;
  float wDrawAlpha = uDrawAlpha;
  vec4  wDrawTint  = vec4(1.0);
#endif

  vec2 ovPos = vec2(0.0);
  mat2 ovBasis = mat2(1.0, 0.0, 0.0, 1.0);
  float ovVis = 1.0;
  vec4 ovTint = vec4(1.0);
  int ovMask = 0;
  vec4 ovFill = vec4(0.0);
  vec4 ovStrk = vec4(0.0);
  float ovStrkW = 0.0;
  if (uHasOverrides == 1) {
    vec4 ovAff  = texelFetch(uOverrideTex, ovAt(OV_AFFINE, shapeIdx), 0);
    vec4 ovP    = texelFetch(uOverrideTex, ovAt(OV_POS_VIS, shapeIdx), 0);
    ovTint      = texelFetch(uOverrideTex, ovAt(OV_TINT, shapeIdx), 0);

    ovBasis = mat2(ovAff.x, ovAff.z,
                   ovAff.y, ovAff.w);
    ovPos = ovP.xy;
    ovVis = clamp(ovP.z, 0.0, 1.0);
    ovMask = int(ovP.w + 0.5);

    if ((ovMask & 1) != 0) ovFill   = texelFetch(uOverrideTex, ovAt(OV_FILL, shapeIdx), 0);
    if ((ovMask & 2) != 0) ovStrk   = texelFetch(uOverrideTex, ovAt(OV_STROKE, shapeIdx), 0);
    if ((ovMask & 4) != 0) ovStrkW  = texelFetch(uOverrideTex, ovAt(OV_STROKE_W, shapeIdx), 0).x;
  }

  ovTint *= wDrawTint;
  ovTint.a *= wDrawAlpha * ovVis;
#ifndef MANTLE_NO_FILTER
  ovTint.a *= uFilterInputScale > 0.0 ? uFilterInputScale : 1.0;
#endif
  vOverrideTint = ovTint;

  if (ovBasis[0][0] != 1.0 || ovBasis[0][1] != 0.0 || ovBasis[1][0] != 0.0 || ovBasis[1][1] != 1.0
      || ovPos.x != 0.0 || ovPos.y != 0.0) ovMask |= 8;
  vOverrideMask = ovMask;
  vOverrideFill = ovFill;
  vOverrideStroke = ovStrk;
  vOverrideStrokeWidth = ovStrkW;

  if (ovVis <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vEmCoord = vec2(0.0);
    return;
  }

  vec4 e0 = emRow0(), e1 = emRow1();
  vec4 m0, m1, m3;
  if (wHasWorldM == 1) {
    m0 = wWorldM[0][0] * e0 + wWorldM[1][0] * e1;  m0.w += wWorldM[2][0];
    m1 = wWorldM[0][1] * e0 + wWorldM[1][1] * e1;  m1.w += wWorldM[2][1];
    m3 = wWorldM[0][2] * e0 + wWorldM[1][2] * e1;  m3.w += wWorldM[2][2];
  } else {
    m0 = e0; m1 = e1; m3 = emRow3();
  }

  if (uHasOverrides == 1) {
    m0.xy = m0.xy * ovBasis;
    m1.xy = m1.xy * ovBasis;
  }

  vec2 lbPos = aPos;
#ifdef MANTLE_COMPOSED
  lbPos = mix(uCoverBBox.xy, uCoverBBox.zw, aPos);
#endif
  vec2 dEm = coverQuadDilate(lbPos, aNormal, m0, m1, m3, uViewportSize);

#if defined(MANTLE_AAC) || (!defined(MANTLE_NO_COVER_FILL) && (defined(MANTLE_HARD_MIXED) || defined(MANTLE_COVER_KERNEL) || (!defined(MANTLE_GWN) && !defined(MANTLE_HARD))))

  if (m3.x == 0.0 && m3.y == 0.0 && m3.w != 0.0) {
    vec2 aR0 = m0.xy * (0.5 * uViewportSize.x / m3.w), aR1 = m1.xy * (0.5 * uViewportSize.y / m3.w);
    float n0 = dot(aR0, aR0), n1 = dot(aR1, aR1), x01 = dot(aR0, aR1), dt = aR0.x * aR1.y - aR0.y * aR1.x;
    bool similar = abs(n0 - n1) <= 1e-5 * (n0 + n1) && abs(x01) <= 1e-5 * (n0 + n1);
    if (!similar && dt != 0.0) {
      float R = sqrt(n0 + n1 + 2.0 * abs(x01)) / (2.0 * abs(dt));
      float supp = dot(aNormal, aNormal) <= 2.000001 ? 1.0 : 1.41421356;
      vec2 dAff = aNormal * (R / supp);
      if (dot(dAff, dAff) > dot(dEm, dEm)) dEm = dAff;
    }
  }
#endif
  vec2 emDilated = lbPos + dEm;

  if (uHasEmCoord != 1 && aEmCoord.x > 0.5) {
    vec2 sr0 = m0.xy * (0.5 * uViewportSize.x), sr1 = m1.xy * (0.5 * uViewportSize.y);
    float sdet = sr0.x * sr1.y - sr0.y * sr1.x;
    if (abs(sdet) > 0.0 && dot(aNormal, aNormal) > 1e-12) {
      vec2 nS = normalize(aNormal);
      vec2 wS = vec2(sr1.y * nS.x - sr1.x * nS.y, -sr0.y * nS.x + sr0.x * nS.y) / sdet;
      float wl = length(wS);
      if (wl > 0.0) {
        const float support = 0.7072;
        vec2 ePxS = vec2(abs(sr1.y) + abs(sr0.y), abs(sr1.x) + abs(sr0.x)) / abs(sdet);
        float floorPush = max(0.25 * (ePxS.x + ePxS.y) - aEmCoord.y, 0.0);
        emDilated = lbPos + aNormal * ((floorPush + support * wl) * 0.70710678);
      }
    }
  }
#ifndef MANTLE_NO_STROKE

  bool widthCover = true;
#ifdef MANTLE_LB_FILL
  widthCover = !MANTLE_IS_LB_VERT;
#endif
  if (widthCover && !(uHasEmCoord != 1 && aEmCoord.x > 0.5)
      && m3.x == 0.0 && m3.y == 0.0 && m3.w != 0.0) {
    vec4 widthCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, shapeIdx), 0);
    int widthFlags = int(widthCap.w + 0.5);
    if ((widthFlags & (1 | (1 << 13) | (1 << 14))) != 0 || (ovMask & 4) != 0) {
      float nominal = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, shapeIdx), 0).x;
      float width = (ovMask & 4) != 0 ? ovStrkW : nominal;
      vec2 r0 = m0.xy * (0.5 * uViewportSize.x / m3.w), r1 = m1.xy * (0.5 * uViewportSize.y / m3.w);
      float scale0 = max(abs(r0.x),abs(r0.y)), scale1 = max(abs(r1.x),abs(r1.y));
      vec2 n0 = scale0 > 0.0 ? r0/scale0 : vec2(0.0), n1 = scale1 > 0.0 ? r1/scale1 : vec2(0.0);
      float det = n0.x*n1.y-n0.y*n1.x;
      if (det != 0.0 && width > 0.0) {
        vec2 pixel = vec2(abs(n1.y)/scale0+abs(n0.y)/scale1, abs(n1.x)/scale0+abs(n0.x)/scale1)/abs(det);
        float extra = max(0.0, 0.5*(width*strokeWidthMultiplier(widthFlags,pixel)-nominal));
        int join = int(widthCap.y + 0.5), cap = int(widthCap.x + 0.5);
        float ml = max(1.0,widthCap.z), reach = join == 0 ? ml : (join == 3 || join == 4) ? sqrt(ml*ml+1.0) : 1.0;
        int endCap = int(texelFetch(uMetaTex,metaAt(MT_PRIM,shapeIdx),0).z+0.5);
        if (cap == 2 || endCap == 3) reach = max(reach,1.41421356);

        vec2 aa = dEm;
        if (any(isnan(aa)) || any(isinf(aa)) || all(equal(aa,vec2(0.0)))) {
          float largest = max(pixel.x,pixel.y);
          float radius = 0.5*largest*length(pixel/largest);
          aa = aNormal*radius;
        }
        emDilated = lbPos+aa+aNormal*(extra*reach);
      }
    }
  }
#endif
#ifdef MANTLE_CPATCH

  if(aLbTC.z>2999.5 && aLbTC.z<3000.5 && m3.x==0.0 && m3.y==0.0 && m3.w!=0.0){
    vec2 r0=m0.xy*(0.5*uViewportSize.x/m3.w),r1=m1.xy*(0.5*uViewportSize.y/m3.w);
    float det=r0.x*r1.y-r0.y*r1.x;
    if(det!=0.0){gCpPixelX=vec2(r1.y,-r1.x)/det;gCpPixelY=vec2(-r0.y,r0.x)/det;
      gCpPixelValid=!any(isnan(gCpPixelX))&&!any(isinf(gCpPixelX))&&!any(isnan(gCpPixelY))&&!any(isinf(gCpPixelY));}
  }
#endif
#if defined(MANTLE_CPATCH) && !defined(MANTLE_CPATCH_NO_QUADRATIC_AREA)

  vec2 cpPx0=m0.xy*(0.5*uViewportSize.x),cpPx1=m1.xy*(0.5*uViewportSize.y);
  float cpDet=cpPx0.x*cpPx1.y-cpPx0.y*cpPx1.x;
  gCpAreaEpp=sqrt(dot(cpPx0,cpPx0)+dot(cpPx1,cpPx1))/max(abs(cpDet),1e-30);
#endif
#ifdef MANTLE_LB_FILL

  if (MANTLE_IS_LB_VERT) {

#ifdef MANTLE_LB_MORPH
    vec2 mPos = mix(aPos, aPosB, uMorphT);
    vec3 mTC  = mix(aLbTC, aLbTCB, uMorphT);
    vec4 c0A = LB_C0, c0B = LB_C0B, c3A = LB_C3, c3B = LB_C3B;
    vec4 mC0  = mix(c0A, c0B, uMorphT);

    if (aFlags.x > 9.5 && aFlags.x < 10.5) {
      float n0 = length(mC0.xy), n1 = length(mC0.zw);
      mC0 = vec4(n0 > 1e-6 ? mC0.xy / n0 : mC0.xy, n1 > 1e-6 ? mC0.zw / n1 : mC0.zw);
    }
    vec4 mC3  = mix(c3A, c3B, uMorphT);

    bool band12M = aFlags.x > 11.5 && aFlags.x < 12.5;
    if (band12M && abs(aFlags.y) >= 8192.0) mC0.z = lbMixKlmGrad(c0A.z, c0B.z, uMorphT);
    if (aFlags.x > 3.5 && aFlags.x < 4.5 && aSeamM > 5.0) mC3.w = lbMixHalfUnit(c3A.w, c3B.w, uMorphT);
#ifdef MANTLE_NO_BEZOUT
    emDilated = lbVertexSetup(mPos, mTC, mC0, mC3);
#else
    vec4 c2A = LB_C2, c2B = LB_C2B;
    vec4 mC2 = mix(c2A, c2B, uMorphT);
    if (band12M) { mC2.x = lbMixHalfUnit(c2A.x, c2B.x, uMorphT); mC2.y = lbMixHalfUnit(c2A.y, c2B.y, uMorphT); }
    emDilated = lbVertexSetup(mPos, mTC, mC0, mix(LB_C1, LB_C1B, uMorphT), mC2, mC3);
#endif
#else
#ifdef MANTLE_NO_BEZOUT
    emDilated = lbVertexSetup(aPos, aLbTC, LB_C0, LB_C3);
#else
    emDilated = lbVertexSetup(aPos, aLbTC, LB_C0, LB_C1, LB_C2, LB_C3);
#endif
#endif
#ifdef MANTLE_CPATCH

    if (aFlags.x > CP_STREAM_TAG - 0.5 && aFlags.x < CP_STREAM_TAG + 0.5) emDilated += LB_C2.zw;
#endif
#ifndef MANTLE_LB_NO_EDGE_STRIP

    if (aFlags.x > 9.5 && aFlags.x < 10.5) {
      vec4 cw10 = LB_C1, cc10 = LB_C2;
#ifdef MANTLE_LB_MORPH

      vec4 cw10B = LB_C1B;
      cw10 = vec4(dot(cw10.xy, cw10.xy) > 0.0 && dot(cw10B.xy, cw10B.xy) > 0.0 ? mix(cw10.xy, cw10B.xy, uMorphT) : vec2(0.0),
                  dot(cw10.zw, cw10.zw) > 0.0 && dot(cw10B.zw, cw10B.zw) > 0.0 ? mix(cw10.zw, cw10B.zw, uMorphT) : vec2(0.0));
      cc10 = mix(cc10, LB_C2B, uMorphT);
#endif
      mat3 H10 = lbEmToClipH(e0, e1, ovBasis, ovPos, wWorldM, wHasWorldM, shapeIdx);
      vLB1 = lbCornerPlanePx(cc10.xy, cw10.xy, H10);
      vLB2 = lbCornerPlanePx(cc10.zw, cw10.zw, H10);
    }
#endif
  } else {
#ifdef MANTLE_COVER_KERNEL

    vKind = -1.0 - aLbMeta.y;
#else
    vKind = -1.0;
#endif
  }
#endif

  vec2 emTransformed = (uHasOverrides == 1)
    ? ovBasis * emDilated + ovPos
    : emDilated;

  vEmCoord = (uHasEmCoord == 1) ? aEmCoord : emDilated;
#ifdef MANTLE_CPATCH

  bool cpV = MANTLE_IS_LB_VERT && aFlags.x > CP_STREAM_TAG - 0.5 && aFlags.x < CP_STREAM_TAG + 0.5;
  bool cpLocalOk = cpV && uHasOverrides != 1 && uHasEmCoord != 1;
  if (cpV) vEmCoord = cpLocalOk ? gCpLocal : vEmCoord - LB_C2.zw;
#endif

  vec2 uv = (emTransformed - uGlobalBBox.xy) / uGlobalBBox.zw;
#ifdef MANTLE_CPATCH

  if (cpLocalOk) uv = (gCpLocal + (LB_C2.zw - uGlobalBBox.xy)) / uGlobalBBox.zw;
#endif
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  float z = (uNumShapes > 0.0) ? (1.0 - float(shapeIdx) / uNumShapes) : 0.0;

  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  int footprintVectorEffects = 0;
  if (wHasWorldM == 1) {

    vec4 cj = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, shapeIdx), 0);
    int flagsShape = int(cj.w + 0.5);
    footprintVectorEffects = flagsShape & 7168;
    bool nonScalingSize = (flagsShape & 1024) != 0;
    bool nonRotation    = (flagsShape & 2048) != 0;
    bool fixedPosition  = (flagsShape & 4096) != 0;
    if (nonScalingSize || nonRotation || fixedPosition) {

      vec4 bb = texelFetch(uMetaTex, metaAt(MT_BBOX, shapeIdx), 0);
      vec2 anchorEm = vec2((bb.x + bb.z) * 0.5, (bb.y + bb.w) * 0.5);
      vec2 anchorUV = (anchorEm - uGlobalBBox.xy) / uGlobalBBox.zw;
      vec2 anchorPlane = (anchorUV * 2.0 - 1.0) * uCanvasAR;
      vec2 anchorClip = vec2(anchorPlane.x, -anchorPlane.y);

      float m00 = wWorldM[0][0], m10 = wWorldM[0][1];
      float m01 = wWorldM[1][0], m11 = wWorldM[1][1];
      vec2 t    = wWorldM[2].xy;

      float scale = max(sqrt(m00 * m00 + m10 * m10), 1e-30);
      float cR = m00 / scale, sR = m10 / scale;

      vec2 effScale = nonScalingSize ? vec2(1.0) : vec2(scale);
      mat2 effR = nonRotation
        ? mat2(1.0, 0.0, 0.0, 1.0)
        : mat2(cR, sR, -sR, cR);
      vec2 effT = fixedPosition ? vec2(0.0) : t;

      vec2 d = clip3.xy - anchorClip;
      d *= effScale;
      d = effR * d;
      clip3.xy = d + anchorClip + effT;
    } else {

      float worldReach = max(max(abs(wWorldM[0].x), abs(wWorldM[0].y)), max(abs(wWorldM[1].x), abs(wWorldM[1].y))) * max(uViewportSize.x, uViewportSize.y);
      if (worldReach >= 65536.0) {
        vec2 emClip = emTransformed, clipConst = vec2(e0.w, e1.w);
#ifdef MANTLE_CPATCH
        if (cpLocalOk) { emClip = gCpLocal; clipConst += vec2(e0.x, e1.y) * LB_C2.zw; }
#endif
        clip3 = wWorldM * vec3(vec2(e0.x, e1.y) * emClip, 0.0) + wWorldM * vec3(clipConst, 1.0);
      } else {
        clip3 = wWorldM * clip3;
      }
    }
  }

  bool affineWorld = wHasWorldM != 1 ||
    (wWorldM[0].z == 0.0 && wWorldM[1].z == 0.0 && wWorldM[2].z == 1.0);
  if (uHasEmCoord == 0 && affineWorld && footprintVectorEffects == 0) {
    vec2 scale = vec2(2.0, -2.0) * uCanvasAR / uGlobalBBox.zw;
    mat2 jacobian = mat2(scale.x, 0.0, 0.0, scale.y) * ovBasis;
    if (wHasWorldM == 1) jacobian = mat2(wWorldM) * jacobian;
    jacobian = mat2(uViewportSize.x * 0.5, 0.0, 0.0, uViewportSize.y * 0.5) * jacobian;
    float det = determinant(jacobian);
    if (det != 0.0) {
      mat2 footprint = inverse(jacobian);
      vec4 packed = vec4(footprint[0], footprint[1]);
      if (!any(isnan(packed)) && !any(isinf(packed))) vAffineFootprint = packed;
    }
  }

  bool plainCover = uHasEmCoord == 0 && aEmCoord.x <= .5;
#ifdef MANTLE_LB_FILL
  plainCover = plainCover && aLbMeta.x <= .5;
#endif

  bool axisWorld = wHasWorldM != 1 || (affineWorld && wWorldM[0].y == 0.0 && wWorldM[1].x == 0.0);
  if (plainCover && axisWorld && footprintVectorEffects == 0
      && abs(aNormal.x) == 1.0 && abs(aNormal.y) == 1.0
      && ovBasis[0].y == 0.0 && ovBasis[1].x == 0.0 && ovBasis[0].x != 0.0 && ovBasis[1].y != 0.0
      && any(greaterThan(abs(clip3.xy), vec2(16384.0 * abs(clip3.z))))) {
    vec2 worldScale = wHasWorldM == 1 ? vec2(wWorldM[0].x, wWorldM[1].y) : vec2(1.0);
    if (worldScale.x != 0.0 && worldScale.y != 0.0) {
      vec2 ndc = clamp(clip3.xy / clip3.z, vec2(-1.0), vec2(1.0));

      vec2 worldOffset = wHasWorldM == 1 ? wWorldM[2].xy : vec2(0.0);
      vec2 document = (ndc - (worldScale * vec2(e0.w, e1.w) + worldOffset)) / (worldScale * vec2(e0.x, e1.y));
      vEmCoord = (document - ovPos) / vec2(ovBasis[0].x, ovBasis[1].y);
      clip3.xy = ndc * clip3.z;
    }
  }

  if (plainCover && clip3.z > 0.0 && dot(vAffineFootprint, vAffineFootprint) > 0.0) {
    vec2 sR0 = m0.xy * (0.5 * uViewportSize.x), sR1 = m1.xy * (0.5 * uViewportSize.y);
    float sn0 = dot(sR0, sR0), sn1 = dot(sR1, sR1), sx01 = dot(sR0, sR1);

    bool nonSimilar = abs(sn0 - sn1) > (1.0 / 256.0) * (sn0 + sn1) || abs(sx01) > (1.0 / 256.0) * (sn0 + sn1);
    vec2 halfVp = 0.5 * uViewportSize;
    vec2 win = clip3.xy / clip3.z * halfVp + halfVp;
    if (nonSimilar && max(abs(win.x), abs(win.y)) < 8192.0) {
      vec2 snapped = floor(win * 256.0 + 0.5) * (1.0 / 256.0);
      vEmCoord += mat2(vAffineFootprint.xy, vAffineFootprint.zw) * (snapped - win);
      clip3.xy = (snapped - halfVp) / halfVp * clip3.z;
    }
  }
  gl_Position = vec4(clip3.xy, z, clip3.z);
}
