// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeGradientPaint.js -- the native morph's gradient channel.
//
// The WebGL morph tweens a matched shape's gradient by lerping the record slots PARAM_SLOTS of the packed gradient table and
// the stop bytes of the stop LUT (core/morphGradients.js plans both; shapeMorph.js uploads the lerp). The native scene has no
// texture to lerp, so this module reads the same plan from the composed morph sections and, per t, decodes the lerped record
// and stops into a plain description the scene writes onto a <linearGradient>/<radialGradient> of its own.
//
// A row tweens exactly when the GL morph's plan tweens it: a gradient record the plan claimed for the row (the two poses'
// gradients have the same type, no image paint on the row, the gradient is not shared with an unclaimed row). The stops tween
// only where the plan's stop slice does (both ends have the same stop count); otherwise the parameters tween and the stops hold
// the source's, as they do on the GPU.
//
// Record layout (bundle/layout.js GRAD_*; hitTest/paintSample.js is the CPU reader of it):
//   0 type (0 linear, 1 radial)  1 spread (0 pad, 1 reflect, 2 repeat)  2 units (> 0.5 objectBoundingBox)  3 radial focal dy / r
//   4..9 [m00 m10 m01 m11 tx ty]: shape (or bounding-box) point -> gradient space, gx = m00 px + m01 py + tx
//   10 stop texel offset  11 stop count (< 0: one opaque texel per stop)
//   12..15 linear x1 y1 x2 y2 | radial cx cy r (focal dx / r)
const STRIDE = 16;

/** Decode the stops of a record: [offset, r, g, b, a] with r, g, b in 0..255 and a in 0..1. */
function decodeStops(bytes, begin, count) {
  const one = count < 0,
    n = Math.abs(count),
    out = [];
  for (let k = 0; k < n; k++) {
    if (one) {
      const o = begin + k * 4;
      out.push([bytes[o + 3] / 255, bytes[o], bytes[o + 1], bytes[o + 2], 1]);
    } else {
      const c = begin + k * 8,
        o = c + 4;
      out.push([
        bytes[o] / 255 + bytes[o + 1] / 65025 + bytes[o + 2] / 16581375,
        bytes[c],
        bytes[c + 1],
        bytes[c + 2],
        bytes[c + 3] / 255,
      ]);
    }
  }
  return out;
}

/// The gradient morph of a composed morph, or null when no row of it tweens a gradient.
export function createGradientMorph(sections) {
  const a = sections._srcGradParamsF,
    b = sections._dstGradParamsF,
    plan = sections._gradParamPlan;
  if (!(a && b && a.length >= STRIDE && plan && plan.length)) return null;
  const sa = sections._srcGradStopsB,
    sb = sections._dstGradStopsB;
  const stopBegins = new Set((sections._gradStopPlan || []).map((p) => p.srcByteOffset));
  const tweened = new Map(); // record id -> the plan row
  for (const row of plan) {
    if (row.imageFrames || !row.lerpSlots || !row.lerpSlots.length) continue;
    tweened.set(row.baseF / STRIDE + 1, row);
  }
  if (!tweened.size) return null;

  const stopsOf = (id, t) => {
    const base = (id - 1) * STRIDE,
      count = Math.round(a[base + 11]),
      begin = Math.round(a[base + 10]) * 4;
    if (!count || !sa || begin < 0) return null;
    const from = decodeStops(sa, begin, count);
    if (!(sb && stopBegins.has(begin))) return from;
    const to = decodeStops(sb, begin, count);
    return from.map((s, i) => s.map((v, c) => v * (1 - t) + to[i][c] * t));
  };

  /// Whether the gradient `id` differs between the poses (a tween with nothing to move leaves the authored paint alone).
  const moves = (id) => {
    const row = tweened.get(id);
    if (!row) return false;
    const base = (id - 1) * STRIDE;
    for (const s of row.lerpSlots) if (a[base + s] !== b[base + s]) return true;
    const count = Math.round(a[base + 11]),
      begin = Math.round(a[base + 10]) * 4;
    if (count && sa && sb && stopBegins.has(begin)) {
      const n = Math.abs(count) * (count < 0 ? 4 : 8);
      for (let i = 0; i < n; i++) if (sa[begin + i] !== sb[begin + i]) return true;
    }
    return false;
  };

  /// The description of gradient `id` at t, or null where it cannot be expressed (a singular gradient-space map, no stops).
  const specAt = (id, t) => {
    const row = tweened.get(id);
    if (!row) return null;
    const base = (id - 1) * STRIDE,
      g = new Float64Array(STRIDE);
    for (let i = 0; i < STRIDE; i++) g[i] = a[base + i];
    for (const s of row.lerpSlots) g[s] = a[base + s] * (1 - t) + b[base + s] * t;
    const type = Math.round(g[0]);
    if (type !== 0 && type !== 1) return null;
    const stops = stopsOf(id, t);
    if (!stops || !stops.length) return null;
    // g maps a point to gradient space; the element's gradientTransform maps gradient space to the point: the inverse.
    const det = g[4] * g[7] - g[5] * g[6];
    if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null;
    const transform = [
      g[7] / det,
      -g[5] / det,
      -g[6] / det,
      g[4] / det,
      (g[6] * g[9] - g[7] * g[8]) / det,
      (g[5] * g[8] - g[4] * g[9]) / det,
    ];
    const identity =
      g[4] === 1 && g[5] === 0 && g[6] === 0 && g[7] === 1 && g[8] === 0 && g[9] === 0;
    const spread = Math.round(g[1]);
    const out = {
      type: type === 0 ? 'linear' : 'radial',
      units: g[2] > 0.5 ? 'objectBoundingBox' : 'userSpaceOnUse',
      spread: spread === 1 ? 'reflect' : spread === 2 ? 'repeat' : 'pad',
      transform: identity ? null : transform,
      stops,
    };
    if (type === 0) Object.assign(out, { x1: g[12], y1: g[13], x2: g[14], y2: g[15] });
    else
      Object.assign(out, {
        cx: g[12],
        cy: g[13],
        r: g[14],
        fx: g[12] + g[15] * g[14],
        fy: g[13] + g[3] * g[14],
      });
    return out;
  };

  return { has: (id) => tweened.has(id), moves, specAt };
}
