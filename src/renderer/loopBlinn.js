// loopBlinn.js — additive Loop-Blinn hybrid fill mesh builder.
//
// Resolution-independent SOLID-FILL alternative to the Slug per-fragment
// ray-cast: triangulate the interior, emit one control-hull region per curve
// carrying its EXACT implicit; the fragment shader keeps the fill side (cheap
// ALU, no ray-cast). Watertight on quads + cubics (convex / deep-concave /
// inflecting-S) and punch-out holes, with exact closed-form math (no sampling).
//
// Pure / no GL. Produces em-space geometry; the renderer applies the em→NDC
// transform in the vertex shader exactly as the Slug path does.
//
// Curve implicit (the key idea, no klmn case tables):
//   - quadratic: control triangle (P0,P1,P2), texcoords (0,0),(½,0),(1,1),
//     implicit f = u²−v.
//   - cubic: the EXACT Bezout resultant Res_t(x(t)−x, y(t)−y) — a 3×3
//     determinant of linear forms in (x,y), evaluated in a per-curve normalized
//     frame for 32-bit precision. Machine-exact (|det| on the curve ~1e-14).
//
// Additive model: route each curve's interior rim through the CONVEX side of
// its control structure (chord for convex curves, control points for concave),
// so every curve's missing sliver is exterior and gets ADDED — no subtraction,
// so overlaps are harmless for a solid color (holes + concavity both work).
//
// Falls back to Slug for: loop/cusp cubics (rare — detected exactly), and any
// non-solid paint (gradient/stroke/image/blend/clip/mask) the caller filters.

import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';


/** @typedef {{type:number,p1:number[],p2?:number[],p3?:number[],p4?:number[]}} Seg */







import { earcut } from './lbEarcut.js';
import { _setKeyOrigin, circleFromContours, extractAnnuli } from './lbContour.js';
export { curveRangeToContours, _setKeyOrigin } from './lbContour.js';   // barrel: decode surface
export { bezoutCubicImplicit, evalBezout, cubicKLMN, partitionCubicSplitTs, uvInHull } from './lbCubicMath.js';   // barrel: public math surface
export { LB_VERT_FLOATS, packLoopBlinnMesh, transformLoopBlinnRaw, lbCanonicalFrame, lbCanonicalHash } from './lbPack.js';   // barrel: pack/reuse surface
import { _healCand } from './lbInteriorSplit.js';
import { buildRims, buildCornerCaps2, turnsEqual, flattenRims, rimLens, assemble, healCracks, buildLoopBlinnMesh } from './lbFastMesh.js';
export { selfOrientRows, buildLoopBlinnMesh } from './lbFastMesh.js';   // barrel: fast-path surface
import { buildLoopBlinnPartition } from './lbPartition.js';
export { buildLoopBlinnPartitionPair, partitionPairMidError } from './lbPartitionPair.js';   // barrel: morph-pair surface









export function buildLoopBlinnCDT(contours, opts) {
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const circ = circleFromContours(contours);
  if (circ) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], circles: [circ], _topo: null };
  // Pull out concentric circular RINGS → exact annulus SDF; the rest builds below.
  const _ann = extractAnnuli(contours, opts && opts.fillRule);
  contours = _ann.rest;
  if (!contours.length) return { interior: new Float32Array(0), interiorEdges: null, quads: [], cubics: [], edges: [], fallback: [], annuli: _ann.annuli, _topo: null };
  // DEFAULT ROUTE (post-annulus): line/quad/rquad/cubic shapes build the exact partition
  // (control points in the CDT, exact partition, one side-bit per segment).
  // Runs AFTER annulus extraction so full circle pairs keep the exact SDF path
  // (kappa-circle cubics have near-degenerate klmn frames), but only when the
  // extraction is ALL-OR-NOTHING — a partially consumed shape (one ring of a
  // two-ring composite) would leave partition building half the geometry (arcRing).
  if (!_ann.annuli.length) {
    let ok9 = true;
    for (const c9 of contours) { for (const s9 of c9) { if (s9.type !== SEG_LINE && s9.type !== SEG_QUAD && s9.type !== SEG_RQUAD && s9.type !== SEG_CUBIC) { ok9 = false; break; } } if (!ok9) break; }
    if (ok9) {
      let pp9 = null;
      try { pp9 = buildLoopBlinnPartition(contours, opts); }
      catch (e9) { pp9 = null; if (typeof globalThis !== 'undefined') globalThis.__lbPartitionErr = String(e9 && e9.stack || e9).slice(0, 500); }
      if (pp9) return pp9;
    }
  }
  // After circle/annulus extraction (thin rings legitimately have cross-contour
  // chord sag, handled exactly by the SDF kinds), detect remaining outline
  // overlap. Shapes the exact partition builder declines go to the caller's
  // per-shape Slug fallback.
  return null;
}

// (buildLoopBlinnCDTPair deleted — the partition pair serves every morph class;
//  see buildLoopBlinnPartitionPair + segmentPartitionPairMorph)

// Fixed-topology streaming refresh: rebuild the rims/curves/edges from NEW
// contour coordinates but REUSE the previous earcut triangulation when the rim
// STRUCTURE is unchanged (same contour/rim/hole lengths, no new loop-cusp
// fallback). Skips the O(n log n) earcut — the only superlinear step — so a
// morph/road that deforms a fixed topology refreshes in O(n). Falls back to a
// full buildLoopBlinnMesh when the structure changed (a curve flipped
// convex↔concave, gained/lost an inflection, or a loop/cusp appeared).
export function refreshLoopBlinnMesh(prev, contours) {
  if (!prev || !prev._topo) return buildLoopBlinnMesh(contours);
  const r = buildRims(contours);
  const { coords, holeStarts } = flattenRims(r.rims);
  const t = prev._topo, lens = rimLens(r.rims);
  let same = lens.length === t.rimLens.length && holeStarts.length === t.holeStarts.length
          && r.fallback.length === prev.fallback.length;
  if (same) for (let i = 0; i < lens.length; i++) if (lens[i] !== t.rimLens[i]) { same = false; break; }
  if (same) for (let i = 0; i < holeStarts.length; i++) if (holeStarts[i] !== t.holeStarts[i]) { same = false; break; }
  // Rim STRUCTURE check (not just lengths): equal-length rims can still have a
  // different convex/reflex layout — a curve flipping convex↔concave, or a
  // ring-road slot teleporting to a different depth band when scroll crosses a
  // group boundary — which invalidates the cached triangulation ("wrong wedges"
  // / under-fill gaps). The rim turn-sign fingerprint catches both; rebuild on
  // a miss.
  if (same && !turnsEqual(r.turns, t.turns)) same = false;
  // Validity guard: the cached triangulation stays correct only if the new
  // coordinates don't FOLD it — every reused triangle must keep one consistent
  // orientation and stay non-degenerate. If deformation flipped/collapsed any
  // triangle, re-triangulate from scratch (correctness over the streaming win).
  if (same) {
    let sgn = 0;
    const tr = t.tris;
    for (let k = 0; k < tr.length; k += 3) {
      const a = coords[tr[k]], b = coords[tr[k + 1]], c = coords[tr[k + 2]];
      const ar = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const s = ar > 1e-7 ? 1 : ar < -1e-7 ? -1 : 0;
      if (s === 0 || (sgn !== 0 && s !== sgn)) { same = false; break; }
      if (sgn === 0) sgn = s;
    }
  }
  const tris = same ? t.tris : earcut(coords, holeStarts.length ? holeStarts : null);
  const mesh = assemble(r, coords, tris, holeStarts, t.ramped);
  mesh.caps = t.ramped ? buildCornerCaps2(contours) : [];
  mesh.curveStrips = !!t.ramped;
  if (t.ramped) healCracks(mesh);
  return mesh;
}

