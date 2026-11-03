#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

flat in vec2  vP0, vP1, vP2, vP3;
flat in float vHalfW, vMiterLimit;
flat in vec2  vInTan, vOutTan;
flat in float vFreeStart, vFreeEnd;
flat in float vSegType;
flat in int   vCap, vJoin;
flat in float vStartDist;
in vec2 vEm;
out vec4 o;

uniform int       uDashId;
uniform sampler2D uDashTex;

uniform int       uStrokeExactAa;

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

#define STROKE_DASH_ID uDashId

float strokeCoverage() {
  vec2 ePx = fwidth(vEm);

  float pxSize = max(0.5 * (ePx.x + ePx.y), 1e-30);

  vec4 p12 = vec4(vP0 - vEm, vP1 - vEm);
  vec4 p34 = vec4(vP2 - vEm, vP3 - vEm);

  const vec4 curv = vec4(0.0);

  vec2 _mgrad;
  vec4 _eP, _eQ;

  bool fS = vFreeStart > 0.5, fE = vFreeEnd > 0.5;
  strokeSeamSet(vFreeStart, vFreeEnd);
  strokeSeamResolve(STROKE_DASH_ID, pxSize, fS, fE);

  float md;
  if (vSegType > 2.5) {

    md = strokeArcAccum(vEm - vP0, vP1, vP2.x, vP2.y, vP3.x,
                        fS, fE, vCap, vCap,
                        vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                        STROKE_DASH_ID, vStartDist, curv, 1e20, _mgrad, 1e30, _eP, _eQ);
  } else if (vSegType < 0.5) {

    vec2 p1 = p12.xy, p3 = p34.zw, d = p3 - p1;
    float dd = dot(d, d);
    float t = dd > 0.0 ? clamp(dot(-p1, d) / dd, 0.0, 1.0) : 0.0;
    vec2 q = p1 + d * t;
    float thisD = length(q);
    vec2 g = (t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 0.0) ? (-q / thisD) : vec2(0.0);
    float arcLenAtT = (STROKE_DASH_ID > 0) ? t * sqrt(dd) : 0.0;
    md = strokeCapsJoinsDash(t, thisD, p1, p3, d, d,
                             fS, fE, vCap, vCap,
                             vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                             STROKE_DASH_ID, vStartDist, arcLenAtT, curv, 1e20, g, strokeUnit(d),
                             fE ? vStartDist + sqrt(dd) : 1e30, 1e30, _eP, _eQ);
    _mgrad = g;
  } else if (vSegType < 1.5) {
    md = strokeQuadAccum(p12, p34.zw, fS, fE, vCap, vCap,
                         vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                         STROKE_DASH_ID, vStartDist, curv, 1e20, _mgrad, 1e30, _eP, _eQ);
  } else {
    md = strokeCubicAccum(p12, p34, fS, fE, vCap, vCap,
                          vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                          STROKE_DASH_ID, vStartDist, curv, 1e20, _mgrad, 1e30, _eP, _eQ);
  }

  float halfWVis = max(vHalfW, 0.5 * pxSize);
  float weightFade = vHalfW / halfWVis;
  float dfe = md - halfWVis;

  float cov;
  if (uStrokeExactAa != 0 && dot(_mgrad, _mgrad) > 0.5 && dfe <= 0.75 * pxSize) {
    vec2 nUn = _mgrad * ePx;
    float il = inversesqrt(max(dot(nUn, nUn), 1e-30));
    cov = exactBoxCov(nUn * il, -dfe * il) * weightFade;
  } else {
    cov = (dfe <= 0.5 * pxSize) ? clamp(0.5 - dfe / pxSize, 0.0, 1.0) * weightFade : 0.0;
  }
  if (cov <= 0.0) discard;
  return cov;
}

void main() {
  o = vec4(strokeCoverage());
}
