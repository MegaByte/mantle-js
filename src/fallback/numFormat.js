// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// numFormat.js: number printing and validation shared by the native scene and the frame export.

/** Clamp to [0, 1]; NaN becomes 0 (an infinite value clamps), so no `rgba(NaN,...)` is written. */
export const unit = (v) => (v === v ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Shortest decimal that parses back to the same float32. A Float32Array holds float32 values,
 * and String() on one prints the float32 widened to a double (1.8285714387893677 for 1.8285714).
 * A value that is not float32-exact, or not finite, prints as String() does.
 */
export function shortF32(v) {
  if (!Number.isFinite(v) || Math.fround(v) !== v) return String(v);
  for (let p = 1; p < 10; p++) {
    const t = v.toPrecision(p);
    if (Math.fround(+t) === v) return String(+t);
  }
  return String(v);
}

/** True when a mat3 has a non-finite entry among the six the SVG transform reads (0, 1, 3, 4, 6, 7). */
export function badMatrix(wm) {
  return (
    !!wm &&
    !(
      Number.isFinite(wm[0]) &&
      Number.isFinite(wm[1]) &&
      Number.isFinite(wm[3]) &&
      Number.isFinite(wm[4]) &&
      Number.isFinite(wm[6]) &&
      Number.isFinite(wm[7])
    )
  );
}

/** True when the first n entries of an array are all finite numbers (a missing array is fine). */
export function allFinite(a, n) {
  if (!a) return true;
  for (let i = 0; i < n && i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}
