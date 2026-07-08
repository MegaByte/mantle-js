// clipDraw.js — external screen-space clip subsystem, split out of renderer.js.
//
// Owns: renderClipCoverage (render a clip BUNDLE to a framebuffer-aligned
// coverage RT and hand back a caller-owned texture), the per-bundle node-clip
// registry (setNodeClip / clearNodeClip / _autoNodeClip), and their teardown
// (_disposeNodeClips, called by renderer.dispose).
//
// renderClipCoverage saves/restores the whole per-draw state block + the active
// handle around a re-entrant _renderCanvasInner() into an offscreen FBO; every
// one of those (R._handle, the R._draw* recolor state, R._inFrame,
// R.fillPassCanvasW/H) is a live get/set bridge on R, so this module drives them
// through R.x and renderer.js sees the same closure vars. Stable helpers (gl,
// viewportSize, bindFb, createBundleHandle, _renderCanvasInner, _canvasUnsized)
// are destructured at attach time — attachClipDraw runs LATE in _runInit, after
// the Object.assign that publishes them.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachClipDraw(R) {
  const { gl, viewportSize, bindFb, createBundleHandle, _renderCanvasInner, _canvasUnsized } = R;

  // A reusable FBO container; each renderClipCoverage call attaches a FRESH
  // caller-owned texture (so N concurrent clips don't clobber each other).
  let _clipCovFbo = null;
  let _clipCovHandle = null, _clipCovBundle = null;
  const _nodeClips = new Map();   // targetBundle -> { tex, mode }

  // Render a clip BUNDLE to a framebuffer-aligned coverage RT via the coverage
  // fill pipeline (analytic, at OUTPUT resolution) and return a NEW WebGLTexture
  // the caller owns. The .a channel is the silhouette coverage; pass the
  // texture as drawBundle/drawInstance `opts.extClipTex` (+ `extClipMode`
  // 1=clip-IN, 2=clip-OUT) and free it with R.deleteClipTexture. This is the
  // resolution-independent replacement for a consumer-rasterized bitmap clip:
  // the clip is a STATIONARY screen-space mask (gl_FragCoord-sampled) that
  // moving content is drawn through — the case Mantle's intra-bundle <mask>
  // (which moves WITH its bundle) can't express. Re-call (and delete the old
  // texture) when the clip shape, placement (worldMatrix), or viewport changes.
  //
  // The clip bundle must be plain coverage — opaque fills, no nested groups /
  // masks / filters (the group-composite path binds the default framebuffer);
  // a silhouette mask SVG satisfies this. Reuses the static-cache bake
  // mechanism: bind an FBO, then _renderCanvasInner draws the bundle into it.
  function renderClipCoverage(target, opts = {}) {
    if (R._contextLost || _canvasUnsized()) return null;
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return null;
    const [cw, ch] = viewportSize();
    // Fresh caller-owned coverage texture sized to the framebuffer.
    const covTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, covTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!_clipCovFbo) _clipCovFbo = gl.createFramebuffer();
    bindFb(gl.FRAMEBUFFER, _clipCovFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, covTex, 0);
    bindFb(gl.FRAMEBUFFER, null);
    const _clipCovW = cw, _clipCovH = ch;
    // Save caller per-draw state.
    const sH = R._handle, sWM = R.draw.worldM, sAl = R.draw.alpha, sOv = R.draw.overrides,
          sCM = R.draw.colorMatrix, sCMO = R.draw.colorMatrixOffset, sPal = R.draw.palette,
          sPC = R.draw.paletteChannel, sCL = R.draw.channelLerp, sEC = R.draw.extClipTex,
          sECM = R.draw.extClipMode, sSR = R.draw.shapeRange;
    let ok = false;
    try {
      // Persistent handle for this clip bundle — own VAO/VBO, kept across calls
      // (NOT via setBundle, which would dispose the caller's _handle).
      if (_clipCovBundle !== bundle) {
        const nextHandle = createBundleHandle(bundle);
        if (_clipCovHandle) _clipCovHandle.dispose();
        _clipCovHandle = nextHandle;
        _clipCovBundle = bundle;
      }
      // Neutral state + the clip's placement matrix.
      R._handle = _clipCovHandle;
      R.draw.worldM = opts.worldMatrix || null;
      R.draw.alpha = 1.0; R.draw.overrides = null;
      R.draw.colorMatrix = null; R.draw.colorMatrixOffset = null;
      R.draw.palette = null; R.draw.paletteChannel = 0; R.draw.channelLerp = null;
      R.draw.extClipTex = null; R.draw.extClipMode = 0; R.draw.shapeRange = null;
      R._handle.fillPassAssetDirty = true;
      R.fillPassCanvasW = 0; R.fillPassCanvasH = 0;
      // Draw the bundle into the clip FBO.
      bindFb(gl.FRAMEBUFFER, _clipCovFbo);
      gl.viewport(0, 0, _clipCovW, _clipCovH);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clearDepth(1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // _inFrame=true so _renderCanvasInner keeps OUR transparent color clear
      // (its standalone branch would re-clear the RT to opaque white). The bake
      // guard skips the cache tick on the re-entrant draw.
      const wasInFrame = R._inFrame;
      R._cacheBakingNow = true; R._inFrame = true;
      try { _renderCanvasInner(); }
      finally { R._cacheBakingNow = false; R._inFrame = wasInFrame; }
      ok = true;
      return covTex;
    } finally {
      // Restore caller state + default target even when the clip render throws;
      // otherwise the next normal draw inherits the temporary clip handle/state.
      bindFb(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      R._handle = sH; R.draw.worldM = sWM; R.draw.alpha = sAl; R.draw.overrides = sOv;
      R.draw.colorMatrix = sCM; R.draw.colorMatrixOffset = sCMO; R.draw.palette = sPal;
      R.draw.paletteChannel = sPC; R.draw.channelLerp = sCL; R.draw.extClipTex = sEC;
      R.draw.extClipMode = sECM; R.draw.shapeRange = sSR;
      if (sH) sH.fillPassAssetDirty = true;
      R.fillPassCanvasW = 0; R.fillPassCanvasH = 0;
      if (!ok && covTex) gl.deleteTexture(covTex);
    }
  }

  // ── Per-bundle external clip (setNodeClip) ───────────────────────────
  // Mirrors the native scene's model so a consumer needs NO backend branch:
  // register a stationary screen-space clip against a TARGET bundle, and the
  // renderer auto-applies it on every draw of that bundle (drawBundle /
  // drawInstance / handle.draw). The coverage is rendered once via
  // renderClipCoverage (coverage); re-call setNodeClip when the clip placement or
  // the viewport changes (the worldMatrix is the consumer's to recompute).
  function setNodeClip(target, opts) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    clearNodeClip(bundle);
    if (!opts) return;
    const clipSrc = opts.clipBundle !== undefined ? opts.clipBundle : opts.bundle;
    const clipBundle = clipSrc && clipSrc.bundle !== undefined ? clipSrc.bundle : clipSrc;
    if (!clipBundle) return;
    const tex = renderClipCoverage(clipBundle, { worldMatrix: opts.worldMatrix });
    if (!tex) return;
    _nodeClips.set(bundle, { tex, mode: opts.mode === 'out' ? 2 : 1 });
  }

  function clearNodeClip(target) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    const c = bundle && _nodeClips.get(bundle);
    if (c) { gl.deleteTexture(c.tex); _nodeClips.delete(bundle); }
  }

  // If a draw didn't set an explicit extClipTex but its bundle has a
  // registered node-clip, fold the clip in. Called by each draw entry after
  // it resolves opts.extClipTex.
  function _autoNodeClip(bundle) {
    if (R.draw.extClipTex || _nodeClips.size === 0 || !bundle) return;
    const c = _nodeClips.get(bundle);
    if (c) { R.draw.extClipTex = c.tex; R.draw.extClipMode = c.mode; }
  }

  // Teardown for renderer.dispose(): the renderClipCoverage FBO, its persistent
  // clip handle, and every per-bundle node-clip coverage texture.
  function _disposeNodeClips() {
    if (_clipCovFbo) { gl.deleteFramebuffer(_clipCovFbo); _clipCovFbo = null; }
    if (_clipCovHandle) { _clipCovHandle.dispose(); _clipCovHandle = null; _clipCovBundle = null; }
    for (const c of _nodeClips.values()) gl.deleteTexture(c.tex);
    _nodeClips.clear();
  }

  // Context-loss forget: drop our GPU-handle refs WITHOUT deleting (post-loss
  // they're dangling; node-clip textures are caller-owned). renderClipCoverage /
  // setNodeClip rebuild on next use.
  function _forgetClipState() {
    _clipCovFbo = null; _clipCovHandle = null; _clipCovBundle = null;
    _nodeClips.clear();
  }

  R.renderClipCoverage = renderClipCoverage;
  R.setNodeClip = setNodeClip;
  R.clearNodeClip = clearNodeClip;
  R._autoNodeClip = _autoNodeClip;
  R._disposeNodeClips = _disposeNodeClips;
  R._forgetClipState = _forgetClipState;
}
