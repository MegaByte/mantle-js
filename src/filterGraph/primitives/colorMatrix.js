// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/colorMatrix.js — feColorMatrix (4×5 row-major color xform).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthroughCs, setInMap } from '../svgFilterShared.js';
import { inMode, outMode } from '../colorSpace.js';

function feColorMatrix(node, inputs, outRT, ctx) {
  const { gl, pool, colorMatrixProg, colorMatrixU, coverVao } = ctx;
  if (!colorMatrixProg) return passthroughCs(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  // matrix layout matches the filterTab encoding (row-major 4×5).
  // params.matrix = [r0c0..r0c3, r0c4, r1c0..r1c3, r1c4, r2..., r3...]
  // = 20 floats. The shader reads 4 row uniforms (c0..c3 of each row)
  // plus uMOff = (r0c4, r1c4, r2c4, r3c4).
  const m = (node.params && node.params.matrix) || [
    1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
  ];
  gl.useProgram(colorMatrixProg);
  gl.uniform1i(colorMatrixU.uTex, 0);
  if (colorMatrixU.uLinearZeroBorder) gl.uniform1i(colorMatrixU.uLinearZeroBorder, 0);
  const mode = inMode(ctx, 0);
  const outConv = outMode(ctx);
  if (colorMatrixU.uCsIn) gl.uniform1i(colorMatrixU.uCsIn, mode);
  if (colorMatrixU.uCsOut) gl.uniform1i(colorMatrixU.uCsOut, outConv);
  setInMap(gl, colorMatrixU.uInMap, inputs[0], outRT, ctx);
  gl.uniform4f(colorMatrixU.uM0, m[0], m[1], m[2], m[3]);
  gl.uniform4f(colorMatrixU.uM1, m[5], m[6], m[7], m[8]);
  gl.uniform4f(colorMatrixU.uM2, m[10], m[11], m[12], m[13]);
  gl.uniform4f(colorMatrixU.uM3, m[15], m[16], m[17], m[18]);
  gl.uniform4f(colorMatrixU.uMOff, m[4], m[9], m[14], m[19]);
  beginFullscreen(gl, outRT);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  if (mode && colorMatrixU.uCsIn) gl.uniform1i(colorMatrixU.uCsIn, 0);
  if (outConv && colorMatrixU.uCsOut) gl.uniform1i(colorMatrixU.uCsOut, 0);
}

registerSvgFilter('feColorMatrix', feColorMatrix);
export { feColorMatrix };
