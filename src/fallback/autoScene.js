// autoScene.js — factory that owns the WebGL-vs-native-SVG decision, so a
// consumer doesn't hand-write the `gl ? createRenderer : createNativeScene`
// seam.
//
//   import { createMantleScene } from '@kontek/mantle';
//   const scene = await createMantleScene(canvas, { shaders });
//   // scene is EITHER a WebGL renderer OR a native-SVG scene — both
//   // expose setViewport/beginFrame/drawBundle/endFrame. scene.backend
//   // is 'webgl' | 'native'. scene.toScene(sections) returns the right
//   // drawable (a GL bundle, or the sections themselves for native).
//
// CODE SPLITTING: createMantleScene is ASYNC and loads each backend via
// dynamic import(), so a native-path bundle never ships the WebGL renderer
// (renderer.js + filterGraph + shaders) and a pure-WebGL app never ships
// the native fallback — only the selected backend's code is fetched. (Use
// createRenderer / createNativeScene directly — both synchronous — when you
// already know the backend and don't need the split.)
//
// Backend selection — native path is chosen when ANY of these is set
// (checked in order):
//   1. opts.backend === 'native'  (explicit — strongest)
//   2. opts.forceNative === true
//   3. the 'forceNative' debug flag (e.g. globalThis.__MANTLE_FORCE_NATIVE)
//   4. a `mantleNative` / `mantleForceNative` URL query param (?mantleNative=1)
//   5. WebGL2 is unavailable (getContext returns null)
// opts.backend === 'webgl' forces WebGL, skipping auto-fallback.

function urlForcesNative() {
  try {
    if (typeof location === 'undefined' || !location.search) return false;
    const q = new URLSearchParams(location.search);
    const v = (k) => { const x = q.get(k); return x != null && x !== '0' && x !== 'false'; };
    return v('mantleNative') || v('mantleForceNative');
  } catch { return false; }
}

import { mantleWarn, mantleDebugFlag } from '../core/diagnostics.js';

/**
 * Decide which backend to use. Exposed so callers can branch their own
 * setup (e.g. only fetch shaders when WebGL wins).
 *
 * @param {HTMLCanvasElement} [canvas]
 * @param {object} [opts]
 * @param {'webgl'|'native'} [opts.backend]  hard override
 * @param {boolean} [opts.forceNative]
 * @param {object}  [opts.glAttribs]  getContext('webgl2', …) attributes
 * @returns {{backend:'webgl'|'native', gl:WebGL2RenderingContext|null}}
 */
export function chooseBackend(canvas, opts = {}) {
  if (opts.backend === 'native') return { backend: 'native', gl: null };
  if (opts.backend === 'webgl') {
    const gl = getGL(canvas, opts);
    if (!gl) throw new Error("createMantleScene: backend:'webgl' forced but WebGL2 is unavailable");
    return { backend: 'webgl', gl };
  }
  const forced = opts.forceNative === true
    || mantleDebugFlag('forceNative')
    || urlForcesNative();
  if (forced) return { backend: 'native', gl: null };
  const gl = getGL(canvas, opts);
  return gl ? { backend: 'webgl', gl } : { backend: 'native', gl: null };
}

function getGL(canvas, opts) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  try {
    return canvas.getContext('webgl2', opts.glAttribs || {
      antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true,
    });
  } catch { return null; }
}

/**
 * Create a Mantle scene that auto-selects the backend. The returned
 * object exposes the shared scene surface (setViewport / beginFrame /
 * drawBundle / endFrame), plus:
 *   .backend            'webgl' | 'native'
 *   .gl                 the GL context, or null on native
 *   .renderer           the underlying WebGL renderer, or null
 *   .nativeScene        the underlying native scene, or null
 *   .toScene(sections)  → the right drawable for drawBundle:
 *                          a GL bundle (webgl) or `sections` (native)
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts]
 * @param {object} [opts.shaders]      shader sources (required for webgl)
 * @param {Element} [opts.nativeHost]  host for the native <svg>
 *                                     (defaults to the canvas, which
 *                                     creates an <svg> overlay)
 * @param {'webgl'|'native'} [opts.backend]
 * @param {boolean} [opts.forceNative]
 * @param {object}  [opts.rendererOpts] passed to createRenderer
 * @param {object}  [opts.glAttribs]
 */
export async function createMantleScene(canvas, opts = {}) {
  const { backend, gl } = chooseBackend(canvas, opts);

  if (backend === 'webgl') {
    // Lazy-load the GL pipeline ONLY on the WebGL path so a native-only
    // bundle never ships renderer.js / bundle.js (+ filterGraph, shaders).
    // The binding factories (overrides / morph / timeline / palette) ride
    // along here too, so the scene can expose them without the consumer
    // threading `gl` or gating by backend.
    const [{ createRenderer }, { createBundle }, ovr, morph, anim, pal, txt] =
      await Promise.all([
        import('../renderer/renderer.js'),
        import('../renderer/bundle.js'),
        import('../animation/overrides.js'),
        import('../animation/shapeMorph.js'),
        import('../animation/shapeAnimation.js'),
        import('../animation/colorPalette.js'),
        import('../textBundle.js'),
      ]);
    // Shaders are opt-in for advanced callers (a precompiled/minified
    // build-time dict via `opts.shaders`); otherwise self-locate and fetch
    // them from the package so the drop-in path needs zero shader wiring.
    // `opts.shaderSpec` trims the fetch list (e.g. `{ features }`).
    let shaders = opts.shaders;
    if (!shaders) {
      const { bundleShaders } = await import('../shaders/index.js');
      shaders = await bundleShaders.fromPackage(opts.shaderSpec);
    }
    const renderer = createRenderer(gl, shaders, opts.rendererOpts || {});
    return wrapWebgl(renderer, gl, createBundle, { ovr, morph, anim, pal, txt });
  }

  // Lazy-load the native fallback ONLY on the native path (+ its binding
  // factories — all gl-free).
  const [{ createNativeScene }, { createNativeOverrideTable }, native, { createNativeTextBundle }] =
    await Promise.all([
      import('./nativeSvgFallback.js'),
      import('./nativeOverrideTable.js'),
      import('./nativeMorph.js'),
      import('./nativeTextBundle.js'),
    ]);
  const host = opts.nativeHost || canvas;
  const nativeScene = createNativeScene(host, {
    document: opts.document,
    // A multi-bundle pixel-viewport compositor passes coordinateSpace:
    // 'viewport' so the native root viewBox is the pixel viewport and
    // worldMatrix is em→pixel (matches the WebGL path's pixel-space
    // result). Default 'bundle' keeps the single-bundle em-space behavior.
    coordinateSpace: opts.coordinateSpace,
  });
  return wrapNative(nativeScene, { createNativeOverrideTable, native, createNativeTextBundle });
}

// WebGL: return the REAL renderer (full method surface — drawSprite,
// drawBundleInstanced, createBundleHandle, enableStaticCache, every
// renderer.* call a consumer already makes), augmented with `backend`,
// `gl`, and `toScene`. This is the drop-in: swap createRenderer(gl,…) for
// `await createMantleScene(canvas,…)` and NOTHING else in the consumer
// changes. We add fields directly on the renderer object (it's a plain
// dict of closures, not a class) so no method is hidden behind a wrapper.
function wrapWebgl(renderer, gl, createBundle, bind) {
  renderer.backend = 'webgl';
  renderer.gl = gl;
  renderer.renderer = renderer;   // self-ref, mirrors scene.renderer on native
  renderer.nativeScene = null;
  if (typeof renderer.toScene !== 'function')
    renderer.toScene = (sections) => createBundle(gl, sections);
  // The GL path is ALWAYS pixel-viewport (the vertex shader maps em→clip
  // via the canvas viewport). setCoordinateSpace exists for parity but is
  // a no-op here — worldMatrix is clip-space by the shader contract.
  if (typeof renderer.setCoordinateSpace !== 'function')
    renderer.setCoordinateSpace = () => {};

  // Backend-agnostic binding factories — supply `gl` so the consumer
  // doesn't, and doesn't gate by backend. (createOverrideTable etc. are
  // still importable directly for low-level use.)
  renderer.createOverrideTable = (bundle) => bind.ovr.createOverrideTable(gl, bundle);
  renderer.createPalette = (entries) => bind.pal.createPalette(gl, entries);
  renderer.createTextBundle = (textOpts) => bind.txt.createTextBundle(gl, textOpts);
  // createMorph(src, dst, {srcSprite?, dstSprite?}) — sprite morph when a
  // sprite is named on either side, else a whole-bundle shape morph.
  renderer.createMorph = (src, dst, mopts = {}) =>
    (mopts.srcSprite != null || mopts.dstSprite != null)
      ? bind.morph.createSpriteMorph(gl,
          { bundle: src, sprite: mopts.srcSprite },
          { bundle: dst, sprite: mopts.dstSprite })
      : bind.morph.createShapeMorph(gl, src, dst);
  // createTimeline(refs, keys) — sprite timeline when refs are
  // {bundle,sprite} (or keys use refIndex), else a bundle-array timeline.
  renderer.createTimeline = (refs, keys) => isSpriteRefs(refs, keys)
    ? bind.anim.createSpriteTimeline(gl, refs, keys)
    : bind.anim.createShapeTimeline(gl, refs, keys);
  return renderer;
}

// Heuristic shared by both backends: a "sprite" timeline is one whose
// refs are {bundle,sprite} objects (or whose keys index by refIndex).
function isSpriteRefs(refs, keys) {
  if (Array.isArray(refs) && refs.some(r => r && r.bundle !== undefined && r.sprite !== undefined))
    return true;
  if (Array.isArray(keys) && keys.some(k => k && k.refIndex !== undefined))
    return true;
  return false;
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
  scene.toScene = (sections) => {
    if (!sections.svgSource) {
      mantleWarn('[Mantle] native fallback: sections lack svgSource — ' +
        'import with { retainSource: true } so the fallback can render ' +
        'the original markup.');
    }
    return sections;
  };

  // Same binding-factory surface as WebGL — routed to the native (gl-free)
  // implementations. Identical call shape, so the consumer's override /
  // morph / timeline setup is backend-agnostic (no `gl`, no gating).
  scene.createOverrideTable = (bundle) => bind.createNativeOverrideTable(bundle);
  scene.createMorph = (src, dst, mopts = {}) =>
    bind.native.createNativeMorph(src, dst, mopts);
  scene.createTimeline = (refs, keys) =>
    bind.native.createNativeTimeline(refs, keys);
  // Native text: shape glyphs (gl-free) → svgSource bundle; renders the
  // glyph OUTLINES (GL-parity geometry, no browser-font dependency).
  scene.createTextBundle = (textOpts) => bind.createNativeTextBundle(textOpts);
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
      setEntries(next) { this.entries = next; this.size = next.length; this.__entries01 = null; },
    };
  };
  return scene;
}
