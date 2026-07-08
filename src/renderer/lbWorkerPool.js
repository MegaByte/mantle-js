// lbWorkerPool.js — main-thread manager for the off-thread LB build worker.
//
// `requestLbBuild(bundle, onDone)` ships a bundle's curve/meta buffers to the
// worker and calls `onDone({ packed, hasReal, hasSlug })` when the meshes come
// back (`packed[s] === null` ⇒ that shape is Slug). The heavy Loop-Blinn
// triangulation runs entirely off the main thread; the draw path never builds.
//
// Curve/meta buffers are COPIED into the worker (structured clone, no transfer)
// because the main thread keeps its own copies for the morph/stream/sync paths;
// the returned vertex buffers are transferred back (zero-copy). Where `Worker`
// is unavailable (native / SSR), it degrades to a deferred synchronous build via
// the same GL-free core, so behaviour is identical, just on-thread.

import { buildLbBundle } from './lbBuildCore.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map();   // id → { input, onDone }

function _packForWire(res) {
  return res.packed.map((pk) => (pk && !pk.slug)
    ? { verts: pk.verts, vertexCount: pk.vertexCount, hasBezout: !!pk.hasBezout }
    : null);
}

function _errString(ex) {
  return String((ex && (ex.message || (ex.error && ex.error.message))) || ex);
}

function _scheduleSyncBuild(input, onDone) {
  const run = () => {
    try {
      const res = buildLbBundle({
        curveFloats: input.curves, metaFloats: input.meta,
        metaFloatsPerShape: input.metaFloatsPerShape, ranges: input.ranges, numShapes: input.numShapes,
      });
      onDone({ packed: _packForWire(res), hasReal: res.hasReal, hasSlug: res.hasSlug });
    } catch (ex) {
      onDone({ packed: [], hasReal: false, hasSlug: false, err: _errString(ex) });
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
  for (const job of jobs) _scheduleSyncBuild(job.input, job.onDone);
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
      if (!job) return;
      _pending.delete(d.id);
      job.onDone({ packed: d.packed, hasReal: d.hasReal, hasSlug: d.hasSlug, err: d.err });
    };
    _worker.onerror = (e) => {
      if (typeof console !== 'undefined') console.warn('[mantle] LB build worker died — builds fall back to the main thread:', (e && (e.message || e.filename)) || e);
      _failWorker(e);
    };
  } catch (ex) {
    // LOUD on purpose: a dead worker silently inverts the perf architecture —
    // every LB build lands on the main thread (multi-second load freezes).
    // Classic cause: a dev server refusing the worker URL (vite server.fs
    // denies /@fs/ realpaths outside its workspace root → 403).
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
    _pending.set(id, { input, onDone });
    // No transfer list → curve/meta are cloned into the worker; main keeps its copies.
    try { w.postMessage({ id, ...input }); }
    catch (ex) {
      _pending.delete(id);
      _failWorker(ex);
      _scheduleSyncBuild(input, onDone);
    }
    return;
  }

  // No Worker: build synchronously but deferred, so createBundle doesn't block.
  _scheduleSyncBuild(input, onDone);
}

// Terminate the worker (test teardown / context loss). Pending jobs are dropped.
export function disposeLbWorker() {
  if (_worker) { try { _worker.terminate(); } catch { } }
  _worker = null; _workerFailed = false; _pending.clear();
}
