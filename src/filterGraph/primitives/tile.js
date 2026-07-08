// primitives/tile.js — feTile (repeat the input region across the filter
// region).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthrough } from '../svgFilterShared.js';

function feTile(node, inputs, outRT, ctx) {
  const { gl, pool, feTileProg, feTileU, coverVao } = ctx;
  if (!feTileProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  gl.useProgram(feTileProg);
  gl.uniform1i(feTileU.uTex, 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feTile', feTile);
export { feTile };
