// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// viewCull.js — trim the unified fill draw to the on-screen span.
//
// WHY. LB's per-fragment slope is ~0, so the vertex budget
// IS the perf budget. A cover quad that lands off-screen
// is already free — the rasterizer clips it before any fragment work — but its
// VERTICES still run the vertex shader, and an LB vert is lbVertexSetup plus meta
// and override texelFetches. On scrolling content most of the stream is off-screen
// and every vertex of it is paid for.
//
// TRIM-only, AND THAT IS THE whole DESIGN. The obvious version of this pass drops
// every off-screen entry, which fragments one drawArrays into many. That trade is
// backwards here: the route's cost is per-draw fixed cost plus vertices, so paying
// N draws to save vertices loses. This pass therefore only ever NARROWS the single
// draw to the range between the first and last visible entry — the run count is 1
// by construction.

import {
  META_BBOX_XMIN,
  META_BBOX_YMIN,
  META_BBOX_XMAX,
  META_BBOX_YMAX,
  META_STROKE_W,
  META_JOIN_STYLE,
  META_MITER_LIMIT,
  META_FLAGS_SHAPE,
  META_FILTER_ID,
} from '../bundle/layout.js';
import { strokeReachFactor } from '../bundle/strokeReach.js';

// Vector-effect bits in META_FLAGS_SHAPE. Each one cancels part of the world
// matrix for that shape inside the vertex shader (mantle.vert.glsl), so this
// pass's em→NDC mirror does not describe where the shape actually lands.
const VE_MASK = 1024 | 2048 | 4096; // non-scaling-size | non-rotation | fixed-position

// Slack on the NDC accept box, in device pixels. Covers every dilation applied
// downstream of the bbox this pass reads: the cover quad's half-pixel outward
// push, the LB curve rings' 1.5px extrusion, and fp slack in the mirror itself.
// Expressed in PIXELS and converted to NDC per draw, so it stays a fixed on-screen
// margin under any world-matrix scale — an em-space margin would starve as the
// bundle is scaled up, which is precisely when the trim is worth the most.
const MARGIN_PX = 4;

/// Does any shape in this bundle make the em→NDC mirror unsound? A vector-effect
/// shape has part of the world matrix canceled per-shape, and a 9-sliced bundle
/// rasterizes from a rewritten em coord the meta bbox no longer describes.
///
/// Only the O(numShapes) flag scan is memoised — flagsShape is baked, so it cannot
/// change. `_nineSliceActive` is read LIVE every call because applyNineSlice stamps
/// it at draw time, possibly after this pass has already run once: caching it
/// would let a bundle that became 9-sliced keep a stale "safe" verdict, which is
/// the staleness class that already bit occlusionCull.
function cullUnsafe(bundle) {
  if (bundle._nineSliceActive) return true;
  if (bundle._viewCullVE !== undefined) return bundle._viewCullVE;
  let ve = false;
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0;
  if (meta && stride > META_FLAGS_SHAPE) {
    const n = bundle.numShapes | 0;
    for (let s = 0; s < n; s++) {
      if (((meta[s * stride + META_FLAGS_SHAPE] + 0.5) | 0) & VE_MASK) {
        ve = true;
        break;
      }
    }
  }
  bundle._viewCullVE = ve;
  return ve;
}

/// The visible sub-span of the unified fill stream, as { first, count } in VERTICES.
///
/// Returns null when the pass does not apply or would save nothing — the caller then
/// draws the whole stream exactly as it did before. Returns count 0 when the bundle
/// is entirely off-screen, which is a legitimate "draw nothing".
///
/// A morph draw never trims: each row's box here is its SOURCE-pose box (the merged meta keeps the source's), and the row moves between poses, so a
/// row outside the canvas now can be inside it at another t.
///
/// @param {import('./rendererContext.js').RendererContext} R
/// @param {boolean} [isMorph]
export function visibleTrimSpan(R, bundle, cache, isMorph) {
  if (isMorph) return null;
  if (R.opts.viewCull === false) return null;
  if (!cache || !cache.spanV || !cache.spanN || !cache.spanS) return null;
  const spanV = cache.spanV,
    spanN = cache.spanN,
    spanS = cache.spanS;
  const nE = spanN.length;
  if (nE < 2) return null;
  const gbb = bundle.globalBBox;
  if (!gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) return null;
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0;
  if (!meta || stride <= META_MITER_LIMIT) return null;
  if (cullUnsafe(bundle)) return null;

  const wm = R.draw && R.draw.worldM;
  // A projective world matrix divides by a varying w; this mirror assumes affine.
  // (Column-major mat3: the bottom row is wm[2], wm[5], wm[8].)
  if (wm && (wm[2] !== 0 || wm[5] !== 0 || wm[8] !== 1)) return null;

  //
  const ov = (R.draw && R.draw.overrides) || null;
  const ovLive = !!(ov && ov.uploadIfDirty);
  const ovP = ovLive ? ov.packedBuffer || null : null;
  const ovFps = ovP ? (ov.texelsPerShape | 0) * 4 : 0;

  if (ovLive && (!ovP || ovFps <= 0)) return null;

  const [cw, ch] = R.viewportSize();
  if (!(cw > 0) || !(ch > 0)) return null;
  const [arX, arY] = R.arScale(gbb, cw, ch);
  const mx = 1 + (2 * MARGIN_PX) / cw,
    my = 1 + (2 * MARGIN_PX) / ch;

  // em → uv → plane → worldM → NDC, mirroring mantle.vert.glsl's main().
  const sxE = (2 * arX) / gbb[2],
    txE = -arX - (2 * gbb[0] * arX) / gbb[2];
  const syE = (2 * arY) / gbb[3],
    tyE = -arY - (2 * gbb[1] * arY) / gbb[3];

  /// Is entry `i`'s shape possibly on screen? Conservative: any doubt answers yes.
  const visible = (i) => {
    if (spanN[i] <= 0) return false;
    const s = spanS[i],
      b = s * stride;
    let m00 = 1,
      m01 = 0,
      m10 = 0,
      m11 = 1,
      otx = 0,
      oty = 0;
    if (ovP) {
      const o = s * ovFps;
      if (o + 8 > ovP.length) return true; // short table: cannot prove hidden
      if (!(ovP[o + 6] > 0)) return false; // visibility 0 — the vert collapses anyway
      m00 = ovP[o + 0];
      m01 = ovP[o + 1];
      m10 = ovP[o + 2];
      m11 = ovP[o + 3];
      otx = ovP[o + 4];
      oty = ovP[o + 5];
    }
    // A FILTERED shape paints beyond its own box (a blur's halo, an offset's shadow, a displacement), and the filter frame draws that
    // part into the canvas even when the shape itself lies outside it. Its reach is not known here: keep it.
    if (Math.round(meta[b + META_FILTER_ID]) > 0) return true;
    // Dilate the path-tight bbox by the stroke envelope. A miter join reaches
    // miterLimit half-widths past the path, which is the bound the stroke shader
    // itself honors, so use it rather than the half-width alone. A clipped miter's corners
    // reach a little past that (bundle/strokeReach.js), so take the larger.
    let width = meta[b + META_STROKE_W] || 0;
    const ob = s * ovFps;
    if (ovP && ob + 23 < ovP.length && Math.round(ovP[ob + 7]) & 4) width = ovP[ob + 20];
    const flags = Math.round(meta[b + META_FLAGS_SHAPE]);
    if (flags & (1 | 8192 | 16384)) {
      const w0 = wm ? wm[0] : 1,
        w1 = wm ? wm[1] : 0,
        w3 = wm ? wm[3] : 0,
        w4 = wm ? wm[4] : 1;
      const a = (w0 * sxE * m00 - w3 * syE * m10) * cw * 0.5,
        b0 = (w0 * sxE * m01 - w3 * syE * m11) * cw * 0.5;
      const c = (w1 * sxE * m00 - w4 * syE * m10) * ch * 0.5,
        d = (w1 * sxE * m01 - w4 * syE * m11) * ch * 0.5,
        det = Math.abs(a * d - b0 * c);
      if (!(det > 0)) return true;
      const x = (Math.abs(d) + Math.abs(b0)) / det,
        y = (Math.abs(c) + Math.abs(a)) / det;
      const h = (flags & 8192) !== 0,
        v = (flags & 16384) !== 0;
      width *= h && !v ? x : v && !h ? y : (x + y) * 0.5;
    }
    const hw = width * 0.5;
    const pad =
      hw > 0
        ? hw *
          Math.max(
            meta[b + META_MITER_LIMIT] || 1,
            1,
            strokeReachFactor(meta[b + META_JOIN_STYLE], meta[b + META_MITER_LIMIT] || 1),
          )
        : 0;
    const x0 = meta[b + META_BBOX_XMIN] - pad,
      y0 = meta[b + META_BBOX_YMIN] - pad;
    const x1 = meta[b + META_BBOX_XMAX] + pad,
      y1 = meta[b + META_BBOX_YMAX] + pad;
    if (!(x1 >= x0) || !(y1 >= y0)) return true; // degenerate/NaN bbox — keep it
    let lo = 1e30,
      hi = -1e30,
      lo2 = 1e30,
      hi2 = -1e30;
    for (let c = 0; c < 4; c++) {
      const ex = c === 1 || c === 2 ? x1 : x0;
      const ey = c >= 2 ? y1 : y0;
      // Override basis is em-space and applies before the projection.
      const ax = m00 * ex + m01 * ey + otx,
        ay = m10 * ex + m11 * ey + oty;
      const px = sxE * ax + txE,
        py = -(syE * ay + tyE);
      const nx = wm ? wm[0] * px + wm[3] * py + wm[6] : px;
      const ny = wm ? wm[1] * px + wm[4] * py + wm[7] : py;
      if (nx < lo) lo = nx;
      if (nx > hi) hi = nx;
      if (ny < lo2) lo2 = ny;
      if (ny > hi2) hi2 = ny;
    }
    if (!(lo === lo) || !(lo2 === lo2)) return true; // NaN anywhere — keep it
    return !(hi < -mx || lo > mx || hi2 < -my || lo2 > my);
  };

  let first = -1;
  for (let i = 0; i < nE; i++) {
    if (visible(i)) {
      first = i;
      break;
    }
  }
  if (first < 0) return { first: 0, count: 0 }; // nothing on screen
  let last = first;
  for (let i = nE - 1; i > first; i--) {
    if (visible(i)) {
      last = i;
      break;
    }
  }

  // Clamp to the stream. The walk's batching relies on consecutive spans abutting,
  // but this pass must not be the thing that turns a malformed cache into an
  // out-of-range drawArrays, so bound the range by the stream it indexes into.
  const total = cache.vertexCount | 0;
  const vFirst = Math.max(0, Math.min(spanV[first], total));
  const vEnd = Math.max(vFirst, Math.min(spanV[last] + spanN[last], total));
  if (vFirst <= 0 && vEnd >= total) return null; // nothing trimmed
  return { first: vFirst, count: vEnd - vFirst };
}
