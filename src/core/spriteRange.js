// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteRange.js -- sprite id and explicit [first, last] range lookups shared by drawSprite and the sprite morphs.

/// An explicit [first, last] shape range as integers, or null when it is not 0 <= first <= last < numShapes.
export function checkedSpriteBounds(range, numShapes) {
  const a = Number(range[0]),
    b = Number(range[1]);
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= b)) return null;
  if (Number.isFinite(numShapes) && b >= numShapes) return null;
  return [a, b];
}

/// A sprite id's [first, last] range from the bundle's own table; ids like "constructor" or "__proto__" are not entries.
export function ownSpriteRange(bundle, sprite) {
  const ranges = bundle && bundle.spriteRanges;
  return ranges && Object.hasOwn(ranges, sprite) ? ranges[sprite] : undefined;
}
