// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
// Code splitting: createMantleScene is ASYNC and loads each backend via
// dynamic import(), so a native-path bundle never ships the WebGL renderer
// (renderer.js + filterGraph + shaders) and a pure-WebGL app never ships
// the native fallback — only the selected backend's code is fetched. (Use
// createRenderer / createNativeScene directly — both synchronous — when you
// already know the backend and don't need the split.)
//

import { mantleWarn } from '../core/diagnostics.js';

/**
 * Decide which backend to use. Exposed so callers can branch their own
 * setup (e.g. only fetch shaders when WebGL wins).
 *
 * @param {HTMLCanvasElement} [canvas]
 * @param {object} [opts]
 * @param {'webgl'|'native'} [opts.backend]  hard override
 * @param {boolean} [opts.forceNative]
 * @param {object}  [opts.glAttribs]  getContext('webgl2', …) attributes
 * @param {boolean} [opts.rememberFailedWebgl]  false tries WebGL even where it failed to start before
 * @returns {{backend:'webgl'|'native', gl:WebGL2RenderingContext|null, webglFailed:[string, number]|null, gpu?:string}}
 *   webglFailed: the GPU and 0 ms when a failed start on this GPU and browser chose native;
 *   gpu: the GPU WebGL will start on, read while its context still answers
 */
export function chooseBackend(canvas, opts = {}) {
  if (opts.backend === 'native') return { backend: 'native', gl: null, webglFailed: null };
  if (opts.backend === 'webgl') {
    const gl = getGL(canvas, opts);
    if (!gl) throw new Error("createMantleScene: backend:'webgl' forced but WebGL2 is unavailable");
    return { backend: 'webgl', gl, webglFailed: null };
  }
  if (opts.forceNative === true) return { backend: 'native', gl: null, webglFailed: null };
  const gl = getGL(canvas, opts);
  if (!gl) return { backend: 'native', gl: null, webglFailed: null };
  const gpu = gpuOf(gl);
  if (opts.rememberFailedWebgl !== false && webglFailedBefore(gpu)) {
    try {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch {
      /* best effort */
    }
    return { backend: 'native', gl: null, webglFailed: [gpu, 0] };
  }
  return { backend: 'webgl', gl, webglFailed: null, gpu };
}

// A driver that cannot build Mantle's large programs holds the browser's GPU process for seconds per program before it fails (a Galaxy Tab A's
// Mali-T830 in Chrome 101: maskBake 11 s, splitStroke 19 s), and no frame draws meanwhile, native SVG included, so no timeout can cut it short.
// Only not starting is fast: a failed start is remembered for that GPU and browser, and their next load starts native. A browser update tries
// WebGL again.
const WEBGL_FAILED_KEY = 'mantle.webglFailed';

/** The GPU's unmasked renderer, or its masked one, or ''. Read it before WebGL starts: a context whose start failed may answer null. */
function gpuOf(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof renderer === 'string' ? renderer : '';
  } catch {
    return '';
  }
}

function deviceOf(gpu) {
  const userAgent = (globalThis.navigator && globalThis.navigator.userAgent) || '';
  return gpu + ' ' + userAgent;
}

function webglFailedBefore(gpu) {
  try {
    return !!globalThis.localStorage && globalThis.localStorage.getItem(WEBGL_FAILED_KEY) === deviceOf(gpu);
  } catch {
    return false;
  }
}

function rememberWebglFailed(gpu) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(WEBGL_FAILED_KEY, deviceOf(gpu));
  } catch {
    /* storage unavailable */
  }
}

function getGL(canvas, opts) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  try {
    return canvas.getContext(
      'webgl2',
      opts.glAttribs || {
        // Nothing in src/ ever tests the stencil buffer: zero `stencilFunc` and zero `stencilOp`
        // call sites, and every STENCIL_TEST mention is a
        // disable or a restore of something nothing enables. Asking for one allocates a buffer no
        // fragment reads.
        //
        // This matches what mantleDemo.html uses (depth true, stencil true) minus the stencil
        // buffer that path does not need either.
        depth: true,
        stencil: false,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        desynchronized: true,
        powerPreference: 'high-performance',
      },
    );
  } catch {
    return null;
  }
}

/**
 * The scene `createMantleScene` returns. The named members are the draw surface both backends share; the rest of each
 * backend's surface (the renderer's, or the native scene's) is reachable through the index signature.
 * @typedef {{
 *   backend: 'webgl' | 'native',
 *   gl?: any,
 *   setViewport(w: number, h: number): void,
 *   beginFrame(clearColor?: number[]): void,
 *   drawBundle(target: any, opts?: import('../renderer/rendererApi.js').DrawBundleOptions): any,
 *   endFrame(): void,
 *   toScene(sections: any, opts?: any): any,
 *   dispose(): void,
 * } & Record<string, any>} MantleScene
 */

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
 * @param {object}  [opts.shaderSpec]  narrows the bundled shader set loaded when
 *   `opts.shaders` is absent (e.g. `{ features }` from bundle inspect).
 *   Ignored when `shaders` is supplied — nothing is loaded then.
 * @param {Document} [opts.document]   forwarded to the native scene; defaults
 *   to the host's ownerDocument
 * @param {'bundle'|'viewport'} [opts.coordinateSpace]  forwarded to the native
 *   scene — a multi-bundle pixel-viewport compositor wants 'viewport'
 * @param {boolean} [opts.rememberFailedWebgl]  default true: a WebGL start that fails is stored in localStorage for
 *   this GPU and browser, and their next createMantleScene starts native at once. A native scene then carries
 *   `webglFailed`: [gpu, ms spent trying], 0 ms when a remembered failure skipped WebGL.
 * @returns {Promise<MantleScene>} the WebGL renderer or the native scene, whichever won; both share this surface.
 */
export async function createMantleScene(canvas, opts = {}) {
  if (
    opts.warmPolicy !== undefined &&
    opts.warmPolicy !== 'strict' &&
    opts.warmPolicy !== 'idle' &&
    opts.warmPolicy !== 'off'
  )
    throw new Error(
      'createMantleScene: opts.warmPolicy must be "strict", "idle" or "off", got ' +
        JSON.stringify(opts.warmPolicy),
    );
  const chosen = chooseBackend(canvas, opts);
  const { backend, gl } = chosen;
  let webglFailed = chosen.webglFailed;

  if (backend === 'webgl') {
    const gpu = chosen.gpu !== undefined ? chosen.gpu : gpuOf(gl);
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Lazy-load the GL pipeline only on the WebGL path so a native-only
    // bundle never ships renderer.js / bundle.js (+ filterGraph, shaders).
    // The binding factories (overrides / morph / timeline / palette) ride
    // along here too, so the scene can expose them without the consumer
    // threading `gl` or gating by backend.
    //
    // WebGL2 existing is not the same as the renderer starting: the context may already be lost, a driver may fail to link a
    // program, the shaders may fail to load. This factory owns the WebGL-vs-native decision, so unless the caller FORCED
    // backend:'webgl' (then the failure is theirs to see) any failure to start falls through to the native backend.
    try {
      const [{ createRenderer }, { createBundle }, ovr, morph, anim, pal, txt, ctx] =
        await Promise.all([
          import('../renderer/renderer.js'),
          import('../renderer/bundle.js'),
          import('../animation/overrides.js'),
          import('../animation/shapeMorph.js'),
          import('../animation/shapeAnimation.js'),
          import('../animation/colorPalette.js'),
          import('../textBundle.js'),
          import('../renderer/contextResources.js'),
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
      // The scene factory is async, so it can do what a synchronous createRenderer cannot: let the driver link the ~30 base programs in parallel
      // and read them only once they report complete (KHR_parallel_shader_compile), instead of freezing the page on the first LINK_STATUS read.
      // `asyncShaderCompile: false` in rendererOpts restores the synchronous create. Without the extension the option is a no-op and the create
      // is synchronous (the documented fallback: the extension is the only way to ask a program whether it is done).
      // `nonBlocking: true` also: no draw waits for a link, and while the GPU thread is more than 40 ms behind (a pipeline build is running) frames are dropped
      // at the door instead of queued behind it (queued uploads would make the main thread wait for the build). `nonBlocking: false` in rendererOpts restores
      // the blocking renderer.
      // `warmPolicy` (default 'strict'): 'strict' = the options above; 'idle' = the previous releases' renderer (no safety nets, draws compile on demand, blocking
      // links) that also builds queued variants in library-inferred idle windows; 'off' = previous releases with no background builds.
      const policy = opts.warmPolicy === undefined ? 'strict' : opts.warmPolicy;
      const renderer = createRenderer(
        gl,
        shaders,
        policy === 'strict'
          ? {
              asyncShaderCompile: true,
              nonBlocking: true,
              strictPlay: true,
              warmPolicy: 'strict',
              ...(opts.rendererOpts || {}),
            }
          : { warmPolicy: policy, ...(opts.rendererOpts || {}) },
      );
      await renderer.ready;
      // (A turn of the event loop between the renderer's construction and whatever the caller does when this resolves: the two are separate tasks, and
      // a long-task report names each.)
      await new Promise((r) => setTimeout(r, 0));
      return wrapWebgl(renderer, gl, createBundle, { ovr, morph, anim, pal, txt, ctx });
    } catch (err) {
      if (opts.backend === 'webgl') throw err;
      if (opts.rememberFailedWebgl !== false) rememberWebglFailed(gpu);
      const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      webglFailed = [gpu, Math.round(endedAt - startedAt)];
      mantleWarn(
        '[Mantle] createMantleScene: the WebGL renderer could not start (' +
          String((err && err.message) || err)
            .split('\n')[0]
            .slice(0, 200) +
          "); falling back to the native SVG backend. Pass backend:'webgl' to make this an error.",
      );
    }
  }

  // Lazy-load the native backend only on the native path (nativeBackend.js holds the native scene and its gl-free
  // binding factories; the `@kontek/mantle/native` entry is the same code without this GL-aware chooser).
  const [{ createNativeBackend }] = await Promise.all([
    import('./nativeBackend.js'),
    import('./nativeText.js'),
  ]);
  const scene = createNativeBackend(opts.nativeHost || canvas, opts);
  scene.webglFailed = webglFailed;
  return scene;
}

function wrapWebgl(renderer, gl, createBundle, bind) {
  renderer.backend = 'webgl';
  renderer.gl = gl;
  renderer.renderer = renderer; // self-ref, mirrors scene.renderer on native
  renderer.nativeScene = null;
  // opts forwards to createBundle — notably { recolor: true }, which fixes the
  // fill variant at creation. Dropping it here would strand every consumer that
  // builds bundles through toScene on the mid-play self-heal path.
  //
  // Memoized per (sections object, options): a frame loop that calls toScene(sections) every frame
  // gets the one bundle back instead of uploading a new GPU bundle per call. The bundle is
  // rebuilt when it was disposed or the GL context was lost and restored since. Mutating
  // `sections` after the first call is not picked up; pass a new sections object for new content.
  if (typeof renderer.toScene !== 'function') {
    const built = new WeakMap(); // sections -> Map(options key -> bundle)
    renderer.toScene = (sections, opts) => {
      if (sections === null || typeof sections !== 'object')
        return createBundle(gl, sections, opts);
      let key;
      try {
        key = opts == null ? '' : JSON.stringify(opts);
      } catch {
        key = undefined;
      }
      if (key === undefined) return createBundle(gl, sections, opts); // options that cannot be keyed are not cached
      let byOpts = built.get(sections);
      if (!byOpts) built.set(sections, (byOpts = new Map()));
      const hit = byOpts.get(key);
      if (
        hit &&
        !hit._disposed &&
        (hit._resourceGeneration == null ||
          hit._resourceGeneration === bind.ctx.resourceGeneration(gl))
      )
        return hit;
      const bundle = createBundle(gl, sections, opts);
      byOpts.set(key, bundle);
      return bundle;
    };
  }
  // The GL path is always pixel-viewport (the vertex shader maps em→clip
  // via the canvas viewport). setCoordinateSpace exists for parity but is
  // a no-op here — worldMatrix is clip-space by the shader contract.
  if (typeof renderer.setCoordinateSpace !== 'function') renderer.setCoordinateSpace = () => {};

  // Backend-agnostic binding factories — supply `gl` so the consumer
  // doesn't, and doesn't gate by backend. (createOverrideTable etc. are
  // still importable directly for low-level use.)
  renderer.createOverrideTable = (bundle) => bind.ovr.createOverrideTable(gl, bundle);
  renderer.createPalette = (entries) => bind.pal.createPalette(gl, entries);
  renderer.createTextBundle = (textOpts) => bind.txt.createTextBundle(gl, textOpts);
  // createMorph(src, dst, {srcSprite?, dstSprite?}) — sprite morph when a
  // sprite is named on either side, else a whole-bundle shape morph.
  renderer.createMorph = (src, dst, mopts = {}) =>
    mopts.srcSprite != null || mopts.dstSprite != null
      ? bind.morph.createSpriteMorph(
          gl,
          { bundle: src, sprite: mopts.srcSprite },
          { bundle: dst, sprite: mopts.dstSprite },
          mopts,
        )
      : bind.morph.createShapeMorph(gl, src, dst, mopts);
  // createTimeline(refs, keys) — sprite timeline when refs are
  // {bundle,sprite} (or keys use refIndex), else a bundle-array timeline.
  renderer.createTimeline = (refs, keys, topts) =>
    isSpriteRefs(refs, keys)
      ? bind.anim.createSpriteTimeline(gl, refs, keys, topts)
      : bind.anim.createShapeTimeline(gl, refs, keys, topts);
  return renderer;
}

// Heuristic shared by both backends: a "sprite" timeline is one whose
// refs are {bundle,sprite} objects (or whose keys index by refIndex).
function isSpriteRefs(refs, keys) {
  if (
    Array.isArray(refs) &&
    refs.some((r) => r && r.bundle !== undefined && r.sprite !== undefined)
  )
    return true;
  if (Array.isArray(keys) && keys.some((k) => k && k.refIndex !== undefined)) return true;
  return false;
}
