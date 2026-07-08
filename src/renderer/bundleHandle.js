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

import { createStaticCache, Strategy as CacheStrategy, releaseA3GroupMember } from './staticCache.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachBundleHandle(R) {
  const { gl, paletteChannelToInt, render, _analyticRoute, computeMaskRegions } = R;

  function createBundleHandle(bundle, opts) {
    if (!bundle) throw new Error('createBundleHandle: bundle required');

    // Per-handle VAO + VBO pair. Today's renderer holds a single
    // shared pair and re-uploads the bundle's mesh on every
    // setBundle — the per-mount loop paid that re-upload on
    // every iteration. Per-handle ownership means each bundle's
    // mesh lives in its own VBO for the handle's lifetime; draw()
    // just binds the VAO. Memory cost: ~coverQuadFloats.byteLength
    // + shapeIdxFloats.byteLength per handle.
    const triVao = gl.createVertexArray();
    const triBuf = gl.createBuffer();
    const shapeIdxBuf = gl.createBuffer();
    gl.bindVertexArray(triVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
    {
      // 7-attribute cover-quad layout:
      //   slot 0  : aPos       (vec2)
      //   slots 1-4: aV0..aV3  (vec2 control points)
      //   slot 5  : aKind      (float, flat)
      //   slot 6  : aZone      (float)
      const stride = 48;
      for (let i = 0; i < 7; i++) gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride,  0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride,  8);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 24);
      gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 32);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 40);
      gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 44);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, shapeIdxBuf);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Upload the bundle's mesh once at handle-create time. Subsequent
    // draws bind the VAO; no re-upload unless invalidate() is called.
    if (bundle.coverQuadFloats) {
      gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
      gl.bufferData(gl.ARRAY_BUFFER, bundle.coverQuadFloats, gl.STATIC_DRAW);
      if (bundle.hybridShapeIdxFloats) {
        gl.bindBuffer(gl.ARRAY_BUFFER, shapeIdxBuf);
        gl.bufferData(gl.ARRAY_BUFFER, bundle.hybridShapeIdxFloats, gl.STATIC_DRAW);
      }
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
      maskRegions: [],
      maskRowToLayerCpu: null,
      maskRowToLayerTex: null,
      maskRowToLayerTexSize: 0,
      // hybridMeshDirty starts false — mesh was uploaded above. Set
      // true on invalidate() to force re-upload at next draw.
      hybridMeshDirty: false,
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
        if (h.cache) h.cache.invalidate();
      },
      /** Release per-handle GL resources. Idempotent. */
      dispose() {
        if (R._lastFillPassHandle === h) R._lastFillPassHandle = null;
        // Drop the mask-bake validity if it pointed at this handle,
        // so a future handle object reused at this address can't false-hit.
        if (R._maskBakeValidHandle === h) { R._maskBakeValidHandle = null; R._maskBakeValidGen = -1; }
        if (h.maskRowToLayerTex) { gl.deleteTexture(h.maskRowToLayerTex); h.maskRowToLayerTex = null; }
        if (h.triVao) { gl.deleteVertexArray(h.triVao); h.triVao = null; }
        if (h.triBuf) { gl.deleteBuffer(h.triBuf); h.triBuf = null; }
        if (h.shapeIdxBuf) { gl.deleteBuffer(h.shapeIdxBuf); h.shapeIdxBuf = null; }
        if (h.cache && h.cache.instanceGroupKey) {
          releaseA3GroupMember(h.cache.instanceGroupKey, h.cache._cacheState, (g) => {
            if (g.sharedTex) { gl.deleteTexture(g.sharedTex); g.sharedTex = null; }
            if (g.sharedFbo) { gl.deleteFramebuffer(g.sharedFbo); g.sharedFbo = null; }
          });
        } else {
          if (h.cacheTex) { gl.deleteTexture(h.cacheTex); h.cacheTex = null; }
          if (h.cacheFbo) { gl.deleteFramebuffer(h.cacheFbo); h.cacheFbo = null; }
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
            if (!_analyticRoute(h.bundle, { streamOnly: true })) render();
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
