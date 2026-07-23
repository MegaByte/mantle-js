import { shaperIsc as shaperIscTrie } from "../unicode/tables/shaperIsc.js";
import { shaperIpc as shaperIpcTrie } from "../unicode/tables/shaperIpc.js";
// indicShaper.js — Indic shaper.
//
// Implements Devanagari and Bengali shaping per the OpenType Indic2
// (formerly USE-Devanagari) spec. Each Indic script has its own
// cluster grammar but they share a common machinery:
//
//   1. Classify each codepoint into an Indic Syllable Category (ISC)
//      and Indic Positional Category (IPC).
//   2. Identify syllable boundaries — a cluster of consonants, vowels,
//      halants, vowel signs, etc. that form one shaping unit.
//   3. Pick a "base" consonant inside each syllable (per per-script rules).
//   4. Reorder marks/matras/reph around the base.
//   5. Apply GSUB features in canonical order (nukt → akhn → rphf →
//      rkrf → pref → blwf → half → vatu → cjct → init → pres →
//      abvs → blws → psts → haln → calt).
//
// References:
//   https://learn.microsoft.com/en-us/typography/script-development/devanagari
//   https://learn.microsoft.com/en-us/typography/script-development/bengali
//
// This file ships Devanagari + Bengali table sets. Other Indic scripts
// (Tamil, Telugu, Kannada, etc.) plug into the same machinery via
// additional script tables.

/// Indic Syllable Category — per-codepoint classification for cluster
/// formation. Encoded as a single byte for table compactness.
export const Isc = Object.freeze({
  Other:               0,   // anything outside the Indic block
  Consonant:           1,
  ConsonantDead:       2,   // consonant that always carries inherent virama (rare)
  ConsonantPlaceholder:3,   // U+25CC dotted circle (placeholder)
  Nukta:               4,
  Halant:              5,   // virama
  ZWJ:                 6,
  ZWNJ:                7,
  VowelIndependent:    8,
  VowelDependent:      9,   // matra
  Anudatta:           10,
  Bindu:              11,   // anusvara/candrabindu/visarga
  Modifier:           12,   // miscellaneous (avagraha, danda, etc.)
  Ra:                 13,   // Devanagari/Bengali RA — special because it forms reph
  RegisteredShifter:  14,   // Bengali only; ignored for Devanagari
  Number:             15,
});

/// Indic Positional Category — where this glyph renders relative to
/// the syllable base. Drives reordering.
export const Ipc = Object.freeze({
  Right:           0,   // default; glyph follows base
  Left:            1,   // pre-base matra (e.g. Devanagari I-sign)
  Top:             2,   // above base (e.g. Devanagari E/AI matra, candrabindu)
  Bottom:          3,   // below base (e.g. Devanagari U-sign matras)
  LeftRight:       4,   // wraps around base (e.g. Devanagari O matra: top+right)
  TopRight:        5,
  BottomRight:     6,
  TopBottomRight:  7,
});

// -- Codepoint → Indic script -----------------------------------------

/// The script bucket for a codepoint, or null if not Indic.
export function indicScriptOf(codepoint) {
  if (codepoint >= 0x0900 && codepoint <= 0x097F) return 'deva';
  if (codepoint >= 0x0980 && codepoint <= 0x09FF) return 'beng';
  if (codepoint >= 0x0A00 && codepoint <= 0x0A7F) return 'guru';
  if (codepoint >= 0x0A80 && codepoint <= 0x0AFF) return 'gujr';
  if (codepoint >= 0x0B00 && codepoint <= 0x0B7F) return 'orya';
  if (codepoint >= 0x0B80 && codepoint <= 0x0BFF) return 'taml';
  if (codepoint >= 0x0C00 && codepoint <= 0x0C7F) return 'telu';
  if (codepoint >= 0x0C80 && codepoint <= 0x0CFF) return 'knda';
  if (codepoint >= 0x0D00 && codepoint <= 0x0D7F) return 'mlym';
  if (codepoint >= 0x0D80 && codepoint <= 0x0DFF) return 'sinh';
  return null;
}

/// True iff the codepoint is in a supported Indic block.
export function isIndicCodepoint(codepoint) {
  return indicScriptOf(codepoint) != null;
}
/// Classify a codepoint into ISC (Indic Syllable Category). Authoritative full
/// coverage via the generated Indic_Syllabic_Category adapter trie (UCD-derived;
/// the trie's value order matches the Isc enum above).
export function classifyIsc(codepoint) {
  return shaperIscTrie.get(codepoint);
}

/// Classify a codepoint's positional category (where the glyph
/// renders relative to its base). Defaults to Right.
export function classifyIpc(codepoint) {
  return shaperIpcTrie.get(codepoint);
}

// ---------------------------------------------------------------------
// Syllable identification.
// ---------------------------------------------------------------------

/// True iff `iscCat` looks like a syllable-boundary start (a new
/// consonant, independent vowel, or non-Indic character that breaks
/// the cluster).
function _isSyllableStart(c) {
  return c === Isc.Consonant ||
         c === Isc.ConsonantDead ||
         c === Isc.Ra ||
         c === Isc.VowelIndependent ||
         c === Isc.ConsonantPlaceholder ||
         c === Isc.Other ||
         c === Isc.Number;
}

/// True iff `iscCat` can extend an existing syllable (it's a continuation
/// glyph that attaches to the previous cluster).
function _isSyllableExtender(c) {
  return c === Isc.Nukta ||
         c === Isc.Halant ||
         c === Isc.VowelDependent ||
         c === Isc.Bindu ||
         c === Isc.Anudatta ||
         c === Isc.ZWJ ||
         c === Isc.ZWNJ;
}

/// Find syllable boundaries in `cps`. Returns an array of { start,
/// end } objects with half-open ranges. Non-Indic codepoints become
/// their own one-codepoint "syllables" (so they pass through layout
/// unchanged but the reorder loop can skip them with a quick check).
export function findIndicSyllables(cps) {
  const out = [];
  const n = cps.length;
  let i = 0;
  while (i < n) {
    const startCat = classifyIsc(cps[i]);
    if (startCat === Isc.Other) {
      out.push({ start: i, end: i + 1 });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const c = classifyIsc(cps[j]);
      if (_isSyllableStart(c) && c !== Isc.Other) {
        // Allow consonant-after-halant inside a cluster — halant+C is
        // a stacked / conjunct consonant, still part of the syllable.
        const prev = classifyIsc(cps[j - 1]);
        if (prev === Isc.Halant && (c === Isc.Consonant || c === Isc.Ra || c === Isc.ConsonantDead)) {
          j++;
          continue;
        }
        break;
      }
      if (!_isSyllableExtender(c) && c !== Isc.Consonant && c !== Isc.Ra && c !== Isc.ConsonantDead) {
        break;
      }
      j++;
    }
    out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

/// Pick the "base" consonant index inside [start, end). Returns -1
/// when the syllable has no consonant (vowel-only or pure modifier).
///
/// Default rule (most Indic scripts): the LAST consonant of the
/// syllable. Reph (Ra + Halant at start) doesn't count as the
/// base — it'll be moved out as the reph mark.
export function pickBaseConsonant(cps, start, end) {
  // Detect reph: initial Ra + Halant.
  let scan = start;
  let hasReph = false;
  if (scan + 1 < end &&
      classifyIsc(cps[scan]) === Isc.Ra &&
      classifyIsc(cps[scan + 1]) === Isc.Halant) {
    hasReph = true;
    scan += 2;  // skip the reph
  }
  // Find the LAST consonant in scan..end (in a C + halant + C chain
  // the final consonant IS the base).
  let last = -1;
  for (let k = scan; k < end; k++) {
    const c = classifyIsc(cps[k]);
    if (c === Isc.Consonant || c === Isc.Ra || c === Isc.ConsonantDead) {
      last = k;
    }
  }
  return last;
}

/// Detect whether a syllable starts with reph (Ra + Halant).
export function hasInitialReph(cps, start, end) {
  return start + 1 < end &&
         classifyIsc(cps[start]) === Isc.Ra &&
         classifyIsc(cps[start + 1]) === Isc.Halant;
}

// ---------------------------------------------------------------------
// Per-syllable reordering.
//
// Indic scripts written in OpenType need two reorders done by the
// shaper before GSUB runs:
//   1. Reph: when the syllable starts with `Ra + Halant`, those two
//      glyphs become a "reph" mark that visually sits at the end of
//      the syllable (or right after a final matra in some scripts).
//   2. Pre-base matra: a vowel sign whose IPC = Left visually renders
//      BEFORE the base consonant even though it appears AFTER in
//      memory. We move it to the position immediately before the base.
// ---------------------------------------------------------------------

/// Reorder a single Indic syllable into the visual order the GSUB
/// pipeline expects. Returns the new logical order as an array of
/// indices into the original [start, end) range.
///
/// `cps` is the codepoint array; the indices in the return array are
/// absolute (between start and end), suitable for use as a permutation
/// over the gid stream.
export function reorderSyllable(cps, start, end) {
  const order = [];
  for (let i = start; i < end; i++) order.push(i);
  if (end - start <= 1) return order;

  // Step 1: pre-base matra reorder. Find any pre-base vowel sign
  // (IPC = Left) and move it to JUST BEFORE the base consonant.
  const baseIdx = pickBaseConsonant(cps, start, end);
  if (baseIdx >= 0) {
    // Walk `order` finding the first pre-base-matra after the base
    // position. There should be at most one (most scripts).
    let preMatraOrderIdx = -1;
    for (let k = 0; k < order.length; k++) {
      const idx = order[k];
      if (idx <= baseIdx) continue;
      const c = classifyIsc(cps[idx]);
      if (c !== Isc.VowelDependent) continue;
      if (classifyIpc(cps[idx]) === Ipc.Left) {
        preMatraOrderIdx = k;
        break;
      }
    }
    if (preMatraOrderIdx >= 0) {
      const preMatraAbsIdx = order[preMatraOrderIdx];
      order.splice(preMatraOrderIdx, 1);
      // Find where `baseIdx` currently sits in `order` and insert
      // right before it.
      const baseOrderIdx = order.indexOf(baseIdx);
      order.splice(baseOrderIdx, 0, preMatraAbsIdx);
    }
  }

  // Step 2: reph. If the syllable starts with Ra + Halant, those two
  // indices move to the end of the order (after the final matra).
  if (hasInitialReph(cps, start, end)) {
    // The reph occupies the first TWO positions of `order` (since
    // they were leading the original cluster and pre-matra reorder
    // only affects indices AFTER the base).
    if (order.length >= 2 && order[0] === start && order[1] === start + 1) {
      const reph = order.splice(0, 2);
      order.push(...reph);
    }
  }
  return order;
}

/// Convenience: reorder a whole codepoint stream syllable-by-syllable.
/// Returns the permutation as a flat Uint32Array of indices that maps
/// new-position → original-cp-index. Non-Indic codepoints pass through.
export function reorderIndicStream(cps) {
  const n = cps.length;
  const order = new Uint32Array(n);
  const syllables = findIndicSyllables(cps);
  let outIdx = 0;
  for (const { start, end } of syllables) {
    const sylOrder = reorderSyllable(cps, start, end);
    for (const j of sylOrder) order[outIdx++] = j;
  }
  return order;
}

/// Variant of reorderSyllable that takes an explicit "had initial
/// reph" flag and the number of glyphs that constitute the reph.
/// Used AFTER pre-reorder GSUB features (rphf) have run — they may
/// have collapsed (ra, halant) → (reph) into a single glyph, in
/// which case the original `hasInitialReph` detector (based on the
/// post-rphf cp stream) wouldn't fire.
///
/// `cps`/`start`/`end` describe the CURRENT (post-feature) state of
/// the syllable. `hadReph` is the snapshot from BEFORE feature
/// application. `rephLen` is the number of leading glyphs that
/// represent the reph: 2 when rphf didn't fire (ra+halant intact),
/// 1 when rphf fired (single collapsed glyph). Callers compute
/// rephLen by tracking how many glyphs were consumed.
export function reorderSyllableExplicitReph(cps, start, end, hadReph, rephLen) {
  const order = [];
  for (let i = start; i < end; i++) order.push(i);
  if (end - start <= 1) return order;

  // Pre-base matra step (same as reorderSyllable).
  const baseIdx = pickBaseConsonant(cps, start, end);
  if (baseIdx >= 0) {
    let preMatraOrderIdx = -1;
    for (let k = 0; k < order.length; k++) {
      const idx = order[k];
      if (idx <= baseIdx) continue;
      const c = classifyIsc(cps[idx]);
      if (c !== Isc.VowelDependent) continue;
      if (classifyIpc(cps[idx]) === Ipc.Left) {
        preMatraOrderIdx = k;
        break;
      }
    }
    if (preMatraOrderIdx >= 0) {
      const preMatraAbsIdx = order[preMatraOrderIdx];
      order.splice(preMatraOrderIdx, 1);
      const baseOrderIdx = order.indexOf(baseIdx);
      order.splice(baseOrderIdx, 0, preMatraAbsIdx);
    }
  }

  // Move the leading `rephLen` glyphs to the end if hadReph.
  if (hadReph && order.length >= rephLen) {
    // The reph glyphs occupy the FIRST `rephLen` indices in original
    // syllable order. After pre-matra reorder, they should still be at
    // positions 0..rephLen-1 since pre-matra only moves indices AFTER
    // the base (and reph sits before the base).
    let prefixOk = true;
    for (let k = 0; k < rephLen; k++) {
      if (order[k] !== start + k) { prefixOk = false; break; }
    }
    if (prefixOk) {
      const reph = order.splice(0, rephLen);
      order.push(...reph);
    }
  }
  return order;
}
