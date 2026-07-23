// lbMorphCore.js — GL-free morph-pair mesh construction.
//
// Extracted from morphDraw's _ensureBundleMorphMeshes so the SAME per-shape
// build runs OFF the main thread in lbBuild.worker.js (the static build already
// does). No `gl`, no renderer context — only the pure builders. The result is
// plain CPU data (interleaved Float32Array VBOs + counts) the main thread uploads.
//
// The main-thread copy in morphDraw stays as the synchronous fallback (worker
// unavailable / failed) and keeps its per-shape cache, budget and resumability;
// this module is the unbudgeted one-shot the worker runs.
import { curveRangeToContours } from './lbContour.js';
import { buildEarcutPair, segmentPartitionPairMorph } from './loopBlinnMorph.js';
import { buildLoopBlinnPartitionPair } from './lbPartitionPair.js';
import { packLoopBlinnMesh, LB_VERT_FLOATS } from './lbPack.js';

// Interleave src/dst packed verts into ONE VBO (vertex s.src, s.dst, …), the wire
// form the morph VS lerps. Identical to morphDraw._interleavePair.
function interleavePair(pkS, pkD) {
  const n = pkS.vertexCount, F = LB_VERT_FLOATS;
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
//   { mesh: null }   → non-morphable fill: the bundle renders via Slug
//   { mesh: {...} }  → a plain or t-segmented partition-pair mesh
export function buildMorphShape(sc, dc, meta, dmeta, b, st) {
  const hasPaint = Math.floor(meta[b + 28] + 0.5) !== 0 || (st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0);
  const hasFill = hasPaint || meta[b + 7] > 0.004 || dmeta[b + 7] > 0.004;
  if (!hasFill) return { fill: false };
  const translucent = !hasPaint && (meta[b + 7] < 0.996 || dmeta[b + 7] < 0.996);
  const fillRule = meta[b + 13] > 0.5 ? 'evenodd' : 'nonzero';
  let m = null;
  try {
    // EARCUT pair first (single-contour opaque; returns null on any structure
    // drift → falls to the partition pair), gated only on !translucent — exactly
    // as _ensureBundleMorphMeshes does.
    const pair = (!translucent && buildEarcutPair(sc, dc))
      || buildLoopBlinnPartitionPair(sc, dc, fillRule);
    if (pair) {
      const pkS = packLoopBlinnMesh(pair.src), pkD = packLoopBlinnMesh(pair.dst);
      if (pkS.vertexCount === pkD.vertexCount && pkS.vertexCount > 0)
        m = { mode: 'partitionPair', vbo: interleavePair(pkS, pkD), vertexCount: pkS.vertexCount, hasSlug: false };
    }
  } catch { m = null; }
  if (!m) {
    // FLIP morph: t-segmented pairs, one sub-interval per classification span.
    try {
      const segs = segmentPartitionPairMorph(sc, dc, fillRule);
      if (segs) {
        const out = []; let ok = true;
        for (const sg of segs) {
          const pkS = packLoopBlinnMesh(sg.pair.src), pkD = packLoopBlinnMesh(sg.pair.dst);
          if (!pkS.vertexCount || pkS.vertexCount !== pkD.vertexCount) { ok = false; break; }
          out.push({ tLo: sg.tLo, tHi: sg.tHi, tLoB: sg.tLoB, tHiB: sg.tHiB,
            vbo: interleavePair(pkS, pkD), vertexCount: pkS.vertexCount, mode: 'partitionPair' });
        }
        if (ok && out.length) m = { mode: 'partitionPair', segments: out, vertexCount: out[0].vertexCount, hasSlug: false };
      }
    } catch { /* Slug */ }
  }
  return { mesh: m };
}

// Build EVERY shape's morph mesh in one unbudgeted pass (the worker path).
//   input: { srcCurve, dstCurve, srcMeta, dstMeta, metaStride, ranges, numShapes }
// Returns { meshes } on success, or { hasSlug: true } when the bundle can't morph
// as a whole (missing range / arc / non-morphable opaque fill) → renders via Slug.
export function buildMorphBundle(input) {
  const { srcCurve, dstCurve, srcMeta, dstMeta, ranges, numShapes } = input;
  const st = input.metaStride | 0;
  const meshes = [];
  for (let s = 0; s < numShapes; s++) {
    const r = ranges[s];
    if (!r) return { hasSlug: true };
    const sc = curveRangeToContours(srcCurve, r.begin, r.end);
    const dc = curveRangeToContours(dstCurve, r.begin, r.end);
    if (!sc || !dc) return { hasSlug: true };   // arc / empty → whole-bundle Slug
    const res = buildMorphShape(sc, dc, srcMeta, dstMeta, s * st, st);
    if (res.fill === false) { meshes.push(null); continue; }
    if (!res.mesh) {
      const stroked = srcMeta[s * st + 11] > 0 && srcMeta[s * st + 12] > 0;
      if (stroked) { meshes.push(null); continue; }   // stroke carries geometry
      return { hasSlug: true };                        // non-morphable fill → Slug
    }
    meshes.push(res.mesh);
  }
  return { meshes };
}

// Collect the transferable ArrayBuffers of a meshes[] result (for zero-copy post).
export function morphMeshTransfers(meshes) {
  const t = [];
  if (!meshes) return t;
  for (const m of meshes) {
    if (!m) continue;
    if (m.vbo && m.vbo.buffer instanceof ArrayBuffer) t.push(m.vbo.buffer);
    if (m.segments) for (const sg of m.segments) if (sg && sg.vbo && sg.vbo.buffer instanceof ArrayBuffer) t.push(sg.vbo.buffer);
  }
  return t;
}
