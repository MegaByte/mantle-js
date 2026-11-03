// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Recognize and pack static circle/ellipse primitives for the shared fill stream.
// Unrecognized shapes keep the caller's fallback sentinel.

import { curveRangeToContours } from '../geom/lbContour.js';
import { circleFromContours, ellipseFromContours } from '../geom/shapeRecognize.js';
import { packLoopBlinnMesh } from './lbPack.js';

/// One shape's contours → a packed primitive mesh, or null when nothing is recognized.
export function primMeshFor(contours) {
  if (!contours || !contours.length) return null;
  const prim = circleFromContours(contours) || ellipseFromContours(contours);
  if (!prim) return null;
  let pm = null;
  try {
    pm = packLoopBlinnMesh({
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      circles: [prim],
      _topo: null,
    });
  } catch {
    return null;
  }
  if (!pm || !(pm.vertexCount | 0)) return null;
  return {
    verts: pm.verts,
    vertexCount: pm.vertexCount,
    fallback: false,
    cpatch: false,
    slug: false,
    prim: true,
    kindMask: pm.kindMask,
  };
}

/// A whole static bundle → the per-shape mesh array (primitive where recognized, `sentinel`
/// elsewhere), or null when NO shape is a primitive. Returning null is the point: a bundle with no
/// primitive must not be pulled onto the shared stream just to be handed straight back.
export function buildPrimMeshes(bundle, sentinel) {
  const ranges = bundle && bundle.curveRangesByShape;
  if (!ranges || !ranges.length) return null;
  const cf =
    bundle.curveFloats64 &&
    bundle.curveFloats &&
    bundle.curveFloats64.length >= bundle.curveFloats.length
      ? bundle.curveFloats64
      : bundle.curveFloats;
  if (!cf) return null;
  const out = new Array(ranges.length).fill(sentinel);
  let any = false;
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      contours = null;
    }
    const m = primMeshFor(contours);
    if (m) {
      out[s] = m;
      any = true;
    }
  }
  return any ? out : null;
}
