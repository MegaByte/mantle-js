// textSlotEmit.js — glyph-segment emission (horizontal + vertical) and the
// vertical-layout re-aiming pass, split out of textLayout.js. Consumes the
// laid-out slots from layoutSlots (textLayout.js) and turns each into
// user-space segment geometry. Imported by textRun.js.

import { mkLine, mkQuad, mkCubic, SEG_LINE, SEG_QUAD, SEG_CUBIC } from '../svg/importer.js';
import { isCjkOrUprightCodepoint } from './textBreak.js';

export function applyVerticalLayout(slots, font, textOrient, writingMode, ox = 0, oy = 0) {
  // SVG/CSS vertical-rl stacks columns RIGHT→LEFT; vertical-lr
  // stacks LEFT→RIGHT. For a single column we just move the pen
  // down; multi-column wrap would use this to pick the column-stack
  // direction. The fallback here treats both as a single column
  // anchored at x=0 so a caller building a single line gets the
  // expected DOWN-the-page run. `ox`/`oy` translate the whole column
  // in the re-aimed space (used by buildTextSections to pin the
  // bundle's globalBBox origin to (0,0) for vertical runs too).
  void writingMode;
  const out = new Array(slots.length);
  // Column positions are RE-ACCUMULATED from each glyph's VERTICAL
  // advance (vmtx for upright glyphs) — reusing the horizontal penX
  // (hmtx sums) mis-spaced vertical CJK wherever vmtx ≠ hmtx (common
  // for punctuation/kana). Each line keeps its leading penX offset
  // (alignment/margin); zero-advance marks ride the previous glyph's
  // position plus their GPOS inline delta.
  const posByIdx = new Float64Array(slots.length);
  let curLine = null;
  let colPos = 0;
  let colStarted = false;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const lnY9 = s.lineY !== undefined ? s.lineY : s.penY;
    if (curLine === null || lnY9 !== curLine) { curLine = lnY9; colStarted = false; }
    const upright = textOrient === 'upright'
                 || (textOrient === 'mixed' && isCjkOrUprightCodepoint(s.codepoint | 0));
    // Vertical step: vmtx advanceHeight when upright; sideways glyphs
    // span their horizontal advance along the line axis (CSS Writing
    // Modes).
    let vAdv = s.advance || 0;
    if (upright && typeof font.getVerticalMetricsByGid === 'function') {
      const m = font.getVerticalMetricsByGid(s.glyphId);
      if (m && m.advanceHeight) vAdv = m.advanceHeight;
    }
    let pos;
    if ((s.advance || 0) === 0 && i > 0) {
      // Combining mark: anchor to the previous glyph's column position,
      // preserving the GPOS inline delta the pen loop applied.
      pos = posByIdx[i - 1] + (s.penX - slots[i - 1].penX);
    } else {
      if (!colStarted) { colPos = s.penX; colStarted = true; }
      pos = colPos;
      colPos += vAdv;
    }
    posByIdx[i] = pos;
    let originXEm = 0;
    let originYEm = pos;
    if (upright) {
      const vOriginYem = (typeof font.getVerticalOriginY === 'function')
        ? font.getVerticalOriginY(s.glyphId) : 0.5;
      const halfAdvEm = (s.advance || 0) * 0.5;
      originXEm = -halfAdvEm;       // centre the upright glyph
      originYEm += vOriginYem;      // shift origin down to vert-origin
    }
    // Clone the slot with re-aimed coords + rotation hint.
    const cloned = { ...s };
    cloned.penX = originXEm + ox;
    cloned.penY = originYEm + oy;
    if (!upright) {
      cloned.style = { ...(s.style || {}), rotateDeg: 90 };
    }
    cloned.advance = vAdv;
    out[i] = cloned;
  }
  return out;
}

export function normalizeWritingMode(v) {
  if (v == null) return 'horizontal-tb';
  const s = String(v).trim().toLowerCase();
  if (s === 'vertical-rl' || s === 'tb' || s === 'tb-rl') return 'vertical-rl';
  if (s === 'vertical-lr' || s === 'tb-lr')               return 'vertical-lr';
  return 'horizontal-tb';
}

export function normalizeTextOrientation(v) {
  if (v == null) return 'mixed';
  const s = String(v).trim().toLowerCase();
  if (s === 'upright' || s === 'sideways') return s;
  return 'mixed';
}

export function emitHorizontalGlyphs(slots, useFont, x, y, fontSize, shearTan, synthBoldSwEm) {
  const out = [];
  for (const slot of slots) {
    if (slot.ignorable) continue; // default-ignorable: zero-ink
    const slotFont = slot.font || useFont;
    const src = slotFont.getGlyphSegsByGid(slot.glyphId);
    if (!src || src.length === 0) continue;
    const invUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;
    const sx = invUpem * fontSize, sy = sx;
    const ox = x + slot.penX * fontSize;
    const oy = y + slot.penY * fontSize;
    const segs = [];
    const X = shearTan !== 0
      ? (p) => {
          const sxv = p[0] * sx;
          const syv = -p[1] * sy;
          return [ox + sxv - syv * shearTan, oy + syv];
        }
      : (p) => [ox + p[0] * sx, oy - p[1] * sy];
    for (const s of src) {
      if      (s.type === SEG_LINE)  segs.push(mkLine (X(s.p1), X(s.p2)));
      else if (s.type === SEG_QUAD)  segs.push(mkQuad (X(s.p1), X(s.p2), X(s.p3)));
      else if (s.type === SEG_CUBIC) segs.push(mkCubic(X(s.p1), X(s.p2), X(s.p3), X(s.p4)));
    }
    if (segs.length) {
      const g = { segs, codepoint: slot.codepoint, penX: slot.penX * fontSize, advance: slot.advance * fontSize };
      if (synthBoldSwEm > 0) g.synthBoldSwEm = synthBoldSwEm;
      out.push(g);
    }
  }
  return out;
}

/// Vertical layout. The horizontal layoutSlots already produced
/// per-slot penX (em-units, advance along the inline axis). For
/// vertical mode we REINTERPRET penX as penY (pen moves DOWN the
/// page), then position each glyph using the font's per-gid vertical
/// metrics. Glyphs that should ride upright in `text-orientation:
/// mixed` (CJK ideographs, kana, hangul, fullwidth) use vmtx /
/// VORG / vertTypoAscender to anchor their origin; sideways glyphs
/// (Latin in `mixed`, everything in `sideways`) get a 90° clockwise
/// rotation in addition to the baseline-aligned positioning.
export function emitVerticalGlyphs(slots, useFont, x, y, fontSize, shearTan, synthBoldSwEm, textOrient) {
  const out = [];
  for (const slot of slots) {
    if (slot.ignorable) continue; // default-ignorable: zero-ink
    const slotFont = slot.font || useFont;
    const src = slotFont.getGlyphSegsByGid(slot.glyphId);
    if (!src || src.length === 0) continue;
    const invUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;
    const sx = invUpem * fontSize, sy = sx;
    // The horizontal layout step used penX as the linear advance
    // along the inline axis. Reuse it as the Y position for the
    // vertical column (vertical-rl: top→down; same offset applies
    // for vertical-lr — column-stacking direction is the caller's
    // worry).
    const advanceAlong = slot.penX * fontSize;  // user-space
    // Decide upright vs sideways for THIS glyph.
    const upright = textOrient === 'upright'
                 || (textOrient === 'mixed' && isCjkOrUprightCodepoint(slot.codepoint | 0));
    let segs;
    if (upright) {
      // Origin: use vmtx-derived vertical origin Y (distance from
      // glyph top down to the OT-baseline origin used by horizontal
      // outlines). For fonts without vmtx, fall back to half-em.
      const vOriginYem = (typeof slotFont.getVerticalOriginY === 'function')
        ? slotFont.getVerticalOriginY(slot.glyphId)
        : 0.5;
      // The glyph's OT-origin (0,0) sits at the cell's left edge,
      // baseline level. Position the cell so its TOP is at penY ==
      // y + advanceAlong, centered horizontally at x.
      const advanceHeightEm = (typeof slotFont.getVerticalMetricsByGid === 'function')
        ? (slotFont.getVerticalMetricsByGid(slot.glyphId).advanceHeight || 1.0)
        : 1.0;
      const ox = x - (slot.advance * fontSize) * 0.5;  // horizontal centring
      const oy = y + advanceAlong + vOriginYem * fontSize;
      segs = [];
      const X = shearTan !== 0
        ? (p) => {
            const sxv = p[0] * sx;
            const syv = -p[1] * sy;
            return [ox + sxv - syv * shearTan, oy + syv];
          }
        : (p) => [ox + p[0] * sx, oy - p[1] * sy];
      for (const s of src) {
        if      (s.type === SEG_LINE)  segs.push(mkLine (X(s.p1), X(s.p2)));
        else if (s.type === SEG_QUAD)  segs.push(mkQuad (X(s.p1), X(s.p2), X(s.p3)));
        else if (s.type === SEG_CUBIC) segs.push(mkCubic(X(s.p1), X(s.p2), X(s.p3), X(s.p4)));
      }
      if (segs.length) {
        const g = {
          segs, codepoint: slot.codepoint,
          // For vertical, penX is the LINE-AXIS position (constant
          // for one column) and penY is the position along the
          // column. We report (penY, advance) so callers chaining
          // <tspan>-style columns know where to continue.
          penX: 0, penY: advanceAlong,
          advance: advanceHeightEm * fontSize,
        };
        if (synthBoldSwEm > 0) g.synthBoldSwEm = synthBoldSwEm;
        out.push(g);
      }
    } else {
      // Sideways: glyph rotated 90° CW around its bottom-left.
      // The bottom of the glyph sits along the column's right side;
      // the right edge of the glyph faces DOWN the page.
      // OT-space → user-space mapping:
      //   x_user = ox + (-otY * sy)        (glyph's +Y maps to -X user)
      //   y_user = oy + (otX * sx)         (glyph's +X maps to +Y user)
      // After shear (synth italic) the shear becomes a Y-shift along
      // the column.
      const ox = x;
      const oy = y + advanceAlong;
      segs = [];
      // Synthetic-italic shear is intentionally NOT applied to sideways
      // glyphs (it would skew along the column), so both shear/no-shear
      // cases map OT → user identically: OT +X → +Y user, OT +Y → -X user.
      const X = (p) => [ox - p[1] * sy, oy + p[0] * sx];
      for (const s of src) {
        if      (s.type === SEG_LINE)  segs.push(mkLine (X(s.p1), X(s.p2)));
        else if (s.type === SEG_QUAD)  segs.push(mkQuad (X(s.p1), X(s.p2), X(s.p3)));
        else if (s.type === SEG_CUBIC) segs.push(mkCubic(X(s.p1), X(s.p2), X(s.p3), X(s.p4)));
      }
      if (segs.length) {
        const g = {
          segs, codepoint: slot.codepoint,
          penX: 0, penY: advanceAlong,
          advance: slot.advance * fontSize,
        };
        if (synthBoldSwEm > 0) g.synthBoldSwEm = synthBoldSwEm;
        out.push(g);
      }
    }
  }
  return out;
}
