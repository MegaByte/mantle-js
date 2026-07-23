// maskBake.js — offscreen <mask> coverage bake, split out of renderer.js.
//
// Owns: the mask RT texture-array ("ping") + its FBO, the nested-mask depth-1
// "pong" snapshot array, the two 1×1 dummy samplers, the bake's full-region
// quad VAO/VBO, and the bake pass itself (bakeMaskRegions / bakeOneRegion /
// copyPingToPong) plus the re-bake key helper (_maskFeedShapeGen).
//
// bakeMaskRegions runs ONCE per render() (before the fill pass) when the bundle
// has FLAG_MASK_BEGIN regions; _renderCanvasInner then binds R._maskRTArray on
// its mask sampler unit. The ~24 maskBake program uniforms are self-derived
// here from R.maskBakeProg (captured once, never rebuilt). The active handle +
// per-draw override plane are read via R.x at bake time. Stable helpers (gl,
// viewportSize, arScale, bindFb, the dummy textures) are destructured at attach
// time — attachMaskBake runs after the Object.assign that publishes them.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachMaskBake(R) {
  const { gl, viewportSize, arScale, bindFb,
          dummyDashTex, dummyGradientTex, dummyGradientStops } = R;

  // ── maskBake program uniform locations (derived once from R.maskBakeProg) ──
  const mbUCurve  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uCurveData')         : null;
  const mbUBand   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uBandData')          : null;
  const mbUMeta   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMetaTex')           : null;
  const mbUDash   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uDashTex')           : null;
  const mbUGrad   = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientTex')       : null;
  const mbUGStops = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientStops')     : null;
  const mbUImage  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uImageTex')          : null;
  const mbUAtlasS = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uImageAtlasSize')    : null;
  const mbUFilter = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uFilterTex')         : null;
  const mbUGCount = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientCount')     : null;
  const mbUGStopsCnt = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGradientStopsCount') : null;
  const mbUGBB    = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uGlobalBBox')        : null;
  const mbUEmBBox = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskEmBBox')        : null;
  const mbUCanvasAR = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uCanvasAR')        : null;
  const mbURow    = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskChildRow1Based'): null;
  const mbUIsLum  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskIsLuminance')   : null;
  const mbUMaskRTArrayPong       = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskRTArrayPong')       : null;
  const mbUMaskRowToLayerTexBake = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskRowToLayerTexBake') : null;
  const mbUViewportSize          = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uViewportSize')          : null;
  const mbUOverrideTex  = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uOverrideTex')  : null;
  const mbUHasOverrides = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uHasOverrides') : null;
  const mbUOwnRow                = R.maskBakeProg ? gl.getUniformLocation(R.maskBakeProg, 'uMaskOwnRow')            : null;

  // Mask RT texture-array ("ping" = write target) + its single FBO.
  let _maskRTArray = null;
  let _maskBakeFbo = null;
  const _maskRTSize = [0, 0, 0];   // (w, h, depth) currently allocated
  // Nested-mask depth-1 "pong" array: a frozen copy of the ping array after
  // Pass 1. Lazy-alloc'd only when at least one region has hasInnerMask=true.
  let _maskRTArrayPong = null;
  const _maskRTSizePong = [0, 0, 0];
  let _maskBakeCopyFbo = null;     // read FBO used to blit ping → pong layer

  // 4-vertex VAO + buffer for the bake's full-region quad: aUV in [0,1]².
  const maskBakeVao = gl.createVertexArray();
  const maskBakeBuf = gl.createBuffer();
  gl.bindVertexArray(maskBakeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, maskBakeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // FNV-mix the override generation of every mask child across all regions.
  // The bake applies each child's override transform (animated <mask>), so the
  // mask-bake cache must re-bake when ANY mask child's override changes — the
  // filter cache uses the same per-feeding-shape generation key. Returns 0
  // (stable) when no override table is bound (static masks).
  function _maskFeedShapeGen() {
    const ov = R.draw.overrides;
    if (!ov || !ov.shapeGenOf || !R._handle) return 0;
    const regions = R._handle.maskRegions;
    let h = 2166136261;
    for (let r = 0; r < regions.length; r++) {
      const reg = regions[r];
      for (let row = reg.firstChild; row <= reg.lastChild; row++) {
        h ^= (ov.shapeGenOf(row) >>> 0);
        h = (h * 16777619) >>> 0;
      }
    }
    return h >>> 0;
  }

  function ensureMaskRTArray(depth) {
    const [cw, ch] = viewportSize();
    if (depth <= 0) return;
    if (_maskRTArray
        && _maskRTSize[0] === cw && _maskRTSize[1] === ch
        && _maskRTSize[2] >= depth) return;
    if (_maskRTArray) gl.deleteTexture(_maskRTArray);
    if (_maskBakeFbo) gl.deleteFramebuffer(_maskBakeFbo);
    _maskRTArray = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTArray);
    // R8 is enough — bake writes vec4(a,a,a,a) but only .r is sampled
    // (single-channel mask RT). Saves 4× the memory.
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, cw, ch, depth, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    _maskBakeFbo = gl.createFramebuffer();
    _maskRTSize[0] = cw; _maskRTSize[1] = ch; _maskRTSize[2] = depth;
  }

  function ensureMaskRTArrayPong(depth) {
    const [cw, ch] = viewportSize();
    if (depth <= 0) return;
    if (_maskRTArrayPong
        && _maskRTSizePong[0] === cw && _maskRTSizePong[1] === ch
        && _maskRTSizePong[2] >= depth) return;
    if (_maskRTArrayPong) gl.deleteTexture(_maskRTArrayPong);
    if (_maskBakeCopyFbo) gl.deleteFramebuffer(_maskBakeCopyFbo);
    _maskRTArrayPong = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTArrayPong);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, cw, ch, depth, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    _maskBakeCopyFbo = gl.createFramebuffer();
    _maskRTSizePong[0] = cw; _maskRTSizePong[1] = ch; _maskRTSizePong[2] = depth;
  }

  // Dummy 1×1×1 R8 array, bound to TEXTURE9 when uHasOffscreenMask=0
  // so the sampler unit stays in a valid state (WebGL2 requires
  // declared samplers to have a binding even when never sampled).
  let _maskRTDummy = null;
  function maskRTDummy() {
    if (_maskRTDummy) return _maskRTDummy;
    _maskRTDummy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTDummy);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return _maskRTDummy;
  }
  // Companion dummy 1×1 R32I texture for the rowToLayer sampler unit.
  let _maskRowToLayerDummy = null;
  function maskRowToLayerDummy() {
    if (_maskRowToLayerDummy) return _maskRowToLayerDummy;
    _maskRowToLayerDummy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _maskRowToLayerDummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 1, 1, 0, gl.RED_INTEGER, gl.INT, new Int32Array([-1]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return _maskRowToLayerDummy;
  }

  // Bake all regions of the current bundle into _maskRTArray's layers.
  // Called once per render() (before processing the drawList) when the
  // bundle has any FLAG_MASK_BEGIN regions and R.maskBakeProg is available.
  function bakeMaskRegions() {
    if (!R.maskBakeProg || !R._handle || !R._handle.bundle || !R._handle.maskRegions.length) return;
    const regions = R._handle.maskRegions;
    ensureMaskRTArray(regions.length);
    const b = R._handle.bundle;
    const [cw, ch] = viewportSize();
    const [sx, sy] = arScale(b.globalBBox, cw, ch);

    // Detect whether the ping-pong second pass is needed: any region
    // whose children carry an inner-mask reference. Most bundles have
    // none → single pass, no Pong alloc, no extra blit.
    let anyInnerMask = false;
    for (let r = 0; r < regions.length; r++) {
      if (regions[r].hasInnerMask) { anyInnerMask = true; break; }
    }
    if (anyInnerMask) ensureMaskRTArrayPong(regions.length);

    gl.useProgram(R.maskBakeProg);
    // Bind the bake program's bundle textures (same set as mantle.frag).
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.curveTex); gl.uniform1i(mbUCurve, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.bandTex);  gl.uniform1i(mbUBand, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, b.metaTex);  gl.uniform1i(mbUMeta, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, b.dashTex || dummyDashTex); gl.uniform1i(mbUDash, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, b.gradientTex || dummyGradientTex); gl.uniform1i(mbUGrad, 4);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, b.gradientStopsTex || dummyGradientStops); gl.uniform1i(mbUGStops, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, b.imageAtlasTex || dummyGradientStops); gl.uniform1i(mbUImage, 6);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, b.filterTex || dummyGradientTex); gl.uniform1i(mbUFilter, 7);
    gl.uniform2f(mbUAtlasS, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
    gl.uniform1i(mbUGCount, b.gradientCount | 0);
    gl.uniform1i(mbUGStopsCnt, b.gradientStopsCount | 0);
    gl.uniform4f(mbUGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
    gl.uniform2f(mbUCanvasAR, sx, sy);

    // Nested-mask sample bindings. Pass 1 always binds the dummy
    // (regions in pass 1 don't read any prior bake). Pass 2 swaps in
    // the pong array. The row→layer lookup is the same texture in
    // both passes (matches the visible-shape binding).
    if (mbUMaskRTArrayPong) {
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskRTDummy());
      gl.uniform1i(mbUMaskRTArrayPong, 11);
    }
    if (mbUMaskRowToLayerTexBake) {
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, R._handle.maskRowToLayerTex || maskRowToLayerDummy());
      gl.uniform1i(mbUMaskRowToLayerTexBake, 12);
    }
    if (mbUViewportSize) gl.uniform2f(mbUViewportSize, cw, ch);

    // Override plane on unit 8 (same as the main fill pass) so animated
    // <mask> children bake at their transformed position. CRUCIAL: the bake
    // runs BEFORE the fill pass (beginFillPass), so we must uploadIfDirty()
    // here — otherwise the override texture is allocated-but-empty at bake
    // time and every child reads a zero transform (the mask would freeze).
    // No overrides → dummy + uHasOverrides=0 (static mask).
    if (mbUOverrideTex) {
      const ov = R.draw.overrides;
      gl.activeTexture(gl.TEXTURE8);
      if (ov && ov.uploadIfDirty && ov.texture) {
        ov.uploadIfDirty();
        gl.bindTexture(gl.TEXTURE_2D, ov.texture);
        gl.uniform1i(mbUOverrideTex, 8);
        if (mbUHasOverrides) gl.uniform1i(mbUHasOverrides, 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, dummyGradientTex);
        gl.uniform1i(mbUOverrideTex, 8);
        if (mbUHasOverrides) gl.uniform1i(mbUHasOverrides, 0);
      }
    }

    bindFb(gl.FRAMEBUFFER, _maskBakeFbo);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    // Blend One One — additive accumulation of per-child
    // weighted coverage. Spec divergence from per-fragment src-over
    // documented in maskBake.frag.glsl.
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(maskBakeVao);

    // -- Pass 1: regions without inner-mask refs --
    // These regions can bake straight into the ping array; their
    // children sample at most the dummy (no-op), so no feedback.
    for (let r = 0; r < regions.length; r++) {
      const reg = regions[r];
      if (reg.hasInnerMask) continue;
      bakeOneRegion(reg, r);
    }

    // -- Pass 2: regions with inner-mask refs --
    // Snapshot ping → pong so Pass 2 can sample the Pass 1 results
    // without forming a read-write loop. Then bake the remaining
    // regions; the shader's inner-mask sample reads from pong on
    // sampler unit 11 while writing to ping via the FBO attachment.
    if (anyInnerMask) {
      copyPingToPong(regions.length);
      // Swap pong onto the bake's inner-mask sampler.
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, _maskRTArrayPong);
      gl.uniform1i(mbUMaskRTArrayPong, 11);
      // Re-bind the bake FBO (the copy switched it to the copy FBO).
      bindFb(gl.FRAMEBUFFER, _maskBakeFbo);
      gl.viewport(0, 0, cw, ch);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(maskBakeVao);
      for (let r = 0; r < regions.length; r++) {
        const reg = regions[r];
        if (!reg.hasInnerMask) continue;
        bakeOneRegion(reg, r);
      }
      // Restore dummy on inner-mask sampler so a subsequent frame's
      // Pass 1 doesn't accidentally read stale pong content.
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, maskRTDummy());
    }

    gl.bindVertexArray(null);
    bindFb(gl.FRAMEBUFFER, null);
    // Restore src-over for downstream passes.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  // Inline helper used by both passes. Reads bake-program uniforms
  // already bound in bakeMaskRegions().
  function bakeOneRegion(reg, layerIdx) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskRTArray, 0, layerIdx);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(mbUEmBBox, reg.emBBox[0], reg.emBBox[1], reg.emBBox[2], reg.emBBox[3]);
    gl.uniform1i(mbUIsLum, reg.isLuminance | 0);
    if (mbUOwnRow) gl.uniform1i(mbUOwnRow, reg.maskRow | 0);
    // Walk every child row, including the FLAG_MASK_BEGIN row itself
    // (it carries the first child shape's geometry — its bbox bracket
    // doesn't preclude it being a renderable shape too).
    for (let row = reg.firstChild; row <= reg.lastChild; row++) {
      gl.uniform1i(mbURow, row + 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Blit each layer of the ping array onto the matching layer of the
  // pong array via a read FBO + draw FBO blitFramebuffer. Done once
  // per frame, between Pass 1 and Pass 2 of bakeMaskRegions().
  function copyPingToPong(depth) {
    const [cw, ch] = viewportSize();
    for (let l = 0; l < depth; l++) {
      bindFb(gl.READ_FRAMEBUFFER, _maskBakeCopyFbo);
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskRTArray, 0, l);
      bindFb(gl.DRAW_FRAMEBUFFER, _maskBakeFbo);
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, _maskRTArrayPong, 0, l);
      gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    bindFb(gl.READ_FRAMEBUFFER, null);
    bindFb(gl.DRAW_FRAMEBUFFER, null);
  }

  // Full teardown for renderer.dispose(): delete every mask GL resource.
  function _disposeMaskBake() {
    for (const t of [_maskRTArray, _maskRTArrayPong, _maskRTDummy, _maskRowToLayerDummy]) if (t) gl.deleteTexture(t);
    if (_maskBakeFbo) gl.deleteFramebuffer(_maskBakeFbo);
    if (_maskBakeCopyFbo) gl.deleteFramebuffer(_maskBakeCopyFbo);
    if (maskBakeVao) gl.deleteVertexArray(maskBakeVao);
    if (maskBakeBuf) gl.deleteBuffer(maskBakeBuf);
    _maskRTArray = null; _maskBakeFbo = null;
    _maskRTArrayPong = null; _maskBakeCopyFbo = null;
    _maskRTDummy = null; _maskRowToLayerDummy = null;
    _maskRTSize[0] = _maskRTSize[1] = _maskRTSize[2] = 0;
    _maskRTSizePong[0] = _maskRTSizePong[1] = _maskRTSizePong[2] = 0;
  }

  // Context-loss forget: drop RT-array/FBO refs WITHOUT deleting (post-loss
  // they're dangling). ensureMaskRTArray rebuilds on the next bake, and the
  // nulled dummy samplers are recreated lazily by their accessors. The bake
  // quad VAO/VBO are created once at attach and are NOT nulled here — a truly
  // lost context needs the consumer to dispose() + recreate the renderer.
  function _forgetMaskBake() {
    _maskRTArray = null; _maskBakeFbo = null;
    _maskRTArrayPong = null; _maskBakeCopyFbo = null;
    _maskRTDummy = null; _maskRowToLayerDummy = null;
    _maskRTSize[0] = _maskRTSize[1] = _maskRTSize[2] = 0;
    _maskRTSizePong[0] = _maskRTSizePong[1] = _maskRTSizePong[2] = 0;
  }

  // The unit-quad VAO/VBO is shared: drawImages.js draws its image quad on it.
  R.maskBakeVao = maskBakeVao;
  R.maskBakeBuf = maskBakeBuf;
  Object.defineProperty(R, '_maskRTArray', { get: () => _maskRTArray, configurable: true });
  R.bakeMaskRegions = bakeMaskRegions;
  R.maskRTDummy = maskRTDummy;
  R.maskRowToLayerDummy = maskRowToLayerDummy;
  R._maskFeedShapeGen = _maskFeedShapeGen;
  R._disposeMaskBake = _disposeMaskBake;
  R._forgetMaskBake = _forgetMaskBake;
}
