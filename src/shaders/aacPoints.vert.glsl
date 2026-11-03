#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// aacPoints.vert.glsl — AAC coverage for SMALL shapes, computed in the VERTEX stage.
//
//
// The inputs match the cover-quad fragment exactly: em at the pixel center comes from the inverse of the em->pixel affine
// (the cover quad interpolates the same affine), and pixels per em is what fwidth(em) gives for that affine. Grid pixels
// that miss the shape get coverage 0 and the fragment shader discards them, so the grid only has to be a superset of
// the pixels the shape touches. See aacPointsDraw.js for which draws take this route.
//
// One point per entry of a per-draw list. Each point names its meta row, its column and row in that row's
// own grid, and what it paints: the FILL, the exact walk; or the STROKE, the fill shader's stroke pass (mantle.frag.glsl,
// the block after "WHO PAINTS THE STROKE"), the same statements on the same meta texels. A row's grid is its own on-screen
// extent, so one large shape does not size every row's grid, and a row with both paints lists its fill points before its
// stroke points: two points blended OVER in that order are the one fragment's fill-then-stroke composite.
#define MANTLE_AAC
#define MANTLE_NO_IMAGE
#ifndef MANTLE_POINTS_GRADIENT
#define MANTLE_NO_GRADIENT   // the gradient sampler (and its stop texture reads) only for a draw that has a gradient row
#endif

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uCurveData;
uniform sampler2D uBandData;
uniform sampler2D uMetaTex;
// Declared for the shared coverage helpers; a fill-only point draw never samples them.
uniform sampler2D uDashTex;
uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;
uniform sampler2D uSecondaryImageTex;
uniform vec2 uSecondaryImageAtlasSize;
uniform sampler2D uImageTex;
uniform vec2      uImageAtlasSize;
uniform sampler2D uFilterTex;
uniform vec4      uGlobalBBox;

@@BUNDLE_LAYOUT@@
@@GRADIENT_HELPERS@@
@@COVERAGE@@

// A CLIPPED ROW (MANTLE_POINTS_CLIP): the fill shader's clip walk (_clipWalk.glsl, the same text mantle.frag and maskBake.frag
// share), taken at the point. The route takes no override table, so the clip child's override transform is the identity.
#if defined(MANTLE_POINTS_CLIP) || defined(MANTLE_POINTS_MASK)
uniform sampler2D uOverrideTex;
const int uHasOverrides = 0;
@@OVERRIDE_TRANSFORM@@
@@CLIP_WALK@@
#endif

uniform vec2  uCanvasAR;
uniform vec2  uViewportSize;
uniform mat3  uWorldM;      // identity when the draw has no worldMatrix
uniform float uDrawAlpha;
uniform int   uStrokeExactAa;   // the renderer's setStrokeExactAa, as the fill shader's uniform
// The draw's colorMatrix, as mantle.frag applies it: to the STRAIGHT paint, after the draw's alpha is folded in and before
// the gradient multiply, the alpha test and the coverage / premultiply. Off (0) for a draw with none, or an identity matrix with a zero offset.
uniform mat4  uColorMatrix;
uniform vec4  uColorMatrixOffset;
uniform int   uColorMatrixEnabled;

#ifdef MANTLE_POINTS_GEN
// THE POINTS ARE GENERATED, not listed: one table entry per (row, paint) in draw order -- x = its first point's index, y = the meta row | paint << 16,
// z = the grid width, w = the grid origin x | y << 16 (each biased by 2^15) -- and a point is found from gl_VertexID by a binary search over the entries.
// The search is bounded by the BLOCK BOUNDS after the entries: for every 64 points, the entry holding the block's first point (four to a texel, one
// more for the last point), so it spans the entries of one block, usually one or two. (A search over all of them cost 2-10% GPU on point draws.)
// It is the same (row, column, row, paint) the CPU list carried, built from a table of a few bytes per row instead of 8 bytes per pixel.
uniform highp usampler2D uPtTable;
uniform int uPtEntries;
uvec4 ptTexel(int i) { return texelFetch(uPtTable, ivec2(i & 4095, i >> 12), 0); }
uvec4 pointAt(int id) {
  int j = id >> 6, q = uPtEntries + (j >> 2), c = j & 3;
  uvec4 bb = ptTexel(q);
  int lo = int(bb[c]), hi = int(c == 3 ? ptTexel(q + 1).x : bb[c + 1]);
  while (lo < hi) {
    int mid = (lo + hi + 1) >> 1;
    if (int(ptTexel(mid).x) <= id) lo = mid; else hi = mid - 1;
  }
  uvec4 e = ptTexel(lo);
  uint k = uint(id) - e.x, w = e.z;
  return uvec4(e.y & 0xffffu, (e.w & 0xffffu) + k % w, (e.w >> 16) + k / w, e.y >> 16);
}
#else
in uvec4 aPt;               // per point: the meta row, its grid column and row, and what it paints (0 fill, 1 stroke)
#endif
out vec4 vColor;            // premultiplied color x coverage


// The kernel the paint blocks walk children with: the axis-aligned exact walk (the point program has no rotated variant of them; the route
// declines a mask, pattern or gradient row under a rotated map).
float childFill(vec2 c, vec2 invPx, ivec4 cGD, bool evenOdd, vec4 cBB) { return renderFillAAC(c, invPx, cGD, evenOdd, cBB); }

#ifdef MANTLE_POINTS_MASK
// A masked row: mantle.frag's mask multiply on the finished color, the INLINE path -- the single-fill fast path, and the
// multi-shape walk (children composited source-over, the value their luminance or alpha), which mantle.frag takes where no bake is bound.
// A baked layer is a screen-space image of the same walk; the point evaluates it where it stands. No override table: the identity transform.
float maskFactor(int s, vec2 emCoord, vec2 ePx, vec2 invPx, vec2 emDx, vec2 emDy) {
  int maskId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).w + 0.5);
  if (maskId <= 0) return 1.0;
  int firstRow = maskId - 1;
  vec4 firstCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, firstRow), 0);
  bool isMultiShape = (int(firstCap.w + 0.5) & 512) != 0;   // FLAG_MASK_BEGIN
  if (!isMultiShape) {
    vec4 mFill  = texelFetch(uMetaTex, metaAt(MT_FILL, firstRow), 0);
    vec4 mIso = texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, firstRow), 0);
    float w = (int(mIso.z + 0.5) != 0) ? dot(mFill.rgb, vec3(0.2126, 0.7152, 0.0722)) * mFill.a : mFill.a;
    float mCov = 0.0;
    if (w != 0.0) {
      vec4 mBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, firstRow), 0);
      vec4 mGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, firstRow), 0);
      bool mEvenOdd = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, firstRow), 0).y > 0.5;
      mCov = childFill(emCoord, invPx, ivec4(int(mGlyph.x), int(mGlyph.y), int(mGlyph.z), int(mGlyph.w)), mEvenOdd, mBB);
      if (mCov > 0.0) {
        int innerClipId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, firstRow), 0).z + 0.5);
        if (innerClipId > 0) mCov *= evalClipCoverage(emCoord, invPx, innerClipId - 1);
      }
    }
    return mCov * w;
  }
  vec4 acc = vec4(0.0);
  int maskRows = metaRowsOf(textureSize(uMetaTex, 0));
  for (int k = 0; firstRow + k < maskRows; k++) {
    int cRow = firstRow + k;
    vec4 cCap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
    int cFlags = int(cCap.w + 0.5);
    if ((cFlags & 256) == 0) break;
    vec4 cBB     = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
    vec4 cStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, cRow), 0);
    vec4 cGlyph  = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
    vec4 cGrad7  = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, cRow), 0);
    int cStrokeGradId = int(cGrad7.y + 0.5);
    float cSW = cStrokePad.x;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y), int(cGlyph.z), int(cGlyph.w));
    bool cEvenOdd = cStrokePad.y > 0.5;
    float cCov;
    bool cIsStroke = cSW > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0);
    if (cIsStroke) {
      int cDashId = int(cStrokePad.w + 0.5);
      strokeDashScale = (cFlags & 1) != 0 ? 0.5 * (ePx.x + ePx.y) : 1.0;
          float halfW = cSW * 0.5 * strokeWidthMultiplier(cFlags, ePx);
      int startCapM = int(cCap.x + 0.5), joinStyle = int(cCap.y + 0.5);
      float miterLim = cCap.z;
      int endCapMEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, cRow), 0).z + 0.5);
      int endCapM = (endCapMEnc == 0) ? startCapM : (endCapMEnc - 1);
      vec2 _sgDummy; vec4 _seDP, _seDQ;
      float minD;
      bool cLocalSt = (cFlags & FS_STROKE_LOCAL) != 0;   // one call site for both arms (strokeWalk)
      vec4 cStN = vec4(0.0);
      if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, cRow), 0);
      minD = strokeWalk(emCoord, cGD, cBB, cStN, cLocalSt, halfW,
                        startCapM, endCapM, joinStyle, miterLim, cDashId, _sgDummy,
                        -1e20, strokeAaReachEm(halfW, ePx), ePx, false, _seDP, _seDQ);
      cCov = strokeEdgeCov(minD, halfW, vec2(0.0), ePx, false);
    } else {
      cCov = childFill(emCoord, invPx, cGD, cEvenOdd, cBB);
    }
    if (cCov > 0.0) {
      int cClipId = int(cGrad7.z + 0.5);
      if (cClipId > 0) cCov *= evalClipCoverage(emCoord, invPx, cClipId - 1);
    }
    if (cCov > 0.0) {
      int cIsLum = int(texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, cRow), 0).z + 0.5);
      vec4 cPaint;
      if (cIsStroke) {
#ifdef MANTLE_POINTS_GRADIENT
        cPaint = (cStrokeGradId > 0) ? sampleGradient(cStrokeGradId, emCoord, cBB, emDx, emDy) * cStroke : cStroke;
#else
        cPaint = cStroke;
#endif
      } else {
        int cFillGradId = int(cGrad7.x + 0.5);
        vec4 cFill = texelFetch(uMetaTex, metaAt(MT_FILL, cRow), 0);
#ifdef MANTLE_POINTS_GRADIENT
        cPaint = (cFillGradId > 0) ? sampleGradient(cFillGradId, emCoord, cBB, emDx, emDy) * cFill : cFill;
#else
        cPaint = cFill;
#endif
      }
      float a = cCov * cPaint.a;
      float v = (cIsLum != 0) ? dot(cPaint.rgb, vec3(0.2126, 0.7152, 0.0722)) * a : a;
      acc.rgb = vec3(v) + acc.rgb * (1.0 - a);
      acc.a   = v      + acc.a   * (1.0 - a);
    }
    if ((cFlags & 1024) != 0) break;   // FLAG_MASK_END
  }
  return acc.a;
}
#endif


#ifdef MANTLE_POINTS_PATTERN
// A vector-pattern fill: mantle.frag's pattern block (texel 10 .w == 2), axis-aligned map, children with fill, gradient or
// stroke paints (an image child declines the route). The tile coordinate is the pattern-space position wrapped to the tile, each child's
// coverage is walked at it and at all eight seam neighbors, and the children composite source-over. THE CHILDREN'S PIXEL IS THE PIXEL IN
// Pattern space: patLinv maps the em derivatives to the tile's own units, so a scaled patternTransform widens or narrows every
// child's ramp, stroke reach and seam window with it, exactly as the fragment's cEPx / cInvPx do. Returns the premultiplied paint,
// before the fill's coverage.
vec4 patternPaint(int s, vec2 emCoord, vec2 ePx, vec2 invPx, vec2 emDx, vec2 emDy, vec4 vAtlasSlot) {
  vec4 vImageRect = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, s), 0);
  vec2 tileOrigin = vImageRect.xy;
  vec2 tileSize = max(vImageRect.zw, vec2(1e-30));
  vec4 vPatLinv = texelFetch(uMetaTex, metaAt(MT_SOLID, s), 0);
  mat2 patLinv = mat2(vPatLinv.x, vPatLinv.y, vPatLinv.z, vPatLinv.w);
  vec2 patCoord = patLinv * emCoord;
  vec2 patDx = patLinv * emDx, patDy = patLinv * emDy;
  vec2 cEPx = ePx, cInvPx = invPx;
  if (vPatLinv.x != 1.0 || vPatLinv.y != 0.0 || vPatLinv.z != 0.0 || vPatLinv.w != 1.0) {
    cEPx = abs(patDx) + abs(patDy);
    cInvPx = 1.0 / max(cEPx, vec2(1e-30));
  }
  vec2 rel = patCoord - tileOrigin;
  vec2 tileEm = rel - floor(rel / tileSize) * tileSize;
  int firstRow1 = int(vAtlasSlot.x + 0.5), lastRow1 = int(vAtlasSlot.y + 0.5);
  vec2 nearLo = step(tileEm, cEPx), nearHi = step(tileSize - tileEm, cEPx);
  vec4 acc = vec4(0.0);
  for (int row1 = firstRow1; row1 <= lastRow1; row1++) {
    int rowIdx = row1 - 1;
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, rowIdx), 0);
    float cStrokeWidth = cStrokePad.x;
    vec4 cStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, rowIdx), 0);
    vec4 cGrad7 = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, rowIdx), 0);
    int cStrokeGradId = int(cGrad7.y + 0.5);
    vec4 cBB = texelFetch(uMetaTex, metaAt(MT_BBOX, rowIdx), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, rowIdx), 0);
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y), int(cGlyph.z), int(cGlyph.w));
    if (cStrokeWidth > 0.0 && (cStroke.a > 0.0 || cStrokeGradId > 0)) {
      vec4 cCapJoin = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, rowIdx), 0);
      int cStartCap = int(cCapJoin.x + 0.5), cJoinStyle = int(cCapJoin.y + 0.5);
      float cMiterLimit = cCapJoin.z;
      int cEndCapEnc = int(texelFetch(uMetaTex, metaAt(MT_PRIM, rowIdx), 0).z + 0.5);
      int cEndCap = (cEndCapEnc == 0) ? cStartCap : (cEndCapEnc - 1);
      int cDashId = int(cStrokePad.w + 0.5);
      strokeDashScale = (int(cCapJoin.w + 0.5) & 1) != 0 ? 0.5 * (cEPx.x + cEPx.y) : 1.0;
        float halfW = cStrokeWidth * 0.5 * strokeWidthMultiplier(int(cCapJoin.w + 0.5), cEPx);
      vec2 _sgDummy; vec4 _seDP, _seDQ;
      float minD;
      bool cLocalSt = (int(cCapJoin.w + 0.5) & FS_STROKE_LOCAL) != 0;   // one call site for both arms (strokeWalk)
      vec4 cStN = vec4(0.0);
      if (cLocalSt) cStN = texelFetch(uMetaTex, metaAt(MT_SOLID, rowIdx), 0);
      minD = strokeWalk(tileEm, cGD, cBB, cStN, cLocalSt, halfW,
                        cStartCap, cEndCap, cJoinStyle, cMiterLimit, cDashId, _sgDummy,
                        -1e20, strokeAaReachEm(halfW, cEPx), cEPx, false, _seDP, _seDQ);
      float cCov = strokeEdgeCov(minD, halfW, vec2(0.0), cEPx, false);
      if (cCov <= 0.0) continue;
#ifdef MANTLE_POINTS_GRADIENT
      vec4 paint = cStrokeGradId > 0 ? sampleGradient(cStrokeGradId, tileEm, cBB, patDx, patDy) * cStroke : cStroke;
#else
      vec4 paint = cStroke;
#endif
      float a = cCov * paint.a;
      acc.rgb = paint.rgb * a + acc.rgb * (1.0 - a);
      acc.a   = a + acc.a * (1.0 - a);
    } else {
      bool cEvenOdd = cStrokePad.y > 0.5;
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
          float r = childFill(q, cInvPx, cGD, cEvenOdd, cBB);
          cCov = (nb == 0) ? r : cCov + r;
        }
      }
      cCov = clamp(cCov, 0.0, 1.0);
      if (cCov <= 0.0) continue;
      int cFillGradId = int(cGrad7.x + 0.5);
      vec4 cFill = texelFetch(uMetaTex, metaAt(MT_FILL, rowIdx), 0);
#ifdef MANTLE_POINTS_GRADIENT
      vec4 paint = cFillGradId > 0 ? sampleGradient(cFillGradId, tileEm, cBB, patDx, patDy) * cFill : cFill;
#else
      vec4 paint = cFill;
#endif
      float a = cCov * paint.a;
      acc.rgb = paint.rgb * a + acc.rgb * (1.0 - a);
      acc.a   = a + acc.a * (1.0 - a);
    }
  }
  return acc;
}
#endif

// The fill vertex shader's em -> clip mapping (mantle.vert.glsl), taken to window pixels.
vec2 emToPx(vec2 em) {
  vec2 uv = (em - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 c = uWorldM * vec3(plane.x, -plane.y, 1.0);
  return (c.xy / c.z * 0.5 + 0.5) * uViewportSize;
}

// THE STROKE, as the fill shader paints a stroke row (mantle.frag.glsl, from its per-fragment setup through
// `color = sc + color * (1.0 - sc.a)`): the same meta reads, the same derived width, the same walk and the same coverage.
// Only a solid stroke paint reaches here (aacPointsDraw.js declines gradient and bitmap strokes), and no override, palette or channelLerp
// is bound (a colorMatrix is), so the paint is the meta color with the draw's alpha, as vOverrideTint folds it. Compiled only for a draw that
// strokes (MANTLE_POINTS_STROKE): the stroke walk is most of the program, and a fill-only draw should not carry it.
#ifdef MANTLE_POINTS_STROKE
vec4 strokeColorAt(int s, vec2 emCoord, vec2 ePx, ivec4 GD, vec4 vShapeBBox, vec2 emDx, vec2 emDy) {
  vec4 vStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, s), 0);
  vec4 vCapJoin = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, s), 0);
  vec4 t11 = texelFetch(uMetaTex, metaAt(MT_PRIM, s), 0);
  int startCap = int(vCapJoin.x + 0.5);
  int flagsShape = int(vCapJoin.w + 0.5);
  int primKind = int(t11.x + 0.5);
  int dashId = int(vStrokePad.w + 0.5);
  bool nonScalingStroke = (flagsShape & 1) != 0;
  float vStrokeWidth = vStrokePad.x;
  bool squareBB = abs((vShapeBBox.z - vShapeBBox.x) - (vShapeBBox.w - vShapeBBox.y))
                    <= 1e-3 * max(vShapeBBox.z - vShapeBBox.x, vShapeBBox.w - vShapeBBox.y);
  bool noHScale = (flagsShape & (1 << 13)) != 0;
  bool noVScale = (flagsShape & (1 << 14)) != 0;
  strokeDashScale = nonScalingStroke ? 0.5 * (ePx.x + ePx.y) : 1.0;
  if (nonScalingStroke || noHScale || noVScale) {
    float emPerPx;
    if (noHScale && noVScale) emPerPx = 0.5 * (ePx.x + ePx.y);
    else if (noHScale)        emPerPx = ePx.x;
    else if (noVScale)        emPerPx = ePx.y;
    else                      emPerPx = 0.5 * (ePx.x + ePx.y);
    vStrokeWidth *= emPerPx;
  }
  vec4 vStroke = texelFetch(uMetaTex, metaAt(MT_STROKE, s), 0);
  vStroke.a *= uDrawAlpha;
  if (uColorMatrixEnabled != 0) vStroke = clamp(uColorMatrix * vStroke + uColorMatrixOffset, 0.0, 1.0);
  if (!(vStrokeWidth > 0.0 && vStroke.a > 0.0)) return vec4(0.0);
  int joinStyle = int(vCapJoin.y + 0.5);
  float miterLimit = vCapJoin.z;
  float halfW = vStrokeWidth * 0.5;
  int endCapEnc = int(t11.z + 0.5);
  int endCap = (endCapEnc == 0) ? startCap : (endCapEnc - 1);
  float minD;
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
    bool locSt = (flagsShape & FS_STROKE_LOCAL) != 0;   // one call site for both arms (strokeWalk)
    if (locSt) edgeN = texelFetch(uMetaTex, metaAt(MT_SOLID, s), 0);
    minD = strokeWalk(emCoord, GD, vShapeBBox, locSt ? edgeN : vec4(0.0), locSt, halfW,
                      startCap, endCap, joinStyle, miterLimit, dashId, strokeGrad,
                      max(halfW - 0.5 * length(ePx), 0.0), strokeAaReachEm(halfW, ePx), ePx, true, edgeP, edgeQ);
  }
#ifdef MANTLE_STROKE_EXACT
  float strokeCov = (uStrokeExactAa != 0 && edgeP.w > 0.0 && halfW >= 0.25 * (ePx.x + ePx.y))
                    ? strokeExactCov(edgeP, edgeQ, halfWS, edgeN, ePx)
                    : strokeEdgeCov(minD, halfW, strokeGrad, ePx, uStrokeExactAa != 0);
#else
  float strokeCov = strokeEdgeCov(minD, halfW, strokeGrad, ePx, uStrokeExactAa != 0);
#endif
  // Stroke paint: a gradient ramp times the row's paint (1,1,1,opacity), where the stroke covers anything; else the solid color
  vec4 strokePaint = vStroke;
#ifdef MANTLE_POINTS_GRADIENT
  int vStrokeGradId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).y + 0.5);
  if (vStrokeGradId > 0 && strokeCov != 0.0) strokePaint = sampleGradient(vStrokeGradId, emCoord, vShapeBBox, emDx, emDy) * vStroke;
#endif
  float sAlpha = strokeCov * strokePaint.a;
  return vec4(strokePaint.rgb * sAlpha, sAlpha);
}
#endif

void main() {
  gl_PointSize = 1.0;
#ifdef MANTLE_POINTS_GEN
  uvec4 aPt = pointAt(gl_VertexID);
#endif
  int s = int(aPt.x);
  vec4 bb = texelFetch(uMetaTex, metaAt(MT_BBOX, s), 0);
  vec2 p00 = emToPx(bb.xy);
  vec2 p10 = emToPx(bb.zy), p01 = emToPx(bb.xw), p11 = emToPx(bb.zw);
  vec2 lo = min(min(p00, p10), min(p01, p11));
  // The grid's origin is the bbox's low pixel corner; a point's offsets from it are biased by 2^15 (they may be negative:
  // a stroke's miter spike paints before its bbox). The route lists exactly the pixels the row can reach.
  vec2 origin = floor(lo);
  vec2 pc = origin + (vec2(aPt.yz) - 32768.0) + 0.5;
  // em -> pixel linear part, and its inverse: pixel offsets back to em, as the cover quad's interpolation does.
  mat2 W2 = mat2(uWorldM[0].xy, uWorldM[1].xy);
  mat2 J = mat2(0.5 * uViewportSize.x, 0.0, 0.0, 0.5 * uViewportSize.y) * W2 * mat2(1.0, 0.0, 0.0, -1.0)
         * mat2(2.0 * uCanvasAR.x / uGlobalBBox.z, 0.0, 0.0, 2.0 * uCanvasAR.y / uGlobalBBox.w);
  mat2 Ji = inverse(J);
  vec2 em = bb.xy + Ji * (pc - p00);
  vec2 ePx = abs(Ji[0]) + abs(Ji[1]);             // fwidth(em) = |d em / d px.x| + |d em / d px.y|
  vec2 invPx = 1.0 / max(ePx, vec2(1e-30));      // a zero derivative only: see mantle.frag.glsl's invPx
  vec4 gb = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, s), 0);
  ivec4 GD = ivec4(int(gb.x), int(gb.y), int(gb.z), int(gb.w));
  if (aPt.w == 0u) {
    bool evenOdd = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, s), 0).y > 0.5;
#ifdef MANTLE_ROTATED_MAP
    // A rotated or skewed draw takes the pixel as em sees it, as the fill shader's rotated-map program does
    // (mantle.frag.glsl's slMx / slMy, from the signed derivatives; here those are Ji's columns).
    vec2 emDx = Ji[0], emDy = Ji[1];
    vec2 slMx = vec2(invPx.x, 0.0), slMy = vec2(0.0, invPx.y);
    if (emDx.y != 0.0 || emDy.x != 0.0) {
      float det = emDx.x * emDy.y - emDy.x * emDx.y;
      if (det != 0.0) {
        slMx = vec2(emDy.y, -emDx.y) / det;
        slMy = vec2(-emDy.x, emDx.x) / det;
        if (det < 0.0) { slMx.y = -slMx.y; slMy.y = -slMy.y; }
      }
    }
    float cov = renderFillAACM(em, slMx, slMy, GD, evenOdd, bb);
#else
    float cov = renderFillAAC(em, invPx, GD, evenOdd, bb);
#endif
    vec4 fill = texelFetch(uMetaTex, metaAt(MT_FILL, s), 0);
    fill.a *= uDrawAlpha;
    if (uColorMatrixEnabled != 0) fill = clamp(uColorMatrix * fill + uColorMatrixOffset, 0.0, 1.0);
#ifdef MANTLE_POINTS_GRADIENT
    // mantle.frag: the gradient ramp times the row's paint, sampled only where the fill covers something (derivatives: the pixel's em steps)
    int fillGradId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).x + 0.5);
    if (fillGradId > 0 && cov != 0.0) fill = sampleGradient(fillGradId, em, bb, Ji[0], Ji[1]) * fill;
#endif
    vColor = vec4(fill.rgb * fill.a, fill.a) * cov;
#ifdef MANTLE_POINTS_PATTERN
    vec4 vAtlasSlot = texelFetch(uMetaTex, metaAt(MT_ATLAS, s), 0);
    if (abs(vAtlasSlot.w - 2.0) < 0.5 && cov > 0.0) vColor = patternPaint(s, em, ePx, invPx, Ji[0], Ji[1], vAtlasSlot) * cov * vec4(fill.rgb * fill.a, fill.a);
#endif
  } else {
#ifdef MANTLE_POINTS_STROKE
    vColor = strokeColorAt(s, em, ePx, GD, bb, Ji[0], Ji[1]);
#else
    vColor = vec4(0.0);
#endif
  }
#ifdef MANTLE_POINTS_MASK
  // mantle.frag multiplies the mask after the clip, on the finished color
  vColor *= maskFactor(s, em, ePx, invPx, Ji[0], Ji[1]);
#endif
#ifdef MANTLE_POINTS_CLIP
  // mantle.frag: `color *= evalClipCoverage(emCoord, invPx, clipId - 1)` on the finished color (fill over stroke, premultiplied)
  int clipId = int(texelFetch(uMetaTex, metaAt(MT_PAINT_ID, s), 0).z + 0.5);
  if (clipId > 0) vColor *= evalClipCoverage(em, invPx, clipId - 1);
#endif
  gl_Position = vec4(pc / uViewportSize * 2.0 - 1.0, 0.0, 1.0);
}
