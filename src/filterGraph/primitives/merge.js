// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitives/merge.js — feMerge: composite N inputs as "in[0] over
// in[1] over ... over in[N-1]". Per SVG spec, mergeNode order is
// bottom-to-top — the first mergeNode is drawn first (becomes the
// backmost layer), each subsequent node composites over it. Reuses the
// feComposite shader (op=over) with two scratch RTs ping-ponging.
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex,
  beginFullscreen,
  setInMap,
  setMapRect,
  rectOfRT,
  blitRect,
  passthroughCs,
} from '../svgFilterShared.js';
import { inMode } from '../colorSpace.js';
import { porterDuffCoefficients } from '../porterDuff.js';

function feMerge(node, inputs, outRT, ctx) {
  const { gl, pool, feCompositeProg, feCompositeU, coverVao } = ctx;
  if (!feCompositeProg || !inputs.length) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  if (inputs.length === 1) {
    passthroughCs(gl, inputs[0], outRT, ctx);
    return;
  }
  // Resolve every input's texture BEFORE this pass sets its program and bindings: a SourceAlpha /
  // BackgroundAlpha input is materialised on first use by a blit that changes the program, the
  // active unit and the VAO, which left the composite drawing with the wrong program.
  const texs = inputs.map((inp) => resolveInputTex(inp, pool, ctx));
  gl.useProgram(feCompositeProg);
  gl.uniform1i(feCompositeU.uIn1, 0);
  gl.uniform1i(feCompositeU.uIn2, 1);
  gl.uniform1i(feCompositeU.uOp, 0); // over
  if (feCompositeU.uPD) {
    const k = porterDuffCoefficients(3);
    gl.uniform4f(feCompositeU.uPD, k[0], k[1], k[2], k[3]);
  }
  gl.uniform4f(feCompositeU.uK, 0, 0, 0, 0);
  // Each layer is read in the space the merge operates in; the running result already is in it.
  const cs = feCompositeU.uCsIn ? (a, b) => gl.uniform2i(feCompositeU.uCsIn, a, b) : () => {};
  let converted = false;
  const mode = (i) => {
    const m = inMode(ctx, i);
    if (m) converted = true;
    return m;
  };
  cs(mode(1), mode(0));
  const coverage = !!(feCompositeU.uCoverageResolve && ctx._cs?.coverageResolve);
  try {
    if (coverage) {
      const sourceRT = ctx.sourceRT,
        lowerRT = inputs[0].kind === 'rt' ? pool.get(inputs[0].idx) : null;
      const aligned = (rt) => {
        if (!rt || !rt.size) return false;
        const r = rectOfRT(rt);
        return (
          r.length === 4 &&
          r.every((n) => Number.isInteger(n) && Math.abs(n) < 536870912) &&
          r[2] === rt.size[0] &&
          r[3] === rt.size[1] &&
          r[2] > 0 &&
          r[3] > 0 &&
          r[2] <= 8388608 &&
          r[3] <= 8388608
        );
      };
      const pixelAligned = aligned(outRT) && aligned(sourceRT) && aligned(lowerRT);
      gl.uniform1i(feCompositeU.uCoverageIn1, 0);
      gl.uniform1i(feCompositeU.uCoverageIn2, 1);
      gl.uniform1i(feCompositeU.uCoveragePixelAligned, pixelAligned ? 1 : 0);
      if (pixelAligned) {
        const out = rectOfRT(outRT),
          src = rectOfRT(sourceRT),
          lower = rectOfRT(lowerRT);
        gl.uniform2i(feCompositeU.uCoverageIn1Offset, out[0] - src[0], out[1] - src[1]);
        gl.uniform2i(feCompositeU.uCoverageIn2Offset, out[0] - lower[0], out[1] - lower[1]);
      }
      gl.uniform1i(feCompositeU.uCoverageResolve, 1);
      gl.uniform1f(feCompositeU.uSourceCoverageScale, ctx.unitCoverageOpacity || 1);
      const p = ctx._cs.sourceMaterial;
      gl.uniform4fv(feCompositeU.uSourceMaterialLo, p.materialLo);
      gl.uniform4fv(feCompositeU.uSourceMaterialHi, p.materialHi);
    }
    const outR = rectOfRT(outRT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texs[1]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texs[0]);
    beginFullscreen(gl, outRT);
    setInMap(gl, feCompositeU.uIn1Map, inputs[1], outRT, ctx);
    setInMap(gl, feCompositeU.uIn2Map, inputs[0], outRT, ctx);
    gl.bindVertexArray(coverVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (inputs.length > 2) {
      const [rW, rH] = outRT.size;
      // The accumulator ping-pongs with a scratch RT of the same rect, so uIn2
      // (the running result) is always the identity map; only uIn1 — the next
      // layer, which has its own rect — needs one.
      let tmpIdx = pool.acquire(rW, rH, outR);
      let tmp = pool.get(tmpIdx);
      let acc = outRT,
        scratch = tmp;
      for (let i = 2; i < inputs.length; i++) {
        cs(mode(i), 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texs[i]);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, acc.tex);
        beginFullscreen(gl, scratch);
        setInMap(gl, feCompositeU.uIn1Map, inputs[i], scratch, ctx);
        setMapRect(gl, feCompositeU.uIn2Map, scratch, outR);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const t = acc;
        acc = scratch;
        scratch = t;
      }
      if (acc !== outRT) blitRect(gl, acc.fbo, outR, outRT, ctx);
      pool.release(tmpIdx);
    }
    gl.bindVertexArray(null);
  } finally {
    if (converted) cs(0, 0);
    if (coverage) gl.uniform1i(feCompositeU.uCoverageResolve, 0);
  }
}

registerSvgFilter('feMerge', feMerge);
export { feMerge };
