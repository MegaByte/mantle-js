// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feOffset translates in canvas pixels after the document and draw transforms.
import { solidPaintOf, passthrough as paintPassthrough } from '../svgFilterShared.js';
import { registerSvgFilter } from '../dispatchRegistry.js';
import { SRC_GRAPHIC } from '../filterGraph.js';
import {
  beginFullscreen,
  blitRect,
  rectOf,
  resolveInputTex,
  setMapRect,
} from '../svgFilterShared.js';

function feOffset(node, inputs, outRT, ctx) {
  if (solidPaintOf(inputs[0], ctx)) return paintPassthrough(ctx.gl, inputs[0], outRT, ctx);
  const { gl, pool } = ctx,
    p = node.params || {},
    ws = ctx.worldScale || [1, 1];
  const m = ctx.offsetMatrix || [ws[0], 0, 0, ws[1]],
    x = p.dx || 0,
    y = p.dy || 0;
  const dx = Math.fround(m[0] * x + m[2] * y),
    dy = Math.fround(m[1] * x + m[3] * y);
  const input = inputs[0],
    inR = rectOf(input, ctx),
    shifted = [inR[0] + dx, inR[1] - dy, inR[2], inR[3]];
  const blits =
    Number.isInteger(dx) &&
    Number.isInteger(dy) &&
    (input.kind === 'rt' || input.tag === SRC_GRAPHIC);
  // Resolve the input texture BEFORE the output is bound: SourceAlpha / BackgroundAlpha are materialised on
  // first use by a pass that binds its own framebuffer, which sent the shifted draw into the wrong target.
  const tex = blits ? null : resolveInputTex(input, pool, ctx),
    u = ctx.colorMatrixU;
  beginFullscreen(gl, outRT);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (blits) {
    const inFbo = input.kind === 'rt' ? pool.get(input.idx).fbo : ctx.sourceRT.fbo;
    blitRect(gl, inFbo, shifted, outRT, ctx);
    return;
  }
  if (!tex) return;
  if (!ctx.colorMatrixProg || !u)
    throw new Error('Fractional filter offsets require the color-matrix shader');
  gl.useProgram(ctx.colorMatrixProg);
  gl.uniform1i(u.uTex, 0);
  if (u.uLinearZeroBorder) gl.uniform1i(u.uLinearZeroBorder, 1);
  if (u.uCsIn) gl.uniform1i(u.uCsIn, 0); // a pure move: the result keeps the space of its input
  if (u.uCsOut) gl.uniform1i(u.uCsOut, 0);
  setMapRect(gl, u.uInMap, outRT, shifted);
  gl.uniform4f(u.uM0, 1, 0, 0, 0);
  gl.uniform4f(u.uM1, 0, 1, 0, 0);
  gl.uniform4f(u.uM2, 0, 0, 1, 0);
  gl.uniform4f(u.uM3, 0, 0, 0, 1);
  gl.uniform4f(u.uMOff, 0, 0, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.bindVertexArray(ctx.coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}
registerSvgFilter('feOffset', feOffset);
export { feOffset };
