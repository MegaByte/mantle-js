// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textSvgInOt.js — SVG-in-OT nested import for color glyphs: the text-side seam.
//
// The import itself needs the SVG importer, so it lives in font/color/svgInOtImport.js and registers into svgInOtHook.js.
// Text imports only this seam; a font with SVG glyphs and no registration warns once and the glyph falls to the next source.

import { getSvgInOtEmitter } from './svgInOtHook.js';
import { warnMissingFeature } from '../core/missingFeature.js';

// Cumulative non-geometry sections from the shared SVG importer. Images are
// packed after all SVG and bitmap glyphs have contributed to ctx.imagesUsed.
export const SVG_TEXT_RESOURCE_FIELDS = [
  'gradients',
  'gradientStops',
  'gradientStopsCount',
  'dashes',
  'strokeMesh',
  'clipMesh',
  'maskMesh',
  'filterTab',
  'filterGraphs',
  'filterRegions',
  'filterRegionObb',
  'filterRegionQuads',
  'filterPrimCtms',
  'kernelTab',
  'clipperRows',
  'clipperRowSets',
  'spriteRanges',
  'spriteRangesNonContiguous',
  'shapeHrefs',
];

/// Emit a slot's SVG-in-OT glyph into an existing build context when
/// the font ships an 'SVG ' table record for this gid. Returns true
/// when shapes were imported (caller should advance idx and continue).
export async function emitSvgInOtGlyphIfPresent(slot, slotFont, ox, oy, sx, sy, ctx, bboxBox) {
  if (!slotFont.hasSvgGlyphs) return false;
  const emit = getSvgInOtEmitter();
  if (!emit) {
    if (!slotFont.getSvgGlyphByGid(slot.glyphId)) return false;
    warnMissingFeature(
      'svgInOt',
      'this font has SVG-in-OpenType glyphs, which are not drawn',
      '@kontek/mantle/font/color/svgInOtImport',
      'registerSvgInOtImport()',
    );
    return false;
  }
  return emit(slot, slotFont, ox, oy, sx, sy, ctx, bboxBox);
}
