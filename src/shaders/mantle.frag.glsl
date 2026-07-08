#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
// uDashTex feeds dashed strokes. Not feature-gated: dashCovered (its consumer)
// is called by the shared stroke-coverage helpers (strokeMinDist), which aren't
// gated. Stays declared; dead-strips at runtime if unused.
uniform sampler2D uDashTex;        // 16 wide × N tall; row = dashId-1
#ifndef MANTLE_NO_GRADIENT
uniform sampler2D uGradientTex;    // RGBA32F, 4 texels wide × N gradients
uniform sampler2D uGradientStops;  // RGBA8, M × 1 packed stops LUT
                                   //   rgb = PREMULTIPLIED stop color
                                   //   a   = stop offset in [0,1]
                                   // Each gradient's stops are at
                                   // [g.stopsOffset, g.stopsOffset+g.stopsCount)
                                   // where (stopsOffset, stopsCount) live in
                                   // the gradient record at texel 10's xy.
                                   // Exact stops, no banding,
                                   // shared format with the COLRv1 dispatch.
uniform int       uGradientCount;
uniform int       uGradientStopsCount;
#endif
#ifndef MANTLE_NO_IMAGE
uniform sampler2D uImageTex;       // RGBA8 image atlas (pattern children + top-level <image>)
uniform vec2      uImageAtlasSize; // pixel dims of uImageTex (for u/v scale)
#endif
#ifndef MANTLE_NO_FILTER
uniform sampler2D uFilterTex;      // RGBA32F, 6 wide × N filters tall (color matrix + kind/sigma)
#endif
uniform vec4 uGlobalBBox;
// Per-shape override table — same texture the vertex shader reads.
// Frag side consumes ONLY the 2D affine (texel 0) + translate (texel 1.xy)
// of the clip's first layer row, to invert-transform the visible shape's
// sample coord before evaluating clip coverage (animatable
// clipper). When uHasOverrides == 0 the inverse is identity and the
// branch collapses.
// Frag-side override use is ONLY transformClipCoord (animated clip / mask
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
#ifndef MANTLE_NO_MASK
uniform highp sampler2DArray uMaskRTArray;
uniform highp isampler2D uMaskRowToLayerTex;
uniform int uHasOffscreenMask;
#endif
uniform vec2 uViewportSize;        // canvas pixels (w, h) — for mask UV mapping (also ext-clip)
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
// Runs BEFORE palette and color matrix in the pipeline so all three
// can compose: bilinear lerp first (consumes the original channel
// encoding), then optional palette substitution, then optional matrix
// transform. uChannelLerpEnabled is coherent → free when disabled.
#ifndef MANTLE_NO_RECOLOR
uniform vec4 uChannelLerpPrimary;
uniform vec4 uChannelLerpContrast;
uniform vec4 uChannelLerpHighlight;
uniform int  uChannelLerpEnabled;
#endif

// Per-draw color matrix recolor (dual-tint fill recolor).
// `out.rgba = uColorMatrix * in.rgba + uColorMatrixOffset` applied to
// the resolved per-shape vFill BEFORE coverage/premultiply. Use case:
// SVGs where R/G/B encode body/highlight/contrast regions; caller picks
// a 4×5 matrix that maps those channels to per-instance
// primary/contrast/highlight tints. Generalizes to hue shifts,
// saturation, monochrome, etc. — same algebra as SVG feColorMatrix.
//
// uColorMatrixEnabled is a coherent (per-draw) uniform int; the
// branch is uniform across the whole draw → free on every modern GPU
// when disabled. Defaults: identity matrix + zero offset, enabled=0.
#ifndef MANTLE_NO_RECOLOR
uniform mat4 uColorMatrix;
uniform vec4 uColorMatrixOffset;
uniform int  uColorMatrixEnabled;
#endif

// Per-draw palette LUT (discrete color substitution). Companion to
// the color matrix: where the matrix is continuous, the palette is
// indexed lookup. The shape's resolved fill picks an index from one
// of its channels; the index reads a 256×1 RGBA8 LUT; the result
// replaces RGB (alpha is passthrough). Applied BEFORE the color
// matrix so the two compose: palette substitution → matrix transform.
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
#ifndef MANTLE_NO_RECOLOR
uniform sampler2D uPalette;
uniform int uPaletteEnabled;
uniform int uPaletteChannel;
uniform int uPaletteSize;
#endif
// Interior-skip occupancy: 1 when this bundle baked any interior grids (opt-in
// opts.occupancyGrid). Coherent per-draw → the whole occupancy branch is free
// (no meta fetch) on the default path where it's 0.
uniform int uHasOccupancy;
// GPU-resident morph path: the FILL coverage for this shape comes from a
// pre-rendered Loop-Blinn coverage RT (the GPU-resident morph mesh wrote it in
// screen space) instead of the per-fragment Slug ray-cast. Compiled only into
// the `MANTLE_LB_COV` fill variant (fillLBCovProg) so the DEFAULT program gains
// no extra sampler — the renderer drives this variant for morph shapes that
// need clip/mask/stroke/filter, which all run BELOW the fCov seam and so compose
// with the LB fill. renderFill stays available for clip/mask/pattern CHILDREN
// (separate geometry); MANTLE_NO_* still drops it when absent.
#ifdef MANTLE_LB_COV
uniform sampler2D uLBCovTex;        // R8/RGBA8 LB fill coverage, screen-space
uniform sampler2D uStrokeCovTex;  // R8/RGBA8 morph stroke coverage — analytic SDF, NOT Loop-Blinn, screen-space
// Allocated texel size of the coverage RTs (pooled, rounded UP to the pool
// quantum — so ≥ viewport). The coverage is rendered into the bottom-left
// viewport-sized region, so screen→UV must divide by THIS, not uViewportSize,
// or the sample reads past the rendered region (shrunk/empty fill).
uniform vec2 uLBCovTexSize;
// Morphing paint fed as uniforms (NOT from uMetaTex) so a composed morph shape
// needs ZERO per-frame meta upload: the route lerps these on the CPU and sets
// them per composed shape. Structural meta (clipId/maskId/gradId/strokeWidth/…)
// is read from uMetaTex as usual (it doesn't morph).
uniform vec4 uLBShapeBBox;          // lerped tight shape bbox (gradient objectBoundingBox)
uniform vec4 uLBFill;               // lerped fill colour
uniform vec4 uLBStroke;             // lerped stroke colour
uniform vec4 uLBImageRect;          // lerped image rect (texel 9) — fill/stroke bitmap mapping
#endif
flat in int vInst;
in vec2 vEmCoord;
in vec4 vOverrideTint;     // multiplied into fill+stroke colour
// Per-attribute absolute overrides (animation drivers). When the
// corresponding mask bit is set, the override replaces the meta value
// at draw time. Mask bits:
//   0x1 = fill, 0x2 = stroke, 0x4 = strokeWidth.
flat in int vOverrideMask;
in vec4 vOverrideFill;
in vec4 vOverrideStroke;
in float vOverrideStrokeWidth;
out vec4 fragColor;

#ifndef MANTLE_NO_FILTER
// uses these; the lean variant drops them (and the uFilterTex sampler).
// Apply feColorMatrix to an unpremultiplied RGBA. For kind >= 2
// (shadow / glow / bevel) the matrix texels are repurposed; the per-shape
// path is the offscreen filter region — pass through here.
vec4 applyFilter(int filterId, vec4 c) {
  if (filterId <= 0) return c;
  int row = filterId - 1;
  vec4 meta = texelFetch(uFilterTex, ivec2(FT_META, row), 0);
  int kind = int(meta.x + 0.5);
  if (kind >= 2) return c;
  vec4 r0 = texelFetch(uFilterTex, ivec2(FT_R0, row), 0);
  vec4 r1 = texelFetch(uFilterTex, ivec2(FT_R1, row), 0);
  vec4 r2 = texelFetch(uFilterTex, ivec2(FT_R2, row), 0);
  vec4 r3 = texelFetch(uFilterTex, ivec2(FT_R3, row), 0);
  vec4 off = texelFetch(uFilterTex, ivec2(FT_OFF, row), 0);
  vec4 o;
  o.r = dot(r0, c) + off.x;
  o.g = dot(r1, c) + off.y;
  o.b = dot(r2, c) + off.z;
  o.a = dot(r3, c) + off.w;
  return clamp(o, 0.0, 1.0);
}

// Apply the per-shape filter to a premultiplied source color. SVG's
// feColorMatrix is specified on the source's UNpremultiplied RGBA scaled
// by coverage; the fragColor we hold is premultiplied (rgb = color*a*cov),
// so we unpremultiply, apply, and re-premultiply.
vec4 applyFilterPre(int filterId, vec4 pre) {
  if (filterId <= 0) return pre;
  float a = pre.a;
  vec3 rgb = a > 0.0 ? pre.rgb / a : pre.rgb;
  vec4 outU = applyFilter(filterId, vec4(rgb, a));
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

@@SLUG_COVERAGE@@
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

// Evaluate a single-level clipPath's coverage at emCoord. `clipId` is
// the 1-based meta row of the clip's FLAG_LAYER row (the first
// child of the multi-row union, or the lone row of a single-shape
// clip). Returns coverage in [0, 1] following SVG clipPath
// children-union semantics.
//
// THIS HELPER DOES NOT RECURSE: it samples each clip child's RAW
// geometry coverage only. Nesting (a clip child carrying its own
// clipId) is handled by the visible-shape clip eval that CALLS this
// helper twice — once for the outer clip, once per child for the
// child's nested clip — and AND-multiplies the two coverages. Depth
// limited to 1 (a clip's clip's clip is ignored). GLSL doesn't
// support recursion; the depth-1 limit keeps shader unroll bounded.
float evalClipCoverageAtRow(vec2 emCoord, vec2 px, int firstRow) {
  vec4 fcap = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, firstRow), 0);
  int fflags = int(fcap.w + 0.5);
  bool multiClip = (fflags & 2048) != 0;  // FLAG_CLIP_BEGIN = 1<<11
  if (!multiClip) {
    vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, firstRow), 0);
    vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, firstRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, firstRow), 0);
    bool cEvenOdd = cStrokePad.y > 0.5;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    vec2 localCoord = transformClipCoord(emCoord, firstRow);
    return renderFill(localCoord, px, cGD, cEvenOdd, cBB);
  }
  float acc = 0.0;
  const int kMaxClipChildren = 16;
  for (int k = 0; k < kMaxClipChildren; k++) {
    int cRow = firstRow + k;
    vec4 ccap = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, cRow), 0);
    int cflags = int(ccap.w + 0.5);
    if ((cflags & 256) == 0) break;  // FLAG_LAYER cleared
    vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, cRow), 0);
    vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, cRow), 0);
    bool cEvenOdd = cStrokePad.y > 0.5;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    vec2 localCoord = transformClipCoord(emCoord, cRow);
    float c = renderFill(localCoord, px, cGD, cEvenOdd, cBB);
    acc = max(acc, c);
    if ((cflags & 4096) != 0) break;  // FLAG_CLIP_END
  }
  return clamp(acc, 0.0, 1.0);
}

// Tier-1 closed-form fill coverage for simple primitives (kind 1=circle,
// 2=rect, 3=roundRect) inscribed in their em-space bbox. The SDF is evaluated
// in EM space and the AA is normalized by the SDF's ON-SCREEN gradient
// (length(dFdx,dFdy)) — so coverage stays correct under ANY affine transform
// (rotation / non-uniform scale / shear), because the screen distortion is
// absorbed by the gradient. `rx` = corner radius (roundRect only). Bodies are
// IQ's sdBox / sdRoundedBox (iquilezles.org/articles/distfunctions2d).
float primFillCoverage(int kind, vec2 p, vec4 bb, float rx) {
  vec2 he = 0.5 * (bb.zw - bb.xy);          // half-extents (em)
  vec2 q  = p - 0.5 * (bb.xy + bb.zw);      // centered on the shape
  float d;
  if (kind == 1) {                          // circle: square bbox ⇒ he.x==he.y
    d = length(q) - min(he.x, he.y);
  } else {                                  // rect (rx=0) / roundRect (rx>0)
    vec2 e = abs(q) - he + rx;
    d = min(max(e.x, e.y), 0.0) + length(max(e, vec2(0.0))) - rx;
  }
  float g = max(length(vec2(dFdx(d), dFdy(d))), 1e-6);   // on-screen gradient
  return clamp(0.5 - d / g, 0.0, 1.0);                   // 0.5 at edge, 1px ramp
}

void main() {
  int y = vInst;
#ifdef MANTLE_LB_COV
  vec4 vShapeBBox = uLBShapeBBox;   // morph paint via uniforms (no per-frame meta upload)
  vec4 vFill      = uLBFill;
#else
  vec4 vShapeBBox = texelFetch(uMetaTex, ivec2(MT_BBOX, y), 0);
  vec4 vFill      = texelFetch(uMetaTex, ivec2(MT_FILL, y), 0);
#endif
  // Per-attribute absolute overrides REPLACE the meta value (animation
  // drivers — fill/stroke/width animations). Tint then multiplies on
  // top so a tint applied alongside an animated fill modulates the
  // animated value.
  if ((vOverrideMask & 1) != 0) vFill = vOverrideFill;
  // Per-shape override tint: straight-RGBA multiply
  // applied BEFORE coverage / premultiply. Identity (vec4(1)) when
  // no override is active, so the non-override paths see no change.
  vFill *= vOverrideTint;
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
  if (uChannelLerpEnabled != 0) {
    vec3 tint = vFill.r * uChannelLerpPrimary.rgb
              + vFill.b * uChannelLerpContrast.rgb;
    float k = clamp(vFill.g + (1.0 - vFill.a), 0.0, 1.0);
    vFill = vec4(mix(tint, uChannelLerpHighlight.rgb, k), vFill.a);
  }
  // Per-draw palette LUT (dual-tint fill recolor).
  // Indexed discrete color substitution: pick a channel,
  // use it as an index into the 256×1 LUT, replace RGB. Applied
  // BEFORE the color matrix so caller can stack palette → matrix.
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
  // Per-draw color-matrix recolor (dual-tint fill recolor).
  // Applied AFTER per-shape override + tint + palette substitution,
  // BEFORE coverage. Acts on the unpremultiplied fill so the matrix is
  // expressed in straight RGBA space (matches feColorMatrix convention).
  if (uColorMatrixEnabled != 0) {
    vFill = clamp(uColorMatrix * vFill + uColorMatrixOffset, 0.0, 1.0);
  }
#endif
#ifdef MANTLE_LB_COV
  vec4 vStroke    = uLBStroke;
#else
  vec4 vStroke    = texelFetch(uMetaTex, ivec2(MT_STROKE, y), 0);
#endif
  if ((vOverrideMask & 2) != 0) vStroke = vOverrideStroke;
  vStroke *= vOverrideTint;
#ifndef MANTLE_NO_RECOLOR
  if (uChannelLerpEnabled != 0) {
    vec3 tint = vStroke.r * uChannelLerpPrimary.rgb
              + vStroke.b * uChannelLerpContrast.rgb;
    float k = clamp(vStroke.g + (1.0 - vStroke.a), 0.0, 1.0);
    vStroke = vec4(mix(tint, uChannelLerpHighlight.rgb, k), vStroke.a);
  }
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
  if (uColorMatrixEnabled != 0) {
    vStroke = clamp(uColorMatrix * vStroke + uColorMatrixOffset, 0.0, 1.0);
  }
#endif
  vec4 vStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, y), 0);
  vec4 vGlyphBand = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, y), 0);
  // v3 bundles have two additional meta texels (6 and 7). v2 and older leave
  // them unread — texelFetch past texture height wraps to row 0 in WebGL2's
  // NEAREST/CLAMP mode, so we instead check the bundle's stride via a uniform
  // that the renderer sets based on bundle version.
  vec4 vCapJoin   = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, y), 0);
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
  vec4 vMeta8  = texelFetch(uMetaTex, ivec2(MT_FILTER_BLEND, y), 0);
  int vFilterId = int(vMeta8.x + 0.5);
  // Per-shape image id (1-based; 0 = no image fill). atlasSlot.w
  // distinguishes 0=image / 1=pattern / 2=vector pattern; sampleTopLevelImage
  // handles 0 and 1 (vector pattern stays in the dedicated block below).
  int vImageId = int(vMeta8.w + 0.5);
  // Texel 7 carries the gradient ids. When > 0 the per-pixel fill /
  // stroke color is replaced with a gradient ramp sample rather than the
  // placeholder-white base color. mask + clip handling reads the
  // same texel further down; we sample once and reuse.
  vec4 vMeta7  = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, y), 0);
  int vFillGradId   = int(vMeta7.x + 0.5);
  int vStrokeGradId = int(vMeta7.y + 0.5);
  bool nonScalingStroke = (flagsShape & 1) != 0;
  float vStrokeWidth = (vOverrideMask & 4) != 0 ? vOverrideStrokeWidth : vStrokePad.x;
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
  vec2 ePx = fwidth(emCoord);
  vec2 invPx = 1.0 / max(ePx, vec2(1e-6));

  // vector-effect="non-scaling-stroke": reinterpret strokeWidth as screen
  // pixels (it was left at its authored em-value by the exporter). Convert
  // to em-space width at THIS fragment by multiplying by the local
  // em-per-pixel scale, which undoes any current 2D transform's scale.
  //
  // Flash LineStyle2 adds per-axis flavours: NoHScale (flagsShape bit 13)
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
  bool noHScale = (flagsShape & (1 << 13)) != 0;
  bool noVScale = (flagsShape & (1 << 14)) != 0;
  if (nonScalingStroke || noHScale || noVScale) {
    float emPerPx;
    if (noHScale && noVScale) emPerPx = 0.5 * (ePx.x + ePx.y);  // both → same as bit 0
    else if (noHScale)        emPerPx = ePx.x;
    else if (noVScale)        emPerPx = ePx.y;
    else                      emPerPx = 0.5 * (ePx.x + ePx.y);  // bit 0 default
    vStrokeWidth *= emPerPx;
  }
  // Every fillable shape is routed through the coverage-texture
  // (drawSlugShape) pixel shader, not the mesh pass, so accumGroupId is
  // not a "skip" signal — render fill from curve+band texture data
  // regardless of accumGroupId.
  bool doFill = vFill.a > 0.0;
  // Tier-1 fast path: a tagged primitive (circle/rect/roundRect) has closed-form
  // coverage — skip the curve ray-cast. Circle (1) additionally requires a
  // square bbox here (so a non-uniformly-scaled circle, whose baked bbox is an
  // ellipse, falls back); rect (2) / roundRect (3) are tagged by the importer
  // only under axis-aligned transforms, so the bbox is trustworthy. roundRect's
  // corner radius rides in meta texel 11.z (cap-style on stroke rows, free on
  // fill rows). primKind is 0 until the importer tags shapes, so this is inert.
  vec4 t11 = texelFetch(uMetaTex, ivec2(MT_PRIM, y), 0);
  int primKind = int(t11.x + 0.5);
  bool squareBB = abs((vShapeBBox.z - vShapeBBox.x) - (vShapeBBox.w - vShapeBBox.y))
                    <= 1e-3 * max(vShapeBBox.z - vShapeBBox.x, 1e-6);
  bool primFast = doFill && (primKind == 2 || primKind == 3
                             || (primKind == 1 && squareBB));
  // Interior-skip occupancy: for a non-primitive fill the importer may have
  // baked a coarse grid of provably-interior cells (meta texel 5 .xy =
  // baseTexelIdx, G), packed into the curve buffer 4 cells/texel. Skip the
  // coverage walk and return 1.0 when this fragment lands in a SOLID_IN cell
  // AND the cell is wider than the AA reach (cellSize ≥ 1.5·emPerPx), so the
  // ≤1px coverage ramp can never touch a boundary — byte-identical to the walk.
  // Off for pattern carriers (texel 5 holds patInvLinear; atlasSlot.w==2).
  bool occSkip = false;
  if (uHasOccupancy == 1 && doFill && !primFast) {
    vec4 t5occ = texelFetch(uMetaTex, ivec2(MT_SOLID, y), 0);
    int occG = int(t5occ.y + 0.5);
    if (occG > 0) {
      vec4 t10occ = texelFetch(uMetaTex, ivec2(MT_ATLAS, y), 0);
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
#ifdef MANTLE_LB_COV
  // The fill silhouette + AA already live in the LB coverage RT
  // (rendered from the GPU-resident morph mesh). Sample it in screen space and
  // SKIP the whole Slug ray-cast / primFast / occupancy machinery for the fill —
  // stroke/clip/mask/filter below are untouched, so they compose with the LB
  // fill. (occSkip/primFast above are dead under this define and compiler-stripped.)
  float fCov = doFill ? texture(uLBCovTex, gl_FragCoord.xy / uLBCovTexSize).r : 0.0;
#else
  float fCov = occSkip ? 1.0
    : !primFast
    ? (doFill ? renderFill(emCoord, 1.0/max(ePx,vec2(1e-6)), GD, evenOddFill, vShapeBBox) : 0.0)
    : primFillCoverage(primKind, emCoord, vShapeBBox, (primKind == 3) ? t11.z : 0.0);
#endif
  // Fill paint: gradient ramp sample when fillGradId > 0, otherwise the
  // flat vFill that came in via meta texel 1. The importer writes
  // fillRgba = (1,1,1,fillOpacity) for gradient shapes so multiplying
  // by vFill preserves alpha modulation.
#ifndef MANTLE_NO_GRADIENT
  vec4 fillPaint = (vFillGradId > 0)
    ? sampleGradient(vFillGradId, emCoord, vShapeBBox) * vFill
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
  if (vImageId > 0) {
    vec4 vAtlas9  = texelFetch(uMetaTex, ivec2(MT_ATLAS, y), 0);
    if (abs(vAtlas9.w - 2.0) >= 0.5) {  // not a vector pattern
#ifdef MANTLE_LB_COV
      vec4 vImgRect = uLBImageRect;     // lerped per-frame (composed morph)
#else
      vec4 vImgRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, y), 0);
#endif
      vec4 imgCol = sampleTopLevelImage(emCoord, vImgRect, vAtlas9);
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
  // composite premultiplied source-over. Capped at 8 children to match
  // the Mantle shader's unroll budget.
  vec4 vAtlasSlot = texelFetch(uMetaTex, ivec2(MT_ATLAS, y), 0);
  if (abs(vAtlasSlot.w - 2.0) < 0.5 && fCov > 0.0) {
    vec4 vImageRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, y), 0);
    vec2 tileOrigin = vImageRect.xy;
    // imageRect.zw is (tileEmW, tileEmH) absolute (matches the bundle
    // packing — texel 9 stores (X, Y, W, H), not (X0, Y0, X1, Y1)).
    vec2 tileSize   = max(vImageRect.zw, vec2(1e-6));
    // Pattern children's curve+band data is anchored at pattern-
    // local em-space (origin = 0,0). patternTransform's inverse LINEAR part is
    // packed in texel 5 (column-major mat2; identity when no patternTransform)
    // — map the user-space sample coord into pattern space BEFORE wrapping so a
    // rotated/skewed pattern (e.g. diagonal stripes) samples + tiles along its
    // own axes. (Its inverse translation is already folded into tileOrigin.)
    vec4 vPatLinv = texelFetch(uMetaTex, ivec2(MT_SOLID, y), 0);
    mat2 patLinv  = mat2(vPatLinv.x, vPatLinv.y, vPatLinv.z, vPatLinv.w);
    vec2 patCoord = patLinv * emCoord;
    vec2 rel    = patCoord - tileOrigin;
    vec2 tileEm = rel - floor(rel / tileSize) * tileSize;
    int firstRow1 = int(vAtlasSlot.x + 0.5);
    int lastRow1  = int(vAtlasSlot.y + 0.5);
    vec2 patPx = 1.0 / max(ePx, vec2(1e-6));
    // Toroidal-wrap neighbor offsets: when a fragment's pixel footprint
    // straddles a tile boundary, also evaluate the child against the
    // pattern's neighboring tile so AA coverage at the seam sums to 1
    // across the wrap. Children whose bbox doesn't reach the tile edge
    // contribute 0 from the neighbor — costs a few extra band-list
    // probes but keeps the inner coverage walk early-out cheap.
    vec2 nearLo = step(tileEm, ePx);                  // 1 if near .x=0 / .y=0
    vec2 nearHi = step(tileSize - tileEm, ePx);       // 1 if near .x=W / .y=H
    vec4 acc = vec4(0.0);
    // Cap: each shape child can produce up to 2 layer rows (fill +
    // stroke), so 16 covers 8 shapes with both modes.
    for (int k = 0; k < 16; k++) {
      int row1 = firstRow1 + k;
      if (row1 > lastRow1) break;
      int rowIdx = row1 - 1;
      // Read only what we need to decide which branch to take. The
      // remaining texels (gradient ids, image atlas slot, cap/join
      // for stroke) are deferred until the branch picks them up.
      vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, rowIdx), 0);
      float cStrokeWidth = cStrokePad.x;
      vec4 cStroke= texelFetch(uMetaTex, ivec2(MT_STROKE, rowIdx), 0);
      vec4 cGrad7  = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, rowIdx), 0);
      int cStrokeGradId = int(cGrad7.y + 0.5);
      vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, rowIdx), 0);
      vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, rowIdx), 0);
      ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                        int(cGlyph.z), int(cGlyph.w));
      if (cStrokeWidth > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {
        // Stroke layer. Fetch cap/join (texel 6) here; image (texel
        // 8/9/10) and fill color/gradient skipped — stroke branch
        // doesn't use them.
        vec4 cCapJoin = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, rowIdx), 0);
        int cStartCap = int(cCapJoin.x + 0.5);
        int cJoinStyle = int(cCapJoin.y + 0.5);
        float cMiterLimit = cCapJoin.z;
        int cEndCapEnc = int(texelFetch(uMetaTex, ivec2(MT_PRIM, rowIdx), 0).z + 0.5);
        int cEndCap = (cEndCapEnc == 0) ? cStartCap : (cEndCapEnc - 1);
        // Read child DashId from texel 3.w so dashed strokes inside
        // <pattern> children render dashed.
        int cDashId = int(cStrokePad.w + 0.5);
        float halfW = cStrokeWidth * 0.5;
        float minD = strokeMinDist(tileEm, cGD, cBB, halfW,
                                       cStartCap, cEndCap,
                                       cJoinStyle, cMiterLimit, cDashId);
        float pxSize = 0.5 * (ePx.x + ePx.y);
        float halfWMin = 0.5 * pxSize;
        float halfWVis = max(halfW, halfWMin);
        float weightFade = halfW / halfWVis;
        float distFromEdge = minD - halfWVis;
        float cCov = 0.0;
        if (distFromEdge <= 0.5 * pxSize) {
          cCov = clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0);
          cCov *= weightFade;
        }
        if (cCov <= 0.0) continue;
        // Paint color: gradient if bound, else solid stroke color.
#ifndef MANTLE_NO_GRADIENT
        vec4 paint = cStrokeGradId > 0
          ? sampleGradient(cStrokeGradId, tileEm, cBB)
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
        float cCov = renderFill(tileEm, patPx, cGD, cEvenOdd, cBB);
        if (nearLo.x > 0.5 && cBB.z > tileSize.x - ePx.x)
          cCov += renderFill(tileEm + vec2(tileSize.x, 0.0), patPx, cGD, cEvenOdd, cBB);
        if (nearHi.x > 0.5 && cBB.x < ePx.x)
          cCov += renderFill(tileEm - vec2(tileSize.x, 0.0), patPx, cGD, cEvenOdd, cBB);
        if (nearLo.y > 0.5 && cBB.w > tileSize.y - ePx.y)
          cCov += renderFill(tileEm + vec2(0.0, tileSize.y), patPx, cGD, cEvenOdd, cBB);
        if (nearHi.y > 0.5 && cBB.y < ePx.y)
          cCov += renderFill(tileEm - vec2(0.0, tileSize.y), patPx, cGD, cEvenOdd, cBB);
        cCov = clamp(cCov, 0.0, 1.0);
        if (cCov <= 0.0) continue;
        // Paint: image sample → gradient → solid. Defer image-rect /
        // atlas-slot reads until we know the row is image-fill.
        vec4 cImg8 = texelFetch(uMetaTex, ivec2(MT_FILTER_BLEND, rowIdx), 0);
        int cImgId = int(cImg8.w + 0.5);
        int cFillGradId = int(cGrad7.x + 0.5);
        vec4 paint;
        if (cImgId > 0) {
          vec4 cImgRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, rowIdx), 0);
          vec4 cAtlas   = texelFetch(uMetaTex, ivec2(MT_ATLAS, rowIdx), 0);
          paint = sampleChildImage(tileEm, cImgRect, cAtlas);
        }
#ifndef MANTLE_NO_GRADIENT
        else if (cFillGradId > 0) {
          paint = sampleGradient(cFillGradId, tileEm, cBB);
        }
#endif
        else {
          vec4 cFill  = texelFetch(uMetaTex, ivec2(MT_FILL, rowIdx), 0);
          paint = cFill;
        }
        float a = cCov * paint.a;
        vec3 premul = paint.rgb * a;
        acc.rgb = premul + acc.rgb * (1.0 - a);
        acc.a   = a      + acc.a   * (1.0 - a);
      }
    }
    color = acc * fCov;
  }
#endif
  // Stroke pass: compute distance to closest point on path; AA-band
  // against halfW. Direct port of MantleStrokeMinDist + the
  // AA falloff from MantleUnified.shader (lines 608-617).
  // MANTLE_NO_STROKE drops the per-shape stroke band-walk for a fill-only
  // variant. strokeMinDist (the helper) is NOT guarded — mask / pattern stroke
  // children still call it; it dead-strips when those are also omitted.
#ifndef MANTLE_NO_STROKE
  if (vStrokeWidth > 0.0 && vStroke.a > 0.0) {
#ifdef MANTLE_LB_COV
    // The stroke geometric coverage (AA + hairline fade already baked) was
    // rendered from the GPU-resident morph stroke pass into a screen-space RT.
    // Sample it instead of the Slug band-walk (which reads the morphing shape's
    // own curves — stale under skipUploads). The strokePaint logic below is
    // untouched, so bitmap/gradient/solid stroke + clip/mask/filter all compose
    // over the morphed stroke.
    float strokeCov = texture(uStrokeCovTex, gl_FragCoord.xy / uLBCovTexSize).r;
#else
    int joinStyle = int(vCapJoin.y + 0.5);
    float miterLimit = vCapJoin.z;
    float halfW = vStrokeWidth * 0.5;
    // Asymmetric line caps (Flash LineStyle2 StartCapStyle ≠ EndCapStyle).
    // Texel 11.z holds endCap as (endCap+1) with sentinel 0 = "same as
    // startCap" — keeps legacy bundles working unchanged.
    int endCapEnc = int(texelFetch(uMetaTex, ivec2(MT_PRIM, y), 0).z + 0.5);
    int endCap = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
    float minD = strokeMinDist(emCoord, GD, vShapeBBox, halfW,
                                   startCap, endCap,
                                   joinStyle, miterLimit, dashId);
    // Mantle's AA falloff. pxSize = avg em-per-pixel; sub-pixel
    // hairlines floor halfW to half a pixel and fade alpha by the
    // true-vs-clamped ratio.
    float pxSize = 0.5 * (ePx.x + ePx.y);
    float halfWMin = 0.5 * pxSize;
    float halfWVis = max(halfW, halfWMin);
    float weightFade = halfW / halfWVis;
    float distFromEdge = minD - halfWVis;
    // Compute geometric coverage first, then modulate by the paint's
    // alpha (bitmap / gradient / solid).
    float strokeCov = 0.0;
    if (distFromEdge <= 0.5 * pxSize) {
      strokeCov = clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0) * weightFade;
    }
#endif
    // Stroke paint priority: bitmap > gradient > solid.
    // Bitmap-fill stroke (Flash LineStyle2.HasFillFlag with FillStyleType
    // 0x40/0x41/0x42/0x43): the LINE is painted by a tiled/clipped
    // bitmap, not a color. Texel 11.w carries strokeImageId (1-based;
    // 0 = no bitmap stroke). When set, the stroke samples the SAME
    // imageRect + atlasSlot the fill would (texel 9 + texel 10).
    // Independent stroke bitmaps (where the SWF strokeImageId differs
    // from the fill's) require an extra meta texel for stroke-rect +
    // stroke-atlas — bundle-version-bump territory; not in this slice.
    int vStrokeImageId = int(texelFetch(uMetaTex, ivec2(MT_PRIM, y), 0).w + 0.5);
    vec4 strokePaint;
    if (vStrokeImageId > 0) {
#ifdef MANTLE_LB_COV
      vec4 vImgRect = uLBImageRect;     // lerped per-frame (composed morph)
#else
      vec4 vImgRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, y), 0);
#endif
      vec4 vAtlas10 = texelFetch(uMetaTex, ivec2(MT_ATLAS, y), 0);
      vec4 imgCol = sampleTopLevelImage(emCoord, vImgRect, vAtlas10);
      // Straight-RGBA × stroke color (importer writes (1,1,1, opacity)
      // for bitmap-stroke shapes so vStroke alpha-modulates the bitmap).
      strokePaint = imgCol * vStroke;
#ifndef MANTLE_NO_GRADIENT
    } else if (vStrokeGradId > 0) {
      strokePaint = sampleGradient(vStrokeGradId, emCoord, vShapeBBox) * vStroke;
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
  //      composite per-child coverage * (luminance or alpha)
  //      via premultiplied source-over. isolation field (texel 8 .z)
  //      = 1 → luminance weighting; 0 → alpha-only.
  //
  // Tile-loop is bounded at 8 children to keep shader compile times
  // sane on weak GPUs (matches the Mantle pattern unroll cap).
  vec4 vMeta7m = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, y), 0);
#ifndef MANTLE_NO_CLIP
  int clipId = int(vMeta7m.z + 0.5);
  if (clipId > 0) {
    int firstRow = clipId - 1;
    vec2 pxInv = 1.0 / max(ePx, vec2(1e-6));
    vec4 fcap = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, firstRow), 0);
    int fflags = int(fcap.w + 0.5);
    bool multiClip = (fflags & 2048) != 0;  // FLAG_CLIP_BEGIN = 1<<11
    float clipCov;
    if (multiClip) {
      // Multi-row union, with optional nested clip on each child.
      // For each clip child we sample its raw geometry coverage,
      // then AND in (multiply by) the nested clip's coverage when
      // the child carries a non-zero clipId at meta texel 7.z.
      // Nested clip eval uses the helper which DOES NOT recurse, so
      // total depth is exactly 1 (outer clip union × per-child
      // nested clip coverage). Two-level nesting (a clip's clip's
      // clip) is silently flattened to the outer two levels.
      float acc = 0.0;
      const int kMaxClipChildren = 16;
      for (int k = 0; k < kMaxClipChildren; k++) {
        int cRow = firstRow + k;
        vec4 ccap = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, cRow), 0);
        int cflags = int(ccap.w + 0.5);
        if ((cflags & 256) == 0) break;  // FLAG_LAYER cleared
        vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, cRow), 0);
        vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, cRow), 0);
        vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, cRow), 0);
        bool cEvenOdd = cStrokePad.y > 0.5;
        ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                          int(cGlyph.z), int(cGlyph.w));
        vec2 localCoord = transformClipCoord(emCoord, cRow);
        float c = renderFill(localCoord, pxInv, cGD, cEvenOdd, cBB);
        // Nested clip AND. Texel 7.z is the rewritten meta-row index
        // of the inner clip's first layer row (importer rewrites
        // ClipId for layer rows so this resolves correctly).
        vec4 cMeta7 = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, cRow), 0);
        int innerClipId = int(cMeta7.z + 0.5);
        if (innerClipId > 0) {
          c *= evalClipCoverageAtRow(emCoord, pxInv, innerClipId - 1);
        }
        acc = max(acc, c);
        if ((cflags & 4096) != 0) break;  // FLAG_CLIP_END
      }
      clipCov = clamp(acc, 0.0, 1.0);
    } else {
      // Single-row clip: same nested-clip AND opportunity. The lone
      // row's clipId points at a nested multi-row clip (or another
      // single-row clip); AND in its coverage.
      vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, firstRow), 0);
      vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, firstRow), 0);
      vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, firstRow), 0);
      bool cEvenOdd = cStrokePad.y > 0.5;
      ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                        int(cGlyph.z), int(cGlyph.w));
      vec2 localCoord = transformClipCoord(emCoord, firstRow);
      clipCov = renderFill(localCoord, pxInv, cGD, cEvenOdd, cBB);
      vec4 cMeta7 = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, firstRow), 0);
      int innerClipId = int(cMeta7.z + 0.5);
      if (innerClipId > 0) {
        clipCov *= evalClipCoverageAtRow(emCoord, pxInv, innerClipId - 1);
      }
    }
    color *= clipCov;
  }
#endif
#ifndef MANTLE_NO_MASK
  int maskId = int(vMeta7m.w + 0.5);
  if (maskId > 0) {
    int firstRow = maskId - 1;
    // Read first row's flags to see if this is a multi-shape mask.
    vec4 firstCap = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, firstRow), 0);
    int firstFlags = int(firstCap.w + 0.5);
    bool isMultiShape = (firstFlags & 512) != 0;  // FLAG_MASK_BEGIN = 1<<9
    if (!isMultiShape) {
      // Single-fill fast path.
      vec2 pxInvM = 1.0 / max(ePx, vec2(1e-6));
      vec4 mBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, firstRow), 0);
      vec4 mFill  = texelFetch(uMetaTex, ivec2(MT_FILL, firstRow), 0);
      vec4 mGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, firstRow), 0);
      vec4 mStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, firstRow), 0);
      vec4 mIso = texelFetch(uMetaTex, ivec2(MT_FILTER_BLEND, firstRow), 0);
      int mIsLum = int(mIso.z + 0.5);
      ivec4 mGD = ivec4(int(mGlyph.x), int(mGlyph.y),
                        int(mGlyph.z), int(mGlyph.w));
      bool mEvenOdd = mStrokePad.y > 0.5;
      // Animated mask: inverse-transform into the mask shape's local frame
      // (same as clips + the offscreen bake) so an override on the mask
      // shape moves the mask. Static mask → mLocal == emCoord.
      vec2 mLocal = transformClipCoord(emCoord, firstRow);
      float mCov = renderFill(mLocal, pxInvM, mGD, mEvenOdd, mBB);
      // Nested clipPath on the single mask shape (depth 1): AND in
      // its coverage before paint-weight multiplication. Importer's
      // post-walk rewrite plumbs the nested clipId
      // into the mask row's texel 7.z.
      vec4 mMeta7 = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, firstRow), 0);
      int innerClipId = int(mMeta7.z + 0.5);
      if (innerClipId > 0) {
        mCov *= evalClipCoverageAtRow(emCoord, pxInvM, innerClipId - 1);
      }
      float w = (mIsLum != 0)
        ? dot(mFill.rgb, vec3(0.2126, 0.7152, 0.0722)) * mFill.a
        : mFill.a;
      color *= mCov * w;
    } else if (uHasOffscreenMask != 0) {
      // Multi-shape mask, offscreen-baked path. The
      // renderer baked each FLAG_MASK_BEGIN region into a TEXTURE_2D_-
      // ARRAY layer (canvas-sized, R8). Look up the layer via
      // maskId→layer, then sample at the current fragment's framebuffer
      // coordinate. The bake's vertex shader places em-space matches at
      // identical screen positions, so gl_FragCoord.xy / viewportSize
      // is the right UV.
      int layer = texelFetch(uMaskRowToLayerTex, ivec2(MRL_ROW, firstRow), 0).r;
      if (layer >= 0) {
        vec2 muv = gl_FragCoord.xy / uViewportSize;
        float maskA = texture(uMaskRTArray, vec3(muv, float(layer))).r;
        color *= clamp(maskA, 0.0, 1.0);
      }
    } else {
      // Multi-shape mask, inline fallback (no bake program bundled).
      // Walk firstRow..firstRow+kMax for FLAG_MASK_END bit, compositing
      // each child premultiplied src-over.
      vec4 acc = vec4(0.0);
      const int kMaxMaskChildren = 8;
      for (int k = 0; k < kMaxMaskChildren; k++) {
        int cRow = firstRow + k;
        vec4 cCap = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, cRow), 0);
        int cFlags = int(cCap.w + 0.5);
        if ((cFlags & 256) == 0) break;  // FLAG_LAYER cleared → past end
        vec4 cBB     = texelFetch(uMetaTex, ivec2(MT_BBOX, cRow), 0);
        vec4 cFill   = texelFetch(uMetaTex, ivec2(MT_FILL, cRow), 0);
        vec4 cStroke = texelFetch(uMetaTex, ivec2(MT_STROKE, cRow), 0);
        vec4 cGlyph  = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, cRow), 0);
        vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, cRow), 0);
        vec4 cGrad7  = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, cRow), 0);
        vec4 cIso    = texelFetch(uMetaTex, ivec2(MT_FILTER_BLEND, cRow), 0);
        vec4 cImgRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, cRow), 0);
        vec4 cAtlas   = texelFetch(uMetaTex, ivec2(MT_ATLAS, cRow), 0);
        int cIsLum  = int(cIso.z + 0.5);
        int cFillGradId   = int(cGrad7.x + 0.5);
        int cStrokeGradId = int(cGrad7.y + 0.5);
        int cImgId  = int(cIso.w + 0.5);
        float cSW   = cStrokePad.x;
        ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                          int(cGlyph.z), int(cGlyph.w));
        bool cEvenOdd = cStrokePad.y > 0.5;
        // Animated mask child: local frame (matching the bake path).
        vec2 cLocal = transformClipCoord(emCoord, cRow);
        float cCov;
        vec4 cPaint;
        if (cSW > 0.0 && cStroke.a > 0.0) {
          // Stroke-only mask child (e.g. <line stroke-dasharray=...>):
          // use stroke-coverage helper, honoring per-row DashId.
          int cDashId = int(cStrokePad.w + 0.5);
          float halfW = cSW * 0.5;
          int startCapM  = int(cCap.x + 0.5);
          int joinStyle = int(cCap.y + 0.5);
          float miterLim = cCap.z;
          int endCapMEnc = int(texelFetch(uMetaTex, ivec2(MT_PRIM, cRow), 0).z + 0.5);
          int endCapM = (endCapMEnc == 0) ? startCapM : (endCapMEnc - 1);
          float minD = strokeMinDist(cLocal, cGD, cBB, halfW,
                                         startCapM, endCapM,
                                         joinStyle, miterLim, cDashId);
          float pxSize = 0.5 * (ePx.x + ePx.y);
          float halfWMin = 0.5 * pxSize;
          float halfWVis = max(halfW, halfWMin);
          float weightFade = halfW / halfWVis;
          float distFromEdge = minD - halfWVis;
          cCov = (distFromEdge <= 0.5 * pxSize)
            ? clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0) * weightFade
            : 0.0;
#ifndef MANTLE_NO_GRADIENT
          cPaint = (cStrokeGradId > 0)
            ? sampleGradient(cStrokeGradId, cLocal, cBB)
            : cStroke;
#else
          cPaint = cStroke;
#endif
        } else {
          cCov = renderFill(cLocal, 1.0/max(ePx,vec2(1e-6)), cGD, cEvenOdd, cBB);
          if (cImgId > 0) {
            cPaint = sampleChildImage(cLocal, cImgRect, cAtlas);
          }
#ifndef MANTLE_NO_GRADIENT
          else if (cFillGradId > 0) {
            cPaint = sampleGradient(cFillGradId, cLocal, cBB);
          }
#endif
          else {
            cPaint = cFill;
          }
        }
        if (cCov > 0.0) {
          float weight = (cIsLum != 0)
            ? dot(cPaint.rgb, vec3(0.2126, 0.7152, 0.0722)) * cPaint.a
            : cPaint.a;
          float a = cCov * weight;
          // Premultiplied src-over composite into acc (we only need .a
          // as the final multiplier — but accumulate via the full vec
          // so the mask spec's color-weighting applies correctly when
          // children have different luminance levels).
          acc.rgb = vec3(a) + acc.rgb * (1.0 - a);
          acc.a   = a      + acc.a   * (1.0 - a);
        }
        if ((cFlags & 1024) != 0) break;  // FLAG_MASK_END
      }
      // acc.a holds the composite luminance/alpha multiplier.
      color *= acc.a;
    }
  }
#endif
  // Discard fully-transparent pixels so they don't write painter z and
  // occlude later strokes (the bbox quad covers more than the actual
  // shape — pixels outside the shape have alpha=0 but would still update
  // depth, which would block stroke draws of the same shape's stroke or
  // earlier shapes' strokes that pass through the bbox region).
#ifndef MANTLE_NO_EXTCLIP
  // External screen-space clip mask (setNodeClip): destination-out / -in
  // by a fixed mask texture, sampled in framebuffer space. Default off.
  if (uExtClipMode > 0) {
    float em = texture(uExtClipTex, gl_FragCoord.xy / uViewportSize).a;
    color *= (uExtClipMode == 2) ? (1.0 - em) : em;  // premultiplied → scalar OK
  }
#endif
#ifndef MANTLE_NO_FILTER
  color = applyFilterPre(vFilterId, color);
#endif
  if (color.a < 1.0/255.0) discard;
  fragColor = color;
}
