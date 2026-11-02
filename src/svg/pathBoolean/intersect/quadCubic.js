// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// quadCubic — intersection of a quadratic Bezier with a cubic Bezier.
// Uses Bezier clipping (Sederberg & Nishita 1990). Up to 6
// intersections in theory; typically 2-4 in practice.
//
// The clipping kernel is unified across degrees: both curves are
// passed as Bernstein control-point arrays, length N+1 for degree N.

import { intersectBezierClip } from '../bezierClip.js';

export function intersectQuadCubic(qP1, qP2, qP3, cP1, cP2, cP3, cP4) {
  return intersectBezierClip([qP1, qP2, qP3], [cP1, cP2, cP3, cP4]);
}
