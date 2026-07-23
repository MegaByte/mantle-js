// lbWorkerPool.js — main-thread manager for the off-thread LB build worker.
//
// `requestLbBuild(bundle, onDone)` ships a bundle's curve/meta buffers to the
// worker and calls `onDone({ packed, hasReal, hasSlug, overBudget })` when the
// meshes come back (`packed[s] === null` ⇒ that shape is Slug). The heavy Loop-Blinn
// triangulation runs entirely off the main thread; the draw path never builds.
//
// Curve/meta buffers are COPIED into the worker (structured clone, no transfer)
// because the main thread keeps its own copies for the morph/stream/sync paths;
// the returned vertex buffers are transferred back (zero-copy). Where `Worker`
// is unavailable (native / SSR), it degrades to a deferred synchronous build via
// the same GL-free core, so behaviour is identical, just on-thread.

import { buildLbBundle } from './lbBuildCore.js';
import { buildMorphBundle } from './lbMorphCore.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map();   // id → { input, onDone }

function _packForWire(res) {
  return res.packed.map((pk) => (pk && !pk.slug && !pk.overBudget && (pk.vertexCount | 0) > 0)
    ? { verts: pk.verts, vertexCount: pk.vertexCount, hasBezout: !!pk.hasBezout }
    : null);
}

function _errString(ex) {
  return String((ex && (ex.message || (ex.error && ex.error.message))) || ex);
}

function _scheduleSyncBuild(input, onDone, kind) {
  const run = () => {
    try {
      if (kind === 'morph') {
        const res = buildMorphBundle(input);
        onDone({ meshes: res.meshes || null, hasSlug: !!res.hasSlug });
        return;
      }
      // Sync path shares the main-thread lbPack module.
      const res = buildLbBundle({
        curveFloats: input.curves, metaFloats: input.meta,
        metaFloatsPerShape: input.metaFloatsPerShape, ranges: input.ranges, numShapes: input.numShapes,
      });
      onDone({ packed: _packForWire(res), hasReal: res.hasReal && !res.overBudget, hasSlug: res.hasSlug || !!res.overBudget, overBudget: !!res.overBudget });
    } catch (ex) {
      onDone(kind === 'morph' ? { meshes: null, hasSlug: false, err: _errString(ex) }
                              : { packed: [], hasReal: false, hasSlug: false, err: _errString(ex) });
    }
  };
  (typeof queueMicrotask === 'function' ? queueMicrotask : (f) => setTimeout(f, 0))(run);
}

function _failWorker(ex) {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  _workerFailed = true;
  if (_worker) { try { _worker.terminate(); } catch { } }
  _worker = null;
  for (const job of jobs) _scheduleSyncBuild(job.input, job.onDone, job.kind);
}

function _tryWorker() {
  if (_worker || _workerFailed) return _worker;
  // Guard the whole construction: bundlers that can't resolve the worker URL, or
  // runtimes without `Worker`, must fall through to the synchronous path.
  try {
    if (typeof Worker === 'undefined') { _workerFailed = true; return null; }
    _worker = new Worker(new URL('./lbBuild.worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const job = _pending.get(d.id);
      if (job && d.kind === 'morph') { _pending.delete(d.id); job.onDone({ meshes: d.meshes || null, hasSlug: !!d.hasSlug, err: d.err }); return; }
      if (!job) return;
      _pending.delete(d.id);
      job.onDone({ packed: d.packed, hasReal: d.hasReal, hasSlug: d.hasSlug, overBudget: !!d.overBudget, err: d.err });
    };
    _worker.onerror = (e) => {
      if (typeof console !== 'undefined') console.warn('[mantle] LB build worker died — builds fall back to the main thread:', (e && (e.message || e.filename)) || e);
      _failWorker(e);
    };
  } catch (ex) {
    // Report construction failure because subsequent LB builds fall back to the
    // main thread. A common cause is a dev server rejecting the worker URL.
    if (typeof console !== 'undefined') console.warn('[mantle] LB build worker failed to construct — builds fall back to the main thread:', ex);
    _workerFailed = true;
    _worker = null;
  }
  return _worker;
}

export function requestLbBuild(bundle, onDone) {
  const input = {
    curves: bundle.curveFloats,
    meta: bundle.metaFloats || null,
    metaFloatsPerShape: bundle.metaFloatsPerShape | 0,
    ranges: bundle.curveRangesByShape,
    numShapes: bundle.numShapes | 0,
  };
  if (!input.curves || !input.ranges || input.numShapes < 1) { onDone({ packed: [], hasReal: false, hasSlug: false }); return; }

  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { input, onDone, kind: 'static' });
    // No transfer list → curve/meta are cloned into the worker; main keeps its copies.
    try { w.postMessage({ id, ...input }); }
    catch (ex) {
      _pending.delete(id);
      _failWorker(ex);
      _scheduleSyncBuild(input, onDone, 'static');
    }
    return;
  }

  // No Worker: build synchronously but deferred, so createBundle doesn't block.
  _scheduleSyncBuild(input, onDone, 'static');
}

// MORPH-pair build, off the main thread — the counterpart to requestLbBuild for
// the GPU-resident morph meshes (was an 8ms/frame main-thread build). Ships BOTH
// endpoints' curve+meta; `onDone({ meshes, hasSlug })` returns per-shape interleaved
// pair VBOs (or hasSlug:true when the bundle can't morph → renders via Slug). Same
// worker; degrades to a deferred synchronous build where Worker is unavailable/failed.
export function requestMorphBuild(bundle, onDone) {
  const src = bundle._morphSrc;
  if (!src || !src.mergedCurveF32 || !src.dstCurveF32 || !src.curveRanges || (bundle.numShapes | 0) < 1) {
    onDone({ meshes: null, hasSlug: false }); return;
  }
  const input = {
    kind: 'morph',
    srcCurve: src.mergedCurveF32, dstCurve: src.dstCurveF32,
    srcMeta: src.mergedMetaF32, dstMeta: src.dstMetaF32,
    metaStride: src.metaStride | 0, ranges: src.curveRanges, numShapes: bundle.numShapes | 0,
  };
  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { input, onDone, kind: 'morph' });
    try { w.postMessage({ id, ...input }); }
    catch (ex) { _pending.delete(id); _failWorker(ex); _scheduleSyncBuild(input, onDone, 'morph'); }
    return;
  }
  _scheduleSyncBuild(input, onDone, 'morph');
}
