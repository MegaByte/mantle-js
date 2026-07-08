// thaiShaper.js — Thai + Lao shaper.
//
// Thai (U+0E00..U+0E7F) and Lao (U+0E80..U+0EFF) share a common
// pre-base vowel reorder pattern: 5 leading vowels per script appear
// AFTER the consonant in memory but render visually BEFORE it. There's
// no Indic-style cluster grammar — Thai is a single-consonant-anchored
// segmental script with marks stacked above/below.
//
// Pre-base vowels (logical order: consonant + vowel; visual order:
// vowel + consonant):
//
//   Thai (U+0E40..U+0E44):
//     U+0E40 SARA E
//     U+0E41 SARA AE
//     U+0E42 SARA O
//     U+0E43 SARA AI MAIMUAN
//     U+0E44 SARA AI MAIMALAI
//
//   Lao (U+0EC0..U+0EC4):
//     U+0EC0 LAO VOWEL SIGN E
//     U+0EC1 LAO VOWEL SIGN EI
//     U+0EC2 LAO VOWEL SIGN O
//     U+0EC3 LAO VOWEL SIGN AY
//     U+0EC4 LAO VOWEL SIGN AI
//
// Above/below marks include tone marks and other non-spacing marks
// that should stack on the consonant via GPOS 'mark' attachment.

// SARA AM (U+0E33) is a precomposed Thai vowel that canonically
// decomposes into SARA AA (U+0E32) + NIKHAHIT (U+0E4D). Some fonts
// only carry glyphs for the decomposed pair, so we mirror what OT
// 'ccmp' would do — explicit decomposition before shaping. NFC keeps
// SARA AM composed, so we have to handle this case ourselves.
const _THAI_SARA_AM     = 0x0E33;
const _THAI_SARA_AA     = 0x0E32;
const _THAI_NIKHAHIT    = 0x0E4D;
// Lao SARA AM has the same decomposition pattern.
const _LAO_SARA_AM      = 0x0EB3;
const _LAO_SARA_AA      = 0x0EB2;
const _LAO_NIKKHIT      = 0x0ECD;

/// True iff `codepoint` is a Thai or Lao codepoint we shape.
export function isThaiLaoCodepoint(codepoint) {
  return (codepoint >= 0x0E00 && codepoint <= 0x0E7F) ||  // Thai
         (codepoint >= 0x0E80 && codepoint <= 0x0EFF);    // Lao
}

/// True iff `codepoint` is one of the pre-base vowels that needs to
/// move BEFORE its preceding consonant during shaping.
export function isPreBaseVowel(codepoint) {
  return (codepoint >= 0x0E40 && codepoint <= 0x0E44) ||  // Thai
         (codepoint >= 0x0EC0 && codepoint <= 0x0EC4);    // Lao
}

/// Thai/Lao above-base marks (tone marks, nikhahit, thanthakhat,
/// vowel signs that sit above the consonant). Used by the GPOS mark-
/// attachment pass to determine which slots are marks. Returns true
/// for the full set of Thai/Lao non-spacing marks per Unicode
/// IndicSyllabicCategory + General_Category=Mn.
export function isThaiLaoMark(codepoint) {
  // Thai marks (vowel signs + tone marks + special marks)
  if (codepoint === 0x0E31) return true;                  // MAI HAN-AKAT
  if (codepoint >= 0x0E34 && codepoint <= 0x0E3A) return true;  // SARA I..PHINTHU
  if (codepoint >= 0x0E47 && codepoint <= 0x0E4E) return true;  // MAITAIKHU..YAMAKKAN
  // Lao marks
  if (codepoint === 0x0EB1) return true;                  // MAI KAN
  if (codepoint >= 0x0EB4 && codepoint <= 0x0EBC) return true;  // SARA I..MARK
  if (codepoint >= 0x0EC8 && codepoint <= 0x0ECD) return true;  // TONE MAI EK..NIKKHIT
  return false;
}

/// Apply SARA AM decomposition to a codepoint stream. Each U+0E33
/// (Thai) or U+0EB3 (Lao) becomes a pair (SARA AA, NIKHAHIT).
///
/// Returns a NEW array — the caller threads it through any parallel
/// arrays (gids, clusterStarts, fonts) by tracking origLow per emitted
/// codepoint (one cp expands to two).
///
/// Returns { cps, origLow } where origLow[i] = source index in the
/// INPUT array. For non-decomposed codepoints, the mapping is
/// identity; for decomposed pairs, both emitted positions share the
/// same source index.
export function decomposeSaraAm(cps) {
  const outCps = [];
  const origLow = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === _THAI_SARA_AM) {
      outCps.push(_THAI_SARA_AA);
      outCps.push(_THAI_NIKHAHIT);
      origLow.push(i);
      origLow.push(i);
    } else if (cp === _LAO_SARA_AM) {
      outCps.push(_LAO_SARA_AA);
      outCps.push(_LAO_NIKKHIT);
      origLow.push(i);
      origLow.push(i);
    } else {
      outCps.push(cp);
      origLow.push(i);
    }
  }
  return { cps: outCps, origLow };
}

/// Build a permutation that swaps each (consonant, pre-base-vowel)
/// pair in `cps`. Returns Uint32Array of length cps.length where
/// `out[v] = logicalIndex`.
///
/// Algorithm:
///   Walk the stream. When we find a pre-base vowel at index i, the
///   PRECEDING codepoint at i-1 is its consonant. Swap them in the
///   output permutation: out[outIdx]   = i (the vowel goes first)
///                       out[outIdx+1] = i-1 (consonant follows)
///   and skip the consonant we already placed. Codepoints that are
///   not part of a pre-base pair are appended in logical order.
///
/// Edge cases:
///   - Pre-base vowel at the START of the run (no preceding cp):
///     emit as-is (broken syllable; rare in well-formed text).
///   - Two pre-base vowels in a row (shouldn't happen in real Thai):
///     handle by treating the first as "no consonant preceding."
export function reorderThaiLao(cps) {
  const n = cps.length;
  const out = new Uint32Array(n);
  let outIdx = 0;
  for (let i = 0; i < n; i++) {
    const cp = cps[i];
    // Pre-base vowel? Swap with preceding consonant in the OUTPUT.
    if (isPreBaseVowel(cp) && i > 0 && !isPreBaseVowel(cps[i - 1]) &&
        outIdx > 0 && out[outIdx - 1] === i - 1) {
      // Replace [consonant] with [vowel, consonant].
      out[outIdx - 1] = i;
      out[outIdx]     = i - 1;
      outIdx++;
    } else {
      out[outIdx++] = i;
    }
  }
  return out;
}
