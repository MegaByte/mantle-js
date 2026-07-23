// primitives/convolve.js — feConvolveMatrix (NxM kernel; kernel uploaded
// lazily as a 7×1 RGBA32F texture and cached on the node).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthrough, setInMap, rectOf } from '../svgFilterShared.js';

function feConvolveMatrix(node, inputs, outRT, ctx) {
  const { gl, pool, convolveProg, convolveU, coverVao } = ctx;
  if (!convolveProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  // Upload the 25-float kernel as a 7×1 RGBA32F texture lazily and
  // cache on the node. The shader reads kernel[r*orderX + c] via
  // texelFetch — only orderX*orderY texels are meaningful, the rest
  // are zero from the importer's padding.
  // The cached texture belongs to a specific GL context: a bundle drawn
  // on a second canvas (or after context-loss recreate) must not reuse a
  // foreign/dead handle — free it on its owning context and rebuild.
  if (p._kTex && p._kTexGl !== gl) {
    try { p._kTexGl.deleteTexture(p._kTex); } catch { /* context gone */ }
    p._kTex = null;
  }
  if (!p._kTex) {
    // Pack 25 floats into a 7-RGBA-texel row (28 floats with 3 padding).
    const padded = new Float32Array(28);
    padded.set(p.kernel || new Float32Array(25));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 7, 1, 0, gl.RGBA, gl.FLOAT, padded);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    p._kTex = tex;
    p._kTexGl = gl;
  }
  const src = rectOf(inputs[0], ctx);
  // Fold the per-draw world scale into the kernel sample spacing
  // (kernelUnitLength-style) so the convolution tracks worldMatrix
  // (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  gl.useProgram(convolveProg);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(convolveU.uTex, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, p._kTex);
  gl.uniform1i(convolveU.uKernelTex, 1);
  setInMap(gl, convolveU.uInMap, inputs[0], outRT, ctx);
  // Kernel cells are spaced one CANVAS pixel apart, in the INPUT's uv.
  gl.uniform2f(convolveU.uTexel, ws[0] / Math.max(src[2], 1), ws[1] / Math.max(src[3], 1));
  gl.uniform2f(convolveU.uOrder, p.orderX || 3, p.orderY || 3);
  gl.uniform2f(convolveU.uTarget, p.targetX | 0, p.targetY | 0);
  gl.uniform1f(convolveU.uDivisor, p.divisor || 1);
  gl.uniform1f(convolveU.uBias, p.bias || 0);
  gl.uniform1i(convolveU.uKernelRow, 0);
  gl.uniform1i(convolveU.uEdgeMode, p.edgeMode | 0);
  gl.uniform1i(convolveU.uPreserveAlpha, p.preserveAlpha | 0);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feConvolveMatrix', feConvolveMatrix);
export { feConvolveMatrix };
