// bundle/featureManifest.js — turn an inspect() feature bitfield into the
// list of side-effect module subpaths a consumer must import so the
// registries (filter primitives, font readers/shapers) contain exactly
// the handlers those features need. This is the consumption half of the
// featureSet system: inspect() describes what an asset uses, this maps
// that to what to import, and scripts/genFeatureEntry.mjs writes the
// import list out as a generated entry module.
//
// Only features that correspond to an opt-in registry seam appear here.
// Features that are always linked (base geometry, strokes, clips, masks —
// handled inside the always-present renderer core) have no entry and
// contribute nothing to the import list. As more subsystems gain the
// registry seam (gradients, markers, images, …) add their bits here.

import { Features } from './featureSet.js';

const PKG = '@kontek/mantle';

// Each entry: a Features bit → array of subpath modules whose import
// registers the handler(s) that bit needs. Subpaths are package-relative
// so the generated entry module works from a consumer's node_modules.
//
// Filter primitives map per-kind. featureSet only surfaces the coarse
// per-kind flags it can derive from the filter table (Blur, ColorMatrix,
// DropShadow, Glow, Bevel, Morphology, Convolve); the rest (offset,
// flood, composite, merge, blend, tile, turbulence, displacement,
// lighting, componentTransfer, image) aren't individually flagged in the
// bundle yet, so a graph-mode filter (Features.FilterGraph) conservatively
// pulls the full primitive set. Single-kind filters pull only their kind.
const FILT = `${PKG}/filterGraph/primitives`;

const MAP = [
  // [bit, modules]
  // COLRv1 paint graph (color fonts / emoji). One module — a paint
  // graph can use any node type, so the granularity is COLR on/off.
  [Features.ColrPaintGraph,    [`${PKG}/filterGraph/colr/paints`]],

  [Features.FilterBlur,        [`${FILT}/blur`]],
  [Features.FilterColorMatrix, [`${FILT}/colorMatrix`]],
  // Drop-shadow / glow / bevel are synthesized from blur + offset +
  // flood + composite/merge in the graph; their single-kind fast paths
  // still exercise those primitives.
  [Features.FilterDropShadow,  [`${FILT}/blur`, `${FILT}/offset`, `${FILT}/flood`, `${FILT}/composite`, `${FILT}/merge`]],
  [Features.FilterGlow,        [`${FILT}/blur`, `${FILT}/flood`, `${FILT}/composite`, `${FILT}/merge`]],
  [Features.FilterBevel,       [`${FILT}/blur`, `${FILT}/offset`, `${FILT}/lighting`, `${FILT}/composite`, `${FILT}/merge`]],
  [Features.FilterMorphology,  [`${FILT}/morphology`]],
  [Features.FilterConvolve,    [`${FILT}/convolve`]],
  // Graph-mode filters can use any primitive — pull the full set.
  [Features.FilterGraph,       [`${FILT}/all`]],
];

/// Map a feature bitfield (from inspect / inspectAll) to the sorted,
/// de-duplicated list of module subpaths to import. Imports are pure
/// side-effect registrations; the consumer imports each for effect only.
export function featuresToModules(flags) {
  const set = new Set();
  for (const [bit, modules] of MAP) {
    if ((flags & bit) === bit && bit !== 0n) {
      for (const m of modules) set.add(m);
    }
  }
  // If the full filter set is included, drop the now-redundant per-kind
  // entries so the generated import list stays minimal and readable.
  const all = `${FILT}/all`;
  if (set.has(all)) {
    for (const m of [...set]) {
      if (m.startsWith(`${FILT}/`) && m !== all) set.delete(m);
    }
  }
  return [...set].sort();
}
