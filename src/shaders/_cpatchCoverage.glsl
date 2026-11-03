// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPatch analytic coverage on the unified fill vertex stream.
// Kind 14 selects this kernel; engine accounting remains separate from Loop-Blinn.

#define CP_STREAM_TAG    14.0
#define CP_IS_CPATCH_VERTEX (vKind > CP_STREAM_TAG - 0.5 && vKind < CP_STREAM_TAG + 0.5)

#ifdef MANTLE_CPATCH



#define CP_AA_REACH 0.7072   // half a pixel box's widest projection: past this exactBoxCov saturates
// How far past a seam a patch claims. Two patches sharing a seam evaluate it at the same
// point in exact negation -- a line seam by construction, and a curved one because it packs one implicit
// on both sides (see cpatchPack) -- so what can still leave a point to neither is the POSITION: the rasterizer
// interpolates vEm from each patch's own triangles, which rounds differently. That is 16 unit
// roundoffs of the fragment's coordinates in the contour's frame, CP_POS_REL (|p.x| + |p.y|):
// a statement about the coordinates, the same at every scale.
//
#define CP_POS_REL 9.5367432e-7
#define CP_CUT_TIE 0.0009765625
// THE ARC HAS THREE CONTROL POINTS, in bit 5 of the kind. Must match CPK_ARC3 in cpatchPack.js.
#define CP_ARC3 32.0
// A SEAM THAT CARRIES ITS COMPANION, the outline running closest along it on the far side:
// CP_COMP added to the cut's kind word, twice over for a companion with three control points.
// Must match CPK_COMP in cpatchPack.js.
#define CP_COMP 64.0
// A horn arc: bits 12-14 of the kind word -- the arc ends at its own curve's cusp at t = 0 (1), at
// t = 1 (2), and the patch's inside is on its right (4). Must match CPK_HORN0/1/_RIGHT in cpatchPack.js.
#define CP_HORN 4096.0
// A morph's corners: bits 8-11 of the kind word on a morph pack's outline curves -- its start (bit 8) and its
// end (bit 9) are seam corners a static skirt would square off, and its start (bit 10) and end (bit 11) turn onto another
// outline curve (cpatchCov.markSeamCorners). A static pack writes none. Must match CPK_END in cpatchPack.js.
#define CP_END 256.0
// A complete-paint curve: bit 17, and bit 18 for a clockwise boundary. Must match CPK_AREA in cpatchPack.js.
#define CP_AREA 131072.0
#define CP_AREA_RIGHT 262144.0
#ifndef CP_CLAIM_MIN
#define CP_CLAIM_MIN 0.15
#endif
#ifndef CP_HULL16_DILATE
#define CP_HULL16_DILATE 0.0
#endif
// How far a patch must already be off full coverage to count as standing on a real edge, which is
// what lets a seam ramp there. See the composition below.
#define CP_SEAM_NEAR 0.5
// How far outside the patch's own box a fragment may still paint: the filter's own reach, which is
// the distance past which exactBoxCov saturates, so the box can never clip an AA band and there is
// no free parameter to choose. Swept anyway -- 0.71 / 1.0 / 1.6 give painted outside 40 / 41 / 41
// with wrong solid and AA unmoved, so the residual leak is INSIDE the box, not escaping past it.
#ifndef CP_BOX_SLACK
#define CP_BOX_SLACK CP_AA_REACH
#endif
#ifndef CP_HULLVAR_BIAS
#define CP_HULLVAR_BIAS 0.0
#endif

#ifndef CP_HULL_AGREE
#define CP_HULL_AGREE 0.0015
#endif
///
/// Three paths rather than one elevated cubic, and the cheapest is the common one: a polynomial
/// quadratic costs no divide, where the rational form pays one per evaluation and cpArcDist runs
/// sixteen of them per band fragment. g0 = (P0, P1); g1 = (P2, P3) for a cubic, (P2, w, 0) for a
/// three-point arc. Twin of arcEval in cpatchCov.js.
void cpArcEval(vec4 g0, vec4 g1, bool arc3, float t, out vec2 b, out vec2 d) {
  float u = 1.0 - t;
  if (arc3) {
    float w = g1.z;
    if (w == 1.0) {
      vec3 bb = vec3(u * u, 2.0 * u * t, t * t);
      b = bb.x * g0.xy + bb.y * g0.zw + bb.z * g1.xy;
      d = (2.0 * u) * (g0.zw - g0.xy) + (2.0 * t) * (g1.xy - g0.zw);
      return;
    }
    vec3 bb = vec3(u * u, 2.0 * u * t * w, t * t);
    vec2 h = bb.x * g0.xy + bb.y * g0.zw + bb.z * g1.xy;
    float hw = bb.x + bb.y + bb.z;
    vec3 db = vec3(-2.0 * u, 2.0 * w * (1.0 - 2.0 * t), 2.0 * t);
    vec2 dh = db.x * g0.xy + db.y * g0.zw + db.z * g1.xy;
    float dw = db.x + db.y + db.z;
    float iw = hw != 0.0 ? 1.0 / hw : 0.0;      // a zero divisor, not a magnitude
    b = h * iw;
    d = (dh - b * dw) * iw;
    return;
  }
  vec4 bb = vec4(u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
  b = bb.x * g0.xy + bb.y * g0.zw + bb.z * g1.xy + bb.w * g1.zw;
  vec3 cb = vec3(3.0 * u * u, 6.0 * u * t, 3.0 * t * t);
  d = cb.x * (g0.zw - g0.xy) + cb.y * (g1.xy - g0.zw) + cb.z * (g1.zw - g1.xy);
}
///
/// Green's theorem: the area of a convex region is half the sum, over the lines bounding it, of each
/// line's offset d/|n| times the length of it the other constraints leave standing. Parametrising
/// the line as p + s rot90(n) with n.p = d makes that length |n|(s1 - s0), so a line contributes
/// d(s1 - s0)/2 and no normalization is needed; the box's four sides are four more lines at d = 1/2.
/// Each length is an interval clip -- one min or max per constraint -- so this is straight-line
/// arithmetic: no array, no loop, no data-dependent vertex count. The two areas share every clip
/// by the first two planes, and the third plane's clip is one more per line.
///
/// Exact ties are broken by moving the k-th half-plane inward by (k+1) 2e-6 px. A constraint lying
/// exactly on a box side or on another constraint otherwise counts the shared segment from both
/// lines -- or, facing the other way, fails to cancel it (0.25 of error on a zero-width sliver) --
/// and a pixel-aligned edge makes that tie routine. The shift moves the area by about 1e-5, far
/// below a coverage step. An ABSENT plane is n = 0, d = 1: it clips nothing and has no line.
/// WHERE TWO PLANES MEET IS ONE POINT, and it is computed once. With each line's length an interval
/// clip of its own, a pair of nearly coincident planes -- a curve and its neighbor along the same
/// edge, within a few 1e-6 px and 1e-7 rad of each other, which CPatch's two tightest constraints
/// often are -- would locate their crossing twice, from numerators at float32's noise floor, and
/// the gap between the two segments would be area nobody counts (a large share of a small sliver's
/// true area). A Sutherland-Hodgman clip does not have this, since a vertex is made once and used by
/// both edges. So the crossing is found on the first line and
/// carried to the second through the point itself (cpGreenMap); only a pair parallel to float32
/// (|n2.t1| < 1e-8) keeps its per-line test, where the tie-break has already put one plane strictly
/// inside the other and the answer is all of the line or none of it.
/// ...AND WHICH SIDE OF IT each LINE KEEPS IS ONE SIGN. n1.t2 is -(n2.t1) exactly, but taken from
/// a dot product of its own on each line, a GPU that fuses the multiply-add rounds the two
/// differently, so for a pair within float32's floor of parallel they can come back with the same
/// sign: both lines keep the same side of the crossing, and the second line's share is counted or
/// dropped whole. So the carried crossing brings the negated sign.
float cpGreenCross(vec2 p, vec2 t, vec2 n, float d, out float a) {
  a = dot(n, t);
  a = abs(a) < 1e-8 ? (a < 0.0 ? -1e-8 : 1e-8) : a;   // parallel: keeps all of the line or none
  return (d - dot(n, p)) / a;
}
void cpGreenKeep(float a, float r, inout float s0, inout float s1) {
  if (a > 0.0) s1 = min(s1, r); else s0 = max(s0, r);
}
float cpGreenMap(vec2 pa, vec2 ta, float r, vec2 pb, vec2 tb) {
  return dot(pa + r * ta - pb, tb) / dot(tb, tb);
}
/// The parameter interval of the line p + s t inside the pixel box.
void cpGreenSlab(vec2 p, vec2 t, out float s0, out float s1) {
  vec2 q = vec2(abs(t.x) < 1e-8 ? (t.x < 0.0 ? -1e-8 : 1e-8) : t.x,
                abs(t.y) < 1e-8 ? (t.y < 0.0 ? -1e-8 : 1e-8) : t.y);
  vec2 lo = (vec2(-0.5) - p) / q, hi = (vec2(0.5) - p) / q;
  vec2 mn = min(lo, hi), mx = max(lo, hi);
  s0 = max(mn.x, mn.y); s1 = min(mx.x, mx.y);
}
/// One box side's share of both areas: its extent under planes 1 and 2, then under 3 as well.
void cpGreenSide(vec2 nb, vec2 n1, float d1, vec2 n2, float d2, vec2 n3, float d3, inout float a2, inout float a3) {
  vec2 p = 0.5 * nb, t = vec2(-nb.y, nb.x);
  float s0 = -0.5, s1 = 0.5, a, r;
  r = cpGreenCross(p, t, n1, d1, a); cpGreenKeep(a, r, s0, s1);
  r = cpGreenCross(p, t, n2, d2, a); cpGreenKeep(a, r, s0, s1);
  a2 += 0.25 * max(0.0, s1 - s0);
  r = cpGreenCross(p, t, n3, d3, a); cpGreenKeep(a, r, s0, s1);
  a3 += 0.25 * max(0.0, s1 - s0);
}
float cpExactBoxCov23(vec2 n1, float d1, vec2 n2, float d2, vec2 n3, float d3, bool third, out float area2) {
  d1 -= 2e-6 * length(n1); d2 -= 4e-6 * length(n2); d3 -= 6e-6 * length(n3);
  float a2 = 0.0, a3 = 0.0;
  cpGreenSide(vec2(1.0, 0.0), n1, d1, n2, d2, n3, d3, a2, a3);
  cpGreenSide(vec2(0.0, 1.0), n1, d1, n2, d2, n3, d3, a2, a3);
  cpGreenSide(vec2(-1.0, 0.0), n1, d1, n2, d2, n3, d3, a2, a3);
  cpGreenSide(vec2(0.0, -1.0), n1, d1, n2, d2, n3, d3, a2, a3);
  bool has2 = dot(n2, n2) > 0.0;
  vec2 p1 = n1 * (d1 / dot(n1, n1)), t1 = vec2(-n1.y, n1.x);
  vec2 p2 = has2 ? n2 * (d2 / dot(n2, n2)) : vec2(0.0), t2 = vec2(-n2.y, n2.x);
  float s0, s1, a12, a13, a21, a23;
  float r12 = cpGreenCross(p1, t1, n2, d2, a12), r13 = cpGreenCross(p1, t1, n3, d3, a13);
  cpGreenSlab(p1, t1, s0, s1); cpGreenKeep(a12, r12, s0, s1);
  a2 += 0.5 * d1 * max(0.0, s1 - s0);
  cpGreenKeep(a13, r13, s0, s1);
  a3 += 0.5 * d1 * max(0.0, s1 - s0);
  float r23 = 0.0;
  if (has2) {
    float r21 = cpGreenCross(p2, t2, n1, d1, a21);
    if (abs(dot(n2, t1)) >= 1e-8) { r21 = cpGreenMap(p1, t1, r12, p2, t2); a21 = -a12; }
    r23 = cpGreenCross(p2, t2, n3, d3, a23);
    cpGreenSlab(p2, t2, s0, s1); cpGreenKeep(a21, r21, s0, s1);
    a2 += 0.5 * d2 * max(0.0, s1 - s0);
    cpGreenKeep(a23, r23, s0, s1);
    a3 += 0.5 * d2 * max(0.0, s1 - s0);
  }
  area2 = clamp(a2, 0.0, 1.0);
  if (!third || !(dot(n3, n3) > 0.0)) return area2;
  vec2 p3 = n3 * (d3 / dot(n3, n3)), t3 = vec2(-n3.y, n3.x);
  float a31, a32;
  float r31 = cpGreenCross(p3, t3, n1, d1, a31), r32 = cpGreenCross(p3, t3, n2, d2, a32);
  if (abs(dot(n3, t1)) >= 1e-8) { r31 = cpGreenMap(p1, t1, r13, p3, t3); a31 = -a13; }
  if (has2 && abs(dot(n3, t2)) >= 1e-8) { r32 = cpGreenMap(p2, t2, r23, p3, t3); a32 = -a23; }
  cpGreenSlab(p3, t3, s0, s1); cpGreenKeep(a31, r31, s0, s1); cpGreenKeep(a32, r32, s0, s1);
  a3 += 0.5 * d3 * max(0.0, s1 - s0);
  return clamp(a3, 0.0, 1.0);
}
/// Distance from p to the DRAWN ARC, with the parameter it was found at. `tOut` comes back exactly
/// 0.0 or 1.0 when the foot point is an END of the arc -- an end is a candidate of its own, not a
/// clamped root -- so the caller's interior test needs no tolerance.
/// ...AND THE FOOT POINT, for a caller that needs the line's DIRECTION as well as its offset. A
/// box coverage is the area on one side of a line, so an offset alone is half a linearization.
///
/// ANALYTIC, ON THE CURVE'S own DEGREE. The foot point is a root of (B(t) - p).B'(t): a CUBIC for a polynomial
/// quadratic, a QUARTIC for a rational one and a QUINTIC for a cubic:
///   * a quadratic takes the stroke kernel's closed form, quadClosestT (Cardano, one Newton polish);
///   * a cubic takes its descending chain, cubicClosestDescend: the quintic's roots are isolated by
///     the roots of its derivatives, so one bisection per bracket cannot miss one, a tangency
///     included;
///   * a conic takes the same chain from its quartic, cpConicClosestT below.
/// Each compares its roots with both ends and keeps the nearest.
///
/// The conic's quartic. With u(t) = h(t) - p hw(t) (h the weighted numerator, hw its weight) and
/// B = h / hw, (B - p).B' is u.(u' hw - u hw') / hw^3, and hw > 0 on the arc, so the roots are those
/// of u.v with v = u' hw - u hw'. v's cubic terms cancel, so it is a quadratic and u.v a quartic.
/// Its second derivative is a quadratic, taken in closed form; its first derivative's roots and its
/// own are bisected inside the brackets the level above hands down, 24 steps each.
float cpConicClosestT(vec4 g0, vec4 g1, vec2 p) {
  float w = g1.z;
  vec2 U0 = g0.xy - p, U1 = w * (g0.zw - p), U2 = g1.xy - p;
  vec2 a0 = U0, a1 = 2.0 * (U1 - U0), a2 = U0 - 2.0 * U1 + U2;
  float w1 = 2.0 * (w - 1.0), w2 = 2.0 - 2.0 * w;
  vec2 V2 = a2 * w1 - a1 * w2, V1 = 2.0 * (a2 - a0 * w2), V0 = a1 - a0 * w1;
  float c4 = dot(a2, V2), c3 = dot(a2, V1) + dot(a1, V2), c2 = dot(a2, V0) + dot(a1, V1) + dot(a0, V2);
  float c1 = dot(a1, V0) + dot(a0, V1), c0 = dot(a0, V0);
  // f'' = 12 c4 t^2 + 6 c3 t + 2 c2, by the stable pairing (see cubicClosestDescend's level 3).
  float rts[4];
  int nr = 0;
  {
    float A = 12.0 * c4, B = 6.0 * c3, C = 2.0 * c2;
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
  for (int lv = 1; lv >= 0; lv--) {
    float nxt[4];
    int nn = 0;
    float lo = 0.0, flo = cdPoly(0.0, c4, c3, c2, c1, c0, lv, 0.0);
    for (int i = 0; i <= 4; i++) {
      if (i > nr) break;
      float hi = (i == nr) ? 1.0 : rts[i];
      float fhi = cdPoly(0.0, c4, c3, c2, c1, c0, lv, hi);
      if (flo == 0.0 && lo > 0.0 && nn < 4) nxt[nn++] = lo;
      if (flo * fhi < 0.0) {
        float a = lo, b = hi, fa = flo;
        for (int k = 0; k < 24; k++) {
          float m = 0.5 * (a + b);
          float fm = cdPoly(0.0, c4, c3, c2, c1, c0, lv, m);
          if (fa * fm <= 0.0) b = m; else { a = m; fa = fm; }
        }
        if (nn < 4) nxt[nn++] = 0.5 * (a + b);
      }
      lo = hi; flo = fhi;
    }
    nr = nn;
    for (int i = 0; i < 4; i++) rts[i] = nxt[i];
  }
  // The ends, then the roots: the nearest wins, and an end keeps a tie.
  vec2 b, d;
  cpArcEval(g0, g1, true, 0.0, b, d);
  float bt = 0.0, bs = dot(b - p, b - p);
  cpArcEval(g0, g1, true, 1.0, b, d);
  if (dot(b - p, b - p) < bs) { bs = dot(b - p, b - p); bt = 1.0; }
  for (int i = 0; i < 4; i++) {
    if (i >= nr) break;
    cpArcEval(g0, g1, true, rts[i], b, d);
    float dd = dot(b - p, b - p);
    if (dd < bs) { bs = dd; bt = rts[i]; }
  }
  return bt;
}
/// A certified gauss-newton foot point for a cubic. Most fragments do not need the quintic's descending chain: nine seeds and five Gauss-Newton
/// steps land on the nearest point, and whether they did is decidable. |B(t) - p|^2 is a degree-6 polynomial; split its
/// Bernstein form at the foot t_g (de Casteljau) and every coefficient of both halves bounds that half from below. If none
/// is under D(t_g) less the square-distance slack of `certEm` (2^-11 px in em, from the caller), no point of the arc is
/// nearer than the foot by more than the slack -- the foot IS the answer, at every scale, since the slack is a fraction of
/// a pixel. float32's own noise in the coefficients counts against the certificate. What it cannot certify goes to the
/// chain, so nothing is lost but time.
///
/// An end is the foot only as the chain would pick it. The kernel reads an interior foot differently from an end one (the
/// arc's own normal against the implicit's corner), so a certified foot at an end where the distance still falls into the
/// arc comes back just inside it, and the end itself is chosen by the chain's own comparison (d2AtT, ends first, a root
/// only if strictly nearer). A HORN'S caller passes no slack: its side depends on which end is the cusp, and the chain's
/// classification is the contract there.
float cpCubicCertFoot(vec4 g0, vec4 g1, vec2 p, vec4 cx, vec4 cy, float certEm, out bool certOut) {
  float bt = 0.0, bd = 1e30;
  vec2 b, d;
  for (int k = 0; k <= 8; ++k) {
    float t = float(k) * 0.125;
    cpArcEval(g0, g1, false, t, b, d);
    float dd = dot(b - p, b - p);
    if (dd < bd) { bd = dd; bt = t; }
  }
  cpArcEval(g0, g1, false, bt, b, d);
  for (int it = 0; it < 5; ++it) {
    vec2 e = b - p;
    float g2 = dot(d, d);
    float nt = g2 > 0.0 ? clamp(bt - dot(e, d) / g2, 0.0, 1.0) : bt;
    vec2 b2, d2;
    cpArcEval(g0, g1, false, nt, b2, d2);
    bool better = dot(b2 - p, b2 - p) <= dot(e, e);
    bt = better ? nt : bt; b = better ? b2 : b; d = better ? d2 : d;
  }
  // |B(t) - p|^2 in the degree-6 Bernstein basis, from the control points' offsets
  vec2 Q0 = g0.xy - p, Q1 = g0.zw - p, Q2 = g1.xy - p, Q3 = g1.zw - p;
  float c0 = dot(Q0, Q0), c1 = dot(Q0, Q1), c2 = (6.0 * dot(Q0, Q2) + 9.0 * dot(Q1, Q1)) / 15.0,
        c3 = (2.0 * dot(Q0, Q3) + 18.0 * dot(Q1, Q2)) / 20.0, c4 = (6.0 * dot(Q1, Q3) + 9.0 * dot(Q2, Q2)) / 15.0,
        c5 = dot(Q2, Q3), c6 = dot(Q3, Q3);
  // de Casteljau at the foot: the left half's coefficients lead each row, the right half's close it
  float s = bt;
  float a0 = c0 + s * (c1 - c0), a1 = c1 + s * (c2 - c1), a2 = c2 + s * (c3 - c2), a3 = c3 + s * (c4 - c3),
        a4 = c4 + s * (c5 - c4), a5 = c5 + s * (c6 - c5);
  float b0 = a0 + s * (a1 - a0), b1 = a1 + s * (a2 - a1), b2_ = a2 + s * (a3 - a2), b3 = a3 + s * (a4 - a3), b4 = a4 + s * (a5 - a4);
  float e0 = b0 + s * (b1 - b0), e1 = b1 + s * (b2_ - b1), e2 = b2_ + s * (b3 - b2_), e3 = b3 + s * (b4 - b3);
  float f0 = e0 + s * (e1 - e0), f1 = e1 + s * (e2 - e1), f2 = e2 + s * (e3 - e2);
  float h0 = f0 + s * (f1 - f0), h1 = f1 + s * (f2 - f1);
  float Dg = h0 + s * (h1 - h0);
  float mn = min(min(min(c0, a0), min(b0, e0)), min(min(f0, h0), min(h1, f2)));
  mn = min(mn, min(min(e3, b4), min(a5, c6)));
  float dg = sqrt(max(Dg, 0.0));
  float nz = 1.1920929e-6 * max(max(max(abs(c0), abs(c1)), max(abs(c2), abs(c3))), max(max(abs(c4), abs(c5)), abs(c6)));
  certOut = mn - nz >= Dg - (2.0 * dg * certEm + certEm * certEm);
  bool in0 = bt <= 0.0 && dot(Q0, g0.zw - g0.xy) < 0.0, in1 = bt >= 1.0 && dot(Q3, g1.zw - g1.xy) > 0.0;
  float d0 = d2AtT(cx, cy, 0.0), d1 = d2AtT(cx, cy, 1.0);
  float bt2 = (d0 <= d1) ? 0.0 : 1.0, bs = min(d0, d1);
  float tt = clamp(bt, 0.0, 1.0), dd = d2AtT(cx, cy, tt);
  float r = dd < bs ? tt : bt2;
  return (in0 && r <= 0.0) ? 5.9604645e-8 : ((in1 && r >= 1.0) ? 0.99999994 : r);
}
/// `certEm` is the slack a certified cubic foot may be off by, in em (the caller's 2^-11 px); 0 solves exactly.
float cpArcDistFootTangent(vec4 g0, vec4 g1, bool arc3, vec2 p, float certEm, out float tOut, out vec2 footOut, out vec2 tangentOut) {
  float bt;
  if (arc3 && g1.z == 1.0) {
    // B(t) - p = A t^2 + B t + C, the form quadClosestT solves for the origin.
    vec2 P0 = g0.xy - p, P1 = g0.zw - p, P2 = g1.xy - p;
    bt = quadClosestT(P0 - 2.0 * P1 + P2, 2.0 * (P1 - P0), P0);
  } else if (arc3) {
    bt = cpConicClosestT(g0, g1, p);
  } else {
    // The power basis of B(t) - p, (t^3, t^2, t, 1) per axis, as cubicClosestDescend takes it.
    vec2 P0 = g0.xy - p, P1 = g0.zw - p, P2 = g1.xy - p, P3 = g1.zw - p;
    vec2 k3 = P3 - P0 + 3.0 * (P1 - P2), k2 = 3.0 * (P0 - 2.0 * P1 + P2), k1 = 3.0 * (P1 - P0);
    bool cert_ = false;
    if (certEm > 0.0) bt = cpCubicCertFoot(g0, g1, p, vec4(k3.x, k2.x, k1.x, P0.x), vec4(k3.y, k2.y, k1.y, P0.y), certEm, cert_);
    if (!cert_) bt = cubicClosestDescend(vec4(k3.x, k2.x, k1.x, P0.x), vec4(k3.y, k2.y, k1.y, P0.y));
  }
  vec2 b, d;
  cpArcEval(g0, g1, arc3, bt, b, d);
  tOut = bt; footOut = b; tangentOut = d;
  return length(b - p);
}
float cpArcDistFoot(vec4 g0, vec4 g1, bool arc3, vec2 p, float certEm, out float tOut, out vec2 footOut) {
  vec2 tangent;
  return cpArcDistFootTangent(g0, g1, arc3, p, certEm, tOut, footOut, tangent);
}
float cpArcDist(vec4 g0, vec4 g1, bool arc3, vec2 p, out float tOut) {
  vec2 f_;
  return cpArcDistFoot(g0, g1, arc3, p, 0.0, tOut, f_);
}
/// One hard hull plane: kind 16 bridges two corners and clips undilated; kind 14 has a cut along it
/// and reaches exactly as far as the cut does. See patchCoverLines for which is which and why.
/// ONE RAMPED HULL PLANE, four to a kind-22 block, given its signed distance `a` in pixels.
float cpHullRamp(vec2 n, float a, float s0, float s1, vec2 p, float emPerPx) {

  float u = dot(vec2(-n.y, n.x), p);
  if (u < s0 - CP_AA_REACH * emPerPx || u > s1 + CP_AA_REACH * emPerPx) return a >= 0.0 ? 1.0 : exactBoxCov(n, a);
  return exactBoxCov(n, a);
}
float cpHullHard(vec3 abc, float kind, vec2 p, float invPx, out float softH, out float areaH) {
  float A = dot(abc.xy, p) + abc.z;

  // Exactness does not cost exclusivity, which is what hardness would buy. Beyond
  // +/-0.707px exactBoxCov IS the step, so nothing a pixel away from the plane changes; inside
  // that band the plane is a half-plane and its honest area is what it contributes. And the plane
  // is not what makes two patches exclusive in the first place -- the SEAM constraint it runs
  // along (kind 8+) is, and that is still a hard step. This is a fence against a far algebraic
  // branch, not an ownership token.
  //
  float gH = max(length(abc.xy), 1e-20);
  // A plane along a cut reaches as far as the cut's own claim does (CP_POS_REL, CP_CUT_TIE).
  float sdH = A / gH * invPx
            + (kind > 15.5 ? CP_HULL16_DILATE : CP_POS_REL * (abs(p.x) + abs(p.y)) * invPx + CP_CUT_TIE);
  softH = sdH;
  areaH = exactBoxCov(abc.xy, sdH);

  return step(0.0, sdH);
}

#ifdef MANTLE_CPATCH_COMP
/// HOW COVERED A PIXEL CAN BE, GIVEN AN OUTLINE ARC NEAR IT: the box coverage of the line through the
/// arc's foot point, square to the fragment's offset from it, on the fragment's side. The fragment's
/// own constraints have admitted it, so it is inside the shape and the shape ends at the arc: a
/// local bound, continuous in the fragment, with no half-space and no power to reject. A seam's
/// companion (CP_COMP) takes it. ON the arc there is no direction to take, and no bound to apply either.
///
float cpOutlineBound(vec4 og0, vec4 og1, bool arc3, vec2 p, float invPx) {
  float ot; vec2 foot;
  float od = cpArcDistFoot(og0, og1, arc3, p, 4.8828125e-4 / invPx, ot, foot) * invPx;
  vec2 ov = p - foot;
  float ovl = length(ov);
  if (!(ovl > 0.0)) return 1.0;
  return exactBoxCov(ov / ovl, od);
}
#endif

float cpatchCurveCov(int idx, vec2 p, float emPerPx, out bool cutOut, out float softOut, out bool nearOut,
                     out bool hullOut, out float sdOut, out vec2 nOut, out float outlOut) {
  softOut = 1.0; nearOut = false;
  cutOut = false; hullOut = false; sdOut = 1e30;
  // A SEAM'S COMPANION'S BOUND (CP_COMP): the coverage the outline across this seam allows, 1 where
  // there is none or it is out of reach. The caller mins it into the patch's coverage.
  outlOut = 1.0;
  // The constraint's UNIT GRADIENT (inside = +), reported with sdOut wherever the AA ramp is an exact half-plane area, so the
  // caller can intersect two of them exactly. Zero where no half-plane stands behind the coverage.
  nOut = vec2(0.0);
  // Seven texels to a block. The fifth is the arc box for kind 4 -- a Bezout cubic spends all
  // sixteen floats of the first four on its own coefficients, so without it that kind would have no
  // box and nothing would bound its far branches but the patch's convex cover. The sixth and seventh are
  // the ARC'S own CONTROL POINTS, which is the one thing an implicit cannot give: its zero set is
  // the whole algebraic curve, and a second branch running within the filter's reach of the arc is
  // a defect no BOUND can name -- the arc's box, its cross-chord strip and its full oriented box
  // all contain the offending fragment, because the arc bends away inside its own box. Must match
  // cpatchPack.CP_BLOCK_TEXELS.
  int t = idx * 7;
  // One reciprocal for every distance. Twelve distances below multiply by this rather than
  // each dividing by max(emPerPx, 1e-30). It is loop-invariant, so the composition
  // loop computes it once.
  float invPx = 1.0 / max(emPerPx, 1e-30);
#ifdef MANTLE_CPATCH_BLEND3
  // MEASUREMENT only — price the FETCH TRAFFIC of evaluating the morph's degree-2 blend here,
  // per fragment, instead of in a pre-pass. The pass costs 0.187ms and it is a read-after-write
  // barrier, not shading; doing the blend in the kernel would remove it and cost three
  // coefficient fetches per curve instead of one. Whether that trades well cannot be reasoned
  // out — the fill is only 0.127ms total — so this prices it without building it.
  //
  // Three DIFFERENT addresses, four texels apart, which is the layout a real version would use
  // (a block's three poses stored adjacently). Weighted by a vector that is (1,0,0) at runtime
  // but not at compile time: emPerPx is em-per-pixel and strictly positive, so min(emPerPx, 0)
  // is zero — and no compiler can prove it, so neither the extra fetches nor the multiplies can
  // be folded away. Only the first address carries real data and its weight is exactly 1, so
  // every value below is bit-for-bit what an unweighted fetch would give.
  float cpbZ = min(emPerPx, 0.0);
  vec3 cpbW = vec3(1.0 - cpbZ, cpbZ, cpbZ);
#define CPFETCH(ti) (cpbW.x * texFetch(ivec2(ti, 0)) + cpbW.y * texFetch(ivec2((ti) + 7, 0)) \
                                                    + cpbW.z * texFetch(ivec2((ti) + 14, 0)))
#else
#define CPFETCH(ti) texFetch(ivec2(ti, 0))
#endif
  vec4 e0 = CPFETCH(t);
  // BIT 5 OF THE KIND IS THE ARC'S DEGREE, not part of the kind. Stripped here so every test below
  // reads the kind it always did; kinds 0-17 are taken and 18-31 stay free. See arcIs3 in
  // cpatchPack.js.
  float arcTag = e0.w;
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
  bool convexRight = arcTag >= CP_AREA + CP_AREA_RIGHT - 0.5;
  if (convexRight) arcTag -= CP_AREA_RIGHT;
  bool convexEnd = arcTag >= CP_AREA - 0.5;
  if (convexEnd) arcTag -= CP_AREA;
#endif
  // THE HORN BITS, stripped before everything else (CP_HORN): 0 or 4 (the inside is on the right) plus the cusp
  // ends, 0 to 3.
  float hornW = floor(arcTag / CP_HORN + 1e-3);
  arcTag -= CP_HORN * hornW;
  bool hornRight = hornW > 3.5;
  float hornE = hornRight ? hornW - 4.0 : hornW;
  // ...then a morph's corners (CP_END): squared seam corners at the start (1) and end (2), outline corners there (4, 8).
  float endW = floor(arcTag / CP_END + 1e-3);
  arcTag -= CP_END * endW;
  bool sq0 = mod(endW, 2.0) > 0.5, sq1 = mod(floor(endW * 0.5), 2.0) > 0.5;
  bool oc0 = mod(floor(endW * 0.25), 2.0) > 0.5, oc1 = endW > 7.5;
  // ...and bits 6 and 7 are a seam's companion (CP_COMP), stripped first.
  float compTag = arcTag > 2.0 * CP_COMP - 0.5 ? 2.0 : (arcTag > CP_COMP - 0.5 ? 1.0 : 0.0);
  arcTag -= CP_COMP * compTag;
  e0.w = arcTag;
  bool arc3 = arcTag > CP_ARC3 - 0.5;
  if (arc3) e0.w = arcTag - CP_ARC3;
    //
  // Bit 3 of the kind carries hardness, so the real kind survives it.
  //
  // WHY THE STEP IS HARD, AND WHAT IT COSTS. A cut is shared by two patches, and their coverages
  // reach the framebuffer through OVER — under which two halves give 1-(1-a)(1-b) = 0.75, not 1.
  // A hard step avoids that by giving the seam entirely to whichever patch contains the pixel
  // center, which is exact for a pixel that is wholly inside the shape.
  //
  //
  float kraw = e0.w;
  // THE ROW KINDS, numbered above 13; a curve is numbered below. Two reach the kernel:
  //
  // FOUR HARD HULL PLANES IN ONE BLOCK (kind 21). A hull plane is one texel, and a seven-texel
  // block each would cost a loop iteration and a kind dispatch per plane -- and the loop is where
  // they cost, not the arithmetic. Layout: this texel carries plane 0's (a, b, c) and the pack
  // kind; texels 1-3 carry planes 1-3's coefficients and, in .w, the PREVIOUS plane's kind; texel
  // 4.x carries plane 3's. An unused slot is (0, 0, 1) at kind 16, whose step(0, 1) is 1, so a
  // short group needs no count.
  // FOUR RAMPED HULL PLANES IN ONE BLOCK (kind 22). Same reason as kind 21 and a bigger one: the
  // ramped planes are the majority, and a seven-texel block each would hold five numbers. The
  // group is padded by repeating its last plane, and min() is idempotent, so no count is needed.
  // See CPK_HULL_RAMP_PACK in cpatchPack.js for the layout.

  // One test for the common case. Everything from here to the closing brace is a ROW KIND. A CURVE
  // is numbered below it, and curves are what most fragments spend their loop on (3.6 a patch
  // against 4 hull blocks, and a curve block costs about four times a hull one), so a curve takes
  // one comparison to reach its own code.
  if (kraw > 13.5) {
    if (kraw > 21.5) {
      cutOut = false;
      vec4 q1 = CPFETCH(t + 1), q2 = CPFETCH(t + 2), q3 = CPFETCH(t + 3);
      // The four distances first. A ramped plane saturates at CP_AA_REACH either way --
      // its step and its box area are both 1 past it and both 0 before its negative -- so a fragment
      // that far inside all four, or that far outside any one, has its answer before the spans are
      // fetched or tested and before any area is taken. Hull planes are unit (patchCoverLines), so
      // no normal reaches a support above 0.7071.
      vec4 av = vec4(dot(e0.xy, p) + e0.z, dot(q1.xy, p) + q1.z, dot(q2.xy, p) + q2.z, dot(q3.xy, p) + q3.z) * invPx;
      float amin = min(min(av.x, av.y), min(av.z, av.w));
      if (amin >= CP_AA_REACH) return 1.0;
      if (amin <= -CP_AA_REACH) return 0.0;
      vec4 q4 = CPFETCH(t + 4), q5 = CPFETCH(t + 5);
#ifdef MANTLE_CPATCH_EXACT_COMBINE
      // min() is right about OWNERSHIP and wrong as an AREA at a corner: two
      // planes that each cover half the pixel return 0.5, where the true intersection is a quarter.
      // The exact answer for two half-planes is exactBoxCov2 -- and it is NOT cheap arithmetic, it
      // is a Sutherland-Hodgman clip of the pixel box over two passes, which is exactly the
      // "register-bound loop" the row warns about. `abc.xy` is unit length (that is what makes
      // exactBoxCov(abc.xy, a) valid), so the pair feeds exactBoxCov2 directly.
      //
      // Only the two tightest planes. A corner is where two boundaries meet; a third plane that is
      // further away does not touch the pixel, and keeping four live is what costs the registers.
      // Out-of-span planes stay on min(), because there they are a hard 0/1 ownership test and
      // carry no area at all.
      vec2 n1 = vec2(1.0, 0.0), n2 = vec2(1.0, 0.0);
      float d1 = 1e9, d2 = 1e9, mh = 1.0;
      vec3 pl[4]; pl[0] = e0.xyz; pl[1] = q1.xyz; pl[2] = q2.xyz; pl[3] = q3.xyz;
      vec2 sp[4]; sp[0] = vec2(q1.w, q2.w); sp[1] = vec2(q3.w, q4.x);
      sp[2] = vec2(q4.y, q4.z); sp[3] = vec2(q4.w, q5.x);
      for (int i = 0; i < 4; i++) {
        vec3 abc = pl[i];
        float ai = av[i];
        float u = dot(vec2(-abc.y, abc.x), p);
        if (u < sp[i].x - CP_AA_REACH * emPerPx || u > sp[i].y + CP_AA_REACH * emPerPx) {
          mh = min(mh, step(0.0, ai));
          continue;
        }
        if (ai < d1) { n2 = n1; d2 = d1; n1 = abc.xy; d1 = ai; }
        else if (ai < d2) { n2 = abc.xy; d2 = ai; }
      }
      // `d` here is how far the pixel center sits INSIDE the plane, and exactBoxCov2 clips
      // {n.p <= d}. One live plane is the single-plane case; none means nothing bounded this
      // fragment and only the hard planes above spoke.
      float mc = d1 > 1e8 ? 1.0 : (d2 > 1e8 ? exactBoxCov(n1, d1) : exactBoxCov2(n1, d1, n2, d2));
      return min(mh, mc);
#else
      float m = 1.0;
      m = min(m, cpHullRamp(e0.xy, av.x, q1.w, q2.w, p, emPerPx));
      m = min(m, cpHullRamp(q1.xy, av.y, q3.w, q4.x, p, emPerPx));
      m = min(m, cpHullRamp(q2.xy, av.z, q4.y, q4.z, p, emPerPx));
      m = min(m, cpHullRamp(q3.xy, av.w, q4.w, q5.x, p, emPerPx));
      return m;
#endif
    }
    if (kraw > 20.5) {
      vec4 q1 = CPFETCH(t + 1), q2 = CPFETCH(t + 2), q3 = CPFETCH(t + 3), q4 = CPFETCH(t + 4);

      float m = 1.0, ms = 1e30, sX, aX, ma = 1.0;
      m = min(m, cpHullHard(e0.xyz, q1.w, p, invPx, sX, aX)); ms = min(ms, sX); ma = min(ma, aX);
      m = min(m, cpHullHard(q1.xyz, q2.w, p, invPx, sX, aX)); ms = min(ms, sX); ma = min(ma, aX);
      m = min(m, cpHullHard(q2.xyz, q3.w, p, invPx, sX, aX)); ms = min(ms, sX); ma = min(ma, aX);
      m = min(m, cpHullHard(q3.xyz, q4.x, p, invPx, sX, aX)); ms = min(ms, sX); ma = min(ma, aX);
      softOut = ma;
      // REPORTED AS A CUT, so CPatch's edges are not binary.

      // As a cut it goes to cutHard/cutSoft, where the seam gate already decides between them, and
      // the hardness stays exactly where it is load-bearing: cutHard still carries the step, so a
      // fragment that is not mid-ramp on this patch's own edge is excluded -- which is what stops
      // two patches sharing this plane both claiming a pixel.

      hullOut = true;
      sdOut = ms;
      return m;
    }
    return 1.0;
  }

  bool isCut = kraw > 7.5;
  cutOut = isCut;
  float kind = isCut ? kraw - 8.0 : kraw;
    //
  // This is worth more under a MORPH than it looks: CPFETCH there is three texel reads blended
  // across poses, so a skipped fetch is three reads saved, not one.
#ifdef MANTLE_CPATCH_E1_ALWAYS
  // A/B arm: every constraint fetches texel 1, as it did before the sign moved into a[0]. With
  // the sign folded in, a line's e1.w is 1 and this arm is OUTPUT-IDENTICAL to the other -- so it
  // prices the FETCH alone, which is the only way to price it on a machine whose cross-run spread
  // is wider than the effect.
  vec4 e1 = CPFETCH(t + 1);
#else
  vec4 e1 = (kind < 0.5) ? vec4(0.0, 0.0, 0.0, 1.0) : CPFETCH(t + 1);
#endif
  float sg = e1.w;
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
  if (convexEnd && kind > 0.5 && kind < 1.5) {
    vec4 cg0 = CPFETCH(t + 5), cg1 = CPFETCH(t + 6);
    vec2 cp0 = cg0.xy, cp1 = cg0.zw, cp2 = cg1.xy;
    vec2 ct0 = cp1 - cp0, ct1 = cp2 - cp1;
    bool before = dot(p - cp0, ct0) <= 0.0;
    bool after = dot(p - cp2, ct1) >= 0.0;
    if (before || after) {
      vec2 ct = before ? ct0 : ct1, ep = before ? cp0 : cp2;
      vec2 cn = normalize(vec2(-ct.y, ct.x)) * (convexRight ? -1.0 : 1.0);
      sdOut = dot(p - ep, cn) * invPx; nOut = cn;
      nearOut = abs(sdOut) <= CP_AA_REACH;
      softOut = exactBoxCov(cn, sdOut); return softOut;
    }
  }
#endif

  vec4 e2c = (kind < 1.5) ? vec4(0.0) : CPFETCH(t + 2);
  vec4 e3c = (kind < 0.5) ? vec4(0.0) : CPFETCH(t + 3);
#define CP_EVAL(pp, ff, gg) { \
    float _A0 = dot(e0.xy, (pp)) + e0.z; \
    if (kind < 0.5) { (ff) = _A0; (gg) = e0.xy; } \
    else if (kind < 1.5) { float _A1 = dot(e1.xy, (pp)) + e1.z; \
      (ff) = _A0 * _A0 - _A1; (gg) = 2.0 * _A0 * e0.xy - e1.xy; } \
    else { float _A1 = dot(e1.xy, (pp)) + e1.z; float _A2 = dot(e2c.xy, (pp)) + e2c.z; \
      if (kind > 4.5) { (ff) = _A0 * _A0 - _A1 * _A2; \
        (gg) = 2.0 * _A0 * e0.xy - _A2 * e1.xy - _A1 * e2c.xy; } \
      else if (kind < 3.5) { (ff) = _A0 * _A0 * _A0 - _A1 * _A2; \
        (gg) = 3.0 * _A0 * _A0 * e0.xy - _A2 * e1.xy - _A1 * e2c.xy; } \
      else { float _A3 = dot(e3c.xy, (pp)) + e3c.z; float _C0 = e2c.w, _C1 = e3c.w; \
        (ff) = _C1 * _A0 * _A3 - _C0 * _C0 * _A0 - _C1 * _A1 * _A1 + 2.0 * _C0 * _A1 * _A2 - _A3 * _A2 * _A2; \
        (gg) = (_C1 * _A3 - _C0 * _C0) * e0.xy + (_C1 * _A0 - _A2 * _A2) * e3c.xy \
             + (2.0 * _C0 * _A2 - 2.0 * _C1 * _A1) * e1.xy \
             + (2.0 * _C0 * _A1 - 2.0 * _A3 * _A2) * e2c.xy; } } }
  float f; vec2 gf;
  CP_EVAL(p, f, gf)
  f *= sg; gf *= sg;
  // A seam decides along its own span and no further. Its step is an implicit's sign, and the zero set runs
  // on past the seam's ends -- often as the very outline the seam meets, where a curve was split into a seam piece and an
  // outline piece -- so a fragment in this patch's skirt, beside that outline pixels further on, would read the seam's extension
  // as the patch's edge and drop half its pixel with no other patch there to take it. Past the filter's reach of the seam's own bound the step has nothing to say. The bound is the arc's box
  // (texel 3), or for the Bezout cubic, whose coefficients fill texel 3, the slab across its chord between its two ends (the
  // arc, texels 5-6 -- unless they carry a companion instead, CP_COMP, when the step stays unbounded as before).
  // ...AND only WHERE THE PATCH HAS AN EDGE OF ITS own TO PAINT: past its span the step comes back with nearOut set (a cut
  // never sets it otherwise), and the composition drops it only for a fragment standing in the AA band of one of the patch's
  // drawn arcs.
  if (isCut) {
    bool far_ = false;
    if (kind > 3.5 && kind < 4.5) {
      if (compTag < 0.5) {
        vec4 ca_ = CPFETCH(t + 5), cz_ = CPFETCH(t + 6);
        vec2 cd_ = cz_.zw - ca_.xy;
        float cL_ = length(cd_), cu_ = cL_ > 0.0 ? dot(p - ca_.xy, cd_) / cL_ : 0.0, cr_ = CP_AA_REACH * emPerPx;
        far_ = cu_ < -cr_ || cu_ > cL_ + cr_;
      }
    } else {
      vec4 cb_ = kind < 0.5 ? CPFETCH(t + 3) : e3c;
      far_ = length(max(max(cb_.xy - p, p - cb_.zw), vec2(0.0))) * invPx > CP_AA_REACH;
    }
    if (far_) { nearOut = true; return f >= 0.0 ? 1.0 : 0.0; }
  }
  // A CUT CLAIMS WHAT THE FRAGMENT'S own POSITION CANNOT RULE OUT (CP_POS_REL), in pixels.
  // ...AND WHAT THE TWO PATCHES' own POSITIONS CAN DISAGREE ON (CP_CUT_TIE): each interpolates from its own vertices, so at a center exactly on a seam both could read the other's side, and
  // neither painted (a line of solid pixels read 0). A pixel's thousandth is rounding and not overlap.
  float cutRes = isCut ? CP_POS_REL * (abs(p.x) + abs(p.y)) * invPx + CP_CUT_TIE : 0.0;

  float gpx = length(gf) * emPerPx;
#ifdef MANTLE_CPATCH_ONLYCUT
  // MEASUREMENT only — the inverse of NOCUT: only the seams constrain. What is left unpainted
  // is exactly the region the cut half-spaces exclude, which names the offending seam.
  if (!isCut) return 1.0;
#endif
#ifdef MANTLE_CPATCH_NOCUT
  // MEASUREMENT only — a CUT seam contributes nothing. If a region reappears with the seams
  // ignored, the seam half-spaces are what removed it, and the defect is in the converter's
  // cut geometry rather than in the coverage ramp.
  if (isCut) return 1.0;
#endif
    //
  bool hornNear = false;
  if (hornE > 0.5 && !isCut) {
    vec2 hbo = kind > 3.5 && kind < 4.5 ? vec2(0.0) : max(max(e3c.xy - p, p - e3c.zw), vec2(0.0));
    vec4 hst = CPFETCH(t + 4);
    float hpx = length(hbo) * invPx;
    if (dot(hst.xy, hst.xy) > 0.5) { float hv = dot(hst.xy, p); hpx = max(hpx, max(max(hst.z - hv, hv - hst.w), 0.0) * invPx); }
    hornNear = hpx <= CP_AA_REACH;
  }
  if (f > gpx * 0.7072 && !hornNear) return 1.0;

#ifdef MANTLE_CPATCH_HARD
  // MEASUREMENT only — every curve a hard step, no AA ramp at all. Separates "is the
  // REGION right" from "is the coverage ramp right": jagged edges but exact interiors.
  return step(0.0, f);
#else
  // Measurement only: scales the ramp WIDTH. If coverage is being lost to a ramp that
  // is simply too wide, a scale < 1 walks the deficit back and names the miscalibration
  // rather than guessing at it.
#ifdef MANTLE_CPATCH_RAMP
  return isCut ? step(0.0, f) : clamp(0.5 + f / max(gpx * MANTLE_CPATCH_RAMP, 1e-30), 0.0, 1.0);
#else
  // TRUE DISTANCE TO THE ZERO SET, by Newton projection, instead of the first-order estimate.
  //
  //
  // Two Newton steps onto the zero set give the real distance. Near the curve the first step
  // already lands (the first-order estimate is good there); far away it converges to the nearest
  // point rather than a scaled-down guess. Cheap on this kernel -- two more evaluations of an
  // implicit already in registers -- and it makes the ramp exactly half a pixel wide at every
  // degree, which is what antialiasing a half-space means.
  // A linear boundary needs no newton. f/|grad f| IS the distance for a plane — exactly, not to
  // first order — so the two projection steps below buy nothing and cost two more evaluations of
  // the implicit. That matters because the patch's own COVER HULL is packed as linear boundaries
  // (see the packer): without this the hull's five-odd planes cost as much as its curves, and
  // enforcing them took the fill from 4.90ms to 11.00ms. With it they are nearly free.
  // And one inverse length for the gradient: the line's distance and normal, a cut's
  // distance, the curve's normal and its curvature all divided by length(gf) or its cube. It is
  // 1/max(|gf|, 1e-20); the guard keeps inversesqrt off zero, where it is undefined.
  float g2 = dot(gf, gf);
  float ig = g2 > 0.0 ? min(inversesqrt(g2), 1e20) : 1e20;
  // THE OUTLINE ACROSS A SEAM (CP_COMP), for a fragment within the filter's reach of it: the
  // companion's box first, then its arc. Nothing is fetched for a seam without one, nor for a
  // fragment further inside than the reach, which has already returned.
// COMPILED IN only WHERE A SEAM PACKS ONE (MANTLE_CPATCH_COMP). The branch below is taken only for a seam
// whose kind word carries CP_COMP, and the companion is off by default, so a program without one never runs it --
// but compiled in, cpOutlineBound inlines a second whole arc-distance solver, cubic and conic chains with their root
// arrays, into the composition loop: on text, about a fifth of the optimized SPIR-V instructions, a quarter of the loops
// and two fifths of the function-scope arrays. The renderer defines it for a bundle
// whose packs wrote a companion (fillPass, R._cpatchHasComp).
#ifdef MANTLE_CPATCH_COMP
#define CP_COMPANION(sdv) \
  if (compTag > 0.0 && isCut && (sdv) >= -CP_AA_REACH) { \
    vec4 cbx_ = CPFETCH(t + 4); \
    vec2 cbo_ = max(max(cbx_.xy - p, p - cbx_.zw), vec2(0.0)); \
    if (length(cbo_) <= CP_AA_REACH * emPerPx) \
      outlOut = cpOutlineBound(CPFETCH(t + 5), CPFETCH(t + 6), compTag > 1.5, p, invPx); \
  }
#else
#define CP_COMPANION(sdv)
#endif
  if (kind < 0.5) {
    float sdL = f * ig * invPx;
    vec2 nL = gf * ig;

    if (!isCut && sdL >= 0.0 && sdL <= CP_AA_REACH) {
      vec4 lb = CPFETCH(t + 3);
      vec2 ov = max(max(lb.xy - p, p - lb.zw), vec2(0.0));
      float bpx = length(ov) * invPx;
      if (bpx > sdL && (oc0 || oc1)) {
        vec4 le = CPFETCH(t + 5);
        vec2 ld = le.zw - le.xy;
        float lu = dot(p - le.xy, ld);
        if ((lu < 0.0 && oc0) || (lu > dot(ld, ld) && oc1)) bpx = 0.0;
      }
      sdL = max(sdL, bpx);
    }
    // A morph draws its static corners here. A static cover stops at a seam corner whose miter would run past
    // 1.05 of the reach: the skirt squares off on the line's own normal (cpatchPack's `corner`), so no fragment of the
    // patch exists outside the line past that normal. A morph's cover is the span's dilated hull and has no such corner --
    // it reaches those pixels, and each seam's extension past the corner hands its own patch the pixels beyond it: where
    // two patches meet the outline at one point through two different seams, both painted the same pixels (0.726 where
    // the shape covers 0.476, cpatchMorphLayoutSmoke). So on a morph's pack, outside the line and beyond the normal at
    // such an end, the patch paints nothing -- which is where its static cover stops.
    if (!isCut && (sq0 || sq1) && sdL < 0.0) {
      vec4 le = CPFETCH(t + 5);
      vec2 ld = le.zw - le.xy;
      if ((sq0 && dot(p - le.xy, ld) < 0.0) || (sq1 && dot(p - le.zw, ld) > 0.0)) {
        softOut = 0.0; sdOut = sdL; nOut = nL;
        return 0.0;
      }
    }
    softOut = exactBoxCov(nL, sdL);
    nearOut = !isCut && abs(sdL) <= CP_AA_REACH;
    sdOut = sdL; nOut = nL;
    CP_COMPANION(sdL)
    // A straight seam past its outline end defers to the outline's normal. At an end where the patch's loop
    // turns from the seam onto its own outline curve and one other outline curve meets the same point, a fragment past
    // the end belongs to the patch whose curve it is beside -- its own curve's side of that curve's normal, and not the
    // other's -- whichever side of the seam's extension it lies on. Bits 8 and 9 arm the two ends; the four legs ride the
    // xyz of texels 1, 2 and 4 (which a line never reads, and a morph's blend carries per pose): end 0's own leg and
    // other leg, then end 1's; texel 5 holds the seam's two ends.
    // THE LEGS ARE FETCHED only PAST THE END (output-identical reorder, cost): the seam's two ends (texel 5, one fetch) say whether
    // the fragment is past an armed end at all, and the three leg texels are read only then.
    if (isCut && endW > 0.5 && sdL < -cutRes) {
      vec4 le = CPFETCH(t + 5);
      vec2 q0 = p - le.xy, q1 = p - le.zw;
      bool pe0 = sq0 && dot(q0, le.xy - le.zw) > 0.0, pe1 = sq1 && dot(q1, le.zw - le.xy) > 0.0;
      if (pe0 || pe1) {
        vec4 l1 = CPFETCH(t + 1), l2 = CPFETCH(t + 2);
        if (pe0 && dot(q0, l1.xy) >= 0.0 && dot(q0, vec2(l1.z, l2.x)) < 0.0) return 1.0;
        if (pe1) { vec4 l4 = CPFETCH(t + 4);
          if (dot(q1, l2.yz) >= 0.0 && dot(q1, l4.xy) < 0.0) return 1.0; }
      }
    }
    return isCut ? step(-cutRes, sdL) : softOut;
  }
  // A cut needs no newton either. Its answer is a hard step at a quarter pixel, so the distance
  // only has to be right where the step CHANGES -- and there f is ~0, which is exactly where the
  // first-order estimate f/|grad f| is exact. Newton buys accuracy at LARGE distances, where the
  // step's outcome is not in doubt. The two iterations are two more evaluations of the implicit
  // apiece, and they are not cheap on the kinds that carry them: a 64-segment cubic ring packs 35
  // Bezout seams and a 64-segment quad ring 106 curved ones.
  float dpx;
  if (isCut) {
    dpx = abs(f) * ig * invPx;
  } else {
        //
    // Most constraints on real shapes are LINES, which take the
    // fast path above and never reach here at all (a rounded rectangle is 4 lines + 4 klmn + 14
    // line seams). Newton is a small share of the total, so halving it is invisible.
    vec2 q = p; float fq = f; vec2 gq = gf;
    for (int it = 0; it < 2; ++it) {
      float g2 = dot(gq, gq);
      // The step's own epsilon is not a size. |grad|^2 for a small cubic's Bezout form is around 1e-22,
      // so an absolute bar would bail on a step that is perfectly well defined -- |f|/|grad|, which for that
      // constraint is under an em -- and leave dpx at ZERO, which reads as "exactly on the boundary" and
      // returns half coverage. Both float32 and double carry 1e-22 without trouble; what cannot be carried
      // is a zero divisor, so that is all this tests for. Even 1e-30 would be an absolute length: the Bezout
      // form's |grad|^2 goes as the shape's size to the tenth power, so a shape a few hundred em across can sit
      // just under it (a half-coverage ramp where the patch is not even the owner) while the same shape at 2^-20
      // of its size lands above it. The floor is float32's smallest NORMAL number, which is the representable
      // limit and not a size.
      if (g2 < 1.1754944e-38) break;
      q -= fq * gq / g2;
      float ff; vec2 gg;
      CP_EVAL(q, ff, gg)
      fq = ff * sg; gq = gg * sg;
    }
    dpx = length(p - q) * invPx;
  }
  // A curve only constrains near its own arc -- on one side. An implicit's zero set is the whole
  // algebraic curve, and a klmn cubic's extraneous branch can sweep through the patch INTERIOR,
  // where the ramp paints a half-covered region: correct as far as the half-space is concerned and
  // wrong as far as the shape is. The distance there is genuinely small, so no better distance
  // estimate helps; only knowing where the ARC is does. Texel 3 carries the arc's bounding box for
  // every kind but the Bezout cubic (kind 4), whose own coefficients need those slots.
  //
  // The box may only ever RAISE coverage, and that asymmetry is the whole correction. The defect
  // it exists for is a branch DARKENING the interior -- fragments the patch contains
  // (f >= 0), dimmed to 0.5 because an unrelated sheet of the same algebraic curve happens to pass
  // nearby. Flooring their distance by the distance to the arc's box restores them to 1.
  //
  // Using it on the f < 0 side instead deletes real coverage, because this kernel min()s every
  // curve of the patch and a fragment on the shape's true edge is also being tested against its
  // patch's other constraints. Off its own arc a curve's sign says nothing about the region, so one
  // such curve reading f < 0 there would take the fragment's coverage to zero. Against an 8x
  // reference, a plain step(0, f) is several times as wrong as either alternative on curved
  // constraints, and the error is one-sided -- the signature of coverage being deleted rather than
  // mis-shaped.
  //
  // The asymmetric rule (f >= 0 only) buys the accuracy of "unconstrained" without its
  // over-painting: returning 1.0 off-arc outright drops the constraint on both sides, and the pixels
  // it then paints outside the shape are exactly the ones the box exists to stop.
  // The bezout cubic has no box. Its own coefficients fill texels 0-3, so hasBox excludes kind 4,
  // and what bounds its far branches is texel 4's cross-chord strip, below.
  //
  bool hasBox = kind < 3.5 || kind > 4.5;
  vec4 boxc = e3c;
  float boxPx = 0.0;
  if (hasBox) {
    vec2 outv = max(max(boxc.xy - p, p - boxc.zw), vec2(0.0));   // 0 on the arc's box, growing off it
    boxPx = length(outv) * invPx;
  }

  vec4 strip = CPFETCH(t + 4);
  float stripPx = 0.0;
  if (dot(strip.xy, strip.xy) > 0.5) {
    float v = dot(strip.xy, p);
    stripPx = max(max(strip.z - v, v - strip.w), 0.0) * invPx;
    boxPx = max(boxPx, stripPx);
    hasBox = true;
  }

  bool cutArc = false, cutSdOn = false;
  float cutSd = 0.0;
  if (isCut && f < 0.0 && compTag < 0.5 && dot(strip.xy, strip.xy) > 0.5) {
    if (stripPx > CP_AA_REACH) {
      vec4 ca_ = CPFETCH(t + 5), cz_ = CPFETCH(t + 6);
      vec2 cE1_ = arc3 ? cz_.xy : cz_.zw;
      float cf0_, cf1_; vec2 cn0_, cn1_;
      CP_EVAL(ca_.xy, cf0_, cn0_)
      CP_EVAL(cE1_, cf1_, cn1_)
      float cin_ = dot((dot(cn0_, cn0_) >= dot(cn1_, cn1_) ? cn0_ : cn1_) * sg, strip.xy), cv_ = dot(strip.xy, p);
      if ((cv_ > strip.w && cin_ > 0.0) || (cv_ < strip.z && cin_ < 0.0)) { cutSdOn = true; cutSd = stripPx; }
    } else {
      vec2 cq_ = p; float cfq_ = f; vec2 cgq_ = gf;
      for (int it = 0; it < 2; ++it) {
        float cg2_ = dot(cgq_, cgq_);
        if (!(cg2_ > 0.0)) break;
        cq_ -= cfq_ * cgq_ / cg2_;
        float cff_; vec2 cgg_;
        CP_EVAL(cq_, cff_, cgg_)
        cfq_ = cff_ * sg; cgq_ = cgg_ * sg;
      }
      float cvq_ = dot(strip.xy, cq_);
      cutArc = cvq_ < strip.z || cvq_ > strip.w;
    }
  }
    //
  // Only where the foot point is interior. At an end of the arc the boundary turns onto the next
  // curve, and the endpoint's distance would round every corner off; there the implicit's own
  // extension is kept, which is what forms a corner out of two half-spaces. Standing the constraint
  // down instead paints 483 pixels outside the shape against 12.
  //
  //
  // The order matters: this runs on the RAW Newton distance, before the box floors it, and the box
  // below is then a no-op wherever the arc answered -- the distance to a bounding box is never more
  // than the distance to the arc inside it.
  bool hornGeo = false, hornLine = false;
  vec2 hornF = vec2(0.0), hornT = vec2(0.0);
  float hornAd = 0.0;
  if ((!isCut && (dpx <= CP_AA_REACH || boxPx <= CP_AA_REACH || hornNear)) || cutArc) {
    vec4 g0 = CPFETCH(t + 5), g1 = CPFETCH(t + 6);
    float at; vec2 afoot, aTangent;
    float ad = cpArcDistFootTangent(g0, g1, arc3, p, hornE > 0.5 ? 0.0 : 4.8828125e-4 * emPerPx, at, afoot, aTangent) * invPx;
    // A morph draws its static corners here too: outside the arc, with its foot at
    // a squared seam corner.
    if (!isCut && f < 0.0 && ((sq0 && at <= 0.0) || (sq1 && at >= 1.0))) {
      softOut = 0.0; sdOut = -ad; nOut = vec2(0.0);
      return 0.0;
    }

    if (hornE > 0.5 && ad <= CP_AA_REACH) {
      bool cusp0 = at <= 0.0 && (hornE == 1.0 || hornE == 3.0), cusp1 = at >= 1.0 && hornE > 1.5;
      if (at > 0.0 && at < 1.0) {
        vec2 hb_, hd_;
        cpArcEval(g0, g1, arc3, at, hb_, hd_);
        if (dot(hd_, hd_) > 0.0) { hornGeo = true; hornF = afoot; hornT = hd_; hornAd = ad; }
      } else {
        vec2 hb_, hd_;
        cpArcEval(g0, g1, arc3, at <= 0.0 ? 0.0 : 1.0, hb_, hd_);
        if (cusp0 || cusp1) hd_ = g1.xy - g0.zw;
        if (dot(hd_, hd_) > 0.0) { hornGeo = true; hornLine = true; hornF = hb_; hornT = hd_; }
      }
    }
    if (at > 0.0 && at < 1.0) {
      dpx = ad;
      // A distance to this arc needs this arc's side. The implicit's sign at p can belong to another branch of the
      // algebraic curve, or the opposite side of an ellipse: paired with a nearby interior foot it can put a pixel a fraction
      // of a pixel from the near edge hundreds of pixels away (the far arc's), erasing the AA there. The arc's own tangent at
      // the foot and the patch loop's orientation (bit 14, on every outline) say which side p is on. Ends keep the implicit's corner model;
      // hard seams take their side below.
      if (!isCut && f < 0.0 && dot(aTangent, aTangent) > 0.0)
        f = dot(p - afoot, vec2(-aTangent.y, aTangent.x)) * (hornRight ? -1.0 : 1.0);
    }
    // PAST ITS own ENDS A CURVE BOUNDS, IT DOES NOT ATTENUATE. Where the foot point is an END the
    // nearest boundary is not this arc -- the patch's boundary has turned onto the next curve, and
    // this half-space is only here to close the corner. The implicit's extension still passes
    // nearby and attenuates fragments the shape covers whole. The arc's own distance is the honest
    // number there, and it is a lower bound on where the drawn outline is.
    //
    else if (f >= 0.0 && ad > dpx) dpx = ad;
    if (isCut && at > 0.0 && at < 1.0) {
      float cff_; vec2 cgg_;
      CP_EVAL(afoot, cff_, cgg_)
      cutSdOn = true; cutSd = dot(p - afoot, cgg_ * sg) >= 0.0 ? ad : -ad;
    }
  }
  if (hasBox && !isCut && f >= 0.0) dpx = max(dpx, boxPx);
  // A cut seam is shared with the neighboring patch, and the two sides evaluate functionals
  // that are exact negatives only in exact arithmetic. Rounding leaves a hairline where both
  // read f < 0 and neither covers. Admitting a QUARTER pixel past the seam closes it from both
  // sides; the overlap is invisible on the opaque fills a hard cut is used for, and a quarter
  // pixel is far below the half-pixel a coverage test can resolve.
  float sd = (f < 0.0 ? -dpx : dpx);

  float sdStep = sd;
  // The normal in PIXEL space: the gradient points across the zero set, and the world-to-pixel
  // scale here is uniform, so its direction survives the mapping.
  vec2 nrm = gf * ig;
  // The edge is curved and the area model is not. `sd` is a true distance -- the Newton projection
  // earns that -- but exactBoxCov then measures the area a STRAIGHT half-plane at that distance
  // leaves in the pixel, and on a curved edge those differ by the level set's curvature times the
  // pixel's size. Loop-Blinn corrects the same thing with kappa/24 in curveCov, where the note says
  // first-order coverage "left a 0.3-0.4 band on curved partials" -- which is CPatch's symptom
  // exactly: ramping cuts instead of stepping them changes its worst AA pixel not at all, and
  // removing the ramp entirely takes the mean from 0.0093 to 0.0381, so the residue is INSIDE the
  // ramp rather than at a seam.
  //
  // THE HESSIAN IS ANALYTIC HERE, which is why this costs so little. Every packed implicit is a sum
  // of products of AFFINE functionals, so each functional's gradient is just its own (a, b) and the
  // second derivative is a handful of outer products of those. No screen-space derivative is taken:
  // dFdx inside this loop would be undefined anyway, since the loop's control flow is data-driven.
  //
  {
    float k0 = dot(e0.xy, p) + e0.z;
    vec3 H = vec3(0.0);                       // (Hxx, Hxy, Hyy)
    if (kind < 0.5) { }                       // a line is flat: no correction
    else if (kind < 1.5) H = 2.0 * vec3(e0.x * e0.x, e0.x * e0.y, e0.y * e0.y);
    else {
      vec3 oo = vec3(e0.x * e0.x, e0.x * e0.y, e0.y * e0.y);
      vec3 c12 = vec3(2.0 * e1.x * e2c.x, e1.x * e2c.y + e1.y * e2c.x, 2.0 * e1.y * e2c.y);
      if (kind > 4.5)      H = 2.0 * oo - c12;                       // A0^2 - A1*A2
      else if (kind < 3.5) H = 6.0 * k0 * oo - c12;                  // A0^3 - A1*A2
      else {
        float a1 = dot(e1.xy, p) + e1.z, a2 = dot(e2c.xy, p) + e2c.z;
        float a3 = dot(e3c.xy, p) + e3c.z, C0 = e2c.w, C1 = e3c.w;
        vec3 c03 = vec3(2.0 * e0.x * e3c.x, e0.x * e3c.y + e0.y * e3c.x, 2.0 * e0.y * e3c.y);
        vec3 c11 = vec3(e1.x * e1.x, e1.x * e1.y, e1.y * e1.y);
        vec3 c32 = vec3(2.0 * e3c.x * e2c.x, e3c.x * e2c.y + e3c.y * e2c.x, 2.0 * e3c.y * e2c.y);
        vec3 c22 = vec3(e2c.x * e2c.x, e2c.x * e2c.y, e2c.y * e2c.y);
        H = C1 * c03 - 2.0 * C1 * c11 + 2.0 * C0 * c12 - 2.0 * a2 * c32 - 2.0 * a3 * c22;
      }
      H *= sg;
    }
    if (g2 > 0.0) {
      // The level set's curvature, then into pixels. Clamped for the same reason Loop-Blinn clamps
      // it: a huge kappa at a vanishing gradient is noise, not geometry.
      //
      float kap = (H.x * nrm.y * nrm.y - 2.0 * H.y * nrm.x * nrm.y + H.z * nrm.x * nrm.x) * ig;
      sd += clamp(kap * emPerPx, -2.0, 2.0) / 24.0;
    }
  }
  if (hornGeo) {
    // The inside normal: the arc's left, or its right where the patch loop runs clockwise.
    vec2 hl = normalize(vec2(-hornT.y, hornT.x)) * (hornRight ? -1.0 : 1.0);
    if (hornLine) { sd = dot(hl, p - hornF) * invPx; nrm = hl; }
    else {
      vec2 hv = p - hornF;
      float hs = dot(hl, hv) < 0.0 ? -1.0 : 1.0, hvl = length(hv);
      sd = hs * hornAd;
      nrm = hvl > 0.0 ? hs * hv / hvl : hl;
    }
  }
  softOut = exactBoxCov(nrm, sd);
  sdOut = sd; nOut = nrm;
  // ON ITS own ARC, IN ITS own AA BAND. Both halves matter: an implicit's zero set is the whole
  // algebraic curve, so being near the ZERO SET proves nothing on its own -- the far branch is
  // near its zero set too. Being near the zero set AND inside the drawn arc's bounding box is what
  // says this fragment is on the outline the artwork actually has. A Bezout cubic carries no box
  // (its coefficients need those slots), so it can never make this claim.
  nearOut = !isCut && hasBox && abs(sd) <= CP_AA_REACH && boxPx <= CP_AA_REACH;
  CP_COMPANION(sd)
  if (cutSdOn) sdStep = cutSd;
  // ...AND A QUADRATIC SEAM PAST ITS OUTLINE END DEFERS TO THE OUTLINE'S NORMAL TOO: its
  // ends and their outward legs from the arc (texels 5-6), the four outline legs' angles from texel 2, which a
  // quadratic's implicit never reads.
  if (isCut && endW > 0.5 && sdStep < -cutRes && kind > 0.5 && kind < 1.5) {
    vec4 qa = CPFETCH(t + 5), qb = CPFETCH(t + 6), qg = CPFETCH(t + 2);
    if (sq0) { vec2 q = p - qa.xy;
      if (dot(q, qa.xy - qa.zw) > 0.0 && dot(q, vec2(cos(qg.x), sin(qg.x))) >= 0.0 && dot(q, vec2(cos(qg.y), sin(qg.y))) < 0.0) return 1.0; }
    if (sq1) { vec2 q = p - qb.xy;
      if (dot(q, qb.xy - qa.zw) > 0.0 && dot(q, vec2(cos(qg.z), sin(qg.z))) >= 0.0 && dot(q, vec2(cos(qg.w), sin(qg.w))) < 0.0) return 1.0; }
  }
  return isCut ? step(-cutRes, sdStep) : softOut;
#undef CP_COMPANION
#endif
#endif
}
#endif

#ifdef MANTLE_CPATCH

float cpatchLineCov(vec4 e, vec2 p, float emPerPx, out bool cutOut, out float softOut, out bool nearOut) {
  // The arc-degree bit rides in the same slot and means nothing to a line; strip it, or a
  // three-point arc that packed to a LINE implicit reads as kind 32 and matches no test at all.
  float kraw = e.w > CP_ARC3 - 0.5 ? e.w - CP_ARC3 : e.w;
  bool isCut = kraw > 7.5;
  cutOut = isCut; softOut = 1.0; nearOut = false;
  float gLen = max(length(e.xy), 1e-20);
  float sd = (dot(e.xy, p) + e.z) / gLen / max(emPerPx, 1e-30);
  // Kinds 14, 16 and 17 are hull planes: along a cut, bridging, and along an arc. See
  // cpatchCurveCov for what each one does and why.
  if (kraw > 16.5) return exactBoxCov(e.xy, (dot(e.xy, p) + e.z) / max(emPerPx, 1e-30));
  if (kraw > 15.5) return step(0.0, dot(e.xy, p) + e.z);
  if (kraw > 13.5) return step(-CP_POS_REL * (abs(p.x) + abs(p.y)) / max(emPerPx, 1e-30) - CP_CUT_TIE, (dot(e.xy, p) + e.z) / max(emPerPx, 1e-30));
  if (sd > (isCut ? 0.25 : CP_AA_REACH)) return 1.0;      // far inside: nothing to place
  softOut = exactBoxCov(e.xy / gLen, sd);
  nearOut = !isCut && abs(sd) <= CP_AA_REACH;
  return isCut ? step(-CP_POS_REL * (abs(p.x) + abs(p.y)) / max(emPerPx, 1e-30) - CP_CUT_TIE, sd) : softOut;
}


  // The whole primitive: inside is the intersection of every bounding curve's half-space, so
  // coverage is their minimum. The patch's cover quad is its oriented bounding box, clipped by
  // the rasterizer exactly as a control triangle clips an ordinary Loop-Blinn crescent — the
  // box costs no ALU here at all.
/// Area only, for callers that do not need the seam flag.
///
/// At file scope, because the diagnostics MANTLE_CPATCH_REJHARD, SHOWREJ and SHOWN call it: a
/// function definition nested in a function compiles under no GLSL, and inside a block the
/// preprocessor removes it would not exist for them.
float cpatchCurveCov(int idx, vec2 p, float emPerPx) {
  bool c_, n_, h_; float s_, sd_, o_;
  vec2 g_;
  return cpatchCurveCov(idx, p, emPerPx, c_, s_, n_, h_, sd_, g_, o_);
}

#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
// Certified complete polynomial paint area. Nesting is resolved during preparation;
// uncertain geometry and morph follow tapes retain their existing kernels.
vec2 cpAreaEval(vec2 p0, vec2 p1, vec2 p2, float t) {
  return mix(mix(p0, p1, t), mix(p1, p2, t), t);
}
vec2 cpAreaRoots(float a, float b, float c) {
  vec2 roots = vec2(-1.0);
  if (a == 0.0) {
    if (b != 0.0) roots.x = -c / b;
  } else {
    float disc = b*b - 4.0*a*c;
    // A curve TANGENT to a pixel wall (a glyph's bottom on the pixel grid) has a double root that float32 rounds to a slightly
    // negative discriminant; read within a few ulps of its terms, it is the double root, not "no crossing" (which clipped the
    // span at the wrong end and painted a whole pixel row where the shape covers none).
    if (disc < 0.0 && disc >= -64.0 * 1.1920929e-7 * (b*b + abs(4.0*a*c))) disc = 0.0;
    if (disc >= 0.0) {
      float sq = sqrt(disc), q = -0.5 * (b + (b < 0.0 ? -sq : sq));
      roots = q == 0.0 ? vec2(-b/(2.0*a)) : vec2(q/a, c/q);
    }
  }
  return roots;
}
// A monotone quadratic span contains at most one crossing of each wall.
float cpAreaRootIn(float a,float b,float c,float lo,float hi) {
  vec2 roots=cpAreaRoots(a,b,c);
  float m=0.5*(lo+hi);
  return clamp(abs(roots.x-m)<=abs(roots.y-m)?roots.x:roots.y,lo,hi);
}
float cpAreaCurve(vec2 p0, vec2 p1, vec2 p2) {
  if (max(max(p0.x,p1.x),p2.x) <= 0.0) return 0.0;
  if (min(min(p0.x,p1.x),p2.x) >= 1.0)
    return clamp(p2.y,0.0,1.0)-clamp(p0.y,0.0,1.0);
  if (max(max(p0.y,p1.y),p2.y) <= 0.0 || min(min(p0.y,p1.y),p2.y) >= 1.0) return 0.0;
  vec2 a=p0-2.0*p1+p2,b=2.0*(p1-p0);
  float tx=a.x==0.0?1.0:-b.x/(2.0*a.x),ty=a.y==0.0?1.0:-b.y/(2.0*a.y);
  if(tx<=0.0||tx>=1.0)tx=1.0;
  if(ty<=0.0||ty>=1.0)ty=1.0;
  float first=min(tx,ty),second=max(tx,ty),area=0.0;
  for(int span=0;span<3;span++) {
    float lo=span==0?0.0:(span==1?first:second),hi=span==0?first:(span==1?second:1.0);
    if(hi<=lo)continue;
    vec2 pl=cpAreaEval(p0,p1,p2,lo),ph=cpAreaEval(p0,p1,p2,hi);
    if(max(pl.y,ph.y)<=0.0||min(pl.y,ph.y)>=1.0)continue;
    float yl=pl.y,yh=ph.y;
    bool up=ph.y>=pl.y;
    if(up?yl<0.0:yl>1.0) {float wall=up?0.0:1.0;lo=cpAreaRootIn(a.y,b.y,p0.y-wall,lo,hi);yl=wall;}
    if(up?yh>1.0:yh<0.0) {float wall=up?1.0:0.0;hi=cpAreaRootIn(a.y,b.y,p0.y-wall,lo,hi);yh=wall;}
    if(hi<=lo)continue;
    pl=cpAreaEval(p0,p1,p2,lo);ph=cpAreaEval(p0,p1,p2,hi);
    if(max(pl.x,ph.x)<=0.0)continue;
    if(min(pl.x,ph.x)>=1.0) {area+=yh-yl;continue;}
    bool right=ph.x>=pl.x;
    // The saturated part telescopes in y; integrate only 0<x<1.
    if(right?ph.x>1.0:pl.x>1.0) {
      float t=cpAreaRootIn(a.x,b.x,p0.x-1.0,lo,hi),y=cpAreaEval(p0,p1,p2,t).y;
      area+=right?yh-y:y-yl;
      if(right)hi=t;else lo=t;
    }
    if(right?pl.x<0.0:ph.x<0.0) {
      float t=cpAreaRootIn(a.x,b.x,p0.x,lo,hi);
      if(right)lo=t;else hi=t;
    }
    float h=hi-lo,m=0.5*(lo+hi),d=0.2886751345948129*h,t0=m-d,t1=m+d;
    if(h>0.0) area+=0.5*h*(cpAreaEval(p0,p1,p2,t0).x*2.0*mix(p1.y-p0.y,p2.y-p1.y,t0)
                  +cpAreaEval(p0,p1,p2,t1).x*2.0*mix(p1.y-p0.y,p2.y-p1.y,t1));
  }
  return area;
}
// Both entry points must accept the same record bound as the native integrator.
#if defined(MANTLE_NO_CUBIC) || defined(MANTLE_CPATCH_NO_CUBIC_AREA)
#define CP_AREA_MAX_CURVES 64
#else
#define CP_AREA_MAX_CURVES 256
#endif
float cpConvexArea(int first,int n,vec2 dx,vec2 dy) {
  float det=dx.x*dy.y-dx.y*dy.x;
  vec2 mapX=vec2(dy.y,-dy.x)/det,mapY=vec2(-dx.y,dx.x)/det;
  float area=0.0;
  for(int i=0;i<CP_AREA_MAX_CURVES;i++) {
    if(i>=n) break;
    int t=(first+i)*7;
    vec4 e0=CPFETCH(t),g0=CPFETCH(t+5),g1=CPFETCH(t+6);
    vec2 q0=g0.xy-vEm,q1=g0.zw-vEm,q2=g1.xy-vEm;
    vec2 p0=vec2(dot(mapX,q0),dot(mapY,q0))+0.5;
    vec2 p1=vec2(dot(mapX,q1),dot(mapY,q1))+0.5;
    vec2 p2=vec2(dot(mapX,q2),dot(mapY,q2))+0.5;
    float tag=e0.w-CP_AREA-(e0.w>=CP_AREA+CP_AREA_RIGHT-0.5?CP_AREA_RIGHT:0.0);
    if(tag<0.5) {p2=p1;p1=0.5*(p0+p2);}
#if !defined(MANTLE_NO_CUBIC) && !defined(MANTLE_CPATCH_NO_CUBIC_AREA)
    if(tag>33.5) {
      vec2 q3=g1.zw-vEm;
      vec2 p3=vec2(dot(mapX,q3),dot(mapY,q3))+0.5;
      vec2 lo=min(min(p0,p1),min(p2,p3)),hi=max(max(p0,p1),max(p2,p3));
      // Hull bounds prove these cases without root solving. AAC's band walker
      // already rejects the left hull; this complete-paint walk must do so itself.
      if(hi.x>0.0 && hi.y>0.0 && lo.y<1.0) {
        if(lo.x>=1.0) area+=clamp(p3.y,0.0,1.0)-clamp(p0.y,0.0,1.0);
        else if(all(greaterThanEqual(lo,vec2(0.0))) && all(lessThanEqual(hi,vec2(1.0))))
          area+=aacZoneInt(aacCubicCoeff(p0.x,p1.x,p2.x,p3.x),aacCubicCoeff(p0.y,p1.y,p2.y,p3.y),0.0,1.0);
        // AAC's clipped native cubic integral uses the opposite Green orientation.
        else area-=aacCubicContrib(p0,p1,p2,p3,0.0,1.0);
      }
    } else
#endif
      area+=cpAreaCurve(p0,p1,p2);
  }
  return clamp(abs(area),0.0,1.0);
}

#endif

float cpatchCoverage() {
#ifdef MANTLE_CPATCH_QUADRATIC_AREA_ONLY
    vec2 dx=dFdx(vEm),dy=dFdy(vEm);
    // (the constant inverse map where the draw has one, as main's: see areaDx below)
    if(any(notEqual(vAffineFootprint,vec4(0.0)))){dx=vAffineFootprint.xy;dy=vAffineFootprint.zw;}
    if(abs(dx.x*dy.y-dx.y*dy.x)==0.0)return 0.0;
    return cpConvexArea(int(cCen.x+0.5),int(cCen.y+0.5),dx,dy);
#else
    // Derivatives precede divergent ownership/cell rejection.
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
    vec2 areaDx=dFdx(vEm),areaDy=dFdy(vEm);
    // THE CONSTANT INVERSE MAP WHERE THE DRAW HAS ONE, as main takes it. An area cell is two triangles over its box. Where their shared edge runs through pixel centers,
    // a 2x2 block with one covered pixel differences it against helper pixels the GPU holds to the edge: read on ANGLE/Metal at a diagonal, dFdx 0, dFdy (-e, -e), a zero
    // determinant, and every other pixel of the diagonal drew 0 inside a solid fill.
    if(any(notEqual(vAffineFootprint,vec4(0.0)))){areaDx=vAffineFootprint.xy;areaDy=vAffineFootprint.zw;}
#endif
#ifdef MANTLE_CPATCH_DEBUG
    return 1.0;     // full cover-box coverage: separates "do these fragments run" from "is the
                    // coverage right", for every kind.
#endif
    // One cell owns each fragment. gridSplitPatch cuts a patch on a common grid and the packer
    // sends each cell its own box; a HALF-OPEN test against it makes the cells tile exactly, so a
    // fragment is shaded by exactly one of them. Without this, dilated covers (1.5px for the AA
    // ramp, +1% to close a rasterization crack) overlap by ~3px BY CONSTRUCTION and every fragment
    // in a seam band is shaded twice — invisible at alpha 1, doubling every overlap below it, and
    // the reason a depth claim would be needed to arbitrate at all.
    //
    // Half-open, and exact: adjacent boxes share bit-identical grid coordinates, so `< lo` and
    // `>= hi` can neither drop a fragment nor hand it to two cells. That is precisely what two
    // separately-derived cut edges cannot promise, and why growing the covers alone does not work.
    //
    // A zero box means an UNGRIDDED patch — one cell, owning everything its constraints admit.
    vec4 cell = vLB0;
    if (cell.z > cell.x && cell.w > cell.y
        && (vEm.x < cell.x || vEm.x >= cell.z || vEm.y < cell.y || vEm.y >= cell.w)) return 0.0;
    int first = int(cCen.x + 0.5), n = int(cCen.y + 0.5);
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
    if(n>=3 && n<=CP_AREA_MAX_CURVES && CPFETCH(first*7).w>=CP_AREA - 0.5
       && abs(areaDx.x*areaDy.y-areaDx.y*areaDy.x)>0.0)
      return cpConvexArea(first,n,areaDx,areaDy);
#endif
    int lineBlocks = 0;
#ifdef MANTLE_CPATCH_ONLYN5
    // MEASUREMENT only — paint only the patch that carries five curves, ignoring its constraints.
    // That shows where its cover quad actually lands, which is the one thing a per-fragment
    // rejection test cannot tell you.
    if (n != 5) return 0.02;
    return 1.0;
#endif
#ifdef MANTLE_CPATCH_SHOWX
    // MEASUREMENT only — paint vEm.x over the shape's own coordinate range. Every check on the
    // CPU assumes the kernel is fed SHAPE coordinates; this is the one that verifies it.
    return clamp((vEm.x - 50.0) / 300.0, 0.02, 1.0);
#endif
#ifdef MANTLE_CPATCH_REJHARD
    // Which curve rejects OUTRIGHT (coverage 0), not merely falls under half.
    {
      for (int i = 0; i < 32; i++) {
        if (i >= n) break;
        if (cpatchCurveCov(first + i, vEm, vEmPerPx) <= 0.0)
#ifdef CP_REJ_IDX
          // ONE INDEX AT A TIME, because the encoded form cannot be read back: the framebuffer is
          // not guaranteed linear, and (i+1)/32 through an unknown transfer curve decodes to a
          // non-integer. Solid when the index under test is the one that rejects, nothing
          // otherwise, and a sweep says which without any decoding at all.
          return (i == CP_REJ_IDX) ? 1.0 : 0.02;
#else
          return clamp(float(n * 8 + i + 1) / 64.0, 0.02, 1.0);   // decode: v*64 -> n*8 + i+1
#endif
      }
      return 0.015;
    }
#endif
#ifdef MANTLE_CPATCH_SHOWREJ
    // MEASUREMENT only — paint WHICH curve rejects the fragment, as index+1 over 8. A hole that
    // survives every data check has to be named by the kernel itself.
    {
      for (int i = 0; i < 32; i++) {
        if (i >= n) break;
        // OVER 32, NOT 8. Divided by 8 every index from 7 up clamps to 1.0 and reads as "c7", which
        // is a ceiling rather than an answer -- it would hide whether the rejecting constraint is the
        // patch's last or one well past its end.
        if (cpatchCurveCov(first + i, vEm, vEmPerPx) < 0.5) return clamp(float(i + 1) / 32.0, 0.02, 1.0);
      }
      return 0.01;                       // nothing rejects: this fragment should be painted
    }
#endif
#ifdef MANTLE_CPATCH_SHOWN
    // MEASUREMENT only — paint the curve COUNT the fragment actually resolved, so a patch whose
    // varying or index arrives wrong shows up as a differently-shaded wedge rather than a hole.
    return clamp(float(n) / 8.0, 0.02, 1.0);
#endif
    // A CUT BOUNDS THE PATCH, NOT THE SHAPE — so it must not reject inside the AA band.
    //
    //
    float cov = 1.0, cutHard = 1.0, cutFar = 1.0;
    // The cover-hull planes get their own pair, not the cut's. Both are hard steps that must not
    // clip an edge ramp, but they answer to different gates -- see where they are applied.
    float hullHard = 1.0, hullSoft = 1.0, sdHull = 1e30, sdEdge = 1e30;
    bool nearArc = false;

    float exC1 = 1.0, exD1 = 0.0, exC2 = 1.0, exD2 = 0.0;
    vec2 exN1 = vec2(0.0), exN2 = vec2(0.0);

    for (int i = lineBlocks; i < 128; i++) {
      if (i >= n) break;
      // The cut flag comes BACK from the evaluation instead of being fetched ahead of it: the
      // constraint reads that same texel first thing, so asking twice cost one fetch per
      // constraint per fragment for a bit it already had.
#ifdef MANTLE_CPATCH_BODYCOST
      // MEASUREMENT only — price a BIGGER LOOP BODY, without building the layout that would need
      // one. The packed-line experiment showed a second loop costs 2-4% merely by existing; the
      // one-loop alternative trades that second loop for a body that dispatches a block as either
      // a curve or four lines, and the question is whether a bigger body costs the same. This is
      // that body's shape, behind a test that is false at runtime and cannot be folded at compile
      // time: vEmPerPx is em-per-pixel and strictly positive, so min(vEmPerPx, 0) is 0, and no
      // compiler can prove it.
      if (min(vEmPerPx, 0.0) < -1.0) {
        int b4 = (first + i) * 5;
        bool cA, nA; float sA;
        cov = min(cov, cpatchLineCov(texFetch(ivec2(b4 + 0, 0)), vEm, vEmPerPx, cA, sA, nA));
        cov = min(cov, cpatchLineCov(texFetch(ivec2(b4 + 1, 0)), vEm, vEmPerPx, cA, sA, nA));
        cov = min(cov, cpatchLineCov(texFetch(ivec2(b4 + 2, 0)), vEm, vEmPerPx, cA, sA, nA));
        cov = min(cov, cpatchLineCov(texFetch(ivec2(b4 + 3, 0)), vEm, vEmPerPx, cA, sA, nA));
      }
#endif
      bool cut9, near9, hull9; float soft9, sd9, outl9; vec2 n9;
      float c9 = cpatchCurveCov(first + i, vEm, vEmPerPx, cut9, soft9, near9, hull9, sd9, n9, outl9);
      if (hull9) { hullHard = min(hullHard, c9); hullSoft = min(hullSoft, soft9); sdHull = min(sdHull, sd9); }
      else if (cut9) {
        if (near9) cutFar = min(cutFar, c9);        // past its span: the step holds only off the patch's own edges
        else cutHard = min(cutHard, c9);
        // The outline across the seam bounds the fragment (CP_COMP): it takes
        // coverage and names no edge, so where it binds there is no edge distance to compare a hull
        // plane against.
        if (outl9 < cov) sdEdge = 1e30;
        cov = min(cov, outl9);
      }
      else {
        if (c9 < cov) sdEdge = sd9;
        cov = min(cov, c9); nearArc = nearArc || near9;
        if (c9 < 1.0 && dot(n9, n9) > 0.0) {
          if (c9 < exC1) { exC2 = exC1; exD2 = exD1; exN2 = exN1; exC1 = c9; exD1 = sd9; exN1 = n9; }
          else if (c9 < exC2) { exC2 = c9; exD2 = sd9; exN2 = n9; }
        }
      }

    }

    if (exC2 < 1.0) {
      float ex2;
      cpExactBoxCov23(-exN1, exD1, -exN2, exD2, vec2(0.0), 1.0, false, ex2);
      cov = min(cov, ex2);
    }
        //
    // A cover-hull plane that runs ALONG the shape's own outline partitions nothing: the far side
    // of it is outside the shape, so there is no second patch to conflate with, and its hard step
    // is pure loss -- it zeroes the very edge ramp the outline constraint just computed. A plane
    // that runs through the INTERIOR is the opposite: it is the partition, and softening it makes
    // two patches each paint ~0.5 of a pixel that OVER then composites to 0.75.
    //
    // Which one this is needs no plane comparison, because the two cases already say different
    // things: where the plane lies along the outline it reports the same area the outline does, and
    // where it partitions the interior it does not. So "does this bound agree with my own edge"
    // IS the test, it costs a subtract, and it is exact in the sense that matters -- a plane that
    // agrees to within a fiftieth of a pixel's coverage cannot be the thing excluding this patch.
    //
    // THE SKIRT CARRIES ONE PLANE, its distance taken from the vertices. Adding a corner plane (with
    // a diagonal or a midpoint split, soft or hard) does not pay: every such configuration that fixes
    // the AA at corners leaks, and every one that holds the leak is binary at corners. The reason is
    // structural rather than a missing trick: a skirt fragment carries TWO of its patch's planes and a
    // patch has up to six, so wherever a third is the binding bound -- a patch thinner than the reach,
    // which is where this route's residual error is -- relaxing either of the two leaves nothing
    // holding the fragment in. The packed rows may relax precisely because they hold every plane. The fence's AA advantage
    // is therefore bought with the fetches, not with cleverness, and closing it from this side wants
    // the DECOMPOSITION to stop producing patches thinner than a pixel, not more varyings.
    //
    // Two gotchas worth keeping. exactBoxCov reads only |n.x| and |n.y|, so it is EVEN in the normal
    // and a hull plane's inward n works there by accident; exactBoxCov2 clips a real
    // polygon twice and is NOT even, so inward normals must be negated or it intersects the two
    // OUTSIDE half-planes. And splitting the skirt quad on its DIAGONAL looks cheaper than splitting
    // at the edge midpoint and is wrong: the far triangle spans both corners while naming one, so
    // every fragment near the other corner is handed a plane it is nowhere near.
    // THE BOX FIRST, because it is the primitive's own bound and the cheapest thing in this file.
    // A patch is its curves INSIDE A BOX (Dokter et al.); the half-spaces alone are an unbounded
    // intersection, and what leaks when the packed hull rows come off is that unboundedness -- full
    // intensity ink where every constraint agrees by accident, far from any arc. Four lines reject
    // it for two dots.
    //
    vec2 bxA = cBoxA;
    if (dot(bxA, bxA) > 1e-12) {
      vec2 bxB = vec2(-bxA.y, bxA.x);
      float bu = dot(bxA, vEm), bv = dot(bxB, vEm);
      float bd = min(min(bu - cBoxU.x, cBoxU.y - bu), min(bv - cBoxV.x, cBoxV.y - bv))
               / max(vEmPerPx, 1e-30);
      hullHard = min(hullHard, step(-CP_BOX_SLACK, bd));
    }

    vec2 hvN = vTC.xy;
    float hvL = length(hvN);
    hullHard = min(hullHard, exactBoxCov(hvL > 1e-9 ? hvN / hvL : vec2(1.0, 0.0), vTC.z));

    sdHull = min(sdHull, vTC.z);
    // WHERE THE PLANE IS THE EDGE, IT IS REDUNDANT -- so DROP it rather than soften it. If the two
    // are the same plane the outline constraint has already contributed exactly the area this plane
    // would, and min() with its own value again is a no-op. That makes the whole repair free: no
    // area form, no second normal, one float compared against another.
    bool hullRedundant = nearArc && cov < CP_SEAM_NEAR && sdEdge < 1e29 && sdHull < 1e29
                         && abs(sdEdge - sdHull) < CP_HULL_AGREE;
    // The same gate the cut planes get. A hull plane is hard about OWNERSHIP and wrong as a
    // COVERAGE, and the seam gate is the existing answer to that: where the patch's own outline
    // says this fragment is mid-ramp (cov < CP_SEAM_NEAR), the plane contributes its exact area
    // instead of its verdict, exactly as a CUT gets; without it edge pixels lose their ramp. The
    // redundancy test still stands above it, for the plane that IS the outline.
    cov = min(cov, hullRedundant ? 1.0 : ((nearArc && cov < CP_SEAM_NEAR) ? hullSoft : hullHard));
    // The seam last: a step, which is the ownership. The fence above ramps beside the patch's own arc because cutHard zeroes
    // every fragment whose center is not this patch's -- the hull plane only has the AA band beside the arc to decide, and a
    // step there took the band off the outline.
    cov = min(cov, cutHard);
    if (!nearArc) cov = min(cov, cutFar);
        //
    //   applied to every all-seam patch      wrong solid 1 -> 4375
    //   gated to a sub-pixel facing pair     1 -> 276   (ribbon under 1.0px)
    //   ...under 0.5px                       1 -> 32
    //   ...under 0.25px                      1 -> 8,  JAGGY 234 -> 264
    //
    if (cov < 0.004) discard;
    return LBCOV_OUT(cov);
#endif
}
#endif
