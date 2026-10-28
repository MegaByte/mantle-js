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
// KHR_parallel_shader_compile poll), captureFrames (SVG-export frame
// recorder, default off), fillDefines (extra fill-shader defines),
// aacFill (false | true | 'auto' engine selection), exactEdgeAa, slopeAa
// (secant-reconstruction edge AA, cheaper than exactEdgeAa), disableFillVariants,
// typeOmit (strip unused curve kernels per bundle), and
// onContextLost / onContextRestored consumer hooks.
//
// State ownership:
//   - The renderer instance owns programs, uniform locations, VAOs,
//     attribute buffers, dummy textures, FBOs, and all render-pass
//     scratch state.
//   - The bundle owns asset textures + mesh ArrayBuffers.
//   - The canvas + gl context are owned by the consumer.

import { Constants, removeLbBuilder, removeLbPreparer } from './bundle.js';
import { mantleWarn, mantleError, mantleDebugFlag, diagFlags, diagNoteEngine } from '../core/diagnostics.js';
import { buildLoopBlinnMesh, buildLoopBlinnCDT, refreshLoopBlinnMesh, packLoopBlinnMesh, curveRangeToContours, LB_VERT_FLOATS, lbCanonicalFrame, lbCanonicalHash, lbCanonicalHashes, transformLoopBlinnRaw } from './loopBlinn.js';
import { buildMorphStroke } from './loopBlinnMorph.js';
import {
  createRTPool, evaluateGraph, releaseRoot, SRC_BACKGROUND, SRC_BACKGROUND_A,
} from '../filterGraph/filterGraph.js';
// Read filter/COLR handlers from the opt-in registry — NOT from a module
// that side-effect-imports every primitive, which would re-link the whole
// filter+COLR shader-handler set into every renderer consumer and defeat
// the registry tree-shaking. The registry is empty by default; the
// consumer's feature imports (or the root barrel's "register all")
// populate it before createRenderer runs. The graph evaluator treats an
// unregistered node type as passthrough, so a partial table is safe.
import { svgFilterDispatch, colrPaintDispatch } from '../filterGraph/dispatchRegistry.js';
import { computeNodeBboxes } from '../filterGraph/bbox.js';
import { Strategy as CacheStrategy, Level as CacheLevel } from './staticCache.js';
import { attachShaderPrograms } from './shaderPrograms.js';
import loopBlinnVertSource from '../shaders/generated/loopBlinn.vert.glsl?raw';
import loopBlinnFragSource from '../shaders/generated/loopBlinn.frag.glsl?raw';
import morphStrokeVertSource from '../shaders/generated/morphStroke.vert.glsl?raw';
import morphStrokeFragSource from '../shaders/generated/morphStroke.frag.glsl?raw';

const shaderSourcesCallersNoLongerSupply = {
  loopBlinnVert: loopBlinnVertSource,
  loopBlinnFrag: loopBlinnFragSource,
  morphStrokeVert: morphStrokeVertSource,
  morphStrokeFrag: morphStrokeFragSource,
};
import { attachDrawImages } from './drawImages.js';
import { attachInstancedFill } from './instancedFill.js';
import { attachMorphDraw } from './morphDraw.js';
import { attachDrawSprites } from './drawSprites.js';
import { attachCacheDraw } from './cacheDraw.js';
import { attachFilterDraw } from './filterDraw.js';
import { attachMaskBake } from './maskBake.js';
import { attachFillPass } from './fillPass.js';
import { attachOpaquePrepass } from './opaquePrepass.js';
import { attachFrameLoop } from './frameLoop.js';
import { attachDrawDispatch } from './drawDispatch.js';
import { attachBundleHandle } from './bundleHandle.js';
import { attachClipDraw } from './clipDraw.js';
import { attachIncrementalStroke } from './incrementalStroke.js';
import { decodeImageHref } from '../svg/image.js';

const COVER_QUAD_STRIDE = Constants.COVER_QUAD_STRIDE;

// Meta-plane texel-7.w bit positions (matches MantleSvgImporter
// constants — keep in lockstep). Float-offset in metaFloats is
// shape * stride + (texel * 4 + component).
const META_FLAG_LAYER      = 0x100;
const META_FLAG_MASK_BEGIN = 1 << 9;
const META_FLAG_MASK_END   = 1 << 10;

// Color-matrix recolor defaults (dual-tint fill recolor).
// Used when a caller supplies only the matrix OR only the offset —
// the other defaults to identity/zero.
const IDENTITY_COLOR_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
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
  return n < 0 ? 0 : (n > 3 ? 3 : n);
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
  let xL = 0, yT = 0, xR = 0, yB = 0;
  // Nested-mask depth-1 detection: any child carrying a non-zero
  // texel 7.w (post-importer-rewrite inner maskId) flips the region's
  // `hasInnerMask` flag. The renderer uses this to decide whether the
  // ping-pong sample pass is needed for this region. Float offset 31
  // = texel 7 component 3 in the 48-float stride.
  let hasInnerMask = false;
  for (let row = 0; row < n; row++) {
    const off = row * stride;
    const flags = (m[off + 27] + 0.5) | 0;
    if ((flags & META_FLAG_LAYER) === 0) continue;
    const isBegin = (flags & META_FLAG_MASK_BEGIN) !== 0;
    const isEnd   = (flags & META_FLAG_MASK_END)   !== 0;
    if (isBegin) {
      beginRow = row;
      // Texel 8.z (float offset 34) = isLuminance flag.
      beginIsLum = (m[off + 34] + 0.5) | 0;
      xL = m[off + 0]; yT = m[off + 1];
      xR = m[off + 2]; yB = m[off + 3];
      hasInnerMask = false;
    }
    if (beginRow >= 0) {
      // Accumulate em-bbox union across all children of the current
      // mask. Each row's texel 0 is its own bbox.
      const cxL = m[off + 0], cyT = m[off + 1];
      const cxR = m[off + 2], cyB = m[off + 3];
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
      if (innerMaskId > 0 && innerMaskId !== (beginRow + 1)) hasInnerMask = true;
    }
    if (isEnd && beginRow >= 0) {
      regions.push({
        maskRow: beginRow + 1,   // 1-based meta-row index
        firstChild: beginRow,
        lastChild: row,
        emBBox: [xL, yT, xR, yB],
        isLuminance: beginIsLum,
        hasInnerMask,
      });
      beginRow = -1;
      hasInnerMask = false;
    }
  }
  return regions;
}

/**
 * Create a Mantle WebGL2 renderer.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} shaderSources  from `loadShaders()` / `loadShadersSync()`
 * @param {object} [opts]
 * @returns {import('./rendererApi.js').MantleRenderer}
 */
export function createRenderer(gl, shaderSources, opts = {}) {
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
  const _asyncCompile = opts.asyncShaderCompile === true
    && !!gl.getExtension('KHR_parallel_shader_compile');
  // Always grab the extension when present: selectFillVariant polls it to compile per-bundle
  // fill variants WITHOUT blocking, independently of the opt-in initial-batch async path.
  const _khrParallel = gl.getExtension('KHR_parallel_shader_compile') || null;
  const _pendingShaders  = [];
  const _pendingPrograms = [];
  // `aacFill: true` means "draw with AAC", not "draw with AAC eventually". Left to the variant
  // machinery it was the latter: the AAC program compiles lazily, and until it is linked AND
  // its Metal pipeline is warmed, every draw falls back to the Slug base — so a render of a
  // few frames (a test, an A/B, this repo's own demo) silently produced Slug and reported it
  // as AAC. Bake the define into the BASE program instead, so the engine you asked for is the
  // engine that draws frame 0. ('auto' is a per-bundle decision and stays with the variants.)
  if (opts.aacFill === true) {
    opts = { ...opts, fillDefines: (opts.fillDefines || []).concat(
      (opts.fillDefines || []).includes('MANTLE_AAC') ? [] : ['MANTLE_AAC']) };
  }
  // EXACT-EDGE AA (`exactEdgeAa: true`), OFF by default.
  //
  // This refines single straight-edge pixels with exact half-plane box area.
  // Tracking the extra crossing state raises register pressure for every fragment,
  // so keep it opt-in for straight-edge content that is not fill-rate bound.
  if (opts.exactEdgeAa === true) {
    opts = { ...opts, fillDefines: (opts.fillDefines || []).concat(
      (opts.fillDefines || []).includes('MANTLE_EXACT_EDGE') ? [] : ['MANTLE_EXACT_EDGE']) };
  }
  // SLOPE AA (`slopeAa: true`), OFF by default.
  //
  // Reconstructs the boundary secant from the two nearest ray crossings and takes
  // its exact box coverage on single-edge ramp pixels — near exact-edge quality on
  // diagonal edges (the default combiner's weak regime) for two floats of walker
  // state instead of MANTLE_EXACT_EDGE's per-crossing tangent tracking. Changes
  // Slug output, so parity-gated consumers must opt in deliberately.
  if (opts.slopeAa === true) {
    opts = { ...opts, fillDefines: (opts.fillDefines || []).concat(
      (opts.fillDefines || []).includes('MANTLE_SLOPE_AA') ? [] : ['MANTLE_SLOPE_AA']) };
  }
  /** @type {import('./rendererContext.js').RendererContext} */
  shaderSources = { ...shaderSourcesCallersNoLongerSupply, ...shaderSources };
  const R = { gl, shaderSources, opts, mantleWarn, mantleError, mantleDebugFlag,
    _asyncCompile, _khrParallel, _pendingShaders, _pendingPrograms };
  // WebGL context-loss state + the backing canvas for the listeners (null for
  // an OffscreenCanvas / headless gl with no addEventListener).
  let _contextLost = false;
  const _canvas = (gl.canvas && typeof gl.canvas.addEventListener === 'function')
    ? gl.canvas : null;
  R.CacheStrategy = CacheStrategy;
  R.CacheLevel = CacheLevel;
  attachShaderPrograms(R);

  // The object returned synchronously. In async mode _init() publishes
  // its methods (via defineProperties, to preserve getters) once shaders
  // are ready; in sync mode that happens inline before return.
  /** @type {import('./rendererApi.js').MantleRenderer} */
  const rendererState = /** @type {import('./rendererApi.js').MantleRenderer} */ ({});
  let _ready = false;
  let _resolveReady, _rejectReady;
  rendererState.ready = new Promise((res, rej) => { _resolveReady = res; _rejectReady = rej; });

  // Pre-ready stubs (async mode only). Until _init() publishes the real
  // methods, a draw call would otherwise throw "render is not a
  // function". These warn once and no-op; _init's defineProperties
  // replaces them. In sync mode _init runs before return, so these are
  // overwritten before any caller can observe them.
  if (_asyncCompile) {
    let _warnedEarly = false;
    const _earlyStub = (name) => () => {
      if (!_warnedEarly) {
        _warnedEarly = true;
        mantleWarn('Mantle: ' + name + '() called before renderer.ready resolved; '
          + 'with asyncShaderCompile you must await renderer.ready before the first draw. (No-op.)');
      }
    };
    for (const m of ['render', 'drawBundle', 'beginFrame', 'endFrame', 'setViewport',
                     'drawInstance', 'drawImage', 'drawImageInstanced', 'drawBundleInstanced',
                     'drawSprite', 'drawSpriteInstanced', 'setBundle']) {
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
    R.finalizeShaderCompiles();
    attachDrawImages(R);
    attachInstancedFill(R);
    attachMorphDraw(R);
    attachDrawSprites(R);
    attachCacheDraw(R);
    const { createImage, drawImage, drawImageInstanced, deleteClipTexture } = R;
    const { drawLoopBlinnMesh } = R;
    const { drawSprite, drawSpriteInstanced } = R;
    const { enableStaticCache, setInstanceGroup, disableStaticCache, invalidateStaticCache } = R;
    const { _drawBundleLoopBlinn, _drawBundleMorphRoute, _loopBlinnEligible,
      _simpleInstanceable, _ensureInstProg, _drawBundleInstancedFast,
      _cacheTick, _cacheBakeAndBlit, _cacheBlitToCanvas } = R;
    const { fillProg, solidProg, compProg, blurProg, boxBlurProg, morphProg,
      convolveProg, colorMatrixProg, feCompositeProg, feBlendProg, feTileProg,
      feTurbulenceProg, feDisplacementMapProg, feLightingProg, feComponentTransferProg,
      feImageProg, paintLinearGradProg, paintRadialGradProg, paintSweepGradProg,
      paintTransformProg, paintGlyphProg, paintCompositeProg, maskBakeProg,
      cacheBlitProg, drawImageProg, drawImageInstProg, lbProg, lbCompProg,
      morphStrokeProg,
      diUTex, diUTint, diUAlpha, diUDstRect, diUSrcRect, diUViewport, diUWorldM,
      diiUTex, diiUViewport, diiUSrcRect, cbUCacheTex, cbUTint,
      lbUGBB, lbUCanvasAR, lbUWorldM, lbUHasWorldM, lbUViewport, lbUDirect, lbUAlpha,
      lbcUCoverage, lbcUColor, morphStrokeU } = R;

  // (the fill-program uniform locations are resolved in fillPass.js's
  // attachFillPass — captureFillUniforms(prog), per program variant.)

  // maskBake program uniform locations.
  const mbUCurve  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uCurveData')         : null;
  const mbUBand   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uBandData')          : null;
  const mbUMeta   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMetaTex')           : null;
  const mbUDash   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uDashTex')           : null;
  const mbUGrad   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientTex')       : null;
  const mbUGStops = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientStops')     : null;
  const mbUImage  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uImageTex')          : null;
  const mbUAtlasS = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uImageAtlasSize')    : null;
  const mbUFilter = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uFilterTex')         : null;
  const mbUGCount = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientCount')     : null;
  const mbUGStopsCnt = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientStopsCount') : null;
  const mbUGBB    = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGlobalBBox')        : null;
  const mbUEmBBox = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskEmBBox')        : null;
  const mbUCanvasAR = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uCanvasAR')        : null;
  const mbURow    = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskChildRow1Based'): null;
  const mbUIsLum  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskIsLuminance')   : null;
  // Nested-mask depth-1: bake shader reads the PONG array (frozen
  // ping snapshot after Pass 1) + the row→layer lookup. Different
  // sampler binding from the visible-shape path so we can swap which
  // array is read independently of which is written.
  const mbUMaskRTArrayPong       = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskRTArrayPong')       : null;
  const mbUMaskRowToLayerTexBake = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskRowToLayerTexBake') : null;
  const mbUViewportSize          = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uViewportSize')          : null;
  // Override plane (animated <mask> children) — bound on unit 8 in the bake,
  // same as the main fill pass; applied via the shared transformClipCoord.
  const mbUOverrideTex  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uOverrideTex')  : null;
  const mbUHasOverrides = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uHasOverrides') : null;
  const mbUOwnRow                = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskOwnRow')            : null;

  // Static-scene cache blit uniforms.
  R.cbUCacheTex = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uCacheTex') : null;
  R.cbUInMap    = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uInMap')    : null;
  R.cbUTint     = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uTint')     : null;
  // R.drawImage uniform locations.
  R.diUTex      = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uTex')      : null;
  R.diUTint     = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uTint')     : null;
  R.diUAlpha    = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uAlpha')    : null;
  R.diUDstRect  = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uDstRect')  : null;
  R.diUSrcRect  = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uSrcRect')  : null;
  R.diUViewport = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uViewport') : null;
  R.diUWorldM   = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uWorldM')   : null;
  R.diUCMatrix  = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uColorMatrix')       : null;
  R.diUCOffset  = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uColorMatrixOffset') : null;
  R.diUCEnabled = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uColorMatrixEnabled'): null;
  R.diiUTex      = R.drawImageInstProg ? gl.getUniformLocation(R.drawImageInstProg, 'uTex')      : null;
  R.diiUViewport = R.drawImageInstProg ? gl.getUniformLocation(R.drawImageInstProg, 'uViewport') : null;
  R.diiUSrcRect  = R.drawImageInstProg ? gl.getUniformLocation(R.drawImageInstProg, 'uSrcRect')  : null;


  const solidUGBB   = gl.getUniformLocation(R.solidProg, 'uGlobalBBox');
  const solidUAR    = gl.getUniformLocation(R.solidProg, 'uCanvasAR');
  const solidUColor = gl.getUniformLocation(R.solidProg, 'uFillColor');

  // vUV → texture-uv maps (src/shaders/_filterRect.glsl). Every composite below
  // reads two CANVAS-sized textures, so both are the identity — but an unset vec4
  // uniform is (0,0,0,0), which would sample a single texel, so upload it.
  const COMP_IDENTITY_MAP = () => {
    if (compUShapeMap) gl.uniform4f(compUShapeMap, 1, 1, 0, 0);
    if (compUDstMap)   gl.uniform4f(compUDstMap,   1, 1, 0, 0);
  };
  const compUShapeMap    = gl.getUniformLocation(R.compProg, 'uShapeMap');
  const compUDstMap      = gl.getUniformLocation(R.compProg, 'uDstMap');
  const compUShapeTex    = gl.getUniformLocation(R.compProg, 'uShapeTex');
  const compUDstTex      = gl.getUniformLocation(R.compProg, 'uDstTex');
  const compUBlendMode   = gl.getUniformLocation(R.compProg, 'uBlendMode');
  const compUOpacity     = gl.getUniformLocation(R.compProg, 'uOpacity');

  const blurUTex   = gl.getUniformLocation(R.blurProg, 'uTex');
  const blurUTexel = gl.getUniformLocation(R.blurProg, 'uTexel');
  const blurUDir   = gl.getUniformLocation(R.blurProg, 'uDir');
  const blurUSigma = gl.getUniformLocation(R.blurProg, 'uSigma');

  const bbUTex    = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTex')    : null;
  const bbUTexel  = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTexel')  : null;
  const bbUDir    = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uDir')    : null;
  const bbURadius = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uRadius') : null;

  const morphUTex      = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTex')      : null;
  const morphUTexel    = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTexel')    : null;
  const morphUDir      = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uDir')      : null;
  const morphURadius   = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uRadius')   : null;
  const morphUOperator = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uOperator') : null;

  const convUTex       = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTex')           : null;
  const convUKernelTex = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernelTex')     : null;
  const convUTexel     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTexel')         : null;
  const convUOrder     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uOrder')         : null;
  const convUTarget    = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTarget')        : null;
  const convUDivisor   = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uDivisor')       : null;
  const convUBias      = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uBias')          : null;
  const convUKernelRow = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernelRow')     : null;
  const convUEdgeMode  = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uEdgeMode')      : null;
  const convUPreserve  = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uPreserveAlpha') : null;

  const cmUTex  = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uTex')  : null;
  const cmUM0   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM0')   : null;
  const cmUM1   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM1')   : null;
  const cmUM2   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM2')   : null;
  const cmUM3   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM3')   : null;
  const cmUMOff = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uMOff') : null;

  const fcUIn1 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1') : null;
  const fcUIn2 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2') : null;
  const fcUIn1Map = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1Map') : null;
  const fcUIn2Map = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2Map') : null;
  const fcUOp  = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uOp')  : null;
  const fcUK   = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uK')   : null;

  const fbUIn1  = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1')  : null;
  const fbUIn2  = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2')  : null;
  const fbUMode = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uMode') : null;

  const ftUTex  = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTex') : null;

  const ftbUBaseFreq    = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uBaseFreq')   : null;
  const ftbUNumOctaves  = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uNumOctaves') : null;
  const ftbUSeed        = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uSeed')       : null;
  const ftbUKind        = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uKind')       : null;
  const ftbUTilePos     = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uTilePos')    : null;
  const ftbUTileSize    = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uTileSize')   : null;
  const ftbUStitch      = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uStitch')     : null;
  const fimgUIn         = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uIn')          : null;
  const fimgUAtlasSize  = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasSize')   : null;
  const fimgUAtlasRect  = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasRect')   : null;
  const fimgUPreserveAR = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uPreserveAR')  : null;

  const fdUIn1   = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn1')   : null;
  const fdUIn2   = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn2')   : null;
  const fdUScale = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uScale') : null;
  const fdUTexel = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uTexel') : null;
  const fdUXChan = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uXChan') : null;
  const fdUYChan = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uYChan') : null;

  const flUIn           = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uIn')           : null;
  const flUTexel        = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uTexel')        : null;
  const flUWorldScale   = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uWorldScale')   : null;
  const flUSurfaceScale = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSurfaceScale') : null;
  const flUK            = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uK')            : null;
  const flUExponent     = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uExponent')     : null;
  const flULightColor   = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uLightColor')   : null;
  const flUMode         = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uMode')         : null;
  const flULightType    = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uLightType')    : null;
  const flULightPos     = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uLightPos')     : null;
  const flUSpotAt       = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotAt')       : null;
  const flUSpotExp      = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotExp')      : null;
  const flUSpotCosCone  = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotCosCone')  : null;

  const fctUIn  = R.feComponentTransferProg ? gl.getUniformLocation(R.feComponentTransferProg, 'uIn')  : null;
  const fctULUT = R.feComponentTransferProg ? gl.getUniformLocation(R.feComponentTransferProg, 'uLUT') : null;

  // COLRv1 paint-graph uniforms. Resolved once; the dispatch reads
  // them via ctx.paint*U dicts.
  function loc(prog, name) { return prog ? gl.getUniformLocation(prog, name) : null; }
  const paintLinearGradU = {
    uGradientStops: loc(R.paintLinearGradProg, 'uGradientStops'),
    uStopsOffset: loc(R.paintLinearGradProg, 'uStopsOffset'),
    uStopCount: loc(R.paintLinearGradProg, 'uStopCount'),
    uBboxOrigin: loc(R.paintLinearGradProg, 'uBboxOrigin'), uBboxSize: loc(R.paintLinearGradProg, 'uBboxSize'),
    uP0: loc(R.paintLinearGradProg, 'uP0'), uP1: loc(R.paintLinearGradProg, 'uP1'),
    uP2: loc(R.paintLinearGradProg, 'uP2'), uExtend: loc(R.paintLinearGradProg, 'uExtend'),
  };
  const paintRadialGradU = {
    uGradientStops: loc(R.paintRadialGradProg, 'uGradientStops'),
    uStopsOffset: loc(R.paintRadialGradProg, 'uStopsOffset'),
    uStopCount: loc(R.paintRadialGradProg, 'uStopCount'),
    uBboxOrigin: loc(R.paintRadialGradProg, 'uBboxOrigin'), uBboxSize: loc(R.paintRadialGradProg, 'uBboxSize'),
    uC0: loc(R.paintRadialGradProg, 'uC0'), uC1: loc(R.paintRadialGradProg, 'uC1'),
    uR0: loc(R.paintRadialGradProg, 'uR0'), uR1: loc(R.paintRadialGradProg, 'uR1'),
    uExtend: loc(R.paintRadialGradProg, 'uExtend'),
  };
  const paintSweepGradU = {
    uGradientStops: loc(R.paintSweepGradProg, 'uGradientStops'),
    uStopsOffset: loc(R.paintSweepGradProg, 'uStopsOffset'),
    uStopCount: loc(R.paintSweepGradProg, 'uStopCount'),
    uBboxOrigin: loc(R.paintSweepGradProg, 'uBboxOrigin'), uBboxSize: loc(R.paintSweepGradProg, 'uBboxSize'),
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
  };
  const paintCompositeU = {
    uSrc: loc(R.paintCompositeProg, 'uSrc'),
    uDst: loc(R.paintCompositeProg, 'uDst'),
    uMode: loc(R.paintCompositeProg, 'uMode'),
  };

  // ------------------------------------------------------------
  // Vertex buffers + VAOs
  // ------------------------------------------------------------
  // Solid/debug VAO + buffer (dynamic geometry, used by overlay paths).
  const solidVao = gl.createVertexArray();
  const solidBuf = gl.createBuffer();
  gl.bindVertexArray(solidVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

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
  const coverVao = gl.createVertexArray();
  const coverBuf = gl.createBuffer();
  gl.bindVertexArray(coverVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, coverBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // ------------------------------------------------------------
  // Dummy textures — bound to samplers when the bundle has no
  // corresponding asset texture. WebGL2 requires every declared
  // sampler in the active program to have a valid binding even when
  // the shader's branch never reads it.
  // ------------------------------------------------------------
  function makeDummy(internal, format, type, fill) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 1, 1, 0, format, type, fill);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  const dummyGradientTex  = makeDummy(gl.RGBA32F, gl.RGBA, gl.FLOAT,
                                      new Float32Array([0,0,0,0]));
  // 1×1 dummy stops LUT — bound when a bundle has no gradients so the
  // shader's `uGradientStops` sampler stays valid. NEAREST sampling
  // (the stops shader does explicit texelFetch, not linear interp).
  const dummyGradientStops = makeDummy(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE,
                                       new Uint8Array([0,0,0,0]));
  const dummyDashTex = makeDummy(gl.RGBA32F, gl.RGBA, gl.FLOAT,
                                 new Float32Array([0,0,0,0]));

  // ------------------------------------------------------------
  // Lazy FBOs (group composite + Gaussian blur ping-pong)
  // ------------------------------------------------------------
  let shapeFbo = null, shapeFboTex = null, shapeFboRb = null;
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
  let pingFbo = null, pingTex = null;
  const pingSize = [0, 0];

  // Generic RT pool used by the filter-graph walker (filterGraph.js).
  // The fast path (kind=1/5/6 dispatch) keeps using its dedicated
  // shapeFbo / pingFbo — the pool only allocates when a
  // shape's `filterGraphId` opts into the composable path. Canvas-size
  // invalidation is the consumer's responsibility (we call invalidate
  // when the canvas resizes; the pool's lazy alloc handles the rest).
  const _rtPool = createRTPool(gl);
  // Dedicated R8 pool for coverage-only RTs (LB fill cov, stroke cov,
  // static-mesh cov) — 4× less memory than the RGBA8 filter pool. These RTs only
  // ever hold a single coverage channel (written as vec4(cov), sampled .r).
  const _covPool = createRTPool(gl, { internalFormat: gl.R8, format: gl.RED });
  // Snapshot of the registered filter/COLR handlers. Graph nodes look
  // up handlers by primitive name; the walker tolerates partial tables
  // (unregistered nodes pass through), so a renderer built when only some
  // primitives are registered still works. Registration happens at
  // module load (the root barrel registers all; a feature entry registers
  // its subset), i.e. before any createRenderer call — so this snapshot
  // sees the consumer's intended set.
  const _svgDispatch = svgFilterDispatch();
  const _colrDispatch = colrPaintDispatch();

  // ------------------------------------------------------------
  // Multi-shape mask offscreen bake.
  // One TEXTURE_2D_ARRAY (R8) sized to the canvas, one layer per
  // mask region in the bundle. We rebind a single FBO's color
  // attachment per region via framebufferTextureLayer and bake the
  // region's children additively (Blend One One — additive coverage).
  // mantle.frag samples the layer indexed by
  // uMaskRowToLayer[maskId - 1].
  //
  // Allocation is lazy + canvas-size-tracked: when the canvas resizes
  // Tier-2a result cache: the mask bake is a pure function of the bundle's
  // immutable geometry + canvas size (NOT the per-draw worldMatrix or
  // overrides — the maskBake shader samples neither). So once baked, the
  // layers in `R._maskRTArray` stay valid until the canvas resizes or a
  // different handle / geometry is bound. Stamp what we last baked so a
  // static masked asset that re-renders every frame (e.g. because a
  // SIBLING shape animates) doesn't re-bake the unchanged mask layers.
  let _maskBakeValidHandle = null;   // the handle whose masks are in R._maskRTArray
  let _maskBakeValidGen = -1;        // that handle's `generation` at bake time
  const _maskBakeValidCanvas = [0, 0];
  let _maskBakeValidShapeGen = -1;   // aggregate override-gen of all mask children at bake time
  let _maskBakeCount = 0;            // debug: # of actual bakes (cache misses)
  // Tier-2b filter result cache. Per (handle, filterGraphId, shape) we keep the
  // evaluated filter OUTPUT in a persistent texture + the key it was
  // valid for. On a hit we skip the expensive source-render +
  // evaluateGraph (the multi-pass DAG, blurs, etc.) and re-use the tex.
  // The composite-over-backdrop step still runs every frame (the backdrop
  // changes). Key = (handle.generation, worldM, canvas, the feeding
  // shape's override generation). feedShape = op.shapeIdx — the single
  // shape rendered as SourceGraphic. Cleared on dispose.
  // Filter outputs outlive the transient bundle-handle LRU: a busy scene can
  // alternate more than eight ordinary bundles while the same filtered mount
  // remains visible. Bound this independently so those handle swaps do not
  // turn an otherwise static filter into an allocation + multi-pass render
  // every frame.
  const _filterCache = new Map();    // Map<'g<owner>_<id>_<shape>'|'k<owner>_<id>_<shape>', {tex,fbo,w,h,key}>
  const MAX_FILTER_CACHE_ENTRIES = 8;
  function _dropFilterCacheEntry(c) {
    if (!c) return;
    for (const t of [c.tex, c.shapeTex]) if (t) gl.deleteTexture(t);
    for (const fb of [c.fbo, c.shapeTexFbo]) if (fb) gl.deleteFramebuffer(fb);
  }
  function _getFilterCache(key) {
    const c = _filterCache.get(key);
    if (!c) return null;
    _filterCache.delete(key);
    _filterCache.set(key, c);
    return c;
  }
  function _setFilterCache(key, c) {
    const old = _filterCache.get(key);
    if (old && old !== c) _dropFilterCacheEntry(old);
    _filterCache.delete(key);
    _filterCache.set(key, c);
    while (_filterCache.size > MAX_FILTER_CACHE_ENTRIES) {
      const oldestKey = _filterCache.keys().next().value;
      const oldest = _filterCache.get(oldestKey);
      _filterCache.delete(oldestKey);
      _dropFilterCacheEntry(oldest);
    }
  }
  // Drop one cache owner's filtered output. Persistent handles own their own
  // entries because their override tables are independent even when they share
  // a bundle. The transient setBundle handle uses the bundle as its owner.
  function _evictFilterCache(owner) {
    if (!owner) return;
    const gp = 'g' + owner + '_', kp = 'k' + owner + '_';
    for (const [k, c] of _filterCache) {
      if (!k.startsWith(gp) && !k.startsWith(kp)) continue;
      _filterCache.delete(k);
      _dropFilterCacheEntry(c);
    }
  }
  R._evictFilterCache = _evictFilterCache;
  R._getFilterCache = _getFilterCache;
  R._setFilterCache = _setFilterCache;
  let _filterEvalCount = 0;          // debug: # of actual graph evals (misses)
  let _filterBboxActiveCount = 0;   // debug: # of graph evals that ran on bbox-sized RTs

  function ensurePingFbo() {
    const [cw, ch] = viewportSize();
    if (pingSize[0] === cw && pingSize[1] === ch && pingFbo) return;
    if (pingTex) gl.deleteTexture(pingTex);
    if (pingFbo) gl.deleteFramebuffer(pingFbo);
    pingTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pingTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    pingFbo = gl.createFramebuffer();
    bindFb(gl.FRAMEBUFFER, pingFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pingTex, 0);
    bindFb(gl.FRAMEBUFFER, null);
    pingSize[0] = cw; pingSize[1] = ch;
  }

  // Returns a SHARED 2-element scratch (filled per call) to avoid a young-gen
  // allocation on every draw-path call. Safe because every caller destructures
  // the result immediately (`const [w,h] = viewportSize()`); the one caller that
  // RETAINS the array (exportFrameSVG, below) copies it with .slice(). Do not
  // hold the returned array across another viewportSize()/arScale() call.
  const _viewportScratch = [0, 0];
  function viewportSize() {
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
    return !(w >= 1) || !(h >= 1);
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
  function bindFb(target, fbo) {
    // During a static-cache bake the cache RT (canvas-sized) stands in for
    // the canvas: a "bind the canvas" (null draw target) must land in the
    // cache FBO instead. Otherwise filter / group-blend / mask composites
    // — which hardcode the canvas as their target — escape to the real
    // framebuffer, leaving the baked texture missing them; the subsequent
    // blit then overwrites the canvas with that blank cache. (READ binds
    // are blit sources, left alone.)
    if (fbo === null && R._cacheBakingNow && _handle && _handle.cacheFbo
        && (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER)) {
      fbo = _handle.cacheFbo;
    }
    gl.bindFramebuffer(target, fbo);
    // Shadow the DRAW binding. Asking GL for it later (getParameter) is not a lookup —
    // on ANGLE/Metal it flushes the pipeline and syncs with the GPU. We are the ones
    // binding it; remember it.
    if (target !== gl.READ_FRAMEBUFFER) R._boundDrawFbo = fbo;
    if (!_scissor) return;
    // READ_FRAMEBUFFER binds are blit-source only; they don't change
    // the draw target so scissor state is irrelevant. Only toggle on
    // FRAMEBUFFER and DRAW_FRAMEBUFFER binds.
    if (target === gl.READ_FRAMEBUFFER) return;
    if (fbo === null) {
      gl.scissor(_scissor[0], _scissor[1], _scissor[2], _scissor[3]);
      gl.enable(gl.SCISSOR_TEST);
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }
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
      gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fbo); gl.deleteRenderbuffer(e.rb);
    }
    _shapeRtCache.clear();
    for (const e of _backdropCache.values()) { gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fbo); }
    _backdropCache.clear();
    for (const e of _pingRtCache.values()) { gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fbo); }
    _pingRtCache.clear();
    // Filtered outputs are cached at a canvas-relative RECT — every one of them moved.
    for (const c of _filterCache.values()) {
      for (const t of [c.tex, c.shapeTex]) if (t) gl.deleteTexture(t);
      for (const fb of [c.fbo, c.shapeTexFbo]) if (fb) gl.deleteFramebuffer(fb);
    }
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
    if (shapeFboTex) gl.deleteTexture(shapeFboTex);
    if (shapeFbo)    gl.deleteFramebuffer(shapeFbo);
    if (shapeFboRb)  gl.deleteRenderbuffer(shapeFboRb);
    shapeFboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shapeFboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    shapeFbo = gl.createFramebuffer();
    bindFb(gl.FRAMEBUFFER, shapeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shapeFboTex, 0);
    shapeFboRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, shapeFboRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, cw, ch);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, shapeFboRb);
    bindFb(gl.FRAMEBUFFER, null);
    shapeFboSize[0] = cw; shapeFboSize[1] = ch;
  }
  // Pooled offscreen targets for a FILTERED SHAPE, keyed by size.
  //
  // Shape and backdrop targets cover only the filter rect. Sizes come from
  // _filterNodeRects already quantized to 32px, so the working set
  // is a handful of entries; they live with the renderer and are dropped on resize
  // alongside the RT pool.
  const _shapeRtCache  = new Map();   // "w,h" → { fbo, tex, rb }  color + depth/stencil
  const _backdropCache = new Map();   // "w,h" → { fbo, tex }      color only
  const _pingRtCache   = new Map();   // "w,h" → { fbo, tex }      the kernels' ping-pong
  function _newColorTex(w, h) {
    const tex = gl.createTexture();
    // Bind on the SCRATCH unit. gl.bindTexture hits whatever unit is active, and the
    // fill pass keeps its samplers bound across draws — allocating here on unit 0 (or
    // wherever we happened to land) silently evicts one of them, and the renderer's
    // binding cache goes on believing it is still there.
    gl.activeTexture(gl.TEXTURE15);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  // The SourceGraphic target. Needs depth + stencil: the fill pass depth-claims and
  // stencils exactly as it does against the canvas — so this cannot come from the
  // colour-only RT pool.
  function acquireShapeRT(w, h) {
    const k = w + ',' + h;
    let e = _shapeRtCache.get(k);
    if (e) return e;
    const tex = _newColorTex(w, h);
    const fbo = gl.createFramebuffer();
    bindFb(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
    bindFb(gl.FRAMEBUFFER, null);
    e = { fbo, tex, rb, size: [w, h] };
    _shapeRtCache.set(k, e);
    return e;
  }
  // Snapshot the render target's `rect` into a rect-sized texture — the backdrop the
  // filter composite blends against (and BackgroundImage, when the graph asks for it,
  // which is the one case that still needs the whole canvas).
  function snapshotBackdrop(rect, cw, ch) {
    const [rx, ry, rw, rh] = rect;
    const k = rw + ',' + rh;
    let e = _backdropCache.get(k);
    if (!e) {
      const tex = _newColorTex(rw, rh);
      const fbo = gl.createFramebuffer();
      bindFb(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      bindFb(gl.FRAMEBUFFER, null);
      e = { fbo, tex };
      _backdropCache.set(k, e);
    }
    // A rect may poke off-canvas, where copyTexSubImage2D simply doesn't write —
    // leaving whatever the recycled texture held. Clear first so those texels read
    // as transparent, which is what is behind the canvas.
    const scWas = _scissor;
    if (scWas) gl.disable(gl.SCISSOR_TEST);
    bindFb(gl.FRAMEBUFFER, e.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (scWas) gl.enable(gl.SCISSOR_TEST);
    bindFb(gl.FRAMEBUFFER, null);   // back to the render target: the copy READS it
    const sx = Math.max(0, rx), sy = Math.max(0, ry);
    const ex = Math.min(cw, rx + rw), ey = Math.min(ch, ry + rh);
    if (ex > sx && ey > sy) {
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, sx - rx, sy - ry, sx, sy, ex - sx, ey - sy);
    }
    return e;
  }
  // A same-sized scratch RT for the separable kernels to bounce through.
  function acquirePingRT(w, h) {
    const k = w + ',' + h;
    let e = _pingRtCache.get(k);
    if (e) return e;
    const tex = _newColorTex(w, h);
    const fbo = gl.createFramebuffer();
    bindFb(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    bindFb(gl.FRAMEBUFFER, null);
    e = { fbo, tex };
    _pingRtCache.set(k, e);
    return e;
  }
  function ensureMainCopyTex() {
    const [cw, ch] = viewportSize();
    if (mainCopySize[0] === cw && mainCopySize[1] === ch && mainCopyTex) return;
    if (mainCopyTex) gl.deleteTexture(mainCopyTex);
    mainCopyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    mainCopySize[0] = cw; mainCopySize[1] = ch;
  }
  function ensureGroupBackdropTex() {
    const [cw, ch] = viewportSize();
    if (groupBackdropSize[0] === cw && groupBackdropSize[1] === ch && groupBackdropTex) return;
    if (groupBackdropTex) gl.deleteTexture(groupBackdropTex);
    groupBackdropTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    groupBackdropSize[0] = cw; groupBackdropSize[1] = ch;
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
  const _transientHandles = new Map();
  const MAX_TRANSIENT_HANDLES = 8;
  // fillPass* and viewport cache stay on the renderer (truly shared
  // across handles within one frame).
  let fillPassCanvasW = 0, fillPassCanvasH = 0;
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
    overrides: null,         // createOverrideTable handle, or null
    worldM: null,            // Float32Array(9) column-major mat3, or null
    alpha: 1.0,              // opts.alpha opacity multiplier; 1.0 = none
    colorMatrix: null,       // Float32Array(16) mat4 dual-tint recolor, or null
    colorMatrixOffset: null, // Float32Array(4), or null
    extClipTex: null,        // setNodeClip coverage WebGLTexture, or null
    extClipMode: 0,          // 0=off, 1=clip-IN, 2=clip-OUT
    palette: null,           // createPalette handle (.texture/.size), or null
    paletteChannel: 0,       // 0=R, 1=G, 2=B, 3=A
    channelLerp: null,       // { primary, contrast, highlight }, or null
    shapeRange: null,        // [firstRow,lastRow] sprite subset, or null
    spriteNonContig: false,  // that subset's shapes are NOT a contiguous run → analytic slice unsafe
    spriteKey: null,         // sprite id of the active subset draw, or null
  };
  // Filter-pass scissoring on/off (default on). Internal toggle used by
  // the render-diff smoke to prove scissored == full-canvas byte-identical;
  // no public surface.
  let _filterBboxEnabled = true;
  // drawBundleInstanced GPU fast path on/off (default on). Internal toggle
  // so the render-diff smoke can compare the instanced draw against the
  // per-instance render() loop.
  let _instancedFastEnabled = true;
  // Frame lifecycle (M3): begin/end gates the swap chain present.
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
  // Per-frame coalescing state (drawList walker).
  const _groupStack = [];
  let _pendingStart = -1, _pendingEnd = -1;

  // Reusable scratch for overlay draws.
  const _triOverlayPts  = new Float32Array(6);
  const _bboxOverlayPts = new Float32Array(8);

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  // Shared 2-element scratch (see viewportSize note). Every arScale caller
  // destructures immediately; none retains the array.
  const _arScaleScratch = [0, 0];
  function arScale(bbox, vw, vh) {
    const cAR = vw / vh, sAR = bbox[2] / bbox[3];
    let sx = 1, sy = 1;
    if (sAR > cAR) sy = cAR / sAR;
    else           sx = sAR / cAR;
    _arScaleScratch[0] = sx; _arScaleScratch[1] = sy;
    return _arScaleScratch;
  }

  // COLR coord rescale: walk the graph and convert every geometric
  // coordinate from em-space (where TextRun normalised them) to
  // canvas-pixel-space (where the dispatch's gradient/transform
  // shaders sample). Applies the same em→px mapping the fill shader
  // applies to vertex positions, so PaintGlyph silhouettes and
  // PaintTransform affines end up in the same coordinate system as
  // the silhouette in shapeFbo.
  //
  // The mapping is linear: `px = sx*em + tx`, same factors for X.
  // Affine basis (xx, yx, xy, yy) is unitless so stays as-is; only
  // translations need scaling.
  function rescaleColrGraph(graph, sx, sy, tx, ty) {
    if (!graph || !graph.nodes) return graph;
    // Shallow-clone the node array; each node we touch gets a fresh
    // params object so mutating the rescaled graph doesn't leak back
    // into the bundle's pristine copy.
    const scaledNodes = graph.nodes.map(n => {
      if (!n.params) return n;
      const p = n.params;
      switch (n.type) {
        case 'PaintLinearGradient':
          return { ...n, params: {
            ...p,
            p0: p.p0 && [p.p0[0] * sx + tx, p.p0[1] * sy + ty],
            p1: p.p1 && [p.p1[0] * sx + tx, p.p1[1] * sy + ty],
            p2: p.p2 && [p.p2[0] * sx + tx, p.p2[1] * sy + ty],
          }};
        case 'PaintRadialGradient':
          return { ...n, params: {
            ...p,
            c0: p.c0 && [p.c0[0] * sx + tx, p.c0[1] * sy + ty],
            c1: p.c1 && [p.c1[0] * sx + tx, p.c1[1] * sy + ty],
            // Radii are scalar lengths. Geometric mean of per-axis
            // scale factors so non-uniform fits don't bias. For
            // uniform sx==sy this is just sx.
            r0: typeof p.r0 === 'number' ? p.r0 * Math.sqrt(Math.abs(sx * sy)) : p.r0,
            r1: typeof p.r1 === 'number' ? p.r1 * Math.sqrt(Math.abs(sx * sy)) : p.r1,
          }};
        case 'PaintSweepGradient':
          return { ...n, params: {
            ...p,
            center: p.center && [p.center[0] * sx + tx, p.center[1] * sy + ty],
            // Angles stay.
          }};
        case 'PaintTransform': {
          // Map em-space affine to px-space:
          //   px_out = S*(M*em_in + t_em) + T  (S = diag(sx,sy), T = (tx,ty))
          //   = S*M*em_in + S*t_em + T
          // em_in itself needs converting too: em_in = (px_in - T)/S.
          // Substituting:
          //   px_out = S*M*S⁻¹*(px_in - T) + S*t_em + T
          //          = (S*M*S⁻¹)*px_in + (T - S*M*S⁻¹*T + S*t_em)
          // For diagonal S = diag(sx, sy):
          //   xx' = xx
          //   yx' = yx * sy/sx
          //   xy' = xy * sx/sy
          //   yy' = yy
          if (!p.affine || p.affine.length < 6) return n;
          const [xx, yx, xy, yy, dx, dy] = p.affine;
          const xxp = xx;
          const yxp = yx * sy / sx;
          const xyp = xy * sx / sy;
          const yyp = yy;
          const dxp = tx - xxp * tx - xyp * ty + sx * dx;
          const dyp = ty - yxp * tx - yyp * ty + sy * dy;
          return { ...n, params: { ...p, affine: [xxp, yxp, xyp, yyp, dxp, dyp] }};
        }
        // PaintSolid / PaintMerge / PaintGlyph / PaintComposite carry no
        // geometric coords — share node by reference.
        default: return n;
      }
    });
    return { nodes: scaledNodes, rootOut: graph.rootOut };
  }
  function applyBlendMode(mode) {
    gl.blendEquation(gl.FUNC_ADD);
    switch (mode) {
      case 1: gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
      case 2: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
      case 4: gl.blendEquation(gl.MIN); gl.blendFunc(gl.ONE, gl.ONE); break;
      case 5: gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); break;
      default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
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
    _drawCoverRange(_pendingStart, _pendingEnd - _pendingStart);
    _pendingStart = -1; _pendingEnd = -1;
  }

  /** The stripped cover mesh laid out in draw-list order, or null when the draw
   *  list already walks it contiguously. The occlusion cull drops hidden shapes
   *  from the draw list but not from the mesh, so each dropped shape ends a
   *  contiguous range and costs another drawArrays — dozens per detailed asset.
   *  Chunks outside the draw list (culled shapes, mask sources) follow the live
   *  ones, so every chunk keeps a start. Cached on the bundle per draw list. */
  function _drawOrderedCover(bundle) {
    const verts = bundle.coverQuadVboFloats;
    const chunks = bundle.coverQuadChunks;
    const drawList = bundle.drawList;
    if (!verts || !chunks || !drawList) return null;
    const cached = bundle._drawOrderedCover;
    if (cached && cached.drawList === drawList && cached.verts === verts) return cached.layout;
    let gaps = 0, end = -1;
    for (const op of drawList) {
      const c = op.chunk;
      if (!c || c.vboStart == null) continue;
      if (end >= 0 && c.vboStart !== end) gaps++;
      end = c.vboStart + c.count;
    }
    let layout = null;
    if (gaps > 0) {
      const sidx = bundle.hybridShapeIdxVboFloats;
      const ordered = new Float32Array(verts.length);
      const orderedIdx = new Float32Array((verts.length / 12) | 0);
      const startOf = new Map();
      let at = 0;
      const place = (c) => {
        if (!c || c.vboStart == null || startOf.has(c)) return;
        const from = c.vboStart | 0, count = c.count | 0;
        ordered.set(verts.subarray(from * 12, (from + count) * 12), at * 12);
        if (sidx) orderedIdx.set(sidx.subarray(from, from + count), at);
        startOf.set(c, at);
        at += count;
      };
      for (const op of drawList) place(op.chunk);
      for (const c of chunks) place(c);
      layout = { verts: ordered.subarray(0, at * 12), shapeIdx: orderedIdx.subarray(0, at), startOf, count: at };
    }
    bundle._drawOrderedCover = { drawList, verts, layout };
    return layout;
  }

  /** Upload cover-quad + matching shapeIdx planes onto the active handle.
   *  shapeIdx is always sized to the vert count — attrib 7 stays enabled. */
  function _uploadCoverMesh(h, bundle) {
    h.coverDrawList = bundle.drawList;
    const ordered = _drawOrderedCover(bundle);
    h.coverStartOf = ordered ? ordered.startOf : null;
    if (ordered) {
      if (h._ensureCoverResources) h._ensureCoverResources();
      gl.bindBuffer(gl.ARRAY_BUFFER, h.triBuf);
      gl.bufferData(gl.ARRAY_BUFFER, ordered.verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, h.shapeIdxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, ordered.shapeIdx, gl.STATIC_DRAW);
      h.coverVertCount = ordered.count;
      h.coverStripped = true;
      return;
    }
    const vboVerts = bundle.coverQuadVboFloats || bundle.coverQuadFloats;
    if (!vboVerts) {
      h.coverVertCount = 0;
      h.coverStripped = false;
      return;
    }
    if (h._ensureCoverResources) h._ensureCoverResources();
    const stripped = !!(bundle.coverQuadVboFloats);
    const coverVertCount = (vboVerts.length / 12) | 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, h.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vboVerts, gl.STATIC_DRAW);
    let vboSidx = stripped
      ? bundle.hybridShapeIdxVboFloats
      : (bundle.hybridShapeIdxFloats || bundle.hybridShapeIdxVboFloats);
    if (!vboSidx || (vboSidx.length | 0) < coverVertCount) {
      const padded = new Float32Array(coverVertCount);
      if (vboSidx) padded.set(vboSidx.subarray(0, Math.min(vboSidx.length, coverVertCount)));
      vboSidx = padded;
    } else if ((vboSidx.length | 0) > coverVertCount) {
      vboSidx = vboSidx.subarray(0, coverVertCount);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, h.shapeIdxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vboSidx, gl.STATIC_DRAW);
    h.coverVertCount = coverVertCount;
    h.coverStripped = stripped;
  }

  /** Chunk first-vert index for the currently uploaded cover VBO. */
  function _coverChunkStart(chunk) {
    if (!chunk) return -1;
    if (_handle && _handle.coverStartOf) {
      const start = _handle.coverStartOf.get(chunk);
      return start === undefined ? -1 : start;
    }
    if (_handle && _handle.coverStripped) {
      // Stripped uploads omit chunk headers, so the original `start` would
      // address beyond the compact VBO on large Slug fallbacks.
      return (chunk.vboStart != null) ? (chunk.vboStart | 0) : -1;
    }
    return (chunk.vboStart != null ? chunk.vboStart : chunk.start) | 0;
  }

  /** Clamp + draw a cover-quad range against the uploaded vert count. */
  function _drawCoverRange(start, count) {
    if (!_handle || !_handle.triVao) return;
    // Always rebind — beginFillPass may have early-returned while another
    // path left a different VAO bound.
    gl.bindVertexArray(_handle.triVao);
    const maxV = (_handle.coverVertCount | 0) || 0;
    let s = start | 0, c = count | 0;
    if (maxV <= 0 || c <= 0 || s < 0) return;
    if (s >= maxV) return;
    if (s + c > maxV) {
      if (typeof console !== 'undefined') {
        console.warn('[mantle] cover draw clamped ' + c + ' → ' + (maxV - s) +
          ' verts @' + s + ' (VBO has ' + maxV + ')');
      }
      c = maxV - s;
    }
    if (c > 0) gl.drawArrays(gl.TRIANGLES, s, c);
  }

  function _drawCoverChunk(chunk) {
    const s = _coverChunkStart(chunk);
    if (s < 0 || !chunk) return;
    _drawCoverRange(s, chunk.count | 0);
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
    for (const h of _transientHandles.values()) h.dispose();
    _transientHandles.clear();
  }

  function _getTransientHandle(bundle, deferCoverUpload) {
    let h = _transientHandles.get(bundle);
    if (h) {
      _transientHandles.delete(bundle);
      _transientHandles.set(bundle, h);
      return h;
    }
    while (_transientHandles.size >= MAX_TRANSIENT_HANDLES) {
      const oldestBundle = _transientHandles.keys().next().value;
      const oldest = _transientHandles.get(oldestBundle);
      _transientHandles.delete(oldestBundle);
      if (oldest === _handle) _handle = null;
      // Filter-output residency is independently bounded above. Keep it when
      // this geometry handle ages out so an alternating scene can still hit
      // a static filter result on its next visit.
      oldest.dispose({ retainFilterCache: true });
    }
    h = R.createBundleHandle(bundle, {
      filterCacheOwner: 'b' + bundle.uid,
      deferCoverUpload: !!deferCoverUpload,
    });
    _transientHandles.set(bundle, h);
    return h;
  }

  function setBundle(bundle, opts) {
    // Same-bundle bind: a no-op for the per-handle state (mask regions
    // + GL lookup texture are immutable for the lifetime of the bundle).
    // The intervening passes between renders (filter graph, mask bake,
    // cache blit) still need the next fill pass to re-bind the asset
    // textures, so we flip _handle.fillPassAssetDirty true unconditionally.
    if (_handle && _handle.bundle === bundle) {
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
    _handle = _getTransientHandle(bundle, opts && opts.deferCoverUpload);
    _refreshBoundHandle(_handle, bundle);
  }

  // FRAME-INTERVAL sampling for the cache cost gate: the cached path's real cost
  // (RT switches, blit sync) is GPU-side and invisible to JS timers, so the gate
  // compares each mode's actual frame cadence. `_lastModeCached9` says which mode
  // the PREVIOUS frame ran, so the interval lands in that mode's EMA. Called from
  // handle.draw() (which decides cache-vs-LB before the route) or from render().
  function _cacheSampleCost() {
    if (!_handle) return;
    const now9 = performance.now();
    if (_handle._lastRenderT !== undefined) {
      const dt9 = now9 - _handle._lastRenderT;
      if (_handle._skipNextSample9) { _handle._skipNextSample9 = false; }
      else if (dt9 > 0.5 && dt9 < 100) {
        if (_handle._lastModeCached9) _handle._cachedCostEma = _handle._cachedCostEma === undefined ? dt9 : _handle._cachedCostEma * 0.92 + dt9 * 0.08;
        else _handle._directCostEma = _handle._directCostEma === undefined ? dt9 : _handle._directCostEma * 0.92 + dt9 * 0.08;
      }
    }
    _handle._lastRenderT = now9;
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

    // Static-scene cache hookup. When the active handle has cache
    // enabled and we're not re-entering from the bake step below,
    // the cache state machine decides whether this frame should
    // bake-then-blit or reuse the prior bake. Live (None) path falls
    // through to the normal render body unchanged.
    //
    // Cache state lives on the handle (multi-bundle scenes get
    // per-mount caching). The handle IS the bundle; a bundle swap creates
    // a new handle, hence a new cache RT, which can't be stale relative
    // to its handle's bundle.
    // FRAME-INTERVAL sampling for the cache cost gate: the cached path's real
    // cost (RT switches, blit sync) is GPU-side and invisible to JS timers, so
    // the gate compares the actual frame cadence of each mode instead.
    // A cached handle whose bundle takes the LB route never reaches render(), so
    // its cache could never tick — the cost gate never ran and the cache never
    // engaged (LB won unconditionally). handle.draw() now samples + ticks FIRST
    // so the cache can COMPETE with LB, and hands the decision down here. When it
    // pre-decided, consume that; otherwise (bare drawBundle / setBundle) decide here.
    /** @type {number} */
    let level = CacheLevel.None;
    if (_handle._decidedLevel9 !== undefined) {
      level = _handle._decidedLevel9;
      _handle._decidedLevel9 = undefined;
    } else if (!R._cacheBakingNow) {
      // (never sample/tick inside a bake re-entry — that interval is bake cost,
      // not the blit cadence the gate compares)
      R._cacheSampleCost();
      if (_handle.cache) level = R._cacheTick();
    }
    if (_handle.cache && !R._cacheBakingNow) {
      if (level === CacheLevel.WholeAsset || level === CacheLevel.ViewportWindow || level === CacheLevel.SharedGroup) {
        const _wasValid9 = _handle.cache.isCacheValid;
        if (level === CacheLevel.SharedGroup && !_handle.cache.isCacheValid
            && _handle.cache.isGroupCacheValid()) {
          // Adopt the group's existing bake: BORROW the shared RT (so
          // _cacheBlitToCanvas has a texture — this handle never baked, so its
          // cacheTex is still null) and mark valid WITHOUT re-baking. This is
          // the "blit twice" half of shared-group caching. If borrowing fails we leave
          // the cache invalid and fall through to a normal bake below.
          const [acw, ach] = viewportSize();
          if (R._cacheEnsureFbo(acw, ach) && _handle.cache.isGroupCacheValid()) {
            _handle.cache.markBaked(R._cacheFrameSeq);
            _handle.cacheBakeCw = acw;
            _handle.cacheBakeCh = ach;
          }
        }
        if (!_handle.cache.isCacheValid) {
          if (!R._cacheBakeAndBlit()) {
            // Bake failed → fall back to live this frame.
            _renderCanvasInner();
            return;
          }
        }
        R._cacheBlitToCanvas();
        R._cacheFrameSeq++;
        _handle._lastModeCached9 = true;
        if (!_wasValid9) _handle._skipNextSample9 = true;   // bake frames don't represent the blit cadence
        return;
      }
      // Level.None → fall through to live render.
    }

    _handle._lastModeCached9 = false;
    _renderCanvasInner();
  }

  // The original render() body. Extracted so the cache bake path
  // can re-enter it with a different framebuffer + viewport bound,
  // and the live-render path can call it directly.
  // Retire the occlusion cull once a per-shape override could change what covers what.
  //
  // occlusionCull decides containment ONCE, from static em-space geometry, and applies it by
  // REMOVING shapes from the draw list (bundle.js:140). Overrides then move / hide / fade shapes
  // at draw time, so an occluder can stop occluding after that decision was made — and the shape
  // underneath, already dropped from the list, silently never draws again. (Measured: hide the
  // occluder via `visibility: 0` and the covered shape does not come back.)
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
    if (!b || !b.drawListUnculled || b.drawList === b.drawListUnculled) return;
    const ov = _ds.overrides;
    const ovP = ov && ov.packedBuffer;
    if (!ovP) return;
    // Only re-scan when the override state actually moved. Without this, a table carrying only
    // colour changes never retires the cull and so re-scans every shape on EVERY draw forever.
    const ovGen = (ov.generation | 0);
    if (b._cullOvScanGen === ovGen && b._cullOvScanTable === ov) return;
    b._cullOvScanGen = ovGen;
    b._cullOvScanTable = ov;
    // 24 floats/shape: 0..3 affine (a,b,c,d), 4..5 (tx,ty), 6 visibility, 7 overrideMask,
    // 8..11 tint rgba. Anything that can shrink, move, hide or fade a shape invalidates a
    // containment decision; a pure colour change cannot, but an ALPHA change can, so tint.a and
    // the absolute-override mask (which can carry a fill alpha) both count.
    const n = b.numShapes | 0;
    let affects = false;
    for (let s = 0; s < n; s++) {
      const o = s * 24;
      if (Math.abs(ovP[o] - 1) > 1e-4 || Math.abs(ovP[o + 1]) > 1e-4
       || Math.abs(ovP[o + 2]) > 1e-4 || Math.abs(ovP[o + 3] - 1) > 1e-4
       || Math.abs(ovP[o + 4]) > 1e-4 || Math.abs(ovP[o + 5]) > 1e-4
       || ovP[o + 6] < 0.9999 || ovP[o + 7] !== 0 || ovP[o + 11] < 0.9999) { affects = true; break; }
    }
    if (!affects) return;
    b._drawListCulled = b.drawList;
    b.drawList = b.drawListUnculled;
    b._lbCombined = null;                          // combined VBO was built from the short list
    b._cullGen = (b._cullGen | 0) + 1;             // draw-list derivatives must rebuild
  }

  function _renderCanvasInner() {
    if (!_handle || !_handle.bundle) return;
    _retireCullIfOverridden();
    const [cw, ch] = viewportSize();
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    // Depth + stencil are per-bundle resources: within a bundle they
    // sequence shape z-order and clip/mask coverage, but ACROSS bundle
    // calls they must be reset so a later bundle's draw doesn't depth-
    // test against an earlier bundle's depth values (or its stencil
    // coverage). Clear unconditionally — both the
    // beginFrame/drawBundle×N/endFrame lifecycle and the standalone
    // drawInstance pattern need this.
    //
    // Pre-fix: clearing was gated on `!_inFrame`, so beginFrame ran
    // the clear once and subsequent drawBundle calls in the same
    // frame inherited stale depth/stencil from earlier bundles —
    // visible as cross-bundle painter-order failures even though the
    // CPU-side mount sort was correct (later bundles' shapes rejected
    // by the LEQUAL depth test against earlier bundles' depths).
    gl.clearStencil(0);
    gl.clearDepth(1.0);
    gl.depthMask(true);
    if (!_inFrame) {
      // Color clear is gated: beginFrame owns the color clear for
      // multi-bundle scenes; standalone callers (legacy `render()`
      // single-bundle path) still get the implicit color clear.
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      gl.clear(gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    gl.depthMask(false);
    // The occlusion cull (or its retirement) swapped the draw list: re-lay out the
    // cover mesh when either the old or the new list needs draw-list order.
    if (_handle.coverDrawList !== _handle.bundle.drawList) {
      _handle.coverDrawList = _handle.bundle.drawList;
      if (_handle.coverStartOf || _drawOrderedCover(_handle.bundle)) _handle.hybridMeshDirty = true;
    }
    if (_handle.hybridMeshDirty && (_handle.bundle.coverQuadVboFloats || _handle.bundle.coverQuadFloats)) {
      // Re-upload the header-free VBO planes (see bundleHandle.js) so a
      // streamed / nine-sliced re-derive keeps chunk vboStart in sync.
      _uploadCoverMesh(_handle, _handle.bundle);
      _handle.hybridMeshDirty = false;
    }
    // Write depth only for occupancy's certified opaque interiors. The
    // analytic pass below remains responsible for all color and AA edges.
    if (R.runOpaquePrepass) R.runOpaquePrepass(_handle);
    // Multi-shape mask offscreen bake. Runs before the
    // main draw list so mantle.frag can sample uMaskRTArray when a shape
    // carries a maskId pointing at a region with a baked layer.
    if (R.maskBakeProg && _handle.maskRegions.length) {
      // Skip the bake when the existing R._maskRTArray is still
      // valid for this handle (same geometry generation, same canvas size,
      // AND same mask-child override generation). The bake is worldMatrix-
      // independent (em-space, pre-projection), so a re-render driven by a
      // SIBLING animation reuses the layers — but an animated MASK CHILD
      // bumps R._maskFeedShapeGen() and forces a re-bake at its new position.
      const [cw, ch] = viewportSize();
      const maskFeedGen = R._maskFeedShapeGen();
      const maskValid = R._maskRTArray
        && _maskBakeValidHandle === _handle
        && _maskBakeValidGen === _handle.generation
        && _maskBakeValidCanvas[0] === cw
        && _maskBakeValidCanvas[1] === ch
        && _maskBakeValidShapeGen === maskFeedGen;
      if (!maskValid) {
        R.bakeMaskRegions();
        _maskBakeCount++;
        _maskBakeValidHandle = _handle;
        _maskBakeValidGen = _handle.generation;
        _maskBakeValidCanvas[0] = cw;
        _maskBakeValidCanvas[1] = ch;
        _maskBakeValidShapeGen = maskFeedGen;
        // The bake rewrote bundle texture bindings; force the fill pass
        // to rebind on next R.beginFillPass().
        _handle.fillPassAssetDirty = true;
      }
    }
    R.endFillPass();

    const groupStack = _groupStack;
    const drawList = _handle.bundle.drawList;
    for (let di = 0; di < drawList.length; di++) {
      const op = drawList[di];
      if (op.kind === 'groupBegin') {
        flushPending();
        R.endFillPass();
        ensureShapeFbo();
        ensureMainCopyTex();
        // Capture the canvas backdrop (shapes drawn so far this frame)
        // into mainCopyTex. Earlier dispatch paths may have left an
        // offscreen FBO bound; the snapshot MUST come from the default
        // framebuffer, so re-bind null explicitly.
        // The group's CONTENT RECT: the union of what its children actually paint.
        //
        // A group cost three FULL-CANVAS operations, every group, every frame: snapshot
        // the whole canvas as the backdrop, clear the whole accumulator, then composite
        // the whole accumulator back. For a group covering a corner of the screen, all
        // three were almost entirely wasted, and all three scale with the canvas — the
        // same shape as the fullscreen problem. Bound them by what the group paints.
        //
        // null = could not bound it safely → full canvas, exactly as before. A group whose
        // rect is too small drops its children's pixels on the floor, which is a far worse
        // bug than a slow group.
        let _gOps = null, _gDepth = 1;
        for (let gi = di + 1; gi < drawList.length; gi++) {
          const go = drawList[gi];
          if (go.kind === 'groupBegin') { _gDepth++; continue; }
          if (go.kind === 'groupEnd') { if (--_gDepth === 0) break; continue; }
          (_gOps || (_gOps = [])).push(go);
        }
        // Kill switch: a wrong rect and a clipped group look identical from the outside.
        // __MANTLE_NO_GROUP_RECT falls back to full-canvas group passes — slower,
        // unconditionally correct. If a group's content vanishes, look here first.
        const grpRect = (_gOps && !mantleDebugFlag('noGroupRect'))
          ? R._contentRectPx(cw, ch, _gOps) : null;

        bindFb(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
        // Snapshot only the region groupEnd will read back. mainCopyTex is canvas-sized
        // and the copy lands at the same coordinates, so the rest of it stays stale —
        // which is fine precisely because groupEnd only samples inside the rect.
        if (grpRect) gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, grpRect[0], grpRect[1],
                                          grpRect[0], grpRect[1], grpRect[2], grpRect[3]);
        else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
        bindFb(gl.FRAMEBUFFER, shapeFbo);
        gl.viewport(0, 0, cw, ch);
        gl.depthMask(true); gl.stencilMask(0xff);
        gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
        // Clear only the rect. Outside it the accumulator keeps whatever a previous group
        // left — harmless, because nothing writes there and groupEnd never reads there.
        if (grpRect) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(grpRect[0], grpRect[1], grpRect[2], grpRect[3]);
        }
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        // bindFb(shapeFbo) had already disabled the scissor for this offscreen target;
        // put it back the way it found it.
        if (grpRect) gl.disable(gl.SCISSOR_TEST);
        gl.depthMask(false);
        groupStack.push({
          opacity:   op.opacity,
          blendMode: op.blendMode,
          isolation: op.isolation,
          rect:      grpRect,
        });
        continue;
      }
      if (op.kind === 'groupEnd') {
        flushPending();
        R.endFillPass();
        const grp = groupStack.pop();
        if (!grp) continue;
        bindFb(gl.FRAMEBUFFER, null);
        // Composite only over the group's own rect. The accumulator is transparent outside
        // it (nothing drew there) and blendFunc is ONE,ZERO — a REPLACE — so a full-canvas
        // quad would have been rewriting the whole screen with "backdrop, unchanged", every
        // group, every frame.
        const gr = grp.rect;
        if (gr) gl.viewport(gr[0], gr[1], gr[2], gr[3]);
        else gl.viewport(0, 0, cw, ch);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.useProgram(R.compProg);
        // vUV spans the rect now; both inputs are canvas-sized, so map it back to them.
        if (gr) {
          const m = [gr[2] / cw, gr[3] / ch, gr[0] / cw, gr[1] / ch];
          if (compUShapeMap) gl.uniform4f(compUShapeMap, m[0], m[1], m[2], m[3]);
          if (compUDstMap)   gl.uniform4f(compUDstMap,   m[0], m[1], m[2], m[3]);
        } else {
          COMP_IDENTITY_MAP();
        }
        R._fpUValid = false;
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shapeFboTex); gl.uniform1i(compUShapeTex, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);  gl.uniform1i(compUDstTex, 1);
        gl.uniform1i(compUBlendMode, grp.blendMode | 0);
        gl.uniform1f(compUOpacity, isFinite(grp.opacity) ? grp.opacity : 1);
        gl.bindVertexArray(coverVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        _handle.fillPassAssetDirty = true;
        continue;
      }
      // Sprite-subset draw: every op below here is a shape op (carries
      // op.shapeIdx). Skip those outside the requested sprite range. Group
      // begin/end ops above are kept so a sprite that DOES contain a nested
      // group still composites correctly; flat sprites (the common sheet
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
      // The bbox propagation pre-pass (computeNodeBboxes) is run with
      // sourceBbox = the shape's bbox so PaintLinearGradient et al see
      // the right axis range.
      if (op.colrGraphId && _handle.bundle.colrGraphs) {
        const entry = _handle.bundle.colrGraphs[op.colrGraphId - 1];
        // Accept both shapes — the rich form { graph, masks } emitted
        // by TextRun for slice 8d, and a bare graph DAG for hand-rolled
        // tests / future emitters.
        const graph = (entry && entry.graph) || entry;
        const maskMap = (entry && entry.masks) || null;
        if (graph && graph.nodes && graph.nodes.length) {
          flushPending();
          R.endFillPass();
          ensureShapeFbo();
          ensureMainCopyTex();
          // Inside a group, shapeFbo IS the group accumulator and
          // mainCopyTex holds the canvas snapshot groupEnd composites
          // against — this branch must not clear the former or clobber
          // the latter, and its result must land IN the group. Use the
          // blend branch's arrangement: pingFbo for the silhouette,
          // groupBackdropTex for the local backdrop, shapeFbo as dst.
          const inGrpC = groupStack.length > 0;
          let colrSrcFbo = shapeFbo, colrSrcTex = shapeFboTex;
          let colrBackdrop = mainCopyTex, colrDst = null;
          if (inGrpC) {
            ensurePingFbo();
            ensureGroupBackdropTex();
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
            bindFb(gl.FRAMEBUFFER, shapeFbo);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
            colrSrcFbo = pingFbo; colrSrcTex = pingTex;
            colrBackdrop = groupBackdropTex; colrDst = shapeFbo;
          } else {
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          }
          _handle.fillPassAssetDirty = true;
          // Render the primary glyph silhouette into the silhouette FBO.
          // Primary mask = the silhouette referenced by the top-level
          // PaintGlyph (or the bare top-level outline when none wraps).
          bindFb(gl.FRAMEBUFFER, colrSrcFbo);
          gl.viewport(0, 0, cw, ch);
          gl.depthMask(true); gl.stencilMask(0xff);
          gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          R.beginFillPass();
          _drawCoverChunk(op.chunk);
          R.endFillPass();
          // Bake per-gid alpha masks for every PaintGlyph node in the
          // graph that references a non-primary gid. Each mask uses
          // the bundle's existing coverQuadChunks via the shapeIdx
          // recorded in entry.masks[gid]; we render each into its own
          // pool RT and pass the map through ctx.glyphAlphaMasks. The
          // dispatch's paintGlyph handler resolves node.params.glyphId
          // against this map (falls back to glyphAlphaTex for the
          // primary). Mask RTs are released after evaluation.
          const glyphAlphaMasks = new Map();
          const maskRTIdxs = [];
          if (maskMap) {
            for (const gidStr of Object.keys(maskMap)) {
              const maskShapeIdx = maskMap[gidStr];
              const maskChunk = _handle.bundle.chunkByShape[maskShapeIdx];
              if (!maskChunk) continue;
              const gidNum = +gidStr;
              if (gidNum === op.shapeIdx + 1 /* primary already rendered */) {
                glyphAlphaMasks.set(gidNum, colrSrcTex);
                continue;
              }
              // For mask-only shapes we know the silhouette is the
              // same gid the slot used + transformAndFlip — but the
              // mask shape's gid number in the bundle is its own
              // accumGroupId. The map key is the original COLR gid
              // from FontAsset.getColrV1GraphByGid (referenced by
              // PaintGlyph.glyphId). We acquire a pool RT and
              // re-run the fill pass with that shape's chunk.
              const rtIdx = _rtPool.acquire(cw, ch);
              maskRTIdxs.push(rtIdx);
              const rt = _rtPool.get(rtIdx);
              bindFb(gl.FRAMEBUFFER, rt.fbo);
              gl.viewport(0, 0, cw, ch);
              gl.depthMask(true); gl.stencilMask(0xff);
              gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
              gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
              gl.depthMask(false);
              R.beginFillPass();
              _drawCoverChunk(maskChunk);
              R.endFillPass();
              glyphAlphaMasks.set(gidNum, rt.tex);
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
          // sourceBbox for the graph = the shape's bbox (texel 0)
          // mapped from em-space → canvas-pixel-space so it matches
          // the fill pass's silhouette in shapeFbo. The shader's
          // vertex math is:
          //   uv    = (em - gBB.xy) / gBB.zw         // 0..1
          //   plane = (uv*2 - 1) * canvasAR
          //   pos.x = plane.x          → px.x = (pos.x + 1) * cw / 2
          //   pos.y = -plane.y         → px.y = (1 - pos.y) * ch / 2
          // (Note WebGL2 readPixels reports framebuffer pixels with
          // origin at bottom-left; the smoke's coverage check reads
          // through that convention. Bbox math here matches the
          // framebuffer/silhouette coord system.)
          const gBB = _handle.bundle.globalBBox;
          const [arSx, arSy] = arScale(gBB, cw, ch);
          // The fill shader's em → screen-px mapping:
          //   plane = ((em - gBB.xy)/gBB.zw * 2 - 1) * (arSx, arSy)
          //   pos.x = plane.x                              (NDC x)
          //   pos.y = -plane.y                             (NDC y, flipped)
          //   px.x  = (pos.x + 1) * cw / 2
          //   px.y  = (1 - pos.y) * ch / 2  = (1 + plane.y) * ch / 2
          // → Linear: px.x = sxEmToPx * em.x + txEmToPx
          //            px.y = syEmToPx * em.y + tyEmToPx
          const sxEmToPx = arSx * cw / Math.max(1e-12, gBB[2]);
          const syEmToPx = arSy * ch / Math.max(1e-12, gBB[3]);
          const txEmToPx = (1 - arSx) * cw * 0.5 - gBB[0] * sxEmToPx;
          const tyEmToPx = (1 - arSy) * ch * 0.5 - gBB[1] * syEmToPx;
          const emXmin = _handle.bundle.metaFloats[mb + 0];
          const emYmin = _handle.bundle.metaFloats[mb + 1];
          const emXmax = _handle.bundle.metaFloats[mb + 2];
          const emYmax = _handle.bundle.metaFloats[mb + 3];
          const sourceBbox = {
            x: emXmin * sxEmToPx + txEmToPx,
            y: emYmin * syEmToPx + tyEmToPx,
            w: (emXmax - emXmin) * sxEmToPx,
            h: (emYmax - emYmin) * syEmToPx,
          };
          // Now scale the graph's coordinates from em → canvas-pixel
          // so the gradient/transform shaders sample in matching
          // units. The reader's font-unit coords were normalised to
          // em by TextRun (`normaliseColrCoords`); convert that em
          // space to canvas-pixel space here. The graph is the
          // bundle's permanent copy, so we clone first — the rescale
          // depends on the current canvas dimensions and we'd
          // otherwise repeatedly multiply on each frame.
          const scaledGraph = rescaleColrGraph(graph, sxEmToPx, syEmToPx, txEmToPx, tyEmToPx);
          const { bboxes } = computeNodeBboxes(scaledGraph, sourceBbox, cw, ch);
          const ctx = {
            gl, pool: _rtPool, coverVao, w: cw, h: ch,
            bbox: bboxes,
            glyphAlphaTex: colrSrcTex,
            glyphAlphaMasks,
            runColor,
            // Bundle's shared gradient-stops LUT — same texture the
            // SVG fill walker (ray-cast) reads from. Per-node (stopsOffset,
            // stopsCount) in node.params resolve to slices of this
            // texture, single source of truth across SVG and COLR.
            gradientStopsTex: _handle.bundle.gradientStopsTex || null,
            paintLinearGradProg, paintLinearGradU,
            paintRadialGradProg, paintRadialGradU,
            paintSweepGradProg,  paintSweepGradU,
            paintTransformProg,  paintTransformU,
            paintGlyphProg,      paintGlyphU,
            paintCompositeProg,  paintCompositeU,
            feCompositeProg,
            feCompositeU: feCompositeProg ? {
              uIn1: fcUIn1, uIn2: fcUIn2, uIn1Map: fcUIn1Map, uIn2Map: fcUIn2Map,
              uOp: fcUOp, uK: fcUK,
            } : null,
            bundle: _handle.bundle,
          };
          // Filter-graph dispatch binds pool RTs directly on `gl` —
          // those binds bypass bindFb, so disable SCISSOR_TEST here so
          // the user scissor doesn't crop the graph's intermediate RTs.
          // The post-eval bindFb(FRAMEBUFFER, null) below restores it.
          if (_scissor) gl.disable(gl.SCISSOR_TEST);
          const rootRT = evaluateGraph(gl, scaledGraph, _rtPool, _colrDispatch, ctx, cw, ch);
          // Free per-gid mask RTs back to the pool.
          for (const rtIdx of maskRTIdxs) _rtPool.release(rtIdx);
          // Free any lazy stops textures created for synthetic nodes
          // that carried inline stops (test-only path; production
          // nodes use the bundle-resolved stopsOffset/stopsCount).
          if (ctx._lazyStopsTextures) {
            for (const tex of ctx._lazyStopsTextures) gl.deleteTexture(tex);
          }
          bindFb(gl.FRAMEBUFFER, colrDst);
          gl.viewport(0, 0, cw, ch);
          gl.disable(gl.DEPTH_TEST);
          gl.disable(gl.STENCIL_TEST);
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(R.compProg);
          COMP_IDENTITY_MAP();
          R._fpUValid = false;
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rootRT.tex);   gl.uniform1i(compUShapeTex, 0);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, colrBackdrop); gl.uniform1i(compUDstTex, 1);
          gl.uniform1i(compUBlendMode, 0);
          gl.uniform1f(compUOpacity, 1);
          gl.bindVertexArray(coverVao);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.bindVertexArray(null);
          releaseRoot(_rtPool, rootRT);   // hand the root back — see the SVG route
          _handle.fillPassAssetDirty = true;
          continue;
        }
      }
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
          // These inputs are not represented in the result-cache key. A
          // filtered SourceGraphic is cacheable only when it is self-contained.
          const _readsBackdrop = graph.nodes.some(n =>
            n.inputs.some(i => i === SRC_BACKGROUND || i === SRC_BACKGROUND_A));
          const _filterCacheable = !_ds.palette && !_ds.extClipTex && !_ds.shapeRange
            && !_readsBackdrop && !_handle.bundle.maskMesh;
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
            geomGen: _handle.bundle ? (_handle.bundle._geomGen | 0) : 0,
            morphT: (_handle.bundle && _handle.bundle._morphSrc) ? _handle.bundle._morphSrc.t : 0,
            cw, ch,
            wmHash: R._wmHash(_ds.worldM),
            shapeGen: (_ds.overrides && _ds.overrides.shapeGenOf)
              ? _ds.overrides.shapeGenOf(op.shapeIdx | 0) : 0,
            recolor: R._recolorHash(),
          };
          // Filter graph IDs are bundle-local and a graph may feed more than one
          // shape. Keep an output per feeding shape; otherwise two shapes sharing a
          // graph evict each other on every frame.
          const fCacheId = 'g' + _handle._filterCacheOwner + '_'
            + op.filterGraphId + '_' + (op.shapeIdx | 0);
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
          if (filterHit) {
            // Snapshot backdrop, then composite the cached filtered tex.
            flushPending();
            R.endFillPass();
            if (inGrpF) {
              ensureGroupBackdropTex();
              gl.activeTexture(gl.TEXTURE15);
              gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
              bindFb(gl.FRAMEBUFFER, shapeFbo);
              gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
              R._compositeFilteredTex(cached.tex, groupBackdropTex, cw, ch, shapeFbo, cached.rect || null);
            } else if (cached.rect) {
              // Snapshot only the region we're about to composite into — not the canvas.
              const bd = snapshotBackdrop(cached.rect, cw, ch);
              R._compositeFilteredTex(cached.tex, bd.tex, cw, ch, null, cached.rect, cached.rect);
            } else {
              ensureMainCopyTex();
              gl.activeTexture(gl.TEXTURE15);
              gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
              gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
              R._compositeFilteredTex(cached.tex, mainCopyTex, cw, ch, null, null, null);
            }
            _handle.fillPassAssetDirty = true;
            continue;
          }
          flushPending();
          R.endFillPass();
          // Per-node rects. Needed BEFORE the source render now: they decide how big
          // the SourceGraphic RT and the backdrop have to be.
          const _fInfo = R._filterNodeRects(graph, op.shapeIdx | 0, cw, ch);
          const _fRects = _fInfo ? _fInfo.rects : null;
          if (_fRects) _filterBboxActiveCount++;
          const _rootRect = _fRects ? _fRects[graph.rootOut] : null;
          // BackgroundImage / BackgroundAlpha read the backdrop AS A GRAPH INPUT, and
          // may sample it anywhere — so that one case still needs the whole canvas.
          // Can the shape render into an RT covering only its own rect? Not inside a
          // group (shapeFbo is the accumulator there, and canvas-sized by nature).
          const _srcRect = (!inGrpF && _fInfo && _fInfo.source && !_readsBackdrop && _rootRect)
            ? _fInfo.source : null;

          let fSrcFbo, fSrcTex, fBackdrop, fDst = null;
          let fSrcRect = null, fBackdropRect = null;
          if (inGrpF) {
            ensureShapeFbo();
            ensureMainCopyTex();
            ensurePingFbo();
            ensureGroupBackdropTex();
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
            bindFb(gl.FRAMEBUFFER, shapeFbo);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
            fSrcFbo = pingFbo; fSrcTex = pingTex;
            fBackdrop = groupBackdropTex; fDst = shapeFbo;
          } else if (_srcRect) {
            const sRT = acquireShapeRT(_srcRect[2], _srcRect[3]);
            fSrcFbo = sRT.fbo; fSrcTex = sRT.tex; fSrcRect = _srcRect;
            const bd = snapshotBackdrop(_rootRect, cw, ch);
            fBackdrop = bd.tex; fBackdropRect = _rootRect;
          } else {
            ensureShapeFbo();
            ensureMainCopyTex();
            fSrcFbo = shapeFbo; fSrcTex = shapeFboTex;
            // Snapshot main FB → mainCopyTex (SourceBackground for the graph).
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
            fBackdrop = mainCopyTex;
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
            gl.viewport(-fSrcRect[0], -fSrcRect[1], cw, ch);
            R._fragOrigin = fSrcRect;
          } else {
            gl.viewport(0, 0, cw, ch);
          }
          gl.depthMask(true); gl.stencilMask(0xff);
          gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          R.beginFillPass();
          _drawCoverChunk(op.chunk);
          R.endFillPass();
          // Build the dispatch context. Handlers in filterGraphSvg.js
          // sample by texture; we present shapeFbo + mainCopyTex as the
          // SourceGraphic and BackgroundImage source RTs without
          // pre-acquiring pool slots for them (saves two allocations
          // per filter evaluation).
          // em→canvas-px scale folded into scale-sensitive graph primitives
          // (blur σ, offset, morphology radius, convolve/displacement kernel
          // spacing, lighting gradient). This is the SAME _filterPxPerEm the
          // single-kind path uses (canvas-AR × worldMatrix), so a primitive
          // renders at the identical size in both paths — params are in
          // viewBox/em units and pxPerEm converts them to the canvas-res RT.
          const _pxPerEm = R._filterPxPerEm(cw, ch);
          const ctx = R._buildFilterCtx(cw, ch, _pxPerEm,
            { fbo: fSrcFbo, tex: fSrcTex,
              size: fSrcRect ? [fSrcRect[2], fSrcRect[3]] : [cw, ch],
              rect: fSrcRect || [0, 0, cw, ch] },
            { fbo: null, tex: fBackdrop,
              size: fBackdropRect ? [fBackdropRect[2], fBackdropRect[3]] : [cw, ch],
              rect: fBackdropRect || [0, 0, cw, ch] });
          // Per-eval lookup textures for feComponentTransfer nodes.
          // Each node's params.lutBytes (256×4 RGBA8) is uploaded into
          // its own short-lived texture; dispatched in handler order
          // by params.lutIndex. Released after evaluateGraph below.
          const ctLUTs = [];
          for (const n of graph.nodes) {
            if (n.type !== 'feComponentTransfer') { ctLUTs.push(null); continue; }
            const bytes = n.params && n.params.lutBytes;
            if (!bytes) { ctLUTs.push(null); continue; }
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 4, 0,
                          gl.RGBA, gl.UNSIGNED_BYTE,
                          ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            n.params.lutIndex = ctLUTs.length;
            ctLUTs.push(tex);
          }
          ctx.componentTransferLUTs = ctLUTs;
          // Same as the COLR branch — pause the user scissor across the
          // filter-graph dispatch; the post-eval bindFb(FRAMEBUFFER, null)
          // below restores it for the composite-back step.
          if (_scissor) gl.disable(gl.SCISSOR_TEST);
          // Restrict each full-canvas pass to its propagated output bbox
          // (the device-pixel region where it can be non-zero), so a small
          // filtered shape on a large canvas skips out-of-bbox fragment
          // work. null = no safe bound (region-filling generator) → full
          // canvas, current behavior.
          const rootRT = evaluateGraph(gl, graph, _rtPool, _svgDispatch, ctx, cw, ch, _fRects);
          _filterEvalCount++;
          // Release per-eval LUT textures.
          for (const tex of ctLUTs) { if (tex) gl.deleteTexture(tex); }
          // Tier-2b: retain the output only when the hit gate can later use
          // it. Backdrop-dependent and per-draw-dependent graphs are live by
          // definition; copying their transient root into a persistent cache
          // texture every frame only adds an allocation and a full blit.
          if (_filterCacheable) {
            R._storeFilteredTex(fCacheId, rootRT.tex, cw, ch, fKey, rootRT.rect || null);
          }
          // Composite the graph's root output back to the target (main FB,
          // or the group accumulator when in a group). Normal src-over
          // against the existing backdrop — the graph is expected to emit
          // premultiplied RGBA per CSS Filter Effects §11.
          R._compositeFilteredTex(rootRT.tex, fBackdrop, cw, ch, fDst, rootRT.rect || null, fBackdropRect);
          // The root is ours until here; give it back or the pool allocates a fresh
          // one for the next evaluation, every frame, forever.
          releaseRoot(_rtPool, rootRT);
          _handle.fillPassAssetDirty = true;
          continue;
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
          flushPending();
          R.endFillPass();
          // The filter kernels (blurShapeFbo & co.) filter a target in place —
          // inside a group, that target is the canvas-sized shapeFbo (which IS the
          // group accumulator), so stash the group's content in groupBackdropTex
          // first, run the kernels, then restore + composite back into shapeFbo
          // below. mainCopyTex must stay untouched (it holds groupEnd's snapshot).
          const inGrpK = groupStack.length > 0;
          // px/em must be known BEFORE the source render now: the kernel's reach in
          // canvas pixels is what decides how big the target has to be.
          const px = R._filterPxPerEm(cw, ch);
          const pxPerEmX = px[0], pxPerEmY = px[1];
          // Outside a group the shape can render into an RT covering only itself,
          // dilated by the kernel's reach — no canvas-sized anything.
          const skRect = inGrpK
            ? null : R._filterSingleKindRect(op.shapeIdx | 0, cw, ch, f, pxPerEmX, pxPerEmY);
          let kTarget = null, kBackdropTex = null;
          if (inGrpK) {
            ensureShapeFbo();
            ensureMainCopyTex();
            ensurePingFbo();
            ensureGroupBackdropTex();
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
            bindFb(gl.FRAMEBUFFER, shapeFbo);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          } else if (skRect) {
            const sRT = acquireShapeRT(skRect[2], skRect[3]);
            const pRT = acquirePingRT(skRect[2], skRect[3]);
            kTarget = { fbo: sRT.fbo, tex: sRT.tex, pingFbo: pRT.fbo, pingTex: pRT.tex,
                        w: skRect[2], h: skRect[3] };
            kBackdropTex = snapshotBackdrop(skRect, cw, ch).tex;
          } else {
            ensureShapeFbo();
            ensureMainCopyTex();
            // Snapshot main FB so the composite pass sees the backdrop.
            // Use an otherwise-unused texture unit so we don't clobber
            // a binding that beginFillPass will sample again.
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          }
          // Force a full asset rebind on the upcoming fill pass so the
          // textures we shuffled (mainCopyTex on a high unit) don't leak
          // through.
          _handle.fillPassAssetDirty = true;
          const drawTarget = kTarget ? kTarget.fbo : shapeFbo;
          // Tier-2b single-kind filter cache (the COMMON blur path). The
          // filtered shapeFboTex is a pure function of (feeding shape
          // geometry+overrides, worldMatrix → pxPerEm, canvas). Cache it,
          // keyed like the graph path. On a hit, restore those FBO
          // textures and skip the source render + the (expensive,
          // multi-pass) blur — the kind-specific composite below runs
          // unchanged. Keyed per (filterId, shapeIdx) so two shapes
          // sharing a filter id each get their own cached output.
          const skId = 'k' + _handle._filterCacheOwner + '_'
            + op.filterId + '_' + (op.shapeIdx | 0);
          const skKey = {
            gen: _handle.generation,
            geomGen: _handle.bundle ? (_handle.bundle._geomGen | 0) : 0,
            morphT: (_handle.bundle && _handle.bundle._morphSrc) ? _handle.bundle._morphSrc.t : 0,
            cw, ch,
            wmHash: R._wmHash(_ds.worldM),
            shapeGen: (_ds.overrides && _ds.overrides.shapeGenOf)
              ? _ds.overrides.shapeGenOf(op.shapeIdx | 0) : 0,
            recolor: R._recolorHash(),
          };
          // The cached texture is the FILTERED shape, so it is the size of the target
          // it was filtered in — the kernel's rect, not the canvas.
          const skW = skRect ? skRect[2] : cw, skH = skRect ? skRect[3] : ch;
          let skEntry = _getFilterCache(skId);
          const skHit = !_ds.palette && !_ds.extClipTex && !_ds.shapeRange && !_handle.bundle.maskMesh
            && R._filterKeyMatches(skEntry, skKey)
            && skEntry.shapeTex && skEntry.w === skW && skEntry.h === skH;
          if (skHit) {
            if (inGrpK) {
              // Don't blit into shapeFbo (the group accumulator) —
              // composite the cached filtered tex straight into it.
              R._filterSingleKindComposite(f, cw, ch, skEntry.shapeTex, groupBackdropTex, shapeFbo);
            } else if (skRect) {
              // Straight from the cache to the canvas: no blit through a scratch RT,
              // and only the shape's own rect is touched.
              R._filterSingleKindComposite(f, cw, ch, skEntry.shapeTex, kBackdropTex, null,
                                           skRect, skRect);
            } else {
              // Backdrop already snapshotted at branch entry — the old
              // second copy here was a wasted full-canvas GPU copy on
              // the steady-state hit path.
              R._blitTexToFbo(skEntry.shapeTex, shapeFbo, cw, ch);
              R._filterSingleKindComposite(f, cw, ch);
            }
            _handle.fillPassAssetDirty = true;
            continue;
          }
          bindFb(gl.FRAMEBUFFER, drawTarget);
          // Same translated projection as the graph route (see acquireShapeRT):
          // the viewport sits at -rect.origin and the fill shader is told where its
          // framebuffer is, so its canvas-space samples stay canvas-space.
          if (skRect) { gl.viewport(-skRect[0], -skRect[1], cw, ch); R._fragOrigin = skRect; }
          else gl.viewport(0, 0, cw, ch);
          gl.depthMask(true); gl.stencilMask(0xff);
          gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          R.beginFillPass();
          _drawCoverChunk(op.chunk);
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
          // For non-uniform / sheared / rotated matrices we use the
          // per-axis Frobenius scale (√(a²+b²) / √(c²+d²)), which
          // gives the right answer for uniform scale and a sensible
          // approximation otherwise.
          if (f.kind === 1) {
            // feGaussianBlur — blur the target in place.
            R.blurShapeFbo(f.sigmaX * pxPerEmX, f.sigmaY * pxPerEmY, kTarget);
          } else if (f.kind === 5) {
            // feMorphology — erode (0) / dilate (1) with per-axis radii.
            const operator = f.tintR | 0;
            R.morphShapeFbo(operator,
                          f.sigmaX * pxPerEmX,
                          f.sigmaY * pxPerEmY, kTarget);
          } else if (f.kind === 6) {
            // feConvolveMatrix — single-pass 2D convolution.
            R.convolveShapeFbo(f, kTarget);
          }
          // Tier-2b: store the post-filter shapeFboTex into the persistent
          // per-(filterId,shape) cache so a static re-render skips the
          // source render + filter next frame.
          if (!skEntry) { skEntry = { w: 0, h: 0, key: null }; _setFilterCache(skId, skEntry); }
          R._ensureCacheTex(skEntry, 'shapeTex', skW, skH);
          skEntry.w = skW; skEntry.h = skH;
          R._blitTexToFbo(kTarget ? kTarget.tex : shapeFboTex, skEntry.shapeTexFbo, skW, skH);
          skEntry.key = skKey;
          _filterEvalCount++;
          if (inGrpK) {
            // The filtered output sits in shapeFbo, which must go back to
            // being the group accumulator. Move the output aside (a
            // composite can't sample shapeFboTex while writing shapeFbo —
            // feedback loop), restore the group content, then composite
            // the filtered shape into it.
            bindFb(gl.FRAMEBUFFER, shapeFbo);
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, pingTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
            R._blitTexToFbo(groupBackdropTex, shapeFbo, cw, ch);
            R._filterSingleKindComposite(f, cw, ch, pingTex, groupBackdropTex, shapeFbo);
          } else if (skRect) {
            R._filterSingleKindComposite(f, cw, ch, kTarget.tex, kBackdropTex, null,
                                         skRect, skRect);
          } else {
            // Composite back to main FB.
            R._filterSingleKindComposite(f, cw, ch);
          }
          _handle.fillPassAssetDirty = true;
          continue;
        }
      }
      // Per-leaf mix-blend-mode requires an offscreen route: draw the
      // shape alone into shapeFbo, then composite with the requested
      // blend mode against the main FB. Group-flatten for blend
      // modes 1-15 (CSS Compositing & Blending §6).
      if (op.blendMode) {
        flushPending();
        R.endFillPass();
        ensureShapeFbo();
        ensureMainCopyTex();
        // When inside an isolated group, the per-shape blend modes
        // composite within the group's local backdrop, NOT the canvas.
        // The group's accumulator IS shapeFbo, so for an in-group blend
        // shape we use pingFbo as the single-shape isolated RT, and use
        // shapeFboTex as the "backdrop" sampled by the compositor. The
        // composited result then writes BACK into shapeFbo (the group's
        // accumulator) instead of the canvas.
        //
        // Out-of-group blend shapes use the original path: shapeFbo as
        // the isolated RT, mainCopyTex (canvas snapshot) as backdrop,
        // canvas as final target.
        const inGroup = groupStack.length > 0;
        // This shape's own rect. A blended leaf paid FOUR full-canvas operations — snapshot
        // the backdrop, clear the isolated RT, render, composite it back — and only the
        // render was ever bounded (by the shape's cover quad). The other three covered the
        // screen for a shape that might be a badge in a corner. Same fix as the group and
        // the cache blit: bound them by what the shape actually paints.
        // null = could not bound it → full canvas, as before.
        const bRect = mantleDebugFlag('noGroupRect')
          ? null : R._contentRectPx(cw, ch, [op]);
        let isolatedFbo, isolatedTex, backdropTex, dstFbo;
        if (inGroup) {
          // The group's accumulator IS shapeFbo, so we can't reuse it
          // as the single-shape RT (would clobber accumulated content).
          // Path:
          //   1. snapshot shapeFbo → groupBackdropTex (group's local backdrop)
          //   2. render this shape into pingFbo
          //   3. composite ping over groupBackdropTex into shapeFbo
          //
          // groupBackdropTex is SEPARATE from mainCopyTex so the
          // canvas-snapshot captured at groupBegin survives until
          // groupEnd composes it back. groupBackdropTex is sampled,
          // not the live shapeFbo — avoids the WebGL feedback loop of
          // reading + writing one FBO.
          ensurePingFbo();
          ensureGroupBackdropTex();
          gl.activeTexture(gl.TEXTURE15);
          gl.bindTexture(gl.TEXTURE_2D, groupBackdropTex);
          // copyTexSubImage2D reads from the currently-bound framebuffer.
          // Bind shapeFbo (the group's accumulator) so the snapshot
          // captures the in-progress group content.
          bindFb(gl.FRAMEBUFFER, shapeFbo);
          if (bRect) gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, bRect[0], bRect[1],
                                          bRect[0], bRect[1], bRect[2], bRect[3]);
          else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          isolatedFbo = pingFbo;
          isolatedTex = pingTex;
          backdropTex = groupBackdropTex;
          dstFbo      = shapeFbo;
        } else {
          gl.activeTexture(gl.TEXTURE15);
          gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
          if (bRect) gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, bRect[0], bRect[1],
                                          bRect[0], bRect[1], bRect[2], bRect[3]);
          else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          isolatedFbo = shapeFbo;
          isolatedTex = shapeFboTex;
          backdropTex = mainCopyTex;
          dstFbo      = null;  // canvas
        }
        _handle.fillPassAssetDirty = true;
        bindFb(gl.FRAMEBUFFER, isolatedFbo);
        gl.viewport(0, 0, cw, ch);
        gl.depthMask(true); gl.stencilMask(0xff);
        gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
        // Clear only the rect. The shape rasterizes inside its cover quad, which is inside
        // the rect, so stale colour/depth/stencil outside it is never read or written.
        if (bRect) { gl.enable(gl.SCISSOR_TEST); gl.scissor(bRect[0], bRect[1], bRect[2], bRect[3]); }
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (bRect) gl.disable(gl.SCISSOR_TEST);   // bindFb had it off for this offscreen target
        gl.depthMask(false);
        R.beginFillPass();
        _drawCoverChunk(op.chunk);
        R.endFillPass();
        bindFb(gl.FRAMEBUFFER, dstFbo);
        if (bRect) gl.viewport(bRect[0], bRect[1], bRect[2], bRect[3]);
        else gl.viewport(0, 0, cw, ch);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ZERO);  // composite shader emits the
                                         // final composited result.
        gl.useProgram(R.compProg);
        // vUV spans the rect; both inputs are canvas-sized, so map it back to them.
        if (bRect) {
          const m = [bRect[2] / cw, bRect[3] / ch, bRect[0] / cw, bRect[1] / ch];
          if (compUShapeMap) gl.uniform4f(compUShapeMap, m[0], m[1], m[2], m[3]);
          if (compUDstMap)   gl.uniform4f(compUDstMap,   m[0], m[1], m[2], m[3]);
        } else {
          COMP_IDENTITY_MAP();
        }
        R._fpUValid = false;
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, isolatedTex); gl.uniform1i(compUShapeTex, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, backdropTex); gl.uniform1i(compUDstTex, 1);
        gl.uniform1i(compUBlendMode, op.blendMode | 0);
        gl.uniform1f(compUOpacity, 1);
        gl.bindVertexArray(coverVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        _handle.fillPassAssetDirty = true;
        continue;
      }
      const cs = _coverChunkStart(op.chunk), cc = op.chunk.count | 0;
      if (cs < 0 || cc <= 0) continue;
      if (_pendingStart < 0) {
        _pendingStart = cs;
        _pendingEnd   = cs + cc;
      } else if (cs === _pendingEnd) {
        _pendingEnd += cc;
      } else {
        flushPending();
        _pendingStart = cs;
        _pendingEnd   = cs + cc;
      }
    }
    flushPending();
    while (groupStack.length) {
      groupStack.pop();
      bindFb(gl.FRAMEBUFFER, null);
    }
    R.endFillPass();
    gl.bindVertexArray(null);
    R._opaquePrepassActive = false;

    R._drawDebugOverlays(_handle.bundle, false);
  }

  // Both analytic routes call the shared overlay hook with the mesh they served.
  R._drawDebugOverlays = function (b, lbServed) {
    if (!b) return;
    if (rendererState.showTriOutline) withOverlayState(() => renderTriOutlineOverlay(b, lbServed));
    if (rendererState.showBBoxes)     withOverlayState(() => renderBBoxOverlay(b));
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
    gl.useProgram(R.solidProg);
    gl.uniform4f(solidUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
    const [sx, sy] = arScale(b.globalBBox, cw, ch);
    gl.uniform2f(solidUAR, sx, sy);
    gl.bindVertexArray(solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
    const triPts = _triOverlayPts;
    for (const m of b._lbMeshes) {
      const v = m && m.verts;
      if (!v) continue;
      for (let t = 0; t + 3 <= m.vertexCount; t += 3) {
        const base = t * LB_VERT_FLOATS;
        // aFlags.x is kind + a fractional blend bit — floor it off.
        const kind = Math.floor(v[base + 5] + 1e-4);
        triPts[0] = v[base];
        triPts[1] = v[base + 1];
        triPts[2] = v[base + LB_VERT_FLOATS];
        triPts[3] = v[base + LB_VERT_FLOATS + 1];
        triPts[4] = v[base + LB_VERT_FLOATS * 2];
        triPts[5] = v[base + LB_VERT_FLOATS * 2 + 1];
        if (kind === 0)                                 gl.uniform4f(solidUColor, 1.0, 0.82, 0.0, 0.9);  // interior
        else if (kind === 10 || kind === 12)
                                                        gl.uniform4f(solidUColor, 0.1, 0.7, 1.0, 0.9);   // AA bands
        else                                            gl.uniform4f(solidUColor, 1.0, 0.15, 0.15, 0.9); // curve pieces
        gl.bufferData(gl.ARRAY_BUFFER, triPts, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINE_LOOP, 0, 3);
      }
    }
    gl.bindVertexArray(null);
  }

  // The overlay is a plain LINE_LOOP pass and owns no state, so it inherits whatever the fill
  // left behind. LB leaves the DEPTH test on (its per-shape depth claim), which rejects every
  // overlay line at z=0 — the overlay silently drew nothing under LB. Neutralise the tests,
  // then put them back for whatever the caller does next.
  function withOverlayState(fn) {
    const depth = gl.isEnabled(gl.DEPTH_TEST), stencil = gl.isEnabled(gl.STENCIL_TEST);
    const cm = gl.getParameter(gl.COLOR_WRITEMASK);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    try { fn(); }
    finally {
      if (depth) gl.enable(gl.DEPTH_TEST);
      if (stencil) gl.enable(gl.STENCIL_TEST);
      gl.colorMask(cm[0], cm[1], cm[2], cm[3]);
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
    gl.useProgram(R.solidProg);
    gl.uniform4f(solidUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
    const [sx, sy] = arScale(b.globalBBox, cw, ch);
    gl.uniform2f(solidUAR, sx, sy);
    gl.bindVertexArray(solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
    const triPts = _triOverlayPts;
    const meshFloats = b.coverQuadFloats;
    for (let ci = 0; ci < b.coverQuadChunks.length; ci++) {
      const ch0 = b.coverQuadChunks[ci];
      const v0 = ch0.start, vn = ch0.count;
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
        else             gl.uniform4f(solidUColor, 1.0, 0.82, 0.0, 0.9);
        gl.bufferData(gl.ARRAY_BUFFER, triPts, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINE_LOOP, 0, 3);
      }
    }
    gl.bindVertexArray(null);
  }
  function renderBBoxOverlay(b) {
    if (!b || !b.metaFloats || !b.numShapes) return;
    const [cw, ch] = viewportSize();
    gl.useProgram(R.solidProg);
    gl.uniform4f(solidUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
    const [sx, sy] = arScale(b.globalBBox, cw, ch);
    gl.uniform2f(solidUAR, sx, sy);
    gl.uniform4f(solidUColor, 0.78, 0.38, 0.02, 0.95);
    gl.bindVertexArray(solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, solidBuf);
    const bbPts = _bboxOverlayPts;
    const stride = b.metaFloatsPerShape;
    for (let si = 0; si < b.numShapes; si++) {
      const o = si * stride;
      const x0 = b.metaFloats[o + 0], y0 = b.metaFloats[o + 1];
      const x1 = b.metaFloats[o + 2], y1 = b.metaFloats[o + 3];
      bbPts[0] = x0; bbPts[1] = y0;
      bbPts[2] = x1; bbPts[3] = y0;
      bbPts[4] = x1; bbPts[5] = y1;
      bbPts[6] = x0; bbPts[7] = y1;
      gl.bufferData(gl.ARRAY_BUFFER, bbPts, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINE_LOOP, 0, 4);
    }
    gl.bindVertexArray(null);
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
   *  @param {boolean} [exportOpts.detail]  return the full report object
   *         ({ svg, drawn, skipped, notes }) instead of just the string
   *  @returns {Promise<string|{svg:string,drawn:number,skipped:number,notes:string[]}>}
   */
  async function exportFrameSVG(exportOpts = {}) {
    if (!_captureFrames)
      throw new Error('exportFrameSVG: frame capture is disabled — call '
        + 'R.setFrameCapture(true) before the frame you want to export.');
    const { exportFrameToSvg } = await import('../fallback/frameExport.js');
    const report = exportFrameToSvg({
      frameLog: _frameLog,
      viewport: exportOpts.viewport || viewportSize().slice(),  // .slice(): viewportSize returns shared scratch
      clearColor: _lastFrameClearColor,
      document: exportOpts.document,
      coordinateSpace: exportOpts.coordinateSpace || 'viewport',
      serialize: exportOpts.serialize,
      recoverText: !!exportOpts.recoverText,
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
      const key = (bundle.numShapes | 0) + '|'
        + (bb ? `${Math.round(bb[0])},${Math.round(bb[1])},${Math.round(bb[2])},${Math.round(bb[3])}` : '-')
        + '|' + (served ? 'LB' : 'SLUG')
        + '|entry' + (opts && opts.bare ? 'bare' : (opts && opts.streamOnly ? 'handle' : 'instanced'))
        + '|baking' + (R._cacheBakingNow ? 1 : 0);
      diagNoteEngine(key);
    }
    return served;
  }
  // Would the analytic (LB) route serve this bundle RIGHT NOW? A predicate over
  // the SAME gates _analyticRoute applies, with no side effects.
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
    const off = mantleDebugFlag('noOcclusionCull');
    const b = _handle && _handle.bundle;
    if (!b || !b.drawListUnculled) return;
    if (off && b.drawList !== b.drawListUnculled) {
      b._drawListCulled = b.drawList;
      b.drawList = b.drawListUnculled;
      b._cullGen = (b._cullGen | 0) + 1;
      b._lbCombined = null;
    } else if (!off && b._drawListCulled && b.drawList === b.drawListUnculled) {
      b.drawList = b._drawListCulled;
      b._cullGen = (b._cullGen | 0) + 1;
      b._lbCombined = null;
    }
  }
  R._cullSwitchTick = _cullSwitchTick;

  function _lbWouldServe(bundle) {
    if (!bundle || R._lbFillMode === 'off' || mantleDebugFlag('forceSlug')) return false;
    if (bundle._morphSrc || bundle._incStroke) return false;
    if (bundle._geomGen && !bundle._lbStream) return false;
    // Keep this in step with _analyticRouteImpl's veto: a sprite-subset draw is Slug-only
    // (the combined VBO spans every shape), and _lbOverInstanced consults this to decide
    // whether to divert drawBundleInstanced off its fast path.
    if (_ds.shapeRange && _ds.spriteNonContig) return false;
    if (_ds.extClipTex || _canvasUnsized()) return false;
    if (R._requestLbBuild) R._requestLbBuild(bundle);
    if (!Array.isArray(bundle._lbMeshes) || !bundle._lbMeshes.length) return false;
    if ((bundle._lbGen | 0) !== (bundle._geomGen | 0)) return false;
    if (R._preferNoAa && R._preferNoAa(bundle)) return false;
    if (R._lbFillMode === 'auto' && !(R._staticPerfOk(bundle) && R._lbSizeOk(bundle))) return false;
    return true;
  }
  function _analyticRouteImpl(bundle, opts) {
    if (!bundle) return false;
    // Dynamic incremental stroke (paint tool): a bundle-like flagged
    // `_incStroke` draws through its own GPU-resident stroke-coverage path
    // (incrementalStroke.js) from EVERY entry point. It carries no Slug
    // geometry, so this branch always handles it (returns true).
    if (bundle._incStroke) return R._drawIncrementalStroke(bundle);
    const bare = !!(opts && opts.bare);
    const streamOnly = !!(opts && opts.streamOnly);
    // GPU-resident morph route: a dynamic MORPH handle (createShapeMorph marks
    // it with _morphSrc). drawBundle-only (a handle, so !bare).
    if (!streamOnly && !bare && R._lbFillMode !== 'off' && bundle._morphSrc
        && (!_ds.overrides || (R._lbOvrColorOnly && R._lbOvrColorOnly(_ds.overrides))) && !_ds.colorMatrix && !_ds.palette
        && !_ds.channelLerp && !_ds.extClipTex && !_canvasUnsized()) {
      if (R._drawBundleMorphRoute(bundle)) return true;
    }
    // Not routed but marked → resume CPU lerp+upload in setT.
    if (bundle._morphSrc) bundle._morphSrc.skipUploads = false;
    // Static analytic route: any static bundle (not a morph, not mid-stream
    // geometry) through ANY entry point — bare drawBundle, handle.draw, and
    // instanced (the `bare`/`streamOnly` context no longer gates it; the static
    // LB route builds its OWN route VBO, independent of the handle's cover-quad
    // VBO). One exception: when the active handle owns a static-scene cache, we
    // leave it to render()'s cache path — a baked-RT blit already beats re-running
    // LB per frame, so routing LB there would defeat the cache.
    //
    // Streaming has two bundle states, split HERE:
    //   • _lbStream (lightweight LB stream): built without Slug cover-quads, so it
    //     has no draw-time Slug fallback — it MUST route the analytic path. Its
    //     "fallback" is at STREAM time: streamGeometryLightweight declines (arc /
    //     loop-cusp / stroke-clip-mask-dash) → updateBundleGeometry does the full
    //     Slug rebuild instead, which clears _lbStream (see next bullet).
    //   • _geomGen>0, !_lbStream (the Slug streaming fallback): the full rebuild
    //     regenerated cover-quads, so `!bundle._geomGen` below keeps it on Slug —
    //     which is correct, it fell back precisely because LB couldn't serve it.
    const lbStreamed = !!bundle._lbStream;
    // Cached handles route LB like everything else: the bake's re-entrant render
    // reaches here with the cache FBO as the redirect target (bindFb), and forcing
    // Slug instead rendered BLANK for bundles that carry no Slug cover-quads
    // (lightweight builds) — the "enable WholeAsset and components disappear" report.
    // The capture also matches live frames exactly when both are LB.
    const wantStatic = R._lbFillMode !== 'off' && !mantleDebugFlag('forceSlug') && !bundle._geomGen && !bundle._morphSrc;
    if (wantStatic && R._requestLbBuild) R._requestLbBuild(bundle);
    // Prefer the cheaper no-AA route when an opaque stroke hides the fill edge.
    // Morph and streamed geometry remain on LB, and the draw-time gate retains LB
    // for small shapes or strokes that are too thin in device space.
    if (wantStatic && R._preferNoAa && R._preferNoAa(bundle)) return false;
    // 'auto' perf gate (shared by static + streamed; stub → always route). A
    // published _lbStream bundle ignores the veto: it has no draw-time Slug
    // fallback, so routing anyway beats rendering blank (its perf decision was
    // already made at stream time).
    if ((wantStatic || lbStreamed)
        // 'auto' vetoes unsupported/expensive features and rejects dense meshes or
        // excessive device-space coverage per segment.
        && !(R._lbFillMode === 'auto' && !(R._staticPerfOk(bundle) && R._lbSizeOk(bundle)) && !lbStreamed)
        // Override recolor (fill/tint/visibility — fog) is baked by the route.
        // A per-shape TRANSFORM override on a shape that has Slug geometry falls
        // back to Slug per-shape (which applies the transform); on a lightweight
        // streamed bundle (no Slug geometry) it's unsupported (the road uses fog
        // only). Both static and streamed route — _drawBundleLB handles the mix.
        // Per-draw recolor (colorMatrix/palette/channelLerp) composes via the
        // analytic composite path (_drawBundleLB rejects gradient/image bundles
        // under recolor and forces all shapes through it). ext-clip is still
        // stripped from the variant → keep it on Slug.
        // SPRITE SUBSET: the combined VBO now carries a per-shape vertex span so the draw can be
        // sliced to the sprite (morphDraw _ensureLbCombined + the drawArrays there). Before that,
        // the analytic route ignored _ds.shapeRange entirely and painted the ENTIRE SHEET on any
        // drawSprite — and cost O(bundleShapes) per call (64 sprites = 15ms/frame). The
        // NON-CONTIGUOUS case (a pattern/clip child interleaved, bundle.spriteRangesNonContiguous)
        // breaks the contiguous-slice assumption, so it stays on Slug.
        && !(_ds.shapeRange && _ds.spriteNonContig)
        && !_ds.extClipTex && !_canvasUnsized()) {
      // _drawBundleLB classifies the feature set (solid → combined route;
      // gradient/image → per-shape) and checks eligibility with the right
      // allow* flags. Returns false (→ Slug) for anything it can't serve.
      return R._drawBundleLB(bundle);
    }
    return false;
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

  function dispose() {
    // UNREGISTER THE LB HOOKS. They live in a module-level registry (every renderer adds one), and
    // a disposed renderer's closure captures a dead GL context — leaving it registered means the
    // next bundle created hands its Loop-Blinn build to a renderer that no longer exists.
    try {
      removeLbBuilder(R._lbBuilderFn);
      removeLbPreparer(R._lbPreparerFn);
    } catch { /* not registered */ }
    // Per-handle resources are owned by the bounded bare-draw handle LRU or
    // by caller-created handles. Dispose every internal resident handle here.
    for (const p of [
      R.fillProg, R.solidProg, R.compProg, R.blurProg, R.boxBlurProg, R.morphProg,
      R.convolveProg, R.colorMatrixProg, R.feCompositeProg, R.feBlendProg,
      R.feTileProg, R.feTurbulenceProg, R.feDisplacementMapProg, R.feLightingProg,
      R.feComponentTransferProg, R.feImageProg,
      R.paintLinearGradProg, R.paintRadialGradProg, R.paintSweepGradProg,
      R.paintTransformProg, R.paintGlyphProg, R.paintCompositeProg,
      R.maskBakeProg, R.cacheBlitProg, R.drawImageProg, R.drawImageInstProg,
      R.lbProg, R.lbProgLean, R.lbCompProg, R.morphStrokeProg, R.lbPairProg,
    ]) {
      if (p) gl.deleteProgram(p);
    }
    if (R._disposeInstProgs) R._disposeInstProgs();
    if (R._disposeFillVariants) R._disposeFillVariants();
    if (R.disposeOpaquePrepass) R.disposeOpaquePrepass();
    if (R._disposeLbCovPrograms) R._disposeLbCovPrograms();
    if (R._clearLbCaches) R._clearLbCaches();
    for (const v of [solidVao, coverVao, R._instVao]) if (v) gl.deleteVertexArray(v);
    for (const b of [solidBuf, coverBuf, R._instBuf, R._instAttrBuf]) if (b) gl.deleteBuffer(b);
    if (R._disposeInstCompacts) R._disposeInstCompacts();
    // Per-handle GL resources (triVao, triBuf, shapeIdxBuf,
    // maskRowToLayerTex) are owned by the handle and freed by its
    // dispose(); the renderer-owned dummies are released here. The mask
    // RT arrays + bake VAO/FBOs are owned by maskBake.js.
    R._disposeMaskBake();
    for (const t of [dummyGradientTex, dummyGradientStops, dummyDashTex,
                     shapeFboTex, mainCopyTex, groupBackdropTex, pingTex]) {
      if (t) gl.deleteTexture(t);
    }
    _rtPool.invalidate();
    _covPool.invalidate();
    // The filtered-shape targets are canvas-relative too — a resize moves every rect.
    for (const e of _shapeRtCache.values()) {
      gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fbo); gl.deleteRenderbuffer(e.rb);
    }
    _shapeRtCache.clear();
    for (const e of _backdropCache.values()) {
      gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fbo);
    }
    _backdropCache.clear();
    for (const e of _pingRtCache.values()) {
      gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fbo);
    }
    _pingRtCache.clear();
    if (shapeFbo) gl.deleteFramebuffer(shapeFbo);
    if (pingFbo)  gl.deleteFramebuffer(pingFbo);
    if (shapeFboRb) gl.deleteRenderbuffer(shapeFboRb);
    // Tier-2b filter result cache (graph-path tex/fbo + single-kind
    // shapeTex + their FBOs).
    for (const c of _filterCache.values()) {
      for (const t of [c.tex, c.shapeTex]) if (t) gl.deleteTexture(t);
      for (const fb of [c.fbo, c.shapeTexFbo]) if (fb) gl.deleteFramebuffer(fb);
    }
    _filterCache.clear();
    // feConvolveMatrix lazily caches its kernel texture on the persistent
    // bundle graph node (params._kTex). Nothing else frees it on teardown,
    // so walk the graphs and delete any here.
    const _bundlesToDispose = new Set();
    if (_handle && _handle.bundle) _bundlesToDispose.add(_handle.bundle);
    for (const h of _transientHandles.values()) if (h.bundle) _bundlesToDispose.add(h.bundle);
    for (const b of _bundlesToDispose) {
      const _fgs = b.filterGraphs;
      if (!_fgs) continue;
      for (const g of _fgs) {
        if (!g || !g.nodes) continue;
        for (const n of g.nodes) {
          if (n && n.params && n.params._kTex) {
            gl.deleteTexture(n.params._kTex);
            n.params._kTex = null;
          }
        }
      }
    }
    // External-clip resources (clipDraw.js): the renderClipCoverage FBO, its
    // persistent clip handle, and every per-bundle node-clip coverage texture.
    R._disposeNodeClips();
    if (_handle && !_isTransientHandle(_handle)) _handle.dispose();
    _handle = null;
    _disposeTransientHandles();
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
    if (shapeFbo)  n += cw * ch * 4;  // RGBA8 → 4 bpt
    if (mainCopyTex) n += cw * ch * 4;
    if (pingTex)   n += cw * ch * 4;
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
      if (b.bandFloats  && b.bandFloats.byteLength)  n += b.bandFloats.byteLength;
      if (b.metaFloats  && b.metaFloats.byteLength)  n += b.metaFloats.byteLength;
      if (b.imageAtlasTex && b.imageAtlasSize)
        n += (b.imageAtlasSize[0] | 0) * (b.imageAtlasSize[1] | 0) * 4;
      if (b.gradientStopsBytes) n += b.gradientStopsBytes.length;
    }
    return n;
  }

  // Drop every cached offscreen target + its size-tracker so the next
  // ensure*Fbo() rebuilds it against the live context. Used on context
  // restore (handles are dangling post-loss; deleting them would throw
  // or no-op, so we just forget them) and is safe to call any time.
  function _forgetTransientGpuState() {
    shapeFbo = shapeFboTex = shapeFboRb = null; shapeFboSize[0] = shapeFboSize[1] = 0;
    mainCopyTex = null;            mainCopySize[0] = mainCopySize[1] = 0;
    groupBackdropTex = null;       groupBackdropSize[0] = groupBackdropSize[1] = 0;
    pingFbo = pingTex = null;      pingSize[0] = pingSize[1] = 0;
    R._forgetMaskBake();   // mask RT arrays + bake FBOs live in maskBake.js
    // External-clip resources are GPU handles too — forget them (post-loss
    // they're dangling; setNodeClip/renderClipCoverage rebuild on next use).
    // The node-clip textures are caller-owned coverage RTs; drop our refs so a
    // stale tex can't be auto-bound into a live draw after restore.
    R._forgetClipState();
    _rtPool.forget();
    _covPool.forget();
  }

  function _onContextLost(e) {
    // preventDefault() is REQUIRED for the browser to later fire
    // webglcontextrestored. Without it, the context stays dead.
    e.preventDefault();
    _contextLost = true;
    // Bundle handles cache per-bundle GL state too — mark the active
    // one stale so it re-uploads after restore.
    if (_handle && typeof _handle.invalidate === 'function') _handle.invalidate();
    if (opts && typeof opts.onContextLost === 'function') {
      try { opts.onContextLost(e); } catch (err) { /* consumer hook */ }
    }
  }

  function _onContextRestored(e) {
    _contextLost = false;
    // Forget dangling resource handles; ensure*Fbo() + bundle re-upload
    // rebuild on the next frame. NOTE: GL programs/uniform locations are
    // captured in closures at createRenderer() time and are NOT rebuilt
    // here — a context that is genuinely lost (not just the startup
    // race) needs the consumer to dispose() + recreate the renderer.
    // The onContextRestored hook is where the consumer does that.
    _forgetTransientGpuState();
    if (opts && typeof opts.onContextRestored === 'function') {
      try { opts.onContextRestored(e); } catch (err) { /* consumer hook */ }
    }
  }

  if (_canvas) {
    _canvas.addEventListener('webglcontextlost', _onContextLost, false);
    _canvas.addEventListener('webglcontextrestored', _onContextRestored, false);
  }

  // Wire shared renderer context for extracted draw modules.
  Object.assign(R, {
    setBundle, render,
    // createBundleHandle lives in bundleHandle.js (attachBundleHandle); it
    // destructures these at attach time, so they must be on R first.
    _analyticRoute, _lbWouldServe, computeMaskRegions, _cacheSampleCost,
    viewportSize, bindFb, applyBlendMode, arScale,
    paletteChannelToInt, _renderCanvasInner,
    _canvasUnsized, _covPool, _rtPool, _svgDispatch,
    IDENTITY_COLOR_MATRIX, ZERO_OFFSET,
    dummyGradientTex, dummyGradientStops, dummyDashTex,
    coverVao,
    buildLoopBlinnMesh, buildLoopBlinnCDT, refreshLoopBlinnMesh, packLoopBlinnMesh, curveRangeToContours,
    lbCanonicalFrame, lbCanonicalHash, lbCanonicalHashes, transformLoopBlinnRaw,
    buildMorphStroke, LB_VERT_FLOATS,
    // Filter subsystem lives in filterDraw.js (attachFilterDraw, below) — it
    // attaches filterRecord / _buildFilterCtx / blurShapeFbo / … onto R. These
    // renderer-owned helpers stay here but are shared with it (and the composed
    // MORPH route in morphDraw.js) via R. Per-shape state (shapeFbo/mainCopyTex/
    // pingFbo/…) is exposed as LIVE getters below; _filterCache is a stable Map
    // reference so it rides this Object.assign directly.
    ensureShapeFbo, ensureMainCopyTex, ensurePingFbo, evaluateGraph, releaseRoot, _filterCache,
  });
  attachFilterDraw(R);
  attachMaskBake(R);
  attachFillPass(R);
  attachOpaquePrepass(R);
  attachFrameLoop(R);
  attachDrawDispatch(R);
  attachBundleHandle(R);   // before attachClipDraw — it destructures R.createBundleHandle
  attachClipDraw(R);
  attachIncrementalStroke(R);   // dynamic paint-stroke path (reads R.* at draw time)
  // Live views of the per-shape filter state (reassigned during compositing).
  Object.defineProperty(R, 'shapeFbo',    { get: () => shapeFbo,    configurable: true });
  Object.defineProperty(R, 'shapeFboTex', { get: () => shapeFboTex, configurable: true });
  Object.defineProperty(R, 'mainCopyTex', { get: () => mainCopyTex, configurable: true });
  Object.defineProperty(R, '_scissor',    { get: () => _scissor, set: (v) => { _scissor = v; }, configurable: true });
  // frameLoop.js: setViewport/scissor + the SVG-export recorder set these;
  // viewportSize reads _explicitViewport, exportFrameSVG reads _frameLog/_last.
  Object.defineProperty(R, '_explicitViewport', { get: () => _explicitViewport, set: (v) => { _explicitViewport = v; }, configurable: true });
  Object.defineProperty(R, '_frameLog', { get: () => _frameLog, set: (v) => { _frameLog = v; }, configurable: true });
  Object.defineProperty(R, '_lastFrameClearColor', { get: () => _lastFrameClearColor, set: (v) => { _lastFrameClearColor = v; }, configurable: true });
  // _filterEvalCount is bumped by BOTH render() and the morph route → get/set bridge.
  Object.defineProperty(R, '_filterEvalCount', { get: () => _filterEvalCount, set: (v) => { _filterEvalCount = v; }, configurable: true });
  // Ping RT + filter-scissor flag: live views for filterDraw.js (pingFbo/pingTex
  // are reassigned by ensurePingFbo; _filterBboxEnabled toggled by _setFilterBbox).
  Object.defineProperty(R, 'pingFbo', { get: () => pingFbo, configurable: true });
  Object.defineProperty(R, 'pingTex', { get: () => pingTex, configurable: true });
  Object.defineProperty(R, '_filterBboxEnabled', { get: () => _filterBboxEnabled, configurable: true });
  // clipDraw.js: renderClipCoverage guards on context loss and resets the
  // fill-pass canvas-size cache around its re-entrant offscreen draw.
  Object.defineProperty(R, '_contextLost', { get: () => _contextLost, configurable: true });
  Object.defineProperty(R, 'fillPassCanvasW', { get: () => fillPassCanvasW, set: (v) => { fillPassCanvasW = v; }, configurable: true });
  Object.defineProperty(R, 'fillPassCanvasH', { get: () => fillPassCanvasH, set: (v) => { fillPassCanvasH = v; }, configurable: true });
  // bundleHandle.js: handle.dispose() clears these renderer-owned validity refs.
  Object.defineProperty(R, '_lastFillPassHandle', { get: () => _lastFillPassHandle, set: (v) => { _lastFillPassHandle = v; }, configurable: true });
  Object.defineProperty(R, '_maskBakeValidHandle', { get: () => _maskBakeValidHandle, set: (v) => { _maskBakeValidHandle = v; }, configurable: true });
  Object.defineProperty(R, '_maskBakeValidGen', { get: () => _maskBakeValidGen, set: (v) => { _maskBakeValidGen = v; }, configurable: true });
  Object.defineProperty(R, '_handle', { get: () => _handle, set: (v) => { _handle = v; }, configurable: true });
  R.draw = _ds;   // per-draw state struct (stable ref, mutated in place)
  // Per-shape Slug fallback for the analytic route: render ONE shape (index s) of
  // the active bundle through the Slug fill pass, in painter order, compositing
  // OVER whatever is already on the canvas. The analytic route calls this for a
  // shape Loop-Blinn can't serve (loop/cusp/arc) while the rest stay analytic.
  // Bypasses the static-scene cache (we're mid-draw); _renderCanvasInner clears
  // only depth/stencil while _inFrame (never color), and the analytic draws run
  // depth-disabled, so the already-drawn shapes survive.
  // Render shape s (or the contiguous shape-index range [s, hi]) via the Slug
  // ubershader. A range batches every shape in it into ONE Slug pass — used to
  // paint a run of consecutive LB sentinels (loop/cusp shapes) in a single draw
  // instead of one per shape. Safe only when the index block [s,hi] holds exactly
  // those shapes (the split caller guarantees a gap-free sentinel block).
  R._renderShapeViaSlug = function (bundle, s, hi) {
    if (_contextLost) return false;
    if (_handle && _handle.bundle !== bundle) setBundle(bundle);
    if (!_handle || !_handle.bundle) return false;
    const saved = _ds.shapeRange;
    _ds.shapeRange = [s | 0, (hi == null ? s : hi) | 0];
    try { _renderCanvasInner(); } finally { _ds.shapeRange = saved; }
    return true;
  };
  Object.defineProperty(R, '_inFrame', { get: () => _inFrame, set: (v) => { _inFrame = v; }, configurable: true });
  Object.defineProperty(R, '_captureFrames', { get: () => _captureFrames, set: (v) => { _captureFrames = v; }, configurable: true });
  Object.defineProperty(R, '_instancedFastEnabled', { get: () => _instancedFastEnabled, set: (v) => { _instancedFastEnabled = v; }, configurable: true });

  // Public renderer state object. The factory exposes mutable debug
  // flags here so consumers can toggle them at any time.
  /** @type {import('./rendererApi.js').MantleRendererApi} */
  const built = {
    showTriOutline: false,
    showBBoxes: false,
    setBundle,
    render,
    invalidateRenderState: R.invalidateRenderState,
    markGeometryDirty: R.markGeometryDirty,
    // Internal: toggle filter-pass scissoring (default on). Used by the
    // render-diff smoke to compare scissored vs full-canvas output.
    _setFilterBbox(v) { _filterBboxEnabled = !!v; },
    /** @deprecated the per-node scissor became per-node bbox-sized RTs. */
    _setFilterScissor(v) { _filterBboxEnabled = !!v; },
    // Internal: toggle the drawBundleInstanced GPU fast path (default on).
    // Used by the render-diff smoke to compare it against the loop.
    _setInstancedFast(v) { _instancedFastEnabled = !!v; },
    dispose,
    // WebGL context-loss state. True between webglcontextlost and
    // webglcontextrestored; while true all draw entry points no-op.
    // Consumers that own the canvas/gl should pass opts.onContextLost /
    // opts.onContextRestored to dispose()+recreate on a real loss.
    get isContextLost() { return _contextLost; },
    // Frame lifecycle.
    setViewport: R.setViewport,
    /// Render fewer pixels at the same screen size. Fill cost is linear in backing-store
    /// pixels, so this is a direct dial on frame time. See frameLoop.setResolutionScale.
    setResolutionScale: (s, o) => R.setResolutionScale(s, o),
    get resolutionScale() { return R._resScale; },
    beginFrame: R.beginFrame,
    endFrame: R.endFrame,
    // SVG export — serialize the last rendered frame to an SVG string by
    // replaying its recorded draw list on the native (DOM) backend. Async
    // (loads the native fallback on demand). setFrameCapture toggles the
    // per-frame draw recording it depends on (on by default). See the
    // exportFrameSVG docstring for preconditions/limitations.
    exportFrameSVG,
    setFrameCapture: R.setFrameCapture,
    get frameCaptureEnabled() { return _captureFrames; },
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
    drawBundle: R.drawBundle,
    // Same as drawBundle, but DEFERRED and stacking-ordered: the draw is queued and
    // painted at endFrame() in (zOrder asc, submission asc) order. Lower zOrder paints
    // underneath; equal zOrder keeps submission order. Use when stacking must not depend
    // on the order things happen to mount (async overlays, HUD above gameplay) — it is the
    // JS counterpart to sortingLayerID/sortingOrder on the C# side.
    submitBundle: R.submitBundle,
    // Synchronously build a bundle's Loop-Blinn meshes NOW (on the main thread),
    // instead of waiting for the off-thread worker build to land. The runtime
    // never needs this — the draw path uses ready-LB-or-Slug — but eager callers
    // (scene prewarm) and tests that must assert LB routing deterministically do.
    prepareBundle: R.prepareBundle,
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
        if (!bundle) { resolve(false); return; }
        // A shape-morph handle wraps its drawable bundle (where _morphSrc lives);
        // unwrap so awaitLbReady(morph) waits on the morph-pair build, not a
        // non-existent static mesh.
        if (bundle.bundle && typeof bundle.setT === 'function') bundle = bundle.bundle;
        // Slug-only renderer never builds LB → don't spin until timeout.
        if (R._lbSlugOnly) { resolve(false); return; }
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        // MORPH bundles build their pair meshes off-thread too (a re-target sets a
        // fresh _morphSrc → a fresh build), so readiness is _morphMeshesBuilt, set
        // once the worker (or its sync fallback) lands via _applyMorphResult. The
        // build is normally kicked off by the first draw; the poke below starts it
        // here too, so awaitLbReady resolves even when called before any draw.
        // A settled Slug decision is also finished work, but it is not LB-ready.
        // Resolve it immediately as false instead of spinning until timeout or
        // reporting a successful analytic route.
        const hasRealMeshes = () => bundle._morphSrc
          ? (Array.isArray(bundle._morphMeshes) && bundle._morphMeshes.some((m) => !!m))
          : (Array.isArray(bundle._lbMeshes)
              && bundle._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0));
        const settled = () => {
          if (bundle._morphSrc) return !!bundle._morphMeshesBuilt;
          if (hasRealMeshes()) return true;
          const gen = bundle._geomGen | 0;
          return bundle._lbMeshes !== undefined && (bundle._lbGen | 0) === gen
            && bundle._lbWorkerPendingGen !== gen;
        };
        // The morph build is triggered by the first draw; poke it here so
        // awaitLbReady works without a prior draw (a game may await before drawing).
        if (bundle._morphSrc && !bundle._morphMeshesBuilt && R._ensureBundleMorphMeshes) {
          try { R._ensureBundleMorphMeshes(bundle); } catch { /* draw-time fallback */ }
        } else if (!bundle._morphSrc && R._requestLbBuild) {
          try {
            if (R._requestLbBuild(bundle) === false) { resolve(false); return; }
          } catch { /* remain on coverage fallback */ }
        }
        if (settled()) { resolve(hasRealMeshes()); return; }
        const start = now();
        const tick = () => {
          if (settled()) { resolve(hasRealMeshes()); return; }
          if (now() - start >= timeoutMs) { resolve(false); return; }
          setTimeout(tick, 8);
        };
        setTimeout(tick, 8);
      });
    },
    /// Non-blocking: start linking the fill program this bundle will use. Call at load.
    prewarmBundle: (bundle) => { if (R.prewarmFillVariant) R.prewarmFillVariant(bundle); },
    /// Budget for resident Loop-Blinn mesh memory (bytes). Bundles whose
    /// projected footprint would exceed it render via Slug instead.
    setLoopBlinnMemoryBudget: R.setLoopBlinnMemoryBudget,
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
    createImage,
    drawImage,
    // Additive Loop-Blinn hybrid fill — render one solid-fill shape's mesh
    // (buildLoopBlinnMesh output) via analytic implicit coverage instead of
    // the Slug ray-cast. Resolution-independent, GPU-cheap; the cost-driven
    // alternative to drawBundle's per-fragment fill for qualifying shapes.
    drawLoopBlinnMesh,
    // THE single toggle for the analytic (Loop-Blinn) fill path, governing every
    // route — static bundles (bare drawBundle, handle.draw, instanced), streamed
    // bundles, AND createShapeMorph handles. Mirrors Slug as one fill path with
    // one switch (no separate static/morph flags to drift apart):
    //   'off'         · always use the Slug ray-cast.
    //   'auto' (DEFAULT) · route the paths where LB WINS: GPU morphs, streamed
    //                   bundles, and eligible batched static bundles. Opaque
    //                   gradients/images and translucent solids use the combined
    //                   route; clip/mask/filter/stroke compositions stay on the
    //                   cheaper fill fallback — see _staticPerfOk.
    //   'on'          · additionally force gradient/image/composed static bundles
    //                   through LB (bypass the perf gate); ineligible shapes still
    //                   fall back to Slug.
    //   'only'        · LB ONLY — no Slug fallback. A shape with no ready/eligible
    //                   analytic mesh draws NOTHING (and the static cache won't
    //                   bake an empty frame). For isolating/inspecting the LB path.
    // `true`→'on' (full LB), `false`→'off' (Slug only, LB build skipped).
    setLoopBlinnFill(mode) {
      const m = mode === true ? 'on' : (mode === false || !mode) ? 'off'
        : (mode === 'on' || mode === 'auto' || mode === 'off' || mode === 'only') ? mode : 'off';
      // 'off' = Slug only → also skip the (now-pointless) off-thread LB build.
      R._lbSlugOnly = (m === 'off');
      // 'only' = LB only → suppress the Slug fallback so unbuilt/ineligible shapes
      // draw nothing instead of Slug.
      R._lbSlugFallback = (m !== 'only');
      // 'only' routes like 'on' (force LB); the fallback flag is what makes it LB-only.
      R._lbFillMode = (m === 'only') ? 'on' : m;
    },
    // Back-compat alias: the morph route now shares the single R._lbFillMode, so
    // this just forwards to setLoopBlinnFill. Prefer setLoopBlinnFill.
    setLoopBlinnMorphFill(mode) { this.setLoopBlinnFill(mode); },
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
    createBundleHandle: R.createBundleHandle,
    // Up-front warm of every loaded bundle's fill pipelines. Call behind a LOADING
    // SCREEN (bundles created, before gameplay) for games that start animating
    // immediately and never present an idle window for the background warmer —
    // gameplay then runs on the lean variants with zero mid-play pipeline stalls.
    // Blocking by design. Returns the number of bundles warmed.
    precompileFills: R.precompileFills,
    // Dynamic incremental stroke — the paint-tool fast path. Returns a handle
    // whose appendPoints(pts) tessellates ONLY the new segments (O(1) per
    // point) and whose `.bundle` draws through every entry point (drawBundle /
    // handle.draw / drawInstance) via the shared GPU stroke-coverage pipeline
    // (identical caps/joins/AA to the static analytic stroke route).
    // finalize() freezes it and returns { pathD, svg } for re-hosting.
    createIncrementalStroke: R.createIncrementalStroke,
    // Debug-only memory estimate (bytes).
    gpuMemoryEstimate,
    // Debug-only cache stats. maskBakeCount / filterEvalCount = number
    // of actual mask bakes / filter-graph evals (cache misses).
    get debugStats() {
      return { maskBakeCount: _maskBakeCount, filterEvalCount: _filterEvalCount,
               filterBboxActiveCount: _filterBboxActiveCount,
               // # of drawBundleInstanced calls that took the single
               // drawArraysInstanced GPU fast path (vs the per-instance loop).
               instancedFastCount: R._instFastCount | 0,
               loopBlinnRouteCount: R._lbRouteCount,
               lbAutoPx2PerSeg: R._lbAutoPx2PerSeg || 0,
               lbAutoBytesPerSeg: R._lbAutoBytesPerSeg || 0,
               loopBlinnMorphRouteCount: R._lbMorphRouteCount,
               loopBlinnMorphComposedCount: R._lbMorphComposedCount,
               opaquePrepassCount: R._opaquePrepassCount | 0,
               // aacFill:'auto' — what the selector saw and chose on the last draw.
               variantCompiles: R._variantCompiles || 0,
      variantPolls: R._variantPolls || 0,
      autoMeanShapePx2: R._autoMeanShapePx2 || 0,
      autoSegsPerShape: R._autoSegsPerShape || 0,
      autoPx2PerSeg: R._autoPx2PerSeg || 0,
               autoEngine: R._autoEngine || null,
               recolorDraws: R._recolorDrawCount | 0 };
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
    // (see sharedGroupCacheSmoke). For multi-handle scenes prefer
    // createBundleHandle(b, { staticCache: { strategy: ForceSharedGroup, instanceGroupKey } }).
    setInstanceGroup,
    disableStaticCache,
    invalidateStaticCache,
    /// Diagnostic view of the cache state machine on the renderer's
    /// internal handle. Null until R.enableStaticCache() is called.
    /// For multi-handle scenes, read `handle.staticCache`
    /// on the specific handle instead.
    get staticCache() { return _handle ? _handle.cache : null; },
    };
    // Publish onto the synchronously-returned rendererState. Copy
    // descriptors (not values) so getters like `debugStats` /
    // `staticCache` / `isContextLost` stay live rather than being
    // snapshotted by a plain assign.
    Object.defineProperties(rendererState, Object.getOwnPropertyDescriptors(built));
    _ready = true;
    _resolveReady(rendererState);
  } // end _runInit

  if (_asyncCompile) {
    // Defer the forced-completion work off the main thread. Compile/link
    // errors reject `ready`; we also log for the fire-and-forget case.
    R._whenProgramsComplete()
      .then(() => { _runInit(); })
      .catch((err) => {
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
