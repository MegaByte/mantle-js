// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/morphology.js — feMorphology (dilate / erode).
import { solidPaintOf, convertedInput, passthroughCs } from '../svgFilterShared.js';
import { inMode } from '../colorSpace.js';
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  setInMap,
  setMapRect,
  texelOf,
  rectOfRT,
} from '../svgFilterShared.js';
import { morphAxesPx, morphRadiusPasses } from '../blurKernel.js';

function feMorphology(node, inputs, outRT, ctx) {
  if (solidPaintOf(inputs[0], ctx)) return passthroughCs(ctx.gl, inputs[0], outRT, ctx);
  const { gl, pool, morphProg, morphU, coverVao } = ctx;
  if (!morphProg) return passthroughCs(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const { operator = 0 } = node.params || {};
  // Fold the per-draw world scale so the morphology radius tracks
  // worldMatrix (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  // `m` (the importer, under a turning or skewing CTM): the window's two axes are the ELEMENT's, so the passes run along them in canvas px.
  const axes = node.params?.m
    ? morphAxesPx(node.params, ctx.offsetMatrix || [ws[0], 0, 0, ws[1]]).passes
    : null;
  const radiusX = axes ? axes[0].r : (node.params?.radiusX || 0) * ws[0];
  const radiusY = axes ? axes[1].r : (node.params?.radiusY || 0) * ws[1];
  const dir0 = axes ? axes[0].dir : [1, 0],
    dir1 = axes ? axes[1].dir : [0, 1];
  if (radiusX < 0.5 && radiusY < 0.5) {
    passthroughCs(gl, inputs[0], outRT, ctx);
    return;
  }
  // The window mixes neighbors in the space the primitive operates in: take a converted copy of the input.
  const conv = convertedInput(inputs[0], inMode(ctx, 0), ctx);
  inputs = [conv.input];
  const srcTex2 = resolveInputTex(inputs[0], pool, ctx);
  const [rW, rH] = outRT.size;
  const outR = rectOfRT(outRT);
  // Each axis is its radius in passes (morphRadiusPasses); within one pass's reach that is two passes, one per axis.
  const longest = Math.max(rW, rH),
    steps = [];
  for (const r of morphRadiusPasses(radiusX, longest)) steps.push([r, dir0]);
  for (const r of morphRadiusPasses(radiusY, longest)) steps.push([r, dir1]);
  const tmpIdx = pool.acquire(rW, rH, outR); // intermediates share the output's rect
  const tmp = pool.get(tmpIdx);
  const tmp2Idx = steps.length > 2 ? pool.acquire(rW, rH, outR) : -1;
  const tmp2 = tmp2Idx >= 0 ? pool.get(tmp2Idx) : null;
  gl.useProgram(morphProg);
  gl.uniform1i(morphU.uTex, 0);
  gl.uniform1i(morphU.uOperator, operator | 0);
  gl.bindVertexArray(coverVao);
  let from = null;
  steps.forEach(([radius, dir], i) => {
    const to = i === steps.length - 1 ? outRT : i % 2 === 0 ? tmp : tmp2;
    beginFullscreen(gl, to);
    gl.activeTexture(gl.TEXTURE0);
    if (!from) {
      // The first pass reads the input. Steps one canvas pixel in the SOURCE's uv.
      const [sxT, syT] = texelOf(inputs[0], ctx);
      setInMap(gl, morphU.uInMap, inputs[0], to, ctx);
      gl.uniform2f(morphU.uTexel, sxT, syT);
      gl.bindTexture(gl.TEXTURE_2D, srcTex2 || srcTex);
    } else {
      // The rest read the pass before, on the same rect: the map is the identity.
      setMapRect(gl, morphU.uInMap, to, outR);
      gl.uniform2f(morphU.uTexel, 1 / outR[2], 1 / outR[3]);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
    }
    gl.uniform2f(morphU.uDir, dir[0], dir[1]);
    gl.uniform1f(morphU.uRadius, radius);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    from = to;
  });
  gl.bindVertexArray(null);
  pool.release(tmpIdx);
  if (tmp2Idx >= 0) pool.release(tmp2Idx);
  conv.release();
}

registerSvgFilter('feMorphology', feMorphology);
export { feMorphology };
