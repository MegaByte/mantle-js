// primitives/displacementMap.js — feDisplacementMap.
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthrough } from '../svgFilterShared.js';

function feDisplacementMap(node, inputs, outRT, ctx) {
  const { gl, pool, feDisplacementMapProg, feDisplacementMapU, coverVao } = ctx;
  const [w, h] = outRT.size;
  if (!feDisplacementMapProg) return passthrough(gl, inputs[0], outRT, ctx);
  const aTex = resolveInputTex(inputs[0], pool, ctx);
  const bTex = resolveInputTex(inputs[1], pool, ctx);
  if (!aTex || !bTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  // Fold the per-draw world scale into the texel step so the pixel
  // displacement (disp = (dx,dy)·uTexel in the shader) tracks worldMatrix
  // (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  gl.useProgram(feDisplacementMapProg);
  gl.uniform1i(feDisplacementMapU.uIn1, 0);
  gl.uniform1i(feDisplacementMapU.uIn2, 1);
  gl.uniform1f(feDisplacementMapU.uScale, p.scale || 0);
  gl.uniform2f(feDisplacementMapU.uTexel, ws[0] / w, ws[1] / h);
  gl.uniform1i(feDisplacementMapU.uXChan, (p.xChan | 0));
  gl.uniform1i(feDisplacementMapU.uYChan, (p.yChan | 0));
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, aTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feDisplacementMap', feDisplacementMap);
export { feDisplacementMap };
