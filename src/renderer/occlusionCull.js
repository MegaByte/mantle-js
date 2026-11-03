// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCull.js — drop shapes that a later OPAQUE shape completely covers.
//
// WHY. A fully-occluded shape contributes nothing to the final image — except at
// its ANTIALIASED EDGE, which it does contribute, wrongly. Painter compositing
// blends each shape's coverage independently, so where an occluded shape's edge
// runs under the occluder's edge, the pixel gets the hidden shape's color
// blended in a second time:

// The error peaks at c = 0.5 and vanishes at c = 0 and 1, producing a
// one-pixel fringe of the hidden shape's color along shared edges.
//
// This is the classic CONFLATION ARTIFACT, and it is not specific to us. Skia
// documents that it avoids conflation WITHIN a path but not during COMPOSITING
// (canvas semantics require alpha compositing), and Chrome reproduces the same
// fringe on a straight shared edge. It only looks clean there on CURVED edges,
// where Chrome rasterizes multisampled — and multisampling is what actually
// dissolves conflation, because binary per-sample coverage cannot double-blend.
// MSAA is the general cure and it is the expensive one: it multiplies fill and
// bandwidth, and would mean giving up the analytic AA this renderer is built on.
//
// Culling is the cheap, targeted cure for the case that actually bites: a shape
// that is INVISIBLE anyway. It removes the conflation by removing the draw, so it
// costs less than nothing at render time. It does NOT address conflation between
// shapes that are genuinely both visible (two tiles meeting at a shared seam) —
// that still needs multisampling, and is left alone deliberately.
//
// SOUNDNESS. Culling is only valid when the occluder really covers the shape:
//   • the occluder is drawn later, is a plain opaque solid, and has no
//     clip/mask/filter/blend that could shrink or move what it paints;
//   • the occluded shape has no filter — a blur paints OUTSIDE its geometry and
//     could escape the occluder entirely;
//   • containment is verified geometrically, not assumed from bounding boxes.
//
// Containment test. Bbox containment first (cheap reject). Then sample the
// occluded shape's boundary, push each sample a hair to both sides, and for every
// nudged point that lies inside the occluded shape, require it to lie inside the
// occluder too. A point inside I but outside J proves I is not contained. The
// nudge is what makes COINCIDENT edges work: a sample sitting exactly on a shared
// boundary is ambiguous for a winding test, but its inward nudge is unambiguous.
// Interior samples are checked as well, and so is the occluder's own boundary: an
// opening has a boundary however small it is, so a hole or a notch that falls between
// the shape's samples still fails the test where that boundary crosses the shape.

import { decodeSegs, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../hitTest/curveGeom.js';
import { pointInFill } from '../hitTest/fillCoverage.js';
import { strokeReachFactor } from '../bundle/strokeReach.js';
import { FS_NON_SCALING_STROKE, FS_HIDDEN } from '../bundle/layout.js';

// Meta slots (same layout hitTest.js reads).
const META_BBOX_XMIN = 0,
  META_BBOX_YMIN = 1,
  META_BBOX_XMAX = 2,
  META_BBOX_YMAX = 3;
const META_FILL_A = 7;
const META_FILL_RULE = 13; // 1 = even-odd (svg/meta.js, hitTest.js)
const META_STROKE_W = 12;
const META_STROKE_A = 11;
const META_JOIN_STYLE = 25;
const META_MITER_LIMIT = 26;

// A bundle bigger than this skips the pass — the pair scan is quadratic in the
// worst case and the win is a handful of draws. Real occluder art is small.
const MAX_SHAPES = 512;
// Boundary sample density: points per segment, plus interior grid resolution.
const PER_SEG = 5;
const GRID = 6;
// Float32 resolution of a coordinate, as a fraction of its magnitude: the curve plane stores every coordinate as a
// float32, so two edges authored flush can come back this far apart (hitTest/curveGeom.js F32_JOINT).
const F32_REL = 4 * 2 ** -23;

/**
 * The containment slack and boundary nudge for occluder bbox [x0, y0, x1, y1]: how far a shape's bbox may pass the
 * occluder's, how close a side must be to count as flush, and how far isContained pushes each boundary sample. 1e-4 of
 * the occluder's extent, and never under the float32 resolution of the coordinates it is compared against.
 *
 * No absolute floor such as 1e-5: under scale(2^-20) an occluder 100 units across is 9.5e-5 across, so the slack would
 * be a tenth of the occluder, and a shape passing its edge by 4% of its size would be culled: visible ink would go
 * missing. Both terms scale with the drawing, so the answer is the same at every size.
 */
export function occluderEps(x0, y0, x1, y1) {
  return Math.max(
    1e-4 * Math.max(x1 - x0, y1 - y0),
    F32_REL * Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)),
  );
}

/** Segments of shape i, or null. */
export function segsOf(i, cv, ranges) {
  const r = ranges[i];
  if (!r || r.end <= r.begin) return null;
  const segs = decodeSegs(cv, r.begin, r.end, 0);
  return segs && segs.length ? segs : null;
}

/**
 *
 * Two outlines authored flush and rounded (float32, a few ulps of the importer's arithmetic) disagree by that much, so a nudged
 * sample near a sharp corner of the contained shape -- inside it by 1e-4 of the occluder's extent, yet within a rounding of its
 * other edge -- lands outside the occluder on one side and inside it on the other: the cull flipped with input noise. A point
 * that near the occluder paints at most `slack` of ink outside it, which is invisible at any size the drawing is legible.

 */
export function insideWithin(inside, x, y, slack) {
  if (inside(x, y)) return true;
  const d = slack,
    e = slack * Math.SQRT1_2;
  return (
    inside(x + d, y) ||
    inside(x - d, y) ||
    inside(x, y + d) ||
    inside(x, y - d) ||
    inside(x + e, y + e) ||
    inside(x - e, y + e) ||
    inside(x + e, y - e) ||
    inside(x - e, y - e)
  );
}
/** The ink slack for a coordinate magnitude `mag` and a length scale `len`: 1e-5 of the length, never under 16 float32 resolutions of the coordinates. */
export const inkSlack = (len, mag) => Math.max(1e-5 * len, 16 * F32_REL * mag);

/**
 * Unit tangent of a segment at parameter t, or null where it has none (a zero-length segment). The sample at t = 1 steps BACK:
 * `segPointAt(s, min(1, t + 0.01))` is the sample itself there, so its tangent would be the zero vector and the nudge would
 * degenerate to the vertex -- where a point-in-fill test answers by rounding. Two flush boundaries that differ by one float32 ulp
 * would then disagree, and the cull would flip on input noise.
 */
export function segTangentAt(s, t) {
  const fwd = t < 0.99;
  const [ax, ay] = segPointAt(s, fwd ? t : t - 0.01),
    [bx, by] = segPointAt(s, fwd ? t + 0.01 : t);
  const tx = bx - ax,
    ty = by - ay,
    L = Math.hypot(tx, ty);
  // the whole segment shorter than a float32 ulp of its own position: no direction, and its points are its neighbors' vertices
  const mag = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by));
  return L > F32_REL * mag && L > 0 ? [tx / L, ty / L] : null;
}

/**
 * Point on a segment at parameter t. Segs come from decodeSegs: flat
 * {t, x0,y0, [cx,cy | c1x,c1y,c2x,c2y | arc center form], x1,y1}.
 */
export function segPointAt(s, t) {
  const u = 1 - t;
  if (s.t === SEG_CUBIC) {
    const a = u * u * u,
      b = 3 * u * u * t,
      c = 3 * u * t * t,
      d = t * t * t;
    return [
      a * s.x0 + b * s.c1x + c * s.c2x + d * s.x1,
      a * s.y0 + b * s.c1y + c * s.c2y + d * s.y1,
    ];
  }
  if (s.t === SEG_QUAD) {
    const a = u * u,
      b = 2 * u * t,
      c = t * t;
    return [a * s.x0 + b * s.cx + c * s.x1, a * s.y0 + b * s.cy + c * s.y1];
  }
  if (s.t === SEG_ARC) {
    const th = s.th0 + (s.th1 - s.th0) * t;
    return [
      s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
      s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp,
    ];
  }
  return [s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t];
}

// A shape that paints its whole silhouette, opaquely, with nothing that could shrink
// or displace it. Only such a shape can be trusted to hide what is under it.
export function isPlainOpaque(meta, stride, s) {
  const b = s * stride;
  if (meta[b + 7] < 0.996) return false; // fill alpha
  if (Math.floor(meta[b + 28] + 0.5) !== 0) return false; // gradient
  if (Math.floor(meta[b + 30] + 0.5) !== 0) return false; // clip
  if (Math.floor(meta[b + 31] + 0.5) !== 0) return false; // mask
  if (Math.floor(meta[b + 32] + 0.5) !== 0) return false; // filter
  if (stride >= 34 && Math.floor(meta[b + 33] + 0.5) !== 0) return false; // blend
  if (stride >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0) return false; // image
  if (stride >= 46 && Math.floor(meta[b + 45] + 0.5) !== 0) return false; // COLR
  if (stride >= 44 && Math.abs(meta[b + 43] - 2) < 0.5) return false; // Vector paint may be translucent.
  const fs = stride >= 28 ? Math.floor(meta[b + 27] + 0.5) : 0;
  if (fs & (64 | 128 | 256 | FS_HIDDEN)) return false; // group begin/end, COLR mask-only, a row kept hidden (it draws nothing, so it hides nothing)
  return true;
}
// Children can hide only earlier paint in the same isolated composition scope.
export function compositionScopes(meta, n, stride) {
  const scopes = new Int32Array(n),
    stack = [0];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const flags = stride >= 28 ? Math.round(meta[i * stride + 27]) : 0;
    scopes[i] = stack[stack.length - 1];
    if ((flags & 64) !== 0) stack.push(++next);
    else if ((flags & 128) !== 0 && stack.length > 1) stack.pop();
  }
  return scopes;
}

// A filter paints OUTSIDE its geometry (a blur spreads), so a filtered shape can
// escape its occluder entirely — never cull one.
export function hasFilter(meta, stride, s) {
  return Math.floor(meta[s * stride + 32] + 0.5) !== 0;
}

/**
 * Shape indices that a later opaque shape fully covers, and which are therefore
 * safe to skip. Returns an empty Set when nothing qualifies.
 *
 * `mode` picks how much work to do:
 *   'coincident' — only shapes touching their occluder's boundary. This is the
 *                  CORRECTNESS half (it removes the AA-edge conflation fringe) and
 *                  it is cheap, so createBundle runs it inline.
 *   'full'       — also the inner-rectangle search for hidden shapes that keep clear
 *                  of the boundary. Pure PERF (fewer draws), costs real time, and
 *                  nothing is wrong while it is missing — so it runs OFF-THREAD and
 *                  is applied when it lands.
 *
 * @param {Float32Array} cv packed curve plane
 * @param {{begin:number,end:number}[]} ranges authoritative curve range per shape
 * @param {Float32Array} meta packed shape metadata
 * @param {number} n shape count
 * @param {number} stride metadata floats per shape
 * @param {'coincident'|'full'} [mode]
 */
export function computeOccludedShapes(cv, ranges, meta, n, stride, mode = 'full') {
  const culled = new Set();
  if (!meta || n < 2 || n > MAX_SHAPES) return culled;
  // Ranges must be the AUTHORITATIVE per-shape curve slices. Do NOT re-derive them
  // from meta texel 4 (glyphLoc): that inference is a bandBuf index, not a curveBuf
  // offset, and is wrong on multi-shape bundles — it decodes far past each shape and
  // the containment test then reads another shape's geometry as its own.
  if (!cv || !cv.length || !Array.isArray(ranges) || ranges.length !== n) return culled;

  const scopes = compositionScopes(meta, n, stride);
  const bb = (i) => {
    const o = i * stride;
    return [
      meta[o + META_BBOX_XMIN],
      meta[o + META_BBOX_YMIN],
      meta[o + META_BBOX_XMAX],
      meta[o + META_BBOX_YMAX],
    ];
  };
  const segCache = new Array(n).fill(undefined);
  const segs = (i) =>
    segCache[i] === undefined ? (segCache[i] = segsOf(i, cv, ranges)) : segCache[i];
  // Total segment-visits this pass may spend across all point tests (see below).
  let budget = 1_000_000;

  const cullable = (i) => {
    if (culled.has(i) || hasFilter(meta, stride, i)) return false;
    const oi = i * stride;
    if (meta[oi + META_FILL_A] > 0) return true; // fill row
    // A non-scaling stroke has no fixed bound in the import frame.
    if (stride >= 28 && Math.round(meta[oi + 27]) & (FS_NON_SCALING_STROKE | (1 << 13) | (1 << 14)))
      return false;
    // Stroke row: invisible if its whole BAND is inside an opaque occluder.
    return meta[oi + META_STROKE_W] > 0 && meta[oi + META_STROKE_A] > 0;
  };
  /// How far a stroke's ink can reach from its centerline, in em. halfW everywhere,
  /// except that a miter join spikes to halfW*miterLimit past the vertex — and the
  /// row's stored bbox is only halfW-padded ("the perceived stroke ink"), so the
  /// spike lives OUTSIDE it. Using the miter bound unconditionally is conservative:
  /// it can only cost a cull that was available, never claim one that was not. A clipped
  /// miter reaches a little farther than that bound (bundle/strokeReach.js), so take the
  /// larger of the two.
  const strokeReach = (i) => {
    const o = i * stride;
    const halfW = meta[o + META_STROKE_W] * 0.5;
    const ml = stride > META_MITER_LIMIT ? meta[o + META_MITER_LIMIT] : 4;
    return halfW * Math.max(1, ml || 4, strokeReachFactor(meta[o + META_JOIN_STYLE], ml));
  };
  const isStrokeRow = (i) => !(meta[i * stride + META_FILL_A] > 0);
  // each SHAPE'S own FILL RULE, for both sides of every containment test. See isContained.
  const eoOf = (i) => meta[i * stride + META_FILL_RULE] > 0.5;

  // Exact containment. `mode` only controls which candidate pairs are tested.
  for (let j = n - 1; j >= 1; j--) {
    if (culled.has(j) || !isPlainOpaque(meta, stride, j)) continue;
    const [jx0, jy0, jx1, jy1] = bb(j);
    // Nudge scaled to the occluder, so it is meaningful at any em scale.
    const eps = occluderEps(jx0, jy0, jx1, jy1);

    for (let i = j - 1; i >= 0; i--) {
      if (scopes[i] !== scopes[j] || !cullable(i)) continue;
      // A stroke row's stored bbox bounds its CENTERLINE ink; the band reaches
      // further, so grow it before asking whether the occluder swallows it.
      const _sr = isStrokeRow(i) ? strokeReach(i) : 0;
      const _b = bb(i);
      const ix0 = _b[0] - _sr,
        iy0 = _b[1] - _sr,
        ix1 = _b[2] + _sr,
        iy1 = _b[3] + _sr;
      if (ix0 < jx0 - eps || iy0 < jy0 - eps || ix1 > jx1 + eps || iy1 > jy1 + eps) continue;
      // 'coincident' (INLINE, the correctness half): only shapes that TOUCH the
      // occluder's boundary can conflate, and touching shows up as a bbox side flush
      // against the occluder's. That gate is what keeps the load-path cost down.
      // 'full' (worker): inspect every nested pair, including shapes clear of the
      // occluder's boundary.
      if (mode !== 'full') {
        const flush =
          Math.abs(ix0 - jx0) < eps ||
          Math.abs(iy0 - jy0) < eps ||
          Math.abs(ix1 - jx1) < eps ||
          Math.abs(iy1 - jy1) < eps;
        if (!flush) continue;
      }
      const si = segs(i);
      if (!si) continue;
      const sj = segs(j); // decoded lazily: most occluders never get here
      if (!sj) break;

      // Each point test walks the occluder's segments. Stop when the work budget
      // is exhausted; incomplete culling only leaves extra draws.
      if (budget <= 0) return culled;
      budget -= (si.length + sj.length) * 64;
      const contained =
        _sr > 0
          ? isStrokeBandContained(si, sj, _sr, eoOf(j), ix0, iy0, ix1, iy1, eps)
          : isContained(si, sj, eps, ix0, iy0, ix1, iy1, eoOf(i), eoOf(j));
      if (contained) culled.add(i);
    }
  }
  return culled;
}

/**
 * Is the STROKE BAND around centerline `si` entirely inside `sj`?
 *
 * Not the same question isContained answers. That one samples si's boundary, nudges
 * a hair to both sides, and only checks points that land INSIDE si — which is right
 * for a fill and useless for a stroke, whose ink extends `reach` em to both sides of
 * the centerline and mostly lies outside si.
 *
 * So: push each boundary sample outward AND inward by the full reach, and require
 * every one of those to be inside sj — unconditionally, since a stroke paints there
 * whether or not si does. Segment ENDPOINTS are also pushed along the tangent, which
 * is where a cap puts ink.
 *
 * Sampling, so conservative in the usual direction: it can miss a cull between
 * samples on a wildly wiggly outline. A missed cull costs a draw; a wrong one loses
 * ink, so the error has to fall this way.
 */
export function isStrokeBandContained(
  si,
  sj,
  reach,
  eoJ = false,
  ix0 = Infinity,
  iy0 = Infinity,
  ix1 = -Infinity,
  iy1 = -Infinity,
  eps = reach,
) {
  const plain = (x, y) => pointInFill(sj, x, y, eoJ, null);
  for (let k = 0; k < si.length; k++) {
    for (let t = 0; t < PER_SEG; t++) {
      const tt = t / (PER_SEG - 1 || 1);
      const [px, py] = segPointAt(si[k], tt);
      const slack = inkSlack(reach, Math.max(Math.abs(px), Math.abs(py)) + reach);
      const inJ = (x, y) => insideWithin(plain, x, y, slack);
      const tg = segTangentAt(si[k], tt);
      if (!tg) continue;
      const [tx, ty] = tg;
      const nx = -ty * reach,
        ny = tx * reach;
      // Both sides of the band, the centerline itself, and the cap directions.
      if (!inJ(px + nx, py + ny)) return false;
      if (!inJ(px - nx, py - ny)) return false;
      if (!inJ(px, py)) return false;
      if (tt === 0 || tt === 1) {
        const ex = tx * reach,
          ey = ty * reach;
        if (!inJ(px + ex + nx, py + ey + ny)) return false;
        if (!inJ(px + ex - nx, py + ey - ny)) return false;
        if (!inJ(px - ex + nx, py - ey + ny)) return false;
        if (!inJ(px - ex - nx, py - ey - ny)) return false;
      }
    }
  }
  // The samples above are as far apart as the segment is long, so an opening between them is the occluder's boundary to report. Any part of it
  // inside the band's box refuses the cull, which may give up a cull a diagonal stroke could have had: the safe direction.
  const inBox = (x, y) => x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1;
  return !occluderBoundaryOpens(sj, inBox, plain, eps, ix0, iy0, ix1, iy1);
}

/**
 * Does the occluder's own boundary show an opening over a covered shape? Each sample of `sj`'s boundary inside the shape's box is pushed to both
 * sides; a side inside the shape (`inShape`) and outside the occluder (`inOccluder`) is a place the shape shows through. A boundary with the
 * occluder on both sides (overlapping contours) reports nothing, nor does an edge the shape stops at.
 *
 * The push is `nudge` (the caller's, scaled to the occluder) or a quarter of the segment, whichever is less, so a window smaller than the nudge is still
 * entered, and the slack of the inside test follows it. A slit narrower than the push is crossed by it and not seen; 1e-4 of the occluder's extent is
 * the bound of what this finds. A push that rounding lands on the wrong side can only refuse a cull, which costs a draw.
 */
function occluderBoundaryOpens(sj, inShape, inOccluder, nudge, ix0, iy0, ix1, iy1) {
  for (let k = 0; k < sj.length; k++) {
    const s = sj[k];
    const [ax, ay] = segPointAt(s, 0),
      [mx, my] = segPointAt(s, 0.5),
      [bx, by] = segPointAt(s, 1);
    const len = Math.max(Math.hypot(mx - ax, my - ay), Math.hypot(bx - mx, by - my)) * 2;
    const d = Math.min(nudge, len / 4);
    if (!(d > 0)) continue;
    for (let t = 0; t < PER_SEG; t++) {
      const tt = t / (PER_SEG - 1 || 1);
      const [px, py] = segPointAt(s, tt);
      if (px < ix0 - d || px > ix1 + d || py < iy0 - d || py > iy1 + d) continue;
      const tg = segTangentAt(s, tt);
      if (!tg) continue;
      const nx = -tg[1] * d,
        ny = tg[0] * d;
      const slack = Math.max(d / 8, 16 * F32_REL * Math.max(Math.abs(px), Math.abs(py)));
      for (const [x, y] of [
        [px + nx, py + ny],
        [px - nx, py - ny],
      ]) {
        if (inShape(x, y) && !insideWithin(inOccluder, x, y, Math.min(slack, d / 2))) return true;
      }
    }
  }
  return false;
}

/**
 * Is shape `si` entirely inside shape `sj`? Both are decodeSegs segment lists in the
 * same coordinate space; `eps` is a nudge scaled to the occluder.
 *
 * Sample si's boundary, push each sample a hair to both sides, and for every nudged
 * point that lies inside si, require it to lie inside sj. A point inside si but
 * outside sj disproves containment. The nudge is what makes COINCIDENT edges work: a
 * sample sitting exactly on a shared boundary is ambiguous for a winding test, but
 * its inward nudge is not. An interior grid is checked too, so an occluder with a
 * HOLE where the shape sits can't pass.
 */
export function isContained(si, sj, eps, ix0, iy0, ix1, iy1, eoI = false, eoJ = false) {
  // Under each shape's own fill rule. An even-odd occluder's holes are solid under nonzero -- so tested as
  // NONZERO, a shape sitting in one would pass every sample, including the interior grid below that exists
  // precisely so "an occluder with a HOLE under the shape can't pass", and an even-odd frame would cull the
  // shapes sitting in its cut-outs. The cull is asynchronous, so such missing ink appears only once the worker
  // answers -- under every fill engine -- and is hidden from any measurement that finishes its frames first.
  const inI = (x, y) => pointInFill(si, x, y, eoI, null);
  const slack = Math.max(
    eps / 8,
    16 * F32_REL * Math.max(Math.abs(ix0), Math.abs(iy0), Math.abs(ix1), Math.abs(iy1)),
  );
  const inJ = (x, y) => insideWithin((u, v) => pointInFill(sj, u, v, eoJ, null), x, y, slack);

  const NS = 8;
  for (let k = 0; k < NS; k++) {
    const s = si[Math.floor((k / NS) * si.length)];
    const t = ((k * 7) % 5) / 4;
    const [px, py] = segPointAt(s, t);
    const tg = segTangentAt(s, t);
    if (!tg) continue;
    const nx = -tg[1] * eps,
      ny = tg[0] * eps;
    for (const [ax, ay] of [
      [px + nx, py + ny],
      [px - nx, py - ny],
    ]) {
      if (inI(ax, ay) && !inJ(ax, ay)) return false;
    }
  }
  // Dense boundary sweep.
  for (let k = 0; k < si.length; k++) {
    for (let t = 0; t < PER_SEG; t++) {
      const tt = t / (PER_SEG - 1 || 1);
      const [px, py] = segPointAt(si[k], tt);
      const tg = segTangentAt(si[k], tt);
      if (!tg) continue;
      const nx = -tg[1] * eps,
        ny = tg[0] * eps;
      for (const [ax, ay] of [
        [px + nx, py + ny],
        [px - nx, py - ny],
      ]) {
        if (inI(ax, ay) && !inJ(ax, ay)) return false;
      }
    }
  }
  // Interior grid — an occluder with a HOLE under the shape must not pass.
  if (ix1 > ix0 && iy1 > iy0) {
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const x = ix0 + ((gx + 0.5) / GRID) * (ix1 - ix0);
        const y = iy0 + ((gy + 0.5) / GRID) * (iy1 - iy0);
        if (inI(x, y) && !inJ(x, y)) return false;
      }
    }
  }
  // The occluder's own boundary, for an opening between the samples above (occluderBoundaryOpens). Reached only by a pair about to be culled.
  return !occluderBoundaryOpens(
    sj,
    inI,
    (x, y) => pointInFill(sj, x, y, eoJ, null),
    eps,
    ix0,
    iy0,
    ix1,
    iy1,
  );
}
