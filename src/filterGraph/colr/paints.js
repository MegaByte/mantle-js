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
  beginRT, clearOut, bindBbox, bindGradientStops, withIdx,
} from './colrPaintShared.js';

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
  bindBbox(ctx, nodeIdx, paintLinearGradProg, paintLinearGradU.uBboxOrigin, paintLinearGradU.uBboxSize);
  if (!bindGradientStops(gl, 0, paintLinearGradProg, paintLinearGradU, ctx, node)) {
    return clearOut(gl, outRT);
  }
  const p0 = p.p0 || [0, 0], p1 = p.p1 || [1, 0], p2 = p.p2 || [0, 1];
  gl.uniform2f(paintLinearGradU.uP0, p0[0], p0[1]);
  gl.uniform2f(paintLinearGradU.uP1, p1[0], p1[1]);
  gl.uniform2f(paintLinearGradU.uP2, p2[0], p2[1]);
  gl.uniform1i(paintLinearGradU.uExtend, (p.extend | 0));
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function paintRadialGradient(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, paintRadialGradProg, paintRadialGradU, coverVao } = ctx;
  if (!paintRadialGradProg) return clearOut(gl, outRT);
  const p = node.params || {};
  bindBbox(ctx, nodeIdx, paintRadialGradProg, paintRadialGradU.uBboxOrigin, paintRadialGradU.uBboxSize);
  if (!bindGradientStops(gl, 0, paintRadialGradProg, paintRadialGradU, ctx, node)) {
    return clearOut(gl, outRT);
  }
  const c0 = p.c0 || [0, 0], c1 = p.c1 || [0, 0];
  gl.uniform2f(paintRadialGradU.uC0, c0[0], c0[1]);
  gl.uniform2f(paintRadialGradU.uC1, c1[0], c1[1]);
  gl.uniform1f(paintRadialGradU.uR0, p.r0 || 0);
  gl.uniform1f(paintRadialGradU.uR1, p.r1 || 0);
  gl.uniform1i(paintRadialGradU.uExtend, (p.extend | 0));
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function paintSweepGradient(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, paintSweepGradProg, paintSweepGradU, coverVao } = ctx;
  if (!paintSweepGradProg) return clearOut(gl, outRT);
  const p = node.params || {};
  bindBbox(ctx, nodeIdx, paintSweepGradProg, paintSweepGradU.uBboxOrigin, paintSweepGradU.uBboxSize);
  if (!bindGradientStops(gl, 0, paintSweepGradProg, paintSweepGradU, ctx, node)) {
    return clearOut(gl, outRT);
  }
  const center = p.center || [0, 0];
  gl.uniform2f(paintSweepGradU.uCenter, center[0], center[1]);
  gl.uniform1f(paintSweepGradU.uStartAngle, p.startAngle || 0);
  gl.uniform1f(paintSweepGradU.uEndAngle, p.endAngle || 360);
  gl.uniform1i(paintSweepGradU.uExtend, (p.extend | 0));
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function paintTransform(nodeIdx, node, inputs, outRT, ctx) {
  const { gl, pool, paintTransformProg, paintTransformU, coverVao, bbox } = ctx;
  if (!paintTransformProg || inputs.length === 0 || inputs[0].kind !== 'rt') {
    return clearOut(gl, outRT);
  }
  const inRT = pool.get(inputs[0].idx);
  const aff = (node.params && node.params.affine) || [1, 0, 0, 1, 0, 0];
  const outB = bbox[nodeIdx] || { x: 0, y: 0, w: outRT.size[0], h: outRT.size[1] };
  const inB  = bbox[node.inputs[0]] || { x: 0, y: 0, w: inRT.size[0], h: inRT.size[1] };
  gl.useProgram(paintTransformProg);
  gl.uniform1i(paintTransformU.uIn, 0);
  gl.uniform2f(paintTransformU.uBboxOutOrigin, outB.x, outB.y);
  gl.uniform2f(paintTransformU.uBboxOutSize,   Math.max(1, outB.w), Math.max(1, outB.h));
  gl.uniform2f(paintTransformU.uBboxInOrigin,  inB.x, inB.y);
  gl.uniform2f(paintTransformU.uBboxInSize,    Math.max(1, inB.w), Math.max(1, inB.h));
  // affine = [xx, yx, xy, yy, dx, dy] in our normalised order; pack as
  //   uMRow0 = (xx, xy, dx, _),  uMRow1 = (yx, yy, dy, _)
  gl.uniform4f(paintTransformU.uMRow0, aff[0], aff[2], aff[4], 0);
  gl.uniform4f(paintTransformU.uMRow1, aff[1], aff[3], aff[5], 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inRT.tex);
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
  const gid = node.params && node.params.glyphId;
  if (ctx.glyphAlphaMasks && typeof gid === 'number' && ctx.glyphAlphaMasks.has(gid)) {
    maskTex = ctx.glyphAlphaMasks.get(gid);
  }
  if (!maskTex) maskTex = ctx.glyphAlphaTex || null;
  if (!maskTex) {
    // No mask available — passthrough via blit.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inRT.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
    const sz = outRT.size;
    gl.blitFramebuffer(0, 0, sz[0], sz[1], 0, 0, sz[0], sz[1], gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    return;
  }
  gl.useProgram(paintGlyphProg);
  gl.uniform1i(paintGlyphU.uIn, 0);
  gl.uniform1i(paintGlyphU.uMask, 1);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inRT.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex);
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
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inRT.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
    const sz = outRT.size;
    gl.blitFramebuffer(0, 0, sz[0], sz[1], 0, 0, sz[0], sz[1], gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    return;
  }
  gl.useProgram(feCompositeProg);
  gl.uniform1i(feCompositeU.uIn1, 0);
  gl.uniform1i(feCompositeU.uIn2, 1);
  gl.uniform1i(feCompositeU.uOp, 0);
  gl.uniform4f(feCompositeU.uK, 0, 0, 0, 0);
  // Every COLR RT is canvas-sized, so the vUV→uv maps the shared feComposite
  // shader takes are the identity here (see src/shaders/_filterRect.glsl) —
  // but an unset vec4 uniform is (0,0,0,0), so upload them.
  if (feCompositeU.uIn1Map) gl.uniform4f(feCompositeU.uIn1Map, 1, 1, 0, 0);
  if (feCompositeU.uIn2Map) gl.uniform4f(feCompositeU.uIn2Map, 1, 1, 0, 0);
  const tex = i => pool.get(inputs[i].idx).tex;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex(1));
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex(0));
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (inputs.length > 2) {
    const sz = outRT.size;
    let tmpIdx = pool.acquire(sz[0], sz[1]);
    let tmp = pool.get(tmpIdx);
    let acc = outRT, scratch = tmp;
    for (let i = 2; i < inputs.length; i++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex(i));
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      beginRT(gl, scratch);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const t = acc; acc = scratch; scratch = t;
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
  const srcTex = inputs[0].kind === 'rt' ? pool.get(inputs[0].idx).tex : null;
  const dstTex = inputs[1].kind === 'rt' ? pool.get(inputs[1].idx).tex : null;
  if (!srcTex || !dstTex) return clearOut(gl, outRT);
  gl.useProgram(paintCompositeProg);
  gl.uniform1i(paintCompositeU.uSrc,  0);
  gl.uniform1i(paintCompositeU.uDst,  1);
  gl.uniform1i(paintCompositeU.uMode, mode);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dstTex);
  beginRT(gl, outRT);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

registerColrPaint('PaintSolid',          (node, inputs, outRT, ctx) => paintSolid(node, inputs, outRT, ctx));
registerColrPaint('PaintLinearGradient', withIdx(paintLinearGradient));
registerColrPaint('PaintRadialGradient', withIdx(paintRadialGradient));
registerColrPaint('PaintSweepGradient',  withIdx(paintSweepGradient));
registerColrPaint('PaintTransform',      withIdx(paintTransform));
registerColrPaint('PaintGlyph',          withIdx(paintGlyph));
registerColrPaint('PaintMerge',          withIdx(paintMerge));
registerColrPaint('PaintComposite',      withIdx(paintComposite));

export {
  paintSolid, paintLinearGradient, paintRadialGradient, paintSweepGradient,
  paintTransform, paintGlyph, paintMerge, paintComposite,
};
