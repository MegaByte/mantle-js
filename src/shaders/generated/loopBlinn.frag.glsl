#version 300 es

precision highp float;

in vec2 vEm;
in vec3 vTC;
flat in float vKind;
flat in float vSign;

#ifndef MANTLE_NO_BEZOUT
flat in vec3  cM00;
flat in vec3  cM01;
flat in vec3  cM02;
flat in float cM11a;
flat in float cM12;
flat in float cM22;
#endif
flat in vec2  cCen;
flat in float cScale;
flat in float cHalf;   
flat in float vEmPerPx; 
flat in float vTP;      
flat in float vSeam;    
flat in vec2  vNa;      
flat in vec2  vNb;      
flat in vec3  vLine2;   
flat in float vLineT;   
flat in vec4  vColor;

uniform int   uDirect;   
uniform float uAlpha;    

uniform int       uGradId;        
uniform vec4      uShapeBBox;      
uniform sampler2D uGradientTex;   

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

uniform sampler2D uGradientStops; 

uniform int       uImageId;       
uniform vec4      uImgRect;        
uniform vec4      uAtlasSlot;      
uniform sampler2D uImageTex;       
uniform vec2      uImageAtlasSize; 

uniform vec4 uChannelLerpPrimary;
uniform vec4 uChannelLerpContrast;
uniform vec4 uChannelLerpHighlight;
uniform int  uChannelLerpEnabled;
uniform mat4 uColorMatrix;
uniform vec4 uColorMatrixOffset;
uniform int  uColorMatrixEnabled;
out vec4 o;

vec4 lbRecolor(vec4 c) {
  if (uChannelLerpEnabled != 0) {
    vec3 tint = c.r * uChannelLerpPrimary.rgb + c.b * uChannelLerpContrast.rgb;
    float k = clamp(c.g + (1.0 - c.a), 0.0, 1.0);
    c = vec4(mix(tint, uChannelLerpHighlight.rgb, k), c.a);
  }
  if (uColorMatrixEnabled != 0) c = clamp(uColorMatrix * c + uColorMatrixOffset, 0.0, 1.0);
  return c;
}

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

int gradientSpreadToExtend(int spread) { return spread == 1 ? 2 : spread == 2 ? 1 : 0; }

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

vec4 sampleImageLB(vec2 emPos, vec4 imageRect, vec4 atlasSlot) {
  float u = (emPos.x - imageRect.x) / max(imageRect.z, 1e-6);
  float v = (emPos.y - imageRect.y) / max(imageRect.w, 1e-6);
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) { u = fract(u); v = fract(v); }
  else if (kind == 3) { u = abs(fract(u * 0.5) - 0.5) * 2.0; v = abs(fract(v * 0.5) - 0.5) * 2.0; }
  else if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0.0);
  float aU = (u * atlasSlot.y) / max(uImageAtlasSize.x, 1.0);
  float aV = (atlasSlot.x + v * atlasSlot.z) / max(uImageAtlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    aU = (floor(aU * uImageAtlasSize.x) + 0.5) / max(uImageAtlasSize.x, 1.0);
    aV = (floor(aV * uImageAtlasSize.y) + 0.5) / max(uImageAtlasSize.y, 1.0);
  }
  return texture(uImageTex, vec2(aU, aV));
}

vec4 emit(float cov) {
  if (uDirect == 1) {
    vec4 paint;
    if (uImageId > 0) {
      vec4 t = sampleImageLB(vEm, uImgRect, uAtlasSlot) * vColor;          
      paint = vec4(t.rgb * t.a, t.a);
    } else if (uGradId > 0) {
      paint = sampleGradient(uGradId, vEm, uShapeBBox);                  
    } else {
      vec4 f = lbRecolor(vColor);                                          
      paint = vec4(f.rgb * f.a, f.a);                                      
    }
    return paint * (uAlpha * cov);
  }
  return vec4(cov);
}

float slugCov(float f, vec2 grad) {
  float g  = max(length(grad), 1e-6);
  float nx = max(abs(grad.x) / g, 1e-6);   
  float ny = max(abs(grad.y) / g, 1e-6);
  float c  = f / g;                          
  float xc = clamp(0.5 - c / nx, 0.0, 1.0);  
  float yc = clamp(0.5 - c / ny, 0.0, 1.0);  
  float xw = clamp(1.0 - 2.0 * abs(c) / nx, 0.0, 1.0);  
  float yw = clamp(1.0 - 2.0 * abs(c) / ny, 0.0, 1.0);
  float wsum = max(xw + yw, 1e-6);
  return clamp(max((xc * xw + yc * yw) / wsum, min(xc, yc)), 0.0, 1.0);
}

float negLen(float A, float B, float C) {
  if (abs(A) < 1e-7) {                       
    if (abs(B) < 1e-9) return C < 0.0 ? 1.0 : 0.0;
    float r = -C / B, lo = -0.5, hi = 0.5;
    if (B > 0.0) hi = min(hi, r); else lo = max(lo, r);
    return clamp(hi - lo, 0.0, 1.0);
  }
  float disc = B * B - 4.0 * A * C;
  if (disc <= 0.0) return A < 0.0 ? 1.0 : 0.0;   
  float sq = sqrt(disc);
  float r1 = (-B - sq) / (2.0 * A), r2 = (-B + sq) / (2.0 * A);
  float rlo = min(r1, r2), rhi = max(r1, r2);
  if (A > 0.0) {                             
    return clamp(min(0.5, rhi) - max(-0.5, rlo), 0.0, 1.0);
  }
  float a1 = clamp(rlo, -0.5, 0.5) + 0.5;    
  float a2 = 0.5 - clamp(rhi, -0.5, 0.5);
  return clamp(a1 + a2, 0.0, 1.0);
}

float curveCov(float f, float fx, float fy, float fxx, float fyy) {
  float covH = negLen(0.5 * fxx, fx, f);
  float covV = negLen(0.5 * fyy, fy, f);
  float wH = clamp(1.0 - 2.0 * abs(f) / max(abs(fx), 1e-6), 0.0, 1.0);
  float wV = clamp(1.0 - 2.0 * abs(f) / max(abs(fy), 1e-6), 0.0, 1.0);
  float wsum = max(wH + wV, 1e-6);
  return clamp(max((covH * wH + covV * wV) / wsum, min(covH, covV)), 0.0, 1.0);
}

void main() {
  
  
  
  
  
  
  if (vKind > 7.5 && vKind < 8.5) {
    
    
    
    
    
    
    
    
    
    
    vec2 V8 = vec2(vSeam, vTC.z);
    vec2 dA8 = vec2(-cCen.y, cCen.x);
    if (dot(dA8, vLine2.xy) > 0.0) dA8 = -dA8;
    vec2 dB8 = vec2(-vLine2.y, vLine2.x);
    if (dot(dB8, cCen) > 0.0) dB8 = -dB8;
    vec2 rel8 = vEm - V8;
    
    
    
    float tA8 = dot(rel8, dA8), tB8 = dot(rel8, dB8);
    float fA = dot(cCen, vEm) - cScale - 0.5 * vLineT * tA8 * tA8;
    float fB = dot(vLine2.xy, vEm) - vLine2.z - 0.5 * cHalf * tB8 * tB8;
    
    
    
    float band8 = 1.3 * vEmPerPx;
    bool inA8 = dot(rel8, dA8) > 0.0 && fA >= 0.0 && fA < band8;
    bool inB8 = dot(rel8, dB8) > 0.0 && fB >= 0.0 && fB < band8;
    if (inA8 || inB8) discard;                                    
    if (max(fA, fB) <= 0.0) discard;                              
    float cA2 = slugCov(fA, cCen * vEmPerPx);
    float cB2 = slugCov(fB, vLine2.xy * vEmPerPx);
    float k8 = max(0.0, dot(cCen, vLine2.xy));
    o = emit(mix(max(0.0, cA2 + cB2 - 1.0), min(cA2, cB2), k8));
    return;
  }
  
  
  
  
  
  
  
  
  
  if (vKind > 9.5 && vKind < 10.5) {
    vec2 p1k = cCen, p2k = vec2(cScale, cHalf);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-9);
    vec2 nOwn = vec2(-tdk.y, tdk.x) * vSign;
    float fOwn = dot(nOwn, vEm - p1k);
    float codeA = floor((vSeam + 0.5) / 16.0), codeB = vSeam - codeA * 16.0;
    float tyA = floor((codeA + 0.5) / 4.0) - 1.0; bool curveA = mod(codeA, 4.0) >= 1.5;
    float tsA = mod(codeA, 2.0);
    float tyB = floor((codeB + 0.5) / 4.0) - 1.0; bool curveB = mod(codeB, 4.0) >= 1.5;
    float tsB = mod(codeB, 2.0);
    vec2 rA = vEm - p1k, rB = vEm - p2k;
    vec2 wA, wB;
    if (curveA) { wA = vec2(-vNa.y, vNa.x) * (tsA > 0.5 ? 1.0 : -1.0);   
      
      
      
      
      
      if (dot(rA, wA) >= 0.0 && length(rA) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else { wA = vec2(-(vNa.y + nOwn.y), vNa.x + nOwn.x); if (dot(wA, tdk) < 0.0) wA = -wA;
      if (dot(rA, wA) < 0.0) discard; }
    if (curveB) { wB = vec2(-vNb.y, vNb.x) * (tsB > 0.5 ? 1.0 : -1.0);
      if (dot(rB, wB) >= 0.0 && length(rB) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else { wB = vec2(-(vNb.y + nOwn.y), vNb.x + nOwn.x); if (dot(wB, tdk) < 0.0) wB = -wB;
      if (dot(rB, wB) >= 0.0) discard; }
    float fA = dot(vNa, rA) - 0.5 * vTC.y * dot(rA, rA);
    float fB = dot(vNb, rB) - 0.5 * vTC.z * dot(rB, rB);
    
    
    
    
    
    
    
    
    
    
    float gA = clamp((2.2 - length(rA) / vEmPerPx) / 1.5, 0.0, 1.0);
    float gB = clamp((2.2 - length(rB) / vEmPerPx) / 1.5, 0.0, 1.0);
    
    
    
    if (fOwn < -1.2 * vEmPerPx) discard;
    float sOwn = fOwn < -0.012 * vEmPerPx ? 1.0 : 0.0;
    float sA = fA < 0.0 ? 1.0 : 0.0, sB = fB < 0.0 ? 1.0 : 0.0;
    float sAe = tyA > 0.5 ? (gA > 0.01 ? sA : 1.0) : (gA > 0.01 ? sA : 0.0);
    float sBe = tyB > 0.5 ? (gB > 0.01 ? sB : 1.0) : (gB > 0.01 ? sB : 0.0);
    float insid = sOwn;
    insid = tyA > 0.5 ? min(insid, sAe) : (tyA < -0.5 ? max(insid, sAe) : insid);
    insid = tyB > 0.5 ? min(insid, sBe) : (tyB < -0.5 ? max(insid, sBe) : insid);
    if (insid > 0.5) discard;
    float c10 = slugCov(fOwn, nOwn * vEmPerPx);
    if (abs(tyA) > 0.5) {
      float cA10 = slugCov(fA, vNa * vEmPerPx);
      cA10 = tyA > 0.0 ? mix(1.0, cA10, gA) : mix(0.0, cA10, gA);
      float kpA = max(0.0, dot(nOwn, vNa));
      c10 = tyA > 0.0 ? mix(max(0.0, c10 + cA10 - 1.0), min(c10, cA10), kpA)
                      : mix(c10 + cA10 - c10 * cA10, max(c10, cA10), kpA * gA);
    }
    if (abs(tyB) > 0.5) {
      float cB10 = slugCov(fB, vNb * vEmPerPx);
      cB10 = tyB > 0.0 ? mix(1.0, cB10, gB) : mix(0.0, cB10, gB);
      float kpB = max(0.0, dot(nOwn, vNb));
      c10 = tyB > 0.0 ? mix(max(0.0, c10 + cB10 - 1.0), min(c10, cB10), kpB)
                      : mix(c10 + cB10 - c10 * cB10, max(c10, cB10), kpB * gB);
    }
    
    
    
    
    
    if (c10 < 0.004) discard;
    o = emit(c10);
    return;
  }
  
  
  
  
  if (vKind < 0.5) {
    if (dot(cCen, cCen) > 1e-9) {
      float fi = dot(cCen, vEm) - cScale;
      
      
      
      
      
      
      
      float cA = slugCov(fi, cCen * vEmPerPx);
      
      
      
      
      
      if (abs(vLineT) > 0.5) {
        float cB = slugCov(dot(vLine2.xy, vEm) - vLine2.z, vLine2.xy * vEmPerPx);
        cA = vLineT > 0.0 ? max(0.0, cA + cB - 1.0) : cA + cB - cA * cB;
      }
      
      
      if (abs(cHalf) > 0.5 && dot(vTC.xy, vTC.xy) > 1e-9) {
        float cC = slugCov(dot(vTC.xy, vEm) - vTC.z, vTC.xy * vEmPerPx);
        cA = cHalf > 0.0 ? max(0.0, cA + cC - 1.0) : cA + cC - cA * cC;
      }
      o = emit(cA);
    } else o = emit(1.0);
    return;
  }

  float f;
  vec2 f4gEm = vec2(0.0);
  bool f4has = false;
  if (vKind < 1.5 || vKind > 8.5) {   
    
    f = vSign * (vTC.x * vTC.x - vTC.y);
  } else if (vKind < 2.5) {
    
    
    f = vSign * (vTC.x * vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 3.5) {
    
    
    f = dot(cCen, vEm) - cScale;
  } else if (vKind < 4.5) {
#ifndef MANTLE_NO_BEZOUT
    
    vec2 n = (vEm - cCen) / cScale;
    float lin02 = cM02.y * n.x + cM02.z * n.y;   
    float M00 = cM00.x + dot(cM00.yz, n);
    float M01 = cM01.x + dot(cM01.yz, n);
    float M02 = cM02.x + lin02;
    float M11 = cM11a  + lin02;
    float det = M00 * (M11 * cM22 - cM12 * cM12)
              - M01 * (M01 * cM22 - cM12 * M02)
              + M02 * (M01 * cM12 - M11 * M02);
    f = vSign * det;
    
    
    
    float d00 = M11 * cM22 - cM12 * cM12;
    float d01 = -2.0 * M01 * cM22 + 2.0 * M02 * cM12;
    float d02 = 2.0 * M01 * cM12 - 2.0 * M02 * M11;
    float d11 = M00 * cM22 - M02 * M02;
    vec2 gN = d00 * cM00.yz + d01 * cM01.yz + (d02 + d11) * cM02.yz;
    f4gEm = vSign * gN / cScale;
    f4has = true;
#else
    
    f = 1.0;
#endif
  } else if (vKind < 5.5) {
    
    
    
    f = vSign * (vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 6.5) {
    
    
    
    
    
    
    f = vSign * (length(vEm - cCen) - cScale);
  } else {
    
    
    
    
    f = vSign * (abs(length(vEm - cCen) - cScale) - cHalf);
  }
  
  
  
  
  
  
  
  
  float cov;
  bool deferFill = false;
  bool isQuad = vKind > 0.5 && vKind < 1.5;
  bool isCubic = vKind > 1.5 && vKind < 2.5;
  bool isRquad = vKind > 4.5 && vKind < 5.5;
  bool isQuad9 = vKind > 8.5 && vKind < 9.5;
  bool isQuad11 = vKind > 10.5;
  
  
  
  
  
  
  if (isQuad) {
    
    
    
    
    
    
    
    
    vec2 a = cCen, b = vec2(cScale, cHalf);
    if (dot(b - a, b - a) > 1e-9) {
      
      
      
      
      vec2 cp = vec2(vSeam, vTC.z);
      float s1 = (cp.x - a.x) * (vEm.y - a.y) - (cp.y - a.y) * (vEm.x - a.x);
      float s2 = (b.x - cp.x) * (vEm.y - cp.y) - (b.y - cp.y) * (vEm.x - cp.x);
      float s3 = (a.x - b.x) * (vEm.y - b.y) - (a.y - b.y) * (vEm.x - b.x);
      bool ownTri = min(min(s1, s2), s3) >= 0.0 || max(max(s1, s2), s3) <= 0.0;
      float clipEps = 0.5 * vEmPerPx;
      if (!ownTri && (dot(vEm - a, vNa) < -clipEps || dot(vEm - b, vNb) < -clipEps)) discard;
      
      
      
      
      deferFill = !ownTri && vSign * (vTC.x * vTC.x - vTC.y) < 0.0;
    }
  } else if (isRquad) {
    
    vec2 a = cCen, b = vec2(cScale, cHalf), ch = b - a;
    if (dot(ch, ch) > 1e-9 && (dot(vEm - a, ch) < 0.0 || dot(vEm - b, ch) > 0.0)) discard;
  } else if (isQuad9) {
    
    
    
    
    
    
    
    vec2 a = cCen, b = vec2(cScale, cHalf), cp = vec2(vSeam, vTC.z);
    if (dot(vEm - a, cp - a) < 0.0 || dot(vEm - b, cp - b) < 0.0) discard;
    if (vSign * (vTC.x * vTC.x - vTC.y) <= 0.0) discard;
  } else if (isQuad11) {
    
    
    
    
    
    if (abs(vSign) < 1.5 && vSign * (vTC.x * vTC.x - vTC.y) > 0.0) discard;
  }
  if (isQuad || isCubic || isRquad || isQuad9 || isQuad11) {
    vec3 tx = dFdx(vTC), ty = dFdy(vTC);   
    float fx, fy, fxx, fyy;
    if (isQuad || isQuad9 || isQuad11) {   
      float u = vTC.x;
      fx = vSign * (2.0 * u * tx.x - tx.y); fy = vSign * (2.0 * u * ty.x - ty.y);
      fxx = vSign * 2.0 * tx.x * tx.x;      fyy = vSign * 2.0 * ty.x * ty.x;
    } else if (isCubic) {                  
      float k = vTC.x, l = vTC.y, m = vTC.z;
      fx = vSign * (3.0 * k * k * tx.x - (tx.y * m + l * tx.z));
      fy = vSign * (3.0 * k * k * ty.x - (ty.y * m + l * ty.z));
      fxx = vSign * (6.0 * k * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (6.0 * k * ty.x * ty.x - 2.0 * ty.y * ty.z);
    } else {                               
      float U = vTC.x, V = vTC.y, Rr = vTC.z;
      fx = vSign * (2.0 * U * tx.x - (tx.y * Rr + V * tx.z));
      fy = vSign * (2.0 * U * ty.x - (ty.y * Rr + V * ty.z));
      fxx = vSign * (2.0 * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (2.0 * ty.x * ty.x - 2.0 * ty.y * ty.z);
    }
    cov = curveCov(f, fx, fy, fxx, fyy);
  } else {
    if (f4has) {
      
      
      
      vec2 emx = dFdx(vEm), emy = dFdy(vEm);
      float fx4 = dot(f4gEm, emx), fy4 = dot(f4gEm, emy);
      float fxx4 = dot(dFdx(f4gEm), emx), fyy4 = dot(dFdy(f4gEm), emy);
      cov = curveCov(f, fx4, fy4, fxx4, fyy4);
#ifdef MANTLE_DEBUG_K4
      float dpx = f / max(length(vec2(fx4, fy4)), 1e-12);
      o = vec4(clamp(0.5 + dpx * 0.25, 0.0, 1.0), clamp(0.5 + fxx4 * 2.0, 0.0, 1.0), cov, 1.0);
      return;
#endif
    } else {
      vec2 fgrad = (vKind > 2.5 && vKind < 3.5) ? cCen * vEmPerPx : vec2(dFdx(f), dFdy(f));
      cov = slugCov(f, fgrad);
    }
  }
  
  
  
  
  
  
  
  if (vKind > 8.5 && vKind < 9.5 && cov < 0.999 && vSign * (vTC.x * vTC.x - vTC.y) < 0.0) discard;
  if (deferFill && cov < 0.999) discard;
  if (cov <= 0.0) discard;
  o = emit(cov);
}
