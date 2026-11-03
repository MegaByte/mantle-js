// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/meta.js — per-shape meta-record packer (Float32 → Uint8 buffer).
//
// The meta plane is the bundle's shape-attribute table: one v3 record
// (META_FLOATS_V3 = 48 floats = 12 RGBA texels) per shape. The
// renderer's fill shader reads it by shape index to learn fill / stroke
// / gradient / clip / mask / filter / blend / image / colrGraph state
// for each fragment.
//
// Texel layout (kept in lock-step with bundle.js's parseMetaBin):
//   0  bbox                          (xmin, ymin, xmax, ymax)
//   1  fillColor                     (r, g, b, a)
//   2  strokeColor                   (r, g, b, a)
//   3  (sw, fillRuleEvenOdd, accum, dashId)
//   4  (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY)
//   5  (solidStart, solidCount, cgeomOff, cgeomLen) | a pattern carrier's L^-1 | a stroke row's frame N
//   6  (cap, join, miter, flagsShape)
//   7  (fillGradId, strokeGradId, clipId, maskId)
//   8  (filterId, blendMode, isolation, imageId)
//   9  imageRect                     (ix, iy, iw, ih)
//   10 atlasSlot                     (yOffsetPx, atlasWidthPx, atlasHeightPx, _pad)
//   11 (primKind, colrGraphId, endCap/rx, strokeImageId)

import { CAP_BUTT, JOIN_MITER } from './segment.js';
import {
  META_ACCUM_GROUP,
  META_ATLAS_H,
  META_ATLAS_IS_PATTERN,
  META_ATLAS_W,
  META_ATLAS_Y,
  META_BAND_MAX_X,
  META_BAND_MAX_Y,
  META_BBOX_XMAX,
  META_BBOX_XMIN,
  META_BBOX_YMAX,
  META_BBOX_YMIN,
  META_BLEND_MODE,
  META_CAP_STYLE,
  META_CGEOM_LEN,
  META_CGEOM_OFF,
  META_CLIP_ID,
  META_COLR_GRAPH,
  META_DASH_ID,
  META_END_CAP_OR_RX,
  META_FILL_A,
  META_FILL_B,
  META_FILL_G,
  META_FILL_GRAD,
  META_FILL_R,
  META_FILL_RULE,
  META_FILTER_ID,
  META_FLAGS_SHAPE,
  META_GLYPH_LOC_X,
  META_GLYPH_LOC_Y,
  META_IMAGE_ID,
  META_IMAGE_RECT_H,
  META_IMAGE_RECT_W,
  META_IMAGE_RECT_X,
  META_IMAGE_RECT_Y,
  META_ISOLATION,
  META_JOIN_STYLE,
  META_MASK_ID,
  META_MITER_LIMIT,
  META_PRIM_KIND,
  META_SOLID_COUNT,
  META_SOLID_START,
  META_STROKE_A,
  META_STROKE_B,
  META_STROKE_G,
  META_STROKE_GRAD,
  META_STROKE_IMAGE_ID,
  META_STROKE_R,
  META_STROKE_W,
} from '../bundle/layout.js';

export const META_FLOATS_V3 = 48;

export function packMetaBody(metas) {
  const n = metas.length;
  const out = new Float32Array(n * META_FLOATS_V3);
  for (let i = 0; i < n; i++) {
    const m = metas[i];
    const o = i * META_FLOATS_V3;
    // Texel 0: bbox
    out[o + META_BBOX_XMIN] = m.bbox[0];
    out[o + META_BBOX_YMIN] = m.bbox[1];
    out[o + META_BBOX_XMAX] = m.bbox[2];
    out[o + META_BBOX_YMAX] = m.bbox[3];
    // Texel 1: fillColor
    out[o + META_FILL_R] = m.fillColor[0];
    out[o + META_FILL_G] = m.fillColor[1];
    out[o + META_FILL_B] = m.fillColor[2];
    out[o + META_FILL_A] = m.fillColor[3];
    // Texel 2: strokeColor
    out[o + META_STROKE_R] = m.strokeColor[0];
    out[o + META_STROKE_G] = m.strokeColor[1];
    out[o + META_STROKE_B] = m.strokeColor[2];
    out[o + META_STROKE_A] = m.strokeColor[3];
    // Texel 3: (sw, fillRuleEvenOdd, accum, dashId)
    // dashId = 1-based row index into the dash pattern texture, 0 = no dashes.
    out[o + META_STROKE_W] = m.strokeWidth || 0;
    out[o + META_FILL_RULE] = m.fillRule === 'evenodd' ? 1 : 0;
    out[o + META_ACCUM_GROUP] = m.accumGroupId || 0;
    out[o + META_DASH_ID] = m.dashId || 0;
    // Texel 4: (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY)
    out[o + META_GLYPH_LOC_X] = m.glyphLoc[0] || 0;
    out[o + META_GLYPH_LOC_Y] = m.glyphLoc[1] || 0;
    out[o + META_BAND_MAX_X] = m.bandMaxX || 0;
    out[o + META_BAND_MAX_Y] = m.bandMaxY || 0;
    // Texel 5: (solidStart, solidCount, cgeomOff, cgeomLen) — OR, for a vector
    // pattern carrier (atlasSlot.w==2), the patternTransform inverse linear
    // matrix (column-major mat2). Those carriers never use solid/cgeom (both
    // hardcoded 0 in the importer's vector-pattern emit), so the slot is reused;
    // the shader reads it as L⁻¹ only inside the atlasSlot.w==2 branch.
    // A stroke row drawn in stroke space (flagsShape FS_STROKE_LOCAL) carries its frame N here instead, column-major
    // like L^-1 (bundle/strokeFrame.js). Stroke rows never hold an occupancy grid or solid data.
    if (m.patInvLinear) {
      out[o + META_SOLID_START] = m.patInvLinear[0];
      out[o + META_SOLID_COUNT] = m.patInvLinear[1];
      out[o + META_CGEOM_OFF] = m.patInvLinear[2];
      out[o + META_CGEOM_LEN] = m.patInvLinear[3];
    } else if (m.strokeFrame) {
      out[o + META_SOLID_START] = m.strokeFrame[0];
      out[o + META_SOLID_COUNT] = m.strokeFrame[1];
      out[o + META_CGEOM_OFF] = m.strokeFrame[2];
      out[o + META_CGEOM_LEN] = m.strokeFrame[3];
    } else {
      out[o + META_SOLID_START] = m._solid_float_start || 0;
      out[o + META_SOLID_COUNT] = m._solid_float_count || 0;
      out[o + META_CGEOM_OFF] = m._cgeom_byte_off || 0;
      out[o + META_CGEOM_LEN] = m._cgeom_byte_len || 0;
    }
    // Texel 6: (cap, join, miter, flags)
    out[o + META_CAP_STYLE] = m.capStyle ?? CAP_BUTT;
    out[o + META_JOIN_STYLE] = m.joinStyle ?? JOIN_MITER;
    out[o + META_MITER_LIMIT] = m.miterLimit ?? 4;
    out[o + META_FLAGS_SHAPE] = m.flagsShape || 0;
    // Texel 7: (fillGradId, strokeGradId, clipId, maskId)
    out[o + META_FILL_GRAD] = m.fillGradId || 0;
    out[o + META_STROKE_GRAD] = m.strokeGradId || 0;
    out[o + META_CLIP_ID] = m.clipId || 0;
    out[o + META_MASK_ID] = m.maskId || 0;
    // Texel 8: (filterId, blendMode, isolation, imageId)
    //   filterId = 1-based row in the filter table, 0 = unfiltered.
    //   blendMode = 0 normal / 1 multiply / 2 screen / 3 overlay /
    //               4 darken / 5 lighten / 6 color-dodge / 7 color-burn /
    //               8 hard-light / 9 soft-light / 10 difference /
    //               11 exclusion / 12 hue / 13 saturation / 14 color /
    //               15 luminosity / 16 add / 17 subtract / 18 invert /
    //               19 CSS plus-lighter / 20 alpha / 21 erase.
    //   isolation = 1 if isolation:isolate; 0 otherwise. Per CSS Compositing
    //               & Blending §6 isolation only has observable effect on
    //               groups (descendants composite among themselves before
    //               the group composites onto the parent), so it does not
    //               affect single-shape output.
    out[o + META_FILTER_ID] = m.filterId || 0;
    out[o + META_BLEND_MODE] = m.blendMode || 0;
    out[o + META_ISOLATION] = m.isolation || 0;
    out[o + META_IMAGE_ID] = m.imageId || 0;
    // Texel 9: imageRect (ix, iy, iw, ih) — em-space rect of the <image>
    // shape so the cover frag can map em-coord → [0,1]² uv.
    const ir = m.imageRect || [0, 0, 0, 0];
    out[o + META_IMAGE_RECT_X] = ir[0];
    out[o + META_IMAGE_RECT_Y] = ir[1];
    out[o + META_IMAGE_RECT_W] = ir[2];
    out[o + META_IMAGE_RECT_H] = ir[3];
    // Texel 10: atlas slot (yOffsetPx, atlasWidthPx, atlasHeightPx, _pad).
    // atlas is stacked vertically; per-image y is the running sum of
    // previous heights. Filled in by bundle assembly.
    const at = m.atlasSlot || [0, 0, 0, 0];
    out[o + META_ATLAS_Y] = at[0];
    out[o + META_ATLAS_W] = at[1];
    out[o + META_ATLAS_H] = at[2];
    out[o + META_ATLAS_IS_PATTERN] = at[3];
    // Texel 11: (primKind, colrGraphId, endCap/rx, strokeImageId).
    //   slot 0 (primKind)    = simple-shape fast-path selector:
    //                          0=general ray-cast, 1=circle, 2=rect,
    //                          3=roundRect. The shader computes closed-form
    //                          coverage (analytic SDF) for tagged shapes,
    //                          skipping the curve walk; it gates on
    //                          (near-)uniform scale and falls back to the
    //                          exact ray-cast otherwise.
    //   slot 1 (colrGraphId) = 1-based row index into bundle.colrGraphs.
    //                          Set by TextRun on COLRv1 color-glyph
    //                          shapes; renderer's COLR dispatch evaluates
    //                          graph N-1 with the coverage-rendered silhouette
    //                          as the PaintGlyph alpha mask. 0 = no graph;
    //                          shape renders via the regular coverage fill /
    //                          stroke path.
    //
    // Slots 2/3 have non-COLR meanings today; keep new COLR metadata
    // in newly appended slots after a bundle-version bump.
    out[o + META_PRIM_KIND] = m.primKind || 0; // simple-shape fast-path selector
    out[o + META_COLR_GRAPH] = m.colrGraphId || 0;
    // slot 46 (texel 11.z) = endCapStyle (+1 sentinel) on STROKE rows; reused
    // as the em-space corner radius on roundRect (primKind==3) FILL rows, which
    // have no cap. The shader reads it as rx only when primKind==3.
    //   endCapStyle: 0 → "same as startCap"; 1/2/3 → butt/round/square
    //   (asymmetric caps; SVG has no native syntax).
    out[o + META_END_CAP_OR_RX] =
      m.primKind === 3 ? m.primRx || 0 : m.endCapStyle != null ? m.endCapStyle + 1 : 0;
    // slot 47 (texel 11.w) = strokeImageId (1-based; 0 = no bitmap stroke).
    // Bitmap-fill stroke: the renderer's stroke-paint branch samples
    // imageAtlas using the same imageRect/atlasSlot the fill uses. SVG
    // has no native syntax. Independent stroke bitmaps (different
    // rect/slot from fill) require an extra meta texel and a
    // bundle-version bump.
    out[o + META_STROKE_IMAGE_ID] = m.strokeImageId || 0;
  }
  return new Uint8Array(out.buffer);
}
