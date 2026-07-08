// textRun.js — string → bundle assembler. Plain-text and rich-text
// (markup parser + styled-span API) entry points plus layout (line wrap,
// alignment, per-line baseline).

import { packMetaBody, mkLine, mkQuad, mkCubic } from '../svg/importer.js';
import { makeBuildContext, emitShape } from '../svg/buildContext.js';
import { parseMarkup, defaultStyle } from './markupParser.js';
import {
  layoutSlots,
} from './textLayout.js';
import {
  applyVerticalLayout,
  normalizeWritingMode,
  normalizeTextOrientation,
  emitHorizontalGlyphs,
  emitVerticalGlyphs,
} from './textSlotEmit.js';
import {
  createColrEmitState,
  buildColrGradientStopsSection,
  transformAndFlip,
  emitColrV1GlyphIfPresent,
  emitColrV0GlyphIfPresent,
  emitOutlineGlyph,
} from './textColrEmit.js';
import { emitSvgInOtGlyphIfPresent } from './textSvgInOt.js';


/** @typedef {[number,number,number,number]} Color */
/** @typedef {{ color: Color, sizeScale: number, voffsetEm: number }} Style */
/** @typedef {{ text: string, style: Style }} Span */
/**
 * @typedef LayoutOptions
 * @property {number} [maxWidthEm]
 * @property {('left'|'center'|'right')} [align]
 * @property {number} [lineHeightEm]
 * @property {Record<string, boolean>} [features]         OpenType opt-in
 *   GSUB feature tags (e.g. `{ tnum: true, lnum: true, ss01: true }`).
 *   Each truthy entry runs that feature's lookup chain over the per-
 *   font glyph runs via `gsub.applyFeatureToSeq`. `smcp` here is
 *   equivalent to the `<smallcaps>` markup tag / `style.smallCaps`.
 *   Unknown / unsupported tags no-op silently.
 * @property {Set<string>|string[]} [disabledFeatures]    OpenType
 *   default-on tags to suppress: `kern` skips the GPOS kerning loop;
 *   `liga` / `rlig` skips the ligature substitution pass. Other tags
 *   in the set are ignored (default-on features beyond these are
 *   script-shaper-internal and shouldn't be disabled by callers).
 * @property {('horizontal-tb'|'vertical-rl'|'vertical-lr')} [writingMode]
 *   CSS Writing Modes Level 4 / SVG 2 §11.4. `horizontal-tb` (default)
 *   advances along +X; vertical modes advance along +Y. Each glyph's
 *   origin shifts from baseline-aligned to vert-origin-aligned using
 *   the font's vmtx / VORG tables (em-box-half fallback when absent).
 *   The same knob is exposed on `styleOpts.writingMode` for the
 *   `buildSvgTextGlyphs` SVG-shortcut entry; both paths share the
 *   layout post-process.
 * @property {('mixed'|'upright'|'sideways')} [textOrientation]
 *   CSS Writing Modes Level 4. `mixed` (default) keeps CJK
 *   ideographs / kana / hangul upright and rotates Latin glyphs
 *   90° clockwise; `upright` keeps everything upright; `sideways`
 *   rotates everything 90° CW. Ignored in horizontal mode.

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Plain text in one color.
 * @param {string} text
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {Color} [color]
 */
export async function buildTextRun(text, font, color = [0, 0, 0, 1]) {
  const style = { ...defaultStyle(), color: color.slice() };
  return await buildStyled([{ text: text ?? '', style }], font, {});
}

/**
 * Pre-styled spans + layout.
 * @param {Span[]} spans
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export async function buildStyled(spans, font, layout = {}) {
  if (!font) throw new Error('font is required');
  spans = spans || [];
  const writingMode = normalizeWritingMode(layout.writingMode);
  const vertical = writingMode !== 'horizontal-tb';
  // In vertical mode the pen axes are re-aimed (inline advance → +Y),
  // so an `originX`/`originY` shift expressed in horizontal space would
  // land on the wrong axis. Strip it from the horizontal pass and
  // re-apply it in the re-aimed space inside applyVerticalLayout, so the
  // (0,0)-origin normalization in buildTextSections still holds.
  const slotLayout = (vertical && (layout.originX || layout.originY))
    ? { ...layout, originX: 0, originY: 0 }
    : layout;
  let slots = layoutSlots(spans, font, slotLayout);
  // Vertical writing-mode: re-aim each slot's pen so subsequent
  // assembleBundle emits glyphs DOWN the column. The orientation
  // tag is stamped on each slot so transformAndFlip's rotDeg path
  // takes the 90°-CW transform for `sideways`-mode glyphs.
  if (vertical) {
    slots = applyVerticalLayout(slots, font,
      normalizeTextOrientation(layout.textOrientation),
      writingMode, layout.originX || 0, layout.originY || 0);
  }
  return await assembleBundle(slots, font, layout.varCoords || null);
}

/**
 * Parse markup, then build.
 * @param {string} markup
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {Color} [defaultColor]
 * @param {LayoutOptions} [layout]
 */
export async function buildFromMarkup(markup, font, defaultColor = [0, 0, 0, 1], layout = {}) {
  const base = { ...defaultStyle(), color: defaultColor.slice() };
  const spans = parseMarkup(markup, base);
  return await buildStyled(spans, font, layout);
}

/**
 * Layout-only metrics for a string of styled spans. Skips the coverage
 * texture / cover-quad emit `buildStyled` does, so it's much cheaper.
 *
 * Width is pen-advance-based (typographic), not ink-bbox. Use
 * buildStyled if you need actual rendered glyph extent.
 *
 * Returns: {
 *   width, height,
 *   ascent, descent,
 *   lineHeight,
 *   lineCount,
 *   maxLineWidth,         // = width
 *   lineWidths: number[]  // per-line widths
 * }
 * All values are in em-space, +Y down. Empty spans → all zeros +
 * lineWidths: [].
 *
 * @param {Span[]} spans
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export function measureText(spans, font, layout = {}) {
  if (!font) throw new Error('font is required');
  spans = spans || [];
  if (spans.length === 0) {
    return {
      width: 0, height: 0,
      ascent: font.ascent, descent: -font.descent,
      lineHeight: layout.lineHeightEm > 0
        ? layout.lineHeightEm
        : (font.ascent - font.descent + font.lineGap),
      lineCount: 0, maxLineWidth: 0, lineWidths: [],
    };
  }

  const slots = layoutSlots(spans, font, layout);

  // Walk slots; group by penY into lines. Slots are emitted in
  // document order with monotonically non-decreasing penY. Slots
  // never contain synthetic directive entries — layout flattens
  // those during pass 1.
  const lineWidths = [];
  let curLineWidth = 0;
  let curLineY = null;
  let nLines = 0;
  for (const slot of slots) {
    if (curLineY === null || slot.penY !== curLineY) {
      if (curLineY !== null) lineWidths.push(curLineWidth);
      curLineY = slot.penY;
      curLineWidth = 0;
      nLines++;
    }
    const right = slot.penX + slot.advance;
    if (right > curLineWidth) curLineWidth = right;
  }
  if (curLineY !== null) lineWidths.push(curLineWidth);

  let maxLineWidth = 0;
  for (const w of lineWidths) if (w > maxLineWidth) maxLineWidth = w;

  const ascent  = font.ascent;
  const descent = -font.descent;  // font.descent is negative
  const lineHeight = layout.lineHeightEm > 0
    ? layout.lineHeightEm
    : (font.ascent - font.descent + font.lineGap);
  const height = nLines > 0
    ? ascent + descent + lineHeight * Math.max(0, nLines - 1)
    : 0;

  return {
    width: maxLineWidth,
    height,
    ascent, descent,
    lineHeight,
    lineCount: nLines,
    maxLineWidth,
    lineWidths,
  };
}

/**
 * measureText with markup parsing — mirror of buildFromMarkup.
 */
export function measureFromMarkup(markup, font, layout = {}) {
  const spans = parseMarkup(markup ?? '', defaultStyle());
  return measureText(spans, font, layout);
}

/**
 * Per-glyph layout geometry for a styled span list — the missing
 * companion to measureText (which collapses to per-line widths). Runs
 * the same `layoutSlots` pass `buildStyled` uses, but skips the coverage
 * texture / cover-quad emit, so it's cheap enough to call per reflow.
 * Returns one record per laid-out glyph (whitespace included
 * as zero-ink advance slots), in document order. Coordinates are in
 * em-space, +Y down, baseline at `penY`:
 *
 *   {
 *     glyphs: [{
 *       penX,            // inline x of the glyph origin within its line
 *       penY,            // baseline y of the glyph's line (line key)
 *       advance,         // inline advance (penX+advance = glyph right)
 *       cluster,         // source char index in the concatenated span text
 *       codepoint,       // unicode scalar (0x20 == space)
 *     }, ...],
 *     ascent, descent,   // font ascent / -descent (descent <= 0)
 *     lineHeight,        // baseline-to-baseline step
 *     lineCount,
 *   }
 *
 * `cluster` lets callers map a SOURCE string index ↔ rendered glyph
 * box (per-word hit-testing / inline highlight rects), and `penY`
 * groups glyphs into wrapped lines. Geometry is style-independent of
 * color/underline (those don't change advance), so a caller can
 * measure plain text once and render styled markup that wraps
 * identically. Empty spans → { glyphs: [] } with font metrics.
 *
 * @param {Span[]} spans
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export function measureGlyphs(spans, font, layout = {}) {
  if (!font) throw new Error('font is required');
  spans = spans || [];
  const ascent = font.ascent;
  const descent = -font.descent;  // font.descent is negative
  const lineHeight = layout.lineHeightEm > 0
    ? layout.lineHeightEm
    : (font.ascent - font.descent + font.lineGap);
  if (spans.length === 0) {
    return { glyphs: [], ascent, descent, lineHeight, lineCount: 0 };
  }
  const slots = layoutSlots(spans, font, layout);

  // Source-index reconstruction. Slots carry a boolean `clusterStart`
  // flag (first-of-grapheme), NOT a source offset, so we recover the
  // UTF-16 index of each glyph by matching slot codepoints against the
  // concatenated span text in document order. Exact for LTR text (one
  // logical run, glyphs emitted in logical order) — the per-word
  // hit-testing use case. For bidi-reordered RTL or ligature-collapsed
  // runs it degrades to best-effort. `cluster` is the resulting UTF-16
  // index into the source.
  const src = spans.map((sp) => sp.text || '').join('');
  let srcPos = 0;

  const glyphs = new Array(slots.length);
  let curLineY = null;
  let lineCount = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (curLineY === null || s.penY !== curLineY) {
      curLineY = s.penY;
      lineCount++;
    }
    const cp = s.codepoint | 0;
    let cluster = srcPos;
    if (s.clusterStart) {
      // Advance to this codepoint's next occurrence (skips any glyphs
      // with no 1:1 source char, e.g. inserted marks).
      let p = srcPos;
      while (p < src.length) {
        const c = src.codePointAt(p);
        if (c === cp) break;
        p += c > 0xffff ? 2 : 1;
      }
      if (p < src.length) {
        cluster = p;
        srcPos = p + (cp > 0xffff ? 2 : 1);
      } else {
        cluster = Math.min(srcPos, Math.max(0, src.length - 1));
      }
    } else if (i > 0) {
      // Combining mark / ligature component → same cluster as the base.
      cluster = glyphs[i - 1].cluster;
    }
    glyphs[i] = {
      penX: s.penX,
      penY: s.penY,
      advance: s.advance,
      cluster,
      codepoint: cp,
    };
  }
  return { glyphs, ascent, descent, lineHeight, lineCount };
}

/**
 * measureGlyphs for a single run of PLAIN text (no markup parsing), so
 * each glyph's `cluster` indexes directly into `text`. Mirrors
 * buildTextRun's span construction. Use this for per-word hit-testing /
 * inline highlight geometry where the caller works in source-string
 * char indices and styles the rendered copy separately.
 *
 * @param {string} text
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export function measureGlyphsFromText(text, font, layout = {}) {
  const spans = [{ text: text ?? '', style: defaultStyle() }];
  return measureGlyphs(spans, font, layout);
}

/**
 * SVG <text> entry. Lays out `text` with `font` and returns a list of
 * per-glyph shapes — each a separate seg list emitted as its own Mantle
 * shape (own bbox + curve+band data + cover quad).
 *
 * Per-glyph shapes matter for coverage perf: one combined shape would
 * make every fragment's band walk scan every glyph's curves in the
 * relevant band; separate shapes keep band-walk cost local to each
 * glyph's tight bbox.
 *
 * Coordinates: glyph segs are in SVG user-space (+Y down), already
 * scaled by `fontSize` and translated so the text baseline runs at
 * y == `y`. Each glyph element carries its own (xmin, ymin, xmax,
 * ymax) for downstream bbox-aware callers.
 *
 * styleOpts (optional, 8th arg): { fontWeight, fontStyle,
 *   variantFonts: { boldFont?, italicFont?, boldItalicFont? },
 *   letterSpacingEm?, wordSpacingEm? }.
 * - When `fontWeight >= 600` or the literal "bold" / "bolder" and
 *   variantFonts.boldFont is wired, that font is used instead of the
 *   base. Same for italic. Combined bold+italic prefers boldItalicFont,
 *   then falls back to boldFont, then italicFont.
 * - letterSpacingEm/wordSpacingEm are in em units (importer divides
 *   user-space CSS values by fontSize before passing through).
 * - Unknown / missing variants fall through to the base font (no
 *   synthesis); callers can post-process for shear / stroke.
 *
 * Layout is single-line, advance-only. No wrap, no markup, no kerning
 * across font fallbacks.
 *
 * @param {string} text
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {number} x   baseline X in SVG user-space
 * @param {number} y   baseline Y in SVG user-space
 * @param {number} fontSize  em → SVG user-space scale (size in px)
 * @returns {{ glyphs: { segs: object[], codepoint: number }[],
 *             advance: number }}
 *   glyphs is one entry per emitted glyph (skipping whitespace +
 *   missing glyphs); each entry's segs is ready for pathBbox /
 *   buildTexturesShape. advance is the final pen position relative
 *   to x in EM units (multiply by fontSize for user-space).
 */
/// Treat font-weight per CSS Fonts Level 4: 600+ (or 'bold' / 'bolder')
/// is bold. Strings parse to numbers; unrecognised values are normal.
function isBoldWeight(v) {
  if (v == null) return false;
  if (typeof v === 'number') return v >= 600;
  const s = String(v).trim().toLowerCase();
  if (s === 'bold' || s === 'bolder') return true;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 600;
}

/// 'italic' OR 'oblique' (CSS treats them equivalently for selection).
function isItalicStyle(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'italic' || s === 'oblique';
}

export function buildSvgTextGlyphs(text, font, x, y, fontSize, fallbacks = null, maxWidthEm = 0, styleOpts = null) {
  if (!font) throw new Error('font is required');
  const t = text ?? '';
  if (!t) return { glyphs: [], advance: 0 };
  // Variant font selection. When the caller wired a matching variant
  // (boldFont / italicFont / boldItalicFont) use it; otherwise fall back
  // to synthesis — italic via 12° shear, bold via stroke inflation at
  // ~4% em on top of the fill paint (CSS `font-synthesis: weight style`,
  // the browser default).
  let useFont = font;
  let synthBold = false;
  let synthItalic = false;
  if (styleOpts) {
    const wantBold   = isBoldWeight(styleOpts.fontWeight);
    const wantItalic = isItalicStyle(styleOpts.fontStyle);
    const vf = styleOpts.variantFonts || null;
    if (wantBold && wantItalic) {
      if (vf && vf.boldItalicFont) useFont = vf.boldItalicFont;
      else if (vf && vf.boldFont)   { useFont = vf.boldFont;   synthItalic = true; }
      else if (vf && vf.italicFont) { useFont = vf.italicFont; synthBold = true; }
      else                           { synthBold = true; synthItalic = true; }
    } else if (wantBold) {
      if (vf && vf.boldFont) useFont = vf.boldFont;
      else                   synthBold = true;
    } else if (wantItalic) {
      if (vf && vf.italicFont) useFont = vf.italicFont;
      else                     synthItalic = true;
    }
    // Per-style escape hatch: styleOpts.synthesizeBold/Italic === false
    // disables synthesis (matches CSS `font-synthesis: none`).
    if (styleOpts.synthesizeBold   === false) synthBold = false;
    if (styleOpts.synthesizeItalic === false) synthItalic = false;
  }
  const baseStyle = defaultStyle();
  // Carry letter-spacing / word-spacing through to the span style so
  // layoutSlots can apply them. The span style schema already has
  // these fields for the markup path; reuse the same names.
  if (styleOpts) {
    if (typeof styleOpts.letterSpacingEm === 'number') baseStyle.letterSpacing = styleOpts.letterSpacingEm;
    if (typeof styleOpts.wordSpacingEm   === 'number') baseStyle.wordSpacing   = styleOpts.wordSpacingEm;
  }
  const spans = [{ text: t, style: baseStyle }];
  // maxWidthEm > 0 triggers word-wrap (used by <textArea>); 0 = single line.
  const layoutOpts = {};
  if (fallbacks) layoutOpts.fallbacks = fallbacks;
  if (maxWidthEm > 0) layoutOpts.maxWidthEm = maxWidthEm;
  const slots = layoutSlots(spans, useFont, layoutOpts);
  // Synth-italic shear amount. CSS uses -12°; the negative sign
  // is so the TOP of the glyph leans RIGHT (the visual italic
  // direction), since OT +Y is UP and SVG +Y is DOWN.
  const shearTan = synthItalic ? Math.tan(12 * Math.PI / 180) : 0;
  // Synth-bold stroke half-width (stroke paints both sides of the path):
  // 0.04 em ≈ 8% visual bolding at typical text size.
  const synthBoldSwEm = synthBold ? 0.04 : 0;
  // Writing-mode + text-orientation (CSS Writing Modes Level 4 /
  // SVG 2 §11.4). We accept three normalized values:
  //   'horizontal-tb' (default) — pen along +X, glyph origin = baseline.
  //   'vertical-rl'             — pen along +Y, columns stack right→left.
  //   'vertical-lr'             — pen along +Y, columns stack left→right.
  // text-orientation:
  //   'mixed' (default) — CJK upright, Latin rotated 90° clockwise.
  //   'upright'         — all glyphs upright (no rotation).
  //   'sideways'        — all glyphs rotated 90° clockwise.
  const writingMode = normalizeWritingMode(styleOpts && styleOpts.writingMode);
  const textOrient  = normalizeTextOrientation(styleOpts && styleOpts.textOrientation);
  const vertical    = writingMode !== 'horizontal-tb';
  const glyphs = vertical
    ? emitVerticalGlyphs(slots, useFont, x, y, fontSize, shearTan, synthBoldSwEm, textOrient)
    : emitHorizontalGlyphs(slots, useFont, x, y, fontSize, shearTan, synthBoldSwEm);
  let advance = 0;
  if (slots.length > 0) {
    const last = slots[slots.length - 1];
    advance = (last.penX + last.advance) * fontSize;
  }
  return { glyphs, advance, writingMode, textOrientation: textOrient };
}

// Internal export: inspect per-slot positions without running the full
// bundle assembly. Not part of the public API.
export function _layoutSlotsForTest(spans, font, layout) {
  return layoutSlots(spans, font, layout);
}


// ---------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------

async function assembleBundle(slots, font, varCoords = null) {
  const ctx = makeBuildContext();
  const gidBox = { next: 1 };
  const bboxBox = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  let firstBaselineY = 0, lastBaselineY = 0, lineCount = 0, lastLineAdvance = 0;
  if (slots.length > 0) {
    let curLineY = null;
    let curLineRight = 0;
    for (const slot of slots) {
      if (curLineY === null || slot.penY !== curLineY) {
        if (curLineY === null) firstBaselineY = slot.penY;
        curLineY = slot.penY;
        lineCount++;
        curLineRight = 0;
      }
      const right = slot.penX + slot.advance;
      if (right > curLineRight) curLineRight = right;
    }
    lastBaselineY = curLineY;
    lastLineAdvance = curLineRight;
  }
  const colrState = createColrEmitState();

  emitDecorationRects(slots, font, ctx, gidBox, bboxBox,
    { mark: true, underline: false, strike: false });

  let idx = 0;
  for (const slot of slots) {
    if (slot.ignorable) { idx++; continue; }
    const slotFont = slot.font || font;
    const slotInvUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;

    const glyphScale = slot.style.glyphScale > 0 ? slot.style.glyphScale : 1;
    const sy = slotInvUpem * slot.style.sizeScale * glyphScale;
    const widthScale = slot.style.widthScale > 0 ? slot.style.widthScale : 1;
    const sx = sy * widthScale;
    const ox = slot.penX;
    const oy = slot.penY - slot.style.voffsetEm;
    const rotDeg = slot.style.rotateDeg || 0;
    const SYNTH_ITALIC_DEG = -12;
    const shearDeg = slot.synthItalic
      ? (slotFont.italicAngle !== 0 ? slotFont.italicAngle : SYNTH_ITALIC_DEG)
      : 0;
    const shearTan = shearDeg !== 0 ? Math.tan(-shearDeg * Math.PI / 180) : 0;
    const synthBoldSwEm = slot.synthBold ? 0.04 : 0;
    const cpHex = slot.codepoint.toString(16).toUpperCase().padStart(4, '0');

    if (await emitSvgInOtGlyphIfPresent(slot, slotFont, ox, oy, sx, sy, ctx, bboxBox)) {
      idx++;
      continue;
    }

    if (emitColrV1GlyphIfPresent(slot, slotFont, varCoords, ctx, gidBox, bboxBox, colrState,
                                  ox, oy, sx, sy, rotDeg, idx, cpHex)) {
      idx++;
      continue;
    }

    if (emitColrV0GlyphIfPresent(slot, slotFont, ctx, gidBox, bboxBox,
                                 ox, oy, sx, sy, rotDeg, idx, cpHex)) {
      idx++;
      continue;
    }

    if (slot.mathAssembly && slot.mathAssembly.asm.parts.length > 0) {
      const partList = slot.mathAssembly.asm.parts;
      const axis = slot.mathAssembly.axis;
      const upemInv = slotInvUpem;
      for (let pi = 0; pi < partList.length; pi++) {
        const part = partList[pi];
        const pSrc = slotFont.getGlyphSegsByGid(part.glyphID);
        if (!pSrc || pSrc.length === 0) continue;
        const partEmOff = part.offset * upemInv * slot.style.sizeScale
                          * (slot.style.glyphScale > 0 ? slot.style.glyphScale : 1);
        let partOx = ox, partOy = oy;
        if (axis === 'v') {
          partOy = oy - partEmOff;
        } else {
          partOx = ox + partEmOff;
        }
        const partSegs = transformAndFlip(pSrc, partOx, partOy, sx, sy, rotDeg, shearTan);
        emitOutlineGlyph(ctx, gidBox, bboxBox, partSegs, slot.style.color,
                         `glyph_${idx}_u${cpHex}_asm${pi}`, synthBoldSwEm);
      }
      idx++;
      continue;
    }

    const src = slotFont.getGlyphSegsByGid(slot.glyphId);
    if (!src || src.length === 0) { idx++; continue; }
    const segs = transformAndFlip(src, ox, oy, sx, sy, rotDeg, shearTan);
    emitOutlineGlyph(ctx, gidBox, bboxBox, segs, slot.style.color,
                     `glyph_${idx}_u${cpHex}`, synthBoldSwEm);
    idx++;
  }

  emitDecorationRects(slots, font, ctx, gidBox, bboxBox,
    { mark: false, underline: true, strike: true });

  const numShapes = ctx.metas.length;
  if (numShapes === 0) { bboxBox.xmin = bboxBox.ymin = bboxBox.xmax = bboxBox.ymax = 0; }
  let { xmin, ymin, xmax, ymax } = bboxBox;
  if (!Number.isFinite(xmin) || !Number.isFinite(ymin)
      || !Number.isFinite(xmax) || !Number.isFinite(ymax)
      || xmax < xmin || ymax < ymin) {
    xmin = Number.isFinite(xmin) ? xmin : 0;
    ymin = Number.isFinite(ymin) ? ymin : 0;
    xmax = (Number.isFinite(xmax) && xmax >= xmin) ? xmax : xmin;
    ymax = (Number.isFinite(ymax) && ymax >= ymin) ? ymax : ymin;
  }

  const curveTexels = new Float32Array(ctx.curveBuf.count * 4);
  for (let i = 0; i < ctx.curveBuf.count * 4; i++) curveTexels[i] = ctx.curveBuf.floats[i];
  const bandTexels = new Float32Array(ctx.bandBuf.count * 4);
  for (let i = 0; i < ctx.bandBuf.count * 4; i++) bandTexels[i] = ctx.bandBuf.floats[i];
  const metaBytes = packMetaBody(ctx.metas);
  const metaFloats = new Float32Array(metaBytes.buffer, metaBytes.byteOffset, metaBytes.byteLength >>> 2);
  const curveGeomFloats = new Float32Array(ctx.hybridFloats);
  const fontMetricsSnapshot = font && typeof font.fontMetrics === 'function'
    ? font.fontMetrics(varCoords)
    : null;
  return {
    version: 3,
    numShapes,
    flags: 1 | 2 | 4,
    metaFloatsPerShape: 48,
    globalBBox: [xmin, ymin, xmax - xmin, ymax - ymin],
    fontMetrics: fontMetricsSnapshot,
    firstBaselineY,
    lastBaselineY,
    lineCount,
    lastLineAdvance,
    viewBox: [0, 0, 0, 0],
    preserveAspectRatio: [1, 1, 0],
    curveTexels, bandTexels, metaFloats,
    curveGeomFloats,
    parentShapeIdx: new Int32Array(ctx.parents),
    shapeIds: ctx.shapeIds,
    curveRangesByShape: (function () {
      const n = ctx.metas.length;
      const out = new Array(n);
      const totalF = ctx.curveBuf.count * 4;
      for (let i = 0; i < n; i++) out[i] = { begin: ctx.metas[i]._curveStartF | 0, end: 0 };
      for (let i = 0; i < n - 1; i++) out[i].end = out[i + 1].begin;
      if (n > 0) out[n - 1].end = totalF;
      return out;
    })(),
    colrGraphs: colrState.colrGraphs,
    ...buildColrGradientStopsSection(colrState.gradientStopsBytes),
  };
}


// ---------------------------------------------------------------------
// Decoration shapes (<u>, <s>, <mark>).
// ---------------------------------------------------------------------

function colorEq(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function emitDecorationRects(slots, font, ctx, gidBox, bboxBox, flags) {
  const ulY = -font.underlinePosition;
  let ulThick = font.underlineThickness;
  if (!(ulThick > 0)) ulThick = 0.05;
  const strikeY = -0.27;          // 0.27em above baseline (in +Y-down: negative)
  const markTop = -font.ascent;
  const markBot = -font.descent;

  const n = slots.length;
  let i = 0;
  while (i < n) {
    const s0 = slots[i];
    if (!s0.glyphId) { i++; continue; }

    if (flags.mark && s0.style.mark) {
      let j = i;
      while (j + 1 < n) {
        const sj = slots[j + 1];
        if (!sj.style.mark) break;
        if (!colorEq(sj.style.markColor, s0.style.markColor)) break;
        if (Math.abs(sj.penY - s0.penY) > 1e-6) break;
        j++;
      }
      const sN = slots[j];
      const x0 = s0.penX;
      const x1 = sN.penX + sN.advance;
      const yTop = s0.penY + markTop * s0.style.sizeScale - s0.style.voffsetEm;
      const yBot = s0.penY + markBot * s0.style.sizeScale - s0.style.voffsetEm;
      emitRect(x0, yTop, x1, yBot, s0.style.markColor, ctx, gidBox, bboxBox, `mark_${ctx.metas.length}`);
      i = j + 1;
      continue;
    }

    if (flags.underline && s0.style.underline) {
      let j = i;
      // Coalesce runs sharing decoration kind + color + style + thickness.
      const decoColor0 = s0.style.underlineColor || s0.style.color;
      const decoStyle0 = s0.style.underlineStyle || 'solid';
      const decoThick0 = s0.style.underlineThicknessEm || 0;
      while (j + 1 < n) {
        const sj = slots[j + 1];
        if (!sj.style.underline) break;
        const cj = sj.style.underlineColor || sj.style.color;
        const styleJ = sj.style.underlineStyle || 'solid';
        const thickJ = sj.style.underlineThicknessEm || 0;
        if (!colorEq(cj, decoColor0)) break;
        if (styleJ !== decoStyle0) break;
        if (Math.abs(thickJ - decoThick0) > 1e-9) break;
        if (Math.abs(sj.penY - s0.penY) > 1e-6) break;
        j++;
      }
      const sN = slots[j];
      const x0 = s0.penX;
      const x1 = sN.penX + sN.advance;
      const thick = (decoThick0 > 0 ? decoThick0 : ulThick) * s0.style.sizeScale;
      const yTop = s0.penY + ulY * s0.style.sizeScale - s0.style.voffsetEm;
      emitDecoration(decoStyle0, x0, yTop, x1, thick, decoColor0, ctx, gidBox, bboxBox, `underline_${ctx.metas.length}`);
      i = j + 1;
      continue;
    }

    if (flags.strike && s0.style.strikethrough) {
      let j = i;
      const decoColor0 = s0.style.strikeColor || s0.style.color;
      const decoStyle0 = s0.style.strikeStyle || 'solid';
      const decoThick0 = s0.style.strikeThicknessEm || 0;
      while (j + 1 < n) {
        const sj = slots[j + 1];
        if (!sj.style.strikethrough) break;
        const cj = sj.style.strikeColor || sj.style.color;
        const styleJ = sj.style.strikeStyle || 'solid';
        const thickJ = sj.style.strikeThicknessEm || 0;
        if (!colorEq(cj, decoColor0)) break;
        if (styleJ !== decoStyle0) break;
        if (Math.abs(thickJ - decoThick0) > 1e-9) break;
        if (Math.abs(sj.penY - s0.penY) > 1e-6) break;
        j++;
      }
      const sN = slots[j];
      const x0 = s0.penX;
      const x1 = sN.penX + sN.advance;
      const thick = (decoThick0 > 0 ? decoThick0 : ulThick) * s0.style.sizeScale;
      // Strike is mid-line: yTop sits ABOVE the centerline so emitDecoration
      // (which positions style relative to yTop=top-of-stroke) renders
      // the band centered on strikeY.
      const yMid = s0.penY + strikeY * s0.style.sizeScale - s0.style.voffsetEm;
      const yTop = yMid - 0.5 * thick;
      emitDecoration(decoStyle0, x0, yTop, x1, thick, decoColor0, ctx, gidBox, bboxBox, `strike_${ctx.metas.length}`);
      i = j + 1;
      continue;
    }

    i++;
  }
}

function emitRect(x0, yTop, x1, yBot, color, ctx, gidBox, bboxBox, shapeId) {
  if (x1 <= x0 || yBot <= yTop) return;
  const segs = [
    mkLine([x0, yTop], [x1, yTop]),
    mkLine([x1, yTop], [x1, yBot]),
    mkLine([x1, yBot], [x0, yBot]),
    mkLine([x0, yBot], [x0, yTop]),
  ];
  emitShape(ctx, segs, { fillRgba: color, shapeId }, gidBox, bboxBox);
}

/// Dispatch underline/strike emission by style. `thick` is in user
/// space (em × sizeScale already applied by caller). `yTop` is the
/// top edge of the (solid-equivalent) stroke band; styles that
/// move pixels vertically (double, wavy) anchor relative to it.
function emitDecoration(style, x0, yTop, x1, thick, color, ctx, gidBox, bboxBox, shapeId) {
  if (x1 <= x0 || thick <= 0) return;
  const yBot = yTop + thick;
  if (style === 'solid' || !style) {
    emitRect(x0, yTop, x1, yBot, color, ctx, gidBox, bboxBox, shapeId);
    return;
  }
  if (style === 'dashed') {
    // Dash = 4× thick, gap = 2× thick (CSS doesn't specify exact ratios).
    const dash = thick * 4, gap = thick * 2;
    for (let x = x0; x < x1; x += dash + gap) {
      emitRect(x, yTop, Math.min(x + dash, x1), yBot, color, ctx, gidBox, bboxBox, shapeId);
    }
    return;
  }
  if (style === 'dotted') {
    // Each dot is a square `thick × thick`; gap = 1.5× thick.
    const dot = thick, gap = thick * 1.5;
    for (let x = x0; x < x1; x += dot + gap) {
      emitRect(x, yTop, Math.min(x + dot, x1), yBot, color, ctx, gidBox, bboxBox, shapeId);
    }
    return;
  }
  if (style === 'double') {
    // Two thin rects, each 0.4× thick, separated by a 0.4× thick gap.
    // Total band height ≈ 1.2× the original thick (consistent with CSS).
    const t = thick * 0.4;
    emitRect(x0, yTop,                       x1, yTop + t,           color, ctx, gidBox, bboxBox, shapeId);
    emitRect(x0, yTop + t + t,               x1, yTop + t + t + t,   color, ctx, gidBox, bboxBox, shapeId);
    return;
  }
  if (style === 'wavy') {
    // Sine-like band emitted as a chain of cubic Bezier segments.
    // Wavelength ≈ 5× thick; amplitude ≈ 1.5× thick. The wave is
    // built as two parallel curves offset perpendicularly to the
    // tangent direction by half the thickness, then closed with line
    // endcaps. Working in +Y-down, so positive amplitude moves the
    // wave DOWN at peaks. One closed shape per coalesced run.
    const wavelen = Math.max(thick * 5, 0.001);
    const amp = thick * 1.5;
    const yMid = yTop + thick * 0.5;
    const tStrokeHalf = thick * 0.5;
    // Sample wave centerline points + tangents at each quarter wavelength.
    const points = [];
    for (let x = x0; x <= x1 + 1e-6; x += wavelen * 0.25) {
      const t = ((x - x0) / wavelen) * 2 * Math.PI;
      const y = yMid + Math.sin(t) * amp * 0.5;
      // Tangent direction = (1, dy/dx). dy/dx = cos(t) * amp * 0.5 * (2π / wavelen).
      const dy = Math.cos(t) * amp * 0.5 * (2 * Math.PI / wavelen);
      points.push({ x: Math.min(x, x1), y, dy });
      if (x >= x1) break;
    }
    if (points.length < 2) {
      emitRect(x0, yTop, x1, yBot, color, ctx, gidBox, bboxBox, shapeId);
      return;
    }
    // Compute the two offset point arrays. Perpendicular unit
    // normal to tangent (1, dy) is (-dy, 1) / sqrt(1 + dy²); we
    // push out by ±tStrokeHalf.
    const topPts = [];
    const botPts = [];
    for (const p of points) {
      const len = Math.sqrt(1 + p.dy * p.dy);
      const nx = -p.dy / len, ny = 1 / len;
      topPts.push([p.x + nx * tStrokeHalf, p.y + ny * tStrokeHalf]);
      botPts.push([p.x - nx * tStrokeHalf, p.y - ny * tStrokeHalf]);
    }
    // Top curve forward, bottom curve backward, line endcaps. Approximate
    // with line segments between samples (4 per wavelength suffices).
    const segs = [];
    for (let k = 0; k < topPts.length - 1; k++) segs.push(mkLine(topPts[k], topPts[k + 1]));
    segs.push(mkLine(topPts[topPts.length - 1], botPts[botPts.length - 1]));
    for (let k = botPts.length - 1; k > 0; k--) segs.push(mkLine(botPts[k], botPts[k - 1]));
    segs.push(mkLine(botPts[0], topPts[0]));
    emitShape(ctx, segs, { fillRgba: color, shapeId }, gidBox, bboxBox);
    return;
  }
  // Unknown style → fall back to solid.
  emitRect(x0, yTop, x1, yBot, color, ctx, gidBox, bboxBox, shapeId);
}

