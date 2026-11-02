// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeVertexSetup.glsl — the analytic stroke's VERTEX stage, for the split-stroke pass.
//
// The twin of _strokeCoverage.glsl on the fragment side. Returns the band-quad corner in em
// space and leaves the em->clip projection to the includer.
//
// ONE band quad per outline segment; no separate join/cap primitives. uPrim holds the
// segments in the main renderer's format (below), and aPrimBase is a header's texel index.
// The stroke parameters are arguments rather than uniforms so the includer decides where they
// come from; splitStroke.vert, the one includer, passes its uniforms.
//
// Writes the flat stroke varyings the coverage reads; returns the em corner.
// Exact axis values avoid ANGLE/Metal's sign reversal for atan(y, -0.0).
// No epsilon: every nonzero x keeps the driver's existing angle and branch cut.
float curveAtan2(float y, float x) {
  return x == 0.0 ? sign(y) * 1.5707963267948966 : atan(y, x);
}

vec4 strokeFtx(int i) { return texelFetch(uPrim, ivec2(i % uPrimW, i / uPrimW), 0); }
// A unit vector, over the larger component first so no square under- or overflows; zero stays zero. (No absolute
// em floor such as v / max(length(v), 1e-9).)
vec2 strokeNrm(vec2 v) { float m = max(abs(v.x), abs(v.y)); if (!(m > 0.0)) return v; vec2 u = v / m; return u / length(u); }

/// The smallest stretch the em -> device-pixel map applies at the em point `p`, in units of the fit's own px per em
/// (1 with no world matrix): sigma_min of C = D J A, with A the em -> plane map (isotropic, y flipped), J the world
/// matrix's derivative there (its linear part over w, less the projective row's share; the whole matrix is constant for
/// an affine one) and D the NDC -> pixel scale (vp / 2 on each axis, so the matrix acts in a plane whose x and y pixels
/// differ by the viewport's aspect). Normalized by its largest entry first, so a scale of 1e-20 or 1e20 neither
/// underflows nor overflows; singular, it is 0.
float strokeWorldStretch(vec2 p, mat3 W, vec4 bb, vec2 ar, vec2 vp) {
  vec2 pl = ((p - bb.xy) / bb.zw * 2.0 - 1.0) * ar;
  vec3 h = W * vec3(pl.x, -pl.y, 1.0);
  vec2 n = h.xy / h.z;
  vec2 c0 = (W[0].xy - n * W[0].z) / h.z, c1 = (W[1].xy - n * W[1].z) / h.z;
  float a = vp.x / vp.y;
  vec4 g = vec4(c0.x, c0.y / a, -c1.x * a, -c1.y);          // C / (px per em): (C00, C10, C01, C11)
  float m = max(max(abs(g.x), abs(g.y)), max(abs(g.z), abs(g.w)));
  if (!(m > 0.0)) return 0.0;
  g /= m;
  float s = dot(g, g), det = g.x * g.w - g.z * g.y;
  float smax = sqrt(0.5 * (s + sqrt(max(s * s - 4.0 * det * det, 0.0))));   // >= 1/sqrt(2), the largest entry being 1
  return m * abs(det) / smax;
}

/// There are no aSegFlags, aContourStart or morph `t` inputs: the header carries the free-end flags,
/// the header carries startDist so no contour walk is needed, and there is no split-stroke morph route
/// to write a src/dst pose pair. A vertex is (primBase, corner).
vec2 strokeVertexSetup(float aPrimBase, float aCorner,
                       float halfW, float miterLimit,
                       int capStyle, int joinStyle, int dashId,
                       vec4 globalBBox, vec2 canvasAR, vec2 viewportSize,
                       mat3 worldM, int hasWorldM) {
    //
  // encodeSeg's layout carries all of it and less besides: a header with the type, the free-end
  // flags and the exact startDist, then the control points in their NATIVE form, then a join texel
  // holding inTan/outTan directly — so the neighbor fetches go away too. Stride varies by type,
  // and aPrimBase is simply the header's texel index.
  int base = int(aPrimBase + 0.5);
  vec4 hdr = strokeFtx(base);
  int segTy = int(hdr.x + 0.5) & 3;                 // low bits; 2 and 3 are fill-only / subpath-start
  vec2 P0, P1, P2, P3;
  int joinOfs;
  if (segTy == 0) {                                 // LINE — one texel
    vec4 a = strokeFtx(base + 1);
    P0 = a.xy; P3 = a.zw;
    P1 = P0 + (P3 - P0) / 3.0;                      // elevate for the SHARED hull/quad math below;
    P2 = P0 + 2.0 * (P3 - P0) / 3.0;                // exact, and the frag re-derives the line form
    joinOfs = 2;
  } else if (segTy == 1) {
    vec4 a = strokeFtx(base + 1), b = strokeFtx(base + 2);
    P0 = a.xy; P1 = a.zw; P2 = a.zw; P3 = b.xy;
    joinOfs = 3;
  } else if (segTy == 2) {                          // CUBIC
    vec4 a = strokeFtx(base + 1), b = strokeFtx(base + 2);
    P0 = a.xy; P1 = a.zw; P2 = b.xy; P3 = b.zw;
    joinOfs = 3;
  } else {                                          // ARC — stored as the ellipse it is
    // (cx, cy, rx, ry) and (th0, th1, phi). There is no hull to carry, so the four point slots
    // carry the PARAMETERS instead and the fragment reads them back by type. An arc is the one
    // kind that cannot be re-expressed as a cubic without error, which is why it is here at all.
    vec4 a = strokeFtx(base + 1), b = strokeFtx(base + 2);
    P0 = a.xy; P1 = a.zw; P2 = vec2(b.z, b.x); P3 = vec2(b.y, 0.0);
    joinOfs = 4;                                    // after the endpoints texel
  }
  vec4 jn = strokeFtx(base + joinOfs);
  vP0 = P0; vP1 = P1; vP2 = P2; vP3 = P3;
  STROKE_SET_TYPE(float(segTy));
  vHalfW = halfW; vMiterLimit = max(miterLimit, 1.0);
  // Written through macros the includer defines (splitStroke.vert: plain assignments).
  STROKE_SET_CAPJOIN(capStyle, joinStyle);
  STROKE_SET_FREE(hdr.y, hdr.z);
  STROKE_SET_DASH(dashId);
  vInTan = jn.xy; vOutTan = jn.zw;
  vStartDist = hdr.w;
    //
  // hdr.w IS the band walk's cumulative arc length, from the same GL-16 table, so no separate
  // mechanism is needed. Not verified against a dashed render: the one caller, incrementalStroke,
  // draws with uDashId 0, so no dash reaches this pass.

  // THE QUAD COVERS THE SEGMENT, AND NOT MUCH MORE. Every fragment of it runs the whole stroke solve,
  // and the ones off the stroke only discard. The hull's AXIS-ALIGNED box, dilated by the reach, would shade ~6,500 px
  // for the ~1,100 a 45-degree line 100 px long at half-width 2 px can reach, and an arc's box would be its whole
  // ellipse's whatever its sweep. So a line or a curve takes its hull's box in the frame of its CHORD (the hull's
  // points projected on the chord and its normal) -- the tightest box that frame gives, and still the hull's, so the
  // dilated box holds everything within the reach of the curve; and an arc takes the box of its endpoints and the axis
  // extremes its sweep passes, exact for the arc. The box is (ax, ay) about P0 over [lo, hi] (with ax, ay the x and y
  // axes for an arc); conservative either way, so a fragment it drops had nothing to draw.
  vec2 ax = vec2(1.0, 0.0), ay = vec2(0.0, 1.0), lo, hi;
  if (segTy == 3) {
    float cp = cos(P2.x), sp = sin(P2.x), th0 = P2.y, th1 = P3.x, dth = th1 - th0;
    if (abs(dth) >= 6.28318530717959) {
      // A FULL TURN IS THE whole ELLIPSE, and its box is the ellipse's: half-extents |(rx cp, ry sp)| and
      // |(rx sp, ry cp)|. The extremes below would take all four angles here, and with rx or ry 0 at phi a multiple of pi/2
      // one of them is atan(0, 0), which GLSL leaves undefined -- a NaN extreme, and min/max of a NaN is the driver's to
      // pick, so the quad could collapse. Each length is taken over the larger radius, so no square under- or overflows.
      float r = max(abs(P1.x), abs(P1.y)), rs = r > 0.0 ? 1.0 / r : 0.0;
      vec2 ext = r * vec2(length(vec2(P1.x * rs * cp, P1.y * rs * sp)), length(vec2(P1.x * rs * sp, P1.y * rs * cp)));
      lo = -ext; hi = ext;
    } else {
      vec2 e0 = P0 + vec2(P1.x * cp * cos(th0) - P1.y * sp * sin(th0), P1.x * sp * cos(th0) + P1.y * cp * sin(th0));
      vec2 e1 = P0 + vec2(P1.x * cp * cos(th1) - P1.y * sp * sin(th1), P1.x * sp * cos(th1) + P1.y * cp * sin(th1));
      vec2 mn = min(e0, e1), mx = max(e0, e1);
      // the four axis extremes: x'(th) = 0 at atan(-ry sp, rx cp) and half a turn on; y'(th) = 0 at atan(ry cp, rx sp).
      // A constant coordinate needs no extreme; curveAtan2 chooses zero for (0, 0),
      // a point on the ellipse, and gives exact quarter turns for either sign of a zero x.
      float tx = curveAtan2(-P1.y * sp, P1.x * cp), ty = curveAtan2(P1.y * cp, P1.x * sp);
      for (int k = 0; k < 4; k++) {
        float th = (k < 2 ? tx : ty) + (((k & 1) == 1) ? 3.14159265358979 : 0.0);
        // in the sweep: its angle from th0 in the sweep's own direction, within the sweep
        float d = mod(dth >= 0.0 ? th - th0 : th0 - th, 6.28318530717959);
        if (d <= abs(dth)) {
          vec2 e = P0 + vec2(P1.x * cp * cos(th) - P1.y * sp * sin(th), P1.x * sp * cos(th) + P1.y * cp * sin(th));
          mn = min(mn, e); mx = max(mx, e);
        }
      }
      lo = mn - P0; hi = mx - P0;
    }
  } else {
    // THE CHORD'S DIRECTION, taken over its larger component first: length(ch) squares it, and a chord
    // under ~1e-19 em would underflow (over ~1e19, overflow), leaving an ax that is not unit length -- the box shrinking by
    // its square, or collapsing to P0 at an infinite length.
    vec2 ch = P3 - P0;
    float cm = max(abs(ch.x), abs(ch.y));
    if (cm > 0.0) { vec2 chn = ch / cm; ax = chn / length(chn); ay = vec2(-ax.y, ax.x); }
    vec2 q1 = P1 - P0, q2 = P2 - P0, q3 = P3 - P0;
    vec2 u = vec2(dot(q1, ax), dot(q1, ay)), v = vec2(dot(q2, ax), dot(q2, ay)), w = vec2(dot(q3, ax), dot(q3, ay));
    lo = min(min(vec2(0.0), u), min(v, w)); hi = max(max(vec2(0.0), u), max(v, w));
  }
  float emPerPx = globalBBox.z / max(canvasAR.x * viewportSize.x, 1.0);
  // Band reach = the stroke half-width, PLUS (miter joins only) the ACTUAL per-join
  // miter extent — NOT the worst-case halfW*miterLimit. This mirrors the frag's
  // strokeCapsJoinsDash exactly: miterLen = halfW/sinHalf, used iff <= halfW*limit
  // (else the join bevels -> halfW). On a smooth curve (cosHalf~1) this collapses
  // to ~halfW instead of up to 8x halfW, so far fewer fragments are discarded.
  // Round/bevel joins and butt/round caps never exceed halfW. (+3px AA margin.)
  float reach = halfW;
  if (joinStyle == 0) {
    float worst = halfW * max(miterLimit, 1.0);
    vec2 dS = P1 - P0, dE = P3 - P2;
    if (segTy == 3) {
      // An arc's slots are its PARAMETERS, so P1 - P0 is radii minus center: its join directions
      // are its endpoint velocities, R(phi) (-rx sin th, ry cos th) signed by the sweep. Read as a
      // hull they would size the quad from an arbitrary angle, and a sharp miter at an arc would be
      // cut off past the ellipse box (incrementalStrokeArcMiterSmoke checks it).
      float cp = cos(P2.x), sp = sin(P2.x), sw = (P3.x < P2.y) ? -1.0 : 1.0;
      vec2 vs = sw * vec2(-P1.x * sin(P2.y), P1.y * cos(P2.y));
      vec2 ve = sw * vec2(-P1.x * sin(P3.x), P1.y * cos(P3.x));
      dS = vec2(cp * vs.x - sp * vs.y, sp * vs.x + cp * vs.y);
      dE = vec2(cp * ve.x - sp * ve.y, sp * ve.x + cp * ve.y);
    }
    // THE END DIRECTIONS ARE THE FRAGMENT STAGE'S, which builds the cap and join planes the reach must hold: a line's
    // chord; a quad's and a cubic's end handle, else the next handle, else the chord, each while it is over 1e-9 of the
    // control-point span (strokeQuadAccum, strokeCubicAccum; the encoder's segTangentAt); an arc's velocity, and a
    // zero-radius arc's chord (strokeArcAccum). None at all -- a point -- takes the conservative reach. This took the
    // end handle alone and called it no direction under an ABSOLUTE 1e-6 em: at 2^-20 every segment under
    // about a unit took the worst-case reach, and at 2^20 a handle a hair of its span, which the fragment replaces by the
    // chord, sized a sharp miter from its own direction -- 333 of 9,565 painted fragments fell outside the quad.
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
      if (!(length(dS) > dirMin)) dS = P2 - P1;         // (a quad's P1 == P2: on to the chord)
      if (!(length(dS) > dirMin)) dS = P3 - P0;
      if (!(length(dE) > dirMin)) dE = P2 - P1;
      if (!(length(dE) > dirMin)) dE = P3 - P0;
    }
    float mS = halfW, mE = halfW;
    if (vFreeStart < 0.5) {
      if (!(length(dS) > dirMin)) mS = worst;   // no start direction -> conservative
      else { float sh = 0.5 * length(strokeNrm(dS) + vInTan);   // sin(theta/2): half the distance between (-dS) and vInTan
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
  // THE MARGIN IS DEVICE PIXELS, UNDER THE WORLD MATRIX. The fragment's AA works in device pixels
  // (fwidth), and so does its hairline floor (halfWVis >= 0.5 px, _strokeCoverage.glsl); emPerPx is the em -> plane ->
  // viewport chain's alone, and uWorldM maps the plane after it. Under a zoom-out by s a 3 px em-chain margin would be 3s
  // device px, and the quad would clip the AA fringe: a hairline's at s <= ~0.4, any stroke's at s < 0.24. pxEm is the em size of a
  // device pixel along its longest direction, emPerPx over the map's least stretch; the fragment's pxSize,
  // 0.5 (fwidth.x + fwidth.y), is at most sqrt(2) pxEm, so what its coverage reaches past the geometric reach -- the
  // floor's 0.5 pxSize plus the ramp's 0.5 pxSize or the exact edge's gate at 0.75 -- is at most 1.77 pxEm, inside the
  // margin. Exact for an affine matrix, which has one stretch everywhere; a projective one takes the least over the
  // undilated box's four corners. With no world matrix pxEm IS emPerPx, so that draw is unchanged bit for bit.
  float pxEm = emPerPx;
  if (hasWorldM == 1) {
    float st = strokeWorldStretch(P0, worldM, globalBBox, canvasAR, viewportSize);
    if (worldM[0].z != 0.0 || worldM[1].z != 0.0) {
      st = min(st, strokeWorldStretch(P0 + ax * hi.x + ay * lo.y, worldM, globalBBox, canvasAR, viewportSize));
      st = min(st, strokeWorldStretch(P0 + ax * hi.x + ay * hi.y, worldM, globalBBox, canvasAR, viewportSize));
      st = min(st, strokeWorldStretch(P0 + ax * lo.x + ay * hi.y, worldM, globalBBox, canvasAR, viewportSize));
      st = min(st, strokeWorldStretch(P0 + ax * lo.x + ay * lo.y, worldM, globalBBox, canvasAR, viewportSize));
    }
    // A singular map draws the quad with no area whatever its size, so a zero stretch keeps the margin it had.
    if (st > 0.0) pxEm = emPerPx / st;
  }
  reach += 3.0 * pxEm;
  lo -= vec2(reach); hi += vec2(reach);
  int ci = int(aCorner + 0.5);
  vec2 k = (ci == 0) ? lo : (ci == 1) ? vec2(hi.x, lo.y) : (ci == 2) ? hi : vec2(lo.x, hi.y);
  return P0 + ax * k.x + ay * k.y;
}
