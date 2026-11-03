// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// drawDispatch.js — drawBundle / drawBundleInstanced / drawInstance entry points.

import { resolveDstRect, bundleDrawMatrix } from '../geom/dstRect.js';
import { checkMat3 } from '../core/argCheck.js';
import { syncKeptRows } from './bundle.js';
import { worldMapAxisAligned, overridesAxisAligned, patternMapAxisAligned } from './shapeScale.js';
import {
  FS_LAYER,
  FS_NON_SCALING_STROKE,
  FS_NON_SCALING_SIZE,
  FS_NON_ROTATION,
  FS_FIXED_POSITION,
  META_FLAGS_SHAPE,
} from '../bundle/layout.js';

/** An exact zero-scale affine map has no displayed area. Do not use a
 * determinant tolerance: tiny invertible maps must keep their rendering path.
 * @param {ArrayLike<number> | null | undefined} m
 * @param {{metaFloats?: ArrayLike<number>, metaFloatsPerShape?: number, numShapes?: number, _morphSrc?: {metaMovesWithT?: boolean} | null} | null | undefined} bundle */
export function collapsedAffineDraw(m, bundle) {
  if (!(
    !!m &&
    m[0] === 0 &&
    m[1] === 0 &&
    m[3] === 0 &&
    m[4] === 0 &&
    m[2] === 0 &&
    m[5] === 0 &&
    Number.isFinite(m[8]) &&
    m[8] !== 0 &&
    Number.isFinite(m[6]) &&
    Number.isFinite(m[7])
  ))
    return false;
  // Scale-independent vector effects can reconstruct visible geometry. Defer
  // changing morph metadata and unknown layouts to the normal draw path.
  if (!bundle || bundle._morphSrc?.metaMovesWithT) return false;
  const meta = bundle.metaFloats,
    stride = (bundle.metaFloatsPerShape || 0) | 0;
  const n = (bundle.numShapes || 0) | 0;
  if (!meta || stride <= META_FLAGS_SHAPE || meta.length < n * stride) return false;
  for (let i = 0; i < n; i++) {
    const flags = meta[i * stride + META_FLAGS_SHAPE] | 0;
    if (flags & (FS_NON_SCALING_STROKE | 8192 | 16384)) return false;
    // Layer rows reuse the size/rotation/position bits for resource brackets.
    if (!(flags & FS_LAYER) && flags & (FS_NON_SCALING_SIZE | FS_NON_ROTATION | FS_FIXED_POSITION))
      return false;
  }
  return true;
}

/// THE OVERRIDE TABLE A DRAW SHOULD USE, when the caller named none.

/// AN EXPLICIT `overrides: null` MEANS NONE. Absent — or `undefined`, or no opts at all —
/// means "whatever this target already carries". Those are different questions and a caller
/// can only ask the second one by name: drawing a morph's geometry WITHOUT its fade (to see
/// what the lerp is doing, or to drive visibility from somewhere else) has no other spelling,
/// whereas "use the morph's" is what every caller who says nothing wants. `undefined` is on
/// the "says nothing" side deliberately, because it is what a spread of an options object
/// whose key was never set produces, and stripping a morph's fade on that would be a silent
/// drop. The bundle is consulted rather than the handle so a bare
/// `drawBundle(morph.bundle)` fades too; the fade is part of the morph's correct appearance,
/// not a property of the wrapper it was reached through.
export function resolveOverrides(bundle, opts) {
  if (opts && opts.overrides !== undefined) return opts.overrides || null;
  return (bundle && bundle._morphOverrides) || null;
}

/// What exportFrameSVG replays of a draw, for the entries that draw one bundle once (drawBundle, a mount's draw).
export function recordDrawForExport(R, bundle, opts, ovTable, dstFit) {
  if (!(R._captureFrames && R._inFrame)) return;
  // COPIED, not referenced: the recorder holds matrices as-is (export reads
  // their current state), and the resolved matrix lives in a small reused
  // scratch ring — a fifth dstRect draw in the same frame would rewrite the
  // first one's record under it.
  // The RESOLVED override table, for the same reason the resolved matrix is recorded: an
  // export replays what the draw did, and a morph drawn without a table of its own would
  // otherwise export with both poses' unmatched shapes solid.
  R._recordBundleDraw(bundle, {
    ...opts,
    overrides: ovTable,
    viewportWorldMatrix: bundleDrawMatrix(R, bundle, opts),
    ...(dstFit ? { worldMatrix: dstFit.worldM.slice(), scissor: dstFit.scissor || null } : null),
  });
}

/// A disposed bundle has no textures: binding it would allocate a transient handle (VAO, buffers, texture, FBO) per call, draw nothing
/// and raise a feedback-loop GL error each frame. It is a use-after-dispose bug in the caller, so say so once per bundle.
const _warnedDisposed = new WeakSet();
/// A SHARED morph drawn for one of its users (opts.morphT, or the timeline itself drawn: drawBundle(timeline)): that user's pose, applied before anything of this draw is bound.
/// The morph's curve-lerp pre-pass binds a framebuffer of its own; the draw's target is put back after it, whoever bound it (drawInstance draws into the caller's). The pass announces its other GL writes.
export function applySharedPose(R, target, bundle, opts) {
  const pose =
    opts && typeof opts.morphT === 'number'
      ? opts.morphT
      : target !== bundle && target && typeof target.t === 'number'
        ? target.t
        : NaN;
  if (
    pose !== pose ||
    typeof bundle._morphSetT !== 'function' ||
    !bundle._morphSrc ||
    bundle._morphSrc.t === pose
  )
    return;
  const fb = R.gl.getParameter(R.gl.FRAMEBUFFER_BINDING),
    t0 = bundle._morphSrc.t;
  bundle._morphSetT(pose);
  if (bundle._morphSrc.t === t0) return;
  R.gl.bindFramebuffer(R.gl.FRAMEBUFFER, fb);
  if (R._applyTargetScissor) R._applyTargetScissor(fb); // (the pass disabled the scissor raw; the frame's is not re-set per draw)
}

export function disposedBundleDraw(R, fn, bundle) {
  if (!_warnedDisposed.has(bundle)) {
    _warnedDisposed.add(bundle);
    R.mantleWarn(
      '[Mantle] ' +
        fn +
        ': the bundle (or morph) is disposed; nothing is drawn. Stop drawing it, or create a new one.',
    );
  }
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachDrawDispatch(R) {
  const { setBundle, render, paletteChannelToInt, _analyticRoute, _canvasUnsized } = R;

  /// Once per frame, before any geometry is bound: let the fill pass finish and pipeline-warm a
  /// variant whose link has completed. Hooked here rather than in beginFrame because consumers
  /// reach the renderer through several frame entries (render(), handle.draw(), instanced), and
  /// a warm that never runs is worse than useless — it looks like it works.
  /// `draw`: the entry is about to CLEAR the canvas (a standalone render()), so the tick may draw its one-pixel
  /// pipeline warm; every other entry outside a frame links and promotes but draws nothing (a warm pixel must never outlive the entry that drew it).
  function warmTick(draw = false) {
    if (!R.fillWarmTick) return;
    // Count this frame against any variant still waiting for its pipeline, before the throttle: the
    // warm deadline is in frames, and a loop can submit frames faster than one per 8 ms.
    if (R._ageWarmDemands) R._ageWarmDemands();
    // INSIDE A FRAME, only THE COUNT (the frame-entry contract at renderer.js renderEntry): beginFrame
    // ticked before its clear. A tick here drew its one-pixel pipeline warm into the frame, over what it had drawn.
    if (R._inFrame) return;
    // Not keyed on R._frameSerial: that is only bumped by beginFrame(), and consumers that drive
    // the renderer through render()/handle.draw() never call it — the guard would then compare
    // undefined to undefined and never fire. Throttle on wall clock instead: at most one
    // pipeline build per ~frame.
    const now = performance.now();
    if (now - (R._warmAt || 0) < 8) return;
    R._warmAt = now;
    R.fillWarmTick({ draw: !!draw });
  }
  // The public render() ticks it too (renderer.js renderEntry). The two render() calls below are
  // this module's own fallbacks, made after drawBundle's tick, so they call the untick'd body.
  R._warmTick = warmTick;

  /// Honor a landed cpatch conversion. The pooled conversion finishes between frames on a
  /// promise, sets bundle._cpatchRetry and stops. prepareBundle is the only thing that consumes the
  /// flag, so without this a caller that prepared once (which is the documented way) would get the
  /// Slug fallback for the life of the bundle no matter how long it waited; only a caller that polls
  /// _cpatchConv and prepares a SECOND time would see the conversion -- private knowledge that the
  /// public path should not need. Any bundle whose conversion outlives its prepare is affected; a
  /// small one such as text, whose conversion lands just after the caller's one prepare, most often.
  ///
  /// Here rather than in the conversion's continuation because the continuation has no renderer --
  /// a bundle can be drawn by several -- and here rather than in beginFrame because consumers that
  /// drive the renderer through render()/handle.draw() never call it. Build work at the top of a
  /// draw is what warmTick already does, and this is cheaper: one strict-equality test, and
  /// cpatchFill is false for everyone who has not opted in.
  function cpatchRetryTick(bundle) {
    if (!bundle || bundle._cpatchRetry !== true) return;
    if (R.opts.cpatchFill !== true && !(R.opts.cpatchAuto === true && !bundle._morphSrc)) return;
    if (R.prepareBundle) {
      try {
        R.prepareBundle(bundle);
      } catch {
        /* decline -> Slug, as ever */
      }
    }
  }

  function clearDrawState() {
    R.draw.overrides = null;
    R.draw.worldM = null;
    R.draw.alpha = 1.0;
    R.draw.colorMatrix = null;
    R.draw.colorMatrixOffset = null;
    R.draw.palette = null;
    R.draw.paletteChannel = 0;
    R.draw.channelLerp = null;
    R.draw.extClipTex = null;
    R.draw.extClipMode = 0;
  }

  /// Draw one bundle (or animation handle) into the current viewport.
  ///
  /// The content bbox is what gets fitted. The draw scales the bundle's inked bounding box
  /// (`globalBBox`) by `min(width/bboxWidth, height/bboxHeight)` and centers it — the SVG's
  /// viewBox is not mapped 1:1, so padding the artwork carried inside its viewBox is not
  /// reproduced. See setViewport in frameLoop.js.
  ///
  /// `opts.dstRect` [x, y, w, h] puts that fit in a RECTANGLE of the viewport instead of the
  /// whole of it — viewport pixels, y-down, origin top-left, the same units as drawImage's
  /// dstRect. `opts.fit` takes preserveAspectRatio's vocabulary ('xMidYMid meet' by default,
  /// 'slice' to cover, 'none' to stretch) and `opts.clipToRect` (default true) scissors the
  /// draw to the rect's edges. It composes into the per-draw world matrix — see dstRect.js
  /// for what that buys and what it inherits — and `renderer.bundleDrawMatrix(target, opts)`
  /// returns the matching em→pixel matrix so a hit test answers for the pixels drawn.
  ///
  /// `opts.overrides` is the per-shape override table. LEAVE IT OUT and an animation handle
  /// that owns one (a morph's fade-in/fade-out) supplies its own — see resolveOverrides; pass
  /// `overrides: null` to draw the geometry with no table at all.
  function drawBundle(target, opts) {
    warmTick();
    if (R._contextLost) return;
    if (!target) return;
    // Accept either a bundle directly, or an animation handle that
    // owns a bundle (createShapeMorph, createShapeTimeline,
    // createSpatialBezierMorph, createPathDeltaMorph, createSkinnedMorph,
    // createPoseStack — anything with a `.bundle` getter). Consumers
    // never have to manually unwrap: pass the morph/timeline and the
    // current frame's data is bound automatically. Re-binding each
    // draw call is cheap (per-asset dirty flag short-circuits when
    // the same bundle is bound back-to-back); ensures timelines that
    // internally rebuild a morph across bracket boundaries don't need
    // a re-`setBundle` from the caller.
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    // a sprite timeline's held frame is a view of its sheet: it draws as drawSprite(sheet, sprite), which comes back here with the sheet and its range set
    if (bundle._spriteOf && !R.draw.shapeRange) {
      R.drawSprite(bundle._spriteOf.sheet, bundle._spriteOf.sprite, opts);
      return;
    }
    if (bundle._disposed || target._disposed) {
      disposedBundleDraw(R, 'drawBundle', bundle);
      return;
    }
    if (opts) checkMat3('drawBundle', 'worldMatrix', opts.worldMatrix);
    cpatchRetryTick(bundle);
    applySharedPose(R, target, bundle, opts);

    const dstFit = resolveDstRect(R, bundle, opts);
    const ovTable = resolveOverrides(bundle, opts);
    recordDrawForExport(R, bundle, opts, ovTable, dstFit);
    // Preserve the captured draw above, but allocate no targets for collapsed
    // timeline poses. Explicit pipeline warming still runs its draw.
    if (
      !R._psoWarming &&
      collapsedAffineDraw(dstFit ? dstFit.worldM : opts && opts.worldMatrix, bundle)
    )
      return;
    if (R._atlasReset) R._atlasReset();
    setBundle(bundle);
    R.draw.overrides = ovTable;
    syncKeptRows(bundle, ovTable);
    // Every route reads the draw list: retire the cull here, not only in the classic pass.
    if (R._retireCullIfOverridden) R._retireCullIfOverridden();
    R.draw.worldM = dstFit ? dstFit.worldM : (opts && opts.worldMatrix) || null;
    if (R._noteDrawIdle) R._noteDrawIdle(bundle, ovTable, R.draw.worldM, opts && opts.alpha, opts);
    if (bundle._stripChunks && bundle._stripChunks.length && R._applyStripMode)
      R._applyStripMode(bundle, target !== bundle); // an animation handle animates geometry the strip was not built for
    // opts.alpha is the draw's GROUP opacity (below: R._alphaGroupBegin). Here it is only recorded in R.draw.alpha, whose leaf-level
    // consumers (uDrawAlpha in the fill, AAC point and morph programs, the filter output opacity) see it for a draw that is one
    // paint-only leaf, where per-leaf and group agree; a draw that needs the group sees 1 there. Works on bare bundles (no override
    // table required) and on bundles with overrides -- the override buffer's stored tint stays unmodified across draws.
    R.draw.alpha =
      opts && typeof opts.alpha === 'number' ? Math.max(0, Math.min(1, opts.alpha)) : 1.0;
    R.draw.colorMatrix = (opts && opts.colorMatrix) || null;
    R.draw.colorMatrixOffset = (opts && opts.colorMatrixOffset) || null;
    R.draw.palette = (opts && opts.palette) || null;
    R.draw.paletteChannel = paletteChannelToInt(opts && opts.paletteChannel);
    R.draw.channelLerp = (opts && opts.channelLerp) || null;
    R.draw.extClipTex = (opts && opts.extClipTex) || null;
    R.draw.extClipMode = (opts && opts.extClipMode) | 0;
    // Analytic fill route (setLoopBlinnFill / setFillEngine; 'auto' by default). A bundle
    // it serves draws through the unified draw, where shapes with a mesh and shapes on
    // cover quads share one stream; anything it cannot serve takes render(). Static and
    // streamed bundles only (see _analyticRoute + the _geomGen gate).
    const _bareBundle = target.bundle === undefined;
    // dstRect's edge clip. Saved and restored around the draw so a per-draw rect never
    // outlives its draw, and so an outer setScissorRect survives one (resolveDstRect already
    // intersected with it — a per-draw rect may shrink the caller's region, never widen it).
    // `undefined` means "this draw set no scissor", which is distinct from "the caller had
    // none" (null) — conflating the two would clear a scissor this draw never touched.
    let savedScissor;
    if (dstFit && dstFit.scissor) {
      savedScissor = R._scissor ? R._scissor.slice() : null;
      R.setScissorRect(dstFit.scissor[0], dstFit.scissor[1], dstFit.scissor[2], dstFit.scissor[3]);
    }

    // alpha < 1: the whole draw is a GROUP faded as one unit (renderer.js R._alphaGroupBegin). null at alpha 1 and for a draw that
    // is one paint-only leaf, which keeps the direct path.
    let alphaGroup = null;
    try {
      alphaGroup = R._alphaGroupBegin(bundle);
      R._autoNodeClip(bundle);
      // Points first where the analytic route would paint only recognized primitives (aacPointsDraw.js aacPointsFirst).
      if (
        R._aacPointsFirst &&
        R._aacPointsFirst(bundle, () => {
          if (_analyticRoute(bundle, { bare: _bareBundle })) R._drawDebugOverlays(bundle, true);
          else render();
        })
      ) {
        /* drawn as points */
      } else if (!_analyticRoute(bundle, { bare: _bareBundle })) {
        // LB-only ('only' mode): no Slug fallback → draw nothing. Otherwise AAC's small-shape point route
        // (aacPointsDraw.js) takes the draw when it qualifies, and render() when it does not.
        if (R._lbSlugFallback && !(R._aacPointsRoute && R._aacPointsRoute(bundle))) render();
      } else {
        // render() draws the debug overlays at the end of its pass; the analytic route never
        // enters it, so it must draw them itself — over ITS mesh, which is the one on screen.
        R._drawDebugOverlays(bundle, true);
      }
      if (alphaGroup) {
        const g = alphaGroup;
        alphaGroup = null;
        R._alphaGroupEnd(g);
      }
    } finally {
      if (alphaGroup) R._alphaGroupAbort(alphaGroup);
      if (savedScissor !== undefined) {
        if (savedScissor)
          R.setScissorRect(savedScissor[0], savedScissor[1], savedScissor[2], savedScissor[3]);
        else R.clearScissorRect();
      }
      clearDrawState();
    }
  }

  /// em → viewport pixels (y-down) for the draw `drawBundle(target, opts)` would perform now.
  /// Hand it to `fillHitShape(bundle, px, py, { worldMatrix: m })` and the hit boundary agrees
  /// with the pixels on screen; `opts.worldMatrix` alone does NOT, because it acts in clip
  /// space and carries none of the viewport fit. Pure query — touches no GL state.
  function bundleDrawMatrixFor(target, opts) {
    if (!target) return null;
    const bundle = target.bundle !== undefined ? target.bundle : target;
    return bundle ? bundleDrawMatrix(R, bundle, opts) : null;
  }

  // ---- per-instance color helpers (drawBundleInstanced) -------------------
  // Per-instance color state is defined at the colorMatrix stage:
  //   c' = sharedCM · ( instCM · ( diag(tint) · c ) + instOff ) + sharedOff
  // i.e. the instance tint applies first (as a diagonal matrix), then the
  // instance matrix+offset, then the shared matrix+offset. The GPU fast path
  // implements diag(tint) via the vertex override-tint multiply — identical
  // math when channelLerp is off (multiplication commutes past the paint
  // eval); full per-instance matrices take the per-instance loop below,
  // where the stages are composed into ONE effective matrix+offset.
  // All matrices are 16-float COLUMN-MAJOR (the uniformMatrix4fv layout —
  // same convention as drawBundle's opts.colorMatrix).
  function _mat4MulInto(o, A, B) {
    // o = A·B, column-major flat
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
        o[c * 4 + r] = s;
      }
  }
  let _fastColorScratch = null;
  let _fastColorCap = 0;
  // The loop consumes this state synchronously in render(), so one pair of
  // scratch buffers avoids allocating matrices and offsets for every copy.
  const _loopColorMatrix = new Float32Array(16);
  const _loopColorTintMatrix = new Float32Array(16);
  const _loopColorOffset = new Float32Array(4);
  function _setEffInstColor(inst, sharedCM, sharedOff) {
    const t = inst.tint,
      iM = inst.colorMatrix,
      iO = inst.colorMatrixOffset;
    if (!t && !iM && !iO) {
      R.draw.colorMatrix = sharedCM;
      R.draw.colorMatrixOffset = sharedOff;
      return;
    }

    let innerM = iM;
    if (t) {
      const tr = t[0],
        tg = t[1],
        tb = t[2];
      const ta = t.length > 3 && t[3] != null ? t[3] : 1;
      if (iM) {
        for (let c = 0; c < 4; c++) {
          const scale = c === 0 ? tr : c === 1 ? tg : c === 2 ? tb : ta;
          const p = c * 4;
          _loopColorTintMatrix[p] = iM[p] * scale;
          _loopColorTintMatrix[p + 1] = iM[p + 1] * scale;
          _loopColorTintMatrix[p + 2] = iM[p + 2] * scale;
          _loopColorTintMatrix[p + 3] = iM[p + 3] * scale;
        }
      } else {
        _loopColorTintMatrix.fill(0);
        _loopColorTintMatrix[0] = tr;
        _loopColorTintMatrix[5] = tg;
        _loopColorTintMatrix[10] = tb;
        _loopColorTintMatrix[15] = ta;
      }
      innerM = _loopColorTintMatrix;
    }

    let m = innerM;
    if (sharedCM && innerM) {
      _mat4MulInto(_loopColorMatrix, sharedCM, innerM);
      m = _loopColorMatrix;
    } else if (sharedCM) {
      m = sharedCM;
    }

    let off = iO;
    if (iO && sharedCM) {
      for (let r = 0; r < 4; r++) {
        _loopColorOffset[r] =
          sharedCM[r] * iO[0] +
          sharedCM[4 + r] * iO[1] +
          sharedCM[8 + r] * iO[2] +
          sharedCM[12 + r] * iO[3] +
          (sharedOff ? sharedOff[r] : 0);
      }
      off = _loopColorOffset;
    } else if (iO && sharedOff) {
      for (let r = 0; r < 4; r++) _loopColorOffset[r] = iO[r] + sharedOff[r];
      off = _loopColorOffset;
    } else if (!iO) {
      off = sharedOff;
    }
    R.draw.colorMatrix = m;
    R.draw.colorMatrixOffset = off;
  }

  /// The instanced fast path's extra fragment defines: its engine's, and the rotated footprint (MANTLE_ROTATED_MAP)
  /// when any instance's world matrix is not axis-aligned -- each instance carries its own map -- or the shared
  /// override table rotates a row.
  function instProgDefines(bundle, instances) {
    const defs = (R._instancedEngineDefines ? R._instancedEngineDefines(bundle) : []).slice();
    if (!overridesAxisAligned(R.draw && R.draw.overrides) || !patternMapAxisAligned(bundle)) {
      defs.push('MANTLE_ROTATED_MAP');
      return defs;
    }
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (inst && !worldMapAxisAligned(inst.worldMatrix)) {
        defs.push('MANTLE_ROTATED_MAP');
        break;
      }
    }
    return defs;
  }

  /** drawBundleInstanced(target, instances, shared) — draw ONE bundle at N
   *  transforms with per-instance worldMatrix/alpha/tint (and optionally a
   *  full per-instance colorMatrix+offset), sharing the bundle geometry AND
   *  a single `shared.overrides` table across every instance. The bundle is
   *  bound ONCE (the per-mount setBundle + intermediate bakes run a single
   *  time, reused via the mask-bake + filter caches).
   *
   *  Each instance's `alpha` is GROUP opacity, as drawBundle's: an instance below 1 of a bundle that paints more than one thing is
   *  faded as one unit, which one instanced draw cannot do: instances whose painted boxes do not touch share one accumulator per
   *  distinct alpha (one instanced draw each), and ones that do touch are layered so that the painter order holds (one accumulator per
   *  layer and alpha; R._alphaInstancePlan). A bundle whose own leaves cannot overlap keeps the single instanced draw. Anything the
   *  plan cannot bound takes the per-instance loop, one group each.
   *
   *  Routing:
   *  - GPU fast path (one drawArraysInstanced): simple fill-only bundles,
   *    per-instance worldMatrix + alpha + rgba `tint` as instanced vertex
   *    attributes. Taken when no instance carries a full colorMatrix/offset
   *    (a tint IS instanced natively) and, if any instance is tinted, no
   *    shared channelLerp is active (ordering vs the lerp would diverge
   *    from the composed-matrix semantics below).
   *  - Per-instance loop otherwise (masks/filters/clips/9-slice/_lbStream,
   *    or per-instance colorMatrix/colorMatrixOffset): each instance's
   *    tint/matrix/offset is composed with the shared matrix into ONE
   *    effective colorMatrix per instance — pixel-equivalent to the fast
   *    path for the states both support.
   *
   *  @param {object} target  bundle or animation handle (auto-unwrapped).
   *  @param {Array<{worldMatrix?, alpha?, tint?, colorMatrix?, colorMatrixOffset?}>} instances
   *    worldMatrix: 9-float column-major mat3; alpha: [0,1] multiplier;
   *    tint: [r,g,b,a] multiplicative rgba (≡ diagonal colorMatrix);
   *    colorMatrix/colorMatrixOffset: 16/4-float, column-major (loop path).
   *  @param {object} [shared] overrides/colorMatrix/colorMatrixOffset/palette/
   *    paletteChannel/channelLerp — applied to every instance. `overrides` left out means the
   *    target's own table (a morph's fade); `overrides: null` means none.
   *  @returns {number} instances drawn.
   */
  function drawBundleInstanced(target, instances, shared) {
    warmTick();
    if (R._contextLost) return 0;
    if (!target) return 0;
    if (!Array.isArray(instances) || instances.length === 0) return 0;
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return 0;
    if (bundle._spriteOf && !R.draw.shapeRange)
      return R.drawSpriteInstanced(
        bundle._spriteOf.sheet,
        bundle._spriteOf.sprite,
        instances,
        shared,
      ); // (a held sprite frame, as drawBundle)
    if (bundle._disposed || target._disposed) {
      disposedBundleDraw(R, 'drawBundleInstanced', bundle);
      return 0;
    }
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (inst)
        checkMat3('drawBundleInstanced', 'instances[' + i + '].worldMatrix', inst.worldMatrix);
    }
    cpatchRetryTick(bundle);
    applySharedPose(R, target, bundle, shared);
    // NO dstRect HERE, deliberately. Every instance already carries its own worldMatrix, and
    // a rect is one: `renderer.bundleDrawMatrix` composes the placement a caller wants and the
    // instance matrix is where it belongs. Accepting a shared rect would also have to decide
    // whether N instances share one scissor or get N — a question with no good answer at this
    // level — so the option is refused loudly rather than half-honored.
    if (shared && shared.dstRect) {
      R.mantleWarn(
        '[Mantle] drawBundleInstanced: dstRect is not supported here; give each ' +
          'instance a worldMatrix (renderer.bundleDrawMatrix composes one) and scissor the ' +
          'frame yourself if you need the crop. Ignoring it.',
      );
    }
    if (
      !R._psoWarming &&
      !R._captureFrames &&
      instances.every((inst) => inst && collapsedAffineDraw(inst.worldMatrix, bundle))
    )
      return instances.length;
    // Bind the bundle ONCE — the per-mount cost (setBundle, and on first
    // render the mask bake + filter eval) is paid a single time; the
    // mask-bake + filter caches make every subsequent instance reuse those bakes.
    // Simple instancing uses its own compact mesh cache. Avoid uploading the
    // normal cover VBO into this transient handle unless the fallback loop
    // actually reaches render().
    setBundle(bundle, { deferCoverUpload: true });
    shared = shared || {};
    // Same resolution as drawBundle: N instances of a morph fade exactly as one does.
    const sharedOv = resolveOverrides(bundle, shared);
    R.draw.overrides = sharedOv;
    syncKeptRows(bundle, sharedOv);
    if (R._retireCullIfOverridden) R._retireCullIfOverridden();
    if (R._noteInstancesIdle) R._noteInstancesIdle(bundle, sharedOv, instances, shared);
    R.draw.colorMatrix = shared.colorMatrix || null;
    R.draw.colorMatrixOffset = shared.colorMatrixOffset || null;
    R.draw.palette = shared.palette || null;
    R.draw.paletteChannel = paletteChannelToInt(shared.paletteChannel);
    R.draw.channelLerp = shared.channelLerp || null;
    // A lightweight-streamed bundle has no Slug cover-quad VBO, so the Slug
    // instancing fast path + render() loop can't paint it — route each instance
    // through the analytic fill (which honors the per-instance worldMatrix).
    const _lbStreamed = !!(bundle && bundle._lbStream);

    const _isDiagCm = (m) => {
      if (!m) return true;
      for (let i = 0; i < 16; i++) {
        if (i % 5 === 0) continue; // diagonal
        if (Math.abs(m[i]) > 1e-6) return false; // a real matrix — needs the loop
      }
      return true;
    };
    let _anyInstCM = false,
      _anyInstTint = false,
      _hasDiagInstColor = false;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (!inst) continue;
      if (inst.colorMatrix || inst.colorMatrixOffset) {
        // Diagonal → it IS a tint + bias, so stay on the fast path.
        if (!_isDiagCm(inst.colorMatrix)) {
          _anyInstCM = true;
          break;
        } // a real matrix → the loop
        _hasDiagInstColor = true;
        _anyInstTint = true;
        continue;
      }
      if (inst.tint) _anyInstTint = true;
    }
    // GPU instancing fast path: a fill-only bundle paints all N copies in one
    // drawArraysInstanced per chunk. Skipped for _lbStream (no cover-quad VBO),
    // when capturing frames for SVG export (the loop records each instance), or
    // when the bundle isn't simple / the program fails to build.
    try {
      // …and NOT when the analytic route would serve a PLAIN-FILL instanced draw.
      // The fast path is Slug-only, so taking it made the engine a property of the
      // Call site rather than of the bundle: the same content painted by Slug when
      // drawn instanced and by LB when drawn through a handle — so enabling
      // something as unrelated as a static cache silently swapped renderers (a
      // per-mount cache breaks the caller's instancing run). Ask the same question
      // in both places. LB's 'auto' gate inside _lbWouldServe is what keeps
      // many-small-instance content — sprites, text — on the instanced Slug path,
      // where one drawArraysInstanced genuinely beats N analytic draws.
      //
      // Per-instance color keeps the fast path. A tint rides the instanced vertex
      // attributes, so N tinted copies still cost ONE draw; routing them per-instance
      // through LB would trade that batching away. The engine can still differ by
      // call site for those, but paying N analytic draws to eliminate that
      // difference would cost more than preserving the instanced path.
      const _lbOverInstanced = R._lbWouldServe(bundle, true) && !_anyInstCM && !_anyInstTint;
      const instFastOff = R.mantleDebugFlag('noInstancedFast');
      // A draw alpha is group opacity (renderer.js R._alphaGroupBegin): an instance below 1 of a bundle that can paint two things
      // fades its own accumulated copy, which one instanced draw cannot do. Those leave the fast path for the per-instance loop; a
      // bundle that is one paint-only leaf (and an alpha-1 batch) keeps it.
      let _anyGroupAlpha = false;
      for (let i = 0; i < instances.length; i++) {
        const ia = instances[i] && instances[i].alpha;
        if (typeof ia === 'number' && ia < 1) {
          _anyGroupAlpha = true;
          break;
        }
      }
      if (_anyGroupAlpha)
        _anyGroupAlpha = R._alphaNeedsGroup(
          bundle,
          !!(shared.colorMatrix || shared.colorMatrixOffset || _hasDiagInstColor),
        );
      // ...unless the instances can share accumulators (R._alphaInstancePlan): instances that do not touch go into one accumulator per
      // alpha, drawn by the single instanced draw and faded once, in layers that keep the painter order of the ones that do; or no
      // instance's own leaves can overlap ('direct'), and the single instanced draw with its per-instance alpha is the picture.
      let faded = null;
      if (
        !instFastOff &&
        !_lbStreamed &&
        (!_anyGroupAlpha ||
          (!_hasDiagInstColor && !shared.colorMatrix && !shared.colorMatrixOffset)) &&
        R._instancedFastEnabled &&
        instances.length >= 2 &&
        !(R._captureFrames && R._inFrame) &&
        !_anyInstCM &&
        !(_anyInstTint && shared.channelLerp) &&
        !_canvasUnsized() &&
        !_lbOverInstanced &&
        R._simpleInstanceable(bundle, R._handle) &&
        R._selectInstProgram(bundle, instProgDefines(bundle, instances)) &&
        (!_anyGroupAlpha || (faded = R._alphaInstancePlan(bundle, instances)))
      ) {
        if (faded && faded !== 'direct') {
          // Touching faded instances need more than one layer: give each its own slot of the atlas instead, and draw them all at once.
          if (R._alphaSlotBatch && faded.some((bt) => bt.level > 0)) {
            const sb = R._alphaSlotBatch(bundle, instances);
            if (sb > 0) return sb;
          }
          let drawn = 0;
          for (let bi = 0; bi < faded.length; bi++) {
            const bt = faded[bi];
            if (bt.alpha >= 1) R._drawBundleInstancedFast(bundle, bt.list, null);
            else {
              R.draw.alpha = bt.alpha;
              let g = null;
              try {
                // (the layers of a faded grid are a run: their composites share the group atlas)
                g = R._alphaGroupBegin(bundle, bt.rect, {
                  next: bi + 1 < faded.length && faded[bi + 1].alpha < 1,
                });
                R._drawBundleInstancedFast(bundle, bt.list, null);
                if (g) {
                  const t = g;
                  g = null;
                  R._alphaGroupEnd(t);
                }
              } finally {
                if (g) R._alphaGroupAbort(g);
              }
            }
            drawn += bt.list.length;
          }
          return drawn;
        }
        let packedColor = null;
        if (_hasDiagInstColor) {
          const needed = instances.length * 8;
          if (_fastColorCap < needed) {
            _fastColorCap = Math.max(needed, _fastColorCap ? _fastColorCap * 2 : 64);
            _fastColorScratch = new Float32Array(_fastColorCap);
          }
          packedColor = _fastColorScratch;
          for (let i = 0; i < instances.length; i++) {
            const inst = instances[i] || {};
            const tint = inst.tint;
            const cm = inst.colorMatrix;
            const off = inst.colorMatrixOffset;
            const p = i * 8;
            const tr = tint ? tint[0] : 1,
              tg = tint ? tint[1] : 1,
              tb = tint ? tint[2] : 1;
            const ta = tint && tint[3] != null ? tint[3] : 1;
            packedColor[p] = tr * (cm ? cm[0] : 1);
            packedColor[p + 1] = tg * (cm ? cm[5] : 1);
            packedColor[p + 2] = tb * (cm ? cm[10] : 1);
            packedColor[p + 3] = ta * (cm ? cm[15] : 1);
            packedColor[p + 4] = off ? off[0] : 0;
            packedColor[p + 5] = off ? off[1] : 0;
            packedColor[p + 6] = off ? off[2] : 0;
            packedColor[p + 7] = off ? off[3] || 0 : 0;
          }
        }
        return R._drawBundleInstancedFast(bundle, instances, packedColor);
      }
      // Shared-bake bundles stay on Slug so the bake is reused across instances.
      const _instSlug = !_lbStreamed && R._instancedPrefersSlug(bundle, R._handle);
      const _hasInstColor = _anyInstCM || _anyInstTint;
      let drawn = 0;
      const prep = (inst, alpha) => {
        R.draw.worldM = inst.worldMatrix || null;
        R.draw.alpha = alpha;
        if (_hasInstColor) {
          // Compose tint ∘ instance-CM ∘ shared-CM into ONE effective pair.
          // Instances without their own color state fall back to the shared
          // pair (reset each iteration — a prior instance may have replaced it).
          _setEffInstColor(inst, shared.colorMatrix || null, shared.colorMatrixOffset || null);
        }
        if (R._captureFrames && R._inFrame)
          R._recordBundleDraw(bundle, {
            worldMatrix: inst.worldMatrix,
            alpha: inst.alpha,
            viewportWorldMatrix: bundleDrawMatrix(R, bundle, { worldMatrix: inst.worldMatrix }),
            overrides: sharedOv,
            colorMatrix: _hasInstColor ? R.draw.colorMatrix : shared.colorMatrix,
            colorMatrixOffset: _hasInstColor ? R.draw.colorMatrixOffset : shared.colorMatrixOffset,
            palette: shared.palette,
            paletteChannel: shared.paletteChannel,
            channelLerp: shared.channelLerp,
          });
      };
      const paint = () => {
        if (!R._psoWarming && collapsedAffineDraw(R.draw.worldM, bundle)) {
          drawn++;
          return;
        }
        if (_instSlug || !_analyticRoute(bundle, { streamOnly: true })) {
          if (R._lbSlugFallback) render();
        }
        drawn++;
      };
      const drawOne = (inst, alpha) => {
        prep(inst, alpha);
        paint();
      };
      const aOf = (inst) =>
        typeof inst.alpha === 'number' ? Math.max(0, Math.min(1, inst.alpha)) : 1.0;
      // Faded instances of a bundle that needs the group, drawn one by one (the analytic route, or per-instance color): the plan
      // (R._alphaInstancePlan) still says which of them can share an accumulator, so each batch is ONE group around its instances.
      let batches = null;
      if (
        _anyGroupAlpha &&
        !(R._captureFrames && R._inFrame) &&
        !shared.colorMatrix &&
        !shared.colorMatrixOffset
      ) {
        const plan = R._alphaInstancePlan(bundle, instances);
        if (Array.isArray(plan)) batches = plan;
      }
      if (batches) {
        for (let bi = 0; bi < batches.length; bi++) {
          const bt = batches[bi];
          if (bt.alpha >= 1) {
            for (const i of bt.idx) drawOne(instances[i] || {}, 1.0);
            continue;
          }
          R.draw.alpha = bt.alpha;
          let g = null;
          try {
            // The batch's instances are recolored one by one INSIDE the group (prep), so the color state the group is asked under is
            // not yet theirs: say so (`recolor`), or a one-leaf bundle declines the group and the batch paints at alpha 1.
            g = R._alphaGroupBegin(bundle, bt.rect, {
              next: bi + 1 < batches.length && batches[bi + 1].alpha < 1,
              recolor: _hasInstColor,
            });
            // No group (per-leaf alpha is the group's): each instance carries the batch alpha itself.
            const ia = g ? 1.0 : bt.alpha;
            for (const i of bt.idx) drawOne(instances[i] || {}, ia);
            if (g) {
              const t = g;
              g = null;
              R._alphaGroupEnd(t);
            }
          } finally {
            if (g) R._alphaGroupAbort(g);
          }
        }
        return drawn;
      }
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i] || {};
        let alphaGroup = null;
        try {
          prep(inst, aOf(inst));
          const nx = instances[i + 1];
          alphaGroup = R._alphaGroupBegin(bundle, undefined, { next: !!nx && aOf(nx) < 1 });
          paint();
          if (alphaGroup) {
            const g = alphaGroup;
            alphaGroup = null;
            R._alphaGroupEnd(g);
          }
        } finally {
          if (alphaGroup) R._alphaGroupAbort(alphaGroup);
        }
      }
      return drawn;
    } finally {
      clearDrawState();
    }
  }

  /** Draw a single bundle's fill pass into the currently-bound framebuffer
   *  with caller-supplied per-instance state. A plain fill lands there; a group, a
   *  blend leaf, a filter or an incremental stroke ends on the canvas, and the
   *  binding is not restored afterward. Skips the frame-lifecycle
   *  auto-clear: the caller owns the outer state (viewport, clear, blend,
   *  depth); Mantle owns the inner fill-pass setup. Each call is a fresh
   *  per-asset bind so per-bundle texture state never leaks across instances.
   *  Same option semantics as drawBundle (bundle/handle auto-unwrapped). */
  function drawInstance(bundle, opts) {
    if (R._contextLost) return;
    if (!bundle) return;
    const wasInFrame = R._inFrame;
    // Outside a frame this is the frame's entry, so it ticks (handle.draw does the same): drawBundle, below, runs
    // in-frame and would only count the frame.
    if (!wasInFrame) warmTick();
    // Flip _inFrame=true so the call composes with the caller's frame. Only that flag is restored below: the
    // framebuffer binding is not (see the doc comment).
    R._inFrame = true;
    try {
      drawBundle(bundle, opts);
    } finally {
      R._inFrame = wasInFrame;
    }
  }

  R.drawBundle = drawBundle;
  R.drawBundleInstanced = drawBundleInstanced;
  R.drawInstance = drawInstance;
  R.bundleDrawMatrix = bundleDrawMatrixFor;
  R._resolveDstRect = (target, opts) => resolveDstRect(R, target, opts);
}
