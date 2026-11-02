// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/convolve.js — feConvolveMatrix (NxM kernel, up to 5x5; the kernel reaches the pass as a
// uniform array, flipped to a fixed 5-wide stride -- convolveKernel.js).
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  passthroughCs,
  setInMap,
  rectOf,
  convertedInput,
} from '../svgFilterShared.js';
import { inMode } from '../colorSpace.js';
import { flipConvolveKernel } from '../convolveKernel.js';

const _kernel = new Float32Array(25);

function feConvolveMatrix(node, inputs, outRT, ctx) {
  const { gl, pool, convolveProg, convolveU, coverVao } = ctx;
  if (!convolveProg) return passthroughCs(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  // Cells step one pixel (point samples), but the kernel mixes neighbors in the space it operates in: read a converted copy.
  const conv = convertedInput(inputs[0], inMode(ctx, 0), ctx);
  inputs = [conv.input];
  const srcTex2 = resolveInputTex(inputs[0], pool, ctx);

  flipConvolveKernel(p.kernel, 0, p.orderX || 3, p.orderY || 3, _kernel);
  const src = rectOf(inputs[0], ctx);
  gl.useProgram(convolveProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex2 || srcTex);
  gl.uniform1i(convolveU.uTex, 0);
  gl.uniform1fv(convolveU.uKernel, _kernel);
  setInMap(gl, convolveU.uInMap, inputs[0], outRT, ctx);
  // Kernel cells are spaced one CANVAS pixel apart, in the INPUT's uv.
  gl.uniform2f(convolveU.uTexel, 1 / Math.max(src[2], 1), 1 / Math.max(src[3], 1));
  gl.uniform2f(convolveU.uOrder, p.orderX || 3, p.orderY || 3);
  gl.uniform2f(convolveU.uTarget, p.targetX | 0, p.targetY | 0);
  gl.uniform1f(convolveU.uDivisor, p.divisor || 1);
  gl.uniform1f(convolveU.uBias, p.bias || 0);
  gl.uniform1i(convolveU.uEdgeMode, p.edgeMode | 0);
  gl.uniform1i(convolveU.uPreserveAlpha, p.preserveAlpha | 0);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  conv.release();
}

registerSvgFilter('feConvolveMatrix', feConvolveMatrix);
export { feConvolveMatrix };
