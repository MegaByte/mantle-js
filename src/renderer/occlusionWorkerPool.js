// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Find fully hidden shapes in a worker, or in a deferred CPU task when workers
// are unavailable. The bundle applies coincident-edge culling synchronously;
// this additional cull reduces draws without changing visible geometry.

import { computeOccludedShapes } from './occlusionCull.js';
import { computeMorphOccludedShapes } from './morphCull.js';
import { spawnWorker, registerWorkerPool, describeWorkerError } from './workerConfig.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map(); // id → { job, onDone }

function _syncRun(job) {
  try {
    if (job.cv1) {
      return [
        ...computeMorphOccludedShapes(
          job.cv,
          job.cv1,
          job.ranges,
          job.meta,
          job.meta1,
          job.n | 0,
          job.stride | 0,
        ),
      ];
    }
    return [
      ...computeOccludedShapes(job.cv, job.ranges, job.meta, job.n | 0, job.stride | 0, 'full'),
    ];
  } catch {
    return [];
  }
}

function _scheduleSync(job, onDone) {
  setTimeout(() => onDone(_syncRun(job)), 0);
}

function _failWorker() {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  _workerFailed = true;
  if (_worker) {
    try {
      _worker.terminate();
    } catch {
      /* ignore */
    }
  }
  _worker = null;
  for (const pending of jobs) _scheduleSync(pending.job, pending.onDone);
}

// configureWorkers() stops the running worker and forgets a recorded failure; its queued work finishes on the main thread.
registerWorkerPool('occlusion', () => {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  if (_worker) {
    try {
      _worker.terminate();
    } catch {
      /* ignore */
    }
  }
  _worker = null;
  _workerFailed = false;
  for (const pending of jobs) _scheduleSync(pending.job, pending.onDone);
});

function _tryWorker() {
  if (_worker || _workerFailed) return _worker;
  try {
    if (typeof Worker === 'undefined') {
      _workerFailed = true;
      return null;
    }
    _worker = spawnWorker(
      'occlusion',
      () => new Worker(new URL('./occlusion.worker.js', import.meta.url), { type: 'module' }),
    );
    if (!_worker) {
      _workerFailed = true;
      return null;
    } // workers disabled by configureWorkers
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const pending = _pending.get(d.id);
      if (!pending) return;
      _pending.delete(d.id);
      pending.onDone(d.culled || []);
    };
    _worker.onerror = (e) => {
      if (typeof console !== 'undefined') {
        console.warn(
          '[mantle] occlusion cull worker died — queued work is falling back to the main thread:',
          describeWorkerError(e),
        );
      }
      _failWorker();
    };
  } catch (ex) {
    if (typeof console !== 'undefined') {
      console.warn(
        '[mantle] occlusion cull worker failed to construct — extra draw culling runs deferred on the main thread:',
        ex,
      );
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
  if (!job || !(job.n > 1)) {
    onDone([]);
    return;
  }
  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { job, onDone });
    // Clone the arrays: the renderer retains their live backing buffers.
    try {
      w.postMessage({
        id,
        cv: job.cv,
        meta: job.meta,
        n: job.n,
        stride: job.stride,
        ranges: job.ranges,
        cv1: job.cv1,
        meta1: job.meta1,
      }); // cv1/meta1 present ⇒ a MORPH job
    } catch {
      _pending.delete(id);
      _failWorker();
      _scheduleSync(job, onDone);
    }
    return;
  }
  _scheduleSync(job, onDone);
}

export function disposeOcclusionWorker() {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  if (_worker) {
    try {
      _worker.terminate();
    } catch {
      /* ignore */
    }
  }
  _worker = null;
  _workerFailed = false;
  for (const job of jobs) {
    try {
      job.onDone([]);
    } catch {
      /* ignore */
    }
  }
}
