#version 300 es

precision highp float;
precision highp int;

layout(location=0) in float aPrimBase;
layout(location=1) in float aCorner;

uniform highp sampler2D uPrim;
uniform int   uPrimW;
uniform float uHalfW, uMiterLimit;
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
flat out float vSegType;
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

#define STROKE_SET_CAPJOIN(c, j) vCap = (c); vJoin = (j)
#define STROKE_SET_TYPE(t) vSegType = (t)
#define STROKE_SET_FREE(s, e)    vFreeStart = (s); vFreeEnd = (e)
#define STROKE_SET_DASH(d)

float curveAtan2(float y, float x) {
  return x == 0.0 ? sign(y) * 1.5707963267948966 : atan(y, x);
}

vec4 strokeFtx(int i) { return texelFetch(uPrim, ivec2(i % uPrimW, i / uPrimW), 0); }

vec2 strokeNrm(vec2 v) { float m = max(abs(v.x), abs(v.y)); if (!(m > 0.0)) return v; vec2 u = v / m; return u / length(u); }

float strokeWorldStretch(vec2 p, mat3 W, vec4 bb, vec2 ar, vec2 vp) {
  vec2 pl = ((p - bb.xy) / bb.zw * 2.0 - 1.0) * ar;
  vec3 h = W * vec3(pl.x, -pl.y, 1.0);
  vec2 n = h.xy / h.z;
  vec2 c0 = (W[0].xy - n * W[0].z) / h.z, c1 = (W[1].xy - n * W[1].z) / h.z;
  float a = vp.x / vp.y;
  vec4 g = vec4(c0.x, c0.y / a, -c1.x * a, -c1.y);
  float m = max(max(abs(g.x), abs(g.y)), max(abs(g.z), abs(g.w)));
  if (!(m > 0.0)) return 0.0;
  g /= m;
  float s = dot(g, g), det = g.x * g.w - g.z * g.y;
  float smax = sqrt(0.5 * (s + sqrt(max(s * s - 4.0 * det * det, 0.0))));
  return m * abs(det) / smax;
}

vec2 strokeVertexSetup(float aPrimBase, float aCorner,
                       float halfW, float miterLimit,
                       int capStyle, int joinStyle, int dashId,
                       vec4 globalBBox, vec2 canvasAR, vec2 viewportSize,
                       mat3 worldM, int hasWorldM) {

  int base = int(aPrimBase + 0.5);
  vec4 hdr = strokeFtx(base);
  int segTy = int(hdr.x + 0.5) & 3;
  vec2 P0, P1, P2, P3;
  int joinOfs;
  if (segTy == 0) {
    vec4 a = strokeFtx(base + 1);
    P0 = a.xy; P3 = a.zw;
    P1 = P0 + (P3 - P0) / 3.0;
    P2 = P0 + 2.0 * (P3 - P0) / 3.0;
    joinOfs = 2;
  } else if (segTy == 1) {
    vec4 a = strokeFtx(base + 1), b = strokeFtx(base + 2);
    P0 = a.xy; P1 = a.zw; P2 = a.zw; P3 = b.xy;
    joinOfs = 3;
  } else if (segTy == 2) {
    vec4 a = strokeFtx(base + 1), b = strokeFtx(base + 2);
    P0 = a.xy; P1 = a.zw; P2 = b.xy; P3 = b.zw;
    joinOfs = 3;
  } else {

    vec4 a = strokeFtx(base + 1), b = strokeFtx(base + 2);
    P0 = a.xy; P1 = a.zw; P2 = vec2(b.z, b.x); P3 = vec2(b.y, 0.0);
    joinOfs = 4;
  }
  vec4 jn = strokeFtx(base + joinOfs);
  vP0 = P0; vP1 = P1; vP2 = P2; vP3 = P3;
  STROKE_SET_TYPE(float(segTy));
  vHalfW = halfW; vMiterLimit = max(miterLimit, 1.0);

  STROKE_SET_CAPJOIN(capStyle, joinStyle);
  STROKE_SET_FREE(hdr.y, hdr.z);
  STROKE_SET_DASH(dashId);
  vInTan = jn.xy; vOutTan = jn.zw;
  vStartDist = hdr.w;

  vec2 ax = vec2(1.0, 0.0), ay = vec2(0.0, 1.0), lo, hi;
  if (segTy == 3) {
    float cp = cos(P2.x), sp = sin(P2.x), th0 = P2.y, th1 = P3.x, dth = th1 - th0;
    if (abs(dth) >= 6.28318530717959) {

      float r = max(abs(P1.x), abs(P1.y)), rs = r > 0.0 ? 1.0 / r : 0.0;
      vec2 ext = r * vec2(length(vec2(P1.x * rs * cp, P1.y * rs * sp)), length(vec2(P1.x * rs * sp, P1.y * rs * cp)));
      lo = -ext; hi = ext;
    } else {
      vec2 e0 = P0 + vec2(P1.x * cp * cos(th0) - P1.y * sp * sin(th0), P1.x * sp * cos(th0) + P1.y * cp * sin(th0));
      vec2 e1 = P0 + vec2(P1.x * cp * cos(th1) - P1.y * sp * sin(th1), P1.x * sp * cos(th1) + P1.y * cp * sin(th1));
      vec2 mn = min(e0, e1), mx = max(e0, e1);

      float tx = curveAtan2(-P1.y * sp, P1.x * cp), ty = curveAtan2(P1.y * cp, P1.x * sp);
      for (int k = 0; k < 4; k++) {
        float th = (k < 2 ? tx : ty) + (((k & 1) == 1) ? 3.14159265358979 : 0.0);

        float d = mod(dth >= 0.0 ? th - th0 : th0 - th, 6.28318530717959);
        if (d <= abs(dth)) {
          vec2 e = P0 + vec2(P1.x * cp * cos(th) - P1.y * sp * sin(th), P1.x * sp * cos(th) + P1.y * cp * sin(th));
          mn = min(mn, e); mx = max(mx, e);
        }
      }
      lo = mn - P0; hi = mx - P0;
    }
  } else {

    vec2 ch = P3 - P0;
    float cm = max(abs(ch.x), abs(ch.y));
    if (cm > 0.0) { vec2 chn = ch / cm; ax = chn / length(chn); ay = vec2(-ax.y, ax.x); }
    vec2 q1 = P1 - P0, q2 = P2 - P0, q3 = P3 - P0;
    vec2 u = vec2(dot(q1, ax), dot(q1, ay)), v = vec2(dot(q2, ax), dot(q2, ay)), w = vec2(dot(q3, ax), dot(q3, ay));
    lo = min(min(vec2(0.0), u), min(v, w)); hi = max(max(vec2(0.0), u), max(v, w));
  }
  float emPerPx = globalBBox.z / max(canvasAR.x * viewportSize.x, 1.0);

  float reach = halfW;
  if (joinStyle == 0) {
    float worst = halfW * max(miterLimit, 1.0);
    vec2 dS = P1 - P0, dE = P3 - P2;
    if (segTy == 3) {

      float cp = cos(P2.x), sp = sin(P2.x), sw = (P3.x < P2.y) ? -1.0 : 1.0;
      vec2 vs = sw * vec2(-P1.x * sin(P2.y), P1.y * cos(P2.y));
      vec2 ve = sw * vec2(-P1.x * sin(P3.x), P1.y * cos(P3.x));
      dS = vec2(cp * vs.x - sp * vs.y, sp * vs.x + cp * vs.y);
      dE = vec2(cp * ve.x - sp * ve.y, sp * ve.x + cp * ve.y);
    }

    float dirMin;
    if (segTy == 3) {
      dirMin = 1e-9 * max(abs(P1.x), abs(P1.y));
      if (P1.x == 0.0 || P1.y == 0.0) {
        float cp = cos(P2.x), sp = sin(P2.x);
        vec2 c0 = vec2(P1.x * cos(P2.y), P1.y * sin(P2.y)), c1 = vec2(P1.x * cos(P3.x), P1.y * sin(P3.x)), ch = c1 - c0;
        dS = vec2(cp * ch.x - sp * ch.y, sp * ch.x + cp * ch.y); dE = dS;
      }
    } else {
      vec2 lo4 = min(min(P0, P1), min(P2, P3)), hi4 = max(max(P0, P1), max(P2, P3));
      dirMin = 1e-9 * max(hi4.x - lo4.x, hi4.y - lo4.y);
      if (!(length(dS) > dirMin)) dS = P2 - P1;
      if (!(length(dS) > dirMin)) dS = P3 - P0;
      if (!(length(dE) > dirMin)) dE = P2 - P1;
      if (!(length(dE) > dirMin)) dE = P3 - P0;
    }
    float mS = halfW, mE = halfW;
    if (vFreeStart < 0.5) {
      if (!(length(dS) > dirMin)) mS = worst;
      else { float sh = 0.5 * length(strokeNrm(dS) + vInTan);
             float m = halfW / max(sh, 1.17549435e-38); mS = (m <= worst) ? m : halfW; }
    }
    if (vFreeEnd < 0.5) {
      if (!(length(dE) > dirMin)) mE = worst;
      else { float sh = 0.5 * length(strokeNrm(dE) + vOutTan);
             float m = halfW / max(sh, 1.17549435e-38); mE = (m <= worst) ? m : halfW; }
    }
    reach = max(mS, mE);
  }

  if (capStyle == 2) reach = max(reach, halfW * 1.41421356);
  if (joinStyle == 3 || joinStyle == 4) {
    float ml = max(miterLimit, 1.0);
    reach = max(reach, halfW * sqrt(ml * ml + 1.0));
  }

  float pxEm = emPerPx;
  if (hasWorldM == 1) {
    float st = strokeWorldStretch(P0, worldM, globalBBox, canvasAR, viewportSize);
    if (worldM[0].z != 0.0 || worldM[1].z != 0.0) {
      st = min(st, strokeWorldStretch(P0 + ax * hi.x + ay * lo.y, worldM, globalBBox, canvasAR, viewportSize));
      st = min(st, strokeWorldStretch(P0 + ax * hi.x + ay * hi.y, worldM, globalBBox, canvasAR, viewportSize));
      st = min(st, strokeWorldStretch(P0 + ax * lo.x + ay * hi.y, worldM, globalBBox, canvasAR, viewportSize));
      st = min(st, strokeWorldStretch(P0 + ax * lo.x + ay * lo.y, worldM, globalBBox, canvasAR, viewportSize));
    }

    if (st > 0.0) pxEm = emPerPx / st;
  }
  reach += 3.0 * pxEm;
  lo -= vec2(reach); hi += vec2(reach);
  int ci = int(aCorner + 0.5);
  vec2 k = (ci == 0) ? lo : (ci == 1) ? vec2(hi.x, lo.y) : (ci == 2) ? hi : vec2(lo.x, hi.y);
  return P0 + ax * k.x + ay * k.y;
}

void main() {
  vec2 emPos = strokeVertexSetup(aPrimBase, aCorner,
                                 uHalfW, uMiterLimit, uCapStyle, uJoinStyle, uDashId,
                                 uGlobalBBox, uCanvasAR, uViewportSize, uWorldM, uHasWorldM);
  vEm = emPos;
  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;
  gl_Position = vec4(clip3.xy, 0.0, clip3.z);
}
