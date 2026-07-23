// occupancyWorkerPool.js — main-thread manager for the off-thread occupancy build
// worker. `requestOccupancyBuild({ occ, tier3 }, onDone)` ships the pending grid
// tasks to the worker and calls `onDone({ occ, tier3 })` with the built bits/cells
// when they come back; the caller writes them into the curve/band planes and
// uploads. Where `Worker` is unavailable (native / SSR / dead worker) it degrades
// to a deferred synchronous build via the same pure cores. Mirrors lbWorkerPool.

import { buildOccupancyGrid } from '../svg/occupancy.js';
import { computeGwnOccupancyCells } from '../svg/textures.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map();   // id → { occ, tier3, onDone }

function _syncBuild(occ, tier3) {
  const occOut = (occ || []).map((p) => {
    let bits = null;
    try { const g = buildOccupancyGrid(p.segs, p.bbox, p.evenOdd, { grid: p.G, minInteriorFrac: 0.15 }); bits = (g && g.bits) || null; } catch { bits = null; }
    return { base: p.base, G: p.G, bits };
  });
  const tierOut = (tier3 || []).map((p) => {
    let cells = null;
    try { cells = computeGwnOccupancyCells(p.polySegs, p.bbX0, p.bbY0, p.bbW, p.bbH, p.gridW, p.gridH); } catch { cells = null; }
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
  if (_worker) { try { _worker.terminate(); } catch { /* ignore */ } }
  _worker = null;
  for (const job of jobs) _scheduleSync(job.occ, job.tier3, job.onDone);
}

function _tryWorker() {
  if (_worker || _workerFailed) return _worker;
  try {
    if (typeof Worker === 'undefined') { _workerFailed = true; return null; }
    _worker = new Worker(new URL('./occupancy.worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const job = _pending.get(d.id);
      if (!job) return;
      _pending.delete(d.id);
      job.onDone({ occ: d.occ || [], tier3: d.tier3 || [] });
    };
    _worker.onerror = (e) => {
      // LOUD: a dead worker silently pushes every grid build back onto the main
      // thread (the perf regression this pool exists to prevent).
      if (typeof console !== 'undefined') console.warn('[mantle] occupancy build worker died — builds fall back to the main thread:', (e && (e.message || e.filename)) || e);
      _failWorker();
    };
  } catch (ex) {
    if (typeof console !== 'undefined') console.warn('[mantle] occupancy build worker failed to construct — builds fall back to the main thread:', ex);
    _failWorker();
  }
  return _worker;
}

/// Build the pending occupancy grids + tier-3 cells off the main thread.
/// occ:   [{ base, G, segs, bbox, evenOdd }]
/// tier3: [{ absTexel, gridW, gridH, polySegs, bbX0, bbY0, bbW, bbH }]
/// onDone({ occ:[{ base, G, bits }], tier3:[{ absTexel, gridW, gridH, cells }] })
export function requestOccupancyBuild(occ, tier3, onDone) {
  if ((!occ || !occ.length) && (!tier3 || !tier3.length)) { onDone({ occ: [], tier3: [] }); return; }
  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { occ, tier3, onDone });
    // Structured-clone (no transfer): the main thread keeps its polySegs/segs for
    // the sync fallback, and the build we offload dwarfs the clone cost.
    try { w.postMessage({ id, occ: occ || [], tier3: tier3 || [] }); }
    catch { _pending.delete(id); _failWorker(); _scheduleSync(occ, tier3, onDone); }
    return;
  }
  _scheduleSync(occ, tier3, onDone);
}

export function disposeOccupancyWorker() {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  if (_worker) { try { _worker.terminate(); } catch { /* ignore */ } }
  _worker = null; _workerFailed = false;
  // Never drop pending without onDone — awaiters / createBundle callbacks
  // would otherwise hang until a timeout (or forever).
  for (const job of jobs) {
    try { job.onDone({ occ: [], tier3: [] }); } catch { /* ignore */ }
  }
}
