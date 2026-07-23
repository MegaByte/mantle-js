// primitives/turbulence.js — feTurbulence (procedural Perlin/fractal noise
// source; no image inputs).
import { registerSvgFilter } from '../dispatchRegistry.js';
import { beginFullscreen, rectOfRT } from '../svgFilterShared.js';

function feTurbulence(node, inputs, outRT, ctx) {
  const { gl, feTurbulenceProg, feTurbulenceU, coverVao } = ctx;
  const oR = rectOfRT(outRT);
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
  // Noise is a function of CANVAS position — the subregion origin/size, so the
  // pattern doesn't slide when the output rect moves.
  gl.uniform2f(feTurbulenceU.uTilePos, oR[0], oR[1]);
  gl.uniform2f(feTurbulenceU.uTileSize, oR[2], oR[3]);
  gl.uniform1i(feTurbulenceU.uStitch, p.stitch | 0);
  beginFullscreen(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerSvgFilter('feTurbulence', feTurbulence);
export { feTurbulence };
