#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

layout(location=0) in vec2 aPosA;
layout(location=1) in vec3 aTCA;
layout(location=2) in vec2 aFlags;

layout(location=3) in vec4 aC0A;
#ifndef MANTLE_NO_BEZOUT
layout(location=4) in vec4 aC1A;
layout(location=5) in vec4 aC2A;
#endif
layout(location=6) in vec4 aC3A;
layout(location=7) in vec4 aColor;
#ifdef MANTLE_LB_MORPH_PAIR
layout(location=10) in vec2 aPosB;
layout(location=11) in vec3 aTCB;
layout(location=12) in vec4 aC0B;
#ifndef MANTLE_NO_BEZOUT
layout(location=13) in vec4 aC1B;
layout(location=14) in vec4 aC2B;
#endif
layout(location=15) in vec4 aC3B;
uniform float uMorphT;
#endif

layout(location=8) in float aSeamM;

uniform vec4 uGlobalBBox;

uniform sampler2D uOverrideTex;

uniform sampler2D uLbPaintTex;
uniform int uLbHasPaint;
uniform int uLbHasOvr;

layout(location=9) in float aShapeRow;
uniform vec2 uCanvasAR;
uniform mat3 uWorldM;
uniform int  uHasWorldM;
uniform vec2 uViewportSize;

out vec2 vEm;
out vec3 vTC;
flat out float vKind;
flat out float vSign;
#ifndef MANTLE_NO_BEZOUT
flat out vec3  cM00;
flat out vec3  cM01;
flat out vec3  cM02;
flat out float cM11a;
flat out float cM12;
flat out float cM22;
flat out vec4  vCh2A;
flat out vec4  vCh2B;
#endif
flat out vec2  cCen;
flat out float cScale;
flat out float cHalf;
flat out float vEmPerPx;

flat out float vSeam;
flat out float vGradId;
flat out float vImageId;
flat out vec4  vImgRect;
flat out vec4  vAtlasSlot;
flat out vec4  vShapeBB;
flat out vec2  vNa;
flat out vec2  vNb;
flat out vec3  vLine2;
flat out float vLineT;
flat out vec4  vColor;

const int OV_POS_VIS = 1;
const int OV_TINT    = 2;
const int OV_FILL    = 3;

float emPerPxFor(vec2 dirEm, float basePx) {
  if (uHasWorldM == 0) return basePx;
  vec2 c0 = vec2(uWorldM[0][0], uWorldM[0][1]);
  vec2 c1 = vec2(uWorldM[1][0], uWorldM[1][1]);
  float l0 = length(c0), l1 = length(c1);
  float dl = length(dirEm);
  if (dl < 1e-9 ||
      (abs(l1 - l0) <= 1e-4 * max(l0, l1) && abs(dot(c0, c1)) <= 1e-4 * max(l0 * l1, 1e-20)))
    return basePx / max(l0, 1e-4);
  vec2 pd = vec2(dirEm.x, -dirEm.y) / dl;
  return basePx / max(length(c0 * pd.x + c1 * pd.y), 1e-4);
}

void main() {
#ifdef MANTLE_LB_MORPH_PAIR
  vec2 aPos = mix(aPosA, aPosB, uMorphT);
  vec3 aTC  = mix(aTCA,  aTCB,  uMorphT);
  vec4 aC0  = mix(aC0A,  aC0B,  uMorphT);
#ifndef MANTLE_NO_BEZOUT
  vec4 aC1  = mix(aC1A,  aC1B,  uMorphT);
  vec4 aC2  = mix(aC2A,  aC2B,  uMorphT);
#endif
  vec4 aC3  = mix(aC3A,  aC3B,  uMorphT);
#else
  vec2 aPos = aPosA;
  vec3 aTC  = aTCA;
  vec4 aC0  = aC0A;
#ifndef MANTLE_NO_BEZOUT
  vec4 aC1  = aC1A;
  vec4 aC2  = aC2A;
#endif
  vec4 aC3  = aC3A;
#endif
  vColor = aColor;
  if (uLbHasOvr == 1) {
    int row = int(aShapeRow + 0.5);
    vec4 ovP  = texelFetch(uOverrideTex, ivec2(OV_POS_VIS, row), 0);
    vec4 ovT  = texelFetch(uOverrideTex, ivec2(OV_TINT, row), 0);
    int  ovMask = int(ovP.w + 0.5);
    if ((ovMask & 1) != 0) vColor = texelFetch(uOverrideTex, ivec2(OV_FILL, row), 0);
    vColor *= ovT;
    vColor.a *= clamp(ovP.z, 0.0, 1.0);
  }
  vGradId = 0.0; vImageId = 0.0; vShapeBB = vec4(0.0); vImgRect = vec4(0.0); vAtlasSlot = vec4(0.0);
  if (uLbHasPaint == 1) {
    int prow = int(aShapeRow + 0.5);
    vec4 p0  = texelFetch(uLbPaintTex, ivec2(0, prow), 0);
    vGradId  = p0.x; vImageId = p0.y;
    vShapeBB = texelFetch(uLbPaintTex, ivec2(1, prow), 0);
    if (vImageId > 0.5) {
      vImgRect   = texelFetch(uLbPaintTex, ivec2(2, prow), 0);
      vAtlasSlot = texelFetch(uLbPaintTex, ivec2(3, prow), 0);
    }
  }
  vTC = aTC;
  vKind = aFlags.x;
  vSign = aFlags.y;
  vSeam = aSeamM;
  vNa = aC0.xy;
  vNb = aC0.zw;
  vLine2 = aC0.xyz;
  vLineT = aC0.w;
#ifndef MANTLE_NO_BEZOUT
  cM00 = aC0.xyz;
  cM01 = vec3(aC0.w, aC1.xy);
  cM02 = vec3(aC1.zw, aC2.x);
  cM11a = aC2.y;
  cM12  = aC2.z;
  cM22  = aC2.w;

  vCh2A = aC1;
  vCh2B = aC2;
#endif
  cCen  = aC3.xy;
  cScale = aC3.z;
  cHalf = aC3.w;

  float basePx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  vEmPerPx = emPerPxFor(aC3.xy, basePx);
  vec2 emPos = aPos;
  if (aFlags.x > 3.5 && aFlags.x < 4.5) {

    vec2 out4 = aPos - cCen;
    float L4 = max(length(out4), 1e-9);
    vEmPerPx = emPerPxFor(out4, basePx);
    emPos = aPos + (out4 / L4) * (1.5 * emPerPxFor(out4, basePx));
  } else if (aFlags.x > 9.5 && aFlags.x < 10.5) {

    vec2 p1k = aC3.xy, p2k = vec2(aC3.z, aC3.w);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-9);
    vec2 nOutk = vec2(-tdk.y, tdk.x) * aFlags.y;
    float tR = mod(aTC.x, 2.0), sR = floor(aTC.x / 2.0 + 0.25);
    vec2 basek = tR < 0.5 ? p1k : p2k;
    vEmPerPx = emPerPxFor(nOutk, basePx);

    float tExt = 3.2, nExt = 3.2;
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

    float amt12 = 1.5 * emPerPxFor(aC0.xy, basePx);
    vEmPerPx = emPerPxFor(aC0.xy, basePx);
    emPos = aPos + aC0.xy * amt12;
    if (abs(aFlags.y) >= 8192.0) {
      vec2 dkl12 = unpackHalf2x16(floatBitsToUint(aC0.z));
      vTC = aTC + vec3(dkl12, aC0.w) * amt12;
    } else vTC = vec3(aTC.xy + aC0.zw * amt12, aTC.z);
  }
  vEm = emPos;

  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;

  float kindI9 = floor(aFlags.x + 0.25);
  float frac9 = (aFlags.x - kindI9) * 8192.0;

  float blend9 = step(2048.0, frac9 + 0.5);
  float ord9 = frac9 - blend9 * 2048.0;

  bool strip9 = (kindI9 > 9.5 && kindI9 < 10.5) || (kindI9 > 11.5 && kindI9 < 12.5);

  bool opaque9 = vColor.a >= 0.996;
  float tier9 = (kindI9 == 0.0 || (strip9 && opaque9)) ? 0.0 : 1e-5;
  float blendEff9 = opaque9 ? blend9 : 0.0;
  float carveZ = -ord9 * 2.4e-5 - (1.0 - blendEff9) * tier9;
  gl_Position = vec4(clip3.xy, carveZ * clip3.z, clip3.z);
}
