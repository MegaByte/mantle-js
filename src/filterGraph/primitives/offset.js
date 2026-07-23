// primitives/offset.js — feOffset (single-pass blit with a uv shift).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen, blitRect, rectOf } from '../svgFilterShared.js';

function feOffset(node, inputs, outRT, ctx) {
  const { gl, pool } = ctx;
  const inFbo = (inputs[0].kind === 'rt')
    ? pool.get(inputs[0].idx).fbo
    : ctx.sourceRT.fbo;
  // Fold the per-draw world scale so the offset tracks worldMatrix
  // (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  const dx = Math.round((node.params?.dx || 0) * ws[0]);
  const dy = Math.round((node.params?.dy || 0) * ws[1]);
  beginFullscreen(gl, outRT);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  // An offset is a TRANSLATION of the input's canvas rect: SVG dy is
  // screen-down, GL y is up, so the shift is (dx, -dy). blitRect then copies
  // whatever of the shifted input still lands on the output; the rest of the
  // output keeps the transparent clear above. Stated in output pixels this
  // needed four min/max terms and was silently wrong the moment the input and
  // output stopped covering the same rect.
  const inR = rectOf(inputs[0], ctx);
  blitRect(gl, inFbo, [inR[0] + dx, inR[1] - dy, inR[2], inR[3]], outRT, ctx);
}

registerSvgFilter('feOffset', feOffset);
export { feOffset };
