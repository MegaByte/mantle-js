// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { certifySimplePolynomialPaint } from '../core/polynomialPaint.js';
import { snapSubPrecisionLines, snapSubPrecisionHandles } from '../core/subPrecision.js';
import { arcOf, arcPoint } from '../core/arcPaint.js';
// fillNormalize.js -- A nonzero path whose closed contours are all line polygons with ONE orientation fills the UNION of
// their regions; a contour whose region lies inside another's (weakly: shared edges and touching vertices allowed, no proper
// crossing) adds nothing to the fill. The winding integrators (AAC, Slug's fold) still count it: inside it the winding is 2, and a
// pixel holding both boundaries reads fold(2*c) = 1 where the coverage is c. Dropping such contours makes the integral the area.
//
// Exact and scale free: the tests are orientation (signed-area sign), vertex-in-polygon with an ON-boundary answer that rounds with
// the coordinates (128 epsilon of the terms, as cpatchSimpleArea's certificate does), and proper-crossing of line segments.
// Anything uncertain returns null and the contours stay.
//
//   droppedContourIndices(contours, evenOdd) -> Set of contour indices to drop, or null when nothing is to be dropped
// `contours`: arrays of line segments { type: SEG_LINE, p1, p2 } forming CLOSED subpaths (as splitSubpathsWithCloseInto emits).
const EPS = Number.EPSILON;

const FLUSH_REL = 2 ** -17;
function area2(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}
// distance from (x, y) to the segment a-b
function distSeg(a, b, x, y) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
// 0 outside, 1 inside, 2 on the boundary (within `tl` of an edge)
function locate(poly, x, y, tl) {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    if (distSeg(a, b, x, y) <= tl) return 2;
    const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (a[1] <= y !== b[1] <= y) {
      const t = cr;
      if (b[1] > a[1] ? t > 0 : t < 0) w += b[1] > a[1] ? 1 : -1;
    }
  }
  return w !== 0 ? 1 : 0;
}
// a proper crossing: each segment's ends lie on strictly opposite sides of the other, "strictly" being farther than `tl` from its line
function properCross(a, b, c, d, tl) {
  const o = (p, q, r) => {
    const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return Math.abs(v) <=
      Math.max(
        tl * len,
        128 *
          EPS *
          (Math.abs((q[0] - p[0]) * (r[1] - p[1])) + Math.abs((q[1] - p[1]) * (r[0] - p[0]))),
      )
      ? 0
      : Math.sign(v);
  };
  const o1 = o(a, b, c),
    o2 = o(a, b, d),
    o3 = o(c, d, a),
    o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}
export function droppedContourIndices(contours, evenOdd = false) {
  if (evenOdd || contours.length < 2 || contours.length > 64) return null;
  const polys = [];
  let edges = 0;
  for (const c of contours) {
    const poly = [];
    for (const s of c) {
      if (s.type !== 0 || !s.p1 || !s.p2) return null;
      poly.push(s.p1);
    } // SEG_LINE only
    if (poly.length < 3) return null;
    edges += poly.length;
    polys.push(poly);
  }
  if (edges > 512) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const P of polys)
    for (const q of P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
  const tl = FLUSH_REL * Math.max(x1 - x0, y1 - y0);
  const sign = polys.map((p) => Math.sign(area2(p)));
  if (sign.some((s) => s === 0) || sign.some((s) => s !== sign[0])) return null; // one orientation, no degenerate loop
  const drop = new Set();
  for (let i = 0; i < polys.length; i++) {
    for (let j = 0; j < polys.length; j++) {
      if (i === j || drop.has(j)) continue; // never drop on the strength of a dropped contour
      // C_i weakly inside C_j: every vertex inside or on, no proper crossing; identical contours: the later one goes
      const A = polys[i],
        B = polys[j];
      let inside = true,
        strictly = false;
      for (const p of A) {
        const l = locate(B, p[0], p[1], tl);
        if (l === 0) {
          inside = false;
          break;
        }
        if (l === 1) strictly = true;
      }
      if (!inside) continue;
      let cross = false;
      for (let a = 0; a < A.length && !cross; a++)
        for (let b = 0; b < B.length; b++)
          if (properCross(A[a], A[(a + 1) % A.length], B[b], B[(b + 1) % B.length], tl)) {
            cross = true;
            break;
          }
      if (cross) continue;
      // the edge midpoints too: a vertex-in-B test misses an edge that leaves B between two inside vertices without crossing a vertex pair test
      for (let a = 0; a < A.length && inside; a++) {
        const p = A[a],
          q = A[(a + 1) % A.length];
        if (locate(B, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, tl) === 0) inside = false;
      }
      if (!inside) continue;
      // equal regions: keep the lower index
      let sameRegion = !strictly && polys[i].length === polys[j].length;
      if (sameRegion) {
        const back = B.every((p) => locate(A, p[0], p[1], tl) !== 0);
        sameRegion = back;
      }
      if (sameRegion && i < j) continue;
      drop.add(i);
      break;
    }
  }
  return drop.size ? drop : null;
}

// The closed contours of a fill segment list as splitSubpathsWithCloseInto emits it: every subpath ends with a synthetic closing line
// (is_fill_only), so a contour is the run of segments up to and including one. Returns null if the list does not end on one.
export function closedContours(segs) {
  const out = [];
  let cur = [];
  for (const sg of segs) {
    cur.push(sg);
    if (sg.is_fill_only === true) {
      out.push(cur);
      cur = [];
    }
  }
  return cur.length ? null : out;
}
// Coverage-only normalization: authored records remain available to strokes,
// hit tests and morph pairing. The strict polynomial certificate also handles
// even-odd holes and oppositely oriented disjoint contours within one pixel.
// Optional `statusOut` records the multi-contour certification outcome with
// zero extra passes: 0 = single contour / n/a, 1 = certified 0/1 boundary,
// -1 = multi-contour boundary declined by certification.
export const FILL_NORM_SINGLE = 0;
export const FILL_NORM_CERTIFIED = 1;
export const FILL_NORM_DECLINED = -1;

function keptPolysCertified(contours, drop) {
  const kept = [];
  for (let i = 0; i < contours.length; i++) {
    if (drop.has(i)) continue;
    const poly = [];
    for (const s of contours[i]) {
      if (s.type !== 0 || !s.p1) return false;
      poly.push(s.p1);
    }
    const n = poly.length;
    if (n < 3) return false;
    for (let a = 0; a < n; a++) {
      for (let b = a + 2; b < n; b++) {
        if (a === 0 && b === n - 1) continue;
        if (properCross(poly[a], poly[(a + 1) % n], poly[b], poly[(b + 1) % n])) return false;
      }
    }
    kept.push(poly);
  }
  for (let i = 0; i < kept.length; i++) {
    const A = kept[i];
    for (let j = i + 1; j < kept.length; j++) {
      const B = kept[j];
      for (let a = 0; a < A.length; a++) {
        for (let b = 0; b < B.length; b++) {
          if (properCross(A[a], A[(a + 1) % A.length], B[b], B[(b + 1) % B.length])) return false;
        }
      }
      for (let a = 0; a < A.length; a++) {
        const p = A[a],
          q = A[(a + 1) % A.length];
        if (locate(B, p[0], p[1]) !== 0 || locate(B, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2) !== 0)
          return false;
      }
      for (let b = 0; b < B.length; b++) {
        const p = B[b],
          q = B[(b + 1) % B.length];
        if (locate(A, p[0], p[1]) !== 0 || locate(A, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2) !== 0)
          return false;
      }
    }
  }
  return kept.length > 0;
}

// One curve as a string that does not depend on its direction: its control points, the lesser of the two orders. A native arc
// by its center form and the angle in the middle of its sweep, which tells it from the other way round the same ellipse.
function segKey(g) {
  if (g.type === 3) {
    const a = arcOf(g);
    if (!a) return null;
    const e = [String(g.p1), String(g.p4)].sort();
    return `a${a.cx},${a.cy},${a.rx},${a.ry},${a.phi},${arcPoint(a, 0.5 * (a.t0 + a.t1))},${e}`;
  }
  const P =
    g.type === 0
      ? [g.p1, g.p2]
      : g.type === 1
        ? [g.p1, g.p2, g.p3]
        : g.type === 2
          ? [g.p1, g.p2, g.p3, g.p4]
          : null;
  if (!P) return null;
  const f = P.join(';'),
    r = [...P].reverse().join(';');
  return g.type + (f < r ? f : r);
}
// A contour as the sorted list of its curves (null where one has no key).
function contourKey(c) {
  const keys = [];
  for (const g of c) {
    if (g.type === 0 && g.p1[0] === g.p2[0] && g.p1[1] === g.p2[1]) continue; // a closing line of no length
    const k = segKey(g);
    if (k === null) return null;
    keys.push(k);
  }
  return keys.sort().join('|');
}
// A number two contours of the same curves agree on, whatever their directions and starts: the count and the exact bounds of their control
// points, skipping what contourKey skips. Different numbers mean different keys, and building the keys is most of the cost of the tests below.
function contourPrefilter(c) {
  let n = 0,
    x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const at = (p) => {
    if (!p) return;
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  };
  for (const g of c) {
    if (g.type === 0 && g.p1[0] === g.p2[0] && g.p1[1] === g.p2[1]) continue;
    n++;
    if (g.type === 3) {
      at(g.p1);
      at(g.p4);
    } else if (g.type === 0) {
      at(g.p1);
      at(g.p2);
    } else if (g.type === 1) {
      at(g.p1);
      at(g.p2);
      at(g.p3);
    } else if (g.type === 2) {
      at(g.p1);
      at(g.p2);
      at(g.p3);
      at(g.p4);
    }
  }
  return n + 1.3 * x0 + 1.7 * y0 + 2.3 * x1 + 2.9 * y1;
}
// Even-odd reads the winding mod 2, so two closed contours made of the same curves add nothing, whatever their directions, starts and order:
// each curve is crossed twice. A winding integrator does not see that: a pixel on the edge they share reads fold(2 * c), a full pixel at c = 1/2,
// where the coverage is 0 (a ring of up to 249/255 round a contour drawn twice). Pairs leave the list; a third copy stays, as it should.
// Exact and scale free: the coordinates are compared as they are. A contour that only nearly matches, or shares only part of its edge, stays.
function withoutEvenOddPairs(cs) {
  const seen = new Set();
  for (const c of cs) seen.add(contourPrefilter(c));
  if (seen.size === cs.length) return cs;
  const open = new Map(),
    gone = new Set();
  for (let i = 0; i < cs.length; i++) {
    const key = contourKey(cs[i]);
    if (key === null) return cs;
    if (open.has(key)) {
      gone.add(open.get(key));
      gone.add(i);
      open.delete(key);
    } else open.set(key, i);
  }
  return gone.size ? cs.filter((c, i) => !gone.has(i)) : cs;
}

// The sign of a contour's control polygon: reversing the contour negates it exactly, and its start does not matter.
function controlArea(c) {
  let a = 0;
  for (const g of c) {
    const P =
      g.type === 0
        ? [g.p1, g.p2]
        : g.type === 1
          ? [g.p1, g.p2, g.p3]
          : g.type === 2
            ? [g.p1, g.p2, g.p3, g.p4]
            : [g.p1, g.p4];
    for (let i = 0; i + 1 < P.length; i++) a += P[i][0] * P[i + 1][1] - P[i + 1][0] * P[i][1];
  }
  return a;
}
function sameContourSameWay(A, B) {
  const pa = contourPrefilter(A),
    pb = contourPrefilter(B);
  if (pa < pb || pa > pb) return false; // (no answer from a NaN: non-finite control points)
  const ka = contourKey(A),
    kb = contourKey(B);
  if (ka === null || ka !== kb) return false;
  const a = controlArea(A),
    b = controlArea(B);
  return a !== 0 && Math.sign(a) === Math.sign(b);
}

export function normalizedFillSegs(segs, evenOdd, statusOut = null) {
  if (statusOut) statusOut.status = FILL_NORM_SINGLE;
  const cs = closedContours(segs);
  if (!cs || cs.length < 2) return null;
  if (evenOdd && cs.length <= 4096) {
    const left = withoutEvenOddPairs(cs);
    if (left !== cs) {
      const flat = left.flat();
      return normalizedFillSegs(flat, evenOdd, statusOut) || flat;
    }
  }
  // Nonzero, two contours and nothing else: the same curves in the same direction wind everything twice, and the winding is nonzero where one copy's is,
  // so the copy adds nothing to the fill and fold(2 * c) only overstates the edge. Run the other way they wind to zero, which the integral already reads.
  if (!evenOdd && cs.length === 2 && sameContourSameWay(cs[0], cs[1])) return cs[0];
  // Weak containment along a line: shared edges intentionally decline the
  // stricter disjoint-boundary certificate below.
  const drop = droppedContourIndices(cs, evenOdd);
  if (drop) {
    if (statusOut)
      statusOut.status = keptPolysCertified(cs, drop) ? FILL_NORM_CERTIFIED : FILL_NORM_DECLINED;
    return cs.flatMap((c, i) => (drop.has(i) ? [] : c));
  }
  if (cs.length > 64 || segs.length > 320) return null;
  const contours = [];
  let arcs = false;
  for (let ci = 0; ci < cs.length; ci++) {
    const loop = [];
    for (const g of cs[ci]) {
      if (g.type < 0 || g.type > 3) {
        if (statusOut) statusOut.status = FILL_NORM_DECLINED;
        return null;
      }
      if (g.type === 0 && g.p1[0] === g.p2[0] && g.p1[1] === g.p2[1]) continue;
      if (g.type === 3) {
        // A native arc: its center form is the certificate's geometry; a degenerate radius is the chord (a line) as the importer
        // draws it, and a zero sweep adds nothing.
        const a = arcOf(g);
        if (!a || !g.p1 || !g.p4) {
          if (statusOut) statusOut.status = FILL_NORM_DECLINED;
          return null;
        }
        const chord = g.p1[0] === g.p4[0] && g.p1[1] === g.p4[1];
        if (a.rx === 0 || a.ry === 0) {
          if (chord) continue;
          loop.push({ t: 'line', P: [g.p1, g.p4], source: g, contour: ci });
          continue;
        }
        if (a.t0 === a.t1) continue;
        arcs = true;
        loop.push({ t: 'arc', P: [g.p1, g.p4], arc: a, source: g, contour: ci });
        continue;
      }
      const P =
        g.type === 0 ? [g.p1, g.p2] : g.type === 1 ? [g.p1, g.p2, g.p3] : [g.p1, g.p2, g.p3, g.p4];
      loop.push({ t: ['line', 'quad', 'cubic'][g.type], P, source: g, contour: ci });
    }

    if (arcs && loop.length > 1) {
      let mag = 0;
      for (const c of loop)
        for (const p of c.P) mag = Math.max(mag, Math.abs(p[0]), Math.abs(p[1]));
      const tiny = (p, q) =>
        Math.abs(p[0] - q[0]) <= 2 ** -40 * mag && Math.abs(p[1] - q[1]) <= 2 ** -40 * mag;
      const start = loop[0].P[0];
      while (
        loop.length > 1 &&
        loop[loop.length - 1].t === 'line' &&
        tiny(loop[loop.length - 1].P[0], loop[loop.length - 1].P[1])
      )
        loop.pop();
      const last = loop[loop.length - 1],
        e = last.P[last.P.length - 1];
      if ((e[0] !== start[0] || e[1] !== start[1]) && tiny(e, start))
        last.P = [...last.P.slice(0, -1), start];
    }

    const snapped = loop.length >= 2 ? snapSubPrecisionHandles(snapSubPrecisionLines(loop)) : loop;
    for (const e of snapped) {
      const src = { ...e.source };
      e.P.forEach((q, j) => {
        src['p' + (j + 1)] = q;
      });
      e.source = src;
    }
    contours.push(snapped);
  }
  const certStatus = statusOut ? { declined: false } : null;
  const cert = certifySimplePolynomialPaint(contours, evenOdd, {
    changesOnly: true,
    arcs,
    statusOut: certStatus,
  });
  if (!cert) {
    if (statusOut && certStatus && certStatus.declined) statusOut.status = FILL_NORM_DECLINED;
    return null;
  }
  if (statusOut) statusOut.status = FILL_NORM_CERTIFIED;
  const kept = new Set(cert.curves.map((c) => c.contour));
  const reversed = cert.curves.map((c) => c.P[0] !== c.source.p1);
  // A global reversal leaves absolute Green coverage unchanged. Avoid copying
  // records and allocating a second band region when all boundaries agree.
  if (kept.size === cs.length && (reversed.every(Boolean) || reversed.every((v) => !v)))
    return null;
  const out = [];
  for (let i = 0; i < cert.curves.length; i++) {
    const c = cert.curves[i],
      g = { ...c.source };
    delete g.is_fill_only;
    if (g.type === 3) {
      // an arc reversed is the same ellipse traveled the other way (the convention of pathBoolean's reverseSeg)
      g.p1 = c.P[0];
      g.p4 = c.P[1];
      if (c.P[0] !== c.source.p1) {
        g.theta_start = c.source.theta_end;
        g.theta_end = c.source.theta_start;
        g.sweep_flag = c.source.sweep_flag ? 0 : 1;
      }
    } else
      c.P.forEach((p, j) => {
        g['p' + (j + 1)] = p;
      });
    out.push(g);
    if (i === cert.curves.length - 1 || cert.curves[i + 1].contour !== c.contour) {
      const start = cert.curves.find((q) => q.contour === c.contour).P[0],
        end = c.P.at(-1);
      out.push({ type: 0, p1: end, p2: start, is_fill_only: true });
    }
  }
  return out;
}
