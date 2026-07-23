// textBreak.js — CJK soft-wrap predicates, glyph resolution across fallbacks
// (incl. variation selectors), and Arabic kashida justification planning.
// Split out of textLayout.js; a leaf module (no dependency on the layout
// orchestration or slot emission). textLayout.js (line wrap) and textSlotEmit.js
// (vertical emit) import from here.

import { verticalOrientation, Vo } from './unicode/tables/verticalOrientation.js';
import { getArabicShaping } from './shaperRegistry.js';

/// True iff `cp` stays upright in `text-orientation: mixed`, per UAX #50
/// Vertical_Orientation: U (Upright) and Tu (Transformed_Upright) stay
/// upright; R/Tr rotate sideways.
export function isCjkOrUprightCodepoint(cp) {
  const vo = verticalOrientation.get(cp);
  return vo === Vo.U || vo === Vo.Tu;
}

// CJK soft-wrap predicates. A pragmatic predicate set rather than a
// full UCD trie.
export function isCjkCore(cp) {
  return (cp >= 0x3000 && cp <= 0x303F) ||
         (cp >= 0x3040 && cp <= 0x309F) ||
         (cp >= 0x30A0 && cp <= 0x30FF) ||
         (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x4E00 && cp <= 0x9FFF) ||
         (cp >= 0xAC00 && cp <= 0xD7AF) ||
         (cp >= 0xF900 && cp <= 0xFAFF) ||
         (cp >= 0xFF00 && cp <= 0xFFEF) ||
         (cp >= 0x20000 && cp <= 0x2FFFF);
}

// CJK/fullwidth characters forbidden at line start (TR#14): closing
// punctuation (class CL, LB13), fullwidth exclamation/question (EX),
// small kana + prolonged sound mark (CJ), and NS marks (LB21) — all
// must stay with the preceding glyph.
export function isCjkClosing(cp) {
  switch (cp) {
    case 0xFF09: case 0xFF3D: case 0xFF5D:
    case 0xFF0C: case 0xFF0E:
    case 0xFF1A: case 0xFF1B:
    case 0xFF1F: case 0xFF01:
    case 0x3001: case 0x3002:
    case 0x3009: case 0x300B: case 0x300D:
    case 0x300F: case 0x3011: case 0x3015:
    case 0x3017: case 0x3019: case 0x301B:
    case 0x3041: case 0x3043: case 0x3045: case 0x3047: case 0x3049:
    case 0x3063: case 0x3083: case 0x3085: case 0x3087: case 0x308E:
    case 0x30A1: case 0x30A3: case 0x30A5: case 0x30A7: case 0x30A9:
    case 0x30C3: case 0x30E3: case 0x30E5: case 0x30E7: case 0x30EE:
    case 0x309B: case 0x309C:
    case 0x30FB: case 0x30FC:
      return true;
    default: return false;
  }
}

// CJK OPENING punctuation — don't break AFTER these (TR#14 LB14).
export function isCjkOpening(cp) {
  switch (cp) {
    case 0xFF08: case 0xFF3B: case 0xFF5B:
    case 0x3008: case 0x300A: case 0x300C:
    case 0x300E: case 0x3010: case 0x3014:
    case 0x3016: case 0x3018: case 0x301A:
      return true;
    default: return false;
  }
}

export function isCjkBreakBefore(cp) {
  if (!isCjkCore(cp)) return false;
  if (isCjkClosing(cp)) return false;
  return true;
}

// Walk (primary, fallbacks...) and return [font, gid] for the first
// font with a non-.notdef glyph. Falls back to [primary, 0] when
// nothing matches.
export function resolveGlyph(cp, primary, fallbacks) {
  const gid = primary.codepointToGlyphId(cp);
  if (gid !== 0 || cp === 0) return [primary, gid];
  if (!fallbacks) return [primary, 0];
  for (const fb of fallbacks) {
    if (!fb || fb === primary) continue;
    const fbGid = fb.codepointToGlyphId(cp);
    if (fbGid !== 0) return [fb, fbGid];
  }
  return [primary, 0];
}

/// JSTF Arabic kashida justification plan for one visual line.
///
/// Returns null when the line can't use kashida (no Arabic shaper, no
/// font with 'arab' JSTF extenders, no eligible cursive join, or the
/// widest extender doesn't fit the slack). Otherwise returns
///   { counts: Map<visualIndex,count>, gid, advEm, font, total }
/// where a kashida (tatweel) connector is inserted AFTER each listed
/// visual slot, `total` kashidas in all, distributed round-robin across
/// the eligible joins. Eligible joins are adjacent same-font Arabic
/// dual-joining letters — these always connect, so a connector slots in
/// cleanly regardless of LTR/RTL visual ordering.
export function planKashida(lineSlots, slack) {
  const _arabic = getArabicShaping();
  if (!_arabic || slack <= 0) return null;
  const D = _arabic.ArabicJoiningType.D;
  let extFont = null, gid = 0, advEm = 0;
  const points = [];
  for (let i = 0; i + 1 < lineSlots.length; i++) {
    const a = lineSlots[i], b = lineSlots[i + 1];
    if (a.font !== b.font || a.glyphId === 0 || b.glyphId === 0) continue;
    if (_arabic.getArabicJoiningType(a.codepoint) !== D) continue;
    if (_arabic.getArabicJoiningType(b.codepoint) !== D) continue;
    // Resolve (and cache) this font's widest extender glyph.
    if (extFont !== a.font) {
      const exts = a.font.jstf.getExtenderGlyphs('arab');
      if (!exts) continue;
      let best = 0, bestAdv = 0;
      for (const g of exts) {
        const adv = a.font.getMetricsByGid(g).advance;
        if (adv > bestAdv) { bestAdv = adv; best = g; }
      }
      if (bestAdv <= 0) continue;
      extFont = a.font; gid = best; advEm = bestAdv;
    }
    if (a.font === extFont) points.push(i);
  }
  if (points.length === 0 || advEm <= 0) return null;
  const total = Math.floor(slack / advEm);
  if (total <= 0) return null;
  const counts = new Map();
  for (let k = 0; k < total; k++) {
    const p = points[k % points.length];
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  return { counts, gid, advEm, font: extFont, total };
}

/// Registered Unicode variation selectors: VS1–16 (U+FE00–FE0F) for
/// emoji/text presentation + standardized variants, and VS17–256
/// (U+E0100–E01EF) for CJK ideographic variation sequences.
export function isVariationSelector(cp) {
  return (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);
}

/// Resolve a base codepoint that's immediately followed by a variation
/// selector. Prefers whichever font (primary, then fallbacks) defines an
/// explicit variant for the exact (base, selector) sequence in its
/// format-14 UVS cmap — this is what selects an emoji-presentation glyph
/// for `base + VS16`. Falls back to the ordinary base lookup when no
/// font registers the sequence.
export function resolveGlyphWithSelector(baseCp, selectorCp, primary, fallbacks) {
  if (primary.hasVariationSelectors) {
    const vg = primary.codepointToVariationGlyphId(baseCp, selectorCp);
    if (vg !== 0) return [primary, vg];
  }
  if (fallbacks) {
    for (const fb of fallbacks) {
      if (!fb || fb === primary || !fb.hasVariationSelectors) continue;
      const vg = fb.codepointToVariationGlyphId(baseCp, selectorCp);
      if (vg !== 0) return [fb, vg];
    }
  }
  return resolveGlyph(baseCp, primary, fallbacks);
}
