// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colr/paints.js — COLRv1 paint node handlers. Imported as a unit (a
// COLR paint graph can use any node type), self-registering into
// dispatchRegistry on import. A consumer whose assets use no color fonts
// never imports this module and the bundler drops all handlers + their
// shared helpers.
//
// The root barrel (@kontek/mantle) imports this module, so importing the
// package registers the full COLR paint set. Feature-splitting consumers
// import it directly and read colrPaintDispatch() from dispatchRegistry.js.

import { registerColrPaint } from '../dispatchRegistry.js';
import {
  beginRT,
  clearOut,
  bindPaintMap,
  bindGradientStops,
  withIdx,
  pxOfUV,
  pxAffine,
} from './colrPaintShared.js';
import { mapFor, rectOfRT, blitRect } from '../svgFilterShared.js';
import { AFF_ID, affMul, affInv } from '../affine2d.js';
import { porterDuffCoefficients } from '../porterDuff.js';

/// Upload the vUV -> uv map of an input whose target covers `inR` (see _filterRect.glsl). A missing
/// location (a program built without it) is skipped.
function setMap(gl, loc, outRT, inR) {
  if (!loc) return;
  const m = mapFor(rectOfRT(outRT), inR);
  gl.uniform4f(loc, m[0], m[1], m[2], m[3]);
}

/// PaintSolid — fill RT with a constant premultiplied color. Uses the
/// same gl.clearColor + gl.clear path as feFlood (no shader).
function paintSolid(node, inputs, outRT, ctx) {
  const { gl } = ctx;
  const p = node.params || {};
  // The reader emits unpremultiplied [r,g,b,a]. Foreground sentinel
  // (isForeground=true) substitutes the run's primary color.
  let rgba = p.rgba;
  if (p.isForeground && ctx.runColor) rgba = ctx.runColor;
  if (!rgba) rgba = [0, 0, 0, 0];
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  // Premultiply for the filter-graph invariant (CSS Filter Effects §11).
  gl.clearColor(rgba[0] * rgba[3], rgba[1] * rgba[3], rgba[2] * rgba[3], rgba[3]);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function paintLinearGradient(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, paintLinearGradProg, paintLinearGradU, coverVao } = ctx;
  if (!paintLinearGradProg) return clearOut(gl, outRT);
  const p = node.params || {};
  if (
    !bindPaintMap(
      ctx,
      outRT,
      paintLinearGradProg,
      paintLinearGradU.uPaintMapX,
      paintLinearGradU.uPaintMapY,
    )
  )
    return clearOut(gl, outRT);
  if (!bindGradientStops(gl, 0, paintLinearGradProg, paintLinearGradU, ctx, node)) {
    return clearOut(gl, outRT);
  }
  const p0 = p.p0 || [0, 0],
    p1 = p.p1 || [1, 0],
    p2 = p.p2 || [0, 1];
  gl.uniform2f(paintLinearGradU.uP0, p0[0], p0[1]);
  gl.uniform2f(paintLinearGradU.uP1, p1[0], p1[1]);
  gl.uniform2f(paintLinearGradU.uP2, p2[0], p2[1]);
  gl.uniform1i(paintLinearGradU.uExtend, p.extend | 0);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function paintRadialGradient(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, paintRadialGradProg, paintRadialGradU, coverVao } = ctx;
  if (!paintRadialGradProg) return clearOut(gl, outRT);
  const p = node.params || {};
  const c0 = p.c0 || [0, 0],
    c1 = p.c1 || [0, 0],
    r0 = p.r0 || 0,
    r1 = p.r1 || 0;
  // Translate and scale the circle data together with the sampling map. The
  // shader's quadratic thresholds then have the same meaning at every scale.
  const scale =
    Math.max(Math.abs(c1[0] - c0[0]), Math.abs(c1[1] - c0[1]), Math.abs(r0), Math.abs(r1)) || 1;
  if (
    !bindPaintMap(
      ctx,
      outRT,
      paintRadialGradProg,
      paintRadialGradU.uPaintMapX,
      paintRadialGradU.uPaintMapY,
      [c0[0], c0[1], scale],
    )
  )
    return clearOut(gl, outRT);
  if (!bindGradientStops(gl, 0, paintRadialGradProg, paintRadialGradU, ctx, node)) {
    return clearOut(gl, outRT);
  }
  gl.uniform2f(paintRadialGradU.uC0, 0, 0);
  gl.uniform2f(paintRadialGradU.uC1, (c1[0] - c0[0]) / scale, (c1[1] - c0[1]) / scale);
  gl.uniform1f(paintRadialGradU.uR0, r0 / scale);
  gl.uniform1f(paintRadialGradU.uR1, r1 / scale);
  gl.uniform1i(paintRadialGradU.uExtend, p.extend | 0);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function paintSweepGradient(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, paintSweepGradProg, paintSweepGradU, coverVao } = ctx;
  if (!paintSweepGradProg) return clearOut(gl, outRT);
  const p = node.params || {};
  if (
    !bindPaintMap(
      ctx,
      outRT,
      paintSweepGradProg,
      paintSweepGradU.uPaintMapX,
      paintSweepGradU.uPaintMapY,
    )
  )
    return clearOut(gl, outRT);
  if (!bindGradientStops(gl, 0, paintSweepGradProg, paintSweepGradU, ctx, node)) {
    return clearOut(gl, outRT);
  }
  const center = p.center || [0, 0];
  gl.uniform2f(paintSweepGradU.uCenter, center[0], center[1]);
  // `??`: an end angle of 0 is a real COLRv1 sweep bound (F2Dot14 -1.0), not an absent one.
  gl.uniform1f(paintSweepGradU.uStartAngle, p.startAngle ?? 0);
  gl.uniform1f(paintSweepGradU.uEndAngle, p.endAngle ?? 360);
  gl.uniform1i(paintSweepGradU.uExtend, p.extend | 0);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

// Evaluate transformed generators in their analytic coordinates. Their input
// region may be outside the canvas or much larger than any render target.
function transformedGenerator(nodeIdx, node, outRT, ctx) {
  const nodes = ctx._paintNodes;
  if (!nodes) return false;
  let leaf = node,
    index = nodeIdx,
    transform = AFF_ID;
  while (leaf.type === 'PaintTransform') {
    const input = leaf.inputs[0];
    if (leaf.inputs.length !== 1 || !(input >= 0 && input < index)) return false;
    transform = affMul(transform, leaf.params?.affine || AFF_ID);
    leaf = nodes[input];
    index = input;
    if (!leaf) return false;
  }
  let draw;
  switch (leaf.type) {
    case 'PaintSolid':
      draw = paintSolid;
      break;
    case 'PaintLinearGradient':
      draw = paintLinearGradient;
      break;
    case 'PaintRadialGradient':
      draw = paintRadialGradient;
      break;
    case 'PaintSweepGradient':
      draw = paintSweepGradient;
      break;
    default:
      return false;
  }
  const previous = ctx.paintToPx,
    placement = affMul(previous || AFF_ID, transform);
  const inverse = affInv(placement);
  if (!placement.every(Number.isFinite) || !inverse || !inverse.every(Number.isFinite)) {
    clearOut(ctx.gl, outRT);
    return true;
  }
  ctx.paintToPx = placement;
  try {
    if (draw === paintSolid) draw(leaf, [], outRT, ctx);
    else draw(index, leaf, [], outRT, ctx);
  } finally {
    ctx.paintToPx = previous;
  }
  return true;
}

function paintTransform(nodeIdx, node, inputs, outRT, ctx) {
  if (transformedGenerator(nodeIdx, node, outRT, ctx)) return;
  const { gl, pool, paintTransformProg, paintTransformU, coverVao } = ctx;
  if (!paintTransformProg || inputs.length === 0 || inputs[0].kind !== 'rt') {
    return clearOut(gl, outRT);
  }
  const inRT = pool.get(inputs[0].idx);
  // The affine is in PAINT space; the shader works in canvas px, so it gets T·M·T⁻¹.
  const aff = pxAffine(ctx, (node.params && node.params.affine) || [1, 0, 0, 1, 0, 0]);
  if (!aff) return clearOut(gl, outRT);
  // Each target's vUV -> canvas px, as (origin, size): the shader's q = origin + vUV * size. The size is
  // negative in y -- vUV is y up, canvas px y down -- which the shader's divide undoes exactly.
  const o = pxOfUV(ctx, outRT),
    i = pxOfUV(ctx, inRT);
  gl.useProgram(paintTransformProg);
  gl.uniform1i(paintTransformU.uIn, 0);
  gl.uniform2f(paintTransformU.uBboxOutOrigin, o[4], o[5]);
  gl.uniform2f(paintTransformU.uBboxOutSize, o[0], o[3]);
  gl.uniform2f(paintTransformU.uBboxInOrigin, i[4], i[5]);
  gl.uniform2f(paintTransformU.uBboxInSize, i[0], i[3]);

  gl.uniform4f(paintTransformU.uMRow0, aff[0], aff[2], aff[4], 0);
  gl.uniform4f(paintTransformU.uMRow1, aff[1], aff[3], aff[5], 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, inRT.tex);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

/// PaintGlyph — clip the (single) input by the referenced glyph's alpha
/// silhouette. The renderer bakes per-gid masks before evaluation; the
/// dispatch looks up the mask from ctx.glyphAlphaMasks by glyphId,
/// falling back to ctx.glyphAlphaTex (the primary silhouette).
function paintGlyph(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, pool, paintGlyphProg, paintGlyphU, coverVao } = ctx;
  if (!paintGlyphProg || inputs.length === 0 || inputs[0].kind !== 'rt') {
    return clearOut(gl, outRT);
  }
  const inRT = pool.get(inputs[0].idx);
  // Resolve the mask texture for this PaintGlyph's referenced gid.
  let maskTex = null;
  // maskKey names the silhouette when the glyph was placed by a paint transform (the same gid can appear more than once,
  // under different maps); otherwise the glyph id is the key.
  const gid =
    node.params && (node.params.maskKey != null ? node.params.maskKey : node.params.glyphId);
  if (
    ctx.glyphAlphaMasks &&
    (typeof gid === 'number' || typeof gid === 'string') &&
    ctx.glyphAlphaMasks.has(gid)
  ) {
    maskTex = ctx.glyphAlphaMasks.get(gid);
  }
  if (!maskTex) maskTex = ctx.glyphAlphaTex || null;
  if (!maskTex) {
    // No mask available — passthrough: the child's pixels, where they sit on the canvas.
    blitRect(gl, inRT.fbo, rectOfRT(inRT), outRT, ctx);
    return;
  }
  gl.useProgram(paintGlyphProg);
  gl.uniform1i(paintGlyphU.uIn, 0);
  gl.uniform1i(paintGlyphU.uMask, 1);
  // The child covers its own rect; the silhouettes are canvas-sized (ctx.w x ctx.h).
  setMap(gl, paintGlyphU.uInMap, outRT, rectOfRT(inRT));
  setMap(
    gl,
    paintGlyphU.uMaskMap,
    outRT,
    ctx.w > 0 && ctx.h > 0 ? [0, 0, ctx.w, ctx.h] : rectOfRT(outRT),
  );
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, inRT.tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

/// PaintMerge — N-input over-stack. Reuses the SVG feComposite program
/// with op=over (0). Same ping-pong as feMerge, minus source sentinels.
function paintMerge(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, pool, feCompositeProg, feCompositeU, coverVao } = ctx;
  if (!feCompositeProg || !inputs.length) return clearOut(gl, outRT);
  if (inputs.length === 1) {
    if (inputs[0].kind !== 'rt') return clearOut(gl, outRT);
    const inRT = pool.get(inputs[0].idx);
    blitRect(gl, inRT.fbo, rectOfRT(inRT), outRT, ctx);
    return;
  }
  if (inputs.some((inp) => inp.kind !== 'rt')) return clearOut(gl, outRT);
  gl.useProgram(feCompositeProg);
  gl.uniform1i(feCompositeU.uIn1, 0);
  gl.uniform1i(feCompositeU.uIn2, 1);
  gl.uniform1i(feCompositeU.uOp, 0);
  gl.uniform4f(feCompositeU.uK, 0, 0, 0, 0);
  if (feCompositeU.uPD) {
    const k = porterDuffCoefficients(3);
    gl.uniform4f(feCompositeU.uPD, k[0], k[1], k[2], k[3]);
  } // src over
  // Each input covers its own rect (see src/shaders/_filterRect.glsl): uIn1 is the layer on top, uIn2
  // what it goes over.
  const rt = (i) => pool.get(inputs[i].idx);
  setMap(gl, feCompositeU.uIn1Map, outRT, rectOfRT(rt(1)));
  setMap(gl, feCompositeU.uIn2Map, outRT, rectOfRT(rt(0)));
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, rt(1).tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, rt(0).tex);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (inputs.length > 2) {
    const sz = outRT.size;
    // The accumulator ping-pongs over the OUTPUT's rect, so it reads 1:1.
    let tmpIdx = pool.acquire(sz[0], sz[1], rectOfRT(outRT).slice());
    let tmp = pool.get(tmpIdx);
    let acc = outRT,
      scratch = tmp;
    setMap(gl, feCompositeU.uIn2Map, outRT, rectOfRT(outRT));
    for (let i = 2; i < inputs.length; i++) {
      setMap(gl, feCompositeU.uIn1Map, outRT, rectOfRT(rt(i)));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rt(i).tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      beginRT(gl, scratch);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const t = acc;
      acc = scratch;
      scratch = t;
    }
    if (acc !== outRT) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, acc.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
      gl.blitFramebuffer(0, 0, sz[0], sz[1], 0, 0, sz[0], sz[1], gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    pool.release(tmpIdx);
  }
  gl.bindVertexArray(null);
}

/// PaintComposite — COLRv1 binary composite, 28 modes (Porter-Duff
/// 0..11, Plus 12, CSS blends 13..27). Inputs are [src, dst] per the
/// COLR spec (src on top, dst the backdrop). Falls back to PaintMerge
/// (over) when the full-mode shader is unavailable.
function paintComposite(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, pool, paintCompositeProg, paintCompositeU, coverVao } = ctx;
  if (!paintCompositeProg || inputs.length < 2) {
    return paintMerge(nodeIdx, node, inputs, outRT, ctx);
  }
  const mode = (node.params && node.params.mode) | 0;
  const srcRT = inputs[0].kind === 'rt' ? pool.get(inputs[0].idx) : null;
  const dstRT = inputs[1].kind === 'rt' ? pool.get(inputs[1].idx) : null;
  if (!srcRT || !dstRT) return clearOut(gl, outRT);
  const srcTex = srcRT.tex,
    dstTex = dstRT.tex;
  gl.useProgram(paintCompositeProg);
  gl.uniform1i(paintCompositeU.uSrc, 0);
  gl.uniform1i(paintCompositeU.uDst, 1);
  gl.uniform1i(paintCompositeU.uMode, mode);
  setMap(gl, paintCompositeU.uSrcMap, outRT, rectOfRT(srcRT)); // each input covers its own rect
  setMap(gl, paintCompositeU.uDstMap, outRT, rectOfRT(dstRT));
  const pd = porterDuffCoefficients(mode); // the Porter-Duff weights, per draw
  if (paintCompositeU.uPD) gl.uniform4f(paintCompositeU.uPD, pd[0], pd[1], pd[2], pd[3]);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, dstTex);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerColrPaint('PaintSolid', (node, inputs, outRT, ctx) => paintSolid(node, inputs, outRT, ctx));
registerColrPaint('PaintLinearGradient', withIdx(paintLinearGradient));
registerColrPaint('PaintRadialGradient', withIdx(paintRadialGradient));
registerColrPaint('PaintSweepGradient', withIdx(paintSweepGradient));
registerColrPaint('PaintTransform', withIdx(paintTransform));
registerColrPaint('PaintGlyph', withIdx(paintGlyph));
registerColrPaint('PaintMerge', withIdx(paintMerge));
registerColrPaint('PaintComposite', withIdx(paintComposite));

export {
  paintSolid,
  paintLinearGradient,
  paintRadialGradient,
  paintSweepGradient,
  paintTransform,
  paintGlyph,
  paintMerge,
  paintComposite,
};
