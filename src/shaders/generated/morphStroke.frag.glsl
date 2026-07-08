#version 300 es

precision highp float;
precision highp int;

flat in vec2  vP0, vP1, vP2, vP3;
flat in float vHalfW, vMiterLimit;
flat in vec2  vInTan, vOutTan;        
flat in float vFreeStart, vFreeEnd;
flat in int   vCap, vJoin;            
flat in float vStartDist;
in vec2 vEm;
out vec4 o;

uniform int       uDashId;            
uniform sampler2D uDashTex;

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

void main() {
  vec2 ePx = fwidth(vEm);
  float pxSize = max(0.5 * (ePx.x + ePx.y), 1e-6);
  
  
  vec4 p12 = vec4(vP0 - vEm, vP1 - vEm);
  vec4 p34 = vec4(vP2 - vEm, vP3 - vEm);
  float reachS = vFreeStart > 0.5 ? 1e9 : 0.0;
  float reachE = vFreeEnd > 0.5 ? 1e9 : 0.0;
  
  
  
  
  
  
  vec4 curv = vec4(0.0);
  if (vJoin == 4) {
    vec2 d1s = 3.0 * (vP1 - vP0), d2s = 6.0 * (vP0 - 2.0 * vP1 + vP2);
    vec2 d1e = 3.0 * (vP3 - vP2), d2e = 6.0 * (vP1 - 2.0 * vP2 + vP3);
    float ms = length(d1s), me = length(d1e);
    curv.x = ms > 1e-9 ? (d1s.x * d2s.y - d1s.y * d2s.x) / (ms * ms * ms) : 0.0;
    curv.y = me > 1e-9 ? (d1e.x * d2e.y - d1e.y * d2e.x) / (me * me * me) : 0.0;
  }
  float md = strokeCubicAccum(p12, p34, vFreeStart > 0.5, vFreeEnd > 0.5, vCap, vCap,
                              vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                              uDashId, vStartDist, reachS, reachE, curv, 1e20);
  
  float halfWVis = max(vHalfW, 0.5 * pxSize);
  float weightFade = vHalfW / halfWVis;
  float dfe = md - halfWVis;
  float cov = (dfe <= 0.5 * pxSize) ? clamp(0.5 - dfe / pxSize, 0.0, 1.0) * weightFade : 0.0;
  if (cov <= 0.0) discard;
  o = vec4(cov);
}
