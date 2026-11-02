// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
//     ranges:{begin,end}[], numShapes, shapeMemBytes }
// Output (packed verts transferred):
//   { id, packed:( {verts,vertexCount,hasBezout,hasCubicChain,prim,kindMask} | null )[], hasReal, hasSlug,
//     overBudget, memWants:{shape,bytes}[]|null, err }
//   packed[s] === null  ⇒ that shape is Slug (built the main-thread SLUG sentinel).

import { buildLbBundle, packLbMeshForWire } from './lbBuildCore.js';
import { buildMorphBundle, morphMeshTransfers } from './lbMorphCore.js';
import { setSdfPrimitivesEnabled } from '../geom/shapeRecognize.js';
import { applyWorkerFlags } from './workerFlags.js';

function _handleMorph(d) {
  let meshes = null,
    hasSlug = false,
    err = null;
  // WHY each shape has no morph mesh (SLUG_WHY), and a declined shape's own cause: without them a
  // morph that fell to Slug reached the main thread as a bare `hasSlug`.
  let why = null,
    pairWhy = null;
  try {
    const res = buildMorphBundle({
      srcCurve: d.srcCurve,
      dstCurve: d.dstCurve,
      srcMeta: d.srcMeta,
      dstMeta: d.dstMeta,
      metaStride: d.metaStride,
      ranges: d.ranges,
      numShapes: d.numShapes,
      shapeMemBytes: d.shapeMemBytes || 0,
      declineIncomplete: !!d.declineIncomplete,
    });
    meshes = res.meshes || null;
    hasSlug = !!res.hasSlug;
    why = res.why || null;
    pairWhy = res.pairWhy || null;
  } catch (ex) {
    err = String((ex && ex.message) || ex);
  }
  const workerSelf =
    /** @type {{ postMessage: (message: any, transfer: Transferable[]) => void }} */ (
      /** @type {unknown} */ (self)
    );
  const tx = morphMeshTransfers(meshes);
  if (why) tx.push(why.buffer);
  workerSelf.postMessage({ id: d.id, kind: 'morph', meshes, hasSlug, why, pairWhy, err }, tx);
}

// The page's switches, posted with every message (workerFlags.js). The previous message's set is
// removed first: the worker outlives a build, so a flag left behind would configure the NEXT
// bundle, and an A/B's second arm would silently inherit the first's.
self.onmessage = (e) => {
  const data = e.data || {};
  applyWorkerFlags(data.flags);
  // THE RECOGNIZER SWITCH IS A MODULE FLAG, and this worker has its own copy of the module. Without this a page that
  // turned SDF primitives off still got them from here -- so whether a ring drew as a primitive or as Loop-Blinn
  // depended on whether this build or prepareBundle's main-thread one landed first.
  setSdfPrimitivesEnabled(!data.sdfPrimsOff);
  if (data.kind === 'morph') {
    _handleMorph(data);
    return;
  }
  const {
    id,
    curves,
    meta,
    metaFloatsPerShape,
    ranges,
    numShapes,
    preferBezout,
    skip,
    shapeMemBytes,
  } = data;
  const workerSelf =
    /** @type {{ postMessage: (message: any, transfer: Transferable[]) => void }} */ (
      /** @type {unknown} */ (self)
    );
  const transfersOf = (list) => {
    /** @type {Transferable[]} */
    const t = [];
    if (list)
      for (const pk of list)
        if (pk && pk.verts && pk.verts.buffer instanceof ArrayBuffer) t.push(pk.verts.buffer);
    return t;
  };
  // STREAM THE SHAPES BACK AS THEY FINISH, in batches, so the bundle can draw a shape's mesh while
  // the rest of the build is still running. Opt-in from the input: with no batch policy this posts
  // the single whole-bundle result it always posted, byte for byte.
  //
  // A batch's vertex buffers are TRANSFERRED, which detaches them here — so a shape that has gone out
  // must never be packed again, and the final message carries only the ones that have not.
  const adoptShapes = Math.max(0, data.adoptShapes | 0);
  const adoptMs = Math.max(0, data.adoptMs | 0);
  const streamed = adoptShapes > 0 || adoptMs > 0;
  const sent = streamed ? new Uint8Array(numShapes | 0) : null;
  const buildStart = Date.now();
  let bShapes = [],
    bMeshes = [],
    lastFlush = buildStart;
  const flush = () => {
    if (!bShapes.length) return;
    const shapes = bShapes,
      meshes = bMeshes;
    bShapes = [];
    bMeshes = [];
    lastFlush = Date.now();
    workerSelf.postMessage({ id, kind: 'lbPartial', shapes, meshes }, transfersOf(meshes));
  };
  // The interval grows with the build. A fixed interval makes adoptions grow LINEARLY with build
  // length, so a heavy asset would rebuild the vertex stream hundreds of times -- each rebuild being
  // main-thread work in front of a frame, which is the cost this batching exists to bound. Holding
  // the interval at a third of the elapsed build keeps the early meshes arriving as promptly as the
  // flat rule does (adoptMs dominates for the first ~3x adoptMs) and makes the total grow with the
  // LOGARITHM of build length after that.
  const dueAt = (now) => Math.max(adoptMs, (now - buildStart) / 3);
  const onShape = streamed
    ? (s, pk) => {
        bShapes.push(s);
        bMeshes.push(packLbMeshForWire(pk));
        sent[s] = 1;
        const now = Date.now();
        if (
          (adoptShapes > 0 && bShapes.length >= adoptShapes) ||
          (adoptMs > 0 && now - lastFlush >= dueAt(now))
        )
          flush();
      }
    : undefined;

  let packed = null,
    tail = null,
    hasReal = false,
    hasSlug = false,
    overBudget = false,
    err = null;
  /// Shapes the caller's per-shape MEMORY budget turned away, with the bytes each one wanted. It
  /// rides the final message beside `why` for the same reason: the wire form flattens every
  /// sentinel to `null`, so a budget refusal would otherwise reach the main thread as an anonymous
  /// Slug -- the silent decline this budget is written not to be.
  let memWants = null;
  /// WHY each shape has no mesh (SLUG_WHY), whole-bundle. Sent once on the final message even for a
  /// streamed build: the wire form flattens every sentinel to `null`, so without it the main thread
  /// cannot tell a shape the builder declined from one it never attempted.
  let why = null;
  try {
    const res = buildLbBundle({
      curveFloats: curves, // already a Float32Array (cloned view)
      metaFloats: meta || null,
      metaFloatsPerShape,
      ranges,
      numShapes,
      preferBezout: !!preferBezout,
      skip: skip || null,
      shapeMemBytes: shapeMemBytes || 0,
      onShape,
    });
    // Drop the CPU `raw` meshes (only the packed GPU buffers cross back) and
    // flatten Slug markers to `null` for a compact wire form.
    overBudget = !!res.overBudget;
    if (streamed) {
      // Whatever has not gone out yet, including the batch still in hand. The main thread folds
      // these back together with the ones it already adopted.
      flush();
      const shapes = [],
        meshes = [];
      for (let s = 0; s < res.packed.length; s++) {
        if (sent[s]) continue;
        shapes.push(s);
        meshes.push(packLbMeshForWire(res.packed[s]));
      }
      tail = { shapes, meshes };
    } else {
      packed = res.packed.map(packLbMeshForWire);
    }
    why = res.why || null;
    memWants = res.memWants && res.memWants.length ? res.memWants : null;
    hasReal = res.hasReal && !overBudget;
    hasSlug = res.hasSlug || overBudget;
  } catch (ex) {
    err = String((ex && ex.message) || ex);
    // A BUILD THAT THREW HAS NO RESULT, streamed or not. Reporting it as a streamed finish would
    // finalize the bundle on however many shapes happened to land first; the main thread's error
    // path (whole-bundle Slug) is the same answer it has always given, and it revokes those.
    packed = null;
    tail = null;
    why = null;
    memWants = null;
  }
  const _tx = transfersOf(packed || (tail && tail.meshes));
  if (why) _tx.push(why.buffer);
  workerSelf.postMessage(
    {
      id,
      packed,
      tail,
      why,
      memWants,
      streamed: streamed && !err,
      hasReal,
      hasSlug,
      overBudget,
      err,
    },
    _tx,
  );
};
