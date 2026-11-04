// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { finishLerpPass } from './morphLerpPass.js';
import { monotoneCubicDrawEligible } from './aacCubicPreparation.js';
import { lbPickBreaks, lbPickRows } from './lbShapePolicy.js';
import {
  deleteGlResource,
  deleteProgramWhenLinked,
  resourceGeneration,
  contextProgramsCreated,
  trackGlResource,
} from './contextResources.js';
// Fill-pass setup and shader variants. Bundles enqueue their own prewarm work;
// variant defines come from the bundle's features. fillWarmTick drains the
// queue incrementally; precompileFills compiles explicitly requested variants.

import { inspect, featuresToFillOmit } from '../bundle/featureSet.js';
import {
  enqueueFillPrewarm,
  takeFillPrewarm,
  addFillPrewarmConsumer,
  removeFillPrewarmConsumer,
} from './bundle.js';
import { getRendererFeature } from './featureRegistry.js';
import {
  meanShapePx2 as sharedMeanShapePx2,
  minLinearScalePx,
  unitPx2,
  worldMapAxisAligned,
  overridesAxisAligned,
  overridesRaiseStroke,
  patternMapAxisAligned,
  patternHasFineTile,
  patternFineBar,
} from './shapeScale.js';
import { shapeSegStats } from './shapeStats.js';
import {
  aacBundleFloor,
  aacPresenceTerms,
  aacPresenceBreak,
  aacClassicPick,
  aacClassicBar,
} from './coverKernelPolicy.js';
import { omitDefinesFor } from './fillOmit.js';
import { auxWarmers } from './auxWarm.js';
import { diagFlags, mantleWarn, mantleDebugHook } from '../core/diagnostics.js';
import { glEpoch } from '../core/glEpoch.js';
import { ENGINES, DECLINE, engineOfVariantKey, coverKernelOfVariantKey } from './engineLedger.js';
import { engineSelection, engineSelKey } from './engineSwitch.js';
import {
  mergeSceneDefines,
  pickWarmSuperset,
  isWarmSuperset,
  isNetFor,
  isRestrictive,
  classSig,
  heavySig,
} from './sceneUnion.js';
import { warmStateOf } from './warmManifest.js';
import { unwrapBundle } from '../core/unwrapBundle.js';

/** Fill texture-unit shadow, one per WebGL context (see the note in
 *  attachFillPass). Keyed by gl so renderers sharing a context share it. */
const _fillUnitsByContext = new WeakMap();
const SEGMENT_TYPE_DEFINES = [
  'MANTLE_NO_LINE',
  'MANTLE_NO_QUAD',
  'MANTLE_NO_CUBIC',
  'MANTLE_NO_ARC',
];

// Fill content-features that are BAKED into the bundle geometry/tables, so a
// bundle that lacks one can compile it out of its shader variant. recolor and
// extclip are deliberately absent: they are PER-DRAW state (any bundle can turn
// them on via drawBundle options / setNodeClip), so omitting them would silently
// drop a feature a later draw enables. See featuresToFillOmit / BAKED_FILL_FEATURES.
/** @param {import('./rendererContext.js').RendererContext} R */
export function attachFillPass(R) {
  const {
    gl,
    viewportSize,
    arScale,
    dummyDashTex,
    dummyGradientTex,
    dummyGradientStops,
    IDENTITY_COLOR_MATRIX,
    ZERO_OFFSET,
  } = R;

  // Texture bindings and the active unit are shared context state. Keep one
  // shadow per context so renderers sharing it observe each other’s bindings.
  // Program-specific sampler assignments are handled by bindProgramSamplers.
  const FILL_UNITS = 16; // shadowed: 0..15
  const SCRATCH_UNIT = 11; // no fill sampler uses this unit
  let unitState = _fillUnitsByContext.get(gl);
  const generation = resourceGeneration(gl);
  if (!unitState || unitState.generation !== generation) {
    unitState = { generation, u: new Array(FILL_UNITS).fill(null), active: -1, epoch: glEpoch() };
    _fillUnitsByContext.set(gl, unitState);
  }
  R._fpU = unitState.u;
  // Standalone GL writers, including morph uploads on units14/15, invalidate
  // this shadow through glEpoch. Synchronize before any cached binding decision.
  const syncUnitEpoch = () => {
    const e = glEpoch();
    if (e === unitState.epoch) return;
    unitState.epoch = e;
    unitState.u.fill(null);
    unitState.active = -1;
  };
  // `target` differs for unit 9 (a 2D_ARRAY); everything else is TEXTURE_2D.
  /** @type {(unit: number, tex: WebGLTexture, target?: number) => void} */
  const bindFillTex = (unit, tex, target = gl.TEXTURE_2D) => {
    syncUnitEpoch();
    if (unitState.u[unit] === tex) return;
    activeUnit(unit);
    gl.bindTexture(target, tex);
    unitState.u[unit] = tex;
  };
  // The active unit is itself GL state worth shadowing: a draw whose every
  // bind was a shadow hit does not need to re-select anything, including the
  // scratch park below. Unknown after a forget, since other passes move it.
  const activeUnit = (unit) => {
    syncUnitEpoch();
    if (unitState.active === unit) return;
    unitState.active = unit;
    gl.activeTexture(gl.TEXTURE0 + unit);
  };
  R._forgetFillUnits = () => {
    unitState.epoch = glEpoch();
    unitState.u.fill(null);
    unitState.active = -1;
  };
  /// For a caller that had to move the active unit with a RAW gl.activeTexture (a bind this shadow does not own):
  /// put it back on the scratch unit and say so. Restoring TEXTURE0 instead left the shadow believing the scratch
  /// park still stood, so the next bare bindTexture -- a group's backdrop snapshot -- replaced uCurveData and every
  /// cover quad after it sampled the canvas as curve data.
  R._parkFillActiveUnit = () => {
    syncUnitEpoch();
    unitState.active = SCRATCH_UNIT;
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  };
  // Fold the active-unit shadow into glAuditState so one audit covers both
  // (this shadow is what makes the scratch-unit park skippable).
  R._glStateExtraAudit = () => {
    const out = [];
    if (unitState.active >= 0) {
      const got = gl.getParameter(gl.ACTIVE_TEXTURE) - gl.TEXTURE0;
      if (got !== unitState.active) {
        out.push(`[Mantle] glState: activeTexture shadow=${unitState.active} actual=${got}`);
      }
    }
    // And every shadowed BINDING. This is what catches a pass (or a public
    // entry point like shapeMorph) clobbering a fill unit without dropping the
    // shadow — the failure mode is a skipped bind, i.e. sampling someone
    // else's texture, which no pixel test reliably localizes.
    const savedActive = unitState.active;
    for (let u = 0; u < FILL_UNITS; u++) {
      const want = unitState.u[u];
      if (!want) continue;
      gl.activeTexture(gl.TEXTURE0 + u);
      const is2DArray = u === 9;
      const got = gl.getParameter(is2DArray ? gl.TEXTURE_BINDING_2D_ARRAY : gl.TEXTURE_BINDING_2D);
      if (got !== want) out.push(`[Mantle] glState: texture unit ${u} shadow != actual binding`);
    }
    if (savedActive >= 0) gl.activeTexture(gl.TEXTURE0 + savedActive);
    return out.length ? out : null;
  };

  // Reused scratch for variant-cache keys (avoids per-draw slice+sort alloc).
  const _defKeyBuf = [];
  function definesKey(defines) {
    if (!defines || !defines.length) return '';
    _defKeyBuf.length = 0;
    for (let i = 0; i < defines.length; i++) _defKeyBuf.push(defines[i]);
    _defKeyBuf.sort();
    return _defKeyBuf.join('|');
  }

  // Resolve every fill uniform location for one program variant. Keyed by the
  // exact local names beginFillPass uses, so the pass body destructures the
  // active variant's table (`const { ... } = variant.u`) and stays unchanged.
  function captureFillUniforms(prog) {
    return {
      uCurveLoc: gl.getUniformLocation(prog, 'uCurveData'),
      uBandLoc: gl.getUniformLocation(prog, 'uBandData'),
      uMetaLoc: gl.getUniformLocation(prog, 'uMetaTex'),
      uDashLoc: gl.getUniformLocation(prog, 'uDashTex'),
      uGBB: gl.getUniformLocation(prog, 'uGlobalBBox'),
      uShapeIdxOverride: gl.getUniformLocation(prog, 'uShapeIdxOverride'),
      uFillNumShapes: gl.getUniformLocation(prog, 'uNumShapes'),
      uFillCanvasAR: gl.getUniformLocation(prog, 'uCanvasAR'),
      uFillViewportSize: gl.getUniformLocation(prog, 'uViewportSize'),
      uFillFragOrigin: gl.getUniformLocation(prog, 'uFragOrigin'),
      uFillGradTex: gl.getUniformLocation(prog, 'uGradientTex'),
      uFillGradStops: gl.getUniformLocation(prog, 'uGradientStops'),
      uFillGradCount: gl.getUniformLocation(prog, 'uGradientCount'),
      uFillSecondaryImageTex: gl.getUniformLocation(prog, 'uSecondaryImageTex'),
      uFillSecondaryImageAtlasSize: gl.getUniformLocation(prog, 'uSecondaryImageAtlasSize'),
      uFillImageTex: gl.getUniformLocation(prog, 'uImageTex'),
      uFillImageAtlasSize: gl.getUniformLocation(prog, 'uImageAtlasSize'),
      uFillFilterTex: gl.getUniformLocation(prog, 'uFilterTex'),
      uFillOverrideTex: gl.getUniformLocation(prog, 'uOverrideTex'),
      uFillHasOverrides: gl.getUniformLocation(prog, 'uHasOverrides'),
      uFillHasEmCoord: gl.getUniformLocation(prog, 'uHasEmCoord'),
      uFillDrawAlpha: gl.getUniformLocation(prog, 'uDrawAlpha'),
      uFillFilterInputScale: gl.getUniformLocation(prog, 'uFilterInputScale'),
      uFillFilterCoverageScale: gl.getUniformLocation(prog, 'uFilterCoverageScale'),
      uFillColorMatrix: gl.getUniformLocation(prog, 'uColorMatrix'),
      uFillColorMatrixOffset: gl.getUniformLocation(prog, 'uColorMatrixOffset'),
      uFillColorMatrixEnabled: gl.getUniformLocation(prog, 'uColorMatrixEnabled'),
      uFillExtClipTex: gl.getUniformLocation(prog, 'uExtClipTex'),
      uFillExtClipMode: gl.getUniformLocation(prog, 'uExtClipMode'),
      uFillChLerpPrimary: gl.getUniformLocation(prog, 'uChannelLerpPrimary'),
      uFillChLerpContrast: gl.getUniformLocation(prog, 'uChannelLerpContrast'),
      uFillChLerpHighlight: gl.getUniformLocation(prog, 'uChannelLerpHighlight'),
      uFillChLerpEnabled: gl.getUniformLocation(prog, 'uChannelLerpEnabled'),
      uFillStrokeGates: gl.getUniformLocation(prog, 'uStrokeGates'),
      uFillCoverAaReach: gl.getUniformLocation(prog, 'uCoverAaReach'),
      uFillStrokeExactAa: gl.getUniformLocation(prog, 'uStrokeExactAa'),
      uFillPalette: gl.getUniformLocation(prog, 'uPalette'),
      uFillPaletteEnabled: gl.getUniformLocation(prog, 'uPaletteEnabled'),
      uFillPaletteChannel: gl.getUniformLocation(prog, 'uPaletteChannel'),
      uFillPaletteSize: gl.getUniformLocation(prog, 'uPaletteSize'),
      uFillWorldM: gl.getUniformLocation(prog, 'uWorldM'),
      uFillHasWorldM: gl.getUniformLocation(prog, 'uHasWorldM'),
      uFillMaskRTArray: gl.getUniformLocation(prog, 'uMaskRTArray'),
      uFillMaskRowToLayerTex: gl.getUniformLocation(prog, 'uMaskRowToLayerTex'),
      uFillHasOffscreenMask: gl.getUniformLocation(prog, 'uHasOffscreenMask'),
      uFillHasPatternGroups: gl.getUniformLocation(prog, 'uHasPatternGroups'),
      uFillHasOccupancy: gl.getUniformLocation(prog, 'uHasOccupancy'),
      // MANTLE_LB_MORPH only: the mix between the two endpoint packs the unified
      // morph stream carries. Null on every other variant, and the unified draw
      // sets it only when it bound a morph buffer.
      uFillMorphT: gl.getUniformLocation(prog, 'uMorphT'),
      // MANTLE_LB_CURVE_TEX only: the per-curve coefficient texture and its width.
      uFillCurveCoef: gl.getUniformLocation(prog, 'uCurveCoefTex'),
      uFillCurveCoefW: gl.getUniformLocation(prog, 'uCurveCoefW'),
    };
  }

  // Per-variant uniform shadow. GL keeps uniform VALUES per program OBJECT, so
  // anything already written to a variant survives every intervening
  // useProgram — a re-selected variant does NOT need its state restated. In a
  // multi-mount frame the same variant comes back draw after draw with the same
  // feature flags, alpha and frag origin, and each redundant write is a
  // command-buffer crossing (far dearer than the compare that avoids it).
  //
  // Safe because fillPass is the only writer of these programs' uniforms —
  // renderer.js resolves no fill locations of its own (see the note beside its
  // program list), and every other pass drives its own program. Programs are
  // never relinked, so a shadow entry is valid for the life of the variant.
  // `v.s` is the shadow; each uniform owns a distinct key.
  const u1i = (v, k, loc, x) => {
    if (v.s[k] !== x) {
      v.s[k] = x;
      gl.uniform1i(loc, x);
    }
  };
  const u1f = (v, k, loc, x) => {
    if (v.s[k] !== x) {
      v.s[k] = x;
      gl.uniform1f(loc, x);
    }
  };
  // Vector/matrix shadows keep their components in one reused Float64Array per
  // key (never a string-concatenated key — that would allocate per draw).
  function _slot(v, k, n) {
    let a = v.s[k];
    if (!a) a = v.s[k] = new Float64Array(n).fill(NaN); // NaN ≠ anything → first write always lands
    return a;
  }
  const u2f = (v, k, loc, x, y) => {
    const a = _slot(v, k, 2);
    if (a[0] === x && a[1] === y) return;
    a[0] = x;
    a[1] = y;
    gl.uniform2f(loc, x, y);
  };
  const u4f = (v, k, loc, x, y, z, w) => {
    const a = _slot(v, k, 4);
    if (a[0] === x && a[1] === y && a[2] === z && a[3] === w) return;
    a[0] = x;
    a[1] = y;
    a[2] = z;
    a[3] = w;
    gl.uniform4f(loc, x, y, z, w);
  };
  // A mat3 arrives as a caller-owned Float32Array that may be mutated in place,
  // so compare CONTENTS, never identity.
  const uMat3 = (v, k, loc, m) => {
    const a = _slot(v, k, 9);
    let same = true;
    for (let i = 0; i < 9; i++) {
      if (a[i] !== m[i]) {
        same = false;
        break;
      }
    }
    if (same) return;
    for (let i = 0; i < 9; i++) a[i] = m[i];
    gl.uniformMatrix3fv(loc, false, m);
  };

  // Which texture unit each fill sampler reads is FIXED for the life of a
  // program: unit 0 is always the curve texture, 13 always the palette, and so
  // on. Same per-program-object persistence as the shadow above, so one
  // assignment per variant holds forever. Re-sending them per draw would be the
  // single largest per-draw GL cost in a multi-mount frame: 13 uniform1i on
  // every asset rebind, about half of a multi-mount frame's uniform1i calls.
  // A null location (a lean variant that compiled the sampler out) is
  // a spec-defined no-op.
  function bindProgramSamplers(v) {
    // Every variant record reaches the pass body through here, so this is the
    // one place the value shadow has to be created — the variant creation
    // sites (base, prewarm, mid-draw, AAC) stay uniform-agnostic.
    if (!v.s) v.s = {};
    if (v.samplersBound) return;
    const u = v.u;
    gl.uniform1i(u.uCurveLoc, 0);
    gl.uniform1i(u.uBandLoc, 1);
    gl.uniform1i(u.uMetaLoc, 2);
    gl.uniform1i(u.uDashLoc, 3);
    gl.uniform1i(u.uFillGradTex, 4);
    gl.uniform1i(u.uFillGradStops, 5);
    gl.uniform1i(u.uFillImageTex, 6);
    gl.uniform1i(u.uFillSecondaryImageTex, 15);
    gl.uniform1i(u.uFillFilterTex, 7);
    gl.uniform1i(u.uFillOverrideTex, 8);
    gl.uniform1i(u.uFillMaskRTArray, 9);
    gl.uniform1i(u.uFillMaskRowToLayerTex, 10);
    gl.uniform1i(u.uFillPalette, 13);
    gl.uniform1i(u.uFillExtClipTex, 14);
    v.samplersBound = true;
  }

  const variantCache = new Map();
  const defaultKey = (R._baseFillDefines || []).slice().sort().join('|');
  const defaultHasAac = defaultKey.split('|').includes('MANTLE_AAC');
  const defaultHasRotatedMap = defaultKey.split('|').includes('MANTLE_ROTATED_MAP');
  // this renderer's share of the context's newly-created bundles. Seeded with the bundles the
  // context already holds, so a renderer created after its content still warms it.
  const _prewarmQ = addFillPrewarmConsumer(gl);
  // A bundle handed to createShapeMorph is a source POSE: nothing draws it, yet the automatic warm would compile its fill variants,
  // draw it once (building and uploading its Loop-Blinn stream and coefficient texture: 43 MB of GL buffers and 11 MB of textures
  // on a six-pair scene) and start its worker meshes. So the automatic queue skips it unless `warmMorphSources: true`. An explicit
  // prewarmBundle()/prepareBundle() still warms it, and a source drawn directly builds what it needs at its first draw.
  // Under strictPlay's stand-in-free policy no pipeline may first be built in play, and an app may draw a pose beside its timeline, so a pose is warmed like any bundle unless `warmMorphSources: false`
  // (it costs its programs and pipelines; a pose's keys are mostly the other poses', and a static bundle under 'auto' builds no mesh).
  const _skipMorphSource = (b) =>
    !!b._morphSourcePose &&
    !R.opts.warmMorphSources &&
    !(
      R.opts.warmMorphSources === undefined &&
      R.opts.strictPlay === true &&
      R.opts.standIns === false
    );
  // A bundle whose decided variant has no warm pipeline asks this renderer to warm it. Once per
  // bundle and variant key; once the pipeline is warm, psoReady stops the request. (The unified
  // route has its own re-enqueue, in fillVariantHasLbFill.)
  //
  const _psoWarmRequested = new WeakMap();
  const rememberWarmTarget = (bundle, key, queue) => {
    if (!bundle || R.opts.psoWarm === false) return false;
    let keys = _psoWarmRequested.get(bundle);
    if (!keys) {
      keys = new Map();
      _psoWarmRequested.set(bundle, keys);
    }
    const queued = keys.get(key);
    if (queue && !queued) {
      keys.set(key, true);
      return true;
    }
    if (queued === undefined) keys.set(key, false);
    return false;
  };
  // ---- STRICT PLAY ------------------------------------------------------------------------------------------------------------
  // opts.strictPlay (createMantleScene sets it): once the loading call is done, every frame is a complete, correct, new frame -- no frame is shed,
  // no draw deferred, no pipeline built. The loading call (and a warm window the app opens: renderer.beginWarmWindow) builds, besides the
  // scene's own programs, the SAFETY NETS: the maximal program of every kernel family and draw state the scene can reach (planCover), whose
  // pipelines are built behind the loading screen. A draw in play whose own program has no built pipeline draws with a built net (an omission
  // superset: the same pixels, only more code left in) and its own lean program is queued for the next window. Builds happen only there.
  const strictCfg = () => R.opts.strictPlay === true;
  // warmPolicy 'idle': no strict-play safety nets (draws compile on demand), and ALSO builds queued variants in library-inferred idle windows
  const idleCfg = () => R.opts.warmPolicy === 'idle';
  const offCfg = () => R.opts.warmPolicy === 'off';
  const strictNow = () =>
    strictCfg() &&
    nb() &&
    !!R._loadStats &&
    R._loadStats.phase === 'done' &&
    !R._warmWindow &&
    !R._coop &&
    !R._inferSlice;
  // ---- LIBRARY-INFERRED WARM WINDOWS ---------------------------------------------------------------------------------------------
  // Builds hold the GPU thread (and with it presentation) for 0.1-1.7 s each, so strict play makes none -- until a build is INVISIBLE: the screen
  // is static (the last N frames drew the same bundles under the same matrices, overrides and morph times), or the tab is hidden, and no input has
  // arrived for a while. Then the queued lean programs (and a new size class) are built, one pipeline per fence, and the moment the screen moves
  // or an input arrives the builds stop (the one in flight finishes: a pipeline cannot be canceled). The app has nothing to do;
  // renderer.beginWarmWindow() only lets it choose the moment instead.
  const _f32 = new Float32Array(1),
    _u32 = new Uint32Array(_f32.buffer);
  // (a float's entropy is in its top bits and a multiply only carries upward, so it must fold down too: without it h kept 22 clear low bits and a sprite's frames 0 and 1 hashed alike)
  const _fold = (h, x) => {
    _f32[0] = x;
    h = Math.imul(h ^ _u32[0], 16777619);
    return (h ^ (h >>> 15)) | 0;
  };
  const _bundleIds = new WeakMap();
  let _nextBundleId = 1;
  const _idOf = (o) => {
    let id = _bundleIds.get(o);
    if (!id) _bundleIds.set(o, (id = _nextBundleId++));
    return id;
  };
  const _foldN = (h, a, n) => {
    for (let i = 0; i < n; i++) h = _fold(h, a[i]);
    return h;
  };
  /// What a draw's options move on the screen besides its matrix: a tint or recolor that animates, an image's rects.
  function _foldDrawOpts(h, o) {
    if (!o) return h;
    if (o.colorMatrix) h = _foldN(h, o.colorMatrix, 16);
    if (o.colorMatrixOffset) h = _foldN(h, o.colorMatrixOffset, 4);
    const cl = o.channelLerp;
    if (cl) {
      if (cl.primary) h = _foldN(h, cl.primary, cl.primary.length);
      if (cl.contrast) h = _foldN(h, cl.contrast, cl.contrast.length);
      if (cl.highlight) h = _foldN(h, cl.highlight, cl.highlight.length);
    }
    if (o.palette) h = _fold(h, _idOf(o.palette));
    if (o.tint) h = _foldN(h, o.tint, o.tint.length);
    if (o.dstRect) h = _foldN(h, o.dstRect, 4);
    if (o.srcRect) h = _foldN(h, o.srcRect, 4);
    return h;
  }
  /// every DRAW ENTRY NOTES ITSELF, or the screen reads as static while it moves: a scene animated through handle.draw, an instanced draw, a sprite's frames, a recolor or a drawImage kept the
  /// count of static frames climbing, and the warm that waits for a still screen linked and built in the middle of its motion. `target` is a bundle or an image.
  R._noteDrawIdle = (target, ov, wm, alpha, o) => {
    if (R._psoWarming || (!strictCfg() && !idleCfg())) return;
    let h = _fold(R._idleSig | 0, _idOf(target));
    if (wm) h = _foldN(h, wm, 9);
    else h = _fold(h, -1);
    h = _fold(h, ov ? ov.generation : -1);
    h = _fold(h, target._morphSrc ? target._morphSrc.t : -2);
    const sr = R.draw.shapeRange;
    if (sr) h = _fold(_fold(h, sr[0]), sr[1]);
    R._idleSig = _foldDrawOpts(_fold(h, alpha == null ? 1 : alpha), o);
  };
  const IDLE_INST_SAMPLES = 256; // (a field of instances that moves shows in a sample of it; a frame does not fold thousands of matrices to learn that)
  R._noteInstancesIdle = (target, ov, instances, o) => {
    if (R._psoWarming || (!strictCfg() && !idleCfg())) return;
    const n = instances.length,
      step = n > IDLE_INST_SAMPLES ? n / IDLE_INST_SAMPLES : 1;
    let h = _fold(_fold(R._idleSig | 0, _idOf(target)), n);
    h = _fold(h, ov ? ov.generation : -1);
    h = _fold(h, target._morphSrc ? target._morphSrc.t : -2);
    const sr = R.draw.shapeRange;
    if (sr) h = _fold(_fold(h, sr[0]), sr[1]);
    h = _foldDrawOpts(h, o);
    for (let f = 0; f < n; f += step) {
      const inst = instances[f | 0];
      if (!inst) continue;
      if (inst.worldMatrix) h = _foldN(h, inst.worldMatrix, 9);
      h = _foldDrawOpts(_fold(h, inst.alpha == null ? 1 : inst.alpha), inst);
    }
    R._idleSig = h;
  };
  let _lastIdleSig = 0,
    _staticFrames = 0,
    _lastInputAt = 0,
    _inputHooked = false;
  const IDLE_STATIC_FRAMES = 24,
    IDLE_INPUT_QUIET_MS = 700,
    IDLE_NO_FRAME_MS = 300;
  const RESIZE_QUIET_MS = 5000,
    RESIZE_INPUT_QUIET_MS = 2000; // (a size settled for this long, and no input, before a resize-triggered build)
  // (declared above _stepIdle's first use; _lastVpChangeAt is declared with the class warm below and read lazily)
  function _hookInput() {
    if (_inputHooked || typeof window === 'undefined' || !window.addEventListener) return;
    _inputHooked = true;
    const mark = () => {
      _lastInputAt = _nowMs();
    };
    for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove']) {
      try {
        window.addEventListener(t, mark, { passive: true, capture: true });
      } catch {
        /* no window events */
      }
    }
  }
  function _stepIdle() {
    // once per frame entry
    const sig = _fold(_fold(R._idleSig | 0, R._lastSeenW | 0), R._lastSeenH | 0);
    R._idleSig = 0; // (a resize is motion too)
    if (sig === _lastIdleSig) _staticFrames++;
    else {
      _staticFrames = 0;
      _lastIdleSig = sig;
    }
  }
  const _hasPendingWarm = () =>
    _psoWarmHead < _psoWarmQueue.length || _psoDemand.size > 0 || !!_vpChange || !!_bg;
  function _inferredIdle() {
    if (typeof document !== 'undefined' && document.hidden) return true;
    // After a RESIZE the user is likely still interacting (a drag, a second toggle): a window needs a longer settle and a longer input quiet than the
    // plain static-screen one, and a size that changes again closes it (the screen moved: the static count restarts, _lastVpChangeAt moves).
    const afterResize = _nowMs() - _lastVpChangeAt < RESIZE_QUIET_MS;
    return (
      _staticFrames >= IDLE_STATIC_FRAMES &&
      _nowMs() - _lastInputAt >= (afterResize ? RESIZE_INPUT_QUIET_MS : IDLE_INPUT_QUIET_MS) &&
      !afterResize
    );
  }
  R._inferredWindows = 0;
  /// For warmQueue: the library's idleness inference (static screen, no input, hidden tab, or no frame entered for a while), the last frame entry and input.
  R._hookInput = _hookInput;
  R._lastInputMs = () => _lastInputAt;
  R._staticFrameCount = () => _staticFrames;
  R._idleNow = () => {
    _hookInput();
    if (typeof document !== 'undefined' && document.hidden) return true;
    const t = _nowMs();
    if (t - _lastInputAt < IDLE_INPUT_QUIET_MS) return false;
    if (_staticFrames >= IDLE_STATIC_FRAMES) return true;
    return !(R._frameEntryAt > 0) || t - R._frameEntryAt >= IDLE_NO_FRAME_MS; // (no frame entered: nothing this renderer draws is moving)
  };
  R._strictPlay = strictNow;
  R._queueWarmBundle = (b) => {
    if (b && !b._disposed && R.opts.psoWarm !== false && !_psoWarmQueue.includes(b))
      _psoWarmQueue.push(b);
  };
  const standIns = (R._playStandIns = new Map()); // wanted key -> { net, frames, firstFrame, lastFrame }
  const _atReady = new WeakSet();
  R._markLoadedBundles = () => {
    for (const b of R._liveBundles()) _atReady.add(b);
  };
  const noteStandIn = (key, net, bundle) => {
    let e = standIns.get(key);
    if (!e) {
      e = {
        net: net.key || '',
        frames: 0,
        firstFrame: R._frameSerial | 0,
        lastFrame: 0,
        serial: -1,
        bundles: 0,
        freshBundles: 0,
        _seen: new WeakSet(),
      };
      if (standIns.size < 200) standIns.set(key, e);
      else return;
    }
    if (e.serial !== (R._frameSerial | 0)) {
      e.serial = R._frameSerial | 0;
      e.frames++;
      e.lastFrame = e.serial;
    }
    if (bundle && !e._seen.has(bundle)) {
      e._seen.add(bundle);
      e.bundles++;
      if (!_atReady.has(bundle)) e.freshBundles++;
    }
    R._playStandInDraws = (R._playStandInDraws | 0) + 1;
  };
  const requestPsoWarm = (bundle, key) => {
    if (!bundle || R.opts.psoWarm === false) return;
    if (!rememberWarmTarget(bundle, key, true)) return;
    // A rotated-map variant is decided by the draw's world matrix, which the slack-time warm does not have:
    // record it, and the warm replays a rotated map (_warmBundlePso), as it replays a recolor.
    if (key.includes('MANTLE_ROTATED_MAP')) bundle._warmRotatedMap = true;
    _psoWarmQueue.push(bundle);
  };
  const _psoWarmQueue = []; // bundles whose Metal pipeline-state to build at load (fill-only warm)
  let _psoWarmHead = 0;
  // The warm deadline. A draw that finds its variant linked but its pipeline cold
  // draws the universal program and records a DEMAND here: variant key -> the bundle that wants
  // it, the frames it has fallen back for, whether a draw fell back since the last frame entry,
  // and when the first did. fillWarmTick builds a demand's pipeline once it is past its deadline,
  // whatever the frame time -- see _warmOverdueDemand.
  const _psoDemand = new Map();
  const _nowMs = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const noteWarmDemand = (bundle, key) => {
    let d = _psoDemand.get(key);
    if (!d)
      _psoDemand.set(key, {
        bundle,
        frames: 0,
        hit: true,
        since: _nowMs(),
        selection: engineSelKey(R),
        warm: null,
        ready: null,
      });
    else {
      d.bundle = bundle;
      d.hit = true;
      d.selection = engineSelKey(R);
    }
  };
  // A demand that is not a fill variant's pipeline: the instanced fast path's specialized program
  // (instancedFill.js). `warm` builds it, `ready` says whether it is built; it is placed exactly as a
  // fill variant's warm is -- in slack, else at the deadline.
  R._noteWarmDemand = (key, warm, ready) => {
    let d = _psoDemand.get(key);
    if (!d)
      _psoDemand.set(key, {
        bundle: null,
        frames: 0,
        hit: true,
        since: _nowMs(),
        selection: engineSelKey(R),
        warm,
        ready,
      });
    else {
      d.hit = true;
      d.selection = engineSelKey(R);
    }
  };
  let _auxProgQueue = null; // one-time queue of aux-program compile thunks (morph/instanced), prewarmed at load
  let _auxProgHead = 0;
  // The AAC fallback has the full feature set; the constructor's kernel only selects the initial base program.
  const aacBaseKey = Array.from(new Set((R.opts.fillDefines || []).concat(['MANTLE_AAC'])))
    .sort()
    .join('|');
  // The universal (all-feature) fallback. psoReady:true — it is what a lean
  // variant falls back to until its own pipeline is warmed, so it is always
  // usable; its one-time pipeline compile lands on the first fill draw (behind
  // the load screen), then every draw reuses it → no per-variant stalls.
  /// Every cache entry carries the key it was built from, so a consumer can ask
  /// what a variant actually CONTAINS. Tagging at creation is not optional
  /// bookkeeping: entries are created from four places (prewarm, mid-draw
  /// specialization, the two bases), and a flag set at only one of them reads as
  /// "absent" from the others — and the unified fill route would silently never
  /// engage.
  // Match the exact-cover branch in mantle.vert.glsl, including Slug aliases. The ordinary and the instanced
  // programs share this answer: the instanced fast path must size its cover like the per-instance loop.
  R._exactCoverDefines = (defs) =>
    defs.includes('MANTLE_AAC') ||
    (!defs.includes('MANTLE_NO_COVER_FILL') &&
      (defs.includes('MANTLE_HARD_MIXED') ||
        defs.includes('MANTLE_COVER_KERNEL') ||
        (!defs.includes('MANTLE_GWN') && !defs.includes('MANTLE_HARD'))));
  const putVariant = (key, v) => {
    v.key = key;
    const defs = key.split('|');
    v.boxFilterReach = R._exactCoverDefines(defs);
    variantCache.set(key, v);
    return v;
  };
  // The init-time fill source check (shaderPrograms.js) is a real variant: the plain-fill key. Registered here so a bundle that wants it finds it linked.
  if (R._fillProbeProg) {
    const k = definesKey(R._fillProbeDefines || []);
    if (!variantCache.has(k))
      putVariant(k, { prog: R._fillProbeProg, u: null, pending: true, psoReady: false });
  }
  // The default entry reads the base program through getters, so a session that never draws the base never builds it (shaderPrograms.js).
  {
    const _bv = { psoReady: true, universal: true };
    let _bu = null;
    Object.defineProperty(_bv, 'prog', {
      enumerable: true,
      get() {
        return R.fillProg;
      },
    });
    Object.defineProperty(_bv, 'u', {
      enumerable: true,
      get() {
        return _bu || (_bu = captureFillUniforms(R.fillProg));
      },
      set(x) {
        _bu = x;
      },
    });
    putVariant(defaultKey, _bv);
  }

  // The BAKED omit-features a bundle can strip (cached on the bundle): every
  // baked feature it lacks. null = inspection unavailable → strip nothing baked.
  function bakedOmitFor(bundle) {
    if (bundle._fillBakedOmit !== undefined) return bundle._fillBakedOmit;
    let bits = null;
    try {
      bits = inspect(bundle);
    } catch {
      bits = null;
    }
    const omit = bits != null ? featuresToFillOmit(bits) : null;
    return (bundle._fillBakedOmit = omit);
  }
  // Identity matrices, zero offsets, and absent palette textures do not activate
  // the recolor path.
  function _isIdentityCm(m) {
    if (!m) return true;
    for (let i = 0; i < 16; i++) {
      const want = i % 5 === 0 ? 1 : 0; // diagonal
      if (Math.abs(m[i] - want) > 1e-6) return false;
    }
    return true;
  }
  function _isZeroOff(o) {
    if (!o) return true;
    for (let i = 0; i < 4; i++) if (Math.abs(o[i]) > 1e-6) return false;
    return true;
  }
  function drawUsesRecolor() {
    const d = R.draw;
    return !!(
      d.channelLerp ||
      (d.palette && d.palette.texture) ||
      !_isIdentityCm(d.colorMatrix) ||
      !_isZeroOff(d.colorMatrixOffset)
    );
  }
  // The draw's recolor omissions: all of recolor when the draw uses none, else each part it does not use.
  // ONE RECOLOR PROGRAM FOR A BUNDLE DECLARED both WAYS OR NOT AT ALL: under the stand-in-free policy the loading call builds every program a bundle's declared states bind, and a reach that names
  // both a color matrix and a channel lerp doubled the recolored half of its image (each key as drawn and rotated, canvas and render target) for one uniform-gated block of difference:
  // A scene that declares both for every bundle: folding them took 51 of its 180 programs, about 50 of its 230 pipelines and 17 s off its load. Such a draw leaves both blocks in; the draw sets each block's enabled
  // flag from its own state (uChannelLerpEnabled, uColorMatrixEnabled), so the pixels are the same and the two states ask for one key. A palette draw with neither keeps its own key.
  function pushRecolorOmits(defines, bundle) {
    if (!drawUsesRecolor()) {
      if (!defines.includes('MANTLE_NO_RECOLOR')) defines.push('MANTLE_NO_RECOLOR');
      return;
    }
    const usesCm = !_isIdentityCm(R.draw.colorMatrix) || !_isZeroOff(R.draw.colorMatrixOffset);
    const folded =
      (usesCm || !!R.draw.channelLerp) &&
      R.opts.standIns === false &&
      !!R._foldsRecolors &&
      !!bundle &&
      R._foldsRecolors(bundle);
    if (!R.draw.channelLerp && !folded && !defines.includes('MANTLE_NO_CHANNEL_LERP'))
      defines.push('MANTLE_NO_CHANNEL_LERP');
    if (!(R.draw.palette && R.draw.palette.texture) && !defines.includes('MANTLE_NO_PALETTE'))
      defines.push('MANTLE_NO_PALETTE');
    if (!usesCm && !folded && !defines.includes('MANTLE_NO_COLOR_MATRIX'))
      defines.push('MANTLE_NO_COLOR_MATRIX');
  }

  // Which kernel shades a cover quad: the constants and the per-type threshold live in
  // coverKernelPolicy.js, a module rather than a closure here so the decision can be asked without a GL
  // context.

  const meanShapePx2 = (bundle) => sharedMeanShapePx2(R, bundle);
  /// The draw rides the unified stream: an explicit MANTLE_LB_FILL, or a bundle the route takes.
  /// `R._coverOnlyDraw`: the row gate's cover run (aacPointsDraw.js) draws its rows as plain cover quads of an otherwise unified-eligible bundle:
  /// its program is the cover pass's own, not the unified stream's (whose census counts those rows as mesh rows and strips the cover kernel).
  const unifiedDraw = (bundle) =>
    R._coverOnlyDraw !== true &&
    ((R.opts.fillDefines || []).includes('MANTLE_LB_FILL') ||
      !!(R._unifiedFillEligible && R._unifiedFillEligible(bundle)));
  /// True when the bundle has no fill-bearing row, so every engine variant emits
  /// identical pixels: the defines only choose a renderFill*, and `doFill` is
  /// false everywhere. Selecting an engine here would compile and bind a second
  /// program to compute the same thing.
  const engineIsInert = (bundle) => !!bundle && bundle.numFillShapes === 0;

  // Small shapes stay on Slug because AAC's larger fragment kernel cannot be
  // amortized. Unknown geometry also resolves to Slug.
  /// forceSlug PINS THE COVER KERNEL TOO. It names Slug, and a measurement that sets it assumes
  /// both axes: the route carries no analytic geometry AND the cover fragments take Slug's walk.
  /// Read as a route-only switch it left auto free to pick AAC or a no-AA kernel, so the run came
  /// back with another engine's per-fragment cost filed under Slug's name. The ordinary way to
  /// select a kernel is `setFillEngine({ kernel })`, which this deliberately overrides — a force
  /// flag that an option can outvote is not a force flag.
  const forceSlugKernel = () => engineSelection(R).forceSlug;
  /// ...with ONE limit, and it has to be said rather than papered over: a renderer CONSTRUCTED with
  /// `aacFill: true` (or an explicit `fillDefines`) has the kernel baked into its BASE program, so
  /// there is no Slug program to select and no per-draw flag can undo it. Warn instead of quietly
  /// returning a Slug verdict for an AAC draw, which is the failure this whole pass is about.
  let _warnedBakedKernel = false;
  function _warnBakedKernel() {
    if (_warnedBakedKernel) return;
    _warnedBakedKernel = true;
    mantleWarn(
      '[mantle] __MANTLE_FORCE_SLUG cannot change the cover kernel of a renderer built with ' +
        'aacFill:true or explicit fillDefines — the define is compiled into the base program. ' +
        "Construct the renderer without them, or use setFillEngine({ kernel: 'slug' }).",
    );
  }

  function preferAac(bundle, coverAll) {
    R._autoAacGain = -1;
    R._autoAacPresence = -1;
    if (forceSlugKernel()) {
      // Report the engine that DREW, and clear the size facts with it: left from the last auto
      // decision they describe a choice this draw did not make.
      R._autoMeanShapePx2 = 0;
      R._autoSegsPerShape = 0;
      R._autoPx2PerSeg = 0;
      R._autoEngine = ENGINES.SLUG;
      return false;
    }
    // Stroke-only bundle: no renderFill* ever runs, so AAC and Slug are the same
    // picture and the same work. Take the base variant (no define) — it is the
    // one already compiled for everything else.
    if (engineIsInert(bundle)) {
      R._autoMeanShapePx2 = 0;
      R._autoSegsPerShape = 0;
      R._autoPx2PerSeg = 0;
      R._autoEngine = ENGINES.INERT;
      return false;
    }
    // A V-less bundle (engine:'aac' pinned at import) has one V band holding every
    // segment; Slug's vertical ray would walk all of them, per fragment. Never
    // route it to Slug, whatever its size.
    if (bundle && bundle.noVBands) {
      R._autoMeanShapePx2 = meanShapePx2(bundle);
      R._autoSegsPerShape = bundle.meanSegsPerShape || 0;
      R._autoPx2PerSeg = R._autoSegsPerShape
        ? R._autoMeanShapePx2 / R._autoSegsPerShape
        : R._autoMeanShapePx2;
      R._autoEngine = ENGINES.AAC;
      return true;
    }
    const px2 = meanShapePx2(bundle);
    // ON THE UNIFIED ROUTE, THE PRESENCE MODEL (coverKernelPolicy.aacPresenceTerms): AAC only when the px^2 it
    // saves on the cover rows it shades beats the px^2 its presence costs every other fragment of the draw.
    // The classic route keeps the fitted bundle-mean rule -- every
    // row there is a cover row, and a stroke row is the only fragment AAC does not shade.
    const cls =
      !coverAll && bundle && unifiedDraw(bundle) && R._unifiedRowClasses
        ? R._unifiedRowClasses(bundle)
        : null;
    let pick;
    if (cls) {
      const stats = shapeSegStats(bundle);
      const t = aacPresenceTerms(bundle, cls, stats && stats.types, unitPx2(R, bundle));
      R._autoAacGain = t.gain;
      R._autoAacPresence = t.presence;
      // ONE KEY FOR A STREAM'S whole LIFE means the engine too. A stream's rows are meshes; a section that cannot take one this frame leaves a cover row whose area is the section's, so the gate reads a
      // bundle the warm never saw and moves the key (a road band declined on a bend: the other kernel's program, first built in play at the reuse deadline). The kernel it would pick draws the same picture.
      const oneKey = oneKeyStream(bundle);
      pick = !oneKey && t.rows > 0 && t.gain > t.presence;
      if (R._variantProbe && !oneKey) {
        const pb = aacPresenceBreak(bundle, cls, stats && stats.types);
        if (!pb.always && !pb.never) R._probeAacFlips = true;
      }
    } else {
      pick = aacClassicPick(
        (bundle && bundle.meanFillShapeArea) || 0,
        aacBundleFloor(bundle),
        unitPx2(R, bundle),
      );
      if (R._variantProbe) {
        const k2 = aacClassicBar((bundle && bundle.meanFillShapeArea) || 0, aacBundleFloor(bundle));
        if (k2 > 0 && Number.isFinite(k2)) R._probeAacFlips = true;
      }
    }
    // (the warm image's probe asks a re-flowable bundle's key under each outcome: its content, and with it the gate's data, changes after loading;
    // R._probeAacFlips tells it the gate has a bar at some unit px2 in (0, inf), which a draw's world matrix reaches: wantKeysOf)
    if (R._variantProbe && R._probeAacPick !== undefined) pick = R._probeAacPick;
    R._autoMeanShapePx2 = px2;
    R._autoSegsPerShape = (bundle && bundle.meanSegsPerShape) || 0;
    R._autoPx2PerSeg = R._autoSegsPerShape ? px2 / R._autoSegsPerShape : px2; // surfaced via renderer.debugStats
    R._autoEngine = pick ? ENGINES.AAC : ENGINES.SLUG;
    return pick;
  }

  const NOAA_BANDHARD_MAX_SEGS = 64;
  const NOAA_MIN_STROKE_PX = 2; // (a covering stroke hides the fill's edge from this many device px, in its thinnest direction: both no-AA gates, and their bar in the warm image's scale domain)
  // A pinned no-AA kernel (setFillEngine({kernel:'hard-band'|'hard-tree'})) answers this same question, so every consumer
  // of it -- the variant, the LB route veto, _lbWouldServe, prewarm -- follows the pin as it follows auto's choice.
  function pinnedNoAa() {
    return R.opts.fillKernel === ENGINES.HARD_BAND || R.opts.fillKernel === ENGINES.HARD_TREE;
  }
  // Does this bundle's no-AA draw walk the GWN tree? A tree pin needs a tree to walk (without one it draws band-hard);
  // a band pin never does; auto uses the tree exactly when the importer baked it for a covered cubic/arc fill.
  function treeFor(bundle) {
    if (!bundle) return false;
    if (R.opts.fillKernel === ENGINES.HARD_TREE) return !!(bundle.noAaTree || bundle.gwnTree);
    if (R.opts.fillKernel === ENGINES.HARD_BAND) return false;
    return !!bundle.noAaTree;
  }
  function preferNoAa(bundle) {
    if (forceSlugKernel()) return false; // see forceSlugKernel: it outranks the pin
    if (pinnedNoAa()) return !!bundle; // pinned: the caller asserted the kernel
    if (R.opts.aacFill !== 'auto') return false; // only the auto path routes no-AA
    if (!bundle || !bundle.noAaFill) return false; // not all fills are stroke-covered
    if (R.draw.overrides || R.draw.alpha < 0.996 || drawUsesRecolor()) return false;
    const mask = bundle.segTypeMask || 0xf;
    // cubic/arc: band-hard, unless the bundle was imported with noAaTree (then tree-hard walks the baked GWN tree).
    // Without the tree (e.g. a MORPH — the tree is too costly to rebuild per frame) band-hard is
    // the only no-AA option, and it beats AAC only below NOAA_BANDHARD_MAX_SEGS; above that, AA.
    if (
      mask & ((1 << 2) | (1 << 3)) &&
      !bundle.noAaTree &&
      (bundle.meanSegsPerShape || 0) > NOAA_BANDHARD_MAX_SEGS
    )
      return false;

    if ((bundle.minStrokeEmW || 0) * minLinearScalePx(R, bundle) < NOAA_MIN_STROKE_PX) return false;
    return true;
  }
  // Let the static LB gate prefer this cheaper route when its proof holds.
  R._preferNoAa = preferNoAa;

  /// Per-row hard fill (MANTLE_HARD_MIXED): SOME rows are opaque-stroke-covered.
  /// preferNoAa above needs every fill covered, because it swaps the whole program;
  /// this one keeps the AA kernel and lets the covered rows take a cheaper branch,
  /// selected from meta bits the importer stamped. The branch is spatially coherent
  /// — each shape owns its cover quad — so the rows that stay on AA pay nothing but
  /// the compare.
  ///
  /// The per-draw conditions are the same ones preferNoAa tests, and for the same
  /// reasons: an override can move or restyle a shape out from under the proof, a
  /// translucent draw or a recolor makes the covering stroke stop covering, and a
  /// stroke thinner than ~2px on screen no longer hides the fill's edge.
  function preferNoAaMixed(bundle) {
    if (forceSlugKernel()) return false;
    if (R.opts.fillKernel) return false; // a pinned kernel is the whole bundle's
    if (R.opts.aacFill !== 'auto') return false;
    if (!bundle || !bundle.noAaMixed) return false;
    if (bundle.noAaFill) return false; // whole-bundle path is cheaper; it wins
    if (R.draw.overrides || R.draw.alpha < 0.996 || drawUsesRecolor()) return false;
    if ((bundle.minStrokeEmWMixed || 0) * minLinearScalePx(R, bundle) < NOAA_MIN_STROKE_PX)
      return false;
    return true;
  }
  R._preferNoAaMixed = preferNoAaMixed;

  /// The extra FRAGMENT defines the instanced fast path should compile for a bundle — Slug (MANTLE_AAC absent)
  /// or AAC, and the band layout either way. Same size gate as the
  /// non-instanced path (preferAac), so a large bundle instanced N times gets AAC's per-fragment win multiplied across
  /// all N. (no-AA is Slug/AAC-only here: it needs an opaque covering stroke, which the fill-only instanced fast path
  /// doesn't draw.)
  function instancedEngineDefines(bundle) {
    // coverAll: this path is only reached when `_lbWouldServe` already declined (drawDispatch), so
    // no row of this draw takes a mesh and the whole bundle is cover quads. Passing the per-shape
    // pick set here would price the kernel over a remainder that does not exist on this path.
    const wantAac = forceSlugKernel()
      ? false
      : R.opts.aacFill === 'auto'
        ? preferAac(bundle, true)
        : !!R.opts.aacFill;
    const defs = wantAac ? ['MANTLE_AAC'] : [];
    if (bundle && bundle.pairBands) defs.push('MANTLE_AAC_PAIR_BANDS');
    return defs;
  }
  R._instancedEngineDefines = instancedEngineDefines;

  /// A stream whose key is one for its whole life: every segment-type kernel and analytic-kind block in, whatever it holds now. A stream built as one under the stand-in-free policy, where a key
  /// that moved would block, and a bundle the app declared a stream (renderer.declareStream), under any policy.
  function oneKeyStream(bundle) {
    return (
      !!bundle &&
      bundle.streamable === true &&
      (R.opts.standIns === false || bundle._streamDeclared === true)
    );
  }
  /// The omissions the instanced fast path compiles into its program. These are a fill variant's
  /// MANTLE_NO_* defines for this bundle and draw: the bundle's baked feature omissions and the draw's recolor ones. Nothing that changes the vertex format (the
  /// LB and CPatch streams, the cover kernel id) or the kernel (instancedEngineDefines picks that).
  function instancedOmitDefines(bundle) {
    if (R.opts.disableFillVariants || !bundle) return [];
    const baked = bakedOmitFor(bundle);
    const omit = baked ? baked.slice() : [];
    // (as variantDefinesForOne: a shared table that gives a row a stroke width paints a stroke the bundle's rows do not carry)
    if (
      omit.includes('stroke') &&
      R.draw &&
      R.draw.overrides &&
      overridesRaiseStroke(R.draw.overrides)
    )
      omit.splice(omit.indexOf('stroke'), 1);
    const defines = omitDefinesFor(omit);
    pushRecolorOmits(defines);
    // Use the same conservative type mask as ordinary cover draws. Missing
    // masks keep all kernels; streamed and morph masks cover every pose.
    // (a declared stream's instanced program holds every type, as its fill key does: a type its update brings is not a new program)
    const types =
      R.opts.typeOmit !== false && bundle._streamDeclared !== true
        ? bundle.segTypeMask || 0xf
        : 0xf;
    for (let i = 0; i < 4; i++)
      if (!(types & (1 << i)) && !defines.includes(SEGMENT_TYPE_DEFINES[i]))
        defines.push(SEGMENT_TYPE_DEFINES[i]);
    return defines;
  }
  R._instancedOmitDefines = instancedOmitDefines;

  /// Start compiling the fill variants this bundle may use. Safe to call repeatedly.

  function bundleHasFilters(bundle) {
    if (bundle.filterGraphs && bundle.filterGraphs.some(Boolean)) return true;
    const dl = bundle.drawList;
    if (dl) for (const op of dl) if (op.filterId || op.filterGraphId) return true;
    return false;
  }
  function prewarmFillVariant(bundle) {
    // A disposed bundle — or a spent transplant shell (textBundle.setText) — owns no GL
    // objects. Warming it compiles variants for content that no longer exists, and the
    // PSO warm below would bind its dead textures.
    if (!bundle || bundle._disposed) return;
    noteLive(bundle);
    if (R._declaredReach) R._declaredReach(bundle); // (a declared need is linked with its bundle, whether or not a manifest covers it)
    // A manifest that knows this bundle names the states it is drawn in; they are built by drawing them (precompileFills), not by linking every
    // candidate engine's program up front.
    if (R._wmCovers && R._wmCovers(bundle)) return;
    try {
      // coverSet: the loading call plans the scene's variants as a whole and compiles the maximal ones only (planCover), not every candidate.
      if (R.opts.coverSet !== true)
        for (const eng of variantEnginesFor(bundle)) {
          const defines = variantDefinesFor(bundle, eng.aac, eng.noAa, eng.mixed);
          const target = compileVariant(defines, 'fill:prewarm:', bundle);
          rememberWarmTarget(bundle, target.key, false);
          // ...and its cover sibling, which an override draw of the same bundle binds (see variantDefinesFor)
          if (defines.includes('MANTLE_NO_COVER_FILL')) {
            const sibling = compileVariant(
              defines.filter((d) => d !== 'MANTLE_NO_COVER_FILL'),
              'fill:prewarm:',
              bundle,
            );
            rememberWarmTarget(bundle, sibling.key, false);
          }
        }
      if (R._beginInstancedForBundle) R._beginInstancedForBundle(bundle);
      if (R._aacPointsWarm) R._aacPointsWarm(bundle);
      if (R._beginFilterPrograms && bundleHasFilters(bundle)) R._beginFilterPrograms();
    } catch {
      /* prewarm is best-effort: a failure just means the draw path compiles it */
    }
  }

  /// What asking to start a key that failed to link answers: an entry in no cache, with nothing to wait for and nothing to build. Its program is a null no draw reaches, since selection answers
  /// from _linkFailed first.
  const failedVariant = (key) => ({
    key,
    prog: null,
    u: null,
    pending: false,
    psoReady: true,
    failed: true,
  });
  /// Start compiling one variant, if nothing has yet. Returns its cache entry.
  function compileVariant(defines, label, bundle) {
    const key = definesKey(defines);
    let v = variantCache.get(key);
    if (v) {
      if (v.universal) void v.prog;
      return v;
    } // (a bundle whose own key IS the base: build it here, at warm time)
    if (_linkFailed.has(key)) return failedVariant(key);
    const prog = R.program(
      R.withDefines(R.shaderSources.fillVert, defines),
      R.withDefines(R.shaderSources.fillFrag, defines),
      label + (key || 'full'),
    );
    return putVariant(key, {
      prog,
      u: null,
      pending: true,
      psoReady: false,
      bundleRef: bundleRefOf(bundle),
    });
  }
  /// The bundle that asked for a variant, held weakly: the class unions (below) warm a variant by drawing a bundle of its class, and a
  /// disposed bundle must not be kept alive by the variant cache.
  function bundleRefOf(bundle) {
    if (!bundle) return null;
    return typeof WeakRef === 'function' ? new WeakRef(bundle) : { deref: () => bundle };
  }

  /// Which engines might this bundle be drawn with? `aacFill:'auto'` decides per draw from the
  /// on-screen size, which load time cannot know — so prewarm all candidates and let the draw pick.
  function variantEnginesFor(bundle) {
    if (pinnedNoAa()) return [{ aac: false, noAa: true }]; // exactly the pinned variant
    if (R.opts.aacFill === 'auto') {
      // No fill row ⇒ every candidate compiles to the same pixels; warm one.
      if (engineIsInert(bundle)) return [{ aac: false }];
      const out = bundle && bundle.noVBands ? [{ aac: true }] : [{ aac: false }, { aac: true }];
      if (bundle && bundle.noAaFill) out.push({ aac: false, noAa: true }); // band-hard candidate
      // Per-row hard rides ON TOP of an AA kernel, so it needs a candidate for each
      // one the selector might pick — warming only the Slug pairing would leave the
      // AAC pairing to compile mid-draw, which is the stall prewarming exists to avoid.
      if (bundle && bundle.noAaMixed && !bundle.noAaFill) {
        out.push({ aac: false, mixed: true });
        if (!(bundle && bundle.noVBands)) out.push({ aac: true, mixed: true });
      }
      return out;
    }
    return [{ aac: !!R.opts.aacFill }];
  }

  /// Both stages get the defines. Specializing only the fragment would work for
  /// defines that add fragment-only code (MANTLE_NO_*, MANTLE_AAC) and fail the
  /// moment a variant adds a VARYING: the fragment declares it, the vertex does
  /// not, and the program fails to link with "FRAGMENT varying X does not match
  /// any VERTEX varying". MANTLE_LB_FILL is such a variant.

  /** @type {ReadonlyArray<[number, string]>} */
  const LB_OMITTABLE_KINDS = Object.freeze([
    [7, 'DISC'],
    [10, 'EDGE_STRIP'],
    [12, 'CURVE_BAND'],
    [13, 'CHAIN_STRIP'],
  ]);

  /// How engines are combined. Two rules, and they answer different questions — collapsing them
  /// into one is what produced three mechanisms wearing one name.
  ///
  /// 1. WHICH KERNELS ARE COMPILED IN = what the bundle's geometry CONTAINS. Loop-Blinn's kinds,
  ///    CPatch and the SDF primitives are distinct GEOMETRY: a shape either produced that geometry
  ///    or it did not. Each publishes itself into one kind mask (_lbKindMask ORs every mesh's), and
  ///    a kernel absent from the mask is stripped. The union is not free — a kernel that merely
  ///    exists costs 2-5% on this shader — so it is driven by presence and nothing else. This is
  ///    what lets one bundle hold a CPatch shape, a Loop-Blinn shape and a primitive and still draw
  ///    them in ONE pass, which is the only arrangement that does not pay to switch engines
  ///    between shapes.
  ///
  /// 2. WHICH COVER-QUAD KERNEL SERVES THE REST = a policy decision for this draw. Slug, AAC and
  ///    the no-AA kernels (MANTLE_HARD / GWN / HARD_TREE / HARD_MIXED) are NOT different geometry —
  ///    they all consume the same band data from the same cover quad and differ only in how they
  ///    integrate coverage. Choosing between them is a question about accuracy and speed for this
  ///    draw, which is why they are selected by predicates (preferNoAa, preferAac) rather than by
  ///    presence, and why that is correct rather than an inconsistency to be flattened.
  ///
  /// MANTLE_LB_FILL names rule 1's WIRE, not Loop-Blinn: it says this draw uses the unified fill
  /// stream and its varyings, which CPatch and the primitives ride too. It keeps that name
  /// because callers pass it through opts.fillDefines and unifiedFillDraw tests for it; the
  /// name is narrower than the meaning.
  // ---- THE SCENE UNION ------------------------------------------------------------------------------------------------
  // renderer.setSceneUnion(bundles) declares the bundles one scene draws. Bundles whose programs agree on everything that changes a
  // program's KERNEL or its WIRE (the unified-stream define, the morph layout, the cover kernel set, the AAC footprint) then bind ONE
  // program: its presence defines are the union of theirs (a kernel any of them needs is compiled in) and its omissions their
  // intersection (a block is left out only if every one of them leaves it out). So a CPatch bundle and an LB bundle that would have
  // been two programs are one, and a scene's programs, links and first-pipeline builds shrink to the count of distinct kernel classes.
  // The union program is a SUPERSET of each member's lean one, so every member renders the same pixels (kernel presence costs time,
  // never output); the price is that presence, and it is what the mixed-scene pages measure. Bundles that disagree on the class keep
  // their own lean program, and a bundle not declared is untouched. Cleared with setSceneUnion(null).
  let _sceneSet = null,
    _sceneGen = 0,
    _autoSceneN = 0;
  function setSceneUnion(bundles) {
    _sceneSet =
      bundles && bundles.length
        ? new Set(bundles.map((b) => unwrapBundle(b)).filter(Boolean))
        : null;
    _sceneGen++;
    for (const b of _sceneSet || []) {
      try {
        prewarmFillVariant(b);
      } catch {
        /* best effort */
      }
    }
  }
  R.setSceneUnion = (bundles) => {
    R._userSceneUnion = true;
    setSceneUnion(bundles);
  };
  /// The defines selectFillVariant would bind for this bundle now (the scene union included); for tests and the mixed-frame probe.
  R._variantDefinesNow = (bundle) => {
    const noAa = preferNoAa(bundle),
      mixed = noAa ? false : preferNoAaMixed(bundle);
    const aac = noAa ? false : R.opts.aacFill === 'auto' ? preferAac(bundle) : !!R.opts.aacFill;
    return variantDefinesFor(bundle, aac, noAa, mixed);
  };
  function sceneUnionDefines(bundle, own, useAac, useNoAa, useMixed) {
    if (!_sceneSet || !_sceneSet.has(bundle) || _sceneSet.size < 2) return own;
    const savedAuto = R._autoEngine;
    const others = [];
    try {
      for (const m of _sceneSet) {
        if (m === bundle || m._disposed) continue;
        // the member's own flags, as selectFillVariant derives them
        const mNoAa = preferNoAa(m),
          mMixed = mNoAa ? false : preferNoAaMixed(m);
        const mAac = mNoAa ? false : R.opts.aacFill === 'auto' ? preferAac(m) : !!R.opts.aacFill;
        others.push(variantDefinesForOne(m, mAac, mNoAa, mMixed));
      }
    } finally {
      R._autoEngine = savedAuto;
    }
    return mergeSceneDefines(own, others);
  }
  function variantDefinesFor(bundle, useAac, useNoAa, useMixed) {
    const own = variantDefinesForOne(bundle, useAac, useNoAa, useMixed);
    let defs = _sceneSet ? sceneUnionDefines(bundle, own, useAac, useNoAa, useMixed) : own;
    // Measurement-only ordered CPatch runs. This scope belongs to a proven span,
    // never to the whole bundle or its scene union.
    if (R._uniCpAreaPass && defs.includes('MANTLE_CPATCH')) {
      defs = defs.filter(
        (d) => d !== 'MANTLE_CPATCH_NO_QUADRATIC_AREA' && d !== 'MANTLE_CPATCH_QUADRATIC_AREA_ONLY',
      );
      if (R._uniCpAreaPass === 'area') {
        for (const d of [
          'MANTLE_CPATCH_QUADRATIC_AREA_ONLY',
          'MANTLE_NO_COVER_FILL',
          'MANTLE_NO_STROKE',
        ])
          if (!defs.includes(d)) defs.push(d);
      } else defs.push('MANTLE_CPATCH_NO_QUADRATIC_AREA');
    }
    // (not a stream's under the stand-in-free policy, whose key is one for its whole life, variantDefinesForOne: the first update takes the certificate away, and the key it left was linked in play)
    if (
      !defs.includes('MANTLE_ROTATED_MAP') &&
      !defs.includes('MANTLE_NO_COVER_FILL') &&
      !defs.includes('MANTLE_LB_FILL') &&
      !defs.includes('MANTLE_CPATCH') &&
      !oneKeyStream(bundle) &&
      monotoneCubicDrawEligible(bundle, R.draw)
    )
      defs = [...defs, 'MANTLE_NO_CUBIC_SPLITS'];
    return defs;
  }
  function variantDefinesForOne(bundle, useAac, useNoAa, useMixed) {
    // WHICH FILL ROWS RIDE THE UNIFIED STREAM AS COVER QUADS (unifiedFillDraw._unifiedCoverRows): the key an
    // eligible bundle's unified draw binds may leave out a cover kernel no row of it reaches. The classic
    // fill pass draws every row as a cover quad, so selectFillVariant never lets IT bind a key that left
    // the whole kernel out (MANTLE_NO_COVER_FILL): it takes the base program instead.
    const coverCensus =
      unifiedDraw(bundle) && R._unifiedCoverRows ? R._unifiedCoverRows(bundle, true) : -1;
    const covRows = coverCensus < 0 ? -1 : coverCensus & 3;
    const coverPaintOnly = coverCensus >= 0 && (coverCensus & 8) !== 0 && (coverCensus & 4) === 0;

    if (
      R.opts.aacFill === 'auto' &&
      !R.opts.fillKernel &&
      (useAac || useNoAa || useMixed) &&
      covRows !== -1
    ) {
      if (covRows === 0) {
        useAac = false;
        useNoAa = false;
        useMixed = false;
      } else {
        if (useMixed && !(covRows & 2)) useMixed = false;
        if (useAac && useMixed && !(covRows & 1)) useAac = false;
      }
    }
    const baked = bakedOmitFor(bundle);
    // Mutate a fresh array only when baking; otherwise start empty (no slice).
    const omit = baked ? baked.slice() : [];
    // An override table that gives a row a stroke width paints a stroke the bundle's rows do not carry: keep the stroke walk.
    if (
      omit.length &&
      R.draw &&
      R.draw.overrides &&
      omit.includes('stroke') &&
      overridesRaiseStroke(R.draw.overrides)
    )
      omit.splice(omit.indexOf('stroke'), 1);
    let defines = omitDefinesFor(omit);
    const optDefs = R.opts.fillDefines;
    if (optDefs)
      for (let i = 0; i < optDefs.length; i++) {
        const d = optDefs[i];
        if (!defines.includes(d)) defines.push(d);
      }
    pushRecolorOmits(defines, bundle);
    // A pinned engine, or primitives turned off, keeps its walk on a tagged circle or round rect past the float32 bound (primDeep, mantle.frag.glsl): only 'auto' or primitives: 'on' may take the closed form.
    if (
      ((R._forcedCover || R._forcedKernel || R.opts.fillKernel) &&
        R._forcedPrimitivesOn !== true) ||
      R._forcedPrimitivesOn === false
    )
      defines.push('MANTLE_PRIM_WALK');
    // A GWN kernel walks the run tree the IMPORTER bakes. Ask for the kernel without asking
    // for the tree and it reads a header that was never written: the shader renders nothing,
    // silently, and a blank canvas gives you no way to find that out. Say it once, per bundle.
    // (MANTLE_HARD without MANTLE_HARD_TREE is the BAND walk — MANTLE_GWN only rides along to
    // compile the kernel in, and it needs no tree. Don't warn about that one.)
    const _fd = R.opts.fillDefines || [];
    const _needsTree =
      _fd.includes('MANTLE_HARD_TREE') ||
      (_fd.includes('MANTLE_GWN') && !_fd.includes('MANTLE_HARD'));
    if (bundle && !bundle.gwnTree && !bundle._gwnWarned && _needsTree) {
      bundle._gwnWarned = true;
      console.warn(
        '[mantle] this renderer compiles a GWN fill kernel, but the bundle has no GWN ' +
          'run tree and will render EMPTY. Import it with importSvg(svg, { gwnTree: true }).',
      );
    }
    // VETO: the anti-aliased GWN+SDF kernel (the opt-in MANTLE_GWN define) cannot fill a self-closing cubic (blank), a cubic loop
    // or a cusp (off by tens of pixels): the type-6 hard pieces those need exist only in tree-hard mode. A bundle the importer
    // marked `gwnUnsafe` therefore draws with the AAC / Slug kernel the program would otherwise be, which is exact for them.
    if (
      bundle &&
      bundle.gwnUnsafe &&
      !useNoAa &&
      !useMixed &&
      defines.includes('MANTLE_GWN') &&
      !defines.includes('MANTLE_HARD')
    ) {
      defines = defines.filter((d) => d !== 'MANTLE_GWN');
      if (!bundle._gwnVetoWarned) {
        bundle._gwnVetoWarned = true;
        console.warn(
          '[mantle] the GWN fill kernel is vetoed for this bundle: it holds a self-closing cubic, loop or cusp, which GWN+SDF anti-aliasing cannot fill; drawing with the AAC/Slug kernel.',
        );
      }
    }
    // no-AA band-hard: MANTLE_HARD selects renderFillHardBand (it precedes every other
    // coverage branch in the frag #if chain, so MANTLE_GWN here is inert — kept to match
    // the validated config). Mutually exclusive with MANTLE_AAC.
    if (useNoAa) {
      if (!defines.includes('MANTLE_HARD')) defines.push('MANTLE_HARD');
      // cubic/arc tree-hard: the GWN run tree (baked at build) walks winding-only; MANTLE_HARD_TREE
      // selects renderFillGWNSDF over renderFillHardBand. Band-hard (line/quad) omits it.
      if (treeFor(bundle) && !defines.includes('MANTLE_HARD_TREE'))
        defines.push('MANTLE_HARD_TREE');
      if (!defines.includes('MANTLE_GWN')) defines.push('MANTLE_GWN');
    }
    // Per-row hard: keep the AA kernel (AAC or Slug) and add the MIXED branch, so
    // stroke-covered rows go hard while the rest are untouched. Mutually exclusive
    // with the whole-bundle MANTLE_HARD above, which needs no per-row test at all.
    if (!useNoAa && useMixed && !defines.includes('MANTLE_HARD_MIXED')) {
      defines.push('MANTLE_HARD_MIXED');
      // Band-hard only. Without MANTLE_HARD_TREE the MIXED program deliberately
      // omits the GWN run-tree kernel (~+15-70% occupancy cost), and no row is
      // stamped 3, so nothing asks for it.
      if (!defines.includes('MANTLE_GWN')) defines.push('MANTLE_GWN');
    }
    // Unified LB fill. Hosting the Loop-Blinn coverage in this shader is what lets
    // a bundle's cover quads and LB triangles go in ONE drawArrays, so it is
    // selected per bundle here rather than compiled into the base program — the
    // define declares the LB attributes and pulls lbCoverage() in, and a bundle
    // with no LB mesh should carry neither.
    if (
      R._coverOnlyDraw !== true &&
      R._unifiedFillEligible &&
      R._unifiedFillEligible(bundle) &&
      !defines.includes('MANTLE_LB_FILL')
    )
      defines.push('MANTLE_LB_FILL');
    //
    // The key then depends on per-draw state: a transform or fill override puts a row back on its cover quad, so the
    // same bundle drawn under an override table wants the key WITHOUT the define -- its COVER SIBLING. A warm that
    // built only the no-override key left that one cold, and the first frames of an override draw declined to the
    // classic pass while later ones drew the unified route (loopBlinnRenderDiffSmoke). So every warm of a key
    // carrying this define warms its sibling beside it (_warmCoverSibling); R._uniCoverFill is how it asks for it.
    // (a stream with cover rows keeps the kernel while every section has a mesh: the first section that cannot take one this frame needs it, and its key is one for life. One built with no cover rows never does.)
    if (
      covRows === 0 &&
      !R._uniCoverFill &&
      defines.includes('MANTLE_LB_FILL') &&
      !defines.includes('MANTLE_LB_FILL_COV') &&
      !defines.includes('MANTLE_NO_COVER_FILL') &&
      !(oneKeyStream(bundle) && bundle.drawList && bundle.drawList.length)
    )
      defines.push('MANTLE_NO_COVER_FILL');
    //
    // AND THAT PATH CANNOT REACH this DEFINE, which is containment rather than luck: the instanced
    // program is built by `R._ensureInstProg([...])` from its own define list and never passes
    // through variantDefinesFor, so MANTLE_COVER_KERNEL cannot be compiled into a draw whose vertex
    // format has no aLbMeta to read the id from. If step (4) ever routes the instanced path through
    // here, it needs the meta-row source (flagsShape widened at bits 15-16 into free bit 17) first,
    // or every hard row on it would silently shade with the AA kernel.
    if (defines.includes('MANTLE_LB_FILL') && defines.includes('MANTLE_HARD_MIXED')) {
      defines.splice(defines.indexOf('MANTLE_HARD_MIXED'), 1);
      defines.push('MANTLE_COVER_KERNEL');
    }
    // Measurement hook: extra fill defines from a probe (globalThis.__MANTLE_FILL_DEFINES, comma-separated), so a kernel's own
    // debug switches can be A/B'd in one run the way __CP_DEFINES does for CPatch. Read only under __MANTLE_DEBUG__; unset
    // appends nothing and the variant key follows.
    const _xfd = mantleDebugHook('__MANTLE_FILL_DEFINES');
    if (_xfd)
      for (const d of String(_xfd).split(',')) {
        const t = d.trim();
        if (t && !defines.includes(t)) defines.push(t);
      }
    // MORPH pair: six more attributes and a uMorphT mix in the vertex stage. A
    // separate variant rather than a uniform branch, because the attributes
    // themselves only exist here — and it is keyed off the BUNDLE, so a scene
    // holding both a morph and a static bundle compiles one of each.
    if (
      R._unifiedMorphEligible &&
      R._unifiedMorphEligible(bundle) &&
      !defines.includes('MANTLE_LB_MORPH')
    )
      defines.push('MANTLE_LB_MORPH');

    if (
      R.opts.unifiedFillCurveTex !== false &&
      !(bundle && bundle._noCurveTex) &&
      defines.includes('MANTLE_LB_FILL') &&
      !defines.includes('MANTLE_LB_CURVE_TEX')
    )
      defines.push('MANTLE_LB_CURVE_TEX');
    // LB coverage is itself componentized, by KIND. Each of these guards one
    // block of the per-kind dispatch, and a bundle only reaches the kinds its
    // meshes packed — so this is the same omit-define mechanism as
    // MANTLE_NO_GRADIENT, applied one level down. (Kinds 4 and 12 already ride
    // MANTLE_NO_BEZOUT; kinds 0/2/5 are present in essentially every mesh.)
    // CPATCH IS ITS own ENGINE, so its define is its own: MANTLE_CPATCH, not MANTLE_LB_CPATCH,
    // and the question that turns it on is "does CPatch own this bundle's meshes?" — asked of the
    // OWNER, not of bit 14 of Loop-Blinn's kind mask. Keying it on that bit would make "is this
    // CPatch?" a question about Loop-Blinn's kind space, the coupling that lets a CPatch decline
    // be served by LB and reported as CPatch.
    // Still conditioned on MANTLE_LB_FILL because the two engines share the unified fill stream
    // and its varyings — a shared WIRE, which is the part worth sharing — but the kernel it
    // compiles in lives in _cpatchCoverage.glsl and has nothing to do with Loop-Blinn.
    // PRESENCE, NOT OWNERSHIP — the same rule every other kernel here obeys. Loop-Blinn's kinds are
    // chosen by what the bundle's geometry CONTAINS (the kind mask below strips the ones it does
    // not), and CPatch publishes itself into that mask as bit CP_STREAM_TAG. Selecting it by
    // `_fillMeshOwner === 'cpatch'` instead, a per-BUNDLE field that says the bundle is wholly
    // CPatch or wholly not, would leave a bundle unable to hold CPatch geometry beside Loop-Blinn
    // geometry, and a recognized circle unable to be an SDF primitive inside an otherwise-CPatch bundle.
    //
    // Reading the mask instead costs nothing and composes: a bundle carrying both gets both kernels
    // in ONE program, and therefore one stream and one draw, which is the only arrangement that
    // does not pay for switching engines between shapes. The union is not free -- a kernel that
    // merely exists costs a few percent on this shader, and MANTLE_LB_FILL compiled into a Slug
    // program costs several percent more -- so it is driven by what is actually present and nothing more.
    //
    // The owner field remains the fallback for a bundle whose meshes cannot be inspected (mask -1).
    const CP_MASK_BIT = 1 << 14; // CPATCH_STREAM_TAG in cpatchPack.js
    if (defines.includes('MANTLE_LB_FILL') && !defines.includes('MANTLE_CPATCH')) {
      const kmC = R._lbKindMask ? R._lbKindMask(bundle) : -1;
      const hasCpatch =
        kmC === -1 ? !!(bundle && bundle._fillMeshOwner === 'cpatch') : !!(kmC & CP_MASK_BIT);
      if (hasCpatch) defines.push('MANTLE_CPATCH');
    }
    // Its seams are owned on every draw: the patch whose side the pixel's center is on paints what the shape covers there,
    // exact under OVER and under a depth claim alike (translucent content, morphs: one patch wins the depth test, the other is
    // discarded). A seam that relaxed near the outline would have the two patches each paint a piece of the pixel, sound only
    // when both PAINT. Owned seams are the kernel's only composition, so there is no seam variant to pick here.
    if (defines.includes('MANTLE_CPATCH')) {
      if (R._cpatchHasQuadraticArea && R._cpatchHasQuadraticArea(bundle) === false)
        defines.push('MANTLE_CPATCH_NO_QUADRATIC_AREA');

      if (
        R._cpatchHasCubicArea &&
        R._cpatchHasCubicArea(bundle) === false &&
        !defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA')
      )
        defines.push('MANTLE_CPATCH_NO_CUBIC_AREA');
      if (
        !defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA') &&
        R._cpatchOnlyQuadraticArea &&
        R._cpatchOnlyQuadraticArea(bundle) &&
        defines.includes('MANTLE_NO_COVER_FILL') &&
        defines.includes('MANTLE_NO_STROKE')
      )
        defines.push('MANTLE_CPATCH_QUADRATIC_AREA_ONLY');
      // And the seam companion's code only where a seam packed one: see R._cpatchHasComp.
      if (R._cpatchHasComp && R._cpatchHasComp(bundle) && !defines.includes('MANTLE_CPATCH_COMP'))
        defines.push('MANTLE_CPATCH_COMP');
      // EXTRA DEFINES FROM A PROBE, so the kernel's own switches can be A/B'd in ONE run. The
      // shader carries a dozen of them (MANTLE_CPATCH_HARD, _NO_FAROUT, _ONLYCUT, ...), and reaching
      // one by editing the file means a separate run and a separate GPU state -- and a cross-run
      // GPU comparison drifts by tens of percent. Read only under
      // __MANTLE_DEBUG__: an unset global appends nothing and the variant key is unchanged.
      const extra = mantleDebugHook('__CP_DEFINES');
      if (extra)
        for (const d of String(extra).split(',')) {
          const t = d.trim();
          if (t && !defines.includes(t)) defines.push(t);
        }
    }

    if (defines.includes('MANTLE_LB_FILL') && R.opts.lbKindOmit !== false) {
      const km = R._lbKindMask ? R._lbKindMask(bundle) : -1;
      if (km !== -1) {
        for (const [k, name] of LB_OMITTABLE_KINDS) {
          const d = `MANTLE_LB_NO_${name}`;
          if (!(km & (1 << k)) && !defines.includes(d)) defines.push(d);
        }
      }
      // ...AND THE whole BEZOUT TIER, by the same presence rule. The shader guards three
      // separate things with MANTLE_NO_BEZOUT — the kind-4 3×3 determinant and its cofactor
      // gradient, the kind-12 curve band, and the interior chain's second arc — and drops
      // aC1/aC2 from the vertex stage with them (two vec4 varyings, and two texel fetches per
      // vertex under MANTLE_LB_CURVE_TEX). The packer publishes the answer per mesh
      // (`hasBezout`, which already ORs `interiorHasChain2`), across the worker wire.
      //
      // Not for cpatch. CPatch shares this vertex stream and parks its oriented bounding box in
      // exactly those slots (cBoxA/cBoxU/cBoxV = vLB1/vLB2), so a CPatch program must keep the
      // full setup whatever Loop-Blinn's meshes say. That is why this sits AFTER the
      // MANTLE_CPATCH decision rather than beside the kind mask it otherwise mirrors.
      if (
        !defines.includes('MANTLE_CPATCH') &&
        !defines.includes('MANTLE_NO_BEZOUT') &&
        R._lbNoBezout &&
        R._lbNoBezout(bundle)
      )
        defines.push('MANTLE_NO_BEZOUT');
      // ...AND THE KIND-4 DETERMINANT ON ITS own, where the tier stays for another reason. A straight
      // outline's chain faces carry chain 2 in aC1/aC2, which keeps MANTLE_NO_BEZOUT off -- and that
      // compiled the Bezout crescent's 3x3 determinant and cofactor gradient into a bundle with no
      // kind-4 piece: lbPartialAdoption's frames went 0.1 -> 0.35 ms on the GPU (1.15/1.46/2.13x) when
      // its stars took the chain route. Same presence rule as the kinds above, read off the same mask
      // (kind 4 = CUBIC_BEZ). Static meshes only: a morph pair pack records no kind mask, and a
      // CPatch pack none of Loop-Blinn's kinds -- CPatch's own kernel never reaches this block.
      if (
        !defines.includes('MANTLE_NO_BEZOUT') &&
        !defines.includes('MANTLE_LB_NO_CUBIC_BEZ') &&
        bundle &&
        bundle._lbMeshes &&
        !bundle._morphMeshes
      ) {
        const km4 = R._lbKindMask ? R._lbKindMask(bundle) : -1;
        if (km4 !== -1 && !(km4 & (1 << 4))) defines.push('MANTLE_LB_NO_CUBIC_BEZ');
      }
      // ...and the CUBIC chain, the same way: `cubicChainBoxCov` is reachable only from a kind-0 face
      // carrying sentinel 4 or 5 (or a cubic chain 2), which lbPack records as hasCubicChain.
      if (
        !defines.includes('MANTLE_LB_NO_CUBIC_CHAIN') &&
        R._lbNoCubicChain &&
        R._lbNoCubicChain(bundle)
      )
        defines.push('MANTLE_LB_NO_CUBIC_CHAIN');
    }
    if (useAac && !useNoAa && !defines.includes('MANTLE_AAC')) defines.push('MANTLE_AAC');
    // The unified wire can contain only complete cover paints. Use the draw's
    // existing row census, never a guess from retained/preparing mesh storage.
    // Unknown or mixed draws keep the piece cutoff; no per-fragment selector.
    if (useAac && !useNoAa && defines.includes('MANTLE_LB_FILL') && coverPaintOnly)
      defines.push('MANTLE_COVER_PAINT_ONLY');
    // THE BAND LAYOUT, for every program that draws a pair-band bundle: renderFill is the exact walk in
    // every program, so Slug's needs it as AAC's does. A pair list read as a stripe list is still exact -- each stripe's
    // window takes only its own part of every segment -- just walked twice where the pair walk reads it once; a stripe
    // list read as a pair list would miss the next stripe's segments, so the define follows the bundle, never a guess.
    if (bundle && bundle.pairBands && !defines.includes('MANTLE_AAC_PAIR_BANDS'))
      defines.push('MANTLE_AAC_PAIR_BANDS');
    // A missing mask keeps every kernel; morph/stream masks include every reachable pose/type.
    // The stroke walk uses the same flags, so absent types add no per-pixel code.
    const tm = R.opts.typeOmit !== false ? (bundle && bundle.segTypeMask) || 0xf : 0xf;
    for (let t = 0; t < 4; t++)
      if (!(tm & (1 << t)) && !defines.includes(SEGMENT_TYPE_DEFINES[t]))
        defines.push(SEGMENT_TYPE_DEFINES[t]);

    if (
      (!worldMapAxisAligned(R.draw && R.draw.worldM) ||
        !overridesAxisAligned(R.draw && R.draw.overrides) ||
        (!defines.includes('MANTLE_NO_PATTERN') && !patternMapAxisAligned(bundle))) &&
      !defines.includes('MANTLE_ROTATED_MAP')
    )
      defines.push('MANTLE_ROTATED_MAP');
    // A vector pattern whose tile may be finer than a device pixel under this draw walks the tile as cells and averages them
    // (mantle.frag.glsl MINIFICATION). That code is in the base program, like every feature a lean variant may omit; a draw whose
    // patterns all have a tile of two pixels or more omits it (MANTLE_NO_PATTERN_MEAN) and keeps the program it always had.
    if (
      !defines.includes('MANTLE_NO_PATTERN') &&
      !defines.includes('MANTLE_NO_PATTERN_MEAN') &&
      !patternHasFineTile(R, bundle)
    )
      defines.push('MANTLE_NO_PATTERN_MEAN');
    // Measurement only -- extra defines, switchable between draws on one renderer (__setAbDefines),
    // so an A/B can hold everything but the program fixed. It belongs HERE, at the bottom of the
    // one function that answers "what defines does this bundle's draw use", rather than at the call
    // site in selectFillVariant, because the ROUTE asks this same function whether a bundle is
    // eligible for the unified/LB path and the two should not disagree.

    if (R._abDefines) for (const d of R._abDefines) if (!defines.includes(d)) defines.push(d);
    // Disabling specialization still requires the vertex layout and kernels
    // carried by the unified stream. Keep those defines, retaining all feature,
    // curve-type and analytic-kind blocks in the resulting program.
    // A STREAMED bundle's content is unknown at warm time (updateBundleGeometry replaces it: a segment type or an analytic kind that first appears mid-stream removes a
    // MANTLE_NO_* / MANTLE_LB_NO_*, i.e. the program changes under the draw). Where the app chose the stand-in-free policy that change would block, and where the app declared the stream, the image is the
    // content-agnostic program: every segment-type kernel and analytic-kind block in, one key for the stream's whole life (the domain is the full union; it can only grow into it).
    if (oneKeyStream(bundle))
      defines = defines.filter(
        (d) =>
          !SEGMENT_TYPE_DEFINES.includes(d) &&
          !d.startsWith('MANTLE_LB_NO_') &&
          d !== 'MANTLE_NO_BEZOUT',
      );
    if (R.opts.disableFillVariants)
      return defines.filter(
        (d) =>
          !d.startsWith('MANTLE_NO_') &&
          !d.startsWith('MANTLE_LB_NO_') &&
          d !== 'MANTLE_COVER_PAINT_ONLY',
      );
    return defines;
  }
  /// `uni`: the unified route is asking for the program its stream draws with -- its readiness check, and
  /// each span's beginFillPass (R._uniScope). Any other caller draws every row as a cover quad.
  /// A bundle with nothing to draw (no shapes, an empty draw list: an all-invisible frame, fill="none" with no stroke, which the importer drops) binds no fill
  /// program: every route's fill pass declines it (beginFillPass, R._fillDeclined) and its warm image is empty. A stream or a morph may gain content: not this.
  const drawsNothing = (b) =>
    !!b && !b._lbStream && !b._morphSrc && !(b.numShapes > 0) && !(b.drawList && b.drawList.length);
  R._drawsNothing = drawsNothing;
  function selectFillVariant(bundle, uni = R._uniScope === true) {
    if (drawsNothing(bundle)) return null;
    const savedSel = R._selBundle;
    R._selBundle = bundle;
    let r;
    try {
      r = selectFillVariantInner(bundle, uni);
    } finally {
      R._selBundle = savedSel;
    }
    // the variant this bundle last drew with exactly what it asked for: the previous-variant reuse rule's candidate (standIns:false)
    if (
      r &&
      bundle &&
      !R._psoWarming &&
      !R._variantProbe &&
      r.key === R._lastWantKey &&
      !r.pending
    ) {
      bundle._prevVariant = r;
      bundle._reuseN = 0;
    }
    // In strict play, a program drawn without a built pipeline is a BUILD in play (the net was missing): counted, so the harness fails the run.
    if (
      r &&
      strictNow() &&
      !R._psoWarming &&
      !R._variantProbe &&
      !pipelineWarm(r) &&
      !r.__playBuild
    ) {
      r.__playBuild = true;
      R._playBuilds = (R._playBuilds | 0) + 1;
      (R._playBuildWhy ||= []).length < 30 &&
        R._playBuildWhy.push({
          key: r.key || '',
          frame: R._frameSerial | 0,
          uni,
          rotated: !worldMapAxisAligned(R.draw && R.draw.worldM),
          recolor: drawUsesRecolor(),
          palette: !!(R.draw.palette && R.draw.palette.texture),
          lerp: !!R.draw.channelLerp,
          ov: !!R.draw.overrides,
          alpha: R.draw.alpha,
          psoReady: !!r.psoReady,
          pending: !!r.pending,
          gateDrawn: R._progDrawn ? !!R._progDrawn(r.prog) : null,
          boundFbo: !!R._boundDrawFbo,
          folded: !!r.universal,
          built: r.built ? Object.keys(r.built).join(',') : '',
          cls: R._viewportClassInfo ? R._viewportClassInfo().cls : null,
          warmedClasses: R._viewportClassInfo ? R._viewportClassInfo().warmedClasses : null,
          bundleShapes: bundle ? bundle.numShapes : null,
          label: bundle && bundle.debugLabel ? String(bundle.debugLabel) : null,
          atLoad: !!(bundle && _atReady.has(bundle)),
          wm: R._wmKeyOf ? R._wmKeyOf(bundle) : null,
        });
      (R._playBuildKeys ||= []).length < 50 && R._playBuildKeys.push(r.key || '');
    }
    return r;
  }
  function selectFillVariantInner(bundle, uni = R._uniScope === true) {
    // A manifest warm draws a bundle with the exact fill variant the recorded session bound (R._warmForceKey, set by _warmBundlePso).
    if (R._warmForceKey && R._psoWarming) {
      const fv = variantCache.get(R._warmForceKey);
      if (fv && !fv.pending) return fv;
    }
    // Escape hatch: force the single default program (no per-bundle/per-draw
    // specialization). For deterministic baselines (byte-identity tests) and
    // debugging.

    // No-AA band-hard wins over AA when the fill is opaque-stroke-covered (draw-time gate).
    const useNoAa = preferNoAa(bundle);
    const useMixed = useNoAa ? false : preferNoAaMixed(bundle);
    const useAac = useNoAa
      ? false
      : R.opts.aacFill === 'auto'
        ? preferAac(bundle)
        : !!R.opts.aacFill;
    if (useAac && forceSlugKernel()) _warnBakedKernel();
    if (useNoAa) R._autoEngine = treeFor(bundle) ? ENGINES.HARD_TREE : ENGINES.HARD_BAND;
    // The tree is baked into the curve buffer at import, so a bundle without one cannot draw this pin: it says so and draws band-hard, the same kernel without the walk's tree.
    if (
      useNoAa &&
      R.opts.fillKernel === ENGINES.HARD_TREE &&
      !treeFor(bundle) &&
      bundle.numFillShapes !== 0 &&
      !R._psoWarming
    ) {
      if (R._engines) R._engines.declined(ENGINES.HARD_TREE, DECLINE.NO_TREE);
      if (!bundle._treeDeclineWarned) {
        bundle._treeDeclineWarned = true;
        mantleWarn(
          "[mantle] setFillEngine({ kernel: 'hard-tree' }): this bundle has no winding tree, so it draws hard-band. Import it with importSvg(svg, { gwnTree: true }).",
        );
      }
    } else if (useMixed) R._autoEngine = useAac ? ENGINES.HARD_MIXED_AAC : ENGINES.HARD_MIXED;
    // A pinned aacFill never runs preferAac, which is the only other writer of _autoEngine -- so
    // the field kept whatever the last auto decision left there and an explicitly-AAC draw
    // reported itself as Slug. Only the pinned case is filled in here; the 'auto' path's own
    // answer is richer (it distinguishes 'inert', a stroke-only bundle where no fill kernel runs
    // at all) and must not be overwritten with a guess.
    else if (R.opts.aacFill !== 'auto') R._autoEngine = useAac ? ENGINES.AAC : ENGINES.SLUG;
    let defines = variantDefinesFor(bundle, useAac, useNoAa, useMixed);
    const baseAac = useAac && !defaultHasAac ? variantCache.get(aacBaseKey) : null;
    const needsAacKernel =
      (useAac && !defaultHasAac && !(baseAac && !baseAac.pending)) || (!useAac && defaultHasAac);
    // THE ROTATED FOOTPRINT IS THE ANSWER FOR every KERNEL. A rotated or skewed map draws Slug's em -> pixel
    // map and AAC's footprint only from a program compiled with MANTLE_ROTATED_MAP; the warm fallback (leanOrBase) is
    // the base program, which has none, so a COLD Slug draw under a rotated map would draw visible edge error (with
    // stray ink) until its variant warmed. The AAC kernel finishes its lean program instead of drawing that frame,
    // and Slug does the same, for the same reason.
    const needsAacMap = defines.includes('MANTLE_ROTATED_MAP') && !defaultHasRotatedMap;
    // A key with NO cover fill kernel serves only the unified stream it was keyed for. The classic pass
    // (a warm-up fallback, a declined or bailed unified draw) shades every row as a cover quad and would
    // draw every fill EMPTY with it, so it takes the base program, which holds every kernel.
    if (!uni && defines.includes('MANTLE_NO_COVER_FILL')) {
      // The classic pass uses cover attributes, not the unified stream. Keep this draw's feature/type omissions and its required
      // footprint: its own lean cover variant, with every stand-in rule below (a warm superset, the variant itself once linked), rather
      // than the universal -- which, for the AAC kernel, is a ~10 s pipeline build the first time anything draws it.
      defines = defines.filter(
        (d) =>
          d !== 'MANTLE_NO_COVER_FILL' &&
          !d.startsWith('MANTLE_LB_') &&
          !d.startsWith('MANTLE_CPATCH'),
      );
      if (useAac && !defines.includes('MANTLE_AAC')) defines.push('MANTLE_AAC');
    }
    const key = definesKey(defines);
    R._lastWantKey = key;
    if (!R._variantProbe) _recentWants.set(key, R._frameSerial | 0); // (a probe of K, the warm image's own question, is not a draw: it must not start state twins)
    // DEV ASSERTION (closure): a key K answers in play that the loading window's image did not contain is counted (debugStats.needMiss.kOutsideWarmSet / kOutsideKeys). The image is
    // the image of this function over the reachable draw states, so a nonzero count is a state outside the declared domain (palette, channel lerp, stroke-width override ... without a
    // declared reach) or a bundle created after the loading call.
    if (
      R._warmSet.size &&
      standInsOff() &&
      !R._psoWarming &&
      !R._variantProbe &&
      !R._warmSet.has(key) &&
      !(R._isDeclaredKey && R._isDeclaredKey(key))
    ) {
      const vb = variantCache.get(key);
      if (vb && pipelineWarm(vb))
        R._kOutsideBuilt = (R._kOutsideBuilt | 0) + 1; // outside the image but already built by another pass: harmless, counted apart
      else {
        R._kOutside = (R._kOutside | 0) + 1;
        const ks = (R._kOutsideKeys ||= []);
        if (ks.length < 40 && !ks.includes(key)) ks.push(key);
      }
    }
    rememberWarmTarget(bundle, key, false);
    let v = variantCache.get(key);
    // A key that failed to link is not linked again here (R._retryFailedLinks: the next safe window takes it up; the failure was logged when it happened).
    if (!v && _linkFailed.has(key)) {
      if (!needsAacKernel && !needsAacMap) return leanOrBase(key, null, useAac);
      return nb() ? noStandIn(key) : kernelLinkFailed(key);
    }
    if (!v && R._noteNeedMiss) R._noteNeedMiss('fill', key); // (the variant was neither warmed nor declared: counted and, in a dev build, warned; the path below is unchanged)
    if (
      !v &&
      R.opts.needMissPolicy === 'block' &&
      inPlay() &&
      !R._psoWarming &&
      !R._variantProbe &&
      !R._warmForceKey
    ) {
      // needMissPolicy: 'block' (the strict-play default) prepares the exact variant synchronously. Count the stall
      // (debugStats.needMiss.blocked), never a stand-in and never a skipped draw.
      R._needBlocked = (R._needBlocked | 0) + 1;
      const prog = R.program(
        R.withDefines(R.shaderSources.fillVert, defines),
        R.withDefines(R.shaderSources.fillFrag, defines),
        'fill:block:' + (key || 'full'),
      );
      v = putVariant(key, {
        prog,
        u: null,
        pending: true,
        psoReady: false,
        bundleRef: bundleRefOf(bundle),
      });
      const was = R._forceLinks;
      R._forceLinks = true;
      try {
        promote(key, v);
      } finally {
        R._forceLinks = was;
      }
      v = variantCache.get(key);
      if (v && !v.pending) {
        v.psoReady = true;
        return v;
      }
    }
    if (!v && (R._wmExact || R._cover)) {
      // A manifest warm builds the recorded variants only (forced, above). Any other variant this draw would pick is one the recorded
      // session never bound -- building it is the waste (links of ~1-2 s each, serialized) the manifest exists to avoid.
      const st = warmSuperset(key) || bestWarmSuperset(key) || bestLinkedSuperset(key);
      if (st) return st;
    }
    if (!v && strictNow() && !R._psoWarming && !standInsOff()) {
      // STRICT PLAY LINKS nothing: a program link is compile work in the GPU process (0.3-1.5 s of translator and Metal compiler each), which delays every
      // pipeline and frame queued behind it. A draw whose own program does not exist yet draws a built net, and the program is created by the window
      // that builds it (the wanted key is queued with its bundle).
      const net = warmSuperset(key) || bestWarmSuperset(key) || builtNetFor(key);
      if (net) {
        noteStandIn(key, net, bundle);
        requestPsoWarm(bundle, key);
        return net;
      }
    }
    if (!v) {
      // Start specialization without blocking. The base variant is a strict
      // functional superset and remains usable while linking completes.
      R._variantCompiles = (R._variantCompiles || 0) + 1;
      const prog = _traceStall(`fill-variant compile MID-DRAW [${key || 'full'}]`, () =>
        R.program(
          R.withDefines(R.shaderSources.fillVert, defines),
          R.withDefines(R.shaderSources.fillFrag, defines),
          'fill:' + (key || 'full'),
        ),
      );
      v = putVariant(key, {
        prog,
        u: null,
        pending: true,
        psoReady: false,
        bundleRef: bundleRefOf(bundle),
      });
      // A variant first asked for in play under a draw state the scene has not shown: start that state's twins for the rest of the scene.
      if (!R._warmState && !R._psoWarming) {
        // (the loading call's own state draws build their variants themselves)
        if (defines.includes('MANTLE_ROTATED_MAP')) startStateTwins('rot');
        if (drawUsesRecolor()) startStateTwins('recolor');
      }
    }
    if (strictNow() && !R._psoWarming && !pipelineWarm(v) && !standInsOff()) {
      // The draw's own pipeline is not built. A built net (warm omission superset) draws the same pixels; the lean program waits for a window.
      const net = warmSuperset(key) || bestWarmSuperset(key) || builtNetFor(key);
      if (net) {
        noteStandIn(key, net, bundle);
        requestPsoWarm(bundle, key);
        return net;
      }
    }
    if (needsAacKernel || needsAacMap) {
      if (!v.pending && v.psoReady) return v;
      if (standInsOff() && !R._psoWarming) {
        const rr = reuseOrBlock(key, v);
        if (rr) return rr;
      }
      // Kernel and pixel footprint affect the answer, so a stand-in must have both: a warm superset, else a linked one whose pipeline is
      // still to build (lean, a fraction of a second), else this draw's own program once linked. Never the Slug base or an axis-aligned
      // program (a wrong frame).
      const warm = warmSuperset(key) || bestWarmSuperset(key);
      if (warm) {
        requestPsoWarm(bundle, key);
        return warm;
      }
      if (!v.pending) {
        v.psoReady = true;
        return v;
      }
      const linked = bestLinkedSuperset(key);
      if (linked) {
        requestPsoWarm(bundle, key);
        linked.psoReady = true;
        return linked;
      }
      if (v.pending) {
        if (nb()) {
          if (!promote(key, v)) {
            if (variantCache.get(key) !== v) return kernelLinkFailed(key);
            // The driver is still linking this draw's program (or the GPU thread is behind) and nothing that has the kernel and the footprint is
            // built (the AAC universal has the kernel alone, and only a built one will do: its first pipeline is ~10 s).
            const ab = !needsAacMap ? variantCache.get(aacBaseKey) : null;
            if (pipelineWarm(ab)) return ab;
            return noStandIn(key);
          }
        } else {
          const khr = R._khrParallel;
          if (khr && !gl.getProgramParameter(v.prog, khr.COMPLETION_STATUS_KHR)) {
            // The driver is still linking this draw's program and nothing that has the kernel and the footprint is built (the AAC universal has
            // the kernel alone, and only a built one will do: its first pipeline is ~10 s, a wait on the lean link is a fraction of one).
            const ab = !needsAacMap ? variantCache.get(aacBaseKey) : null;
            if (pipelineWarm(ab)) return ab;
            if (R._variantProbe) return null; // a readiness probe asks only what could draw; it never waits
            R._blockingLinkWaits = (R._blockingLinkWaits | 0) + 1; // the last resort: counted (debugStats.blockingLinkWaits)
          }
          if (!promote(key, v)) return kernelLinkFailed(key);
        }
      }
      v.psoReady = true;
      return v;
    }
    if (v.pending) {
      if (R._khrParallel) R._variantPolls = (R._variantPolls || 0) + 1;
      // Promote here as well as in the warm tick so a completed variant does not remain pending until the next scheduler pass.
      // (still linking, or -- non-blocking mode -- the GPU thread behind: draw with a superset)
      if (nb()) {
        if (!promote(key, v)) return leanOrBase(key, v, useAac);
      } else {
        const khr = R._khrParallel;
        const done = khr ? gl.getProgramParameter(v.prog, khr.COMPLETION_STATUS_KHR) : true;
        if (!done) return leanOrBase(key, v, useAac); // still linking: draw with a superset
        if (!promote(key, v)) return leanOrBase(key, v, useAac);
      }
    }
    // Progressive specialization: a lean variant is USED only once its Metal
    // pipeline is ALSO warmed (built off the critical path in _warmBundlePso during
    // frame-slack). Until then draw with the pipeline-warm universal — so a real
    // draw never compiles a pipeline and content appearing mid-scene can't stall.
    // R._psoWarming bypasses this so the warm draw itself can build the pipeline.
    if (!v.psoReady && !R._psoWarming) {
      requestPsoWarm(bundle, key);
      if (R.opts.psoWarm !== false) noteWarmDemand(bundle, key);
      if (standInsOff()) {
        const rr = reuseOrBlock(key, v);
        if (rr) return rr;
      }
      return leanOrBase(key, v, useAac);
    }
    return v;
  }
  /// THE DRAW WITH NO CORRECT PROGRAM. Its own variant is still linking (or the GPU thread is still building pipelines ahead of any query
  /// on it), and nothing that is built draws the same pixels: the universal program is an all-feature pipeline never drawn (~10 s of GPU
  /// thread, no presented frame), a Slug stand-in for an AAC or rotated draw is a different picture. Waiting on the link would freeze the
  /// main thread, so the draw is DEFERRED: the selection answers null, the fill pass declines (beginFillPass returns false), and the
  /// next frame asks again. Counted in `debugStats.deferredFillDraws` (a warm draw's deferral is the warm retrying, not a missing picture).
  /// A readiness probe (R._variantProbe) just gets null.
  /// A program whose kernel the draw needs did not link. On a lost context every link reads as failed, in the window before webglcontextlost as after it: that is the loss, not a shader
  /// defect, and a throw there ends the host's frame loop before its handler runs. The draw is deferred like any other with no program.
  function kernelLinkFailed(key) {
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return noStandIn(key);
    if (R._psoWarming) return noStandIn(key); // (a warm draws nothing, it does not end the loading call: the rest of the scene still warms, and the next window takes this key up. A draw says so.)
    throw new Error('Required AAC fill shader failed to link');
  }
  function noStandIn(key) {
    if (!R._variantProbe) {
      if (R._psoWarming) R._deferredWarmDraws = (R._deferredWarmDraws | 0) + 1;
      else {
        R._deferredFillDraws = (R._deferredFillDraws | 0) + 1;
        R._lastDeferredKey = key;
      }
    }
    return null;
  }
  // Before any base draw, the default policy promotes the lean program instead.
  // A ready superset takes precedence; variantFirst:false permits base fallback.
  /// Every program a draw takes INSTEAD of the one it asked for (a ready superset, the base) is a STAND-IN: counted, by program key, in debugStats.standIns. The warm
  /// policy's aim is zero of them in play; the deferral twin (noStandIn) is counted in deferredFillDraws.
  /// The stand-in-free rule and the block policy apply from PLAY on: the loading call has finished (renderer._loadStats.phase 'done'). Before it the loading screen draws through the
  /// stand-in and deferral mechanisms (a deferred draw is a hole on a screen that is not gameplay); the programs the screen needs are cold by construction.
  const inPlay = () => !!(R._loadStats && R._loadStats.phase === 'done');
  const standInsOff = () => R.opts.standIns === false && inPlay();
  R._inPlay = inPlay;
  /// A key without the ENGINE tokens: two programs with the same feature key draw the same picture whatever the kernel, and every kernel is correct at any scale.
  const ENGINE_TOKENS = new Set([
    'MANTLE_PRIM_WALK',
    'MANTLE_AAC',
    'MANTLE_AAC_PAIR_BANDS',
    'MANTLE_HARD',
    'MANTLE_HARD_TREE',
    'MANTLE_HARD_MIXED',
    'MANTLE_GWN',
    'MANTLE_COVER_KERNEL',
    'MANTLE_COVER_PAINT_ONLY',
  ]);
  const featureKeyOf = (key) =>
    key
      ? key
          .split('|')
          .filter((d) => !ENGINE_TOKENS.has(d))
          .join('|')
      : '';
  /// THE STAND-IN-FREE RULE (opts.standIns === false), for a bundle whose needed program `v` is not ready: (1) the bundle's own previous variant, when it is linked and
  /// pipeline-ready and has the same feature key (a different engine on the same footprint, route and omissions): keep drawing with it and let `v` finish linking;
  /// (2) else nothing is available: BLOCK, compile and link exactly `v`, draw with it (one counted stall). No superset stand-in and no deferral.
  function reuseOrBlock(key, v) {
    const prior = R._selBundle && R._selBundle._prevVariant;
    // (the record lives on the bundle, which outlives a renderer on its context: a variant not in this cache belongs to another renderer, or was released, and its program may be deleted)
    if (
      prior &&
      prior !== v &&
      variantCache.get(prior.key) === prior &&
      !prior.pending &&
      pipelineWarm(prior) &&
      featureKeyOf(prior.key) === featureKeyOf(key)
    ) {
      // BOUNDED: once the needed program has linked, its pipeline is built by the warm tick in slack or at the demand deadline; a bundle that has reused for as long as
      // that deadline (psoWarmMaxWaitFrames) draws the needed program itself, building its pipeline now (a lean pipeline: a fraction of a second, counted).
      const sb = R._selBundle;
      sb._reuseN = (sb._reuseN | 0) + 1;
      if (v && !v.pending && sb._reuseN > _psoWarmMaxWait()) {
        sb._reuseN = 0;
        R._reuseDeadline = (R._reuseDeadline | 0) + 1;
        v.psoReady = true;
        return v;
      }
      R._reuseDraws = (R._reuseDraws | 0) + 1;
      const m = (R._reuseByKey ||= new Map());
      const k = (prior.key || '') + ' <- ' + (key || '');
      if (m.size < 40 || m.has(k)) m.set(k, (m.get(k) | 0) + 1);
      if (v && v.pending && !R._variantProbe && nb()) promote(key, v); // (a poll: the switch happens on the first draw after the link completes)
      return prior;
    }
    if (R._variantProbe) return null;
    R._needBlocked = (R._needBlocked | 0) + 1;
    if (v && v.pending) {
      const was = R._forceLinks;
      R._forceLinks = true;
      try {
        promote(key, v);
      } finally {
        R._forceLinks = was;
      }
    }
    const w = variantCache.get(key);
    if (w && !w.pending) {
      w.psoReady = true;
      return w;
    }
    return null;
  }
  function leanOrBase(key, v, useAac) {
    if (standInsOff() && !R._psoWarming && v && !v.universal) return reuseOrBlock(key, v);
    const r = leanOrBaseInner(key, v, useAac);
    if (r && r !== v && !R._variantProbe && !R._psoWarming) {
      R._standInDraws = (R._standInDraws | 0) + 1;
      // (debugStats.needMiss.standInWhy: the first stand-ins, with what was wanted and who drew -- a stand-in under standIns:false is a draw the policy did not see)
      if ((R._standInWhy ||= []).length < 20)
        R._standInWhy.push({
          drawn: r.key || '(universal)',
          wanted: key || '',
          why: v ? (v.universal ? 'wanted-universal' : 'variant') : 'no-variant',
          policy: standInsOff() ? 'off' : 'on',
          frame: R._frameSerial | 0,
          at: Math.round(_nowMs()),
          label: R._selBundle && R._selBundle.debugLabel ? String(R._selBundle.debugLabel) : null,
          shapes: R._selBundle ? R._selBundle.numShapes | 0 : null,
          inFrame: !!R._inFrame,
          coop: !!R._coop,
          stack: new Error().stack
            .split('\n')
            .slice(2, 10)
            .map((l) =>
              l
                .trim()
                .replace(/^at /, '')
                .replace(/\(.*\/(src|dist|node_modules)\//, '('),
            )
            .join(' < '),
        });
      const m = (R._standInByKey ||= new Map());
      const k = r.key || (r.universal ? '(universal)' : '');
      if (m.size < 80 || m.has(k)) m.set(k, (m.get(k) | 0) + 1);
    }
    return r;
  }
  function leanOrBaseInner(key, v, useAac) {
    // variantFirst: false opts out: the base program, whatever else is built.
    if (R.opts.variantFirst === false) {
      R._baseDrawn = true;
      return baseVariant(useAac);
    }
    const sib = warmSuperset(key);
    if (sib) return sib;
    const done = nb()
      ? () => true
      : (p) =>
          !R._khrParallel || gl.getProgramParameter(p.prog, R._khrParallel.COMPLETION_STATUS_KHR);
    if (!R._baseDrawn && v && (!v.pending || (done(v) && promote(key, v)))) {
      v.psoReady = true;
      return v;
    }
    const sup = bestWarmSuperset(key);
    if (sup) return sup;
    // A built superset is better than a base that has never drawn, and a linked one whose pipeline is still to build is a lean build.
    const linked = bestLinkedSuperset(key);
    if (linked && R.opts.psoWarm !== false) {
      linked.psoReady = true;
      return linked;
    }
    // THE UNIVERSAL IS A FALLBACK only WHILE ITS PIPELINE IS BUILT. A first draw of a program the driver has not seen builds its Metal
    // pipeline on the GPU process (seconds for the all-feature program on a cold cache, a fraction of one for a lean variant), and nothing
    // presents until it is done -- nor does any other work on that thread, a link's completion included. So a linked lean variant whose
    // pipeline is cold draws itself, paying its own small build, rather than handing the frame to a universal that has never been drawn.
    // (Only the AAC universal: nothing warms it, and its first pipeline is the 10 s one. The Slug base is what the loading call draws and what an
    // unwarmed renderer's first frames start on.)
    // The same holds for whichever universal this draw would fall back to: the AAC universal, or the default base (the Slug universal, or
    // the AAC one under aacFill): on a cold cache either is ~10 s of Metal pipeline (pbench: 9.7 s each), and a lean variant is ~0.1-0.2 s.
    const base =
      useAac && !defaultHasAac ? variantCache.get(aacBaseKey) : variantCache.get(defaultKey);
    if (R.opts.psoWarm !== false && v && v !== base && !pipelineWarm(base)) {
      if (!v.pending) {
        v.psoReady = true;
        return v;
      }
      if (nb()) {
        // The lean program is still linking (or the GPU thread is behind) and nothing is built to stand in for it. No draw waits: this one is
        // deferred, and the next frame that finds the program ready draws it (noStandIn).
        return noStandIn(key);
      }
      // (blocking mode) The wait on that link (a lean program: a fraction of a second) is the lesser cost, and the last resort; a readiness
      // probe never takes it.
      if (R._variantProbe) return null;
      R._blockingLinkWaits = (R._blockingLinkWaits | 0) + 1;
      if (promote(key, v)) {
        v.psoReady = true;
        return v;
      }
    }
    R._baseDrawn = true;
    return baseVariant(useAac);
  }
  /// The variant's Metal pipeline is known built: warmed (psoReady) and, for the two universal programs, which start out marked ready though
  /// nothing has drawn them, actually drawn once.
  // (strictPlay: psoReady only says a draw chose the program; "built" is a draw the gate saw with it)
  // BUILT = a warm draw bound this program on this ROUTE (the unified stream or cover quads: different vertex layouts) and this TARGET kind (the
  // canvas, or an RGBA8+depth/stencil render target: different attachment formats). psoReady only says a draw chose the program.
  const builtKey = (uni, tgt) => (uni ? 'u' : 'c') + (tgt ? 'T' : 'C');
  function markBuilt(v, uni) {
    if (v) (v.built ||= {})[builtKey(uni, !!R._warmTarget || !!R._boundDrawFbo)] = true;
  }
  // An LB program draws with TWO vertex layouts (the unified stream, and cover quads for the rows that ride as cover inside the same pass), a cover program
  // with one: all of them must be built on the target kind.
  // The first draw of an already-drawn program on another target kind or with another vertex layout opens no measurable gap (no GPU fence of 50 ms
  // or more after loading), where the first draw of a PROGRAM can cost seconds. So by default built = the program was drawn once
  // The warm image is therefore PROGRAMS (the link is the cost); route, target kind and blend are pipeline states derived from a linked program by the driver and are not part of the key.
  const builtFor = (v) => v.failed === true || !R._progDrawn || R._progDrawn(v.prog);
  const pipelineWarm = (v) =>
    !!v &&
    !v.pending &&
    !!v.psoReady &&
    (!v.universal || !!v.drawn) &&
    (!strictCfg() || !!v.universal || builtFor(v));
  R._variantState = (k) => {
    const e = variantCache.get(k);
    return e
      ? { pending: !!e.pending, psoReady: !!e.psoReady, universal: !!e.universal, net: !!e.net }
      : null;
  };
  R._variantList = () => {
    const o = [];
    for (const [k, e] of variantCache) {
      if (o.length >= 400) break;
      o.push({
        key: k,
        pending: !!e.pending,
        ready: !!e.psoReady,
        net: !!e.net,
        spec: !!e.speculative,
      });
    }
    return o;
  };
  R._pendingList = () => {
    const o = [];
    for (const [k, e] of variantCache)
      if (e.pending) o.push({ key: k.slice(-60), spec: !!e.speculative });
    return o;
  };
  R._netList = () => {
    const o = [];
    for (const [k, e] of variantCache)
      if (e.net)
        o.push({
          key: k,
          pending: !!e.pending,
          psoReady: !!e.psoReady,
          built: e.built ? Object.keys(e.built).join(',') : '',
        });
    return o;
  };
  /// The leanest built SAFETY NET (strictPlay) that draws `key`'s pixels, or null.
  function builtNetFor(key) {
    let best = null,
      bestScore = -1;
    for (const [k, e] of variantCache) {
      if (!e.net || !pipelineWarm(e) || !isNetFor(k, key)) continue;
      // the leanest net: the most omissions, the same footprint
      const score =
        (k.includes('MANTLE_ROTATED_MAP') === key.includes('MANTLE_ROTATED_MAP') ? 1000 : 0) +
        k.split('|').filter((d) => d.startsWith('MANTLE_NO_') || d.startsWith('MANTLE_LB_NO_'))
          .length;
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    return best;
  }
  /// The leanest warm omission superset of `key` (sceneUnion.isWarmSuperset), or null.
  function bestWarmSuperset(key) {
    const cand = [];
    for (const [k, e] of variantCache) if (k !== key && pipelineWarm(e)) cand.push(k);
    const k = cand.length ? pickWarmSuperset(key, cand) : null;
    return k === null ? null : variantCache.get(k);
  }
  /// The leanest LINKED (not necessarily built) omission superset of `key` that is not a universal program: drawing it builds its own
  /// pipeline, which for a lean variant is a fraction of a second, where a never-drawn universal costs ~10 s.
  function bestLinkedSuperset(key) {
    const khr = R._khrParallel;
    const cand = [];
    // (a twin is linked when the driver says so; it is promoted here, at its first use)
    for (const [k, e] of variantCache) {
      if (k === key || e.universal) continue;
      if (
        !e.pending ||
        (e.speculative &&
          khr &&
          (nb()
            ? R._programReady(e.prog)
            : gl.getProgramParameter(e.prog, khr.COMPLETION_STATUS_KHR)))
      )
        cand.push(k);
    }
    const k = cand.length ? pickWarmSuperset(key, cand) : null;
    const e = k === null ? null : variantCache.get(k);
    if (e && e.pending && !promote(k, e)) return null;
    return e;
  }
  // ---- THE DRAW-STATE TWINS ---------------------------------------------------------------------------------------------------
  // Two draw states pick a different program from the same bundle and kernel, and the loading call cannot see either: a rotated or skewed
  // map (MANTLE_ROTATED_MAP: the footprint only that program has) and a recolor (colorMatrix / palette / channelLerp). The first draw to meet
  // one links its program (0.3-2 s on a cold cache, 10 s behind a pipeline build), and a scene that turns many things at once -- a spinning
  // field of sprites -- met it once per bundle, five waits in a row.
  //
  // So the FIRST sight of a state starts, for every variant drawn in the last few seconds, its twin for that state (the key with the rotated
  // map; the key with every recolor part left in, a superset of every partial recolor omission): linking in the background, not registered
  // with the load promise, not promoted until a draw needs it. The rest of the scene then finds its program finished, or a linked superset
  // (bestLinkedSuperset), and builds only its own small pipeline.
  //
  // NOT speculative at load: each link is ~0.2-0.5 s of GPU process time (the translator runs there), so twins for every prewarmed variant
  // put ~10 s of work in front of the first frames of play. Twins for the live variants of a scene that has just shown the state are a
  // handful.
  function startQuietVariant(defines) {
    const key = definesKey(defines);
    const had = variantCache.get(key);
    if (had) return had;
    if (_linkFailed.has(key)) return failedVariant(key);
    const ps0 = R._pendingShaders.length,
      pp0 = R._pendingPrograms.length;
    const prog = R.program(
      R.withDefines(R.shaderSources.fillVert, defines),
      R.withDefines(R.shaderSources.fillFrag, defines),
      'fill:twin:' + (key || 'full'),
    );
    R._pendingShaders.length = ps0;
    R._pendingPrograms.length = pp0; // nothing waits on a twin; a failed link is reported when it is promoted
    return putVariant(key, { prog, u: null, pending: true, psoReady: false, speculative: true });
  }
  const TWIN_LIVE_FRAMES = 360;
  const _twinsStarted = new Set();
  /// The keys the draws of the last few seconds asked for (a stand-in may have drawn instead), by the frame that last asked.
  const _recentWants = new Map();
  function startStateTwins(kind) {
    if (strictNow()) return; // (a link in play: the window creates the programs it builds)
    if (R.opts.standIns === false) return; // (twins only exist to serve stand-ins; the stand-in-free policy builds its states exactly)
    if (R.opts.fillTwins === false || R.opts.disableFillVariants || R.opts.psoWarm === false)
      return;
    const now = R._frameSerial | 0;
    for (const [key, last] of Array.from(_recentWants)) {
      if (!(last >= now - TWIN_LIVE_FRAMES)) {
        _recentWants.delete(key);
        continue;
      }
      const v = variantCache.get(key);
      if (v && (v.speculative || v.universal)) continue;
      const tag = kind + ':' + key;
      if (_twinsStarted.has(tag)) continue;
      _twinsStarted.add(tag);
      const defs = key ? key.split('|') : [];
      if (defs.some((d) => d.startsWith('MANTLE_CPATCH') || d === 'MANTLE_LB_MORPH')) continue;
      if (kind === 'rot') {
        if (!defs.includes('MANTLE_ROTATED_MAP'))
          startQuietVariant([...defs, 'MANTLE_ROTATED_MAP']);
      } else if (defs.includes('MANTLE_NO_RECOLOR'))
        startQuietVariant(defs.filter((d) => d !== 'MANTLE_NO_RECOLOR'));
    }
  }
  /// A warm superset for a key with no cover fill kernel: its cover sibling (the same key with the kernel), when that is
  /// linked and its pipeline warm. MANTLE_NO_COVER_FILL only takes out code no fragment of such a draw reaches, so the
  /// sibling draws the same pixels -- the rule the base program already follows for every lean variant, one step closer,
  /// and unlike the base it hosts the unified stream. Without it a draw whose key gained the define (an 'lb' route turned
  /// on after awaitLbReady warmed the 'auto' key, where the bundle was declined) would leave the unified route until its own
  /// variant warmed (loopBlinnRenderDiffSmoke). The lean key is still requested, and replaces the sibling once warm.
  function warmSuperset(key) {
    if (!key || !key.includes('MANTLE_NO_COVER_FILL')) return null;
    const sv = variantCache.get(
      key
        .split('|')
        .filter((d) => d !== 'MANTLE_NO_COVER_FILL')
        .join('|'),
    );
    return sv && !sv.pending && sv.psoReady ? sv : null;
  }

  /// Would a draw of `bundle` right now bind a program that hosts LB coverage?
  ///
  /// The unified fill route has to know BEFORE it builds its vertex stream, and
  /// "the defines asked for it" is not the same question: a variant that is still
  /// linking, or whose Metal pipeline is not warm, draws with its BASE, and the
  /// base declares no LB attributes — the LB triangles would be read as cover
  /// quads. selectFillVariant already resolves all of that, and it is idempotent
  /// and cached, so ask it and read the flag off what it actually returns.
  function fillVariantHasLbFill(bundle) {
    // A readiness probe: it asks what could draw, so it never waits on a link.
    R._variantProbe = true;
    let v;
    try {
      v = selectFillVariant(bundle, true);
    } finally {
      R._variantProbe = false;
    }
    R._lastFillVariantKey = (v && v.key) || null;

    let ok = !!(v && v.key && v.key.includes('MANTLE_LB_FILL'));

    const wantCurveTex = R.opts.unifiedFillCurveTex !== false && !(bundle && bundle._noCurveTex);
    if (ok && wantCurveTex && !v.key.includes('MANTLE_LB_CURVE_TEX')) ok = false;
    //
    // A COUNTER, not a once-per-bundle flag. The required variant also depends on
    // PER-DRAW state — a recolor (colorMatrix / palette / channelLerp) selects a
    // different one — so a bundle that spent its single requeue warming its plain
    // variant could never warm its recolored one, and the recolored draw would decline
    // forever. With warm-up falling to the best non-LB engine that is a PERMANENT loss
    // of the analytic route for that draw state (loopBlinnRenderDiffSmoke checks it).
    //
    // Bounded because the point of a requeue limit is to stop an unbounded
    // re-enqueue every frame. Four covers plain/recolor x the engine choices;
    // anything beyond that is a mismatch this cannot fix by warming.
    if (!ok && (bundle._lbVariantRequeues | 0) < 4) {
      bundle._lbVariantRequeues = (bundle._lbVariantRequeues | 0) + 1;

      bundle._lbWarmDraw = {
        colorMatrix: R.draw.colorMatrix,
        colorMatrixOffset: R.draw.colorMatrixOffset,
        palette: R.draw.palette,
        channelLerp: R.draw.channelLerp,
        overrides: R.draw.overrides,
      };
      enqueueFillPrewarm(gl, bundle);
      if (R.opts.psoWarm !== false) _psoWarmQueue.push(bundle);
    }
    return ok;
  }

  // Request both run variants before any real span draws. Until both are warm,
  // the caller keeps its complete combined draw rather than partially painting.
  R._cpatchAreaSplitReady = (bundle) => {
    const saved = R._uniCpAreaPass;
    let ready = true;
    const variants = {};
    try {
      for (const mode of /** @type {Array<'area' | 'seam'>} */ (['area', 'seam'])) {
        R._uniCpAreaPass = mode;
        const v = selectFillVariant(bundle, true);
        const flag =
          mode === 'area' ? 'MANTLE_CPATCH_QUADRATIC_AREA_ONLY' : 'MANTLE_CPATCH_NO_QUADRATIC_AREA';
        if (!v || v.pending || !v.psoReady || !v.key || !v.key.includes(flag)) ready = false;
        variants[mode] = v;
      }
    } finally {
      R._uniCpAreaPass = saved;
    }
    if (!ready) {
      // The combined variant can already be ready under recolor while these two
      // variants are still cold. Its gate then has no reason to capture the draw
      // state; record it here so the queued warm builds the missing split PSOs.
      bundle._lbWarmDraw = {
        colorMatrix: R.draw.colorMatrix,
        colorMatrixOffset: R.draw.colorMatrixOffset,
        palette: R.draw.palette,
        channelLerp: R.draw.channelLerp,
        overrides: R.draw.overrides,
      };
    }
    return ready ? variants : null;
  };

  /// Validate a linked variant and capture its uniforms. Only this program is checked:
  /// finalizeShaderCompiles() reads LINK_STATUS on every pending program, and reading it is what
  /// FORCES a link — one finished variant would force all the others still compiling.
  /// Non-blocking mode, or inside a cooperative loading step (gpuGate.js R._nbNow).
  const nb = () => !!(R._nbNow && R._nbNow());
  const gpuClearW = () =>
    R._warmBatch === true ? true : R._coop && R._gpuClearBatch ? R._gpuClearBatch() : R._gpuClear(); // (a batch inside the loading window is one fence's worth: bindSetPass)   // (the loading call may batch cheap warms: gpuGate.clearBatch)
  function linksQuiet(self) {
    const khr = R._khrParallel;
    for (const e of variantCache.values()) {
      if (e === self || !e.pending || e.speculative) continue;
      if (!gl.getProgramParameter(e.prog, khr.COMPLETION_STATUS_KHR)) return false;
    }
    return true;
  }
  function promote(key, v) {
    // THE GATE. With KHR_parallel_shader_compile a program is validated only once it reports complete AND the GPU thread has caught up with
    // the pipeline builds queued before it (gpuGate.js): the reads below are in-order commands that would otherwise wait for both. A program that
    // is not ready is NOT touched and promote answers false -- every caller already treats false as "use a stand-in". A link that FAILED is
    // reported by the same call once it is ready (it deletes the variant, so `variantCache.get(key) !== v` tells the two apart).
    // `R._forceLinks` is the synchronous loading call's explicit opt-in to wait (precompileFills(), documented as blocking).
    if (R._khrParallel && nb()) {
      if (!R._forceLinks && !R._programReady(v.prog)) return false;
      // STRICT PLAY reads a program's uniform table only when no other program is still compiling: the read is a synchronous round trip to the GPU
      // process, which can answer hundreds of ms late (main thread frozen in the loading screen) while it is translating and compiling the others.
      if (strictCfg() && !R._forceLinks && !linksQuiet(v)) return false;
      if (R._forceLinks && !R._programReady(v.prog))
        R._blockingLinkWaits = (R._blockingLinkWaits | 0) + 1;
    }
    if (!diagFlags.stallMs) return _promote(key, v);
    return _traceStall(`shader LINK [${key || 'full'}]`, () => _promote(key, v));
  }
  /// A KEY THAT FAILED TO LINK waits for the next safe window: in play it is not linked again (each frame's attempt was a link in play for a picture that may never come), and no warm in the window
  /// that failed it links it a second time (a loading call warms many sizes). key -> the bundle that asked, weakly.
  const _linkFailed = new Map();
  R._linkFailedCount = () => _linkFailed.size;
  /// THE SAFE WINDOW'S RETRY. A loading call or warm window takes the failed keys up, once: a failure can be transient (a driver out of memory, a context under pressure). A key nothing live asks for
  /// stays down. Linked here, it is promoted and built by the window like any other; failed again, it waits for the next window.
  R._retryFailedLinks = () => {
    if (
      !_linkFailed.size ||
      R._contextLost ||
      (typeof gl.isContextLost === 'function' && gl.isContextLost())
    )
      return 0;
    let n = 0;
    for (const [key, ref] of [..._linkFailed]) {
      const owner = ref ? ref.deref() : null;
      if (ref && (!owner || owner._disposed)) continue;
      _linkFailed.delete(key);
      _bindUnbuildable.delete(key);
      try {
        compileVariant(key ? key.split('|') : [], 'fill:retry:', owner);
        n++;
      } catch {
        _linkFailed.set(key, ref);
      }
    }
    R._linkRetries = (R._linkRetries | 0) + n;
    return n;
  };
  function _promote(key, v) {
    dropPending(v.prog);
    if (!gl.getProgramParameter(v.prog, gl.LINK_STATUS)) {
      let why = gl.getProgramInfoLog(v.prog);
      const st = gl.getAttachedShaders ? gl.getAttachedShaders(v.prog) || [] : [];
      for (const sh of st) {
        if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) continue;
        why +=
          '\n  ' +
          (gl.getShaderParameter(sh, gl.SHADER_TYPE) === gl.VERTEX_SHADER ? 'vertex' : 'fragment') +
          ': ' +
          gl.getShaderInfoLog(sh);
      }
      // A context lost between loseContext() and the webglcontextlost event (and any time after) fails every link; that is the
      // loss, not a shader defect, and four dumps of it per frame hid real link failures.
      if (!(typeof gl.isContextLost === 'function' && gl.isContextLost()))
        R.mantleError('link failed (fill variant) [' + (key || 'full') + ']:', why);
      // A compile failure is not a wait. The bounded requeue above will retry a few times and then
      // stop, after which this engine never draws again for the life of the bundle -- so record it
      // as its own decline reason, distinct from 'not-warm', or the two are indistinguishable in
      // the one place anybody looks.
      if (R._engines) R._engines.declined(engineOfVariantKey(key), DECLINE.COMPILE_FAILED);
      deleteGlResource(gl, 'Program', v.prog);
      variantCache.delete(key);
      if (!(typeof gl.isContextLost === 'function' && gl.isContextLost()))
        _linkFailed.set(key, v.bundleRef || null);
      return false;
    }
    v.u = captureFillUniforms(v.prog);
    v.pending = false;
    return true;
  }

  // The program a specialized variant draws with while it still links is its AAC BASE, not the
  // Slug default: the specialized variants differ from their base only by omit-defines (which
  // strip kernels the bundle never uses), so the base is a strict superset and the picture is
  // identical. Substituting Slug for a pending AAC variant would silently swap the engine for a
  // few frames — near-identical, since both are exact, but not identical (the AAC-referenced LB
  // gates see the difference).
  //
  // Before the AAC base has linked, use Slug briefly rather than blocking; load-time
  // prewarm starts the base link and the KHR poll promotes it asynchronously.
  /// Take a program out of the global pending queue, so finalizeShaderCompiles()/`renderer.ready`
  /// neither re-checks it nor blocks on the others.
  function dropPending(prog) {
    const pp = R._pendingPrograms;
    if (pp) for (let i = pp.length - 1; i >= 0; i--) if (pp[i].prog === prog) pp.splice(i, 1);
    const ps = R._pendingShaders;
    if (ps) for (let i = ps.length - 1; i >= 0; i--) if (ps[i].owner === prog) ps.splice(i, 1);
  }

  function baseVariant(useAac) {
    if (!useAac) return variantCache.get(defaultKey);
    let b = variantCache.get(aacBaseKey);
    if (!b) {
      // Start the compile without reading LINK_STATUS, which can block the main
      // thread. Use the Slug default until the async link completes.
      const defs = (R.opts.fillDefines || []).concat(['MANTLE_AAC']);
      const prog = R.program(
        R.withDefines(R.shaderSources.fillVert, defs),
        R.withDefines(R.shaderSources.fillFrag, defs),
        'fill:aac-base',
      );
      putVariant(aacBaseKey, { prog, u: null, pending: true, psoReady: true, universal: true });
      return variantCache.get(defaultKey);
    }
    if (b.pending) {
      const khr = R._khrParallel;
      if (
        !khr ||
        (!nb() && !gl.getProgramParameter(b.prog, khr.COMPLETION_STATUS_KHR)) ||
        !promote(aacBaseKey, b)
      )
        return variantCache.get(defaultKey);
    }
    return b;
  }

  /// Per-frame tick: start the compile of variants for bundles that have just been created, and
  /// promote (validate + capture uniforms) at most one whose link has completed. Runs once per
  /// frame BEFORE any geometry is bound, so promotion never lands in the middle of a fill pass.
  ///
  /// It also builds the driver pipeline state with a one-pixel scissored draw on
  /// the default framebuffer. Default and texture framebuffers can use different
  /// pipelines, so an offscreen warm would not prepare the canvas path. Disable
  /// with `psoWarm:false`.

  // Stall tracer. setDiagnostics({ stallMs: N }) — any mantle-side op that
  // blocks the main thread ≥ N ms logs what it was. Off by default: _traceStall
  // is a single number compare + direct call when disabled.
  function _traceStall(what, fn) {
    const thr = diagFlags.stallMs;
    if (!thr) return fn();
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const r = fn();
    const d = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (d >= thr) console.warn(`[mantle] STALL ${d.toFixed(0)}ms — ${what}`);
    return r;
  }
  R._traceStall = _traceStall;

  const WARM_PIXEL = [0, 0, 1, 1];
  const WARM_TINT = new Float32Array([
    0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1,
  ]);
  const WARM_TINT_OFFSET = new Float32Array([0.03, 0, 0, 0]);
  const WARM_IDENTITY_MAP = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const WARM_ROTATED_MAP = new Float32Array([
    Math.SQRT1_2,
    Math.SQRT1_2,
    0,
    -Math.SQRT1_2,
    Math.SQRT1_2,
    0,
    0,
    0,
    1,
  ]);
  /// A warm that draws nothing: where no clear follows to take the warm's pixel back --
  /// an entry outside any frame, beginFrame(null), a warm forced from inside a draw -- the bundle's lean variant is made
  /// usable without the one-pixel draw that would have built its pipeline. The variant the bundle's next draw binds (with
  /// the draw state a mismatch recorded, as _warmBundlePso replays it) and its cover sibling are marked psoReady once
  /// linked, so that draw builds the pipeline itself -- a stall on that frame, which is what a warm drawn there would
  /// have cost too -- instead of falling back to the universal program, or off the unified route, for good.
  // A pending target must not block later ready bundles or grow the queue.
  let automaticWarmCursor = 0;
  function nextAutomaticWarmIndex() {
    const head = _psoWarmHead,
      end = _psoWarmQueue.length;
    if (head >= end) return -1;
    if (automaticWarmCursor < head || automaticWarmCursor >= end) automaticWarmCursor = head;
    const attempts = Math.min(8, end - head);
    for (let work = 0; work < attempts; work++) {
      const index = automaticWarmCursor++;
      if (automaticWarmCursor >= end) automaticWarmCursor = head;
      const bundle = _psoWarmQueue[index];
      if (bundle && !bundle._disposed && automaticWarmTargetsReady(bundle)) return index;
    }
    return -1;
  }
  function consumeAutomaticWarm(index) {
    if (index !== _psoWarmHead) {
      const waiting = _psoWarmQueue[_psoWarmHead];
      _psoWarmQueue[_psoWarmHead] = _psoWarmQueue[index];
      _psoWarmQueue[index] = waiting;
    }
    _psoWarmHead++;
  }
  function automaticWarmTargetsReady(bundle) {
    // Poll the programs already requested for this bundle before changing render state.
    const keys = _psoWarmRequested.get(bundle);
    if (!keys || !keys.size) return true;
    const khr = R._khrParallel;
    for (const key of keys.keys()) {
      const target = variantCache.get(key);
      if (
        target &&
        target.pending &&
        (!khr ||
          !(nb()
            ? R._programReady(target.prog)
            : gl.getProgramParameter(target.prog, khr.COMPLETION_STATUS_KHR)))
      )
        return false;
    }
    return true;
  }
  function _readyBundleNoDraw(bundle, automatic = false) {
    if (!bundle || bundle._disposed) return true;
    if (automatic && !automaticWarmTargetsReady(bundle)) return false;
    const wd = bundle._lbWarmDraw;
    const savedCm = R.draw.colorMatrix,
      savedCmO = R.draw.colorMatrixOffset;
    const savedPal = R.draw.palette,
      savedOv = R.draw.overrides,
      savedCl = R.draw.channelLerp;
    const savedWorldM = R.draw.worldM;
    if (bundle._warmRotatedMap) {
      R.draw.worldM = WARM_ROTATED_MAP;
      bundle._warmRotatedMap = false;
    }
    if (wd) {
      R.draw.colorMatrix = wd.colorMatrix;
      R.draw.colorMatrixOffset = wd.colorMatrixOffset;
      R.draw.palette = wd.palette;
      R.draw.channelLerp = wd.channelLerp;
      if (wd.overrides !== undefined) R.draw.overrides = wd.overrides;
    } else {
      R.draw.channelLerp = null;
    }
    R._psoWarming = true; // selectFillVariant hands back the lean variant itself, past the psoReady gate
    try {
      const uni = !!(R._unifiedFillEligible && R._unifiedFillEligible(bundle));
      const v = selectFillVariant(bundle, uni);
      if (v && !v.pending) {
        v.psoReady = true;
        const sk =
          v.key && v.key.includes('MANTLE_NO_COVER_FILL')
            ? v.key
                .split('|')
                .filter((d) => d !== 'MANTLE_NO_COVER_FILL')
                .join('|')
            : null;
        const sib = sk != null ? variantCache.get(sk) : null;
        if (sib && !sib.pending) sib.psoReady = true;
      }
    } finally {
      R._psoWarming = false;
      R.draw.channelLerp = savedCl;
      R.draw.worldM = savedWorldM;
      if (wd) {
        R.draw.colorMatrix = savedCm;
        R.draw.colorMatrixOffset = savedCmO;
        R.draw.palette = savedPal;
        R.draw.overrides = savedOv;
        bundle._lbWarmDraw = null;
      }
    }
    return true;
  }
  let baseWarms = 0;
  const baseWarmOn = () =>
    R.opts.loadingBaseWarm === true ||
    (R.opts.loadingBaseWarm !== false && R.opts.variantFirst === false);
  function _warmBundlePso(bundle, automatic = false, loadingBase = false) {
    if (!bundle || bundle._disposed || !bundle.curveTex || drawsNothing(bundle)) return true;
    if (automatic && !automaticWarmTargetsReady(bundle)) return false;
    if (R._captureFrames || fillPassActive) return false;
    // ONE BATCH OF PIPELINE BUILDS IN FLIGHT. A warm draw is a first-use draw: the GPU thread builds its pipeline (0.2-1.5 s lean, ~10 s the
    // universal) ahead of everything queued after it, and the compositor shares that thread. The next warm waits for the fence behind the last.
    if (R._khrParallel && (nb() || R._inferSlice) && !R._forceLinks && !gpuClearW()) return false;
    // ...and none while the app is still uploading its content (a bundle or image created in the last 120 ms): its uploads cannot be deferred, and
    // one that lands in a build waits for it. Outside the loading call, an automatic warm waits for the loading call itself (up to 15 s after the
    // renderer was ready: an app that never makes it still gets its idle warm).
    if (R._khrParallel && nb() && !R._forceLinks && R._gateQuiet && !R._gateQuiet(120))
      return false;
    if (
      R._khrParallel &&
      R._nonBlocking() &&
      !R._coop &&
      !R._forceLinks &&
      !R._loadCalled &&
      _nowMs() - (R._readyAt || 0) < 15000
    )
      return false;
    // The size the loading call was told to warm for (opts.viewport), for the length of this warm only.
    const savedWarmViewport = R._warmViewport;
    if (R._warmViewportOpt && (R._coop || R._warmQuick)) R._warmViewport = R._warmViewportOpt;
    const [cw, ch] = viewportSize();
    if (!(cw > 0 && ch > 0)) {
      R._warmViewport = savedWarmViewport;
      return false;
    } // canvas not sized yet — try again next frame
    // Use renderer-shadowed state because driver state queries may flush the GPU.
    const savedFbo = R._boundDrawFbo || null;
    const savedCl = R.draw.channelLerp;
    R.setBundle(bundle);
    R.bindFb(gl.FRAMEBUFFER, R._warmTarget || null); // default FB = the real draw target (canvas PSO); strictPlay's second round: a scratch RGBA8+depth/stencil target
    // 1px, nothing visible; scissor not baked into the PSO. A FLOOR the whole walk honors, not a
    // bare gl.scissor call: the warm draws the bundle for real -- groups, filters, blend leaves --
    // and each of those scissors a rect of its own and then restores the target's scissor. A
    // restore to "off" would let the rest of the warm, after the first filter region, group rect or
    // blend rect, paint the canvas unscissored, from fillWarmTick right after beginFrame's clear or
    // mid-frame from drawBundle's warmTick; and with a caller's scissor set, bindFb would re-apply the
    // CALLER's rect on the first canvas bind. R._warmScissor makes the pixel part of
    // the rule bindFb and every restore apply (renderer.js _targetScissor), intersected with the
    // caller's rect on the canvas.
    R._warmScissor = WARM_PIXEL;
    R._applyTargetScissor(R._warmTarget || null);
    // Warm mode: selectFillVariant returns the ACTUAL lean variant (bypassing the
    // psoReady gate) so this warm draw builds ITS pipeline; then mark it usable, so
    // the next real draw of this content upgrades off the universal with no stall.
    R._psoWarming = true;
    let warmDeclined = false;
    const warm1 = () => {
      R._warmBound = null;
      // Warm the pipeline this bundle will actually draw with. On Metal a pipeline
      // is per (program × blend × VERTEX LAYOUT), and the unified fill route uses
      // its own VAO and stride — so warming the cover quad would leave the route's
      // pipeline cold and its first real draw would build one mid-frame, which is
      // the stall this whole mechanism exists to avoid.
      // A morph bundle must be warmed AS a morph: its variant carries
      // MANTLE_LB_MORPH and its VAO carries six more attributes, so a static warm
      // builds a different program and a different pipeline and leaves the one the
      // draw actually wants cold forever.
      const warmT = R._unifiedMorphEligible && R._unifiedMorphEligible(bundle) ? 0 : undefined;
      // (R._warmPointsOnly: the bind-set pass builds a bundle's point program, which a unified bundle reaches only when its analytic route declines)
      if (
        !R._warmClassic &&
        !R._warmPointsOnly &&
        R._unifiedFillEligible &&
        R._unifiedFillEligible(bundle) &&
        R._drawBundleUnifiedFill &&
        R._drawBundleUnifiedFill(bundle, warmT)
      ) {
        if (R._lastFillVariant) {
          R._lastFillVariant.psoReady = true;
          markBuilt(R._lastFillVariant, true);
        }
        if (R._warmBound) for (const bv of R._warmBound) markBuilt(bv, true);
        return;
      }
      if (R._fillDeclined) {
        warmDeclined = true;
        return;
      } // the unified pass found no ready program: nothing was warmed, the bundle stays queued
      // The small-shape AAC fallback uses its own vertex-stage coverage program
      // and point VAO. Warm that actual route under the same one-pixel scissor;
      // a cover warm cannot compile or build its pipeline for the first draw.
      // (a warm forced to a fill key builds THAT key: the cover program a points bundle draws when its route declines at draw time)
      if (!R._warmClassic && !R._warmForceKey && R._aacPointsRoute && R._aacPointsRoute(bundle))
        return;
      // A triangular cover has three vertices. Empty / lightweight
      // bundles never uploaded triBuf — drawing 6 against a 0-byte VBO is
      // exactly `Vertex buffer is not big enough`.
      // the cover mesh the draw path uploads before its first fill pass (renderer.js: a handle made before the bundle's cover quads existed is dirty, not empty)
      if (R._uploadCoverMeshIfDirty) R._uploadCoverMeshIfDirty();
      // no cover mesh yet: nothing drawn, so nothing warmed (reporting it as warmed would leave the key unbuilt with no draw issued)
      if (!R._handle || (R._handle.coverVertCount | 0) < 3) {
        if (R._handle && (bundle.coverQuadVboFloats || bundle.coverQuadFloats)) warmDeclined = true;
        return;
      }
      // In the unified scope when the bundle takes that route: this marks the variant that route asks for
      // (a key with no cover fill kernel is otherwise handed to a classic caller as the base program).
      R._uniScope = !R._warmClassic && !!(R._unifiedFillEligible && R._unifiedFillEligible(bundle));
      try {
        beginFillPass();
      } finally {
        R._uniScope = false;
      }
      if (R._fillDeclined) {
        warmDeclined = true;
        endFillPass();
        return;
      } // no ready program yet: nothing drawn, nothing warmed
      gl.drawArrays(gl.TRIANGLES, 0, Math.min(6, R._handle.coverVertCount));
      endFillPass();
      if (R._lastFillVariant) {
        R._lastFillVariant.psoReady = true;
        markBuilt(R._lastFillVariant, false);
      }
      if (R._warmBound) for (const bv of R._warmBound) markBuilt(bv, false);
    };

    const wd = bundle._lbWarmDraw;
    const savedCm = R.draw.colorMatrix,
      savedCmO = R.draw.colorMatrixOffset;
    const savedPal = R.draw.palette,
      savedOv = R.draw.overrides;

    const savedWorldM = R.draw.worldM;
    if (bundle._warmRotatedMap) {
      R.draw.worldM = WARM_ROTATED_MAP;
      bundle._warmRotatedMap = false;
    }
    // The loading call's FUTURE STATES (R._warmState, set by precompileFillsAsync): the same bundle drawn under a rotated map and under a
    // recolor, so the variants, point programs and mask bakes those states pick are linked and built behind the load screen.
    const ws = R._warmState,
      savedTintCm = R.draw.colorMatrix,
      savedTintOff = R.draw.colorMatrixOffset;
    const savedForce = R._warmForceKey;
    if (ws && ws.force) R._warmForceKey = ws.force;
    if (ws && ws.world) R.draw.worldM = ws.world;
    if (ws && ws.cm) {
      R.draw.colorMatrix = ws.cm;
      R.draw.colorMatrixOffset = ws.off;
    }
    if (wd) {
      R.draw.colorMatrix = wd.colorMatrix;
      R.draw.colorMatrixOffset = wd.colorMatrixOffset;
      R.draw.palette = wd.palette;
      R.draw.channelLerp = wd.channelLerp;
      if (wd.overrides !== undefined) R.draw.overrides = wd.overrides;
    } else {
      R.draw.channelLerp = null;
    }
    if (ws && ws.cl) R.draw.channelLerp = ws.cl;
    try {
      const binds0 = R._fillVariantBinds | 0;
      _traceStall('pipeline warm', warm1);
      // (declined on a key that failed to link: nothing is coming, so the warm is over, and the next window takes the key up. Asked again, it held the loading call to its deadline.)
      if (warmDeclined && R._lastWantKey != null && _linkFailed.has(R._lastWantKey)) return true;
      if (warmDeclined) return false; // (the finally below restores the state)
      // Each program this warm draws is its own pipeline build: the fill above, then the mask bake, then the cover sibling. In non-blocking mode they are
      // taken one fence apart (the bundle stays queued, and its next attempt finds the fill's pipeline built and goes on to the next program), so no single
      // wait on the GPU thread is the sum of them.
      if (nb() && R._khrParallel && !R._forceLinks && R._warmMaskBakePrograms && !gpuClearW())
        return false;
      // The mask bake is its own program with its own pipeline (190 KB of shader; 6 s of GPU process time the first time it draws on a cold
      // cache): draw it for this bundle, in this warm state, scissored to the warm pixel like the fill.
      if (R._warmMaskBakePrograms) {
        let mb = null;
        try {
          _traceStall('mask bake warm', () => {
            mb = R._warmMaskBakePrograms(bundle);
          });
        } catch {
          /* the bake builds itself at its first real draw */
        }
        if (mb === 'defer') return false; // its lean program is still linking: the bundle stays queued (the finally below restores the state)
      }
      if (nb() && R._khrParallel && !R._forceLinks && !gpuClearW()) return false; // (one program per fence, or a batch of cheap ones: see above)
      if ((R._fillVariantBinds | 0) !== binds0) _warmCoverSibling(bundle, warm1); // the variant this warm bound
      // A fallback requested before analytic preparation can remain cold after
      // the bundle switches routes. Warm that exact cover program as well.
      if (R._handle?.coverVertCount >= 3)
        for (const [key, demand] of _psoDemand) {
          if (demand.bundle !== bundle) continue;
          const v = variantCache.get(key);
          if (
            !v ||
            v.pending ||
            v.psoReady ||
            key.includes('MANTLE_LB_FILL') ||
            key.includes('MANTLE_NO_COVER_FILL')
          )
            continue;
          R._uniScope = false;
          beginFillPass(v);
          gl.drawArrays(gl.TRIANGLES, 0, Math.min(6, R._handle.coverVertCount));
          endFillPass();
          v.psoReady = true;
          markBuilt(v, false);
        }
      // Loading calls build the existing universal cover pipeline before gameplay.
      if (
        loadingBase &&
        (R.opts.loadingBaseWarm === true ||
          (R.opts.loadingBaseWarm !== false && R.opts.variantFirst === false)) &&
        !(R.opts.warmManifest && R.opts.loadingBaseWarm !== true) &&
        baseWarms === 0 &&
        R._handle?.triVao &&
        R._handle.coverVertCount >= 3
      ) {
        const base = variantCache.get(defaultKey);
        if (base && !base.pending) {
          endFillPass();
          R._uniScope = false;
          beginFillPass(base);
          gl.drawArrays(gl.TRIANGLES, 0, Math.min(6, R._handle.coverVertCount));
          endFillPass();
          baseWarms++;
          R._baseDrawn = true;
        }
      }
    } finally {
      // Restore state even when a pipeline draw or compile fails.
      endFillPass();
      R._psoWarming = false;
      R._warmScissor = null;
      R._uniCoverFill = false;
      R.draw.channelLerp = savedCl;
      R.draw.worldM = savedWorldM;
      if (ws && ws.cm) {
        R.draw.colorMatrix = savedTintCm;
        R.draw.colorMatrixOffset = savedTintOff;
      }
      R._warmForceKey = savedForce;
      if (wd) {
        R.draw.colorMatrix = savedCm;
        R.draw.colorMatrixOffset = savedCmO;
        R.draw.palette = savedPal;
        R.draw.overrides = savedOv;
        bundle._lbWarmDraw = null;
      }
      R.bindFb(gl.FRAMEBUFFER, savedFbo);
      R._applyTargetScissor(savedFbo);
      R._lastFillPassHandle = null;
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
      R._warmViewport = savedWarmViewport;
    }
    return true;
  }
  /// THE COVER SIBLING, WARMED WITH ITS KEY. A unified key that left out every cover fill kernel
  /// (MANTLE_NO_COVER_FILL) serves this bundle only while no fill row rides as a cover quad; a transform or fill
  /// override moves a row onto one, and that draw binds the same key minus the define. Warm both here, in the
  /// same warm, so a bundle that is ready to draw is ready under an override table too -- awaitLbReady's
  /// promise, and the first frames of an override draw taking the route the later ones take.
  ///
  /// Only once the sibling has LINKED: a warm of a program still linking draws the base, and the unified route's
  /// check would spend one of the bundle's bounded requeues on it. A sibling still linking puts the bundle back
  /// on the warm queue; one that failed to link is gone from the cache and is not retried.
  function _warmCoverSibling(bundle, warm1) {
    const lv = R._lastFillVariant;
    if (!lv || !lv.key || !lv.key.includes('MANTLE_NO_COVER_FILL')) return;
    const sib = compileVariant(
      lv.key.split('|').filter((d) => d !== 'MANTLE_NO_COVER_FILL'),
      'fill:sibling:',
    );
    if (sib.psoReady) return;
    if (sib.pending) {
      const khr = R._khrParallel;
      if (
        (!nb() && khr && !gl.getProgramParameter(sib.prog, khr.COMPLETION_STATUS_KHR)) ||
        !promote(sib.key, sib)
      ) {
        if (variantCache.get(sib.key) === sib && R.opts.psoWarm !== false)
          _psoWarmQueue.push(bundle);
        return;
      }
    }
    R._uniCoverFill = true;
    try {
      _traceStall('pipeline warm (cover sibling)', warm1);
    } finally {
      R._uniCoverFill = false;
    }
    R._coverSiblingWarms = (R._coverSiblingWarms | 0) + 1;
  }

  // Frame-slack gate for pipeline warming. A PSO warm is a synchronous main-thread
  // block; only spend it when recent frames are healthy, so it never turns a busy
  // frame (e.g. a scene transition) into a jank spike. Under load, warms defer and
  // content keeps drawing on the pipeline-warm universal — priority: no stalls > fps.
  // Games can widen/narrow the window or force-allow via R.opts.psoWarmIdle().
  // A single fast frame is not proof of idleness. Require sustained slack, or let
  // the host provide an authoritative psoWarmIdle callback.
  const PSO_WARM_MAX_FRAME_MS = 20; // a "slack" frame runs at least this fast
  const PSO_WARM_IDLE_FRAMES = 45; // ~0.75s of uninterrupted slack ⇒ genuinely idle
  function _psoWarmAllowed(dtMs) {
    if (R._inferSlice) return true; // (the library decided the screen is static and quiet: that IS the slack this gate looks for)
    if (typeof R.opts.psoWarmIdle === 'function') {
      try {
        return !!R.opts.psoWarmIdle(dtMs);
      } catch {
        /* fall through */
      }
    }
    if (idleCfg() && !strictCfg()) return false; // warmPolicy 'idle': slack is the inferred idle window above, not a run of fast frames
    if (typeof document !== 'undefined' && document.hidden) return false;
    return (R._idleFrames | 0) >= PSO_WARM_IDLE_FRAMES;
  }

  const PSO_WARM_MAX_WAIT_FRAMES = 60;
  const PSO_WARM_MIN_WAIT_MS = 1000;
  function _psoWarmMaxWait() {
    const m = R.opts.psoWarmMaxWaitFrames;
    return typeof m === 'number' && m >= 0 ? m : PSO_WARM_MAX_WAIT_FRAMES;
  }
  let agedFrameSerial = null;
  function _ageWarmDemands() {
    let ageThisEntry = true;
    if (R._inFrame) {
      const frameSerial = R._frameSerial | 0;
      ageThisEntry = agedFrameSerial !== frameSerial;
      agedFrameSerial = frameSerial;
    }
    if (!_psoDemand.size) return;
    const selection = engineSelKey(R);
    for (const [key, d] of _psoDemand) {
      // A new engine pin can no longer draw the old policy's variant. Warming
      // its bundle now selects a different program and cannot satisfy this key.
      if (d.selection !== selection) {
        _psoDemand.delete(key);
        continue;
      }
      if (d.ready) {
        if (d.ready()) {
          _psoDemand.delete(key);
          continue;
        }
      } else {
        const v = variantCache.get(key);
        if (!v || v.psoReady || !d.bundle || d.bundle._disposed) {
          _psoDemand.delete(key);
          continue;
        }
      }
      if (ageThisEntry && d.hit) {
        d.frames++;
        d.hit = false;
      }
    }
  }
  // Age demands once per explicit frame; standalone entries retain their cadence.
  // Every entry still removes demands invalidated by readiness, disposal or engine selection.
  R._ageWarmDemands = () => {
    _ageWarmDemands();
  };
  let automaticDemandCursor = null;
  function _warmOverdueDemand(draws = true) {
    const max = _psoWarmMaxWait();
    if (!(max > 0) || typeof R.opts.psoWarmIdle === 'function') return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    const now = _nowMs();
    if (!automaticDemandCursor) automaticDemandCursor = _psoDemand.entries();
    for (let work = 0; work < Math.min(8, _psoDemand.size); work++) {
      let entry = automaticDemandCursor.next();
      if (entry.done) {
        automaticDemandCursor = _psoDemand.entries();
        entry = automaticDemandCursor.next();
        if (entry.done) break;
      }
      const [key, d] = entry.value;
      if (d.frames < max || now - d.since < PSO_WARM_MIN_WAIT_MS) continue;
      // Deferred targets retain their demand. After an actual warm, a different
      // still-cold variant must be demanded again.
      // a demand's own warm (the instanced program) links and draws nothing; a fill variant's warm draws, so where no
      // clear follows it is readied without the draw
      if (d.warm) d.warm();
      else if (!(draws ? _warmBundlePso(d.bundle, true) : _readyBundleNoDraw(d.bundle, true)))
        continue;
      _psoDemand.delete(key);
      R._psoDeadlineWarms = (R._psoDeadlineWarms | 0) + 1;
      return true;
    }
    return false;
  }
  // In slack, a demand with its own warm (the instanced program) is built at once, one per tick. A fill
  // variant's demand is not: slack already drains its bundle through _psoWarmQueue.
  function _warmSlackDemand() {
    for (const [key, d] of _psoDemand) {
      if (!d.warm) continue;
      _psoDemand.delete(key);
      d.warm();
      return true;
    }
    return false;
  }
  /// `opts.draw === false`: everything but the PIPELINE WARM DRAWS. A warm draws one
  /// scissored pixel of the canvas, which only an entry that then CLEARS the canvas takes back -- beginFrame with a
  /// clear color, a standalone render(). Every other entry (a draw outside any frame, beginFrame(null)) still links,
  /// promotes and compiles here, and leaves the drawing to the next entry that clears.
  // ---- SIZE AS A CONTINUOUS INPUT --------------------------------------------------------------------------------------------------
  // Engine choice, kernel pick, the point-route regime and the stroke tiers follow the drawn scale (px per em), so a window drag, a rotation, a
  // fullscreen toggle or a move to another display changes which programs a bundle wants. The warm covers SCALE CLASSES (a quarter octave of the
  // viewport's linear size), not one size: the loading call warms the classes it was told about (`viewport`, `viewports`) and the one it is at; after
  // that, a size that has SETTLED (no change for 350 ms: nothing is built in the middle of a drag, the stand-ins draw) in a class not yet warm starts a
  // background warm of the live bundles for it, stepped a few ms per frame from beginFrame (before the clear, so the warm pixel never shows), behind the
  // fence gate. `debugStats.viewportWarm` lists each class, how long after the last change it settled and how long its warm took.
  const _classOf = (w, h) =>
    Math.round(4 * Math.log2(Math.max(1, Math.sqrt(Math.max(1, w) * Math.max(1, h)))));
  const _warmedClasses = new Set();
  R._noteWarmedViewport = (w, h) => {
    if (w >= 1 && h >= 1) _warmedClasses.add(_classOf(w, h));
  };
  R._viewportClassInfo = () => {
    const v = R.viewportSize ? R.viewportSize() : null;
    const c = v && v[0] >= 1 ? _classOf(v[0], v[1]) : null;
    return {
      vp: v ? [v[0] | 0, v[1] | 0] : null,
      cls: c,
      warmed: c !== null && _warmedClasses.has(c),
      warmedClasses: [..._warmedClasses].sort((x, y) => x - y),
      lastChangeAgoMs: Math.round(_nowMs() - _lastVpChangeAt),
    };
  };
  const _vw = (R._viewportWarm = { changes: 0, events: [], settleMs: 350 });
  /// DEBUG/TEST HOOK only (under __MANTLE_DEBUG__): the production decision answer for a bundle at a viewport -- the keys candidateDefinesFor, _instWantDefsFor and
  /// _pointsWantArgs give under every warm state. The loading call never calls it; the smokes sweep it to prove the analytic breakpoints (strictDerivedRegionsSmoke).
  const _sigOf = (b) => {
    const out = [];
    for (const ws of [null, ...WARM_STATES]) {
      const sw = R.draw.worldM,
        sc = R.draw.colorMatrix,
        so = R.draw.colorMatrixOffset;
      if (ws && ws.world) R.draw.worldM = ws.world;
      if (ws && ws.cm) {
        R.draw.colorMatrix = ws.cm;
        R.draw.colorMatrixOffset = ws.off;
      }
      try {
        for (const d of candidateDefinesFor(b)) out.push(definesKey(d));
        for (const rot of [false, true]) {
          const defs = R._instWantDefsFor && R._instWantDefsFor(b, rot);
          if (defs) out.push('I' + defs.slice().sort().join('|'));
          const a = R._pointsWantArgs && R._pointsWantArgs(b, rot);
          if (a) out.push('P' + JSON.stringify(a));
        }
      } catch {
        out.push('!');
      } finally {
        R.draw.worldM = sw;
        R.draw.colorMatrix = sc;
        R.draw.colorMatrixOffset = so;
      }
    }
    return out.join('\n');
  };
  if (typeof globalThis !== 'undefined' && globalThis.__MANTLE_DEBUG__) {
    const _hashStr = (str) => {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
      return h >>> 0;
    };
    R._sigStr = (b, w, h) => {
      const sv = R._warmViewport;
      R._warmViewport = [w, h];
      try {
        return _sigOf(b);
      } finally {
        R._warmViewport = sv;
      }
    };
    R._sigAt = (b, w, h) => _hashStr(R._sigStr(b, w, h));
  }
  /// The reachable VIEWPORT rectangle: width and height each between the app's minimum window (`minViewportPx`, default 256) and the screen's physical size at
  /// device pixel ratio >= 2 (`maxViewportPx` bounds the larger side when given), widened to hold the canvas as it is now.
  R._reachableRange = (cur, o) => {
    const scr = typeof screen !== 'undefined' ? screen : null;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const k = Math.max(1, 2 / dpr);
    // (the window itself bounds the range from below: a browser window may be larger than the screen object reports, e.g. an emulated or multi-display window)
    const ww =
        typeof outerWidth === 'number'
          ? Math.max(outerWidth, typeof innerWidth === 'number' ? innerWidth : 0) * dpr
          : 0,
      wh =
        typeof outerHeight === 'number'
          ? Math.max(outerHeight, typeof innerHeight === 'number' ? innerHeight : 0) * dpr
          : 0;
    const sw = Math.max(ww, scr ? (scr.width || scr.availWidth || 0) * dpr * k : 0),
      sh = Math.max(wh, scr ? (scr.height || scr.availHeight || 0) * dpr * k : 0);
    const cw = cur && cur[0] > 0 ? cur[0] : sw || 640,
      ch = cur && cur[1] > 0 ? cur[1] : sh || 480;
    const minPx = Math.max(16, +(o && o.minViewportPx) || 256),
      cap = +(o && o.maxViewportPx) || 0;
    const maxW = Math.max(cw, cap || sw || cw),
      maxH = Math.max(ch, cap || sh || ch);
    return { minW: Math.min(minPx, cw), minH: Math.min(minPx, ch), maxW, maxH };
  };
  /// DECISIONS FOLLOW THE FIT SCALE s = min(w / vw, h / vh) of the bundle's own box (vw x vh), not the window's aspect (unit px2 k2 = s^2; strictDerivedRegionsSmoke checks
  /// it at aspects 1:10..10:1), so each bundle is derived in its own scale domain [sLo, sHi] = [min(minW / vw, minH / vh), min(maxW / vw, maxH / vh)]; the viewport for a
  /// scale s is (s * vw, s * vh), inside the reachable rectangle by construction.
  /// SYMBOLIC: the scale-dependent gate of the fill route (lbShapePolicy.js: the bundle size bar, the compact-convex floor, E_MIN, the CPatch area cost gate) is
  /// rows of bars, and lbPickBreaks reads the unit px2 values at which a row can change, with the effect on the route's census (any mesh row, any AA cover row, any
  /// hard cover row) -- no scale is sampled and no gate is called. A bundle whose census never changes inside its range warms at the current size only; one with a
  /// break inside warms a viewport per side, at an interior point of each analytic interval. Gates that are not yet rows of bars are listed in `unmodeled` (the drift
  /// guard in the smoke finds any flip they cause that no break explains).
  R._lbPickModel = (bundle, meshes) => {
    const hardAll = !!(R._preferNoAa && R._preferNoAa(bundle));
    const hardMixed = !hardAll && !!(R._preferNoAaMixed && R._preferNoAaMixed(bundle));
    return lbPickRows(R, bundle, meshes, hardAll, hardMixed);
  };
  R._deriveSizeRegions = (cur, o) => {
    const t0 = _nowMs();
    const rr = R._reachableRange(cur, o);
    const bundles = (o && Array.isArray(o.bundles) ? o.bundles : R._liveBundles()).filter(
      (b) => !b._disposed,
    );
    const box = (b) => {
      const g = b.globalBBox;
      const w = g ? Math.abs(g[2]) : 0,
        h = g ? Math.abs(g[3]) : 0;
      return w > 0 && h > 0 ? [w, h] : null;
    };
    const report = [],
      sizes = [],
      seen = new Set(),
      owners = new Map(); // 'WxH' -> the bundles whose own region this size represents
    const addSize = (w, h, b) => {
      const k = w + 'x' + h;
      if (!seen.has(k)) {
        seen.add(k);
        sizes.push([w, h]);
        owners.set(k, []);
      }
      owners.get(k).push(b);
    };
    bundles.forEach((b, i) => {
      const vb = box(b);
      if (!vb) {
        report.push({ index: i, bbox: null, scaleRange: null, breakpoints: [], regions: 1 });
        return;
      }
      const sLo = Math.min(rr.minW / vb[0], rr.minH / vb[1]),
        sHi = Math.max(sLo * 1.0001, Math.min(rr.maxW / vb[0], rr.maxH / vb[1]));
      let breaks = [];
      const meshes = b._lbMeshes;
      if (meshes && R._lbPickModel) {
        try {
          breaks = lbPickBreaks(R._lbPickModel(b, meshes), sLo * sLo, sHi * sHi).breaks;
        } catch {
          breaks = [];
        }
      }
      // every other size gate of the bundle, each a bar beside its gate: the instanced path's engine pick (the classic AAC gate, coverKernelPolicy.aacClassicBar),
      // the stroke strips (unifiedFillDraw stripBreaks). Key-neutral gates are listed in `keyNeutral` below. These regions are the VIEWPORT's: a draw's world matrix reaches past them, and
      // the gates that move a key are asked over (0, inf) by the warm image (wantKeysOf: scaleProbes, the forced engine picks).
      const extra = [];
      if (
        R.opts.aacFill === 'auto' &&
        !forceSlugKernel() &&
        R._instWantDefsFor &&
        R._instWantDefsFor(b, false)
      )
        extra.push({
          k2: aacClassicBar(b.meanFillShapeArea || 0, aacBundleFloor(b)),
          why: 'aac-classic',
        });
      if (R._stripBreaksFor)
        for (const x of R._stripBreaksFor(b, sLo * sLo, sHi * sHi))
          extra.push({ k2: x.k2, why: 'strip' });
      // THE ENGINE PICK OF THE COVER ROUTES (the pick that moves a plain cover bundle between AAC and Slug with the drawn scale): the classic route's bar, or the unified route's presence
      // model, whose staircase flips at most once (aacPresenceBreak). Both are the gate's own data, so the breaks are exact; each side is a distinct program key and warms a viewport.
      if (
        R.opts.aacFill === 'auto' &&
        !forceSlugKernel() &&
        !engineIsInert(b) &&
        !b.noVBands &&
        !extra.some((x) => x.why === 'aac-classic')
      ) {
        const cls = unifiedDraw(b) && R._unifiedRowClasses ? R._unifiedRowClasses(b) : null;
        if (cls) {
          const st = shapeSegStats(b);
          const pb = aacPresenceBreak(b, cls, st && st.types);
          if (!pb.always && !pb.never) extra.push({ k2: pb.k2, why: 'aac-presence' });
        } else {
          const k2 = aacClassicBar(b.meanFillShapeArea || 0, aacBundleFloor(b));
          if (Number.isFinite(k2)) extra.push({ k2, why: 'aac-pick' });
        }
      }
      for (const x of extra)
        if (x.k2 > sLo * sLo && x.k2 < sHi * sHi && Number.isFinite(x.k2)) breaks.push(x);
      breaks.sort((p, q) => p.k2 - q.k2);
      const bounds = [sLo * sLo, ...breaks.map((x) => x.k2), sHi * sHi];
      report.push({
        index: i,
        bbox: Array.from(b.globalBBox || []),
        scaleRange: [+sLo.toFixed(3), +sHi.toFixed(3)],
        breakpoints: breaks.map((x) => +Math.sqrt(x.k2).toFixed(4)),
        census: breaks.map((x) => x.census),
        why: breaks.map((x) => x.why || 'lb-pick'),
        regions: bounds.length - 1,
      });
      // Only the breaks that change which PROGRAM KEYS the route wants (the LB pick census) need a warm viewport. The AAC gate's two outcomes are both warmed as instanced
      // programs (warmCover); the strip policy changes which cover chunk is drawn, not a program (a strip viewport builds no pipeline).
      if (extra.some((x) => x.why === 'aac-classic' && x.k2 > sLo * sLo && x.k2 < sHi * sHi))
        (R._instBothEngines ||= new WeakSet()).add(b);
      const lbBounds = [
        sLo * sLo,
        ...breaks
          .filter(
            (x) =>
              !x.why || x.why === 'aac-presence' || x.why === 'aac-pick' || x.why === 'aac-classic',
          )
          .map((x) => x.k2),
        sHi * sHi,
      ];
      if (lbBounds.length > 2)
        for (let k = 0; k + 1 < lbBounds.length; k++) {
          const sc = Math.sqrt(Math.sqrt(lbBounds[k] * lbBounds[k + 1]));
          addSize(Math.max(1, Math.round(sc * vb[0])), Math.max(1, Math.round(sc * vb[1])), b);
        }
    });
    const out = {
      range: {
        minW: Math.round(rr.minW),
        minH: Math.round(rr.minH),
        maxW: Math.round(rr.maxW),
        maxH: Math.round(rr.maxH),
      },
      regions: sizes.length,
      sizes,
      bundles: report,
      method: 'analytic',
      // gates with a scale term that never changes a program key or a draw state: the aacPoints route regime and row-run cut choose between two programs that are both warmed (the points program is
      // started whatever the scale, the cover program is the net), and a scale that takes the route with an unbuilt program declines to the cover key; instanceability and monotoneCubicDrawEligible have no
      // scale term (bundle features and the draw's matrix/overrides only); the stroke strips move cover vertices and the depth claim, in one buffer and layout, and no key reads them.
      keyNeutral: [
        'aacPoints regime',
        'aacPoints row-run cut',
        'instanceability',
        'monotoneCubicDrawEligible',
        'stroke strips',
      ],
      ms: Math.round(_nowMs() - t0),
    };
    Object.defineProperty(out, 'ownersOf', { value: owners, enumerable: false }); // (bundle references: the loading call's size skip, never serialized)
    // the report is plain data (debugStats is serialized by the harness); the live bundles are kept only for the smokes, as a non-enumerable property, under __MANTLE_DEBUG__
    if (typeof globalThis !== 'undefined' && globalThis.__MANTLE_DEBUG__)
      Object.defineProperty(out, 'live', { value: bundles, enumerable: false });
    return out;
  };
  let _vpChange = null,
    _bg = null,
    _bgInfo = null;
  let _lastVpChangeAt = -1e9;
  R._noteViewportChange = (w, h) => {
    _vw.changes++;
    _vpChange = { w, h, at: _nowMs() };
    _lastVpChangeAt = _vpChange.at;
  };
  function backgroundViewportWarm() {
    if (!nb() || !R._loadStats || R._loadStats.phase !== 'done' || R.opts.psoWarm === false) return;
    if (_bg) {
      let r;
      try {
        r = R._coopStep(_bg, { _refreshLive: true, _noSync: true }, 3);
      } catch {
        r = { done: true };
      }
      if (r.done) {
        _bgInfo.warmMs = Math.round(_nowMs() - _bgInfo.startedAt);
        _bgInfo.done = true;
        _bg = null;
      }
      return;
    }
    if (!_vpChange || _nowMs() - _vpChange.at < _vw.settleMs) return;
    const cls = _classOf(_vpChange.w, _vpChange.h);
    const at = _vpChange.at,
      size = [_vpChange.w, _vpChange.h];
    _vpChange = null;
    if (_warmedClasses.has(cls)) return; // hysteresis: a class already warm needs nothing
    _warmedClasses.add(cls);
    R._warmViewportOpt = size;
    _bgInfo = {
      size,
      class: cls,
      settledAfterMs: Math.round(_nowMs() - at),
      startedAt: _nowMs(),
      warmMs: null,
      done: false,
    };
    if (_vw.events.length < 40) _vw.events.push(_bgInfo);
    _bg = precompileFillsG({ draw: true });
  }
  /// A WARM LEAVES THE CALLER'S BUNDLE BOUND. A warm draws through setBundle, so without this `renderer.setBundle(a)` followed by a frame's tick or a loading call would leave the last warmed
  /// bundle bound, and a `render()` with no target would draw that one, for good. Taken around each thing that warms: the frame's tick, a loading step, the queue's bundle warm. (A renderer with nothing bound stays as it was left.)
  function restoreBindingOf(h, b) {
    if (!b || b._disposed || R._handle === h) return;
    if (h.bundle === b)
      R._handle = h; // (the handle itself: no GL, and no re-upload of one evicted and made again)
    else R.setBundle(b);
  }
  function fillWarmTick(opts) {
    const keepH = R._handle,
      keepB = keepH && keepH.bundle;
    try {
      return fillWarmTickEntry(opts);
    } finally {
      restoreBindingOf(keepH, keepB);
    }
  }
  function fillWarmTickEntry(opts) {
    R._frameEntryAt = _nowMs();
    if (R._wqFrameTick) R._wqFrameTick(!!(opts && opts.draw)); // (warmQueue: a frame entry before the clear; canvas pipelines may be built here when the screen is idle)
    if (idleCfg() && !strictCfg()) {
      _hookInput();
      _stepIdle();
      if (
        _hasPendingWarm() &&
        _inferredIdle() &&
        !R._coop &&
        !R._warmWindow &&
        R._gpuClear &&
        R._gpuClear()
      ) {
        R._inferSlice = true;
        R._inferredWindows++;
        try {
          return fillWarmTickBody(opts);
        } finally {
          R._inferSlice = false;
        }
      }
    } else if (strictCfg()) {
      _hookInput();
      _stepIdle();
      if (strictNow() && _hasPendingWarm() && _inferredIdle()) {
        R._inferSlice = true;
        R._inferredWindows++;
        try {
          return fillWarmTickBody(opts);
        } finally {
          R._inferSlice = false;
        }
      }
    }
    return fillWarmTickBody(opts);
  }
  function fillWarmTickBody(opts) {
    if (R._contextLost) return;
    const draws = !(opts && opts.draw === false);
    if (draws && !strictNow()) backgroundViewportWarm();
    const _now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const _dt = R._lastWarmTickT ? _now - R._lastWarmTickT : 16;
    R._lastWarmTickT = _now;
    // Sustained-idle accrual: heavy frame → reset; slack frame → +1.
    R._idleFrames = _dt > 0 && _dt <= PSO_WARM_MAX_FRAME_MS ? (R._idleFrames | 0) + 1 : 0;
    // Demands age on every tick (beginFrame's included), the ticks that return early below too.
    _ageWarmDemands();

    if (!R._cpatchPoolWarmed && R.opts && R.opts.cpatchFill && _psoWarmAllowed(_dt)) {
      R._cpatchPoolWarmed = true;
      try {
        getRendererFeature('cpatch')?.warmCpatchPool();
      } catch {
        /* no workers here; the build converts inline */
      }
    }
    // Bundles enqueue themselves at creation time; each renderer drains its own share.
    let budget = strictNow() ? 0 : 8; // (strict play links nothing: a bundle that arrives in play is prewarmed by the next window)
    while (budget-- > 0) {
      const b = takeFillPrewarm(_prewarmQ, _skipMorphSource);
      if (!b) break;
      prewarmFillVariant(b);
      if (R.opts.psoWarm !== false) _psoWarmQueue.push(b);
    }
    // Promote at most one linked variant per frame, before any geometry is bound.
    const khr = R._khrParallel;
    for (const [key, v] of variantCache) {
      // A twin stays unpromoted until a draw needs it: promoting reads the program's uniforms, a round trip to a GPU process that can be
      // seconds deep in a pipeline build, and nothing needs the twin before then.
      if (!v.pending || (v.speculative && !R._inferSlice)) continue; // (an inferred window promotes the twins the stand-ins were drawn for)
      if (khr) {
        R._variantPolls = (R._variantPolls || 0) + 1;
        if (!gl.getProgramParameter(v.prog, khr.COMPLETION_STATUS_KHR)) continue;
        if (nb() && !R._gpuClear()) return; // linked, but the GPU thread is still building pipelines ahead of any query: ask again next tick
      }
      promote(key, v);
      return; // one promote/frame; aux + PSO warm below wait until every fill link has settled
    }
    // Warm auxiliary morph and instanced programs after fill variants settle,
    // draining one compile per frame — unless precompileFills already drained them
    // behind the load screen, which is where they belong.
    ensureAuxQueue();
    if (_auxProgHead < _auxProgQueue.length) {
      try {
        _auxProgQueue[_auxProgHead++](false);
      } catch {
        /* best-effort */
      }
      if (_auxProgHead === _auxProgQueue.length) {
        _auxProgQueue.length = 0;
        _auxProgHead = 0;
      }
      return;
    }
    // Strict play builds no pipeline: the queue waits for the next warm window. warmPolicy 'off' builds none in the background at all.
    if (strictNow() || (offCfg() && !R._inferSlice)) return;
    // Links all settled ⇒ build one bundle's pipeline state this frame (fill-only, off the frame
    // that first shows it). Drains during load; gameplay is untouched once empty.
    while (
      _psoWarmHead < _psoWarmQueue.length &&
      (!_psoWarmQueue[_psoWarmHead] || _psoWarmQueue[_psoWarmHead]._disposed)
    )
      _psoWarmHead++;
    if (_psoWarmHead === _psoWarmQueue.length) {
      _psoWarmQueue.length = 0;
      _psoWarmHead = 0;
    }
    R._psoWarmPending = _psoWarmQueue.length - _psoWarmHead;
    // An entry that keeps the canvas draws no warm: the same order, with the bundle queue and the overdue fill
    // demands readied without a draw. A demand carrying its own warm (the instanced program) links and draws nothing,
    // so it runs as it does below.
    if (!draws) {
      if (R.opts.psoWarm === false) return;
      if (
        _psoWarmHead >= _psoWarmQueue.length &&
        _psoDemand.size &&
        _psoWarmAllowed(_dt) &&
        _warmSlackDemand()
      )
        return;
      if (_psoWarmHead < _psoWarmQueue.length && _psoWarmAllowed(_dt)) {
        const index = nextAutomaticWarmIndex();
        if (index < 0 || !_readyBundleNoDraw(_psoWarmQueue[index], true)) return;
        consumeAutomaticWarm(index);
        if (_psoWarmHead === _psoWarmQueue.length) {
          _psoWarmQueue.length = 0;
          _psoWarmHead = 0;
        }
        return;
      }
      if (_psoDemand.size) _warmOverdueDemand(false);
      return;
    }
    // With the bundle queue drained, slack builds a demand that carries its own warm (the instanced
    // fast path's specialized program).
    if (
      R.opts.psoWarm !== false &&
      _psoWarmHead >= _psoWarmQueue.length &&
      _psoDemand.size &&
      _psoWarmAllowed(_dt) &&
      _warmSlackDemand()
    )
      return;
    if (R.opts.psoWarm !== false && _psoWarmHead < _psoWarmQueue.length && _psoWarmAllowed(_dt)) {
      const index = nextAutomaticWarmIndex();
      if (index < 0 || !_warmBundlePso(_psoWarmQueue[index], true)) return;
      consumeAutomaticWarm(index);
      if (_psoWarmHead === _psoWarmQueue.length) {
        _psoWarmQueue.length = 0;
        _psoWarmHead = 0;
      } else if (_psoWarmHead >= 1024 && _psoWarmHead * 2 >= _psoWarmQueue.length) {
        _psoWarmQueue.splice(0, _psoWarmHead);
        _psoWarmHead = 0;
      }
      return;
    }
    // No slack this tick: a demand past its deadline is built now.
    if (R.opts.psoWarm !== false && _psoDemand.size) _warmOverdueDemand();
  }

  // The auxiliary programs a scene may reach for AFTER the fill variants: the LB morph
  // pair, the LB coverage fill (clip/mask/filter/stroke morphs) and the instanced Slug
  // fill. Each links SYNCHRONOUSLY inside its own _ensure*, so where they are built is
  // where the stall lands. Built once, then drained either by precompileFills (behind
  // the load screen — the right place) or one per frame by fillWarmTick (the fallback
  // for a consumer that never calls it).
  /// The options under which a universal (all-feature) program can be a DRAW TARGET: variantFirst:false returns the base unconditionally (leanOrBase), psoWarm:false
  /// skips the lean-first rules, loadingBaseWarm:true draws it behind the load screen; eagerPrograms:true is the explicit opt-in. Under the default options the universal
  /// programs (fill base, AAC base, instanced base, instanced AAC) are never selected while a lean variant can serve, so they are not built ahead of demand.
  function universalsEager() {
    return (
      R.opts.variantFirst === false ||
      R.opts.psoWarm === false ||
      R.opts.loadingBaseWarm === true ||
      R.opts.eagerPrograms === true
    );
  }
  R._universalsEager = universalsEager;
  function ensureAuxQueue() {
    if (_auxProgQueue !== null) return;
    _auxProgQueue = [];
    _auxProgHead = 0;
    if (R._lbFillMode !== 'off') {
      if (R._ensureFillLBCovProg)
        _auxProgQueue.push((block) => R._ensureFillLBCovProg(true, !block)); // clip/mask/filter/stroke morphs
    }
    if (R._instancedFastEnabled && R._ensureInstProg) {
      // A thunk takes `block`: precompileFills (behind the load screen) finishes the link; an idle tick only starts it
      // when the driver can compile in parallel, and the draw that needs the program finishes it once it reports complete.
      // THE UNIVERSAL INSTANCED PROGRAMS (Slug, AAC: hundreds of KB each, which real content does not draw) are built only where an option makes them a draw target,
      // like the base fill program; a bundle that omits nothing starts its own (the same key) with its prewarm, and a draw declines to the per-instance loop until it links.
      if (universalsEager()) {
        _auxProgQueue.push((block) => (block ? R._ensureInstProg([]) : R._beginInstancedFill([]))); // instanced Slug
        if (R.opts.aacFill)
          _auxProgQueue.push((block) =>
            block ? R._ensureInstProg(['MANTLE_AAC']) : R._beginInstancedFill(['MANTLE_AAC']),
          ); // instanced AAC
      }
    }
    // Compile the AAC base asynchronously during load so pending variants have a
    // compatible fallback without a first-draw link.
    if (R.opts.aacFill && universalsEager() && !variantCache.has(aacBaseKey))
      _auxProgQueue.push(() => {
        if (variantCache.has(aacBaseKey)) return;
        const _d = (R.opts.fillDefines || []).concat(['MANTLE_AAC']);
        const prog = R.program(
          R.withDefines(R.shaderSources.fillVert, _d),
          R.withDefines(R.shaderSources.fillFrag, _d),
          'fill:aac-base',
        );
        putVariant(aacBaseKey, { prog, u: null, pending: true, psoReady: true, universal: true });
      });
  }

  R.fillWarmTick = fillWarmTick;

  /// Explicit up-front warm of every loaded bundle's fill pipelines. Use this when
  /// gameplay has no idle warm window. Call it behind the loading screen after bundles are
  /// created, before gameplay — to pay the compile + pipeline cost where a pause is
  /// invisible. Blocking by design (that's the point): it force-links every pending
  /// fill program. Pipeline draws are bounded; gameplay uses the
  /// lean variants once their pipelines are warmed. Large queues can require another call
  /// after the budget or duplicate-variant stop. No-op if psoWarm is disabled.
  /// Returns the number of bundle warm attempts in this call.
  /// `opts.draw === false`: link and ready everything, but draw no pipeline warm: the renderer's own forced
  /// calls from inside a draw, where no clear follows. The public call draws its warms, behind a load screen that the
  /// first frame's clear takes back.
  let customWarms = 0;
  /// COOPERATIVE LOADING. A synchronous loading call WAITS in four places: a forced link of every pending fill program, the aux/instanced/point/
  /// mask-bake/filter/lerp finishers, a warm that found its program unready, and the closing GPU barrier. Waiting is a frozen main thread, so the
  /// loading work is a generator: where the synchronous call waited, the cooperative driver (renderer.precompileFillsAsync, via R._coopStep)
  /// gets a `yield` and comes back on a timer once the thing it waited for is ready; `precompileFills()` (blocking, documented) runs the same
  /// generator to the end with R._forceLinks set, and never sees a yield that matters.
  /// A pause also puts back the draw-state flags the generator holds across its yields (an app frame may run between two resumptions).
  function* pause(kind) {
    const ws = R._warmState,
      exact = R._wmExact;
    R._warmState = null;
    R._wmExact = false;
    R._coopPauses = (R._coopPauses | 0) + 1;
    R._coopLastPause = kind;
    yield kind;
    R._warmState = ws;
    R._wmExact = exact;
  }
  function* maybeSlice() {
    if (R._coop && _nowMs() - R._sliceT0 > R._sliceMs) yield* pause('slice');
  }
  /// The pending fill variants, promoted as far as the gate allows (complete AND the GPU thread clear): no query is made on a program that
  /// is not. One time slice's worth per call. Returns how many are still pending.
  function promoteReady() {
    let pending = 0;
    for (const [key, v] of Array.from(variantCache)) {
      if (!v.pending || v.speculative) continue;
      if (R._coop && _nowMs() - R._sliceT0 > R._sliceMs) {
        pending++;
        continue;
      }
      if (!promote(key, v) && variantCache.get(key) === v) pending++;
    }
    return pending;
  }
  R._promoteReady = promoteReady;
  function* precompilePass(opts) {
    if (R.opts.psoWarm === false || R._contextLost) return 0;
    const draws = !(opts && opts.draw === false);
    _ageWarmDemands();
    // Bundle-level recolor declarations make the required variant known at load.
    // 1) Compile every enqueued bundle's variant programs; queue them for PSO warm.
    let b;
    const _taken = [];
    while ((b = takeFillPrewarm(_prewarmQ, _skipMorphSource))) _taken.push(b);
    // sceneUnion: 'auto' -- the loading call declares the scene's bundles as one scene (setSceneUnion) before it builds any program, so a class of
    // bundles binds ONE program (sceneUnion.js) instead of one per bundle x candidate x draw state. An explicit setSceneUnion call wins.
    if (R.opts.sceneUnion === 'auto' && !R._userSceneUnion) {
      const set = new Set(_taken);
      if (R._liveBundles) for (const lb of R._liveBundles()) set.add(lb);
      const all = Array.from(set).filter((x) => x && !x._disposed);
      if (all.length > 1 && all.length !== _autoSceneN) {
        _autoSceneN = all.length;
        setSceneUnion(all);
      }
    }
    for (b of _taken) {
      prewarmFillVariant(b);
      if (!(R._wmCovers && R._wmCovers(b))) _psoWarmQueue.push(b);
    } // a manifest names the states of the bundles it knows; they are drawn below
    // precompileFillsAsync: the analytic meshes have arrived since the bundles were first prewarmed, so their variants are not the ones
    // prewarmed then -- ask again, and warm every live bundle.
    if (draws && R._refreshLive) {
      const queued = new Set(_psoWarmQueue.slice(_psoWarmHead));
      for (const lb of R._liveBundles()) {
        prewarmFillVariant(lb);
        if (!queued.has(lb) && !(R._wmCovers && R._wmCovers(lb))) _psoWarmQueue.push(lb);
      }
    }
    // Explicit loading work must also service variants whose bounded draw-time
    // requeue allowance is spent. A queued bundle can satisfy several demands.
    if (draws) {
      const queued = new Set(_psoWarmQueue.slice(_psoWarmHead));
      const current = R._handle;
      // (the universal cover is drawn in loading only when the loading base warm is on; off, there is nothing to queue the current bundle for)
      if (
        baseWarmOn() &&
        baseWarms === 0 &&
        current?.triVao &&
        current.coverVertCount >= 3 &&
        current.bundle &&
        !current.bundle._disposed &&
        !queued.has(current.bundle)
      ) {
        queued.add(current.bundle);
        _psoWarmQueue.push(current.bundle);
      }
      for (const d of _psoDemand.values()) {
        if (d.bundle && !d.bundle._disposed && !queued.has(d.bundle)) {
          queued.add(d.bundle);
          _psoWarmQueue.push(d.bundle);
        }
      }
    }
    // 2) Force-link every pending fill program now (promote reads LINK_STATUS, which
    //    blocks until the driver finishes — acceptable behind a load screen).
    if (R._coop) {
      while (promoteReady() > 0) yield* pause('link');
    } else for (const [key, v] of variantCache) if (v.pending && !v.speculative) promote(key, v);

    ensureAuxQueue();
    while (_auxProgHead < _auxProgQueue.length) {
      try {
        _auxProgQueue[_auxProgHead++](!R._coop);
      } catch {
        /* best-effort */
      } // (cooperative: start the link, the finishers below wait for it)
    }
    _auxProgQueue.length = 0;
    _auxProgHead = 0;
    // Whatever else the prewarm only started (point, instanced, filter and morph helper programs) finishes here as well: on a cold driver
    // cache its compile otherwise runs through the first seconds of play, and every frame in them is late.
    if (draws) {
      if (R._coop) {
        // Each finisher completes the programs that are ready and answers how many still link; a pause lets the driver compile.
        const softAll = () =>
          (R._finishPointPrograms ? R._finishPointPrograms(true) : 0) +
          (R._finishMaskBakePrograms ? R._finishMaskBakePrograms(true) : 0) +
          (R._finishInstancedPrograms ? R._finishInstancedPrograms(true) : 0) +
          (R._finishFilterPrograms ? R._finishFilterPrograms(true) : 0) +
          (R._finishLbCovPrograms ? R._finishLbCovPrograms(true) : 0) +
          (finishLerpPass(gl, true, R._programReady) | 0);
        while (softAll() > 0) yield* pause('finish');
      } else {
        if (R._finishPointPrograms) R._finishPointPrograms();
        if (R._finishMaskBakePrograms) R._finishMaskBakePrograms();
        if (R._finishInstancedPrograms) R._finishInstancedPrograms();
        if (R._finishFilterPrograms) R._finishFilterPrograms();
        if (R._finishLbCovPrograms) R._finishLbCovPrograms();
        finishLerpPass(gl);
      }
    }
    // Specialized instanced programs register their own loading callbacks.
    // Explicit loading work does not depend on a later idle frame or deadline.
    if (draws)
      for (const [key, demand] of _psoDemand) {
        if (demand.warm) {
          _psoDemand.delete(key);
          if (!demand.ready || !demand.ready()) {
            demand.warm();
            // The scene must draw and fence a program linked after its last draw.
            customWarms++;
          }
        }
      }
    // Warm one representative per variant and blend state. Bound repeated work
    // by count and elapsed time; keep unvisited entries for the next loading call.
    // An individual driver compilation can exceed this scheduling budget.
    const readyCount = () => {
      let r = 0;
      for (const v of variantCache.values()) if (v.psoReady) r++;
      return r;
    };
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const budget = R.opts.precompileFillsBudgetMs != null ? R.opts.precompileFillsBudgetMs : 800;
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let n = 0,
      stale = 0;
    // (an exhaustive warm -- precompileFillsAsync, the future-state passes -- visits every queued bundle: two bundles with the same lean variant
    // still differ in their mask bakes, point programs, instanced programs and split passes)
    const exhaustive = !!(R._refreshLive || R._warmState);
    let declinedRun = 0;
    while (
      _psoWarmHead < _psoWarmQueue.length &&
      (exhaustive || (stale < 8 && n < 128)) &&
      (R._coop || nowMs() - t0 < budget)
    ) {
      const bundle = _psoWarmQueue[_psoWarmHead];
      // Disposed entries need no work and must not consume the duplicate budget.
      if (!bundle || bundle._disposed) {
        _psoWarmHead++;
        continue;
      }
      const before = readyCount();
      if (R._coop) yield* maybeSlice();
      if (draws && !_warmBundlePso(bundle, false, true)) {
        // The bundle's program is not ready (still linking, or the GPU thread is behind the pipelines already queued): nothing was drawn and nothing
        // waited. The synchronous call stops here; the cooperative call lets the driver compile and asks again.
        if (!R._coop) break;
        promoteReady();
        if (++declinedRun > 4000) {
          _psoWarmHead++;
          declinedRun = 0;
          continue;
        } // a bundle that never becomes ready is the driver's deadline's business
        yield* pause('warm');
        continue;
      }
      declinedRun = 0;
      if (!draws) _readyBundleNoDraw(_psoWarmQueue[_psoWarmHead]);
      _psoWarmHead++;
      n++;
      if (readyCount() > before) stale = 0;
      else stale++;
    }
    // A budget or duplicate-variant stop does not prove that later entries share
    // a warm pipeline. Keep the unvisited tail for another loading call or idle tick.
    _psoWarmQueue.splice(0, _psoWarmHead);
    _psoWarmHead = 0;
    // The warm draws only queue the driver's pipeline builds: on a cold cache they run for seconds on the GPU process, and a page that
    // starts drawing before they finish presents nothing until they do (a late first seconds of play, with the main thread idle).
    // The loading call waits for them here, behind the load screen.
    return n;
  }
  /// The bundles this renderer has warmed or been asked to (weak): what the loading call re-draws under each future state.
  const _liveRefs = [],
    _liveSeen = new WeakSet();
  function noteLive(b) {
    if (b && !_liveSeen.has(b)) {
      _liveSeen.add(b);
      _liveRefs.push(new WeakRef(b));
      if (R._wmSeen) R._wmSeen(b);
    }
  }
  // A WARM SCOPED TO ONE LATE BUNDLE (awaitBundleReady): the passes below walk this list, and re-drawing the whole scene for one new bundle held real games for up to 4.7 s in play (713 warm
  // draws for a dashed ring). A full loading call in flight sees everything. Keys already built draw nothing new, so the rest of the scene had nothing to gain.
  const _warmScope = new Map();
  let _fullWarms = 0;
  R._warmScopeEnter = (b) => {
    if (!b) {
      _fullWarms++;
      return;
    }
    noteLive(b);
    _warmScope.set(b, (_warmScope.get(b) | 0) + 1);
  };
  R._warmScopeExit = (b) => {
    if (!b) {
      _fullWarms--;
      return;
    }
    const n = (_warmScope.get(b) | 0) - 1;
    if (n > 0) _warmScope.set(b, n);
    else _warmScope.delete(b);
  };
  R._liveBundles = () => {
    if (_warmScope.size && !_fullWarms) return [..._warmScope.keys()].filter((b) => !b._disposed);
    const out = [];
    for (let i = _liveRefs.length - 1; i >= 0; i--) {
      const b = _liveRefs[i].deref();
      if (!b || b._disposed) _liveRefs.splice(i, 1);
      else out.unshift(b);
    }
    return out;
  };
  /// A pixel read-back is a barrier no earlier command can be behind. gl.finish() alone returns in Chrome with the GPU process still
  /// building the pipelines the warm draws queued, and the page started drawing with seconds of builds ahead of its first frame.
  const _syncPx = new Uint8Array(4);
  function gpuSync() {
    try {
      gl.finish();
      const saved = R._boundDrawFbo || null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _syncPx);
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved);
    } catch {
      /* a context without read-back: the finish above is the best available */
    }
  }
  /// Draw the bundle's instanced fast path once, under the warm state, scissored to the warm pixel, so its (rotated) instanced program and
  /// pipeline are built behind the load screen.
  function warmInstanced(bundle) {
    if (!R._instancedFastEnabled || !R.drawBundleInstanced || bundle._disposed || !bundle.curveTex)
      return;
    if (R._warmState && R._warmState.inst === false) return; // a recorded plain-draw state: no instanced program to build
    const ws = R._warmState,
      wm = ws && ws.world ? ws.world : WARM_IDENTITY_MAP;
    const savedFbo = R._boundDrawFbo || null;
    R._warmScissor = WARM_PIXEL;
    try {
      R.bindFb(gl.FRAMEBUFFER, R._warmTarget || null);
      R._applyTargetScissor(R._warmTarget || null);
      const list = [{ worldMatrix: wm }, { worldMatrix: wm }, { worldMatrix: wm }];
      R._psoWarming = true;
      R.drawBundleInstanced(bundle, list);
    } catch {
      /* the first real instanced draw builds it */
    } finally {
      R._psoWarming = false;
      R._warmScissor = null;
      R.bindFb(gl.FRAMEBUFFER, savedFbo);
      R._applyTargetScissor(savedFbo);
      R._lastFillPassHandle = null;
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
    }
  }
  /// STRICT PLAY's pipelines for the filter helpers (blits, linear-light blits, fused blurs, effect masks): each drawn once, one program per fence, on
  /// the canvas and on a texture target, with blend on (ONE, ONE_MINUS_SRC_ALPHA: a composite) and off (a pass into a target), one pixel.
  let _auxRt = null;
  const _auxDone = new Set(),
    _auxDoneMorphs = new WeakSet();
  const _auxDummy = new Map();
  R._auxWarmed = () => [..._auxDone].filter((k) => typeof k === 'string'); // debugStats.auxWarmed: the helper programs whose four loading draws were issued
  /// A sampler uniform never set reads unit 0, so a program with two sampler types (the effect mask: sampler2D + sampler2DArray) draws with two
  /// textures of different types on one unit: GL_INVALID_OPERATION, the draw never reaches the GPU and the pipeline is not built at load. Give every
  /// sampler of the program its own unit (in declaration order), a 1x1 texture of its type on that unit, run the draws, then put back the unit
  /// bindings and the active unit. Returns the undo, or null for a program with one sampler: it cannot meet another type on its unit.
  /// The samplers' VALUES are not read back: getUniform waits for the GPU process (seconds behind a scene's loading compiles), and every
  /// helper with two samplers sets both at each of its draws (the effect mask: uCacheTex 0, uMasks 3).
  function bindAuxSamplers(prog) {
    /** @type {Map<number, number>} */
    const kinds = new Map([
      [gl.SAMPLER_2D, gl.TEXTURE_2D],
      [gl.SAMPLER_2D_ARRAY, gl.TEXTURE_2D_ARRAY],
      [gl.SAMPLER_3D, gl.TEXTURE_3D],
      [gl.SAMPLER_CUBE, gl.TEXTURE_CUBE_MAP],
    ]);
    /** @type {Map<number, number>} */
    const binding = new Map([
      [gl.TEXTURE_2D, gl.TEXTURE_BINDING_2D],
      [gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BINDING_2D_ARRAY],
      [gl.TEXTURE_3D, gl.TEXTURE_BINDING_3D],
      [gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BINDING_CUBE_MAP],
    ]);
    const samplers = [];
    for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const info = gl.getActiveUniform(prog, i),
        target = info && kinds.get(info.type);
      if (target) samplers.push({ info, target });
    }
    if (samplers.reduce((s, x) => s + x.info.size, 0) < 2) return null;
    const prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE),
      savedTex = [];
    R.glUseProgram(prog);
    let unit = 0;
    for (const { info, target } of samplers) {
      const loc = gl.getUniformLocation(prog, info.name),
        units = [];
      for (let k = 0; k < info.size; k++) {
        const u = unit++;
        units.push(u);
        gl.activeTexture(gl.TEXTURE0 + u);
        savedTex.push([u, target, gl.getParameter(binding.get(target))]);
        let tex = _auxDummy.get(target);
        if (!tex) {
          tex = trackGlResource(gl, gl.createTexture());
          _auxDummy.set(target, tex);
          gl.bindTexture(target, tex);
          if (target === gl.TEXTURE_CUBE_MAP)
            for (let f = 0; f < 6; f++)
              gl.texImage2D(
                gl.TEXTURE_CUBE_MAP_POSITIVE_X + f,
                0,
                gl.RGBA8,
                1,
                1,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                null,
              );
          else if (target === gl.TEXTURE_2D)
            gl.texImage2D(target, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          else gl.texImage3D(target, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        } else gl.bindTexture(target, tex);
      }
      if (info.size > 1) gl.uniform1iv(loc, units);
      else gl.uniform1i(loc, units[0]);
    }
    return () => {
      for (let i = savedTex.length - 1; i >= 0; i--) {
        gl.activeTexture(gl.TEXTURE0 + savedTex[i][0]);
        gl.bindTexture(savedTex[i][1], savedTex[i][2]);
      }
      gl.activeTexture(prevUnit);
      R._forgetFillUnits(); // the fill pass's unit shadow knows nothing of these binds
    };
  }
  function* warmAuxPipelines() {
    if (!strictCfg() || !R._filterAuxPrograms || R.opts.psoWarm === false || R._contextLost)
      return 0;
    let n = 0;
    // the opaque prepass (a depth-only program drawn on a bundle's first frames), built here instead of at the first frame of play
    if (R.warmOpaquePrepass && R.opts.opaquePrepass !== false && !_auxDone.has('prepass')) {
      let ok = false;
      for (let i = 0; !ok && i < 1500; i++) {
        while (R._khrParallel && nb() && !R._forceLinks && !gpuClearW()) yield* pause('warm');
        const savedFbo = R._boundDrawFbo || null;
        try {
          R._warmScissor = WARM_PIXEL;
          R.bindFb(gl.FRAMEBUFFER, null);
          R._applyTargetScissor(null);
          ok = R.warmOpaquePrepass();
        } catch {
          ok = true;
        } finally {
          R._warmScissor = null;
          R.bindFb(gl.FRAMEBUFFER, savedFbo);
          R._applyTargetScissor(savedFbo);
          R._lastFillPassHandle = null;
        }
        if (!ok) {
          if (!R._coop) break;
          yield* pause('link');
          promoteReady();
        }
      }
      if (ok) {
        _auxDone.add('prepass');
        n++;
      }
    }
    // the filter helpers, started whatever the loaded bundles hold (a bundle that arrives in play may filter): linked, primed, then drawn below
    if (R._primeFilterPrograms)
      for (let i = 0; i < 1500 && R._primeFilterPrograms() > 0 && R._coop; i++) {
        yield* pause('link');
        promoteReady();
      }
    // feature modules' own passes (the morph lerp and fixup passes), once per context, before any morph exists
    for (const warm of auxWarmers) {
      if (_auxDone.has(warm)) continue;
      while (R._khrParallel && nb() && !R._forceLinks && !gpuClearW()) yield* pause('warm');
      let ok = false;
      try {
        const clearNow = () => !(R._khrParallel && nb() && !R._forceLinks) || gpuClearW();
        ok = warm(gl, R._programReady, clearNow);
        for (let i = 0; !ok && R._coop && i < 1500; i++) {
          yield* pause('link');
          promoteReady();
          ok = warm(gl, R._programReady, clearNow);
        }
      } catch {
        ok = true;
      }
      if (ok) {
        _auxDone.add(warm);
        n++;
      }
    }
    // the morphs' lerp and fixup passes (texture targets of the planes' formats): each live morph bundle redraws its current pose once
    for (const b of R._liveBundles()) {
      if (!b._morphWarm || _auxDoneMorphs.has(b)) continue; // (weak: a disposed morph is not kept alive by having been warmed)
      while (R._khrParallel && nb() && !R._forceLinks && !gpuClearW()) yield* pause('warm');
      try {
        let ok = b._morphWarm();
        for (let i = 0; !ok && R._coop && i < 1500; i++) {
          yield* pause('link');
          promoteReady();
          while (R._khrParallel && nb() && !R._forceLinks && !R._gpuClear()) yield* pause('warm');
          ok = b._morphWarm();
        }
        if (ok) {
          _auxDoneMorphs.add(b);
          n++;
        }
      } catch {
        /* the first real setT builds it */
      }
    }
    // the group composite's instanced program (renderer.js _compositeInstanced), first asked for by a run of two composites. A bundle reaches one where a fade needs its group: authored groups, leaves
    // that can overlap, or one leaf under a recolor that touches alpha (R._alphaNeedsGroup, with the declared reach's recolor). One program, a pipeline on each attachment set a composite lands on
    // (the canvas; a cache or a group's accumulator, RGBA8 + depth/stencil): a run that met it unbuilt linked it and built it in play.
    if (
      !_auxDone.has('compositeInstanced') &&
      R._compositeWarmStart &&
      R._liveBundles().some((b) => {
        const dom = R._declaredDomain ? R._declaredDomain(b) : null;
        return !drawsNothing(b) && R._alphaNeedsGroup(b, !dom || dom.recolor);
      })
    ) {
      const prog = R._compositeWarmStart();
      if (prog) {
        while (R._khrParallel && nb() && !R._forceLinks && !gpuClearW()) yield* pause('warm');
        for (
          let i = 0;
          i < 1500 && R._khrParallel && nb() && !R._forceLinks && !R._programReady(prog) && R._coop;
          i++
        )
          yield* pause('link');
        if (!(R._khrParallel && nb() && !R._forceLinks && !R._programReady(prog))) {
          const savedFbo = R._boundDrawFbo || null,
            prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE),
            [cw, ch] = viewportSize(),
            tg = warmTargets()[0];
          let ok = true;
          try {
            R._warmScissor = WARM_PIXEL;
            for (const target of tg ? [null, tg.fbo] : [null]) {
              gl.bindFramebuffer(gl.FRAMEBUFFER, target);
              if (target) R.glDisable(gl.SCISSOR_TEST);
              else R._applyTargetScissor(null);
              if (!R._compositeWarmDraw(cw, ch)) ok = false;
            }
            if (ok) {
              _auxDone.add('compositeInstanced');
              n++;
            }
          } catch {
            /* the first real run builds it */
          } finally {
            R._warmScissor = null;
            R.glDisable(gl.BLEND);
            gl.activeTexture(prevUnit);
            if (R._forgetFillUnits) R._forgetFillUnits();
            R.bindFb(gl.FRAMEBUFFER, savedFbo);
            R._applyTargetScissor(savedFbo);
            R._lastFillPassHandle = null;
            R.fillPassCanvasW = 0;
            R.fillPassCanvasH = 0;
          }
        }
      }
    }
    for (const { label, prog } of R._filterAuxPrograms()) {
      if (_auxDone.has(label)) continue;
      while (R._khrParallel && nb() && !R._forceLinks && !gpuClearW()) yield* pause('warm');
      // (a helper still linking is waited for: the loading call does not end with a filter program unbuilt)
      for (
        let i = 0;
        i < 1500 && R._khrParallel && nb() && !R._forceLinks && !R._programReady(prog) && R._coop;
        i++
      ) {
        yield* pause('link');
      }
      if (R._khrParallel && nb() && !R._forceLinks && !R._programReady(prog)) continue;
      const savedFbo = R._boundDrawFbo || null;
      let undoSamplers = null;
      try {
        if (!_auxRt) {
          const tex = trackGlResource(gl, gl.createTexture()),
            fbo = trackGlResource(gl, gl.createFramebuffer()),
            prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindTexture(gl.TEXTURE_2D, prevTex);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          _auxRt = { tex, fbo };
        }
        R._warmScissor = WARM_PIXEL;
        R.glDisable(gl.DEPTH_TEST);
        R.glDisable(gl.STENCIL_TEST);
        undoSamplers = bindAuxSamplers(prog);
        for (const target of [null, _auxRt.fbo]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target);
          if (target) {
            R.glDisable(gl.SCISSOR_TEST);
            R.glViewport(0, 0, 4, 4);
          } else {
            R._applyTargetScissor(null);
            const [cw, ch] = viewportSize();
            R.glViewport(0, 0, cw, ch);
          } // (through the shadow: the first fill's own call is skipped when the shadow already reads its size)
          for (const on of [true, false]) {
            if (on) {
              R.glEnable(gl.BLEND);
              R.glBlendEquation(gl.FUNC_ADD);
              R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            } else R.glDisable(gl.BLEND);
            R.glUseProgram(prog);
            R.glBindVertexArray(R.coverVao);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            R.glBindVertexArray(null);
          }
        }
        _auxDone.add(label);
        n++;
      } catch {
        /* the first real filtered draw builds it */
      } finally {
        if (undoSamplers)
          try {
            undoSamplers();
          } catch {
            /* best effort */
          }
        R._warmScissor = null;
        R.glDisable(gl.BLEND);
        R.bindFb(gl.FRAMEBUFFER, savedFbo);
        R._applyTargetScissor(savedFbo);
        R._lastFillPassHandle = null;
        R.fillPassCanvasW = 0;
        R.fillPassCanvasH = 0;
      }
    }
    return n;
  }
  const WARM_CHLERP = {
    primary: [0.2, 0.2, 0.2, 1],
    contrast: [0, 0, 0, 1],
    highlight: [1, 1, 1, 1],
  }; // the channel-lerp recolor (two-tone text and glyphs)
  const WARM_STATES = [
    { world: WARM_ROTATED_MAP },
    { cm: WARM_TINT, off: WARM_TINT_OFFSET },
    { world: WARM_ROTATED_MAP, cm: WARM_TINT, off: WARM_TINT_OFFSET },
  ];
  const WARM_CHANNEL_LERP = {
    primary: [0.8, 0.2, 0.2, 1],
    contrast: [0.2, 0.2, 0.8, 1],
    highlight: [1, 1, 1, 1],
  }; // (a channel-lerp recolor for the warm: the values never reach a visible pixel)
  /// THE LOADING CALL: everything the first seconds of play will ask for, built behind the load screen and finished with a GPU barrier.
  /// Pass one is the scene as drawn; then the same bundles under the draw states play meets that loading cannot see (a rotated map, a
  /// recolor), each in passes so a variant a state asks for is linked before the pass that builds its pipeline. `draw:false` and
  /// `warmFutureStates:false` keep the single pass. The synchronous call does the single pass (and the GPU barrier) unless asked
  /// (`precompileFills({ futureStates: true })` or the renderer option `warmFutureStates: true`); precompileFillsAsync always does the states.
  /// THE ENGINE CANDIDATES' PIPELINES. The loading call builds the pipeline of the program each bundle's draw picks AT THE VIEWPORT IT IS WARMED AT; the other engine candidates of the bundle
  /// (variantEnginesFor: Slug / AAC / band-hard / mixed) are only LINKED (prewarmFillVariant), so the first draw that picks one -- the scale crossed an aac-classic breakpoint, a recolor state
  /// the pick changes with -- builds a pipeline in play. Under `standIns:false` there is no stand-in to cover that build, so the loading window builds them: for every live bundle and every
  /// draw state of the warm, each candidate key that is linked and not yet built is drawn once under a forced key (one-pixel scissor, like every warm draw). On by default only with
  /// `standIns:false`; `warmEngineCandidates: true|false` overrides. Its cost is load-window time (counted: debugStats.needMiss.engineCandidateBuilds / engineCandidateMs).
  const candidatePassOn = () => R.opts.warmEngineCandidates === true; // (opt-in: it over-builds; the bind-set pass below is the default under standIns:false)
  function* engineCandidatePass(ws) {
    if (!candidatePassOn() || R.opts.psoWarm === false || R._contextLost) return 0;
    let n = 0;
    const t0 = _nowMs();
    const todo = []; // [bundle, key]
    for (const bb of R._liveBundles()) {
      if (!bb || bb._disposed) continue;
      const sw = R.draw.worldM,
        sc = R.draw.colorMatrix,
        so = R.draw.colorMatrixOffset;
      let cands = [];
      try {
        if (ws && ws.world) R.draw.worldM = ws.world;
        if (ws && ws.cm) {
          R.draw.colorMatrix = ws.cm;
          R.draw.colorMatrixOffset = ws.off;
        }
        cands = candidateDefinesFor(bb);
      } catch {
        cands = [];
      } finally {
        R.draw.worldM = sw;
        R.draw.colorMatrix = sc;
        R.draw.colorMatrixOffset = so;
      }
      for (const defs of cands) {
        const key = definesKey(defs);
        let v = variantCache.get(key);
        if (v && (v.psoReady || v.universal)) continue;
        if (!v) {
          try {
            v = compileVariant(defs, 'fill:cand:', bb);
            v.speculative = false;
          } catch {
            continue;
          }
        } // (the cover set links only the maximal programs; a candidate is linked here)
        todo.push([bb, key]);
      }
    }
    if (!todo.length) return 0;
    // links finish before any pipeline is drawn (a cooperative pause lets the driver compile; the blocking call forces them)
    if (R._coop) {
      while (promoteReady() > 0) yield* pause('link');
    } else for (const [key, v] of variantCache) if (v.pending && !v.speculative) promote(key, v);
    for (const [bb, key] of todo) {
      const v = variantCache.get(key);
      if (!v || v.pending || v.psoReady || bb._disposed) continue;
      const savedState = R._warmState,
        savedForce = R._warmForceKey;
      R._warmState = ws || null;
      R._warmForceKey = key;
      try {
        if (_warmBundlePso(bb, false, false)) n++;
      } catch {
        /* a failed candidate warm is only a build in play later */
      } finally {
        R._warmState = savedState;
        R._warmForceKey = savedForce;
      }
      if (R._coop) yield* maybeSlice();
    }
    R._engineCandidateBuilds = (R._engineCandidateBuilds | 0) + n;
    R._engineCandidateMs = (R._engineCandidateMs || 0) + (_nowMs() - t0);
    return n;
  }
  /// THE BIND-SET PASS (single source of truth). The program a draw binds is whatever selectFillVariant answers for the bundle in the draw state at that moment; this pass ASKS
  /// selectFillVariant (in probe mode, so nothing waits) for every live bundle under every draw state the warm covers (as drawn, the rotated/recolor states, or the states a recorded
  /// manifest names), reads the key it wants (R._lastWantKey), links it if it does not exist and draws it once under a forced key until its pipeline is built. It runs at the
  /// END of the loading round, after the meshes and routes have settled, so a route that flipped while the loading call ran (a unified LB variant that only exists once its meshes
  /// arrived) is asked on its FINAL state: the key built equals the key bound by construction, not by a parallel approximation. It repeats until a round finds nothing unbuilt
  /// (a build can change a route) or makes no progress. On by default under `standIns:false` (`warmBindSet: true|false` overrides); counted in debugStats.needMiss.bindSet*.
  const bindPassOn = () =>
    R.opts.warmBindSet === true || (R.opts.warmBindSet !== false && R.opts.standIns === false);
  // (the same predicate the draw path uses to decide whether a program may draw without a build in play)
  // BUILT = a draw the gate saw with the program (the gate's own record; pipelineWarm is permissive outside strict play and during the loading window, so it cannot be the test here)
  const isBuilt = (v) =>
    !!v &&
    (v.universal ||
      (!v.pending &&
        !!v.psoReady &&
        (R._progDrawn
          ? !!R._progDrawn(v.prog)
          : !!(v.built && (v.built.cC || v.built.cT || v.built.uC || v.built.uT)))));
  const POINTS_ROUTE = '\u0000points-route';
  const pointsArgsOf = (key) => JSON.parse(key.slice(POINTS_ROUTE.length));
  const pointsProgOf = (key) =>
    R._pointsProgState
      ? R._pointsProgState(pointsArgsOf(key))
      : { started: true, ready: true, built: true };
  /// THE SCALE DOMAIN OF K. A draw's world matrix reaches every scale in (0, inf), and the size regions follow the viewport alone, so a gate whose outcome moves the key has to be asked past them. Each
  /// gate gives its bars, from its own data: unit px2 k2 for the ones that read the area scale (the Loop-Blinn pick's rows, lbPickBreaks over (0, inf), under each no-AA answer since that moves their
  /// floors), and device px per em for the ones that read the thinnest direction (the no-AA gates' stroke, the pattern minification gate's tile). A stretch moves the second independently of the first,
  /// below it: every direction bar under sqrt(k2) is reachable at k2. So: one uniform scale per k2 interval, and at each a stretch per direction interval below it. K then answers for itself at
  /// each, so a gate whose outcome moves no key adds no program. The engine picks (preferAac) are asked both ways by wantKeysOf. No bar, no probe; nothing here depends on a tolerance or a sampled scale.
  /// Returns [[k2, px | 0]]: the unit px2 to probe, and the thinnest direction's px per em when it is stretched below sqrt(k2).
  function scaleProbes(bb) {
    const lines = [];
    const noAaW = bb.noAaFill ? bb.minStrokeEmW : bb.noAaMixed ? bb.minStrokeEmWMixed : 0;
    if (noAaW > 0) lines.push(NOAA_MIN_STROKE_PX / noAaW);
    const pat = patternFineBar(bb);
    if (pat > 0) lines.push(pat);
    const cuts = new Set(lines.map((x) => x * x));
    const meshes = bb._lbMeshes;
    if (
      meshes &&
      !bb._morphSrc &&
      !bb._lbStream &&
      R._unifiedFillEligible &&
      R._unifiedFillEligible(bb)
    ) {
      for (const [ha, hm] of bb.noAaFill
        ? [
            [false, false],
            [true, false],
          ]
        : bb.noAaMixed
          ? [
              [false, false],
              [false, true],
            ]
          : [[false, false]]) {
        for (const x of lbPickBreaks(lbPickRows(R, bb, meshes, ha, hm), 0, Number.POSITIVE_INFINITY)
          .breaks)
          cuts.add(x.k2);
      }
    }
    if (!cuts.size) return [];
    const ks = [...cuts].sort((a, b) => a - b),
      reps = [ks[0] / 4];
    for (let i = 0; i + 1 < ks.length; i++) reps.push(Math.sqrt(ks[i] * ks[i + 1]));
    reps.push(ks[ks.length - 1] * 4);
    lines.sort((a, b) => a - b);
    const out = [];
    for (const k2 of reps) {
      out.push([k2, 0]);
      const top = Math.sqrt(k2);
      for (let i = 0; i < lines.length && lines[i] < top; i++)
        out.push([k2, i ? Math.sqrt(lines[i - 1] * lines[i]) : lines[0] / 4]);
    }
    return out;
  }
  /// The draw's map scaled to a probe's unit px2 (and stretched, for its thinnest direction), keeping what the key reads of it: an axis-aligned map stays exactly so, a rotated one rotated.
  function scaledMap(base, now, probe) {
    const k2 = probe[0],
      px = probe[1];
    const m = base ? Float32Array.from(base) : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const f = Math.sqrt(k2 / now),
      st = px > 0 ? Math.sqrt(k2) / px : 1;
    m[0] *= f * st;
    m[1] *= f * st;
    m[3] *= f / st;
    m[4] *= f / st;
    return m;
  }
  /// K under one draw state, READ, not drawn: nothing is bound, allocated, uploaded or drawn (the probe asks the selection with R._variantProbe set and the points route's
  /// decision alone, R._aacPointsDecide). A bundle the small-shape points route takes binds its point program, and draws on the cover route when the route declines at draw time
  /// (the GPU thread busy, the memory room), so its image is the point program AND the cover keys.
  function wantKeysOf(bb, ws) {
    const sw = R.draw.worldM,
      sc = R.draw.colorMatrix,
      so = R.draw.colorMatrixOffset,
      sp = R._variantProbe,
      scl = R.draw.channelLerp;
    const out = [];
    if (drawsNothing(bb)) return out;
    const savedWv = R._warmViewport;
    try {
      if (R._warmViewportOpt) R._warmViewport = R._warmViewportOpt; // the SIZE this pass warms for (the loading call's derived regions): K is a function of the drawn scale
      if (ws && ws.world) R.draw.worldM = ws.world;
      if (ws && ws.cm) {
        R.draw.colorMatrix = ws.cm;
        R.draw.colorMatrixOffset = ws.off;
      }
      if (ws && ws.cl) R.draw.channelLerp = ws.cl;
      R._variantProbe = true;
      if (!R._warmClassic && R._aacPointsDecide) {
        const a = R._aacPointsDecide(bb);
        if (a) out.push(POINTS_ROUTE + JSON.stringify(a));
      }
      const eligible = !!(R._unifiedFillEligible && R._unifiedFillEligible(bb));
      // A RE-FLOWABLE bundle (text: setText replaces its content in place) has the AAC gate's data of whatever string it holds next: both outcomes are reachable.
      // So has every bundle whose engine pick has a bar (coverKernelPolicy aacClassicBar, aacPresenceBreak) at some unit px2 in (0, inf): the pick reads the DRAWN
      // scale, viewport fit times |det| of the draw's world matrix (shapeScale.unitPx2), and drawBundle({ worldMatrix }) reaches every one of them -- a scene's
      // tiles pop in from scale 0 (unwarmed, the Slug side of a tile shape would first be built in play). The size regions follow the viewport only.
      const picks =
        bb.reflowable === true && R.opts.aacFill === 'auto' ? [true, false] : [undefined];
      const ask = (uni, pick) => {
        R._lastWantKey = null;
        R._probeAacPick = pick;
        selectFillVariant(bb, uni);
        if (R._lastWantKey != null && !out.includes(R._lastWantKey)) out.push(R._lastWantKey);
      };
      // the unified answer, and the classic (cover-wire) one: the unified draw can DECLINE at draw time (its meshes, a row census, a route flip) and the bundle then binds the cover program
      const askAll = () => {
        for (const pick of picks)
          for (const uni of eligible ? [true, false] : [false]) {
            R._probeAacFlips = false;
            ask(uni, pick);
            if (pick === undefined && R._probeAacFlips) {
              ask(uni, true);
              ask(uni, false);
            }
          }
      };
      askAll();
      // THE GATES WITH A BAR IN (0, inf) THAT PICK NO ENGINE: K under each scale they admit (scaleProbes). Bound by bindPassOn: a stand-in covers such a draw under any other policy.
      if (bindPassOn()) {
        const probes = scaleProbes(bb);
        if (probes.length) {
          // (K's own caches of the pick, put back: _lbPickKey is the stream's key, and a probe that moved it would rebuild the stream at the next draw)
          const pc = bb._lbPickCache,
            pk = bb._lbPickKey,
            rc = bb._uniRowClasses,
            ap = R._lbAutoPicked,
            base = R.draw.worldM,
            now = unitPx2(R, bb);
          try {
            if (now > 0)
              for (const p of probes) {
                R.draw.worldM = scaledMap(base, now, p);
                askAll();
              }
          } finally {
            R.draw.worldM = base;
            bb._lbPickCache = pc;
            bb._lbPickKey = pk;
            bb._uniRowClasses = rc;
            R._lbAutoPicked = ap;
          }
        }
      }
      return out;
    } catch {
      return out;
    } finally {
      R.draw.worldM = sw;
      R.draw.colorMatrix = sc;
      R.draw.colorMatrixOffset = so;
      R.draw.channelLerp = scl;
      R._variantProbe = sp;
      R._warmViewport = savedWv;
      R._probeAacPick = undefined;
      R._probeAacFlips = false;
    }
  }
  /// THE WARM IMAGE of one bundle: the image of K = selectFillVariant over the draw states the bundle can enter. The draw states are the finite product
  /// {as drawn} x {rotated map} x {recolor} x {both} (a recorded manifest's states replace the product: its exact states), each evaluated by K itself on the
  /// state at the END of the loading round. Returns [{ ws, key }] with duplicate keys removed: its length is the exact number of fill programs this bundle needs built.
  function warmImageOf(bb) {
    const recorded = R._wmStatesFor ? R._wmStatesFor(bb) : null;
    /** @type {any[]} */
    let states;
    if (recorded && recorded.length) states = recorded.map((sig) => warmStateOf(sig));
    else {
      const dom = R._declaredDomain ? R._declaredDomain(bb) : null; // the declared reach narrows the default domain
      states = [
        null,
        ...WARM_STATES.filter((w) => !dom || ((!w.world || dom.rotate) && (!w.cm || dom.recolor))),
      ];
      // a DECLARED channel-lerp recolor (an app's per-class tint of its sprites) is a draw state of its own: the declared reach only links its keys, so without
      // this their pipelines would first be built in play (a tinted sprite timeline's pair morph). As drawn and rotated, when declared.
      // (With `recolor` declared too the key is the color-matrix state's, pushRecolorOmits: these states add no program, and a key is listed once.)
      if (dom && dom.channelLerp) {
        states.push({ cl: WARM_CHANNEL_LERP });
        if (dom.rotate) states.push({ world: WARM_ROTATED_MAP, cl: WARM_CHANNEL_LERP });
      }
    }
    const out = [],
      seen = new Set();
    for (const ws of states) {
      for (const key of wantKeysOf(bb, ws)) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ws, key });
      }
    }
    return out;
  }
  R._warmImageOf = warmImageOf;
  /// Does this bundle need any fill program the loading call has not built? Its image is evaluated at the current size and at every size of ITS own derived regions (the same
  /// analytic breaks as the loading call, for this bundle alone) and compared with the set the passes built. Cheap when nothing is missing, so an app may ask per trial.
  R._bundleNeedsWarm = (bb) => {
    const t0 = _nowMs();
    try {
      return _bundleNeedsWarmImpl(bb);
    } finally {
      const d = _nowMs() - t0;
      R._needsWarmMs = (R._needsWarmMs || 0) + d;
      R._needsWarmCalls = (R._needsWarmCalls | 0) + 1;
      if (d > (R._needsWarmMax || 0)) R._needsWarmMax = d;
    }
  };
  // (The stand-in policy runs no bind-set pass, so its built set never holds an image's keys: "missing" stayed true for good, and every awaitBundleReady, each text re-flow
  //  and each trial, reran the whole loading call in play, ~19,000 warm draws a second in real games. A stand-in covers the draw there, so a missing key asks for one round.)
  const _standInAsked = new Set();
  // A key is in the warm set from the moment the pass lists it. Only a build answers "built": the pass may still be running, or may have stopped at its deadline with the key in the set. (Without
  // KHR_parallel_shader_compile the gate records no draws and cannot say; a key the pass tried and could not build is not asked again, or each ask would rerun the warm.)
  const imageKeyMissing = (key) => {
    if (key.charAt(0) === '\u0000') return !pointsProgOf(key).built;
    if (_linkFailed.has(key) && !variantCache.has(key)) return false; // (no window would build it: it is taken up by the next one the app opens)
    if (!R._warmSet.has(key)) return true;
    return !!R._khrParallel && !_bindUnbuildable.has(key) && !isBuilt(variantCache.get(key));
  };
  const _bundleNeedsWarmImpl = (bb) => {
    if (!bb || bb._disposed) return false;
    const cur = R.viewportSize();
    const dv = R._deriveSizeRegions(R._lastWarmOpt || cur, {
      ...(R._lastWarmOpts || {}),
      bundles: [bb],
    });
    const sizes = [null, ...dv.sizes];
    const saved = R._warmViewportOpt;
    let need = false;
    try {
      for (const sz of sizes) {
        R._warmViewportOpt = sz;
        for (const { key } of warmImageOf(bb)) {
          if (!imageKeyMissing(key)) continue;
          if (R.opts.standIns === false) return true;
          if (!_standInAsked.has(key)) {
            _standInAsked.add(key);
            need = true;
          }
        }
      }
    } finally {
      R._warmViewportOpt = saved;
    }
    return need;
  };
  /// THE SIZES THE LOADING CALL MAY SKIP. Each derived size warms the whole scene, but a size asks for a new program only through the bundles whose own region it
  /// represents (its owners: every other bundle is inside one of its own regions, and that region has its own size in the list). A size is COVERED when every key its
  /// owners ask for there (the warm image, and the candidate, instanced and point keys, under every warm state) was asked for at a size already warmed, and, when the
  /// bind-set pass runs, each image key ended built (a key that failed is asked again). Exact: key equality, at any scale. A scene can derive hundreds of sizes, many
  /// 1 px apart, and warming at each would hold its loading call to the deadline.
  function sizeKeys(bb, sz) {
    const sOpt = R._warmViewportOpt,
      sWv = R._warmViewport;
    try {
      R._warmViewportOpt = sz;
      R._warmViewport = sz;
      return { image: warmImageOf(bb).map((e) => e.key), sig: _sigOf(bb).split('\n') };
    } finally {
      R._warmViewportOpt = sOpt;
      R._warmViewport = sWv;
    }
  }
  const keyBuilt = (k) =>
    k.charAt(0) === '\u0000'
      ? !!pointsProgOf(k).built
      : isBuilt(variantCache.get(k)) || _linkFailed.has(k);
  R._sizeCoveredG = function* (sz, owners, asked) {
    for (const bb of owners) {
      if (!bb || bb._disposed) continue;
      const { image, sig } = sizeKeys(bb, sz);
      if (
        sig.some((k) => !asked.has(k)) ||
        image.some((k) => !asked.has(k) || (bindPassOn() && !keyBuilt(k)))
      )
        return 0;
      yield* maybeSlice();
    }
    return 1;
  };
  R._noteSizeAskedG = function* (sz, asked) {
    for (const bb of R._liveBundles()) {
      if (bb._disposed) continue;
      const { image, sig } = sizeKeys(bb, sz);
      for (const k of image) asked.add(k);
      for (const k of sig) asked.add(k);
      yield* maybeSlice();
    }
    return 0;
  };
  /// K for a bundle under an explicit draw state: the program key(s) the draw path binds (selectFillVariant, evaluated with the bundle bound). `patch` = { worldM, colorMatrix,
  /// colorMatrixOffset, alpha, overrides, palette, channelLerp }. The warm image is the image of this function; the closure test samples it.
  R._K = (bb, patch = {}) => {
    const d = R.draw,
      saved = {};
    const names = [
      'worldM',
      'colorMatrix',
      'colorMatrixOffset',
      'alpha',
      'overrides',
      'palette',
      'channelLerp',
    ];
    for (const k of names) saved[k] = d[k];
    try {
      Object.assign(d, patch);
      return wantKeysOf(bb, null);
    } finally {
      for (const k of names) d[k] = saved[k];
    }
  };
  /// The set of fill-variant keys the loading window built (K's image over the live bundles), consulted by the draw path's dev assertion and by the closure test.
  R._warmSet = new Set();
  /// The pass: build exactly the image, once. No per-key retry, no probing loop: (1) the keys are linked and their links awaited (cooperatively), (2) the pipeline-building draws are
  /// issued as ONE BATCH (the per-fence pacing gate `gpuClearW` is a pacing rule for warms interleaved with frames; inside the loading window the whole image is one batch, and
  /// the single wait is the one fence behind it), (3) the set is verified once against the gate's own record and a second round runs only if a build changed a route.
  const BIND_BATCH = 8;
  const _bindUnbuildable = new Set(); // keys a finished pass tried and left unbuilt (imageKeyMissing)
  function* bindSetPass() {
    if (!bindPassOn() || R.opts.psoWarm === false || R._contextLost) return 0;
    const t0 = _nowMs();
    let total = 0,
      unbuilt = 0,
      imageSize = 0;
    /** @type {any[]} */
    let left = [];
    for (let round = 0; round < 2; round++) {
      const todo = [];
      imageSize = 0;
      let tEnum = _nowMs(),
        nEnum = 0;
      for (const bb of R._liveBundles()) {
        if (!bb || bb._disposed) continue;
        nEnum++;
        for (const { ws, key } of warmImageOf(bb)) {
          if (key.charAt(0) === '\u0000') {
            // the points route's program: started here, linked below, built by the route's own draw in the batch under this state
            const pp = pointsProgOf(key);
            if (!pp.started && R._pointsStart) R._pointsStart(pointsArgsOf(key));
            if (!pp.built) todo.push([bb, ws, key]);
            continue;
          }
          imageSize++;
          R._warmSet.add(key);
          (R._bindSetKeys ||= []).length < 400 &&
            R._bindSetKeys.push((ws && ws.world ? 'R ' : '') + (ws && ws.cm ? 'C ' : '') + key);
          let v = variantCache.get(key);
          if (!v && _linkFailed.has(key)) continue;
          if (!v) {
            try {
              v = compileVariant(key ? key.split('|') : [], 'fill:bind:', bb);
            } catch {
              continue;
            }
          }
          v.speculative = false;
          if (!isBuilt(v)) todo.push([bb, ws, key]);
        }
        // the enumeration is cooperative like the batch below: one bundle's image is ~1 ms, the live list is hundreds of bundles (a single step walked
        // them all, 44-445 ms with no yield). Only the resumable drivers reach this pass (the loading call and the background warm: _refreshLive).
        if (R._coop) {
          const tp = _nowMs();
          yield* maybeSlice();
          tEnum += _nowMs() - tp;
        }
      }
      {
        const d = _nowMs() - tEnum;
        R._bindSetEnumMs = (R._bindSetEnumMs || 0) + d;
        R._bindSetEnumBundles = Math.max(R._bindSetEnumBundles | 0, nEnum);
        if (d > (R._bindSetEnumMax || 0)) R._bindSetEnumMax = d;
      }
      if (!todo.length) {
        unbuilt = 0;
        left = [];
        break;
      }
      // (1) links
      if (R._coop) {
        while (
          promoteReady() > 0 ||
          todo.some(([, , k]) => k.charAt(0) === '\u0000' && !pointsProgOf(k).ready)
        )
          yield* pause('link');
      } else for (const [key, v] of variantCache) if (v.pending && !v.speculative) promote(key, v);
      // content uploads of the last 120 ms must land before a batch of builds queues ahead of them
      if (R._coop && R._gateQuiet) while (!R._gateQuiet(120)) yield* pause('warm');
      // (2) batches of pipeline-building draws, each behind one fence. The compositor shares the GPU thread, so the loading screen presents nothing until a batch is done: one batch of a
      // whole image held it still for 20-39 s on real games. Eight draws is about 2.4 s of cold pipelines; a fence costs about a frame.
      let issued = 0,
        sinceFence = 0;
      const batchBreak = function* () {
        if (!R._coop || ++sinceFence < BIND_BATCH) return;
        sinceFence = 0;
        R._warmBatch = false;
        while (!R._gpuClear()) yield* pause('warm');
        R._warmBatch = true;
      };
      R._warmBatch = true;
      try {
        for (const [bb, ws, key] of todo) {
          if (key.charAt(0) === '\u0000') {
            if (bb._disposed || pointsProgOf(key).built) continue;
            const savedState = R._warmState;
            R._warmState = ws || null;
            R._warmPointsOnly = true;
            try {
              _warmBundlePso(bb, false, false);
              issued++;
            } catch {
              /* reported as unbuilt below */
            } finally {
              R._warmState = savedState;
              R._warmPointsOnly = false;
            }
            if (R._coop) {
              yield* maybeSlice();
              yield* batchBreak();
            }
            continue;
          }
          const v = variantCache.get(key);
          if (!v || v.pending || isBuilt(v) || bb._disposed) continue;
          const savedState = R._warmState,
            savedForce = R._warmForceKey;
          R._warmState = ws || null;
          R._warmForceKey = key;
          try {
            _warmBundlePso(bb, false, false);
            issued++;
          } catch {
            /* a failed warm draw is reported as unbuilt below */
          } finally {
            R._warmState = savedState;
            R._warmForceKey = savedForce;
          }
          if (R._coop) {
            yield* maybeSlice();
            yield* batchBreak();
          }
        }
      } finally {
        R._warmBatch = false;
      }
      // THE TARGET DIMENSION: a morph bundle's fill is drawn into a render target (the curve-lerp / cache pre-pass: an RGBA8 + depth/stencil attachment, another pipeline of the
      // same program). The pipeline-state part of the closure is the target kind a bundle can be drawn into; a morph always reaches the texture target, so its image is also
      // issued there (one scene's morph: 30 deferred draws and 7 pipelines first built after ready without it).
      if (warmTargets().length) {
        R._warmBatch = true;
        try {
          for (const bb of R._liveBundles()) {
            if (!bb || bb._disposed || !bb._morphSrc) continue;
            for (const { ws, key } of warmImageOf(bb)) {
              if (key.charAt(0) === '\u0000') continue;
              const v = variantCache.get(key);
              if (!v || v.pending) continue;
              const tg = warmTargets()[0];
              const savedState = R._warmState,
                savedForce = R._warmForceKey,
                savedT = R._warmTarget,
                savedTn = R._warmTargetName;
              R._warmState = ws || null;
              R._warmForceKey = key;
              R._warmTarget = tg.fbo;
              R._warmTargetName = tg.name;
              try {
                _warmBundlePso(bb, false, false);
                issued++;
              } catch {
                /* the draw builds it */
              } finally {
                R._warmState = savedState;
                R._warmForceKey = savedForce;
                R._warmTarget = savedT;
                R._warmTargetName = savedTn;
              }
              if (R._coop) {
                yield* maybeSlice();
                yield* batchBreak();
              }
            }
          }
        } finally {
          R._warmBatch = false;
        }
      }
      // helper programs of the bundles warmed above (mask bake twins, points programs) finish, then the ONE fence behind the batch
      if (R._coop) {
        const softAll = () =>
          (R._finishPointPrograms ? R._finishPointPrograms(true) : 0) +
          (R._finishMaskBakePrograms ? R._finishMaskBakePrograms(true) : 0) +
          (R._finishInstancedPrograms ? R._finishInstancedPrograms(true) : 0) +
          (R._finishFilterPrograms ? R._finishFilterPrograms(true) : 0) +
          (R._finishLbCovPrograms ? R._finishLbCovPrograms(true) : 0);
        // (a finisher's status read comes back behind every pipeline the batch queued: the page would freeze for the whole batch, tens of seconds on a large scene. The fence is first.)
        while (!R._gpuClear()) yield* pause('warm');
        while (softAll() > 0) yield* pause('finish');
        while (!R._gpuClear()) yield* pause('warm');
      }
      total += issued;
      left = todo.filter(([, , k]) =>
        k.charAt(0) === '\u0000' ? !pointsProgOf(k).built : !isBuilt(variantCache.get(k)),
      );
      unbuilt = left.length;
      // (debugStats.needMiss.bindSetUnbuiltKeys: which keys the pass could not build, in which state, and what the gate saw)
      R._bindSetUnbuiltKeys = left.slice(0, 40).map(([b, ws, k]) => {
        const v = k.charAt(0) === '\u0000' ? null : variantCache.get(k);
        const pp = k.charAt(0) === '\u0000' ? pointsProgOf(k) : null; // (a fill key with no entry failed to link in this pass: it is no points key)
        return {
          bundle: b.uid,
          state: ws ? (ws.world ? 'R' : '') + (ws.cm ? 'C' : '') : '',
          key: k.charAt(0) === '\u0000' ? 'points ' + k.slice(POINTS_ROUTE.length) : k,
          seen: v
            ? v.pending
              ? 'pending'
              : !v.psoReady
                ? 'no-pso'
                : 'not-drawn'
            : !pp
              ? 'link-failed'
              : pp.ready
                ? 'not-drawn'
                : pp.started
                  ? 'pending'
                  : 'not-started',
          cover: b._disposed
            ? 'disposed'
            : b.coverQuadVboFloats || b.coverQuadFloats
              ? 'yes'
              : 'none',
        };
      });
      if (!unbuilt) break;
    }
    for (const [b, , k] of left) if (!b._disposed) _bindUnbuildable.add(k);
    R._bindSetBuilds = (R._bindSetBuilds | 0) + total;
    R._bindSetUnbuilt = unbuilt;
    R._bindSetImage = imageSize;
    R._bindSetMs = /** @type {number} */ (R._bindSetMs || 0) + (_nowMs() - t0);
    return total;
  }
  function* precompileRound(opts, extraTarget = false) {
    if (R.opts.psoWarm === false || R._contextLost) return 0;
    const draws = !(opts && opts.draw === false);
    let n = yield* precompilePass(opts);
    if (draws && !R._warmQuick && R._refreshLive) n += yield* engineCandidatePass(null);
    if (draws && !R._warmQuick && R._refreshLive) n += yield* warmCover();
    if (draws && !R._warmQuick && R._refreshLive && !extraTarget) n += yield* warmAuxPipelines();
    if (
      draws &&
      !R._warmQuick &&
      (R._refreshLive ||
        (opts && opts.futureStates === true) ||
        R.opts.warmFutureStates === true) &&
      R.opts.warmFutureStates !== false
    ) {
      const budget = R.opts.precompileFillsBudgetMs;
      if (budget == null && !R._coop) R.opts.precompileFillsBudgetMs = Infinity; // an explicit budget (even 0) is the app's (cooperative: the time slice bounds each step)
      try {
        const enqueue = () => {
          const queued = new Set(_psoWarmQueue.slice(_psoWarmHead));
          for (const b of R._liveBundles()) if (!queued.has(b)) _psoWarmQueue.push(b);
        };
        // A manifest names the fill variants the recorded session bound, each with the first draw that bound it: link them (already started
        // at creation, in parallel), then build each one's pipeline with that draw, forced to that exact variant.
        const manifestWarm = !!(R._wmVariantList && R._wmVariantList().length);
        if (manifestWarm) R._wmExact = true;
        if (manifestWarm) {
          const byKey = new Map();
          for (const bb of R._liveBundles()) {
            const kk = R._wmKeyOf(bb);
            if (kk && !byKey.has(kk)) byKey.set(kk, bb);
          }
          if (R._coop) {
            while (promoteReady() > 0) yield* pause('link');
          } else
            for (const [key, v] of variantCache)
              if (v.pending && R._wmVariantList().some((e) => e.k === key)) promote(key, v);
          for (const e of R._wmVariantList()) {
            const bb = e.b && byKey.get(e.b),
              v = variantCache.get(e.k);
            if (!bb || !v || v.pending || v.psoReady) continue;
            const wantsUni = e.k.includes('MANTLE_LB_FILL');
            if (wantsUni !== !!(R._unifiedFillEligible && R._unifiedFillEligible(bb))) continue; // the draw's route is not the recorded one yet
            R._warmState = warmStateOf({ w: [...e.w], cm: e.cm, i: 0, ov: 0, k: e.k });
            try {
              if (_warmBundlePso(bb, false, false)) v.psoReady = true;
            } finally {
              R._warmState = null;
            }
            if (R._coop) yield* maybeSlice();
          }
        }
        // The states to build, per bundle: the ones a manifest recorded for it, else every state it could be drawn in.
        const tasks = new Map(); // state -> [bundle]
        const add = (ws, bb) => {
          let l = tasks.get(ws);
          if (!l) tasks.set(ws, (l = []));
          l.push(bb);
        };
        for (const bb of R._liveBundles()) {
          const recorded = R._wmStatesFor ? R._wmStatesFor(bb) : null;
          let exhaustive = !recorded;
          if (recorded)
            for (const sig of recorded) {
              const st = warmStateOf(sig);
              st.inst = sig.i === 1 ? undefined : false;
              add(st, bb);
              if (sig.ov === 1 && !sig.w.some((x, i) => (i === 1 || i === 2 ? x !== 0 : false)))
                add({ world: WARM_ROTATED_MAP, inst: st.inst, cm: st.cm, off: st.off }, bb); // an override table that turns a row: the rotated footprint too
              else if (sig.ov === 2) exhaustive = true; // a stroke-raising table: the stroke walk, which only the exhaustive states reach
            }
          if (exhaustive) for (const ws of WARM_STATES) add(ws, bb);
        }
        let last = null;
        const instWarmed = new Set();
        const instKeyed = !!(R._khrParallel && R.opts.variantFirst !== false && R._instWantDefsFor);
        for (let pass = 0; pass < 4; pass++) {
          for (const [ws, bundles] of tasks) {
            R._warmState = ws;
            const queued = new Set(_psoWarmQueue.slice(_psoWarmHead));
            for (const bb of bundles) if (!queued.has(bb)) _psoWarmQueue.push(bb);
            // (the stand-in-free policy builds the fill programs of these states from the exact image, bindSetPass: K over the same states; this older pass would link the candidate
            // keys of the states beside them, programs no draw asks for. The instanced programs below are not fill variants and stay.)
            if (R.opts.standIns !== false) {
              n += yield* precompilePass(opts);
              n += yield* engineCandidatePass(ws);
            }
            for (const bb of bundles) {
              // ONE DRAW PER INSTANCED PROGRAM AND TARGET. A bundle that cannot be drawn instanced has no instanced program: its warm drew the whole bundle
              // three times, filters and mask bakes included, and built nothing the fill warm had not. A bundle whose program another bundle already drew
              // in this call builds nothing new either.
              if (instKeyed && !(ws && ws.inst === false)) {
                const defs = R._instWantDefsFor(bb, !!(ws && ws.world));
                if (!defs) continue;
                const instKey = defs.slice().sort().join('|') + '@' + (R._warmTargetName || 'canvas');
                if (instWarmed.has(instKey)) continue;
                if (bb.curveTex && !bb._disposed) instWarmed.add(instKey);
              }
              // (one instanced program's pipeline build in flight at a time, like every other warm)
              while (R._coop && R._khrParallel && !R._gpuClear()) yield* pause('warm');
              warmInstanced(bb);
              if (R._coop) yield* maybeSlice();
            }
          }
          R._warmState = null;
          const sig = JSON.stringify(R._warmSignature());
          if (sig === last) break;
          last = sig;
        }
      } finally {
        R._warmState = null;
        R._wmExact = false;
        if (!R._coop) R.opts.precompileFillsBudgetMs = budget;
      }
    }
    return n;
  }
  /// The scratch render targets strictPlay warms the fill programs on besides the canvas: a program's pipeline is built per ATTACHMENT FORMAT, and a fill
  /// drawn into a group, a cache or a filter source renders into an RGBA8 target with a depth/stencil renderbuffer, not the canvas.
  let _warmTargets = null;
  function warmTargets() {
    if (_warmTargets) return _warmTargets;
    _warmTargets = [];
    try {
      const tex = trackGlResource(gl, gl.createTexture()),
        fbo = trackGlResource(gl, gl.createFramebuffer()),
        rb = trackGlResource(gl, gl.createRenderbuffer());
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, 4, 4);
      const saved = R._boundDrawFbo || null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved);
      _warmTargets.push({ fbo, tex, rb, name: 'rgba8+d24s8' });
    } catch {
      _warmTargets = [];
    }
    return _warmTargets;
  }
  function* precompileFillsG(opts) {
    if (R.opts.psoWarm === false || R._contextLost) return 0;
    const draws = !(opts && opts.draw === false);
    let n = yield* precompileRound(opts);
    if (draws && !R._warmQuick && R._refreshLive) n += yield* bindSetPass();
    if (draws && !R._warmQuick && !R._noSync) gpuSync();
    return n;
  }
  /// The blocking loading call: the generator run to its end with the gate off (links are waited for).
  function precompileFills(opts) {
    const was = R._forceLinks;
    R._forceLinks = true;
    const keepH = R._handle,
      keepB = keepH && keepH.bundle;
    try {
      const g = precompileFillsG(opts);
      let r = g.next();
      while (!r.done) r = g.next();
      return r.value;
    } finally {
      R._forceLinks = was;
      restoreBindingOf(keepH, keepB);
    }
  }
  R.precompileFills = precompileFills;
  /// The loading work with no waiting, for a caller that is not the cooperative loading call (a draw, awaitLbReady, awaitEngine, warmScene):
  /// the same generator, stepped until its first pause and then dropped. Whatever was ready is done, whatever is not stays queued.
  R._precompileSoft = (opts) => {
    const g = precompileFillsG(opts);
    try {
      const r = R._coopStep(g, {}, 3);
      return r.done ? r.value : 0;
    } finally {
      try {
        g.return(0);
      } catch {
        /* finished */
      }
    }
  };
  /// The loading work a DRAW, awaitLbReady, awaitEngine or warmScene does on the way: waits for links as it always did, unless the renderer is non-blocking.
  R._precompileNow = (opts) => (nb() ? R._precompileSoft(opts) : R.precompileFills(opts));
  /// One resumption of a cooperative loading generator (renderer.precompileFillsAsync): the flags are the caller's, on for this step only.
  R._coopStep = (gen, flags, sliceMs) => {
    const saved = {
      coop: R._coop,
      forceLinks: R._forceLinks,
      refreshLive: R._refreshLive,
      noSync: R._noSync,
      warmQuick: R._warmQuick,
      t0: R._sliceT0,
      ms: R._sliceMs,
    };
    R._coop = true;
    R._forceLinks = false;
    R._sliceT0 = _nowMs();
    R._sliceMs = sliceMs || 8;
    Object.assign(R, flags);
    const keepH = R._handle,
      keepB = keepH && keepH.bundle;
    try {
      return gen.next();
    } finally {
      restoreBindingOf(keepH, keepB);
      R._coop = saved.coop;
      R._forceLinks = saved.forceLinks;
      R._refreshLive = saved.refreshLive;
      R._noSync = saved.noSync;
      R._warmQuick = saved.warmQuick;
      R._sliceT0 = saved.t0;
      R._sliceMs = saved.ms;
    }
  };
  R._precompileFillsG = precompileFillsG;
  // ---- THE COVER SET ------------------------------------------------------------------------------------------------------------
  // Every distinct program costs the driver ~0.1-0.3 s of translator time on the GPU process whether or not anything ever draws it, and
  // translator time is serial. A scene's variants (every bundle x candidate engine x draw state) form an order by omission superset
  // (sceneUnion.isWarmSuperset): a program that leaves out less draws the same pixels as any program that leaves out more. The MAXIMAL elements
  // cover all of them. The loading call compiles those and builds their pipelines; every other key a draw asks for binds a built superset
  // (selectFillVariant, at the top of its creation path) instead of being compiled. Kernel presence costs GPU time, never pixels.
  function candidateDefinesFor(bundle) {
    const out = [];
    for (const eng of variantEnginesFor(bundle)) {
      const defines = variantDefinesFor(bundle, eng.aac, eng.noAa, eng.mixed);
      out.push(defines);
      if (defines.includes('MANTLE_NO_COVER_FILL'))
        out.push(defines.filter((d) => d !== 'MANTLE_NO_COVER_FILL'));
      // ...and the COVER-WIRE form of an unified candidate: where the unified route declines (a rotated map, a scale, a route flip) the same bundle draws as
      // cover quads with the lean omissions of its own features, and that program has no LB define at all.
      if (strictCfg() && defines.includes('MANTLE_LB_FILL'))
        out.push(
          defines.filter(
            (d) =>
              d !== 'MANTLE_NO_COVER_FILL' &&
              d !== 'MANTLE_COVER_PAINT_ONLY' &&
              !d.startsWith('MANTLE_LB_'),
          ),
        );
    }
    return out;
  }
  // (the lighter feature blocks: a union that carries the recolor, gradient or clip code for members that never use it runs measurably slower than their lean programs)
  const UNION_LIGHT_BLOCKS = new Set([
    'MANTLE_NO_GRADIENT',
    'MANTLE_NO_CLIP',
    'MANTLE_NO_RECOLOR',
    'MANTLE_NO_CHANNEL_LERP',
    'MANTLE_NO_PALETTE',
    'MANTLE_NO_COLOR_MATRIX',
  ]);
  // (a union that carries the recolor block for draws that never recolor runs slower than their lean program: identity-state and tint-state members stay apart)
  const UNION_RECOLOR = new Set([
    'MANTLE_NO_RECOLOR',
    'MANTLE_NO_CHANNEL_LERP',
    'MANTLE_NO_PALETTE',
    'MANTLE_NO_COLOR_MATRIX',
  ]);
  function planCover() {
    const items = new Map(),
      wide = new Map();
    // THE SIZE CLASSES: which engine and route a draw takes follows its drawn scale (the analytic stream only above a size, the points route only
    // below one), and the canvas can be any size while the app plays (a drag, a fullscreen toggle, another display). A strictPlay plan enumerates the
    // candidates at the current size and at a small and a large one, so a size change meets a built union, not a missing program.
    const sizes =
      strictCfg() && !R._classList
        ? [R._warmViewport || null, [1024, 640], [3840, 2160]]
        : [R._warmViewport || null]; // (the loading call's class list covers the sizes the display reaches)
    const savedWV = R._warmViewport;
    try {
      for (const wv of sizes) {
        if (wv && strictCfg()) R._warmViewport = wv;
        for (const b of R._liveBundles()) {
          if (b._disposed) continue;
          for (const ws of [null, ...WARM_STATES]) {
            const sw = R.draw.worldM,
              sc = R.draw.colorMatrix,
              so = R.draw.colorMatrixOffset;
            if (ws && ws.world) R.draw.worldM = ws.world;
            if (ws && ws.cm) {
              R.draw.colorMatrix = ws.cm;
              R.draw.colorMatrixOffset = ws.off;
            }
            const savedClP = R.draw.channelLerp;
            if (ws && ws.cl) R.draw.channelLerp = ws.cl;
            try {
              for (const d of candidateDefinesFor(b)) {
                const k = definesKey(d);
                if (!wide.has(k)) wide.set(k, { key: k, defs: d, bundle: b, ws });
                if (!wv || wv === sizes[0])
                  if (!items.has(k)) items.set(k, { key: k, defs: d, bundle: b, ws });
              }
            } catch {
              /* a bundle that cannot be planned is warmed by its own draws */
            } finally {
              R.draw.worldM = sw;
              R.draw.colorMatrix = sc;
              R.draw.colorMatrixOffset = so;
              R.draw.channelLerp = savedClP;
            }
          }
        }
      }
    } finally {
      R._warmViewport = savedWV;
    }
    const keys = [...items.keys()];
    const maximal = keys.filter((k) => !keys.some((k2) => k2 !== k && isWarmSuperset(k2, k)));
    return { items, wide, maximal, total: keys.length };
  }
  function* warmCover() {
    if (
      (R.opts.coverSet !== true && !strictCfg()) ||
      R.opts.disableFillVariants ||
      R.opts.psoWarm === false
    )
      return 0;
    const { items, wide, maximal, total } = planCover();
    // the instanced and point programs are planned the same way: the maximal ones only
    const inst = new Map(),
      pts = new Map();
    for (const b of R._liveBundles()) {
      if (b._disposed) continue;
      for (const rot of [false, true]) {
        const defs = R._instWantDefsFor && R._instWantDefsFor(b, rot);
        if (defs) inst.set(defs.slice().sort().join('|'), defs);
        // both OUTCOMES of the classic AAC gate (coverKernelPolicy.aacClassicBar), for a bundle whose bar lies inside the display's reachable range: the instanced engine
        // pick is AAC above the bar and Slug below it, so both instanced programs are warmed -- no viewport is derived for it (the derivation lists the bar, `aac-classic`).
        // (The viewport range is the whole domain here: the fast path binds one program for all its instances with the draw's world matrix cleared by setBundle, so the pick reads the fit alone.)
        if (defs && R._instBothEngines && R._instBothEngines.has(b)) {
          const other = defs.includes('MANTLE_AAC')
            ? defs.filter((d) => d !== 'MANTLE_AAC')
            : defs.concat('MANTLE_AAC');
          inst.set(other.slice().sort().join('|'), other);
        }
        const a = R._pointsWantArgs && R._pointsWantArgs(b, rot);
        if (a) pts.set(JSON.stringify(a), a);
      }
    }
    const ik = [...inst.keys()],
      pk = [...pts.keys()];
    for (const k of ik)
      if (!ik.some((k2) => k2 !== k && isWarmSuperset(k2, k))) R._instStart(inst.get(k));
    for (const k of pk) {
      const a = pts.get(k);
      if (
        !pk.some(
          (k2) =>
            k2 !== k && JSON.stringify(pts.get(k2)) !== k && R._pointsSuperset(pts.get(k2), a),
        )
      )
        R._pointsStart(a);
    }
    R._coverStats = {
      candidates: total,
      maximal: maximal.length,
      instCandidates: ik.length,
      pointCandidates: pk.length,
    };
    if (R.opts.coverSet === true) R._cover = { maximal: new Set(maximal) };
    const built = [];
    if (R.opts.coverSet === true || !strictCfg())
      for (const k of maximal) {
        const it = items.get(k);
        const v = compileVariant(it.defs, 'fill:cover:', it.bundle);
        built.push([v, it]);
      }
    // THE SCENE UNIONS (strictPlay): the loading call builds, per class of the scene's candidate draws (kernel, wire, footprint, heavy blocks present),
    // ONE program: the union of the presence defines and the intersection of the omissions of every member (sceneUnion.mergeSceneDefines). Every member
    // draws it at the speed of a lean program plus the class's own extras, so these are the PREDICTED programs and, because they are omission supersets of
    // every member, the stand-ins of any state or later bundle of the class. A union costs about one lean program of its class (seconds at most, cold), where a
    // program that leaves nothing out costs many seconds and runs more than twice as slow on a real scene.
    // (the stand-in-free policy builds no net: a net is the program a draw falls back to when its own is missing, and that policy never falls back -- it builds the key exactly or blocks)
    if (strictCfg() && R.opts.standIns !== false) {
      let count = 0;
      if (R.opts.strictFineUnions === true) {
        /** @type {Map<string, {defs: string[][], items: any[]}>} */
        const groups = new Map();
        for (const it of items.values()) {
          if (it.defs.some((d) => d.startsWith('MANTLE_CPATCH'))) continue;
          // (the curve types are part of the class: a union that carries the cubic kernel for line-only art runs it at 2.6x the lean program's cost;
          // an arriving bundle takes the leanest built union whose types include its own)
          const sig =
            classSig(it.defs) +
            '/' +
            heavySig(it.defs) +
            '/' +
            it.defs
              .filter(
                (d) =>
                  d === 'MANTLE_NO_LINE' ||
                  d === 'MANTLE_NO_QUAD' ||
                  d === 'MANTLE_NO_CUBIC' ||
                  d === 'MANTLE_NO_ARC' ||
                  UNION_RECOLOR.has(d),
              )
              .sort()
              .join(',');
          let g = groups.get(sig);
          if (!g) groups.set(sig, (g = { defs: [], items: [] }));
          g.defs.push(it.defs);
          g.items.push(it);
        }
        for (const g of groups.values()) {
          let ud = g.defs.length > 1 ? mergeSceneDefines(g.defs[0], g.defs.slice(1)) : g.defs[0];
          // A bundle that arrives after loading has the curve types of its own art: line, quad and cubic are what artwork is made of, so the union keeps those
          // three kernels whatever the loaded bundles hold (arcs, the rare one, stay omitted when no loaded bundle has them).
          if (R.opts.strictNetTypes === true)
            ud = ud.filter(
              (d) => d !== 'MANTLE_NO_LINE' && d !== 'MANTLE_NO_QUAD' && d !== 'MANTLE_NO_CUBIC',
            );
          const first = g.items[0];
          const v = compileVariant(ud, 'fill:union:', first.bundle);
          v.net = true;
          built.push([
            v,
            {
              defs: ud,
              bundle: first.bundle,
              bundles: [...new Set(g.items.map((i) => i.bundle))],
              ws: first.ws,
            },
          ]);
          count++;
        }
      }
      // THE COARSE NETS: per class and heavy-block set, ONE program over every member whatever its curve types and light blocks, with line, quad and cubic and
      // the recolor, gradient and clip blocks all present. Any bundle that arrives later whose heavy blocks (mask, stroke, pattern, image, filter) match a
      // loaded class has a built program to draw -- the guarantee that a draw never finds nothing -- while the fine unions above keep the speed of the
      // bundles that were there.
      if (R.opts.strictNetCoarse !== false) {
        /** @type {Map<string, {defs: string[][], items: any[]}>} */
        const coarse = new Map();
        // (one kernel: the AAC kernel stands in for Slug's wherever a bundle has both candidates, and the no-AA engines are never a stand-in)
        const aacBundles = new Set();
        for (const it of wide.values())
          if (it.defs.includes('MANTLE_AAC')) aacBundles.add(it.bundle);
        for (const it of wide.values()) {
          if (
            it.defs.some(
              (d) =>
                d.startsWith('MANTLE_CPATCH') || d.startsWith('MANTLE_HARD') || d === 'MANTLE_GWN',
            )
          )
            continue;
          if (
            R.opts.strictNetAac !== false &&
            aacBundles.has(it.bundle) &&
            !it.defs.includes('MANTLE_AAC')
          )
            continue;
          // (the rotated footprint is in every coarse net: a program that computes the map draws an axis-aligned draw correctly, so one net per class serves both)
          const dd = it.defs.includes('MANTLE_ROTATED_MAP')
            ? it
            : { ...it, defs: [...it.defs, 'MANTLE_ROTATED_MAP'] };
          const sig = classSig(dd.defs) + '/' + heavySig(dd.defs);
          let g = coarse.get(sig);
          if (!g) coarse.set(sig, (g = { defs: [], items: [] }));
          g.defs.push(dd.defs);
          g.items.push(dd);
        }
        for (const g of coarse.values()) {
          const base =
            g.defs.length > 1 ? mergeSceneDefines(g.defs[0], g.defs.slice(1)) : g.defs[0];
          const hasArc = g.defs.some((d) => !d.includes('MANTLE_NO_ARC'));
          // two flavors per class: line + quad (text and flat art: what a font glyph and a polygon are made of) and line + quad + cubic; arcs only where a loaded
          // bundle has them. The leanest built net that covers a draw is the one it uses.
          for (const cubic of R.opts.strictNetFlavors === 'both' ? [false, true] : [true]) {
            let ud = base.filter(
              (d) =>
                d !== 'MANTLE_NO_LINE' &&
                d !== 'MANTLE_NO_QUAD' &&
                d !== 'MANTLE_NO_CUBIC' &&
                d !== 'MANTLE_NO_ARC' &&
                !UNION_LIGHT_BLOCKS.has(d),
            );
            if (!cubic) ud.push('MANTLE_NO_CUBIC');
            if (!hasArc) ud.push('MANTLE_NO_ARC');
            const first = g.items[0],
              key = definesKey(ud);
            if (variantCache.has(key) && variantCache.get(key).net) continue;
            const v = compileVariant(ud, 'fill:net:', first.bundle);
            v.net = true;
            v.coarse = true;
            built.push([
              v,
              {
                defs: ud,
                bundle: first.bundle,
                bundles: [...new Set(g.items.map((i) => i.bundle))],
                ws: first.ws,
              },
            ]);
            count++;
          }
        }
      }
      // THE GENERIC LEANS: the cheap, common content that arrives after loading -- text (lines and quads), flat polygons (lines), plain curved art -- in its own lean
      // program per curve-type subset: a fill-only class (no mask, stroke, pattern, image or filter) without the recolor, gradient and clip blocks costs ~0.1-0.4 s
      // to build and runs at the speed of the lean program, where the coarse net that would otherwise draw it (every block present) runs a scene's 450 text bundles
      // at 41 ms a frame instead of 13. Built from each fill-only coarse class, whatever the loaded bundles are.
      let generics = 0;
      if (R.opts.strictGenerics === true) {
        const HEAVY = [
          'MANTLE_NO_MASK',
          'MANTLE_NO_STROKE',
          'MANTLE_NO_PATTERN',
          'MANTLE_NO_IMAGE',
          'MANTLE_NO_FILTER',
        ];
        /** @type {Array<[string, number]>} */
        const TYPES = [
          ['MANTLE_NO_LINE', 1],
          ['MANTLE_NO_QUAD', 2],
          ['MANTLE_NO_CUBIC', 4],
        ];
        for (const [v0, it0] of built.slice()) {
          if (!v0.coarse || !HEAVY.every((d) => v0.key.split('|').includes(d))) continue;
          const base0 = v0.key
            .split('|')
            .filter(
              (d) =>
                !d.startsWith('MANTLE_NO_LINE') &&
                d !== 'MANTLE_NO_QUAD' &&
                d !== 'MANTLE_NO_CUBIC' &&
                !UNION_LIGHT_BLOCKS.has(d),
            );
          // (both kernels: a want without the AAC define is matched by presence, and the coarse net carries AAC)
          for (const kernel of base0.includes('MANTLE_AAC') ? ['aac', 'slug'] : ['slug'])
            for (const rot of [false, true])
              for (const lerp of [false, true])
                for (const mask of [1, 3, 7]) {
                  if (generics >= 48) break; // (a cap: the cheap programs of a few classes, not a cross product)
                  let base = kernel === 'slug' ? base0.filter((d) => d !== 'MANTLE_AAC') : base0;
                  base = rot
                    ? base.includes('MANTLE_ROTATED_MAP')
                      ? base
                      : [...base, 'MANTLE_ROTATED_MAP']
                    : base.filter((d) => d !== 'MANTLE_ROTATED_MAP');
                  const ud = base.slice();
                  for (const [d, bit] of TYPES) if (!(mask & bit)) ud.push(d);
                  // (flavors: plain, and with the channel-lerp recolor block -- two-tone text and tinted glyphs declare it on the bundle)
                  for (const d of UNION_LIGHT_BLOCKS)
                    if (!(lerp && d === 'MANTLE_NO_CHANNEL_LERP')) ud.push(d);
                  const key = definesKey(ud);
                  if (variantCache.has(key)) continue;
                  const v = compileVariant(ud, 'fill:lean:', it0.bundle);
                  v.net = true;
                  built.push([
                    v,
                    { defs: ud, bundle: it0.bundle, bundles: it0.bundles, ws: it0.ws },
                  ]);
                  count++;
                  generics++;
                }
        }
      }
      R._netCount = count;
    }
    // (an entry whose link failed has left the cache and stays pending: waiting on it spent all 1500 turns, 30 s per warmed size, on a key that will never finish)
    if (R._coop) {
      for (
        let i = 0;
        i < 1500 && built.some(([v]) => v.pending && variantCache.get(v.key) === v);
        i++
      ) {
        promoteReady();
        yield* pause('link');
      }
    } else for (const [v] of built) if (v.pending) promote(v.key, v);
    let n = 0;
    for (const [v, it] of built) {
      if (v.pending || builtFor(v)) continue;
      const wantsUni = v.key.includes('MANTLE_LB_FILL');
      // (a union is warmed by a member whose route matches its wire: the unified stream for an LB program, cover quads for the other; it counts as
      // warm only if THAT program is what the warm draw bound -- a route that declined or flipped drew another one)
      let cands = v.net
        ? (it.bundles || [it.bundle]).filter(
            (b) => wantsUni === !!(R._unifiedFillEligible && R._unifiedFillEligible(b)),
          )
        : [it.bundle];
      // a cover-wire program of a bundle whose route is the unified stream (it draws as cover quads where that route declines): drawn as the classic pass
      const classic = v.net && !cands.length && !wantsUni;
      if (classic) cands = (it.bundles || [it.bundle]).slice(0, 2);
      if (!cands.length) continue;
      if (!v.net && wantsUni !== !!(R._unifiedFillEligible && R._unifiedFillEligible(it.bundle)))
        continue;
      for (const wb of cands.slice(0, 4)) {
        R._warmState = { ...(it.ws || {}), force: v.key };
        R._lastFillVariant = null;
        R._warmClassic = classic;
        // (a warm that finds the GPU thread still building the last program's pipeline says so: wait for its fence and ask again)
        try {
          let tries = 0,
            done = _warmBundlePso(wb, false, false);
          while (!done && R._coop && tries++ < 1200) {
            R._warmState = null;
            yield* pause('warm');
            R._warmState = { ...(it.ws || {}), force: v.key };
            done = _warmBundlePso(wb, false, false);
          }
          if (done && (!v.net || (v.built && v.built[builtKey(wantsUni, !!R._warmTarget)]))) {
            v.psoReady = true;
            n++;
            break;
          }
        } finally {
          R._warmState = null;
          R._warmClassic = false;
        }
      }
    }
    return n;
  }
  /// A manifest lists the fill variant keys the recorded session bound. Start every one of them linking now -- at renderer creation, in
  /// parallel, before any bundle exists -- so the driver's first compile of each kernel (seconds each on a cold cache: the AAC cover kernel, the
  /// Slug kernel, the unified-stream kernels) overlaps instead of running one after another as each draw first asks for its program.
  R._wmPrelink = () => {
    if (
      R.opts.fillTwins === false ||
      R.opts.disableFillVariants ||
      R.opts.psoWarm === false ||
      !R._wmVariantList
    )
      return;
    for (const { k: key } of R._wmVariantList()) {
      if (!key || variantCache.has(key)) continue;
      const v = startQuietVariant(key.split('|'));
      v.speculative = false; // a variant a draw asked for in the recorded session: the loading call links and warms it like any other
    }
  };
  /// Link and ready only the variant the bundle's draw selects right now (the one fillVariantHasLbFill last asked for), not every pending
  /// program: a streamed bundle has no Slug geometry to fall back to, so it has to wait -- for its own program alone.
  R._readyBundleVariant = (bundle) => {
    const v = variantCache.get(R._lastWantKey);
    if (v && v.pending) {
      if (!nb()) R._blockingLinkWaits = (R._blockingLinkWaits | 0) + 1; // (blocking mode: waits for the link)
      promote(R._lastWantKey, v); // non-blocking mode: gated, a program that is not ready is not asked and the bundle draws on a later frame
    }
    if (v && !v.pending) v.psoReady = true;
    return !!v;
  };
  // ---- WARM QUEUE EXECUTOR (warmQueue.js) --------------------------------------------------------------------------------------
  // The units of work a recorded manifest names, done WITHOUT the scene's bundles: start a fill variant linking (`link`), and build one of its
  // pipelines (`pipeline`): the program drawn once with the recorded vertex layout, target kind, instancing, blend and color mask on a synthetic
  // vertex array and dummy samplers, one scissored pixel. The caller (the queue) has established the window and that the GPU thread is clear.
  const _wqVaos = new Map(),
    _wqDummyTex = new Map();
  const SAMPLER_KINDS = {
    0x8b5e: ['2D', 'f'],
    0x8dc1: ['A', 'f'],
    0x8b5f: ['3D', 'f'],
    0x8dca: ['2D', 'i'],
    0x8dd2: ['2D', 'u'],
    0x8dcf: ['A', 'u'],
    0x8dce: ['A', 'i'],
  };
  function wqVao(lay) {
    const sig = JSON.stringify(lay);
    let e = _wqVaos.get(sig);
    if (e) return e;
    const vao = trackGlResource(gl, gl.createVertexArray()),
      buf = trackGlResource(gl, gl.createBuffer());
    R.glBindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(2048), gl.STATIC_DRAW);
    for (const a of lay) {
      gl.enableVertexAttribArray(a.i);
      if (a.int) gl.vertexAttribIPointer(a.i, a.s, a.t, a.st, a.o);
      else gl.vertexAttribPointer(a.i, a.s, a.t, !!a.n, a.st, a.o);
      if (a.d) gl.vertexAttribDivisor(a.i, a.d);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    R.glBindVertexArray(null);
    _wqVaos.set(sig, (e = { vao, buf }));
    return e;
  }
  function wqDummy(kind, ty) {
    const k = kind + ty;
    let t = _wqDummyTex.get(k);
    if (t) return t;
    t = trackGlResource(gl, gl.createTexture());
    const tgt = kind === 'A' ? gl.TEXTURE_2D_ARRAY : kind === '3D' ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    gl.bindTexture(tgt, t);
    const fmt =
      ty === 'u'
        ? [gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT]
        : ty === 'i'
          ? [gl.RGBA32I, gl.RGBA_INTEGER, gl.INT]
          : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    if (kind === 'A' || kind === '3D')
      gl.texImage3D(tgt, 0, fmt[0], 2, 2, 2, 0, fmt[1], fmt[2], null);
    else gl.texImage2D(tgt, 0, fmt[0], 2, 2, 0, fmt[1], fmt[2], null);
    gl.texParameteri(tgt, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(tgt, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(tgt, null);
    _wqDummyTex.set(k, { tex: t, tgt });
    return _wqDummyTex.get(k);
  }
  const _wqReleased = new Set(); // (warmQueueRelease: keys whose program was built and deleted; they count as done)
  R._wq = {
    has: (key) => variantCache.has(key) || _wqReleased.has(key),
    /// Delete a built variant's program once the warm queue needs it no more (warmQueueRelease). True when it was released. `dropped`: its scene was canceled, so it may still be linking and
    /// its pipeline may never have been built: it is only forgotten, and a later scene that needs the key starts it again.
    release(key, dropped = false) {
      const v = variantCache.get(key);
      if (
        !v ||
        (v.pending && !dropped) ||
        v.universal ||
        (R._baseFillMade && v.prog === R.fillProg)
      )
        return false; // (a bare read of R.fillProg would link the universal program)
      deleteProgramWhenLinked(gl, v.prog);
      variantCache.delete(key);
      if (!dropped) _wqReleased.add(key);
      return true;
    },
    /// Start the variant linking (idempotent). False when the renderer cannot make variants (fill twins off, variants disabled, no warm).
    link(key) {
      if (_wqReleased.has(key)) return true;
      if (R.opts.fillTwins === false || R.opts.disableFillVariants || R.opts.psoWarm === false)
        return false;
      const v = variantCache.get(key) || startQuietVariant(key ? key.split('|') : []);
      v.speculative = false;
      return true;
    },
    /// 'ready' (linked and promoted), 'linking', or 'failed' (the variant left the cache: its link failed, or it was never started).
    linked(key) {
      if (_wqReleased.has(key)) return 'ready';
      const v = variantCache.get(key);
      if (!v) return 'failed';
      if (!v.pending) return 'ready';
      promote(key, v);
      const w = variantCache.get(key);
      return !w ? 'failed' : w.pending ? 'linking' : 'ready';
    },
    built: (key) => {
      if (_wqReleased.has(key)) return true;
      const v = variantCache.get(key);
      return !!v && !v.pending && (!R._progDrawn || R._progDrawn(v.prog));
    },
    /// Build one recorded pipeline. 'built' | 'wait' (not ready: ask again) | 'skip' (cannot be done here).
    pipeline(item, canvasOk) {
      const v = variantCache.get(item.k);
      if (!v) return 'skip';
      if (v.pending) return 'wait';
      if (R._contextLost || fillPassActive || R._captureFrames) return 'wait';
      if (item.tex === false && !canvasOk) return 'wait';
      if (R._khrParallel && !R._gpuClear()) return 'wait';
      const tg = item.tex ? warmTargets()[0] : null;
      if (item.tex && !tg) return 'skip';
      const [cw, ch] = viewportSize();
      if (!item.tex && !(cw > 0 && ch > 0)) return 'wait';
      const snap = R.glPeek ? R.glPeek() : null,
        savedFbo = R._boundDrawFbo || null;
      const prog = v.prog,
        restore = [];
      try {
        R._warmScissor = WARM_PIXEL;
        R.bindFb(gl.FRAMEBUFFER, tg ? tg.fbo : null);
        R._applyTargetScissor(tg ? tg.fbo : null);
        R.glDisable(gl.DEPTH_TEST);
        R.glDisable(gl.STENCIL_TEST);
        R.glUseProgram(prog);
        // Samplers: every one gets its own unit and a complete dummy texture of its type; the program's own sampler uniforms are put back after.
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        let unit = 0;
        for (let i = 0; i < n; i++) {
          const u = gl.getActiveUniform(prog, i),
            sk = u && SAMPLER_KINDS[u.type];
          if (!sk) continue;
          const loc = gl.getUniformLocation(prog, u.name.replace(/\[0\]$/, ''));
          if (!loc) continue;
          const d = wqDummy(sk[0], sk[1]);
          restore.push([loc, gl.getUniform(prog, loc), unit, d.tgt]);
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(d.tgt, d.tex);
          gl.uniform1i(loc, unit);
          unit++;
        }
        if (item.blend) {
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(item.blend[0], item.blend[1], item.blend[2], item.blend[3]);
          gl.blendEquationSeparate(item.blend[4], item.blend[5]);
        } else gl.disable(gl.BLEND);
        const cm = item.cmask == null ? 15 : item.cmask;
        gl.colorMask(!!(cm & 1), !!(cm & 2), !!(cm & 4), !!(cm & 8));
        if (tg) R.glViewport(0, 0, 4, 4);
        else R.glViewport(0, 0, cw, ch);
        gl.enable(gl.SCISSOR_TEST);
        const e = wqVao(item.lay);
        R.glBindVertexArray(e.vao);
        if (item.inst) gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 1);
        else gl.drawArrays(gl.TRIANGLES, 0, 3);
        R.glBindVertexArray(null);
      } catch (err) {
        R._wqLastError = String((err && err.stack) || err).slice(0, 400);
        if (mantleDebugHook('__WQ_DEBUG')) console.error(R._wqLastError);
        return 'skip';
      } finally {
        for (const [loc, prev, unit, tgt] of restore) {
          try {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(tgt, null);
            if (prev != null) gl.uniform1i(loc, prev);
          } catch {
            /* best effort */
          }
        }
        try {
          gl.activeTexture(gl.TEXTURE0);
          gl.colorMask(true, true, true, true);
          gl.disable(gl.BLEND);
        } catch {
          /* best effort */
        }
        R._warmScissor = null;
        if (R.glForgetState) R.glForgetState();
        if (R._forgetFillUnits) R._forgetFillUnits();
        R.bindFb(gl.FRAMEBUFFER, savedFbo);
        R._applyTargetScissor(savedFbo);
        if (snap && R.glRestore) R.glRestore(snap);
        R._lastFillPassHandle = null;
        R.fillPassCanvasW = 0;
        R.fillPassCanvasH = 0;
      }
      v.psoReady = true;
      markBuilt(v, false);
      return 'built';
    },
    /// The variant key a program belongs to (for a manifest recording), or null for a program that is not a fill variant.
    keyOfProgram(prog) {
      for (const [k, e] of variantCache)
        if ((!e.universal || R._baseFillMade) && e.prog === prog) return k;
      return null;
    },
    /// One bundle's pipeline warm in one draw state (the bundle-driven fallback): 'built' | 'wait'.
    bundle(bundle, state, canvasOk, vp) {
      if (!bundle || bundle._disposed) return 'built';
      prewarmFillVariant(bundle);
      promoteReady();
      const saved = R._warmState,
        savedTarget = R._warmTarget,
        savedVp = R._warmViewport;
      R._warmState = state || null;
      if (!canvasOk) {
        const tg = warmTargets()[0];
        if (!tg) return 'wait';
        R._warmTarget = tg.fbo;
      }
      if (vp) R._warmViewport = vp;
      const keepH = R._handle,
        keepB = keepH && keepH.bundle;
      try {
        return _warmBundlePso(bundle, false, false) ? 'built' : 'wait';
      } finally {
        R._warmState = saved;
        R._warmTarget = savedTarget;
        R._warmViewport = savedVp;
        restoreBindingOf(keepH, keepB);
      }
    },
    /// Every state a bundle could be drawn in that loading cannot see: as drawn, a rotated map, a recolor, both.
    exhaustiveStates: () => [null, ...WARM_STATES],
    /// How a draw of `key` would be served right now: 'warmed' (its own pipeline is built), 'superset' (a built or linked omission superset stands in:
    /// the same pixels), 'linking' (its program exists and is not ready: the draw defers), or 'none' (no program yet: the draw starts it and defers).
    /// Never links or draws: the test and the miss report read it.
    coverage(key) {
      const v = variantCache.get(key);
      if (v && !v.pending && pipelineWarm(v)) return 'warmed';
      for (const [k, e] of variantCache) {
        if (
          k !== key &&
          !e.universal &&
          !e.pending &&
          pipelineWarm(e) &&
          pickWarmSuperset(key, [k]) !== null
        )
          return 'superset';
      }
      for (const [k, e] of variantCache) {
        if (k !== key && !e.universal && !e.pending && pickWarmSuperset(key, [k]) !== null)
          return 'superset';
      }
      return v ? 'linking' : 'none';
    },
    /// The key a draw of this bundle binds now (the asset-derived need), for the warm queue's per-bundle ordering.
    keyOfBundle(bundle) {
      try {
        return definesKey(R._variantDefinesNow(bundle));
      } catch {
        return null;
      }
    },
  };
  R._gpuSync = gpuSync;
  if (R._wmVariantList && R._wmVariantList().length) R._wmPrelink();

  /// What warming has produced so far, for renderer.warmScene's stability test: fill variants known, their pipelines built, programs
  /// still linking, and bundles queued for a pipeline build. Two equal readings around a full pass mean the pass built nothing.
  R._warmSignature = () => {
    let ready = 0,
      pending = 0;
    for (const v of variantCache.values()) {
      if (v.psoReady) ready++;
      if (v.pending && !v.speculative) pending++;
    }
    let demands = 0;
    for (const [key, d] of _psoDemand) {
      if (d.ready) {
        if (!d.ready()) demands++;
      } else {
        const v = variantCache.get(key);
        if (v && !v.psoReady && d.bundle && !d.bundle._disposed) demands++;
      }
    }
    return {
      variants: variantCache.size,
      ready,
      pending,
      demands,
      customWarms,
      baseWarms,
      queued: _psoWarmQueue.length - _psoWarmHead,
      programs: contextProgramsCreated(gl),
      generation: resourceGeneration(gl),
      coldKeys: [...variantCache.values()]
        .filter((v) => v.pending || !v.psoReady)
        .map((v) => v.key),
      demandKeys: [..._psoDemand.keys()],
    };
  };

  R.prewarmFillVariant = prewarmFillVariant;

  // Free every specialized fill variant (the default entry aliases R.fillProg,
  // which renderer.dispose() deletes itself). Without this, each bundle's
  // lean variant outlived the renderer.
  R._disposeFillVariants = () => {
    for (const v of variantCache.values()) {
      if (
        v &&
        (!v.universal || R._baseFillMade) &&
        v.prog &&
        v.prog !== (R._baseFillMade ? R.fillProg : null)
      )
        deleteProgramWhenLinked(R.gl, v.prog);
    }
    variantCache.clear();
    // ...and hand the prewarm queue back, so the context stops broadcasting new bundles at a
    // renderer that has no variant cache left to warm them into.
    removeFillPrewarmConsumer(_prewarmQ);
    _psoWarmQueue.length = 0;
    _psoWarmHead = 0;
    _psoDemand.clear();
    if (_auxProgQueue) _auxProgQueue.length = 0;
    _auxProgHead = 0;
    // ...and the warm's own scratch: a shared context outlives this renderer, and each one left these behind.
    for (const t of _warmTargets || []) {
      deleteGlResource(gl, 'Framebuffer', t.fbo);
      deleteGlResource(gl, 'Texture', t.tex);
      deleteGlResource(gl, 'Renderbuffer', t.rb);
    }
    _warmTargets = null;
    if (_auxRt) {
      deleteGlResource(gl, 'Framebuffer', _auxRt.fbo);
      deleteGlResource(gl, 'Texture', _auxRt.tex);
      _auxRt = null;
    }
    for (const t of _auxDummy.values()) deleteGlResource(gl, 'Texture', t);
    _auxDummy.clear();
    for (const e of _wqVaos.values()) {
      deleteGlResource(gl, 'VertexArray', e.vao);
      deleteGlResource(gl, 'Buffer', e.buf);
    }
    _wqVaos.clear();
    for (const e of _wqDummyTex.values()) deleteGlResource(gl, 'Texture', e.tex);
    _wqDummyTex.clear();
  };

  let fillPassActive = false;
  let lastVariantProg = null; // force a full re-bind when the bound variant changes

  function beginFillPass(requestedVariant = null) {
    if (fillPassActive) {
      // Fill pass already live — still rebind the cover VAO. Nested filter /
      // composite / LB paths often leave VAO=null (or coverVao) without
      // endFillPass; a later flushPending that skipped this bind would draw
      // against the default VAO → "Vertex buffer is not big enough".
      if (R._handle && R._handle.triVao) R.glBindVertexArray(R._handle.triVao);
      return;
    }
    R._fillDeclined = false;
    // Select this bundle's specialized fill program + its uniform table. The
    // pass body below reads the destructured locals, so it is variant-agnostic.
    let variant = requestedVariant || R._uniCpAreaVariant;
    if (!variant) {
      // The groups of one atlas run draw one bundle under one draw state, one after another: the variant the first of them chose is the
      // one every other would choose (R._atlasRunMemo lives from the run's first slot to its composite).
      const memo = R._atlasRunMemo,
        hb = R._handle.bundle,
        uni = R._uniScope === true;
      if (
        memo &&
        memo.variant &&
        memo.bundle === hb &&
        memo.uni === uni &&
        !R._uniCpAreaPass &&
        !R._psoWarming
      ) {
        variant = memo.variant;
        R._autoEngine = memo.engine;
      } else {
        variant = selectFillVariant(hb);
        if (memo && !R._uniCpAreaPass && !R._psoWarming) {
          memo.bundle = hb;
          memo.uni = uni;
          memo.variant = variant;
          memo.engine = R._autoEngine;
        }
      }
    }
    if (!variant) {
      // DEFERRED (noStandIn): no program that draws these pixels is ready and no draw waits for one. The pass is not begun; the cover/unified
      // draw functions see R._fillDeclined and issue nothing, and a warm reports that it did not warm.
      R._fillDeclined = true;
      R._lastFillVariant = null;
      return false;
    }
    // (only now: a selection that throws has begun no pass, and a pass left marked active binds nothing for every later unified draw and refuses every warm)
    fillPassActive = true;
    R._lastFillVariant = variant; // so _warmBundlePso can mark the warmed pipeline ready
    if (R._psoWarming && variant) (R._warmBound ||= new Set()).add(variant); // every program this warm bound (a unified draw binds one per span)
    R._fillVariantBinds = (R._fillVariantBinds | 0) + 1;
    R._lastDrawnFillVariantKey = (variant && variant.key) || null;

    const _hb = R._handle.bundle;
    R._lastDrawnCoverKernel = coverKernelOfVariantKey(
      R._lastDrawnFillVariantKey,
      !!_hb && _hb.numFillShapes === 0,
    );
    // Only the DATA uniforms are destructured. The sampler-unit assignments
    // (uCurveData…uExtClipTex) are program state written once by
    // bindProgramSamplers, so they have no place in the per-draw body.
    const {
      uGBB,
      uShapeIdxOverride,
      uFillNumShapes,
      uFillCanvasAR,
      uFillViewportSize,
      uFillFragOrigin,
      uFillGradCount,
      uFillImageAtlasSize,
      uFillSecondaryImageTex,
      uFillSecondaryImageAtlasSize,
      uFillHasOverrides,
      uFillHasEmCoord,
      uFillDrawAlpha,
      uFillColorMatrix,
      uFillColorMatrixOffset,
      uFillColorMatrixEnabled,
      uFillExtClipMode,
      uFillChLerpPrimary,
      uFillChLerpContrast,
      uFillChLerpHighlight,
      uFillChLerpEnabled,
      uFillStrokeGates,
      uFillCoverAaReach,
      uFillStrokeExactAa,
      uFillPaletteEnabled,
      uFillPaletteChannel,
      uFillPaletteSize,
      uFillWorldM,
      uFillHasWorldM,
      uFillHasOffscreenMask,
      uFillHasOccupancy,
      uFillCurveCoef,
    } = variant.u;
    const [cw, ch] = viewportSize();
    // The fill pass always projects the CANVAS. When the target framebuffer is a
    // rect of it — a filtered shape rendering into an RT covering only itself —
    // the same projection is simply TRANSLATED: a viewport at -rect.origin lands
    // canvas pixel (x,y) on RT texel (x-rx, y-ry). No clip-space math changes.
    // (This owns the viewport: a caller that set its own would have it clobbered
    // here, which is exactly what happened the first time.)
    const _fo = R._fragOrigin;
    R.glViewport(_fo ? -_fo[0] : 0, _fo ? -_fo[1] : 0, cw, ch);
    R.glEnable(gl.BLEND);
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (mantleDebugHook('__MANTLE_NO_DEPTH')) {
      R.glDisable(gl.DEPTH_TEST);
    } else {
      R.glEnable(gl.DEPTH_TEST);
      R.glDepthFunc(gl.LEQUAL);
      R.glDepthMask(!R._opaquePrepassActive);
    }
    R.glUseProgram(variant.prog);
    variant.drawn = true;
    if (R._wmVariant && !variant.universal && !R._psoWarming) R._wmVariant(variant.key); // (a warm draw binds variants play may never ask for)
    bindProgramSamplers(variant);

    const splitEpoch = R._uniCpAreaPass ? R._cpAreaSplitEpoch || 0 : 0;
    const splitReuse = splitEpoch > 0 && variant.cpSplitBindEpoch === splitEpoch;
    if (R._lastFillPassHandle !== R._handle || (!splitReuse && lastVariantProg !== variant.prog)) {
      R._handle.fillPassAssetDirty = true;
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
    }
    lastVariantProg = variant.prog;
    // External writes can invalidate bindings while a resident handle stays active.
    syncUnitEpoch();
    const asset = R._handle.bundle;
    if (
      !R._handle.fillPassAssetDirty &&
      (unitState.u[0] !== asset.curveTex ||
        unitState.u[1] !== asset.bandTex ||
        unitState.u[2] !== asset.metaTex ||
        unitState.u[3] !== (asset.dashTex || dummyDashTex) ||
        unitState.u[4] !== (asset.gradientTex || dummyGradientTex) ||
        unitState.u[5] !== (asset.gradientStopsTex || dummyGradientStops) ||
        unitState.u[6] !== (asset.imageAtlasTex || dummyGradientStops) ||
        unitState.u[7] !== (asset.filterTex || dummyGradientTex) ||
        (uFillSecondaryImageTex !== null &&
          unitState.u[15] !== (asset.secondaryImageAtlasTex || dummyGradientStops)))
    ) {
      R._handle.fillPassAssetDirty = true;
    }
    if (R._handle.fillPassAssetDirty) {
      const b = R._handle.bundle;
      // bindFillTex skips the driver bindTexture when the unit already holds that
      // texture (dummy dash/grad/image/filter are identical across consecutive
      // solid bundles). The unit ASSIGNMENTS came from bindProgramSamplers when
      // this variant was first used — only the bundle's own data belongs here.
      bindFillTex(0, b.curveTex);
      bindFillTex(1, b.bandTex);
      bindFillTex(2, b.metaTex);
      bindFillTex(3, b.dashTex || dummyDashTex);
      bindFillTex(4, b.gradientTex || dummyGradientTex);
      bindFillTex(5, b.gradientStopsTex || dummyGradientStops);
      u1i(variant, 'gradCount', uFillGradCount, b.gradientCount);
      bindFillTex(6, b.imageAtlasTex || dummyGradientStops);
      u2f(
        variant,
        'imageAtlasSize',
        uFillImageAtlasSize,
        b.imageAtlasSize[0] || 1,
        b.imageAtlasSize[1] || 1,
      );

      if (uFillSecondaryImageTex !== null) {
        bindFillTex(15, b.secondaryImageAtlasTex || dummyGradientStops);
        u2f(
          variant,
          'secondaryImageAtlasSize',
          uFillSecondaryImageAtlasSize,
          b.secondaryImageAtlasSize?.[0] || 1,
          b.secondaryImageAtlasSize?.[1] || 1,
        );
      }
      bindFillTex(7, b.filterTex || dummyGradientTex);
      u4f(variant, 'gbb', uGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      u1f(variant, 'numShapes', uFillNumShapes, Math.max(1, b.numShapes));
      u1i(variant, 'shapeIdxOverride', uShapeIdxOverride, -1);
      // Multi-shape mask offscreen RT. When the bundle has regions and
      // the bake program is bundled, R._maskRTArray was filled by
      // R.bakeMaskRegions() at the top of render(); bind it on TEXTURE9
      // and the row-to-layer lookup on TEXTURE10. Otherwise bind dummy
      // 1×1×1 R8 array + 1×1 R32I textures (WebGL2 validation requires
      // every declared sampler to have a binding).
      const offscreenMask = !!(
        R.maskBakeProg &&
        R._handle.maskRegions.length &&
        R._maskRTArray &&
        R._handle.maskRowToLayerTex
      );
      bindFillTex(9, offscreenMask ? R._maskRTArray : R.maskRTDummy(), gl.TEXTURE_2D_ARRAY);
      bindFillTex(10, offscreenMask ? R._handle.maskRowToLayerTex : R.maskRowToLayerDummy());
      u1i(variant, 'hasOffscreenMask', uFillHasOffscreenMask, offscreenMask ? 1 : 0);
      u1i(
        variant,
        'hasPatternGroups',
        variant.u.uFillHasPatternGroups,
        offscreenMask && R._handle.hasPatternGroups ? 1 : 0,
      );
      // Interior-skip occupancy is a per-bundle property (opt-in importer
      // grids). Coherent uniform → the fill shader's occupancy branch is free
      // on bundles without it.
      const occOff = R.mantleDebugFlag('noOccupancy');
      u1i(
        variant,
        'hasOccupancy',
        uFillHasOccupancy,
        !occOff && R._handle.bundle && R._handle.bundle.hasOccupancy ? 1 : 0,
      );
      R._handle.fillPassAssetDirty = false;
      R._lastFillPassHandle = R._handle;
    }
    // Per-draw override table. This flips per drawBundle call inside one frame,
    // so it can't ride _handle.fillPassAssetDirty.
    //
    // Most frames re-bind the same table — or the same dummy — draw after
    // draw, so bindFillTex's unit shadow skips the actual GL call.
    const ov = R.draw.overrides;
    const hasOv = !!(ov && ov.uploadIfDirty);
    //
    // Unit 8 is the override table's own unit and bindFillTex re-binds it on the
    // very next line, so parking the damage there costs nothing. Clearing just that
    // one shadow slot — rather than _forgetFillUnits() — keeps the other ~10 asset
    // textures from re-binding every draw on animated content.
    if (hasOv) {
      activeUnit(8);
      ov.uploadIfDirty(); // must run every draw — it flushes dirty rows
      unitState.u[8] = null; // the null-bind above landed here; re-bind it
    }
    // Dummy 1x1 RGBA32F texture so unit 8 has something compatible with a
    // sampler2D-RGBA32F lookup (driver-defensive).
    const ovTex = hasOv ? ov.texture : dummyGradientTex;
    bindFillTex(8, ovTex);
    // A curve-tex loop-blinn program drawn by the classic pass still declares uCurveCoefTex (vertex stage). Only the
    // unified draw binds a real table there; nothing else owns unit 12, and the mask bake leaves its INTEGER row-to-layer
    // texture on it. A float sampler on an integer texture fails draw validation, and the draw is dropped (a masked
    // bundle drew blank on the default route). Give the sampler a float texture; the unified draw rebinds its own.
    if (uFillCurveCoef && R._uniScope !== true) {
      bindFillTex(12, dummyGradientTex);
      u1i(variant, 'curveCoefUnit', uFillCurveCoef, 12);
    }
    u1i(variant, 'hasOverrides', uFillHasOverrides, hasOv ? 1 : 0);
    // Per-draw opacity multiplier. The fill vert shader folds this
    // into the per-shape tint alpha so it works whether or not the
    // caller bound an override table. drawBundle/drawInstance set
    // _drawAlpha to opts.alpha (defaults to 1.0).
    u1f(variant, 'drawAlpha', uFillDrawAlpha, R.draw.alpha);
    u1f(variant, 'filterInputScale', variant.u.uFillFilterInputScale, R._filterInputScale || 1);
    if (
      variant.u.uFillFilterCoverageScale &&
      ((R._filterCoverageScale > 0 && R._filterCoverageScale !== 1) ||
        variant.s.filterCoverageScale)
    )
      u1f(
        variant,
        'filterCoverageScale',
        variant.u.uFillFilterCoverageScale,
        R._filterCoverageScale > 0 && R._filterCoverageScale !== 1 ? R._filterCoverageScale : 0,
      );
    // 9-slice em-coord: nineSlice.applyNineSlice stamps the bundle
    // with `_nineSliceActive=true` so the vert shader reads the
    // native em coord from aEmCoord (v1.xy slot) instead of aPos.
    u1i(
      variant,
      'hasEmCoord',
      uFillHasEmCoord,
      R._handle.bundle && R._handle.bundle._nineSliceActive ? 1 : 0,
    );
    if (R.draw.worldM) {
      // Pass row-major 3x3 as a mat3 (GLSL is column-major; flip).
      uMat3(variant, 'worldM', uFillWorldM, R.draw.worldM);
      u1i(variant, 'hasWorldM', uFillHasWorldM, 1);
    } else {
      u1i(variant, 'hasWorldM', uFillHasWorldM, 0);
    }
    // Per-draw bilinear channel-lerp recolor (bilinear recolor).
    // The channel-lerp formula: out = mix(R·primary +
    // B·contrast, highlight, G + 1 - A). Non-linear, can't be expressed
    // as a color matrix. Runs first in the pipeline so palette + matrix
    // can stack downstream if the caller wants.
    // Stroke fast-path gates. Default on; a bench or a validation run sets
    // renderer.strokeGates = false to prove they are output-identical without
    // rebuilding shaders (a #define would select a different variant, which is
    // its own behavior change — see probes/_strokeGateBench.mjs).
    if (uFillStrokeGates)
      u1i(variant, 'strokeGates', uFillStrokeGates, R.strokeGates === false ? 0 : 1);
    // Geometry may rotate a cover even when its draw transform is axis-aligned.
    // An explicit override replaces the variant's automatic margin policy.
    if (uFillCoverAaReach)
      u1i(
        variant,
        'coverAaReach',
        uFillCoverAaReach,
        R.coverAaReach === true || (R.coverAaReach === undefined && variant.boxFilterReach) ? 1 : 0,
      );
    // Exact-area stroke edges: default ON; false restores the isotropic ramp.
    if (uFillStrokeExactAa)
      u1i(variant, 'strokeExactAa', uFillStrokeExactAa, R.strokeExactAa === false ? 0 : 1);
    if (uFillChLerpEnabled) {
      if (R.draw.channelLerp) {
        const cl = R.draw.channelLerp;
        const p = cl.primary || [0, 0, 0, 1];
        const c = cl.contrast || [0, 0, 0, 1];
        const h = cl.highlight || [1, 1, 1, 1];
        gl.uniform4f(uFillChLerpPrimary, p[0], p[1], p[2], p[3] == null ? 1 : p[3]);
        gl.uniform4f(uFillChLerpContrast, c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
        gl.uniform4f(uFillChLerpHighlight, h[0], h[1], h[2], h[3] == null ? 1 : h[3]);
        u1i(variant, 'chLerpEnabled', uFillChLerpEnabled, 1);
      } else {
        u1i(variant, 'chLerpEnabled', uFillChLerpEnabled, 0);
      }
    }
    // Per-draw color matrix recolor (dual-tint fill recolor).
    // Caller supplies a 4x4 matrix + offset; the fragment shader
    // transforms vFill (and vStroke) via `out = M * in + offset` after
    // per-shape overrides and before coverage. When neither matrix nor
    // offset is set, the enabled flag stays 0 and the shader branch is
    // skipped (uniform branch, coherent across the draw → free).
    // Gate on EFFECT, not presence. An identity matrix with a zero offset produces the
    // color it started with — enabling it would make every fragment pay a 4x4 multiply to
    // learn that (and drag the draw onto the recolor variant).
    if (uFillColorMatrixEnabled) {
      if (!_isIdentityCm(R.draw.colorMatrix) || !_isZeroOff(R.draw.colorMatrixOffset)) {
        gl.uniformMatrix4fv(uFillColorMatrix, false, R.draw.colorMatrix || IDENTITY_COLOR_MATRIX);
        gl.uniform4fv(uFillColorMatrixOffset, R.draw.colorMatrixOffset || ZERO_OFFSET);
        u1i(variant, 'cmEnabled', uFillColorMatrixEnabled, 1);
      } else {
        u1i(variant, 'cmEnabled', uFillColorMatrixEnabled, 0);
      }
    }
    // Per-draw palette LUT. Unit 13 always holds SOMETHING (the dummy when the
    // palette is off) so the sampler has a valid binding; uPaletteEnabled gates
    // the shader path. The caller may mutate its palette between draws at
    // texSubImage2D cost — nothing to plumb here beyond the bind.
    //
    // Neither block below carries its own OFF-state latch to skip a redundant
    // dummy re-bind. The unit shadow and the per-variant uniform shadow do
    // exactly that, generically: an OFF draw issues no GL call either way, and
    // there is no third flag to forget to reset when another pass steals the
    // unit — which is how a foreign texture would stay pinned to 13/14.
    if (uFillPaletteEnabled) {
      const pal = R.draw.palette;
      const palOn = !!(pal && pal.texture);
      bindFillTex(13, palOn ? pal.texture : dummyGradientStops);
      u1i(variant, 'palEnabled', uFillPaletteEnabled, palOn ? 1 : 0);
      if (palOn) {
        u1i(variant, 'palChannel', uFillPaletteChannel, R.draw.paletteChannel | 0);
        u1i(variant, 'palSize', uFillPaletteSize, Math.max(1, pal.size | 0));
      }
    }
    // Per-draw external clip mask (setNodeClip). Same contract on unit 14:
    // uExtClipMode gates the shader path (0 → off, byte-identical to an
    // unclipped draw).
    const clipOn = !!(R.draw.extClipTex && R.draw.extClipMode > 0);
    bindFillTex(14, clipOn ? R.draw.extClipTex : dummyGradientStops);
    u1i(variant, 'extClipMode', uFillExtClipMode, clipOn ? R.draw.extClipMode | 0 : 0);
    if (cw !== R.fillPassCanvasW || ch !== R.fillPassCanvasH) {
      const [sx, sy] = arScale(R._handle.bundle.globalBBox, cw, ch);
      u2f(variant, 'canvasAR', uFillCanvasAR, sx, sy);
      u2f(variant, 'viewportSize', uFillViewportSize, cw, ch);
      R.fillPassCanvasW = cw;
      R.fillPassCanvasH = ch;
    }
    // Canvas position of the bound framebuffer's origin. Zero for every pass that
    // targets the canvas; non-zero only when a filtered shape is being rendered into
    // an RT covering just its own rect (renderer.acquireShapeRT), where gl_FragCoord
    // is rect-local and the canvas-space textures (mask, external clip, coverage RTs)
    // must still be sampled in canvas space. Not cached on cw/ch — it changes per
    // draw target, and a stale one silently shifts every screen-space sample.
    if (uFillFragOrigin) {
      const fo = R._fragOrigin || R._atlasFragOrigin;
      u2f(variant, 'fragOrigin', uFillFragOrigin, fo ? fo[0] : 0, fo ? fo[1] : 0);
    }
    R.glBindVertexArray(R._handle.triVao);
    // Leave the scratch unit active — see SCRATCH_UNIT above. Every bare
    // bindTexture upload between now and the next draw lands there instead of
    // on a unit this pass's shadow claims to know.
    activeUnit(SCRATCH_UNIT);
    if (splitEpoch > 0) variant.cpSplitBindEpoch = splitEpoch;
  }

  // The frame origin belongs to ONE fill pass — the caller sets it, this pass honors
  // it, and it dies here. Leaving the caller to clear it is how a filtered shape's
  // origin leaked into the NEXT draw, which then rendered with a shifted viewport:
  // silently, in a later frame, far from the code that set it.
  function endFillPass() {
    fillPassActive = false;
    R._fillDeclined = false;
    R._fragOrigin = null;
  }

  R.beginFillPass = beginFillPass;
  R._fillVariantHasLbFill = fillVariantHasLbFill;
  R.endFillPass = endFillPass;
}
