// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillOmit — which optional fill-shader features a program compiles out, as `MANTLE_NO_<FEAT>` defines.
//
// INTERNAL. The fill variants (fillPass) define the features a bundle does not use -- its baked ones
// (bundle/featureSet.js featuresToFillOmit) and the per-draw recolor ones -- so the renderer derives these on its own.
// The public helpers that handed the same list to an app for createRenderer's `fillDefines` (fillOmitDefines,
// featuresToFillDefines, FILL_FEATURES in `@kontek/mantle/shaders`) are removed: that option is a test hook, honored
// only under __MANTLE_DEBUG__, so a public helper for it had no production use.

/// Optional fill-shader features that can be COMPOSED OUT at compile time. Each is guarded by
/// `#ifndef MANTLE_NO_<FEAT>` in mantle.frag.glsl, and defining that macro drops the code. The fill shader = a fixed
/// CORE (coverage walk + primKind SDF + occupancy + solid/gradient paint + stroke + blend + overrides) plus whichever
/// of these a draw uses. Each section only WRITES color/coverage, so omitting one is byte-identical for a draw that
/// doesn't trigger it. Names line up with bundle/featureSet.js BAKED_FILL_FEATURES.
export const FILL_FEATURES = Object.freeze([
  'recolor', // per-draw channelLerp/palette/colorMatrix (+ uPalette sampler)
  'gradient', // gradient paint, UNWOVEN from fill/stroke/pattern/mask: each
  //   sampleGradient call falls back to its solid branch (the one
  //   runtime takes when no gradient ids exist), and the shared
  //   sampleGradient def + uGradientTex/uGradientStops drop. Define
  //   MANTLE_NO_GRADIENT only when the content has NO gradients.
  'clip', // clipPath coverage
  'mask', // <mask> luminance/alpha (+ uMaskRTArray / uMaskRowToLayerTex)
  'extclip', // setNodeClip screen-space mask (+ uExtClipTex)
  'filter', // per-shape feColorMatrix (+ uFilterTex)
  'stroke', // per-shape stroke band walk (the top-level stroke pass)
  'pattern', // vector <pattern> tiling (the child-walk block)
  'image', // <image> / raster pattern fill (+ uImageTex). Its helpers are
  //   shared by pattern/mask/stroke, so MANTLE_NO_IMAGE is only
  //   emitted when those are ALSO omitted (see omitDefinesFor).
]);

/// Fill features to OMIT → their `MANTLE_NO_<FEAT>` define names, in FILL_FEATURES order.
export function omitDefinesFor(omitFeatures) {
  const set = omitFeatures instanceof Set ? omitFeatures : new Set(omitFeatures || []);
  // `image`'s sampleChildImage / sampleTopLevelImage helpers are CALLED from the
  // pattern, mask, and stroke blocks, so dropping uImageTex (MANTLE_NO_IMAGE) is
  // only safe when those blocks are also dropped — otherwise a kept block would
  // reference the removed helper. Honor an `image` omit only if all three are
  // omitted too; otherwise the (inert, never-hit) top-level image branch stays.
  const safe = new Set(set);
  if (safe.has('image') && !(safe.has('pattern') && safe.has('mask') && safe.has('stroke')))
    safe.delete('image');
  return FILL_FEATURES.filter((f) => safe.has(f)).map((f) => `MANTLE_NO_${f.toUpperCase()}`);
}
