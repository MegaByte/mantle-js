// _coverage.glsl — fill + stroke curve-coverage kernels and paint sampling,
// shared (spliced via @@COVERAGE@@) between mantle.frag and the maskBake shader.
// Holds every coverage engine: the Slug ray-cast walk, AAC signed-area
// coverage, the GWN run-tree fill (+ SDF AA and the tree-hard no-AA variant),
// the hard band fill, exactBoxCov, and the stroke-band walk.
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
// Slug's clamped-Newton iteration count for the fill walk. 5, not 8: with the
// SECANT seed below, 5 matches 8 exactly on accuracy (measured against AAC, which
// is now an exact-area reference: cubic mean 0.041/255, max 25 at both) and is
// ~15% faster on a dense-cubic draw. 4 is not enough (max error 37), 3 is bad
// (175). The old comment's "keep 8" was correct FOR A MIDPOINT SEED.
#define SLUG_NEWTON 5
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

// Point and both θ-derivatives of a native arc at ONE θ, sharing cos/sin(θ) and
// taking cos/sin(phi) from the caller (they are per-segment constants).
//
// evalArc() and arcDyDtheta()/arcDxDtheta() each recompute cos(phi), sin(phi),
// cos(θ) and sin(θ) from scratch, so the fill walkers were paying EIGHT
// transcendentals per arc root where two suffice — and they take up to two roots,
// in each of the H and V passes. The standalone helpers stay for the stroke
// walker, which calls them at endpoints only.
void arcSample(vec4 d1, float cp, float sp, float th, out vec2 p, out float dx, out float dy) {
  float ct = cos(th), st = sin(th);
  float ax = cp * d1.z, bx = sp * d1.w;      // x = cx + ax·cosθ − bx·sinθ
  float ay = sp * d1.z, by = cp * d1.w;      // y = cy + ay·cosθ + by·sinθ
  p  = vec2(d1.x + ax * ct - bx * st,
            d1.y + ay * ct + by * st);
  dx = -ax * st - bx * ct;
  dy = -ay * st + by * ct;
}
ivec2 bLoc(ivec2 gl, int off) { ivec2 l=ivec2(gl.x+off, gl.y); l.y+=l.x>>12; l.x&=4095; return l; }

// Band segment lists pack TWO entries per texel: (loc0, brk0, loc1, brk1). loc is the
// segment header's LINEAR curve-plane texel index (row*4096 + col; f32-exact under 4096
// rows — encoder-guarded), brk the sorted break axis. Halves the distinct texels a walk
// touches; the odd half's repeat fetch of the shared texel is a cache hit.
vec2 bandEntry(ivec2 gl, int arrIdx, int eIdx) {
  vec4 t = bFetch(bLoc(gl, arrIdx + (eIdx >> 1)));
  return (eIdx & 1) == 0 ? t.xy : t.zw;
}
// Unpack a packed header loc to curve-plane texel coords. Reproduces the old (hx, hy)
// bit-exactly; texels PAST the header that straddle a 4096-column row wrap are already
// handled by texFetch's own wrap.
ivec2 segLocXY(float loc) { int L = int(loc); return ivec2(L & 4095, L >> 12); }

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

// Exact distance from a point to an axis-aligned ellipse (rx,ry) centred at the
// origin, plus the closest point ON the ellipse (returned in `foot`).
//
// The stroke walker previously used the FIRST-ORDER estimate |f|/|∇f| of the
// implicit f(p)=(x/rx)²+(y/ry)²−1. That is exact for a circle (evenly spaced
// level sets) but NOT for an ellipse: |∇f| varies around the curve, so the band
// ±halfW it produces is uneven, and at a thick stroke it cuts visible flat
// facets into a round outline (circles fine, ellipses chamfered). Every
// projected cylinder in a 3D-derived sprite is an ellipse, so its whole white
// outline came out polygonal.
//
// This is Inigo Quilez's closed-form ellipse SDF: reduce to the first quadrant,
// then solve the closest-point quartic with Cardano (no iteration, exact). It
// yields the cosine `co` of the foot's eccentric angle, from which the foot is
// (rx·co, ry·√(1−co²)). We only need the unsigned distance for stroke coverage.
float distToEllipse(vec2 ab, vec2 pIn, out vec2 foot) {
  vec2 sgn = sign(pIn);
  vec2 p = abs(pIn);
  bool swap = p.x > p.y;
  if (swap) { p = p.yx; ab = ab.yx; }
  float l = ab.y * ab.y - ab.x * ab.x;
  // Scale-RELATIVE circle test: an absolute 1e-12 misses a near-circle whose
  // rx,ry differ by a float hair (l ~ 3e-4 at r=35.8), sending it into the ellipse
  // branch where m = ab.x*p.x/l has a near-zero denominator -> huge/Inf
  // intermediates and precision-sensitive UB.
  if (abs(l) < 1e-9 * max(ab.x * ab.x, ab.y * ab.y)) {   // (near-)circle → trivial closest point
    vec2 fq = ab.x * normalize(p + vec2(1e-20));
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
  vec2 fo = swap ? fq.yx : fq.xy;             // undo axis swap
  foot = sgn * fo;                            // restore quadrant
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
  // Break-early threshold hoisted out of the four per-segment tests below.
  float sBreak = c.x - halfW;
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
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
        if (startCap == 0) {
          // Butt cap as an SDF, not a hard drop — see _strokeMath.glsl. A drop
          // makes the cap plane binary, so the pixel it bisects gets all or
          // nothing where the truth is a partial. tRaw < 0 here, so the closest
          // point on the segment IS the endpoint and its distance is |c - a|;
          // intersect that with the half-space behind the cap plane.
          thisD = max(length(c - a), halfW + dot(c - a, -segTan));
        }
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
            // MITER LENGTH IS halfW / sin(theta/2), NOT / cos(theta/2).
            //
            // `cosBetween` is the cosine of the INTERIOR angle theta between the
            // two segments at the vertex, so the half-angle identity needed here
            // is sin(theta/2) = sqrt((1 - cos theta)/2). The `1 + cosBetween`
            // form yields cos(theta/2) and is inverted: it makes miters too SHORT
            // at sharp corners and unbounded at flat ones. Sanity check at
            // theta = 180 (collinear): the true miter is exactly halfW, while
            // halfW/cos(90deg) diverges.
            //
            // Measured on `M20 100 L64 24 L108 100` at stroke-width 12
            // (theta = 60.06deg): true miter 6/sin(30.03deg) = 11.98, the old form
            // gave 6/cos(30.03deg) = 6.93, and the rendered tip stopped ~4 units
            // short of the browser's. Now the tip matches to within AA.
            //
            // This also repairs the miter LIMIT, which per SVG compares
            // miterLength/strokeWidth = 1/sin(theta/2) against the limit; the old
            // form compared 1/cos(theta/2), so miters were clipped by the wrong
            // criterion (and in the wrong direction).
            float cosBetween = dot(-segTan, inTan);
            float sinHalf = sqrt(max(0.5 * (1.0 - cosBetween), 1e-9));
            float miterLen = halfW / max(sinHalf, 1e-6);
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
        if (endCap == 0) {
          // Butt cap as an SDF — see the start twin.
          thisD = max(length(c - b), halfW + dot(c - b, segTan));
        }
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
            // halfW/sin(theta/2) — see the start twin above for why.
            float cosBetween = dot(segTan, -outTan);
            float sinHalf = sqrt(max(0.5 * (1.0 - cosBetween), 1e-9));
            float miterLen = halfW / max(sinHalf, 1e-6);
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
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
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
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
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
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < sBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
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
    // EXACT distance to the (possibly rotated) ellipse. pR is the point in the
    // ellipse's local frame; d1.zw = (rx, ry). The old |f|/|∇f| here was only a
    // first-order estimate — right for a circle, but it faceted thick strokes on
    // any true ellipse (distToEllipse comment has the full story). The foot's
    // angle also gives the in-range test directly, so we no longer approximate
    // the closest angle with atan of the raw point.
    vec2 foot;
    float dEdge = distToEllipse(d1.zw, pR, foot);
    float tAng = atan(foot.y / max(d1.w, 1e-9), foot.x / max(d1.z, 1e-9));
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
//
// STABLE ROOT PAIR, not (b ± d)/a for both roots. A NEAR-degenerate quadratic —
// a symmetric quad whose ctrl is the chord midpoint has a == 0 exactly in em
// space, but the RAY-CENTERED float32 coords reintroduce a ≈ coordinate-ulp —
// slips past the 1/65536 linear-path test once coordinates are large enough
// (≥ ~1000 em units: a ≈ 3e-5 at a 1536px viewport, under the test at 192px —
// a SCALE-dependent bug). The cancelling combination (b ∓ d) then loses every
// significant bit and the root lands anywhere in ±1 (measured: t2 == 1.0
// exactly, reporting the crossing at the far ENDPOINT — winding miscounts that
// rendered band-shaped WHITE SLITS hanging from a wide symmetric quad, plus
// near-apex under-coverage from the same instability on the perpendicular
// rays). The stable pair takes the NON-cancelling combination q = b + sign(b)·d
// and derives the other root from the product c/q — aacQuadRoots does the same;
// roots assigned to preserve this solver's ((b−d)/a, (b+d)/a) ordering.
vec4 slugSolveHorizQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.y;
  float rb = 0.5 / b.y;
  float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  float q  = b.y + (b.y >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0 && abs(q) > 1e-30) ? p12.y / q : tBig;
  float t1 = b.y >= 0.0 ? tSml : tBig;
  float t2 = b.y >= 0.0 ? tBig : tSml;
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
  float q  = b.x + (b.x >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0 && abs(q) > 1e-30) ? p12.x / q : tBig;
  float t1 = b.x >= 0.0 ? tSml : tBig;
  float t2 = b.x >= 0.0 ? tBig : tSml;
  if (abs(a.x) < 1.0/65536.0) { t1 = p12.x * rb; t2 = t1; }
  return vec4((a.y * t1 - b.y * 2.0) * t1 + p12.y,
              (a.y * t2 - b.y * 2.0) * t2 + p12.y,
              t1, t2);
}
void solveCubicBisect(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t) {
  r = vec3(1e20); t = vec3(-1.0);
  vec4 cy = cubicCoeff(vert?p12.x:p12.y, vert?p12.z:p12.w, vert?p34.x:p34.y, vert?p34.z:p34.w);
  vec4 cx = cubicCoeff(vert?p12.y:p12.x, vert?p12.w:p12.z, vert?p34.y:p34.x, vert?p34.w:p34.z);

  // Critical points of Cy: 3A·t² + 2B·t + C = 0
  float qa = 3.0 * cy.x;
  float qb = 2.0 * cy.y;
  float qc = cy.z;
  float split1 = -1.0, split2 = -1.0;
  // DEGENERACY MUST BE RELATIVE, AND THE QUADRATIC ROOTS MUST BE STABLE.
  //
  // cy.x is mathematically ZERO for any cubic symmetric in this axis (p1 == p4
  // and p2 == p3), e.g. the arch `M14 96 C34 8 94 8 114 96 Z`. But it is
  // evaluated as ((-p1 + 3*p2) - 3*p3) + p4 on PIXEL-RELATIVE coordinates, so it
  // comes back as a rounding residue of order 1e-5 that VARIES WITH THE PIXEL —
  // straddling the old absolute 1.0/65536 (1.53e-5) threshold. Above it, the
  // quadratic branch ran with a near-zero leading coefficient and computed both
  // roots as (-qb +- sd)/(2*qa), where the (-qb + sd) form cancels catastrophically
  // and the apex root landed outside (0,1).
  //
  // Losing that split is not a small error: the sub-interval split at a critical
  // point is what makes each piece y-MONOTONE, which is the precondition for the
  // endpoint sign test to detect a crossing at all. With the arch unsplit, [0,1]
  // has BOTH endpoints at y=96 — same side of the ray — so the walker reported NO
  // crossings through the middle of a solid shape. Whole bands of interior pixels
  // came back empty (3194 of 8018 px, worst pixel fully wrong).
  //
  // Fix both halves: scale the degeneracy test to the coefficients actually in
  // play, and use the numerically stable root form (the same one used elsewhere
  // in this file) so a small qa degrades gracefully instead of cancelling.
  if (abs(qa) <= 1e-6 * max(abs(qb), abs(qc))) {
    if (abs(qb) > 1e-30) {
      float s = -qc / qb;
      if (s > 0.0 && s < 1.0) split1 = s;
    }
  } else {
    float disc = qb*qb - 4.0*qa*qc;
    if (disc >= 0.0) {
      float sd = sqrt(disc);
      float qq = -0.5 * (qb + (qb >= 0.0 ? sd : -sd));
      float s1 = qq / qa;
      float s2 = (abs(qq) > 1e-30) ? (qc / qq) : s1;
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
    // Clamped Newton, SECANT-seeded. The clamp guarantees bounded behaviour near
    // critical points; the seed is what sets the iteration count. Seeding at the
    // midpoint (as this did) wastes the first steps re-deriving what the chord
    // through the bracket ends already tells you, which is why 8 were needed. The
    // secant seed lands close enough that SLUG_NEWTON iterations suffice.
    // f(lo) and f(hi) straddle zero here (that is why this sub-interval fired).
    float fLo = evalC(cy, lo) - 0.0, fHi = evalC(cy, hi) - 0.0;
    float sden = fHi - fLo;
    float xr = (abs(sden) > 1e-12) ? clamp(lo - fLo * (hi - lo) / sden, lo, hi)
                                   : 0.5 * (lo + hi);
    for (int k = 0; k < SLUG_NEWTON; k++) {
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
@@BOX_COV@@

// Reconstruct the edge from its two centre-line crossings (rx, 0) and (0, ry), both in
// PIXEL units and signed, and return the exact covered fraction. The fill lies on the
// {x <= rx} side along the H ray (that is what clamp(ri + 0.5) encodes), which fixes the
// orientation. Degenerates when a ray is parallel to the edge (|r| explodes) — the caller
// only takes this path when both rays have exactly one crossing.
// Bezier tangents at parameter t, scaled to PIXEL units. p12 = (P1, P2) and p3 / p34 carry
// the remaining control points, all already relative to the pixel centre (em).
vec2 quadTanPx(vec4 p12, vec2 p3, float t, vec2 px) {
  vec2 d = 2.0 * ((p12.zw - p12.xy) * (1.0 - t) + (p3 - p12.zw) * t);
  return d * px;
}
vec2 cubicTanPx(vec4 p12, vec4 p34, float t, vec2 px) {
  float u = 1.0 - t;
  vec2 d = 3.0 * ((p12.zw - p12.xy) * (u * u) + (p34.xy - p12.zw) * (2.0 * u * t) + (p34.zw - p34.xy) * (t * t));
  return d * px;
}

// Half-plane (n, d) through ptPx with direction tanPx, both in PIXEL units relative to the
// pixel centre. Returns vec3(n.x, n.y, d); zero when degenerate.
// UNNORMALIZED on purpose: the sqrt + 2 divides are deferred to renderFill, which runs them
// ONCE per fragment on the surviving record, instead of once per crossing. Most edge pixels
// have a single crossing, so this removes a sqrt from the walker's inner loop.
vec3 exLine(vec2 tanPx, vec2 ptPx) {
  vec2 n = vec2(tanPx.y, -tanPx.x);
  return vec3(n, dot(n, ptPx));
}

// Per-ray half-plane recording. Each of the ten crossing sites (4 curve types x 2 rays, plus
// the two quad "subtract" roots) does THREE assignments — nothing else. The expensive part,
// deciding whether the H-ray's edge and the V-ray's edge are the same line, happens ONCE per
// fragment at the end of fillLinear.
//
// This shape was chosen for COMPILE time, which is a real cost: each new per-bundle variant
// forces a synchronous link, and a fat body inlined ten times pushed that to ~20-40ms — a
// visible first-frame hitch. (Hoisting the body into a function with inout params is far
// worse: the driver stops optimizing the unrolled walker loops and the link cost explodes to
// ~1s. Measured, not guessed.)
#ifdef MANTLE_EXACT_EDGE
#define EX_H(V3) { exNH++; if (exNH == 1) { vec3 _v = (V3); \
  if (dot(_v.xy, _v.xy) < 1e-18) exOther = true; else { exNrmH = _v.xy; exDH = _v.z; } } }
#define EX_V(V3) { exNV++; if (exNV == 1) { vec3 _v = (V3); \
  if (dot(_v.xy, _v.xy) < 1e-18) exOther = true; else { exNrmV = _v.xy; exDV = _v.z; } } }
#else
// OFF (the default). The macro swallows its argument, so the Bézier TANGENT the caller would have
// evaluated at every crossing never appears in the source — and the normals, offsets, counters and
// flags stop being live across the band walk. That state, not the area math, is what the exact
// branch costs: it is register pressure, and register pressure is paid by EVERY fragment, including
// the interior ones that never reach the branch. Compiling it out is worth ~45% of frame on
// curve-and-edge-dense content (tiger, 900px: 18.8 → 10.4 ms).
#define EX_H(V3) {}
#define EX_V(V3) {}
#endif

// Slope-AA (MANTLE_SLOPE_AA): keep only the SIGNED OFFSET of the crossing nearest
// the pixel centre on each ray — two floats of walker state (vs the exact-edge
// branch's normals/offsets/counters), no extra fetches, one compare per crossing.
// renderFill reconstructs the boundary SECANT through the two nearest crossings
// and takes its exact box coverage when (and only when) that single-edge model
// reproduces the measured per-ray coverages; otherwise the default combiner
// stands. Exact for any straight edge that crosses both centre rays (the
// diagonal regime, where the default two-ray blend is weakest); a chord
// approximation for curves; corners and multi-edge pixels fail the consistency
// check and keep the default.
#ifdef MANTLE_SLOPE_AA
#define SL_H(RI) { float _r = (RI); if (abs(_r) < abs(slH)) slH = _r; }
#define SL_V(RI) { float _r = (RI); if (abs(_r) < abs(slV)) slV = _r; }
#else
#define SL_H(RI) {}
#define SL_V(RI) {}
#endif

vec4 fillLinear(vec2 c, vec2 px, ivec4 GD, vec4 shapeBB, out vec4 exInfo, out vec2 slInfo) {
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
  // Exact-edge tracking: counts + the raw (unclamped) crossing offset per ray. Any curve
  // crossing poisons the pixel (exOther) — the closed form is for straight edges only.
  // Exact-edge tracking. We do NOT reconstruct the line from two ray crossings (a segment
  // often crosses only ONE centre ray within its own extent, so that path covers a minority
  // of edge pixels). The H-line walker already holds the segment's endpoints, so build the
  // half-plane directly: exact for ANY pixel cut by exactly one straight edge.
#ifdef MANTLE_EXACT_EDGE
  int exNH = 0, exNV = 0; bool exOther = false;
  vec2 exNrmH = vec2(0.0), exNrmV = vec2(0.0); float exDH = 0.0, exDV = 0.0;
#endif
#ifdef MANTLE_SLOPE_AA
  float slH = 1e30, slV = 1e30;
#endif
  // Break-early thresholds, hoisted out of the eight per-segment tests below:
  //   (entryBrk - c.x) * px.x < -0.5   ==   segRaw.y * px.x < c.x*px.x - 0.5
  // Algebraically exact (no divide, so no sign flip). One subtract per segment
  // saved, in the walker's innermost loop.
  float hBreak = c.x * px.x - 0.5;
  float vBreak = c.y * px.y - 0.5;

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

#ifndef MANTLE_NO_LINE
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
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
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
      xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
      xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      if (abs(ri) < 1.0) {   // only edges that can touch this pixel box
        vec2 A = vec2(p.x * px.x, p.y * px.y);          // segment endpoints in PIXEL units,
        vec2 B = vec2(p.z * px.x, p.w * px.y);          // relative to the pixel centre
        EX_H(exLine(B - A, A));
      }
    }
#endif
    hOff += hLineN;

#ifndef MANTLE_NO_QUAD
    // ---- H sub-loop 2: QUADRATICS (Slug-original CalcRootCode2) ----
    for (int i = 0; i < 1024; i++) {
      if (i >= hQuadN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 p12 = texFetch(dL) - vec4(c, c);
      vec2 p3  = texFetch(ivec2(dL.x + 1, dL.y)).xy - c;
      if (max(max(p12.x, p12.z), p3.x) * px.x < -0.5) continue;
      uint code = calcRootCode2(p12.y, p12.w, p3.y);
      if (code == 0u) continue;
      vec4 rt = slugSolveHorizQuad(p12, p3);
      if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x) {
        float ri = rt.x * px.x;
        xcov += clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
        // TANGENT line at the crossing: exact for the tangent, so only the CURVATURE inside
        // the pixel remains as error (second order) instead of the combiner's first-order one.
        if (abs(ri) < 1.0) EX_H(exLine(quadTanPx(p12, p3, rt.z, px), vec2(ri, 0.0)));
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.x;
        xcov -= clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
        if (abs(ri) < 1.0) EX_H(exLine(quadTanPx(p12, p3, rt.w, px), vec2(ri, 0.0)));
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    hOff += hQuadN;

#ifndef MANTLE_NO_CUBIC
    // ---- H sub-loop 3: CUBICS ----
    // Sign convention matches the H-QUAD walker's LUT canonical form:
    // downward crossing (dY/dt < 0 at root) ADDS, upward crossing
    // (dY/dt > 0) SUBTRACTS. Matching the LUT (rather than a bare
    // sign(evalCD)) avoids fractional-crossing spikes on paths that
    // mix lines with cubics. See V-CUBIC for the analog (with the
    // V-walker's reversed root convention already absorbed).
    for (int i = 0; i < 1024; i++) {
      if (i >= hCubicN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
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
        xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
        if (abs(ri) < 1.0) EX_H(exLine(cubicTanPx(p12, p34, ts[j], px), vec2(ri, 0.0)));
        xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    hOff += hCubicN;

#ifndef MANTLE_NO_ARC
    // ---- H sub-loop 4: ARCS ----
    // Sign convention matches H-QUAD/CUBIC LUT canonical form:
    // downward crossing in y (dY/dθ along the natural sweep is
    // negative when the sweep traverses downward, then arcDir
    // flips for reversed-sweep arcs) → ADD. See H-CUBIC for the
    // rationale.
    for (int i = 0; i < 1024; i++) {
      if (i >= hArcN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
      if (segRaw.y * px.x < hBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      // ENDPOINT EXACTLY ON THE RAY — match the LINE walker's convention.
      // That walker decides a crossing from ENDPOINT SIGNS with a centred y of
      // exactly 0 counted as POSITIVE, so a segment running into the ray
      // straddles and is counted. It relies on the neighbouring segment to
      // supply the opposing term, which cancels where the outline merely TOUCHES
      // the ray. The arc walker instead solves the true curve, and at such a
      // vertex its root falls just outside the arc's own theta span — so it
      // supplies nothing, the touch reads as a crossing, and the winding is off
      // by one for that entire scanline (a one-row slit, only when a pixel
      // centre lands on the vertex). Applying the chord rule to the arc's own
      // endpoints restores the cancellation.
      vec2 pS9, pE9; float s9x, s9y, e9x, e9y;
      arcSample(d1, cp, sp, d2.x, pS9, s9x, s9y);
      arcSample(d1, cp, sp, d2.y, pE9, e9x, e9y);
      float yS9 = pS9.y - c.y, yE9 = pE9.y - c.y;
      if (abs(yS9) < 1e-3 && abs(yE9) >= 1e-3 && yE9 < 0.0) {
        float r9 = (pS9.x - c.x) * px.x;                 // start on ray, other end above
        xcov += clamp(r9 + 0.5, 0.0, 1.0); SL_H(r9);
        xwgt = max(xwgt, clamp(1.0 - abs(r9) * 2.0, 0.0, 1.0));
      }
      if (abs(yE9) < 1e-3 && abs(yS9) >= 1e-3 && yS9 < 0.0) {
        float r9 = (pE9.x - c.x) * px.x;                 // end on ray, other end above
        xcov -= clamp(r9 + 0.5, 0.0, 1.0); SL_H(r9);
        xwgt = max(xwgt, clamp(1.0 - abs(r9) * 2.0, 0.0, 1.0));
      }
      float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t1, p, ddx, ddy);
            float ri = (p.x - c.x) * px.x;
            // LUT-aligned: dY/dθ < 0 → ADD; >= 0 → SUBTRACT.
            float sgn = arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
            if (abs(ri) < 1.0) EX_H(exLine(vec2(ddx, ddy) * px, vec2(ri, (p.y - c.y) * px.y)));
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t2, p, ddx, ddy);
            float ri = (p.x - c.x) * px.x;
            float sgn = arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
            xcov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_H(ri);
            if (abs(ri) < 1.0) EX_H(exLine(vec2(ddx, ddy) * px, vec2(ri, (p.y - c.y) * px.y)));
            xwgt = max(xwgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
#endif
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

#ifndef MANTLE_NO_LINE
    // ---- V sub-loop 1: LINES ----
    // Same sign-convention story as H-LINE, but with the V walker's
    // reversed root convention (root 1 → −, root 2 → +). The line
    // walker's sign must therefore be:
    //   sgn = p2Neg ? -1 : +1
    // (Opposite of H-LINE's `p2Neg ? +1 : -1`.)
    // See H-LINE comment for the full LUT derivation.
    for (int i = 0; i < 1024; i++) {
      if (i >= vLineN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
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
      ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
      // An edge can cut a pixel CORNER without crossing the horizontal centre ray, so the
      // H walker alone misses it. Record here too, de-duplicated: if this is the same line
      // the H walker already saw (same normal and offset), do not count it twice.
      if (abs(ri) < 1.0) {
        vec2 A2 = vec2(p.x * px.x, p.y * px.y);
        vec2 B2 = vec2(p.z * px.x, p.w * px.y);
        EX_V(exLine(B2 - A2, A2));
      }
      ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
    }
#endif
    vOff += vLineN;

#ifndef MANTLE_NO_QUAD
    // ---- V sub-loop 2: QUADRATICS (Slug-original; root-index parity reversed vs H) ----
    for (int i = 0; i < 1024; i++) {
      if (i >= vQuadN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
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
        ycov -= clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
        if (abs(ri) < 1.0) EX_V(exLine(quadTanPx(p12, p3, rt.z, px), vec2(0.0, ri)));
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
      if (code > 1u && !isinf(rt.y) && rt.y == rt.y) {
        float ri = rt.y * px.y;
        ycov += clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
        if (abs(ri) < 1.0) EX_V(exLine(quadTanPx(p12, p3, rt.w, px), vec2(0.0, ri)));
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    vOff += vQuadN;

#ifndef MANTLE_NO_CUBIC
    // ---- V sub-loop 3: CUBICS ----
    for (int i = 0; i < 1024; i++) {
      if (i >= vCubicN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
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
        ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
        if (abs(ri) < 1.0) EX_V(exLine(cubicTanPx(p12, p34, ts[j], px), vec2(0.0, ri)));
        ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
      }
    }
#endif
    vOff += vCubicN;

#ifndef MANTLE_NO_ARC
    // ---- V sub-loop 4: ARCS ----
    for (int i = 0; i < 1024; i++) {
      if (i >= vArcN) break;
      vec2 segRaw = bandEntry(gl, arrIdx, vOff + i);
      if (segRaw.y * px.y < vBreak) break;
      ivec2 sL = segLocXY(segRaw.x);
      ivec2 dL = ivec2(sL.x + 1, sL.y);
      vec4 d1 = texFetch(dL), d2 = texFetch(ivec2(dL.x + 1, dL.y));
      float sp = sin(d2.z), cp = cos(d2.z);
      float A = cp * d1.z, B = -sp * d1.w, C = -(d1.x - c.x);
      float Rlen = sqrt(A * A + B * B);
      float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
      if (Rlen > 1e-10) {
        float ratio = C / Rlen;
        if (abs(ratio) < 0.99999) {
          // PHASE AT B == 0: for an UNROTATED ellipse (phi = 0 — every circle and
          // axis-aligned ellipse) sp is +0, so `-sp * ry` is NEGATIVE ZERO, and
          // atan(-0, +A) resolves to PI instead of -0. That puts the phase half a
          // turn out, pushing BOTH roots outside the arc's theta range, so the arc
          // contributes no crossings and the shape does not fill. Writing the
          // degenerate phase directly is exact and cannot be optimised away (adding
          // +0.0 to normalise the zero was elided by the compiler and did nothing).
          //
          // Only the V walker is exposed: here A = cos(phi)*rx is POSITIVE while B
          // carries the zero. The H walker has A = sin(phi)*rx = 0 and B = cos(phi)*ry
          // > 0, and atan(+y, ±0) is +PI/2 either way, so it is immune — which is why
          // this only ever showed up as MISSING FILL, never as a wrong edge.
          float ang = (B == 0.0) ? (A >= 0.0 ? 0.0 : TWO_PI * 0.5) : atan(B, A);
          float b2 = acos(clamp(ratio, -1.0, 1.0));
          float t1 = ang + b2, t2 = ang - b2;
          if (arcInRange(t1, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t1, p, ddx, ddy);
            float ri = (p.y - c.y) * px.y;
            float sgn = arcDir * ((ddx >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
            if (abs(ri) < 1.0) EX_V(exLine(vec2(ddx, ddy) * px, vec2((p.x - c.x) * px.x, ri)));
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
          if (arcInRange(t2, d2.x, d2.y)) {
            vec2 p; float ddx, ddy; arcSample(d1, cp, sp, t2, p, ddx, ddy);
            float ri = (p.y - c.y) * px.y;
            float sgn = arcDir * ((ddx >= 0.0) ? 1.0 : -1.0);
            ycov += sgn * clamp(ri + 0.5, 0.0, 1.0); SL_V(ri);
            if (abs(ri) < 1.0) EX_V(exLine(vec2(ddx, ddy) * px, vec2((p.x - c.x) * px.x, ri)));
            ywgt = max(ywgt, clamp(1.0 - abs(ri) * 2.0, 0.0, 1.0));
          }
        }
      }
    }
#endif
  }
  // (n.x, n.y, code): code < 0 ⇒ a curve crossed; else the count of straight edges near it
  // ONE merge per fragment. Nothing to merge unless BOTH rays saw exactly one edge.
  //   * either ray saw two edges, or a degenerate one ⇒ fall back
  //   * both rays saw one ⇒ same line? (parallel and same offset) then it is one edge; a corner
  //     gives two different lines ⇒ fall back
  //   * only one ray saw an edge ⇒ use it (an edge can cut a pixel corner without crossing the
  //     other centre ray, and a segment often crosses only one ray within its own extent)
#ifdef MANTLE_EXACT_EDGE
  vec2 exNrm = exNrmH; float exD = exDH; float exCode = 0.0;
  if (exOther || exNH > 1 || exNV > 1) exCode = -1.0;
  else if (exNH == 1 && exNV == 1) {
    float l1 = length(exNrmH), l2 = length(exNrmV), pp = l1 * l2;
    float crs = abs(exNrmH.x * exNrmV.y - exNrmH.y * exNrmV.x);
    bool same = crs <= 0.174 * pp && abs(abs(exDH) * l2 - abs(exDV) * l1) <= 0.35 * pp;
    if (!same) exCode = -1.0;
    else {
      exCode = 1.0;
      if (abs(exDV) * l1 < abs(exDH) * l2) { exNrm = exNrmV; exD = exDV; }   // the more central one
    }
  } else if (exNH == 1) exCode = 1.0;
  else if (exNV == 1) { exNrm = exNrmV; exD = exDV; exCode = 1.0; }
  exInfo = vec4(exNrm, exD, exCode);
#else
  exInfo = vec4(0.0);                                 // exact-edge branch compiled out
#endif
#ifdef MANTLE_SLOPE_AA
  slInfo = vec2(slH, slV);
#else
  slInfo = vec2(1e30);                                // slope-AA branch compiled out
#endif
  return vec4(xcov, ycov, xwgt, ywgt);
}

#if defined(MANTLE_GWN) || defined(MANTLE_HARD_MIXED)
// GWN_WINDING_ONLY: the tree-hard (MANTLE_HARD_TREE) and bare-GWN (no SDF/AAC) programs share
// renderFillGWNSDF's traversal but want the folded winding, not coverage. Derived from the defines
// already set, so no program has to opt in explicitly.
#if defined(MANTLE_HARD_TREE) || defined(MANTLE_HARD_MIXED) || (defined(MANTLE_GWN) && !defined(MANTLE_GWN_SDF))
#define GWN_WINDING_ONLY 1
#endif
// The GWN run-tree kernel (renderFillGWNSDF + helpers) is heavy; compiling it alongside AAC
// costs GPU occupancy (~+15-70% measured). A band-only MIXED program (line/quad hard shapes,
// no cubic/arc) never calls it, so exclude it there — keep it only when a tree consumer is present.
#if !defined(MANTLE_HARD_MIXED) || defined(MANTLE_HARD_TREE)
// ============================================================================
// Closed-form generalized winding number over the packed run tree.
//
// The winding number of p wrt a closed contour is the sum, over its arcs, of
//     GWN(arc) = signedAngle(P0-p -> Pn-p) / 2pi        [chord subtended angle]
//              + (+-1 if p lies in the arc<->chord lune) [bulge correction]
// The chord term is ONE atan2 at ANY degree; the bulge term is a couple of sign tests plus the
// curve's own implicit, and is zero for every pixel outside the thin lune hugging the curve. So
// the per-curve cost does not grow with degree — unlike the Slug walk, which root-solves per ray
// (a quadratic solve for quads, a cubic solve for cubics).
//
// Winding is GLOBAL: every segment must be summed exactly once. The run tree references each
// segment from exactly one leaf, so the traversal sums it once — no band double-count to undo,
// and no break-early prune (a segment far to the left still contributes its subtended angle).

const float GWN_TAU = 6.283185307179586;

// signed angle from (A-p) to (B-p), in turns
float gwnChord(vec2 p, vec2 A, vec2 B) {
  vec2 a = A - p, b = B - p;
  return atan(a.x * b.y - a.y * b.x, dot(a, b)) / GWN_TAU;
}

// ---------------------------------------------------------------------------
// GWN + implicit-SDF. AA WITHOUT AAC.
//
// The tree hands a boundary pixel its NEAR segments. From those we recover signed distances and
// boundary NORMALS, and (distance, normal) is precisely what exactBoxCov turns into the exact
// area of the pixel box under that half-plane — the same closed form Slug uses for single-edge
// pixels and LB uses for curves. So the coverage comes from the geometry the traversal already
// touched: no band walk, no area integral, no second structure.
//
// Per segment we evaluate the curve's own implicit f and its gradient, in PIXEL units:
//   line: f = dot(n, p - A), |grad| = 1
//   quad: f = u^2 - v over the control triangle's barycentrics (the Loop-Blinn implicit); grad by
//         chain rule through the (constant) barycentric gradients.
// Coverage = exactBoxCov(grad/|grad|, -f/|grad|), oriented so that "inside" is the filled side.
//
// Two endpoint/corner refinements keep the local half-plane approximation valid:
//  * END-TANGENT EXTENSION. An implicit does not stop at its segment's endpoints, and past them
//    it CURLS (the far arm of the parabola) — near-circle seam pixels read the curled extension
//    of the neighbouring quad and lost coverage one-sidedly (all 24 bad px sat exactly at the
//    8 joint angles; 415 negative-error px vs 77 positive). Out-of-span candidates therefore
//    use the segment's END-TANGENT half-plane through the endpoint — the honest linear
//    continuation (the same osculating-line rule the LB kind-12 band uses in its corner wedges).
//  * TWO-CANDIDATE COMBINE. One half-plane per pixel undercounts any pixel holding two distinct
//    edges (corners; the triangle's 2 bad px). Keep the best candidate from TWO different
//    segments and combine with the LB kind-10 chained-coverage rules — intersection for convex,
//    union for reflex, blended toward min/max as the planes become parallel (seams degrade to
//    the single-plane answer). Convex/reflex is decided by the winding: if the centre is inside
//    the fill but only ONE plane claims it, the corner is reflex (fill = union); outside with
//    one claim = convex (fill = intersection); unanimous pixels default to the convex blend.
struct GwnSdfCand {
  float dpx;    // rank: TRUE |distance| to the segment in pixels (endpoint distance beyond the
                // span — an unbounded plane passes near pixels on the far side of the shape
                // and a bogus near-plane there destroys the ranking). 1e30 = no candidate.
  float sFill;  // FILL-signed distance of the coverage half-plane at the pixel centre, pixels
                // (+ = centre on the ink side). Oriented by travel x contour handedness —
                // deterministic, no winding-agreement flip (which inverts near cov = 1/2 and
                // misoriented reflex inner-ring joints).
  vec2 nf;      // unit INTO-FILL plane normal, PIXEL space
  vec2 tv;      // unit TRAVEL tangent at the near point (em space) — corner classification
  float endNear;// +1 pixel near the segment's END, -1 near its START, 0 mid-segment
  vec2 V;       // the near endpoint (em) when endNear != 0
};

// Evaluate one segment as an SDF candidate (the caller still sums exact per-segment GWN for
// winding). PIXEL-SPACE gradient = em-gradient / px (em = c + delta/px per axis), so the
// distance |f|/|grad| comes out in pixels at any scale.
// Signed +x-axis ray crossing of the directed edge a -> b (coords RELATIVE to the pixel):
// the cheap piece of the TELESCOPED leaf winding. A contiguous run's per-segment chord
// angles sum to ONE chord angle of the whole run plus the winding of the closed chord
// polygon around the pixel — so a near leaf costs one atan2 total, with the polygon
// winding counted by these sign tests instead of trig.
float gwnCross(vec2 a, vec2 b) {
  if ((a.y < 0.0) == (b.y < 0.0)) return 0.0;
  float dy = b.y - a.y;
  float t = a.x * dy - a.y * (b.x - a.x);
  return (t * dy > 0.0) ? sign(dy) : 0.0;
}

// EXACT area of the centred unit pixel box under BOTH half-planes {n1·x <= d1, n2·x <= d2}:
// Sutherland-Hodgman box clip (<= 6-gon) + shoelace. The inclusion-exclusion lower bound
// cA + cB - 1 (the LB kind-10 combine) UNDERESTIMATES whenever the two planes' union does
// not cover the box — exactly the corner pixels holding the vertex (the triangle's two
// 30/255 under-inked corner pixels). One clip serves intersection AND union
// (union = cA + cB - intersection).
float gwnBoxCov2(vec2 n1, float d1, vec2 n2, float d2) {
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

// Merged per-segment evaluation: ONE set of texel fetches yields the winding pieces (the
// chord-polygon crossing + the quad's lune term, sharing the barycentric work) AND the SDF
// candidate. Returns the winding contribution (integer-valued, in turns). `sigma` is the
// content's handedness (+1 = ink left of travel), decoded from the tree header.
// Exact +x ray crossing of a cubic (defined below with the hard-band crossers). A cubic PIECE
// winds with this, not with chord + lune — see the type-4 branch.
float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);

float gwnSegEval(vec2 c, vec2 px, ivec2 sL, int type, float sigma, out GwnSdfCand cand) {
  cand.dpx = 1e30; cand.sFill = 0.0; cand.nf = vec2(0.0);
  cand.tv = vec2(0.0); cand.endNear = 0.0; cand.V = vec2(0.0);
  if (type == 6) {
    // HARD CUBIC PIECE: a cusp/loop cubic, or a near-degenerate one with no single-branch implicit
    // (cubicKLMN → null). These are the MAJORITY of a curve-heavy asset's pieces (~86% of the
    // tiger's): flatSplit drives most cubics down to nearly straight, and a nearly straight cubic
    // has no usable implicit but a nearly perfect chord. So wind it EXACTLY (hardCrossCubic, same
    // +up convention as gwnCross) and take coverage from the CHORD — which is exactly a type-0 line
    // candidate on the endpoints P0..P3. This is why type 4 and 6 are one branch away from each
    // other: identical winding, and the only difference is implicit-vs-chord for the ramp.
    vec4 p01 = texFetch(sL);                          // (P0, P1)
    vec4 p23 = texFetch(ivec2(sL.x + 1, sL.y));       // (P2, P3)
    float wSeg = hardCrossCubic(c, p01 - vec4(c, c), p23 - vec4(c, c));
    vec2 A = p01.xy, B = p23.zw, t = B - A;            // the chord, as a line candidate
    float L2 = dot(t, t);
    if (L2 < 1e-20) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);
    float f = dot(n, c - A);
    vec2 gPx = n / px;
    float gpx = length(gPx);
    if (gpx < 1e-12) return wSeg;
    float tproj = dot(c - A, t) / L2;
    cand.dpx = abs(f) / gpx;
    if (tproj < 0.0) cand.dpx = length((c - A) * px);
    else if (tproj > 1.0) cand.dpx = length((c - B) * px);
    cand.nf = sigma * gPx / gpx;
    cand.sFill = sigma * f / gpx;
    cand.tv = t * inversesqrt(L2);
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = A; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = B; }
    return wSeg;
  }
  if (type == 0) {                                    // LINE: exact half-plane
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 A = pe.xy, B = pe.zw, t = B - A;
    float wSeg = gwnCross(A - c, B - c);
    float L2 = dot(t, t);
    if (L2 < 1e-20) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);      // = leftPerp(travel)
    float f = dot(n, c - A);
    vec2 gPx = n / px;                                // px-space gradient
    float gpx = length(gPx);
    if (gpx < 1e-12) return wSeg;
    float dPlane = abs(f) / gpx;
    float tproj = dot(c - A, t) / L2;
    cand.dpx = dPlane;
    if (tproj < 0.0) cand.dpx = length((c - A) * px);
    else if (tproj > 1.0) cand.dpx = length((c - B) * px);
    // ink left of travel (sigma +1) => into-fill normal = +leftPerp = +n
    cand.nf = sigma * gPx / gpx;
    cand.sFill = sigma * f / gpx;
    cand.tv = t * inversesqrt(L2);
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = A; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = B; }
    return wSeg;
  }
  if (type == 1) {                                    // QUAD: Loop-Blinn implicit u^2 - v
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 P0 = p12.xy, P1 = p12.zw, P2 = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    float wSeg = gwnCross(P0 - c, P2 - c);            // chord-polygon edge
    vec2 chord = P2 - P0;
    float cl2 = dot(chord, chord);
    float tproj = cl2 > 1e-20 ? dot(c - P0, chord) / cl2 : 0.5;
    // barycentrics: needed by the LUNE winding term at any tproj, and by the in-span
    // implicit — computed once.
    float d = (P1.y - P2.y) * (P0.x - P2.x) + (P2.x - P1.x) * (P0.y - P2.y);
    float l = 0.0, m = 0.0, n_ = 0.0, u = 0.0, v = 0.0;
    vec2 gL = vec2(0.0), gm = vec2(0.0), gn = vec2(0.0);
    bool haveBary = abs(d) >= 1e-20;
    if (haveBary) {
      gL = vec2(P1.y - P2.y, P2.x - P1.x) / d;        // grad of bary(P0)  (not gl_*)
      gm = vec2(P2.y - P0.y, P0.x - P2.x) / d;        // grad of bary(P1)
      l = dot(gL, c - P2); m = dot(gm, c - P2);
      n_ = 1.0 - l - m;
      gn = -gL - gm;
      u = m * 0.5 + n_; v = n_;
      // LUNE: in the control triangle, between chord and curve → ±1 winding correction.
      if (l >= 0.0 && m >= 0.0 && n_ >= 0.0 && (u * u - v) < 0.0) {
        float sideP = (P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x;
        wSeg += sign(sideP);
      }
    }
    vec2 gEm; float f; float rank = -1.0;
    if (tproj < 0.0 || tproj > 1.0) {
      // OUT OF SPAN: the end-tangent half-plane through the endpoint. The raw implicit's far
      // arm CURLS past the endpoint — near-circle seam pixels read the neighbouring quad's
      // curled extension and lost coverage one-sidedly (all 24 bad px at the 8 joint angles).
      vec2 V  = tproj < 0.0 ? P0 : P2;
      vec2 tg = tproj < 0.0 ? P1 - P0 : P2 - P1;
      float tl2 = dot(tg, tg);
      if (tl2 < 1e-20) { tg = chord; tl2 = cl2; }
      vec2 n = vec2(-tg.y, tg.x) * inversesqrt(max(tl2, 1e-20));
      f = dot(n, c - V);
      gEm = n;
      rank = length((c - V) * px);                    // true SDF distance beyond the span
    } else {
      if (!haveBary) return wSeg;
      vec2 gu = gm * 0.5 + gn, gv = gn;
      f = u * u - v;
      gEm = 2.0 * u * gu - gv;
    }
    vec2 gPx = gEm / px;                              // em-gradient -> px-space gradient
    float gpx = length(gPx);
    if (gpx < 1e-12) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;
    // SLAB-AWARE rank (see the piece branch): the parabola's far arm passes the chord-span
    // test far from the segment; a quad's true max deviation is exactly ctrlDev / 2.
    if (rank < 0.0 && cl2 > 1e-20) {
      float cl9 = sqrt(cl2);
      float devS9 = ((c.x - P0.x) * chord.y - (c.y - P0.y) * chord.x) / cl9;
      float ctrlDev = abs((P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x) / cl9;
      float slabPx = (abs(devS9) - 0.5 * ctrlDev) / max(min(1.0 / px.x, 1.0 / px.y), 1e-12);
      cand.dpx = max(dPlane, slabPx);
    }
    // travel tangent = the plane normal's perp, oriented along the chord (travel direction);
    // fill side = sigma x left of travel: fillSign relative to the gradient = sigma x
    // sign(cross(travel, grad)) (leftPerp(t)·g == cross(t, g)).
    vec2 tvq = vec2(gEm.y, -gEm.x);
    if (dot(tvq, chord) < 0.0) tvq = -tvq;
    cand.tv = normalize(tvq);
    float fillSgn = sigma * ((cand.tv.x * gEm.y - cand.tv.y * gEm.x) >= 0.0 ? 1.0 : -1.0);
    cand.nf = fillSgn * gPx / gpx;
    cand.sFill = fillSgn * f / gpx;
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = P0; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = P2; }
    return wSeg;
  }
  if (type == 4 || type == 5) {
    // PIECE records (tree-private, appended by the encoder): 4 = single-branch CUBIC piece
    // carrying the affine k/l/m rows of the Loop-Blinn implicit k^3 - lm; 5 = <= 90-degree
    // ARC piece carrying the exact ellipse implicit. Shared structure: chord edge for the
    // crossing count, a slab-guarded lune term, the implicit (in-span) or the packed
    // end-tangent plane (out-of-span) as the SDF candidate.
    vec4 tEnds = texFetch(sL);                        // (P0.xy, P1.xy) piece endpoints
    vec2 E0 = tEnds.xy, E1 = tEnds.zw;
    float wSeg = gwnCross(E0 - c, E1 - c);            // chord edge (an UNCERTIFIED cubic overwrites it)
    vec2 chord = E1 - E0;
    float cl2 = dot(chord, chord);
    if (cl2 < 1e-20) return wSeg;
    float cl = sqrt(cl2);
    float tproj = dot(c - E0, chord) / cl2;
    float devS = ((c.x - E0.x) * chord.y - (c.y - E0.y) * chord.x) / cl;   // signed perp deviation
    float f; vec2 gEm;
    float luneAdd, maxDev, fRegionSgn;
    vec2 tv0, tv1;
    if (type == 4) {
      vec4 tk = texFetch(ivec2(sL.x + 1, sL.y));      // (kx, ky, kc, luneAdd — arc-shared, unused)
      vec4 tl = texFetch(ivec2(sL.x + 2, sL.y));      // (lx, ly, lc, fMidSign — ditto)
      vec4 tm = texFetch(ivec2(sL.x + 3, sL.y));      // (mx, my, mc, maxDev)
      vec4 tt = texFetch(ivec2(sL.x + 4, sL.y));      // (t0.xy, t1.xy)
      vec4 tp = texFetch(ivec2(sL.x + 5, sL.y));      // (P1.xy, P2.xy) raw control points
      float kk = tk.x * c.x + tk.y * c.y + tk.z;
      float ll = tl.x * c.x + tl.y * c.y + tl.z;
      float mm = tm.x * c.x + tm.y * c.y + tm.z;
      f = kk * kk * kk - ll * mm;
      gEm = 3.0 * kk * kk * tk.xy - ll * tm.xy - mm * tl.xy;
      luneAdd = tk.w; fRegionSgn = tl.w; maxDev = tm.w;
      tv0 = tt.xy; tv1 = tt.zw;
      // WINDING. luneAdd == 0 is the encoder saying "the cheap lune is NOT exact for this piece —
      // wind it with the exact ray crossing", and such a piece carries its control points in a 6th
      // texel. The others keep the chord + lune above, which the encoder has certified.
      //
      // What the encoder is certifying against: the lune term decides "is the pixel between the
      // chord and the curve" from the implicit's sign inside a chord slab, and a Bézier's implicit
      // does not stop at its endpoints — it is the whole algebraic cubic. Where the curve's own
      // t<0 / t>1 extension curls back through that slab, the sign flips a SECOND time and reads
      // "inside" again on the far side of the curve, so the lune fires OUTSIDE the lune and adds a
      // phantom ±1 — a flipped region, not a shading error. (The quad's lune has no such problem
      // because it is gated on the control TRIANGLE, which a parabola's extension exits and never
      // re-enters. A cubic's extension re-enters even the control hull, so no cheap region bounds
      // it — hence a build-time certificate rather than a runtime guard.) On the tiger this was 344
      // of 2326 pieces, and 490 of the 520 pixels where the tree disagreed with the band walk.
      if (luneAdd == 0.0) {
        vec4 tp = texFetch(ivec2(sL.x + 5, sL.y));     // (P1.xy, P2.xy) raw control points
        vec2 Q1 = tp.xy, Q2 = tp.zw;
        float ylo = min(min(E0.y, Q1.y), min(Q2.y, E1.y));   // curve ⊂ control hull: a free reject
        float yhi = max(max(E0.y, Q1.y), max(Q2.y, E1.y));
        float xhi = max(max(E0.x, Q1.x), max(Q2.x, E1.x));
        wSeg = (c.y >= ylo && c.y <= yhi && c.x <= xhi)
             ? hardCrossCubic(c, vec4(E0, Q1) - vec4(c, c), vec4(Q2, E1) - vec4(c, c))
             : 0.0;
      }
    } else {
      vec4 tc = texFetch(ivec2(sL.x + 1, sL.y));      // (cx, cy, rx, ry)
      vec4 tr = texFetch(ivec2(sL.x + 2, sL.y));      // (cos phi, sin phi, luneAdd, maxDev)
      vec4 tt = texFetch(ivec2(sL.x + 3, sL.y));      // (t0.xy, t1.xy)
      // DEGENERATE ARC (a radius ~0 — a flat ellipse morphing "from flat"): the ellipse collapses
      // ONTO its chord, so the implicit below would divide by zero. It IS its chord, so wind it as
      // the chord (wSeg already holds that crossing) and take the chord line as the coverage plane,
      // exactly like a type-0 line — no lune, since there is no arc-vs-chord bulge.
      if (min(tc.z, tc.w) <= 1e-4 * max(max(tc.z, tc.w), 1e-9)) {
        vec2 nrm = vec2(-chord.y, chord.x) / cl;      // leftPerp(chord), unit (em)
        f = dot(nrm, c - E0);
        gEm = nrm;
        luneAdd = 0.0; fRegionSgn = 0.0; maxDev = 0.0;
        tv0 = chord / cl; tv1 = chord / cl;
      } else {
        vec2 rel = c - tc.xy;
        vec2 q = vec2(tr.x * rel.x + tr.y * rel.y, -tr.y * rel.x + tr.x * rel.y);   // R(-phi)
        vec2 qq = q / tc.zw;
        f = dot(qq, qq) - 1.0;                        // < 0 between chord and arc (inside)
        vec2 gq = 2.0 * qq / tc.zw;
        gEm = vec2(tr.x * gq.x - tr.y * gq.y, tr.y * gq.x + tr.x * gq.y);           // R(+phi)
        luneAdd = tr.z; fRegionSgn = -1.0; maxDev = tr.w;
        tv0 = tt.xy; tv1 = tt.zw;
      }
    }
    // LUNE: strictly between chord and curve — ±1. Runs for arcs (whose far arm is a whole minor
    // axis away, so the slab guard provably cannot reach it) and for the cubics the encoder
    // certified. luneAdd == 0 makes it dead for the rest, which were wound exactly above.
    if (tproj > 0.0 && tproj < 1.0 && devS * luneAdd > 0.0 && abs(devS) <= maxDev
        && f * fRegionSgn > 0.0) wSeg += luneAdd;
    float rank = -1.0;
    if (tproj < 0.0 || tproj > 1.0) {
      vec2 V  = tproj < 0.0 ? E0 : E1;
      vec2 tg = tproj < 0.0 ? tv0 : tv1;
      vec2 n = vec2(-tg.y, tg.x);
      f = dot(n, c - V);
      gEm = n;
      rank = length((c - V) * px);
    }
    vec2 gPx = gEm / px;
    float gpx = length(gPx);
    if (gpx < 1e-12) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;
    // SLAB-AWARE rank: the implicit is GLOBAL (the whole ellipse / the cubic's full branch),
    // so a pixel near a DIFFERENT part of the curve can pass the chord-span test with a tiny
    // |f| and claim this piece with an inverted travel frame (capsule arc pixels near the
    // line seam claimed the OPPOSITE quarter's piece — hard holes). The piece itself lies
    // within its chord slab, so |devS| - maxDev is a true lower bound on the distance.
    float slabPx = (abs(devS) - maxDev) / max(min(1.0 / px.x, 1.0 / px.y), 1e-12);
    if (rank < 0.0) cand.dpx = max(dPlane, slabPx);
    vec2 tvq = vec2(gEm.y, -gEm.x);
    if (dot(tvq, chord) < 0.0) tvq = -tvq;
    cand.tv = normalize(tvq);
    float fillSgn = sigma * ((cand.tv.x * gEm.y - cand.tv.y * gEm.x) >= 0.0 ? 1.0 : -1.0);
    cand.nf = fillSgn * gPx / gpx;
    cand.sFill = fillSgn * f / gpx;
    if (tproj < 0.1) { cand.endNear = -1.0; cand.V = E0; }
    else if (tproj > 0.9) { cand.endNear = 1.0; cand.V = E1; }
    return wSeg;
  }
  return 0.0;
}

// Cusp/loop cubic pieces (type 6) wind with the EXACT cubic +x ray-crossing — same convention as
// gwnCross's chord crossings — handled in renderFillGWNSDF's leaf loop, not gwnSegEval (keeps that
// hot function's codegen untouched). Defined below with the other hard-band crossers.
float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);

float renderFillGWNSDF(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1, bandsX = GD.z + 1;
  vec4 hdr = bFetch(bLoc(gl, (bandsY + bandsX) * 2));
  int nodeBase = int(hdr.x), nodeCount = int(abs(hdr.y)), refBase = int(hdr.z);
  float sigma = hdr.y >= 0.0 ? 1.0 : -1.0;            // content handedness (+1 = ink left of travel)
  if (nodeCount <= 0) return 0.0;

  vec2 emPerPx = 1.0 / max(px, vec2(1e-6));
  float cellR = 0.70710678 * max(emPerPx.x, emPerPx.y);
  vec4 ext = bFetch(bLoc(gl, refBase + int(hdr.w)));  // (rootBandBase, GB, gridBase, gridWH)

#ifndef MANTLE_GWN_NOEXIT
  // TIER 3 — OCCUPANCY GATE. The encoder certified: every point of this cell is at least
  // `margin` from the boundary. If margin exceeds the pixel's cell radius, the full walk
  // below would find no candidate inside the AA window and return folded 0/1 — so return it
  // from ONE fetch. (Winding was computed on the certified polyline, exact by homotopy.)
  int gridBase = int(ext.z);
  if (gridBase > 0) {
    int gwh = int(ext.w);
    int GW = gwh / 256, GH = gwh - (gwh / 256) * 256;
    vec2 bbSz = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
    vec2 g = (c - shapeBB.xy) / bbSz * vec2(float(GW), float(GH));
    int gx = int(floor(g.x)), gy = int(floor(g.y));
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) {
      int ci = gy * GW + gx;
      vec4 cell = bFetch(bLoc(gl, gridBase + ci / 2));
      vec2 wm = ci - (ci / 2) * 2 == 0 ? cell.xy : cell.zw;
      if (wm.y > cellR) {
        float awg = abs(wm.x);
        if (!evenOdd) return step(0.5, awg);
        float mg = mod(awg, 2.0);
        return (mg >= 0.5 && mg < 1.5) ? 1.0 : 0.0;
      }
    }
  }
#endif

  float w = 0.0;
  GwnSdfCand c1, c2;                                  // two nearest candidates, distinct segments
  c1.dpx = 1e30; c1.sFill = 0.0; c1.nf = vec2(0.0); c1.tv = vec2(0.0); c1.endNear = 0.0; c1.V = vec2(0.0);
  c2 = c1;

  // TIER 2 — the Slug band early-exit, transplanted onto the tree. The winding is a +x-ray
  // crossing count and every contribution of a cut subtree (chords, lunes, curve geometry)
  // lies inside its circle, so a subtree whose circle misses the pixel's row or sits left of
  // it contributes EXACTLY zero. Entries are y-banded and sorted by descending maxX: break at
  // the first entry past the pixel (dilated by cellR so AA candidates survive). A pixel
  // within cellR of a band edge walks the neighbor band too, skipping entries the primary
  // already saw (encode-time adjacency flags — no f32 re-derivation of band membership).
  int GB = 0, byP = 0, nbB = -1, rbBase = 0;
#ifndef MANTLE_GWN_NOEXIT
  GB = int(ext.y); rbBase = int(ext.x);
  if (GB > 0) {
    float bandH = max(shapeBB.w - shapeBB.y, 1e-6) / float(GB);
    if (bandH <= 2.0 * cellR) { GB = 0; }             // shape only a few px tall: bands invalid
    else {
      byP = clamp(int((c.y - shapeBB.y) / bandH), 0, GB - 1);
      float yloc = c.y - shapeBB.y - float(byP) * bandH;
      if (yloc < cellR && byP > 0) nbB = byP - 1;
      else if (bandH - yloc < cellR && byP < GB - 1) nbB = byP + 1;
    }
  }
#endif

  for (int pass = 0; pass < 2; pass++) {
    int eBase = 0, eCount = 1;                        // unbanded: one pseudo-entry, the root
    if (GB > 0) {
      int bandIdx = pass == 0 ? byP : nbB;
      vec4 bh = bFetch(bLoc(gl, rbBase + bandIdx / 2));
      vec2 bc = bandIdx - (bandIdx / 2) * 2 == 0 ? bh.xy : bh.zw;
      eBase = int(bc.x); eCount = int(bc.y);
    }
    for (int ei = 0; ei < 4096; ei++) {
      if (ei >= eCount) break;
      int rootI = 0;
      if (GB > 0) {
        vec4 E = bFetch(bLoc(gl, eBase + ei));        // (ni*4 + adjFlags, maxX, y0, y1)
        if (E.y < c.x - cellR) break;                 // sorted desc: THE early exit
        if (c.y < E.z - cellR || c.y > E.w + cellR) continue;   // row cull, entry level
        int ex = int(E.x);
        rootI = ex / 4;
        int fl = ex - rootI * 4;
        if (pass == 1 && ((nbB < byP && fl - (fl / 2) * 2 == 1) || (nbB > byP && fl >= 2)))
          continue;                                   // neighbor pass: already walked in primary
      }
      // STACKLESS preorder descent of the subtree [rootI, escape(rootI)): a near internal
      // node steps to ni+1 (its left child, by preorder), far/leaf jumps the escape link.
      int ni = rootI, sEnd = rootI + 1;
      for (int guard = 0; guard < 4096; guard++) {
        if (ni >= sEnd) break;
        int base = nodeBase + ni * 2;                 // 2-texel nodes: chord + (circle, code)
        vec4 A = bFetch(bLoc(gl, base));
        vec4 B = bFetch(bLoc(gl, base + 1));
        vec2 dcv = c - B.xy;
        float rr = B.z + cellR;
        // FAR: the node's chord stands in for its whole contiguous run, and because every
        // contour's runs chain into a CLOSED polygon (per-contour subtrees; container nodes
        // carry a degenerate chord), the winding is a pure RAY-CROSSING COUNT over that
        // adaptive simplified polygon — one sign test, no trig anywhere in this kernel.
        // TIER 1: the chord's crossing is provably zero unless the circle straddles the
        // pixel's row AND reaches right of it — skip even the sign test.
        if (dot(dcv, dcv) > rr * rr) {
          if (abs(dcv.y) <= B.z && B.x + B.z > c.x) w += gwnCross(A.xy - c, A.zw - c);
          ni = B.w >= 0.0 ? int(B.w) : ni + 1;
          continue;
        }
        if (B.w < 0.0) {
          // NEAR leaf (code = -(refStart*64 + refCount + 1)): per-segment chord-polygon edges +
          // lune terms, riding the same fetches and barycentric work the SDF candidates do.
          int v = int(-B.w) - 1;
          int rc = v - (v / 64) * 64, rs = v / 64;
          for (int k = 0; k < 32; k++) {
            if (k >= rc) break;
            vec4 R = bFetch(bLoc(gl, refBase + rs + k));
            GwnSdfCand cd;
            // INK SIDE from the ENCODER (R.w), not from the shape's shoelace majority. The build
            // derives each contour's ink side exactly — the winding the OTHER contours contribute
            // at a point on it, plus one if it is CCW, run through the fill rule — so a hole wound
            // like its outer (which is what an even-odd hole IS) gets the right sign, and so do
            // CORNERS, where no runtime rule can decide it.
            //
            // R.w == 0 means the contour is NOT A BOUNDARY: both of its sides are filled (a contour
            // wound like its parent under nonzero, winding 1 → 2). It still contributes winding —
            // that is what makes the inside 2 — but it must paint no coverage ramp, or a seam runs
            // through the middle of a solid shape. So: no SDF candidate from it.
            float sgP = R.w;
            w += gwnSegEval(c, px, ivec2(int(R.x), int(R.y)), int(R.z), sgP == 0.0 ? 1.0 : sgP, cd);
#ifndef GWN_WINDING_ONLY
            if (sgP != 0.0) {                            // not-a-boundary ⇒ winding only, no ramp
              if (cd.dpx < c1.dpx) { c2 = c1; c1 = cd; }
              else if (cd.dpx < c2.dpx) { c2 = cd; }
            }
#endif
          }
          ni++;
          continue;
        }
        if (ni == rootI) sEnd = int(B.w);             // near-internal root: bound = its escape
        ni++;
      }
      if (GB <= 0) break;
    }
    if (GB <= 0 || nbB < 0) break;
  }
  float aw = abs(w);
  float inside = evenOdd ? ((mod(aw, 2.0) >= 0.5 && mod(aw, 2.0) < 1.5) ? 1.0 : 0.0) : step(0.5, aw);
#ifdef GWN_WINDING_ONLY
// Tree-hard uses the same traversal without coverage integration.
  return inside;
#endif
  if (c1.dpx > 0.70710678) return inside;             // no edge can cut this cell
  // ORIENT FROM THE PIXEL'S OWN WINDING, not from travel handedness.
  //
  // sFill is signed by "ink is left of travel". That is a contour invariant only when a shape's
  // contours are wound CONSISTENTLY (outer one way, holes the other). An even-odd ring's inner
  // circle is wound the SAME way as its outer — that is precisely what makes it a hole by PARITY
  // rather than by winding — so for that contour ink is on the right, sFill's sign is inverted,
  // and the ramp runs backwards: a white seam line inside the ink, and stipple wherever the
  // inverted ramp crosses a neighbouring one.
  //
  // The winding at the pixel CENTRE is already computed exactly above (`inside`), and it settles
  // the question with no assumption at all: the fill half-plane contains the centre iff the centre
  // is inside. Negating BOTH n and d keeps the same LINE and swaps which side is covered.
  // sFill is signed by the ENCODER's per-contour ink side (R.w), which is exact — for holes, for
  // even-odd, and for CORNERS, where no runtime rule can decide it (at a convex tip the pixel
  // centre can be on the ink side of one plane and still be outside the ink).
  //
  // The centre-winding flip below is kept ON TOP of it, for SINGLE-EDGE pixels only, and it is not
  // redundant: with the encoder's signs verified correct on a holed shape, removing it still
  // regressed that shape (0.135 → 0.317 mean error, 0 → 33 non-monotone crossings). So gwnSegEval
  // derives sFill's sign PER PIECE TYPE and gets it wrong for at least one of them, independently
  // of sigma — a separate bug this masks. Ledgered, not papered over: it wants its own audit of the
  // per-type fill-sign derivations (the `fillSgn` lines in gwnSegEval).
  bool single = c2.dpx > 0.70710678;
  float f1 = (single && ((c1.sFill >= 0.0) != (inside > 0.5))) ? -1.0 : 1.0;
  float cA = exactBoxCov(-c1.nf * f1, c1.sFill * f1);
  if (single) return cA;                              // single-edge pixel: done
  // TWO-EDGE PIXEL (corner, or a seam where both neighbours reach). Chained combine, the LB
  // kind-10 rules: intersection for convex, union for reflex, blending to min/max as the two
  // planes become parallel (kp -> 1: a tangent-continuous seam degrades to the single-plane
  // answer instead of double-counting one boundary).
  float cB = exactBoxCov(-c2.nf, c2.sFill);
  // CORNER TYPE from the polyline: when the two candidates meet at a shared endpoint, the
  // turn cross vs the content handedness names it (ink left of travel: left turn pinches a
  // CONVEX ink wedge, right turn opens a REFLEX one). The centre-sign heuristic cannot tell
  // these apart — a reflex-notch pixel with its centre outside both fills read
  // "intersection" and lost the ink the union carries.
  bool reflex = false;
  bool corner = c1.endNear != 0.0 && c2.endNear != 0.0 && c1.endNear != c2.endNear;
  if (corner) {
    vec2 dV = (c1.V - c2.V) * px;
    corner = dot(dV, dV) < 0.01;
    if (corner) {
      vec2 tIn = c1.endNear > 0.0 ? c1.tv : c2.tv;
      vec2 tOut = c1.endNear > 0.0 ? c2.tv : c1.tv;
      float turn = tIn.x * tOut.y - tIn.y * tOut.x;
      reflex = turn * sigma < 0.0;
    }
  }
  if (!corner) reflex = (c1.sFill > 0.0) != (c2.sFill > 0.0) && inside > 0.5;   // non-adjacent fallback
  float inter = gwnBoxCov2(-c1.nf, c1.sFill, -c2.nf, c2.sFill);     // exact area(A ∩ B ∩ box)
  return reflex ? (cA + cB - inter) : inter;                        // union by inclusion-exclusion
}
// GWN run-tree kernel (excluded from band-only MIXED).
#endif

// ---------------------------------------------------------------------------
// NO-AA fill over the BANDS (the Slug/AAC data structure). For an OPAQUE, UNDASHED stroked shape
// the stroke covers the fill's 1px boundary band, so the fill needs only inside/outside — a
// containment test, no anti-aliasing. Cheapest the band structure can answer it: a horizontal ray
// from the pixel, counting signed crossings of the band's segments. (NOT the GWN subtended-ANGLE
// winding of gwnSegEval — that only telescopes over the WHOLE contour; a ray crossing is
// per-segment-local and so is correct over the single band at c.y.) LINE + QUAD.
// Line crossing at y = c.y: root t of the linear y, add sign(dy) if the crossing x > c.x.
float hardCrossLine(vec2 c, vec2 A, vec2 B) {
  float dy = B.y - A.y;
  if (abs(dy) < 1e-30) return 0.0;
  float t = (c.y - A.y) / dy;
  if (t < 0.0 || t >= 1.0) return 0.0;
  float x = A.x + t * (B.x - A.x);
  return (x > c.x) ? (dy > 0.0 ? 1.0 : -1.0) : 0.0;
}
// Quad crossing: roots of y(t) = c.y, B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2.
float hardCrossQuad(vec2 c, vec2 P0, vec2 P1, vec2 P2) {
  float a = P0.y - 2.0 * P1.y + P2.y;
  float b = 2.0 * (P1.y - P0.y);
  float cc = P0.y - c.y;
  float w = 0.0;
  float ax = P0.x - 2.0 * P1.x + P2.x, bx = 2.0 * (P1.x - P0.x);
  if (abs(a) < 1e-20) {                                 // linear
    if (abs(b) < 1e-30) return 0.0;
    float t = -cc / b;
    if (t >= 0.0 && t < 1.0) { float x = ax * t * t + bx * t + P0.x;
      if (x > c.x) w += (b > 0.0 ? 1.0 : -1.0); }       // dy/dt = b (a=0)
    return w;
  }
  float disc = b * b - 4.0 * a * cc;
  if (disc < 0.0) return 0.0;
  float sd = sqrt(disc);
  for (int r = 0; r < 2; r++) {
    float t = (r == 0 ? (-b + sd) : (-b - sd)) / (2.0 * a);
    if (t < 0.0 || t >= 1.0) continue;
    float x = ax * t * t + bx * t + P0.x;
    if (x <= c.x) continue;
    float dydt = 2.0 * a * t + b;
    w += dydt > 0.0 ? 1.0 : -1.0;
  }
  return w;
}
// Cubic crossing: reuse Slug's exact H-ray solver (solveCubicBisect), take the +x crossings.
// p12/p34 are the control points CENTERED on c, exactly as Slug's H-CUBIC walker feeds them.
// rs[j] is the x-intercept relative to c (em); a +x ray counts it iff rs[j] > 0. No box filter.
// SIGN: +1 for an UPWARD crossing (dY/dt > 0), matching hardCrossLine/hardCrossQuad/gwnCross so
// this composes with them in one shape's fold. (Cubics historically routed only to the tree, so
// this band/tree crossing sign was latent — the tree's type-6 cusp pieces and any vetoed cubic
// band shape are the first real consumers; both need the +up convention.)
float hardCrossCubic(vec2 c, vec4 p12, vec4 p34) {
  vec3 rs, ts;
  solveCubicBisect(p12, p34, false, rs, ts);
  vec4 cy = cubicCoeff(p12.y, p12.w, p34.y, p34.w);
  float w = 0.0;
  for (int j = 0; j < 3; j++) {
    if (ts[j] < 0.0 || ts[j] >= 1.0 || rs[j] >= 1e10 || rs[j] != rs[j]) continue;
    if (rs[j] <= 0.0) continue;                         // crossing must be at x > c.x
    w += (evalCD(cy, ts[j]) > 0.0) ? 1.0 : -1.0;        // dY/dt > 0 => upward crossing => +1
  }
  return w;
}
// Arc crossing: same solve as Slug's H-ARC walker (A sin + B cos = C), +x crossings only.
// d1 = (cx, cy, rx, ry), d2 = (thetaStart, thetaEnd, phi, _).
float hardCrossArc(vec2 c, vec4 d1, vec4 d2) {
  float sp = sin(d2.z), cp = cos(d2.z);
  float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
  float Rlen = sqrt(A * A + B * B);
  if (Rlen <= 1e-10) return 0.0;
  float ratio = C / Rlen;
  if (abs(ratio) >= 0.99999) return 0.0;
  float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
  float ang = atan(B, A), b2 = acos(clamp(ratio, -1.0, 1.0));
  float w = 0.0;
  for (int k = 0; k < 2; k++) {
    float th = (k == 0) ? (ang + b2) : (ang - b2);
    if (!arcInRange(th, d2.x, d2.y)) continue;
    vec2 pnt; float ddx, ddy; arcSample(d1, cp, sp, th, pnt, ddx, ddy);
    if (pnt.x <= c.x) continue;                          // +x crossing only
    w += arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
  }
  return w;
}

float renderFillHardBand(vec2 c, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));
  int by = clamp(int((c.y - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int hdr = by * 2;
  vec4 cnts = bFetch(bLoc(gl, hdr));
  int nLine = int(cnts.x), nQuad = int(cnts.y);
  int arrIdx = int(bFetch(bLoc(gl, hdr + 1)).x);
  float w = 0.0;
  int hOff = 0;
  // BREAK-EARLY PRUNE (the same one Slug/AAC use): band entries carry .z = the segment's maxX,
  // sorted DESCENDING. A +x ray from the pixel counts crossings at x > c.x, so a segment whose
  // maxX < c.x cannot contribute, and neither can any later (smaller-maxX) one — stop. Exact here,
  // with no AA margin: the box-filter versions need `.z - c.x < -halfPx`; a hard crossing needs
  // only `.z < c.x`.
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < 1024; i++) {
    if (i >= nLine) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    w += hardCrossLine(c, pe.xy, pe.zw);
  }
#endif
  hOff += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < 1024; i++) {
    if (i >= nQuad) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 p3 = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    w += hardCrossQuad(c, p12.xy, p12.zw, p3);
  }
#endif
  hOff += nQuad;
#ifndef MANTLE_NO_CUBIC
  int nCubic = int(cnts.z);
  for (int i = 0; i < 1024; i++) {
    if (i >= nCubic) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    vec4 p12 = texFetch(dL) - vec4(c, c);
    vec4 p34 = texFetch(ivec2(dL.x + 1, dL.y)) - vec4(c, c);
    w += hardCrossCubic(c, p12, p34);
  }
  hOff += nCubic;
#else
  hOff += int(cnts.z);
#endif
#ifndef MANTLE_NO_ARC
  int nArc = int(cnts.w);
  for (int i = 0; i < 1024; i++) {
    if (i >= nArc) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y < c.x) break;
    ivec2 sL = segLocXY(segRaw.x);
    ivec2 dL = ivec2(sL.x + 1, sL.y);
    w += hardCrossArc(c, texFetch(dL), texFetch(ivec2(dL.x + 1, dL.y)));
  }
#endif
  float aw = abs(w);
  if (!evenOdd) return step(0.5, aw);
  float m = mod(aw, 2.0);
  return (m >= 0.5 && m < 1.5) ? 1.0 : 0.0;
}

// (renderFillGWN removed: tree-hard now shares renderFillGWNSDF's traversal via
// MANTLE_GWN_WINDING_ONLY — all tiers, trig-free chords, and cubic/arc pieces.)
#endif

#ifdef MANTLE_AAC
// ============================================================================
// AAC — Analytic Area Coverage. Exact per-pixel signed AREA of the shape within
// the pixel cell, decoded from the SAME curve buffer + H-bands the Slug walk
// uses. Unlike Slug's dual-ray box filter, coverage is the TRUE covered area
// (conflation-free: signed area summed BEFORE the winding fold), so AA is exact
// — this is the CPU twin `meshFreeRaster.js` running on the GPU. One H-band walk,
// no V-ray, no H/V combine. LINE, QUAD, CUBIC and ARC segments are each handled
// natively (aacLineContrib / aacQuadContrib / aacCubicContrib / aacArcContrib) —
// nothing is flattened or degree-elevated. The accumulator is AGG/font-rs's signed
// area + cover; a curve's in-cell area is the closed-form integral of the arc
// clipped to the cell (Manson-Schaefer polynomial filters). See PROVENANCE.md 1a.
//
// Pixel cell = the 1px square centered on em-point c. Work in pixel-LOCAL coords
// where the cell is [0,1]^2: Xl = (x-c.x)*px.x + 0.5, Yl = (y-c.y)*px.y + 0.5.
//
// REVERSED integrand (enables the break-early prune — see renderFillAAC):
//   clamp(1-Xl,0,1) ≡ 1 - clamp(Xl,0,1)          [check Xl<0, Xl∈[0,1], Xl>1]
// so, writing D(S) = ∫_{Yl∈[0,1]} dYl = clamp(Yl_end,0,1) - clamp(Yl_start,0,1)
// (a pure function of the segment ENDPOINTS — the integral of a differential of
// a function of t, so it holds for curves too),
//   Σ_seg ∫ clamp(1-Xl)·dYl  =  Σ_seg D(S)  -  Σ_seg ∫ clamp(Xl)·dYl
// and Σ_seg D(S) TELESCOPES TO ZERO around any closed contour. Hence
//   run = -Σ_seg ∫_{Yl∈[0,1]} clamp(Xl,0,1)·dYl        (exactly, not approx)
// and Coverage = fold(run). Verified to machine epsilon
// (|Σ D| == 0 bit-exact, |I1+I2-D| < 1e-13).
//
// Why bother: under clamp(Xl) a segment entirely LEFT of the cell contributes
// exactly ZERO (clamp = 0) rather than a full dYl. Left-of-cell is precisely the
// suffix of Slug's maxX-descending segment order, so the walker can BREAK there.
// (Under the old clamp(1-Xl) form it was the RIGHT-of-cell segments that
// vanished, and those are scattered through the list — nothing to break on.)
//
// Each *Contrib below returns the RUN-convention value (= -∫clamp(Xl)dYl), so
// the accumulation in renderFillAAC is unchanged.

// em → pixel-local (cell [0,1]^2 centered on c).
//
// Do NOT "hoist" this to the algebraically equal p*px + (0.5 - c*px). It looks
// like a free win (the bracket is loop-invariant, and this runs 4x per cubic per
// fragment) but it SUBTRACTS AFTER SCALING, and aacCubicContrib depends on exact
// cancellation: for a symmetric cubic the control differences come out exactly
// (-d, 0, d), so a = d0-2·d1+d2 is exactly 0 and the y-extrema solver takes its
// degenerate-linear branch. Round each term separately and a becomes ~1e-5, the
// quadratic branch runs, its roots fall outside (0,1), the extremum is never
// found, and the piece handed to the exact integral is not y-monotone — a winding
// miscount, not a rounding wobble. Measured: interior off by 204/255 on the
// parity smoke's cubic blob. Subtract first.
vec2 aacPL(vec2 emPt, vec2 c, vec2 px) { return (emPt - c) * px + 0.5; }

// --- Coefficient (monomial) form + Horner ------------------------------------
//
// The Bernstein form recomputes powers of (1-t) and t on every evaluation. Convert
// once per segment per lane into the coefficient form the SLUG walker already uses
// (cubicCoeff / evalC / evalCD, in _curveArcLen.glsl; descending, .x=a3 … .w=a0),
// after which every eval is 3 FMA and every derivative 2. That matters because the
// cubic root solve runs Newton iterations, each needing one eval AND one
// derivative, and a single y-monotone piece can need up to four solves (two to
// clip in y, two for the Xl=0 / Xl=1 walls).
//
// A quadratic is a cubic with a3 == 0, so this also COLLAPSES the quad and cubic
// paths into one function — the old `typ` parameter disappears entirely.
//
// PRECISION: cubicCoeff's a3 = -p1+3p2-3p3+p4 preserves the exact cancellation the
// degenerate-branch detection depends on (a symmetric cubic yields a3 == 0 bit
// exactly, so the y-extremum is found by the linear branch). See aacPL for the
// superficially similar "hoist" that destroys this and silently miscounts winding.
vec4 aacQuadCoeff(float p1, float p2, float p3) {
  return vec4(0.0, (p1 - p2) + (p3 - p2), 2.0 * (p2 - p1), p1);
}

// Cubic coefficients, FMA-SAFE. Do NOT use the shared cubicCoeff() here, which
// spells a3 as -p1 + 3·p2 - 3·p3 + p4. The compiler is free to contract that into
// fused multiply-adds, and it does: `3.0*p2` and `3.0*p3` end up rounded
// differently, so a curve with p2 == p3 and p1 == p4 — a symmetric cubic, whose a3
// is EXACTLY zero — comes out with a ~1e-5 residual instead. The degenerate-branch
// test then misses, the y-extremum is never found, the piece handed to the exact
// integral is not y-monotone, and the winding miscounts. (Slug survives the same
// expression only because its degeneracy threshold is 1/65536 ≈ 1.5e-5, which
// happens to swallow the residual. Ours must be tighter, so spell it safely.)
//
// Grouping the differences first makes the cancellation exact under contraction:
// p2 == p3 ⇒ (p2-p3) == 0, p1 == p4 ⇒ (p4-p1) == 0, so a3 == fma(3, 0, 0) == 0.
vec4 aacCubicCoeff(float p1, float p2, float p3, float p4) {
  return vec4((p4 - p1) + 3.0 * (p2 - p3),      // a3
              3.0 * ((p1 - p2) + (p3 - p2)),    // a2 = 3(p1 - 2p2 + p3)
              3.0 * (p2 - p1),                  // a1
              p1);                              // a0
}

// Roots of qa·t² + qb·t + qc, ascending, 1e9 for "absent".
// Uses the stable pair (q/qa, qc/q) with q = -(qb + sign(qb)·√disc)/2, so the
// small root comes from a division rather than a cancelling subtraction. This
// also degrades gracefully to the LINEAR root when qa == 0 (then q == -qb and
// qc/q == -qc/qb), which is what a quad — or a cubic whose a3 vanished — needs.
vec2 aacQuadRoots(float qa, float qb, float qc) {
  float disc = qb * qb - 4.0 * qa * qc;
  if (disc <= 0.0) return vec2(1e9);
  float sq = sqrt(disc);
  float q  = -0.5 * (qb + (qb < 0.0 ? -sq : sq));
  float r1 = (abs(qa) > 1e-30) ? q / qa : 1e9;
  float r2 = (abs(q)  > 1e-30) ? qc / q  : 1e9;
  return vec2(min(r1, r2), max(r1, r2));
}

// Degeneracy threshold. Float32-scaled, matching the 1.0/65536.0 the Slug solvers
// use — a 1e-9 test never fires at these magnitudes in float and would leave the
// near-zero divide in place.
#define AAC_EPS (1.0 / 65536.0)
// 6, not 8. Each iteration costs one eval AND one derivative, and a y-monotone
// piece can need four solves. Swept on the GPU against the parity smoke: 4 is too
// few (cubic mean error 0.132/255, max 85), 5 is marginal (0.049), and 6 already
// matches 8 exactly on mean and max (0.041 / 25). Worth ~6% on cubic draws.
//
// Do not infer the count from a synthetic root-solve benchmark: in float32 the
// root error plateaus by iteration 3 on narrow brackets, but the shader solves
// across a FULL monotone piece where the secant seed can start far away.
#define AAC_NEWTON 6

// Solve C(t) = V on a MONOTONE bracket [ta,tb], coefficient form.
//
//  a3 == 0 → the polynomial IS a quadratic: closed form, using the stable root
//            pair (q/qa, qc/q) rather than the naive (-b±√disc)/2a, which loses
//            precision to cancellation when qb² >> 4·qa·qc. Tested for exact zero,
//            not "small": a nearly-cubic a3 must still go to Newton or its root
//            would be wrong.
//  else    → CLAMPED NEWTON, the solver the Slug walker uses (solveCubicBisect):
//            step, then clamp straight back into the bracket. Quadratic
//            convergence to ~1e-7; the clamp keeps it bounded near critical
//            points. Seeded by the secant through the bracket ends.
//
// Do NOT "improve" this by shrinking the bracket each step and bisecting when the
// Newton step leaves it: once converged, tn == t == a bracket endpoint, a strict
// interior test rejects the CORRECT root, and the midpoint of a bracket that only
// ever shrank from one side is nowhere near it — a silent winding miscount.
float aacSolveC(vec4 C, float ta, float tb, float V) {
  float lo = min(ta, tb), hi = max(ta, tb);
  if (abs(C.x) < 1e-12) {                       // exactly quadratic (or lower)
    float qa = C.y, qb = C.z, qc = C.w - V;
    if (abs(qa) < AAC_EPS)                      // degenerate: linear in t
      return clamp(abs(qb) > AAC_EPS ? -qc / qb : lo, lo, hi);
    float sq = sqrt(max(qb * qb - 4.0 * qa * qc, 0.0));
    float q  = -0.5 * (qb + (qb < 0.0 ? -sq : sq));
    float r1 = q / qa;
    float r2 = abs(q) > AAC_EPS ? qc / q : r1;
    float t  = (r1 >= lo - 1e-4 && r1 <= hi + 1e-4) ? r1 : r2;   // the in-bracket root
    return clamp(t, lo, hi);
  }
#ifdef MANTLE_NO_CUBIC
  return 0.5 * (lo + hi);   // unreachable: no cubic segments in this bundle
#else
  float fa = evalC(C, lo) - V, fb = evalC(C, hi) - V, den = fb - fa;
  float t = (abs(den) > AAC_EPS) ? clamp(lo - fa * (hi - lo) / den, lo, hi)   // secant seed
                                 : 0.5 * (lo + hi);
  for (int k = 0; k < AAC_NEWTON; k++) {
    float f = evalC(C, t) - V;
    float d = evalCD(C, t);
    if (abs(d) < 1e-12) break;
    t = clamp(t - f / d, lo, hi);
  }
  return t;
#endif
}

// EXPLICIT ANTIDERIVATIVE of x(t)·y'(t).
//
// x is degree 3 and y' degree 2, so the product is degree 5 and its antiderivative
// is degree 6 — Horner-evaluable in 6 FMA. This replaces a 3-point Gauss-Legendre
// rule which was ALSO exact for degree 5, but cost 3 evals + 3 derivatives (~21
// FMA) per zone. The coefficients depend only on the segment, so the caller builds
// them once and reuses them across every zone of every monotone piece.
// Returned as two vec3 rather than via `out` params — no reason to make the
// translator copy-out when the caller wants both halves anyway.
vec3 aacAntiF0(vec4 CX, vec4 CY) {
  float a0 = CX.w, a1 = CX.z, a2 = CX.y;
  float e0 = CY.z, e1 = 2.0 * CY.y, e2 = 3.0 * CY.x;     // y'(t) = e0 + e1·t + e2·t²
  return vec3(a0 * e0,
              (a0 * e1 + a1 * e0) * 0.5,
              (a0 * e2 + a1 * e1 + a2 * e0) / 3.0);      // ∫ t^k = t^(k+1)/(k+1)
}
vec3 aacAntiF1(vec4 CX, vec4 CY) {
  float a1 = CX.z, a2 = CX.y, a3 = CX.x;
  float e0 = CY.z, e1 = 2.0 * CY.y, e2 = 3.0 * CY.x;
  return vec3((a1 * e2 + a2 * e1 + a3 * e0) * 0.25,
              (a2 * e2 + a3 * e1) * 0.2,
              (a3 * e2) / 6.0);
}
float aacAnti(vec3 F0, vec3 F1, float t) {
  return t * (F0.x + t * (F0.y + t * (F0.z + t * (F1.x + t * (F1.y + t * F1.z)))));
}

// One zone on which clamp(Xl) has a SINGLE analytic form (no wall crossing inside).
// Classify by the midpoint x, then integrate ∫clamp(x)·y' dt in closed form:
//   x ≤ 0 → clamp is 0 → 0
//   x ≥ 1 → clamp is 1 → ∫y' dt = Δy  (endpoints only)
//   else  → clamp is x → F(b) - F(a), exact
float aacZoneI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float a, float b) {
  if (b - a < 1e-12) return 0.0;
  float xm = evalC(CX, 0.5 * (a + b));
  if (xm <= 0.0) return 0.0;
  if (xm >= 1.0) return evalC(CY, b) - evalC(CY, a);
  return aacAnti(F0, F1, b) - aacAnti(F0, F1, a);
}

// [a,b] is x-MONOTONE. Split it at the x=0 and x=1 crossings (at most one each, by
// monotonicity), then each zone is closed form. Fast paths first: a zone that never
// leaves [0,1] in x needs no crossing solve at all — the common case.
float aacXMonoI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float a, float b) {
  if (b - a < 1e-12) return 0.0;
  float xa = evalC(CX, a), xb = evalC(CX, b);
  float xlo = min(xa, xb), xhi = max(xa, xb);
  if (xhi <= 0.0) return 0.0;                                    // fully left
  if (xlo >= 1.0) return evalC(CY, b) - evalC(CY, a);            // fully right
  if (xlo >= 0.0 && xhi <= 1.0) return aacAnti(F0, F1, b) - aacAnti(F0, F1, a);
  float c0 = 1e9, c1 = 1e9;
  if (xlo < 0.0 && xhi > 0.0) c0 = aacSolveC(CX, a, b, 0.0);
  if (xlo < 1.0 && xhi > 1.0) c1 = aacSolveC(CX, a, b, 1.0);
  float m0 = min(c0, c1), m1 = max(c0, c1);
  float acc = 0.0, prev = a;
  if (m0 < 1e8) { acc += aacZoneI2(CX, CY, F0, F1, prev, m0); prev = m0; }
  if (m1 < 1e8) { acc += aacZoneI2(CX, CY, F0, F1, prev, m1); prev = m1; }
  return acc + aacZoneI2(CX, CY, F0, F1, prev, b);
}

// EXACT ∫_{u0}^{u1} clamp(Xl,0,1)·dYl for a y-monotone piece already clipped to the
// cell∩stripe window. Split at the x-extrema (x'(t) = 3a3·t² + 2a2·t + a1 = 0) so
// every sub-piece is x-monotone, then aacXMonoI2 handles each in closed form.
float aacExactI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float u0, float u1) {
  vec2 ex = aacQuadRoots(3.0 * CX.x, 2.0 * CX.y, CX.z);   // x'(t) = 3a3·t² + 2a2·t + a1
  float e0 = ex.x, e1 = ex.y;
  float s0 = (e0 > u0 + 1e-7 && e0 < u1 - 1e-7) ? e0 : 1e9;
  float s1 = (e1 > u0 + 1e-7 && e1 < u1 - 1e-7) ? e1 : 1e9;
  if (s1 < s0) { float tmp = s0; s0 = s1; s1 = tmp; }
  float acc = 0.0, prev = u0;
  if (s0 < 1e8) { acc += aacXMonoI2(CX, CY, F0, F1, prev, s0); prev = s0; }
  if (s1 < 1e8) { acc += aacXMonoI2(CX, CY, F0, F1, prev, s1); prev = s1; }
  return acc + aacXMonoI2(CX, CY, F0, F1, prev, u1);
}

// ∫_0^1 clamp((1-s)·w0 + s·w1, 0, 1) ds — BRANCHLESS, one divide.
//
// The clamped-below ramp has a closed form with no case split:
//     ∫_0^1 max(lerp(f0,f1,s), 0) ds  =  (max(f0,0)² − max(f1,0)²) / (2·(f0−f1))
// (both-positive → the mean; both-negative → 0; straddling → the positive
// triangle — all three fall out of the same expression). And since
// clamp(u,0,1) = max(u,0) − max(u−1,0), the two ramps differ only by a shift, so
// they SHARE the denominator: the whole clamped integral is one divide and no
// branches. Replaces a pair of three-way-branchy ramp helpers — worth avoiding
// in the polygon path, where warp divergence costs more than the arithmetic.
// Verified to 1.6e-11 against fine quadrature over 20k random ramps.
//
// The w0 == w1 limit is the constant integrand, clamp(w0,0,1).
float aacClampI(float w0, float w1) {
  float d = w0 - w1;
  if (abs(d) < 1e-9) return clamp(0.5 * (w0 + w1), 0.0, 1.0);
  float a0 = max(w0, 0.0),       a1 = max(w1, 0.0);
  float b0 = max(w0 - 1.0, 0.0), b1 = max(w1 - 1.0, 0.0);
  return ((a0 * a0 - a1 * a1) - (b0 * b0 - b1 * b1)) / (2.0 * d);
}

// One y-monotone sub-interval of a curve. Clip it to the cell∩stripe window in y,
// then integrate EXACTLY. y' carries the winding sign through the integral, so
// there is no separate `inc` factor to keep consistent across the extrema split.
// The y-clip solves only for the ends that actually stick OUT of the window — a
// piece already inside pays no solve at all.
float aacBezMonoContrib(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float ta, float tb, float q0, float q1) {
  float ya = evalC(CY, ta), yb = evalC(CY, tb);
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  float tLo, tHi;
  if (inc) {
    tLo = (ya >= q0) ? ta : aacSolveC(CY, ta, tb, q0);
    tHi = (yb <= q1) ? tb : aacSolveC(CY, ta, tb, q1);
  } else {
    tLo = (yb >= q0) ? tb : aacSolveC(CY, ta, tb, q0);
    tHi = (ya <= q1) ? ta : aacSolveC(CY, ta, tb, q1);
  }
  float u0 = min(tLo, tHi), u1 = max(tLo, tHi);
  if (u1 - u0 < 1e-12) return 0.0;
  return -aacExactI2(CX, CY, F0, F1, u0, u1);   // run-convention: -∫clamp(Xl)dYl
}

// Shared by QUAD and CUBIC (a quad is a cubic with a3 == 0). Split at the
// y-extrema so each piece is y-monotone, which is what the clip and the x-split
// assume. y'(t) = 3a3·t² + 2a2·t + a1.
float aacCurveContrib(vec4 CX, vec4 CY, float q0, float q1) {
  vec3 F0 = aacAntiF0(CX, CY), F1 = aacAntiF1(CX, CY);
  vec2 ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);   // y'(t) = 3a3·t² + 2a2·t + a1
  float s0 = (ey.x > 1e-6 && ey.x < 1.0 - 1e-6) ? ey.x : 2.0;
  float s1 = (ey.y > 1e-6 && ey.y < 1.0 - 1e-6) ? ey.y : 2.0;
  float run = 0.0, prev = 0.0;
  if (s0 < 1.5) { run += aacBezMonoContrib(CX, CY, F0, F1, prev, s0, q0, q1); prev = s0; }
  if (s1 < 1.5) { run += aacBezMonoContrib(CX, CY, F0, F1, prev, s1, q0, q1); prev = s1; }
  return run + aacBezMonoContrib(CX, CY, F0, F1, prev, 1.0, q0, q1);
}

// A segment lying entirely RIGHT of the cell has clamp(Xl) == 1 throughout, so
// ∫clamp(Xl)·dYl collapses to D = Δclamp(Yl) — a function of the ENDPOINTS only.
// No y-extrema split, no solve, no quadrature: two clamps and a subtract.
// (Run-convention, hence the leading minus.)
float aacRightD(float y0, float y1, float q0, float q1) {
  return -(clamp(y1, q0, q1) - clamp(y0, q0, q1));
}

// LINE (exact, closed form — NO solve, NO quadrature). X is linear in Y, so the
// contribution ∫ clamp(Xl,0,1)·dYl over the window is the integral of a clamped
// linear ramp. This is the hot polygon path: one divide (was two for the band-find
// plus two inside the ramps), and dy·(tb-ta) folds to sign(dy)·(hi-lo).
float aacLineContrib(vec2 A, vec2 B, float q0, float q1) {
  float dy = B.y - A.y;
  if (abs(dy) < 1e-9) return 0.0;
  float lo = max(q0, min(A.y, B.y)), hi = min(q1, max(A.y, B.y));
  if (hi <= lo) return 0.0;                                        // no overlap with cell∩stripe
  if (min(A.x, B.x) >= 1.0) return aacRightD(A.y, B.y, q0, q1);    // fully right of cell
  // x is affine in y, so Xl at the window ends is two FMAs off one slope — no
  // parametric detour (t-values, sorting them, two mixes). aacClampI is symmetric
  // in its arguments (reversing s reverses the ramp), so the ends need no order.
  float dxdy = (B.x - A.x) / dy;                                   // the only divide
  float wlo = A.x + dxdy * (lo - A.y);                             // Xl at y = lo
  float whi = A.x + dxdy * (hi - A.y);                             // Xl at y = hi
  float sgn = (dy > 0.0) ? 1.0 : -1.0;                             // signed clipped Δy
  return -sgn * (hi - lo) * aacClampI(wlo, whi);
}

// CONTROL-HULL CULL (quad/cubic). A Bezier lies inside the convex hull of its
// control points, so hull bounds reject whole segments before the coefficient
// build, the extrema split and the solves — which is where all the cost is.
//   * hull y misses the window  → clamp(Yl) is constant along the curve → 0
//   * hull x fully right of it  → aacRightD closed form
// A third (hull x fully LEFT → 0) is deliberately absent: the walker's break-early
// tests exactly that bound already (the entry's brk IS the segment's xMax), so inside the
// loop maxXl >= 0 is guaranteed and the check would be dead code.
float aacQuadContrib(vec2 P0, vec2 P1, vec2 P2, float q0, float q1) {
  if (max(P0.y, max(P1.y, P2.y)) <= q0 ||
      min(P0.y, min(P1.y, P2.y)) >= q1) return 0.0;                              // hull: no y-overlap
  if (min(P0.x, min(P1.x, P2.x)) >= 1.0) return aacRightD(P0.y, P2.y, q0, q1);   // hull: right of cell
  return aacCurveContrib(aacQuadCoeff(P0.x, P1.x, P2.x),
                         aacQuadCoeff(P0.y, P1.y, P2.y), q0, q1);
}
float aacCubicContrib(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float q0, float q1) {
  if (max(max(P0.y, P1.y), max(P2.y, P3.y)) <= q0 ||
      min(min(P0.y, P1.y), min(P2.y, P3.y)) >= q1) return 0.0;                            // hull: no y-overlap
  if (min(min(P0.x, P1.x), min(P2.x, P3.x)) >= 1.0) return aacRightD(P0.y, P3.y, q0, q1); // hull: right of cell
  return aacCurveContrib(aacCubicCoeff(P0.x, P1.x, P2.x, P3.x),
                         aacCubicCoeff(P0.y, P1.y, P2.y, P3.y), q0, q1);
}

// TYPE OMISSION (both engines). Each walker's sub-loops are type-grouped and a bundle knows
// which segment types it actually contains, so unused kernels can be compiled OUT.
// This matters because AAC's cost on small shapes is REGISTER PRESSURE, not work:
// its occupancy is set by the kernel's live-register high-water mark, which every
// fragment pays whether or not it executes that path. The arc kernel (atan/acos/
// cos/sin + the trig antiderivative) and the cubic kernel (clamped Newton + the
// degree-6 antiderivative) are the two expensive ones. A font bundle is quads only.
#ifndef MANTLE_NO_ARC
// ARC (native ellipse), EXACT closed form. d1=(cx,cy,rx,ry), d2=(th0,th1,phi,_).
//
// In pixel-local coords the arc is a pair of phase-shifted sinusoids in θ:
//   Xl(θ) = X.x + X.y·cosθ + X.z·sinθ
//   Yl(θ) = Y.x + Y.y·cosθ + Y.z·sinθ,   Yl'(θ) = −Y.y·sinθ + Y.z·cosθ
// (from x_em = cx + cp·rx·cosθ − sp·ry·sinθ, y_em = cy + sp·rx·cosθ + cp·ry·sinθ,
//  then the affine em→pixel-local map, which preserves the form).
//
// So the integrand Xl·Yl' is a trig polynomial of degree ≤ 2 and has an
// elementary antiderivative — the arc needs no quadrature and no chord. Every
// other AAC type reaches exactness via a polynomial argument; the arc reaches it
// via a trigonometric one. The old band-chord cost up to 38/255 on small-radius
// arcs (rounded-rect corners) and 32/255 at medium radius; this is 0.000/255.
// P = (C, A, B) with value C + A·cosθ + B·sinθ == C + R·cos(θ−φ),
// R = |(A,B)|, φ = atan2(B,A). R and φ are per-SEGMENT constants, so the walker
// computes them once (for the x and y lanes) and threads them through: every
// eval becomes one cos instead of a cos and a sin, and every solve drops an atan
// and a sqrt. atan/acos/sqrt in a per-fragment inner loop are not cheap.
float aacTrigEval(vec3 P, float th) { return P.x + P.y * cos(th) + P.z * sin(th); }
float aacTrigEvalR(float C, float R, float phi, float th) { return C + R * cos(th - phi); }

// The extrema of C + R·cos(θ-φ) sit at θ = φ + kπ. Return the (at most two) that
// lie strictly inside (lo,hi), ascending, 1e9 for absent. O(1): the smallest
// admissible k is floor((lo-φ)/π)+1, so there is nothing to scan.
//
// This also fixes a latent bug in the -3..3 loop it replaces: an arc whose θ range
// sits outside ±3π had its extrema silently skipped, leaving a piece that is not
// monotone — exactly the precondition the clip and the x-split rely on.
vec2 aacPhaseExtrema(float phi, float lo, float hi) {
  float PI_ = TWO_PI * 0.5;
  float t0 = phi + (floor((lo - phi) / PI_) + 1.0) * PI_;
  float t1 = t0 + PI_;
  float e0 = (t0 > lo + 1e-7 && t0 < hi - 1e-7) ? t0 : 1e9;
  float e1 = (t1 > lo + 1e-7 && t1 < hi - 1e-7) ? t1 : 1e9;
  return vec2(min(e0, e1), max(e0, e1));
}

// F(θ) = ∫ Xl·Yl' dθ. Checked against finite differences to 1.7e-9.
float aacTrigF(vec3 X, vec3 Y, float th) {
  float c = cos(th), s = sin(th);
  return X.x * (Y.y * c + Y.z * s)
       + (X.z * Y.z - X.y * Y.y) * 0.5 * s * s
       + (X.y * Y.z - X.z * Y.y) * 0.5 * th
       + (X.y * Y.z + X.z * Y.y) * 0.5 * s * c;
}

// Solve C + R·cos(θ−φ) = V on a MONOTONE θ-range. Closed form, no iteration:
// θ = φ ± acos((V−C)/R) + 2πk. Pick the branch landing in the range. R and φ come
// from the caller (per-segment constants) — this is the same closed-form
// ray-vs-arc solve Slug's arc walker does with its own atan+acos.
float aacTrigSolve(float C, float R, float phi, float V, float a, float b) {
  float r = clamp((V - C) / max(R, 1e-9), -1.0, 1.0);
  float ac = acos(r);
  float lo = min(a, b), hi = max(a, b);
  for (int k = 0; k < 2; k++) {
    float th = phi + (k == 0 ? ac : -ac);
    th += ceil((lo - th) / TWO_PI) * TWO_PI;      // shift into [lo, lo+2π)
    if (th <= hi + 1e-4) return clamp(th, lo, hi);
  }
  return 0.5 * (lo + hi);   // unreached for a valid monotone bracket
}

// One zone on which clamp(Xl) has a single analytic form. Classify by midpoint:
//   Xl ≤ 0 → 0     Xl ≥ 1 → ∫Yl'dθ = ΔYl (endpoints)     else → F(b) − F(a)
float aacArcZoneI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xm = aacTrigEvalR(X.x, RX, pX, 0.5 * (a + b));
  if (xm <= 0.0) return 0.0;
  if (xm >= 1.0) return aacTrigEvalR(Y.x, RY, pY, b) - aacTrigEvalR(Y.x, RY, pY, a);
  return aacTrigF(X, Y, b) - aacTrigF(X, Y, a);
}

// [a,b] is x-MONOTONE (traversal order; b may be < a). Split at the Xl=0 and
// Xl=1 crossings — at most one each, by monotonicity — then each zone is closed
// form. Fast paths first: a run that never leaves [0,1] in x needs no solve.
float aacArcXMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xa = aacTrigEvalR(X.x, RX, pX, a), xb = aacTrigEvalR(X.x, RX, pX, b);
  float xlo = min(xa, xb), xhi = max(xa, xb);
  if (xhi <= 0.0) return 0.0;                                                            // fully left
  if (xlo >= 1.0) return aacTrigEvalR(Y.x, RY, pY, b) - aacTrigEvalR(Y.x, RY, pY, a);    // fully right
  if (xlo >= 0.0 && xhi <= 1.0) return aacTrigF(X, Y, b) - aacTrigF(X, Y, a);
  bool h0 = (xlo < 0.0 && xhi > 0.0);
  bool h1 = (xlo < 1.0 && xhi > 1.0);
  float t0 = h0 ? aacTrigSolve(X.x, RX, pX, 0.0, a, b) : a;
  float t1 = h1 ? aacTrigSolve(X.x, RX, pX, 1.0, a, b) : a;
  bool fwd = b > a;
  float acc = 0.0, prev = a;
  if (h0 && h1) {                       // both walls crossed: order along traversal
    float m0 = fwd ? min(t0, t1) : max(t0, t1);
    float m1 = fwd ? max(t0, t1) : min(t0, t1);
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m0); prev = m0;
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m1); prev = m1;
  } else if (h0 || h1) {
    float m = h0 ? t0 : t1;
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m); prev = m;
  }
  return acc + aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, b);
}

// Split a y-monotone θ-range at the x-extrema (dXl/dθ=0 ⇒ θ = atan2(X.z,X.y)+kπ)
// so every sub-run is x-monotone, then integrate each exactly.
float aacArcMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b) {
  vec2 ex = aacPhaseExtrema(pX, min(a, b), max(a, b));   // x-extrema at θ = φx + kπ
  float g0 = ex.x, g1 = ex.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = b > a;
  float acc = 0.0, prev = a;
  if (n == 1) { acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, g0); prev = g0; }
  else if (n == 2) {
    float m0 = fwd ? g0 : g1, m1 = fwd ? g1 : g0;
    acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, m0); prev = m0;
    acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, m1); prev = m1;
  }
  return acc + aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, b);
}

// One y-monotone θ-piece, clipped to the cell∩stripe window [q0,q1] in Yl.
// Yl' carries the winding sign through the integral, so there is no separate
// `inc` factor to keep consistent across the extrema split.
float aacArcMonoContrib(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float q0, float q1) {
  float ya = aacTrigEvalR(Y.x, RY, pY, a), yb = aacTrigEvalR(Y.x, RY, pY, b);
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;                                   // along the traversal a→b
  float uA = inc ? ((ya >= q0) ? a : aacTrigSolve(Y.x, RY, pY, q0, a, b))
                 : ((ya <= q1) ? a : aacTrigSolve(Y.x, RY, pY, q1, a, b));
  float uB = inc ? ((yb <= q1) ? b : aacTrigSolve(Y.x, RY, pY, q1, a, b))
                 : ((yb >= q0) ? b : aacTrigSolve(Y.x, RY, pY, q0, a, b));
  if (abs(uB - uA) < 1e-12) return 0.0;
  return -aacArcMonoI2(X, Y, RX, pX, RY, pY, uA, uB);   // run-convention: -∫clamp(Xl)dYl
}

float aacArcContrib(vec4 d1, vec4 d2, vec2 c, vec2 px, float q0, float q1) {
  float dth = d2.y - d2.x;
  if (abs(dth) < 1e-9) return 0.0;
  float sp = sin(d2.z), cp = cos(d2.z);          // phi-trig once per segment
  float th0 = d2.x, th1 = d2.y;
  vec3 X = vec3((d1.x - c.x) * px.x + 0.5,  px.x * cp * d1.z, -px.x * sp * d1.w);
  vec3 Y = vec3((d1.y - c.y) * px.y + 0.5,  px.y * sp * d1.z,  px.y * cp * d1.w);

  // Y-cull, in two stages.
  //
  // STAGE 1 (cheap, whole-ellipse): Yl is a sinusoid of amplitude √(Y.y²+Y.z²)
  // ≤ |Y.y|+|Y.z| — the sqrt-free triangle bound, EXACT for the common
  // axis-aligned case (phi=0 ⇒ one term is zero). Two abs and an add.
  float Ry = abs(Y.y) + abs(Y.z);
  if (Y.x + Ry <= q0 || Y.x - Ry >= q1) return 0.0;

  // X-cull, same triangle bound. Reinstated: it was dropped when it was spelled
  // with a sqrt and a coordinate transform (~4% slower on a two-arc ellipse,
  // where an arc spans the whole shape so "fully right" almost never fires).
  // With X already in (C, A, B) form it is three ops, and on SMALL arcs — scallop
  // rings, rounded-rect corners — it fires constantly and skips the entire
  // integration: the extrema split, the acos clips, every zone.
  //   fully LEFT  → clamp(Xl) ≡ 0 → contributes nothing
  //   fully RIGHT → clamp(Xl) ≡ 1 → Δclamp(Yl), endpoints only
  float Rx = abs(X.y) + abs(X.z);
  if (X.x + Rx <= 0.0) return 0.0;
  if (X.x - Rx >= 1.0)
    return aacRightD(aacTrigEval(Y, th0), aacTrigEval(Y, th1), q0, q1);

  // Per-segment polar constants, computed ONCE and threaded through the whole
  // arc chain: every eval below becomes one cos, every solve loses an atan+sqrt.
  float RX = sqrt(X.y * X.y + X.z * X.z), pX = atan(X.z, X.y);
  float RY = sqrt(Y.y * Y.y + Y.z * Y.z), pY = atan(Y.z, Y.y);

  // y-extrema: Yl'(θ)=0 ⇒ θ = φy + kπ. Split so each piece is y-monotone, which
  // is what the clip and the x-split below assume.
  vec2 ey = aacPhaseExtrema(pY, min(th0, th1), max(th0, th1));
  float g0 = ey.x, g1 = ey.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;

  // STAGE 2 (tight, SWEEP-AWARE). Stage 1 bounds the whole ellipse, which for a
  // short arc — a rounded-rect corner, say — is wildly loose. The true y-range of
  // the sweep is spanned by the two endpoints plus any y-extremum strictly
  // inside it, and at an extremum Yl = Y.x ± R exactly (Yl = Y.x + R·cos(θ−baseY),
  // and θ−baseY = kπ there). So the tight range costs two endpoint evals and one
  // cos per interior extremum — and the extrema were needed anyway.
  //
  // This is why nothing is stashed in the free d2.w slot: a single float can only
  // carry a half-extent symmetric about cy, and a corner arc spanning [cy, cy+ry]
  // has the SAME symmetric bound as the full ellipse. The asymmetry is the whole
  // point, and deriving it here is free.
  //
  // Rejecting here skips every mono contrib — the trig solves, which are the cost.
  {
    float ya = aacTrigEvalR(Y.x, RY, pY, th0), yb = aacTrigEvalR(Y.x, RY, pY, th1);
    float ymin = min(ya, yb), ymax = max(ya, yb);
    if (n >= 1) { float v = aacTrigEvalR(Y.x, RY, pY, g0); ymin = min(ymin, v); ymax = max(ymax, v); }
    if (n >= 2) { float v = aacTrigEvalR(Y.x, RY, pY, g1); ymin = min(ymin, v); ymax = max(ymax, v); }
    if (ymax <= q0 || ymin >= q1) return 0.0;
  }

  // The matching x-cull is deliberately absent: unlike a quad/cubic control hull,
  // an arc typically spans the whole shape, so "fully right of the cell" fires
  // only in a thin sliver at the far left while EVERY fragment pays for the
  // bound. Measured ~4% slower on a two-arc ellipse. Break-early covers the left.
  bool fwd = dth > 0.0;
  float run = 0.0, prev = th0;
  if (n == 1) { run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, g0, q0, q1); prev = g0; }
  else if (n == 2) {
    float m0 = fwd ? g0 : g1, m1 = fwd ? g1 : g0;
    run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, m0, q0, q1); prev = m0;
    run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, m1, q0, q1); prev = m1;
  }
  return run + aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, th1, q0, q1);
}

#endif  // MANTLE_NO_ARC

// Winding fold — matches meshFreeRaster.fold (nonzero: min(|run|,1); even-odd:
// triangle wave). The area's sign convention is irrelevant here (fold uses |run|).
float aacFold(float run, bool evenOdd) {
  if (!evenOdd) return min(abs(run), 1.0);
  float m = run - 2.0 * floor(run * 0.5);    // run mod 2, in [0,2)
  float cc = m <= 1.0 ? m : 2.0 - m;
  return clamp(cc, 0.0, 1.0);
}

// Walk ONE band's segment list, accumulating -∫clamp(Xl)dYl over the y-window
// [q0,q1] of the pixel cell. Hoisted out of renderFillAAC so the single-band
// fast path can pass literal (0.0, 1.0) and let the compiler fold every
// clamp/compare back to the constants they were before the cell-clip existed.
float aacWalkBand(ivec2 gl, int bandY, vec2 c, vec2 px, float xBreak, float q0, float q1) {
  int hdr = bandY * 2;
  vec4 cnts = bFetch(bLoc(gl, hdr));
  int nLine = int(cnts.x), nQuad = int(cnts.y), nCubic = int(cnts.z), nArc = int(cnts.w);
  int arrIdx = int(bFetch(bLoc(gl, hdr + 1)).x);
  int hOff = 0;
  float run = 0.0;
  // BREAK-EARLY (same prune, same sorted order, same test as the Slug walker).
  // Band entries carry .z = the segment's xMax, sorted DESCENDING. Under the
  // reversed clamp(Xl) integrand a segment entirely left of the cell contributes
  // exactly zero, so once xMax falls left of the cell's left edge (Xl < 0) every
  // remaining segment in the band does too — stop. Algebraically identical to
  // Slug's `(entryBrk - c.x) * px.x < -0.5`, with `c.x*px.x - 0.5` hoisted into
  // xBreak by the caller — this test runs once per segment.
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < 1024; i++) {          // LINES
    if (i >= nLine) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    run += aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), q0, q1);
  }
#endif
  hOff += nLine;                            // full count: break skips a suffix
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < 1024; i++) {          // QUADRATICS
    if (i >= nQuad) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 p3  = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    run += aacQuadContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p3, c, px), q0, q1);
  }
#endif
  hOff += nQuad;
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < 1024; i++) {          // CUBICS
    if (i >= nCubic) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec4 p34 = texFetch(ivec2(sL.x + 2, sL.y));
    run += aacCubicContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p34.xy, c, px), aacPL(p34.zw, c, px), q0, q1);
  }
#endif
  hOff += nCubic;
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < 1024; i++) {          // ARCS (native ellipse)
    if (i >= nArc) break;
    vec2 segRaw = bandEntry(gl, arrIdx, hOff + i);
    if (segRaw.y * px.x < xBreak) break;
    ivec2 sL = segLocXY(segRaw.x);
    vec4 d1 = texFetch(ivec2(sL.x + 1, sL.y));   // (cx,cy,rx,ry)
    vec4 d2 = texFetch(ivec2(sL.x + 2, sL.y));   // (th0,th1,phi,_)
    run += aacArcContrib(d1, d2, c, px, q0, q1);
  }
#endif
  return run;
}

float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = max(shapeBB.zw - shapeBB.xy, vec2(1e-6));

  // MULTI-BAND CELL WALK. The pixel cell spans a full pixel in y, but a band only
  // covers its own y-stripe of the shape bbox. Walk every stripe the cell touches
  // and clip that stripe's contribution to (cell ∩ stripe) via [q0,q1]. The
  // y-integral is additive and the sub-ranges are disjoint, so the parts sum to
  // the exact cell coverage with no double-count — and any segment touching
  // (cell ∩ stripe b) overlaps stripe b in y, hence IS in band b's list. No
  // margin needed, and it is what makes the encoder's curve-TIGHT binning exact.
  //
  // Slug never needs this: its H-ray samples y == c.y exactly, so the single band
  // containing c.y always suffices. AAC integrates the whole cell, so reading only
  // band(c.y) silently DROPS segments lying just across a nearby band boundary —
  // a ~0.5-coverage error wherever bands approach pixel size (dense paths drawn
  // small). Guarded by test/aacBandSeamSmoke.mjs.
  // ONE call site, deliberately. An `if (b0==b1) return walk(<literals>)` fast
  // path inlines a SECOND copy of the whole band walk, and a GPU warp executes
  // both sides of a divergent branch — so a single straddling fragment makes
  // every lane pay for both bodies. Measured: that "optimization" cost ~20% on
  // poly-48.
  //
  // Register pressure is the real constraint here: the band walk is bound on
  // bFetch/texFetch latency, which the GPU hides only by keeping many warps
  // resident, and residency is capped by live registers. So anything not needed
  // DURING the walk (yA/yB/bandH/the stripe bounds) is computed inside the rare
  // straddle branch and left dead on the common path, where the window is
  // exactly the full cell (0,1).
  // Loop-invariant work, computed once: the half-pixel in em, the stripe height,
  // and the break-early threshold (see aacPL for one "hoist" that is NOT safe).
  float hy = 0.5 / max(abs(px.y), 1e-12);            // half a pixel, in em
  float bandH = bbSize.y / float(bandsY);
  float xBreak = c.x * px.x - 0.5;                   // break-early threshold
  float yA = c.y - hy, yB = c.y + hy;
  int b0 = clamp(int((yA - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int b1 = clamp(int((yB - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  // PAIR-BAND WALK. Band b's list covers stripes {b, b+1} (see buildTexturesShape).
  // b0 comes from the cell's TOP edge, so the cell always begins in stripe b0. If
  // it ends no later than b0+1 — true for every fragment unless a stripe is
  // thinner than a pixel — ONE walk over band b0's list with the FULL cell window
  // suffices, and the straddle's second walk disappears.
  //
  // Exact: every segment touching the cell overlaps stripe b0 or b0+1, hence is in
  // the list; listed segments that miss the cell contribute zero (their Δclamp(Yl)
  // vanishes), so the telescoping identity is untouched.
  //
  // Otherwise step b += 2: the pairs {b,b+1}, {b+2,b+3}, … tile the cell disjointly,
  // so nothing is double-counted. The walk body stays inside the loop rather than
  // being duplicated behind an `if` — a second inlined copy measured worse every
  // time, and the loop runs exactly once in the common case anyway.
#ifdef MANTLE_AAC_PAIR_BANDS
  bool pairCovers = (b1 <= b0 + 1);
  const int bandStride = 2;               // stripe-PAIRS tile disjointly
#else
  bool pairCovers = (b0 == b1);           // stripe bands: only a non-straddling cell
  const int bandStride = 1;
#endif
  float run = 0.0;
  // Trip bound 96 == pickBandsAxis's cap (clamp(round(sqrt(32n)), 4, 96)). It is
  // a safety net, not the exit: the `bandY > b1` break is. A tighter bound would
  // SILENTLY drop bands, with no assert and no crash — just missing coverage —
  // whenever a 1px cell spans more stripes than the bound. That is not exotic:
  // a 512-segment path gets bandsY = 96, so drawn at 48px its cell spans ~4
  // stripes. Measured: bound 2 → max channel diff 154/255 at 48px, byte-identical
  // at 160px where the cell spans ≤ 2.
  for (int bi = 0; bi < 96; bi++) {
    int bandY = b0 + bi * bandStride;
    if (bandY > b1) break;
    float q0 = 0.0, q1 = 1.0;               // cell ⊂ {b0,b0+1} ⇒ the window IS the cell
    if (!pairCovers) {
      // Stripe-pair bounds in em, formed exactly as the encoder does
      // (bbY0 + by*bbH/bandsY), then (cell ∩ pair) in pixel-local y.
      float e0 = (max(yA, shapeBB.y + float(bandY)     * bandH) - c.y) * px.y + 0.5;
      float e1 = (min(yB, shapeBB.y + float(bandY + bandStride) * bandH) - c.y) * px.y + 0.5;
      q0 = clamp(min(e0, e1), 0.0, 1.0);   // px.y may flip the axis
      q1 = clamp(max(e0, e1), 0.0, 1.0);
      if (q1 - q0 < 1e-9) continue;
    }
    run += aacWalkBand(gl, bandY, c, px, xBreak, q0, q1);
  }
  return aacFold(run, evenOdd);
}


#endif

float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  vec4 exInfo;
  vec2 slInfo;
  vec4 L = fillLinear(c, px, GD, shapeBB, exInfo, slInfo);
  float wsum = max(L.z + L.w, 1.0 / 65536.0);
  // NOT a coverage. This is the pixel's mean WINDING NUMBER, in magnitude: each ray accumulates
  // sgn * (the fraction of the pixel beyond that crossing), so it reads ~1 inside one contour,
  // ~2 inside two nested same-wound contours, and the area-average of the two on a boundary.
  float mag = max(abs(L.x * L.z + L.y * L.w) / wsum, min(abs(L.x), abs(L.y)));
  // The winding resolved through the FILL RULE — i.e. the blend's estimate of the actual
  // coverage, in [0,1]. This is the only quantity an exact AREA may be compared against.
  float est = evenOdd ? (1.0 - abs(1.0 - fract(mag * 0.5) * 2.0)) : clamp(mag, 0.0, 1.0);

  // ONE edge near this pixel (a straight segment, or a curve represented by its TANGENT at the
  // crossing) ⇒ take the EXACT half-plane box area instead of the blend's estimate. Corners and
  // sharply-curved pixels record two half-planes and keep the blend.
  //
  // The blend still decides WHICH side is filled — but it is compared against `est`, a coverage,
  // not against `mag`, a winding magnitude. That was the bug, and it was only ever wrong on
  // INTERIORS, which is what gave it away:
  //
  //   * on an OUTER edge the winding steps 0 → 1, so its magnitude passes for a coverage and the
  //     pick works;
  //   * on an INTERIOR edge — a hole in an even-odd shape, nested contours — it steps 1 → 2, so
  //     the pick was comparing an area in [0,1] against ~1.5 and simply took the larger of
  //     ec / (1−ec). Half the time that is the wrong side, which returns a 0.7 pixel as 0.3 — so
  //     coverage RISES again on its way out of the shape. A mean-absolute-error test never saw
  //     it: the bad pixels are isolated and their errors cancel.
  //
  // Measured against the browser rasterising the same geometry (ring, 400px): 72 of 2008 edge
  // crossings non-monotone and 0.452 mean / 136 max error before; 0 and 0.147 / 49 after. On a
  // hole: 0.253 / 136 → 0.062 / 38. Straight edges are unchanged (diagonal frame 0.021 / 21).
  //
  // `mag < 1.25` excludes the one pixel this model does not describe: under NONZERO an edge can
  // separate two FILLED regions (winding 1 | 2), where the pixel is solid and there is no ramp to
  // size. Substituting an area there drew a seam down the middle of a filled shape. A genuine
  // boundary pixel — however nearly solid — stays near 1, so it keeps the exact area. (Even-odd
  // needs no such guard: parity flips at every crossing, so an interior edge is a real partial.)
#ifdef MANTLE_EXACT_EDGE
  if (exInfo.w == 1.0 && (evenOdd || mag < 1.25)) {
    float _L = max(length(exInfo.xy), 1e-9);      // the ONE normalize, per fragment
    float ec = exactBoxCov(exInfo.xy / _L, exInfo.z / _L);
    return (abs(ec - est) <= abs((1.0 - ec) - est)) ? ec : 1.0 - ec;
  }
#endif
#ifdef MANTLE_SLOPE_AA
  // SECANT reconstruction from the two nearest ray crossings a=(slInfo.x, 0),
  // b=(0, slInfo.y) (pixel units): the boundary line through both is
  // b.y·x + a.x·y = a.x·b.y, and its exact box coverage replaces the two-ray
  // blend — which is exact only for axis-aligned edges (mean 10.6/255, max
  // 31.9/255 at 45°). Runs only on ramp fragments (est partial) and only when
  // the single-edge model REPRODUCES the measured per-ray coverages (both
  // orientations tried; corners, thin strokes and multi-crossing pixels fail
  // the check and keep the blend). A nearly-axis-aligned edge misses one ray
  // (offset stays 1e30) and keeps the blend, which is already exact there.
  // Cost: two floats of walker state and this once-per-fragment tail — none of
  // the exact-edge branch's per-crossing tangent work or register pressure.
  if ((evenOdd || mag < 1.25) && est > 0.002 && est < 0.998
      && abs(slInfo.x) < 8.0 && abs(slInfo.y) < 8.0) {
    vec2 n0 = vec2(slInfo.y, slInfo.x);
    float L0 = length(n0);
    if (L0 > 1e-6) {
      vec2 n = n0 / L0;
      float d = slInfo.x * slInfo.y / L0;
      float cH = clamp(abs(L.x), 0.0, 1.0), cV = clamp(abs(L.y), 0.0, 1.0);
      float pH = clamp(0.5 + (n.x > 0.0 ? slInfo.x : -slInfo.x), 0.0, 1.0);
      float pV = clamp(0.5 + (n.y > 0.0 ? slInfo.y : -slInfo.y), 0.0, 1.0);
      float e1 = abs(pH - cH) + abs(pV - cV);
      float e2 = abs(1.0 - pH - cH) + abs(1.0 - pV - cV);
      if (min(e1, e2) < 0.02) {
        float ec = exactBoxCov(n, d);
        return e1 <= e2 ? ec : 1.0 - ec;
      }
    }
  }
#endif
  return est;
}
