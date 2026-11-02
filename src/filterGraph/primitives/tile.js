// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/tile.js — feTile (repeat the input's primitive subregion across the filter region).
//
// The tile is the INPUT's subregion in user space (ctx.subregionOf, resolved by the renderer: an external feImage's placed
// subregion, else the union of the subregions of the node's inputs, else the filter region), never the rect of the
// render target holding the input: a target is padded, rounded to a quantum and clipped to the canvas or to a filter
// frame, so a tile taken from it would move with the allocator and with the frame. Without a resolved subregion (a context
// that has no filter region) the input's own rect stands in.
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  passthrough,
  rectOf,
  rectOfRT,
  solidPaintOf,
} from '../svgFilterShared.js';

/// The two maps the shader takes (see feTile.frag.glsl), from the output rect `oR`, the tile `tR` and the input texture's rect
/// `iR`, each [x, y, w, h] in the same pixel grid. The tile coordinate's offset is reduced to [0, 1) here, in double precision.
export function tileMaps(oR, tR, iR) {
  const tw = tR[2] || 1,
    th = tR[3] || 1,
    iw = iR[2] || 1,
    ih = iR[3] || 1;
  const bx = (oR[0] - tR[0]) / tw,
    by = (oR[1] - tR[1]) / th;
  return {
    a: [oR[2] / tw, oR[3] / th, bx - Math.floor(bx), by - Math.floor(by)],
    b: [tR[2] / iw, tR[3] / ih, (tR[0] - iR[0]) / iw, (tR[1] - iR[1]) / ih],
  };
}

function feTile(node, inputs, outRT, ctx) {
  const { gl, pool, feTileProg, feTileU, coverVao } = ctx;
  if (!feTileProg) return passthrough(gl, inputs[0], outRT, ctx);
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  gl.useProgram(feTileProg);
  gl.uniform1i(feTileU.uTex, 0);
  if (solidPaintOf(inputs[0], ctx)) {
    // one color everywhere: any tile reads the same texel
    gl.uniform4f(feTileU.uTileA, 0, 0, 0, 0);
    gl.uniform4f(feTileU.uTileB, 0, 0, 0.5, 0.5);
  } else {
    const iR = rectOf(inputs[0], ctx);
    const sub = ctx.subregionOf ? ctx.subregionOf(node.inputs[0]) : null;
    const tR = sub && sub[2] > 0 && sub[3] > 0 ? sub : iR;
    const m = tileMaps(rectOfRT(outRT), tR, iR);
    gl.uniform4f(feTileU.uTileA, m.a[0], m.a[1], m.a[2], m.a[3]);
    gl.uniform4f(feTileU.uTileB, m.b[0], m.b[1], m.b[2], m.b[3]);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feTile', feTile);
export { feTile };
