// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// intersect/index.js — type-pair dispatcher for segment-segment
// intersection. Returns an array of intersection records, each
//   { tA, tB, x, y, endpointA, endpointB }
// where tA is the parameter on segA in [0, 1] and tB on segB.
//
// Covers all 10 type-pairs (LINE/QUAD/CUBIC/ARC).

import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../../segment.js';
import { canonicalScale, scaleSegBy } from '../canonical.js';
import { intersectLineLine } from './lineLine.js';
import { intersectLineQuad } from './lineQuad.js';
import { intersectLineCubic } from './lineCubic.js';
import { intersectLineArc } from './lineArc.js';
import { intersectQuadQuad } from './quadQuad.js';
import { intersectQuadArc } from './quadArc.js';
import { intersectQuadCubic } from './quadCubic.js';
import { intersectCubicCubic } from './cubicCubic.js';
import { intersectCubicArc } from './cubicArc.js';
import { intersectArcArc } from './arcArc.js';

/** Intersect two segments. Order-independent: returns intersections
 *  with `tA` referring to `segA` and `tB` to `segB` regardless of
 *  internal kernel orientation.
 *
 *  @param {object} segA
 *  @param {object} segB
 *  @returns {Array<{tA:number, tB:number, x:number, y:number, endpointA:boolean, endpointB:boolean}>}
 */
/// A segment that is a point crosses nothing, and must never reach a kernel.
///
/// Not defensiveness: intersectQuadCubic DOES NOT RETURN when one side has collapsed to a point. It
/// exhausts memory rather than spinning — a real asset (a quad whose three control points are
/// identical, followed by a cubic starting at that same point) took 600 MB and never finished,
/// while either segment alone is handled in a millisecond. Because the call never returns, a cap on
/// its RESULT cannot help; the check has to be here, before dispatch.
///
/// Returning no intersections is the right answer as well as the safe one. A zero-extent segment
/// bounds nothing, so there is no crossing for a caller to cut at, and every caller of this
/// function is asking where two BOUNDARIES meet.
///
/// Arcs are described by center and radii rather than control points, so they are left to their own
/// kernels — the collapse this guards against comes from path data, where a degenerate arc is
/// already normalized away by the importer.
///
function _pairTolerance(segA, segB) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    mag = 0;
  for (const sg of [segA, segB]) {
    const pts =
      sg.type === SEG_ARC
        ? [
            [sg.cx - Math.max(sg.rx, sg.ry), sg.cy - Math.max(sg.rx, sg.ry)],
            [sg.cx + Math.max(sg.rx, sg.ry), sg.cy + Math.max(sg.rx, sg.ry)],
          ]
        : [sg.p1, sg.p2, sg.p3, sg.p4];
    for (const q of pts) {
      if (!q) continue;
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
      mag = Math.max(mag, Math.abs(q[0]), Math.abs(q[1]));
    }
  }
  return Math.max(1e-9 * Math.max(x1 - x0, y1 - y0), 32e-15 * mag);
}
function _isPoint(sg, tol) {
  const a = sg.p1;
  if (!a) return false;
  if (sg.type === SEG_ARC) return false;
  const pts =
    sg.type === SEG_LINE ? [sg.p2] : sg.type === SEG_QUAD ? [sg.p2, sg.p3] : [sg.p2, sg.p3, sg.p4];
  for (const q of pts) {
    if (!q) continue;
    if (Math.abs(q[0] - a[0]) > tol || Math.abs(q[1] - a[1]) > tol) return false;
  }
  return true;
}

/// THE KERNELS WORK AT A CANONICAL EXTENT, and this is what puts them there.

/// The factor is a POWER OF TWO, so scaling in and back out is exact in binary floating point:
/// the returned parameters are unchanged and the returned points are bit-identical to what the
/// kernel would have produced, and the same pair gets the same answer at any size.
export function intersectSegments(segA, segB) {
  const tol = _pairTolerance(segA, segB);
  if (_isPoint(segA, tol) || _isPoint(segB, tol)) return [];
  const _f = canonicalScale([[segA, segB]]);
  if (_f !== 1) {
    const hits = intersectSegments(scaleSegBy(segA, _f), scaleSegBy(segB, _f));
    // t parameters are dimensionless; only the crossing POINT comes back in the scaled frame.
    return hits.map((r) => (r.x === undefined ? r : { ...r, x: r.x / _f, y: r.y / _f }));
  }
  const tA = segA.type,
    tB = segB.type;

  let lo = segA,
    hi = segB,
    swap = false;
  if (tA > tB) {
    lo = segB;
    hi = segA;
    swap = true;
  }
  const k = lo.type * 4 + hi.type;
  let raw;
  switch (k) {
    case SEG_LINE * 4 + SEG_LINE:
      raw = intersectLineLine(lo.p1, lo.p2, hi.p1, hi.p2);
      break;
    case SEG_LINE * 4 + SEG_QUAD:
      raw = intersectLineQuad(lo.p1, lo.p2, hi.p1, hi.p2, hi.p3);
      break;
    case SEG_LINE * 4 + SEG_CUBIC:
      raw = intersectLineCubic(lo.p1, lo.p2, hi.p1, hi.p2, hi.p3, hi.p4);
      break;
    case SEG_LINE * 4 + SEG_ARC:
      raw = intersectLineArc(lo.p1, lo.p2, hi);
      break;
    case SEG_QUAD * 4 + SEG_QUAD:
      raw = intersectQuadQuad(lo.p1, lo.p2, lo.p3, hi.p1, hi.p2, hi.p3);
      break;
    case SEG_QUAD * 4 + SEG_ARC:
      raw = intersectQuadArc(lo.p1, lo.p2, lo.p3, hi);
      break;
    case SEG_QUAD * 4 + SEG_CUBIC:
      raw = intersectQuadCubic(lo.p1, lo.p2, lo.p3, hi.p1, hi.p2, hi.p3, hi.p4);
      break;
    case SEG_CUBIC * 4 + SEG_CUBIC:
      raw = intersectCubicCubic(lo.p1, lo.p2, lo.p3, lo.p4, hi.p1, hi.p2, hi.p3, hi.p4);
      break;
    case SEG_CUBIC * 4 + SEG_ARC:
      raw = intersectCubicArc(lo.p1, lo.p2, lo.p3, lo.p4, hi);
      break;
    case SEG_ARC * 4 + SEG_ARC:
      raw = intersectArcArc(lo, hi);
      break;
    default:
      throw new Error(`intersectSegments: kernel for (${lo.type}, ${hi.type}) not yet implemented`);
  }
  if (!swap) return raw;
  // Swap tA <-> tB and endpointA <-> endpointB for the caller's view.
  return raw.map((r) => ({
    tA: r.tB,
    tB: r.tA,
    x: r.x,
    y: r.y,
    endpointA: r.endpointB,
    endpointB: r.endpointA,
    ...(r.sameCurve ? { sameCurve: true } : null),
  }));
}

export {
  intersectLineLine,
  intersectLineQuad,
  intersectLineCubic,
  intersectLineArc,
  intersectQuadQuad,
  intersectQuadArc,
  intersectQuadCubic,
  intersectCubicCubic,
  intersectCubicArc,
  intersectArcArc,
};
