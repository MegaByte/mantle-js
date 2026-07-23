#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;  // uOverrideTex/uLbPaintTex are RGBA32F em-space data (lowp default crushes them)
// loopBlinn.vert.glsl — vertex stage of the additive Loop-Blinn hybrid fill.
//
// Projects an em-space mesh vertex to clip space using the SAME em→NDC
// pipeline as the Slug fill (mantle.vert.glsl). The fragment needs (a) the
// interpolated em-space position (cubic-bezout fallback + strips), (b) the
// interpolated texcoords aTC (quad u²−v, or the Loop-Blinn k,l,m for cubics),
// and (c) the FLAT per-curve coefficients (kind/sign + the 3×3 Bezout coeffs,
// used only by the kind-4 fallback).
//
// Unified vertex layout (24 floats / 96 bytes, one interleaved VBO):
//   loc0 aPos   vec2   em-space position                         (interp → vEm)
//   loc1 aTC    vec3   quad (u,v,_) · cubic-klmn (k,l,m) · strip  (interp → vTC)
//   loc2 aFlags vec2   (kind, sign)                               (flat)
//   loc3 aC0    vec4   M00.xyz, M01.x                             (flat)
//   loc4 aC1    vec4   M01.yz, M02.xy                             (flat)
//   loc5 aC2    vec4   M02.z, M11a, M12, M22                      (flat)
//   loc6 aC3    vec4   cen.xy, scale, _  (strip: normal.xy, const) (flat)
//   loc7 aColor vec4   per-vertex paint (route direct mode)
//   kind: 0 interior · 2 cubic-klmn · 4 cubic-bezout · 5 quad/rquad crescent ·
//         7 circle/annulus SDF · 10 edge cap-strip · 12 unified curve band
//         — full table in loopBlinn.frag.glsl's header.

// Geometry attributes. The A-stream is the (only) stream for the static
// programs; the MORPH-PAIR variant adds a B-stream (the destination endpoint)
// and main() opens by declaring locals under the working names (aPos, aTC, …)
// as either the A values or the uMorphT mix — the body below is identical for
// every variant, with no macro renaming. aFlags (kind/sign) and aSeamM are
// endpoint-invariant; aColor and aShapeRow ride per-draw constants on the
// per-shape route. Morph slots: 0-6,8 = A, 10-15 = B (16-attribute budget).
layout(location=0) in vec2 aPosA;
layout(location=1) in vec3 aTCA;
layout(location=2) in vec2 aFlags;
// Bezout (kind-4 cusp fallback) matrix attributes — the LEAN program variant
// (MANTLE_NO_BEZOUT, picked when the mesh has no Bezout cubics) omits aC1/aC2.
// aC0 stays in BOTH variants: kind-5 crescents / kind-10 reuse it for clip normals
// (vNa/vNb), so the lean program needs it declared too.
layout(location=3) in vec4 aC0A;
#ifndef MANTLE_NO_BEZOUT
layout(location=4) in vec4 aC1A;
layout(location=5) in vec4 aC2A;
#endif
layout(location=6) in vec4 aC3A;
layout(location=7) in vec4 aColor;
#ifdef MANTLE_LB_MORPH_PAIR
layout(location=10) in vec2 aPosB;
layout(location=11) in vec3 aTCB;
layout(location=12) in vec4 aC0B;
#ifndef MANTLE_NO_BEZOUT
layout(location=13) in vec4 aC1B;
layout(location=14) in vec4 aC2B;
#endif
layout(location=15) in vec4 aC3B;
uniform float uMorphT;
#endif
// Kind-5 rquad crescent seam dilation needs a 3-component texcoord mean (Ũ,Ṽ,R);
// centroid + mean(Ũ,Ṽ) ride aC3, mean(R) rides this otherwise-unused pad float
// (loc8). Present in BOTH programs (the lean variant only drops Bezout) — a plain
// attribute, no varying cost. Inert for kinds ≠ 5.
layout(location=8) in float aSeamM;

uniform vec4 uGlobalBBox;   // [xmin, ymin, w, h] em-space
// Per-shape runtime overrides (fill/tint/visibility), applied IN THE VS so the
// combined VBO stays fully static under animation — re-assembling the buffer
// per frame collapses under animated text. Shape index is recovered from
// gl_VertexID via a first-vertex-per-shape table (binary search, ≤10 steps).
uniform sampler2D uOverrideTex;    // 6 texels/shape (see _bundleLayout.glsl)
// BATCHED GRADIENTS. The one-draw combined route paints solid colour from the aColor
// attribute, which cannot carry a gradient. Attribute locations
// are exhausted (loc 15 is taken; GL guarantees only 16), so per-shape paint rides a
// TEXTURE instead, indexed by the aShapeRow the route already carries:
//   (0,row) = (gradientId, imageId, 0, 0)   (1,row) = shape bbox (x0,y0,x1,y1)
//   (2,row) = image rect (em)               (3,row) = atlas slot
uniform sampler2D uLbPaintTex;
uniform int uLbHasPaint;           // 1 → the bundle has per-shape gradients
uniform int uLbHasOvr;             // 1 → apply overrides (combined route)
// Shape row baked per-vertex by the combined assembly (a per-vertex binary search
// over a starts texture was tried first: ~12 dependent vertex-texture fetches per
// vertex — a screen of animated text became VERTEX-bound. One static attribute
// replaces the whole search).
layout(location=9) in float aShapeRow;
uniform vec2 uCanvasAR;     // aspect-ratio correction (arScale)
uniform mat3 uWorldM;       // per-draw world transform (column-major)
uniform int  uHasWorldM;    // 1 → apply uWorldM, 0 → identity
uniform vec2 uViewportSize; // drawing-buffer px (for straight-edge AA dilation)

out vec2 vEm;
out vec3 vTC;
flat out float vKind;
flat out float vSign;
#ifndef MANTLE_NO_BEZOUT
flat out vec3  cM00;
flat out vec3  cM01;
flat out vec3  cM02;
flat out float cM11a;
flat out float cM12;
flat out float cM22;
flat out vec4  vCh2A;    // kind-0 chain mode: 2nd outline arc Q0,Q1 (aC1 — kind-4-only otherwise)
flat out vec4  vCh2B;    // kind-0 chain mode: 2nd outline arc Q2,Q3 (aC2)
#endif
flat out vec2  cCen;
flat out float cScale;
flat out float cHalf;   // kind 7: ring half-width (≥0) or disc-mode sentinel (<0)
flat out float vEmPerPx; // em per device pixel — the straight-edge ramps derive ∇f
                         // analytically from this (see frag), never from dFdx, which
                         // corrupts on the CDT's thin sliver triangles on real GPUs
flat out float vSeam;    // kind-1 crescent: off-curve control point x (ctrl.y rides vTC.z) for the tangent clip
flat out float vGradId;  // per-shape gradient id (0 = solid) for the batched route
flat out float vImageId; // per-shape image id (0 = none)
flat out vec4  vImgRect; // per-shape image rect (em)
flat out vec4  vAtlasSlot;
flat out vec4  vShapeBB;  // per-shape em bbox, for objectBoundingBox gradient units
flat out vec2  vNa;      // kind-1 crescent clip normal at endpoint a (aC0.xy — reuses the kind-4-only Bezout slot)
flat out vec2  vNb;      // kind-1 crescent clip normal at endpoint b (aC0.zw)
flat out vec3  vLine2;   // kind-0 SECOND boundary line (aC0.xyz) — thin-stroke/corner combined coverage
flat out float vLineT;   // kind-0 corner type (aC0.w): +1 convex/stroke · −1 reflex · 0 none
flat out vec4  vColor;

const int OV_POS_VIS = 1;   // tx,ty,vis,mask (matches _bundleLayout.glsl)
const int OV_TINT    = 2;
const int OV_FILL    = 3;

// em-per-device-pixel for an AA dilation pushed along the em-space direction
// `dirEm`. `basePx` is the em→pixel scale of the em→plane→viewport chain WITHOUT
// the world matrix. The world matrix (uWorldM) multiplies the PLANE coordinates
// (clip3 = uWorldM * vec3(plane.x, -plane.y, 1)), so its linear 2×2 stretches the
// dilation by the mapped length of the plane-space direction (note the plane Y-flip).
//   • No world matrix, or a CONFORMAL one (uniform scale + rotation → equal-length
//     orthogonal columns), or no usable direction → returns the exact legacy scalar
//     basePx/length(col0), byte-identical to the previous code (zero parity risk on
//     the common path).
//   • ANISOTROPIC scale / SKEW (reachable via a caller-supplied or animated
//     worldMatrix — SVG scale(sx,sy)/skew, synthetic-oblique text) → returns the
//     direction-correct basePx/|M·d̂|, so the dilation is ~constant screen pixels in
//     the push direction instead of collapsing on the compressed axis.
float emPerPxFor(vec2 dirEm, float basePx) {
  if (uHasWorldM == 0) return basePx;
  vec2 c0 = vec2(uWorldM[0][0], uWorldM[0][1]);   // linear column mapping plane.x
  vec2 c1 = vec2(uWorldM[1][0], uWorldM[1][1]);   // linear column mapping plane.y
  float l0 = length(c0), l1 = length(c1);
  float dl = length(dirEm);
  if (dl < 1e-9 ||
      (abs(l1 - l0) <= 1e-4 * max(l0, l1) && abs(dot(c0, c1)) <= 1e-4 * max(l0 * l1, 1e-20)))
    return basePx / max(l0, 1e-4);                // conformal / directionless → legacy
  vec2 pd = vec2(dirEm.x, -dirEm.y) / dl;         // plane-space unit direction (Y-flip)
  return basePx / max(length(c0 * pd.x + c1 * pd.y), 1e-4);
}


void main() {
#ifdef MANTLE_LB_MORPH_PAIR
  vec2 aPos = mix(aPosA, aPosB, uMorphT);
  vec3 aTC  = mix(aTCA,  aTCB,  uMorphT);
  vec4 aC0  = mix(aC0A,  aC0B,  uMorphT);
#ifndef MANTLE_NO_BEZOUT
  vec4 aC1  = mix(aC1A,  aC1B,  uMorphT);
  vec4 aC2  = mix(aC2A,  aC2B,  uMorphT);
#endif
  vec4 aC3  = mix(aC3A,  aC3B,  uMorphT);
#else
  vec2 aPos = aPosA;
  vec3 aTC  = aTCA;
  vec4 aC0  = aC0A;
#ifndef MANTLE_NO_BEZOUT
  vec4 aC1  = aC1A;
  vec4 aC2  = aC2A;
#endif
  vec4 aC3  = aC3A;
#endif
  vColor = aColor;
  if (uLbHasOvr == 1) {
    int row = int(aShapeRow + 0.5);
    vec4 ovP  = texelFetch(uOverrideTex, ivec2(OV_POS_VIS, row), 0);
    vec4 ovT  = texelFetch(uOverrideTex, ivec2(OV_TINT, row), 0);
    int  ovMask = int(ovP.w + 0.5);
    if ((ovMask & 1) != 0) vColor = texelFetch(uOverrideTex, ivec2(OV_FILL, row), 0);
    vColor *= ovT;
    vColor.a *= clamp(ovP.z, 0.0, 1.0);
  }
  vGradId = 0.0; vImageId = 0.0; vShapeBB = vec4(0.0); vImgRect = vec4(0.0); vAtlasSlot = vec4(0.0);
  if (uLbHasPaint == 1) {
    int prow = int(aShapeRow + 0.5);
    vec4 p0  = texelFetch(uLbPaintTex, ivec2(0, prow), 0);
    vGradId  = p0.x; vImageId = p0.y;
    vShapeBB = texelFetch(uLbPaintTex, ivec2(1, prow), 0);
    if (vImageId > 0.5) {
      vImgRect   = texelFetch(uLbPaintTex, ivec2(2, prow), 0);
      vAtlasSlot = texelFetch(uLbPaintTex, ivec2(3, prow), 0);
    }
  }
  vTC = aTC;
  vKind = aFlags.x;
  vSign = aFlags.y;
  vSeam = aSeamM;   // kind-10 end codes / cubic morph clip marker
  vNa = aC0.xy;     // kind-10 neighbour A / cubic morph clip (aC0 otherwise kind-4-only;
  vNb = aC0.zw;     // MUST be outside the NO_BEZOUT guard — lean needs it)
  vLine2 = aC0.xyz; // kind-0 second boundary line + corner type (same shared slot, disjoint kinds)
  vLineT = aC0.w;
#ifndef MANTLE_NO_BEZOUT
  cM00 = aC0.xyz;
  cM01 = vec3(aC0.w, aC1.xy);
  cM02 = vec3(aC1.zw, aC2.x);
  cM11a = aC2.y;
  cM12  = aC2.z;
  cM22  = aC2.w;
  // kind-0 chain mode: the face's SECOND outline arc (Q0..Q3). Same aC1/aC2
  // slots as the Bezout matrix — disjoint kinds, and a mesh carrying chain 2 is
  // flagged so it binds the full program. All-zero when the face has one arc.
  vCh2A = aC1;
  vCh2B = aC2;
#endif
  cCen  = aC3.xy;
  cScale = aC3.z;
  cHalf = aC3.w;

  // Straight-edge AA: the kind-3 strip is dilated OUTWARD (aTC.x>0.5) along the
  // edge normal N=cCen by ~1.25px and the fragment ramps the OUTER half; the kind-0
  // interior carries the same edge line in aC3 and ramps the INNER half, meeting at
  // ½-coverage on the edge (kind 2 klmn also sets aTC.x, so the guard excludes it;
  // kind 4 aTC=0 so it's inert). emPerPx is per-DEVICE-pixel; the em→plane→NDC map is
  // scaled by uWorldM, so a shrinking world transform puts FEWER screen px per em →
  // true em-per-px is LARGER by 1/worldScale. Divide it in, else the dilation
  // collapses sub-pixel on scaled-down shapes (the stroke path does the same).
  //
  // CURVE crescents (kinds 2/5) are NOT dilated (radial hull dilation pushes
  // the whole hull outward → systematic "overcoverage on curves"). The fragment uses
  // curvature-aware coverage (curveCov) so the ½-level lands exactly on the arc, and the
  // seam WEDGE where adjacent crescents pinch is owned by kind-10/12 end chaining —
  // curves stay smooth without the over-coverage.
  // basePx = em→pixel scale WITHOUT the world matrix; emPerPxFor folds in the world
  // matrix per direction (byte-identical to the old basePx/length(col0) for conformal
  // transforms, direction-correct under anisotropic scale/skew — see the helper).
  float basePx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  vEmPerPx = emPerPxFor(aC3.xy, basePx);           // kind-0 straight-edge normal (aC3.xy)
  vec2 emPos = aPos;
  if (aFlags.x > 3.5 && aFlags.x < 4.5) {
    // kind-4 Bezout crescent: the implicit is evaluated from POSITION (not interpolated
    // attributes), so dilating the hull outward extends the AA band with exact values —
    // ring-less Bezout pieces (health-gated kappa cubics) otherwise clip their ramp at
    // the hull edge (the icon-ring 0.4-class residual).
    vec2 out4 = aPos - cCen;
    float L4 = max(length(out4), 1e-9);
    vEmPerPx = emPerPxFor(out4, basePx);
    emPos = aPos + (out4 / L4) * (1.5 * emPerPxFor(out4, basePx));
  } else if (aFlags.x > 9.5 && aFlags.x < 10.5) {
    // Edge cap-strip (kind 10): quad spanning the edge's exterior band [0, +nExt]px plus
    // tangential end extensions ±tExt so it covers both corner wedges; the fragment's
    // watertight plane tests trim to this edge's exact zone. Role: aTC.x = tEnd + 2·sOuter.
    vec2 p1k = aC3.xy, p2k = vec2(aC3.z, aC3.w);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-9);
    vec2 nOutk = vec2(-tdk.y, tdk.x) * aFlags.y;
    float tR = mod(aTC.x, 2.0), sR = floor(aTC.x / 2.0 + 0.25);
    vec2 basek = tR < 0.5 ? p1k : p2k;
    vEmPerPx = emPerPxFor(nOutk, basePx);
    // Tip reach: 3.2px base; acute line–line ends boost so START's extruded
    // quad covers the intersecting-lines bulb (END cedes that zone in the FS).
    // Keep the boost modest: over-reach creates isolated solid spikes on the
    // tip fringe relative to the reference coverage paths.
    float tExt = 3.2, nExt = 3.2;
    if (sR >= 0.5) {
      float codeA10 = floor((aSeamM + 0.5) / 16.0), codeB10 = aSeamM - codeA10 * 16.0;
      float code10 = tR < 0.5 ? codeA10 : codeB10;
      float ty10 = floor((code10 + 0.5) / 4.0) - 1.0;
      bool curve10 = mod(code10, 4.0) >= 1.5;
      if (ty10 > 0.5 && !curve10) {
        vec2 nN10 = tR < 0.5 ? aC0.xy : aC0.zw;
        float nDot10 = dot(nOutk, nN10);
        if (nDot10 < -0.35) {
          float boost10 = 1.0 + 0.55 * clamp(-0.35 - nDot10, 0.0, 1.35);
          tExt *= boost10;
          nExt *= boost10;
        }
      }
    }
    // inner boundary EXACTLY on the edge AND inner verts EXACTLY the outline endpoints:
    // shared coordinates give bit-identical edge equations, so rasterization tie-break
    // partitions strip vs interior watertight. Only the OUTER verts extend for
    // corner-wedge candidate coverage.
    emPos = basek + tdk * ((tR < 0.5 ? -tExt : tExt) * (sR < 0.5 ? 0.0 : emPerPxFor(tdk, basePx))) + nOutk * ((sR < 0.5 ? 0.0 : nExt) * emPerPxFor(nOutk, basePx));
  } else if (aFlags.x > 11.5 && aFlags.x < 12.5) {
    // Unified curve band (kind 12): same push as kind-9 (1.5px). Footprint is the
    // kind-9 ring/bbox (Loop §5 exterior coverage geometry); end partitions trim it.
    // aTC=(Ũ,Ṽ,R) for quads; cubic mode (|sign|≥8192) uses aTC=(k,l,m) with
    // aC0=(n̂, packHalf2x16(dk,dl), dm) so aC3 can hold (a,b) for end chaining.
    float amt12 = 1.5 * emPerPxFor(aC0.xy, basePx);
    vEmPerPx = emPerPxFor(aC0.xy, basePx);
    emPos = aPos + aC0.xy * amt12;
    if (abs(aFlags.y) >= 8192.0) {
      vec2 dkl12 = unpackHalf2x16(floatBitsToUint(aC0.z));
      vTC = aTC + vec3(dkl12, aC0.w) * amt12;
    } else vTC = vec3(aTC.xy + aC0.zw * amt12, aTC.z);
  }
  vEm = emPos;

  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;
  // DEPTH-CARVED BANDS: curve/edge pieces (any kind but plain interior) sit a
  // hair NEARER than kind-0 solids, so under LEQUAL an interior fragment is
  // REJECTED wherever a piece covers the pixel — the piece's analytic coverage
  // is authoritative there. This replaces geometric face-shredding (the band
  // splitter) as the "subtract the solid under the ramp" mechanism.
  // DEPTH-CLAIM CASCADE (active when the draw enables DEPTH_TEST): two z-tiers
  // inside each shape's painter layer — analytic pieces (crescents / discs) at
  // -1e-5, kind-0 interiors and opaque strips/bands (10/12) at 0. Draw order
  // pieces → interiors: piece depth REJECTS the interior wherever it claims;
  // strips/bands blend with interiors (outside-band turf). Equal-z blending
  // within a tier keeps crescent tiling semantics. The shape's painter ordinal
  // rides aFlags.x's fraction (layer step 2.4e-5 > the 1e-5 tier span).
  float kindI9 = floor(aFlags.x + 0.25);
  float frac9 = (aFlags.x - kindI9) * 8192.0;
  // bit 11 of the fraction = the shape's BLEND flag (audit-marginal fur:
  // co-covering pieces need union compositing, not single-owner claims —
  // their pieces drop to the interior tier so everything blends).
  float blend9 = step(2048.0, frac9 + 0.5);
  float ord9 = frac9 - blend9 * 2048.0;
  // STRIPS (kind 10) and the unified curve band (kind 12) sit WITH the interiors:
  // their turf is the OUTSIDE band — air, where claiming rejects nothing — while
  // at organic joins the band sweeps across the neighbour arc's ink, where a
  // partial claim would under-ink a hairline seam. Blending there is exact
  // (band ∪ interior-1 saturates); only coverage-authoritative crescents claim.
  // Keeping kind 12 on the piece tier punched one-pixel holes wherever a
  // near-zero exterior fragment overlapped glyph fill.
  bool strip9 = (kindI9 > 9.5 && kindI9 < 10.5) || (kindI9 > 11.5 && kindI9 < 12.5);
  // TRANSLUCENT shapes cannot let their pieces CO-COVER. The strip/blend unions
  // above are exact only at α=1, where "band ∪ interior saturates" — OVER with an
  // opaque colour is idempotent, so painting a pixel twice is harmless. At α<1 it
  // is not: the union blends the shape OVER ITSELF. α=0.6 twice is 0.84, three
  // times 0.94, and the curve bands drive to fully opaque — so a translucent shape
  // renders its edges far too solid and swallows whatever sits behind it (measured
  // on a 0.6-alpha ridge: the band read 1.00 where the truth is 0.60).
  // Below α, give the strips their own claiming tier and ignore the blend flag, so
  // every pixel has ONE owner and takes exactly ONE OVER. The hairline seam the
  // blend union exists to avoid is the lesser evil against a visibly wrong alpha.
  bool opaque9 = vColor.a >= 0.996;
  float tier9 = (kindI9 == 0.0 || (strip9 && opaque9)) ? 0.0 : 1e-5;
  float blendEff9 = opaque9 ? blend9 : 0.0;
  float carveZ = -ord9 * 2.4e-5 - (1.0 - blendEff9) * tier9;
  gl_Position = vec4(clip3.xy, carveZ * clip3.z, clip3.z);
}
