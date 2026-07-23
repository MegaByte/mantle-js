// bundleHandle.js — createBundleHandle, split out of renderer.js.
//
// A bundle handle owns the per-mount GL state (its own cover-quad VAO/VBO,
// mask-region walk + R32I row→layer texture, and per-handle static-scene
// cache), plus the per-mount draw() entry point used by the multi-handle
// pattern. The ACTIVE handle is renderer.js's `_handle` singleton (read by
// beginFillPass / bakeMaskRegions / render); handle.draw() swaps it in/out via
// the R._handle live bridge, so this module never needs the singleton's other
// readers to move. Per-draw recolor state + _inFrame are likewise live bridges
// on R. Stable helpers (render, _analyticRoute, paletteChannelToInt,
// computeMaskRegions) are destructured at attach time — attachBundleHandle runs
// in _runInit after the Object.assign that publishes them, and BEFORE
// attachClipDraw (which destructures R.createBundleHandle).

import { createStaticCache, Strategy as CacheStrategy } from './staticCache.js';
import { diagFlags, diagNoteDraw } from '../core/diagnostics.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachBundleHandle(R) {
  const { gl, paletteChannelToInt, render, _analyticRoute, computeMaskRegions } = R;
  let nextFilterCacheOwner = 0;

  function freeSharedTarget(g) {
    if (g.sharedTex) { gl.deleteTexture(g.sharedTex); g.sharedTex = null; }
    if (g.sharedFbo) { gl.deleteFramebuffer(g.sharedFbo); g.sharedFbo = null; }
    if (g.sharedRb) { gl.deleteRenderbuffer(g.sharedRb); g.sharedRb = null; }
  }

  function createCoverResources() {
    const triVao = gl.createVertexArray();
    const triBuf = gl.createBuffer();
    const shapeIdxBuf = gl.createBuffer();
    gl.bindVertexArray(triVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
    const stride = 48;
    for (let i = 0; i < 7; i++) gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride,  0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride,  8);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 24);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 32);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 40);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 44);
    gl.bindBuffer(gl.ARRAY_BUFFER, shapeIdxBuf);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { triVao, triBuf, shapeIdxBuf };
  }

  function createBundleHandle(bundle, opts) {
    if (!bundle) throw new Error('createBundleHandle: bundle required');

    // Normal handles keep their own cover VAO/VBOs. The transient fast-
    // instancing handle creates them only if it later falls back to Slug.
    const deferCoverUpload = !!(opts && opts.deferCoverUpload);
    const coverResources = deferCoverUpload ? null : createCoverResources();
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
    const stripped = !!(bundle.coverQuadVboFloats);
    let coverVertCount = 0;
    if (vboVerts && !deferCoverUpload) {
      coverVertCount = (vboVerts.length / 12) | 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
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
      gl.bindBuffer(gl.ARRAY_BUFFER, shapeIdxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, vboSidx, gl.STATIC_DRAW);
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
          strategy:               cacheOpts.strategy ?? CacheStrategy.Auto,
          autoBudgeted:           !!cacheOpts.autoBudgeted,
          stabilityEpsilon:       cacheOpts.stabilityEpsilon,
          stabilityPromoteFrames: cacheOpts.stabilityPromoteFrames,
          stabilityDemoteFrames:  cacheOpts.stabilityDemoteFrames,
          instanceGroupKey:       cacheOpts.instanceGroupKey ?? null,
          viewportWindowGiantAssetFactor: cacheOpts.viewportWindowGiantAssetFactor,
          viewportWindowMarginPixels: cacheOpts.viewportWindowMarginPixels,
          groupScope: gl,
          releaseSharedTarget: freeSharedTarget,
        })
      : null;
    const cacheHooks = cacheOpts
      ? {
          isAnimatorActive: cacheOpts.isAnimatorActive,
          isMorphActive:    cacheOpts.isMorphActive,
        }
      : null;

    const h = {
      bundle,
      triVao,
      triBuf,
      shapeIdxBuf,
      _ensureCoverResources() {
        if (h.triVao) return;
        const created = createCoverResources();
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
      // invalidate() — for BOTH the setBundle singleton and persistent
      // handle.draw() flows.
      _boundGeomGen: bundle._geomGen | 0,
      // Filter results include per-mount overrides. Persistent handles therefore
      // need a distinct owner even when several mounts share one bundle.
      // setBundle supplies a bundle owner for its short-lived singleton handle.
      _filterCacheOwner: (opts && opts.filterCacheOwner) || ('h' + (++nextFilterCacheOwner)),
      fillPassAssetDirty: true,
      generation: 0,
      // Static-scene cache. `cache` is the state machine (createStaticCache
      // from staticCache.js) or null. `cacheFbo` + `cacheTex` are the
      // GL resources; allocated lazily on first bake. `cacheHooks`
      // are the per-frame predicate accessors the caller supplied.
      cache,
      cacheFbo:   null,
      cacheTex:   null,
      cacheRtW:   0,
      cacheRtH:   0,
      cacheHooks,
      /** Mark cache + dirty flags. Engine calls this when bundle
       *  content mutates in place (rare) or external state changes
       *  invalidate the cache. For bundle SWAPS the consumer should
       *  dispose this handle + create a new one. */
      invalidate() {
        h.hybridMeshDirty = !!(h.bundle && h.bundle.coverQuadFloats);
        h.fillPassAssetDirty = true;
        h.generation++;
        // The instanced compact cache is keyed by bundle geometry. Preserve
        // invalidate() as an explicit escape hatch for callers that mutate
        // geometry without a normal _geomGen bump.
        if (h.bundle) h.bundle._instCompactInvalidGen = (h.bundle._instCompactInvalidGen | 0) + 1;
        if (h.cache) h.cache.invalidate();
      },
      /** Release per-handle GL resources. Idempotent. `retainFilterCache` is
       *  internal: the bounded setBundle handle cache retains filter results
       *  while callers alternate resident bundles. */
      dispose(opts) {
        if (R._lastFillPassHandle === h) R._lastFillPassHandle = null;
        // Persistent handles own their filtered output lifetime. The renderer's
        // transient setBundle handle can opt out while changing bundles so the
        // next frame reuses the same static result.
        if (!opts?.retainFilterCache && R._evictFilterCache) R._evictFilterCache(h._filterCacheOwner);
        // Drop the mask-bake validity if it pointed at this handle,
        // so a future handle object reused at this address can't false-hit.
        if (R._maskBakeValidHandle === h) { R._maskBakeValidHandle = null; R._maskBakeValidGen = -1; }
        if (h.maskRowToLayerTex) { gl.deleteTexture(h.maskRowToLayerTex); h.maskRowToLayerTex = null; }
        if (h.triVao) { gl.deleteVertexArray(h.triVao); h.triVao = null; }
        if (h.triBuf) { gl.deleteBuffer(h.triBuf); h.triBuf = null; }
        if (h.shapeIdxBuf) { gl.deleteBuffer(h.shapeIdxBuf); h.shapeIdxBuf = null; }
        if (h.cache && h.cache.instanceGroupKey) {
          h.cache.dispose();
          h.cacheTex = null;
          h.cacheFbo = null;
          h.cacheRb = null;
        } else {
          if (h.cache) h.cache.dispose();
          if (h.cacheTex) { gl.deleteTexture(h.cacheTex); h.cacheTex = null; }
          if (h.cacheFbo) { gl.deleteFramebuffer(h.cacheFbo); h.cacheFbo = null; }
          if (h.cacheRb) { gl.deleteRenderbuffer(h.cacheRb); h.cacheRb = null; }
        }
        h.cacheRtW = 0;
        h.cacheRtH = 0;
        h.cache = null;
        h.cacheHooks = null;
        h.bundle = null;
      },
      /** Per-mount draw entry point. Same per-draw options as
       *  drawBundle(): worldMatrix, overrides, alpha, colorMatrix,
       *  colorMatrixOffset, palette, paletteChannel, channelLerp.
       *  See drawBundle() docstring for the option semantics.
       *
       *  This is the multi-handle-pattern call: each persistent handle
       *  is drawn once per frame, the bundle stays resident in the
       *  handle's VBOs across frames (no per-iter re-upload), and
       *  the static-scene cache is per-handle so static mounts get
       *  cached blits while animated mounts stay live. */
      draw(opts) {
        const prev = R._handle;
        R._handle = h;
        R.draw.overrides = (opts && opts.overrides) || null;
        R.draw.worldM    = (opts && opts.worldMatrix) || null;
        R.draw.alpha     = (opts && typeof opts.alpha === 'number')
          ? Math.max(0, Math.min(1, opts.alpha)) : 1.0;
        R.draw.colorMatrix       = (opts && opts.colorMatrix) || null;
        R.draw.colorMatrixOffset = (opts && opts.colorMatrixOffset) || null;
        R.draw.palette           = (opts && opts.palette) || null;
        R.draw.paletteChannel    = paletteChannelToInt(opts && opts.paletteChannel);
        R.draw.channelLerp       = (opts && opts.channelLerp) || null;
        R.draw.extClipTex        = (opts && opts.extClipTex) || null;
        R.draw.extClipMode       = (opts && opts.extClipMode) | 0;
        R._autoNodeClip(h.bundle);
        try {
          // _inFrame=true so the inner render skips the per-call
          // color clear — handle.draw is compose-with-others, not
          // single-bundle render(). beginFrame() owns the clear.
          const wasInFrame = R._inFrame;
          R._inFrame = true;
          try {
            // The handle's per-mount cover-quad VBO (Slug geometry) is NOT
            // refreshed by the lightweight stream, so a _lbStream bundle MUST
            // render through the analytic route (which builds its own VBO from
            // the streamed meshes) — else the handle paints stale geometry. The
            // engine draws every bundle through a handle (never a bare
            // drawBundle), so without this the streamed road never reaches the
            // analytic route. streamOnly: handles take only the _lbStream route.
            // CACHE vs LB. Previously the LB route ran FIRST and, when it served
            // the bundle, render() was skipped — so a cached handle's cache never
            // ticked, never ran its cost gate, and never engaged. LB won
            // unconditionally, which silently made `staticCache` a no-op for every
            // LB-eligible bundle (e.g. a big parallax background: LB re-fills every
            // pixel every frame where one cached blit would do).
            //
            // Now the cache TICKS FIRST so it can COMPETE. Its existing cost gate
            // decides: it probes CACHED vs DIRECT cadence, and because the direct
            // phase falls through to the LB route below, the baseline it must beat
            // IS LB's cost. It only wins when measurably cheaper (and re-probes if
            // the scene changes), so LB keeps every bundle it actually renders
            // faster — this is a perf gate, not a preference.
            if (R._cullSwitchTick) R._cullSwitchTick();
            const cacheOff9 = R.mantleDebugFlag('noStaticCache');
            let lvl9;
            if (h.cache && !cacheOff9 && !R._cacheBakingNow) {
              R._cacheSampleCost();
              lvl9 = R._cacheTick();
              h._decidedLevel9 = lvl9;   // render() consumes this instead of re-ticking
            }
            let route9 = 'lb';
            if (lvl9 === R.CacheLevel.WholeAsset || lvl9 === R.CacheLevel.ViewportWindow || lvl9 === R.CacheLevel.SharedGroup) {
              route9 = 'cache';
              render();                                             // cache is cheaper → bake/blit
            } else if (!_analyticRoute(h.bundle, { streamOnly: true })) {
              route9 = 'slug';
              render();                                             // LB declined → Slug (live)
            } else {
              // LB served it directly (render() skipped). Drop the unconsumed
              // decision and mark this frame a DIRECT sample, so the cost gate's
              // "direct" EMA measures LB — the cadence the cache has to beat.
              h._decidedLevel9 = undefined;
              h._lastModeCached9 = false;
            }
            // Draw-state trace (setDiagnostics({ engineTrace: true })). Off by
            // default — one boolean check; key build only when enabled.
            if (diagFlags.engineTrace) {
              const b9 = h.bundle || {};
              const o9 = R.draw.overrides;
              const wm9 = R.draw.worldM;
              const bb9 = b9.globalBBox;
              const key9 = (b9.numShapes | 0) + '|'
                + (bb9 ? `${Math.round(bb9[0])},${Math.round(bb9[1])},${Math.round(bb9[2])},${Math.round(bb9[3])}` : '-') + '|'
                + route9 + '|' + (lvl9 | 0) + '|a' + R.draw.alpha
                + '|o' + (o9 ? 1 : 0)
                + '|cm' + (R.draw.colorMatrix ? 1 : 0) + '|pal' + (R.draw.palette ? 1 : 0)
                + '|lerp' + (R.draw.channelLerp ? 1 : 0)
                + '|lb' + (Array.isArray(b9._lbMeshes) ? 1 : 0)
                + '|slug' + (b9._lbHasSlug ? 1 : 0) + '|occ' + (b9.hasOccupancy ? 1 : 0)
                + '|wm' + (wm9 ? `${wm9[0].toFixed(2)},${wm9[4].toFixed(2)},${wm9[6].toFixed(2)},${wm9[7].toFixed(2)}` : '-');
              diagNoteDraw(key9);
            }
          } finally { R._inFrame = wasInFrame; }
        } finally {
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
      get staticCache() { return h.cache; },
    };

    // Compute multi-shape mask regions up front. O(n) over numShapes;
    // the meta plane is immutable after import, so this runs ONCE per handle.
    h.maskRegions = computeMaskRegions(bundle);
    if (bundle.numShapes && h.maskRegions.length) {
      h.maskRowToLayerCpu = new Int32Array(bundle.numShapes);
      for (let i = 0; i < h.maskRowToLayerCpu.length; i++) h.maskRowToLayerCpu[i] = -1;
      for (let r = 0; r < h.maskRegions.length; r++) {
        const beginRow = h.maskRegions[r].maskRow - 1;
        if (beginRow >= 0 && beginRow < h.maskRowToLayerCpu.length) {
          h.maskRowToLayerCpu[beginRow] = r;
        }
      }
      h.maskRowToLayerTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, h.maskRowToLayerTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 1, bundle.numShapes, 0,
                    gl.RED_INTEGER, gl.INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      h.maskRowToLayerTexSize = bundle.numShapes;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, bundle.numShapes,
                       gl.RED_INTEGER, gl.INT, h.maskRowToLayerCpu);
    }
    return h;
  }

  R.createBundleHandle = createBundleHandle;
}
