// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgFilterShared.js — helpers shared by every SVG <fe*> primitive
// handler. Each primitive lives in its own module
// (filterGraph/primitives/*.js) so it tree-shakes individually: a
// primitive a consumer never imports never registers.
//
// All handlers receive (node, inputs, outRT, ctx).

import {
  SRC_GRAPHIC,
  SRC_ALPHA,
  SRC_BACKGROUND,
  SRC_BACKGROUND_A,
  SRC_FILL_PAINT,
  SRC_STROKE_PAINT,
  applyKeepScissor,
  endKeepScissor,
} from './filterGraph.js';
import { noteExternalGlWrite } from '../core/glEpoch.js';
import { inMode } from './colorSpace.js';

const NO_PAINT = Object.freeze([0, 0, 0, 0]);

/** Whether this input names a solid owner paint supplied by the graph context. An owner paint with nothing to draw (none on the graph, a
 *  paint server this build cannot draw, a gradient whose frame is unknown) reads as transparent, so a pass never samples a missing texture. */
export function solidPaintOf(input, ctx) {
  if (input.kind !== 'source' || (input.tag !== SRC_FILL_PAINT && input.tag !== SRC_STROKE_PAINT))
    return null;
  const paint = input.tag === SRC_FILL_PAINT ? ctx.fillPaint : ctx.strokePaint;
  if ((Array.isArray(paint) || ArrayBuffer.isView(paint)) && paint.length >= 4) return paint;
  return gradientPaintOf(input, ctx) ? null : NO_PAINT;
}

/// The gradient owner paint a FillPaint / StrokePaint input names (svg/filterOwnerPaint.js: a placed gradient record), or null: a solid paint
/// (solidPaintOf), a paint server this build cannot draw, and a record whose frame is not known all take the non-gradient path.
export function gradientPaintOf(input, ctx) {
  if (input.kind !== 'source' || !ctx.ownerPaint) return null;
  const paint =
    input.tag === SRC_FILL_PAINT
      ? ctx.fillPaint
      : input.tag === SRC_STROKE_PAINT
        ? ctx.strokePaint
        : null;
  return paint && paint.kind === 'gradient' && paint.gradientId > 0 && paint.frameKnown
    ? paint
    : null;
}

/// Acquire a target in the requested color space and restore the pool's allocation mode.
function acquireIn(pool, linear, w, h, rect, overwrite) {
  const previous = pool.setLinear ? pool.setLinear(linear) : false;
  try {
    return pool.acquire(w, h, rect, overwrite);
  } finally {
    if (pool.setLinear) pool.setLinear(previous);
  }
}

/// The gradient painted into a pool target covering ctx.ownerPaint.rect(): the filter region plus what the graph reads past it, within the
/// canvas. Once per evaluation and role; the target goes back with the solid-paint ones when the evaluation ends.
function gradientPaintRT(pool, ctx, input) {
  const paint = gradientPaintOf(input, ctx);
  if (!paint) return null;
  const cache = ctx._solidPaintRTs || (ctx._solidPaintRTs = Object.create(null));
  if (cache[input.tag] !== undefined) return cache[input.tag];
  const rect = ctx.ownerPaint.rect();
  const index = acquireIn(pool, false, rect[2], rect[3], rect.slice(), true),
    rt = pool.get(index);
  (ctx._solidPaintRTIdx || (ctx._solidPaintRTIdx = [])).push(index);
  endKeepScissor(ctx.gl);
  if (!ctx.ownerPaint.draw(paint, rt)) clearTransparent(ctx.gl, rt); // no program / texture / placement: transparent, as before
  cache[input.tag] = rt;
  return rt;
}

function solidPaintTex(pool, ctx, input) {
  const rgba = solidPaintOf(input, ctx);
  if (!rgba) return null;
  const cache = ctx._solidPaintRTs || (ctx._solidPaintRTs = Object.create(null));
  if (cache[input.tag]) return cache[input.tag].tex;
  const index = acquireIn(pool, false, 1, 1, [0, 0, 1, 1]),
    rt = pool.get(index),
    gl = ctx.gl;
  beginFullscreen(gl, rt);
  gl.clearColor(rgba[0] * rgba[3], rgba[1] * rgba[3], rgba[2] * rgba[3], rgba[3]);
  gl.clear(gl.COLOR_BUFFER_BIT);
  cache[input.tag] = rt;
  (ctx._solidPaintRTIdx || (ctx._solidPaintRTIdx = [])).push(index);
  return rt.tex;
}

/** Resolve a graph input to a concrete texture. Solid paint sources use a constant sampling map. */
export function resolveInputTex(input, pool, ctx) {
  if (input.kind === 'rt') return pool.get(input.idx).tex;
  switch (input.tag) {
    case SRC_GRAPHIC:
      return ctx.sourceRT.tex;
    case SRC_ALPHA:
      return alphaTexOf(pool, ctx, ctx.sourceRT, 'src');
    case SRC_BACKGROUND:
      return ctx.mainCopyRT ? ctx.mainCopyRT.tex : null;
    case SRC_BACKGROUND_A:
      return alphaTexOf(pool, ctx, ctx.mainCopyRT, 'bg');
    case SRC_FILL_PAINT:
    case SRC_STROKE_PAINT: {
      const solid = solidPaintTex(pool, ctx, input);
      if (solid) return solid;
      const grad = gradientPaintRT(pool, ctx, input);
      return grad ? grad.tex : null;
    }
    default:
      return null;
  }
}

/// SourceAlpha / BackgroundAlpha, materialised as a real texture.

/// Doing it here rather than in each primitive means one implementation
/// instead of fifteen shader edits, and it cannot be forgotten by a
/// primitive added later. The copy is made once per graph evaluation and
/// cached on ctx; evaluateGraph returns it to the pool afterwards.
///
/// The mask is a color-masked clear rather than a shader pass: in a
/// premultiplied buffer SourceAlpha is exactly (0, 0, 0, a).
function alphaTexOf(pool, ctx, srcRT, cacheKey) {
  if (!srcRT) return null;
  const cache = ctx._alphaRTs || (ctx._alphaRTs = Object.create(null));
  if (cache[cacheKey]) return cache[cacheKey].tex;
  const gl = ctx.gl;
  const srcR = rectOfRT(srcRT);
  const idx = acquireIn(pool, false, srcRT.size[0], srcRT.size[1], srcR.slice());
  const rt = pool.get(idx);
  blitRect(gl, srcRT.fbo, srcR, rt, ctx);
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
  gl.viewport(0, 0, rt.size[0], rt.size[1]);
  gl.colorMask(true, true, true, false);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.colorMask(true, true, true, true);
  noteExternalGlWrite();
  cache[cacheKey] = rt;
  (ctx._alphaRTIdx || (ctx._alphaRTIdx = [])).push(idx);
  return rt.tex;
}

// The scratch RTs above are returned to the pool by evaluateGraph, which
// releases ctx._alphaRTIdx in its finally block. It does that inline rather
// than calling a helper here: this module already imports the SRC_* sentinels
// from filterGraph.js, and closing that into a true import cycle is how a
// swallowed ReferenceError turns into a silent fallback.
//
// They must outlive every node that samples them, so the release cannot move
// into the per-node refcount loop.

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
// derivation and for why sampling an input AT vUV would make a quantized RT
// pool silently resample every pass.

/// The canvas rect an RT covers. A pool RT carries `.rect`; the sentinel
/// sources (SourceGraphic / BackgroundImage / …) are always canvas-sized.
export function rectOfRT(rt) {
  return rt.rect || [0, 0, rt.size[0], rt.size[1]];
}
export function rectOf(input, ctx) {
  if (solidPaintOf(input, ctx)) return [0, 0, Infinity, Infinity];
  if (input.kind === 'rt') return rectOfRT(ctx.pool.get(input.idx));
  if (gradientPaintOf(input, ctx)) return ctx.ownerPaint.rect();
  // The sentinel sources carry their own rects: SourceGraphic is rendered into an RT
  // covering only the shape, and the backdrop is snapshotted only where the filter
  // composites. Both fall back to the canvas.
  const rt =
    input.tag === SRC_BACKGROUND || input.tag === SRC_BACKGROUND_A ? ctx.mainCopyRT : ctx.sourceRT;
  return (rt && rt.rect) || [0, 0, ctx.w, ctx.h];
}

/// vUV (0..1 across `outR`) → uv in `inR`, as the vec4 the shaders take:
/// (scale.xy, bias.xy). Identity (1, 1, 0, 0) when the rects coincide.
export function mapFor(outR, inR) {
  const iw = inR[2] || 1,
    ih = inR[3] || 1;
  return [outR[2] / iw, outR[3] / ih, (outR[0] - inR[0]) / iw, (outR[1] - inR[1]) / ih];
}

/// Upload the vUV→input-uv map for one sampler. `loc` may be null on a lean
/// build whose shader dropped the uniform.
export function setInMap(gl, loc, input, outRT, ctx) {
  if (solidPaintOf(input, ctx)) {
    if (loc) gl.uniform4f(loc, 0, 0, 0.5, 0.5);
    return;
  }
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
  if (solidPaintOf(input, ctx)) return [0, 0];
  const r = rectOf(input, ctx);
  return [r[2] ? 1 / r[2] : 0, r[3] ? 1 / r[3] : 0];
}

/// Bind the cover quad + viewport + state for a screen-space pass.
/// All handlers run this before drawing.
export function beginFullscreen(gl, outRT) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);
  applyKeepScissor(gl, outRT);

  noteExternalGlWrite();
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
///
/// The alpha-only sentinels are copied from the same RT as their color
/// counterparts and then have RGB masked off, which is what SourceAlpha /
/// BackgroundAlpha mean in a premultiplied buffer: (0, 0, 0, a).
///
export function passthrough(gl, input, outRT, ctx) {
  const paint = solidPaintOf(input, ctx);
  if (paint) {
    beginFullscreen(gl, outRT);
    gl.clearColor(paint[0] * paint[3], paint[1] * paint[3], paint[2] * paint[3], paint[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  const tag = input.kind === 'rt' ? 0 : input.tag;
  const gradient = gradientPaintOf(input, ctx) ? gradientPaintRT(ctx.pool, ctx, input) : null;
  const inFbo =
    input.kind === 'rt'
      ? ctx.pool.get(input.idx).fbo
      : gradient
        ? gradient.fbo
        : tag === SRC_GRAPHIC || tag === SRC_ALPHA
          ? ctx.sourceRT && ctx.sourceRT.fbo
          : (tag === SRC_BACKGROUND || tag === SRC_BACKGROUND_A) && ctx.mainCopyRT
            ? ctx.mainCopyRT.fbo
            : null;
  if (!inFbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
    gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  blitRect(gl, inFbo, rectOf(input, ctx), outRT, ctx);
  if (isAlphaOnly(input)) {
    // Clear RGB and keep A. Safe over the whole RT, not just the blitted
    // overlap: anything the blit missed is already transparent, and zeroing
    // RGB leaves it that way.
    gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
    gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
    gl.colorMask(true, true, true, false);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(true, true, true, true);
    noteExternalGlWrite();
  }
}

/// Copy the overlapping canvas region of `inFbo` (covering `inR`) into `outRT`.
/// Both are 1:1 with canvas pixels, so this is a straight translated blit — the
/// pixels land where they belong in canvas space regardless of either rect.
/// Anything of `outRT` the input doesn't reach stays as the pool left it
/// (transparent: evaluateGraph clears on acquire).
export function blitRect(gl, inFbo, inR, outRT, ctx) {
  void ctx;
  const outR = rectOfRT(outRT);
  const x0 = Math.max(inR[0], outR[0]),
    y0 = Math.max(inR[1], outR[1]);
  const x1 = Math.min(inR[0] + inR[2], outR[0] + outR[2]);
  const y1 = Math.min(inR[1] + inR[3], outR[1] + outR[3]);
  if (x1 <= x0 || y1 <= y0) return; // rects don't meet
  applyKeepScissor(gl, outRT);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inFbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
  gl.blitFramebuffer(
    x0 - inR[0],
    y0 - inR[1],
    x1 - inR[0],
    y1 - inR[1],
    x0 - outR[0],
    y0 - outR[1],
    x1 - outR[0],
    y1 - outR[1],
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

// ── Color space (colorSpace.js) ───────────────────────────────────
//
// An input tagged with another space than the one a primitive operates in is converted by the primitive's own shader where it reads
// the input once per pixel (feColorMatrix, feComponentTransfer, feBlend, feComposite and the merge that rides it, the displacement
// map). A primitive that reads an input with taps at fractional offsets (the blurs, morphology, convolution) cannot: the hardware
// interpolates between two texels BEFORE a shader sees them, and a converted average is not the average of the converted values (a
// black/white edge averages to 0.21 in linear light, 0.5 in sRGB). Those take a converted copy, made by the pass below.

/// Draw `input` converted by `mode` (1 sRGB -> linear, 2 linear -> sRGB) into `outRT`: the color-matrix shader with an identity matrix. The
/// input may be any graph input, a solid owner paint included; where the rects differ the pass maps through them as every pass does.
export function convertPass(gl, input, mode, outRT, ctx) {
  const { pool, colorMatrixProg: prog, colorMatrixU: u, coverVao } = ctx;
  if (!prog || !u || !u.uCsIn) return passthrough(gl, input, outRT, ctx); // a lean build without the color-matrix shader keeps the input's values
  const tex = resolveInputTex(input, pool, ctx);
  if (!tex) {
    clearTransparent(gl, outRT);
    return;
  }
  gl.useProgram(prog);
  gl.uniform1i(u.uTex, 0);
  if (u.uLinearZeroBorder) gl.uniform1i(u.uLinearZeroBorder, 0);
  gl.uniform1i(u.uCsIn, mode);
  if (u.uCsOut) gl.uniform1i(u.uCsOut, 0);
  setInMap(gl, u.uInMap, input, outRT, ctx);
  gl.uniform4f(u.uM0, 1, 0, 0, 0);
  gl.uniform4f(u.uM1, 0, 1, 0, 0);
  gl.uniform4f(u.uM2, 0, 0, 1, 0);
  gl.uniform4f(u.uM3, 0, 0, 0, 1);
  gl.uniform4f(u.uMOff, 0, 0, 0, 0);
  beginFullscreen(gl, outRT);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.bindVertexArray(coverVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  gl.uniform1i(u.uCsIn, 0);
}

/// `input` as a pass that needs it in another space reads it: itself when `mode` is 0, else a scratch RT (of the input's own rect) holding the
/// conversion. Returns { input, release }; call release() when the pass is done. A solid owner paint has no rect, so it stays as it is --
/// callers that cannot take it in the wrong space handle a solid paint first (they pass it through, converted, with convertPass).
export function convertedInput(input, mode, ctx) {
  if (!mode || solidPaintOf(input, ctx)) return { input, release() {} };
  const { gl, pool } = ctx;
  const from = rectOf(input, ctx),
    r = from.slice();
  if (from.keep) r.keep = from.keep;
  const idx = acquireIn(pool, mode === 1, r[2], r[3], r, !from.keep); // convertPass covers the whole RT (a conversion TO linear light is stored as such)
  convertPass(gl, input, mode, pool.get(idx), ctx);
  return {
    input: { kind: 'rt', idx },
    release() {
      pool.release(idx);
    },
  };
}

/// passthrough() for a primitive whose result is tagged with the space it operates in: the copy converts when the input is tagged otherwise.
export function passthroughCs(gl, input, outRT, ctx) {
  const mode = inMode(ctx, 0);
  if (mode) convertPass(gl, input, mode, outRT, ctx);
  else passthrough(gl, input, outRT, ctx);
}
