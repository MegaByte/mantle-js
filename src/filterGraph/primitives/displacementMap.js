// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/displacementMap.js — feDisplacementMap.
import { solidPaintOf, passthrough as paintPassthrough } from '../svgFilterShared.js';
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  passthrough,
  setInMap,
  rectOf,
} from '../svgFilterShared.js';
import { inMode } from '../colorSpace.js';

function feDisplacementMap(node, inputs, outRT, ctx) {
  if (solidPaintOf(inputs[0], ctx)) return paintPassthrough(ctx.gl, inputs[0], outRT, ctx);
  const { gl, pool, feDisplacementMapProg, feDisplacementMapU, coverVao } = ctx;
  if (!feDisplacementMapProg) return passthrough(gl, inputs[0], outRT, ctx);
  const aTex = resolveInputTex(inputs[0], pool, ctx);
  const bTex = resolveInputTex(inputs[1], pool, ctx);
  if (!aTex || !bTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
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
  // Only the displacement map is read in the primitive's space; the displaced image keeps the space it is in (colorSpace.js).
  const mapMode = inMode(ctx, 1);
  if (feDisplacementMapU.uCsIn2) gl.uniform1i(feDisplacementMapU.uCsIn2, mapMode);
  setInMap(gl, feDisplacementMapU.uIn1Map, inputs[0], outRT, ctx);
  setInMap(gl, feDisplacementMapU.uIn2Map, inputs[1], outRT, ctx);
  // The displacement is applied in uIn1's uv, so the pixel→uv scale is uIn1's.
  const src = rectOf(inputs[0], ctx);
  gl.uniform2f(feDisplacementMapU.uTexel, ws[0] / src[2], ws[1] / src[3]);
  // The displacement is a vector in the USER space of the element that references the filter: `p.m` (the importer, under that element's
  // transform) carries it to root space, and the renderer's user-vector -> canvas-px matrix takes it to pixels (GL: y flipped). Without a
  // transform the vector is (dx, dy) (uDispUseM 0).
  if (feDisplacementMapU.uDispUseM) {
    const m = p.m;
    gl.uniform1i(feDisplacementMapU.uDispUseM, m ? 1 : 0);
    if (m) {
      const o = ctx.offsetMatrix || [ws[0], 0, 0, ws[1]];
      const a00 = o[0] * m[0] + o[2] * m[1],
        a01 = o[0] * m[2] + o[2] * m[3],
        a10 = o[1] * m[0] + o[3] * m[1],
        a11 = o[1] * m[2] + o[3] * m[3];
      gl.uniform4f(feDisplacementMapU.uDispM, a00 / ws[0], -a10 / ws[1], a01 / ws[0], -a11 / ws[1]);
    }
  }
  // The channel picks as one-hot vectors: the shader takes each by one dot product.
  const oneHot = (ch) => {
    const v = [0, 0, 0, 0];
    v[Math.max(0, Math.min(3, ch | 0))] = 1;
    return v;
  };
  const xs = oneHot(p.xChan),
    ys = oneHot(p.yChan);
  gl.uniform4f(feDisplacementMapU.uXSel, xs[0], xs[1], xs[2], xs[3]);
  gl.uniform4f(feDisplacementMapU.uYSel, ys[0], ys[1], ys[2], ys[3]);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, aTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, bTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  if (mapMode && feDisplacementMapU.uCsIn2) gl.uniform1i(feDisplacementMapU.uCsIn2, 0);
}

registerSvgFilter('feDisplacementMap', feDisplacementMap);
export { feDisplacementMap };
