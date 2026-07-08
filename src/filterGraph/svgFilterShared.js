// svgFilterShared.js — helpers shared by every SVG <fe*> primitive
// handler. Each primitive lives in its own module
// (filterGraph/primitives/*.js) so it tree-shakes individually: a
// primitive a consumer never imports never registers.
//
// All handlers receive (node, inputs, outRT, ctx).

import {
  SRC_GRAPHIC, SRC_ALPHA, SRC_BACKGROUND, SRC_BACKGROUND_A,
  SRC_FILL_PAINT, SRC_STROKE_PAINT,
} from './filterGraph.js';

/// Resolve an input descriptor to a concrete WebGL texture for sampling.
/// Returns null if the input is a paint (solid color) — the caller is
/// expected to handle that case by reading ctx.fillPaint / strokePaint
/// directly rather than sampling a texture.
export function resolveInputTex(input, pool, ctx) {
  if (input.kind === 'rt') return pool.get(input.idx).tex;
  switch (input.tag) {
    case SRC_GRAPHIC:      return ctx.sourceRT.tex;
    case SRC_ALPHA:        return ctx.sourceRT.tex;  // alpha channel only; handlers mask RGB
    case SRC_BACKGROUND:   return ctx.mainCopyRT ? ctx.mainCopyRT.tex : null;
    case SRC_BACKGROUND_A: return ctx.mainCopyRT ? ctx.mainCopyRT.tex : null;
    case SRC_FILL_PAINT:
    case SRC_STROKE_PAINT: return null;
    default: return null;
  }
}

/// Whether a sentinel input wants the alpha-channel-only treatment
/// (SourceAlpha and BackgroundAlpha).
export function isAlphaOnly(input) {
  if (input.kind !== 'source') return false;
  return input.tag === SRC_ALPHA || input.tag === SRC_BACKGROUND_A;
}

/// Bind the cover quad + viewport + state for a screen-space pass.
/// All handlers run this before drawing.
export function beginFullscreen(gl, outRT) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);
}

/// Clear outRT to transparent black. The "no source / no shader" fallback
/// every handler shares (spec behavior when an input fails to resolve).
export function clearTransparent(gl, outRT) {
  beginFullscreen(gl, outRT);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/// Copy `input` straight to outRT (blit). Used when a primitive's shader
/// is unavailable or its parameters reduce to identity.
export function passthrough(gl, input, outRT, ctx) {
  const inFbo = (input.kind === 'rt')
    ? ctx.pool.get(input.idx).fbo
    : (input.tag === SRC_GRAPHIC ? ctx.sourceRT.fbo
      : (input.tag === SRC_BACKGROUND && ctx.mainCopyRT) ? ctx.mainCopyRT.fbo
      : null);
  if (!inFbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
    gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inFbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
  const [w, h] = outRT.size;
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}
