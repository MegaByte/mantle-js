// @kontek/mantle/fallback — the no-WebGL native-SVG renderer, importable
// WITHOUT pulling the WebGL pipeline.
//
// Import from here (not the package root) when you only need the native
// fallback — e.g. an SSR/thumbnail path, or a build that should never
// ship renderer.js. The package root (`@kontek/mantle`) re-exports these
// too, but it also statically exports the WebGL renderer, so a root
// import can't tree-shake the GL code away on its own. This subpath is
// the clean native-only entry.
//
//   import { createNativeScene, createNativeMorph } from '@kontek/mantle/fallback';
//
// None of these transitively import the WebGL renderer: they reach only
// ../core/* + sibling fallback modules.

export { createNativeScene } from './nativeSvgFallback.js';
export { createNativeOverrideTable } from './nativeOverrideTable.js';
export { createNativeMorph, createNativeTimeline } from './nativeMorph.js';
export { updateNativeBundleGeometry } from './nativeStream.js';
export { createNativeTextBundle } from './nativeTextBundle.js';
export { curveRangeToPathD, curvesToPathDMap } from './curveToPathD.js';
// createMantleScene dynamically import()s whichever backend it picks — so
// it stays native-only until it actually selects WebGL at runtime.
export { createMantleScene, chooseBackend } from './autoScene.js';
