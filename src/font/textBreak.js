// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textBreak.js — CJK soft-wrap predicates, glyph resolution across fallbacks
// (incl. variation selectors), and Arabic kashida justification planning.
// Split out of textLayout.js; a leaf module (no dependency on the layout
// orchestration or slot emission). textLayout.js (line wrap) and textSlotEmit.js
// (vertical emit) import from here.

import { verticalOrientation, Vo } from './unicode/tables/verticalOrientation.js';
import { getArabicShaping, getOtScriptTags } from './shaperRegistry.js';

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
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

// CJK/fullwidth characters forbidden at line start (TR#14): closing
// punctuation (class CL, LB13), fullwidth exclamation/question (EX),
// small kana + prolonged sound mark (CJ), and NS marks (LB21) — all
// must stay with the preceding glyph.
export function isCjkClosing(cp) {
  switch (cp) {
    case 0xff09:
    case 0xff3d:
    case 0xff5d:
    case 0xff0c:
    case 0xff0e:
    case 0xff1a:
    case 0xff1b:
    case 0xff1f:
    case 0xff01:
    case 0x3001:
    case 0x3002:
    case 0x3009:
    case 0x300b:
    case 0x300d:
    case 0x300f:
    case 0x3011:
    case 0x3015:
    case 0x3017:
    case 0x3019:
    case 0x301b:
    case 0x3041:
    case 0x3043:
    case 0x3045:
    case 0x3047:
    case 0x3049:
    case 0x3063:
    case 0x3083:
    case 0x3085:
    case 0x3087:
    case 0x308e:
    case 0x30a1:
    case 0x30a3:
    case 0x30a5:
    case 0x30a7:
    case 0x30a9:
    case 0x30c3:
    case 0x30e3:
    case 0x30e5:
    case 0x30e7:
    case 0x30ee:
    case 0x309b:
    case 0x309c:
    case 0x30fb:
    case 0x30fc:
      return true;
    default:
      return false;
  }
}

export function isCjkOpening(cp) {
  switch (cp) {
    case 0xff08:
    case 0xff3b:
    case 0xff5b:
    case 0x3008:
    case 0x300a:
    case 0x300c:
    case 0x300e:
    case 0x3010:
    case 0x3014:
    case 0x3016:
    case 0x3018:
    case 0x301a:
      return true;
    default:
      return false;
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

// Scripts whose letters join and whose lines read right to left; the others that join (Mongolian, Phags-pa) read left to right
// (top to bottom in a vertical line). The order decides which of two neighbors is the one that must join forward.
const RTL_JOINING_SCRIPTS = new Set([
  'arab',
  'syrc',
  'nko ',
  'mand',
  'adlm',
  'rohg',
  'mani',
  'phlp',
  'sogd',
  'sogo',
  'chrs',
]);

const tagString = (t) => String.fromCharCode(t >>> 24, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);

/// JSTF extender (kashida, tatweel) justification plan for one visual line: connectors inserted where two letters join.
///
/// A join is where the logically earlier letter joins forward (joining type D or L) and the later one joins back (D or R), in
/// any script whose font lists extender glyphs for it. The extender takes the width it has along the line: its horizontal
/// advance, or in an upright vertical line the vertical one.
export function planKashida(lineSlots, slack, varCoords = null, inlineVertical = null) {
  const _arabic = getArabicShaping();
  if (!_arabic || slack <= 0) return null;
  const T = _arabic.ArabicJoiningType;
  if (!Number.isFinite(slack)) return null;
  const registry = getOtScriptTags();
  const scriptOf = (slot) => {
    const tags =
      registry && slot.codepoint ? registry.otScriptTagsPerCodepoint([slot.codepoint])[0] : null;
    return tags && tags.length ? tags.map(tagString) : ['arab'];
  };
  const joinsForward = (type) => type === T.D || type === T.L;
  const joinsBack = (type) => type === T.D || type === T.R;
  const extenders = new Map(),
    points = [];
  for (let i = 0; i + 1 < lineSlots.length; i++) {
    const a = lineSlots[i],
      b = lineSlots[i + 1];
    if (a.font !== b.font || !a.glyphId || !b.glyphId) continue;
    const scripts = scriptOf(a);
    const rtl = scripts.some((name) => RTL_JOINING_SCRIPTS.has(name));
    // visual neighbors; the logical order is the reverse of the visual one in a right-to-left script
    const first = rtl ? b : a,
      second = rtl ? a : b;
    if (
      !joinsForward(_arabic.getArabicJoiningType(first.codepoint)) ||
      !joinsBack(_arabic.getArabicJoiningType(second.codepoint))
    )
      continue;
    const upright =
      inlineVertical === 'upright' ||
      (inlineVertical === 'mixed' && isCjkOrUprightCodepoint(a.codepoint | 0));
    const cacheKey = scripts.join(',') + (upright ? '|v' : '');
    let perFont = extenders.get(a.font);
    if (!perFont) extenders.set(a.font, (perFont = new Map()));
    let extender = perFont.get(cacheKey);
    if (extender === undefined) {
      extender = null;
      let list = null;
      for (const name of scripts) {
        list = a.font.jstf.getExtenderGlyphs(name);
        if (list) break;
      }
      for (const gid of list || []) {
        let advance,
          cross = 0;
        if (upright && typeof a.font.getVerticalMetricsByGid === 'function') {
          const vm = a.font.getVerticalMetricsByGid(gid);
          advance = vm && vm.advanceHeight ? vm.advanceHeight : a.font.getMetricsByGid(gid).advance;
        } else {
          advance =
            varCoords != null && a.font.isVariable
              ? a.font.getGlyphAdvanceVar(gid, varCoords)
              : a.font.getMetricsByGid(gid).advance;
        }
        cross = a.font.getMetricsByGid(gid).advance;
        if (advance > 0 && Number.isFinite(advance) && (!extender || advance > extender.advance))
          extender = { gid, advance, cross };
      }
      perFont.set(cacheKey, extender);
    }
    if (!extender) continue;
    const scale = (a.style?.sizeScale ?? 1) * (a.style?.widthScale > 0 ? a.style.widthScale : 1);
    const advEm = extender.advance * (upright ? (a.style?.sizeScale ?? 1) : scale);
    if (advEm > 0 && Number.isFinite(advEm))
      points.push({
        index: i,
        gid: extender.gid,
        font: a.font,
        advEm,
        crossEm: extender.cross * scale,
        count: 0,
      });
  }
  let remaining = slack,
    active = points,
    total = 0;
  // Allocate complete rounds in one step, then drop joins whose next extender
  // no longer fits. Work depends on join count rather than inserted glyph count.
  while (active.length) {
    active = active.filter((p) => p.advEm <= remaining);
    if (!active.length) break;
    const round = active.reduce((sum, p) => sum + p.advEm, 0),
      rounds = Math.floor(remaining / round);
    if (rounds > 0) {
      for (const p of active) p.count += rounds;
      total += rounds * active.length;
      remaining = Math.max(0, remaining - rounds * round);
    } else {
      for (const p of active)
        if (p.advEm <= remaining) {
          p.count++;
          total++;
          remaining = Math.max(0, remaining - p.advEm);
        }
    }
  }
  if (!total) return null;
  return {
    counts: new Map(points.map((p) => [p.index, p.count])),
    insertions: new Map(points.map((p) => [p.index, p])),
    total,
    usedAdvance: slack - remaining,
  };
}

/// Registered Unicode variation selectors: VS1–16 (U+FE00–FE0F) for
/// emoji/text presentation + standardized variants, and VS17–256
/// (U+E0100–E01EF) for CJK ideographic variation sequences.
export function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
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
