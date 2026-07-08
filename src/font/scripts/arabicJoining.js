import { joiningType as joiningTypeTrie } from "../unicode/tables/joiningType.js";
// arabicJoining.js — Arabic shaping: joining class table + context resolver.
//
// Implements the joining-type lookup defined by ArabicShaping.txt
// (UCD). Hand-curated coverage of the Arabic + Arabic Supplement +
// Arabic Extended-A blocks plus the two format characters (ZWJ/ZWNJ)
// that act as joining causers/breakers.
//
// Form selection for each non-transparent Arabic codepoint depends
// on its joining neighbors:
//   - left-neighbor "joins on the right of this glyph"  → init or medi
//   - right-neighbor "joins on the left of this glyph"  → fina or medi
// resulting in one of {isol, init, medi, fina}.
//
// Transparent codepoints (NSM vowel marks, dagger alef, etc.) are
// skipped when looking at neighbors and inherit the form selection
// of the cluster's base — they don't have their own joining state.
//
// Reference: https://www.unicode.org/reports/tr53/

/** Arabic joining types per ArabicShaping.txt. */
export const ArabicJoiningType = Object.freeze({
  U: 0,  // Non_Joining
  R: 1,  // Right_Joining
  L: 2,  // Left_Joining (rare; e.g. some Manichaean letters)
  D: 3,  // Dual_Joining
  C: 4,  // Join_Causing (ZWJ, Tatweel U+0640)
  T: 5,  // Transparent (combining marks)
});

const U = ArabicJoiningType.U;
const R = ArabicJoiningType.R;
const L = ArabicJoiningType.L;
const D = ArabicJoiningType.D;
const C = ArabicJoiningType.C;
const T = ArabicJoiningType.T;

/** Form codes used to select OpenType feature lookups. */
export const ArabicForm = Object.freeze({
  Isol: 0,
  Init: 1,
  Medi: 2,
  Fina: 3,
});

/** Look up the joining type for `codepoint`. Defaults to U. */
export function getArabicJoiningType(codepoint) {
  // Full Joining_Type coverage (ArabicShaping.txt): Arabic, Syriac, Mongolian,
  // N'Ko, Adlam, Mandaic, Manichaean, etc., plus Transparent marks.
  return joiningTypeTrie.get(codepoint);
}

/// True iff `codepoint` participates in cursive joining (any script). Used to
/// decide whether to apply joining shaping. Covers all joining scripts via the
/// Joining_Type R/L/D/C; ZWNJ/ZWJ are always relevant as joining controls.
export function isArabicCodepoint(codepoint) {
  if (codepoint === 0x200C || codepoint === 0x200D) return true;
  const t = joiningTypeTrie.get(codepoint);
  return t === R || t === L || t === D || t === C;
}

/// Compute the OpenType form (Isol / Init / Medi / Fina) for each
/// codepoint in `cps`. Returns Uint8Array of length cps.length.
///
/// Transparent codepoints (vowel marks) are assigned the same form as
/// the most recent non-transparent cluster base — they don't carry
/// their own joining state but they should still trigger the same
/// feature lookups when present (for marks that have init/medi/fina
/// variants in some fonts).
export function resolveArabicForms(cps) {
  const n = cps.length;
  const out = new Uint8Array(n);
  if (n === 0) return out;

  // Pre-fetch joining types.
  const types = new Uint8Array(n);
  for (let i = 0; i < n; i++) types[i] = getArabicJoiningType(cps[i]);

  // For each non-transparent codepoint, look at prev / next
  // non-transparent neighbor and decide joinsRight / joinsLeft.
  let lastForm = ArabicForm.Isol;
  for (let i = 0; i < n; i++) {
    const ti = types[i];
    if (ti === T) {
      out[i] = lastForm; // inherit cluster's form
      continue;
    }
    if (ti === U) {
      // Non-joining letter or unrelated codepoint: always isolated.
      out[i] = ArabicForm.Isol;
      lastForm = ArabicForm.Isol;
      continue;
    }

    // Find previous non-transparent.
    let p = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (types[k] !== T) { p = k; break; }
    }
    // Find next non-transparent.
    let q = -1;
    for (let k = i + 1; k < n; k++) {
      if (types[k] !== T) { q = k; break; }
    }

    // joinsRight = previous neighbor is Dual or Left or Causing (and
    // current char is capable of joining on its right side = D or R or C).
    // joinsLeft  = next neighbor is Dual or Right or Causing (and
    // current char is capable of joining on its left side = D or L or C).
    const prevT = p >= 0 ? types[p] : U;
    const nextT = q >= 0 ? types[q] : U;

    // Current char's joining capability:
    //   - canJoinPrev (right side connects to previous letter): D, R, C, L?
    //     R/L are paired symmetrically here. Per spec, R chars only
    //     have a right-side connector → they can take fina/isol only.
    //   - canJoinNext (left side connects to next letter): D, L, C.
    //     R chars don't have a left connector.
    const canJoinPrev = (ti === D || ti === R || ti === C);
    const canJoinNext = (ti === D || ti === L || ti === C);

    const prevCausesJoin = (prevT === D || prevT === L || prevT === C);
    const nextCausesJoin = (nextT === D || nextT === R || nextT === C);

    const joinsRight = canJoinPrev && prevCausesJoin;
    const joinsLeft  = canJoinNext && nextCausesJoin;

    let form;
    if (joinsRight && joinsLeft)      form = ArabicForm.Medi;
    else if (joinsRight && !joinsLeft) form = ArabicForm.Fina;
    else if (!joinsRight && joinsLeft) form = ArabicForm.Init;
    else                               form = ArabicForm.Isol;
    out[i] = form;
    lastForm = form;
  }
  return out;
}
