// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Script itemization (UAX #24): split text into runs of a single resolved
// script. Common/Inherited code points adopt the surrounding script (inherit
// from the preceding real script, or the following one at the start of text).
// Drives per-run shaper/font selection.
//
// PARITY: do NOT replace the codegen'd trie with the platform Unicode API
// (`\p{Script=...}`). It reads the engine's bundled ICU version, which can
// diverge from the pinned UCD `tables/script.js` and break render parity.
import { script as scriptTrie, Script } from './tables/script.js';

export const SCRIPT = Script;
export function scriptOf(cp) {
  return scriptTrie.get(cp);
}

const COMMON = Script.Common;
const INHERITED = Script.Inherited;

/**
 * Itemize code points into script runs.
 * @returns array of { start, end, script } over [start, end).
 */
export function itemizeScripts(cps) {
  const n = cps.length;
  const runs = [];
  if (n === 0) return runs;

  // Resolve each code point's script, inheriting through Common/Inherited.
  const res = new Array(n);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const s = scriptTrie.get(cps[i]);
    if (s === COMMON || s === INHERITED) {
      res[i] = prev; // -1 if no real script seen yet
    } else {
      res[i] = s;
      prev = s;
    }
  }
  // Back-fill leading unresolved (-1) runs with the following real script;
  // if the whole string is Common/Inherited, fall back to Common.
  let next = COMMON;
  for (let i = n - 1; i >= 0; i--) {
    if (res[i] === -1) res[i] = next;
    else next = res[i];
  }

  // Group consecutive equal scripts.
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (res[i] !== res[start]) {
      runs.push({ start, end: i, script: res[start] });
      start = i;
    }
  }
  runs.push({ start, end: n, script: res[start] });
  return runs;
}
