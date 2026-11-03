// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// frameLoop.js — frame lifecycle + viewport/scissor + SVG-export recorder,
// split out of renderer.js.
//
// Owns: beginFrame/endFrame (the multi-bundle compose boundary), setViewport /
// setScissorRect / clearScissorRect (caller-facing viewport control),
// invalidateRenderState / markGeometryDirty (fill-pass cache busting after the
// consumer mutates globalBBox or streams geometry in place), and the per-frame
// draw recorder (_recordBundleDraw / _recordImageDraw / setFrameCapture) that
// feeds exportFrameSVG (which stays in renderer.js and reads R._frameLog).
//
// All cold (per-frame or config, never per-shape). Shared mutable state lives on
// renderer.js and is reached via live R get/set bridges: _explicitViewport
// (viewportSize reads it), _scissor (the render path reads it), _frameClearColor
// (_renderCanvasInner reads it), _frameLog / _lastFrameClearColor (exportFrameSVG
// reads them). attachFrameLoop runs after the Object.assign that publishes the
// destructured helpers.

import { clampArg, checkClearColor, checkMat3 } from '../core/argCheck.js';

/** The largest explicit viewport side, in drawingBuffer pixels (the WebGL2 minimum for MAX_VIEWPORT_DIMS is 32767 on current drivers). */
const MAX_VIEWPORT_PX = 32767;
const IMAGE_ARRAY_OPTS = [
  'dstRect',
  'srcRect',
  'worldMatrix',
  'tint',
  'colorMatrix',
  'colorMatrixOffset',
];

// Shared default clear color — read-only, never mutated (verified), so one instance
// avoids a 4-array allocation on every beginFrame that omits an explicit color.
const _DEFAULT_CLEAR = [1, 1, 1, 1];

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachFrameLoop(R) {
  const { gl, viewportSize, _canvasUnsized } = R;
  // Cluster-local: set + consumed within beginFrame, nulled in endFrame; no
  // other reader, so it stays off R.
  let _frameClearColor = null;

  function invalidateRenderState() {
    // Called when the consumer mutates bundle.globalBBox (e.g. for a
    // pan/zoom bench loop) — beginFillPass normally caches uGBB +
    // uCanvasAR but those depend on globalBBox.
    if (R._handle) R._handle.fillPassAssetDirty = true;
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;
  }

  /** Mark the active handle's GEOMETRY dirty after an in-place stream
   *  (streamGeometry.updateBundleGeometry). The textures are already
   *  re-uploaded by the streaming call; this re-uploads the renderer-
   *  owned cover-quad VBO from bundle.coverQuadFloats, refreshes the
   *  globalBBox-dependent fill-pass uniforms, and bumps generation so a
   *  cached/masked handle re-bakes. Cheap; call once per streamed frame. */
  function markGeometryDirty() {
    const h = R._handle;
    if (!h) return;
    h.hybridMeshDirty = !!(h.bundle && h.bundle.coverQuadFloats);
    h.fillPassAssetDirty = true;
    h.generation++;
    if (h.cache) h.cache.invalidate();
    // Streamed geometry moved → bump the LB geometry generation so the cache
    // refreshes (reusing earcut topology) on the next route; prevRaw is kept.
    if (h.bundle) h.bundle._geomGen = (h.bundle._geomGen | 0) + 1;
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;
  }

  /**
RESOLUTION SCALE — render fewer pixels, keep the same screen size.
   *
   *
   *  On a retina display the default DPR of 2 already means 4x the pixels of DPR 1. That
   *  is usually the biggest single win available.
   *
   *
   *  A change drops every canvas-sized resource (RT pools, filter caches, offscreen
   *  targets) and forces static caches to re-bake — so it costs a hitch. Drive it with
   *  hysteresis off a sustained frame-time trend; never per frame.
   *
   *  @param {number} scale  >0, typically 0.5..1
   *  @param {{dpr?: number}} [opts]

 */
  function setResolutionScale(scale, opts) {
    const cnv = gl.canvas;
    if (!cnv || typeof cnv.width !== 'number') return null;
    // CLAMPED to [0.05, 4]; NaN and non-numbers throw (core/argCheck.js).
    const s = clampArg('setResolutionScale', 'scale', scale, 0.05, 4);
    const requestedDpr =
      opts && opts.dpr != null
        ? +opts.dpr
        : typeof devicePixelRatio === 'number'
          ? devicePixelRatio
          : 1;
    const dpr = Number.isFinite(requestedDpr) && requestedDpr > 0 ? requestedDpr : 1;
    // CSS size. An offscreen canvas has no client box — fall back to its current backing
    // store, which lets a caller re-scale relative to whatever it last set.
    const cssW =
      ('clientWidth' in cnv ? cnv.clientWidth : 0) ||
      cnv.width / Math.max(R._resScale * (R._resDpr || 1), 1e-6);
    const cssH =
      ('clientHeight' in cnv ? cnv.clientHeight : 0) ||
      cnv.height / Math.max(R._resScale * (R._resDpr || 1), 1e-6);
    if (!(cssW >= 1) || !(cssH >= 1)) return null;
    const w = Math.max(1, Math.round(cssW * dpr * s));
    const h = Math.max(1, Math.round(cssH * dpr * s));
    R._resScale = s;
    R._resDpr = dpr;
    if (cnv.width === w && cnv.height === h) return [w, h]; // nothing moved
    // A canvas with no CSS size is laid out at its own width/height attributes, so resizing the backing store resized the page element
    // too, and the next call read that new size as "the CSS size": scales compounded (2, then 4, then 1e6 gave 256, 1024, 4096 px; then 0 and
    // -1 gave 205 and 10). Pin the size on screen before the backing store moves, so a scale means "this fraction of the same screen
    // size" and repeating a scale is a no-op.
    const el = /** @type {HTMLCanvasElement} */ (cnv); // an OffscreenCanvas has no style and no client box: the guard skips it
    if (el.style && 'clientWidth' in el && el.clientWidth >= 1 && el.clientHeight >= 1) {
      if (el.style.width === '') el.style.width = el.clientWidth + 'px';
      if (el.style.height === '') el.style.height = el.clientHeight + 'px';
    }
    cnv.width = w;
    cnv.height = h;
    R._explicitViewport = null; // go back to reading the (new) drawing buffer
    if (R._invalidateSizedResources) R._invalidateSizedResources();
    if (R._noteViewportChange && R._loadStats && (w !== R._lastSeenW || h !== R._lastSeenH))
      R._noteViewportChange(w, h);
    R._lastSeenW = w;
    R._lastSeenH = h;
    return [w, h];
  }

  /** The size draws are fitted into, in drawingBuffer pixels. `null` goes back
   *  to reading the canvas's own drawing buffer; one number means a square.
   *
   *  THE FIT IS TO THE BUNDLE'S CONTENT BBOX (`globalBBox`), NOT TO THE SVG's
   *  viewBox. Each draw scales the inked bounding box by
   *  `min(width/bboxWidth, height/bboxHeight)` and centers it, so the content
   *  fills one axis and is letterboxed on the other, and the viewBox's own
   *  margins are not reproduced. Any absolute reference — a browser raster, a
   *  hand-computed area, an expected pixel coordinate — must reproduce that fit
   *  (give the reference SVG the inked bbox as its viewBox, with
   *  `preserveAspectRatio="xMidYMid meet"`) or it disagrees with every engine at
   *  once.
   *  @param {number|null} widthPx
   *  @param {number} [heightPx]  defaults to widthPx
   *  @param {number} [dpr]  accepted for symmetry with setResolutionScale; the
   *    size here is already in drawingBuffer pixels, so it is not applied.
   */
  function setViewport(widthPx, heightPx, dpr) {
    if (widthPx == null) {
      R._explicitViewport = null;
    } else {
      // Sizes TRUNCATE to whole pixels and CLAMP to [1, 32767]; NaN and non-numbers throw (core/argCheck.js).
      const w = Math.trunc(clampArg('setViewport', 'width', widthPx, 1, MAX_VIEWPORT_PX));
      const h = Math.trunc(
        clampArg(
          'setViewport',
          'height',
          heightPx == null ? widthPx : heightPx,
          1,
          MAX_VIEWPORT_PX,
        ),
      );
      R._explicitViewport = [w, h];
      if (R._noteViewportChange && R._loadStats && (w !== R._lastSeenW || h !== R._lastSeenH))
        R._noteViewportChange(w, h); // (a settled size in a new scale class is warmed: fillPass.js)
    }
    R.fillPassCanvasW = 0;
    R.fillPassCanvasH = 0;
  }

  /** Restrict subsequent draws into the default framebuffer (canvas)
   *  to a rectangular region. WebGL native coordinates: origin lower-
   *  left, units = drawingBuffer pixels. Stays active until
   *  clearScissorRect() is called (or endFrame implicit-clears). A
   *  second setScissorRect REPLACES the rect — no intersection.
   *  Internal offscreen passes (sharp/ping/shape/mainCopy/groupBackdrop/
   *  mask/pool) bypass it; their RTs are never cropped by the caller's
   *  scissor.
   *  @param {number} x  left edge, drawingBuffer pixels
   *  @param {number} y  bottom edge, drawingBuffer pixels
   *  @param {number} w  width, drawingBuffer pixels
   *  @param {number} h  height, drawingBuffer pixels
   */
  function setScissorRect(x, y, w, h) {
    // Whole pixels (truncated); x and y clamp to +-2^30, w and h to [0, 2^30]; NaN and non-numbers throw (core/argCheck.js).
    const LIM = 2 ** 30;
    R._scissor = [
      Math.trunc(clampArg('setScissorRect', 'x', x, -LIM, LIM)),
      Math.trunc(clampArg('setScissorRect', 'y', y, -LIM, LIM)),
      Math.trunc(clampArg('setScissorRect', 'width', w, 0, LIM)),
      Math.trunc(clampArg('setScissorRect', 'height', h, 0, LIM)),
    ];
    gl.scissor(R._scissor[0], R._scissor[1], R._scissor[2], R._scissor[3]);
    R.glEnable(gl.SCISSOR_TEST);
  }

  /** Disable the user scissor; subsequent draws cover the full
   *  viewport. Idempotent.
   */
  function clearScissorRect() {
    R._scissor = null;
    R.glDisable(gl.SCISSOR_TEST);
  }

  /** Begin a frame. Clears to clearColor (or skips clear when null). `clearColor` is STRAIGHT (non-premultiplied) RGBA in 0..1.
   *  Subsequent drawBundle() calls accumulate into the same target.
   *  @param {[number,number,number,number]|null} [clearColor]
   */
  function beginFrame(clearColor) {
    checkClearColor('beginFrame', clearColor);
    R._frameSerial = (R._frameSerial | 0) + 1; // per-frame serial (build-pool epoch)
    if (R._contextLost || _canvasUnsized()) {
      // These frames never reach endFrame, so anything already submitted would otherwise
      // accumulate until the canvas comes back and then paint a stale backlog at once.
      // Recycled rather than dropped, so a lost context does not leave the pool holding the
      // bundles it was about to paint.
      _recycleSubmits(_submitQ);
      _submitSeq = 0;
      return;
    }
    if (R._inFrame) endFrame();
    if (R._atlasReset) R._atlasReset();
    R._inFrame = true;
    R._frameOpen = true; // (R._inFrame is also raised outside frames, by drawInstance and a mount's draw; this is the pair itself)
    const cc = clearColor === undefined ? _DEFAULT_CLEAR : clearColor;
    _frameClearColor = cc;
    if (R._captureFrames) {
      R._frameLog = [];
      R._lastFrameClearColor = cc;
    }
    const [cw, ch] = viewportSize();

    if (cw !== R._lastSeenW || ch !== R._lastSeenH) {
      if (R._lastSeenW && R._invalidateSizedResources) R._invalidateSizedResources();
      if (R._lastSeenW && R._noteViewportChange) R._noteViewportChange(cw, ch);
      R._lastSeenW = cw;
      R._lastSeenH = ch;
    }
    R.glViewport(0, 0, cw, ch);

    if (R.fillWarmTick) R.fillWarmTick({ draw: !!cc && !R._boundDrawFbo });
    if (cc) {
      R.glDisable(gl.DEPTH_TEST);
      R.glDisable(gl.STENCIL_TEST);
      gl.clearStencil(0);
      // The clear color is STRAIGHT (non-premultiplied) alpha, as a CSS color is and as the native scene and exportFrameSVG take it: the
      // canvas is premultiplied, so the color is multiplied by its alpha here. [1,0,0,.5] clears to half-transparent red.
      const ca = cc[3] == null ? 1 : cc[3];
      gl.clearColor(cc[0] * ca, cc[1] * ca, cc[2] * ca, ca);
      gl.clearDepth(1.0);
      R.glDepthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      R.glDepthMask(false);
    }
  }

  // ---- zOrder submission queue -------------------------------------------
  // Mantle paints in painter's order: whatever calls drawBundle first ends up underneath.
  // That makes MOUNT order the stacking order, which is unstable as soon as anything mounts
  // asynchronously (an overlay that finishes loading a font after the HUD, a feedback flash).
  // Without this, each consumer would keep its own sorted mount list and call drawBundle in the
  // right sequence; this owns that instead.
  //
  //   r.beginFrame(clear);
  //   r.submitBundle(hud,   { zOrder: 300 });
  //   r.submitBundle(bg,    { zOrder: 0 });     // submitted later, still paints FIRST
  //   r.endFrame();                             // sorts, then paints
  //
  // zOrder is a number; +-Infinity are the top / bottom layers; NaN or a non-number throws. The opts (and the numeric lists in them:
  // worldMatrix, scissor, dstRect, colorMatrix, ...) are COPIED at submit, because the draw happens at endFrame.

  /** @type {{target:any, opts:any, z:number, seq:number, o:any, keys:string[], snap:any}[]} */
  let _submitQ = [];
  /// The array the LAST flush handed back, ready to become the next queue. A flush must
  /// detach the list it is about to walk — drawBundle can re-enter and submit — but it does
  /// not need a NEW list to do that, and a fresh `[]` per flush plus a fresh entry object per
  /// submit is one allocation per bundle per frame in the one loop every multi-mount app runs.
  let _submitSpare = [];
  /// Spent entry records. Their fields are nulled on recycle, so a pooled entry never keeps a
  /// disposed bundle or a caller's opts object alive.
  const _submitPool = [];
  let _submitSeq = 0;
  /// How many entry records have ever been CREATED. Steady state is the high-water mark of
  /// submits in one frame, not submits x frames — which is the whole point, and the only way
  /// to observe it from outside a closure.
  R._submitEntryAllocs = 0;

  /// Give a flushed list's records back to the pool and empty it.
  function _recycleSubmits(q) {
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      e.target = null;
      e.opts = null; // never retain a bundle or a caller's options
      // The entry's own options copy: every key it took is reset (undefined reads as absent everywhere opts is read), so
      // the pooled object never holds the caller's arrays, tables or textures either.
      const o = e.o,
        ks = e.keys;
      for (let k = 0; k < ks.length; k++) o[ks[k]] = undefined;
      ks.length = 0;
      _submitPool.push(e);
    }
    q.length = 0;
  }

  /// The draw options whose value is a numeric list the caller commonly rewrites in place (`o.worldMatrix[6] = x`). The queue
  /// paints at endFrame, so each is copied into a buffer the entry owns (reused across frames, reallocated only when the
  /// list's type or length changes).
  const SNAP_KEYS = new Set([
    'worldMatrix',
    'scissor',
    'dstRect',
    'colorMatrix',
    'colorMatrixOffset',
    'palette',
    'channelLerp',
  ]);
  /** @param {{snap: any}} e @param {string} k @param {any} list */
  function _snapList(e, k, list) {
    /** @type {any} */ const v = list;
    const n = v.length;
    let b = e.snap[k];
    if (!b || b.length !== n || b.constructor !== v.constructor) {
      b = e.snap[k] = ArrayBuffer.isView(v)
        ? new /** @type {any} */ (v.constructor)(n)
        : new Array(n);
    }
    for (let i = 0; i < n; i++) b[i] = v[i];
    return b;
  }

  /// zOrder: absent (undefined / null) is 0; a number, +-Infinity included (always on top / always underneath), orders; anything
  /// else (NaN, a string, an object) is a bug in the caller and throws rather than landing the bundle at 0.
  function _submitZ(opts) {
    const z = opts && opts.zOrder;
    if (z === undefined || z === null) return 0;
    if (typeof z !== 'number' || z !== z) {
      throw new TypeError(
        'submitBundle: opts.zOrder must be a number (Infinity and -Infinity are allowed), got ' +
          (typeof z === 'number' ? 'NaN' : typeof z + ' ' + String(z)),
      );
    }
    return z;
  }

  function submitBundle(target, opts) {
    if (R._contextLost || !target) return;
    const z = _submitZ(opts);
    if (opts) checkMat3('submitBundle', 'worldMatrix', opts.worldMatrix);
    // Outside a frame there is nothing to defer to — behave like drawBundle so a stray
    // submit is never silently dropped.
    if (!R._inFrame) {
      R.drawBundle(target, opts);
      return;
    }
    let e = _submitPool.pop();
    if (!e) {
      e = { target: null, opts: null, z: 0, seq: 0, o: {}, keys: [], snap: {} };
      R._submitEntryAllocs++;
    }
    e.target = target;
    e.z = z;
    e.seq = _submitSeq++;
    // The draw happens at endFrame, so the options are COPIED now: a caller that reuses one options object (and mutates its
    // worldMatrix) between submits gets what it submitted, as it does from the immediate drawBundle.
    if (opts && typeof opts === 'object') {
      const o = e.o,
        ks = e.keys;
      let n = 0;
      for (const k in opts) {
        let v = opts[k];
        if (typeof v === 'object' && v !== null && typeof v.length === 'number' && SNAP_KEYS.has(k))
          v = _snapList(e, k, v);
        o[k] = v;
        ks[n++] = k;
      }
      e.opts = o;
    } else e.opts = null;
    _submitQ.push(e);
  }

  function _flushSubmitQueue() {
    const q = _submitQ;
    if (!q.length) return;
    // Callers commonly re-z every frame (parallax / depth fog) while the RELATIVE order
    // barely moves, so check for already-sorted in O(n) and skip the comparator entirely.
    // Output-identical either way.
    let ordered = true;
    for (let i = 1; i < q.length; i++) {
      const p = q[i - 1],
        c = q[i];
      if (p.z > c.z || (p.z === c.z && p.seq > c.seq)) {
        ordered = false;
        break;
      }
    }
    if (!ordered) q.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.seq - b.seq));

    const spare = _submitSpare;
    _submitSpare = q;
    _submitQ = spare;
    _submitSeq = 0;
    // ...and recycled only now: an entry recycled before its draw would be handing the pool a record
    // the loop still reads. Recycled on a throw too: left in the spare queue, this frame's list would become the next frame's queue and paint again.
    try {
      for (let i = 0; i < q.length; i++) R.drawBundle(q[i].target, q[i].opts);
    } finally {
      _recycleSubmits(q);
    }
  }

  /** End the current frame. Idempotent. */
  function endFrame() {
    // Paint anything submitted this frame, in (zOrder, submission) order — while still
    // in-frame, since drawBundle's capture/group bookkeeping keys off R._inFrame.
    // Drained rather than flushed once: a submit issued DURING the flush lands in the fresh
    // queue, and painting it next frame would be a silently missing draw. Bounded so a
    // pathological submit-from-draw cycle cannot wedge the frame.
    for (let guard = 0; guard < 8 && _submitQ.length; guard++) _flushSubmitQueue();
    R._inFrame = false;
    R._frameOpen = false;
    if (R._instCompactTrim) R._instCompactTrim(); // idle instanced meshes past their bound, before the budget looks
    if (R._transientTrim) R._transientTrim(); // idle transient handles past their bound, likewise
    if (R._opaquePrepassTrim) R._opaquePrepassTrim(); // idle prepass meshes past their bound, likewise
    if (R._memEnforce) R._memEnforce(); // the memory budget's safe point: evict what the budget needs and the frame is done with
    if (R._scratchTrim) R._scratchTrim(); // idle filter-scratch trim: one target per frame, only after a long filter-free stretch
    _frameClearColor = null;
    R.draw.overrides = null;
    R.draw.worldM = null;
    // Implicit scissor reset per setScissorRect contract: each frame
    // starts un-scissored. Callers that want a scissored region must
    // re-issue setScissorRect inside the next beginFrame/endFrame pair.
    if (R._scissor) clearScissorRect();
  }

  // ── SVG-export frame recorder ─────────────────────────────────────
  // Snapshot the draw-time options the native replay needs. References
  // (override table, worldMatrix, colorMatrix, palette handle) are held
  // as-is — export reads their current state, which is exactly the last
  // frame's. Scalars are copied so a caller reusing one opts object
  // across draws doesn't alias. No geometry is touched.
  function _recordBundleDraw(bundle, opts) {
    const o = opts || {};
    // The log outlives this draw and these arrays need not: the instanced loop's color pair is a scratch it rewrites per instance, and a
    // caller may reuse one matrix for every draw.
    const own = (m) => (m && typeof m.slice === 'function' ? m.slice() : m || null);
    R._frameLog.push({
      kind: 'bundle',
      bundle,
      // Sprite-subset draws (R.drawSprite / R.drawSpriteInstanced) set
      // _drawShapeRange before calling through here; capture it (sliced,
      // so a later mutation can't alias) so export replays only the
      // sprite's shapes, not the whole sheet. null for full-bundle draws.
      spriteRange: R.draw.shapeRange ? R.draw.shapeRange.slice() : null,
      // Sprite id when the subset draw was addressed by name — the native
      // export replay isolates the sprite's own element by id (robust to
      // fill+stroke meta-row drift); the row range is the fallback.
      spriteKey: R.draw.spriteKey || null,
      // The scissor this draw ran under (setScissorRect, or the dstRect clipToRect box already
      // intersected with it) in GL drawing-buffer pixels, origin lower left; and the setNodeClip
      // registered for the bundle. The export replays both on the draw.
      scissor: o.scissor ? Array.from(o.scissor) : R._scissor ? Array.from(R._scissor) : null,
      nodeClip: R._nodeClipSource
        ? (() => {
            const c = R._nodeClipSource(bundle);
            return c ? { ...c } : null;
          })()
        : null,
      opts: {
        worldMatrix: own(o.worldMatrix),
        viewportWorldMatrix: own(o.viewportWorldMatrix),
        overrides: o.overrides || null,
        morphVisibilityResolved: !!bundle.__exportMorph,
        alpha: typeof o.alpha === 'number' ? o.alpha : 1,
        colorMatrix: own(o.colorMatrix),
        colorMatrixOffset: own(o.colorMatrixOffset),
        palette: o.palette || null,
        paletteChannel: o.paletteChannel,
        channelLerp: o.channelLerp || null,
      },
    });
  }

  function _recordImageDraw(source, opts) {
    // The arrays are copied: a caller may reuse one matrix or rect for every draw, and the replay happens later.
    const o = opts ? { ...opts } : {};
    for (const k of IMAGE_ARRAY_OPTS) if (o[k]) o[k] = Array.from(o[k]);
    R._frameLog.push({
      kind: 'image',
      source,
      opts: o,
      scissor: R._scissor ? Array.from(R._scissor) : null,
    });
  }

  /** Enable/disable per-frame draw recording for exportFrameSVG().
   *  Off by default (opts.captureFrames opts in at create time); enable
   *  before the frame you want to export. Returns the new state. */
  function setFrameCapture(on) {
    R._captureFrames = !!on;
    if (!R._captureFrames) R._frameLog = [];
    return R._captureFrames;
  }

  R.invalidateRenderState = invalidateRenderState;
  R.markGeometryDirty = markGeometryDirty;
  R.setViewport = setViewport;
  R.setResolutionScale = setResolutionScale;
  Object.defineProperty(R, 'resolutionScale', { get: () => R._resScale, configurable: true });
  R.setScissorRect = setScissorRect;
  R.clearScissorRect = clearScissorRect;
  R.beginFrame = beginFrame;
  R.endFrame = endFrame;
  R.submitBundle = submitBundle;
  R._recordBundleDraw = _recordBundleDraw;
  R._recordImageDraw = _recordImageDraw;
  R.setFrameCapture = setFrameCapture;
}
