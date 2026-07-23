// lbBuild.worker.js — off-main-thread Loop-Blinn mesh construction.
//
// The renderer posts a bundle's parsed curve + meta buffers here; this worker
// triangulates every shape ONCE (unbudgeted — it's off the main thread) via the
// GL-free build core and posts the packed vertex buffers back, transferring them
// so the hand-off is zero-copy. The main thread then uploads them to GL. No `gl`,
// no `document`, no renderer context is touched here — buildLbBundle only pulls
// in the pure builders (loopBlinn → seg/cdt/polyRoots).
//
// Input  (structured-cloned; curve/meta are COPIED, not transferred, because the
//         main thread keeps its own copies for the morph/stream/sync paths):
//   { id, curves:Float32Array, meta:Float32Array|null, metaFloatsPerShape,
//     ranges:{begin,end}[], numShapes }
// Output (packed verts transferred):
//   { id, packed:( {verts,vertexCount,hasBezout} | null )[], hasReal, hasSlug,
//     overBudget, err }
//   packed[s] === null  ⇒ that shape is Slug (built the main-thread SLUG sentinel).

import { buildLbBundle } from './lbBuildCore.js';
import { buildMorphBundle, morphMeshTransfers } from './lbMorphCore.js';

// MORPH build (kind:'morph'): the same off-thread hand-off, for the GPU-resident
// morph-pair meshes that used to build on the MAIN THREAD (an 8ms/frame hitch on
// animated content). Input carries BOTH endpoints' curve+meta buffers; output is
// per-shape interleaved pair VBOs, transferred zero-copy.
function _handleMorph(d) {
  let meshes = null, hasSlug = false, err = null;
  try {
    const res = buildMorphBundle({
      srcCurve: d.srcCurve, dstCurve: d.dstCurve, srcMeta: d.srcMeta, dstMeta: d.dstMeta,
      metaStride: d.metaStride, ranges: d.ranges, numShapes: d.numShapes,
    });
    meshes = res.meshes || null;
    hasSlug = !!res.hasSlug;
  } catch (ex) { err = String((ex && ex.message) || ex); }
  const workerSelf = /** @type {{ postMessage: (message: any, transfer: Transferable[]) => void }} */ (/** @type {unknown} */ (self));
  workerSelf.postMessage({ id: d.id, kind: 'morph', meshes, hasSlug, err }, morphMeshTransfers(meshes));
}

self.onmessage = (e) => {
  const data = e.data || {};
  if (data.kind === 'morph') { _handleMorph(data); return; }
  const { id, curves, meta, metaFloatsPerShape, ranges, numShapes } = data;
  let packed = null, hasReal = false, hasSlug = false, overBudget = false, err = null;
  try {
    const res = buildLbBundle({
      curveFloats: curves,                 // already a Float32Array (cloned view)
      metaFloats: meta || null,
      metaFloatsPerShape,
      ranges,
      numShapes,
    });
    // Drop the CPU `raw` meshes (only the packed GPU buffers cross back) and
    // flatten Slug markers to `null` for a compact wire form.
    overBudget = !!res.overBudget;
    packed = res.packed.map((pk) => (pk && !pk.slug && !pk.overBudget && (pk.vertexCount | 0) > 0)
      ? { verts: pk.verts, vertexCount: pk.vertexCount, hasBezout: !!pk.hasBezout }
      : null);
    hasReal = res.hasReal && !overBudget;
    hasSlug = res.hasSlug || overBudget;
  } catch (ex) {
    err = String((ex && ex.message) || ex);
  }
  /** @type {Transferable[]} */
  const transfer = [];
  if (packed) for (const pk of packed) if (pk && pk.verts && pk.verts.buffer instanceof ArrayBuffer) transfer.push(pk.verts.buffer);
  const workerSelf = /** @type {{ postMessage: (message: any, transfer: Transferable[]) => void }} */ (/** @type {unknown} */ (self));
  workerSelf.postMessage({ id, packed, hasReal, hasSlug, overBudget, err }, transfer);
};
