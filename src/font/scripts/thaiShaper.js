// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// thaiShaper.js — Thai + Lao shaper.
//
const _THAI_SARA_AM = 0x0e33;
const _THAI_SARA_AA = 0x0e32;
const _THAI_NIKHAHIT = 0x0e4d;
// Lao SARA AM has the same decomposition pattern.
const _LAO_SARA_AM = 0x0eb3;
const _LAO_SARA_AA = 0x0eb2;
const _LAO_NIKKHIT = 0x0ecd;

export function isThaiLaoCodepoint(codepoint) {
  return (
    (codepoint >= 0x0e00 && codepoint <= 0x0e7f) || // Thai
    (codepoint >= 0x0e80 && codepoint <= 0x0eff)
  ); // Lao
}

/// True iff `codepoint` is a pre-base vowel. Thai/Lao encode these in
/// visual order (already before the consonant) — the predicate exists
/// for classification only; nothing reorders.
export function isPreBaseVowel(codepoint) {
  return (
    (codepoint >= 0x0e40 && codepoint <= 0x0e44) || // Thai
    (codepoint >= 0x0ec0 && codepoint <= 0x0ec4)
  ); // Lao
}

/// Thai/Lao above-base marks (tone marks, nikhahit, thanthakhat,
/// vowel signs that sit above the consonant). Used by the GPOS mark-
/// attachment pass to determine which slots are marks. Returns true
/// for the full set of Thai/Lao non-spacing marks per Unicode
/// IndicSyllabicCategory + General_Category=Mn.
export function isThaiLaoMark(codepoint) {
  // Thai marks (vowel signs + tone marks + special marks)
  if (codepoint === 0x0e31) return true; // MAI HAN-AKAT
  if (codepoint >= 0x0e34 && codepoint <= 0x0e3a) return true; // SARA I..PHINTHU
  if (codepoint >= 0x0e47 && codepoint <= 0x0e4e) return true; // MAITAIKHU..YAMAKKAN
  // Lao marks
  if (codepoint === 0x0eb1) return true; // MAI KAN
  if (codepoint >= 0x0eb4 && codepoint <= 0x0ebc) return true; // SARA I..MARK
  if (codepoint >= 0x0ec8 && codepoint <= 0x0ecd) return true; // TONE MAI EK..NIKKHIT
  return false;
}

/// Apply SARA AM decomposition to a codepoint stream. Each U+0E33
/// (Thai) or U+0EB3 (Lao) becomes a pair (NIKHAHIT, SARA AA) — the
/// mark FIRST, matching Unicode's canonical decomposition and HarfBuzz,
/// so the nikhahit anchors to the preceding CONSONANT (the mark-attach
/// pass binds a mark to the previous non-mark slot), with the spacing
/// Sara AA following.
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
