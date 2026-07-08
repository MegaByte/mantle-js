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
uniform int       uGradientCount;
uniform int       uGradientStopsCount;
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
      if (startCap == 0) drop = true;
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
      float cosHalf = sqrt(max(0.5 * (1.0 + c), 1e-9));
      float miterLen = halfW / max(cosHalf, 1e-6);
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
      
      
      
      vec2 segTan = normalize(dStart);
      vec2 ep = pStart;
      if (startPrevReach < 1e8 && dot(-ep, inTan) < 0.0) drop = true;
      float c = dot(-segTan, inTan);
      float cosHalf = sqrt(max(0.5 * (1.0 + c), 1e-9));
      float miterLen = halfW / max(cosHalf, 1e-6);
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
        
        
        
        
        vec2 tB = normalize(dStart);
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
      if (endCap == 0) drop = true;
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
      float cosHalf = sqrt(max(0.5 * (1.0 + c), 1e-9));
      float miterLen = halfW / max(cosHalf, 1e-6);
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
      
      vec2 segTan = normalize(dEnd);
      vec2 ep = pEnd;
      if (endNextReach < 1e8 && dot(-ep, outTan) > 0.0) drop = true;
      float c = dot(segTan, -outTan);
      float cosHalf = sqrt(max(0.5 * (1.0 + c), 1e-9));
      float miterLen = halfW / max(cosHalf, 1e-6);
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
        
        
        vec2 tA = normalize(dEnd);
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
  float bT = 0.0, bS = 1e20;
  for (int k = 0; k <= 4; k++) {
    float tt = float(k) / 4.0;
    vec2 q = (A * tt + B) * tt + C;
    float d2 = dot(q, q);
    if (d2 < bS) { bS = d2; bT = tt; }
  }
  float t = bT;
  for (int j = 0; j < 3; j++) {
    vec2 q = (A * t + B) * t + C;
    vec2 d = 2.0 * A * t + B;
    float f = dot(q, d);
    float df = dot(d, d) + dot(q, 2.0 * A);
    if (abs(df) < 1e-9) break;
    t = clamp(t - f / df, 0.0, 1.0);
  }
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
ivec2 bLoc(ivec2 gl, int off) { ivec2 l=ivec2(gl.x+off, gl.y); l.y+=l.x>>12; l.x&=4095; return l; }

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

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
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
        if (startCap == 0) drop = true;
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
            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 1e-9));
            float miterLen = halfW / max(cosHalf, 1e-6);
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
        if (endCap == 0) drop = true;
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
            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 1e-9));
            float miterLen = halfW / max(cosHalf, 1e-6);
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
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
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
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
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
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
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
    float f = dot(pR / d1.zw, pR / d1.zw) - 1.0;
    vec2 g = 2.0 * pR / (d1.zw * d1.zw);
    float dEdge = abs(f) / (length(g) + 1e-9);
    float tAng = atan(pR.y / d1.w, pR.x / d1.z);
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
  float t1 = (b.y - d) * ra;
  float t2 = (b.y + d) * ra;
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
  float t1 = (b.x - d) * ra;
  float t2 = (b.x + d) * ra;
  if (abs(a.x) < 1.0/65536.0) { t1 = p12.x * rb; t2 = t1; }
  return vec4((a.y * t1 - b.y * 2.0) * t1 + p12.y,
              (a.y * t2 - b.y * 2.0) * t2 + p12.y,
              t1, t2);
}

vec4 solveDep(float p, float q) {
  float d=q*q*0.25+p*p*p/27.0;
  if(d>1e-12){ float sd=sqrt(d); return vec4(sign(-q*0.5+sd)*pow(abs(-q*0.5+sd),1.0/3.0)+sign(-q*0.5-sd)*pow(abs(-q*0.5-sd),1.0/3.0),1e20,1e20,1.0); }
  if(d<-1e-12){ float m=2.0*sqrt(-p/3.0), th=acos(clamp(3.0*q/(p*m),-1.0,1.0))/3.0; return vec4(m*cos(th), m*cos(th-radians(120.0)), m*cos(th-radians(240.0)), 3.0); }
  float u=sign(-q*0.5)*pow(abs(-q*0.5),1.0/3.0); return vec4(2.0*u, -u, 1e20, 2.0);
}

void solveCubicBisect(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t) {
  r = vec3(1e20); t = vec3(-1.0);
  vec4 cy = cubicCoeff(vert?p12.x:p12.y, vert?p12.z:p12.w, vert?p34.x:p34.y, vert?p34.z:p34.w);
  vec4 cx = cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);

  
  float qa = 3.0 * cy.x;
  float qb = 2.0 * cy.y;
  float qc = cy.z;
  float split1 = -1.0, split2 = -1.0;
  if (abs(qa) < 1.0/65536.0) {
    if (abs(qb) > 1.0/65536.0) {
      float s = -qc / qb;
      if (s > 0.0 && s < 1.0) split1 = s;
    }
  } else {
    float disc = qb*qb - 4.0*qa*qc;
    if (disc >= 0.0) {
      float sd = sqrt(disc);
      float s1 = (-qb - sd) / (2.0*qa);
      float s2 = (-qb + sd) / (2.0*qa);
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
    
    
    
    
    
    float xr = 0.5 * (lo + hi);
    for (int k = 0; k < 8; k++) {
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

void solveCubic(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t) {
  r=vec3(1e20); t=vec3(-1.0);
  vec4 cy=cubicCoeff(vert?p12.x:p12.y, vert?p12.z:p12.w, vert?p34.x:p34.y, vert?p34.z:p34.w);
  if(abs(cy.x)<(1.0/65536.0)){
    float qa=cy.y, qb=cy.z, qc=cy.w;
    float disc = qb*qb - 4.0*qa*qc;
    vec4 cx=cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);
    if(abs(qa)<(1.0/65536.0)){
      if(abs(qb)<(1.0/65536.0)) return;
      float tt = -qc/qb;
      if(tt>=0.0 && tt<=1.0){ t[0]=tt; r[0]=evalC(cx,tt); }
      return;
    }
    if(disc<0.0) return;
    float det=sqrt(disc);
    float t1=(-qb-det)/(2.0*qa), t2=(-qb+det)/(2.0*qa);
    if(t1>=0.0 && t1<=1.0){ t[0]=t1; r[0]=evalC(cx,t1); }
    if(t2>=0.0 && t2<=1.0 && abs(t2-t1)>1e-6){ t[1]=t2; r[1]=evalC(cx,t2); }
    return;
  }
  float invA=1.0/cy.x, b=cy.y*invA, c=cy.z*invA, d=cy.w*invA;
  float pp=c-b*b/3.0, qq=2.0*b*b*b/27.0-b*c/3.0+d, off=b/3.0;
  vec4 sol=solveDep(pp,qq);
  vec4 cx=cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);

  
  
  
  
  
  
  
  
  
  
  
  
  
  int idx = 0;
  if ((vert ? p12.x : p12.y) > 0.0) idx |= 1;
  if ((vert ? p12.z : p12.w) > 0.0) idx |= 2;
  if ((vert ? p34.x : p34.y) > 0.0) idx |= 4;
  if ((vert ? p34.z : p34.w) > 0.0) idx |= 8;
  int t1Hit = (0x7FFE >> idx) & 1;
  int t2Hit = (0x2E74 >> idx) & 1;
  int t3Hit = (0x0420 >> idx) & 1;

  
  float ts[3];
  ts[0] = sol[0] - off;
  ts[1] = sol[1] - off;
  ts[2] = sol[2] - off;
  if (ts[1] < ts[0]) { float tmp = ts[0]; ts[0] = ts[1]; ts[1] = tmp; }
  if (ts[2] < ts[1]) { float tmp = ts[1]; ts[1] = ts[2]; ts[2] = tmp; }
  if (ts[1] < ts[0]) { float tmp = ts[0]; ts[0] = ts[1]; ts[1] = tmp; }

  
  
  int slot = 0;
  for (int i = 0; i < 3; i++) {
    if (i >= int(sol.w)) break;
    float tt = ts[i];
    if (tt < 0.0 || tt > 1.0) continue;
    
    if (slot > 0 && abs(tt - t[slot-1]) < 1e-5) continue;
    int hit = (slot == 0) ? t1Hit : ((slot == 1) ? t2Hit : t3Hit);
    if (hit != 0) {
      t[slot] = tt;
      r[slot] = evalC(cx, tt);
    }
    slot++;
  }
}

vec4 fillLinear(vec2 c, vec2 px, ivec4 GD, vec4 shapeBB) {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  float xcov = 0.0, ycov = 0.0, xwgt = 0.0, ywgt = 0.0;

  
  
  
  {
    int hdr = bandIdx.y * 2;
    vec4 hCnts = bFetch(bLoc(gl, hdr));
    int hLineN  = int(hCnts.x);
    int hQuadN  = int(hCnts.y);
    int hCubicN = int(hCnts.z);
    int hArcN   = int(hCnts.w);
    int arrIdx  = int(bFetch(bLoc(gl, hdr + 1)).x);
    int hOff = 0;

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    for (int i = 0; i < 1024; i++) {
      if (i >= hLineN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
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
      xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
      xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
    }
    hOff += hLineN;

    
    for (int i = 0; i < 1024; i++) {
      if (i >= hQuadN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.x, p12.z), p3.x) * px.x < -0.5) continue;
      uint code = calcRootCode2(p12.y, p12.w, p3.y);
      if (code == 0u) continue;
      vec4 rt = slugSolveHorizQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.x;
        xcov += clamp(ri + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.x;
        xcov -= clamp(ri + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    hOff += hQuadN;

    
    
    
    
    
    
    
    for (int i = 0; i < 1024; i++) {
      if (i >= hCubicN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
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
        xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    hOff += hCubicN;

    
    
    
    
    
    
    for (int i = 0; i < 1024; i++) {
      if (i >= hArcN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t1) - c;
            float ri = p.x * px.x;
            
            float sgn = arcDir * ((arcDyDtheta(d1.z, d1.w, d2.z, t1) < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t2) - c;
            float ri = p.x * px.x;
            float sgn = arcDir * ((arcDyDtheta(d1.z, d1.w, d2.z, t2) < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
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

    
    
    
    
    
    
    
    for (int i = 0; i < 1024; i++) {
      if (i >= vLineN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
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
      ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
      ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
    }
    vOff += vLineN;

    
    for (int i = 0; i < 1024; i++) {
      if (i >= vQuadN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.y, p12.w), p3.y) * px.y < -0.5) continue;
      
      uint code = calcRootCode2(p12.x, p12.z, p3.x);
      if (code == 0u) continue;
      vec4 rt = slugSolveVertQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.y;
        ycov -= clamp(ri + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.y;
        ycov += clamp(ri + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    vOff += vQuadN;

    
    for (int i = 0; i < 1024; i++) {
      if (i >= vCubicN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
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
        ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    vOff += vCubicN;

    
    for (int i = 0; i < 1024; i++) {
      if (i >= vArcN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      float A = cp * d1.z, B = -sp * d1.w, C = -(d1.x - c.x);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t1) - c;
            float ri = p.y * px.y;
            float sgn = arcDir * ((arcDxDtheta(d1.z, d1.w, d2.z, t1) >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t2) - c;
            float ri = p.y * px.y;
            float sgn = arcDir * ((arcDxDtheta(d1.z, d1.w, d2.z, t2) >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
  }
  return vec4(xcov, ycov, xwgt, ywgt);
}

float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  vec4 L = fillLinear(c, px, GD, shapeBB);
  float wsum = max(L.z + L.w, 1.0 / 65536.0);
  float cov = max(abs(L.x * L.z + L.y * L.w) / wsum, min(abs(L.x), abs(L.y)));
  if (evenOdd) return 1.0 - abs(1.0 - fract(cov * 0.5) * 2.0);
  return clamp(cov, 0.0, 1.0);
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
  if (cSW > 0.0 && cStroke.a > 0.0) {
    
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
