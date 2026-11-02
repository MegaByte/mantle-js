// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
//   - sampleGradient(gid, emCoord, shapeBB, emDx, emDy) → vec4 premult RGBA
//   - sampleChildImage(tileEm, imageRect, atlasSlot, tileDx, tileDy) → vec4
//   - sampleTopLevelImage(emPos, imageRect, atlasSlot, emDx, emDy) → vec4
//   - strokeMinDist(...) — stroke distance helper
//   - dashOut(dashId, dist, zeroDashEmpty) / strokeDashDist(...) — the dash set as a distance
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
// → atlas pixel. Returns straight RGBA (filtered premultiplied, see imageTexelStraight); the caller premultiplies.
// SVG child images clamp; explicit repeat/mirror sampler flags wrap. atlasSlot.w packs (kind | (pixelated<<2)).
// pixelated → emulate nearest-neighbor sampling regardless of the atlas
// texture's GL filter mode by snapping uv to texel centers.
#ifndef MANTLE_NO_IMAGE  // dropped by an image-free fill variant
// tileDx and tileDy are tileEm's screen derivatives, from the caller's uniform control flow: this
// runs inside the pattern loop, and texture()'s implicit LOD there is undefined (: a
// pixelated image child's edges came out blended toward the smallest mip).
// A transformed raster image uses its otherwise unused fill-gradient record
// for the inverse image-to-document map. Axis-aligned positive scales are
// already folded into imageRect and need no gradient record or extra fetches.
void imageLocalCoordinates(int mapId, inout vec2 pos, inout vec2 dx, inout vec2 dy) {
#ifndef MANTLE_NO_GRADIENT
  if (mapId > 0) {
    vec4 m = texelFetch(uGradientTex, gradAt(GR_G1, mapId - 1), 0);
    vec2 t = texelFetch(uGradientTex, gradAt(GR_G2, mapId - 1), 0).xy;
    mat2 linear = mat2(m.xy, m.zw);
    pos = linear * pos + t; dx = linear * dx; dy = linear * dy;
  }
#endif
}

// The atlas texture holds PREMULTIPLIED texels (renderer/bundle.js premultiplies at upload), so the bilinear / mip /
// anisotropic filter blends color weighted by alpha: red next to a transparent texel filters to red at half alpha, not to a
// dark red. The callers tint a STRAIGHT color and premultiply after, so the filtered texel is un-premultiplied here.
vec4 imageTexelStraight(vec4 t) {
  return vec4(t.a > 0.0 ? min(t.rgb / t.a, vec3(1.0)) : vec3(0.0), t.a);
}

vec4 sampleChildImage(vec2 tileEm, vec4 imageRect, vec4 atlasSlot, vec2 tileDx, vec2 tileDy) {
  bool secondary = (int(atlasSlot.w + 0.5) & 8) != 0;
  vec2 atlasSize = secondary ? uSecondaryImageAtlasSize : uImageAtlasSize;

  vec2 rs = max(imageRect.zw, vec2(1e-30));
  float u = (tileEm.x - imageRect.x) / rs.x;
  float v = (tileEm.y - imageRect.y) / rs.y;
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) { u = fract(u); v = fract(v); }
  else if (kind == 3) {
    u = 1.0 - abs(fract(u * 0.5) - 0.5) * 2.0;
    v = 1.0 - abs(fract(v * 0.5) - 0.5) * 2.0;
  } else if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0);
  float atlasU = clamp(u * atlasSlot.y, 0.5, max(0.5, atlasSlot.y - 0.5)) / max(atlasSize.x, 1.0);
  float atlasV = clamp(atlasSlot.x + v * atlasSlot.z, atlasSlot.x + 0.5,
    atlasSlot.x + max(0.5, atlasSlot.z - 0.5)) / max(atlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    // Pixelated: snap to texel center. Linearly-filtered samples between
    // texels would blur the source raster; nearest-neighbor preserves
    // the pixel boundaries that image-rendering:pixelated requests.
    atlasU = (floor(atlasU * atlasSize.x) + 0.5) / max(atlasSize.x, 1.0);
    atlasV = (floor(atlasV * atlasSize.y) + 0.5) / max(atlasSize.y, 1.0);
  }
  vec2 aScale = atlasSlot.yz / (rs * max(atlasSize, vec2(1.0)));
  return imageTexelStraight(secondary ? textureGrad(uSecondaryImageTex, vec2(atlasU, atlasV), tileDx * aScale, tileDy * aScale) : textureGrad(uImageTex, vec2(atlasU, atlasV), tileDx * aScale, tileDy * aScale));}

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
// emDx and emDy are emPos's screen derivatives, taken by the caller in uniform control flow. The
// sample is a textureGrad with the UNWRAPPED coordinate's gradients: after a pattern wrap's fract()
// the implicit LOD saw a jump of a whole tile at every seam and picked the smallest mip, painting a
// line of the atlas's average color along each seam that fell inside a 2x2 quad (:
// every such seam pixel). A mirror wrap flips the gradient's sign, which selects the same LOD.
vec4 sampleTopLevelImage(vec2 emPos, vec4 imageRect, vec4 atlasSlot, vec2 emDx, vec2 emDy) {
  bool secondary = (int(atlasSlot.w + 0.5) & 8) != 0;
  vec2 atlasSize = secondary ? uSecondaryImageAtlasSize : uImageAtlasSize;

  vec2 rs = max(imageRect.zw, vec2(1e-30));
  float u = (emPos.x - imageRect.x) / rs.x;
  float v = (emPos.y - imageRect.y) / rs.y;
  vec2 uvDx = emDx / rs, uvDy = emDy / rs;
  // ONE PIXEL, IN THE RECT'S own UNITS, for the clamp branch below.
  vec2 uvPx = abs(uvDx) + abs(uvDy);
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) {
    // Pattern wrap.
    u = fract(u); if (u < 0.0) u += 1.0;
    v = fract(v); if (v < 0.0) v += 1.0;
  } else if (kind == 3) {
    // Mirror wrap: triangle-wave on each axis so adjacent tiles flip.
    // Period two, starting with the unreversed tile at [0, 1].
    u = 1.0 - abs(fract(u * 0.5) - 0.5) * 2.0;
    v = 1.0 - abs(fract(v * 0.5) - 0.5) * 2.0;
  } else {
    // Image clamp — outside the rect, paint nothing. But "outside" means outside by more than the
    // ANTIALIASING BAND: a Loop-Blinn triangle is DILATED ~1.5px outward so its coverage ramp has
    // somewhere to live, so a boundary fragment's em position sits just outside the rect while its
    // coverage is a legitimate 0.5. Image-painted bundles meet such geometry on the unified draw
    // (the classic per-shape route's is not dilated), static and morphing alike.
    //
    // Two pixels of slack, measured in the rect's own units so it scales with the mapping, then
    // clamp onto the edge texel. Beyond that the fragment really is outside the image and still
    // paints nothing, so an image fill on a path LARGER than its rect is unaffected.
    vec2 slack = 2.0 * uvPx;
    if (u < -slack.x || u > 1.0 + slack.x || v < -slack.y || v > 1.0 + slack.y) return vec4(0);
    u = clamp(u, 0.0, 1.0);
    v = clamp(v, 0.0, 1.0);
  }
  float atlasU = clamp(u * atlasSlot.y, 0.5, max(0.5, atlasSlot.y - 0.5)) / max(atlasSize.x, 1.0);
  float atlasV = clamp(atlasSlot.x + v * atlasSlot.z, atlasSlot.x + 0.5,
    atlasSlot.x + max(0.5, atlasSlot.z - 0.5)) / max(atlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    atlasU = (floor(atlasU * atlasSize.x) + 0.5) / max(atlasSize.x, 1.0);
    atlasV = (floor(atlasV * atlasSize.y) + 0.5) / max(atlasSize.y, 1.0);
  }
  vec2 aScale = atlasSlot.yz / max(atlasSize, vec2(1.0));
  return imageTexelStraight(secondary ? textureGrad(uSecondaryImageTex, vec2(atlasU, atlasV), uvDx * aScale, uvDy * aScale) : textureGrad(uImageTex, vec2(atlasU, atlasV), uvDx * aScale, uvDy * aScale));}

vec4 sampleMappedChildImage(vec2 pos, vec4 rect, vec4 atlas, vec2 dx, vec2 dy, int mapId) {
  imageLocalCoordinates(mapId, pos, dx, dy);
  return sampleChildImage(pos, rect, atlas, dx, dy);
}
vec4 sampleMappedTopLevelImage(vec2 pos, vec4 rect, vec4 atlas, vec2 dx, vec2 dy, int mapId) {
  imageLocalCoordinates(mapId, pos, dx, dy);
  return sampleTopLevelImage(pos, rect, atlas, dx, dy);
}

#endif
//
// Re-derived on Apple Silicon with probes/_newtonSweepBench.mjs (96-cubic
// star, 800x800, error vs the AAC exact-area reference in 0-255 units):
//
//   iters      ms    vs 5   meanErr   maxErr
//       3   3.817     -9%     0.631      255
//       4   4.083     -3%     0.419      254
//       5   4.200       0     0.402       81
//       6   4.517     +8%     0.401       81
//       8   4.683    +12%     0.401       81
//
// 5 is the floor, not a conservative guess: 4 buys 3% and costs a completely
// wrong pixel. Above 5 the error stops moving entirely, so 6 and 8 are 8-12%
// spent on nothing. (The residual max of 81 is the inherent Slug-vs-AAC
// difference at sharp features, not unconverged roots — it does not shrink
// with more iterations.)
// Overridable so probes/_newtonSweepBench.mjs can sweep it through
// createRenderer's fillDefines and re-derive the choice below on new hardware
// rather than trusting a comment.
#ifndef SLUG_NEWTON
#define SLUG_NEWTON 5
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

// Point and both θ-derivatives of a native arc at ONE θ, sharing cos/sin(θ) and
// taking cos/sin(phi) from the caller (they are per-segment constants).
//
// evalArc() and arcDyDtheta()/arcDxDtheta() each recompute cos(phi), sin(phi),
// cos(θ) and sin(θ) from scratch, so with them the fill walkers would pay EIGHT
// transcendentals per arc root where two suffice — and they take up to two roots,
// in each of the H and V passes. The standalone helpers stay for the stroke
// walker, which calls them at endpoints only.
// arcPoint takes cos/sin(θ) themselves, as cs = (ct, st), for a walker that needs them again (an arc's two ends).
void arcPoint(vec4 d1, float cp, float sp, vec2 cs, out vec2 p, out float dx, out float dy) {
  float ct = cs.x, st = cs.y;
  float ax = cp * d1.z, bx = sp * d1.w;      // x = cx + ax·cosθ − bx·sinθ
  float ay = sp * d1.z, by = cp * d1.w;      // y = cy + ay·cosθ + by·sinθ
  p  = vec2(d1.x + ax * ct - bx * st,
            d1.y + ay * ct + by * st);
  dx = -ax * st - bx * ct;
  dy = -ay * st + by * ct;
}
void arcSample(vec4 d1, float cp, float sp, float th, out vec2 p, out float dx, out float dy) {
  arcPoint(d1, cp, sp, vec2(cos(th), sin(th)), p, dx, dy);
}
//
// What remains of the rounding bound is the V ray's, below: band-hard's shortcut compares a SOLVED root's x
// (placed by angle, so rebuilt from the center form) against the pixel, and needs its bound.
// `cx + ax·cosθ − bx·sinθ` rounds as a fraction of |cx| + |rx| + |ry|.
float arcRayUlpV(vec4 d1) { return 1.2e-7 * (abs(d1.x) + abs(d1.z) + abs(d1.w)); }

// AN ARC'S CROSSINGS OF A RAY, COUNTED FROM THE ENDPOINT SIDES -- the one rule all three arc walkers
// share: Slug's H and V sub-loops and band-hard's hardCrossArc (and bandWinding.js, the CPU port).
//
// u(θ) is the arc's RAY-CENTERED CROSSING COORDINATE, y − c.y for the H ray and x − c.x for the V ray,
// written A·cosθ + B·sinθ − C (H: A = sin(phi)·rx, B = cos(phi)·ry, C = c.y − cy; V: A = cos(phi)·rx,
// B = −sin(phi)·ry, C = c.x − cx). `lo`/`hi` are the sweep's ends in θ order, `dir` the path's direction
// through them, and uLo/uHi their u at the STORED endpoints (arcEndsLoHi): the path's own vertices, the
// floats the neighboring segments store, never a value rebuilt from the angles.

// The topology is exact. u(θ) = Rlen·cos(θ − ang) − C is monotone between its stationary angles
// (du/dθ = −Rlen·sin(θ − ang) = 0 at θ = ang and ang + π), so splitting the sweep there leaves at most
// three monotone pieces -- and on a monotone piece the LINE rule is complete: the ends straddle the ray or
// they do not, a straddle is exactly one crossing, and its sign is the side of the end the PATH reaches
// last. The solve only has to LOCATE that crossing; it cannot add or remove one. A stationary
// angle's own u is ±Rlen − C exactly, so the split costs no transcendental; and where that is the ray the
// arc is tangent to it, which is zero crossings under either side (both pieces straddle, at the same x and
// with opposite signs, or neither does). The ends' u are the STORED vertices', signed as the line
// walker signs them, 0 NON-NEGATIVE, so the arc and the segment sharing a vertex count it once between them
// at every scale: they read the same float.
//
// A TOUCH, for the AA walkers only (`aa`). Within 1e-5·Rlen of the extremum that faces it, a ray meets the
// arc in two crossings a hair apart, on the two pieces meeting at that extremum, with opposite signs: they
// cancel, so the COUNT is the same with or without them. But an AA walker would also take their ramp weight,
// and along a ray TANGENT to the outline that weight trusts a reading that says nothing about the pixel --
// the H ray at the bottom of a pixel-sized circle reads 0 there with full weight, and the pixel drew 0.25
// where its exact coverage is 0.46 (test/smallRadiusAaSmoke.mjs). The walkers called such a ray tangent and
// took no root; they still drop the PAIR, and only the pair, so a lone crossing near an extremum
// (an arc that ends inside the touch) still counts. |C / Rlen| is dimensionless, so this is the same
// decision at every coordinate scale; band-hard (aa false) keeps both, which is the same count.
//
// ONE MONOTONE PIECE [ta, tb] of arcRayCrossings, with its ends' u: 0 when the ends do not straddle the
// ray, else 1 where the end the PATH reaches last is non-negative and 2 where it is negative. THE LINE RULE,
// on a piece that is monotone by construction: a centered u of exactly 0 counts as NON-NEGATIVE, so a vertex
// on the ray belongs to one side for both segments that share it. It COUNTS; placing the crossing is the
// walker's (Slug: the closed form in its arc sub-loops; band-hard: arcRayRoots).
float arcPieceCross(float ta, float ua, float tb, float ub, float dir) {
  bool aNeg = ua < 0.0, bNeg = ub < 0.0;
  if (aNeg == bNeg) return 0.0;
  return ((dir > 0.0) ? bNeg : aNeg) ? 2.0 : 1.0;
}
//
// THE SPLIT, for a walker that places the crossings: piece = (t1, u1, t2, u2), the inner ends -- slot 0 is
// [lo, t1], slot 1 [t1, t2], slot 2 [t2, hi], and t1 == lo (t2 == hi) exactly where no stationary angle split
// there -- and aux = (ang, uLo, uHi), the phase and the end values as snapped. No angle is solved here: a walker
// that needs θ calls arcRayRoots, and one that does not (Slug) never computes the acos.
vec3 arcRayCrossings(float lo, float hi, float dir, float A, float B, float C, float uLo, float uHi,
                     bool aa, out vec4 piece, out vec3 aux) {
  piece = vec4(lo, uLo, hi, uHi); aux = vec3(0.0, uLo, uHi);
  float rs = max(abs(A), abs(B));
  float Rlen = rs > 0.0 ? rs * length(vec2(A, B) / rs) : 0.0;
  if (!(Rlen > 0.0)) return vec3(0.0);
  // Every piece end is uLo, uHi or a stationary value ±Rlen − C (the very expressions the split below
  // forms), so when all four are on one side no piece can straddle: the same answer, before the atan.
  bool nLo = uLo < 0.0;
  if (nLo == (uHi < 0.0) && nLo == (Rlen - C < 0.0) && nLo == (-Rlen - C < 0.0)) return vec3(0.0);
  // PHASE AT B == 0, written directly: for an UNROTATED ellipse on the V ray B = −sin(0)·ry is NEGATIVE
  // zero, and atan(−0, +A) resolved to π instead of −0 on the GPU, which put both roots half a turn out
  // and the arc never filled. Exact for either sign of zero, on either ray.
  float ang = (B == 0.0) ? (A >= 0.0 ? 0.0 : 0.5 * TWO_PI) : curveAtan2(B, A);
  aux.x = ang;
  // The two stationary angles at or after lo, in order; each splits the sweep where it is strictly
  // inside it. cos(kπ) = (−1)^k, so a stationary angle's ray-centered u is ±Rlen − C with no call to cos.
  float k0 = ceil((lo - ang) / (0.5 * TWO_PI)), k1 = k0 + 1.0;
  float e0 = ang + k0 * (0.5 * TWO_PI), e1 = ang + k1 * (0.5 * TWO_PI);
  bool in0 = e0 > lo && e0 < hi, in1 = e1 > lo && e1 < hi;
  float t1 = in0 ? e0 : lo, u1 = in0 ? (((mod(k0, 2.0) < 0.5) ? Rlen : -Rlen) - C) : uLo;
  float t2 = in1 ? e1 : hi, u2 = in1 ? (((mod(k1, 2.0) < 0.5) ? Rlen : -Rlen) - C) : uHi;
  piece = vec4(t1, u1, t2, u2);
  vec3 cr = vec3(arcPieceCross(lo, uLo, t1, u1, dir),
                 arcPieceCross(t1, u1, t2, u2, dir),
                 arcPieceCross(t2, u2, hi, uHi, dir));
  // A touching PAIR (aa only): two neighboring pieces that both cross, at the extremum facing the ray.
  if (aa && abs(C / Rlen) >= 0.99999) {
    float nearU = ((C > 0.0) ? Rlen : -Rlen) - C;   // the facing extremum's u, as the split formed it
    if (cr.x > 0.0 && cr.y > 0.0 && u1 == nearU) { cr.x = 0.0; cr.y = 0.0; }
    else if (cr.y > 0.0 && cr.z > 0.0 && u2 == nearU) { cr.y = 0.0; cr.z = 0.0; }
    // The extremum at the sweep's own ends: both ends on the facing extremum (u exactly nearU, the same float) is a closed
    // arc whose seam sits there -- a circle that starts at (cx + rx, cy), met by the V ray through that point. The two touching
    // crossings are then the first and last pieces (no stationary angle is strictly inside the sweep at the seam), so
    // the pair the lines above look for across an interior extremum is looked for across the seam.
    else if (uLo == nearU && uHi == nearU) {
      if (cr.y > 0.0 && cr.z > 0.0) { cr.y = 0.0; cr.z = 0.0; }
      else if (cr.x > 0.0 && cr.y > 0.0) { cr.x = 0.0; cr.y = 0.0; }
    }
  }
  return cr;
}
// A crossing's θ on its piece [ta, tb] (band-hard's placement, from arcRayCrossings' split): u rises with θ at
// ang − b2 and falls at ang + b2, the piece's own direction picks the branch, and the congruent value nearest
// the piece's midpoint is the one inside it (pieces are ≤ π). The crossing EXISTS (the ends straddle); where
// acos is ill-conditioned -- a ray grazing an extremum -- clamping keeps it on the piece instead of off the end.
float arcPieceRoot(float ta, float tb, float ub, float ang, float b2) {
  float t = (ub < 0.0) ? (ang + b2) : (ang - b2);
  float mid = 0.5 * (ta + tb);
  t += TWO_PI * floor((mid - t) / TWO_PI + 0.5);
  return clamp(t, ta, tb);
}
vec3 arcRayRoots(float lo, float hi, float A, float B, float C, vec4 piece, vec3 aux) {
  float rs = max(abs(A), abs(B));
  float Rlen = rs > 0.0 ? rs * length(vec2(A, B) / rs) : 0.0;
  float b2 = acos(clamp(C / Rlen, -1.0, 1.0));
  return vec3(arcPieceRoot(lo, piece.x, piece.y, aux.x, b2),
              arcPieceRoot(piece.x, piece.z, piece.w, aux.x, b2),
              arcPieceRoot(piece.z, hi, aux.z, aux.x, b2));
}
// The sweep of an arc record d2 = (thetaStart, thetaEnd, phi, _) in θ order: (lo, hi, dir). A sweep of a
// full turn or more is one full ellipse, as arcInRange reads it.
vec3 arcSweep(vec4 d2) {
  float lo = min(d2.x, d2.y);
  return vec3(lo, min(max(d2.x, d2.y), lo + TWO_PI), (d2.y >= d2.x) ? 1.0 : -1.0);
}
// The arc's stored endpoints at its sweep's ends. `e` is the record's endpoints texel (sL + 3): (start,
// end) in PATH order, the path's own vertices, the floats the segments beside the arc store (textures.js encodeSeg).
// arcSweep's lo is the path's start when the sweep runs forward (dir > 0) and its end when it runs back.
void arcEndsLoHi(vec4 e, float dir, out vec2 pLo, out vec2 pHi) {
  pLo = (dir > 0.0) ? e.xy : e.zw;
  pHi = (dir > 0.0) ? e.zw : e.xy;
}
// The box a shape's bands divide: its bbox extents, a zero extent borrowing the other and a point using 1 --
// formed exactly as the encoder forms it (textures.js buildTexturesShape) and as the CPU port does (bandWinding.js).
// None of the three floors an extent at an ABSOLUTE value: with a 1e-6 floor a shape under 1e-6 across -- a glyph drawn
// at 2^-20, anything at 2^-40 -- would be banded over a box larger than itself: every segment in the first stripes,
// pixels past them reading an empty band, and the layout differing from scale 1's. A nonzero extent divides fine at any size.
vec2 bandBoxSize(vec4 bb) {
  vec2 e = bb.zw - bb.xy;
  return vec2(e.x > 0.0 ? e.x : (e.y > 0.0 ? e.y : 1.0), e.y > 0.0 ? e.y : (e.x > 0.0 ? e.x : 1.0));
}
ivec2 bLoc(ivec2 gl, int off) { ivec2 l=ivec2(gl.x+off, gl.y); l.y+=l.x>>12; l.x&=4095; return l; }

// Stroke fast-path gates (saturation early-out + control-hull reject), 1 = on.
//
// Declared HERE, in the helper that uses it, not in the shaders that include
// this file. Declaring it in mantle.frag/maskBake.frag left every OTHER
// includer — the lean fill variants above all — compiling a reference to an
// undeclared identifier, which took out 13 render smokes. A helper owns its own
// uniforms.
//
// A coherent uniform rather than a #define so one program can run both and an
// A/B carries no shader-variant confound.
uniform int uStrokeGates;

// A band entry is (loc, breakAxis, z, w), ONE per texel: loc is the segment header's LINEAR
// curve-plane texel index (row*4096 + col; f32-exact under 4096 rows -- encoder-guarded), and z, w
// hold either the seg's far edge on the break axis, which lets a stroke walk reject a segment lying
// entirely past the pixel without fetching its header or control points, or the crossing-axis lanes
// below.
//
// Linear texel indices. Every band walk forms its list's linear index (row*4096 + col) ONCE
// and each fetch splits its own index: `ivec2(i & 4095, i >> 12)` is the carry bLoc and texFetch
// perform on a (col + offset, row) pair, for every index, so every walk reads the texels it read
// before. What it drops is the re-splitting at every step -- bLoc's add, shift, add and mask for the
// entry, segLocXY's mask and shift of loc, the +1 on the column and texFetch's wrap of it again:
// about 11 integer ops per line entry, 4 more per extra data texel, on the chain from the entry fetch
// to the control fetch.
int texLin(ivec2 xy) { return (xy.y << 12) + xy.x; }
vec4 bFetchL(int i) { return texelFetch(uBandData, ivec2(i & 4095, i >> 12), 0); }
vec4 cFetchL(int i) { return texelFetch(uCurveData, ivec2(i & 4095, i >> 12), 0); }

// The crossing-axis lanes. A FILL-only band structure writes, in each entry's free lanes, the
// segment's (min, max) on the list's CROSSING axis -- y for an H list (stripe, pair and AAC level lists alike),
// x for a V list: the control hull of a line, quad or cubic, whose texels hold exactly those floats, and the
// padded tight extent of an arc (svg/textures.js controlHullLanes). It says so in bit 0 of texel 1's .y on
// every band header (band 0's .y is otherwise the AAC level slot, even by construction). Every other
// structure -- a stroke's, a stroked shape's shared one, a morph's, and every bundle written --
// keeps (z, w) = (the far bound on the break axis, 0), and its walkers take no lane reject.
bool bandHasRayLanes(vec4 hdr1) { return (int(hdr1.y) & 1) != 0; }
// Does a FILL walker take the lane reject on this list?
bool fillRayReject(vec4 hdr1) { return bandHasRayLanes(hdr1); }
// A ray at crossing coordinate r cannot cross an entry whose range lies wholly on one side of it -- in the
// solvers' own terms, where 0 counts as NON-NEGATIVE: every end sign, root code and hull test the line, quad
// and cubic walkers apply is a sign of `coordinate - r`, and float subtraction is monotone, so `max - r < 0`
// is exactly "every control coordinate is negative" and `min - r >= 0` "every one is non-negative". No
// tolerance, at any scale; an arc's lane carries its own relative pad. Two compares on a texel the walker
// already holds, and the dependent control fetch and all the math behind it never run.
bool rayLaneMiss(vec4 e, float r) { return e.w - r < 0.0 || e.z - r >= 0.0; }



// Walk one H-band's segment list, accumulating min distance from
// renderCoord across line/quad/cubic/arc sub-loops.
// `gradOut` receives the EM-space unit gradient of the distance field at the
// winning feature, but only when that feature is a LINE-segment BODY — the case
// where the stroke boundary is exactly a straight offset line and its normal is
// known in closed form. Caps, joins and curved segments leave it zero, and the
// caller falls back to the isotropic ramp there. See uStrokeExactAa in
// mantle.frag.glsl for what it is for.
// Can this segment's stroke possibly reach the fragment? The control hull bounds
// the curve, so if the fragment is farther than the stroke's maximum reach from
// that hull, no closest-point solve is needed. Points arrive RELATIVE to the
// fragment, so the fragment is the origin and the distance to the box [lo,hi] is
// max(lo, -hi, 0) per axis.
//
// Worth it because the solve it skips is the expensive half of the walk — a
// cubic's closest point is a quintic — while this is ~8 ops. The band already
// culls by row and by a lower x bound, but nothing bounds a segment lying far
// to the RIGHT of the fragment, so wide shapes walked most of their segments.
bool strokeHullOutOfReach(vec2 lo, vec2 hi, float reach) {
  vec2 dv = max(max(lo, -hi), vec2(0.0));
  return dot(dv, dv) > reach * reach;
}

// A tighter reach gate for a cubic. strokeHullOutOfReach's axis-aligned box is mostly empty for a
// diagonal or winding cubic, so most fragments in a stroke's cover quad passed it and paid the closest-point solve (a
// quintic chain) and the cap/join setup for a segment they cannot reach. The control polygon of each QUARTER of the
// curve (two de Casteljau halvings) bounds that quarter, and an oriented box in the quarter's own chord frame bounds
// the polygon, so a fragment whose distance to every quarter's box exceeds the reach is farther than the reach from the
// curve, and from both ends, which lie on the first and last quarter. The same claim the box test makes, with a
// tighter hull: skipping a segment this rejects changes nothing the walk returns within the reach. Points are RELATIVE
// to the fragment (it is the origin). Nothing here is absolute: the frame is the quarter's own chord (an orthonormal
// frame whatever its length, the axes when the chord is zero), and the slack is relative to the pieces' extent.
bool strokeCubicPieceOut(vec2 a, vec2 b, vec2 c, vec2 d, float reach) {
  vec2 ch = d - a;
  float len = length(ch);
  vec2 u = len > 0.0 ? ch / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  vec4 su = vec4(dot(a, u), dot(b, u), dot(c, u), dot(d, u));
  vec4 sv = vec4(dot(a, v), dot(b, v), dot(c, v), dot(d, v));
  float lu = min(min(su.x, su.y), min(su.z, su.w)), hu = max(max(su.x, su.y), max(su.z, su.w));
  float lv = min(min(sv.x, sv.y), min(sv.z, sv.w)), hv = max(max(sv.x, sv.y), max(sv.z, sv.w));
  vec2 g = vec2(max(max(lu, -hu), 0.0), max(max(lv, -hv), 0.0));
  vec4 ab = abs(vec4(a, b)), cd = abs(vec4(c, d));
  float r = reach * 1.0001 + 4e-6 * max(max(max(ab.x, ab.y), max(ab.z, ab.w)), max(max(cd.x, cd.y), max(cd.z, cd.w)));
  return dot(g, g) > r * r;
}
/// A cubic's left half in place (de Casteljau at 1/2), its right half out.
void strokeCubicSplit(inout vec2 a, inout vec2 b, inout vec2 c, inout vec2 d, out vec2 ra, out vec2 rb, out vec2 rc) {
  vec2 ab = 0.5 * (a + b), bc = 0.5 * (b + c), cd = 0.5 * (c + d);
  vec2 abc = 0.5 * (ab + bc), bcd = 0.5 * (bc + cd);
  vec2 m = 0.5 * (abc + bcd);
  ra = m; rb = bcd; rc = cd;
  b = ab; c = abc; d = m;
}
bool strokeCubicOutOfReach(vec4 p12, vec4 p34, float reach) {
  vec2 a = p12.xy, b = p12.zw, c = p34.xy, d = p34.zw;
  vec2 ra, rb, rc;
  strokeCubicSplit(a, b, c, d, ra, rb, rc);              // left half in (a, b, c, d); right half (ra, rb, rc, p34.zw)
  vec2 rd = p34.zw;
  vec2 qa, qb, qc;
  strokeCubicSplit(a, b, c, d, qa, qb, qc);              // left quarter in (a..d); second quarter (qa, qb, qc, left half's end)
  vec2 qd = ra;
  if (!strokeCubicPieceOut(a, b, c, d, reach)) return false;
  if (!strokeCubicPieceOut(qa, qb, qc, qd, reach)) return false;
  strokeCubicSplit(ra, rb, rc, rd, qa, qb, qc);          // third quarter in (ra..rd); fourth (qa, qb, qc, p34.zw)
  if (!strokeCubicPieceOut(ra, rb, rc, rd, reach)) return false;
  return strokeCubicPieceOut(qa, qb, qc, p34.zw, reach);
}

/// The same gate for a QUADRATIC: its two halves' control triangles, each bounded by an oriented box in
/// its own chord frame (strokeCubicPieceOut with the middle point repeated is that triangle's box).
bool strokeQuadOutOfReach(vec2 a, vec2 b, vec2 c, float reach) {
  vec2 m1 = 0.5 * (a + b), m2 = 0.5 * (b + c), m = 0.5 * (m1 + m2);
  return strokeCubicPieceOut(a, m1, m1, m, reach) && strokeCubicPieceOut(m, m2, m2, c, reach);
}

// ---- STROKE SPACE ----
// A stroke row whose CTM was not conformal is drawn in STROKE SPACE: its element's local space scaled by the CTM's
// larger singular value. Its segments stay in document space in the curve plane; the walk maps each, relative to the
// fragment, through the row's frame N (meta texel 5, column-major), and measures width, dashes, caps and joins there.
// N never shrinks a vector, so every document-space bound the walk and the encoder use (band pads, the break and far
// gates, cover quads) is still a bound when read in stroke-space units.
vec2 strokeFrameMul(vec4 N, vec2 v) { return vec2(N.x * v.x + N.z * v.y, N.y * v.x + N.w * v.y); }
vec2 strokeFrameMulT(vec4 N, vec2 v) { return vec2(N.x * v.x + N.y * v.y, N.z * v.x + N.w * v.y); }
/// A document-space unit direction (a join tangent) as the stroke-space unit direction; a zero one stays zero.
vec2 strokeFrameDir(vec4 N, vec2 t) { return strokeUnit(strokeFrameMul(N, t)); }
/// An ARC under N, in place: d1 = (center RELATIVE TO THE FRAGMENT, rx, ry), d2 = (th0, th1, phi, _). A linear map
/// takes an ellipse to an ellipse: A = N R(phi) diag(rx, ry) = R(phi') diag(sx, sy) R(theta) by the closed-form 2x2
/// SVD, so the arc at th maps to the image's arc at th + theta, and a negative sy (N reflects) to -(th + theta) with
/// |sy| -- the same point, so the fraction of the sweep, and with it the dash distance and the cap parameter, carry
/// over. src/bundle/strokeFrame.js strokeFrameArc is the JS twin.
void strokeFrameArc(vec4 N, inout vec4 d1, inout vec4 d2) {
  float cp = cos(d2.z), sp = sin(d2.z);
  vec2 c0 = strokeFrameMul(N, vec2(cp, sp)) * d1.z;          // A's columns
  vec2 c1 = strokeFrameMul(N, vec2(-sp, cp)) * d1.w;
  float E = 0.5 * (c0.x + c1.y), F = 0.5 * (c0.x - c1.y), G = 0.5 * (c0.y + c1.x), H = 0.5 * (c0.y - c1.x);
  float Q = length(vec2(E, H)), R = length(vec2(F, G));
  // The image of a circle comes out of float32 a few ulps from a circle (R, or Q reflected, a rounding instead of zero);
  // distToEllipse takes such radii exactly (its near-circle foot), so nothing is snapped. A term that IS zero has
  // a free angle, and takes 0: atan(0, 0) is undefined in GLSL.
  float a1 = R > 0.0 ? curveAtan2(G, F) : 0.0, a2 = Q > 0.0 ? curveAtan2(H, E) : 0.0;
  float theta = 0.5 * (a2 - a1), sy = Q - R;
  float sgn = sy < 0.0 ? -1.0 : 1.0;
  d1 = vec4(strokeFrameMul(N, d1.xy), Q + R, abs(sy));
  d2 = vec4(sgn * (d2.x + theta), sgn * (d2.y + theta), 0.5 * (a2 + a1), d2.w);
}

/// A stroke-space edge record's signed distance in DOCUMENT space: each plane's stroke-space distance
/// over how far the frame stretches its normal (the plane n.p + e <= 0 is (N^T n).x + e <= 0 in document space); an
/// intersection is its farther plane, a union its nearer, a disc its radial plane. `fallback` for a record with no
/// boundary: the walk's distance past halfW, read as far off on screen as the frame allows (see its caller).
float seDocKey(vec4 P, vec4 Q, vec4 N, float fallback) {
  if (P.w == 0.0) return fallback;           // a join's or end's own record holds no plane: the distance's
  float k1 = P.z / length(strokeFrameMulT(N, P.xy));
  if (P.w == 9.0 && dot(Q.xy, Q.xy) > 0.5) return max(k1, Q.z / length(strokeFrameMulT(N, Q.xy)));   // a slab: its
  if (P.w == 1.0 || P.w == 4.0 || P.w >= 5.0) return k1;                     // near side is nearer than its far one
  float k2 = Q.z / length(strokeFrameMulT(N, Q.xy));
  return P.w == 2.0 ? max(k1, k2) : min(k1, k2);
}


float strokeAaReachEm(float halfW, vec2 ePx) {
  return max(0.25 * (ePx.x + ePx.y) - halfW, 0.0) + 0.5 * length(ePx);
}

// Where a RAMP-only stroke's coverage is certainly saturated: maskBake's stroke child uses
// this bar. It is the distance below which its ramp (strokeEdgeCov), clamp(0.5 - (minD - halfWVis) / max(pxSize,
// 1e-30), 0, 1), is exactly 1 -- the ramp's guard, for a zero derivative only. The bar takes no em floor (1e-6) either:
// below 1e-6 em per pixel it would sit deeper inside than the ramp's edge -- never wrong, but the walk would stop later
// than it could. Passed to strokeMinDist as satD, it lets the band walk stop at the first segment
// that saturates the pixel instead of walking every segment (-1e20 never fires). The ubershader's
// pattern and inline-mask stroke children share the ramp but still pass -1e20: a live bar in those
// rarely run walks moves the timing of unrelated draws of the same program on the GPU queue by tens
// of percent, either way.
// The walk's early return hands back its running minimum, which is >= the true one but also <= satD,
// so both read 1 and the coverage is unchanged. The ramp saturates at minD <= halfWVis - 0.5 * p;
// the bar sits 0.001 p plus 1e-6 * halfWVis (eight float ulps of it) inside that, so the float
// evaluation of the ramp at any minD below it is >= 1.0009 whatever the rounding of the subtraction
// and the divide. A hairline (halfWVis <= 0.501 p) gets a negative bar, which never fires, as before.
float strokeRampSatD(float halfWVis, float pxSize) {
  float p = max(pxSize, 1e-30);
  return halfWVis - 0.501 * p - 1e-6 * halfWVis;
}

// The join's record for a line's body pixel near its vertex. A pixel whose closest feature is a line's BODY
// takes the body's side as its boundary; but where the pixel box reaches past that end's plane, on the outer side of the
// turn, the boundary there is the JOIN's -- the round join's arc, the bevel's chord, the miter's other side, the clip
// line -- and the side alone ran on past the end plane: every such pixel read the miter's coverage (a bevel 57.5/255 over
// SVG 2's at a sharp turn, a round join 5.5/255 at half-width 1.5). This is the record the join branches write for a
// fragment past the end plane (q = fragment - V; din / dout the path's directions into and out of V), and it holds the
// bodies too: each plane lies wholly outside both segments' rectangles on this side -- the other side, the chord and the
// clip line pass beyond the vertex's outer offset points -- and the disc keeps the slab behind its plane.
void seJoinRecord(vec2 q, vec2 din, vec2 dout, bool ownIn, int joinStyle, float miterLimit, float halfW, float reach,
                  out vec4 P, out vec4 Q) {
  P = vec4(0.0); Q = vec4(0.0);
#ifdef MANTLE_STROKE_EXACT
  // a round join: the disc about the vertex with this segment's slab behind its end plane (`ownIn`: this segment is the
  // one arriving). The join branches choose the nearer body's plane; a pixel of this body is in this body.
  if (joinStyle == 1) { seDisc(P, Q, q, ownIn ? din : -dout, halfW); return; }
  // the two OUTER sides, by the turn (not the fragment's side of each line: a body pixel can lie on the inner side of the
  // neighbor's line produced back through the vertex, and that plane would cut its own body)
  float cr = din.x * dout.y - din.y * dout.x, sd = cr >= 0.0 ? 1.0 : -1.0;
  vec2 nA = sd * vec2(din.y, -din.x), nB = sd * vec2(dout.y, -dout.x);
  seAnd(P, Q, nA, dot(q, nA) - halfW, reach); seAnd(P, Q, nB, dot(q, nB) - halfW, reach);
  float sinHalf = 0.5 * length(din + dout);   // sin(theta/2) of the interior angle: half the distance between (-din) and dout (_strokeMath.glsl's miter branch says why)
  bool fits = halfW / max(sinHalf, 1.17549435e-38) <= halfW * miterLimit;
  if (joinStyle == 2 || (joinStyle == 0 && !fits)) {
    vec2 nb = nA + nB;
    float bl = length(nb);
    if (bl > 1e-4) { vec2 bis = nb / bl; seAnd(P, Q, bis, dot(q, bis) - halfW * dot(nA, bis), reach); }
  } else if ((joinStyle == 3 || joinStyle == 4) && !fits) {
    vec2 tipDir = din - dout;
    float tipLen = length(tipDir);
    if (tipLen > 1e-4) seAnd(P, Q, tipDir / tipLen, dot(q, tipDir) / tipLen - halfW * max(miterLimit, 1.0), reach);
  }
#endif
}

bool seNearOuterJoin(vec2 q, vec2 din, vec2 dout, vec2 own, vec2 uOut, vec2 cpV, float reach) {
  float cr = din.x * dout.y - din.y * dout.x;
  if (cr == 0.0 || dot(q, uOut) <= -reach || length(cpV) > 2.0 * reach + max(-dot(q, uOut), 0.0)) return false;
  vec2 nOwn = (cr >= 0.0 ? 1.0 : -1.0) * vec2(own.y, -own.x);           // this segment's outer normal
  return dot(q, nOwn) > 0.0;
}

// `N` / `framed`: a stroke-space row's frame (see strokeFrameMul above). When `framed`, each segment is mapped into
// stroke space relative to the fragment before anything reads it, halfW / satD / aaEm are stroke-space, and the
// distance and normal come back in stroke space; the entry and break axes stay document-space bounds. When not,
// nothing below changes: the conformal walk is the one that always ran.
float strokeBandAccum(ivec2 gl, int hdrSlot,
                          vec2 c, float halfW,
                          int startCap, int endCap,
                          int joinStyle, float miterLimit,
                          int dashId, float minDIn, out vec2 gradOut, float satD, float aaEm,
                          vec4 N, bool framed, out vec4 edgeP, out vec4 edgeQ) {
  gradOut = vec2(0.0);
  // The winner's edge record: what its boundary is, for the exact coverage.
  edgeP = vec4(0.0); edgeQ = vec4(0.0);
  // The band's own counts bound every walk below -- there is no constant to exceed.

  // A count is read once here, from the band header the encoder wrote, and is the segment count for
  // this band and type. Bounding each walk by it is both correct and the tighter loop.
  int hdrL = texLin(gl) + hdrSlot;          // the band header, as a linear index
  vec4 cnts = bFetchL(hdrL);
  int nLine  = int(cnts.x);
  int nQuad  = int(cnts.y);
  int nCubic = int(cnts.z);
  int nArc   = int(cnts.w);
  vec4 hdr1 = bFetchL(hdrL + 1);
  int hE = texLin(gl) + int(hdr1.x);         // the list's first entry, linear; steps past each type's run
  // The far gate reads an entry's z as its far bound, which only a structure WITHOUT lanes holds. The
  // encoder writes lanes only where no stroke walks, so this is a guard, not a path: a lane structure reached
  // here walks without the gate, as it did before the gate existed.
  bool farGate = uStrokeGates != 0 && !bandHasRayLanes(hdr1);
  float minD = minDIn;
  // Conservative stroke reach for the hull reject: caps, round and bevel stay
  // within halfW of the skeleton; a miter runs out to halfW * miterLimit past a
  // vertex. A CLIPPED miter (miter-clip, and arcs, which SVG 2 sends to miter-clip
  // on straight segments) is cut at halfW * miterLimit along the bisector, but the
  // clip line's two corners sit up to halfW to either side of it, so they are up to
  // halfW * sqrt(miterLimit^2 + 1) from the vertex (the bound approached by a
  // near-reversal). A square cap's outer corners are sqrt(2) * halfW from the
  // endpoint, which sits on the hull, so a curve's hull reject cut them off at
  // halfW. src/bundle/strokeReach.js is the JS copy of this bound.
  float _ml = max(miterLimit, 1.0);
  float _reach = halfW * max((joinStyle == 0 ? _ml
                              : (joinStyle == 3 || joinStyle == 4) ? sqrt(_ml * _ml + 1.0) : 1.0),
                             (startCap == 2 || endCap == 2) ? 1.41421356 : 1.0) + aaEm;

  // ---- LINES ----
  //
  // Body envelope for a line seg = pixels within halfW perpendicular
  // distance of the seg, within its [0, length] body extent. Past
  // either endpoint the coverage depends on cap / join style:
  //
  //   freeStart/freeEnd (no neighbor):
  //     cap == 0 BUTT   : the tube cut by the end plane, as an SDF (no drop).
  //     cap == 1 ROUND  : radial distance from endpoint (= length(c-a)).
  //     cap == 2 SQUARE : the halfW-deep box past the end, as an SDF: the larger
  //                       of the perpendicular distance and `along`.
  //
  //   Interior (joined to a neighbor):
  //     joinStyle == 0 MITER : perpendicular distance to extended-tangent
  //                           line, gated by along ∈ [0, miterLen] AND
  //                           by being on the OUTER side of the bend.
  //                           sinHalf = sqrt(0.5*(1-dot(-segTan, inTan)))
  //                           determines miterLen = halfW/sinHalf; past
  //                           miterLimit it is a BEVEL, as SVG 2 specifies.
  //     joinStyle == 1 ROUND : radial distance from endpoint, inside the join
  //                            wedge — which makes it SVG 2's circular sector.
  //     joinStyle == 2 BEVEL : the radial distance CLIPPED to the bevel chord
  //                            (the branch below); the inner overlap is covered
  //                            by the two bodies.
  //     joinStyle == 3 MITER-CLIP, and 4 ARCS (SVG 2: "If both curvatures are zero
  //                            fall through to miter-clip", which straight segments
  //                            always do) : the miter within the limit; past it the
  //                            miter kite CUT by the line perpendicular to the
  //                            bisector at halfW * miterLimit from the vertex.
  //     Outside the join wedge an interior end is a BUTT end (see below).

  // This gate is not the one that cracked. _strokeMath.glsl's curve path had a
  // gate of the same shape written as `drop = true`, and the wedge between the
  // two perpendiculars belonged to NEITHER segment — a hairline across the band
  // at every tangent break. Here the wedge is the one place the join is drawn,
  // and both segments meeting at a vertex evaluate it (a pixel in it is past the
  // incoming segment's end and before the outgoing one's start), so it cannot
  // crack; outside it each end is a butt end with an AA ramp across its own end
  // plane, never a drop. test/strokeLineJoinSvgShapeSmoke.mjs checks this against
  // SVG 2's stroke shape.
  // Break-early threshold hoisted out of the four per-segment tests below.
  float sBreak = c.x - halfW - aaEm;
  float sFar = c.x + _reach;
  // The winner in document space. A framed row's distances are stroke-space, and the frame stretches
  // each direction by its own amount: two features a pixel apart on screen can come out in either order in stroke space,
  // and the one taken for the pixel's coverage would then be the one farther off on screen. The walk's distance (minD, which
  // the saturation and the ramp read) is still the stroke-space minimum; the EDGE RECORD is the one nearest on screen.
  float bestKey = 1e30;
  // A record with no boundary has only the stroke-space distance e, which is e / k on screen for a stretch k between 1
  // and kMaxN (N's singular values): it is priced at the far end of that range, so a feature with a real edge nearer on
  // screen takes the pixel from it.
  float kMaxN = length(vec2(0.5 * (N.x + N.w), 0.5 * (N.y - N.z))) + length(vec2(0.5 * (N.x - N.w), 0.5 * (N.y + N.z)));
  // The distance of the nearest segment OTHER than the record's (see the union's check at the end): the smallest and
  // second-smallest segment distances, and the record's own.
  float minD2 = 1e20, winD = 1e20;
  vec2 secN = vec2(0.0); float secE = 1e20;   // the second-nearest body's plane, where its record is a plain side
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;
    int sL = int(segRaw.x);
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue; // fill-only synthetic close
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);                      // a closed dashed contour's seam: _strokeMath.glsl
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    vec4 pts = cFetchL(sL + 1);
    // Join tangents at sL+2: (inTan.x, inTan.y, outTan.x, outTan.y).
    // Zero vectors when this end is a free cap (no neighbor) -- so a segment free at both ends has nothing there, and
    // does not fetch it.
    vec4 jn = (freeStart && freeEnd) ? vec4(0.0) : cFetchL(sL + 2);
    vec2 inTan  = jn.xy;
    vec2 outTan = jn.zw;
    vec2 a = pts.xy;
    vec2 b = pts.zw;

    vec2 cq = c;
    if (framed) {
      a = strokeFrameMul(N, a - c); b = strokeFrameMul(N, b - c); cq = vec2(0.0);
      inTan = strokeFrameDir(N, inTan); outTan = strokeFrameDir(N, outTan);
    }
    vec2 ab = b - a;

    float abLen2 = dot(ab, ab);
    // A standalone zero-length subpath has no butt-cap stroke area.
    if (abLen2 == 0.0 && freeStart && freeEnd && startCap == 0 && endCap == 0) continue;
    float abLen = sqrt(abLen2);
    float tRaw = abLen2 > 0.0 ? dot(cq - a, ab) / abLen2 : 0.0;
    vec2 segTan = abLen > 0.0 ? ab / abLen : ab;
    bool drop = false;
    // `thisD` is the distance this seg contributes for pixel `cq`. It
    // starts as the closest-point distance for pixels inside the body
    // extent and is overridden by the cap / miter / body-extension
    // logic below for pixels past either endpoint. -1 means "compute
    // closest-point distance later".
    float thisD = -1.0;
    // This segment's edge record: each branch below says what its boundary is -- a cap is the slab cut by its
    // plane (butt, square) or the disc (round), a join the two outer sides cut by its chord or clip line, or its disc.
    vec4 sP = vec4(0.0), sQ = vec4(0.0);
    bool joinRec = false;                                  // the record is the join's own
    if (tRaw < 0.0) {
      if (freeStart) {
        sP = seSlab(cq - a, segTan, halfW, aaEm);
        float aR = dot(cq - a, -segTan);
        if (startCap == 0) seAnd(sP, sQ, -segTan, aR, aaEm);
        else if (startCap == 2) seAnd(sP, sQ, -segTan, aR - halfW, aaEm);
        else seDisc(sP, sQ, cq - a, -segTan, halfW);
        if (startCap == 0) {
          // Butt cap as an SDF, not a hard drop — see _strokeMath.glsl. A drop
          // makes the cap plane binary, so the pixel it bisects gets all or
          // nothing where the truth is a partial. tRaw < 0 here, so the closest
          // point on the segment IS the endpoint and its distance is |cq - a|;
          // intersect that with the half-space behind the cap plane.
          thisD = max(length(cq - a), halfW + dot(cq - a, -segTan));
        }
        else if (startCap == 2) {

          float along = dot(cq - a, -segTan);
          thisD = max(length((cq - a) + segTan * along), along);
        }
        // startCap == 1 (round): leave thisD = -1; closest-point
        // fallback below gives length(cq - a), the round-cap distance.
      } else {
                //
        bool ourTerritory = dot(cq - a, inTan) >= 0.0;
        if (!ourTerritory) {
          thisD = max(length(cq - a), halfW + dot(cq - a, -segTan));
          sP = seSlab(cq - a, segTan, halfW, aaEm);                        // the butt end: its side and its plane
          seAnd(sP, sQ, -segTan, dot(cq - a, -segTan), aaEm);
        } else {
          float cosBetween = dot(-segTan, inTan);
          float sinHalf = 0.5 * length(segTan + inTan);   // half the distance between (-segTan) and inTan: exact near a reversal
          float miterLen = halfW / max(sinHalf, 1.17549435e-38);
          // the record: a round join's disc, with the body whose tangent point is nearer behind its plane; any other
          // join's two outer sides (meeting at the miter's tip), cut by the chord or the clip line below
          if (joinStyle == 1) seDisc(sP, sQ, cq - a, dot(cq - a, inTan) <= dot(cq - a, -segTan) ? inTan : -segTan, halfW);
          else { seAnd(sP, sQ, seSide(cq - a, segTan, halfW), aaEm); seAnd(sP, sQ, seSide(cq - a, inTan, halfW), aaEm); }
          // A miter past its limit IS a bevel (SVG 2: "return bevel"), not a round join.
          bool bevelHere = joinStyle == 2 || (joinStyle == 0 && !(miterLen <= halfW * miterLimit));
          if (bevelHere) {
            // Exact bevel: clip the radial round corner to the bevel chord — the
            // line joining the two segments' outer offsets (hw·nA, hw·nB) — as an AA
            // distance (coverage crosses 0.5 at the chord). tA=inTan, tB=segTan.
            float cr = inTan.x * segTan.y - inTan.y * segTan.x;
            float sd = (cr >= 0.0) ? 1.0 : -1.0;
            vec2 nA = sd * vec2(inTan.y, -inTan.x), nB = sd * vec2(segTan.y, -segTan.x);
            vec2 nb = nA + nB; float bl = length(nb);
            if (bl > 1e-4) { vec2 bis = nb / bl;
              thisD = max(length(cq - a), halfW + dot(cq - a, bis) - halfW * dot(nA, bis));
              seAnd(sP, sQ, bis, dot(cq - a, bis) - halfW * dot(nA, bis), aaEm); }
            else {   // an exact reversal: the chord between the outer offsets passes through the vertex, a bevel of no area -- a butt end
              thisD = max(length(cq - a), halfW + dot(cq - a, -segTan));
              seAnd(sP, sQ, -segTan, dot(cq - a, -segTan), aaEm); }
          }
          float along = dot(cq - a, -segTan);
          float capAlong = 0.0;
          // Within the limit miter (0), miter-clip (3) and arcs (4) are one shape:
          // straight edges have zero curvature, so SVG 2 sends arcs to miter-clip,
          // and miter-clip only differs from miter past the limit (the branch after
          // this one).
          if (joinStyle == 0 || joinStyle == 3 || joinStyle == 4) {
            // Miter length is halfW / sin(theta/2), NOT / cos(theta/2).
            //
            // `cosBetween` is the cosine of the INTERIOR angle theta between the
            // two segments at the vertex, so the half-angle identity needed here
            // is sin(theta/2) = sqrt((1 - cos theta)/2). The `1 + cosBetween`
            // form yields cos(theta/2) and is inverted: it makes miters too SHORT
            // at sharp corners and unbounded at flat ones. Sanity check at
            // theta = 180 (collinear): the true miter is exactly halfW, while
            // halfW/cos(90deg) diverges.
            //
            //
            // This is the LINE-segment join, and it is NOT dead: strokeBandAccum
            // walks lines inline and calls _strokeMath.glsl's
            // strokeCapsJoinsDash for quads, cubics and arcs, so the two
            // implement one rule over disjoint segment types.

            // (Shaders are assembled into generated/ and loadShaders fetches
            // those first, so `npm run build:shaders` must run before an edit
            // here can be observed at all.)
            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 0.0));
            if (miterLen <= halfW * miterLimit) capAlong = miterLen * cosHalf;
          }
          if (along <= capAlong) {
            float perpThis = length((cq - a) + segTan * along);
            // Perpendicular distance to the OTHER (incoming) seg's
            // tangent line at the vertex. The line passes through a
            // (the join vertex) with direction inTan; the normal is
            // perp(inTan) = (-inTan.y, inTan.x).
            vec2 nIn = vec2(-inTan.y, inTan.x);
            float perpOther = abs(dot(cq - a, nIn));
            // Use the LARGER of the two perpendiculars so the pixel
            // is in the wedge iff both ≤ halfW (AA falloff compares minD
            // against halfW).
            thisD = max(perpThis, perpOther);
          } else if ((joinStyle == 3 || joinStyle == 4) && !(miterLen <= halfW * miterLimit)) {
            // CLIPPED MITER, past the limit. SVG 2: "clip any part of the line join
            // region that extends past the miter limit" -- the line perpendicular to
            // the bisector at halfW * miterLimit from the vertex. Inside the wedge the
            // miter region is the kite where both perpendiculars are <= halfW, so the
            // clipped join is that kite intersected with the half-plane behind the
            // clip line, as an SDF: the largest of the three plane distances, the
            // clip plane's written like the butt end's (halfW + how far past it).
            // The clip is at no less than halfW (_ml = max(miterLimit, 1); SVG 2 makes a
            // limit under 1 an error), so it never reaches the bevel triangle and the
            // bevel is inside this region. Drawn ROUND (the radial fall-through), the
            // whole spike would be left unpainted.
            //
            // The tip direction is -segTan + inTan (the two outward directions at the
            // vertex), not the nA + nB of the bevel branch: at a near-reversal, where
            // the clipped spike is longest, nA + nB cancels while this does not. Its
            // length is 2 cos(theta/2), which only vanishes near collinear, where
            // the tip is within a hair of halfW and the clip has nothing to cut.
            float perpThis = length((cq - a) + segTan * along);
            float perpOther = abs(dot(cq - a, vec2(-inTan.y, inTan.x)));
            vec2 tipDir = inTan - segTan;
            float tipLen = length(tipDir);
            thisD = max(perpThis, perpOther);
            if (tipLen > 1e-4)
              thisD = max(thisD, halfW + dot(cq - a, tipDir) / tipLen - halfW * _ml);
            if (tipLen > 1e-4) seAnd(sP, sQ, tipDir / tipLen, dot(cq - a, tipDir) / tipLen - halfW * _ml, aaEm);
          }
        }
      }
    }
    if (tRaw > 1.0) {
      if (freeEnd) {
        sP = seSlab(cq - b, segTan, halfW, aaEm);                        // the record: see the start twin
        float aR = dot(cq - b, segTan);
        if (endCap == 0) seAnd(sP, sQ, segTan, aR, aaEm);
        else if (endCap == 2) seAnd(sP, sQ, segTan, aR - halfW, aaEm);
        else seDisc(sP, sQ, cq - b, segTan, halfW);
        if (endCap == 0) {
          // Butt cap as an SDF — see the start twin.
          thisD = max(length(cq - b), halfW + dot(cq - b, segTan));
        }
        else if (endCap == 2) {
          // Square cap as an SDF — see the start twin.
          float along = dot(cq - b, segTan);
          thisD = max(length((cq - b) - segTan * along), along);
        }
      } else {
        // Outside the join wedge a BUTT end; a miter past its limit a bevel (see the
        // start-vertex twin above).
        bool ourTerritory = dot(cq - b, -outTan) >= 0.0;
        if (!ourTerritory) {
          thisD = max(length(cq - b), halfW + dot(cq - b, segTan));
          sP = seSlab(cq - b, segTan, halfW, aaEm);
          seAnd(sP, sQ, segTan, dot(cq - b, segTan), aaEm);
        } else {
          // halfW/sin(theta/2) — see the start twin above for why.
          float cosBetween = dot(segTan, -outTan);
          float sinHalf = 0.5 * length(segTan + outTan);   // half the distance between segTan and (-outTan)
          float miterLen = halfW / max(sinHalf, 1.17549435e-38);
          if (joinStyle == 1) seDisc(sP, sQ, cq - b, dot(cq - b, segTan) <= dot(cq - b, -outTan) ? segTan : -outTan, halfW);
          else { seAnd(sP, sQ, seSide(cq - b, segTan, halfW), aaEm); seAnd(sP, sQ, seSide(cq - b, outTan, halfW), aaEm); }
          bool bevelHere = joinStyle == 2 || (joinStyle == 0 && !(miterLen <= halfW * miterLimit));
          if (bevelHere) {
            // exact BEVEL (see the start-vertex twin above). tA=segTan, tB=outTan.
            float cr = segTan.x * outTan.y - segTan.y * outTan.x;
            float sd = (cr >= 0.0) ? 1.0 : -1.0;
            vec2 nA = sd * vec2(segTan.y, -segTan.x), nB = sd * vec2(outTan.y, -outTan.x);
            vec2 nb = nA + nB; float bl = length(nb);
            if (bl > 1e-4) { vec2 bis = nb / bl;
              thisD = max(length(cq - b), halfW + dot(cq - b, bis) - halfW * dot(nA, bis));
              seAnd(sP, sQ, bis, dot(cq - b, bis) - halfW * dot(nA, bis), aaEm); }
            else {   // an exact reversal (see the start twin)
              thisD = max(length(cq - b), halfW + dot(cq - b, segTan));
              seAnd(sP, sQ, segTan, dot(cq - b, segTan), aaEm); }
          }
          float along = dot(cq - b, segTan);
          float capAlong = 0.0;
          // Within the limit miter, miter-clip and arcs are one shape (see start twin).
          if (joinStyle == 0 || joinStyle == 3 || joinStyle == 4) {

            float cosHalf = sqrt(max(0.5 * (1.0 + cosBetween), 0.0));
            if (miterLen <= halfW * miterLimit) capAlong = miterLen * cosHalf;
          }
          if (along <= capAlong) {
            float perpThis = length((cq - b) - segTan * along);
            vec2 nOut = vec2(-outTan.y, outTan.x);
            float perpOther = abs(dot(cq - b, nOut));
            thisD = max(perpThis, perpOther);
          } else if ((joinStyle == 3 || joinStyle == 4) && !(miterLen <= halfW * miterLimit)) {
            // Clipped miter past the limit (see the start twin). Tip direction:
            // segTan - outTan.
            float perpThis = length((cq - b) - segTan * along);
            float perpOther = abs(dot(cq - b, vec2(-outTan.y, outTan.x)));
            vec2 tipDir = segTan - outTan;
            float tipLen = length(tipDir);
            thisD = max(perpThis, perpOther);
            if (tipLen > 1e-4)
              thisD = max(thisD, halfW + dot(cq - b, tipDir) / tipLen - halfW * _ml);
            if (tipLen > 1e-4) seAnd(sP, sQ, tipDir / tipLen, dot(cq - b, tipDir) / tipLen - halfW * _ml, aaEm);
          }
        }
      }
    }
    // A DASH CAP PAST A VERTEX (strokeCapsJoinsDash has the curve twin): a dash that ends (starts) short of this interior
    // vertex has a square or round cap that reaches round the corner, where the join logic above dropped or butted this
    // segment. The pixel's distance to that cap -- across the segment's line, and along the path to the dash end -- is a
    // candidate beside the join's, wherever the dash end lies on this segment.
    float dSpill = 1e30;
    if (dashId > 0 && ((tRaw < 0.0 && !freeStart && startCap != 0) || (tRaw > 1.0 && !freeEnd && endCap != 0))) {
      bool atSp = tRaw < 0.0;
      vec2 vSp = cq - (atSp ? a : b);
      float aSp = dot(vSp, segTan);
      float latSp = length(vSp - segTan * aSp);
      vec2 rSp = dashCapReach(dashId, hdr.w + tRaw * abLen, startCap == 0 && endCap == 0);
      float oSp = atSp ? rSp.y : rSp.x;
      bool seamHere = (atSp ? strokeSeamMergeLo : strokeSeamMergeHi) && abs(oSp - abs(aSp)) <= strokeSeamTol;   // see _strokeMath.glsl: no boundary at a seam the dash passes through
      if (oSp >= abs(aSp) * 0.999995 && oSp < 1e29 && !seamHere) dSpill = (atSp ? startCap : endCap) == 2 ? max(latSp, oSp) : length(vec2(latSp, oSp));
    }
    if (drop) {
      if (dSpill < minD) {
        minD2 = minD; minD = dSpill; gradOut = vec2(0.0);
        if (!framed) { edgeP = vec4(0.0); edgeQ = vec4(0.0); winD = dSpill; }
        else {
          float key = seDocKey(vec4(0.0), vec4(0.0), N, dSpill > halfW ? dSpill - halfW : (dSpill - halfW) / kMaxN);
          if (key < bestKey) { bestKey = key; edgeP = vec4(0.0); edgeQ = vec4(0.0); winD = dSpill; }
        }
      }
      continue;
    }
    float tC = clamp(tRaw, 0.0, 1.0);
    // thisD < 0 means no cap/join branch claimed this pixel, so the closest
    // feature is the segment BODY and the boundary there is the straight offset
    // line — its normal is exactly the unit vector from the closest point.
    bool bodyHit = thisD < 0.0;
    vec2 bodyG = vec2(0.0);
    if (bodyHit) {
      vec2 closestPt = mix(a, b, tC);
      vec2 g = cq - closestPt;
      thisD = length(g);
      // A normal wherever the distance is not exactly zero (g / max(thisD, 1e-12) would give a pixel within 1e-12 of the
      // centerline at 2^-20 one shorter than a unit). At exactly zero g is zero, and so is the normal.
      bodyG = thisD > 0.0 ? g / thisD : g;
      // the record: the side, an offset line (unless a round cap or join, or a miter's tip, already said otherwise);
      // where the box reaches the other side too, both (op 9), and on the centerline, where the side had no normal and the ramp read 1, the slab as well
      if (sP.w == 0.0) sP = thisD > 0.0 ? vec4(bodyG, thisD - halfW, -thisD - halfW > -aaEm ? 9.0 : 1.0)
                                        : seSlab(cq - a, segTan, halfW, aaEm);
      // A free butt end's plane cuts the body from INSIDE too. The cap branch
      // above only sees pixels past the end (tRaw < 0 / > 1), so without this
      // only the outer half of the end's AA ramp existed and the pixels just
      // inside painted solid; a center exactly on the plane went solid or half
      // by the rounding of cq.
      float endD = -1.0;
      if (freeStart && startCap == 0) endD = halfW + dot(cq - a, -segTan);
      if (freeEnd && endCap == 0) endD = max(endD, halfW + dot(cq - b, segTan));
      // the record: the end planes (a far one lies wholly beyond the pixel box, and seAnd leaves it out)
      if (freeStart && startCap == 0) seAnd(sP, sQ, -segTan, dot(cq - a, -segTan), aaEm);
      if (freeEnd && endCap == 0) seAnd(sP, sQ, segTan, dot(cq - b, segTan), aaEm);
      if (endD > thisD) { thisD = endD; bodyHit = false; }
      // THE INSIDE OF A TURN (the record; _strokeMath.glsl has the curve twin): near an interior end, a pixel on the
      // turn's inner side has the neighbor's side take over from this one's -- a concave corner, the union of the two.
      bool atEndU = freeStart || (!freeEnd && tRaw >= 0.5);   // the interior end; of two, the nearer
      // ...and on the OUTER side, past that end's plane within the pixel box, the join's own record (seJoinRecord):
      // the side alone ran on past the plane, where the boundary is the arc, the chord or the other side. (Not
      // under a dash: its planes cut the record next, and a disc record is not one they intersect exactly. Not in a
      // stroke-space row: its winner is the record nearest ON SCREEN (seDocKey), and the join's record, priced from the
      // vertex, lost that to a farther segment's.)
      if (dashId == 0 && !framed && (sP.w == 1.0 || sP.w == 9.0) && (atEndU ? !freeEnd : !freeStart)) {
        vec2 qJ = cq - (atEndU ? b : a), dIn = atEndU ? segTan : inTan, dOut = atEndU ? outTan : segTan;
        joinRec = seNearOuterJoin(qJ, dIn, dOut, segTan, atEndU ? segTan : -segTan, mix(a, b, tC) - (atEndU ? b : a), aaEm);
        if (joinRec) seJoinRecord(qJ, dIn, dOut, atEndU, joinStyle, miterLimit, halfW, aaEm, sP, sQ);
      }
      if ((sP.w == 1.0 || sP.w == 9.0) && (atEndU ? !freeEnd : !freeStart)) {
        vec2 nbU = atEndU ? outTan : inTan, qU = cq - (atEndU ? b : a);
        float turn = atEndU ? segTan.x * nbU.y - segTan.y * nbU.x : nbU.x * segTan.y - nbU.y * segTan.x;
        if (abs(turn) > 1.0 / 64.0 && dot(qU, vec2(-segTan.y, segTan.x)) * turn > 0.0) {
          vec2 pnU = vec2(-nbU.y, nbU.x) * (turn > 0.0 ? 1.0 : -1.0);
          seOr(sP, sQ, pnU, dot(qU, pnU) - halfW, aaEm);
        }
      }
      // ...and where the box reaches past a free ROUND end's plane, the cap's own record: its disc with the body's slab.
      // Of two such ends, the nearer. Not where a join's record or the inside of a turn's union
      // already stands, nor under a dash or in a stroke-space row, as the join's.
      bool capEndU = tRaw >= 0.5;
      vec2 qC = cq - (capEndU ? b : a), uC = capEndU ? segTan : -segTan;
      if (dashId == 0 && !framed && (sP.w <= 1.0 || sP.w == 9.0) && !joinRec && (capEndU ? freeEnd && endCap == 1 : freeStart && startCap == 1)
          && dot(qC, uC) > -aaEm)
        seDisc(sP, sQ, qC, uC, halfW);
    }
    // THE DASH, as its own SDF and with its own caps (strokeDashDist): a dash end is a plane across the stroke whose
    // normal is the segment's direction, and the exact-area edge takes it like the body's.
    if (dashId > 0) {
      vec2 gD = bodyHit ? bodyG : vec2(0.0);
      // the path distance carried on past either end (tRaw, not the clamped tC): see dashOut
      // Past a free round end the distance is radial and tRaw's overshoot is already in it: a dash end's disc takes the
      // distance ACROSS the segment (and its direction) with the path distance o, which carries the overshoot.
      float dIn = thisD;
      vec2 gIn = gD;
      bool roundEnd = (tRaw < 0.0 && freeStart && startCap == 1) || (tRaw > 1.0 && freeEnd && endCap == 1);
      if (roundEnd) {
        vec2 latV = (tRaw < 0.0 ? a : b) - cq;
        latV -= segTan * dot(latV, segTan);
        float lat = length(latV);
        dIn = lat;
        gD = lat > 0.0 ? latV / lat : vec2(0.0);
      }
      float dOut = strokeDashDist(dIn, gD, segTan, halfW, dashId, hdr.w + tRaw * abLen, startCap, endCap,
                                  hdr.w, hdr.w + abLen, aaEm, sP, sQ);
      if (dOut == dIn && roundEnd) gD = gIn;   // the dash changed nothing here
      else thisD = dOut;
      bodyG = gD; bodyHit = dot(gD, gD) > 0.5;
    }
    if (dSpill < thisD) { thisD = dSpill; sP = vec4(0.0); sQ = vec4(0.0); bodyG = vec2(0.0); bodyHit = false; joinRec = false; }
    // one plane only where the distance is that plane's (see _strokeMath.glsl's twin): else the ramp. A join's record
    // is exempt: it left out only the planes the box lies wholly inside, and the one it kept -- a chord, a neighbor's
    // side -- is the whole boundary there (a bevel's chord on a pixel-corner vertex read the ramp's 1 for 0.90; where
    // the exact record declines, beside a short line neighbor, 1 for 0.87).
    if (sP.w == 1.0 && !joinRec && abs(sP.z - (thisD - halfW)) > (1.0 / 1024.0) * aaEm) { sP = vec4(0.0); sQ = vec4(0.0); }
    if (thisD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = thisD; gradOut = bodyHit ? bodyG : vec2(0.0); if (!framed) { edgeP = sP; edgeQ = sQ; winD = thisD; } }
    else { if (thisD < minD2) { if (sP.w == 1.0) { secN = sP.xy; secE = sP.z; } else secE = 1e20; } minD2 = min(minD2, thisD); }
    if (framed) {
      float key = seDocKey(sP, sQ, N, thisD > halfW ? thisD - halfW : (thisD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = sP; edgeQ = sQ; winD = thisD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = sP; edgeQ = sQ; return minD; }
  }
#endif // MANTLE_NO_LINE
  hE += nLine;

  // ---- QUADS (native — not degree-elevated) ----
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;
    // THE CONTROL POINTS FIRST, THEN THE HULL TEST, THEN THE HEADER AND JOIN: a segment the hull test
    // rejects never fetches the two texels only a surviving one reads. The two skips commute, so nothing else moves.
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1) - vec4(c, c);
    vec4 q3t = cFetchL(sL + 2);
    vec2 q3  = q3t.xy - c;
    if (framed) { p12 = vec4(strokeFrameMul(N, p12.xy), strokeFrameMul(N, p12.zw)); q3 = strokeFrameMul(N, q3); }
    if (uStrokeGates != 0 && strokeHullOutOfReach(min(min(p12.xy, p12.zw), q3),
                             max(max(p12.xy, p12.zw), q3), _reach)) continue;
    if (uStrokeGates != 0 && strokeQuadOutOfReach(p12.xy, p12.zw, q3, _reach)) continue;
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);                      // a closed dashed contour's seam: _strokeMath.glsl
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    // q3t.zw carries the encoder's neighbor free-end reaches. nothing ON this ROUTE READS THEM
    // (the join wedge is decided by the tangents alone, as in the line branch), but
    // src/svg/textures.js writes the 1e9 sentinel so a stored bundle stays compatible with a
    // reader that gates on the field.
    vec4 jn = cFetchL(sL + 3);
    if (framed) jn = vec4(strokeFrameDir(N, jn.xy), strokeFrameDir(N, jn.zw));
    // Arcs-join curvature texel follows the join texel (only emitted for
    // stroke-linejoin:arcs). (kSelfStart, kSelfEnd, kPrevEnd, kNextStart).
    vec4 curv = (joinStyle == 4) ? cFetchL(sL + 4) : vec4(0.0);
    vec2 _segGrad = vec2(0.0); vec4 _sP, _sQ;
    float segD = strokeQuadAccum(p12, q3, freeStart, freeEnd,
                           startCap, endCap,
                           joinStyle, miterLimit, halfW,
                           jn.xy, jn.zw, dashId, hdr.w,
                           curv, 1e20, _segGrad, aaEm, _sP, _sQ);
    // A curve's body hit has an exact boundary normal too — the distance
    // gradient. Only cap/join hits leave it zero.
    // (the segment's own distance -- 1e20 where it drops -- so the second-nearest is known; the minimum is the same)
    if (segD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = segD; gradOut = _segGrad; if (!framed) { edgeP = _sP; edgeQ = _sQ; winD = segD; } }
    else { if (segD < minD2) { if (_sP.w == 1.0) { secN = _sP.xy; secE = _sP.z; } else secE = 1e20; } minD2 = min(minD2, segD); }
    if (framed) {
      float key = seDocKey(_sP, _sQ, N, segD > halfW ? segD - halfW : (segD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = _sP; edgeQ = _sQ; winD = segD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = _sP; edgeQ = _sQ; return minD; }
  }
#endif // MANTLE_NO_QUAD
  hE += nQuad;

  // ---- CUBICS ----
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;
    // control points, the hull test, then header and join: the three dependent rounds are two
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1) - vec4(c, c);
    vec4 p34 = cFetchL(sL + 2) - vec4(c, c);
    if (framed) {
      p12 = vec4(strokeFrameMul(N, p12.xy), strokeFrameMul(N, p12.zw));
      p34 = vec4(strokeFrameMul(N, p34.xy), strokeFrameMul(N, p34.zw));
    }
    if (uStrokeGates != 0 && strokeHullOutOfReach(min(min(p12.xy, p12.zw), min(p34.xy, p34.zw)),
                             max(max(p12.xy, p12.zw), max(p34.xy, p34.zw)), _reach)) continue;
    if (uStrokeGates != 0 && strokeCubicOutOfReach(p12, p34, _reach)) continue;
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);                      // a closed dashed contour's seam: _strokeMath.glsl
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    vec4 jn = cFetchL(sL + 3);
    if (framed) jn = vec4(strokeFrameDir(N, jn.xy), strokeFrameDir(N, jn.zw));
    vec4 curv = (joinStyle == 4) ? cFetchL(sL + 4) : vec4(0.0);
    vec2 _segGrad = vec2(0.0); vec4 _sP, _sQ;
    float segD = strokeCubicAccum(p12, p34, freeStart, freeEnd,
                                startCap, endCap,
                                joinStyle, miterLimit, halfW,
                                jn.xy, jn.zw, dashId, hdr.w,
                                curv, 1e20, _segGrad, aaEm, _sP, _sQ);
    // (the segment's own distance -- 1e20 where it drops -- so the second-nearest is known; the minimum is the same)
    if (segD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = segD; gradOut = _segGrad; if (!framed) { edgeP = _sP; edgeQ = _sQ; winD = segD; } }
    else { if (segD < minD2) { if (_sP.w == 1.0) { secN = _sP.xy; secE = _sP.z; } else secE = 1e20; } minD2 = min(minD2, segD); }
    if (framed) {
      float key = seDocKey(_sP, _sQ, N, segD > halfW ? segD - halfW : (segD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = _sP; edgeQ = _sQ; winD = segD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = _sP; edgeQ = _sQ; return minD; }
  }
#endif // MANTLE_NO_CUBIC
  hE += nCubic;

  // ---- ARCS ----
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < sBreak) break;

    if (farGate && segRaw.z > sFar) continue;
    int sL = int(segRaw.x);
    vec4 hdr = cFetchL(sL);
    if ((uint(hdr.x) & 4u) != 0u) continue;
    bool freeStart = hdr.y > 0.5;
    bool freeEnd   = hdr.z > 0.5;
    strokeSeamSet(hdr.y, hdr.z);                      // a closed dashed contour's seam: _strokeMath.glsl
    strokeSeamResolve(dashId, aaEm, freeStart, freeEnd);
    vec4 d1 = cFetchL(sL + 1);
    vec4 d2 = cFetchL(sL + 2);
    vec4 jn = cFetchL(sL + 4);   // join texel (inTan, outTan), after the endpoints texel
    vec4 curv = (joinStyle == 4) ? cFetchL(sL + 5) : vec4(0.0);
    // A stroke-space row measures the IMAGE of the arc under N, with the fragment at the origin (`cq`).
    vec2 cq = c;
    if (framed) {
      d1 = vec4(d1.xy - c, d1.zw); strokeFrameArc(N, d1, d2); cq = vec2(0.0);
      jn = vec4(strokeFrameDir(N, jn.xy), strokeFrameDir(N, jn.zw));
    }
    // Inline arc closest-distance.
    vec2 pc = cq - d1.xy;
    float cphi = cos(d2.z), sphi = sin(d2.z);
    vec2 pR = vec2(pc.x*cphi + pc.y*sphi, -pc.x*sphi + pc.y*cphi);
    // The reach gate for an arc: the arc lies on its ellipse, and n(p) = |(px / rx, py / ry)| is 1 on the
    // ellipse and 1 / min(rx, ry)-Lipschitz, so the fragment is at least min(rx, ry) * |n - 1| from it -- from the arc,
    // and from both ends, which are on it. Farther than the reach (strokeBandAccum's, as the other types' gates), nothing
    // this arc can return reaches the pixel: skip the end points' trig, the foot solve, the angle and the join work. The
    // slack is relative to the ellipse's own size. Zero radii (a line) keep the walk.
    if (uStrokeGates != 0 && d1.z > 0.0 && d1.w > 0.0) {
      float nrm = length(pR / d1.zw);
      if (min(d1.z, d1.w) * abs(nrm - 1.0) > _reach * 1.0001 + 4e-6 * (length(pR) + max(d1.z, d1.w))) continue;
    }
    vec2 ep0 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.x);
    vec2 ep1 = evalArc(d1.x, d1.y, d1.z, d1.w, d2.z, d2.y);
    float dE = min(length(cq - ep0), length(cq - ep1));

    vec2 foot;
    bool inRange;
    float tAng;
    float dEdge = arcClosestFoot(d1.zw, pR, d2.x, d2.y, foot, tAng, inRange);
    if (inRange && dEdge > dE) inRange = false;
    float arcD = inRange ? min(dEdge, dE) : dE;
    // Boundary normal for exact-area AA, same rule as lines and curves: the
    // distance gradient, normalize(fragment - closestPoint). `foot` IS the
    // closest point, in the ellipse's local frame — rotate the local difference
    // back by phi and it is the em-space normal. Only when the arc BODY is the
    // winner; an endpoint (cap/join) wins otherwise and rewrites the distance.
    vec2 _arcGrad = vec2(0.0);
    if (inRange && dEdge > 0.0) {
      vec2 gl2 = (pR - foot) / dEdge;
      _arcGrad = vec2(gl2.x * cphi - gl2.y * sphi, gl2.x * sphi + gl2.y * cphi);
    }
    // Endpoint velocities (dθ-scaled, matching segTangentAt) + the closest-point
    // parameter t∈[0,1] — interior foot when in range, else the nearer endpoint.
    // Route through the shared cap/join/dash helper so arc segments get real
    // caps + joins (butt/square, miter/round/bevel/arcs) like line/quad/cubic.
    // A closed arc's seam is a self-join (see the encoder's self-loop handling),
    // so no butt cap notches it.
    float dth = d2.y - d2.x;
    vec2 dStart = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.x), arcDyDtheta(d1.z, d1.w, d2.z, d2.x)) * dth;
    vec2 dEnd   = vec2(arcDxDtheta(d1.z, d1.w, d2.z, d2.y), arcDyDtheta(d1.z, d1.w, d2.z, d2.y)) * dth;
    if (d1.z == 0.0 || d1.w == 0.0) { dStart = ep1 - ep0; dEnd = dStart; }   // a zero radius: its chord (strokeArcAccum)
    float tArc;
    if (inRange) {
      float dd = hlslFmod(tAng - d2.x, TWO_PI);
      if (dd < 0.0) dd += TWO_PI;
      if (dth < 0.0 && dd > 0.0) dd -= TWO_PI;
      tArc = clamp(dd / dth, 0.0, 1.0);
    } else {
      tArc = (length(cq - ep0) <= length(cq - ep1)) ? 0.0 : 1.0;
    }
    float arcLenAtT = (dashId > 0) ? arcArcLen(d1, d2, tArc) : 0.0;
    // the path's direction at the closest point, for a dash end's plane (strokeDashDist)
    float thT = d2.x + tArc * dth;
    vec2 tanT = (dashId > 0) ? strokeUnit(vec2(arcDxDtheta(d1.z, d1.w, d2.z, thT), arcDyDtheta(d1.z, d1.w, d2.z, thT)) * dth)
                             : vec2(0.0);
    vec4 _sP, _sQ;
    vec2 _bodyG = _arcGrad;
    // a zero-radius arc's ends take the chord's own fraction (strokeArcAccum's tEnd: its parameter runs round the
    // degenerate ellipse, and the butt plane's own-stretch test measures along the path)
    float tEnd = tArc;
    if (d1.z == 0.0 || d1.w == 0.0) {
      vec2 ch = ep1 - ep0;
      float c2 = dot(ch, ch);
      if (c2 > 0.0) tEnd = clamp(dot(cq - ep0, ch) / c2, 0.0, 1.0);
    }
    float segD = strokeCapsJoinsDash(tEnd, arcD, ep0 - cq, ep1 - cq, dStart, dEnd,
                               freeStart, freeEnd, startCap, endCap,
                               joinStyle, miterLimit, halfW, jn.xy, jn.zw,
                               dashId, hdr.w, arcLenAtT, curv, 1e20, _arcGrad, tanT,
                               (dashId > 0) ? hdr.w + arcArcLen(d1, d2, 1.0) : 1e30, aaEm, _sP, _sQ);
    // THE ENDS AS CANDIDATES (strokeArcAccum, strokeQuadAccum): the closest point is interior or the other end, but a pixel past an end
    // plane within the end cap's reach belongs to that end's cap too, and a near-closed arc has another part of itself
    // nearer than the end beside it.
    if (d1.z != 0.0 && d1.w != 0.0) {
      for (int e = 0; e < 2; e++) {
        if ((e == 0 && tEnd < 1e-4) || (e == 1 && tEnd > 1.0 - 1e-4)) continue;   // the end already evaluated
        if (tEnd >= 1e-4 && tEnd <= 1.0 - 1e-4 && !strokeEndCandidate(freeStart, freeEnd, startCap, endCap, joinStyle, dashId, e)) continue;   // an interior closest point: see strokeEndCandidate
        vec2 pE = (e == 0 ? ep0 : ep1) - cq, uE = e == 0 ? -strokeUnit(dStart) : strokeUnit(dEnd);
        if (!(dot(-pE, uE) > 0.0) || length(pE) > halfW * (max(miterLimit, 1.0) + 1.0) + aaEm) continue;
        if (joinStyle == 4 && !(e == 0 ? freeStart : freeEnd)) continue;   // an arcs join's wedge is bounded only by the nearest vertex
        vec2 gK = vec2(0.0);
        vec4 eP2, eQ2;
        float mdK = strokeCapsJoinsDash(float(e), length(pE), ep0 - cq, ep1 - cq, dStart, dEnd,
                                        freeStart, freeEnd, startCap, endCap,
                                        joinStyle, miterLimit, halfW, jn.xy, jn.zw,
                                        dashId, hdr.w, (dashId > 0 && e == 1) ? arcArcLen(d1, d2, 1.0) : 0.0, curv, 1e20, gK,
                                        strokeUnit(e == 0 ? dStart : dEnd),
                                        (dashId > 0) ? hdr.w + arcArcLen(d1, d2, 1.0) : 1e30, aaEm, eP2, eQ2);
        if (mdK < segD) { segD = mdK; _sP = eP2; _sQ = eQ2; _arcGrad = gK; }
      }
    }
    // The curved body. The body's record is the offset curve's TANGENT PLANE at the closest point, and a
    // circular arc's offsets are CIRCLES: across a pixel the plane misses the circle's bulge, most on the inner side of a
    // tight arc (15/255 where the inner offset's radius is about a pixel), and one plane cannot hold both sides of a
    // stroke thinner than the pixel. A circle's body is exactly its ANNULUS SECTOR -- the points R + s along the
    // radius at each angle of the sweep, |s| <= halfW -- whose share of the pixel box strokeExactCov takes in closed
    // form (op 5; the record is the fragment's direction u from the center, its distance past the stroke, and
    // (R, D, sector start, sweep) with D its distance from the center).
    //   * Where the box lies wholly inside the sector -- seen from the center, its angular half-width asin(aaEm / D)
    //     under the closest point's angle to the nearer end -- no sector edge crosses it and the share is the
    //     annulus's (sweep 0). Only while the record is still the body's own plane: a cap, join or dash end that took
    //     it over keeps its record.
    //   * Where one does -- the box at an end, or about the center of a tight arc, where the inner offset's radius is
    //     under the box -- the sector's edges are the stroke's own boundary only at a free BUTT end: the whole stroke
    //     of the arc's subpath IS the sector then, and with R < halfW its normals run on through the center, so it is
    //     the sector of the annulus and the opposite sector of the disc of radius halfW - R. Such an arc (undashed)
    //     takes op 5 at every pixel, the sector wherever the box meets an edge; any other end keeps its record there.
    //     A free ROUND end is exact too wherever its cap is a piece of its own: the half of its disc beyond the end's
    //     ray, disjoint from the sector and from the other cap (R >= halfW, and the ends' gap wider than both discs).
    // A stroke-space row's image of a circle comes out of float32 a few ulps from one (strokeFrameArc); 2^-20 of the
    // radius is a small absolute error; narrow normal footprints can still amplify it. Arc admission is unchanged.
    if (abs(d1.z - d1.w) <= (1.0 / 1048576.0) * d1.z) {
      float D = length(pc), delta = min(tArc, 1.0 - tArc) * abs(dth), R = 0.5 * (d1.z + d1.w);
      vec2 uc = D > 0.0 ? pc / D : vec2(1.0, 0.0);
      bool inside = D > aaEm && aaEm < D * sin(min(delta, 1.5707963));
      // ROUND ends too, where each cap's disc lies beyond its end's ray and clear of the other's: R >= halfW (the disc
      // stays off the center) and the gap between the ends at least the two discs' angular widths
      bool ends = dashId == 0 && freeStart && freeEnd && startCap != 2 && endCap != 2
        && ((startCap == 0 && endCap == 0) || (R >= halfW && TWO_PI - abs(dth) >= 2.0 * asin(halfW / R)));
      if (ends) {
        _sP = vec4(uc, segD - halfW, 5.0); _sQ = vec4(R, D, 0.0, 0.0);
        if (!inside) {
          // the sector: counterclockwise from a0 through `sw`, the one of the two arcs between the ends that holds
          // the arc's middle; op 5 + 1 for a round cap at a0's end, + 2 at the other
          vec2 ps = ep0 - d1.xy, pe = ep1 - d1.xy, pm = evalArc(0.0, 0.0, d1.z, d1.w, d2.z, 0.5 * (d2.x + d2.y));
          float as0 = curveAtan2(ps.y, ps.x), s1 = mod(curveAtan2(pe.y, pe.x) - as0, TWO_PI), sm = mod(curveAtan2(pm.y, pm.x) - as0, TWO_PI);
          bool fwd = sm < s1;
          int c0 = fwd ? startCap : endCap, c1 = fwd ? endCap : startCap;
          _sP = vec4(uc, segD - halfW, 5.0 + float(c0) + 2.0 * float(c1));
          _sQ = vec4(R, D, fwd ? as0 : as0 + s1, fwd ? s1 : TWO_PI - s1);
        }
      } else if (inside && (_sP.w == 1.0 || _sP.w == 9.0) && _sP.x == _bodyG.x && _sP.y == _bodyG.y && _sP.z == arcD - halfW) {
        _sP = vec4(uc, _sP.z, 5.0); _sQ = vec4(R, D, 0.0, 0.0);
      }
    }
    if (segD < minD) { if (edgeP.w == 1.0) { secN = edgeP.xy; secE = edgeP.z; } else secE = 1e20; minD2 = minD; minD = segD; gradOut = _arcGrad; if (!framed) { edgeP = _sP; edgeQ = _sQ; winD = segD; } }
    else { if (segD < minD2) { if (_sP.w == 1.0) { secN = _sP.xy; secE = _sP.z; } else secE = 1e20; } minD2 = min(minD2, segD); }
    if (framed) {
      float key = seDocKey(_sP, _sQ, N, segD > halfW ? segD - halfW : (segD - halfW) / kMaxN);
      if (key < bestKey) { bestKey = key; edgeP = _sP; edgeQ = _sQ; winD = segD; }
    }
    if (uStrokeGates != 0 && minD <= satD) { edgeP = _sP; edgeQ = _sQ; return minD; }
  }
#endif // MANTLE_NO_ARC

  // The union's check. A concave corner unites the winner's side with its neighbor's side as a HALF-PLANE, which is the
  // neighbor only where the neighbor is: a neighbor shorter than the way to the corner has ended, and its half-plane
  // runs on where there is no stroke. The neighbor's own walk said how far it really is: where the nearest other segment
  // is farther than its plane (by more than float32 would put it), the plane is not the neighbor, and the corner is not
  // a union.
  if (!framed && edgeP.w == 1.0 && secE < aaEm) { edgeQ = vec4(secN, secE, 0.0); edgeP = vec4(edgeP.xyz, 3.0); }
  float otherD = winD > minD ? minD : minD2;
  if (edgeP.w == 3.0 && !(otherD <= halfW + edgeQ.z + (1.0 / 256.0) * aaEm)) edgeP = vec4(edgeP.xyz, 1.0);
  return minD;
}

/// THE ONE STROKE-WALK ENTRY. strokeMinDist (conformal) and strokeMinDistLocal (stroke-space row) each ended in their
/// own call of strokeBandAccum, so every call SITE of the pair compiled the whole walk twice. A GPU compiler inlines the
/// walk at each call, and the walk is most of a stroke program: its Metal pipeline took ~6.5 s cold per copy. This entry
/// makes the choice between the two by DATA (`framed`) and calls strokeBandAccum once, so a call site costs one copy.
/// The arithmetic of each arm is the one its entry ran: the conformal arm takes `satD` / `aaEm` as given (strokeMinDist's
/// arguments); the framed arm derives them from `ePx` and `saturate` and converts the answer to document terms (strokeMinDistLocal's
/// body). `halfW` is read in both arms and written only in the framed one.
float strokeWalk(vec2 c, ivec4 GD, vec4 shapeBB, vec4 N, bool framed, inout float halfW,
                 int startCap, int endCap, int joinStyle, float miterLimit,
                 int dashId, out vec2 gradOut, float satD, float aaEm, vec2 ePx, bool saturate,
                 out vec4 edgeP, out vec4 edgeQ) {
  ivec2 gl = GD.xy;
  int bandsX = GD.z + 1;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);
  ivec2 bandIdx = clamp(ivec2((c - shapeBB.xy) / bbSize * vec2(bandsX, bandsY)),
                        ivec2(0), ivec2(bandsX - 1, bandsY - 1));
  if (framed) {
    float kMax = length(vec2(0.5 * (N.x + N.w), 0.5 * (N.y - N.z))) + length(vec2(0.5 * (N.x - N.w), 0.5 * (N.y + N.z)));
    vec2 ePxS = ePx * kMax;
    satD = saturate ? max(halfW - 0.5 * length(ePxS), 0.0) : -1e20;
    aaEm = strokeAaReachEm(halfW, ePxS);
  } else N = vec4(0.0);
  vec2 g;
  float d = strokeBandAccum(gl, bandIdx.y * 2, c, halfW, startCap, endCap, joinStyle, miterLimit, dashId, 1e20, g,
                            satD, aaEm, N, framed, edgeP, edgeQ);
  if (!framed) { gradOut = g; return d; }
  float s;
  if (dot(g, g) > 0.5) { vec2 gd = strokeFrameMulT(N, g); s = length(gd); gradOut = gd / s; }
  else { s = sqrt(abs(N.x * N.w - N.y * N.z)); gradOut = vec2(0.0); }
  halfW = halfW / s;
  return d / s;
}

// The conformal arm of strokeWalk, as its own entry (nothing in a program calls it; the emulated-GLSL tests lift it by name). Walks the H-band that contains renderCoord
// (the encoder dilates band membership by halfW so near-horizontal segs at
// boundaries are reachable from H alone — no V walk needed).
float strokeMinDist(vec2 c, ivec4 GD, vec4 shapeBB, float halfW,
                        int startCap, int endCap,
                        int joinStyle, float miterLimit,
                        int dashId, out vec2 gradOut, float satD, float aaEm,
                        out vec4 edgeP, out vec4 edgeQ) {
  return strokeWalk(c, GD, shapeBB, vec4(0.0), false, halfW, startCap, endCap, joinStyle, miterLimit, dashId, gradOut,
                    satD, aaEm, vec2(0.0), false, edgeP, edgeQ);
}

/// THE STROKE-SPACE ENTRY (flagsShape FS_STROKE_LOCAL). The walk for a row whose CTM was not conformal,
/// in its stroke space (see strokeFrameMul), handed back in DOCUMENT terms so the caller's coverage code is the one
/// every stroke runs: `halfW` comes in as the row's (stroke-space) half-width and goes out as the document-space
/// half-width across the winning feature; the return is the document-space distance in the same units, and `gradOut`
/// the document-space boundary normal.
///
/// The distance field in document space is d(N p), whose gradient is N^T g for the stroke-space gradient g. Where a
/// segment BODY wins, g is its unit normal and s = |N^T g| converts the distance to the edge exactly to first order
/// across the pixel -- the exact-area AA then runs on the true document normal. Where a cap or join wins there is no
/// normal, and s is the geometric mean of N's singular values, sqrt|det N|: the edge (d = halfW) is still exactly
/// where it is, and the ramp's width is off by at most sqrt(kMax), N's condition number's root.
///
/// `saturate` asks for the walk's saturation early-out (the main pass): the whole pixel box is inside once
/// the stroke-space distance is within halfW - kMax * 0.5 |ePx|, kMax the most N can stretch one em. The AA reach is
/// strokeAaReachEm at kMax times the pixel, which bounds the stroke-space reach of a coverage that is nonzero in
/// document space; both are document-space bounds too, which is what the band gates compare them with.
float strokeMinDistLocal(vec2 c, ivec4 GD, vec4 shapeBB, vec4 N, inout float halfW,
                         int startCap, int endCap, int joinStyle, float miterLimit,
                         int dashId, out vec2 gradOut, vec2 ePx, bool saturate,
                         out vec4 edgeP, out vec4 edgeQ) {
  return strokeWalk(c, GD, shapeBB, N, true, halfW, startCap, endCap, joinStyle, miterLimit, dashId, gradOut,
                    0.0, 0.0, ePx, saturate, edgeP, edgeQ);
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

// No linear path. The pair needs none: at a == 0 it is already exact — d = |b|, so q = 2b
// and tSml = c/(2b), the line's own root — and the sign-pattern LUT only ever admits that
// root for such a curve (a straight quad falling through the ray is root 1 with b > 0, rising
// is root 2 with b < 0; both slots hold tSml). The other slot's q/0 is never read. The
// absolute `abs(a) < 1/65536` test this replaces sent every quad under it to c/(2b),
// which is wrong wherever the quad is really curved: at 2^-20 that is nearly every quad.
// d > 0 also makes q nonzero (|q| = |b| + d), so the divide needs no guard of its own.
vec4 slugSolveHorizQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.y;
  float d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  float q  = b.y + (b.y >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0) ? p12.y / q : tBig;
  float t1 = b.y >= 0.0 ? tSml : tBig;
  float t2 = b.y >= 0.0 ? tBig : tSml;
  return vec4((a.x * t1 - b.x * 2.0) * t1 + p12.x,
              (a.x * t2 - b.x * 2.0) * t2 + p12.x,
              t1, t2);
}

vec4 slugSolveVertQuad(vec4 p12, vec2 p3) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.x;
  float d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  float q  = b.x + (b.x >= 0.0 ? d : -d);
  float tBig = q * ra;
  float tSml = (d > 0.0) ? p12.x / q : tBig;
  float t1 = b.x >= 0.0 ? tSml : tBig;
  float t2 = b.x >= 0.0 ? tBig : tSml;
  return vec4((a.y * t1 - b.y * 2.0) * t1 + p12.y,
              (a.y * t2 - b.y * 2.0) * t2 + p12.y,
              t1, t2);
}
void solveCubicBisect(vec4 p12, vec4 p34, bool vert, out vec3 r, out vec3 t, out vec3 up) {
  r = vec3(1e20); t = vec3(-1.0); up = vec3(0.0);
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
  // straddling an absolute 1.0/65536 (1.53e-5) threshold. Above it, the
  // quadratic branch would run with a near-zero leading coefficient and compute both
  // roots as (-qb +- sd)/(2*qa), where the (-qb + sd) form cancels catastrophically
  // and the apex root lands outside (0,1).
  //
  // Losing that split is not a small error: the sub-interval split at a critical
  // point is what makes each piece y-MONOTONE, which is the precondition for the
  // endpoint sign test to detect a crossing at all. With the arch unsplit, [0,1]
  // has both endpoints at y=96 — same side of the ray — so the walker would report NO
  // crossings through the middle of a solid shape, and whole bands of interior
  // pixels would come back empty.
  //
  // So both halves are handled: scale the degeneracy test to the coefficients actually in
  // play, and use the numerically stable root form (the same one used elsewhere
  // in this file) so a small qa degrades gracefully instead of canceling.
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

  // An endpoint on the ray is decided by the LINE walker's convention, as the quad LUT and the arc
  // walkers already do: a crossing-axis value of exactly 0 counts as NON-NEGATIVE, which is the same
  // as casting the ray a hair toward the negative side. Every piece of the cubic is monotone, so it
  // crosses that shifted ray exactly when its two end values fall on different sides of `>= 0`, and
  // the crossing's direction is the piece's own: up when it ends non-negative. The segment's own
  // ends are its control values p1 and p4 exactly (evalC(cy, 1) is not p4 in float32), so a vertex
  // two segments share reads the same on both sides of it.

  float yEnd0 = vert ? p12.x : p12.y, yEnd1 = vert ? p34.z : p34.w;
  // A zero-speed end is a root of y' exactly. y'(t) / 3 = d0 (1-t)^2 + 2 d1 (1-t) t + d2 t^2 with
  // d0 = P2 - P1, d1 = P3 - P2, d2 = P4 - P3 on this axis; a handle on its end (d2 == 0, or d0 == 0 at the start)
  // makes that end a root, and the other is the remaining linear factor's, d0 / (d0 - 2 d1) (or 2 d1 / (2 d1)).
  // Solved as a quadratic, the end's root is a double root or next to one, and a fused multiply-add in the
  // discriminant moved it inside (0, 1): a split at t = 0.9998 cut a sliver piece whose far end evalC'd to noise on
  // the ray, and a crossing 4.8 px off came back (0.39 off exact at P3 == P4 on a sample row and column, fused
  // only). So the end is factored out: the control points say whether an interior root exists at all, and where
  // it does, the solver's own root nearest it is kept (it is that root, rounded as before), the end's dropped.
  float d0 = vert ? p12.z - p12.x : p12.w - p12.y, d1 = vert ? p34.x - p12.z : p34.y - p12.w, d2 = vert ? p34.z - p34.x : p34.w - p34.y;
  if (d0 == 0.0 || d2 == 0.0) {
    float tEnd = (d2 == 0.0) ? 1.0 : 0.0;
    float num = (d2 == 0.0) ? d0 : 2.0 * d1, den = (d2 == 0.0) ? d0 - 2.0 * d1 : 2.0 * d1 - d2;
    float s = (d0 == d2 || den == 0.0) ? -1.0 : num / den;   // both ends still: y' = 6 d1 t (1 - t), no interior root
    float keep = -1.0;
    if (s > 0.0 && s < 1.0) {
      keep = s;
      if (split1 > 0.0 && abs(split1 - s) < abs(split1 - tEnd)) keep = split1;
      else if (split2 > 0.0 && abs(split2 - s) < abs(split2 - tEnd)) keep = split2;
    }
    split1 = keep;
    split2 = -1.0;
  }
  float b1 = (split1 > 0.0) ? split1 : 1.0, b2 = (split2 > 0.0) ? split2 : 1.0;
  float lo = 0.0, yLo = yEnd0;
  for (int i = 0; i < 3; i++) {
    if (lo >= 1.0) break;                     // the last piece ended at 1.0
    float hi = (i == 0) ? b1 : ((i == 1) ? b2 : 1.0);
    // an interior boundary is a split, strictly inside (0, 1); the last piece ends on p4 exactly
    float yHi = (hi < 1.0) ? evalC(cy, hi) : yEnd1;
    bool sHi = yHi >= 0.0;
    bool sLo = yLo >= 0.0;
    if (sLo != sHi) {
      // Clamped Newton, SECANT-seeded. The clamp guarantees bounded behavior near
      // critical points; the seed is what sets the iteration count. Seeding at the
      // midpoint wastes the first steps re-deriving what the chord through the
      // bracket ends already tells you (it takes about 8). The
      // secant seed lands close enough that SLUG_NEWTON iterations suffice.
      // yLo and yHi straddle zero here, so sden is never 0.
      float sden = yHi - yLo;
      float xr = clamp(lo - yLo * (hi - lo) / sden, lo, hi);
      // SAFEGUARDED: every iterate narrows the bracket [bl, bh] the sign test proved, and a
      // step that would leave it bisects instead. A piece with a zero-speed end (a coincident handle,
      // P3 == P4) is flat there: the secant seed lands on the flat end, Newton's first step flew to the
      // FAR end and the clamp parked it there, and five iterations did not come back -- a crossing 0.6 em
      // off and 4 stray px on a cubic ending on its own handle. Where no step leaves the bracket this is
      // the same iteration. A piece END that is exactly on the ray IS the root (yLo / yHi are the segment's
      // own p1 / p4 there, exact): it is taken as it stands, since evalC at that end is not exactly 0 in
      // float32, and with a flat end the residue's step would leave a root the bracket cannot improve on.
      float bl = lo, bh = hi;
      bool onEnd = (yHi == 0.0 || yLo == 0.0);
      if (onEnd) xr = (yHi == 0.0) ? hi : lo;
      for (int k = 0; k < SLUG_NEWTON; k++) {
        if (onEnd) break;
        float fy = evalC(cy, xr);
        if (fy == 0.0) break;                 // an exact root
        if ((fy >= 0.0) == sLo) bl = xr; else bh = xr;
        float fdy = evalCD(cy, xr);
        float xn = (fdy != 0.0) ? xr - fy / fdy : 0.5 * (bl + bh);
        xr = (xn >= bl && xn <= bh) ? xn : 0.5 * (bl + bh);   // inclusive: a converged root sits ON the bracket
      }
      float rr = evalC(cx, xr), uu = sHi ? 1.0 : 0.0;
      if (i == 0) { t.x = xr; r.x = rr; up.x = uu; }
      else if (i == 1) { t.y = xr; r.y = rr; up.y = uu; }
      else { t.z = xr; r.z = rr; up.z = uu; }
    }
    lo = hi; yLo = yHi;
  }
}
@@BOX_COV@@

///
/// Sub-pixel hairlines floor halfW to half a pixel and fade by the true-vs-clamped ratio. Where the boundary is an
/// offset line with a known normal the exact area(pixel box n half-plane) replaces the ramp; the ramp is exact only
/// for an axis-aligned edge.
///
/// The ramp's guard is for a zero derivative only. max(pxSize, 1e-6) -- an em length -- would widen every cap and
/// join ramp of art whose pixel is under 1e-6 em (2^-20 art at a few pixels to the unit) to 1e-6 em, flattening the AA
/// at every scale below that, while halfW, the hairline floor and the exact-area edge are not floored: a body pixel
/// would be right and the cap beside it not. 1e-30 is mantle.frag.glsl's invPx guard.
float strokeEdgeCov(float minD, float halfW, vec2 grad, vec2 ePx, bool exactAa) {
  float pxSize = 0.5 * (ePx.x + ePx.y);
  float halfWMin = 0.5 * pxSize;
  float halfWVis = max(halfW, halfWMin);
  float weightFade = halfW / halfWVis;
  float distFromEdge = minD - halfWVis;
  float cov = 0.0;
  if (exactAa && dot(grad, grad) > 0.5 && distFromEdge <= 0.75 * pxSize) {
    vec2 nUn = grad * ePx;
    // One inversesqrt for the normal and the offset. nUn is a unit gradient times one pixel in em, so its
    // square is 0 only where ePx is; the guard is on the square, below any pixel size a float32 em coordinate resolves.
    float il = inversesqrt(max(dot(nUn, nUn), 1e-30));
    cov = exactBoxCov(nUn * il, -distFromEdge * il) * weightFade;
  } else if (distFromEdge <= 0.5 * pxSize) {
    cov = clamp(0.5 - distFromEdge / max(pxSize, 1e-30), 0.0, 1.0) * weightFade;
  }
  return cov;
}


#if !defined(MANTLE_NO_STROKE) && defined(MANTLE_STROKE_EXACT)
vec3 sePx(vec2 n, float e, vec4 N, vec2 ePx) {
  vec2 nd = strokeFrameMulT(N, n) * ePx;
  float il = inversesqrt(max(dot(nd, nd), 1e-30));
  return vec3(nd * il, -e * il);
}
/// The angle-swept area of the disc of radius^2 r2 between the directions of A and B (signed, counterclockwise
/// positive); zero between two points on one ray.
float seSector(vec2 A, vec2 B, float r2) {
  float y = A.x * B.y - A.y * B.x, x = dot(A, B);
  return (y == 0.0 && x >= 0.0) ? 0.0 : 0.5 * r2 * curveAtan2(y, x);
}
/// The signed area of disc(0, r) n triangle(0, A, B): the segment's inside part as a triangle, its outside parts as
/// the sectors they subtend. Summed over a polygon's edges it is the polygon's area inside the disc. A crossing past an
/// end IS that end: A + D rounds off B, and two points a rounding apart near the center -- a pixel corner on a round
/// cap's or join's vertex -- subtend any angle, a sector of up to half the disc.
float seCircleTri(vec2 A, vec2 B, float r2) {
  vec2 D = B - A;
  float a = dot(D, D);
  if (a == 0.0) return 0.0;
  float b = dot(A, D), c = dot(A, A) - r2;
  float disc = b * b - a * c;
  if (disc <= 0.0) return seSector(A, B, r2);
  float s = sqrt(disc), t0 = (-b - s) / a, t1 = (-b + s) / a;
  vec2 P = t0 <= 0.0 ? A : (t0 >= 1.0 ? B : A + D * t0), Q = t1 >= 1.0 ? B : (t1 <= 0.0 ? A : A + D * t1);
  return seSector(A, P, r2) + 0.5 * (P.x * Q.y - P.y * Q.x) + seSector(Q, B, r2);
}
/// The area of disc(0, r) n quad(C0..C3) n {p : dot(p, u) >= 0}, the half-plane through the disc's center: each edge
/// clipped to the half-plane. The clip line's own edge runs through the center, so it adds nothing.
float seDiscQuadCut(vec2 C0, vec2 C1, vec2 C2, vec2 C3, float r2, vec2 u) {
  float area = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 A = i == 0 ? C0 : (i == 1 ? C1 : (i == 2 ? C2 : C3));
    vec2 B = i == 0 ? C1 : (i == 1 ? C2 : (i == 2 ? C3 : C0));
    float fa = dot(A, u), fb = dot(B, u);
    if (fa >= 0.0 && fb >= 0.0) area += seCircleTri(A, B, r2);
    else if (fa >= 0.0) area += seCircleTri(A, mix(A, B, fa / (fa - fb)), r2);
    else if (fb >= 0.0) area += seCircleTri(mix(A, B, fa / (fa - fb)), B, r2);
  }
  return abs(area);
}

bool seCirclePlaneSafe(float r, vec2 u, vec2 hx, vec2 hy, float reach) {
  return r > 4096.0 * reach || (r > 256.0 * reach
    && reach <= 2.0 * max(abs(dot(u, hx)), abs(dot(u, hy))));
}
float seCircleShare(vec2 f, vec2 u, float D, float r, vec2 hx, vec2 hy, float reach, float boxArea, vec4 N, vec2 ePx) {
  if (r <= 0.0 || D - reach >= r) return 0.0;
  if (D + reach <= r) return 1.0;
  if (seCirclePlaneSafe(r, u, hx, hy, reach)) { vec3 h = sePx(u, D - r, N, ePx); return exactBoxCov(h.xy, h.z); }
  return seDiscQuadCut(f - hx - hy, f + hx - hy, f + hx + hy, f - hx + hy, r * r, vec2(0.0)) / boxArea;
}
/// The area of disc(0, r) n quad(C0..C3) n the WEDGE {p : m0.p >= 0, m1.p >= 0} (two half-planes through the center;
/// a convex wedge, its sweep at most a half-turn): each edge clipped to both. The wedge's own edges run through the
/// center, so they add nothing.
float seDiscQuadWedge(vec2 C0, vec2 C1, vec2 C2, vec2 C3, float r2, vec2 m0, vec2 m1) {
  float area = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 A = i == 0 ? C0 : (i == 1 ? C1 : (i == 2 ? C2 : C3));
    vec2 B = i == 0 ? C1 : (i == 1 ? C2 : (i == 2 ? C3 : C0));
    float lo = 0.0, hi = 1.0;
    for (int k = 0; k < 2; k++) {
      vec2 m = k == 0 ? m0 : m1;
      float fa = dot(A, m), fb = dot(B, m);
      if (fa < 0.0 && fb < 0.0) hi = -1.0;
      else if (fa < 0.0) lo = max(lo, fa / (fa - fb));
      else if (fb < 0.0) hi = min(hi, fa / (fa - fb));
    }
    if (lo < hi) area += seCircleTri(mix(A, B, lo), mix(A, B, hi), r2);
  }
  return abs(area);
}
/// The share of the pixel box inside the SECTOR of the disc of radius r about the center that runs counterclockwise
/// from the unit direction r0 to r1, sweeping `sw` (in (0, 2 pi)); the rest as seCircleShare. A sweep past a half-turn
/// is the disc less the convex sector from r1 to r0. An admitted disc uses its tangent plane, and its
/// sector the planes' intersection: the sector's edges are lines through the center, exact as planes.
float seSectorShare(vec2 f, vec2 u, float D, float r, vec2 r0, vec2 r1, float sw, vec2 hx, vec2 hy, float reach,
                    float boxArea, vec4 N, vec2 ePx) {
  if (r <= 0.0 || D - reach >= r) return 0.0;
  bool big = sw > 3.14159265;
  vec2 a = big ? r1 : r0, b = big ? r0 : r1;                 // the convex sector: from a to b
  vec2 m0 = vec2(-a.y, a.x), m1 = vec2(b.y, -b.x);          // its two half-planes' inward normals
  float part;
  if (seCirclePlaneSafe(r, u, hx, hy, reach)) {
    vec3 h = sePx(u, D - r, N, ePx), w0 = sePx(-m0, -dot(m0, f), N, ePx), w1 = sePx(-m1, -dot(m1, f), N, ePx);
    part = D + reach <= r ? exactBoxCov2(w0.xy, w0.z, w1.xy, w1.z) : exactBoxCov3(h.xy, h.z, w0.xy, w0.z, w1.xy, w1.z);
  } else {
    part = seDiscQuadWedge(f - hx - hy, f + hx - hy, f + hx + hy, f - hx + hy, r * r, m0, m1) / boxArea;
  }
  return big ? seCircleShare(f, u, D, r, hx, hy, reach, boxArea, N, ePx) - part : part;
}
/// The share of the pixel box inside a round cap's half-disc: radius r about its center, beyond the plane through the
/// center with unit normal `ub` (the fragment at g relative to the center); a disc admitted by the guard as op 4
/// takes it, its tangent plane and the cut.
float seCapShare(vec2 g, vec2 ub, float r, vec2 hx, vec2 hy, float reach, float boxArea, vec4 N, vec2 ePx) {
  float dg = length(g);
  if (dg - reach >= r || dot(g, ub) <= -reach) return 0.0;
  if (seCirclePlaneSafe(r, dg > 0.0 ? g / dg : ub, hx, hy, reach)) {
    vec3 hd = sePx(dg > 0.0 ? g / dg : ub, dg - r, N, ePx), hc = sePx(-ub, -dot(g, ub), N, ePx);
    return exactBoxCov2(hd.xy, hd.z, hc.xy, hc.z);
  }
  return seDiscQuadCut(g - hx - hy, g + hx - hy, g + hx + hy, g - hx + hy, r * r, ub) / boxArea;
}
/// The exact coverage of the pixel box by the edge record (P, Q). `halfWS` is the stroke's half-width in the record's
/// space, `N` the row's frame (the identity for a row drawn in document space), `ePx` the fragment's em per pixel.
/// A plane the box lies wholly on one side of (|dq| >= 0.7072, half the box's widest extent) is decided without it.
float strokeExactCov(vec4 P, vec4 Q, float halfWS, vec4 N, vec2 ePx) {
  vec3 p1 = sePx(P.xy, P.z, N, ePx);
  if (P.w == 1.0) return exactBoxCov(p1.xy, p1.z);
  if (P.w == 4.0) {
    // A round cap or join: the disc about V past the plane through it, and the stroke's slab behind it -- two disjoint
    // pieces whose sum is exact, the tangent sides included. With no plane (u = 0) a dot: the whole disc.
    vec2 V = -P.xy * (P.z + halfWS), u = Q.xy, pn = vec2(-u.y, u.x);
    float sl = -dot(V, pn);                                   // the fragment's lateral offset from the centerline
    vec3 hb = dot(u, u) > 0.5 ? sePx(u, Q.z, N, ePx) : vec3(0.0, 0.0, -1.0);   // behind the plane (a dot: nothing is)
    vec3 h1 = sePx(pn, sl - halfWS, N, ePx), h2 = sePx(-pn, -sl - halfWS, N, ePx);
    float slab = 0.0;
    if (hb.z > -0.7072) {
      if (h2.z >= 0.7072 && hb.z >= 0.7072) slab = exactBoxCov(h1.xy, h1.z);
      else if (h1.z >= 0.7072 && hb.z >= 0.7072) slab = exactBoxCov(h2.xy, h2.z);
      else slab = exactBoxCov3(h1.xy, h1.z, h2.xy, h2.z, hb.xy, hb.z);
    }
    float cap = 0.0;
    if (hb.z < 0.7072) {
      // the pixel box in stroke space (a parallelogram about the fragment), and how far it reaches from the fragment
      vec2 hx = strokeFrameMul(N, vec2(0.5 * ePx.x, 0.0)), hy = strokeFrameMul(N, vec2(0.0, 0.5 * ePx.y));
      float rho = P.z + halfWS, reach = max(length(hx + hy), length(hx - hy));
      if (rho + reach <= halfWS) cap = 1.0 - exactBoxCov(hb.xy, hb.z);      // wholly inside the disc: all past the plane
      else if (rho - reach < halfWS) {

        if (seCirclePlaneSafe(halfWS, P.xy, hx, hy, reach)) cap = exactBoxCov2(p1.xy, p1.z, -hb.xy, -hb.z);
        else {
          vec2 f = -V;                                          // the fragment, relative to the disc's center
          float boxArea = 4.0 * abs(hx.x * hy.y - hx.y * hy.x);
          cap = seDiscQuadCut(f - hx - hy, f + hx - hy, f + hx + hy, f - hx + hy, halfWS * halfWS, u) / boxArea;
        }
      }
    }
    return clamp(slab + cap, 0.0, 1.0);
  }
  if (P.w == 9.0) {
    // A stroke thinner than the pixel box: its slab, both sides, cut by the plane Q holds where one does
    vec3 pf = sePx(-P.xy, -P.z - 2.0 * halfWS, N, ePx);
    if (!(dot(Q.xy, Q.xy) > 0.5)) return exactBoxCov2(p1.xy, p1.z, pf.xy, pf.z);
    vec3 p2 = sePx(Q.xy, Q.z, N, ePx);
    return exactBoxCov3(p1.xy, p1.z, pf.xy, pf.z, p2.xy, p2.z);
  }
  if (P.w >= 5.0) {
    // A circular arc's body: Q = (R, D, a0, sw), the op 5 plus its round
    // caps. The fragment lies D from the center along u. With no sector (sw = 0) the annulus between the circles of
    // radius R -+ halfW, the outer circle's share of the box less the inner one's. With one, that annulus's sector from
    // angle a0 through sw, and each round cap's half-disc; and where R < halfW the normals run on through the center,
    // adding the OPPOSITE sector of the disc of radius halfW - R -- less what it shares with the first where the sweep
    // passes a half-turn (the two sectors from a0 and from a0 + pi, each through sw - pi).
    float R = Q.x, D = Q.y, sw = Q.w;
    vec2 u = P.xy, f = u * D;
    vec2 hx = strokeFrameMul(N, vec2(0.5 * ePx.x, 0.0)), hy = strokeFrameMul(N, vec2(0.0, 0.5 * ePx.y));
    float reach = max(length(hx + hy), length(hx - hy)), boxArea = 4.0 * abs(hx.x * hy.y - hx.y * hy.x);
    if (sw == 0.0)
      return clamp(seCircleShare(f, u, D, R + halfWS, hx, hy, reach, boxArea, N, ePx)
                 - seCircleShare(f, u, D, R - halfWS, hx, hy, reach, boxArea, N, ePx), 0.0, 1.0);
    vec2 r0 = vec2(cos(Q.z), sin(Q.z)), r1 = vec2(cos(Q.z + sw), sin(Q.z + sw));
    float cov = seSectorShare(f, u, D, R + halfWS, r0, r1, sw, hx, hy, reach, boxArea, N, ePx)
              - seSectorShare(f, u, D, R - halfWS, r0, r1, sw, hx, hy, reach, boxArea, N, ePx);
    // round caps (op 6: at a0's end, 7: at the other's, 8: both): each the half of its disc beyond its end's ray
    int caps = int(P.w + 0.5) - 5;
    if ((caps & 1) != 0) cov += seCapShare(f - R * r0, vec2(r0.y, -r0.x), halfWS, hx, hy, reach, boxArea, N, ePx);
    if ((caps & 2) != 0) cov += seCapShare(f - R * r1, vec2(-r1.y, r1.x), halfWS, hx, hy, reach, boxArea, N, ePx);
    float ro = halfWS - R;
    if (ro > 0.0) {
      cov += seSectorShare(f, u, D, ro, -r0, -r1, sw, hx, hy, reach, boxArea, N, ePx);
      if (sw > 3.14159265)
        cov -= seSectorShare(f, u, D, ro, r0, -r1, sw - 3.14159265, hx, hy, reach, boxArea, N, ePx)
             + seSectorShare(f, u, D, ro, -r0, r1, sw - 3.14159265, hx, hy, reach, boxArea, N, ePx);
    }
    return clamp(cov, 0.0, 1.0);
  }
  vec3 p2 = sePx(Q.xy, Q.z, N, ePx);
  if (P.w == 2.0) {
    if (p2.z >= 0.7072) return exactBoxCov(p1.xy, p1.z);
    if (p1.z >= 0.7072) return exactBoxCov(p2.xy, p2.z);
    if (p1.z <= -0.7072 || p2.z <= -0.7072) return 0.0;
    return exactBoxCov2(p1.xy, p1.z, p2.xy, p2.z);
  }
  // P.w == 3: the union
  if (p2.z <= -0.7072) return exactBoxCov(p1.xy, p1.z);
  if (p1.z <= -0.7072) return exactBoxCov(p2.xy, p2.z);
  if (p1.z >= 0.7072 || p2.z >= 0.7072) return 1.0;
  return 1.0 - exactBoxCov2(-p1.xy, -p1.z, -p2.xy, -p2.z);
}

#endif // !MANTLE_NO_STROKE && MANTLE_STROKE_EXACT

// MANTLE_HARD IS IN this GUARD because the frag chain calls renderFillHardBand under MANTLE_HARD alone.
// Without it, a program asking for band-hard and nothing else did not compile -- the runtime only ever
// worked because fillPass adds MANTLE_GWN beside MANTLE_HARD.
#if defined(MANTLE_GWN) || defined(MANTLE_HARD) || defined(MANTLE_HARD_MIXED)
// GWN_WINDING_ONLY: the tree-hard (MANTLE_HARD_TREE) and bare-GWN (no SDF/AAC) programs share
// renderFillGWNSDF's traversal but want the folded winding, not coverage. Derived from the defines
// already set, so no program has to opt in explicitly.
#if defined(MANTLE_HARD_TREE) || defined(MANTLE_HARD_MIXED) || (defined(MANTLE_GWN) && !defined(MANTLE_GWN_SDF))
#define GWN_WINDING_ONLY 1
#endif
// GWN_EXACT_AREA: the GWN+SDF COVERAGE kernel's exact-area pass, and the AAC integrands it calls. Exactly
// the programs that compile renderFillGWNSDF (the guard below) and build coverage with it (not GWN_WINDING_ONLY).
#if defined(MANTLE_GWN) && defined(MANTLE_GWN_SDF) && !defined(MANTLE_HARD) && !defined(MANTLE_HARD_MIXED) && !defined(MANTLE_HARD_TREE)
#define GWN_EXACT_AREA 1
#endif
// Signed +x-axis ray crossing of the directed edge a -> b (coords RELATIVE to the pixel), shared by the
// GWN tree's chord polygon and band-hard's line walk (hardCrossLine), which is why it sits outside the tree's
// own guard:
// the cheap piece of the TELESCOPED leaf winding. A contiguous run's per-segment chord
// angles sum to ONE chord angle of the whole run plus the winding of the closed chord
// polygon around the pixel — so a near leaf costs one atan2 total, with the polygon
// winding counted by these sign tests instead of trig.
float gwnChordT(vec2 a, vec2 b) { return a.x * (b.y - a.y) - a.y * (b.x - a.x); }

float gwnCross(vec2 a, vec2 b) {
  if ((a.y < 0.0) == (b.y < 0.0)) return 0.0;
  float dy = b.y - a.y;
  float t = gwnChordT(a, b);
  return dy < 0.0 ? (t < 0.0 ? -1.0 : 0.0) : (t > 0.0 ? 1.0 : 0.0);
}

#if defined(MANTLE_HARD_TREE) || (defined(MANTLE_GWN) && !defined(MANTLE_HARD) && !defined(MANTLE_HARD_MIXED))
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
  return curveAtan2(a.x * b.y - a.y * b.x, dot(a, b)) / GWN_TAU;
}

// ---------------------------------------------------------------------------
// GWN + implicit-SDF. AA WITHOUT AAC.

// Two endpoint/corner refinements keep the local half-plane approximation valid:
//  * END-TANGENT EXTENSION. An implicit does not stop at its segment's endpoints, and past them
//    it CURLS (the far arm of the parabola) — near-circle seam pixels read the curled extension
//    of the neighboring quad and lost coverage one-sidedly (all 24 bad px sat exactly at the
//    8 joint angles; 415 negative-error px vs 77 positive). Out-of-span candidates therefore
//    use the segment's END-TANGENT half-plane through the endpoint — the honest linear
//    continuation (the same osculating-line rule the LB kind-12 band uses in its corner wedges).
//  * TWO-CANDIDATE COMBINE. One half-plane per pixel undercounts any pixel holding two distinct
//    edges (corners; the triangle's 2 bad px). Keep the best candidate from TWO different
//    segments and combine with the LB kind-10 chained-coverage rules — intersection for convex,
//    union for reflex, blended toward min/max as the planes become parallel (seams degrade to
//    the single-plane answer). Convex/reflex is decided by the winding: if the center is inside
//    the fill but only ONE plane claims it, the corner is reflex (fill = union); outside with
//    one claim = convex (fill = intersection); unanimous pixels default to the convex blend.
struct GwnSdfCand {
  float dpx;    // rank: TRUE |distance| to the segment in pixels (endpoint distance beyond the
                // span — an unbounded plane passes near pixels on the far side of the shape
                // and a bogus near-plane there destroys the ranking). 1e30 = no candidate.
  float sFill;  // FILL-signed distance of the coverage half-plane at the pixel center, pixels
                // (+ = center on the ink side). Oriented by travel x contour handedness —
                // deterministic, no winding-agreement flip (which inverts near cov = 1/2 and
                // misoriented reflex inner-ring joints).
  vec2 nf;      // unit INTO-FILL plane normal, PIXEL space
  vec2 tv;      // unit TRAVEL tangent at the near point (em space) — corner classification
  float endNear;// +1 pixel near the segment's END, -1 near its START, 0 mid-segment
  vec2 V;       // the near endpoint (em) when endNear != 0
  float sg;     // the PIECE's ink side (+1 left of travel, -1 right; +-2 it changes along the piece): the corner test's handedness
};

// Evaluate one segment as an SDF candidate (the caller still sums exact per-segment GWN for
// winding). PIXEL-SPACE gradient = em-gradient / px (em = c + delta/px per axis), so the
// distance |f|/|grad| comes out in pixels at any scale.
// THE PIXEL'S SIDE OF A PIECE'S CHORD, decided the way gwnCross decides the chord's crossing. A lune term (+-1 between a
// piece's chord and its curve) is only right if it and the chord crossing agree about pixels ON the chord, and they did
// not: gwnCross counts a crossing only strictly right of the pixel, so a chord through the pixel counts nothing, and the
// lune tests (strict `devS * luneAdd > 0` for arcs and cubics, inclusive `m >= 0` for quads) either skipped the pixel or
// took it on the curve's side regardless. Either way one pixel on every such chord wound 0 where it is inside, or 1
// where it is outside -- an integer circle puts pixel centers exactly on its quarter-chords, along its diagonals.
// gwnCross's convention is a pixel moved a hair right (a crossing at x = 0 is left of it) and, only where a y is exactly
// 0, a much smaller hair down (y = 0 counts non-negative). Here: the sign of -t (the `(p - a) x (b - a)` cross the lune
// tests use), from the same float expression gwnCross uses, and on the chord the side that move puts the pixel on.
float gwnChordSide(vec2 a, vec2 b) {
  float t = gwnChordT(a, b);
  if (t != 0.0) return t < 0.0 ? 1.0 : -1.0;
  float dy = b.y - a.y;
  return (dy != 0.0 ? dy : b.x - a.x) > 0.0 ? 1.0 : -1.0;
}
// The two-half-plane clip is _boxCov.glsl's exactBoxCov2. This file carried a BYTE-IDENTICAL copy
// as gwnBoxCov2 -- the same Sutherland-Hodgman clip and shoelace, character for character.


// Merged per-segment evaluation: ONE set of texel fetches yields the winding pieces (the
// chord-polygon crossing + the quad's lune term, sharing the barycentric work) AND the SDF
// candidate. Returns the winding contribution (integer-valued, in turns). `sigma` is the
// piece's ink side (+1 = ink left of travel), from its leaf ref (R.w).
// Exact +x ray crossing of a cubic (defined below with the hard-band crossers). A cubic PIECE
// winds with this, not with chord + lune — see the type-4 branch.
float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);

#ifdef GWN_EXACT_AREA
// AAC's per-segment integrands (defined below, in the AAC section every program compiles): -∫ clamp(X, 0, 1) dclamp(Y)
// of a curve in PIXEL-LOCAL coordinates, the unit box being the pixel. Summed over a closed outline that is the winding
// integrated over the pixel, which aacFold turns into coverage -- AAC's own definition of the exact area.
vec2 aacPL(vec2 emPt, vec2 c, vec2 px);
float aacLineContrib(vec2 A, vec2 B, float q0, float q1);
float aacQuadContrib(vec2 P0, vec2 P1, vec2 P2, float q0, float q1);
float aacCubicContrib(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float q0, float q1);
#ifndef MANTLE_NO_ARC
float aacArcContrib(vec4 d1, vec4 d2, vec4 ends, vec2 c, vec2 px, float q0, float q1);
#endif
float aacFold(float run, bool evenOdd);
/// One piece's integral over the pixel box, from its own record: every piece type carries its whole curve (a cubic
/// piece its control points in texel 5, an arc piece its angles in texel 4 -- textures.js, for this pass).
float gwnPieceArea(vec2 c, vec2 px, ivec2 sL, int type) {
  if (type == 0) {                                    // line: (header) (A, B)
    vec4 pe = texFetch(ivec2(sL.x + 1, sL.y));
    return aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), 0.0, 1.0);
  }
  if (type == 1) {                                    // quad: (header) (P0, P1) (P2)
    vec4 p12 = texFetch(ivec2(sL.x + 1, sL.y));
    vec2 p3 = texFetch(ivec2(sL.x + 2, sL.y)).xy;
    return aacQuadContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p3, c, px), 0.0, 1.0);
  }
  if (type == 4 || type == 6) {                       // cubic piece (P0, P3) .. (P1, P2); hard piece (P0, P1) (P2, P3)
    vec4 a = texFetch(sL);
    vec4 b = texFetch(ivec2(sL.x + (type == 4 ? 5 : 1), sL.y));
    vec2 P0 = a.xy, P1 = type == 4 ? b.xy : a.zw, P2 = type == 4 ? b.zw : b.xy, P3 = type == 4 ? a.zw : b.zw;
    return aacCubicContrib(aacPL(P0, c, px), aacPL(P1, c, px), aacPL(P2, c, px), aacPL(P3, c, px), 0.0, 1.0);
  }
#ifndef MANTLE_NO_ARC
  if (type == 5) {                                    // arc piece: (E0, E1) (cx, cy, rx, ry) .. (th0, th1, phi, 0)
    return aacArcContrib(texFetch(ivec2(sL.x + 1, sL.y)), texFetch(ivec2(sL.x + 4, sL.y)), texFetch(sL), c, px, 0.0, 1.0);
  }
#endif
  return 0.0;
}
#endif


float gwnSegEval(vec2 c, vec2 px, ivec2 sL, int type, float sigma, out GwnSdfCand cand) {
  cand.dpx = 1e30; cand.sFill = 0.0; cand.nf = vec2(0.0);
  cand.tv = vec2(0.0); cand.endNear = 0.0; cand.V = vec2(0.0); cand.sg = sigma;
  if (type == 6) {

    vec4 p01 = texFetch(sL);                          // (P0, P1)
    vec4 p23 = texFetch(ivec2(sL.x + 1, sL.y));       // (P2, P3)
    // THE CONTROL HULL IS A FREE REJECT, as the type-4 exact path already takes it: the curve lies inside the hull of
    // its control points, so a row outside the hull's y-range or a pixel right of its max x meets no +x crossing. A pixel
    // LEFT of the hull sees the cubic cross its ray exactly as the chord P0->P3 does -- curve plus reversed chord is a
    // closed loop inside the hull, and it cannot wind around a point outside it.
    float t6ylo = min(min(p01.y, p01.w), min(p23.y, p23.w)), t6yhi = max(max(p01.y, p01.w), max(p23.y, p23.w));
    float t6xlo = min(min(p01.x, p01.z), min(p23.x, p23.z)), t6xhi = max(max(p01.x, p01.z), max(p23.x, p23.z));
    float wSeg = (c.y < t6ylo || c.y > t6yhi || c.x > t6xhi) ? 0.0
               : (c.x < t6xlo ? gwnCross(p01.xy - c, p23.zw - c) : hardCrossCubic(c, p01 - vec4(c, c), p23 - vec4(c, c)));
#ifdef GWN_WINDING_ONLY
    return wSeg;                                      // winding-only: no coverage is ever built from the candidate
#endif
    vec2 A = p01.xy, B = p23.zw, t = B - A;            // the chord, as a line candidate
    float L2 = dot(t, t);
    if (!(L2 > 0.0)) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);
    float f = dot(n, c - A);
    vec2 gPx = n / px;
    float gpx = length(gPx);
    if (!(gpx > 0.0)) return wSeg;
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
#ifdef GWN_WINDING_ONLY
    return wSeg;
#endif
    float L2 = dot(t, t);
    if (!(L2 > 0.0)) return wSeg;
    vec2 n = vec2(-t.y, t.x) * inversesqrt(L2);      // = leftPerp(travel)
    float f = dot(n, c - A);
    vec2 gPx = n / px;                                // px-space gradient
    float gpx = length(gPx);
    if (!(gpx > 0.0)) return wSeg;
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
    float tproj = cl2 > 0.0 ? dot(c - P0, chord) / cl2 : 0.5;
    // barycentrics: needed by the LUNE winding term at any tproj, and by the in-span
    // implicit — computed once.
    float d = (P1.y - P2.y) * (P0.x - P2.x) + (P2.x - P1.x) * (P0.y - P2.y);
    float l = 0.0, m = 0.0, n_ = 0.0, u = 0.0, v = 0.0;
    vec2 gL = vec2(0.0), gm = vec2(0.0), gn = vec2(0.0);
    bool haveBary = d != 0.0;
    if (haveBary) {
      gL = vec2(P1.y - P2.y, P2.x - P1.x) / d;        // grad of bary(P0)  (not gl_*)
      gm = vec2(P2.y - P0.y, P0.x - P2.x) / d;        // grad of bary(P1)
      l = dot(gL, c - P2); m = dot(gm, c - P2);
      n_ = 1.0 - l - m;
      gn = -gL - gm;
      u = m * 0.5 + n_; v = n_;
      // LUNE: in the control triangle, between chord and curve → ±1 winding correction. The chord edge of the
      // triangle is gwnChordSide's, not `m >= 0` (see there); the other two edges never meet the lune off its ends.
      float sideP = (P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x;
      if (l >= 0.0 && gwnChordSide(P0 - c, P2 - c) * sideP > 0.0 && n_ >= 0.0 && (u * u - v) < 0.0) {
        wSeg += sign(sideP);
      }
    }
    vec2 gEm; float f; float rank = -1.0;
    if (tproj < 0.0 || tproj > 1.0) {
      // Out of span: the end-tangent half-plane through the endpoint. The raw implicit's far
      // arm CURLS past the endpoint — near-circle seam pixels read the neighboring quad's
      // curled extension and lost coverage one-sidedly (all 24 bad px at the 8 joint angles).
      vec2 V  = tproj < 0.0 ? P0 : P2;
      vec2 tg = tproj < 0.0 ? P1 - P0 : P2 - P1;
      float tl2 = dot(tg, tg);
      if (!(tl2 > 0.0)) { tg = chord; tl2 = cl2; }
      if (!(tl2 > 0.0)) return wSeg;                  // every control point in one place: no edge
      vec2 n = vec2(-tg.y, tg.x) * inversesqrt(tl2);
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
    if (!(gpx > 0.0)) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;
    // SLAB-AWARE rank (see the piece branch): the parabola's far arm passes the chord-span
    // test far from the segment; a quad's true max deviation is exactly ctrlDev / 2.
    if (rank < 0.0 && cl2 > 0.0) {
      float cl9 = sqrt(cl2);
      float devS9 = ((c.x - P0.x) * chord.y - (c.y - P0.y) * chord.x) / cl9;
      float ctrlDev = abs((P1.x - P0.x) * chord.y - (P1.y - P0.y) * chord.x) / cl9;
      float slabPx = (abs(devS9) - 0.5 * ctrlDev) / min(1.0 / px.x, 1.0 / px.y);
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
    if (!(cl2 > 0.0)) return wSeg;
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
      if (min(tc.z, tc.w) <= 1e-4 * max(tc.z, tc.w)) {     // relative; both zero reads degenerate too
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
    // The bulge side is gwnChordSide's (a pixel ON the chord included), so the lune and the chord crossing agree.
    if (tproj > 0.0 && tproj < 1.0 && gwnChordSide(E0 - c, E1 - c) * luneAdd > 0.0 && abs(devS) <= maxDev
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
    if (!(gpx > 0.0)) return wSeg;
    float dPlane = abs(f) / gpx;
    cand.dpx = rank >= 0.0 ? rank : dPlane;
    // SLAB-AWARE rank: the implicit is GLOBAL (the whole ellipse / the cubic's full branch),
    // so a pixel near a DIFFERENT part of the curve can pass the chord-span test with a tiny
    // |f| and claim this piece with an inverted travel frame (capsule arc pixels near the
    // line seam claimed the OPPOSITE quarter's piece — hard holes). The piece itself lies
    // within its chord slab, so |devS| - maxDev is a true lower bound on the distance.
    float slabPx = (abs(devS) - maxDev) / min(1.0 / px.x, 1.0 / px.y);
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

// Cusp/loop cubic pieces (type 6) wind with the exact cubic +x ray-crossing — same convention as
// gwnCross's chord crossings — handled in renderFillGWNSDF's leaf loop, not gwnSegEval (keeps that
// hot function's codegen untouched). Defined below with the other hard-band crossers.
float hardCrossCubic(vec2 c, vec4 p12, vec4 p34);


vec2 gwnBoxSize(vec4 bb) { return bandBoxSize(bb); }   // the bands' box (bandBoxSize, above)

#ifdef GWN_EXACT_AREA
// The fill rule on a winding number (the kernel's `inside`).
float gwnFillOf(float w, bool evenOdd) {
  float aw = abs(w);
  return evenOdd ? ((mod(aw, 2.0) >= 0.5 && mod(aw, 2.0) < 1.5) ? 1.0 : 0.0) : step(0.5, aw);
}
// THE INK SIDE OF THE NEAREST CANDIDATE WHERE IT IS NEAREST, from the exact winding: +1 left of travel, -1 right, 0 no
// boundary there. Nothing lies between the pixel center and the nearest piece's near point (an interior point: a crossing
// there steps the winding by one), so the winding on the center's side of it is w, and across it w - 1 (the center left of
// travel) or w + 1 (right): gwnCross counts a piece that passes the center on its right going up +1, so its left side winds
// one more. `sFill` is signed by the side the piece was evaluated with (R.w; 0 was evaluated as +1).
float gwnLocalSide(GwnSdfCand c, float w, bool evenOdd, float inside) {
  bool left = c.sFill * (c.sg == 0.0 ? 1.0 : sign(c.sg)) >= 0.0;
  if (gwnFillOf(left ? w - 1.0 : w + 1.0, evenOdd) == inside) return 0.0;
  return left == (inside > 0.5) ? 1.0 : -1.0;
}
// The pixel's coverage from its winding and at most two boundary half-planes -- the model renderFillGWNSDF answers with.
// `holds` says whether the model describes this pixel, and where it does not the caller integrates the pixel
// exactly instead: where its answer about the pixel CENTER is not the exact winding's there (a plane with the center on
// the wrong side, or a two-plane combine that claims the center where the winding does not, or the reverse), where the
// nearest piece's side there is not the one the build gave it, and where its one plane is the end tangent at a VERTEX --
// a corner whose other side is no candidate, which the plane runs on past.
float gwnModelCov(GwnSdfCand c1, GwnSdfCand c2, float w, bool evenOdd, float inside, vec2 px, out bool holds) {
  holds = true;
  if (c1.dpx > 0.70710678) return inside;
  float loc = c1.endNear == 0.0 ? gwnLocalSide(c1, w, evenOdd, inside) : 9.0;
#ifdef GWN_DIAG_SINGLE
  bool single = true;                                 // DIAGNOSTIC: every edge pixel takes the single-plane path
#else
  bool single = c2.dpx > 0.70710678;
#endif
  float cA = exactBoxCov(-c1.nf, c1.sFill);
  if (single) {                                       // single-edge pixel: done
    if (loc == 0.0 && c1.sg == 0.0) return inside;    // no boundary here, and the build says none: nothing cuts the cell
    holds = loc == sign(c1.sg) && c1.sg != 0.0 && (c1.sFill >= 0.0) == (inside > 0.5);
    return cA;
  }
  // Two planes model the pixel only with one ink side each: not a piece that changes side along it (|sg| 2), nor one that
  // is no boundary (sg 0), which the combine has no plane for.
  holds = abs(c1.sg) == 1.0 && abs(c2.sg) == 1.0 && (loc == 9.0 || loc == c1.sg);

  bool reflex = false;
  bool corner = c1.endNear != 0.0 && c2.endNear != 0.0 && c1.endNear != c2.endNear;
  if (corner) {
    vec2 dV = (c1.V - c2.V) * px;
    corner = dot(dV, dV) < 0.01;
    if (corner) {
      vec2 tIn = c1.endNear > 0.0 ? c1.tv : c2.tv;
      vec2 tOut = c1.endNear > 0.0 ? c2.tv : c1.tv;
      float turn = tIn.x * tOut.y - tIn.y * tOut.x;
      reflex = turn * (c1.endNear > 0.0 ? c1.sg : c2.sg) < 0.0;
    }
  }
  // Two planes combine only at a true corner: both candidates ending at one shared vertex that is not a smooth split
  // point (the leaf loop clears endNear at those). Any other pair is two views of nearly one boundary or two unrelated
  // edges, and guessing "reflex" from their fill signs could union them into a full pixel outside the ink. Those pixels take the single-plane answer where it holds -- both planes agree with the center winding, and the
  // one it takes is no end tangent at a vertex (whose other side is not the second candidate).
  if (!corner) { holds = holds && (c1.sFill >= 0.0) == (inside > 0.5) && (c2.sFill >= 0.0) == (inside > 0.5) && c1.endNear == 0.0; return cA; }
  // ...AND THE COMBINE MUST AGREE WITH THE WINDING ABOUT THE CENTER. The intersection
  // contains the pixel center iff both half-planes do, the union iff EITHER does — so where
  // exactly one contains it the two combines give opposite answers about the center, and the
  // exact crossing count has already settled that. This is a consistency condition between two
  // exact facts, with no threshold in it: `reflex` is a model of the vertex and `inside` is not.
  //
  bool bothIn = (c1.sFill >= 0.0) && (c2.sFill >= 0.0);
  bool anyIn  = (c1.sFill >= 0.0) || (c2.sFill >= 0.0);
  if (anyIn != bothIn) reflex = inside > 0.5;
  if (anyIn == bothIn && bothIn != (inside > 0.5)) holds = false;
  if (c1.sg != c2.sg) holds = false;
  float inter = exactBoxCov2(-c1.nf, c1.sFill, -c2.nf, c2.sFill);     // exact area(A ∩ B ∩ box)
  // the second candidate's own box coverage only the union reads -- formed here, past the non-corner return that
  // discarded it
  return reflex ? (cA + exactBoxCov(-c2.nf, c2.sFill) - inter) : inter;   // union by inclusion-exclusion
}
#endif
float renderFillGWNSDF(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1, bandsX = GD.z + 1;
  vec4 hdr = bFetch(bLoc(gl, (bandsY + bandsX) * 2));
  int nodeBase = int(hdr.x), nodeCount = int(abs(hdr.y)), refBase = int(hdr.z);
  if (nodeCount <= 0) return 0.0;

  // px is finite and positive (the call site floors em per pixel at 1e-30). A 1e-6 floor here capped em per pixel at
  // 1e6: at 2^20 every prune below read a reach 4.6% short and dropped AA candidates inside it.
  vec2 emPerPx = 1.0 / px;
  float cellR = 0.70710678 * max(emPerPx.x, emPerPx.y);
#ifdef GWN_WINDING_ONLY
  // Winding needs no reach. Every prune below is widened by cellR so AA candidates inside the filter's reach survive,
  // and the neighbor-band pass exists for them too. The winding-only programs build no coverage, and winding is exact
  // outside a subtree's own circle, an entry's own rows and a cell's own margin -- the widening only made them walk more.
  cellR = 0.0;
#endif
  vec4 ext = bFetch(bLoc(gl, refBase + int(hdr.w)));  // (rootBandBase, GB, gridBase, gridWH)

  // TIER 3 — OCCUPANCY GATE. The encoder certified: every point of this cell is at least
  // `margin` from the boundary. If margin exceeds the pixel's cell radius, the full walk
  // below would find no candidate inside the AA window and return folded 0/1 — so return it
  // from ONE fetch. (Winding was computed on the certified polyline, exact by homotopy.)
  int gridBase = int(ext.z);
  if (gridBase > 0) {
    int gwh = int(ext.w);
    int GW = gwh >> 8, GH = gwh & 255;              // non-negative: shifts and masks, not divides
    vec2 bbSz = gwnBoxSize(shapeBB);
    vec2 g = (c - shapeBB.xy) / bbSz * vec2(float(GW), float(GH));
    int gx = int(floor(g.x)), gy = int(floor(g.y));
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) {
      int ci = gy * GW + gx;
      vec4 cell = bFetch(bLoc(gl, gridBase + (ci >> 1)));
      vec2 wm = (ci & 1) == 0 ? cell.xy : cell.zw;
      if (wm.y > cellR) {
        float awg = abs(wm.x);
        if (!evenOdd) return step(0.5, awg);
        float mg = mod(awg, 2.0);
        return (mg >= 0.5 && mg < 1.5) ? 1.0 : 0.0;
      }
    }
  }

  float w = 0.0;
#ifdef GWN_EXACT_AREA

  vec2 hb = 0.5 * emPerPx;                            // half the pixel box, em
  bool subPx = false;
  float run = 0.0;
#endif
  GwnSdfCand c1, c2;                                  // two nearest candidates, distinct segments
  c1.dpx = 1e30; c1.sFill = 0.0; c1.nf = vec2(0.0); c1.tv = vec2(0.0); c1.endNear = 0.0; c1.V = vec2(0.0); c1.sg = 0.0;
  c2 = c1;

  // TIER 2 — the Slug band early-exit, transplanted onto the tree. The winding is a +x-ray
  // crossing count and every contribution of a cut subtree (chords, lunes, curve geometry)
  // lies inside its circle, so a subtree whose circle misses the pixel's row or sits left of
  // it contributes exactly zero. Entries are y-banded and sorted by descending maxX: break at
  // the first entry past the pixel (dilated by cellR so AA candidates survive). A pixel
  // within cellR of a band edge walks the neighbor band too, skipping entries the primary
  // already saw (encode-time adjacency flags — no f32 re-derivation of band membership).
  int GB = 0, byP = 0, nbB = -1, rbBase = 0;
  GB = int(ext.y); rbBase = int(ext.x);
  if (GB > 0) {
    float bandH = gwnBoxSize(shapeBB).y / float(GB);
    if (bandH <= 2.0 * cellR) { GB = 0; }             // shape only a few px tall: bands invalid
    else {
      byP = clamp(int((c.y - shapeBB.y) / bandH), 0, GB - 1);
      float yloc = c.y - shapeBB.y - float(byP) * bandH;
      if (yloc < cellR && byP > 0) nbB = byP - 1;
      else if (bandH - yloc < cellR && byP < GB - 1) nbB = byP + 1;
    }
  }

#ifdef GWN_EXACT_AREA
  for (int ph = 0; ph < 2; ph++) {
  if (ph == 1 && !subPx) break;
#endif
  for (int pass = 0; pass < 2; pass++) {
    int eBase = 0, eCount = 1;                        // unbanded: one pseudo-entry, the root
    if (GB > 0) {
      int bandIdx = pass == 0 ? byP : nbB;
      vec4 bh = bFetch(bLoc(gl, rbBase + (bandIdx >> 1)));
      vec2 bc = (bandIdx & 1) == 0 ? bh.xy : bh.zw;
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
        rootI = ex >> 2;
        int fl = ex & 3;
        if (pass == 1 && ((nbB < byP && (fl & 1) == 1) || (nbB > byP && fl >= 2)))
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
#ifdef GWN_EXACT_AREA
          if (ph == 1) {
            if (abs(dcv.y) <= B.z + hb.y && B.x + B.z > c.x - hb.x) run += aacLineContrib(aacPL(A.xy, c, px), aacPL(A.zw, c, px), 0.0, 1.0);
          } else
#endif
          if (abs(dcv.y) <= B.z && B.x + B.z > c.x) w += gwnCross(A.xy - c, A.zw - c);
          ni = B.w >= 0.0 ? int(B.w) : ni + 1;
          continue;
        }
#ifdef GWN_EXACT_AREA
        if (abs(dcv.x) + B.z <= hb.x && abs(dcv.y) + B.z <= hb.y) subPx = true;
#endif
        if (B.w < 0.0) {
          // NEAR leaf (code = -(refStart*64 + refCount + 1)): per-segment chord-polygon edges +
          // lune terms, riding the same fetches and barycentric work the SDF candidates do.
          int v = int(-B.w) - 1;
          int rc = v & 63, rs = v >> 6;
          for (int k = 0; k < 32; k++) {
            if (k >= rc) break;
            vec4 R = bFetch(bLoc(gl, refBase + rs + k));
#ifdef GWN_EXACT_AREA
            if (ph == 1) { run += gwnPieceArea(c, px, ivec2(int(R.x), int(R.y)), int(R.z + 0.5) & 15); continue; }
#endif
            GwnSdfCand cd;
            // Ink side from the ENCODER (R.w), per PIECE, not from the shape's shoelace majority: the build asks the
            // fill rule's exact inside test on both sides of a point on the piece, so a hole wound like
            // its outer (which is what an even-odd hole IS) gets the right sign, and so does each stretch of a
            // self-intersecting contour, and so do CORNERS, where no runtime rule can decide it.
            //
            // R.w == 0 means the piece is NOT A BOUNDARY: both of its sides are filled (a contour wound like its
            // parent under nonzero, winding 1 → 2), or neither is (a piece traced back along itself). It still
            // contributes winding -- that is what makes the inside 2 -- but it must paint no coverage ramp, or a seam
            // runs through the middle of a solid shape. Where it is the only piece near a pixel the pixel takes the
            // winding's answer; where another is near too, the exact pass (gwnModelCov).
            //
            // R.w == +-2: the piece's side CHANGES along it (another curve crosses it). Its plane takes the sign, and
            // gwnModelCov keeps the model only where the side is that one (the nearest piece's, gwnLocalSide).
            float sgP = R.w;
            // R.z = piece type + 16 * smooth-end flags (bit 0 start, bit 1 end) -- see textures.js' _pieceSmooth.
            int rz = int(R.z + 0.5), pty = rz & 15;
            w += gwnSegEval(c, px, ivec2(int(R.x), int(R.y)), pty, sgP == 0.0 ? 1.0 : sign(sgP), cd);
            cd.sg = sgP;
            // An endpoint inside one smooth curve is not a corner. Two pieces of a split cubic or arc share it and both
            // come back endNear there, so the combine intersected (or unioned) two planes that are one boundary.
            { int smb = rz >> 4; if ((cd.endNear < 0.0 && (smb == 1 || smb == 3)) || (cd.endNear > 0.0 && smb >= 2)) cd.endNear = 0.0; }
#if defined(GWN_DIAG_FLIP_T0) || defined(GWN_DIAG_FLIP_T1) || defined(GWN_DIAG_FLIP_T4) || defined(GWN_DIAG_FLIP_T6)
            // DIAGNOSTIC: negate ONE piece type's coverage plane, to find the type whose fill sign is derived backwards.
            {
              int dt = pty;
              bool flip = false;
#ifdef GWN_DIAG_FLIP_T0
              flip = flip || dt == 0;
#endif
#ifdef GWN_DIAG_FLIP_T1
              flip = flip || dt == 1;
#endif
#ifdef GWN_DIAG_FLIP_T4
              flip = flip || dt == 4;
#endif
#ifdef GWN_DIAG_FLIP_T6
              flip = flip || dt == 6;
#endif
              if (flip) { cd.nf = -cd.nf; cd.sFill = -cd.sFill; }
            }
#endif
#ifndef GWN_WINDING_ONLY
            // every piece is a candidate, a no-boundary one too: the model's nearest piece must BE the nearest, or the
            // winding beside it is not the center's (gwnLocalSide), and a no-boundary one where nothing else reaches
            // the cell answers with the winding alone (gwnModelCov)
            if (cd.dpx < c1.dpx) { c2 = c1; c1 = cd; }
            else if (cd.dpx < c2.dpx) { c2 = cd; }
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
#ifdef GWN_EXACT_AREA
  if (ph == 1) break;
  // PHASE 0 DONE: the model's answer, unless a subtree lies inside the box or the model does not hold here.
  float inside = gwnFillOf(w, evenOdd);
  bool holds;
  float cov = gwnModelCov(c1, c2, w, evenOdd, inside, px, holds);
  if (!subPx && holds) return cov;
  subPx = true;
  }
  return aacFold(run, evenOdd);
#else
  // Tree-hard and bare-GWN programs (GWN_WINDING_ONLY, the only others that compile this kernel): the folded winding.
  float aw = abs(w);
  return evenOdd ? ((mod(aw, 2.0) >= 0.5 && mod(aw, 2.0) < 1.5) ? 1.0 : 0.0) : step(0.5, aw);
#endif
}
// GWN run-tree kernel (excluded from band-only MIXED).
#endif

// ---------------------------------------------------------------------------
// NO-AA fill over the BANDS (the Slug/AAC data structure). For an OPAQUE, UNDASHED stroked shape
// the stroke covers the fill's 1px boundary band, so the fill needs only inside/outside — a
// containment test, no anti-aliasing. Cheapest the band structure can answer it: a horizontal ray
// from the pixel, counting signed crossings of the band's segments. (NOT the GWN subtended-ANGLE
// winding of gwnSegEval — that only telescopes over the whole contour; a ray crossing is
// per-segment-local and so is correct over the single band at c.y.) LINE + QUAD.
// Line crossing at y = c.y: root t of the linear y, add sign(dy) if the crossing x > c.x.
float hardCrossLine(vec2 c, vec2 A, vec2 B) {
  // ENDPOINT SIDES, not t. A vertex shared by two segments has one y, so it is on one side of the ray for both of them and
  // the pair counts it exactly once; `t in [0,1)` computed per segment could count it once, twice or not at all.
  // WHICH SIDE OF THE PIXEL, BY SIGNS. This formed the crossing's x with a divide only to compare it with c.x;
  // (x - c.x)(ay - by) is the chord's cross product, so the comparison is a sign test -- gwnCross, the tree's chord
  // crossing, the same float expression and convention (+1 upward, -1 downward, 0 counting non-negative), so the two
  // no-AA kernels decide a line's crossing identically. Differs from the divide only where the edge passes within
  // rounding of the pixel center, which lies under the opaque stroke that makes band-hard legal.
  return gwnCross(A - c, B - c);
}
// Quad crossing: roots of y(t) = c.y, B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2.
float hardCrossQuad(vec2 c, vec2 P0, vec2 P1, vec2 P2) {
  // Slug's root eligibility. calcRootCode2 admits each root from the sign pattern of the three ray-centered control ys, so a
  // root at an endpoint or a tangent double root is decided by topology, not by an FP boundary test; slugSolveHorizQuad is the
  // stable pair. Root 1 is a crossing toward -y (Slug +1), root 2 toward +y; band-hard counts +y as +1.
  vec4 p12 = vec4(P0 - c, P1 - c);
  vec2 p3 = P2 - c;
  uint code = calcRootCode2(p12.y, p12.w, p3.y);
  if (code == 0u) return 0.0;
  // The hull right of the pixel: every admitted root lies at x > c.x -- the curve is a convex combination of
  // its control points -- so the count IS the code, and the solve that only tested rt > 0 is skipped. Strictly
  // right, in the solver's own ray-centered coordinates, so no tolerance and the same at every scale; the answer
  // moves only where the solve's x rounded onto or past the pixel center from a hull wholly right of it.
  if (min(min(p12.x, p12.z), p3.x) > 0.0) return ((code > 1u) ? 1.0 : 0.0) - (((code & 1u) != 0u) ? 1.0 : 0.0);
  vec4 rt = slugSolveHorizQuad(p12, p3);
  float w = 0.0;
  if ((code & 1u) != 0u && !isinf(rt.x) && rt.x == rt.x && rt.x > 0.0) w -= 1.0;
  if (code > 1u && !isinf(rt.y) && rt.y == rt.y && rt.y > 0.0) w += 1.0;
  return w;
}
// Cubic crossing: reuse Slug's exact H-ray solver (solveCubicBisect), take the +x crossings.
// p12/p34 are the control points CENTERED on c, exactly as Slug's H-CUBIC walker feeds them.
// rs[j] is the x-intercept relative to c (em); a +x ray counts it iff rs[j] > 0. No box filter.
// SIGN: +1 for an UPWARD crossing (dY/dt > 0), matching hardCrossLine/hardCrossQuad/gwnCross so
// this composes with them in one shape's fold. (The tree's type-6 cusp pieces and any vetoed
// cubic band shape both read this sign, so both need the +up convention.)
float hardCrossCubic(vec2 c, vec4 p12, vec4 p34) {
  vec3 rs, ts, up;
  solveCubicBisect(p12, p34, false, rs, ts, up);
  float w = 0.0;
  for (int j = 0; j < 3; j++) {
    if (ts[j] < 0.0 || rs[j] != rs[j]) continue;       // t = 1 is a real crossing (see solveCubicBisect)
    if (rs[j] <= 0.0) continue;                         // crossing must be at x > c.x
    w += (up[j] > 0.5) ? 1.0 : -1.0;                    // upward crossing => +1
  }
  return w;
}
// Arc crossing: THE ENDPOINT SIDES DECIDE, exactly as in hardCrossLine — no tolerance anywhere in
// the count. d1 = (cx, cy, rx, ry), d2 = (thetaStart, thetaEnd, phi, _). The rule is arcRayCrossings,
// shared with Slug's two arc walkers; this walker takes the +x crossings and counts, with no ramp.
//
float hardCrossArc(vec2 c, vec4 d1, vec4 d2, vec4 ends) {
  float sp = sin(d2.z), cp = cos(d2.z);
  vec3 sw = arcSweep(d2);
  // The ends are the stored vertices: the path's own points, as the segments beside the arc store them, so a
  // vertex on the ray is decided by one float for both -- the snap to the row that the rebuilt ends needed is gone.
  vec2 pLo, pHi;
  arcEndsLoHi(ends, sw.z, pLo, pHi);

  if (d1.x - (abs(cp * d1.z) + abs(sp * d1.w)) - c.x > 4.0 * arcRayUlpV(d1)) {
    float nnLo = (pLo.y - c.y >= 0.0) ? 1.0 : 0.0, nnHi = (pHi.y - c.y >= 0.0) ? 1.0 : 0.0;
    return sw.z * (nnHi - nnLo);
  }
  vec4 pcU; vec3 axU;
  vec3 cr = arcRayCrossings(sw.x, sw.y, sw.z, sp * d1.z, cp * d1.w, -(d1.y - c.y),
                            pLo.y - c.y, pHi.y - c.y, false, pcU, axU);
  // band-hard places its roots by angle (Slug by the closed form); the acos only where a piece crosses
  vec3 thc = (cr.x + cr.y + cr.z > 0.0) ? arcRayRoots(sw.x, sw.y, sp * d1.z, cp * d1.w, -(d1.y - c.y), pcU, axU) : vec3(sw.x);
  float w = 0.0;
  for (int j = 0; j < 3; j++) {
    if (cr[j] == 0.0) continue;
    vec2 pnt; float ddx, ddy; arcSample(d1, cp, sp, thc[j], pnt, ddx, ddy);
    if (pnt.x <= c.x) continue;                          // +x crossing only
    w += (cr[j] > 1.5) ? -1.0 : 1.0;                     // ending below: -1; +y counts +1, like hardCrossLine/Quad/Cubic
  }
  return w;
}

float renderFillHardBand(vec2 c, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);
  int by = clamp(int((c.y - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int hdr = texLin(gl) + by * 2;             // the band header, as a linear index
  vec4 cnts = bFetchL(hdr);
  int nLine = int(cnts.x), nQuad = int(cnts.y);
  vec4 hdr1 = bFetchL(hdr + 1);
  int hE = texLin(gl) + int(hdr1.x);         // the list's first entry, linear; steps past each type's run
  // the H ray's lane reject, as Slug's H walker takes it (rayLaneMiss).
  bool rej = fillRayReject(hdr1);
  float w = 0.0;
  // BREAK-EARLY PRUNE (the same one Slug/AAC use): band entries carry .z = the segment's maxX,
  // sorted DESCENDING. A +x ray from the pixel counts crossings at x > c.x, so a segment whose
  // maxX < c.x cannot contribute, and neither can any later (smaller-maxX) one — stop. Exact here,
  // with no AA margin: the box-filter versions need `.z - c.x < -halfPx`; a hard crossing needs
  // only `.z < c.x`.
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    vec4 pe = cFetchL(sL + 1);
    w += hardCrossLine(c, pe.xy, pe.zw);
  }
#endif
  hE += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec2 p3 = cFetchL(sL + 2).xy;
    w += hardCrossQuad(c, p12.xy, p12.zw, p3);
  }
#endif
  hE += nQuad;
#ifndef MANTLE_NO_CUBIC
  int nCubic = int(cnts.z);
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1) - vec4(c, c);
    vec4 p34 = cFetchL(sL + 2) - vec4(c, c);

    if (min(min(p12.y, p12.w), min(p34.y, p34.w)) >= 0.0 || max(max(p12.y, p12.w), max(p34.y, p34.w)) < 0.0) continue;
    if (min(min(p12.x, p12.z), min(p34.x, p34.z)) > 0.0) {
      w += ((p34.w >= 0.0) ? 1.0 : 0.0) - ((p12.y >= 0.0) ? 1.0 : 0.0);
      continue;
    }
    w += hardCrossCubic(c, p12, p34);
  }
  hE += nCubic;
#else
  hE += int(cnts.z);
#endif
#ifndef MANTLE_NO_ARC
  int nArc = int(cnts.w);
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y < c.x) break;
    if (rej && rayLaneMiss(segRaw, c.y)) continue;
    int sL = int(segRaw.x);
    w += hardCrossArc(c, cFetchL(sL + 1), cFetchL(sL + 2), cFetchL(sL + 3));
  }
#endif
  float aw = abs(w);
  if (!evenOdd) return step(0.5, aw);
  float m = mod(aw, 2.0);
  return (m >= 0.5 && m < 1.5) ? 1.0 : 0.0;
}

// (Tree-hard shares renderFillGWNSDF's traversal via MANTLE_GWN_WINDING_ONLY — all
// tiers, trig-free chords, and cubic/arc pieces — so it has no walker of its own.)
#endif

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
// (Under a clamp(1-Xl) form it would be the RIGHT-of-cell segments that
// vanish, and those are scattered through the list — nothing to break on.)
//
// Each *Contrib below returns the RUN-convention value (= -∫clamp(Xl)dYl), so
// the accumulation in renderFillAAC is unchanged.

// em → pixel-local (cell [0,1]^2 centered on c).
//
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
// paths into one function — no per-type parameter is needed.
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
// is exactly zero — comes out with a ~1e-5 residual instead. The degenerate-branch
// test then misses, the y-extremum is never found, the piece handed to the exact
// integral is not y-monotone, and the winding miscounts. (Slug survives the same
// expression only because its degeneracy threshold is 1/65536 ≈ 1.5e-5, which
// happens to swallow the residual. This one must be tighter, so spell it safely.)
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
// small root comes from a division rather than a canceling subtraction. This
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

#define AAC_ROOT_TOL (1.0 / 1048576.0)
#define AAC_ROOT_NEWTON 8
#define AAC_ROOT_STEPS 40

// The root of qa t^2 + qb t + qc = 0 in the monotone bracket [lo, hi]: the stable pair, and a degenerate quadratic's linear
// root. (The 1e-4 slack is in t, which has no units.)
float aacQuadRoot(float qa, float qb, float qc, float lo, float hi) {
  if (abs(qa) < AAC_EPS) return clamp(abs(qb) > AAC_EPS ? -qc / qb : lo, lo, hi);   // degenerate: linear in t
  float sq = sqrt(max(qb * qb - 4.0 * qa * qc, 0.0));
  float q  = -0.5 * (qb + (qb < 0.0 ? -sq : sq));
  float r1 = q / qa, r2 = abs(q) > AAC_EPS ? qc / q : r1;
  return clamp((r1 >= lo - 1e-4 && r1 <= hi + 1e-4) ? r1 : r2, lo, hi);                  // the in-bracket root
}

// Solve C(t) = V on a MONOTONE bracket [ta,tb], coefficient form.
//
//  a3 == 0 → the polynomial IS a quadratic: closed form, using the stable root
//            pair (q/qa, qc/q) rather than the naive (-b±√disc)/2a, which loses
//            precision to cancellation when qb² >> 4·qa·qc. Tested for exact zero,
//            not "small": a nearly-cubic a3 must still go to the bracketed solve or its
//            root would be wrong.
//  else    → THE CERTIFIED BRACKETED SOLVE above.
float aacSolveC(vec4 C, float ta, float tb, float V) {
  float lo = min(ta, tb), hi = max(ta, tb);
  if (abs(C.x) < 1e-12) return aacQuadRoot(C.y, C.z, C.w - V, lo, hi);   // exactly quadratic (or lower)
#ifdef MANTLE_NO_CUBIC
  return 0.5 * (lo + hi);   // unreachable: no cubic segments in this bundle
#else
  float a = lo, b = hi;
  float fa = evalC(C, a) - V, fb = evalC(C, b) - V;
  float tol = max(AAC_ROOT_TOL, (1.0 / 16777216.0) * (abs(C.x) + abs(C.y) + abs(C.z) + abs(C.w) + abs(V)));
  if (abs(fa) <= tol) return a;
  if (abs(fb) <= tol) return b;
  if ((fa < 0.0) == (fb < 0.0)) return (abs(fa) <= abs(fb)) ? a : b;   // no sign change (rounding): the nearer end
  float t = (a * fb - b * fa) / (fb - fa);      // the secant seed; f changes sign, so the divide is safe
  if (!(t > a && t < b)) t = 0.5 * (a + b);
  for (int k = 0; k < AAC_ROOT_STEPS; k++) {
    float ft = evalC(C, t) - V;
    if (abs(ft) <= tol) return t;               // certified: |C(t) - V| within tol
    if ((ft < 0.0) == (fa < 0.0)) a = t; else b = t;   // monotone: f's sign says which side of the root t is on
    float m = 0.5 * (a + b);
    if (!(m > a && m < b)) break;               // two adjacent floats: the root to float resolution
    float tn = t - ft / evalCD(C, t);
    t = (k < AAC_ROOT_NEWTON && tn > a && tn < b) ? tn : m;
  }
  return 0.5 * (a + b);
#endif
}

// THE ZONE INTEGRAL, TAKEN ON THE ZONE. ∫_a^b x(t)·y'(t) dt with x of degree 3 and y' of degree 2: the
// integrand is degree 5, and 3-point Gauss-Legendre on [a, b] is exact for it.
//
// F(b) - F(a) of the degree-6 antiderivative in powers of t is exact in real arithmetic, not in float32. In the
// cell's frame x and y' are O(P) where the segment spans P pixels, so F's terms are O(P^2) at every t, while a zone --
// the curve inside one pixel -- integrates to O(1), and the subtraction would leave P^2 * 2^-24 of it.
// Here every sample is x at a point INSIDE the zone, where it is O(1), times y' there, and the weights sum to
// b - a. What is left is x's own rounding: the ulp of the span that the pixel-local transform already puts on every
// control point, P * 2^-24 px.
//
// The same work: three evals and three derivatives against the antiderivative's six per-piece coefficients and two
// Horners (47 SPIR-V ops against 48), with no coefficients live across the wall solves. The divided-difference form
// of F(b) - F(a) also holds the floor, but at 15-21 ulps of the span on cubics: its terms are still products of two
// O(P) coefficients.
float aacZoneInt(vec4 CX, vec4 CY, float a, float b) {
  float h = b - a, m = 0.5 * (a + b), d = 0.3872983346207417 * h;   // nodes m ± sqrt(3/5)·h/2
  float t0 = m - d, t2 = m + d;
  float e2 = 3.0 * CY.x, e1 = 2.0 * CY.y;                           // y'(t) = (e2·t + e1)·t + CY.z
  float i0 = evalC(CX, t0) * ((e2 * t0 + e1) * t0 + CY.z);
  float i1 = evalC(CX, m) * ((e2 * m + e1) * m + CY.z);
  float i2 = evalC(CX, t2) * ((e2 * t2 + e1) * t2 + CY.z);
  return h * ((5.0 / 18.0) * (i0 + i2) + (8.0 / 18.0) * i1);        // weights 5, 8, 5 / 18 of b - a
}

// ∫_0^1 clamp((1-s)·w0 + s·w1, 0, 1) ds — BRANCHLESS, one divide.
//
// The clamped-below ramp has a closed form with no case split:
//     ∫_0^1 max(lerp(f0,f1,s), 0) ds  =  (max(f0,0)² − max(f1,0)²) / (2·(f0−f1))
// (both-positive → the mean; both-negative → 0; straddling → the positive
// triangle — all three fall out of the same expression). And since
// clamp(u,0,1) = max(u,0) − max(u−1,0), the two ramps differ only by a shift, so
// they SHARE the denominator: the whole clamped integral is one divide and no
// branches, rather than a pair of three-way-branchy ramp helpers — worth avoiding
// in the polygon path, where warp divergence costs more than the arithmetic.
// Verified to 1.6e-11 against fine quadrature over 20k random ramps.
//
// The w0 == w1 limit is the constant integrand, clamp(w0,0,1).
float aacClampI(float w0, float w1) {
  float d = w0 - w1;

  if (abs(d) <= 1e-5 * (1.0 + abs(w0) + abs(w1))) return clamp(0.5 * (w0 + w1), 0.0, 1.0);
  float a0 = max(w0, 0.0),       a1 = max(w1, 0.0);
  float b0 = max(w0 - 1.0, 0.0), b1 = max(w1 - 1.0, 0.0);

  return ((a0 - a1) * (a0 + a1) - (b0 - b1) * (b0 + b1)) / (2.0 * d);
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
// linear ramp. This is the hot polygon path: one divide (not two for the band-find
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

// One doubly monotone piece [ta, tb] of X = (A.x t + B.x) t + P0.x, Y likewise, its end points pa, pb known:
// -∫ clamp(X, 0, 1) dclamp(Y) over it.
float aacQuadPiece(vec2 A, vec2 B, vec2 P0, float ta, float tb, vec2 pa, vec2 pb, float q0, float q1) {
  if (!(tb > ta) || max(pa.y, pb.y) <= q0 || min(pa.y, pb.y) >= q1 || max(pa.x, pb.x) <= 0.0) return 0.0;
  float ya = clamp(pa.y, q0, q1), yb = clamp(pb.y, q0, q1);                  // Y at the clipped ends
  if (min(pa.x, pb.x) >= 1.0) return ya - yb;                                 // right of the cell: -dY
  float u0 = (pa.y == ya) ? ta : aacQuadRoot(A.y, B.y, P0.y - ya, ta, tb);   // the clipped ends' parameters
  float u1 = (pb.y == yb) ? tb : aacQuadRoot(A.y, B.y, P0.y - yb, ta, tb);
  float x0 = (u0 == ta) ? pa.x : (A.x * u0 + B.x) * u0 + P0.x;
  float x1 = (u1 == tb) ? pb.x : (A.x * u1 + B.x) * u1 + P0.x;
  if (max(x0, x1) <= 0.0) return 0.0;
  if (min(x0, x1) >= 1.0) return ya - yb;
  // where the piece enters 0 < X < 1 and leaves it, and Y there
  bool inOut = x0 < 0.0 || x0 > 1.0, outOut = x1 < 0.0 || x1 > 1.0;
  float t0 = inOut ? aacQuadRoot(A.x, B.x, P0.x - (x0 < 0.0 ? 0.0 : 1.0), u0, u1) : u0;
  float t1 = outOut ? aacQuadRoot(A.x, B.x, P0.x - (x1 < 0.0 ? 0.0 : 1.0), u0, u1) : u1;
  float y0 = inOut ? (A.y * t0 + B.y) * t0 + P0.y : ya;
  float y1 = outOut ? (A.y * t1 + B.y) * t1 + P0.y : yb;
  float far = ((x0 > 1.0) ? y0 - ya : 0.0) + ((x1 > 1.0) ? yb - y1 : 0.0);   // the part beyond X = 1: its dY
  // the zone inside the cell: 2-point Gauss-Legendre, nodes m -+ h / (2 sqrt 3)
  float h = t1 - t0, m = 0.5 * (t0 + t1), d = 0.28867513459481287 * h, g0 = m - d, g1 = m + d;
  float zone = 0.5 * h * (((A.x * g0 + B.x) * g0 + P0.x) * (2.0 * A.y * g0 + B.y)
                        + ((A.x * g1 + B.x) * g1 + P0.x) * (2.0 * A.y * g1 + B.y));
  return -(zone + far);
}
float aacQuadContrib(vec2 P0, vec2 P1, vec2 P2, float q0, float q1) {
  if (max(P0.y, max(P1.y, P2.y)) <= q0 ||
      min(P0.y, min(P1.y, P2.y)) >= q1) return 0.0;                              // hull: no y-overlap
  if (min(P0.x, min(P1.x, P2.x)) >= 1.0) return aacRightD(P0.y, P2.y, q0, q1);   // hull: right of cell
  vec2 d0 = P0 - P1, d1 = P2 - P1;
  vec2 A = d0 + d1, B = -2.0 * d0;                 // aacQuadCoeff's grouping: A is exactly 0 on a symmetric quad
  // an interior extremum where P1 lies beyond both ends on that axis, at t = d0 / (d0 + d1); an absent one reads 1
  float ty = (d0.y * d1.y > 0.0) ? d0.y / A.y : 1.0, tx = (d0.x * d1.x > 0.0) ? d0.x / A.x : 1.0;
  float s0 = min(tx, ty), s1 = max(tx, ty);
  // ROLLED: one piece body, three trips; an absent split's piece [1, 1] returns 0
  float run = 0.0, ta = 0.0;
  vec2 pa = P0;
  for (int k = 0; k < 3; k++) {
    float tb = (k == 0) ? s0 : ((k == 1) ? s1 : 1.0);
    vec2 pb = (tb < 1.0) ? (A * tb + B) * tb + P0 : P2;
    run += aacQuadPiece(A, B, P0, ta, tb, pa, pb, q0, q1);
    ta = tb; pa = pb;
  }
  return run;
}
// A cubic, as the quad (A CURVE IN ONE PASS, above): its extrema sorted (at most four), the zone by 3-point Gauss (exact
// for its degree-5 X Y', aacZoneInt), the solves aacSolveC's certified bracket: each piece is monotone, so its
// bracket holds one root.
vec4 aacSort4(vec4 v) {
  vec2 a = vec2(min(v.x, v.y), max(v.x, v.y)), b = vec2(min(v.z, v.w), max(v.z, v.w));
  float lo = min(a.x, b.x), hi = max(a.y, b.y), m0 = max(a.x, b.x), m1 = min(a.y, b.y);
  return vec4(lo, min(m0, m1), max(m0, m1), hi);
}
float aacSplitT(float t) { return (t > 1e-6 && t < 1.0 - 1e-6) ? t : 1.0; }   // an extremum strictly inside, else absent
// One doubly monotone piece [ta, tb] of X = evalC(CX, t), Y = evalC(CY, t), its end points pa, pb known
float aacCubicPiece(vec4 CX, vec4 CY, float ta, float tb, vec2 pa, vec2 pb, float q0, float q1) {
  if (!(tb > ta) || max(pa.y, pb.y) <= q0 || min(pa.y, pb.y) >= q1 || max(pa.x, pb.x) <= 0.0) return 0.0;
  float ya = clamp(pa.y, q0, q1), yb = clamp(pb.y, q0, q1);                  // Y at the clipped ends
  if (min(pa.x, pb.x) >= 1.0) return ya - yb;                                 // right of the cell: -dY
  float u0 = (pa.y == ya) ? ta : aacSolveC(CY, ta, tb, ya);                  // the clipped ends' parameters
  float u1 = (pb.y == yb) ? tb : aacSolveC(CY, ta, tb, yb);
  float x0 = (u0 == ta) ? pa.x : evalC(CX, u0), x1 = (u1 == tb) ? pb.x : evalC(CX, u1);
  if (max(x0, x1) <= 0.0) return 0.0;
  if (min(x0, x1) >= 1.0) return ya - yb;
  bool inOut = x0 < 0.0 || x0 > 1.0, outOut = x1 < 0.0 || x1 > 1.0;          // where it enters 0 < X < 1 and leaves
  float t0 = inOut ? aacSolveC(CX, u0, u1, x0 < 0.0 ? 0.0 : 1.0) : u0;
  float t1 = outOut ? aacSolveC(CX, u0, u1, x1 < 0.0 ? 0.0 : 1.0) : u1;
  float y0 = inOut ? evalC(CY, t0) : ya, y1 = outOut ? evalC(CY, t1) : yb;
  float far = ((x0 > 1.0) ? y0 - ya : 0.0) + ((x1 > 1.0) ? yb - y1 : 0.0);   // the part beyond X = 1: its dY
  return -(aacZoneInt(CX, CY, t0, t1) + far);
}
float aacCubicContrib(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float q0, float q1) {
  if (max(max(P0.y, P1.y), max(P2.y, P3.y)) <= q0 ||
      min(min(P0.y, P1.y), min(P2.y, P3.y)) >= q1) return 0.0;                            // hull: no y-overlap
  if (min(min(P0.x, P1.x), min(P2.x, P3.x)) >= 1.0) return aacRightD(P0.y, P3.y, q0, q1); // hull: right of cell
  vec4 CX = aacCubicCoeff(P0.x, P1.x, P2.x, P3.x), CY = aacCubicCoeff(P0.y, P1.y, P2.y, P3.y);
#ifdef MANTLE_NO_CUBIC_SPLITS
  return aacCubicPiece(CX, CY, 0.0, 1.0, P0, P3, q0, q1);
#else
  vec2 ex = aacQuadRoots(3.0 * CX.x, 2.0 * CX.y, CX.z), ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);
  vec4 s = aacSort4(vec4(aacSplitT(ex.x), aacSplitT(ex.y), aacSplitT(ey.x), aacSplitT(ey.y)));   // absent ones read 1
  // ROLLED: one piece body, five trips; a piece [1, 1] (an absent split) returns 0
  float run = 0.0, ta = 0.0;
  vec2 pa = P0;
  for (int k = 0; k < 5; k++) {
    float tb = (k < 4) ? s[k] : 1.0;
    vec2 pb = (tb < 1.0) ? vec2(evalC(CX, tb), evalC(CY, tb)) : P3;   // a segment end is its control point
    run += aacCubicPiece(CX, CY, ta, tb, pa, pb, q0, q1);
    ta = tb; pa = pb;
  }
  return run;
#endif
}

// TYPE OMISSION (both engines). Each walker's sub-loops are type-grouped and a bundle knows
// which segment types it actually contains, so unused kernels can be compiled OUT.
// This matters because AAC's cost on small shapes is REGISTER PRESSURE, not work:
// its occupancy is set by the kernel's live-register high-water mark, which every
// fragment pays whether or not it executes that path. The arc kernel (a square
// root per clip, an atan and a sine per zone) and the cubic kernel (certified
// bracketed solves + 3-point Gauss) are the two expensive ones. A font bundle is quads only.
#ifndef MANTLE_NO_ARC
// ARC (native ellipse), exact closed form. d1=(cx,cy,rx,ry), d2=(th0,th1,phi,_).
//
// In pixel-local coords the arc is a pair of phase-shifted sinusoids in θ:
//   Xl(θ) = X.x + X.y·cosθ + X.z·sinθ
//   Yl(θ) = Y.x + Y.y·cosθ + Y.z·sinθ,   Yl'(θ) = −Y.y·sinθ + Y.z·cosθ
// (from x_em = cx + cp·rx·cosθ − sp·ry·sinθ, y_em = cy + sp·rx·cosθ + cp·ry·sinθ,
//  then the affine em→pixel-local map, which preserves the form).
//
// So the integrand Xl·Yl' is a trig polynomial of degree ≤ 2 and has an
// elementary antiderivative — the arc needs no quadrature, and its chord is exact
// with the ellipse's segment beyond it added (AN ARC IN ONE PASS, below). Every
// other AAC type reaches exactness via a polynomial argument; the arc reaches it
// via a trigonometric one. A band chord would cost up to 38/255 on small-radius
// arcs (rounded-rect corners) and 32/255 at medium radius; this is 0.000/255.
// The rotated footprint's wall (aacWallArc) still works in θ, with these helpers:
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
// Unlike a fixed -3..3 loop over k, it handles an arc whose θ range sits outside ±3π:
// skipping its extrema would leave a piece that is not monotone — exactly the
// precondition the clip and the x-split rely on.
vec2 aacPhaseExtrema(float phi, float lo, float hi) {
  float PI_ = TWO_PI * 0.5;
  float t0 = phi + (floor((lo - phi) / PI_) + 1.0) * PI_;
  float t1 = t0 + PI_;
  float e0 = (t0 > lo + 1e-7 && t0 < hi - 1e-7) ? t0 : 1e9;
  float e1 = (t1 > lo + 1e-7 && t1 < hi - 1e-7) ? t1 : 1e9;
  return vec2(min(e0, e1), max(e0, e1));
}

// ∫_a^b Xl·Yl' dθ, WITH THE DIFFERENCE TAKEN ANALYTICALLY. The antiderivative is
//   F(θ) = X.x·(Y.y cos θ + Y.z sin θ) + K1/2·sin²θ + K2/2·θ + K3/2·sin θ cos θ,
//   K1 = X.z Y.z - X.y Y.y,  K2 = X.y Y.z - X.z Y.y,  K3 = X.y Y.z + X.z Y.y,
// and evaluating it at both ends and subtracting is not enough. In the cell's frame X.x and the radii are O(P) for an arc
// spanning P pixels, so F is O(P^2) -- and O(P^2 · θ) through the K2 term, the angle itself -- while a zone inside one pixel
// integrates to O(1): the subtraction would be off by 0.01 of a pixel at a 1024 px span, 0.125 at 4096, 0.87 at 16384.
// Each difference is a product, with m = (a + b)/2 and h = (b - a)/2:
//   cos b - cos a = -2 sin m sin h        sin b - sin a = 2 cos m sin h
//   sin²b - sin²a = sin 2m sin 2h         sin b cos b - sin a cos a = cos 2m sin 2h / 2       b - a = 2h
// so every term carries the zone's own sin h (or h), no O(P^2) value is ever subtracted from another, and the angle's
// magnitude drops out. What is left is the transform's ulp of the span (probes/fillperf/aacZoom.mjs: 0.8-2.0 ulps from
// 16 to 16384 px). The same four sin/cos, of m and h.
// sin h IS A SERIES BELOW 1/4: a GPU's sin has an ABSOLUTE error (about 2^-21 after range reduction), which is all of
// sin h's relative accuracy at the h of a zone deep in a zoom (h ~ 1/P). h - h³/6 + h⁵/120 is within 5e-8 relative
// there. A select, not a branch.
float aacTrigDF(vec3 X, vec3 Y, float a, float b) {
  float h = 0.5 * (b - a), m = 0.5 * (a + b), h2 = h * h;
  float sh = (abs(h) < 0.25) ? h * (1.0 - h2 * (1.0 / 6.0) * (1.0 - h2 * 0.05)) : sin(h);
  float ch = cos(h), sm = sin(m), cm = cos(m);
  float K1 = X.z * Y.z - X.y * Y.y, K2 = X.y * Y.z - X.z * Y.y, K3 = X.y * Y.z + X.z * Y.y;
  return 2.0 * sh * X.x * (Y.z * cm - Y.y * sm)                            // X.x · ΔYl
       + K2 * h                                                             // K2/2 · Δθ
       + sh * ch * (2.0 * K1 * sm * cm + K3 * (cm * cm - sm * sm));         // K1/2 · Δsin² + K3/2 · Δ(sin cos)
}

// Solve C + R·cos(θ−φ) = V on a MONOTONE θ-range. Closed form, no iteration:
// θ = φ ± acos((V−C)/R) + 2πk. Pick the branch landing in the range. R and φ come
// from the caller (per-segment constants) — this is the same closed-form
// ray-vs-arc solve Slug's arc walker does with its own atan+acos.
float aacTrigSolve(float C, float R, float phi, float V, float a, float b) {
  float r = clamp((V - C) / max(R, 1e-9), -1.0, 1.0);
  float ac = acos(r);
  float lo = min(a, b), hi = max(a, b);
  float th0 = phi + ac, th1 = phi - ac;
  th0 += ceil((lo - th0) / TWO_PI) * TWO_PI;      // shift into [lo, lo+2π)
  th1 += ceil((lo - th1) / TWO_PI) * TWO_PI;
  if (th0 <= hi + 1e-4) return clamp(th0, lo, hi);
  if (th1 <= hi + 1e-4) return clamp(th1, lo, hi);
  // Neither candidate in the bracket. The root exists -- the caller solves only an end that sticks out of the
  // window, on a monotone piece -- but where the piece ends near a y-extremum the root is within a hair of that end,
  // and acos near +-1 is quantized: float32 has no value between -1 and -1 + 6e-8, so the root moves by up to
  // sqrt(2 * 6e-8) = 3.5e-4 rad, past the bracket's 1e-4 slack, onto the extremum just beyond the arc's end (a circle
  // drawn from a point a hair left of its top). This returned the bracket's MIDPOINT -- a clip half a turn away, whose
  // in-cell integral painted 0.62 of a pixel that is 0.0095 covered. The root is at the END nearest either candidate.
  float d0 = min(th0 - hi, lo + TWO_PI - th0), d1 = min(th1 - hi, lo + TWO_PI - th1);
  float th = (d0 <= d1) ? th0 : th1;
  return (th - hi <= lo + TWO_PI - th) ? hi : lo;
}

// One zone on which clamp(Xl) has a single analytic form. Classify by midpoint:
//   Xl ≤ 0 → 0     Xl ≥ 1 → ∫Yl'dθ = ΔYl (endpoints)     else → ∫Xl·Yl' dθ (aacTrigDF)
float aacArcZoneI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                   float q0, float q1) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xm = aacTrigEvalR(X.x, RX, pX, 0.5 * (a + b));
  if (xm <= 0.0) return 0.0;
  // Δclamp(Yl), for the reason spelled out over aacZoneI2: the far field must not depend
  // on the y-clip solve -- and it takes the ends' KNOWN Yl: a clip end
  // is at the window edge whatever θ the closed-form acos returned for it.
  if (xm >= 1.0) return clamp(yb, q0, q1) - clamp(ya, q0, q1);
  return aacTrigDF(X, Y, a, b);
}

// [a,b] is x-MONOTONE (traversal order; b may be < a). Split at the Xl=0 and
// Xl=1 crossings — at most one each, by monotonicity — then each zone is closed
// form. Fast paths first: a run that never leaves [0,1] in x needs no solve.
float aacArcXMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                    float q0, float q1) {
  if (abs(b - a) < 1e-12) return 0.0;
  float xa = aacTrigEvalR(X.x, RX, pX, a), xb = aacTrigEvalR(X.x, RX, pX, b);
  float xlo = min(xa, xb), xhi = max(xa, xb);
  if (xhi <= 0.0) return 0.0;                                                            // fully left
  if (xlo >= 1.0) return clamp(yb, q0, q1) - clamp(ya, q0, q1);                          // fully right, known ends
  if (xlo >= 0.0 && xhi <= 1.0) return aacTrigDF(X, Y, a, b);
  bool h0 = (xlo < 0.0 && xhi > 0.0);
  bool h1 = (xlo < 1.0 && xhi > 1.0);
  float t0 = h0 ? aacTrigSolve(X.x, RX, pX, 0.0, a, b) : a;
  float t1 = h1 ? aacTrigSolve(X.x, RX, pX, 1.0, a, b) : a;
  bool fwd = b > a;
  // an interior wall crossing's Yl, evaluated once and handed to both zones that meet there
  float acc = 0.0, prev = a, yPrev = ya;
  if (h0 && h1) {                       // both walls crossed: order along traversal
    float m0 = fwd ? min(t0, t1) : max(t0, t1);
    float m1 = fwd ? max(t0, t1) : min(t0, t1);
    float y0 = aacTrigEvalR(Y.x, RY, pY, m0), y1 = aacTrigEvalR(Y.x, RY, pY, m1);
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m0, yPrev, y0, q0, q1); prev = m0; yPrev = y0;
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m1, yPrev, y1, q0, q1); prev = m1; yPrev = y1;
  } else if (h0 || h1) {
    float m = h0 ? t0 : t1, ym = aacTrigEvalR(Y.x, RY, pY, m);
    acc += aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, m, yPrev, ym, q0, q1); prev = m; yPrev = ym;
  }
  return acc + aacArcZoneI2(X, Y, RX, pX, RY, pY, prev, b, yPrev, yb, q0, q1);
}

// Split a y-monotone θ-range at the x-extrema (dXl/dθ=0 ⇒ θ = atan2(X.z,X.y)+kπ)
// so every sub-run is x-monotone, then integrate each exactly.
float aacArcMonoI2(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                   float q0, float q1) {
  vec2 ex = aacPhaseExtrema(pX, min(a, b), max(a, b));   // x-extrema at θ = φx + kπ
  float g0 = ex.x, g1 = ex.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = b > a;
  // ROLLED, as aacExactI2: the extrema in traversal order, an absent one reading b, whose piece [b, b]
  // returns exactly 0 -- aacArcXMonoI2 and its two wall solves inlined once.
  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : b);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : b;
  float ym0 = (n >= 1) ? aacTrigEvalR(Y.x, RY, pY, m0) : yb, ym1 = (n == 2) ? aacTrigEvalR(Y.x, RY, pY, m1) : yb;
  float acc = 0.0, prev = a, yPrev = ya;
  for (int k = 0; k < 3; k++) {
    float nx = (k == 0) ? m0 : ((k == 1) ? m1 : b);
    float yNx = (k == 0) ? ym0 : ((k == 1) ? ym1 : yb);
    acc += aacArcXMonoI2(X, Y, RX, pX, RY, pY, prev, nx, yPrev, yNx, q0, q1);
    prev = nx; yPrev = yNx;
  }
  return acc;
}

// One y-monotone θ-piece, clipped to the cell∩stripe window [q0,q1] in Yl.
// Yl' carries the winding sign through the integral, so there is no separate
// `inc` factor to keep consistent across the extrema split.
float aacArcMonoContrib(vec3 X, vec3 Y, float RX, float pX, float RY, float pY, float a, float b, float ya, float yb,
                        float q0, float q1) {
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;                                   // along the traversal a→b
  // One solve site per window edge: where the piece crosses q0 (or its low end) and q1 (or its high end);
  // aacTrigSolve orders its bracket, so each arm's solve is the same number.
  bool loIn = (inc ? ya : yb) >= q0, hiIn = (inc ? yb : ya) <= q1;
  float tq0 = loIn ? (inc ? a : b) : aacTrigSolve(Y.x, RY, pY, q0, a, b);
  float tq1 = hiIn ? (inc ? b : a) : aacTrigSolve(Y.x, RY, pY, q1, a, b);
  // Yl at each clip end, KNOWN: the window edge where it was solved for, the end's own otherwise
  float yq0 = loIn ? (inc ? ya : yb) : q0, yq1 = hiIn ? (inc ? yb : ya) : q1;
  float uA = inc ? tq0 : tq1, uB = inc ? tq1 : tq0;
  // both CLIPS ON ONE ANGLE. They are 1/R radians apart for a radius of R device px, and an angle in [4, 2 pi) has an ulp of 2^-21, so from R = 2^21 they
  // can be the same float. The piece still crosses this window: its y ends are known, and its x is the angle's, so it is that x over that y.
  if (abs(uB - uA) < 1e-12) return -clamp(aacTrigEvalR(X.x, RX, pX, uA), 0.0, 1.0) * (inc ? yq1 - yq0 : yq0 - yq1);
  return -aacArcMonoI2(X, Y, RX, pX, RY, pY, uA, uB, inc ? yq0 : yq1, inc ? yq1 : yq0, q0, q1);   // -∫clamp(Xl)dclamp(Yl)
}

float aacArcContribXY(vec3 X, vec3 Y, float th0, float th1, vec2 yE, float q0, float q1);
float aacArcContrib(vec4 d1, vec4 d2, vec4 ends, vec2 c, vec2 px, float q0, float q1) {
  float dth = d2.y - d2.x;
  if (abs(dth) < 1e-9) return 0.0;
  float sp = sin(d2.z), cp = cos(d2.z);          // phi-trig once per segment
  vec3 X = vec3((d1.x - c.x) * px.x + 0.5,  px.x * cp * d1.z, -px.x * sp * d1.w);
  vec3 Y = vec3((d1.y - c.y) * px.y + 0.5,  px.y * sp * d1.z,  px.y * cp * d1.w);
  // the ends' Yl from the STORED vertices, mapped as a line's end is (aacPL)
  vec2 yE = (vec2(ends.y, ends.w) - c.y) * px.y + 0.5;
  return aacArcContribXY(X, Y, d2.x, d2.y, yE, q0, q1);
}
// The arc's contribution once it is in the cell's frame: X(θ) = X.x + X.y cos θ + X.z sin θ, and Y likewise (the rotated
// footprint builds X and Y through a whole em -> pixel map).
// yE is Yl at th0 and th1 -- the arc's STORED endpoints, the path's vertices as its neighbors store them. Every
// end value below is theirs, so the clamped ΔY telescopes against the neighbors' exactly; only the interior is
// evaluated from the center form.
float aacArcContribXY(vec3 X, vec3 Y, float th0, float th1, vec2 yE, float q0, float q1) {
  float dth = th1 - th0;

  // Y-cull, in two stages.
  //
  // STAGE 1 (cheap, whole-ellipse): Yl is a sinusoid of amplitude √(Y.y²+Y.z²)
  // ≤ |Y.y|+|Y.z| — the sqrt-free triangle bound, exact for the common
  // axis-aligned case (phi=0 ⇒ one term is zero). Two abs and an add.
  float Ry = abs(Y.y) + abs(Y.z);
  if (Y.x + Ry <= q0 || Y.x - Ry >= q1) return 0.0;

  // X-cull, same triangle bound. Spelled with a sqrt and a coordinate transform
  // it would not pay (a few percent slower on a two-arc ellipse, where an arc
  // spans the whole shape so "fully right" almost never fires).
  // With X already in (C, A, B) form it is three ops, and on SMALL arcs — scallop
  // rings, rounded-rect corners — it fires constantly and skips the entire
  // integration: the extrema split, the acos clips, every zone.
  //   fully LEFT  → clamp(Xl) ≡ 0 → contributes nothing
  //   fully RIGHT → clamp(Xl) ≡ 1 → Δclamp(Yl), endpoints only
  float Rx = abs(X.y) + abs(X.z);
  if (X.x + Rx <= 0.0) return 0.0;
  if (X.x - Rx >= 1.0)
    return aacRightD(yE.x, yE.y, q0, q1);

  // Per-segment polar constants, computed ONCE and threaded through the whole
  // arc chain: every eval below becomes one cos, every solve loses an atan+sqrt.
  float RX = sqrt(X.y * X.y + X.z * X.z), pX = curveAtan2(X.z, X.y);
  float RY = sqrt(Y.y * Y.y + Y.z * Y.z), pY = curveAtan2(Y.z, Y.y);

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
  // cos per interior extremum — and the extrema are needed anyway.
  //
  // This is why nothing is stashed in the free d2.w slot: a single float can only
  // carry a half-extent symmetric about cy, and a corner arc spanning [cy, cy+ry]
  // has the same symmetric bound as the full ellipse. The asymmetry is the whole
  // point, and deriving it here is free.
  //
  // Rejecting here skips every mono contrib — the trig solves, which are the cost.
  // (and each is Yl at a piece end below, evaluated once)
  float yTh0 = yE.x, yTh1 = yE.y;                 // the stored ends
  float yG0 = (n >= 1) ? aacTrigEvalR(Y.x, RY, pY, g0) : yTh1, yG1 = (n >= 2) ? aacTrigEvalR(Y.x, RY, pY, g1) : yTh1;
  {
    float ymin = min(yTh0, yTh1), ymax = max(yTh0, yTh1);
    if (n >= 1) { ymin = min(ymin, yG0); ymax = max(ymax, yG0); }
    if (n >= 2) { ymin = min(ymin, yG1); ymax = max(ymax, yG1); }
    if (ymax <= q0 || ymin >= q1) return 0.0;
  }


  bool fwd = dth > 0.0;
  // ROLLED: the y-extrema in traversal order, an absent one reading th1, whose piece [th1, th1] returns
  // exactly 0 (its clip collapses) -- aacArcMonoContrib and the chain behind it inlined once rather than four
  // times, so only four aacTrigSolve sites remain.
  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : th1);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : th1;
  float ym0 = (n == 2) ? (fwd ? yG0 : yG1) : ((n == 1) ? yG0 : yTh1);
  float ym1 = (n == 2) ? (fwd ? yG1 : yG0) : yTh1;
  float run = 0.0, prev = th0, yPrev = yTh0;
  for (int k = 0; k < 3; k++) {
    float nx = (k == 0) ? m0 : ((k == 1) ? m1 : th1);
    float yNx = (k == 0) ? ym0 : ((k == 1) ? ym1 : yTh1);
    run += aacArcMonoContrib(X, Y, RX, pX, RY, pY, prev, nx, yPrev, yNx, q0, q1);
    prev = nx; yPrev = yNx;
  }
  return run;
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

// the entry's y range, mapped to the cell's pixel-local y exactly as aacPL maps a control point
// (subtract, then scale and offset: monotone steps, so the mapped ends ARE the hull's pixel-local extremes; a
// negative px.y swaps them, hence the min/max), lies wholly outside the window [q0, q1]. Every contribution is
// then exactly zero: a line's clipped y-range is empty, the quad and cubic hull culls fire, and an arc's own two
// culls fire, its lane holding its padded extent. The slack keeps this strictly inside those culls if the
// compiler fuses (p - c) * px + 0.5 into one rounding at one site and not at the other -- 2^-20 of the cell,
// sixteen float32 roundings of a value in it, in the cell's own units, so the same at every scale.
const float AAC_LANE_SLACK = 9.5367431640625e-7;   // 2^-20
bool aacLaneMiss(vec4 e, float cy, float py, float q0, float q1) {
  float a = (e.z - cy) * py + 0.5, b = (e.w - cy) * py + 0.5;
  return max(a, b) < q0 - AAC_LANE_SLACK || min(a, b) > q1 + AAC_LANE_SLACK;
}

// Walk ONE band's segment list, accumulating -∫clamp(Xl)dYl over the y-window
// [q0,q1] of the pixel cell. Hoisted out of renderFillAAC so the single-band
// fast path can pass literal (0.0, 1.0) and let the compiler fold every
// clamp/compare back to constants.
float aacWalkBand(ivec2 gl, int bandY, vec2 c, vec2 px, float xBreak, float q0, float q1) {
  int hdr = texLin(gl) + bandY * 2;          // the band header, as a linear index
  vec4 cnts = bFetchL(hdr);
  int nLine = int(cnts.x), nQuad = int(cnts.y), nCubic = int(cnts.z), nArc = int(cnts.w);
  vec4 hdr1 = bFetchL(hdr + 1);
  int hE = texLin(gl) + int(hdr1.x);         // the list's first entry, linear; steps past each type's run
  // skip an entry whose y range misses the cell's window from the entry alone (aacLaneMiss).
  bool rej = fillRayReject(hdr1);
  float run = 0.0;
  // BREAK-EARLY (same prune, same sorted order, same test as the Slug walker).
  // Band entries carry .z = the segment's xMax, sorted DESCENDING. Under the
  // reversed clamp(Xl) integrand a segment entirely left of the cell contributes
  // exactly zero, so once xMax falls left of the cell's left edge (Xl < 0) every
  // remaining segment in the band does too — stop. Algebraically identical to
  // Slug's `(entryBrk - c.x) * px.x < -0.5`, with `c.x*px.x - 0.5` hoisted into
  // xBreak by the caller — this test runs once per segment.
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {          // LINES
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 pe = cFetchL(sL + 1);
    run += aacLineContrib(aacPL(pe.xy, c, px), aacPL(pe.zw, c, px), q0, q1);
  }
#endif
  hE += nLine;                            // full count: break skips a suffix
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {          // QUADRATICS
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec2 p3  = cFetchL(sL + 2).xy;
    run += aacQuadContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p3, c, px), q0, q1);
  }
#endif
  hE += nQuad;
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < nCubic; i++) {          // CUBICS
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec4 p34 = cFetchL(sL + 2);
    run += aacCubicContrib(aacPL(p12.xy, c, px), aacPL(p12.zw, c, px), aacPL(p34.xy, c, px), aacPL(p34.zw, c, px), q0, q1);
  }
#endif
  hE += nCubic;
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < nArc; i++) {          // ARCS (native ellipse)
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * px.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, px.y, q0, q1)) continue;
    int sL = int(segRaw.x);
    vec4 d1 = cFetchL(sL + 1);   // (cx,cy,rx,ry)
    vec4 d2 = cFetchL(sL + 2);   // (th0,th1,phi,_)
    run += aacArcContrib(d1, d2, cFetchL(sL + 3), c, px, q0, q1);
  }
#endif
  return run;
}

float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);

  // Multi-band cell walk. The pixel cell spans a full pixel in y, but a band only
  // covers its own y-stripe of the shape bbox. Walk every stripe the cell touches
  // and clip that stripe's contribution to (cell ∩ stripe) via [q0,q1]. The
  // y-integral is additive and the sub-ranges are disjoint, so the parts sum to
  // the exact cell coverage with no double-count — and any segment touching
  // (cell ∩ stripe b) overlaps stripe b in y, hence IS in band b's list. No
  // margin needed, and it is what makes the encoder's curve-TIGHT binning exact.
  //
  //
  float hy = 0.5 / abs(px.y);
  float bandH = bbSize.y / float(bandsY);
  float xBreak = c.x * px.x - 0.5;                   // break-early threshold
  float yA = c.y - hy, yB = c.y + hy;
  int b0 = clamp(int((yA - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int b1 = clamp(int((yB - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  // Pair-band walk. Band b's list covers stripes {b, b+1} (see buildTexturesShape).
  // b0 comes from the cell's TOP edge, so the cell always begins in stripe b0. If
  // it ends no later than b0+1 — true for every fragment unless a stripe is
  // thinner than a pixel — ONE walk over band b0's list with the FULL cell window
  // suffices, and the straddle's second walk disappears.
  //
  // Exact: every segment touching the cell overlaps stripe b0 or b0+1, hence is in
  // the list; listed segments that miss the cell contribute zero (their Δclamp(Yl)
  // vanishes), so the telescoping identity is untouched.
  //
#ifdef MANTLE_AAC_PAIR_BANDS
  bool pairCovers = (b1 <= b0 + 1);
  const int bandStride = 2;               // stripe-PAIRS tile disjointly
#else
  bool pairCovers = (b0 == b1);           // stripe bands: only a non-straddling cell
  const int bandStride = 1;
#endif
  float run = 0.0;

  int bandSteps = (b1 - b0) / bandStride + 1;
  int bandFirst = b0;

  bool levelWalk = false;
  if (!pairCovers && bandSteps > 2) {
    vec4 lv = bFetch(bLoc(gl, 1));
    int lTop = int(lv.z);
    int l = max(int(lv.w), 1), first = int(lv.y) / 2;   // virtual band index of the first level's band 0
    for (int k = l; k < lTop && (b1 >> l) > (b0 >> l) + 1; k++) {
      first += (bandsY + (1 << l) - 1) >> l;  // level l's band count
      l++;
    }
    if (lTop > 0 && (b1 >> l) <= (b0 >> l) + 1) {
      levelWalk = true;
      bandFirst = first + (b0 >> l);
      bandSteps = 1;
    }
  }
  for (int bi = 0; bi < bandSteps; bi++) {
    int bandY = bandFirst + bi * bandStride;
    float q0 = 0.0, q1 = 1.0;               // cell ⊂ {b0,b0+1} (or one level pair) ⇒ the window IS the cell
    if (!pairCovers && !levelWalk) {
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


#ifdef MANTLE_ROTATED_MAP
// ============================================================================================================
// The rotated footprint. renderFillAAC integrates an AXIS-ALIGNED box: its caller's px is the
// fragment's fwidth box, |dFdx| + |dFdy| per em axis, which under a rotated or skewed draw is the upright box
// around the real pixel (1.37x it on a side at 30 degrees): 15/255 mean edge error at 30 degrees, against 0.01 at
// identity. The real pixel is the unit box of the em -> pixel map M (mx, my: its columns, as renderFillM takes them),
// and AAC's own identity integrates it exactly -- run = -Σ ∫ clamp(X, 0, 1) dclamp(Y) in PIXEL coordinates -- but its
// far field (every part right of the box, X >= 1) runs along the pixel's X axis, which is slanted in em, and the band
// lists hold em-horizontal stripes. So the far field is taken another way. Summed over every segment it is
//     -∫_0^1 w(1, Y) dY,
// w the winding number along the box's right edge E; and a winding number can be counted along ANY ray, so along em
// +x, whose crossings ARE in the band list of E's em stripe: ∫_0^1 w dY = (1 / |J11|) Σ Δy of the parts of each
// segment right of E, over E's em-y span (J = M^-1; J11 is E's em-y extent). So, over ONE band list holding the
// footprint's em box:
//   * every segment adds the part of its Δy right of the line E within E's span (aacWall*, in the em box's frame);
//   * a segment whose pixel-frame hull reaches the pixel adds its IN-BOX integral: AAC's own contribution in the pixel
//     frame, less its pixel far field (the same wall count against X = 1), which E's count replaced.
// Exact at any rotation, skew, anisotropy or mirror (M is made orientation-preserving by the caller, so a winding
// number reads the same in both frames). The pixel axis nearest em x carries the far field, which keeps |J11| at least
// half the em box's height. Where em and device axes agree, renderFillAACM is renderFillAAC, bit for bit; a bundle
// with no band levels whose footprint needs more than one list keeps the upright box.

vec2 aacPLM(vec2 emPt, vec2 c, vec2 mx, vec2 my) { vec2 d = emPt - c; return mx * d.x + my * d.y + 0.5; }

// The wall count: the signed ΔY of the parts of a segment inside Y in [q0, q1] and strictly right of the line
// X = alpha + beta Y, in one frame. U = X - beta Y - alpha is affine in the frame, so a control hull bounds it.
float aacWallLine(vec2 A, vec2 B, float alpha, float beta, float q0, float q1) {
  float dy = B.y - A.y;
  if (dy == 0.0) return 0.0;
  float lo = max(q0, min(A.y, B.y)), hi = min(q1, max(A.y, B.y));
  if (hi <= lo) return 0.0;
  float dxdy = (B.x - A.x) / dy;
  float ulo = A.x + dxdy * (lo - A.y) - beta * lo - alpha;         // U at the clipped ends: U is affine in Y here
  float uhi = A.x + dxdy * (hi - A.y) - beta * hi - alpha;
  float len = (ulo > 0.0 && uhi > 0.0) ? hi - lo
            : (ulo <= 0.0 && uhi <= 0.0) ? 0.0
            : ((ulo > 0.0) ? (hi - lo) * ulo / (ulo - uhi) : (hi - lo) * uhi / (uhi - ulo));
  return (dy > 0.0) ? len : -len;
}
// A U-monotone piece [a, b] with Y known at its ends
float aacWallPiece(vec4 CY, vec4 CU, float a, float b, float ya, float yb) {
  if (b - a < 1e-12) return 0.0;
  float ua = evalC(CU, a), ub = evalC(CU, b);
  if (ua > 0.0 && ub > 0.0) return yb - ya;
  if (ua <= 0.0 && ub <= 0.0) return 0.0;
  float ys = evalC(CY, aacSolveC(CU, a, b, 0.0));
  return (ua > 0.0) ? ys - ya : yb - ys;
}
// A Y-monotone piece [ta, tb] (Y known at its ends), clipped to [q0, q1] with the known window values, then cut
// where U turns
float aacWallMono(vec4 CY, vec4 CU, float ta, float tb, float ya, float yb, float q0, float q1) {
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  float yLoEnd = inc ? ya : yb, yHiEnd = inc ? yb : ya;
  bool loIn = yLoEnd >= q0, hiIn = yHiEnd <= q1;
  float tLo = loIn ? (inc ? ta : tb) : aacSolveC(CY, ta, tb, q0);
  float tHi = hiIn ? (inc ? tb : ta) : aacSolveC(CY, ta, tb, q1);
  float yLo = loIn ? yLoEnd : q0, yHi = hiIn ? yHiEnd : q1;
  bool lo0 = tLo <= tHi;
  float u0 = lo0 ? tLo : tHi, u1 = lo0 ? tHi : tLo, y0 = lo0 ? yLo : yHi, y1 = lo0 ? yHi : yLo;
  if (u1 - u0 < 1e-12) return evalC(CU, u0) > 0.0 ? y1 - y0 : 0.0;   // both clips on one parameter (t's ulp is 2^-24): the y ends are known, the side is the parameter's
  vec2 ex = aacQuadRoots(3.0 * CU.x, 2.0 * CU.y, CU.z);            // U'(t) = 0
  float s0 = (ex.x > u0 + 1e-7 && ex.x < u1 - 1e-7) ? ex.x : u1, s1 = (ex.y > u0 + 1e-7 && ex.y < u1 - 1e-7) ? ex.y : u1;
  float m0 = min(s0, s1), m1 = max(s0, s1);
  float ym0 = (m0 < u1) ? evalC(CY, m0) : y1, ym1 = (m1 < u1) ? evalC(CY, m1) : y1;
  return aacWallPiece(CY, CU, u0, m0, y0, ym0) + aacWallPiece(CY, CU, m0, m1, ym0, ym1) + aacWallPiece(CY, CU, m1, u1, ym1, y1);
}
float aacWallCurve(vec4 CX, vec4 CY, float yEnd1, float alpha, float beta, float q0, float q1) {
  vec4 CU = CX - beta * CY - vec4(0.0, 0.0, 0.0, alpha);
  vec2 ey = aacQuadRoots(3.0 * CY.x, 2.0 * CY.y, CY.z);            // Y'(t) = 0
  float s0 = (ey.x > 1e-6 && ey.x < 1.0 - 1e-6) ? ey.x : 2.0;
  float s1 = (ey.y > 1e-6 && ey.y < 1.0 - 1e-6) ? ey.y : 2.0;
  float e0 = (s0 < 1.5) ? s0 : ((s1 < 1.5) ? s1 : 1.0);
  float e1 = (s0 < 1.5 && s1 < 1.5) ? s1 : 1.0;
  float ye0 = (e0 < 1.0) ? evalC(CY, e0) : yEnd1, ye1 = (e1 < 1.0) ? evalC(CY, e1) : yEnd1;
  return aacWallMono(CY, CU, 0.0, e0, CY.w, ye0, q0, q1) + aacWallMono(CY, CU, e0, e1, ye0, ye1, q0, q1)
       + aacWallMono(CY, CU, e1, 1.0, ye1, yEnd1, q0, q1);
}
float aacWallQuad(vec2 P0, vec2 P1, vec2 P2, float alpha, float beta, float q0, float q1) {
  if (max(P0.y, max(P1.y, P2.y)) <= q0 || min(P0.y, min(P1.y, P2.y)) >= q1) return 0.0;
  float u0 = P0.x - beta * P0.y - alpha, u1 = P1.x - beta * P1.y - alpha, u2 = P2.x - beta * P2.y - alpha;
  if (max(u0, max(u1, u2)) <= 0.0) return 0.0;                                     // hull left of the wall
  if (min(u0, min(u1, u2)) > 0.0) return clamp(P2.y, q0, q1) - clamp(P0.y, q0, q1);  // hull right: the clipped ΔY
  return aacWallCurve(aacQuadCoeff(P0.x, P1.x, P2.x), aacQuadCoeff(P0.y, P1.y, P2.y), P2.y, alpha, beta, q0, q1);
}
float aacWallCubic(vec2 P0, vec2 P1, vec2 P2, vec2 P3, float alpha, float beta, float q0, float q1) {
  if (max(max(P0.y, P1.y), max(P2.y, P3.y)) <= q0 || min(min(P0.y, P1.y), min(P2.y, P3.y)) >= q1) return 0.0;
  float u0 = P0.x - beta * P0.y - alpha, u1 = P1.x - beta * P1.y - alpha;
  float u2 = P2.x - beta * P2.y - alpha, u3 = P3.x - beta * P3.y - alpha;
  if (max(max(u0, u1), max(u2, u3)) <= 0.0) return 0.0;
  if (min(min(u0, u1), min(u2, u3)) > 0.0) return clamp(P3.y, q0, q1) - clamp(P0.y, q0, q1);
  return aacWallCurve(aacCubicCoeff(P0.x, P1.x, P2.x, P3.x), aacCubicCoeff(P0.y, P1.y, P2.y, P3.y), P3.y, alpha, beta, q0, q1);
}
#ifndef MANTLE_NO_ARC
// arcs: X, Y and U are C + A cos θ + B sin θ; pieces in traversal order, Y known at their ends
float aacWallArcPiece(float UC, float RU, float pU, float YC, float RY, float pY, float a, float b, float ya, float yb) {
  if (abs(b - a) < 1e-12) return 0.0;
  float ua = aacTrigEvalR(UC, RU, pU, a), ub = aacTrigEvalR(UC, RU, pU, b);
  if (ua > 0.0 && ub > 0.0) return yb - ya;
  if (ua <= 0.0 && ub <= 0.0) return 0.0;
  float ys = aacTrigEvalR(YC, RY, pY, aacTrigSolve(UC, RU, pU, 0.0, a, b));
  return (ua > 0.0) ? ys - ya : yb - ys;
}
float aacWallArcMono(float UC, float RU, float pU, float YC, float RY, float pY, float a, float b, float ya, float yb,
                     float q0, float q1) {
  if (max(ya, yb) <= q0 || min(ya, yb) >= q1) return 0.0;
  bool inc = yb > ya;
  bool loIn = (inc ? ya : yb) >= q0, hiIn = (inc ? yb : ya) <= q1;
  float tq0 = loIn ? (inc ? a : b) : aacTrigSolve(YC, RY, pY, q0, a, b);
  float tq1 = hiIn ? (inc ? b : a) : aacTrigSolve(YC, RY, pY, q1, a, b);
  float yq0 = loIn ? (inc ? ya : yb) : q0, yq1 = hiIn ? (inc ? yb : ya) : q1;
  float uA = inc ? tq0 : tq1, uB = inc ? tq1 : tq0, yA = inc ? yq0 : yq1, yB = inc ? yq1 : yq0;
  if (abs(uB - uA) < 1e-12) return aacTrigEvalR(UC, RU, pU, uA) > 0.0 ? yB - yA : 0.0;   // both clips on one angle (aacArcMonoContrib): the y ends are known, the side is the angle's
  vec2 ex = aacPhaseExtrema(pU, min(uA, uB), max(uA, uB));          // U-extrema inside
  float g0 = ex.x, g1 = ex.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = uB > uA;
  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : uB);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : uB;
  float ym0 = (n >= 1) ? aacTrigEvalR(YC, RY, pY, m0) : yB, ym1 = (n == 2) ? aacTrigEvalR(YC, RY, pY, m1) : yB;
  return aacWallArcPiece(UC, RU, pU, YC, RY, pY, uA, m0, yA, ym0) + aacWallArcPiece(UC, RU, pU, YC, RY, pY, m0, m1, ym0, ym1)
       + aacWallArcPiece(UC, RU, pU, YC, RY, pY, m1, uB, ym1, yB);
}
float aacWallArc(vec3 X, vec3 Y, float th0, float th1, vec2 yE, float alpha, float beta, float q0, float q1) {
  if (abs(th1 - th0) < 1e-9) return 0.0;
  vec3 U = X - beta * Y - vec3(alpha, 0.0, 0.0);
  float Ry = abs(Y.y) + abs(Y.z), Ru = abs(U.y) + abs(U.z);
  if (Y.x + Ry <= q0 || Y.x - Ry >= q1 || U.x + Ru <= 0.0) return 0.0;
  float RY = sqrt(Y.y * Y.y + Y.z * Y.z), pY = curveAtan2(Y.z, Y.y);
  float yTh0 = yE.x, yTh1 = yE.y;                 // the stored ends
  if (U.x - Ru > 0.0) return clamp(yTh1, q0, q1) - clamp(yTh0, q0, q1);           // wholly right: the clipped ΔY
  float RU = sqrt(U.y * U.y + U.z * U.z), pU = curveAtan2(U.z, U.y);
  vec2 ey = aacPhaseExtrema(pY, min(th0, th1), max(th0, th1));
  float g0 = ey.x, g1 = ey.y;
  int n = (g0 < 1e8) ? ((g1 < 1e8) ? 2 : 1) : 0;
  bool fwd = th1 > th0;
  float m0 = (n == 2) ? (fwd ? g0 : g1) : ((n == 1) ? g0 : th1);
  float m1 = (n == 2) ? (fwd ? g1 : g0) : th1;
  float ym0 = (n >= 1) ? aacTrigEvalR(Y.x, RY, pY, m0) : yTh1, ym1 = (n == 2) ? aacTrigEvalR(Y.x, RY, pY, m1) : yTh1;
  return aacWallArcMono(U.x, RU, pU, Y.x, RY, pY, th0, m0, yTh0, ym0, q0, q1)
       + aacWallArcMono(U.x, RU, pU, Y.x, RY, pY, m0, m1, ym0, ym1, q0, q1)
       + aacWallArcMono(U.x, RU, pU, Y.x, RY, pY, m1, th1, ym1, yTh1, q0, q1);
}
// An arc's X and Y through the columns of a map: the arc point minus c is
// (d.x + rx cp cos θ - ry sp sin θ, d.y + rx sp cos θ + ry cp sin θ)
// The stored endpoints' y through the same map: (Yl at th0, Yl at th1).
vec2 aacArcEndYM(vec4 ends, vec2 c, vec2 mx, vec2 my) {
  vec2 d0 = ends.xy - c, d1 = ends.zw - c;
  return vec2((mx * d0.x + my * d0.y + 0.5).y, (mx * d1.x + my * d1.y + 0.5).y);
}
void aacArcXYM(vec4 d1, vec4 d2, vec2 c, vec2 mx, vec2 my, out vec3 X, out vec3 Y) {
  float sp = sin(d2.z), cp = cos(d2.z);
  vec2 d = d1.xy - c;
  vec2 k0 = mx * d.x + my * d.y + 0.5, kc = (mx * cp + my * sp) * d1.z, ks = (my * cp - mx * sp) * d1.w;
  X = vec3(k0.x, kc.x, ks.x);
  Y = vec3(k0.y, kc.y, ks.y);
}
#endif

float renderFillAACM(vec2 c, vec2 mx, vec2 my, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  if (mx.y == 0.0 && my.x == 0.0) return renderFillAAC(c, vec2(mx.x, my.y), GD, evenOdd, shapeBB);
  // the pixel axis nearest em x carries the far field: a quarter turn of the pixel frame, which keeps it
  // orientation-preserving and the box the unit box
  if (abs(mx.x) < abs(mx.y)) { vec2 tx = vec2(mx.y, -mx.x), ty = vec2(my.y, -my.x); mx = tx; my = ty; }
  float det = mx.x * my.y - my.x * mx.y;
  float J00 = my.y / det, J01 = -my.x / det, J10 = -mx.y / det, J11 = mx.x / det;   // J = M^-1: em per pixel
  vec2 pa = 1.0 / vec2(abs(J00) + abs(J01), abs(J10) + abs(J11));                    // the em box, pixels per em
  // ONE list holding the em box's stripes: its pair, or the band level that holds it (renderFillAAC's rule)
  ivec2 gl = GD.xy;
  int bandsY = GD.w + 1;
  vec2 bbSize = bandBoxSize(shapeBB);
  float hy = 0.5 / pa.y;
  int b0 = clamp(int((c.y - hy - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
  int b1 = clamp(int((c.y + hy - shapeBB.y) / bbSize.y * float(bandsY)), 0, bandsY - 1);
#ifdef MANTLE_AAC_PAIR_BANDS
  bool covers = (b1 <= b0 + 1);
#else
  bool covers = (b0 == b1);
#endif
  int bandY = b0;
  if (!covers) {
    vec4 lv = bFetch(bLoc(gl, 1));
    int lTop = int(lv.z);
    int l = max(int(lv.w), 1), first = int(lv.y) / 2;
    for (int k = l; k < lTop && (b1 >> l) > (b0 >> l) + 1; k++) {
      first += (bandsY + (1 << l) - 1) >> l;
      l++;
    }
    if (!(lTop > 0 && (b1 >> l) <= (b0 >> l) + 1)) return renderFillAAC(c, pa, GD, evenOdd, shapeBB);   // no single list
    bandY = first + (b0 >> l);
  }
  // E, the pixel's right edge, in the em box's frame: X = alpha + beta Y over its span [wq0, wq1]
  vec2 E0 = vec2(0.5 * (J00 - J01), 0.5 * (J10 - J11)) * pa + 0.5, E1 = vec2(0.5 * (J00 + J01), 0.5 * (J10 + J11)) * pa + 0.5;
  float beta = (E1.x - E0.x) / (E1.y - E0.y), alpha = E0.x - beta * E0.y;
  float wq0 = min(E0.y, E1.y), wq1 = max(E0.y, E1.y);

  int hdr = texLin(gl) + bandY * 2;
  vec4 cnts = bFetchL(hdr);
  int nLine = int(cnts.x), nQuad = int(cnts.y), nCubic = int(cnts.z), nArc = int(cnts.w);
  vec4 hdr1 = bFetchL(hdr + 1);
  int hE = texLin(gl) + int(hdr1.x);
  bool rej = fillRayReject(hdr1);
  float xBreak = c.x * pa.x - 0.5;                     // the em box's left edge: nothing left of it counts
  float inBox = 0.0, far = 0.0;
#ifndef MANTLE_NO_LINE
  for (int i = 0; i < nLine; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    vec4 pe = cFetchL(int(segRaw.x) + 1);
    far += aacWallLine(aacPL(pe.xy, c, pa), aacPL(pe.zw, c, pa), alpha, beta, wq0, wq1);
    vec2 A = aacPLM(pe.xy, c, mx, my), B = aacPLM(pe.zw, c, mx, my);
    if (max(A.x, B.x) > 0.0 && min(A.x, B.x) < 1.0 && max(A.y, B.y) > 0.0 && min(A.y, B.y) < 1.0)
      inBox += aacLineContrib(A, B, 0.0, 1.0) + aacWallLine(A, B, 1.0, 0.0, 0.0, 1.0);
  }
#endif
  hE += nLine;
#ifndef MANTLE_NO_QUAD
  for (int i = 0; i < nQuad; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1);
    vec2 p3 = cFetchL(sL + 2).xy;
    far += aacWallQuad(aacPL(p12.xy, c, pa), aacPL(p12.zw, c, pa), aacPL(p3, c, pa), alpha, beta, wq0, wq1);
    vec2 A = aacPLM(p12.xy, c, mx, my), B = aacPLM(p12.zw, c, mx, my), C = aacPLM(p3, c, mx, my);
    if (max(A.x, max(B.x, C.x)) > 0.0 && min(A.x, min(B.x, C.x)) < 1.0 && max(A.y, max(B.y, C.y)) > 0.0 && min(A.y, min(B.y, C.y)) < 1.0)
      inBox += aacQuadContrib(A, B, C, 0.0, 1.0) + aacWallQuad(A, B, C, 1.0, 0.0, 0.0, 1.0);
  }
#endif
  hE += nQuad;
#ifndef MANTLE_NO_CUBIC
  for (int i = 0; i < nCubic; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    int sL = int(segRaw.x);
    vec4 p12 = cFetchL(sL + 1), p34 = cFetchL(sL + 2);
    far += aacWallCubic(aacPL(p12.xy, c, pa), aacPL(p12.zw, c, pa), aacPL(p34.xy, c, pa), aacPL(p34.zw, c, pa), alpha, beta, wq0, wq1);
    vec2 A = aacPLM(p12.xy, c, mx, my), B = aacPLM(p12.zw, c, mx, my), C = aacPLM(p34.xy, c, mx, my), D = aacPLM(p34.zw, c, mx, my);
    if (max(max(A.x, B.x), max(C.x, D.x)) > 0.0 && min(min(A.x, B.x), min(C.x, D.x)) < 1.0
        && max(max(A.y, B.y), max(C.y, D.y)) > 0.0 && min(min(A.y, B.y), min(C.y, D.y)) < 1.0)
      inBox += aacCubicContrib(A, B, C, D, 0.0, 1.0) + aacWallCubic(A, B, C, D, 1.0, 0.0, 0.0, 1.0);
  }
#endif
  hE += nCubic;
#ifndef MANTLE_NO_ARC
  for (int i = 0; i < nArc; i++) {
    vec4 segRaw = bFetchL(hE + i);
    if (segRaw.y * pa.x < xBreak) break;
    if (rej && aacLaneMiss(segRaw, c.y, pa.y, 0.0, 1.0)) continue;
    int sL = int(segRaw.x);
    vec4 d1 = cFetchL(sL + 1), d2 = cFetchL(sL + 2), ends = cFetchL(sL + 3);   // the stored ends
    vec3 X, Y;
    aacArcXYM(d1, d2, c, vec2(pa.x, 0.0), vec2(0.0, pa.y), X, Y);
    far += aacWallArc(X, Y, d2.x, d2.y, aacArcEndYM(ends, c, vec2(pa.x, 0.0), vec2(0.0, pa.y)), alpha, beta, wq0, wq1);
    aacArcXYM(d1, d2, c, mx, my, X, Y);
    float Rx = abs(X.y) + abs(X.z), Ry = abs(Y.y) + abs(Y.z);
    if (X.x + Rx > 0.0 && X.x - Rx < 1.0 && Y.x + Ry > 0.0 && Y.x - Ry < 1.0) {
      vec2 yE = aacArcEndYM(ends, c, mx, my);
      inBox += aacArcContribXY(X, Y, d2.x, d2.y, yE, 0.0, 1.0) + aacWallArc(X, Y, d2.x, d2.y, yE, 1.0, 0.0, 0.0, 1.0);
    }
  }
#endif
  return aacFold(inBox - far / (pa.y * abs(J11)), evenOdd);
}
#endif

//
// The cheapest exact path from slug's own walk is this one. The exact coverage is the fold of
//     run = sum over segments of -integral clamp(X, 0, 1) dclamp(Y, 0, 1)       (pixel-local: the cell is [0, 1]^2)
// and it splits into the segments that meet the pixel, which need their exact in-box integral, and the ones wholly right
// of it, which add their RIGHT-EDGE WINDING: the dY of their part beside the pixel, the H ray's crossings right of the
// pixel integrated over its height (the decomposition; aacRightD). Nothing of Slug's walk survives that: a wholly-right
// segment's side of the ray is decided by its hull, with no root solve; the V ray and the two-ray blend answer nothing the
// integral does not; and the list must hold the whole pixel box, not the center's stripe. What is left -- one list holding
// the pixel box, each segment integrated once -- is AAC's walk. A hybrid that keeps the estimate where one piece crosses
// the pixel is not exact (a single cubic's loop inside the pixel, a tight quad cutting its corner), and it keeps Slug's two
// walks under the integrals it adds: the fold fallback that priced it cost more than AAC itself on every page.
float renderFill(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {
  return renderFillAAC(c, px, GD, evenOdd, shapeBB);
}
// (mx, my): the em -> device-pixel map's columns, orientation-preserving. An axis-aligned program has only the
// diagonal; a rotated-map program's renderFillAACM hands an axis-aligned map to renderFillAAC itself.
float renderFillM(vec2 c, vec2 mx, vec2 my, ivec4 GD, bool evenOdd, vec4 shapeBB) {
#ifdef MANTLE_ROTATED_MAP
  return renderFillAACM(c, mx, my, GD, evenOdd, shapeBB);
#else
  return renderFillAAC(c, vec2(mx.x, my.y), GD, evenOdd, shapeBB);
#endif
}
