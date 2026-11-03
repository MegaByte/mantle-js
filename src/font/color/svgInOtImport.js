// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgInOtImport.js — SVG-in-OT nested import for color glyphs (the part that needs the SVG importer).
//
//   import { registerSvgInOtImport } from '@kontek/mantle/font/color/svgInOtImport';
//   registerSvgInOtImport();

import importSvg from '../../svg/importer.js';
import { liftGlyphSubElement } from './svgInOtReader.js';
import { gunzipBytes } from '../../core/gzip.js';
import { mantleWarn } from '../../core/diagnostics.js';
import { noteMalformedTable } from '../fontTableGuard.js';
import { registerSvgInOtEmitter } from '../svgInOtHook.js';
import { SVG_TEXT_RESOURCE_FIELDS } from '../textSvgInOt.js';

/// Emit a slot's SVG-in-OT glyph into an existing build context when
/// the font ships an 'SVG ' table record for this gid. Returns true
/// when shapes were imported (caller should advance idx and continue).
async function emitSvgInOtGlyph(slot, slotFont, ox, oy, sx, sy, ctx, bboxBox) {
  const svgG = slotFont.getSvgGlyphByGid(slot.glyphId);
  if (!svgG) return false;
  // SVG glyph coordinates already point down from the baseline. Match the
  // slot rotation used by the TrueType path after its Y-axis conversion.
  const angle = ((slot.style.rotateDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const xform = `matrix(${cos * sx} ${-sin * sx} ${sin * sy} ${cos * sy} ${ox} ${oy})`;
  const metaCountBefore = ctx.metas.length;
  try {
    let bytes = svgG.svgBytes;
    if (svgG.isGzipped) bytes = await gunzipBytes(bytes);
    if (!bytes || bytes.length === 0) return false;
    const docText = new TextDecoder('utf-8').decode(bytes);
    const lifted = liftGlyphSubElement(docText, svgG.subElementId, xform, slotFont.unitsPerEm);
    const sections = await importSvg(lifted, {
      ctx,
      _spriteId: svgG.subElementId,
      defaultFill: 'black',
      initialColor: `rgba(${slot.style.color
        .slice(0, 3)
        .map((c) => c * 255)
        .join(',')},${slot.style.color[3]})`,
      defaultStroke: 'transparent',
      defaultStrokeW: 1,
      preserveViewport: false,
    });
    const resources = {};
    for (const key of SVG_TEXT_RESOURCE_FIELDS)
      if (sections[key] !== undefined) resources[key] = sections[key];
    ctx._svgTextResources = resources;
    for (let i = metaCountBefore; i < ctx.metas.length; i++) ctx.shapeIds[i] = sections.shapeIds[i];
    while (ctx.parents.length < ctx.metas.length) ctx.parents.push(-1);
  } catch (err) {
    // A document that does not gunzip or parse costs this glyph its SVG: with nothing imported, the caller goes on to the outline.
    if (typeof DOMParser === 'undefined')
      mantleWarn(`SVG-in-OT glyph ${slot.glyphId} needs a global DOMParser:`, err.message);
    else noteMalformedTable(slotFont._tables, 'SVG ', err, 'kept, this glyph without its document');
    if (ctx.metas.length === metaCountBefore) return false;
  }
  // Union the new metas' bboxes into the textrun's running bbox.
  for (let mi = metaCountBefore; mi < ctx.metas.length; mi++) {
    const m = ctx.metas[mi];
    if (m.flagsShape & (64 | 128 | 256)) continue;
    const mbb = m.bbox;
    if (mbb && mbb[0] <= mbb[2] && mbb[1] <= mbb[3]) {
      if (mbb[0] < bboxBox.xmin) bboxBox.xmin = mbb[0];
      if (mbb[1] < bboxBox.ymin) bboxBox.ymin = mbb[1];
      if (mbb[2] > bboxBox.xmax) bboxBox.xmax = mbb[2];
      if (mbb[3] > bboxBox.ymax) bboxBox.ymax = mbb[3];
    }
  }
  return true;
}

let _registered = false;
export function registerSvgInOtImport() {
  if (_registered) return;
  _registered = true;
  registerSvgInOtEmitter(emitSvgInOtGlyph);
}
