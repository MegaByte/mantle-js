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
// `opts` is reserved for future flags (debug overlay toggles).
//
// State ownership:
//   - The renderer instance owns programs, uniform locations, VAOs,
//     attribute buffers, dummy textures, FBOs, and all render-pass
//     scratch state.
//   - The bundle owns asset textures + mesh ArrayBuffers.
//   - The canvas + gl context are owned by the consumer.

import { Constants } from './bundle.js';
import { mantleWarn, mantleError } from '../core/diagnostics.js';
import { buildLoopBlinnMesh, buildLoopBlinnCDT, refreshLoopBlinnMesh, packLoopBlinnMesh, curveRangeToContours, LB_VERT_FLOATS, lbCanonicalFrame, lbCanonicalHash, transformLoopBlinnRaw } from './loopBlinn.js';
import { buildMorphStroke } from './loopBlinnMorph.js';
import { mantleDebugFlag } from '../core/diagnostics.js';
import { createRTPool, evaluateGraph } from '../filterGraph/filterGraph.js';
// Read filter/COLR handlers from the opt-in registry — NOT from a module
// that side-effect-imports every primitive, which would re-link the whole
// filter+COLR shader-handler set into every renderer consumer and defeat
// the registry tree-shaking. The registry is empty by default; the
// consumer's feature imports (or the root barrel's "register all")
// populate it before createRenderer runs. The graph evaluator treats an
// unregistered node type as passthrough, so a partial table is safe.
import { svgFilterDispatch, colrPaintDispatch } from '../filterGraph/dispatchRegistry.js';
import { computeNodeBboxes } from '../filterGraph/bbox.js';
import { createStaticCache, Strategy as CacheStrategy, Level as CacheLevel, Reason as CacheReason, borrowA3GroupRt, releaseA3GroupMember } from './staticCache.js';
import { attachShaderPrograms } from './shaderPrograms.js';
import { attachDrawImages } from './drawImages.js';
import { attachInstancedFill } from './instancedFill.js';
import { attachMorphDraw } from './morphDraw.js';
import { attachDrawSprites } from './drawSprites.js';
import { attachCacheDraw } from './cacheDraw.js';
import { attachFilterDraw } from './filterDraw.js';
import { attachMaskBake } from './maskBake.js';
import { attachFillPass } from './fillPass.js';
import { attachFrameLoop } from './frameLoop.js';
import { attachDrawDispatch } from './drawDispatch.js';
import { attachBundleHandle } from './bundleHandle.js';
import { attachClipDraw } from './clipDraw.js';
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

/// Public factory.
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
  const _khrParallel = _asyncCompile ? gl.getExtension('KHR_parallel_shader_compile') : null;
  const _pendingShaders  = [];
  const _pendingPrograms = [];
  /** @type {import('./rendererContext.js').RendererContext} */
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
  const rendererState = {};
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

  const uCurveLoc       = gl.getUniformLocation(R.fillProg, 'uCurveData');
  const uBandLoc        = gl.getUniformLocation(R.fillProg, 'uBandData');
  const uMetaLoc        = gl.getUniformLocation(R.fillProg, 'uMetaTex');
  const uDashLoc        = gl.getUniformLocation(R.fillProg, 'uDashTex');
  const uGBB            = gl.getUniformLocation(R.fillProg, 'uGlobalBBox');
  const uShapeIdxOverride = gl.getUniformLocation(R.fillProg, 'uShapeIdxOverride');
  const uFillNumShapes  = gl.getUniformLocation(R.fillProg, 'uNumShapes');
  const uFillCanvasAR   = gl.getUniformLocation(R.fillProg, 'uCanvasAR');
  const uFillViewportSize = gl.getUniformLocation(R.fillProg, 'uViewportSize');
  const uFillGradTex    = gl.getUniformLocation(R.fillProg, 'uGradientTex');
  const uFillGradStops      = gl.getUniformLocation(R.fillProg, 'uGradientStops');
  const uFillGradStopsCount = gl.getUniformLocation(R.fillProg, 'uGradientStopsCount');
  const uFillGradCount  = gl.getUniformLocation(R.fillProg, 'uGradientCount');
  const uFillImageTex   = gl.getUniformLocation(R.fillProg, 'uImageTex');
  const uFillImageAtlasSize = gl.getUniformLocation(R.fillProg, 'uImageAtlasSize');
  const uFillFilterTex  = gl.getUniformLocation(R.fillProg, 'uFilterTex');
  // Per-shape override texture + presence flag.
  const uFillOverrideTex   = gl.getUniformLocation(R.fillProg, 'uOverrideTex');
  const uFillHasOverrides  = gl.getUniformLocation(R.fillProg, 'uHasOverrides');
  // 9-slice: when 1, vert shader reads native em from aEmCoord (offset
  // 16, location=2 — the v1.xy slot the importer leaves unused for
  // cover-quad verts). Set by drawBundle when bundle._nineSliceActive.
  const uFillHasEmCoord    = gl.getUniformLocation(R.fillProg, 'uHasEmCoord');
  const uFillDrawAlpha     = gl.getUniformLocation(R.fillProg, 'uDrawAlpha');
  // Dual-tint fill recolor: per-draw
  // 4×4 color matrix + offset applied to vFill (and vStroke) in the
  // fragment shader. Enabled flag is a uniform int, coherent → free
  // when disabled.
  const uFillColorMatrix         = gl.getUniformLocation(R.fillProg, 'uColorMatrix');
  const uFillColorMatrixOffset   = gl.getUniformLocation(R.fillProg, 'uColorMatrixOffset');
  const uFillColorMatrixEnabled  = gl.getUniformLocation(R.fillProg, 'uColorMatrixEnabled');
  // Per-draw external screen-space clip mask (setNodeClip).
  const uFillExtClipTex          = gl.getUniformLocation(R.fillProg, 'uExtClipTex');
  const uFillExtClipMode         = gl.getUniformLocation(R.fillProg, 'uExtClipMode');
  // Per-draw bilinear channel-lerp (channel-lerp recolor formula).
  const uFillChLerpPrimary       = gl.getUniformLocation(R.fillProg, 'uChannelLerpPrimary');
  const uFillChLerpContrast      = gl.getUniformLocation(R.fillProg, 'uChannelLerpContrast');
  const uFillChLerpHighlight     = gl.getUniformLocation(R.fillProg, 'uChannelLerpHighlight');
  const uFillChLerpEnabled       = gl.getUniformLocation(R.fillProg, 'uChannelLerpEnabled');
  // Per-draw palette LUT (companion to colorMatrix; discrete index → RGB).
  const uFillPalette             = gl.getUniformLocation(R.fillProg, 'uPalette');
  const uFillPaletteEnabled      = gl.getUniformLocation(R.fillProg, 'uPaletteEnabled');
  const uFillPaletteChannel      = gl.getUniformLocation(R.fillProg, 'uPaletteChannel');
  const uFillPaletteSize         = gl.getUniformLocation(R.fillProg, 'uPaletteSize');
  // Per-draw world-space 3×3 affine + presence flag.
  const uFillWorldM        = gl.getUniformLocation(R.fillProg, 'uWorldM');
  const uFillHasWorldM     = gl.getUniformLocation(R.fillProg, 'uHasWorldM');
  // Multi-shape mask offscreen RT. uMaskRTArray is
  // a TEXTURE_2D_ARRAY (R8); uMaskRowToLayerTex is a 1×numShapes R32I
  // texture where entry maskId-1 is the array layer (or -1 to fall
  // back to the inline child walk).
  const uFillMaskRTArray       = gl.getUniformLocation(R.fillProg, 'uMaskRTArray');
  const uFillMaskRowToLayerTex = gl.getUniformLocation(R.fillProg, 'uMaskRowToLayerTex');
  const uFillHasOffscreenMask  = gl.getUniformLocation(R.fillProg, 'uHasOffscreenMask');
  const uFillHasOccupancy      = gl.getUniformLocation(R.fillProg, 'uHasOccupancy');

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
  R.cbUTint     = R.cacheBlitProg ? gl.getUniformLocation(R.cacheBlitProg, 'uTint')     : null;
  // R.drawImage uniform locations.
  R.diUTex      = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uTex')      : null;
  R.diUTint     = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uTint')     : null;
  R.diUAlpha    = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uAlpha')    : null;
  R.diUDstRect  = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uDstRect')  : null;
  R.diUSrcRect  = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uSrcRect')  : null;
  R.diUViewport = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uViewport') : null;
  R.diUWorldM   = R.drawImageProg ? gl.getUniformLocation(R.drawImageProg, 'uWorldM')   : null;
  R.diiUTex      = R.drawImageInstProg ? gl.getUniformLocation(R.drawImageInstProg, 'uTex')      : null;
  R.diiUViewport = R.drawImageInstProg ? gl.getUniformLocation(R.drawImageInstProg, 'uViewport') : null;
  R.diiUSrcRect  = R.drawImageInstProg ? gl.getUniformLocation(R.drawImageInstProg, 'uSrcRect')  : null;


  const solidUGBB   = gl.getUniformLocation(R.solidProg, 'uGlobalBBox');
  const solidUAR    = gl.getUniformLocation(R.solidProg, 'uCanvasAR');
  const solidUColor = gl.getUniformLocation(R.solidProg, 'uFillColor');

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
  // Tier-2b filter result cache. Per (handle, filterGraphId) we keep the
  // evaluated filter OUTPUT in a persistent texture + the key it was
  // valid for. On a hit we skip the expensive source-render +
  // evaluateGraph (the multi-pass DAG, blurs, etc.) and re-use the tex.
  // The composite-over-backdrop step still runs every frame (the backdrop
  // changes). Key = (handle.generation, worldM, canvas, the feeding
  // shape's override generation). feedShape = op.shapeIdx — the single
  // shape rendered as SourceGraphic. Cleared on dispose.
  const _filterCache = new Map();    // Map<filterGraphId, {tex,fbo,w,h,key}> — stable ref, exposed directly on R
  let _filterEvalCount = 0;          // debug: # of actual graph evals (misses)
  let _filterScissorActiveCount = 0; // debug: # of graph evals that scissored ≥1 node

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

  // Per-bundle state. The renderer owns a single `_handle` slot
  // that's created on setBundle() and disposed on bundle swap. The
  // public createBundleHandle surface lets consumers hold N persistent
  // handles for multi-bundle scenes.
  //
  // Fields:
  //   bundle:                 the createBundle() output bound to this handle
  //   maskRegions:            computed once per handle
  //   maskRowToLayerCpu:      Int32Array(numShapes); -1 = no region
  //   maskRowToLayerTex:      R32I texture mirroring CPU array
  //   maskRowToLayerTexSize:  tracks reallocation
  //   hybridMeshDirty:        true until the bundle's cover quads have
  //                           been uploaded to the renderer's shared
  //                           triBuf/shapeIdxBuf. Cleared after first
  //                           upload; stays cleared for same-bundle
  //                           re-binds (today's renderer re-set this
  //                           to true on every setBundle, forcing a
  //                           pointless re-upload per mount).
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
    spriteKey: null,         // sprite id of the active subset draw, or null
  };
  // Filter-pass scissoring on/off (default on). Internal toggle used by
  // the render-diff smoke to prove scissored == full-canvas byte-identical;
  // no public surface.
  let _filterScissorEnabled = true;
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
    gl.drawArrays(gl.TRIANGLES, _pendingStart, _pendingEnd - _pendingStart);
    _pendingStart = -1; _pendingEnd = -1;
  }

  // ------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------

  // createBundleHandle — per-bundle state handle (VAO/VBO, mask-region walk,
  // per-handle static cache, per-mount draw()) — see bundleHandle.js.

  function setBundle(bundle) {
    // Same-bundle bind: a no-op for the per-handle state (mask regions
    // + GL lookup texture are immutable for the lifetime of the bundle).
    // The intervening passes between renders (filter graph, mask bake,
    // cache blit) still need the next fill pass to re-bind the asset
    // textures, so we flip _handle.fillPassAssetDirty true unconditionally.
    if (_handle && _handle.bundle === bundle) {
      _handle.fillPassAssetDirty = true;
      fillPassCanvasW = 0;
      fillPassCanvasH = 0;
      return;
    }
    if (_handle) _handle.dispose();
    _handle = bundle ? R.createBundleHandle(bundle) : null;
    fillPassCanvasW = 0;
    fillPassCanvasH = 0;
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
    {
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
    if (_handle.cache && !R._cacheBakingNow) {
      const level = R._cacheTick();
      if (level === CacheLevel.A1 || level === CacheLevel.A3) {
        const _wasValid9 = _handle.cache.isCacheValid;
        if (level === CacheLevel.A3 && !_handle.cache.isCacheValid
            && _handle.cache.isGroupCacheValid()) {
          // Adopt the group's existing bake: BORROW the shared RT (so
          // _cacheBlitToCanvas has a texture — this handle never baked, so its
          // cacheTex is still null) and mark valid WITHOUT re-baking. This is
          // the "blit twice" half of A3 bake-once. If the borrow fails we leave
          // the cache invalid and fall through to a normal bake below.
          const [acw, ach] = viewportSize();
          if (R._cacheEnsureFbo(acw, ach)) _handle.cache.markBaked(R._cacheFrameSeq);
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
  function _renderCanvasInner() {
    if (!_handle || !_handle.bundle) return;
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
    if (_handle.hybridMeshDirty && _handle.bundle.coverQuadFloats) {
      gl.bindBuffer(gl.ARRAY_BUFFER, _handle.triBuf);
      gl.bufferData(gl.ARRAY_BUFFER, _handle.bundle.coverQuadFloats, gl.STATIC_DRAW);
      if (_handle.bundle.hybridShapeIdxFloats) {
        gl.bindBuffer(gl.ARRAY_BUFFER, _handle.shapeIdxBuf);
        gl.bufferData(gl.ARRAY_BUFFER, _handle.bundle.hybridShapeIdxFloats, gl.STATIC_DRAW);
      }
      _handle.hybridMeshDirty = false;
    }
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
        bindFb(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
        bindFb(gl.FRAMEBUFFER, shapeFbo);
        gl.viewport(0, 0, cw, ch);
        gl.depthMask(true); gl.stencilMask(0xff);
        gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.depthMask(false);
        groupStack.push({
          opacity:   op.opacity,
          blendMode: op.blendMode,
          isolation: op.isolation,
        });
        continue;
      }
      if (op.kind === 'groupEnd') {
        flushPending();
        R.endFillPass();
        const grp = groupStack.pop();
        if (!grp) continue;
        bindFb(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cw, ch);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.useProgram(R.compProg);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shapeFboTex); gl.uniform1i(compUShapeTex, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);  gl.uniform1i(compUDstTex, 1);
        // Reuse shapeFboTex on the sharp sampler — the kind=0 path
        // doesn't read it, but every declared sampler needs a binding.
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
          gl.activeTexture(gl.TEXTURE15);
          gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          _handle.fillPassAssetDirty = true;
          // Render the primary glyph silhouette into shapeFbo. Primary
          // mask = the silhouette referenced by the top-level PaintGlyph
          // (or the bare top-level outline when no PaintGlyph wraps).
          bindFb(gl.FRAMEBUFFER, shapeFbo);
          gl.viewport(0, 0, cw, ch);
          gl.depthMask(true); gl.stencilMask(0xff);
          gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          R.beginFillPass();
          gl.drawArrays(gl.TRIANGLES, op.chunk.start, op.chunk.count);
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
              if (gidNum === op.shapeIdx + 1 /* primary already in shapeFbo */) {
                glyphAlphaMasks.set(gidNum, shapeFboTex);
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
              gl.drawArrays(gl.TRIANGLES, maskChunk.start, maskChunk.count);
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
            glyphAlphaTex: shapeFboTex,
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
              uIn1: fcUIn1, uIn2: fcUIn2, uOp: fcUOp, uK: fcUK,
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
          bindFb(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, cw, ch);
          gl.disable(gl.DEPTH_TEST);
          gl.disable(gl.STENCIL_TEST);
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(R.compProg);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rootRT.tex);  gl.uniform1i(compUShapeTex, 0);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mainCopyTex); gl.uniform1i(compUDstTex, 1);
          gl.uniform1i(compUBlendMode, 0);
          gl.uniform1f(compUOpacity, 1);
          gl.bindVertexArray(coverVao);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.bindVertexArray(null);
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
          const cached = _filterCache.get(op.filterGraphId);
          // An active palette LUT is mutable with no version token, so a
          // cached filtered tex can't be trusted across palette draws —
          // bar the hit (the recolor hash already separates palette rows).
          const filterHit = !_ds.palette && R._filterKeyMatches(cached, fKey)
            && cached.tex && cached.w === cw && cached.h === ch;
          if (filterHit) {
            // Snapshot backdrop, then composite the cached filtered tex.
            flushPending();
            R.endFillPass();
            ensureMainCopyTex();
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
            R._compositeFilteredTex(cached.tex, mainCopyTex, cw, ch);
            _handle.fillPassAssetDirty = true;
            continue;
          }
          flushPending();
          R.endFillPass();
          ensureShapeFbo();
          ensureMainCopyTex();
          // Snapshot main FB → mainCopyTex (SourceBackground for the graph).
          gl.activeTexture(gl.TEXTURE15);
          gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          _handle.fillPassAssetDirty = true;
          // Render the shape alone into shapeFbo — this becomes the
          // graph's SourceGraphic input (sentinel -1).
          bindFb(gl.FRAMEBUFFER, shapeFbo);
          gl.viewport(0, 0, cw, ch);
          gl.depthMask(true); gl.stencilMask(0xff);
          gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          R.beginFillPass();
          gl.drawArrays(gl.TRIANGLES, op.chunk.start, op.chunk.count);
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
            { fbo: shapeFbo, tex: shapeFboTex, size: [cw, ch] },
            { fbo: null, tex: mainCopyTex, size: [cw, ch] });
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
          const _fScissors = R._filterNodeScissors(graph, op.shapeIdx | 0, cw, ch);
          if (_fScissors && _fScissors.some(Boolean)) _filterScissorActiveCount++;
          const rootRT = evaluateGraph(gl, graph, _rtPool, _svgDispatch, ctx, cw, ch, _fScissors);
          _filterEvalCount++;
          // Release per-eval LUT textures.
          for (const tex of ctLUTs) { if (tex) gl.deleteTexture(tex); }
          // Tier-2b: copy the filter output into the persistent cache tex
          // so it survives the pool RT being recycled, and stamp the key.
          R._storeFilteredTex(op.filterGraphId, rootRT.tex, cw, ch, fKey);
          // Composite the graph's root output back to main FB. Normal
          // src-over against the existing backdrop — the graph is
          // expected to emit premultiplied RGBA per CSS Filter Effects §11.
          R._compositeFilteredTex(rootRT.tex, mainCopyTex, cw, ch);
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
          ensureShapeFbo();
          ensureMainCopyTex();
          // Snapshot main FB so the composite pass sees the backdrop.
          // Use an otherwise-unused texture unit so we don't clobber
          // a binding that beginFillPass will sample again.
          gl.activeTexture(gl.TEXTURE15);
          gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          // Force a full asset rebind on the upcoming fill pass so the
          // textures we shuffled (mainCopyTex on a high unit) don't leak
          // through.
          _handle.fillPassAssetDirty = true;
          const drawTarget = shapeFbo;
          // Tier-2b single-kind filter cache (the COMMON blur path). The
          // filtered shapeFboTex is a pure function of (feeding shape
          // geometry+overrides, worldMatrix → pxPerEm, canvas). Cache it,
          // keyed like the graph path. On a hit, restore those FBO
          // textures and skip the source render + the (expensive,
          // multi-pass) blur — the kind-specific composite below runs
          // unchanged. Keyed per (filterId, shapeIdx) so two shapes
          // sharing a filter id each get their own cached output.
          const skId = 'k' + op.filterId + '_' + (op.shapeIdx | 0);
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
          let skEntry = _filterCache.get(skId);
          const skHit = !_ds.palette && R._filterKeyMatches(skEntry, skKey)
            && skEntry.shapeTex && skEntry.w === cw && skEntry.h === ch;
          if (skHit) {
            ensureMainCopyTex();
            gl.activeTexture(gl.TEXTURE15);
            gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
            R._blitTexToFbo(skEntry.shapeTex, shapeFbo, cw, ch);
            R._filterSingleKindComposite(f, cw, ch);
            _handle.fillPassAssetDirty = true;
            continue;
          }
          bindFb(gl.FRAMEBUFFER, drawTarget);
          gl.viewport(0, 0, cw, ch);
          gl.depthMask(true); gl.stencilMask(0xff);
          gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          R.beginFillPass();
          gl.drawArrays(gl.TRIANGLES, op.chunk.start, op.chunk.count);
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
          const px = R._filterPxPerEm(cw, ch);
          const pxPerEmX = px[0], pxPerEmY = px[1];
          if (f.kind === 1) {
            // feGaussianBlur — blur the shape FBO in place.
            R.blurShapeFbo(f.sigmaX * pxPerEmX, f.sigmaY * pxPerEmY);
          } else if (f.kind === 5) {
            // feMorphology — erode (0) / dilate (1) with per-axis radii.
            const operator = f.tintR | 0;
            R.morphShapeFbo(operator,
                          f.sigmaX * pxPerEmX,
                          f.sigmaY * pxPerEmY);
          } else if (f.kind === 6) {
            // feConvolveMatrix — single-pass 2D convolution.
            R.convolveShapeFbo(f);
          }
          // Tier-2b: store the post-filter shapeFboTex into the persistent
          // per-(filterId,shape) cache so a static re-render skips the
          // source render + filter next frame.
          if (!skEntry) { skEntry = { w: 0, h: 0, key: null }; _filterCache.set(skId, skEntry); }
          R._ensureCacheTex(skEntry, 'shapeTex', cw, ch);
          skEntry.w = cw; skEntry.h = ch;
          R._blitTexToFbo(shapeFboTex, skEntry.shapeTexFbo, cw, ch);
          skEntry.key = skKey;
          _filterEvalCount++;
          // Composite back to main FB.
          R._filterSingleKindComposite(f, cw, ch);
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
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
          isolatedFbo = pingFbo;
          isolatedTex = pingTex;
          backdropTex = groupBackdropTex;
          dstFbo      = shapeFbo;
        } else {
          gl.activeTexture(gl.TEXTURE15);
          gl.bindTexture(gl.TEXTURE_2D, mainCopyTex);
          gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
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
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.depthMask(false);
        R.beginFillPass();
        gl.drawArrays(gl.TRIANGLES, op.chunk.start, op.chunk.count);
        R.endFillPass();
        bindFb(gl.FRAMEBUFFER, dstFbo);
        gl.viewport(0, 0, cw, ch);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ZERO);  // composite shader emits the
                                         // final composited result.
        gl.useProgram(R.compProg);
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
      const cs = op.chunk.start, cc = op.chunk.count;
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

    if (rendererState.showTriOutline) renderTriOutlineOverlay();
    if (rendererState.showBBoxes)     renderBBoxOverlay();
  }

  function renderTriOutlineOverlay() {
    const b = _handle.bundle;
    if (!b || !b.coverQuadFloats || !b.coverQuadChunks.length) return;
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
  function renderBBoxOverlay() {
    const b = _handle.bundle;
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
  function _analyticRoute(bundle, opts) {
    if (!bundle) return false;
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
    // (lightweight builds) — the "enable A1 and components disappear" report.
    // The capture also matches live frames exactly when both are LB.
    const wantStatic = R._lbFillMode !== 'off' && !bundle._geomGen && !bundle._morphSrc;
    // 'auto' perf gate (shared by static + streamed; stub → always route). A
    // published _lbStream bundle ignores the veto: it has no draw-time Slug
    // fallback, so routing anyway beats rendering blank (its perf decision was
    // already made at stream time).
    if ((wantStatic || lbStreamed)
        && !(R._lbFillMode === 'auto' && !R._staticPerfOk(bundle) && !lbStreamed)
        // Override recolor (fill/tint/visibility — fog) is baked by the route.
        // A per-shape TRANSFORM override on a shape that has Slug geometry falls
        // back to Slug per-shape (which applies the transform); on a lightweight
        // streamed bundle (no Slug geometry) it's unsupported (the road uses fog
        // only). Both static and streamed route — _drawBundleLB handles the mix.
        // Per-draw recolor (colorMatrix/palette/channelLerp) composes via the
        // analytic composite path (_drawBundleLB rejects gradient/image bundles
        // under recolor and forces all shapes through it). ext-clip is still
        // stripped from the variant → keep it on Slug.
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
  // A1 caches a single bundle; A3 shares one RT per instance-group key.
  // ------------------------------------------------------------

  // Compat shim: configure cache on the internal handle. Single-bundle
  // callers (the demo, single-asset tests) keep working unchanged.
  // Multi-bundle callers should use `createBundleHandle(b, { staticCache })`
  // so each mount has its own cache state machine + cache RT.

  function dispose() {
    // Per-handle cache RTs are owned by the handle and freed by its
    // dispose(); the renderer-level dispose just drops the active
    // handle (which cascades to its cache cleanup via h.dispose()).
    for (const p of [
      R.fillProg, R.solidProg, R.compProg, R.blurProg, R.boxBlurProg, R.morphProg,
      R.convolveProg, R.colorMatrixProg, R.feCompositeProg, R.feBlendProg,
      R.feTileProg, R.feTurbulenceProg, R.feDisplacementMapProg, R.feLightingProg,
      R.feComponentTransferProg, R.feImageProg,
      R.paintLinearGradProg, R.paintRadialGradProg, R.paintSweepGradProg,
      R.paintTransformProg, R.paintGlyphProg, R.paintCompositeProg,
      R.maskBakeProg, R.cacheBlitProg, R.drawImageProg, R.drawImageInstProg,
    ]) {
      if (p) gl.deleteProgram(p);
    }
    if (R._instProg) gl.deleteProgram(R._instProg);
    for (const v of [solidVao, coverVao, R._instVao, R._instVaoBundle]) if (v) gl.deleteVertexArray(v);
    for (const b of [solidBuf, coverBuf, R._instBuf, R._instAttrBuf,
                     R._instCompactVbo, R._instCompactShapeVbo]) if (b) gl.deleteBuffer(b);
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
    const _fgs = _handle && _handle.bundle && _handle.bundle.filterGraphs;
    if (_fgs) {
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
    if (_handle) {
      _handle.dispose();
      _handle = null;
    }
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
    _analyticRoute, computeMaskRegions,
    viewportSize, bindFb, applyBlendMode, arScale,
    paletteChannelToInt, _renderCanvasInner,
    _canvasUnsized, _covPool, _rtPool, _svgDispatch,
    IDENTITY_COLOR_MATRIX, ZERO_OFFSET,
    dummyGradientTex, dummyGradientStops, dummyDashTex,
    coverVao,
    buildLoopBlinnMesh, buildLoopBlinnCDT, refreshLoopBlinnMesh, packLoopBlinnMesh, curveRangeToContours,
    lbCanonicalFrame, lbCanonicalHash, transformLoopBlinnRaw,
    buildMorphStroke, LB_VERT_FLOATS,
    // Filter subsystem lives in filterDraw.js (attachFilterDraw, below) — it
    // attaches filterRecord / _buildFilterCtx / blurShapeFbo / … onto R. These
    // renderer-owned helpers stay here but are shared with it (and the composed
    // MORPH route in morphDraw.js) via R. Per-shape state (shapeFbo/mainCopyTex/
    // pingFbo/…) is exposed as LIVE getters below; _filterCache is a stable Map
    // reference so it rides this Object.assign directly.
    ensureShapeFbo, ensureMainCopyTex, ensurePingFbo, evaluateGraph, _filterCache,
  });
  attachFilterDraw(R);
  attachMaskBake(R);
  attachFillPass(R);
  attachFrameLoop(R);
  attachDrawDispatch(R);
  attachBundleHandle(R);   // before attachClipDraw — it destructures R.createBundleHandle
  attachClipDraw(R);
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
  // are reassigned by ensurePingFbo; _filterScissorEnabled toggled by _setFilterScissor).
  Object.defineProperty(R, 'pingFbo', { get: () => pingFbo, configurable: true });
  Object.defineProperty(R, 'pingTex', { get: () => pingTex, configurable: true });
  Object.defineProperty(R, '_filterScissorEnabled', { get: () => _filterScissorEnabled, configurable: true });
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
  R._renderShapeViaSlug = function (bundle, s) {
    if (_contextLost) return false;
    if (_handle && _handle.bundle !== bundle) setBundle(bundle);
    if (!_handle || !_handle.bundle) return false;
    const saved = _ds.shapeRange;
    _ds.shapeRange = [s | 0, s | 0];
    try { _renderCanvasInner(); } finally { _ds.shapeRange = saved; }
    return true;
  };
  Object.defineProperty(R, '_inFrame', { get: () => _inFrame, set: (v) => { _inFrame = v; }, configurable: true });
  Object.defineProperty(R, '_captureFrames', { get: () => _captureFrames, set: (v) => { _captureFrames = v; }, configurable: true });
  Object.defineProperty(R, '_instancedFastEnabled', { get: () => _instancedFastEnabled, set: (v) => { _instancedFastEnabled = v; }, configurable: true });

  // Public renderer state object. The factory exposes mutable debug
  // flags here so consumers can toggle them at any time.
  const built = {
    showTriOutline: false,
    showBBoxes: false,
    setBundle,
    render,
    invalidateRenderState: R.invalidateRenderState,
    markGeometryDirty: R.markGeometryDirty,
    // Internal: toggle filter-pass scissoring (default on). Used by the
    // render-diff smoke to compare scissored vs full-canvas output.
    _setFilterScissor(v) { _filterScissorEnabled = !!v; },
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
    // Synchronously build a bundle's Loop-Blinn meshes NOW (on the main thread),
    // instead of waiting for the off-thread worker build to land. The runtime
    // never needs this — the draw path uses ready-LB-or-Slug — but eager callers
    // (scene prewarm) and tests that must assert LB routing deterministically do.
    prepareBundle: R.prepareBundle,
    /// Budget for resident Loop-Blinn mesh memory (bytes). Bundles whose
    /// projected footprint would exceed it render via Slug instead.
    setLoopBlinnMemoryBudget: R.setLoopBlinnMemoryBudget,
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
    //                   bundles, and all-solid static bundles (the one-draw
    //                   combined route, ~3× faster). Gradient/image/composed
    //                   static bundles stay on Slug (per-shape LB loses to Slug's
    //                   single pass) — see _staticPerfOk.
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
    // (worldMatrix + alpha), sharing geometry + a single overrides table.
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
    // Debug-only memory estimate (bytes).
    gpuMemoryEstimate,
    // Debug-only cache stats. maskBakeCount / filterEvalCount = number
    // of actual mask bakes / filter-graph evals (cache misses).
    get debugStats() {
      return { maskBakeCount: _maskBakeCount, filterEvalCount: _filterEvalCount,
               filterScissorActiveCount: _filterScissorActiveCount,
               loopBlinnRouteCount: R._lbRouteCount,
               loopBlinnMorphRouteCount: R._lbMorphRouteCount,
               loopBlinnMorphComposedCount: R._lbMorphComposedCount };
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
    // Strategy.ForceA3 so multiple mounts of one asset share a single cache RT
    // (see a3InstanceGroupSmoke). For multi-handle scenes prefer
    // createBundleHandle(b, { staticCache: { strategy: ForceA3, instanceGroupKey } }).
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
