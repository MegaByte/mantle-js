// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// segmentSet.js — collect all pairwise intersections among a set of
// segments, then split each segment at its intersection points.
// Output: an array of "elementary" segments that don't cross each
// other except at endpoints. This is the precondition for DCEL
// construction.
//
// Complexity: O(N²) pairwise intersections. For N < 200 (typical
// bundle) that's < 40000 kernel calls — each is microsecond-fast.
// A proper Bentley-Ottmann sweep would be O(N log N + K), better for
// large N, but the constant factors make sweep slower for small N
// and significantly more complex to get right.

import { intersectSegments } from '../intersect/index.js';
import { splitSegAt } from '../subdivide.js';
import { segStart, segEnd } from '../../segment.js';

const EPS = 1e-7;

/** Take an array of (already y-monotone) segments and split each at
 *  every interior parameter where it intersects another segment.
 *  The output set has the property that any two segments only share
 *  endpoint points (no interior crossings).
 *
 *  Each output segment carries provenance:
 *    { seg, shapeIdx, subpathIdx, origDirection, fillRule }
 *  so the downstream DCEL construction can rebuild the original
 *  topology + fill semantics.
 *
 *  @typedef {Object} SplitSegment
 *  @property {object} seg
 *  @property {number} shapeIdx
 *  @property {number} subpathIdx
 *  @property {number} origDirection
 *  @property {'nonzero'|'evenodd'} fillRule
 */

/**
 *  @param {SplitSegment[]} inputs
 *  @returns {SplitSegment[]}
 */
export function intersectAndSplit(inputs, intersect) {
  const N = inputs.length;
  const isect = intersect || intersectSegments;
  // Per-input list of interior parameters where this segment is
  // intersected. Endpoints (param 0 or 1) are excluded because they
  // were already vertices in the original geometry.
  const splitParams = new Array(N);
  for (let i = 0; i < N; i++) splitParams[i] = [];

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const hits = isect(inputs[i].seg, inputs[j].seg);
      for (const h of hits) {
        if (h.tA > EPS && h.tA < 1 - EPS) splitParams[i].push(h.tA);
        if (h.tB > EPS && h.tB < 1 - EPS) splitParams[j].push(h.tB);
      }
    }
  }

  const out = [];
  for (let i = 0; i < N; i++) {
    const ts = splitParams[i];
    if (ts.length === 0) {
      out.push(inputs[i]);
      continue;
    }
    // Sort and de-duplicate.
    ts.sort((a, b) => a - b);
    const uniq = [];
    for (const t of ts) {
      if (uniq.length === 0 || t - uniq[uniq.length - 1] > 1e-6) uniq.push(t);
    }
    // Split at each parameter, re-parameterizing for subsequent splits.
    let current = inputs[i].seg;
    let prevT = 0;
    for (const t of uniq) {
      const localT = (t - prevT) / (1 - prevT);
      const [left, right] = splitSegAt(current, localT);
      if (left) {
        out.push({
          seg: left,
          shapeIdx: inputs[i].shapeIdx,
          subpathIdx: inputs[i].subpathIdx,
          origDirection: inputs[i].origDirection,
          fillRule: inputs[i].fillRule,
        });
      }
      current = right;
      prevT = t;
    }
    if (current) {
      out.push({
        seg: current,
        shapeIdx: inputs[i].shapeIdx,
        subpathIdx: inputs[i].subpathIdx,
        origDirection: inputs[i].origDirection,
        fillRule: inputs[i].fillRule,
      });
    }
  }
  return out;
}

/** Snap two points to the same value if they're within tolerance.
 *  Used by the DCEL builder to coalesce near-coincident endpoints
 *  into the same vertex.
 */
export function pointKey(p, tol = 1e-5) {
  // Round to a grid finer than tol, then stringify. Two points that
  // round to the same grid are considered the same vertex.
  const scale = 1 / tol;
  const x = Math.round(p[0] * scale) / scale;
  const y = Math.round(p[1] * scale) / scale;
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

// Re-export for callers to inspect segment endpoints without
// importing segment.js directly.
export { segStart, segEnd };
