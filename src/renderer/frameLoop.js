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
    R._handle.fillPassAssetDirty = true;
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
    if (R._contextLost || _canvasUnsized()) return;
    if (R._inFrame) endFrame();
    R._inFrame = true;
    const cc = clearColor === undefined ? [1, 1, 1, 1] : clearColor;
    _frameClearColor = cc;
    if (R._captureFrames) { R._frameLog = []; R._lastFrameClearColor = cc; }
    const [cw, ch] = viewportSize();
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
  }

  /** End the current frame. Idempotent. */
  function endFrame() {
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
   *  On by default; turn off to drop the (small) per-draw bookkeeping
   *  when SVG export is never used. Returns the new state. */
  function setFrameCapture(on) {
    R._captureFrames = !!on;
    if (!R._captureFrames) R._frameLog = [];
    return R._captureFrames;
  }

  R.invalidateRenderState = invalidateRenderState;
  R.markGeometryDirty = markGeometryDirty;
  R.setViewport = setViewport;
  R.setScissorRect = setScissorRect;
  R.clearScissorRect = clearScissorRect;
  R.beginFrame = beginFrame;
  R.endFrame = endFrame;
  R._recordBundleDraw = _recordBundleDraw;
  R._recordImageDraw = _recordImageDraw;
  R.setFrameCapture = setFrameCapture;
}
