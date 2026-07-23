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

// ── Rect addressing ───────────────────────────────────────────────
//
// Every filter RT covers a RECT of the canvas: [x, y, w, h] in GL framebuffer
// pixels (origin bottom-left), always 1:1 with canvas pixels. A pass may crop
// or translate its output; nothing in a filter graph rescales. An input's uv is
// therefore an affine remap of the output's vUV — see _filterRect.glsl for the
// derivation and for why sampling an input AT vUV is the bug that made a
// quantized RT pool silently resample every pass.

/// The canvas rect an RT covers. A pool RT carries `.rect`; the sentinel
/// sources (SourceGraphic / BackgroundImage / …) are always canvas-sized.
export function rectOfRT(rt) {
  return rt.rect || [0, 0, rt.size[0], rt.size[1]];
}
export function rectOf(input, ctx) {
  if (input.kind === 'rt') return rectOfRT(ctx.pool.get(input.idx));
  // The sentinel sources carry their own rects: SourceGraphic is rendered into an RT
  // covering only the shape, and the backdrop is snapshotted only where the filter
  // composites. Both fall back to the canvas.
  const rt = (input.tag === SRC_BACKGROUND || input.tag === SRC_BACKGROUND_A)
    ? ctx.mainCopyRT : ctx.sourceRT;
  return (rt && rt.rect) || [0, 0, ctx.w, ctx.h];
}

/// vUV (0..1 across `outR`) → uv in `inR`, as the vec4 the shaders take:
/// (scale.xy, bias.xy). Identity (1, 1, 0, 0) when the rects coincide.
export function mapFor(outR, inR) {
  return [
    outR[2] / inR[2], outR[3] / inR[3],
    (outR[0] - inR[0]) / inR[2], (outR[1] - inR[1]) / inR[3],
  ];
}

/// Upload the vUV→input-uv map for one sampler. `loc` may be null on a lean
/// build whose shader dropped the uniform.
export function setInMap(gl, loc, input, outRT, ctx) {
  setMapRect(gl, loc, outRT, rectOf(input, ctx));
}
/// Same, for an input the handler holds directly rather than as a graph input
/// (a multi-pass primitive's own scratch RT).
export function setMapRect(gl, loc, outRT, inR) {
  if (!loc) return;
  const m = mapFor(rectOfRT(outRT), inR);
  gl.uniform4f(loc, m[0], m[1], m[2], m[3]);
}

/// One canvas pixel expressed in an input's uv — what every kernel pass
/// (blur taps, sobel, morphology) steps by. This is `uTexel`, and it is 1 /
/// the INPUT's size, never 1 / the viewport's.
export function texelOf(input, ctx) {
  const r = rectOf(input, ctx);
  return [1 / r[2], 1 / r[3]];
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
  blitRect(gl, inFbo, rectOf(input, ctx), outRT, ctx);
}

/// Copy the overlapping canvas region of `inFbo` (covering `inR`) into `outRT`.
/// Both are 1:1 with canvas pixels, so this is a straight translated blit — the
/// pixels land where they belong in canvas space regardless of either rect.
/// Anything of `outRT` the input doesn't reach stays as the pool left it
/// (transparent: evaluateGraph clears on acquire).
export function blitRect(gl, inFbo, inR, outRT, ctx) {
  void ctx;
  const outR = rectOfRT(outRT);
  const x0 = Math.max(inR[0], outR[0]), y0 = Math.max(inR[1], outR[1]);
  const x1 = Math.min(inR[0] + inR[2], outR[0] + outR[2]);
  const y1 = Math.min(inR[1] + inR[3], outR[1] + outR[3]);
  if (x1 <= x0 || y1 <= y0) return;   // rects don't meet
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inFbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
  gl.blitFramebuffer(
    x0 - inR[0],  y0 - inR[1],  x1 - inR[0],  y1 - inR[1],
    x0 - outR[0], y0 - outR[1], x1 - outR[0], y1 - outR[1],
    gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}
