// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// blurKernel.js — the feGaussianBlur kernel, planned on the CPU per axis (no GL).
//
// Both blur routes use it: the filter graph (primitives/blur.js) and the single-primitive route
// (renderer/filterDraw.js blurShapeFbo). An axis is one of:

// Filter Effects 1 sets no upper bound on stdDeviation. Past BOX_MAX_PASSES boxes of the largest
// radius (sigma ~513) the blur stops widening -- the same place Gecko (500) and Skia's raster
// path (532) clamp theirs.

/// Paired taps per side the Gaussian's uniform table holds. MUST equal blur.frag.glsl's
/// BLUR_MAX_PAIRS (the table is vec4[BLUR_MAX_PAIRS / 2], two pairs per vec4).
export const BLUR_MAX_PAIRS = 128;
/// The largest radius one box pass reaches: boxBlur.frag.glsl's pair-fetch loop cap, times two.
export const BOX_MAX_RADIUS = 256;
/// The most box passes one axis takes before the blur stops widening.
export const BOX_MAX_PASSES = 12;

/// Below this an axis is left alone (the renderer's long-standing identity threshold).
const IDENTITY_SIGMA = 0.5;

const _tapCache = new Map();
const TAP_CACHE_MAX = 16;

/// The Gaussian table for `sigma` (pixels): `{ w0, count, taps }`, where `w0` is the center
/// weight, `count` the number of paired taps per side and `taps` a Float32Array of
/// (offset, weight) per pair, 2 * BLUR_MAX_PAIRS floats, zero past `count`. Weights are
/// normalized: w0 + 2 * sum(weights) = 1. Taps past the table are dropped and the rest
/// renormalized -- which only happens when a caller has no box pass to route to.
/// Memoized: an animated sigma asks for a handful of values, a static one for one.
export function gaussianTaps(sigma) {
  const hit = _tapCache.get(sigma);
  if (hit) return hit;
  const radius = Math.min(Math.ceil(3 * sigma), 2 * BLUR_MAX_PAIRS);
  const twoS2 = 2 * sigma * sigma;
  const taps = new Float32Array(2 * BLUR_MAX_PAIRS);
  let count = 0,
    sum = 1;
  for (let i0 = 1; i0 <= radius; i0 += 2) {
    const i1 = i0 + 1;
    const w0 = Math.exp(-(i0 * i0) / twoS2);
    // Past the truncation radius the second tap weighs 0 and the pair is a plain tap at i0.
    const w1 = i1 <= radius ? Math.exp(-(i1 * i1) / twoS2) : 0;
    const w = w0 + w1;
    taps[2 * count] = (i0 * w0 + i1 * w1) / w;
    taps[2 * count + 1] = w;
    sum += 2 * w;
    count++;
  }
  for (let k = 0; k < count; k++) taps[2 * k + 1] /= sum;
  const out = { w0: 1 / sum, count, taps };
  if (_tapCache.size >= TAP_CACHE_MAX) _tapCache.delete(_tapCache.keys().next().value);
  _tapCache.set(sigma, out);
  return out;
}

/// Box radii whose variances sum to sigma^2: n passes (3 unless a radius would pass
/// BOX_MAX_RADIUS), m of them at r and n - m at r + 1, m chosen for the nearest total. A centered
/// box of radius r has variance r(r + 1) / 3, so three of radius r give r(r + 1) and the split
/// lands within about a sixth of a pixel of sigma.
export function boxRadii(sigma) {
  const v = sigma * sigma;
  const rMax = BOX_MAX_RADIUS;
  let n = 3;
  while (n < BOX_MAX_PASSES && (3 * v) / n > rMax * (rMax + 1)) n++;
  const q = Math.min((3 * v) / n, rMax * (rMax + 1)); // r(r + 1) per box
  const r = Math.min(Math.floor((Math.sqrt(4 * q + 1) - 1) / 2), rMax);
  let m = n;
  if (r < rMax) {
    // Total variance with m boxes at r: [m r(r+1) + (n-m)(r+1)(r+2)] / 3 = (n (r+1)(r+2) - 2 m (r+1)) / 3.
    const target = Math.min(v, (n * rMax * (rMax + 1)) / 3);
    m = Math.round((n * (r + 1) * (r + 2) - 3 * target) / (2 * (r + 1)));
    m = Math.max(0, Math.min(n, m));
  }
  const radii = [];
  for (let i = 0; i < n; i++) radii.push(i < m ? r : r + 1);
  return radii.filter((x) => x > 0);
}

/// How one axis is blurred: null (identity), `{ gauss }` (one pass, the table above) or
/// `{ box }` (the radii, one pass each). `haveBox` false — a lean build without the box shader —
/// keeps every sigma on the Gaussian, truncated at the table's reach.
export function blurAxisPlan(sigma, haveBox) {
  if (!(sigma > IDENTITY_SIGMA)) return null;
  if (Math.ceil(3 * sigma) <= 2 * BLUR_MAX_PAIRS || !haveBox) return { gauss: gaussianTaps(sigma) };
  return { box: boxRadii(sigma) };
}

/// The passes of a separable blur, horizontal first: `[{ dir, gauss } | { dir, box: radius }]`.
/// Empty when both axes are the identity.
export function blurPasses(sigmaX, sigmaY, haveBox) {
  return blurPassesAlong(
    [
      { sigma: sigmaX, dir: [1, 0] },
      { sigma: sigmaY, dir: [0, 1] },
    ],
    haveBox,
  );
}

/// The same passes along arbitrary axes: `axes` is `[{ sigma (px), dir (unit vector, GL px) }]`, one pass
/// group per axis in order. The two axes of a blur are separable along ANY pair of directions, which is what
/// lets a blur follow a turned or skewed element's own axes (blurAxesPx).
export function blurPassesAlong(axes, haveBox) {
  const out = [];
  for (const { sigma, dir } of axes) {
    const plan = blurAxisPlan(sigma, haveBox);
    if (!plan) continue;
    if (plan.gauss) out.push({ dir, gauss: plan.gauss });
    else for (const r of plan.box) out.push({ dir, box: r });
  }
  return out;
}

/// A feGaussianBlur whose stdDeviation axes are the ELEMENT's (the importer set `p.m`, the linear part of
/// the element's CTM, only where that turns or skews them): the two axes in canvas px. `off` is the
/// renderer's user-vector -> canvas-px matrix ([dx', dy'] = [o0 x + o2 y, o1 x + o3 y], y down), the one
/// feOffset uses. Returns `{ axes: [{ sigma, dir }], rx, ry }`: the axes as blurPassesAlong takes them
/// (dir in GL space, y up) and the Gaussian's per-device-axis standard deviation (rx, ry), which is what
/// sizes the RT it spreads into.
export function blurAxesPx(p, off) {
  const m = p.m;
  const sx = Math.max(0, p.sigmaX || 0),
    sy = Math.max(0, p.sigmaY || 0);
  const axes = [];
  let vx = 0,
    vy = 0;
  for (const [s, ux, uy] of [
    [sx, m[0], m[1]],
    [sy, m[2], m[3]],
  ]) {
    const dx = off[0] * ux + off[2] * uy,
      dy = off[1] * ux + off[3] * uy; // one unit of the axis, in px (y down)
    const len = Math.hypot(dx, dy),
      sigma = s * len;
    if (!(len > 0)) {
      axes.push({ sigma: 0, dir: [1, 0] });
      continue;
    }
    const dir = [dx / len, -dy / len];
    axes.push({ sigma, dir });
    vx += (sigma * dir[0]) ** 2;
    vy += (sigma * dir[1]) ** 2;
  }
  return { axes, rx: Math.sqrt(vx), ry: Math.sqrt(vy) };
}

/// The element's two user axes in canvas px: for a unit of user x and of user y, `m` = the linear part of the element's CTM (root space)
/// and `off` the renderer's user-vector -> canvas-px matrix (see blurAxesPx). `[{ len, dir }]`: the length of one unit along the axis in
/// px and its unit direction in GL space (y up).
export function userAxesPx(m, off) {
  const out = [];
  for (const [ux, uy] of [
    [m[0], m[1]],
    [m[2], m[3]],
  ]) {
    const dx = off[0] * ux + off[2] * uy,
      dy = off[1] * ux + off[3] * uy;
    const len = Math.hypot(dx, dy);
    out.push(len > 0 ? { len, dir: [dx / len, -dy / len] } : { len: 0, dir: [1, 0] });
  }
  return out;
}

/// One morph.frag.glsl pass reaches this far; the shader's loop is bounded by it.
export const MORPH_PASS_RADIUS = 64;
/// A window radius as the passes that make it. A box window of radius a over one of radius b is the box window of radius a + b, for the min
/// and the max alike, so a wide window is the same answer as several narrow ones, at any radius and any zoom. The last pass takes the
/// remainder, which the shader rounds up as it does a lone pass; a radius within one pass is that one pass. A radius past `sizePx`, the
/// target's longest side, has already reached every pixel of it from every pixel, so that bounds the passes.
export function morphRadiusPasses(r, sizePx) {
  const out = [];
  let left = Math.min(r, sizePx);
  while (left > MORPH_PASS_RADIUS) {
    out.push(MORPH_PASS_RADIUS);
    left -= MORPH_PASS_RADIUS;
  }
  out.push(left);
  return out;
}

/// A feMorphology whose radii are along the ELEMENT's axes (the importer set `p.m`): the two passes in canvas px,
/// `{ passes: [{ r, dir }], ex, ey }` -- `ex` / `ey` the window's reach on the device axes (the two boxes' extents add).
export function morphAxesPx(p, off) {
  const ax = userAxesPx(p.m, off),
    rs = [Math.max(0, p.radiusX || 0), Math.max(0, p.radiusY || 0)];
  const passes = ax.map((a, i) => ({ r: rs[i] * a.len, dir: a.dir }));
  return {
    passes,
    ex: passes.reduce((s, q) => s + q.r * Math.abs(q.dir[0]), 0),
    ey: passes.reduce((s, q) => s + q.r * Math.abs(q.dir[1]), 0),
  };
}

/// Upload a Gaussian table to blur.frag.glsl: `u` carries uW0, uTapCount and uTaps.
export function setGaussTaps(gl, u, g) {
  gl.uniform1f(u.uW0, g.w0);
  gl.uniform1i(u.uTapCount, g.count);
  // Two pairs per vec4; only the vec4s the loop reads.
  const n = Math.ceil(g.count / 2) * 4;
  if (n) gl.uniform4fv(u.uTaps, g.taps, 0, n);
}
