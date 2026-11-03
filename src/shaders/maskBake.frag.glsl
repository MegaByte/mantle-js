#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Per-mask-child bake into a TEXTURE_2D_ARRAY layer. One DrawArrays per
// child, in document order, composited SOURCE-OVER by the fixed-function
// blend (ONE, ONE_MINUS_SRC_ALPHA; maskBake.js) -- the mask image CSS
// Masking 1 defines.
//
// Each child writes its premultiplied luminance (a luminance mask) or its
// alpha (an alpha mask) in R, G and B, and its alpha -- coverage x paint
// alpha, cut by its own clip-path and nested mask -- in A. Luminance is
// linear in the color, so the composite's R IS the luminance of the
// composited image. R is load-bearing: the layer may be R8, and the blend
// reads the source alpha from this output whatever the attachment holds.
//
// The vertex shader emits a full-screen quad over the mask region's
// em-bbox; per-child row is passed via uniform so one vertex buffer is
// reused across all children.

precision highp float;
precision highp int;
precision highp sampler2D;
flat in vec4 vMaskPixelBasis;

// Bundle textures — bound by the renderer's bake pass, same as the
// main draw. Names match mantle.frag.glsl so the shared coverage
// helpers find what they expect.
uniform mat3 uMaskWorld;
uniform int uMaskFullColor;
uniform int uMaskHasWorld;
uniform int uResourcePatternRow;
uniform int uHasPatternGroups;
uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
uniform sampler2D uDashTex;
uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;
uniform sampler2D uSecondaryImageTex;
uniform vec2 uSecondaryImageAtlasSize;
uniform sampler2D uImageTex;
uniform vec2      uImageAtlasSize;
uniform sampler2D uFilterTex;  // unused here, kept to match the main draw's uniform set
uniform vec4      uGlobalBBox;
uniform vec2      uCanvasAR;

// Per-bake-invocation uniforms.
uniform int  uMaskChildRow1Based;  // 1-based meta row of this child
uniform int  uMaskIsLuminance;     // 1 = luma weight, 0 = alpha weight
// 1-based meta row of this mask region's FLAG_MASK_BEGIN row. Used
// to suppress the nested-mask AND when a child carries its own
// parent maskRow in texel 7.w — the importer rewrites maskId on
// ALL layer rows (including mask children that are NOT cross-mask
// references); so the only way to distinguish a real inner-mask
// reference from a "I'm a child of this mask" reference is to
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
// This child's meta texels, fetched by maskBake.vert from the row the uniform names. vCapJoin.w
// is MT_PRIM.z and vGrad7.z is MT_FILTER_BLEND.w; see maskBake.vert.glsl. vFrame is a stroke-space row's frame N
//, zero for every other row.
flat in vec4 vBB, vFill, vStroke, vGlyph, vStrokePad, vCapJoin, vGrad7, vImgRect, vAtlas, vFrame;
out vec4 fragColor;

@@GRADIENT_HELPERS@@
@@COVERAGE@@
@@OVERRIDE_TRANSFORM@@
@@CLIP_WALK@@

vec2 resourceSampleUV(vec2 point) {
  vec2 plane = ((point - uGlobalBBox.xy) / uGlobalBBox.zw * 2.0 - 1.0) * uCanvasAR;
  vec3 mapped = uMaskWorld * vec3(plane.x, -plane.y, 1.0);
  return (mapped.xy / mapped.z + 1.0) * .5;
}

int patternParent(int row) {
  return int(texelFetch(uMetaTex, metaAt(MT_ATLAS, row), 0).z + .5) - 1;
}

vec2 enterPattern(int row, inout vec2 point, inout vec2 dx, inout vec2 dy) {
  vec4 frame = texelFetch(uMetaTex, metaAt(MT_SOLID, row), 0);
  mat2 inversePattern = mat2(frame.x, frame.y, frame.z, frame.w);
  vec4 tile = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, row), 0);
  vec2 size = max(tile.zw, vec2(1e-30));
  point = inversePattern * transformClipCoord(point, row) - tile.xy;
  point -= floor(point / size) * size;
  dx = inversePattern * transformClipDir(dx, row);
  dy = inversePattern * transformClipDir(dy, row);
  return size;
}

void main() {
  int row = uMaskChildRow1Based - 1;
  if (row < 0) discard;
  // Invert the bake projection at the pixel center. This is independent of
  // the cover quad and gives the exact footprint for its canvas dimensions.
  vec2 emPerPixel = uGlobalBBox.zw / (uCanvasAR * uViewportSize);
  vec2 pixelFromCenter = gl_FragCoord.xy - 0.5 * uViewportSize;
  vec2 emCoord = uGlobalBBox.xy + 0.5 * uGlobalBBox.zw
    + vec2(pixelFromCenter.x, -pixelFromCenter.y) * emPerPixel;
  vec2 emDx = vec2(emPerPixel.x, 0.0), emDy = vec2(0.0, -emPerPixel.y);
  if (uMaskHasWorld != 0) {
    emCoord = vEmCoord;
    if(any(notEqual(vMaskPixelBasis,vec4(0.0)))) {
      emDx=vMaskPixelBasis.xy;emDy=vMaskPixelBasis.zw;
    } else { emDx=dFdx(vEmCoord);emDy=dFdy(vEmCoord); }
    emPerPixel = abs(emDx) + abs(emDy);
  }
  vec2 tileSize = vec2(0.0);
  if (uResourcePatternRow > 0) {
    int patternRow = uResourcePatternRow - 1;
    int depth = 0, parent = patternParent(patternRow), rows = metaRowsOf(textureSize(uMetaTex, 0));
    for (int i = 0; i < rows && parent >= 0; i++) { depth++; parent = patternParent(parent); }
    // Walk outermost to innermost without a fixed-depth shader stack.
    for (int level = depth; level >= 0; level--) {
      int ancestor = patternRow;
      for (int i = 0; i < level; i++) ancestor = patternParent(ancestor);
      tileSize = enterPattern(ancestor, emCoord, emDx, emDy);
    }
    emPerPixel = abs(emDx) + abs(emDy);
  }

  vec4 cBB    = vBB;
  vec4 cFill  = vFill;
  vec4 cStroke = vStroke;
  vec4 cGlyph = vGlyph;
  vec4 cStrokePad = vStrokePad;
  vec4 cCapJoin = vCapJoin;
  vec4 cGrad7 = vGrad7;
  vec4 cImgRect = vImgRect;
  vec4 cAtlas   = vAtlas;
  int  cFillGradId   = int(cGrad7.x + 0.5);
  int  cStrokeGradId = int(cGrad7.y + 0.5);
  int  cImgId        = int(cGrad7.z + 0.5);   // MT_FILTER_BLEND.w, carried in .z
  float cSW          = cStrokePad.x;
  ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                    int(cGlyph.z), int(cGlyph.w));
  bool cEvenOdd = cStrokePad.y > 0.5;

  // Animated <mask> child: inverse-transform the sample coord into the
  // child's local frame before the raycast (identical to the clip path).
  vec2 sCoord = transformClipCoord(emCoord, row);
  // Screen derivatives in uniform control flow, for the paint samplers below.
  vec2 sDx = transformClipDir(emDx, row), sDy = transformClipDir(emDy, row);
  // Analytic footprint of one bake pixel in the frame the walks run in: the child's own under an override, whose scale makes a pixel a different size.
  vec2 ePx   = max(emPerPixel, vec2(1e-30));   // a zero derivative only: see mantle.frag.glsl's invPx
  vec2 clipPxInv = 1.0 / ePx;                  // the child's clip is cut at the world coordinate, so it starts from the world's pixel
  vec2 pxInv = transformClipPx(clipPxInv, row);
  if (pxInv != clipPxInv) ePx = 1.0 / pxInv;
  int strokeFlags = int(texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, row), 0).w + 0.5);
  strokeDashScale = (strokeFlags & 1) != 0 ? 0.5 * (ePx.x + ePx.y) : 1.0;
  cSW *= strokeWidthMultiplier(strokeFlags, ePx);

  float cov;
  vec4 paint;
  if (cSW > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {
    // Stroke-layer mask child: distance-to-curve with cap/join + dash.
    int   cDashId   = int(cStrokePad.w + 0.5);
    int   startCap  = int(cCapJoin.x + 0.5);
    int   joinStyle = int(cCapJoin.y + 0.5);
    float miterLim  = cCapJoin.z;
    int   endCapEnc = int(cCapJoin.w + 0.5);   // MT_PRIM.z, carried in .w
    int   endCap    = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
    float halfW     = cSW * 0.5;
    float pxSize    = 0.5 * (ePx.x + ePx.y);
    float halfWMin  = 0.5 * pxSize;
    vec2 _sgDummy; vec4 _seDP, _seDQ;   // the edge record: the ramp takes none
    float minD;
    // a stroke-space row: document terms back, halfW included (strokeWalk: one call site for both)
    bool framedRow = dot(vFrame, vFrame) > 0.0;
    minD = strokeWalk(sCoord, cGD, cBB, framedRow ? vFrame : vec4(0.0), framedRow, halfW,
                      startCap, endCap, joinStyle, miterLim, cDashId, _sgDummy,
                      strokeRampSatD(max(halfW, halfWMin), pxSize), strokeAaReachEm(halfW, ePx), ePx, false, _seDP, _seDQ);
    if (uResourcePatternRow > 0) {
      for (int neighbor = 1; neighbor < 9; neighbor++) {
        int cell = neighbor < 5 ? neighbor - 1 : neighbor;
        int ix = cell % 3 - 1, iy = cell / 3 - 1;
        float reach = halfW + max(ePx.x, ePx.y);
        bool edgeX = ix == 0 || (ix > 0 ? emCoord.x < reach : tileSize.x - emCoord.x < reach);
        bool edgeY = iy == 0 || (iy > 0 ? emCoord.y < reach : tileSize.y - emCoord.y < reach);
        if (edgeX && edgeY) {
          vec2 coord = sCoord + vec2(float(ix), float(iy)) * tileSize;
          float distance;
          distance = strokeWalk(coord, cGD, cBB, framedRow ? vFrame : vec4(0.0), framedRow, halfW,
            startCap, endCap, joinStyle, miterLim, cDashId, _sgDummy,
            strokeRampSatD(max(halfW, halfWMin), pxSize), strokeAaReachEm(halfW, ePx), ePx, false, _seDP, _seDQ);
          minD = min(minD, distance);
        }
      }
    }
    cov = strokeEdgeCov(minD, halfW, vec2(0.0), ePx, false);   // the ramp (_coverage.glsl)
    // A gradient paint is the ramp times the row's paint (1,1,1,opacity x channel opacity), the
    // importer's contract; mask content dropped it.
    paint = (cStrokeGradId > 0)
      ? sampleGradient(cStrokeGradId, sCoord, cBB, sDx, sDy) * cStroke
      : cStroke;
  } else {
    bool mappedFill = false;
    vec2 fillMx = vec2(pxInv.x, 0.0), fillMy = vec2(0.0, pxInv.y);
    if ((uMaskHasWorld != 0 || uResourcePatternRow > 0) && (sDx.y != 0.0 || sDy.x != 0.0)) {
      float det = sDx.x * sDy.y - sDy.x * sDx.y;
      if (det != 0.0) {
        fillMx = vec2(sDy.y, -sDx.y) / det; fillMy = vec2(-sDy.x, sDx.x) / det;
        if (det < 0.0) { fillMx.y = -fillMx.y; fillMy.y = -fillMy.y; }
        mappedFill = true;
      }
    }
    cov = mappedFill ? renderFillM(sCoord, fillMx, fillMy, cGD, cEvenOdd, cBB)
      : renderFill(sCoord, pxInv, cGD, cEvenOdd, cBB);
    if (uResourcePatternRow > 0 && cov < 1.0) {
      for (int neighbor = 1; neighbor < 9; neighbor++) {
        int cell = neighbor < 5 ? neighbor - 1 : neighbor;
        int ix = cell % 3 - 1, iy = cell / 3 - 1;
        bool edgeX = ix == 0 || (ix > 0 ? emCoord.x < ePx.x : tileSize.x - emCoord.x < ePx.x);
        bool edgeY = iy == 0 || (iy > 0 ? emCoord.y < ePx.y : tileSize.y - emCoord.y < ePx.y);
        if (edgeX && edgeY) {
          vec2 point = sCoord + vec2(float(ix), float(iy)) * tileSize;
          cov += mappedFill ? renderFillM(point, fillMx, fillMy, cGD, cEvenOdd, cBB)
            : renderFill(point, pxInv, cGD, cEvenOdd, cBB);
        }
      }
      cov = clamp(cov, 0.0, 1.0);
    }
    if (uHasPatternGroups != 0 && abs(cAtlas.w - 2.0) < 0.5) {
      int patternLayer = texelFetch(uMaskRowToLayerTexBake, mrlAt(1, row), 0).r;
      vec4 groupPaint = patternLayer >= 0 ? texture(uMaskRTArrayPong, vec3(gl_FragCoord.xy / uViewportSize, float(patternLayer))) : vec4(0.0);
      paint = groupPaint.a > 0.0 ? vec4(groupPaint.rgb / groupPaint.a, groupPaint.a) * cFill : vec4(0.0);
    } else if (cImgId > 0) {
      paint = sampleMappedChildImage(sCoord, cImgRect, cAtlas, sDx, sDy, cFillGradId) * cFill;   // (1,1,1,opacity)
    } else if (cFillGradId > 0) {
      paint = sampleGradient(cFillGradId, sCoord, cBB, sDx, sDy) * cFill;
    } else {
      paint = cFill;
    }
  }

  if (cov <= 0.0) discard;
  // The child's own clip-path: meta texel 7.z, the rewritten meta row of its clip, cuts the child as a
  // drawn shape's cuts it -- at the drawn fragment's own coordinate, with each clip child's own clip-path one level
  // deep (_clipWalk.glsl). The bake ignored it, so a clipped mask child masked in everywhere its geometry reached.
  int cClipId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, row), 0).z + 0.5);
  if (cClipId > 0) {
    cov *= evalClipCoverage(emCoord, clipPxInv, cClipId - 1);
    if (cov <= 0.0) discard;
  }
  // Nested-mask depth-1 AND. If this child carries its own mask
  // (texel 7.w = inner maskId, post-importer-rewrite), AND-multiply
  // the inner mask's already-baked coverage into the child's
  // coverage. Read source = uMaskRTArrayPong (Pass-1 snapshot); write
  // target = uMaskRTArray (the ping). Renderer guarantees the inner
  // mask is in the pong array by the time this branch executes.
  // Layer = -1 → no array entry (gated off → no sample).
  int innerMaskId = int(cGrad7.w + 0.5);
  if (innerMaskId > 0 && innerMaskId != uMaskOwnRow) {
    int innerLayer = texelFetch(uMaskRowToLayerTexBake, mrlAt(MRL_ROW, innerMaskId - 1), 0).r;
    if (innerLayer >= 0) {
      vec2 muv = resourceSampleUV(emCoord);
      cov *= clamp(texture(uMaskRTArrayPong, vec3(muv, float(innerLayer))).r, 0.0, 1.0);
      if (cov <= 0.0) discard;
    }
  }
  float a = cov * paint.a;
  float v = (uMaskIsLuminance != 0) ? dot(paint.rgb, vec3(0.2126, 0.7152, 0.0722)) * a : a;
  fragColor = uMaskFullColor != 0 ? vec4(paint.rgb * a, a) : vec4(v, v, v, a);
}
