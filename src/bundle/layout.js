// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
//   t5: (solidStart, solidCount, cgeomOff, cgeomLen)        — solid section dead in v3; a vector-pattern
//       carrier's inverse linear; on a stroke row with FS_STROKE_LOCAL, the stroke frame N (column-major
//       n00, n10, n01, n11 — bundle/strokeFrame.js)
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
export const META_BBOX_XMIN = 0;
export const META_BBOX_YMIN = 1;
export const META_BBOX_XMAX = 2;
export const META_BBOX_YMAX = 3;
export const META_FILL_R = 4;
export const META_FILL_G = 5;
export const META_FILL_B = 6;
export const META_FILL_A = 7;
export const META_STROKE_R = 8;
export const META_STROKE_G = 9;
export const META_STROKE_B = 10;
export const META_STROKE_A = 11;
export const META_STROKE_W = 12;
export const META_FILL_RULE = 13;
export const META_ACCUM_GROUP = 14;
export const META_DASH_ID = 15;
export const META_GLYPH_LOC_X = 16;
export const META_GLYPH_LOC_Y = 17;
export const META_BAND_MAX_X = 18;
export const META_BAND_MAX_Y = 19;
export const META_SOLID_START = 20;
export const META_SOLID_COUNT = 21;
export const META_CGEOM_OFF = 22;
export const META_CGEOM_LEN = 23;
export const META_CAP_STYLE = 24;
export const META_JOIN_STYLE = 25;
export const META_MITER_LIMIT = 26;
export const META_FLAGS_SHAPE = 27;
export const META_FILL_GRAD = 28;
export const META_STROKE_GRAD = 29;
export const META_CLIP_ID = 30;
export const META_MASK_ID = 31;
export const META_FILTER_ID = 32;
export const META_BLEND_MODE = 33;
export const META_ISOLATION = 34;
export const META_IMAGE_ID = 35;
export const META_IMAGE_RECT_X = 36;
export const META_IMAGE_RECT_Y = 37;
export const META_IMAGE_RECT_W = 38;
export const META_IMAGE_RECT_H = 39;
export const META_ATLAS_Y = 40;
export const META_ATLAS_W = 41;
export const META_ATLAS_H = 42;
export const META_ATLAS_IS_PATTERN = 43;
export const META_PRIM_KIND = 44; // simple-shape fast-path selector (0=none, 1=circle, 2=rect, 3=roundRect)
export const META_COLR_GRAPH = 45;
export const META_END_CAP_OR_RX = 46;
export const META_STROKE_IMAGE_ID = 47;

// FlagsShape bits packed into texel 6.w (META_FLAGS_SHAPE).
// Lower bits = stroke-specific; bits 6/7 = group transitions;
// bit 8 = layer (FLAG_LAYER); bit 9 = COLR mask-only; bits 10..12 =
// vector-effect sub-flags applied by the vertex shader.
export const FS_NON_SCALING_STROKE = 1 << 0;
export const FS_HAS_DASH = 1 << 1;
// A stroke row drawn in STROKE SPACE (its CTM was not conformal): texel 5 holds the frame N that maps the row's
// document-space segments into it, and the row's width, dashes, startDists and arcs-join curvatures are in its units
// (bundle/strokeFrame.js).
export const FS_STROKE_LOCAL = 1 << 2;
// A DASHED stroke row with a CLOSED contour: the first and the last segment of each carry the contour's arc length L as -L in their
// free-start / free-end header field (svg/textures.js encodeSeg), so the shader can tell whether the dash on at the contour's end continues into the
// one on at its start. A reader that tests those fields `> 0.5` for "free" reads them joined, as before; this bit says the row has them.
export const FS_DASH_SEAM = 1 << 3;
export const FS_GROUP_BEGIN = 1 << 6;
export const FS_GROUP_END = 1 << 7;
export const FS_LAYER = 1 << 8;
export const FS_COLR_MASK_ONLY = 1 << 9;
export const FS_NON_SCALING_SIZE = 1 << 10;
export const FS_NON_ROTATION = 1 << 11;
export const FS_FIXED_POSITION = 1 << 12;
// A fill or stroke row kept at alpha 0 (importSvg keepInvisibleShapes, on by default): the static draw list leaves it out (it costs the draw nothing);
// a morph that raises its alpha draws it, and an override that gives it ink brings it into the list (renderer/bundle.js syncKeptRows). Bit 18 (17 is the hueless-color bit of the morph color work).
// Transparent fill colors borrow the visible endpoint hue during morphing. Fill opacity remains independent.
export const FS_FILL_HUELESS = 1 << 17;
export const FS_KEPT_INVISIBLE = 1 << 18;
// A row kept hidden (importSvg keepHidden): the element is `display:none` (or inside one), or its computed `visibility` is `hidden` / `collapse`.
// It keeps its authored paint but draws nothing, hits nothing and is left out of the fit, the occlusion cull and the silhouette, until an override
// reveals it (`reveal: true`, renderer/bundle.js buildDrawList). A morph treats such a row as one at alpha 0 (core/morphCore.js).
// Bit 20 (17 and 19 are the fill and stroke hueless-color bits of the morph color work).
export const FS_HIDDEN = 1 << 20;
// Multi-shape mask region bracket bits.
export const FS_MASK_BEGIN = 1 << 9; // alias of COLR_MASK_ONLY — context decides
export const FS_MASK_END = 1 << 10; // alias of NON_SCALING_SIZE — context decides

// Meta section header bytes preceding the float plane.
//   u32 numShapes
//   f32[4] globalBBox (xmin, ymin, w, h)  -- in the bundle's own units: its coordinates minus the bundle origin (below)
//   u32 magic (META_MAGIC)   -- bytes 20..23; absent (zero) in a version-1 buffer
//   u32 version              -- bytes 24..27; absent (zero) = version 1
//   u32 originFlag           -- bytes 28..31; 0, or 1 in a version-3 header (the bundle has an origin)
// Version 2 is the header above with originFlag 0. Version 3 is the same header with originFlag 1: the bundle's coordinates
// (curve table, gradients, patterns, filter regions, bbox: everything the meta and the sections store) are RELATIVE to a
// per-bundle origin, a float64 pair that rides in `sections.origin` ([x, y], the document-space position of the bundle's
// (0, 0)), so a document coordinate is `stored + origin`. The importer subtracts it in float64 before the float32 store
// (svg/importer.js), which is what keeps art far from the document origin exact (a float32 at 1e7 has a 1.0 spacing).
// A bundle at the origin writes version 2, byte for byte as before.
export const META_HEADER_BYTES = 32;
export const META_MAGIC = 0x4c544e4d; // the bytes 'M' 'N' 'T' 'L'
export const META_VERSION = 3; // the newest version this build reads; 1 = the untagged header
export const META_VERSION_PLAIN = 2; // what a bundle with no feature flags is stamped with
export const META_VERSION_MAX = META_VERSION;
export const META_VERSION_HIDDEN = META_VERSION;
// Version 3 makes bytes 28..31 a feature-flag word; a reader that predates a flag refuses the buffer by name (renderer/sectionsCheck.js).
export const META_FLAG_ORIGIN = 1; // the bundle's coordinates are relative to sections.origin
export const META_FLAG_HIDDEN = 2; // rows kept hidden (FS_HIDDEN, importSvg keepHidden): an older reader would draw them
export const META_FLAGS_KNOWN = META_FLAG_ORIGIN | META_FLAG_HIDDEN;
/** Tag a meta header (a DataView over a buffer of at least META_HEADER_BYTES) with the magic and the version: 2, or 3 with a flag word when
 *  `origin` ([x, y]) is nonzero (the coordinates are relative to it; `sections.origin` carries the pair) and/or `hidden` rows are kept. */
export function stampMetaHeader(dv, origin, hidden) {
  const flags =
    (origin && (origin[0] !== 0 || origin[1] !== 0) ? META_FLAG_ORIGIN : 0) |
    (hidden ? META_FLAG_HIDDEN : 0);
  dv.setUint32(20, META_MAGIC, true);
  dv.setUint32(24, flags ? META_VERSION : META_VERSION_PLAIN, true);
  if (flags) dv.setUint32(28, flags, true);
}
/** The origin of a sections dict as a [x, y] pair of finite numbers; [0, 0] when absent or not usable. */
export function sectionsOrigin(sections) {
  const o = sections && sections.origin;
  return o && Number.isFinite(o[0]) && Number.isFinite(o[1]) ? [+o[0], +o[1]] : [0, 0];
}

// ──────────────────────────────────────────────────────────────────
// Gradient float table layout (16 floats = 4 texels per gradient).
//   t0: (type, spread, units, fyFrac)   — type 0=linear, 1=radial; spread 0=pad/1=reflect/2=repeat
//   t1: inverse 3×2 affine (ia, ib, ic, id)
//   t2: inverse 3×2 affine (ie, if, stopsOffset, stopsCount)
//   t3: linear: (x1, y1, x2, y2) | radial: (cx, cy, r, fxFrac)
// ──────────────────────────────────────────────────────────────────
export const GRAD_FLOATS_PER_GRADIENT = 16;
export const GRAD_TYPE = 0;
export const GRAD_SPREAD = 1;
export const GRAD_UNITS = 2;
export const GRAD_STOPS_OFF = 10;
export const GRAD_STOPS_CNT = 11;

// Gradient type codes (slot 0).
export const GRAD_TYPE_LINEAR = 0;
export const GRAD_TYPE_RADIAL = 1;
export const GRAD_TYPE_SWEEP = 2; // COLRv1 only — SVG has no sweep

// ──────────────────────────────────────────────────────────────────
// Gradient STOP LUT (the `gradientStops` section, RGBA8). A gradient's
// slice starts at texel stopsOffset (slot 10) and holds |stopsCount|
// (slot 11) stops in one of two layouts:
//   stopsCount < 0  ONE texel per stop, (r, g, b, offset): all-opaque
//                   gradients of at most GRAD_STOPS_ONE_TEXEL_MAX stops.
//   stopsCount > 0  TWO texels per stop: straight (r, g, b, a), then
//                   (offHi, offMid, offLo, 0). The offset is
//                   offHi/255 + offMid/255^2 + offLo/255^3 in [0, 1].
//                   A gradient of at most GRAD_STOPS_ONE_TEXEL_MAX stops
//                   writes offHi = round(offset * 255) and leaves the other
//                   two 0 (the 8-bit offset); a longer one uses all three.
// LUT texel i lives at (i % GRAD_STOPS_LUT_W, floor(i / GRAD_STOPS_LUT_W)):
// a LUT of at most GRAD_STOPS_LUT_W texels is one row of exactly its
// length, a longer one wraps onto full rows (the last one zero-padded).
// ──────────────────────────────────────────────────────────────────
export const GRAD_STOPS_LUT_W = 2048; // a power of two; the shader masks and shifts by it
export const GRAD_STOPS_MAX = 65536; // per gradient, sentinels included: 16 search probes
export const GRAD_STOPS_ONE_TEXEL_MAX = 256; // beyond this a stop needs more than an 8-bit offset

/// [width, height] of the stop LUT texture for `texels` texels.
export function gradientStopsLutSize(texels) {
  const n = Math.max(1, texels | 0);
  return n <= GRAD_STOPS_LUT_W ? [n, 1] : [GRAD_STOPS_LUT_W, Math.ceil(n / GRAD_STOPS_LUT_W)];
}

/// `bytes` (RGBA8, 4 per texel) as the full texture gradientStopsLutSize
/// describes: the same array when it already fills it, else a zero-padded copy.
export function padGradientStopsLut(bytes) {
  const [w, h] = gradientStopsLutSize(bytes.length >>> 2);
  if (bytes.length === w * h * 4) return bytes;
  const out = new Uint8Array(w * h * 4);
  out.set(bytes);
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Filter float table (24 floats = 6 texels per filter).
//   t0..t3: color matrix (4×5 — 4 rows of 5 floats; matrix when kind ≤ 1)
//   t4: offsets (only when kind ≤ 1)
//   t5: (kind, sigmaX, sigmaY, _)
//     kind values: 0=color matrix, 1=blur, 2=drop shadow, 3=glow,
//                  4=bevel, 5=morphology, 6=convolve matrix,
//                  7=blur in linearRGB (identity matrix)
//   For kind ≥ 2, t0..t4 are repurposed (see svg/filter.js comments).
// ──────────────────────────────────────────────────────────────────
export const FILT_FLOATS_PER_FILTER = 24;
export const FILT_KIND = 20;
export const FILT_SIGMA_X = 21;
export const FILT_SIGMA_Y = 22;

export const FILT_KIND_COLOR_MATRIX = 0;
export const FILT_KIND_BLUR = 1;
// kinds 2/3/4 (drop-shadow / glow / bevel) run as composable fe-graphs,
// so those single-kind codes are not emitted. The numeric gap is
// intentional (5/6 keep their values for morphology/convolve).
export const FILT_KIND_MORPHOLOGY = 5;
export const FILT_KIND_CONVOLVE = 6;
// A lone Gaussian blur of SourceGraphic in linearRGB (the color-interpolation-filters default): the kind-1 blur on linear light. The color matrix
// texels are the identity, so nothing reads them; the renderer converts on the first pass and the last pass hands the result back as sRGB (filterDraw.js blurShapeFbo).
export const FILT_KIND_BLUR_LINEAR = 7;

// ──────────────────────────────────────────────────────────────────
// Curve / band texture geometry.
// ──────────────────────────────────────────────────────────────────
export const TEX_W = 4096; // row width for curve + band planes
export const COVER_QUAD_STRIDE = 12; // floats per cover-quad vertex (chunk header + verts)

// Bundle.flags bits.
export const BUNDLE_FLAG_HYBRID_MESH_CHUNKED = 2;

// blendMode codes (texel 8.y). Compositing & Blending Level 1 (0..15)
// + Level 2 / Flash AS3 extras (16..18).
export const BLEND_NORMAL = 0;
export const BLEND_MULTIPLY = 1;
export const BLEND_SCREEN = 2;
export const BLEND_OVERLAY = 3;
export const BLEND_DARKEN = 4;
export const BLEND_LIGHTEN = 5;
export const BLEND_COLOR_DODGE = 6;
export const BLEND_COLOR_BURN = 7;
export const BLEND_HARD_LIGHT = 8;
export const BLEND_SOFT_LIGHT = 9;
export const BLEND_DIFFERENCE = 10;
export const BLEND_EXCLUSION = 11;
export const BLEND_HUE = 12;
export const BLEND_SATURATION = 13;
export const BLEND_COLOR = 14;
export const BLEND_LUMINOSITY = 15;
export const BLEND_PLUS_LIGHTER = 16; // CSS Compositing 2 + Flash AS3 'add'
export const BLEND_PLUS_DARKER = 17; // Flash AS3 'subtract'
export const BLEND_INVERT = 18;

// Exact layer-row groups for every placed instance of a named clip or mask.
// Legacy bundles supply one inclusive range instead.
export function clipperRowGroups(bundle, id) {
  const groups =
    bundle.clipperRowSets &&
    Object.prototype.hasOwnProperty.call(bundle.clipperRowSets, id) &&
    bundle.clipperRowSets[id];
  if (groups) return groups;
  const range =
    bundle.clipperRows &&
    Object.prototype.hasOwnProperty.call(bundle.clipperRows, id) &&
    bundle.clipperRows[id];
  if (!range) return null;
  const rows = [];
  for (let row = range[0]; row <= range[1]; row++) rows.push(row);
  return [rows];
}
