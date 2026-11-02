// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bidi.js — Unicode Bidirectional Algorithm.
//
// Per-codepoint bidi-class lookup via the generated Bidi_Class trie
// (DerivedBidiClass.txt). Codepoints not in the table default to L (the
// UCD default for unassigned characters in LTR blocks).
//
// Spec: https://www.unicode.org/reports/tr9/

import { BaseDirection } from './bidiConst.js';
export { BaseDirection };

import { bidiClass as bidiClassTrie } from './unicode/tables/bidiClass.js';
import { bidiMaps } from './unicode/tables/bidiMaps.js';

/** UAX #9 bidi character types (BidiClass). */
export const BidiClass = Object.freeze({
  // Strong types
  L: 0, // Left-to-Right (Latin, Greek, Cyrillic, CJK, ...)
  R: 1, // Right-to-Left (Hebrew)
  AL: 2, // Arabic Letter
  // Weak types (digits + separators)
  EN: 3, // European Number (0-9)
  ES: 4, // European Number Separator (+ -)
  ET: 5, // European Number Terminator ($ %)
  AN: 6, // Arabic Number (Arabic-Indic digits)
  CS: 7, // Common Separator (. , : ;  /)
  NSM: 8, // Nonspacing Mark
  BN: 9, // Boundary Neutral
  // Neutrals
  B: 10, // Paragraph Separator (\n, U+2029)
  S: 11, // Segment Separator (\t, U+001F)
  WS: 12, // Whitespace (space, U+200B ZWSP, etc.)
  ON: 13, // Other Neutral (punctuation, symbols)
  // Explicit (flagged in source but unused)
  LRE: 14,
  RLE: 15,
  LRO: 16,
  RLO: 17,
  PDF: 18,
  LRI: 19,
  RLI: 20,
  FSI: 21,
  PDI: 22,
});

const L = BidiClass.L,
  R = BidiClass.R,
  AL = BidiClass.AL;
const EN = BidiClass.EN,
  ES = BidiClass.ES,
  ET = BidiClass.ET;
const AN = BidiClass.AN,
  CS = BidiClass.CS,
  NSM = BidiClass.NSM;
const BN = BidiClass.BN,
  B = BidiClass.B,
  S = BidiClass.S;
const WS = BidiClass.WS,
  ON = BidiClass.ON;

/** Returns the bidi class for `codepoint`. Full UCD coverage via the generated
 *  Bidi_Class trie (DerivedBidiClass.txt, incl. block-level @missing defaults so
 *  exotic RTL scripts — Thaana, N'Ko, Syriac, Mongolian, Adlam — classify
 *  correctly). The trie's value order matches the BidiClass enum above. */
export function getBidiClass(codepoint) {
  return bidiClassTrie.get(codepoint);
}

/** True iff `cls` is a strong RTL class (R or AL). */
export function isRtlStrong(cls) {
  return cls === R || cls === AL;
}

/** True iff `cls` is a strong class of any direction. */
export function isStrong(cls) {
  return cls === L || cls === R || cls === AL;
}

/** Paragraph base direction. Either explicit (caller-specified) or
 *  Auto = derive from the first strong character per UAX #9 P2/P3. */
// BaseDirection is defined in ./bidiConst.js and re-exported at the top
// of this module (so the lean text path can import the enum without
// pulling in this file's tables).

/// Detect paragraph base direction from an array of codepoints per
/// UAX #9 P2/P3: scan for the first strong character (L / R / AL).
/// L → LTR, R/AL → RTL. When no strong char is found, defaults to
/// LTR (the same fallback the Unicode spec uses for ambiguous text).
///
/// Characters inside an isolate (initiator through matching PDI) are
/// skipped per P2; embedding/override codes (LRE/RLE/LRO/RLO/PDF) are
/// not strong, so they never terminate the scan.
export function detectParagraphDirection(codepoints) {
  // P2: first L/R/AL, skipping characters between an isolate initiator and its
  // matching PDI. P3: L → LTR, R/AL → RTL, else LTR.
  let depth = 0;
  for (let i = 0; i < codepoints.length; i++) {
    const cls = getBidiClass(codepoints[i]);
    if (cls === BidiClass.LRI || cls === BidiClass.RLI || cls === BidiClass.FSI) depth++;
    else if (cls === BidiClass.PDI) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      if (cls === L) return BaseDirection.Ltr;
      if (cls === R || cls === AL) return BaseDirection.Rtl;
    }
  }
  return BaseDirection.Ltr;
}

/// Resolve a base direction. Auto → run the detector; Ltr/Rtl → fixed.
export function resolveBaseDirection(baseDir, codepoints) {
  if (baseDir === BaseDirection.Ltr) return BaseDirection.Ltr;
  if (baseDir === BaseDirection.Rtl) return BaseDirection.Rtl;
  return detectParagraphDirection(codepoints);
}

// ---------------------------------------------------------------------
// Level resolution.
//
// Implements UAX #9 W/N/I rules + N0 paired brackets. Text without
// explicit isolate/override characters is a single isolating-run
// sequence handled by _resolveLevelsRaw; text with them routes through
// _resolveLevelsWithIsolates, which segments per isolate and treats
// the deprecated embedding/override codes as ON.
//
// Input: codepoints + paragraph base direction.
// Output: per-codepoint embedding level (0..125). Even = LTR, odd = RTL.
// ---------------------------------------------------------------------

function _classifyForResolve(cls) {
  // Treat explicit overrides + isolates as ON for the simplified
  // resolver: they don't appear in the kinds of paragraphs the renderer
  // handles, and downstream they'd be filtered anyway.
  if (cls >= BidiClass.LRE) return BidiClass.ON;
  return cls;
}

/// Compute embedding levels for `codepoints` under `baseDir`.
/// Returns Uint8Array of length codepoints.length.

/// Bidi control chars (LRE/RLE/LRO/RLO/PDF, the deprecated explicit
/// overrides) are still treated as ON — DTP-style explicit overrides
/// in plain text are rare and removing them is the spec's preferred
/// approach anyway.
export function resolveLevels(codepoints, baseDir) {
  const n = codepoints.length;
  if (n === 0) return new Uint8Array(0);
  // Resolve an Auto base direction (P2/P3) to a concrete LTR/RTL paragraph.
  baseDir = resolveBaseDirection(baseDir, codepoints);
  // Scan for any isolation markers. If none, fast-path through the
  // single-segment resolver.
  let hasExplicit = false;
  for (let i = 0; i < n; i++) {
    const cls = getBidiClass(codepoints[i]);
    if (cls >= BidiClass.LRE) {
      // any of LRE/RLE/LRO/RLO/PDF/LRI/RLI/FSI/PDI
      hasExplicit = true;
      break;
    }
  }
  const levels = hasExplicit
    ? _resolveLevelsWithIsolates(codepoints, baseDir)
    : _resolveLevelsRaw(codepoints, baseDir);
  const paraLevel = baseDir === BaseDirection.Rtl ? 1 : 0;
  _applyL1(codepoints, levels, paraLevel);
  _retainRemoved(codepoints, levels, paraLevel);
  return levels;
}

/// UAX #9 §5.2, "Retaining Explicit Formatting Characters".
///
/// X9 deletes RLE/LRE/RLO/LRO/PDF and BN outright. This implementation keeps
/// them in the array (callers index by original position), which is the
/// sanctioned alternative — but only if they are given the level of the
/// PRECEDING character, paragraph level at the start. Otherwise they keep a
/// level of their own and L2 forms its runs around them, which reorders the
/// characters that DID survive.

function _retainRemoved(codepoints, levels, paraLevel) {
  let prev = paraLevel;
  for (let i = 0; i < levels.length; i++) {
    const c = getBidiClass(codepoints[i]);
    // The X9-removed set: the deprecated embedding/override pair-members and
    // BN. Isolate initiators/PDI (LRI/RLI/FSI/PDI) are NOT removed by X9 and
    // keep their own resolved level.
    if (c === BidiClass.BN || (c >= BidiClass.LRE && c <= BidiClass.PDF)) {
      levels[i] = prev;
    } else {
      prev = levels[i];
    }
  }
}

/// L1: reset segment/paragraph separators, and any sequence of whitespace or
/// isolate/embedding format characters preceding them or ending the paragraph,
/// to the paragraph embedding level. Uses ORIGINAL bidi classes.
function _applyL1(codepoints, levels, paraLevel) {
  const n = levels.length;
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const c = getBidiClass(codepoints[i]);
    // BN and the embedding controls are gone by X9, so they do not stop a trailing sequence (BidiTest.txt).
    if (c === BidiClass.WS || c === BidiClass.BN || c >= BidiClass.LRE) {
      if (runStart < 0) runStart = i;
    } else if (c === BidiClass.S || c === BidiClass.B) {
      levels[i] = paraLevel;
      if (runStart >= 0) for (let k = runStart; k < i; k++) levels[k] = paraLevel;
      runStart = -1;
    } else {
      runStart = -1;
    }
  }
  if (runStart >= 0) for (let k = runStart; k < n; k++) levels[k] = paraLevel;
}

/// Per-segment resolver: assumes no isolate markers in the input.
/// `forcedTypes` (optional) carries directional-override results from X6: where
/// not -1 it pins the character's type to L or R before the W rules run.
function _resolveLevelsRaw(codepoints, baseDir, forcedTypes, sosOverride, eosOverride) {
  const n = codepoints.length;
  const levels = new Uint8Array(n);
  if (n === 0) return levels;
  const baseLevel = baseDir === BaseDirection.Rtl ? 1 : 0;
  const types = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    types[i] =
      forcedTypes && forcedTypes[i] >= 0
        ? forcedTypes[i]
        : _classifyForResolve(getBidiClass(codepoints[i]));
  }
  // Original NSM positions (before W1 reclassifies them) — needed by N0 step 4.
  const wasNSM = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (types[i] === BidiClass.NSM) wasNSM[i] = 1;

  const isBN = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (types[i] === BidiClass.BN) isBN[i] = 1;

  // ---- W1: NSM takes the type of preceding char (or sos = baseDir).
  // sos/eos: direction at the start/end of the isolating run sequence (X10).
  // Default to the run's own base direction; the explicit resolver overrides
  // them with the higher of this run's level and the neighboring level.
  const sosCls =
    sosOverride !== undefined ? sosOverride : baseLevel & 1 ? BidiClass.R : BidiClass.L;
  const eosCls = eosOverride !== undefined ? eosOverride : sosCls;
  {
    let prev = sosCls;
    for (let i = 0; i < n; i++) {
      if (isBN[i]) continue;
      if (types[i] === BidiClass.NSM) types[i] = prev;
      else prev = types[i];
    }
  }

  // ---- W2: EN preceded by AL (with intervening weak types skipped) → AN.
  {
    let lastStrong = sosCls;
    for (let i = 0; i < n; i++) {
      if (isBN[i]) continue;
      const t = types[i];
      if (t === BidiClass.L || t === BidiClass.R || t === BidiClass.AL) lastStrong = t;
      else if (t === BidiClass.EN && lastStrong === BidiClass.AL) types[i] = BidiClass.AN;
    }
  }

  // ---- W3: AL → R.
  for (let i = 0; i < n; i++) if (!isBN[i] && types[i] === BidiClass.AL) types[i] = BidiClass.R;

  // ---- W4: single ES between two EN → EN; single CS between two same
  // numbers (EN..EN or AN..AN) → that number type.
  for (let i = 1; i < n - 1; i++) {
    if (isBN[i]) continue;
    const t = types[i];
    if (t !== BidiClass.ES && t !== BidiClass.CS) continue;
    // Find previous + next non-BN.
    let p = i - 1;
    while (p >= 0 && isBN[p]) p--;
    let q = i + 1;
    while (q < n && isBN[q]) q++;
    if (p < 0 || q >= n) continue;
    const pt = types[p],
      qt = types[q];
    if (t === BidiClass.ES && pt === BidiClass.EN && qt === BidiClass.EN) types[i] = BidiClass.EN;
    else if (t === BidiClass.CS) {
      if (pt === BidiClass.EN && qt === BidiClass.EN) types[i] = BidiClass.EN;
      else if (pt === BidiClass.AN && qt === BidiClass.AN) types[i] = BidiClass.AN;
    }
  }

  // ---- W5: sequence of ET adjacent to EN → EN.
  for (let i = 0; i < n; i++) {
    if (isBN[i] || types[i] !== BidiClass.ET) continue;
    // Find run of ETs.
    let j = i;
    while (j < n && (isBN[j] || types[j] === BidiClass.ET)) j++;
    // Char before i (skip BN), char at j.
    let p = i - 1;
    while (p >= 0 && isBN[p]) p--;
    let q = j;
    while (q < n && isBN[q]) q++;
    const before = p >= 0 ? types[p] : BidiClass.ON;
    const after = q < n ? types[q] : BidiClass.ON;
    if (before === BidiClass.EN || after === BidiClass.EN) {
      for (let k = i; k < j; k++) if (!isBN[k]) types[k] = BidiClass.EN;
    }
    i = j - 1;
  }

  // ---- W6: remaining ES/ET/CS → ON.
  for (let i = 0; i < n; i++) {
    if (isBN[i]) continue;
    const t = types[i];
    if (t === BidiClass.ES || t === BidiClass.ET || t === BidiClass.CS) types[i] = BidiClass.ON;
  }

  // ---- W7: EN preceded by L (with intervening weak types) and last
  // strong was L → L.
  {
    let lastStrong = sosCls;
    for (let i = 0; i < n; i++) {
      if (isBN[i]) continue;
      const t = types[i];
      if (t === BidiClass.L || t === BidiClass.R) lastStrong = t;
      else if (t === BidiClass.EN && lastStrong === BidiClass.L) types[i] = BidiClass.L;
    }
  }

  //
  {
    const pairs = _findBracketPairs(codepoints, types, isBN);
    for (const { openIdx, closeIdx } of pairs) {
      const e = baseLevel & 1 ? BidiClass.R : BidiClass.L;
      const opp = e === BidiClass.L ? BidiClass.R : BidiClass.L;
      // Scan strong types strictly between openIdx and closeIdx.
      let sawE = false,
        sawOpp = false;
      for (let k = openIdx + 1; k < closeIdx; k++) {
        if (isBN[k]) continue;
        const sl = _strongLikeOf(types[k]);
        if (sl === e) sawE = true;
        else if (sl === opp) sawOpp = true;
      }
      let pairDir = null;
      if (sawE) pairDir = e;
      else if (sawOpp) {
        // Establish-context: scan BACKWARD before openIdx for nearest strong.
        let ctx = sosCls;
        for (let k = openIdx - 1; k >= 0; k--) {
          if (isBN[k]) continue;
          const sl = _strongLikeOf(types[k]);
          if (sl === BidiClass.L || sl === BidiClass.R) {
            ctx = sl;
            break;
          }
        }
        pairDir = ctx === opp ? opp : e;
      }
      if (pairDir !== null) {
        types[openIdx] = pairDir;
        types[closeIdx] = pairDir;
        // NSMs immediately following EITHER retyped bracket adopt its
        // type (UAX #9 rule N0 step 4 applies to both paired brackets).
        for (let k = openIdx + 1; k < n; k++) {
          if (isBN[k]) continue;
          if (!wasNSM[k]) break;
          types[k] = pairDir;
        }
        for (let k = closeIdx + 1; k < n; k++) {
          if (isBN[k]) continue;
          if (!wasNSM[k]) break;
          types[k] = pairDir;
        }
      }
    }
  }

  const embedStrong = baseLevel & 1 ? BidiClass.R : BidiClass.L;
  {
    let i = 0;
    while (i < n) {
      if (isBN[i] || !_isNeutralForResolve(types[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && (isBN[j] || _isNeutralForResolve(types[j]))) j++;
      // Neighbor on left.
      let p = i - 1;
      while (p >= 0 && isBN[p]) p--;
      let q = j;
      while (q < n && isBN[q]) q++;
      const leftDir = p >= 0 ? _strongLikeOf(types[p]) : sosCls;
      const rightDir = q < n ? _strongLikeOf(types[q]) : eosCls;
      const fill =
        leftDir === rightDir && (leftDir === BidiClass.L || leftDir === BidiClass.R)
          ? leftDir
          : embedStrong;
      for (let k = i; k < j; k++) if (!isBN[k]) types[k] = fill;
      i = j;
    }
  }

  // ---- I1 + I2: implicit levels.
  for (let i = 0; i < n; i++) {
    const t = types[i];
    let lvl = baseLevel;
    if ((baseLevel & 1) === 0) {
      // Even (LTR base): R → +1; EN/AN → +2.
      if (t === BidiClass.R) lvl = baseLevel + 1;
      else if (t === BidiClass.EN || t === BidiClass.AN) lvl = baseLevel + 2;
    } else {
      // Odd (RTL base): L → +1; EN/AN → +1.
      if (t === BidiClass.L) lvl = baseLevel + 1;
      else if (t === BidiClass.EN || t === BidiClass.AN) lvl = baseLevel + 1;
    }
    levels[i] = lvl;
  }

  // BN inherits its predecessor's level (or baseLevel for leading BNs).
  let lastLvl = baseLevel;
  for (let i = 0; i < n; i++) {
    if (isBN[i]) levels[i] = lastLvl;
    else lastLvl = levels[i];
  }
  return levels;
}

/// Full UAX #9 explicit-level resolver (rules X1–X8): a directional status
/// stack handles explicit embeddings (LRE/RLE), overrides (LRO/RLO), their
/// terminator (PDF), and isolates (LRI/RLI/FSI/PDI) uniformly. Per position it
/// records the embedding level + directional override; X9-removed characters
/// (the explicit format codes and BN) and the isolate markers take the parent
/// level. The run is then partitioned by embedding level and each segment goes
/// through the W/N/I resolver, with overrides pinned via forcedTypes.
function _resolveLevelsWithIsolates(codepoints, baseDir) {
  const n = codepoints.length;
  const levels = new Uint8Array(n);
  const baseLevel = baseDir === BaseDirection.Rtl ? 1 : 0;
  const MAX_DEPTH = 125;
  const NEUTRAL = -1;

  const embedLevel = new Uint8Array(n);
  const override = new Int8Array(n).fill(NEUTRAL); // -1 none, else BidiClass.L/R
  const removed = new Uint8Array(n); // X9: explicit format codes + BN
  const marker = new Uint8Array(n); // isolate markers (kept, at parent level)

  const stack = [{ level: baseLevel, override: NEUTRAL, isolate: false }];
  let overflowIsolate = 0,
    overflowEmbedding = 0,
    validIsolate = 0;
  const top = () => stack[stack.length - 1];
  const nextOdd = (l) => (l + 1) | 1;
  const nextEven = (l) => (l + 2) & ~1;

  for (let i = 0; i < n; i++) {
    const cls = getBidiClass(codepoints[i]);
    if (
      cls === BidiClass.RLE ||
      cls === BidiClass.LRE ||
      cls === BidiClass.RLO ||
      cls === BidiClass.LRO
    ) {
      embedLevel[i] = top().level;
      removed[i] = 1;
      const odd = cls === BidiClass.RLE || cls === BidiClass.RLO;
      const newLevel = odd ? nextOdd(top().level) : nextEven(top().level);
      const ov =
        cls === BidiClass.RLO ? BidiClass.R : cls === BidiClass.LRO ? BidiClass.L : NEUTRAL;
      if (newLevel <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
        stack.push({ level: newLevel, override: ov, isolate: false });
      } else if (overflowIsolate === 0) {
        overflowEmbedding++;
      }
    } else if (cls === BidiClass.RLI || cls === BidiClass.LRI || cls === BidiClass.FSI) {
      embedLevel[i] = top().level;
      override[i] = top().override;
      marker[i] = 1;
      let dirCls = cls;
      if (cls === BidiClass.FSI) {
        let depth = 0;
        dirCls = BidiClass.LRI; // default LTR
        for (let j = i + 1; j < n; j++) {
          const c2 = getBidiClass(codepoints[j]);
          if (c2 === BidiClass.LRI || c2 === BidiClass.RLI || c2 === BidiClass.FSI) depth++;
          else if (c2 === BidiClass.PDI) {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0) {
            if (c2 === BidiClass.L) break;
            if (c2 === BidiClass.R || c2 === BidiClass.AL) {
              dirCls = BidiClass.RLI;
              break;
            }
          }
        }
      }
      const newLevel = dirCls === BidiClass.RLI ? nextOdd(top().level) : nextEven(top().level);
      if (newLevel <= MAX_DEPTH && overflowIsolate === 0 && overflowEmbedding === 0) {
        validIsolate++;
        stack.push({ level: newLevel, override: NEUTRAL, isolate: true });
      } else {
        overflowIsolate++;
      }
    } else if (cls === BidiClass.PDI) {
      if (overflowIsolate > 0) overflowIsolate--;
      else if (validIsolate > 0) {
        overflowEmbedding = 0;
        while (!top().isolate) stack.pop();
        stack.pop();
        validIsolate--;
      }
      embedLevel[i] = top().level;
      override[i] = top().override;
      marker[i] = 1;
    } else if (cls === BidiClass.PDF) {
      embedLevel[i] = top().level;
      removed[i] = 1;
      if (overflowIsolate > 0) {
        /* nothing */
      } else if (overflowEmbedding > 0) overflowEmbedding--;
      else if (!top().isolate && stack.length >= 2) stack.pop();
    } else if (cls === BidiClass.B) {
      stack.length = 1;
      stack[0] = { level: baseLevel, override: NEUTRAL, isolate: false };
      overflowIsolate = overflowEmbedding = validIsolate = 0;
      embedLevel[i] = baseLevel;
    } else if (cls === BidiClass.BN) {
      embedLevel[i] = top().level;
      removed[i] = 1; // X9
    } else {
      embedLevel[i] = top().level;
      override[i] = top().override; // X6: directional override pins the type
    }
  }

  // X9-removed characters keep their embedding level (output ignores them).
  for (let k = 0; k < n; k++) if (removed[k]) levels[k] = embedLevel[k];
  void marker;

  // X10: form isolating run sequences. First match isolate initiators to PDIs
  // (BD9), then build maximal same-level runs over the non-removed characters,
  // and chain a run that ends with a matched isolate initiator to the run that
  // begins with its PDI. Each sequence is resolved as one unit so the W/N/I
  // rules and bracket pairing see across the isolated content.
  const pairPDI = new Int32Array(n).fill(-1);
  const pdiInit = new Int32Array(n).fill(-1);
  {
    const ist = [];
    for (let k = 0; k < n; k++) {
      const c = getBidiClass(codepoints[k]);
      if (c === BidiClass.LRI || c === BidiClass.RLI || c === BidiClass.FSI) ist.push(k);
      else if (c === BidiClass.PDI && ist.length) {
        const o = ist.pop();
        pairPDI[o] = k;
        pdiInit[k] = o;
      }
    }
  }
  const live = [];
  for (let k = 0; k < n; k++) if (!removed[k]) live.push(k);
  const runs = []; // [aLiveIdx, bLiveIdx)
  for (let a = 0; a < live.length;) {
    let b = a + 1;
    while (b < live.length && embedLevel[live[b]] === embedLevel[live[a]]) b++;
    runs.push([a, b]);
    a = b;
  }
  const runAtPos = new Map();
  runs.forEach(([a], ri) => runAtPos.set(live[a], ri));
  const used = new Uint8Array(runs.length);

  for (let ri = 0; ri < runs.length; ri++) {
    if (used[ri]) continue;
    if (pdiInit[live[runs[ri][0]]] >= 0) continue; // continuation runs joined via chaining
    const seqPos = [];
    let cur = ri,
      lastB = runs[ri][1],
      endedUnmatched = false;
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      const [a, b] = runs[cur];
      for (let t = a; t < b; t++) seqPos.push(live[t]);
      lastB = b;
      const lastPos = live[b - 1];
      const lc = getBidiClass(codepoints[lastPos]);
      if (lc === BidiClass.LRI || lc === BidiClass.RLI || lc === BidiClass.FSI) {
        if (pairPDI[lastPos] >= 0 && runAtPos.has(pairPDI[lastPos]))
          cur = runAtPos.get(pairPDI[lastPos]);
        else {
          endedUnmatched = true;
          cur = -1;
        }
      } else cur = -1;
    }
    const lvl = embedLevel[seqPos[0]];
    const aLive0 = runs[ri][0];
    const prevLevel = aLive0 > 0 ? embedLevel[live[aLive0 - 1]] : baseLevel;
    const nextLevel = endedUnmatched
      ? baseLevel
      : lastB < live.length
        ? embedLevel[live[lastB]]
        : baseLevel;
    const sos = Math.max(lvl, prevLevel) & 1 ? BidiClass.R : BidiClass.L;
    const eos = Math.max(lvl, nextLevel) & 1 ? BidiClass.R : BidiClass.L;
    const segDir = lvl & 1 ? BaseDirection.Rtl : BaseDirection.Ltr;
    const segCps = [],
      forced = [];
    for (const pos of seqPos) {
      segCps.push(codepoints[pos]);
      forced.push(override[pos]);
    }
    const segLevels = _resolveLevelsRaw(segCps, segDir, forced, sos, eos);
    for (let s = 0; s < seqPos.length; s++) levels[seqPos[s]] = segLevels[s] - (lvl & 1) + lvl;
  }
  return levels;
}

function _isNeutralForResolve(cls) {
  return cls === BidiClass.ON || cls === BidiClass.WS || cls === BidiClass.B || cls === BidiClass.S;
}

function _strongLikeOf(cls) {
  // EN / AN count as R for N1 neighbor classification per spec.
  if (cls === BidiClass.L) return BidiClass.L;
  if (cls === BidiClass.R || cls === BidiClass.EN || cls === BidiClass.AN) return BidiClass.R;
  return cls; // L/R strong; ON/etc. unchanged
}

// BidiBrackets.txt, generated rather than kept by hand (the pairs around U+298D..U+2990 and U+2E62/U+2E63 are easy to get wrong).
const BIDI_BRACKETS = (() => {
  const closeToOpen = new Map();
  const openSet = new Set();
  const closeSet = new Set();
  const { bracketKeys, bracketPair, bracketType } = bidiMaps;
  for (let i = 0; i < bracketKeys.length; i++) {
    if (bracketType[i] === 0) openSet.add(bracketKeys[i]);
    else {
      closeSet.add(bracketKeys[i]);
      closeToOpen.set(bracketKeys[i], bracketPair[i]);
    }
  }
  return { closeToOpen, openSet, closeSet };
})();

/// Match brackets per UAX #9 BD16. Returns an array of
/// { openIdx, closeIdx } pairs sorted by openIdx ascending.
/// Implementation: stack of (codepoint, index) for unclosed openers
/// over a sliding window. When a closer matches, the topmost open
/// of its kind closes it; pop intervening unmatched openers.
// Canonical-equivalence for the two brackets that have singleton decompositions
// (BD16 matches by canonical equivalence): ⟨ U+2329 ≡ 〈 U+3008, ⟩ U+232A ≡ 〉 U+3009.
function _canonBracket(cp) {
  return cp === 0x2329 ? 0x3008 : cp === 0x232a ? 0x3009 : cp;
}

function _findBracketPairs(codepoints, types, isBN) {
  const pairs = [];
  const stack = []; // each entry: { open: canonical codepoint, idx: int }
  const n = codepoints.length;
  for (let i = 0; i < n; i++) {
    if (isBN[i]) continue;
    // Per spec, brackets must have ON class to participate. After W6
    // some neutrals become ON; brackets enter as ON natively.
    if (types[i] !== BidiClass.ON) continue;
    const cp = codepoints[i];
    if (BIDI_BRACKETS.openSet.has(cp)) {
      // BD16: stack holds 63 elements; on overflow stop processing entirely.
      if (stack.length === 63) break;
      stack.push({ open: _canonBracket(cp), idx: i });
    } else if (BIDI_BRACKETS.closeSet.has(cp)) {
      const wantOpen = _canonBracket(BIDI_BRACKETS.closeToOpen.get(cp));
      // Walk stack from top finding matching opener.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].open === wantOpen) {
          pairs.push({ openIdx: stack[s].idx, closeIdx: i });
          // Pop everything from s onward (unmatched intervening
          // openers are discarded per spec).
          stack.length = s;
          break;
        }
      }
    }
  }
  // Sort by openIdx ascending.
  pairs.sort((a, b) => a.openIdx - b.openIdx);
  return pairs;
}

/// Build visual-order index map from logical → visual.
/// Reverses contiguous runs at each level from the highest level down
/// to (and including) the lowest odd level. Returns Uint32Array(n)
/// where `visual[v] = logicalIndex`.
export function reorderLine(levels) {
  const n = levels.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (n === 0) return order;
  let highest = 0,
    lowestOdd = 0xff;
  for (let i = 0; i < n; i++) {
    if (levels[i] > highest) highest = levels[i];
    if (levels[i] & 1 && levels[i] < lowestOdd) lowestOdd = levels[i];
  }
  if (lowestOdd === 0xff) return order; // all even — no reversal
  for (let lvl = highest; lvl >= lowestOdd; lvl--) {
    let i = 0;
    while (i < n) {
      if (levels[i] < lvl) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && levels[j] >= lvl) j++;
      // Reverse [i, j) in `order`.
      for (let lo = i, hi = j - 1; lo < hi; lo++, hi--) {
        const tmp = order[lo];
        order[lo] = order[hi];
        order[hi] = tmp;
      }
      i = j;
    }
  }
  return order;
}
