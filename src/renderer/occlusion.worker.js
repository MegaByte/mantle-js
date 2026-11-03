// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusion.worker.js — off-thread hunt for shapes a later opaque shape fully
// covers. Pure O(shapes² + shapes·G²) geometry over the curve/meta floats, no GL and
// no DOM, so it runs entirely off the main thread. Mirrors occupancy.worker.js.
//
// Only the PERF half runs here. createBundle already ran the cheap 'coincident' pass
// inline, because that one is a CORRECTNESS fix (it removes the antialiased-edge
// conflation fringe) and must be in effect on the very first frame. What is left —
// finding hidden shapes that keep clear of their occluder's boundary — buys nothing
// but draws, so nothing is wrong while it is still in flight.

import { computeOccludedShapes } from './occlusionCull.js';
import { computeMorphOccludedShapes } from './morphCull.js';

self.onmessage = (e) => {
  const d = e.data || {};
  const { id, cv, meta, n, stride, ranges } = d;
  let culled = [];
  try {
    // A morph job carries both poses. Hidden-at-t=0 says nothing about t=1, so this
    // decides containment analytically across the whole animation (morphCull.js).
    const set = d.cv1
      ? computeMorphOccludedShapes(cv, d.cv1, ranges, meta, d.meta1, n | 0, stride | 0)
      : computeOccludedShapes(cv, ranges, meta, n | 0, stride | 0, 'full');
    culled = [...set];
  } catch {
    culled = [];
  }
  self.postMessage({ id, culled });
};
