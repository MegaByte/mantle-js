// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMorphCore.js — GL-free morph-pair mesh construction.
//
// Extracted from morphDraw's _ensureBundleMorphMeshes so the same per-shape
// build runs OFF the main thread in lbBuild.worker.js (the static build already
// does). No `gl`, no renderer context — only the pure builders. The result is
// plain CPU data (interleaved Float32Array VBOs + counts) the main thread uploads.
//
// The main-thread copy in morphDraw stays as the synchronous fallback (worker
// unavailable / failed) and keeps its per-shape cache, budget and resumability;
// this module is the unbudgeted one-shot the worker runs.
import { curveRangeToContours } from '../geom/lbContour.js';
import { FS_GROUP_BEGIN, FS_GROUP_END, FS_KEPT_INVISIBLE } from '../bundle/layout.js';
import {
  buildEarcutPair,
  segmentPartitionPairMorph,
  refinePairByDrift,
  segmentMovingInflection,
} from './loopBlinnMorph.js';
import * as MORPH9 from './loopBlinnMorph.js';
import { buildLoopBlinnPartitionPair, lbPairDeclineWhy } from './lbPartitionPair.js';
import {
  packLoopBlinnMesh,
  LB_VERT_FLOATS,
  getLbShapeMemoryBudget,
  setLbShapeMemoryBudget,
} from './lbPack.js';
/// A pair's two poses are lerped vertex for vertex, so they pack one topology (lbPack's `pairedTopology`).
const PAIRED = Object.freeze({ pairedTopology: true });
import { SLUG_WHY } from './lbBuildCore.js';
import { mantleDebugHook } from '../core/diagnostics.js';

// Interleave src/dst packed verts into ONE VBO (vertex s.src, s.dst, …), the wire
// form the morph VS lerps. Identical to morphDraw._interleavePair.
function interleavePair(pkS, pkD) {
  const n = pkS.vertexCount,
    F = LB_VERT_FLOATS;
  const v = new Float32Array(n * F * 2);
  for (let i = 0; i < n; i++) {
    v.set(pkS.verts.subarray(i * F, i * F + F), i * F * 2);
    v.set(pkD.verts.subarray(i * F, i * F + F), i * F * 2 + F);
  }
  return v;
}

// Build ONE shape's morph-pair mesh. Mirrors the per-shape body of
// _ensureBundleMorphMeshes (minus the GL program gate, budget, cache). Returns:
//   { fill: false }  → no fill mesh needed (stroke-only): the caller pushes null
//   { mesh: null, why, pairWhy }  → non-morphable fill: the bundle renders via Slug. `why` is
//                      SLUG_WHY.DECLINED and `pairWhy` the partition pair's own cause
//                      (lbPairDeclineWhy), 'threw' or 'pack-mismatch'
//   { mesh: {...} }  → a plain or t-segmented partition-pair mesh
/// Both poses of a pair, packed as ONE mesh: the destination takes the source's ring plan (lbPack `_ringPlanFrom9`), so
/// a degenerate destination pose cannot ring a different set of edges than its source and refuse the morph.
/// Both keep the builder's order (`_keepOrder9`, which the pair builders set): the packer's own emission order sorts
/// faces and rings by what they carry, which two poses need not agree on, and the pair is lerped vertex for vertex.
// A pair packed for this shape has an interior face whose two chains do not span all the outline it touches. That face paints what its chains
// miss as solid and can read a truncated chain backwards, which on text at any size reads as whole pixels of over-coverage and holes (Slug is exact there).
// The mesh is still built and returned: a route that asked for LB draws it; the renderer's 'auto' takes this flag as a decline (morphDraw).
let _chainIncomplete9 = false;
function packPair9(pair) {
  if (pair.src.chainIncomplete9 || pair.dst.chainIncomplete9) _chainIncomplete9 = true;
  pair.src._keepOrder9 = true;
  pair.dst._keepOrder9 = true;
  const pkS = packLoopBlinnMesh(pair.src, undefined, PAIRED);
  pair.dst._ringPlanFrom9 = pair.src;
  try {
    return [pkS, packLoopBlinnMesh(pair.dst, undefined, PAIRED)];
  } finally {
    delete pair.dst._ringPlanFrom9;
  }
}

export function buildMorphShape(sc, dc, meta, dmeta, b, st) {
  _chainIncomplete9 = false;
  const hasPaint =
    Math.floor(meta[b + 28] + 0.5) !== 0 || (st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0);
  // Overrides can reveal kept invisible fills during a morph. Give those rows pair meshes
  // so they can render without updating the curve plane. Stroke-only rows need no fill mesh.
  const keptFill =
    ((Math.floor(meta[b + 27] + 0.5) | Math.floor(dmeta[b + 27] + 0.5)) & FS_KEPT_INVISIBLE) !==
      0 &&
    !(meta[b + 11] > 0) &&
    !(dmeta[b + 11] > 0);
  const hasFill = hasPaint || keptFill || meta[b + 7] > 0.004 || dmeta[b + 7] > 0.004;
  if (!hasFill) return { fill: false };
  const translucent = !hasPaint && (meta[b + 7] < 0.996 || dmeta[b + 7] < 0.996);
  const fillRule = meta[b + 13] > 0.5 ? 'evenodd' : 'nonzero';
  // WHY the pair declined. Read off the builder's live binding straight after the full-interval attempts, before the
  // t-segmented fallback builds dozens more pairs and overwrites it.
  let m = null,
    pairWhy = null;
  try {
    // EARCUT pair first (single-contour opaque; returns null on any structure
    // drift → falls to the partition pair), gated only on !translucent — exactly
    // as _ensureBundleMorphMeshes does.
    const pair =
      (!translucent && buildEarcutPair(sc, dc, fillRule)) ||
      buildLoopBlinnPartitionPair(sc, dc, fillRule) ||
      // PLAIN ROWS AS A LAST PAIR ATTEMPT, before giving the morph up to Slug. The corner-aware
      // row pass re-cuts each endpoint independently and is checked only by count, so it can
      // pair mismatched vertices whose lerp turns triangles inside out; the plain-row build
      // shares one row plan across both endpoints and does not. It costs corner AA fidelity and
      // keeps the analytic route, which is the better trade -- without this line a rotating
      // polygon falls all the way to Slug; with it, it morphs correctly through LB at every t.
      buildLoopBlinnPartitionPair(sc, dc, fillRule, { plainDstRows: true });
    if (!pair) pairWhy = lbPairDeclineWhy || '(unstamped)';
    // A PAIR OVER THE whole MORPH IS CERTIFIED BETWEEN ITS ENDPOINTS BY THE DRIFT ORACLE, as every flip segment
    // is: refinePairByDrift splits it where its lerped implicit strays past the bar, and a pair it cannot bring under
    // the bar draws through Slug rather than drawing a curve that is not the pose's.
    const refined = pair ? refinePairByDrift(sc, dc, fillRule, pair) : null;
    if (refined && refined.declined) pairWhy = 'drift';
    else if (refined) {
      const out = [];
      let ok = true;
      for (const sg of refined.segs) {
        const [pkS, pkD] = packPair9(sg.pair);
        if (!pkS.vertexCount || pkS.vertexCount !== pkD.vertexCount) {
          ok = false;
          break;
        }
        out.push({
          tLo: sg.tLo,
          tHi: sg.tHi,
          tLoB: sg.tLoB,
          tHiB: sg.tHiB,
          vbo: interleavePair(pkS, pkD),
          vertexCount: pkS.vertexCount,
          mode: 'partitionPair',
        });
      }
      if (ok && out.length)
        m = {
          mode: 'partitionPair',
          segments: out,
          vertexCount: out[0].vertexCount,
          hasSlug: false,
        };
      else pairWhy = 'pack-mismatch';
    } else if (pair) {
      const [pkS, pkD] = packPair9(pair);
      if (pkS.vertexCount === pkD.vertexCount && pkS.vertexCount > 0)
        m = {
          mode: 'partitionPair',
          vbo: interleavePair(pkS, pkD),
          vertexCount: pkS.vertexCount,
          hasSlug: false,
        };
      else pairWhy = 'pack-mismatch';
    }
  } catch {
    m = null;
    pairWhy = 'threw';
  }
  if (!m) {
    // FLIP morph: t-segmented pairs, one sub-interval per classification span.
    try {
      const segs = segmentPartitionPairMorph(sc, dc, fillRule);
      if (segs) {
        const out = [];
        let ok = true;
        for (const sg of segs) {
          const [pkS, pkD] = packPair9(sg.pair);
          if (!pkS.vertexCount || pkS.vertexCount !== pkD.vertexCount) {
            ok = false;
            break;
          }
          out.push({
            tLo: sg.tLo,
            tHi: sg.tHi,
            tLoB: sg.tLoB,
            tHiB: sg.tHiB,
            vbo: interleavePair(pkS, pkD),
            vertexCount: pkS.vertexCount,
            mode: 'partitionPair',
          });
        }
        if (ok && out.length)
          m = {
            mode: 'partitionPair',
            segments: out,
            vertexCount: out[0].vertexCount,
            hasSlug: false,
          };
      }
    } catch {
      /* Slug */
    }
  }
  if (!m) {
    // A MOVING INFLECTION, exactly: one pair whose piece holding the inflection is a SERPENTINE on both
    // poses -- no cut at either pose's inflection, so nothing bulges one way on one pose and the other way on the other.
    // Certified between its endpoints by the drift oracle like any pair; what it cannot certify falls to the fine
    // t-cells below.
    // The drift of a serpentine's lerped implicit is quadratic in the interval like any pair's, but can start far over
    // the bar, so its refinement may take more than the flip segmenter's few cells: as many as it needs, charged against
    // the per-shape memory budget exactly as the fine cells are.
    // The TEST HOOK `__LB_SERPENTINE_PAIR = false` (read only under `__MANTLE_DEBUG__`) is the fine-cells-only arm.
    // only for that class: a morph declined for anything else keeps the few-cell drift cap the flip segmenter has.
    let moving9 = null;
    try {
      moving9 = MORPH9.movingInflections(sc, dc);
    } catch {
      moving9 = null;
    }
    if (mantleDebugHook('__LB_SERPENTINE_PAIR') !== false && moving9 && moving9.length)
      try {
        const pair = buildLoopBlinnPartitionPair(sc, dc, fillRule, { serpentine9: true });
        const refined = pair
          ? refinePairByDrift(sc, dc, fillRule, pair, { serpentine9: true }, MORPH9.MORPH_CELL_MAX)
          : null;
        const segs =
          refined && !refined.declined
            ? refined.segs
            : pair && !refined
              ? [{ tLo: 0, tHi: 1, tLoB: 0, tHiB: 1, pair }]
              : null;
        if (segs) {
          const out = [];
          let ok = true,
            bytes = 0;
          const cap = getLbShapeMemoryBudget();
          for (const sg of segs) {
            const [pkS, pkD] = packPair9(sg.pair);
            if (!pkS.vertexCount || pkS.vertexCount !== pkD.vertexCount) {
              ok = false;
              break;
            }
            bytes += pkS.vertexCount * 2 * LB_VERT_FLOATS * 4;
            if (bytes > cap) {
              ok = false;
              break;
            }
            out.push({
              tLo: sg.tLo,
              tHi: sg.tHi,
              tLoB: sg.tLoB,
              tHiB: sg.tHiB,
              vbo: interleavePair(pkS, pkD),
              vertexCount: pkS.vertexCount,
              mode: 'partitionPair',
            });
          }
          if (ok && out.length === 1 && out[0].tLoB === 0 && out[0].tHiB === 1)
            m = {
              mode: 'partitionPair',
              vbo: out[0].vbo,
              vertexCount: out[0].vertexCount,
              hasSlug: false,
              serpentine: true,
              cells: 1,
              bytes,
            };
          else if (ok && out.length)
            m = {
              mode: 'partitionPair',
              segments: out,
              vertexCount: out[0].vertexCount,
              hasSlug: false,
              serpentine: true,
              cells: out.length,
              bytes,
            };
        }
      } catch {
        m = null;
      }
  }
  if (!m) {
    // A moving inflection: fine t-cells, each short enough that the pair's cut merge absorbs the piece that flips
    // (segmentMovingInflection). One mesh per cell, and the cells together are charged against the
    // per-shape memory budget -- a budget that the class can exceed by an order of magnitude (tens of MiB for an
    // S-curve) and that must refuse it before it is kept, as the static route's does.
    try {
      const segs = segmentMovingInflection(sc, dc, fillRule);
      if (segs) {
        const out = [];
        let ok = true,
          bytes = 0;
        const cap = getLbShapeMemoryBudget();
        for (const sg of segs) {
          const [pkS, pkD] = packPair9(sg.pair);
          if (!pkS.vertexCount || pkS.vertexCount !== pkD.vertexCount) {
            ok = false;
            pairWhy = 'pack-mismatch';
            break;
          }
          bytes += pkS.vertexCount * 2 * LB_VERT_FLOATS * 4;
          if (bytes > cap) {
            ok = false;
            pairWhy = 'over-memory';
            break;
          }
          out.push({
            tLo: sg.tLo,
            tHi: sg.tHi,
            tLoB: sg.tLoB,
            tHiB: sg.tHiB,
            vbo: interleavePair(pkS, pkD),
            vertexCount: pkS.vertexCount,
            mode: 'partitionPair',
          });
        }
        if (ok && out.length)
          m = {
            mode: 'partitionPair',
            segments: out,
            vertexCount: out[0].vertexCount,
            hasSlug: false,
            cells: out.length,
            bytes,
          };
      } else if (
        MORPH9.movingInflectionWhy === 'cells' ||
        MORPH9.movingInflectionWhy === 'cell-declined' ||
        MORPH9.movingInflectionWhy === 'drift'
      ) {
        pairWhy = 'inflection-' + MORPH9.movingInflectionWhy;
      }
    } catch {
      /* Slug */
    }
  }
  if (m && _chainIncomplete9) /** @type {any} */ (m).chainIncomplete9 = true;
  return m ? { mesh: m } : { mesh: null, why: SLUG_WHY.DECLINED, pairWhy };
}

// Build every shape's morph mesh in one unbudgeted pass (the worker path).
//   input: { srcCurve, dstCurve, srcMeta, dstMeta, metaStride, ranges, numShapes }
// Returns { meshes, why, pairWhy } on success, or { hasSlug: true, why, pairWhy } when the bundle
// can't morph as a whole (missing range / arc / non-morphable opaque fill) → renders via Slug.
//
// THE CAUSE TRAVELS WITH THE ANSWER, as it does for the static build (lbBuildCore's SLUG_WHY):
// `why` is one SLUG_WHY code per shape -- REAL for a shape with its mesh or with no fill to mesh,
// DECLINED for a fill the pair could not serve, NO_GEOMETRY for a shape with no contours to pair,
// NOT_BUILT for the shapes after the one that sent the bundle to Slug -- and `pairWhy` is the
// declined shape's own cause (buildMorphShape), null elsewhere. A declined stroked shape keeps
// the bundle on the route, so its cause is recorded and the loop goes on.
export function buildMorphBundle(input) {
  const { srcCurve, dstCurve, srcMeta, dstMeta, ranges, numShapes } = input;
  // The caller's per-shape memory budget, set here as buildLbBundle sets it: in the worker this module's copy is the
  // one that counts, and without it a morph would be charged against whatever the last static build left behind.
  if (input.shapeMemBytes !== undefined) setLbShapeMemoryBudget(input.shapeMemBytes || null);
  const st = input.metaStride | 0;
  const n = numShapes | 0;
  const meshes = [];
  const why = new Uint8Array(n),
    pairWhy = new Array(n).fill(null);
  const slug = (s, w, pw) => {
    why[s] = w;
    pairWhy[s] = pw || null;
    for (let k = s + 1; k < n; k++) why[k] = SLUG_WHY.NOT_BUILT;
    return { hasSlug: true, why, pairWhy };
  };
  for (let s = 0; s < n; s++) {
    // A group marker's alpha stores group opacity, not fill paint. Its empty
    // curve range must not decline the entire morph. Keep mesh row indices.
    const groupBits = FS_GROUP_BEGIN | FS_GROUP_END;
    const sf = Math.floor(srcMeta[s * st + 27] + 0.5) & groupBits;
    const df = Math.floor(dstMeta[s * st + 27] + 0.5) & groupBits;
    if (sf !== 0 && sf === df) {
      meshes.push(null);
      continue;
    }
    const r = ranges[s];
    if (!r) return slug(s, SLUG_WHY.NO_GEOMETRY);
    // Each pose decodes a zero-radius arc as its chord only where the other pose's is one too (one topology).
    const sc = curveRangeToContours(srcCurve, r.begin, r.end, dstCurve);
    const dc = curveRangeToContours(dstCurve, r.begin, r.end, srcCurve);
    if (!sc || !dc) return slug(s, SLUG_WHY.NO_GEOMETRY); // arc / empty → whole-bundle Slug
    const res = buildMorphShape(sc, dc, srcMeta, dstMeta, s * st, st);
    if (res.fill === false) {
      meshes.push(null);
      continue;
    }
    if (!res.mesh) {
      const stroked = srcMeta[s * st + 11] > 0 && srcMeta[s * st + 12] > 0;
      if (stroked) {
        why[s] = res.why;
        pairWhy[s] = res.pairWhy;
        meshes.push(null);
        continue;
      } // stroke carries geometry
      return slug(s, res.why, res.pairWhy); // non-morphable fill → Slug
    }
    // The route will not draw this morph under 'auto' (morphDraw), so the shapes after it are not built for a mesh nothing draws.
    if (input.declineIncomplete && res.mesh.chainIncomplete9)
      return slug(s, SLUG_WHY.DECLINED, 'chain-incomplete');
    meshes.push(res.mesh);
  }
  return { meshes, why, pairWhy };
}

// Collect the transferable ArrayBuffers of a meshes[] result (for zero-copy post).
export function morphMeshTransfers(meshes) {
  const t = [];
  if (!meshes) return t;
  for (const m of meshes) {
    if (!m) continue;
    if (m.vbo && m.vbo.buffer instanceof ArrayBuffer) t.push(m.vbo.buffer);
    if (m.segments)
      for (const sg of m.segments)
        if (sg && sg.vbo && sg.vbo.buffer instanceof ArrayBuffer) t.push(sg.vbo.buffer);
  }
  return t;
}
