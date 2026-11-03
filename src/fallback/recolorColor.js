// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// recolorColor.js — CPU recolor matching the GL fill shader's per-draw
// recolor (mantle.frag.glsl), applied to a SINGLE resolved color, in
// straight (non-premultiplied) RGBA [0,1].
//
// The WebGL fill shader runs this per fragment; the native fallback runs
// the same algebra per shape on the shape's flat fill/stroke color. For
// solid-fill artwork (the channel-encoded recolor case these effects
// target) the per-shape result equals the per-pixel result. Gradient /
// image fills are NOT recolored by this path (no single color to map) —
// the caller skips them.
//
// Pipeline order (mantle.frag.glsl main):
//   1. override tint        : c *= tint            (RGBA multiply)
//   2. channelLerp          : tint = r·primary + b·contrast;
//                             c.rgb = mix(tint, highlight, clamp(g + 1 − a))
//   3. palette LUT          : c.rgb = LUT[idx(channel)]   (discrete)
//   4. colorMatrix + offset : c = clamp(M·c + off, 0, 1)
//
// Each stage is gated on its param being present, exactly like the
// shader's coherent uniform-int branches.

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Apply the per-draw recolor chain to one straight-RGBA color.
 *
 * @param {number[]} rgba  [r,g,b,a] in [0,1] — the shape's base color
 * @param {object} p  recolor params (subset of drawOpts):
 *   @param {number[]} [p.tint] rgba multiply
 *   @param {{primary,contrast,highlight}} [p.channelLerp]
 *   @param {{entries:number[][], channel?:number}} [p.palette] discrete LUT
 *   @param {Float32Array|number[]} [p.colorMatrix] column-major mat4
 *   @param {Float32Array|number[]} [p.colorMatrixOffset] vec4
 * @returns {number[]} recolored [r,g,b,a] in [0,1]
 */
export function applyRecolor(rgba, p) {
  let r = rgba[0],
    g = rgba[1],
    b = rgba[2],
    a = rgba[3] != null ? rgba[3] : 1;

  // 1. Per-shape override tint — straight RGBA multiply.
  if (p.tint) {
    r *= p.tint[0];
    g *= p.tint[1];
    b *= p.tint[2];
    if (p.tint[3] != null) a *= p.tint[3];
  }

  // 2. Bilinear channel-lerp (unlit-vector). Consumes the
  //    channel-encoded input, so it runs before palette/matrix.
  if (p.channelLerp) {
    const pr = p.channelLerp.primary,
      co = p.channelLerp.contrast;
    const hi = p.channelLerp.highlight || [1, 1, 1, 1];
    const tr = r * pr[0] + b * co[0];
    const tg = r * pr[1] + b * co[1];
    const tb = r * pr[2] + b * co[2];
    const k = clamp01(g + (1 - a));
    r = tr + (hi[0] - tr) * k;
    g = tg + (hi[1] - tg) * k;
    b = tb + (hi[2] - tb) * k;
    // alpha unchanged (out.a = in.a)
  }

  // 3. Palette LUT — discrete index from one channel → RGB substitution.
  if (p.palette && p.palette.entries && p.palette.entries.length) {
    const ch = p.palette.channel | 0; // 0=R,1=G,2=B,3=A
    const sel = ch === 0 ? r : ch === 1 ? g : ch === 2 ? b : a;
    const size = p.palette.entries.length;
    let idx = Math.floor(sel * size);
    if (idx < 0) idx = 0;
    else if (idx >= size) idx = size - 1;
    const e = p.palette.entries[idx];
    if (e) {
      r = e[0];
      g = e[1];
      b = e[2];
    } // alpha passthrough
  }

  // 4. Color matrix (column-major mat4) + offset, clamped. out = M·in + off.
  if (p.colorMatrix) {
    const M = p.colorMatrix,
      off = p.colorMatrixOffset || [0, 0, 0, 0];
    // column-major: M[col*4 + row]; out_row = Σ_col M[col*4+row] * in_col
    const ir = r,
      ig = g,
      ib = b,
      ia = a;
    r = clamp01(M[0] * ir + M[4] * ig + M[8] * ib + M[12] * ia + off[0]);
    g = clamp01(M[1] * ir + M[5] * ig + M[9] * ib + M[13] * ia + off[1]);
    b = clamp01(M[2] * ir + M[6] * ig + M[10] * ib + M[14] * ia + off[2]);
    a = clamp01(M[3] * ir + M[7] * ig + M[11] * ib + M[15] * ia + off[3]);
  }

  return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
}

/** True if any recolor stage is active in `drawOpts`. */
export function hasRecolor(p) {
  return !!(
    p &&
    (p.tint ||
      p.channelLerp ||
      p.colorMatrix ||
      (p.palette && p.palette.entries && p.palette.entries.length))
  );
}
