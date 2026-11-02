// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Correct per-shape inside test for probes — fill-rule aware, multi-contour, and
// exact on native curves (line/quad/rquad/arc/cubic). A naive even-odd ray-crossing
// over concatenated points is wrong for multi-contour / nonzero-fill / layered
// shapes (the tiger, for one); use this instead.
//
// Uses the same signed winding the CDT builder uses (lbContour.rayWinding over a
// FLAT seg list), so "inside" matches what the builder considers filled.
//
//   import { shapeInsideTest, shapeFillRule } from './_shapeInside.mjs';
//   const inside = shapeInsideTest(contours, fillRule);   // (x,y) -> bool
import { rayWinding, buildSegWindingTree, treeWinding } from '../src/geom/lbContour.js';

/** fillRule for shape `s`: reads meta texel 13 (the evenodd flag the builder sets). */
export function shapeFillRule(bundle, s) {
  const mst = bundle.metaFloatsPerShape | 0;
  // bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by 8 floats and sends most
  // shapes down the CDT partition, so a build measured that way is 20x the real one. Strip it, as the tests do.
  const meta = bundle.meta ? new Float32Array(bundle.meta, 32) : bundle.metaFloats;
  if (!meta || !mst) return 'nonzero';
  return meta[s * mst + 13] > 0.5 ? 'evenodd' : 'nonzero';
}

/** Build an inside(x,y) predicate for a shape's contours under `fillRule`.
 *  `contours` may be nested (array of contours) or a flat seg list. */
export function shapeInsideTest(contours, fillRule = 'nonzero') {
  const segs = Array.isArray(contours) && Array.isArray(contours[0]) ? contours.flat() : contours;
  // Guard: rayWinding's cubic branch reads p4, which SEG_ARC (type 3) lacks. If any
  // arc survived (curveRangeToContours usually emits rquad=4, not arc=3), fall back
  // to a dense-polyline winding so the test never throws.
  const hasArc = segs.some((s) => s && s.type === 3);
  if (hasArc) return denseWindingTest(segs, fillRule);
  const tree = buildSegWindingTree(segs);
  const wind = tree ? (x, y) => treeWinding(tree, segs, x, y) : (x, y) => rayWinding(segs, x, y);
  const eo = fillRule === 'evenodd';
  return (x, y) => {
    const w = wind(x, y);
    return eo ? (w & 1) !== 0 : w !== 0;
  };
}

// Dense-polyline signed-winding fallback (arcs / robustness). Flattens each seg to
// 64 chords and counts signed y-crossings — nonzero: w!=0, evenodd: parity.
function denseWindingTest(segs, fillRule) {
  const pts = [],
    breaks = [];
  const eval2 = (s, t) => {
    const u = 1 - t;
    if (s.type === 0) return [s.p1[0] * u + s.p2[0] * t, s.p1[1] * u + s.p2[1] * t];
    if (s.type === 1 || s.type === 4) {
      const w = s.type === 4 ? s.w : 1;
      const a = u * u,
        b = 2 * w * u * t,
        c = t * t,
        d = a + b + c;
      return [
        (a * s.p1[0] + b * s.p2[0] + c * s.p3[0]) / d,
        (a * s.p1[1] + b * s.p2[1] + c * s.p3[1]) / d,
      ];
    }
    if (s.type === 3) {
      const th = s.thetaStart + (s.thetaEnd - s.thetaStart) * t,
        ph = s.phi || 0;
      const cx = Math.cos(th) * s.rx,
        cy = Math.sin(th) * s.ry,
        cp = Math.cos(ph),
        sp = Math.sin(ph);
      return [s.cx + cx * cp - cy * sp, s.cy + cx * sp + cy * cp];
    }
    return [
      u * u * u * s.p1[0] + 3 * u * u * t * s.p2[0] + 3 * u * t * t * s.p3[0] + t * t * t * s.p4[0],
      u * u * u * s.p1[1] + 3 * u * u * t * s.p2[1] + 3 * u * t * t * s.p3[1] + t * t * t * s.p4[1],
    ];
  };
  const endP = (s) => (s.type === 0 ? s.p2 : s.type === 2 ? s.p4 : s.p3);
  // group into contours by endpoint continuity
  let cur = [];
  for (const s of segs) {
    if (cur.length) {
      const prev = endP(cur[cur.length - 1]);
      if (Math.hypot(prev[0] - s.p1[0], prev[1] - s.p1[1]) > 1e-3) {
        breaks.push(cur);
        cur = [];
      }
    }
    cur.push(s);
  }
  if (cur.length) breaks.push(cur);
  const loops = breaks.map((c) => {
    const P = [];
    for (const s of c) for (let i = 0; i < 64; i++) P.push(eval2(s, i / 64));
    return P;
  });
  const eo = fillRule === 'evenodd';
  return (x, y) => {
    let w = 0;
    for (const P of loops)
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const a = P[i],
          b = P[j];
        if (a[1] > y !== b[1] > y) {
          const xc = ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0];
          if (xc > x) w += a[1] > b[1] ? 1 : -1;
        }
      }
    return eo ? (w & 1) !== 0 : w !== 0;
  };
}
