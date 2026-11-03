// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Full Unicode upper/lower case mapping (locale-independent), including
// multi-character expansions (ß→SS, ﬀ→FF, ...). Deterministic; does not depend
// on the platform's locale tables. Title-casing is per character (callers that
// need word-aware title case segment first).
import { caseData } from './tables/caseData.js';

function findIndex(keys, cp) {
  let lo = 0,
    hi = keys.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const k = keys[m];
    if (cp < k) hi = m - 1;
    else if (cp > k) lo = m + 1;
    else return m;
  }
  return -1;
}

function mapStr(str, keys, off, data) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const idx = findIndex(keys, cp);
    if (idx < 0) {
      out += ch;
    } else {
      for (let i = off[idx]; i < off[idx + 1]; i++) out += String.fromCodePoint(data[i]);
    }
  }
  return out;
}

export function toUpper(str) {
  return mapStr(str, caseData.upperKeys, caseData.upperOff, caseData.upperData);
}
export function toLower(str) {
  return mapStr(str, caseData.lowerKeys, caseData.lowerOff, caseData.lowerData);
}
export function toTitle(str) {
  return mapStr(str, caseData.titleKeys, caseData.titleOff, caseData.titleData);
}
/** Case-fold for caseless matching (full folding, locale-independent). */
export function foldCase(str) {
  return mapStr(str, caseData.foldKeys, caseData.foldOff, caseData.foldData);
}
