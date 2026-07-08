// renderer/ — WebGL2 runtime: GL state machine, per-bundle texture
// owner, per-frame draw loop, plus the helpers the renderer needs to
// walk a bundle (drawList, cover-quad chunks).
//
// Subpath: `@kontek/mantle/renderer`. Importing this pulls
// in WebGL bindings — for pure data inspection without GL, use the
// `@kontek/mantle/bundle` subpath instead.

export { createBundle, parseMetaBin, Constants } from './bundle.js';
export { createRenderer } from './renderer.js';
// In-place fixed-topology geometry streaming: rebuild only an existing
// bundle's geometry planes via texSubImage2D, skipping the SVG parse /
// style / gradient work.
export { updateBundleGeometry, buildStreamableSections } from './streamGeometry.js';
export { parseCoverQuadChunks } from './coverQuadChunks.js';
export { buildNineSliceMesh } from './nineSlice.js';
// Static-scene cache: pure-JS state machine + per-renderer
// enableStaticCache() hookup. Strategy/Level/Reason re-exported for
// consumers driving the cache from code.
export {
  createStaticCache,
  Strategy as CacheStrategy,
  Level    as CacheLevel,
  Reason   as CacheReason,
} from './staticCache.js';
