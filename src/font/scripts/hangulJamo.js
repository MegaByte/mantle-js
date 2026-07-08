// hangulJamo.js — Hangul shaper: jamo classification helpers.
//
// Korean has three writing modes for the same syllables:
//
//   1. Precomposed Hangul Syllables (U+AC00..U+D7A3): one codepoint
//      per syllable, ~11,184 cells. NFC composes 2-jamo and 3-jamo
//      sequences into these, so most modern Korean text never sees
//      raw jamo in the textRun's per-codepoint stream.
//
//   2. Hangul Jamo (U+1100..U+11FF): leading consonants (L) at
//      U+1100..U+115F, vowels (V) at U+1160..U+11A7, trailing
//      consonants (T) at U+11A8..U+11FF. Composes into (1) via NFC
//      for the modern subset; archaic jamo do not have a precomposed
//      form and must be shaped via 'ljmo'/'vjmo'/'tjmo' GSUB lookups.
//
//   3. Hangul Compatibility Jamo (U+3130..U+318F): used in
//      dictionaries / labels; ALWAYS isolated, no composition.
//
// This module covers (2) — the cases that NFC didn't handle.
// Compatibility jamo (3) are treated as standalone Latin-like
// codepoints by the layout (no special-casing needed).

/// Hangul jamo positional role for GSUB feature dispatch.
export const HangulJamoRole = Object.freeze({
  Leading:  0,  // ljmo — initial consonant
  Vowel:    1,  // vjmo — vowel
  Trailing: 2,  // tjmo — final consonant
});

/// True iff `codepoint` is a Hangul Jamo (U+1100..U+11FF). This is
/// the range that needs jamo shaping. Compatibility Jamo (U+3130..) is
/// NOT included — those render as standalone graphemes.
export function isHangulJamo(codepoint) {
  return codepoint >= 0x1100 && codepoint <= 0x11FF;
}

/// True iff codepoint is a precomposed Hangul syllable (U+AC00..U+D7A3).
/// These render through cmap, not jamo shaping.
export function isPrecomposedHangul(codepoint) {
  return codepoint >= 0xAC00 && codepoint <= 0xD7A3;
}

/// Classify a Hangul Jamo into Leading / Vowel / Trailing. Returns
/// null for codepoints outside the jamo range.
export function classifyHangulJamo(codepoint) {
  if (codepoint < 0x1100 || codepoint > 0x11FF) return null;
  if (codepoint <= 0x115F) return HangulJamoRole.Leading;
  if (codepoint <= 0x11A7) return HangulJamoRole.Vowel;
  return HangulJamoRole.Trailing;
}

/// Compute jamo roles for each codepoint in `cps`. Non-jamo codepoints
/// get role=-1. Returns Int8Array of length cps.length.
export function classifyJamoStream(cps) {
  const n = cps.length;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const r = classifyHangulJamo(cps[i]);
    out[i] = r == null ? -1 : r;
  }
  return out;
}
