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

// Shared default clear colour — read-only, never mutated (verified), so one instance
// avoids a 4-array allocation on every beginFrame that omits an explicit colour.
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

  /** Explicit canvas size in CSS pixels times DPR. Renderer maps the
   *  GL viewport to (widthPx, heightPx) on every pass. Pass null to
   *  return to auto-sizing (gl.drawingBufferWidth/Height).
   *  @param {number|null} widthPx
   *  @param {number} [heightPx]
   *  @param {number} [dpr] reserved; currently informational only
   */
  /** RESOLUTION SCALE — render fewer pixels, keep the same screen size.
   *
   *  A canvas has two independent sizes: the BACKING STORE (canvas.width/height, what you
   *  render into and what you pay for) and the CSS box it is displayed in. The compositor
   *  scales one to the other for free. Fill cost is linear in backing-store pixels
   *  (measured: 2-5 ms/Mpx), so this is a direct dial on frame time — scale 0.7 is half
   *  the pixels and roughly double the fps, at the same screen size, slightly softer.
   *
   *  On a retina display the default DPR of 2 already means 4x the pixels of DPR 1. That
   *  is usually the biggest single win available.
   *
   *  Sets the backing store from the canvas's CSS size, so call it AFTER layout and again
   *  on window resize. Pass dpr to override devicePixelRatio (e.g. cap it at 1.5).
   *  Returns the backing-store size it chose, or null if the canvas has no CSS size yet.
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
    const s = Math.max(0.05, Math.min(4, +scale || 1));
    const requestedDpr = (opts && opts.dpr != null)
      ? +opts.dpr
      : (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const dpr = Number.isFinite(requestedDpr) && requestedDpr > 0 ? requestedDpr : 1;
    // CSS size. An offscreen canvas has no client box — fall back to its current backing
    // store, which lets a caller re-scale relative to whatever it last set.
    const cssW = ('clientWidth' in cnv ? cnv.clientWidth : 0)
      || (cnv.width / Math.max(R._resScale * (R._resDpr || 1), 1e-6));
    const cssH = ('clientHeight' in cnv ? cnv.clientHeight : 0)
      || (cnv.height / Math.max(R._resScale * (R._resDpr || 1), 1e-6));
    if (!(cssW >= 1) || !(cssH >= 1)) return null;
    const w = Math.max(1, Math.round(cssW * dpr * s));
    const h = Math.max(1, Math.round(cssH * dpr * s));
    R._resScale = s;
    R._resDpr = dpr;
    if (cnv.width === w && cnv.height === h) return [w, h];   // nothing moved
    cnv.width = w; cnv.height = h;
    R._explicitViewport = null;      // go back to reading the (new) drawing buffer
    if (R._invalidateSizedResources) R._invalidateSizedResources();
    R._lastSeenW = w; R._lastSeenH = h;
    return [w, h];
  }

  function setViewport(widthPx, heightPx, dpr) {
    if (widthPx == null) { R._explicitViewport = null; }
    else {
      const w = Math.max(1, widthPx | 0);
      const h = Math.max(1, (heightPx == null ? widthPx : heightPx) | 0);
      R._explicitViewport = [w, h];
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
    R._scissor = [x | 0, y | 0, Math.max(0, w | 0), Math.max(0, h | 0)];
    gl.scissor(R._scissor[0], R._scissor[1], R._scissor[2], R._scissor[3]);
    gl.enable(gl.SCISSOR_TEST);
  }

  /** Disable the user scissor; subsequent draws cover the full
   *  viewport. Idempotent.
   */
  function clearScissorRect() {
    R._scissor = null;
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Begin a frame. Clears to clearColor (or skips clear when null).
   *  Subsequent drawBundle() calls accumulate into the same target.
   *  @param {[number,number,number,number]|null} [clearColor]
   */
  function beginFrame(clearColor) {
    R._frameSerial = (R._frameSerial | 0) + 1;   // per-frame serial (build-pool epoch)
    if (R._contextLost || _canvasUnsized()) {
      // These frames never reach endFrame, so anything already submitted would otherwise
      // accumulate until the canvas comes back and then paint a stale backlog at once.
      _submitQ = []; _submitSeq = 0;
      return;
    }
    if (R._inFrame) endFrame();
    R._inFrame = true;
    const cc = clearColor === undefined ? _DEFAULT_CLEAR : clearColor;
    _frameClearColor = cc;
    if (R._captureFrames) { R._frameLog = []; R._lastFrameClearColor = cc; }
    const [cw, ch] = viewportSize();
    // The canvas can be resized by ANYONE — a window resize, a layout change, our own
    // setResolutionScale. Everything sized to it (RT pools, filter caches, offscreen
    // targets) is stale the moment it moves, and nothing was noticing: the pools bucket by
    // size, so they quietly allocated a fresh set and leaked the old one.
    if (cw !== R._lastSeenW || ch !== R._lastSeenH) {
      if (R._lastSeenW && R._invalidateSizedResources) R._invalidateSizedResources();
      R._lastSeenW = cw; R._lastSeenH = ch;
    }
    gl.viewport(0, 0, cw, ch);
    if (cc) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.clearStencil(0);
      gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
      gl.clearDepth(1.0);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.depthMask(false);
    }
    // Compile and pipeline-warm at most one fill variant per frame, BEFORE any draw. Keeps the
    // driver's first-draw pipeline build off the frame that first shows a bundle.
    if (R.fillWarmTick) R.fillWarmTick();
  }

  // ---- zOrder submission queue -------------------------------------------
  // Mantle paints in painter's order: whatever calls drawBundle first ends up underneath.
  // That makes MOUNT order the stacking order, which is unstable as soon as anything mounts
  // asynchronously (an overlay that finishes loading a font after the HUD, a feedback flash).
  // Consumers were each having to keep their own sorted mount list and call drawBundle in the
  // right sequence; this owns that instead.
  //
  //   r.beginFrame(clear);
  //   r.submitBundle(hud,   { zOrder: 300 });
  //   r.submitBundle(bg,    { zOrder: 0 });     // submitted later, still paints FIRST
  //   r.endFrame();                             // sorts, then paints
  //
  // Semantics (deliberately Unity's, so JS and the C# port agree — that side delegates the
  // same job to MeshRenderer.sortingLayerID + sortingOrder):
  //   * LOWER zOrder paints EARLIER, i.e. underneath. Default 0.
  //   * Equal zOrder keeps SUBMISSION order — a stable tiebreak, so re-submitting the same
  //     scene with unchanged z is bit-identical frame to frame.
  //   * drawBundle() is untouched and still paints immediately. Mixing the two in one frame
  //     is allowed and well-defined: immediate draws land when called, so they sit UNDER
  //     everything submitted (which all paints at endFrame).
  /** @type {{target:any, opts:any, z:number, seq:number}[]} */
  let _submitQ = [];
  let _submitSeq = 0;

  function submitBundle(target, opts) {
    if (R._contextLost || !target) return;
    // Outside a frame there is nothing to defer to — behave like drawBundle so a stray
    // submit is never silently dropped.
    if (!R._inFrame) { R.drawBundle(target, opts); return; }
    const z = (opts && typeof opts.zOrder === 'number' && isFinite(opts.zOrder)) ? opts.zOrder : 0;
    _submitQ.push({ target, opts: opts || null, z, seq: _submitSeq++ });
  }

  function _flushSubmitQueue() {
    const q = _submitQ;
    if (!q.length) return;
    // Callers commonly re-z every frame (parallax / depth fog) while the RELATIVE order
    // barely moves, so check for already-sorted in O(n) and skip the comparator entirely.
    // Output-identical either way.
    let ordered = true;
    for (let i = 1; i < q.length; i++) {
      const p = q[i - 1], c = q[i];
      if (p.z > c.z || (p.z === c.z && p.seq > c.seq)) { ordered = false; break; }
    }
    if (!ordered) q.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.seq - b.seq));
    // Reset BEFORE painting: drawBundle can re-enter the frame API (a morph handle that
    // rebuilds, a group that nests), and a submit issued during the flush must not append to
    // the list being walked.
    _submitQ = [];
    _submitSeq = 0;
    for (let i = 0; i < q.length; i++) R.drawBundle(q[i].target, q[i].opts);
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
    _frameClearColor = null;
    R.draw.overrides = null;
    R.draw.worldM = null;
    // Implicit scissor reset per setScissorRect contract: each frame
    // starts un-scissored. Callers that want a scissored region must
    // re-issue setScissorRect inside the next beginFrame/endFrame pair.
    if (R._scissor) clearScissorRect();
    // Leave per-draw uniforms in their default
    // state so the next frame's first draw starts clean. The next
    // beginFillPass writes uHasOverrides / uHasWorldM unconditionally,
    // so we don't need to issue uniform writes here.
  }

  // ── SVG-export frame recorder ─────────────────────────────────────
  // Snapshot the draw-time options the native replay needs. References
  // (override table, worldMatrix, colorMatrix, palette handle) are held
  // as-is — export reads their CURRENT state, which is exactly the last
  // frame's. Scalars are copied so a caller reusing one opts object
  // across draws doesn't alias. No geometry is touched.
  function _recordBundleDraw(bundle, opts) {
    const o = opts || {};
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
      opts: {
        worldMatrix: o.worldMatrix || null,
        overrides: o.overrides || null,
        alpha: typeof o.alpha === 'number' ? o.alpha : 1,
        colorMatrix: o.colorMatrix || null,
        colorMatrixOffset: o.colorMatrixOffset || null,
        palette: o.palette || null,
        paletteChannel: o.paletteChannel,
        channelLerp: o.channelLerp || null,
      },
    });
  }

  function _recordImageDraw(source, opts) {
    R._frameLog.push({ kind: 'image', source, opts: opts ? { ...opts } : {} });
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
