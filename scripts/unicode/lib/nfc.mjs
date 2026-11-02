// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Build canonical-decomposition + canonical-composition data for NFC (UAX #15).
// Hangul is handled algorithmically at runtime (no table). Composition uses the
// authoritative Full_Composition_Exclusion property from DerivedNormalizationProps.
import { parseUnicodeData, ucd } from './ucd.mjs';

export function buildNfcData() {
  const { ccc, decomp } = parseUnicodeData();
  const fce = parseFullCompositionExclusion(ucd('DerivedNormalizationProps.txt'));

  // Canonical decompositions only (drop <compat> mappings). Max length 2.
  const keys = [];
  for (const [cp, d] of decomp) {
    if (d.compat) continue;
    keys.push(cp);
  }
  keys.sort((a, b) => a - b);
  const decompKeys = Uint32Array.from(keys);

  // Split the decomposition into first / second code points. The second is a
  // canonical combining mark (0 = singleton) drawn from a small set (~95
  // distinct), so store a dictionary of the distinct values and one index per
  // entry instead of the value itself.
  const decompFirst = new Uint32Array(keys.length);
  const seconds = new Uint32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const d = decomp.get(keys[i]).cps;
    decompFirst[i] = d[0];
    seconds[i] = d.length > 1 ? d[1] : 0;
  }
  const dict = [...new Set(seconds)].sort((a, b) => a - b);
  const idxOf = new Map(dict.map((v, i) => [v, i]));
  const decompSecondDict = Uint32Array.from(dict);
  const decompSecondIdx = Uint32Array.from(seconds, (s) => idxOf.get(s));

  // Composition is the inverse of a 2-code-point decomposition whose first
  // element is a starter — the runtime rebuilds the (starter, combining) ->
  // composed table from the decomposition. Only the code points to EXCLUDE
  // (Full_Composition_Exclusion among such pairs) need to be stored; singletons
  // and non-starter decompositions are excluded there by structure.
  const compExcl = [];
  for (const cp of keys) {
    const d = decomp.get(cp).cps;
    if (d.length !== 2 || ccc[d[0]] !== 0) continue;
    if (fce.has(cp)) compExcl.push(cp);
  }

  return {
    decompKeys,
    decompFirst,
    decompSecondDict,
    decompSecondIdx,
    compExcl: Uint32Array.from(compExcl),
  };
}

function parseFullCompositionExclusion(text) {
  const set = new Set();
  for (let line of text.split('\n')) {
    const h = line.indexOf('#');
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(';').map((s) => s.trim());
    if (f[1] !== 'Full_Composition_Exclusion') continue;
    const m = f[0].split('..');
    const lo = parseInt(m[0], 16);
    const hi = m.length > 1 ? parseInt(m[1], 16) : lo;
    for (let c = lo; c <= hi; c++) set.add(c);
  }
  return set;
}
