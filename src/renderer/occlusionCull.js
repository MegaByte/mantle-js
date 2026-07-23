// occlusionCull.js — drop shapes that a later OPAQUE shape completely covers.
//
// WHY. A fully-occluded shape contributes nothing to the final image — except at
// its ANTIALIASED EDGE, which it does contribute, wrongly. Painter compositing
// blends each shape's coverage independently, so where an occluded shape's edge
// runs under the occluder's edge, the pixel gets the hidden shape's colour
// blended in a second time:
//
//     truth        c·J + (1−c)·bg
//     what we did  c·J + (1−c)·[ c·I + (1−c)·bg ]      ← I bleeds through
//
// The error peaks at c = 0.5 and vanishes at c = 0 and 1, producing a
// one-pixel fringe of the hidden shape's colour along shared edges.
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
// SOUNDNESS. Culling is only valid when the occluder REALLY covers the shape:
//   • the occluder is drawn later, is a plain opaque solid, and has no
//     clip/mask/filter/blend that could shrink or move what it paints;
//   • the occluded shape has no filter — a blur paints OUTSIDE its geometry and
//     could escape the occluder entirely;
//   • containment is verified geometrically, not assumed from bounding boxes.
//
// CONTAINMENT TEST. Bbox containment first (cheap reject). Then sample the
// occluded shape's boundary, push each sample a hair to BOTH sides, and for every
// nudged point that lies inside the occluded shape, require it to lie inside the
// occluder too. A point inside I but outside J proves I is not contained. The
// nudge is what makes COINCIDENT edges work: a sample sitting exactly on a shared
// boundary is ambiguous for a winding test, but its inward nudge is unambiguous.
// Interior samples are checked as well, so an occluder with a HOLE punched
// through the shape can't pass.

import { decodeSegs, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../hitTest/curveGeom.js';
import { pointInFill } from '../hitTest/fillCoverage.js';

// Meta slots (same layout hitTest.js reads).
const META_BBOX_XMIN = 0, META_BBOX_YMIN = 1, META_BBOX_XMAX = 2, META_BBOX_YMAX = 3;
const META_FILL_A = 7;
const META_STROKE_W = 12;

// A bundle bigger than this skips the pass — the pair scan is quadratic in the
// worst case and the win is a handful of draws. Real occluder art is small.
const MAX_SHAPES = 512;
// Boundary sample density: points per segment, plus interior grid resolution.
const PER_SEG = 5;
const GRID = 6;

/** Segments of shape i, or null. */
export function segsOf(i, cv, ranges) {
  const r = ranges[i];
  if (!r || r.end <= r.begin) return null;
  const segs = decodeSegs(cv, r.begin, r.end, 0);
  return segs && segs.length ? segs : null;
}

/**
 * Point on a segment at parameter t. Segs come from decodeSegs: flat
 * {t, x0,y0, [cx,cy | c1x,c1y,c2x,c2y | arc center form], x1,y1}.
 */
export function segPointAt(s, t) {
  const u = 1 - t;
  if (s.t === SEG_CUBIC) {
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * s.x0 + b * s.c1x + c * s.c2x + d * s.x1,
            a * s.y0 + b * s.c1y + c * s.c2y + d * s.y1];
  }
  if (s.t === SEG_QUAD) {
    const a = u * u, b = 2 * u * t, c = t * t;
    return [a * s.x0 + b * s.cx + c * s.x1, a * s.y0 + b * s.cy + c * s.y1];
  }
  if (s.t === SEG_ARC) {
    const th = s.th0 + (s.th1 - s.th0) * t;
    return [s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp,
            s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp];
  }
  return [s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t];
}

// A shape that paints its whole silhouette, opaquely, with nothing that could shrink
// or displace it. Only such a shape can be trusted to hide what is under it.
export function isPlainOpaque(meta, stride, s) {
  const b = s * stride;
  if (meta[b + 7] < 0.996) return false;                                   // fill alpha
  if (Math.floor(meta[b + 28] + 0.5) !== 0) return false;                  // gradient
  if (Math.floor(meta[b + 30] + 0.5) !== 0) return false;                  // clip
  if (Math.floor(meta[b + 31] + 0.5) !== 0) return false;                  // mask
  if (Math.floor(meta[b + 32] + 0.5) !== 0) return false;                  // filter
  if (stride >= 34 && Math.floor(meta[b + 33] + 0.5) !== 0) return false;  // blend
  if (stride >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0) return false;  // image
  if (stride >= 46 && Math.floor(meta[b + 45] + 0.5) !== 0) return false;  // COLR
  const fs = (stride >= 28) ? Math.floor(meta[b + 27] + 0.5) : 0;
  if (fs & (64 | 128 | 256)) return false;          // group begin/end, COLR mask-only
  return true;
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
 *   'coincident' — ONLY shapes touching their occluder's boundary. This is the
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

  const bb = (i) => {
    const o = i * stride;
    return [meta[o + META_BBOX_XMIN], meta[o + META_BBOX_YMIN],
            meta[o + META_BBOX_XMAX], meta[o + META_BBOX_YMAX]];
  };
  const segCache = new Array(n).fill(undefined);
  const segs = (i) => (segCache[i] === undefined ? (segCache[i] = segsOf(i, cv, ranges)) : segCache[i]);
  // Total segment-visits this pass may spend across all point tests (see below).
  let budget = 1_000_000;

  const cullable = (i) => {
    if (culled.has(i) || hasFilter(meta, stride, i)) return false;
    const oi = i * stride;
    // A stroked shape paints a band OUTSIDE its fill, and the fill tests below say
    // nothing about where that band lands. Leave it alone.
    if (meta[oi + META_STROKE_W] > 0) return false;
    return meta[oi + META_FILL_A] > 0;                    // nothing to draw anyway
  };

  // Exact containment. `mode` only controls which candidate pairs are tested.
  for (let j = n - 1; j >= 1; j--) {
    if (culled.has(j) || !isPlainOpaque(meta, stride, j)) continue;
    const [jx0, jy0, jx1, jy1] = bb(j);
    // Nudge scaled to the occluder, so it is meaningful at any em scale.
    const eps = Math.max(1e-5, 1e-4 * Math.max(jx1 - jx0, jy1 - jy0));

    for (let i = j - 1; i >= 0; i--) {
      if (!cullable(i)) continue;
      const [ix0, iy0, ix1, iy1] = bb(i);
      if (ix0 < jx0 - eps || iy0 < jy0 - eps || ix1 > jx1 + eps || iy1 > jy1 + eps) continue;
      // 'coincident' (INLINE, the correctness half): only shapes that TOUCH the
      // occluder's boundary can conflate, and touching shows up as a bbox side flush
      // against the occluder's. That gate is what keeps the load-path cost down.
      // 'full' (worker): inspect every nested pair, including shapes clear of the
      // occluder's boundary.
      if (mode !== 'full') {
        const flush = Math.abs(ix0 - jx0) < eps || Math.abs(iy0 - jy0) < eps
                   || Math.abs(ix1 - jx1) < eps || Math.abs(iy1 - jy1) < eps;
        if (!flush) continue;
      }
      const si = segs(i);
      if (!si) continue;
      const sj = segs(j);              // decoded lazily: most occluders never get here
      if (!sj) break;

      // Each point test walks the occluder's segments. Stop when the work budget
      // is exhausted; incomplete culling only leaves extra draws.
      if (budget <= 0) return culled;
      budget -= (si.length + sj.length) * 64;
      const contained = isContained(si, sj, eps, ix0, iy0, ix1, iy1);
      if (contained) culled.add(i);
    }
  }
  return culled;
}

/**
 * Is shape `si` entirely inside shape `sj`? Both are decodeSegs segment lists in the
 * same coordinate space; `eps` is a nudge scaled to the occluder.
 *
 * Sample si's boundary, push each sample a hair to BOTH sides, and for every nudged
 * point that lies inside si, require it to lie inside sj. A point inside si but
 * outside sj disproves containment. The nudge is what makes COINCIDENT edges work: a
 * sample sitting exactly on a shared boundary is ambiguous for a winding test, but
 * its inward nudge is not. An interior grid is checked too, so an occluder with a
 * HOLE where the shape sits can't pass.
 */
export function isContained(si, sj, eps, ix0, iy0, ix1, iy1) {
  const inI = (x, y) => pointInFill(si, x, y, false, null);
  const inJ = (x, y) => pointInFill(sj, x, y, false, null);

  // SPARSE PRE-REJECT. Almost every pair fails, and usually at the first sample.
  // Walk a handful of points spread around the boundary before paying for the dense
  // sweep, so a rejected pair costs ~8 tests rather than 8·segs.
  const NS = 8;
  for (let k = 0; k < NS; k++) {
    const s = si[Math.floor((k / NS) * si.length)];
    const t = ((k * 7) % 5) / 4;
    const [px, py] = segPointAt(s, t);
    const [qx, qy] = segPointAt(s, Math.min(1, t + 0.01));
    let nx = -(qy - py), ny = (qx - px);
    const L = Math.hypot(nx, ny) || 1;
    nx = (nx / L) * eps; ny = (ny / L) * eps;
    for (const [ax, ay] of [[px + nx, py + ny], [px - nx, py - ny]]) {
      if (inI(ax, ay) && !inJ(ax, ay)) return false;
    }
  }
  // Dense boundary sweep.
  for (let k = 0; k < si.length; k++) {
    for (let t = 0; t < PER_SEG; t++) {
      const tt = t / (PER_SEG - 1 || 1);
      const [px, py] = segPointAt(si[k], tt);
      const [qx, qy] = segPointAt(si[k], Math.min(1, tt + 0.01));
      let nx = -(qy - py), ny = (qx - px);
      const L = Math.hypot(nx, ny) || 1;
      nx = (nx / L) * eps; ny = (ny / L) * eps;
      for (const [ax, ay] of [[px + nx, py + ny], [px - nx, py - ny]]) {
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
  return true;
}
