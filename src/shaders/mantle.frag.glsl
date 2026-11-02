#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
precision highp float;
#ifndef MANTLE_NO_FILTER
uniform float uFilterCoverageScale;
#endif
 precision highp int; precision highp sampler2D;
uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
// uDashTex feeds dashed strokes. Not feature-gated: dashOut (its consumer)
// is called by the shared stroke-coverage helpers (strokeMinDist), which aren't
// gated. Stays declared; dead-strips at runtime if unused.
uniform sampler2D uDashTex;        // 16 wide × N tall; row = dashId-1
#ifndef MANTLE_NO_GRADIENT
uniform sampler2D uGradientTex;    // RGBA32F, 4 texels wide × N gradients
uniform sampler2D uGradientStops;  // RGBA8 packed stops LUT, 1 or 2 texels/stop
                                   // (see _gradientHelpers.glsl): 2-texel layout
                                   // = STRAIGHT RGBA + a separate offset texel;
                                   // 1-texel opaque fast path = (rgb, offset),
                                   // implicit alpha 1. stopsOffset is a TEXEL
                                   // offset; stopsCount's sign picks the layout
                                   // ((stopsOffset, stopsCount) live in the
                                   // gradient record at texel 10's xy).
                                   // Exact stops, no banding,
                                   // shared format with the COLRv1 dispatch.
#endif
#ifndef MANTLE_NO_IMAGE
uniform sampler2D uSecondaryImageTex;
uniform vec2 uSecondaryImageAtlasSize;
uniform sampler2D uImageTex;       // RGBA8 image atlas (pattern children + top-level <image>)
uniform vec2      uImageAtlasSize; // pixel dims of uImageTex (for u/v scale)
#endif
#ifndef MANTLE_NO_FILTER
uniform sampler2D uFilterTex;      // RGBA32F, 6 wide × N filters tall (color matrix + kind/sigma)
#endif
uniform vec4 uGlobalBBox;
// The vertex stage's em -> clip uniforms, read here by the Loop-Blinn chain kernels, which clip the
// pixel box in DEVICE pixels (lbChainCellMap). Same declarations as mantle.vert.glsl.
uniform vec2 uCanvasAR;
uniform mat3 uWorldM;
uniform int uHasWorldM;
// Per-shape override table — same texture the vertex shader reads.
// Frag side consumes only the 2D affine (texel 0) + translate (texel 1.xy)
// of the clip's first layer row, to invert-transform the visible shape's
// sample coord before evaluating clip coverage (animatable
// clipper). When uHasOverrides == 0 the inverse is identity and the
// branch collapses.
// Frag-side override use is only transformClipCoord (animated clip / mask
// geometry), so the decls drop when both clip and mask are omitted.
#if !defined(MANTLE_NO_CLIP) || !defined(MANTLE_NO_MASK)
uniform sampler2D uOverrideTex;
uniform int       uHasOverrides;
#endif
// Multi-shape mask offscreen RT.
// uMaskRTArray: TEXTURE_2D_ARRAY (R8), one layer per FLAG_MASK_BEGIN
// region in the bundle. uMaskRowToLayerTex: R32I 1×numShapes — entry
// (maskId-1) holds the layer index, or -1 to fall back to the inline
// kMaxMaskChildren walk. uHasOffscreenMask gates the entire branch off
// when the renderer didn't bake (e.g. maskBake program not bundled).
// Texture lookup (not uniform int[]) keeps us out of trouble on
// drivers with low uniform component caps and supports any shape count.
#if !defined(MANTLE_NO_MASK) || !defined(MANTLE_NO_PATTERN)
uniform highp sampler2DArray uMaskRTArray;
uniform highp isampler2D uMaskRowToLayerTex;
uniform int uHasOffscreenMask;
uniform int uHasPatternGroups;
#endif
uniform vec2 uViewportSize;
uniform vec2 uFragOrigin;
// External screen-space clip mask (`setNodeClip`). A fixed R8/RGBA
// coverage texture sampled in FRAMEBUFFER space, applied to the whole draw:
//   uExtClipMode 0 = off (default), 1 = clip-IN (keep where mask), 2 = clip-OUT
//   (destination-out — keep where mask is EMPTY, i.e. erase by the shape).
// Additive + default-off, so non-clipped draws are byte-identical.
#ifndef MANTLE_NO_EXTCLIP
uniform sampler2D uExtClipTex;
uniform int uExtClipMode;
#endif
// Per-draw bilinear channel-lerp recolor (bilinear recolor).
// Implements the unlit-vector formula:
//   tint = in.r · primary + in.b · contrast
//   out  = mix(tint, highlight, in.g + 1 - in.a)
//   out.a = in.a
// Genuinely non-linear in the input (R·G and B·G cross terms), so it
// can't be expressed via the linear color matrix — needs its own path.
// Use case: sprites where R = body intensity, B = accent intensity,
// G = white-highlight intensity, A also drives the highlight lerp.
// Pure white pixels (R=G=B=1) → highlight; pure red → primary; pure
// blue → contrast; intermediate G adds white.
//
#if !defined(MANTLE_NO_RECOLOR) && !defined(MANTLE_NO_CHANNEL_LERP)
uniform vec4 uChannelLerpPrimary;
uniform vec4 uChannelLerpContrast;
uniform vec4 uChannelLerpHighlight;
uniform int  uChannelLerpEnabled;
#endif

//
// uColorMatrixEnabled is a coherent (per-draw) uniform int; the
// branch is uniform across the whole draw → free on every modern GPU
// when disabled. Defaults: identity matrix + zero offset, enabled=0.
#if !defined(MANTLE_NO_RECOLOR) && !defined(MANTLE_NO_COLOR_MATRIX)
uniform mat4 uColorMatrix;
uniform vec4 uColorMatrixOffset;
uniform int  uColorMatrixEnabled;
#endif

//
// uPaletteChannel: 0 = R, 1 = G, 2 = B, 3 = A. Caller picks which
// channel of vFill encodes the index. Default is R (aligned with the
// color matrix's R-as-primary convention).
//
// uPaletteSize: number of valid entries in the LUT (1..256). The
// index is `clamp(floor(channel * uPaletteSize), 0, uPaletteSize - 1)`.
// Sampling is NEAREST; entries are discrete and unrelated colors,
// linear interpolation between them would be a bug.
//
// uPaletteEnabled coherent uniform-int → zero cost when disabled.
#if !defined(MANTLE_NO_RECOLOR) && !defined(MANTLE_NO_PALETTE)
uniform sampler2D uPalette;
uniform int uPaletteEnabled;
uniform int uPaletteChannel;
uniform int uPaletteSize;
#endif
// Interior-skip occupancy: 1 when this bundle baked any interior grids (opt-in
// opts.occupancyGrid). Coherent per-draw → the whole occupancy branch is free
// (no meta fetch) on the default path where it's 0.
uniform int uHasOccupancy;
//
//   MANTLE_COMPOSED      — this is a per-shape composed draw: paint comes from
//                          uniforms (no per-frame meta upload) and the VERT
//                          expands a unit quad from uCoverBBox.
//   MANTLE_LB_FILL_COV   — fCov comes from a pre-rendered Loop-Blinn coverage
//                          RT instead of the per-fragment ray-cast. LB fill only.
// (There is no stroke-coverage RT source: the in-shader band walk measures
// BETTER than a composed split-stroke RT would, so such an RT would be a pass per
// shape and an 8-bit quantization of every stroke's AA in exchange for nothing.)
//
// Everything below tests the specific concern, not the bundle, so
// `MANTLE_COMPOSED + MANTLE_AAC` is a valid program: AAC computes the fill
// in-shader while clip/mask/stroke compose over it.
//
// The composed variants carry these samplers so the DEFAULT program gains no
// extra sampler. Clip/mask/stroke/filter all run BELOW the fCov seam and so
// compose with whichever fill ran. renderFill stays available for
// clip/mask/pattern CHILDREN (separate geometry); MANTLE_NO_* still drops it.
#ifdef MANTLE_LB_FILL_COV
  #define MANTLE_ANY_COV_TEX
#endif
#ifdef MANTLE_ANY_COV_TEX
#ifdef MANTLE_LB_FILL_COV
uniform sampler2D uLBCovTex;        // R8/RGBA8 LB fill coverage, screen-space
#endif
// Allocated texel size of the coverage RTs (pooled, rounded UP to the pool
// quantum — so ≥ viewport). The coverage is rendered into the bottom-left
// viewport-sized region, so screen→UV must divide by this, not uViewportSize,
// or the sample reads past the rendered region (shrunk/empty fill).
uniform vec2 uLBCovTexSize;
#endif
// Per-shape paint fed as uniforms (NOT from uMetaTex) so a composed shape needs
// ZERO per-frame meta upload: the route lerps these on the CPU and sets them per
// composed shape. Structural meta (clipId/maskId/gradId/strokeWidth/…) is read
// from uMetaTex as usual (it doesn't morph).
#ifdef MANTLE_COMPOSED
uniform vec4 uLBShapeBBox;          // lerped tight shape bbox (gradient objectBoundingBox)
uniform vec4 uLBFill;               // lerped fill color
uniform vec4 uLBStroke;             // lerped stroke color
uniform vec4 uLBImageRect;          // lerped image rect (texel 9) — fill/stroke bitmap mapping
#endif
flat in int vInst;
in vec2 vEmCoord;
flat in vec4 vAffineFootprint;
in vec4 vOverrideTint;     // multiplied into fill+stroke color
#ifdef MANTLE_INSTANCED
in vec4 vInstBias;         // per-instance additive bias, applied after the tint
#endif
// Per-attribute absolute overrides (animation drivers). When the
// corresponding mask bit is set, the override replaces the meta value
// at draw time. Mask bits:
//   0x1 = fill, 0x2 = stroke, 0x4 = strokeWidth.
flat in int vOverrideMask;
in vec4 vOverrideFill;
in vec4 vOverrideStroke;
in float vOverrideStrokeWidth;
out vec4 fragColor;

// Exact-area stroke edges, 1 = on (the default). See the use site below.
uniform int uStrokeExactAa;

#ifndef MANTLE_NO_FILTER
// uses these; the lean variant drops them (and the uFilterTex sampler).
// Apply feColorMatrix to an unpremultiplied RGBA; row is the filter's texel row, and its kind is a
// color matrix (applyFilterPre has already passed kinds >= 2 through).
vec4 applyFilter(int row, vec4 c) {
  vec4 r0 = texelFetch(uFilterTex, filterAt(FT_R0, row), 0);
  vec4 r1 = texelFetch(uFilterTex, filterAt(FT_R1, row), 0);
  vec4 r2 = texelFetch(uFilterTex, filterAt(FT_R2, row), 0);
  vec4 r3 = texelFetch(uFilterTex, filterAt(FT_R3, row), 0);
  vec4 off = texelFetch(uFilterTex, filterAt(FT_OFF, row), 0);
  vec4 o;
  o.r = dot(r0, c) + off.x;
  o.g = dot(r1, c) + off.y;
  o.b = dot(r2, c) + off.z;
  o.a = dot(r3, c) + off.w;
  return clamp(o, 0.0, 1.0);
}


vec4 applyFilterPre(int filterId, vec4 pre) {
  if (filterId <= 0) return pre;
  int row = filterId - 1;
  if (int(texelFetch(uFilterTex, filterAt(FT_META, row), 0).x + 0.5) >= 2) return pre;
  float a = pre.a;
  vec3 rgb = a > 0.0 ? pre.rgb / a : pre.rgb;
  vec4 outU = applyFilter(row, vec4(rgb, a));
  return vec4(outU.rgb * outU.a, outU.a);
}
#endif

// Stop sampling + extend modes come from _gradientHelpers.glsl, the
// same source the COLRv1 paintLinear/Radial/Sweep shaders use. The
// helper expects `uniform sampler2D uGradientStops` to be declared in
// the preamble (above). Translates the "spread" argument
// (0=pad, 1=reflect, 2=repeat) into the helper's mode
// (0=pad, 1=repeat, 2=reflect) inline at the call site.
@@GRADIENT_HELPERS@@

@@COVERAGE@@

//
// Opt-in (MANTLE_LB_FILL) rather than MANTLE_NO_*: nothing routes through it
// yet, and every existing variant would otherwise pay the compile.
#ifdef MANTLE_LB_FILL
#define vEm vEmCoord           // LB's em-space sample coord IS the ubershader's
#define LB_FLAT flat in
#define LB_SMOOTH in
@@LB_VARYINGS@@
#undef LB_FLAT
#undef LB_SMOOTH
@@CPATCH_COVERAGE@@
@@LB_COVERAGE@@
#endif
// Read the clip-row's override transform (2D affine M = mat2 + translate
// t) and INVERT-apply it to the visible shape's sample coord. Returns
// the coord in the clip's local frame. When the override is identity
// (the default) the result equals the input — branch is uniform per
// draw, so the cost is one sampler fetch + a few mads.
//
// Animatable clipper: setClipper(svgId, opts)
// writes M, t into the layer row's override slot; the shader inverts
// on the fly so the clip mask appears translated / scaled / rotated
// in world space while the clipped shapes stay put. transformClipCoord
// is shared with maskBake.frag via @@OVERRIDE_TRANSFORM@@ so animated
// <mask> children transform identically.
@@OVERRIDE_TRANSFORM@@


#ifdef MANTLE_ROTATED_MAP
#define PATTERN_CHILD_PIXEL cMx, cMy
// The em -> device-pixel map's columns taken to a mask child's local frame: em = M local + t, so the map there is (mx my) M. A mirror reflects the y
// row once more, as main forms slMx and slMy. An override that does not move the basis leaves them bit for bit.
void childMap(int row, inout vec2 mx, inout vec2 my) {
#if !defined(MANTLE_NO_CLIP) || !defined(MANTLE_NO_MASK)
  if (uHasOverrides != 1) return;
  vec4 m = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  if (m == vec4(1.0, 0.0, 0.0, 1.0)) return;
  float det = m.x * m.w - m.y * m.z;
  if (!(abs(det) > 2.384185791015625e-7 * (abs(m.x * m.w) + abs(m.y * m.z)))) return;   // as transformClipCoord
  vec2 lx = mx * m.x + my * m.z, ly = mx * m.y + my * m.w;
  if (det < 0.0) { lx.y = -lx.y; ly.y = -ly.y; }
  mx = lx; my = ly;
#endif
}
float childFill(vec2 c, vec2 mx, vec2 my, ivec4 cGD, bool evenOdd, vec4 cBB) {
#ifdef MANTLE_AAC
  return renderFillAACM(c, mx, my, cGD, evenOdd, cBB);
#else
  return renderFillM(c, mx, my, cGD, evenOdd, cBB);
#endif
}
#else
#define PATTERN_CHILD_PIXEL cInvPx
float childFill(vec2 c, vec2 invPx, ivec4 cGD, bool evenOdd, vec4 cBB) {
#ifdef MANTLE_AAC
  return renderFillAAC(c, invPx, cGD, evenOdd, cBB);
#else
  return renderFill(c, invPx, cGD, evenOdd, cBB);
#endif
}
#endif

// A <clipPath>'s coverage at a point: evalClipCoverageAtRow (the union's raw coverage) and evalClipCoverage (each child
// cut by its own clip-path, depth 1), shared with maskBake.frag.
@@CLIP_WALK@@

// An axis-aligned rect's coverage is the pixel box's overlap with it. The pixel is ePx em on a side
// (fwidth of em, taken in uniform flow), centered on p. A one-pixel SDF ramp -- clamp(0.5 - d / g) with the gradient g
// floored at 1e-6 em per pixel -- is exact only on an axis-aligned straight edge: a circle would be off by up to 0.045
// at scale 1, and at 2^-20 (a pixel about 1e-6 em) the floor would bind and the ramp be 0.15 off. Circles, round rects and
// a rect under a rotated, skewed or axis-swapping map take the fill walk, which is the exact box coverage.
// Only a zero derivative is guarded, as invPx's: 1e-30 sits below every float32 pixel size a fill can resolve.
float primRectCoverage(vec2 p, vec4 bb, vec2 ePx) {
  vec2 w = max(ePx, vec2(1e-30));
  vec2 a = max(p - 0.5 * w, bb.xy);
  vec2 b = min(p + 0.5 * w, bb.zw);
  vec2 ov = max(b - a, vec2(0.0));
  return (ov.x / w.x) * (ov.y / w.y);
}

// A circle's or a round rect's coverage past the arc walk's float32 bound (primDeep, in main). `rx` is the corner radius; the circle is the
// round rect whose corner is its whole half-extent, so it passes half its box. Each axis's distance past the box, `a`, is a difference of
// nearby floats and exact, and the corner's distance is (|o|^2 - r^2) / (|o| + r) with the major axis's square factored through `a`, so the
// radius's magnitude never enters by subtraction. The ramp is one pixel along the normal: this only runs where the coordinates themselves
// round by a pixel or more, and that noise swamps the shape of the ramp.
float primDeepCoverage(vec2 p, vec4 bb, float rx, vec2 emDx, vec2 emDy) {
  vec2 a = max(bb.xy - p, p - bb.zw);
  vec2 e = a + rx;
  if (e.x <= 0.0 && e.y <= 0.0) return 1.0;       // inside the box the corners are cut from: at least a radius from any edge
  vec2 o = max(e, vec2(0.0));
  float len = length(o);
  float d = (o.y >= o.x ? o.x * o.x + a.y * (o.y + rx) : o.y * o.y + a.x * (o.x + rx)) / (len + rx);
  vec2 n = o / len;
  n.x = (p.x < 0.5 * (bb.x + bb.z)) ? -n.x : n.x;
  n.y = (p.y < 0.5 * (bb.y + bb.w)) ? -n.y : n.y;
  float g = max(abs(dot(n, emDx)) + abs(dot(n, emDy)), 1e-30);
  return clamp(0.5 - d / g, 0.0, 1.0);
}

// Which cover kernel this row wants.
// Two sources for one answer, and nothing else in
// the selection chain below changes, which is what makes the default byte-identical:
//
//   * PER SHAPE (default) — `flagsShape` bits 15-16, stamped in bundleFinalize where a later opaque
//     stroke provably hides this fill's edge. One value for every cover quad the row owns.
//   * PER ENTRY (MANTLE_COVER_KERNEL) — the id rides the cover vertex's otherwise-zero `aLbMeta.y`
//     (`.z` is NOT free: the fragment reads it as vSeam) and reaches here on vKind as `-1 - id`, so
//     every `vKind < 0.0` / `vKind >= 0.0` test in this shader keeps its meaning unchanged.
//
// The id space is the HARD_MIXED one: 3 = hard-tree, 2 = hard-band, anything else = the program's
// own AA kernel. `kindV` is a PARAMETER rather than a direct read of vKind so the function can be
// lifted and driven by test/_glslEmu.mjs, which is the only compiler this tree has.
int coverKernelId(int flagsShape, float kindV) {
#if defined(MANTLE_COVER_KERNEL) && defined(MANTLE_LB_FILL)
  return int(-kindV - 1.0 + 0.5);
#else
  return (flagsShape >> 15) & 3;
#endif
}
// Where the id comes from at the call site. The unified fill stream is the only geometry that
// carries a per-entry id and the only one that declares vKind, so a program without
// MANTLE_LB_FILL feeds a constant and the function above takes the per-shape arm — the two
// conditions are the same one, deliberately, so the argument and the branch can never disagree.
#if defined(MANTLE_COVER_KERNEL) && defined(MANTLE_LB_FILL)
#define MANTLE_COVER_KID_SRC vKind
#else
#define MANTLE_COVER_KID_SRC (-1.0)
#endif

#if !defined(MANTLE_NO_PATTERN_MEAN) && !defined(MANTLE_NO_PATTERN)
// A vector pattern's children (every fill and stroke row of the pattern, in painter order) composited at ONE tile position:
// the walk of the sub-pixel tile's cells (MINIFICATION, in main), called once per cell. It is a second copy of the loop main
// runs for a tile of a pixel or more, and is compiled out (MANTLE_NO_PATTERN_MEAN) from every draw whose tiles are all that coarse.
vec4 patternRowsAt(vec2 tileEm, vec2 tileSize, vec2 cEPx, vec2 cInvPx,
#ifdef MANTLE_ROTATED_MAP
    vec2 cMx, vec2 cMy,
#endif
    vec2 nearLo, vec2 nearHi, vec2 patDx, vec2 patDy, int firstRow1, int lastRow1) {
  vec4 acc = vec4(0.0);
  // The imported range includes every fill and stroke row, in painter order.
  for (int row1 = firstRow1; row1 <= lastRow1; row1++) {
    int rowIdx = row1 - 1;

    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, rowIdx), 0);
    float cStrokeWidth = cStrokePad.x;
    vec4 cStroke= texelFetch(uMetaTex, metaAt(MT_STROKE, rowIdx), 0);
    vec4 cGrad7  = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, rowIdx), 0);
    int cStrokeGradId = int(cGrad7.y + 0.5);
    vec4 cBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, rowIdx), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, rowIdx), 0);
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    if (cStrokeWidth > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {
      // Stroke layer. Fetch cap/join (texel 6) here; image (texel
      // 8/9/10) and fill color/gradient skipped — stroke branch
      // doesn't use them.
      vec4 cCapJoin = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, rowIdx), 0);
      int cStartCap = int(cCapJoin.x + 0.5);
      int cJoinStyle = int(cCapJoin.y + 0.5);
      float cMiterLimit = cCapJoin.z;
      int cEndCapEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, rowIdx), 0).z + 0.5);
      int cEndCap = (cEndCapEnc == 0) ? cStartCap : (cEndCapEnc - 1);
      // Read child DashId from texel 3.w so dashed strokes inside
      // <pattern> children render dashed.
      int cDashId = int(cStrokePad.w + 0.5);
      strokeDashScale = (int(cCapJoin.w + 0.5) & 1) != 0 ? 0.5 * (cEPx.x + cEPx.y) : 1.0;
      float halfW = cStrokeWidth * 0.5 * strokeWidthMultiplier(int(cCapJoin.w + 0.5), cEPx);
      vec2 _sgDummy; vec4 _seDP, _seDQ;   // the edge record: the ramp takes none
      float minD;
      // A stroke-space row walks through its frame and hands back document terms, halfW included. One call site
      // for both (strokeWalk), so the walk is compiled once here.
      bool cLocalSt = (int(cCapJoin.w + 0.5) & FS_STROKE_LOCAL) != 0;
      vec4 cStN = vec4(0.0);
      if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, rowIdx), 0);
      minD = strokeWalk(tileEm, cGD, cBB, cStN, cLocalSt, halfW,
                        cStartCap, cEndCap, cJoinStyle, cMiterLimit, cDashId, _sgDummy,
                        -1e20, strokeAaReachEm(halfW, cEPx), cEPx, false, _seDP, _seDQ);
      float cCov = strokeEdgeCov(minD, halfW, vec2(0.0), cEPx, false);   // the ramp (_coverage.glsl)
      if (cCov <= 0.0) continue;
      // Paint color: gradient if bound, else solid stroke color.
#ifndef MANTLE_NO_GRADIENT
      // A gradient paint is the ramp times the row's paint (1,1,1,opacity x stroke-opacity) -- the
      // importer's contract, which the main path already honored and this loop dropped
      //.
      vec4 paint = cStrokeGradId > 0
        ? sampleGradient(cStrokeGradId, tileEm, cBB, patDx, patDy) * cStroke
        : cStroke;
#else
      vec4 paint = cStroke;
#endif
      float a = cCov * paint.a;
      vec3 premul = paint.rgb * a;
      acc.rgb = premul + acc.rgb * (1.0 - a);
      acc.a   = a      + acc.a   * (1.0 - a);
    } else {
      // Fill layer. Fetch fill-related texels lazily after the
      // coverage check passes.
      bool cEvenOdd = cStrokePad.y > 0.5;
      // Include diagonal copies when a pixel overlaps both tile axes.
      // Every neighbor uses the same ordered coverage call site.
      float cCov = 0.0;
      for (int nb = 0; nb < 9; nb++) {
        vec2 q = tileEm;
        bool use = true;
        if (nb == 1)      { use = nearLo.x > 0.5 && cBB.z > tileSize.x - cEPx.x; q = tileEm + vec2(tileSize.x, 0.0); }
        else if (nb == 2) { use = nearHi.x > 0.5 && cBB.x < cEPx.x;               q = tileEm - vec2(tileSize.x, 0.0); }
        else if (nb == 3) { use = nearLo.y > 0.5 && cBB.w > tileSize.y - cEPx.y; q = tileEm + vec2(0.0, tileSize.y); }
        else if (nb == 4) { use = nearHi.y > 0.5 && cBB.y < cEPx.y;               q = tileEm - vec2(0.0, tileSize.y); }
        else if (nb == 5) { use = nearLo.x > .5 && nearLo.y > .5 && cBB.z > tileSize.x - cEPx.x && cBB.w > tileSize.y - cEPx.y; q = tileEm + tileSize; }
        else if (nb == 6) { use = nearLo.x > .5 && nearHi.y > .5 && cBB.z > tileSize.x - cEPx.x && cBB.y < cEPx.y; q = tileEm + vec2(tileSize.x, -tileSize.y); }
        else if (nb == 7) { use = nearHi.x > .5 && nearLo.y > .5 && cBB.x < cEPx.x && cBB.w > tileSize.y - cEPx.y; q = tileEm + vec2(-tileSize.x, tileSize.y); }
        else if (nb == 8) { use = nearHi.x > .5 && nearHi.y > .5 && cBB.x < cEPx.x && cBB.y < cEPx.y; q = tileEm - tileSize; }
        if (use) {
          float r = childFill(q, PATTERN_CHILD_PIXEL, cGD, cEvenOdd, cBB);
          cCov = (nb == 0) ? r : cCov + r;
        }
      }
      cCov = clamp(cCov, 0.0, 1.0);
      if (cCov <= 0.0) continue;

      vec4 cImg8 = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, rowIdx), 0);
      int cImgId = int(cImg8.w + 0.5);
      int cFillGradId = int(cGrad7.x + 0.5);
      vec4 paint;
      if (cImgId > 0) {
        vec4 cImgRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, rowIdx), 0);
        vec4 cAtlas   = texelFetch(uMetaTex, metaAt(MT_ATLAS, rowIdx), 0);
        // An image row's paint is (1,1,1,opacity): the main path tints by it (imgCol * vFill) and so
        // must a pattern child, or its opacity is dropped.
        paint = sampleMappedChildImage(tileEm, cImgRect, cAtlas, patDx, patDy, cFillGradId)
              * texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);
      }
#ifndef MANTLE_NO_GRADIENT
      else if (cFillGradId > 0) {
        paint = sampleGradient(cFillGradId, tileEm, cBB, patDx, patDy)
              * texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);   // (1,1,1,opacity x fill-opacity)
      }
#endif
      else {
        vec4 cFill  = texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);
        paint = cFill;
      }
      float a = cCov * paint.a;
      vec3 premul = paint.rgb * a;
      acc.rgb = premul + acc.rgb * (1.0 - a);
      acc.a   = a      + acc.a   * (1.0 - a);
    }
  }
  return acc;
}

#endif

void main() {
#ifdef MANTLE_FRAG_STUB
  // MEASUREMENT only — return immediately, so the frame costs only what
  // RASTERIZATION costs: vertex work, the fragments the cover geometry actually
  // emits, and blending. The gap to a real frame is everything the ubershader
  // does per fragment. Renders WRONG on purpose; never ship it enabled.
  fragColor = vec4(0.02, 0.02, 0.02, 0.02);
  return;
#endif
  int y = vInst;
#ifdef MANTLE_COMPOSED
  vec4 vShapeBBox = uLBShapeBBox;   // morph paint via uniforms (no per-frame meta upload)
  vec4 vFill      = uLBFill;
#else
  vec4 vShapeBBox = texelFetch(uMetaTex, metaAt(MT_BBOX, y), 0);
  vec4 vFill      = texelFetch(uMetaTex, metaAt(MT_FILL, y), 0);
#endif
  // Per-attribute absolute overrides REPLACE the meta value (animation
  // drivers — fill/stroke/width animations). Tint then multiplies on
  // top so a tint applied alongside an animated fill modulates the
  // animated value.
  if ((vOverrideMask & 1) != 0) vFill = vOverrideFill;

  vFill *= vOverrideTint;
#ifdef MANTLE_INSTANCED
  // out = clamp(in*tint + bias). A pure tint has bias 0, so this is the tint's own
  // behavior plus a clamp — which is what the per-instance LOOP path does (it composes
  // the tint into a color matrix, and that path clamps), so a tint above 1 agrees
  // between the two.
  vFill = clamp(vFill + vInstBias, 0.0, 1.0);
#endif
#ifndef MANTLE_NO_RECOLOR
  // recolor uniforms. The lean fill variant omits this whole block (and its
  // uPalette sampler); an app that uses per-draw recolor selects the full frag.
  // Per-draw bilinear channel-lerp recolor (unlit-vector
  // formula). Operates on the channel-encoded input directly, so it
  // must run FIRST — palette + matrix would destroy the channel
  // encoding the lerp consumes. Output is no longer channel-encoded
  // (it's the final tint), so downstream palette / matrix would
  // re-process this as if it were a fresh color — composable but
  // each stage is taking a different semantic input.
#ifndef MANTLE_NO_CHANNEL_LERP
  if (uChannelLerpEnabled != 0) {
    vec3 tint = vFill.r * uChannelLerpPrimary.rgb
              + vFill.b * uChannelLerpContrast.rgb;
    float k = clamp(vFill.g + (1.0 - vFill.a), 0.0, 1.0);
    vFill = vec4(mix(tint, uChannelLerpHighlight.rgb, k), vFill.a);
  }
#endif

#ifndef MANTLE_NO_PALETTE
  if (uPaletteEnabled != 0) {
    float ch =
        uPaletteChannel == 0 ? vFill.r :
        uPaletteChannel == 1 ? vFill.g :
        uPaletteChannel == 2 ? vFill.b :
                               vFill.a;
    int idx = clamp(int(ch * float(uPaletteSize)),
                    0, uPaletteSize - 1);
    vec4 looked = texelFetch(uPalette, ivec2(idx, 0), 0);
    vFill.rgb = looked.rgb;
    // Alpha passes through. (Palette entry's alpha is ignored so the
    // caller's `opts.alpha` + meta fill alpha + override tint alpha
    // continue to drive AA edge falloff.)
  }
#endif

#ifndef MANTLE_NO_COLOR_MATRIX
  if (uColorMatrixEnabled != 0) {
    vFill = clamp(uColorMatrix * vFill + uColorMatrixOffset, 0.0, 1.0);
  }
#endif
#endif
    vec4 vStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, y), 0);
    vec4 vGlyphBand = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, y), 0);
  // Cap/join meta texel — always allocated by the current bundle layout
  // (MT_CAP_JOIN), so it is fetched unconditionally.
    vec4 vCapJoin   = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, y), 0);
  // vCapJoin.x = startCap (0 butt, 1 round, 2 square; "capStyle")
  // vCapJoin.y = joinStyle (0 miter, 1 round, 2 bevel)
  // vCapJoin.z = miterLimit
  // vCapJoin.w = flagsShape
  int startCap = int(vCapJoin.x + 0.5);
  int flagsShape = int(vCapJoin.w + 0.5);
  // Per-shape filter id (1-based; 0 = none). Texel 8 layout:
  // (filterId, blendMode, isolation, imageId). Color-matrix kinds
  // (kind<=1) are applied inline at the fragColor writes below;
  // kind>=2 (shadow / glow / bevel) is dispatched offscreen by the
  // renderer (the shape draws unfiltered, then the composite quad
  // applies the per-kind effect).
  vec4 vMeta8  = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, y), 0);
  int vFilterId = int(vMeta8.x + 0.5);
  // Per-shape image id (1-based; 0 = no image fill). atlasSlot.w
  // distinguishes 0=image / 1=pattern / 2=vector pattern; sampleTopLevelImage
  // handles 0 and 1 (vector pattern stays in the dedicated block below).
  int vImageId = int(vMeta8.w + 0.5);

  vec4 vMeta7  = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, y), 0);
  int vFillGradId   = int(vMeta7.x + 0.5);
#ifndef MANTLE_NO_STROKE
  int vStrokeGradId = int(vMeta7.y + 0.5);
  bool nonScalingStroke = (flagsShape & 1) != 0;
  float vStrokeWidth = (vOverrideMask & 4) != 0 ? vOverrideStrokeWidth : vStrokePad.x;
#endif
  // The screen-space zero test. The external clip (setNodeClip) and a baked multi-shape
  // mask layer multiply the finished color near the end of main(); where either is exactly 0, every
  // fill, stroke, pattern, clip and mask walk below computes a color that is then multiplied to zero.
  // Testing them here lets `screenZero` skip that work.
  //
  // only THE VERDICT IS KEPT, AND only A DRAW THAT HAS ONE OF THEM COMPUTES IT. Both tests sit
  // behind the draw's own uniforms: uExtClipMode, and uHasOffscreenMask, which is 1 only when the
  // bundle has baked mask regions. The multipliers are sampled again where they are applied, at the
  // end. A draw with neither runs two uniform branches that are not taken
  // and carries one false bool through the walks. It keeps no multiplier, mask layer or mask flags
  // live across them, and fetches no mask flags ahead of lbCoverage's discards. The samples here are
  // the same expressions at the same UVs as the ones at the end (the conditions are per draw or per
  // shape), so the verdict is exactly "the multiplier applied there is 0". Their implicit-LOD
  // texture() calls stay ahead of every discard, in uniform flow.
  bool screenZero = false;
#ifndef MANTLE_NO_EXTCLIP
  if (uExtClipMode > 0) {
    float em = texture(uExtClipTex, (gl_FragCoord.xy + uFragOrigin) / uViewportSize).a;
    screenZero = ((uExtClipMode == 2) ? (1.0 - em) : em) == 0.0;
  }
#endif
#ifndef MANTLE_NO_MASK
  // A ROW AN OVERRIDE MOVES (vOverrideMask 0x8) reads its mask through the in-shader walk below, never the bake:
  // the bake is a screen-space image of the mask where the row was authored, and the row's mask moves with it.
  bool ovMoved = (vOverrideMask & 8) != 0;
  if (uHasOffscreenMask != 0 && !ovMoved) {
    int zRow = int(vMeta7.w + 0.5) - 1;   // the mask's first row, as maskId - 1 below
    if (zRow >= 0 && (int(texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, zRow), 0).w + 0.5) & 512) != 0) {
      int zLayer = texelFetch(uMaskRowToLayerTex, mrlAt(MRL_ROW, zRow), 0).r;
      if (zLayer >= 0) {
        vec2 muv = (gl_FragCoord.xy + uFragOrigin) / uViewportSize;
        screenZero = screenZero || clamp(texture(uMaskRTArray, vec3(muv, float(zLayer))).r, 0.0, 1.0) == 0.0;
      }
    }
  }
#endif

  bool evenOddFill = vStrokePad.y > 0.5;
  float accumGroupId = vStrokePad.z;
  // dashId: 1-based row into uDashTex; 0 = solid stroke.
  int dashId = int(vStrokePad.w + 0.5);
  ivec4 GD = ivec4(int(vGlyphBand.x), int(vGlyphBand.y), int(vGlyphBand.z), int(vGlyphBand.w));
  // emCoord comes from the vertex shader's per-shape bbox quad with
  // dynamic dilation — already exactly half-a-pixel padded outward.
  // No per-shape discard needed here; the rasterizer's quad bounds
  // implicitly clip pixels outside the shape's dilated bbox.
  vec2 emCoord = vEmCoord;
#ifdef MANTLE_CPATCH
  // A CPatch fragment's em position arrives relative to its contour's corner (the kernel's frame,
  //); everything else here reads world em, so the corner goes back on.
  if (CP_IS_CPATCH_VERTEX) emCoord += vLB2.zw;
#endif
  vec2 ePx = fwidth(emCoord);
  // THE SIGNED DERIVATIVES, taken here in uniform control flow and handed down. Paint samplers run
  // inside per-shape branches, the pattern loop and their own early returns, where GLSL leaves a
  // derivative undefined; they take these instead.
  vec2 emDx = dFdx(emCoord), emDy = dFdy(emCoord);
  // Thin projections amplify interpolation error in fragment differences.
  // Use the constant inverse map for supported affine coordinates.
  if (any(notEqual(vAffineFootprint, vec4(0.0)))) {
    emDx = vAffineFootprint.xy;
    emDy = vAffineFootprint.zw;
    ePx = abs(emDx) + abs(emDy);
  }
  // ONE reciprocal per fragment, shared by every coverage call below (fill,
  // pattern children, clip and mask walks). Re-deriving it per call site would
  // mean keeping the guard in sync in ten places.
  // The guard is for a zero derivative only. A guard of 1e-6 em per pixel would bind on art drawn at
  // 2^-20 of a pixel-per-unit size (9.5e-7): every coverage kernel would take pixels 4.6% too small and
  // widen every AA ramp by that much. 1e-30 sits below every kernel's own float32 floor (their squares
  // underflow near 1e-19 em), so it decides nothing a fill can resolve. Twins: aacPoints.vert.glsl,
  // maskBake.frag.glsl.
  vec2 invPx = 1.0 / max(ePx, vec2(1e-30));
  // only IN A ROTATED-MAP PROGRAM (MANTLE_ROTATED_MAP): an axis-aligned draw's fills take invPx.
  // The map below, its derivative test and the fills' map arithmetic would cost those draws
  // roughly 1.2x (Slug) and 2x (AAC) on the GPU by being present; the renderer picks the define per draw.
#ifdef MANTLE_ROTATED_MAP
  // THE PIXEL AS EM SEES IT, for the Slug and AAC fills:
  // the em -> device-pixel map's columns, the inverse of the signed derivatives above. Where em and device axes agree
  // it IS invPx on the diagonal, taken as exactly that; a rotated or skewed draw passes the whole map, made
  // orientation-preserving (a mirror reflects the y row once more: the pixel box is symmetric, and both kernels count
  // windings in em's orientation). From the derivatives, not the world-matrix uniforms: an instanced draw carries its
  // matrix per instance.
  vec2 slMx = vec2(invPx.x, 0.0), slMy = vec2(0.0, invPx.y);
  if (emDx.y != 0.0 || emDy.x != 0.0) {
    float det = emDx.x * emDy.y - emDy.x * emDx.y;
    if (det != 0.0) {
      slMx = vec2(emDy.y, -emDx.y) / det;
      slMy = vec2(-emDy.x, emDx.x) / det;
      if (det < 0.0) { slMx.y = -slMx.y; slMy.y = -slMy.y; }
    }
  }
#endif

  // vector-effect="non-scaling-stroke": reinterpret strokeWidth as screen
  // pixels (it was left at its authored em-value by the exporter). Convert
  // to em-space width at this fragment by multiplying by the local
  // em-per-pixel scale, which undoes any current 2D transform's scale.
  //
  // Flash LineStyle2 adds per-axis flavors: NoHScale (flagsShape bit 13)
  // cancels horizontal squash only — useful when a character is stretched
  // vertically but you want vertical-running strokes to keep their
  // authored thickness. NoVScale (bit 14) is the mirror. Bit 0 is the
  // full symmetric SVG `vector-effect: non-scaling-stroke`.
  //
  // Per-axis math is approximate at the shape level — the coverage walker
  // doesn't have per-segment tangent here. The single-axis multiplier corrects the
  // common case (squash-on-one-axis content) but a 45° stroke under
  // NoHScale will track ePx.x rather than the true bisector of the
  // anisotropic scale. SWF exporters use these flags almost exclusively
  // for axis-aligned ink, so the approximation lines up with intent.
#ifndef MANTLE_NO_STROKE
  bool noHScale = (flagsShape & (1 << 13)) != 0;
  bool noVScale = (flagsShape & (1 << 14)) != 0;
  strokeDashScale = nonScalingStroke ? 0.5 * (ePx.x + ePx.y) : 1.0;
  if (nonScalingStroke || noHScale || noVScale) {
    float emPerPx;
    if (noHScale && noVScale) emPerPx = 0.5 * (ePx.x + ePx.y);  // both → same as bit 0
    else if (noHScale)        emPerPx = ePx.x;
    else if (noVScale)        emPerPx = ePx.y;
    else                      emPerPx = 0.5 * (ePx.x + ePx.y);  // bit 0 default
    vStrokeWidth *= emPerPx;
  }
#endif
  // Every fillable shape is routed through the coverage-texture
  // (drawSlugShape) pixel shader, not the mesh pass, so accumGroupId is
  // not a "skip" signal — render fill from curve+band texture data
  // regardless of accumGroupId.
  bool doFill = vFill.a > 0.0;
  // Tier-1 fast path: a tagged axis-aligned rect (primKind 2) has an exact closed-form coverage, the pixel box's overlap
  // with it -- skip the curve walk. A circle (1) or round rect (3) walks: a one-pixel SDF ramp is not their
  // coverage and is scale-dependent. So does every tagged fill under a rotated map. primKind 1
  // and 3 still tag the row for the annulus stroke (4) and the hit test. primKind is 0 until the importer tags shapes.
  vec4 t11 = texelFetch(uMetaTex, metaAt(MT_PRIM, y), 0);
  int primKind = int(t11.x + 0.5);
  // Circle and annulus shortcuts require a square bounding box; nonuniform
  // scaling can turn an authored circle into an ellipse.
  bool squareBB = abs((vShapeBBox.z - vShapeBBox.x) - (vShapeBBox.w - vShapeBBox.y))
                    <= 1e-3 * max(vShapeBBox.z - vShapeBBox.x, vShapeBBox.w - vShapeBBox.y);
  // Only an axis-aligned rect has a closed form that is exact: the pixel box's overlap with it. The map is
  // axis-aligned where neither em axis moves the other's pixel coordinate (the derivatives' cross terms are exactly zero,
  // as the rotated-map program tests them); every other tagged fill -- circle, round rect, a rect under another map -- walks.
  bool axisMap = emDx.y == 0.0 && emDy.x == 0.0;
  // PAST THE WALK'S FLOAT32 BOUND. The walk places an arc through its angle, and an angle in [4, 2pi) is a float with an ulp of 2^-21, so from a radius of R = 2^21 device px the
  // edge it reads is one or more pixels off, growing with R (aacArcMonoContrib keeps the row filled; it cannot place it better). A tagged circle or round rect has a closed form
  // with no angle in it, whose error is the coordinates' 2^-24 of R, so it takes that from there on: at 2^20 the furthest wrong pixel from a circle's true edge is 2 to 8 times nearer (a round rect's, 1 to 8).
  // No tolerance is involved; the bound follows from the float format and the range of an angle. Under it nothing here runs, and a pinned engine keeps the walk it asked for.
  bool primDeep = false;
  // (A program with no arcs has no arc walk to outrun, and a tagged circle or round rect holds arcs, so it compiles this out.)
#if !defined(MANTLE_PRIM_WALK) && !defined(MANTLE_NO_ARC)
  if (doFill && (primKind == 3 || (primKind == 1 && squareBB))) {
    float primR = primKind == 3 ? t11.z : 0.5 * (vShapeBBox.z - vShapeBBox.x);
    primDeep = primR * max(invPx.x, invPx.y) >= 2097152.0;
  }
#endif
  bool primFast = doFill && ((primKind == 2 && axisMap) || primDeep);
  // Interior-skip occupancy: for a non-primitive fill the importer may have
  // baked a coarse grid of provably-interior cells (meta texel 5 .xy =
  // baseTexelIdx, G), packed into the curve buffer 4 cells/texel. Skip the
  // coverage walk and return 1.0 when this fragment lands in a SOLID_IN cell
  // AND the cell is wider than the AA reach (cellSize ≥ 1.5·emPerPx), so the
  // ≤1px coverage ramp can never touch a boundary — byte-identical to the walk.
  // Off for pattern carriers (texel 5 holds patInvLinear; atlasSlot.w==2).
#ifndef MANTLE_NO_PATTERN
  // MT_ATLAS at this row is read by four blocks — the occupancy gate here, the
  // image fill, the vector-pattern carrier test, and the bitmap stroke. The
  // pattern block needs it on every fragment, so fetch it once and let the
  // others reuse it: uMetaTex is immutable for the draw, so repeated fetches
  // would be pure per-fragment bandwidth. Variants compiled with MANTLE_NO_PATTERN keep
  // their own local fetches — for them no unconditional read exists to share,
  // and hoisting one would add work rather than remove it.
  vec4 vAtlasSlot = texelFetch(uMetaTex, metaAt(MT_ATLAS, y), 0);
#endif
#ifdef MANTLE_LB_FILL
#define FCOV_UNUSED (vKind >= 0.0)
#else
#define FCOV_UNUSED false
#endif
  bool occSkip = false;
  // The derivative-free fill walks run only where the screen multipliers leave something.
  bool walkFill = doFill && !screenZero;

  if (!FCOV_UNUSED && uHasOccupancy == 1 && walkFill && !primFast) {
    vec4 t5occ = texelFetch(uMetaTex, metaAt(MT_SOLID, y), 0);
    int occG = int(t5occ.y + 0.5);
    if (occG > 0) {
#ifndef MANTLE_NO_PATTERN
      vec4 t10occ = vAtlasSlot;
#else
      vec4 t10occ = texelFetch(uMetaTex, metaAt(MT_ATLAS, y), 0);
#endif
      // Pattern carriers reuse texel 5 for patInvLinear (atlasSlot.w==2); never
      // skip those. occupancy is only stamped on plain fills.
      if (t10occ.w < 1.5) {
        float occCW = (vShapeBBox.z - vShapeBBox.x) / float(occG);
        float occCH = (vShapeBBox.w - vShapeBBox.y) / float(occG);
        // AA gate: cell must exceed 1.5px of em reach on both axes, so the
        // ≤1px coverage ramp can't touch a boundary ≥1 cell away.
        if (occCW >= 1.5 * ePx.x && occCH >= 1.5 * ePx.y) {
          int ocx = int(floor((emCoord.x - vShapeBBox.x) / occCW));
          int ocy = int(floor((emCoord.y - vShapeBBox.y) / occCH));
          if (ocx >= 0 && ocx < occG && ocy >= 0 && ocy < occG) {
            int cellIdx = ocy * occG + ocx;
            vec4 occT = texFetch(ivec2(int(t5occ.x + 0.5) + (cellIdx >> 2), 0));
            if (occT[cellIdx & 3] > 0.5) occSkip = true;
          }
        }
      }
    }
  }
  // LAZY fCovBase. Under MANTLE_LB_FILL this value is only ever READ by a cover quad
  // (vKind < 0); an LB triangle takes lbCoverage() instead and throws fCovBase away. But the
  // assignment below is EAGER, and what it computes is the whole Slug / AAC / GWN fill — a
  // band walk or run-tree per fragment. lbCoverage() is already lazy for free because it
  // contains a discard, so the compiler may not hoist it; fCovBase is pure, so nothing forces
  // the compiler to sink it into the branch that uses it. Computed eagerly, every Loop-Blinn
  // fragment would run a whole Slug/AAC/GWN fill and discard it (about 3x the cost).
  //
  // SAFE BY CONSTRUCTION, not by measurement: fCovBase has exactly two readers — this
  // ternary (cover quads only, vKind < 0) and the MANTLE_LB_FILL-off path below, where the
  // guard is compile-time false. Nothing else reads it.
#ifdef MANTLE_LB_FILL_COV
  // The fill silhouette + AA already live in the LB coverage RT
  // (rendered from the GPU-resident morph mesh). Sample it in screen space and
  // SKIP the whole Slug ray-cast / primFast / occupancy machinery for the fill —
  // stroke/clip/mask/filter below are untouched, so they compose with the LB
  // fill. (occSkip/primFast above are dead under this define and compiler-stripped.)
  float fCovBase = FCOV_UNUSED ? 0.0
    : doFill ? texture(uLBCovTex, (gl_FragCoord.xy + uFragOrigin) / uLBCovTexSize).r : 0.0;
#elif defined(MANTLE_NO_COVER_FILL) && defined(MANTLE_LB_FILL)
  // NO FILL ROW OF this DRAW IS A COVER QUAD (fillPass sets it from the unified stream's own rows): every
  // fill is a mesh, and a cover quad here is a stroke row, whose doFill is false. So no fragment reads a
  // cover fill kernel, and none is compiled -- the chain below, the occupancy lookup, the kernel itself.
  float fCovBase = 0.0;
#else
  float fCovBase = FCOV_UNUSED ? 0.0
    : occSkip ? 1.0
    : !primFast
// Per-shape engine bits are spatially coherent because each shape occupies its
// own cover quad. Hard-tree is 3, hard-band is 2, and other values use AA.
// Under MANTLE_COVER_KERNEL the same chain reads a PER-ENTRY id off vKind instead; the
// branches, their order and their arguments are unchanged, so a stream whose entries all carry
// their row's bits renders exactly what the per-shape program renders.
#if defined(MANTLE_HARD_MIXED) || defined(MANTLE_COVER_KERNEL)
    ? (walkFill ? (
#ifdef MANTLE_HARD_TREE
        coverKernelId(flagsShape, MANTLE_COVER_KID_SRC) == 3 ? renderFillGWNSDF(emCoord, invPx, GD, evenOddFill, vShapeBBox) :
#endif
        coverKernelId(flagsShape, MANTLE_COVER_KID_SRC) == 2 ? renderFillHardBand(emCoord, GD, evenOddFill, vShapeBBox)
#if defined(MANTLE_AAC) && defined(MANTLE_ROTATED_MAP)
      : renderFillAACM(emCoord, slMx, slMy, GD, evenOddFill, vShapeBBox)
#elif defined(MANTLE_AAC)
      : renderFillAAC(emCoord, invPx, GD, evenOddFill, vShapeBBox)
#elif defined(MANTLE_ROTATED_MAP)
      : renderFillM(emCoord, slMx, slMy, GD, evenOddFill, vShapeBBox)
#else
      : renderFill(emCoord, invPx, GD, evenOddFill, vShapeBBox)
#endif
      ) : 0.0)
#elif defined(MANTLE_HARD) && defined(MANTLE_HARD_TREE)
    ? (walkFill ? renderFillGWNSDF(emCoord, invPx, GD, evenOddFill, vShapeBBox) : 0.0)
#elif defined(MANTLE_HARD)

    ? (walkFill ? renderFillHardBand(emCoord, GD, evenOddFill, vShapeBBox) : 0.0)
#elif defined(MANTLE_GWN) && defined(MANTLE_GWN_SDF)
    ? (walkFill ? renderFillGWNSDF(emCoord, invPx, GD, evenOddFill, vShapeBBox) : 0.0)
#elif defined(MANTLE_GWN)
    ? (walkFill ? renderFillGWNSDF(emCoord, invPx, GD, evenOddFill, vShapeBBox) : 0.0)
#elif defined(MANTLE_AAC) && defined(MANTLE_ROTATED_MAP)
    ? (walkFill ? renderFillAACM(emCoord, slMx, slMy, GD, evenOddFill, vShapeBBox) : 0.0)
#elif defined(MANTLE_AAC)
    ? (walkFill ? renderFillAAC(emCoord, invPx, GD, evenOddFill, vShapeBBox) : 0.0)
#elif defined(MANTLE_ROTATED_MAP)
    ? (walkFill ? renderFillM(emCoord, slMx, slMy, GD, evenOddFill, vShapeBBox) : 0.0)
#else
    ? (walkFill ? renderFill(emCoord, invPx, GD, evenOddFill, vShapeBBox) : 0.0)
#endif
    // WHERE THE CLOSED FORM GOES IS CHOSEN BY MEASUREMENT, not reasoned: no row under the bound reads it, and on Apple Metal one form or the other costs every fragment
    // of a program, by which programs depends on whether it holds the stroke walk. With strokes an arm of this chain cost up to 18 percent of a frame and a statement
    // costs nothing; without them a statement cost up to 14 percent and an arm costs nothing. Retime this if the shader around it changes.
#ifdef MANTLE_NO_STROKE
    : primDeep ? primDeepCoverage(emCoord, vShapeBBox, primKind == 3 ? t11.z : 0.5 * (vShapeBBox.z - vShapeBBox.x), emDx, emDy)
#endif
    : primRectCoverage(emCoord, vShapeBBox, ePx);
#ifndef MANTLE_NO_STROKE
  if (primDeep) fCovBase = primDeepCoverage(emCoord, vShapeBBox, primKind == 3 ? t11.z : 0.5 * (vShapeBBox.z - vShapeBBox.x), emDx, emDy);
#endif
#endif
  // An LB triangle carries vKind >= 0; a cover quad is stamped -1. The LB path
  // computes its coverage from the implicit it already carries, and everything
  // below — paint, stroke, clip, mask, filter — is shared verbatim.
#ifdef MANTLE_LB_FILL
  float fCov = (vKind >= 0.0) ? (doFill ? lbCoverage() : 0.0) : fCovBase;
#ifdef MANTLE_LB_FRAGDBG
  // DIAGNOSTIC VARIANT, never a render path. Counts how
  // many LB fragments land on each pixel and of which kind: each surviving
  // fragment adds 1/64 (~4/255) to alpha and to its kind's channel, so a readback
  // counts them directly. Per-pixel multiplicity is the only thing that decides
  // whether a single OVER draw can replace the MAX coverage pass — a geometric
  // sample test cannot see it, because a pixel is an area and disjoint triangles
  // still both rasterize to it. Clear the canvas to TRANSPARENT when using this;
  // an opaque clear pins alpha at 255 and every pixel reads 64.
  if (vKind < 0.0 || fCov <= MANTLE_LB_FRAGDBG) discard;
  const float dbgU = 1.0 / 64.0;
  fragColor = vec4(dbgU * vKind / 15.0,                          // R: SUM of kinds
                   dbgU * (fCov > 0.98 ? 1.0 : 0.0),             // G: saturated fragments
                   vKind < 0.5 ? dbgU : 0.0,                     // B: INTERIOR interior
                   dbgU);                                        // A: every kind
  return;
#endif
#else
  float fCov = fCovBase;
#endif
#ifdef MANTLE_COV_STUB
  // MEASUREMENT only — replace the fill's COVERAGE with a constant, keeping every
  // other per-fragment stage (paint, stroke, clip, mask, blend). The walk cap only
  // priced the MARGINAL cost of extra segments; capping to one still ran the whole
  // coverage machinery, so it understates what a fill engine actually costs. This
  // measures the whole of it. Renders WRONG on purpose; never ship it enabled.
  fCov = 0.75;
#endif
  // Fill paint: gradient ramp sample when fillGradId > 0, otherwise the
  // flat vFill that came in via meta texel 1. The importer writes
  // fillRgba = (1,1,1,fillOpacity) for gradient shapes so multiplying
  // by vFill preserves alpha modulation.
  //
  // Sampled only where the fill covers something: the paint is used only times fCov,
  // and at fCov == 0 any finite paint gives the same zero. `!= 0.0`, not `> 0.0`, so a coverage of
  // any sign or NaN still takes the gradient exactly as before. Legal in divergent flow:
  // sampleGradient reads texelFetch only and takes emDx/emDy from main's uniform-flow derivatives.
#ifndef MANTLE_NO_GRADIENT
  vec4 fillPaint = (vFillGradId > 0 && fCov != 0.0 && !screenZero)
    ? sampleGradient(vFillGradId, emCoord, vShapeBBox, emDx, emDy) * vFill
    : vFill;
#else
  vec4 fillPaint = vFill;
#endif
  vec4 color = vec4(fillPaint.rgb * fillPaint.a, fillPaint.a) * fCov;

  // ---- Top-level <image> / raster <pattern> fill ----
  // When imageId > 0 AND the shape isn't a vector-pattern carrier
  // (atlasSlot.w == 2 is handled below), replace the flat fill with
  // the sampled atlas color. fCov gates the AA coverage at the shape
  // silhouette. Tint by the shape's fill color so SVG fill-opacity /
  // alpha modulation still works against the raster.
#ifndef MANTLE_NO_IMAGE
  if (vImageId > 0 && !screenZero) {
#ifndef MANTLE_NO_PATTERN
    vec4 vAtlas9  = vAtlasSlot;
#else
    vec4 vAtlas9  = texelFetch(uMetaTex, metaAt(MT_ATLAS, y), 0);
#endif
    if (abs(vAtlas9.w - 2.0) >= 0.5) {  // not a vector pattern
#ifdef MANTLE_COMPOSED
      vec4 vImgRect = uLBImageRect;     // lerped per-frame (composed morph)
#else
      vec4 vImgRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, y), 0);
#endif
      vec4 imgCol = sampleMappedTopLevelImage(emCoord, vImgRect, vAtlas9, emDx, emDy, vFillGradId);
      // imgCol is straight RGBA from the atlas; tint by the white-or-
      // alpha-modulated fill (importer writes (1,1,1, fillOpacity) for
      // <image>) then premultiply.
      vec4 tinted = imgCol * vFill;
      color = vec4(tinted.rgb * tinted.a, tinted.a) * fCov;
    }
  }
#endif

  // ---- Vector pattern fill (Gap 4) ----
#ifndef MANTLE_NO_PATTERN
  // Texel 10 .w == 2 marks a vector pattern. .xy = (firstRow1, lastRow1)
  // of the pattern's child layer meta rows. Texel 9 (imageRect) =
  // (originX, originY, +tileEmW, +tileEmH). Tile-wrap emPos, loop each
  // child row, sample its coverage via the existing renderFill helper,
  // Composite every child row in painter order, using premultiplied source-over.
  if (abs(vAtlasSlot.w - 2.0) < 0.5 && fCov > 0.0 && !screenZero) {
    int resourceLayer = uHasPatternGroups != 0 ? texelFetch(uMaskRowToLayerTex, mrlAt(1, y), 0).r : -1;
    if (resourceLayer >= 0) {
      vec2 resourceUV = (gl_FragCoord.xy + uFragOrigin) / uViewportSize;
      color = texture(uMaskRTArray, vec3(resourceUV, float(resourceLayer))) * fCov
        * vec4(vFill.rgb * vFill.a, vFill.a);
    } else {
    vec4 vImageRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, y), 0);
    vec2 tileOrigin = vImageRect.xy;
    // imageRect.zw is (tileEmW, tileEmH) absolute (matches the bundle
    // packing — texel 9 stores (X, Y, W, H), not (X0, Y0, X1, Y1)).
    // (A ZERO guard only, as invPx's: an absolute 1e-6 em floor would stretch every tile under 1e-6 em -- a unit tile at
    // 2^-20 -- and the pattern would tile at the wrong period.)
    vec2 tileSize   = max(vImageRect.zw, vec2(1e-30));

    vec4 vPatLinv = texelFetch(uMetaTex, metaAt(MT_SOLID, y), 0);
    mat2 patLinv  = mat2(vPatLinv.x, vPatLinv.y, vPatLinv.z, vPatLinv.w);
    vec2 patCoord = patLinv * emCoord;
    vec2 patDx = patLinv * emDx, patDy = patLinv * emDy;   // the tile wrap is a translation
    // The children's pixel is the pixel in pattern space. The children are walked in the tile's own units,
    // where a scaled patternTransform makes a device pixel a different size: a quarter of the user pixel under scale(4).
    // A child walk that took the user-space pixel (ePx, invPx) would make each child's AA ramp, its stroke's reach and ramp
    // and the seam window 4x too wide there (and too narrow under a shrink). The pattern-space pixel is the derivative map
    // just formed: its fwidth |patDx| + |patDy| for the ramps and the window, its reciprocal for an axis-aligned kernel,
    // and its inverse for a rotated-map one (as slMx / slMy are formed from emDx / emDy). With no patternTransform
    // patLinv is the identity and the user pixel is kept, bit for bit.
#ifndef MANTLE_NO_PATTERN_MEAN
    const int PATTERN_MEAN_N = 4;   // cells per collapsed axis when a tile is finer than a pixel (see MINIFICATION below)
#endif
    vec2 cEPx = ePx, cInvPx = invPx;
#ifdef MANTLE_ROTATED_MAP
    vec2 cMx = slMx, cMy = slMy;
#endif
    if (vPatLinv.x != 1.0 || vPatLinv.y != 0.0 || vPatLinv.z != 0.0 || vPatLinv.w != 1.0) {
      cEPx = abs(patDx) + abs(patDy);
      cInvPx = 1.0 / max(cEPx, vec2(1e-30));
#ifdef MANTLE_ROTATED_MAP
      cMx = vec2(cInvPx.x, 0.0); cMy = vec2(0.0, cInvPx.y);
      if (patDx.y != 0.0 || patDy.x != 0.0) {
        float det = patDx.x * patDy.y - patDy.x * patDx.y;
        if (det != 0.0) {
          cMx = vec2(patDy.y, -patDx.y) / det;
          cMy = vec2(-patDy.x, patDx.x) / det;
          if (det < 0.0) { cMx.y = -cMx.y; cMy.y = -cMy.y; }
        }
      }
#endif
    }
    vec2 rel    = patCoord - tileOrigin;
    vec2 tileEm = rel - floor(rel / tileSize) * tileSize;
    int firstRow1 = int(vAtlasSlot.x + 0.5);
    int lastRow1  = int(vAtlasSlot.y + 0.5);
    // Toroidal-wrap neighbor offsets: when a fragment's pixel footprint
    // straddles a tile boundary, also evaluate the child against the
    // pattern's neighboring tile so AA coverage at the seam sums to 1
    // across the wrap. Children whose bbox doesn't reach the tile edge
    // contribute 0 from the neighbor — costs a few extra band-list
    // probes but keeps the inner coverage walk early-out cheap.
    vec2 nearLo = step(tileEm, cEPx);                 // 1 if near .x=0 / .y=0
    vec2 nearHi = step(tileSize - tileEm, cEPx);      // 1 if near .x=W / .y=H
    // MINIFICATION. An axis whose tile is finer than the pixel (cEPx > tileSize) has no tile structure left to resolve: the pixel is
    // the MEAN of the tile there. The child coverage is the exact box overlap over the pixel footprint, which for a tile finer than the
    // pixel is the child's area over the PIXEL -- a fraction tile/pixel of the answer -- so the pattern faded to the background (a
    // 0.1 px tile read 226,222,226 against a mean of 167,116,167). The tile is instead walked as PATTERN_MEAN_N cells per collapsed
    // axis, each the exact box overlap over a cell of tile/N, and the cells are averaged. One cell per axis is not enough: the children
    // composite source-over, which treats each child's partial coverage as independent, so two children that split a cell between
    // them (a red and a blue quarter meeting at the tile's center) came out 0.19 and 0.25 instead of 0.25 and 0.25. With cells a
    // quarter of the tile the split happens on the cell boundaries, where every coverage is 0 or 1. Tiles of a pixel or more take
    // none of this.
    vec4 accMean = vec4(0.0);
#ifndef MANTLE_NO_PATTERN_MEAN
    bvec2 patMin = greaterThan(cEPx, tileSize);
    if (patMin.x || patMin.y) {
      // The sub-pixel tile: a separate copy of the walk, so the common case below is the plain single pass.
      ivec2 nSub = ivec2(patMin.x ? PATTERN_MEAN_N : 1, patMin.y ? PATTERN_MEAN_N : 1);
      vec2 patCell = tileSize / vec2(nSub);
      vec2 mEPx = cEPx, mInvPx = cInvPx, mNearLo = nearLo, mNearHi = nearHi;
      vec2 mDx = vec2(patMin.x ? patCell.x : patDx.x, patMin.y ? 0.0 : patDx.y);
      vec2 mDy = vec2(patMin.x ? 0.0 : patDy.x, patMin.y ? patCell.y : patDy.y);
      if (patMin.x) { mEPx.x = patCell.x; mInvPx.x = 1.0 / patCell.x; mNearLo.x = 0.0; mNearHi.x = 0.0; }
      if (patMin.y) { mEPx.y = patCell.y; mInvPx.y = 1.0 / patCell.y; mNearLo.y = 0.0; mNearHi.y = 0.0; }
#ifdef MANTLE_ROTATED_MAP
      vec2 mMx = vec2(mInvPx.x, 0.0), mMy = vec2(0.0, mInvPx.y);
#endif
      vec4 accAll = vec4(0.0);
      for (int sj = 0; sj < nSub.y; sj++) {
        for (int si = 0; si < nSub.x; si++) {
          vec2 tileS = tileEm;
          if (patMin.x) tileS.x = (float(si) + 0.5) * patCell.x;
          if (patMin.y) tileS.y = (float(sj) + 0.5) * patCell.y;
          accAll += patternRowsAt(tileS, tileSize, mEPx, mInvPx,
#ifdef MANTLE_ROTATED_MAP
            mMx, mMy,
#endif
            mNearLo, mNearHi, mDx, mDy, firstRow1, lastRow1);
        }
      }
      accMean = accAll / float(nSub.x * nSub.y);
    } else
#endif
    {
    vec4 acc = vec4(0.0);
    // The imported range includes every fill and stroke row, in painter order.
    for (int row1 = firstRow1; row1 <= lastRow1; row1++) {
      int rowIdx = row1 - 1;

      vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, rowIdx), 0);
      float cStrokeWidth = cStrokePad.x;
      vec4 cStroke= texelFetch(uMetaTex, metaAt(MT_STROKE, rowIdx), 0);
      vec4 cGrad7  = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, rowIdx), 0);
      int cStrokeGradId = int(cGrad7.y + 0.5);
      vec4 cBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, rowIdx), 0);
      vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, rowIdx), 0);
      ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                        int(cGlyph.z), int(cGlyph.w));
      if (cStrokeWidth > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {
        // Stroke layer. Fetch cap/join (texel 6) here; image (texel
        // 8/9/10) and fill color/gradient skipped — stroke branch
        // doesn't use them.
        vec4 cCapJoin = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, rowIdx), 0);
        int cStartCap = int(cCapJoin.x + 0.5);
        int cJoinStyle = int(cCapJoin.y + 0.5);
        float cMiterLimit = cCapJoin.z;
        int cEndCapEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, rowIdx), 0).z + 0.5);
        int cEndCap = (cEndCapEnc == 0) ? cStartCap : (cEndCapEnc - 1);
        // Read child DashId from texel 3.w so dashed strokes inside
        // <pattern> children render dashed.
        int cDashId = int(cStrokePad.w + 0.5);
        strokeDashScale = (int(cCapJoin.w + 0.5) & 1) != 0 ? 0.5 * (cEPx.x + cEPx.y) : 1.0;
        float halfW = cStrokeWidth * 0.5 * strokeWidthMultiplier(int(cCapJoin.w + 0.5), cEPx);
        vec2 _sgDummy; vec4 _seDP, _seDQ;   // the edge record: the ramp takes none
        float minD;
        // A stroke-space row walks through its frame and hands back document terms, halfW included. One call site
        // for both (strokeWalk), so the walk is compiled once here.
        bool cLocalSt = (int(cCapJoin.w + 0.5) & FS_STROKE_LOCAL) != 0;
        vec4 cStN = vec4(0.0);
        if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, rowIdx), 0);
        minD = strokeWalk(tileEm, cGD, cBB, cStN, cLocalSt, halfW,
                          cStartCap, cEndCap, cJoinStyle, cMiterLimit, cDashId, _sgDummy,
                          -1e20, strokeAaReachEm(halfW, cEPx), cEPx, false, _seDP, _seDQ);
        float cCov = strokeEdgeCov(minD, halfW, vec2(0.0), cEPx, false);   // the ramp (_coverage.glsl)
        if (cCov <= 0.0) continue;
        // Paint color: gradient if bound, else solid stroke color.
  #ifndef MANTLE_NO_GRADIENT
        // A gradient paint is the ramp times the row's paint (1,1,1,opacity x stroke-opacity) -- the
        // importer's contract, which the main path already honored and this loop dropped
        //.
        vec4 paint = cStrokeGradId > 0
          ? sampleGradient(cStrokeGradId, tileEm, cBB, patDx, patDy) * cStroke
          : cStroke;
  #else
        vec4 paint = cStroke;
  #endif
        float a = cCov * paint.a;
        vec3 premul = paint.rgb * a;
        acc.rgb = premul + acc.rgb * (1.0 - a);
        acc.a   = a      + acc.a   * (1.0 - a);
      } else {
        // Fill layer. Fetch fill-related texels lazily after the
        // coverage check passes.
        bool cEvenOdd = cStrokePad.y > 0.5;
        // Include diagonal copies when a pixel overlaps both tile axes.
        // Every neighbor uses the same ordered coverage call site.
        float cCov = 0.0;
        for (int nb = 0; nb < 9; nb++) {
          vec2 q = tileEm;
          bool use = true;
          if (nb == 1)      { use = nearLo.x > 0.5 && cBB.z > tileSize.x - cEPx.x; q = tileEm + vec2(tileSize.x, 0.0); }
          else if (nb == 2) { use = nearHi.x > 0.5 && cBB.x < cEPx.x;               q = tileEm - vec2(tileSize.x, 0.0); }
          else if (nb == 3) { use = nearLo.y > 0.5 && cBB.w > tileSize.y - cEPx.y; q = tileEm + vec2(0.0, tileSize.y); }
          else if (nb == 4) { use = nearHi.y > 0.5 && cBB.y < cEPx.y;               q = tileEm - vec2(0.0, tileSize.y); }
          else if (nb == 5) { use = nearLo.x > .5 && nearLo.y > .5 && cBB.z > tileSize.x - cEPx.x && cBB.w > tileSize.y - cEPx.y; q = tileEm + tileSize; }
          else if (nb == 6) { use = nearLo.x > .5 && nearHi.y > .5 && cBB.z > tileSize.x - cEPx.x && cBB.y < cEPx.y; q = tileEm + vec2(tileSize.x, -tileSize.y); }
          else if (nb == 7) { use = nearHi.x > .5 && nearLo.y > .5 && cBB.x < cEPx.x && cBB.w > tileSize.y - cEPx.y; q = tileEm + vec2(-tileSize.x, tileSize.y); }
          else if (nb == 8) { use = nearHi.x > .5 && nearHi.y > .5 && cBB.x < cEPx.x && cBB.y < cEPx.y; q = tileEm - tileSize; }
          if (use) {
            float r = childFill(q, PATTERN_CHILD_PIXEL, cGD, cEvenOdd, cBB);
            cCov = (nb == 0) ? r : cCov + r;
          }
        }
        cCov = clamp(cCov, 0.0, 1.0);
        if (cCov <= 0.0) continue;

        vec4 cImg8 = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, rowIdx), 0);
        int cImgId = int(cImg8.w + 0.5);
        int cFillGradId = int(cGrad7.x + 0.5);
        vec4 paint;
        if (cImgId > 0) {
          vec4 cImgRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, rowIdx), 0);
          vec4 cAtlas   = texelFetch(uMetaTex, metaAt(MT_ATLAS, rowIdx), 0);
          // An image row's paint is (1,1,1,opacity): the main path tints by it (imgCol * vFill) and so
          // must a pattern child, or its opacity is dropped.
          paint = sampleMappedChildImage(tileEm, cImgRect, cAtlas, patDx, patDy, cFillGradId)
                * texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);
        }
  #ifndef MANTLE_NO_GRADIENT
        else if (cFillGradId > 0) {
          paint = sampleGradient(cFillGradId, tileEm, cBB, patDx, patDy)
                * texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);   // (1,1,1,opacity x fill-opacity)
        }
  #endif
        else {
          vec4 cFill  = texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);
          paint = cFill;
        }
        float a = cCov * paint.a;
        vec3 premul = paint.rgb * a;
        acc.rgb = premul + acc.rgb * (1.0 - a);
        acc.a   = a      + acc.a   * (1.0 - a);
      }
    }
    accMean = acc;
    }
    color = accMean * fCov * vec4(vFill.rgb * vFill.a, vFill.a);
    }
  }
#endif
  // Stroke pass: compute distance to closest point on path; AA-band
  // against halfW.
  // MANTLE_NO_STROKE drops the per-shape stroke band-walk for a fill-only
  // variant. strokeMinDist (the helper) is NOT guarded — mask / pattern stroke
  // children still call it; it dead-strips when those are also omitted.
#ifndef MANTLE_NO_STROKE

  vec4 vStroke = vec4(0.0);
  if (!screenZero && vStrokeWidth > 0.0) {
#ifdef MANTLE_COMPOSED
    vStroke = uLBStroke;
#else
    vStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, y), 0);
#endif
    if ((vOverrideMask & 2) != 0) vStroke = vOverrideStroke;
    vStroke *= vOverrideTint;
#ifdef MANTLE_INSTANCED
    vStroke = clamp(vStroke + vInstBias, 0.0, 1.0);
#endif
#ifndef MANTLE_NO_RECOLOR
#ifndef MANTLE_NO_CHANNEL_LERP
    if (uChannelLerpEnabled != 0) {
      vec3 tint = vStroke.r * uChannelLerpPrimary.rgb
                + vStroke.b * uChannelLerpContrast.rgb;
      float k = clamp(vStroke.g + (1.0 - vStroke.a), 0.0, 1.0);
      vStroke = vec4(mix(tint, uChannelLerpHighlight.rgb, k), vStroke.a);
    }
#endif
#ifndef MANTLE_NO_PALETTE
    if (uPaletteEnabled != 0) {
      float ch =
          uPaletteChannel == 0 ? vStroke.r :
          uPaletteChannel == 1 ? vStroke.g :
          uPaletteChannel == 2 ? vStroke.b :
                                 vStroke.a;
      int idx = clamp(int(ch * float(uPaletteSize)),
                      0, uPaletteSize - 1);
      vec4 looked = texelFetch(uPalette, ivec2(idx, 0), 0);
      vStroke.rgb = looked.rgb;
    }
#endif
#ifndef MANTLE_NO_COLOR_MATRIX
    if (uColorMatrixEnabled != 0) {
      vStroke = clamp(uColorMatrix * vStroke + uColorMatrixOffset, 0.0, 1.0);
    }
#endif
#endif
  }
  // Who paints the stroke. The pass below runs on any vertex whose meta row has a
  // visible stroke, so when dedicated stroke-segment quads own it the fill carrier
  // must stand down or both would contribute a band. Cover quads carry that flag in
  // aLbMeta.z (vSeam), which they otherwise leave zero; LB fill triangles never
  // coexist with a stroke-seg entry for the same shape.
  if (!screenZero && vStrokeWidth > 0.0 && vStroke.a > 0.0) {
    int joinStyle = int(vCapJoin.y + 0.5);
    float miterLimit = vCapJoin.z;
    strokeDashScale = nonScalingStroke ? 0.5 * (ePx.x + ePx.y) : 1.0;
    float halfW = vStrokeWidth * 0.5;
    // Asymmetric line caps (Flash LineStyle2 StartCapStyle ≠ EndCapStyle).
    // Texel 11.z holds endCap as (endCap+1) with sentinel 0 = "same as
    // startCap" — keeps legacy bundles working unchanged.
    int endCapEnc = int(t11.z + 0.5);   // MT_PRIM at this row, fetched above
    int endCap = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
    // ANNULUS: a stroked circle's distance field is closed form, so skip the
    // band walk entirely. The importer tags the STROKE row primKind 4 (fill
    // rows use 1/2/3; a stroke row's primKind is otherwise unused, and the
    // fill fast path above cannot see this because it gates on doFill, which
    // is false on a stroke row).
    //
    // The centerline radius is derived, not stored: this row's bbox is padded
    // by the AUTHORED half-width, so R = min(halfExtent) - authoredHalfW.
    // Deriving it from the authored width rather than vStrokeWidth is what
    // keeps a strokeWidth OVERRIDE correct — the ring then grows about the
    // same centerline, exactly as the walk would have it.
    //
    // squareBB rejects a non-uniformly scaled circle (its baked bbox is an
    // ellipse, whose offset is not a circle). dashId falls back: dashes need
    // the walk's arc-length parameter.
    float minD;
    // EM-space unit normal of the stroke boundary, set only where that boundary
    // is exactly a straight offset line (a LINE segment's body). Zero elsewhere.
    vec2 strokeGrad = vec2(0.0);

    vec4 edgeP = vec4(0.0), edgeQ = vec4(0.0), edgeN = vec4(1.0, 0.0, 0.0, 1.0);
    float halfWS = halfW;
    vec2 annHe = 0.5 * (vShapeBBox.zw - vShapeBBox.xy);
    if (primKind == 4 && squareBB && dashId == 0) {
      vec2 annQ = emCoord - 0.5 * (vShapeBBox.xy + vShapeBBox.zw);
      float annR = min(annHe.x, annHe.y) - vStrokePad.x * 0.5;
      float annL = length(annQ);
      minD = abs(annL - annR);

      strokeGrad = (annL > 1e-9) ? (annQ / annL) * sign(annL - annR) : vec2(0.0);
    } else {
      // A stroke-space row (FS_STROKE_LOCAL) is drawn in stroke space: the CTM was not conformal, so the outline is the
      // image of the LOCAL stroke and no document-space width reproduces it. The walk measures it through the row's frame and returns
      // document terms -- the distance, halfW across the winning feature, and the document boundary normal -- so
      // everything below is the coverage every stroke takes.
      // One call site for both arms (strokeWalk), so the walk is compiled once here.
      bool locSt = (flagsShape & FS_STROKE_LOCAL) != 0;
      if (locSt) edgeN = texelFetch(uMetaTex, metaAt(MT_SOLID, y), 0);
      // The conformal arm's saturation depth is max(halfW - 0.5 * length(ePx), 0): coverage saturates there; see
      // strokeBandAccum. 0.5*length(ePx) is the deepest the exact-area box is still partial (its half-extent across
      // the edge, maximized over directions), and it covers the ramp model too: 0.25*(ePx.x+ePx.y) saturated only
      // the RAMP, so under the default exact-area AA the early return kept a segment a later, closer one should
      // have won.
      minD = strokeWalk(emCoord, GD, vShapeBBox, locSt ? edgeN : vec4(0.0), locSt, halfW,
                        startCap, endCap, joinStyle, miterLimit, dashId, strokeGrad,
                        max(halfW - 0.5 * length(ePx), 0.0), strokeAaReachEm(halfW, ePx), ePx, true, edgeP, edgeQ);
    }
    // Mantle's AA falloff (_coverage.glsl strokeEdgeCov): sub-pixel hairlines floor halfW to half a pixel and fade
    // alpha by the true-vs-clamped ratio. Geometric coverage first, then modulated by the paint's alpha
    // (bitmap / gradient / solid).
    //
    // exact-AREA stroke edge, ON by default (renderer.setStrokeExactAa(false)
    // restores the previous isotropic ramp).
    //
    // The ramp is the true area(pixel box n stroke) only for an AXIS-ALIGNED
    // edge; _boxCov.glsl records the same weakness for Slug's fill combiner
    // (mean 10.6/255, max 31.9 at 45deg). Where the boundary is a straight
    // offset line — a LINE segment's body — its normal is known in closed form,
    // so the exact box coverage comes from the same exactBoxCov the fill
    // engines use. Caps, joins and curved segments keep the ramp.
    //
    //
    // AND WHERE THE WALK SAYS WHAT THE WINNING EDGE IS, ITS exact AREA: a cap's or a join's plane, the
    // two planes of a corner, a round cap's disc (strokeExactCov). A hairline keeps the floor-and-fade above.
#ifdef MANTLE_STROKE_EXACT
    float strokeCov = (uStrokeExactAa != 0 && edgeP.w > 0.0 && halfW >= 0.25 * (ePx.x + ePx.y))
                      ? strokeExactCov(edgeP, edgeQ, halfWS, edgeN, ePx)
                      : strokeEdgeCov(minD, halfW, strokeGrad, ePx, uStrokeExactAa != 0);
#else
    float strokeCov = strokeEdgeCov(minD, halfW, strokeGrad, ePx, uStrokeExactAa != 0);
#endif
    // Stroke paint priority: bitmap > gradient > solid.
    // Bitmap-fill stroke (Flash LineStyle2.HasFillFlag with FillStyleType
    // 0x40/0x41/0x42/0x43): the LINE is painted by a tiled/clipped
    // bitmap, not a color. Texel 11.w carries strokeImageId (1-based;
    // 0 = no bitmap stroke). When set, the stroke samples the same
    // imageRect + atlasSlot the fill would (texel 9 + texel 10).
    // Independent stroke bitmaps (where the SWF strokeImageId differs
    // from the fill's) require an extra meta texel for stroke-rect +
    // stroke-atlas — bundle-version-bump territory; not in this slice.
    int vStrokeImageId = int(t11.w + 0.5);   // MT_PRIM at this row, fetched above
    vec4 strokePaint;
    if (vStrokeImageId > 0) {
#ifdef MANTLE_COMPOSED
      vec4 vImgRect = uLBImageRect;     // lerped per-frame (composed morph)
#else
      vec4 vImgRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, y), 0);
#endif
#ifndef MANTLE_NO_PATTERN
      vec4 vAtlas10 = vAtlasSlot;
#else
      vec4 vAtlas10 = texelFetch(uMetaTex, metaAt(MT_ATLAS, y), 0);
#endif
      vec4 imgCol = sampleMappedTopLevelImage(emCoord, vImgRect, vAtlas10, emDx, emDy, vStrokeGradId);
      // Straight-RGBA × stroke color (importer writes (1,1,1, opacity)
      // for bitmap-stroke shapes so vStroke alpha-modulates the bitmap).
      strokePaint = imgCol * vStroke;
#ifndef MANTLE_NO_GRADIENT
    } else if (vStrokeGradId > 0 && strokeCov != 0.0) {
      // Only where the stroke covers something, as the fill above: strokePaint is used only
      // through sAlpha = strokeCov * strokePaint.a, so at strokeCov == 0 either paint composites
      // nothing.
      strokePaint = sampleGradient(vStrokeGradId, emCoord, vShapeBBox, emDx, emDy) * vStroke;
#endif
    } else {
      strokePaint = vStroke;
    }
    float sAlpha = strokeCov * strokePaint.a;
    vec4 sc = vec4(strokePaint.rgb * sAlpha, sAlpha);
    color = sc + color * (1.0 - sc.a);
  }
#endif
  // Per-pixel mask sample. meta texel 7 .w = maskId (1-based meta row
  // of the mask's FLAG_LAYER row). When > 0, the shader walks the
  // mask layer(s) inline via renderFill and multiplies into color.
  //
  // Two paths share this branch:
  //   1. Single-fill (legacy): maskId points at ONE FLAG_LAYER row.
  //      Sample coverage at that row + multiply by fillColor.r.
  //   2. Multi-shape: maskId points at a
  //      FLAG_MASK_BEGIN row. Walk rows until FLAG_MASK_END,
  //      composite the children premultiplied source-over and take
  //      the luminance (isolation field, texel 8 .z = 1) or the alpha
  //      (0) of the result.
  //
  // Both walks run to their END flag however many children there are; their bound is the meta table.
  // Same texel as the gradient ids above (.x/.y fill/stroke gradient, .z clip,
  // .w mask) — reuse that fetch rather than reading the row a second time.
#ifndef MANTLE_NO_CLIP
  int clipId = int(vMeta7.z + 0.5);
  // Only where there is something to clip. The walk below is about one fill walk per
  // child, and its only use is `color *= clipCov`: a fragment whose color is already zero (outside the
  // fill and the stroke, most of a thin stroke's padded quad) keeps its zero whatever the walk returns,
  // since clipCov is a coverage in [0, 1]. The whole vector is tested, not color.a: the color-matrix
  // filter below can create alpha from rgb. Nothing in the walk takes a derivative.
  if (clipId > 0 && !screenZero && any(notEqual(color, vec4(0.0)))) {
    // The union with each child cut by its own clip-path (depth 1; _clipWalk.glsl evalClipCoverage), walked to its
    // FLAG_CLIP_END however many children it has.
    color *= evalClipCoverage(emCoord, invPx, clipId - 1);
  }
#endif
#ifndef MANTLE_NO_MASK
  int maskId = int(vMeta7.w + 0.5);
  if (maskId > 0) {
    int firstRow = maskId - 1;
    // Read first row's flags to see if this is a multi-shape mask.
    vec4 firstCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, firstRow), 0);
    int firstFlags = int(firstCap.w + 0.5);
    bool isMultiShape = (firstFlags & 512) != 0;  // FLAG_MASK_BEGIN = 1<<9
    if (!isMultiShape) {
      // Single-fill fast path. Walked only where the color is not already zero, as the clip above:
      // its only use is the multiply at the end, by mCov * w, a finite factor.
      if (!screenZero && any(notEqual(color, vec4(0.0)))) {
        // The weight first: a black luminance mask or a transparent mask shape has
        // w == 0, and then mCov * w is 0 * w whatever the walk returns (mCov is a finite coverage >= 0,
        // so even the sign of the zero is w's). The walk runs only for a nonzero weight.
        vec4 mFill  = texelFetch(uMetaTex, metaAt(MT_FILL, firstRow), 0);
        vec4 mIso = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, firstRow), 0);
        int mIsLum = int(mIso.z + 0.5);
        float w = (mIsLum != 0)
          ? dot(mFill.rgb, vec3(0.2126, 0.7152, 0.0722)) * mFill.a
          : mFill.a;
        float mCov = 0.0;
        if (w != 0.0) {
          vec4 mBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, firstRow), 0);
          vec4 mGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, firstRow), 0);
          vec4 mStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, firstRow), 0);
          ivec4 mGD = ivec4(int(mGlyph.x), int(mGlyph.y),
                            int(mGlyph.z), int(mGlyph.w));
          bool mEvenOdd = mStrokePad.y > 0.5;
          // Animated mask: inverse-transform into the mask shape's local frame
          // (same as clips + the offscreen bake) so an override on the mask
          // shape moves the mask. Static mask → mLocal == emCoord.
          vec2 mLocal = transformClipCoord(emCoord, firstRow);
#ifdef MANTLE_ROTATED_MAP
          vec2 mMx = slMx, mMy = slMy;
          childMap(firstRow, mMx, mMy);
          mCov = childFill(mLocal, mMx, mMy, mGD, mEvenOdd, mBB);
#else
          mCov = childFill(mLocal, transformClipPx(invPx, firstRow), mGD, mEvenOdd, mBB);
#endif
          // Nested clipPath on the single mask shape (depth 1): AND in
          // its coverage before paint-weight multiplication. Importer's
          // post-walk rewrite plumbs the nested clipId
          // into the mask row's texel 7.z.
          // Only a nonzero coverage needs the nested clip.
          if (mCov > 0.0) {
            vec4 mMeta7 = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, firstRow), 0);
            int innerClipId = int(mMeta7.z + 0.5);
            if (innerClipId > 0) {
              mCov *= evalClipCoverage(emCoord, invPx, innerClipId - 1);
            }
          }
        }
        color *= mCov * w;
      }
    } else if (uHasOffscreenMask != 0 && !ovMoved) {
      // Multi-shape mask, offscreen-baked path. The
      // renderer baked each FLAG_MASK_BEGIN region into a TEXTURE_2D_-
      // ARRAY layer (canvas-sized, R8). Look up the layer via
      // maskId→layer, then sample at the current fragment's framebuffer
      // coordinate. The bake's vertex shader places em-space matches at
      // identical screen positions, so gl_FragCoord.xy / viewportSize
      // is the right UV. (The top of main tested this same sample for 0.)
      int layer = texelFetch(uMaskRowToLayerTex, mrlAt(MRL_ROW, firstRow), 0).r;
      if (layer >= 0) {
        vec2 muv = (gl_FragCoord.xy + uFragOrigin) / uViewportSize;
        float maskA = texture(uMaskRTArray, vec3(muv, float(layer))).r;
        color *= clamp(maskA, 0.0, 1.0);
      }
    } else if (!screenZero) {
      // Multi-shape mask, inline: no bake program bundled, or a row an override moves (ovMoved above).
      // Walk firstRow..firstRow+kMax for FLAG_MASK_END bit, compositing
      // each child premultiplied src-over.
      vec4 acc = vec4(0.0);
      int maskRows = metaRowsOf(textureSize(uMetaTex, 0));
      for (int k = 0; firstRow + k < maskRows; k++) {
        int cRow = firstRow + k;
        vec4 cCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
        int cFlags = int(cCap.w + 0.5);
        if ((cFlags & 256) == 0) break;  // FLAG_LAYER cleared → past end
        // WHAT THE COVERAGE NEEDS FIRST, THE PAINT only WHERE IT COUNTS. The paint (a gradient
        // search or an image) is read only inside the `cCov > 0` test, so it and the texels only it
        // uses come after that test rather than before it. Same fetches, same arguments, same composite
        // where cCov > 0. The paint
        // samplers take no implicit derivative (textureGrad with the hoisted emDx/emDy), so the
        // per-fragment branch around them is legal.
        vec4 cBB     = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
        vec4 cStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, cRow), 0);
        vec4 cGlyph  = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
        vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
        vec4 cGrad7  = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, cRow), 0);
        int cStrokeGradId = int(cGrad7.y + 0.5);
        float cSW   = cStrokePad.x;
        ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                          int(cGlyph.z), int(cGlyph.w));
        bool cEvenOdd = cStrokePad.y > 0.5;
        // Animated mask child: local frame (matching the bake path).
        vec2 cLocal = transformClipCoord(emCoord, cRow);
        float cCov;
        // Stroke present when a width AND either a stroke color or a
        // stroke gradient exists (matches the pattern-child walker) —
        // gating on color alpha alone dropped gradient-stroked children.
        // A bundle with no stroked row ANYWHERE (MANTLE_NO_STROKE: the baked Strokes feature reads every meta row, mask layer rows
        // included) has no stroked mask child, so the child stroke solve below cannot run. strokeMinDist is shared with the
        // top-level pass and is not itself guarded, so without this the solver is compiled into every mask-bearing program: on
        // a masked illustration at 2048 px (strokes stripped) it is 0.75x of the frame, output identical.
#ifdef MANTLE_NO_STROKE
        const bool cIsStroke = false;
#else
        bool cIsStroke = cSW > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0);
#endif
        if (cIsStroke) {
          // Stroke-only mask child (e.g. <line stroke-dasharray=...>):
          // use stroke-coverage helper, honoring per-row DashId.
          int cDashId = int(cStrokePad.w + 0.5);
          vec2 cEPx = transformClipEPx(emDx, emDy, cRow);   // the walk runs in the child's local frame, where a pixel is this size
          strokeDashScale = (cFlags & 1) != 0 ? 0.5 * (cEPx.x + cEPx.y) : 1.0;
          float halfW = cSW * 0.5 * strokeWidthMultiplier(cFlags, cEPx);
          int startCapM  = int(cCap.x + 0.5);
          int joinStyle = int(cCap.y + 0.5);
          float miterLim = cCap.z;
          int endCapMEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, cRow), 0).z + 0.5);
          int endCapM = (endCapMEnc == 0) ? startCapM : (endCapMEnc - 1);
          vec2 _sgDummy; vec4 _seDP, _seDQ;   // the edge record: the ramp takes none
          float minD;
          // a stroke-space row: document terms back, halfW included (one call site for both: strokeWalk)
          bool cLocalSt = (cFlags & FS_STROKE_LOCAL) != 0;
          vec4 cStN = vec4(0.0);
          if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, cRow), 0);
          minD = strokeWalk(cLocal, cGD, cBB, cStN, cLocalSt, halfW,
                            startCapM, endCapM, joinStyle, miterLim, cDashId, _sgDummy,
                            -1e20, strokeAaReachEm(halfW, cEPx), cEPx, false, _seDP, _seDQ);
          cCov = strokeEdgeCov(minD, halfW, vec2(0.0), cEPx, false);   // the ramp (_coverage.glsl)
        } else {
#ifdef MANTLE_ROTATED_MAP
          vec2 cMx = slMx, cMy = slMy;
          childMap(cRow, cMx, cMy);
          cCov = childFill(cLocal, cMx, cMy, cGD, cEvenOdd, cBB);
#else
          cCov = childFill(cLocal, transformClipPx(invPx, cRow), cGD, cEvenOdd, cBB);
#endif
        }
        // A mask child's own clip-path cuts it, as a drawn shape's does: texel 7.z, the rewritten meta
        // row of its clip.
        if (cCov > 0.0) {
          int cClipId = int(cGrad7.z + 0.5);
          if (cClipId > 0) cCov *= evalClipCoverage(emCoord, invPx, cClipId - 1);
        }
        if (cCov > 0.0) {
          vec4 cIso    = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, cRow), 0);
          int cIsLum  = int(cIso.z + 0.5);
          vec2 cLocDx = transformClipDir(emDx, cRow), cLocDy = transformClipDir(emDy, cRow);
          vec4 cPaint;
          if (cIsStroke) {
#ifndef MANTLE_NO_GRADIENT
            cPaint = (cStrokeGradId > 0)
              ? sampleGradient(cStrokeGradId, cLocal, cBB, cLocDx, cLocDy) * cStroke   //
              : cStroke;
#else
            cPaint = cStroke;
#endif
          } else {
            int cFillGradId   = int(cGrad7.x + 0.5);
            int cImgId  = int(cIso.w + 0.5);
            vec4 cFill  = texelFetch(uMetaTex, metaAt(MT_FILL, cRow), 0);
            if (cImgId > 0) {
              vec4 cImgRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, cRow), 0);
              vec4 cAtlas   = texelFetch(uMetaTex, metaAt(MT_ATLAS, cRow), 0);
              cPaint = sampleMappedChildImage(cLocal, cImgRect, cAtlas, cLocDx, cLocDy, cFillGradId) * cFill;   //
            }
#ifndef MANTLE_NO_GRADIENT
            else if (cFillGradId > 0) {
              cPaint = sampleGradient(cFillGradId, cLocal, cBB, cLocDx, cLocDy) * cFill;   //
            }
#endif
            else {
              cPaint = cFill;
            }
          }
          // THE MASK IMAGE IS THE CHILDREN COMPOSITED SOURCE-OVER, and its value is that image's luminance (or alpha)
          // (CSS Masking 1 §7.1). Luminance is linear in the color, so compositing each child's
          // premultiplied luminance lum * a over the others by its alpha a IS the luminance of the composite. Compositing
          // lum * a AS IF IT WERE THE ALPHA would leave the white showing under a black child (lum 0) where the spec has
          // black, and a dark child would take out less than it covers.
          float a = cCov * cPaint.a;
          float v = (cIsLum != 0) ? dot(cPaint.rgb, vec3(0.2126, 0.7152, 0.0722)) * a : a;
          acc.rgb = vec3(v) + acc.rgb * (1.0 - a);
          acc.a   = v      + acc.a   * (1.0 - a);
        }
        if ((cFlags & 1024) != 0) break;  // FLAG_MASK_END
      }
      // acc.a holds the composite luminance/alpha multiplier.
      color *= acc.a;
    }
  }
#endif

#ifndef MANTLE_NO_EXTCLIP
  // External screen-space clip mask (setNodeClip): destination-out / -in
  // by a fixed mask texture, sampled in framebuffer space. Default off.
  // (The top of main tested this same sample for 0.)
  if (uExtClipMode > 0) {
    float em = texture(uExtClipTex, (gl_FragCoord.xy + uFragOrigin) / uViewportSize).a;
    color *= (uExtClipMode == 2) ? (1.0 - em) : em;  // premultiplied → scalar OK
  }
#endif
#ifndef MANTLE_NO_FILTER
  color = applyFilterPre(vFilterId, color);
  if (uFilterCoverageScale > 0.0) color *= uFilterCoverageScale;
#endif
  // Discard sub-byte contributions to avoid unnecessary blending and writes.
  // A raw AAC cover emits one complete paint. Preserve contributions that
  // round to a visible RGBA8 byte, including during endpoint interpolation.
  // A known cover-only unified wire uses the same constant; mixed programs
  // retain their existing piece cutoff.
#if defined(MANTLE_AAC) && (!defined(MANTLE_LB_FILL) || defined(MANTLE_COVER_PAINT_ONLY)) && !defined(MANTLE_NO_COVER_FILL)
  if (color.a < 0.5/255.0) discard;
#elif defined(MANTLE_CPATCH_QUADRATIC_AREA_ONLY)
  // Every drawn fill is one certified paint and the variant contains no stroke.
  if (color.a < 0.5/255.0) discard;
#else
  if (color.a < 1.0/255.0) discard;
#endif
  fragColor = color;
}
