// primitives/composite.js — feComposite (Porter-Duff + arithmetic).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthrough, setInMap } from '../svgFilterShared.js';

function feComposite(node, inputs, outRT, ctx) {
  const { gl, pool, feCompositeProg, feCompositeU, coverVao } = ctx;
  if (!feCompositeProg) return passthrough(gl, inputs[0], outRT, ctx);
  const aTex = resolveInputTex(inputs[0], pool, ctx);
  const bTex = resolveInputTex(inputs[1], pool, ctx);
  if (!aTex || !bTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const op = (node.params && node.params.op) | 0;
  const k = (node.params && node.params.k) || [0, 0, 0, 0];
  gl.useProgram(feCompositeProg);
  gl.uniform1i(feCompositeU.uIn1, 0);
  gl.uniform1i(feCompositeU.uIn2, 1);
  setInMap(gl, feCompositeU.uIn1Map, inputs[0], outRT, ctx);
  setInMap(gl, feCompositeU.uIn2Map, inputs[1], outRT, ctx);
  gl.uniform1i(feCompositeU.uOp, op);
  gl.uniform4f(feCompositeU.uK, k[0] || 0, k[1] || 0, k[2] || 0, k[3] || 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, aTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feComposite', feComposite);
export { feComposite };
