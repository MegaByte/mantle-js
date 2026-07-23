// occlusionWorkerPool.js — main-thread manager for the off-thread occlusion-cull
// worker. `requestOcclusionCull(job, onDone)` ships the bundle's curve/meta floats to
// the worker and calls `onDone(culledIndices)` when the hunt comes back. Where
// `Worker` is unavailable (native / SSR / dead worker) it degrades to a DEFERRED
// synchronous run, so the cost still lands off the critical import path. Mirrors
// occupancyWorkerPool.
//
// This carries only the PERF half of the cull. createBundle runs the cheap
// 'coincident' pass inline because that half is a correctness fix (the AA-edge
// conflation fringe) and must hold on frame one. Finding the remaining hidden shapes
// buys draws and nothing else, so arriving late is harmless — and being off-thread is
// what lets it be thorough without charging the load.

import { computeOccludedShapes } from './occlusionCull.js';
import { computeMorphOccludedShapes } from './morphCull.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map();   // id → { job, onDone }

function _syncRun(job) {
  try {
    if (job.cv1) {
      return [...computeMorphOccludedShapes(job.cv, job.cv1, job.ranges, job.meta, job.meta1,
                                            job.n | 0, job.stride | 0)];
    }
    return [...computeOccludedShapes(job.cv, job.ranges, job.meta, job.n | 0, job.stride | 0, 'full')];
  } catch { return []; }
}

function _scheduleSync(job, onDone) {
  setTimeout(() => onDone(_syncRun(job)), 0);
}

function _failWorker() {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  _workerFailed = true;
  if (_worker) { try { _worker.terminate(); } catch { /* ignore */ } }
  _worker = null;
  for (const pending of jobs) _scheduleSync(pending.job, pending.onDone);
}

function _tryWorker() {
  if (_worker || _workerFailed) return _worker;
  try {
    if (typeof Worker === 'undefined') { _workerFailed = true; return null; }
    _worker = new Worker(new URL('./occlusion.worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const pending = _pending.get(d.id);
      if (!pending) return;
      _pending.delete(d.id);
      pending.onDone(d.culled || []);
    };
    _worker.onerror = (e) => {
      if (typeof console !== 'undefined') {
        console.warn('[mantle] occlusion cull worker died — queued work is falling back to the main thread:',
                     (e && (e.message || e.filename)) || e);
      }
      _failWorker();
    };
  } catch (ex) {
    if (typeof console !== 'undefined') {
      console.warn('[mantle] occlusion cull worker failed to construct — extra draw culling runs deferred on the main thread:', ex);
    }
    _failWorker();
  }
  return _worker;
}

/**
 * Hunt for fully-occluded shapes off the main thread.
 * job:    { cv: Float32Array, meta: Float32Array, n, stride, ranges: [{begin,end}] }
 * onDone: (culled: number[]) => void
 */
export function requestOcclusionCull(job, onDone) {
  if (!job || !(job.n > 1)) { onDone([]); return; }
  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { job, onDone });
    // Structured clone, NOT transfer: the main thread keeps using these very buffers
    // (they back the live curve/meta textures), so handing ownership away would
    // detach them out from under the renderer.
    try {
      w.postMessage({ id, cv: job.cv, meta: job.meta, n: job.n, stride: job.stride, ranges: job.ranges,
                      cv1: job.cv1, meta1: job.meta1 });   // cv1/meta1 present ⇒ a MORPH job
    }
    catch { _pending.delete(id); _failWorker(); _scheduleSync(job, onDone); }
    return;
  }
  _scheduleSync(job, onDone);
}

export function disposeOcclusionWorker() {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  if (_worker) { try { _worker.terminate(); } catch { /* ignore */ } }
  _worker = null; _workerFailed = false;
  for (const job of jobs) {
    try { job.onDone([]); } catch { /* ignore */ }
  }
}
