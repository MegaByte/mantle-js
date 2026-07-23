// thaiShaper.js — Thai + Lao shaper.
//
// Thai (U+0E00..U+0E7F) and Lao (U+0E80..U+0EFF) are encoded in VISUAL
// order (TUS §16.1): pre-base vowels (SARA E .. SARA AI, U+0E40..44 /
// U+0EC0..C4) are already STORED before their consonant, so — unlike
// Indic scripts — no glyph reordering is ever performed (HarfBuzz does
// none either). There's no Indic-style cluster grammar; Thai is a
// single-consonant-anchored segmental script with marks stacked
// above/below via GPOS 'mark' attachment.

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

/// True iff `codepoint` is a pre-base vowel. Thai/Lao encode these in
/// visual order (already before the consonant) — the predicate exists
/// for classification only; nothing reorders.
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
/// (Thai) or U+0EB3 (Lao) becomes a pair (NIKHAHIT, SARA AA) — the
/// mark FIRST, matching Unicode's canonical decomposition and HarfBuzz,
/// so the nikhahit anchors to the preceding CONSONANT (the mark-attach
/// pass binds a mark to the previous non-mark slot), with the spacing
/// SARA AA following.
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
      outCps.push(_THAI_NIKHAHIT);
      outCps.push(_THAI_SARA_AA);
      origLow.push(i);
      origLow.push(i);
    } else if (cp === _LAO_SARA_AM) {
      outCps.push(_LAO_NIKKHIT);
      outCps.push(_LAO_SARA_AA);
      origLow.push(i);
      origLow.push(i);
    } else {
      outCps.push(cp);
      origLow.push(i);
    }
  }
  return { cps: outCps, origLow };
}

