// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// missingFeature.js — the one message shape for "this asset needs an optional module that was not imported".
//
// Optional features (filter primitives, COLR paints, script shapers, table readers, renderer engines, ...) are opt-in
// subpaths. When an asset reaches one that is not registered the library degrades (or, for an explicit request, throws), and
// either way the text names the exact import to add. Warned once per feature: a frame loop must not flood the console.

import { mantleWarn } from './diagnostics.js';

const _warned = new Set();

/**
 * @param {string} id        stable key; one warning per id
 * @param {string} what      what was reached and what happens instead, e.g. 'font has an Arabic run: it is shaped without joining forms'
 * @param {string} subpath   the subpath to import, e.g. '@kontek/mantle/font/scripts/arabic'
 * @param {string} [call]    a registration call to make after importing, e.g. 'registerArabicShaping()'
 */
export function warnMissingFeature(id, what, subpath, call) {
  if (_warned.has(id)) return;
  _warned.add(id);
  mantleWarn(`[Mantle] ${what}. Add: ${missingFeatureHint(subpath, call)}`);
}

/** The "import ... and call ..." text, for an error that is thrown instead of warned. */
export function missingFeatureHint(subpath, call) {
  return `import '${subpath}'` + (call ? `; ${call}` : '') + '.';
}

/** Throw the same message as an Error (an explicit request for a feature that is not registered). */
export function requireFeature(what, subpath, call) {
  throw new Error(`[Mantle] ${what}. Add: ${missingFeatureHint(subpath, call)}`);
}

/** Test hook: forget which warnings were shown. */
export function _resetMissingFeatureWarnings() {
  _warned.clear();
}
