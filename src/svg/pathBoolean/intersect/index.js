// intersect/index.js — type-pair dispatcher for segment-segment
// intersection. Returns an array of intersection records, each
//   { tA, tB, x, y, endpointA, endpointB }
// where tA is the parameter on segA in [0, 1] and tB on segB.
//
// Covers all 10 type-pairs (LINE/QUAD/CUBIC/ARC).

import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../../segment.js';
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
export function intersectSegments(segA, segB) {
  const tA = segA.type, tB = segB.type;
  // Normalise to (lo, hi) by type so we only have to write each
  // kernel once. swap=true means the kernel's tA/tB need flipping.
  let lo = segA, hi = segB, swap = false;
  if (tA > tB) {
    lo = segB; hi = segA; swap = true;
  }
  const k = lo.type * 4 + hi.type;
  let raw;
  switch (k) {
    case SEG_LINE  * 4 + SEG_LINE:
      raw = intersectLineLine(lo.p1, lo.p2, hi.p1, hi.p2);
      break;
    case SEG_LINE  * 4 + SEG_QUAD:
      raw = intersectLineQuad(lo.p1, lo.p2, hi.p1, hi.p2, hi.p3);
      break;
    case SEG_LINE  * 4 + SEG_CUBIC:
      raw = intersectLineCubic(lo.p1, lo.p2, hi.p1, hi.p2, hi.p3, hi.p4);
      break;
    case SEG_LINE  * 4 + SEG_ARC:
      raw = intersectLineArc(lo.p1, lo.p2, hi);
      break;
    case SEG_QUAD  * 4 + SEG_QUAD:
      raw = intersectQuadQuad(lo.p1, lo.p2, lo.p3, hi.p1, hi.p2, hi.p3);
      break;
    case SEG_QUAD  * 4 + SEG_ARC:
      raw = intersectQuadArc(lo.p1, lo.p2, lo.p3, hi);
      break;
    case SEG_QUAD  * 4 + SEG_CUBIC:
      raw = intersectQuadCubic(lo.p1, lo.p2, lo.p3, hi.p1, hi.p2, hi.p3, hi.p4);
      break;
    case SEG_CUBIC * 4 + SEG_CUBIC:
      raw = intersectCubicCubic(lo.p1, lo.p2, lo.p3, lo.p4, hi.p1, hi.p2, hi.p3, hi.p4);
      break;
    case SEG_CUBIC * 4 + SEG_ARC:
      raw = intersectCubicArc(lo.p1, lo.p2, lo.p3, lo.p4, hi);
      break;
    case SEG_ARC   * 4 + SEG_ARC:
      raw = intersectArcArc(lo, hi);
      break;
    default:
      throw new Error(`intersectSegments: kernel for (${lo.type}, ${hi.type}) not yet implemented`);
  }
  if (!swap) return raw;
  // Swap tA <-> tB and endpointA <-> endpointB for the caller's view.
  return raw.map(r => ({
    tA: r.tB, tB: r.tA, x: r.x, y: r.y,
    endpointA: r.endpointB, endpointB: r.endpointA,
  }));
}

export {
  intersectLineLine, intersectLineQuad, intersectLineCubic, intersectLineArc,
  intersectQuadQuad, intersectQuadArc, intersectQuadCubic,
  intersectCubicCubic, intersectCubicArc,
  intersectArcArc,
};
