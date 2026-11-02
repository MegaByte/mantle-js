// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _clipWalk.glsl — a <clipPath>'s coverage at a point, shared by mantle.frag (a drawn shape's clip, a mask child's clip
// in the inline mask walk) and maskBake.frag (a mask child's own clip-path), so the three cannot diverge.
// Needs uMetaTex and the MT_* layout (@@BUNDLE_LAYOUT@@), renderFill (@@COVERAGE@@) and transformClipCoord
// (@@OVERRIDE_TRANSFORM@@) before it.
//
// A clip is a union of its children (SVG 1.1 §14.3.5): one row, or rows bracketed by FLAG_CLIP_BEGIN (1<<11) and
// FLAG_CLIP_END (1<<12). THE UNION IS WALKED TO ITS END: a fixed child limit would drop every child past it from
// the union. Its bound is the meta table itself, which a union cannot run past; it ends at FLAG_CLIP_END, or once
// saturated.

// The union's RAW coverage: each child's geometry, no nested clip. This helper does not recurse (GLSL has no
// recursion); evalClipCoverage below adds the one level of nesting a clip child's own clip-path takes.
float evalClipCoverageAtRow(vec2 emCoord, vec2 px, int firstRow) {
  // One loop for the single-row and the multi-row clip: a single-row clip is the loop's first pass with no
  // FLAG_LAYER test and an unconditional break, its coverage clamp(max(0, c), 0, 1) = c.
  float acc = 0.0;
  bool multiClip = false;
  int rows = metaRowsOf(textureSize(uMetaTex, 0));
  for (int k = 0; firstRow + k < rows; k++) {
    int cRow = firstRow + k;
    vec4 ccap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
    int cflags = int(ccap.w + 0.5);
    if (k == 0) multiClip = (cflags & 2048) != 0;  // FLAG_CLIP_BEGIN = 1<<11
    if (multiClip && (cflags & 256) == 0) break;  // FLAG_LAYER cleared
    vec4 cBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
    bool cEvenOdd = cStrokePad.y > 0.5;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    vec2 localCoord = transformClipCoord(emCoord, cRow);
    float c = renderFill(localCoord, transformClipPx(px, cRow), cGD, cEvenOdd, cBB);
    acc = max(acc, c);
    // A single-row clip is its one row. A union ends at FLAG_CLIP_END, or once saturated: every child's coverage is in
    // [0, 1], so max() cannot move past 1.
    if (!multiClip || acc >= 1.0 || (cflags & 4096) != 0) break;
  }
  return clamp(acc, 0.0, 1.0);
}

// The clip's coverage with each child cut by the child's own clip-path (meta texel 7.z, the rewritten meta row of that
// clip's first row): depth 1, a clip's clip's clip is flattened to the outer two levels.
float evalClipCoverage(vec2 emCoord, vec2 px, int firstRow) {
  float acc = 0.0;
  bool multiClip = false;
  int rows = metaRowsOf(textureSize(uMetaTex, 0));
  for (int k = 0; firstRow + k < rows; k++) {
    int cRow = firstRow + k;
    vec4 ccap = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, cRow), 0);
    int cflags = int(ccap.w + 0.5);
    if (k == 0) multiClip = (cflags & 2048) != 0;  // FLAG_CLIP_BEGIN = 1<<11
    if (multiClip && (cflags & 256) == 0) break;  // FLAG_LAYER cleared
    vec4 cBB    = texelFetch(uMetaTex, metaAt(MT_BBOX, cRow), 0);
    vec4 cGlyph = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, cRow), 0);
    vec4 cStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, cRow), 0);
    bool cEvenOdd = cStrokePad.y > 0.5;
    ivec4 cGD = ivec4(int(cGlyph.x), int(cGlyph.y),
                      int(cGlyph.z), int(cGlyph.w));
    vec2 localCoord = transformClipCoord(emCoord, cRow);
    float c = renderFill(localCoord, transformClipPx(px, cRow), cGD, cEvenOdd, cBB);
    // Only when the child can raise the union: the nested coverage is in [0, 1], so c * nested <= c, and a
    // child with c <= acc leaves max(acc, .) at acc whatever it is. On the first pass acc is 0, so this is also the
    // single-row clip's "only a nonzero coverage".
    if (c > acc) {
      vec4 cMeta7 = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, cRow), 0);
      int innerClipId = int(cMeta7.z + 0.5);
      if (innerClipId > 0) c *= evalClipCoverageAtRow(emCoord, px, innerClipId - 1);
    }
    acc = max(acc, c);
    if (!multiClip || acc >= 1.0 || (cflags & 4096) != 0) break;
  }
  return clamp(acc, 0.0, 1.0);
}
