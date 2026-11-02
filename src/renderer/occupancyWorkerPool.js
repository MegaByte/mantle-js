// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Build occupancy bits and tier-3 cells in a worker. Inputs are cloned; callers
// apply the returned arrays to their CPU planes and GPU textures. Without a
// worker, the same CPU cores run in a deferred task.

import { buildOccupancyGrid } from '../svg/occupancy.js';
import { computeGwnOccupancyCells } from '../svg/textures.js';
import { spawnWorker, registerWorkerPool, describeWorkerError } from './workerConfig.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map(); // id → { occ, tier3, onDone }

function _syncBuild(occ, tier3) {
  const occOut = (occ || []).map((p) => {
    let bits = null;
    try {
      const g = buildOccupancyGrid(p.segs, p.bbox, p.evenOdd, { grid: p.G, minInteriorFrac: 0.15 });
      bits = (g && g.bits) || null;
    } catch {
      bits = null;
    }
    return { base: p.base, G: p.G, bits };
  });
  const tierOut = (tier3 || []).map((p) => {
    let cells = null;
    try {
      cells = computeGwnOccupancyCells(p.polySegs, p.bbX0, p.bbY0, p.bbW, p.bbH, p.gridW, p.gridH);
    } catch {
      cells = null;
    }
    return { absTexel: p.absTexel, gridW: p.gridW, gridH: p.gridH, cells };
  });
  return { occ: occOut, tier3: tierOut };
}

function _scheduleSync(occ, tier3, onDone) {
  setTimeout(() => onDone(_syncBuild(occ, tier3)), 0);
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
  for (const job of jobs) _scheduleSync(job.occ, job.tier3, job.onDone);
}

// configureWorkers() stops the running worker and forgets a recorded failure; its queued work finishes on the main thread.
registerWorkerPool('occupancy', () => {
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
  for (const job of jobs) _scheduleSync(job.occ, job.tier3, job.onDone);
});

function _tryWorker() {
  if (_worker || _workerFailed) return _worker;
  try {
    if (typeof Worker === 'undefined') {
      _workerFailed = true;
      return null;
    }
    _worker = spawnWorker(
      'occupancy',
      () => new Worker(new URL('./occupancy.worker.js', import.meta.url), { type: 'module' }),
    );
    if (!_worker) {
      _workerFailed = true;
      return null;
    } // workers disabled by configureWorkers
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const job = _pending.get(d.id);
      if (!job) return;
      _pending.delete(d.id);
      job.onDone({ occ: d.occ || [], tier3: d.tier3 || [] });
    };
    _worker.onerror = (e) => {
      // Report failures because subsequent builds run on the main thread.
      if (typeof console !== 'undefined')
        console.warn(
          '[mantle] occupancy build worker died — builds fall back to the main thread:',
          describeWorkerError(e),
        );
      _failWorker();
    };
  } catch (ex) {
    if (typeof console !== 'undefined')
      console.warn(
        '[mantle] occupancy build worker failed to construct — builds fall back to the main thread:',
        ex,
      );
    _failWorker();
  }
  return _worker;
}

/// Build the pending occupancy grids + tier-3 cells off the main thread.
/// occ:   [{ base, G, segs, bbox, evenOdd }]
/// tier3: [{ absTexel, gridW, gridH, polySegs, bbX0, bbY0, bbW, bbH }]
/// onDone({ occ:[{ base, G, bits }], tier3:[{ absTexel, gridW, gridH, cells }] })
export function requestOccupancyBuild(occ, tier3, onDone) {
  if ((!occ || !occ.length) && (!tier3 || !tier3.length)) {
    onDone({ occ: [], tier3: [] });
    return;
  }
  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { occ, tier3, onDone });

    try {
      w.postMessage({ id, occ: occ || [], tier3: tier3 || [] });
    } catch {
      _pending.delete(id);
      _failWorker();
      _scheduleSync(occ, tier3, onDone);
    }
    return;
  }
  _scheduleSync(occ, tier3, onDone);
}

export function disposeOccupancyWorker() {
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
  // Settle every callback so preparation waiters can finish.
  for (const job of jobs) {
    try {
      job.onDone({ occ: [], tier3: [] });
    } catch {
      /* ignore */
    }
  }
}
