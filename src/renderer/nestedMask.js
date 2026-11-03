// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nestedMask.js — does a bundle contain a mask whose own children carry a mask of their own?
//
// The unified fill stream paints a masked shape's cover quad or mesh and samples ONE baked mask texture in its fragment stage.
// The cover pass bakes a mask region with a ping-pong pass per nesting level (renderer.js computeMaskRegions hasInnerMask); the
// unified stream has no such pass, so a mask child that is itself masked (or clipped) is not applied.
// The test is structural, read from the meta plane, and has no size or scale term:
//   a LAYER row (flag 0x100) between a MASK_BEGIN row (0x200) and its MASK_END row (0x400) belongs to the mask region whose
//   id is the BEGIN row's 1-based index. The importer stamps every such row's maskId (float 31) with that id, so a row carrying
//   another id references an inner mask. Masks reached through <use>, <g>, or a chain of any depth all reduce to a layer row of some
//   mask region carrying a reference of its own.
// A single-level mask, however many children it has, never trips it. A clip-path inside a mask child (or a mask and a clip on one
// element, or a clip inside a clip) draws identically on the unified route and the cover pass (checked against the Chrome 8x reference), so
// a clip reference does not count.
const FLAGS = 27,
  MASK = 31,
  LAYER = 0x100,
  MASK_BEGIN = 0x200,
  MASK_END = 0x400;
const cache = new WeakMap();

/// `{ nested }` for a bundle (cached on its meta plane, which is immutable after import).
export function nestedMaskInfo(bundle) {
  const m = bundle && bundle.metaFloats;
  if (!m || !bundle.numShapes) return NONE;
  let hit = cache.get(m);
  if (hit) return hit;
  const stride = bundle.metaFloatsPerShape | 0,
    n = bundle.numShapes | 0;
  let nested = false,
    own = 0;
  if (stride > MASK) {
    for (let row = 0; row < n; row++) {
      const o = row * stride,
        flags = Math.round(m[o + FLAGS]);
      if (!(flags & LAYER)) {
        own = 0;
        continue;
      }
      if (flags & MASK_BEGIN) own = row + 1;
      if (own > 0) {
        const mask = Math.round(m[o + MASK]);
        if (mask > 0 && mask !== own) nested = true;
      }
      if (flags & MASK_END) own = 0;
    }
  }
  hit = nested ? YES : NONE;
  cache.set(m, hit);
  return hit;
}
const NONE = Object.freeze({ nested: false }),
  YES = Object.freeze({ nested: true });

export const bundleHasNestedMask = (bundle) => nestedMaskInfo(bundle).nested;
