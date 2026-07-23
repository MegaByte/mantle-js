// drawImages.js — createImage, drawImage, instanced image blit.

import { decodeImageHref } from '../svg/image.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachDrawImages(R) {
    // Instanced-blit VAO: loc 0 = the shared unit quad (per-vertex), loc 1..5
    // = per-instance attributes streamed from _instBuf (divisor 1). Layout per
    // instance: [dst.xyzw(4), wm col0(3), col1(3), col2(3), tint.rgba(4)] = 17
    // floats = 68 bytes. Buffer grows on demand in drawImageInstanced.
    const INST_STRIDE = 17 * 4;           // bytes per instance
    let _instVao = null, _instBuf = null, _instCap = 0;
    let _instScratch = null;              // Float32Array reused for upload
    function _ensureInstVao(count) {
      if (!_instVao) {
        _instVao = R.gl.createVertexArray();
        _instBuf = R.gl.createBuffer();
        R.gl.bindVertexArray(_instVao);
        // per-vertex unit quad on the shared R.maskBakeBuf (loc 0)
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, R.maskBakeBuf);
        R.gl.enableVertexAttribArray(0);
        R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, 0, 0);
        R.gl.vertexAttribDivisor(0, 0);
        // per-instance interleaved attributes on _instBuf (loc 1..5)
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instBuf);
        const f = 4, s = INST_STRIDE;
        R.gl.enableVertexAttribArray(1); R.gl.vertexAttribPointer(1, 4, R.gl.FLOAT, false, s,  0*f); R.gl.vertexAttribDivisor(1, 1);
        R.gl.enableVertexAttribArray(2); R.gl.vertexAttribPointer(2, 3, R.gl.FLOAT, false, s,  4*f); R.gl.vertexAttribDivisor(2, 1);
        R.gl.enableVertexAttribArray(3); R.gl.vertexAttribPointer(3, 3, R.gl.FLOAT, false, s,  7*f); R.gl.vertexAttribDivisor(3, 1);
        R.gl.enableVertexAttribArray(4); R.gl.vertexAttribPointer(4, 3, R.gl.FLOAT, false, s, 10*f); R.gl.vertexAttribDivisor(4, 1);
        R.gl.enableVertexAttribArray(5); R.gl.vertexAttribPointer(5, 4, R.gl.FLOAT, false, s, 13*f); R.gl.vertexAttribDivisor(5, 1);
        R.gl.bindVertexArray(null);
      }
      if (count > _instCap) {
        _instCap = Math.max(count, _instCap ? _instCap * 2 : 16);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instBuf);
        R.gl.bufferData(R.gl.ARRAY_BUFFER, _instCap * INST_STRIDE, R.gl.DYNAMIC_DRAW);
        _instScratch = new Float32Array(_instCap * 17);
      }
    }
    // Multiply RGBA8 straight-alpha bytes into premultiplied in place.
    function premultiplyRgba(u8) {
      let opaque = true;
      for (let i = 3; i < u8.length; i += 4) {
        if (u8[i] !== 255) { opaque = false; break; }
      }
      if (opaque) return u8;
      const out = new Uint8Array(u8);
      for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3];
        if (a === 255) continue;
        const f = a / 255;
        out[i]     = (out[i]     * f) | 0;
        out[i + 1] = (out[i + 1] * f) | 0;
        out[i + 2] = (out[i + 2] * f) | 0;
      }
      return out;
    }
  
    function makeImageTex(filter) {
      const t = R.gl.createTexture();
      R.gl.bindTexture(R.gl.TEXTURE_2D, t);
      const f = (filter === 'nearest') ? R.gl.NEAREST : R.gl.LINEAR;
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, f);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, f);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
      R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
      return t;
    }
  
    // Build a renderer-owned premultiplied RGBA8 texture from raw pixels.
    function imageFromPixels(width, height, rgba, opts) {
      const w = width | 0, h = height | 0;
      if (w <= 0 || h <= 0 || !rgba) return null;
      let u8 = (rgba instanceof Uint8Array) ? rgba : new Uint8Array(rgba.buffer || rgba);
      if (opts.premultiplied !== true) {
        u8 = premultiplyRgba(u8);
      }
      const tex = makeImageTex(opts.filter);
      R.gl.pixelStorei(R.gl.UNPACK_FLIP_Y_WEBGL, false);
      R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA8, w, h, 0, R.gl.RGBA, R.gl.UNSIGNED_BYTE, u8);
      return makeImageHandle(tex, w, h, /*owned*/ true);
    }
  
    // Build a texture from a DOM image-like source (ImageBitmap,
    // HTMLImageElement, HTMLCanvasElement, OffscreenCanvas, ImageData).
    function imageFromDomSource(domSrc, opts) {
      const w = (domSrc.width || domSrc.naturalWidth | 0);
      const h = (domSrc.height || domSrc.naturalHeight | 0);
      if (!w || !h) return null;
      const tex = makeImageTex(opts.filter);
      // The browser premultiplies on upload when asked — matches our
      // compositing without a manual RGBA pass.
      R.gl.pixelStorei(R.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        opts.premultiplied === true ? false : true);
      R.gl.pixelStorei(R.gl.UNPACK_FLIP_Y_WEBGL, false);
      try {
        R.gl.texImage2D(R.gl.TEXTURE_2D, 0, R.gl.RGBA8, R.gl.RGBA, R.gl.UNSIGNED_BYTE, domSrc);
      } catch (e) {
        R.gl.deleteTexture(tex);
        R.gl.pixelStorei(R.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        return null;
      }
      R.gl.pixelStorei(R.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      return makeImageHandle(tex, w, h, /*owned*/ true);
    }
  
    function makeImageHandle(tex, w, h, owned) {
      return {
        _mantleImage: true,
        texture: tex,
        width: w,
        height: h,
        dispose() {
          if (owned && tex) R.gl.deleteTexture(tex);
          this.texture = null;
        },
      };
    }
  
    // Detect DOM image-like objects without referencing browser globals
    // that may be absent (headless). Duck-type on the shapes texImage2D
    // accepts as TexImageSource.
    function isDomImageSource(s) {
      if (!s || typeof s !== 'object') return false;
      const ctor = s.constructor && s.constructor.name;
      return ctor === 'ImageBitmap' || ctor === 'HTMLImageElement'
          || ctor === 'HTMLCanvasElement' || ctor === 'OffscreenCanvas'
          || ctor === 'HTMLVideoElement' || ctor === 'ImageData'
          || (typeof s.width === 'number' && typeof s.height === 'number'
              && (s.tagName === 'IMG' || s.tagName === 'CANVAS'));
    }
  
    // Free an external-clip coverage texture from renderClipCoverage.
    function deleteClipTexture(tex) {
      if (tex) R.gl.deleteTexture(tex);
    }

    // Normalize any supported source into a Mantle image handle.
    // Synchronous sources resolve immediately; encoded hrefs/strings are
    // async (returns a Promise). Supported:
    //   - a Mantle image handle (passthrough)
    //   - a WebGLTexture (wrapped, NOT owned → caller disposes)
    //   - { width, height, data | rgba } raw pixels
    //   - ImageBitmap / HTMLImageElement / HTMLCanvasElement / ImageData
    //   - string href / data-URL / encoded bytes via decodeImageHref
    //   - { isSvg, svgText } / SVG href → returns { isSvg: true } so the
    //     caller can route through importSvg (raster blit can't draw SVG)
    function createImage(source, opts = {}) {
      if (!source) return null;
      if (source._mantleImage) return source;
      // Bare WebGLTexture: caller owns it (we don't delete on dispose).
      if (typeof WebGLTexture !== 'undefined' && source instanceof WebGLTexture) {
        const w = opts.width | 0, h = opts.height | 0;
        return makeImageHandle(source, w, h, /*owned*/ false);
      }
      // Raw pixels.
      if (source.data || source.rgba) {
        return imageFromPixels(source.width, source.height,
          source.rgba || source.data, opts);
      }
      // DOM image-like.
      if (isDomImageSource(source)) {
        if (source.data && typeof source.width === 'number'
            && source.constructor && source.constructor.name === 'ImageData') {
          return imageFromPixels(source.width, source.height, source.data, opts);
        }
        return imageFromDomSource(source, opts);
      }
      // Encoded href / data-URL / remote URL → async decode (reuses the
      // exact <image> decode path so behavior matches SVG image fills).
      if (typeof source === 'string') {
        return decodeImageHref(source, opts).then((dec) => {
          if (!dec) return null;
          if (dec.isSvg) return { isSvg: true, svgText: dec.svgText };
          return imageFromPixels(dec.w, dec.h, dec.rgba, opts);
        });
      }
      return null;
    }
  
    // Identity mat3 (column-major) reused when no worldMatrix is given.
    const _imgIdentM = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  
    // Composite an image (handle or raw source) into the current frame.
    // opts:
    //   dstRect:   [x, y, w, h] destination in viewport pixels (y-down).
    //              Defaults to the image's natural size at the origin.
    //   worldMatrix: column-major mat3 (Float32Array(9)) for rotation/skew,
    //                applied in pixel space; identity by default.
    //   srcRect:   [x, y, w, h] source sub-rect in PIXELS (atlas/sprite).
    //              Default = whole image.
    //   alpha:     0..1 global multiplier (default 1).
    //   tint:      [r,g,b,a] straight-alpha color multiply (default white).
    //   colorMatrix:       column-major mat4 (16 floats) recolor, applied to
    //                      straight color before tint/alpha, exactly as on the
    //                      vector path (drawBundle's opts.colorMatrix).
    //   colorMatrixOffset: vec4 added after the matrix (default zero).
    //                      Either option alone enables the recolor.
    //   blendMode: 0 normal, 1 multiply, 2 screen, 4 darken, 5 lighten.
    // A non-handle source is uploaded for this draw only (one-shot) and
    // released after — for repeated draws, createImage() once and pass the
    // handle. Returns false if it could not draw (no shader / bad source).
    function drawImage(source, opts = {}) {
      if (R._contextLost || R._canvasUnsized()) return false;
      // Record the ORIGINAL source for SVG export — a re-drawable DOM
      // source / URL replays on the native backend; a GPU image handle is
      // reported as skipped there (it can't be re-rasterized off the GPU).
      if (R._captureFrames && R._inFrame) R._recordImageDraw(source, opts);
      if (!R.drawImageProg) {
        R.mantleWarn('[Mantle] drawImage shader not present; pass '
          + 'drawImageVert + drawImageFrag in shaderSources (loadShaders '
          + 'includes them).');
        return false;
      }
      // Resolve the source to a handle. One-shot uploads are disposed after.
      let img = source && source._mantleImage ? source : null;
      let oneShot = null;
      if (!img) {
        const made = createImage(source, opts);
        if (made && typeof made.then === 'function') {
          R.mantleWarn('[Mantle] drawImage got an async source (encoded/href); '
            + 'await renderer.createImage(src) first, then pass the handle.');
          return false;
        }
        if (!made || made.isSvg || !made.texture) return false;
        img = made; oneShot = made;
      }
      if (!img.texture) return false;
  
      const [vw, vh] = R.viewportSize();
      const dst = opts.dstRect
        || [0, 0, img.width, img.height];
      // src sub-rect in pixels → [0,1] uv.
      const sr = opts.srcRect;
      const uv = sr
        ? [sr[0] / img.width, sr[1] / img.height,
           sr[2] / img.width, sr[3] / img.height]
        : [0, 0, 1, 1];
      const tint = opts.tint || [1, 1, 1, 1];
      const alpha = (typeof opts.alpha === 'number')
        ? Math.max(0, Math.min(1, opts.alpha)) : 1.0;
  
      R.gl.useProgram(R.drawImageProg);
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.bindTexture(R.gl.TEXTURE_2D, img.texture);
      R.gl.uniform1i(R.diUTex, 0);
      R.gl.uniform4f(R.diUTint, tint[0], tint[1], tint[2],
        tint.length > 3 ? tint[3] : 1.0);
      R.gl.uniform1f(R.diUAlpha, alpha);
      R.gl.uniform4f(R.diUDstRect, dst[0], dst[1], dst[2], dst[3]);
      R.gl.uniform4f(R.diUSrcRect, uv[0], uv[1], uv[2], uv[3]);
      R.gl.uniform2f(R.diUViewport, vw, vh);
      // Accept a Float32Array or a plain 9-element array for worldMatrix.
      const wm = opts.worldMatrix
        ? (opts.worldMatrix instanceof Float32Array
            ? opts.worldMatrix : new Float32Array(opts.worldMatrix))
        : _imgIdentM;
      R.gl.uniformMatrix3fv(R.diUWorldM, false, wm);
      // Per-draw recolor; same enable rule as the vector path (either half
      // present turns it on, the missing half falls back to identity/zero).
      const cm = opts.colorMatrix, cmo = opts.colorMatrixOffset;
      if ((cm || cmo) && R.diUCEnabled) {
        R.gl.uniformMatrix4fv(R.diUCMatrix, false,
          cm ? (cm instanceof Float32Array ? cm : new Float32Array(cm))
             : R.IDENTITY_COLOR_MATRIX);
        const o = cmo || R.ZERO_OFFSET;
        R.gl.uniform4f(R.diUCOffset, o[0], o[1], o[2], o[3] || 0);
        R.gl.uniform1i(R.diUCEnabled, 1);
      } else if (R.diUCEnabled) R.gl.uniform1i(R.diUCEnabled, 0);
  
      R.gl.enable(R.gl.BLEND);
      R.applyBlendMode(opts.blendMode | 0);
      // Draw to the default framebuffer (canvas) with the user scissor, if any.
      R.bindFb(R.gl.FRAMEBUFFER, null);
      R.gl.viewport(0, 0, vw, vh);
      R.gl.disable(R.gl.DEPTH_TEST);
      R.gl.bindVertexArray(R.maskBakeVao);   // unit quad [0,1]² as TRIANGLE_STRIP
      R.gl.drawArrays(R.gl.TRIANGLE_STRIP, 0, 4);
      R.gl.bindVertexArray(null);
      // Restore the renderer's default src-over for subsequent passes.
      R.gl.blendEquation(R.gl.FUNC_ADD);
      R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
  
      // Changed program + clobbered TEXTURE0. Self-report so a following
      // drawBundle re-binds its asset textures instead of trusting the
      // fill-pass cache (same contract as the mask/filter/cache passes).
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;
  
      if (oneShot) oneShot.dispose();
      return true;
    }
  
    // drawImageInstanced(source, instances, opts) — stamp ONE shared source
    // texture at N transforms in a single instanced draw call. `source` is an
    // image handle (from createImage) or a raster the same forms drawImage
    // accepts. `instances` is an array of { dstRect?, worldMatrix?, tint?,
    // alpha? } — each the per-instance form of drawImage's opts. `opts.srcRect`
    // (shared) and `opts.blendMode` (shared) apply to every instance.
    //
    // GPU instancing: the asset is uploaded once and the GPU iterates the
    // instance buffer, collapsing N draw calls into one. Returns the instance
    // count drawn, or 0 on failure.
    const _diiIdentCols = [1,0,0, 0,1,0, 0,0,1];   // mat3 identity, column-major
    function drawImageInstanced(source, instances, opts = {}) {
      if (R._contextLost || R._canvasUnsized()) return 0;
      if (!R.drawImageInstProg) {
        R.mantleWarn('[Mantle] drawImageInstanced shader not present; pass '
          + 'drawImageInstancedVert + drawImageInstancedFrag in shaderSources '
          + '(loadShaders includes them).');
        return 0;
      }
      if (!Array.isArray(instances) || instances.length === 0) return 0;
  
      let img = source && source._mantleImage ? source : null;
      let oneShot = null;
      if (!img) {
        const made = createImage(source, opts);
        if (made && typeof made.then === 'function') {
          R.mantleWarn('[Mantle] drawImageInstanced got an async source; '
            + 'await renderer.createImage(src) first, then pass the handle.');
          return 0;
        }
        if (!made || made.isSvg || !made.texture) return 0;
        img = made; oneShot = made;
      }
      if (!img.texture) return 0;
  
      const n = instances.length;
      _ensureInstVao(n);
      const buf = _instScratch;
      for (let i = 0; i < n; i++) {
        const inst = instances[i] || {};
        const dst = inst.dstRect;
        // wm is only element-indexed into a scratch buffer below (never
        // passed to uniformMatrix3fv), so a plain array works as-is.
        const wm = inst.worldMatrix || _diiIdentCols;
        const tint = inst.tint;
        const alpha = (typeof inst.alpha === 'number')
          ? Math.max(0, Math.min(1, inst.alpha)) : 1.0;
        const ta = (tint && tint.length > 3 ? tint[3] : 1.0) * alpha;
        let o = i * 17;
        buf[o++] = dst ? dst[0] : 0;
        buf[o++] = dst ? dst[1] : 0;
        buf[o++] = dst ? dst[2] : img.width;
        buf[o++] = dst ? dst[3] : img.height;
        // mat3 columns (column-major source → laid out col0,col1,col2)
        buf[o++] = wm[0]; buf[o++] = wm[1]; buf[o++] = wm[2];
        buf[o++] = wm[3]; buf[o++] = wm[4]; buf[o++] = wm[5];
        buf[o++] = wm[6]; buf[o++] = wm[7]; buf[o++] = wm[8];
        // tint.rgb, folded alpha (tint.a*alpha) so the frag matches drawImage
        buf[o++] = tint ? tint[0] : 1;
        buf[o++] = tint ? tint[1] : 1;
        buf[o++] = tint ? tint[2] : 1;
        buf[o++] = ta;
      }
  
      const [vw, vh] = R.viewportSize();
      const sr = opts.srcRect;
      const uv = sr
        ? [sr[0] / img.width, sr[1] / img.height, sr[2] / img.width, sr[3] / img.height]
        : [0, 0, 1, 1];
  
      R.gl.useProgram(R.drawImageInstProg);
      R.gl.activeTexture(R.gl.TEXTURE0);
      R.gl.bindTexture(R.gl.TEXTURE_2D, img.texture);
      R.gl.uniform1i(R.diiUTex, 0);
      R.gl.uniform2f(R.diiUViewport, vw, vh);
      R.gl.uniform4f(R.diiUSrcRect, uv[0], uv[1], uv[2], uv[3]);
  
      R.gl.bindVertexArray(_instVao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instBuf);
      R.gl.bufferSubData(R.gl.ARRAY_BUFFER, 0, buf, 0, n * 17);
  
      R.gl.enable(R.gl.BLEND);
      R.applyBlendMode(opts.blendMode | 0);
      R.bindFb(R.gl.FRAMEBUFFER, null);
      R.gl.viewport(0, 0, vw, vh);
      R.gl.disable(R.gl.DEPTH_TEST);
      R.gl.drawArraysInstanced(R.gl.TRIANGLE_STRIP, 0, 4, n);
      R.gl.bindVertexArray(null);
      R.gl.blendEquation(R.gl.FUNC_ADD);
      R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
  
      // Clobbered program + TEXTURE0 — same self-report contract as drawImage.
      if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;
  
      if (oneShot) oneShot.dispose();
      return n;
    }
  R.createImage = createImage;
  R.drawImage = drawImage;
  R.drawImageInstanced = drawImageInstanced;
  R.deleteClipTexture = deleteClipTexture;
  R._ensureInstVao = _ensureInstVao;
  Object.defineProperty(R, '_instVao', { get: () => _instVao });
  Object.defineProperty(R, '_instBuf', { get: () => _instBuf });
}
