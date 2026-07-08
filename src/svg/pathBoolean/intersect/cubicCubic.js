// cubicCubic — intersection of two cubic Beziers via Bezier clipping
// (Sederberg & Nishita 1990). Up to 9 intersections.

import { intersectBezierClip } from '../bezierClip.js';

export function intersectCubicCubic(aP1, aP2, aP3, aP4, bP1, bP2, bP3, bP4) {
  return intersectBezierClip(
    [aP1, aP2, aP3, aP4],
    [bP1, bP2, bP3, bP4],
  );
}
