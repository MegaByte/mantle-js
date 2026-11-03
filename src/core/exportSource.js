// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Nested driven poses can retain source markup through their morph inputs.
export function hasRetainedSvgSource(bundle) {
  const seen = new Set();
  while (bundle && !seen.has(bundle)) {
    if (bundle.svgSource) return true;
    seen.add(bundle);
    bundle = bundle.__exportMorph?.srcBundle;
  }
  return false;
}
