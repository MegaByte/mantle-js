// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeBackend.js — the native-SVG backend as a Mantle scene: the native scene plus the same binding factories
// (override table, morph, timeline, text bundle, palette) the WebGL scene exposes, so an app is backend-agnostic.
//
// This module and everything it imports is GL-free: no renderer, no shaders, no render targets. It is shared by the
// `@kontek/mantle/native` entry (native only) and by autoScene.js (which adds the WebGL-or-native chooser).

import { mantleWarn } from '../core/diagnostics.js';
import { createNativeScene } from './nativeSvgFallback.js';
import { createNativeOverrideTable } from './nativeOverrideTable.js';
import * as native from './nativeMorph.js';
import { getNativeTextBundle } from './nativeTextHook.js';
import { requireFeature } from '../core/missingFeature.js';

/**
 * Create the native scene on `host` with the shared scene surface. Synchronous: nothing here loads lazily.
 * @param {Element|HTMLCanvasElement} host  where the native <svg> goes (a canvas gets an <svg> overlay)
 * @param {object} [opts]
 * @param {Document} [opts.document]  defaults to the host's ownerDocument
 * @param {'bundle'|'viewport'} [opts.coordinateSpace]  a multi-bundle pixel-viewport compositor passes 'viewport' so the native
 *   root viewBox is the pixel viewport and worldMatrix is em to pixel (the WebGL path's result); the default 'bundle' keeps
 *   the single-bundle em-space behavior
 */
export function createNativeBackend(host, opts = {}) {
  const nativeScene = createNativeScene(host, {
    document: opts.document,
    coordinateSpace: opts.coordinateSpace,
  });
  return wrapNative(nativeScene, { createNativeOverrideTable, native });
}

// Native: the native scene already exposes the full renderer-parity
// surface (drawSprite/instancing/scissor are REAL fallbacks; static-cache
// is a no-op). Augment it the same way so the two backends are
// interchangeable. toScene returns the sections (which carry svgSource).
function wrapNative(scene, bind) {
  scene.backend = 'native';
  scene.gl = null;
  scene.renderer = null;
  scene.nativeScene = scene;
  // `opts` (e.g. { recolor: true }) is accepted for signature parity with the
  // WebGL path and ignored: recolor on native is applied by the SVG renderer
  // at draw time, so there is no shader variant to fix at creation.
  scene.toScene = (sections, _opts) => {
    if (!sections.svgSource) {
      mantleWarn(
        '[Mantle] native fallback: sections lack svgSource — ' +
          'import with { retainSource: true } so the fallback can render ' +
          'the original markup.',
      );
    }
    return sections;
  };

  // Same binding-factory surface as WebGL — routed to the native (gl-free)
  // implementations. Identical call shape, so the consumer's override /
  // morph / timeline setup is backend-agnostic (no `gl`, no gating).
  scene.createOverrideTable = (bundle) => bind.createNativeOverrideTable(bundle);
  scene.createMorph = (src, dst, mopts = {}) => bind.native.createNativeMorph(src, dst, mopts);
  scene.createTimeline = (refs, keys, topts) => bind.native.createNativeTimeline(refs, keys, topts);
  // Native text: shape glyphs (gl-free) → svgSource bundle; renders the
  // glyph OUTLINES (GL-parity geometry, no browser-font dependency).
  scene.createTextBundle = (textOpts) => {
    const make = getNativeTextBundle();
    if (!make)
      requireFeature(
        'scene.createTextBundle() on the native backend needs the text engine, which is not registered',
        '@kontek/mantle/native/text',
      );
    return make(textOpts);
  };
  // Palette LUT recolor: on native it's applied per-shape (CPU) by the
  // recolor pass in drawBundle — the shape's selected channel indexes the
  // LUT and replaces its fill RGB, mirroring the GL palette path. Returns a
  // token carrying the entries; pass it as drawBundle({ palette, paletteChannel }).
  // entries: [r,g,b,a] in [0,255] (same contract as the GL createPalette).
  scene.createPalette = (entries) => {
    if (!Array.isArray(entries))
      throw new Error('createPalette: entries must be an array of [r,g,b,a]');
    return {
      __nativePalette: true,
      entries,
      size: entries.length,
      // Mutable like the GL handle: rewriting entries invalidates the cache.
      setEntries(next) {
        this.entries = next;
        this.size = next.length;
        this.__entries01 = null;
      },
    };
  };
  return scene;
}
