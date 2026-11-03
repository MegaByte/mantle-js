// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textLayout.js — line wrap, alignment, bidi itemization hooks.

import { BaseDirection } from './bidiConst.js';
import { getBidi } from './bidiRegistry.js';
import { noteScriptNeeds } from './scriptNeeds.js';
import { normalizeNFC, segmentGraphemes, segmentWordStarts } from './unicodeRegistry.js';
import { mirror, hasMirror } from './unicode/mirror.js';
import { emojiPresentationDefault } from './unicode/emoji.js';
import {
  getArabicShaping,
  getHangulShaping,
  getMathStretchy,
  getIndicShaping,
  getThaiShaping,
  getUseShaping,
  getOtScriptTags,
} from './shaperRegistry.js';
import { isDefaultIgnorable } from './defaultIgnorable.js';

import {
  isCjkOrUprightCodepoint,
  planKashida,
  resolveGlyph,
  resolveGlyphWithSelector,
  isVariationSelector,
} from './textBreak.js';
import { lineBreakActions, PROHIBITED } from './unicode/lineBreak.js';
import { justifyLineWithJstf, installJstf } from './justifyJstf.js';
import { tableDropCount } from './fontTableGuard.js';

/// Copy long spans without converting their elements into function-call arguments.
function _replaceInPlace(dst, src) {
  dst.length = src.length;
  for (let i = 0; i < src.length; i++) dst[i] = src[i];
}

/// The font for an emoji sequence (a cluster with VS16, a keycap or a ZWJ):
/// the first font of the chain that maps every visible codepoint and, for
/// VS16, either defines the (base, VS16) variant or carries color glyphs.
/// Null leaves the ordinary first-codepoint resolution in charge.
function _emojiSequenceFont(cps, primary, fallbacks) {
  let vs16 = false,
    marked = false;
  for (const c of cps) {
    if (c === 0xfe0f) vs16 = marked = true;
    else if (c === 0x20e3 || c === 0x200d) marked = true;
  }
  if (!marked) return null;
  const covers = (f) => {
    for (const c of cps) {
      if (c === 0x200d || c === 0x200c || isVariationSelector(c)) continue;
      if (f.codepointToGlyphId(c) === 0) return false;
    }
    return true;
  };
  const wantsEmoji = (f) =>
    !vs16 ||
    f.hasColor ||
    f.hasBitmaps ||
    f.hasSvgGlyphs ||
    f.hasColrV1 ||
    (f.hasVariationSelectors && f.codepointToVariationGlyphId(cps[0], 0xfe0f) !== 0);
  if (covers(primary) && wantsEmoji(primary)) return primary;
  for (const f of fallbacks) if (f && f !== primary && covers(f) && wantsEmoji(f)) return f;
  return null;
}

/// Shape checks for a span that carries text: a clean error here instead of a
/// TypeError deep in shaping or a NaN in the bundle geometry.
function _validateSpan(span, index) {
  if (typeof span.text !== 'string')
    throw new TypeError(`layout: spans[${index}].text must be a string, got ${typeof span.text}`);
  const style = span.style;
  if (style === null || typeof style !== 'object')
    throw new TypeError(`layout: spans[${index}].style must be an object (see defaultStyle())`);
  if (!Number.isFinite(style.sizeScale))
    throw new RangeError(
      `layout: spans[${index}].style.sizeScale must be a finite number, got ${style.sizeScale}`,
    );
  if (!Number.isFinite(style.voffsetEm))
    throw new RangeError(
      `layout: spans[${index}].style.voffsetEm must be a finite number, got ${style.voffsetEm}`,
    );
}

/// Per-cluster NFC, after HarfBuzz: a lone codepoint the font maps itself (U+2000,
/// the ohm sign, a CJK compatibility ideograph) keeps its own glyph; a sequence
/// whose composed form no font maps stays decomposed when some part of it draws,
/// so the base, its marks and any ccmp lookup still resolve.
function _keepUncomposed(cluster, composed, primary, fallbacks) {
  if (cluster.length === 1 || (cluster.length === 2 && cluster.codePointAt(0) > 0xffff))
    return _chainMaps(cluster.codePointAt(0), primary, fallbacks);
  return (
    !_hasGlyphInChain(composed, primary, fallbacks) && _anyGlyphInChain(cluster, primary, fallbacks)
  );
}

/// Whether any font in the chain maps the first codepoint of `text` to a glyph.
function _hasGlyphInChain(text, primary, fallbacks) {
  return _chainMaps(text.codePointAt(0), primary, fallbacks);
}

/// Whether any font in the chain maps at least one codepoint of `text`.
function _anyGlyphInChain(text, primary, fallbacks) {
  for (const ch of text) if (_chainMaps(ch.codePointAt(0), primary, fallbacks)) return true;
  return false;
}

function _chainMaps(cp, primary, fallbacks) {
  if (primary.codepointToGlyphId(cp) !== 0) return true;
  if (fallbacks) for (const f of fallbacks) if (f.codepointToGlyphId(cp) !== 0) return true;
  return false;
}

function _otLangTag(language) {
  if (typeof language !== 'string') return 0;
  const s = (language.trim().toUpperCase() + '    ').slice(0, 4);
  if (s === '    ') return 0;
  return (
    ((s.charCodeAt(0) << 24) |
      (s.charCodeAt(1) << 16) |
      (s.charCodeAt(2) << 8) |
      s.charCodeAt(3)) >>>
    0
  );
}

/// Ordered USE substitutions after cluster reordering. locl is not applied here.
const USE_FEATURES = [
  'nukt',
  'akhn',
  'rphf',
  'pref',
  'rkrf',
  'abvf',
  'blwf',
  'half',
  'pstf',
  'vatu',
  'cjct',
  'cfar',
  'abvs',
  'blws',
  'haln',
  'pres',
  'psts',
  'clig',
];
const AUTOMATIC_GSUB_FEATURES = new Set([
  ...USE_FEATURES,
  'rvrn',
  'ccmp',
  'locl',
  'liga',
  'rlig',
  'calt',
  'smcp',
  'c2sc',
  'isol',
  'init',
  'medi',
  'fina',
  'ljmo',
  'vjmo',
  'tjmo',
]);

/// The Indic basic substitutions that belong to one PART of a syllable
/// rather than to all of it, and the mask bit each reads. `half` builds
/// the joined spelling of a consonant that precedes the base;
/// `abvf`/`pstf`/`pref` build the forms that hang off one that follows
/// it; `blwf` reaches both sides in most scripts. `rphf` belongs to the
/// reph and to nothing else. The remaining basic substitutions (nukt,
/// akhn, rkrf, vatu, cjct) are global and carry no bit here.
///
/// Applied unmasked, each shapes glyphs on the wrong side of the base.
/// Bengali `da + halant + ya + aa` takes a half form on the da that the
/// font never wanted, and Devanagari `ka + halant + ra + halant + ta`
/// spells its INTERIOR ra as a reph — an `rphf` that only the syllable's
/// first glyphs should ever have seen.
const M_RPHF = 1;
const M_PREF = 2;
const M_BLWF = 4;
const M_ABVF = 8;
const M_HALF = 16;
const M_PSTF = 32;
const INDIC_MASK_BIT = {
  rphf: M_RPHF,
  pref: M_PREF,
  blwf: M_BLWF,
  abvf: M_ABVF,
  half: M_HALF,
  pstf: M_PSTF,
};
/// Telugu and Kannada give `blwf` to the glyphs after the base only;
/// every other Indic script here gives it to both sides, which is what
/// spells `ka + halant + ra + halant + ta` as one half-ka-with-ra glyph.
const BLWF_POST_ONLY = new Set(['telu', 'knda']);

/// CSS Fonts 4 `font-variant-caps: small-caps` on a font with no `smcp` feature: the user agent may synthesize it, and every browser
/// does, by drawing each lowercase letter as its capital at 0.7 of the size (Blink and Gecko both). The text is split into spans at
/// the lowercase / other boundary, as a browser splits its shaping runs, so kerning does not cross it. A letter whose uppercase form
/// is not the same number of UTF-16 units (ß) stays as it is, which keeps every span's source offset where it was.
const SMALL_CAPS_SCALE = 0.7;
function _synthSmallCaps(spans, font, layout) {
  const lacks = (f) => !(f && f.gsub && f.gsub.hasSmallCaps);
  let out = null;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    let f = font;
    if (span && span.style && !span.directive) {
      if (span.style.bold && span.style.italic)
        f = layout.boldItalicFont || layout.boldFont || layout.italicFont || font;
      else if (span.style.bold) f = layout.boldFont || font;
      else if (span.style.italic) f = layout.italicFont || font;
    }
    if (
      !span ||
      !span.style ||
      !span.style.smallCaps ||
      typeof span.text !== 'string' ||
      !span.text ||
      !lacks(f)
    ) {
      if (out) out.push(span);
      continue;
    }
    const pieces = [];
    let cur = '',
      curLow = false;
    const flush = () => {
      if (cur) pieces.push([cur, curLow]);
      cur = '';
    };
    for (const ch of span.text) {
      const up = ch.toUpperCase();
      const low = up !== ch && up.length === ch.length;
      if (low !== curLow) {
        flush();
        curLow = low;
      }
      cur += low ? up : ch;
    }
    flush();
    if (!pieces.some(([, low]) => low)) {
      if (out) out.push(span);
      continue;
    }
    if (!out) out = spans.slice(0, i);
    for (const [text, low] of pieces) {
      // (letter-spacing is a length of the whole text, not of the smaller letters: the layout scales it by sizeScale)
      out.push(
        low
          ? {
              ...span,
              text,
              style: {
                ...span.style,
                smallCaps: false,
                sizeScale: span.style.sizeScale * SMALL_CAPS_SCALE,
                cspaceEm: (span.style.cspaceEm || 0) / SMALL_CAPS_SCALE,
              },
            }
          : { ...span, text, style: { ...span.style, smallCaps: false } },
      );
    }
  }
  return out || spans;
}

/// Dependent vowel signs with a canonical decomposition into two (or three) signs, by script: NFC composes them back, the
/// Indic shaper wants them apart so each part gets its own position and lookups.
const INDIC_SPLIT_MATRAS = new Map([
  [0x09cb, [0x09c7, 0x09be]],
  [0x09cc, [0x09c7, 0x09d7]],
  [0x0b48, [0x0b47, 0x0b56]],
  [0x0b4b, [0x0b47, 0x0b3e]],
  [0x0b4c, [0x0b47, 0x0b57]],
  [0x0bca, [0x0bc6, 0x0bbe]],
  [0x0bcb, [0x0bc7, 0x0bbe]],
  [0x0bcc, [0x0bc6, 0x0bd7]],
  [0x0c48, [0x0c46, 0x0c56]],
  [0x0cc0, [0x0cbf, 0x0cd5]],
  [0x0cc7, [0x0cc6, 0x0cd5]],
  [0x0cc8, [0x0cc6, 0x0cd6]],
  [0x0cca, [0x0cc6, 0x0cc2]],
  [0x0ccb, [0x0cc6, 0x0cc2, 0x0cd5]],
  [0x0d4a, [0x0d46, 0x0d3e]],
  [0x0d4b, [0x0d47, 0x0d3e]],
  [0x0d4c, [0x0d46, 0x0d57]],
  [0x0dda, [0x0dd9, 0x0dca]],
  [0x0ddc, [0x0dd9, 0x0dcf]],
  [0x0ddd, [0x0dd9, 0x0dcf, 0x0dca]],
  [0x0dde, [0x0dd9, 0x0ddf]],
]);

/// Where a dependent vowel sign sorts among the glyphs behind the base (HarfBuzz hb-ot-shaper-indic.cc MATRA_POS_*): between
/// the below-base forms (8) and the post-base ones (11) the script's own convention decides -- before the sub-joined forms
/// (7), after them (9), after the post-base forms (12), or right after the main consonant (5, Oriya).
function _matraPosition(cp, side) {
  const BEFORE_SUB = 7,
    AFTER_SUB = 9,
    AFTER_POST = 12,
    AFTER_MAIN = 5;
  const script =
    cp >= 0x900 && cp < 0x980
      ? 'deva'
      : cp < 0xa00
        ? 'beng'
        : cp < 0xa80
          ? 'guru'
          : cp < 0xb00
            ? 'gujr'
            : cp < 0xb80
              ? 'orya'
              : cp < 0xc00
                ? 'taml'
                : cp < 0xc80
                  ? 'telu'
                  : cp < 0xd00
                    ? 'knda'
                    : cp < 0xd80
                      ? 'mlym'
                      : 'sinh';
  if (side === 'right') {
    switch (script) {
      case 'deva':
        return AFTER_SUB;
      case 'telu':
        return cp <= 0xc42 ? BEFORE_SUB : AFTER_SUB;
      case 'knda':
        return cp < 0xcc3 || cp > 0xcd6 ? BEFORE_SUB : AFTER_SUB;
      case 'sinh':
        return AFTER_SUB;
      default:
        return AFTER_POST;
    }
  }
  if (side === 'top') {
    switch (script) {
      case 'guru':
        return AFTER_POST;
      case 'orya':
        return AFTER_MAIN;
      case 'telu':
      case 'knda':
        return BEFORE_SUB;
      default:
        return AFTER_SUB;
    }
  }
  switch (
    script // bottom
  ) {
    case 'deva':
    case 'beng':
    case 'orya':
    case 'sinh':
      return AFTER_SUB;
    case 'telu':
      return cp <= 0xc42 ? BEFORE_SUB : AFTER_SUB;
    case 'knda':
      return BEFORE_SUB;
    default:
      return AFTER_POST;
  }
}

/// Canonical order puts shadda (ccc 33) after the vowels (ccc 27-32); Arabic fonts are written for shadda first, its vowel stacked on it or
/// ligated with it, which is the order HarfBuzz shapes (hb_modified_combining_class). All of these are BMP, so a cluster's UTF-16 widths stand.
function _shaddaFirst(cps) {
  for (let i = 1; i < cps.length; i++) {
    if (cps[i] !== 0x0651) continue;
    let k = i;
    while (
      k > 0 &&
      ((cps[k - 1] >= 0x064b && cps[k - 1] <= 0x0650) ||
        (cps[k - 1] >= 0x08f0 && cps[k - 1] <= 0x08f2))
    ) {
      cps[k] = cps[k - 1];
      k--;
    }
    cps[k] = 0x0651;
  }
}

/// Per-codepoint right-to-left flags (an odd UAX #9 embedding level) for one span, or null when no codepoint is
/// right-to-left or no bidi engine is registered. Resolved with the layout's base direction, like the line reorder.
function _rtlPerCodepoint(cps, layout) {
  const bidi = getBidi();
  if (!bidi) return null;
  const rawBase = layout.baseDirection != null ? layout.baseDirection : BaseDirection.Auto;
  const levels = bidi.resolveLevels(cps, bidi.resolveBaseDirection(rawBase, cps));
  let any = false;
  const out = new Array(cps.length);
  for (let i = 0; i < cps.length; i++) {
    out[i] = (levels[i] & 1) === 1;
    any = any || out[i];
  }
  return any ? out : null;
}

/// Whether a mark's advance is zeroed. HarfBuzz keeps it for Khmer and for the scripts of its Indic shaper, whose sub-joined consonants
/// and vowel signs are marks that carry real advances (HB_OT_SHAPE_ZERO_WIDTH_MARKS_NONE), and in a face whose positioning is AAT 'kerx'.
function _isMarkCodepoint(cp) {
  const arabic = getArabicShaping(),
    thai = getThaiShaping();
  return (
    (arabic ? arabic.getArabicJoiningType(cp) === arabic.ArabicJoiningType.T : false) ||
    (thai ? thai.isThaiLaoMark(cp) : false) ||
    (cp >= 0x20d0 && cp <= 0x20ff)
  );
}

function marksLoseAdvance(font, cp, usesKerx) {
  if ((cp >= 0x1780 && cp <= 0x17ff) || (cp >= 0x0900 && cp <= 0x0d7f)) return false;
  return !usesKerx;
}

// A drop mid-layout means earlier stages ran with a table the later ones did not see. Each pass that repeats dropped a table, and a
// layout reaches only so many of them; this is a ceiling on a font's table count, not a tuning value.
const MAX_LAYOUT_PASSES = 64;

/// A style that leaves out sizeScale or voffsetEm reads them as defaultStyle() does (1 and 0), so a pen is never
/// NaN. A value that is present and not finite still reaches _validateSpan's RangeError.
function _withScaleDefaults(spans) {
  let out = null;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i],
      style = span && span.style;
    if (
      style === null ||
      typeof style !== 'object' ||
      (style.sizeScale !== undefined && style.voffsetEm !== undefined)
    )
      continue;
    if (!out) out = spans.slice();
    out[i] = {
      ...span,
      style: {
        ...style,
        sizeScale: style.sizeScale === undefined ? 1 : style.sizeScale,
        voffsetEm: style.voffsetEm === undefined ? 0 : style.voffsetEm,
      },
    };
  }
  return out || spans;
}

export function layoutSlots(spans, font, layout, trackSourceClusters = false, lineRanges = null) {
  spans = _withScaleDefaults(spans);
  for (let pass = 1; ; pass++) {
    const drops = tableDropCount();
    const slots = layoutPass(spans, font, layout, trackSourceClusters, lineRanges);
    if (tableDropCount() === drops || pass >= MAX_LAYOUT_PASSES) return slots;
    if (lineRanges) lineRanges.length = 0;
  }
}

/// One pass over the fonts' readers directly, not through their guards, since a layout crosses them many times per glyph on fonts that
/// are nearly always good. A pass that throws is abandoned and run again behind the guards, which name the bad table and drop it, and
/// those fonts stay behind their guards. An error that is not a table's throws again from the second run.
function layoutPass(spans, font, layout, trackSourceClusters, lineRanges) {
  const unguarded = [];
  for (const f of [
    font,
    layout.boldFont,
    layout.italicFont,
    layout.boldItalicFont,
    ...(layout.fallbacks || []),
  ]) {
    if (f && f._unguardLayoutReaders()) unguarded.push(f);
  }
  if (!unguarded.length)
    return layoutSlotsOnce(spans, font, layout, trackSourceClusters, lineRanges);
  try {
    const slots = layoutSlotsOnce(spans, font, layout, trackSourceClusters, lineRanges);
    for (const f of unguarded) f._guardLayoutReaders();
    return slots;
  } catch {
    for (const f of unguarded) {
      f._guardLayoutReaders();
      f._distrustLayoutReaders();
    }
  }
  if (lineRanges) lineRanges.length = 0;
  return layoutSlotsOnce(spans, font, layout, trackSourceClusters, lineRanges);
}

function layoutSlotsOnce(spans, font, layout, trackSourceClusters, lineRanges) {
  if (!layout.jstf) return layoutSlotsInner(spans, font, layout, trackSourceClusters, lineRanges);
  // A justification trial: the lookup changes of one JSTF priority, installed on the fonts' readers for this layout only.
  const fonts = [
    font,
    layout.boldFont,
    layout.italicFont,
    layout.boldItalicFont,
    ...(layout.fallbacks || []),
  ];
  const remove = installJstf(fonts.filter(Boolean), layout.jstf);
  try {
    return layoutSlotsInner(spans, font, layout, trackSourceClusters, lineRanges);
  } finally {
    remove();
  }
}

/// True when some line may be justified against a font's JSTF priorities: the layout or a directive asks for justify and a
/// font in play lists priorities.
function _wantsJstf(spans, font, layout) {
  if (layout._jstfPass || layout.useJstf === false) return false;
  const justify =
    layout.align === 'justify' ||
    spans.some((s) => s && s.directive && s.directive.hasAlign && s.directive.align === 'justify');
  if (!justify) return false;
  const fonts = [
    font,
    layout.boldFont,
    layout.italicFont,
    layout.boldItalicFont,
    ...(layout.fallbacks || []),
  ];
  return fonts.some((f) => f && f.jstf && f.jstf.hasAnyPriorities);
}

function layoutSlotsInner(spans, font, layout, trackSourceClusters = false, lineRanges = null) {
  spans = _synthSmallCaps(spans, font, layout);
  // JSTF justification re-shapes a line from its source text, so the slots must know their source offsets.
  const jstfOn = _wantsJstf(spans, font, layout);
  if (jstfOn) trackSourceClusters = true;
  font.getMetrics(0x20);
  const metrics = layout.varCoords != null ? font.getMetricsVar(layout.varCoords) : font;
  const naturalLineHeight = metrics.ascent - metrics.descent + metrics.lineGap;
  // Per-line height resolved in the second pass (a <line-height>
  // directive can change it mid-paragraph).
  // Vertical writing: the line runs along the vertical axis, so the wrap
  // budget and alignment measure vertical advances (set by styledSlots).
  const inlineVertical = layout.inlineVertical || null;
  const maxWidth = layout.maxWidthEm > 0 ? layout.maxWidthEm : 0;
  const wrap = maxWidth > 0;
  // Fixed layout box width (align in a rect). Drives
  // horizontal alignment even WITHOUT wrap: a right-aligned single line
  // is pushed to the box's right edge rather than collapsing to its own
  // ink width. `0` = ink-tight behavior. textBundle.js turns
  // this into the bundle's globalBBox so the alignment offset survives.
  const layoutBoxW = layout.layoutWidthEm > 0 ? layout.layoutWidthEm : 0;
  const defaultAlign = layout.align || 'left';
  const varCoords = layout.varCoords || null;
  const defaultAxisCoords = [];
  const normalizedByFont = new Map();

  // OpenType feature toggles (caller-driven). `features` opts INTO
  // GSUB lookups that are off-by-default (tnum, lnum, ss01,
  // alternate-style sets); `disabledFeatures` opts OUT of the two
  // default-on tags callers may want suppressed (`kern`, `liga`/`rlig`).
  // Built once per layoutSlots call.
  const featureTags = [];
  if (layout.features) {
    for (const tag of Object.keys(layout.features)) {
      if (tag !== 'rvrn' && tag !== 'locl' && tag !== 'ccmp' && layout.features[tag])
        featureTags.push(tag);
    }
  }
  const disabled =
    layout.disabledFeatures instanceof Set
      ? layout.disabledFeatures
      : new Set(layout.disabledFeatures || []);
  // `compat: 'harfbuzz'` reproduces HarfBuzz where it departs from the specifications (default 'spec').
  const harfbuzzCompat = layout.compat === 'harfbuzz';
  // A font with both AAT (morx/mort, kerx) and OpenType (GSUB, GPOS) tables is shaped by the AAT ones unless `preferAat: false`
  // (default true); HarfBuzz compatibility uses its substitution and positioning table priorities.
  const preferAat = harfbuzzCompat || layout.preferAat !== false;
  // Positioning is selected independently from substitution. A chosen kerx route does not also execute GPOS.
  const usesKerx = (f) => {
    if (!f.kerx.hasKerx) return false;
    if (!harfbuzzCompat) return preferAat || !f.gpos.hasTable;
    const aatSubstitution = f.usesAatShaping || (!layout.inlineVertical && f.hasAatSubstitution);
    return !(!aatSubstitution && f.gsub.hasTable && f.gpos.hasTable);
  };
  const pairKerning = (f, a, b, requiredOnly) => {
    if (f.kerx.hasKerx)
      return usesKerx(f)
        ? requiredOnly
          ? 0
          : f.kerx.getPairKerning(a, b)
        : f.gpos.getPairKerning(a, b, requiredOnly);
    return requiredOnly ? f.gpos.getPairKerning(a, b, true) : f.getPairKerningFu(a, b);
  };
  const kernDisabled = disabled.has('kern');
  const ligaDisabled = disabled.has('liga') || disabled.has('rlig');

  const lines = [];
  const lineAdvances = [];
  const lineAlignOverride = [];
  const lineHeights = [];
  const lineUsableMaxes = [];
  const lineForcedEnd = []; // the line ended at a forced break, so `text-align-last` governs it (CSS Text 3)
  let needsFinalLine = false,
    hasHardBreak = false;
  let curLine = [];
  let curLineAdv = 0;
  let curLineAlign = null;
  let pendingAlign = null;
  let currentIndent = 0;
  let currentLineIndent = 0; // single-shot, resets at line break
  let currentMarginLeft = 0;
  let currentMarginRight = 0;
  let currentLineHeightOverride = 0; // 0 = use default
  let pendingPosOverride = null; // null = no override
  // UAX #14 break candidates on the current line, ascending. `cut` is the
  // first slot that leaves the line, `carry` the first slot that starts the
  // next one (they differ when a run of collapsible spaces is dropped), and
  // `pref` marks a word-aware candidate (after spaces or at a word start).
  let candCut = [];
  let candCarry = [];
  let candPref = [];
  let spaceRunStart = -1; // curLine index of the trailing collapsible-space run
  let dropLeadingSpaces = false; // after a soft wrap, spaces at the line start vanish
  let afterCr = false; // a LF directly after a CR belongs to that break
  let lbTail = []; // trailing codepoints of earlier spans, the line-break context

  const lineStartX = () => currentMarginLeft + currentIndent + currentLineIndent;
  const lineUsableMax = () => (wrap ? maxWidth - currentMarginRight : 0);

  const endLine = () => {
    needsFinalLine = false;
    lines.push(curLine);
    lineAdvances.push(curLineAdv);
    lineAlignOverride.push(curLineAlign);
    lineHeights.push(currentLineHeightOverride);
    lineUsableMaxes.push(lineUsableMax());
    if (pendingAlign != null) {
      curLineAlign = pendingAlign;
      pendingAlign = null;
    }
    // <line-indent> single-shot — resets at line break.
    currentLineIndent = 0;
    curLine = [];
    curLineAdv = lineStartX();
    candCut = [];
    candCarry = [];
    candPref = [];
    spaceRunStart = -1;
  };

  // CSS white-space:normal: collapsible spaces that end a line hang; when
  // they would overflow the usable width they are dropped.
  const trimHangingSpaces = () => {
    if (wrap && spaceRunStart > 0 && curLineAdv > lineUsableMax()) {
      curLineAdv = curLine[spaceRunStart].penX;
      curLine.length = spaceRunStart;
    }
    spaceRunStart = -1;
  };

  // Per-slot fonts: layout.fallbacks (if non-empty) is an ordered
  // list walked when the primary has no glyph for a codepoint. Each
  // slot stores its resolved font; GSUB/GPOS/metrics use that font.
  const fallbacks = layout.fallbacks && layout.fallbacks.length > 0 ? layout.fallbacks : null;

  // Script and language selection for every GSUB / GPOS lookup below.
  // Registry-backed (otScriptTags.js) so a Latin-only bundle carries no
  // script trie; with nothing registered the readers stay on their Latin
  // default, which is what such a consumer's text is.
  const otScriptTags = getOtScriptTags();
  const langTag = _otLangTag(layout.language);

  curLineAdv = lineStartX();

  let sourceTextOffset = 0;
  let spanIndex = -1;
  for (const span of spans) {
    spanIndex++;
    if (span === null || typeof span !== 'object')
      throw new TypeError(`layout: spans[${spanIndex}] must be an object {text, style}`);
    // Directive span — apply layout commands, emit no glyphs.
    const d = span.directive;
    if (
      d &&
      (d.hasAlign ||
        d.hasIndent ||
        d.hasPos ||
        d.hasLineHeight ||
        d.hasLineIndent ||
        d.hasMarginLeft ||
        d.hasMarginRight)
    ) {
      if (d.hasAlign) pendingAlign = d.align;
      if (d.hasIndent) {
        currentIndent = d.indentEm || 0;
        if (curLine.length === 0) curLineAdv = lineStartX();
      }
      if (d.hasLineIndent) {
        currentLineIndent = d.lineIndentEm || 0;
        if (curLine.length === 0) curLineAdv = lineStartX();
      }
      if (d.hasMarginLeft) {
        currentMarginLeft = d.marginLeftEm || 0;
        if (curLine.length === 0) curLineAdv = lineStartX();
      }
      if (d.hasMarginRight) {
        currentMarginRight = d.marginRightEm || 0;
      }
      if (d.hasPos) {
        pendingPosOverride = d.posEm || 0;
      }
      if (d.hasLineHeight) {
        currentLineHeightOverride = d.lineHeightEm || 0;
      }
      continue;
    }

    if (!span.text) continue;
    _validateSpan(span, spanIndex);
    noteScriptNeeds(span.text);

    const spanOffset = sourceTextOffset;
    sourceTextOffset += span.text.length;
    // <b>/<i> font-variant swap. When the span's style has bold
    // or italic AND the caller wired the matching font variant on
    // layout.{bold,italic,boldItalic}Font, use that as the span's
    // primary. When the matching variant is NOT wired, fall back to
    // synthesis: italic via shear, bold via stroke-rendering.
    let spanFont = font;
    let synthBold = false;
    let synthItalic = false;
    if (span.style.bold && span.style.italic) {
      if (layout.boldItalicFont) spanFont = layout.boldItalicFont;
      else if (layout.boldFont) {
        spanFont = layout.boldFont;
        synthItalic = true;
      } else if (layout.italicFont) {
        spanFont = layout.italicFont;
        synthBold = true;
      } else {
        synthBold = synthItalic = true;
      }
    } else if (span.style.bold) {
      if (layout.boldFont) spanFont = layout.boldFont;
      else synthBold = true;
    } else if (span.style.italic) {
      if (layout.italicFont) spanFont = layout.italicFont;
      else synthItalic = true;
    }

    // NFC per grapheme cluster (see _keepUncomposed for when a cluster is left as typed).
    const composedSpan = normalizeNFC(span.text);
    let normalized = composedSpan;
    let normalizedOffsets = null;
    if (composedSpan !== span.text) {
      const pieces = [];
      let kept = false;
      for (const cluster of segmentGraphemes(span.text)) {
        const composed = normalizeNFC(cluster);
        if (composed !== cluster && _keepUncomposed(cluster, composed, spanFont, fallbacks)) {
          pieces.push(cluster);
          kept = true;
        } else pieces.push(composed);
      }
      if (kept) normalized = pieces.join('');
      if (trackSourceClusters) {
        const source = kept ? pieces : null;
        normalizedOffsets = new Uint32Array(normalized.length);
        let original = 0,
          canonical = 0,
          pi = 0;
        for (const cluster of segmentGraphemes(span.text)) {
          const length = source ? source[pi++].length : normalizeNFC(cluster).length;
          normalizedOffsets.fill(spanOffset + original, canonical, canonical + length);
          original += cluster.length;
          canonical += length;
        }
      }
    }

    // Build cps/gids/fonts parallel with cluster-start + word-start
    // flags. Per-cluster font resolution: pick the font for the
    // cluster's first codepoint, then keep all cps of that cluster on
    // the same font so ZWJ chains and combining marks share GSUB/GPOS
    // tables.
    //
    // Word-start flags come from Intl.Segmenter('word') — ICU-quality
    // CJK morphological segmentation in browsers.
    const cps = [];
    const gids = [];
    const clusterStarts = [];
    const sourceClusters = trackSourceClusters ? [] : null;
    const wordStarts = [];
    const fonts = [];

    const wordStartSet = new Set();
    // Dictionary word starts provide optional wrap opportunities. The registered
    // provider defaults to Intl.Segmenter, or no hints when unavailable.
    {
      const starts = segmentWordStarts(normalized);
      if (starts) for (const i of starts) wordStartSet.add(i);
    }
    // Grapheme clustering uses the registered provider and its UAX #29 fallback.
    let utf16Pos = 0;
    for (const segment of segmentGraphemes(normalized)) {
      const sourceCluster = trackSourceClusters
        ? normalizedOffsets
          ? normalizedOffsets[utf16Pos]
          : spanOffset + utf16Pos
        : 0;
      let firstOfCluster = true;
      let clusterFont = null;
      // Materialize the cluster's codepoints so the base can look ahead
      // to a trailing Unicode variation selector (VS1–16 / IVS).
      const segCps = [],
        segUnits = [];
      // (an AAT font's own tables decide what to do with a composed sign, as in HarfBuzz)
      const splitMatras = !(
        spanFont.usesAatShaping ||
        (preferAat && !layout.inlineVertical && spanFont.hasAatSubstitution)
      );
      for (const c of codepoints(segment)) {
        // Two-part vowel signs stay split, as HarfBuzz's Indic shaper leaves them (its recomposition refuses a mark first).
        const parts = splitMatras ? INDIC_SPLIT_MATRAS.get(c) : undefined;
        if (parts) {
          segCps.push(...parts);
          segUnits.push(1, ...new Array(parts.length - 1).fill(0));
        } else {
          segCps.push(c);
          segUnits.push(c > 0xffff ? 2 : 1);
        }
      }
      _shaddaFirst(segCps);
      // An emoji sequence (VS16, keycap or ZWJ) picks its font by what covers
      // the whole cluster, not by its first codepoint.
      const sequenceFont =
        fallbacks !== null && segCps.length > 1
          ? _emojiSequenceFont(segCps, spanFont, fallbacks)
          : null;

      for (let ci = 0; ci < segCps.length; ci++) {
        const cp = segCps[ci];
        cps.push(cp);
        let chosen, gid;
        if (isHardBreakCp(cp)) {
          chosen = spanFont;
          gid = 0;
        } else if (firstOfCluster) {
          // Unicode Variation Sequence: a base immediately followed by a
          // variation selector (e.g. base + U+FE0F → emoji presentation,
          // or a CJK ideograph + IVS selector) resolves via the font's
          // format-14 cmap. The selector itself is hidden downstream as a
          // default-ignorable.
          const nextCp = ci + 1 < segCps.length ? segCps[ci + 1] : 0;
          if (sequenceFont !== null) {
            chosen = sequenceFont;
            gid =
              nextCp && isVariationSelector(nextCp) && chosen.hasVariationSelectors
                ? chosen.codepointToVariationGlyphId(cp, nextCp) || chosen.codepointToGlyphId(cp)
                : chosen.codepointToGlyphId(cp);
          } else if (nextCp && isVariationSelector(nextCp)) {
            [chosen, gid] = resolveGlyphWithSelector(cp, nextCp, spanFont, fallbacks);
          } else if (emojiPresentationDefault(cp)) {
            // Emoji-presentation-default codepoint with no explicit selector:
            // try an implicit emoji selector (VS16) so dual-form characters
            // prefer their emoji glyph; resolveGlyphWithSelector falls back to
            // the plain base glyph when the font has no such UVS entry.
            [chosen, gid] = resolveGlyphWithSelector(cp, 0xfe0f, spanFont, fallbacks);
          } else {
            [chosen, gid] = resolveGlyph(cp, spanFont, fallbacks);
          }
          clusterFont = chosen;
        } else {
          chosen = clusterFont;
          gid = chosen.codepointToGlyphId(cp);
        }
        gids.push(gid);
        fonts.push(chosen);
        clusterStarts.push(firstOfCluster);
        if (trackSourceClusters) sourceClusters.push(sourceCluster);
        wordStarts.push(wordStartSet.has(utf16Pos));
        utf16Pos += segUnits[ci];
        firstOfCluster = false;
      }
    }

    // AAT 'morx' shaping. AAT-only fonts (Zapfino, Hoefler Text, Apple
    // Chancery, …) carry no GSUB and form ligatures / contextual forms
    // through morx instead. Apply it per maximal same-font run so mixed-
    // font fallback still composes, then rebuild the parallel arrays from
    // morx's source map (a ligature inherits its first component's
    // codepoint / cluster / word-start; an inserted glyph its neighbor's).
    // The GSUB passes below then no-op on these fonts (null GSUB).
    // Fonts shaped by AAT metamorphosis: those with no GSUB, and (unless preferAat is false) every font with morx/mort in horizontal
    // text (morx replaces the OpenType tables there, and kerx replaces GPOS pair kerning, as in HarfBuzz and CoreText).
    const aatFonts = new Set();
    for (let i = 0; i < fonts.length; i++) {
      const f = fonts[i];
      if (f === fonts[i - 1]) continue; // (the list is per glyph)
      if (
        f &&
        !aatFonts.has(f) &&
        (f.usesAatShaping || (preferAat && !layout.inlineVertical && f.hasAatSubstitution))
      )
        aatFonts.add(f);
    }
    const gsubOf = (f) => (aatFonts.has(f) ? null : f.gsub);
    let aatComponents = null;
    if (aatFonts.size > 0) {
      const nCps = [],
        nGids = [],
        nClusterStarts = [],
        nWordStarts = [],
        nFonts = [];
      const nComps = [];
      const nSourceClusters = trackSourceClusters ? [] : null;
      // A run is one font in one direction: morx reads right-to-left text in visual order.
      const rtlAt = _rtlPerCodepoint(cps, layout);
      let ri = 0;
      while (ri < gids.length) {
        const f = fonts[ri];
        let rj = ri;
        while (rj < gids.length && fonts[rj] === f && (!rtlAt || rtlAt[rj] === rtlAt[ri])) rj++;
        if (aatFonts.has(f)) {
          const { gids: outGids, src } = f.applyAatShaping(
            gids.slice(ri, rj),
            !!(rtlAt && rtlAt[ri]),
          );
          // A ligature takes the place of its first component; the inputs nothing maps to were folded into it.
          const used = new Set(src);
          for (let k = 0; k < outGids.length; k++) {
            let comps = 1;
            for (let q = src[k] + 1; q < rj - ri && !used.has(q); q++) comps++;
            nComps.push(comps);
            const s = ri + src[k];
            nGids.push(outGids[k]);
            nCps.push(cps[s]);
            nClusterStarts.push(clusterStarts[s]);
            if (trackSourceClusters) nSourceClusters.push(sourceClusters[s]);
            nWordStarts.push(wordStarts[s]);
            nFonts.push(f);
          }
        } else {
          for (let k = ri; k < rj; k++) {
            nComps.push(1);
            nGids.push(gids[k]);
            nCps.push(cps[k]);
            nClusterStarts.push(clusterStarts[k]);
            if (trackSourceClusters) nSourceClusters.push(sourceClusters[k]);
            nWordStarts.push(wordStarts[k]);
            nFonts.push(fonts[k]);
          }
        }
        ri = rj;
      }
      _replaceInPlace(cps, nCps);
      _replaceInPlace(gids, nGids);
      _replaceInPlace(clusterStarts, nClusterStarts);
      if (trackSourceClusters) _replaceInPlace(sourceClusters, nSourceClusters);
      _replaceInPlace(wordStarts, nWordStarts);
      _replaceInPlace(fonts, nFonts);
      if (nComps.some((c) => c > 1)) aatComponents = nComps;
    }

    // A feature's lookups come from the language system of the run's own
    // script: a font's 'dev2' script can carry features its DFLT script
    // does not, and a Devanagari run reading DFLT's list loses half its
    // conjuncts. Each pass below selects the script of the glyph it is
    // about to shape before it asks the font for anything. The per-glyph
    // tags are rebuilt whenever a pass changes the glyph count; a reorder
    // inside a syllable leaves every glyph's script alone.
    let _scriptTags = null;
    let _scriptTagsLen = -1;
    const scriptTagsAt = (i) => {
      if (!otScriptTags) return null;
      if (_scriptTagsLen !== cps.length) {
        _scriptTags = otScriptTags.otScriptTagsPerCodepoint(cps);
        _scriptTagsLen = cps.length;
      }
      return _scriptTags[i];
    };
    const selectScript = (reader, i) => {
      if (!reader) return;
      if (reader.hasFeatureVariations || reader.hasDeviceVariations) {
        const selectedFont = fonts[i];
        let coords = normalizedByFont.get(selectedFont);
        if (!coords) {
          coords = selectedFont.isVariable
            ? selectedFont._normCoords(varCoords || defaultAxisCoords)
            : defaultAxisCoords;
          normalizedByFont.set(selectedFont, coords);
        }
        reader.setVariationCoords(coords);
      }
      reader.setShapingScript(scriptTagsAt(i), langTag);
    };

    // Maximal runs of one font and one script. Run boundaries stay valid
    // until a stage rewrites the glyph arrays.
    let runStarts = null;
    const runsOfSequence = () => {
      if (runStarts && runStarts.len === gids.length) return runStarts;
      const starts = [];
      const n = gids.length;
      if (n > 0) scriptTagsAt(0);
      const tagsOf = otScriptTags ? _scriptTags : null;
      for (let i = 0; i < n;) {
        starts.push(i);
        const font = fonts[i],
          tags = tagsOf ? tagsOf[i] : null;
        let end = i + 1;
        if (tagsOf) while (end < n && fonts[end] === font && tagsOf[end] === tags) end++;
        else while (end < n && fonts[end] === font) end++;
        i = end;
      }
      starts.len = gids.length;
      starts.push(gids.length);
      runStarts = starts;
      return starts;
    };

    // Required variation alternates preserve glyph count and cluster ownership.
    {
      const starts = runsOfSequence();
      for (let r = 0; r + 1 < starts.length; r++) {
        const reader = gsubOf(fonts[starts[r]]);
        selectScript(reader, starts[r]);
        if (!reader?.hasFeatureVariations && reader?.requiredFeature !== 'rvrn') continue;
        for (let i = starts[r]; i < starts[r + 1]; i++)
          gids[i] = reader.substituteRequiredVariation(gids[i]);
      }
    }

    let requiredComponents = aatComponents,
      requiredMarkIndices = aatComponents ? aatComponents.map(() => -1) : null;
    // `maskOf(start, end)` limits the stage to some inputs of a run; `carried` is a per-glyph array kept in step with the rewrite;
    // `required` lets a requested tag run when it is also the language system's required feature.
    const applyMappedStage = (tag = null, maskOf = null, carried = null, required = false) => {
      let hasRequiredFeature = false;
      {
        const starts = runsOfSequence();
        for (let r = 0; r + 1 < starts.length && !hasRequiredFeature; r++) {
          const reader = gsubOf(fonts[starts[r]]);
          selectScript(reader, starts[r]);
          if (!reader) continue;
          const stageTag = typeof tag === 'function' ? tag(reader) : tag;
          if (typeof tag === 'function' && !stageTag) continue;
          const lookupTag = stageTag || (reader.hasRequiredFeature ? reader.requiredFeature : null);
          if (stageTag ? !reader.hasFeature?.(stageTag) : !reader.hasRequiredFeature) continue;
          hasRequiredFeature = reader.featureMayChange
            ? reader.featureMayChange(
                lookupTag,
                gids,
                starts[r],
                starts[r + 1],
                !stageTag || required,
              )
            : true;
        }
      }
      if (hasRequiredFeature) {
        const starts = runsOfSequence();
        const shapes = [];
        let changed = false;
        for (let r = 0; r + 1 < starts.length; r++) {
          const start = starts[r],
            end = starts[r + 1];
          const reader = gsubOf(fonts[start]);
          selectScript(reader, start);
          const input = gids.slice(start, end);
          const ownership = requiredComponents
            ? {
                components: requiredComponents.slice(start, end),
                markComponents: requiredMarkIndices.slice(start, end),
              }
            : null;
          // (a run shaped by AAT has no reader, and a stage chosen per reader has no tag for it)
          const stageTag = typeof tag === 'function' ? (reader ? tag(reader) : null) : tag;
          const shaped = reader?.applyMappedFeatureToSeqTracked
            ? reader.applyMappedFeatureToSeqTracked(
                stageTag ||
                  (typeof tag === 'function'
                    ? null
                    : reader.hasRequiredFeature
                      ? reader.requiredFeature
                      : null),
                input,
                required || (!stageTag && typeof tag !== 'function'),
                ownership,
                maskOf ? maskOf(start, end) : null,
              )
            : {
                seq: input,
                src: input.map((_, i) => i),
                components: ownership?.components || input.map(() => 1),
                markComponents: ownership?.markComponents || input.map(() => -1),
              };
          if (!changed) {
            changed =
              shaped.seq.length !== input.length ||
              shaped.mergedSourceRanges?.length > 0 ||
              shaped.seq.some(
                (gid, k) =>
                  gid !== input[k] ||
                  shaped.src[k] !== k ||
                  shaped.components[k] !== (ownership ? ownership.components[k] : 1) ||
                  shaped.markComponents[k] !== (ownership ? ownership.markComponents[k] : -1),
              );
          }
          shapes.push(shaped);
        }
        if (!changed) return;
        let total = 0;
        for (const shaped of shapes) total += shaped.seq.length;
        const next = {
          cps: new Array(total),
          gids: new Array(total),
          clusters: new Array(total),
          words: new Array(total),
          fonts: new Array(total),
          sources: trackSourceClusters ? new Array(total) : [],
          components: new Array(total),
          marks: new Array(total),
        };
        const nextCarried = carried ? new Array(total) : null;
        let w = 0;
        for (let r = 0; r + 1 < starts.length; r++) {
          const start = starts[r];
          const shaped = shapes[r];
          const mergedClusters = new Map();
          const clusterRoot = (cluster) => {
            while (mergedClusters.has(cluster) && mergedClusters.get(cluster) !== cluster)
              cluster = mergedClusters.get(cluster);
            return cluster;
          };
          if (trackSourceClusters)
            for (const [lo, hi] of shaped.mergedSourceRanges || []) {
              const clusters = sourceClusters.slice(start + lo, start + hi + 1).map(clusterRoot);
              const root = Math.min(...clusters);
              for (const cluster of clusters) mergedClusters.set(cluster, root);
            }
          for (let k = 0; k < shaped.seq.length; k++, w++) {
            const source = start + shaped.src[k];
            const first = k === 0 || shaped.src[k - 1] !== shaped.src[k];
            next.gids[w] = shaped.seq[k];
            next.cps[w] = first ? cps[source] : 0;
            next.components[w] = shaped.components[k];
            next.marks[w] = shaped.markComponents[k];
            next.clusters[w] = first ? clusterStarts[source] : false;
            next.words[w] = first ? wordStarts[source] : false;
            next.fonts[w] = fonts[source];
            if (trackSourceClusters) next.sources[w] = clusterRoot(sourceClusters[source]);
            if (nextCarried) nextCarried[w] = carried[source];
          }
        }
        if (carried) _replaceInPlace(carried, nextCarried);
        _replaceInPlace(cps, next.cps);
        _replaceInPlace(gids, next.gids);
        _replaceInPlace(clusterStarts, next.clusters);
        _replaceInPlace(wordStarts, next.words);
        _replaceInPlace(fonts, next.fonts);
        if (trackSourceClusters) _replaceInPlace(sourceClusters, next.sources);
        requiredComponents = next.components;
        requiredMarkIndices = next.marks;
        runStarts = null;
      }
    };
    applyMappedStage();

    if (span.style.smallCaps) {
      for (let gi = 0; gi < gids.length; gi++) {
        const g = gids[gi];
        if (g === 0) continue;
        const fGsub = gsubOf(fonts[gi]);
        if (!fGsub) continue;
        selectScript(fGsub, gi);
        if (!fGsub.hasSmallCaps) continue;
        gids[gi] = fGsub.substituteSmallCap(g);
      }
    }

    // Ahead of ccmp, as HarfBuzz decomposes it before any GSUB: a font's ccmp that splits it too would leave a second aa.
    // Thai/Lao shaping: SARA AM decomposition (U+0E33 → U+0E4D + U+0E32
    // for Thai, U+0EB3 → U+0ECD + U+0EB2 for Lao — mark first, matching
    // Unicode's canonical decomposition and HarfBuzz). NFC keeps SARA AM
    // composed, but some fonts only glyph the decomposed pair — this
    // mirrors what OT 'ccmp' would do. Thai/Lao are encoded in VISUAL
    // order, so there is no reorder pass. GPOS mark attachment for tone
    // marks + above/below vowels rides the mark-attachment slot loop via
    // the isMarkAt() predicate.
    const _thai = getThaiShaping();
    // (an AAT font's morx splits SARA AM itself)
    if (_thai && cps.some(_thai.isThaiLaoCodepoint) && fonts.some((f) => !aatFonts.has(f))) {
      // Decompose SARA AM. The decomposed halves re-resolve their gid
      // via cmap (see below); the pair shares a single source-cp's
      // metadata (cluster/word/font).
      const decomp = _thai.decomposeSaraAm(cps);
      if (decomp.cps.length !== cps.length) {
        // Stream length changed: rebuild parallel arrays.
        const newCps = [],
          newGids = [],
          newClusterStarts = [],
          newWordStarts = [],
          newFonts = [];
        const newSourceClusters = trackSourceClusters ? [] : null;
        const newRequiredComponents = requiredComponents ? [] : null,
          newRequiredMarks = requiredComponents ? [] : null;
        for (let i = 0; i < decomp.cps.length; i++) {
          const src = decomp.origLow[i];
          const outCp = decomp.cps[i];
          newCps.push(outCp);

          let outGid = gids[src];
          if (outCp !== cps[src]) {
            outGid = fonts[src].codepointToGlyphId(outCp);
          }
          newGids.push(outGid);
          // Cluster-start only on the first emitted half.
          const firstHalf = i === 0 || decomp.origLow[i - 1] !== src;
          newClusterStarts.push(firstHalf ? clusterStarts[src] : false);
          if (trackSourceClusters) newSourceClusters.push(sourceClusters[src]);
          if (requiredComponents) {
            newRequiredComponents.push(requiredComponents[src]);
            newRequiredMarks.push(requiredMarkIndices[src]);
          }
          newWordStarts.push(firstHalf ? wordStarts[src] : false);
          newFonts.push(fonts[src]);
        }
        _replaceInPlace(cps, newCps);
        _replaceInPlace(gids, newGids);
        _replaceInPlace(clusterStarts, newClusterStarts);
        if (trackSourceClusters) _replaceInPlace(sourceClusters, newSourceClusters);
        if (requiredComponents) {
          _replaceInPlace(requiredComponents, newRequiredComponents);
          _replaceInPlace(requiredMarkIndices, newRequiredMarks);
        }
        _replaceInPlace(wordStarts, newWordStarts);
        _replaceInPlace(fonts, newFonts);
      }

      // No pre-base vowel reorder: Thai/Lao are encoded in VISUAL order
      // (TUS §16.1) — pre-base vowels are already stored before their
      // consonant, and HarfBuzz performs no reorder either. A swap here
      // would displace every mid-string เ/แ/โ/ใ/ไ in correctly-encoded
      // text.
    }

    if (!disabled.has('ccmp') && (layout.features?.ccmp == null || layout.features.ccmp)) {
      applyMappedStage('ccmp');
    }

    if (!disabled.has('locl') && (layout.features?.locl == null || layout.features.locl))
      applyMappedStage('locl');

    const _arabic = getArabicShaping();
    if (_arabic && cps.some(_arabic.isArabicCodepoint)) {
      const forms = Array.from(_arabic.resolveArabicForms(cps));
      // A transparent character takes no positional form of its own, whatever the letter before it takes (HarfBuzz gives it no
      // shaping action). SF Arabic's medi lookup covers fatha, and would take it away from the rclt rule that lifts it over a tall letter.
      for (let k = 0; k < forms.length; k++)
        if (cps[k] !== 0 && _arabic.getArabicJoiningType(cps[k]) === _arabic.ArabicJoiningType.T)
          forms[k] = ARABIC_NO_FORM;
      // A font whose positional lookups are more than single substitutions (Noto Nastaliq: multiple; Noto Sans Hanifi Rohingya:
      // alternate) runs each feature over the sequence, masked to the glyphs of that form, in HarfBuzz's feature order.
      for (const [formTag, form] of ARABIC_FORM_STAGES) {
        applyMappedStage(
          (reader) => (reader.arabicFormsNeedSequence ? formTag : null),
          (start, end) => {
            const mask = new Array(end - start);
            for (let k = start; k < end; k++) mask[k - start] = forms[k] === form;
            return mask;
          },
          forms,
        );
      }
      for (let gi = 0; gi < gids.length; gi++) {
        const g = gids[gi];
        if (g === 0) continue;
        const fGsub = gsubOf(fonts[gi]);
        if (!fGsub) continue;
        selectScript(fGsub, gi);
        if (!fGsub.hasArabicForms || fGsub.arabicFormsNeedSequence) continue;
        gids[gi] = fGsub.substituteArabicForm(g, forms[gi]);
      }
    }

    // Hangul jamo positional form substitution (ljmo/vjmo/tjmo).
    // Runs over raw Hangul Jamo codepoints (U+1100..U+11FF) that NFC
    // couldn't compose into precomposed syllables — Old Korean and
    // archaic jamo combinations. Modern Korean text reaches us as
    // precomposed Hangul Syllables (U+AC00..U+D7A3) which go through
    // cmap directly and don't need this pass.
    const _hangul = getHangulShaping();
    if (_hangul && cps.some(_hangul.isHangulJamo)) {
      for (let gi = 0; gi < gids.length; gi++) {
        const g = gids[gi];
        if (g === 0) continue;
        const role = _hangul.classifyHangulJamo(cps[gi]);
        if (role == null) continue;
        const fGsub = gsubOf(fonts[gi]);
        if (!fGsub) continue;
        selectScript(fGsub, gi);
        if (!fGsub.hasHangulJamoForms) continue;
        gids[gi] = fGsub.substituteHangulJamo(g, role);
      }
    }

    // Shape each Indic syllable with basic substitutions, reordering, then
    // presentation substitutions. Apply each feature's lookup chain over the
    // current glyph sequence and use its source map to retain parallel metadata.
    // Feature masks restrict inputs relative to the selected base and reph.
    // Presentation features run in tag order rather than merging their lookups.
    const _indic = getIndicShaping();
    if (_indic && cps.some(_indic.isIndicCodepoint)) {
      const PRE_FEATURES = [
        'nukt',
        'akhn',
        'rphf',
        'rkrf',
        'pref',
        'blwf',
        'abvf',
        'half',
        'pstf',
        'vatu',
        'cjct',
      ];
      const POST_FEATURES = ['init', 'pres', 'abvs', 'blws', 'psts', 'haln', 'calt'];
      // An AAT font's morx does its own reordering: its glyphs pass through as they came out of it.
      const syllables = [];
      for (const syl of _indic.findIndicSyllables(cps)) {
        if (aatFonts.size > 0 && aatFonts.has(fonts[syl.start]))
          for (let i = syl.start; i < syl.end; i++) syllables.push({ start: i, end: i + 1 });
        else syllables.push(syl);
      }
      // Whether a consonant has a below-base or post-base form is a
      // property of (font, script, glyph), not of the syllable it turned
      // up in, so the answer is kept for the whole run: a paragraph asks
      // the font once per distinct consonant rather than once per
      // occurrence. Keyed by font because a fallback boundary changes
      // whose glyph ids these are, and by script because the selected
      // language system decides which lookups the probe can see.
      const posByFont = new Map();
      const newCps = [],
        newGids = [],
        newClusterStarts = [],
        newWordStarts = [],
        newFonts = [];
      const newSourceClusters = trackSourceClusters ? [] : null;
      const newRequiredComponents = requiredComponents ? [] : null,
        newRequiredMarks = requiredComponents ? [] : null;
      for (const { start, end } of syllables) {
        let sCps = [],
          sGids = [],
          sClusters = [],
          sWords = [],
          sFonts = [],
          sOrigLow = [];
        for (let k = start; k < end; k++) {
          sCps.push(cps[k]);
          sGids.push(gids[k]);
          sClusters.push(clusterStarts[k]);
          sWords.push(wordStarts[k]);
          sFonts.push(fonts[k]);
          sOrigLow.push(k - start);
        }
        const origCps = sCps.slice();
        const fGsub = gsubOf(sFonts[0]);
        selectScript(fGsub, start);
        // One font per syllable, as the USE pass requires: a fallback-font
        // boundary splits the lookup context, and a coverage table read
        // with another font's glyph ids matches by accident.
        const oneFont = sFonts.every((f) => f === sFonts[0]);
        const hasIndic = !!fGsub && fGsub.hasIndicFeatures && oneFont;

        // Resolve the base consonant against the FONT. Which glyph is the
        // base decides which of them may take a half form and which may
        // take a below-base or post-base one, and the answer depends on
        // what forms the font carries — see indicShaper.js. A leading
        // Ra + Halant is a reph on the same terms: the codepoints alone
        // cannot tell, and a font whose 'rphf' does not cover the pair
        // never wanted the reorder (Gurmukhi ਰ੍ਕ comes out with its two
        // glyphs in the wrong ORDER when this is read off the
        // codepoints).
        const script = _indic.indicScriptOf(origCps[0]);
        const viramaGid =
          fGsub && script ? sFonts[0].codepointToGlyphId(_indic.viramaForScript(script)) : 0;
        let posCache = posByFont.get(sFonts[0]);
        if (!posCache) posByFont.set(sFonts[0], (posCache = new Map()));
        const gids0 = sGids;
        const positionAt = (i) => {
          const g = gids0[i - start];
          const key = script + ':' + g;
          let p = posCache.get(key);
          if (p === undefined) {
            p = _indic.consonantPositionFromFont(
              (tag, glyphs) => fGsub.wouldSubstitute(tag, glyphs),
              g,
              viramaGid,
            );
            posCache.set(key, p);
          }
          return p;
        };
        const syl = _indic.analyzeIndicSyllable(cps, start, end, {
          positionAt: fGsub && viramaGid ? positionAt : null,
          gidAt: (i) => gids0[i - start],
          rphfProbe: (glyphs) => fGsub.wouldSubstitute('rphf', glyphs),
          hasRphf: !!fGsub && fGsub.hasFeature('rphf'),
        });
        const hadReph = syl.hasReph;
        const baseLocal = syl.base < 0 ? -1 : syl.base - start;

        const PRE_MASK = M_HALF | (BLWF_POST_ONLY.has(script) ? 0 : M_BLWF);
        const POST_MASK = M_BLWF | M_ABVF | M_PSTF | M_PREF;
        let sMask = sGids.map((_, k) => {
          let m;
          if (baseLocal < 0) m = PRE_MASK | POST_MASK;
          else if (k < baseLocal) m = PRE_MASK;
          else if (k > baseLocal) m = POST_MASK;
          else m = 0;
          if (hadReph && k < syl.rephLimit - start) m |= M_RPHF;
          return m;
        });
        // A zwnj withholds `half` from the glyphs behind it, back through
        // the nearest consonant: the writer asked for the two consonants
        // to stay apart, and a half form is exactly the joined spelling
        // they asked against.
        for (let k = 1; k < origCps.length; k++) {
          const cat = _indic.classifyIsc(origCps[k]);
          if (cat !== _indic.Isc.ZWNJ) continue;
          let j = k;
          do {
            j--;
            sMask[j] &= ~M_HALF;
          } while (j > 0 && !_indic.isIndicBaseCandidate(_indic.classifyIsc(origCps[j])));
        }

        /// Run one feature over the whole syllable, carrying the parallel
        /// arrays through the engine's source map. A glyph that is not the
        /// first output of its source — a multiple substitution's tail —
        /// gets no codepoint and starts neither cluster nor word, the same
        /// convention the USE pass emits. The mask travels with them.
        const applyTag = (tag) => {
          if (!fGsub.hasFeature(tag)) return;
          const bit = INDIC_MASK_BIT[tag] || 0;
          const mask = bit ? sMask.map((m) => (m & bit) !== 0) : null;
          const r = fGsub.applyFeatureToSeqTracked(tag, sGids, mask, false);
          if (r.seq === sGids) return;
          const nCps = [],
            nClusters = [],
            nWords = [],
            nFonts = [],
            nOrigLow = [],
            nMask = [];
          for (let k = 0; k < r.seq.length; k++) {
            const j = r.src[k];
            const firstOfSource = k === 0 || r.src[k - 1] !== j;
            nCps.push(firstOfSource ? sCps[j] : 0);
            nClusters.push(firstOfSource ? sClusters[j] : false);
            nWords.push(firstOfSource ? sWords[j] : false);
            nFonts.push(sFonts[j]);
            nOrigLow.push(sOrigLow[j]);
            nMask.push(sMask[j]);
          }
          sGids = r.seq;
          sCps = nCps;
          sClusters = nClusters;
          sWords = nWords;
          sFonts = nFonts;
          sOrigLow = nOrigLow;
          sMask = nMask;
        };

        // Initial reordering of what follows the base (HarfBuzz initial_reordering_consonant_syllable): each glyph takes a
        // position class -- above the base, below it, after it, at the end -- and a stable sort puts them in that order, so a
        // top matra comes before a below-base consonant, whatever the order they were typed in.
        if (hasIndic && fGsub.usesNewIndicScript && baseLocal >= 0 && sCps.length - baseLocal > 2) {
          const POS_END = 15,
            POS_BELOW = 8,
            POS_POST = 11,
            POS_AFTER_POST = 12,
            POS_FINAL = 13,
            POS_SMVD = 14;
          const n = sCps.length,
            Isc = _indic.Isc,
            Ipc = _indic.Ipc;
          const cat = sCps.map((c) => _indic.classifyIsc(c));
          const isCons = (c) =>
            c === Isc.Consonant ||
            c === Isc.Ra ||
            c === Isc.ConsonantDead ||
            c === Isc.VowelIndependent ||
            c === Isc.ConsonantPlaceholder;
          const pos = new Array(n).fill(0);
          let lastPos = 0;
          for (let k = 0; k < n; k++) {
            const c = cat[k];
            let own = -1;
            if (isCons(c)) {
              own =
                k < baseLocal
                  ? 3
                  : k === baseLocal
                    ? 4
                    : positionAt(start + k) === _indic.ConsPos.Below
                      ? POS_BELOW
                      : positionAt(start + k) === _indic.ConsPos.Post
                        ? POS_POST
                        : 4;
            } else if (c === Isc.VowelDependent) {
              const ipc = _indic.classifyIpc(sCps[k]);
              own =
                ipc === Ipc.Left
                  ? POS_END
                  : _matraPosition(
                      sCps[k],
                      ipc === Ipc.Top ? 'top' : ipc === Ipc.Bottom ? 'bottom' : 'right',
                    );
            } else if (c === Isc.Bindu || c === Isc.Anudatta || c === Isc.Modifier) own = POS_SMVD;
            if (own < 0)
              pos[k] = lastPos; // joiner, nukta, halant: rides with the glyph before it
            else {
              pos[k] = own;
              if (own !== POS_SMVD) lastPos = own;
            }
          }
          // A halant or joiner ahead of an after-main consonant belongs to that consonant.
          let last = baseLocal;
          for (let k = baseLocal + 1; k < n; k++) {
            if (isCons(cat[k])) {
              for (let j = last + 1; j < k; j++) if (pos[j] < POS_SMVD) pos[j] = pos[k];
              last = k;
            } else if (cat[k] === Isc.VowelDependent) last = k;
          }
          // A consonant that comes after a matra is a final consonant.
          for (let k = baseLocal + 1; k < n; k++) {
            if (cat[k] !== Isc.VowelDependent) continue;
            for (let j = k + 1; j < n; j++)
              if (isCons(cat[j])) {
                pos[j] = POS_FINAL;
                break;
              }
            break;
          }
          const order = [];
          for (let k = baseLocal + 1; k < n; k++) order.push(k);
          order.sort((a, b) => pos[a] - pos[b] || a - b);
          if (order.some((k, i) => k !== baseLocal + 1 + i)) {
            const permute = (arr) => {
              const head = arr.slice(0, baseLocal + 1);
              for (const k of order) head.push(arr[k]);
              return head;
            };
            sCps = permute(sCps);
            sGids = permute(sGids);
            sClusters = permute(sClusters);
            sWords = permute(sWords);
            sFonts = permute(sFonts);
            sOrigLow = permute(sOrigLow);
            sMask = permute(sMask);
          }
        }

        // Pre-reorder feature application.
        if (hasIndic) for (const tag of PRE_FEATURES) applyTag(tag);

        // Compute rephLen post-features and reorder.
        let rephLen = 0;
        if (hadReph) {
          for (let i = 0; i < sOrigLow.length; i++) {
            if (sOrigLow[i] < 2) rephLen++;
            else break;
          }
        }
        // Follow the base through the substitutions: it is the last glyph
        // whose source is at or before the base's original position, which
        // is the base itself when it survived and the glyph it ligated
        // into when it did not.
        let baseAfter = -1;
        if (baseLocal >= 0) {
          for (let i = 0; i < sOrigLow.length; i++) if (sOrigLow[i] <= baseLocal) baseAfter = i;
        }

        const rephAfterPost = script === 'sinh';
        const sylOrder = _indic.reorderSyllableExplicitReph(
          sCps,
          0,
          sCps.length,
          hadReph && !rephAfterPost,
          rephLen,
          baseAfter,
          script === 'mlym' || script === 'taml',
        );
        const reCps = [],
          reGids = [],
          reClusters = [],
          reWords = [],
          reFonts = [],
          reOrigLow = [];
        for (const idx of sylOrder) {
          reCps.push(sCps[idx]);
          reGids.push(sGids[idx]);
          reClusters.push(sClusters[idx]);
          reWords.push(sWords[idx]);
          reFonts.push(sFonts[idx]);
          reOrigLow.push(sOrigLow[idx]);
        }
        sCps = reCps;
        sGids = reGids;
        sClusters = reClusters;
        sWords = reWords;
        sFonts = reFonts;
        sOrigLow = reOrigLow;

        // Post-reorder feature application.
        if (hasIndic) for (const tag of POST_FEATURES) applyTag(tag);

        // Sinhala's deferred reph move. Nothing to do when the reph has
        // already ligated with its base — the glyph that carries both is
        // where it belongs.
        if (hadReph && rephAfterPost) {
          let n = 0;
          while (n < sOrigLow.length && sOrigLow[n] < 2) n++;
          let basePos = -1;
          if (baseLocal >= 0) {
            for (let i = 0; i < sOrigLow.length; i++) if (sOrigLow[i] <= baseLocal) basePos = i;
          }
          if (n > 0 && basePos >= n) {
            const move = (arr) => arr.splice(basePos + 1 - n, 0, ...arr.splice(0, n));
            move(sCps);
            move(sGids);
            move(sClusters);
            move(sWords);
            move(sFonts);
            move(sOrigLow);
          }
        }

        for (let k = 0; k < sCps.length; k++) {
          newCps.push(sCps[k]);
          newGids.push(sGids[k]);
          newClusterStarts.push(sClusters[k]);
          if (trackSourceClusters) newSourceClusters.push(sourceClusters[start + sOrigLow[k]]);
          if (requiredComponents) {
            newRequiredComponents.push(requiredComponents[start + sOrigLow[k]]);
            newRequiredMarks.push(requiredMarkIndices[start + sOrigLow[k]]);
          }
          newWordStarts.push(sWords[k]);
          newFonts.push(sFonts[k]);
        }
      }
      _replaceInPlace(cps, newCps);
      _replaceInPlace(gids, newGids);
      _replaceInPlace(clusterStarts, newClusterStarts);
      if (trackSourceClusters) _replaceInPlace(sourceClusters, newSourceClusters);
      if (requiredComponents) {
        _replaceInPlace(requiredComponents, newRequiredComponents);
        _replaceInPlace(requiredMarkIndices, newRequiredMarks);
      }
      _replaceInPlace(wordStarts, newWordStarts);
      _replaceInPlace(fonts, newFonts);
    }

    const _use = getUseShaping();
    if (_use && cps.some(_use.isUseCodepoint)) {
      const clusters = [];
      for (const cl of _use.findUseClusters(cps)) {
        if (aatFonts.size > 0 && aatFonts.has(fonts[cl.start]))
          for (let i = cl.start; i < cl.end; i++) clusters.push({ start: i, end: i + 1 });
        else clusters.push(cl);
      }
      const newCps = [],
        newGids = [],
        newClusterStarts = [],
        newWordStarts = [],
        newFonts = [];
      const newSourceClusters = trackSourceClusters ? [] : null;
      const newRequiredComponents = requiredComponents ? [] : null,
        newRequiredMarks = requiredComponents ? [] : null;
      for (const { start, end } of clusters) {
        const eCps = [],
          eGids = [],
          eStarts = [],
          eWords = [],
          eFonts = [];
        const eSourceClusters = trackSourceClusters ? [] : null;
        const eRequiredComponents = requiredComponents ? [] : null,
          eRequiredMarks = requiredComponents ? [] : null;
        for (let k = start; k < end; k++) {
          const pre =
            _use.splitVowelPrefix && !aatFonts.has(fonts[k]) ? _use.splitVowelPrefix(cps[k]) : 0;
          if (pre && fonts[k]) {
            eCps.push(pre);
            eGids.push(fonts[k].codepointToGlyphId(pre));
            eStarts.push(false);
            eWords.push(false);
            eFonts.push(fonts[k]);
            if (trackSourceClusters) eSourceClusters.push(sourceClusters[k]);
            if (requiredComponents) {
              eRequiredComponents.push(requiredComponents[k]);
              eRequiredMarks.push(requiredMarkIndices[k]);
            }
          }
          eCps.push(cps[k]);
          eGids.push(gids[k]);
          eStarts.push(clusterStarts[k]);
          eWords.push(wordStarts[k]);
          eFonts.push(fonts[k]);
          if (trackSourceClusters) eSourceClusters.push(sourceClusters[k]);
          if (requiredComponents) {
            eRequiredComponents.push(requiredComponents[k]);
            eRequiredMarks.push(requiredMarkIndices[k]);
          }
        }
        const order = _use.reorderUseCluster(eCps, 0, eCps.length);
        const cCps = [],
          cGids = [],
          cStarts = [],
          cWords = [],
          cFonts = [];
        const cSourceClusters = trackSourceClusters ? [] : null;
        const cRequiredComponents = requiredComponents ? [] : null,
          cRequiredMarks = requiredComponents ? [] : null;
        for (const j of order) {
          cCps.push(eCps[j]);
          cGids.push(eGids[j]);
          cStarts.push(eStarts[j]);
          cWords.push(eWords[j]);
          cFonts.push(eFonts[j]);
          if (trackSourceClusters) cSourceClusters.push(eSourceClusters[j]);
          if (requiredComponents) {
            cRequiredComponents.push(eRequiredComponents[j]);
            cRequiredMarks.push(eRequiredMarks[j]);
          }
        }
        const fGsub = cFonts.length && cFonts[0] && gsubOf(cFonts[0]);
        if (fGsub) selectScript(fGsub, start);
        let fGids = cGids,
          src = null;
        // One font per cluster: a fallback font boundary splits the lookup context, so a mixed cluster keeps its glyphs.
        if (fGsub && _use.isUseCodepoint(cCps[0]) && cFonts.every((f) => f === cFonts[0])) {
          for (const tag of USE_FEATURES) {
            if (!fGsub.hasFeature(tag)) continue;
            const r = fGsub.applyFeatureToSeqTracked(tag, fGids, null, false);
            if (r.seq === fGids) continue;
            src = src ? r.src.map((k) => src[k]) : r.src;
            fGids = r.seq;
          }
        }
        for (let k = 0; k < fGids.length; k++) {
          const j = src ? src[k] : k;
          const firstOfSource = !src || k === 0 || src[k - 1] !== j;
          newCps.push(firstOfSource ? cCps[j] : 0);
          newGids.push(fGids[k]);
          newClusterStarts.push(firstOfSource ? cStarts[j] : false);
          if (trackSourceClusters) newSourceClusters.push(cSourceClusters[j]);
          if (requiredComponents) {
            newRequiredComponents.push(cRequiredComponents[j]);
            newRequiredMarks.push(cRequiredMarks[j]);
          }
          newWordStarts.push(firstOfSource ? cWords[j] : false);
          newFonts.push(cFonts[j]);
        }
      }
      _replaceInPlace(cps, newCps);
      _replaceInPlace(gids, newGids);
      _replaceInPlace(clusterStarts, newClusterStarts);
      if (trackSourceClusters) _replaceInPlace(sourceClusters, newSourceClusters);
      if (requiredComponents) {
        _replaceInPlace(requiredComponents, newRequiredComponents);
        _replaceInPlace(requiredMarkIndices, newRequiredMarks);
      }
      _replaceInPlace(wordStarts, newWordStarts);
      _replaceInPlace(fonts, newFonts);
    }

    //
    // ligCompIdx is the 0-based component a mark was written INSIDE of, or -1
    // for everything else. Under an IgnoreMarks lookup a ligature match spans
    // the marks between its components (gsubReader returns compPos to identify
    // them), and those marks have to survive: advancing by `consumed` alone
    // would DELETE them, so Arabic lam-FATHA-alef would render as a bare lam-alef
    // with the vowel gone. They are re-emitted after the ligature glyph, each
    // tagged with the component it followed so MarkLigPos can place it.
    // CSS Text 3 7.2: optional ligatures break when letter-spacing is not zero;
    // required ones (rlig) stay.
    const optionalLigatures = (span.style.cspaceEm || 0) === 0;
    // Fonts whose default features hold more than ligature lookups (contextual alternates, a chain that rewrites a mark)
    // take the full stage, ahead of the ligature pass so the ligature bookkeeping starts from its component counts.
    for (let stageIdx = 0; stageIdx < 4; stageIdx++) {
      applyMappedStage((reader) => {
        const stages = reader.defaultStages(optionalLigatures, disabled);
        if (!stages) return null;
        // With rlig/liga switched off the ligature pass is off too, so the stage keeps only what is left in it.
        const tags = (stages[stageIdx] || []).filter(
          (t) => !ligaDisabled || (t !== 'rlig' && t !== 'liga'),
        );
        return tags.length ? tags : null;
      });
    }
    let ligComponents = requiredComponents || new Array(gids.length).fill(1);
    let ligCompIdx = requiredMarkIndices || new Array(gids.length).fill(-1);
    if (!ligaDisabled) {
      const newCps = [],
        newGids = [],
        newClusterStarts = [],
        newWordStarts = [],
        newFonts = [],
        newLigComps = [],
        newLigCompIdx = [];
      const newSourceClusters = trackSourceClusters ? [] : null;
      const mergedSourceClusters = new Map();
      const sourceClusterRoot = (cluster) => {
        while (mergedSourceClusters.has(cluster)) cluster = mergedSourceClusters.get(cluster);
        return cluster;
      };
      let i = 0;
      while (i < gids.length) {
        // Same-font run boundary + slice computed ONCE per run — a
        // per-glyph rescan-to-end would be O(n²) on single-font text (~N²/2
        // comparisons per span per layout).
        // A run also ends where the script does: ligature lookups belong
        // to one language system, and HarfBuzz shapes one script per run.
        let runEnd = i + 1;
        while (
          runEnd < gids.length &&
          fonts[runEnd] === fonts[i] &&
          scriptTagsAt(runEnd) === scriptTagsAt(i)
        )
          runEnd++;
        const fGsub = gsubOf(fonts[i]);
        selectScript(fGsub, i);
        const wholeArr = i === 0 && runEnd === gids.length;
        const runSlice = wholeArr ? gids : gids.slice(i, runEnd);
        const runBase = wholeArr ? 0 : i;
        const runHasLiga =
          fGsub && fGsub.hasLigatures && !fGsub.defaultStages(optionalLigatures, disabled);
        while (i < runEnd) {
          const hit =
            runHasLiga && gids[i] !== 0
              ? fGsub.tryMatchLigature(runSlice, i - runBase, optionalLigatures)
              : null;
          if (hit && hit.consumed > 0 && i + hit.consumed <= runEnd) {
            // compPos is in run-slice coordinates; shift to absolute. Absent
            // (contiguous match, no filter) means every position in the span
            // was a component and nothing was skipped.
            const compAbs = hit.compPos ? hit.compPos.map((q) => q + runBase) : null;
            const componentRows = compAbs || Array.from({ length: hit.consumed }, (_, k) => i + k);
            const compCount = componentRows.reduce((n, row) => n + ligComponents[row], 0);
            if (trackSourceClusters) {
              const clusters = sourceClusters.slice(i, i + hit.consumed).map(sourceClusterRoot);
              const root = Math.min(...clusters);
              for (const cluster of clusters)
                if (cluster !== root) mergedSourceClusters.set(cluster, root);
            }
            newGids.push(hit.replacement);
            newCps.push(cps[i]);
            newClusterStarts.push(clusterStarts[i]);
            if (trackSourceClusters) newSourceClusters.push(sourceClusters[i]);
            newWordStarts.push(wordStarts[i]);
            newFonts.push(fonts[i]);
            newLigComps.push(compCount);
            newLigCompIdx.push(-1);
            // Re-emit the marks the filter skipped over, in order, each
            // carrying the 0-based component it was written after.
            if (compAbs && hit.consumed > compAbs.length) {
              let seen = 0,
                componentsBefore = 0,
                ownerStart = 0;
              for (let q = i; q < i + hit.consumed; q++) {
                if (seen < compAbs.length && compAbs[seen] === q) {
                  ownerStart = componentsBefore;
                  componentsBefore += ligComponents[q];
                  seen++;
                  continue;
                }
                newGids.push(gids[q]);
                newCps.push(cps[q]);
                newClusterStarts.push(clusterStarts[q]);
                if (trackSourceClusters) newSourceClusters.push(sourceClusters[i]);
                newWordStarts.push(wordStarts[q]);
                newFonts.push(fonts[q]);
                newLigComps.push(1);
                newLigCompIdx.push(
                  ligCompIdx[q] >= 0
                    ? ownerStart + ligCompIdx[q]
                    : Math.max(0, componentsBefore - 1),
                );
              }
            }
            i += hit.consumed;
          } else {
            newGids.push(gids[i]);
            newCps.push(cps[i]);
            newClusterStarts.push(clusterStarts[i]);
            if (trackSourceClusters) newSourceClusters.push(sourceClusters[i]);
            newWordStarts.push(wordStarts[i]);
            newFonts.push(fonts[i]);
            newLigComps.push(ligComponents[i]);
            newLigCompIdx.push(ligCompIdx[i]);
            i++;
          }
        }
      }
      _replaceInPlace(ligComponents, newLigComps);
      _replaceInPlace(ligCompIdx, newLigCompIdx);
      _replaceInPlace(cps, newCps);
      _replaceInPlace(gids, newGids);
      _replaceInPlace(clusterStarts, newClusterStarts);
      if (trackSourceClusters)
        _replaceInPlace(sourceClusters, newSourceClusters.map(sourceClusterRoot));
      _replaceInPlace(wordStarts, newWordStarts);
      _replaceInPlace(fonts, newFonts);
    }

    // Requested features, each a stage: `dlig` and friends change the glyph count, and the arrays follow the source map.
    if (featureTags.length > 0 && gids.length > 0) {
      requiredComponents = ligComponents;
      requiredMarkIndices = ligCompIdx;
      for (const tag of featureTags)
        applyMappedStage(tag, null, null, !AUTOMATIC_GSUB_FEATURES.has(tag));
      ligComponents = requiredComponents;
      ligCompIdx = requiredMarkIndices;
    }

    // Surviving cluster starts partition the original span, including every
    // character consumed by a ligature. Sort logical offsets after shaping so
    // reordering and repeated mark clusters do not change the source ranges.
    let sourceClusterEnds = null;
    if ((jstfOn || layout._jstfPass) && sourceClusters) {
      const starts = [...new Set(sourceClusters)].sort((a, b) => a - b);
      sourceClusterEnds = new Map(
        starts.map((start, i) => [
          start,
          i + 1 < starts.length ? starts[i + 1] : spanOffset + span.text.length,
        ]),
      );
    }
    let prevGid = 0;
    let prevFont = null;
    let prevSlotRef = null; // the slot object of prevGid: a pair's first-glyph placement lands on it
    let prevBaseGid = 0,
      prevBaseFont = null,
      prevBaseSlot = null; // the same for the last glyph that is not a mark
    let pairConsumed = false; // the last pair's PairPos declared a second value record: HarfBuzz consumed that second glyph, so it starts no pair
    // Break actions before each glyph (UAX #14), with the previous spans'
    // tail as left context. Only wrapping layouts consult them.
    let breakBefore = null,
      breakOff = 0;
    if (wrap) {
      breakOff = lbTail.length;
      const seq = breakOff ? lbTail.concat(cps) : cps;
      breakBefore = lineBreakActions(seq);
      lbTail = seq.length > LB_TAIL ? seq.slice(seq.length - LB_TAIL) : seq.slice();
    }
    // Joined (cursive) scripts take no letter-spacing between letters.
    let joinsNext = null;
    if ((span.style.cspaceEm || 0) !== 0) {
      const arabic = getArabicShaping();
      if (arabic && cps.some(arabic.isArabicCodepoint)) {
        const forms = arabic.resolveArabicForms(cps);
        joinsNext = new Uint8Array(cps.length);
        for (let k = 0; k < cps.length; k++) {
          if (
            arabic.getArabicJoiningType(cps[k]) !== arabic.ArabicJoiningType.T &&
            (forms[k] === ARABIC_FORM_INIT || forms[k] === ARABIC_FORM_MEDI)
          )
            joinsNext[k] = 1;
        }
      }
    }
    for (let idx = 0; idx < gids.length; idx++) {
      const cp = cps[idx];
      let gid = gids[idx];
      const slotFont = fonts[idx];
      if (isHardBreakCp(cp)) {
        if (cp === 0x0a && afterCr) {
          afterCr = false;
          continue;
        }
        afterCr = cp === 0x0d;
        trimHangingSpaces();
        endLine();
        lineForcedEnd[lines.length - 1] = true;
        needsFinalLine = true;
        hasHardBreak = true;
        // A paragraph separator (LF, CR, NEL, PS) ends a UAX #9 P1 paragraph:
        // the bidi pass resolves each paragraph independently. LS, VT and FF
        // start a new line inside the same paragraph.
        if (isParagraphBreakCp(cp) && lines.length) lines[lines.length - 1]._paraEnd = true;
        dropLeadingSpaces = false;
        prevGid = 0;
        prevFont = null;
        prevSlotRef = null;
        pairConsumed = false;
        prevBaseGid = 0;
        prevBaseFont = null;
        prevBaseSlot = null;
        continue;
      }
      afterCr = false;
      if (
        dropLeadingSpaces &&
        curLine.length === 0 &&
        (cp === 0x20 || cp === 0x09) &&
        !span.style.nobr
      )
        continue;

      // Positioning features (kern, mark, mkmk, curs) come from this
      // slot's own script, exactly as the substitutions above do.
      const slotUsesKerx = usesKerx(slotFont);
      if (!slotUsesKerx) selectScript(slotFont.gpos, idx);

      const isIgnorable = isDefaultIgnorable(cp);

      //
      let slotMathAssembly = null;
      const _math = getMathStretchy();
      if (
        _math &&
        gid !== 0 &&
        slotFont.math.hasTable &&
        slotFont.math.hasMathVariants &&
        _math.isCodepointStretchy(cp)
      ) {
        const constants = slotFont.math.getConstants();
        const target = _math.targetStretchHeight(cp, constants);
        if (target > 0) {
          const axis = _math.isAlwaysStretchy(cp, 'h') ? 'h' : 'v';
          // First try pre-built variants — fastest path, single gid.
          const baseGid9 = gid;
          const variantGid = slotFont.math.pickVariantForSize(gid, target, axis);
          gid = variantGid;

          let variantAdv = 0;
          const mv9 = slotFont.math.getMathVariants(baseGid9, axis);
          if (mv9) {
            for (const rec9 of mv9.variants) {
              if (rec9.glyphID === variantGid) {
                variantAdv = rec9.advance;
                break;
              }
            }
          }
          const targetAxisAdv = target; // already in font units (height for the v-axis)
          if (variantAdv < targetAxisAdv) {
            // The assembly recipe lives on the BASE glyph's
            // MathGlyphConstruction (gid was reassigned to the variant).
            const asm = slotFont.math.buildAssembly(baseGid9, target, axis);
            if (asm && asm.parts.length > 1) {
              slotMathAssembly = { axis, asm };
            }
          }
        }
      }

      // Per-slot metrics — every em-space quantity normalizes by this
      // font's unitsPerEm so mixed-font runs compose correctly.
      const slotInvUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;
      // `disabledFeatures: ['kern']` opts out of pair-kerning AND of
      // GPOS SinglePos xAdvance deltas. Both are kern-family
      // adjustments — the SinglePos delta is what GPOS calls the
      // per-glyph X-advance shift, which a caller wanting tabular
      // figures expects suppressed alongside pair kerning.
      // GPOS reads the features of the glyph's own script and language system, as GSUB does.
      const slotKern =
        (!kernDisabled && slotFont.hasAnyKerning) ||
        (!slotUsesKerx && slotFont.gpos.hasAlwaysOnPositioning);

      const sizeScale = span.style.sizeScale;
      const widthScale = span.style.widthScale > 0 ? span.style.widthScale : 1;
      // Variation-aware advance when layout.varCoords is supplied for a
      // variable font; getGlyphAdvanceVar resolves HVAR → gvar phantom points
      // → static internally (so HVAR-less VFs still vary). Non-variable / no
      // coords fall back to static hmtx via getMetricsByGid.
      // A space the font does not map draws its U+0020 glyph at HarfBuzz's
      // fallback width (hb-ot-shape-fallback.cc).
      let fallbackAdv = -1;
      if (gid === 0 && _spaceFallbackKind(cp) !== 0) {
        const spaceGid = slotFont.codepointToGlyphId(0x20);
        if (spaceGid !== 0) {
          gid = spaceGid;
          fallbackAdv = _fallbackSpaceAdvance(cp, slotFont, spaceGid);
        }
      }
      // A tab (CSS Text 3 `tab-size`): drawn as the font's space (never .notdef), advancing to the next tab stop.
      let isTab = false;
      if (cp === 0x09) {
        const spaceGid = slotFont.codepointToGlyphId(0x20);
        if (spaceGid !== 0) {
          gid = spaceGid;
          isTab = true;
        }
      }
      const natAdv =
        fallbackAdv >= 0
          ? fallbackAdv
          : varCoords != null && slotFont.isVariable
            ? slotFont.getGlyphAdvanceVar(gid, varCoords)
            : slotFont._advanceByGid(gid);
      // GPOS SinglePos (lookup type 1) xAdvance delta — composed
      // additively with the natural advance before width-scaling.
      const singlePosFu =
        !slotUsesKerx && slotKern && gid !== 0
          ? slotFont.gpos.getSingleXAdvanceDelta(gid, kernDisabled)
          : 0;
      const singlePosDelta = singlePosFu * slotInvUpem;
      // Value-record fields beyond the x advance (xPlacement, yPlacement and, in upright vertical text, yAdvance), from
      // fonts that carry them in a 'kern' SinglePos/PairPos record: the glyph is drawn offset and the pen is untouched.
      let gposDxEm = 0,
        gposDyEm = 0,
        gposYAdvEm = 0;
      if (!slotUsesKerx && slotKern && gid !== 0 && slotFont.gpos.hasPositionValues(kernDisabled)) {
        const sv = slotFont.gpos.getSingleValues(gid, kernDisabled);
        if (sv) {
          gposDxEm = sv[0] * slotInvUpem * widthScale * sizeScale;
          gposDyEm = -sv[1] * slotInvUpem * sizeScale; // +Y up -> +Y down
          gposYAdvEm = sv[3] * slotInvUpem * sizeScale;
        }
      }
      let pairBAdvEm = 0;
      // Ot math italic correction — for math-equipped fonts, slanted
      // math italic glyphs (U+1D400..U+1D7FF range) carry an italic-
      // correction value that adds extra X advance so the next glyph
      // doesn't overlap the slant. Real strings like '𝑓+' or '𝑓(𝑥)'
      // need this; ASCII fonts return 0 (no MATH table). HarfBuzz's
      // simple model: always add to advance; explicit kern between
      // italic+italic pairs can subtract if needed.
      // italicCorrFu is in FONT UNITS; natAdv is in EM units (already
      // / unitsPerEm). Scale to em.
      const italicCorrFu =
        gid !== 0 && slotFont.math.hasTable ? slotFont.math.getItalicCorrection(gid) : 0;
      const italicCorrEm = italicCorrFu * slotInvUpem;
      const mspace = span.style.mspaceEm || 0;
      const cspace = joinsNext !== null && joinsNext[idx] === 1 ? 0 : span.style.cspaceEm || 0;
      // Word-spacing (SVG/CSS): extra advance on word separators only.
      const wspace =
        (span.style.wspaceEm || 0) && (cp === 0x20 || cp === 0xa0) ? span.style.wspaceEm : 0;
      let adv = isIgnorable
        ? 0
        : mspace > 0
          ? mspace * sizeScale
          : ((natAdv + singlePosDelta + italicCorrEm) * widthScale + cspace + wspace) * sizeScale;
      // compat 'harfbuzz': AAT 'trak' tracking at the layout's point size (HarfBuzz assumes 12 pt when none is given).
      if (harfbuzzCompat && adv !== 0 && mspace <= 0 && !isIgnorable && slotFont.trak.hasTrak)
        adv +=
          slotFont.trak.getHorizontalTracking(layout.ptem > 0 ? layout.ptem : 12) *
          slotInvUpem *
          widthScale *
          sizeScale;
      if (isTab && mspace <= 0 && !isIgnorable) {
        // The tab stops are the multiples of tab-size from the start of the line: `layout.tabSize` spaces (default 8, each the
        // advance of U+0020 with its letter- and word-spacing, as the spec measures it) or `layout.tabSizeEm` of absolute length.
        const spaceFull =
          ((natAdv + singlePosDelta) * widthScale + cspace + (span.style.wspaceEm || 0)) *
          sizeScale;
        const tabW =
          layout.tabSizeEm > 0
            ? layout.tabSizeEm
            : (layout.tabSize >= 0 ? layout.tabSize : 8) * spaceFull;
        if (tabW > 0) {
          const at = curLineAdv + (layout.tabOriginEm || 0);
          adv = tabW - (at - Math.floor(at / tabW) * tabW);
        }
      }

      // Pair kerning — only between same-font adjacent slots (kerning
      // pairs are font-local; no cross-font kern).
      const posPending = pendingPosOverride !== null;
      const consumed = pairConsumed;
      if (!isIgnorable) pairConsumed = false;
      // AAT 'kerx' and legacy 'kern' pairs are formed between non-marks (HarfBuzz runs that machine with IgnoreMarks);
      // a GPOS lookup states its own flags.
      const kernMachine = slotUsesKerx || !slotFont.gpos.hasKerning;
      // (a glyph a ligature action folded several characters into starts no pair either)
      const kernSkipsThis =
        kernMachine &&
        (slotFont.gdef.hasGlyphClasses
          ? gid !== 0 && slotFont.gdef.getGlyphClass(gid) === 3
          : _isMarkCodepoint(cp));
      const kernLeftLigated = kernMachine && prevSlotRef !== null && prevSlotRef.ligComponents > 1;
      if (
        !posPending &&
        !consumed &&
        mspace <= 0 &&
        slotKern &&
        !isIgnorable &&
        !kernSkipsThis &&
        !kernLeftLigated &&
        prevGid !== 0 &&
        gid !== 0 &&
        prevFont === slotFont
      ) {
        // Pair kerning is an X advance. In upright vertical text the flow runs along y and HarfBuzz applies no x kerning there (the
        // vertical pair values below still do); in mixed orientation a pair is vertical when both of its glyphs stand upright.
        const verticalPair =
          inlineVertical === 'upright' ||
          (inlineVertical === 'mixed' &&
            prevSlotRef !== null &&
            isCjkOrUprightCodepoint(cp | 0) &&
            isCjkOrUprightCodepoint(prevSlotRef.codepoint | 0));
        // A GPOS lookup states its own flags: when a mark is involved, each lookup says which glyph it pairs this one with.
        const markPair =
          !kernMachine &&
          slotFont.gdef.hasGlyphClasses &&
          (slotFont.gdef.getGlyphClass(prevGid) === 3 || slotFont.gdef.getGlyphClass(gid) === 3);
        const adjacentGid = markPair ? prevGid : -1;
        const kFu = markPair
          ? slotFont.gpos.getPairKerning(prevGid, gid, kernDisabled, adjacentGid)
          : pairKerning(slotFont, prevGid, gid, kernDisabled);
        if (kFu !== 0 && !verticalPair) {
          curLineAdv += kFu * slotInvUpem * widthScale * sizeScale;
          // A pair value belongs to the logically first glyph's advance; the bidi reorder re-derives the pens from advances.
          if (prevSlotRef !== null)
            prevSlotRef.kernAfterEm =
              (prevSlotRef.kernAfterEm || 0) + kFu * slotInvUpem * widthScale * sizeScale;
          // AAT kerning (kerx, kern) splits the value over the pair: the first glyph's advance takes the half rounded down,
          // so the marks that sit between the two move with it (HarfBuzz hb_kern_machine_t).
          if (
            kernMachine &&
            prevSlotRef !== null &&
            curLine.length > 0 &&
            curLine[curLine.length - 1] !== prevSlotRef
          ) {
            const half = (kFu >> 1) * slotInvUpem * widthScale * sizeScale;
            for (let q = curLine.length - 1; q >= 0 && curLine[q] !== prevSlotRef; q--)
              curLine[q].penX += half;
          }
        }
        const applyPairValues = (pv, first) => {
          // first glyph: placement moves the glyph already laid out (its own scales), y advance the flow in upright text
          if (first) {
            const ps = first.style,
              pw = ps.widthScale > 0 ? ps.widthScale : 1;
            if (pv[0] !== 0)
              first.gposDxEm = (first.gposDxEm || 0) + pv[0] * slotInvUpem * pw * ps.sizeScale;
            if (pv[1] !== 0)
              first.gposDyEm = (first.gposDyEm || 0) - pv[1] * slotInvUpem * ps.sizeScale;
          }
          if (inlineVertical === 'upright' && pv[3] !== 0)
            curLineAdv += pv[3] * slotInvUpem * sizeScale;
          // second glyph: placement, x advance (its own, after it), y advance in upright text
          gposDxEm += pv[4] * slotInvUpem * widthScale * sizeScale;
          gposDyEm -= pv[5] * slotInvUpem * sizeScale;
          pairBAdvEm += pv[6] * slotInvUpem * widthScale * sizeScale;
          gposYAdvEm += pv[7] * slotInvUpem * sizeScale;
          if (pv[8] === 1) pairConsumed = true;
        };
        if (!slotUsesKerx && slotFont.gpos.hasPositionValues(kernDisabled)) {
          const pv = slotFont.gpos.getPairValues(prevGid, gid, kernDisabled, adjacentGid);
          if (pv) applyPairValues(pv, prevSlotRef);
        }
        // The lookups that do not see the mark before this glyph pair it with the base behind that mark.
        if (
          markPair &&
          prevBaseSlot !== null &&
          prevBaseGid !== prevGid &&
          prevBaseFont === slotFont
        ) {
          const kBase = slotFont.gpos.getPairKerning(prevBaseGid, gid, kernDisabled, adjacentGid);
          if (kBase !== 0 && !verticalPair) {
            curLineAdv += kBase * slotInvUpem * widthScale * sizeScale;
            prevBaseSlot.kernAfterEm =
              (prevBaseSlot.kernAfterEm || 0) + kBase * slotInvUpem * widthScale * sizeScale;
          }
          if (!slotUsesKerx && slotFont.gpos.hasPositionValues(kernDisabled)) {
            const pv = slotFont.gpos.getPairValues(prevBaseGid, gid, kernDisabled, adjacentGid);
            if (pv) applyPairValues(pv, prevBaseSlot);
          }
        }
      }

      // Single-shot <pos> override: place this glyph at PosEm.
      if (posPending) {
        curLineAdv = pendingPosOverride;
        pendingPosOverride = null;
      }

      // BreakKind: 0 none, 1 collapsible space, 2 a UAX #14 opportunity
      // precedes the slot. Candidates are recorded below, once the slot's
      // place on the line is known.
      const isCollapsibleSpace = (cp === 0x20 || cp === 0x09) && !span.style.nobr;
      const clusterStart = clusterStarts[idx];
      let breakKind = isCollapsibleSpace ? 1 : 0;
      if (wrap) {
        if (isCollapsibleSpace) {
          if (spaceRunStart < 0) spaceRunStart = curLine.length;
        } else {
          // Break after a run of spaces or directly before this slot; never
          // at the line start, never inside a cluster, never in <nobr>.
          if (clusterStart && !span.style.nobr && breakBefore[breakOff + idx] !== PROHIBITED) {
            const cut = spaceRunStart >= 0 ? spaceRunStart : curLine.length;
            if (cut > 0) {
              candCut.push(cut);
              candCarry.push(curLine.length);
              candPref.push(spaceRunStart >= 0 || wordStarts[idx]);
              breakKind = 2;
            }
          }
          spaceRunStart = -1;
        }
      }
      if (!isCollapsibleSpace) dropLeadingSpaces = false;

      //
      // Mark stacking: a mark following another mark goes through
      // the 'mkmk' lookup against the previous mark; non-stacked
      // marks go through 'mark' against the preceding non-mark.
      let slotAdvance = adv + pairBAdvEm;
      let attachToIdx = -1; // index INTO this LINE to anchor against
      let attachDxEm = 0;
      let attachDyEm = 0;
      // Mark detection. A codepoint is a "mark" for GPOS attachment
      // purposes if it has no advance of its own and anchors on a base:
      //   - Arabic transparent harakat / Quranic annotation marks
      //   - Thai/Lao tone marks + above/below vowels
      //   - Combining marks for symbols (U+20D0..U+20FF) — math accents
      //     like \hat{x}, \vec{x}, etc.
      // The Arabic + Thai predicates dereference the registry; when a
      // script isn't registered, that script's mark contribution is 0
      // (correct: if the consumer didn't enable Arabic shaping they
      // won't have Arabic content needing transparent-mark anchoring).
      const _arabicMark = getArabicShaping();
      const _thaiMark = getThaiShaping();
      const isMathMark = (c) => c >= 0x20d0 && c <= 0x20ff;
      // A mark is also any glyph the font's GDEF class says is one: a substitution can leave a mark glyph (a dot split off a
      // letter) with no codepoint of its own.
      // With a GDEF glyph class definition the font names its marks (HarfBuzz reads them from there); without one they are the
      // combining characters.
      const isMarkAt = (cp) =>
        (_arabicMark && _arabicMark.getArabicJoiningType(cp) === _arabicMark.ArabicJoiningType.T) ||
        (_thaiMark && _thaiMark.isThaiLaoMark(cp)) ||
        isMathMark(cp);
      const isMarkOf = (f, g, c) =>
        isMathMark(c) ||
        (f.gdef.hasGlyphClasses ? g !== 0 && f.gdef.getGlyphClass(g) === 3 : isMarkAt(c));
      const isMarkCp = isMarkOf(slotFont, gid, cp);
      const isMarkSlot = (s) => isMarkOf(s.font, s.glyphId, s.codepoint);
      if (isMarkCp && curLine.length > 0 && gid !== 0) {
        // Find preceding non-mark slot AND immediate previous slot.
        let prevSlotIdx = -1,
          prevSlot = null;
        let lastBaseIdx = -1,
          lastBaseSlot = null;
        for (let j = curLine.length - 1; j >= 0; j--) {
          const s = curLine[j];
          if (s.font !== slotFont) break;
          if (prevSlotIdx === -1) {
            prevSlotIdx = j;
            prevSlot = s;
          }
          if (!isMarkSlot(s)) {
            lastBaseIdx = j;
            lastBaseSlot = s;
            break;
          }
        }
        const gpos = slotFont.gpos;
        let att = null;
        let targetIdx = -1;
        if (!slotUsesKerx && prevSlot && isMarkSlot(prevSlot) && gpos.hasMarkMark) {
          att = gpos.getMarkMarkAttachment(prevSlot.glyphId, gid);
          if (att) targetIdx = prevSlotIdx;
        }
        if (!slotUsesKerx && !att && lastBaseSlot && gpos.hasMarkBase) {
          // GPOS type 5 — MarkLigPos. When the prior base is itself
          // a ligature (≥2 components), try the per-component anchor
          // table first. The component index for a trailing mark is
          // the last component (compCount - 1) under the HarfBuzz
          // "default to final" heuristic — sufficient for the common
          // case where one mark binds to a ligature.
          if (lastBaseSlot.ligComponents > 1) {
            const own = ligCompIdx[idx];
            const compIdx =
              own >= 0
                ? Math.min(own, lastBaseSlot.ligComponents - 1)
                : lastBaseSlot.ligComponents - 1;
            att = gpos.getMarkLigAttachment(lastBaseSlot.glyphId, gid, compIdx);
            if (att) targetIdx = lastBaseIdx;
          }
          if (!att) {
            att = gpos.getMarkBaseAttachment(lastBaseSlot.glyphId, gid);
            if (att) targetIdx = lastBaseIdx;
          }
        }

        if (!att && lastBaseSlot && slotFont.math.hasTable && isMathMark(cp)) {
          const baseAcc = slotFont.math.getTopAccentAttachment(lastBaseSlot.glyphId);
          if (!Number.isNaN(baseAcc)) {
            const markAdvFu = slotFont.getMetricsByGid(gid).advance * slotFont.unitsPerEm;
            att = { dx: baseAcc - markAdvFu * 0.5, dy: 0 };
            targetIdx = lastBaseIdx;
          }
        }
        if (att) {
          attachToIdx = targetIdx;
          attachDxEm = att.dx * slotInvUpem * widthScale * sizeScale;
          attachDyEm = -att.dy * slotInvUpem * sizeScale; // +Y up → +Y down
        }
        if (marksLoseAdvance(slotFont, cp, slotUsesKerx)) slotAdvance = 0;
      }

      // GPOS type 3 (cursive). Two adjacent same-font non-mark glyphs with cursive anchors stitch their baselines together: the
      // first glyph's exit anchor lands on the second's entry anchor. Y only (X is implicit via font-designer anchor placement
      // matching the advance widths). One of the pair is the child that moves: with the lookup's RIGHT_TO_LEFT bit (real Arabic
      // Naskh and Nastaliq fonts) the FIRST glyph, so the chain hangs from its last glyph on the baseline; otherwise the SECOND
      // (HarfBuzz CursivePosFormat1). Offsets add up along a chain, so they resolve per line (_resolveCursiveChains) when every
      // link is known. Mark glyphs don't participate (they ride their bases).
      let cursivePrevIdx = -1,
        cursiveDyEm = 0,
        cursiveRtl = false;
      let slotCursiveExit = null;
      if (!slotUsesKerx && !isMarkCp && gid !== 0 && slotFont.gpos.hasCursive) {
        const myAnch = slotFont.gpos.getCursiveAnchors(gid);
        if (myAnch && myAnch.entry && prevFont === slotFont) {
          // Find prev non-mark same-font slot for the exit/entry join.
          let prevBaseIdx = -1;
          for (let j = curLine.length - 1; j >= 0; j--) {
            const s = curLine[j];
            if (s.font !== slotFont) break;
            if (!isMarkSlot(s)) {
              prevBaseIdx = j;
              break;
            }
          }
          if (prevBaseIdx >= 0 && curLine[prevBaseIdx].cursiveExit) {
            const dyFu = curLine[prevBaseIdx].cursiveExit.y - myAnch.entry.y;
            cursivePrevIdx = prevBaseIdx;
            cursiveDyEm = -dyFu * slotInvUpem * sizeScale; // +Y up -> +Y down: the second glyph's pen relative to the first's
            cursiveRtl = myAnch.rtl;
          }
        }
        slotCursiveExit = myAnch && myAnch.exit ? myAnch.exit : null;
      }
      let crossAdvance = slotAdvance;
      if (inlineVertical !== null && slotAdvance !== 0 && mspace <= 0) {
        const upright =
          inlineVertical === 'upright' ||
          (inlineVertical === 'mixed' && isCjkOrUprightCodepoint(cp | 0));
        if (upright) {
          if (varCoords != null && typeof slotFont.getGlyphVerticalAdvanceVar === 'function') {
            slotAdvance = slotFont.getGlyphVerticalAdvanceVar(gid, varCoords) * sizeScale;
          } else if (typeof slotFont.getVerticalMetricsByGid === 'function') {
            const vm = slotFont.getVerticalMetricsByGid(gid);
            if (vm && vm.advanceHeight) slotAdvance = vm.advanceHeight * sizeScale;
          }
          slotAdvance += gposYAdvEm; // GPOS yAdvance grows the advance along the flow (HarfBuzz: y_advance -= value, y down)
        }
      }
      // A zero-advance slot (mark, ignorable) rides its predecessor; the vertical
      // layout reads its offset from the predecessor's HORIZONTAL advance.
      let slotPenX = curLineAdv;
      if (inlineVertical !== null && crossAdvance === 0 && curLine.length > 0) {
        const prev = curLine[curLine.length - 1];
        slotPenX = curLineAdv - prev.advance + prev.crossAdvance;
      }
      const slot = {
        codepoint: cp,
        glyphId: gid,
        style: span.style,
        font: slotFont,
        penX: slotPenX,
        penY: 0,
        advance: slotAdvance,
        breakKind,
        clusterStart,
        synthBold,
        synthItalic,
        attachToIdx,
        attachDxEm,
        attachDyEm,
        cursiveExit: slotCursiveExit,
        ligComponents: ligComponents[idx] || 1,
        mathAssembly: slotMathAssembly,
        ignorable: isIgnorable,
      };
      if (cursivePrevIdx >= 0) {
        slot.cursivePrevIdx = cursivePrevIdx;
        slot.cursiveDyEm = cursiveDyEm;
        slot.cursiveRtl = cursiveRtl;
      }
      if (trackSourceClusters) slot.sourceCluster = sourceClusters[idx];
      if (sourceClusterEnds) slot.sourceClusterEnd = sourceClusterEnds.get(sourceClusters[idx]);
      if (inlineVertical !== null) slot.crossAdvance = crossAdvance;
      if (gposDxEm !== 0) slot.gposDxEm = gposDxEm;
      if (gposDyEm !== 0) slot.gposDyEm = gposDyEm;
      curLine.push(slot);
      // Default-ignorable slots are invisible and transparent: leave the
      // prev-glyph context (kerning pair, LB14 CJK) pointing at the last
      // VISIBLE glyph so a selector/joiner between two letters doesn't
      // break their kern pair or line-break decision.
      if (!isIgnorable && !kernSkipsThis) {
        prevGid = gid;
        prevFont = slotFont;
        prevSlotRef = slot;
        if (!slotFont.gdef.hasGlyphClasses || slotFont.gdef.getGlyphClass(gid) !== 3) {
          prevBaseGid = gid;
          prevBaseFont = slotFont;
          prevBaseSlot = slot;
        }
      }

      const next = curLineAdv + slotAdvance;
      // A collapsible space hangs: only a following slot can overflow the line.
      if (
        wrap &&
        !isCollapsibleSpace &&
        next > lineUsableMax() &&
        candCut.length > 0 &&
        curLine.length > 1
      ) {
        // Prefer the latest word-aware candidate; fall back to the latest one
        // (CJK text the word segmenter could not split).
        let pick = candCut.length - 1;
        for (let k = pick; k >= 0; k--)
          if (candPref[k]) {
            pick = k;
            break;
          }
        const cut = candCut[pick],
          carryStart = candCarry[pick];
        const restCut = [],
          restCarry = [],
          restPref = [];
        for (let k = pick + 1; k < candCut.length; k++) {
          restCut.push(candCut[k] - carryStart);
          restCarry.push(candCarry[k] - carryStart);
          restPref.push(candPref[k]);
        }
        const carry = curLine.slice(carryStart);
        curLineAdv = curLine[cut].penX;
        curLine.length = cut;
        endLine();
        dropLeadingSpaces = true;
        candCut = restCut;
        candCarry = restCarry;
        candPref = restPref;
        let penX = curLineAdv;
        let lastGid = 0;
        let lastFont = null;
        let lastCp = 0;
        for (const s of carry) {
          const cw = s.style.widthScale > 0 ? s.style.widthScale : 1;
          const sFont = s.font;
          const sInvUpem = sFont.unitsPerEm > 0 ? 1 / sFont.unitsPerEm : 0;
          if (
            (s.style.mspaceEm || 0) <= 0 &&
            ((!kernDisabled && sFont.hasAnyKerning) ||
              (!usesKerx(sFont) && sFont.gpos.hasRequiredFeature)) &&
            lastGid !== 0 &&
            s.glyphId !== 0 &&
            lastFont === sFont
          ) {
            const kFu = pairKerning(sFont, lastGid, s.glyphId, kernDisabled);
            const verticalPair =
              inlineVertical === 'upright' ||
              (inlineVertical === 'mixed' &&
                isCjkOrUprightCodepoint(s.codepoint | 0) &&
                isCjkOrUprightCodepoint(lastCp | 0));
            if (kFu !== 0 && !verticalPair) penX += kFu * sInvUpem * cw * s.style.sizeScale;
          }
          // attachToIdx indexes INTO THE LINE; the carried run starts a
          // new line at 0, so anchors shift by carryStart. An anchor
          // that stayed on the previous line is unreachable — drop the
          // attachment (unremapped indices would bind marks to whatever slot
          // sits at that index, or drop them silently).
          const at9 = s.attachToIdx >= carryStart ? s.attachToIdx - carryStart : -1;
          const carried = { ...s, penX, attachToIdx: at9 };
          // (a cursive link to a glyph left on the previous line is gone)
          if (s.cursivePrevIdx !== undefined)
            carried.cursivePrevIdx =
              s.cursivePrevIdx >= carryStart ? s.cursivePrevIdx - carryStart : -1;
          curLine.push(carried);
          penX += s.advance;
          lastGid = s.glyphId;
          lastFont = sFont;
          lastCp = s.codepoint;
        }
        curLineAdv = penX;
        prevGid = lastGid;
        prevFont = lastFont;
        prevSlotRef = curLine.length ? curLine[curLine.length - 1] : null;
        prevBaseGid = lastGid;
        prevBaseFont = lastFont;
        prevBaseSlot = prevSlotRef;
        if (carry.length) dropLeadingSpaces = false;
      } else {
        curLineAdv = next;
      }
    }
  }
  trimHangingSpaces();
  const trailingEmptyLine = curLine.length === 0 && needsFinalLine;
  if (curLine.length > 0 || lines.length === 0) endLine();

  const lineIsRtl = reorderLinesBidi(lines, layout, fallbacks);
  let jstfCtx = null;
  if (jstfOn) {
    const spanStarts = [];
    let at = 0;
    for (const sp of spans) {
      spanStarts.push(at);
      at += sp.text ? sp.text.length : 0;
    } // (a directive span may have no text)
    jstfCtx = {
      spans,
      spanStarts,
      text: spans.map((sp) => sp.text).join(''),
      graphemes: (text) => segmentGraphemes(text),
      scriptTagsOf: otScriptTags ? (cps) => otScriptTags.otScriptTagsPerCodepoint(cps) : null,
      // One line shaped again alone: no wrapping, no alignment, the paragraph's direction, and the trial's lookup changes.
      relayout: (subSpans, cfg, paragraphRtl) =>
        layoutSlots(
          subSpans,
          font,
          {
            ...layout,
            maxWidthEm: 0,
            layoutWidthEm: 0,
            align: 'left',
            lastLineAlign: 'auto',
            originX: 0,
            originY: 0,
            baseDirection: paragraphRtl ? BaseDirection.Rtl : BaseDirection.Ltr,
            _jstfPass: true,
            jstf: cfg || undefined,
          },
          true,
        ),
    };
  }
  const slots = emitAlignedSlots(
    lines,
    { lineAdvances, lineAlignOverride, lineHeights, lineUsableMaxes, lineForcedEnd },
    {
      layout,
      naturalLineHeight,
      defaultAlign,
      wrap,
      layoutBoxW,
      lineIsRtl,
      metrics,
      lineRanges,
      trailingEmptyLine,
      jstfCtx,
    },
  );
  if (!layout._jstfPass) applyAatContextualKerning(slots, usesKerx, preferAat, kernDisabled);
  if (lineRanges && !slots.length && !hasHardBreak) lineRanges.length = 0;
  return slots;
}

/// Cursive offsets of one line, in logical order: each child takes its parent's offset plus the link's, so the links read from
/// the root of each chain: backward for right-to-left lookups (the first glyph of a pair is the child), forward otherwise.
function _resolveCursiveChains(line) {
  for (let k = line.length - 1; k >= 0; k--) {
    const s = line[k];
    if (s.cursivePrevIdx >= 0 && s.cursiveRtl) line[s.cursivePrevIdx].penY = s.penY - s.cursiveDyEm;
  }
  for (let k = 0; k < line.length; k++) {
    const s = line[k];
    if (s.cursivePrevIdx >= 0 && !s.cursiveRtl)
      s.penY = line[s.cursivePrevIdx].penY + s.cursiveDyEm;
  }
}

// ---- layout pass 2: bidi reordering (per-line, resolved paragraph-wide) --
// Mutates `lines` in place (reordered slot arrays, mirrored glyphs, mark
// attachments applied post-reorder); returns, per line, whether its
// paragraph's base direction resolved RTL (drives right-anchored alignment
// in pass 3).
function reorderLinesBidi(lines, layout, fallbacks) {
  // Bidi: reorder per-line slots into visual order.
  //
  // Resolve once over the FULL paragraph codepoint stream so explicit
  // base-direction context is consistent across line boundaries; then
  // slice per-line. Each line gets reorderLine() applied and penX
  // reassigned to preserve advances. RTL paragraphs are also marked
  // for right-anchored emission below (xOff = slack instead of 0).
  const rawBase = layout.baseDirection != null ? layout.baseDirection : BaseDirection.Auto;
  const bidi = getBidi();
  // UAX #9 P1: rules apply per PARAGRAPH. Explicit '\n' breaks (marked
  // `_paraEnd` by the layout pass) delimit paragraphs; wrap-created
  // lines share their paragraph's resolution. Resolving the whole text
  // as one paragraph would leak RTL/LTR context across explicit breaks and,
  // under BaseDirection.Auto, give later paragraphs the FIRST line's
  // base direction.
  for (const line of lines) _resolveCursiveChains(line);
  const lineLevels = new Array(lines.length); // per line: Uint8Array slice
  const lineIsRtl = new Array(lines.length);
  for (let p0 = 0; p0 < lines.length;) {
    let p1 = p0;
    while (p1 < lines.length - 1 && !lines[p1]._paraEnd) p1++;
    const cps = [];
    for (let li = p0; li <= p1; li++) for (const s of lines[li]) cps.push(s.codepoint);
    const dir = bidi.resolveBaseDirection(rawBase, cps);
    const rtl = dir === BaseDirection.Rtl;
    for (let li = p0; li <= p1; li++) lineIsRtl[li] = rtl;
    const levels = bidi.resolveLevels(cps, dir);
    let cur = 0;
    for (let li = p0; li <= p1; li++) {
      lineLevels[li] = levels.subarray(cur, cur + lines[li].length);
      cur += lines[li].length;
    }
    p0 = p1 + 1;
  }
  // UAX #9 L4: a mirrorable character at an odd (RTL) level is drawn with its
  // mirrored glyph (e.g. '(' shows as ')').
  for (let li = 0; li < lines.length; li++) {
    const lv = lineLevels[li];
    const line = lines[li];
    for (let k = 0; k < line.length; k++) {
      const s = line[k];
      if (lv[k] & 1 && hasMirror(s.codepoint)) {
        const [mfont, mgid] = resolveGlyph(mirror(s.codepoint), s.font, fallbacks);
        if (mgid) {
          s.glyphId = mgid;
          s.font = mfont;
        }
      }
    }
  }
  for (let li = 0; li < lines.length; li++) {
    const lineLen = lines[li].length;
    if (lineLen === 0) continue;
    const lvSlice = lineLevels[li];
    const order = bidi.reorderLine(lvSlice);
    // Reassign penX so visually-ordered slots are left-to-right.
    // Build a logical→visual index map so per-slot attach pointers
    // can be remapped to their new positions.
    const orig = lines[li];
    let identity = true;
    for (let i = 0; i < order.length; i++)
      if (order[i] !== i) {
        identity = false;
        break;
      }
    let workingLine = orig;
    if (!identity) {
      let penX = orig[0].penX;
      const reord = new Array(lineLen);
      const logicalToVisual = new Array(lineLen);
      for (let v = 0; v < lineLen; v++) {
        const logIdx = order[v];
        logicalToVisual[logIdx] = v;
        const s = orig[logIdx];
        reord[v] = { ...s, penX };
        // (the last glyph's value, if any, was against one that wrapped to the next line)
        penX += s.advance + (logIdx === lineLen - 1 ? 0 : s.kernAfterEm || 0);
      }
      // Remap attachToIdx through the reorder.
      for (let v = 0; v < lineLen; v++) {
        const s = reord[v];
        if (s.attachToIdx >= 0) s.attachToIdx = logicalToVisual[s.attachToIdx];
      }
      lines[li] = reord;
      workingLine = reord;
    }
    // Apply mark attachments on the final (post-reorder) line. A base comes first whatever the visual order: in right-to-left text a
    // mark stands before its base and a stacked mark before the mark it sits on.
    const placed = new Uint8Array(lineLen);
    const place = (v) => {
      if (placed[v]) return;
      placed[v] = 1;
      const s = workingLine[v];
      if (s.attachToIdx >= 0) {
        const base = workingLine[s.attachToIdx];
        if (base) {
          place(s.attachToIdx);
          s.penX = base.penX + s.attachDxEm;
          s.penY = base.penY + s.attachDyEm;
        }
      }
      // GPOS value-record placement: after attachment, so a mark rides its base's offset (HarfBuzz propagates it)
      if (s.gposDxEm) s.penX += s.gposDxEm;
      if (s.gposDyEm) s.penY += s.gposDyEm;
    };
    for (let v = 0; v < lineLen; v++) place(v);
  }
  return lineIsRtl;
}

// ---- layout pass 3: alignment + slot emission ----------------------------
// Applies per-line alignment (incl. justify: kashida elongation then
// space distribution), the per-line baseline step, and the layout origin,
// emitting the final flat slot list.
function emitAlignedSlots(
  lines,
  { lineAdvances, lineAlignOverride, lineHeights, lineUsableMaxes, lineForcedEnd },
  {
    layout,
    naturalLineHeight,
    defaultAlign,
    wrap,
    layoutBoxW,
    lineIsRtl,
    metrics,
    lineRanges,
    trailingEmptyLine,
    jstfCtx,
  },
) {
  const slots = [];
  const ox = layout.originX || 0;
  const oy = layout.originY || 0;
  // Per-line baseline accumulator — supports <line-height> directives
  // that change the step mid-paragraph.
  let baselineAccum = 0;

  // A line grows with its largest sizeScale (CSS line-height: <number>): the
  // line's ascent share scales above the baseline and its descent share below,
  // so a larger span neither overlaps the line above nor the one below. The
  // base style is the strut, so no line shrinks below one.
  const lineScale = new Array(lines.length);
  let anyScaled = false;
  for (let li = 0; li < lines.length; li++) {
    let sc = 1;
    for (const s of lines[li]) {
      const z = s.style && s.style.sizeScale;
      if (z > sc) sc = z;
    }
    lineScale[li] = sc;
    if (sc !== 1) anyScaled = true;
  }
  const ascentShare =
    naturalLineHeight > 0 ? (metrics.ascent + metrics.lineGap * 0.5) / naturalLineHeight : 0.5;
  const descentShare = 1 - ascentShare;

  const lastLineAlign = layout.lastLineAlign || 'auto';
  for (let li = 0; li < lines.length; li++) {
    const effLh =
      lineHeights[li] > 0
        ? lineHeights[li]
        : layout.lineHeightEm > 0
          ? layout.lineHeightEm
          : naturalLineHeight;
    const baselineY = baselineAccum;
    const lineStart = slots.length;
    const nextScale = li + 1 < lines.length ? lineScale[li + 1] : 1;
    baselineAccum +=
      anyScaled && (lineScale[li] !== 1 || nextScale !== 1)
        ? effLh * (descentShare * lineScale[li] + ascentShare * nextScale)
        : effLh;
    let xOff = 0;
    let perSpaceExtra = 0; // for justify: extra em per breakKind=1 slot
    const effAlign = lineAlignOverride[li] || defaultAlign;
    // RTL paragraph base direction implies right anchor by default
    // when no explicit align was given.
    const paraIsRtl = lineIsRtl[li] === true;
    const effAlignFinal =
      lineAlignOverride[li] == null && defaultAlign === 'left' && paraIsRtl ? 'right' : effAlign;
    // text-align-last decoupling: last-line in 'justify' mode falls
    // back to plain align ('left' / 'right' under RTL). A line before a forced break is a last line too.
    const isLastLine = li === lines.length - 1 || lineForcedEnd[li] === true;
    let effLineAlign = effAlignFinal;
    if (effAlignFinal === 'justify' && isLastLine) {
      if (lastLineAlign === 'auto') effLineAlign = paraIsRtl ? 'right' : 'left';
      else effLineAlign = lastLineAlign;
    }
    // Align against the wrap width when wrapping, else against the fixed
    // layout-box width. Without either, single lines have no slack and
    // stay left (ink-tight behavior).
    let kashidaPlan = null; // JSTF Arabic elongation for this line
    const usableMax = wrap ? lineUsableMaxes[li] : layoutBoxW;
    if (usableMax > 0 && effLineAlign === 'justify' && jstfCtx) {
      // JSTF priorities first: shape the line again with the font's own suggestions for lengthening or shortening it.
      const r = justifyLineWithJstf(
        jstfCtx,
        lines[li],
        layout,
        usableMax - lineAdvances[li],
        paraIsRtl,
      );
      if (r) {
        const x0 = Math.min(...lines[li].map((s) => s.penX));
        lines[li] = r.slots.map((s) => ({ ...s, penX: s.penX + x0 }));
        lineAdvances[li] += r.delta;
      }
    }
    if (usableMax > 0 && effLineAlign !== 'left') {
      const slack = usableMax - lineAdvances[li];
      if (slack > 0) {
        if (effLineAlign === 'center') xOff = slack * 0.5;
        else if (effLineAlign === 'right') xOff = slack;
        else if (effLineAlign === 'justify') {
          // Arabic kashida elongation first (JSTF extender glyphs): insert
          // tatweel connectors at cursive joins to absorb slack. Whatever
          // a whole number of kashidas can't cover spills to the spaces.
          let remainingSlack = slack;
          kashidaPlan = planKashida(
            lines[li],
            slack,
            layout.varCoords || null,
            layout.inlineVertical || null,
          );
          if (kashidaPlan) remainingSlack -= kashidaPlan.usedAdvance;

          let spaceCount = 0;
          for (const s of lines[li]) if (s.breakKind === 1) spaceCount++;
          if (spaceCount > 0) perSpaceExtra = remainingSlack / spaceCount;
          // No spaces and no kashida (single-word Latin line that
          // overflowed): leave as-is.
        }
      }
    }
    let extraAcc = 0;
    for (let si = 0; si < lines[li].length; si++) {
      const s = lines[li][si];
      // penY is ADDITIVE: pass 2 stored GPOS mark-attach dy / cursive
      // chain dy in s.penY (0 for plain glyphs), so the baseline must be
      // ADDED here, not assigned, or harakat / tone marks lose their
      // attachment offsets. lineY carries the line identity for
      // downstream line-splitters (they must not infer it from penY).
      slots.push({
        ...s,
        penX: s.penX + xOff + ox + extraAcc,
        penY: s.penY + baselineY + oy,
        lineY: baselineY + oy,
      });
      // Inject extra after each space (the gap visually grows to the
      // right of the space character, before the next word).
      if (perSpaceExtra > 0 && s.breakKind === 1) extraAcc += perSpaceExtra;
      // Kashida insertions after this visual slot (JSTF justification):
      // emit `count` connector glyphs, each pushing the rest of the line
      // right by its advance.
      const kc = kashidaPlan && kashidaPlan.counts.get(si);
      if (kc) {
        const insertion = kashidaPlan.insertions.get(si);
        for (let n = 0; n < kc; n++) {
          const kx = s.penX + s.advance + xOff + ox + extraAcc;
          slots.push({
            codepoint: 0x0640,
            glyphId: insertion.gid,
            font: insertion.font,
            style: s.style,
            penX: kx,
            penY: baselineY + oy,
            lineY: baselineY + oy,
            advance: insertion.advEm,
            ...(layout.inlineVertical ? { crossAdvance: insertion.crossEm } : {}),
            breakKind: 0,
            clusterStart: true,
            ...(s.sourceCluster === undefined ? {} : { sourceCluster: s.sourceCluster }),
            synthBold: s.synthBold,
            synthItalic: s.synthItalic,
            attachToIdx: -1,
            attachDxEm: 0,
            attachDyEm: 0,
            cursiveExit: null,
            ligComponents: 1,
            mathAssembly: null,
            ignorable: false,
          });
          extraAcc += insertion.advEm;
        }
      }
    }
    if (lineRanges) lineRanges.push({ start: lineStart, end: slots.length, y: baselineY + oy });
  }
  if (lineRanges && trailingEmptyLine)
    lineRanges.push({ start: slots.length, end: slots.length, y: baselineAccum + oy });
  return slots;
}

/// AAT 'kerx' contextual (format 1) + anchor (format 4) positioning. Runs
/// after layout, per line, over each maximal same-font run whose font is
/// AAT-shaped and ships a state-machine/anchor kerning subtable. Format 1
/// produces per-glyph advance / offset deltas; format 4 attaches a glyph
/// to a marked predecessor. Pairwise kerx 0/2 are already applied in the
/// pen loop, so they're excluded here.
function applyAatContextualKerning(slots, usesKerx, preferAat, kernDisabled) {
  if (slots.length === 0) return;
  // Split into lines (constant lineY; penY varies per mark), preserving order.
  let lineStart = 0;
  const lnY = (s) => (s.lineY !== undefined ? s.lineY : s.penY);
  for (let end = 1; end <= slots.length; end++) {
    if (end === slots.length || lnY(slots[end]) !== lnY(slots[lineStart])) {
      _kerxLine(slots, lineStart, end, usesKerx, preferAat, kernDisabled);
      lineStart = end;
    }
  }
}

function _kerxLine(slots, lo, hi, usesKerx, preferAat, kernDisabled) {
  const N = hi - lo;
  if (N === 0) return;
  const xAdv = new Array(N).fill(0),
    xOff = new Array(N).fill(0),
    yOff = new Array(N).fill(0);
  const attaches = [];
  let any = false;
  let i = 0;
  while (i < N) {
    const f = slots[lo + i].font;
    let j = i;
    while (j < N && slots[lo + j].font === f) j++;
    if (
      f &&
      (f.kerx.hasKerx
        ? usesKerx(f) && f.kerx.hasContextualKerning
        : !kernDisabled &&
          (f.usesAatKerning || (preferAat && f.hasAatSubstitution && f.legacyKern.hasStateKerning)))
    ) {
      const inv = f.unitsPerEm > 0 ? 1 / f.unitsPerEm : 0;
      const runGids = [];
      for (let k = i; k < j; k++) runGids.push(slots[lo + k].glyphId);
      const r = f.kerx.hasKerx
        ? f.kerx.applyContextualKerning(runGids, !kernDisabled)
        : { ...f.legacyKern.applyStateKerning(runGids), attach: [] };
      for (let k = 0; k < runGids.length; k++) {
        const style = slots[lo + i + k].style;
        const sy = style?.sizeScale ?? 1,
          sx = sy * (style?.widthScale > 0 ? style.widthScale : 1);
        xAdv[i + k] = r.xAdvance[k] * inv * sx;
        xOff[i + k] = r.xOffset[k] * inv * sx;
        yOff[i + k] = r.yOffset[k] * inv * sy;
        if (r.xAdvance[k] || r.xOffset[k] || r.yOffset[k]) any = true;
      }
      for (const a of r.attach) {
        const style = slots[lo + i + a.idx].style;
        const sy = style?.sizeScale ?? 1,
          sx = sy * (style?.widthScale > 0 ? style.widthScale : 1);
        attaches.push({
          idx: i + a.idx,
          markIdx: i + a.markIdx,
          dx: a.dxFu * inv * sx,
          dy: a.dyFu * inv * sy,
        });
        any = true;
      }
    }
    i = j;
  }
  if (!any) return;
  // Cumulative left-to-right pass: advance deltas shift everything after;
  // x/y offsets shift the glyph itself.
  let cum = 0;
  for (let k = 0; k < N; k++) {
    const s = slots[lo + k];
    s.penX += cum + xOff[k];
    s.penY += -yOff[k]; // FUnits +Y up → layout +Y down
    s.advance += xAdv[k];
    cum += xAdv[k];
  }
  // Format-4 attachments: place the glyph at its mark's pen + (dx, dy).
  for (const a of attaches) {
    slots[lo + a.idx].penX = slots[lo + a.markIdx].penX + a.dx;
    slots[lo + a.idx].penY = slots[lo + a.markIdx].penY - a.dy;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/// UAX #14 mandatory breaks that take no glyph: LF, VT, FF, CR, NEL, LS, PS.
function isHardBreakCp(cp) {
  return (
    cp === 0x0a ||
    cp === 0x0d ||
    cp === 0x0b ||
    cp === 0x0c ||
    cp === 0x85 ||
    cp === 0x2028 ||
    cp === 0x2029
  );
}

/// Breaks that also end a UAX #9 paragraph (bidi class B): LF, CR, NEL, PS.
function isParagraphBreakCp(cp) {
  return cp === 0x0a || cp === 0x0d || cp === 0x85 || cp === 0x2029;
}

const LB_TAIL = 32;

// No ArabicForm: a transparent character, which no positional feature applies to.
const ARABIC_NO_FORM = -1;
// ArabicForm.Init / ArabicForm.Medi (scripts/arabicJoining.js): the forms that join the next letter.
const ARABIC_FORM_INIT = 1;
const ARABIC_FORM_MEDI = 2;
const ARABIC_FORM_STAGES = [
  ['isol', 0],
  ['fina', 3],
  ['medi', ARABIC_FORM_MEDI],
  ['init', ARABIC_FORM_INIT],
];

/// HarfBuzz space fallback types (hb_ucd_space_fallback_type): 0 not a space;
/// N in 1..6,16 is 1/N em; 7 figure, 8 punctuation, 9 narrow, 10 four-eighteenths
/// em, 11 an ordinary space glyph at its own width.
function _spaceFallbackKind(cp) {
  switch (cp) {
    case 0x00a0:
      return 11;
    case 0x2000:
      return 2;
    case 0x2001:
      return 1;
    case 0x2002:
      return 2;
    case 0x2003:
      return 1;
    case 0x2004:
      return 3;
    case 0x2005:
      return 4;
    case 0x2006:
      return 6;
    case 0x2007:
      return 7;
    case 0x2008:
      return 8;
    case 0x2009:
      return 5;
    case 0x200a:
      return 16;
    case 0x202f:
      return 9;
    case 0x205f:
      return 10;
    case 0x3000:
      return 1;
    default:
      return 0;
  }
}

/// Advance in em of the U+0020 glyph standing in for an unmapped space.
function _fallbackSpaceAdvance(cp, font, spaceGid) {
  const upem = font.unitsPerEm;
  const fu = (gid) => Math.round(font.getMetricsByGid(gid).advance * upem);
  const kind = _spaceFallbackKind(cp);
  let units;
  if (kind === 11) units = fu(spaceGid);
  else if (kind === 7 || kind === 8) {
    let g = font.codepointToGlyphId(kind === 7 ? 0x30 : 0x2e);
    if (!g && kind === 8) g = font.codepointToGlyphId(0x2c);
    units = g ? fu(g) : fu(spaceGid);
  } else if (kind === 9) units = Math.trunc(fu(spaceGid) / 2);
  else if (kind === 10) units = Math.trunc((upem * 4) / 18);
  else units = Math.trunc((upem + (kind >> 1)) / kind);
  return upem > 0 ? units / upem : 0;
}

function* codepoints(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        yield ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
        i++;
        continue;
      }
    }
    yield c;
  }
}
