// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// loopBlinn.js — additive Loop-Blinn hybrid fill mesh builder.
//
// Resolution-independent SOLID-FILL alternative to the Slug per-fragment
// ray-cast: triangulate the interior, emit one control-hull region per curve
// carrying its exact implicit; the fragment shader keeps the fill side (cheap
// ALU, no ray-cast). Watertight on quads + cubics (convex / deep-concave /
// inflecting-S) and punch-out holes, with exact closed-form math (no sampling).
//
// Pure / no GL. Produces em-space geometry; the renderer applies the em→NDC
// transform in the vertex shader exactly as the Slug path does.
//
// Curve implicit (the key idea, no klmn case tables):
//   - quadratic: control triangle (P0,P1,P2), texcoords (0,0),(½,0),(1,1),
//     implicit f = u²−v.
//   - cubic: the exact Bezout resultant Res_t(x(t)−x, y(t)−y) — a 3×3
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

import { mantleWarn } from '../core/diagnostics.js';
import { earcut } from '../geom/lbEarcut.js';
import { _setKeyOrigin, extractAnnuli } from '../geom/lbContour.js';
import { circleFromContours, ellipseFromContours } from '../geom/shapeRecognize.js';
export {
  curveRangeToContours,
  _setKeyOrigin,
  lbFrameOrigin,
  translateContours,
} from '../geom/lbContour.js'; // barrel: decode surface
export {
  bezoutCubicImplicit,
  evalBezout,
  cubicKLMN,
  partitionCubicSplitTs,
  uvInHull,
} from '../geom/lbCubicMath.js'; // barrel: public math surface
export {
  LB_VERT_FLOATS,
  LB_VERT_BYTES,
  LB_MAX_VERTS_PER_MESH,
  LB_MAX_VERTS_PER_BUNDLE,
  packLoopBlinnMesh,
  transformLoopBlinnRaw,
  translateLoopBlinnRaw,
  lbCanonicalFrame,
  lbCanonicalHash,
  lbCanonicalHashes,
  setLbShapeMemoryBudget,
  getLbShapeMemoryBudget,
  lbVertexBytes,
  lbRawMinVertexBytes,
} from './lbPack.js'; // barrel: pack/reuse surface
import { _healCand } from './lbInteriorSplit.js';
import {
  buildRims,
  turnsEqual,
  layoutRims,
  triangulateLayout,
  rimLens,
  assemble,
  healCracks,
  buildLoopBlinnMesh,
  resolveSelfOverlap,
} from './lbFastMesh.js';
export {
  selfOrientRows,
  buildLoopBlinnMesh,
  dropDegenerateFaces,
  setPreferBezout,
  getPreferBezout,
} from './lbFastMesh.js'; // barrel: fast-path surface
import { buildLoopBlinnPartition } from './lbPartition.js';
import { cutPinches } from './lbFastResolve.js';
export { buildLoopBlinnPartitionPair } from './lbPartitionPair.js'; // barrel: morph-pair surface

// A decline is a null RETURN, NOT A THROW. buildLoopBlinnPartition reports a shape it cannot
// partition by returning null, so anything it THROWS is a bug in this code — and catching that
// into the same per-shape Slug fallback made a TypeError or a missing import indistinguishable
// from a geometric decline. Programming errors are rethrown (the callers' own handlers still fall
// back to Slug, and lbBuildCore reports the swallow once); anything else is recorded in
// __lbPartitionErr for the build-route smoke and reported once through the package's warn helper.
let _warnedPartitionThrow = false;
function partitionThrew(e9) {
  if (typeof globalThis !== 'undefined')
    globalThis.__lbPartitionErr = String((e9 && e9.stack) || e9).slice(0, 500);
  if (!_warnedPartitionThrow) {
    _warnedPartitionThrow = true;
    mantleWarn(
      '[mantle] the Loop-Blinn partition threw and this shape fell back to Slug; ' +
        'reported once per session:\n' +
        String((e9 && e9.stack) || e9),
    );
  }
  if (e9 instanceof TypeError || e9 instanceof ReferenceError || e9 instanceof RangeError) throw e9;
}

export function buildLoopBlinnCDT(contours, opts) {
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const circ = circleFromContours(contours);
  if (circ)
    return {
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      circles: [circ],
      _topo: null,
    };
  const ell = ellipseFromContours(contours);
  if (ell)
    return {
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      circles: [ell],
      _topo: null,
    };
  // Pull out concentric circular RINGS → exact annulus SDF; the rest builds below.
  const _ann = extractAnnuli(contours, opts && opts.fillRule);
  contours = _ann.rest;
  if (!contours.length)
    return {
      interior: new Float32Array(0),
      interiorEdges: null,
      quads: [],
      cubics: [],
      edges: [],
      fallback: [],
      annuli: _ann.annuli,
      _topo: null,
    };

  if (!_ann.annuli.length) {
    let ok9 = true;
    for (const c9 of contours) {
      for (const s9 of c9) {
        if (
          s9.type !== SEG_LINE &&
          s9.type !== SEG_QUAD &&
          s9.type !== SEG_RQUAD &&
          s9.type !== SEG_CUBIC
        ) {
          ok9 = false;
          break;
        }
      }
      if (!ok9) break;
    }
    if (ok9) {
      let pp9 = null;
      try {
        pp9 = buildLoopBlinnPartition(contours, opts);
      } catch (e9) {
        pp9 = null;
        partitionThrew(e9);
      }
      if (pp9) return pp9;
      // The partition DECLINED (returned null). One cause is a SELF-OVERLAPPING
      // outline: two segments of a contour overlap with opposite winding (common
      // in exported art where strokes were flattened to fills), leaving a
      // winding-0 sliver the per-crescent fill-side test cannot honor — both
      // overlapping crescents paint the sliver (each reads its own f<0) while the
      // true fill is empty there, so the shape over-paints AIR and declines
      // Retry ONCE from the exact union silhouette
      // (native cubics preserved), which has no winding-0 straddle. resolveSelfOverlap
      // returns the same contours unless the outline genuinely self-intersects, so
      // a shape that declined for any OTHER reason changes nothing and this second
      // build is skipped — clean shapes never pay for it and stay byte-identical.
      // STATIC only — morphs build through buildLoopBlinnPartitionPair, untouched.
      //
      // ...and resolveSelfOverlap has a THIRD answer: null, for an outline it cannot resolve. `!== contours`
      // alone would read that as a new set and retry on null, throwing inside the partition -- the shape
      // would decline by CRASHING rather than by deciding, and spend the once-per-session swallow report,
      // which is the channel a real build failure has to arrive on. So null is not retried.
      // A resolved crossing can come back pinched; cut it into its loops.
      const r9 = resolveSelfOverlap(contours, opts && opts.fillRule);
      const contours9 = r9 && r9 !== contours ? cutPinches(r9) : r9;
      if (contours9 && contours9 !== contours) {
        try {
          pp9 = buildLoopBlinnPartition(contours9, opts);
        } catch (e9) {
          pp9 = null;
          partitionThrew(e9);
        }
        if (pp9) return pp9;
      }
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
export function refreshLoopBlinnMesh(prev, contours, fillRule) {
  // The fallback is a FULL rebuild, so it needs the same rule the original build used; without it
  // a refresh silently reinterpreted an even-odd shape as nonzero.
  if (!prev || !prev._topo) return buildLoopBlinnMesh(contours, true, fillRule);
  // Same per-build setup as buildLoopBlinnMesh: the vertex-key origin is
  // scale-aware GLOBAL state (without the reset, rim quantization keys
  // against whichever shape built LAST — refresh output depended on
  // cross-shape build order), and a ramped refresh must not feed
  // healCracks another build's stale candidates. buildRims also gets the
  // ramped flag so a static mesh's refresh runs the same
  // degree-reduce/subdivide steps as its own build (count guards in the
  // earcut pair path silently lost the cheap route otherwise).
  _healCand.length = 0;
  _setKeyOrigin(contours);
  const r = buildRims(contours, !!prev._topo.ramped);
  const { coords, holeStarts, spans } = layoutRims(r.rims);
  const t = prev._topo,
    lens = rimLens(r.rims);
  let same =
    lens.length === t.rimLens.length &&
    holeStarts.length === t.holeStarts.length &&
    r.fallback.length === prev.fallback.length;
  if (same)
    for (let i = 0; i < lens.length; i++)
      if (lens[i] !== t.rimLens[i]) {
        same = false;
        break;
      }
  if (same)
    for (let i = 0; i < holeStarts.length; i++)
      if (holeStarts[i] !== t.holeStarts[i]) {
        same = false;
        break;
      }
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
      const a = coords[tr[k]],
        b = coords[tr[k + 1]],
        c = coords[tr[k + 2]];
      const ar = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      // AN AREA AGAINST THE TRIANGLE'S own SIZE, not against a constant. This asks whether the
      // triangle is non-degenerate, and an area scales as the SQUARE of the coordinates -- so a
      // fixed 1e-7 calls a small shape's honest triangle degenerate and a large shape's collapsed
      // one healthy. Over a 2^-4..2^4 sweep that threshold swings by 2^16.
      const e2m = Math.max(
        (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2,
        (c[0] - b[0]) ** 2 + (c[1] - b[1]) ** 2,
        (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2,
      );
      const aEps = 1e-10 * e2m;
      const s = ar > aEps ? 1 : ar < -aEps ? -1 : 0;
      if (s === 0 || (sgn !== 0 && s !== sgn)) {
        same = false;
        break;
      }
      if (sgn === 0) sgn = s;
    }
  }
  const tris = same ? t.tris : triangulateLayout(coords, spans);
  const mesh = assemble(r, coords, tris, holeStarts, t.ramped);

  if (t.ramped)
    mesh.bandArcs = mesh.quads
      .filter((q) => !q.circle && !q.tc)
      .map((q) => ({ tri: q.tri, sign: q.sign, w: q.w, e1: q.e1, e2: q.e2 }));
  if (t.ramped) healCracks(mesh);
  return mesh;
}
