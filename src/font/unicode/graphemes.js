// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Unicode grapheme cluster boundaries (UAX #29), Unicode 18 rule set incl.
// GB9c (Indic conjunct) and GB11 (emoji ZWJ). Table-driven fallback for when the
// platform segmenter (Intl.Segmenter) is unavailable or behind the pinned version.
import { graphemeBreak, Gcb } from './tables/graphemeBreak.js';
import { extPict } from './tables/extPict.js';
import { incb, Incb } from './tables/incb.js';

const gcb = (cp) => graphemeBreak.get(cp);

// xpic-run state (for GB11): NONE | run is ExtPict Extend* | run is ExtPict Extend* ZWJ
const X_NONE = 0,
  X_PICT = 1,
  X_PICT_ZWJ = 2;

/**
 * Return an array of boundary indices [0, ..., n] such that consecutive pairs
 * delimit grapheme clusters. Input is an array of code points.
 */
export function graphemeBoundaries(cps) {
  const n = cps.length;
  const bounds = [0];
  if (n === 0) return bounds;

  let L = cps[0];
  let lc = gcb(L);
  let riCount = lc === Gcb.Regional_Indicator ? 1 : 0;

  let incbLinker = incb.get(L) === Incb.Linker;
  // GB11 left-state
  let xstate = extPict.get(L) ? X_PICT : X_NONE;

  for (let i = 1; i < n; i++) {
    const R = cps[i];
    const rc = gcb(R);
    const ri = incb.get(R);
    const rpict = extPict.get(R) !== 0;

    let brk;
    if (lc === Gcb.CR && rc === Gcb.LF)
      brk = false; // GB3
    else if (lc === Gcb.Control || lc === Gcb.CR || lc === Gcb.LF)
      brk = true; // GB4
    else if (rc === Gcb.Control || rc === Gcb.CR || rc === Gcb.LF)
      brk = true; // GB5
    else if (lc === Gcb.L && (rc === Gcb.L || rc === Gcb.V || rc === Gcb.LV || rc === Gcb.LVT))
      brk = false; // GB6
    else if ((lc === Gcb.LV || lc === Gcb.V) && (rc === Gcb.V || rc === Gcb.T))
      brk = false; // GB7
    else if ((lc === Gcb.LVT || lc === Gcb.T) && rc === Gcb.T)
      brk = false; // GB8
    else if (rc === Gcb.Extend || rc === Gcb.ZWJ)
      brk = false; // GB9
    else if (rc === Gcb.SpacingMark)
      brk = false; // GB9a
    else if (lc === Gcb.Prepend)
      brk = false; // GB9b
    else if (incbLinker && ri === Incb.Consonant)
      brk = false; // GB9c
    else if (xstate === X_PICT_ZWJ && rpict)
      brk = false; // GB11
    else if (lc === Gcb.Regional_Indicator && rc === Gcb.Regional_Indicator && (riCount & 1) === 1)
      brk = false; // GB12/13
    else brk = true; // GB999

    if (brk) bounds.push(i);

    // Advance left-states so that L := R.
    riCount = rc === Gcb.Regional_Indicator ? (lc === Gcb.Regional_Indicator ? riCount + 1 : 1) : 0;

    if (ri === Incb.Linker) incbLinker = true;
    else if (ri !== Incb.Extend) incbLinker = false; // Extend continues the run

    if (rpict) xstate = X_PICT;
    else if (xstate === X_PICT && rc === Gcb.Extend) xstate = X_PICT;
    else if (xstate === X_PICT && rc === Gcb.ZWJ) xstate = X_PICT_ZWJ;
    else xstate = X_NONE;

    L = R;
    lc = rc;
  }
  bounds.push(n);
  return bounds;
}

/** Iterate grapheme clusters of a string, invoking cb(clusterString, startIdx). */
export function eachGrapheme(str, cb) {
  const cps = [];
  const idx = [];
  for (let i = 0; i < str.length;) {
    const cp = str.codePointAt(i);
    cps.push(cp);
    idx.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  const b = graphemeBoundaries(cps);
  for (let k = 0; k < b.length - 1; k++) {
    const s = idx[b[k]];
    const e = b[k + 1] < idx.length ? idx[b[k + 1]] : str.length;
    cb(str.slice(s, e), s);
  }
}
