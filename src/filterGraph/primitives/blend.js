// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/blend.js — feBlend (two-input separable/non-separable blend
// modes).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { resolveInputTex, beginFullscreen, passthroughCs, setInMap } from '../svgFilterShared.js';
import { inMode } from '../colorSpace.js';

function feBlend(node, inputs, outRT, ctx) {
  const { gl, pool, feBlendProg, feBlendU, coverVao } = ctx;
  if (!feBlendProg) return passthroughCs(gl, inputs[0], outRT, ctx);
  const aTex = resolveInputTex(inputs[0], pool, ctx);
  const bTex = resolveInputTex(inputs[1], pool, ctx);
  if (!aTex || !bTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const mode = (node.params && node.params.mode) | 0;
  gl.useProgram(feBlendProg);
  gl.uniform1i(feBlendU.uIn1, 0);
  gl.uniform1i(feBlendU.uIn2, 1);
  setInMap(gl, feBlendU.uIn1Map, inputs[0], outRT, ctx);
  setInMap(gl, feBlendU.uIn2Map, inputs[1], outRT, ctx);
  gl.uniform1i(feBlendU.uMode, mode);
  const m0 = inMode(ctx, 0),
    m1 = inMode(ctx, 1);
  if (feBlendU.uCsIn) gl.uniform2i(feBlendU.uCsIn, m0, m1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, aTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, bTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  if ((m0 || m1) && feBlendU.uCsIn) gl.uniform2i(feBlendU.uCsIn, 0, 0);
}

registerSvgFilter('feBlend', feBlend);
export { feBlend };
