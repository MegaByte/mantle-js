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
// The curve implicits:
//   quad:  f = u²−v over the control triangle (texcoords 0,0 / ½,0 / 1,1).
//   cubic: exact Bezout resultant — a 3×3 symmetric determinant of linear
//          forms in the per-curve normalized frame (cen/scale). Machine-exact.
// Coverage = clamp(½ − f/fwidth(f)) gives a ½-pixel analytic AA ramp across
// the zero set, resolution-independent.

precision highp float;

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
#endif
flat in vec2  cCen;
flat in float cScale;
flat in float cHalf;   // kind 7 annulus half-width
flat in float vEmPerPx; // em per device pixel — analytic ∇f for the line-edge ramps
flat in float vTP;      // kind-8 corner cap: T·p
flat in float vSeam;    // kind-1 crescent tangent-clip: ctrl.x (ctrl.y rides vTC.z)
flat in vec2  vNa;      // kind-1 crescent clip normal at endpoint a (bisector of arc+neighbor tangents)
flat in vec2  vNb;      // kind-1 crescent clip normal at endpoint b
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
// with _slugCoverage via @@PAINT_SAMPLE@@ (so the two can't drift). Needs the local
// gradientSpreadToExtend (above) + sampleStops (@@GRADIENT_HELPERS@@) declared first.
@@PAINT_SAMPLE@@

// straight RGBA atlas sample for a top-level <image> (mirrors _slugCoverage's
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
      paint = sampleGradient(uGradId, vEm, uShapeBBox);                  // already premultiplied
    } else {
      vec4 f = lbRecolor(vColor);                                          // per-draw recolor (free when off)
      paint = vec4(f.rgb * f.a, f.a);                                      // premultiply solid
    }
    return paint * (uAlpha * cov);
  }
  return vec4(cov);
}

// Slug-identical straight-edge coverage from a local implicit f and its screen
// gradient. Slug (renderFill in _slugCoverage) casts a horizontal AND a vertical
// ray through the pixel, takes a 1D box coverage on each — clamp(½ − c/|n|) at
// ray-crossing distance c/|n| — and blends them by a centre-proximity weight,
// with a min() floor. A single perpendicular clamp(½ − c) only reproduces the
// axis-aligned case; this reproduces every angle (slope √2 at 45°), so LB's AA
// ramp matches Slug's byte-for-byte on straight edges instead of the too-soft,
// angle-independent perpendicular ramp. f>0 = outside the fill.
float slugCov(float f, vec2 grad) {
  float g  = max(length(grad), 1e-6);
  float nx = max(abs(grad.x) / g, 1e-6);   // |normal.x|, |normal.y| (nx²+ny²≈1)
  float ny = max(abs(grad.y) / g, 1e-6);
  float c  = f / g;                          // signed perpendicular distance (px)
  float xc = clamp(0.5 - c / nx, 0.0, 1.0);  // horizontal-ray 1D box coverage
  float yc = clamp(0.5 - c / ny, 0.0, 1.0);  // vertical-ray 1D box coverage
  float xw = clamp(1.0 - 2.0 * abs(c) / nx, 0.0, 1.0);  // centre-proximity weights
  float yw = clamp(1.0 - 2.0 * abs(c) / ny, 0.0, 1.0);
  float wsum = max(xw + yw, 1e-6);
  return clamp(max((xc * xw + yc * yw) / wsum, min(xc, yc)), 0.0, 1.0);
}

// CURVATURE-AWARE 1D coverage along ONE axis. slugCov treats a curved edge as
// its tangent line (crossing = f/|∂f|), which over-covers on the convex side and
// under-covers on the flat/concave side — the "overcoverage on curves" residual.
// For LB's implicits the texcoords are AFFINE in screen space, so f is exactly
// quadratic along any axis: f(t) = C + B·t + A·t² with A=½·∂²f/∂axis². This
// returns the true length of the kept region {t∈[−½,½] : f(t)<0} — i.e. how much
// of the 1-px ray Slug's ray-cast would find inside — exact for quad/rquad and a
// second-order (curvature-correct) fit for cubic. Degrades cleanly to the linear
// box when A→0, so straight edges are unchanged.
float negLen(float A, float B, float C) {
  if (abs(A) < 1e-7) {                       // ~linear: C + B·t < 0 over [−½,½]
    if (abs(B) < 1e-9) return C < 0.0 ? 1.0 : 0.0;
    float r = -C / B, lo = -0.5, hi = 0.5;
    if (B > 0.0) hi = min(hi, r); else lo = max(lo, r);
    return clamp(hi - lo, 0.0, 1.0);
  }
  float disc = B * B - 4.0 * A * C;
  if (disc <= 0.0) return A < 0.0 ? 1.0 : 0.0;   // no crossing: constant sign = sign(A)
  float sq = sqrt(disc);
  float r1 = (-B - sq) / (2.0 * A), r2 = (-B + sq) / (2.0 * A);
  float rlo = min(r1, r2), rhi = max(r1, r2);
  if (A > 0.0) {                             // f<0 BETWEEN the roots
    return clamp(min(0.5, rhi) - max(-0.5, rlo), 0.0, 1.0);
  }
  float a1 = clamp(rlo, -0.5, 0.5) + 0.5;    // f<0 OUTSIDE the roots: [−½,rlo]∪[rhi,½]
  float a2 = 0.5 - clamp(rhi, -0.5, 0.5);
  return clamp(a1 + a2, 0.0, 1.0);
}

// Slug-blend of the two curvature-aware axis coverages (same H/V centre-proximity
// weighting slugCov uses, so straight/curved AA compose identically at seams).
float curveCov(float f, float fx, float fy, float fxx, float fyy) {
  float covH = negLen(0.5 * fxx, fx, f);
  float covV = negLen(0.5 * fyy, fy, f);
  float wH = clamp(1.0 - 2.0 * abs(f) / max(abs(fx), 1e-6), 0.0, 1.0);
  float wV = clamp(1.0 - 2.0 * abs(f) / max(abs(fy), 1e-6), 0.0, 1.0);
  float wsum = max(wH + wV, 1e-6);
  return clamp(max((covH * wH + covV * wV) / wsum, min(covH, covV)), 0.0, 1.0);
}

void main() {
  // CONVEX-corner cap (kind 8): owns the exterior wedge beyond BOTH tangent spans at a
  // convex junction (cCen/cScale = tangent line A, vLine2 = tangent line B). Centres
  // inside either half-plane belong to the interior/strips/crescents — discard keeps the
  // pixel partition exact under the direct-OVER route. In the wedge, the true coverage is
  // the two-line box model: intersection covA+covB−1 for genuinely-crossing tangents,
  // sliding to min(covA,covB) as the lines become parallel (nested cuts).
  if (vKind > 7.5 && vKind < 8.5) {
    // Ownership by SPAN planes, not tangent half-planes: strips own within-span fragments,
    // the interior owns deep-inside ones — the cap owns what remains at the corner:
    // fragments BEYOND both span planes that aren't deep inside the fill. (The old fA<0
    // discard also dropped the dead zone between a strip's end-plane and the neighbour
    // tangent — a boundary pixel there rendered 0.) V = the corner point (intersection of
    // the two tangent lines); dA/dB = each edge's span direction away from V, signed into
    // the other's inner half-plane.
    // Corner point passed exactly (aSeamM=p.x, aTC.z=p.y): solving the two tangent lines'
    // intersection is ill-conditioned at shallow joints (near-parallel normals) and fp32
    // error scattered V far from the joint, firing the span discards spuriously.
    vec2 V8 = vec2(vSeam, vTC.z);
    vec2 dA8 = vec2(-cCen.y, cCen.x);
    if (dot(dA8, vLine2.xy) > 0.0) dA8 = -dA8;
    vec2 dB8 = vec2(-vLine2.y, vLine2.x);
    if (dot(dB8, cCen) > 0.0) dB8 = -dB8;
    vec2 rel8 = vEm - V8;
    // Osculating correction: f_arc ≈ f_tan − (κ/2)·t² (κ fitted in the builder; 0 for
    // lines). Without it, a tight arc peels off its tangent inside the cap and arc-outside
    // pixels read tangent-inside → wrongly discarded as interior turf.
    float tA8 = dot(rel8, dA8), tB8 = dot(rel8, dB8);
    float fA = dot(cCen, vEm) - cScale - 0.5 * vLineT * tA8 * tA8;
    float fB = dot(vLine2.xy, vEm) - vLine2.z - 0.5 * cHalf * tB8 * tB8;
    // A strip's turf is its span half-plane AND its ~1.25px outward band — a pixel within
    // the span direction but beyond the band (a fill corner poking into a box near a SHORT
    // edge) is painted by nobody else, so the cap keeps it.
    float band8 = 1.3 * vEmPerPx;
    bool inA8 = dot(rel8, dA8) > 0.0 && fA >= 0.0 && fA < band8;
    bool inB8 = dot(rel8, dB8) > 0.0 && fB >= 0.0 && fB < band8;
    if (inA8 || inB8) discard;                                    // a strip paints there
    if (max(fA, fB) <= 0.0) discard;                              // deep inside both → interior's turf
    float cA2 = slugCov(fA, cCen * vEmPerPx);
    float cB2 = slugCov(fB, vLine2.xy * vEmPerPx);
    float k8 = max(0.0, dot(cCen, vLine2.xy));
    o = emit(mix(max(0.0, cA2 + cB2 - 1.0), min(cA2, cB2), k8));
    return;
  }
  // Edge cap-strip (kind 10): the exterior band + BOTH end wedges of one straight edge,
  // with three-feature chained box coverage (prev tangent+κ · own line · next tangent+κ).
  // End partitions are watertight: a LINE neighbour shares the bisector plane
  // w = perp(n̂N + n̂Own) (canonicalized along the edge; START keeps ≥0, END keeps <0 — the
  // neighbour computes the identical plane with the complementary rule); a CURVE neighbour
  // partitions at the arc's tangent plane, complementary to the kind-9 strip's span clip.
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
      // cede to the arc's kind-9 only NEAR the corner: a concave arc's tangent points back
      // over this very edge, and an unbounded cession discarded the whole strip (d75 dots).
      // But NEVER cede our own ½-coverage row (|fOwn| within the working band): the arc's
      // kind-9 f-discards its fill side, so a raster-tie pixel ON our edge line ceded here
      // has no painter left (2@0.6's dead 0.50 ties at the edge→curve junction).
      if (dot(rA, wA) >= 0.0 && length(rA) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else { wA = vec2(-(vNa.y + nOwn.y), vNa.x + nOwn.x); if (dot(wA, tdk) < 0.0) wA = -wA;
      if (dot(rA, wA) < 0.0) discard; }
    if (curveB) { wB = vec2(-vNb.y, vNb.x) * (tsB > 0.5 ? 1.0 : -1.0);
      if (dot(rB, wB) >= 0.0 && length(rB) < 2.5 * vEmPerPx && fOwn > 0.35 * vEmPerPx) discard; }
    else { wB = vec2(-(vNb.y + nOwn.y), vNb.x + nOwn.x); if (dot(wB, tdk) < 0.0) wB = -wB;
      if (dot(rB, wB) >= 0.0) discard; }
    float fA = dot(vNa, rA) - 0.5 * vTC.y * dot(rA, rA);
    float fB = dot(vNb, rB) - 0.5 * vTC.z * dot(rB, rB);
    // PROXIMITY GATE: a neighbour's boundary exists only from its corner onward (along the
    // packed into-neighbour direction) — its field is meaningless elsewhere on our edge.
    // Ungated, a REFLEX neighbour's half-plane covers most of the edge: the union formula
    // saturated mid-edge pixels to 1 and the inside-test discarded them wholesale. Fade in
    // over ~0.8px around the corner; when gated out, convex ends read inert-1 (intersection
    // identity) and reflex ends inert-0 (union identity).
    // RADIAL gate: projection along the into-direction stays large along the WHOLE edge
    // when the neighbour is nearly parallel (an acute apex) — the neighbour's line then
    // zeroed mid-edge coverage via the intersection formula (dotted under-runs). Distance
    // to the corner is scale-correct and orientation-free.
    float gA = clamp((2.2 - length(rA) / vEmPerPx) / 1.5, 0.0, 1.0);
    float gB = clamp((2.2 - length(rB) / vEmPerPx) / 1.5, 0.0, 1.0);
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
    float c10 = slugCov(fOwn, nOwn * vEmPerPx);
    if (abs(tyA) > 0.5) {
      float cA10 = slugCov(fA, vNa * vEmPerPx);
      cA10 = tyA > 0.0 ? mix(1.0, cA10, gA) : mix(0.0, cA10, gA);
      float kpA = max(0.0, dot(nOwn, vNa));
      c10 = tyA > 0.0 ? mix(max(0.0, c10 + cA10 - 1.0), min(c10, cA10), kpA)
                      : mix(c10 + cA10 - c10 * cA10, max(c10, cA10), kpA * gA);
    }
    if (abs(tyB) > 0.5) {
      float cB10 = slugCov(fB, vNb * vEmPerPx);
      cB10 = tyB > 0.0 ? mix(1.0, cB10, gB) : mix(0.0, cB10, gB);
      float kpB = max(0.0, dot(nOwn, vNb));
      c10 = tyB > 0.0 ? mix(max(0.0, c10 + cB10 - 1.0), min(c10, cB10), kpB)
                      : mix(c10 + cB10 - c10 * cB10, max(c10, cB10), kpB * gB);
    }
    // KIND-10 CLAIM RULE (the depth-claim contract): an edge strip fragment
    // that emits ~nothing must not WRITE DEPTH — its zero-coverage zones (the
    // chained-corner union/intersection identities) would otherwise claim
    // junction pixels at the piece tier and reject the interior's full
    // coverage beneath, punching holes at stem junctions.
    if (c10 < 0.004) discard;
    o = emit(c10);
    return;
  }
  // Interior triangle: solid, unless it carries a straight boundary-edge line
  // (cCen,cScale from aC3) — then ramp the INNER AA half across it with the same
  // Slug dual-ray coverage the outward strip uses for the outer half (f>0 outside).
  // They meet at ½ on the edge → a centered analytic ramp with no interior inset.
  if (vKind < 0.5) {
    if (dot(cCen, cCen) > 1e-9) {
      float fi = dot(cCen, vEm) - cScale;
      // ∇fi ANALYTICALLY, not dFdx(fi). cCen is the flat unit edge normal, so ∇fi is
      // exactly cCen scaled to pixels (1/emPerPx). dFdx(fi) instead reads across the
      // 2×2 derivative quad — and at a sharp corner the CDT fans thin SLIVER
      // triangles whose helper pixels extrapolate garbage, blowing up the gradient
      // so slugCov collapses to ~0. That erodes the fill along the sliver: a "linear
      // cut" / diagonal slash across the letter (MuseoSans 'v' base) on real GPUs;
      // SwiftShader masks it. Analytic ∇fi is identical inside a triangle but immune.
      float cA = slugCov(fi, cCen * vEmPerPx);
      // SECOND boundary line (vLine2 = nx,ny,c; vLineT = corner type). A pixel box cut by
      // TWO lines — a thin stroke (both stroke edges in one box) or a corner — needs the
      // combined coverage, not one line's: convex/stroke (fill = intersection locally):
      // covA+covB−1; reflex (fill = union): covA+covB−covA·covB. covB saturates to 1 more
      // than a pixel from line B, so far pixels reduce to plain covA — scale-invariant.
      if (abs(vLineT) > 0.5) {
        float cB = slugCov(dot(vLine2.xy, vEm) - vLine2.z, vLine2.xy * vEmPerPx);
        cA = vLineT > 0.0 ? max(0.0, cA + cB - 1.0) : cA + cB - cA * cB;
      }
      // THIRD line (vTC.xyz; type in cHalf): sliver faces can be cut by three edges. Far →
      // saturates → inert under the same chain.
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
  if (vKind < 1.5 || vKind > 8.5) {   // kinds 9/11 (curve strip / static crescent) share the quad implicit
    // Quadratic control-tri: f = u²−v, signed so the kept side is exterior.
    f = vSign * (vTC.x * vTC.x - vTC.y);
  } else if (vKind < 2.5) {
    // Cubic (Loop-Blinn klmn, p1000-loop §4.4): k,l,m interpolated in vTC;
    // implicit f = k³ − l·m (n≡1 for integral cubics). ~3 mul + 1 sub.
    f = vSign * (vTC.x * vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 3.5) {
    // Straight-edge AA strip: signed distance to the edge line N·em − c (em).
    // f>0 outside the fill; the fwidth ramp centers ½-coverage on the edge.
    f = dot(cCen, vEm) - cScale;
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
    f = vSign * (vTC.x * vTC.x - vTC.y * vTC.z);
  } else if (vKind < 6.5) {
    // Circular arc SDF (kind 6): cCen = circle centre (em), cScale = radius.
    // f = signed distance to the circle. Unlike the per-piece rquad implicit,
    // EVERY co-circular arc sector evaluates the IDENTICAL field, so adjacent
    // sectors MAX-blend with no seam undercount (the notch the ≤90° splits gave
    // at the axis tangents). ∇f is the true radial direction everywhere, so the
    // slugCov AA is correct at every angle including the horizontal/vertical tips.
    f = vSign * (length(vEm - cCen) - cScale);
  } else {
    // Concentric annulus / ring SDF (kind 7): cCen = centre, cScale = mid-radius
    // (rOut+rIn)/2, cHalf = half-width (rOut−rIn)/2. f = signed distance to the ring
    // band = ||p−C| − rMid| − halfW; f<0 inside the band. ONE primitive renders a
    // whole ring exactly — no crescents, no arc-split seams, no small-scale wedge.
    f = vSign * (abs(length(vEm - cCen) - cScale) - cHalf);
  }
  // Coverage. Curve kinds (1 quad · 2 cubic · 5 rquad) use the CURVATURE-AWARE
  // per-axis coverage: their texcoords are affine in screen space, so f is exactly
  // quadratic along each axis and curveCov measures the true kept length within the
  // pixel — removing the tangent-line over-coverage on convex arcs. The needed
  // derivatives come from the texcoord screen gradients (exact for affine tc; the
  // crescent hull triangles aren't slivers, so dFdx is clean here). Straight kinds
  // (0/3) and the SDF kinds (6/7) keep slugCov — kind-3's ∇f is the exact flat
  // normal cCen·(1/emPerPx), not dFdx(f) which corrupts on sliver-adjacent quads.
  float cov;
  bool deferFill = false;
  bool isQuad = vKind > 0.5 && vKind < 1.5;
  bool isCubic = vKind > 1.5 && vKind < 2.5;
  bool isRquad = vKind > 4.5 && vKind < 5.5;
  bool isQuad9 = vKind > 8.5 && vKind < 9.5;
  bool isQuad11 = vKind > 10.5;
  // TILING CLIP: each quad/rquad crescent is generously DILATED (packer) so it reaches
  // past the arc AA band at both endpoints — no pinch. Here we confine it back to its own
  // arc's chord span [a,b] (a = aC3.xy, b = aC3.zw), discarding the excess. Adjacent
  // crescents share an endpoint, so they PARTITION the boundary — every pixel is covered
  // by exactly one crescent reporting its exact curveCov → MAX is trivially correct, with
  // no seam notch (scalloping) and no seam over-coverage.
  if (isQuad) {
    // EXACT tangent/corner partition. Clip each endpoint by its BISECTOR normal (vNa at a,
    // vNb at b): the bisector of THIS arc's tangent and the NEIGHBOUR segment's tangent at
    // the shared on-curve point. At a tangent-continuous seam the neighbour tangent is
    // collinear, so vNa ∝ the arc tangent — adjacent crescents' clip planes COINCIDE and
    // they tile edge-to-edge (no seam over/notch). At a CORNER (curve meets a straight edge
    // or another curve at an angle) the bisector is the shared corner-partition plane, so the
    // generously-dilated crescent is clipped exactly at the corner instead of spilling past
    // it (the concave-corner over-coverage). a=aC3.xy, b=aC3.zw; a==b ⇒ adopted sub-tri (no clip).
    vec2 a = cCen, b = vec2(cScale, cHalf);
    if (dot(b - a, b - a) > 1e-9) {
      // ½px slack: an fp-tilted bisector plane must never discard true crescent body —
      // at large scales a hairline plane error becomes a hundreds-of-px crack along the
      // clip (the e@5.3 diagonal). The neighbour may double-paint ≤half the AA ramp
      // in the overlap hair — invisible against a full crack.
      vec2 cp = vec2(vSeam, vTC.z);
      float s1 = (cp.x - a.x) * (vEm.y - a.y) - (cp.y - a.y) * (vEm.x - a.x);
      float s2 = (b.x - cp.x) * (vEm.y - cp.y) - (b.y - cp.y) * (vEm.x - cp.x);
      float s3 = (a.x - b.x) * (vEm.y - b.y) - (a.y - b.y) * (vEm.x - b.x);
      bool ownTri = min(min(s1, s2), s3) >= 0.0 || max(max(s1, s2), s3) <= 0.0;
      float clipEps = 0.5 * vEmPerPx;
      if (!ownTri && (dot(vEm - a, vNa) < -clipEps || dot(vEm - b, vNb) < -clipEps)) discard;
      // fill-side deferral outside the control tri assumes the interior mesh covers the
      // pixel — at tight spiral bowls (6/8/9/e) it can miss, tearing glyph-locked holes.
      // DEEP fill (cov≈1) is always safe to paint: 1-over-1 composites to 1 exactly.
      // Only the PARTIAL fill-side zone defers (the interior ramp's turf).
      deferFill = !ownTri && vSign * (vTC.x * vTC.x - vTC.y) < 0.0;
    }
  } else if (isRquad) {
    // rquad (ellipse/arc) keeps the chord-span clip — control point not threaded (rare).
    vec2 a = cCen, b = vec2(cScale, cHalf), ch = b - a;
    if (dot(ch, ch) > 1e-9 && (dot(vEm - a, ch) < 0.0 || dot(vEm - b, ch) > 0.0)) discard;
  } else if (isQuad9) {
    // Curve strip: owns the EXTERIOR side (f-sign partition — the kind-11 crescent owns the
    // fill side of the same implicit) within its span. Discards keep direct-OVER exact.
    // KNOWN LIMIT: 9 and 11 evaluate f in different interpolation frames, so a pixel
    // centered exactly on the arc can read opposite epsilon signs and lose both painters
    // (a 0.5 tie hole, ~1px/glyph at one phase). Overlap windows trade holes for doubles
    // statistically (measured: no δ fits both n and u) — the real fix is a raster-domain
    // partition (ring strips sharing hull verts), ledgered.
    vec2 a = cCen, b = vec2(cScale, cHalf), cp = vec2(vSeam, vTC.z);
    if (dot(vEm - a, cp - a) < 0.0 || dot(vEm - b, cp - b) < 0.0) discard;
    if (vSign * (vTC.x * vTC.x - vTC.y) <= 0.0) discard;
  } else if (isQuad11) {
    // Static crescent: |vSign|=2 marks a FAT arc paired with a RING strip — the ring
    // never overlaps the hull (shared inner verts partition by rasterization), so the
    // hull face paints BOTH sides of its arc: no f-sign discard, no tie fragility.
    // |vSign|=1 (shallow arc / earcut path) keeps the bbox-strip f-sign partition.
    // curveCov is homogeneous in (f, fx, fy, fxx, fyy), so the ×2 sign is harmless.
    if (abs(vSign) < 1.5 && vSign * (vTC.x * vTC.x - vTC.y) > 0.0) discard;
  }
  if (isQuad || isCubic || isRquad || isQuad9 || isQuad11) {
    vec3 tx = dFdx(vTC), ty = dFdy(vTC);   // ∂(texcoords)/∂(screen px) — exact (affine)
    float fx, fy, fxx, fyy;
    if (isQuad || isQuad9 || isQuad11) {   // f = s·(u²−v)
      float u = vTC.x;
      fx = vSign * (2.0 * u * tx.x - tx.y); fy = vSign * (2.0 * u * ty.x - ty.y);
      fxx = vSign * 2.0 * tx.x * tx.x;      fyy = vSign * 2.0 * ty.x * ty.x;
    } else if (isCubic) {                  // f = s·(k³−l·m); 2nd-order fit (drop t³)
      float k = vTC.x, l = vTC.y, m = vTC.z;
      fx = vSign * (3.0 * k * k * tx.x - (tx.y * m + l * tx.z));
      fy = vSign * (3.0 * k * k * ty.x - (ty.y * m + l * ty.z));
      fxx = vSign * (6.0 * k * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (6.0 * k * ty.x * ty.x - 2.0 * ty.y * ty.z);
    } else {                               // f = s·(Ũ²−Ṽ·R)
      float U = vTC.x, V = vTC.y, Rr = vTC.z;
      fx = vSign * (2.0 * U * tx.x - (tx.y * Rr + V * tx.z));
      fy = vSign * (2.0 * U * ty.x - (ty.y * Rr + V * ty.z));
      fxx = vSign * (2.0 * tx.x * tx.x - 2.0 * tx.y * tx.z);
      fyy = vSign * (2.0 * ty.x * ty.x - 2.0 * ty.y * ty.z);
    }
    cov = curveCov(f, fx, fy, fxx, fyy);
  } else {
    if (f4has) {
      // kind-4: exact analytic gradient (cofactor) + curvature from the gradient
      // field's screen derivatives → the same curvature-aware coverage the quad
      // kinds use. First-order slugCov left a 0.3-0.4 band on curved partials.
      vec2 emx = dFdx(vEm), emy = dFdy(vEm);
      float fx4 = dot(f4gEm, emx), fy4 = dot(f4gEm, emy);
      float fxx4 = dot(dFdx(f4gEm), emx), fyy4 = dot(dFdy(f4gEm), emy);
      cov = curveCov(f, fx4, fy4, fxx4, fyy4);
#ifdef MANTLE_DEBUG_K4
      float dpx = f / max(length(vec2(fx4, fy4)), 1e-12);
      o = vec4(clamp(0.5 + dpx * 0.25, 0.0, 1.0), clamp(0.5 + fxx4 * 2.0, 0.0, 1.0), cov, 1.0);
      return;
#endif
    } else {
      vec2 fgrad = (vKind > 2.5 && vKind < 3.5) ? cCen * vEmPerPx : vec2(dFdx(f), dFdy(f));
      cov = slugCov(f, fgrad);
    }
  }
  // KIND-9 CLAIM RULE (the depth-claim contract): a curve strip's job is the
  // OUTSIDE AA band — its FILL-side partial fragments are the interior's turf
  // (at junction zones their arc-frame partial is not the pixel's truth: the
  // pixel is deep ink via the OTHER feature). Under blending they merely
  // double-blend; under the cascade they would claim the pixel at partial
  // coverage and reject the interior's full coverage beneath.
  // Deep fill-side (cov≈1) stays: 1-over-1 is exact either way.
  if (vKind > 8.5 && vKind < 9.5 && cov < 0.999 && vSign * (vTC.x * vTC.x - vTC.y) < 0.0) discard;
  if (deferFill && cov < 0.999) discard;
  if (cov <= 0.0) discard;
  o = emit(cov);
}
