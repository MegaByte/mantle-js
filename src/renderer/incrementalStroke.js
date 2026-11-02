// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, trackGlResource } from './contextResources.js';
import { maxTextureSize } from './tableLayout.js';
// incrementalStroke.js — a DYNAMIC polyline stroke that grows in place: the
// paint-tool fast path. A freehand brush stroke appends one point per pointer
// move; re-importing the whole path each time (SVG parse → style → Slug
// tessellation) makes append cost scale with total stroke length. This module
// keeps the stroke GPU-resident and makes each append O(1):
//
//   const s = renderer.createIncrementalStroke({ color, width, bbox });
//   s.appendPoints([[x, y], …]);   // per pointer-move; tessellates only the new segments
//   drawBundle(s.bundle, opts);    // or mount s.bundle via createBundleHandle
//   s.finalize();                  // freeze; returns { pathD, svg } for re-hosting
//   s.dispose();
//
// RENDER PATH — the exact machinery the static analytic stroke route already
// uses (buildSplitStroke + splitStroke.vert/frag at t=0, MAX-blend union into
// a pooled coverage RT, then the shared lbComp composite quad). Caps, joins,
// dashes-off AA falloff are therefore IDENTICAL to a whole-loaded stroke on
// the analytic route, and within AA tolerance of the Slug stroke (see
// lbStrokeParitySmoke for that equivalence). One band quad per segment; the
// frag distance-fields the segment with cap/join logic from the neighbor
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

import { segArcLen, segTangentAt } from '../svg/textures.js';

const PRIM_W = 512; // prim texture width (texels) — mirrors PRIM_TEX_W
// THE MAIN RENDERER'S SEGMENT FORMAT (svg/textures.js encodeSeg), not a private one:
//   [type, freeStart, freeEnd, startDist][native control points…][inTan.xy, outTan.xy]
// Stride varies by type, which is why each segment records its own base texel.
const SEG_TEXELS = [3, 4, 4, 5]; // LINE, QUAD, CUBIC, ARC (+ its endpoints texel)
const VERT_FLOATS_PER_SEG = 12; // 6 verts × [primBase, corner]
const SEG_LINE = 0,
  SEG_QUAD = 1,
  SEG_CUBIC = 2,
  SEG_ARC = 3;
const CORNERS = [0, 1, 2, 0, 2, 3];

const _segDir = (ty, pts, atStart) =>
  segTangentAt(
    ty === SEG_ARC
      ? {
          type: SEG_ARC,
          cx: pts[0][0],
          cy: pts[0][1],
          rx: pts[1][0],
          ry: pts[1][1],
          theta_start: pts[2][0],
          theta_end: pts[2][1],
          phi: pts[3][0],
        }
      : ty === SEG_QUAD
        ? { type: SEG_QUAD, p1: pts[0], p2: pts[1], p3: pts[2] }
        : ty === SEG_CUBIC
          ? { type: SEG_CUBIC, p1: pts[0], p2: pts[1], p3: pts[2], p4: pts[3] }
          : { type: SEG_LINE, p1: pts[0], p2: pts[1] },
    atStart,
  );
/// Exact per type: a line closes in form, a curve uses the encoder's GL-16 helper — the same one
/// the band walk and the hit test use, so a startDist written here means what it means everywhere.
const _segLen = (ty, pts) => {
  if (ty === SEG_LINE) return Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  if (ty === SEG_ARC) {
    // GL-16 over |dp/dtheta|, as the shader and encoder do
    const [rx, ry] = pts[1],
      th0 = pts[2][0],
      dth = pts[2][1] - th0;
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      const th = th0 + dth * ((i + 0.5) / 16);
      sum += Math.sqrt(rx * rx * Math.sin(th) ** 2 + ry * ry * Math.cos(th) ** 2) / 16;
    }
    return Math.abs(dth) * sum;
  }
  const s =
    ty === SEG_QUAD
      ? { type: 1, p1: pts[0], p2: pts[1], p3: pts[2] }
      : { type: 2, p1: pts[0], p2: pts[1], p3: pts[2], p4: pts[3] };
  const L = segArcLen(s);
  return Number.isFinite(L) ? L : 0;
};
const finite2 = (p) => !!p && Number.isFinite(+p[0]) && Number.isFinite(+p[1]);
const segFinite = (sg) =>
  sg.type === 'arc'
    ? finite2(sg.center) && finite2(sg.radii) && finite2(sg.theta) && Number.isFinite(+sg.phi || 0)
    : finite2(sg.to) &&
      ((sg.type !== 'quad' && sg.type !== 'cubic') || finite2(sg.c1)) &&
      (sg.type !== 'cubic' || finite2(sg.c2));
const CAP = { butt: 0, round: 1, square: 2 };
const JOIN = { miter: 0, round: 1, bevel: 2 };

function rgbaCss(c) {
  const r = Math.round((c[0] || 0) * 255),
    g = Math.round((c[1] || 0) * 255),
    b = Math.round((c[2] || 0) * 255);
  return `rgba(${r},${g},${b},${c[3] == null ? 1 : c[3]})`;
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachIncrementalStroke(R) {
  const gl = R.gl;

  // ── CPU-side growable stores (whole prim rows so texture uploads are
  //    row-aligned; both double on overflow) ─────────────────────────────
  // getParameter can stall the pipeline, so the device limit is read once per renderer, on the first append.
  let _primTexelLimit = 0;
  const primTexelLimit = () => _primTexelLimit || (_primTexelLimit = PRIM_W * maxTextureSize(gl));
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
  function markPrimDirty(h, texel) {
    if (h.dirtyTexelLo < 0 || texel < h.dirtyTexelLo) h.dirtyTexelLo = texel;
  }
  function markVertDirty(h, floatIdx) {
    if (h.dirtyVertLo < 0 || floatIdx < h.dirtyVertLo) h.dirtyVertLo = floatIdx;
  }

  /// Write segment `si` in the main renderer's format. `pts` holds the segment's NATIVE control
  /// points — two for a line, three for a quad, four for a cubic — so nothing is degree-elevated
  /// on the way in and the fragment shader can solve the segment it was actually given.
  ///
  /// Tangents follow encodeSeg's convention: inTan is the PREVIOUS segment's end direction, outTan
  /// the NEXT segment's start direction, and a zero vector means that end is free (a cap, not a
  /// join). startDist is the arc length before this segment, kept as a running total so it stays
  /// O(1) per append — the same quantity the band walk reads, rather than a per-vertex prefix sum.
  function writeSeg(h, si, type, pts, inTan, outTan, freeStart, freeEnd, startDist) {
    const stride = SEG_TEXELS[type];
    const t = si === h.segBase.length ? h.texelCount : h.segBase[si];
    // The prim texture is PRIM_W wide and one row per PRIM_W texels, so a stroke of more texels than PRIM_W * MAX_TEXTURE_SIZE
    // cannot be uploaded (texImage2D raises GL 1281 and the stroke draws nothing). Throw BEFORE any state changes.
    if (t + stride > primTexelLimit()) {
      throw new Error(
        `incremental stroke: the prim texture needs ${t + stride} texels (${Math.ceil((t + stride) / PRIM_W)} rows of ${PRIM_W}) ` +
          `but this device (MAX_TEXTURE_SIZE ${maxTextureSize(gl)}) can store at most ${primTexelLimit()}; split the stroke into several strokes`,
      );
    }
    if (si === h.segBase.length) h.segBase.push(t);
    // Rewriting the last slot may widen it. The first real segment overwrites the dot, and a quad
    // or cubic needs a texel more than the line that was there — without this the next append
    // would start inside it.
    if (si === h.segBase.length - 1) h.texelCount = t + stride;
    ensurePrimCap(h, t + stride);
    const f = h.prim,
      w = t * 4;
    f[w] = type;
    f[w + 1] = freeStart ? 1 : 0;
    f[w + 2] = freeEnd ? 1 : 0;
    f[w + 3] = startDist || 0;
    let o = w + 4;
    if (type === SEG_ARC) {
      // (cx, cy, rx, ry) then (th0, th1, phi, 0) — the ellipse itself, per encodeSeg. An arc is
      // the one kind that cannot be re-expressed as a cubic without error, so it is not.
      const a = pts; // [center, radii, [th0, th1], [phi, 0]]
      f[o++] = a[0][0];
      f[o++] = a[0][1];
      f[o++] = a[1][0];
      f[o++] = a[1][1];
      f[o++] = a[2][0];
      f[o++] = a[2][1];
      f[o++] = a[3][0];
      f[o++] = 0;
      // ...then its endpoints, as encodeSeg writes them
      const cp = Math.cos(a[3][0]),
        sp = Math.sin(a[3][0]);
      const at = (t) => [
        a[0][0] + cp * a[1][0] * Math.cos(t) - sp * a[1][1] * Math.sin(t),
        a[0][1] + sp * a[1][0] * Math.cos(t) + cp * a[1][1] * Math.sin(t),
      ];
      const e0 = at(a[2][0]),
        e1 = at(a[2][1]);
      f[o++] = e0[0];
      f[o++] = e0[1];
      f[o++] = e1[0];
      f[o++] = e1[1];
    } else {
      for (let i = 0; i < pts.length; i++) {
        f[o++] = pts[i][0];
        f[o++] = pts[i][1];
      }
    }
    // A quad's second texel carries the join reaches after p3; a line's single texel is full. Pad
    // whatever the type leaves unused so a reused slot never shows a previous segment's numbers.
    const ptFloats = type === SEG_ARC ? 12 : pts.length * 2,
      slotFloats = (stride - 2) * 4;
    for (let i = ptFloats; i < slotFloats; i++) f[o++] = type === SEG_QUAD ? 1e9 : 0;
    const j = w + (stride - 1) * 4;
    f[j] = inTan[0];
    f[j + 1] = inTan[1];
    f[j + 2] = outTan[0];
    f[j + 3] = outTan[1];
    for (let k = 0; k < stride; k++) markPrimDirty(h, t + k);
    const vo = si * VERT_FLOATS_PER_SEG;
    ensureVertCap(h, vo + VERT_FLOATS_PER_SEG);
    const v = h.verts;
    for (let k = 0; k < 6; k++) {
      const q = vo + k * 2;
      v[q] = t;
      v[q + 1] = CORNERS[k];
    }
    markVertDirty(h, vo);
  }
  /// The previous segment's end cap becomes a join: clear its freeEnd in the header and point its
  /// outTan at the new segment. Two texels rather than one, still O(1).
  function patchPrevSeg(h, si, outTan) {
    const t = h.segBase[si],
      stride = SEG_TEXELS[h.prim[t * 4] | 0],
      f = h.prim;
    f[t * 4 + 2] = 0; // freeEnd = false
    const j = (t + stride - 1) * 4;
    f[j + 2] = outTan[0];
    f[j + 3] = outTan[1];
    markPrimDirty(h, t);
    markPrimDirty(h, t + stride - 1);
  }

  // ── GPU flush: upload only what changed since the last draw ──────────
  function flush(h) {
    // Vert buffer (per-handle VAO + VBO, capacity-managed).
    if (!h.vao) {
      h.vao = trackGlResource(gl, gl.createVertexArray());
      h.buf = trackGlResource(gl, gl.createBuffer(), 'strokes');
      R.glBindVertexArray(h.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, h.buf);
      for (let a = 0; a < 2; a++) {
        // (primBase, corner) — segFlags and
        gl.enableVertexAttribArray(a); // contourStart moved into the header texel
        gl.vertexAttribPointer(a, 1, gl.FLOAT, false, 8, a * 4);
      }
      R.glBindVertexArray(null);
      h.bufCap = 0;
    }
    const vertFloats = h.segCount * VERT_FLOATS_PER_SEG;
    if (vertFloats > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, h.buf);
      if (h.verts.length > h.bufCap) {
        gl.bufferData(gl.ARRAY_BUFFER, h.verts.byteLength, gl.DYNAMIC_DRAW); // capacity (bytes)
        h.bufCap = h.verts.length;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, h.verts.subarray(0, vertFloats));
      } else if (h.dirtyVertLo >= 0) {
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          h.dirtyVertLo * 4,
          h.verts.subarray(h.dirtyVertLo, vertFloats),
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    h.dirtyVertLo = -1;

    // Prim texture (RGBA32F, PRIM_W wide, row capacity grows geometrically).
    const texels = h.texelCount; // stride varies by segment type
    const rowsNeeded = Math.max(1, Math.ceil(texels / PRIM_W));
    if (!h.tex || rowsNeeded > h.texRows) {
      let rows = Math.max(1, h.texRows);
      while (rows < rowsNeeded) rows *= 2;
      rows = Math.min(rows, Math.max(rowsNeeded, maxTextureSize(gl))); // geometric growth never overshoots the device
      ensurePrimCap(h, rows * PRIM_W); // capacity is whole rows
      if (h.tex) deleteGlResource(gl, 'Texture', h.tex);
      h.tex = trackGlResource(gl, gl.createTexture(), 'strokes');
      gl.bindTexture(gl.TEXTURE_2D, h.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        PRIM_W,
        rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        h.prim.subarray(0, rows * PRIM_W * 4),
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
      h.texRows = rows;
    } else if (h.dirtyTexelLo >= 0) {
      const row0 = Math.floor(h.dirtyTexelLo / PRIM_W);
      const row1 = Math.ceil(texels / PRIM_W); // exclusive
      gl.bindTexture(gl.TEXTURE_2D, h.tex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        row0,
        PRIM_W,
        row1 - row0,
        gl.RGBA,
        gl.FLOAT,
        h.prim.subarray(row0 * PRIM_W * 4, row1 * PRIM_W * 4),
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    h.dirtyTexelLo = -1;
  }

  // Per-draw effective color: straight RGBA × per-draw colorMatrix(+offset)
  // (exact CPU application for a solid paint) × per-draw alpha.
  function drawColor(h) {
    let r = h.color[0],
      g = h.color[1],
      b = h.color[2],
      a = h.color[3];
    const m = R.draw.colorMatrix,
      off = R.draw.colorMatrixOffset;
    if (m || off) {
      // Same convention as the fill pass: uniformMatrix4fv(transpose=false)
      // → the JS array is COLUMN-major; out = M·in + offset.
      const M = m || R.IDENTITY_COLOR_MATRIX,
        O = off || R.ZERO_OFFSET;
      const nr = M[0] * r + M[4] * g + M[8] * b + M[12] * a + O[0];
      const ng = M[1] * r + M[5] * g + M[9] * b + M[13] * a + O[1];
      const nb = M[2] * r + M[6] * g + M[10] * b + M[14] * a + O[2];
      const na = M[3] * r + M[7] * g + M[11] * b + M[15] * a + O[3];
      r = Math.min(1, Math.max(0, nr));
      g = Math.min(1, Math.max(0, ng));
      b = Math.min(1, Math.max(0, nb));
      a = Math.min(1, Math.max(0, na));
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
    if (!R.splitStrokeProg || !R.lbCompProg) return true; // stroke/composite shaders unavailable
    if (!h.segCount) return true; // nothing appended yet
    const [cw, ch] = R.viewportSize();
    if (cw < 1 || ch < 1) return true;
    flush(h);

    const bbox = h.bbox;
    const [sx, sy] = R.arScale(bbox, cw, ch);
    const worldM = R.draw.worldM;
    const U = R.splitStrokeU;

    // Pass 1: analytic stroke coverage into a pooled RT (MAX blend = the
    // round-cap/round-join distance-field union), with the handle's own VAO +
    // incremental prim texture.

    const rtIdx = R._covPool.acquire(cw, ch);
    const rt = R._covPool.get(rtIdx);
    R.bindFb(gl.FRAMEBUFFER, rt.fbo);
    R.glViewport(0, 0, cw, ch);
    R.glDisable(gl.DEPTH_TEST);
    R.glDepthMask(false);
    R.glDisable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    R.glEnable(gl.BLEND);
    R.glBlendEquation(gl.MAX);
    R.glBlendFunc(gl.ONE, gl.ONE);
    R.glUseProgram(R.splitStrokeProg);
    gl.uniform1i(U.uPrimW, PRIM_W);
    gl.uniform1f(U.uHalfW, h.halfW);
    if (U.uMiterLimit) gl.uniform1f(U.uMiterLimit, h.miterLimit);
    if (U.uCapStyle) gl.uniform1i(U.uCapStyle, h.capStyle);
    if (U.uJoinStyle) gl.uniform1i(U.uJoinStyle, h.joinStyle);
    if (U.uDashId) gl.uniform1i(U.uDashId, 0);
    // The exact-area edge, on the renderer's toggle as the static stroke is. Unset it read 0 and this
    // pass drew the isotropic ramp (incrementalStrokeExactAaSmoke: up to 9.96/255 off the box).
    if (U.uStrokeExactAa) gl.uniform1i(U.uStrokeExactAa, R.strokeExactAa === false ? 0 : 1);
    gl.uniform4f(U.uGBB, bbox[0], bbox[1], bbox[2], bbox[3]);
    gl.uniform2f(U.uCanvasAR, sx, sy);
    gl.uniform2f(U.uViewport, cw, ch);
    if (worldM) {
      gl.uniformMatrix3fv(U.uWorldM, false, worldM);
      gl.uniform1i(U.uHasWorldM, 1);
    } else gl.uniform1i(U.uHasWorldM, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, h.tex);
    gl.uniform1i(U.uPrim, 0);
    if (U.uDashTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, R.dummyDashTex);
      gl.uniform1i(U.uDashTex, 1);
    }
    R.glBindVertexArray(h.vao);
    gl.drawArrays(gl.TRIANGLES, 0, h.segCount * 6);
    R.glBindVertexArray(null);

    // Pass 2: composite paint × coverage OVER the canvas (or the active cache
    // bake target) — the shared lbComp fullscreen quad, premultiplied.
    R.bindFb(gl.FRAMEBUFFER, R._cacheTargetFbo || null);
    R.glViewport(0, 0, cw, ch);
    R.glBlendEquation(gl.FUNC_ADD);
    R.glBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    R.glUseProgram(R.lbCompProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    gl.uniform1i(R.lbcUCoverage, 0);
    const c = drawColor(h);
    gl.uniform4f(R.lbcUColor, c[0], c[1], c[2], c[3]);
    // The pooled RT is quantized (≥ viewport): map the quad's UV into the
    // bottom-left viewport-sized region the coverage pass actually rendered.
    if (R.lbcUCovScale) gl.uniform2f(R.lbcUCovScale, cw / rt.size[0], ch / rt.size[1]);
    R.glBindVertexArray(R.coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    R.glBindVertexArray(null);
    // Unbind the pooled RT from unit 0: the next coverage pass may re-acquire
    // it as its render target (framebuffer↔texture feedback loop otherwise).
    gl.bindTexture(gl.TEXTURE_2D, null);
    R._covPool.release(rtIdx);
    if (R._handle) R._handle.fillPassAssetDirty = true;
    R._forgetFillUnits(); // next Slug pass rebinds
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
      color: opts.color && opts.color.length === 4 ? opts.color.slice() : [0, 0, 0, 1],
      halfW: opts.width / 2,
      bbox: [opts.bbox[0], opts.bbox[1], opts.bbox[2], opts.bbox[3]],
      capStyle: CAP[opts.capStyle] ?? CAP.round,
      joinStyle: JOIN[opts.joinStyle] ?? JOIN.round,
      miterLimit: opts.miterLimit > 0 ? opts.miterLimit : 4,
      pts: [], // flat [x0,y0, x1,y1, …]
      segCount: 0,
      prim: new Float32Array(PRIM_W * 4), // one row
      verts: new Float32Array(64 * VERT_FLOATS_PER_SEG),
      dirtyTexelLo: -1,
      dirtyVertLo: -1,
      lastDir: [0, 0], // previous segment's end direction — this one's inTan
      runLen: 0, // arc length before the next segment, for its startDist
      segBase: [], // texel index per segment; stride varies by type
      segsMeta: [], // {ty, pts} per segment, for pathD — segment types vary
      texelCount: 0,
      tex: null,
      texRows: 0,
      vao: null,
      buf: null,
      bufCap: 0,
      finalized: false,
      disposed: false,
      drawCount: 0,
      bundle: null,
      get pointCount() {
        return h.pts.length / 2;
      },
      get segmentCount() {
        return h.segCount;
      },
      /** SVG path data for the polyline (persistence / re-hosting). */
      get pathD() {
        const p = h.pts;
        if (!p.length) return '';
        // Serialize the SEGMENTS, since they are not all lines. A stroke re-hosted through
        // importSvg then rebuilds the same curves rather than a resampled polyline of them.
        let d = `M${p[0]} ${p[1]}`;
        // A first point alone draws a dot here. A path of a bare moveto draws nothing, so the dot goes out as the zero-length subpath SVG gives caps to.
        if (!h.segsMeta.length) return `${d}L${p[0]} ${p[1]}`;
        for (const { ty, pts } of h.segsMeta) {
          const e = pts[pts.length - 1]; // for an arc this slot is (phi, 0); handled below
          if (ty === SEG_ARC) {
            const [cx, cy] = pts[0],
              [rx, ry] = pts[1],
              [t0, t1] = pts[2],
              ph = pts[3][0];
            const cp = Math.cos(ph),
              sp = Math.sin(ph);
            const dth = t1 - t0,
              k = Math.abs(dth) > Math.PI ? Math.ceil(Math.abs(dth) / Math.PI) : 1;
            for (let i = 1; i <= k; i++) {
              const t = i === k ? t1 : t0 + dth * (i / k),
                ct = Math.cos(t),
                st = Math.sin(t);
              const ex = cx + cp * rx * ct - sp * ry * st,
                ey = cy + sp * rx * ct + cp * ry * st;
              d += `A${rx} ${ry} ${(ph * 180) / Math.PI} 0 ${dth > 0 ? 1 : 0} ${ex} ${ey}`; // a piece is never the large arc
            }
          } else if (ty === SEG_QUAD) d += `Q${pts[1][0]} ${pts[1][1]} ${e[0]} ${e[1]}`;
          else if (ty === SEG_CUBIC)
            d += `C${pts[1][0]} ${pts[1][1]} ${pts[2][0]} ${pts[2][1]} ${e[0]} ${e[1]}`;
          else d += `L${e[0]} ${e[1]}`;
        }
        return d;
      },
      /**
       * Append points (user units, the bbox space). O(1) per point: writes
       * the new segment's texels/verts and patches the previous segment's
       * join. Exact duplicates of the last point are skipped. The GPU upload
       * happens on the next draw (touched prim rows + the vert tail only).
       */
      /**
       * Append polyline points — the pointer-move fast path, and a thin wrapper over
       * appendSegments so the two cannot drift. Consecutive duplicates are dropped: a zero-length
       * step would be a degenerate segment, and only the FIRST point is meant to paint a dot.
       */
      appendPoints(points) {
        const segs = [];
        let lx = h.pts.length ? h.pts[h.pts.length - 2] : NaN;
        let ly = h.pts.length ? h.pts[h.pts.length - 1] : NaN;
        for (const pt of points) {
          const x = +pt[0],
            y = +pt[1];
          // A point with a non-finite coordinate is DROPPED (it would poison every vertex after it).
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (x === lx && y === ly) continue;
          segs.push({ type: 'line', to: [x, y] });
          lx = x;
          ly = y;
        }
        if (segs.length) this.appendSegments(segs);
      },
      /**
       * Append segments in their NATIVE type — the point of the format change. A paint tool that
       * fits curves to a gesture can hand them over as curves instead of resampling them into a
       * polyline, and each fragment then runs the solve for what the segment IS: a quad's closest
       * point has a closed form, a line's is a projection, only a cubic needs the seeded Newton.
       *
       * Each entry continues from the current point, exactly as SVG's L / Q / C do:
       *   { type: 'line',  to:[x,y] }
       *   { type: 'quad',  c1:[x,y], to:[x,y] }
       *   { type: 'cubic', c1:[x,y], c2:[x,y], to:[x,y] }
       *   { type: 'arc', center:[x,y], radii:[rx,ry], theta:[start,end], phi? }
       *
       * An arc states its own start, so it continues from the current point as canvas's arc() does:
       * a straight line to its start first, unless it starts on the current point; with no current
       * point it starts the path.
       *
       * The arc is stored AS an arc — center, radii and angles — not as a cubic through the same
       * points. That distinction is the whole reason for this format: line and quad elevation is
       * exact, so converting them costs only the wrong kernel, but a circular arc has no cubic
       * form at all, and approximating one drifts 8.9e-3 of the radius on a 90-degree sweep — an
       * error fixed in em, so unbounded in pixels as the view zooms.
       *
       * Append stays O(1): one segment written, one neighbor's join texel patched.
       */
      appendSegments(segs) {
        if (h.finalized || h.disposed) throw new Error('incremental stroke is finalized/disposed');
        for (const sg of segs) {
          // A segment with a non-finite number is DROPPED, as appendPoints drops a point: the next one starts from where this one ends, so it would poison every segment after it.
          if (!segFinite(sg)) continue;
          const ty =
            sg.type === 'quad'
              ? SEG_QUAD
              : sg.type === 'cubic'
                ? SEG_CUBIC
                : sg.type === 'arc'
                  ? SEG_ARC
                  : SEG_LINE;
          // An arc states its own geometry, so its endpoint is derived rather than given.
          const arcAt = (th) => {
            const cp = Math.cos(+sg.phi || 0),
              sp = Math.sin(+sg.phi || 0);
            const ct = Math.cos(th),
              st = Math.sin(th);
            return [
              sg.center[0] + cp * sg.radii[0] * ct - sp * sg.radii[1] * st,
              sg.center[1] + sp * sg.radii[0] * ct + cp * sg.radii[1] * st,
            ];
          };
          const to = ty === SEG_ARC ? arcAt(+sg.theta[1]) : [+sg.to[0], +sg.to[1]];
          // AN ARC STATES ITS own START, and nothing makes it the current point: written JOINED wherever it began
          // (freeStart 0, the previous end direction as its inTan, the previous segment's end cap cleared), the join
          // planes would stand at an end with no neighbor behind them -- coverage stepping 1 -> 0.5 across the ray --
          // and pathD's `A` would run from the previous point, a different arc. Canvas's arc() and ellipse() say what
          // it means: a line from the current point to the arc's start, and with no current point the arc starts the path.
          // "At the current point" is a relative test: within 64 float32 ulps of the coordinates, the rounding a start
          // computed in either precision can carry (the renderer stores float32).
          if (ty === SEG_ARC) {
            const s0 = arcAt(+sg.theta[0]);
            const n = h.pts.length;
            const m = Math.max(
              n ? Math.abs(h.pts[n - 2]) : 0,
              n ? Math.abs(h.pts[n - 1]) : 0,
              Math.max(Math.abs(+sg.center[0]), Math.abs(+sg.center[1])) +
                Math.max(Math.abs(+sg.radii[0]), Math.abs(+sg.radii[1])),
            );
            if (
              !n ||
              !(Math.hypot(s0[0] - h.pts[n - 2], s0[1] - h.pts[n - 1]) <= 64 * 2 ** -24 * m)
            ) {
              this.appendSegments([{ type: 'line', to: s0 }]);
            }
          }
          if (!h.pts.length) {
            // no current point yet: start here
            writeSeg(h, 0, SEG_LINE, [to, to], [0, 0], [0, 0], 1, 1, 0);
            h.segCount = 1;
            h.lastDir = [0, 0];
            h.runLen = 0;
            h.pts.push(to[0], to[1]);
            h.segsMeta.length = 0;
            continue;
          }
          const n = h.pts.length,
            from = [h.pts[n - 2], h.pts[n - 1]];
          const pts =
            ty === SEG_ARC
              ? [
                  [+sg.center[0], +sg.center[1]],
                  [+sg.radii[0], +sg.radii[1]],
                  [+sg.theta[0], +sg.theta[1]],
                  [+sg.phi || 0, 0],
                ]
              : ty === SEG_LINE
                ? [from, to]
                : ty === SEG_QUAD
                  ? [from, [+sg.c1[0], +sg.c1[1]], to]
                  : [from, [+sg.c1[0], +sg.c1[1]], [+sg.c2[0], +sg.c2[1]], to];
          // The encoder's end directions (an arc's are its endpoint velocities, not chords of a hull).
          const sDir = _segDir(ty, pts, true);
          const eDir = _segDir(ty, pts, false);
          // The FIRST real segment replaces the dot slot; later ones extend and patch back.
          const si = h.segsMeta && h.segsMeta.length ? h.segCount : 0;
          const first = si === 0;
          writeSeg(
            h,
            si,
            ty,
            pts,
            first ? [0, 0] : h.lastDir,
            [0, 0],
            first ? 1 : 0,
            1,
            first ? 0 : h.runLen,
          );
          if (!first) patchPrevSeg(h, si - 1, sDir);
          h.segCount = si + 1;
          h.lastDir = eDir;
          h.runLen = (first ? 0 : h.runLen) + _segLen(ty, pts);
          h.segsMeta.push({ ty, pts });
          h.pts.push(to[0], to[1]);
        }
      },
      /** Push pending geometry to the GPU now (draw does this automatically). */
      flush() {
        if (!h.disposed) flush(h);
      },
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
        if (h.tex) {
          deleteGlResource(gl, 'Texture', h.tex);
          h.tex = null;
        }
        if (h.vao) {
          deleteGlResource(gl, 'VertexArray', h.vao);
          h.vao = null;
        }
        if (h.buf) {
          deleteGlResource(gl, 'Buffer', h.buf);
          h.buf = null;
        }
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
      get globalBBox() {
        return h.bbox;
      },
      // For SVG export / native re-hosting: the stroke as a plain SVG string.
      get svgSource() {
        const bb = h.bbox;
        const cap =
          h.capStyle === CAP.butt ? 'butt' : h.capStyle === CAP.square ? 'square' : 'round';
        const join =
          h.joinStyle === JOIN.miter ? 'miter' : h.joinStyle === JOIN.bevel ? 'bevel' : 'round';
        return (
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb[0]} ${bb[1]} ${bb[2]} ${bb[3]}">` +
          `<path d="${h.pathD}" fill="none" stroke="${rgbaCss(h.color)}" stroke-width="${h.halfW * 2}"` +
          ` stroke-linecap="${cap}" stroke-linejoin="${join}"` +
          // The limit decides whether a miter draws at all; left out, a re-hosted stroke bevels
          // every join sharper than SVG's default 4 that this one mitered.
          (h.joinStyle === JOIN.miter ? ` stroke-miterlimit="${h.miterLimit}"` : '') +
          '/></svg>'
        );
      },
      dispose: () => h.dispose(),
    };
    if (opts.points && opts.points.length) h.appendPoints(opts.points);
    return h;
  }

  R.createIncrementalStroke = createIncrementalStroke;
  R._drawIncrementalStroke = _drawIncrementalStroke;
}
