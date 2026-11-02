// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/strokeInk.js -- the extents of a stroke's ink that lie OUTSIDE its path-plus-halfW box.
//
// A stroke row's bbox is the path box padded by halfW (the box the shader indexes the row's bands through; see
// bundleFinalize.js). Two kinds of ink reach farther than halfW from the path: a MITER (or miter-clip) tip, up to halfW *
// miterLimit from its vertex, and a SQUARE cap's outer corners, sqrt(2) * halfW from the end point (on a diagonal line the
// corner leaves the padded box). A renderer that fits the content box (globalBBox) cropped them.
//
// strokeInkPoints lists those points exactly, from the segments' own end tangents (the same tangents the shader's join and
// cap use), so a bundle without a sharp miter or a diagonal square cap gets points inside the padded box and nothing changes.
import { SEG_LINE, SEG_ARC, segStart, segEnd, pointsMeet } from './segment.js';
import { segTangent } from './strokeStrip.js';

const unit = (v) => {
  if (!v) return null;
  const l = Math.hypot(v[0], v[1]);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
};

/** Split the segments into subpaths: { segs, closed }. Mirrors strokeStrip.polylines' splitting rule. */
function subpaths(segs) {
  const subs = [];
  let cur = null,
    prev = null;
  for (const s of segs) {
    if (!s) continue;
    const a = segStart(s);
    if (!a) return null;
    if (!cur || s.subStart === true || !pointsMeet(segEnd(prev), a)) {
      cur = { segs: [], openEnd: false };
      subs.push(cur);
    }
    cur.segs.push(s);
    if (s.openEnd === true) cur.openEnd = true;
    prev = s;
  }
  for (const sp of subs) {
    const a = segStart(sp.segs[0]),
      b = segEnd(sp.segs[sp.segs.length - 1]);
    sp.closed = !sp.openEnd && sp.segs.length > 1 && pointsMeet(a, b);
  }
  return subs;
}

/**
 * The points a stroke's ink reaches beyond path +- halfW, as a flat [x, y, ...] list.
 * o: { halfW, joinStyle (0 miter, 1 round, 2 bevel, 3 miter-clip, 4 arcs), miterLimit, capStyle, endCapStyle, dashed, N }.
 * N, for a stroke drawn in STROKE SPACE (bundle/strokeFrame.js): the column-major map from the document-space segments to the
 * space the stroke is an ordinary one in (halfW is then its stroke-space half width); the points come back in document space.
 * A dashed stroke puts a cap at every dash end: a square cap is bounded by the corners at each line's two ends and, on a
 * curve, by its control box grown sqrt(2) * halfW (an upper bound; dashes only remove ink).
 */
export function strokeInkPoints(segs, o) {
  const { halfW, joinStyle, capStyle, endCapStyle = capStyle, dashed = false, N = null } = o;
  const ml = Math.max(1, o.miterLimit || 4);
  const out = [];
  if (!(halfW > 0)) return out;
  // a framed stroke: points and tangents go through N, the result comes back through N^-1
  const det = N ? N[0] * N[3] - N[1] * N[2] : 1;
  if (N && !(Math.abs(det) > 0 && Number.isFinite(det))) return out;
  const fwd = N
    ? (v) => (v ? [N[0] * v[0] + N[2] * v[1], N[1] * v[0] + N[3] * v[1]] : v)
    : (v) => v;
  const emit = N
    ? (x, y) => out.push((N[3] * x - N[2] * y) / det, (-N[1] * x + N[0] * y) / det)
    : (x, y) => out.push(x, y);
  const squareCorners = (P0, t) => {
    // t: unit tangent pointing OUT of the path at P0 (stroke space)
    const P = fwd(P0),
      nx = -t[1],
      ny = t[0];
    emit(P[0] + halfW * (t[0] + nx), P[1] + halfW * (t[1] + ny));
    emit(P[0] + halfW * (t[0] - nx), P[1] + halfW * (t[1] - ny));
  };
  const joinPoints = (P0, ti, to) => {
    if (joinStyle !== 0 && joinStyle !== 3 && joinStyle !== 4) return;
    const P = fwd(P0);
    const d1 = unit(fwd(ti)),
      d2 = unit(fwd(to));
    if (!d1 || !d2) return;
    const cosT = d1[0] * d2[0] + d1[1] * d2[1];
    if (!(1 + cosT > 0)) return; // a full reversal: unbounded miter, which bevels
    const ratio = 1 / Math.sqrt((1 + cosT) * 0.5);
    const sOut = d1[0] * d2[1] - d1[1] * d2[0] > 0 ? -1 : 1;
    const n1 = [-d1[1] * sOut, d1[0] * sOut],
      n2 = [-d2[1] * sOut, d2[0] * sOut];
    const bx = n1[0] + n2[0],
      by = n1[1] + n2[1],
      bl = Math.hypot(bx, by);
    if (!(bl > 0)) return;
    const b = [bx / bl, by / bl];
    // the shader compares in float32 and the stored limit is the ratio the shape actually turns: err wide (strokeStrip does)
    if (ratio <= ml * 1.02 + 1e-3) {
      emit(P[0] + b[0] * halfW * ratio, P[1] + b[1] * halfW * ratio);
      return;
    }
    if (joinStyle === 0) return; // past the limit a miter bevels
    // miter-clip / arcs past the limit: the clip line's corners on the two outer offset lines
    const tipD = halfW * ratio,
      baseD = halfW / ratio,
      ML = halfW * ml;
    const sc = tipD > baseD ? Math.min(1, Math.max(0, (ML - baseD) / (tipD - baseD))) : 0;
    const T = [P[0] + b[0] * tipD, P[1] + b[1] * tipD];
    for (const n of [n1, n2]) {
      const A = [P[0] + n[0] * halfW, P[1] + n[1] * halfW];
      emit(A[0] + sc * (T[0] - A[0]), A[1] + sc * (T[1] - A[1]));
    }
  };
  const subs = subpaths(segs);
  if (!subs) return out;
  for (const sp of subs) {
    const ss = sp.segs;
    for (let i = 1; i < ss.length; i++)
      joinPoints(segStart(ss[i]), segTangent(ss[i - 1], true), segTangent(ss[i], false));
    if (sp.closed)
      joinPoints(segStart(ss[0]), segTangent(ss[ss.length - 1], true), segTangent(ss[0], false));
    if (dashed) {
      if (capStyle !== 2 && endCapStyle !== 2) continue;
      const r = halfW * Math.SQRT2;
      for (const s of ss) {
        if (s.type === SEG_LINE) {
          const t = unit(fwd(segTangent(s, false)));
          if (t) {
            squareCorners(segStart(s), [-t[0], -t[1]]);
            squareCorners(segEnd(s), t);
          }
        } else {
          const R = s.type === SEG_ARC ? Math.max(Math.abs(s.rx), Math.abs(s.ry)) : 0;
          const pts =
            s.type === SEG_ARC
              ? [
                  [s.cx - R, s.cy - R],
                  [s.cx + R, s.cy + R],
                ]
              : [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
          let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
          for (const p of pts) {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1];
            if (p[1] > y1) y1 = p[1];
          }
          if (x1 >= x0) out.push(x0 - r, y0 - r, x1 + r, y1 + r);
        }
      }
    } else if (!sp.closed) {
      if (capStyle === 2) {
        const t = unit(fwd(segTangent(ss[0], false)));
        if (t) squareCorners(segStart(ss[0]), [-t[0], -t[1]]);
      }
      if (endCapStyle === 2) {
        const t = unit(fwd(segTangent(ss[ss.length - 1], true)));
        if (t) squareCorners(segEnd(ss[ss.length - 1]), t);
      }
    }
  }
  return out;
}

/** bbox [x0, y0, x1, y1] grown to hold the ink points; the same array when nothing lies outside it. */
export function growByInkPoints(bbox, pts) {
  let g = bbox;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i],
      y = pts[i + 1];
    if (!Number.isFinite(x + y)) continue;
    if (x < g[0] || y < g[1] || x > g[2] || y > g[3]) {
      if (g === bbox) g = bbox.slice();
      if (x < g[0]) g[0] = x;
      if (x > g[2]) g[2] = x;
      if (y < g[1]) g[1] = y;
      if (y > g[3]) g[3] = y;
    }
  }
  return g;
}
