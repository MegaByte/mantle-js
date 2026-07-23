// bundle/featureSet.js — bundle introspection for distribution
// stripping.
//
// Walks a bundle (the object returned by importSvg + createBundle, or
// the sections-dict form pre-GL-upload) and surfaces a flat bitfield
// describing which renderer subsystems the asset actually exercises.
// Consumers union the bitfields of every asset they intend to ship,
// then strip the corresponding modules / shader fragments from their
// distribution build.
//
// Scope: bundle-visible features only. Font-level features (variable
// axes, GPOS cursive, specific OT tables) are out of scope; those
// belong to the FontAsset and should be inspected separately.

import {
  META_FLOATS_PER_SHAPE, META_HEADER_BYTES,
  META_STROKE_A, META_STROKE_W, META_DASH_ID,
  META_FLAGS_SHAPE, META_FILL_GRAD, META_STROKE_GRAD,
  META_CLIP_ID, META_MASK_ID, META_FILTER_ID,
  META_BLEND_MODE, META_IMAGE_ID, META_STROKE_IMAGE_ID,
  META_ATLAS_IS_PATTERN, META_COLR_GRAPH,
  FS_NON_SCALING_STROKE, FS_GROUP_BEGIN, FS_GROUP_END,
  FS_LAYER, FS_NON_SCALING_SIZE, FS_NON_ROTATION, FS_FIXED_POSITION,
  GRAD_FLOATS_PER_GRADIENT, GRAD_TYPE,
  GRAD_TYPE_LINEAR, GRAD_TYPE_RADIAL, GRAD_TYPE_SWEEP,
  FILT_FLOATS_PER_FILTER, FILT_KIND,
  FILT_KIND_COLOR_MATRIX, FILT_KIND_BLUR, FILT_KIND_MORPHOLOGY,
  FILT_KIND_CONVOLVE,
} from './layout.js';

// Flag set. Bit positions are part of the bundle wire contract;
// reorder only by adding new bits at the end. Storage: BigInt
// (so we can extend past 32 bits without changing callers).
export const Features = Object.freeze({
  None:                  0n,

  // --- Geometry / paint ---
  Gradients:             1n <<  0n,
  GradientLinear:        1n <<  1n,
  GradientRadial:        1n <<  2n,
  GradientSweep:         1n <<  3n,  // COLRv1 only (SVG has no sweep)
  Strokes:               1n <<  4n,
  StrokeDash:            1n <<  5n,
  NonScalingStroke:      1n <<  6n,
  NonScalingSize:        1n <<  7n,
  NonRotation:           1n <<  8n,
  FixedPosition:         1n <<  9n,

  // --- Compositing ---
  Clips:                 1n << 10n,
  Masks:                 1n << 11n,
  GroupComposite:        1n << 12n,
  BlendNonNormal:        1n << 13n,

  // --- Filters ---
  Filters:               1n << 14n,
  FilterGraph:           1n << 15n,
  FilterBlur:            1n << 16n,
  FilterColorMatrix:     1n << 17n,
  FilterDropShadow:      1n << 18n,
  FilterGlow:            1n << 19n,
  FilterBevel:           1n << 20n,
  FilterMorphology:      1n << 21n,
  FilterConvolve:        1n << 22n,

  // --- Patterns / images ---
  Images:                1n << 23n,
  VectorPattern:         1n << 24n,

  // --- COLR / text ---
  ColrPaintGraph:        1n << 25n,
});

/// Inspect a bundle (the object returned by importSvg) and return the
/// feature flags it exercises. Safe to call on partial bundles —
/// missing sections contribute no flags.
export function inspect(bundle) {
  let f = 0n;
  if (!bundle) return f;

  const numShapes = bundle.numShapes | 0;
  // === Per-shape meta walk ===
  // Accept both bundle shapes: createBundle/textRun output (metaFloats,
  // header-free Float32Array) and the sections-dict form (.meta
  // ArrayBuffer with a 32-byte header). Stride varies by bundle
  // version, so honor metaFloatsPerShape when present (mirrors hitTest).
  let meta = null, stride = META_FLOATS_PER_SHAPE;
  if (bundle.metaFloats instanceof Float32Array) {
    meta = bundle.metaFloats;
    stride = (bundle.metaFloatsPerShape | 0) || META_FLOATS_PER_SHAPE;
  } else if (bundle.meta && bundle.meta.byteLength != null) {
    meta = new Float32Array(bundle.meta, META_HEADER_BYTES);
    stride = (bundle.metaFloatsPerShape | 0) || META_FLOATS_PER_SHAPE;
  }
  if (numShapes > 0 && meta) {
    for (let i = 0; i < numShapes; i++) {
      const o = i * stride;
      const flags = meta[o + META_FLAGS_SHAPE] | 0;
      if ((flags & FS_NON_SCALING_STROKE) !== 0) f |= Features.NonScalingStroke;
      // Bits 9–12 are double-booked: on clip/mask LAYER rows they carry
      // the begin/end bracket bits, not vector-effect flags. Only honor
      // their vector-effect meaning on non-layer rows.
      if ((flags & FS_LAYER) === 0) {
        if ((flags & FS_NON_SCALING_SIZE) !== 0) f |= Features.NonScalingSize;
        if ((flags & FS_NON_ROTATION)     !== 0) f |= Features.NonRotation;
        if ((flags & FS_FIXED_POSITION)   !== 0) f |= Features.FixedPosition;
      }
      if ((flags & (FS_GROUP_BEGIN | FS_GROUP_END)) !== 0)
        f |= Features.GroupComposite;

      if (meta[o + META_STROKE_A] > 0 && meta[o + META_STROKE_W] > 0)
        f |= Features.Strokes;
      if (meta[o + META_DASH_ID]   > 0) f |= Features.StrokeDash;
      if (meta[o + META_FILL_GRAD] > 0 || meta[o + META_STROKE_GRAD] > 0)
        f |= Features.Gradients;
      if (meta[o + META_CLIP_ID]    > 0) f |= Features.Clips;
      if (meta[o + META_MASK_ID]    > 0) f |= Features.Masks;
      if (meta[o + META_FILTER_ID]  > 0) f |= Features.Filters;
      if (meta[o + META_IMAGE_ID] > 0 || meta[o + META_STROKE_IMAGE_ID] > 0)
        f |= Features.Images;
      if (meta[o + META_BLEND_MODE] > 0) f |= Features.BlendNonNormal;
      if (meta[o + META_COLR_GRAPH] > 0) f |= Features.ColrPaintGraph;

      // atlasSlot[3] (isPattern) == 2 is the vector-pattern sentinel.
      // (atlasSlot.w / index 41 carries image pixel-width for rasters,
      // so it must NOT be used here — see layout.js META_ATLAS_IS_PATTERN.)
      if (Math.abs(meta[o + META_ATLAS_IS_PATTERN] - 2) < 0.001)
        f |= Features.VectorPattern;
    }
  }

  // === Gradient table walk — derive per-type sub-flags ===
  // Sections bundles carry `gradients` (ArrayBuffer); uploaded bundles
  // expose `gradientFloats` instead — accept both, or the sub-flags
  // silently vanish on createBundle output.
  const gradSrc = bundle.gradients || bundle.gradientFloats;
  if ((f & Features.Gradients) !== 0n && gradSrc) {
    const grads = gradSrc instanceof Float32Array ? gradSrc : new Float32Array(gradSrc);
    const gradCount = grads.length / GRAD_FLOATS_PER_GRADIENT;
    for (let i = 0; i < gradCount; i++) {
      const type = grads[i * GRAD_FLOATS_PER_GRADIENT + GRAD_TYPE] | 0;
      if      (type === GRAD_TYPE_LINEAR) f |= Features.GradientLinear;
      else if (type === GRAD_TYPE_RADIAL) f |= Features.GradientRadial;
      else if (type === GRAD_TYPE_SWEEP)  f |= Features.GradientSweep;
    }
  }

  // === Filter table walk — derive per-kind sub-flags ===
  if ((f & Features.Filters) !== 0n && bundle.filterTab) {
    const filts = new Float32Array(bundle.filterTab);
    const filtCount = filts.length / FILT_FLOATS_PER_FILTER;
    for (let i = 0; i < filtCount; i++) {
      const kind = filts[i * FILT_FLOATS_PER_FILTER + FILT_KIND] | 0;
      switch (kind) {
        case FILT_KIND_COLOR_MATRIX: f |= Features.FilterColorMatrix; break;
        case FILT_KIND_BLUR:         f |= Features.FilterBlur;        break;
        case FILT_KIND_MORPHOLOGY:   f |= Features.FilterMorphology;  break;
        case FILT_KIND_CONVOLVE:     f |= Features.FilterConvolve;    break;
        // kinds 2/3/4 (drop-shadow/glow/bevel) are fe-graphs, so the
        // FilterDropShadow/Glow/Bevel flags are reserved (bit contract
        // preserved) but not set here.
      }
    }
  }
  // FilterGraph: a non-null `filterGraphs` entry indicates that filter
  // primitive uses the new graph-mode dispatch (vs. matrix-only).
  if (bundle.filterGraphs && bundle.filterGraphs.some(g => g))
    f |= Features.FilterGraph;

  return f;
}

/// Union the feature sets of every supplied bundle.
export function inspectAll(bundles) {
  let f = 0n;
  if (!bundles) return f;
  for (const b of bundles) f |= inspect(b);
  return f;
}

/// Return a sorted list of flag names for human-readable reports.
/// `None` is omitted.
export function toNames(f) {
  const names = [];
  for (const [name, val] of Object.entries(Features)) {
    if (val === 0n) continue;
    if ((f & val) === val) names.push(name);
  }
  return names;
}
