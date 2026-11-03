// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// argCheck.js -- the argument rules of the public setters.
//
// A CONFIGURATION scalar (a viewport size, a scale, a threshold) must be a number: NaN and non-numbers THROW, because a
// silent default hides the caller's bug; every other number, +-Infinity included, CLAMPS to the documented range. DATA
// values (colors, points, override fields) are coerced instead of rejected; each entry documents its coercion.

/**
 * @param {string} fn    the public entry, for the message
 * @param {string} name  the argument
 * @param {any} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number} `value` clamped to [lo, hi]
 */
export function clampArg(fn, name, value, lo, hi) {
  if (typeof value !== 'number' || value !== value)
    throw new Error(
      fn +
        ': ' +
        name +
        ' must be a number, got ' +
        (typeof value === 'number' ? 'NaN' : JSON.stringify(value)),
    );
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * A per-draw world matrix: a 9-float column-major mat3 (Array or typed array) of finite numbers. `null`, `undefined` and `false`
 * mean "no matrix" and are not checked here. Constant work (nine reads) per draw.
 * @param {string} fn  the public entry, for the message
 * @param {string} name  the argument ('worldMatrix' or 'instances[3].worldMatrix')
 * @param {any} m
 */
export function checkMat3(fn, name, m) {
  if (m == null || m === false) return;
  if (typeof m !== 'object' || m.length !== 9)
    throw new Error(
      fn +
        ': ' +
        name +
        ' must be a 9-float column-major mat3, got ' +
        (typeof m === 'object' && m.length !== undefined ? 'length ' + m.length : typeof m),
    );
  for (let i = 0; i < 9; i++) {
    const v = m[i];
    if (typeof v !== 'number' || !(v - v === 0))
      throw new Error(fn + ': ' + name + '[' + i + '] must be a finite number, got ' + String(v));
  }
}

/**
 * A clear color: `null`/`undefined` (keep / default) or four finite numbers (Array or typed array), the documented
 * `[r, g, b, a]`. Constant work per frame.
 * @param {string} fn
 * @param {any} c
 */
export function checkClearColor(fn, c) {
  if (c == null) return;
  if (typeof c !== 'object' || c.length !== 4)
    throw new Error(
      fn +
        ': clearColor must be null or [r, g, b, a], got ' +
        (typeof c === 'string'
          ? JSON.stringify(c)
          : typeof c === 'object' && c.length !== undefined
            ? 'length ' + c.length
            : typeof c),
    );
  for (let i = 0; i < 4; i++) {
    const v = c[i];
    if (typeof v !== 'number' || !(v - v === 0))
      throw new Error(fn + ': clearColor[' + i + '] must be a finite number, got ' + String(v));
  }
}
