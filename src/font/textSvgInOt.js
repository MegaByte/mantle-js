// textSvgInOt.js — SVG-in-OT nested import for color glyphs.

import importSvg from '../svg/importer.js';
import { liftGlyphSubElement } from './color/svgInOtReader.js';
import { gunzipBytes } from '../core/gzip.js';
import { mantleWarn } from '../core/diagnostics.js';

/// Emit a slot's SVG-in-OT glyph into an existing build context when
/// the font ships an 'SVG ' table record for this gid. Returns true
/// when shapes were imported (caller should advance idx and continue).
export async function emitSvgInOtGlyphIfPresent(slot, slotFont, ox, oy, sx, sy, ctx, bboxBox) {
  if (!slotFont.hasSvgGlyphs) return false;
  const svgG = slotFont.getSvgGlyphByGid(slot.glyphId);
  if (!svgG) return false;
  let bytes = svgG.svgBytes;
  if (svgG.isGzipped) {
    bytes = await gunzipBytes(bytes);
  }
  if (!bytes || bytes.length === 0) return false;
  const docText = new TextDecoder('utf-8').decode(bytes);
  // Per OT 'SVG ' spec, document coords are in font design
  // units with +Y up. textrun bundle is +Y down → scale Y
  // by -sy to flip.
  const xform = `translate(${ox} ${oy}) scale(${sx} ${-sy})`;
  const lifted = liftGlyphSubElement(docText, svgG.subElementId, xform);
  const metaCountBefore = ctx.metas.length;
  try {
    await importSvg(lifted, {
      ctx,
      defaultFill: 'black',
      defaultStroke: 'transparent',
      defaultStrokeW: 1,
      preserveViewport: false,
    });
  } catch (err) {
    mantleWarn(`SVG-in-OT glyph ${slot.glyphId} import failed:`, err.message);
  }
  // Union the new metas' bboxes into the textrun's running bbox.
  for (let mi = metaCountBefore; mi < ctx.metas.length; mi++) {
    const mbb = ctx.metas[mi].bbox;
    if (mbb && mbb[0] <= mbb[2] && mbb[1] <= mbb[3]) {
      if (mbb[0] < bboxBox.xmin) bboxBox.xmin = mbb[0];
      if (mbb[1] < bboxBox.ymin) bboxBox.ymin = mbb[1];
      if (mbb[2] > bboxBox.xmax) bboxBox.xmax = mbb[2];
      if (mbb[3] > bboxBox.ymax) bboxBox.ymax = mbb[3];
    }
  }
  return true;
}
