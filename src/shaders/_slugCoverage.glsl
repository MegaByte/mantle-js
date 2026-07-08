// _slugCoverage.glsl — Slug curve coverage + paint sampling helpers, shared
// (spliced via @@SLUG_COVERAGE@@) between mantle.frag and the maskBake shader.
//
// Requires the following uniforms to be declared by the including shader (these
// are bundle-wide and bound by the renderer):
//   uniform sampler2D uCurveData;     // Slug curve buffer (segments)
//   uniform sampler2D uBandData;      // Slug band buffer (per-band index lists)
//   uniform sampler2D uMetaTex;       // per-shape state plane
//   uniform sampler2D uDashTex;       // dash pattern table
//   uniform sampler2D uGradientTex;   // per-gradient parameter records
//   uniform sampler2D uGradientStops; // packed-stops LUT
//   uniform sampler2D uImageTex;      // image atlas
//   uniform vec2      uImageAtlasSize;
//   uniform sampler2D uFilterTex;
//   uniform vec4      uGlobalBBox;
// @@GRADIENT_HELPERS@@ must be substituted ABOVE this file.
//
// Public entry points:
//   - renderFill(c, px, GD, evenOdd, shapeBB) → float coverage
//   - sampleGradient(gid, emCoord, shapeBB)   → vec4 premult RGBA
//   - sampleChildImage(tileEm, imageRect, atlasSlot) → vec4
//   - sampleTopLevelImage(emPos, imageRect, atlasSlot) → vec4
//   - strokeMinDist(...) — stroke distance helper
//   - dashCovered(dashId, dist) → bool
int gradientSpreadToExtend(int spread) {
  // spread: 0=pad, 1=reflect, 2=repeat → mode: 0=pad, 1=repeat, 2=reflect
  if (spread == 1) return 2;
  if (spread == 2) return 1;
  return 0;
}

// Gradient paint sampler (sampleGradient).
@@PAINT_SAMPLE@@
// Sample a pattern child <image> at a pattern-local em-coord. The
// image-sample math: tileEm → uv via imageRect, then atlasSlot
// → atlas pixel. Returns straight-RGBA (caller premultiplies). Always
// clamp-samples (child images don't wrap inside a pattern — the parent
// pattern handles wrap). atlasSlot.w packs (kind | (pixelated<<2)).
// pixelated → emulate nearest-neighbor sampling regardless of the atlas
// texture's GL filter mode by snapping uv to texel centers.
#ifndef MANTLE_NO_IMAGE  // dropped by an image-free fill variant
vec4 sampleChildImage(vec2 tileEm, vec4 imageRect, vec4 atlasSlot) {
  float u = (tileEm.x - imageRect.x) / max(imageRect.z, 1e-6);
  float v = (tileEm.y - imageRect.y) / max(imageRect.w, 1e-6);
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0);
  float atlasU = (u * atlasSlot.y) / max(uImageAtlasSize.x, 1.0);
  float atlasV = (atlasSlot.x + v * atlasSlot.z) / max(uImageAtlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    // Pixelated: snap to texel center. Linearly-filtered samples between
    // texels would blur the source raster; nearest-neighbor preserves
    // the pixel boundaries that image-rendering:pixelated requests.
    atlasU = (floor(atlasU * uImageAtlasSize.x) + 0.5) / max(uImageAtlasSize.x, 1.0);
    atlasV = (floor(atlasV * uImageAtlasSize.y) + 0.5) / max(uImageAtlasSize.y, 1.0);
  }
  return texture(uImageTex, vec2(atlasU, atlasV));
}

// Top-level <image> sampler. atlasSlot.w & 3 selects the wrap mode:
//   0 = clamp (image): return alpha=0 outside [0,1]² (caller treats as
//       no contribution); the bbox quad covers the image rect exactly.
//   1 = wrap  (raster pattern): repeat the tile across the shape.
//   2 = vector-pattern sentinel (handled by caller, not here).
//   3 = mirror (Rive ImageSampler mirror wrap): reflect the tile
//       across each tile boundary so adjacent copies are mirror
//       images. Eliminates the seam-discontinuity that REPEAT shows
//       on tiles whose edge colors don't match.
// atlasSlot.w & 4 → pixelated; same snap-to-texel as sampleChildImage.
vec4 sampleTopLevelImage(vec2 emPos, vec4 imageRect, vec4 atlasSlot) {
  float u = (emPos.x - imageRect.x) / max(imageRect.z, 1e-6);
  float v = (emPos.y - imageRect.y) / max(imageRect.w, 1e-6);
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) {
    // Pattern wrap.
    u = fract(u); if (u < 0.0) u += 1.0;
    v = fract(v); if (v < 0.0) v += 1.0;
  } else if (kind == 3) {
    // Mirror wrap: triangle-wave on each axis so adjacent tiles flip.
    // tri(x) = abs(fract(x*0.5) - 0.5) * 2 produces 0..1..0..1 sawtooth
    // over period 2; equivalent to GL_MIRRORED_REPEAT.
    u = abs(fract(u * 0.5) - 0.5) * 2.0;
    v = abs(fract(v * 0.5) - 0.5) * 2.0;
  } else {
    // Image clamp — outside the rect, paint nothing.
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0);
  }
  float atlasU = (u * atlasSlot.y) / max(uImageAtlasSize.x, 1.0);
  float atlasV = (atlasSlot.x + v * atlasSlot.z) / max(uImageAtlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    atlasU = (floor(atlasU * uImageAtlasSize.x) + 0.5) / max(uImageAtlasSize.x, 1.0);
    atlasV = (floor(atlasV * uImageAtlasSize.y) + 0.5) / max(uImageAtlasSize.y, 1.0);
  }
  return texture(uImageTex, vec2(atlasU, atlasV));
}
#endif
#define SEG_LINE 0u
#define SEG_QUAD 1u
#define SEG_CUBIC 2u
#define SEG_ARC 3u

// Shared curve coeff/eval/arc-length (_curveArcLen.glsl) THEN the analytic
// stroke-distance math (_strokeMath.glsl). CURVE_ARCLEN must come first: the fill
// walk, strokeBandAccum, and strokeCubicAccum all use evalC.
@@CURVE_ARCLEN@@
@@STROKE_MATH@@

// Curve-data fetch with row wrap. Segment data texels are addressed as
// sL.x + {1,2} off the band-stored header coord; when the curve buffer
// exceeds the 4096-texel row width those offsets must carry into the next
// row exactly like bLoc does for the band buffer. Without this, a segment
// whose texels straddle a 4096 column boundary reads garbage. In-bounds
// coords are unchanged (x>>12 == 0).
vec4 texFetch(ivec2 xy) { xy.y += xy.x >> 12; xy.x &= 4095; return texelFetch(uCurveData, xy, 0); }
vec4 bFetch(ivec2 xy) { return texelFetch(uBandData, xy, 0); }
ivec2 bLoc(ivec2 gl, int off) { ivec2 l=ivec2(gl.x+off, gl.y); l.y+=l.x>>12; l.x&=4095; return l; }

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
bool arcInRange(float t, float tS, float tE) {
  if (abs(tE - tS) >= TWO_PI) return true;
  float dur = tE - tS;
  float d = hlslFmod(t - tS, TWO_PI);
  if (d < 0.0) d += TWO_PI;
  if (dur > 0.0) return d < dur;
  if (d > 0.0) d -= TWO_PI;
  return d > dur;
}

// GL-16 arc length of an elliptical arc over [0,t] of its sweep. d1=(cx,cy,
// rx,ry), d2=(th0,th1,phi). |dp/dθ| = √(rx²sin²θ+ry²cos²θ) (rotation by phi
// preserves length); same nodes/weights/integrand as the encoder and the hit
// test, so dashed native arcs (circles/ellipses) phase continuously.
float arcArcLen(vec4 d1, vec4 d2, float t) {
  float dth = d2.y - d2.x;
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float th = d2.x + dth * (t * SLUG_GL16_N[i]);
    float st = sin(th), ct = cos(th);
    sum += SLUG_GL16_W[i] * sqrt(d1.z * d1.z * st * st + d1.w * d1.w * ct * ct);
  }
  return t * abs(dth) * sum;
}

// Walk one H-band's segment list, accumulating min distance from
// renderCoord across line/quad/cubic/arc sub-loops.
float strokeBandAccum(ivec2 gl, int hdrSlot,
                          vec2 c, float halfW,
                          int startCap, int endCap,
                          int joinStyle, float miterLimit,
                          int dashId, float minDIn) {
  vec4 cnts = bFetch(bLoc(gl, hdrSlot));
  int nLine  = int(cnts.x);
  int nQuad  = int(cnts.y);
  int nCubic = int(cnts.z);
  int nArc   = int(cnts.w);
  int arrIdx = int(bFetch(bLoc(gl, hdrSlot + 1)).x);
  int hOff = 0;
  float minD = minDIn;

  // ---- LINES ----
  //
  // Body envelope for a line seg = pixels within halfW perpendicular
  // distance of the seg, within its [0, length] body extent. Past
  // either endpoint the coverage depends on cap / join style:
  //
  //   freeStart/freeEnd (no neighbour):
  //     cap == 0 BUTT   : drop. Coverage ends at endpoint perpendicular.
  //     cap == 1 ROUND  : radial distance from endpoint (= length(c-a)).
  //     cap == 2 SQUARE : perpendicular distance to extended-tangent line,
  //                       gated by along ∈ [0, halfW].
  //
  //   Interior (joined to a neighbour):
  //     joinStyle == 0 MITER : perpendicular distance to extended-tangent
  //                           line, gated by along ∈ [0, miterLen] AND
  //                           by being on the OUTER side of the bend.
  //                           cosHalf = sqrt(0.5*(1+dot(-segTan, inTan)))
  //                           determines miterLen = halfW/cosHalf; fall
  //                           through to round if miterLen > miterLimit.
  //     joinStyle == 1 ROUND : radial distance from endpoint.
  //     joinStyle == 2 BEVEL : same as round (covers the inner overlap +
  //                            bevel triangle naturally; explicit bevel
  //                            geometry not needed for per-pixel coverage).
  //
  // Body extension into the join region: at an interior endpoint, the
  // body envelope continues PERPENDICULARLY past the seg into the
  // half-plane bounded by the OTHER seg's perpendicular. Without this
  // the inner-bend has a circular gap (round distance from endpoint)
  // even at sharp polyline corners. The gate
  // `dot(c - vertex, inTan/-outTan) >= 0` keeps us in our seg's
  // territory and lets the joining seg cover the other half-plane.
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue; // fill-only synthetic close
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 pts = texFetch(dL);
    // Join tangents at sL+2: (inTan.x, inTan.y, outTan.x, outTan.y).
    // Zero vectors when this end is a free cap (no neighbour).
    vec4 jn = texFetch(ivec2(dL.x + 1, dL.y));
    vec2 inTan  = jn.xy;
    vec2 outTan = jn.zw;
    vec2 a = pts.xy;
    vec2 b = pts.zw;
    vec2 ab = b - a;
    float abLen2 = max(dot(ab, ab), 1e-20);
    float abLen = sqrt(abLen2);
    float tRaw = dot(c - a, ab) / abLen2;
    vec2 segTan = ab / abLen;
    bool drop = false;
    // `thisD` is the distance this seg contributes for pixel `c`. It
    // starts as the closest-point distance for pixels inside the body
    // extent and is overridden by the cap / miter / body-extension
    // logic below for pixels past either endpoint. -1 means "compute
    // closest-point distance later".
    float thisD = -1.0;
    if (tRaw < 0.0) {
      if (freeStart) {
        if (startCap == 0) drop = true;
        else if (startCap == 2) {
          // Square cap: extend by halfW along -segTan. Drop outside
          // the [0, halfW] cap zone; perpendicular distance inside.
          float along = dot(c - a, -segTan);
          if (along < 0.0 || along > halfW) drop = true;
          else thisD = length((c - a) + segTan * along);
        }
        // startCap == 1 (round): leave thisD = -1; closest-point
        // fallback below gives length(c - a), the round-cap distance.
      } else {
        // Interior start vertex. Body continues PERPENDICULARLY into
        // our seg's half of the join (gated by dot(c-a, inTan) >= 0
        // — past the incoming seg's perpendicular at the vertex).
        // The miter-wedge constraint requires the pixel to be within
        // halfW of BOTH this seg's tangent line AND the joining seg's
        // tangent line; the second check bounds the wedge at the
        // miter tip (otherwise body extension sticks out past the
        // miter point as a rectangular spur).
        bool ourTerritory = dot(c - a, inTan) >= 0.0;
        if (ourTerritory && joinStyle == 2) {
          // EXACT BEVEL: clip the radial round corner to the bevel chord — the
          // line joining the two segments' outer offsets (hw·nA, hw·nB) — as an AA
          // distance (coverage crosses 0.5 at the chord). tA=inTan, tB=segTan.
          float cr = inTan.x * segTan.y - inTan.y * segTan.x;
          float sd = (cr >= 0.0) ? 1.0 : -1.0;
          vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(segTan.y, -segTan.x);
          vec2 nb = nA + nB; float bl = length(nb);
          if (bl > 1e-4) { vec2 bis = nb / bl;
            thisD = max(length(c - a), halfW + dot(c - a, bis) - halfW * dot(nA, bis)); }
        }
        if (ourTerritory) {
          float along = dot(c - a, -segTan);
          float capAlong = 0.0;
          // Straight edges have zero curvature, so an arcs join (4) on line
          // segments reduces to a miter (extend the edges until they meet).
          if (joinStyle == 0 || joinStyle == 4) {
            float cosBetween = dot(-segTan, inTan);
            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 1e-9));
            float miterLen = halfW / max(cosHalf, 1e-6);
            if (miterLen <= halfW * miterLimit) capAlong = miterLen;
          }
          if (along <= capAlong) {
            float perpThis = length((c - a) + segTan * along);
            // Perpendicular distance to the OTHER (incoming) seg's
            // tangent line at the vertex. The line passes through a
            // (the join vertex) with direction inTan; the normal is
            // perp(inTan) = (-inTan.y, inTan.x).
            vec2 nIn = vec2(-inTan.y, inTan.x);
            float perpOther = abs(dot(c - a, nIn));
            // Use the LARGER of the two perpendiculars so the pixel
            // is in the wedge iff both ≤ halfW (AA falloff compares minD
            // against halfW).
            thisD = max(perpThis, perpOther);
          }
        }
      }
    }
    if (tRaw > 1.0) {
      if (freeEnd) {
        if (endCap == 0) drop = true;
        else if (endCap == 2) {
          float along = dot(c - b, segTan);
          if (along < 0.0 || along > halfW) drop = true;
          else thisD = length((c - b) - segTan * along);
        }
      } else {
        bool ourTerritory = dot(c - b, -outTan) >= 0.0;
        if (ourTerritory && joinStyle == 2) {
          // EXACT BEVEL (see the start-vertex twin above). tA=segTan, tB=outTan.
          float cr = segTan.x * outTan.y - segTan.y * outTan.x;
          float sd = (cr >= 0.0) ? 1.0 : -1.0;
          vec2 nA = sd * vec2(segTan.y, -segTan.x), nB = sd * vec2(outTan.y, -outTan.x);
          vec2 nb = nA + nB; float bl = length(nb);
          if (bl > 1e-4) { vec2 bis = nb / bl;
            thisD = max(length(c - b), halfW + dot(c - b, bis) - halfW * dot(nA, bis)); }
        }
        if (ourTerritory) {
          float along = dot(c - b, segTan);
          float capAlong = 0.0;
          // Arcs join (4) on straight edges reduces to a miter (see start twin).
          if (joinStyle == 0 || joinStyle == 4) {
            float cosBetween = dot(segTan, -outTan);
            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 1e-9));
            float miterLen = halfW / max(cosHalf, 1e-6);
            if (miterLen <= halfW * miterLimit) capAlong = miterLen;
          }
          if (along <= capAlong) {
            float perpThis = length((c - b) - segTan * along);
            vec2 nOut = vec2(-outTan.y, outTan.x);
            float perpOther = abs(dot(c - b, nOut));
            thisD = max(perpThis, perpOther);
          }
        }
      }
    }
    if (drop) continue;
    float tC = clamp(tRaw, 0.0, 1.0);
    if (dashId > 0) {
      float pathDist = hdr.w + tC * abLen;
      if (!dashCovered(dashId, pathDist)) continue;
    }
    if (thisD < 0.0) {
      vec2 closestPt = mix(a, b, tC);
      thisD = length(c - closestPt);
    }
    minD = min(minD, thisD);
  }
  hOff += nLine;

  // ---- QUADS (native — not degree-elevated) ----
  for (int i = 0; i < 1024; i++) {
    if (i >= nQuad) break;
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 p12 = texFetch(dL) - vec4(c, c);
    vec4 q3t = texFetch(ivec2(dL.x + 1, dL.y));
    vec2 q3  = q3t.xy - c;
    vec2 joinReach = q3t.zw;  // (startPrevReach, endNextReach)
    vec4 jn = texFetch(ivec2(dL.x + 2, dL.y));
    // Arcs-join curvature texel follows the join texel (only emitted for
    // stroke-linejoin:arcs). (kSelfStart, kSelfEnd, kPrevEnd, kNextStart).
    vec4 curv = (joinStyle == 4) ? texFetch(ivec2(dL.x + 3, dL.y)) : vec4(0.0);
    minD = strokeQuadAccum(p12, q3, freeStart, freeEnd,
                           startCap, endCap,
                           joinStyle, miterLimit, halfW,
                           jn.xy, jn.zw, dashId, hdr.w,
                           joinReach.x, joinReach.y, curv, minD);
  }
  hOff += nQuad;

  // ---- CUBICS ----
  for (int i = 0; i < 1024; i++) {
    if (i >= nCubic) break;
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 p12 = texFetch(dL) - vec4(c, c);
    vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
    vec4 jn = texFetch(ivec2(dL.x + 2, dL.y));
    vec4 curv = (joinStyle == 4) ? texFetch(ivec2(dL.x + 3, dL.y)) : vec4(0.0);
    minD = strokeCubicAccum(p12, p34, freeStart, freeEnd,
                                startCap, endCap,
                                joinStyle, miterLimit, halfW,
                                jn.xy, jn.zw, dashId, hdr.w,
                                1e9, 1e9, curv, minD);
  }
  hOff += nCubic;

  // ---- ARCS ----
  for (int i = 0; i < 1024; i++) {
    if (i >= nArc) break;
    vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
    if (segRaw.z - c.x < -halfW) break;
    ivec2 sL = ivec2(segRaw.xy);
    vec4 hdr = texFetch(sL);
    if (uint(hdr.x) >= 4u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 d1 = texFetch(dL);
    vec4 d2 = texFetch(ivec2(dL.x + 1, dL.y));
    vec4 jn = texFetch(ivec2(dL.x + 2, dL.y));   // join texel (inTan, outTan)
    vec4 curv = (joinStyle == 4) ? texFetch(ivec2(dL.x + 3, dL.y)) : vec4(0.0);
    // Inline arc closest-distance.
    vec2 pc = c - d1.xy;
    float cphi = cos(d2.z), sphi = sin(d2.z);
    vec2 pR = vec2(pc.x*cphi + pc.y*sphi, -pc.x*sphi + pc.y*cphi);
    vec2 ep0 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.x);
    vec2 ep1 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.y);
    float dE = min(length(c - ep0), length(c - ep1));
    float f = dot(pR / d1.zw, pR / d1.zw) - 1.0;
    vec2 g = 2.0 * pR / (d1.zw * d1.zw);
    float dEdge = abs(f) / (length(g) + 1e-9);
    float tAng = atan(pR.y / d1.w, pR.x / d1.z);
    bool inRange = arcInRange(tAng, d2.x, d2.y);
    float arcD = inRange ? min(dEdge, dE) : dE;
    // Endpoint velocities (dθ-scaled, matching segTangentAt) + the closest-point
    // parameter t∈[0,1] — interior foot when in range, else the nearer endpoint.
    // Route through the shared cap/join/dash helper so arc segments get real
    // caps + joins (butt/square, miter/round/bevel/arcs) like line/quad/cubic.
    // A closed arc's seam is a self-join (see the encoder's self-loop handling),
    // so no butt cap notches it.
    float dth = d2.y - d2.x;
    vec2 dStart = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.x), arcDyDtheta(d1.z, d1.w, d2.z, d2.x)) * dth;
    vec2 dEnd   = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.y), arcDyDtheta(d1.z, d1.w, d2.z, d2.y)) * dth;
    float tArc;
    if (inRange && dEdge <= dE) {
      float dd = hlslFmod(tAng - d2.x, TWO_PI);
      if (dd < 0.0) dd += TWO_PI;
      if (dth < 0.0 && dd > 0.0) dd -= TWO_PI;
      tArc = clamp(dd / dth, 0.0, 1.0);
    } else {
      tArc = (length(c - ep0) <= length(c - ep1)) ? 0.0 : 1.0;
    }
    float arcLenAtT = (dashId > 0) ? arcArcLen(d1, d2, tArc) : 0.0;
    minD = strokeCapsJoinsDash(tArc, arcD, ep0 - c, ep1 - c, dStart, dEnd,
                               freeStart, freeEnd, startCap, endCap,
                               joinStyle, miterLimit, halfW, jn.xy, jn.zw,
                               1e9, 1e9, dashId, hdr.w, arcLenAtT, curv, minD);
  }

  return minD;
}

// Public stroke entry point. Walks the H-band that contains renderCoord
// (the encoder dilates band membership by halfW so near-horizontal segs at
// boundaries are reachable from H alone — no V walk needed).
float strokeMinDist(vec2 c, ivec4 GD, vec4 shapeBB, float halfW,
                        int startCap, int endCap,
                        int joinStyle, float miterLimit,
                        int dashId) {
  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  int hdr = bandIdx.y * 2;
  return strokeBandAccum(gl, hdr, c, halfW,
                             startCap, endCap,
                             joinStyle, miterLimit, dashId, 1e20);
}

// ==== Slug quadratic root eligibility + solvers ====
//
// calcRootCode2: 0x2E74 magic-table sign-pattern lookup. Returns a
// 2-bit code: bit 0 = root 1 valid, bit 1 = root 2 valid. Robust at
// cusps because eligibility depends only on the topology of y-sign
// crossings, not on a fragile FP `t < 1.0` boundary check.
uint calcRootCode2(float y1, float y2, float y3) {
  uint shift = (y1 < 0.0 ? 1u : 0u)
             | (y2 < 0.0 ? 2u : 0u)
             | (y3 < 0.0 ? 4u : 0u);
  return ((0x2E74u >> shift) & 0x0101u);
}

// Solvers return (r1, r2, t1, t2). r is the ray-axis intercept at
// the corresponding t. Caller multiplies r by pxPerEm and applies
// the sign convention (root1 → +saturate for H, -saturate for V;
// root2 reversed).
vec4 slugSolveHorizQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.y;
  float rb = 0.5 / b.y;
  float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  float t1 = (b.y - d) * ra;
  float t2 = (b.y + d) * ra;
  if (abs(a.y) < 1.0/65536.0) { t1 = p12.y * rb; t2 = t1; }
  return vec4((a.x * t1 - b.x * 2.0) * t1 + p12.x,
              (a.x * t2 - b.x * 2.0) * t2 + p12.x,
              t1, t2);
}

vec4 slugSolveVertQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.x;
  float rb = 0.5 / b.x;
  float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  float t1 = (b.x - d) * ra;
  float t2 = (b.x + d) * ra;
  if (abs(a.x) < 1.0/65536.0) { t1 = p12.x * rb; t2 = t1; }
  return vec4((a.y * t1 - b.y * 2.0) * t1 + p12.y,
              (a.y * t2 - b.y * 2.0) * t2 + p12.y,
              t1, t2);
}

vec4 solveDep(float p, float q) {
  float d=q*q*0.25+p*p*p/27.0;
  if(d>1e-12){ float sd=sqrt(d); return vec4(sign(-q*0.5+sd)*pow(abs(-q*0.5+sd),1.0/3.0)+sign(-q*0.5-sd)*pow(abs(-q*0.5-sd),1.0/3.0),1e20,1e20,1.0); }
  if(d<-1e-12){ float m=2.0*sqrt(-p/3.0), th=acos(clamp(3.0*q/(p*m),-1.0,1.0))/3.0; return vec4(m*cos(th), m*cos(th-radians(120.0)), m*cos(th-radians(240.0)), 3.0); }
  float u=sign(-q*0.5)*pow(abs(-q*0.5),1.0/3.0); return vec4(2.0*u, -u, 1e20, 2.0);
}
// Cubic root finder following Yuksel 2022, "High-Performance Polynomial
// Root Finding for Graphics". More accurate AND faster than Cardano:
//
//   1. Split [0,1] at the cubic's critical points (zeros of the derivative,
//      a quadratic — fast, stable analytical solve).
//   2. For each monotonic sub-interval, sign-test endpoints. If signs
//      differ, exactly one root exists in the interval.
//   3. Find that root via INTERVAL-CLAMPED Newton iterations:
//        x_new = clamp(x - f(x)/f'(x), x_min, x_max)
//      Newton has quadratic convergence (~halves remaining bits each
//      iteration) but is unstable near critical points; clamping to the
//      interval guarantees convergence in ~4-8 iterations to ~1e-7.
//   4. Special case: if interval contains both critical points (only
//      possible for the middle one when 2 critical points exist), split
//      at the midpoint to avoid an infinite oscillation across the
//      inflection point.
//
// Reference: Cem Yuksel, "High-Performance Polynomial Root Finding for
// Graphics", PACMCGIT 5(3), 2022. https://doi.org/10.1145/3543865
void solveCubicBisect(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t) {
  r = vec3(1e20); t = vec3(-1.0);
  vec4 cy = cubicCoeff(vert?p12.x:p12.y, vert?p12.z:p12.w, vert?p34.x:p34.y, vert?p34.z:p34.w);
  vec4 cx = cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);

  // Critical points of Cy: 3A·t² + 2B·t + C = 0
  float qa = 3.0 * cy.x;
  float qb = 2.0 * cy.y;
  float qc = cy.z;
  float split1 = -1.0, split2 = -1.0;
  if (abs(qa) < 1.0/65536.0) {
    if (abs(qb) > 1.0/65536.0) {
      float s = -qc / qb;
      if (s > 0.0 && s < 1.0) split1 = s;
    }
  } else {
    float disc = qb*qb - 4.0*qa*qc;
    if (disc >= 0.0) {
      float sd = sqrt(disc);
      float s1 = (-qb - sd) / (2.0*qa);
      float s2 = (-qb + sd) / (2.0*qa);
      if (s1 > s2) { float tmp = s1; s1 = s2; s2 = tmp; }
      if (s1 > 0.0 && s1 < 1.0) split1 = s1;
      if (s2 > 0.0 && s2 < 1.0) {
        if (split1 < 0.0) split1 = s2; else split2 = s2;
      }
    }
  }

  float bds[4];
  bds[0] = 0.0;
  int nb = 1;
  if (split1 > 0.0) { bds[nb] = split1; nb++; }
  if (split2 > 0.0) { bds[nb] = split2; nb++; }
  bds[nb] = 1.0; nb++;

  // Sign convention: > 0 (strictly positive). yLo=0 → "negative" side
  // (so sLo != sHi when yLo=0 and yHi>0 → crossing reported at t=lo).
  // This includes segment-start crossings (t=0 endpoint on ray) while
  // the per-segment t-range filter [0, 1) at the call site excludes
  // segment-end crossings (avoids double-counting shared vertices).
  //
  // Apex-on-ray correction:
  // when a contour has a shared vertex exactly on the ray (e.g. a
  // 4-cubic ellipse with apex at x=cx joining seg[i] and seg[i+1]),
  // the leaving segment (seg[i+1]) has yLo=0 with yHi on the OPPOSITE
  // side from the entering segment's yLo. Under `> 0` the leaving
  // segment with yHi<0 mis-classifies yLo=0 as "negative" (same side
  // as yHi) → no fire; the entering segment fires at t≈1 but is
  // excluded by the t-range filter [0,1). Net: zero crossings at that
  // apex when the contour actually crosses → parity flip in the
  // band above/below the apex column.
  //
  // Fix: when yLo (resp. yHi) is exactly on the ray (within epsilon),
  // classify it as the OPPOSITE side of its sub-interval neighbour.
  // This guarantees a transition is detected at the apex endpoint,
  // and the t≈0 fire from the leaving segment is the one the t-range
  // filter accepts. Tangent-at-endpoint cases (where two adjacent
  // segments are on the SAME side, just touching the ray) are not
  // exercised by this fix because the sub-interval's other endpoint
  // is then ALSO same-side (sLo == sHi via the OPPOSITE rule still
  // detects no crossing).
  int slot = 0;
  for (int i = 0; i < 3; i++) {
    if (i + 1 >= nb) break;
    float lo = bds[i], hi = bds[i + 1];
    float yLo = evalC(cy, lo);
    float yHi = evalC(cy, hi);
    bool sLo = yLo > 0.0;
    bool sHi = yHi > 0.0;
    // Apex-on-ray: classify exactly-zero endpoint as the opposite
    // side of its sub-interval neighbour. Epsilon ≈ scale of typical
    // float-eval roundoff for a unit cubic.
    const float EPS = 1e-6;
    if (abs(yLo) < EPS && abs(yHi) >= EPS) sLo = !sHi;
    else if (abs(yHi) < EPS && abs(yLo) >= EPS) sHi = !sLo;
    if (sLo == sHi) continue;
    // Clamped Newton: 8 iterations gives quadratic convergence to ~1e-7
    // even from the worst starting points, with the clamp guaranteeing
    // bounded behavior near critical points. Keep 8 here — 3 leaves
    // multi-pixel error on well-conditioned crossings. The stroke
    // closest-point solvers use 3 because they start from a coarse seed.
    float xr = 0.5 * (lo + hi);
    for (int k = 0; k < 8; k++) {
      float fy = evalC(cy, xr);
      float fdy = evalCD(cy, xr);
      if (abs(fdy) < 1e-12) break;
      float xn = xr - fy / fdy;
      xr = clamp(xn, lo, hi);
    }
    if (slot < 3) {
      t[slot] = xr;
      r[slot] = evalC(cx, xr);
      slot++;
    }
  }
}

void solveCubic(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t) {
  r=vec3(1e20); t=vec3(-1.0);
  vec4 cy=cubicCoeff(vert?p12.x:p12.y, vert?p12.z:p12.w, vert?p34.x:p34.y, vert?p34.z:p34.w);
  if(abs(cy.x)<(1.0/65536.0)){
    float qa=cy.y, qb=cy.z, qc=cy.w;
    float disc = qb*qb - 4.0*qa*qc;
    vec4 cx=cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);
    if(abs(qa)<(1.0/65536.0)){
      if(abs(qb)<(1.0/65536.0)) return;
      float tt = -qc/qb;
      if(tt>=0.0 && tt<=1.0){ t[0]=tt; r[0]=evalC(cx,tt); }
      return;
    }
    if(disc<0.0) return;
    float det=sqrt(disc);
    float t1=(-qb-det)/(2.0*qa), t2=(-qb+det)/(2.0*qa);
    if(t1>=0.0 && t1<=1.0){ t[0]=t1; r[0]=evalC(cx,t1); }
    if(t2>=0.0 && t2<=1.0 && abs(t2-t1)>1e-6){ t[1]=t2; r[1]=evalC(cx,t2); }
    return;
  }
  float invA=1.0/cy.x, b=cy.y*invA, c=cy.z*invA, d=cy.w*invA;
  float pp=c-b*b/3.0, qq=2.0*b*b*b/27.0-b*c/3.0+d, off=b/3.0;
  vec4 sol=solveDep(pp,qq);
  vec4 cx=cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);

  // Cubic root-eligibility lookup table — 16 sign patterns × 3 root
  // slots, derived by enumerating each y-control-point sign pattern
  // and its possible real-root counts via the Variation Diminishing
  // Property of Bernstein-basis polynomials. This is the cubic
  // equivalent of Slug's quadratic 0x2E74 table; it eliminates the
  // disc≈0 epsilon-sensitivity of bare Cardano by replacing
  // continuous tolerances with discrete sign tests.
  //
  // idx = (y1>0) | (y2>0)<<1 | (y3>0)<<2 | (y4>0)<<3
  // Bit i of T1/T2/T3 = "is t_{1/2/3} a real root in [0,1] for sign idx i".
  // T1 = 0x7FFE  : t1 fires for any pattern with ≥1 sign change
  // T2 = 0x2E74  : t2 fires for sign patterns with ≥2 sign changes
  // T3 = 0x0420  : t3 fires only for the 3-sign-change patterns (5, 10)
  int idx = 0;
  if ((vert ? p12.x : p12.y) > 0.0) idx |= 1;
  if ((vert ? p12.z : p12.w) > 0.0) idx |= 2;
  if ((vert ? p34.x : p34.y) > 0.0) idx |= 4;
  if ((vert ? p34.z : p34.w) > 0.0) idx |= 8;
  int t1Hit = (0x7FFE >> idx) & 1;
  int t2Hit = (0x2E74 >> idx) & 1;
  int t3Hit = (0x0420 >> idx) & 1;

  // Sort Cardano's roots in ascending t-order (after offset removal).
  float ts[3];
  ts[0] = sol[0] - off;
  ts[1] = sol[1] - off;
  ts[2] = sol[2] - off;
  if (ts[1] < ts[0]) { float tmp = ts[0]; ts[0] = ts[1]; ts[1] = tmp; }
  if (ts[2] < ts[1]) { float tmp = ts[1]; ts[1] = ts[2]; ts[2] = tmp; }
  if (ts[1] < ts[0]) { float tmp = ts[0]; ts[0] = ts[1]; ts[1] = tmp; }

  // Map sorted Cardano roots → table slots [t1, t2, t3]. Slots whose
  // table bit is 0 stay at 1e20 (filtered out by the consumer).
  int slot = 0;
  for (int i = 0; i < 3; i++) {
    if (i >= int(sol.w)) break;
    float tt = ts[i];
    if (tt < 0.0 || tt > 1.0) continue;
    // Dedupe near-coincident roots.
    if (slot > 0 && abs(tt - t[slot-1]) < 1e-5) continue;
    int hit = (slot == 0) ? t1Hit : ((slot == 1) ? t2Hit : t3Hit);
    if (hit != 0) {
      t[slot] = tt;
      r[slot] = evalC(cx, tt);
    }
    slot++;
  }
}

vec4 fillLinear(vec2 c, vec2 px, ivec4 GD, vec4 shapeBB) {
  // Per-type
  // sub-loops (lines, quads, cubics, arcs) with breakAxis early-out.
  // Band layout (wide-only):
  //   per band: 2 adjacent texels.
  //     texel 0 = (nLine, nQuad, nCubic, nArc) plain floats
  //     texel 1 = (arrIdx, 0, 0, 0) — segment-list start offset
  //   bandsY H bands at slots [0 .. bandsY*2); bandsX V bands at
  //   slots [bandsY*2 .. (bandsY+bandsX)*2).
  // Per-segment band entry .xyzw:
  //     .xy = curveData segment header texel coords
  //     .z  = breakAxis (segCtrlBb.xMax for H bands, .yMax for V bands).
  //           Sorted descending → walker can break out as soon as
  //           (breakAxis - rayPos) * pxPerEm < -0.5.
  //     .w  = unused
  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  float xcov = 0.0, ycov = 0.0, xwgt = 0.0, ywgt = 0.0;

  // ============================================================
  // H-walker (horizontal ray cast). Integrates xcov / xwgt.
  // ============================================================
  {
    int hdr = bandIdx.y * 2;
    vec4 hCnts = bFetch(bLoc(gl, hdr));
    int hLineN  = int(hCnts.x);
    int hQuadN  = int(hCnts.y);
    int hCubicN = int(hCnts.z);
    int hArcN   = int(hCnts.w);
    int arrIdx  = int(bFetch(bLoc(gl, hdr + 1)).x);
    int hOff = 0;

    // ---- H sub-loop 1: LINES ----
    // The line walker uses native line math (`t = -p.y/dy`) but its
    // SIGN CONVENTION must match the QUAD walker's sign-pattern
    // convention, or shared endpoints between a line and a quadratic
    // in the same band produce fractional-crossing over-counts (visible
    // as 2-row alpha spikes along inner vertical edges).
    //
    // Deriving the matching sign: for a line viewed as a degenerate
    // quadratic with p2 = midpoint(p1, p3), the 0x2E74 LUT reduces
    // to a single boolean — root 1 (add) fires iff p2.y_centered < 0,
    // root 2 (subtract) fires iff p2.y_centered > 0, neither fires
    // iff both endpoints are on the same side (0.0 treated as positive).
    //
    // Equivalent skip-condition: both endpoints same-sign in y
    // means no crossing. The `abs(dy) > 1/65536` safety guard
    // stays so a zero-height line doesn't divide by zero.
    for (int i = 0; i < 1024; i++) {
      if (i >= hLineN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p = texFetch(dL) - vec4(c, c);  // (p1.xy, p2.xy) centered
      if (max(p.x, p.z) * px.x < -0.5) continue;
      // Sign-pattern eligibility (0.0 treated as positive, matching
      // calcRootCode2's `y < 0` convention). Skip same-sign endpoints.
      bool p1Neg = p.y < 0.0;
      bool p2Neg = p.w < 0.0;
      if (p1Neg == p2Neg) continue;
      float dy = p.w - p.y;
      if (abs(dy) < 1.0 / 65536.0) continue;
      float t  = -p.y / dy;
      float rx = mix(p.x, p.z, t);
      float ri = rx * px.x;
      // Matches the LUT's sign: p2 above ray (positive centered) → subtract.
      float sgn = p2Neg ? 1.0 : -1.0;
      xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
      xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
    }
    hOff += hLineN;

    // ---- H sub-loop 2: QUADRATICS (Slug-original CalcRootCode2) ----
    for (int i = 0; i < 1024; i++) {
      if (i >= hQuadN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.x, p12.z), p3.x) * px.x < -0.5) continue;
      uint code = calcRootCode2(p12.y, p12.w, p3.y);
      if (code == 0u) continue;
      vec4 rt = slugSolveHorizQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.x;
        xcov += clamp(ri + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.x;
        xcov -= clamp(ri + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    hOff += hQuadN;

    // ---- H sub-loop 3: CUBICS ----
    // Sign convention matches the H-QUAD walker's LUT canonical form:
    // downward crossing (dY/dt < 0 at root) ADDS, upward crossing
    // (dY/dt > 0) SUBTRACTS. Matching the LUT (rather than a bare
    // sign(evalCD)) avoids fractional-crossing spikes on paths that
    // mix lines with cubics. See V-CUBIC for the analog (with the
    // V-walker's reversed root convention already absorbed).
    for (int i = 0; i < 1024; i++) {
      if (i >= hCubicN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
      if (max(max(p12.x, p12.z), max(p34.x, p34.z)) * px.x < -0.5) continue;
      vec3 rs, ts;
      solveCubicBisect(p12, p34, false, rs, ts);
      vec4 cy = cubicCoeff(p12.y, p12.w, p34.y, p34.w);
      for (int j = 0; j < 3; j++) {
        if (ts[j] < 0.0 || ts[j] >= 1.0 || rs[j] >= 1e10 || rs[j] != rs[j]) continue;
        float ri  = rs[j] * px.x;
        // LUT-aligned: dY/dt < 0 (downward) → ADD; >= 0 → SUBTRACT.
        float sgn = (evalCD(cy, ts[j]) < 0.0) ? 1.0 : -1.0;
        xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    hOff += hCubicN;

    // ---- H sub-loop 4: ARCS ----
    // Sign convention matches H-QUAD/CUBIC LUT canonical form:
    // downward crossing in y (dY/dθ along the natural sweep is
    // negative when the sweep traverses downward, then arcDir
    // flips for reversed-sweep arcs) → ADD. See H-CUBIC for the
    // rationale.
    for (int i = 0; i < 1024; i++) {
      if (i >= hArcN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + hOff + i));
      if ((segRaw.z - c.x) * px.x < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t1) - c;
            float ri = p.x * px.x;
            // LUT-aligned: dY/dθ < 0 → ADD; >= 0 → SUBTRACT.
            float sgn = arcDir * ((arcDyDtheta(d1.z, d1.w, d2.z, t1) < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t2) - c;
            float ri = p.x * px.x;
            float sgn = arcDir * ((arcDyDtheta(d1.z, d1.w, d2.z, t2) < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
  }

  // ============================================================
  // V-walker (vertical ray cast). Integrates ycov / ywgt.
  // ============================================================
  {
    int hdr = bandsY * 2 + bandIdx.x * 2;
    vec4 vCnts = bFetch(bLoc(gl, hdr));
    int vLineN  = int(vCnts.x);
    int vQuadN  = int(vCnts.y);
    int vCubicN = int(vCnts.z);
    int vArcN   = int(vCnts.w);
    int arrIdx  = int(bFetch(bLoc(gl, hdr + 1)).x);
    int vOff = 0;

    // ---- V sub-loop 1: LINES ----
    // Same sign-convention story as H-LINE, but with the V walker's
    // reversed root convention (root 1 → −, root 2 → +). The line
    // walker's sign must therefore be:
    //   sgn = p2Neg ? -1 : +1
    // (Opposite of H-LINE's `p2Neg ? +1 : -1`.)
    // See H-LINE comment for the full LUT derivation.
    for (int i = 0; i < 1024; i++) {
      if (i >= vLineN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p = texFetch(dL) - vec4(c, c);  // (p1.xy, p2.xy) centered
      if (max(p.y, p.w) * px.y < -0.5) continue;
      // V walker fires a vertical ray; eligibility uses x-sign pattern.
      bool p1Neg = p.x < 0.0;
      bool p2Neg = p.z < 0.0;
      if (p1Neg == p2Neg) continue;
      float dx = p.z - p.x;
      if (abs(dx) < 1.0 / 65536.0) continue;
      float t  = -p.x / dx;
      float ry = mix(p.y, p.w, t);
      float ri = ry * px.y;
      float sgn = p2Neg ? -1.0 : 1.0;
      ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
      ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
    }
    vOff += vLineN;

    // ---- V sub-loop 2: QUADRATICS (Slug-original; root-index parity reversed vs H) ----
    for (int i = 0; i < 1024; i++) {
      if (i >= vQuadN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.y, p12.w), p3.y) * px.y < -0.5) continue;
      // V eligibility uses x-sign pattern (curve crosses x=0 plane).
      uint code = calcRootCode2(p12.x, p12.z, p3.x);
      if (code == 0u) continue;
      vec4 rt = slugSolveVertQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.y;
        ycov -= clamp(ri + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.y;
        ycov += clamp(ri + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    vOff += vQuadN;

    // ---- V sub-loop 3: CUBICS ----
    for (int i = 0; i < 1024; i++) {
      if (i >= vCubicN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
      if (max(max(p12.y, p12.w), max(p34.y, p34.w)) * px.y < -0.5) continue;
      vec3 rs, ts;
      solveCubicBisect(p12, p34, true, rs, ts);
      vec4 cx = cubicCoeff(p12.x, p12.z, p34.x, p34.z);
      for (int j = 0; j < 3; j++) {
        if (ts[j] < 0.0 || ts[j] >= 1.0 || rs[j] >= 1e10 || rs[j] != rs[j]) continue;
        float ri  = rs[j] * px.y;
        float sgn = (evalCD(cx, ts[j]) >= 0.0) ? 1.0 : -1.0;
        ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
    vOff += vCubicN;

    // ---- V sub-loop 4: ARCS ----
    for (int i = 0; i < 1024; i++) {
      if (i >= vArcN) break;
      vec4 segRaw = bFetch(bLoc(gl, arrIdx + vOff + i));
      if ((segRaw.z - c.y) * px.y < -0.5) break;
      ivec2 sL = ivec2(segRaw.xy);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      float A = cp * d1.z, B = -sp * d1.w, C = -(d1.x - c.x);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t1) - c;
            float ri = p.y * px.y;
            float sgn = arcDir * ((arcDxDtheta(d1.z, d1.w, d2.z, t1) >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, t2) - c;
            float ri = p.y * px.y;
            float sgn = arcDir * ((arcDxDtheta(d1.z, d1.w, d2.z, t2) >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0);
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
  }
  return vec4(xcov, ycov, xwgt, ywgt);
}

float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  vec4 L = fillLinear(c, px, GD, shapeBB);
  float wsum = max(L.z + L.w, 1.0 / 65536.0);
  float cov = max(abs(L.x * L.z + L.y * L.w) / wsum, min(abs(L.x), abs(L.y)));
  if (evenOdd) return 1.0 - abs(1.0 - fract(cov * 0.5) * 2.0);
  return clamp(cov, 0.0, 1.0);
}
