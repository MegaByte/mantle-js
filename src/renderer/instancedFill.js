// instancedFill.js — instanced fill program, scratch buffer growth.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachInstancedFill(R) {
    let _instProg = null, _instU = null;
    const _instProgs = new Map();   // engineKey ('' Slug | 'MANTLE_AAC…') -> { prog, U }; _instProg/_instU point at the selected one
    let _instAttrBuf = null, _instAttrScratch = null, _instAttrCap = 0;
    // Compacted (header-free) cover-quad geometry for the instanced draw.
    // Keep a small LRU rather than only the last handle: games commonly
    // alternate several instanced assets (cards, HUD pieces, hazards), and a
    // one-entry cache re-packed and re-uploaded both meshes every frame.
    // The cover-quad buffer interleaves a
    // 12-float chunk header between shapes' vertex runs, so a single
    // drawArraysInstanced over the raw buffer would rasterize the headers as
    // garbage triangles. Pack just the vertices (in shape order) + their
    // shapeIdx into dedicated buffers so ONE instanced draw covers the whole
    // bundle, with the instance as the OUTER loop (instance 0's full shape
    // list, then instance 1's, …) — matching the per-instance loop's painter
    // order. Depth is disabled: shapes are emitted in shapeIdx = z order, so
    // painter's order already matches the depth test — and depth can't be
    // reset between instances within one instanced draw.
    const _instCompacts = new Map();
    const MAX_INST_COMPACTS = 8;
    const INST_FLOATS = 18;   // 3 vec3 worldM columns + alpha + rgba tint + rgba bias
    const COVER_STRIDE_F = 12; // floats per cover-quad vertex

    function _dropInstCompact(compact) {
      if (!compact) return;
      if (compact.vao) R.gl.deleteVertexArray(compact.vao);
      if (compact.vbo) R.gl.deleteBuffer(compact.vbo);
      if (compact.shapeVbo) R.gl.deleteBuffer(compact.shapeVbo);
    }

    function _createInstCompactVao(compact) {
      const vao = R.gl.createVertexArray();
      R.gl.bindVertexArray(vao);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, compact.vbo);
      const stride = COVER_STRIDE_F * 4;
      for (let i = 0; i < 7; i++) R.gl.enableVertexAttribArray(i);
      R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, stride, 0);
      R.gl.vertexAttribPointer(1, 2, R.gl.FLOAT, false, stride, 8);
      R.gl.vertexAttribPointer(2, 2, R.gl.FLOAT, false, stride, 16);
      R.gl.vertexAttribPointer(3, 2, R.gl.FLOAT, false, stride, 24);
      R.gl.vertexAttribPointer(4, 2, R.gl.FLOAT, false, stride, 32);
      R.gl.vertexAttribPointer(5, 1, R.gl.FLOAT, false, stride, 40);
      R.gl.vertexAttribPointer(6, 1, R.gl.FLOAT, false, stride, 44);
      for (let i = 0; i < 7; i++) R.gl.vertexAttribDivisor(i, 0);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, compact.shapeVbo);
      R.gl.enableVertexAttribArray(7);
      R.gl.vertexAttribPointer(7, 1, R.gl.FLOAT, false, 0, 0);
      R.gl.vertexAttribDivisor(7, 0);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instAttrBuf);
      const instanceStride = INST_FLOATS * 4;
      R.gl.enableVertexAttribArray(8);  R.gl.vertexAttribPointer(8,  3, R.gl.FLOAT, false, instanceStride, 0);   R.gl.vertexAttribDivisor(8, 1);
      R.gl.enableVertexAttribArray(9);  R.gl.vertexAttribPointer(9,  3, R.gl.FLOAT, false, instanceStride, 12);  R.gl.vertexAttribDivisor(9, 1);
      R.gl.enableVertexAttribArray(10); R.gl.vertexAttribPointer(10, 3, R.gl.FLOAT, false, instanceStride, 24);  R.gl.vertexAttribDivisor(10, 1);
      R.gl.enableVertexAttribArray(11); R.gl.vertexAttribPointer(11, 1, R.gl.FLOAT, false, instanceStride, 36);  R.gl.vertexAttribDivisor(11, 1);
      R.gl.enableVertexAttribArray(12); R.gl.vertexAttribPointer(12, 4, R.gl.FLOAT, false, instanceStride, 40);  R.gl.vertexAttribDivisor(12, 1);
      R.gl.enableVertexAttribArray(13); R.gl.vertexAttribPointer(13, 4, R.gl.FLOAT, false, instanceStride, 56);  R.gl.vertexAttribDivisor(13, 1);
      R.gl.bindVertexArray(null);
      return vao;
    }

    function _instCompactFor(handle) {
      const bundle = handle.bundle;
      const geomGen = bundle._geomGen | 0;
      const cullGen = bundle._cullGen | 0;
      const invalidGen = bundle._instCompactInvalidGen | 0;
      let compact = _instCompacts.get(bundle);
      if (compact && compact.geomGen === geomGen && compact.cullGen === cullGen
          && compact.invalidGen === invalidGen) {
        // Map insertion order is our LRU order.
        _instCompacts.delete(bundle);
        _instCompacts.set(bundle, compact);
        return compact;
      }

      if (compact) {
        _instCompacts.delete(bundle);
        _dropInstCompact(compact);
      }
      const cqf = bundle.coverQuadFloats;
      const sidx = bundle.hybridShapeIdxFloats;
      // Build from the draw list so instancing honors shapes removed by the
      // occlusion cull instead of reintroducing hidden AA edges.
      const chunks = [];
      for (const op of bundle.drawList) if (op.kind === 'fillShape' && op.chunk) chunks.push(op.chunk);
      let total = 0;
      for (const chunk of chunks) total += chunk.count;
      const verts = new Float32Array(total * COVER_STRIDE_F);
      const shapes = new Float32Array(total);
      let w = 0;
      for (const chunk of chunks) {
        const vStart = chunk.start * COVER_STRIDE_F;
        verts.set(cqf.subarray(vStart, vStart + chunk.count * COVER_STRIDE_F), w * COVER_STRIDE_F);
        if (sidx) for (let k = 0; k < chunk.count; k++) shapes[w + k] = sidx[chunk.start + k];
        w += chunk.count;
      }
      compact = {
        geomGen,
        cullGen,
        invalidGen,
        count: total,
        vbo: R.gl.createBuffer(),
        shapeVbo: R.gl.createBuffer(),
        vao: null,
      };
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, compact.vbo);
      R.gl.bufferData(R.gl.ARRAY_BUFFER, verts, R.gl.STATIC_DRAW);
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, compact.shapeVbo);
      R.gl.bufferData(R.gl.ARRAY_BUFFER, shapes, R.gl.STATIC_DRAW);
      compact.vao = _createInstCompactVao(compact);
      while (_instCompacts.size >= MAX_INST_COMPACTS) {
        const oldest = _instCompacts.keys().next().value;
        const retired = _instCompacts.get(oldest);
        _instCompacts.delete(oldest);
        _dropInstCompact(retired);
      }
      _instCompacts.set(bundle, compact);
      return compact;
    }
    // Compile+cache the instanced program for a given ENGINE (extra frag defines: [] = Slug,
    // ['MANTLE_AAC'…] = AAC). Sets _instProg/_instU to the selected variant. The VERTEX shader is
    // always MANTLE_INSTANCED (same attrib layout across engines), so the VAO/attr buffer are shared.
    function _ensureInstProg(extra) {
      const key = (extra && extra.length) ? extra.slice().sort().join('|') : '';
      const cached = _instProgs.get(key);
      if (cached) { if (cached.prog === false) return false; _instProg = cached.prog; _instU = cached.U; return true; }
      // Compile + link synchronously; a lazily-built program validates itself.
      const _ps0 = R._pendingShaders.length, _pp0 = R._pendingPrograms.length;
      const vs = R.compile(R.withDefines(R.shaderSources.fillVert, ['MANTLE_INSTANCED']), R.gl.VERTEX_SHADER);
      // The FRAGMENT shader needs MANTLE_INSTANCED too. It used not to — it was "shared
      // verbatim", because the only per-instance colour was a TINT, and a tint is
      // multiplicative so the vertex shader could fold it into vOverrideTint and the
      // fragment shader never had to know. A per-instance BIAS (a fog's offset) cannot be
      // folded into a multiply, so the fragment shader has to read it — and without the
      // define, its `in vec4 vInstBias` was compiled straight out and every fog silently
      // rendered as a plain tint.
      const fragDefs = (R.opts.fillDefines || []).concat(extra || [], ['MANTLE_INSTANCED']);
      const fs = R.compile(R.withDefines(R.shaderSources.fillFrag, fragDefs), R.gl.FRAGMENT_SHADER);
      const p = R.gl.createProgram();
      R.gl.attachShader(p, vs); R.gl.attachShader(p, fs); R.gl.linkProgram(p);
      if (!R.gl.getShaderParameter(vs, R.gl.COMPILE_STATUS) ||
          !R.gl.getShaderParameter(fs, R.gl.COMPILE_STATUS) ||
          !R.gl.getProgramParameter(p, R.gl.LINK_STATUS)) {
        R.mantleWarn('[Mantle] instanced fill program failed to build; falling back to per-instance loop.',
          R.gl.getShaderInfoLog(vs), R.gl.getShaderInfoLog(fs), R.gl.getProgramInfoLog(p));
        R._pendingShaders.length = _ps0; R._pendingPrograms.length = _pp0;
        R.gl.deleteProgram(p); R.gl.deleteShader(vs); R.gl.deleteShader(fs);
        _instProgs.set(key, { prog: false, U: null });
        return false;
      }
      // Drop ONLY our tail entries (validated inline) — zeroing the whole
      // queue silently dropped the deferred validation of unrelated
      // in-flight programs (prewarmed fill variants, the LB pair prog).
      R._pendingShaders.length = _ps0; R._pendingPrograms.length = _pp0;
      R.gl.deleteShader(vs); R.gl.deleteShader(fs);
      const U = {};
      for (const n of ['uCurveData', 'uBandData', 'uMetaTex', 'uDashTex', 'uGlobalBBox',
        'uShapeIdxOverride', 'uNumShapes', 'uCanvasAR', 'uViewportSize', 'uGradientTex',
        'uGradientStops', 'uGradientStopsCount', 'uGradientCount', 'uImageTex',
        'uImageAtlasSize', 'uFilterTex', 'uOverrideTex', 'uHasOverrides', 'uHasEmCoord',
        'uMaskRTArray', 'uMaskRowToLayerTex', 'uHasOffscreenMask', 'uHasOccupancy',
        'uColorMatrix', 'uColorMatrixOffset', 'uColorMatrixEnabled',
        'uPalette', 'uPaletteEnabled', 'uPaletteChannel', 'uPaletteSize',
        'uChannelLerpPrimary', 'uChannelLerpContrast', 'uChannelLerpHighlight', 'uChannelLerpEnabled',
        'uExtClipTex', 'uExtClipMode']) {
        U[n] = R.gl.getUniformLocation(p, n);
      }
      _instProgs.set(key, { prog: p, U });
      _instProg = p; _instU = U;
      if (!_instAttrBuf) _instAttrBuf = R.gl.createBuffer();
      return true;
    }
    // Strict gate: only the genuinely simple fill case is instanced; anything
    // with clip / mask / filter / group / image / 9-slice falls back to the
    // correct per-instance loop.
    function _simpleInstanceable(bundle, handle) {
      if (!bundle || !handle) return false;
      // Pure function of bundle geometry/cull generations + the handle's
      // mask regions — cached (the O(numShapes) meta walk ran per instanced
      // call per frame). A cull can remove the only unsupported op and make
      // the remaining draw list eligible for the compact draw.
      const gen9 = bundle._geomGen | 0;
      const cullGen9 = bundle._cullGen | 0;
      const hasMask9 = !!(handle.maskRegions && handle.maskRegions.length);
      const c9 = bundle._instSimpleCache;
      if (c9 && c9.gen === gen9 && c9.cullGen === cullGen9 && c9.hasMask === hasMask9) return c9.ok;
      const ok9 = _simpleInstanceableUncached(bundle, hasMask9);
      bundle._instSimpleCache = { gen: gen9, cullGen: cullGen9, hasMask: hasMask9, ok: ok9 };
      return ok9;
    }
    function _simpleInstanceableUncached(bundle, hasMask) {
      if (bundle._nineSliceActive) return false;
      if (hasMask) return false;
      if (bundle.filterGraphs && bundle.filterGraphs.length) return false;
      const dl = bundle.drawList;
      if (!dl || !dl.length) return false;
      for (const op of dl) {
        if (op.kind !== 'fillShape') return false;
        if (op.filterGraphId || op.filterId || op.colrGraphId || op.blendMode) return false;
      }
      if (!bundle.coverQuadChunks || !bundle.coverQuadChunks.length) return false;
      // No per-shape clip / mask / image (those need the offscreen / in-shader
      // routes the simple instanced pass doesn't bind).
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      for (let s = 0; s < n; s++) {
        const b = s * st;
        if (Math.floor(meta[b + 30] + 0.5) !== 0) return false;   // clipId
        if (Math.floor(meta[b + 31] + 0.5) !== 0) return false;   // maskId
        if (st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0) return false; // imageId
      }
      return true;
    }
    /// `packedColor` (optional, 8 floats per instance): the derived tint+bias
    /// when a diagonal colour matrix was folded in. It stays in drawDispatch's
    /// reusable scratch buffer so caller-owned instance objects remain untouched.
    function _drawBundleInstancedFast(bundle, instances, packedColor) {
      const n = instances.length;
      R._instFastCount = (R._instFastCount | 0) + 1;   // debugStats.instancedFastCount
      // Upload per-instance worldMatrix (col-major mat3) + alpha + rgba tint.
      if (n > _instAttrCap) {
        _instAttrCap = Math.max(n, _instAttrCap ? _instAttrCap * 2 : 64);
        _instAttrScratch = new Float32Array(_instAttrCap * INST_FLOATS);
        R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instAttrBuf);
        R.gl.bufferData(R.gl.ARRAY_BUFFER, _instAttrCap * INST_FLOATS * 4, R.gl.DYNAMIC_DRAW);
      }
      const S = _instAttrScratch;
      for (let i = 0; i < n; i++) {
        const inst = instances[i] || {};
        const wm = inst.worldMatrix;
        const o = i * INST_FLOATS;
        if (wm) { for (let k = 0; k < 9; k++) S[o + k] = wm[k]; }
        else { S[o] = 1; S[o+1] = 0; S[o+2] = 0; S[o+3] = 0; S[o+4] = 1; S[o+5] = 0; S[o+6] = 0; S[o+7] = 0; S[o+8] = 1; }
        S[o + 9] = (typeof inst.alpha === 'number') ? Math.max(0, Math.min(1, inst.alpha)) : 1.0;
        // Multiplicative tint. A DIAGONAL per-instance colour matrix is exactly a tint, so
        // it lands here too — see _isDiagCm in drawDispatch.
        const pc = packedColor ? i * 8 : -1;
        const tn = inst.tint;
        if (pc >= 0) {
          S[o + 10] = packedColor[pc]; S[o + 11] = packedColor[pc + 1];
          S[o + 12] = packedColor[pc + 2]; S[o + 13] = packedColor[pc + 3];
        } else if (tn) {
          S[o + 10] = tn[0]; S[o + 11] = tn[1]; S[o + 12] = tn[2];
          S[o + 13] = (tn.length > 3 && tn[3] != null) ? tn[3] : 1.0;
        } else {
          S[o + 10] = 1; S[o + 11] = 1; S[o + 12] = 1; S[o + 13] = 1;
        }
        // Additive bias — what a fog needs and a tint cannot express.
        if (pc >= 0) { S[o + 14] = packedColor[pc + 4]; S[o + 15] = packedColor[pc + 5]; S[o + 16] = packedColor[pc + 6]; S[o + 17] = packedColor[pc + 7]; }
        else    { S[o + 14] = 0; S[o + 15] = 0; S[o + 16] = 0; S[o + 17] = 0; }
      }
      R.gl.bindBuffer(R.gl.ARRAY_BUFFER, _instAttrBuf);
      R.gl.bufferSubData(R.gl.ARRAY_BUFFER, 0, S.subarray(0, n * INST_FLOATS));
  
      const [cw, ch] = R.viewportSize();
      R.gl.viewport(0, 0, cw, ch);
      // This path never reads depth or stencil. beginFrame has already cleared
      // them for an accumulated frame, and the normal fill path clears them
      // before it needs either resource. Avoid a full-target resource clear
      // for every simple instanced batch.
      R.gl.disable(R.gl.STENCIL_TEST);
      if (!R._inFrame) {
        R.gl.clearColor(1, 1, 1, 1);
        R.gl.clear(R.gl.COLOR_BUFFER_BIT);
      }
  
      const compact = _instCompactFor(R._handle);
  
      R.gl.bindVertexArray(compact.vao);
  
      // Bind program + state (trimmed beginFillPass for the simple bundle).
      const b = R._handle.bundle, U = _instU;
      R.gl.useProgram(_instProg);
      R.gl.enable(R.gl.BLEND); R.gl.blendFunc(R.gl.ONE, R.gl.ONE_MINUS_SRC_ALPHA);
      // Depth OFF: shapes are emitted in shapeIdx order = z order = draw order,
      // so painter's order already matches what the depth test would do — and
      // depth can't be reset between instances within one instanced draw the
      // way the per-instance loop does.
      R.gl.disable(R.gl.DEPTH_TEST); R.gl.depthMask(false);
      R.gl.activeTexture(R.gl.TEXTURE0); R.gl.bindTexture(R.gl.TEXTURE_2D, b.curveTex); R.gl.uniform1i(U.uCurveData, 0);
      R.gl.activeTexture(R.gl.TEXTURE1); R.gl.bindTexture(R.gl.TEXTURE_2D, b.bandTex);  R.gl.uniform1i(U.uBandData, 1);
      R.gl.activeTexture(R.gl.TEXTURE2); R.gl.bindTexture(R.gl.TEXTURE_2D, b.metaTex);  R.gl.uniform1i(U.uMetaTex, 2);
      R.gl.activeTexture(R.gl.TEXTURE3); R.gl.bindTexture(R.gl.TEXTURE_2D, b.dashTex || R.dummyDashTex); R.gl.uniform1i(U.uDashTex, 3);
      R.gl.activeTexture(R.gl.TEXTURE4); R.gl.bindTexture(R.gl.TEXTURE_2D, b.gradientTex || R.dummyGradientTex); R.gl.uniform1i(U.uGradientTex, 4);
      R.gl.activeTexture(R.gl.TEXTURE5); R.gl.bindTexture(R.gl.TEXTURE_2D, b.gradientStopsTex || R.dummyGradientStops); R.gl.uniform1i(U.uGradientStops, 5);
      R.gl.uniform1i(U.uGradientStopsCount, b.gradientStopsCount | 0);
      R.gl.uniform1i(U.uGradientCount, b.gradientCount);
      R.gl.activeTexture(R.gl.TEXTURE6); R.gl.bindTexture(R.gl.TEXTURE_2D, b.imageAtlasTex || R.dummyGradientStops); R.gl.uniform1i(U.uImageTex, 6);
      R.gl.uniform2f(U.uImageAtlasSize, b.imageAtlasSize[0] || 1, b.imageAtlasSize[1] || 1);
      R.gl.activeTexture(R.gl.TEXTURE7); R.gl.bindTexture(R.gl.TEXTURE_2D, b.filterTex || R.dummyGradientTex); R.gl.uniform1i(U.uFilterTex, 7);
      R.gl.uniform4f(U.uGlobalBBox, b.globalBBox[0], b.globalBBox[1], b.globalBBox[2], b.globalBBox[3]);
      R.gl.uniform1f(U.uNumShapes, Math.max(1, b.numShapes));
      R.gl.uniform1i(U.uShapeIdxOverride, -1);
      R.gl.uniform1i(U.uHasEmCoord, 0);
      R.gl.uniform1i(U.uHasOccupancy, b.hasOccupancy ? 1 : 0);
      // Mask off (simple bundle has none) — bind dummies the sampler needs.
      R.gl.activeTexture(R.gl.TEXTURE9);  R.gl.bindTexture(R.gl.TEXTURE_2D_ARRAY, R.maskRTDummy()); R.gl.uniform1i(U.uMaskRTArray, 9);
      R.gl.activeTexture(R.gl.TEXTURE10); R.gl.bindTexture(R.gl.TEXTURE_2D, R.maskRowToLayerDummy()); R.gl.uniform1i(U.uMaskRowToLayerTex, 10);
      R.gl.uniform1i(U.uHasOffscreenMask, 0);
      // Shared override table (applies to every instance).
      R.gl.activeTexture(R.gl.TEXTURE8);
      if (R.draw.overrides && R.draw.overrides.uploadIfDirty) {
        R.draw.overrides.uploadIfDirty();
        R.gl.bindTexture(R.gl.TEXTURE_2D, R.draw.overrides.texture);
        R.gl.uniform1i(U.uOverrideTex, 8); R.gl.uniform1i(U.uHasOverrides, 1);
      } else {
        R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientTex);
        R.gl.uniform1i(U.uOverrideTex, 8); R.gl.uniform1i(U.uHasOverrides, 0);
      }
      // Shared recolor state.
      if (R.draw.channelLerp) {
        const cl = R.draw.channelLerp;
        const pp = cl.primary || [0,0,0,1], cc = cl.contrast || [0,0,0,1], hh = cl.highlight || [1,1,1,1];
        R.gl.uniform4f(U.uChannelLerpPrimary, pp[0], pp[1], pp[2], pp[3] == null ? 1 : pp[3]);
        R.gl.uniform4f(U.uChannelLerpContrast, cc[0], cc[1], cc[2], cc[3] == null ? 1 : cc[3]);
        R.gl.uniform4f(U.uChannelLerpHighlight, hh[0], hh[1], hh[2], hh[3] == null ? 1 : hh[3]);
        R.gl.uniform1i(U.uChannelLerpEnabled, 1);
      } else { R.gl.uniform1i(U.uChannelLerpEnabled, 0); }
      if (R.draw.colorMatrix || R.draw.colorMatrixOffset) {
        R.gl.uniformMatrix4fv(U.uColorMatrix, false, R.draw.colorMatrix || R.IDENTITY_COLOR_MATRIX);
        R.gl.uniform4fv(U.uColorMatrixOffset, R.draw.colorMatrixOffset || R.ZERO_OFFSET);
        R.gl.uniform1i(U.uColorMatrixEnabled, 1);
      } else { R.gl.uniform1i(U.uColorMatrixEnabled, 0); }
      R.gl.activeTexture(R.gl.TEXTURE13);
      if (R.draw.palette && R.draw.palette.texture) {
        R.gl.bindTexture(R.gl.TEXTURE_2D, R.draw.palette.texture);
        R.gl.uniform1i(U.uPalette, 13); R.gl.uniform1i(U.uPaletteEnabled, 1);
        R.gl.uniform1i(U.uPaletteChannel, R.draw.paletteChannel | 0);
        R.gl.uniform1i(U.uPaletteSize, Math.max(1, R.draw.palette.size | 0));
      } else {
        R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientStops);
        R.gl.uniform1i(U.uPalette, 13); R.gl.uniform1i(U.uPaletteEnabled, 0);
      }
      R.gl.activeTexture(R.gl.TEXTURE14);
      if (R.draw.extClipTex && R.draw.extClipMode > 0) {
        R.gl.bindTexture(R.gl.TEXTURE_2D, R.draw.extClipTex);
        R.gl.uniform1i(U.uExtClipTex, 14); R.gl.uniform1i(U.uExtClipMode, R.draw.extClipMode | 0);
      } else {
        R.gl.bindTexture(R.gl.TEXTURE_2D, R.dummyGradientStops);
        R.gl.uniform1i(U.uExtClipTex, 14); R.gl.uniform1i(U.uExtClipMode, 0);
      }
      const [sx, sy] = R.arScale(b.globalBBox, cw, ch);
      R.gl.uniform2f(U.uCanvasAR, sx, sy);
      R.gl.uniform2f(U.uViewportSize, cw, ch);
  
      // ONE instanced draw over the whole compacted range. Instance is the
      // outer loop (inst 0's full shape list, then inst 1's, …) → identical
      // painter order to the per-instance render() loop.
      R.gl.drawArraysInstanced(R.gl.TRIANGLES, 0, compact.count, n);
      R.gl.bindVertexArray(null);
      R._handle.fillPassAssetDirty = true; R._fpUValid = false;   // next non-instanced pass rebinds.
      return n;
    }
    // In the per-instance draw loop, a bundle whose render depends on a SHARED
    // bake — multi-shape mask regions, a filter graph, or any per-shape
    // clip/mask/filter/COLR/blend — is cheaper on Slug: the bake runs ONCE and
    // every instance reuses it (the instancing win), whereas the analytic
    // composed path evaluates the mask/filter INLINE per instance (N times). So
    // those bundles stay on Slug; simple solid/gradient/image bundles (no shared
    // bake) may route the analytic fill. (Simple fill-only bundles never reach
    // the loop at all — they take the drawArraysInstanced fast path above.)
    function _instancedPrefersSlug(bundle, handle) {
      if (!bundle) return false;
      // This gate runs before the per-instance fallback loop. Cache its
      // O(drawList + numShapes) inspection; culling swaps drawList without a
      // geometry mutation, so its generation is part of the key.
      const gen = bundle._geomGen | 0;
      const cullGen = bundle._cullGen | 0;
      const hasMask = !!(handle && handle.maskRegions && handle.maskRegions.length);
      const cached = bundle._instSlugPrefersCache;
      if (cached && cached.gen === gen && cached.cullGen === cullGen && cached.hasMask === hasMask) return cached.ok;
      if (hasMask) {
        bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
        return true;
      }
      if (bundle.filterGraphs && bundle.filterGraphs.some(g => g)) {
        bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
        return true;
      }
      const dl = bundle.drawList;
      if (dl) for (const op of dl) {
        if (op.filterGraphId || op.filterId || op.colrGraphId || op.blendMode) {
          bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
          return true;
        }
      }
      const meta = bundle.metaFloats, st = bundle.metaFloatsPerShape | 0, n = bundle.numShapes | 0;
      if (meta) for (let s = 0; s < n; s++) {
        const b = s * st;
        if (Math.floor(meta[b + 30] + 0.5) !== 0 || Math.floor(meta[b + 31] + 0.5) !== 0) {
          bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: true };
          return true;
        }
      }
      bundle._instSlugPrefersCache = { gen, cullGen, hasMask, ok: false };
      return false;
    }
  R._ensureInstProg = _ensureInstProg;
  R._disposeInstProgs = () => {
    for (const v of _instProgs.values()) if (v && v.prog) R.gl.deleteProgram(v.prog);
    _instProgs.clear(); _instProg = null; _instU = null;
  };
  R._disposeInstCompacts = () => {
    for (const compact of _instCompacts.values()) _dropInstCompact(compact);
    _instCompacts.clear();
  };
  R._simpleInstanceable = _simpleInstanceable;
  R._instancedPrefersSlug = _instancedPrefersSlug;
  R._drawBundleInstancedFast = _drawBundleInstancedFast;
  Object.defineProperty(R, '_instProg', { get: () => _instProg });
  Object.defineProperty(R, '_instAttrBuf', { get: () => _instAttrBuf });
}
