// Bidi mirroring (UAX #9 rule L4): a character at an odd (RTL) embedding level
// whose Bidi_Mirrored property is Yes is drawn with its mirrored glyph, e.g.
// '(' U+0028 <-> ')' U+0029. The mirror map comes from BidiMirroring.txt.
import { bidiMaps } from "./tables/bidiMaps.js";

const { mirrorKeys, mirrorVals } = bidiMaps;

/** Mirrored code point for `cp`, or `cp` itself if it has no mirror. */
export function mirror(cp) {
  let lo = 0, hi = mirrorKeys.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const k = mirrorKeys[m];
    if (cp < k) hi = m - 1;
    else if (cp > k) lo = m + 1;
    else return mirrorVals[m];
  }
  return cp;
}

/** True iff `cp` has a mirrored form. */
export function hasMirror(cp) {
  let lo = 0, hi = mirrorKeys.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const k = mirrorKeys[m];
    if (cp < k) hi = m - 1;
    else if (cp > k) lo = m + 1;
    else return true;
  }
  return false;
}
