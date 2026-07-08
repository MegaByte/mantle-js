// primitives/offset.js — feOffset (single-pass blit with a uv shift).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen } from '../svgFilterShared.js';

function feOffset(node, inputs, outRT, ctx) {
  // Single-pass copy with a uv offset via blit. For bbox-sized RTs the
  // bbox-propagation step grows the bbox by the offset amount so the
  // shifted region lands within the RT.
  const { gl, pool } = ctx;
  const inFbo = (inputs[0].kind === 'rt')
    ? pool.get(inputs[0].idx).fbo
    : ctx.sourceRT.fbo;
  const [w, h] = outRT.size;
  // Fold the per-draw world scale so the offset tracks worldMatrix
  // (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  const dx = (node.params?.dx || 0) * ws[0];
  const dy = (node.params?.dy || 0) * ws[1];
  beginFullscreen(gl, outRT);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  const idx = Math.round(dx), idy = Math.round(dy);
  const sx0 = Math.max(0, -idx), sy0 = Math.max(0, -idy);
  const sx1 = Math.min(w,  w - idx), sy1 = Math.min(h, h - idy);
  const dx0 = sx0 + idx, dy0 = sy0 + idy;
  const dx1 = sx1 + idx, dy1 = sy1 + idy;
  if (sx1 <= sx0 || sy1 <= sy0) return;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inFbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
  gl.blitFramebuffer(sx0, h - sy1, sx1, h - sy0,
                     dx0, h - dy1, dx1, h - dy0,
                     gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

registerSvgFilter('feOffset', feOffset);
export { feOffset };
