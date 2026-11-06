// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import {
  uploadBuffer,
  uploadQueued,
  setCoopUploads,
  pumpUploads,
  pendingUploadBytes,
} from './coopUpload.js';
import { planCoverLayout } from './coverQuadChunks.js';
import {
  deleteGlResource,
  deleteProgramWhenLinked,
  trackGlResource,
  contextProgramsCreated,
  resourceGeneration,
} from './contextResources.js';
import { retainMorphLerpOwner } from './morphLerpPass.js';
import { retainCPatchBlendOwner } from './cpatchMorphBlend.js';
import { assertUsableGl, validateRendererOptions } from './contextCheck.js';
// MantleRenderer (WebGL2) — owns the GL state machine (programs,
// VAOs, FBOs, dummy textures) and the per-frame render loop. Bundles
// own their per-asset textures + mesh data and are bound onto the
// renderer via setBundle().
//
// Public API:
//   const renderer = createRenderer(gl, shaderSources, opts?);
//   renderer.setBundle(bundle);
//   renderer.render();
//   renderer.dispose();
//
// `shaderSources` is the SHADER_SOURCES object exported by
// ./shaders/index.js (keyed by stage). The renderer doesn't fetch
// shaders on its own — the consumer chooses bundler-time inlining vs
// runtime fetch (loadShaders).
//
// `opts` flags: asyncShaderCompile (defer link stalls behind a
// KHR_parallel_shader_compile poll), nonBlocking (no draw, query or upload waits for the driver or the GPU thread: a
// program that is not ready is not asked, its draw uses a built stand-in or is deferred, frames are shed while the GPU thread is behind -- gpuGate.js,
// README "Never blocking the main thread"; createMantleScene sets it), glGuard (count and log every wait: glGuard.js), captureFrames (SVG-export frame
// recorder, default off), fillDefines (extra fill-shader defines; a test hook, read only under
// __MANTLE_DEBUG__), groupAtlas (false gives every plain group its own accumulator instead of a slot of the shared atlas), groupFilterCache (false turns off the filtered-group result cache),
// aacFill (false | true | 'auto' engine selection), exactEdgeAa (accepted and
// ignored: the default fill is at least as exact), disableFillVariants,
// typeOmit (strip unused curve kernels per bundle), strokeExactEdges (compile the exact stroke edge records
// and strokeExactCov into the stroke programs; off by default: the default stroke AA is the single-edge ramp), and
// onContextLost / onContextRestored consumer hooks.
//
// State ownership:
//   - The renderer instance owns programs, uniform locations, VAOs,
//     attribute buffers, dummy textures, FBOs, and all render-pass
//     scratch state.
//   - The bundle owns asset textures + mesh ArrayBuffers.
//   - The canvas + gl context are owned by the consumer.

import { Constants, removeLbBuilder, removeLbPreparer } from './bundle.js';
import {
  mantleWarn,
  mantleError,
  mantleDebugFlag,
  mantleDebugHook,
  mantleDebugEnabled,
  diagFlags,
  diagNoteEngine,
} from '../core/diagnostics.js';
import {
  buildLoopBlinnMesh,
  buildLoopBlinnCDT,
  refreshLoopBlinnMesh,
  packLoopBlinnMesh,
  curveRangeToContours,
  LB_VERT_FLOATS,
  lbCanonicalFrame,
  lbCanonicalHash,
  lbCanonicalHashes,
  transformLoopBlinnRaw,
} from './loopBlinn.js';
import {
  createRTPool,
  evaluateGraph,
  unitCoverageShadow,
  releaseRoot,
  SRC_BACKGROUND,
  SRC_BACKGROUND_A,
} from '../filterGraph/filterGraph.js';
// Read filter/COLR handlers from the opt-in registry — NOT from a module
// that side-effect-imports every primitive, which would re-link the whole
// filter+COLR shader-handler set into every renderer consumer and defeat
// the registry tree-shaking. The registry is empty by default; the
// consumer's feature imports (or the root barrel's "register all")
// populate it before createRenderer runs. The graph evaluator treats an
// unregistered node type as passthrough, so a partial table is safe.
import { svgFilterDispatch, colrPaintDispatch } from '../filterGraph/dispatchRegistry.js';
import { colrNodeBoxes } from '../filterGraph/bbox.js';
import { affMul, affInv } from '../filterGraph/affine2d.js';
import { Strategy as CacheStrategy, Level as CacheLevel } from './staticCache.js';
import { attachShaderPrograms } from './shaderPrograms.js';
import { installGlGuard } from './glGuard.js';
import { attachGpuGate } from './gpuGate.js';
import { attachGlState } from './glState.js';
import { attachDrawImages } from './drawImages.js';
import { attachInstancedFill } from './instancedFill.js';
import { attachAacPointsDraw } from './aacPointsDraw.js';
import { attachRouteBytes } from './routeBytes.js';
import { attachMemoryStats } from './memoryStats.js';
import { beginPreparation, endPreparation } from './memoryLedger.js';
import { attachRowEngines } from './rowEngines.js';
import { attachMorphDraw } from './morphDraw.js';
import { attachDrawSprites } from './drawSprites.js';
import { attachCacheDraw } from './cacheDraw.js';
import { attachFilterDraw } from './filterDraw.js';
import { attachMaskBake } from './maskBake.js';
import { attachWarmManifest } from './warmManifest.js';
import { attachWarmQueue } from './warmQueue.js';
import { attachWarmNeeds } from './warmNeeds.js';
import { attachFillPass } from './fillPass.js';
import { attachUnifiedFillDraw } from './unifiedFillDraw.js';
import { MESH_OWNER } from './fillMeshOwner.js';
import { attachOpaquePrepass } from './opaquePrepass.js';
import { attachFrameLoop } from './frameLoop.js';
import { attachDrawDispatch, resolveOverrides, disposedBundleDraw } from './drawDispatch.js';
import { attachBundleHandle } from './bundleHandle.js';
import { attachClipDraw } from './clipDraw.js';
import { attachIncrementalStroke } from './incrementalStroke.js';
import { decodeImageHref } from '../svg/image.js';
import { ENGINES, ROUTES, DECLINE, createEngineLedger, isStrokeRow } from './engineLedger.js';
import { setSdfPrimitivesEnabled, setSdfPrimitivesPinned } from '../geom/shapeRecognize.js';
import { engineSelection, analyticAllowed, engineSelKey } from './engineSwitch.js';
import { unwrapBundle } from '../core/unwrapBundle.js';
import { requireRendererFeature, getRendererFeature } from './featureRegistry.js';
import { clampArg } from '../core/argCheck.js';

const COVER_QUAD_STRIDE = Constants.COVER_QUAD_STRIDE;

// Meta-plane texel-7.w bit positions (matches MantleSvgImporter
// constants — keep in lockstep). Float-offset in metaFloats is
// shape * stride + (texel * 4 + component).
const META_FLAG_LAYER = 0x100;
const META_FLAG_MASK_BEGIN = 1 << 9;
const META_FLAG_MASK_END = 1 << 10;

// Color-matrix recolor defaults (dual-tint fill recolor).
// Used when a caller supplies only the matrix OR only the offset —
// the other defaults to identity/zero.
const SCRATCH_CEILING_BYTES = 256 * 1048576; // the least the filter scratch's ceiling can be (see _scratchOverCeiling)
const IDENTITY_COLOR_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ZERO_OFFSET = new Float32Array([0, 0, 0, 0]);

// Map opts.paletteChannel (string 'r'/'g'/'b'/'a' or numeric 0..3)
// to the int the fragment shader expects.
function paletteChannelToInt(v) {
  if (v == null) return 0;
  if (typeof v === 'string') {
    const c = v.toLowerCase();
    if (c === 'r') return 0;
    if (c === 'g') return 1;
    if (c === 'b') return 2;
    if (c === 'a') return 3;
  }
  const n = v | 0;
  return n < 0 ? 0 : n > 3 ? 3 : n;
}

/// Scan a bundle's meta plane for multi-shape mask regions. Returns
/// an array of regions:
///   { maskRow, firstChild, lastChild, emBBox: [xmin, ymin, xmax, ymax],
///     isLuminance }
///
/// `maskRow` is the 1-based meta-row index of the FLAG_MASK_BEGIN
/// row (= the value of every referencing visible shape's maskId).
/// Single-shape masks (no FLAG_MASK_BEGIN bracket) are NOT returned;
/// callers fall back to the inline single-fill path for those.
///
/// Cost: O(numShapes). Cache the result per bundle — meta plane is
/// immutable after import.
export function computeMaskRegions(bundle) {
  if (!bundle || !bundle.metaFloats || !bundle.numShapes) return [];
  const stride = bundle.metaFloatsPerShape | 0;
  const m = bundle.metaFloats;
  const n = bundle.numShapes | 0;
  const regions = [];
  let beginRow = -1;
  let beginIsLum = 0;
  let xL = 0,
    yT = 0,
    xR = 0,
    yB = 0;
  // Nested-mask depth-1 detection: any child carrying a non-zero
  // texel 7.w (post-importer-rewrite inner maskId) flips the region's
  // `hasInnerMask` flag. The renderer uses this to decide whether the
  // ping-pong sample pass is needed for this region. Float offset 31
  // = texel 7 component 3 in the 48-float stride.
  let hasInnerMask = false,
    hasGroups = false;
  for (let row = 0; row < n; row++) {
    const off = row * stride;
    const flags = (m[off + 27] + 0.5) | 0;
    if ((flags & META_FLAG_LAYER) === 0) continue;
    const isBegin = (flags & META_FLAG_MASK_BEGIN) !== 0;
    const isEnd = (flags & META_FLAG_MASK_END) !== 0;
    if (isBegin) {
      beginRow = row;
      // Texel 8.z (float offset 34) = isLuminance flag.
      beginIsLum = (m[off + 34] + 0.5) | 0;
      xL = m[off + 0];
      yT = m[off + 1];
      xR = m[off + 2];
      yB = m[off + 3];
      hasInnerMask = false;
      hasGroups = false;
    }
    if (beginRow >= 0) {
      if ((flags & (64 | 128)) !== 0 || m[off + 33] > 0) hasGroups = true;
      // Accumulate em-bbox union across all children of the current
      // mask. Each row's texel 0 is its own bbox.
      const cxL = m[off + 0],
        cyT = m[off + 1];
      const cxR = m[off + 2],
        cyB = m[off + 3];
      if (cxL < xL) xL = cxL;
      if (cyT < yT) yT = cyT;
      if (cxR > xR) xR = cxR;
      if (cyB > yB) yB = cyB;
      // Inner maskId on this child row? (Texel 7.w = float offset 31.)
      // Importer rewrites every layer row's maskId, so a child carries
      // the parent's maskRow even when it has no real inner reference.
      // Treat as a real inner-mask reference only when the child's
      // maskId differs from the parent region's beginRow+1.
      const innerMaskId = (m[off + 31] + 0.5) | 0;
      if (innerMaskId > 0 && innerMaskId !== beginRow + 1) hasInnerMask = true;
    }
    if (isEnd && beginRow >= 0) {
      regions.push({
        maskRow: beginRow + 1, // 1-based meta-row index
        firstChild: beginRow,
        lastChild: row,
        emBBox: [xL, yT, xR, yB],
        isLuminance: beginIsLum,
        hasInnerMask,
        hasGroups,
      });
      beginRow = -1;
      hasInnerMask = false;
    }
  }
  // Filtered containers apply their clip and mask after filtering, and a masked container applies its mask to the
  // composited group. Bake even single-shape resources so the final texture composite can sample coverage.
  for (let row = 0; row < n; row++) {
    const o = row * stride;
    if (
      !(m[o + 27] & 64) ||
      !(m[o + 32] > 0 || (!(m[o + 27] & META_FLAG_LAYER) && (m[o + 30] > 0 || m[o + 31] > 0)))
    )
      continue;
    for (const slot of [30, 31]) {
      const clip = slot === 30;
      const id = Math.round(m[o + slot]);
      if (!(id > 0) || regions.some((reg) => reg.maskRow === id)) continue;
      const first = id - 1,
        flags = Math.round(m[first * stride + 27]);
      let last = first;
      const begin = clip ? 2048 : 512,
        end = clip ? 4096 : 1024;
      if (flags & begin) while (last + 1 < n && !(m[last * stride + 27] & end)) last++;
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      let inner = false;
      for (let child = first; child <= last; child++) {
        const c = child * stride;
        bb[0] = Math.min(bb[0], m[c]);
        bb[1] = Math.min(bb[1], m[c + 1]);
        bb[2] = Math.max(bb[2], m[c + 2]);
        bb[3] = Math.max(bb[3], m[c + 3]);
        if (m[c + 31] > 0 && Math.round(m[c + 31]) !== id) inner = true;
      }
      regions.push({
        kind: clip ? 'effectClip' : 'effectMask',
        maskRow: id,
        firstChild: first,
        lastChild: last,
        emBBox: bb,
        isLuminance: clip ? 0 : Math.round(m[first * stride + 34]),
        hasInnerMask: inner,
        hasGroups: false,
      });
    }
  }
  // Grouped patterns share the cached resource array but retain RGBA paint.
  for (let row = 0; row < n; row++) {
    const o = row * stride;
    if (stride < 44 || Math.round(m[o + 43]) !== 2) continue;
    const first = Math.round(m[o + 40]) - 1,
      last = Math.round(m[o + 41]) - 1;
    if (first < 0 || last < first || last >= n) continue;
    let grouped = false;
    for (let child = first; child <= last; child++) {
      const c = child * stride;
      if (
        (Math.round(m[c + 27]) & (64 | 128)) !== 0 ||
        m[c + 33] > 0 ||
        Math.round(m[c + 43]) === 2
      ) {
        grouped = true;
        break;
      }
    }
    if (!grouped && !regions.some((reg) => reg.firstChild <= row && row <= reg.lastChild)) continue;
    regions.push({
      kind: 'pattern',
      patternRow: row,
      maskRow: 0,
      firstChild: first,
      lastChild: last,
      emBBox: [m[o], m[o + 1], m[o + 2], m[o + 3]],
      isLuminance: 0,
      hasInnerMask: false,
      hasGroups: true,
    });
  }
  return regions;
}

/// createRenderer's fillDefines warning is said once per page, not once per renderer.
let _warnedFillDefines = false;
let _warnedStraightCanvas = false;

/**
 * Create a Mantle WebGL2 renderer.
 *
 * A bundle's draws use the general fill program until the program specialized for it has its GPU
 * pipeline built. The renderer builds it in frame slack, or after `opts.psoWarmMaxWaitFrames` frames and
 * a second when the frames never have any; `precompileFills()` builds it at load instead.
 *   opts.psoWarmMaxWaitFrames  frames a draw may use the general fill program for want of its specialized
 *     pipeline before that pipeline is built regardless of frame time (default 60, and at least one
 *     second; 0 builds only in frame slack).
 *   opts.psoWarmIdle(dtMs)     decides when a frame is idle enough to build a pipeline, instead of the
 *     renderer's slack rule; while it is set the deadline does not apply.
 *   opts.aacPointsPrewarm      start the point-route program's link in prepareBundle / prewarmBundle, not at the first small
 *     draw. Default on with KHR_parallel_shader_compile (the link is only started), opt-in without it (the link is waited for).
 *   opts.variantFirst          (default true; false opts out) until a bundle's specialized fill program is warm, draw with
 *     that program instead of the general (base) program, as long as the base has never drawn. Every feature
 *     gate of the specialized program is the one the settled path uses. Fill and instanced draws alike.
 *   opts.filterPoolIdleMs      (default 10000; 0 disables) free filter scratch (the RT pool, the shape and ping targets) after this many
 *     MILLISECONDS with no filtered draw, one target per frame, oldest first, never one of the viewport's size class.
 *     debugStats.scratchTrim reports ticks, targets and bytes freed. A cached filter result in a texture over twice its size, stored this long ago, moves to a texture of its own size (a static scene after a zoom out).
 *   opts.cacheKeepDepthStencil (default false) keep a static cache's DEPTH24_STENCIL8 renderbuffer after its bake. By default it is freed
 *     after every bake (the bake needs it, the cached picture does not) and a fresh one is attached at the next bake of the same target.
 *   opts.warmMorphSources      (default false) prewarm the two bundles passed to `createShapeMorph` like any other. They are
 *     source poses nothing normally draws, so the automatic prewarm skips them (saves a Loop-Blinn stream and a coefficient
 *     texture each). Set true if the app draws a pose directly. Left unset on a stand-in-free renderer (strictPlay's default) the poses are warmed, so a direct draw builds nothing in play; false skips them there too.
 *
 * Throws a message that names WebGL2 when `gl` is null, not a WebGL context, WebGL1 or lost, and on invalid option values (see
 * `MantleRendererOptions`). A restored context does not revive a renderer: see `needsRecreate`, `onContextLost` and `onContextRestored`.
 *
 * @param {any} gl  a WebGL2 rendering context (checked at run time; typed `any` in the declarations)
 * @param {Record<string, string>} shaderSources  the shader dict: `await bundleShaders.fromPackage()` (`@kontek/mantle/shaders`), `loadShaders()`, or `bundleShaders({...})`
 * @param {import('./rendererApi.js').MantleRendererOptions} [opts]
 * @returns {import('./rendererApi.js').MantleRenderer}
 */
export function createRenderer(gl, shaderSources, opts = {}) {
  assertUsableGl('createRenderer', gl);
  if (
    !shaderSources ||
    typeof shaderSources !== 'object' ||
    shaderSources.fillVert == null ||
    shaderSources.fillFrag == null
  )
    throw new Error(
      'createRenderer: shaderSources is missing or incomplete; pass the dict from `await bundleShaders.fromPackage()` (or loadShaders(), or bundleShaders({...})).',
    );
  validateRendererOptions(opts);
  if (opts.cpatchFill === true || opts.cpatchAuto === true)
    requireRendererFeature(
      'cpatch',
      'createRenderer({ ' + (opts.cpatchFill === true ? 'cpatchFill' : 'cpatchAuto') + ': true })',
    );
  // Mantle's output is PREMULTIPLIED alpha, which is the WebGL default and what a page compositor expects. A context created with
  // `premultipliedAlpha: false` tells the browser to read the canvas as straight alpha, so every translucent pixel (an anti-aliased
  // edge, a fill-opacity, a group opacity) is darkened: half-transparent red reads (128,0,0,128) instead of (255,0,0,128). There is
  // no cheap correct fix on this side (every pass would have to un-premultiply), so it is reported once, loudly.
  if (!_warnedStraightCanvas && typeof gl.getContextAttributes === 'function') {
    const attrs = gl.getContextAttributes();
    if (attrs && attrs.premultipliedAlpha === false) {
      _warnedStraightCanvas = true;
      mantleWarn(
        '[mantle] createRenderer: this WebGL context was created with premultipliedAlpha:false, but Mantle writes premultiplied ' +
          'alpha. Translucent pixels (anti-aliased edges, opacity) will look darkened. Create the context with the default ' +
          '(premultipliedAlpha:true) -- canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true }).',
      );
    }
  }
  // The options are this renderer's own copy. setFillEngine writes the selection into R.opts, so a kept
  // caller object would carry one renderer's route and kernel into every other renderer built from it -- baked into the
  // second one's base program (aacFill below) -- and have them written back into the app's own object.
  opts = { ...opts };
  // warmPolicy (README, "Warm policy"): 'strict' = the strict-play guarantee (what createMantleScene sets), 'idle' = no strict-play safety nets (draws compile on demand) but
  // queued variants also build in inferred idle windows, 'off' = no background builds. Absent: a direct createRenderer keeps exactly the options it was given. The policy only fills
  // options the caller left out, so an explicit nonBlocking / strictPlay / asyncShaderCompile always wins.
  if (opts.warmPolicy === 'strict') {
    if (opts.nonBlocking === undefined) opts.nonBlocking = true;
    if (opts.strictPlay === undefined) opts.strictPlay = true;
    if (opts.asyncShaderCompile === undefined) opts.asyncShaderCompile = true;
  }
  // THE WARM POLICY DEFAULT (README, "Warm policy"): a strict renderer is stand-in-free. The loading call builds the exact image of what the live content can bind, and a draw whose
  // program is still missing in play waits for it (counted in debugStats.needMiss) rather than drawing a superset in its place. The stand-in policy stays available,
  // `{ standIns: true, needMissPolicy: 'defer' }`. A renderer without strictPlay keeps the options it was given: its synchronous warm has no bind-set pass.
  if (opts.strictPlay === true) {
    if (opts.standIns === undefined) opts.standIns = false;
    if (opts.needMissPolicy === undefined) opts.needMissPolicy = 'block';
  }
  // ------------------------------------------------------------
  // Shader readiness — synchronous by default, async opt-in
  // ------------------------------------------------------------
  // By default createRenderer behaves exactly as it always has: it
  // compiles + links every program and captures all uniform locations
  // synchronously, fully ready on return. In the common case shader
  // R.compile is cheap (a few ms; drivers often R.compile eagerly in the
  // background, so the status queries don't even block), and paying a
  // few event-loop turns to defer it would only ADD first-paint latency.
  //
  // `opts.asyncShaderCompile: true` is the escape hatch for the
  // pathological case — a GPU under heavy contention, or an old/weak
  // device — where linking ~20 programs can stall the main thread for
  // tens of ms. When set, the
  // link-status + uniform-capture work (everything that FORCES the
  // driver to finish compiling) is deferred behind a non-blocking
  // KHR_parallel_shader_compile poll across rAF, so the stall moves off
  // the critical path. The caller must then `await renderer.ready`
  // before the first draw; pre-ready draw calls no-op with a warning.
  //
  // Either way `renderer.ready` exists and resolves when usable — it
  // resolves synchronously-then-already-resolved in the default path, so
  // `await renderer.ready` is always safe and a no-op when not needed.
  // The zero-blocking guard (glGuard.js) goes on BEFORE anything below touches the context, so it sees every query this renderer makes.
  const _glGuard =
    opts.glGuard === true || mantleDebugHook('__MANTLE_GL_GUARD__') === true
      ? installGlGuard(gl, opts.glGuardOptions)
      : null;
  const _asyncCompile =
    opts.asyncShaderCompile === true && !!gl.getExtension('KHR_parallel_shader_compile');
  // Always grab the extension when present: selectFillVariant polls it to compile per-bundle
  // fill variants WITHOUT blocking, independently of the opt-in initial-batch async path.
  const _khrParallel = gl.getExtension('KHR_parallel_shader_compile') || null;
  const _pendingShaders = [];
  const _pendingPrograms = [];
  // `aacFill: true` means "draw with AAC", not "draw with AAC eventually". Left to the variant
  // machinery it would be the latter: the AAC program compiles lazily, and until it is linked AND
  // its Metal pipeline is warmed, every draw falls back to the Slug base — so a render of a
  // few frames (a test, an A/B, a demo) would silently produce Slug and report it as AAC. Bake
  // the define into the BASE program instead, so the engine you asked for is the engine that
  // draws frame 0. ('auto' is a per-bundle decision and stays with the variants.)
  // Filldefines is a test hook. It compiles arbitrary defines into every fill program --
  // kernels, omissions, research arms -- so an app passing it builds a program no default draw ever runs, and a wrong
  // omission paints wrong. It takes effect only under `globalThis.__MANTLE_DEBUG__ === true`, like the
  // `__MANTLE_FILL_DEFINES` hook; otherwise it warns once and is dropped here, before the renderer's own use of the
  // field (aacFill below). The fill variants already strip what a bundle does not use, per bundle.
  if (opts.fillDefines && opts.fillDefines.length && !mantleDebugEnabled()) {
    if (!_warnedFillDefines) {
      _warnedFillDefines = true;
      mantleWarn(
        '[mantle] createRenderer: `fillDefines` is a test hook and is ignored unless globalThis.__MANTLE_DEBUG__ ' +
          'is true. Pick an engine with renderer.setFillEngine(); fill variants omit unused features per bundle.',
      );
    }
    opts = { ...opts, fillDefines: undefined };
  }
  const baseFillDefines = (opts.fillDefines || []).slice();
  if (opts.aacFill === true && !baseFillDefines.includes('MANTLE_AAC'))
    baseFillDefines.push('MANTLE_AAC');
  // exact-EDGE AA (`exactEdgeAa: true`) IS ACCEPTED AND IGNORED: the default fill is the better path. MANTLE_EXACT_EDGE
  // takes a pixel one straight edge crosses as that half-plane's exact box area. The default Slug tail has the same
  // exactness on straight edges (the secant through the two rays' crossings, clipped at a corner pixel) and bends it by
  // the tangents on curves, without per-crossing normals, offsets and counters held live across the band walk.
  // A knob that is slower and less exact is not a trade, so the option selects nothing; a caller passing it gets
  // the default. MANTLE_EXACT_EDGE itself is reachable through fillDefines, for research only.
  // NOTE: there is no `slopeAa` option — slope-AA is always ON. As a flag it would cost the frame tax
  // of a fill #define for an accuracy win every caller wants.
  //
  /** @type {import('./rendererContext.js').RendererContext} */
  const R = {
    gl,
    shaderSources,
    opts,
    mantleWarn,
    mantleError,
    mantleDebugFlag,
    _baseFillDefines: baseFillDefines,
    _asyncCompile,
    _khrParallel,
    _pendingShaders,
    _pendingPrograms,
    _glGuard,
    // Per-renderer and cumulative, like every other counter here: consumers snapshot and
    // difference it. Created with R rather than lazily, because a call site that finds it
    // missing would silently record nothing.
    _engines: createEngineLedger(),
  };
  // WebGL context-loss state + the backing canvas for the listeners (null for
  // an OffscreenCanvas / headless gl with no addEventListener).
  let _contextLost = false;
  // The context came back (webglcontextrestored) but this renderer cannot use it: its programs, uniform locations and the
  // bundles' textures died with the old context. _contextLost stays true so every internal draw gate keeps refusing; the public
  // draw entries throw (see _onContextRestored) until the host disposes this renderer and creates a new one.
  let _needsRecreate = false;
  // dispose() has run: every draw entry no-ops (it rides _contextLost), and entries that would allocate GL
  // resources (handles, images, strokes, prepare, warm) refuse -- see dispose().
  let _disposed = false;
  /** @type {Promise<void>|null} */
  let _loadingCall = null; // the async loading call in flight (precompileFillsAsync)
  // GROUP ATLAS state (see R._atlasTryBegin): the shared accumulator, its shelf packer, the composites a run of groups has
  // deferred, and the viewport shift in force while a slot is being drawn. Declared here, before any bindFb, so a bind during
  // construction never reads it uninitialized.
  const _atlas = {
    rt: null,
    size: 0,
    maxTex: 0,
    shelves: [],
    shelfEnd: 0,
    pend: [],
    held: false,
    open: false,
    flushing: false,
    shift: null,
    baseViewport: null,
  };
  const _canvas = gl.canvas && typeof gl.canvas.addEventListener === 'function' ? gl.canvas : null;
  R.CacheStrategy = CacheStrategy;
  R.CacheLevel = CacheLevel;
  // Attach the pipeline-state shadow FIRST: every later gl state write in this
  // renderer goes through R.gl*, so the helpers must exist before any of them
  // can run (setup code included).
  attachGlState(R);
  attachGpuGate(R);
  attachShaderPrograms(R);

  // The object returned synchronously. In async mode _init() publishes
  // its methods (via defineProperties, to preserve getters) once shaders
  // are ready; in sync mode that happens inline before return.
  /** @type {import('./rendererApi.js').MantleRenderer} */
  const rendererState = /** @type {import('./rendererApi.js').MantleRenderer} */ ({});
  let _ready = false;
  let _disposedBeforeReady = false;
  function discardInitialPrograms() {
    // Complete the driver's pending links before releasing their programs.
    // Program-owned shaders were already marked for deletion after link.
    for (const { prog } of R._pendingPrograms) deleteGlResource(gl, 'Program', prog);
    R._pendingShaders.length = 0;
    R._pendingPrograms.length = 0;
  }
  let _resolveReady, _rejectReady;
  rendererState.ready = new Promise((res, rej) => {
    _resolveReady = res;
    _rejectReady = rej;
  });

  // Pre-ready stubs (async mode only). Until _init() publishes the real
  // methods, a draw call would otherwise throw "render is not a
  // function". These warn once and no-op; _init's defineProperties
  // replaces them. In sync mode _init runs before return, so these are
  // overwritten before any caller can observe them.
  if (_asyncCompile) {
    rendererState.dispose = () => {
      if (_ready) {
        rendererState.dispose();
        return;
      }
      if (_disposedBeforeReady) return;
      _disposedBeforeReady = true;
      _rejectReady(new Error('Renderer disposed before shader preparation completed'));
    };
    let _warnedEarly = false;
    const _earlyStub = (name) => () => {
      if (!_warnedEarly) {
        _warnedEarly = true;
        mantleWarn(
          'Mantle: ' +
            name +
            '() called before renderer.ready resolved; ' +
            'with asyncShaderCompile you must await renderer.ready before the first draw. (No-op.)',
        );
      }
    };
    for (const m of [
      'render',
      'drawBundle',
      'beginFrame',
      'endFrame',
      'setViewport',
      'drawInstance',
      'drawImage',
      'drawImageInstanced',
      'drawBundleInstanced',
      'drawSprite',
      'drawSpriteInstanced',
      'setBundle',
    ]) {
      rendererState[m] = _earlyStub(m);
    }
  }

  /// Resolve when every queued program reports COMPLETION_STATUS_KHR ===
  /// true, polling across animation frames so the main thread stays free.
  /// Only used in async mode (else _khrParallel is null and this resolves
  /// immediately — but the sync path doesn't call it at all).

  // Everything below — link validation, the ~150 uniform-location
  // captures, and all resource/function setup — runs inside _runInit().
  // These are the forced-completion queries. In sync mode _runInit() is
  // called inline before createRenderer returns (default, zero added
  // latency); in async mode it runs after R._whenProgramsComplete()
  // resolves, off the main-thread critical path. The program handles
  // above are already queued (compiles kicked off); _runInit only
  // OBSERVES their results.
  function _runInit() {
    if (_disposedBeforeReady) {
      discardInitialPrograms();
      return;
    }
    // (Checkpoints of the construction, ms since it began, in debugStats.initPhases: a long construction task is a held main thread.)
    const _ti = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      _initT0 = _ti(),
      _ck = (name) => {
        (R._initPhases ||= []).push([name, Math.round((_ti() - _initT0) * 10) / 10]);
      };
    R.finalizeShaderCompiles();
    _ck('finalizeShaderCompiles');
    attachDrawImages(R);
    _ck('attachDrawImages');
    attachInstancedFill(R);
    _ck('attachInstancedFill');
    attachAacPointsDraw(R);
    _ck('attachAacPointsDraw');
    attachRouteBytes(R);
    attachMemoryStats(R);
    if (opts.memoryBudgetBytes != null) R.setMemoryBudget(opts.memoryBudgetBytes);
    attachRowEngines(R);
    attachMorphDraw(R);
    _ck('attachMorphDraw');
    attachDrawSprites(R);
    attachCacheDraw(R);
    _ck('attachCacheDraw');
    const { createImage, drawImage, drawImageInstanced, deleteClipTexture } = R;
    const { drawSprite, drawSpriteInstanced } = R;
    const { enableStaticCache, setInstanceGroup, disableStaticCache, invalidateStaticCache } = R;
    const {
      _drawBundleMorphRoute,
      _loopBlinnEligible,
      _simpleInstanceable,
      _ensureInstProg,
      _drawBundleInstancedFast,
      _cacheTick,
      _cacheBakeAndBlit,
      _cacheBlitToCanvas,
    } = R;
    const {
      solidProg,
      compProg,
      blurProg,
      boxBlurProg,
      morphProg,
      convolveProg,
      colorMatrixProg,
      feCompositeProg,
      feBlendProg,
      feTileProg,
      feTurbulenceProg,
      feDisplacementMapProg,
      feLightingProg,
      feComponentTransferProg,
      feImageProg,
      paintLinearGradProg,
      paintRadialGradProg,
      paintSweepGradProg,
      paintTransformProg,
      paintGlyphProg,
      paintCompositeProg,
      maskBakeProg,
      cacheBlitProg,
      lbProg,
      lbCompProg,
      splitStrokeProg,
      cbUCacheTex,
      cbUTint,
      lbUGBB,
      lbUCanvasAR,
      lbUWorldM,
      lbUHasWorldM,
      lbUViewport,
      lbUDirect,
      lbUAlpha,
      lbcUCoverage,
      lbcUColor,
      splitStrokeU,
    } = R;

    // (the fill-program uniform locations are resolved in fillPass.js's
    // attachFillPass — captureFillUniforms(prog), per program variant.)

    // maskBake program uniform locations.
    const mbUCurve = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uCurveData') : null;
    const mbUBand = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uBandData') : null;
    const mbUMeta = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMetaTex') : null;
    const mbUDash = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uDashTex') : null;
    const mbUGrad = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientTex') : null;
    const mbUGStops = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uGradientStops')
      : null;
    const mbUImage = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uImageTex') : null;
    const mbUAtlasS = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uImageAtlasSize')
      : null;
    const mbUFilter = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uFilterTex') : null;
    const mbUGCount = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uGradientCount')
      : null;
    const mbUGBB = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGlobalBBox') : null;
    const mbUEmBBox = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskEmBBox') : null;
    const mbUCanvasAR = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uCanvasAR') : null;
    const mbURow = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uMaskChildRow1Based')
      : null;
    const mbUIsLum = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uMaskIsLuminance')
      : null;

    const mbUMaskRTArrayPong = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uMaskRTArrayPong')
      : null;
    const mbUMaskRowToLayerTexBake = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uMaskRowToLayerTexBake')
      : null;
    const mbUViewportSize = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uViewportSize')
      : null;
    // Override plane (animated <mask> children) — bound on unit 8 in the bake,
    // same as the main fill pass; applied via the shared transformClipCoord.
    const mbUOverrideTex = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uOverrideTex')
      : null;
    const mbUHasOverrides = R.maskBakeProg
      ? gl.getUniformLocation(R.maskBakeProg, 'uHasOverrides')
      : null;
    const mbUOwnRow = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskOwnRow') : null;

    // Static-scene cache blit uniforms.
    R.cbUCacheTex = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uCacheTex') : null;
    R.cbUInMap = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uInMap') : null;
    R.cbUTint = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uTint') : null;
    // R.drawImage uniform locations.
    // (the image programs are built at the first image draw: their uniform locations are read then, shaderPrograms.js lazyProgram)
    {
      let di = null,
        dii = null;
      const locs = (prog, names) =>
        prog
          ? Object.fromEntries(
              Object.entries(names).map(([k, n]) => [k, gl.getUniformLocation(prog, n)]),
            )
          : null;
      const DI = {
        diUTex: 'uTex',
        diUTint: 'uTint',
        diUAlpha: 'uAlpha',
        diUDstRect: 'uDstRect',
        diUSrcRect: 'uSrcRect',
        diUViewport: 'uViewport',
        diUWorldM: 'uWorldM',
        diUCMatrix: 'uColorMatrix',
        diUCOffset: 'uColorMatrixOffset',
        diUCEnabled: 'uColorMatrixEnabled',
      };
      const DII = { diiUTex: 'uTex', diiUViewport: 'uViewport', diiUSrcRect: 'uSrcRect' };
      for (const k of Object.keys(DI))
        Object.defineProperty(R, k, {
          configurable: true,
          enumerable: true,
          get() {
            di = di || (R.drawImageProg ? locs(R.drawImageProg, DI) : {});
            return di[k] || null;
          },
        });
      for (const k of Object.keys(DII))
        Object.defineProperty(R, k, {
          configurable: true,
          enumerable: true,
          get() {
            dii = dii || (R.drawImageInstProg ? locs(R.drawImageInstProg, DII) : {});
            return dii[k] || null;
          },
        });
    }

    const solidUGBB = gl.getUniformLocation(R.solidProg, 'uGlobalBBox');
    const solidUAR = gl.getUniformLocation(R.solidProg, 'uCanvasAR');
    const solidUColor = gl.getUniformLocation(R.solidProg, 'uFillColor');

    // vUV → texture-uv maps (src/shaders/_filterRect.glsl). Every composite below
    // reads two CANVAS-sized textures, so both are the identity — but an unset vec4
    // uniform is (0,0,0,0), which would sample a single texel, so upload it.
    const COMP_IDENTITY_MAP = () => {
      if (compUShapeMap) gl.uniform4f(compUShapeMap, 1, 1, 0, 0);
      if (compUDstMap) gl.uniform4f(compUDstMap, 1, 1, 0, 0);
    };
    const compUShapeMap = gl.getUniformLocation(R.compProg, 'uShapeMap');
    const compUDstMap = gl.getUniformLocation(R.compProg, 'uDstMap');
    const compUShapeTex = gl.getUniformLocation(R.compProg, 'uShapeTex');
    const compUDstTex = gl.getUniformLocation(R.compProg, 'uDstTex');
    const compUBlendMode = gl.getUniformLocation(R.compProg, 'uBlendMode');
    const compUOpacity = gl.getUniformLocation(R.compProg, 'uOpacity');

    const morphUTex = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTex') : null;
    const morphUTexel = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTexel') : null;
    const morphUDir = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uDir') : null;
    const morphURadius = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uRadius') : null;
    const morphUOperator = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uOperator') : null;

    const convUTex = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTex') : null;
    const convUTexel = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTexel') : null;
    const convUOrder = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uOrder') : null;
    const convUTarget = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTarget') : null;
    const convUDivisor = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uDivisor') : null;
    const convUBias = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uBias') : null;
    const convUEdgeMode = R.convolveProg
      ? gl.getUniformLocation(R.convolveProg, 'uEdgeMode')
      : null;
    const convUPreserve = R.convolveProg
      ? gl.getUniformLocation(R.convolveProg, 'uPreserveAlpha')
      : null;

    const fcUIn1 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1') : null;
    const fcUIn2 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2') : null;
    const fcUIn1Map = R.feCompositeProg
      ? gl.getUniformLocation(R.feCompositeProg, 'uIn1Map')
      : null;
    const fcUIn2Map = R.feCompositeProg
      ? gl.getUniformLocation(R.feCompositeProg, 'uIn2Map')
      : null;
    const fcUOp = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uOp') : null;
    const fcUPD = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uPD') : null;
    const fcUK = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uK') : null;

    const fbUIn1 = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1') : null;
    const fbUIn2 = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2') : null;
    const fbUMode = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uMode') : null;

    const ftUTex = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTex') : null;

    const flUIn = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uIn') : null;
    const flUTexel = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uTexel') : null;
    const flUWorldScale = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uWorldScale')
      : null;
    const flUSurfaceScale = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uSurfaceScale')
      : null;
    const flUK = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uK') : null;
    const flUExponent = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uExponent')
      : null;
    const flULightColor = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uLightColor')
      : null;
    const flUMode = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uMode') : null;
    const flULightType = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uLightType')
      : null;
    const flULightPos = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uLightPos')
      : null;
    const flUSpotExp = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uSpotExp')
      : null;
    const flUSpotCosCone = R.feLightingProg
      ? gl.getUniformLocation(R.feLightingProg, 'uSpotCosCone')
      : null;

    const fctUIn = R.feComponentTransferProg
      ? gl.getUniformLocation(R.feComponentTransferProg, 'uIn')
      : null;
    const fctULUT = R.feComponentTransferProg
      ? gl.getUniformLocation(R.feComponentTransferProg, 'uLUT')
      : null;

    // COLRv1 paint-graph uniforms. Resolved once; the dispatch reads
    // them via ctx.paint*U dicts.
    function loc(prog, name) {
      return prog ? gl.getUniformLocation(prog, name) : null;
    }
    const paintLinearGradU = {
      uGradientStops: loc(R.paintLinearGradProg, 'uGradientStops'),
      uStopsOffset: loc(R.paintLinearGradProg, 'uStopsOffset'),
      uStopCount: loc(R.paintLinearGradProg, 'uStopCount'),
      uStopsChrome: loc(R.paintLinearGradProg, 'uStopsChrome'),
      uPaintMapX: loc(R.paintLinearGradProg, 'uPaintMapX'),
      uPaintMapY: loc(R.paintLinearGradProg, 'uPaintMapY'),
      uP0: loc(R.paintLinearGradProg, 'uP0'),
      uP1: loc(R.paintLinearGradProg, 'uP1'),
      uP2: loc(R.paintLinearGradProg, 'uP2'),
      uExtend: loc(R.paintLinearGradProg, 'uExtend'),
    };
    const paintRadialGradU = {
      uGradientStops: loc(R.paintRadialGradProg, 'uGradientStops'),
      uStopsOffset: loc(R.paintRadialGradProg, 'uStopsOffset'),
      uStopCount: loc(R.paintRadialGradProg, 'uStopCount'),
      uStopsChrome: loc(R.paintRadialGradProg, 'uStopsChrome'),
      uPaintMapX: loc(R.paintRadialGradProg, 'uPaintMapX'),
      uPaintMapY: loc(R.paintRadialGradProg, 'uPaintMapY'),
      uC0: loc(R.paintRadialGradProg, 'uC0'),
      uC1: loc(R.paintRadialGradProg, 'uC1'),
      uR0: loc(R.paintRadialGradProg, 'uR0'),
      uR1: loc(R.paintRadialGradProg, 'uR1'),
      uExtend: loc(R.paintRadialGradProg, 'uExtend'),
    };
    const paintSweepGradU = {
      uGradientStops: loc(R.paintSweepGradProg, 'uGradientStops'),
      uStopsOffset: loc(R.paintSweepGradProg, 'uStopsOffset'),
      uStopCount: loc(R.paintSweepGradProg, 'uStopCount'),
      uStopsChrome: loc(R.paintSweepGradProg, 'uStopsChrome'),
      uPaintMapX: loc(R.paintSweepGradProg, 'uPaintMapX'),
      uPaintMapY: loc(R.paintSweepGradProg, 'uPaintMapY'),
      uCenter: loc(R.paintSweepGradProg, 'uCenter'),
      uStartAngle: loc(R.paintSweepGradProg, 'uStartAngle'),
      uEndAngle: loc(R.paintSweepGradProg, 'uEndAngle'),
      uExtend: loc(R.paintSweepGradProg, 'uExtend'),
    };
    const paintTransformU = {
      uIn: loc(R.paintTransformProg, 'uIn'),
      uBboxOutOrigin: loc(R.paintTransformProg, 'uBboxOutOrigin'),
      uBboxOutSize: loc(R.paintTransformProg, 'uBboxOutSize'),
      uBboxInOrigin: loc(R.paintTransformProg, 'uBboxInOrigin'),
      uBboxInSize: loc(R.paintTransformProg, 'uBboxInSize'),
      uMRow0: loc(R.paintTransformProg, 'uMRow0'),
      uMRow1: loc(R.paintTransformProg, 'uMRow1'),
    };
    const paintGlyphU = {
      uIn: loc(R.paintGlyphProg, 'uIn'),
      uMask: loc(R.paintGlyphProg, 'uMask'),
      uInMap: loc(R.paintGlyphProg, 'uInMap'),
      uMaskMap: loc(R.paintGlyphProg, 'uMaskMap'),
    };
    const paintCompositeU = {
      uSrc: loc(R.paintCompositeProg, 'uSrc'),
      uDst: loc(R.paintCompositeProg, 'uDst'),
      uMode: loc(R.paintCompositeProg, 'uMode'),
      uPD: loc(R.paintCompositeProg, 'uPD'),
      uSrcMap: loc(R.paintCompositeProg, 'uSrcMap'),
      uDstMap: loc(R.paintCompositeProg, 'uDstMap'),
    };

    // ------------------------------------------------------------
    // Vertex buffers + VAOs
    // ------------------------------------------------------------
    // Solid/debug VAO + buffer (dynamic geometry, used by overlay paths).
    const solidVao = trackGlResource(gl, gl.createVertexArray());
    const solidBuf = trackGlResource(gl, gl.createBuffer(), 'core');
    R.glBindVertexArray(solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    R.glBindVertexArray(null);

    // Cover-quad VAO. Per-vert stride: 12 floats / 48 bytes.
    //   slot 0  : aPos (em-space xy)
    //   slots 1-4: aV0..aV3 (curve control points; per-curve-kind layout)
    //   slot 5  : aKind  (nointerp) 0=line, 1=arc, 2=quad, 3=cubic
    //   slot 6  : aZone  (interp)  +1 fan apex, 0 chord, -1 hull interior
    //   slot 7  : aShapeIdx (per-vert; sourced from a parallel buffer)
    // Per-handle VAO + VBO trio (triVao, triBuf, shapeIdxBuf) lives on
    // each bundle handle (see createBundleHandle below), off the renderer
    // scope so multi-bundle scenes don't re-upload mesh data on every
    // bundle switch.

    // Cover-pass fullscreen triangle strip (used by group composite + blur).
    const coverVao = trackGlResource(gl, gl.createVertexArray());
    const coverBuf = trackGlResource(gl, gl.createBuffer(), 'core');
    R.glBindVertexArray(coverVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, coverBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    R.glBindVertexArray(null);

    // ------------------------------------------------------------
    // Dummy textures — bound to samplers when the bundle has no
    // corresponding asset texture. WebGL2 requires every declared
    // sampler in the active program to have a valid binding even when
    // the shader's branch never reads it.
    // ------------------------------------------------------------
    function makeDummy(internal, format, type, fill) {
      const t = trackGlResource(gl, gl.createTexture(), 'core');
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 1, 1, 0, format, type, fill);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    }
    const dummyGradientTex = makeDummy(
      gl.RGBA32F,
      gl.RGBA,
      gl.FLOAT,
      new Float32Array([0, 0, 0, 0]),
    );
    // 1×1 dummy stops LUT — bound when a bundle has no gradients so the
    // shader's `uGradientStops` sampler stays valid. NEAREST sampling
    // (the stops shader does explicit texelFetch, not linear interp).
    const dummyGradientStops = makeDummy(
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    const dummyDashTex = makeDummy(gl.RGBA32F, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 0]));

    // ------------------------------------------------------------
    // Lazy FBOs (group composite + Gaussian blur ping-pong)
    // ------------------------------------------------------------
    let shapeFbo = null,
      shapeFboTex = null,
      shapeFboRb = null;
    const shapeFboSize = [0, 0];
    let mainCopyTex = null;
    const mainCopySize = [0, 0];
    // Inside an isolation group, per-shape blend-mode children need to
    // composite against the GROUP's local backdrop, not the canvas
    // snapshot in mainCopyTex (which groupBegin captured). Allocate a
    // separate RGBA8 texture lazily so the in-group snapshot doesn't
    // clobber mainCopyTex while the group is active.
    let groupBackdropTex = null;
    const groupBackdropSize = [0, 0];
    let pingFbo = null,
      pingTex = null;
    const pingSize = [0, 0];

    // A PIPELINE WARM draws one scissored pixel to build pipelines, which depend on the target's FORMAT, not its size: its group, filter, ping and coverage
    // targets are one small size (WARM_RT_PX). At full size every derived size region, every future state and every bundle that might draw would allocate
    // targets of its own, and the pool would keep them (gigabytes in a large scene, almost all of it for warms). A draw in play allocates the real targets it uses at its first
    // draw (a texture allocation, not a build). The warm's output is discarded (the frame's clear takes the pixel back).
    const WARM_RT_PX = 16;
    const _warmClamp = () => (R._psoWarming ? WARM_RT_PX : 0);
    const _rtPool = createRTPool(gl, { clamp: _warmClamp });
    // Dedicated R8 pool for coverage-only RTs (LB fill cov, stroke cov,
    // static-mesh cov) — 4× less memory than the RGBA8 filter pool. These RTs only
    // ever hold a single coverage channel (written as vec4(cov), sampled .r).
    const _covPool = createRTPool(gl, { internalFormat: gl.R8, format: gl.RED, clamp: _warmClamp });
    // Snapshot of the registered filter/COLR handlers. Graph nodes look
    // up handlers by primitive name; the walker tolerates partial tables
    // (unregistered nodes pass through), so a renderer built when only some
    // primitives are registered still works. Registration happens at
    // module load (the root barrel registers all; a feature entry registers
    // its subset), i.e. before any createRenderer call — so this snapshot
    // sees the consumer's intended set.
    const _svgDispatch = svgFilterDispatch();
    const _colrDispatch = colrPaintDispatch();

    let _maskBakeCount = 0;
    const _filterCache = new Map(); //
    //   a menu sheet (45 filtered shapes)         50.40ms -> 4.30ms
    //   a board sheet (65 shapes)                 75.65ms -> 6.38ms
    //   a dark panel (11 shapes)                  12.20ms -> 1.22ms
    //   slide1_games.svg (20 shapes)              17.28ms -> 2.63ms
    //
    // Assets with no filters are unchanged, as they must be.
    //
    // MIN_ENTRIES keeps the budget from starving a scene of a few big filters: a
    // handful of full-canvas results is exactly the case a byte budget alone would
    // refuse to hold, and that case is the main one this cache is for.
    // Tunable: `filterCacheBytes` on createRenderer. Raise it for scenes with many
    // large filtered shapes; lower it on memory-tight targets. Setting it BELOW one
    // frame's working set does not collapse the hit rate (see the eviction rule),
    // it just costs the extra bytes while that frame is on screen.
    const FILTER_CACHE_BYTE_BUDGET = Math.max(
      4 * 1024 * 1024,
      (opts && +opts.filterCacheBytes) || 64 * 1024 * 1024,
    );
    const FILTER_CACHE_MIN_ENTRIES = 8;
    // Absolute ceiling. The budget is advisory against this FRAME'S working set (see
    // _setFilterCache): evicting an entry another shape already used this frame
    // guarantees a miss next frame, which is precisely the collapse above. So the
    // budget yields to the working set, and this bounds what that can cost. It also
    // covers consumers that never call beginFrame, where the frame serial does not
    // advance and every entry would otherwise look current forever.
    const FILTER_CACHE_HARD_BYTES = 3 * FILTER_CACHE_BYTE_BUDGET;
    let _filterCacheBytes = 0;
    // Entries are charged by whoever ALLOCATES the texture (filterDraw's
    // _ensureCacheTex / _storeFilteredTex), because an entry is inserted into the map
    // before it is sized — reading c.w/c.h at insertion counts every such entry as
    // zero bytes and the budget silently never binds.
    R._filterCacheCharge = (delta) => {
      _filterCacheBytes += delta | 0;
      if (_filterCacheBytes < 0) _filterCacheBytes = 0;
    };
    const _entryBytes = (c) => (c ? (c._bytes_tex | 0) + (c._bytes_shapeTex | 0) : 0);
    // A result's texture outlives its entry for a while: an app that makes and disposes handles as it animates would otherwise allocate one per handle (dozens a second). A few small ones
    // wait here for the next store of a size they fit.
    const FREE_RESULT_BYTES = 8 * 1048576;
    const _freeResults = [];
    let _freeResultBytes = 0;
    function _dropFilterCacheEntry(c) {
      if (!c) return;
      _filterCacheBytes -= _entryBytes(c);
      if (_filterCacheBytes < 0) _filterCacheBytes = 0;
      if (c.tex && c.w * c.h * 4 + _freeResultBytes <= FREE_RESULT_BYTES) {
        _freeResults.push({ tex: c.tex, fbo: c.fbo, w: c.w, h: c.h });
        _freeResultBytes += c.w * c.h * 4;
        c.tex = null;
        c.fbo = null;
      }
      c._bytes_tex = 0;
      c._bytes_shapeTex = 0;
      for (const t of [c.tex, c.shapeTex]) if (t) deleteGlResource(gl, 'Texture', t);
      for (const fb of [c.fbo, c.shapeTexFbo]) if (fb) deleteGlResource(gl, 'Framebuffer', fb);
    }
    R._takeFreeResult = (w, h) => {
      for (let i = _freeResults.length - 1; i >= 0; i--) {
        const f = _freeResults[i];
        if (w <= f.w && h <= f.h && f.w * f.h <= 2 * w * h) {
          _freeResults.splice(i, 1);
          _freeResultBytes -= f.w * f.h * 4;
          return f;
        }
      }
      return null;
    };
    function _forgetFreeResults(deleteThem) {
      if (deleteThem)
        for (const f of _freeResults) {
          deleteGlResource(gl, 'Texture', f.tex);
          deleteGlResource(gl, 'Framebuffer', f.fbo);
        }
      _freeResults.length = 0;
      _freeResultBytes = 0;
    }
    function _getFilterCache(key) {
      // every filtered draw looks its result up here, a hit or a miss: that is the "filter work lately" clock of the scratch trim. The
      // pool's own acquire stamp is not enough: a static filtered scene is served from this cache and acquires nothing for seconds,
      // and the first version of the trim read that as idle and freed the targets a cache eviction (or a t change) needs next frame.
      _scratchUsedT = _nowMs();
      const c = _filterCache.get(key);
      if (!c) return null;
      c.frameSeen = R._frameSerial | 0;
      c._mt = _scratchUsedT;
      _filterCache.delete(key);
      _filterCache.set(key, c);
      return c;
    }
    function _setFilterCache(key, c) {
      const old = _filterCache.get(key);
      if (old && old !== c) _dropFilterCacheEntry(old);
      _filterCache.delete(key);
      _filterCache.set(key, c);
      c.frameSeen = R._frameSerial | 0;
      c._mt = _scratchUsedT = _nowMs();
      _enforceFilterBudget(c);
    }
    // Evict LRU-first until under budget, but never the entry being stored or grown, never below MIN_ENTRIES while under the hard ceiling, and -- up to that ceiling -- never one
    // another shape has already used this FRAME. That last rule is what makes a 0%-hit-rate collapse structurally impossible: a working set larger than the budget costs extra
    // memory for a frame instead of silently re-running every filter graph forever. The ceiling itself holds: past it, only the entry in hand stays. Runs wherever bytes are charged, on a store and on an
    // entry that GREW (zoom in): growing entries alone can pass the ceiling many times over, with nothing stored to trigger this.
    function _enforceFilterBudget(keep) {
      const curFrame = R._frameSerial | 0;
      while (
        _filterCacheBytes > FILTER_CACHE_BYTE_BUDGET &&
        (_filterCache.size > FILTER_CACHE_MIN_ENTRIES ||
          _filterCacheBytes > FILTER_CACHE_HARD_BYTES)
      ) {
        let oldestKey = _filterCache.keys().next().value;
        let oldest = _filterCache.get(oldestKey);
        if (oldestKey === undefined || oldest === keep) break;
        if (oldest && oldest.frameSeen === curFrame) {
          if (_filterCacheBytes <= FILTER_CACHE_HARD_BYTES) break;
          // Past the ceiling with everything left in this frame's working set, the oldest is the entry the next frame asks for first, and evicting it misses every entry in turn. Give up the
          // newest other instead: the entries that fit stay resident and only the rest re-evaluate. (Without beginFrame the serial never advances and "this frame" means nothing: oldest first.)
          if (curFrame > 0)
            for (const [k, e] of _filterCache)
              if (e !== keep) {
                oldestKey = k;
                oldest = e;
              }
        }
        _filterCache.delete(oldestKey);
        _dropFilterCacheEntry(oldest);
      }
    }
    R._enforceFilterBudget = _enforceFilterBudget;
    /// MAY A RESULT OF `bytes` JOIN THE CACHE? Not when it would pass the ceiling with only this frame's entries left to give up: the store would allocate a texture, copy into it and
    /// push out an entry the next frame asks for, or be pushed out itself by the next store, every frame. Every route composites from the target it evaluated in, so a store refused here
    /// changes no pixel and costs nothing; the entries that fit stay and serve the next frame, and the rest re-evaluate. The key's own old result goes either way. A lone entry may
    /// stay past the ceiling (it has nothing to push out), and with no beginFrame "this frame" means nothing and the budget decides alone.
    R._filterStoreFits = (key, bytes) => {
      const own = _filterCache.get(key);
      let used = _filterCacheBytes - _entryBytes(own);
      if (used + bytes <= FILTER_CACHE_HARD_BYTES) return true;
      const curFrame = R._frameSerial | 0;
      if (curFrame <= 0 || _filterCache.size === (own ? 1 : 0)) return true;
      for (const c of _filterCache.values()) {
        if (c === own || c.frameSeen === curFrame) continue;
        used -= _entryBytes(c);
        if (used + bytes <= FILTER_CACHE_HARD_BYTES) return true;
      }
      if (own) {
        _filterCache.delete(key);
        _dropFilterCacheEntry(own);
      }
      return false;
    };
    R._filterCacheOverBudget = () => _filterCacheBytes > FILTER_CACHE_BYTE_BUDGET;
    /// What a store put in its entry's texture: the result's own pixels, and when, for the idle shrink.
    R._noteResultStored = (entry, pl) => {
      entry._resultW = pl.rw;
      entry._resultH = pl.rh;
      entry._storedT = _nowMs();
    };
    /// Give back one oversized result texture nothing has stored into for `idle` ms. A store is what shrinks a texture (_resultPlacement), and a static scene stores nothing: after a zoom out its
    /// results are hits for as long as the scene stands, in textures sized for the zoom. The result is the texture's corner, so it moves by a copy, with no filter run and no program, and the
    /// entry's next hit composites the same pixels at the same place. One per frame. A result that is still moving stores again before this reads it.
    let _resultShrinkNotBefore = 0;
    function _shrinkIdleResult(t, idle) {
      if (!R._resultsOversized || t < _resultShrinkNotBefore) return false;
      let waiting = false;
      for (const c of _filterCache.values()) {
        const field = c.tex ? 'tex' : c.shapeTex ? 'shapeTex' : null,
          rw = c._resultW | 0,
          rh = c._resultH | 0;
        if (!field || c.key == null || !c.rect || !rw || !rh || !(c.w * c.h > 2 * rw * rh))
          continue;
        if (t - c._storedT < idle) {
          waiting = true;
          continue;
        }
        const fboField = field === 'tex' ? 'fbo' : 'shapeTexFbo',
          bytesField = '_bytes_' + field;
        const tex = trackGlResource(gl, gl.createTexture(), 'filterCache'),
          fbo = trackGlResource(gl, gl.createFramebuffer()),
          bound = R._boundDrawFbo || null;
        R._parkFillActiveUnit();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        bindFb(gl.FRAMEBUFFER, c[fboField]);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, rw, rh);
        bindFb(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        bindFb(gl.FRAMEBUFFER, bound);
        deleteGlResource(gl, 'Texture', c[field]);
        deleteGlResource(gl, 'Framebuffer', c[fboField]);
        _filterCacheBytes += rw * rh * 4 - (c[bytesField] | 0);
        c[field] = tex;
        c[fboField] = fbo;
        c[bytesField] = rw * rh * 4;
        c.w = rw;
        c.h = rh;
        c.rect = [c.rect[0], c.rect[1], rw, rh];
        c._wasted = 0;
        _trimDiag.shrunkResults++;
        return true;
      }
      // Nothing is ready: look again in at most a second, and not at all until a store leaves another texture oversized.
      if (!waiting) R._resultsOversized = false;
      _resultShrinkNotBefore = t + Math.min(idle, 1000);
      return false;
    }
    R._filterCacheStats = () => ({ entries: _filterCache.size, bytes: _filterCacheBytes });

    function _evictFilterCache(owner) {
      if (!owner) return;
      const gp = 'g' + owner + '_',
        kp = 'k' + owner + '_',
        up = 'u' + owner + '_'; // graph, single-kind, unified
      for (const [k, c] of _filterCache) {
        if (!k.startsWith(gp) && !k.startsWith(kp) && !k.startsWith(up)) continue;
        _filterCache.delete(k);
        _dropFilterCacheEntry(c);
      }
    }
    R._evictFilterCache = _evictFilterCache;
    R._getFilterCache = _getFilterCache;
    /// Every counter a DEFERRED draw raises (fill: no ready program; filter primitive; mask bake). A bake into a cache or render target that
    /// sees this move was not a complete picture and must not be kept as one (a blank static-cache bake would be blitted for a whole session).
    R._deferTotal = () =>
      (R._deferredFillDraws | 0) +
      (R._deferredFilterDraws | 0) +
      (R._maskBakeDeferred | 0) +
      (R._maskBakeStandIns | 0) +
      (R._reuseDraws | 0); // (a previous-variant reuse draw is a draw whose engine is not the needed one, and a rotated mask bake drawn by the axis-aligned program while its own links has the wrong footprint: a cache or mask slot baked over either is refused like a deferred bake and retried once the needed program is ready)
    R._setFilterCache = _setFilterCache;
    /// Does this filter graph read the BACKDROP (BackgroundImage / BackgroundAlpha)? Those are the only
    /// inputs that sample a backdrop snapshot, so they are the only reason to take one: every filter
    /// composite is fixed-function src-over and reads the destination itself. The same
    /// test keeps such a graph out of the result cache, whose key has no term for the backdrop. Shared
    /// by the classic loop and the unified route's isolation step so the two cannot disagree.
    R._graphReadsBackdrop = (graph) =>
      !!(
        graph &&
        graph.nodes &&
        graph.nodes.some(
          (n) => n.inputs && n.inputs.some((i) => i === SRC_BACKGROUND || i === SRC_BACKGROUND_A),
        )
      );
    /// May this draw of a filtered shape be served from -- or stored in -- the tier-2b result cache?
    /// The key is geometry, overrides, world matrix, canvas, recolor and filter parameters; these
    /// inputs change the result with no term in it: a palette LUT (mutable, no version token), an
    /// external clip texture (setNodeClip), a sprite subset draw, a bundle mask mesh, and a graph that
    /// reads the backdrop. `graph` is null for a single-kind filter. ONE predicate for the classic
    /// loop's graph and single-kind entries and the unified route's isolation step: a key with only
    /// the backdrop term would serve a palette draw or a sprite draw frame 1's result for as long as
    /// the key held.
    R._filterCacheable = (bundle, graph) =>
      !R._psoWarming &&
      !_ds.palette &&
      !_ds.extClipTex &&
      !_ds.shapeRange &&
      !(bundle && bundle.maskMesh) &&
      !R._graphReadsBackdrop(graph);
    let _filterEvalCount = 0; // debug: # of actual graph evals (misses)
    let _filterBboxActiveCount = 0; // debug: # of graph evals that ran on bbox-sized RTs

    function ensurePingFbo() {
      const [cw, ch] = viewportSize();
      if (pingSize[0] === cw && pingSize[1] === ch && pingFbo) return;
      if (pingTex) deleteGlResource(gl, 'Texture', pingTex);
      if (pingFbo) deleteGlResource(gl, 'Framebuffer', pingFbo);
      pingTex = trackGlResource(gl, gl.createTexture(), 'frameTargets');
      R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, pingTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      pingFbo = trackGlResource(gl, gl.createFramebuffer());
      bindFb(gl.FRAMEBUFFER, pingFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pingTex, 0);
      bindFb(gl.FRAMEBUFFER, null);
      pingSize[0] = cw;
      pingSize[1] = ch;
    }

    // Returns a SHARED 2-element scratch (filled per call) to avoid a young-gen
    // allocation on every draw-path call. Safe because every caller destructures
    // the result immediately (`const [w,h] = viewportSize()`); the one caller that
    // RETAINS the array (exportFrameSVG, below) copies it with .slice(). Do not
    // hold the returned array across another viewportSize()/arScale() call.
    const _viewportScratch = [0, 0];
    function viewportSize() {
      // The loading call's INTENDED final size (precompileFillsAsync({ viewport })): engine choice and variant keys follow the drawn size, so the warm
      // asks for the programs the player will see, not the ones the pre-resize canvas would pick. Set only while a warm draw runs (fillPass).
      if (R._warmViewport) return R._warmViewport;
      if (_explicitViewport) return _explicitViewport;
      _viewportScratch[0] = gl.drawingBufferWidth;
      _viewportScratch[1] = gl.drawingBufferHeight;
      return _viewportScratch;
    }

    // True when the drawing buffer hasn't reached a real size yet (a
    // pre-layout canvas reports 0×0). Creating offscreen targets at a
    // zero size and submitting them is a source of the startup mailbox
    // race — skip the frame and
    // let the next rAF tick run once the canvas has real dimensions.
    // Guard is intentionally narrow (zero, not "small") so legitimate
    // tiny offscreen renders still work.
    function _canvasUnsized() {
      const [w, h] = viewportSize();
      // ...or the GPU thread is behind by more than a frame (gpuGate.js shedFrame): a frame entered now would queue commands behind a pipeline
      // build and, when its uploads need transfer space, make the main thread wait for the build. The entry drops the frame exactly as it drops
      // one for an unsized canvas -- the canvas keeps the last frame that reached it, the caller's loop goes on, and the next frame after the
      // GPU thread catches up draws. Off by default for a direct createRenderer (a test or a tool that draws frame after frame and reads them back
      // wants every frame drawn); createMantleScene turns it on (`gpuShedMs: 40`), and `gpuShedMs: Infinity` turns it off again.
      return (
        !(w >= 1) ||
        !(h >= 1) ||
        (!R._inFrame &&
          R._gpuShedFrame !== undefined &&
          !(R._strictPlay && R._strictPlay()) &&
          R._gpuShedFrame())
      ); // (decided at the frame's entry, never part-way through one)
    }

    // Framebuffer bind wrapper that scopes the user-set scissor
    // (setScissorRect) to default-framebuffer draws only. Every internal
    // bindFramebuffer must route through here so SCISSOR_TEST tracks the
    // currently bound target:
    //   fbo === null  → user wants to draw to the canvas → enable scissor
    //   fbo !== null  → internal offscreen RT (shape/ping/sharp/mask/pool)
    //                   → disable scissor so the offscreen pass renders
    //                     full-RT
    // When no user scissor is set (_scissor == null), this is a passthrough.
    // 3rd-party dispatch modules (filterGraph/svg.js, filterGraph/colr.js)
    // bind FBOs directly on the raw `gl` ref — those binds don't toggle
    // scissor, but the dispatch call site below (render()) pauses
    // SCISSOR_TEST before evaluateGraph and the post-eval bindFb(null) here
    // re-enables it for the composite-back step.
    //
    function _targetScissor(fbo, logical) {
      const user = fbo === null && !(logical && R._cacheBakingNow) ? _scissor : null;
      const ws = R._warmScissor;
      if (!ws) return user;
      if (!user) return ws;
      const x0 = Math.max(user[0], ws[0]),
        y0 = Math.max(user[1], ws[1]);
      const x1 = Math.min(user[0] + user[2], ws[0] + ws[2]),
        y1 = Math.min(user[1] + user[3], ws[1] + ws[3]);
      return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
    }
    function _applyTargetScissor(fbo, logical) {
      const r = _targetScissor(fbo, logical);
      if (r) {
        gl.scissor(r[0], r[1], r[2], r[3]);
        R.glEnable(gl.SCISSOR_TEST);
      } else R.glDisable(gl.SCISSOR_TEST);
    }
    // A local scissor (a clear bounded to a rect) on an offscreen target, inside whatever that
    // target already allows; `_applyTargetScissor(fbo)` puts the target's own back afterwards.
    function _pushLocalScissor(rect, fbo) {
      const r = _targetScissor(fbo, false);
      let x0 = rect[0],
        y0 = rect[1],
        x1 = rect[0] + rect[2],
        y1 = rect[1] + rect[3];
      if (r) {
        x0 = Math.max(x0, r[0]);
        y0 = Math.max(y0, r[1]);
        x1 = Math.min(x1, r[0] + r[2]);
        y1 = Math.min(y1, r[1] + r[3]);
      }
      gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      R.glEnable(gl.SCISSOR_TEST);
    }
    R._targetScissor = _targetScissor;
    R._applyTargetScissor = _applyTargetScissor;
    function bindFb(target, fbo) {
      // A group-alpha draw (R._alphaGroupBegin) redirects every canvas bind to its accumulator, so the prelude and the passes that bind
      // "the canvas" after a sub-pass land in the group, not on the screen.
      if (
        fbo === null &&
        _alphaRedirect !== null &&
        (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER)
      )
        fbo = _alphaRedirect;
      // A cache bake redirects canvas writes to its cache target. Explicit
      // offscreen targets and read-framebuffer bindings keep their own identity.
      if (
        fbo === null &&
        R._cacheBakingNow &&
        _handle &&
        _handle.cacheFbo &&
        (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER)
      ) {
        fbo = _handle.cacheFbo;
      }
      // A run of group-atlas slots has deferred its composites: the first bind of the canvas is where they land (R._atlasFlush binds it).
      if (
        _atlas.held &&
        fbo === null &&
        !_atlas.flushing &&
        (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER)
      ) {
        R._atlasFlush();
        return;
      }
      gl.bindFramebuffer(target, fbo);

      if (target !== gl.READ_FRAMEBUFFER) R._boundDrawFbo = fbo;
      if (!_scissor && !R._warmScissor) return;
      // READ_FRAMEBUFFER binds are blit-source only; they don't change
      // the draw target so scissor state is irrelevant. Only toggle on
      // FRAMEBUFFER and DRAW_FRAMEBUFFER binds.
      if (target === gl.READ_FRAMEBUFFER) return;
      _applyTargetScissor(fbo);
    }

    // Drop everything whose SIZE is tied to the canvas. Nothing did this: the pools bucket
    // by size, so a resize just started allocating new buckets and kept every old one
    // forever. It went unnoticed because nothing resized much — a resolution scaler resizes
    // constantly, so it has to be real.
    //
    // Called on a detected canvas resize and by setResolutionScale. Everything here is
    // rebuilt lazily on demand, so this is a drop, not a teardown.
    function _invalidateSizedResources() {
      _rtPool.invalidate();
      _covPool.invalidate();
      for (const e of _shapeRtCache.values()) {
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
        deleteGlResource(gl, 'Renderbuffer', e.rb);
      }
      _shapeRtCache.clear();
      for (const e of _pingRtCache.values()) {
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
      }
      _pingRtCache.clear();
      // Filtered outputs are cached at a canvas-relative RECT — every one of them moved. (Through the one drop, which takes the entry's bytes off the budget: a resize that left them
      // charged raised the count by a full working set each time, until the ceiling evicted every result on every frame.)
      for (const c of _filterCache.values()) _dropFilterCacheEntry(c);
      _filterCache.clear();
      // shapeFbo / mainCopyTex / pingFbo / groupBackdropTex re-create themselves from
      // viewportSize() on next use (ensure*), and each handle's static cache re-bakes when
      // it sees the canvas changed. Just make the fill pass re-upload its size uniforms.
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
    }
    R._invalidateSizedResources = _invalidateSizedResources;

    function ensureShapeFbo() {
      const [cw, ch] = viewportSize();
      if (shapeFboSize[0] === cw && shapeFboSize[1] === ch && shapeFbo) return;
      if (shapeFboTex) deleteGlResource(gl, 'Texture', shapeFboTex);
      if (shapeFbo) deleteGlResource(gl, 'Framebuffer', shapeFbo);
      if (shapeFboRb) deleteGlResource(gl, 'Renderbuffer', shapeFboRb);
      shapeFboTex = trackGlResource(gl, gl.createTexture(), 'frameTargets');
      R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, shapeFboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      shapeFbo = trackGlResource(gl, gl.createFramebuffer());
      bindFb(gl.FRAMEBUFFER, shapeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shapeFboTex, 0);
      shapeFboRb = trackGlResource(gl, gl.createRenderbuffer(), 'frameTargets');
      gl.bindRenderbuffer(gl.RENDERBUFFER, shapeFboRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, cw, ch);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        shapeFboRb,
      );
      bindFb(gl.FRAMEBUFFER, null);
      shapeFboSize[0] = cw;
      shapeFboSize[1] = ch;
    }
    // Pooled offscreen targets for a FILTERED SHAPE, keyed by size.
    //
    // Shape targets cover only the filter rect. Sizes come from
    // _filterNodeRects already quantized to 32px, so the working set
    // is a handful of entries; they live with the renderer and are dropped on resize
    // alongside the RT pool. (The composite reads no backdrop, so there is no
    // rect-sized backdrop cache.)
    const _shapeRtCache = new Map(); // "w,h" → { fbo, tex, rb }  color + depth/stencil
    const _pingRtCache = new Map(); // "w,h" → { fbo, tex }      the kernels' ping-pong
    // What the memory budget (memoryStats.js) may free and read: the caches themselves, not copies.
    R._memHooks = {
      filterCache: _filterCache,
      dropFilterEntry: _dropFilterCacheEntry,
      entryBytes: _entryBytes,
      pools: { rt: _rtPool, coverage: _covPool },
      shapeTargets: _shapeRtCache,
      pingTargets: _pingRtCache,
      atlas: _atlas,
      filterBudget: { bytes: FILTER_CACHE_BYTE_BUDGET, hard: FILTER_CACHE_HARD_BYTES },
    };
    // `lin`: a target that holds linear light (SRGB8_ALPHA8: the hardware encodes on write and decodes on sample; see filterGraph.js createRTPool setLinear).
    function _newColorTex(w, h, cat = 'pool', lin = false) {
      const tex = trackGlResource(gl, gl.createTexture(), cat);

      R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        lin ? gl.SRGB8_ALPHA8 : gl.RGBA8,
        w,
        h,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }
    // The SourceGraphic target. Needs depth + stencil: the fill pass depth-claims and
    // stencils exactly as it does against the canvas — so this cannot come from the
    // color-only RT pool.
    // `slot` names a target that must not be shared with the transient users of the
    // unnamed one: a NESTED GROUP's accumulator lives across the whole group, and a
    // filtered child inside it takes the unnamed canvas-sized entry as its source.
    function acquireShapeRT(w, h, slot = '') {
      if (!slot.startsWith('atlas:') && _warmClamp()) {
        w = WARM_RT_PX;
        h = WARM_RT_PX;
      } // (see WARM_RT_PX; an atlas holds persistent content)
      const k = slot + w + ',' + h;
      let e = _shapeRtCache.get(k);
      _scratchUsedT = _nowMs();
      if (e) {
        e.used = _scratchUsedT;
        e.frame = R._frameSerial | 0;
        return e;
      }
      const rtCat = slot.startsWith('atlas:') ? 'atlas' : 'pool';
      const tex = _newColorTex(w, h, rtCat);
      const fbo = trackGlResource(gl, gl.createFramebuffer());
      bindFb(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const rb = trackGlResource(gl, gl.createRenderbuffer(), rtCat);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
      bindFb(gl.FRAMEBUFFER, null);
      e = { fbo, tex, rb, size: [w, h], used: _scratchUsedT, frame: R._frameSerial | 0 };
      _shapeRtCache.set(k, e);
      {
        const log = mantleDebugHook('__rtAllocLog');
        if (log && log.length < 4000)
          log.push([
            'shape:' + slot,
            w,
            h,
            (new Error().stack || '')
              .split('\n')
              .slice(2, 7)
              .map((l) =>
                l
                  .trim()
                  .replace(/^at /, '')
                  .replace(/\(.*\/(src|dist|node_modules)\//, '('),
              )
              .join(' < '),
          ]);
      } // (memory probe)
      return e;
    }
    // Idle trim of the filter scratch (memory). The RT pool, the shape targets and the ping targets keep every size they were ever asked
    // for, and a filter-heavy scene at a large canvas can hold 100+ MB of them for the life of the renderer, even after every bundle is
    // disposed. Once NO filter work has happened for `filterPoolIdleMs` (default 10 s, in
    // milliseconds so it does not depend on the frame rate; 0 disables), endFrame frees ONE idle target per frame, oldest first,
    // never one of the viewport's size class (equal to it or larger: the next filtered frame wants it) and never one used within the
    // window. A trimmed target is reallocated by the next filtered frame (on the order of a millisecond per 1536 px target; a whole
    // pool can be tens of milliseconds in that one frame), which is why the window is long and the release is gradual.
    const _nowMs = () =>
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let _scratchUsedT = 0;
    const _trimDiag = {
      calls: 0,
      freedTargets: 0,
      freedBytes: 0,
      ceilingFreedBytes: 0,
      shrunkResults: 0,
      last: 'never',
    };
    R._trimDiag = _trimDiag;
    // THE CEILING. The trim above waits for a long filter-free stretch, and nothing else gives a target back. Target sizes sit on grids (the frame's margin, the rects), so a moving shape reuses them, but a long zoom
    // still crosses sizes it will not ask for again. Past the larger of SCRATCH_CEILING_BYTES and six canvases of color + depth/stencil the targets neither of the last two frames used are freed, oldest first. A working
    // set in use is never touched, however large.
    let _scratchEnd1 = 0,
      _scratchEnd2 = 0; // when the last two frames ended
    function _scratchOverCeiling(t) {
      const before = _scratchEnd2;
      _scratchEnd2 = _scratchEnd1;
      _scratchEnd1 = t;
      const [cw, ch] = viewportSize();
      const cap = Math.max(SCRATCH_CEILING_BYTES, 6 * cw * ch * 8);
      const named = [];
      let bytes = _rtPool.bytes() + _covPool.bytes();
      for (const [k, e] of _shapeRtCache) {
        if (k.startsWith('atlas:')) continue;
        bytes += e.size[0] * e.size[1] * 8;
        named.push({ map: _shapeRtCache, k, e, n: 8 });
      }
      for (const [k, e] of _pingRtCache) {
        bytes += e.size[0] * e.size[1] * 4;
        named.push({ map: _pingRtCache, k, e, n: 4 });
      }
      if (bytes <= cap) return;
      let need = bytes - cap,
        freed = _rtPool.shrink(need, before);
      if (freed < need) freed += _covPool.shrink(need - freed, before);
      if (freed < need) {
        named.sort((p, q) => p.e.used - q.e.used);
        for (const { map, k, e, n } of named) {
          if (freed >= need || e.used >= before) break;
          deleteGlResource(gl, 'Texture', e.tex);
          deleteGlResource(gl, 'Framebuffer', e.fbo);
          if (e.rb) deleteGlResource(gl, 'Renderbuffer', e.rb);
          map.delete(k);
          freed += e.size[0] * e.size[1] * n;
        }
      }
      _trimDiag.ceilingFreedBytes += freed;
    }
    function _scratchTrim() {
      _trimDiag.calls++;
      _scratchOverCeiling(_nowMs());
      const idle = R.opts.filterPoolIdleMs === undefined ? 10000 : +R.opts.filterPoolIdleMs;
      if (!(idle > 0)) {
        _trimDiag.last = 'disabled';
        return 0;
      }
      const t = _nowMs();
      _shrinkIdleResult(t, idle);
      if (t - _scratchUsedT < idle || t - _rtPool.lastUse() < idle) {
        _trimDiag.last = 'recent-use';
        return 0;
      }
      _forgetFreeResults(true);
      const [cw, ch] = viewportSize();
      let freed = _rtPool.trim(t, idle, cw, ch);
      _trimDiag.last = freed ? 'freed-pool' : 'none-eligible';
      if (freed) {
        _trimDiag.freedTargets++;
        _trimDiag.freedBytes += freed;
        return freed;
      }
      for (const [k, e] of _shapeRtCache) {
        if (t - e.used < idle || (e.size[0] >= cw && e.size[1] >= ch)) continue;
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
        deleteGlResource(gl, 'Renderbuffer', e.rb);
        _shapeRtCache.delete(k);
        _trimDiag.freedTargets++;
        _trimDiag.freedBytes += e.size[0] * e.size[1] * 8;
        _trimDiag.last = 'freed-shape';
        return e.size[0] * e.size[1] * 8;
      }
      for (const [k, e] of _pingRtCache) {
        if (t - e.used < idle || (e.size[0] >= cw && e.size[1] >= ch)) continue;
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
        _pingRtCache.delete(k);
        _trimDiag.freedTargets++;
        _trimDiag.freedBytes += e.size[0] * e.size[1] * 4;
        _trimDiag.last = 'freed-ping';
        return e.size[0] * e.size[1] * 4;
      }
      return 0;
    }
    R._scratchTrim = _scratchTrim;
    // A same-sized scratch RT for the separable kernels to bounce through.
    // `lin`: the scratch of a blur on linear light holds linear light (a separate entry: SRGB8_ALPHA8).
    function acquirePingRT(w, h, lin = false) {
      if (_warmClamp()) {
        w = WARM_RT_PX;
        h = WARM_RT_PX;
      } // (see WARM_RT_PX)
      lin = !!lin && !!gl.SRGB8_ALPHA8;
      const k = (lin ? 'lin:' : '') + w + ',' + h;
      let e = _pingRtCache.get(k);
      _scratchUsedT = _nowMs();
      if (e) {
        e.used = _scratchUsedT;
        e.frame = R._frameSerial | 0;
        return e;
      }
      const tex = _newColorTex(w, h, 'pool', lin);
      const fbo = trackGlResource(gl, gl.createFramebuffer());
      bindFb(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      bindFb(gl.FRAMEBUFFER, null);
      e = { fbo, tex, size: [w, h], used: _scratchUsedT, frame: R._frameSerial | 0, lin };
      _pingRtCache.set(k, e);
      return e;
    }
    function ensureMainCopyTex() {
      const [cw, ch] = viewportSize();
      if (mainCopySize[0] === cw && mainCopySize[1] === ch && mainCopyTex) return;
      if (mainCopyTex) deleteGlResource(gl, 'Texture', mainCopyTex);
      mainCopyTex = trackGlResource(gl, gl.createTexture(), 'frameTargets');
      R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      mainCopySize[0] = cw;
      mainCopySize[1] = ch;
    }
    function ensureGroupBackdropTex() {
      const [cw, ch] = viewportSize();
      if (groupBackdropSize[0] === cw && groupBackdropSize[1] === ch && groupBackdropTex) return;
      if (groupBackdropTex) deleteGlResource(gl, 'Texture', groupBackdropTex);
      groupBackdropTex = trackGlResource(gl, gl.createTexture(), 'frameTargets');
      R._parkFillActiveUnit();
      gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      groupBackdropSize[0] = cw;
      groupBackdropSize[1] = ch;
    }

    // ------------------------------------------------------------
    // Render-state caches
    // ------------------------------------------------------------

    // Per-bundle state. Bare drawBundle calls keep a small resident handle LRU
    // so alternating assets do not re-upload their cover meshes every frame.
    // The public createBundleHandle surface remains the unbounded explicit
    // option for multi-bundle scenes.
    //
    // Fields:
    //   bundle:                 the createBundle() output bound to this handle
    //   maskRegions:            computed once per handle
    //   maskRowToLayerCpu:      Int32Array(numShapes); -1 = no region
    //   maskRowToLayerTex:      R32I texture mirroring CPU array
    //   maskRowToLayerTexSize:  tracks reallocation
    //   hybridMeshDirty:        true until the bundle's cover quads have
    //                           been uploaded to the handle's
    //                           triBuf/shapeIdxBuf. Cleared after first
    //                           upload; stays cleared for same-bundle
    //                           re-binds (only a bundle._geomGen bump —
    //                           a geometry rewrite — re-flags it).
    //   _handle.fillPassAssetDirty:     forces the next beginFillPass to rebind
    //                           the bundle's texture units + uniforms.
    //                           Set on first bind + any intervening pass
    //                           that mutates global state (filter graphs,
    //                           mask bake, group composite, cache blit).
    //   dispose():              releases the per-handle R32I texture
    //   invalidate():           bumps generation + flags for re-bind
    //                           (consumed by the static-scene cache too)
    //   generation:             counter bumped on invalidate()
    let _handle = null;
    // The transient handles setBundle makes for a bare bundle (drawBundle, drawInstance, render(bundle), the per-instance loop of
    // drawBundleInstanced), least recently bound first. MAX_TRANSIENT_HANDLES bounds the IDLE ones: a handle bound in this frame or
    // the one before it is not evicted by the bound, or a scene that draws more distinct bundles per frame than the bound would
    // evict each handle before its next draw and re-create it, re-uploading its cover mesh, every frame. Such a working set keeps
    // its handles while it is drawn and gives them back two frames after it shrinks (R._transientTrim at endFrame); the memory
    // budget may free any handle the current frame has not bound (R._memEvictTransientHandles). A handle's `_wsFrame` is the last
    // frame that bound it (-1 for one bound only outside a beginFrame / endFrame pair, by a loading call or a frameless draw: the
    // bound alone keeps it; the pipeline warm of beginFrame's tick, one bundle a frame, binds inside the pair) and `_wsTime` the
    // time it was last bound before any frame ran. Neither the bound nor the budget evicts the bound handle or `_boundTransient`,
    // the transient handle bound last, which a caller drawing a mount in between restores.
    const _transientHandles = new Map();
    const MAX_TRANSIENT_HANDLES = 8;
    let _boundTransient = null;
    // fillPass* and viewport cache stay on the renderer (truly shared
    // across handles within one frame).
    let fillPassCanvasW = 0,
      fillPassCanvasH = 0;
    // The handle whose textures + uniforms are CURRENTLY bound on the
    // fill pass. Compared against _handle inside beginFillPass to
    // detect a handle switch (multi-handle pattern) and force
    // a rebind. Per-handle `fillPassAssetDirty` only tells us "MY
    // textures aren't bound yet"; this tells us "different handle's
    // textures are still bound from the previous draw."
    let _lastFillPassHandle = null;
    // Per-draw state — set by drawBundle()/setBundle()/handle.draw(), consumed by
    // beginFillPass, reset between draws. One live object (exposed as R.draw),
    // mutated in place, so every module sees the current values by reference.
    const _ds = {
      overrides: null, // createOverrideTable handle, or null
      worldM: null, // Float32Array(9) column-major mat3, or null
      alpha: 1.0, // opts.alpha opacity multiplier; 1.0 = none
      colorMatrix: null, // Float32Array(16) mat4 dual-tint recolor, or null
      colorMatrixOffset: null, // Float32Array(4), or null
      extClipTex: null, // setNodeClip coverage WebGLTexture, or null
      extClipMode: 0, // 0=off, 1=clip-IN, 2=clip-OUT
      palette: null, // createPalette handle (.texture/.size), or null
      paletteChannel: 0, // 0=R, 1=G, 2=B, 3=A
      channelLerp: null, // { primary, contrast, highlight }, or null
      shapeRange: null, // [firstRow,lastRow] sprite subset, or null
      spriteNonContig: false, // that subset's shapes are NOT a contiguous run → analytic slice unsafe
      spriteKey: null, // sprite id of the active subset draw, or null
    };
    // Filter-pass scissoring on/off (default on). Internal toggle used by
    // the render-diff smoke to prove scissored == full-canvas byte-identical;
    // no public surface.
    // Loop-Blinn fill mode DEFAULT, and the only place these three are initialized:
    // ONE mode governs the whole analytic fill path — static, streamed, AND morph —
    // mirroring Slug's single always-available fill path. 'off' · 'auto' (DEFAULT) ·
    // 'on'. There is no separate morph toggle: "static vs morph" is not a real axis
    // (klmn-source + batching are, both handled by the shared unified draw), so a
    // split flag would only let the two drift apart — and a second default written
    // elsewhere would be the same drift by another name.
    //
    // setLoopBlinnFill is the only other writer, and
    // leaving these unset would create a third, unintended state: undefined passes every
    // `!== 'off'` test (so the LB path is attempted) while failing every `=== 'auto'`
    // test (so none of the perf gates apply).
    //
    // The reason is CORRECTNESS, not speed. _lbSlugFallback is falsy when
    // unset, and drawDispatch reads `if (R._lbSlugFallback) render()` — the LB-only
    // semantic, where an ineligible shape draws nothing instead of falling back to
    // Slug. An unconfigured renderer would carry that on those paths.
    //
    R._lbFillMode = 'auto';
    // ...but nobody has SELECTED it. The per-shape build gate keys on the selection, not the value;
    // see setLoopBlinnFill.
    R._lbAutoExplicit = false;
    R._lbSlugOnly = false;
    R._lbSlugFallback = true;
    R._renderCover = () => render(); // the live cover draw, for the row gate's cover run (aacPointsDraw.js)
    let _filterBboxEnabled = true;
    // drawBundleInstanced GPU fast path on/off (default on). Internal toggle
    // so the render-diff smoke can compare the instanced draw against the
    // per-instance render() loop.
    let _instancedFastEnabled = true;
    // Frame lifecycle: begin/end gates the swap chain present.
    // `_inFrame` blocks per-call clears; null = legacy `render()` mode.
    let _inFrame = false;
    // SVG-export frame recorder. While capture is on, each draw between
    // beginFrame/endFrame appends a lightweight entry (bundle ref + the
    // forwarded draw options — references + scalars, NO geometry copy) to
    // _frameLog; exportFrameSVG() replays it on the native backend.
    //
    // Defaults OFF: export instrumentation must not run in the render loop
    // unless requested. Even though each entry is light, recording allocates
    // a record object per bundle draw per frame AND disables drawBundle-
    // Instanced's fast path while active — pure per-frame garbage for the
    // (common) consumer that never exports. Export tools opt in with
    // rendererOpts.captureFrames:true or R.setFrameCapture(true) before the
    // frame they want to export; exportFrameSVG() throws a guiding error if
    // capture was never enabled. _lastFrameClearColor survives endFrame
    // (which nulls _frameClearColor) so the export reproduces the clear.
    let _captureFrames = opts.captureFrames === true;
    let _frameLog = [];
    let _lastFrameClearColor = null;
    // Resolution scale (setResolutionScale). 1 = native backing store.
    R._resScale = 1;
    R._resDpr = null;
    R._lastSeenW = 0;
    R._lastSeenH = 0;
    // Explicit viewport (setViewport). null = auto from gl.canvas.
    let _explicitViewport = null;
    // User-set scissor rect. null = no scissor; otherwise
    // [x, y, w, h] in drawingBuffer pixels (origin lower-left).
    // Applies to default-framebuffer draws only; offscreen RT passes
    // (shape/ping/sharp/mask/pool/etc.) bypass it via bindFb().
    let _scissor = null;
    // A pipeline warm's scissor ([x, y, w, h]), or null: set only while _warmBundlePso draws, and
    // applied to every target -- see _targetScissor.
    R._warmScissor = null;
    // Per-frame coalescing state (drawList walker).
    const _groupStack = [];
    let _groupBaseTarget = null;
    R._withGroupTarget = (target, work) => {
      R._atlasFlush();
      const saved = _groupStack.splice(0),
        base = _groupBaseTarget;
      _groupBaseTarget = target;
      try {
        return work();
      } finally {
        R._groupUnwind(0, false);
        _groupBaseTarget = base;
        _groupStack.push(...saved);
      }
    };

    /// GROUP ATLAS. A run of small plain groups -- a faded fill+stroke leaf after another, or the layers
    /// of a faded instance grid -- would otherwise pay a render-pass pair each: bind an accumulator, clear it, draw the group, then bind the
    /// canvas and composite it. On a tile-based GPU a pass switch is the cost (about 0.12 ms), not the fragments. The atlas gives
    /// every group of the run its own SLOT of ONE shared accumulator: the group draws into its slot through a viewport shifted
    /// to the slot (canvas pixel (x, y) lands on atlas texel (x + vx, y + vy), the sub-rect-target arrangement of a filtered shape,
    /// R._fragOrigin, kept for the whole group), and its composite is DEFERRED. When the run ends the canvas is bound once and
    /// every slot is composited in painter order by the same cache-blit program a group uses (a slot's texels are sampled at the
    /// pixel centers, so the picture is the group's own). Two passes for the run instead of two per group.
    ///
    /// Only groups whose content is pure fill-pass work take a slot: leaf rows with no filter, blend mode, clip, mask, image,
    /// COLR graph or nested group, at depth 0, outside cache baking, scissors and group-alpha draws. Anything else, a slot
    /// that does not fit, or a run of one, takes the ordinary accumulator (R._groupBegin below), so a bundle never gets a
    /// different picture. A deferred composite is flushed by the first thing that needs the canvas: the next ordinary group, a canvas
    /// bind (bindFb), the end of the draw walk.
    const _atlasGutter = 2;
    const _atlasLeafPure = (m, st, op) => {
      if (
        op.kind !== 'fillShape' ||
        op.filterId ||
        op.filterGraphId ||
        op.colrGraphId ||
        op.resource ||
        (op.blendMode | 0) > 0
      )
        return false;
      const o = (op.shapeIdx | 0) * st;
      // meta texel 7 (.z clip, .w mask), texel 8 (.x filter, .y blend, .w image id)
      return !(
        Math.floor(m[o + 30] + 0.5) !== 0 ||
        Math.floor(m[o + 31] + 0.5) !== 0 ||
        Math.floor(m[o + 32] + 0.5) !== 0 ||
        Math.floor(m[o + 33] + 0.5) !== 0 ||
        (st >= 36 && Math.floor(m[o + 35] + 0.5) !== 0)
      );
    };
    /// Are these ops (a draw's whole leaf list or sprite subset) fill-pass work only? Used by the draw-alpha entries.
    R._atlasOpsPure = (bundle, ops) => {
      const m = bundle && bundle.metaFloats,
        st = bundle ? bundle.metaFloatsPerShape | 0 : 0;
      if (!m || st < 32 || !ops || !ops.length || bundle._nineSliceActive) return false;
      for (let i = 0; i < ops.length; i++) if (!_atlasLeafPure(m, st, ops[i])) return false;
      return true;
    };
    /// The bundle's top-level groups that can take a slot and sit in a run (two or more groups, each ending where the next begins):
    /// Map(groupBegin op -> { next }) where `next` says another slot group follows at once. Cached on the bundle per draw list.
    function _atlasMarks(b) {
      const dl = b.drawList;
      let c = b._atlasMarks;
      if (c && c.dl === dl && c.n === dl.length) return c.map;
      const map = new Map();
      const m = b.metaFloats,
        st = b.metaFloatsPerShape | 0;
      if (dl && m && st >= 32 && !b._nineSliceActive) {
        let run = [];
        const closeRun = () => {
          if (run.length > 1) {
            const r = { groups: run, plan: null };
            for (let k = 0; k < run.length; k++)
              map.set(run[k].op, { next: k + 1 < run.length, run: r, k });
          }
          run = [];
        };
        for (let i = 0; i < dl.length;) {
          const op = dl[i];
          if (op.kind !== 'groupBegin') {
            closeRun();
            i++;
            continue;
          }
          let depth = 1,
            j = i + 1,
            ok = !(op.filterId || op.clipId || op.maskId || (op.blendMode | 0) !== 0);
          if (ok) {
            const o = (op.shapeIdx | 0) * st;
            if (op.shapeIdx >= 0 && (m[o + 30] > 0 || m[o + 31] > 0)) ok = false;
          }
          let leaves = 0;
          const body = [];
          for (; j < dl.length; j++) {
            const q = dl[j];
            if (q.kind === 'groupBegin') {
              depth++;
              ok = false;
              continue;
            }
            if (q.kind === 'groupEnd') {
              if (--depth === 0) break;
              continue;
            }
            leaves++;
            body.push(q);
            if (!_atlasLeafPure(m, st, q)) ok = false;
          }
          if (j >= dl.length) {
            closeRun();
            break;
          }
          if (ok && leaves > 0) run.push({ op, body });
          else closeRun();
          i = j + 1;
        }
        closeRun();
      }
      b._atlasMarks = { dl, n: dl ? dl.length : 0, map };
      return map;
    }
    /// A RUN OF GROUP COMPOSITES IN ONE DRAW. The group atlas and a merged run composite N rects of one texture, each at its own tint,
    /// in painter order; the rects differ only in destination, source map and tint, so they are the N instances of one
    /// drawArraysInstanced (cacheBlitInstanced.vert; the instances rasterize and blend in order, so overlapping rects land as N draws did).
    /// `items` is a flat Float32Array of 12 floats per composite: rect (GL px x, y, w, h), uInMap (4), tint (4). The caller has bound the
    /// framebuffer, the cache-blit state (blend, no depth/stencil/scissor) and the source texture on unit 0; returns false when the
    /// instanced program is absent (the caller then draws the quads one at a time).
    const _ci = {
      prog: undefined,
      vao: null,
      buf: null,
      cap: 0,
      uView: null,
      uTex: null,
      uCh: null,
    };
    function _compositeInstancedReady() {
      if (_ci.vao) return true;
      const S = R.shaderSources;
      if (_ci.prog === undefined) {
        _ci.prog = null;
        if (!S.cacheBlitInstancedVert || !S.cacheBlitFrag || !R.maskBakeBuf) return false;
        _ci.prog = R.program(
          S.cacheBlitInstancedVert,
          S.cacheBlitFrag.replace(/^(\s*#version[^\n]*\n)/, '$1#define CB_INSTANCED 1\n'),
          'cacheBlitInstanced',
        );
      }
      if (!_ci.prog) return false;
      // The caller draws the quads one at a time until the driver has finished the program; asking it anything sooner would wait.
      if (R._khrParallel && !gl.getProgramParameter(_ci.prog, R._khrParallel.COMPLETION_STATUS_KHR))
        return false;
      _ci.uView = gl.getUniformLocation(_ci.prog, 'uViewport');
      _ci.uTex = gl.getUniformLocation(_ci.prog, 'uCacheTex');
      _ci.uCh = gl.getUniformLocation(_ci.prog, 'uOutputChannel');
      _ci.vao = trackGlResource(gl, gl.createVertexArray());
      _ci.buf = trackGlResource(gl, gl.createBuffer());
      R.glBindVertexArray(_ci.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, R.maskBakeBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, _ci.buf);
      for (let a = 1; a <= 3; a++) {
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 48, (a - 1) * 16);
        gl.vertexAttribDivisor(a, 1);
      }
      R.glBindVertexArray(null);
      return true;
    }
    function _compositeInstanced(items, n, cw, ch) {
      if (n < 2 || mantleDebugFlag('noInstancedComposite') || !_compositeInstancedReady())
        return false;
      R.glUseProgram(_ci.prog);
      gl.uniform2f(_ci.uView, cw, ch);
      gl.uniform1i(_ci.uTex, 0);
      gl.uniform1i(_ci.uCh, 0);
      R.glViewport(0, 0, cw, ch);
      R.glBindVertexArray(_ci.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, _ci.buf);
      if (n > _ci.cap) {
        _ci.cap = Math.max(n, _ci.cap * 2, 64);
        gl.bufferData(gl.ARRAY_BUFFER, _ci.cap * 48, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, items.subarray(0, n * 12));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      R.glBindVertexArray(null);
      R._compositeDraws = (R._compositeDraws | 0) + 1;
      return true;
    }
    let _ciItems = new Float32Array(12 * 64);
    const _ciRoom = (n) => {
      if (_ciItems.length < n * 12)
        _ciItems = new Float32Array(Math.max(n, _ciItems.length / 6) * 12);
      return _ciItems;
    };
    /// THE LOADING CALL'S SIDE OF IT (fillPass warmAuxPipelines): the program, started if it is not, or null where no run can draw it...
    R._compositeWarmStart = () => {
      if (mantleDebugFlag('noInstancedComposite')) return null;
      if (_ci.prog === undefined) _compositeInstancedReady();
      return _ci.prog || null;
    };
    /// ...and one draw of it on the bound target under a run's state: two one-pixel composites at zero tint, which leave ONE, ONE_MINUS_SRC_ALPHA's destination as it is. False until the program is complete.
    R._compositeWarmDraw = (cw, ch) => {
      const items = _ciRoom(2);
      items.fill(0, 0, 24);
      items[2] = items[3] = items[14] = items[15] = 1;
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dummyGradientStops);
      return _compositeInstanced(items, 2, cw, ch);
    };
    /// Draw `n` composites (12 floats each, see _compositeInstanced) with the cache-blit state and source texture already bound: one
    /// instanced draw, or one quad each when the instanced program is absent.
    function _compositeItems(items, n, cw, ch) {
      if (_compositeInstanced(items, n, cw, ch)) return;
      R.glBindVertexArray(coverVao);
      for (let i = 0, k = 0; i < n; i++, k += 12) {
        R.glViewport(items[k], items[k + 1], items[k + 2], items[k + 3]);
        gl.uniform4f(R.cbUTint, items[k + 8], items[k + 9], items[k + 10], items[k + 11]);
        if (R.cbUInMap)
          gl.uniform4f(R.cbUInMap, items[k + 4], items[k + 5], items[k + 6], items[k + 7]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        R._compositeDraws = (R._compositeDraws | 0) + 1;
      }
      R.glBindVertexArray(null);
    }
    function _atlasShiftOn(vx, vy) {
      if (!_atlas.baseViewport) _atlas.baseViewport = R.glViewport;
      const base = _atlas.baseViewport;
      _atlas.shift = [vx, vy];
      R.glViewport = (x, y, w, h) => base(x + vx, y + vy, w, h);
      R._atlasFragOrigin = [-vx, -vy]; // the canvas position of the bound target's origin (the fill shader's uFragOrigin)
    }
    function _atlasShiftOff() {
      if (_atlas.baseViewport) R.glViewport = _atlas.baseViewport;
      _atlas.shift = null;
      R._atlasFragOrigin = null;
    }
    /// Try to open `op` as a slot of the atlas; false = take the ordinary accumulator. `mk` = { next } from the marks, or from a
    /// draw-alpha caller that decided the run itself.
    function _atlasDynamicOk() {
      if (R.opts.groupAtlas === false || !R.cacheBlitProg || !_handle || !_handle.bundle)
        return false;
      if (
        _groupStack.length ||
        _groupBaseTarget ||
        _alphaRedirect !== null ||
        R._cacheBakingNow ||
        _scissor ||
        R._warmScissor
      )
        return false;
      // Changing resource bindings require ordinary group isolation.
      if (_handle.bundle._morphSrc?.bindingSteps?.length) return false;
      return !(R._captureFrames && R._inFrame);
    }
    R._atlasTryBegin = (op, gOps, mk) => {
      if (!mk || !_atlasDynamicOk()) return false;
      const [cw, ch] = viewportSize();
      if (!(cw >= 1) || !(ch >= 1)) return false;
      const rect =
        op.rectPx !== undefined
          ? op.rectPx
          : (gOps || op.shapeIdx === -1) && !mantleDebugFlag('noGroupRect')
            ? _tightGlRectOf(op, gOps || null, cw, ch) || R._contentRectPx(cw, ch, gOps || null)
            : null;
      const gr = rect || [0, 0, cw, ch];
      const w = gr[2],
        h = gr[3];
      if (!(w >= 1) || !(h >= 1)) return false;
      if (_atlas.maxTex === 0) {
        let t = 0;
        try {
          t = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
        } catch {
          /* fixed below */
        }
        _atlas.maxTex = t > 0 ? t : 2048;
      }
      const size = Math.min(_atlas.maxTex, Math.max(cw, ch) <= 1024 ? 2048 : 4096);
      if (w + _atlasGutter > size || h + _atlasGutter + 1 > size) return false;
      if (_atlas.rt && _atlas.size !== size) {
        R._atlasFlush();
        _atlas.rt = null;
        _atlas.shelves.length = 0;
        _atlas.shelfEnd = 0;
      }
      // The scene memory budget: the atlas target is optional (a group can take its own, canvas-sized accumulator, as with groupAtlas:false); a
      // budget that cannot hold it (2048 x 2048 RGBA8 + depth/stencil = 32 MiB at small canvases) sends the group to that accumulator.
      if (
        !_shapeRtCache.has('atlas:' + size + ',' + size) &&
        R._memAdmit &&
        !R._memAdmit(size * size * 8, 'group atlas')
      )
        return false;
      let slot = _atlasPlace(size, gr);
      if (!slot && _atlas.pend.length) {
        R._atlasFlush();
        slot = _atlasPlace(size, gr);
      }
      if (!slot) return false;
      // A run's FIRST slot clears the whole atlas once (a pass-start clear costs nothing on a tile-based GPU) and re-announces the texture
      // units; the slots that follow find clean texels and the bindings the last one left, and pay only their viewport and scissor.
      const cont = _atlas.held && _atlas.pend.length > 0;
      _atlas.held = false;
      if (!cont) R._atlasRunMemo = {};
      const rt = acquireShapeRT(size, size, 'atlas:');
      _atlas.rt = rt;
      _atlas.size = size;
      const vx = slot.x - gr[0],
        vy = slot.y - gr[1];
      slot.rx = gr[0];
      slot.ry = gr[1];
      slot.w = w;
      slot.h = h;
      slot.size = size;
      if (R._boundDrawFbo !== rt.fbo || !cont) bindFb(gl.FRAMEBUFFER, rt.fbo);
      _atlasShiftOn(vx, vy);
      if (!cont) {
        R.glDisable(gl.SCISSOR_TEST);
        R.glDepthMask(true);
        gl.stencilMask(0xff);
        gl.clearColor(0, 0, 0, 0);
        gl.clearStencil(0);
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        R.glDepthMask(false);
        R._forgetFillUnits();
        _handle.fillPassAssetDirty = true;
      }
      R.glViewport(0, 0, cw, ch);
      gl.scissor(slot.x, slot.y, w, h);
      R.glEnable(gl.SCISSOR_TEST);
      const now = _groupOpacityNow(op),
        opacity = isFinite(now) ? Math.min(1, Math.max(0, now)) : 1;
      _groupStack.push({
        opacity,
        filterId: 0,
        effectRow: -1,
        savedAlpha: null,
        shapeIdx: op.shapeIdx,
        bundle: _handle.bundle,
        gOps,
        uniDraws0: R._unifiedFillDraws | 0,
        def0: R._deferTotal(),
        blendMode: 0,
        isolation: op.isolation,
        rect,
        acc: { fbo: rt.fbo, tex: rt.tex },
        over: true,
        frame: null,
        atlas: slot,
        defer: !!mk.next,
      });
      _atlas.open = true;
      R._atlasSlots = (R._atlasSlots | 0) + 1;
      return true;
    };
    /// A slot for a w x h rect whose canvas origin is (gr[0], gr[1]): shelves of the atlas, the slot's origin matching the rect origin's
    /// parity (the shift is then even and the 2x2 derivative quads of the atlas are the canvas's own).
    function _atlasPlace(size, gr) {
      const w = gr[2],
        h = gr[3],
        px = gr[0] & 1,
        py = gr[1] & 1;
      for (const sh of _atlas.shelves) {
        const x = sh.x + ((sh.x - px) & 1 ? 1 : 0),
          y = sh.y + ((sh.y - py) & 1 ? 1 : 0);
        if (x + w <= size && y + h <= sh.y + sh.h) {
          sh.x = x + w + _atlasGutter;
          return { x, y };
        }
      }
      const y0 = _atlas.shelfEnd,
        sh = { y: y0, h: h + _atlasGutter + 1, x: 0 };
      if (y0 + sh.h > size) return null;
      _atlas.shelfEnd = y0 + sh.h;
      _atlas.shelves.push(sh);
      const x = (sh.x - px) & 1 ? 1 : 0,
        y = y0 + ((y0 - py) & 1 ? 1 : 0);
      if (x + w > size || y + h > y0 + sh.h) return null;
      sh.x = x + w + _atlasGutter;
      return { x, y };
    }
    /// The group closes: its composite is queued; a run's last group (or any group not followed at once by another slot) lands the run.
    function _atlasGroupEnd(grp) {
      _atlas.open = false;
      _atlasShiftOff();
      R.glDisable(gl.SCISSOR_TEST);
      const s = grp.atlas;
      if (grp.savedAlpha !== null && grp.savedAlpha !== undefined) R.draw.alpha = grp.savedAlpha; // a draw-alpha group puts the draw's alpha back
      _atlas.pend.push({ s, o: grp.opacity });
      _atlas.held = true;
      if (!grp.defer) R._atlasFlush();
      return true;
    }
    /// A draw that threw between a slot's begin and end leaves the shifted viewport, the scissor and queued composites behind. Every frame and
    /// draw entry calls this first, so the next draw starts on the canvas as always; nothing is queued across a healthy entry.
    R._atlasReset = () => {
      _merge = null;
      _atlas.open = false;
      R._atlasRunMemo = null;
      if (!_atlas.shift && !_atlas.held && !_atlas.pend.length) return;
      _atlasShiftOff();
      R.glDisable(gl.SCISSOR_TEST);
      _atlas.pend = [];
      _atlas.held = false;
      _atlas.shelves.length = 0;
      _atlas.shelfEnd = 0;
    };
    /// Composite every queued slot, in order, into the canvas; reset the packer.
    R._atlasFlush = () => {
      // (a slot is open: the draw walks inside it -- a per-instance loop's render() -- end with a flush of their own, which is not the run's end)
      if (_atlas.flushing || _atlas.open) return;
      const pend = _atlas.pend;
      if (!pend.length) {
        _atlas.held = false;
        _atlas.shelves.length = 0;
        _atlas.shelfEnd = 0;
        R._atlasRunMemo = null;
        return;
      }
      _atlas.flushing = true;
      R._atlasRunMemo = null;
      try {
        _atlas.pend = [];
        _atlas.held = false;
        _atlasShiftOff();
        R.endFillPass();
        const [cw, ch] = viewportSize();
        const tex = _atlas.rt.tex,
          size = _atlas.size;
        bindFb(gl.FRAMEBUFFER, null);
        R.glDisable(gl.DEPTH_TEST);
        R.glDisable(gl.STENCIL_TEST);
        R.glDisable(gl.SCISSOR_TEST);
        R.glEnable(gl.BLEND);
        R.glBlendEquation(gl.FUNC_ADD);
        R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        R.glUseProgram(R.cacheBlitProg);
        R._forgetFillUnits();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(R.cbUCacheTex, 0);
        const items = _ciRoom(pend.length);
        for (let i = 0, k = 0; i < pend.length; i++, k += 12) {
          const s = pend[i].s,
            o = pend[i].o;
          items[k] = s.rx;
          items[k + 1] = s.ry;
          items[k + 2] = s.w;
          items[k + 3] = s.h;
          items[k + 4] = s.w / size;
          items[k + 5] = s.h / size;
          items[k + 6] = s.x / size;
          items[k + 7] = s.y / size;
          items[k + 8] = o;
          items[k + 9] = o;
          items[k + 10] = o;
          items[k + 11] = o;
        }
        _compositeItems(items, pend.length, cw, ch);
        _atlas.shelves.length = 0;
        _atlas.shelfEnd = 0;
        R._atlasComposites = (R._atlasComposites | 0) + pend.length;
        R._atlasPasses = (R._atlasPasses | 0) + 1;
        if (_handle) _handle.fillPassAssetDirty = true;
      } finally {
        _atlas.flushing = false;
      }
    };

    /// Interpolate opacity for matched morph groups; unmatched groups keep their authored opacity.
    function _groupOpacityNow(op) {
      const ms = _handle.bundle && _handle.bundle._morphSrc;
      const shapeIdx = op.shapeIdx;
      if (
        ms &&
        Number.isInteger(shapeIdx) &&
        ms.mergedMetaF32 &&
        ms.dstMetaF32 &&
        (!ms.matchedSrcIdxs ||
          (ms.matchedSrcSet
            ? ms.matchedSrcSet.has(shapeIdx)
            : Array.prototype.indexOf.call(ms.matchedSrcIdxs, shapeIdx) >= 0))
      ) {
        const a = shapeIdx * (ms.metaStride | 0) + 7,
          t = +ms.t || 0;
        if (a >= 7 && a < ms.mergedMetaF32.length && a < ms.dstMetaF32.length)
          return ms.mergedMetaF32[a] * (1 - t) + ms.dstMetaF32[a] * t;
      }
      return op.opacity;
    }

    /// GROUP ISOLATION, extracted so more than one route can perform it.

    /// `gOps` is the group's child ops, used only to bound the accumulator to what
    /// the group actually paints. Each caller knows its own position in the list,
    /// so it does that walk itself and passes the result.
    /// Returns true when the group's cached filter result stands in for its children: the caller then steps over every op up to the
    /// matching groupEnd (R._groupEnd composites the cached result) instead of drawing them.
    R._groupBegin = (op, gOps) => {
      // A plain group in a run takes a slot of the shared atlas (R._atlasTryBegin) -- or, when the whole run is disjoint, the run shares
      // ONE accumulator and one batched draw (_mergePlan); otherwise any deferred composites land first.
      const mk =
        op.atlasRun ||
        (_handle && _handle.bundle && _handle.bundle.drawList
          ? _atlasMarks(_handle.bundle).get(op)
          : undefined);
      if (mk) {
        if (mk.run && mk.k === 0 && !_merge) {
          const plan = _mergePlan(mk);
          if (plan) {
            _mergeBegin(op, plan, mk);
            return;
          }
        }
        if (R._atlasTryBegin(op, gOps, mk)) return;
      }
      if (_atlas.held || _atlas.pend.length) R._atlasFlush();
      return _groupBeginOrdinary(op, gOps) === true;
    };
    function _groupBeginOrdinary(op, gOps) {
      // A filtered group whose children cross the canvas edge filters in a FRAME (filterFrame.js), as a filtered shape does: the
      // children paint into an accumulator of the frame's size and the group's graph runs over all of it. A group with a blend mode
      // is framed too: its backdrop is snapshotted at the canvas, before the frame opens, and the composite reads it by canvas pixel
      // (R._groupEnd). The frame is the group's coordinate system, so a mask on a child is re-laid at frame size (R._filterFrameForGroup).
      let frame = null;
      let snapped = false; // the canvas backdrop of an outermost non-normal group is already in mainCopyTex
      // A cached result whose key matches settles the frame too (it is part of the key: an entry stored without a frame matches only
      // a group that would again have none), so a group served from the cache never asks for one.
      const hit =
        op.filterId && gOps && _groupOverBlit(op)
          ? _groupFilterHit(op, gOps, ...viewportSize())
          : null;
      if (op.filterId && !hit) {
        const [vw, vh] = viewportSize();
        const g = _handle.bundle.filterGraphs && _handle.bundle.filterGraphs[op.filterId - 1];
        frame = g ? R._filterFrameForGroup(op, vw, vh, g) : null;
        if (frame) {
          if (!_groupOverBlit(op) && _groupStack.length === 0 && !_groupBaseTarget) {
            ensureMainCopyTex();
            bindFb(gl.FRAMEBUFFER, null);
            R._parkFillActiveUnit();
            gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, vw, vh);
            snapped = true;
          }
          frame.group = true;
          R._enterFilterFrame(frame);
        }
      }
      const [cw, ch] = viewportSize();
      const _gOps = gOps;

      let opacity = _groupOpacityNow(op);
      const shapeIdx = op.shapeIdx;
      const savedAlpha = op.filterId ? R.draw.alpha : null;
      if (savedAlpha !== null) {
        opacity *= savedAlpha;
        R.draw.alpha = 1;
        const ov = R.draw.overrides?.packedBuffer,
          i = shapeIdx * 24;
        if (ov && i >= 0 && i + 11 < ov.length)
          opacity *= Math.max(0, Math.min(1, ov[i + 6])) * ov[i + 11];
      }
      if (hit) {
        const top =
          _groupStack.length > 0
            ? _groupStack[_groupStack.length - 1].acc
            : { fbo: _groupBaseTarget };
        _groupStack.push({
          opacity,
          filterId: op.filterId,
          effectRow: -1,
          savedAlpha,
          shapeIdx: op.shapeIdx,
          bundle: _handle.bundle,
          gOps,
          uniDraws0: R._unifiedFillDraws | 0,
          def0: R._deferTotal(),
          blendMode: op.blendMode,
          isolation: op.isolation,
          rect: null,
          acc: top,
          over: true,
          frame: null,
          skip: hit,
        });
        R._groupFilterSkips = (R._groupFilterSkips | 0) + 1;
        return true;
      }
      const depth = _groupStack.length;
      // Normal groups use fixed-function premultiplied source-over. Other blend
      // modes need a backdrop snapshot retained until the group composite.
      const over = _groupOverBlit(op);
      // The canvas-sized shapeFbo is the accumulator of an outermost group only. A frame sets the viewport to its own size, so asking for it there (a plain group nested in a framed
      // one) re-sized it under the outer group still drawing into it, deleting that group's target. A nested group or a framed one takes a pooled target of the current size.
      let acc;
      if (depth > 0 || _groupBaseTarget || frame) {
        const e = acquireShapeRT(
          cw,
          ch,
          (_groupBaseTarget ? 'resource-group' : frame ? 'frame-group' : 'group') + depth + ':',
        );
        acc = { fbo: e.fbo, tex: e.tex };
      } else {
        ensureShapeFbo();
        acc = { fbo: shapeFbo, tex: shapeFboTex };
        if (!over) ensureMainCopyTex();
      }
      // Bound ordinary groups to their painted content. Filtered groups need
      // generated output and child-filter extents; unsafe bounds use the canvas.
      // A masked group is bounded like any other: its mask only removes what its members painted, so the accumulator, the
      // masked copy and the composite all stay inside the painted rect. By SCISSOR, with the canvas-sized viewport and the identity
      // map: a rect viewport samples the accumulator through a remapped coordinate, which is off by a float rounding and moved 43
      // pixels of the icebergy scene by one byte (the bilinear fetch's 8-bit weight). A blend-mode group composites by that remap, so
      // it stays unbounded.
      const effectRow = _groupEffectRow(op);
      const grpRect =
        op.rectPx !== undefined
          ? op.rectPx
          : !op.filterId && (effectRow < 0 || over) && _gOps && !mantleDebugFlag('noGroupRect')
            ? R._contentRectPx(cw, ch, _gOps)
            : null;

      if (depth === 0 && !_groupBaseTarget && !over && !snapped) {
        bindFb(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
        // Snapshot only the region groupEnd will read back. mainCopyTex is canvas-sized
        // and the copy lands at the same coordinates, so the rest of it stays stale —
        // which is fine precisely because groupEnd only samples inside the rect.
        if (grpRect)
          gl.copyTexSubImage2D(
            gl.TEXTURE_2D,
            0,
            grpRect[0],
            grpRect[1],
            grpRect[0],
            grpRect[1],
            grpRect[2],
            grpRect[3],
          );
        else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
      }
      // That bind lands on whatever unit is ACTIVE, behind the fill pass's unit shadow. Announce it, as groupEnd does:
      // after a unified draw that is unit 0, and the group's cover quads would then sample this snapshot as uCurveData.
      R._forgetFillUnits();
      _handle.fillPassAssetDirty = true;
      bindFb(gl.FRAMEBUFFER, acc.fbo);
      R.glViewport(0, 0, cw, ch);
      R.glDepthMask(true);
      gl.stencilMask(0xff);
      gl.clearColor(0, 0, 0, 0);
      gl.clearStencil(0);
      gl.clearDepth(1.0);
      // Clear only the rect. Outside it the accumulator keeps whatever a previous group
      // left — harmless, because nothing writes there and groupEnd never reads there.
      if (grpRect) _pushLocalScissor(grpRect, acc.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (grpRect) _applyTargetScissor(acc.fbo);
      R.glDepthMask(false);
      _groupStack.push({
        opacity,
        filterId: op.filterId || 0,
        effectRow,
        savedAlpha,
        shapeIdx: op.shapeIdx,
        bundle: _handle.bundle,
        gOps: _gOps,
        uniDraws0: R._unifiedFillDraws | 0,
        def0: R._deferTotal(),
        blendMode: op.blendMode,
        isolation: op.isolation,
        rect: grpRect,
        acc,
        over,
        frame,
      });
    }
    /// A MERGED RUN: consecutive plain groups whose painted rects are pairwise disjoint (the 2 px antialiasing reach
    /// included) share ONE accumulator and ONE batched draw, and their composites are N quads of one pass. No pixel belongs to two
    /// groups, so painting every group's leaves into the same accumulator and fading each rect by its own group's opacity is the
    /// picture of N accumulators -- the same rects, the same texels, the same cache-blit -- without N passes and without N broken draw
    /// batches. The routes skip the brackets inside the run (R._mergeSkip), so the leaves of all groups reach one draw call.
    /// A run with an overlap, or a group that cannot take it, falls to the atlas slots (R._atlasTryBegin) and then to ordinary accumulators.
    let _merge = null; // { skip }: the inner brackets of the open merged run the routes still have to step over
    R._mergeSkip = () => {
      if (_merge === null || !(_merge.skip > 0)) return false;
      _merge.skip--;
      return true;
    };
    /// The GL rect (origin bottom-left, even origin, clipped to the canvas) one group's leaves can paint in: the union of their exact boxes
    /// (R._shapeBboxPx at ink reach) plus the 2 px antialiasing reach -- tight, where R._contentRectPx quantizes to 128 px. null = unbounded
    /// or unknown (the callers then keep the generous rect or the ordinary accumulator).
    const _tightScratch = [0, 0, 0, 0];
    function _tightGlRect(ops, cw, ch) {
      const list = ops || (_handle.bundle && _handle.bundle.drawList);
      if (!list || !list.length || _handle.bundle._nineSliceActive) return null;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const op = list[i];
        if (op.kind === 'groupBegin' && op.filterId) return null; // (its filter paints past the leaves)
        if (op.kind !== 'fillShape') continue;
        const bx = _alphaLeafBox(op.shapeIdx, cw, ch, _tightScratch);
        if (!bx) return null;
        if (bx[0] < x0) x0 = bx[0];
        if (bx[1] < y0) y0 = bx[1];
        if (bx[2] > x1) x1 = bx[2];
        if (bx[3] > y1) y1 = bx[3];
      }
      if (!(x1 > x0) || !(y1 > y0)) return null;
      const gx0 = Math.max(0, Math.floor(x0) & ~1),
        gx1 = Math.min(cw, Math.ceil(x1));
      const yTop = Math.max(0, Math.floor(y0)),
        yBot = Math.min(ch, Math.ceil(y1));
      const gy0 = Math.max(0, (ch - yBot) & ~1),
        gy1 = ch - yTop;
      if (gx1 <= gx0 || gy1 <= gy0) return null;
      return [gx0, gy0, gx1 - gx0, gy1 - gy0];
    }
    /// _tightGlRect of a group's leaves, remembered on the group row under the inputs the rect is a function of (the viewport, the geometry
    /// and cull generations, morph parameter, overrides and row generations, and world matrix): a static scene asks for the same
    /// rect of every group on every frame.
    function _tightGlRectOf(op, gOps, cw, ch) {
      const b = _handle.bundle,
        ov = R.draw.overrides,
        wm = R.draw.worldM;
      if (!gOps || op.shapeIdx === -1) return _tightGlRect(gOps, cw, ch);
      const mt = b._morphSrc ? +b._morphSrc.t || 0 : 0;
      const c = op._tightRect;
      if (
        c &&
        c.mt === mt &&
        c.cw === cw &&
        c.ch === ch &&
        c.geom === (b._geomGen | 0) &&
        c.cull === (b._cullGen | 0) &&
        c.ov === ov &&
        c.dl === b.drawList &&
        c.n === gOps.length &&
        (wm
          ? c.wm !== null && c.wm.length === wm.length && c.wm.every((v, i) => v === wm[i])
          : c.wm === null) &&
        (ov && ov.shapeGenOf
          ? c.gens !== null && c.gens.every((g, i) => g === ov.shapeGenOf(gOps[i].shapeIdx | 0))
          : c.gens === null)
      )
        return c.rect;
      const rect = _tightGlRect(gOps, cw, ch);
      op._tightRect = {
        mt,
        cw,
        ch,
        geom: b._geomGen | 0,
        cull: b._cullGen | 0,
        ov,
        dl: b.drawList,
        n: gOps.length,
        wm: wm ? Array.from(wm) : null,
        gens: ov && ov.shapeGenOf ? gOps.map((o) => ov.shapeGenOf(o.shapeIdx | 0)) : null,
        rect,
      };
      return rect;
    }
    function _mergePlan(mk) {
      const run = mk.run,
        groups = run.groups,
        n = groups.length;
      if (n < 2 || !_atlasDynamicOk()) return null;
      const [cw, ch] = viewportSize();
      const b = _handle.bundle,
        ov = R.draw.overrides,
        wm = R.draw.worldM;
      const gens =
        ov && ov.shapeGenOf
          ? groups.map((g) => g.body.map((o) => ov.shapeGenOf(o.shapeIdx | 0)))
          : null;
      const mt = b._morphSrc ? +b._morphSrc.t || 0 : 0; // a morph's boxes and opacities move with t
      const same = (c) =>
        c &&
        c.mt === mt &&
        c.cw === cw &&
        c.ch === ch &&
        c.geom === (b._geomGen | 0) &&
        c.cull === (b._cullGen | 0) &&
        c.ov === ov &&
        c.dl === b.drawList &&
        (wm ? c.wm && c.wm.every((v, i) => v === wm[i]) : !c.wm) &&
        (gens
          ? c.gens &&
            c.gens.every(
              (row, i) => row.length === gens[i].length && row.every((v, j) => v === gens[i][j]),
            )
          : !c.gens);
      if (same(run.plan)) return run.plan.plan;
      let plan = null;
      const rects = new Array(n);
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        rects[i] = _tightGlRect(groups[i].body, cw, ch);
        if (!rects[i]) ok = false;
      }
      if (ok) {
        // (each rect already carries its 2 px antialiasing reach, so rects that do not touch are groups that share no pixel)
        const boxes = rects.map((r) => [r[0], r[1], r[0] + r[2], r[1] + r[3]]);
        if (_boxesPairwiseDisjoint(boxes)) {
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const r of rects) {
            x0 = Math.min(x0, r[0]);
            y0 = Math.min(y0, r[1]);
            x1 = Math.max(x1, r[0] + r[2]);
            y1 = Math.max(y1, r[1] + r[3]);
          }
          const full = x0 <= 0 && y0 <= 0 && x1 >= cw && y1 >= ch;
          plan = {
            rects,
            tints: groups.map((g) => {
              const v = _groupOpacityNow(g.op);
              return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
            }),
            union: full ? null : [x0, y0, x1 - x0, y1 - y0],
          };
        }
      }
      run.plan = {
        mt,
        cw,
        ch,
        geom: b._geomGen | 0,
        cull: b._cullGen | 0,
        ov,
        dl: b.drawList,
        wm: wm ? Array.from(wm) : null,
        gens,
        plan,
      };
      return plan;
    }
    function _mergeBegin(op, plan, mk) {
      if (_atlas.held || _atlas.pend.length) R._atlasFlush();
      _groupBeginOrdinary({ ...op, rectPx: plan.union }, null);
      const top = _groupStack[_groupStack.length - 1];
      top.merge = plan;
      _merge = { skip: 2 * (plan.rects.length - 1) };
      R._mergedRuns = (R._mergedRuns | 0) + 1;
    }
    /// The run's last group closes: every rect of the accumulator is composited under its own group's opacity, in painter order.
    function _mergeEnd(grp) {
      _merge = null;
      const plan = grp.merge,
        [cw, ch] = viewportSize();
      bindFb(gl.FRAMEBUFFER, null);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glDisable(gl.SCISSOR_TEST);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      R.glUseProgram(R.cacheBlitProg);
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, grp.acc.tex);
      gl.uniform1i(R.cbUCacheTex, 0);
      R.glBindVertexArray(coverVao);
      const nr = plan.rects.length,
        items = _ciRoom(nr);
      for (let i = 0, k = 0; i < nr; i++, k += 12) {
        const r = plan.rects[i],
          o = plan.tints[i];
        items[k] = r[0];
        items[k + 1] = r[1];
        items[k + 2] = r[2];
        items[k + 3] = r[3];
        items[k + 4] = r[2] / cw;
        items[k + 5] = r[3] / ch;
        items[k + 6] = r[0] / cw;
        items[k + 7] = r[1] / ch;
        items[k + 8] = o;
        items[k + 9] = o;
        items[k + 10] = o;
        items[k + 11] = o;
      }
      if (!_compositeInstanced(items, nr, cw, ch)) {
        for (let i = 0, k = 0; i < nr; i++, k += 12) {
          R.glViewport(items[k], items[k + 1], items[k + 2], items[k + 3]);
          gl.uniform4f(R.cbUTint, items[k + 8], items[k + 9], items[k + 10], items[k + 11]);
          if (R.cbUInMap)
            gl.uniform4f(R.cbUInMap, items[k + 4], items[k + 5], items[k + 6], items[k + 7]);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          R._compositeDraws = (R._compositeDraws | 0) + 1;
        }
      }
      R.glBindVertexArray(null);
      R._mergedComposites = (R._mergedComposites | 0) + plan.rects.length;
      _handle.fillPassAssetDirty = true;
      return true;
    }
    /// The meta row of a group that carries a clip or mask of its own (a masked container, whose mask applies to the
    /// composited group), or -1. A filtered group applies its own after the filter, in _groupFilterOutput.
    function _groupEffectRow(op) {
      const b = _handle.bundle,
        row = op.shapeIdx;
      if (op.filterId || !(row >= 0) || !b || !b.metaFloats) return -1;
      const o = row * (b.metaFloatsPerShape | 0);
      // A layer row (the content of a mask, clip or pattern, drawn by the bake) carries the id of the resource it belongs to.
      if ((Math.round(b.metaFloats[o + 27]) & META_FLAG_LAYER) !== 0) return -1;
      return b.metaFloats[o + 30] > 0 || b.metaFloats[o + 31] > 0 ? row : -1;
    }
    /// Does this group composite by a plain src-over blit (no backdrop copy)? A normal blend, with
    /// the blit program present. The debug flag __MANTLE_GROUP_COPY_COMPOSITE puts every group back
    /// on the copy-and-composite path, for an in-page A/B of the two.
    function _groupOverBlit(op) {
      return (
        (op.blendMode | 0) === 0 && !!R.cacheBlitProg && !mantleDebugFlag('groupCopyComposite')
      );
    }
    /// Where a shape drawn now composites: the innermost open group's accumulator, or
    /// null for the canvas. Every in-group branch in this file composites there, and the
    /// unified route's isolation step asks this too, so the two routes agree on it
    ///. shapeFbo for the outermost group; its own target for a nested one.
    R._groupTarget = () =>
      _groupStack.length > 0 ? _groupStack[_groupStack.length - 1].acc.fbo : _groupBaseTarget;
    /// How many groups are open. A caller that opens groups records this before it starts, so it
    /// can put the stack back if it stops early.
    R._groupDepth = () => _groupStack.length;
    /// Close groups above depth, optionally compositing their accumulated output.
    /// Discarded groups restore draw alpha and the prior framebuffer target.
    R._groupUnwind = (depth, composite) => {
      let n = 0;
      while (_groupStack.length > (depth | 0)) {
        if (composite) R._groupEnd();
        else {
          const discarded = _groupStack.pop();
          if (discarded.atlas) {
            _atlas.open = false;
            _atlasShiftOff();
            R.glDisable(gl.SCISSOR_TEST);
          }
          if (discarded.merge) _merge = null;
          if (discarded.savedAlpha !== null && discarded.savedAlpha !== undefined)
            R.draw.alpha = discarded.savedAlpha;
          if (discarded.frame) R._exitFilterFrame(discarded.frame);
        }
        n++;
      }
      if (n && composite) R._atlasFlush();
      if (n && !composite) {
        bindFb(gl.FRAMEBUFFER, R._groupTarget());
        const [cw, ch] = viewportSize();
        R.glViewport(0, 0, cw, ch);
        R._forgetFillUnits();
        if (_handle) _handle.fillPassAssetDirty = true;
      }
      return n;
    };
    /// DRAW ALPHA IS GROUP OPACITY. `drawBundle({alpha})`, a handle's draw, a sprite, an instance: the whole draw is
    /// rendered into an accumulator and faded as ONE unit, as CSS `opacity` on a `<g>` does. Multiplying every leaf instead would let
    /// shapes that overlap show through each other. This is the group machinery of an `<g opacity>` row (R._groupBegin / R._groupEnd: the
    /// painted-rect scissor, the pooled accumulator, the mask-cost bound), opened by the draw entry instead of by a row of the bundle,
    /// with the draw's alpha as the group's opacity and 1 inside. alpha 1 (or absent) never reaches here.
    ///
    /// A draw that is ONE paint-only leaf (one shape, fill or stroke, normal blend, no recolor) has nothing to overlap: per-leaf and
    /// group agree to the byte, so it keeps the direct draw and pays nothing. What stays per leaf, as before: the override table's
    /// tint and opacity, the colorMatrix/offset and palette, the leaf's own fill-opacity. They are applied inside the group; alpha is
    /// applied to the composited result, last (a filter, mask, clip and blend mode of a row are inside it too, as for any group).
    let _alphaRedirect = null;
    const _alphaLeafMax = 64;
    const _alphaDisjointMax = 1024;
    /// {oneLeaf, ops}: whether the draw the current state selects (the whole draw list, or the sprite subset) is a single paint-only leaf.
    /// Cached on the bundle per draw list and range; `ops` is the subset's leaf list for the painted-rect bound, with the row of any filtered group it paints through (null = the whole list); `filtered`, whether there is one.
    function _alphaLeafInfo(bundle) {
      const dl = bundle.drawList,
        sr = _ds.shapeRange;
      let c = bundle._alphaLeaf;
      if (!c || c.dl !== dl || c.n !== dl.length)
        c = bundle._alphaLeaf = { dl, n: dl.length, byRange: new Map(), whole: null };
      const key = sr ? sr[0] * 1048576 + sr[1] : -1;
      let info = sr ? c.byRange.get(key) : c.whole;
      if (info) return info;
      let count = 0,
        groups = false,
        first = null,
        ops = sr ? [] : null,
        filtered = false;
      // A filtered group this draw paints through reaches past the leaves: `ops` carries its row, so the painted-rect bound answers none.
      const open = [];
      // A filtered group with nothing of this subset in it, its own row or a leaf: its filter is another sprite's picture, and a generator (a flood, an image, turbulence) would paint it.
      // The walks step over these (R._groupOutsideDraw). A plain group paints nothing past its leaves, and it may hold a place in a merged run, so it stays.
      let outside = null,
        reached = null;
      for (let i = 0; i < dl.length; i++) {
        const op = dl[i];
        if (op.kind === 'groupBegin') {
          groups = true;
          open.push(op.filterId ? op : null);
          if (sr) {
            const si = op.shapeIdx | 0;
            (reached || (reached = [])).push(si >= sr[0] && si <= sr[1]);
          }
          continue;
        }
        if (op.kind === 'groupEnd') {
          groups = true;
          const g = open.pop();
          if (sr) {
            const hit = reached.pop();
            if (hit && reached.length) reached[reached.length - 1] = true;
            if (g && !hit) (outside || (outside = new Set())).add(g);
          }
          continue;
        }
        if (sr) {
          const si = op.shapeIdx | 0;
          if (si < sr[0] || si > sr[1]) continue;
          ops.push(op);
          if (reached && reached.length) reached[reached.length - 1] = true;
        }
        for (let k = 0; k < open.length; k++)
          if (open[k]) {
            filtered = true;
            if (ops) ops.push(open[k]);
            open[k] = null;
          }
        if (++count === 1) first = op;
      }
      let oneLeaf = !groups && count <= 1;
      // Can the leaves overlap at all? (_alphaLeavesDisjoint): only plain fill leaves of a small, static draw are ever tested.
      let plain =
        !groups &&
        count >= 2 &&
        count <= _alphaDisjointMax &&
        !bundle._morphSrc &&
        !bundle._lbStream &&
        !bundle._nineSliceActive;
      if (plain) {
        const m = bundle.metaFloats,
          st = bundle.metaFloatsPerShape | 0;
        for (let i = 0; i < dl.length && plain; i++) {
          const op = dl[i];
          if (sr) {
            const si = op.shapeIdx | 0;
            if (si < sr[0] || si > sr[1]) continue;
          }
          const b = (op.shapeIdx | 0) * st;
          // a clip, mask or image paint may run its own pass; a filter reaches past the shape's box; a blend mode is isolated by a group
          if (
            op.kind !== 'fillShape' ||
            op.filterId ||
            op.filterGraphId ||
            op.colrGraphId ||
            op.blendMode > 0 ||
            Math.floor(m[b + 30] + 0.5) !== 0 ||
            Math.floor(m[b + 31] + 0.5) !== 0 ||
            (st >= 36 && Math.floor(m[b + 35] + 0.5) !== 0) ||
            (m[b + 7] > 0 && m[b + 12] > 0 && m[b + 11] > 0)
          )
            plain = false;
        }
      }
      if (oneLeaf && first) {
        // fill AND stroke in one row are two paints that overlap along the stroke's inner half; a blend mode is isolated by a group.
        const m = bundle.metaFloats,
          st = bundle.metaFloatsPerShape | 0,
          b = (first.shapeIdx | 0) * st;
        const fillA = m[b + 7],
          strokeA = m[b + 11],
          sw = m[b + 12];
        if ((fillA > 0 && sw > 0 && strokeA > 0) || first.blendMode > 0 || first.colrGraphId)
          oneLeaf = false;
      }
      info = { oneLeaf, ops, plain, filtered, outside, dj: null };
      if (sr) {
        if (c.byRange.size >= _alphaLeafMax) c.byRange.clear();
        c.byRange.set(key, info);
      } else c.whole = info;
      return info;
    }
    /// Does a subset draw step over this filtered group? (_alphaLeafInfo's `outside`.) Whole-bundle draws and plain groups never ask past the first test.
    R._groupOutsideDraw = (bundle, op) => {
      if (!_ds.shapeRange || !op.filterId) return false;
      const out = _alphaLeafInfo(bundle).outside;
      return !!out && out.has(op);
    };
    /// Would a draw at this alpha need the group (a bundle that can paint two things, or a recolor of the one)? Asked by the instanced
    /// path, which keeps its single instanced draw for the bundles that do not.
    R._alphaNeedsGroup = (bundle, recolor) =>
      !!bundle && !!bundle.drawList && (!!recolor || !_alphaLeafInfo(bundle).oneLeaf);
    /// The box one leaf can paint in, top-left px under the current draw state (world matrix, overrides, viewport): the row's exact box
    /// (R._shapeBboxPx, a stroke at its ink reach, not twice its pad) plus 2 px for the AA reach. [x0, y0, x1, y1], or null when the box
    /// is unbounded or unknown (the callers then keep the group).
    const _alphaPad = 2;
    function _alphaLeafBox(shapeIdx, cw, ch, out) {
      const bb = R._shapeBboxPx(shapeIdx | 0, cw, ch, undefined, true, true);
      if (!bb || !Number.isFinite(bb.x + bb.y + bb.w + bb.h)) return null;
      out[0] = bb.x - _alphaPad;
      out[1] = bb.y - _alphaPad;
      out[2] = bb.x + bb.w + _alphaPad;
      out[3] = bb.y + bb.h + _alphaPad;
      return out;
    }
    const _boxesOverlap = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];
    /// True when no two boxes overlap: a sweep along x over the boxes sorted by left edge, with the set of boxes still open, so a bundle of
    /// hundreds of leaves costs n log n plus the (usually empty) overlap of x-ranges, not n^2.
    function _boxesPairwiseDisjoint(boxes) {
      const n = boxes.length;
      if (n < 2) return true;
      const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
      let active = [];
      for (const i of order) {
        const b = boxes[i];
        active = active.filter((j) => boxes[j][2] > b[0]);
        for (const j of active) {
          const q = boxes[j];
          if (b[1] < q[3] && q[1] < b[3]) return false;
        }
        active.push(i);
      }
      return true;
    }
    /// The leaf boxes of a draw's leaves (`ops`) under the current state, or null.
    function _alphaLeafBoxes(ops, cw, ch) {
      const out = new Array(ops.length);
      for (let i = 0; i < ops.length; i++) {
        const bx = _alphaLeafBox(ops[i].shapeIdx, cw, ch, [0, 0, 0, 0]);
        if (!bx) return null;
        out[i] = bx;
      }
      return out;
    }
    /// Can no two leaves of this draw paint the same pixel? Then per-leaf alpha IS group alpha (each pixel has one leaf, faded once) and
    /// the draw needs no accumulator. Plain fill leaves only, up to 1024 (info.plain: no fill+stroke row -- its stroke's inner half is on its own
    /// fill --, filter, blend mode, clip, mask, image, group, recolor); then the leaves' painted boxes must be pairwise disjoint. The
    /// verdict is a function of the geometry, the overrides, the world matrix and the viewport, so it is cached on the leaf info under
    /// exactly those terms (the world matrix by its float bits): a bundle drawn every frame at one placement pays the key compare.
    const _alphaLeavesDisjoint = (bundle, info) => {
      if (!info.plain || R.draw.colorMatrix || R.draw.colorMatrixOffset) return false;
      const [cw, ch] = viewportSize();
      const ops = info.ops || bundle.drawList,
        wm = R.draw.worldM,
        ov = R.draw.overrides;
      const gens = ov && ov.shapeGenOf ? ops.map((o) => ov.shapeGenOf(o.shapeIdx | 0)) : null;
      const c = info.dj;
      if (
        c &&
        c.cw === cw &&
        c.ch === ch &&
        c.geom === (bundle._geomGen | 0) &&
        c.cull === (bundle._cullGen | 0) &&
        c.ov === ov &&
        (wm ? c.wm && c.wm.every((v, i) => v === wm[i]) : !c.wm) &&
        (gens ? c.gens && c.gens.every((v, i) => v === gens[i]) : !c.gens)
      )
        return c.ok;
      let ok = false;
      const boxes = _alphaLeafBoxes(ops, cw, ch);
      if (boxes) {
        ok = _boxesPairwiseDisjoint(boxes);
      }
      info.dj = {
        cw,
        ch,
        geom: bundle._geomGen | 0,
        cull: bundle._cullGen | 0,
        ov,
        wm: wm ? Array.from(wm) : null,
        gens,
        ok,
      };
      return ok;
    };
    /// How a batch of INSTANCES at alpha < 1 can share accumulators. Each instance's painted box (the union of its leaves' boxes under its
    /// own world matrix, R._alphaLeafBox) says which instances can touch: two whose boxes are disjoint share no pixel. A pixel is
    /// composited in instance order, so an instance goes into the first batch ("level") AFTER every earlier instance it overlaps (an
    /// ASAP layering of the overlap graph, the fewest levels there are): within a level no two instances touch, so painting the level's
    /// instances into ONE accumulator and fading it once is the picture the instances one at a time would make, and the levels composite
    /// in order. One pass per (level, distinct alpha) replaces one per faded instance. Disjoint placements are the one-level case.
    ///
    /// Returns [{ alpha, list, rect }] in composite order -- `list` the instances with alpha 1 (tint kept; the cached plan holds their indices), `rect` the batch's union (GL px,
    /// even origin; null = the canvas) -- or 'direct' when no instance's own leaves can overlap (per-leaf alpha is then group alpha and one
    /// instanced draw with per-instance alpha is the picture, however the instances overlap each other: the caller keeps its fast path as
    /// it is), or null when a box is unbounded, the pass count would not drop below the faded instance count, or there are more than 256
    /// instances (the pairwise test is quadratic) or 8 distinct alphas per level (each costs a pass).
    R._alphaInstancePlan = (bundle, instances) => {
      const n = instances.length;
      if (n > 256 || !bundle || !bundle.drawList || !_handle) return null;
      // The plan is a function of the placements (matrix bits and alpha), the geometry, the overrides and the viewport: a scene that
      // draws the same placements frame after frame (tints may change) reuses it for the price of comparing them.
      const [cw, ch] = viewportSize(),
        ov = R.draw.overrides,
        info = _alphaLeafInfo(bundle);
      const ops = info.ops || bundle.drawList;
      const gens = ov && ov.shapeGenOf ? ops.map((o) => ov.shapeGenOf(o.shapeIdx | 0)) : null;
      const cm = !!(R.draw.colorMatrix || R.draw.colorMatrixOffset);
      const mt = bundle._morphSrc ? +bundle._morphSrc.t || 0 : 0; // a morph's boxes move with t
      const c = bundle._alphaPlan;
      let hit =
        !!c &&
        c.n === n &&
        c.cw === cw &&
        c.ch === ch &&
        c.info === info &&
        c.mt === mt &&
        c.geom === (bundle._geomGen | 0) &&
        c.cull === (bundle._cullGen | 0) &&
        c.ov === ov &&
        c.cm === cm &&
        (gens
          ? !!c.gens && c.gens.length === gens.length && c.gens.every((v, i) => v === gens[i])
          : !c.gens);
      const key = new Float64Array(n * 10);
      for (let i = 0; i < n; i++) {
        const inst = instances[i],
          wm = inst && inst.worldMatrix,
          o = i * 10;
        for (let k = 0; k < 9; k++) key[o + k] = wm ? wm[k] : k === 0 || k === 4 || k === 8 ? 1 : 0;
        key[o + 9] =
          inst && typeof inst.alpha === 'number' ? Math.max(0, Math.min(1, inst.alpha)) : 1;
      }
      if (hit)
        for (let i = 0; i < key.length; i++)
          if (key[i] !== c.key[i]) {
            hit = false;
            break;
          }
      let plan;
      if (hit) plan = c.plan;
      else {
        plan = _alphaInstancePlanCompute(bundle, instances);
        bundle._alphaPlan = {
          n,
          cw,
          ch,
          info,
          mt,
          geom: bundle._geomGen | 0,
          cull: bundle._cullGen | 0,
          ov,
          cm,
          gens,
          key,
          plan,
        };
      }
      if (!Array.isArray(plan)) return plan;
      return plan.map((bt) => ({
        alpha: bt.alpha,
        level: bt.level,
        rect: bt.rect,
        idx: bt.idx,
        list: bt.idx.map((i) => {
          const inst = instances[i] || {};
          return { worldMatrix: inst.worldMatrix, alpha: 1, tint: inst.tint };
        }),
      }));
    };
    const _alphaInstancePlanCompute = (bundle, instances) => {
      const n = instances.length;
      if (n > 256 || !bundle || !bundle.drawList || !_handle) return null;
      const [cw, ch] = viewportSize();
      const info = _alphaLeafInfo(bundle);
      if (info.filtered) return null; // the batch rect below is the leaves' box, which a filtered group paints past: the per-instance loop
      const ops = (info.ops || bundle.drawList).filter((o) => o.kind === 'fillShape');
      if (!ops.length) return null;
      const boxes = new Array(n),
        savedW = _ds.worldM;
      let direct = info.plain && !R.draw.colorMatrix && !R.draw.colorMatrixOffset;
      try {
        for (let i = 0; i < n; i++) {
          const inst = instances[i];
          _ds.worldM = (inst && inst.worldMatrix) || null;
          const lb = _alphaLeafBoxes(ops, cw, ch);
          if (!lb) return null;
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const b of lb) {
            if (b[0] < x0) x0 = b[0];
            if (b[1] < y0) y0 = b[1];
            if (b[2] > x1) x1 = b[2];
            if (b[3] > y1) y1 = b[3];
          }
          if (!(x1 > x0) || !(y1 > y0)) return null;
          boxes[i] = [x0, y0, x1, y1];
          if (direct)
            for (let a = 0; a < lb.length && direct; a++)
              for (let c = a + 1; c < lb.length; c++)
                if (_boxesOverlap(lb[a], lb[c])) {
                  direct = false;
                  break;
                }
        }
      } finally {
        _ds.worldM = savedW;
      }
      if (direct) return 'direct';
      const level = new Int32Array(n);
      let top = 0;
      for (let i = 0; i < n; i++) {
        let l = 0;
        for (let j = 0; j < i; j++)
          if (level[j] >= l && _boxesOverlap(boxes[i], boxes[j])) l = level[j] + 1;
        level[i] = l;
        if (l > top) top = l;
      }
      // batches: per level, per distinct alpha, in first-seen order
      const by = new Map();
      let faded = 0;
      for (let i = 0; i < n; i++) {
        const inst = instances[i] || {};
        const a = typeof inst.alpha === 'number' ? Math.max(0, Math.min(1, inst.alpha)) : 1;
        if (a < 1) faded++;
        const key = level[i] + ':' + a;
        let b = by.get(key);
        if (!b) {
          b = {
            level: level[i],
            alpha: a,
            idx: [],
            box: [Infinity, Infinity, -Infinity, -Infinity],
          };
          by.set(key, b);
        }
        b.idx.push(i);
        const r = boxes[i];
        if (r[0] < b.box[0]) b.box[0] = r[0];
        if (r[1] < b.box[1]) b.box[1] = r[1];
        if (r[2] > b.box[2]) b.box[2] = r[2];
        if (r[3] > b.box[3]) b.box[3] = r[3];
      }
      const batches = Array.from(by.values()).sort((p, q) => p.level - q.level); // stable: first-seen alpha order within a level
      let passes = 0;
      for (const b of batches) if (b.alpha < 1) passes++;
      if (passes >= faded || passes > 64) return null; // no fewer passes than the per-instance loop
      const out = [];
      for (const b of batches) {
        // top-left px box -> GL rect (origin bottom-left), origin forced even as every sub-rect target's is, clipped to the canvas
        const x0 = Math.max(0, Math.floor(b.box[0]) & ~1),
          x1 = Math.min(cw, Math.ceil(b.box[2]));
        const yTop = Math.max(0, Math.floor(b.box[1])),
          yBot = Math.min(ch, Math.ceil(b.box[3]));
        const gy0 = Math.max(0, (ch - yBot) & ~1),
          gy1 = ch - yTop;
        const w = x1 - x0,
          h = gy1 - gy0;
        const full = x0 <= 0 && gy0 <= 0 && w >= cw && h >= ch;
        out.push({
          alpha: b.alpha,
          level: b.level,
          idx: b.idx,
          rect: full || w <= 0 || h <= 0 ? null : [x0, gy0, w, h],
        });
      }
      return out;
    };
    /// `mk` = { next } says this faded group is one of a run of faded groups (instance batches, or instances of the per-instance loop)
    /// whose composites may share the group atlas (R._atlasTryBegin); `next` that another follows at once. Only a bundle of pure
    /// fill-pass leaves (no filter, mask, blend, group, ...) is offered to it. `recolor` says the draws inside the group are recolored
    /// (per-instance color applied after this call), so a one-leaf bundle still takes the group.
    R._alphaGroupBegin = (bundle, rectPx, mk) => {
      const tok = _alphaGroupBeginInner(bundle, rectPx, mk);
      // a faded draw that takes the direct path draws on the canvas: the composites a run deferred land first
      if (!tok && _atlas.held) R._atlasFlush();
      return tok;
    };
    /// Does a draw colorMatrix (column-major mat4, out = M * paint + off) read or write alpha? Output alpha = m[3]r + m[7]g + m[11]b + m[15]a + off[3];
    /// RGB reads alpha through m[12..14]. A matrix without an offset (or an offset without a matrix) is the identity in the missing part.
    const _recolorTouchesAlpha = (m, off) =>
      !!(
        (off && off[3] !== 0) ||
        (m &&
          (m[3] !== 0 ||
            m[7] !== 0 ||
            m[11] !== 0 ||
            m[12] !== 0 ||
            m[13] !== 0 ||
            m[14] !== 0 ||
            m[15] !== 1))
      );
    const _alphaGroupBeginInner = (bundle, rectPx, mk) => {
      const a = R.draw.alpha;
      if (!(a < 1) || !bundle || !_handle || !bundle.drawList) return null;
      const info = _alphaLeafInfo(bundle);
      // `mk.recolor`: the caller recolors the draws inside the group (per-instance color), which the current state does not show yet.
      // The draw's own colorMatrix needs the group only when it touches ALPHA: the fill folds the draw's alpha into the straight paint
      // BEFORE the matrix (mantle.vert ovTint.a, aacPoints.vert fill.a), so a matrix whose alpha row is (0,0,0,1) with offset 0 and whose
      // RGB rows do not read alpha (a tint, an RGB mix, an RGB offset) gives one leaf the same pixels whether it is faded per leaf or as a group.
      const recolor = !!(
        (mk && mk.recolor) ||
        _recolorTouchesAlpha(R.draw.colorMatrix, R.draw.colorMatrixOffset)
      );
      if (info.oneLeaf && !recolor) return null;
      // leaves that provably share no pixel: per-leaf alpha is the group's (a rectPx caller -- an instance batch -- decided that itself)
      if (rectPx === undefined && !info.oneLeaf && _alphaLeavesDisjoint(bundle, info)) return null;
      R.endFillPass();
      const depth = _groupStack.length;
      const gop = {
        kind: 'groupBegin',
        shapeIdx: -1,
        opacity: a,
        filterId: 0,
        blendMode: 0,
        isolation: 1,
        rectPx,
      };
      if (mk) {
        if (info.pure === undefined)
          info.pure = R._atlasOpsPure(bundle, info.ops || bundle.drawList);
        if (info.pure) gop.atlasRun = mk;
      }
      R._groupBegin(gop, info.ops);
      const top = _groupStack[_groupStack.length - 1];
      top.savedAlpha = a; // _groupEnd puts the draw's alpha back
      R.draw.alpha = 1;
      const prior = _alphaRedirect;
      _alphaRedirect = top.acc.fbo;
      return { depth, prior };
    };
    /// Close the group: the composite fades the accumulator by the draw's alpha into the canvas (or the enclosing group).
    R._alphaGroupEnd = (tok) => {
      if (!tok) return;
      _alphaRedirect = tok.prior;
      R.endFillPass();
      R._groupUnwind(tok.depth + 1, true); // a group the draw left open composites first
      R._groupEnd();
    };
    /// An exception unwound the draw: drop the group and its redirect without compositing a half-drawn accumulator.
    R._alphaGroupAbort = (tok) => {
      if (!tok) return;
      _alphaRedirect = tok.prior;
      R._groupUnwind(tok.depth, false);
    };

    /// FADED INSTANCES, each IN ITS own SLOT, ONE INSTANCED DRAW PER BLOCK. The faded instances of a bundle that paints two things are
    /// each a group; layering touching ones (R._alphaInstancePlan) so that each layer shares an accumulator would cost one pass
    /// and one draw per layer (22 for an 8 x 8 grid whose instances are 1.8 cells wide). Here every instance takes a slot of the atlas
    /// of its own, sized to its painted box, so nothing needs layering: the slot's offset is added to the instance's world matrix (a
    /// translation in clip space, which the instanced vertex stage applies to the instance's whole copy), the slots of a canvas-sized BLOCK of the atlas
    /// are drawn by ONE instanced draw (a viewport shift by the block's origin), and every instance is composited, in instance order, by one instanced
    /// composite at its own alpha. Slot offsets are even, so the 2x2 derivative quads are the canvas's own; slots are 2 px apart and the painted
    /// boxes already carry the antialiasing reach. Declines (-1) for anything the plain instanced fill draw cannot take into a slot.
    const _slotMax = 512;
    /// The slot rect of an instance's painted box, in canvas GL pixels, NOT clipped to the canvas: ink beyond the canvas edge must land inside the
    /// slot (nothing clips a slot, whose neighbors are 2 px away), and the composite shows only the part on the canvas. `vis` = that visible part, or
    /// null when the instance paints nothing on the canvas. Origins are even, as every sub-rect target's is.
    function _alphaSlotRect(box, cw, ch) {
      const x0 = Math.floor(box[0]) & ~1,
        x1 = Math.ceil(box[2]);
      const yTop = Math.floor(box[1]),
        yBot = Math.ceil(box[3]);
      const gy0 = (ch - yBot) & ~1,
        gy1 = ch - yTop;
      if (!(x1 > x0 && gy1 > gy0)) return null;
      const vx0 = Math.max(0, x0),
        vx1 = Math.min(cw, x1),
        vy0 = Math.max(0, gy0),
        vy1 = Math.min(ch, gy1);
      return {
        x: x0,
        y: gy0,
        w: x1 - x0,
        h: gy1 - gy0,
        vis: vx1 > vx0 && vy1 > vy0 ? [vx0, vy0, vx1 - vx0, vy1 - vy0] : null,
      };
    }
    function _alphaSlotPlan(bundle, instances, cw, ch, size) {
      const n = instances.length,
        info = _alphaLeafInfo(bundle),
        ov = R.draw.overrides;
      const ops = (info.ops || bundle.drawList).filter((o) => o.kind === 'fillShape');
      if (!ops.length) return null;
      const gens = ov && ov.shapeGenOf ? ops.map((o) => ov.shapeGenOf(o.shapeIdx | 0)) : null;
      const key = new Float64Array(n * 9);
      for (let i = 0; i < n; i++) {
        const wm = instances[i] && instances[i].worldMatrix;
        for (let k = 0; k < 9; k++)
          key[i * 9 + k] = wm ? wm[k] : k === 0 || k === 4 || k === 8 ? 1 : 0;
      }
      const mt = bundle._morphSrc ? +bundle._morphSrc.t || 0 : 0; // a morph's boxes move with t
      const c = bundle._alphaSlotPlan;
      if (
        c &&
        c.n === n &&
        c.cw === cw &&
        c.ch === ch &&
        c.size === size &&
        c.info === info &&
        c.mt === mt &&
        c.geom === (bundle._geomGen | 0) &&
        c.cull === (bundle._cullGen | 0) &&
        c.ov === ov &&
        (gens
          ? !!c.gens && c.gens.length === gens.length && c.gens.every((v, i) => v === gens[i])
          : !c.gens) &&
        c.key.every((v, i) => v === key[i])
      )
        return c.plan;
      let plan = null;
      const savedW = _ds.worldM,
        rects = new Array(n);
      try {
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
          _ds.worldM = (instances[i] && instances[i].worldMatrix) || null;
          const lb = _alphaLeafBoxes(ops, cw, ch);
          if (!lb) {
            ok = false;
            break;
          }
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const b of lb) {
            if (b[0] < x0) x0 = b[0];
            if (b[1] < y0) y0 = b[1];
            if (b[2] > x1) x1 = b[2];
            if (b[3] > y1) y1 = b[3];
          }
          rects[i] = x1 > x0 && y1 > y0 ? _alphaSlotRect([x0, y0, x1, y1], cw, ch) : null;
          if (!rects[i]) ok = false;
        }
        if (ok) plan = _alphaSlotPack(instances, rects, cw, ch, size);
      } finally {
        _ds.worldM = savedW;
      }
      bundle._alphaSlotPlan = {
        n,
        cw,
        ch,
        size,
        info,
        mt,
        geom: bundle._geomGen | 0,
        cull: bundle._cullGen | 0,
        ov,
        gens,
        key,
        plan,
      };
      return plan;
    }
    /// Shelf-pack the rects into the canvas-sized blocks of a size x size atlas; null when they do not fit.
    function _alphaSlotPack(instances, rects, cw, ch, size) {
      const n = rects.length,
        nbx = Math.floor(size / cw),
        nby = Math.floor(size / ch),
        nblocks = nbx * nby;
      if (nblocks < 1) return null;
      const slots = new Array(n).fill(null),
        blocks = [];
      /** @type {{ y: number, h: number, x: number }[]} */
      let shelves = [];
      let shelfEnd = 0,
        blk = -1;
      const open = () => {
        blk++;
        shelves = [];
        shelfEnd = 0;
        blocks.push([]);
        return blk < nblocks;
      };
      if (!open()) return null;
      for (let i = 0; i < n; i++) {
        const r = rects[i];
        if (!r.vis) continue; // paints nothing on the canvas
        const w = r.w,
          h = r.h,
          px = r.x & 1,
          py = r.y & 1;
        if (w + _atlasGutter > cw || h + _atlasGutter + 1 > ch) return null;
        let at = null;
        for (let pass = 0; pass < 2 && !at; pass++) {
          for (const sh of shelves) {
            const x = sh.x + ((sh.x - px) & 1 ? 1 : 0),
              y = sh.y + ((sh.y - py) & 1 ? 1 : 0);
            if (x + w <= cw && y + h <= sh.y + sh.h) {
              sh.x = x + w + _atlasGutter;
              at = { x, y };
              break;
            }
          }
          if (!at) {
            const y0 = shelfEnd,
              sh = { y: y0, h: h + _atlasGutter + 1, x: 0 };
            if (y0 + sh.h <= ch) {
              const x = (sh.x - px) & 1 ? 1 : 0,
                y = y0 + ((y0 - py) & 1 ? 1 : 0);
              if (x + w <= cw && y + h <= y0 + sh.h) {
                shelfEnd = y0 + sh.h;
                shelves.push(sh);
                sh.x = x + w + _atlasGutter;
                at = { x, y };
              }
            }
          }
          if (!at && pass === 0) {
            if (!open()) return null;
          }
        }
        if (!at) return null;
        slots[i] = { block: blk, x: at.x, y: at.y };
        blocks[blk].push(i);
      }
      // the instance's matrix, translated so that its painted rect lands on its slot (clip units of the canvas-sized viewport)
      const mats = new Array(n);
      for (let i = 0; i < n; i++) {
        if (!slots[i]) continue;
        const wm = instances[i] && instances[i].worldMatrix,
          m = new Float32Array(9);
        if (wm) for (let k = 0; k < 9; k++) m[k] = wm[k];
        else {
          m[0] = 1;
          m[4] = 1;
          m[8] = 1;
        }
        // A translation of the clip position, so it goes through w: the matrix is homogeneous, and adding to the last column alone moves the copy by offset / w.
        const dx = (2 * (slots[i].x - rects[i].x)) / cw,
          dy = (2 * (slots[i].y - rects[i].y)) / ch;
        m[0] += dx * m[2];
        m[3] += dx * m[5];
        m[6] += dx * m[8];
        m[1] += dy * m[2];
        m[4] += dy * m[5];
        m[7] += dy * m[8];
        mats[i] = m;
      }
      return {
        rects,
        slots,
        blocks,
        mats,
        nbx,
        lists: blocks.map((idx) =>
          idx.map((i) => ({ worldMatrix: mats[i], alpha: 1, tint: undefined })),
        ),
      };
    }
    R._alphaSlotBatch = (bundle, instances) => {
      const n = instances.length;
      if (
        n < 2 ||
        n > _slotMax ||
        !bundle ||
        !bundle.drawList ||
        !_handle ||
        mantleDebugFlag('noAlphaSlots')
      )
        return -1;
      if (!_atlasDynamicOk() || R.draw.extClipTex || R.draw.colorMatrix || R.draw.colorMatrixOffset)
        return -1;
      const [cw, ch] = viewportSize();
      if (!(cw >= 1) || !(ch >= 1)) return -1;
      const info = _alphaLeafInfo(bundle);
      if (info.pure === undefined) info.pure = R._atlasOpsPure(bundle, info.ops || bundle.drawList);
      if (!info.pure) return -1;
      if (info.noVectorEffect === undefined) {
        const m = bundle.metaFloats,
          st = bundle.metaFloatsPerShape | 0;
        let ok = true;
        for (const o of info.ops || bundle.drawList)
          if ((Math.round(m[(o.shapeIdx | 0) * st + 27]) & 7168) !== 0) {
            ok = false;
            break;
          }
        info.noVectorEffect = ok;
      }
      if (!info.noVectorEffect) return -1;
      for (let i = 0; i < n; i++) {
        const a = instances[i] && instances[i].alpha;
        if (!(typeof a === 'number' && a < 1)) return -1;
      }
      if (_atlas.maxTex === 0) {
        let t = 0;
        try {
          t = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
        } catch {
          /* fixed below */
        }
        _atlas.maxTex = t > 0 ? t : 2048;
      }
      const size = Math.min(_atlas.maxTex, Math.max(cw, ch) <= 1024 ? 2048 : 4096);
      const plan = _alphaSlotPlan(bundle, instances, cw, ch, size);
      if (!plan) return -1;
      // The atlas is optional here as in R._atlasTryBegin: a budget that cannot hold it sends the instances to the layered accumulators.
      if (
        !_shapeRtCache.has('atlas:' + size + ',' + size) &&
        R._memAdmit &&
        !R._memAdmit(size * size * 8, 'group atlas')
      )
        return -1;
      R._atlasFlush();
      R.endFillPass();
      const rt = acquireShapeRT(size, size, 'atlas:');
      _atlas.rt = rt;
      _atlas.size = size;
      bindFb(gl.FRAMEBUFFER, rt.fbo);
      R.glDisable(gl.SCISSOR_TEST);
      R.glDepthMask(true);
      gl.stencilMask(0xff);
      gl.clearColor(0, 0, 0, 0);
      gl.clearStencil(0);
      gl.clearDepth(1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      R.glDepthMask(false);
      try {
        for (let b = 0; b < plan.blocks.length; b++) {
          const idx = plan.blocks[b],
            list = plan.lists[b];
          if (!idx.length) continue;
          const bx = (b % plan.nbx) * cw,
            by = Math.floor(b / plan.nbx) * ch;
          for (let j = 0; j < idx.length; j++) list[j].tint = instances[idx[j]].tint;
          _atlasShiftOn(bx, by);
          gl.scissor(bx, by, cw, ch);
          R.glEnable(gl.SCISSOR_TEST);
          R._drawBundleInstancedFast(bundle, list, null);
        }
      } finally {
        _atlasShiftOff();
        R.glDisable(gl.SCISSOR_TEST);
      }
      bindFb(gl.FRAMEBUFFER, null);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      R.glUseProgram(R.cacheBlitProg);
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rt.tex);
      gl.uniform1i(R.cbUCacheTex, 0);
      const items = _ciRoom(n);
      let nc = 0;
      for (let i = 0; i < n; i++) {
        const sl = plan.slots[i];
        if (!sl) continue; // paints nothing on the canvas
        const r = plan.rects[i],
          v = r.vis,
          k = nc++ * 12;
        const ax = (sl.block % plan.nbx) * cw + sl.x + (v[0] - r.x),
          ay = Math.floor(sl.block / plan.nbx) * ch + sl.y + (v[1] - r.y);
        const a = Math.max(0, Math.min(1, instances[i].alpha));
        items[k] = v[0];
        items[k + 1] = v[1];
        items[k + 2] = v[2];
        items[k + 3] = v[3];
        items[k + 4] = v[2] / size;
        items[k + 5] = v[3] / size;
        items[k + 6] = ax / size;
        items[k + 7] = ay / size;
        items[k + 8] = a;
        items[k + 9] = a;
        items[k + 10] = a;
        items[k + 11] = a;
      }
      _compositeItems(items, nc, cw, ch);
      R._atlasSlots = (R._atlasSlots | 0) + nc;
      R._atlasComposites = (R._atlasComposites | 0) + nc;
      R._atlasPasses = (R._atlasPasses | 0) + 1;
      R._alphaSlotBatches = (R._alphaSlotBatches | 0) + 1;
      _handle.fillPassAssetDirty = true;
      return n;
    };
    /// Every input of a filtered group's result that the accumulator does not already carry: the group's filter result is a
    /// pure function of this key and of what the open children painted into the accumulator, and the children's paint is a
    /// pure function of the bundle's geometry, resources and per-row overrides, the world matrix and the recolor state. Each
    /// term is compared exactly (resources by identity, the override table by identity or what it says, its rows by what they say as lists, the
    /// world matrix by its float bits), so the key holds at any document scale. The group's own opacity is NOT a term: it
    /// is applied after the filter, by the group composite.
    function _groupFilterKey(grp, graph, cw, ch) {
      const b = grp.bundle,
        ov = R.draw.overrides;
      let gens = null;
      if (ov && ov.shapeGenOf) {
        const ops = grp.gOps || [];
        gens = new Array(ops.length + 1);
        gens[0] = R._rowFeedKey(ov, grp.shapeIdx | 0);
        for (let i = 0; i < ops.length; i++) gens[i + 1] = R._rowFeedKey(ov, ops[i].shapeIdx | 0);
      }
      return {
        gen: _handle.generation,
        geomGen: b._geomGen | 0,
        morphT: b._morphSrc ? b._morphSrc.t : 0,
        cw,
        ch,
        wmHash: R._wmHash(_ds.worldM),
        world: _ds.worldM ? Array.from(_ds.worldM) : null,
        recolor: R._recolorHash(),
        recolorState: R._recolorState(),
        paramGen: b._filterParamGen | 0,
        graph,
        overrides: ov || null,
        groupGens: gens,
        maskGen: R._maskFeedShapeGen(),
        res: [
          b.curveTex,
          b.bandTex,
          b.metaTex,
          b.gradientTex,
          b.imageAtlasTex,
          b.secondaryImageAtlasTex,
          b.filterTex,
          b.imageAtlasRects,
        ],
        variant: R._lastFillVariantKey || '',
        frameKey: grp.frame ? grp.frame.key : '',
      };
    }
    /// A filtered group's cached result when its key is unchanged, found BEFORE its children paint: the key is a pure function of the
    /// bundle, resources, overrides, world matrix and recolor state (see _groupFilterKey), so an unchanged key means the children would
    /// paint what they painted when the entry was stored, and they need not paint at all. null = evaluate as usual.
    function _groupFilterHit(op, gOps, cw, ch) {
      const b = _handle.bundle;
      if (
        !gOps ||
        R.opts.groupFilterCache === false ||
        b._morphSrc ||
        mantleDebugFlag('noGroupFilterSkip')
      )
        return null;
      const graph = b.filterGraphs?.[op.filterId - 1];
      if (!graph || !R._filterCacheable(b, graph)) return null;
      const probe = { bundle: b, gOps, shapeIdx: op.shapeIdx, frame: null };
      const entry = _getFilterCache(
        'g' + _handle._filterCacheOwner + '_G' + op.filterId + '_' + (op.shapeIdx | 0),
      );
      if (
        !entry ||
        !entry.tex ||
        !R._filterKeyMatches(entry, _groupFilterKey(probe, graph, cw, ch))
      )
        return null;
      return entry;
    }
    /// The group whose children were skipped: the cached filter result composites straight into the parent at the group's opacity.
    function _groupSkipEnd(grp, cw, ch) {
      if (grp.savedAlpha !== null && grp.savedAlpha !== undefined) R.draw.alpha = grp.savedAlpha;
      const entry = grp.skip;
      const o = isFinite(grp.opacity) ? Math.min(1, Math.max(0, grp.opacity)) : 1;
      R._compositeFilteredTex(
        entry.tex,
        cw,
        ch,
        grp.acc.fbo || null,
        entry.rect || null,
        R._filterRegionRectPx(grp.shapeIdx, cw, ch),
        o,
        grp.shapeIdx,
        true,
      );
      R._groupEndFiltered = true;
      _handle.fillPassAssetDirty = true;
      return true;
    }
    /// Runs a filtered group's graph over its accumulator and leaves the filtered, region-clipped result in grp.acc. The
    /// graph's root is kept in the filter-result cache, per (owner, filter, group row), and a frame whose key is unchanged
    /// composites it without evaluating the graph. The children still paint into the accumulator every frame: nothing
    /// here knows a frame is unchanged until its inputs have been compared. Returns whether a filter was applied.
    function _groupFilterOutput(grp, cw, ch) {
      const graph = grp.bundle.filterGraphs?.[grp.filterId - 1];
      if (!graph) return false;
      // A morph's key moves every frame (its curve lerp is the parameter), so an entry could never be read.
      // (`groupFilterCache: false` turns the cache off, the way `unifiedFilterCache: false` does for a filtered shape.)
      const cacheable =
        R.opts.groupFilterCache !== false &&
        R._filterCacheable(grp.bundle, graph) &&
        !grp.bundle._morphSrc;
      const key = cacheable ? _groupFilterKey(grp, graph, cw, ch) : null;
      const cacheId =
        'g' + _handle._filterCacheOwner + '_G' + grp.filterId + '_' + (grp.shapeIdx | 0);
      const entry = cacheable ? _getFilterCache(cacheId) : null;
      const regionPx = R._filterRegionRectPx(grp.shapeIdx, cw, ch);
      const clearOutput = (output) => {
        bindFb(gl.FRAMEBUFFER, output.fbo);
        R.glViewport(0, 0, cw, ch);
        R.glDepthMask(true);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        R.glDepthMask(false);
      };
      if (cacheable && entry && entry.tex && R._filterKeyMatches(entry, key)) {
        const output = acquireShapeRT(cw, ch);
        clearOutput(output);
        R._compositeFilteredTex(
          entry.tex,
          cw,
          ch,
          output.fbo,
          entry.rect || null,
          regionPx,
          1,
          grp.shapeIdx,
          true,
        );
        _handle.fillPassAssetDirty = true;
        grp.acc = output;
        grp.rect = null;
        return true;
      }
      const info = R._filterNodeRects(graph, grp.shapeIdx, cw, ch, { x: 0, y: 0, w: cw, h: ch });
      const px = R._filterPxPerEm(cw, ch, grp.shapeIdx);
      let backdrop = null;
      if (R._graphReadsBackdrop(graph)) {
        ensureGroupBackdropTex();
        bindFb(gl.FRAMEBUFFER, R._groupTarget());
        R._parkFillActiveUnit();
        gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
        backdrop = { fbo: null, tex: groupBackdropTex, size: [cw, ch], rect: [0, 0, cw, ch] };
      }
      const ctx = R._buildFilterCtx(
        cw,
        ch,
        px,
        { ...grp.acc, size: [cw, ch], rect: [0, 0, cw, ch] },
        backdrop,
        grp.shapeIdx,
      );
      ctx.nodeSubregions = info?.subregions || null;
      ctx.feImagePlacements = R._feImagePlacements(graph, grp.shapeIdx, cw, ch);
      const luts = [];
      for (const n of graph.nodes) {
        const bytes = n.type === 'feComponentTransfer' && n.params?.lutBytes;
        if (!bytes) {
          luts.push(null);
          continue;
        }
        const tex = trackGlResource(gl, gl.createTexture(), 'filterScratch');
        R._parkFillActiveUnit();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          256,
          4,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes),
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        n.params.lutIndex = luts.length;
        luts.push(tex);
      }
      ctx.componentTransferLUTs = luts;
      const root = evaluateGraph(
        gl,
        graph,
        _rtPool,
        _svgDispatch,
        ctx,
        cw,
        ch,
        info?.rects || null,
      );
      _filterEvalCount++;
      // Store only a result the route has actually painted: the unified route reports success on a frame whose
      // program is still linking, and that frame's accumulator is empty. Its fill-draw counter has not moved.
      if (
        cacheable &&
        (!R._groupEndUnified || (R._unifiedFillDraws | 0) > grp.uniDraws0) &&
        R._deferTotal() === grp.def0
      ) {
        R._storeFilteredTex(cacheId, root.tex, cw, ch, key, root.rect || null, root.cs | 0);
      }
      const output = acquireShapeRT(cw, ch);
      clearOutput(output);
      R._compositeFilteredTex(
        root.tex,
        cw,
        ch,
        output.fbo,
        root.rect || null,
        regionPx,
        1,
        grp.shapeIdx,
        true,
        root.cs | 0,
      );
      releaseRoot(_rtPool, root);
      for (const tex of luts) if (tex) deleteGlResource(gl, 'Texture', tex);
      grp.acc = output;
      grp.rect = null;
      return true;
    }
    /// A masked group's accumulator, multiplied by the group's clip and mask coverage: the composited group is masked once
    /// (filter, then clip and mask, then opacity -- Filter Effects 1 §3, Masking 1 §7).
    function _groupMaskOutput(grp, cw, ch) {
      const output = acquireShapeRT(cw, ch);
      const gr = grp.rect;
      bindFb(gl.FRAMEBUFFER, output.fbo);
      R.glViewport(0, 0, cw, ch);
      R.glDepthMask(true);
      gl.clearColor(0, 0, 0, 0);
      // Inside the group's rect only: groupEnd reads nothing outside it, and the accumulator is transparent there anyway.
      if (gr) _pushLocalScissor(gr, output.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      if (gr) _applyTargetScissor(output.fbo);
      R.glDepthMask(false);
      R._compositeFilteredTex(grp.acc.tex, cw, ch, output.fbo, null, gr, 1, grp.effectRow);
      _handle.fillPassAssetDirty = true;
      grp.acc = output;
    }
    /// Composite the accumulator back over the snapshotted backdrop. Returns false
    /// when the stack was empty, so a caller that mis-pairs begin/end fails loudly
    /// rather than compositing someone else's group.
    R._groupEnd = () => {
      let [cw, ch] = viewportSize();
      const grp = _groupStack.pop();
      if (!grp) return false;
      // The parent accumulator is the target for nested groups. The canvas or
      // resource target receives the outermost group.
      R._groupEndFiltered = false;
      if (grp.atlas) return _atlasGroupEnd(grp);
      if (grp.merge) return _mergeEnd(grp);
      if (grp.skip) return _groupSkipEnd(grp, cw, ch);
      if (grp.filterId) R._groupEndFiltered = _groupFilterOutput(grp, cw, ch);
      else if (grp.effectRow >= 0) _groupMaskOutput(grp, cw, ch);
      if (grp.savedAlpha !== null && grp.savedAlpha !== undefined) R.draw.alpha = grp.savedAlpha;
      // A framed group's accumulator now holds the filtered frame. Leave the frame, and hand it to the parent shifted by the margin.
      const fr = grp.frame;
      if (fr) {
        R._exitFilterFrame(fr);
        cw = fr.cw;
        ch = fr.ch;
      }
      const gr = grp.rect;
      const parent =
        _groupStack.length > 0
          ? _groupStack[_groupStack.length - 1].acc
          : _groupBaseTarget
            ? { fbo: _groupBaseTarget }
            : null;
      // A framed group hands its whole frame back: the part of it that lands on the parent (R._frameDest).
      const fd = fr ? R._frameDest(fr, [0, 0, fr.W, fr.H]) : null;
      if (fr && !fd) {
        _handle.fillPassAssetDirty = true;
        return true;
      }
      if (grp.over) {
        // The accumulator is premultiplied. Tint all channels by group opacity
        // before source-over blending into the parent target.
        bindFb(gl.FRAMEBUFFER, parent ? parent.fbo : null);
        // A framed group hands its whole frame back through the frame viewport and map; otherwise a masked group is bounded by a
        // scissor over the canvas-sized viewport (identical pixels, fewer fragments), an unmasked one by its own viewport rect.
        const scOnly = !fd && grp.effectRow >= 0 && !!gr;
        if (fd) R.glViewport(fd.vp[0], fd.vp[1], fd.vp[2], fd.vp[3]);
        else if (gr && !scOnly) R.glViewport(gr[0], gr[1], gr[2], gr[3]);
        else R.glViewport(0, 0, cw, ch);
        const clipOn = scOnly ? R._pushRegionScissor(gr, parent ? parent.fbo : null) : false;
        R.glDisable(gl.DEPTH_TEST);
        R.glDisable(gl.STENCIL_TEST);
        R.glEnable(gl.BLEND);
        R.glBlendEquation(gl.FUNC_ADD);
        R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        R.glUseProgram(R.cacheBlitProg);
        R._forgetFillUnits();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, grp.acc.tex);
        gl.uniform1i(R.cbUCacheTex, 0);
        // The opacity the composite applied (max(uOpacity, 0)), clamped to 1 as well: a tint above 1
        // would leave premultiplied range, which the composite's REPLACE clamped only after the fact.
        const o = isFinite(grp.opacity) ? Math.min(1, Math.max(0, grp.opacity)) : 1;
        gl.uniform4f(R.cbUTint, o, o, o, o);
        // vUV spans the rect; the accumulator is canvas-sized, so map it back to it.
        if (R.cbUInMap) {
          if (fd) gl.uniform4f(R.cbUInMap, fd.map[0], fd.map[1], fd.map[2], fd.map[3]);
          else if (gr && !scOnly)
            gl.uniform4f(R.cbUInMap, gr[2] / cw, gr[3] / ch, gr[0] / cw, gr[1] / ch);
          else gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);
        }
        R.glBindVertexArray(coverVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        R.glBindVertexArray(null);
        if (clipOn) R._popRegionScissor(clipOn, parent ? parent.fbo : null);
        _handle.fillPassAssetDirty = true;
        return true;
      }
      let backdropTex = mainCopyTex;
      if (parent) {
        ensureGroupBackdropTex();
        bindFb(gl.FRAMEBUFFER, parent.fbo);
        R._parkFillActiveUnit();
        gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
        if (gr) gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, gr[0], gr[1], gr[0], gr[1], gr[2], gr[3]);
        else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
        backdropTex = groupBackdropTex;
      } else {
        bindFb(gl.FRAMEBUFFER, null);
      }
      // Composite only over the group's own rect. The accumulator is transparent outside
      // it (nothing drew there) and blendFunc is ONE,ZERO — a REPLACE — so a full-canvas
      // quad would have been rewriting the whole screen with "backdrop, unchanged", every
      // group, every frame.
      if (fd) R.glViewport(fd.vp[0], fd.vp[1], fd.vp[2], fd.vp[3]);
      else if (gr) R.glViewport(gr[0], gr[1], gr[2], gr[3]);
      else R.glViewport(0, 0, cw, ch);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ZERO);
      R.glUseProgram(R.compProg);
      // vUV spans the rect now; both inputs are canvas-sized, so map it back to them. A framed group's accumulator is the frame's: it
      // reads through the frame map, and the backdrop (canvas-sized) through the part of the canvas the viewport covers.
      if (fd) {
        const v = fd.vp;
        if (compUShapeMap) gl.uniform4f(compUShapeMap, fd.map[0], fd.map[1], fd.map[2], fd.map[3]);
        if (compUDstMap) gl.uniform4f(compUDstMap, v[2] / cw, v[3] / ch, v[0] / cw, v[1] / ch);
      } else if (gr) {
        const m = [gr[2] / cw, gr[3] / ch, gr[0] / cw, gr[1] / ch];
        if (compUShapeMap) gl.uniform4f(compUShapeMap, m[0], m[1], m[2], m[3]);
        if (compUDstMap) gl.uniform4f(compUDstMap, m[0], m[1], m[2], m[3]);
      } else {
        COMP_IDENTITY_MAP();
      }
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, grp.acc.tex);
      gl.uniform1i(compUShapeTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, backdropTex);
      gl.uniform1i(compUDstTex, 1);
      gl.uniform1i(compUBlendMode, grp.blendMode | 0);
      gl.uniform1f(compUOpacity, isFinite(grp.opacity) ? grp.opacity : 1);
      R.glBindVertexArray(coverVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      R.glBindVertexArray(null);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      _handle.fillPassAssetDirty = true;
      return true;
    };

    /// PER-LEAF BLEND MODE, extracted so more than one route can perform it.
    ///
    /// A mix-blend-mode leaf renders ALONE into an isolated target and composites
    /// back with a blend equation the fill pass does not have — the same shape as
    /// the offscreen-filter case, and the same reason a single draw cannot express
    /// it. `renderSource` draws the shape into whatever target this binds, so the
    /// caller keeps its own geometry: Slug its cover chunk, the unified route the
    /// vertex range for that one shape.
    R._blendLeaf = (op, renderSource) => {
      const [cw, ch] = viewportSize();
      if (cw < 1 || ch < 1) return false;
      //
      // Out-of-group blend shapes use the plain path: shapeFbo as
      // the isolated RT, mainCopyTex (canvas snapshot) as backdrop,
      // canvas as final target.
      const inGroup = _groupStack.length > 0 || !!_groupBaseTarget;
      // This shape's own rect. A blended leaf pays FOUR operations — snapshot the backdrop,
      // clear the isolated RT, render, composite it back — and only the render is bounded by
      // the shape's cover quad; unbounded, the other three would cover the screen for a shape
      // that might be a badge in a corner. As for the group and the cache blit: bound them by
      // what the shape actually paints.
      // null = could not bound it → full canvas.
      const bRect =
        op.resource || mantleDebugFlag('noGroupRect') ? null : R._contentRectPx(cw, ch, [op]);
      let isolatedFbo, isolatedTex, backdropTex, dstFbo;
      if (inGroup) {
        //
        // THE TARGET HAS DEPTH AND STENCIL, as shapeFbo does out of a group: the source
        // render is an ordinary fill pass (the unified route's depth claim included). A
        // target without them (pingFbo) would leave a translucent leaf's claim inert in a
        // group -- the fill's pieces double-painting every chord they share -- while the
        // same leaf out of a group is claimed. The shape-RT cache's
        // canvas-sized entry, which the in-group filter paths use for the same reason.
        //
        // groupBackdropTex is SEPARATE from mainCopyTex so the
        // canvas-snapshot captured at groupBegin survives until
        // groupEnd composes it back. groupBackdropTex is sampled,
        // not the live shapeFbo — avoids the WebGL feedback loop of
        // reading + writing one FBO.
        // Acquired FIRST: an allocation binds on the scratch unit and rebinds the canvas.
        const iRT = acquireShapeRT(cw, ch);
        ensureGroupBackdropTex();
        R._parkFillActiveUnit();
        gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
        // copyTexSubImage2D reads from the currently-bound framebuffer.
        // Bind the group's accumulator (shapeFbo, or a nested group's
        // own) so the snapshot captures the in-progress group content.
        const accFbo = R._groupTarget();
        bindFb(gl.FRAMEBUFFER, accFbo);
        if (bRect)
          gl.copyTexSubImage2D(
            gl.TEXTURE_2D,
            0,
            bRect[0],
            bRect[1],
            bRect[0],
            bRect[1],
            bRect[2],
            bRect[3],
          );
        else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
        isolatedFbo = iRT.fbo;
        isolatedTex = iRT.tex;
        backdropTex = groupBackdropTex;
        dstFbo = accFbo;
      } else {
        // (Only here: in a group neither is read, and in a filter frame asking for them would re-size what the outer groups still hold.)
        ensureShapeFbo();
        ensureMainCopyTex();
        R._parkFillActiveUnit();
        gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
        if (bRect)
          gl.copyTexSubImage2D(
            gl.TEXTURE_2D,
            0,
            bRect[0],
            bRect[1],
            bRect[0],
            bRect[1],
            bRect[2],
            bRect[3],
          );
        else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
        isolatedFbo = shapeFbo;
        isolatedTex = shapeFboTex;
        backdropTex = mainCopyTex;
        dstFbo = null; // canvas
      }
      _handle.fillPassAssetDirty = true;
      bindFb(gl.FRAMEBUFFER, isolatedFbo);
      R.glViewport(0, 0, cw, ch);
      R.glDepthMask(true);
      gl.stencilMask(0xff);
      gl.clearColor(0, 0, 0, 0);
      gl.clearStencil(0);
      gl.clearDepth(1.0);
      // Clear only the rect. The shape rasterizes inside its cover quad, which is inside
      // the rect, so stale color/depth/stencil outside it is never read or written.
      if (bRect) _pushLocalScissor(bRect, isolatedFbo);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (bRect) _applyTargetScissor(isolatedFbo); // what bindFb left for this offscreen target
      R.glDepthMask(false);
      renderSource(); // the caller decides HOW the shape draws
      bindFb(gl.FRAMEBUFFER, dstFbo);
      if (bRect) R.glViewport(bRect[0], bRect[1], bRect[2], bRect[3]);
      else R.glViewport(0, 0, cw, ch);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glEnable(gl.BLEND);
      R.glBlendEquation(gl.FUNC_ADD);
      R.glBlendFunc(gl.ONE, gl.ZERO); // composite shader emits the
      // final composited result.
      R.glUseProgram(R.compProg);
      // vUV spans the rect; both inputs are canvas-sized, so map it back to them.
      if (bRect) {
        const m = [bRect[2] / cw, bRect[3] / ch, bRect[0] / cw, bRect[1] / ch];
        if (compUShapeMap) gl.uniform4f(compUShapeMap, m[0], m[1], m[2], m[3]);
        if (compUDstMap) gl.uniform4f(compUDstMap, m[0], m[1], m[2], m[3]);
      } else {
        COMP_IDENTITY_MAP();
      }
      R._forgetFillUnits();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, isolatedTex);
      gl.uniform1i(compUShapeTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, backdropTex);
      gl.uniform1i(compUDstTex, 1);
      gl.uniform1i(compUBlendMode, op.blendMode | 0);
      gl.uniform1f(compUOpacity, 1);
      R.glBindVertexArray(coverVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      R.glBindVertexArray(null);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      _handle.fillPassAssetDirty = true;
      return true;
    };

    /// COLRv1 PAINT GRAPH for one glyph, extracted so more than one route can run it.

    /// Renders its sources through the bundle's COVER QUADS, exactly as before —
    /// the silhouette is a coverage mask feeding the graph, not a painted fill, so
    /// there is nothing for the analytic route to contribute inside it.
    ///
    /// Returns false when the op carries no usable graph, so the caller can fall
    /// through to its ordinary handling.
    R._colrLeaf = (op) => {
      if (!(op.colrGraphId && _handle.bundle.colrGraphs)) return false;
      const [cw, ch] = viewportSize();
      if (cw < 1 || ch < 1) return false;
      const entry = _handle.bundle.colrGraphs[op.colrGraphId - 1];
      // Accept both shapes — the rich form { graph, masks } emitted
      // by TextRun, and a bare graph DAG for hand-rolled
      // tests / future emitters.
      const graph = (entry && entry.graph) || entry;
      const maskMap = (entry && entry.masks) || null;
      if (graph && graph.nodes && graph.nodes.length) {
        flushPending();
        R.endFillPass();
        // Inside a group, shapeFbo IS the group accumulator and
        // mainCopyTex holds the canvas snapshot groupEnd composites
        // against — this branch must not clear the former or clobber
        // the latter, and its result must land IN the group. Use the
        // blend branch's arrangement: a target of its own for the
        // silhouette (with depth and stencil, like shapeFbo -- not
        // pingFbo, which has neither), the innermost
        // group's accumulator as dst.
        //
        // No backdrop snapshot. The glyph composites by fixed-function src-over, which reads the
        // destination itself, and the paint graph has no backdrop input.
        const inGrpC = _groupStack.length > 0;
        let colrSrcFbo, colrSrcTex;
        let colrDst = null;
        if (inGrpC) {
          const sRT = acquireShapeRT(cw, ch);
          colrSrcFbo = sRT.fbo;
          colrSrcTex = sRT.tex;
          colrDst = R._groupTarget();
        } else {
          ensureShapeFbo();
          colrSrcFbo = shapeFbo;
          colrSrcTex = shapeFboTex;
        }
        _handle.fillPassAssetDirty = true;
        // Render the primary glyph silhouette into the silhouette FBO.
        // Primary mask = the silhouette referenced by the top-level
        // PaintGlyph (or the bare top-level outline when none wraps).
        bindFb(gl.FRAMEBUFFER, colrSrcFbo);
        R.glViewport(0, 0, cw, ch);
        R.glDepthMask(true);
        gl.stencilMask(0xff);
        gl.clearColor(0, 0, 0, 0);
        gl.clearStencil(0);
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        R.glDepthMask(false);
        R.beginFillPass();
        _drawCoverChunk(op.chunk, op.shapeIdx);
        R.endFillPass();

        // (This compared the key with the PRIMARY SHAPE INDEX + 1, so a PaintGlyph whose glyph id happened to be
        // shapeIdx + 1 -- gid 1 under the first shape of a bundle -- clipped by the base glyph's outline instead of its own.)
        // Mask keys: the glyph id for an unplaced outline, "gid#n" for one emitted under a paint transform
        // (font/textColrEmit.js placeColrTransforms). A numeric key stays a number, as the handlers look it up.
        const glyphAlphaMasks = new Map();
        const maskRTIdxs = [];
        if (maskMap) {
          for (const keyStr of Object.keys(maskMap)) {
            const maskShapeIdx = maskMap[keyStr];
            const maskChunk = _handle.bundle.chunkByShape[maskShapeIdx];
            if (!maskChunk) continue;
            const key = /^\d+$/.test(keyStr) ? +keyStr : keyStr;
            if (maskShapeIdx === op.shapeIdx /* the primary silhouette, already rendered */) {
              glyphAlphaMasks.set(key, colrSrcTex);
              continue;
            }

            const rtIdx = _rtPool.acquire(cw, ch);
            maskRTIdxs.push(rtIdx);
            const rt = _rtPool.get(rtIdx);
            bindFb(gl.FRAMEBUFFER, rt.fbo);
            R.glViewport(0, 0, cw, ch);
            R.glDepthMask(true);
            gl.stencilMask(0xff);
            gl.clearColor(0, 0, 0, 0);
            gl.clearStencil(0);
            gl.clearDepth(1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            R.glDepthMask(false);
            R.beginFillPass();
            _drawCoverChunk(maskChunk);
            R.endFillPass();
            glyphAlphaMasks.set(key, rt.tex);
          }
        }
        // Read the shape's runColor from the meta (fillColor at texel 1).
        const mb = op.shapeIdx * _handle.bundle.metaFloatsPerShape;
        const runColor = [
          _handle.bundle.metaFloats[mb + 4],
          _handle.bundle.metaFloats[mb + 5],
          _handle.bundle.metaFloats[mb + 6],
          _handle.bundle.metaFloats[mb + 7],
        ];
        // Where the graph goes. The graph has its own PAINT space: a TextRun glyph's is
        // its design grid, placed on the bundle by entry.placement; a bare graph's is bundle em. The
        // glyph's silhouette went through the shape's override, the bundle's fit and the draw's world
        // matrix, so the graph goes through the same chain (R._shapeToPx), taken as the affine it is --
        // three points. (A world matrix with perspective is not affine; the paint then follows its
        // affine part.) The paint handlers map each target's vUV into paint space through this, so a
        // gradient's points, radii and angles keep the meaning the font gave them.
        const toPx = R._shapeToPx(op.shapeIdx, cw, ch);
        const o0 = toPx(0, 0),
          o1 = toPx(1, 0),
          o2 = toPx(0, 1);
        const emToPx = [o1[0] - o0[0], o1[1] - o0[1], o2[0] - o0[0], o2[1] - o0[1], o0[0], o0[1]];
        const placement =
          entry && Array.isArray(entry.placement) && entry.placement.length >= 6
            ? entry.placement
            : null;
        const paintToPx = placement ? affMul(emToPx, placement) : emToPx;
        // Node rects: every node renders into a target covering only the canvas region it must fill
        // (colrNodeBoxes: what its consumers read, within where it can be non-zero), not the canvas.
        // A PaintGlyph is bounded by the silhouette it clips by, which the leaf rendered from that
        // glyph's shape -- the primary's for a gid it has no mask of, as the handler does.
        const meta = _handle.bundle.metaFloats,
          mfs = _handle.bundle.metaFloatsPerShape;
        const shapeBoxPx = (si) => {
          const b = si * mfs;
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const [ex, ey] of [
            [meta[b], meta[b + 1]],
            [meta[b + 2], meta[b + 1]],
            [meta[b], meta[b + 3]],
            [meta[b + 2], meta[b + 3]],
          ]) {
            const [px, py] = toPx(ex, ey);
            if (px < x0) x0 = px;
            if (py < y0) y0 = py;
            if (px > x1) x1 = px;
            if (py > y1) y1 = py;
          }
          return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
        };
        const primaryBox = shapeBoxPx(op.shapeIdx);
        const glyphBoxOf = (gid) => {
          const si =
            maskMap &&
            (typeof gid === 'number' || typeof gid === 'string') &&
            glyphAlphaMasks.has(gid)
              ? maskMap[gid]
              : op.shapeIdx;
          return si === op.shapeIdx ? primaryBox : shapeBoxPx(si);
        };
        const pxInv = affInv(paintToPx); // the handlers conjugate the same way (colrPaintShared.pxAffine)
        const pxAff = graph.nodes.map((nd) =>
          pxInv && nd.type === 'PaintTransform' && nd.params && nd.params.affine
            ? affMul(affMul(paintToPx, nd.params.affine), pxInv)
            : null,
        );
        const boxes = colrNodeBoxes(graph, {
          canvasW: cw,
          canvasH: ch,
          affineOf: (i) => pxAff[i],
          glyphBoxOf,
        });
        // GL rects (origin bottom-left) with the filter route's padding, quantum and even origins. A node
        // nothing reads gets a token target: whatever it holds, no consumer's needed region sees it.
        const nodeRects = boxes.map((bb) => R._bboxToRect(bb, ch) || [0, 0, 2, 2]);
        const ctx = {
          gl,
          pool: _rtPool,
          coverVao,
          w: cw,
          h: ch,
          paintToPx,
          analyticPaintTransforms: true,
          glyphAlphaTex: colrSrcTex,
          glyphAlphaMasks,
          runColor,
          // Bundle's shared gradient-stops LUT — same texture the
          // SVG fill walker (ray-cast) reads from. Per-node (stopsOffset,
          // stopsCount) in node.params resolve to slices of this
          // texture, single source of truth across SVG and COLR.
          gradientStopsTex: _handle.bundle.gradientStopsTex || null,
          paintLinearGradProg,
          paintLinearGradU,
          paintRadialGradProg,
          paintRadialGradU,
          paintSweepGradProg,
          paintSweepGradU,
          paintTransformProg,
          paintTransformU,
          paintGlyphProg,
          paintGlyphU,
          paintCompositeProg,
          paintCompositeU,
          feCompositeProg,
          feCompositeU: feCompositeProg
            ? {
                uIn1: fcUIn1,
                uIn2: fcUIn2,
                uIn1Map: fcUIn1Map,
                uIn2Map: fcUIn2Map,
                uOp: fcUOp,
                uK: fcUK,
                uPD: fcUPD,
              }
            : null,
          bundle: _handle.bundle,
        };
        // Filter-graph dispatch binds pool RTs directly on `gl` —
        // those binds bypass bindFb, so disable SCISSOR_TEST here so
        // the user scissor doesn't crop the graph's intermediate RTs.
        // The post-eval bindFb(FRAMEBUFFER, null) below restores it.
        // (The rule for an offscreen target: off, or a pipeline warm's pixel.)
        _applyTargetScissor(colrSrcFbo);
        const rootRT = evaluateGraph(gl, graph, _rtPool, _colrDispatch, ctx, cw, ch, nodeRects);
        // Free per-gid mask RTs back to the pool.
        for (const rtIdx of maskRTIdxs) _rtPool.release(rtIdx);
        // Free any lazy stops textures created for synthetic nodes
        // that carried inline stops (test-only path; production
        // nodes use the bundle-resolved stopsOffset/stopsCount).
        if (ctx._lazyStopsTextures) {
          for (const tex of ctx._lazyStopsTextures) deleteGlResource(gl, 'Texture', tex);
        }
        bindFb(gl.FRAMEBUFFER, colrDst);
        // Over the ROOT's rect: the quad spans it and reads the root's target 1:1.
        const rootR = rootRT.rect || [0, 0, cw, ch];
        R.glViewport(rootR[0], rootR[1], rootR[2], rootR[3]);
        R.glDisable(gl.DEPTH_TEST);
        R.glDisable(gl.STENCIL_TEST);
        R.glEnable(gl.BLEND);
        R.glBlendEquation(gl.FUNC_ADD);
        R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        // The blend above IS premultiplied src-over, so the program hands it the glyph's texture and
        // nothing else. compProg in normal mode already src-overed against a backdrop snapshot, which
        // applied the backdrop twice wherever its alpha is fractional.
        R.glUseProgram(R.cacheBlitProg);
        R._forgetFillUnits();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, rootRT.tex);
        gl.uniform1i(R.cbUCacheTex, 0);
        gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
        if (R.cbUInMap) gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);
        R.glBindVertexArray(coverVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        R.glBindVertexArray(null);
        releaseRoot(_rtPool, rootRT); // hand the root back — see the SVG route
        _handle.fillPassAssetDirty = true;
        return true;
      }
      return false; // no usable graph on this op — caller handles it normally
    };
    let _pendingStart = -1,
      _pendingEnd = -1;

    let _pendingFill = false,
      _pendingStroke = false;

    // Reusable scratch for overlay draws.
    const _triOverlayPts = new Float32Array(6);
    const _bboxOverlayPts = new Float32Array(8);

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------
    // Shared 2-element scratch (see viewportSize note). Every arScale caller
    // destructures immediately; none retains the array.
    const _arScaleScratch = [0, 0];
    function arScale(bbox, vw, vh) {
      const cAR = vw / vh,
        sAR = bbox[2] / bbox[3];
      let sx = 1,
        sy = 1;
      if (sAR > cAR) sy = cAR / sAR;
      else sx = sAR / cAR;
      _arScaleScratch[0] = sx;
      _arScaleScratch[1] = sy;
      return _arScaleScratch;
    }

    function applyBlendMode(mode) {
      R.glBlendEquation(gl.FUNC_ADD);
      switch (mode) {
        case 1:
          R.glBlendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
          break;
        case 2:
          R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
          break;
        case 4:
          R.glBlendEquation(gl.MIN);
          R.glBlendFunc(gl.ONE, gl.ONE);
          break;
        case 5:
          R.glBlendEquation(gl.MAX);
          R.glBlendFunc(gl.ONE, gl.ONE);
          break;
        default:
          R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }

    // ------------------------------------------------------------
    // Direct raster blit (R.createImage / R.drawImage)
    // ------------------------------------------------------------
    // Lets a consumer composite a raster image straight into the
    // current frame without wrapping it in a minimal SVG + re-importing a
    // bundle. Mirrors the drawBundle frame-lifecycle contract: compose
    // between beginFrame/endFrame, or call standalone (caller owns
    // viewport/clear).
    //
    // Images upload PREMULTIPLIED to match the renderer's standard
    // blendFunc(ONE, ONE_MINUS_SRC_ALPHA) compositing.

    function flushPending() {
      if (_pendingStart < 0) return;
      R.beginFillPass();
      _drawCoverRange(_pendingStart, _pendingEnd - _pendingStart, _pendingFill, _pendingStroke);
      _pendingStart = -1;
      _pendingEnd = -1;
      _pendingFill = false;
      _pendingStroke = false;
    }

    /** Upload cover-quad + matching shapeIdx planes onto the active handle.
     *  shapeIdx is always sized to the vert count — attrib 7 stays enabled. */
    function _uploadCoverMesh(h, bundle) {
      const vboVerts = bundle.coverQuadVboFloats || bundle.coverQuadFloats;
      if (!vboVerts) {
        h.coverVertCount = 0;
        h.coverStripped = false;
        return;
      }
      if (h._ensureCoverResources) h._ensureCoverResources();
      const stripped = !!bundle.coverQuadVboFloats;
      const coverVertCount = (vboVerts.length / 12) | 0;
      uploadBuffer(gl, h.triBuf, vboVerts, gl.STATIC_DRAW); // (cooperative in the loading call: coopUpload.js)
      let vboSidx = stripped
        ? bundle.hybridShapeIdxVboFloats
        : bundle.hybridShapeIdxFloats || bundle.hybridShapeIdxVboFloats;
      if (!vboSidx || (vboSidx.length | 0) < coverVertCount) {
        const padded = new Float32Array(coverVertCount);
        if (vboSidx) padded.set(vboSidx.subarray(0, Math.min(vboSidx.length, coverVertCount)));
        vboSidx = padded;
      } else if ((vboSidx.length | 0) > coverVertCount) {
        vboSidx = vboSidx.subarray(0, coverVertCount);
      }
      uploadBuffer(gl, h.shapeIdxBuf, vboSidx, gl.STATIC_DRAW);
      h.coverVertCount = coverVertCount;
      h.coverStripped = stripped;
      h.coverStartAt = null; // the bundle's own layout
      h.coverLayoutList = null;
    }

    /// Lay the handle's cover buffer out for the draw list the cover pass is about to walk (planCoverLayout): the chunks the
    /// list leaves out, such as rows the occlusion cull dropped, move behind the painted ones, so the painted ones merge into
    /// one drawArrays. Only the vertices that move are uploaded, once per change of the list; the bundle's planes are never
    /// rewritten (a nine-slice instance shares them). A list that brings back rows kept hidden comes and goes with the
    /// override that reveals them, so it walks the layout it finds rather than re-laying the buffer at each reveal.
    function _layCoverForDrawList(h, b) {
      if (h.coverLayoutList === b.drawList || b._keptShown) return;
      const verts = b.coverQuadVboFloats,
        sidx = b.hybridShapeIdxVboFloats;
      if (!verts || !sidx || !h.coverStripped || !h.triBuf || !h.shapeIdxBuf) return;
      // a loading-call fill still queued for this buffer would write the bundle's layout over the moved span
      if (uploadQueued(gl, h.triBuf) || uploadQueued(gl, h.shapeIdxBuf)) return;
      h.coverLayoutList = b.drawList;
      const chunks = b.coverQuadChunks;
      const plan = planCoverLayout(chunks, b.drawList, h.coverStartAt);
      if (!plan || plan.hi * 12 > verts.length || plan.hi > sidx.length) return;
      const { lo, hi, startAt } = plan;
      const v = new Float32Array((hi - lo) * 12),
        s = new Float32Array(hi - lo);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i],
          to = startAt ? startAt[i] : c.vboStart;
        if (to < lo || to >= hi) continue;
        v.set(verts.subarray(c.vboStart * 12, (c.vboStart + c.count) * 12), (to - lo) * 12);
        s.set(sidx.subarray(c.vboStart, c.vboStart + c.count), to - lo);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, h.triBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, lo * 48, v);
      gl.bindBuffer(gl.ARRAY_BUFFER, h.shapeIdxBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, lo * 4, s);
      h.coverStartAt = startAt;
      h.coverLayoutChunks = chunks;
    }

    /// Re-upload the header-free VBO planes (see bundleHandle.js) so a streamed / nine-sliced re-derive keeps chunk vboStart in sync, then lay
    /// them out for the draw list. The fill pass's first draw and the pipeline warm (fillPass warm1) both run it: a warm against the handle's
    /// empty mesh drew nothing.
    function _uploadCoverMeshIfDirty() {
      if (!_handle || !(_handle.bundle.coverQuadVboFloats || _handle.bundle.coverQuadFloats))
        return;
      if (_handle.hybridMeshDirty) {
        _uploadCoverMesh(_handle, _handle.bundle);
        _handle.hybridMeshDirty = false;
      }
      _layCoverForDrawList(_handle, _handle.bundle);
    }
    R._uploadCoverMeshIfDirty = _uploadCoverMeshIfDirty;

    /** Chunk first-vert index for the currently uploaded cover VBO. */
    function _coverChunkStart(chunk) {
      if (!chunk) return -1;
      if (chunk._stripOn && _handle && _handle.coverStripped) return chunk._strip.start | 0; // the strip, when this draw allows it
      if (_handle && _handle.coverStripped) {
        // Stripped uploads omit chunk headers, so the original `start` would
        // address beyond the compact VBO on large Slug fallbacks.
        return chunk.vboStart != null ? chunk.vboStart | 0 : -1;
      }
      return (chunk.vboStart != null ? chunk.vboStart : chunk.start) | 0;
    }
    /** Chunk first-vert index in the active handle's cover buffer, which _layCoverForDrawList may have laid out for its draw list. */
    function _coverDrawStart(chunk) {
      const lay = _handle && _handle.coverStartAt;
      if (lay && chunk && !(chunk._stripOn && _handle.coverStripped)) {
        const i = chunk._ci;
        if (_handle.coverLayoutChunks[i] === chunk) return lay[i];
      }
      return _coverChunkStart(chunk);
    }

    function _coverRowIsStroke(shapeIdx) {
      const b = _handle && _handle.bundle;
      if (!b || shapeIdx == null || (shapeIdx | 0) < 0) return null;
      const meta = b.metaFloats,
        st = b.metaFloatsPerShape | 0;
      if (!meta || !st) return null;
      return isStrokeRow(meta, st, shapeIdx | 0);
    }

    /** Clamp + draw a cover-quad range against the uploaded vert count. */
    function _drawCoverRange(start, count, hasFill, hasStroke) {
      if (!_handle || !_handle.triVao) return;
      if (R._fillDeclined) return; // beginFillPass deferred this pass: no program is ready, and no draw waits for one
      // Always rebind — beginFillPass may have early-returned while another
      // path left a different VAO bound.
      R.glBindVertexArray(_handle.triVao);
      const maxV = _handle.coverVertCount | 0 || 0;
      let s = start | 0,
        c = count | 0;
      if (maxV <= 0 || c <= 0 || s < 0) return;
      if (s >= maxV) return;
      if (s + c > maxV) {
        if (typeof console !== 'undefined') {
          console.warn(
            '[mantle] cover draw clamped ' +
              c +
              ' → ' +
              (maxV - s) +
              ' verts @' +
              s +
              ' (VBO has ' +
              maxV +
              ')',
          );
        }
        c = maxV - s;
      }
      if (c > 0) {
        const stripClaim =
          _handle.bundle &&
          _handle.bundle._stripModeNow === 2 &&
          R.opts.unifiedFillDepthClaim !== false;
        if (stripClaim) {
          gl.depthRange(0.0, 0.99);
          gl.clearDepth(1.0);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          R.glEnable(gl.DEPTH_TEST);
          R.glDepthFunc(gl.LESS);
          R.glDepthMask(true);
        }
        gl.drawArrays(gl.TRIANGLES, s, c);
        if (stripClaim) {
          R.glDepthFunc(gl.LEQUAL);
          R.glDepthMask(!R._opaquePrepassActive);
          gl.depthRange(0.0, 1.0);
        } // the fill pass's own depth state, which stays enabled
        // A COVER QUAD IS SHADED BY A KERNEL, and which kernel is the engine: the kernel of the program
        // beginFillPass BOUND. That is not always the one preferAac and the no-AA gates decided on --
        // until a decided variant links and its pipeline warms, the base program draws -- so the record
        // comes from the bound program's defines (coverKernelOfVariantKey), not from _autoEngine.
        //
        if (R._engines) {
          const kern = R._lastDrawnCoverKernel || ENGINES.SLUG;
          if (!hasFill && !hasStroke) R._engines.drew(kern, ROUTES.COVER);
          else {
            if (hasFill) R._engines.drew(kern, ROUTES.COVER);
            // A pinned CPatch that reached the cover pass did not draw: its build has not landed, or the route could not take this bundle.
            if (hasFill && R.opts.cpatchFill === true && !R._psoWarming)
              R._engines.declined(
                ENGINES.CPATCH,
                _handle.bundle._cpatchBuilt ? DECLINE.UNSUPPORTED : DECLINE.PENDING,
              );
            if (hasStroke) R._engines.drew(ENGINES.STROKE, ROUTES.COVER);
          }
        }
      }
    }

    // Exposed for unifiedFillDraw: it needs the same chunk->vertex-range
    // resolution the per-chunk draws use, or its cover-quad entries index
    // the wrong vertices. It reads the bundle's planes, so it gets the
    // bundle's layout, not a handle's (_coverDrawStart).
    R._coverChunkStart = _coverChunkStart;
    function _coverChunkCount(chunk) {
      return (
        (chunk._stripOn && _handle && _handle.coverStripped ? chunk._strip.count : chunk.count) | 0
      );
    }
    R._coverChunkCount = _coverChunkCount;
    function _drawCoverChunk(chunk, shapeIdx) {
      const s = _coverDrawStart(chunk);
      if (s < 0 || !chunk) return;
      const st = _coverRowIsStroke(shapeIdx);
      _drawCoverRange(s, _coverChunkCount(chunk), st === false, st === true);
    }

    // ------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------

    // createBundleHandle — per-bundle state handle (VAO/VBO, mask-region walk,
    // per-handle static cache, per-mount draw()) — see bundleHandle.js.

    function _refreshBoundHandle(h, bundle) {
      h.fillPassAssetDirty = true;
      const gen9 = bundle._geomGen | 0;
      if ((h._boundGeomGen | 0) !== gen9) {
        h._boundGeomGen = gen9;
        h.maskRegions = computeMaskRegions(bundle);
        h.hybridMeshDirty = !!bundle.coverQuadFloats;
        h.generation++;
        if (h.cache) h.cache.invalidate();
      }
      fillPassCanvasW = 0;
      fillPassCanvasH = 0;
    }

    function _isTransientHandle(h) {
      return !!(h && h.bundle && _transientHandles.get(h.bundle) === h);
    }

    function _disposeTransientHandles() {
      for (const [b, h] of _transientHandles) {
        if (b._disposeHooks) b._disposeHooks.delete(_onBundleDisposed);
        h.dispose();
      }
      _transientHandles.clear();
      _boundTransient = null;
    }

    /// A bundle's dispose() calls this (bundle._disposeHooks). The bounded handle cache is a strong Map keyed by bundle, so
    /// a disposed bundle would otherwise stay in it (with its CPU planes) until eight newer bundles pushed it out, and its
    /// handle kept the cover VBO, the filter-result cache and the static-cache RT alive for just as long.
    function _onBundleDisposed(bundle) {
      const h = _transientHandles.get(bundle);
      if (!h) return;
      _transientHandles.delete(bundle);
      if (_handle === h) _handle = null;
      if (_boundTransient === h) _boundTransient = null;
      h.dispose();
    }

    /// A bundle whose handle aged out of the bounded cache keeps its filter-result entries (an alternating scene hits them on its
    /// next visit), so it keeps a LIGHT dispose hook: bundle.dispose() purges the entries of its owner key and nothing else.
    /// Weakly held, so an evicted bundle that is never disposed is not kept alive by this renderer.
    const _evictedHooked = new Set();
    function _onEvictedBundleDisposed(bundle) {
      _evictFilterCache('b' + bundle.uid);
    }
    /// Keep one weak reference per bundle and sweep dead references when the set doubles.
    const _evictedSeen = new WeakSet();
    let _evictedSweepAt = 256;
    function _hookEvicted(bundle) {
      (bundle._disposeHooks || (bundle._disposeHooks = new Set())).add(_onEvictedBundleDisposed);
      if (_evictedSeen.has(bundle)) return;
      _evictedSeen.add(bundle);
      if (_evictedHooked.size >= _evictedSweepAt) {
        for (const r of _evictedHooked) if (!r.deref()) _evictedHooked.delete(r);
        _evictedSweepAt = Math.max(256, _evictedHooked.size * 2);
      }
      _evictedHooked.add(new WeakRef(bundle));
    }
    function _unhookEvicted() {
      for (const r of _evictedHooked) {
        const b = r.deref();
        if (b && b._disposeHooks) b._disposeHooks.delete(_onEvictedBundleDisposed);
        if (b) _evictedSeen.delete(b);
      }
      _evictedHooked.clear();
      _evictedSweepAt = 256;
    }

    /// Note a bind of transient handle `h`: the frame that bound it (inside a beginFrame / endFrame pair only), or, while no frame has
    /// ever run, the time (the budget's in-use test reads the time only then, so a framed draw does not pay for a clock read).
    function _touchTransient(h) {
      if (R._frameOpen) h._wsFrame = R._frameSerial | 0;
      else if (!(R._frameSerial > 0)) h._wsTime = _nowMs();
    }
    function _retireTransient(bundle, h) {
      _transientHandles.delete(bundle);
      if (h === _handle) _handle = null;
      if (h === _boundTransient) _boundTransient = null;
      if (bundle._disposeHooks) bundle._disposeHooks.delete(_onBundleDisposed);
      // Filter-output residency is independently bounded above. Keep it when
      // this geometry handle ages out so an alternating scene can still hit
      // a static filter result on its next visit; the bundle's dispose purges it (_hookEvicted).
      h.dispose({ retainFilterCache: true });
      _hookEvicted(bundle);
    }
    /// Evict handles bound before frame `keepFrom`, least recently bound first, until `room` more fit under the bound.
    function _trimTransientHandles(room, keepFrom) {
      if (_transientHandles.size + room <= MAX_TRANSIENT_HANDLES) return;
      for (const [b, h] of _transientHandles) {
        if (_transientHandles.size + room <= MAX_TRANSIENT_HANDLES) break;
        if (h._wsFrame >= keepFrom || h === _handle || h === _boundTransient) continue;
        _retireTransient(b, h);
      }
    }
    /// The endFrame safe point: handles beyond the bound that neither this frame nor the previous one bound go.
    R._transientTrim = () => _trimTransientHandles(0, (R._frameSerial | 0) - 1);
    /// The memory budget's evictor: drop transient handles the current frame has not bound, least recently bound first, never the bound
    /// one and never one holding a static cache (setBundle + enableStaticCache: its raster is not evictable). `heldBytes` reads the
    /// context's allocation total. Returns the bytes freed.
    R._memEvictTransientHandles = (need, inUse, heldBytes) => {
      let freed = 0;
      for (const [b, h] of [..._transientHandles]) {
        if (freed >= need) break;
        if (h === _handle || h === _boundTransient || h.cache || inUse(h._wsFrame, h._wsTime))
          continue;
        const before = heldBytes();
        _retireTransient(b, h);
        freed += before - heldBytes();
      }
      return freed;
    };

    function _getTransientHandle(bundle, deferCoverUpload) {
      let h = _transientHandles.get(bundle);
      if (h) {
        _transientHandles.delete(bundle);
        _transientHandles.set(bundle, h);
        _touchTransient(h);
        return h;
      }
      // The first frame whose handles the bound keeps: inside a frame, the previous frame's (a handle it bound may be bound again
      // later in this one); between frames, the frame just drawn (the next frame's working set).
      _trimTransientHandles(1, (R._frameSerial | 0) - (R._frameOpen ? 1 : 0));
      h = R.createBundleHandle(bundle, {
        filterCacheOwner: 'b' + bundle.uid,
        deferCoverUpload: !!deferCoverUpload,
      });
      h._wsFrame = -1;
      h._wsTime = 0;
      _touchTransient(h);
      _transientHandles.set(bundle, h);
      if (bundle._disposeHooks) bundle._disposeHooks.delete(_onEvictedBundleDisposed);
      (bundle._disposeHooks || (bundle._disposeHooks = new Set())).add(_onBundleDisposed);
      return h;
    }

    function setBundle(bundle, opts) {
      // A disposed renderer must not allocate: setBundle would make a transient handle (a VAO and two buffers) that
      // nothing frees. A disposed bundle has no textures to bind; binding one would allocate a handle that draws a feedback loop.
      if (_disposed) return;
      if (bundle && bundle._disposed) return;
      if (_handle && _handle.bundle === bundle) {
        if (_transientHandles.get(bundle) === _handle) _touchTransient(_handle);
        _refreshBoundHandle(_handle, bundle);
        return;
      }
      if (!bundle) {
        if (_handle && !_isTransientHandle(_handle)) _handle.dispose();
        _handle = null;
        _disposeTransientHandles();
        fillPassCanvasW = 0;
        fillPassCanvasH = 0;
        return;
      }
      if (_handle && !_isTransientHandle(_handle)) _handle.dispose({ retainFilterCache: true });
      // TEST-only MUTATION (under __MANTLE_DEBUG__): `__MANTLE_MUTATE = 'coverDirty'` drops a bundle's resident handle (its cover VAO and buffers) each time the other bundle drew
      // in between, so the cover resources are rebuilt on every visit (instancedCompactCacheNodeSmoke proves the retention guard fails under it).
      if (mantleDebugHook('__MANTLE_MUTATE') === 'coverDirty') {
        const stale = _transientHandles.get(bundle);
        if (stale && stale !== _handle) {
          _transientHandles.delete(bundle);
          if (_handle === stale) _handle = null;
          if (_boundTransient === stale) _boundTransient = null;
          stale.dispose({ retainFilterCache: true });
        }
      }
      _handle = _boundTransient = _getTransientHandle(bundle, opts && opts.deferCoverUpload);
      _refreshBoundHandle(_handle, bundle);
    }

    /// The public render(): the frame-slack tick first, then the frame. drawBundle and
    /// drawBundleInstanced tick at their entry (drawDispatch warmTick), and render() is the third
    /// frame entry -- the one setBundle + render() consumers, svgRenderBench and the demo drive.
    /// Without the tick a fill variant is compiled but never promoted and its pipeline never warmed,
    /// so every frame of such a consumer would draw with the UNIVERSAL fill program: over twenty
    /// times the SPIR-V instructions of the specialized variant, and on simple art, where one draw
    /// shades most of the canvas, several times the GPU time. The internal fallbacks in drawDispatch call the
    /// body below directly: they run after drawBundle's own tick.
    ///
    /// A pipeline warm draws the bundle it warms through setBundle, so the binding the caller made
    /// is put back after the tick; render(target) binds its target itself. Only a STANDALONE
    /// render() ticks: inside beginFrame / endFrame, beginFrame has ticked, and a standalone render()
    /// clears the canvas after the tick (the warm's one scissored pixel never survives the frame).
    /// The tick does not make the variant immediate: its pipeline is built in frame slack (~0.75 s at
    /// 60 fps) or at the warm deadline (fillPass.js); precompileFills() at load does it up front.

    /// THE FRAME-ENTRY CONTRACT, which every entry keeps:
    ///   * the COLOR CLEAR belongs to a FRAME, never to a draw: beginFrame(clearColor) clears (null keeps the
    ///     canvas), and a standalone render() is a one-bundle frame that clears to white once, here, before any
    ///     route -- the static cache's blit included. drawBundle, drawBundleInstanced, drawInstance and handle.draw
    ///     never clear color, on any route (the body's Slug fallback did, so a bare drawBundle cleared the canvas
    ///     on Slug and not on Loop-Blinn, and an instanced loop cleared before every instance). Depth and stencil
    ///     are reset per bundle everywhere, as before;
    ///   * the WARM TICK runs once per frame at the frame's entry and before its clear: beginFrame ticks then
    ///     clears, a standalone render() ticks then clears. A pipeline warm DRAWS only there -- at an entry that then
    ///     clears the canvas it drew its one pixel on: any other entry outside a frame (a bare
    ///     drawBundle, drawInstance, handle.draw, beginFrame(null)) links and promotes but draws no warm, since
    ///     nothing would take the pixel back: it readies the variant without a draw (fillPass _readyBundleNoDraw), and
    ///     the next real draw builds the pipeline. So do the warms the renderer forces from inside a draw (morphDraw).
    ///     The load-time calls still draw theirs, for the first frame's clear to take back: precompileFills always, and
    ///     awaitLbReady only while its bundle's variant is not yet usable (under variantFirst it is a no-op when the
    ///     lean variant already is: its warm checks _fillVariantHasLbFill first). Inside a frame a draw entry only counts the frame (drawDispatch warmTick): a tick there drew its
    ///     one-pixel pipeline warm over the frame, after beginFrame's clear;
    ///   * the OVERRIDE TABLE is resolved the same way everywhere (drawDispatch resolveOverrides): the one the
    ///     caller passes, else the target's own -- a morph's fade. render(morph) drew the morph with no table, so
    ///     both poses' unmatched shapes at full strength, where drawBundle(morph) faded them.
    function renderEntry(target) {
      // As drawBundle does: a disposed target draws nothing and says so. setBundle refuses it and leaves the last bundle bound, which this entry then drew in its place.
      if (target !== undefined && target !== null) {
        const db = target.bundle !== undefined ? target.bundle : target;
        if (target._disposed || (db && db._disposed)) {
          disposedBundleDraw(R, 'render', db || target);
          return;
        }
      }
      if (!_contextLost && !_canvasUnsized() && !_inFrame && R._warmTick) {
        const keep = _handle && _handle.bundle;
        // this ENTRY CLEARS THE CANVAS (below) when it has a bundle to draw and the canvas is its target, and then --
        // only then -- its tick may draw a pipeline warm there first.
        const tb =
          target !== undefined && target !== null
            ? target.bundle !== undefined
              ? target.bundle
              : target
            : keep;
        R._warmTick(!!tb && !R._cacheBakingNow && !R._boundDrawFbo);
        if (keep && !keep._disposed && (!_handle || _handle.bundle !== keep)) setBundle(keep);
      }
      if (_contextLost || _canvasUnsized() || R._cacheBakingNow) return render(target);
      if (target !== undefined && target !== null) {
        const tb = target.bundle !== undefined ? target.bundle : target;
        if (tb) setBundle(tb);
      }
      const h = _handle,
        bundle = h && h.bundle;
      if (!bundle) return render();
      // A standalone frame: clear once, then draw as inside a frame, so a nested body run (the analytic
      // route's per-shape Slug fallback) resets depth and stencil but never clears the color it drew.
      const standalone = !_inFrame;
      if (standalone) {
        _clearTarget(true);
        _targetCleared = true;
        _inFrame = true;
      }
      const clipWas = _ds.extClipTex;
      const clipModeWas = _ds.extClipMode;
      const ovWas = _ds.overrides;
      if (!ovWas) _ds.overrides = resolveOverrides(bundle);
      if (R._noteDrawIdle) R._noteDrawIdle(bundle, _ds.overrides, _ds.worldM, _ds.alpha);
      try {
        if (h.cache && !mantleDebugFlag('noStaticCache')) {
          const lvl = R._cacheTick();
          h._decidedLevel9 = lvl; // the body consumes this instead of ticking again
          if (
            lvl === CacheLevel.WholeAsset ||
            lvl === CacheLevel.ViewportWindow ||
            lvl === CacheLevel.SharedGroup
          )
            return render();
        }
        if (R._autoNodeClip) R._autoNodeClip(bundle);
        if (
          R._aacPointsFirst &&
          R._aacPointsFirst(bundle, () => {
            // the row gate's mesh runs: this entry's own analytic route, else the live cover draw
            if (_analyticRoute(bundle, { bare: !(target && target.bundle !== undefined) }))
              R._drawDebugOverlays(bundle, true);
            else render();
          })
        ) {
          // only primitives on the analytic route (aacPointsDraw.js)
          h._decidedLevel9 = undefined;
          return;
        }
        if (_analyticRoute(bundle, { bare: !(target && target.bundle !== undefined) })) {
          h._decidedLevel9 = undefined;
          R._drawDebugOverlays(bundle, true);
          return;
        }
        if (!R._lbSlugFallback || (R._aacPointsRoute && R._aacPointsRoute(bundle))) {
          h._decidedLevel9 = undefined;
          return;
        }
        return render();
      } finally {
        _targetCleared = false;
        if (standalone) _inFrame = false;
        _ds.extClipTex = clipWas;
        _ds.extClipMode = clipModeWas;
        _ds.overrides = ovWas;
      }
    }
    // Clear the draw target's depth and stencil, and with `color` its color to white: the body's
    // per-bundle reset, which renderEntry performs up front for a standalone frame.
    let _targetCleared = false;
    function _clearTarget(color) {
      gl.clearStencil(0);
      gl.clearDepth(1.0);
      R.glDepthMask(true);
      if (color) {
        gl.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      } else {
        gl.clear(gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      }
      R.glDepthMask(false);
    }

    function render(target) {
      // Context lost: every GL handle is dangling. Skip the frame rather
      // than submit draws the GPU process will reject (mailbox spam).
      if (_contextLost) return;
      // Canvas not laid out yet (0×0): skip rather than allocate + submit
      // zero-sized targets that race the compositor on startup.
      if (_canvasUnsized()) return;
      // Optional target: rebind before rendering. Lets the demo + the
      // visual smokes do `renderer.render(morph)` after `morph.setT(t)`
      // without remembering to call setBundle, and also keeps a stable
      // binding when a timeline internally rebuilds its morph at a
      // bracket boundary. No-arg form preserves the prior contract.
      if (target !== undefined && target !== null) {
        const b = target.bundle !== undefined ? target.bundle : target;
        if (b) setBundle(b);
      }
      if (!_handle || !_handle.bundle) return;

      // In-place geometry rewrite detection for the PERSISTENT-handle flow.
      // setBundle's same-bundle fast path already re-uploads on a
      // bundle._geomGen bump, but handle.draw() enters here directly (no
      // setBundle), so an applyNineSlice re-slice or a textBundle
      // identity-stable setText on a handle-bound bundle would otherwise
      // draw the stale VBO. Compare generations every render; on change,
      // re-upload the mesh, refresh globalBBox-dependent uniforms, bump the
      // handle generation (mask bake / instanced-compact keys) and drop any
      // static-cache bake.
      {
        const genR = _handle.bundle._geomGen | 0;
        if ((_handle._boundGeomGen | 0) !== genR) {
          _handle._boundGeomGen = genR;
          _handle.hybridMeshDirty = !!_handle.bundle.coverQuadFloats;
          _handle.fillPassAssetDirty = true;
          _handle.generation++;
          if (_handle.cache) _handle.cache.invalidate();
          fillPassCanvasW = 0;
          fillPassCanvasH = 0;
        }
      }

      //
      // Cache state lives on the handle (multi-bundle scenes get
      // per-mount caching). The handle IS the bundle; a bundle swap creates
      // a new handle, hence a new cache RT, which can't be stale relative
      // to its handle's bundle.
      // A cached handle whose bundle takes the LB route never reaches render(), so
      // its cache could not tick there — the cost gate would never run and the cache
      // never engage (LB winning unconditionally). handle.draw() ticks FIRST so the
      // cache can COMPETE with LB, and hands the decision down here. When it
      // pre-decided, consume that; otherwise (bare drawBundle / setBundle) decide here.
      /** @type {number} */
      let level = CacheLevel.None;
      if (_handle._decidedLevel9 !== undefined) {
        level = _handle._decidedLevel9;
        _handle._decidedLevel9 = undefined;
      } else if (!R._cacheBakingNow && _alphaRedirect === null) {
        // (never tick inside a bake re-entry — that would nest cache decisions; nor inside a group-alpha draw, which composes live)
        if (_handle.cache) level = R._cacheTick();
      }
      if (_handle.cache && !R._cacheBakingNow && _alphaRedirect === null) {
        if (
          level === CacheLevel.WholeAsset ||
          level === CacheLevel.ViewportWindow ||
          level === CacheLevel.SharedGroup
        ) {
          // A sibling baked over the shared raster since this member took it: this member's own flag cannot say, and it would go on blitting the sibling's picture.
          if (
            level === CacheLevel.SharedGroup &&
            _handle.cache.isCacheValid &&
            _handle.cache.groupRasterStale()
          )
            _handle.cache.invalidateLocal();
          if (
            level === CacheLevel.SharedGroup &&
            !_handle.cache.isCacheValid &&
            _handle.cache.isGroupCacheValid(_handle._cacheContentKey)
          ) {
            const [acw, ach] = viewportSize();
            if (
              R._cacheEnsureFbo(acw, ach) &&
              _handle.cache.isGroupCacheValid(_handle._cacheContentKey)
            ) {
              _handle.cache.markBaked(R._cacheFrameSeq, undefined, _handle._cacheContentKey);
              _handle.cacheBakeCw = acw;
              _handle.cacheBakeCh = ach;
              _handle.cacheBakeDrawHash = _handle._pendingDrawHash;
              _handle.cacheBakeGeomGen = _handle.bundle._geomGen | 0;
              _handle.cacheContentRect = _handle.cache.groupContentRect();
            }
          }
          if (!_handle.cache.isCacheValid) {
            if (!R._cacheBakeAndBlit()) {
              // Bake failed → fall back to live this frame (a faded draw of a cached mount draws live as the group it is).
              const tint = R._cacheTint;
              if (tint < 1) {
                R._cacheTint = 1;
                R.draw.alpha = tint;
                let g = null;
                try {
                  g = R._alphaGroupBegin(_handle.bundle);
                  _renderCanvasInner();
                  if (g) {
                    const t = g;
                    g = null;
                    R._alphaGroupEnd(t);
                  }
                } finally {
                  if (g) R._alphaGroupAbort(g);
                }
              } else _renderCanvasInner();
              return;
            }
          }
          R._cacheBlitToCanvas();
          R._cacheFrameSeq++;
          return;
        }
        // Level.None → fall through to live render.
      }

      _renderCanvasInner();
    }

    // The original render() body. Extracted so the cache bake path
    // can re-enter it with a different framebuffer + viewport bound,
    // and the live-render path can call it directly.
    // Retire the occlusion cull once a per-shape override could change what covers what.
    //
    // A whole-bundle worldMatrix is safe — an affine map preserves containment — and the streaming
    // path already retires the cull when geometry moves (streamGeometry.js:357). This is the
    // remaining hole.
    //
    // Retirement is PERMANENT for the bundle rather than per draw: a bundle being animated through
    // overrides will keep being animated, so re-deciding every frame would burn the scan for
    // nothing, and it keeps the swap free of save/restore and re-entrancy hazards. Once retired the
    // first test below short-circuits, so the scan costs nothing thereafter.
    function _retireCullIfOverridden() {
      const b = _handle && _handle.bundle;
      if (!b || !b.drawListUnculled || b._cullRetired) return;
      // Nothing to retire yet when the list is whole, unless the worker half of the cull is still on its way.
      const cut = b.drawList !== b.drawListUnculled;
      if (!cut && !b._occlusionCullPending) return;
      const ov = _ds.overrides;
      const ovP = ov && ov.packedBuffer;
      if (!ovP) return;
      // Only re-scan when the override state actually moved. Without this, a table carrying only
      // color changes never retires the cull and so re-scans every shape on every draw forever.
      // `revision` advances at the mutation; `generation` only when the draw uploads it, which is AFTER this check, so a set()
      // made since the last draw would otherwise read as "unchanged" for one frame (the first draw painted the culled list).
      const ovGen = ov.revision !== undefined ? ov.revision | 0 : ov.generation | 0;
      if (b._cullOvScanGen === ovGen && b._cullOvScanTable === ov) return;
      b._cullOvScanGen = ovGen;
      b._cullOvScanTable = ov;
      // 24 floats/shape: 0..3 affine (a,b,c,d), 4..5 (tx,ty), 6 visibility, 7 overrideMask,
      // 8..11 tint rgba. Anything that can shrink, move, hide or fade a shape invalidates a
      // containment decision; a pure color change cannot, but an ALPHA change can, so tint.a and
      // the absolute-override mask (which can carry a fill alpha) both count.
      const n = b.numShapes | 0;
      let affects = false;
      for (let s = 0; s < n; s++) {
        const o = s * 24;
        // (Exact: the translation is in the document's units, so a tolerance on it is a distance that means something else on every drawing. An identity row holds exactly these values.)
        if (
          ovP[o] !== 1 ||
          ovP[o + 1] !== 0 ||
          ovP[o + 2] !== 0 ||
          ovP[o + 3] !== 1 ||
          ovP[o + 4] !== 0 ||
          ovP[o + 5] !== 0 ||
          ovP[o + 6] < 0.9999 ||
          ovP[o + 7] !== 0 ||
          ovP[o + 11] < 0.9999
        ) {
          affects = true;
          break;
        }
      }
      if (!affects) return;
      b._cullRetired = true; // the kill-switch tick and a late worker cull leave it retired
      if (!cut) return;
      b._drawListCulled = b.drawList;
      b.drawList = b.drawListUnculled;
      b._cullGen = (b._cullGen | 0) + 1; // draw-list derivatives must rebuild
    }
    // The cull decides a shape is hidden by a later opaque shape wherever that shape is; a sprite draw shows only its own rows, so a
    // row cut for an occluder in another sprite would vanish. A sprite draw whose range holds a cut row retires the cull, as an
    // override does; the range is remembered so a worker answer that lands later is held to the same rule (bundle.js).
    function _retireCullForSprite(b, sr) {
      if (!b || !sr || !b.drawListUnculled || b._cullRetired) return;
      const seen = b._cullSpriteRanges || (b._cullSpriteRanges = []);
      if (!seen.some((r) => r[0] === sr[0] && r[1] === sr[1])) seen.push([sr[0], sr[1]]);
      const cutSet = b._culledShapes;
      if (!cutSet || !cutSet.size) return;
      for (const i of cutSet)
        if (i >= sr[0] && i <= sr[1]) {
          b._cullRetired = true;
          break;
        }
      if (!b._cullRetired || b.drawList === b.drawListUnculled) return;
      b._drawListCulled = b.drawList;
      b.drawList = b.drawListUnculled;
      b._cullGen = (b._cullGen | 0) + 1;
    }
    R._retireCullForSprite = _retireCullForSprite;

    R._ensureMaskBake = () => {
      if (!_handle) return;
      // Multi-shape mask offscreen bake. Runs before the
      // main draw list so mantle.frag can sample uMaskRTArray when a shape
      // carries a maskId pointing at a region with a baked layer.
      if (R.maskBakeProg && _handle.maskRegions.length) {
        // Skip the bake when the existing R._maskRTArray is still
        // valid for this handle (same geometry generation, same canvas size,
        // same resource overrides, morph pose and world matrix. Unchanged
        // draws reuse the layers; resource animation invalidates them.
        const [cw, ch] = viewportSize();
        const maskFeedGen = R._maskFeedShapeGen();
        // A morph rewrites live curve/meta textures without changing mesh generation.
        const maskMorphT = _handle.bundle._morphSrc ? _handle.bundle._morphSrc.t : null;
        const slot = R._selectMaskSlot(_handle, !!(R._filterFrameTop && R._filterFrameTop()));
        const world = R.draw.worldM;
        let worldValid = !world && !slot.validWorld;
        if (world && slot.validWorld) {
          worldValid = true;
          for (let i = 0; i < 9; i++)
            if (world[i] !== slot.validWorld[i]) {
              worldValid = false;
              break;
            }
        }
        const maskValid =
          slot.arr &&
          slot.validGen === _handle.generation &&
          slot.validCanvas[0] === cw &&
          slot.validCanvas[1] === ch &&
          slot.validShapeGen === maskFeedGen &&
          slot.validMorphT === maskMorphT &&
          worldValid;
        if (!maskValid) {
          const defM = R._deferTotal();
          R.bakeMaskRegions();
          _maskBakeCount++;
          // A mask bake whose program is not ready (or whose fills deferred) drew nothing: the slot is not valid, the next frame bakes again.
          if (R._bakeJustDeferred || R._deferTotal() !== defM) {
            slot.validGen = -1;
            return;
          }
          // Pipeline warming may scissor the bake; it cannot validate a full mask image.
          if (R._psoWarming || R._warmScissor) {
            slot.validGen = -1;
            return;
          }
          slot.validGen = _handle.generation;
          slot.validCanvas[0] = cw;
          slot.validCanvas[1] = ch;
          slot.validShapeGen = maskFeedGen;
          slot.validMorphT = maskMorphT;
          if (world) {
            if (!slot.validWorld) slot.validWorld = new Float64Array(9);
            slot.validWorld.set(world);
          } else slot.validWorld = null;
          // The bake rewrote bundle texture bindings; force the fill pass
          // to rebind on next R.beginFillPass().
          _handle.fillPassAssetDirty = true;
        }
      }
    };

    function _renderCanvasInner() {
      if (!_handle || !_handle.bundle) return;
      if (R._wmNote) R._wmNote(); // warm manifest recording (a no-op unless the renderer was created with recordWarmManifest)
      _retireCullIfOverridden();
      // `let`: a framed filtered group (R._groupBegin) changes the viewport for the span of its children, and this walk follows it.
      let [cw, ch] = viewportSize();
      R.glViewport(0, 0, cw, ch);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      //
      // never THE COLOR (the frame-entry contract at renderEntry): beginFrame owns the color clear, and a
      // standalone public render() has already made it, before choosing the route.
      if (_targetCleared) _targetCleared = false;
      else _clearTarget(false);
      _uploadCoverMeshIfDirty();
      // Write depth only for occupancy's certified opaque interiors. The
      // analytic pass below remains responsible for all color and AA edges.
      // ON by default; createRenderer({ opaquePrepass: false }) opts out. Depth-only: the output is identical with it off by construction.
      if (R.runOpaquePrepass && R.opts.opaquePrepass !== false) R.runOpaquePrepass(_handle);
      R._ensureMaskBake();
      R.endFillPass();

      const groupStack = _groupStack;
      const groupDepth0 = groupStack.length; // a group-alpha draw (R._alphaGroupBegin) is open under this walk: it is not ours to close
      const drawList = _handle.bundle.drawList;
      const laidOut = !!_handle.coverStartAt; // (a bundle in its own layout pays no per-row lookup)
      const paintOrderStack = [];
      let previousPaintRow = -1;
      for (let di = 0; di < drawList.length; di++) {
        const op = drawList[di];
        if (op.kind === 'groupBegin') {
          if (R._groupOutsideDraw(_handle.bundle, op)) {
            for (let gd = 1, gi = di + 1; gi < drawList.length; gi++) {
              const k = drawList[gi].kind;
              if (k === 'groupBegin') gd++;
              else if (k === 'groupEnd' && --gd === 0) {
                di = gi;
                break;
              }
            }
            continue;
          }
          paintOrderStack.push(previousPaintRow);
          previousPaintRow = -1;
          if (R._mergeSkip()) continue; // inside a merged run: the leaves of every group reach one draw
          flushPending();
          R.endFillPass();
          // The group's child ops, for the content rect. Walked here because only
          // this loop knows where it stands in the list.
          let _gOps = null,
            _gDepth = 1;
          for (let gi = di + 1; gi < drawList.length; gi++) {
            const go = drawList[gi];
            // (a nested filtered group stays in the list: its filter paints past its leaves, so the outer rect cannot be bounded by them)
            if (go.kind === 'groupBegin') {
              _gDepth++;
              if (go.filterId) (_gOps || (_gOps = [])).push(go);
              continue;
            }
            if (go.kind === 'groupEnd') {
              if (--_gDepth === 0) break;
              continue;
            }
            (_gOps || (_gOps = [])).push(go);
          }
          if (R._groupBegin(op, _gOps)) {
            // the group's cached filter result stands in for its children: step to its groupEnd
            for (let gd = 1, gi = di + 1; gi < drawList.length; gi++) {
              const k = drawList[gi].kind;
              if (k === 'groupBegin') gd++;
              else if (k === 'groupEnd' && --gd === 0) {
                di = gi - 1;
                break;
              }
            }
          }
          [cw, ch] = viewportSize();
          continue;
        }
        if (op.kind === 'groupEnd') {
          previousPaintRow = paintOrderStack.pop() ?? -1;
          if (R._mergeSkip()) continue;
          flushPending();
          R.endFillPass();
          if (!R._groupEnd()) continue;
          [cw, ch] = viewportSize();
          continue;
        }
        // Sprite-subset draw: every op below here is a shape op (carries
        // op.shapeIdx). Skip those outside the requested sprite range. Group
        // begin/end ops above are kept so a sprite that DOES contain a nested
        // group still composites correctly (a filtered group with nothing of
        // the sprite in it is stepped over, above); flat sprites (the common sheet
        // case) have none. Placed after group handling, before any per-shape
        // work (mask/filter eval, chunk draw) so skipped shapes cost nothing.
        if (_ds.shapeRange) {
          const si = op.shapeIdx | 0;
          if (si < _ds.shapeRange[0] || si > _ds.shapeRange[1]) continue;
        }
        // COLRv1 paint-graph path: opt-in via op.colrGraphId. TextRun
        // sets this on color-glyph shapes; the coverage-rendered silhouette
        // becomes the alpha mask for the graph's PaintGlyph nodes, and
        // the graph (gradients / transforms / composites) supplies the
        // color. Mirrors the filterGraphId branch with two changes:
        //   - dispatch = _colrDispatch (PaintSolid/gradients/Transform/
        //     Glyph/Merge/Composite handlers)
        //   - ctx.glyphAlphaTex = shapeFboTex (the coverage silhouette)
        //   - ctx.runColor = meta fillColor (for PaintSolid foreground)
        // The graph is placed with the glyph (entry.placement through the
        // shape's own em -> px chain) and each node renders into a target
        // covering its own rect (bbox.js colrNodeBoxes).
        if (op.colrGraphId && _handle.bundle.colrGraphs && R._colrLeaf(op)) continue;
        // Composable filter-graph path: opt-in via op.filterGraphId. The
        // importer sets this on shapes whose <filter> can't be reduced to a
        // single kind (multi-primitive chains like blur→colorMatrix, or
        // primitives the kind path doesn't cover — feTurbulence,
        // feDisplacementMap, etc.). Single-kind filters fall through to the
        // direct-dispatch fast path below.
        //
        // Architectural note: this branch and the kind-dispatch branch are
        // deliberately not deduplicated. The two paths have different
        // GL-state semantics (pool RTs vs dedicated shapeFbo) and
        // a shared helper costs correctness for marginal LOC. Speed lens:
        // single-primitive filters (the common case) never pay the graph
        // refcount walk or pool acquire overhead.
        if (op.filterGraphId && _handle.bundle.filterGraphs) {
          const graph = _handle.bundle.filterGraphs[op.filterGraphId - 1];
          if (graph && graph.nodes && graph.nodes.length) {
            const outputOpacity = R._filterOutputOpacity(op.shapeIdx | 0, op.filterGraphId);
            if (!(outputOpacity > 0)) continue;
            // A shape that crosses the canvas edge filters in a FRAME (the canvas plus the margin the graph reaches): inside it, cw/ch are the
            // frame's and every hand-off back to the target shifts by the margin (filterFrame.js). Null = the canvas, and nothing below changes.
            const _ffG = R._filterFrameFor(op.shapeIdx | 0, cw, ch, graph, null);
            const _cwG = cw,
              _chG = ch;
            if (_ffG) {
              flushPending();
              R.endFillPass();
              R._enterFilterFrame(_ffG);
            }
            try {
              const cw = _ffG ? _ffG.W : _cwG,
                ch = _ffG ? _ffG.H : _chG;
              // These inputs are not represented in the result-cache key. A
              // filtered SourceGraphic is cacheable only when it is self-contained.
              // ...and they are the only reason to snapshot the backdrop.
              const _readsBackdrop = R._graphReadsBackdrop(graph);
              const _filterCacheable = R._filterCacheable(_handle.bundle, graph); // shared with the unified route
              // Tier-2b filter result cache. The filter OUTPUT (rootRT) is a
              // pure function of (the feeding shape's geometry+overrides,
              // worldMatrix, canvas). Build the key; on a hit, skip the
              // source render + evaluateGraph and composite the cached
              // texture. feedShape = op.shapeIdx (the single SourceGraphic
              // shape). The composite still re-runs (the backdrop changes).
              const fKey = {
                gen: _handle.generation,
                // Geometry-change tokens: _geomGen (streamed bare bundles via
                // markGeometryDirty) AND the morph parameter t (createShapeMorph's
                // setT uploads new curves but does NOT bump _geomGen). WITHOUT these a
                // morphing/streamed filtered shape freezes at the first frame's cached
                // filter output (the rest of the key is geometry-invariant).
                geomGen: _handle.bundle ? _handle.bundle._geomGen | 0 : 0,
                morphT: _handle.bundle && _handle.bundle._morphSrc ? _handle.bundle._morphSrc.t : 0,
                cw,
                ch,
                wmHash: R._wmHash(_ds.worldM),
                shapeGen: R._rowFeedKey(_ds.overrides, op.shapeIdx | 0),
                recolor: R._recolorHash(),
                // createFilterParams' write token. The graph's nodes are read fresh
                // at every evaluation, so a changed sigma needs nothing but a reason
                // to re-evaluate; without this term there would be none.
                paramGen: _handle.bundle ? _handle.bundle._filterParamGen | 0 : 0,
                frameKey: _ffG ? _ffG.key : '',
              };
              // Filter graph IDs are bundle-local and a graph may feed more than one
              // shape. Keep an output per feeding shape; otherwise two shapes sharing a
              // graph evict each other on every frame.
              const fCacheId =
                'g' + _handle._filterCacheOwner + '_' + op.filterGraphId + '_' + (op.shapeIdx | 0);
              const cached = _getFilterCache(fCacheId);
              // An active palette LUT is mutable with no version token, so a
              // cached filtered tex can't be trusted across palette draws —
              // bar the hit (the recolor hash already separates palette rows).
              // The entry's w/h are its TEXTURE's — which is the filter's bbox, not the
              // canvas. Don't compare them to the canvas; a canvas resize is already a
              // key mismatch (the key carries cw/ch), and re-checking it here against a
              // bbox-sized texture is a guard that can never pass.
              const filterHit = _filterCacheable && R._filterKeyMatches(cached, fKey) && cached.tex;
              // Inside a group: shapeFbo is the accumulator and mainCopyTex
              // the canvas snapshot groupEnd needs — see the blend branch.
              const inGrpF = groupStack.length > 0;
              // The <filter> region clips the COMPOSITE, not the stored texture, so a cache hit has to
              // pass it exactly like the miss below or the clip holds for one frame and is gone after.
              const fRegionPx = R._filterRegionRectPx(op.shapeIdx | 0, cw, ch);
              if (filterHit) {
                // Composite the cached filtered tex -- into the group accumulator in a group, onto the
                // canvas otherwise, at the rect it was filtered at. No backdrop snapshot: the composite
                // is fixed-function src-over, and a hit never reads BackgroundImage (a graph that does
                // is not cacheable).
                flushPending();
                R.endFillPass();
                R._compositeFilteredTex(
                  cached.tex,
                  cw,
                  ch,
                  R._groupTarget(),
                  cached.rect || null,
                  fRegionPx,
                  outputOpacity,
                );
                _handle.fillPassAssetDirty = true;
                continue;
              }
              flushPending();
              R.endFillPass();

              const _fInfo = R._filterNodeRects(graph, op.shapeIdx | 0, cw, ch);
              const _fRects = _fInfo ? _fInfo.rects : null;
              const _fSubregions = _fInfo ? _fInfo.subregions : null;
              if (_fRects) _filterBboxActiveCount++;
              const _rootRect = _fRects ? _fRects[graph.rootOut] : null;
              // BackgroundImage / BackgroundAlpha read the backdrop AS A GRAPH INPUT, and
              // may sample it anywhere — so that one case still needs the whole canvas.
              // Can the shape render into an RT covering only its own rect? Not inside a
              // group (shapeFbo is the accumulator there, and canvas-sized by nature).
              const _srcRect =
                !inGrpF && _fInfo && _fInfo.source && !_readsBackdrop && _rootRect
                  ? _fInfo.source
                  : null;

              // The BACKDROP is snapshotted only for a graph that reads it (BackgroundImage /
              // BackgroundAlpha), where it is a graph INPUT. The composite below never reads it -- it is
              // fixed-function src-over -- so for every other graph the copy would be a full-canvas copy
              // per filtered shape per frame with no reader. In a group the backdrop is the
              // accumulator so far; outside one, the canvas.
              let fSrcFbo,
                fSrcTex,
                fBackdrop = null,
                fDst = null;
              let fSrcRect = null;
              if (inGrpF) {
                // The SourceGraphic renders into a canvas-sized target of its own, with the depth
                // and stencil the fill pass has everywhere else (not pingFbo, which has neither).
                // Acquired before the snapshot below: an allocation rebinds the canvas.
                const sRT = acquireShapeRT(cw, ch);
                fDst = R._groupTarget();
                if (_readsBackdrop) {
                  ensureGroupBackdropTex();
                  R._parkFillActiveUnit();
                  gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
                  bindFb(gl.FRAMEBUFFER, fDst);
                  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
                  fBackdrop = groupBackdropTex;
                }
                fSrcFbo = sRT.fbo;
                fSrcTex = sRT.tex;
              } else if (_srcRect) {
                // (Only reachable when the graph does NOT read the backdrop -- see _srcRect.)
                const sRT = acquireShapeRT(_srcRect[2], _srcRect[3]);
                fSrcFbo = sRT.fbo;
                fSrcTex = sRT.tex;
                fSrcRect = _srcRect;
              } else if (_ffG) {
                // The frame is not the canvas, so the canvas-sized shapeFbo is the wrong size (and re-sizing it per draw would thrash it).
                // A pooled target of the frame's own size; a framed graph never reads the backdrop.
                const sRT = acquireShapeRT(cw, ch);
                fSrcFbo = sRT.fbo;
                fSrcTex = sRT.tex;
              } else {
                ensureShapeFbo();
                fSrcFbo = shapeFbo;
                fSrcTex = shapeFboTex;
                if (_readsBackdrop) {
                  // Snapshot main FB → mainCopyTex (BackgroundImage for the graph).
                  ensureMainCopyTex();
                  R._parkFillActiveUnit();
                  gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
                  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
                  fBackdrop = mainCopyTex;
                }
              }
              _handle.fillPassAssetDirty = true;
              // Render the shape alone into the SourceGraphic FBO (sentinel -1).
              bindFb(gl.FRAMEBUFFER, fSrcFbo);
              // Same projection, TRANSLATED: a viewport at -rect.origin puts canvas pixel
              // (x,y) at RT texel (x-rx, y-ry), so the shape lands in a small RT with no
              // change to any clip-space math. gl_FragCoord is then rect-local, so the
              // fill shader is told where its framebuffer sits (uFragOrigin) — it samples
              // canvas-space textures (mask, external clip, coverage RTs) by it.
              if (fSrcRect) {
                R.glViewport(-fSrcRect[0], -fSrcRect[1], cw, ch);
                R._fragOrigin = fSrcRect;
              } else {
                R.glViewport(0, 0, cw, ch);
              }
              const def0F = R._deferTotal(); // a deferral under this source draw or the graph leaves an incomplete result: never cache it
              R.glDepthMask(true);
              gl.stencilMask(0xff);
              gl.clearColor(0, 0, 0, 0);
              gl.clearStencil(0);
              gl.clearDepth(1.0);
              gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
              R.glDepthMask(false);
              const unitPaint = unitCoverageShadow(graph)
                ? R._filterSourceMaterial(op.shapeIdx, 1 / outputOpacity)
                : null;
              const proposedOpacity = unitPaint?.materialHi[3];
              const unitOpacity =
                proposedOpacity > 0 &&
                proposedOpacity <= 1 &&
                Number.isFinite(1 / (outputOpacity * proposedOpacity))
                  ? proposedOpacity
                  : 1;
              const previousInputScale = R._filterInputScale,
                previousCoverageScale = R._filterCoverageScale;
              R._filterInputScale = 1 / outputOpacity;
              R._filterCoverageScale = 1 / unitOpacity;
              try {
                R.beginFillPass();
                _drawCoverChunk(op.chunk, op.shapeIdx);
                R.endFillPass();
              } finally {
                R._filterInputScale = previousInputScale;
                R._filterCoverageScale = previousCoverageScale;
              }

              const _pxPerEm = R._filterPxPerEm(cw, ch, op.shapeIdx);
              // No backdrop RT at all for a graph that does not read one: the inputs that would
              // sample it (svgFilterShared.resolveInputTex) are exactly the ones it lacks.
              const ctx = R._buildFilterCtx(
                cw,
                ch,
                _pxPerEm,
                {
                  fbo: fSrcFbo,
                  tex: fSrcTex,
                  size: fSrcRect ? [fSrcRect[2], fSrcRect[3]] : [cw, ch],
                  rect: fSrcRect || [0, 0, cw, ch],
                },
                fBackdrop
                  ? { fbo: null, tex: fBackdrop, size: [cw, ch], rect: [0, 0, cw, ch] }
                  : null,
                op.shapeIdx,
                _handle.bundle,
                1 / outputOpacity,
              );
              ctx.unitCoverageOpacity = unitOpacity;
              const unitGraph =
                unitOpacity === 1
                  ? graph
                  : {
                      ...graph,
                      nodes: graph.nodes.map((n, i) =>
                        i !== 2
                          ? n
                          : {
                              ...n,
                              params: {
                                ...n.params,
                                rgba: n.params.rgba.map((v, j) => (j === 3 ? v * unitOpacity : v)),
                              },
                            },
                      ),
                    };
              // Per-eval lookup textures for feComponentTransfer nodes.
              // Each node's params.lutBytes (256×4 RGBA8) is uploaded into
              // its own short-lived texture; dispatched in handler order
              // by params.lutIndex. Released after evaluateGraph below.
              const ctLUTs = [];
              for (const n of graph.nodes) {
                if (n.type !== 'feComponentTransfer') {
                  ctLUTs.push(null);
                  continue;
                }
                const bytes = n.params && n.params.lutBytes;
                if (!bytes) {
                  ctLUTs.push(null);
                  continue;
                }
                const tex = trackGlResource(gl, gl.createTexture(), 'filterScratch');
                R._parkFillActiveUnit();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(
                  gl.TEXTURE_2D,
                  0,
                  gl.RGBA8,
                  256,
                  4,
                  0,
                  gl.RGBA,
                  gl.UNSIGNED_BYTE,
                  ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes),
                );
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                n.params.lutIndex = ctLUTs.length;
                ctLUTs.push(tex);
              }
              ctx.componentTransferLUTs = ctLUTs;
              // Per-node filter SUBREGIONS (unpadded, unquantized, GL space). Only
              // feTurbulence's stitch reads them; everything else addresses by RT rect.
              ctx.nodeSubregions = _fSubregions;
              // Where each external feImage draws (subregion + fitted image, canvas px).
              ctx.feImagePlacements = R._feImagePlacements(graph, op.shapeIdx | 0, cw, ch);
              // Same as the COLR branch — pause the user scissor across the
              // filter-graph dispatch; the post-eval bindFb(FRAMEBUFFER, null)
              // below restores it for the composite-back step.
              _applyTargetScissor(fSrcFbo);
              // Restrict each full-canvas pass to its propagated output bbox
              // (the device-pixel region where it can be non-zero), so a small
              // filtered shape on a large canvas skips out-of-bbox fragment
              // work. null = no safe bound (region-filling generator) → full
              // canvas, current behavior.
              const rootRT = evaluateGraph(
                gl,
                unitGraph,
                _rtPool,
                _svgDispatch,
                ctx,
                cw,
                ch,
                _fRects,
              );
              _filterEvalCount++;
              // Release per-eval LUT textures.
              for (const tex of ctLUTs) {
                if (tex) deleteGlResource(gl, 'Texture', tex);
              }
              // Tier-2b: retain the output only when the hit gate can later use
              // it. Backdrop-dependent and per-draw-dependent graphs are live by
              // definition; copying their transient root into a persistent cache
              // texture every frame only adds an allocation and a full blit.
              if (_filterCacheable && R._deferTotal() === def0F) {
                R._storeFilteredTex(
                  fCacheId,
                  rootRT.tex,
                  cw,
                  ch,
                  fKey,
                  rootRT.rect || null,
                  rootRT.cs | 0,
                );
              }
              // Composite the graph's root output back to the target (main FB,
              // or the group accumulator when in a group). Normal src-over
              // against the existing backdrop — the graph is expected to emit
              // premultiplied RGBA per CSS Filter Effects §11.
              R._compositeFilteredTex(
                rootRT.tex,
                cw,
                ch,
                fDst,
                rootRT.rect || null,
                fRegionPx,
                outputOpacity,
                -1,
                false,
                rootRT.cs | 0,
              );
              // The root is ours until here; give it back or the pool allocates a fresh
              // one for the next evaluation, every frame, forever.
              releaseRoot(_rtPool, rootRT);
              _handle.fillPassAssetDirty = true;
              continue;
            } finally {
              if (_ffG) R._exitFilterFrame(_ffG);
            }
          }
        }
        // 'fillShape' — possibly filtered. Color-matrix (kind=0 or absent)
        // is applied inline in mantle.frag; nothing special needed. kind>=1
        // (blur / morphology / convolve) needs an offscreen FBO route:
        // draw the single shape into shapeFbo, run filter pass, composite
        // back into the main FB. Per-filterId flattening.
        if (op.filterId) {
          const f = R.filterRecord(op.filterId);
          if (f && f.kind >= 1) {
            // The single-primitive twin of the graph route's frame (see there).
            const _ffK = R._filterFrameFor(op.shapeIdx | 0, cw, ch, null, f);
            const _cwK = cw,
              _chK = ch;
            flushPending();
            R.endFillPass();
            if (_ffK) R._enterFilterFrame(_ffK);
            try {
              const cw = _ffK ? _ffK.W : _cwK,
                ch = _ffK ? _ffK.H : _chK;

              const inGrpK = groupStack.length > 0;

              const px = R._filterPxPerEm(cw, ch, op.shapeIdx);
              const pxPerEmX = px[0],
                pxPerEmY = px[1];
              // Outside a group the shape can render into an RT covering only itself,
              // dilated by the kernel's reach — no canvas-sized anything.
              const skRect = inGrpK
                ? null
                : R._filterSingleKindRect(op.shapeIdx | 0, cw, ch, f, pxPerEmX, pxPerEmY);
              // No backdrop snapshot on any branch: every single-kind composite below is
              // fixed-function src-over, which reads the destination itself, and no kernel
              // reads a backdrop.
              // (In a group the target is acquired on the miss path below: a hit never renders.)
              let kTarget = null;
              if (!skRect && !inGrpK && !_ffK) ensureShapeFbo();
              // Force a full asset rebind on the upcoming fill pass so the
              // textures the allocations above bound on a high unit don't leak
              // through.
              _handle.fillPassAssetDirty = true;
              // Tier-2b single-kind filter cache (the COMMON blur path). The
              // filtered shapeFboTex is a pure function of (feeding shape
              // geometry+overrides, worldMatrix → pxPerEm, canvas). Cache it,
              // keyed like the graph path. On a hit, restore those FBO
              // textures and skip the source render + the (expensive,
              // multi-pass) blur — the kind-specific composite below runs
              // unchanged. Keyed per (filterId, shapeIdx) so two shapes
              // sharing a filter id each get their own cached output.
              const skId =
                'k' + _handle._filterCacheOwner + '_' + op.filterId + '_' + (op.shapeIdx | 0);
              const skKey = {
                gen: _handle.generation,
                geomGen: _handle.bundle ? _handle.bundle._geomGen | 0 : 0,
                morphT: _handle.bundle && _handle.bundle._morphSrc ? _handle.bundle._morphSrc.t : 0,
                cw,
                ch,
                wmHash: R._wmHash(_ds.worldM),
                shapeGen: R._rowFeedKey(_ds.overrides, op.shapeIdx | 0),
                recolor: R._recolorHash(),
                // ...and the same token on the single-primitive route, where the
                // numbers live in lastFilterFloats and filterRecord re-reads them
                // every frame.
                paramGen: _handle.bundle ? _handle.bundle._filterParamGen | 0 : 0,
                frameKey: _ffK ? _ffK.key : '',
              };
              // The cached texture is the FILTERED shape, so it is the size of the target
              // it was filtered in — the kernel's rect, not the canvas.
              const skW = skRect ? skRect[2] : cw,
                skH = skRect ? skRect[3] : ch;
              let skEntry = _getFilterCache(skId);
              // The region clips every composite below, hit or miss, in a group or not (see fRegionPx).
              const skRegionPx = R._filterRegionRectPx(op.shapeIdx | 0, cw, ch);
              // The rule every route shares (R._filterCacheable). A draw it refuses neither hits nor
              // stores: such an entry could only ever be read by a draw it is wrong for.
              const skCacheable = R._filterCacheable(_handle.bundle, null);
              const skHit =
                skCacheable &&
                R._filterKeyMatches(skEntry, skKey) &&
                skEntry.shapeTex &&
                (skRect ? !!skEntry.rect : !skEntry.rect && skEntry.w === skW && skEntry.h === skH);
              if (skHit) {
                if (inGrpK) {
                  // Don't blit into shapeFbo (the group accumulator) —
                  // composite the cached filtered tex straight into it.
                  R._filterSingleKindComposite(
                    f,
                    cw,
                    ch,
                    skEntry.shapeTex,
                    R._groupTarget(),
                    null,
                    skRegionPx,
                  );
                } else if (skRect) {
                  // Straight from the cache to the canvas: no blit through a scratch RT,
                  // and only the shape's own rect is touched.
                  R._filterSingleKindComposite(
                    f,
                    cw,
                    ch,
                    skEntry.shapeTex,
                    null,
                    skEntry.rect,
                    skRegionPx,
                  );
                } else {
                  // Straight from the cache to the canvas, as the rect branch does. Blitting
                  // it into shapeFbo first would buy nothing: the composite reads its source
                  // texture 1:1 and no backdrop.
                  R._filterSingleKindComposite(f, cw, ch, skEntry.shapeTex, null, null, skRegionPx);
                }
                _handle.fillPassAssetDirty = true;
                continue;
              }
              if (skRect) {
                // (The rect's targets are acquired here, on the miss: a hit composites the cached texture and never renders.)
                const sRT = acquireShapeRT(skRect[2], skRect[3]);
                const pRT = acquirePingRT(skRect[2], skRect[3], f.linear);
                kTarget = {
                  fbo: sRT.fbo,
                  tex: sRT.tex,
                  pingFbo: pRT.fbo,
                  pingTex: pRT.tex,
                  pingLin: !!pRT.lin,
                  w: skRect[2],
                  h: skRect[3],
                };
              } else if (inGrpK || _ffK) {
                const sRT = acquireShapeRT(cw, ch);
                const pRT = acquirePingRT(cw, ch, f.linear);
                kTarget = {
                  fbo: sRT.fbo,
                  tex: sRT.tex,
                  pingFbo: pRT.fbo,
                  pingTex: pRT.tex,
                  pingLin: !!pRT.lin,
                  w: cw,
                  h: ch,
                };
              }
              const drawTarget = kTarget ? kTarget.fbo : shapeFbo;
              bindFb(gl.FRAMEBUFFER, drawTarget);
              // Same translated projection as the graph route (see acquireShapeRT):
              // the viewport sits at -rect.origin and the fill shader is told where its
              // framebuffer is, so its canvas-space samples stay canvas-space.
              if (skRect) {
                R.glViewport(-skRect[0], -skRect[1], cw, ch);
                R._fragOrigin = skRect;
              } else R.glViewport(0, 0, cw, ch);
              R.glDepthMask(true);
              gl.stencilMask(0xff);
              gl.clearColor(0, 0, 0, 0);
              gl.clearStencil(0);
              gl.clearDepth(1.0);
              gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
              R.glDepthMask(false);
              const def0K = R._deferTotal(); // see def0F
              R.beginFillPass();
              _drawCoverChunk(op.chunk, op.shapeIdx);
              R.endFillPass();
              // Per-kind filter math.
              //
              // pxPerEm{X,Y} converts viewBox-unit filter values (σ, dx, dy,
              // erode/dilate radius) into screen pixels. It must fold the
              // ENTIRE em → screen-pixel chain:
              //   em → object (the canvas-AR fit, captured in scX/scY)
              //   object → world (the per-draw worldMatrix, if any)
              //   world → screen (the canvas itself, captured by cw/ch)
              // A bundle scaled down by `_ds.worldM` to 18% renders its
              // shapes small (the vert shader applies the matrix), so the
              // blur σ must scale the same way: otherwise a 0.333-unit
              // stdDeviation becomes a ~5px halo on a small glyph instead
              // of ~0.6px. The filter must honor world scale.
              //
              if (f.kind === 1) {
                // feGaussianBlur — blur the target in place.
                R.blurShapeFbo(f.sigmaX * pxPerEmX, f.sigmaY * pxPerEmY, kTarget, f.linear);
              } else if (f.kind === 5) {
                // feMorphology — erode (0) / dilate (1) with per-axis radii.
                const operator = f.tintR | 0;
                R.morphShapeFbo(operator, f.sigmaX * pxPerEmX, f.sigmaY * pxPerEmY, kTarget);
              } else if (f.kind === 6) {
                // feConvolveMatrix — single-pass 2D convolution.
                R.convolveShapeFbo(f, kTarget);
              }
              // Tier-2b: store the post-filter shapeFboTex into the persistent
              // per-(filterId,shape) cache so a static re-render skips the
              // source render + filter next frame.
              // Priced as what it allocates: the placement, which is the entry's texture while the result fits it, not the result's rect.
              const skPl =
                skCacheable && R._deferTotal() === def0K
                  ? R._resultPlacement(skEntry && skEntry.shapeTex ? skEntry : null, skRect, cw, ch)
                  : null;
              if (skPl && R._filterStoreFits(skId, skPl.w * skPl.h * 4)) {
                if (!skEntry) {
                  skEntry = { w: 0, h: 0, key: null };
                  _setFilterCache(skId, skEntry);
                }
                skEntry.rect = skPl.rect;
                R._ensureCacheTex(skEntry, 'shapeTex', skPl.w, skPl.h);
                skEntry.w = skPl.w;
                skEntry.h = skPl.h;
                R._blitResult(kTarget ? kTarget.tex : shapeFboTex, skEntry.shapeTexFbo, skPl, 0);
                R._noteResultStored(skEntry, skPl);
                skEntry.key = skKey;
              }
              _filterEvalCount++;
              if (inGrpK) {
                // Into the INNERMOST group's accumulator: shapeFbo for the outermost group, a
                // nested group's own target otherwise.
                R._filterSingleKindComposite(
                  f,
                  cw,
                  ch,
                  kTarget.tex,
                  R._groupTarget(),
                  null,
                  skRegionPx,
                );
              } else if (skRect) {
                R._filterSingleKindComposite(f, cw, ch, kTarget.tex, null, skRect, skRegionPx);
              } else {
                // Composite back to main FB.
                R._filterSingleKindComposite(
                  f,
                  cw,
                  ch,
                  kTarget ? kTarget.tex : null,
                  null,
                  null,
                  skRegionPx,
                );
              }
              _handle.fillPassAssetDirty = true;
              continue;
            } finally {
              if (_ffK) R._exitFilterFrame(_ffK);
            }
          }
        }
        // Per-leaf mix-blend-mode requires an offscreen route: draw the
        // shape alone into shapeFbo, then composite with the requested
        // blend mode against the main FB. Group-flatten for blend
        // modes 1-15 (CSS Compositing & Blending §6).
        if (op.blendMode) {
          flushPending();
          R.endFillPass();
          R._blendLeaf(op, () => {
            R.beginFillPass();
            _drawCoverChunk(op.chunk, op.shapeIdx);
            R.endFillPass();
          });
          continue;
        }
        const cs = laidOut ? _coverDrawStart(op.chunk) : _coverChunkStart(op.chunk),
          cc = _coverChunkCount(op.chunk);
        if (cs < 0 || cc <= 0) continue;

        if (_handle.bundle._drawOrder && op.shapeIdx < previousPaintRow) {
          flushPending();
          // Scene order can differ from stable resource-row addresses.
          gl.clearDepth(1);
          gl.clear(gl.DEPTH_BUFFER_BIT);
        }
        previousPaintRow = op.shapeIdx;
        const rowStroke = _coverRowIsStroke(op.shapeIdx);
        if (_pendingStart < 0) {
          _pendingStart = cs;
          _pendingEnd = cs + cc;
        } else if (cs === _pendingEnd) {
          _pendingEnd += cc;
        } else {
          flushPending();
          _pendingStart = cs;
          _pendingEnd = cs + cc;
        }
        if (rowStroke === true) _pendingStroke = true;
        else if (rowStroke === false) _pendingFill = true;
      }
      flushPending();
      R._atlasFlush();
      while (groupStack.length > groupDepth0) {
        const dangling = groupStack.pop();
        if (dangling.frame) R._exitFilterFrame(dangling.frame);
        bindFb(gl.FRAMEBUFFER, groupDepth0 > 0 ? groupStack[groupStack.length - 1].acc.fbo : null);
      }
      R.endFillPass();
      R.glBindVertexArray(null);
      R._opaquePrepassActive = false;

      R._drawDebugOverlays(_handle.bundle, false);
      if (R._noteRowDraw) R._noteRowDraw(_handle.bundle, 'cover'); // the classic cover pass: every fill row is a cover quad (rowEngines.js)
    }

    // Both analytic routes call the shared overlay hook with the mesh they served.
    R._drawDebugOverlays = function (b, lbServed) {
      if (!b) return;
      if (rendererState.showTriOutline)
        withOverlayState(() => renderTriOutlineOverlay(b, lbServed));
      if (rendererState.showBBoxes) withOverlayState(() => renderBBoxOverlay(b));
    };

    // The mesh overlay must show the mesh that was actually DRAWN. Under LB that is the
    // Loop-Blinn partition — interior triangles, curve hulls, AA strips — not the Slug cover
    // quads, which LB never submits. Drawing the cover quads under LB shows you a mesh the
    // frame did not use, which is worse than showing nothing.
    //
    // LB verts are em-space in the same aPos slot the solid overlay program projects from
    // (loopBlinn.vert.glsl shares mantle.vert.glsl's em→NDC), so they need no remapping.
    // Per-shape override transforms are applied in LB's VS and are NOT reflected here.
    function renderLbTriOutlineOverlay(b) {
      const [cw, ch] = viewportSize();
      R.glUseProgram(R.solidProg);
      gl.uniform4f(solidUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      const [sx, sy] = arScale(b.globalBBox, cw, ch);
      gl.uniform2f(solidUAR, sx, sy);
      R.glBindVertexArray(solidVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
      const triPts = _triOverlayPts;
      for (const m of b._lbMeshes) {
        const v = m && m.verts;
        if (!v) continue;
        for (let t = 0; t + 3 <= m.vertexCount; t += 3) {
          const base = t * LB_VERT_FLOATS;
          // aFlags.x is kind + a fractional blend bit — floor it off.
          const kind = Math.floor(v[base + 5] + 1e-4);
          // A CPatch cover vertex is in its contour's frame; the frame rides in aC2.zw (floats 17-18).
          const fx = kind === 14 ? v[base + 17] : 0,
            fy = kind === 14 ? v[base + 18] : 0;
          triPts[0] = v[base] + fx;
          triPts[1] = v[base + 1] + fy;
          triPts[2] = v[base + LB_VERT_FLOATS] + fx;
          triPts[3] = v[base + LB_VERT_FLOATS + 1] + fy;
          triPts[4] = v[base + LB_VERT_FLOATS * 2] + fx;
          triPts[5] = v[base + LB_VERT_FLOATS * 2 + 1] + fy;
          if (kind === 0)
            gl.uniform4f(solidUColor, 1.0, 0.82, 0.0, 0.9); // interior
          else if (kind === 10 || kind === 12)
            gl.uniform4f(solidUColor, 0.1, 0.7, 1.0, 0.9); // AA bands
          else gl.uniform4f(solidUColor, 1.0, 0.15, 0.15, 0.9); // curve pieces
          gl.bufferData(gl.ARRAY_BUFFER, triPts, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINE_LOOP, 0, 3);
        }
      }
      R.glBindVertexArray(null);
    }

    // The overlay is a plain LINE_LOOP pass and owns no state, so it inherits whatever the fill
    // left behind. LB leaves the DEPTH test on (its per-shape depth claim), which rejects every
    // overlay line at z=0 — the overlay silently drew nothing under LB. Neutralize the tests,
    // then put them back for whatever the caller does next.
    function withOverlayState(fn) {
      const depth = gl.isEnabled(gl.DEPTH_TEST),
        stencil = gl.isEnabled(gl.STENCIL_TEST);
      const cm = gl.getParameter(gl.COLOR_WRITEMASK);
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      R.glColorMask(true, true, true, true);
      R.glEnable(gl.BLEND);
      R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      try {
        fn();
      } finally {
        if (depth) R.glEnable(gl.DEPTH_TEST);
        if (stencil) R.glEnable(gl.STENCIL_TEST);
        R.glColorMask(cm[0], cm[1], cm[2], cm[3]);
      }
    }

    function renderTriOutlineOverlay(b, lbServed) {
      if (!b) return;
      if (lbServed && Array.isArray(b._lbMeshes) && b._lbMeshes.length) {
        renderLbTriOutlineOverlay(b);
        return;
      }
      if (!b.coverQuadFloats || !b.coverQuadChunks.length) return;
      const [cw, ch] = viewportSize();
      R.glUseProgram(R.solidProg);
      gl.uniform4f(solidUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      const [sx, sy] = arScale(b.globalBBox, cw, ch);
      gl.uniform2f(solidUAR, sx, sy);
      R.glBindVertexArray(solidVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
      const triPts = _triOverlayPts;
      const meshFloats = b.coverQuadFloats;
      for (let ci = 0; ci < b.coverQuadChunks.length; ci++) {
        const ch0 = b.coverQuadChunks[ci];
        const v0 = ch0.start,
          vn = ch0.count;
        for (let vi = 0; vi + 3 <= vn; vi += 3) {
          const base = (v0 + vi) * COVER_QUAD_STRIDE;
          const type = meshFloats[base + 10];
          if (type < 0) continue;
          triPts[0] = meshFloats[base + 0];
          triPts[1] = meshFloats[base + 1];
          triPts[2] = meshFloats[base + COVER_QUAD_STRIDE + 0];
          triPts[3] = meshFloats[base + COVER_QUAD_STRIDE + 1];
          triPts[4] = meshFloats[base + COVER_QUAD_STRIDE * 2 + 0];
          triPts[5] = meshFloats[base + COVER_QUAD_STRIDE * 2 + 1];
          if (type >= 3.5) gl.uniform4f(solidUColor, 1.0, 0.15, 0.15, 0.9);
          else gl.uniform4f(solidUColor, 1.0, 0.82, 0.0, 0.9);
          gl.bufferData(gl.ARRAY_BUFFER, triPts, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINE_LOOP, 0, 3);
        }
      }
      R.glBindVertexArray(null);
    }
    function renderBBoxOverlay(b) {
      if (!b || !b.metaFloats || !b.numShapes) return;
      const [cw, ch] = viewportSize();
      R.glUseProgram(R.solidProg);
      gl.uniform4f(solidUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      const [sx, sy] = arScale(b.globalBBox, cw, ch);
      gl.uniform2f(solidUAR, sx, sy);
      gl.uniform4f(solidUColor, 0.78, 0.38, 0.02, 0.95);
      R.glBindVertexArray(solidVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
      const bbPts = _bboxOverlayPts;
      const stride = b.metaFloatsPerShape;
      for (let si = 0; si < b.numShapes; si++) {
        const o = si * stride;
        const x0 = b.metaFloats[o + 0],
          y0 = b.metaFloats[o + 1];
        const x1 = b.metaFloats[o + 2],
          y1 = b.metaFloats[o + 3];
        bbPts[0] = x0;
        bbPts[1] = y0;
        bbPts[2] = x1;
        bbPts[3] = y0;
        bbPts[4] = x1;
        bbPts[5] = y1;
        bbPts[6] = x0;
        bbPts[7] = y1;
        gl.bufferData(gl.ARRAY_BUFFER, bbPts, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINE_LOOP, 0, 4);
      }
      R.glBindVertexArray(null);
    }

    /** Serialize the LAST rendered frame to an SVG string by replaying its
     *  recorded draw list on the native (DOM) backend. Async: the native
     *  fallback module is loaded on demand (dynamic import), so apps that
     *  never export don't ship it. Requires frame capture to have been on
     *  for that frame (default).
     *
     *  Bundles must have been imported with { retainSource: true } (so the
     *  native scene can clone their markup); morph/timeline geometry is
     *  rebuilt on the CPU at call time. See frameExport.js for the full
     *  precondition + limitation list (animated clippers, GPU image
     *  handles).
     *
     *  @param {object} [exportOpts]
     *  @param {Document} [exportOpts.document]  DOM document when headless
     *  @param {'viewport'|'bundle'} [exportOpts.coordinateSpace='viewport']
     *  @param {[number,number]} [exportOpts.viewport]  override the mirrored
     *         pixel viewport (defaults to the renderer's current viewport)
     *  @param {(svg:Element)=>string} [exportOpts.serialize]
     *  @param {boolean} [exportOpts.recoverText]  emit <text> for text
     *         bundles that retained their string (createTextBundle with
     *         retainText:true) instead of glyph outlines
     *  @param {boolean} [exportOpts.allowActiveContent]  keep <script>, <foreignObject>, on*
     *         handlers and javascript: hrefs of a bundle's retained source (stripped by default)
     *  @param {boolean} [exportOpts.detail]  return the full report object
     *         ({ svg, drawn, skipped, notes }) instead of just the string
     *  @returns {Promise<string|{svg:string,drawn:number,skipped:number,notes:string[]}>}
     */
    async function exportFrameSVG(exportOpts = {}) {
      if (!_captureFrames)
        throw new Error(
          'exportFrameSVG: frame capture is disabled — call ' +
            'R.setFrameCapture(true) before the frame you want to export.',
        );
      const { exportFrameToSvg } = requireRendererFeature('frameExport', 'exportFrameSVG()');
      const report = exportFrameToSvg({
        frameLog: _frameLog,
        viewport: exportOpts.viewport || viewportSize().slice(), // .slice(): viewportSize returns shared scratch
        clearColor: _lastFrameClearColor,
        document: exportOpts.document,
        coordinateSpace: exportOpts.coordinateSpace || 'viewport',
        serialize: exportOpts.serialize,
        recoverText: !!exportOpts.recoverText,
        allowActiveContent: !!exportOpts.allowActiveContent,
      });
      return exportOpts.detail ? report : report.svg;
    }

    // ── Centralized analytic-fill (Loop-Blinn) routing ────────────────────
    // The SINGLE decision point for whether a bundle renders through an analytic
    // route instead of the Slug ray-cast. Every draw entry point (bare
    // drawBundle, handle.draw, drawBundleInstanced) funnels through here so the
    // routing + feature gating lives in ONE place, not duplicated per site.
    // Reads the current per-draw state (_ds.worldM/_ds.alpha/_ds.overrides/…)
    // and draws at it. Returns true when it rendered the bundle (caller skips
    // Slug); false → caller falls through to render().
    //
    //   opts.bare       drawBundle context: a bare bundle (target.bundle
    //                   undefined). A morph HANDLE is `bare:false`.
    //   opts.streamOnly handle.draw / instanced context: only the streamed
    //                   (_lbStream) route may fire (preserves: handles never
    //                   took the global setLoopBlinnFill static route).
    /** @param {object} bundle
     *  @param {{bare?:boolean, streamOnly?:boolean}} [opts] */
    // Engine trace (setDiagnostics({ engineTrace: true })). Wraps the ROUTING
    // DECISION itself, so it sees every entry point — bare drawBundle, handle.draw,
    // and instanced — not just one. Off by default: one boolean check when disabled.
    function _analyticRoute(bundle, opts) {
      const served = _analyticRouteImpl(bundle, opts);
      if (diagFlags.engineTrace && bundle) {
        const bb = bundle.globalBBox;
        const key =
          (bundle.numShapes | 0) +
          '|' +
          (bb
            ? `${Math.round(bb[0])},${Math.round(bb[1])},${Math.round(bb[2])},${Math.round(bb[3])}`
            : '-') +
          '|' +
          (served ? 'LB' : 'SLUG') +
          '|entry' +
          (opts && opts.bare ? 'bare' : opts && opts.streamOnly ? 'handle' : 'instanced') +
          '|baking' +
          (R._cacheBakingNow ? 1 : 0);
        diagNoteEngine(key);
      }
      return served;
    }
    // Would the analytic (LB) route serve this bundle RIGHT now? A predicate over
    // the same gates _analyticRoute applies, with no side effects.
    //
    // The instanced fill path uses this predicate so route selection remains a
    // property of the bundle rather than the draw entry point.
    //
    // LB meshes build OFF-THREAD: until one lands, LB declines and every instance
    // would fall to its own Slug draw — strictly worse than the instanced fast path.
    // So an unbuilt mesh reports false and the fast path keeps it until LB is ready.
    // Draw-time kill switch for the occlusion cull. createBundle keeps the UNCULLED
    // draw list precisely so the cull can be undone without a reload — a toggle that
    // needed a re-import would be useless for diagnosing a live artifact.
    function _cullSwitchTick() {
      _retireCullIfOverridden();
      const off = mantleDebugFlag('noOcclusionCull');
      const b = _handle && _handle.bundle;
      if (!b || !b.drawListUnculled) return;
      if (off && b.drawList !== b.drawListUnculled) {
        b._drawListCulled = b.drawList;
        b.drawList = b.drawListUnculled;
        b._cullGen = (b._cullGen | 0) + 1;
      } else if (
        !off &&
        b._drawListCulled &&
        !b._cullRetired &&
        b.drawList === b.drawListUnculled
      ) {
        b.drawList = b._drawListCulled;
        b._cullGen = (b._cullGen | 0) + 1;
      }
    }
    R._cullSwitchTick = _cullSwitchTick;
    R._retireCullIfOverridden = _retireCullIfOverridden;

    function _lbWouldServe(bundle, requestBuild = false) {
      // Share static-route gates across instanced and ordinary draw entry points.
      // Instanced draws do not enter the morph route.
      if (!bundle || bundle._incStroke || bundle._morphSrc) return false;
      if (R._lbFillMode === 'off' && R.opts.unifiedFill !== 'force') return false;
      if (!_staticRouteWanted(bundle, requestBuild)) return false;
      // LB meshes build OFF-THREAD: until one lands the route declines, and every instance would fall to its own Slug
      // draw, strictly worse than the instanced fast path. So an unbuilt mesh reports false.
      if (!Array.isArray(bundle._lbMeshes) || !bundle._lbMeshes.length) return false;
      return (bundle._lbGen | 0) === (bundle._geomGen | 0);
    }
    // ── Engine-selection switches ─────────────────────────────────────────
    // Read through engineSwitch.js, which owns the table of which switch denies which DRAW PATH, so
    // a path that forgets to ask is a missing name rather than a silently different engine.
    R._engineSel = () => engineSelection(R);
    R._analyticAllowed = (path) => analyticAllowed(engineSelection(R), path);
    R._engineSelKey = () => engineSelKey(R);
    let _warnedForceSlugStream = false;
    function _warnForceSlugStream() {
      R._forceSlugStreamDraws = (R._forceSlugStreamDraws | 0) + 1;
      if (_warnedForceSlugStream) return;
      _warnedForceSlugStream = true;
      mantleWarn(
        '[mantle] __MANTLE_FORCE_SLUG cannot be honored for a streamed bundle: a lightweight ' +
          'geometry stream is built without cover quads, so Slug has nothing to draw. Drawing it through ' +
          'the analytic route instead — timings from this run include it.',
      );
    }

    /// Would the static (or streamed) analytic branch attempt this bundle? Asked by _analyticRouteImpl before it draws and
    /// by _lbWouldServe. Diagnostic queries disable build requests to preserve mesh ownership.
    function _staticRouteWanted(bundle, requestBuild = true) {
      // ROUTE CLASS (fillRouteClass.js): a static bundle under 'auto' takes the cover pass; no analytic build is requested for it, and the gate says why.
      if (bundle && R._fillRouteReason && R._fillRouteReason(bundle) === 'static-cover') {
        R._unifiedFillGate = 'static-cover';
        return false;
      }
      // Static analytic route: any static bundle (not a morph, not mid-stream
      // geometry) through ANY entry point — bare drawBundle, handle.draw, and
      // instanced (the `bare`/`streamOnly` context does not gate it; the static
      // LB route builds its own route VBO, independent of the handle's cover-quad
      // VBO). A handle with a static-scene cache ticks the cache FIRST and asks this
      // route only when the cache declines (bundleHandle.js), so the cache and LB
      // compete there instead of LB winning by position.
      //
      // Streaming has two bundle states, split HERE:
      //   • _lbStream (lightweight LB stream): built without Slug cover-quads, so it
      //     has no draw-time Slug fallback — it MUST route the analytic path. Its
      //     "fallback" is at STREAM time: streamGeometryLightweight declines (arc /
      //     loop-cusp / stroke-clip-mask-dash) → updateBundleGeometry does the full
      //     Slug rebuild instead, which clears _lbStream (see next bullet).
      //   • _geomGen>0, !_lbStream (the Slug streaming fallback): the full rebuild
      //     regenerates cover-quads, so `!bundle._geomGen` below keeps it on Slug —
      //     which is correct, it falls back precisely because LB cannot serve it.
      const lbStreamed = !!bundle._lbStream;

      const cpatchBundle = R.opts.cpatchFill === true && !!bundle._cpatchBuilt;
      // Cached handles route LB like everything else: the bake's re-entrant render
      // reaches here with the cache FBO as the redirect target (bindFb), and forcing
      // Slug instead would render BLANK for bundles that carry no Slug cover-quads
      // (lightweight builds): components would disappear once the whole asset is cached.
      // The capture also matches live frames exactly when both are LB.
      const _bundleHasPrim = (b) => {
        const ms = b && b._lbMeshes;
        if (!ms) return false;
        for (const m of ms) if (m && m.prim) return true;
        return false;
      };
      const sel = engineSelection(R);
      const forceSlug = sel.forceSlug;
      // A replacement bake changes the generation without streaming geometry.
      // Its rebuilt CPatch meshes may serve only the generation they certify.
      const currentCpatch = cpatchBundle && bundle._lbGen === (bundle._geomGen | 0);
      let wantStatic =
        analyticAllowed(sel, 'static').allow &&
        (!bundle._geomGen || currentCpatch) &&
        !bundle._morphSrc;
      if (requestBuild && wantStatic && R._requestLbBuild) R._requestLbBuild(bundle);
      // Primitive recognition is independent of the selected analytic engine.
      // Unrecognized shapes retain their cover fallback.
      const primAllowed = analyticAllowed(sel, 'prim').allow;
      if (
        requestBuild &&
        !wantStatic &&
        primAllowed &&
        !bundle._geomGen &&
        !bundle._morphSrc &&
        bundle._lbMeshes === undefined &&
        R._requestPrimBuild &&
        !(R._fillRouteReason && R._fillRouteReason(bundle) === 'static-cover')
      )
        R._requestPrimBuild(bundle);
      // Apply the current renderer policy to retained primitive meshes too.
      if (!wantStatic && primAllowed && _bundleHasPrim(bundle)) wantStatic = true;
      // An explicit raw-kernel pin takes precedence over a forced unified route.
      const forceUnified = R.opts.unifiedFill === 'force' && !forceSlug;
      if (forceUnified) wantStatic = true;
      //
      // ...AND IT IS A PER-SHAPE QUESTION WHEREVER A PER-SHAPE POLICY RUNS. This line
      // has exactly two answers for a whole bundle, and which one it takes is decided by whether SOME
      // OTHER row happens to be a recognized primitive: one primitive turns the preference off for
      // every curved row, and no primitive turns it on for every one. Under 'auto' the floor
      // rides in lbShapePolicy per row (minPx2PerSegFor), where the primitive exemption is the row's
      // own fact and the others are priced against the kernel that will actually shade them. The
      // routing outcome is unchanged for a bundle with no primitive: every row floors out, the pick
      // set is null, and the 'auto' gate just below declines it exactly as this line would.
      //
      // A pinned mode keeps the whole-bundle form, and that is not an omission: a pin means "draw
      // every mesh", so there is no per-row choice left to make and the only question is whether the
      // bundle routes at all.
      const perShapePolicy = R._lbFillMode === 'auto' && !cpatchBundle && !lbStreamed;
      if (
        wantStatic &&
        !forceUnified &&
        !perShapePolicy &&
        R._preferNoAa &&
        R._preferNoAa(bundle) &&
        !(primAllowed && _bundleHasPrim(bundle))
      )
        return false;
      // 'auto' perf gate (shared by static + streamed; stub → always route). A
      // published _lbStream bundle ignores the veto: it has no draw-time Slug
      // fallback, so routing anyway beats rendering blank (its perf decision was
      // already made at stream time).
      //
      // Which is also why forceSlug CANNOT BE HONORED HERE, and why that has to be SAID. A
      // lightweight stream is built with no cover quads at all, so "draw this with Slug" has no
      // geometry to draw and the only alternatives are the analytic route or a blank frame. Silently
      // taking the route is what made the switch untrustworthy: a run with it set reported Loop-Blinn
      // timings under Slug's name for every streamed bundle in the scene. Say so, once, and route.
      if (lbStreamed && analyticAllowed(sel, 'stream').reason === 'force-slug-stream')
        _warnForceSlugStream();
      if (
        (wantStatic || lbStreamed) &&
        // 'auto' takes the route when the per-shape policy gives at least one shape its mesh
        // (lbShapePolicy); every other shape rides the same stream as a cover quad.
        !(
          R._lbFillMode === 'auto' &&
          !R._lbAutoPicks(bundle) &&
          !lbStreamed &&
          !cpatchBundle &&
          !forceUnified
        ) &&
        // Override recolor (fill/tint/visibility — fog) is baked by the route.
        // A per-shape TRANSFORM override on a shape that has Slug geometry falls
        // back to Slug per-shape (which applies the transform); on a lightweight
        // streamed bundle (no Slug geometry) it's unsupported (the road uses fog
        // only). Both static and streamed route — _drawBundleLB handles the mix.
        // Per-draw recolor (colorMatrix/palette/channelLerp) composes via the
        // analytic composite path (_drawBundleLB rejects gradient/image bundles
        // under recolor and forces all shapes through it). ext-clip is still
        // stripped from the variant → keep it on Slug.
        // Sprite subset: the combined VBO carries a per-shape vertex span so the draw can be
        // sliced to the sprite (the unified route's per-entry vertex ranges). Without it the
        // analytic route would paint the ENTIRE SHEET on any drawSprite — and cost
        // O(bundleShapes) per call. The
        // NON-CONTIGUOUS case (a pattern/clip child interleaved, bundle.spriteRangesNonContiguous)
        // breaks the contiguous-slice assumption, so it stays on Slug.
        !(_ds.shapeRange && _ds.spriteNonContig) &&
        !_ds.extClipTex &&
        !_canvasUnsized()
      ) {
        return true;
      }
      return false;
    }
    function _analyticRouteImpl(bundle, opts) {
      if (!bundle) return false;

      // Dynamic incremental stroke (paint tool): a bundle-like flagged
      // `_incStroke` draws through its own GPU-resident stroke-coverage path
      // (incrementalStroke.js) from every entry point. It carries no Slug
      // geometry, so this branch always handles it (returns true).
      if (bundle._incStroke) return R._drawIncrementalStroke(bundle);
      const bare = !!(opts && opts.bare);
      const streamOnly = !!(opts && opts.streamOnly);
      // GPU-resident morph route: a dynamic MORPH handle (createShapeMorph marks
      // it with _morphSrc). drawBundle-only (a handle, so !bare).
      //
      // It reads the same forceSlug as the static branch below. Reading only the fill mode, a morph
      // would keep its analytic route while every static bundle in the same scene went to Slug —
      // and a morph's fill is one draw with a per-frame pre-pass behind it, which is exactly the shape
      // of cost such a run is measuring. A morph declining here resumes the CPU lerp + upload it
      // already falls back to (the `skipUploads` reset just below), so the fallback is the supported
      // one, not a blank frame.
      const preparedNativeMorph = !!(
        bundle._morphSrc &&
        !bundle._nineSliceActive &&
        R._preparedCPatchWanted &&
        R._preparedCPatchWanted(bundle)
      );
      if (
        ((!streamOnly && !bare) || preparedNativeMorph) &&
        analyticAllowed(engineSelection(R), 'morph').allow &&
        bundle._morphSrc &&
        (!_ds.overrides || (R._lbOvrColorOnly && R._lbOvrColorOnly(_ds.overrides))) &&
        !_ds.colorMatrix &&
        !_ds.palette &&
        !_ds.channelLerp &&
        !_ds.extClipTex &&
        !_canvasUnsized()
      ) {
        if (R._drawBundleMorphRoute(bundle)) return true;
      }
      if (bundle._morphSrc) {
        const ms = bundle._morphSrc;
        // Prepared morphs may leave the raw curve plane at an earlier pose.
        // Restore both uploads before the cover draw consumes the current pose.
        const resume = ms.skipUploads || ms.skipCurveUploads;
        ms.skipUploads = false;
        ms.skipCurveUploads = false;
        if (resume && typeof ms.relerp === 'function') ms.relerp();
      }
      // _drawBundleLB classifies the feature set (solid → combined route;
      // gradient/image → per-shape) and checks eligibility with the right
      // allow* flags. Returns false (→ Slug) for anything it can't serve.
      return _staticRouteWanted(bundle) ? R._drawBundleLB(bundle) : false;
    }

    // drawBundle / drawBundleInstanced / drawInstance — the public per-bundle
    // draw entry points — see drawDispatch.js.

    // ------------------------------------------------------------
    // Static-scene cache. Per-cache state (state machine, FBO+texture,
    // hooks) lives on each handle so multi-bundle scenes get per-mount
    // cache hits.
    //
    // Renderer-side remnants:
    //   _cacheBakingNow:  re-entrancy guard (the bake re-enters
    //                     _renderCanvasInner, which must not itself
    //                     trip the cache check again).
    //
    // Helpers below operate on whatever handle is currently active
    // (_handle.cache / _handle.cacheFbo / etc).
    //
    // WholeAsset caches one bundle; SharedGroup shares a target per instance-group key.
    // ------------------------------------------------------------

    // Compat shim: configure cache on the internal handle. Single-bundle
    // callers (the demo, single-asset tests) keep working unchanged.
    // Multi-bundle callers should use `createBundleHandle(b, { staticCache })`
    // so each mount has its own cache state machine + cache RT.

    let releaseMorphLerpOwner = null;
    let releaseCPatchBlendOwner = null;
    function dispose() {
      if (_disposed) return;
      _disposed = true;
      if (R._warmQueueDispose) R._warmQueueDispose();
      if (releaseMorphLerpOwner) releaseMorphLerpOwner();
      if (releaseCPatchBlendOwner) releaseCPatchBlendOwner();
      // From here on every draw entry returns at its context-loss guard, so a late frame (a requestAnimationFrame
      // that outlives a framework unmount) allocates nothing that this dispose would have to free.
      _contextLost = true;
      // Unregister the LB hooks. They live in a registry scoped to this GL context (every renderer on
      // the canvas adds one), and a disposed renderer's closure captures a dead GL context — leaving
      // it registered means the next bundle created on this canvas hands its Loop-Blinn build to a
      // renderer that no longer exists.
      try {
        removeLbBuilder(gl, R._lbBuilderFn);
        removeLbPreparer(gl, R._lbPreparerFn);
      } catch {
        /* not registered */
      }
      // Filter handlers that keep GL objects per renderer (feTurbulence's lattice
      // textures) free them before their programs go.
      for (const h of Object.values(_svgDispatch)) if (h && h.disposeGl) h.disposeGl(gl, R);
      // Per-handle resources are owned by the bounded bare-draw handle LRU or
      // by caller-created handles. Dispose every internal resident handle here.
      for (const p of new Set([
        R._baseFillMade ? R.fillProg : null,
        R.solidProg,
        R.compProg,
        R.blurProg,
        R.boxBlurProg,
        R.morphProg,
        R.convolveProg,
        R.colorMatrixProg,
        R.feCompositeProg,
        R.feBlendProg,
        R.feTileProg,
        R.feTurbulenceProg,
        R.feDisplacementMapProg,
        R.feLightingProg,
        R.feComponentTransferProg,
        R.feImageProg,
        R.paintLinearGradProg,
        R.paintRadialGradProg,
        R.paintSweepGradProg,
        R.paintTransformProg,
        R.paintGlyphProg,
        R.paintCompositeProg,
        R.maskBakeProg,
        R.cacheBlitProg,
        R.effectMaskProg,
        R._lazyMade.drawImageProg() ? R.drawImageProg : null,
        R._lazyMade.drawImageInstProg() ? R.drawImageInstProg : null,
        R.lbCompProg,
        R.splitStrokeProg,
        _ci.prog,
      ])) {
        if (p) deleteProgramWhenLinked(gl, p);
      }
      if (R._disposeInstProgs) R._disposeInstProgs();
      if (R._disposeAacPoints) R._disposeAacPoints();
      if (R._disposeFillVariants) R._disposeFillVariants();
      if (R._disposeFilterPrograms) R._disposeFilterPrograms();
      R._pendingShaders.length = 0;
      R._pendingPrograms.length = 0;
      if (R.disposeOpaquePrepass) R.disposeOpaquePrepass();
      if (R._disposeLbCovPrograms) R._disposeLbCovPrograms();
      if (R._clearLbCaches) R._clearLbCaches();
      for (const v of [solidVao, coverVao, R._instVao, _ci.vao])
        if (v) deleteGlResource(gl, 'VertexArray', v);
      for (const b of [solidBuf, coverBuf, R._instBuf, R._instAttrBuf, _ci.buf])
        if (b) deleteGlResource(gl, 'Buffer', b);
      _ci.prog = _ci.vao = _ci.buf = null;
      _ci.cap = 0;
      if (R._disposeInstCompacts) R._disposeInstCompacts();
      // Per-handle GL resources (triVao, triBuf, shapeIdxBuf,
      // maskRowToLayerTex) are owned by the handle and freed by its
      // dispose(); the renderer-owned dummies are released here. The mask
      // RT arrays + bake VAO/FBOs are owned by maskBake.js.
      R._disposeMaskBake();
      if (R._memDispose) R._memDispose();
      for (const t of [
        dummyGradientTex,
        dummyGradientStops,
        dummyDashTex,
        shapeFboTex,
        mainCopyTex,
        groupBackdropTex,
        pingTex,
      ]) {
        if (t) deleteGlResource(gl, 'Texture', t);
      }
      _rtPool.invalidate();
      _covPool.invalidate();
      // The filtered-shape targets are canvas-relative too — a resize moves every rect.
      for (const e of _shapeRtCache.values()) {
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
        deleteGlResource(gl, 'Renderbuffer', e.rb);
      }
      _shapeRtCache.clear();
      for (const e of _pingRtCache.values()) {
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
      }
      _pingRtCache.clear();
      if (shapeFbo) deleteGlResource(gl, 'Framebuffer', shapeFbo);
      if (pingFbo) deleteGlResource(gl, 'Framebuffer', pingFbo);
      if (shapeFboRb) deleteGlResource(gl, 'Renderbuffer', shapeFboRb);
      // Tier-2b filter result cache (graph-path tex/fbo + single-kind
      // shapeTex + their FBOs).
      _forgetFreeResults(true);
      for (const c of _filterCache.values()) {
        for (const t of [c.tex, c.shapeTex]) if (t) deleteGlResource(gl, 'Texture', t);
        for (const fb of [c.fbo, c.shapeTexFbo]) if (fb) deleteGlResource(gl, 'Framebuffer', fb);
      }
      _filterCache.clear();
      // External-clip resources (clipDraw.js): the renderClipCoverage FBO, its
      // persistent clip handle, and every per-bundle node-clip coverage texture.
      R._disposeNodeClips();
      if (_handle && !_isTransientHandle(_handle)) _handle.dispose();
      _handle = null;
      _disposeTransientHandles();
      _unhookEvicted();
      // Detach context-loss listeners so a disposed renderer doesn't keep
      // the canvas (and this closure) alive.
      if (_canvas) {
        _canvas.removeEventListener('webglcontextlost', _onContextLost, false);
        _canvas.removeEventListener('webglcontextrestored', _onContextRestored, false);
      }
      _ds.overrides = null;
      _ds.worldM = null;
    }

    /** Rough GPU memory estimate in bytes. Sums (a) renderer-owned
     *  texture allocations (shapeFbo / mainCopy / ping) and
     *  (b) the currently-bound bundle's GL texture sizes. Does NOT
     *  include override tables (each owns its own texture; query the
     *  table). Returns 0 when nothing is bound.
     */
    function gpuMemoryEstimate() {
      function texBytes(tex, w, h, bytesPerTexel) {
        return tex ? (w | 0) * (h | 0) * (bytesPerTexel | 0) : 0;
      }
      let n = 0;
      // Renderer-owned offscreen RTs (created lazily; size matches viewport).
      const [cw, ch] = viewportSize();
      if (shapeFbo) n += cw * ch * 4; // RGBA8 → 4 bpt
      if (mainCopyTex) n += cw * ch * 4;
      if (pingTex) n += cw * ch * 4;
      // Bound bundle
      const b = _handle && _handle.bundle;
      if (b) {
        // curveTex / bandTex are RGBA32F (16 bpt); meta is RGBA32F too.
        // Sizes aren't stored on the bundle — estimate from buffer
        // lengths instead.
        // The CPU float planes the bundle actually exposes (createBundle
        // names them curveFloats/bandFloats/metaFloats — the input
        // `sections` names curves/bands/meta never survive onto the
        // bundle, so reading those gave 0 for the dominant textures).
        if (b.curveFloats && b.curveFloats.byteLength) n += b.curveFloats.byteLength;
        if (b.bandFloats && b.bandFloats.byteLength) n += b.bandFloats.byteLength;
        if (b.metaFloats && b.metaFloats.byteLength) n += b.metaFloats.byteLength;
        if (b.imageAtlasTex && b.imageAtlasSize)
          n += (b.imageAtlasSize[0] | 0) * (b.imageAtlasSize[1] | 0) * 4;
        if (b.secondaryImageAtlasTex && b.secondaryImageAtlasSize)
          n += (b.secondaryImageAtlasSize[0] | 0) * (b.secondaryImageAtlasSize[1] | 0) * 4;
        if (b.gradientStopsBytes) n += b.gradientStopsBytes.length;
      }
      return n;
    }

    function _forgetTransientGpuState() {
      shapeFbo = shapeFboTex = shapeFboRb = null;
      shapeFboSize[0] = shapeFboSize[1] = 0;
      mainCopyTex = null;
      mainCopySize[0] = mainCopySize[1] = 0;
      groupBackdropTex = null;
      groupBackdropSize[0] = groupBackdropSize[1] = 0;
      pingFbo = pingTex = null;
      pingSize[0] = pingSize[1] = 0;
      R._forgetMaskBake();
      R._forgetClipState();
      _rtPool.forget();
      _covPool.forget();
      // The filtered-shape targets and their kernels' scratch -- and, in named slots of the first,
      // every NESTED GROUP's accumulator. Kept across a restore, the first frames after one would
      // render filtered shapes and nested groups into objects of the lost context. Forgotten, not
      // deleted, like everything above.
      _shapeRtCache.clear();
      _pingRtCache.clear();
      // ...and every cached filter RESULT, for the same reason: its texture and FBO are as dead,
      // _ensureCacheTex reuses an entry's texture when the size still matches, and a hit -- whose
      // key has no term a restore moves (the unified route's keys on geometry) -- would composite it.
      _filterCache.clear();
      _filterCacheBytes = 0;
      _forgetFreeResults(false);
    }

    function _onContextLost(e) {
      // preventDefault() is REQUIRED for the browser to later fire
      // webglcontextrestored. Without it, the context stays dead.
      e.preventDefault();
      _contextLost = true;
      // A driver reset is rare; the usual cause is the page holding more live contexts than the browser allows (Chrome drops the oldest
      // past about 16, and a dropped context may never be restored).
      mantleWarn(
        'Mantle: the WebGL context was lost; drawing is paused. If the page did not lose it to a driver reset, it may hold more live WebGL contexts ' +
          'than the browser allows (Chrome drops the oldest past about 16): dispose renderers you no longer draw. After webglcontextrestored this renderer ' +
          'must be disposed and recreated (see the onContextRestored option).',
      );
      // Bundle handles cache per-bundle GL state too — mark the active
      // one stale so it re-uploads after restore.
      if (_handle && typeof _handle.invalidate === 'function') _handle.invalidate();
      if (opts && typeof opts.onContextLost === 'function') {
        try {
          opts.onContextLost(e);
        } catch (err) {
          /* consumer hook */
        }
      }
    }

    const STALE_CONTEXT_MSG =
      'the WebGL context was lost and restored, and this renderer cannot draw on the restored context: its programs, ' +
      'uniform locations and every bundle created before the loss died with the old context. Call renderer.dispose() and create a new ' +
      'renderer and new bundles on the restored context (the createRenderer option onContextRestored is the place to do it).';
    // For the extracted modules that hold their own public entries (bundleHandle.js's handle.draw): the same state and the same message.
    Object.defineProperty(R, '_needsRecreate', { get: () => _needsRecreate, configurable: true });
    R._staleContextError = (name) => new Error(name + ': ' + STALE_CONTEXT_MSG);
    // The public entries a frame or a load screen calls. After a restore each one throws instead of drawing nothing.
    const STALE_THROWING = [
      'beginFrame',
      'render',
      'drawBundle',
      'drawBundleInstanced',
      'drawInstance',
      'submitBundle',
      'drawImage',
      'drawImageInstanced',
      'drawSprite',
      'drawSpriteInstanced',
      'setBundle',
      'createBundleHandle',
      'createImage',
      'precompileFills',
    ];
    function _onContextRestored(e) {
      // The renderer is NOT revived. Rebuilding it would take the ~20 programs and ~265 captured uniform locations in the
      // extracted draw modules, and every bundle, override table, morph and handle the host holds is a set of dead textures
      // that only the host can recreate (a bundle keeps no copy of its sections). So the restore is made loud instead:
      // _contextLost stays true (no internal path touches a dead object), isContextLost stays true, needsRecreate turns on, one
      // error is logged, and the draw entries throw. dispose() still works and frees what the lost context left behind.
      _forgetTransientGpuState();
      if (_disposed) return;
      _needsRecreate = true;
      mantleError('Mantle: ' + STALE_CONTEXT_MSG);
      for (const name of STALE_THROWING) {
        if (typeof rendererState[name] === 'function')
          rendererState[name] = function () {
            throw new Error(name + ': ' + STALE_CONTEXT_MSG);
          };
      }
      if (opts && typeof opts.onContextRestored === 'function') {
        try {
          opts.onContextRestored(e);
        } catch (err) {
          /* consumer hook */
        }
      }
    }

    if (_canvas) {
      _canvas.addEventListener('webglcontextlost', _onContextLost, false);
      _canvas.addEventListener('webglcontextrestored', _onContextRestored, false);
    }

    // Wire shared renderer context for extracted draw modules.
    Object.assign(R, {
      setBundle,
      render,
      // createBundleHandle lives in bundleHandle.js (attachBundleHandle); it
      // destructures these at attach time, so they must be on R first.
      _analyticRoute,
      _lbWouldServe,
      computeMaskRegions,
      viewportSize,
      bindFb,
      applyBlendMode,
      arScale,
      paletteChannelToInt,
      _renderCanvasInner,
      _canvasUnsized,
      _covPool,
      _rtPool,
      _svgDispatch,
      IDENTITY_COLOR_MATRIX,
      ZERO_OFFSET,
      dummyGradientTex,
      dummyGradientStops,
      dummyDashTex,
      coverVao,
      buildLoopBlinnMesh,
      buildLoopBlinnCDT,
      refreshLoopBlinnMesh,
      packLoopBlinnMesh,
      curveRangeToContours,
      lbCanonicalFrame,
      lbCanonicalHash,
      lbCanonicalHashes,
      transformLoopBlinnRaw,
      LB_VERT_FLOATS,
      // Filter subsystem lives in filterDraw.js (attachFilterDraw, below) — it
      // attaches filterRecord / _buildFilterCtx / blurShapeFbo / … onto R. These
      // renderer-owned helpers stay here but are shared with it (and the composed
      // MORPH route in morphDraw.js) via R. Per-shape state (shapeFbo/mainCopyTex/
      // pingFbo/…) is exposed as LIVE getters below; _filterCache is a stable Map
      // reference so it rides this Object.assign directly.
      ensureShapeFbo,
      ensureMainCopyTex,
      ensurePingFbo,
      evaluateGraph,
      releaseRoot,
      _filterCache,
      // ...and what the unified route's isolation step needs to filter a shape INSIDE a group
      // without touching the group's accumulator or groupBegin's backdrop.
      ensureGroupBackdropTex,
      _acquireShapeRT: acquireShapeRT,
      _acquirePingRT: acquirePingRT,
    });
    attachFilterDraw(R);
    attachMaskBake(R);
    attachWarmManifest(R);
    attachFillPass(R);
    attachWarmNeeds(R);
    attachWarmQueue(R, unwrapBundle);
    attachUnifiedFillDraw(R); // one-draw cover-quad + LB path (opt-in via MANTLE_LB_FILL)
    attachOpaquePrepass(R);
    attachFrameLoop(R);
    attachDrawDispatch(R);
    attachBundleHandle(R); // before attachClipDraw — it destructures R.createBundleHandle
    attachClipDraw(R);
    attachIncrementalStroke(R); // dynamic paint-stroke path (reads R.* at draw time)
    // Live views of the per-shape filter state (reassigned during compositing).
    Object.defineProperty(R, 'shapeFbo', { get: () => shapeFbo, configurable: true });
    Object.defineProperty(R, 'shapeFboTex', { get: () => shapeFboTex, configurable: true });
    Object.defineProperty(R, 'mainCopyTex', { get: () => mainCopyTex, configurable: true });
    Object.defineProperty(R, 'groupBackdropTex', {
      get: () => groupBackdropTex,
      configurable: true,
    });
    Object.defineProperty(R, '_scissor', {
      get: () => _scissor,
      set: (v) => {
        _scissor = v;
      },
      configurable: true,
    });
    // frameLoop.js: setViewport/scissor + the SVG-export recorder set these;
    // viewportSize reads _explicitViewport, exportFrameSVG reads _frameLog/_last.
    Object.defineProperty(R, '_explicitViewport', {
      get: () => _explicitViewport,
      set: (v) => {
        _explicitViewport = v;
      },
      configurable: true,
    });
    Object.defineProperty(R, '_frameLog', {
      get: () => _frameLog,
      set: (v) => {
        _frameLog = v;
      },
      configurable: true,
    });
    Object.defineProperty(R, '_lastFrameClearColor', {
      get: () => _lastFrameClearColor,
      set: (v) => {
        _lastFrameClearColor = v;
      },
      configurable: true,
    });
    // _filterEvalCount is bumped by both render() and the morph route → get/set bridge.
    Object.defineProperty(R, '_filterEvalCount', {
      get: () => _filterEvalCount,
      set: (v) => {
        _filterEvalCount = v;
      },
      configurable: true,
    });
    // Ping RT + filter-scissor flag: live views for filterDraw.js (pingFbo/pingTex
    // are reassigned by ensurePingFbo; _filterBboxEnabled toggled by _setFilterBbox).
    Object.defineProperty(R, 'pingFbo', { get: () => pingFbo, configurable: true });
    Object.defineProperty(R, 'pingTex', { get: () => pingTex, configurable: true });
    Object.defineProperty(R, '_filterBboxEnabled', {
      get: () => _filterBboxEnabled,
      configurable: true,
    });
    // clipDraw.js: renderClipCoverage guards on context loss and resets the
    // fill-pass canvas-size cache around its re-entrant offscreen draw.
    Object.defineProperty(R, '_contextLost', { get: () => _contextLost, configurable: true });
    Object.defineProperty(R, 'fillPassCanvasW', {
      get: () => fillPassCanvasW,
      set: (v) => {
        fillPassCanvasW = v;
      },
      configurable: true,
    });
    Object.defineProperty(R, 'fillPassCanvasH', {
      get: () => fillPassCanvasH,
      set: (v) => {
        fillPassCanvasH = v;
      },
      configurable: true,
    });
    // bundleHandle.js: handle.dispose() clears these renderer-owned validity refs.
    Object.defineProperty(R, '_lastFillPassHandle', {
      get: () => _lastFillPassHandle,
      set: (v) => {
        _lastFillPassHandle = v;
      },
      configurable: true,
    });
    Object.defineProperty(R, '_handle', {
      get: () => _handle,
      set: (v) => {
        _handle = v;
        if (_isTransientHandle(v)) _boundTransient = v;
      },
      configurable: true,
    });
    R.draw = _ds;
    R._renderShapeViaSlug = function (bundle, s, hi) {
      if (_contextLost) return false;
      if (_handle && _handle.bundle !== bundle) setBundle(bundle);
      if (!_handle || !_handle.bundle) return false;
      const saved = _ds.shapeRange;
      _ds.shapeRange = [s | 0, (hi == null ? s : hi) | 0];
      try {
        _renderCanvasInner();
      } finally {
        _ds.shapeRange = saved;
      }
      return true;
    };
    Object.defineProperty(R, '_inFrame', {
      get: () => _inFrame,
      set: (v) => {
        _inFrame = v;
      },
      configurable: true,
    });
    Object.defineProperty(R, '_captureFrames', {
      get: () => _captureFrames,
      set: (v) => {
        _captureFrames = v;
      },
      configurable: true,
    });
    Object.defineProperty(R, '_instancedFastEnabled', {
      get: () => _instancedFastEnabled,
      set: (v) => {
        _instancedFastEnabled = v;
      },
      configurable: true,
    });

    // Public renderer state object. The factory exposes mutable debug
    // flags here so consumers can toggle them at any time.
    const FILL_ROUTES = ['none', 'lb', 'cpatch', 'cpatch-auto', 'auto'];
    const FILL_KERNELS = ['slug', 'aac', 'hard-band', 'hard-tree', 'auto'];
    const FILL_PRIMITIVES = ['on', 'off', true, false];
    /** @type {import('./rendererApi.js').MantleRendererApi} */
    const built = {
      showTriOutline: false,
      showBBoxes: false,
      setBundle,
      render: renderEntry,
      invalidateRenderState: R.invalidateRenderState,
      markGeometryDirty: R.markGeometryDirty,
      // Internal: toggle filter-pass scissoring (default on). Used by the
      // render-diff smoke to compare scissored vs full-canvas output.
      _setFilterBbox(v) {
        _filterBboxEnabled = !!v;
      },
      /** @deprecated the per-node scissor became per-node bbox-sized RTs. */
      // Internal: toggle the drawBundleInstanced GPU fast path (default on).
      // Used by the render-diff smoke to compare it against the loop.
      _setInstancedFast(v) {
        _instancedFastEnabled = !!v;
      },
      dispose,
      // WebGL context-loss state. True between webglcontextlost and
      // webglcontextrestored; while true all draw entry points no-op.
      // Consumers that own the canvas/gl should pass opts.onContextLost /
      // opts.onContextRestored to dispose()+recreate on a real loss.
      get isContextLost() {
        return _contextLost && !_disposed;
      },
      // True once the context came back after a loss: this renderer (and every bundle made before the loss) is unusable, draw
      // entries throw, and the host must dispose() and recreate. isContextLost stays true until then.
      get needsRecreate() {
        return _needsRecreate && !_disposed;
      },
      /** @internal Compare renderer/glState.js's pipeline-state shadow against
       *  the driver; returns [] when they agree. Diagnostic only — getParameter
       *  can flush the pipeline. test/glStateAuditSmoke.mjs drives it. */
      __glAuditState: () => R.glAuditState(),
      /** @internal MEASUREMENT only — extra fill-shader defines, switchable BETWEEN DRAWS on one
       *  renderer, so an A/B of two kernels can hold everything else fixed. Giving each arm its own
       *  renderer is not a controlled experiment: three renderers on one context, handed a define
       *  that changes no code, time the same bundle at 1.633 / 2.008 / 0.933 ms. Selecting the
       *  variant per draw instead leaves the program as the only difference. Variants compile and
       *  cache on first use, so switching is a key lookup. probes/_cpatchOneRendererAB.mjs drives
       *  it; pass null to go back to the default kernel. */
      __setAbDefines: (d) => {
        R._abDefines = d && d.length ? d.slice() : null;
      },
      // Frame lifecycle.
      setViewport: R.setViewport,
      /// Render fewer pixels at the same screen size. Fill cost is linear in backing-store
      /// pixels, so this is a direct dial on frame time. See frameLoop.setResolutionScale.
      setResolutionScale: (s, o) => R.setResolutionScale(s, o),
      get resolutionScale() {
        return R._resScale;
      },
      beginFrame: R.beginFrame,
      endFrame: R.endFrame,
      // SVG export — serialize the last rendered frame to an SVG string by
      // replaying its recorded draw list on the native (DOM) backend. Async
      // (loads the native fallback on demand). setFrameCapture toggles the
      // per-frame draw recording it depends on (on by default). See the
      // exportFrameSVG docstring for preconditions/limitations.
      exportFrameSVG,
      setFrameCapture: R.setFrameCapture,
      get frameCaptureEnabled() {
        return _captureFrames;
      },
      // Scissor — per-draw rectangular clip in drawingBuffer
      // pixels (origin lower-left). Applies to default-framebuffer
      // draws only; internal RTs bypass via bindFb.
      setScissorRect: R.setScissorRect,
      clearScissorRect: R.clearScissorRect,
      // Free an external-clip coverage texture from renderClipCoverage.
      deleteClipTexture,
      // setNodeClip — render a clip BUNDLE to a framebuffer-aligned
      // coverage RT via the coverage fill pipeline (analytic, output resolution) and
      // return a new caller-owned WebGLTexture for use as a per-draw external
      // clip (opts.extClipTex + extClipMode); free with deleteClipTexture.
      renderClipCoverage: R.renderClipCoverage,
      // setNodeClip — register a stationary screen-space clip against a TARGET
      // bundle; auto-applied on every draw of that bundle (no per-draw
      // extClipTex plumbing). Same signature as the native scene's setNodeClip
      // so a consumer needs NO backend branch. opts: { clipBundle, worldMatrix,
      // mode: 'in'|'out' }. clearNodeClip(target) removes it.
      setNodeClip: R.setNodeClip,
      clearNodeClip: R.clearNodeClip,
      // Single-bundle draw with optional worldMatrix +
      // overrides. Composes between beginFrame/endFrame.
      // opts.dstRect [x,y,w,h] (viewport px, y-down) places the draw in a RECTANGLE of the
      // viewport instead of the whole of it, with opts.fit in preserveAspectRatio's vocabulary
      // and opts.clipToRect (default true) cropping at the rect's edges.
      drawBundle: R.drawBundle,
      // The em → viewport-pixel matrix for the draw drawBundle(target, opts) would perform:
      // viewport fit, dstRect/fit placement and the caller's worldMatrix, composed. Feed it to
      // fillHitShape's `worldMatrix` so a hit test answers for the pixels actually drawn —
      // opts.worldMatrix alone cannot, since it acts in clip space and has no viewport fit in it.
      bundleDrawMatrix: R.bundleDrawMatrix,
      // Same as drawBundle, but DEFERRED and stacking-ordered: the draw is queued and
      // painted at endFrame() in (zOrder asc, submission asc) order. Lower zOrder paints
      // underneath; equal zOrder keeps submission order. Use when stacking must not depend
      // on the order things happen to mount (async overlays, HUD above gameplay).
      submitBundle: R.submitBundle,
      // Synchronously build a bundle's Loop-Blinn meshes now (on the main thread),
      // instead of waiting for the off-thread worker build to land. The runtime
      // never needs this — the draw path uses ready-LB-or-Slug — but eager callers
      // (scene prewarm) and tests that must assert LB routing deterministically do.
      prepareBundle: (bundle) => {
        if (_disposed || _contextLost) return false;
        bundle = unwrapBundle(bundle);
        if (R._aacPointsWarm) R._aacPointsWarm(bundle);
        const prep = beginPreparation('prepareBundle', gl);
        try {
          return R.prepareBundle(bundle);
        } finally {
          endPreparation(prep);
          if (R._memEnforce) R._memEnforce(true);
        }
      },
      // Explicit loading completion for the otherwise idle-scheduled CPatch worker warm-up.
      warmCPatchPool: R.warmCPatchPool,
      /// Resolve once a bundle's Loop-Blinn meshes are built and ready to ROUTE.
      ///
      /// Static bundles build their LB meshes OFF the main thread (the load-time
      /// worker in lbWorkerPool); until that lands the draw path renders Slug, so
      /// the first frame after createBundle is Slug even with LB enabled. Callers
      /// that need LB on the very first painted frame (avoiding a Slug→LB pop) —
      /// and tests that assert LB routing deterministically — await this first.
      ///
      /// Resolves true when real LB meshes are resident (`_lbMeshes` is a
      /// non-null array at the current geometry generation), false when automatic
      /// policy skips construction or on timeout (for example, an all-Slug result).
      /// Note prepareBundle's synchronous main-thread build can leave `_lbMeshes`
      /// null for shapes only the worker builds; this waits past that for the
      /// worker's array, so it stays correct whether or not prepareBundle ran.
      awaitLbReady(bundle, timeoutMs = 5000) {
        return new Promise((resolve) => {
          if (!bundle) {
            resolve(false);
            return;
          }
          // A shape-morph handle wraps its drawable bundle (where _morphSrc lives);
          // unwrap so awaitLbReady(morph) waits on the morph-pair build, not a
          // non-existent static mesh.
          bundle = unwrapBundle(bundle);
          if (!bundle || _disposed || _contextLost) {
            resolve(false);
            return;
          }
          // Slug-only renderer never builds LB → don't spin until timeout.
          if (R._lbSlugOnly) {
            resolve(false);
            return;
          }
          const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
          // MORPH bundles build their pair meshes off-thread too (a re-target sets a
          // fresh _morphSrc → a fresh build), so readiness is _morphMeshesBuilt, set
          // once the worker (or its sync fallback) lands via _applyMorphResult. The
          // build is normally kicked off by the first draw; the poke below starts it
          // here too, so awaitLbReady resolves even when called before any draw.
          // A settled Slug decision is also finished work, but it is not LB-ready.
          // Resolve it immediately as false instead of spinning until timeout or
          // reporting a successful analytic route.
          const hasRealMeshes = () =>
            bundle._morphSrc
              ? Array.isArray(bundle._morphMeshes) && bundle._morphMeshes.some((m) => !!m)
              : Array.isArray(bundle._lbMeshes) &&
                bundle._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0);
          const settled = () => {
            if (bundle._morphSrc) return !!bundle._morphMeshesBuilt;
            // A GATED BUILD THE current SELECTION WOULD DRAW MORE OF IS NOT READY EITHER, and it looks
            // ready to every other test here: its meshes are real, non-Slug and at the current
            // generation. A bundle built under an explicit 'auto' skips the rows the per-shape policy
            // can never give a mesh to; pinning a mode afterwards starts a rebuild, and resolving
            // before it lands hands the caller the set that is being replaced.
            if (R._lbBuildStale && R._lbBuildStale(bundle)) return false;
            // A partially adopted bundle is drawable but not finished. Shapes are adopted in batches
            // as the builder completes them, so real meshes exist long before the last one lands —
            // and this promise means FULL quality, or the shapes still building would pop from Slug
            // to Loop-Blinn after a caller had been told there was nothing left to wait for.
            const gen = bundle._geomGen | 0;
            const cpatchReady =
              bundle._fillMeshOwner === MESH_OWNER.CPATCH &&
              (bundle._cpatchBuilt | 0) > 0 &&
              (bundle._lbGen | 0) === gen &&
              hasRealMeshes();
            // An older LB build does not delay the current CPatch owner.
            if (!cpatchReady && bundle._lbPartialGen === gen) return false;
            if (!cpatchReady && bundle._lbWorkerPendingGen === gen) return false;
            if (R.opts && R.opts.cpatchAuto === true && !bundle._morphSrc) {
              if (bundle._cpatchConv === 'pending') return false;
              if (bundle._cpatchRetry === true && R.prepareBundle) {
                try {
                  R.prepareBundle(bundle);
                } catch {
                  /* fallback */
                }
              }
            }
            if (hasRealMeshes()) return true;
            return bundle._lbMeshes !== undefined && (bundle._lbGen | 0) === gen;
          };
          // The morph build is triggered by the first draw; poke it here so
          // awaitLbReady works without a prior draw (a caller may await before drawing).
          if (bundle._morphSrc && R._morphChainRelease) R._morphChainRelease(bundle);
          if (bundle._morphSrc && !bundle._morphMeshesBuilt && R._ensureBundleMorphMeshes) {
            try {
              R._ensureBundleMorphMeshes(bundle);
            } catch {
              /* draw-time fallback */
            }
          } else if (!bundle._morphSrc && R._requestLbBuild) {
            try {
              if (R._requestLbBuild(bundle) === false) {
                resolve(false);
                return;
              }
            } catch {
              /* remain on coverage fallback */
            }
          }
          // Analytic readiness requires the mesh, linked fill program and driver pipeline.
          // Variant selection re-enqueues mismatched programs; precompileFills drains
          // those queues. Try at most three rounds here, then leave remaining work
          // to frame-slack warming.
          const warmFillVariant = () => {
            try {
              if (!R._fillVariantHasLbFill) return;
              if (R._unifiedFillEligible && !R._unifiedFillEligible(bundle)) return;
              for (let i = 0; i < 3; i++) {
                if (R._fillVariantHasLbFill(bundle)) return; // ...and enqueues on a miss
                if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
                if (R._precompileNow) R._precompileNow(); // (non-blocking mode: no wait -- whatever is ready is done, the rest is the loading call's or frame slack's)
              }
            } catch {
              /* best effort: the draw path still warms during frame slack */
            }
          };
          const done = () => {
            const real = hasRealMeshes();
            if (real && !R._warmQuick) warmFillVariant(); // precompileFillsAsync warms once, after every bundle's meshes have arrived
            return real;
          };
          if (settled()) {
            resolve(done());
            return;
          }
          const start = now();
          const tick = () => {
            // A loss (or a restore, which leaves the renderer unusable) ends the wait: the build can never become drawable.
            if (_contextLost) {
              resolve(false);
              return;
            }
            if (settled()) {
              resolve(done());
              return;
            }
            if (now() - start >= timeoutMs) {
              resolve(false);
              return;
            }
            setTimeout(tick, 8);
          };
          setTimeout(tick, 8);
        });
      },
      /// READY TO DRAW WITH this ENGINE — one question, one answer, for every engine.
      ///
      /// Slug and AAC resolve true immediately: they need no build, and returning false for "nothing
      /// to wait for" would be the same trap in the other direction.
      async awaitEngine(bundle, engine, timeoutMs = 20000) {
        if (!bundle) return false;
        bundle = unwrapBundle(bundle);
        if (!bundle || _disposed || _contextLost) return false;
        if (
          engine === ENGINES.SLUG ||
          engine === ENGINES.AAC ||
          engine === ENGINES.INERT ||
          engine === ENGINES.HARD_BAND ||
          engine === ENGINES.HARD_TREE ||
          engine === ENGINES.HARD_MIXED
        )
          return true;
        // An explicit request for LB or CPatch on this bundle: under router 'auto' a static bundle draws the cover pass and would never build either, so the request is recorded
        // on the bundle (fillRouteClass.js 'engine-requested') and the build starts; the bundle then rides the unified route.
        if (engine === ENGINES.LB) bundle._lbRequested = true; // (the morph chain gate yields to an LB request only, morphDraw)
        if (!bundle._engineRequested && (engine === ENGINES.LB || engine === ENGINES.CPATCH)) {
          bundle._engineRequested = true;
          if (R.prepareBundle) {
            try {
              R.prepareBundle(bundle);
            } catch {
              /* the wait below reports it */
            }
          }
        }
        const deadline =
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) + timeoutMs;
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        if (engine === ENGINES.CPATCH) {
          if (R.prepareBundle) {
            try {
              R.prepareBundle(bundle);
            } catch {
              /* falls back */
            }
          }
          while (bundle._cpatchConv === 'pending' && now() < deadline && !_contextLost)
            await sleep(5);
          if (_contextLost) return false;
          if (R.prepareBundle) {
            try {
              R.prepareBundle(bundle);
            } catch {
              /* falls back */
            }
          }
          while (bundle._cpatchMorphPlan === 'pending' && now() < deadline && !_contextLost)
            await sleep(5);
          if (_contextLost) return false;
          if (bundle._morphSrc) {
            // CPatch's settled plan must be consumed before testing readiness.
            // awaitLbReady starts the separate LB pair build and checks
            // _morphMeshes, while CPatch owns _lbMeshes and _cpatchBuilt. Asking
            // it here can report a false decline or replace the posed resources.
            if (!bundle._cpatchMorphPlan || bundle._cpatchMorphPlan === 'pending') return false;
            if (R.prepareBundle) {
              try {
                R.prepareBundle(bundle);
              } catch {
                return false;
              }
            }
            if (!(bundle._cpatchBuilt > 0)) return false;
            for (let i = 0; i < 3 && now() < deadline; i++) {
              if (R._fillVariantHasLbFill && R._fillVariantHasLbFill(bundle)) return true;
              if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
              if (R._precompileNow) R._precompileNow();
              await sleep(5);
            }
            return !!(R._fillVariantHasLbFill && R._fillVariantHasLbFill(bundle));
          }
        }
        // ...and then the mesh wait, which also tries for the variant CPatch needs exactly as LB does (both ride the unified
        // route). Under a non-blocking renderer that try returns on the mesh, whatever the link has reached.
        if (_contextLost) return false;
        const left = Math.max(0, deadline - now());
        return !!(await built.awaitLbReady(bundle, left));
      },
      /// WARM A SCENE, AND SAY WHETHER IT IS WARM. Loading code names the draw states the first frames will use; each state's
      /// `draw` runs the exact future draw (the same canvas, viewport, transform, blend, overrides and morph pose) behind the load
      /// screen. After every pass the renderer fences, runs precompileFills (outside the draw), fences again and reads what was built.
      /// A state is STABLE when a whole pass built nothing: no program created, no variant added, none pending, no pipeline readied.
      /// The count of passes is not fixed -- a state that keeps building (a morph interval that needs another pipeline) runs on until it
      /// stops or `maxPasses` -- and the report says which states did not reach stable, so a caller never has to guess that a fixed warm
      /// was enough. The visible first frame must still clear: warm pixels are the caller's to hide.
      ///   states: [{ name?, bundle?, engine?, draw: () => void | Promise<void> }]; `bundle` + `engine` first await that engine's readiness.
      ///   opts: { maxPasses = 8, fenceTimeoutMs = 4000, readyTimeoutMs = 20000 }
      /// Resolves { complete, programs, ms, states: [{ name, ready, passes, stable, programsCreated, variantsAdded, pipelinesReadied,
      ///   fenced, error }] }; `complete` is true only when every state was ready, stable and fenced.
      /// Program counts include engine readiness and draw/warm passes, for all library programs in the current context generation.
      /// Shared helpers and other renderers on the same context contribute to the count.
      /// A context change during a state's pass fails that state instead of reporting a count across generations.
      async warmScene(states, opts = {}) {
        if (_disposed || _contextLost) return { complete: false, programs: 0, ms: 0, states: [] };
        const maxPasses = Math.max(1, opts.maxPasses | 0 || 8);
        const fenceTimeoutMs = opts.fenceTimeoutMs != null ? opts.fenceTimeoutMs : 4000;
        const readyTimeoutMs = opts.readyTimeoutMs != null ? opts.readyTimeoutMs : 20000;
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const sig = () =>
          R._warmSignature
            ? R._warmSignature()
            : {
                variants: 0,
                ready: 0,
                pending: 0,
                queued: 0,
                programs: contextProgramsCreated(R.gl),
                generation: resourceGeneration(R.gl),
              };
        const gl = R.gl;
        // wait for the GPU to finish what was submitted (a fence where WebGL2 has one, finish() otherwise); false = timed out
        const fence = async () => {
          try {
            if (typeof gl.fenceSync === 'function' && typeof gl.clientWaitSync === 'function') {
              const f = trackGlResource(gl, gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
              gl.flush();
              const t0 = now();
              for (;;) {
                const r = gl.clientWaitSync(f, 0, 0);
                if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) {
                  deleteGlResource(gl, 'Sync', f);
                  return true;
                }
                if (r === gl.WAIT_FAILED || now() - t0 > fenceTimeoutMs) {
                  deleteGlResource(gl, 'Sync', f);
                  return false;
                }
                await sleep(2);
              }
            }
            if (typeof gl.finish === 'function') gl.finish();
            return true;
          } catch {
            return false;
          }
        };
        const t00 = now(),
          report = [];
        let complete = true;
        if (R._retryFailedLinks) R._retryFailedLinks(); // (a safe window: a key that failed to link is tried once more)
        for (let i = 0; i < (states ? states.length : 0); i++) {
          /** @type {any} */ const st = states[i] || {};
          const row = {
            name: st.name != null ? st.name : String(i),
            ready: true,
            passes: 0,
            stable: false,
            programsCreated: 0,
            variantsAdded: 0,
            pipelinesReadied: 0,
            fenced: true,
            error: null,
          };
          report.push(row);
          try {
            if (typeof st.draw !== 'function') throw new Error('warmScene state has no draw()');
            const first = sig();
            if (st.bundle && st.engine)
              row.ready = !!(await this.awaitEngine(st.bundle, st.engine, readyTimeoutMs));
            if (sig().generation !== first.generation)
              throw new Error('WebGL context changed during warming');
            for (let pass = 1; pass <= maxPasses; pass++) {
              const before = sig();
              await st.draw();
              if (!(await fence())) row.fenced = false;
              if (R._precompileNow) {
                // Internal pipeline draws must not append to the captured frame.
                const capture = R._captureFrames;
                R._captureFrames = false;
                try {
                  R._precompileNow();
                } finally {
                  R._captureFrames = capture;
                }
              }
              if (!(await fence())) row.fenced = false;
              const after = sig();
              row.passes = pass;
              if (after.generation !== before.generation)
                throw new Error('WebGL context changed during warming');
              if (
                after.programs === before.programs &&
                after.variants === before.variants &&
                after.ready === before.ready &&
                after.pending === 0 &&
                after.queued === 0 &&
                after.demands === 0 &&
                after.customWarms === before.customWarms &&
                after.baseWarms === before.baseWarms
              ) {
                row.stable = true;
                break;
              }
            }
            const last = sig();
            if (!row.stable) row.remaining = last;
            row.programsCreated = last.programs - first.programs;
            row.variantsAdded = last.variants - first.variants;
            row.pipelinesReadied =
              last.ready - first.ready + ((last.baseWarms || 0) - (first.baseWarms || 0));
          } catch (ex) {
            row.error = String((ex && ex.message) || ex);
          }
          if (!row.ready || !row.stable || !row.fenced || row.error) complete = false;
        }
        return { complete, programs: contextProgramsCreated(gl), ms: now() - t00, states: report };
      },
      /// Declare the bundles one scene draws, so bundles whose programs share a kernel class bind ONE union program (fillPass.js, the scene union).
      /// Pass null to clear. Pixels are unchanged; the program count, link and first-pipeline work fall, the shared program carries each member's kernels.
      setSceneUnion: (bundles) => {
        if (R.setSceneUnion) R.setSceneUnion(bundles);
      },
      /// The fill defines this bundle's draw would bind now, the scene union included (tests and probes).
      _variantDefinesNow: (bundle) =>
        R._variantDefinesNow ? R._variantDefinesNow(unwrapBundle(bundle)) : [],
      /// Non-blocking: start linking the fill program this bundle will use. Call at load.
      prewarmBundle: (bundle) => {
        if (_disposed) return;
        bundle = unwrapBundle(bundle);
        if (R._aacPointsWarm) R._aacPointsWarm(bundle);
        if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
      },
      /// Budget for resident Loop-Blinn mesh memory (bytes). Bundles whose
      /// projected footprint would exceed it render via Slug instead.
      setLoopBlinnMemoryBudget: R.setLoopBlinnMemoryBudget,
      estimateRouteBytes: R.estimateRouteBytes,
      /// Byte-accurate GPU memory by category, cache and bundle; CPU bytes; preparation high-water; budget policy counters (README: Memory).
      getMemoryStats: (o) => R.getMemoryStats(o),
      /// The draw states this bundle can enter, named by the app (`tags`: 'rotate', 'recolor', 'palette', 'channelLerp', 'overrides', 'strokeWidth', 'alpha';
      /// [] = drawn as is only; null = undeclared again): the warm builds those and no others. A state outside it, drawn anyway, is a need miss in play.
      declareReach: (bundle, tags) => {
        if (R._declareBundleReach) R._declareBundleReach(unwrapBundle(bundle), tags);
      },
      /// This imported bundle will be streamed with updateBundleGeometry (false or null: it will not, again). Declared before the loading call, the warm builds what its updates bind, so its first update
      /// links and builds nothing in play. A lightweight update needs one update before the loading call as well: the warm has no meshes to draw the unified keys with until then.
      declareStream: (bundle, on = true) => {
        if (_disposed) return;
        if (R._declareBundleStream)
          R._declareBundleStream(unwrapBundle(bundle), on !== false && on !== null);
      },
      /// The scene memory budget in bytes (Infinity or null: none). Optional resources are refused or evicted past it; see README: Memory.
      setMemoryBudget: (bytes) => {
        if (_disposed) return;
        R.setMemoryBudget(bytes);
      },
      getMemoryBudget: () => R.getMemoryBudget(),
      /// Reset the GPU peak and the preparation high-water to the current level.
      resetMemoryPeaks: () => R.resetMemoryPeaks(),
      getFillPolicyOptions: R.getFillPolicyOptions,
      setFillPolicyOptions: R.setFillPolicyOptions,
      /// PER-SHAPE budget (bytes of packed vertex stream). Default: no limit. A shape whose stream
      /// would exceed it is never packed and renders via Slug; the refusal is reported in
      /// debugStats (`lbShapeMemDeclined`, `lbShapeMemWantedBytes`), never silent.
      setLoopBlinnShapeMemoryBudget: R.setLoopBlinnShapeMemoryBudget,
      setLoopBlinnMeshOpts: R.setLoopBlinnMeshOpts,
      getLoopBlinnMemoryUse: () => R._lbMemUsed | 0,
      // Per-instance fill pass without entering
      // the frame lifecycle. Caller owns viewport/clear/blend.
      drawInstance: R.drawInstance,
      // Direct raster blit. createImage(src, opts) uploads a reusable
      // premultiplied texture handle ({width,height,dispose()}); drawImage
      // (handleOrSource, opts) composites it into the current frame with
      // dstRect / worldMatrix / srcRect / alpha / tint / blendMode. Mirrors
      // the SVG <image> source paths. Composes between beginFrame/endFrame
      // like drawBundle.
      createImage: (source, o) => (_disposed ? null : createImage(source, o)),
      drawImage,
      // Additive Loop-Blinn hybrid fill — render one solid-fill shape's mesh
      // (buildLoopBlinnMesh output) via analytic implicit coverage instead of
      // the Slug ray-cast. Resolution-independent, GPU-cheap; the cost-driven
      // alternative to drawBundle's per-fragment fill for qualifying shapes.
      // THE single toggle for the analytic (Loop-Blinn) fill path, governing every
      // route — static bundles (bare drawBundle, handle.draw, instanced), streamed
      // bundles, AND createShapeMorph handles. Mirrors Slug as one fill path with
      // one switch (no separate static/morph flags to drift apart):
      //   'off'         · always use the Slug ray-cast.
      //   'auto' (DEFAULT) · route the paths where LB WINS: GPU morphs, streamed
      //                   bundles, and static bundles SHAPE BY SHAPE — each shape
      //                   whose mesh wins draws it, the rest draw their cover quads
      //                   in the same stream (lbShapePolicy). Strokes, clipped,
      //                   masked and filtered shapes keep their cover quads.
      //   'on'          · additionally force gradient/image/composed static bundles
      //                   through LB (bypass the perf gate); ineligible shapes still
      //                   fall back to Slug.
      //   'only'        · LB only — no Slug fallback. A shape with no ready/eligible
      //                   analytic mesh draws nothing (and the static cache won't
      //                   bake an empty frame). For isolating/inspecting the LB path.
      // `true`→'on' (full LB), `false`→'off' (Slug only, LB build skipped).
      /// Draw a bundle's cover quads AND Loop-Blinn triangles in ONE call through
      /// the fill ubershader. Returns false when the bundle can't be served that
      /// way, so a caller falls through to its existing route. Requires the
      /// renderer to have been created with fillDefines including MANTLE_LB_FILL.
      /// Internal while the route selection is being built out.
      _drawBundleUnifiedFill(bundle) {
        return R._drawBundleUnifiedFill(bundle);
      },
      /// Bisector ownership for the split stroke: each segment claims only its
      /// side of each joint, so overlapping segment quads become a PARTITION and
      /// plain OVER is exact at any alpha. Required before stroke segments can
      /// join the unified fill draw and the coverage RT can go.
      setStrokePartition(on) {
        R.strokePartition = !!on;
      },
      /// Stroke covers: auto selects eligible strips by saved pixels per vertex;
      /// on forces eligible strips, off uses quads. The threshold defaults to64.
      /// maxMode1 excludes overlapping strips; maxMode2 permits depth ownership.
      setStrokeStrip(sel) {
        if (!sel || typeof sel !== 'object') return;
        // Validated before anything is written. policy: 'auto' | 'on' | 'off' | boolean, maxMode: 1 | 2, anything else throws;
        // minSavedPxPerVertex: a number, NaN and non-numbers throw, negatives clamp to 0 (the threshold of "every row").
        let policy, saved, mode;
        if (sel.policy != null) {
          if (
            sel.policy !== 'auto' &&
            sel.policy !== 'on' &&
            sel.policy !== 'off' &&
            typeof sel.policy !== 'boolean'
          )
            throw new Error(
              'setStrokeStrip: unknown policy ' +
                JSON.stringify(sel.policy) +
                ' (expected auto | on | off | boolean)',
            );
          policy =
            sel.policy === 'off' || sel.policy === false
              ? false
              : sel.policy === 'on' || sel.policy === true
                ? 'on'
                : 'auto';
        }
        if (sel.minSavedPxPerVertex != null)
          saved = clampArg(
            'setStrokeStrip',
            'minSavedPxPerVertex',
            sel.minSavedPxPerVertex,
            0,
            Infinity,
          );
        if (sel.maxMode != null) {
          if (sel.maxMode !== 1 && sel.maxMode !== 2)
            throw new Error(
              'setStrokeStrip: maxMode must be 1 or 2, got ' + JSON.stringify(sel.maxMode),
            );
          mode = sel.maxMode;
        }
        if (policy !== undefined) R.opts.strokeStrip = policy;
        if (saved !== undefined) R.opts.strokeStripMinSavedPx = saved;
        if (mode !== undefined) R.opts.strokeStripMode = mode;
      },
      /// Select the geometry route and cover kernel independently. Omitted axes
      /// retain their values. LB/CPatch/none route pins and Slug/AAC kernel pins
      /// suppress SDF primitives unless primitives:'on' is set. Explicit auto enables preparation policy;
      /// commit:false returns to the uncommitted default policy.
      setFillEngine(sel) {
        if (!sel || typeof sel !== 'object') return;
        // One rule for every enum field: null / undefined leaves the axis alone, a value outside the vocabulary THROWS before any
        // state changes (a typo must not silently pin an engine, and the sdf pin is process-wide). Matching is exact and case-sensitive.
        const pick = (field, value, allowed) => {
          if (value == null) return undefined;
          if (!allowed.includes(value))
            throw new Error(
              'setFillEngine: unknown ' +
                field +
                ' ' +
                JSON.stringify(value) +
                ' (expected ' +
                allowed.join(' | ') +
                ')',
            );
          return value;
        };
        sel = {
          route: pick('route', sel.route, FILL_ROUTES),
          kernel: pick('kernel', sel.kernel, FILL_KERNELS),
          primitives: pick('primitives', sel.primitives, FILL_PRIMITIVES),
          commit: pick('commit', sel.commit, [true, false]),
          cpatch: pick('cpatch', sel.cpatch, [true, false]),
        };
        if (sel.route === 'cpatch' || sel.route === 'cpatch-auto' || sel.cpatch === true)
          requireRendererFeature(
            'cpatch',
            'setFillEngine(' +
              JSON.stringify(sel.route === undefined ? { cpatch: true } : { route: sel.route }) +
              ')',
          );
        if (sel.route !== undefined) {
          const r = sel.route === 'cpatch-auto' ? 'auto' : sel.route;
          const cpAuto = sel.route === 'cpatch-auto' || (r === 'auto' && sel.cpatch === true);
          // CPatch rides the unified LB route, so choosing it is choosing that route AND the
          // conversion. Choosing 'lb' turns the conversion off rather than leaving it set, or the
          // previous selection would keep drawing CPatch and the report would be right while the
          // request was ignored.
          R.opts.cpatchFill = r === ENGINES.CPATCH;
          R.opts.cpatchAuto = cpAuto;
          // A forced cover route draws plain cover (engineSwitch.js forcedCover): a primitive is not an exception to it.
          R._forcedCover = r === 'none' || r === ENGINES.LB || r === ENGINES.CPATCH;
          this.setLoopBlinnFill(r === 'none' ? 'off' : r === 'auto' ? 'auto' : 'on');
          if (r === 'auto' && sel.commit === false) R._lbAutoExplicit = false;
        } else if (sel.cpatch !== undefined) {
          R.opts.cpatchAuto =
            sel.cpatch === true &&
            R._lbFillMode === 'auto' &&
            !R._lbSlugOnly &&
            R.opts.cpatchFill !== true;
        }
        // `primitives: 'on'` keeps the recognized primitives of a forced cover arm.
        if (sel.primitives !== undefined)
          R._forcedPrimitivesOn = sel.primitives === 'on' || sel.primitives === true;
        if (sel.kernel !== undefined) {
          const k = sel.kernel;
          R.opts.fillKernel = k === ENGINES.HARD_BAND || k === ENGINES.HARD_TREE ? k : null;
          R.opts.aacFill = k === 'auto' ? 'auto' : k === ENGINES.AAC;
          // a pinned Slug / AAC kernel is a pin too: a recognized primitive must not take the draw over (primitives: 'on' opts back in)
          R._forcedKernel = k === ENGINES.SLUG || k === ENGINES.AAC;
        }
        // a pin stops primitive recognition for bundles built from here on (shapeRecognize.js setSdfPrimitivesPinned)
        const selection = engineSelection(R);
        setSdfPrimitivesPinned(selection.forcedCover || selection.primitivesOff);
      },
      /// Requested route/kernel state. debugStats.engines reports actual emitted draws.
      /// Legacy 'only' suppresses fallback; unifiedFill:'force' reports 'force'.
      getFillEngine() {
        return {
          route:
            R.opts.unifiedFill === 'force'
              ? 'force'
              : R.opts.cpatchFill === true
                ? ENGINES.CPATCH
                : R._lbSlugOnly
                  ? 'none'
                  : R._lbFillMode === 'auto'
                    ? 'auto'
                    : R._lbSlugFallback
                      ? ENGINES.LB
                      : 'only',
          kernel:
            R.opts.fillKernel ||
            (R.opts.aacFill === 'auto' ? 'auto' : R.opts.aacFill ? ENGINES.AAC : ENGINES.SLUG),
          // Explicit auto enables build-time policy; the implicit default does not.
          routeCommitted:
            R._lbFillMode === 'auto' &&
            R._lbAutoExplicit === true &&
            !R._lbSlugOnly &&
            R.opts.cpatchFill !== true &&
            R.opts.unifiedFill !== 'force',
          cpatchAuto:
            R._lbFillMode === 'auto' &&
            R.opts.cpatchAuto === true &&
            !R._lbSlugOnly &&
            R.opts.cpatchFill !== true &&
            R.opts.unifiedFill !== 'force',
        };
      },
      /// Legacy route selector. Explicit auto enables per-shape preparation policy.
      /// A later pin rebuilds omitted meshes. Off suppresses analytic builds/draws
      /// while retaining recognized primitives; only disables cover fallback.
      setLoopBlinnFill(mode) {
        // true -> 'on', false / null / undefined -> 'off', the four names as given; anything else THROWS (the same rule as
        // setFillEngine: a typo is an error, never a silent 'off').
        if (
          mode != null &&
          typeof mode !== 'boolean' &&
          mode !== 'on' &&
          mode !== 'auto' &&
          mode !== 'off' &&
          mode !== 'only'
        )
          throw new Error(
            'setLoopBlinnFill: unknown mode ' +
              JSON.stringify(mode) +
              ' (expected off | auto | on | only | boolean)',
          );
        const m = mode === true ? 'on' : mode === false || !mode ? 'off' : mode;
        // Retain whether preparation policy was explicitly selected.
        R._lbAutoExplicit = m === 'auto';
        // Off skips analytic mesh preparation.
        R._lbSlugOnly = m === 'off';
        // 'only' = LB only → suppress the Slug fallback so unbuilt/ineligible shapes
        // draw nothing instead of Slug.
        R._lbSlugFallback = m !== 'only';
        // 'only' routes like 'on' (force LB); the fallback flag is what makes it LB-only.
        R._lbFillMode = m === 'only' ? 'on' : m;
      },
      // Back-compat alias: the morph route shares the single R._lbFillMode, so
      // this just forwards to setLoopBlinnFill. Prefer setLoopBlinnFill.
      setLoopBlinnMorphFill(mode) {
        this.setLoopBlinnFill(mode);
      },

      setStrokeGates(on) {
        R.strokeGates = on !== false;
      },
      /// Override the cover quad's directional pixel-box margin.
      /// Rotated exact-cover variants enable this automatically. Explicit
      /// true/false overrides that policy without rebuilding shaders. Exact
      /// fills retain their separate inverse-map affine support.
      setCoverAaReach(on) {
        R.coverAaReach = on === true;
      },
      /// Exact-area AA on straight stroke edges. ON by default.
      ///
      /// Off restores the isotropic ramp.
      /// A runtime uniform rather than a shader define, because passing
      /// fillDefines selects a different variant and costs 16-35% by itself,
      /// against 3-8% for this feature.
      setStrokeExactAa(on) {
        R.strokeExactAa = on !== false;
      },
      /// Process-wide primitive recognition for subsequent preparation. Existing
      /// meshes are retained; setFillEngine controls their renderer-local admission.
      setSdfPrimitives(on) {
        setSdfPrimitivesEnabled(on);
      },
      // Instanced raster blit — stamp one shared texture at N transforms in a
      // single drawArraysInstanced. Pass an
      // image handle (createImage) + an array of per-instance
      // { dstRect, worldMatrix, tint, alpha }; shared srcRect/blendMode in opts.
      drawImageInstanced,
      // Live-fill instancing — draw one bundle at N per-instance transforms
      // (worldMatrix + alpha + rgba tint; full colorMatrix/offset via the
      // per-instance loop), sharing geometry + a single overrides table.
      // The mask/filter bakes run once and are reused across instances; only
      // the fill pass repeats. Counterpart to R.drawImageInstanced for content
      // that must stay live (not a baked texture). See its docstring.
      drawBundleInstanced: R.drawBundleInstanced,
      // Sprite-sheet API — draw one addressable sprite (top-level <g id> /
      // lone id'd top-level shape) from a sheet bundle, by id or range.
      // R.drawSprite = subset of drawBundle; R.drawSpriteInstanced = subset of
      // drawBundleInstanced (N transforms, one bind). See bundle.spriteRanges.
      drawSprite,
      drawSpriteInstanced,
      // Bundle-handle API. Per-mount persistent handle that owns its own
      // VAO+VBO pair, mask region cache, and its own static-scene cache RT.
      // Designed for scenes with N
      // distinct bundles visible per frame (the multi-mount pattern): each
      // mount calls `handle.draw(opts)` per frame; the bundle stays
      // resident in the handle's VBOs across frames without re-upload.
      createBundleHandle: (target, o) => {
        if (_disposed) throw new Error('createBundleHandle: the renderer is disposed');
        return R.createBundleHandle(target, o);
      },
      // Up-front warm of every loaded bundle's fill pipelines. Call behind a LOADING
      // SCREEN (bundles created, before gameplay) for games that start animating
      // immediately and never present an idle window for the background warmer —
      // gameplay then runs on the lean variants with zero mid-play pipeline stalls.
      // Blocking by design. Returns the number of bundles warmed.
      // Blocking load call. While the context is lost it throws: returning 0 looked like "nothing to warm" to a loading gate.
      precompileFills: (o) => {
        if (_contextLost && !_disposed)
          throw new Error(
            'precompileFills: ' +
              (_needsRecreate
                ? STALE_CONTEXT_MSG
                : 'the WebGL context is lost; wait for webglcontextrestored and recreate the renderer'),
          );
        if (R._retryFailedLinks) R._retryFailedLinks(); // (the app's own loading call, and only this entry: the renderer calls R.precompileFills from draws too)
        return R.precompileFills(o);
      },
      // The promise-returning loading call (additive; precompileFills is unchanged for callers that do not await). Resolves when the
      // renderer has everything the first seconds of play will ask for built and the GPU has nothing left in flight:
      //   1. every bundle's analytic meshes have arrived from the workers (awaitLbReady), so the unified-route, area-split and kind-narrowed
      //      variants play will use exist and are the ones warmed;
      //   2. precompileFills' warm, in the scene as drawn and under a rotated map and a recolor (variants, point programs, mask bakes,
      //      instanced programs);
      //   3. a fence the GPU process signals only after the last pipeline build, polled without blocking the page, then a read-back barrier.
      // `opts.timeoutMs` bounds the mesh wait and the fence (default 20000 each). Resolves with precompileFills' count.
      async precompileFillsAsync(o = {}) {
        // LOADING CALLS RUN ONE AT A TIME. The size being warmed, the load's phase, the warm window and the cooperative uploads are one set of renderer state, and a second call running beside
        // the first would move all of them under it: the first call would warm and record a size it was not on, and whichever ended first would say the renderer was loaded while the other still built.
        while (_loadingCall) await _loadingCall;
        if (_contextLost && !_disposed)
          throw new Error(
            'precompileFillsAsync: ' +
              (_needsRecreate
                ? STALE_CONTEXT_MSG
                : 'the WebGL context is lost; wait for webglcontextrestored and recreate the renderer'),
          );
        if (_disposed || R.opts.psoWarm === false) return 0;
        /** @type {any} */
        let load = null;
        if (R._gateArm) R._gateArm(); // the fence gate needs its draw interposers from here on, in either mode
        R._loadCalled = true;
        if (R._retryFailedLinks) R._retryFailedLinks(); // (a safe window: a key that failed to link is tried once more)
        const _isWindow = !!(R._loadStats && R._loadStats.phase === 'done');
        if (_isWindow) {
          R._warmWindow = true;
          R._warmWindows = (R._warmWindows | 0) + 1;
        }
        const _scope = (o && /** @type {any} */ (o)._scopeBundle) || null; // (internal: awaitBundleReady)
        if (R._warmScopeEnter) R._warmScopeEnter(_scope);
        let _loadingDone = () => {};
        _loadingCall = new Promise((res) => {
          _loadingDone = res;
        });
        try {
          {
            const vp = o && o.viewport;
            R._warmViewportOpt =
              Array.isArray(vp) && vp[0] >= 1 && vp[1] >= 1 ? [vp[0] | 0, vp[1] | 0] : null;
          }
          const timeoutMs = o && o.timeoutMs != null ? +o.timeoutMs : 20000;
          const warmTimeoutMs = o && o.warmTimeoutMs != null ? +o.warmTimeoutMs : 180000;
          const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
          const t0 = now(),
            deadline = t0 + warmTimeoutMs;
          if (o && o.manifest && R._wmUse) R._wmUse(o.manifest);
          load = R._loadStats = {
            steps: 0,
            pauses: 0,
            slices: 0,
            frameWaits: 0,
            maxStepMs: 0,
            ms: 0,
            incomplete: false,
            phase: 'meshes',
          };
          // The cooperative driver: one budgeted step of the loading generator per timer turn. Between steps the page is idle (the loading
          // screen animates, input is served); a step that has to wait for a link or for the GPU thread says so (a pause) and the next turn asks
          // again. Nothing here, or in the generator, queries a program that is not ready (gpuGate.js).
          let lastSlow = 0;
          // COOPERATIVE UPLOADS (coopUpload.js): the big vertex uploads of the warm steps only allocate; the driver fills them one slice at a time while the GPU thread is clear.
          if (R._khrParallel && R._nbNow && R._nbNow())
            setCoopUploads(gl, true, () => R._forceLinks || !R._gpuClear || R._gpuClear());
          const drive = async (gen, flags) => {
            for (;;) {
              if (_disposed || _contextLost) {
                try {
                  gen.return(0);
                } catch {
                  /* done */
                }
                return 0;
              }
              try {
                pumpUploads(gl, 3);
              } catch {
                /* a lost context: the loop ends on the next check */
              }
              const s0 = now();
              let r;
              try {
                r = R._coopStep(gen, flags, o && o.sliceMs ? +o.sliceMs : 8);
              } catch (e) {
                try {
                  gen.return(0);
                } catch {
                  /* done */
                }
                throw e;
              }
              const dt = now() - s0;
              load.steps++;
              if (dt > load.maxStepMs) load.maxStepMs = dt;
              if (r.done) return r.value | 0;
              load.pauses = R._coopPauses | 0;
              if (now() > deadline) {
                load.incomplete = true;
                try {
                  gen.return(0);
                } catch {
                  /* done */
                }
                return 0;
              }
              const kind = R._coopLastPause;
              if (kind === 'slice') load.slices++;
              await new Promise((res) => setTimeout(res, kind === 'slice' ? 1 : 6));
              // A pipeline build that held the GPU thread for 50 ms or more starved the compositor with it: let one page frame present before the next
              // batch is queued, so the loading screen advances between builds instead of only after the last of them. (Capped: a page whose rAF
              // is throttled -- a hidden tab -- must not stall the load.)
              const slow = R._gateStats ? R._gateStats.slowFenceCount : 0;
              if (slow !== lastSlow) {
                lastSlow = slow;
                if (typeof requestAnimationFrame === 'function') {
                  load.frameWaits++;
                  await new Promise((res) => {
                    const t = setTimeout(res, 120);
                    requestAnimationFrame(() => {
                      clearTimeout(t);
                      res();
                    });
                  });
                }
              }
            }
          };
          R._warmQuick = (R._warmQuick | 0) + 1;
          try {
            await drive(R._precompileFillsG({ draw: false }), {}); // drains the bundles created since the last call into the live list
            load.phase = 'meshes';
            const live = R._liveBundles ? R._liveBundles() : [];
            await Promise.all(live.map((b) => this.awaitLbReady(b, timeoutMs).catch(() => false)));
          } finally {
            R._warmQuick--;
          }
          load.phase = 'warm';
          let n = 0;
          R._refreshLive = true;
          // The sizes to warm for: the hint(s) the app gave (`viewport`, `viewports`: drawing-buffer pixels) and the size the canvas has now. Size is a continuous
          // input, so these are STARTING POINTS only: a size change after loading is warmed automatically (fillPass.js backgroundViewportWarm).
          // (a warm scoped to one late bundle reads these, it does not set them: the range is the app's, for the whole scene)
          if (!_scope) {
            R._lastWarmOpts = o
              ? { minViewportPx: o.minViewportPx, maxViewportPx: o.maxViewportPx }
              : null;
            R._lastWarmOpt = R._warmViewportOpt || null;
          }
          const sizes = [];
          if (o && Array.isArray(o.viewports))
            for (const v of o.viewports)
              if (Array.isArray(v) && v[0] >= 1 && v[1] >= 1) sizes.push([v[0] | 0, v[1] | 0]);
          if (!sizes.length) sizes.push(R._warmViewportOpt || null);
          else if (
            R._warmViewportOpt &&
            !sizes.some((v) => v[0] === R._warmViewportOpt[0] && v[1] === R._warmViewportOpt[1])
          )
            sizes.unshift(R._warmViewportOpt);
          // STRICT PLAY: the loading call warms the programs of every decision region the display's reachable size range holds (fillPass.js _deriveSizeRegions).
          R._classList = false;
          let ownersOf = null;
          if (
            R.opts.strictPlay === true &&
            !(o && o.classes === false) &&
            !(o && Array.isArray(o.viewports)) &&
            R._deriveSizeRegions
          ) {
            const cur0 = R.viewportSize(),
              seen = new Set(sizes.filter(Boolean).map((v) => v.join('x')));
            const dv = R._deriveSizeRegions(
              R._warmViewportOpt || (_scope && R._lastWarmOpt) || cur0,
              _scope ? { ...(R._lastWarmOpts || {}), ...o } : o,
            );
            for (const v of dv.sizes)
              if (!seen.has(v.join('x'))) {
                seen.add(v.join('x'));
                sizes.push(v);
              }
            R._classList = true;
            if (R._sigAt)
              for (const k of ['sigAt', 'sigStr', 'stripKeyAt'])
                Object.defineProperty(dv, k, {
                  value: k === 'sigAt' ? R._sigAt : k === 'sigStr' ? R._sigStr : R._stripKeyAt,
                  enumerable: false,
                }); // (debug hooks, set only under __MANTLE_DEBUG__)   // (the production decision answer for a bundle at a size: the debug report and the cross-check test call it)
            ownersOf = dv.ownersOf;
            if (R._viewportWarm && !_scope) R._viewportWarm.derived = dv;
            // every size class inside the range is covered by a derived region: the background class warm (a build in a window) is for sizes outside it only
            // (a warm of one late bundle says nothing about a size class for the rest of the scene)
            if (!_scope)
              for (
                let L = Math.sqrt(dv.range.minW * dv.range.minH);
                L <= Math.sqrt(dv.range.maxW * dv.range.maxH);
                L *= 1.04
              )
                R._noteWarmedViewport(L, L);
          }
          const classRows =
            (!_scope && R._viewportWarm && (R._viewportWarm.loadClasses = [])) || [];
          // (a derived size whose owners ask for nothing an earlier warmed size did not is skipped: fillPass.js R._sizeCoveredG)
          // The keys asked for carry over to the next loading call while no program has been dropped since: a replay of the same art (new bundles, the same
          // content) asks for nothing new and warms no size. A size no bundle owns (the current one, the app's hint) is checked against every live bundle.
          const dropsAtStart = R._programsDropped | 0;
          const carried = R._askedAcrossLoads;
          const asked = carried && carried.drops === dropsAtStart ? carried.keys : new Set();
          R._askedAcrossLoads = null;
          try {
            for (const sz of sizes) {
              if (load.incomplete) break; // past the deadline: no later size is started
              const own = ownersOf
                ? (sz && ownersOf.get(sz[0] + 'x' + sz[1])) || (asked.size ? R._liveBundles() : null)
                : null;
              if (own && R._sizeCoveredG && (await drive(R._sizeCoveredG(sz, own, asked), {}))) {
                if (!_scope && sz) R._noteWarmedViewport(sz[0], sz[1]);
                classRows.push({
                  size: sz ? sz.slice() : null,
                  ms: 0,
                  pipelines: 0,
                  programs: [],
                  covered: true,
                });
                continue;
              }
              if (load.incomplete) break;
              // (once a size has been warmed, a later size warms only the bundles that ask there for a key not yet asked for: keys already built draw nothing new)
              let only = null;
              if (ownersOf && asked.size && R._uncoveredG) {
                const live = R._liveBundles();
                const out = [];
                await drive(R._uncoveredG(sz, live, asked, out), {});
                if (out.length < live.length) only = new Set(out);
              }
              R._warmViewportOpt = sz;
              const c0 = now(),
                p0 = R._gateStats && R._gateStats.pipeLog ? R._gateStats.pipeLog.length : 0;
              R._warmOnly = only;
              try {
                n += await drive(R._precompileFillsG(o), { _refreshLive: true, _noSync: true });
              } finally {
                R._warmOnly = null;
              }
              if (sz && !_scope) R._noteWarmedViewport(sz[0], sz[1]);
              const pl = R._gateStats && R._gateStats.pipeLog ? R._gateStats.pipeLog : [];
              classRows.push({
                size: sz ? sz.slice() : null,
                ms: Math.round(now() - c0),
                pipelines: pl.length - p0,
                programs: pl.slice(p0, p0 + 12).map((e) => e[1]),
              });
              if (ownersOf && R._noteSizeAskedG && !load.incomplete)
                await drive(R._noteSizeAskedG(sz, asked), {});
            }
            if (!_scope) {
              const cur = R.viewportSize();
              R._noteWarmedViewport(cur[0], cur[1]);
            }
            if (ownersOf && !load.incomplete && (R._programsDropped | 0) === dropsAtStart)
              R._askedAcrossLoads = { keys: asked, drops: dropsAtStart };
          } finally {
            R._refreshLive = false;
            R._warmViewportOpt = null;
          }
          // Anything still pending is promoted as the driver finishes it, then the GPU thread is waited for with a fence the page polls (the
          // pipelines the warm draws queued run for seconds on a cold cache; a page that starts drawing before they finish presents nothing),
          // and only then the read-back barrier, which a clear GPU thread answers at once.
          load.phase = 'drain';
          // every queued fill lands before the loading call ends (a play draw never sees a buffer that is still being filled)
          {
            const flushDeadline = now() + warmTimeoutMs;
            while (
              pendingUploadBytes(gl) > 0 &&
              now() < flushDeadline &&
              !_disposed &&
              !_contextLost
            ) {
              try {
                pumpUploads(gl, 4);
              } catch {
                break;
              }
              await new Promise((res) => setTimeout(res, 4));
            }
            setCoopUploads(gl, false);
          }
          if (R._promoteReady) {
            const last = now() + timeoutMs;
            while (
              R._promoteReady() > 0 &&
              now() < last &&
              now() < deadline &&
              !_disposed &&
              !_contextLost
            )
              await new Promise((res) => setTimeout(res, 6));
          }
          const fenceDeadline = now() + timeoutMs;
          while (R._gpuBusy && R._gpuBusy() && now() < fenceDeadline && !_disposed && !_contextLost)
            await new Promise((res) => setTimeout(res, 6));
          // (a window for one late bundle can open in play, and there the fence above is the barrier: the read-back took 34-67 ms with the GPU thread already clear)
          if (
            !_disposed &&
            !_contextLost &&
            R._gpuSync &&
            (!R._gpuBusy || !R._gpuBusy()) &&
            !(_scope && R._gpuBusy)
          )
            R._gpuSync();
          load.phase = 'done';
          load.ms = now() - t0;
          if (R._markLoadedBundles) R._markLoadedBundles();
          if (R._gateLoaded) R._gateLoaded(); // from here on a pipeline built for the first time is logged (debugStats.gpuGate.postReady)
          return n;
        } finally {
          if (R._warmScopeExit) R._warmScopeExit(_scope);
          if (_isWindow) R._warmWindow = false;
          // (a call that threw is over too: left at its phase, the renderer would read as still loading for the rest of its life, with no strict play and no background class warm)
          if (load && load.phase !== 'done') {
            load.phase = 'done';
            load.incomplete = true;
          }
          // Nothing pumps the queue after this: a fill left behind (the deadline passed with the GPU thread busy, the call threw, it was cut short by a dispose) would leave a buffer of
          // zeros that draws nothing until the next loading call. Finishing it here can wait behind a pipeline build; that is the path that is already late.
          try {
            setCoopUploads(gl, false);
            pumpUploads(gl, Infinity);
          } catch {
            /* a lost context */
          }
          _loadingCall = null;
          _loadingDone();
        }
      },
      /// A SAFE WARM WINDOW: the app is on a loading / transition / results screen and says so. Everything that play deferred to a window is built
      /// now (the lean programs of the states play met on a safety net, the programs of a new size class), cooperatively, then the promise
      /// resolves and play is strict again (no builds, no shed frames). The app keeps its transition screen up until it resolves.
      beginWarmWindow(o = {}) {
        return this.precompileFillsAsync(o);
      },
      /// One bundle created after the loading call (a story, a trial's text): resolves 0 at once when every program its draw states and reachable sizes need was already built by the
      /// loading call (the check is exact and cheap), otherwise opens one warm window for it. The app awaits it behind its own screen, before the bundle's first draw.
      /// (Asked after any loading call in flight: what it is still building is not built, and what it builds may be all this bundle needs.)
      async awaitBundleReady(bundle, o = {}) {
        bundle = unwrapBundle(bundle);
        while (_loadingCall) await _loadingCall;
        return R._bundleNeedsWarm && R._bundleNeedsWarm(bundle)
          ? this.precompileFillsAsync({ ...o, _scopeBundle: bundle })
          : 0;
      },
      /// The draw states this renderer has met, per bundle (names are content hashes), for `precompileFillsAsync({ manifest })` /
      /// `createRenderer(..., { warmManifest })` in a later session. Throws unless the renderer was created with `recordWarmManifest: true`.
      exportWarmManifest: () => R.exportWarmManifest(),
      /// The background warm queue (warmQueue.js): add scenes by manifest or bundles, focus one, resume, cancel, status.
      warm: R.warm,
      /// The game context of the warm policy: `{ game, active, viewport, needed, declaredNeeds }` (= warm.setContext).
      setWarmContext: (c) => R.warm.setContext(c),
      /// Test and tool hooks of the warm policy (under __MANTLE_DEBUG__): the production key decision for a draw state, the keys a runtime API reaches for a bundle, how a key
      /// would be served now, and the warm manifest's name for a bundle.
      get _policy() {
        return globalThis.__MANTLE_DEBUG__
          ? {
              K: R._K,
              needsWarm: R._bundleNeedsWarm,
              warmSet: () => new Set(R._warmSet),
              image: R._warmImageOf,
              keyWith: R._keyWith,
              reachKeys: R._reachKeys,
              coverage: (k) => R._wq.coverage(k),
              has: (k) => R._wq.has(k),
              keyOfBundle: (b) => R._wq.keyOfBundle(b),
              wmKeyOf: R._wmKeyOf,
              staticFrames: R._staticFrameCount,
            }
          : null;
      },
      /// Cold-start diagnostics: where a bundle's analytic (Loop-Blinn) build stands ('off' | 'skipped-by-type' | 'pending' | 'built-declined' |
      /// 'built-picked', plus row counts), for one bundle, or for every live bundle the renderer warms when none is given.
      lbCensus: (bundle) => {
        if (bundle) return R.lbCensus(unwrapBundle(bundle));
        return (R._liveBundles ? R._liveBundles() : []).map((b, i) => ({
          index: i,
          ...R.lbCensus(b),
        }));
      },
      // Dynamic incremental stroke — the paint-tool fast path. Returns a handle
      // whose appendPoints(pts) tessellates only the new segments (O(1) per
      // point) and whose `.bundle` draws through every entry point (drawBundle /
      // handle.draw / drawInstance) via the shared GPU stroke-coverage pipeline
      // (identical caps/joins/AA to the static analytic stroke route).
      // finalize() freezes it and returns { pathD, svg } for re-hosting.
      createIncrementalStroke: (o) => {
        if (_disposed) throw new Error('createIncrementalStroke: the renderer is disposed');
        return R.createIncrementalStroke(o);
      },
      // Debug-only memory estimate (bytes).
      gpuMemoryEstimate,
      // Debug-only cache stats. maskBakeCount / filterEvalCount = number
      // of actual mask bakes / filter-graph evals (cache misses).
      get debugStats() {
        const _cpf = getRendererFeature('cpatch');
        const _cpStall = _cpf
          ? _cpf.cpatchConvStats()
          : {
              stalled: 0,
              stalledLanded: 0,
              pool: { posted: 0, answered: 0, failed: 0, inflight: 0, queued: 0, oldestMs: 0 },
            };
        return {
          maskBakeCount: _maskBakeCount,
          filterEvalCount: _filterEvalCount,
          // Filter-result cache residency. `filterCacheBytes` is the number the
          // budget actually bounds; `filterCacheEntries` is how many results are
          // live. A filtered bundle whose entries exceed the budget shows up as
          // a nonzero filterEvalCount every frame — that is thrash, not warm-up.
          filterCacheEntries: _filterCache.size,
          filterCacheBytes: _filterCacheBytes,
          filterBboxActiveCount: _filterBboxActiveCount,
          // The idle trim of the filter scratch (opts.filterPoolIdleMs): ticks seen, targets and bytes freed, and what the last tick found.
          scratchTrim: (() => {
            const [cw, ch] = viewportSize();
            return {
              ..._trimDiag,
              pool: _rtPool.stats(cw, ch),
              shapeRts: _shapeRtCache.size,
              pingRts: _pingRtCache.size,
              msSinceUse: Math.round(_nowMs() - Math.max(_scratchUsedT, _rtPool.lastUse())),
            };
          })(),
          // # of drawBundleInstanced calls that took the single
          // drawArraysInstanced GPU fast path (vs the per-instance loop).
          instancedFastCount: R._instFastCount | 0,
          groupAtlasSlots: R._atlasSlots | 0,
          groupAtlasComposites: R._atlasComposites | 0,
          groupAtlasPasses: R._atlasPasses | 0,
          groupFilterSkips: R._groupFilterSkips | 0,
          alphaSlotBatches: R._alphaSlotBatches | 0,
          groupCompositeDraws: R._compositeDraws | 0,
          groupMergedRuns: R._mergedRuns | 0,
          groupMergedComposites: R._mergedComposites | 0,
          loopBlinnRouteCount: R._lbRouteCount,
          // Why a CPatch MORPH fell back. The fallback is legitimate; being unable to see it
          // is not — it is how an LB timing got reported as CPatch's for a whole bench run.
          cpatchMorphError: R._cpatchMorphError || null,
          // Two engines fighting over one bundle's fill meshes. Should be 0: a decline
          // releases the claim, so a refusal means CPatch and LB are both live on the same
          // bundle — which is how a posed CPatch morph got rebuilt away before it drew.
          fillMeshStomps: R._lastBundle ? R._lastBundle._fillMeshStomps | 0 : 0,
          // Bundles painted by the UNIFIED fill draw (cover quads + LB
          // triangles, one drawArrays). Bumped at the drawArrays itself, so
          // unlike loopBlinnRouteCount — which every LB route bumps — this
          // identifies the route that actually produced the pixels.
          unifiedFillDraws: R._unifiedFillDraws | 0,
          // Ordered area/seam split runs; excludes pipeline warms.
          cpatchAreaSplitDraws: R._cpAreaSplitDraws | 0,
          cpatchAreaSplitAreaDraws: R._cpAreaSplitAreaDraws | 0,
          // ...and why the last bundle did NOT take it: 'no-meshes',
          // 'variant-warming', 'no-entries', 'opt-off', or 'on'.
          unifiedFillGate: R._unifiedFillGate || null,
          fillRouteReason:
            R._handle && R._handle.bundle && R._fillRouteReason
              ? R._fillRouteReason(R._handle.bundle)
              : null,
          // Vertices the VIEW TRIM removed from unified fill draws, cumulative.
          // The trim only ever narrows the single draw to the span between the
          // first and last on-screen entry, so this never costs a draw call —
          // `unifiedFillDraws` is unchanged by it. See viewCull.js.
          viewCullTrimmedVerts: R._viewCullTrimmed | 0,
          // Bytes of vertex stream uploaded and then RELEASED from the JS heap.
          // Cumulative across bundles, so it is the memory this route stopped
          // holding, not a live figure.
          unifiedStreamBytesFreed: R._uniStreamBytes | 0,
          // Times the curve-texture draw refused because the bound program was
          // not the curve-tex variant. Nonzero means some pass is drawing the
          // narrow stream through a program that expects wide vertices.
          unifiedCurveTexBail: R._uniCurveTexBail | 0,
          // Draws that found the coefficient cache with neither texture nor data.
          unifiedCoefLost: R._uniCoefLost | 0,
          // Shapes the unified draw ISOLATED for an offscreen filter — it split
          // into runs around each one instead of declining the bundle. Nonzero
          // means the split ran; `unifiedFillDraws` then counts the spans.
          unifiedFilterDraws: R._uniFilterDraws | 0,
          // ...and how many of those isolations FAILED (a zero-sized viewport is
          // the only way _morphShapeFilter reports one). Those shapes are left
          // unpainted rather than painted unfiltered, so this is the difference
          // between a missing shape and a silently wrong one.
          unifiedFilterIsolateFail: R._uniFilterIsolateFail | 0,
          // Group brackets and blend leaves the unified draw INTERRUPTED for
          // rather than declining the bundle. Both drive renderer.js's own
          // begin/end and blend code (R._groupBegin / R._groupEnd /
          // R._blendLeaf), shared rather than copied.
          unifiedGroupBrackets: R._uniGroupBrackets | 0,
          unifiedBlendLeaves: R._uniBlendLeaves | 0,
          // COLRv1 glyphs the unified draw INTERRUPTED for (served) versus
          // turned away. A decline takes the whole bundle off the route, so the
          // second number is the costly one.
          unifiedColrLeaves: R._uniColrLeaves | 0,
          unifiedColrDeclines: R._uniColrDeclines | 0,
          // Bundles that fell PAST the unified route onto a classic LB route,
          // and the gate that sent the last one there. Zero across a corpus is
          // what would make the classic routes deletable.
          unifiedFilterCacheHits: R._uniFilterCacheHits | 0,
          unifiedFilterStorePx: R._uniFilterStorePx || null,
          unifiedFilterBlitProg: R._uniFilterBlitProg === undefined ? null : !!R._uniFilterBlitProg,
          unifiedFilterSrcPx: R._uniFilterSrcPx || null,
          // Times a span bail happened AFTER something had already been painted,
          // so the route reported success rather than let the caller repaint the
          // bundle on top. Should be 0: the bail is a property of the bound
          // program, so it can only fire on the first span.
          unifiedPartialSpanBail: R._uniPartialSpanBail | 0,
          // Draws that fell to the ordinary engine-selected fill pass because the
          // LB-hosting variant had not linked yet — the second-best engine for
          // that bundle, chosen by re-running the same selection minus LB, rather
          // than by dropping into the classic coverage-RT routes.
          unifiedWarmFallbacks: R._uniWarmFallbacks | 0,
          // Shapes an adoption stream LOST: the worker posts each shape exactly once, so a
          // batch dropped on this side leaves a shape no half ever reported and the fold can
          // only render it as Slug. Always 0 on a healthy build. Reported here because the
          // failure is otherwise invisible — the picture stays correct while the analytic route
          // silently shrinks, which reads as a memory figure that changes from run to run.
          unifiedAdoptLost: R._uniAdoptLost | 0,
          // The CPatch counterpart: pooled conversions still pending past the report bound
          // (cpatchBuild's CPATCH_STALL_REPORT_MS), each of which held a bundle on its fallback
          // engine, and how many of those landed after all. Always 0 on a healthy build; the
          // bundle's own `_cpatchStall` says why. Process-wide, like the pool it watches, and
          // `cpatchPool` is that pool's accounting (posted = answered + failed + in flight + queued).
          cpatchConvStalled: _cpStall.stalled,
          cpatchConvStalledLanded: _cpStall.stalledLanded,
          cpatchPool: _cpStall.pool,
          // Shapes the caller's PER-SHAPE Loop-Blinn memory budget turned away
          // (setLoopBlinnShapeMemoryBudget), and the largest stream any of them asked for.
          // Zero unless a budget is set. Reported for the same reason as the two above: a
          // budget that declines silently leaves a correct picture drawn by a route that has
          // quietly shrunk, with nothing anywhere to tune against. `bundle._lbMemWants` names
          // the shapes; the per-shape cause is SLUG_WHY.OVER_MEMORY in the census.
          lbShapeMemDeclined: R._lbShapeMemDeclined | 0,
          lbShapeMemWantedBytes: R._lbShapeMemWantedBytes | 0,
          // WHICH ENGINE actually PAINTED, recorded where geometry is submitted, plus why any
          // engine that was asked for did not. The option, the mesh kind and the route
          // counters each answer part of this and none of them answers it — see
          // engineLedger.js. { last, draws: {slug, aac, lb, cpatch, hard-*}, declines }.
          engines: R._engines ? R._engines.snapshot() : null,
          unifiedMorphTLast: R._uniMorphTLast,
          unifiedUsedCover:
            R._unifiedFillUsedCover === undefined ? null : !!R._unifiedFillUsedCover,
          // The define key of the variant the last readiness check resolved
          // to. `variant-warming` alone cannot say whether the variant is
          // still linking or the wrong one was selected; this can.
          uniCurveTexOverflow: R._uniCurveTexOverflow | 0, // builds whose curve-block table passed even the 32-bit index or the texture's size (the bundle then takes the wide layout)
          uniCurveTexIdx32: R._uniCurveTexIdx32 | 0, // builds that passed the 16-bit index and took the 32-bit layout
          fillVariantKey: R._lastFillVariantKey || null,
          // The variant the fill pass last BOUND; fillVariantKey above is the unified route's readiness query.
          drawnFillVariantKey: R._lastDrawnFillVariantKey || null,
          // Warm state, so "variant-warming" can be told apart from "the
          // warm queue never reached this bundle".
          idleFrames: R._idleFrames | 0,
          psoWarmPending: R._psoWarmPending | 0,
          // Pipelines built by the warm deadline rather than in slack.
          psoDeadlineWarms: R._psoDeadlineWarms | 0,
          lbAutoPicked: R._lbAutoPicked || 0,
          loopBlinnMorphRouteCount: R._lbMorphRouteCount,
          loopBlinnMorphComposedCount: R._lbMorphComposedCount,
          // Composed draws split by where each coverage came from. The two
          // are independent, so a draw can be (RT fill, RT stroke),
          // (in-shader fill, RT stroke), or (in-shader fill, no stroke).
          // composedFillInShader > 0 means a fill was computed by the
          // Slug/AAC/hard kernel inside a composed draw.
          composedFillFromRT: R._composedFillFromRT | 0,
          composedFillInShader: R._composedFillInShader | 0,
          composedStrokeFromRT: R._composedStrokeFromRT | 0,
          opaquePrepassCount: R._opaquePrepassCount | 0,
          cacheBakeDeferred: R._cacheBakeDeferred | 0,
          // the conforming strip covers' policy (defaults visible before any draw) and what the last draw used
          strokeStrip: {
            policy:
              R.opts.strokeStrip === false
                ? 'off'
                : R.opts.strokeStrip === true || R.opts.strokeStrip === 'on'
                  ? 'on'
                  : 'auto',
            minSavedPxPerVertex:
              R.opts.strokeStripMinSavedPx != null ? +R.opts.strokeStripMinSavedPx : 64,
            maxMode: R.opts.strokeStripMode === 1 ? 1 : 2,
            last: R._stripStats || null,
          },
          // aacFill:'auto' — what the selector saw and chose on the last draw.
          variantCompiles: R._variantCompiles || 0,
          // THE ZERO-BLOCKING LEDGER. Queries on a program (or a shader of one) whose link had not completed, draws with such a program, and the
          // last-resort waits the fill pass took itself. Needs `glGuard: true` (or globalThis.__MANTLE_GL_GUARD__) for the first two; the third
          // is always counted. Any nonzero value is a main-thread stall on a cold driver cache. `glGuard` carries the slow-call ledger.
          blockingLinkWaits:
            (R._blockingLinkWaits | 0) + (_glGuard ? _glGuard.stats.blockingLinkWaits : 0),
          morphChain: R._morphChainStats ? { ...R._morphChainStats } : null, // morph builds landed, how many draw LB, how many 'auto' declined for a face beyond its chains (and how many of those after the load)
          warmPolicy: R._warmPolicyStats ? R._warmPolicyStats() : null, // the game context of the warm queue (warmQueue.js)
          needMiss: R._needStatsSnapshot ? R._needStatsSnapshot() : null, // a variant or program a draw requested that was neither warmed nor declared (warmNeeds.js)
          linkFailedKeys: R._linkFailedCount ? R._linkFailedCount() : 0, // fill variants that failed to link and wait for the next loading call or warm window
          linkRetries: R._linkRetries | 0, // the links those windows tried again
          baseFillBuilt: R._baseFillMade === true, // the universal fill program exists (default sessions never build it)
          glGuard: _glGuard ? _glGuard.stats : null,
          auxWarmed: R._auxWarmed ? R._auxWarmed() : [], // the filter-helper programs whose loading draws were issued (valid draws: a sampler clash rejects them)
          // Draws deferred rather than waited for (no correct program was ready), and the cooperative loading call's own account.
          deferredFillDraws: R._deferredFillDraws | 0,
          deferredWarmDraws: R._deferredWarmDraws | 0,
          deferredFilterDraws: R._deferredFilterDraws | 0,
          shedFrames: R._gateStats ? R._gateStats.shedFrames : 0,
          lastDeferredKey: R._lastDeferredKey || null,
          nets: R._netList ? R._netList() : [],
          pendingVariants: R._pendingList ? R._pendingList() : [],
          variantState: R._variantState || null,
          playStandInDraws: R._playStandInDraws | 0,
          playBuilds: R._playBuilds | 0,
          playBuildKeys: R._playBuildKeys || [],
          playStandIns: R._playStandIns
            ? [...R._playStandIns].slice(0, 60).map(([k, e]) => ({
                want: k,
                net: e.net,
                frames: e.frames,
                firstFrame: e.firstFrame,
                lastFrame: e.lastFrame,
                bundles: e.bundles,
                freshBundles: e.freshBundles,
              }))
            : [],
          variantKeys: R._variantList ? R._variantList() : [],
          warmWindows: R._warmWindows | 0,
          pointsStrictDeclines: R._pointsStrictDeclines | 0,
          inferredWindows: R._inferredWindows | 0,
          initPhases: R._initPhases || null,
          viewportWarm: R._viewportWarm || null,
          maskBakeStandIns: R._maskBakeStandIns | 0,
          maskBakeDeferred: R._maskBakeDeferred | 0,
          gpuGate: R._gateStats || null,
          coopLoad: R._loadStats || null,
          variantPolls: R._variantPolls || 0,
          autoMeanShapePx2: R._autoMeanShapePx2 || 0,
          autoSegsPerShape: R._autoSegsPerShape || 0,
          autoPx2PerSeg: R._autoPx2PerSeg || 0,
          // the unified route's presence model (coverKernelPolicy): px^2 AAC saves on its cover rows, and px^2
          // its presence costs the rest; AAC iff gain > presence. -1: the draw was not priced by it.
          // pipeline warms of a MANTLE_NO_COVER_FILL key's cover sibling (fillPass _warmCoverSibling)
          coverSiblingWarms: R._coverSiblingWarms | 0,
          autoAacGain: R._autoAacGain ?? -1,
          autoAacPresence: R._autoAacPresence ?? -1,
          // The engine SELECTED for cover-quad fragments. `engines` below says what actually
          // drew; this says what the selection chose, and the two differ exactly when a route
          // declined. Same vocabulary (ENGINES) so they can be compared without a mapping.
          autoEngine: R._autoEngine || null,
          // The kernel of the program that last shaded cover quads, which is what `engines` records. It
          // differs from autoEngine while a decided variant is still linking or warming.
          coverKernel: R._lastDrawnCoverKernel || null,
          // Why the AAC point route declined its last ask (a short tag), or null: recorded only under __MANTLE_DEBUG__
          pointsGateWhy: R._aacPointsWhy || null,
          // The effective row-gate / E_MIN options (defaults included) and the last row-gate cut ({ runs, rowsPts, rows, bytes }), or null.
          fillPolicy: R.getFillPolicyOptions ? R.getFillPolicyOptions() : null,
          rowGatePlan: R._aacPointsPlan || null,
          pointsStats: R._aacPointsStats ? { ...R._aacPointsStats } : null,
          // Which engine drew each ROW of the last recorded draw (unified or points): counts, runs and a hash of the per-row codes (rowEngines.js).
          rowEngines: R.getRowEngines ? R.getRowEngines() : null,
          recolorDraws: R._recolorDrawCount | 0,
        };
      },
      // Static-scene cache. Opt-in: enable once and the
      // renderer auto-evaluates eligibility every subsequent
      // render() / drawBundle(). Bundle swaps and content changes are
      // auto-detected (the renderer invalidates on setBundle); explicit
      // invalidate is for cases the renderer can't observe (e.g. the
      // caller mutated bundle data in-place).
      enableStaticCache,
      // setInstanceGroup(key) — RENDERER-INSTANCE method (deliberately NOT a
      // root/package export): it mutates the renderer's ACTIVE handle cache, so it
      // only makes sense on a live renderer after enableStaticCache(). Pairs with
      // Strategy.ForceSharedGroup lets multiple mounts share one cache target
      // (see staticCacheSmoke). For multi-handle scenes prefer
      // createBundleHandle(b, { staticCache: { strategy: ForceSharedGroup, instanceGroupKey } }).
      setInstanceGroup,
      disableStaticCache,
      invalidateStaticCache,
      /// Diagnostic view of the cache state machine on the renderer's
      /// internal handle. Null until R.enableStaticCache() is called.
      /// For multi-handle scenes, read `handle.staticCache`
      /// on the specific handle instead.
      get staticCache() {
        return _handle ? _handle.cache : null;
      },
    };
    // Publish onto the synchronously-returned rendererState. Copy
    // descriptors (not values) so getters like `debugStats` /
    // `staticCache` / `isContextLost` stay live rather than being
    // snapshotted by a plain assign.
    Object.defineProperties(rendererState, Object.getOwnPropertyDescriptors(built));
    releaseMorphLerpOwner = retainMorphLerpOwner(gl);
    releaseCPatchBlendOwner = retainCPatchBlendOwner(gl);
    _ck('built');
    R._readyAt = _ti();
    _ready = true;
    R._ready_ = true;
    if (R._wmPrelinkAll) R._wmPrelinkAll(); // a manifest's non-fill programs start linking now, with its fill variants, in parallel
    // Non-blocking mode: `ready` also waits for the image-draw pipeline (R._warmImageProgram), so the first image the app draws does not build one in the
    // middle of the app's own loading. Methods are usable from here on; only the promise waits.
    if (R._nonBlocking() && R._khrParallel && R._warmImageProgram) {
      R._gateArm();
      (async () => {
        try {
          if (R._warmImageProgram()) {
            const t0 = _ti();
            while (!_disposed && R._gpuBusy() && _ti() - t0 < 6000)
              await new Promise((res) => setTimeout(res, 6));
          }
        } catch {
          /* best effort */
        }
        _resolveReady(rendererState);
      })();
    } else _resolveReady(rendererState);
  } // end _runInit

  if (_asyncCompile) {
    R._whenProgramsComplete()
      .then(() => {
        _runInit();
      })
      .catch((err) => {
        if (_disposedBeforeReady) {
          discardInitialPrograms();
          return;
        }
        mantleError('createRenderer: shader init failed:', err);
        _rejectReady(err);
      });
  } else {
    // Default: run synchronously before returning — identical behavior to
    // pre-readiness Mantle. _runInit resolves `ready` (already-resolved by
    // the time the caller could await it), so `await renderer.ready` stays
    // valid and cheap.
    _runInit();
  }

  return rendererState;
}
