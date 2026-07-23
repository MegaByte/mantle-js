// primitives/merge.js — feMerge: composite N inputs as "in[0] over
// in[1] over ... over in[N-1]". Per SVG spec, mergeNode order is
// bottom-to-top — the first mergeNode is drawn first (becomes the
// backmost layer), each subsequent node composites over it. Reuses the
// feComposite shader (op=over) with two scratch RTs ping-ponging.
import { registerSvgFilter } from '../dispatchRegistry.js';
import {
  resolveInputTex, beginFullscreen, passthrough,
  setInMap, setMapRect, rectOfRT, blitRect,
} from '../svgFilterShared.js';

function feMerge(node, inputs, outRT, ctx) {
  const { gl, pool, feCompositeProg, feCompositeU, coverVao } = ctx;
  if (!feCompositeProg || !inputs.length) {
    beginFullscreen(gl, outRT);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  if (inputs.length === 1) {
    passthrough(gl, inputs[0], outRT, ctx);
    return;
  }
  gl.useProgram(feCompositeProg);
  gl.uniform1i(feCompositeU.uIn1, 0);
  gl.uniform1i(feCompositeU.uIn2, 1);
  gl.uniform1i(feCompositeU.uOp, 0);  // over
  gl.uniform4f(feCompositeU.uK, 0, 0, 0, 0);
  const outR = rectOfRT(outRT);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, resolveInputTex(inputs[1], pool, ctx));
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, resolveInputTex(inputs[0], pool, ctx));
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
    let acc = outRT, scratch = tmp;
    for (let i = 2; i < inputs.length; i++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, resolveInputTex(inputs[i], pool, ctx));
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      beginFullscreen(gl, scratch);
      setInMap(gl, feCompositeU.uIn1Map, inputs[i], scratch, ctx);
      setMapRect(gl, feCompositeU.uIn2Map, scratch, outR);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const t = acc; acc = scratch; scratch = t;
    }
    if (acc !== outRT) blitRect(gl, acc.fbo, outR, outRT, ctx);
    pool.release(tmpIdx);
  }
  gl.bindVertexArray(null);
}

registerSvgFilter('feMerge', feMerge);
export { feMerge };
