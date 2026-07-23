// bundle/layout.js — authoritative bundle texel layout constants.
//
// Single source of truth for the per-shape meta record layout, the
// gradient float table, the filter float table, and the flagsShape
// bits. Imported by:
//   - featureSet.js (bundle introspection)
//   - svg/meta.js   (importer-side meta packer; the canonical writer)
//
// Bit positions and texel offsets are part of the bundle wire
// contract. Reorder only by
// appending new slots at the end of reserved space; never renumber
// existing ones.
//
// ──────────────────────────────────────────────────────────────────
// Meta record (48 floats = 12 texels per shape).
// ──────────────────────────────────────────────────────────────────
//   t0: bbox (xmin, ymin, xmax, ymax)
//   t1: fillColor (r, g, b, a)
//   t2: strokeColor (r, g, b, a)
//   t3: (strokeWidth, fillRuleEvenOdd, accumGroupId, dashId)
//   t4: (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY)
//   t5: (solidStart, solidCount, cgeomOff, cgeomLen)        — solid section dead in v3
//   t6: (capStyle, joinStyle, miterLimit, flagsShape)
//   t7: (fillGradId, strokeGradId, clipId, maskId)
//   t8: (filterId, blendMode, isolation, imageId)
//   t9: imageRect (ix, iy, iw, ih)                          — origin + size
//  t10: atlasSlot (yOffPx, w, h, isPattern)                 — w==2 sentinel: vector pattern
//  t11: (primKind, colrGraphId, endCap/rx, strokeImageId)    — primKind: simple-shape
//       fast-path selector (0 = none, 1 = circle, 2 = rect, 3 = roundRect); see
//       hitTest/fillCoverage.js

export const META_FLOATS_PER_SHAPE = 48;
export const META_TEXELS_PER_SHAPE = 12;

// Per-float offsets within a meta row. Add the row's base (i × 48).
export const META_BBOX_XMIN     =  0;
export const META_BBOX_YMIN     =  1;
export const META_BBOX_XMAX     =  2;
export const META_BBOX_YMAX     =  3;
export const META_FILL_R        =  4;
export const META_FILL_G        =  5;
export const META_FILL_B        =  6;
export const META_FILL_A        =  7;
export const META_STROKE_R      =  8;
export const META_STROKE_G      =  9;
export const META_STROKE_B      = 10;
export const META_STROKE_A      = 11;
export const META_STROKE_W      = 12;
export const META_FILL_RULE     = 13;
export const META_ACCUM_GROUP   = 14;
export const META_DASH_ID       = 15;
export const META_GLYPH_LOC_X   = 16;
export const META_GLYPH_LOC_Y   = 17;
export const META_BAND_MAX_X    = 18;
export const META_BAND_MAX_Y    = 19;
export const META_SOLID_START   = 20;
export const META_SOLID_COUNT   = 21;
export const META_CGEOM_OFF     = 22;
export const META_CGEOM_LEN     = 23;
export const META_CAP_STYLE     = 24;
export const META_JOIN_STYLE    = 25;
export const META_MITER_LIMIT   = 26;
export const META_FLAGS_SHAPE   = 27;
export const META_FILL_GRAD     = 28;
export const META_STROKE_GRAD   = 29;
export const META_CLIP_ID       = 30;
export const META_MASK_ID       = 31;
export const META_FILTER_ID     = 32;
export const META_BLEND_MODE    = 33;
export const META_ISOLATION     = 34;
export const META_IMAGE_ID      = 35;
export const META_IMAGE_RECT_X  = 36;
export const META_IMAGE_RECT_Y  = 37;
export const META_IMAGE_RECT_W  = 38;
export const META_IMAGE_RECT_H  = 39;
export const META_ATLAS_Y       = 40;
export const META_ATLAS_W       = 41;
export const META_ATLAS_H       = 42;
export const META_ATLAS_IS_PATTERN = 43;
export const META_PRIM_KIND     = 44;   // simple-shape fast-path selector (0=none, 1=circle, 2=rect, 3=roundRect)
export const META_COLR_GRAPH    = 45;
export const META_END_CAP_OR_RX  = 46;
export const META_STROKE_IMAGE_ID = 47;

// FlagsShape bits packed into texel 6.w (META_FLAGS_SHAPE).
// Lower bits = stroke-specific; bits 6/7 = group transitions;
// bit 8 = layer (FLAG_LAYER); bit 9 = COLR mask-only; bits 10..12 =
// vector-effect sub-flags applied by the vertex shader.
export const FS_NON_SCALING_STROKE = 1 <<  0;
export const FS_HAS_DASH           = 1 <<  1;
export const FS_GROUP_BEGIN        = 1 <<  6;
export const FS_GROUP_END          = 1 <<  7;
export const FS_LAYER              = 1 <<  8;
export const FS_COLR_MASK_ONLY     = 1 <<  9;
export const FS_NON_SCALING_SIZE   = 1 << 10;
export const FS_NON_ROTATION       = 1 << 11;
export const FS_FIXED_POSITION     = 1 << 12;
// Multi-shape mask region bracket bits.
export const FS_MASK_BEGIN         = 1 <<  9;  // alias of COLR_MASK_ONLY — context decides
export const FS_MASK_END           = 1 << 10;  // alias of NON_SCALING_SIZE — context decides

// Meta section header bytes preceding the float plane.
//   u32 numShapes
//   f32[4] globalBBox (xmin, ymin, w, h)
//   pad to 32 bytes
export const META_HEADER_BYTES = 32;

// ──────────────────────────────────────────────────────────────────
// Gradient float table layout (16 floats = 4 texels per gradient).
//   t0: (type, spread, units, fyFrac)   — type 0=linear, 1=radial; spread 0=pad/1=reflect/2=repeat
//   t1: inverse 3×2 affine (ia, ib, ic, id)
//   t2: inverse 3×2 affine (ie, if, stopsOffset, stopsCount)
//   t3: linear: (x1, y1, x2, y2) | radial: (cx, cy, r, fxFrac)
// ──────────────────────────────────────────────────────────────────
export const GRAD_FLOATS_PER_GRADIENT = 16;
export const GRAD_TYPE      =  0;
export const GRAD_SPREAD    =  1;
export const GRAD_UNITS     =  2;
export const GRAD_STOPS_OFF = 10;
export const GRAD_STOPS_CNT = 11;

// Gradient type codes (slot 0).
export const GRAD_TYPE_LINEAR = 0;
export const GRAD_TYPE_RADIAL = 1;
export const GRAD_TYPE_SWEEP  = 2;   // COLRv1 only — SVG has no sweep

// ──────────────────────────────────────────────────────────────────
// Filter float table (24 floats = 6 texels per filter).
//   t0..t3: color matrix (4×5 — 4 rows of 5 floats; matrix when kind ≤ 1)
//   t4: offsets (only when kind ≤ 1)
//   t5: (kind, sigmaX, sigmaY, _)
//     kind values: 0=color matrix, 1=blur, 2=drop shadow, 3=glow,
//                  4=bevel, 5=morphology, 6=convolve matrix
//   For kind ≥ 2, t0..t4 are repurposed (see svg/filter.js comments).
// ──────────────────────────────────────────────────────────────────
export const FILT_FLOATS_PER_FILTER = 24;
export const FILT_KIND      = 20;
export const FILT_SIGMA_X   = 21;
export const FILT_SIGMA_Y   = 22;

export const FILT_KIND_COLOR_MATRIX = 0;
export const FILT_KIND_BLUR         = 1;
// kinds 2/3/4 (drop-shadow / glow / bevel) run as composable fe-graphs,
// so those single-kind codes are not emitted. The numeric gap is
// intentional (5/6 keep their values for morphology/convolve).
export const FILT_KIND_MORPHOLOGY   = 5;
export const FILT_KIND_CONVOLVE     = 6;

// ──────────────────────────────────────────────────────────────────
// Curve / band texture geometry.
// ──────────────────────────────────────────────────────────────────
export const TEX_W = 4096;             // row width for curve + band planes
export const COVER_QUAD_STRIDE = 12;       // floats per cover-quad vertex (chunk header + verts)

// Bundle.flags bits.
export const BUNDLE_FLAG_HYBRID_MESH_CHUNKED = 2;

// blendMode codes (texel 8.y). Compositing & Blending Level 1 (0..15)
// + Level 2 / Flash AS3 extras (16..18).
export const BLEND_NORMAL      =  0;
export const BLEND_MULTIPLY    =  1;
export const BLEND_SCREEN      =  2;
export const BLEND_OVERLAY     =  3;
export const BLEND_DARKEN      =  4;
export const BLEND_LIGHTEN     =  5;
export const BLEND_COLOR_DODGE =  6;
export const BLEND_COLOR_BURN  =  7;
export const BLEND_HARD_LIGHT  =  8;
export const BLEND_SOFT_LIGHT  =  9;
export const BLEND_DIFFERENCE  = 10;
export const BLEND_EXCLUSION   = 11;
export const BLEND_HUE         = 12;
export const BLEND_SATURATION  = 13;
export const BLEND_COLOR       = 14;
export const BLEND_LUMINOSITY  = 15;
export const BLEND_PLUS_LIGHTER = 16;   // CSS Compositing 2 + Flash AS3 'add'
export const BLEND_PLUS_DARKER  = 17;   // Flash AS3 'subtract'
export const BLEND_INVERT       = 18;
