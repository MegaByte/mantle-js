#version 300 es
// Per-mask-child bake into a TEXTURE_2D_ARRAY layer. One DrawArrays per
// child; children of the same mask accumulate via additive
// `Blend One One` so overlapping mask shapes union their coverage.
//
// The bake pulls the child's coverage × luma/alpha paint weight and
// writes it across all four channels (R is load-bearing; G/B/A echo it
// so the same RT can be sampled as either R8 or RGBA8).
//
// Additive bake: spec-correct premultiplied src-over would require
// programmable blend or a multi-pass read-back, so output diverges
// slightly from spec for mask children with overlapping non-binary
// alpha.
//
// The vertex shader emits a full-screen quad over the mask region's
// em-bbox; per-child row is passed via uniform so one vertex buffer is
// reused across all children.

precision highp float;
precision highp int;
precision highp sampler2D;

// Bundle textures — bound by the renderer's bake pass, same as the
// main draw. Names match mantle.frag.glsl so the shared coverage
// helpers find what they expect.
uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
uniform sampler2D uDashTex;
uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;
uniform sampler2D uImageTex;
uniform vec2      uImageAtlasSize;
uniform sampler2D uFilterTex;  // unused here, kept to match the main draw's uniform set
uniform int       uGradientCount;
uniform int       uGradientStopsCount;
uniform vec4      uGlobalBBox;

// Per-bake-invocation uniforms.
uniform int  uMaskChildRow1Based;  // 1-based meta row of THIS child
uniform int  uMaskIsLuminance;     // 1 = luma weight, 0 = alpha weight
// 1-based meta row of THIS mask region's FLAG_MASK_BEGIN row. Used
// to suppress the nested-mask AND when a child carries its own
// parent maskRow in texel 7.w — the importer rewrites maskId on
// ALL layer rows (including mask children that are NOT cross-mask
// references); so the only way to distinguish a real inner-mask
// reference from a "I'm a child of THIS mask" reference is to
// compare against the region's own maskRow.
uniform int  uMaskOwnRow;

// Nested-mask depth-1 plumbing. Renderer does a two-pass bake:
//   Pass 1: regions whose children carry NO inner-mask reference
//           bake directly into the ping array (uMaskRTArrayPong stays
//           bound to a 1x1x1 dummy; the AND below is gated on
//           innerMaskId>0 so it doesn't sample on this pass anyway).
//   Pass 2: after Pass 1, the renderer snapshots ping -> pong, then
//           bakes the remaining regions with uMaskRTArrayPong = pong.
//           The shader writes to ping (the bake target) and reads
//           from pong — different texture → no WebGL2 feedback loop.
// The row→layer lookup is the same R32I texture as the visible-shape
// path; the renderer binds it on a separate sampler unit during bake
// so they don't fight for one binding.
uniform highp sampler2DArray uMaskRTArrayPong;
uniform highp isampler2D     uMaskRowToLayerTexBake;
uniform vec2                 uViewportSize;  // canvas-pixel (w, h)

// Per-shape override plane — bound by the renderer's bake pass when an
// override table is active, so an ANIMATED <mask> child (its shapes moved
// via the override table) bakes at its transformed position. Same plane +
// same transform (transformClipCoord) the main draw uses for animated clips.
uniform sampler2D uOverrideTex;
uniform int       uHasOverrides;

in  vec2 vEmCoord;
out vec4 fragColor;

@@GRADIENT_HELPERS@@
@@SLUG_COVERAGE@@
@@OVERRIDE_TRANSFORM@@

void main() {
  int row = uMaskChildRow1Based - 1;
  if (row < 0) discard;
  vec4 cBB    = texelFetch(uMetaTex, ivec2(MT_BBOX, row), 0);
  vec4 cFill  = texelFetch(uMetaTex, ivec2(MT_FILL, row), 0);
  vec4 cStroke = texelFetch(uMetaTex, ivec2(MT_STROKE, row), 0);
  vec4 cGlyph = texelFetch(uMetaTex, ivec2(MT_GLYPH_BAND, row), 0);
  vec4 cStrokePad = texelFetch(uMetaTex, ivec2(MT_STROKE_PARAMS, row), 0);
  vec4 cCapJoin = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, row), 0);
  vec4 cGrad7 = texelFetch(uMetaTex, ivec2(MT_PAINT_ID, row), 0);
  vec4 cIso   = texelFetch(uMetaTex, ivec2(MT_FILTER_BLEND, row), 0);
  vec4 cImgRect = texelFetch(uMetaTex, ivec2(MT_IMAGE_RECT, row), 0);
  vec4 cAtlas   = texelFetch(uMetaTex, ivec2(MT_ATLAS, row), 0);
  int  cFillGradId   = int(cGrad7.x + 0.5);
  int  cStrokeGradId = int(cGrad7.y + 0.5);
  int  cImgId        = int(cIso.w + 0.5);
  float cSW          = cStrokePad.x;
  ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                    int(cGlyph.z), int(cGlyph.w));
  bool cEvenOdd = cStrokePad.y > 0.5;

  // Pixel size from the RAW (world) coord — matches the visible clip path.
  vec2 ePx   = max(fwidth(vEmCoord), vec2(1e-6));
  vec2 pxInv = 1.0 / ePx;

  // Animated <mask> child: inverse-transform the sample coord into the
  // child's local frame before the raycast (identical to the clip path).
  vec2 sCoord = transformClipCoord(vEmCoord, row);

  float cov;
  vec4 paint;
  if (cSW > 0.0 && cStroke.a > 0.0) {
    // Stroke-layer mask child: distance-to-curve with cap/join + dash.
    int   cDashId   = int(cStrokePad.w + 0.5);
    int   startCap  = int(cCapJoin.x + 0.5);
    int   joinStyle = int(cCapJoin.y + 0.5);
    float miterLim  = cCapJoin.z;
    int   endCapEnc = int(texelFetch(uMetaTex, ivec2(MT_PRIM, row), 0).z + 0.5);
    int   endCap    = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
    float halfW     = cSW * 0.5;
    float minD = strokeMinDist(sCoord, cGD, cBB, halfW,
                                   startCap, endCap,
                                   joinStyle, miterLim, cDashId);
    float pxSize    = 0.5 * (ePx.x + ePx.y);
    float halfWMin  = 0.5 * pxSize;
    float halfWVis  = max(halfW, halfWMin);
    float weightFade = halfW / halfWVis;
    float distFromEdge = minD - halfWVis;
    cov = (distFromEdge <= 0.5 * pxSize)
      ? clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0) * weightFade
      : 0.0;
    paint = (cStrokeGradId > 0)
      ? sampleGradient(cStrokeGradId, sCoord, cBB)
      : cStroke;
  } else {
    cov = renderFill(sCoord, pxInv, cGD, cEvenOdd, cBB);
    if (cImgId > 0) {
      paint = sampleChildImage(sCoord, cImgRect, cAtlas);
    } else if (cFillGradId > 0) {
      paint = sampleGradient(cFillGradId, sCoord, cBB);
    } else {
      paint = cFill;
    }
  }

  if (cov <= 0.0) discard;
  // Nested-mask depth-1 AND. If this child carries its own mask
  // (texel 7.w = inner maskId, post-importer-rewrite), AND-multiply
  // the inner mask's already-baked coverage into the child's
  // coverage. Read source = uMaskRTArrayPong (Pass-1 snapshot); write
  // target = uMaskRTArray (the ping). Renderer guarantees the inner
  // mask is in the pong array by the time this branch executes.
  // Layer = -1 → no array entry (gated off → no sample).
  int innerMaskId = int(cGrad7.w + 0.5);
  if (innerMaskId > 0 && innerMaskId != uMaskOwnRow) {
    int innerLayer = texelFetch(uMaskRowToLayerTexBake, ivec2(MRL_ROW, innerMaskId - 1), 0).r;
    if (innerLayer >= 0) {
      vec2 muv = gl_FragCoord.xy / uViewportSize;
      cov *= clamp(texture(uMaskRTArrayPong, vec3(muv, float(innerLayer))).r, 0.0, 1.0);
      if (cov <= 0.0) discard;
    }
  }
  float weight = (uMaskIsLuminance != 0)
    ? dot(paint.rgb, vec3(0.2126, 0.7152, 0.0722)) * paint.a
    : paint.a;
  float a = cov * weight;
  fragColor = vec4(a, a, a, a);
}
