#version 300 es

precision highp float;
precision highp int;

layout(location=0) in float aPrimBase;
layout(location=1) in float aCorner;
layout(location=2) in float aSegFlags;
layout(location=3) in float aContourStart;

uniform highp sampler2D uPrim;
uniform int   uPrimW;
uniform float uT, uHalfW, uMiterLimit;
uniform int   uCapStyle, uJoinStyle, uDashId;
uniform vec4  uGlobalBBox;
uniform vec2  uCanvasAR;
uniform mat3  uWorldM;
uniform int   uHasWorldM;
uniform vec2  uViewportSize;

flat out vec2  vP0, vP1, vP2, vP3;
flat out float vHalfW, vMiterLimit;
flat out vec2  vInTan, vOutTan;
flat out float vFreeStart, vFreeEnd;
flat out int   vCap, vJoin;
flat out float vStartDist;
out vec2 vEm;

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

vec4 ftx(int i) { return texelFetch(uPrim, ivec2(i % uPrimW, i / uPrimW), 0); }
vec2 nrm(vec2 v) { return v / max(length(v), 1e-9); }

float segArcLen(int b) {
  vec4 s0 = ftx(b), s1 = ftx(b + 1), d0 = ftx(b + 2), d1 = ftx(b + 3);
  vec2 P0 = mix(s0.xy, d0.xy, uT), P1 = mix(s0.zw, d0.zw, uT);
  vec2 P2 = mix(s1.xy, d1.xy, uT), P3 = mix(s1.zw, d1.zw, uT);
  return slugCubicArcLen(cubicCoeff(P0.x, P1.x, P2.x, P3.x), cubicCoeff(P0.y, P1.y, P2.y, P3.y), 1.0);
}

void main() {
  int base = int(aPrimBase + 0.5);
  vec4 s0 = ftx(base), s1 = ftx(base + 1), d0 = ftx(base + 2), d1 = ftx(base + 3), nb = ftx(base + 4), nx = ftx(base + 5);
  vec2 P0 = mix(s0.xy, d0.xy, uT), P1 = mix(s0.zw, d0.zw, uT);
  vec2 P2 = mix(s1.xy, d1.xy, uT), P3 = mix(s1.zw, d1.zw, uT);
  vec2 prevP2 = mix(nb.xy, nb.zw, uT), nextP1 = mix(nx.xy, nx.zw, uT);
  vP0 = P0; vP1 = P1; vP2 = P2; vP3 = P3;
  vHalfW = uHalfW; vMiterLimit = max(uMiterLimit, 1.0);
  vCap = uCapStyle; vJoin = uJoinStyle;
  int fl = int(aSegFlags + 0.5);
  vFreeStart = float(fl & 1); vFreeEnd = float((fl >> 1) & 1);
  vInTan = nrm(P0 - prevP2); vOutTan = nrm(nextP1 - P3);

  vStartDist = 0.0;
  if (uDashId > 0) {
    int segIdx = base / 6, startSeg = int(aContourStart + 0.5) / 6;
    for (int j = 0; j < 4096; j++) { int jj = startSeg + j; if (jj >= segIdx) break; vStartDist += segArcLen(jj * 6); }
  }

  vec2 mn = min(min(P0, P1), min(P2, P3)), mx = max(max(P0, P1), max(P2, P3));
  float emPerPx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  
  
  
  
  
  
  float reach = uHalfW;
  if (uJoinStyle == 0) {
    float worst = uHalfW * max(uMiterLimit, 1.0);
    vec2 dS = P1 - P0, dE = P3 - P2;
    float mS = uHalfW, mE = uHalfW;
    if (vFreeStart < 0.5) {
      if (length(dS) < 1e-6) mS = worst;   
      else { float ch = sqrt(max(0.5 * (1.0 + dot(-nrm(dS), vInTan)), 1e-9));
             float m = uHalfW / max(ch, 1e-6); mS = (m <= worst) ? m : uHalfW; }
    }
    if (vFreeEnd < 0.5) {
      if (length(dE) < 1e-6) mE = worst;
      else { float ch = sqrt(max(0.5 * (1.0 + dot(nrm(dE), -vOutTan)), 1e-9));
             float m = uHalfW / max(ch, 1e-6); mE = (m <= worst) ? m : uHalfW; }
    }
    reach = max(mS, mE);
  }
  reach += 3.0 * emPerPx;
  mn -= vec2(reach); mx += vec2(reach);
  int ci = int(aCorner + 0.5);
  vec2 emPos = (ci == 0) ? mn : (ci == 1) ? vec2(mx.x, mn.y) : (ci == 2) ? mx : vec2(mn.x, mx.y);

  vEm = emPos;
  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;
  gl_Position = vec4(clip3.xy, 0.0, clip3.z);
}
