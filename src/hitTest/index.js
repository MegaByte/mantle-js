// hitTest/ — point-in-shape queries against a Mantle bundle. Pure CPU; no GL
// dependency. The subpath for interaction layers (web pointer events) that
// don't need the renderer at all.
//
// Subpath: `@kontek/mantle/hitTest`.

export { HitMode, fillHitShape, fillHits, fillHitId } from './hitTest.js';
