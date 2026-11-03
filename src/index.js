// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Public API for @kontek/mantle.
//
//   import {
//     // Importer / renderer / scene composition
//     importSvg,              // SVG text → Mantle bundle (or packed bytes)
//     createScene, sceneToBundle, sceneToSvg,  // programmatic scene → bundle
//                                  // (bypasses the SVG-text-as-source path)
//     rectContour, ellipseContour, polygonContour, linearSeg,
//                                  // scene-tree contour-builder helpers
//     createBundle,           // bundle dict → GL textures + drawList
//     createRenderer,         // factory: programs, VAOs, render state, dispose
//     createOverrideTable,    // per-shape runtime overrides
//     createTextBundle,       // mutable text bundle
//     createShapeMorph,       // name-based shape morph
//     loadShaders,            // async shader loader (bundled module by default; opt-in URL fetch)
//     HitMode,                // .Bbox/.Coverage/.Outline/.Auto
//     fillHitShape,           // point-in-bundle query
//     fillHits, fillHitId,    // ditto, multi-hit / id variants
//     fillHitHref,            // ditto, the hit shape's <a href>
//     Constants,              // META_STRIDE_V2, FULL_META_W, COVER_QUAD_STRIDE, …
//     // Font subsystem (curated re-export from ./font/index.js)
//     MantleFontAsset,        // class wrapping a .ttf/.otf/.woff2 byte blob
//     decodeIfWoff2,           // transparent woff2 → sfnt decoder
//     ttcFaceCount,            // peek at .ttc collection size
//     buildTextRun,            // simple text + color → bundle dict
//     buildStyled,             // pre-styled span list → bundle dict
//     buildFromMarkup,         // rich-text markup string + font → bundle dict
//     measureText,             // layout-only metrics (no bundle build)
//     measureFromMarkup,
//     buildSvgTextGlyphs,      // per-glyph segs for SVG <text> imports
//     BaseDirection,           // UAX #9 base direction enum
//   } from '@kontek/mantle';
//
// Advanced consumers needing low-level font readers (CFF, GSUB, GPOS,
// IVS, etc.) can reach into the subsystem barrel directly:
//
//   import { /* … */ } from '@kontek/mantle/font';
//
// or the importer subpath:
//
//   import { importSvg } from '@kontek/mantle/svg';
//
// Two ways to drive the renderer:
//
// (1) Legacy single-bundle path (kept for back-compat — bench harnesses,
//     existing single-asset demos):
//
//     renderer.setBundle(bundle);
//     function frame() { renderer.render(); requestAnimationFrame(frame); }
//     frame();
//
// (2) Multi-bundle scene path (preferred for game engines and
//     anything that composes multiple bundles per frame):
//
//     renderer.setViewport(widthPx, heightPx);
//     function frame() {
//       renderer.beginFrame([0, 0, 0, 1]);
//       for (const node of scene) {
//         renderer.drawBundle(node.bundle, {
//           worldMatrix: node.worldMatrix3x3,   // optional
//           overrides:   node.overrideTable,     // createOverrideTable handle
//         });
//       }
//       renderer.endFrame();
//       requestAnimationFrame(frame);
//     }
//
//     // Per scene-graph node owning a bundle:
//     const table = createOverrideTable(gl, bundle);
//     table.set('hat',   { tint: [1, 0, 0, 1] });
//     table.set('shirt', { visibility: 0 });
//
// Hit testing transforms with the same worldMatrix used at draw time:
//
//     const shapeId = fillHitId(bundle, mouseX, mouseY, {
//       worldMatrix: node.worldMatrix3x3,
//     });
//
// Bundler-time consumers can build the `sources` dict from their own
// `.glsl` text-loader imports — see ./shaders/index.js for the
// expected shape.

export { default as importSvg } from './svg/importer.js';
export {
  pathBbox,
  segBbox,
  mkLine,
  mkQuad,
  mkCubic,
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  getCoverQuadMesh,
  COVER_QUAD_STRIDE,
} from './svg/importer.js';
export {
  setDiagnostics,
  clearDiagnosticTraces,
  diagnosticTraces,
  mantleWarn,
  mantleError,
  mantleDebugFlag,
} from './core/diagnostics.js';
export {
  loadShaders, // async: the bundled module by default, or an opt-in URL fetch
  bundleShaders, // sync bundler-time wrapper around `?raw` imports
  preprocess, // pure substitution helper (any consumer)
  SHADER_FILENAMES, // canonical [key, filename] list for bundler imports
  HELPER_FILENAMES, // canonical [marker, filename] list for helpers
  shaderKeysFor, // feature spec → set of shader keys
  shaderFilesFor, // feature spec → [key, generated/*.glsl subpath] (peer of featuresToModules)
} from './shaders/index.js';
export { createBundle, parseMetaBin, Constants } from './renderer/bundle.js';
export { createRenderer } from './renderer/renderer.js';
export { configureWorkers, terminateWorkers } from './renderer/workerConfig.js';
// Nine-slice: bundle.applyNineSlice(opts) rewrites a bundle IN PLACE (one
// nine-slice state per bundle); bundle.nineSliceInstance(opts) returns a
// cheap per-DRAW view carrying its own rewritten mesh + globalBBox while
// sharing the base's GL textures — draw ONE chrome asset at several sizes
// simultaneously. buildNineSliceMesh is the underlying pure rewrite.
export { buildNineSliceMesh } from './renderer/nineSlice.js';
// Select Loop-Blinn through renderer.setFillEngine({ route: 'lb' }).
// In-place fixed-topology geometry streaming (skips the SVG parse for a large
// CPU win). Pair with renderer.markGeometryDirty(). Pass { lightweight:true }
// to take the allocation-light GPU-resident fast path (rebuilds only the
// analytic fill meshes, skips the per-frame CPU re-mesh + re-texture; the main
// draw route renders such a bundle through the GPU fill automatically).
//
export { updateBundleGeometry, buildStreamableSections } from './renderer/streamGeometry.js';

// One-shot convenience (root barrel only — the lean `/svg` and `/renderer`
// subpaths stay decoupled): SVG text → uploaded GL bundle, fusing the two
// most common first calls (importSvg + createBundle). Async because importSvg
// is. Pairs with bundleShaders.fromPackage() for a no-boilerplate path:
//   const renderer = createRenderer(gl, await bundleShaders.fromPackage());
//   renderer.render(await importToBundle(gl, svgText));
import _importSvgForBundle from './svg/importer.js';
import { createBundle as _createBundleForImport } from './renderer/bundle.js';
/**
 * @param {any} gl  a WebGL2 context
 * @param {string} svgText
 * @param {Record<string, any>} [opts]  importSvg options
 */
export async function importToBundle(gl, svgText, opts) {
  return _createBundleForImport(gl, await _importSvgForBundle(svgText, opts));
}

import './filterGraph/primitives/all.js';
import './renderer/features/all.js';
import './filterGraph/colr/paints.js';
// Static-scene cache. Strategy/Level/Reason
// constants are needed by consumers driving the cache from code
// (e.g. enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset })).
// The createStaticCache factory is exposed for advanced consumers
// that want to drive the state machine independently of a renderer.
export {
  createStaticCache,
  Strategy as CacheStrategy,
  Level as CacheLevel,
  Reason as CacheReason,
} from './renderer/staticCache.js';
export { createOverrideTable } from './animation/overrides.js';
// Color-matrix recolor builders (dual-tint fill recolor).
// Helpers that build the per-draw colorMatrix + colorMatrixOffset
// pair for the common recolor cases (dual-tint, triple-tint,
// monochrome, identity, compose). Callers can also hand-build the
// matrix; these are convenience wrappers for the named patterns.
export {
  dualTint as colorMatrixDualTint,
  tripleTint as colorMatrixTripleTint,
  monochrome as colorMatrixMonochrome,
  identity as colorMatrixIdentity,
  combine as colorMatrixCombine,
  channelLerpParams, // builds the parameter object for the channelLerp recolor
} from './animation/colorMatrix.js';
// Per-draw palette LUT. Companion to color matrix:
// indexed discrete recolor table, mutable AT WILL between draws.
export { createPalette } from './animation/colorPalette.js';
// Mutable uniform-valued filter parameters. Baked lookup tables, kernel textures
// and graph topology require re-importing; unsupported changes are reported per target.
export { createFilterParams } from './animation/filterParams.js';
export { createTextBundle } from './textBundle.js';
export { createShapeMorph, createSpriteMorph } from './animation/shapeMorph.js';
// Programmatic scene tree → bundle.
export {
  createScene,
  sceneToBundle, // scene → sections dict (feeds createBundle)
  sceneToSections, // scene → sections DIRECTLY (no SVG round-trip; solid-fill fast path)
  sceneToSvg, // scene → SVG string (for chaining / inspection)
  rectContour, // helper: closed rectangle contour
  ellipseContour, // helper: closed ellipse / circle (2 native arcs)
  polygonContour, // helper: closed polygon contour
  polylineContour, // helper: open polyline contour (fill closes it; stroke leaves it open)
  lineSeg, // helper: one native line segment
  quadSeg, // helper: one native quadratic segment
  arcContour, // helper: closed contour from arc segments
  arcSeg, // helper: one elliptical-arc segment
  linearSeg, // helper: degenerate-cubic line segment
} from './scene/scene.js';
export {
  createShapeTimeline, // N-key timeline + linear/hold/cubic-Bezier easing
  createSpriteTimeline, // N-key timeline over SPRITE refs (sheet poses)
  createSpatialBezierMorph, // per-vertex 2D Bezier path (Lottie)
  createPathDeltaMorph, // base pose + N delta channels (Lottie)
  createSkinnedMorph, // bone-weighted skinning of non-mesh paths (Rive)
  createPoseStack, // 3-pose blend stack for state-machine transitions
} from './animation/shapeAnimation.js';
export { HitMode, fillHitShape, fillHits, fillHitId, fillHitHref } from './hitTest/hitTest.js';

// No-WebGL fallback. When `canvas.getContext('webgl2')` returns null
// (GPU blocklist, ancient browser, some headless setups), render the
// ORIGINAL source SVG via the browser's native SVG engine instead. Same
// multi-bundle scene surface (setViewport/beginFrame/drawBundle/endFrame)
// so a consumer's scene loop runs unchanged behind a `gl ? … : …` seam.
// Supports per-shape overrides, animated clips (setClipper), and geometry
// MORPHS (createNativeMorph / createNativeTimeline rewrite each shape's
// path `d` per frame). Requires importing with `{ retainSource: true }`.
// Output is the browser's SVG rasterization — visually equivalent to,
// not bit-identical with, the Mantle WebGL path.
//
// NOTE on bundle size: re-exporting these here is a convenience, but the
// package root ALSO statically exports the WebGL renderer, so a root
// import can't tree-shake the GL pipeline away. For a NATIVE-only build
// (no WebGL renderer shipped), import from the `@kontek/mantle/fallback`
// subpath instead — it reaches none of renderer.js, so the bundle is a
// small fraction of the full package.
export { createNativeScene } from './fallback/nativeSvgFallback.js';
export { createNativeOverrideTable } from './fallback/nativeOverrideTable.js';
export { createNativeMorph, createNativeTimeline } from './fallback/nativeMorph.js';
export { updateNativeBundleGeometry } from './fallback/nativeStream.js';
export { createNativeTextBundle } from './fallback/nativeTextBundle.js';
export { curveRangeToPathD, curvesToPathDMap } from './fallback/curveToPathD.js';
// Auto-selecting factory (owns the gl-vs-native decision in one place).
// ASYNC: it dynamic-import()s only the backend it selects, so neither the
// WebGL pipeline nor the native fallback is loaded until chosen at
// runtime. Force the native fallback via opts.backend: 'native' or
// opts.forceNative. chooseBackend exposes just the decision.
export { createMantleScene, chooseBackend } from './fallback/autoScene.js';

// Font subsystem re-exports. Sourced from `font/index.js` (NOT the lean
// `font/text.js`): the root barrel is the CONVENIENCE entry and eagerly
// registers the full shaper + COLR/emoji + variation + math reader stack
// as an import side effect, so `import { buildStyled } from '@kontek/mantle'`
// shapes complex scripts and renders color fonts out of the box. Bundle-
// size-conscious consumers instead use the lean subpaths (e.g.
// `@kontek/mantle/renderer`, which prunes the font stack entirely) and opt
// into exactly the shapers/readers they need. Advanced consumers needing
// reader internals (CFF, GSUB, GPOS, …) use `@kontek/mantle/font`.
export {
  MantleFontAsset,
  decodeIfWoff2,
  ttcFaceCount,
  buildTextRun,
  buildStyled,
  buildFromMarkup,
  measureText,
  measureFromMarkup,
  buildSvgTextGlyphs,
  BaseDirection,
} from './font/index.js';
