// primitives/blur.js — feGaussianBlur. Two-pass linear-sampled Gaussian
// for σ ≤ 20; 3-pass box approximation (Wells 1986 / Kovacs 2011) above.
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex, beginFullscreen, passthrough,
  setInMap, setMapRect, texelOf, rectOfRT, blitRect, rectOf,
} from '../svgFilterShared.js';

/// Kovacs closed-form: integer box radius that best matches σ when
/// iterated K=3 times. r = floor((sqrt(12σ²/3 + 1) - 1) / 2).
function boxRadiusForSigma(sigma) {
  const s = Math.max(0, sigma);
  const r = (Math.sqrt(12 * s * s / 3 + 1) - 1) / 2;
  return Math.max(1, Math.floor(r + 0.5));
}

function feGaussianBlur(node, inputs, outRT, ctx) {
  const { gl, pool, blurProg, blurU, boxBlurProg, boxBlurU, coverVao } = ctx;
  if (!blurProg) return passthrough(gl, inputs[0], outRT, ctx);  // lean build without the blur shader
  const srcTex = resolveInputTex(inputs[0], pool, ctx);
  if (!srcTex) {
    // No source: clear to transparent black.
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  // Fold the per-draw world scale so the blur radius tracks worldMatrix
  // (ctx.worldScale defaults to [1,1] = identity).
  const ws = ctx.worldScale || [1, 1];
  const sigmaX = (node.params?.sigmaX || 0) * ws[0];
  const sigmaY = (node.params?.sigmaY || 0) * ws[1];
  const [rW, rH] = outRT.size;
  // Identity — passthrough via blit.
  if (sigmaX <= 0.5 && sigmaY <= 0.5) {
    const inFbo = (inputs[0].kind === 'rt') ? pool.get(inputs[0].idx).fbo : ctx.sourceRT.fbo;
    blitRect(gl, inFbo, rectOf(inputs[0], ctx), outRT, ctx);
    return;
  }
  // Pick algorithm: linear-sampled Gaussian for σ ≤ 20 (high quality,
  // bounded tap count); 3-pass box approximation for σ > 20 (cost is
  // O(r) instead of O(σ); Wells 1986 / Kovacs 2011). The threshold is
  // tunable — at σ=20 the Gaussian uses 32 taps per axis, the 3-pass
  // box uses ~20 fetches per axis. Crossover varies by hardware; 20
  // is a conservative safe default.
  // The intermediate carries the OUTPUT's rect: the horizontal pass has already
  // widened the input to the blurred extent, so the vertical pass reads it at
  // the output's own footprint.
  const outR = rectOfRT(outRT);
  const useBox = Math.max(sigmaX, sigmaY) > 20 && boxBlurProg;
  if (useBox) {
    blurThreePassBox(gl, pool, boxBlurProg, boxBlurU, coverVao,
                     inputs[0], srcTex, outRT, sigmaX, sigmaY, rW, rH, ctx);
    return;
  }
  // Two-pass linear-sampled Gaussian.
  const tmpIdx = pool.acquire(rW, rH, outR);
  const tmp = pool.get(tmpIdx);
  gl.useProgram(blurProg);
  gl.uniform1i(blurU.uTex, 0);
  gl.bindVertexArray(coverVao);
  // Horizontal: src → tmp. Taps step one canvas pixel, expressed in the
  // SOURCE's uv — which is not the output's once the two rects differ.
  const [sxT, syT] = texelOf(inputs[0], ctx);
  beginFullscreen(gl, tmp);
  setInMap(gl, blurU.uInMap, inputs[0], tmp, ctx);
  gl.uniform2f(blurU.uTexel, sxT, syT);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform2f(blurU.uDir, 1, 0);
  gl.uniform1f(blurU.uSigma, sigmaX);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // Vertical: tmp → out. Same rect, so the map is the identity.
  beginFullscreen(gl, outRT);
  setMapRect(gl, blurU.uInMap, outRT, outR);
  gl.uniform2f(blurU.uTexel, 1 / outR[2], 1 / outR[3]);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
  gl.uniform2f(blurU.uDir, 0, 1);
  gl.uniform1f(blurU.uSigma, sigmaY);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  pool.release(tmpIdx);
}

/// Three box-blur iterations per axis converge to a Gaussian shape
/// (Wells 1986). Picks the box radius via the Kovacs 2011 closed-form
/// so the resulting σ matches the requested feGaussianBlur σ.
function blurThreePassBox(gl, pool, prog, u, coverVao,
                          srcIn, srcTex, outRT, sigmaX, sigmaY, rW, rH, ctx) {
  const rx = boxRadiusForSigma(sigmaX);
  const ry = boxRadiusForSigma(sigmaY);
  // Ping-pong between two scratch RTs; 6 passes total (3 horizontal,
  // 3 vertical). The final vertical pass writes to outRT. Every scratch RT
  // carries the OUTPUT's rect, so only the first pass — reading the graph
  // input — has a non-identity map.
  const outR = rectOfRT(outRT);
  const aIdx = pool.acquire(rW, rH, outR);
  const bIdx = pool.acquire(rW, rH, outR);
  const a = pool.get(aIdx);
  const b = pool.get(bIdx);
  gl.useProgram(prog);
  gl.uniform1i(u.uTex, 0);
  gl.bindVertexArray(coverVao);

  function doPass(inTex, inR, outFB, dir, radius) {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inTex);
    gl.uniform2f(u.uDir, dir[0], dir[1]);
    gl.uniform1i(u.uRadius, radius);
    beginFullscreen(gl, outFB);
    setMapRect(gl, u.uInMap, outFB, inR);
    gl.uniform2f(u.uTexel, 1 / inR[2], 1 / inR[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  const srcR = rectOf(srcIn, ctx);
  // 3 horizontal passes: src → a → b → a (after 3rd write, a holds
  // horizontal-converged data).
  doPass(srcTex, srcR, a, [1, 0], rx);
  doPass(a.tex,  outR, b, [1, 0], rx);
  doPass(b.tex,  outR, a, [1, 0], rx);
  // 3 vertical passes: a → b → a → outRT.
  doPass(a.tex, outR, b,     [0, 1], ry);
  doPass(b.tex, outR, a,     [0, 1], ry);
  doPass(a.tex, outR, outRT, [0, 1], ry);

  gl.bindVertexArray(null);
  pool.release(aIdx);
  pool.release(bIdx);
}

registerSvgFilter('feGaussianBlur', feGaussianBlur);
export { feGaussianBlur };
