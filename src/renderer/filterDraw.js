// filterDraw.js — SVG filter-graph draw (cache keys, FBO composite, scissor,
// blur/morphology/convolve in-place passes). Attached onto the renderer context.

import { computeNodeBboxes } from '../filterGraph/bbox.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachFilterDraw(R) {
  const { gl, coverVao, arScale, viewportSize, bindFb, ensurePingFbo } = R;

  // ── Uniform locations (derived once from the R-published programs) ─────
  // vUV → texture-uv maps. Every filter RT covers a canvas RECT, and an input's
  // rect need not be the output's; uv is an affine remap of vUV through the two.
  // See src/shaders/_filterRect.glsl. IDENTITY = (1, 1, 0, 0), which is what a
  // canvas-sized input in a canvas-sized pass gets.
  const compUShapeMap    = gl.getUniformLocation(R.compProg, 'uShapeMap');
  const compUDstMap      = gl.getUniformLocation(R.compProg, 'uDstMap');
  const compUShapeTex    = gl.getUniformLocation(R.compProg, 'uShapeTex');
  const compUDstTex      = gl.getUniformLocation(R.compProg, 'uDstTex');
  const compUBlendMode   = gl.getUniformLocation(R.compProg, 'uBlendMode');
  const compUOpacity     = gl.getUniformLocation(R.compProg, 'uOpacity');

  const blurUTex   = gl.getUniformLocation(R.blurProg, 'uTex');
  const blurUTexel = gl.getUniformLocation(R.blurProg, 'uTexel');
  const blurUInMap = gl.getUniformLocation(R.blurProg, 'uInMap');
  const blurUDir   = gl.getUniformLocation(R.blurProg, 'uDir');
  const blurUSigma = gl.getUniformLocation(R.blurProg, 'uSigma');

  const bbUTex    = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTex')    : null;
  const bbUTexel  = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTexel')  : null;
  const bbUInMap  = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uInMap')  : null;
  const bbUDir    = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uDir')    : null;
  const bbURadius = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uRadius') : null;

  const morphUTex      = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTex')      : null;
  const morphUTexel    = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTexel')    : null;
  const morphUInMap    = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uInMap')    : null;
  const morphUDir      = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uDir')      : null;
  const morphURadius   = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uRadius')   : null;
  const morphUOperator = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uOperator') : null;

  const convUTex       = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTex')           : null;
  const convUKernelTex = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernelTex')     : null;
  const convUTexel     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTexel')         : null;
  const convUInMap     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uInMap')         : null;
  const convUOrder     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uOrder')         : null;
  const convUTarget    = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTarget')        : null;
  const convUDivisor   = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uDivisor')       : null;
  const convUBias      = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uBias')          : null;
  const convUKernelRow = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernelRow')     : null;
  const convUEdgeMode  = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uEdgeMode')      : null;
  const convUPreserve  = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uPreserveAlpha') : null;

  const cmUTex  = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uTex')  : null;
  const cmUInMap = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uInMap') : null;
  const cmUM0   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM0')   : null;
  const cmUM1   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM1')   : null;
  const cmUM2   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM2')   : null;
  const cmUM3   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM3')   : null;
  const cmUMOff = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uMOff') : null;

  const fcUIn1 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1') : null;
  const fcUIn2 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2') : null;
  const fcUIn1Map = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1Map') : null;
  const fcUIn2Map = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2Map') : null;
  const fcUOp  = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uOp')  : null;
  const fcUK   = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uK')   : null;

  const fbUIn1  = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1')  : null;
  const fbUIn2  = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2')  : null;
  const fbUIn1Map = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1Map') : null;
  const fbUIn2Map = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2Map') : null;
  const fbUMode = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uMode') : null;

  const ftUTex  = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTex') : null;
  const ftUInMap = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uInMap') : null;

  const ftbUBaseFreq    = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uBaseFreq')   : null;
  const ftbUNumOctaves  = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uNumOctaves') : null;
  const ftbUSeed        = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uSeed')       : null;
  const ftbUKind        = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uKind')       : null;
  const ftbUTilePos     = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uTilePos')    : null;
  const ftbUTileSize    = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uTileSize')   : null;
  const ftbUStitch      = R.feTurbulenceProg ? gl.getUniformLocation(R.feTurbulenceProg, 'uStitch')     : null;
  const fimgUIn         = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uIn')          : null;
  const fimgUAtlasSize  = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasSize')   : null;
  const fimgUAtlasRect  = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uAtlasRect')   : null;
  const fimgUPreserveAR = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uPreserveAR')  : null;
  const fimgURegionMap  = R.feImageProg ? gl.getUniformLocation(R.feImageProg, 'uRegionMap')   : null;

  const fdUIn1   = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn1')   : null;
  const fdUIn2   = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn2')   : null;
  const fdUScale = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uScale') : null;
  const fdUTexel = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uTexel') : null;
  const fdUIn1Map = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn1Map') : null;
  const fdUIn2Map = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn2Map') : null;
  const fdUXChan = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uXChan') : null;
  const fdUYChan = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uYChan') : null;

  const flUIn           = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uIn')           : null;
  const flUTexel        = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uTexel')        : null;
  const flUInMap        = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uInMap')        : null;
  const flUOutRect      = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uOutRect')      : null;
  const flUWorldScale   = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uWorldScale')   : null;
  const flUSurfaceScale = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSurfaceScale') : null;
  const flUK            = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uK')            : null;
  const flUExponent     = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uExponent')     : null;
  const flULightColor   = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uLightColor')   : null;
  const flUMode         = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uMode')         : null;
  const flULightType    = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uLightType')    : null;
  const flULightPos     = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uLightPos')     : null;
  const flUSpotAt       = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotAt')       : null;
  const flUSpotExp      = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotExp')      : null;
  const flUSpotCosCone  = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uSpotCosCone')  : null;

  const fctUIn  = R.feComponentTransferProg ? gl.getUniformLocation(R.feComponentTransferProg, 'uIn')  : null;
  const fctUInMap = R.feComponentTransferProg ? gl.getUniformLocation(R.feComponentTransferProg, 'uInMap') : null;
  const fctULUT = R.feComponentTransferProg ? gl.getUniformLocation(R.feComponentTransferProg, 'uLUT') : null;

  // vUV → uv for a pass whose output and input cover the SAME rect (both the
  // whole canvas, in every case below). Identity — but it must still be UPLOADED:
  // an unset vec4 uniform is (0,0,0,0), which samples one texel forever.
  const IDENTITY_MAP = [1, 1, 0, 0];
  function setMap(loc, m) {
    if (loc) gl.uniform4f(loc, m[0], m[1], m[2], m[3]);
  }

  // ── Filter-result cache key compare ───────────────────────────
  function _filterKeyMatches(c, key) {
    return c && c.key
      && c.key.gen === key.gen
      && c.key.geomGen === key.geomGen
      && c.key.morphT === key.morphT
      && c.key.cw === key.cw && c.key.ch === key.ch
      && c.key.shapeGen === key.shapeGen
      && c.key.wmHash === key.wmHash
      && c.key.recolor === key.recolor;
  }
  function _wmHash(m) {
    // Cheap value hash of the column-major mat3 (or identity when null).
    if (!m) return 0;
    let h = 2166136261;
    for (let i = 0; i < 9; i++) {
      h ^= (Math.round(m[i] * 4096) | 0);
      h = (h * 16777619) >>> 0;
    }
    return h;
  }
  // Cheap value hash of the per-draw recolor state that beginFillPass
  // bakes into a filter's SourceGraphic (alpha, colorMatrix + offset,
  // channelLerp, paletteChannel, extClipMode, palette-present). The
  // filtered output is cached POST-recolor, so two draws of the same
  // bundle in one frame with different tints must key differently — else
  // the second draw composites the first's recolored texture. The
  // palette LUT is mutable with no version token, so only its presence is
  // hashed; an active-palette draw is additionally barred from hitting
  // the cache (see the filterHit/skHit guards below).
  function _recolorHash() {
    let h = 2166136261;
    const mix = (x) => { h ^= (x | 0); h = (h * 16777619) >>> 0; };
    mix(Math.round(R.draw.alpha * 4096));
    mix(R.draw.paletteChannel | 0);
    mix(R.draw.extClipMode | 0);
    mix(R.draw.palette ? 1 : 0);
    if (R.draw.colorMatrix) for (let i = 0; i < 16; i++) mix(Math.round(R.draw.colorMatrix[i] * 4096));
    else mix(0x9e3779b1 | 0);
    if (R.draw.colorMatrixOffset) for (let i = 0; i < 4; i++) mix(Math.round(R.draw.colorMatrixOffset[i] * 4096));
    else mix(0x85ebca77 | 0);
    if (R.draw.channelLerp) {
      const cl = R.draw.channelLerp;
      const arrs = [cl.primary || [0, 0, 0, 1], cl.contrast || [0, 0, 0, 1], cl.highlight || [1, 1, 1, 1]];
      for (const a of arrs)
        for (let i = 0; i < 4; i++) mix(Math.round((a[i] == null ? (i === 3 ? 1 : 0) : a[i]) * 4096));
    } else mix(0x27d4eb2f | 0);
    return h;
  }
  // Composite a (premultiplied) filtered texture over the backdrop into
  // `dstFbo` (null = canvas) — the tail step shared by the filter cache
  // hit + miss paths. Inside a group the caller passes the group
  // accumulator FBO so the filtered shape stays IN the group instead of
  // escaping to the canvas.
  // `srcRect` is the canvas rect the filtered texture covers — null = the whole
  // canvas. The backdrop always covers the canvas, so it takes the identity.
  function _compositeFilteredTex(filteredTex, backdropTex, cw, ch, dstFbo = null,
                                srcRect = null, backdropRect = null) {
    bindFb(gl.FRAMEBUFFER, dstFbo);
    // Draw only where the filter output lives. The graph is transparent outside
    // its root rect, so src-over there is a no-op — skipping it is free, and it
    // is the same fillrate saving the per-node scissor used to buy.
    if (srcRect) gl.viewport(srcRect[0], srcRect[1], srcRect[2], srcRect[3]);
    else gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(R.compProg);
    // vUV spans the ROOT RECT (the viewport above), so the filtered texture is read
    // 1:1. The backdrop is read through ITS rect — the canvas when it's a full
    // snapshot, the root rect when it's a rect-sized one (then also identity).
    const outR = srcRect || [0, 0, cw, ch];
    const dstR = backdropRect || [0, 0, cw, ch];
    setMap(compUShapeMap, IDENTITY_MAP);
    setMap(compUDstMap, [
      outR[2] / dstR[2], outR[3] / dstR[3],
      (outR[0] - dstR[0]) / dstR[2], (outR[1] - dstR[1]) / dstR[3],
    ]);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, filteredTex); gl.uniform1i(compUShapeTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, backdropTex); gl.uniform1i(compUDstTex, 1);
    gl.uniform1i(compUBlendMode, 0);
    gl.uniform1f(compUOpacity, 1);
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
  // Passthrough-draw a texture into an FBO (orientation-preserving copy).
  // Used by the single-kind filter cache to restore shapeFbo from a
  // cached texture on a hit. Uses coverVao + R.cacheBlitProg.
  function _blitTexToFbo(srcTex, dstFbo, cw, ch) {
    bindFb(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(R.cacheBlitProg);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(R.cbUCacheTex, 0);
    gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
    if (R.cbUInMap) gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);   // whole texture, 1:1
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
  // Allocate/reuse a persistent RGBA8 texture (+ its own FBO) named
  // `texField` on a cache entry, sized (cw,ch). Re-creates on resize.
  function _ensureCacheTex(entry, texField, cw, ch) {
    const fboField = texField + 'Fbo';
    if (entry[texField] && entry.w === cw && entry.h === ch) return;
    if (entry[texField]) { gl.deleteTexture(entry[texField]); gl.deleteFramebuffer(entry[fboField]); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    entry[texField] = tex; entry[fboField] = fbo;
  }
  // Build the SVG filter-graph dispatch context (programs + uniform handles +
  // source/backdrop RTs). Pure object construction over module program +
  // uniform consts — shared by render()'s filter-graph branch and the morph
  // route's offscreen filter path so the two can't drift.
  function _buildFilterCtx(cw, ch, pxPerEm, sourceRT, mainCopyRT) {
    return {
      gl, pool: R._rtPool, coverVao, w: cw, h: ch,
      worldScale: pxPerEm,
      sourceRT, mainCopyRT,
      blurProg: R.blurProg,
      blurU: { uTex: blurUTex, uTexel: blurUTexel, uInMap: blurUInMap, uDir: blurUDir, uSigma: blurUSigma },
      boxBlurProg: R.boxBlurProg,
      boxBlurU: R.boxBlurProg ? { uTex: bbUTex, uTexel: bbUTexel, uInMap: bbUInMap, uDir: bbUDir, uRadius: bbURadius } : null,
      morphProg: R.morphProg,
      morphU: R.morphProg ? { uTex: morphUTex, uTexel: morphUTexel, uInMap: morphUInMap, uDir: morphUDir, uRadius: morphURadius, uOperator: morphUOperator } : null,
      colorMatrixProg: R.colorMatrixProg,
      colorMatrixU: R.colorMatrixProg ? { uTex: cmUTex, uInMap: cmUInMap, uM0: cmUM0, uM1: cmUM1, uM2: cmUM2, uM3: cmUM3, uMOff: cmUMOff } : null,
      feCompositeProg: R.feCompositeProg,
      feCompositeU: R.feCompositeProg ? { uIn1: fcUIn1, uIn2: fcUIn2, uIn1Map: fcUIn1Map, uIn2Map: fcUIn2Map, uOp: fcUOp, uK: fcUK } : null,
      feBlendProg: R.feBlendProg,
      feBlendU: R.feBlendProg ? { uIn1: fbUIn1, uIn2: fbUIn2, uIn1Map: fbUIn1Map, uIn2Map: fbUIn2Map, uMode: fbUMode } : null,
      feTileProg: R.feTileProg,
      feTileU: R.feTileProg ? { uTex: ftUTex, uInMap: ftUInMap } : null,
      feTurbulenceProg: R.feTurbulenceProg,
      feTurbulenceU: R.feTurbulenceProg ? { uBaseFreq: ftbUBaseFreq, uNumOctaves: ftbUNumOctaves, uSeed: ftbUSeed, uKind: ftbUKind, uTilePos: ftbUTilePos, uTileSize: ftbUTileSize, uStitch: ftbUStitch } : null,
      feDisplacementMapProg: R.feDisplacementMapProg,
      feDisplacementMapU: R.feDisplacementMapProg ? { uIn1: fdUIn1, uIn2: fdUIn2, uIn1Map: fdUIn1Map, uIn2Map: fdUIn2Map, uScale: fdUScale, uTexel: fdUTexel, uXChan: fdUXChan, uYChan: fdUYChan } : null,
      feLightingProg: R.feLightingProg,
      feLightingU: R.feLightingProg ? { uIn: flUIn, uTexel: flUTexel, uInMap: flUInMap, uOutRect: flUOutRect, uWorldScale: flUWorldScale, uSurfaceScale: flUSurfaceScale, uK: flUK, uExponent: flUExponent, uLightColor: flULightColor, uMode: flUMode, uLightType: flULightType, uLightPos: flULightPos, uSpotAt: flUSpotAt, uSpotExp: flUSpotExp, uSpotCosCone: flUSpotCosCone } : null,
      feComponentTransferProg: R.feComponentTransferProg,
      feComponentTransferU: R.feComponentTransferProg ? { uIn: fctUIn, uInMap: fctUInMap, uLUT: fctULUT } : null,
      feImageProg: R.feImageProg,
      feImageU: R.feImageProg ? { uIn: fimgUIn, uAtlasSize: fimgUAtlasSize, uAtlasRect: fimgUAtlasRect, uPreserveAR: fimgUPreserveAR, uRegionMap: fimgURegionMap } : null,
      convolveProg: R.convolveProg,
      convolveU: R.convolveProg ? { uTex: convUTex, uKernelTex: convUKernelTex, uTexel: convUTexel, uInMap: convUInMap, uOrder: convUOrder, uTarget: convUTarget, uDivisor: convUDivisor, uBias: convUBias, uKernelRow: convUKernelRow, uEdgeMode: convUEdgeMode, uPreserveAlpha: convUPreserve } : null,
      bundle: R._handle.bundle,
    };
  }
  function _filterPxPerEm(cw, ch) {
    const b = R._handle.bundle;
    const [scX, scY] = arScale(b.globalBBox, cw, ch);
    const wM = R.draw.worldM;
    const wsX = wM ? Math.hypot(wM[0], wM[1]) : 1;
    const wsY = wM ? Math.hypot(wM[3], wM[4]) : 1;
    return [
      (cw * scX * wsX) / Math.max(b.globalBBox[2], 1e-6),
      (ch * scY * wsY) / Math.max(b.globalBBox[3], 1e-6),
    ];
  }
  // Per-node RECTS for a filter graph: the region of the canvas where each
  // node's output can be non-zero (the SourceGraphic bbox propagated through
  // the graph by computeNodeBboxes). Each node's RT is then allocated at its
  // own rect instead of at the full canvas — so a 200×150 card with a drop
  // shadow on a 1080p canvas evaluates its five nodes in ~600KB of RTs rather
  // than ~41MB, and shades only the pixels that can matter.
  //
  // Output-identical: a bounded primitive is transparent black beyond its bbox
  // by spec (Filter Effects §7), which is exactly what a consumer reads off the
  // rect's edge — sampleIn returns 0 outside the input's rect rather than the
  // clamped edge texel.
  //
  // Returns an array aligned with graph.nodes — each entry a rect
  // [x, y, w, h] in GL framebuffer pixels (origin bottom-left) — or null to
  // run the whole graph at canvas size.
  //
  // Sizes are rounded out to a 32px grid to improve exact-size pool reuse. The
  // texture still matches its quantized canvas rect at one pixel per pixel.
  //
  // Generator nodes (feFlood / feTurbulence / feImage / Paint*Gradient)
  // have no inputs and fill their whole output region uniformly;
  // computeNodeBboxes bounds them by the SHAPE bbox, which is too small
  // (a feFlood feeding a drop-shadow composite must cover the OFFSET-
  // BLURRED region, not just the shape). We resize each generator to the
  // union of its consumers' bboxes — but only when EVERY consumer samples
  // it POINTWISE (composite / blend / merge / colorMatrix / …), so the
  // consumer reads the generator strictly inside its own bbox. If any
  // consumer is a kernel/dilating node (blur / morphology / displacement)
  // or a tile, the generator runs full-canvas (safe, no clip).
  // The shape's own silhouette in top-left canvas px, or null when rects are off /
  // unsafe for this bundle. Shared by the graph route (where it seeds
  // computeNodeBboxes) and the single-kind route (which just dilates it by the
  // kernel's reach) so the two can't disagree about where the shape is.
  function _shapeBboxPx(shapeIdx, cw, ch) {
    if (!R._filterBboxEnabled) return null;
    const b = R._handle.bundle;
    // Nine-slice rewrites the fill cover-quad to the stretched target but leaves
    // the per-shape meta bbox (texels 0-3) at its NATIVE extent. Mapping that
    // native bbox through the target globalBBox below would size the filter RTs to
    // where the native rect lands in target space (the un-stretched corner) —
    // silently clipping the 9-sliced filtered shape. Run a 9-sliced bundle on
    // canvas-sized RTs; correct, just unoptimized.
    if (b && b._nineSliceActive) return null;
    // Each RT owns an explicit canvas rect and consumers remap UVs through it, so
    // allocation at the bbox replaces a separate scissor. The diagnostic switch
    // falls back to canvas-sized RTs when validating rect calculations.
    if (typeof globalThis !== 'undefined'
        && R.mantleDebugFlag('noFilterBbox')) return null;
    const meta = b.metaFloats, st = b.metaFloatsPerShape | 0, mb = (shapeIdx | 0) * st;
    const gBB = b.globalBBox;
    const [arSx, arSy] = arScale(gBB, cw, ch);
    const wM = R.draw.worldM;   // column-major mat3 or null
    // em → top-left screen px (the convention computeNodeBboxes + the SVG
    // filter primitives assume; feOffset dy is screen-down). Mirrors the
    // fill vertex shader's em→clip chain, including the per-draw world
    // matrix so the scissor tracks the world-transformed silhouette.
    const emToPx = (ex, ey) => {
      const planeX = ((ex - gBB[0]) / Math.max(1e-12, gBB[2]) * 2 - 1) * arSx;
      const planeY = ((ey - gBB[1]) / Math.max(1e-12, gBB[3]) * 2 - 1) * arSy;
      let nx = planeX, ny = -planeY, nw = 1;
      if (wM) {
        const cx = wM[0] * nx + wM[3] * ny + wM[6];
        const cy = wM[1] * nx + wM[4] * ny + wM[7];
        const cwv = wM[2] * nx + wM[5] * ny + wM[8];
        nx = cx; ny = cy; nw = cwv;
      }
      const iw = 1 / (Math.abs(nw) < 1e-12 ? 1 : nw);
      return [(nx * iw + 1) * cw * 0.5, (1 - ny * iw) * ch * 0.5];
    };
    // The PER-SHAPE OVERRIDE, if the draw has one. The vertex shader moves the shape by
    // em' = M·em + t before anything else (mantle.vert), so a bbox taken straight from
    // the meta texels describes where the shape ISN'T. That was survivable while every
    // filter RT was the whole canvas — the region was wrong, but it contained the shape
    // anyway. Sized to the bbox, it CLIPS: the shape renders at its overridden position
    // and its RT sits at the original one. An overridden shape is how an app animates a
    // card, so this is the common case, not an exotic one.
    //
    // A rotation makes the transformed box non-axis-aligned; min/max over the four
    // mapped corners is the conservative bound, which is what we want.
    const ov = R.draw.overrides;
    let m00 = 1, m01 = 0, m10 = 0, m11 = 1, tx = 0, ty = 0;
    if (ov && ov.packedBuffer && ov.texelsPerShape) {
      const fps = (ov.texelsPerShape | 0) * 4;   // floats per shape row
      const p = ov.packedBuffer, o = (shapeIdx | 0) * fps;
      if (o + 6 <= p.length) {
        m00 = p[o + 0]; m01 = p[o + 1]; m10 = p[o + 2]; m11 = p[o + 3];
        tx  = p[o + 4]; ty  = p[o + 5];
      }
    }
    const ovEm = (ex, ey) => [m00 * ex + m01 * ey + tx, m10 * ex + m11 * ey + ty];
    // The meta bbox (texel 0) bounds the FILL. A stroke straddles the outline, so it
    // reaches half a stroke-width beyond it — and a miter join reaches miterLimit times
    // further still at a sharp corner. Sizing an RT to the fill bbox CUTS THE STROKE OFF
    // at the RT edge. Pad in EM, before the override transform, so an overridden shape's
    // pad scales with it exactly as its stroke does.
    //   texel 3 = (strokeWidth, fillRuleEvenOdd, accumGroup, dashId)
    //   texel 6 = (capStyle, joinStyle, miterLimit, flagsShape)
    const strokeW = Math.abs(meta[mb + 12] || 0);
    let padEm = 0;
    if (strokeW > 0) {
      const miter = meta[mb + 26] || 1;
      // Over-inclusive on purpose: pad every join as if it were a miter. Costing a few
      // shaded pixels beats guessing the join enum wrong and clipping a corner.
      padEm = 0.5 * strokeW * Math.max(1, Math.min(miter, 4));
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const ex0 = meta[mb + 0] - padEm, ey0 = meta[mb + 1] - padEm;
    const ex1 = meta[mb + 2] + padEm, ey1 = meta[mb + 3] + padEm;
    for (const [cx, cy] of [[ex0, ey0], [ex1, ey0], [ex0, ey1], [ex1, ey1]]) {
      const [ox, oy] = ovEm(cx, cy);
      const [px, py] = emToPx(ox, oy);
      if (px < minX) minX = px; if (py < minY) minY = py;
      if (px > maxX) maxX = px; if (py > maxY) maxY = py;
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;   // degenerate
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // A canvas rect (GL px, origin bottom-left) from a top-left px bbox, padded, with
  // its SIZE rounded up to the quantum. Returns null if degenerate.
  //
  // The size is quantized; the ORIGIN is not. Snapping the rect to a global grid
  // instead — origin down, extent up — makes the SIZE depend on where the box happens
  // to fall on that grid, so two identical cards a few pixels apart get different-sized
  // RTs. Everything downstream is cached by size, and the filter-result cache DELETES
  // AND RECREATES its texture whenever the size changes: six identical cards thrashed
  // one cache entry through several sizes every frame. Sizing off the box's own extent
  // makes identical shapes agree no matter where they sit.
  const RECT_PAD = 2;
  // Rect quantum. Coarse ON PURPOSE — it is an ALLOCATION-CHURN control, not a
  // pixel-budget one.
  //
  // Everything sized to a rect is cached BY that size: the pool's buckets, the
  // SourceGraphic RT (which carries a depth+stencil renderbuffer), the kernel ping,
  // the backdrop, the filter-result cache texture. A fine quantum means two cards a
  // few pixels apart in size, or one card animating its scale, land on DIFFERENT
  // sizes — and each new size allocates, while the filter-result cache deletes and
  // recreates its texture on every size change. Measured on six drop-shadowed cards
  // animating in: at 32 that was ~11 texture allocations per frame and a 145ms
  // hitch. Rounding to 128 collapses them onto shared sizes.
  //
  // The cost is a few more shaded pixels per pass, which is noise next to the canvas
  // these rects replaced.
  const RECT_Q = 128;
  function _bboxToRect(bb, ch, padX = 0, padY = 0) {
    if (!bb || !(bb.w > 0) || !(bb.h > 0)) return null;
    const qUp = v => Math.max(RECT_Q, Math.ceil(v / RECT_Q) * RECT_Q);
    const px = RECT_PAD + padX, py = RECT_PAD + padY;
    const x0 = Math.floor(bb.x - px);          // left edge, top-left px
    const yTop = Math.floor(bb.y - py);        // top edge, top-left px
    const w = qUp(Math.ceil(bb.x + bb.w + px) - x0);
    const h = qUp(Math.ceil(bb.y + bb.h + py) - yTop);
    if (w <= 0 || h <= 0) return null;
    // The quantized box grows DOWN and RIGHT from (x0, yTop), so it still contains the
    // padded bbox. Flip to GL (origin bottom-left).
    return [x0, ch - (yTop + h), w, h];
  }
  const _isWholeCanvas = (r, cw, ch) => r[0] <= 0 && r[1] <= 0 && r[2] >= cw && r[3] >= ch;

  // The rect a SINGLE-KIND filter (blur / morphology / convolve — no graph) needs:
  // the shape, dilated by that kernel's reach in canvas px. Same job computeNodeBboxes
  // does for a graph, for the one-node case where there is no graph to walk.
  function _filterSingleKindRect(shapeIdx, cw, ch, f, pxPerEmX, pxPerEmY) {
    const bb = _shapeBboxPx(shapeIdx, cw, ch);
    if (!bb) return null;
    let rx = 0, ry = 0;
    if (f.kind === 1) {
      // Gaussian: the shader truncates at ±3σ (and the σ>20 box path converges to
      // about the same reach over its three iterations).
      rx = Math.ceil(3 * Math.abs(f.sigmaX * pxPerEmX));
      ry = Math.ceil(3 * Math.abs(f.sigmaY * pxPerEmY));
    } else if (f.kind === 5) {
      // Morphology: dilate grows by the radius; erode only shrinks, but padding by
      // the radius anyway is over-inclusive, never wrong.
      rx = Math.ceil(Math.abs(f.sigmaX * pxPerEmX));
      ry = Math.ceil(Math.abs(f.sigmaY * pxPerEmY));
    } else if (f.kind === 6) {
      // Convolve: one kernel cell is one canvas px, so the reach is the order.
      rx = Math.max(f.orderX | 0, 1);
      ry = Math.max(f.orderY | 0, 1);
    }
    const r = _bboxToRect(bb, ch, rx, ry);
    if (!r || _isWholeCanvas(r, cw, ch)) return null;
    return r;
  }

  function _filterNodeRects(graph, shapeIdx, cw, ch) {
    const sourceBbox = _shapeBboxPx(shapeIdx, cw, ch);
    if (!sourceBbox) return null;
    const b = R._handle.bundle;
    // computeNodeBboxes works in canvas pixels, but the SVG graph's
    // spatial params (blur σ, offset dx/dy, morphology radius, …) are in
    // em/userspace units — the dispatch handlers fold _filterPxPerEm at
    // draw time. Scale a shallow clone of the graph's params to px so the
    // propagated bboxes match the rendered extents (mirrors the COLR
    // path's rescaleColrGraph). Anisotropic: x by pxX, y by pxY.
    const [pxX, pxY] = _filterPxPerEm(cw, ch);
    const pxS = Math.max(pxX, pxY);
    const sgraph = {
      ...graph,
      nodes: graph.nodes.map(nd => {
        const p = nd.params;
        if (!p) return nd;
        switch (nd.type) {
          case 'feGaussianBlur':
            return { ...nd, params: { ...p, sigmaX: (p.sigmaX || 0) * pxX, sigmaY: (p.sigmaY || 0) * pxY } };
          case 'feOffset':
            return { ...nd, params: { ...p, dx: (p.dx || 0) * pxX, dy: (p.dy || 0) * pxY } };
          case 'feMorphology':
            return { ...nd, params: { ...p, radiusX: (p.radiusX || 0) * pxX, radiusY: (p.radiusY || 0) * pxY } };
          case 'feDisplacementMap':
            return { ...nd, params: { ...p, scale: (p.scale || 0) * pxS } };
          default:
            return nd;   // order (cell count) + color params are px/unitless
        }
      }),
    };
    const { bboxes } = computeNodeBboxes(sgraph, sourceBbox, cw, ch);
    // Generator resize pass (see header). GEN = no-input fillers; POINT =
    // consumers that sample at-uv inside their own bbox.
    const GEN = new Set(['feFlood', 'feTurbulence', 'feImage',
      'PaintSolid', 'PaintLinearGradient', 'PaintRadialGradient', 'PaintSweepGradient']);
    const POINT = new Set(['feComposite', 'feBlend', 'feMerge', 'feColorMatrix',
      'feComponentTransfer', 'PaintComposite', 'PaintMerge', 'PaintGlyph']);
    const nN = graph.nodes.length;
    const consumers = graph.nodes.map(() => []);
    for (let i = 0; i < nN; i++)
      for (const inp of graph.nodes[i].inputs)
        if (inp >= 0 && inp < nN) consumers[inp].push(i);
    const unionRect = (a, c) => {
      if (!a) return { x: c.x, y: c.y, w: c.w, h: c.h };
      const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
      return { x, y, w: Math.max(a.x + a.w, c.x + c.w) - x, h: Math.max(a.y + a.h, c.y + c.h) - y };
    };
    for (let i = 0; i < nN; i++) {
      if (!GEN.has(graph.nodes[i].type)) continue;
      const cs = consumers[i];
      if (cs.length && cs.every(c => POINT.has(graph.nodes[c].type))) {
        let u = null;
        for (const c of cs) u = unionRect(u, bboxes[c]);
        if (u) bboxes[i] = u;
      } else {
        bboxes[i] = { x: 0, y: 0, w: cw, h: ch };   // unbounded / root → full canvas
      }
    }
    const FULL = [0, 0, cw, ch];
    let anyBounded = false;
    const rects = bboxes.map(bb => {
      const r = _bboxToRect(bb, ch);
      // No safe bound, or it reaches the whole canvas anyway → a rect buys nothing.
      if (!r || _isWholeCanvas(r, cw, ch)) return FULL;
      anyBounded = true;
      return r;
    });
    if (!anyBounded) return null;
    // The SourceGraphic's own rect. The shape is rendered into an RT covering just
    // this, instead of a canvas-sized one — see renderer.acquireShapeRT. A primitive
    // reading SourceGraphic outside it reads 0, which is what the shape is there.
    const src = _bboxToRect(sourceBbox, ch);
    const source = (src && !_isWholeCanvas(src, cw, ch)) ? src : null;
    return { rects, source };
  }
  // Composite the post-filter shapeFboTex over the backdrop into the
  // canvas — the tail step shared by the single-kind filter cache hit +
  // miss paths. Expects shapeFboTex / mainCopyTex to already hold the
  // right contents. Single-kind filters (blur / colorMatrix / morphology
  // / convolve) all composite as a straight premultiplied over-blend.
  // Optional (srcTex, backdropTex, dstFbo) route the composite inside a
  // group (accumulator FBO as dst) — defaults preserve the canvas path.
  function _filterSingleKindComposite(f, cw, ch, srcTex = null, backdropTex = null, dstFbo = null,
                                     srcRect = null, backdropRect = null) {
    bindFb(gl.FRAMEBUFFER, dstFbo);
    // Same as the graph route: draw only where the filtered shape lives.
    if (srcRect) gl.viewport(srcRect[0], srcRect[1], srcRect[2], srcRect[3]);
    else gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(R.compProg);
    const outR = srcRect || [0, 0, cw, ch];
    const dstR = backdropRect || [0, 0, cw, ch];
    setMap(compUShapeMap, IDENTITY_MAP);   // vUV spans the filtered rect → read it 1:1
    setMap(compUDstMap, [
      outR[2] / dstR[2], outR[3] / dstR[3],
      (outR[0] - dstR[0]) / dstR[2], (outR[1] - dstR[1]) / dstR[3],
    ]);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex || R.shapeFboTex); gl.uniform1i(compUShapeTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, backdropTex || R.mainCopyTex);  gl.uniform1i(compUDstTex, 1);
    gl.uniform1i(compUBlendMode, 0);
    gl.uniform1f(compUOpacity, 1);
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
  // Copy a freshly-evaluated filter output (a transient pool RT texture)
  // into the persistent per-filter-graph-and-shape cache texture + stamp its key.
  // Uses a blit (read FBO = src, draw FBO = the cache's own FBO).
  // `rect` — the canvas rect the filtered output covers (null = whole canvas).
  // The cache texture is allocated at the RECT, so a small filtered shape doesn't
  // hold a canvas-sized texture per filter graph; the rect rides along so the hit
  // path composites it back where it belongs.
  function _storeFilteredTex(filterGraphId, srcTex, cw, ch, key, rect = null) {
    const rw = rect ? rect[2] : cw, rh = rect ? rect[3] : ch;
    let c = R._getFilterCache(filterGraphId);
    if (c) c.rect = rect;
    if (!c || c.w !== rw || c.h !== rh) {
      if (c) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fbo); }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      c = { tex, fbo, w: rw, h: rh, key: null, rect };
      R._setFilterCache(filterGraphId, c);
    }
    // Blit srcTex → cache tex. srcTex isn't an FBO we hold; bind the cache
    // FBO as draw target and sample-copy with the comp/blit program — a
    // passthrough draw of srcTex is the cheapest correct path.
    bindFb(gl.FRAMEBUFFER, c.fbo);
    gl.viewport(0, 0, rw, rh);   // src and cache tex are the same size — a 1:1 copy
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(R.cacheBlitProg);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(R.cbUCacheTex, 0);
    gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
    if (R.cbUInMap) gl.uniform4f(R.cbUInMap, 1, 1, 0, 0);   // whole texture, 1:1
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    c.key = key;
  }

  // Read the filter record for a 1-based filterId from the CPU-side
  // mirror so we don't have to round-trip through GPU readback.
  // lastFilterFloats is 24 floats per filter (6 RGBA32F texels).
  // For kind <= 1: texels 0..3 = color matrix rows, texel 4 = matrix
  //   offset column.
  // For kinds 5/6 (morphology/convolve) t0..t2 carry op-specific params.
  // texel 5 always = (kind, sigmaX, sigmaY, _).
  function filterRecord(filterId) {
    const b = R._handle.bundle;
    if (!b || !b.lastFilterFloats || filterId <= 0) return null;
    const off = (filterId - 1) * 24;
    const ff = b.lastFilterFloats;
    if (off + 24 > ff.length) return null;
    return {
      kind:    ff[off + 20] | 0,
      sigmaX:  ff[off + 21] || 0,
      sigmaY:  ff[off + 22] || 0,
      // t0..t1 reuse for kind-specific params. The shape of these
      // fields is identical across kinds because we always slot the
      // first 8 floats here; consumers pick the names appropriate
      // for their kind. The float layout:
      //   ff[off+0..3]  = t0
      //   ff[off+4..7]  = t1
      //   ff[off+8..11] = t2
      // Morphology (kind=5):
      //   t0.x = operator; sigmaX/sigmaY reused for (radiusX, radiusY).
      // Convolve (kind=6):
      //   t0 = (orderX, orderY, targetX, targetY)
      //   t1 = (divisor, bias, edgeMode, preserveAlpha)
      //   t2.x = kernelRow.
      tintR:    ff[off + 0] || 0,
      tintG:    ff[off + 1] || 0,
      tintB:    ff[off + 2] || 0,
      tintA:    ff[off + 3] || 0,
      offsetX:  ff[off + 4] || 0,
      offsetY:  ff[off + 5] || 0,
      orderX:   ff[off + 0] | 0,
      orderY:   ff[off + 1] | 0,
      targetX:  ff[off + 2] | 0,
      targetY:  ff[off + 3] | 0,
      divisor:  ff[off + 4] || 1,
      bias:     ff[off + 5] || 0,
      edgeMode: ff[off + 6] | 0,
      preserveAlpha: ff[off + 7] | 0,
      kernelRow:     ff[off + 8] | 0,
    };
  }

  // Separable max/min morphology on shapeFboTex, in place. operator
  // 0 = erode, 1 = dilate. rx/ry are pixel radii (per-axis).
  // `t` — the RT to filter in place, with a same-sized ping to bounce through:
  // { fbo, tex, pingFbo, pingTex, w, h }. Omitted → the canvas-sized shapeFbo/pingFbo
  // pair, which is what a group's filtered child still uses.
  function _kernelTarget(t) {
    if (t) return t;
    ensurePingFbo();
    const [cw, ch] = viewportSize();
    return { fbo: R.shapeFbo, tex: R.shapeFboTex, pingFbo: R.pingFbo, pingTex: R.pingTex, w: cw, h: ch };
  }
  function morphShapeFbo(operator, rx, ry, target) {
    if (!R.morphProg) return;
    if (rx < 0.5 && ry < 0.5) return;
    const t = _kernelTarget(target);
    const cw = t.w, ch = t.h;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(R.morphProg);
    gl.uniform2f(morphUTexel, 1 / cw, 1 / ch);
    setMap(morphUInMap, IDENTITY_MAP);   // target ↔ ping: same rect
    gl.uniform1i(morphUTex, 0);
    gl.uniform1i(morphUOperator, operator | 0);
    gl.bindVertexArray(coverVao);
    // Horizontal pass: target → ping.
    bindFb(gl.FRAMEBUFFER, t.pingFbo);
    gl.viewport(0, 0, cw, ch);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform2f(morphUDir, 1, 0);
    gl.uniform1f(morphURadius, rx);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Vertical pass: ping → target.
    bindFb(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, cw, ch);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.pingTex);
    gl.uniform2f(morphUDir, 0, 1);
    gl.uniform1f(morphURadius, ry);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
  }

  // Apply feConvolveMatrix to shapeFboTex, in place. Reads the kernel
  // from bundle.kernelTex at the supplied row; runs a single full-screen
  // pass into pingFbo, then blits ping → shape so subsequent code
  // continues to read from shapeFboTex.
  function convolveShapeFbo(rec, target) {
    const b = R._handle.bundle;
    if (!R.convolveProg || !b || !b.kernelTex) return;
    const t = _kernelTarget(target);
    const cw = t.w, ch = t.h;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(R.convolveProg);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(convUTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.kernelTex);
    gl.uniform1i(convUKernelTex, 1);
    gl.uniform2f(convUTexel, 1 / cw, 1 / ch);
    setMap(convUInMap, IDENTITY_MAP);   // target ↔ ping: same rect
    gl.uniform2f(convUOrder, rec.orderX, rec.orderY);
    gl.uniform2f(convUTarget, rec.targetX, rec.targetY);
    gl.uniform1f(convUDivisor, rec.divisor || 1);
    gl.uniform1f(convUBias, rec.bias || 0);
    gl.uniform1i(convUKernelRow, rec.kernelRow | 0);
    gl.uniform1i(convUEdgeMode, rec.edgeMode | 0);
    gl.uniform1i(convUPreserve, rec.preserveAlpha | 0);
    bindFb(gl.FRAMEBUFFER, t.pingFbo);
    gl.viewport(0, 0, cw, ch);
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    // Blit ping → target so the next stage (composite) sees the result.
    bindFb(gl.READ_FRAMEBUFFER, t.pingFbo);
    bindFb(gl.DRAW_FRAMEBUFFER, t.fbo);
    gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    bindFb(gl.READ_FRAMEBUFFER, null);
    bindFb(gl.DRAW_FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
  }

  // Separable Gaussian blur on shapeFboTex, in place. After the call the
  // shape FBO holds the blurred result. sx/sy are pixel sigmas (the shape
  // FBO is canvas-sized, so em → px scale already in pixel units).
  function blurShapeFbo(sx, sy, target) {
    if (sx <= 0.5 && sy <= 0.5) return;
    const t = _kernelTarget(target);
    const cw = t.w, ch = t.h;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(R.blurProg);
    gl.uniform2f(blurUTexel, 1 / cw, 1 / ch);
    setMap(blurUInMap, IDENTITY_MAP);   // target ↔ ping: same rect
    gl.uniform1i(blurUTex, 0);
    gl.bindVertexArray(coverVao);
    // Horizontal: target → ping
    bindFb(gl.FRAMEBUFFER, t.pingFbo);
    gl.viewport(0, 0, cw, ch);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform2f(blurUDir, 1, 0);
    gl.uniform1f(blurUSigma, sx);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Vertical: ping → target
    bindFb(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, cw, ch);
    R._fpUValid = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.pingTex);
    gl.uniform2f(blurUDir, 0, 1);
    gl.uniform1f(blurUSigma, sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
  }

  R._filterKeyMatches = _filterKeyMatches;
  R._wmHash = _wmHash;
  R._recolorHash = _recolorHash;
  R._compositeFilteredTex = _compositeFilteredTex;
  R._blitTexToFbo = _blitTexToFbo;
  R._ensureCacheTex = _ensureCacheTex;
  R._buildFilterCtx = _buildFilterCtx;
  R._filterPxPerEm = _filterPxPerEm;
  // The canvas rect the CURRENT handle's bundle actually paints into — the union of
  // every shape's own rect, expanded by whatever that shape's filter or stroke reaches.
  // Reuses the per-shape machinery the filter rects are built on, so it cannot disagree
  // with them about where a shape is.
  //
  // Used to stop the static cache blitting a FULL-CANVAS quad for a shape that covers a
  // tenth of the screen — which it did, once per cached handle, every frame. That is pure
  // fillrate, it scales with the canvas, and it is why the games fall over at fullscreen.
  //
  // null = "could not bound it safely, use the whole canvas". Be conservative: a rect
  // that is too small CLIPS the cached image, and a clipped cache is the worst kind of
  // bug (it looks like the content is simply missing).
  function _contentRectPx(cw, ch, ops) {
    const b = R._handle && R._handle.bundle;
    if (!b || !b.drawList || !b.drawList.length) return null;
    if (b._nineSliceActive) return null;
    const list = ops || b.drawList;
    if (!list.length) return null;
    const [pxX, pxY] = _filterPxPerEm(cw, ch);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const op of list) {
      if (op.kind !== 'fillShape') continue;
      const si = op.shapeIdx | 0;
      let r = null;
      if (op.filterGraphId) {
        // A graph filter. Its ROOT rect is the extent of what it finally paints — and if
        // we cannot resolve it, BAIL rather than fall through to the bare shape bbox: a
        // drop shadow reaches well past its shape, and bounding the cache by the shape
        // would cut the shadow off.
        const g = b.filterGraphs && b.filterGraphs[op.filterGraphId - 1];
        if (!g) return null;
        const info = _filterNodeRects(g, si, cw, ch);
        if (!info) return null;                      // rects off / unsafe → don't bound
        r = info.rects[g.rootOut];
      } else if (op.filterId) {
        const f = filterRecord(op.filterId);
        if (!f) return null;
        r = (f.kind >= 1) ? _filterSingleKindRect(si, cw, ch, f, pxX, pxY)
                          : _bboxToRect(_shapeBboxPx(si, cw, ch), ch);
      } else {
        r = _bboxToRect(_shapeBboxPx(si, cw, ch), ch);
      }
      if (!r) return null;                            // a shape we can't bound → bail
      if (r[0] < minX) minX = r[0];
      if (r[1] < minY) minY = r[1];
      if (r[0] + r[2] > maxX) maxX = r[0] + r[2];
      if (r[1] + r[3] > maxY) maxY = r[1] + r[3];
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;
    // Clamp to the canvas — off-canvas pixels are not ours to touch, and the blit's
    // viewport is in canvas space.
    const x = Math.max(0, Math.floor(minX)), y = Math.max(0, Math.floor(minY));
    const w = Math.min(cw, Math.ceil(maxX)) - x, h = Math.min(ch, Math.ceil(maxY)) - y;
    if (w <= 0 || h <= 0) return null;
    if (x <= 0 && y <= 0 && w >= cw && h >= ch) return null;   // covers the canvas anyway
    return [x, y, w, h];
  }
  R._contentRectPx = _contentRectPx;

  R._filterNodeRects = _filterNodeRects;
  R._filterSingleKindRect = _filterSingleKindRect;
  R._filterSingleKindComposite = _filterSingleKindComposite;
  R._storeFilteredTex = _storeFilteredTex;
  R.filterRecord = filterRecord;
  R.morphShapeFbo = morphShapeFbo;
  R.convolveShapeFbo = convolveShapeFbo;
  R.blurShapeFbo = blurShapeFbo;
}
