// _bundleLayout.glsl — named texel indices for the bundle's per-shape meta
// record, so shader reads are self-documenting instead of raw `ivec2(N, row)`
// literals. Values are the bundle wire contract and MUST match
// src/bundle/layout.js (JS encoder), MantleBundleLayout.cs (C# encoder), and
// MantleBundleLayout.hlsl (C# shader). Spliced via the @@BUNDLE_LAYOUT@@ marker.

// Per-shape meta record: 12 RGBA texels (column = texel index, row = shape).
const int MT_BBOX         = 0;   // bbox        (xmin, ymin, xmax, ymax)
const int MT_FILL         = 1;   // fillColor   (r, g, b, a)
const int MT_STROKE       = 2;   // strokeColor (r, g, b, a)
const int MT_STROKE_PARAMS = 3;  // (strokeWidth, fillRuleEvenOdd, accumGroup, dashId)
const int MT_GLYPH_BAND   = 4;   // (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY)
const int MT_SOLID        = 5;   // (solidStart, solidCount, cgeomOff, cgeomLen) | patternInvLinear | occupancy
const int MT_CAP_JOIN     = 6;   // (capStyle, joinStyle, miterLimit, flagsShape)
const int MT_PAINT_ID     = 7;   // (fillGradId, strokeGradId, clipId, maskId)
const int MT_FILTER_BLEND = 8;   // (filterId, blendMode, isolation, imageId)
const int MT_IMAGE_RECT   = 9;   // imageRect   (ix, iy, iw, ih)
const int MT_ATLAS        = 10;  // atlasSlot   (yOffPx, w, h, isPattern)
const int MT_PRIM         = 11;  // (primKind, colrGraphId, endCap/rx, strokeImageId)

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
