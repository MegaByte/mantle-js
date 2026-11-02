// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _bundleLayout.glsl — named texel indices for the bundle's per-shape meta
// record, so shader reads are self-documenting instead of raw `ivec2(N, row)`
// literals. Values are the bundle wire contract and MUST match
// src/bundle/layout.js (the JS encoder). Spliced via the @@BUNDLE_LAYOUT@@ marker.

// Per-shape meta record: 12 RGBA texels (column = texel index, row = shape).
const int MT_BBOX         = 0;   // bbox        (xmin, ymin, xmax, ymax)
const int MT_FILL         = 1;   // fillColor   (r, g, b, a)
const int MT_STROKE       = 2;   // strokeColor (r, g, b, a)
const int MT_STROKE_PARAMS = 3;  // (strokeWidth, fillRuleEvenOdd, accumGroup, dashId)
const int MT_GLYPH_BAND   = 4;   // (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY)
const int MT_SOLID        = 5;   // (solidStart, solidCount, cgeomOff, cgeomLen) | patternInvLinear | occupancy
                                 // | a stroke row's frame N under FS_STROKE_LOCAL
const int MT_CAP_JOIN     = 6;   // (capStyle, joinStyle, miterLimit, flagsShape)
const int MT_PAINT_ID     = 7;   // (fillGradId, strokeGradId, clipId, maskId)
const int MT_FILTER_BLEND = 8;   // (filterId, blendMode, isolation, imageId)
const int MT_IMAGE_RECT   = 9;   // imageRect   (ix, iy, iw, ih)
const int MT_ATLAS        = 10;  // atlasSlot   (yOffPx, w, h, isPattern)
const int MT_PRIM         = 11;  // (primKind, colrGraphId, endCap/rx, strokeImageId)
// flagsShape bit (MT_CAP_JOIN.w): a stroke row drawn in stroke space, its frame N in MT_SOLID (bundle/strokeFrame.js).
const int FS_STROKE_LOCAL = 4;

// Filter color-matrix record: 6 RGBA texels per filter row (JS in-shader path).
const int FT_R0   = 0;   // color-matrix output rows 0..3 (dot input rgba)
const int FT_R1   = 1;
const int FT_R2   = 2;
const int FT_R3   = 3;
const int FT_OFF  = 4;   // offset column
const int FT_META = 5;   // (kind, ...)

// Gradient param record: 4 RGBA texels per gradient row.
const int GR_G0 = 0;  const int GR_G1 = 1;  const int GR_G2 = 2;  const int GR_G3 = 3;
// Override (per-shape animation) record: 6 texels per shape.
const int OV_AFFINE   = 0;  // m00,m01,m10,m11
const int OV_POS_VIS  = 1;  // tx,ty,vis,mask
const int OV_TINT     = 2;
const int OV_FILL     = 3;
const int OV_STROKE   = 4;
const int OV_STROKE_W = 5;
// Dash pattern row: header texel = (cycleLen, count, offset, _).
const int DASH_HDR = 0;
// Mask row -> layer index table.
const int MRL_ROW = 0;

// PER-ITEM TABLES WRAP IN 4096-ROW BANDS (renderer/tableLayout.js). Row r of a table of `cols` texels per row sits at
// (c + cols * (r >> 12), r & 4095): a table of up to 4096 rows is exactly the plain `cols x N` texture, a taller one continues in
// a strip to its right, so no table outgrows MAX_TEXTURE_SIZE in height. All six use these; never write a raw ivec2(c, row).
ivec2 metaAt(int c, int r)   { return ivec2(c + 12 * (r >> 12), r & 4095); }   // meta: 12 texels per shape
ivec2 gradAt(int c, int r)   { return ivec2(c + 4 * (r >> 12), r & 4095); }    // gradient params: 4
ivec2 dashAt(int c, int r)   { return ivec2(c + 16 * (r >> 12), r & 4095); }   // dash pattern: 16
ivec2 filterAt(int c, int r) { return ivec2(c + 6 * (r >> 12), r & 4095); }    // filter record: 6
ivec2 ovAt(int c, int r)     { return ivec2(c + 6 * (r >> 12), r & 4095); }    // override record: 6
ivec2 mrlAt(int c, int r)    { return ivec2(c + 2 * (r >> 12), r & 4095); }    // mask row -> layer: 2 (1-wide when <= 4096 rows)
// Rows the meta texture can hold (>= numShapes; the pad rows read zero). Loop bound for the mask / clip / pattern walks.
int metaRowsOf(ivec2 sz) { return sz.y * (sz.x / 12); }

// Width flags use the row's document-space pixel footprint. Dash scaling
// remains controlled by the separate SVG non-scaling-stroke flag.
float strokeWidthMultiplier(int flags, vec2 footprint) {
  bool h = (flags & (1 << 13)) != 0, v = (flags & (1 << 14)) != 0;
  if (h && !v) return footprint.x;
  if (v && !h) return footprint.y;
  return (flags & (1 | (1 << 13) | (1 << 14))) != 0 ? 0.5 * (footprint.x + footprint.y) : 1.0;
}
