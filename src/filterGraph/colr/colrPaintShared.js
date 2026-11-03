// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { trackGlResource } from '../../renderer/contextResources.js';
// colrPaintShared.js — helpers shared by the COLRv1 paint handlers
// (colr/paints.js), kept separate so that tree-shakeable module drops out
// entirely for consumers whose assets use no color fonts.
//
// COLRv1 paint trees consume no SVG sentinels (no SourceGraphic etc.) —
// PaintSolid / gradients are 0-input leaves and PaintGlyph clips a child
// by a glyph silhouette.
//

import { noteExternalGlWrite } from '../../core/glEpoch.js';
import { rectOfRT } from '../svgFilterShared.js';
import { AFF_ID, affInv, affMul } from '../affine2d.js';
import { packStopList } from '../../core/gradientStops.js';
import { gradientStopsLutSize, padGradientStopsLut } from '../../bundle/layout.js';

/// Bind the output RT, set its viewport, and disable depth/stencil/blend.
export function beginRT(gl, outRT) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);

  noteExternalGlWrite();
}

/// Clear outRT to transparent black — the "missing shader / bad input"
/// fallback every paint handler shares.
export function clearOut(gl, outRT) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/// COLR gradients are baked into the bundle's shared gradient-stops LUT
/// at TextRun assembly time; each gradient node carries (stopsOffset,
/// stopsCount) into that LUT. Falls back to lazy per-node texture
/// creation for synthetic test graphs that carry inline `stops`.
export function resolveStops(gl, ctx, node) {
  // Bundle-resolved path (production: TextRun pre-packed all stops):
  const p = node.params || {};
  if (
    typeof p.stopsOffset === 'number' &&
    typeof p.stopsCount === 'number' &&
    ctx.gradientStopsTex
  ) {
    return { tex: ctx.gradientStopsTex, offset: p.stopsOffset, count: p.stopsCount };
  }
  // Lazy path (test graphs with inline stops). One mini-texture per
  // node, released when the dispatch finishes via ctx._lazyStopsTextures.
  const stops = p.stops || [];
  if (!stops.length) return null;
  if (!ctx._lazyStopsCache) ctx._lazyStopsCache = new Map();
  const key = node; // node identity is unique per-eval
  if (ctx._lazyStopsCache.has(key)) return ctx._lazyStopsCache.get(key);
  // The bundle's own packer and LUT shape (core/gradientStops.js, bundle/layout.js), so
  // sampleStopsRaw reads this texture exactly as it reads a bundle's: count is signed
  // (negative = 1-texel), offset is in texels, rows of GRAD_STOPS_LUT_W texels.
  const { bytes, count } = packStopList(stops);
  const [lutW, lutH] = gradientStopsLutSize(bytes.length >>> 2);
  const tex = trackGlResource(gl, gl.createTexture(), 'filterScratch');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    lutW,
    lutH,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    padGradientStopsLut(bytes),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (!ctx._lazyStopsTextures) ctx._lazyStopsTextures = [];
  ctx._lazyStopsTextures.push(tex);
  const out = { tex, offset: 0, count };
  ctx._lazyStopsCache.set(key, out);
  return out;
}

/// vUV (0..1 across `rt`'s rect, y up) -> canvas px (y down), as an affine. The rect is GL px (origin
/// bottom-left); ctx.h is the canvas height (a canvas-sized target's own height when absent).
export function pxOfUV(ctx, rt) {
  const r = rectOfRT(rt);
  const H = ctx.h > 0 ? ctx.h : r[1] + r[3];
  return [r[2], 0, 0, -r[3], r[0], H - r[1]];
}

/// A paint-space affine as the same map in canvas px: T·M·T⁻¹ (T = ctx.paintToPx). Null when T is singular.
export function pxAffine(ctx, m) {
  const T = ctx.paintToPx || AFF_ID,
    Ti = affInv(T);
  return Ti ? affMul(affMul(T, m), Ti) : null;
}

/// Bind a gradient's vUV -> paint-space map on `prog`: the shader's q = (dot(uPaintMapX, (vUV, 1)),
/// dot(uPaintMapY, (vUV, 1))), the pixel in the gradient's own coordinates, where its points, radii and
/// angles mean what the font says. False when the placement is singular (the caller draws nothing).
export function bindPaintMap(ctx, outRT, prog, uX, uY, frame = null) {
  const { gl } = ctx;
  const Ti = affInv(ctx.paintToPx || AFF_ID);
  if (!Ti) return false;
  const m = affMul(Ti, pxOfUV(ctx, outRT));
  if (frame) {
    m[0] /= frame[2];
    m[1] /= frame[2];
    m[2] /= frame[2];
    m[3] /= frame[2];
    m[4] = (m[4] - frame[0]) / frame[2];
    m[5] = (m[5] - frame[1]) / frame[2];
  }
  gl.useProgram(prog);
  gl.uniform3f(uX, m[0], m[2], m[4]);
  gl.uniform3f(uY, m[1], m[3], m[5]);
  return true;
}

/// Resolve + bind the gradient stops LUT for a gradient paint node.
/// Returns the resolved descriptor, or null when the node has no stops
/// (caller should clearOut).
export function bindGradientStops(gl, slot, prog, u, ctx, node) {
  const res = resolveStops(gl, ctx, node);
  if (!res) return null;
  gl.uniform1i(u.uGradientStops, slot);
  gl.uniform1i(u.uStopsOffset, res.offset);
  gl.uniform1i(u.uStopCount, res.count);
  // The font's compat: 'chrome' (font/fontAsset.js) marks its gradient nodes. A uniform, not a program: both modes are the warmed program.
  gl.uniform1i(u.uStopsChrome, node.params && node.params.stopsChrome ? 1 : 0);
  gl.activeTexture(gl.TEXTURE0 + slot);
  gl.bindTexture(gl.TEXTURE_2D, res.tex);
  return res;
}

/// The walker calls handler(node, inputs, outRT, ctx). COLR handlers also
/// need nodeIdx; read it back from ctx._curIdx, which the evaluator sets
/// before each call.
export function withIdx(fn) {
  return (node, inputs, outRT, ctx) => fn(ctx._curIdx, node, inputs, outRT, ctx);
}
