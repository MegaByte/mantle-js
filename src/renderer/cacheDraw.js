// cacheDraw.js — static cache blit, A1/A3 bake trigger helpers.

import { createStaticCache, Strategy as CacheStrategy, Level as CacheLevel, Reason as CacheReason, borrowA3GroupRt } from './staticCache.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachCacheDraw(R) {
    // _cacheBakingNow (bake re-entrancy guard) and _cacheFrameSeq live on R:
    // renderer.js's render() reads/increments them, so the bake here must
    // write/read the same R properties.

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
      R.bindFb(R.gl.FRAMEBUFFER, null);
      return { tex, fbo, rtW: w, rtH: h };
    }
  
    function _cacheEnsureFbo(rtW, rtH) {
      const h = R._handle;
      if (!h || !h.cache) return false;
      const key = h.cache.instanceGroupKey;
      if (key && h.cache.resolvedLevel === R.CacheLevel.A3) {
        const borrowed = borrowA3GroupRt(key, h.cache._cacheState, rtW, rtH, _allocCacheFbo);
        if (!borrowed) return false;
        h.cacheTex = borrowed.tex;
        h.cacheFbo = borrowed.fbo;
        h.cacheRtW = borrowed.rtW;
        h.cacheRtH = borrowed.rtH;
        h._a3Borrowed = true;
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
      h._a3Borrowed = false;
      if (h.cacheTex && h.cacheRtW >= rtW && h.cacheRtH >= rtH) return true;
      if (h.cacheTex) { R.gl.deleteTexture(h.cacheTex); h.cacheTex = null; }
      if (h.cacheFbo) { R.gl.deleteFramebuffer(h.cacheFbo); h.cacheFbo = null; }
      const created = _allocCacheFbo(rtW, rtH);
      h.cacheTex = created.tex;
      h.cacheFbo = created.fbo;
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
      return h9;
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
      const bk = h.cacheBakeWm; // [m0,m1,m3,m4,tx,ty] captured at bake, or undefined
      h.cacheBlitDx = 0;
      h.cacheBlitDy = 0;
      if (bk) {
        if (bk[0] === m0 && bk[1] === m1 && bk[2] === m3 && bk[3] === m4) {
          // Translation-only (or identical): reuse the RT, offset the blit —
          // but ONLY if the bake position left the bundle FULLY inside the
          // viewport. An RT baked while (partly) off-screen holds a CLIPPED
          // raster; shifting it back on-screen shows the clip (a parked card
          // baked at tx=2 is a fully blank RT slid back to center).
          let clipped9 = false;
          if ((tx !== bk[4] || ty !== bk[5]) && h.bundle && h.bundle.globalBBox) {
            const bb9 = h.bundle.globalBBox;
            for (const [ex9, ey9] of [[bb9[0], bb9[1]], [bb9[2], bb9[1]], [bb9[0], bb9[3]], [bb9[2], bb9[3]]]) {
              const nx9 = bk[0] * ex9 + bk[2] * ey9 + bk[4];
              const ny9 = bk[1] * ex9 + bk[3] * ey9 + bk[5];
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
        } else {
          // Linear part changed → coverage differs → re-bake at the new transform.
          h.cache.invalidate();
          h.cacheBakeWm = undefined;
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
      h.cache.tick({
        hasAsset:        !!h.bundle,
        animatorActive: animatorActive || dhUnstable9 || (h._dhStableRuns | 0) < 2,
        morphActive,
        footprintW:      cw,
        footprintH:      ch,
        viewportW:       cw,
        viewportH:       ch,
      });
      return h.cache.resolvedLevel;
    }
  
    // Bake-then-blit. Called from render() when cache says A1.
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
      if (!_cacheEnsureFbo(cw, ch)) return false;
  
      // Bake: bind cache FBO + clear, then re-enter render() as if it
      // were a normal canvas draw. The re-entry guard prevents an
      // infinite loop and skips the cache tick on the inner call.
      R.bindFb(R.gl.FRAMEBUFFER, h.cacheFbo);
      R.gl.viewport(0, 0, h.cacheRtW, h.cacheRtH);
      R.gl.disable(R.gl.SCISSOR_TEST);
      R.gl.clearColor(0, 0, 0, 0);
      R.gl.clear(R.gl.COLOR_BUFFER_BIT | R.gl.STENCIL_BUFFER_BIT | R.gl.DEPTH_BUFFER_BIT);
  
      R._cacheBakingNow = true;
      R._cacheTargetFbo = h.cacheFbo;   // LB draw sites target this instead of the canvas
      try {
        R._renderCanvasInner();
      } finally {
        R._cacheBakingNow = false;
        R._cacheTargetFbo = null;
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
      h.cacheBakeDrawHash = h._pendingDrawHash;
      h.cache.markBaked(R._cacheFrameSeq, h.cacheBakeWm); // frame counter + bake wm for the A3 group
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
      const dxPx = Math.round((h.cacheBlitDx || 0) * cw / 2);
      const dyPx = Math.round((h.cacheBlitDy || 0) * ch / 2);
      R.gl.viewport(dxPx, dyPx, cw, ch);
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
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.bindTexture(R.gl.TEXTURE_2D, h.cacheTex);
      R.gl.uniform1i(R.cbUCacheTex, 0);
      R.gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
      R.gl.bindVertexArray(R.coverVao);
      R.gl.drawArrays(R.gl.TRIANGLE_STRIP, 0, 4);
      R.gl.bindVertexArray(null);
      // Force the next live draw to rebind asset textures — the blit
      // changed program/textures so the per-frame "skip rebind if
      // unchanged" optimization needs an explicit dirty bit.
      h.fillPassAssetDirty = true;
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
          R._handle.cache.setInstanceGroup(opts.instanceGroupKey);
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
      R._handle.cache.setInstanceGroup(key);
    }
  
    function disableStaticCache() {
      if (!R._handle) return;
      R._handle.cache = null;
      R._handle.cacheHooks = null;
      if (R._handle.cacheTex) { R.gl.deleteTexture(R._handle.cacheTex); R._handle.cacheTex = null; }
      if (R._handle.cacheFbo) { R.gl.deleteFramebuffer(R._handle.cacheFbo); R._handle.cacheFbo = null; }
      R._handle.cacheRtW = 0;
      R._handle.cacheRtH = 0;
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
