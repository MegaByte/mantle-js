// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/blur.js — feGaussianBlur. Per axis, one linear-sampled Gaussian pass
// (a CPU-built tap table reaching 3σ) or, past the table's reach, box passes;
// filterGraph/blurKernel.js plans both.
import { solidPaintOf, convertedInput, passthroughCs } from '../svgFilterShared.js';
import { inMode } from '../colorSpace.js';
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  setInMap,
  setMapRect,
  texelOf,
  rectOf,
  rectOfRT,
} from '../svgFilterShared.js';
import { blurPasses, blurPassesAlong, blurAxesPx, setGaussTaps } from '../blurKernel.js';

function feGaussianBlur(node, inputs, outRT, ctx) {
  if (solidPaintOf(inputs[0], ctx)) return passthroughCs(ctx.gl, inputs[0], outRT, ctx);
  const { gl, pool, blurProg, blurU, boxBlurProg, boxBlurU, coverVao } = ctx;
  if (!blurProg) return passthroughCs(gl, inputs[0], outRT, ctx); // lean build without the blur shader
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    // No source: clear to transparent black.
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  // Fold the per-draw world scale so the blur radius tracks worldMatrix
  // (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  const sigmaX = (node.params?.sigmaX || 0) * ws[0];
  const sigmaY = (node.params?.sigmaY || 0) * ws[1];
  const haveBox = !!(boxBlurProg && boxBlurU);
  // `m` (set by the importer under a turning or skewing CTM, importFilters blurFollowsAxes): the blur follows
  // the element's own axes, so its two passes run along those axes in canvas px. Without it the
  // passes are the device's x then y, exactly as before.
  const passes = node.params?.m
    ? blurPassesAlong(
        blurAxesPx(node.params, ctx.offsetMatrix || [ws[0], 0, 0, ws[1]]).axes,
        haveBox,
      )
    : blurPasses(sigmaX, sigmaY, haveBox);
  // Identity on both axes — passthrough via blit.
  if (!passes.length) return passthroughCs(gl, inputs[0], outRT, ctx);
  // The taps sit between texels, so the conversion cannot ride them: blur a converted copy (see svgFilterShared convertedInput).
  // A Gaussian first pass converts as it reads (the variant program reads each paired tap as its two texels); a box first pass cannot, and
  // takes the converted copy.
  const mode = inMode(ctx, 0);
  const fused = mode && passes[0].gauss && ctx.blurCs ? ctx.blurCs() : null;
  const conv = fused ? { input: inputs[0], release() {} } : convertedInput(inputs[0], mode, ctx);
  inputs = [conv.input];
  const srcTex2 = resolveInputTex(inputs[0], pool, ctx);

  // Every scratch RT carries the OUTPUT's rect: the first pass has already
  // widened the input to the blurred extent, so later passes read it at the
  // output's own footprint and only the first — reading the graph input — has a
  // non-identity map. Two scratch RTs ping-pong when there are three or more
  // passes (box), one serves two, none serves one; the last pass writes outRT.
  const outR = rectOfRT(outRT);
  const [rW, rH] = outRT.size;
  const nScratch = Math.min(passes.length - 1, 2);
  const scratch = [];
  for (let i = 0; i < nScratch; i++) scratch.push(pool.acquire(rW, rH, outR));
  gl.bindVertexArray(coverVao);
  gl.activeTexture(gl.TEXTURE0);
  let prog = null,
    inTex = srcTex2 || srcTex;
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const dst = i === passes.length - 1 ? outRT : pool.get(scratch[i % nScratch]);
    const f0 = fused && i === 0;
    const u = f0 ? fused.u : p.gauss ? blurU : boxBlurU;
    const want = f0 ? fused.prog : p.gauss ? blurProg : boxBlurProg;
    if (prog !== want) {
      gl.useProgram(want);
      gl.uniform1i(u.uTex, 0);
      prog = want;
    }
    if (f0) gl.uniform1i(u.uCsIn, mode);
    beginFullscreen(gl, dst);
    // Taps step one canvas pixel, expressed in the INPUT's uv — which is not the
    // output's once the two rects differ.
    if (i === 0) {
      setInMap(gl, u.uInMap, inputs[0], dst, ctx);
      const [tx, ty] = texelOf(inputs[0], ctx);
      gl.uniform2f(u.uTexel, tx, ty);
    } else {
      setMapRect(gl, u.uInMap, dst, outR);
      gl.uniform2f(u.uTexel, 1 / outR[2], 1 / outR[3]);
    }
    gl.uniform2f(u.uDir, p.dir[0], p.dir[1]);
    if (p.gauss) setGaussTaps(gl, u, p.gauss);
    else gl.uniform1i(u.uRadius, p.box);
    gl.bindTexture(gl.TEXTURE_2D, inTex);
    const keep = i === 0 ? rectOf(inputs[0], ctx) : outR; // (a target past its pixels: see applyKeepScissor)
    const past = u.uInPast && keep.keep;
    if (past) gl.uniform2f(u.uInPast, 1 - keep.keep[2] / keep[2], 1 - keep.keep[3] / keep[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (past) gl.uniform2f(u.uInPast, 0, 0);
    inTex = dst.tex;
  }
  gl.bindVertexArray(null);
  for (const idx of scratch) pool.release(idx);
  conv.release();
}

registerSvgFilter('feGaussianBlur', feGaussianBlur);
export { feGaussianBlur };
