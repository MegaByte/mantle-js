#version 300 es
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
//   kind: 0 interior · 1 quad · 2 cubic-klmn · 3 edge-strip · 4 cubic-bezout.

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
// aC0 stays in BOTH variants: kind-1 quads reuse it for the crescent clip normals
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
#endif
flat out vec2  cCen;
flat out float cScale;
flat out float cHalf;   // kind 7 (annulus SDF) half-width; unused by other kinds
flat out float vEmPerPx; // em per device pixel — the straight-edge ramps derive ∇f
                         // analytically from this (see frag), never from dFdx, which
                         // corrupts on the CDT's thin sliver triangles on real GPUs
flat out float vTP;      // kind-8 corner cap: T·p (tangential coord of the on-curve pt)
flat out float vSeam;    // kind-1 crescent: off-curve control point x (ctrl.y rides vTC.z) for the tangent clip
flat out vec2  vNa;      // kind-1 crescent clip normal at endpoint a (aC0.xy — reuses the kind-4-only Bezout slot)
flat out vec2  vNb;      // kind-1 crescent clip normal at endpoint b (aC0.zw)
flat out vec3  vLine2;   // kind-0 SECOND boundary line (aC0.xyz) — thin-stroke/corner combined coverage
flat out float vLineT;   // kind-0 corner type (aC0.w): +1 convex/stroke · −1 reflex · 0 none
flat out vec4  vColor;

const int OV_POS_VIS = 1;   // tx,ty,vis,mask (matches _bundleLayout.glsl)
const int OV_TINT    = 2;
const int OV_FILL    = 3;

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
  vTC = aTC;
  vKind = aFlags.x;
  vSign = aFlags.y;
  vSeam = aSeamM;   // kind-1 crescent tangent-clip: ctrl.x
  vNa = aC0.xy;     // kind-1 crescent bisector clip normals (aC0 is otherwise kind-4-only, so
  vNb = aC0.zw;     // reusing it costs nothing; MUST be outside the NO_BEZOUT guard — lean needs it)
  vLine2 = aC0.xyz; // kind-0 second boundary line + corner type (same shared slot, disjoint kinds)
  vLineT = aC0.w;
#ifndef MANTLE_NO_BEZOUT
  cM00 = aC0.xyz;
  cM01 = vec3(aC0.w, aC1.xy);
  cM02 = vec3(aC1.zw, aC2.x);
  cM11a = aC2.y;
  cM12  = aC2.z;
  cM22  = aC2.w;
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
  // CURVE crescents (kinds 1/2/5) are NOT dilated (radial hull dilation pushes
  // the whole hull outward → systematic "overcoverage on curves"). The fragment uses
  // curvature-aware coverage (curveCov) so the ½-level lands exactly on the arc, and the
  // seam WEDGE where adjacent crescents pinch is filled by dedicated kind-8 corner caps
  // (below) — curves stay smooth without the over-coverage.
  float emPerPx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  if (uHasWorldM == 1) emPerPx /= max(length(vec2(uWorldM[0][0], uWorldM[0][1])), 1e-4);
  vEmPerPx = emPerPx;
  vec2 emPos = aPos;
  if (aFlags.x > 1.5 && aFlags.x < 2.5 && aSeamM > 5.0) {
    // cubic exterior-ring outer vert: extrude ~1.5px outward; k,l,m ride the SAME
    // affine map (Δklm = ∇klm·n̂ per em), so curveCov's derivatives stay exact.
    float amt2 = 1.5 * emPerPx;
    emPos = aPos + aC0.xy * amt2;
    vTC = aTC + vec3(aC0.zw, aC3.x) * amt2;
  } else if (aFlags.x > 3.5 && aFlags.x < 4.5) {
    // kind-4 Bezout crescent: the implicit is evaluated from POSITION (not interpolated
    // attributes), so dilating the hull outward extends the AA band with exact values —
    // ring-less Bezout pieces (health-gated kappa cubics) otherwise clip their ramp at
    // the hull edge (the icon-ring 0.4-class residual).
    vec2 out4 = aPos - cCen;
    float L4 = max(length(out4), 1e-9);
    emPos = aPos + (out4 / L4) * (1.5 * emPerPx);
  } else if (aFlags.x > 2.5 && aFlags.x < 3.5 && aTC.x > 0.5) {
    emPos += cCen * (1.25 * emPerPx);
  } else if (aFlags.x > 7.5 && aFlags.x < 8.5) {
    // CONVEX-corner cap (kind 8): a small scale-blind quad at a junction (aPos) whose
    // tangents turn convexly, owning the exterior wedge beyond BOTH tangent spans.
    // aC3 = tangent line A (nx,ny,c) → cCen/cScale; aC0 = tangent line B → vLine2 (both
    // assigned above). Expand ±1.8px in the (outward bisector, perp) frame; the fragment
    // discards centres inside either half-plane and paints the two-line box coverage.
    vec2 bis = aC3.xy + aC0.xy;
    bis = bis / max(length(bis), 1e-6);
    vec2 tang = vec2(-bis.y, bis.x);
    float capS = 1.8 * emPerPx;
    emPos = aPos + (aTC.x * tang + aTC.y * bis) * capS;
  } else if (aFlags.x > 8.5 && aFlags.x < 9.5) {
    // Curve strip (kind 9): push verts flagged by nonzero aC0 extrude outward by ~1.25px;
    // texcoords move by Δuv = J·n̂ per em so the interpolated UV stays the crescent's exact
    // global affine frame at every scale (the strip exists to span the AA band that a
    // sub-pixel-thin crescent's own geometry cannot).
    float amt = 1.5 * emPerPx;
    emPos = aPos + aC0.xy * amt;
    vTC = vec3(aTC.xy + aC0.zw * amt, aTC.z);
  } else if (aFlags.x > 9.5 && aFlags.x < 10.5) {
    // Edge cap-strip (kind 10): quad spanning the edge's exterior band [−0.35, +1.4]px plus
    // tangential end extensions ±2.6px so it covers both corner wedges; the fragment's
    // watertight plane tests trim to this edge's exact zone. Role: aTC.x = tEnd + 2·sOuter.
    vec2 p1k = aC3.xy, p2k = vec2(aC3.z, aC3.w);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-9);
    vec2 nOutk = vec2(-tdk.y, tdk.x) * aFlags.y;
    float tR = mod(aTC.x, 2.0), sR = floor(aTC.x / 2.0 + 0.25);
    vec2 basek = tR < 0.5 ? p1k : p2k;
    // inner boundary EXACTLY on the edge AND inner verts EXACTLY the outline endpoints:
    // shared coordinates give bit-identical edge equations, so rasterization tie-break
    // partitions strip vs interior watertight. The old −0.35px inner margin + fp-tie
    // window let BOTH paint (1−(1−c)² stem columns at 5.3×); tangentially extending the
    // INNER verts made the boundary collinear-but-different-verts — fp-fragile, dropping
    // center-on-edge pixels from both painters (the v/a 0.5-tie holes). Only the OUTER
    // verts extend ±2.6px for corner-wedge candidate coverage.
    emPos = basek + tdk * ((tR < 0.5 ? -2.6 : 2.6) * (sR < 0.5 ? 0.0 : emPerPx)) + nOutk * ((sR < 0.5 ? 0.0 : 3.2) * emPerPx);
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
  // DEPTH-CLAIM CASCADE (active when the draw enables DEPTH_TEST): three
  // z-tiers inside each shape's painter layer — CAPS (kind 8, the corner
  // authorities: chained box-combine coverage) nearest at -2e-5, every other
  // piece at -1e-5, kind-0 interiors at 0. Draw order caps → pieces →
  // interiors: each tier's depth REJECTS the tiers below wherever it claims,
  // so a corner pixel is owned by the cap alone, a band pixel by its piece,
  // and the interior only paints where nothing analytic claimed. Equal-z
  // blending within a tier keeps the crescent/strip tiling semantics. The
  // shape's painter ordinal rides aFlags.x's fraction (layer step 2.4e-5 >
  // the 2e-5 tier span, so layers never interleave).
  float kindI9 = floor(aFlags.x + 0.25);
  float frac9 = (aFlags.x - kindI9) * 8192.0;
  // bit 11 of the fraction = the shape's BLEND flag (audit-marginal fur:
  // co-covering pieces need union compositing, not single-owner claims —
  // their pieces drop to the interior tier so everything blends).
  float blend9 = step(2048.0, frac9 + 0.5);
  float ord9 = frac9 - blend9 * 2048.0;
  // STRIPS (kinds 9/10) sit WITH the interiors: their turf is the OUTSIDE
  // band — air, where claiming rejects nothing — while at organic joins the
  // band sweeps across the neighbour arc's ink, where a partial claim would
  // under-ink a hairline seam. Blending there is exact (band ∪ interior-1
  // saturates); only the coverage-authoritative pieces claim.
  bool strip9 = kindI9 > 8.5 && kindI9 < 10.5;
  float tier9 = (kindI9 == 0.0 || strip9) ? 0.0 : ((kindI9 > 7.5 && kindI9 < 8.5) ? 2e-5 : 1e-5);
  float carveZ = -ord9 * 2.4e-5 - (1.0 - blend9) * tier9;
  gl_Position = vec4(clip3.xy, carveZ * clip3.z, clip3.z);
}
