// colrPaintShared.js — helpers shared by the COLRv1 paint handlers
// (colr/paints.js), kept separate so that tree-shakeable module drops out
// entirely for consumers whose assets use no color fonts.
//
// COLRv1 paint trees consume no SVG sentinels (no SourceGraphic etc.) —
// PaintSolid / gradients are 0-input leaves and PaintGlyph clips a child
// by a glyph silhouette. Handlers size every RT to the glyph bbox
// computed by computeNodeBboxes (ctx.bbox), not the canvas. See colr.js
// header for the full ctx contract.

/// Bind the output RT, set its viewport, and disable depth/stencil/blend.
export function beginRT(gl, outRT) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);
}

/// Clear outRT to transparent black — the "missing shader / bad input"
/// fallback every paint handler shares.
export function clearOut(gl, outRT) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
}

/// COLR gradients are baked into the bundle's shared gradient-stops LUT
/// at TextRun assembly time; each gradient node carries (stopsOffset,
/// stopsCount) into that LUT. Falls back to lazy per-node texture
/// creation for synthetic test graphs that carry inline `stops`.
export function resolveStops(gl, ctx, node) {
  // Bundle-resolved path (production: TextRun pre-packed all stops):
  const p = node.params || {};
  if (typeof p.stopsOffset === 'number' && typeof p.stopsCount === 'number'
      && ctx.gradientStopsTex) {
    return { tex: ctx.gradientStopsTex, offset: p.stopsOffset, count: p.stopsCount };
  }
  // Lazy path (test graphs with inline stops). One mini-texture per
  // node, released when the dispatch finishes via ctx._lazyStopsTextures.
  const stops = (p.stops) || [];
  if (!stops.length) return null;
  if (!ctx._lazyStopsCache) ctx._lazyStopsCache = new Map();
  const key = node;  // node identity is unique per-eval
  if (ctx._lazyStopsCache.has(key)) return ctx._lazyStopsCache.get(key);
  // Matches packGradientStops / sampleStopsRaw: all-opaque stops take the
  // 1-texel/stop fast path (R,G,B,offset); otherwise 2 texels/stop (straight
  // RGBA + offset). count is signed (negative = 1-texel); offset is in texels.
  const N = stops.length;
  const q = (x) => Math.min(255, Math.max(0, Math.round(x * 255)));
  const opaque = stops.every((s) => Math.round((s.color[3] ?? 1) * 255) === 255);
  const texelsPerStop = opaque ? 1 : 2;
  const buf = new Uint8Array(N * texelsPerStop * 4);
  for (let i = 0; i < N; i++) {
    const s = stops[i];
    const c = i * texelsPerStop * 4;
    buf[c + 0] = q(s.color[0]);
    buf[c + 1] = q(s.color[1]);
    buf[c + 2] = q(s.color[2]);
    buf[c + 3] = opaque ? q(s.offset) : q(s.color[3]);
    if (!opaque) buf[c + 4] = q(s.offset);
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N * texelsPerStop, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (!ctx._lazyStopsTextures) ctx._lazyStopsTextures = [];
  ctx._lazyStopsTextures.push(tex);
  const out = { tex, offset: 0, count: opaque ? -N : N };
  ctx._lazyStopsCache.set(key, out);
  return out;
}

/// Bind the node's bbox origin/size uniforms on `prog`.
export function bindBbox(ctx, nodeIdx, prog, uOrigin, uSize) {
  const { gl } = ctx;
  const b = ctx.bbox[nodeIdx] || { x: 0, y: 0, w: 1, h: 1 };
  gl.useProgram(prog);
  gl.uniform2f(uOrigin, b.x, b.y);
  gl.uniform2f(uSize,   Math.max(1, b.w), Math.max(1, b.h));
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
