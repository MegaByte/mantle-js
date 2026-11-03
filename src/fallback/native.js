// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// native.js — the NATIVE-only entry (`@kontek/mantle/native`): the native-SVG scene and its binding factories with NO
// WebGL engine dependency. Nothing reachable from here imports the renderer, a shader, a render target, a GL engine
// (Loop-Blinn, CPatch, AAC, Slug, GWN) or a GL worker pool; test/nativeEntrySmoke.mjs holds that line.
//
//   import { importSvg } from '@kontek/mantle/svg';
//   import { createMantleScene } from '@kontek/mantle/native';
//   const scene = await createMantleScene(host, { backend: 'native' });
//   const sections = await importSvg(text, { retainSource: true });
//   scene.setViewport(w, h); scene.beginFrame(); scene.drawBundle(scene.toScene(sections)); scene.endFrame();
//
// Text on the native backend is a feature of its own (it carries the font engine): `import '@kontek/mantle/native/text'`.
// The auto chooser (WebGL when available, native when not) lives in `@kontek/mantle/fallback` and the root entry, which
// load the WebGL backend. This entry never does: `backend: 'webgl'` from here throws, naming the import to use.

export { createNativeScene } from './nativeSvgFallback.js';
export { createNativeOverrideTable } from './nativeOverrideTable.js';
export { createNativeMorph, createNativeTimeline } from './nativeMorph.js';
export { updateNativeBundleGeometry } from './nativeStream.js';
export { curveRangeToPathD, curvesToPathDMap } from './curveToPathD.js';
export { createNativeBackend } from './nativeBackend.js';

import { createNativeBackend } from './nativeBackend.js';

const WEBGL_MISSING =
  "createMantleScene: backend:'webgl' needs the WebGL backend, which the native-only entry '@kontek/mantle/native' " +
  "does not include. Import createMantleScene from '@kontek/mantle/fallback' (or '@kontek/mantle'), or pass backend:'native'.";

/**
 * Which backend this entry would use: always the native one. `backend: 'webgl'` throws.
 * @param {any} [_canvas]
 * @param {{backend?: 'webgl'|'native', forceNative?: boolean}} [opts]
 * @returns {{backend: 'native', gl: null}}
 */
export function chooseBackend(_canvas, opts = {}) {
  if (opts && opts.backend === 'webgl') throw new Error(WEBGL_MISSING);
  return { backend: 'native', gl: null };
}

/**
 * Create the native scene with the shared scene surface (setViewport / beginFrame / drawBundle / endFrame / toScene /
 * createOverrideTable / createMorph / createTimeline / createTextBundle / createPalette). Async only for signature parity
 * with the chooser in `@kontek/mantle/fallback`.
 * @param {Element} host  where the native <svg> goes (a canvas gets an <svg> overlay)
 * @param {{backend?: 'webgl'|'native', forceNative?: boolean, nativeHost?: Element, document?: Document, coordinateSpace?: 'bundle'|'viewport'}} [opts]
 */
export async function createMantleScene(host, opts = {}) {
  chooseBackend(host, opts);
  return createNativeBackend(opts.nativeHost || host, opts);
}
