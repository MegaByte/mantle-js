// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintSample.js — a mask child's paint at one point, for the hit test.
//
// A <mask> weighs each child by its paint (luminance or alpha), so whether a masked shape is visible at a point
// depends on the gradient or image a mask child is painted with, not only on its geometry. These are the render's
// samplers (_paintSample.glsl sampleGradient, _gradientHelpers.glsl sampleStopsRaw, _coverage.glsl
// sampleChildImage) at a POINT: the pixel-footprint filters there (a REPEAT seam's box, a cone edge's ramp, the
// image's mip level) answer for a pixel, and a hit test asks about a point. Degenerate gradients follow SVG rather
// than a length floor: a linear gradient whose ends coincide paints its last stop (SVG 1.1 §13.2.2), and an
// objectBoundingBox gradient on a box with no width or no height paints nothing (§7.11).
import { GRAD_FLOATS_PER_GRADIENT } from '../bundle/layout.js';

/// The bundle's gradient records and stop LUT bytes, in either bundle flavor; null when it has none.
export function gradientData(bundle) {
  if (!bundle) return null;
  const g =
    bundle.gradientFloats instanceof Float32Array
      ? bundle.gradientFloats
      : bundle.gradients && bundle.gradients.byteLength
        ? new Float32Array(bundle.gradients)
        : null;
  const s =
    bundle.gradientStopsBytes instanceof Uint8Array
      ? bundle.gradientStopsBytes
      : bundle.gradientStops && bundle.gradientStops.byteLength
        ? new Uint8Array(bundle.gradientStops)
        : null;
  return g && s ? { g, s } : null;
}

/// The bundle's image atlas (RGBA8) and its pixel size; null when it has none.
export function imageData(bundle) {
  if (!bundle) return null;
  const plane = (secondary) => {
    const data = secondary ? bundle.secondaryImageAtlas : bundle.imageAtlas;
    const dim = secondary ? bundle.secondaryImageAtlasDim : bundle.imageAtlasDim;
    return data && dim
      ? {
          px: data instanceof Uint8Array ? data : new Uint8Array(data),
          w: dim[0] | 0,
          h: dim[1] | 0,
        }
      : null;
  };
  const primary = plane(false),
    secondary = plane(true);
  return primary || secondary ? { ...(primary || { px: null, w: 0, h: 0 }), secondary } : null;
}

// Stop LUT texel i, channel c, as the texture reads it (0..1). Texel i sits at (i % W, i / W) of the
// W-wide texture (bundle/layout.js GRAD_STOPS_LUT_W), which in the flat byte array is simply texel i.
const texel = (s, i, c) => s[i * 4 + c] / 255;

/// sampleStopsRaw: straight [r, g, b, a] at t in [0, 1] (after the extend).
function sampleStops(s, t, base, count) {
  if (count === 0) return [0, 0, 0, 0];
  const one = count < 0,
    n = Math.abs(count);
  const off = (k) =>
    one
      ? texel(s, base + k, 3)
      : texel(s, base + k * 2 + 1, 0) +
        texel(s, base + k * 2 + 1, 1) / 255 +
        texel(s, base + k * 2 + 1, 2) / 65025;
  const col = (k) =>
    one
      ? [texel(s, base + k, 0), texel(s, base + k, 1), texel(s, base + k, 2), 1]
      : [
          texel(s, base + k * 2, 0),
          texel(s, base + k * 2, 1),
          texel(s, base + k * 2, 2),
          texel(s, base + k * 2, 3),
        ];
  if (n === 1) return col(0);
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (off(mid) < t) lo = mid + 1;
    else hi = mid;
  }
  const cur = col(lo),
    curOff = off(lo);
  if (lo === 0 || curOff < t) return cur;
  // Here off(lo - 1) < t <= curOff, so the bracket has a positive span even at a hard stop.
  const prev = col(lo - 1),
    prevOff = off(lo - 1);
  const k = (t - prevOff) / (curOff - prevOff);
  return [0, 1, 2, 3].map((c) => prev[c] + (cur[c] - prev[c]) * k);
}

function extend(t, spread) {
  if (spread === 2) return t - Math.floor(t); // repeat
  if (spread === 1) {
    const u = t * 0.5 - Math.floor(t * 0.5);
    return u < 0.5 ? u * 2 : (1 - u) * 2;
  } // reflect
  return Math.min(Math.max(t, 0), 1); // pad
}

/// Gradient `gid` (1-based) at em point (x, y) of a row whose bbox is bb: straight [r, g, b, a].
export function sampleGradientAt(gd, gid, x, y, bb) {
  const o = (gid - 1) * GRAD_FLOATS_PER_GRADIENT;
  if (!gd || o < 0 || o + GRAD_FLOATS_PER_GRADIENT > gd.g.length) return [0, 0, 0, 0];
  const g = gd.g;
  const type = Math.round(g[o]),
    spread = Math.round(g[o + 1]);
  let px = x,
    py = y;
  if (g[o + 2] > 0.5) {
    const w = bb[2] - bb[0],
      h = bb[3] - bb[1];
    if (!(w > 0 && h > 0)) return [0, 0, 0, 0];
    px = (x - bb[0]) / w;
    py = (y - bb[1]) / h;
  }
  const gx = g[o + 4] * px + g[o + 6] * py + g[o + 8];
  const gy = g[o + 5] * px + g[o + 7] * py + g[o + 9];
  const base = Math.round(g[o + 10]);
  const cnt = Math.round(g[o + 11]);
  const last = () => sampleStops(gd.s, 2, base, cnt);
  let t;
  if (type === 0) {
    const dx = g[o + 14] - g[o + 12],
      dy = g[o + 15] - g[o + 13];
    const dd = dx * dx + dy * dy;
    if (dd === 0) return last();
    t = ((gx - g[o + 12]) * dx + (gy - g[o + 13]) * dy) / dd;
  } else {
    const cx = g[o + 12],
      cy = g[o + 13],
      r = g[o + 14];
    if (r === 0) return last();
    const fx = cx + g[o + 15] * r,
      fy = cy + g[o + 3] * r;
    const dx = gx - fx,
      dy = gy - fy,
      cfx = cx - fx,
      cfy = cy - fy;
    const A = dx * dx + dy * dy,
      B = 2 * (cfx * dx + cfy * dy),
      C = cfx * cfx + cfy * cfy - r * r;
    const disc = B * B - 4 * A * C;
    if (C > 0) {
      // the focus outside the circle: SVG 2's cone, the larger root with a non-negative radius; nothing outside it
      if (disc < 0) return [0, 0, 0, 0];
      t = (0.5 * B + 0.5 * Math.sqrt(disc)) / C;
      if (!(t >= 0)) return [0, 0, 0, 0];
    } else if (A === 0) {
      t = 0;
    } else if (C === 0) {
      if (!(B > 0)) return [0, 0, 0, 0];
      t = A / B;
    } else {
      if (disc < 0) return [0, 0, 0, 0];
      t = (2 * A) / (B + Math.sqrt(disc));
    }
  }
  return sampleStops(gd.s, extend(t, spread), base, cnt);
}

/// sampleChildImage at a point: the image rect (x, y, w, h) and atlas slot (atlasY, w, h, flags) of the row,
/// bilinear as the atlas texture filters (nearest under image-rendering: pixelated). [r, g, b, a], 0 outside.
export function sampleImageAt(im, x, y, rect, slot) {
  if ((Math.round(slot[3]) & 8) !== 0) im = im && im.secondary;
  if (!im || !im.px || !(im.w > 0) || !(im.h > 0) || !(rect[2] > 0) || !(rect[3] > 0))
    return [0, 0, 0, 0];
  let u = (x - rect[0]) / rect[2],
    v = (y - rect[1]) / rect[3];
  const kind = Math.round(slot[3]) & 3;
  if (kind === 1 || kind === 3) {
    const wrap = (t) =>
      kind === 1 ? t - Math.floor(t) : 1 - Math.abs((t * 0.5 - Math.floor(t * 0.5)) * 2 - 1);
    u = wrap(u);
    v = wrap(v);
  } else if (u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0, 0];
  const tx = u * slot[1],
    ty = slot[0] + v * slot[2]; // atlas texels
  const at = (ix, iy) => {
    const cx = Math.min(Math.max(ix, 0), Math.min(slot[1], im.w) - 1);
    const cy = Math.min(Math.max(iy, slot[0]), Math.min(slot[0] + slot[2], im.h) - 1);
    const b = (cy * im.w + cx) * 4;
    return [im.px[b] / 255, im.px[b + 1] / 255, im.px[b + 2] / 255, im.px[b + 3] / 255];
  };
  if ((Math.round(slot[3]) & 4) !== 0) return at(Math.floor(tx), Math.floor(ty));
  const fx = tx - 0.5,
    fy = ty - 0.5,
    x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    ax = fx - x0,
    ay = fy - y0;
  const c00 = at(x0, y0),
    c10 = at(x0 + 1, y0),
    c01 = at(x0, y0 + 1),
    c11 = at(x0 + 1, y0 + 1);
  return [0, 1, 2, 3].map(
    (c) => (c00[c] * (1 - ax) + c10[c] * ax) * (1 - ay) + (c01[c] * (1 - ax) + c11[c] * ax) * ay,
  );
}

// Premultiplied paint composition for production mask hit testing.
export function compositePaint(src, dst, mode = 0) {
  const a = src[3],
    b = dst[3];
  if (mode === 19) return src.map((v, i) => Math.min(1, v + dst[i]));
  if (mode === 20 || mode === 21) return dst.map((v) => v * (mode === 20 ? a : 1 - a));
  if (!mode) return src.map((v, i) => v + dst[i] * (1 - a));
  const s = src.slice(0, 3).map((v) => (a > 0 ? v / a : v));
  const d = dst.slice(0, 3).map((v) => (b > 0 ? v / b : v));
  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const sat = (c) => Math.max(...c) - Math.min(...c);
  const clip = (c) => {
    const l = lum(c),
      lo = Math.min(...c),
      hi = Math.max(...c);
    if (lo < 0) c = c.map((v) => l + ((v - l) * l) / (l - lo));
    if (hi > 1) c = c.map((v) => l + ((v - l) * (1 - l)) / (hi - l));
    return c;
  };
  const setLum = (c, l) => clip(c.map((v) => v + l - lum(c)));
  const setSat = (c, value) => {
    const lo = Math.min(...c),
      range = sat(c);
    return range > 0 ? c.map((v) => ((v - lo) * value) / range) : [0, 0, 0];
  };
  let color;
  if (mode === 12) color = setLum(setSat(s, sat(d)), lum(d));
  else if (mode === 13) color = setLum(setSat(d, sat(s)), lum(d));
  else if (mode === 14) color = setLum(s, lum(d));
  else if (mode === 15) color = setLum(d, lum(s));
  else
    color = s.map((x, i) => {
      const y = d[i];
      switch (mode) {
        case 1:
          return x * y;
        case 2:
          return x + y - x * y;
        case 3:
          return y < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y);
        case 4:
          return Math.min(x, y);
        case 5:
          return Math.max(x, y);
        case 6:
          return y <= 0 ? 0 : x >= 1 ? 1 : Math.min(1, y / Math.max(1 - x, 1e-6));
        case 7:
          return y >= 1 ? 1 : x <= 0 ? 0 : 1 - Math.min(1, (1 - y) / Math.max(x, 1e-6));
        case 8:
          return x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y);
        case 9:
          return x < 0.5
            ? y - (1 - 2 * x) * y * (1 - y)
            : y + (2 * x - 1) * ((y < 0.25 ? ((16 * y - 12) * y + 4) * y : Math.sqrt(y)) - y);
        case 10:
          return Math.abs(y - x);
        case 11:
          return x + y - 2 * x * y;
        case 16:
          return Math.min(x + y, 1);
        case 17:
          return Math.max(y - x, 0);
        case 18:
          return 1 - y;
        default:
          return x;
      }
    });
  return [...color.map((v, i) => a * ((1 - b) * s[i] + b * v) + (1 - a) * dst[i]), a + b - a * b];
}
