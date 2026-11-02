// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// intersect/exact.js — the pair intersector a boolean operation should hand unionPaths.

import { SEG_QUAD, SEG_CUBIC } from '../../segment.js';
import { intersectSegments } from './index.js';
import { exactCrossings } from '../../../geom/cpatchGraph.js';

const isCurve = (sg) => sg.type === SEG_QUAD || sg.type === SEG_CUBIC;
const toTP = (sg) =>
  sg.type === SEG_CUBIC
    ? { t: 'cubic', P: [sg.p1, sg.p2, sg.p3, sg.p4] }
    : { t: 'quad', P: [sg.p1, sg.p2, sg.p3] };

/** intersectSegments' contract, (segA, segB) -> [{ tA, tB, x, y }], without the clipper's misses. */
export function intersectSegmentsExact(A, B) {
  let hits = null;
  try {
    hits = intersectSegments(A, B);
  } catch {
    hits = null;
  }
  if (!isCurve(A) || !isCurve(B)) return hits || [];
  // A pair the kernel answered as ONE curve has no crossings to add: the composition along a curve
  // that coincides with it is rounding noise, and at some scales it "found" a crossing at a point of
  // the shared stretch -- a cut on one copy of a doubled edge that its reversed twin did not get,
  // which left the planar graph with two edges that overlap and emptied the union.
  if (hits && hits.some((h) => h.sameCurve)) return hits;
  let extra = null;
  try {
    extra = exactCrossings(toTP(A), toTP(B), hits);
  } catch {
    extra = null;
  }
  // Recover one-sided implicit roots only after both methods found no crossings.
  // Keep quadratic pairs on their established path.
  if (
    A.type === SEG_CUBIC &&
    B.type === SEG_CUBIC &&
    (!hits || !hits.length) &&
    (!extra || !extra.length)
  ) {
    try {
      extra = exactCrossings(toTP(A), toTP(B), hits, true);
    } catch {
      extra = null;
    }
  }
  return extra && extra.length ? (hits || []).concat(extra) : hits || [];
}
