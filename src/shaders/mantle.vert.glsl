#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
precision highp float;
precision highp int;
precision highp sampler2D;  // uMetaTex/uOverrideTex are RGBA32F em-space data (lowp default crushes them)

// Per-shape OBB cover quad with full Lengyel "A Decade of Slug"
// dynamic dilation. Each cover-quad corner is pushed outward along
// its outward bisector normal by exactly half a pixel in viewport
// space.
//
// Inputs (per vertex, from importer.js getCoverQuadMesh cover-
// quad chunks):
//   aPos      : em-space vertex position (one of 6 OBB-quad corners)
//   aNormal   : un-normalized outward bisector at this vertex
//               (OBB: ±uHat ± vHat per quadrant; AABB: ±1, ±1)
//   aShapeIdx : per-vert meta-row index. Reading shapeIdx from the
//               vert lets a SINGLE drawArrays cover the whole
//               cover-quad set.
// Per-draw uniforms:
//   uMetaTex      : per-shape meta; texel 0 = em-space bbox (used
//                   only by the fragment shader, not here)
//   uGlobalBBox   : (minX, minY, w, h) em-space; em → NDC mapping
//   uCanvasAR     : aspect-preserving NDC scale
//   uViewportSize : canvas pixels (w, h)
//   uNumShapes    : for per-shape z = 1 - shapeIdx/N painter ordering
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aNormal;
// Optional per-vert native-em sample coord. Stored in the buffer slot
// reserved for curve control point v1 (offset 16 / floats 4-5). For
// non-9-slice bundles this slot is unused by the cover-quad path;
// nineSlice.applyNineSlice() rewrites it to hold the native em coord so
// the fragment's coverage sampler sees undeformed curves in stretched
// cells. uHasEmCoord = 1 selects this attribute over aPos for vEmCoord;
// default (0) keeps "aPos IS emPos".
layout(location=2) in vec2 aEmCoord;
// With the per-curve TEXTURE the shape index and the coefficient-block index are two
// small integers, so they share ONE unsigned-short pair here instead of two floats
// (56B -> 52B per vertex). Macro'd back to the original names so every use site —
// aShapeIdx here, lbCoefAt(aCurveIdx, i) below — is untouched. UNSIGNED_SHORT is bound
// UNNORMALIZED, so each arrives as its integer value.
#ifdef MANTLE_LB_CURVE_TEX
layout(location=7) in vec2 aIdxPair;
#define aShapeIdx aIdxPair.x
#define aCurveIdx aIdxPair.y
#else
layout(location=7) in float aShapeIdx;
#endif
// The position's order of operations below is what makes a deep zoom land right, and on ANGLE/Metal a program-cache hit of this source
// gave the answer of the plain product while a fresh compile kept it. Invariant holds both to the one written.
invariant gl_Position;
out vec2 vEmCoord;
flat out vec4 vAffineFootprint;
out vec4 vOverrideTint;     // multiplied into the fill+stroke color in mantle.frag
#ifdef MANTLE_INSTANCED
out vec4 vInstBias;         // ADDED to the fill+stroke color after the tint (fog)
#endif
// Absolute attribute overrides. Driven by the override table's
// per-attribute mask (texel 1.w); the fragment shader gates the
// replacement at draw time so unmasked attributes pass through.
flat out int vOverrideMask; // 0 when none; 0x1=fill, 0x2=stroke, 0x4=strokeWidth, 0x8=moved
out vec4 vOverrideFill;     // absolute fill color when (mask & 1)
out vec4 vOverrideStroke;   // absolute stroke color when (mask & 2)
out float vOverrideStrokeWidth;  // absolute em-space width when (mask & 4)
flat out int vInst;
uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
uniform vec2 uViewportSize;
uniform float uNumShapes;
// -1 = use aShapeIdx (main path, single-drawcall fills).
// >=0 = override (mask render binds a separate VBO without an
// aShapeIdx column, so it forces shapeIdx via uniform).
uniform int uShapeIdxOverride;
// 1 → read native em-coord from aEmCoord (set by nineSlice rewrite);
// 0 → fall back to aPos (every non-9-slice bundle).
uniform int uHasEmCoord;

// Per-shape override texture (animation extensions).
// 6 RGBA32F texels per shape, row = shapeIdx, columns:
//   0 : (m00, m01, m10, m11) — 2×2 affine
//   1 : (tx, ty, visibility, overrideMask)
//   2 : (tint.r, tint.g, tint.b, tint.a) — multiplicative
//   3 : (fill.r, fill.g, fill.b, fill.a)  — abs fill   when mask & 1
//   4 : (stroke.r, stroke.g, stroke.b, stroke.a) — abs stroke when mask & 2
//   5 : (strokeWidth, _, _, _) — abs strokeWidth when mask & 4
// Bound when uHasOverrides == 1; otherwise the shape draws as-is
// and the override varyings carry inert defaults.
uniform sampler2D uOverrideTex;
uniform int uHasOverrides;
// Per-draw alpha multiplier. Set from drawBundle/drawInstance's
// opts.alpha; defaults to 1.0 when omitted. Folded into the per-shape
// tint alpha here so callers get a universal opacity multiplier
// whether or not an override table is bound (works on bare bundles too).
uniform float uDrawAlpha;
#ifndef MANTLE_NO_FILTER
uniform float uFilterInputScale;
#endif
// World-space 3×3 affine applied to em-space verts after dilation.
// Identity when no per-draw transform is provided. Stored as 3 vec3
// columns: uWorldM[0]=col0 (m00, m10, 0), uWorldM[1]=col1 (m01, m11, 0),
// uWorldM[2]=col2 (tx, ty, 1).
uniform mat3 uWorldM;
uniform int uHasWorldM;

// ── Loop-Blinn geometry, hosted here ───────────────────────────────────────
// An LB triangle and a cover quad are different vertices in the same buffer, so
// they overlay attribute slots and the fragment tells them apart by vKind (a
// cover quad is stamped -1). Slots 3-6 are free on this program; 8-13 belong to
// the instanced fill-only variant, which never carries LB geometry.
#ifdef MANTLE_LB_FILL
// MANTLE_LB_CURVE_TEX moves the 16 per-curve coefficient floats out of the vertex
// and into an RGBA32F texture, 4 texels per unique block, addressed by ONE index.
// RGBA32F is still FP32, so nothing about the math changes — only where the bytes
// live (116B -> 56B per static vertex; see unifiedFillVerts.js). Frees slots 4-6.
//
// The blocks are interned BY CONTENT, so a triangle's three identical blocks share
// one entry and the all-zero block that every cover-quad and interior vertex carries
// collapses to a single entry.
#ifdef MANTLE_LB_CURVE_TEX
// aCurveIdx is the .y of the packed pair at location 7 (see above) — location 3 is
// free on this variant.
uniform highp sampler2D uCurveCoefTex;   // lowp would crush em-space coefficients
uniform int uCurveCoefW;
vec4 lbCoefAt(float blockIdx, int i) {
  int t = int(blockIdx + 0.5) * 4 + i;
  return texelFetch(uCurveCoefTex, ivec2(t % uCurveCoefW, t / uCurveCoefW), 0);
}
#else
layout(location=3) in vec4 aC0;
layout(location=4) in vec4 aC1;
layout(location=5) in vec4 aC2;
layout(location=6) in vec4 aC3;
#endif
layout(location=14) in vec3 aLbTC;    // LB texcoord / klmn (cover quads leave it 0)
// (kind+1, sign, seamM). The BIAS matters: an unbound vertex attribute reads
// (0,0,0,1), so storing the raw kind would make every cover quad look like
// an INTERIOR piece and take the LB path. Biased by one, unbound = 0 = "not LB",
// and the cover-quad VAO needs no binding here at all.
layout(location=15) in vec3 aLbMeta;
#define MANTLE_IS_LB_VERT (aLbMeta.x > 0.5)
// _lbVertexSetup reads these two at file scope; they ride aLbMeta here.
#define aFlags vec2(aLbMeta.x - 1.0, aLbMeta.y)
#define aSeamM aLbMeta.z
#ifdef MANTLE_LB_MORPH
// MORPH: the second endpoint's pack, mixed by uMorphT below — the same
// dual-stream trick loopBlinn.vert uses (MANTLE_LB_MORPH_PAIR), so one static
// mesh serves every t and no buffer is rewritten per frame.
//
// These take 8-13, which is the whole remaining budget (the static half holds
// 0-7, 14, 15). They collide with MANTLE_INSTANCED's per-instance attributes,
// and that is fine: an instanced draw paints N copies of one fill-only bundle
// and a morph interpolates one bundle's geometry, so no program is ever both.
//
// kind/sign/seamM have no twin. Both endpoint packs come from the same
// partition, so a vertex is the same kind of piece at both ends.
layout(location=8)  in vec2 aPosB;
layout(location=9)  in vec3 aLbTCB;
#ifdef MANTLE_LB_CURVE_TEX
layout(location=10) in float aCurveIdxB;
#else
layout(location=10) in vec4 aC0B;
layout(location=11) in vec4 aC1B;
layout(location=12) in vec4 aC2B;
layout(location=13) in vec4 aC3B;
#endif
uniform float uMorphT;
// A slot holding packed bits is not a number, and mix() of two such floats is a meaningless bit pattern: the
// Bezout ring's push normal (aC3.w), a cubic klm ring's gradient pair (aC0.z) and a curve band's own end normals
// (aC2.xy) came out as garbage at every 0 < t < 1 while both endpoints stayed exact -- isolated dropouts inside a morphing
// fill at t = 0.5 and nowhere else. Unpack both endpoints, lerp the vectors, pack the result. A unit normal is
// renormalized after the lerp (zero stays zero, which is what keeps an inner ring vertex welded to its hull).
// The gradient pair has its own codec and its own mixer, `lbMixKlmGrad` in _lbVertexSetup.glsl.
float lbMixHalfUnit(float a, float b, float t) {
  vec2 n = mix(unpackHalf2x16(floatBitsToUint(a)), unpackHalf2x16(floatBitsToUint(b)), t);
  float L = length(n);
  return uintBitsToFloat(packHalf2x16(L > 0.0 ? n / L : n));
}
#endif
// ONE NAME PER COEFFICIENT SLOT, so every use site is identical in both layouts.
// Deliberately macros over the fetch rather than four locals: on the static path the
// non-Bezout variant reads only C0 and C3, and a local would fetch C1/C2 that the
// shader never uses. Each macro is referenced ONCE per use site below, so nothing is
// fetched twice.
#ifdef MANTLE_LB_FILL
#ifdef MANTLE_LB_CURVE_TEX
#define LB_C0 lbCoefAt(aCurveIdx, 0)
#define LB_C1 lbCoefAt(aCurveIdx, 1)
#define LB_C2 lbCoefAt(aCurveIdx, 2)
#define LB_C3 lbCoefAt(aCurveIdx, 3)
#define LB_C0B lbCoefAt(aCurveIdxB, 0)
#define LB_C1B lbCoefAt(aCurveIdxB, 1)
#define LB_C2B lbCoefAt(aCurveIdxB, 2)
#define LB_C3B lbCoefAt(aCurveIdxB, 3)
#else
#define LB_C0 aC0
#define LB_C1 aC1
#define LB_C2 aC2
#define LB_C3 aC3
#define LB_C0B aC0B
#define LB_C1B aC1B
#define LB_C2B aC2B
#define LB_C3B aC3B
#endif
#endif
#define LB_FLAT flat out
#define LB_SMOOTH out
@@LB_VARYINGS@@
#undef LB_FLAT
#undef LB_SMOOTH
@@EM_PER_PX@@
@@CPATCH_VERTEX_SETUP@@
@@LB_VERTEX_SETUP@@
#endif
// Only the composed-draw half concerns the vertex
// stage; the two coverage sources (LB fill / split stroke) are fragment-only.
// So a caller can ask for a composed draw WITHOUT the LB fill — Slug or AAC
// computing the fill in-shader while the stroke is sampled — and the vertex
// behavior is the same either way.
#ifdef MANTLE_COMPOSED
// Composed cover quad: the static unit-quad corner aPos (0/1) is expanded to
// this AABB (em-space), eliminating the per-frame quad upload.
uniform vec4 uCoverBBox;
#endif

// Instanced fill variant (drawBundleInstanced fast path). The per-draw
// world matrix + alpha come from per-instance vertex attributes (divisor
// 1) instead of the uWorldM/uDrawAlpha uniforms, so one drawArraysInstanced
// paints N transformed copies of a fill-only bundle. Everything else
// (curve/band/meta textures, shared override table, recolor) is identical
// to the non-instanced program — only these inputs differ, so the
// fragment shader is shared verbatim. Locations 8–11 are free (the fill
// vertex shader uses 0,1,2,7; the cover-quad mesh fills 3–6 unused here).
#ifdef MANTLE_INSTANCED
layout(location=8)  in vec3 aInstW0;   // uWorldM col0 (m00, m10, 0)
layout(location=9)  in vec3 aInstW1;   // uWorldM col1 (m01, m11, 0)
layout(location=10) in vec3 aInstW2;   // uWorldM col2 (tx,  ty,  1)
layout(location=11) in float aInstAlpha;

layout(location=12) in vec4 aInstTint;
// Per-instance additive BIAS, applied after the tint: out = clamp(in*tint + bias).
//
// A tint alone is a diagonal color matrix — a pure multiply. It cannot express a FOG:
//   out.rgb = in.rgb*fog + fogColor*(1 - fog)
// which is a diagonal scale PLUS an offset. Without a bias slot, any instance carrying an
// offset would fall off the instanced fast path entirely and the whole draw would collapse to
// one draw call PER INSTANCE. The offset is one vec4; the draw calls are the expensive part.
layout(location=13) in vec4 aInstBias;
#endif


vec4 emRow0() {
  float sx = uCanvasAR.x * 2.0 / uGlobalBBox.z;
  return vec4(sx, 0.0, 0.0, -uCanvasAR.x - 2.0 * uGlobalBBox.x * uCanvasAR.x / uGlobalBBox.z);
}
vec4 emRow1() {
  float sy = -uCanvasAR.y * 2.0 / uGlobalBBox.w;
  return vec4(0.0, sy, 0.0, uCanvasAR.y + 2.0 * uGlobalBBox.y * uCanvasAR.y / uGlobalBBox.w);
}
vec4 emRow3() {
  // 2D ortho: w = 1. m3 = (0, 0, 0, 1).
  return vec4(0.0, 0.0, 0.0, 1.0);
}

// THE BOX FILTER'S REACH ALONG A ROTATED EDGE, 1 = on. Off, every cover-quad EDGE is pushed
// out by half a device pixel, which is exactly right for an AXIS-ALIGNED edge and short for any
// other one: a pixel has coverage iff its 1x1 box meets the shape, so its center can be half a
// pixel away along each screen axis — up to 0.7071 px along an edge normal at 45 degrees. The
// PCA-fitted OBB cover quad is the case that is not axis-aligned, and there the outermost sliver of
// the AA ramp falls outside the quad and is never rasterized.
//
// A COHERENT UNIFORM, NOT A #define, so one program runs both arms and a fill-rate A/B carries no
// shader-variant confound (the reason uStrokeGates is one too). Declared with the helper that reads
// it: a uniform in the shaders that INCLUDE a helper leaves every other includer referencing an
// undeclared identifier. Unset it reads 0, the default, so a draw path that does not set it keeps
// the default pixels.
uniform int uCoverAaReach;

// Lengyel "A Decade of Slug" dynamic dilation. Pushes the cover-quad
// vertex outward along `normal` so the corner moves by half a pixel
// in viewport space.
//   s  = clip-w at vertex
//   t  = clip-w derivative along normal
//   uv = squared per-axis viewport-shift-per-unit-normal
//   d  = s²(st + √uv) / (uv − s²t²)
// Returns the em-space displacement Δem; caller adds to em-pos for
// rasterization AND to the sample coord (emPos == sample coord in
// Mantle's design, so the inverse Jacobian is identity → Δem = d·n).
vec2 coverQuadDilate(vec2 emPos, vec2 normal,
                vec4 m0, vec4 m1, vec4 m3,
                vec2 viewportPx) {
  if (dot(normal, normal) < 1e-12) return vec2(0.0);
  vec2 nHat = normalize(normal);
  float s = dot(m3.xy, emPos) + m3.w;
  float t = dot(m3.xy, nHat);
  float u = (s * dot(m0.xy, nHat) - t * (dot(m0.xy, emPos) + m0.w)) * viewportPx.x;
  float v = (s * dot(m1.xy, nHat) - t * (dot(m1.xy, emPos) + m1.w)) * viewportPx.y;
  float s2 = s * s;
  float st = s * t;
  float uv = u * u + v * v;
  float denom = uv - st * st;
  // Guard singular projections relative to their terms: an absolute cutoff
  // removes valid AA cover at large document scales.
  if (abs(denom) <= 1.1920929e-7 * (uv + st * st)) return vec2(0.0);
  float d = s2 * (st + sqrt(uv)) / denom;
  // (u, v) IS the corner bisector in screen space, so the factor costs no new projection. The
  // support of the unit pixel box in a direction at angle θ to the axes is ½(|cos θ| + |sin θ|);
  // for a RECTANGLE both edges share it (perp swaps the components), and with the bisector at
  // θ + 45° that equals √2 · max(|b̂x|, |b̂y|) — exactly 1 for an axis-aligned quad, where the
  // default half pixel is already right, and √2 at 45°. So this costs no extra fragment on the
  // common case and never over-dilates past the filter's true reach.
  if (uCoverAaReach == 1) {
    float len = sqrt(uv);
    if (len > 0.0) d *= 1.41421356 * max(abs(u), abs(v)) / len;
  }
  return normal * d;
}

#if defined(MANTLE_LB_FILL) && !defined(MANTLE_LB_NO_EDGE_STRIP)
// The edge strips' shared corner planes. Two edge strips meet at a line-line corner and split its wedge
// at the bisector, one side each. Decided from each strip's own interpolated em position, the two tests would disagree in
// the last bits, and a pixel center ON the bisector -- where a symmetric corner puts one exactly -- would be painted by both
// strips or by neither. The builder packs ONE plane per corner (a point and a normal both strips hold bit for bit,
// aC2/aC1), and this maps it into canvas pixels, where the fragment's own center is exact: gl_FragCoord + uFragOrigin.
// Both strips run this on the same bits, so they get the same line, and the fragment's test is one shared number.
//
// The em -> clip chain as one homogeneous matrix: the override affine, the em -> plane map (emRow0/emRow1), and the
// world matrix -- or, under an SVG vector-effect, the anchored affine main() builds in its place. It mirrors main()'s
// point chain; it need not match it bit for bit, only be the same for both strips, which it is (same inputs).
mat3 lbEmToClipH(vec4 r0, vec4 r1, mat2 ovB, vec2 ovP, mat3 wM, int hasWM, int shapeIdx) {
  mat3 H = mat3(r0.x, 0.0, 0.0,  0.0, r1.y, 0.0,  r0.w, r1.w, 1.0);
  if (uHasOverrides == 1) H = H * mat3(ovB[0].x, ovB[0].y, 0.0,  ovB[1].x, ovB[1].y, 0.0,  ovP.x, ovP.y, 1.0);
  if (hasWM == 1) {
    int fl = int(texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, shapeIdx), 0).w + 0.5);
    if ((fl & (1024 | 2048 | 4096)) != 0) {
      vec4 bb = texelFetch(uMetaTex, metaAt(MT_BBOX, shapeIdx), 0);
      vec2 aUV = (vec2((bb.x + bb.z) * 0.5, (bb.y + bb.w) * 0.5) - uGlobalBBox.xy) / uGlobalBBox.zw;
      vec2 aPl = (aUV * 2.0 - 1.0) * uCanvasAR, ac = vec2(aPl.x, -aPl.y);
      float m00 = wM[0][0], m10 = wM[0][1];
      float sc = max(sqrt(m00 * m00 + m10 * m10), 1e-30);
      vec2 effS = (fl & 1024) != 0 ? vec2(1.0) : vec2(sc);
      mat2 effR = (fl & 2048) != 0 ? mat2(1.0) : mat2(m00 / sc, m10 / sc, -m10 / sc, m00 / sc);
      vec2 effT = (fl & 4096) != 0 ? vec2(0.0) : wM[2].xy;
      mat2 A = effR * mat2(effS.x, 0.0, 0.0, effS.y);
      H = mat3(vec3(A[0], 0.0), vec3(A[1], 0.0), vec3(ac + effT - A * ac, 1.0)) * H;
    } else {
      H = wM * H;
    }
  }
  return H;
}
// One corner's plane in canvas pixels: (point, normal), the normal on the side the em normal w points to (the outgoing
// edge's). A zero w is "no shared plane" and stays zero. The line is the image of the em line through c along perp(w);
// its direction and the side come from the projection's derivative at c, so a projective world matrix maps it too.
vec4 lbCornerPlanePx(vec2 c, vec2 w, mat3 H) {
  if (!(dot(w, w) > 0.0)) return vec4(0.0);
  vec3 ch = H * vec3(c, 1.0), mh = H * vec3(-w.y, w.x, 0.0), wh = H * vec3(w, 0.0);
  vec2 hv = 0.5 * uViewportSize, cn = ch.xy / ch.z;
  vec2 dm = (mh.xy - cn * mh.z) / ch.z * hv, dw = (wh.xy - cn * wh.z) / ch.z * hv;
  vec2 n = vec2(-dm.y, dm.x);
  return vec4(cn * hv + hv, dot(n, dw) < 0.0 ? -n : n);
}
#endif


void main() {
  vAffineFootprint = vec4(0.0);
  int shapeIdx = (uShapeIdxOverride >= 0) ? uShapeIdxOverride : int(aShapeIdx + 0.5);
  vInst = shapeIdx;

  // World transform + draw-alpha source: per-instance attributes in the
  // instanced variant, the per-draw uniforms otherwise. The rest of main()
  // reads wWorldM / wHasWorldM / wDrawAlpha so the two paths share code.
#ifdef MANTLE_INSTANCED
  mat3  wWorldM    = mat3(aInstW0, aInstW1, aInstW2);
  int   wHasWorldM = 1;
  float wDrawAlpha = aInstAlpha;
  vec4  wDrawTint  = aInstTint;
  vInstBias        = aInstBias;
#else
  mat3  wWorldM    = uWorldM;
  int   wHasWorldM = uHasWorldM;
  float wDrawAlpha = uDrawAlpha;
  vec4  wDrawTint  = vec4(1.0);   // compile-time white → multiply folds away
#endif

  // Per-shape override read. The shader-side default is identity +
  // white tint + full visibility so uniformly-unset shapes are
  // indistinguishable from a no-override draw.
  vec2 ovPos = vec2(0.0);
  mat2 ovBasis = mat2(1.0, 0.0, 0.0, 1.0);
  float ovVis = 1.0;
  vec4 ovTint = vec4(1.0);
  int ovMask = 0;
  vec4 ovFill = vec4(0.0);
  vec4 ovStrk = vec4(0.0);
  float ovStrkW = 0.0;
  if (uHasOverrides == 1) {
    vec4 ovAff  = texelFetch(uOverrideTex, ovAt(OV_AFFINE, shapeIdx), 0); // m00,m01,m10,m11
    vec4 ovP    = texelFetch(uOverrideTex, ovAt(OV_POS_VIS, shapeIdx), 0); // tx,ty,vis,mask
    ovTint      = texelFetch(uOverrideTex, ovAt(OV_TINT, shapeIdx), 0);
    // Pack basis column-major into mat2 (GLSL is column-major).
    ovBasis = mat2(ovAff.x, ovAff.z,
                   ovAff.y, ovAff.w);
    ovPos = ovP.xy;
    ovVis = clamp(ovP.z, 0.0, 1.0);
    ovMask = int(ovP.w + 0.5);
    // Conditional fetches: a shape with no absolute-override bits set
    // doesn't pay for the three trailing texel reads. Branch-coherent
    // within a draw (one shape per fragment quad) so the cost is
    // bounded by the actual overridden-shape count.
    if ((ovMask & 1) != 0) ovFill   = texelFetch(uOverrideTex, ovAt(OV_FILL, shapeIdx), 0);
    if ((ovMask & 2) != 0) ovStrk   = texelFetch(uOverrideTex, ovAt(OV_STROKE, shapeIdx), 0);
    if ((ovMask & 4) != 0) ovStrkW  = texelFetch(uOverrideTex, ovAt(OV_STROKE_W, shapeIdx), 0).x;
  }
  // Fold the per-draw alpha multiplier AND the per-shape visibility into the
  // override tint alpha (mantle.frag multiplies vFill/vStroke by vOverrideTint),
  // giving a uniform fade whether or not an override table is bound. uDrawAlpha
  // defaults to 1.0. Visibility is a CONTINUOUS [0,1] fade (0.5 ⇒ half-opacity),
  // not binary — the ovVis<=0 collapse below is just the fully-transparent fast
  // path.
  ovTint *= wDrawTint;   // per-instance rgba tint (instanced variant; 1 otherwise)
  ovTint.a *= wDrawAlpha * ovVis;
#ifndef MANTLE_NO_FILTER
  ovTint.a *= uFilterInputScale > 0.0 ? uFilterInputScale : 1.0;
#endif
  vOverrideTint = ovTint;
  // Bit 0x8: the override MOVES the row (a basis other than the identity, or a translation). The fragment then reads
  // the row's mask through the in-shader walk, at its own frame, rather than the screen-space mask bake.
  if (ovBasis[0][0] != 1.0 || ovBasis[0][1] != 0.0 || ovBasis[1][0] != 0.0 || ovBasis[1][1] != 1.0
      || ovPos.x != 0.0 || ovPos.y != 0.0) ovMask |= 8;
  vOverrideMask = ovMask;
  vOverrideFill = ovFill;
  vOverrideStroke = ovStrk;
  vOverrideStrokeWidth = ovStrkW;

  // Visibility = 0 → collapse vert behind the near plane. The
  // rasterizer drops the degenerate triangle.
  if (ovVis <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vEmCoord = vec2(0.0);
    return;
  }


  vec4 e0 = emRow0(), e1 = emRow1();
  vec4 m0, m1, m3;
  if (wHasWorldM == 1) {
    m0 = wWorldM[0][0] * e0 + wWorldM[1][0] * e1;  m0.w += wWorldM[2][0];
    m1 = wWorldM[0][1] * e0 + wWorldM[1][1] * e1;  m1.w += wWorldM[2][1];
    m3 = wWorldM[0][2] * e0 + wWorldM[1][2] * e1;  m3.w += wWorldM[2][2];
  } else {
    m0 = e0; m1 = e1; m3 = emRow3();
  }
  // Fold the per-shape override basis into the dilation Jacobian. The override
  // (applied below as ovBasis*emDilated + ovPos) changes the shape's ACTUAL
  // on-screen scale, and the half-pixel guard must be half a pixel at THAT
  // scale — otherwise an override-scaled/rotated shape gets a band off by
  // 1/scale (the same class as the worldMatrix dilation composition above).
  // Right-multiply the linear rows by ovBasis (em→clip · ovBasis); the
  // perspective row m3 is untouched (m3.xy=0 in 2D ortho, so ovPos / translation
  // never enter the dilation). For an identity basis this is a no-op.
  if (uHasOverrides == 1) {
    m0.xy = m0.xy * ovBasis;
    m1.xy = m1.xy * ovBasis;
  }
  // Composed draw: aPos is a UNIT-quad corner (0/1); expand it to the shape's
  // AABB (uCoverBBox) here so the cover quad needs NO per-frame vertex upload —
  // only the uCoverBBox uniform changes. The default program (no
  // MANTLE_COMPOSED) reads aPos as the em corner verbatim.
  vec2 lbPos = aPos;
#ifdef MANTLE_COMPOSED
  lbPos = mix(uCoverBBox.xy, uCoverBBox.zw, aPos);
#endif
  vec2 dEm = coverQuadDilate(lbPos, aNormal, m0, m1, m3, uViewportSize);
// Both AAC and the Slug entry point integrate the full pixel box. Mixed
// programs also contain that kernel. Pure hard fills and mesh-only Slug
// programs retain their existing vertex path.
#if defined(MANTLE_AAC) || (!defined(MANTLE_NO_COVER_FILL) && (defined(MANTLE_HARD_MIXED) || defined(MANTLE_COVER_KERNEL) || (!defined(MANTLE_GWN) && !defined(MANTLE_HARD))))
  // Affine cover support: The bisector push above is half a pixel along ONE screen direction. Under a non-similarity affine map
  // (thin, sheared, anisotropic) an edge's pixel box reaches further than that in em space and the outermost AA ramp would fall outside
  // the cover. Every pixel touching an edge has its center within R of it, where R is the
  // furthest inverse-mapped pixel corner, R = sqrt(a^2+b^2+c^2+d^2 + 2|ac+bd|) / (2|det|) for the em -> pixel map [[a,b],[c,d]]. A
  // rectangle bisector (|n|^2 = 2) has unit support on both incident edges; a convex-fan miter carries sqrt(2). A similarity keeps
  // the tighter push above; a projective map keeps it too. Every term is a ratio of the map's own entries: no absolute epsilon.
  if (m3.x == 0.0 && m3.y == 0.0 && m3.w != 0.0) {
    vec2 aR0 = m0.xy * (0.5 * uViewportSize.x / m3.w), aR1 = m1.xy * (0.5 * uViewportSize.y / m3.w);
    float n0 = dot(aR0, aR0), n1 = dot(aR1, aR1), x01 = dot(aR0, aR1), dt = aR0.x * aR1.y - aR0.y * aR1.x;
    bool similar = abs(n0 - n1) <= 1e-5 * (n0 + n1) && abs(x01) <= 1e-5 * (n0 + n1);
    if (!similar && dt != 0.0) {
      float R = sqrt(n0 + n1 + 2.0 * abs(x01)) / (2.0 * abs(dt));
      float supp = dot(aNormal, aNormal) <= 2.000001 ? 1.0 : 1.41421356;
      vec2 dAff = aNormal * (R / supp);
      if (dot(dAff, dAff) > dot(dEm, dEm)) dEm = dAff;
    }
  }
#endif
  vec2 emDilated = lbPos + dEm;
  // A STRIP VERTEX (svg/strokeStrip.js; aEmCoord.x = 1 marks it, aEmCoord.y = its half-width in em; aEmCoord is read only
  // in 9-slice mode, which a strip bundle never uses). Its edge must sit where the stroke's coverage ramp ends: the coverage
  // ramp's reach ALONG THE EDGE'S SCREEN NORMAL, plus the half-width (a hairline is drawn at least half a pixel each side,
  // strokeEdgeCov's halfWMin, the AVERAGE of the map's two em-per-pixel axes). The generic dilation above pushes along the
  // bisector's own image J*n, which is the screen normal only for a similarity; on an anisotropic rotated map it falls short.
  // With J the em -> pixel Jacobian (override basis folded in), the screen normal of an edge of em normal n is J^-T n, the
  // ramp reaches 0.7072 px, and one em along n moves 1/|J^-T n| pixels along it, so the em offset that reaches it is
  // 0.7072 * |J^-T n|. aNormal is sqrt(2) times the edge normal (it moves each adjacent edge by
  // sqrt(2) per unit), hence the 1/sqrt(2). An LB vertex overwrites emDilated below, so the test costs it nothing.
  if (uHasEmCoord != 1 && aEmCoord.x > 0.5) {
    vec2 sr0 = m0.xy * (0.5 * uViewportSize.x), sr1 = m1.xy * (0.5 * uViewportSize.y);
    float sdet = sr0.x * sr1.y - sr0.y * sr1.x;
    if (abs(sdet) > 0.0 && dot(aNormal, aNormal) > 1e-12) {
      vec2 nS = normalize(aNormal);
      vec2 wS = vec2(sr1.y * nS.x - sr1.x * nS.y, -sr0.y * nS.x + sr0.x * nS.y) / sdet;   // J^-T n
      float wl = length(wS);
      if (wl > 0.0) {
        const float support = 0.7072;   // CP_AA_REACH: the stroke's coverage ramp reaches 0.7072 px from its edge in every direction (the box support half(|nx|+|ny|) is only the axis-aligned part)
        vec2 ePxS = vec2(abs(sr1.y) + abs(sr0.y), abs(sr1.x) + abs(sr0.x)) / abs(sdet);
        float floorPush = max(0.25 * (ePxS.x + ePxS.y) - aEmCoord.y, 0.0);
        emDilated = lbPos + aNormal * ((floorPush + support * wl) * 0.70710678);
      }
    }
  }
#ifndef MANTLE_NO_STROKE
  // A baked stroke cover bounds the nominal width. Grow it when the current
  // screen-space width or an absolute override exceeds that envelope.
  bool widthCover = true;
#ifdef MANTLE_LB_FILL
  widthCover = !MANTLE_IS_LB_VERT;
#endif
  if (widthCover && !(uHasEmCoord != 1 && aEmCoord.x > 0.5)
      && m3.x == 0.0 && m3.y == 0.0 && m3.w != 0.0) {
    vec4 widthCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, shapeIdx), 0);
    int widthFlags = int(widthCap.w + 0.5);
    if ((widthFlags & (1 | (1 << 13) | (1 << 14))) != 0 || (ovMask & 4) != 0) {
      float nominal = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, shapeIdx), 0).x;
      float width = (ovMask & 4) != 0 ? ovStrkW : nominal;
      vec2 r0 = m0.xy * (0.5 * uViewportSize.x / m3.w), r1 = m1.xy * (0.5 * uViewportSize.y / m3.w);
      float scale0 = max(abs(r0.x),abs(r0.y)), scale1 = max(abs(r1.x),abs(r1.y));
      vec2 n0 = scale0 > 0.0 ? r0/scale0 : vec2(0.0), n1 = scale1 > 0.0 ? r1/scale1 : vec2(0.0);
      float det = n0.x*n1.y-n0.y*n1.x;
      if (det != 0.0 && width > 0.0) {
        vec2 pixel = vec2(abs(n1.y)/scale0+abs(n0.y)/scale1, abs(n1.x)/scale0+abs(n0.x)/scale1)/abs(det);
        float extra = max(0.0, 0.5*(width*strokeWidthMultiplier(widthFlags,pixel)-nominal));
        int join = int(widthCap.y + 0.5), cap = int(widthCap.x + 0.5);
        float ml = max(1.0,widthCap.z), reach = join == 0 ? ml : (join == 3 || join == 4) ? sqrt(ml*ml+1.0) : 1.0;
        int endCap = int(texelFetch(uMetaTex,metaAt(MT_PRIM,shapeIdx),0).z+0.5);
        if (cap == 2 || endCap == 3) reach = max(reach,1.41421356);
        // Preserve the normal AA path; a scaled inverse also supplies a finite
        // fallback when its squared screen derivatives underflow or overflow.
        vec2 aa = dEm;
        if (any(isnan(aa)) || any(isinf(aa)) || all(equal(aa,vec2(0.0)))) {
          float largest = max(pixel.x,pixel.y);
          float radius = 0.5*largest*length(pixel/largest);
          aa = aNormal*radius;
        }
        emDilated = lbPos+aa+aNormal*(extra*reach);
      }
    }
  }
#endif
#ifdef MANTLE_CPATCH
  // Inverse affine em-to-device-pixel Jacobian, including draw and shape basis.
  // The extra raster grid unit encloses boundary centers after vertex quantization.
  if(aLbTC.z>2999.5 && aLbTC.z<3000.5 && m3.x==0.0 && m3.y==0.0 && m3.w!=0.0){
    vec2 r0=m0.xy*(0.5*uViewportSize.x/m3.w),r1=m1.xy*(0.5*uViewportSize.y/m3.w);
    float det=r0.x*r1.y-r0.y*r1.x;
    if(det!=0.0){gCpPixelX=vec2(r1.y,-r1.x)/det;gCpPixelY=vec2(-r0.y,r0.x)/det;
      gCpPixelValid=!any(isnan(gCpPixelX))&&!any(isinf(gCpPixelX))&&!any(isnan(gCpPixelY))&&!any(isinf(gCpPixelY));}
  }
#endif
#if defined(MANTLE_CPATCH) && !defined(MANTLE_CPATCH_NO_QUADRATIC_AREA)
  // A box enlarged by this common inverse-Frobenius bound contains every
  // pixel touching the authored hull. Direction-by-direction normalization
  // moves different corners by different amounts and can shrink an edge.
  vec2 cpPx0=m0.xy*(0.5*uViewportSize.x),cpPx1=m1.xy*(0.5*uViewportSize.y);
  float cpDet=cpPx0.x*cpPx1.y-cpPx0.y*cpPx1.x;
  gCpAreaEpp=sqrt(dot(cpPx0,cpPx0)+dot(cpPx1,cpPx1))/max(abs(cpDet),1e-30);
#endif
#ifdef MANTLE_LB_FILL
  // An LB triangle brings its own dilation: lbVertexSetup applies the per-kind
  // AA expansion and returns the em position, which then goes through the same
  // em->clip projection below as a cover quad. That shared projection is what
  // lets both live in one draw and one painter sort.
  if (MANTLE_IS_LB_VERT) {
    // MORPH: mix the two endpoint packs, then run the STATIC setup on the result.
    // Everything downstream — dilation, the implicit, the coverage kernel — is
    // the static code path, which is the property worth protecting: a morph frame
    // at t=0 or t=1 renders through exactly the same math as the static draw of
    // that endpoint. A cover quad's twin is written equal to its own position, so
    // the mix is the identity there and needs no branch.
#ifdef MANTLE_LB_MORPH
    vec2 mPos = mix(aPos, aPosB, uMorphT);
    vec3 mTC  = mix(aLbTC, aLbTCB, uMorphT);
    vec4 c0A = LB_C0, c0B = LB_C0B, c3A = LB_C3, c3B = LB_C3B;
    vec4 mC0  = mix(c0A, c0B, uMorphT);
    // A kind-10 corner record holds its two neighbor edge NORMALS in c0 (xy, zw). A lerp of two unit vectors is shorter than
    // unit between them (|n| = 0.707 halfway through a quarter turn), and the coverage kernel reads those as unit plane
    // normals, so the corner's edge strips sat off their planes for the whole morph (5-7 bytes at mid-pose, exact at both ends).
    if (aFlags.x > 9.5 && aFlags.x < 10.5) {
      float n0 = length(mC0.xy), n1 = length(mC0.zw);
      mC0 = vec4(n0 > 1e-6 ? mC0.xy / n0 : mC0.xy, n1 > 1e-6 ? mC0.zw / n1 : mC0.zw);
    }
    vec4 mC3  = mix(c3A, c3B, uMorphT);
    // The packed slots, lerped as the vectors they hold (lbMixHalfUnit above; the cubic klm gradient pair has
    // its own codec, lbMixKlmGrad in _lbVertexSetup.glsl, since it is a shared-exponent pair and not two
    // halves). Kind, sign and seam mark have no twin: both endpoint packs come from one partition, so the
    // source stream's say which slots are packed.
    bool band12M = aFlags.x > 11.5 && aFlags.x < 12.5;
    if (band12M && abs(aFlags.y) >= 8192.0) mC0.z = lbMixKlmGrad(c0A.z, c0B.z, uMorphT);
    if (aFlags.x > 3.5 && aFlags.x < 4.5 && aSeamM > 5.0) mC3.w = lbMixHalfUnit(c3A.w, c3B.w, uMorphT);
#ifdef MANTLE_NO_BEZOUT
    emDilated = lbVertexSetup(mPos, mTC, mC0, mC3);
#else
    vec4 c2A = LB_C2, c2B = LB_C2B;
    vec4 mC2 = mix(c2A, c2B, uMorphT);
    if (band12M) { mC2.x = lbMixHalfUnit(c2A.x, c2B.x, uMorphT); mC2.y = lbMixHalfUnit(c2A.y, c2B.y, uMorphT); }
    emDilated = lbVertexSetup(mPos, mTC, mC0, mix(LB_C1, LB_C1B, uMorphT), mC2, mC3);
#endif
#else
#ifdef MANTLE_NO_BEZOUT
    emDilated = lbVertexSetup(aPos, aLbTC, LB_C0, LB_C3);
#else
    emDilated = lbVertexSetup(aPos, aLbTC, LB_C0, LB_C1, LB_C2, LB_C3);
#endif
#endif
#ifdef MANTLE_CPATCH
    // A CPatch cover vertex comes back in its contour's frame; everything below reads world em.
    if (aFlags.x > CP_STREAM_TAG - 0.5 && aFlags.x < CP_STREAM_TAG + 0.5) emDilated += LB_C2.zw;
#endif
#ifndef MANTLE_LB_NO_EDGE_STRIP
    // EDGE_STRIP: the two corners' shared planes, in canvas pixels (lbCornerPlanePx above). vLB1/vLB2 are free on this
    // kind and are written here in every variant, MANTLE_NO_BEZOUT included.
    if (aFlags.x > 9.5 && aFlags.x < 10.5) {
      vec4 cw10 = LB_C1, cc10 = LB_C2;
#ifdef MANTLE_LB_MORPH
      // A plane both endpoint packs carry, lerped as the vectors it is. An end with a plane at only one endpoint (a line
      // corner that is a curve corner at the other) takes none at any t, so its two strips still agree.
      vec4 cw10B = LB_C1B;
      cw10 = vec4(dot(cw10.xy, cw10.xy) > 0.0 && dot(cw10B.xy, cw10B.xy) > 0.0 ? mix(cw10.xy, cw10B.xy, uMorphT) : vec2(0.0),
                  dot(cw10.zw, cw10.zw) > 0.0 && dot(cw10B.zw, cw10B.zw) > 0.0 ? mix(cw10.zw, cw10B.zw, uMorphT) : vec2(0.0));
      cc10 = mix(cc10, LB_C2B, uMorphT);
#endif
      mat3 H10 = lbEmToClipH(e0, e1, ovBasis, ovPos, wWorldM, wHasWorldM, shapeIdx);
      vLB1 = lbCornerPlanePx(cc10.xy, cw10.xy, H10);
      vLB2 = lbCornerPlanePx(cc10.zw, cw10.zw, H10);
    }
#endif
  } else {
#ifdef MANTLE_COVER_KERNEL
    // the cover-quad kernel id rides aLbMeta.y, which a cover vertex zeroes and
    // which nothing else reads — `.x > 0.5` is the "this is an LB vertex" test just above, and
    // `.z` is NOT free (the fragment reads it as vSeam to learn that a stroke-segment quad owns
    // the stroke). Step (2): it reaches the fragment on vKind as -1 - id, so the shader's
    // `vKind < 0.0` / `vKind >= 0.0` tests keep their meaning and no varying is added.
    vKind = -1.0 - aLbMeta.y;
#else
    vKind = -1.0;   // cover quad: the fragment takes its normal coverage path
#endif
  }
#endif

  vec2 emTransformed = (uHasOverrides == 1)
    ? ovBasis * emDilated + ovPos
    : emDilated;

  vEmCoord = (uHasEmCoord == 1) ? aEmCoord : emDilated;
#ifdef MANTLE_CPATCH
  // A CPATCH FRAGMENT'S EM POSITION IS TAKEN RELATIVE TO ITS CONTOUR'S CORNER, which
  // the packer put in aC2.zw and packed the kernel's texels against, and the fragment adds it back for
  // everything that is not the kernel (paint, clips). The vertex arrives in that frame already: its
  // world position, rounded to float32 where the contour sits, would quantize the kernel's position --
  // 1/128 of a unit at 1e5, 1/8 at 1e6 -- and place the cover a rounding off the seams the kernel cuts
  // exactly, so the one patch that did rasterize a pixel would be told it belonged to the other. Under
  // an override or a 9-slice the world path stands.
  bool cpV = MANTLE_IS_LB_VERT && aFlags.x > CP_STREAM_TAG - 0.5 && aFlags.x < CP_STREAM_TAG + 0.5;
  bool cpLocalOk = cpV && uHasOverrides != 1 && uHasEmCoord != 1;
  if (cpV) vEmCoord = cpLocalOk ? gCpLocal : vEmCoord - LB_C2.zw;
#endif

  vec2 uv = (emTransformed - uGlobalBBox.xy) / uGlobalBBox.zw;
#ifdef MANTLE_CPATCH
  // ...and projected from the frame: O minus the box corner is one rounding shared by the whole contour,
  // so its patches' covers keep their relative placement to the precision of their own size.
  if (cpLocalOk) uv = (gCpLocal + (LB_C2.zw - uGlobalBBox.xy)) / uGlobalBBox.zw;
#endif
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  float z = (uNumShapes > 0.0) ? (1.0 - float(shapeIdx) / uNumShapes) : 0.0;
  // Per-draw world transform. 3×3 mat applied to
  // (plane.x, -plane.y, 1.0). Identity by default — non-COLR
  // paths leave this off and pay nothing.
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  int footprintVectorEffects = 0;
  if (wHasWorldM == 1) {
    // SVG 2 vector-effect: selectively cancel parts of uWorldM (the
    // supplemental transform applied at draw time) per flagsShape.
    //   bit 10 = non-scaling-size — undo uniform scale
    //   bit 11 = non-rotation     — undo rotation
    //   bit 12 = fixed-position   — undo translation
    // Decomposition assumes a similarity uWorldM (rotation + uniform
    // scale + translation), the common case for SVG/CSS transforms.
    // For an arbitrary affine, only the translation cancellation is
    // exact; the rotation/scale cancellation degrades gracefully
    // (the polar decomposition extracts the closest rotation).
    //
    // Anchoring: scale/rotation cancellation pivots around the shape's
    // bbox-center projected through the em→NDC pipeline (so the shape
    // stays put while only the supplemental scale/rot is removed).
    vec4 cj = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, shapeIdx), 0);
    int flagsShape = int(cj.w + 0.5);
    footprintVectorEffects = flagsShape & 7168;
    bool nonScalingSize = (flagsShape & 1024) != 0;
    bool nonRotation    = (flagsShape & 2048) != 0;
    bool fixedPosition  = (flagsShape & 4096) != 0;
    if (nonScalingSize || nonRotation || fixedPosition) {
      // Project the shape's bbox center through the same em→NDC chain
      // so the anchor lives in clip space (where uWorldM applies).
      vec4 bb = texelFetch(uMetaTex, metaAt(MT_BBOX, shapeIdx), 0);
      vec2 anchorEm = vec2((bb.x + bb.z) * 0.5, (bb.y + bb.w) * 0.5);
      vec2 anchorUV = (anchorEm - uGlobalBBox.xy) / uGlobalBBox.zw;
      vec2 anchorPlane = (anchorUV * 2.0 - 1.0) * uCanvasAR;
      vec2 anchorClip = vec2(anchorPlane.x, -anchorPlane.y);

      // Decompose uWorldM linear part (column-major in mat3):
      //   col0 = (m00, m10, 0), col1 = (m01, m11, 0), col2 = (tx, ty, 1)
      float m00 = wWorldM[0][0], m10 = wWorldM[0][1];
      float m01 = wWorldM[1][0], m11 = wWorldM[1][1];
      vec2 t    = wWorldM[2].xy;
      // Polar decomposition (similarity assumption): scale = column-0
      // length; rotation = arg(col0). For skewed matrices this is the
      // best-fit rotation.
      float scale = max(sqrt(m00 * m00 + m10 * m10), 1e-30);
      float cR = m00 / scale, sR = m10 / scale;
      // Reconstructed scale matrix S, rotation matrix R, translation t
      // such that uWorldM ≈ T * R * S * (vertex - origin) + origin.
      // Build the EFFECTIVE world matrix by zeroing out the canceled
      // parts.
      vec2 effScale = nonScalingSize ? vec2(1.0) : vec2(scale);
      mat2 effR = nonRotation
        ? mat2(1.0, 0.0, 0.0, 1.0)
        : mat2(cR, sR, -sR, cR);  // GLSL column-major
      vec2 effT = fixedPosition ? vec2(0.0) : t;

      // Apply: effClip = effT + effR * (effScale * (vertexClip - anchor)) + anchor
      vec2 d = clip3.xy - anchorClip;
      d *= effScale;
      d = effR * d;
      clip3.xy = d + anchorClip + effT;
    } else {
      // THE MATRIX'S CONSTANT TERM IS SUMMED FIRST ONCE THE SCALE WOULD MAGNIFY THE PLANE'S ROUNDING PAST THE RASTER GRID. The plane above
      // rounds to the ulp of 1, which a matrix of scale s and a viewport of v px turns into s * v * 2^-24 px: past 1/256 px a vertex lands off
      // the em vEmCoord keeps (at 2^16 on a 512 px canvas it moves in 2 px steps, and fragments read an em half a pixel from where they are). As the
      // linear part plus the constant (the order lbEmToClipH already uses), a translation that brings the art into view cancels before anything
      // rounds, and the position is as exact as em itself. Under that scale both forms name one point to within the grid, so the form stays.
      float worldReach = max(max(abs(wWorldM[0].x), abs(wWorldM[0].y)), max(abs(wWorldM[1].x), abs(wWorldM[1].y))) * max(uViewportSize.x, uViewportSize.y);
      if (worldReach >= 65536.0) {
        vec2 emClip = emTransformed, clipConst = vec2(e0.w, e1.w);
#ifdef MANTLE_CPATCH
        if (cpLocalOk) { emClip = gCpLocal; clipConst += vec2(e0.x, e1.y) * LB_C2.zw; }
#endif
        clip3 = wWorldM * vec3(vec2(e0.x, e1.y) * emClip, 0.0) + wWorldM * vec3(clipConst, 1.0);
      } else {
        clip3 = wWorldM * clip3;
      }
    }
  }
  // Affine em-to-framebuffer Jacobian, constant for the complete cover.
  // Nine-slice coordinates and vector effects retain interpolated derivatives.
  bool affineWorld = wHasWorldM != 1 ||
    (wWorldM[0].z == 0.0 && wWorldM[1].z == 0.0 && wWorldM[2].z == 1.0);
  if (uHasEmCoord == 0 && affineWorld && footprintVectorEffects == 0) {
    vec2 scale = vec2(2.0, -2.0) * uCanvasAR / uGlobalBBox.zw;
    mat2 jacobian = mat2(scale.x, 0.0, 0.0, scale.y) * ovBasis;
    if (wHasWorldM == 1) jacobian = mat2(wWorldM) * jacobian;
    jacobian = mat2(uViewportSize.x * 0.5, 0.0, 0.0, uViewportSize.y * 0.5) * jacobian;
    float det = determinant(jacobian);
    if (det != 0.0) {
      mat2 footprint = inverse(jacobian);
      vec4 packed = vec4(footprint[0], footprint[1]);
      if (!any(isnan(packed)) && !any(isinf(packed))) vAffineFootprint = packed;
    }
  }

  bool plainCover = uHasEmCoord == 0 && aEmCoord.x <= .5;
#ifdef MANTLE_LB_FILL
  plainCover = plainCover && aLbMeta.x <= .5;
#endif
  // Clip oversized axis-aligned covers before rasterization loses their span.
  // Reconstruct sample coordinates from the same inverse projection.
  bool axisWorld = wHasWorldM != 1 || (affineWorld && wWorldM[0].y == 0.0 && wWorldM[1].x == 0.0);
  if (plainCover && axisWorld && footprintVectorEffects == 0
      && abs(aNormal.x) == 1.0 && abs(aNormal.y) == 1.0
      && ovBasis[0].y == 0.0 && ovBasis[1].x == 0.0 && ovBasis[0].x != 0.0 && ovBasis[1].y != 0.0
      && any(greaterThan(abs(clip3.xy), vec2(16384.0 * abs(clip3.z))))) {
    vec2 worldScale = wHasWorldM == 1 ? vec2(wWorldM[0].x, wWorldM[1].y) : vec2(1.0);
    if (worldScale.x != 0.0 && worldScale.y != 0.0) {
      vec2 ndc = clamp(clip3.xy / clip3.z, vec2(-1.0), vec2(1.0));
      // The position's own inverse, its constant summed first as above.
      vec2 worldOffset = wHasWorldM == 1 ? wWorldM[2].xy : vec2(0.0);
      vec2 document = (ndc - (worldScale * vec2(e0.w, e1.w) + worldOffset)) / (worldScale * vec2(e0.x, e1.y));
      vEmCoord = (document - ovPos) / vec2(ovBasis[0].x, ovBasis[1].y);
      clip3.xy = ndc * clip3.z;
    }
  }
  // SUBPIXEL-exact COVER VERTICES OF A NON-SIMILARITY MAP. A rasterizer rounds every vertex to a fixed subpixel grid (1/256 px
  // on common GPUs) before it interpolates, but vEmCoord is an exact affine function of the UNROUNDED vertex. The
  // rounding therefore tilts the em plane across the quad by up to half a grid step per vertex, and the coverage kernel reads
  // that tilted position: an edge pixel's alpha moves by up to (1/512 px) x opacity x 255, a quarter of an 8-bit level, in a
  // direction that depends on where the dilated corner happened to fall on the grid. Under a similarity (uniform scale, with
  // or without rotation) the margin is the default half pixel along the bisector, the same for every exact-cover policy, so
  // the rounding is the same either way and the vertex is left alone. Under any other affine map the exact-cover margin
  // differs from the half-pixel one per axis, lands the corner elsewhere on the grid, and moves edge pixels (a mirrored
  // anisotropic map loses accuracy to it). There, round the vertex here, onto the grid, and move vEmCoord by the same
  // displacement through the draw's constant pixel -> em Jacobian: the rasterizer's rounding is then the identity and every
  // vertex is exact. The window range bound is the float32 reach of the grid (a coordinate past it has no 1/256 resolution to
  // preserve); an oversized or perspective cover keeps the value it had. The similarity test is the affine-support block's,
  // a ratio of the map's own entries, with the skew floor below.
  if (plainCover && clip3.z > 0.0 && dot(vAffineFootprint, vAffineFootprint) > 0.0) {
    vec2 sR0 = m0.xy * (0.5 * uViewportSize.x), sR1 = m1.xy * (0.5 * uViewportSize.y);
    float sn0 = dot(sR0, sR0), sn1 = dot(sR1, sR1), sx01 = dot(sR0, sR1);
    // The margin differs from a plain half pixel by about half the map's relative skew, in pixels; below one grid
    // step's half (1/512 px, a skew of 1/256) the corner lands on the same grid point and there is nothing to correct.
    bool nonSimilar = abs(sn0 - sn1) > (1.0 / 256.0) * (sn0 + sn1) || abs(sx01) > (1.0 / 256.0) * (sn0 + sn1);
    vec2 halfVp = 0.5 * uViewportSize;
    vec2 win = clip3.xy / clip3.z * halfVp + halfVp;
    if (nonSimilar && max(abs(win.x), abs(win.y)) < 8192.0) {
      vec2 snapped = floor(win * 256.0 + 0.5) * (1.0 / 256.0);
      vEmCoord += mat2(vAffineFootprint.xy, vAffineFootprint.zw) * (snapped - win);
      clip3.xy = (snapped - halfVp) / halfVp * clip3.z;
    }
  }
  gl_Position = vec4(clip3.xy, z, clip3.z);
}
