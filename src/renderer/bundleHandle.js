// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { uploadBuffer } from './coopUpload.js';
import { deleteGlResource, resourceScope, trackGlResource } from './contextResources.js';
// bundleHandle.js — createBundleHandle, split out of renderer.js.
//

import { createStaticCache, Strategy as CacheStrategy } from './staticCache.js';
import { decodeTraceBake } from './cpatchTrace.js';
import { diagFlags, diagNoteDraw } from '../core/diagnostics.js';
import {
  applySharedPose,
  collapsedAffineDraw,
  recordDrawForExport,
  resolveOverrides,
} from './drawDispatch.js';
import { syncKeptRows } from './bundle.js';
import { MRL_COLS, TAB_H, tableDims, checkLayersFit } from './tableLayout.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachBundleHandle(R) {
  const { gl, paletteChannelToInt, render, _analyticRoute, computeMaskRegions } = R;
  let nextFilterCacheOwner = 0;

  function freeSharedTarget(g) {
    if (g.sharedTex) {
      deleteGlResource(gl, 'Texture', g.sharedTex);
      g.sharedTex = null;
    }
    if (g.sharedFbo) {
      deleteGlResource(gl, 'Framebuffer', g.sharedFbo);
      g.sharedFbo = null;
    }
    if (g.sharedRb) {
      deleteGlResource(gl, 'Renderbuffer', g.sharedRb);
      g.sharedRb = null;
    }
  }

  function createCoverResources(owner) {
    const triVao = trackGlResource(gl, gl.createVertexArray());
    const triBuf = trackGlResource(gl, gl.createBuffer(), 'coverGeometry', owner);
    const shapeIdxBuf = trackGlResource(gl, gl.createBuffer(), 'coverGeometry', owner);
    R.glBindVertexArray(triVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
    const stride = 48;
    for (let i = 0; i < 7; i++) gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 24);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 32);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 40);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 44);
    gl.bindBuffer(gl.ARRAY_BUFFER, shapeIdxBuf);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, 0, 0);
    R.glBindVertexArray(null);
    return { triVao, triBuf, shapeIdxBuf };
  }

  function createBundleHandle(target, opts) {
    if (!target) throw new Error('createBundleHandle: bundle required');
    // An ANIMATION HANDLE (a morph, a timeline) unwraps to its bundle, by drawBundle's own rule, so a
    // mount takes what drawBundle takes. Handed the morph itself, the handle wrapped an object with no
    // geometry and the first draw threw a TypeError inside render() (c). The morph's fade
    // then resolves from the bundle's table like any draw (resolveOverrides).
    const bundle = target.bundle !== undefined ? target.bundle : target;
    // a sprite timeline's frame changes with setTime, which a static handle cannot follow (its held frames are views of the sheet: draw them with drawBundle)
    if (bundle && bundle._spriteOf)
      throw new Error(
        'createBundleHandle: a sprite timeline frame is a view of its sheet that changes with setTime; draw the timeline with drawBundle, or make a handle of the sheet and draw it with drawSprite',
      );
    // Each mask / effect region bakes into its own layer of a 2D texture array, and the layer count is bounded by the device's
    // MAX_ARRAY_TEXTURE_LAYERS (256 at the WebGL 2 minimum). Past it texImage3D raises GL 1281 and every masked shape draws
    // wrong. Regions are sampled together by the main draw, so they cannot share layers: throw, naming the count and the limit,
    // before anything is allocated.
    const maskRegions0 = computeMaskRegions(bundle);
    checkLayersFit(gl, 'mask/effect regions', maskRegions0.length, 'drawBundle');

    // Normal handles keep their own cover VAO/VBOs. The transient fast-
    // instancing handle creates them only if it later falls back to Slug.
    const deferCoverUpload = !!(opts && opts.deferCoverUpload);
    const coverResources = deferCoverUpload ? null : createCoverResources(bundle);
    let triVao = coverResources ? coverResources.triVao : null;
    let triBuf = coverResources ? coverResources.triBuf : null;
    let shapeIdxBuf = coverResources ? coverResources.shapeIdxBuf : null;

    // Upload the bundle's mesh once at handle-create time. The instanced
    // fast path has its own compact VBOs, so its transient handle defers this
    // upload until a normal fill draw actually needs the cover mesh.
    // Upload the HEADER-FREE cover-quad planes (chunk body verts packed
    // contiguously; each chunk carries `vboStart`). This lets the renderer
    // batch adjacent chunks into one drawArrays — the interleaved chunk
    // headers in coverQuadFloats otherwise force a per-shape flush. Falls
    // back to the raw (with-header) planes if a bundle predates the strip.
    //
    // Attrib 7 (shapeIdx) is always enabled on triVao — the shapeIdx buffer
    // MUST cover every vert or Chrome reports "Vertex buffer is not big enough".
    const vboVerts = bundle.coverQuadVboFloats || bundle.coverQuadFloats;
    const stripped = !!bundle.coverQuadVboFloats;
    let coverVertCount = 0;
    if (vboVerts && !deferCoverUpload) {
      coverVertCount = (vboVerts.length / 12) | 0;
      uploadBuffer(gl, triBuf, vboVerts, gl.STATIC_DRAW); // (cooperative in the loading call: coopUpload.js)
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
      uploadBuffer(gl, shapeIdxBuf, vboSidx, gl.STATIC_DRAW);
    }

    // Per-handle static-scene cache. The renderer-level
    // R.enableStaticCache() configures cache options on the internal
    // handle via setBundle; createBundleHandle({ staticCache: ... })
    // configures it at handle-create time. State machine + GL
    // resources live on the handle, so multi-bundle scenes get
    // per-mount cache hits.
    // Static caching stays OPT-IN at creation (auto-defaulting broke 26 render
    // smokes: a cached handle changes draw semantics — LB routing, RT staleness —
    // in ways callers must choose deliberately). Strategy.Auto within an opted-in
    // cache self-promotes/demotes; opts.staticCache.autoBudgeted joins the global
    // ≤6-RT budget if desired.
    const cacheOpts = opts && opts.staticCache;
    const cache = cacheOpts
      ? createStaticCache({
          strategy: cacheOpts.strategy ?? CacheStrategy.Auto,
          autoBudgeted: !!cacheOpts.autoBudgeted,
          stabilityEpsilon: cacheOpts.stabilityEpsilon,
          stabilityPromoteFrames: cacheOpts.stabilityPromoteFrames,
          stabilityDemoteFrames: cacheOpts.stabilityDemoteFrames,
          instanceGroupKey: cacheOpts.instanceGroupKey ?? null,
          viewportWindowGiantAssetFactor: cacheOpts.viewportWindowGiantAssetFactor,
          viewportWindowMarginPixels: cacheOpts.viewportWindowMarginPixels,
          groupScope: resourceScope(gl),
          releaseSharedTarget: freeSharedTarget,
        })
      : null;
    const cacheHooks = cacheOpts
      ? {
          isAnimatorActive: cacheOpts.isAnimatorActive,
          isMorphActive: cacheOpts.isMorphActive,
        }
      : null;

    const h = {
      bundle,
      triVao,
      triBuf,
      shapeIdxBuf,
      _ensureCoverResources() {
        if (h.triVao) return;
        const created = createCoverResources(bundle);
        h.triVao = created.triVao;
        h.triBuf = created.triBuf;
        h.shapeIdxBuf = created.shapeIdxBuf;
      },
      // Vert count currently resident in triBuf (+ matching shapeIdxBuf).
      // Cover draws clamp against this so a stale chunk.start against a
      // stripped VBO cannot trip "Vertex buffer is not big enough".
      coverVertCount,
      coverStripped: stripped,
      maskRegions: [],
      maskRowToLayerCpu: null,
      maskRowToLayerTex: null,
      maskRowToLayerTexSize: 0,
      // A transient instanced handle leaves its ordinary cover mesh empty.
      // The regular render path uploads it on demand before its first draw.
      hybridMeshDirty: deferCoverUpload && !!vboVerts,
      // Geometry generation the VBO upload above corresponds to. The
      // render path compares this against bundle._geomGen every draw so
      // in-place geometry rewrites (applyNineSlice re-slices, textBundle
      // identity-stable setText) re-upload without an explicit
      // invalidate() — for both the setBundle singleton and persistent
      // handle.draw() flows.
      _boundGeomGen: bundle._geomGen | 0,

      _filterCacheOwner: (opts && opts.filterCacheOwner) || 'h' + ++nextFilterCacheOwner,
      fillPassAssetDirty: true,
      generation: 0,
      // Static-scene cache. `cache` is the state machine (createStaticCache
      // from staticCache.js) or null. `cacheFbo` + `cacheTex` are the
      // GL resources; allocated lazily on first bake. `cacheHooks`
      // are the per-frame predicate accessors the caller supplied.
      cache,
      cacheFbo: null,
      cacheTex: null,
      cacheRtW: 0,
      cacheRtH: 0,
      cacheHooks,
      // Content tokens captured with the current RT. They keep cacheDraw's
      // geometry/override invalidation explicit for persistent handles.
      cacheBakeDrawHash: undefined,
      cacheBakeGeomGen: undefined,
      _lastSeenCacheGeomGen: undefined,
      _cacheResumePending: false,
      _cacheContentKey: null,
      /** Mark cache + dirty flags. Engine calls this when bundle
       *  content mutates in place (rare) or external state changes
       *  invalidate the cache. For bundle SWAPS the consumer should
       *  dispose this handle + create a new one. */
      invalidate() {
        h.hybridMeshDirty = !!(h.bundle && h.bundle.coverQuadFloats);
        h.fillPassAssetDirty = true;
        h.generation++;
        h.cacheBakeWm = undefined;
        h.cacheBakeDrawHash = undefined;
        h.cacheBakeGeomGen = undefined;
        // The instanced compact cache is keyed by bundle geometry. Preserve
        // invalidate() as an explicit escape hatch for callers that mutate
        // geometry without a normal _geomGen bump.
        if (h.bundle) h.bundle._instCompactInvalidGen = (h.bundle._instCompactInvalidGen | 0) + 1;
        if (h.cache) h.cache.invalidate();
      },
      /** Set legacy CPatch decomposition traces as bytes or a decoded Map;
       *  null clears them. Supersedes pending conversion and invalidates geometry.
       *  Legacy builds replay matching entries. Prepared whole-paint builds
       *  decline explicit traces and retain the selected raw cover. */
      setCPatchBake(bake) {
        const b = h.bundle;
        if (!b) return;
        b._cpatchTraces = bake ? (bake instanceof Map ? bake : decodeTraceBake(bake)) : null;
        b._cpatchConv = undefined; // a pooled conversion in flight or cached is superseded
        b._cpatchRetry = true;
        b._geomGen = (b._geomGen | 0) + 1; // reopens the build gate (_lbGen !== _geomGen)
        h.invalidate();
      },
      /** Release per-handle GL resources. Idempotent. `retainFilterCache` is
       *  internal: the bounded setBundle handle cache retains filter results
       *  while callers alternate resident bundles. */
      dispose(opts) {
        if (R._lastFillPassHandle === h) R._lastFillPassHandle = null;
        // Persistent handles own their filtered output lifetime. The renderer's
        // transient setBundle handle can opt out while changing bundles so the
        // next frame reuses the same static result.
        if (!opts?.retainFilterCache && R._evictFilterCache)
          R._evictFilterCache(h._filterCacheOwner);
        // Drop the mask-bake validity if it pointed at this handle,
        // so a future handle object reused at this address can't false-hit.
        if (R._dropMaskSlot) R._dropMaskSlot(h);
        if (h.maskRowToLayerTex) {
          deleteGlResource(gl, 'Texture', h.maskRowToLayerTex);
          h.maskRowToLayerTex = null;
        }
        if (h.triVao) {
          deleteGlResource(gl, 'VertexArray', h.triVao);
          h.triVao = null;
        }
        if (h.triBuf) {
          deleteGlResource(gl, 'Buffer', h.triBuf);
          h.triBuf = null;
        }
        if (h.shapeIdxBuf) {
          deleteGlResource(gl, 'Buffer', h.shapeIdxBuf);
          h.shapeIdxBuf = null;
        }
        if (h.cache && h.cache.instanceGroupKey) {
          h.cache.dispose();
          h.cacheTex = null;
          h.cacheFbo = null;
          h.cacheRb = null;
        } else {
          if (h.cache) h.cache.dispose();
          if (h.cacheTex) {
            deleteGlResource(gl, 'Texture', h.cacheTex);
            h.cacheTex = null;
          }
          if (h.cacheFbo) {
            deleteGlResource(gl, 'Framebuffer', h.cacheFbo);
            h.cacheFbo = null;
          }
          if (h.cacheRb) {
            deleteGlResource(gl, 'Renderbuffer', h.cacheRb);
            h.cacheRb = null;
          }
        }
        h.cacheRtW = 0;
        h.cacheRtH = 0;
        h.cache = null;
        h.cacheHooks = null;
        h.bundle = null;
      },
      /** Per-mount draw entry point. Same per-draw options as
       *  drawBundle(): worldMatrix, overrides, alpha, colorMatrix,
       *  colorMatrixOffset, palette, paletteChannel, channelLerp, and
       *  dstRect/fit/clipToRect.
       *  See drawBundle() docstring for the option semantics.
       *
       *  This is the multi-handle-pattern call: each persistent handle
       *  is drawn once per frame, the bundle stays resident in the
       *  handle's VBOs across frames (no per-iter re-upload), and
       *  the static-scene cache is per-handle so static mounts get
       *  cached blits while animated mounts stay live. */
      draw(opts) {
        // Lost: inert, like every draw entry. Restored: the handle's VAO, buffers and the bundle's textures died with the old context and
        // the renderer cannot rebuild them (renderer.needsRecreate), so say so instead of drawing through dead objects (GL 1282 every frame).
        if (R._contextLost) {
          if (R._needsRecreate) throw R._staleContextError('handle.draw');
          return;
        }
        const prev = R._handle;
        // THE FRAME-SLACK TICK, as drawBundle and render() run it. A mount drawn
        // outside beginFrame -- the caller owning the clear, as drawInstance's callers do -- would
        // otherwise never run it, so its fill variant would be linked but never promoted or
        // pipeline-warmed and every frame would draw the universal program. Inside a frame
        // beginFrame has ticked. Taken before the
        // handle is swapped in, with `prev` read first: a pipeline warm rebinds the active handle,
        // and the one restored below must be the caller's.
        if (!R._inFrame && R._warmTick) R._warmTick();
        if (h.bundle) applySharedPose(R, null, h.bundle, opts); // (before the handle is swapped in: the morph's pre-pass may run)
        R._handle = h;
        // A mount honors dstRect exactly as a bare drawBundle does — the same helper, so the
        // two entry points cannot drift. Without this, moving a caller from drawBundle to a
        // resident handle (a pure performance change) would silently drop the rect.
        const dstFit = R._resolveDstRect ? R._resolveDstRect(h.bundle, opts) : null;
        let savedScissor;
        if (dstFit && dstFit.scissor) {
          savedScissor = R._scissor ? R._scissor.slice() : null;
          R.setScissorRect(
            dstFit.scissor[0],
            dstFit.scissor[1],
            dstFit.scissor[2],
            dstFit.scissor[3],
          );
        }
        // The same resolver drawBundle uses, for the same reason the dstRect helper is shared:
        // a mount is documented as taking drawBundle's options, so moving a caller from a bare
        // drawBundle to a resident handle (a pure performance change) must not silently drop a
        // morph's fade. Absent/undefined -> the bundle's own table; an explicit null -> none.
        R.draw.overrides = resolveOverrides(h.bundle, opts);
        recordDrawForExport(R, h.bundle, opts, R.draw.overrides, dstFit); // (as drawBundle: a frame drawn through mounts exports)
        syncKeptRows(h.bundle, R.draw.overrides); // (as drawBundle: an override that gives a kept row ink, or reveals it, brings it back into the draw list)
        R.draw.worldM = dstFit ? dstFit.worldM : (opts && opts.worldMatrix) || null;
        if (R._noteDrawIdle && h.bundle)
          R._noteDrawIdle(h.bundle, R.draw.overrides, R.draw.worldM, opts && opts.alpha, opts);
        R.draw.alpha =
          opts && typeof opts.alpha === 'number' ? Math.max(0, Math.min(1, opts.alpha)) : 1.0;
        R.draw.colorMatrix = (opts && opts.colorMatrix) || null;
        R.draw.colorMatrixOffset = (opts && opts.colorMatrixOffset) || null;
        R.draw.palette = (opts && opts.palette) || null;
        R.draw.paletteChannel = paletteChannelToInt(opts && opts.paletteChannel);
        R.draw.channelLerp = (opts && opts.channelLerp) || null;
        R.draw.extClipTex = (opts && opts.extClipTex) || null;
        R.draw.extClipMode = (opts && opts.extClipMode) | 0;
        R._autoNodeClip(h.bundle);
        // alpha < 1: the draw is a group faded as one unit (renderer.js R._alphaGroupBegin); null at alpha 1 or for one paint-only leaf.
        let alphaGroup = null;
        try {
          if (!R._psoWarming && collapsedAffineDraw(R.draw.worldM, h.bundle)) return;
          // _inFrame=true so the inner render skips the per-call
          // color clear — handle.draw is compose-with-others, not
          // single-bundle render(). beginFrame() owns the clear.
          const wasInFrame = R._inFrame;
          R._inFrame = true;
          try {
            // A faded draw of a CACHED mount: the cache holds the alpha-1 picture of the draw (the tick, the draw-state hash and the
            // bake all see alpha 1) and the blit fades it (uTint = alpha, the group composite of the same picture), so an alpha that
            // animates never re-bakes and a cached faded asset is one blit. When the tick says the cache does not serve this frame the
            // draw goes on as a live group, as before.
            let ticked9 = false,
              lvlEarly9;
            const aDraw9 = R.draw.alpha;
            if (
              aDraw9 < 1 &&
              h.cache &&
              !R._cacheBakingNow &&
              !R.mantleDebugFlag('noStaticCache')
            ) {
              if (R._cullSwitchTick) R._cullSwitchTick();
              R.draw.alpha = 1;
              try {
                lvlEarly9 = R._cacheTick();
              } finally {
                R.draw.alpha = aDraw9;
              }
              ticked9 = true;
              h._decidedLevel9 = lvlEarly9;
              if (
                lvlEarly9 === R.CacheLevel.WholeAsset ||
                lvlEarly9 === R.CacheLevel.ViewportWindow ||
                lvlEarly9 === R.CacheLevel.SharedGroup
              ) {
                R.draw.alpha = 1;
                R._cacheTint = aDraw9;
              }
            }
            if (R._cacheTint === 1) alphaGroup = R._alphaGroupBegin(h.bundle);
            //
            // The cache TICKS FIRST so it can COMPETE. Auto uses a live-
            // complexity heuristic (not a cadence probe): it only promotes when
            // redraw is expensive enough that a viewport blit is likely cheaper.
            // Forced strategies still opt in deliberately. LB keeps every bundle
            // Auto declines — this is a perf gate, not a preference.
            if (!ticked9 && R._cullSwitchTick) R._cullSwitchTick();
            const cacheOff9 = R.mantleDebugFlag('noStaticCache');
            let lvl9 = lvlEarly9;
            if (!ticked9 && h.cache && !cacheOff9 && !R._cacheBakingNow && !alphaGroup) {
              lvl9 = R._cacheTick();
              h._decidedLevel9 = lvl9; // render() consumes this instead of re-ticking
            }
            let route9 = 'lb';
            if (
              lvl9 === R.CacheLevel.WholeAsset ||
              lvl9 === R.CacheLevel.ViewportWindow ||
              lvl9 === R.CacheLevel.SharedGroup
            ) {
              route9 = 'cache';
              render(); // cache is cheaper → bake/blit
            } else if (
              R._aacPointsFirst &&
              R._aacPointsFirst(h.bundle, () => {
                if (!_analyticRoute(h.bundle, { streamOnly: true })) render();
              })
            ) {
              route9 = 'points'; // only primitives on the analytic route (aacPointsFirst)
              h._decidedLevel9 = undefined;
            } else if (!_analyticRoute(h.bundle, { streamOnly: true })) {
              // The same fallback as a bare drawBundle (drawDispatch): LB-only mode draws nothing, and AAC's small-shape
              // point route takes the draw when it qualifies. This went straight to render(), so content drawn through a
              // handle -- which is how the engine draws everything -- never reached the point route a bare drawBundle took.
              if (!R._lbSlugFallback) route9 = 'none';
              else if (R._aacPointsRoute && R._aacPointsRoute(h.bundle)) route9 = 'points';
              else {
                route9 = 'slug';
                render();
              } // LB declined → Slug (live)
            } else {
              // LB served it directly (render() skipped). Drop the unconsumed
              // decision so a later bare render() re-ticks cleanly.
              h._decidedLevel9 = undefined;
            }
            // Draw-state trace (setDiagnostics({ engineTrace: true })). Off by
            // default — one boolean check; key build only when enabled.
            if (diagFlags.engineTrace) {
              const b9 = h.bundle || {};
              const o9 = R.draw.overrides;
              const wm9 = R.draw.worldM;
              const bb9 = b9.globalBBox;
              const key9 =
                (b9.numShapes | 0) +
                '|' +
                (bb9
                  ? `${Math.round(bb9[0])},${Math.round(bb9[1])},${Math.round(bb9[2])},${Math.round(bb9[3])}`
                  : '-') +
                '|' +
                route9 +
                '|' +
                (lvl9 | 0) +
                '|a' +
                R.draw.alpha +
                '|o' +
                (o9 ? 1 : 0) +
                '|cm' +
                (R.draw.colorMatrix ? 1 : 0) +
                '|pal' +
                (R.draw.palette ? 1 : 0) +
                '|lerp' +
                (R.draw.channelLerp ? 1 : 0) +
                '|lb' +
                (Array.isArray(b9._lbMeshes) ? 1 : 0) +
                '|slug' +
                (b9._lbHasSlug ? 1 : 0) +
                '|occ' +
                (b9.hasOccupancy ? 1 : 0) +
                '|wm' +
                (wm9
                  ? `${wm9[0].toFixed(2)},${wm9[4].toFixed(2)},${wm9[6].toFixed(2)},${wm9[7].toFixed(2)}`
                  : '-');
              diagNoteDraw(key9);
            }
            if (alphaGroup) {
              const g = alphaGroup;
              alphaGroup = null;
              R._alphaGroupEnd(g);
            }
          } finally {
            R._inFrame = wasInFrame;
          }
        } finally {
          if (alphaGroup) R._alphaGroupAbort(alphaGroup);
          if (savedScissor !== undefined) {
            if (savedScissor)
              R.setScissorRect(savedScissor[0], savedScissor[1], savedScissor[2], savedScissor[3]);
            else R.clearScissorRect();
          }
          R._cacheTint = 1;
          R._handle = prev;
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
      },
      /** Diagnostic accessor for the cache state machine. Null if
       *  the handle wasn't created with a `staticCache` opt. */
      get staticCache() {
        return h.cache;
      },
    };

    // Compute multi-shape mask regions up front. O(n) over numShapes;
    // the meta plane is immutable after import, so this runs ONCE per handle.
    h.maskRegions = maskRegions0;
    h.hasPatternGroups = h.maskRegions.some((reg) => reg.kind === 'pattern');
    h.maskRowToLayerWidth = h.hasPatternGroups ? 2 : 1;
    if (bundle.numShapes && h.maskRegions.length) {
      h.maskRowToLayerCpu = new Int32Array(bundle.numShapes * h.maskRowToLayerWidth);
      for (let i = 0; i < h.maskRowToLayerCpu.length; i++) h.maskRowToLayerCpu[i] = -1;
      for (let r = 0; r < h.maskRegions.length; r++) {
        if (h.maskRegions[r].kind === 'pattern') {
          h.maskRowToLayerCpu[h.maskRegions[r].patternRow * h.maskRowToLayerWidth + 1] = r;
          continue;
        }
        const beginRow = h.maskRegions[r].maskRow - 1;
        if (beginRow >= 0 && beginRow < h.maskRowToLayerCpu.length) {
          h.maskRowToLayerCpu[beginRow * h.maskRowToLayerWidth] = r;
        }
      }
      h.maskRowToLayerTex = trackGlResource(gl, gl.createTexture(), 'mask', bundle);
      gl.bindTexture(gl.TEXTURE_2D, h.maskRowToLayerTex);
      // <= 4096 shapes: the plain width x numShapes plane. More wrap in 4096-row bands, MRL_COLS (2) texels per row, like the
      // other per-shape tables (tableLayout.js; mrlAt in the shaders).
      const mrlDims = tableDims(MRL_COLS, bundle.numShapes);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32I,
        mrlDims.bands === 1 ? h.maskRowToLayerWidth : mrlDims.w,
        mrlDims.bands === 1 ? bundle.numShapes : mrlDims.h,
        0,
        gl.RED_INTEGER,
        gl.INT,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      h.maskRowToLayerTexSize = bundle.numShapes;
      if (mrlDims.bands === 1) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          h.maskRowToLayerWidth,
          bundle.numShapes,
          gl.RED_INTEGER,
          gl.INT,
          h.maskRowToLayerCpu,
        );
      } else {
        const wrapped = new Int32Array(mrlDims.w * mrlDims.h).fill(-1),
          cw = h.maskRowToLayerWidth;
        for (let r = 0; r < bundle.numShapes; r++)
          for (let c = 0; c < cw; c++) {
            wrapped[(r & (TAB_H - 1)) * mrlDims.w + MRL_COLS * (r >> 12) + c] =
              h.maskRowToLayerCpu[r * cw + c];
          }
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          mrlDims.w,
          mrlDims.h,
          gl.RED_INTEGER,
          gl.INT,
          wrapped,
        );
      }
    }
    return h;
  }

  R.createBundleHandle = createBundleHandle;
}
