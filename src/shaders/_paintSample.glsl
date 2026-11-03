// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _paintSample.glsl — gradient paint sampling, shared (spliced via @@PAINT_SAMPLE@@)
// between the Slug fill and the Loop-Blinn direct path. Requires
// @@GRADIENT_HELPERS@@ (sampleStops, gradientSpreadToExtend) included before it,
// and the includer to declare `uniform sampler2D uGradientTex;`. Guarded so the
// solid-only fill variant drops it.
#ifndef MANTLE_NO_GRADIENT
// The gradient parameter at gradient-space point gpos; ok is false where the gradient paints
// nothing (behind a cone's apex, or outside a rim-focus half-plane). `cone` is true for a radial whose focus lies
// outside its circle, and then `disc` is the root discriminant -- positive inside the cone, zero on
// its edge -- and outside the cone t is the edge's own parameter, so the caller can antialias the
// edge rather than cut it.
float gradientT(vec2 gpos, int gType, vec4 g0, vec4 g3, out bool ok, out bool cone, out float disc) {
  ok = true; cone = false; disc = 1.0;
  if (gType == 0) {
    vec2 p1 = g3.xy;
    vec2 p2 = g3.zw;
    vec2 d = p2 - p1;
    float dd = dot(d, d);
    return dot(gpos - p1, d) / dd;
  }
  vec2 c = g3.xy;
  float r = g3.z;
  float fxFrac = g3.w;
  float fyFrac = g0.w;
  // The quadratic is solved in units of the radius r: A, B and C are each the gradient-space values over r^2,
  // so t is unchanged, but B*B stays inside float32 when the art is authored at 2^28 or 2^-36 (the
  // unnormalized form overflows above ~1.3e19 and underflows below ~1e-19, and the whole gradient vanishes).
  // c - f is -frac * r exactly, so its normalized form needs no subtraction at all.
  vec2 frac = vec2(fxFrac, fyFrac);
  float invR = 1.0 / r;
  vec2 d = (gpos - c) * invR - frac;
  vec2 cf = -frac;
  // A focal radius (SVG 2 `fr`) rides as the remainder of the spread slot: slot = spread + q / 2, q = fr / (fr + r), so the spread is
  // round(slot) and q / 2 its fractional part (0 for every gradient without an fr, which takes none of the code below).
  float frHalf = g0.y - floor(g0.y + 0.5);
  if (frHalf > 0.0) {
    // THE GENERAL TWO-CIRCLE GRADIENT (canvas createRadialGradient, SVG 2 13.2.3): circle(t) has center f + t (c - f) and radius
    // fr + t (r - fr); a point takes the LARGEST t whose radius is not negative and whose circle passes through it, so the gradient
    // extends below 0 (pad) wherever the radius allows. With fr = 0 this is the cone code below. Roots by the cancellation-free pair
    // t1 = cc / m, t2 = m / a (m = b + sign(b) sqrt(b^2 - a cc)); a root past 1e12 is the one a vanishing `a` sends to infinity.
    float fq = 2.0 * frHalf;
    float fr = fq / (1.0 - fq);   // fr / r: this solve is in units of r (the radius is 1), like the rest of the function
    float dr = 1.0 - fr;
    float qa = dot(cf, cf) - dr * dr;
    float qb = dot(d, cf) + fr * dr;
    float qc = dot(d, d) - fr * fr;
    float qd = qb * qb - qa * qc;
    disc = 4.0 * qd;
    cone = qa > 0.0;
    // Equal circles (fr = r, one center): the ring between them is infinitely thin, the first stop inside it and the last outside, as Skia
    // (hence Chrome) draws it for pad. Hard-edged: the circle's edge is not antialiased.
    if (dr == 0.0 && qa == 0.0 && qb == 0.0) return qc < 0.0 ? 0.0 : 1.0;
    if (qd < 0.0) {
      // Outside the cone the double root b / a stands in for the edge's AA (as the fr = 0 code does), where it has a radius.
      if (!cone) { ok = false; return 0.0; }
      float te = qb / qa;
      if (!(fr + te * dr >= 0.0)) { ok = false; return 0.0; }
      return te;
    }
    float sq = sqrt(qd);
    float m = qb + (qb >= 0.0 ? sq : -sq);
    float t1 = m != 0.0 ? qc / m : 0.0;
    bool ok1 = m != 0.0 && fr + t1 * dr >= 0.0;
    float t2 = 0.0;
    // `a` is a difference of near-equal terms exactly where the focal circle touches the end circle internally (|c - f| = |r - fr|), so
    // it is judged against those terms (single precision: a few eps), not against zero. Below that the second root is at infinity.
    bool ok2 = m != 0.0 && abs(qa) > 1.0e-6 * (dot(cf, cf) + dr * dr) && abs(qa) * 1.0e12 > abs(m);
    if (ok2) { t2 = m / qa; ok2 = fr + t2 * dr >= 0.0; }
    if (!ok1 && !ok2) { ok = false; return 0.0; }
    if (ok1 && ok2) return max(t1, t2);
    return ok1 ? t1 : t2;
  }
  float A = dot(d, d);
  float B = 2.0 * dot(cf, d);
  float C = dot(cf, cf) - 1.0;
  disc = B * B - 4.0 * A * C;
  if (C > 0.0) {
    // THE FOCUS LIES OUTSIDE THE CIRCLE (C = |c - f|^2 - r^2 > 0): SVG 2's cone, touched by the focal
    // point and the end circle, transparent outside it. On the circle interpolated from the focus
    // (radius 0) to the end circle (radius r), a point lies at the parameters t solving
    // C t^2 - B t + A = 0, and SVG 2 takes the LARGEST with a non-negative radius -- the larger root,
    // (B/2 + sqrt(disc)/2) / C. The inside-focus form below yields the SMALLER one here, which painted
    // a third of a 256 px test square with the wrong colors.
    // Outside the cone (disc < 0) the edge's double root stands in, for the caller's edge AA.
    cone = true;
    float tc = (0.5 * B + 0.5 * sqrt(max(disc, 0.0))) / C;
    if (!(tc >= 0.0)) { ok = false; return 0.0; }
    return tc;
  }
  if (C == 0.0) {
    cone = true; disc = B;
    return B > 0.0 ? A / B : 0.0;
  }
  if (A == 0.0) return 0.0;
  if (disc < 0.0) { ok = false; return 0.0; }
  // 1 / tParam with tParam = (B + sqrt(disc)) / 2A, in one divide.
  return (2.0 * A) / (B + sqrt(disc));
}

// Compute paint color for a gradient at an em coord with a shape bbox. gid is 1-based. emDx and
// emDy are emCoord's screen derivatives, taken by the caller in UNIFORM control flow: this runs
// inside the pattern loop, per-shape branches and its own early return, where dFdx or fwidth
// would be undefined (a REPEAT gradient child of a pattern would paint nothing along its
// edges on the unified route).
vec4 sampleGradient(int gid, vec2 emCoord, vec4 shapeBB, vec2 emDx, vec2 emDy) {
  int row = gid - 1;
  vec4 g0 = texelFetch(uGradientTex, gradAt(GR_G0, row), 0);
  vec4 g1 = texelFetch(uGradientTex, gradAt(GR_G1, row), 0);
  vec4 g2 = texelFetch(uGradientTex, gradAt(GR_G2, row), 0);
  vec4 g3 = texelFetch(uGradientTex, gradAt(GR_G3, row), 0);
  int gType = int(g0.x + 0.5);
  int spread = int(g0.y + 0.5);
  float unitsFlag = g0.z;
  // Texel 2 (g2) slots zw carry (stopsOffset, stopsCount) — pointers
  // into uGradientStops. Replaces the per-gradient ramp atlas row.
  int stopsOffset = int(g2.z + 0.5);                    // TEXEL offset into uGradientStops
  // stopsCount is signed (negative = 1-texel opaque fast path) — round away
  // from zero so the magnitude survives for negatives.
  int stopsCount  = int(g2.w >= 0.0 ? g2.w + 0.5 : g2.w - 0.5);
  if ((gType == 0 && all(equal(g3.xy, g3.zw))) || (gType != 0 && g3.z == 0.0))
    return sampleStopsRaw(2.0, stopsOffset, stopsCount);
  vec2 gp = emCoord, gdx = emDx, gdy = emDy;
  if (unitsFlag > 0.5) {
    vec2 bboxMin = shapeBB.xy;
    // A zero extent (an axis-aligned line) is the only degenerate case: any positive extent is a real one at
    // any scale. A fixed floor such as 1e-6 compressed the gradient of art authored below ~2^-20 units.
    vec2 bboxSize = shapeBB.zw - bboxMin;
    bboxSize = vec2(bboxSize.x > 0.0 ? bboxSize.x : 1.0, bboxSize.y > 0.0 ? bboxSize.y : 1.0);
    gp = (emCoord - bboxMin) / bboxSize;
    gdx = emDx / bboxSize; gdy = emDy / bboxSize;
  }
  float ax = g1.x, ay = g1.y, bx = g1.z, by = g1.w;
  float ex = g2.x, ey = g2.y;
  vec2 gpos = vec2(ax * gp.x + bx * gp.y + ex,
                   ay * gp.x + by * gp.y + ey);
  bool ok, cone; float disc;
  float t = gradientT(gpos, gType, g0, g3, ok, cone, disc);
  if (!ok) return vec4(0);
  int mode = gradientSpreadToExtend(spread);
  // Radial t is nonnegative: the first period has no lower repeat seam.
  // Keep its real upper boundary and the cone coverage filter.
  // (A focal radius lets t go below 0, where REPEAT has its seams like anywhere else.)
  if (gType != 0 && mode == 1 && t < 0.5 && g0.y == floor(g0.y + 0.5)) mode = 0;
  // The neighboring pixels, read off through the linear part (which carries the derivative into
  // gradient space), serve two box filters: REPEAT's seam over the pixel's steps in UNWRAPPED t
  //, and a cone's EDGE, over the discriminant's steps -- it is linear across a pixel
  // there, so the covered fraction is the same trapezoid tail the seam uses. REFLECT has no seam.
  vec2 dt = vec2(0.0);
  float coneCov = 1.0;
  if (mode == 1 || cone) {
    bool okX, okY, cX, cY; float dX, dY;
    float tX = gradientT(gpos + vec2(ax * gdx.x + bx * gdx.y, ay * gdx.x + by * gdx.y), gType, g0, g3, okX, cX, dX);
    float tY = gradientT(gpos + vec2(ax * gdy.x + bx * gdy.y, ay * gdy.x + by * gdy.y), gType, g0, g3, okY, cY, dY);
    if (mode == 1) dt = vec2(okX ? tX - t : 0.0, okY ? tY - t : 0.0);
    if (cone) {
      float sa = abs(dX - disc), sb = abs(dY - disc);
      float SA = max(sa, sb), SB = min(sa, sb);
      coneCov = (SA > 0.0) ? stopsFootprintTail(disc + 0.5 * (SA + SB), SA, SB) : (disc >= 0.0 ? 1.0 : 0.0);
    }
  }
  if (coneCov <= 0.0) return vec4(0);
  vec4 c = sampleStops(t, stopsOffset, stopsCount, mode, dt);
  return vec4(c.rgb, c.a * coneCov);
}
#endif
