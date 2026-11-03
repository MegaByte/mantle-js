// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// defaultIgnorable.js — Unicode Default_Ignorable_Code_Point predicate.
//
// Implements the derived
// Unicode property `Default_Ignorable_Code_Point` (DerivedCoreProperties).
//
// Codepoints with this property are format/control characters that —
// when NOT consumed by shaping and NOT supported by the font — must be
// rendered as zero-advance, zero-ink (i.e. hidden), NOT as a `.notdef`
// tofu box. This matches HarfBuzz's hide-default-ignorables pass.
//
// Members include: variation selectors (FE00–FE0F, E0100–E01EF), the
// zero-width joiners/non-joiners (200C/200D), zero-width space (200B),
// soft hyphen (00AD), BOM / word-joiner (FEFF, 2060), bidi formatting
// controls (202A–202E, 2066–206F), Mongolian free variation selectors,
// Hangul fillers, and the Tags block (E0000–E007F).
//
// Ranges below are sorted ascending; the lookup is a linear scan over a
// tiny table (≈20 ranges) — cheaper than a binary search's overhead at
// this size, and called at most once per codepoint during layout.

// [lo, hi] inclusive ranges, ascending, non-overlapping.
const _RANGES = [
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x034f, 0x034f], // COMBINING GRAPHEME JOINER
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x115f, 0x1160], // HANGUL CHOSEONG/JUNGSEONG FILLER
  [0x17b4, 0x17b5], // KHMER VOWEL INHERENT AQ/AA
  [0x180b, 0x180f], // MONGOLIAN FVS1–4 + VOWEL SEPARATOR
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2060, 0x206f], // WORD JOINER … bidi isolates + deprecated format
  [0x3164, 0x3164], // HANGUL FILLER
  [0xfe00, 0xfe0f], // VARIATION SELECTOR-1 … 16
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE / BOM
  [0xffa0, 0xffa0], // HALFWIDTH HANGUL FILLER
  [0xfff0, 0xfff8], // reserved (Default_Ignorable)
  [0x1bca0, 0x1bca3], // SHORTHAND FORMAT CONTROLS
  [0x1d173, 0x1d17a], // MUSICAL SYMBOL BEGIN BEAM … END PHRASE
  [0xe0000, 0xe0fff], // TAGS + VARIATION SELECTORS SUPPLEMENT (E0100–E01EF)
];

/// True when `cp` has the Unicode Default_Ignorable_Code_Point property.
/// Callers hide such glyphs (zero advance, no ink) when the font doesn't
/// substitute them into something visible.
export function isDefaultIgnorable(cp) {
  // Fast reject for the overwhelmingly-common ASCII / Latin path: the
  // first member is 0x00AD, so anything below it is never ignorable.
  if (cp < 0x00ad) return false;
  for (let i = 0; i < _RANGES.length; i++) {
    const r = _RANGES[i];
    if (cp < r[0]) return false; // ranges ascending → past it, done
    if (cp <= r[1]) return true;
  }
  return false;
}
