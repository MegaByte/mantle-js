// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// core/gradientStops.js — the gradient stop-LUT packer (the `gradientStops` section).
//
// One writer for every gradient that reaches uGradientStops: SVG gradients (svg/gradient.js
// buildGradientTables), COLRv1 text gradients (font/textColrEmit.js) and the COLR dispatch's
// inline-stop test path (filterGraph/colr/colrPaintShared.js). The layout is bundle/layout.js's
// GRAD_STOPS_* contract and _gradientHelpers.glsl's sampleStopsRaw reads it.
//
// Pure JS, no DOM, no GL: the renderer-side consumers import it without the SVG parser.

import { GRAD_STOPS_MAX, GRAD_STOPS_ONE_TEXEL_MAX } from '../bundle/layout.js';
import { mantleWarn } from './diagnostics.js';

/// A gradient's stops as the LUT holds them: sorted by offset, with sentinel
/// stops at 0 and 1 so PAD (the most common mode) needs no special case for
/// t < first.offset, and cut to GRAD_STOPS_MAX (the shader's search reaches no
/// further). A missing or empty list is two transparent stops.
function normalizeStops(stops) {
  let out =
    stops && stops.length
      ? stops.slice().sort((a, b) => a.offset - b.offset)
      : [
          { offset: 0, color: [0, 0, 0, 0] },
          { offset: 1, color: [0, 0, 0, 0] },
        ];
  if (out[0].offset > 0) out = [{ offset: 0, color: out[0].color }].concat(out);
  if (out[out.length - 1].offset < 1) out.push({ offset: 1, color: out[out.length - 1].color });
  if (out.length > GRAD_STOPS_MAX) {
    mantleWarn(
      `gradient: ${out.length} stops (sentinels included) exceed the ${GRAD_STOPS_MAX}-stop limit; ` +
        `the stops past ${GRAD_STOPS_MAX} are dropped.`,
    );
    out = out.slice(0, GRAD_STOPS_MAX);
  }
  return out;
}

const q255 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
const isOpaqueList = (stops) => stops.every((s) => Math.round((s.color[3] ?? 1) * 255) === 255);
/// True when every offset is a whole multiple of 1/255 (to 1e-6 of a byte), i.e. an 8-bit offset places it exactly.
/// Any other offset needs the 24-bit one: 8 bits move a hard stop at 0.5 to 128/255.
const offsetsFit8Bit = (stops) =>
  stops.every((s) => {
    const v = (+s.offset || 0) * 255;
    return Math.abs(v - Math.round(v)) <= 1e-6;
  });

/// Pack normalized stops. `oneTexel` = the all-opaque fast path (1 texel/stop:
/// rgb + an 8-bit offset in alpha, implicit alpha 1); otherwise 2 texels/stop
/// (straight RGBA, then the offset texel), so per-stop alpha survives. In the
/// 2-texel layout a list of more than GRAD_STOPS_ONE_TEXEL_MAX stops carries a
/// 24-bit offset (see layout.js): 256 positions cannot place more stops than
/// that apart, and so do offsets an 8-bit one cannot place exactly (offsetsFit8Bit). A shorter list whose offsets
/// are all multiples of 1/255 keeps the 8-bit offset and packs as it always has.
function packNormalized(stops, oneTexel) {
  if (oneTexel) {
    // Opaque fast path — ONE RGBA8 texel per stop: (R, G, B, offset). Alpha is
    // implicitly 1, so premult == straight; the sampler reads .a as the offset
    // and substitutes alpha 1. Half the bytes + no separate offset texel.
    const out = new Uint8Array(stops.length * 4);
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const c = i * 4;
      out[c + 0] = q255(s.color[0]);
      out[c + 1] = q255(s.color[1]);
      out[c + 2] = q255(s.color[2]);
      out[c + 3] = q255(s.offset);
    }
    return out;
  }
  // TWO RGBA8 texels per stop (gradients with a transparent stop, or too many
  // stops for an 8-bit offset):
  //   texel A = (R, G, B, alpha)          — STRAIGHT (non-premultiplied) color.
  //   texel B = (offHi, offMid, offLo, 0) — stop position in [0,1].
  // The shader premultiplies AFTER sampling, preserving per-stop alpha;
  // straight-space interpolation matches the SVG color-interpolation default.
  const fine = stops.length > GRAD_STOPS_ONE_TEXEL_MAX || !offsetsFit8Bit(stops);
  const out = new Uint8Array(stops.length * 8);
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const c = i * 8;
    out[c + 0] = q255(s.color[0]);
    out[c + 1] = q255(s.color[1]);
    out[c + 2] = q255(s.color[2]);
    out[c + 3] = q255(s.color[3]);
    if (!fine) {
      out[c + 4] = q255(s.offset);
      continue;
    }
    // The offset in units of 1/255^3, written base 255: n = hi*255^2 + mid*255 + lo, so
    // hi/255 + mid/255^2 + lo/255^3 decodes to n/255^3, within 1/(2 * 255^3) of the offset.
    const n = Math.round(Math.max(0, Math.min(1, +s.offset || 0)) * 16581375);
    const hi = Math.floor(n / 65025),
      rem = n - hi * 65025,
      mid = Math.floor(rem / 255);
    out[c + 4] = hi;
    out[c + 5] = mid;
    out[c + 6] = rem - mid * 255;
  }
  return out;
}

/// Pack a stop list in the layout `oneTexel` names (true = one texel per stop,
/// whose offset is 8-bit whatever the count; use it only for opaque lists of at
/// most GRAD_STOPS_ONE_TEXEL_MAX stops). Stops are { offset, color: [r,g,b,a] }
/// in [0, 1].
export function packStopListAs(stops, oneTexel = false) {
  return packNormalized(normalizeStops(stops), !!oneTexel);
}

/// Pack a stop list in the layout the LUT wants for it: one texel per stop when
/// every stop is opaque, there are few enough for an 8-bit offset and each offset
/// is a multiple of 1/255, else two.
/// Returns the bytes and the SIGNED stop count the shader reads (negative = one
/// texel per stop).
export function packStopList(stops) {
  const list = normalizeStops(stops);
  const oneTexel = !!(
    stops &&
    stops.length > 0 &&
    isOpaqueList(stops) &&
    list.length <= GRAD_STOPS_ONE_TEXEL_MAX &&
    offsetsFit8Bit(list)
  );
  return { bytes: packNormalized(list, oneTexel), count: oneTexel ? -list.length : list.length };
}
