// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeCoverage.glsl — the analytic SDF stroke, as COVERAGE, for the split-stroke pass.
//
// This is NOT Loop-Blinn — LB is the FILL coverage (klmn/Bezout implicits). This
// is the exact analytic distance with caps/joins/dashes via strokeCubicAccum
// (_strokeMath.glsl, the same code the ubershader's Slug stroke uses).
//
// Spliced textually (@@STROKE_COVERAGE@@) into splitStroke.frag, so it reads the
// varyings directly rather than threading ~19 flat components through a signature.
// Its one caller is incrementalStroke, which MAX-unions every segment's coverage
// into a render target: adjacent segment quads overlap at every joint, and MAX is
// exact there at any alpha where OVER would double-blend.
//
// There is no bisector-ownership partition (which would let this coverage leave
// the render target) and no arcs-join curvature derivation: no caller needs either.
float strokeCoverage() {
  vec2 ePx = fwidth(vEm);
  // THE GUARD IS FOR A ZERO DERIVATIVE only, as mantle.frag.glsl's invPx is. A guard of 1e-6 -- an em length -- would make
  // art whose pixel is under 1e-6 em (0.1 of a unit wide at 2^-20, a few pixels to the unit) read its pixel as 1e-6: the
  // hairline floor below would take the stroke for sub-pixel and fade it (test/splitStrokeScaleSmoke.mjs).
  float pxSize = max(0.5 * (ePx.x + ePx.y), 1e-30);
  // Control points relative to the fragment. The join wedge
  // is decided by the tangents alone, as in _coverage.glsl's line branch.
  vec4 p12 = vec4(vP0 - vEm, vP1 - vEm);
  vec4 p34 = vec4(vP2 - vEm, vP3 - vEm);
  // No arcs join (4) reaches this pass: incrementalStroke offers miter, round and bevel, and it
  // writes no curvature texel. The accums read curv only for joinStyle 4.
  const vec4 curv = vec4(0.0);
  // The boundary normal, for the exact-area branch below, and the edge record.
  vec2 _mgrad;
  vec4 _eP, _eQ;
  // the free ends, with a closed dashed contour's seam resolved (_strokeMath.glsl): the varyings carry the header's raw fields
  bool fS = vFreeStart > 0.5, fE = vFreeEnd > 0.5;
  strokeSeamSet(vFreeStart, vFreeEnd);
  strokeSeamResolve(STROKE_DASH_ID, pxSize, fS, fE);

  float md;
  if (vSegType > 2.5) {
    // ARC — the four point varyings carry (center), (radii), (phi, th0), (th1, _). Query-relative
    // like every other kernel here: vEm is the fragment, vP0 the center.
    md = strokeArcAccum(vEm - vP0, vP1, vP2.x, vP2.y, vP3.x,
                        fS, fE, vCap, vCap,
                        vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                        STROKE_DASH_ID, vStartDist, curv, 1e20, _mgrad, 1e30, _eP, _eQ);
  } else if (vSegType < 0.5) {
    // A line solves as one: the clamped projection. Through strokeQuadAccum on a recovered
    // midpoint, rounding would leave the quadratic term slightly nonzero and quadClosestT would
    // take its degenerate branch -- a square root, two divides, extra candidates and a polish.
    // Every incrementalStroke polyline segment is a line. The same cap, join and dash handling
    // follows, fed exactly what the quad path feeds it.
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
  // AA falloff identical to mantle.frag's stroke (½px halfWVis floor + hairline fade).
  float halfWVis = max(vHalfW, 0.5 * pxSize);
  float weightFade = vHalfW / halfWVis;
  float dfe = md - halfWVis;
  // exact-AREA edge, same rule and same gate as mantle.frag's stroke: where the
  // boundary is a real offset line the ramp is replaced by the true
  // area(pixel box ∩ half-plane). The ramp is exact only for an AXIS-ALIGNED
  // edge; on the static path this cut stroke AA error 53% on lines, 64% on
  // curves and 50% on arcs.
  float cov;
  if (uStrokeExactAa != 0 && dot(_mgrad, _mgrad) > 0.5 && dfe <= 0.75 * pxSize) {
    vec2 nUn = _mgrad * ePx;
    float il = inversesqrt(max(dot(nUn, nUn), 1e-30));   // as mantle.frag's stroke edge
    cov = exactBoxCov(nUn * il, -dfe * il) * weightFade;
  } else {
    cov = (dfe <= 0.5 * pxSize) ? clamp(0.5 - dfe / pxSize, 0.0, 1.0) * weightFade : 0.0;
  }
  if (cov <= 0.0) discard;
  return cov;
}
