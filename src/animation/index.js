// animation/ — renderer-side animation primitives. Three
// building blocks composed by external drivers (SMIL / SWF / Lottie /
// Rive / state machines):
//
//   createOverrideTable(bundle)            — per-shape runtime overrides
//   createShapeMorph(bundleA, bundleB)     — two-pose curve+gradient lerp
//   createShapeTimeline / Spatial / …      — N-key timeline composers
//
// Subpath: `@kontek/mantle/animation`. Pulls in createBundle
// (needed by shapeMorph), so this subpath has the same WebGL
// footprint as the renderer subpath.

export { createOverrideTable } from './overrides.js';
export { createShapeMorph, createSpriteMorph } from './shapeMorph.js';
export {
  createShapeTimeline,
  createSpriteTimeline,
  createSpatialBezierMorph,
  createPathDeltaMorph,
  createSkinnedMorph,
  createPoseStack,
} from './shapeAnimation.js';

// Color-matrix recolor builders. Both the bare names and the root's
// aliased names are provided.
export {
  dualTint,
  tripleTint,
  monochrome,
  identity,
  combine,
  unityChannelLerp,
  dualTint    as colorMatrixDualTint,
  tripleTint  as colorMatrixTripleTint,
  monochrome  as colorMatrixMonochrome,
  identity    as colorMatrixIdentity,
  combine     as colorMatrixCombine,
} from './colorMatrix.js';
// Per-draw palette LUT — companion to the color matrix.
export { createPalette } from './colorPalette.js';
