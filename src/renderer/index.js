// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

//
// Subpath: `@kontek/mantle/renderer`. Importing this pulls
// in WebGL bindings — for pure data inspection without GL, use the
// `@kontek/mantle/bundle` subpath instead.
//
// The CPatch engine and renderer.exportFrameSVG() are not part of this entry: each is a feature module
// (`@kontek/mantle/renderer/features/cpatch`, `.../frameExport`, or `.../all`) that registers itself when
// imported. Using one without it throws, naming the import. The root entry imports them all.

export { createBundle, parseMetaBin, Constants } from './bundle.js';
export { createRenderer } from './renderer.js';
export { configureWorkers, terminateWorkers } from './workerConfig.js';
// In-place fixed-topology geometry streaming: rebuild only an existing
// bundle's geometry planes via texSubImage2D, skipping the SVG parse /
// style / gradient work.
export { updateBundleGeometry, buildStreamableSections } from './streamGeometry.js';
// parseCoverQuadChunks is cover-quad WIRE FORMAT — internal, so it is not exported here; the
// modules that need it import ./coverQuadChunks.js.
export { buildNineSliceMesh } from './nineSlice.js';
// Static-scene cache: pure-JS state machine + per-renderer
// enableStaticCache() hookup. Strategy/Level/Reason re-exported for
// consumers driving the cache from code.
export {
  createStaticCache,
  Strategy as CacheStrategy,
  Level as CacheLevel,
  Reason as CacheReason,
} from './staticCache.js';
