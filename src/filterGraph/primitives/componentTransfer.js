// primitives/componentTransfer.js — feComponentTransfer (per-channel
// transfer function via a baked 256×4 LUT texture).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthrough, setInMap } from '../svgFilterShared.js';

function feComponentTransfer(node, inputs, outRT, ctx) {
  const { gl, pool, feComponentTransferProg, feComponentTransferU, coverVao } = ctx;
  if (!feComponentTransferProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  // The LUT was baked into a 256×4 RGBA8 texture by the renderer-side
  // ctx setup (one per dispatch context, since LUTs are per-filter).
  // The node carries an index into ctx.componentTransferLUTs.
  const lutTex = ctx.componentTransferLUTs &&
                 ctx.componentTransferLUTs[node.params && node.params.lutIndex];
  if (!lutTex) return passthrough(gl, inputs[0], outRT, ctx);
  gl.useProgram(feComponentTransferProg);
  gl.uniform1i(feComponentTransferU.uIn, 0);
  gl.uniform1i(feComponentTransferU.uLUT, 1);
  setInMap(gl, feComponentTransferU.uInMap, inputs[0], outRT, ctx);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feComponentTransfer', feComponentTransfer);
export { feComponentTransfer };
