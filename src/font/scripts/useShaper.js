// useShaper.js — Universal Shaping Engine (USE).
//
// USE handles "complex" scripts that don't fit the Indic2 model:
// Khmer, Myanmar, Tibetan, Tai Tham, Tai Viet, Javanese, Balinese,
// Buginese, Buhid, Chakma, Cham, Hanunoo, Khojki, Mahajani, New Tai
// Lue, Phags-pa, Saurashtra, Sharada, Siddham, Sinhala (alternate
// path), Sundanese, Sylotinagri, Tagalog, Tagbanwa, Takri, Tibetan,
// Tifinagh, etc.
//
// Scope here:
//   - USE Cluster Category (UCC) table for Khmer + Myanmar + Tibetan
//   - USE Cluster Position (UCP) table for matra positioning
//   - Cluster boundary detection via UCC-driven state machine
//   - Pre-base matra reorder + pre-base subscript consonant detection
//   - Kinzi handling for Myanmar (Ra + Halant + ZWJ at syllable start)
//
// Reference:
//   https://learn.microsoft.com/en-us/typography/script-development/use
//   IndicSyllabicCategory.txt + IndicPositionalCategory.txt (UCD)

/// USE Cluster Category. Granular per-codepoint classification.
/// Integer values stable.
export const Ucc = Object.freeze({
  Other:           0,
  Base:            1,   // B
  GenericBase:     2,   // GB — placeholder (dotted circle)
  IndVowel:        3,   // IND — independent vowel
  RepBase:         4,   // RB — Repha base (rarely used in USE)
  Number:          5,
  Symbol:          6,
  ConsonantSub:    7,   // CS — subscript consonant (Khmer COENG-base)
  VariantSelector: 8,   // VS

  Halant:         10,   // H — virama
  HalantVowelMod: 11,   // HVM
  ZWJ:            12,
  ZWNJ:           13,

  // Matras (dependent vowels), split by position
  MatraPre:       20,   // MPre — pre-base
  MatraAbove:     21,   // MAbv
  MatraBelow:     22,   // MBlw
  MatraPost:      23,   // MPst
  Matra:          24,   // M — fallback when position unknown

  // Vowel modifiers (anusvara, candrabindu, etc.)
  VowelMod:       30,   // SUFFIX / vowel modifier marks

  // Combining marks (script-specific)
  CMAbove:        31,
  CMBelow:        32,

  // Sakot (some scripts use this as halant variant)
  Sakot:          40,
});

/// USE Cluster Position — coarser than UCC but used for matra
/// positioning. Mostly redundant with the Matra* UCC values; kept for
/// codepoints where the UCC alone doesn't fully classify (e.g. Symbol
/// with positional intent).
export const Ucp = Object.freeze({
  Right:       0,
  Left:        1,    // pre-base
  Top:         2,
  Bottom:      3,
  TopLeft:     4,
  TopRight:    5,
  BottomLeft:  6,
  BottomRight: 7,
  LeftRight:   8,
});

// ---- Khmer (U+1780..U+17FF) -----------------------------------------
//
// Khmer is the canonical USE script: its cluster grammar uses COENG
// (U+17D2) as the "halant" between stacked consonants, and 3 pre-base
// vowel modifiers that render before the base.
//
// Key codepoints:
//   U+1780..U+17B3: consonants (33 letters)
//   U+17B6..U+17C5: dependent vowels (matras)
//   U+17C6..U+17DD: signs (anusvara/visarga, tone marks, COENG, etc.)
//   U+17C1..U+17C3: pre-base vowels E / AE / AI (RENDER BEFORE BASE)
//   U+17D2: KHMER SIGN COENG (subscript-consonant prefix; like halant)
const _KHMER_UCC = {};
const _KHMER_UCP = {};
for (let cp = 0x1780; cp <= 0x17B3; cp++) _KHMER_UCC[cp] = Ucc.Base;
for (let cp = 0x17B4; cp <= 0x17B5; cp++) _KHMER_UCC[cp] = Ucc.VowelMod; // inherent vowels (rare)
for (let cp = 0x17B6; cp <= 0x17C5; cp++) {
  _KHMER_UCC[cp] = Ucc.Matra;
  _KHMER_UCP[cp] = Ucp.Right;
}
// Pre-base matras
_KHMER_UCC[0x17C1] = Ucc.MatraPre;  _KHMER_UCP[0x17C1] = Ucp.Left; // E
_KHMER_UCC[0x17C2] = Ucc.MatraPre;  _KHMER_UCP[0x17C2] = Ucp.Left; // AE
_KHMER_UCC[0x17C3] = Ucc.MatraPre;  _KHMER_UCP[0x17C3] = Ucp.Left; // AI
// Above-base matras
_KHMER_UCC[0x17B7] = Ucc.MatraAbove; _KHMER_UCP[0x17B7] = Ucp.Top; // I
_KHMER_UCC[0x17B8] = Ucc.MatraAbove; _KHMER_UCP[0x17B8] = Ucp.Top; // II
_KHMER_UCC[0x17B9] = Ucc.MatraAbove; _KHMER_UCP[0x17B9] = Ucp.Top; // Y
_KHMER_UCC[0x17BA] = Ucc.MatraAbove; _KHMER_UCP[0x17BA] = Ucp.Top; // YY
// Below-base matras
_KHMER_UCC[0x17BB] = Ucc.MatraBelow; _KHMER_UCP[0x17BB] = Ucp.Bottom; // U
_KHMER_UCC[0x17BC] = Ucc.MatraBelow; _KHMER_UCP[0x17BC] = Ucp.Bottom; // UU
_KHMER_UCC[0x17BD] = Ucc.MatraBelow; _KHMER_UCP[0x17BD] = Ucp.Bottom; // UA
// Signs (anusvara, visarga, ROBAT, etc.)
_KHMER_UCC[0x17C6] = Ucc.VowelMod;   _KHMER_UCP[0x17C6] = Ucp.Top; // anusvara
_KHMER_UCC[0x17C7] = Ucc.Matra;      _KHMER_UCP[0x17C7] = Ucp.Right; // AHSDA (post-base)
_KHMER_UCC[0x17C8] = Ucc.Matra;      _KHMER_UCP[0x17C8] = Ucp.Right; // YUUKALEAPINTU
for (let cp = 0x17C9; cp <= 0x17D1; cp++) _KHMER_UCC[cp] = Ucc.VowelMod; // tone marks etc.
_KHMER_UCC[0x17D2] = Ucc.Halant;  // COENG — Khmer halant
_KHMER_UCC[0x17D3] = Ucc.VowelMod; // BATHAMASAT
_KHMER_UCC[0x17D7] = Ucc.VowelMod; // LEK TOO (a length sign)
_KHMER_UCC[0x17DD] = Ucc.VowelMod; // ATTHACAN
for (let cp = 0x17E0; cp <= 0x17E9; cp++) _KHMER_UCC[cp] = Ucc.Number;

// ---- Myanmar (U+1000..U+109F) ---------------------------------------
//
// Myanmar uses U+1039 (virama) as halant. "Kinzi" = U+1004 + U+103A
// (asat) + U+1039 (virama) — a 3-codepoint prefix that renders as a
// superscript at the END of the syllable (like Indic reph but with a
// different trigger sequence). The parts are classified here; kinzi
// detection happens in the cluster boundary phase.
const _MYANMAR_UCC = {};
const _MYANMAR_UCP = {};
for (let cp = 0x1000; cp <= 0x102A; cp++) _MYANMAR_UCC[cp] = Ucc.Base;  // consonants
// Independent vowels U+1023..U+1027 + U+1029..U+102A
for (let cp = 0x1023; cp <= 0x1027; cp++) _MYANMAR_UCC[cp] = Ucc.IndVowel;
for (let cp = 0x1029; cp <= 0x102A; cp++) _MYANMAR_UCC[cp] = Ucc.IndVowel;
// Dependent vowels (matras)
for (let cp = 0x102B; cp <= 0x1032; cp++) {
  _MYANMAR_UCC[cp] = Ucc.Matra;
  _MYANMAR_UCP[cp] = Ucp.Right;
}
// Pre-base matras
_MYANMAR_UCC[0x1031] = Ucc.MatraPre;  _MYANMAR_UCP[0x1031] = Ucp.Left; // E
// Above/below matras
_MYANMAR_UCC[0x102D] = Ucc.MatraAbove; _MYANMAR_UCP[0x102D] = Ucp.Top; // I
_MYANMAR_UCC[0x102E] = Ucc.MatraAbove; _MYANMAR_UCP[0x102E] = Ucp.Top; // II
_MYANMAR_UCC[0x1032] = Ucc.MatraAbove; _MYANMAR_UCP[0x1032] = Ucp.Top; // AI
_MYANMAR_UCC[0x102F] = Ucc.MatraBelow; _MYANMAR_UCP[0x102F] = Ucp.Bottom; // U
_MYANMAR_UCC[0x1030] = Ucc.MatraBelow; _MYANMAR_UCP[0x1030] = Ucp.Bottom; // UU
// Signs
_MYANMAR_UCC[0x1036] = Ucc.VowelMod;  _MYANMAR_UCP[0x1036] = Ucp.Top; // anusvara
_MYANMAR_UCC[0x1037] = Ucc.VowelMod;  _MYANMAR_UCP[0x1037] = Ucp.Bottom; // dot below
_MYANMAR_UCC[0x1038] = Ucc.VowelMod;  _MYANMAR_UCP[0x1038] = Ucp.Right; // visarga
_MYANMAR_UCC[0x1039] = Ucc.Halant;    // VIRAMA
_MYANMAR_UCC[0x103A] = Ucc.VowelMod;  _MYANMAR_UCP[0x103A] = Ucp.Top; // ASAT (kinzi component)
// Medials (substitute consonants) U+103B..U+103E — classify as Below
_MYANMAR_UCC[0x103B] = Ucc.ConsonantSub; _MYANMAR_UCP[0x103B] = Ucp.Right;  // medial YA
_MYANMAR_UCC[0x103C] = Ucc.ConsonantSub; _MYANMAR_UCP[0x103C] = Ucp.Left;   // medial RA (pre-base!)
_MYANMAR_UCC[0x103D] = Ucc.ConsonantSub; _MYANMAR_UCP[0x103D] = Ucp.Bottom; // medial WA
_MYANMAR_UCC[0x103E] = Ucc.ConsonantSub; _MYANMAR_UCP[0x103E] = Ucp.Bottom; // medial HA
for (let cp = 0x1040; cp <= 0x1049; cp++) _MYANMAR_UCC[cp] = Ucc.Number;
// Myanmar extensions (Shan / Khamti / Pali) — minimal coverage
for (let cp = 0x1050; cp <= 0x1055; cp++) _MYANMAR_UCC[cp] = Ucc.Base;
for (let cp = 0x1056; cp <= 0x1059; cp++) {
  _MYANMAR_UCC[cp] = Ucc.Matra;
  _MYANMAR_UCP[cp] = Ucp.Right;
}
for (let cp = 0x105A; cp <= 0x1060; cp++) _MYANMAR_UCC[cp] = Ucc.Base;
for (let cp = 0x1071; cp <= 0x1074; cp++) _MYANMAR_UCC[cp] = Ucc.MatraAbove;

// ---- Tibetan (U+0F00..U+0FFF) — basic coverage ---------------------
//
// Tibetan has stacked consonants (head + subjoined) and uses precomposed
// "stack" codepoints. The shaping needs are minimal because most Tibetan
// text uses precomposed forms; subjoined consonants are at U+0F90..U+0FBC.
const _TIBETAN_UCC = {};
const _TIBETAN_UCP = {};
for (let cp = 0x0F40; cp <= 0x0F6C; cp++) _TIBETAN_UCC[cp] = Ucc.Base;
for (let cp = 0x0F71; cp <= 0x0F87; cp++) {
  _TIBETAN_UCC[cp] = Ucc.Matra;
  _TIBETAN_UCP[cp] = Ucp.Right;
}
for (let cp = 0x0F90; cp <= 0x0FBC; cp++) _TIBETAN_UCC[cp] = Ucc.ConsonantSub;
for (let cp = 0x0F20; cp <= 0x0F29; cp++) _TIBETAN_UCC[cp] = Ucc.Number;
_TIBETAN_UCC[0x0F84] = Ucc.Halant; // VIRAMA

// ---------------------------------------------------------------------

const _USE_SCRIPT_RANGES = [
  // [origin, end, name, table]
  { lo: 0x0F00, hi: 0x0FFF, name: 'tibt', ucc: _TIBETAN_UCC, ucp: _TIBETAN_UCP },
  { lo: 0x1000, hi: 0x109F, name: 'mymr', ucc: _MYANMAR_UCC, ucp: _MYANMAR_UCP },
  { lo: 0x1780, hi: 0x17FF, name: 'khmr', ucc: _KHMER_UCC,   ucp: _KHMER_UCP   },
];

/// True iff `codepoint` is in a USE-handled script range.
export function isUseCodepoint(codepoint) {
  for (const r of _USE_SCRIPT_RANGES) {
    if (codepoint >= r.lo && codepoint <= r.hi) return true;
  }
  return codepoint === 0x200C || codepoint === 0x200D || codepoint === 0x25CC;
}

/// Script bucket name for `codepoint` ('khmr' / 'mymr' / 'tibt' / null).
export function useScriptOf(codepoint) {
  for (const r of _USE_SCRIPT_RANGES) {
    if (codepoint >= r.lo && codepoint <= r.hi) return r.name;
  }
  return null;
}

/// Classify a codepoint into Ucc (USE Cluster Category).
export function classifyUcc(codepoint) {
  if (codepoint === 0x200C) return Ucc.ZWNJ;
  if (codepoint === 0x200D) return Ucc.ZWJ;
  if (codepoint === 0x25CC) return Ucc.GenericBase;
  for (const r of _USE_SCRIPT_RANGES) {
    if (codepoint >= r.lo && codepoint <= r.hi) {
      const c = r.ucc[codepoint];
      return c != null ? c : Ucc.Other;
    }
  }
  return Ucc.Other;
}

/// Classify a codepoint's positional category (USE Cluster Position).
export function classifyUcp(codepoint) {
  for (const r of _USE_SCRIPT_RANGES) {
    if (codepoint >= r.lo && codepoint <= r.hi) {
      const p = r.ucp[codepoint];
      return p != null ? p : Ucp.Right;
    }
  }
  return Ucp.Right;
}

/// True iff the UCC is a base-like glyph (anchors a cluster).
function _isClusterAnchor(ucc) {
  return ucc === Ucc.Base ||
         ucc === Ucc.IndVowel ||
         ucc === Ucc.GenericBase ||
         ucc === Ucc.RepBase ||
         ucc === Ucc.Number ||
         ucc === Ucc.Symbol;
}

/// True iff the UCC can extend an open cluster.
function _isClusterExtender(ucc) {
  return ucc === Ucc.Halant ||
         ucc === Ucc.HalantVowelMod ||
         ucc === Ucc.ConsonantSub ||
         ucc === Ucc.VariantSelector ||
         ucc === Ucc.ZWJ ||
         ucc === Ucc.ZWNJ ||
         ucc === Ucc.Matra ||
         ucc === Ucc.MatraPre ||
         ucc === Ucc.MatraAbove ||
         ucc === Ucc.MatraBelow ||
         ucc === Ucc.MatraPost ||
         ucc === Ucc.VowelMod ||
         ucc === Ucc.CMAbove ||
         ucc === Ucc.CMBelow ||
         ucc === Ucc.Sakot;
}

/// Find cluster boundaries in `cps`. Returns array of { start, end }
/// half-open ranges. Non-USE codepoints become single-cp clusters so
/// they pass through layout unchanged.
///
/// USE cluster grammar (simplified):
///   Cluster ::= (Kinzi)? Base [Halant Base]* (Matras | VowelMod)*
///
/// Boundaries open on:
///   - A new Base/IndVowel/Number/Symbol when the previous cp wasn't
///     a Halant (Halant+Base continues the same cluster)
///   - A non-USE codepoint (Other)
export function findUseClusters(cps) {
  const out = [];
  const n = cps.length;
  let i = 0;
  while (i < n) {
    const startCat = classifyUcc(cps[i]);
    if (startCat === Ucc.Other) {
      out.push({ start: i, end: i + 1 });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const c = classifyUcc(cps[j]);
      if (_isClusterAnchor(c) && c !== Ucc.Other) {
        // New anchor — but if preceded by Halant, it's a subscript
        // continuation of the current cluster.
        const prev = classifyUcc(cps[j - 1]);
        if (prev === Ucc.Halant) {
          j++;
          continue;
        }
        break;
      }
      if (!_isClusterExtender(c)) break;
      j++;
    }
    out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

/// Detect Myanmar "kinzi" at the start of a cluster.
/// Kinzi = U+1004 (NGA) + U+103A (ASAT) + U+1039 (VIRAMA)
/// Renders as a superscript at the END of the syllable.
export function hasMyanmarKinzi(cps, start, end) {
  return start + 2 < end &&
         cps[start    ] === 0x1004 &&
         cps[start + 1] === 0x103A &&
         cps[start + 2] === 0x1039;
}

/// Pick base consonant in [start, end). USE rule: the LAST consonant
/// that isn't followed by a halant. Subscript consonants (CS) don't
/// count as base candidates.
export function pickUseBase(cps, start, end) {
  let scan = start;
  if (hasMyanmarKinzi(cps, start, end)) scan += 3;
  let last = -1;
  for (let k = scan; k < end; k++) {
    const c = classifyUcc(cps[k]);
    if (c === Ucc.Base || c === Ucc.IndVowel) last = k;
  }
  return last;
}

/// Reorder a USE cluster. Returns absolute-index permutation.
///
/// Two reorders:
///   1. Pre-base matra (Ucp.Left) moves to JUST BEFORE the base.
///      Includes Myanmar medial RA (U+103C) which is also pre-base.
///   2. Myanmar kinzi (NGA+ASAT+VIRAMA at cluster start) moves to end.
export function reorderUseCluster(cps, start, end) {
  const order = [];
  for (let i = start; i < end; i++) order.push(i);
  if (end - start <= 1) return order;

  // Pre-base step.
  const baseIdx = pickUseBase(cps, start, end);
  if (baseIdx >= 0) {
    let preMatraOrderIdx = -1;
    for (let k = 0; k < order.length; k++) {
      const idx = order[k];
      if (idx <= baseIdx) continue;
      if (classifyUcp(cps[idx]) === Ucp.Left) {
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

  // Kinzi step (Myanmar): move first 3 indices (NGA+ASAT+VIRAMA) to end.
  if (hasMyanmarKinzi(cps, start, end) && order.length >= 3 &&
      order[0] === start && order[1] === start + 1 && order[2] === start + 2) {
    const kinzi = order.splice(0, 3);
    order.push(...kinzi);
  }
  return order;
}
