// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, trackGlResource } from '../../renderer/contextResources.js';
// primitives/turbulence.js — feTurbulence (procedural Perlin/fractal noise
// source; no image inputs), the Filter Effects 1 reference algorithm.
//
// The seeded tables are built on the CPU (turbulenceLattice.js) and uploaded
// as a 256×3 RGBA32F texture, once per seed and only when a turbulence is
// drawn: nothing here runs, allocates or binds for a bundle without one, and
// the texture is bound only for this pass (its sampler exists in no other
// program).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen, rectOfRT } from '../svgFilterShared.js';
import {
  turbulenceLattice,
  packLatticeTexels,
  turbulenceSetup,
  latticeSeed,
} from '../turbulenceLattice.js';

// Per PROGRAM (a renderer's, so a context-loss rebuild starts fresh), the
// uniforms ctx does not carry and the lattice textures by integer seed. A seed
// is tweenable, so the textures are an LRU: an animated seed holds at most
// LATTICE_CACHE of them (12 KB each).
const LATTICE_CACHE = 8;
const _perProg = new WeakMap();
function progState(gl, prog) {
  let st = _perProg.get(prog);
  if (!st) {
    st = {
      gl,
      uLattice: gl.getUniformLocation(prog, 'uLattice'),
      uUserMap: gl.getUniformLocation(prog, 'uUserMap'),
      uUserAff: gl.getUniformLocation(prog, 'uUserAff'),
      uUserM: gl.getUniformLocation(prog, 'uUserM'),
      uUserT: gl.getUniformLocation(prog, 'uUserT'),
      tex: new Map(),
    };
    _perProg.set(prog, st);
  }
  return st;
}
function latticeTex(gl, st, seed) {
  const key = latticeSeed(seed);
  let tex = st.tex.get(key);
  if (tex) {
    st.tex.delete(key);
    st.tex.set(key, tex);
    return tex;
  } // most recent last
  tex = trackGlResource(gl, gl.createTexture(), 'filterScratch');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    256,
    3,
    0,
    gl.RGBA,
    gl.FLOAT,
    packLatticeTexels(turbulenceLattice(key)),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  st.tex.set(key, tex);
  if (st.tex.size > LATTICE_CACHE) {
    const [oldKey, oldTex] = st.tex.entries().next().value;
    st.tex.delete(oldKey);
    deleteGlResource(gl, 'Texture', oldTex);
  }
  return tex;
}

function feTurbulence(node, inputs, outRT, ctx) {
  const { gl, feTurbulenceProg, feTurbulenceU, coverVao } = ctx;
  const oR = rectOfRT(outRT);
  if (!feTurbulenceProg) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  const st = progState(gl, feTurbulenceProg);
  // The noise is a function of USER space, y down: canvas px over the canvas's
  // px-per-user scale, flipped from GL's y-up.
  const ws = ctx.worldScale || [1, 1];
  // In a filter frame the pass runs m pixels in from the canvas on both axes (renderer/filterFrame.js). The noise is anchored to
  // the CANVAS, so every position below is taken back to canvas pixels first: the same field with or without a frame.
  const fm = ctx.frameM | 0;
  const ch = (ctx.h || oR[1] + oR[3]) - 2 * fm;
  // stitchTiles wraps the noise lattice at the TILE's period, and the tile is
  // the primitive's subregion — not this RT, which is that subregion padded and
  // rounded up for allocation. Stitching to the RT would give a period that
  // moves with the allocator and still seam wherever a consumer actually tiles.
  // Falls back to the RT rect when the subregion is unavailable (canvas-sized
  // passes), which is the same rect in that case. GL px → user space, y down.
  const sub0 = (ctx.nodeSubregions && ctx.nodeSubregions[ctx._curIdx | 0]) || oR;
  const sub = fm ? [sub0[0] - fm, sub0[1] - fm, sub0[2], sub0[3]] : sub0;
  let tile = [sub[0] / ws[0], (ch - (sub[1] + sub[3])) / ws[1], sub[2] / ws[0], sub[3] / ws[1]];
  // Under the referencing element's transform the field is a function of ITS user space: `p.um` takes a root-space point there (the
  // importer, from the inverse of the element's CTM). The stitch tile is the bound of the subregion in that space.
  const um = p.um || null;
  if (um) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [cx, cy] of [
      [tile[0], tile[1]],
      [tile[0] + tile[2], tile[1]],
      [tile[0], tile[1] + tile[3]],
      [tile[0] + tile[2], tile[1] + tile[3]],
    ]) {
      const qx = um[0] * cx + um[2] * cy + um[4],
        qy = um[1] * cx + um[3] * cy + um[5];
      if (qx < x0) x0 = qx;
      if (qx > x1) x1 = qx;
      if (qy < y0) y0 = qy;
      if (qy > y1) y1 = qy;
    }
    tile = [x0, y0, x1 - x0, y1 - y0];
  }
  const setup = turbulenceSetup(p.baseFreqX || 0, p.baseFreqY || 0, !!(p.stitch | 0), tile);
  gl.useProgram(feTurbulenceProg);
  gl.uniform2f(feTurbulenceU.uBaseFreq, setup.fx, setup.fy);
  gl.uniform1i(feTurbulenceU.uNumOctaves, Math.max(1, Math.min(6, p.numOctaves | 0 || 1)));
  gl.uniform1i(feTurbulenceU.uKind, p.kind | 0);
  gl.uniform2f(feTurbulenceU.uTilePos, oR[0] - fm, oR[1] - fm);
  gl.uniform2f(feTurbulenceU.uTileSize, oR[2], oR[3]);
  gl.uniform4f(st.uUserMap, 1 / ws[0], 1 / ws[1], ch, 0);
  if (st.uUserAff) gl.uniform1i(st.uUserAff, um ? 1 : 0);
  if (um) {
    gl.uniform4f(st.uUserM, um[0], um[1], um[2], um[3]);
    gl.uniform2f(st.uUserT, um[4], um[5]);
  }
  gl.uniform1i(feTurbulenceU.uStitch, setup.size ? 1 : 0);
  if (setup.size) {
    gl.uniform2f(feTurbulenceU.uStitchPos, setup.wrap[0], setup.wrap[1]);
    gl.uniform2f(feTurbulenceU.uStitchSize, setup.size[0], setup.size[1]);
  }
  gl.uniform1i(st.uLattice, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, latticeTex(gl, st, p.seed));
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

/// Free this renderer's lattice textures (renderer dispose calls every
/// handler's disposeGl with its context).
feTurbulence.disposeGl = (gl, R) => {
  const prog = R && R.feTurbulenceProg;
  const st = prog && _perProg.get(prog);
  if (!st) return;
  for (const tex of st.tex.values()) deleteGlResource(gl, 'Texture', tex);
  st.tex.clear();
  _perProg.delete(prog);
};

registerSvgFilter('feTurbulence', feTurbulence);
export { feTurbulence };
