// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { ccc as cccTrie } from './tables/ccc.js';
import { nfcData } from './tables/nfcData.js';

const SBASE = 0xac00,
  LBASE = 0x1100,
  VBASE = 0x1161,
  TBASE = 0x11a7;
const LCOUNT = 19,
  VCOUNT = 21,
  TCOUNT = 28,
  NCOUNT = VCOUNT * TCOUNT,
  SCOUNT = LCOUNT * NCOUNT;

const ccc = (cp) => cccTrie.get(cp);

// The blob stores decomposition as first code point + a dictionary-coded second
// code point; rebuild the flat [first, second] pairs used by decomposeInto.
const { decompKeys, decompFirst, decompSecondDict, decompSecondIdx, compExcl } = nfcData;
const decompVals = new Uint32Array(decompKeys.length * 2);
for (let i = 0; i < decompKeys.length; i++) {
  decompVals[i * 2] = decompFirst[i];
  decompVals[i * 2 + 1] = decompSecondDict[decompSecondIdx[i]];
}

// Composition is the inverse of a 2-code-point decomposition whose first element
// is a starter, minus the stored exclusions. Rebuild the sorted (starter,
// combining) -> composed arrays that getComposite binary-searches.
const [compStarter, compCombining, compComposed] = (() => {
  const excl = new Set(compExcl);
  const pairs = [];
  for (let i = 0; i < decompKeys.length; i++) {
    const second = decompVals[i * 2 + 1];
    if (second === 0) continue; // singleton
    const first = decompVals[i * 2];
    if (ccc(first) !== 0) continue;
    if (excl.has(decompKeys[i])) continue;
    pairs.push([first, second, decompKeys[i]]);
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return [
    Uint32Array.from(pairs, (p) => p[0]),
    Uint32Array.from(pairs, (p) => p[1]),
    Uint32Array.from(pairs, (p) => p[2]),
  ];
})();

function decompIndex(cp) {
  let lo = 0,
    hi = decompKeys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = decompKeys[mid];
    if (cp < k) hi = mid - 1;
    else if (cp > k) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Primary composite of (a, b) or -1. Handles Hangul algorithmically.
function getComposite(a, b) {
  // Hangul L + V
  if (a >= LBASE && a < LBASE + LCOUNT && b >= VBASE && b < VBASE + VCOUNT) {
    return SBASE + ((a - LBASE) * VCOUNT + (b - VBASE)) * TCOUNT;
  }
  // Hangul LV + T
  if (
    a >= SBASE &&
    a < SBASE + SCOUNT &&
    (a - SBASE) % TCOUNT === 0 &&
    b > TBASE &&
    b < TBASE + TCOUNT
  ) {
    return a + (b - TBASE);
  }
  // Table: binary search by (starter, combining)
  let lo = 0,
    hi = compStarter.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sa = compStarter[mid];
    if (a < sa) hi = mid - 1;
    else if (a > sa) lo = mid + 1;
    else {
      const cb = compCombining[mid];
      if (b < cb) hi = mid - 1;
      else if (b > cb) lo = mid + 1;
      else return compComposed[mid];
    }
  }
  return -1;
}

function decomposeInto(cp, out) {
  if (cp >= SBASE && cp < SBASE + SCOUNT) {
    const s = cp - SBASE;
    out.push(LBASE + ((s / NCOUNT) | 0));
    out.push(VBASE + (((s % NCOUNT) / TCOUNT) | 0));
    const t = s % TCOUNT;
    if (t !== 0) out.push(TBASE + t);
    return;
  }
  const i = decompIndex(cp);
  if (i < 0) {
    out.push(cp);
    return;
  }
  decomposeInto(decompVals[i * 2], out);
  const b = decompVals[i * 2 + 1];
  if (b !== 0) decomposeInto(b, out);
}

// Canonical ordering: stable insertion sort of combining marks by CCC.
function canonicalOrder(arr) {
  for (let i = 1; i < arr.length; i++) {
    const c = ccc(arr[i]);
    if (c === 0) continue;
    const cp = arr[i];
    let j = i;
    while (j > 0 && ccc(arr[j - 1]) > c) {
      arr[j] = arr[j - 1];
      j--;
    }
    arr[j] = cp;
  }
}

function compose(arr) {
  if (arr.length === 0) return arr;
  const out = [arr[0]];
  let lastStarter = ccc(arr[0]) === 0 ? 0 : -1;
  let prevCC = ccc(arr[0]) === 0 ? 0 : ccc(arr[0]);
  for (let i = 1; i < arr.length; i++) {
    const cp = arr[i];
    const cc = ccc(cp);
    let composed = -1;
    if (lastStarter >= 0 && (prevCC < cc || prevCC === 0)) {
      composed = getComposite(out[lastStarter], cp);
    }
    if (composed >= 0) {
      out[lastStarter] = composed;
    } else {
      out.push(cp);
      prevCC = cc;
      if (cc === 0) lastStarter = out.length - 1;
    }
  }
  return out;
}

/** Normalize an array of code points to NFC. */
export function toNFCCodepoints(cps) {
  const d = [];
  for (let i = 0; i < cps.length; i++) decomposeInto(cps[i], d);
  canonicalOrder(d);
  return compose(d);
}

/** Normalize a string to NFC. */
export function toNFC(str) {
  const cps = [];
  for (const ch of str) cps.push(ch.codePointAt(0));
  const out = toNFCCodepoints(cps);
  let s = '';
  for (let i = 0; i < out.length; i++) s += String.fromCodePoint(out[i]);
  return s;
}
