// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { hasTrackedOverrideRevision } from '../core/overrideRevision.js';
import { deleteGlResource, resourceScope, trackGlResource } from './contextResources.js';
// cacheDraw.js — static cache bake and blit helpers.

import { createStaticCache, borrowSharedGroupTarget } from './staticCache.js';
import { diagFlags, diagPushCacheDump } from '../core/diagnostics.js';
import { inspect, Features } from '../bundle/featureSet.js';
import { bundleBlendsBackdrop } from './bundle.js';

/** Work tokens for one packed mesh. Packed meshes publish `vertexCount`;
 *  a Slug sentinel is not triangle work. */
export function cacheMeshTokens(m) {
  if (!m || m.slug) return 0;
  const n = m.vertexCount | 0;
  return n > 0 ? n >> 3 : 0;
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachCacheDraw(R) {
  // _cacheBakingNow (bake re-entrancy guard) and _cacheFrameSeq live on R:
  // renderer.js's render() reads/increments them, so the bake here must
  // write/read the same R properties.

  /// Has this bundle reached FULL analytic quality since `bakeFullGen` was stamped?
  ///
  /// ONE definition, used by the bake gate and published for tests, so what the raster follows
  /// cannot drift from what a test believes it follows. Deliberately a function of `_lbFullGen`
  /// ALONE: adoption batches move `_lbAdoptKey` and must NOT invalidate a bake, or the cache
  /// re-bakes its way through the whole build.
  const bakeQualityStale = (bakeFullGen, bundle) =>
    bakeFullGen !== (bundle ? bundle._lbFullGen : undefined);
  R._cacheBakeQualityStale = bakeQualityStale;

  const _cacheFeatureInfo = new WeakMap();
  const VIEWPORT_WINDOW_INCOMPATIBLE =
    Features.NonScalingSize | Features.NonRotation | Features.FixedPosition;
  function _featureInfo(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      return { viewportWindow: true, sharedGroup: true, fixedPosition: false, flags: 0n };
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
      blendsBackdrop: bundleBlendsBackdrop(bundle),
      flags,
    };
    _cacheFeatureInfo.set(bundle, info);
    return info;
  }

  // Estimate how expensive the LIVE path is relative to a viewport bake+blit.
  // Units are approximate work tokens — shapes, cover triangles, and multipass
  // features — fed to staticCache's `minLiveComplexityForCache` gate.
  //
  // Coverage appears here AND as staticCache's own `minCoverageForCache`
  // gate, deliberately: that gate is a hard floor (a small card never earns a
  // full-viewport RT), while the scaling below ranks what survives it, so a
  // half-covering asset needs more shapes than a full-screen one to win.
  function _cacheLiveComplexity(h, footprintW, footprintH, cw, ch) {
    const b = h && h.bundle;
    if (!b) return 0;
    let score = b.numShapes | 0;
    const coverFloats = b.coverQuadVboFloats || b.coverQuadFloats;
    if (coverFloats && coverFloats.length) {
      // 12 floats/vert, 6 verts/quad → triangles ≈ length/72.
      score += (coverFloats.length / 72) | 0;
    }
    if (Array.isArray(b._lbMeshes)) {
      for (let i = 0; i < b._lbMeshes.length; i++) {
        score += cacheMeshTokens(b._lbMeshes[i]);
      }
    }
    const flags = _featureInfo(b).flags;
    if ((flags & Features.Filters) !== 0n) score += 48;
    if ((flags & Features.Masks) !== 0n) score += 24;
    if ((flags & Features.Clips) !== 0n) score += 12;
    if ((flags & Features.Images) !== 0n) score += 8;
    if (h.maskRegions && h.maskRegions.length) score += h.maskRegions.length * 16;
    const vpArea = Math.max(1, (cw | 0) * (ch | 0));
    const fpArea = Math.max(0, footprintW) * Math.max(0, footprintH);
    const coverage = Math.min(1, fpArea / vpArea);
    // Fullscreen blit bandwidth is paid regardless of how small the asset is.
    // Scale the score by coverage so small cards stay live on large canvases.
    return (score * (0.25 + 0.75 * coverage)) | 0;
  }

  function _allocCacheFbo(rtW, rtH) {
    const w = Math.max(16, rtW | 0);
    const h = Math.max(16, rtH | 0);
    const tex = trackGlResource(R.gl, R.gl.createTexture(), 'staticCache');
    R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
    R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA8, w, h, 0, R.gl.RGBA, R.gl.UNSIGNED_BYTE, null);
    R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.LINEAR);
    R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.LINEAR);
    R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
    R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
    const fbo = trackGlResource(R.gl, R.gl.createFramebuffer());
    R.bindFb(R.gl.FRAMEBUFFER, fbo);
    R.gl.framebufferTexture2D(R.gl.FRAMEBUFFER, R.gl.COLOR_ATTACHMENT0, R.gl.TEXTURE_2D, tex, 0);
    // DEPTH + STENCIL are REQUIRED, not optional. The bake re-enters the normal
    // render into this FBO, and within a bundle the fill uses depth to sequence
    // shape z-order and stencil for clip/mask coverage (see _renderCanvasInner).
    // A color-only RT makes both silently no-op, so the fill never resolves: the
    // bake captures the cover-quad EDGES with no fill inside them (a curved shape
    // bakes as bare outlines / stray slivers). It renders correctly to the canvas
    // — which has depth+stencil — and via LB, which needs neither, so this only
    // ever surfaced through a cached bake of a Slug-filled bundle.
    const rb = trackGlResource(R.gl, R.gl.createRenderbuffer(), 'staticCache');
    R.gl.bindRenderbuffer(R.gl.RENDERBUFFER, rb);
    R.gl.renderbufferStorage(R.gl.RENDERBUFFER, R.gl.DEPTH24_STENCIL8, w, h);
    R.gl.framebufferRenderbuffer(
      R.gl.FRAMEBUFFER,
      R.gl.DEPTH_STENCIL_ATTACHMENT,
      R.gl.RENDERBUFFER,
      rb,
    );
    R.gl.bindRenderbuffer(R.gl.RENDERBUFFER, null);
    R.bindFb(R.gl.FRAMEBUFFER, null);
    return { tex, fbo, rb, rtW: w, rtH: h };
  }

  function _freeSharedTarget(g) {
    if (g.sharedTex) {
      deleteGlResource(R.gl, 'Texture', g.sharedTex);
      g.sharedTex = null;
    }
    if (g.sharedFbo) {
      deleteGlResource(R.gl, 'Framebuffer', g.sharedFbo);
      g.sharedFbo = null;
    }
    if (g.sharedRb) {
      deleteGlResource(R.gl, 'Renderbuffer', g.sharedRb);
      g.sharedRb = null;
    }
  }

  function _setHandleInstanceGroup(h, key) {
    const oldKey = h.cache.instanceGroupKey;
    const nextKey = key || null;
    if (oldKey === nextKey) return;
    // A non-group target belongs only to this handle. Group targets are
    // released by the cache registry when the membership changes.
    if (!oldKey) {
      if (h.cacheTex) deleteGlResource(R.gl, 'Texture', h.cacheTex);
      if (h.cacheFbo) deleteGlResource(R.gl, 'Framebuffer', h.cacheFbo);
      if (h.cacheRb) deleteGlResource(R.gl, 'Renderbuffer', h.cacheRb);
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
  const _MAX_UNITS9 = 16;
  function _unbindTexEverywhere(tex) {
    if (!tex) return;
    for (let u9 = 0; u9 < _MAX_UNITS9; u9++) {
      R.gl.activeTexture(R.gl.TEXTURE0 + u9);
      R.gl.bindTexture(R.gl.TEXTURE_2D, null);
    }
    R.gl.activeTexture(R.gl.TEXTURE0);
  }

  // The bake needs DEPTH24_STENCIL8 (see _allocCacheFbo); the cached picture does not. After the bake the renderbuffer is detached and
  // freed (4 B/px: 8 MB at 1080p, 9.4 MB at 1536 px, 16.8 MB at 2048 px, per cache, up to 6 auto caches) and the next bake of the same
  // target attaches a fresh one (about 0.1-0.2 ms). `opts.cacheKeepDepthStencil: true` keeps it resident as before. A SHARED-group
  // target is left alone: its renderbuffer is the group's, borrowed by every member.
  function _attachCacheRb(h) {
    const rb = trackGlResource(R.gl, R.gl.createRenderbuffer(), 'staticCache');
    R.bindFb(R.gl.FRAMEBUFFER, h.cacheFbo);
    R.gl.bindRenderbuffer(R.gl.RENDERBUFFER, rb);
    R.gl.renderbufferStorage(R.gl.RENDERBUFFER, R.gl.DEPTH24_STENCIL8, h.cacheRtW, h.cacheRtH);
    R.gl.framebufferRenderbuffer(
      R.gl.FRAMEBUFFER,
      R.gl.DEPTH_STENCIL_ATTACHMENT,
      R.gl.RENDERBUFFER,
      rb,
    );
    R.gl.bindRenderbuffer(R.gl.RENDERBUFFER, null);
    R.bindFb(R.gl.FRAMEBUFFER, null);
    h.cacheRb = rb;
  }
  // Called with the cache FBO still bound as FRAMEBUFFER, right after the bake's invalidate.
  function _releaseCacheRb(h) {
    if (
      !h.cacheRb ||
      h._sharedCacheBorrowed ||
      (h.cache && h.cache.instanceGroupKey) ||
      (R.opts && R.opts.cacheKeepDepthStencil)
    )
      return;
    R.gl.framebufferRenderbuffer(
      R.gl.FRAMEBUFFER,
      R.gl.DEPTH_STENCIL_ATTACHMENT,
      R.gl.RENDERBUFFER,
      null,
    );
    deleteGlResource(R.gl, 'Renderbuffer', h.cacheRb);
    h.cacheRb = null;
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
        if (ret9.tex) deleteGlResource(R.gl, 'Texture', ret9.tex);
        if (ret9.fbo) deleteGlResource(R.gl, 'Framebuffer', ret9.fbo);
        if (ret9.rb) deleteGlResource(R.gl, 'Renderbuffer', ret9.rb);
      }
      h.cacheTex = borrowed.tex;
      h.cacheFbo = borrowed.fbo;
      h.cacheRb = borrowed.rb;
      h.cacheRtW = borrowed.rtW;
      h.cacheRtH = borrowed.rtH;
      h._sharedCacheBorrowed = true;

      if (borrowed.bakeWm) {
        const wm9 = R.draw.worldM;
        const m09 = wm9 ? wm9[0] : 1,
          m19 = wm9 ? wm9[1] : 0,
          m39 = wm9 ? wm9[3] : 0,
          m49 = wm9 ? wm9[4] : 1;
        const bw9 = borrowed.bakeWm;
        // Borrowing is only valid at the same linear part (the raster is
        // scale/rotation-specific); a mismatched member falls through to
        // its own bake instead.
        if (bw9[0] !== m09 || bw9[1] !== m19 || bw9[2] !== m39 || bw9[3] !== m49) return false;
        h.cacheBakeWm = bw9.slice();
        const tx9 = wm9 ? wm9[6] : 0,
          ty9 = wm9 ? wm9[7] : 0;
        h.cacheBlitDx = tx9 - bw9[4];
        h.cacheBlitDy = ty9 - bw9[5];
      }
      return true;
    }
    h._sharedCacheBorrowed = false;
    if (h.cacheTex && h.cacheRtW === rtW && h.cacheRtH === rtH) {
      if (!h.cacheRb) _attachCacheRb(h);
      return true;
    }
    if (h.cacheTex) {
      deleteGlResource(R.gl, 'Texture', h.cacheTex);
      h.cacheTex = null;
    }
    if (h.cacheFbo) {
      deleteGlResource(R.gl, 'Framebuffer', h.cacheFbo);
      h.cacheFbo = null;
    }
    if (h.cacheRb) {
      deleteGlResource(R.gl, 'Renderbuffer', h.cacheRb);
      h.cacheRb = null;
    }
    // The scene memory budget: a static-cache raster is optional (RGBA8 color + depth/stencil); refused, the bundle draws live.
    if (R._memAdmit && !R._memAdmit(rtW * rtH * 8, 'static-cache raster')) return false;
    const created = _allocCacheFbo(rtW, rtH);
    h.cacheTex = created.tex;
    h.cacheFbo = created.fbo;
    h.cacheRb = created.rb;
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
  // Preserve numeric changes below any fixed quantum; they can cross an RGBA8 rounding boundary.
  const hashNumber = new Float64Array(1);
  const hashWords = new Uint32Array(hashNumber.buffer);
  function _drawStateHash() {
    let h9 = 0x811c9dc5 | 0;
    const mix = (v9) => {
      h9 = Math.imul(h9 ^ (v9 | 0), 0x01000193);
    };
    const mixNum = (n9) => {
      if (typeof n9 !== 'number') {
        mix(0x9e3779b9);
        return;
      }
      hashNumber[0] = n9;
      mix(hashWords[0]);
      mix(hashWords[1]);
    };
    const walk = (o9, depth9) => {
      if (o9 === null || o9 === undefined || depth9 > 4) return;
      if (typeof o9 === 'number') {
        mixNum(o9);
        return;
      }
      if (typeof o9 === 'boolean') {
        mix(o9 ? 1 : 2);
        return;
      }
      if (typeof o9 === 'string') {
        for (let i9 = 0; i9 < o9.length && i9 < 24; i9++) mix(o9.charCodeAt(i9));
        return;
      }
      if (Array.isArray(o9)) {
        for (let i9 = 0; i9 < o9.length; i9++) mixNum(o9[i9]);
        return;
      }
      if (ArrayBuffer.isView(o9)) {
        if (o9 instanceof DataView) {
          for (let i9 = 0; i9 < o9.byteLength; i9++) mix(o9.getUint8(i9));
          return;
        }
        const view9 = /** @type {{ length: number, [i: number]: number }} */ (
          /** @type {unknown} */ (o9)
        );
        for (let i9 = 0; i9 < view9.length; i9++) mixNum(view9[i9]);
        return;
      }
      if (typeof o9 === 'object') {
        for (const k9 in o9) {
          for (let i9 = 0; i9 < k9.length && i9 < 16; i9++) mix(k9.charCodeAt(i9));
          walk(o9[k9], depth9 + 1);
        }
      }
    };
    const overrides = R.draw.overrides;

    if (hasTrackedOverrideRevision(overrides)) {
      mixNum(overrides.revision);
      // Revision includes pending writes and markDirty(); identity separates
      // tables with equal counters. Host, bundle and GL objects are not paint.
      mix(_texIdOf(overrides));
      mix(_texIdOf(overrides.texture));
    } else {
      mixNum(overrides && overrides.generation);
      mixNum(overrides && overrides.version);
      mixNum(overrides && overrides.revision);
      walk(overrides, 0);
    }
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
    // A tweened filter parameter (createFilterParams) is baked into the RT
    // like everything above it. The filter-result cache has its own key term
    // for this; without it here too, a statically-cached mount would keep
    // blitting the bake made at the old blur radius — the filter would
    // re-evaluate and nothing on screen would move.
    mix(R._handle && R._handle.bundle ? R._handle.bundle._filterParamGen | 0 : 0);
    // A morph bundle's pose is part of what the bake captured: hash its t itself, not only through the optional isMorphActive hook,
    // or a handle created without the hook keeps blitting the raster baked at the old t.
    const morph9 = R._handle && R._handle.bundle && R._handle.bundle._morphSrc;
    if (morph9) mixNum(+morph9.t || 0);
    return h9;
  }
  // Stable per-texture ids for hashing (identity, not content).
  const _texIds9 = new WeakMap();
  let _texIdNext9 = 1;
  function _texIdOf(t9) {
    if (!t9) return 0;
    let id9 = _texIds9.get(t9);
    if (!id9) {
      id9 = _texIdNext9++;
      _texIds9.set(t9, id9);
    }
    return id9;
  }
  function _cacheTick() {
    const h = R._handle;
    if (!h || !h.cache) return R.CacheLevel.None;
    // Cost gate: Auto only promotes when live redraw is complex enough that a
    // viewport bake+blit is likely cheaper. A live CACHED↔DIRECT cadence probe
    // (60+60 frames, then rare re-probes) would itself cause frame drops on
    // light scenes, so a heuristic decides instead. Forced strategies skip
    // the complexity check inside the state machine.
    const [cw, ch] = R.viewportSize();
    const animatorActive =
      h.cacheHooks && h.cacheHooks.isAnimatorActive ? !!h.cacheHooks.isAnimatorActive() : false;
    const morphActive =
      h.cacheHooks && h.cacheHooks.isMorphActive ? !!h.cacheHooks.isMorphActive() : false;

    // These states cannot reuse a raster. Skip feature scans and draw-state
    // hashing, but still tick so dynamic content invalidates forced/shared caches.
    if (animatorActive || morphActive || h.cache.strategy === R.CacheStrategy.AlwaysLive) {
      h._lastSeenDrawHash = undefined;
      h._cacheResumePending = true;
      h._dhStableRuns = 0;
      h._pendingDrawHash = undefined;
      h._cacheContentKey = null;
      h.cacheBakeWm = undefined;
      h.cacheBlitDx = h.cacheBlitDy = 0;
      h.cache.tick({
        hasAsset: !!h.bundle,
        animatorActive,
        morphActive,
        dynamicContent: animatorActive || morphActive,
        footprintW: 0,
        footprintH: 0,
        viewportW: cw,
        viewportH: ch,
      });
      return h.cache.resolvedLevel;
    }

    const wm = R.draw.worldM; // column-major mat3, or null (identity)
    const m0 = wm ? wm[0] : 1,
      m1 = wm ? wm[1] : 0,
      m3 = wm ? wm[3] : 0,
      m4 = wm ? wm[4] : 1;
    const tx = wm ? wm[6] : 0,
      ty = wm ? wm[7] : 0;
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
        // translation stays inside that margin; a larger pan recenters by baking.
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
        // but only if the bake position left the bundle FULLY inside the
        // viewport. An RT baked while (partly) off-screen holds a CLIPPED
        // raster; shifting it back on-screen shows the clip (a parked card
        // baked at tx=2 is a fully blank RT slid back to center).
        let clipped9 = false;
        if ((tx !== bk[4] || ty !== bk[5]) && h.bundle && h.bundle.globalBBox) {
          const bb9 = h.bundle.globalBBox;
          const [arSx9, arSy9] = R.arScale(bb9, cw, ch);
          for (const [px9, py9] of [
            [-arSx9, -arSy9],
            [arSx9, -arSy9],
            [-arSx9, arSy9],
            [arSx9, arSy9],
          ]) {
            const nx9 = bk[0] * px9 + bk[2] * py9 + bk[4];
            const ny9 = bk[1] * px9 + bk[3] * py9 + bk[5];
            if (nx9 < -1.001 || nx9 > 1.001 || ny9 < -1.001 || ny9 > 1.001) {
              clipped9 = true;
              break;
            }
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
    // A bundle generation identifies rewritten cover geometry (streaming,
    // nine-slice, identity-stable text). Observe it before render() does its
    // VBO refresh: otherwise a forced cache can select and blit the old RT
    // for one frame. A one-off rewrite is live for that frame; a continuously
    // changing generation remains live instead of baking every frame.
    const geomGen9 = h.bundle ? h.bundle._geomGen | 0 : 0;
    const geomUnstable9 =
      (h.cache.isCacheValid &&
        h.cacheBakeGeomGen !== undefined &&
        h.cacheBakeGeomGen !== geomGen9) ||
      (h._lastSeenCacheGeomGen !== undefined && h._lastSeenCacheGeomGen !== geomGen9);
    h._lastSeenCacheGeomGen = geomGen9;

    // FULL QUALITY IS A ONE-TIME TRANSITION, and a bake has to follow it exactly once.
    //
    // Shapes adopt their Loop-Blinn meshes in BATCHES while the build runs, and none of that moves
    // the geometry generation — the geometry has not changed, only which engine draws it. Keyed on
    // the generation alone a bake never notices, so a long-lived cached handle would show its
    // cover-kernel raster for good while an uncached draw of the same art upgraded: a visible
    // difference between two draws of one bundle. Invalidating per BATCH is not the answer either,
    // since that re-bakes repeatedly and is exactly what the cache exists to avoid.
    //
    // So the bake rides through every intermediate adoption and is invalidated on the single step
    // that ends them: `_lbFullGen`, the generation at which the mesh set became complete. It is
    // undefined until that happens and constant afterwards, which makes this one edge, not a poll.
    if (bakeQualityStale(h.cacheBakeFullGen, h.bundle) && h.cache.isCacheValid)
      h.cache.invalidate();

    // ...and the same argument applies to the ENGINE SELECTION itself. A raster is a picture of
    // whichever engine drew it, and the cache is the one draw path that does not re-decide per
    // frame — so without this a bundle cached under one selection would keep blitting that raster
    // after the selection changed: with __MANTLE_FORCE_SLUG set on a cached scene every live draw
    // would go to Slug while the cached mounts blitted their Loop-Blinn bake, the switch drawing
    // exactly the engine it was asked to exclude. Cheap: a short string, compared once per tick.
    if (R._engineSelKey) {
      const sel9 = R._engineSelKey();
      if (
        h.cacheBakeEngineSel !== undefined &&
        h.cacheBakeEngineSel !== sel9 &&
        h.cache.isCacheValid
      ) {
        h.cache.invalidate();
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
      dhUnstable9 =
        !!h._cacheResumePending ||
        (h._lastSeenDrawHash !== undefined && h._lastSeenDrawHash !== dh9);
      h._cacheResumePending = false;
      h._dhStableRuns = dhUnstable9 ? 0 : (h._dhStableRuns | 0) + 1;
      h._lastSeenDrawHash = dh9;
      if (
        h.cacheBakeDrawHash !== undefined &&
        h.cacheBakeDrawHash !== dh9 &&
        h.cache.isCacheValid
      ) {
        h.cache.invalidate(); // overrides/alpha/palette changed since bake → stale raster
      }
      h._pendingDrawHash = dh9;
    }
    const contentUnstable9 = geomUnstable9 || dhUnstable9;
    // A shared target is only reusable by a member with the same rasterized
    // content. Translation remains shareable (it is handled by the blit
    // delta), while geometry and per-draw visual state are part of this key.
    h._cacheContentKey = `${geomGen9}:${h._pendingDrawHash}`;
    // Canvas resize. The raster was baked FOR a specific drawing-buffer size: the RT
    // is that size, and the em→NDC projection folds in the canvas aspect (arScale).
    // Nothing above notices a resize, so without this the stale raster keeps being blitted:
    //   • canvas GROWS  → the tick says "valid, just blit", no re-bake happens, and a
    //                     smaller RT is stretched over a bigger canvas — a visibly
    //                     LOW-RESOLUTION, UPSCALED card.
    //   • canvas SHRINKS→ _cacheEnsureFbo keeps the oversized RT (rtW >= needed) and
    //                     the blit squashes it — wrong scale, and the top clipped.
    // An ASPECT change corrupts it even at equal pixel count. An embedded browser panel
    // that resizes after load shows it; a fixed headless viewport never does.
    if (
      h.cache.isCacheValid &&
      h.cacheBakeCw !== undefined &&
      (h.cacheBakeCw !== cw || h.cacheBakeCh !== ch)
    ) {
      h.cache.invalidateLocal();
      h.cacheBakeWm = undefined;
    }

    let footprintW = 0,
      footprintH = 0;
    if (h.bundle && h.bundle.globalBBox) {
      const [sx, sy] = R.arScale(h.bundle.globalBBox, cw, ch);
      footprintW = (Math.abs(m0) * sx + Math.abs(m3) * sy) * cw;
      footprintH = (Math.abs(m1) * sx + Math.abs(m4) * sy) * ch;
    }
    h.cache.tick({
      hasAsset: !!h.bundle,
      animatorActive: animatorActive || dhUnstable9 || (h._dhStableRuns | 0) < 2,
      morphActive,
      dynamicContent: animatorActive || morphActive || contentUnstable9,
      footprintW,
      footprintH,
      viewportW: cw,
      viewportH: ch,
      liveComplexity:
        h.cache.strategy === R.CacheStrategy.Auto &&
        !contentUnstable9 &&
        (h._dhStableRuns | 0) >= 2 &&
        !(R.draw.extClipTex && R.draw.extClipMode > 0)
          ? _cacheLiveComplexity(h, footprintW, footprintH, cw, ch)
          : undefined,
      // External clips are mutable screen-space textures; their contents
      // cannot be represented by a content-raster cache key. A row that blends with
      // what lies under the bundle cannot be baked at all: the bake has no backdrop.
      cacheCompatible:
        !(R.draw.extClipTex && R.draw.extClipMode > 0) && !featureInfo.blendsBackdrop,
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
    // Don't bake nothing. Normally Slug is always drawable so a bake has content;
    // but in LB-only mode ('only') there is no Slug fallback, so a bundle whose
    // analytic mesh hasn't landed yet would bake an empty RT. Skip the bake until
    // its LB is ready (caller falls back to a live draw); the cache never holds a
    // blank frame, and once LB lands the bake captures it. Per the LB>Slug>nothing
    // ladder: cache only Slug-or-LB, never nothing.
    if (!R._lbSlugFallback && h.bundle && R._lbBundleReady && !R._lbBundleReady(h.bundle))
      return false;
    const [cw, ch] = R.viewportSize();
    const isViewportWindow = h.cache.resolvedLevel === R.CacheLevel.ViewportWindow;
    const margin = isViewportWindow ? Math.max(0, h.cache.viewportWindowMarginPixels | 0) : 0;
    const rtW = cw + margin * 2;
    const rtH = ch + margin * 2;
    // WholeAsset/SharedGroup must not bake content that is not fully on-screen. Their
    // viewport-sized target would hold a clipped raster and later treat it as complete.
    // ViewportWindow deliberately captures only the viewport plus its slack margin.
    if (!isViewportWindow && h.bundle && h.bundle.globalBBox) {
      const wm0 = R.draw.worldM;
      const a0 = wm0 ? wm0[0] : 1,
        b0 = wm0 ? wm0[1] : 0;
      const c0 = wm0 ? wm0[3] : 0,
        d0 = wm0 ? wm0[4] : 1;
      const e0 = wm0 ? wm0[6] : 0,
        f0 = wm0 ? wm0[7] : 0;
      const [sx0, sy0] = R.arScale(h.bundle.globalBBox, cw, ch);
      for (const [px0, py0] of [
        [-sx0, -sy0],
        [sx0, -sy0],
        [-sx0, sy0],
        [sx0, sy0],
      ]) {
        const nx0 = a0 * px0 + c0 * py0 + e0;
        const ny0 = b0 * px0 + d0 * py0 + f0;
        if (nx0 < -1.001 || nx0 > 1.001 || ny0 < -1.001 || ny0 > 1.001) return false; // off-screen → draw live
      }
    }
    // A sibling draws from the shared raster and it shows something else: this member draws live, or the two would bake over each other every frame.
    if (
      h.cache.resolvedLevel === R.CacheLevel.SharedGroup &&
      h.cache.groupRasterTaken(h._cacheContentKey, R._frameSerial | 0)
    )
      return false;
    if (!_cacheEnsureFbo(rtW, rtH)) return false;
    if (h._sharedCacheBorrowed) h.cache.noteGroupRasterWrite(); // (before the clear: a bake refused below has written it too)

    const savedWorld = R.draw.worldM;
    const savedViewport = R._explicitViewport;
    if (isViewportWindow) {
      // Render through the full larger framebuffer so gl_FragCoord, AA dilation,
      // masks, filters, and LB coverage all see its real dimensions. Compensate
      // the world matrix for the changed aspect fit so the original canvas maps
      // 1:1 into the centerd cw×ch window, with `margin` pixels around it.
      const bbox = h.bundle && h.bundle.globalBBox;
      let canvasSx = 1,
        canvasSy = 1,
        targetSx = 1,
        targetSy = 1;
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
      const dx = cw / rtW,
        dy = ch / rtH;
      const qx = targetSx ? canvasSx / targetSx : 1;
      const qy = targetSy ? canvasSy / targetSy : 1;
      R.draw.worldM = new Float32Array([
        dx * a * qx,
        dy * b * qx,
        0,
        dx * c * qy,
        dy * d * qy,
        0,
        dx * e,
        dy * f,
        1,
      ]);
      R._explicitViewport = [rtW, rtH];
    }

    // Bake: bind cache FBO + clear, then re-enter render() as if it
    // were a normal canvas draw. The re-entry guard prevents an
    // infinite loop and skips the cache tick on the inner call.
    let _bakeRouted = false;
    // Feedback loop: the blit samples h.cacheTex, and it stays bound to that
    // sampler unit afterwards. This bake is about to attach the same texture as
    // the cache FBO's color target — a texture that is simultaneously attached
    // to the draw framebuffer and bound to a unit the program samples makes the
    // whole draw GL_INVALID_OPERATION, and the driver DROPS it. The bake then
    // resolves to an empty (or half-written) RT, which gets blitted as a valid
    // cache: the shape's fill silently disappears. Unbind every unit still
    // holding the cache texture before it becomes the render target.
    _unbindTexEverywhere(h.cacheTex);
    R.bindFb(R.gl.FRAMEBUFFER, h.cacheFbo);
    R.glViewport(0, 0, h.cacheRtW, h.cacheRtH);
    R.glDisable(R.gl.SCISSOR_TEST);
    R.gl.clearColor(0, 0, 0, 0);
    R.gl.clear(R.gl.COLOR_BUFFER_BIT | R.gl.STENCIL_BUFFER_BIT | R.gl.DEPTH_BUFFER_BIT);

    // A draw DEFERRED during this bake (no ready program, nothing waits for one: debugStats.deferred*) leaves the target empty or half drawn.
    // Such a bake is not a picture of the bundle and must never be kept as the cache (it would blit blank, or half drawn,
    // for the rest of the session). The counters tell it apart: a deferral anywhere under the bake raises one of them.
    const deferredBefore = R._deferTotal(); // (a previous-variant reuse draw too: it is another engine's picture)
    R._cacheBakingNow = true;
    R._cacheTargetFbo = h.cacheFbo; // LB draw sites target this instead of the canvas
    // The bake re-enters the FILL pass, whose texture rebind is gated on
    // (_lastFillPassHandle !== _handle || handle.fillPassAssetDirty). A bundle
    // that normally takes the LB route never runs the fill pass, so this
    // handle's fill-pass texture state is stale/unset — yet the gate can still
    // read "unchanged" and SKIP the rebind. The Slug band-walk then samples
    // whatever curve/band textures happen to be bound (not this bundle's), finds
    // no curves, and emits ZERO coverage on every boundary fragment: the shape
    // bakes as its occupancy-interior slab with the curved edges missing (a
    // wavy ridge bakes flat-topped). Force a full rebind for the bake.
    h.fillPassAssetDirty = true;
    R._forgetFillUnits();
    R._lastFillPassHandle = null;
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;
    try {
      // Bake through the same ROUTE the live draw would take. The cached blit is
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
      h.fillPassAssetDirty = true;
      R._forgetFillUnits();
      R._lastFillPassHandle = null;
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
    }

    if (diagFlags.dumpCache) {
      try {
        const dw = h.cacheRtW,
          dh = h.cacheRtH;
        const px = new Uint8Array(dw * dh * 4);
        R.gl.readPixels(0, 0, dw, dh, R.gl.RGBA, R.gl.UNSIGNED_BYTE, px);
        let opaque = 0,
          partial = 0;
        for (let i = 3; i < px.length; i += 4) {
          if (px[i] > 250) opaque++;
          else if (px[i] > 4) partial++;
        }
        const cvs = new OffscreenCanvas(dw, dh);
        const c2 = cvs.getContext('2d');
        const img = c2.createImageData(dw, dh);
        for (let y = 0; y < dh; y++) {
          // GL origin is bottom-left
          const s = (dh - 1 - y) * dw * 4,
            d = y * dw * 4;
          img.data.set(px.subarray(s, s + dw * 4), d);
        }
        c2.putImageData(img, 0, 0);
        diagPushCacheDump({
          id: h.bundle && h.bundle.id,
          rt: `${dw}x${dh}`,
          canvas: `${cw}x${ch}`,
          lb: !!(h.bundle && Array.isArray(h.bundle._lbMeshes)),
          occ: !!(h.bundle && h.bundle.hasOccupancy),
          opaque,
          partial,
          routed: _bakeRouted,
          alpha: R.draw.alpha,
          blob: cvs.convertToBlob ? cvs.convertToBlob({ type: 'image/png' }) : null,
        });
      } catch (e) {
        diagPushCacheDump({ err: String(e) });
      }
    }
    // Unbind cache FBO; restore default + viewport. The blit pass
    // immediately below uses the canvas viewport.
    // The cached COLOR attachment is needed by the blit, but the bake's
    // DEPTH24_STENCIL8 renderbuffer is transient. Explicitly discard it on
    // tiled mobile GPUs rather than making the driver preserve data that no
    // later pass can read.
    if (R.gl.invalidateFramebuffer) {
      R.gl.invalidateFramebuffer(R.gl.FRAMEBUFFER, [R.gl.DEPTH_STENCIL_ATTACHMENT]);
    }
    _releaseCacheRb(h);
    R.bindFb(R.gl.FRAMEBUFFER, null);
    R.glViewport(0, 0, cw, ch);
    // Record the worldMatrix the RT was baked at: [linear a,b,c,d, tx,ty].
    // A later tick with the same linear part but a different translation
    // reuses this RT and offsets the blit (see _cacheTick / _cacheBlitToCanvas);
    // a different linear part invalidates and re-bakes.
    const wm = R.draw.worldM;
    h.cacheBakeWm = wm ? [wm[0], wm[1], wm[3], wm[4], wm[6], wm[7]] : [1, 0, 0, 1, 0, 0];
    h.cacheBakeCw = cw;
    h.cacheBakeCh = ch;
    h.cacheWindowMargin = margin;
    // Preserve the source rect from the bake. Recomputing it after a
    // translation is not reversible once it has been clipped by a canvas
    // edge, which made a moved filtered cache stretch to the wrong side.
    h.cacheContentRect = margin || !R._contentRectPx ? null : R._contentRectPx(cw, ch);
    h.cacheBakeDrawHash = h._pendingDrawHash;
    h.cacheBakeGeomGen = h.bundle ? h.bundle._geomGen | 0 : 0;
    // Which quality this raster IS. Undefined means it was baked before the analytic build
    // completed, so the one invalidation above is still owed.
    h.cacheBakeFullGen = h.bundle ? h.bundle._lbFullGen : undefined;
    // ...and which ENGINE SELECTION it is a picture of; see the tick's invalidation.
    h.cacheBakeEngineSel = R._engineSelKey ? R._engineSelKey() : undefined;
    if (R._deferTotal() !== deferredBefore) {
      // Incomplete: the caller draws this frame live, the cache stays invalid, and the next frame bakes again.
      h.cache.invalidate();
      R._cacheBakeDeferred = (R._cacheBakeDeferred | 0) + 1; // debugStats.cacheBakeDeferred: bakes refused; it stops rising once the programs are ready
      return false;
    }
    h.cache.markBaked(R._cacheFrameSeq, h.cacheBakeWm, h._cacheContentKey);
    if (h._sharedCacheBorrowed) h.cache.setGroupContentRect(h.cacheContentRect);
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

    const margin = h.cacheWindowMargin | 0;
    const dxPx = Math.round(((h.cacheBlitDx || 0) * cw) / 2);
    const dyPx = Math.round(((h.cacheBlitDy || 0) * ch) / 2);
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
      const x0 = Math.max(0, targetX),
        y0 = Math.max(0, targetY);
      const x1 = Math.min(cw, targetX + sourceRect[2]);
      const y1 = Math.min(ch, targetY + sourceRect[3]);
      if (x1 > x0 && y1 > y0) {
        blitRect = [
          x0,
          y0,
          x1 - x0,
          y1 - y0,
          sourceRect[0] + (x0 - targetX),
          sourceRect[1] + (y0 - targetY),
        ];
      }
    }
    R.glViewport(
      blitRect ? blitRect[0] : margin ? 0 : dxPx,
      blitRect ? blitRect[1] : margin ? 0 : dyPx,
      blitRect ? blitRect[2] : cw,
      blitRect ? blitRect[3] : ch,
    );
    const savedDepth = R.gl.isEnabled(R.gl.DEPTH_TEST);
    const savedStencil = R.gl.isEnabled(R.gl.STENCIL_TEST);
    R.glDisable(R.gl.DEPTH_TEST);
    R.glDisable(R.gl.STENCIL_TEST);
    R.glEnable(R.gl.BLEND);
    R.glBlendEquation(R.gl.FUNC_ADD);
    // Source-over against the canvas (the canvas is unchanged from
    // a stale prior draw OR cleared by the caller). The cache RT
    // contains premultiplied RGBA from the live coverage draw.
    R.glBlendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
    // No color clear here: it belongs to the frame (renderer.js renderEntry, the frame-entry contract). A
    // standalone render() has cleared before choosing the cache, and every other entry composes.
    R.glUseProgram(R.cacheBlitProg);
    // vUV spans the destination viewport, so map it to the corresponding
    // source portion of the canvas-sized cache RT. (Uniforms only stick
    // after useProgram.)
    if (R.cbUInMap) {
      if (margin) {
        const panX = (h.cacheBlitDx || 0) * cw * 0.5;
        const panY = (h.cacheBlitDy || 0) * ch * 0.5;
        R.gl.uniform4f(
          R.cbUInMap,
          cw / h.cacheRtW,
          ch / h.cacheRtH,
          (margin - panX) / h.cacheRtW,
          (margin - panY) / h.cacheRtH,
        );
      } else if (blitRect)
        R.gl.uniform4f(
          R.cbUInMap,
          blitRect[2] / cw,
          blitRect[3] / ch,
          blitRect[4] / cw,
          blitRect[5] / ch,
        );
      else R.gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);
    }
    R.gl.activeTexture(R.gl.TEXTURE0);
    R.gl.bindTexture(R.gl.TEXTURE_2D, h.cacheTex);
    R.gl.uniform1i(R.cbUCacheTex, 0);
    // A faded draw of a cached mount (bundleHandle.draw): the cache holds the alpha-1 picture and the blit fades it, the group
    // composite of the same picture (uTint on the premultiplied raster).
    const tint9 = R._cacheTint;
    R.gl.uniform4f(R.cbUTint, tint9, tint9, tint9, tint9);
    R.glBindVertexArray(R.coverVao);
    R.gl.drawArrays(R.gl.TRIANGLE_STRIP, 0, 4);
    R.glBindVertexArray(null);
    if (h._sharedCacheBorrowed) h.cache.noteGroupBlit(R._frameSerial | 0);
    // Drop the cache texture off the sampler unit. Left bound, it is still
    // sampleable when a later bake attaches it as the render target — a
    // feedback loop that makes the driver drop the bake's draws entirely.
    R.gl.bindTexture(R.gl.TEXTURE_2D, null);
    // Force the next live draw to rebind asset textures — the blit
    // changed program/textures so the per-frame "skip rebind if
    // unchanged" optimization needs an explicit dirty bit.
    //
    // Setting only this handle's dirty flag isn't enough: the fill-pass
    // rebind gate (fillPass.js) skips the rebind whenever the NEXT fill
    // pass's handle equals R._lastFillPassHandle — which is a DIFFERENT
    // handle here (or a bake re-entry), so its own dirty flag is false and
    // it inherits this blit's clobbered program + TEXTURE0 (the cacheTex),
    // sampling the wrong texture and rendering garbage (a scene with several
    // cached handles per frame — e.g. parallax backgrounds — shows one
    // handle's bake/draw wearing another's cache: missing fill, only edges).
    // Reset the GLOBAL gate so the next fill pass of ANY handle fully rebinds.
    h.fillPassAssetDirty = true;
    R._forgetFillUnits();
    R._lastFillPassHandle = null;
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;

    if (savedDepth) R.glEnable(R.gl.DEPTH_TEST);
    else R.glDisable(R.gl.DEPTH_TEST);
    if (savedStencil) R.glEnable(R.gl.STENCIL_TEST);
    else R.glDisable(R.gl.STENCIL_TEST);
    return true;
  }
  function enableStaticCache(opts = {}) {
    if (!R.cacheBlitProg) {
      R.mantleWarn(
        '[Mantle] cacheBlit shader not present; ' +
          'enableStaticCache is a no-op. Pass cacheBlitVert + ' +
          'cacheBlitFrag in shaderSources.',
      );
      return false;
    }
    if (!R._handle) {
      R.mantleWarn(
        '[Mantle] enableStaticCache called before setBundle. ' +
          'No-op — call after setBundle or use createBundleHandle.',
      );
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
        isMorphActive: opts.isMorphActive,
      };
      return true;
    }
    R._handle.cache = createStaticCache({
      strategy: opts.strategy ?? R.CacheStrategy.Auto,
      stabilityEpsilon: opts.stabilityEpsilon,
      stabilityPromoteFrames: opts.stabilityPromoteFrames,
      stabilityDemoteFrames: opts.stabilityDemoteFrames,
      instanceGroupKey: opts.instanceGroupKey ?? null,
      viewportWindowGiantAssetFactor: opts.viewportWindowGiantAssetFactor,
      viewportWindowMarginPixels: opts.viewportWindowMarginPixels,
      groupScope: resourceScope(R.gl),
      releaseSharedTarget: _freeSharedTarget,
    });
    R._handle.cacheHooks = {
      isAnimatorActive: opts.isAnimatorActive,
      isMorphActive: opts.isMorphActive,
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
      if (h.cacheTex) {
        deleteGlResource(R.gl, 'Texture', h.cacheTex);
        h.cacheTex = null;
      }
      if (h.cacheFbo) {
        deleteGlResource(R.gl, 'Framebuffer', h.cacheFbo);
        h.cacheFbo = null;
      }
      if (h.cacheRb) {
        deleteGlResource(R.gl, 'Renderbuffer', h.cacheRb);
        h.cacheRb = null;
      }
    }
    h.cache = null;
    h.cacheHooks = null;
    h.cacheRtW = 0;
    h.cacheRtH = 0;
    h.cacheBakeCw = undefined;
    h.cacheBakeCh = undefined;
    h.cacheBakeWm = undefined;
    h.cacheBakeDrawHash = undefined;
    h.cacheBakeGeomGen = undefined;
    h._lastSeenCacheGeomGen = undefined;
    h._cacheResumePending = false;
    h._cacheContentKey = null;
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
  R._cacheTint = 1; // the fade of the next cache blit (a faded draw of a cached mount); bundleHandle.draw sets and clears it
}
