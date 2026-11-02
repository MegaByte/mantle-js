// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { emitBitmapGlyphIfPresent, finishBitmapAtlas } from './textBitmap.js';
// textRun.js — string → bundle assembler. Plain-text and rich-text
// (markup parser + styled-span API) entry points plus layout (line wrap,
// alignment, per-line baseline).

import { mkLine, mkQuad, mkCubic } from '../svg/segment.js';
// packMetaBody is bundle-wire plumbing, imported from the module that OWNS it rather than through
// importer.js's re-export. That re-export exists for sibling subsystems like this one, but
// importer.js is a PUBLIC subpath (@kontek/mantle/svg), so anything it re-exports is public too —
// which is how the meta packer and the texel builders ended up on the API surface.
import { packMetaBody } from '../svg/meta.js';
import { makeBuildContext, emitShape } from '../svg/buildContext.js';
import { parseMarkup, defaultStyle } from './markupParser.js';
import { BaseDirection } from './bidiConst.js';
import { layoutSlots } from './textLayout.js';
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

/** @typedef {import('./markupParser.js').Color} Color */
/** @typedef {import('./markupParser.js').Style} Style */
/** @typedef {import('./markupParser.js').Span} Span */
/**
 * @typedef LayoutOptions
 * @property {number} [bitmapPpem] preferred bitmap strike pixels per em (default32)
 * @property {number} [maxWidthEm]
 * @property {number} [tabSize]   CSS tab-size as a number of spaces (default 8): a tab advances to the next multiple of it from the line start
 * @property {number} [tabSizeEm] CSS tab-size as a length, in em; wins over `tabSize`
 * @property {number} [tabOriginEm] how far along its line the first character already sits, in em, for the tab stops (default 0)
 * @property {('left'|'center'|'right'|'justify')} [align]
 * @property {('auto'|'left'|'center'|'right'|'justify')} [lastLineAlign] Final-line alignment; auto keeps paragraph alignment.
 * @property {number} [lineHeightEm]
 * @property {number} [originX]   vertical modes only: user-space origin the
 *   laid-out block is placed against (0 when absent)
 * @property {number} [originY]
 * @property {Record<string, number>|number[]|null} [varCoords]  variable-font axis
 *   coordinates in native axis units. Arrays follow font axis order; objects
 *   use axis tags. Null uses the font defaults.
 * @property {Record<string, boolean>} [features]         OpenType opt-in
 *   GSUB feature tags (e.g. `{ tnum: true, lnum: true, ss01: true }`).
 *   Each truthy entry runs that feature's lookup chain over the per-
 *   font glyph runs via `gsub.applyFeatureToSeq`. `smcp` here is
 *   equivalent to the `<smallcaps>` markup tag / `style.smallCaps`.
 *   Unknown / unsupported tags no-op silently.
 * @property {string} [language]   OpenType language system tag for the
 *   text (e.g. `'MAR '` Marathi, `'URD '` Urdu, `'TRK '` Turkish).
 *   Four characters, space padded; shorter strings are padded and
 *   uppercased. Features come from that language system inside the
 *   run's script, and from the script's default language system when
 *   it isn't there — what HarfBuzz does with `hb_buffer_set_language`.
 * @property {('spec'|'harfbuzz')} [compat]  `'spec'` (default) follows the specifications; `'harfbuzz'` reproduces HarfBuzz where it
 *   departs from them (AAT `trak` tracking at `ptem`, 12 pt when unset).
 * @property {number} [ptem]   point size `compat: 'harfbuzz'` reads `trak` at
 * @property {boolean} [preferAat]  A font that has both AAT tables (`morx`/`mort`, `kerx`) and OpenType ones (GSUB, GPOS) is shaped
 *   with the AAT ones (default true; `false` keeps GSUB/GPOS; `compat: 'harfbuzz'` uses HarfBuzz's table priorities).
 * @property {boolean} [useJstf]  Use the font's JSTF priorities when justifying (default true; needs the JSTF reader registered,
 *   which the `font` barrel and `autoRegisterForFont` do).
 * @property {Set<string>|string[]} [disabledFeatures]    OpenType
 *   default-on tags to suppress: `kern` skips optional pair/contextual kerning
 *   and GPOS advance adjustments; required positioning and mark attachment remain.
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
 */

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
  // color.slice() widens the 4-tuple to number[]; keep it a Color.
  const style = { ...defaultStyle(), color: /** @type {Color} */ ([...color]) };
  return await buildStyled([{ text: text ?? '', style }], font, {});
}

function styledSlots(spans, font, layout, trackSourceClusters = false, lineRanges = null) {
  const writingMode = normalizeWritingMode(layout.writingMode);
  const vertical = writingMode !== 'horizontal-tb';
  const orientation = normalizeTextOrientation(layout.textOrientation);
  const slotLayout = vertical
    ? { ...layout, originX: 0, originY: 0, inlineVertical: orientation }
    : layout;
  const slots = layoutSlots(spans, font, slotLayout, trackSourceClusters, lineRanges);
  return vertical
    ? applyVerticalLayout(
        slots,
        font,
        orientation,
        writingMode,
        layout.originX || 0,
        layout.originY || 0,
        layout.varCoords || null,
      )
    : slots;
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
  const lineRanges = [];
  const slots = styledSlots(spans, font, layout, false, lineRanges);
  return await assembleBundle(slots, font, layout.varCoords || null, layout, lineRanges);
}

// Ranges preserve empty lines without adding glyphs or changing source clusters.
function lineWidthsOf(slots, lineRanges) {
  return lineRanges.map(({ start, end }) => {
    let width = 0;
    for (let i = start; i < end; i++) width = Math.max(width, slots[i].penX + slots[i].advance);
    return width;
  });
}

/**
 * Parse markup, then build.
 * @param {string} markup
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {Color} [defaultColor]
 * @param {LayoutOptions} [layout]
 */
export async function buildFromMarkup(markup, font, defaultColor = [0, 0, 0, 1], layout = {}) {
  // Same tuple-widening as buildTextRun: keep color a Color, not number[].
  const base = { ...defaultStyle(), color: /** @type {Color} */ ([...defaultColor]) };
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
 * All values are in em-space, +Y down. Empty spans have zero extent and
 * no lines, with initialized font metrics.
 *
 * @param {Span[]} spans
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export function measureText(spans, font, layout = {}) {
  if (!font) throw new Error('font is required');
  spans = spans || [];
  if (spans.length === 0) font.getMetrics(0x20);
  const lineRanges = [];
  const slots = spans.length ? layoutSlots(spans, font, layout, false, lineRanges) : [];
  const metrics = layout.varCoords != null ? font.getMetricsVar(layout.varCoords) : font;
  if (spans.length === 0) {
    return {
      width: 0,
      height: 0,
      ascent: metrics.ascent,
      descent: -metrics.descent,
      lineHeight:
        layout.lineHeightEm > 0
          ? layout.lineHeightEm
          : metrics.ascent - metrics.descent + metrics.lineGap,
      lineCount: 0,
      maxLineWidth: 0,
      lineWidths: [],
    };
  }

  const lineWidths = lineWidthsOf(slots, lineRanges);
  const nLines = lineRanges.length;

  let maxLineWidth = 0;
  for (const w of lineWidths) if (w > maxLineWidth) maxLineWidth = w;

  const ascent = metrics.ascent;
  const descent = -metrics.descent; // metrics.descent is negative
  const lineHeight =
    layout.lineHeightEm > 0
      ? layout.lineHeightEm
      : metrics.ascent - metrics.descent + metrics.lineGap;
  const height = nLines > 0 ? ascent + descent + lineRanges[nLines - 1].y - lineRanges[0].y : 0;

  return {
    width: maxLineWidth,
    height,
    ascent,
    descent,
    lineHeight,
    lineCount: nLines,
    maxLineWidth,
    lineWidths,
  };
}

/**
 * measureText with markup parsing — mirror of buildFromMarkup.
 */
/**
 * @param {string} markup
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export function measureFromMarkup(markup, font, layout = {}) {
  const spans = parseMarkup(markup ?? '', defaultStyle());
  return measureText(spans, font, layout);
}

/**
 * Per-glyph layout geometry for styled spans, in visual order. Uses the
 * same shaping and vertical placement as buildStyled without emitting
 * coverage geometry. Coordinates are in em-space, with +Y down.
 *
 *   {
 *     glyphs: [{
 *       penX,            // glyph origin X
 *       penY,            // glyph origin Y
 *       advance,         // advance along the horizontal or vertical inline axis
 *       cluster,         // logical UTF-16 cluster offset in concatenated span text
 *       codepoint,       // unicode scalar (0x20 == space)
 *     }, ...],
 *     ascent, descent,   // font ascent / -descent (descent <= 0)
 *     lineHeight,        // baseline-to-baseline step
 *     lineCount,
 *   }
 *
 * `cluster` maps a logical source position to its visual glyph record.
 * Positions and advances include font selection, style sizing, shaping and
 * writing mode. Empty spans return no glyphs and initialized font metrics.
 *
 * @param {Span[]} spans
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {LayoutOptions} [layout]
 */
export function measureGlyphs(spans, font, layout = {}) {
  if (!font) throw new Error('font is required');
  spans = spans || [];
  font.getMetrics(0x20);
  const metrics = layout.varCoords != null ? font.getMetricsVar(layout.varCoords) : font;
  const ascent = metrics.ascent;
  const descent = -metrics.descent; // metrics.descent is negative
  const lineHeight =
    layout.lineHeightEm > 0
      ? layout.lineHeightEm
      : metrics.ascent - metrics.descent + metrics.lineGap;
  if (spans.length === 0) {
    return { glyphs: [], ascent, descent, lineHeight, lineCount: 0 };
  }
  const lineRanges = [];
  const slots = styledSlots(spans, font, layout, true, lineRanges);

  const glyphs = new Array(slots.length);
  const lineCount = lineRanges.length;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const cp = s.codepoint | 0;
    const cluster = /** @type {number} */ (s.sourceCluster);
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

/// Treat font-weight per CSS Fonts Level 4: 600+ (or 'bold' / 'bolder')
/// is bold. Strings parse to numbers; unrecognized values are normal.
/// Exported so textSections maps its `style.weight` by the same rule
/// rather than inventing a second one.
export function isBoldWeight(v) {
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
 * @param {object[]|null} [fallbacks]  fonts consulted, in order, for a
 *   codepoint the primary font has no glyph for
 * @param {number} [maxWidthEm]  0 = unbounded; otherwise the advance budget
 *   in EM units that layout may consume
 * @param {object|null} [styleOpts]  see the styleOpts note above
 * @returns {{ glyphs: { segs: object[], codepoint: number }[],
 *             advance: number,
 *             writingMode: 'horizontal-tb'|'vertical-rl'|'vertical-lr',
 *             textOrientation: string }}
 *   glyphs is one entry per emitted glyph (skipping whitespace +
 *   missing glyphs); each entry's segs is ready for pathBbox /
 *   buildTexturesShape. advance is the final pen position relative
 *   to x in EM units (multiply by fontSize for user-space).
 *   writingMode / textOrientation echo the resolved layout direction so a
 *   caller placing the result does not have to re-derive them.
 */
export function buildSvgTextGlyphs(
  text,
  font,
  x,
  y,
  fontSize,
  fallbacks = null,
  maxWidthEm = 0,
  styleOpts = null,
) {
  if (!font) throw new Error('font is required');
  const t = text ?? '';
  if (!t) {
    return {
      glyphs: [],
      advance: 0,
      writingMode: normalizeWritingMode(styleOpts && styleOpts.writingMode),
      textOrientation: normalizeTextOrientation(styleOpts && styleOpts.textOrientation),
    };
  }
  // Variant font selection. When the caller wired a matching variant
  // (boldFont / italicFont / boldItalicFont) use it; otherwise fall back
  // to synthesis — italic via 12° shear, bold via stroke inflation at
  // ~4% em on top of the fill paint (CSS `font-synthesis: weight style`,
  // the browser default).
  let useFont = font;
  let synthBold = false;
  let synthItalic = false;
  if (styleOpts) {
    const wantBold = isBoldWeight(styleOpts.fontWeight);
    const wantItalic = isItalicStyle(styleOpts.fontStyle);
    const vf = styleOpts.variantFonts || null;
    if (wantBold && wantItalic) {
      if (vf && vf.boldItalicFont) useFont = vf.boldItalicFont;
      else if (vf && vf.boldFont) {
        useFont = vf.boldFont;
        synthItalic = true;
      } else if (vf && vf.italicFont) {
        useFont = vf.italicFont;
        synthBold = true;
      } else {
        synthBold = true;
        synthItalic = true;
      }
    } else if (wantBold) {
      if (vf && vf.boldFont) useFont = vf.boldFont;
      else synthBold = true;
    } else if (wantItalic) {
      if (vf && vf.italicFont) useFont = vf.italicFont;
      else synthItalic = true;
    }
    // Per-style escape hatch: styleOpts.synthesizeBold/Italic === false
    // disables synthesis (matches CSS `font-synthesis: none`).
    if (styleOpts.synthesizeBold === false) synthBold = false;
    if (styleOpts.synthesizeItalic === false) synthItalic = false;
  }
  const baseStyle = defaultStyle();
  // Carry letter-spacing / word-spacing through to the span style using
  // the fields layoutSlots actually reads: cspaceEm adds per glyph,
  // wspaceEm adds on word separators. (layoutSlots reads no field named
  // letterSpacing/wordSpacing.)
  if (styleOpts) {
    if (typeof styleOpts.letterSpacingEm === 'number')
      baseStyle.cspaceEm = styleOpts.letterSpacingEm;
    if (typeof styleOpts.wordSpacingEm === 'number') baseStyle.wspaceEm = styleOpts.wordSpacingEm;
    // CSS font-variant: small-caps selects the smcp substitution.
    if (/(^|\s)small-caps(\s|$)/i.test(String(styleOpts.fontVariant ?? '')))
      baseStyle.smallCaps = true;
  }
  const spans = [{ text: t, style: baseStyle }];
  // maxWidthEm > 0 triggers word-wrap (used by <textArea>); 0 = single line.
  const layoutOpts = {};
  if (fallbacks) layoutOpts.fallbacks = fallbacks;
  if (maxWidthEm > 0) layoutOpts.maxWidthEm = maxWidthEm;
  if (styleOpts) {
    // CSS direction is the paragraph's base direction; absent keeps UAX #9 auto detection.
    const dir = String(styleOpts.direction ?? '')
      .trim()
      .toLowerCase();
    if (dir === 'rtl') layoutOpts.baseDirection = BaseDirection.Rtl;
    else if (dir === 'ltr') layoutOpts.baseDirection = BaseDirection.Ltr;
    // CSS tab-size: a number of spaces, or (tabSizeEm) a length in em of the font size.
    if (typeof styleOpts.tabSize === 'number' && styleOpts.tabSize >= 0)
      layoutOpts.tabSize = styleOpts.tabSize;
    if (typeof styleOpts.tabSizeEm === 'number' && styleOpts.tabSizeEm > 0)
      layoutOpts.tabSizeEm = styleOpts.tabSizeEm;
    if (typeof styleOpts.tabOriginEm === 'number') layoutOpts.tabOriginEm = styleOpts.tabOriginEm;
    // CSS font-feature-settings: a nonzero value opts a feature in, 0 / off opts the default-on ones out.
    const feat = parseFontFeatureSettings(styleOpts.fontFeatureSettings);
    if (feat) {
      if (feat.on.length)
        layoutOpts.features = Object.fromEntries(feat.on.map((tag) => [tag, true]));
      if (feat.off.length) layoutOpts.disabledFeatures = new Set(feat.off);
    }
  }
  const slots = layoutSlots(spans, useFont, layoutOpts);
  // Synth-italic shear amount. CSS uses -12°; the negative sign
  // is so the TOP of the glyph leans RIGHT (the visual italic
  // direction), since OT +Y is UP and SVG +Y is DOWN.
  const shearTan = synthItalic ? Math.tan((12 * Math.PI) / 180) : 0;
  // Synth-bold stroke half-width (stroke paints both sides of the path):
  // 0.04 em ≈ 8% visual bolding at typical text size.
  const synthBoldSwEm = synthBold ? 0.04 : 0;

  const writingMode = normalizeWritingMode(styleOpts && styleOpts.writingMode);
  const textOrient = normalizeTextOrientation(styleOpts && styleOpts.textOrientation);
  const vertical = writingMode !== 'horizontal-tb';
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

/// `"smcp" 1, 'liga' off, tnum` -> { on: [tags], off: [tags] }; null for `normal`, nothing or no valid tag.
function parseFontFeatureSettings(v) {
  if (v == null) return null;
  const text = String(v).trim();
  if (!text || /^normal$/i.test(text)) return null;
  const on = [],
    off = [];
  for (const part of text.split(',')) {
    const m = /^\s*(["'])([\x20-\x7e]{4})\1\s*(on|off|\d+)?\s*$/i.exec(part);
    if (!m) continue;
    const val =
      m[3] == null || /^on$/i.test(m[3]) ? 1 : /^off$/i.test(m[3]) ? 0 : parseInt(m[3], 10);
    (val ? on : off).push(m[2]);
  }
  return on.length || off.length ? { on, off } : null;
}

// Internal export: inspect per-slot positions without running the full
// bundle assembly. Not part of the public API.
export function _layoutSlotsForTest(spans, font, layout) {
  return layoutSlots(spans, font, layout);
}

// ---------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------

/// Cover-fan hulls per font, relative to each glyph's origin, kept across bundles so a text rebuild reuses them. At most 4096 per font (a few floats each); past that the map starts over.
const _coverFanHulls = new WeakMap();
function coverFanHullsOf(font) {
  let m = _coverFanHulls.get(font);
  if (!m || m.size > 4096) _coverFanHulls.set(font, (m = new Map()));
  return m;
}

async function assembleBundle(slots, font, varCoords = null, layout = null, lineRanges = []) {
  // AAC band levels: text is where a shape is drawn a few pixels tall, which is what they bound.
  const ctx = makeBuildContext({
    curve64: false,
    gwnTree: !!(layout && layout.gwnTree),
    aacLevels: !(layout && layout.aacLevels === false),
  });
  const decorationMetrics = varCoords != null ? font.getMetricsVar(varCoords) : font;
  const fillNoopByFont = new Map();
  const fillNoopStatusOf = (slotFont) => {
    let status = fillNoopByFont.get(slotFont);
    if (!status) fillNoopByFont.set(slotFont, (status = new Map()));
    return status;
  };
  const varKey =
    varCoords != null
      ? JSON.stringify(varCoords, (_, v) =>
          typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
        )
      : ''; // (JSON would write every non-finite axis value as null: +Infinity and -Infinity, two outlines, one key)
  const gidBox = { next: 1 };
  const bboxBox = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  const lineCount = lineRanges.length;
  const firstBaselineY = lineCount ? lineRanges[0].y : 0;
  const lastBaselineY = lineCount ? lineRanges[lineCount - 1].y : 0;
  const lineWidths = lineWidthsOf(slots, lineRanges);
  const lastLineAdvance = lineCount ? lineWidths[lineCount - 1] : 0;
  const colrState = createColrEmitState();

  emitDecorationRects(slots, decorationMetrics, ctx, gidBox, bboxBox, {
    mark: true,
    underline: false,
    strike: false,
  });

  let idx = 0;
  for (const slot of slots) {
    if (slot.ignorable) {
      idx++;
      continue;
    }
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
      ? slotFont.italicAngle !== 0
        ? slotFont.italicAngle
        : SYNTH_ITALIC_DEG
      : 0;
    const shearTan = shearDeg !== 0 ? Math.tan((-shearDeg * Math.PI) / 180) : 0;
    const synthBoldSwEm = slot.synthBold ? 0.04 : 0;
    const cpHex = slot.codepoint.toString(16).toUpperCase().padStart(4, '0');

    if (await emitSvgInOtGlyphIfPresent(slot, slotFont, ox, oy, sx, sy, ctx, bboxBox)) {
      idx++;
      continue;
    }

    if (
      emitColrV1GlyphIfPresent(
        slot,
        slotFont,
        varCoords,
        ctx,
        gidBox,
        bboxBox,
        colrState,
        ox,
        oy,
        sx,
        sy,
        rotDeg,
        idx,
        cpHex,
      )
    ) {
      idx++;
      continue;
    }

    if (
      emitColrV0GlyphIfPresent(
        slot,
        slotFont,
        ctx,
        gidBox,
        bboxBox,
        ox,
        oy,
        sx,
        sy,
        rotDeg,
        idx,
        cpHex,
        varCoords,
      )
    ) {
      idx++;
      continue;
    }

    if (slotFont.hasBitmaps) {
      const bitmapPpem =
        (layout && layout.bitmapPpem > 0 ? layout.bitmapPpem : 32) *
        slot.style.sizeScale *
        glyphScale *
        Math.max(1, widthScale);
      if (
        await emitBitmapGlyphIfPresent(
          slot,
          slotFont,
          ctx,
          gidBox,
          bboxBox,
          ox,
          oy,
          sx,
          sy,
          rotDeg,
          shearTan,
          `glyph_${idx}_U${cpHex}_bitmap`,
          bitmapPpem,
        )
      ) {
        idx++;
        continue;
      }
    }

    if (slot.mathAssembly && slot.mathAssembly.asm.parts.length > 0) {
      const partList = slot.mathAssembly.asm.parts;
      const axis = slot.mathAssembly.axis;
      const upemInv = slotInvUpem;
      for (let pi = 0; pi < partList.length; pi++) {
        const part = partList[pi];
        const pSrc = slotFont.getGlyphSegsByGidVar(part.glyphID, varCoords);
        if (!pSrc || pSrc.length === 0) continue;
        const partEmOff =
          part.offset *
          upemInv *
          slot.style.sizeScale *
          (slot.style.glyphScale > 0 ? slot.style.glyphScale : 1);
        let partOx = ox,
          partOy = oy;
        if (axis === 'v') {
          partOy = oy - partEmOff;
        } else {
          partOx = ox + partEmOff;
        }
        const partSegs = transformAndFlip(pSrc, partOx, partOy, sx, sy, rotDeg, shearTan);
        emitOutlineGlyph(
          ctx,
          gidBox,
          bboxBox,
          partSegs,
          slot.style.color,
          `glyph_${idx}_u${cpHex}_asm${pi}`,
          synthBoldSwEm,
        );
      }
      idx++;
      continue;
    }

    const src = slotFont.getGlyphSegsByGidVar(slot.glyphId, varCoords);
    if (!src || src.length === 0) {
      idx++;
      continue;
    }
    const segs = transformAndFlip(src, ox, oy, sx, sy, rotDeg, shearTan);
    // (every copy of a glyph at one scale has the same cover-fan hull, translated: a passage re-flowed in play spent 40% of its rebuild recomputing them, svg/mesh.js getCoverFanVerts)
    ctx.coverFanShare = {
      cache: coverFanHullsOf(slotFont),
      key: `${slot.glyphId}|${sx}|${sy}|${rotDeg}|${shearTan}|${varKey}`,
      tx: ox,
      ty: oy,
    };
    emitOutlineGlyph(
      ctx,
      gidBox,
      bboxBox,
      segs,
      slot.style.color,
      `glyph_${idx}_u${cpHex}`,
      synthBoldSwEm,
      fillNoopStatusOf(slotFont),
      slot.glyphId,
    );
    ctx.coverFanShare = null;
    idx++;
  }

  emitDecorationRects(slots, decorationMetrics, ctx, gidBox, bboxBox, {
    mark: false,
    underline: true,
    strike: true,
  });

  const numShapes = ctx.metas.length;
  if (numShapes === 0) {
    bboxBox.xmin = bboxBox.ymin = bboxBox.xmax = bboxBox.ymax = 0;
  }
  let { xmin, ymin, xmax, ymax } = bboxBox;
  if (
    !Number.isFinite(xmin) ||
    !Number.isFinite(ymin) ||
    !Number.isFinite(xmax) ||
    !Number.isFinite(ymax) ||
    xmax < xmin ||
    ymax < ymin
  ) {
    xmin = Number.isFinite(xmin) ? xmin : 0;
    ymin = Number.isFinite(ymin) ? ymin : 0;
    xmax = Number.isFinite(xmax) && xmax >= xmin ? xmax : xmin;
    ymax = Number.isFinite(ymax) && ymax >= ymin ? ymax : ymin;
  }

  const curveTexels = new Float32Array(ctx.curveBuf.count * 4);
  for (let i = 0; i < ctx.curveBuf.count * 4; i++) curveTexels[i] = ctx.curveBuf.floats[i];
  const bandTexels = new Float32Array(ctx.bandBuf.count * 4);
  for (let i = 0; i < ctx.bandBuf.count * 4; i++) bandTexels[i] = ctx.bandBuf.floats[i];
  const bitmapAtlas = finishBitmapAtlas(ctx);
  const metaBytes = packMetaBody(ctx.metas);
  const metaFloats = new Float32Array(
    metaBytes.buffer,
    metaBytes.byteOffset,
    metaBytes.byteLength >>> 2,
  );
  const curveGeomFloats = new Float32Array(ctx.hybridFloats);
  const resources = ctx._svgTextResources || {};
  const colrStops = buildColrGradientStopsSection(colrState.gradientStopsBytes);
  const svgStops = resources.gradientStops;
  let gradientStops = svgStops || colrStops.gradientStops;
  let gradientStopsCount = (resources.gradientStopsCount || 0) + colrStops.gradientStopsCount;
  if (svgStops && colrStops.gradientStops) {
    const joined = new Uint8Array(svgStops.byteLength + colrStops.gradientStops.byteLength);
    joined.set(new Uint8Array(svgStops));
    joined.set(new Uint8Array(colrStops.gradientStops), svgStops.byteLength);
    gradientStops = joined.buffer;
    const offset = resources.gradientStopsCount || 0;
    for (const entry of colrState.colrGraphs)
      for (const node of entry.graph.nodes)
        if (node.params?.stopsCount > 0) node.params.stopsOffset += offset;
  }
  const shapeHrefs = resources.shapeHrefs
    ? Array.from({ length: ctx.metas.length }, (_, i) => resources.shapeHrefs[i] || '')
    : null;
  const fontMetricsSnapshot =
    font && typeof font.fontMetrics === 'function' ? font.fontMetrics(varCoords) : null;
  return {
    ...resources,
    version: 3,
    numShapes,
    flags: 1 | 2 | 4,
    // Union of curve types across every glyph. A TrueType face is quadratics
    // only; a CFF face cubics only. Lets both walkers compile the unused kernels
    // out (see fillPass typeOmit) — occupancy, not work.
    segTypeMask: ctx.segTypeMask | 0,
    totalSegments: ctx.totalSegments | 0,
    metaFloatsPerShape: 48,
    globalBBox: [xmin, ymin, xmax - xmin, ymax - ymin],
    fontMetrics: fontMetricsSnapshot,
    firstBaselineY,
    lastBaselineY,
    lineCount,
    lastLineAdvance,
    viewBox: [0, 0, 0, 0],
    preserveAspectRatio: [1, 1, 0],
    curveTexels,
    bandTexels,
    metaFloats,
    authoredBandsByShape: ctx.authoredBandsByShape,
    fillNormByShape: ctx.fillNormByShape,
    curveGeomFloats,
    ...bitmapAtlas,
    bitmapGlyphs: ctx.bitmapGlyphs || null,
    parentShapeIdx: new Int32Array(ctx.parents),
    shapeIds: ctx.shapeIds,
    shapeHrefs,
    curveRangesByShape: (function () {
      const n = ctx.metas.length;
      const out = new Array(n);
      const totalF = ctx.curveBuf.count * 4;
      for (let i = 0; i < n; i++) out[i] = { begin: ctx.metas[i]._curveStartF | 0, end: 0 };
      for (let i = 0; i < n - 1; i++) out[i].end = out[i + 1].begin;
      if (n > 0) out[n - 1].end = totalF;
      for (let i = 0; i < n; i++)
        if (ctx.metas[i]._curveEndF !== undefined) out[i].end = ctx.metas[i]._curveEndF;
      return out;
    })(),
    colrGraphs: colrState.colrGraphs,
    colrHit: colrHitSection(colrState),
    gradientStops,
    gradientStopsCount,
  };
}

/// The COLRv1 hit table (see emitColrV1GlyphIfPresent): mask-only rows the pointer can hit, each answering as the
/// glyph's primary row, and primary rows that answer nothing because the paint graph never draws them. Null when
/// the run has no COLRv1 glyph, so ordinary text bundles are unchanged.
function colrHitSection(colrState) {
  const h = colrState.hit;
  if (!h || (h.include.length === 0 && h.exclude.length === 0)) return null;
  const rows = new Int32Array(h.include.length >> 1),
    owner = new Int32Array(h.include.length >> 1);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = h.include[2 * i];
    owner[i] = h.include[2 * i + 1];
  }
  const out = { rows, owner, exclude: Int32Array.from(h.exclude) };
  // Rows that answer only inside ClipList boxes: [row, [[clip rows of one use], ...], ...]; absent when no box cuts a silhouette.
  if (h.clips && h.clips.length) out.clips = h.clips.slice();
  return out;
}

// ---------------------------------------------------------------------
// Decoration shapes (<u>, <s>, <mark>).
// ---------------------------------------------------------------------

function colorEq(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function emitDecorationRects(slots, metrics, ctx, gidBox, bboxBox, flags) {
  const ulY = -metrics.underlinePosition;
  let ulThick = metrics.underlineThickness;
  if (!(ulThick > 0)) ulThick = 0.05;
  // OS/2 yStrikeoutPosition is the TOP of the stroke above the baseline (+Y-down: negative); yStrikeoutSize its thickness.
  const strikeThick = metrics.strikeoutSize > 0 ? metrics.strikeoutSize : ulThick;
  const strikeTop =
    metrics.strikeoutSize > 0 ? -metrics.strikeoutPosition : -0.27 - 0.5 * strikeThick;
  const markTop = -metrics.ascent;
  const markBot = -metrics.descent;

  const n = slots.length;
  // Decoration runs coalesce per LINE; penY varies per glyph because
  // GPOS mark-attach dy survives emission (a combining mark must not
  // split its base's underline).
  const lnY = (s) => (s.lineY !== undefined ? s.lineY : s.penY);
  let i = 0;
  while (i < n) {
    const s0 = slots[i];
    if (!s0.glyphId) {
      i++;
      continue;
    }

    if (flags.mark && s0.style.mark) {
      let j = i;
      while (j + 1 < n) {
        const sj = slots[j + 1];
        if (!sj.style.mark) break;
        if (!colorEq(sj.style.markColor, s0.style.markColor)) break;
        if (Math.abs(lnY(sj) - lnY(s0)) > 1e-6) break;
        j++;
      }
      const sN = slots[j];
      const x0 = s0.penX;
      const x1 = sN.penX + sN.advance;
      const yTop = lnY(s0) + markTop * s0.style.sizeScale - s0.style.voffsetEm;
      const yBot = lnY(s0) + markBot * s0.style.sizeScale - s0.style.voffsetEm;
      emitRect(
        x0,
        yTop,
        x1,
        yBot,
        s0.style.markColor,
        ctx,
        gidBox,
        bboxBox,
        `mark_${ctx.metas.length}`,
      );
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
        if (Math.abs(lnY(sj) - lnY(s0)) > 1e-6) break;
        j++;
      }
      const sN = slots[j];
      const x0 = s0.penX;
      const x1 = sN.penX + sN.advance;
      const thick = (decoThick0 > 0 ? decoThick0 : ulThick) * s0.style.sizeScale;
      const yTop = lnY(s0) + ulY * s0.style.sizeScale - s0.style.voffsetEm;
      emitDecoration(
        decoStyle0,
        x0,
        yTop,
        x1,
        thick,
        decoColor0,
        ctx,
        gidBox,
        bboxBox,
        `underline_${ctx.metas.length}`,
      );
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
        if (Math.abs(lnY(sj) - lnY(s0)) > 1e-6) break;
        j++;
      }
      const sN = slots[j];
      const x0 = s0.penX;
      const x1 = sN.penX + sN.advance;
      const thick = (decoThick0 > 0 ? decoThick0 : strikeThick) * s0.style.sizeScale;
      // An explicit thickness keeps the stroke centered where the font's own stroke is.
      const yTop =
        lnY(s0) +
        (strikeTop + 0.5 * strikeThick - 0.5 * (decoThick0 > 0 ? decoThick0 : strikeThick)) *
          s0.style.sizeScale -
        s0.style.voffsetEm;
      emitDecoration(
        decoStyle0,
        x0,
        yTop,
        x1,
        thick,
        decoColor0,
        ctx,
        gidBox,
        bboxBox,
        `strike_${ctx.metas.length}`,
      );
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
    const dash = thick * 4,
      gap = thick * 2;
    for (let x = x0; x < x1; x += dash + gap) {
      emitRect(x, yTop, Math.min(x + dash, x1), yBot, color, ctx, gidBox, bboxBox, shapeId);
    }
    return;
  }
  if (style === 'dotted') {
    // Each dot is a square `thick × thick`; gap = 1.5× thick.
    const dot = thick,
      gap = thick * 1.5;
    for (let x = x0; x < x1; x += dot + gap) {
      emitRect(x, yTop, Math.min(x + dot, x1), yBot, color, ctx, gidBox, bboxBox, shapeId);
    }
    return;
  }
  if (style === 'double') {
    // Two thin rects, each 0.4× thick, separated by a 0.4× thick gap.
    // Total band height ≈ 1.2× the original thick (consistent with CSS).
    const t = thick * 0.4;
    emitRect(x0, yTop, x1, yTop + t, color, ctx, gidBox, bboxBox, shapeId);
    emitRect(x0, yTop + t + t, x1, yTop + t + t + t, color, ctx, gidBox, bboxBox, shapeId);
    return;
  }
  if (style === 'wavy') {
    // Sine-like band approximated with line segments (sampled every
    // quarter wavelength). Wavelength ≈ 5× thick; amplitude ≈ 1.5×
    // thick. The wave is built as two parallel polylines offset
    // perpendicularly to the tangent direction by half the thickness,
    // then closed with line endcaps. Working in +Y-down, so positive
    // amplitude moves the wave DOWN at peaks. One closed shape per
    // coalesced run.
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
      const dy = Math.cos(t) * amp * 0.5 * ((2 * Math.PI) / wavelen);
      points.push({ x: Math.min(x, x1), y, dy });
      if (x >= x1) break;
    }
    if (points.length < 2) {
      emitRect(x0, yTop, x1, yBot, color, ctx, gidBox, bboxBox, shapeId);
      return;
    }

    const topPts = [];
    const botPts = [];
    for (const p of points) {
      const len = Math.sqrt(1 + p.dy * p.dy);
      const nx = -p.dy / len,
        ny = 1 / len;
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
