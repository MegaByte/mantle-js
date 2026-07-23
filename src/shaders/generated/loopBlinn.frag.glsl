#version 300 es

precision highp float;

precision highp sampler2D;

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
flat in vec4  vCh2A;
flat in vec4  vCh2B;
#endif
flat in vec2  cCen;
flat in float cScale;
flat in float cHalf;
flat in float vEmPerPx;
flat in float vSeam;
flat in float vGradId;
flat in float vImageId;
flat in vec4 vImgRect;
flat in vec4 vAtlasSlot;
flat in vec4  vShapeBB;
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
      vec4 g = sampleGradient(uGradId, vEm, uShapeBBox);
      paint = vec4(g.rgb * g.a, g.a);
    } else if (vImageId > 0.5) {

      vec4 t = sampleImageLB(vEm, vImgRect, vAtlasSlot) * vColor;
      paint = vec4(t.rgb * t.a, t.a);
    } else if (vGradId > 0.5) {

      vec4 g = sampleGradient(int(vGradId + 0.5), vEm, vShapeBB);
      paint = vec4(g.rgb * g.a, g.a);
    } else {
      vec4 f = lbRecolor(vColor);
      paint = vec4(f.rgb * f.a, f.a);
    }
    return paint * (uAlpha * cov);
  }
  return vec4(cov);
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

float slugCov(float f, vec2 grad) {
  float g = max(length(grad), 1e-6);
  return exactBoxCov(grad / g, -f / g);
}

float curveCov(float f, float fx, float fy, float fxx, float fyy, float fxy) {
  vec2 grad = vec2(fx, fy);
  float g = max(length(grad), 1e-6);
  float kPx = (fxx * fy * fy - 2.0 * fxy * fx * fy + fyy * fx * fx) / (g * g * g);

  kPx = clamp(kPx, -2.0, 2.0);
  return exactBoxCov(grad / g, -f / g - kPx / 24.0);
}

void main() {

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
    else {

      float nDotA = dot(nOwn, vNa);
      bool acuteA = tyA > 0.5 && nDotA < -0.35;
      vec2 sumA = nOwn + vNa;
      bool degenA = dot(sumA, sumA) < 0.08;
      bool tipA = acuteA && fOwn > 0.0 && length(rA) < 2.2 * vEmPerPx;
      if (!(tipA && (acuteA || degenA))) {
        wA = degenA ? vec2(-nOwn.y, nOwn.x) : vec2(-sumA.y, sumA.x);
        if (dot(wA, tdk) < 0.0) wA = -wA;
        if (dot(rA, wA) < 0.0) discard;
      }
    }
    if (curveB) { wB = vec2(-vNb.y, vNb.x) * (tsB > 0.5 ? 1.0 : -1.0);
      if (dot(rB, wB) >= 0.0 && length(rB) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else {
      float nDotB = dot(nOwn, vNb);
      bool acuteB = tyB > 0.5 && nDotB < -0.35;

      if (acuteB && fOwn > 0.0 && dot(vNb, rB) > 0.0 && length(rB) < 2.2 * vEmPerPx) discard;
      else {
        vec2 sumB = nOwn + vNb;
        bool degenB = dot(sumB, sumB) < 0.08;
        wB = degenB ? vec2(-nOwn.y, nOwn.x) : vec2(-sumB.y, sumB.x);
        if (dot(wB, tdk) < 0.0) wB = -wB;
        if (dot(rB, wB) >= 0.0) discard;
      }
    }
    float fA = dot(vNa, rA) - 0.5 * vTC.y * dot(rA, rA);
    float fB = dot(vNb, rB) - 0.5 * vTC.z * dot(rB, rB);

    float tipGateA = (tyA > 0.5 && !curveA && dot(nOwn, vNa) < -0.35) ? 2.2 : 2.0;
    float tipGateB = (tyB > 0.5 && !curveB && dot(nOwn, vNb) < -0.35) ? 2.2 : 2.0;
    float gA = clamp((tipGateA - length(rA) / vEmPerPx) / 1.5, 0.0, 1.0);
    float gB = clamp((tipGateB - length(rB) / vEmPerPx) / 1.5, 0.0, 1.0);

    if (fOwn < -1.2 * vEmPerPx) discard;
    float sOwn = fOwn < -0.012 * vEmPerPx ? 1.0 : 0.0;
    float sA = fA < 0.0 ? 1.0 : 0.0, sB = fB < 0.0 ? 1.0 : 0.0;
    float sAe = tyA > 0.5 ? (gA > 0.01 ? sA : 1.0) : (gA > 0.01 ? sA : 0.0);
    float sBe = tyB > 0.5 ? (gB > 0.01 ? sB : 1.0) : (gB > 0.01 ? sB : 0.0);
    float insid = sOwn;
    insid = tyA > 0.5 ? min(insid, sAe) : (tyA < -0.5 ? max(insid, sAe) : insid);
    insid = tyB > 0.5 ? min(insid, sBe) : (tyB < -0.5 ? max(insid, sBe) : insid);
    if (insid > 0.5) discard;

    float invPx10 = 1.0 / max(vEmPerPx, 1e-12);
    float dOwn10 = -fOwn * invPx10;
    float c10 = exactBoxCov(nOwn, dOwn10);
    float cOwnP10 = c10;
    if (abs(tyA) > 0.5) {
      vec2 nA10 = vNa / max(length(vNa), 1e-9);
      float dA10 = -fA * invPx10;
      float cA10 = exactBoxCov(nA10, dA10);
      float interA = exactBoxCov2(nOwn, dOwn10, nA10, dA10);
      float kpA = max(0.0, dot(nOwn, vNa));
      float exA = tyA > 0.0
        ? mix(clamp(c10 + interA - cOwnP10, 0.0, 1.0), min(c10, cA10), kpA)
        : mix(clamp(c10 + cA10 - interA, 0.0, 1.0), max(c10, cA10), kpA);
      c10 = mix(c10, exA, gA);
    }
    if (abs(tyB) > 0.5) {
      vec2 nB10 = vNb / max(length(vNb), 1e-9);
      float dB10 = -fB * invPx10;
      float cB10 = exactBoxCov(nB10, dB10);
      float interB = exactBoxCov2(nOwn, dOwn10, nB10, dB10);
      float kpB = max(0.0, dot(nOwn, vNb));
      float exB = tyB > 0.0
        ? mix(clamp(c10 + interB - cOwnP10, 0.0, 1.0), min(c10, cB10), kpB)
        : mix(clamp(c10 + cB10 - interB, 0.0, 1.0), max(c10, cB10), kpB);
      c10 = mix(c10, exB, gB);
    }

    if (c10 < 0.004) discard;

    if (fOwn < 0.0 && c10 < 0.999) discard;
    o = emit(c10);
    return;
  }
#ifndef MANTLE_NO_BEZOUT

  if (vKind > 11.5 && vKind < 12.5) {
    float mag12 = abs(vSign);
    float s12 = vSign >= 0.0 ? 1.0 : -1.0;
    bool cubic12 = false;
    if (mag12 >= 8192.0) { cubic12 = true; mag12 -= 8192.0; }
    if (mag12 >= 4096.0) mag12 -= 4096.0;
    float spanB12 = 0.0, spanA12 = 0.0;
    if (mag12 >= 2048.0) { spanB12 = 1.0; mag12 -= 2048.0; }
    if (mag12 >= 1024.0) { spanA12 = 1.0; mag12 -= 1024.0; }
    float codeA = floor((mag12 + 0.5) / 16.0), codeB = mag12 - codeA * 16.0;
    float tyA = floor((codeA + 0.5) / 4.0) - 1.0; bool curveA = mod(codeA, 4.0) >= 1.5;
    float tyB = floor((codeB + 0.5) / 4.0) - 1.0; bool curveB = mod(codeB, 4.0) >= 1.5;
    vec2 a12 = cCen, b12 = vec2(cScale, cHalf);
    vec2 rA = vEm - a12, rB = vEm - b12;
    vec2 nA12 = cM01.yz, nB12 = cM02.xy;

    vec2 nOA = unpackHalf2x16(floatBitsToUint(cM02.z));
    vec2 nOB = unpackHalf2x16(floatBitsToUint(cM11a));
    float kA12 = cM12, kB12 = cM22;
    bool ends12 = cubic12 && dot(a12, a12) + dot(b12, b12) > 0.0;
    if (cubic12 && !ends12) {
      float k12 = vTC.x, l12 = vTC.y, m12 = vTC.z;
      float f12c = s12 * (k12 * k12 * k12 - l12 * m12);
      vec3 tx12c = dFdx(vTC), ty12c = dFdy(vTC);
      float fx12c = s12 * (3.0 * k12 * k12 * tx12c.x - (tx12c.y * m12 + l12 * tx12c.z));
      float fy12c = s12 * (3.0 * k12 * k12 * ty12c.x - (ty12c.y * m12 + l12 * ty12c.z));
      float fxx12c = s12 * (6.0 * k12 * tx12c.x * tx12c.x - 2.0 * tx12c.y * tx12c.z);
      float fyy12c = s12 * (6.0 * k12 * ty12c.x * ty12c.x - 2.0 * ty12c.y * ty12c.z);
      float fxy12c = s12 * (6.0 * k12 * tx12c.x * ty12c.x - (tx12c.y * ty12c.z + ty12c.y * tx12c.z));
      float c12c = curveCov(f12c, fx12c, fy12c, fxx12c, fyy12c, fxy12c);
      if (c12c < 0.999 && f12c < 0.0) discard;
      if (c12c < 0.004) discard;
      o = emit(c12c);
      return;
    }

    float u12 = vTC.x, v12 = vTC.y, r12 = vTC.z;
    if (!cubic12 && abs(r12 - 1.0) < 1e-3 && v12 >= 0.0 && u12 >= v12 && 1.0 - 2.0 * u12 + v12 >= 0.0) discard;
    vec2 sA12 = vec2(-nOA.y, nOA.x) * (spanA12 > 0.5 ? 1.0 : -1.0);
    vec2 sB12 = vec2(-nOB.y, nOB.x) * (spanB12 > 0.5 ? 1.0 : -1.0);

    float f12, fx12, fy12, fxx12, fyy12, fxy12;
    if (cubic12) {
      float k12 = u12, l12 = v12, m12 = r12;
      f12 = s12 * (k12 * k12 * k12 - l12 * m12);
      vec3 tx12 = dFdx(vTC), ty12 = dFdy(vTC);
      fx12 = s12 * (3.0 * k12 * k12 * tx12.x - (tx12.y * m12 + l12 * tx12.z));
      fy12 = s12 * (3.0 * k12 * k12 * ty12.x - (ty12.y * m12 + l12 * ty12.z));
      fxx12 = s12 * (6.0 * k12 * tx12.x * tx12.x - 2.0 * tx12.y * tx12.z);
      fyy12 = s12 * (6.0 * k12 * ty12.x * ty12.x - 2.0 * ty12.y * ty12.z);
      fxy12 = s12 * (6.0 * k12 * tx12.x * ty12.x - (tx12.y * ty12.z + ty12.y * tx12.z));
    } else {
      f12 = s12 * (u12 * u12 - v12 * r12);
      vec3 tx12 = dFdx(vTC), ty12 = dFdy(vTC);
      fx12 = s12 * (2.0 * u12 * tx12.x - (tx12.y * r12 + v12 * tx12.z));
      fy12 = s12 * (2.0 * u12 * ty12.x - (ty12.y * r12 + v12 * ty12.z));
      fxx12 = s12 * (2.0 * tx12.x * tx12.x - 2.0 * tx12.y * tx12.z);
      fyy12 = s12 * (2.0 * ty12.x * ty12.x - 2.0 * ty12.y * ty12.z);
      fxy12 = s12 * (2.0 * tx12.x * ty12.x - (tx12.y * ty12.z + ty12.y * tx12.z));
    }
    float dpx12 = f12 / max(length(vec2(fx12, fy12)), 1e-6);

    bool chainA = abs(tyA) > 0.5, chainB = abs(tyB) > 0.5;
    if (!chainA) { if (dot(rA, sA12) < 0.0) discard; }
    else {
      vec2 bisA = nOA + nA12;
      if (dot(bisA, bisA) > 1e-6) {
        vec2 wA12 = vec2(-bisA.y, bisA.x);
        if (dot(rA, wA12) * dot(wA12, sA12) < 0.0) discard;
      } else if (dot(rA, sA12) < 0.0) discard;
    }
    if (!chainB) { if (dot(rB, sB12) < 0.0) discard; }
    else {
      vec2 bisB = nOB + nB12;
      if (dot(bisB, bisB) > 1e-6) {
        vec2 wB12 = vec2(-bisB.y, bisB.x);
        if (dot(rB, wB12) * dot(wB12, sB12) <= 0.0) discard;
      } else if (dot(rB, sB12) < 0.0) discard;
    }
    bool wgA = chainA && dot(rA, sA12) < 0.0;
    bool wgB = chainB && dot(rB, sB12) < 0.0;

    float fA12 = dot(nA12, rA) - 0.5 * kA12 * dot(rA, rA);
    float fB12 = dot(nB12, rB) - 0.5 * kB12 * dot(rB, rB);
    float gL12 = max(length(vec2(fx12, fy12)), 1e-6);
    float kOwnS12 = (fxx12 * fy12 * fy12 - 2.0 * fxy12 * fx12 * fy12 + fyy12 * fx12 * fx12) / (gL12 * gL12 * gL12);
    float kOwnPx = abs(kOwnS12);
    float invPx12 = 1.0 / max(vEmPerPx, 1e-12);
    float fOwn12;
    vec2 nOwn12;
    float dOwn12;
    if (wgA || wgB) {
      vec2 nOw = wgA ? nOA : nOB;
      vec2 rw = wgA ? rA : rB;
      float nOwL = max(length(nOw), 1e-9);
      fOwn12 = dot(nOw, rw);
      nOwn12 = nOw / nOwL;
      dOwn12 = -fOwn12 / (nOwL * max(vEmPerPx, 1e-12));
    } else {
      fOwn12 = f12;
      nOwn12 = vec2(fx12, fy12) / gL12;
      dOwn12 = -f12 / gL12 - clamp(kOwnS12, -2.0, 2.0) / 24.0;
    }
    float cOwn12 = exactBoxCov(nOwn12, dOwn12);
    float rgA12 = 0.5 / max(max(abs(kA12), 1e-6) * vEmPerPx, max(kOwnPx, 1e-6));
    float rgB12 = 0.5 / max(max(abs(kB12), 1e-6) * vEmPerPx, max(kOwnPx, 1e-6));
    float gA12 = clamp(rgA12 - length(rA) / vEmPerPx, 0.0, 1.0);
    float gB12 = clamp(rgB12 - length(rB) / vEmPerPx, 0.0, 1.0);
    bool cnA = abs(tyA) > 0.5, cnB = abs(tyB) > 0.5;
    float sOwn12 = fOwn12 < 0.0 ? 1.0 : 0.0;
    float sA12i = fA12 < 0.0 ? 1.0 : 0.0, sB12i = fB12 < 0.0 ? 1.0 : 0.0;
    float sAe12 = tyA > 0.5 ? (gA12 > 0.0 ? sA12i : 1.0) : (gA12 > 0.0 ? sA12i : 0.0);
    float sBe12 = tyB > 0.5 ? (gB12 > 0.0 ? sB12i : 1.0) : (gB12 > 0.0 ? sB12i : 0.0);
    float insid12 = sOwn12;
    if (cnA) insid12 = tyA > 0.5 ? min(insid12, sAe12) : max(insid12, sAe12);
    if (cnB) insid12 = tyB > 0.5 ? min(insid12, sBe12) : max(insid12, sBe12);
    if (insid12 > 0.5) discard;

    float c12 = cOwn12;
    if (cnA) {
      vec2 nAn12 = nA12 / max(length(nA12), 1e-9);
      float dA12 = -fA12 * invPx12;
      float cA12 = exactBoxCov(nAn12, dA12);
      float interA12 = exactBoxCov2(nOwn12, dOwn12, nAn12, dA12);
      float kpA12 = max(0.0, dot(nOA, nA12));
      float exA12 = tyA > 0.0
        ? mix(clamp(c12 + interA12 - cOwn12, 0.0, 1.0), min(c12, cA12), kpA12)
        : mix(clamp(c12 + cA12 - interA12, 0.0, 1.0), max(c12, cA12), kpA12);
      c12 = mix(c12, exA12, gA12);
    }
    if (cnB) {
      vec2 nBn12 = nB12 / max(length(nB12), 1e-9);
      float dB12 = -fB12 * invPx12;
      float cB12 = exactBoxCov(nBn12, dB12);
      float interB12 = exactBoxCov2(nOwn12, dOwn12, nBn12, dB12);
      float kpB12 = max(0.0, dot(nOB, nB12));
      float exB12 = tyB > 0.0
        ? mix(clamp(c12 + interB12 - cOwn12, 0.0, 1.0), min(c12, cB12), kpB12)
        : mix(clamp(c12 + cB12 - interB12, 0.0, 1.0), max(c12, cB12), kpB12);
      c12 = mix(c12, exB12, gB12);
    }
    if (c12 <= 0.0) discard;
    /* In-span exterior-band contract: fill-side partials are interior turf.
       Wedges use the two-plane ownership test above instead. */
    if (!wgA && !wgB && f12 < 0.0 && c12 < 0.999) discard;
    /* Counter-hole chord ribbons extrude into the empty region; UV
       extrapolation can then paint mid-gray far past the arc while dpx still
       reads "near". Gate on s12<0: nested counters use sign -1 when ink sits
       on the control side; outer bowls keep their bulge AA past the chord. */
    if (!wgA && !wgB && fOwn12 >= 0.0 && s12 < 0.0) {
      vec2 ab = b12 - a12;
      float abL2 = max(dot(ab, ab), 1e-12);
      float t = clamp(dot(rA, ab) / abL2, 0.0, 1.0);
      float dChord = length(rA - ab * t) / max(vEmPerPx, 1e-9);
      if (dChord > 1.5 && abs(dpx12) < 1.0) discard;
      if (dChord > 1.2 && abs(dpx12) < 0.7 && c12 < 0.95) discard;
    }
    /* Near-zero exterior coverage that conflicts with a neighboring linear
       interior can still reject solid interior. Keep this threshold below the
       AA midpoint so ordinary exterior ramps continue to paint. */
    if (!wgA && !wgB && fOwn12 >= 0.0 && c12 < 0.12) {
      if (gA12 > 0.0 && dot(nA12, rA) < 0.0) discard;
      if (gB12 > 0.0 && dot(nB12, rB) < 0.0) discard;
    }
    o = emit(c12);
    return;
  }
#endif

  if (vKind > 12.5 && vKind < 13.5) {
    float invE = 1.0 / max(vEmPerPx, 1e-12);
    vec2 c0 = (cCen - vEm) * invE;
    vec2 c1 = (vec2(cScale, cHalf) - vEm) * invE;
    vec2 c2 = (vLine2.xy - vEm) * invE;
    vec2 c3 = (vec2(vLine2.z, vLineT) - vEm) * invE;
    o = emit(chainBoxCov(c0, c1, c2, c3, c3, 0.0));
    return;
  }

  if (vKind < 0.5) {

    if (vTC.x > 1.5) {
      float invE = 1.0 / max(vEmPerPx, 1e-12);
      vec2 c0 = (cCen - vEm) * invE;
      vec2 c1 = (vec2(cScale, cHalf) - vEm) * invE;
      vec2 c2 = (vLine2.xy - vEm) * invE;
      vec2 c3 = (vec2(vLine2.z, vLineT) - vEm) * invE;
      vec2 c4 = (vTC.yz - vEm) * invE;

      float cov = vTC.x > 2.5
        ? conicChainBoxCov(c0, c1, c2, c3, c4, 2.0)
        : chainBoxCov(c0, c1, c2, c3, c4, 2.0);
#ifndef MANTLE_NO_BEZOUT

      if (any(notEqual(vCh2A, vec4(0.0))) || any(notEqual(vCh2B, vec4(0.0)))) {
        vec2 d0 = (vCh2A.xy - vEm) * invE;
        vec2 d1 = (vCh2A.zw - vEm) * invE;
        vec2 d2 = (vCh2B.xy - vEm) * invE;
        vec2 d3 = (vCh2B.zw - vEm) * invE;
        cov = min(cov, chainBoxCov(d0, d1, d2, d3, d3, 1.0));
      }
#endif
      o = emit(cov);
      return;
    }
    if (dot(cCen, cCen) > 1e-9) {
      float fi = dot(cCen, vEm) - cScale;

      float cA = slugCov(fi, cCen * vEmPerPx);

      if (abs(vLineT) > 0.5) {
        float fiB = dot(vLine2.xy, vEm) - vLine2.z;
        float cB = slugCov(fiB, vLine2.xy * vEmPerPx);
        float invPx = 1.0 / max(vEmPerPx, 1e-12);
        float inter = exactBoxCov2(cCen, -fi * invPx, vLine2.xy, -fiB * invPx);
        cA = vLineT > 0.0 ? inter : (cA + cB - inter);
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
  if (vKind < 2.5) {

    f = vSign * (vTC.x * vTC.x * vTC.x - vTC.y * vTC.z);
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

    f = (vSign > 0.0 ? 1.0 : -1.0) * (vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 7.5) {

    vec2 d7 = vEm - cCen;
    vec2 G7, W7;
    float w7;
    if (cHalf < -1.5) {
      float rx7 = max(cScale, 1e-9), ry7 = max(vNa.x, 1e-9);
      float c7 = vNa.y, s7 = vNb.x;
      vec2 q7 = vec2((d7.x * c7 + d7.y * s7) / rx7, (-d7.x * s7 + d7.y * c7) / ry7);
      float Lq7 = max(length(q7), 1e-9);
      f = vSign * (Lq7 - 1.0);
      vec2 qh7 = q7 / Lq7, th7 = vec2(-qh7.y, qh7.x);
      G7 = vSign * vec2(qh7.x * c7 / rx7 - qh7.y * s7 / ry7, qh7.x * s7 / rx7 + qh7.y * c7 / ry7);
      W7 = vec2(th7.x * c7 / rx7 - th7.y * s7 / ry7, th7.x * s7 / rx7 + th7.y * c7 / ry7);
      w7 = vSign / Lq7;
    } else {
      float L7 = max(length(d7), 1e-9);
      vec2 dh7 = d7 / L7;
      float sig7 = 1.0, halfW7 = 0.0;
      if (vKind > 6.5 && cHalf >= 0.0) { sig7 = L7 >= cScale ? 1.0 : -1.0; halfW7 = cHalf; }
      f = vSign * (sig7 * (L7 - cScale) - halfW7);
      G7 = (vSign * sig7) * dh7;
      W7 = vec2(-dh7.y, dh7.x);
      w7 = vSign * sig7 / L7;
    }

    vec2 emx7 = dFdx(vEm), emy7 = dFdy(vEm);
    float fx7 = dot(G7, emx7), fy7 = dot(G7, emy7);
    float wx7 = dot(W7, emx7), wy7 = dot(W7, emy7);
    float cov7 = curveCov(f, fx7, fy7, w7 * wx7 * wx7, w7 * wy7 * wy7, w7 * wx7 * wy7);

    if (cov7 < 0.004) discard;
    o = emit(cov7);
    return;
  } else {

    f = 0.0;
  }

  float cov;
  bool isCubic = vKind > 1.5 && vKind < 2.5;
  bool isRquad = vKind > 4.5 && vKind < 5.5;
  if (isCubic && vSeam > 0.5 && vSeam < 5.0) {

    vec2 a = cCen, b = vec2(cScale, cHalf);

    float clipEpsC = 0.05 * vEmPerPx;
    if (dot(vEm - a, vNa) < -clipEpsC || dot(vEm - b, vNb) < -clipEpsC) discard;
  } else if (isRquad) {

    vec2 a = cCen, b = vec2(cScale, cHalf), ch = b - a;
    if (dot(ch, ch) > 1e-9 && (dot(vEm - a, ch) < 0.0 || dot(vEm - b, ch) > 0.0)) discard;
  }
  if (isCubic || isRquad) {
    vec3 tx = dFdx(vTC), ty = dFdy(vTC);
    float fx, fy, fxx, fyy, fxy;
    if (isCubic) {
      float k = vTC.x, l = vTC.y, m = vTC.z;
      fx = vSign * (3.0 * k * k * tx.x - (tx.y * m + l * tx.z));
      fy = vSign * (3.0 * k * k * ty.x - (ty.y * m + l * ty.z));
      fxx = vSign * (6.0 * k * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (6.0 * k * ty.x * ty.x - 2.0 * ty.y * ty.z);
      fxy = vSign * (6.0 * k * tx.x * ty.x - (tx.y * ty.z + ty.y * tx.z));
    } else {
      float s5 = vSign > 0.0 ? 1.0 : -1.0;
      float U = vTC.x, V = vTC.y, Rr = vTC.z;
      fx = s5 * (2.0 * U * tx.x - (tx.y * Rr + V * tx.z));
      fy = s5 * (2.0 * U * ty.x - (ty.y * Rr + V * ty.z));
      fxx = s5 * (2.0 * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = s5 * (2.0 * ty.x * ty.x - 2.0 * ty.y * ty.z);
      fxy = s5 * (2.0 * tx.x * ty.x - (tx.y * ty.z + ty.y * tx.z));
    }
    cov = curveCov(f, fx, fy, fxx, fyy, fxy);
    if (isRquad && abs(vSign) > 2.0) {

      float s5 = vSign > 0.0 ? 1.0 : -1.0;
      float gC = s5 * (vTC.y - vTC.x);
      vec2  gG = s5 * vec2(tx.y - tx.x, ty.y - ty.x);
      cov = min(cov, slugCov(gC, gG));
    }
  } else {
    if (f4has) {

      vec2 emx = dFdx(vEm), emy = dFdy(vEm);
      float fx4 = dot(f4gEm, emx), fy4 = dot(f4gEm, emy);
      float fxx4 = dot(dFdx(f4gEm), emx), fyy4 = dot(dFdy(f4gEm), emy);
      float fxy4 = dot(dFdy(f4gEm), emx);
      cov = curveCov(f, fx4, fy4, fxx4, fyy4, fxy4);
#ifdef MANTLE_DEBUG_K4
      float dpx = f / max(length(vec2(fx4, fy4)), 1e-12);
      o = vec4(clamp(0.5 + dpx * 0.25, 0.0, 1.0), clamp(0.5 + fxx4 * 2.0, 0.0, 1.0), cov, 1.0);
      return;
#endif
    } else {

      cov = slugCov(f, vec2(dFdx(f), dFdy(f)));
    }
  }

  if (isCubic && vSeam > 5.0 && cov < 0.999 && f < 0.0) discard;

  if (cov < 0.004) discard;
  o = emit(cov);
}
