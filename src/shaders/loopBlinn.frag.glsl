#version 300 es
// loopBlinn.frag.glsl — coverage stage of the additive Loop-Blinn fill.
//
// Writes COVERAGE (not color) to an R8/RGBA8 target, accumulated with
// blendEquation(MAX): interior triangles contribute 1, each curve's
// control-hull region contributes the analytic side-of-curve coverage. MAX is
// conflation-free because coverage is a distance/occupancy function and the
// union of overlapping pieces is the nearest = the max (so the additive
// crescents compose identically to OVER on solid color, and straight-edge AA
// ramps at sharp corners don't double-count). A later `loopBlinnComposite`
// pass multiplies the shape's paint by this coverage.
//
// Piece kinds (vKind, dispatched in main):
//   0  interior triangle (carries up to three straight boundary lines whose
//      inner AA ramps meet the outward strips at ½ on the edge)
//   2  cubic (Loop-Blinn klmn)       f = k³−l·m
//   4  cubic Bezout fallback (cusp / d1≈0): exact 3×3 symmetric determinant
//      of linear forms in the per-curve normalized frame (cen/scale)
//   5  quad / rational-quad crescent  f = Ũ²−Ṽ·R  (integral ⇒ R≡1; aC3=0 ⇒
//      fill-side only — kind-12 owns the exterior band)
//   7  circular / annulus / elliptical SDF
//                                     cHalf < −1.5 → ellipse f = |R(φ)(p−C)/(rx,ry)| − 1
//                                     −1.5 ≤ cHalf < 0 → disc f = |p−C| − r
//                                     cHalf ≥ 0 → ring f = ||p−C| − rMid| − halfW
//   10 edge cap-strip (straight-edge exterior band + end wedges)
//   12 unified curve band (quad/rquad/cubic exterior)
// Straight/SDF kinds take the EXACT pixel-box coverage of the half-plane
// (exactBoxCov); curve kinds take the same box area of the tangent plane
// (curveCov). Both give a resolution-independent analytic AA ramp across
// the zero set.

precision highp float;
// GLSL ES 3.0 predeclares lowp sampler2D; the gradient/paint textures are
// RGBA32F em-space data — lowp lookup precision crushes them on
// precision-honouring GPUs (Mali).
precision highp sampler2D;

in vec2 vEm;
in vec3 vTC;
flat in float vKind;
flat in float vSign;
// Bezout (kind-4) matrix varyings — omitted by the lean program (MANTLE_NO_BEZOUT).
#ifndef MANTLE_NO_BEZOUT
flat in vec3  cM00;
flat in vec3  cM01;
flat in vec3  cM02;
flat in float cM11a;
flat in float cM12;
flat in float cM22;
flat in vec4  vCh2A;   // kind-0 chain mode: 2nd outline arc Q0,Q1 (shares the kind-4 aC1 slot)
flat in vec4  vCh2B;   // kind-0 chain mode: 2nd outline arc Q2,Q3 (aC2)
#endif
flat in vec2  cCen;
flat in float cScale;
flat in float cHalf;   // kind 7 annulus half-width
flat in float vEmPerPx; // em per device pixel — analytic ∇f for the line-edge ramps
flat in float vSeam;    // cubic morph clip / kind-10 end codes
flat in float vGradId;   // batched route: per-shape gradient id (0 = solid)
flat in float vImageId;  // batched route: per-shape image id (0 = none)
flat in vec4 vImgRect;   // batched route: per-shape image rect (em)
flat in vec4 vAtlasSlot; // batched route: per-shape atlas slot
flat in vec4  vShapeBB;
flat in vec2  vNa;      // kind-10 neighbour normal A / cubic morph clip normal A
flat in vec2  vNb;      // kind-10 neighbour normal B / cubic morph clip normal B
flat in vec3  vLine2;   // kind-0 second boundary line (thin strokes / corners)
flat in float vLineT;   // kind-0 corner type: +1 convex/stroke · −1 reflex · 0 none
flat in vec4  vColor;

uniform int   uDirect;   // 1 → emit premultiplied paint·coverage straight to
uniform float uAlpha;    //      the canvas (single-pass OVER); 0 → coverage only
// Direct-mode gradient: when uGradId>0 the paint is a GRADIENT sampled at the em
// position (a pure function of position, so it stays conflation-free under OVER
// like a solid color) instead of the flat vColor. uGradId defaults 0.
uniform int       uGradId;        // 0 = solid vColor · >0 = sample gradient at vEm
uniform vec4      uShapeBBox;      // em (x0,y0,x1,y1) for objectBoundingBox units
uniform sampler2D uGradientTex;   // per-gradient param records (4 texels/row)
@@BUNDLE_LAYOUT@@
uniform sampler2D uGradientStops; // packed-stops LUT (shared bundle texture)
// Top-level <image> fill: sample the atlas at the em position.
uniform int       uImageId;       // 0 = no image · >0 = sample uImageTex
uniform vec4      uImgRect;        // em (x,y,w,h) the image maps onto
uniform vec4      uAtlasSlot;      // (atlasY, atlasW, atlasH, kind/wrap) into uImageTex
uniform sampler2D uImageTex;       // RGBA8 image atlas
uniform vec2      uImageAtlasSize; // px dims of uImageTex
// Per-draw recolor (channel-lerp → color-matrix), coherent uniforms → free when
// disabled. Lets a SOLID recolored bundle (e.g. fog-tinted scenery) ride the
// one-draw combined route instead of the per-shape composite path (big draw-call
// cut). Palette-LUT recolor still routes per-shape (it needs a sampler).
uniform vec4 uChannelLerpPrimary;
uniform vec4 uChannelLerpContrast;
uniform vec4 uChannelLerpHighlight;
uniform int  uChannelLerpEnabled;
uniform mat4 uColorMatrix;
uniform vec4 uColorMatrixOffset;
uniform int  uColorMatrixEnabled;
out vec4 o;

// Straight-RGBA recolor, matching mantle.frag's fill recolor order (minus the
// palette LUT). Applied to the solid paint before premultiply.
vec4 lbRecolor(vec4 c) {
  if (uChannelLerpEnabled != 0) {
    vec3 tint = c.r * uChannelLerpPrimary.rgb + c.b * uChannelLerpContrast.rgb;
    float k = clamp(c.g + (1.0 - c.a), 0.0, 1.0);
    c = vec4(mix(tint, uChannelLerpHighlight.rgb, k), c.a);
  }
  if (uColorMatrixEnabled != 0) c = clamp(uColorMatrix * c + uColorMatrixOffset, 0.0, 1.0);
  return c;
}

@@GRADIENT_HELPERS@@

// spread 0=pad/1=reflect/2=repeat → extend 0=pad/1=repeat/2=reflect
int gradientSpreadToExtend(int spread) { return spread == 1 ? 2 : spread == 2 ? 1 : 0; }

// Premultiplied gradient color at em position — sampleGradient is shared verbatim
// with _coverage via @@PAINT_SAMPLE@@ (so the two can't drift). Needs the local
// gradientSpreadToExtend (above) + sampleStops (@@GRADIENT_HELPERS@@) declared first.
@@PAINT_SAMPLE@@

// straight RGBA atlas sample for a top-level <image> (mirrors _coverage's
// sampleTopLevelImage: clamp/repeat/mirror wrap, optional nearest snap).
vec4 sampleImageLB(vec2 emPos, vec4 imageRect, vec4 atlasSlot) {
  float u = (emPos.x - imageRect.x) / max(imageRect.z, 1e-6);
  float v = (emPos.y - imageRect.y) / max(imageRect.w, 1e-6);
  int kind = int(atlasSlot.w + 0.5) & 3;
  if (kind == 1) { u = fract(u); v = fract(v); }
  else if (kind == 3) { u = abs(fract(u * 0.5) - 0.5) * 2.0; v = abs(fract(v * 0.5) - 0.5) * 2.0; }
  else if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0.0);
  float aU = (u * atlasSlot.y) / max(uImageAtlasSize.x, 1.0);
  float aV = (atlasSlot.x + v * atlasSlot.z) / max(uImageAtlasSize.y, 1.0);
  if ((int(atlasSlot.w + 0.5) & 4) != 0) {
    aU = (floor(aU * uImageAtlasSize.x) + 0.5) / max(uImageAtlasSize.x, 1.0);
    aV = (floor(aV * uImageAtlasSize.y) + 0.5) / max(uImageAtlasSize.y, 1.0);
  }
  return texture(uImageTex, vec2(aU, aV));
}

// premultiplied paint·coverage (direct mode) or raw coverage (RT mode)
vec4 emit(float cov) {
  if (uDirect == 1) {
    vec4 paint;
    if (uImageId > 0) {
      vec4 t = sampleImageLB(vEm, uImgRect, uAtlasSlot) * vColor;          // tint by fill (1,1,1,opacity)
      paint = vec4(t.rgb * t.a, t.a);
    } else if (uGradId > 0) {
      vec4 g = sampleGradient(uGradId, vEm, uShapeBBox);                 // STRAIGHT (rgb, a) — premultiply here
      paint = vec4(g.rgb * g.a, g.a);
    } else if (vImageId > 0.5) {
      // BATCHED image: rect + atlas slot came from the per-shape paint texture, so a bundle
      // of many DIFFERENT images still draws in ONE call. Same sampleImageLB as the
      // per-shape path, tinted by the fill colour exactly as it is there.
      vec4 t = sampleImageLB(vEm, vImgRect, vAtlasSlot) * vColor;
      paint = vec4(t.rgb * t.a, t.a);
    } else if (vGradId > 0.5) {
      // BATCHED gradient: id + bbox came from the per-shape paint texture, so a bundle of
      // many DIFFERENT gradients still draws in ONE call. Same sampleGradient, so the
      // batched and per-shape paths cannot drift.
      vec4 g = sampleGradient(int(vGradId + 0.5), vEm, vShapeBB);
      paint = vec4(g.rgb * g.a, g.a);
    } else {
      vec4 f = lbRecolor(vColor);                                          // per-draw recolor (free when off)
      paint = vec4(f.rgb * f.a, f.a);                                      // premultiply solid
    }
    return paint * (uAlpha * cov);
  }
  return vec4(cov);
}

// Slug-identical straight-edge coverage from a local implicit f and its screen
// gradient. Slug (renderFill in _coverage) casts a horizontal AND a vertical
// ray through the pixel, takes a 1D box coverage on each — clamp(½ − c/|n|) at
// ray-crossing distance c/|n| — and blends them by a centre-proximity weight,
// with a min() floor. A single perpendicular clamp(½ − c) only reproduces the
// axis-aligned case; this reproduces every angle (slope √2 at 45°), so LB's AA
// ramp matches Slug's byte-for-byte on straight edges instead of the too-soft,
// angle-independent perpendicular ramp. f>0 = outside the fill.
@@BOX_COV@@

// Coverage of a locally-straight edge, from the implicit f and its screen gradient.
// f > 0 is OUTSIDE the fill, so the fill is {p : f + ∇f·p <= 0} = {n·p <= -f/|∇f|}.
// The exact box area (~10 flops) is near-exact at every angle; a blended pair of 1D
// axis-ray coverages is exact only for axis-aligned edges (mean 10.6/255 error at 45°).
float slugCov(float f, vec2 grad) {
  float g = max(length(grad), 1e-6);
  return exactBoxCov(grad / g, -f / g);
}

// Curve coverage: exact box area of the tangent half-plane, plus a mean
// curvature bias (κ/24) so convex bowls don't solid-fill the inner AA fringe.
// κ is the screen-space level-set curvature (∇²f projected); for an outward
// gradient (f>0 outside) a convex outline has κ>0 and the correction pulls
// coverage back toward the true arc. Cubic circles use the kind-7 SDF path;
// general quadratic outlines still use this correction.
float curveCov(float f, float fx, float fy, float fxx, float fyy, float fxy) {
  vec2 grad = vec2(fx, fy);
  float g = max(length(grad), 1e-6);
  float kPx = (fxx * fy * fy - 2.0 * fxy * fx * fy + fyy * fx * fx) / (g * g * g);
  // Clamp: huge κ at degenerate gradients is noise, not geometry.
  kPx = clamp(kPx, -2.0, 2.0);
  return exactBoxCov(grad / g, -f / g - kPx / 24.0);
}



void main() {
  // Edge cap-strip (kind 10): the exterior band + BOTH end wedges of one straight edge,
  // with three-feature chained box coverage (prev tangent+κ · own line · next tangent+κ).
  // End partitions are watertight: a LINE neighbour shares the bisector plane
  // w = perp(n̂N + n̂Own) (canonicalized along the edge; START keeps ≥0, END keeps <0 — the
  // neighbour computes the identical plane with the complementary rule); a CURVE neighbour
  // partitions at the arc's tangent plane, complementary to the kind-12 band's span clip.
  // Fragments whose CENTER is inside the fill (chained step test) are the interior mesh's
  // turf. Pixels cut by several features (short edges, acute tips, shallow joints) get the
  // exact combined coverage no single-feature owner could produce.
  if (vKind > 9.5 && vKind < 10.5) {
    vec2 p1k = cCen, p2k = vec2(cScale, cHalf);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-9);
    vec2 nOwn = vec2(-tdk.y, tdk.x) * vSign;
    float fOwn = dot(nOwn, vEm - p1k);
    float codeA = floor((vSeam + 0.5) / 16.0), codeB = vSeam - codeA * 16.0;
    float tyA = floor((codeA + 0.5) / 4.0) - 1.0; bool curveA = mod(codeA, 4.0) >= 1.5;
    float tsA = mod(codeA, 2.0);
    float tyB = floor((codeB + 0.5) / 4.0) - 1.0; bool curveB = mod(codeB, 4.0) >= 1.5;
    float tsB = mod(codeB, 2.0);
    vec2 rA = vEm - p1k, rB = vEm - p2k;
    vec2 wA, wB;
    if (curveA) { wA = vec2(-vNa.y, vNa.x) * (tsA > 0.5 ? 1.0 : -1.0);   // exact into-arc dir
      // cede to the arc's kind-12 only NEAR the corner: a concave arc's tangent points
      // back over this very edge, and an unbounded cession would discard the whole strip.
      // But NEVER cede our own ½-coverage row (|fOwn| within the working band): the arc's
      // band f-discards its fill side, so a raster-tie pixel ON our edge line ceded here
      // has no painter left (dead 0.50 ties at the edge→curve junction).
      if (dot(rA, wA) >= 0.0 && length(rA) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else {
      // Line neighbour. Acute tips (nOwn·nN < −0.35): bisector |nOwn+nN| collapses —
      // START owns the exterior tip bulb (no bisector cull there); END cedes it.
      float nDotA = dot(nOwn, vNa);
      bool acuteA = tyA > 0.5 && nDotA < -0.35;
      vec2 sumA = nOwn + vNa;
      bool degenA = dot(sumA, sumA) < 0.08;
      bool tipA = acuteA && fOwn > 0.0 && length(rA) < 2.2 * vEmPerPx;
      if (!(tipA && (acuteA || degenA))) {
        wA = degenA ? vec2(-nOwn.y, nOwn.x) : vec2(-sumA.y, sumA.x);
        if (dot(wA, tdk) < 0.0) wA = -wA;
        if (dot(rA, wA) < 0.0) discard;
      }
    }
    if (curveB) { wB = vec2(-vNb.y, vNb.x) * (tsB > 0.5 ? 1.0 : -1.0);
      if (dot(rB, wB) >= 0.0 && length(rB) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else {
      float nDotB = dot(nOwn, vNb);
      bool acuteB = tyB > 0.5 && nDotB < -0.35;
      // END yields the acute tip bulb to the neighbour edge's START — but ONLY
      // fragments on the NEIGHBOUR'S exterior side. The neighbour's tip handler
      // claims fOwn>0 (its own exterior), so the sliver that is outside OUR
      // line yet inside the neighbour's (fOwn>0 here, dot(vNb,rB)<0) had no
      // painter left: one dead 46%-coverage pixel at every sufficiently acute
      // line-line corner (y's arm top-left, ref 139 vs LB 255).
      if (acuteB && fOwn > 0.0 && dot(vNb, rB) > 0.0 && length(rB) < 2.2 * vEmPerPx) discard;
      else {
        vec2 sumB = nOwn + vNb;
        bool degenB = dot(sumB, sumB) < 0.08;
        wB = degenB ? vec2(-nOwn.y, nOwn.x) : vec2(-sumB.y, sumB.x);
        if (dot(wB, tdk) < 0.0) wB = -wB;
        if (dot(rB, wB) >= 0.0) discard;
      }
    }
    float fA = dot(vNa, rA) - 0.5 * vTC.y * dot(rA, rA);
    float fB = dot(vNb, rB) - 0.5 * vTC.z * dot(rB, rB);
    // PROXIMITY GATE: a neighbour's boundary exists only from its corner onward (along the
    // packed into-neighbour direction) — its field is meaningless elsewhere on our edge.
    // Ungated, a REFLEX neighbour's half-plane covers most of the edge: the union formula
    // saturated mid-edge pixels to 1 and the inside-test discarded them wholesale. Fade in
    // over ~0.8px around the corner; when gated out, convex ends read inert-1 (intersection
    // identity) and reflex ends inert-0 (union identity).
    // Acute tips keep the neighbour field live farther so intersecting-lines covers the bulb.
    float tipGateA = (tyA > 0.5 && !curveA && dot(nOwn, vNa) < -0.35) ? 2.2 : 2.0;
    float tipGateB = (tyB > 0.5 && !curveB && dot(nOwn, vNb) < -0.35) ? 2.2 : 2.0;
    float gA = clamp((tipGateA - length(rA) / vEmPerPx) / 1.5, 0.0, 1.0);
    float gB = clamp((tipGateB - length(rB) / vEmPerPx) / 1.5, 0.0, 1.0);
    // Deep inside own line is ALWAYS the interior mesh's turf — the corner chain below may
    // misclassify real fill as "outside the corner intersection" (a convex end's tangent
    // half-plane doesn't bound the fill mid-stem) and double-paint over the interior ramp.
    if (fOwn < -1.2 * vEmPerPx) discard;
    float sOwn = fOwn < -0.012 * vEmPerPx ? 1.0 : 0.0;
    float sA = fA < 0.0 ? 1.0 : 0.0, sB = fB < 0.0 ? 1.0 : 0.0;
    float sAe = tyA > 0.5 ? (gA > 0.01 ? sA : 1.0) : (gA > 0.01 ? sA : 0.0);
    float sBe = tyB > 0.5 ? (gB > 0.01 ? sB : 1.0) : (gB > 0.01 ? sB : 0.0);
    float insid = sOwn;
    insid = tyA > 0.5 ? min(insid, sAe) : (tyA < -0.5 ? max(insid, sAe) : insid);
    insid = tyB > 0.5 ? min(insid, sBe) : (tyB < -0.5 ? max(insid, sBe) : insid);
    if (insid > 0.5) discard;
    // Corner coverage via the EXACT two-plane box area (exactBoxCov2), the same
    // kernel kind-0 uses: intersection (convex/tip) and union (reflex) of the own
    // and neighbour half-planes are computed directly, so acute tips, near-parallel
    // continuations and nested cuts all fall out of one formula — no per-case
    // covA+covB−1 / min / kp-mix interpolation. The gA/gB proximity gate keeps its
    // original coverage-space semantics: the exact combined result blends back to
    // the ungated own coverage away from the corner, where the neighbour's
    // boundary does not exist. Chained ends compose by inclusion–exclusion
    // against the pristine own coverage (exact when only one end is near, the
    // common case).
    float invPx10 = 1.0 / max(vEmPerPx, 1e-12);
    float dOwn10 = -fOwn * invPx10;
    float c10 = exactBoxCov(nOwn, dOwn10);
    float cOwnP10 = c10;
    if (abs(tyA) > 0.5) {
      vec2 nA10 = vNa / max(length(vNa), 1e-9);
      float dA10 = -fA * invPx10;
      float cA10 = exactBoxCov(nA10, dA10);
      float interA = exactBoxCov2(nOwn, dOwn10, nA10, dA10);
      float kpA = max(0.0, dot(nOwn, vNa));
      float exA = tyA > 0.0
        ? mix(clamp(c10 + interA - cOwnP10, 0.0, 1.0), min(c10, cA10), kpA)
        : mix(clamp(c10 + cA10 - interA, 0.0, 1.0), max(c10, cA10), kpA);
      c10 = mix(c10, exA, gA);
    }
    if (abs(tyB) > 0.5) {
      vec2 nB10 = vNb / max(length(vNb), 1e-9);
      float dB10 = -fB * invPx10;
      float cB10 = exactBoxCov(nB10, dB10);
      float interB = exactBoxCov2(nOwn, dOwn10, nB10, dB10);
      float kpB = max(0.0, dot(nOwn, vNb));
      float exB = tyB > 0.0
        ? mix(clamp(c10 + interB - cOwnP10, 0.0, 1.0), min(c10, cB10), kpB)
        : mix(clamp(c10 + cB10 - interB, 0.0, 1.0), max(c10, cB10), kpB);
      c10 = mix(c10, exB, gB);
    }
    // KIND-10 CLAIM RULE (the depth-claim contract): an edge strip fragment
    // that emits ~nothing must not WRITE DEPTH — its zero-coverage zones (the
    // chained-corner union/intersection identities) would otherwise claim
    // junction pixels at the piece tier and reject the interior's full
    // coverage beneath, punching holes at stem junctions.
    if (c10 < 0.004) discard;
    // Exterior-band contract (same as Loop strip vs interior split):
    // fill-side partials are the interior mesh's turf (kind-0 inner ramp). Painting
    // them here WRITES DEPTH and rejects solid interior — acute tips (N/V/Z) and
    // stem junctions read as hard underfills (Slug/legacy solid ink, band empty).
    // Deep fill-side (cov≈1) stays: 1-over-1 is exact either way.
    if (fOwn < 0.0 && c10 < 0.999) discard;
    o = emit(c10);
    return;
  }
#ifndef MANTLE_NO_BEZOUT
  // Unified curve band (kind 12): quads/rquads and cubic exterior rings.
  // Quad: aTC=(Ũ,Ṽ,R). Cubic (|vSign|≥8192): aTC=(k,l,m), Δklm via aC0 packHalf;
  // optional end chaining when aC3=(a,b) is packed.
  if (vKind > 11.5 && vKind < 12.5) {
    float mag12 = abs(vSign);
    float s12 = vSign >= 0.0 ? 1.0 : -1.0;
    bool cubic12 = false;
    if (mag12 >= 8192.0) { cubic12 = true; mag12 -= 8192.0; }
    if (mag12 >= 4096.0) mag12 -= 4096.0;
    float spanB12 = 0.0, spanA12 = 0.0;
    if (mag12 >= 2048.0) { spanB12 = 1.0; mag12 -= 2048.0; }
    if (mag12 >= 1024.0) { spanA12 = 1.0; mag12 -= 1024.0; }
    float codeA = floor((mag12 + 0.5) / 16.0), codeB = mag12 - codeA * 16.0;
    float tyA = floor((codeA + 0.5) / 4.0) - 1.0; bool curveA = mod(codeA, 4.0) >= 1.5;
    float tyB = floor((codeB + 0.5) / 4.0) - 1.0; bool curveB = mod(codeB, 4.0) >= 1.5;
    vec2 a12 = cCen, b12 = vec2(cScale, cHalf);
    vec2 rA = vEm - a12, rB = vEm - b12;
    vec2 nA12 = cM01.yz, nB12 = cM02.xy;
    // aC2 = (packHalf(nOwnA), packHalf(nOwnB), κA, κB) — κ mixed for morph pairs.
    vec2 nOA = unpackHalf2x16(floatBitsToUint(cM02.z));
    vec2 nOB = unpackHalf2x16(floatBitsToUint(cM11a));
    float kA12 = cM12, kB12 = cM22;
    bool ends12 = cubic12 && dot(a12, a12) + dot(b12, b12) > 0.0;
    if (cubic12 && !ends12) {
      float k12 = vTC.x, l12 = vTC.y, m12 = vTC.z;
      float f12c = s12 * (k12 * k12 * k12 - l12 * m12);
      vec3 tx12c = dFdx(vTC), ty12c = dFdy(vTC);
      float fx12c = s12 * (3.0 * k12 * k12 * tx12c.x - (tx12c.y * m12 + l12 * tx12c.z));
      float fy12c = s12 * (3.0 * k12 * k12 * ty12c.x - (ty12c.y * m12 + l12 * ty12c.z));
      float fxx12c = s12 * (6.0 * k12 * tx12c.x * tx12c.x - 2.0 * tx12c.y * tx12c.z);
      float fyy12c = s12 * (6.0 * k12 * ty12c.x * ty12c.x - 2.0 * ty12c.y * ty12c.z);
      float fxy12c = s12 * (6.0 * k12 * tx12c.x * ty12c.x - (tx12c.y * ty12c.z + ty12c.y * tx12c.z));
      float c12c = curveCov(f12c, fx12c, fy12c, fxx12c, fyy12c, fxy12c);
      if (c12c < 0.999 && f12c < 0.0) discard;
      if (c12c < 0.004) discard;
      o = emit(c12c);
      return;
    }
    // Hull turf (integral R≡1): UV image of the control triangle is FIXED —
    // (0,0),(½,0),(1,1) — inside test is pure uv barycentrics. Rational bands skip
    // this (homogeneous image ≠ that triangle); footprint + claim rules trim instead.
    float u12 = vTC.x, v12 = vTC.y, r12 = vTC.z;
    if (!cubic12 && abs(r12 - 1.0) < 1e-3 && v12 >= 0.0 && u12 >= v12 && 1.0 - 2.0 * u12 + v12 >= 0.0) discard;
    vec2 sA12 = vec2(-nOA.y, nOA.x) * (spanA12 > 0.5 ? 1.0 : -1.0);   // into-arc tangent at a
    vec2 sB12 = vec2(-nOB.y, nOB.x) * (spanB12 > 0.5 ? 1.0 : -1.0);   // into-arc tangent at b
    // Own field: quad f = Ũ²−Ṽ·R; cubic f = k³−lm. Curvature-aware coverage.
    float f12, fx12, fy12, fxx12, fyy12, fxy12;
    if (cubic12) {
      float k12 = u12, l12 = v12, m12 = r12;
      f12 = s12 * (k12 * k12 * k12 - l12 * m12);
      vec3 tx12 = dFdx(vTC), ty12 = dFdy(vTC);
      fx12 = s12 * (3.0 * k12 * k12 * tx12.x - (tx12.y * m12 + l12 * tx12.z));
      fy12 = s12 * (3.0 * k12 * k12 * ty12.x - (ty12.y * m12 + l12 * ty12.z));
      fxx12 = s12 * (6.0 * k12 * tx12.x * tx12.x - 2.0 * tx12.y * tx12.z);
      fyy12 = s12 * (6.0 * k12 * ty12.x * ty12.x - 2.0 * ty12.y * ty12.z);
      fxy12 = s12 * (6.0 * k12 * tx12.x * ty12.x - (tx12.y * ty12.z + ty12.y * tx12.z));
    } else {
      f12 = s12 * (u12 * u12 - v12 * r12);
      vec3 tx12 = dFdx(vTC), ty12 = dFdy(vTC);
      fx12 = s12 * (2.0 * u12 * tx12.x - (tx12.y * r12 + v12 * tx12.z));
      fy12 = s12 * (2.0 * u12 * ty12.x - (ty12.y * r12 + v12 * ty12.z));
      fxx12 = s12 * (2.0 * tx12.x * tx12.x - 2.0 * tx12.y * tx12.z);
      fyy12 = s12 * (2.0 * ty12.x * ty12.x - 2.0 * ty12.y * ty12.z);
      fxy12 = s12 * (2.0 * tx12.x * ty12.x - (tx12.y * ty12.z + ty12.y * tx12.z));
    }
    float dpx12 = f12 / max(length(vec2(fx12, fy12)), 1e-6);   // signed px distance to the arc
    // END PARTITIONS + CORNER COVERAGE (Loop §5.1 geometry, Mantle exactBoxCov AA).
    //
    // Packer sets |type|>0 only for sharp banded-curve neighbours (chain). Line ends
    // stay type 0 → span-clip, matching kind-12 and complementary to kind-10's cession
    // at the arc tangent plane. Chaining line ends through a bisector∩line combine
    // under-covered tip bulbs outside the line half-plane but on the arc exterior.
    //
    // Partition: watertight bisector perp(nOwn+nN) when normals are not antiparallel
    // (|nOwn+nN|²→0); else own span. In-span own model: Loop f → curveCov.
    // Wedge own model: osculating line (quadratic extrapolation wraps).
    // Corner coverage: intersecting-lines combine (kind-10/12) via slugCov.
    bool chainA = abs(tyA) > 0.5, chainB = abs(tyB) > 0.5;
    if (!chainA) { if (dot(rA, sA12) < 0.0) discard; }
    else {
      vec2 bisA = nOA + nA12;
      if (dot(bisA, bisA) > 1e-6) {
        vec2 wA12 = vec2(-bisA.y, bisA.x);
        if (dot(rA, wA12) * dot(wA12, sA12) < 0.0) discard;
      } else if (dot(rA, sA12) < 0.0) discard;
    }
    if (!chainB) { if (dot(rB, sB12) < 0.0) discard; }
    else {
      vec2 bisB = nOB + nB12;
      if (dot(bisB, bisB) > 1e-6) {
        vec2 wB12 = vec2(-bisB.y, bisB.x);
        if (dot(rB, wB12) * dot(wB12, sB12) <= 0.0) discard;
      } else if (dot(rB, sB12) < 0.0) discard;
    }
    bool wgA = chainA && dot(rA, sA12) < 0.0;
    bool wgB = chainB && dot(rB, sB12) < 0.0;
    // Own boundary as a box-coverage PLANE (normal + pixel offset): in-span, the
    // curvature-adjusted tangent curveCov integrates (same offset −f/|∇f| − κ/24);
    // in a wedge, the osculating line. Keeping the plane form (not just its
    // coverage) lets the end combine below use the exact two-plane box area.
    float fA12 = dot(nA12, rA) - 0.5 * kA12 * dot(rA, rA);
    float fB12 = dot(nB12, rB) - 0.5 * kB12 * dot(rB, rB);
    float gL12 = max(length(vec2(fx12, fy12)), 1e-6);
    float kOwnS12 = (fxx12 * fy12 * fy12 - 2.0 * fxy12 * fx12 * fy12 + fyy12 * fx12 * fx12) / (gL12 * gL12 * gL12);
    float kOwnPx = abs(kOwnS12);
    float invPx12 = 1.0 / max(vEmPerPx, 1e-12);
    float fOwn12;
    vec2 nOwn12;
    float dOwn12;
    if (wgA || wgB) {
      vec2 nOw = wgA ? nOA : nOB;
      vec2 rw = wgA ? rA : rB;
      float nOwL = max(length(nOw), 1e-9);
      fOwn12 = dot(nOw, rw);
      nOwn12 = nOw / nOwL;
      dOwn12 = -fOwn12 / (nOwL * max(vEmPerPx, 1e-12));
    } else {
      fOwn12 = f12;
      nOwn12 = vec2(fx12, fy12) / gL12;
      dOwn12 = -f12 / gL12 - clamp(kOwnS12, -2.0, 2.0) / 24.0;
    }
    float cOwn12 = exactBoxCov(nOwn12, dOwn12);
    float rgA12 = 0.5 / max(max(abs(kA12), 1e-6) * vEmPerPx, max(kOwnPx, 1e-6));
    float rgB12 = 0.5 / max(max(abs(kB12), 1e-6) * vEmPerPx, max(kOwnPx, 1e-6));
    float gA12 = clamp(rgA12 - length(rA) / vEmPerPx, 0.0, 1.0);
    float gB12 = clamp(rgB12 - length(rB) / vEmPerPx, 0.0, 1.0);
    bool cnA = abs(tyA) > 0.5, cnB = abs(tyB) > 0.5;
    float sOwn12 = fOwn12 < 0.0 ? 1.0 : 0.0;
    float sA12i = fA12 < 0.0 ? 1.0 : 0.0, sB12i = fB12 < 0.0 ? 1.0 : 0.0;
    float sAe12 = tyA > 0.5 ? (gA12 > 0.0 ? sA12i : 1.0) : (gA12 > 0.0 ? sA12i : 0.0);
    float sBe12 = tyB > 0.5 ? (gB12 > 0.0 ? sB12i : 1.0) : (gB12 > 0.0 ? sB12i : 0.0);
    float insid12 = sOwn12;
    if (cnA) insid12 = tyA > 0.5 ? min(insid12, sAe12) : max(insid12, sAe12);
    if (cnB) insid12 = tyB > 0.5 ? min(insid12, sBe12) : max(insid12, sBe12);
    if (insid12 > 0.5) discard;
    // End combine: exact two-plane box area (see kind-10) — intersection for
    // convex chains, union for reflex, neighbour plane gated to its inert
    // identity away from the corner, inclusion–exclusion for chained ends.
    // End combine. Two models per end, selected by normal parallelism kp:
    // nearly-parallel normals mean the neighbour plane is the SAME boundary the
    // own field already integrates (a tangent-continuous continuation) — min /
    // max is the one-boundary answer, and intersecting the two planes would
    // double-cut the pixel. Genuinely distinct normals mean a real corner —
    // there the EXACT two-plane box area (exactBoxCov2) replaces the old
    // covA+covB−1 approximation, which overcounts acute tips. The gA/gB
    // proximity gate blends the whole result back to the own coverage away
    // from the corner; chained ends compose by inclusion–exclusion against the
    // pristine own coverage.
    float c12 = cOwn12;
    if (cnA) {
      vec2 nAn12 = nA12 / max(length(nA12), 1e-9);
      float dA12 = -fA12 * invPx12;
      float cA12 = exactBoxCov(nAn12, dA12);
      float interA12 = exactBoxCov2(nOwn12, dOwn12, nAn12, dA12);
      float kpA12 = max(0.0, dot(nOA, nA12));
      float exA12 = tyA > 0.0
        ? mix(clamp(c12 + interA12 - cOwn12, 0.0, 1.0), min(c12, cA12), kpA12)
        : mix(clamp(c12 + cA12 - interA12, 0.0, 1.0), max(c12, cA12), kpA12);
      c12 = mix(c12, exA12, gA12);
    }
    if (cnB) {
      vec2 nBn12 = nB12 / max(length(nB12), 1e-9);
      float dB12 = -fB12 * invPx12;
      float cB12 = exactBoxCov(nBn12, dB12);
      float interB12 = exactBoxCov2(nOwn12, dOwn12, nBn12, dB12);
      float kpB12 = max(0.0, dot(nOB, nB12));
      float exB12 = tyB > 0.0
        ? mix(clamp(c12 + interB12 - cOwn12, 0.0, 1.0), min(c12, cB12), kpB12)
        : mix(clamp(c12 + cB12 - interB12, 0.0, 1.0), max(c12, cB12), kpB12);
      c12 = mix(c12, exB12, gB12);
    }
    if (c12 <= 0.0) discard;
    /* In-span exterior-band contract: fill-side partials are interior turf.
       Wedges use the two-plane ownership test above instead. */
    if (!wgA && !wgB && f12 < 0.0 && c12 < 0.999) discard;
    /* Counter-hole chord ribbons extrude into the empty region; UV
       extrapolation can then paint mid-gray far past the arc while dpx still
       reads "near". Gate on s12<0: nested counters use sign -1 when ink sits
       on the control side; outer bowls keep their bulge AA past the chord. */
    if (!wgA && !wgB && fOwn12 >= 0.0 && s12 < 0.0) {
      vec2 ab = b12 - a12;
      float abL2 = max(dot(ab, ab), 1e-12);
      float t = clamp(dot(rA, ab) / abL2, 0.0, 1.0);
      float dChord = length(rA - ab * t) / max(vEmPerPx, 1e-9);
      if (dChord > 1.5 && abs(dpx12) < 1.0) discard;
      if (dChord > 1.2 && abs(dpx12) < 0.7 && c12 < 0.95) discard;
    }
    /* Near-zero exterior coverage that conflicts with a neighboring linear
       interior can still reject solid interior. Keep this threshold below the
       AA midpoint so ordinary exterior ramps continue to paint. */
    if (!wgA && !wgB && fOwn12 >= 0.0 && c12 < 0.12) {
      if (gA12 > 0.0 && dot(nA12, rA) < 0.0) discard;
      if (gB12 > 0.0 && dot(nB12, rB) < 0.0) discard;
    }
    o = emit(c12);
    return;
  }
#endif
  // KIND 13 — THIN CHAIN STRIP: a ±band quad hugging one outline edge, carrying
  // that edge's local chain (P0=cCen, P1=(cScale,cHalf), P2=vLine2.xy,
  // P3=(vLine2.z,vLineT)). Analytic poly-clip coverage, exact per-edge; piece tier
  // rejects the solid coarse interior where it draws. (probes/_polyClipAB.mjs)
  if (vKind > 12.5 && vKind < 13.5) {
    float invE = 1.0 / max(vEmPerPx, 1e-12);
    vec2 c0 = (cCen - vEm) * invE;
    vec2 c1 = (vec2(cScale, cHalf) - vEm) * invE;
    vec2 c2 = (vLine2.xy - vEm) * invE;
    vec2 c3 = (vec2(vLine2.z, vLineT) - vEm) * invE;
    o = emit(chainBoxCov(c0, c1, c2, c3, c3, 0.0));   // strips: 4 pts, exterior-aware miss
    return;
  }
  // Interior triangle: solid, unless it carries a straight boundary-edge line
  // (cCen,cScale from aC3) — then ramp the INNER AA half across it with the same
  // Slug dual-ray coverage the outward strip uses for the outer half (f>0 outside).
  // They meet at ½ on the edge → a centered analytic ramp with no interior inset.
  if (vKind < 0.5) {
    // ANALYTIC POLY-CLIP (vTC.x = 2 sentinel): the four flat slots carry the
    // triangle's local outline chain as POINTS (P0=cCen, P1=(cScale,cHalf),
    // P2=vLine2.xy, P3=(vLine2.z,vLineT)). Map each into the pixel cell with an
    // ISOTROPIC em→px scale (length of the screen-x derivative of vEm) — matches
    // the baseline slugCov's isotropic model and avoids the Jacobian cross-terms.
    // Then clip: exact coverage, no corner-type combos.
    if (vTC.x > 1.5) {
      float invE = 1.0 / max(vEmPerPx, 1e-12);   // ANALYTIC scale — dFdx blows up on thin CDT faces
      vec2 c0 = (cCen - vEm) * invE;
      vec2 c1 = (vec2(cScale, cHalf) - vEm) * invE;
      vec2 c2 = (vLine2.xy - vEm) * invE;
      vec2 c3 = (vec2(vLine2.z, vLineT) - vEm) * invE;
      vec2 c4 = (vTC.yz - vEm) * invE;                      // P4 (aTC.yz)
      // CONIC mode (sentinel 3): the same five slots are TWO quadratic Bézier
      // segments p0–c1→p2 –c3→p4 rather than four straight ones, so a whole
      // glyph arc is represented EXACTLY — no sagitta to trade against reach.
      // The builder picks per face: conic where the face's boundary is ≤2
      // pieces and any is curved, straight-chain otherwise (a straight-heavy
      // face keeps all four of its segments).
      float cov = vTC.x > 2.5
        ? conicChainBoxCov(c0, c1, c2, c3, c4, 2.0)
        : chainBoxCov(c0, c1, c2, c3, c4, 2.0);   // own chain: linear-miss mode
#ifndef MANTLE_NO_BEZOUT
      // A coarse face can reach a SECOND, disconnected outline arc that chain 1
      // cannot represent; without this its fragments miss and fill solid. Chain 2
      // bounds the fill from that side, so the local fill is the INTERSECTION of
      // the two — min() is exact when only one arc crosses the box (the common
      // case, the other returning 1) and a tight upper bound when both do.
      // All-zero chain 2 ⇒ degenerate segments ⇒ 1.0 ⇒ min() changes nothing.
      if (any(notEqual(vCh2A, vec4(0.0))) || any(notEqual(vCh2B, vec4(0.0)))) {
        vec2 d0 = (vCh2A.xy - vEm) * invE;
        vec2 d1 = (vCh2A.zw - vEm) * invE;
        vec2 d2 = (vCh2B.xy - vEm) * invE;
        vec2 d3 = (vCh2B.zw - vEm) * invE;
        cov = min(cov, chainBoxCov(d0, d1, d2, d3, d3, 1.0));
      }
#endif
      o = emit(cov);
      return;
    }
    if (dot(cCen, cCen) > 1e-9) {
      float fi = dot(cCen, vEm) - cScale;
      // ∇fi ANALYTICALLY, not dFdx(fi). cCen is the flat unit edge normal, so ∇fi is
      // exactly cCen scaled to pixels (1/emPerPx). dFdx(fi) instead reads across the
      // 2×2 derivative quad — and at a sharp corner the CDT fans thin SLIVER
      // triangles whose helper pixels extrapolate garbage, blowing up the gradient
      // so slugCov collapses to ~0. That erodes the fill along the sliver: a "linear
      // cut" / diagonal slash across the glyph on real GPUs;
      // SwiftShader masks it. Analytic ∇fi is identical inside a triangle but immune.
      float cA = slugCov(fi, cCen * vEmPerPx);
      // SECOND boundary line (vLine2 = nx,ny,c; vLineT = corner type). A pixel box cut by
      // TWO lines — a thin stroke (both stroke edges in one box) or a corner — needs the
      // combined coverage, not one line's. Use exact two-plane box area (exactBoxCov2):
      // covA+covB−1 overcounts acute tips where the true box area is partial.
      // Convex/stroke (fill = intersection): area(A∩B); reflex (fill = union): A∪B.
      if (abs(vLineT) > 0.5) {
        float fiB = dot(vLine2.xy, vEm) - vLine2.z;
        float cB = slugCov(fiB, vLine2.xy * vEmPerPx);
        float invPx = 1.0 / max(vEmPerPx, 1e-12);
        float inter = exactBoxCov2(cCen, -fi * invPx, vLine2.xy, -fiB * invPx);
        cA = vLineT > 0.0 ? inter : (cA + cB - inter);
      }
      // THIRD line (vTC.xyz; type in cHalf): sliver faces can be cut by three edges. Far →
      // saturates → inert under the same chain. Approximate chain with the cheap formula
      // once the dominant pair is exact (third edges are usually near-orthogonal stems).
      if (abs(cHalf) > 0.5 && dot(vTC.xy, vTC.xy) > 1e-9) {
        float cC = slugCov(dot(vTC.xy, vEm) - vTC.z, vTC.xy * vEmPerPx);
        cA = cHalf > 0.0 ? max(0.0, cA + cC - 1.0) : cA + cC - cA * cC;
      }
      o = emit(cA);
    } else o = emit(1.0);
    return;
  }

  float f;
  vec2 f4gEm = vec2(0.0);
  bool f4has = false;
  if (vKind < 2.5) {
    // Cubic (Loop-Blinn klmn, p1000-loop §4.4): k,l,m interpolated in vTC;
    // implicit f = k³ − l·m (n≡1 for integral cubics). ~3 mul + 1 sub.
    // (kind 0 returned above, so vKind < 2.5 here means kind 2.)
    f = vSign * (vTC.x * vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 4.5) {
#ifndef MANTLE_NO_BEZOUT
    // Cubic-bezout fallback (cusp / d1≈0): exact 3×3 Bezout determinant.
    vec2 n = (vEm - cCen) / cScale;
    float lin02 = cM02.y * n.x + cM02.z * n.y;   // M02, M11 share m02's (b,c)
    float M00 = cM00.x + dot(cM00.yz, n);
    float M01 = cM01.x + dot(cM01.yz, n);
    float M02 = cM02.x + lin02;
    float M11 = cM11a  + lin02;
    float det = M00 * (M11 * cM22 - cM12 * cM12)
              - M01 * (M01 * cM22 - cM12 * M02)
              + M02 * (M01 * cM12 - M11 * M02);
    f = vSign * det;
    // EXACT gradient via cofactor differentiation (the det is an analytic cubic in n;
    // dFdx(f) is a per-quad constant approximation whose error IS the kind-4 AA
    // wobble). M12/M22 constant; M02 and M11 share lin02's linear part.
    float d00 = M11 * cM22 - cM12 * cM12;
    float d01 = -2.0 * M01 * cM22 + 2.0 * M02 * cM12;
    float d02 = 2.0 * M01 * cM12 - 2.0 * M02 * M11;
    float d11 = M00 * cM22 - M02 * M02;
    vec2 gN = d00 * cM00.yz + d01 * cM01.yz + (d02 + d11) * cM02.yz;
    f4gEm = vSign * gN / cScale;
    f4has = true;
#else
    // LEAN variant: no kind-4 verts exist in a Bezout-free mesh — unreachable.
    f = 1.0;
#endif
  } else if (vKind < 5.5) {
    // Rational quadratic (arc, Loop-Blinn §3.2): homogeneous texcoords
    // vTC = (Ũ,Ṽ,R); implicit f = Ũ²−Ṽ·R (integral quad is the R≡1 case). Exact
    // for elliptical arcs — no cubic approximation. Cheap: 2 mul + 1 sub.
    // |vSign| == 3 flags a LONE CRESCENT (no kind-0 interior in this mesh) — the
    // sign-magnitude idiom kind 12 uses; take only its sign for the implicit.
    f = (vSign > 0.0 ? 1.0 : -1.0) * (vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 7.5) {
    // Circular / annulus / elliptical SDF (kind 7; legacy kind 6 still accepted).
    // Ellipse (cHalf < −1.5): aC0=(ry,cosφ,sinφ), cScale=rx — unit-circle pullback.
    // Disc (−1.5 ≤ cHalf < 0, or legacy kind 6): f = |p−C| − r.
    // Ring (cHalf ≥ 0): f = ||p−C| − rMid| − halfW; one primitive, no wedges.
    //
    // ANALYTIC gradient + curvature (no dFdx of f): every level set here is a
    // circle/ellipse through the fragment, so ∇f and the (rank-1) Hessian
    // H = w·WWᵀ are closed-form. Feeding them into the same curvature-aware
    // coverage the curve kinds use removes the tangent-line over-coverage on
    // the inner fringe of small/high-curvature discs — the correction the
    // first-order slugCov path could not express.
    vec2 d7 = vEm - cCen;
    vec2 G7, W7;
    float w7;
    if (cHalf < -1.5) {
      float rx7 = max(cScale, 1e-9), ry7 = max(vNa.x, 1e-9);
      float c7 = vNa.y, s7 = vNb.x;
      vec2 q7 = vec2((d7.x * c7 + d7.y * s7) / rx7, (-d7.x * s7 + d7.y * c7) / ry7);
      float Lq7 = max(length(q7), 1e-9);
      f = vSign * (Lq7 - 1.0);
      vec2 qh7 = q7 / Lq7, th7 = vec2(-qh7.y, qh7.x);
      G7 = vSign * vec2(qh7.x * c7 / rx7 - qh7.y * s7 / ry7, qh7.x * s7 / rx7 + qh7.y * c7 / ry7);
      W7 = vec2(th7.x * c7 / rx7 - th7.y * s7 / ry7, th7.x * s7 / rx7 + th7.y * c7 / ry7);
      w7 = vSign / Lq7;
    } else {
      float L7 = max(length(d7), 1e-9);
      vec2 dh7 = d7 / L7;
      float sig7 = 1.0, halfW7 = 0.0;
      if (vKind > 6.5 && cHalf >= 0.0) { sig7 = L7 >= cScale ? 1.0 : -1.0; halfW7 = cHalf; }
      f = vSign * (sig7 * (L7 - cScale) - halfW7);
      G7 = (vSign * sig7) * dh7;
      W7 = vec2(-dh7.y, dh7.x);
      w7 = vSign * sig7 / L7;
    }
    // Chain rule through the affine em→px map: dFdx(vEm) is the exact
    // per-primitive Jacobian column (vEm is affine in screen space).
    vec2 emx7 = dFdx(vEm), emy7 = dFdy(vEm);
    float fx7 = dot(G7, emx7), fy7 = dot(G7, emy7);
    float wx7 = dot(W7, emx7), wy7 = dot(W7, emy7);
    float cov7 = curveCov(f, fx7, fy7, w7 * wx7 * wx7, w7 * wy7 * wy7, w7 * wx7 * wy7);
    // Near-zero claims write depth at the piece tier and reject solid interior
    // beneath (same contract as the shared tail's cov < 0.004 gate).
    if (cov7 < 0.004) discard;
    o = emit(cov7);
    return;
  } else {
    // Unreachable: kinds 0/7/10/12 return early above, and the packer emits no
    // other kind (legacy 1/3/8/9/11 handlers were removed with their emitters).
    f = 0.0;
  }
  // Coverage. Curve kinds (2 cubic · 5 rquad) use the CURVATURE-AWARE per-axis
  // coverage: their texcoords are affine in screen space, so f is exactly
  // quadratic along each axis and curveCov measures the true kept length within
  // the pixel — removing the tangent-line over-coverage on convex arcs. The
  // needed derivatives come from the texcoord screen gradients (exact for
  // affine tc; the crescent hull triangles aren't slivers, so dFdx is clean here).
  float cov;
  bool isCubic = vKind > 1.5 && vKind < 2.5;
  bool isRquad = vKind > 4.5 && vKind < 5.5;
  if (isCubic && vSeam > 0.5 && vSeam < 5.0) {
    // Cubic crescent: the packer dilated the hull so the exterior AA ramp is not clipped by the
    // hull edge (measured: -14.6/255 under-coverage at the piece midpoint without it). Clip back
    // here to the piece's own END TANGENT planes, or the dilated neighbours overlap and the
    // route's OVER accumulates them into over-coverage (+6.4/255). Sub-pieces of a cubic are
    // tangent-continuous, so adjacent planes coincide and the crescents tile edge to edge.
    // ½px slack: an fp-tilted plane must never discard true crescent body.
    vec2 a = cCen, b = vec2(cScale, cHalf);
    // Reached only by RING-LESS cubic pieces (morph meshes); static pieces carry an exterior
    // ring and never set vSeam. Slack, but SMALL: neighbouring pieces are tangent-continuous, so
    // their clip planes COINCIDE, and a generous slack makes both paint the seam band while the
    // route's OVER double-counts it (a 4-cubic circle read 0.981/255 with 8 bad pixels at 0.5px
    // vs 0.556 with none at <= 0.10). 0.05 keeps a margin against an fp-tilted plane.
    float clipEpsC = 0.05 * vEmPerPx;
    if (dot(vEm - a, vNa) < -clipEpsC || dot(vEm - b, vNb) < -clipEpsC) discard;
  } else if (isRquad) {
    // rquad (ellipse/arc) keeps the chord-span clip — control point not threaded (rare).
    vec2 a = cCen, b = vec2(cScale, cHalf), ch = b - a;
    if (dot(ch, ch) > 1e-9 && (dot(vEm - a, ch) < 0.0 || dot(vEm - b, ch) > 0.0)) discard;
  }
  if (isCubic || isRquad) {
    vec3 tx = dFdx(vTC), ty = dFdy(vTC);   // ∂(texcoords)/∂(screen px) — exact (affine)
    float fx, fy, fxx, fyy, fxy;
    if (isCubic) {                         // f = s·(k³−l·m); 2nd-order fit (drop t³)
      float k = vTC.x, l = vTC.y, m = vTC.z;
      fx = vSign * (3.0 * k * k * tx.x - (tx.y * m + l * tx.z));
      fy = vSign * (3.0 * k * k * ty.x - (ty.y * m + l * ty.z));
      fxx = vSign * (6.0 * k * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (6.0 * k * ty.x * ty.x - 2.0 * ty.y * ty.z);
      fxy = vSign * (6.0 * k * tx.x * ty.x - (tx.y * ty.z + ty.y * tx.z));
    } else {                               // f = s·(Ũ²−Ṽ·R)
      float s5 = vSign > 0.0 ? 1.0 : -1.0;   // magnitude is the lone-crescent flag
      float U = vTC.x, V = vTC.y, Rr = vTC.z;
      fx = s5 * (2.0 * U * tx.x - (tx.y * Rr + V * tx.z));
      fy = s5 * (2.0 * U * ty.x - (ty.y * Rr + V * ty.z));
      fxx = s5 * (2.0 * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = s5 * (2.0 * ty.x * ty.x - 2.0 * ty.y * ty.z);
      fxy = s5 * (2.0 * tx.x * ty.x - (tx.y * ty.z + ty.y * tx.z));
    }
    cov = curveCov(f, fx, fy, fxx, fyy, fxy);
    if (isRquad && abs(vSign) > 2.0) {
      // CHORD EDGE OF A LONE CRESCENT — the missing half of the straight-edge AA.
      //
      // Straight-edge AA is a PAIR: an inner ramp on the kind-0 interior mesh plus
      // the outward kind-10 strip, meeting at 1/2 on the edge. The strip cedes the
      // inner half (`fOwn < 0 && c10 < 0.999 -> discard`) because "fill-side
      // partials are the interior mesh's turf". When a shape's ENTIRE fill is one
      // crescent — a curve plus its closing chord: a lens, a leaf, an arch, a pie
      // slice — there is no kind-0 interior to cede to, so the crescent painted
      // solid and won the MAX composite, rendering the chord as a HARD edge
      // (measured: got 1.000 where the truth is 0.750).
      //
      // No new vertex data is needed: in canonical Loop-Blinn texcoords the arc
      // endpoints are (0,0) and (1,1), so the chord is exactly V = U, and that
      // holds homogeneously for rational quads (u=U/R, v=V/R). The crescent
      // interior has g < 0, the same sense as f, so it min()s straight in.
      //
      // GATED, and it must be: applying it unconditionally fails 13/97 smokes
      // (road IoU 0.46, curved-band "wrong wedges" IoU 0.77) — those rely on the
      // crescent painting solid across a chord that is NOT a shape boundary.
      float s5 = vSign > 0.0 ? 1.0 : -1.0;
      float gC = s5 * (vTC.y - vTC.x);
      vec2  gG = s5 * vec2(tx.y - tx.x, ty.y - ty.x);
      cov = min(cov, slugCov(gC, gG));
    }
  } else {
    if (f4has) {
      // kind-4: exact analytic gradient (cofactor) + curvature from the gradient
      // field's screen derivatives → the same curvature-aware coverage the quad
      // kinds use. First-order slugCov left a 0.3-0.4 band on curved partials.
      vec2 emx = dFdx(vEm), emy = dFdy(vEm);
      float fx4 = dot(f4gEm, emx), fy4 = dot(f4gEm, emy);
      float fxx4 = dot(dFdx(f4gEm), emx), fyy4 = dot(dFdy(f4gEm), emy);
      float fxy4 = dot(dFdy(f4gEm), emx);
      cov = curveCov(f, fx4, fy4, fxx4, fyy4, fxy4);
#ifdef MANTLE_DEBUG_K4
      float dpx = f / max(length(vec2(fx4, fy4)), 1e-12);
      o = vec4(clamp(0.5 + dpx * 0.25, 0.0, 1.0), clamp(0.5 + fxx4 * 2.0, 0.0, 1.0), cov, 1.0);
      return;
#endif
    } else {
      // No live kind reaches this fallback (kept for robustness against an
      // unexpected vertex): first-order tangent-line coverage.
      cov = slugCov(f, vec2(dFdx(f), dFdy(f)));
    }
  }
  // CUBIC EXTERIOR-RING CLAIM RULE (for kind-2 cubic rings): a ring spans
  // the arc's OUTSIDE AA band that a sub-pixel-thin hull cannot. Its FILL-side (f<0) partial
  // fragments are the hull crescent's turf — under the direct-OVER route painting them
  // double-counts the fill-side ramp (measured +10.6/255 over-coverage on a 4-cubic circle,
  // a diagonal band along each arc midpoint). Deep fill (cov≈1) stays: 1-over-1 is exact.
  // vSeam>5 marks a ring vertex (hull crescents carry vSeam=0; the vSeam∈(0.5,5) tangent-clip
  // is the ring-less dilated morph path). f already carries the signed klmn implicit (line ~534).
  if (isCubic && vSeam > 5.0 && cov < 0.999 && f < 0.0) discard;
  // Near-zero claims write depth at the piece tier and reject solid interior
  // beneath (same contract as kind-10's c10 < 0.004 gate).
  if (cov < 0.004) discard;
  o = emit(cov);
}
