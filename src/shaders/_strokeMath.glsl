// _strokeMath.glsl — analytic stroke-DISTANCE math, shared (spliced via the
// @@STROKE_MATH@@ marker) between the Slug stroke walk and the morph stroke pass.
// The analytic closest-point + caps / joins / dasharray distance field: closest
// point via Newton on the curve parameter from a coarse seed; cap/join logic;
// dash phase. Requires @@CURVE_ARCLEN@@ (cubicCoeff / evalC / evalCD /
// slugCubicArcLen) included BEFORE this, and the includer to declare
// `uniform sampler2D uDashTex;` (dashCovered).

// True iff `dist` (along-path em-space) lies inside a DASH (not a gap) for dashId.
// Row 0 of uDashTex: .r=cycleLen .g=patternCount .b=dashOffset. Pattern values
// follow across texels 1..15; pattern[k] at texel 1+k/4, component k%4.
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

// Perpendicular distance from q (RELATIVE to the join vertex) to an edge's
// extended centerline arc: the osculating circle of signed curvature `kappa`
// tangent to `tan` at the vertex. Straight (kappa≈0) → distance to the tangent
// line. The ±halfW band around this arc is the SVG2 `arcs`-join extended stroke;
// this reduces to the miter's perpendicular-to-tangent-line when kappa == 0.
float perpDistToArc(vec2 q, vec2 tan, float kappa) {
  vec2 L = vec2(-tan.y, tan.x);                 // left normal
  if (abs(kappa) < 1e-6) return abs(dot(q, L)); // straight edge → tangent line
  float R = 1.0 / kappa;                         // signed radius
  vec2 CC = R * L;                               // osculating center (vertex at origin)
  return abs(length(q - CC) - abs(R));
}

// Cap / join / dasharray distance modifier at a segment's endpoints. `t` is the
// closest-point param, `thisD` the closest-point distance; pStart/pEnd/dStart/
// dEnd are the endpoints + derivatives RELATIVE to the query point. inTan/outTan
// are the neighbour tangents (joins); free* + startPrevReach/endNextReach gate
// caps-vs-joins. butt drops; square extends halfW; miter fills the wedge to the
// miter point (≤ miterLimit·halfW); arcs (joinStyle 4) extends each edge as an
// arc of its centerline curvature (`curv` = kSelfStart,kSelfEnd,kPrevEnd,kNextStart),
// bevel-fallback past miterLimit. Returns the (possibly dropped) min distance.
float strokeCapsJoinsDash(
    float t, float thisD, vec2 pStart, vec2 pEnd, vec2 dStart, vec2 dEnd,
    bool freeStart, bool freeEnd, int startCap, int endCap,
    int joinStyle, float miterLimit, float halfW,
    vec2 inTan, vec2 outTan, float startPrevReach, float endNextReach,
    int dashId, float startDist, float arcLenAtT, vec4 curv, float minDIn) {
  bool drop = false;
  if (t < 1e-4) {
    if (freeStart) {
      if (startCap == 0) {
        // BUTT CAP AS AN SDF, NOT A HARD DROP. Dropping makes the cap plane a
        // binary edge: the pixel the plane bisects gets all or nothing, where the
        // truth is a partial. The capped stroke is the INTERSECTION of the tube
        // and the half-space behind the plane, so its SDF is
        //   max(dist - halfW, aOut)   ==>   dist_eff = max(dist, halfW + aOut)
        // which is the same idiom the bevel branch below already uses. aOut is
        // how far the pixel lies BEYOND the plane (positive = outside), so a
        // pixel one unit inside reports distance halfW-1 and ramps correctly.
        float tL0 = max(length(dStart), 1e-12);
        float aOut = dot(-pStart, -(dStart / tL0));
        thisD = max(thisD, halfW + aOut);
      }
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
      // MITER LENGTH IS halfW/sin(theta/2). `c` is the cosine of the INTERIOR
      // angle between the two segments, so the half-angle identity is
      // sin(theta/2) = sqrt((1 - c)/2); the (1 + c) form gives cos(theta/2) and is
      // inverted (too short at sharp corners, unbounded at flat ones — it diverges
      // at theta=180 where the true miter is exactly halfW). See _coverage.glsl.
      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
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
      // SVG2 arcs: extend each edge's centerline as its osculating circle; the
      // ±halfW band is the extended stroke, and the join wedge is both bands
      // past the vertex. Reduces to miter when curvatures are 0.
      vec2 segTan = dStart / max(length(dStart), 1e-12);
      vec2 ep = pStart;
      if (startPrevReach < 1e8 && dot(-ep, inTan) < 0.0) drop = true;
      float c = dot(-segTan, inTan);
      // MITER LENGTH IS halfW/sin(theta/2). `c` is the cosine of the INTERIOR
      // angle between the two segments, so the half-angle identity is
      // sin(theta/2) = sqrt((1 - c)/2); the (1 + c) form gives cos(theta/2) and is
      // inverted (too short at sharp corners, unbounded at flat ones — it diverges
      // at theta=180 where the true miter is exactly halfW). See _coverage.glsl.
      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
      if (miterLen > halfW * miterLimit) {
        // Past miterLimit → bevel fallback (same chord as joinStyle 2).
        float cr = inTan.x * segTan.y - inTan.y * segTan.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(segTan.y, -segTan.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl;
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
      } else if (dot(-ep, -segTan) >= 0.0) {
        float perpThis  = perpDistToArc(-ep, segTan, curv.x);  // this seg's start κ
        float perpOther = perpDistToArc(-ep, inTan, curv.z);   // prev seg's end κ
        thisD = min(thisD, max(perpThis, perpOther));
      }
    } else {
      vec2 ep = pStart;
      if (dot(-ep, inTan) < 0.0) drop = true;
      else if (joinStyle == 2) {
        // EXACT BEVEL: clip the round corner to the bevel chord — the line joining
        // the two segments' outer offset points (hw·nA, hw·nB) — as an AA distance
        // (raise thisD so coverage crosses 0.5 at the chord), leaving the flat
        // bevel triangle. tA = incoming dir (inTan), tB = this seg's start dir.
        vec2 tB = dStart / max(length(dStart), 1e-12);
        float cr = inTan.x * tB.y - inTan.y * tB.x;       // turn sign → outer side
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
      if (endCap == 0) {
        // Butt cap as an SDF — see the start twin.
        float tL1 = max(length(dEnd), 1e-12);
        float aOut = dot(-pEnd, dEnd / tL1);
        thisD = max(thisD, halfW + aOut);
      }
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
      // MITER LENGTH IS halfW/sin(theta/2). `c` is the cosine of the INTERIOR
      // angle between the two segments, so the half-angle identity is
      // sin(theta/2) = sqrt((1 - c)/2); the (1 + c) form gives cos(theta/2) and is
      // inverted (too short at sharp corners, unbounded at flat ones — it diverges
      // at theta=180 where the true miter is exactly halfW). See _coverage.glsl.
      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
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
      // SVG2 arcs (end-vertex twin of the start-join above).
      vec2 segTan = dEnd / max(length(dEnd), 1e-12);
      vec2 ep = pEnd;
      if (endNextReach < 1e8 && dot(-ep, outTan) > 0.0) drop = true;
      float c = dot(segTan, -outTan);
      // MITER LENGTH IS halfW/sin(theta/2). `c` is the cosine of the INTERIOR
      // angle between the two segments, so the half-angle identity is
      // sin(theta/2) = sqrt((1 - c)/2); the (1 + c) form gives cos(theta/2) and is
      // inverted (too short at sharp corners, unbounded at flat ones — it diverges
      // at theta=180 where the true miter is exactly halfW). See _coverage.glsl.
      float sinHalf = sqrt(max(0.5 * (1.0 - c), 1e-9));
      float miterLen = halfW / max(sinHalf, 1e-6);
      if (miterLen > halfW * miterLimit) {
        float cr = segTan.x * outTan.y - segTan.y * outTan.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(segTan.y, -segTan.x), nB = sd * vec2(outTan.y, -outTan.x);
        vec2 nb = nA + nB; float bl = length(nb);
        if (bl > 1e-4) { vec2 bis = nb / bl;
          thisD = max(thisD, halfW + dot(-ep, bis) - halfW * dot(nA, bis)); }
      } else if (dot(-ep, segTan) >= 0.0) {
        float perpThis  = perpDistToArc(-ep, segTan, curv.y);  // this seg's end κ
        float perpOther = perpDistToArc(-ep, outTan, curv.w);  // next seg's start κ
        thisD = min(thisD, max(perpThis, perpOther));
      }
    } else {
      vec2 ep = pEnd;
      if (dot(-ep, outTan) > 0.0) drop = true;
      else if (joinStyle == 2) {
        // EXACT BEVEL (see the start-join twin above). tA = this seg's end dir,
        // tB = outgoing dir (outTan); the chord matches the next seg's start-join.
        vec2 tA = dEnd / max(length(dEnd), 1e-12);
        float cr = tA.x * outTan.y - tA.y * outTan.x;
        float sd = (cr >= 0.0) ? 1.0 : -1.0;
        vec2 nA = sd * vec2(tA.y, -tA.x), nB = sd * vec2(outTan.y, -outTan.x);
        vec2 nb = nA + nB; float bl = length(nb);
        // AA chord, not a hard drop: raise thisD so coverage crosses 0.5 AT the
        // chord (chordDist=0) and ramps beyond — leaving the flat bevel triangle.
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

// Cubic stroke distance accumulator. Closest-point via 9-sample seed (+8 mid-cell
// for near-zero-velocity s-cubics) → Newton 3 iters; cap/join via the shared
// helper. p12=(P0,P1), p34=(P2,P3) RELATIVE to the query point.
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

// Closed-form arc length of a quadratic Bézier over [0,t] (encoder + hit-test
// parity). p1/p2/p3 render-relative. Falls back to the chord when nearly straight.
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

// EXACT closest-point parameter on a quadratic Bezier to the ORIGIN.
//
// dot(Q(t), Q'(t)) = 0 is a CUBIC in t, so it has a closed form. This used to be
// a 5-sample seed (t = 0, 1/4, 1/2, 3/4, 1) plus 3 Newton steps, which leaves an
// error fixed in EM — a scale-bounded approximation, which is the one thing the
// geometry is not allowed to be: the stroke mesh is built once and used at any
// zoom, so a fixed em error grows without bound in PIXELS. Measured on the butt
// caps of `M20 100 Q64 10 108 100`, the cap boundary sat ~0.22em off, invisible
// at 1x and 0.9px at 4x.
//
// `t` here is not only the distance parameter — the butt cap is implemented as
// "drop when t < 1e-4", so an inaccurate t moves the CAP PLANE too, which is why
// the residual clustered entirely at the two caps and not along the curve.
//
// Candidates are the in-range roots plus both endpoints; clamping a root outside
// [0,1] to the endpoint is correct, since the closest point on a segment is
// either an interior critical point or an end.
float quadClosestT(vec2 A, vec2 B, vec2 C) {
  float a3 = 2.0 * dot(A, A);
  float a2 = 3.0 * dot(A, B);
  float a1 = dot(B, B) + 2.0 * dot(A, C);
  float a0 = dot(B, C);
  float cand[5];
  int n = 0;
  cand[0] = 0.0; cand[1] = 1.0; n = 2;
  if (abs(a3) < 1e-12 * max(abs(a2), max(abs(a1), abs(a0)))) {
    if (abs(a2) > 1e-30) {                       // degenerates to a quadratic
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
    float pp = q2 - p * p / 3.0;                 // depressed cubic y^3 + pp*y + qq
    float qq = (2.0 * p * p * p) / 27.0 - (p * q2) / 3.0 + r;
    float shift = -p / 3.0;
    float disc = qq * qq / 4.0 + pp * pp * pp / 27.0;
    if (disc > 0.0) {                            // one real root
      float sd = sqrt(disc);
      float u = -qq / 2.0 + sd, v = -qq / 2.0 - sd;
      float uc = sign(u) * pow(abs(u), 1.0 / 3.0);
      float vc = sign(v) * pow(abs(v), 1.0 / 3.0);
      cand[n++] = uc + vc + shift;
    } else {                                     // three real roots (trigonometric)
      float rr = sqrt(max(-pp * pp * pp / 27.0, 0.0));
      float phi = acos(clamp(-qq / (2.0 * max(rr, 1e-30)), -1.0, 1.0));
      float m = 2.0 * sqrt(max(-pp / 3.0, 0.0));
      cand[n++] = m * cos(phi / 3.0) + shift;
      cand[n++] = m * cos((phi + 6.2831853071795865) / 3.0) + shift;
      cand[n++] = m * cos((phi + 12.566370614359172) / 3.0) + shift;
    }
  }
  // ONE Newton polish on the ROOTS (not the endpoints, which are exact bounds).
  // Cardano is closed-form but loses precision in float32 through the depressed-
  // cubic transform and the cbrt/acos branches. Measured in simulated float32
  // against a float64 reference over 3000 random quadratics:
  //   cardano alone            max 5.05e-4   mean 3.06e-7
  //   safe-Newton, 20 iters    max 2.90e-5   mean 4.55e-8
  //   cardano + 1 polish       max 5.59e-6   mean 7.56e-9
  // A second and third step change nothing — it is converged at one. A pure
  // bracketed safe-Newton (Yuksel-style, which is what solveCubicBisect does)
  // is MORE accurate than raw Cardano but only once it runs ~20 iterations; at
  // 2-8 it is far worse (max 16-56) because the bisection fallback crawls on a
  // wide bracket, and on SIMD the warp pays the worst-case count. Seeding with
  // the closed form and polishing once is both cheaper and more accurate.
  for (int i = 2; i < 5; i++) {
    if (i >= n) break;
    float t0 = cand[i];
    float ft = ((a3 * t0 + a2) * t0 + a1) * t0 + a0;
    float df = (3.0 * a3 * t0 + 2.0 * a2) * t0 + a1;
    if (abs(df) > 1e-30) cand[i] = t0 - ft / df;
  }
  float bt = 0.0, bs = 1e30;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    float tt = clamp(cand[i], 0.0, 1.0);
    vec2 qv = (A * tt + B) * tt + C;
    float d2 = dot(qv, qv);
    if (d2 < bs) { bs = d2; bt = tt; }
  }
  return bt;
}

// Native quadratic stroke accumulator (NOT degree-elevated). closest-point is a
// root of Q·Q' (a cubic) — solved in CLOSED FORM; closed-form arc length.
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
  float t = quadClosestT(A, B, C);   // exact: root of the cubic dot(Q, Q')
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
