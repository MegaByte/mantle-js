// fillPass.js — the Slug coverage fill-pass setup, split out of renderer.js.
//
// beginFillPass() binds the fill program, the active handle's bundle textures
// (gated on _handle.fillPassAssetDirty), the offscreen-mask RT, and all the
// per-draw uniforms (world matrix, alpha, overrides, channel-lerp / color-
// matrix / palette recolor, external clip). It runs ONCE per fill pass (the
// per-draw state it reads is set once per drawBundle/handle.draw, NOT per
// shape), so reading that state through R.x here is per-pass, not per-fragment.
//
// endFillPass() just clears the active flag; fillPassActive lives here so both
// stay together. flushPending() stays in renderer.js (it shares the per-shape
// batch cursor _pendingStart/_pendingEnd with the draw loop) and calls
// R.beginFillPass(). The 39 fill uniforms are self-derived from R.fillProg
// (captured once, never rebuilt). attachFillPass runs after the Object.assign
// that publishes the destructured helpers.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachFillPass(R) {
  const { gl, viewportSize, arScale, dummyDashTex, dummyGradientTex, dummyGradientStops,
          IDENTITY_COLOR_MATRIX, ZERO_OFFSET } = R;

  const uCurveLoc       = gl.getUniformLocation(R.fillProg, 'uCurveData');
  const uBandLoc        = gl.getUniformLocation(R.fillProg, 'uBandData');
  const uMetaLoc        = gl.getUniformLocation(R.fillProg, 'uMetaTex');
  const uDashLoc        = gl.getUniformLocation(R.fillProg, 'uDashTex');
  const uGBB            = gl.getUniformLocation(R.fillProg, 'uGlobalBBox');
  const uShapeIdxOverride = gl.getUniformLocation(R.fillProg, 'uShapeIdxOverride');
  const uFillNumShapes  = gl.getUniformLocation(R.fillProg, 'uNumShapes');
  const uFillCanvasAR   = gl.getUniformLocation(R.fillProg, 'uCanvasAR');
  const uFillViewportSize = gl.getUniformLocation(R.fillProg, 'uViewportSize');
  const uFillGradTex    = gl.getUniformLocation(R.fillProg, 'uGradientTex');
  const uFillGradStops      = gl.getUniformLocation(R.fillProg, 'uGradientStops');
  const uFillGradStopsCount = gl.getUniformLocation(R.fillProg, 'uGradientStopsCount');
  const uFillGradCount  = gl.getUniformLocation(R.fillProg, 'uGradientCount');
  const uFillImageTex   = gl.getUniformLocation(R.fillProg, 'uImageTex');
  const uFillImageAtlasSize = gl.getUniformLocation(R.fillProg, 'uImageAtlasSize');
  const uFillFilterTex  = gl.getUniformLocation(R.fillProg, 'uFilterTex');
  const uFillOverrideTex   = gl.getUniformLocation(R.fillProg, 'uOverrideTex');
  const uFillHasOverrides  = gl.getUniformLocation(R.fillProg, 'uHasOverrides');
  const uFillHasEmCoord    = gl.getUniformLocation(R.fillProg, 'uHasEmCoord');
  const uFillDrawAlpha     = gl.getUniformLocation(R.fillProg, 'uDrawAlpha');
  const uFillColorMatrix         = gl.getUniformLocation(R.fillProg, 'uColorMatrix');
  const uFillColorMatrixOffset   = gl.getUniformLocation(R.fillProg, 'uColorMatrixOffset');
  const uFillColorMatrixEnabled  = gl.getUniformLocation(R.fillProg, 'uColorMatrixEnabled');
  const uFillExtClipTex          = gl.getUniformLocation(R.fillProg, 'uExtClipTex');
  const uFillExtClipMode         = gl.getUniformLocation(R.fillProg, 'uExtClipMode');
  const uFillChLerpPrimary       = gl.getUniformLocation(R.fillProg, 'uChannelLerpPrimary');
  const uFillChLerpContrast      = gl.getUniformLocation(R.fillProg, 'uChannelLerpContrast');
  const uFillChLerpHighlight     = gl.getUniformLocation(R.fillProg, 'uChannelLerpHighlight');
  const uFillChLerpEnabled       = gl.getUniformLocation(R.fillProg, 'uChannelLerpEnabled');
  const uFillPalette             = gl.getUniformLocation(R.fillProg, 'uPalette');
  const uFillPaletteEnabled      = gl.getUniformLocation(R.fillProg, 'uPaletteEnabled');
  const uFillPaletteChannel      = gl.getUniformLocation(R.fillProg, 'uPaletteChannel');
  const uFillPaletteSize         = gl.getUniformLocation(R.fillProg, 'uPaletteSize');
  const uFillWorldM        = gl.getUniformLocation(R.fillProg, 'uWorldM');
  const uFillHasWorldM     = gl.getUniformLocation(R.fillProg, 'uHasWorldM');
  const uFillMaskRTArray       = gl.getUniformLocation(R.fillProg, 'uMaskRTArray');
  const uFillMaskRowToLayerTex = gl.getUniformLocation(R.fillProg, 'uMaskRowToLayerTex');
  const uFillHasOffscreenMask  = gl.getUniformLocation(R.fillProg, 'uHasOffscreenMask');
  const uFillHasOccupancy      = gl.getUniformLocation(R.fillProg, 'uHasOccupancy');

  let fillPassActive = false;

  function beginFillPass() {
    if (fillPassActive) return;
    fillPassActive = true;
    const [cw, ch] = viewportSize();
    gl.viewport(0, 0, cw, ch);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.useProgram(R.fillProg);
    // Multi-handle pattern: if the previous fill pass bound
    // textures + uniforms for a DIFFERENT handle, our per-handle
    // fillPassAssetDirty flag isn't enough — the texture units still
    // hold the other handle's bindings, AND the canvas-AR cache
    // below is keyed on (cw, ch) which is bundle-independent, so
    // without an explicit reset different bundles silently inherit
    // the prior handle's `arScale(globalBBox, ...)` result. That's
    // the "dimensions wrong across the board" symptom:
    // mount B's draw uses mount A's scale factor when both have
    // different globalBBox. Force a full re-bind + re-AR-compute.
    if (R._lastFillPassHandle !== R._handle) {
      R._handle.fillPassAssetDirty = true;
      R.fillPassCanvasW = 0;
      R.fillPassCanvasH = 0;
    }
    if (R._handle.fillPassAssetDirty) {
      const b = R._handle.bundle;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.curveTex); gl.uniform1i(uCurveLoc, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.bandTex);  gl.uniform1i(uBandLoc, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, b.metaTex);  gl.uniform1i(uMetaLoc, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, b.dashTex || dummyDashTex); gl.uniform1i(uDashLoc, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, b.gradientTex || dummyGradientTex); gl.uniform1i(uFillGradTex, 4);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, b.gradientStopsTex || dummyGradientStops); gl.uniform1i(uFillGradStops, 5);
      gl.uniform1i(uFillGradStopsCount, b.gradientStopsCount | 0);
      gl.uniform1i(uFillGradCount, b.gradientCount);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, b.imageAtlasTex || dummyGradientStops); gl.uniform1i(uFillImageTex, 6);
      gl.uniform2f(uFillImageAtlasSize, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, b.filterTex || dummyGradientTex); gl.uniform1i(uFillFilterTex, 7);
      gl.uniform4f(uGBB, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      gl.uniform1f(uFillNumShapes, Math.max(1, b.numShapes));
      gl.uniform1i(uShapeIdxOverride, -1);
      // Multi-shape mask offscreen RT. When the bundle has regions and
      // the bake program is bundled, R._maskRTArray was filled by
      // R.bakeMaskRegions() at the top of render(); bind it on TEXTURE9
      // and the row-to-layer lookup on TEXTURE10. Otherwise bind dummy
      // 1×1×1 R8 array + 1×1 R32I textures (WebGL2 validation requires
      // every declared sampler to have a binding).
      gl.activeTexture(gl.TEXTURE9);
      if (R.maskBakeProg && R._handle.maskRegions.length && R._maskRTArray && R._handle.maskRowToLayerTex) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, R._maskRTArray);
        gl.uniform1i(uFillMaskRTArray, 9);
        gl.activeTexture(gl.TEXTURE10);
        gl.bindTexture(gl.TEXTURE_2D, R._handle.maskRowToLayerTex);
        gl.uniform1i(uFillMaskRowToLayerTex, 10);
        gl.uniform1i(uFillHasOffscreenMask, 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, R.maskRTDummy());
        gl.uniform1i(uFillMaskRTArray, 9);
        gl.activeTexture(gl.TEXTURE10);
        gl.bindTexture(gl.TEXTURE_2D, R.maskRowToLayerDummy());
        gl.uniform1i(uFillMaskRowToLayerTex, 10);
        gl.uniform1i(uFillHasOffscreenMask, 0);
      }
      // Interior-skip occupancy is a per-bundle property (opt-in importer
      // grids). Coherent uniform → the fill shader's occupancy branch is free
      // on bundles without it.
      gl.uniform1i(uFillHasOccupancy, (R._handle.bundle && R._handle.bundle.hasOccupancy) ? 1 : 0);
      R._handle.fillPassAssetDirty = false;
      R._lastFillPassHandle = R._handle;
    }
    // Per-draw bindings: override texture + world
    // matrix. These flip per drawBundle call inside one frame, so we
    // can't gate them on _handle.fillPassAssetDirty. Cheap: 2 uniform writes
    // + one texture bind.
    //
    // Always pin uOverrideTex to TEXTURE8 — even when overrides are
    // off — so the sampler doesn't alias TEXTURE0 (curveTex). WebGL2
    // validates sampler-unit usage even when the sampling op is
    // gated by a uniform-bool; aliasing curveTex on unit 0 has been
    // observed to fire spurious feedback-loop errors when the fill
    // pass's framebuffer (shapeFbo) is also bound to TEXTURE0
    // earlier in the frame.
    gl.activeTexture(gl.TEXTURE8);
    const ov = R.draw.overrides;
    if (ov && ov.uploadIfDirty) {
      ov.uploadIfDirty();
      gl.bindTexture(gl.TEXTURE_2D, ov.texture);
      gl.uniform1i(uFillOverrideTex, 8);
      gl.uniform1i(uFillHasOverrides, 1);
    } else {
      // Dummy 1x1 RGBA32F texture so unit 8 has something compatible
      // with a sampler2D-RGBA32F lookup (driver-defensive).
      gl.bindTexture(gl.TEXTURE_2D, dummyGradientTex);
      gl.uniform1i(uFillOverrideTex, 8);
      gl.uniform1i(uFillHasOverrides, 0);
    }
    // Per-draw opacity multiplier. The fill vert shader folds this
    // into the per-shape tint alpha so it works whether or not the
    // caller bound an override table. drawBundle/drawInstance set
    // _drawAlpha to opts.alpha (defaults to 1.0).
    gl.uniform1f(uFillDrawAlpha, R.draw.alpha);
    // 9-slice em-coord: nineSlice.applyNineSlice stamps the bundle
    // with `_nineSliceActive=true` so the vert shader reads the
    // native em coord from aEmCoord (v1.xy slot) instead of aPos.
    gl.uniform1i(uFillHasEmCoord, (R._handle.bundle && R._handle.bundle._nineSliceActive) ? 1 : 0);
    if (R.draw.worldM) {
      // Pass row-major 3x3 as a mat3 (GLSL is column-major; flip).
      gl.uniformMatrix3fv(uFillWorldM, false, R.draw.worldM);
      gl.uniform1i(uFillHasWorldM, 1);
    } else {
      gl.uniform1i(uFillHasWorldM, 0);
    }
    // Per-draw bilinear channel-lerp recolor (bilinear recolor).
    // The channel-lerp formula: out = mix(R·primary +
    // B·contrast, highlight, G + 1 - A). Non-linear, can't be expressed
    // as a color matrix. Runs first in the pipeline so palette + matrix
    // can stack downstream if the caller wants.
    if (R.draw.channelLerp) {
      const cl = R.draw.channelLerp;
      const p = cl.primary   || [0, 0, 0, 1];
      const c = cl.contrast  || [0, 0, 0, 1];
      const h = cl.highlight || [1, 1, 1, 1];
      gl.uniform4f(uFillChLerpPrimary,   p[0], p[1], p[2], p[3] == null ? 1 : p[3]);
      gl.uniform4f(uFillChLerpContrast,  c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
      gl.uniform4f(uFillChLerpHighlight, h[0], h[1], h[2], h[3] == null ? 1 : h[3]);
      gl.uniform1i(uFillChLerpEnabled, 1);
    } else {
      gl.uniform1i(uFillChLerpEnabled, 0);
    }
    // Per-draw color matrix recolor (dual-tint fill recolor).
    // Caller supplies a 4x4 matrix + offset; the fragment shader
    // transforms vFill (and vStroke) via `out = M * in + offset` after
    // per-shape overrides and before coverage. When neither matrix nor
    // offset is set, the enabled flag stays 0 and the shader branch is
    // skipped (uniform branch, coherent across the draw → free).
    if (R.draw.colorMatrix || R.draw.colorMatrixOffset) {
      gl.uniformMatrix4fv(
        uFillColorMatrix, false,
        R.draw.colorMatrix || IDENTITY_COLOR_MATRIX);
      gl.uniform4fv(
        uFillColorMatrixOffset,
        R.draw.colorMatrixOffset || ZERO_OFFSET);
      gl.uniform1i(uFillColorMatrixEnabled, 1);
    } else {
      gl.uniform1i(uFillColorMatrixEnabled, 0);
    }
    // Per-draw palette LUT. Always pin uPalette to TEXTURE13 (even
    // when disabled) so the sampler has a valid binding; the enabled
    // flag gates the shader path. Caller's palette can be mutated
    // between draws at gl.texSubImage2D cost; no plumbing needed
    // here beyond the texture bind.
    gl.activeTexture(gl.TEXTURE13);
    if (R.draw.palette && R.draw.palette.texture) {
      gl.bindTexture(gl.TEXTURE_2D, R.draw.palette.texture);
      gl.uniform1i(uFillPalette, 13);
      gl.uniform1i(uFillPaletteEnabled, 1);
      gl.uniform1i(uFillPaletteChannel, R.draw.paletteChannel | 0);
      gl.uniform1i(uFillPaletteSize, Math.max(1, R.draw.palette.size | 0));
    } else {
      gl.bindTexture(gl.TEXTURE_2D, dummyGradientStops);
      gl.uniform1i(uFillPalette, 13);
      gl.uniform1i(uFillPaletteEnabled, 0);
    }
    // Per-draw external clip mask (setNodeClip). Always pin to
    // TEXTURE14 so the sampler has a valid binding; uExtClipMode gates the
    // shader path (default 0 → off, byte-identical to unclipped draws).
    gl.activeTexture(gl.TEXTURE14);
    if (R.draw.extClipTex && R.draw.extClipMode > 0) {
      gl.bindTexture(gl.TEXTURE_2D, R.draw.extClipTex);
      gl.uniform1i(uFillExtClipTex, 14);
      gl.uniform1i(uFillExtClipMode, R.draw.extClipMode | 0);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, dummyGradientStops);
      gl.uniform1i(uFillExtClipTex, 14);
      gl.uniform1i(uFillExtClipMode, 0);
    }
    if (cw !== R.fillPassCanvasW || ch !== R.fillPassCanvasH) {
      const [sx, sy] = arScale(R._handle.bundle.globalBBox, cw, ch);
      gl.uniform2f(uFillCanvasAR, sx, sy);
      gl.uniform2f(uFillViewportSize, cw, ch);
      R.fillPassCanvasW = cw;
      R.fillPassCanvasH = ch;
    }
    gl.bindVertexArray(R._handle.triVao);
  }

  function endFillPass() { fillPassActive = false; }

  R.beginFillPass = beginFillPass;
  R.endFillPass = endFillPass;
}
