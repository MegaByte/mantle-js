// scene/ — programmatic scene tree → Mantle bundle.
//
// Subpath: `@kontek/mantle/scene`. Pulls in the SVG importer
// indirectly because `sceneToBundle` lowers a scene tree to a synthetic
// SVG string and reuses the importer.

export * from './scene.js';
