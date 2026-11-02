// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterGraph/ — generic node-DAG evaluator + dispatch tables for the
// SVG <filter> pipeline and the COLRv1 paint tree. Two dispatchers
// (svg + colr) share one evaluator (filterGraph.js) and one bbox
// propagator (bbox.js).
//
// Subpath: `@kontek/mantle/filterGraph`. Pulls in WebGL
// bindings — the per-node handlers create / sample RTs.

export * from './filterGraph.js';
export { computeNodeBboxes } from './bbox.js';
// The filter/COLR handler tables come from the opt-in registry:
//   import { svgFilterDispatch, colrPaintDispatch } from
//     '@kontek/mantle/filterGraph/dispatchRegistry';
// (populated by importing the primitive modules — see primitives/all +
// colr/paints, or the codegen'd feature entry). The renderer reads the
// registry directly and the root barrel registers the full set.
export { svgFilterDispatch, colrPaintDispatch } from './dispatchRegistry.js';
