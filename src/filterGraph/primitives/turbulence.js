// primitives/turbulence.js — feTurbulence (procedural Perlin/fractal noise
// source; no image inputs).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen } from '../svgFilterShared.js';

function feTurbulence(node, inputs, outRT, ctx) {
  const { gl, feTurbulenceProg, feTurbulenceU, coverVao } = ctx;
  const [w, h] = outRT.size;
  if (!feTurbulenceProg) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const p = node.params || {};
  gl.useProgram(feTurbulenceProg);
  gl.uniform2f(feTurbulenceU.uBaseFreq, p.baseFreqX || 0, p.baseFreqY || 0);
  gl.uniform1i(feTurbulenceU.uNumOctaves, Math.max(1, Math.min(6, p.numOctaves | 0 || 1)));
  gl.uniform1f(feTurbulenceU.uSeed, p.seed || 0);
  gl.uniform1i(feTurbulenceU.uKind, p.kind | 0);
  gl.uniform2f(feTurbulenceU.uTilePos, 0, 0);
  gl.uniform2f(feTurbulenceU.uTileSize, w, h);
  gl.uniform1i(feTurbulenceU.uStitch, p.stitch | 0);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feTurbulence', feTurbulence);
export { feTurbulence };
