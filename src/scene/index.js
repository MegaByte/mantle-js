// scene/ — programmatic scene tree → Mantle bundle.
//
// Subpath: `@kontek/mantle/scene`. Pulls in the SVG importer
// indirectly because `sceneToBundle` lowers a scene tree to a synthetic
// SVG string and reuses the importer.

export * from './scene.js';

export const lineSeg = undefined;
export const quadSeg = undefined;
export const polylineContour = undefined;
