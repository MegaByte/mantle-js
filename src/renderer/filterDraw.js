// filterDraw.js — SVG filter-graph draw subsystem, split out of renderer.js.
//
// Owns: the filtered-texture cache key/compare helpers, the per-shape
// filter FBO composite paths, the filter-graph dispatch-context builder, the
// per-node scissor computation, and the three single-kind in-place passes
// (blur / morphology / convolve) that operate on the shape FBO.
//
// These functions were always referenced through `R` by the composed-morph
// route (morphDraw.js); this module makes that ownership explicit. Shared GL
// scratch + per-draw state live on `R` (shapeFbo/shapeFboTex/mainCopyTex/
// pingFbo/pingTex, _handle, _rtPool, _filterCache, the _draw* recolor state) —
// this module reads them via `R.x` at call time so it tracks the live values
// renderer.js reassigns per shape. The GL programs are captured once on R
// (attachShaderPrograms) and never rebuilt, so the ~73 uniform locations are
// derived once here from R.<prog>.
//
// attachFilterDraw(R) runs LATE in _runInit (after the Object.assign/getters
// that publish coverVao/bindFb/ensurePingFbo/…), so the stable helpers can be
// destructured; only mutable state is read through R.

import { computeNodeBboxes } from '../filterGraph/bbox.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachFilterDraw(R) {
  const { gl, coverVao, arScale, viewportSize, bindFb, ensurePingFbo } = R;

  // ── Uniform locations (derived once from the R-published programs) ─────
  const compUShapeTex    = gl.getUniformLocation(R.compProg, 'uShapeTex');
  const compUDstTex      = gl.getUniformLocation(R.compProg, 'uDstTex');
  const compUBlendMode   = gl.getUniformLocation(R.compProg, 'uBlendMode');
  const compUOpacity     = gl.getUniformLocation(R.compProg, 'uOpacity');

  const blurUTex   = gl.getUniformLocation(R.blurProg, 'uTex');
  const blurUTexel = gl.getUniformLocation(R.blurProg, 'uTexel');
  const blurUDir   = gl.getUniformLocation(R.blurProg, 'uDir');
  const blurUSigma = gl.getUniformLocation(R.blurProg, 'uSigma');

  const bbUTex    = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTex')    : null;
  const bbUTexel  = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uTexel')  : null;
  const bbUDir    = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uDir')    : null;
  const bbURadius = R.boxBlurProg ? gl.getUniformLocation(R.boxBlurProg, 'uRadius') : null;

  const morphUTex      = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTex')      : null;
  const morphUTexel    = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uTexel')    : null;
  const morphUDir      = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uDir')      : null;
  const morphURadius   = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uRadius')   : null;
  const morphUOperator = R.morphProg ? gl.getUniformLocation(R.morphProg, 'uOperator') : null;

  const convUTex       = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTex')           : null;
  const convUKernelTex = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernelTex')     : null;
  const convUTexel     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTexel')         : null;
  const convUOrder     = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uOrder')         : null;
  const convUTarget    = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uTarget')        : null;
  const convUDivisor   = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uDivisor')       : null;
  const convUBias      = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uBias')          : null;
  const convUKernelRow = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uKernelRow')     : null;
  const convUEdgeMode  = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uEdgeMode')      : null;
  const convUPreserve  = R.convolveProg ? gl.getUniformLocation(R.convolveProg, 'uPreserveAlpha') : null;

  const cmUTex  = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uTex')  : null;
  const cmUM0   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM0')   : null;
  const cmUM1   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM1')   : null;
  const cmUM2   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM2')   : null;
  const cmUM3   = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uM3')   : null;
  const cmUMOff = R.colorMatrixProg ? gl.getUniformLocation(R.colorMatrixProg, 'uMOff') : null;

  const fcUIn1 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn1') : null;
  const fcUIn2 = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uIn2') : null;
  const fcUOp  = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uOp')  : null;
  const fcUK   = R.feCompositeProg ? gl.getUniformLocation(R.feCompositeProg, 'uK')   : null;

  const fbUIn1  = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn1')  : null;
  const fbUIn2  = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uIn2')  : null;
  const fbUMode = R.feBlendProg ? gl.getUniformLocation(R.feBlendProg, 'uMode') : null;

  const ftUTex  = R.feTileProg ? gl.getUniformLocation(R.feTileProg, 'uTex') : null;

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

  const fdUIn1   = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn1')   : null;
  const fdUIn2   = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uIn2')   : null;
  const fdUScale = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uScale') : null;
  const fdUTexel = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uTexel') : null;
  const fdUXChan = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uXChan') : null;
  const fdUYChan = R.feDisplacementMapProg ? gl.getUniformLocation(R.feDisplacementMapProg, 'uYChan') : null;

  const flUIn           = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uIn')           : null;
  const flUTexel        = R.feLightingProg ? gl.getUniformLocation(R.feLightingProg, 'uTexel')        : null;
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
  const fctULUT = R.feComponentTransferProg ? gl.getUniformLocation(R.feComponentTransferProg, 'uLUT') : null;

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
  // the canvas — the tail step shared by the filter cache hit + miss
  // paths. Mirrors the inline composite the eval path uses.
  function _compositeFilteredTex(filteredTex, backdropTex, cw, ch) {
    bindFb(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(R.compProg);
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
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(R.cbUCacheTex, 0);
    gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
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
      blurU: { uTex: blurUTex, uTexel: blurUTexel, uDir: blurUDir, uSigma: blurUSigma },
      boxBlurProg: R.boxBlurProg,
      boxBlurU: R.boxBlurProg ? { uTex: bbUTex, uTexel: bbUTexel, uDir: bbUDir, uRadius: bbURadius } : null,
      morphProg: R.morphProg,
      morphU: R.morphProg ? { uTex: morphUTex, uTexel: morphUTexel, uDir: morphUDir, uRadius: morphURadius, uOperator: morphUOperator } : null,
      colorMatrixProg: R.colorMatrixProg,
      colorMatrixU: R.colorMatrixProg ? { uTex: cmUTex, uM0: cmUM0, uM1: cmUM1, uM2: cmUM2, uM3: cmUM3, uMOff: cmUMOff } : null,
      feCompositeProg: R.feCompositeProg,
      feCompositeU: R.feCompositeProg ? { uIn1: fcUIn1, uIn2: fcUIn2, uOp: fcUOp, uK: fcUK } : null,
      feBlendProg: R.feBlendProg,
      feBlendU: R.feBlendProg ? { uIn1: fbUIn1, uIn2: fbUIn2, uMode: fbUMode } : null,
      feTileProg: R.feTileProg,
      feTileU: R.feTileProg ? { uTex: ftUTex } : null,
      feTurbulenceProg: R.feTurbulenceProg,
      feTurbulenceU: R.feTurbulenceProg ? { uBaseFreq: ftbUBaseFreq, uNumOctaves: ftbUNumOctaves, uSeed: ftbUSeed, uKind: ftbUKind, uTilePos: ftbUTilePos, uTileSize: ftbUTileSize, uStitch: ftbUStitch } : null,
      feDisplacementMapProg: R.feDisplacementMapProg,
      feDisplacementMapU: R.feDisplacementMapProg ? { uIn1: fdUIn1, uIn2: fdUIn2, uScale: fdUScale, uTexel: fdUTexel, uXChan: fdUXChan, uYChan: fdUYChan } : null,
      feLightingProg: R.feLightingProg,
      feLightingU: R.feLightingProg ? { uIn: flUIn, uTexel: flUTexel, uWorldScale: flUWorldScale, uSurfaceScale: flUSurfaceScale, uK: flUK, uExponent: flUExponent, uLightColor: flULightColor, uMode: flUMode, uLightType: flULightType, uLightPos: flULightPos, uSpotAt: flUSpotAt, uSpotExp: flUSpotExp, uSpotCosCone: flUSpotCosCone } : null,
      feComponentTransferProg: R.feComponentTransferProg,
      feComponentTransferU: R.feComponentTransferProg ? { uIn: fctUIn, uLUT: fctULUT } : null,
      feImageProg: R.feImageProg,
      feImageU: R.feImageProg ? { uIn: fimgUIn, uAtlasSize: fimgUAtlasSize, uAtlasRect: fimgUAtlasRect, uPreserveAR: fimgUPreserveAR } : null,
      convolveProg: R.convolveProg,
      convolveU: R.convolveProg ? { uTex: convUTex, uKernelTex: convUKernelTex, uTexel: convUTexel, uOrder: convUOrder, uTarget: convUTarget, uDivisor: convUDivisor, uBias: convUBias, uKernelRow: convUKernelRow, uEdgeMode: convUEdgeMode, uPreserveAlpha: convUPreserve } : null,
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
  // Per-node scissor rects for a filter graph: restrict every full-canvas
  // filter pass to the device-pixel region where its output can be
  // non-zero (the SourceGraphic bbox propagated through the graph by
  // computeNodeBboxes), so a small filtered shape on a large canvas
  // skips the out-of-bbox fragment work. Output-identical: bounded
  // primitives are transparent beyond their bbox by spec, and
  // evaluateGraph pre-clears each RT so the un-drawn region stays 0.
  //
  // Returns an array aligned with graph.nodes (each entry a GL scissor
  // rect {x,y,w,h} in bottom-left framebuffer pixels, or null = draw full
  // canvas for that node), OR null to disable scissoring entirely for
  // this graph.
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
  function _filterNodeScissors(graph, shapeIdx, cw, ch) {
    if (!R._filterScissorEnabled) return null;
    const b = R._handle.bundle;
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const ex0 = meta[mb + 0], ey0 = meta[mb + 1], ex1 = meta[mb + 2], ey1 = meta[mb + 3];
    for (const [cx, cy] of [[ex0, ey0], [ex1, ey0], [ex0, ey1], [ex1, ey1]]) {
      const [px, py] = emToPx(cx, cy);
      if (px < minX) minX = px; if (py < minY) minY = py;
      if (px > maxX) maxX = px; if (py > maxY) maxY = py;
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;   // degenerate
    const sourceBbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
    const PAD = 2;   // safety margin (px) — over-inclusive, never clips
    let anyBounded = false;
    const out = bboxes.map(bb => {
      if (!bb || bb.w <= 0 || bb.h <= 0) return null;
      let x = Math.floor(bb.x) - PAD, y = Math.floor(bb.y) - PAD;
      let w = Math.ceil(bb.w) + 2 * PAD, hgt = Math.ceil(bb.h) + 2 * PAD;
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { hgt += y; y = 0; }
      if (x + w > cw) w = cw - x;
      if (y + hgt > ch) hgt = ch - y;
      if (w <= 0 || hgt <= 0) return null;
      // Covers the whole canvas → scissoring buys nothing; draw full.
      if (x <= 0 && y <= 0 && w >= cw && hgt >= ch) return null;
      anyBounded = true;
      // Flip y from top-left (SVG/screen) to bottom-left (GL scissor).
      return { x, y: ch - (y + hgt), w, h: hgt };
    });
    return anyBounded ? out : null;
  }
  // Composite the post-filter shapeFboTex over the backdrop into the
  // canvas — the tail step shared by the single-kind filter cache hit +
  // miss paths. Expects shapeFboTex / mainCopyTex to already hold the
  // right contents. Single-kind filters (blur / colorMatrix / morphology
  // / convolve) all composite as a straight premultiplied over-blend.
  function _filterSingleKindComposite(f, cw, ch) {
    bindFb(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(R.compProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.shapeFboTex); gl.uniform1i(compUShapeTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.mainCopyTex);  gl.uniform1i(compUDstTex, 1);
    gl.uniform1i(compUBlendMode, 0);
    gl.uniform1f(compUOpacity, 1);
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
  // Copy a freshly-evaluated filter output (a transient pool RT texture)
  // into the persistent per-filterGraphId cache texture + stamp its key.
  // Uses a blit (read FBO = src, draw FBO = the cache's own FBO).
  function _storeFilteredTex(filterGraphId, srcTex, cw, ch, key) {
    let c = R._filterCache.get(filterGraphId);
    if (!c || c.w !== cw || c.h !== ch) {
      if (c) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fbo); }
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
      c = { tex, fbo, w: cw, h: ch, key: null };
      R._filterCache.set(filterGraphId, c);
    }
    // Blit srcTex → cache tex. srcTex isn't an FBO we hold; bind the cache
    // FBO as draw target and sample-copy with the comp/blit program — a
    // passthrough draw of srcTex is the cheapest correct path.
    bindFb(gl.FRAMEBUFFER, c.fbo);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(R.cacheBlitProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(R.cbUCacheTex, 0);
    gl.uniform4f(R.cbUTint, 1, 1, 1, 1);
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
  function morphShapeFbo(operator, rx, ry) {
    if (!R.morphProg) return;
    if (rx < 0.5 && ry < 0.5) return;
    ensurePingFbo();
    const [cw, ch] = viewportSize();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(R.morphProg);
    gl.uniform2f(morphUTexel, 1 / cw, 1 / ch);
    gl.uniform1i(morphUTex, 0);
    gl.uniform1i(morphUOperator, operator | 0);
    gl.bindVertexArray(coverVao);
    // Horizontal pass: shapeFboTex → pingTex.
    bindFb(gl.FRAMEBUFFER, R.pingFbo);
    gl.viewport(0, 0, cw, ch);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.shapeFboTex);
    gl.uniform2f(morphUDir, 1, 0);
    gl.uniform1f(morphURadius, rx);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Vertical pass: pingTex → shapeFboTex.
    bindFb(gl.FRAMEBUFFER, R.shapeFbo);
    gl.viewport(0, 0, cw, ch);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.pingTex);
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
  function convolveShapeFbo(rec) {
    const b = R._handle.bundle;
    if (!R.convolveProg || !b || !b.kernelTex) return;
    ensurePingFbo();
    const [cw, ch] = viewportSize();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(R.convolveProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.shapeFboTex);
    gl.uniform1i(convUTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.kernelTex);
    gl.uniform1i(convUKernelTex, 1);
    gl.uniform2f(convUTexel, 1 / cw, 1 / ch);
    gl.uniform2f(convUOrder, rec.orderX, rec.orderY);
    gl.uniform2f(convUTarget, rec.targetX, rec.targetY);
    gl.uniform1f(convUDivisor, rec.divisor || 1);
    gl.uniform1f(convUBias, rec.bias || 0);
    gl.uniform1i(convUKernelRow, rec.kernelRow | 0);
    gl.uniform1i(convUEdgeMode, rec.edgeMode | 0);
    gl.uniform1i(convUPreserve, rec.preserveAlpha | 0);
    bindFb(gl.FRAMEBUFFER, R.pingFbo);
    gl.viewport(0, 0, cw, ch);
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    // Blit ping → shape so the next stage (composite) sees the result.
    bindFb(gl.READ_FRAMEBUFFER, R.pingFbo);
    bindFb(gl.DRAW_FRAMEBUFFER, R.shapeFbo);
    gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    bindFb(gl.READ_FRAMEBUFFER, null);
    bindFb(gl.DRAW_FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
  }

  // Separable Gaussian blur on shapeFboTex, in place. After the call the
  // shape FBO holds the blurred result. sx/sy are pixel sigmas (the shape
  // FBO is canvas-sized, so em → px scale already in pixel units).
  function blurShapeFbo(sx, sy) {
    if (sx <= 0.5 && sy <= 0.5) return;
    ensurePingFbo();
    const [cw, ch] = viewportSize();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(R.blurProg);
    gl.uniform2f(blurUTexel, 1 / cw, 1 / ch);
    gl.uniform1i(blurUTex, 0);
    gl.bindVertexArray(coverVao);
    // Horizontal: shapeFboTex → pingTex
    bindFb(gl.FRAMEBUFFER, R.pingFbo);
    gl.viewport(0, 0, cw, ch);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.shapeFboTex);
    gl.uniform2f(blurUDir, 1, 0);
    gl.uniform1f(blurUSigma, sx);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Vertical: pingTex → shapeFboTex
    bindFb(gl.FRAMEBUFFER, R.shapeFbo);
    gl.viewport(0, 0, cw, ch);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.pingTex);
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
  R._filterNodeScissors = _filterNodeScissors;
  R._filterSingleKindComposite = _filterSingleKindComposite;
  R._storeFilteredTex = _storeFilteredTex;
  R.filterRecord = filterRecord;
  R.morphShapeFbo = morphShapeFbo;
  R.convolveShapeFbo = convolveShapeFbo;
  R.blurShapeFbo = blurShapeFbo;
}
