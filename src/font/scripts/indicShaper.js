// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { shaperIsc as shaperIscTrie } from '../unicode/tables/shaperIsc.js';
import { shaperIpc as shaperIpcTrie } from '../unicode/tables/shaperIpc.js';
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
//      rkrf → pref → blwf → abvf → half → pstf → vatu → cjct, then,
//      after the reorder, init → pres → abvs → blws → psts → haln →
//      calt).
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
  Other: 0, // anything outside the Indic block
  Consonant: 1,
  ConsonantDead: 2, // consonant that always carries inherent virama (rare)
  ConsonantPlaceholder: 3, // U+25CC dotted circle (placeholder)
  Nukta: 4,
  Halant: 5, // virama
  ZWJ: 6,
  ZWNJ: 7,
  VowelIndependent: 8,
  VowelDependent: 9, // matra
  Anudatta: 10,
  Bindu: 11, // anusvara/candrabindu/visarga
  Modifier: 12, // miscellaneous (avagraha, danda, etc.)
  Ra: 13, // Devanagari/Bengali RA — special because it forms reph
  RegisteredShifter: 14, // Bengali only; ignored for Devanagari
  Number: 15,
});

/// Indic Positional Category — where this glyph renders relative to
/// the syllable base. Drives reordering.
export const Ipc = Object.freeze({
  Right: 0, // default; glyph follows base
  Left: 1, // pre-base matra (e.g. Devanagari I-sign)
  Top: 2, // above base (e.g. Devanagari E/AI matra, candrabindu)
  Bottom: 3, // below base (e.g. Devanagari U-sign matras)
  LeftRight: 4, // wraps around base (e.g. Devanagari O matra: top+right)
  TopRight: 5,
  BottomRight: 6,
  TopBottomRight: 7,
});

// -- Codepoint → Indic script -----------------------------------------

/// The script bucket for a codepoint, or null if not Indic.
export function indicScriptOf(codepoint) {
  if (codepoint >= 0x0900 && codepoint <= 0x097f) return 'deva';
  if (codepoint >= 0x0980 && codepoint <= 0x09ff) return 'beng';
  if (codepoint >= 0x0a00 && codepoint <= 0x0a7f) return 'guru';
  if (codepoint >= 0x0a80 && codepoint <= 0x0aff) return 'gujr';
  if (codepoint >= 0x0b00 && codepoint <= 0x0b7f) return 'orya';
  if (codepoint >= 0x0b80 && codepoint <= 0x0bff) return 'taml';
  if (codepoint >= 0x0c00 && codepoint <= 0x0c7f) return 'telu';
  if (codepoint >= 0x0c80 && codepoint <= 0x0cff) return 'knda';
  if (codepoint >= 0x0d00 && codepoint <= 0x0d7f) return 'mlym';
  if (codepoint >= 0x0d80 && codepoint <= 0x0dff) return 'sinh';
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
  return (
    c === Isc.Consonant ||
    c === Isc.ConsonantDead ||
    c === Isc.Ra ||
    c === Isc.VowelIndependent ||
    c === Isc.ConsonantPlaceholder ||
    c === Isc.Other ||
    c === Isc.Number
  );
}

/// True iff `iscCat` can extend an existing syllable (it's a continuation
/// glyph that attaches to the previous cluster).
function _isSyllableExtender(c) {
  return (
    c === Isc.Nukta ||
    c === Isc.Halant ||
    c === Isc.VowelDependent ||
    c === Isc.Bindu ||
    c === Isc.Anudatta ||
    c === Isc.ZWJ ||
    c === Isc.ZWNJ
  );
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
        // The joiners a writer puts between the halant and the
        // consonant to ask for an explicit half or subjoined form are
        // part of that cluster too: cutting the syllable at them splits
        // `ka + halant + ZWJ + ra` into two, and neither half can then
        // reach the lookup that spells the pair as one glyph.
        let k = j - 1;
        while (k > i && _isJoinerCat(classifyIsc(cps[k]))) k--;
        const prev = classifyIsc(cps[k]);
        if (
          prev === Isc.Halant &&
          (c === Isc.Consonant || c === Isc.Ra || c === Isc.ConsonantDead)
        ) {
          j++;
          continue;
        }
        break;
      }
      if (
        !_isSyllableExtender(c) &&
        c !== Isc.Consonant &&
        c !== Isc.Ra &&
        c !== Isc.ConsonantDead
      ) {
        break;
      }
      j++;
    }
    out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------
// Base consonant.
//
// The base is the consonant the rest of the syllable is arranged around:
// half forms sit before it, below-base and post-base forms after it, and
// a pre-base matra reorders to just before it. Everything downstream —
// which glyph gets `half`, which gets `blwf`/`pstf`, where the matra
// lands — is decided by this one index.
//
// The rule is NOT "the last consonant". Per the OpenType Indic model it
// walks BACKWARD from the syllable end to the first consonant that has
// neither a below-base nor a post-base form, and two things make that
// walk more than a scan of the codepoints:
//
//   * it is FONT-DEPENDENT. Whether a consonant "has a below-base form"
//     is a question only the font can answer, and it is asked with the
//     `wouldSubstitute` probe, not by looking the codepoint up in a
//     table. Bengali `da + halant + X + aa` shapes three structurally
//     different ways depending on whether X carries a `pstf` form: with
//     one, the base is `da` and X takes its post-base form; without one,
//     X is the base and `da` takes its half form.

// Sinhala does not use this algorithm at all: its base is found by a
// FORWARD walk that needs no font query, and its ZWJ rule is its own
// (see `_baseSearchSinhala`).
// ---------------------------------------------------------------------

/// Where the font places a consonant relative to the base. The values a
/// `blwf` / `pstf` / `pref` probe can report.
export const ConsPos = Object.freeze({
  Base: 0, // no below-base or post-base form — a base candidate
  Below: 1, // has a below-base form ('blwf')
  Post: 2, // has a post-base form ('pstf' or 'pref')
});

/// How a script spells a reph. Drives how many glyphs the `rphf` probe
/// is handed and whether a joiner is required.
export const RephMode = Object.freeze({
  Implicit: 0, // Ra + Halant, and the glyph after must NOT be a joiner
  Explicit: 1, // Ra + Halant + ZWJ; the probe takes all three
  LogRepha: 2, // the script encodes the repha as its own codepoint
});

/// Reph spelling per Indic script. Telugu and Sinhala want the ZWJ
/// spelled out; Malayalam encodes its repha (U+0D4E) as a codepoint of
/// its own, so no Ra + Halant pair forms one.
const REPH_MODE_BY_SCRIPT = {
  deva: RephMode.Implicit,
  beng: RephMode.Implicit,
  guru: RephMode.Implicit,
  gujr: RephMode.Implicit,
  orya: RephMode.Implicit,
  taml: RephMode.Implicit,
  telu: RephMode.Explicit,
  knda: RephMode.Implicit,
  mlym: RephMode.LogRepha,
  sinh: RephMode.Explicit,
};

/// The virama codepoint for each script. The font-dependent position
/// probe asks about the pair (virama, consonant), so the syllable's own
/// halant is not enough — a syllable with no halant still has
/// consonants whose position has to be resolved.
const VIRAMA_BY_SCRIPT = {
  deva: 0x094d,
  beng: 0x09cd,
  guru: 0x0a4d,
  gujr: 0x0acd,
  orya: 0x0b4d,
  taml: 0x0bcd,
  telu: 0x0c4d,
  knda: 0x0ccd,
  mlym: 0x0d4d,
  sinh: 0x0dca,
};

export function rephModeForScript(script) {
  const m = REPH_MODE_BY_SCRIPT[script];
  return m === undefined ? RephMode.Implicit : m;
}

export function viramaForScript(script) {
  const v = VIRAMA_BY_SCRIPT[script];
  return v === undefined ? 0 : v;
}

/// True iff `cat` is one of the categories that can BE a base. An
/// independent vowel and a placeholder count: a syllable made of one is
/// arranged around it exactly as one made of a consonant is.
export function isIndicBaseCandidate(c) {
  return (
    c === Isc.Consonant ||
    c === Isc.Ra ||
    c === Isc.ConsonantDead ||
    c === Isc.VowelIndependent ||
    c === Isc.ConsonantPlaceholder
  );
}

function _isJoinerCat(c) {
  return c === Isc.ZWJ || c === Isc.ZWNJ;
}

/*
* Ask the font where a consonant sits relative to the base.
 *
 *
 * `pref` reports Post rather than a category of its own: a pre-base
 * reordering Ra is not a base candidate either, and the reorder that
 * moves it is driven by the feature, not by this index.

 */
export function consonantPositionFromFont(probe, consonantGid, viramaGid) {
  if (!probe || !viramaGid) return ConsPos.Base;
  const newSpec = [viramaGid, consonantGid];
  const oldSpec = [consonantGid, viramaGid];
  if (probe('blwf', newSpec) || probe('blwf', oldSpec)) return ConsPos.Below;
  if (probe('pstf', newSpec) || probe('pstf', oldSpec)) return ConsPos.Post;
  if (probe('pref', newSpec) || probe('pref', oldSpec)) return ConsPos.Post;
  return ConsPos.Base;
}

/// The backward walk, for every Indic script but Sinhala. `positionAt`
/// reports a consonant's font-resolved position; with no font every
/// consonant reads Base and the walk degenerates to the last consonant,
/// which is what the codepoint-only entry point wants.
function _baseSearchLast(cps, start, end, limit, positionAt) {
  if (end <= start) return -1;
  let base = end;
  let seenBelow = false;
  let i = end;
  do {
    i--;
    const cat = classifyIsc(cps[i]);
    if (isIndicBaseCandidate(cat)) {
      const pos = positionAt(i);
      // A consonant with neither a below-base nor a post-base form ends
      // the walk. A post-base form only ends it once a below-base form
      // has already been seen, because post-base forms have to follow
      // below-base ones — a post-base consonant sitting above a
      // below-base one is out of order and cannot be the base.
      if (pos !== ConsPos.Below && (pos !== ConsPos.Post || seenBelow)) {
        base = i;
        break;
      }
      if (pos === ConsPos.Below) seenBelow = true;
      // Not a candidate, but remember it: if the walk reaches the first
      // consonant without finding one, that consonant is the base.
      base = i;
    } else if (start < i && cat === Isc.ZWJ && classifyIsc(cps[i - 1]) === Isc.Halant) {
      break;
    }
  } while (i > limit);
  return base === end ? -1 : base;
}

function _baseSearchSinhala(cps, start, end, limit, hasReph) {
  if (end <= start) return -1;
  let base = hasReph ? start : limit;
  for (let i = limit; i < end; i++) {
    if (!isIndicBaseCandidate(classifyIsc(cps[i]))) continue;
    if (limit < i && classifyIsc(cps[i - 1]) === Isc.ZWJ) break;
    base = i;
  }
  return base >= end ? -1 : base;
}

/**
 * Resolve a syllable's base consonant and its reph.
 *
 * Returns `{ base, hasReph, rephLimit }`. `base` is an absolute index in
 * `cps` (-1 when the syllable holds no consonant); `rephLimit` is the
 * first index the base search is allowed to reach, which is past the
 * reph and any joiners following it.
 *
 * `ctx` carries the font: `positionAt(i)` (a `ConsPos`), `gidAt(i)`,
 * `rphfProbe(gids)` and `hasRphf`. Pass none and the answer is the
 * codepoint-only one — the last consonant, with a leading Ra + Halant
 * read as a reph.
 */
export function analyzeIndicSyllable(cps, start, end, ctx = null) {
  const script = indicScriptOf(cps[start]);
  const sinhala = script === 'sinh';
  const rephMode = ctx && ctx.rephMode !== undefined ? ctx.rephMode : rephModeForScript(script);
  const positionAt = (ctx && ctx.positionAt) || (() => ConsPos.Base);
  const hasRphf = ctx ? !!ctx.hasRphf : true;

  let limit = start;
  let hasReph = false;
  // A reph needs a consonant to sit on, so the syllable has to hold at
  // least three codepoints: Ra, Halant and something to carry it.
  if (
    hasRphf &&
    start + 3 <= end &&
    classifyIsc(cps[start]) === Isc.Ra &&
    classifyIsc(cps[start + 1]) === Isc.Halant &&
    rephMode !== RephMode.LogRepha
  ) {
    const thirdCat = classifyIsc(cps[start + 2]);
    const spellingOk =
      rephMode === RephMode.Explicit ? thirdCat === Isc.ZWJ : !_isJoinerCat(thirdCat);
    // The font decides, not the codepoints: a font with an `rphf` whose
    // lookups do not cover this pair never wanted the reorder, and a
    // pair the font does not glyph as a reph must keep its order.
    let fontSaysReph = true;
    if (spellingOk && ctx && ctx.rphfProbe && ctx.gidAt) {
      const g0 = ctx.gidAt(start),
        g1 = ctx.gidAt(start + 1);
      fontSaysReph =
        rephMode === RephMode.Explicit
          ? ctx.rphfProbe([g0, g1, ctx.gidAt(start + 2)])
          : ctx.rphfProbe([g0, g1]);
    }
    if (spellingOk && fontSaysReph) {
      hasReph = true;
      limit = start + 2;
      while (limit < end && _isJoinerCat(classifyIsc(cps[limit]))) limit++;
    }
  }

  let base = sinhala
    ? _baseSearchSinhala(cps, start, end, limit, hasReph)
    : _baseSearchLast(cps, start, end, limit, positionAt);
  if (hasReph && !sinhala && base < 0) base = start;

  // An unforced reph with no other consonant to sit on is not a reph:
  // the Ra is the syllable's only base and keeps its place.
  if (hasReph && base === start && limit - base <= 2) hasReph = false;

  return { base, hasReph, rephLimit: limit };
}

/// Pick the "base" consonant index inside [start, end). Returns -1
/// when the syllable has no consonant (vowel-only or pure modifier).
///
/// The codepoint-only entry point: no font, so every consonant reads as
/// a base candidate and the backward walk stops at the last one. Callers
/// that hold the font should use `analyzeIndicSyllable` instead — see
/// the note above on why the answer depends on it.
export function pickBaseConsonant(cps, start, end) {
  return analyzeIndicSyllable(cps, start, end, null).base;
}

/// Detect whether a syllable starts with reph (Ra + Halant).
export function hasInitialReph(cps, start, end) {
  return (
    start + 1 < end &&
    classifyIsc(cps[start]) === Isc.Ra &&
    classifyIsc(cps[start + 1]) === Isc.Halant
  );
}

// ---------------------------------------------------------------------
// Per-syllable reordering.

/// `cps` is the codepoint array; the indices in the return array are
/// absolute (between start and end), suitable for use as a permutation
/// over the gid stream.
export function reorderSyllable(cps, start, end) {
  const order = [];
  for (let i = start; i < end; i++) order.push(i);
  if (end - start <= 1) return order;

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

/// `explicitBase`, when >= 0, is the base the caller already resolved
/// against the font. Recomputing it here from the post-feature
/// codepoints cannot reach the same answer: the substitutions have
/// already collapsed the consonants the base search reads, and a
/// multiple substitution's tail carries no codepoint at all.
export function reorderSyllableExplicitReph(
  cps,
  start,
  end,
  hadReph,
  rephLen,
  explicitBase = -1,
  matraBeforeBase = false,
) {
  const order = [];
  for (let i = start; i < end; i++) order.push(i);
  if (end - start <= 1) return order;

  // Pre-base matra step (same as reorderSyllable).
  const baseIdx = explicitBase >= 0 ? explicitBase : pickBaseConsonant(cps, start, end);
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
      // OpenType final reordering: the matra stands "after last standalone halant glyph, after initial matra position and before
      // the main consonant", and its initial position is the start of the syllable, behind a reph. A half form is no standalone
      // halant, so it leaves the matra in front of the whole conjunct. Malayalam and Tamil have no half forms (those glyphs are
      // chillus and explicit viramas): their matra goes right before the base. (HarfBuzz final_reordering_syllable_indic.)
      let at = baseOrderIdx;
      if (!matraBeforeBase) {
        at = Math.min(rephLen, baseOrderIdx);
        for (let k = baseOrderIdx - 1; k >= rephLen; k--) {
          if (classifyIsc(cps[order[k]]) === Isc.Halant) {
            at = k + 1;
            break;
          }
        }
      }
      order.splice(at, 0, preMatraAbsIdx);
    }
  }

  // Move the leading `rephLen` glyphs to the end if hadReph.
  if (hadReph && order.length >= rephLen) {
    let prefixOk = true;
    for (let k = 0; k < rephLen; k++) {
      if (order[k] !== start + k) {
        prefixOk = false;
        break;
      }
    }
    if (prefixOk) {
      const reph = order.splice(0, rephLen);
      order.push(...reph);
    }
  }
  return order;
}
