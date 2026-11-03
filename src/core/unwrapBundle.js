// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unwrapBundle.js -- the one rule for "a bundle or something that owns one".

/**
 * An animation handle (createShapeMorph, createShapeTimeline, ...) and a text handle own the drawable bundle
 * as `.bundle`; every public entry that takes a bundle accepts either and works on the bundle. A value without
 * a `.bundle` member (a bundle, null, a typed array) is returned unchanged. A sprite view (a sprite timeline's held frame) unwraps to its sheet.
 * @param {any} target
 * @returns {any}
 */
export function unwrapBundle(target) {
  const b =
    target != null && typeof target === 'object' && target.bundle !== undefined
      ? target.bundle
      : target;
  // a sprite timeline's held frame is a VIEW of its sheet (createSpriteTimeline): the APIs that work on a bundle work on the sheet; the draw and hit entry
  // points resolve the view to the sheet and its sprite before they get here
  return b != null && typeof b === 'object' && b._spriteOf ? b._spriteOf.sheet : b;
}
