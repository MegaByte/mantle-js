// primitives/morphology.js — feMorphology (dilate / erode).
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex, beginFullscreen, passthrough,
  setInMap, setMapRect, texelOf, rectOfRT,
} from '../svgFilterShared.js';

function feMorphology(node, inputs, outRT, ctx) {
  const { gl, pool, morphProg, morphU, coverVao } = ctx;
  if (!morphProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const { operator = 0 } = node.params || {};
  // Fold the per-draw world scale so the morphology radius tracks
  // worldMatrix (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  const radiusX = (node.params?.radiusX || 0) * ws[0];
  const radiusY = (node.params?.radiusY || 0) * ws[1];
  if (radiusX < 0.5 && radiusY < 0.5) {
    passthrough(gl, inputs[0], outRT, ctx);
    return;
  }
  const [rW, rH] = outRT.size;
  const outR = rectOfRT(outRT);
  const tmpIdx = pool.acquire(rW, rH, outR);   // intermediate shares the output's rect
  const tmp = pool.get(tmpIdx);
  gl.useProgram(morphProg);
  gl.uniform1i(morphU.uTex, 0);
  gl.uniform1i(morphU.uOperator, operator | 0);
  gl.bindVertexArray(coverVao);
  // Horizontal: src → tmp. Steps one canvas pixel in the SOURCE's uv.
  const [sxT, syT] = texelOf(inputs[0], ctx);
  beginFullscreen(gl, tmp);
  setInMap(gl, morphU.uInMap, inputs[0], tmp, ctx);
  gl.uniform2f(morphU.uTexel, sxT, syT);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform2f(morphU.uDir, 1, 0);
  gl.uniform1f(morphU.uRadius, radiusX);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // Vertical: tmp → out. Same rect, so the map is the identity.
  beginFullscreen(gl, outRT);
  setMapRect(gl, morphU.uInMap, outRT, outR);
  gl.uniform2f(morphU.uTexel, 1 / outR[2], 1 / outR[3]);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
  gl.uniform2f(morphU.uDir, 0, 1);
  gl.uniform1f(morphU.uRadius, radiusY);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  pool.release(tmpIdx);
}

registerSvgFilter('feMorphology', feMorphology);
export { feMorphology };
