// incrementalStroke.js — a DYNAMIC polyline stroke that grows in place: the
// paint-tool fast path. A freehand brush stroke appends one point per pointer
// move; re-importing the whole path each time (SVG parse → style → Slug
// tessellation) makes append cost scale with total stroke length. This module
// keeps the stroke GPU-resident and makes each append O(1):
//
//   const s = renderer.createIncrementalStroke({ color, width, bbox });
//   s.appendPoints([[x, y], …]);   // per pointer-move; tessellates ONLY the new segments
//   drawBundle(s.bundle, opts);    // or mount s.bundle via createBundleHandle
//   s.finalize();                  // freeze; returns { pathD, svg } for re-hosting
//   s.dispose();
//
// RENDER PATH — the exact machinery the static analytic stroke route already
// uses (buildMorphStroke + morphStroke.vert/frag at t=0, MAX-blend union into
// a pooled coverage RT, then the shared lbComp composite quad). Caps, joins,
// dashes-off AA falloff are therefore IDENTICAL to a whole-loaded stroke on
// the analytic route, and within AA tolerance of the Slug stroke (see
// lbStrokeParitySmoke for that equivalence). One band quad per segment; the
// frag distance-fields the segment with cap/join logic from the neighbour
// tangents, so appending a segment only has to:
//   • write the new segment's 6 prim texels + 6 band-quad verts, and
//   • patch the PREVIOUS segment's nextP1 texel + clear its freeEnd flag
//     (its end cap becomes a join).
// Both are constant-size writes; the GPU upload at the next draw is a
// texSubImage2D of the touched prim rows + a bufferSubData of the vert tail.
//
// The stroke's bundle is a minimal bundle-like object flagged `_incStroke`;
// _analyticRoute branches on the flag before any Slug/LB gating, so it draws
// through every public entry point (drawBundle, handle.draw, drawInstance,
// drawBundleInstanced) with per-draw worldMatrix/alpha/colorMatrix honored.
// It carries NO Slug geometry (numShapes 0) so a fallback render() no-ops.
//
// Scope: solid straight-RGBA stroke paint. Per-draw colorMatrix(+offset) is
// applied CPU-side to the single color (exact for a solid). Overrides,
// palettes, channelLerp, dashes, and node clips are out of scope — a paint
// stroke uses none of them.

const PRIM_W = 512;                    // prim texture width (texels) — mirrors PRIM_TEX_W
const TEXELS_PER_SEG = 6;              // [srcP0P1][srcP2P3][dstP0P1][dstP2P3][prevP2 s,d][nextP1 s,d]
const VERT_FLOATS_PER_SEG = 24;        // 6 verts × [primBase, corner, segFlags, contourStart]
const CORNERS = [0, 1, 2, 0, 2, 3];
const CAP = { butt: 0, round: 1, square: 2 };
const JOIN = { miter: 0, round: 1, bevel: 2 };

function rgbaCss(c) {
  const r = Math.round((c[0] || 0) * 255), g = Math.round((c[1] || 0) * 255), b = Math.round((c[2] || 0) * 255);
  return `rgba(${r},${g},${b},${c[3] == null ? 1 : c[3]})`;
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachIncrementalStroke(R) {
  const gl = R.gl;

  // ── CPU-side growable stores (whole prim rows so texture uploads are
  //    row-aligned; both double on overflow) ─────────────────────────────
  function ensurePrimCap(h, texels) {
    const need = texels * 4;
    if (need <= h.prim.length) return;
    let cap = h.prim.length;
    while (cap < need) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(h.prim);
    h.prim = grown;
  }
  function ensureVertCap(h, floats) {
    if (floats <= h.verts.length) return;
    let cap = h.verts.length;
    while (cap < floats) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(h.verts);
    h.verts = grown;
  }
  function markPrimDirty(h, texel) { if (h.dirtyTexelLo < 0 || texel < h.dirtyTexelLo) h.dirtyTexelLo = texel; }
  function markVertDirty(h, floatIdx) { if (h.dirtyVertLo < 0 || floatIdx < h.dirtyVertLo) h.dirtyVertLo = floatIdx; }

  // Write segment slot `si`: an elevated cubic P (4 points), the neighbour
  // tangent points, and the free-end flags. Both src and dst planes get the
  // same data (a static stroke is the degenerate morph src == dst, t = 0).
  function writeSeg(h, si, P, prevP2, nextP1, freeStart, freeEnd) {
    const t = si * TEXELS_PER_SEG;
    ensurePrimCap(h, t + TEXELS_PER_SEG);
    const f = h.prim, w = t * 4;
    f[w] = P[0][0]; f[w + 1] = P[0][1]; f[w + 2] = P[1][0]; f[w + 3] = P[1][1];    // src P0,P1
    f[w + 4] = P[2][0]; f[w + 5] = P[2][1]; f[w + 6] = P[3][0]; f[w + 7] = P[3][1]; // src P2,P3
    f[w + 8] = f[w]; f[w + 9] = f[w + 1]; f[w + 10] = f[w + 2]; f[w + 11] = f[w + 3];   // dst = src
    f[w + 12] = f[w + 4]; f[w + 13] = f[w + 5]; f[w + 14] = f[w + 6]; f[w + 15] = f[w + 7];
    f[w + 16] = prevP2[0]; f[w + 17] = prevP2[1]; f[w + 18] = prevP2[0]; f[w + 19] = prevP2[1]; // prevP2 src,dst
    f[w + 20] = nextP1[0]; f[w + 21] = nextP1[1]; f[w + 22] = nextP1[0]; f[w + 23] = nextP1[1]; // nextP1 src,dst
    markPrimDirty(h, t);
    const vo = si * VERT_FLOATS_PER_SEG;
    ensureVertCap(h, vo + VERT_FLOATS_PER_SEG);
    const v = h.verts, flags = (freeStart ? 1 : 0) | (freeEnd ? 2 : 0);
    for (let k = 0; k < 6; k++) {
      const o = vo + k * 4;
      v[o] = t; v[o + 1] = CORNERS[k]; v[o + 2] = flags; v[o + 3] = 0;  // one open contour → contourStart 0
    }
    markVertDirty(h, vo);
  }
  // The previous segment's end cap becomes a join: point its nextP1 texel at
  // the new segment's P1 and clear its freeEnd flag. O(1).
  function patchPrevSeg(h, si, nextP1) {
    const t = si * TEXELS_PER_SEG, w = (t + 5) * 4, f = h.prim;
    f[w] = nextP1[0]; f[w + 1] = nextP1[1]; f[w + 2] = nextP1[0]; f[w + 3] = nextP1[1];
    markPrimDirty(h, t + 5);
    const vo = si * VERT_FLOATS_PER_SEG, v = h.verts;
    const flags = si === 0 ? 1 : 0;                     // keep freeStart on the first segment
    for (let k = 0; k < 6; k++) v[vo + k * 4 + 2] = flags;
    markVertDirty(h, vo);
  }
  // Degree-elevate the line a→b to the uniform cubic hull the stroke frag
  // expects (identical to buildMorphStroke's elevateToCubic for lines).
  function elevLine(a, b) {
    return [a,
      [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
      [a[0] + 2 * (b[0] - a[0]) / 3, a[1] + 2 * (b[1] - a[1]) / 3],
      b];
  }

  // ── GPU flush: upload only what changed since the last draw ──────────
  function flush(h) {
    // Vert buffer (per-handle VAO + VBO, capacity-managed).
    if (!h.vao) {
      h.vao = gl.createVertexArray();
      h.buf = gl.createBuffer();
      gl.bindVertexArray(h.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, h.buf);
      for (let a = 0; a < 4; a++) {
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 1, gl.FLOAT, false, 16, a * 4);
      }
      gl.bindVertexArray(null);
      h.bufCap = 0;
    }
    const vertFloats = h.segCount * VERT_FLOATS_PER_SEG;
    if (vertFloats > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, h.buf);
      if (h.verts.length > h.bufCap) {
        gl.bufferData(gl.ARRAY_BUFFER, h.verts.byteLength, gl.DYNAMIC_DRAW);   // capacity (bytes)
        h.bufCap = h.verts.length;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, h.verts.subarray(0, vertFloats));
      } else if (h.dirtyVertLo >= 0) {
        gl.bufferSubData(gl.ARRAY_BUFFER, h.dirtyVertLo * 4, h.verts.subarray(h.dirtyVertLo, vertFloats));
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    h.dirtyVertLo = -1;

    // Prim texture (RGBA32F, PRIM_W wide, row capacity grows geometrically).
    const texels = h.segCount * TEXELS_PER_SEG;
    const rowsNeeded = Math.max(1, Math.ceil(texels / PRIM_W));
    if (!h.tex || rowsNeeded > h.texRows) {
      let rows = Math.max(1, h.texRows);
      while (rows < rowsNeeded) rows *= 2;
      ensurePrimCap(h, rows * PRIM_W);                  // capacity is whole rows
      if (h.tex) gl.deleteTexture(h.tex);
      h.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, h.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PRIM_W, rows, 0, gl.RGBA, gl.FLOAT,
                    h.prim.subarray(0, rows * PRIM_W * 4));
      gl.bindTexture(gl.TEXTURE_2D, null);
      h.texRows = rows;
    } else if (h.dirtyTexelLo >= 0) {
      const row0 = Math.floor(h.dirtyTexelLo / PRIM_W);
      const row1 = Math.ceil(texels / PRIM_W);          // exclusive
      gl.bindTexture(gl.TEXTURE_2D, h.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row0, PRIM_W, row1 - row0, gl.RGBA, gl.FLOAT,
                       h.prim.subarray(row0 * PRIM_W * 4, row1 * PRIM_W * 4));
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    h.dirtyTexelLo = -1;
  }

  // Per-draw effective color: straight RGBA × per-draw colorMatrix(+offset)
  // (exact CPU application for a solid paint) × per-draw alpha.
  function drawColor(h) {
    let r = h.color[0], g = h.color[1], b = h.color[2], a = h.color[3];
    const m = R.draw.colorMatrix, off = R.draw.colorMatrixOffset;
    if (m || off) {
      // Same convention as the fill pass: uniformMatrix4fv(transpose=false)
      // → the JS array is COLUMN-major; out = M·in + offset.
      const M = m || R.IDENTITY_COLOR_MATRIX, O = off || R.ZERO_OFFSET;
      const nr = M[0] * r + M[4] * g + M[8]  * b + M[12] * a + O[0];
      const ng = M[1] * r + M[5] * g + M[9]  * b + M[13] * a + O[1];
      const nb = M[2] * r + M[6] * g + M[10] * b + M[14] * a + O[2];
      const na = M[3] * r + M[7] * g + M[11] * b + M[15] * a + O[3];
      r = Math.min(1, Math.max(0, nr)); g = Math.min(1, Math.max(0, ng));
      b = Math.min(1, Math.max(0, nb)); a = Math.min(1, Math.max(0, na));
    }
    return [r, g, b, a * R.draw.alpha];
  }

  // ── The draw: stroke coverage (MAX union) → composite (OVER) ─────────
  // Called from _analyticRoute for any bundle flagged `_incStroke`; reads the
  // current per-draw state (R.draw.worldM / alpha / colorMatrix). Always
  // returns true — the bundle has no Slug geometry to fall back to.
  function _drawIncrementalStroke(bundle) {
    const h = bundle._incStroke;
    if (!h || h.disposed || R._contextLost) return true;
    if (!R.morphStrokeProg || !R.lbCompProg) return true;   // stroke/composite shaders unavailable
    if (!h.segCount) return true;                           // nothing appended yet
    const [cw, ch] = R.viewportSize();
    if (cw < 1 || ch < 1) return true;
    flush(h);

    const bbox = h.bbox;
    const [sx, sy] = R.arScale(bbox, cw, ch);
    const worldM = R.draw.worldM;
    const U = R.morphStrokeU;

    // Pass 1: analytic stroke coverage into a pooled RT (MAX blend = the
    // round-cap/round-join distance-field union) — _renderMorphStrokeCovRT's
    // exact GL sequence, with the handle's own VAO + incremental prim texture.
    const rtIdx = R._covPool.acquire(cw, ch);
    const rt = R._covPool.get(rtIdx);
    R.bindFb(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(R.morphStrokeProg);
    gl.uniform1f(U.uT, 0);
    gl.uniform1i(U.uPrimW, PRIM_W);
    gl.uniform1f(U.uHalfW, h.halfW);
    if (U.uMiterLimit) gl.uniform1f(U.uMiterLimit, h.miterLimit);
    if (U.uCapStyle) gl.uniform1i(U.uCapStyle, h.capStyle);
    if (U.uJoinStyle) gl.uniform1i(U.uJoinStyle, h.joinStyle);
    if (U.uDashId) gl.uniform1i(U.uDashId, 0);
    gl.uniform4f(U.uGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
    gl.uniform2f(U.uCanvasAR, sx, sy);
    gl.uniform2f(U.uViewport, cw, ch);
    if (worldM) { gl.uniformMatrix3fv(U.uWorldM, false, worldM); gl.uniform1i(U.uHasWorldM, 1); }
    else gl.uniform1i(U.uHasWorldM, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, h.tex); gl.uniform1i(U.uPrim, 0);
    if (U.uDashTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.dummyDashTex); gl.uniform1i(U.uDashTex, 1); }
    gl.bindVertexArray(h.vao);
    gl.drawArrays(gl.TRIANGLES, 0, h.segCount * 6);
    gl.bindVertexArray(null);

    // Pass 2: composite paint × coverage OVER the canvas (or the active cache
    // bake target) — the shared lbComp fullscreen quad, premultiplied.
    R.bindFb(gl.FRAMEBUFFER, R._cacheTargetFbo || null);
    gl.viewport(0, 0, cw, ch);
    gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(R.lbCompProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    gl.uniform1i(R.lbcUCoverage, 0);
    const c = drawColor(h);
    gl.uniform4f(R.lbcUColor, c[0], c[1], c[2], c[3]);
    // The pooled RT is quantized (≥ viewport): map the quad's UV into the
    // bottom-left viewport-sized region the coverage pass actually rendered.
    if (R.lbcUCovScale) gl.uniform2f(R.lbcUCovScale, cw / rt.size[0], ch / rt.size[1]);
    gl.bindVertexArray(R.coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    // Unbind the pooled RT from unit 0: the next coverage pass may re-acquire
    // it as its render target (framebuffer↔texture feedback loop otherwise).
    gl.bindTexture(gl.TEXTURE_2D, null);
    R._covPool.release(rtIdx);
    if (R._handle) R._handle.fillPassAssetDirty = true; R._fpUValid = false;   // next Slug pass rebinds
    h.drawCount++;
    return true;
  }

  /**
   * Create a dynamic polyline stroke.
   *
   * @param {object} opts
   * @param {[number,number,number,number]} [opts.color]  straight RGBA (default opaque black)
   * @param {number} opts.width      stroke width in user units (the bbox space)
   * @param {[number,number,number,number]} opts.bbox  PINNED global bbox `[x,y,w,h]`
   *        (e.g. the paint surface's reference viewport). Points are in this
   *        space; the bbox never grows with the stroke, so mount placement is
   *        stable while drawing.
   * @param {'butt'|'round'|'square'} [opts.capStyle='round']
   * @param {'miter'|'round'|'bevel'} [opts.joinStyle='round']
   * @param {number} [opts.miterLimit=4]
   * @param {Array<[number,number]>} [opts.points]  initial points
   * @returns incremental-stroke handle (see fields below)
   */
  function createIncrementalStroke(opts) {
    if (!opts || !(opts.width > 0) || !opts.bbox || opts.bbox.length !== 4) {
      throw new Error('createIncrementalStroke: { width > 0, bbox: [x,y,w,h] } required');
    }
    const h = {
      color: (opts.color && opts.color.length === 4) ? opts.color.slice() : [0, 0, 0, 1],
      halfW: opts.width / 2,
      bbox: [opts.bbox[0], opts.bbox[1], opts.bbox[2], opts.bbox[3]],
      capStyle: CAP[opts.capStyle] ?? CAP.round,
      joinStyle: JOIN[opts.joinStyle] ?? JOIN.round,
      miterLimit: opts.miterLimit > 0 ? opts.miterLimit : 4,
      pts: [],                        // flat [x0,y0, x1,y1, …]
      segCount: 0,
      prim: new Float32Array(PRIM_W * 4),          // one row
      verts: new Float32Array(64 * VERT_FLOATS_PER_SEG),
      dirtyTexelLo: -1,
      dirtyVertLo: -1,
      lastP2: null,                   // previous segment's elevated P2 (join tangent source)
      tex: null, texRows: 0,
      vao: null, buf: null, bufCap: 0,
      finalized: false,
      disposed: false,
      drawCount: 0,
      bundle: null,
      get pointCount() { return h.pts.length / 2; },
      get segmentCount() { return h.segCount; },
      /** SVG path data for the polyline (persistence / re-hosting). */
      get pathD() {
        const p = h.pts;
        if (!p.length) return '';
        let d = `M${p[0]} ${p[1]}`;
        for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
        return d;
      },
      /**
       * Append points (user units, the bbox space). O(1) per point: writes
       * the new segment's texels/verts and patches the previous segment's
       * join. Exact duplicates of the last point are skipped. The GPU upload
       * happens on the next draw (touched prim rows + the vert tail only).
       */
      appendPoints(points) {
        if (h.finalized || h.disposed) throw new Error('incremental stroke is finalized/disposed');
        for (const pt of points) {
          const x = +pt[0], y = +pt[1], p = h.pts, n = p.length;
          if (n === 0) {
            // First point: a degenerate segment, free at both ends — with
            // round caps this is the dot a brush tap paints (SVG zero-length
            // subpath semantics; butt caps paint nothing, also per SVG).
            const P = [[x, y], [x, y], [x, y], [x, y]];
            writeSeg(h, 0, P, P[0], P[3], 1, 1);
            h.segCount = 1;
            h.lastP2 = P[2];
            p.push(x, y);
            continue;
          }
          const lx = p[n - 2], ly = p[n - 1];
          if (x === lx && y === ly) continue;            // zero-length: skip
          if (n === 2) {
            // Second point: the dot slot becomes the first real segment.
            const P = elevLine([lx, ly], [x, y]);
            writeSeg(h, 0, P, P[0], P[3], 1, 1);
            h.lastP2 = P[2];
          } else {
            const P = elevLine([lx, ly], [x, y]);
            const si = h.segCount;
            writeSeg(h, si, P, h.lastP2, P[3], 0, 1);
            patchPrevSeg(h, si - 1, P[1]);
            h.segCount = si + 1;
            h.lastP2 = P[2];
          }
          p.push(x, y);
        }
      },
      /** Push pending geometry to the GPU now (draw does this automatically). */
      flush() { if (!h.disposed) flush(h); },
      /**
       * Freeze the stroke. Cheap — no re-tessellation; the handle keeps
       * drawing as-is. Returns `{ pathD, svg }` so the caller can persist the
       * stroke or re-host it as a regular bundle (importSvg/loadSvg) when it
       * wants Slug/native/hit-test parity for finished strokes.
       */
      finalize() {
        h.finalized = true;
        return { pathD: h.pathD, svg: h.bundle.svgSource };
      },
      dispose() {
        if (h.disposed) return;
        h.disposed = true;
        if (h.tex) { gl.deleteTexture(h.tex); h.tex = null; }
        if (h.vao) { gl.deleteVertexArray(h.vao); h.vao = null; }
        if (h.buf) { gl.deleteBuffer(h.buf); h.buf = null; }
        h.prim = h.verts = null;
        h.pts.length = 0;
        h.segCount = 0;
      },
    };
    // The mountable bundle-like. `_incStroke` routes every draw entry point
    // here (see _analyticRoute); it carries NO Slug geometry, so anything
    // that falls through to render() no-ops instead of drawing stale data.
    h.bundle = {
      _incStroke: h,
      numShapes: 0,
      metaFloats: null,
      get globalBBox() { return h.bbox; },
      // For SVG export / native re-hosting: the stroke as a plain SVG string.
      get svgSource() {
        const bb = h.bbox;
        const cap = h.capStyle === CAP.butt ? 'butt' : h.capStyle === CAP.square ? 'square' : 'round';
        const join = h.joinStyle === JOIN.miter ? 'miter' : h.joinStyle === JOIN.bevel ? 'bevel' : 'round';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb[0]} ${bb[1]} ${bb[2]} ${bb[3]}">`
          + `<path d="${h.pathD}" fill="none" stroke="${rgbaCss(h.color)}" stroke-width="${h.halfW * 2}"`
          + ` stroke-linecap="${cap}" stroke-linejoin="${join}"/></svg>`;
      },
      dispose: () => h.dispose(),
    };
    if (opts.points && opts.points.length) h.appendPoints(opts.points);
    return h;
  }

  R.createIncrementalStroke = createIncrementalStroke;
  R._drawIncrementalStroke = _drawIncrementalStroke;
}
