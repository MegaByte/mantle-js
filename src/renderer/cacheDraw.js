// cacheDraw.js — static cache bake and blit helpers.

import { createStaticCache, borrowSharedGroupTarget } from './staticCache.js';
import { diagFlags, diagPushCacheDump } from '../core/diagnostics.js';
import { inspect, Features } from '../bundle/featureSet.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachCacheDraw(R) {
    // _cacheBakingNow (bake re-entrancy guard) and _cacheFrameSeq live on R:
    // renderer.js's render() reads/increments them, so the bake here must
    // write/read the same R properties.

    const _cacheFeatureInfo = new WeakMap();
    const VIEWPORT_WINDOW_INCOMPATIBLE = Features.NonScalingSize
      | Features.NonRotation | Features.FixedPosition;
    function _featureInfo(bundle) {
      if (!bundle || typeof bundle !== 'object') {
        return { viewportWindow: true, sharedGroup: true, fixedPosition: false };
      }
      const gen = bundle._geomGen | 0;
      const prior = _cacheFeatureInfo.get(bundle);
      if (prior && prior.gen === gen) return prior;
      const flags = inspect(bundle);
      const info = {
        gen,
        viewportWindow: (flags & VIEWPORT_WINDOW_INCOMPATIBLE) === 0n,
        sharedGroup: (flags & Features.FixedPosition) === 0n,
        fixedPosition: (flags & Features.FixedPosition) !== 0n,
      };
      _cacheFeatureInfo.set(bundle, info);
      return info;
    }

    function _allocCacheFbo(rtW, rtH) {
      const w = Math.max(16, rtW | 0);
      const h = Math.max(16, rtH | 0);
      const tex = R.gl.createTexture();
      R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
      R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA8, w, h, 0, R.gl.RGBA, R.gl.UNSIGNED_BYTE, null);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.LINEAR);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.LINEAR);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
      const fbo = R.gl.createFramebuffer();
      R.bindFb(R.gl.FRAMEBUFFER, fbo);
      R.gl.framebufferTexture2D(R.gl.FRAMEBUFFER, R.gl.COLOR_ATTACHMENT0,
        R.gl.TEXTURE_2D, tex, 0);
      // DEPTH + STENCIL are REQUIRED, not optional. The bake re-enters the normal
      // render into this FBO, and within a bundle the fill uses depth to sequence
      // shape z-order and stencil for clip/mask coverage (see _renderCanvasInner).
      // A colour-only RT makes both silently no-op, so the fill never resolves: the
      // bake captures the cover-quad EDGES with no fill inside them (a curved shape
      // bakes as bare outlines / stray slivers). It renders correctly to the canvas
      // — which has depth+stencil — and via LB, which needs neither, so this only
      // ever surfaced through a cached bake of a Slug-filled bundle.
      const rb = R.gl.createRenderbuffer();
      R.gl.bindRenderbuffer(R.gl.RENDERBUFFER, rb);
      R.gl.renderbufferStorage(R.gl.RENDERBUFFER, R.gl.DEPTH24_STENCIL8, w, h);
      R.gl.framebufferRenderbuffer(R.gl.FRAMEBUFFER, R.gl.DEPTH_STENCIL_ATTACHMENT,
        R.gl.RENDERBUFFER, rb);
      R.gl.bindRenderbuffer(R.gl.RENDERBUFFER, null);
      R.bindFb(R.gl.FRAMEBUFFER, null);
      return { tex, fbo, rb, rtW: w, rtH: h };
    }

    function _freeSharedTarget(g) {
      if (g.sharedTex) { R.gl.deleteTexture(g.sharedTex); g.sharedTex = null; }
      if (g.sharedFbo) { R.gl.deleteFramebuffer(g.sharedFbo); g.sharedFbo = null; }
      if (g.sharedRb) { R.gl.deleteRenderbuffer(g.sharedRb); g.sharedRb = null; }
    }

    function _setHandleInstanceGroup(h, key) {
      const oldKey = h.cache.instanceGroupKey;
      const nextKey = key || null;
      if (oldKey === nextKey) return;
      // A non-group target belongs only to this handle. Group targets are
      // released by the cache registry when the membership changes.
      if (!oldKey) {
        if (h.cacheTex) R.gl.deleteTexture(h.cacheTex);
        if (h.cacheFbo) R.gl.deleteFramebuffer(h.cacheFbo);
        if (h.cacheRb) R.gl.deleteRenderbuffer(h.cacheRb);
      }
      h.cacheTex = null;
      h.cacheFbo = null;
      h.cacheRb = null;
      h.cacheRtW = 0;
      h.cacheRtH = 0;
      h._sharedCacheBorrowed = false;
      h.cache.setInstanceGroup(nextKey);
    }
  
    // Clear every 2D sampler unit before a texture becomes a render target: sampling a
    // texture that is also attached to the bound framebuffer is a feedback loop, and the
    // driver DROPS the draw (GL_INVALID_OPERATION).
    //
    // Avoid getParameter here: drivers may flush the pipeline for state queries.
    // Unbind all 16 units unconditionally; the
    // bindings we drop are re-established anyway — the bake re-enters the fill pass with
    // fillPassAssetDirty set, which rebinds the bundle's textures from scratch.
    const _MAX_UNITS9 = 16;
    function _unbindTexEverywhere(tex) {
      if (!tex) return;
      for (let u9 = 0; u9 < _MAX_UNITS9; u9++) {
        R.gl.activeTexture(R.gl.TEXTURE0 + u9);
        R.gl.bindTexture(R.gl.TEXTURE_2D, null);
      }
      R.gl.activeTexture(R.gl.TEXTURE0);
    }

    function _cacheEnsureFbo(rtW, rtH) {
      const h = R._handle;
      if (!h || !h.cache) return false;
      rtW = Math.max(16, rtW | 0);
      rtH = Math.max(16, rtH | 0);
      const key = h.cache.instanceGroupKey;
      if (key && h.cache.resolvedLevel === R.CacheLevel.SharedGroup) {
        const borrowed = borrowSharedGroupTarget(key, h.cache._cacheState, rtW, rtH, _allocCacheFbo);
        if (!borrowed) return false;
        // A regrow retires the previous shared RT — free it here (the
        // registry is GL-free and hands the handles back).
        if (borrowed.group && borrowed.group.retired) {
          const ret9 = borrowed.group.retired;
          borrowed.group.retired = null;
          if (ret9.tex) R.gl.deleteTexture(ret9.tex);
          if (ret9.fbo) R.gl.deleteFramebuffer(ret9.fbo);
          if (ret9.rb) R.gl.deleteRenderbuffer(ret9.rb);
        }
        h.cacheTex = borrowed.tex;
        h.cacheFbo = borrowed.fbo;
        h.cacheRb = borrowed.rb;
        h.cacheRtW = borrowed.rtW;
        h.cacheRtH = borrowed.rtH;
        h._sharedCacheBorrowed = true;
        // Adopt the GROUP's bake worldMatrix and recompute this member's blit
        // delta against it: the shared RT holds the owner's raster, so this
        // member must shift the blit by (its translation − the owner's).
        // Without this the borrower blitted at zero delta and its card landed
        // on the owner's spot (alternate group members rendered invisible).
        if (borrowed.bakeWm) {
          const wm9 = R.draw.worldM;
          const m09 = wm9 ? wm9[0] : 1, m19 = wm9 ? wm9[1] : 0, m39 = wm9 ? wm9[3] : 0, m49 = wm9 ? wm9[4] : 1;
          const bw9 = borrowed.bakeWm;
          // Borrowing is only valid at the SAME linear part (the raster is
          // scale/rotation-specific); a mismatched member falls through to
          // its own bake instead.
          if (bw9[0] !== m09 || bw9[1] !== m19 || bw9[2] !== m39 || bw9[3] !== m49) return false;
          h.cacheBakeWm = bw9.slice();
          const tx9 = wm9 ? wm9[6] : 0, ty9 = wm9 ? wm9[7] : 0;
          h.cacheBlitDx = tx9 - bw9[4];
          h.cacheBlitDy = ty9 - bw9[5];
        }
        return true;
      }
      h._sharedCacheBorrowed = false;
      if (h.cacheTex && h.cacheRtW === rtW && h.cacheRtH === rtH) return true;
      if (h.cacheTex) { R.gl.deleteTexture(h.cacheTex); h.cacheTex = null; }
      if (h.cacheFbo) { R.gl.deleteFramebuffer(h.cacheFbo); h.cacheFbo = null; }
      if (h.cacheRb) { R.gl.deleteRenderbuffer(h.cacheRb); h.cacheRb = null; }
      const created = _allocCacheFbo(rtW, rtH);
      h.cacheTex = created.tex;
      h.cacheFbo = created.fbo;
      h.cacheRb  = created.rb;
      h.cacheRtW = created.rtW;
      h.cacheRtH = created.rtH;
      return true;
    }
  
    // FNV-1a over the per-draw visual state the bake captures BESIDES the
    // worldMatrix: overrides (node transform/fill animations ride in here),
    // alpha, colorMatrix, palette channel. A cached bundle whose overrides
    // animate must invalidate — a card sliding via a node-transform override
    // keeps worldM unchanged, so the tick would keep blitting an RT baked
    // while the element was parked off-screen (blank every other card).
    function _drawStateHash() {
      let h9 = 0x811c9dc5 | 0;
      const mix = (v9) => { h9 = (h9 ^ (v9 | 0)) * 0x01000193 | 0; };
      const mixNum = (n9) => { if (typeof n9 === 'number') { mix(n9 * 8192); return; } mix(0x9e3779b9); };
      const walk = (o9, depth9) => {
        if (o9 === null || o9 === undefined || depth9 > 4) return;
        if (typeof o9 === 'number') { mixNum(o9); return; }
        if (typeof o9 === 'boolean') { mix(o9 ? 1 : 2); return; }
        if (typeof o9 === 'string') { for (let i9 = 0; i9 < o9.length && i9 < 24; i9++) mix(o9.charCodeAt(i9)); return; }
        if (Array.isArray(o9)) { for (let i9 = 0; i9 < o9.length; i9++) mixNum(o9[i9]); return; }
        if (ArrayBuffer.isView(o9)) {
          if (o9 instanceof DataView) { for (let i9 = 0; i9 < o9.byteLength; i9++) mix(o9.getUint8(i9)); return; }
          const view9 = /** @type {{ length: number, [i: number]: number }} */ (/** @type {unknown} */ (o9));
          for (let i9 = 0; i9 < view9.length; i9++) mixNum(view9[i9]);
          return;
        }
        if (typeof o9 === 'object') { for (const k9 in o9) { for (let i9 = 0; i9 < k9.length && i9 < 16; i9++) mix(k9.charCodeAt(i9)); walk(o9[k9], depth9 + 1); } }
      };
      walk(R.draw.overrides, 0);
      mixNum(R.draw.alpha);
      walk(R.draw.colorMatrix, 0);
      walk(R.draw.colorMatrixOffset, 0);
      mix(R.draw.paletteChannel | 0);
      walk(R.draw.channelLerp, 0);
      // Palette + external clip are baked into the RT too. The palette walk
      // covers LUT swaps AND in-place LUT mutation; the clip texture is a
      // WebGLTexture (opaque to the walker) so hash its IDENTITY — without
      // these, clearNodeClip()/palette changes kept blitting the stale bake.
      walk(R.draw.palette, 0);
      mix(_texIdOf(R.draw.extClipTex));
      mix(R.draw.extClipMode | 0);
      return h9;
    }
    // Stable per-texture ids for hashing (identity, not content).
    const _texIds9 = new WeakMap();
    let _texIdNext9 = 1;
    function _texIdOf(t9) {
      if (!t9) return 0;
      let id9 = _texIds9.get(t9);
      if (!id9) { id9 = _texIdNext9++; _texIds9.set(t9, id9); }
      return id9;
    }
    function _cacheTick() {
      const h = R._handle;
      if (!h || !h.cache) return R.CacheLevel.None;
      // COST GATE: the cached path (RT upkeep + full-canvas blit + the tick
      // machinery) must measurably BEAT the direct render, or caching is pure
      // overhead — a light scene idles measurably below its direct rate while
      // the cache blits it. Both modes' frame cadences ride EMAs sampled in
      // render(); while the cached path isn't clearly cheaper, stay direct,
      // re-probing rarely (the scene may grow into caching).
      {
        // COST PROBE (applies to forced strategies too — forcing predates the
        // gate, and a forced cache can be the very one losing the frames):
        // phase 0 = CACHED first (~60 frames; tests that assert bake validity
        // on the first frames stay green), phase 1 = DIRECT (~60 frames),
        // phase 2 = the faster cadence WINS, slow-loser re-probes rarely.
        // Frame-interval EMAs are fed by render(): the cached path's cost is
        // GPU-side (RT switches, blit sync), invisible to JS timers.
        const ph9 = h._cacheProbePhase | 0, n9 = (h._cacheProbeN = (h._cacheProbeN | 0) + 1);
        if (ph9 === 0) {                            // measuring CACHED (fall through)
          if (n9 >= 60) { h._cacheProbePhase = 1; h._cacheProbeN = 0; }
        } else if (ph9 === 1) {                     // measuring DIRECT
          if (n9 >= 60) { h._cacheProbePhase = 2; h._cacheProbeN = 0; }
          return R.CacheLevel.None;
        } else {
          const dc9 = h._directCostEma, cc9 = h._cachedCostEma;
          if (cc9 !== undefined && dc9 !== undefined && cc9 > dc9 * 1.03) {
            // cached measured SLOWER → stay direct; re-probe once in a while
            if (n9 >= 3600) { h._cacheProbePhase = 0; h._cacheProbeN = 0; h._cachedCostEma = undefined; h._directCostEma = undefined; }
            return R.CacheLevel.None;
          }
        }
      }
      const [cw, ch] = R.viewportSize();
      const animatorActive = h.cacheHooks && h.cacheHooks.isAnimatorActive
                           ? !!h.cacheHooks.isAnimatorActive() : false;
      const morphActive    = h.cacheHooks && h.cacheHooks.isMorphActive
                           ? !!h.cacheHooks.isMorphActive()    : false;
      // The bake RENDERS the bundle at the per-draw worldMatrix into the cache RT,
      // so a cached bundle that MOVES (e.g. a pause-slide tween animating the
      // node's transform.offset) must not keep blitting the RT at the BAKED
      // position. But a pure TRANSLATION doesn't change the rasterized pixels —
      // only WHERE they land — so the RT stays valid: we reuse it and shift the
      // blit by the translation delta (see `_cacheBlitToCanvas`). Only a change to
      // the LINEAR part (scale/rotation/skew) re-rasterizes coverage, so that —
      // and only that — invalidates + re-bakes. `footprintW/H` tracks the VIEWPORT
      // only, so the matrix delta is otherwise invisible to the state machine.
      const wm = R.draw.worldM; // column-major mat3, or null (identity)
      const m0 = wm ? wm[0] : 1, m1 = wm ? wm[1] : 0, m3 = wm ? wm[3] : 0, m4 = wm ? wm[4] : 1;
      const tx = wm ? wm[6] : 0, ty = wm ? wm[7] : 0;
      const featureInfo = _featureInfo(h.bundle);
      const wasViewportWindow = h.cache.resolvedLevel === R.CacheLevel.ViewportWindow;
      const bk = h.cacheBakeWm; // [m0,m1,m3,m4,tx,ty] captured at bake, or undefined
      h.cacheBlitDx = 0;
      h.cacheBlitDy = 0;
      if (bk) {
        if (bk[0] !== m0 || bk[1] !== m1 || bk[2] !== m3 || bk[3] !== m4) {
          h.cache.invalidate();
          h.cacheBakeWm = undefined;
        } else if (wasViewportWindow) {
          // The window target has a margin around the visible viewport. Reuse it while
          // translation stays inside that margin; a larger pan recentres by baking.
          const margin = h.cache.viewportWindowMarginPixels;
          const panX = (tx - bk[4]) * cw * 0.5;
          const panY = (ty - bk[5]) * ch * 0.5;
          if (Math.abs(panX) > margin || Math.abs(panY) > margin) {
            h.cache.invalidate();
            h.cacheBakeWm = undefined;
          } else {
            h.cacheBlitDx = tx - bk[4];
            h.cacheBlitDy = ty - bk[5];
          }
        } else if (featureInfo.fixedPosition && (tx !== bk[4] || ty !== bk[5])) {
          // fixed-position shapes cancel the world translation. Moving the
          // entire cached raster would move those shapes too, so re-bake.
          h.cache.invalidate();
          h.cacheBakeWm = undefined;
        } else {
          // WholeAsset/SharedGroup translation-only: reuse the target and offset the blit.
          // but ONLY if the bake position left the bundle FULLY inside the
          // viewport. An RT baked while (partly) off-screen holds a CLIPPED
          // raster; shifting it back on-screen shows the clip (a parked card
          // baked at tx=2 is a fully blank RT slid back to center).
          let clipped9 = false;
          if ((tx !== bk[4] || ty !== bk[5]) && h.bundle && h.bundle.globalBBox) {
            // uWorldM applies in CLIP space AFTER the em→NDC fit
            // (mantle.vert: plane = ((em−gbb.xy)/gbb.zw·2−1)·canvasAR,
            // y-flipped) — the bbox corners land exactly at (±arSx,
            // ∓arSy), NOT at their raw em coordinates (globalBBox is
            // x,y,w,h). Feeding em coords through the matrix flagged
            // every translated bake "clipped" (per-frame re-bake thrash
            // on pure-translation tweens) and could pass genuinely
            // clipped ones.
            const bb9 = h.bundle.globalBBox;
            const [arSx9, arSy9] = R.arScale(bb9, cw, ch);
            for (const [px9, py9] of [[-arSx9, -arSy9], [arSx9, -arSy9], [-arSx9, arSy9], [arSx9, arSy9]]) {
              const nx9 = bk[0] * px9 + bk[2] * py9 + bk[4];
              const ny9 = bk[1] * px9 + bk[3] * py9 + bk[5];
              if (nx9 < -1.001 || nx9 > 1.001 || ny9 < -1.001 || ny9 > 1.001) { clipped9 = true; break; }
            }
          }
          if (clipped9) {
            h.cache.invalidate();
            h.cacheBakeWm = undefined;
          } else {
            h.cacheBlitDx = tx - bk[4];
            h.cacheBlitDy = ty - bk[5];
          }
        }
      }
      let dhUnstable9 = false;
      {
        const dh9 = _drawStateHash();
        // HYSTERESIS: a draw-state that keeps changing (an animating override /
        // alpha pulse) must not bake-thrash — invalidate+rebake every frame is
        // strictly worse than drawing direct (a full-canvas re-bake loop costs
        // frames every tick). Treat an unstable state as an active
        // animator (direct draw); bake again only once it holds for 2 ticks.
        dhUnstable9 = h._lastSeenDrawHash !== undefined && h._lastSeenDrawHash !== dh9;
        h._dhStableRuns = dhUnstable9 ? 0 : ((h._dhStableRuns | 0) + 1);
        h._lastSeenDrawHash = dh9;
        if (h.cacheBakeDrawHash !== undefined && h.cacheBakeDrawHash !== dh9 && h.cache.isCacheValid) {
          h.cache.invalidate();   // overrides/alpha/palette changed since bake → stale raster
        }
        h._pendingDrawHash = dh9;
      }
      // CANVAS RESIZE. The raster was baked FOR a specific drawing-buffer size: the RT
      // is that size, and the em→NDC projection folds in the canvas aspect (arScale).
      // Nothing above notices a resize, so the stale raster kept being blitted:
      //   • canvas GROWS  → the tick says "valid, just blit", no re-bake happens, and a
      //                     smaller RT is stretched over a bigger canvas — a visibly
      //                     LOW-RESOLUTION, UPSCALED card.
      //   • canvas SHRINKS→ _cacheEnsureFbo keeps the oversized RT (rtW >= needed) and
      //                     the blit squashes it — wrong scale, and the top clipped.
      // An ASPECT change corrupts it even at equal pixel count. Reported from a VS Code
      // embedded browser, whose panel resizes after load; a fixed viewport never does,
      // which is why it hid from every headless capture.
      if (h.cache.isCacheValid
          && (h.cacheBakeCw !== undefined && (h.cacheBakeCw !== cw || h.cacheBakeCh !== ch))) {
        h.cache.invalidateLocal();
        h.cacheBakeWm = undefined;
      }
      // Project the fitted bbox through the linear transform. Auto uses this to
      // identify giant assets, while ForceViewportWindow bypasses the selector.
      let footprintW = cw, footprintH = ch;
      if (h.bundle && h.bundle.globalBBox) {
        const [sx, sy] = R.arScale(h.bundle.globalBBox, cw, ch);
        footprintW = (Math.abs(m0) * sx + Math.abs(m3) * sy) * cw;
        footprintH = (Math.abs(m1) * sx + Math.abs(m4) * sy) * ch;
      }
      h.cache.tick({
        hasAsset:        !!h.bundle,
        animatorActive: animatorActive || dhUnstable9 || (h._dhStableRuns | 0) < 2,
        morphActive,
        footprintW,
        footprintH,
        viewportW:       cw,
        viewportH:       ch,
        // External clips are mutable screen-space textures; their contents
        // cannot be represented by a content-raster cache key.
        cacheCompatible: !(R.draw.extClipTex && R.draw.extClipMode > 0),
        // The larger viewport is implemented with a compensating world matrix.
        // SVG vector effects intentionally cancel parts of that matrix.
        viewportWindowCompatible: featureInfo.viewportWindow,
        // A shared raster is translated between members; fixed-position shapes
        // intentionally do not follow that translation.
        sharedGroupCompatible: featureInfo.sharedGroup,
      });
      return h.cache.resolvedLevel;
    }
  
    // Bake-then-blit for any resolved cache level.
    // Returns true on success; false on any failure (caller falls
    // back to live render).
    function _cacheBakeAndBlit() {
      if (!R.cacheBlitProg) return false;
      const h = R._handle;
      if (!h || !h.cache) return false;
      // Don't bake NOTHING. Normally Slug is always drawable so a bake has content;
      // but in LB-only mode ('only') there is no Slug fallback, so a bundle whose
      // analytic mesh hasn't landed yet would bake an empty RT. Skip the bake until
      // its LB is ready (caller falls back to a live draw); the cache never holds a
      // blank frame, and once LB lands the bake captures it. Per the LB>Slug>nothing
      // ladder: cache only Slug-or-LB, never nothing.
      if (!R._lbSlugFallback && h.bundle && R._lbBundleReady && !R._lbBundleReady(h.bundle)) return false;
      const [cw, ch] = R.viewportSize();
      const isViewportWindow = h.cache.resolvedLevel === R.CacheLevel.ViewportWindow;
      const margin = isViewportWindow
        ? Math.max(0, h.cache.viewportWindowMarginPixels | 0)
        : 0;
      const rtW = cw + margin * 2;
      const rtH = ch + margin * 2;
      // WholeAsset/SharedGroup must not bake content that is not fully on-screen. Their
      // viewport-sized target would hold a clipped raster and later treat it as complete.
      // ViewportWindow deliberately captures only the viewport plus its slack margin.
      if (!isViewportWindow && h.bundle && h.bundle.globalBBox) {
        const wm0 = R.draw.worldM;
        const a0 = wm0 ? wm0[0] : 1, b0 = wm0 ? wm0[1] : 0;
        const c0 = wm0 ? wm0[3] : 0, d0 = wm0 ? wm0[4] : 1;
        const e0 = wm0 ? wm0[6] : 0, f0 = wm0 ? wm0[7] : 0;
        const [sx0, sy0] = R.arScale(h.bundle.globalBBox, cw, ch);
        for (const [px0, py0] of [[-sx0, -sy0], [sx0, -sy0], [-sx0, sy0], [sx0, sy0]]) {
          const nx0 = a0 * px0 + c0 * py0 + e0;
          const ny0 = b0 * px0 + d0 * py0 + f0;
          if (nx0 < -1.001 || nx0 > 1.001 || ny0 < -1.001 || ny0 > 1.001) return false;   // off-screen → draw live
        }
      }
      if (!_cacheEnsureFbo(rtW, rtH)) return false;

      const savedWorld = R.draw.worldM;
      const savedViewport = R._explicitViewport;
      if (isViewportWindow) {
        // Render through the full larger framebuffer so gl_FragCoord, AA dilation,
        // masks, filters, and LB coverage all see its real dimensions. Compensate
        // the world matrix for the changed aspect fit so the original canvas maps
        // 1:1 into the centred cw×ch window, with `margin` pixels around it.
        const bbox = h.bundle && h.bundle.globalBBox;
        let canvasSx = 1, canvasSy = 1, targetSx = 1, targetSy = 1;
        if (bbox) {
          [canvasSx, canvasSy] = R.arScale(bbox, cw, ch);
          [targetSx, targetSy] = R.arScale(bbox, rtW, rtH);
        }
        const a = savedWorld ? savedWorld[0] : 1;
        const b = savedWorld ? savedWorld[1] : 0;
        const c = savedWorld ? savedWorld[3] : 0;
        const d = savedWorld ? savedWorld[4] : 1;
        const e = savedWorld ? savedWorld[6] : 0;
        const f = savedWorld ? savedWorld[7] : 0;
        const dx = cw / rtW, dy = ch / rtH;
        const qx = targetSx ? canvasSx / targetSx : 1;
        const qy = targetSy ? canvasSy / targetSy : 1;
        R.draw.worldM = new Float32Array([
          dx * a * qx, dy * b * qx, 0,
          dx * c * qy, dy * d * qy, 0,
          dx * e,      dy * f,      1,
        ]);
        R._explicitViewport = [rtW, rtH];
      }
  
      // Bake: bind cache FBO + clear, then re-enter render() as if it
      // were a normal canvas draw. The re-entry guard prevents an
      // infinite loop and skips the cache tick on the inner call.
      let _bakeRouted = false;
      // FEEDBACK LOOP: the blit samples h.cacheTex, and it stays bound to that
      // sampler unit afterwards. This bake is about to attach the SAME texture as
      // the cache FBO's colour target — a texture that is simultaneously attached
      // to the draw framebuffer and bound to a unit the program samples makes the
      // whole draw GL_INVALID_OPERATION, and the driver DROPS it. The bake then
      // resolves to an empty (or half-written) RT, which gets blitted as a valid
      // cache: the shape's fill silently disappears. Unbind every unit still
      // holding the cache texture before it becomes the render target.
      _unbindTexEverywhere(h.cacheTex);
      R.bindFb(R.gl.FRAMEBUFFER, h.cacheFbo);
      R.gl.viewport(0, 0, h.cacheRtW, h.cacheRtH);
      R.gl.disable(R.gl.SCISSOR_TEST);
      R.gl.clearColor(0, 0, 0, 0);
      R.gl.clear(R.gl.COLOR_BUFFER_BIT | R.gl.STENCIL_BUFFER_BIT | R.gl.DEPTH_BUFFER_BIT);
  
      R._cacheBakingNow = true;
      R._cacheTargetFbo = h.cacheFbo;   // LB draw sites target this instead of the canvas
      // The bake re-enters the FILL pass, whose texture rebind is gated on
      // (_lastFillPassHandle !== _handle || handle.fillPassAssetDirty). A bundle
      // that normally takes the LB route never runs the fill pass, so this
      // handle's fill-pass texture state is stale/unset — yet the gate can still
      // read "unchanged" and SKIP the rebind. The Slug band-walk then samples
      // whatever curve/band textures happen to be bound (not this bundle's), finds
      // no curves, and emits ZERO coverage on every boundary fragment: the shape
      // bakes as its occupancy-interior slab with the curved edges missing (a
      // wavy ridge bakes flat-topped). Force a full rebind for the bake.
      h.fillPassAssetDirty = true; if (R) R._fpUValid = false;
      R._lastFillPassHandle = null; R.fillPassCanvasW = 0; R.fillPassCanvasH = 0;
      try {
        // Bake through the SAME ROUTE the live draw would take. The cached blit is
        // supposed to be indistinguishable from the direct frame — it is literally
        // meant to reproduce what would otherwise be on screen. Baking via
        // _renderCanvasInner unconditionally renders SLUG, so a bundle whose live
        // path is LB got a Slug raster cached for it: the two engines differ subtly
        // in coverage/AA, so every time the cost probe alternated cached↔direct the
        // image visibly FLICKERED between them. Route the bake exactly as
        // handle.draw() does (LB draw sites already redirect into _cacheTargetFbo),
        // so cached and direct are the same pixels and switching is invisible.
        _bakeRouted = R._analyticRoute(h.bundle, { streamOnly: true });
        if (!_bakeRouted) R._renderCanvasInner();
      } finally {
        R._cacheBakingNow = false;
        R._cacheTargetFbo = null;
        R.draw.worldM = savedWorld;
        R._explicitViewport = savedViewport;
        // The bake bound ITS textures/FBO; the next live fill pass must rebind too.
        h.fillPassAssetDirty = true; if (R) R._fpUValid = false;
        R._lastFillPassHandle = null; R.fillPassCanvasW = 0; R.fillPassCanvasH = 0;
      }
  
      if (diagFlags.dumpCache) {
        try {
          const dw = h.cacheRtW, dh = h.cacheRtH;
          const px = new Uint8Array(dw * dh * 4);
          R.gl.readPixels(0, 0, dw, dh, R.gl.RGBA, R.gl.UNSIGNED_BYTE, px);
          let opaque = 0, partial = 0;
          for (let i = 3; i < px.length; i += 4) {
            if (px[i] > 250) opaque++; else if (px[i] > 4) partial++;
          }
          const cvs = new OffscreenCanvas(dw, dh);
          const c2 = cvs.getContext('2d');
          const img = c2.createImageData(dw, dh);
          for (let y = 0; y < dh; y++) {                       // GL origin is bottom-left
            const s = (dh - 1 - y) * dw * 4, d = y * dw * 4;
            img.data.set(px.subarray(s, s + dw * 4), d);
          }
          c2.putImageData(img, 0, 0);
          diagPushCacheDump({
            id: h.bundle && h.bundle.id, rt: `${dw}x${dh}`, canvas: `${cw}x${ch}`,
            lb: !!(h.bundle && Array.isArray(h.bundle._lbMeshes)),
            occ: !!(h.bundle && h.bundle.hasOccupancy), opaque, partial, routed: _bakeRouted, alpha: R.draw.alpha,
            blob: cvs.convertToBlob ? cvs.convertToBlob({ type: 'image/png' }) : null,
          });
        } catch (e) { diagPushCacheDump({ err: String(e) }); }
      }
      // Unbind cache FBO; restore default + viewport. The blit pass
      // immediately below uses the canvas viewport.
      R.bindFb(R.gl.FRAMEBUFFER, null);
      R.gl.viewport(0, 0, cw, ch);
      // Record the worldMatrix the RT was baked at: [linear a,b,c,d, tx,ty].
      // A later tick with the SAME linear part but a different translation
      // reuses this RT and offsets the blit (see _cacheTick / _cacheBlitToCanvas);
      // a different linear part invalidates and re-bakes.
      const wm = R.draw.worldM;
      h.cacheBakeWm = wm
        ? [wm[0], wm[1], wm[3], wm[4], wm[6], wm[7]]
        : [1, 0, 0, 1, 0, 0];
      h.cacheBakeCw = cw;
      h.cacheBakeCh = ch;
      h.cacheWindowMargin = margin;
      // Preserve the source rect from the bake. Recomputing it after a
      // translation is not reversible once it has been clipped by a canvas
      // edge, which made a moved filtered cache stretch to the wrong side.
      h.cacheContentRect = margin || !R._contentRectPx
        ? null : R._contentRectPx(cw, ch);
      h.cacheBakeDrawHash = h._pendingDrawHash;
      h.cache.markBaked(R._cacheFrameSeq, h.cacheBakeWm);
      h.cacheBlitDx = 0;
      h.cacheBlitDy = 0;
      return true;
    }
  
    function _cacheBlitToCanvas() {
      if (!R.cacheBlitProg) return false;
      const h = R._handle;
      if (!h || !h.cacheTex) return false;
      R.bindFb(R.gl.FRAMEBUFFER, null);
      const [cw, ch] = R.viewportSize();
      // Offset the full-screen blit by the worldMatrix TRANSLATION delta since
      // the RT was baked (0 for a stationary bundle). The RT is viewport-aligned
      // and covers NDC [-1,1]², so an NDC delta maps to pixels by (cw/2, ch/2).
      // This is what lets a cached bundle that only TRANSLATES (a pause-slide)
      // reuse its valid raster — we move WHERE it lands, not WHAT it contains.
      const margin = h.cacheWindowMargin | 0;
      const dxPx = Math.round((h.cacheBlitDx || 0) * cw / 2);
      const dyPx = Math.round((h.cacheBlitDy || 0) * ch / 2);
      // Rasterize only where the cached content actually is. Its rect is in
      // BAKE coordinates; translate that rect for the destination, then clip
      // both source and destination together. Deriving the rect at the current
      // transform is wrong near a canvas edge: the clip loses how much source
      // content sat beyond that edge.
      const sourceRect = margin ? null : h.cacheContentRect;
      let blitRect = null;
      if (sourceRect) {
        const targetX = sourceRect[0] + dxPx;
        const targetY = sourceRect[1] + dyPx;
        const x0 = Math.max(0, targetX), y0 = Math.max(0, targetY);
        const x1 = Math.min(cw, targetX + sourceRect[2]);
        const y1 = Math.min(ch, targetY + sourceRect[3]);
        if (x1 > x0 && y1 > y0) {
          blitRect = [
            x0, y0, x1 - x0, y1 - y0,
            sourceRect[0] + (x0 - targetX), sourceRect[1] + (y0 - targetY),
          ];
        }
      }
      R.gl.viewport(blitRect ? blitRect[0] : (margin ? 0 : dxPx),
                    blitRect ? blitRect[1] : (margin ? 0 : dyPx),
                    blitRect ? blitRect[2] : cw, blitRect ? blitRect[3] : ch);
      const savedDepth = R.gl.isEnabled(R.gl.DEPTH_TEST);
      const savedStencil = R.gl.isEnabled(R.gl.STENCIL_TEST);
      R.gl.disable(R.gl.DEPTH_TEST);
      R.gl.disable(R.gl.STENCIL_TEST);
      R.gl.enable(R.gl.BLEND);
      R.gl.blendEquation(R.gl.FUNC_ADD);
      // Source-over against the canvas (the canvas is unchanged from
      // a stale prior draw OR cleared by the caller). The cache RT
      // contains premultiplied RGBA from the live coverage draw.
      R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      // Clear the canvas only when we're NOT inside a beginFrame/
      // endFrame composition — the inFrame path expects accumulation.
      if (!R._inFrame) {
        R.gl.clearColor(1, 1, 1, 1);
        R.gl.clear(R.gl.COLOR_BUFFER_BIT);
      }
      R.gl.useProgram(R.cacheBlitProg);
      // vUV spans the destination viewport, so map it to the corresponding
      // source portion of the canvas-sized cache RT. (Uniforms only stick
      // after useProgram.)
      if (R.cbUInMap) {
        if (margin) {
          const panX = (h.cacheBlitDx || 0) * cw * 0.5;
          const panY = (h.cacheBlitDy || 0) * ch * 0.5;
          R.gl.uniform4f(R.cbUInMap,
            cw / h.cacheRtW, ch / h.cacheRtH,
            (margin - panX) / h.cacheRtW,
            (margin - panY) / h.cacheRtH);
        } else if (blitRect) R.gl.uniform4f(R.cbUInMap,
          blitRect[2] / cw, blitRect[3] / ch, blitRect[4] / cw, blitRect[5] / ch);
        else    R.gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);
      }
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.bindTexture(R.gl.TEXTURE_2D, h.cacheTex);
      R.gl.uniform1i(R.cbUCacheTex, 0);
      R.gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
      R.gl.bindVertexArray(R.coverVao);
      R.gl.drawArrays(R.gl.TRIANGLE_STRIP, 0, 4);
      R.gl.bindVertexArray(null);
      // Drop the cache texture off the sampler unit. Left bound, it is still
      // sampleable when a later bake attaches it as the render target — a
      // feedback loop that makes the driver drop the bake's draws entirely.
      R.gl.bindTexture(R.gl.TEXTURE_2D, null);
      // Force the next live draw to rebind asset textures — the blit
      // changed program/textures so the per-frame "skip rebind if
      // unchanged" optimization needs an explicit dirty bit.
      //
      // Setting only THIS handle's dirty flag isn't enough: the fill-pass
      // rebind gate (fillPass.js) skips the rebind whenever the NEXT fill
      // pass's handle equals R._lastFillPassHandle — which is a DIFFERENT
      // handle here (or a bake re-entry), so its own dirty flag is false and
      // it inherits this blit's clobbered program + TEXTURE0 (the cacheTex),
      // sampling the wrong texture and rendering garbage (a scene with several
      // cached handles per frame — e.g. parallax backgrounds — shows one
      // handle's bake/draw wearing another's cache: missing fill, only edges).
      // Reset the GLOBAL gate so the next fill pass of ANY handle fully rebinds.
      h.fillPassAssetDirty = true; if (R) R._fpUValid = false;
      R._lastFillPassHandle = null; R.fillPassCanvasW = 0; R.fillPassCanvasH = 0;
      // RESTORE the depth/stencil enables this blit turned off, to exactly what they
      // were. They are GLOBAL GL state and anything drawn AFTER us in the same frame
      // inherits it — including another cached handle's BAKE. Leaving DEPTH_TEST off
      // makes a later bake skip its depth resolve (blank / edges-only RT); but
      // blanket-ENABLING is just as bad, since STENCIL_TEST then comes back with a
      // stale stencilFunc from some earlier clip pass and silently rejects the next
      // draw's fragments. Restore, don't assume.
      if (savedDepth) R.gl.enable(R.gl.DEPTH_TEST); else R.gl.disable(R.gl.DEPTH_TEST);
      if (savedStencil) R.gl.enable(R.gl.STENCIL_TEST); else R.gl.disable(R.gl.STENCIL_TEST);
      return true;
    }
    function enableStaticCache(opts = {}) {
      if (!R.cacheBlitProg) {
        R.mantleWarn('[Mantle] cacheBlit shader not present; '
          + 'enableStaticCache is a no-op. Pass cacheBlitVert + '
          + 'cacheBlitFrag in shaderSources.');
        return false;
      }
      if (!R._handle) {
        R.mantleWarn('[Mantle] enableStaticCache called before setBundle. '
          + 'No-op — call after setBundle or use createBundleHandle.');
        return false;
      }
      if (R._handle.cache) {
        // Allow opt-in calls to update the strategy / hooks without
        // tearing down state — useful for animators that want to
        // switch strategies at runtime.
        if (opts.strategy != null) R._handle.cache.setStrategy(opts.strategy);
        if (opts.instanceGroupKey !== undefined) {
          _setHandleInstanceGroup(R._handle, opts.instanceGroupKey);
        }
        R._handle.cacheHooks = {
          isAnimatorActive: opts.isAnimatorActive,
          isMorphActive:    opts.isMorphActive,
        };
        return true;
      }
      R._handle.cache = createStaticCache({
        strategy: opts.strategy ?? R.CacheStrategy.Auto,
        stabilityEpsilon:       opts.stabilityEpsilon,
        stabilityPromoteFrames: opts.stabilityPromoteFrames,
        stabilityDemoteFrames:  opts.stabilityDemoteFrames,
        instanceGroupKey:       opts.instanceGroupKey ?? null,
        viewportWindowGiantAssetFactor: opts.viewportWindowGiantAssetFactor,
        viewportWindowMarginPixels: opts.viewportWindowMarginPixels,
        groupScope: R.gl,
        releaseSharedTarget: _freeSharedTarget,
      });
      R._handle.cacheHooks = {
        isAnimatorActive: opts.isAnimatorActive,
        isMorphActive:    opts.isMorphActive,
      };
      return true;
    }
  
    function setInstanceGroup(key) {
      if (!R._handle || !R._handle.cache) {
        R.mantleWarn('[Mantle] setInstanceGroup called before enableStaticCache.');
        return;
      }
      _setHandleInstanceGroup(R._handle, key);
    }
  
    function disableStaticCache() {
      const h = R._handle;
      if (!h) return;
      // A ForceSharedGroup member aliases the group target.
      // deleting them here blanked every other member and left the
      // registry handing out the dead texture. Route through the group
      // release (mirrors handle.dispose); only sole ownership frees GL.
      if (h.cache && h.cache.instanceGroupKey) {
        h.cache.dispose();
        h.cacheTex = null;
        h.cacheFbo = null;
        h.cacheRb = null;
        h._sharedCacheBorrowed = false;
      } else {
        if (h.cache) h.cache.dispose();
        if (h.cacheTex) { R.gl.deleteTexture(h.cacheTex); h.cacheTex = null; }
        if (h.cacheFbo) { R.gl.deleteFramebuffer(h.cacheFbo); h.cacheFbo = null; }
        if (h.cacheRb) { R.gl.deleteRenderbuffer(h.cacheRb); h.cacheRb = null; }
      }
      h.cache = null;
      h.cacheHooks = null;
      h.cacheRtW = 0;
      h.cacheRtH = 0;
      h.cacheBakeCw = undefined;
      h.cacheBakeCh = undefined;
    }
  
    function invalidateStaticCache() {
      if (R._handle && R._handle.cache) R._handle.cache.invalidate();
    }
  R._allocCacheFbo = _allocCacheFbo;
  R._cacheEnsureFbo = _cacheEnsureFbo;
  R._cacheTick = _cacheTick;
  R._cacheBakeAndBlit = _cacheBakeAndBlit;
  R._cacheBlitToCanvas = _cacheBlitToCanvas;
  R.enableStaticCache = enableStaticCache;
  R.setInstanceGroup = setInstanceGroup;
  R.disableStaticCache = disableStaticCache;
  R.invalidateStaticCache = invalidateStaticCache;
  R._cacheBakingNow = false;
  R._cacheFrameSeq = 0;
}
