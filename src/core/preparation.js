// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// preparation.js -- preparation-peak accounting: brackets around importSvg, createBundle, prepareBundle, createShapeMorph.
// CPU-only and renderer-free (the importer uses it); a bracket that is given an allocation ledger also records the exact GPU high-water.
//
// A bracket records the GPU high-water inside it, the CPU bytes the builders NOTED as transient (notePreparationBytes), and a JS heap
// high-water sampled at the bracket's edges and checkpoints where the host exposes one (a sampled lower bound, not an exact peak).

/** Open preparation brackets, shared by every context (one JS heap). */
const _preps = [];
const _prepLog = [];
const PREP_LOG_MAX = 64;
let _prepHighWater = null;

export function forEachOpenPreparation(fn) {
  for (const p of _preps) fn(p);
}

function heapNow() {
  try {
    const proc = /** @type {any} */ (globalThis).process;
    if (proc && typeof proc.memoryUsage === 'function' && proc.versions && proc.versions.node)
      return proc.memoryUsage().heapUsed;
    const m = typeof performance !== 'undefined' ? /** @type {any} */ (performance).memory : null;
    if (m && typeof m.usedJSHeapSize === 'number') return m.usedJSHeapSize;
  } catch {
    /* unavailable */
  }
  return null;
}

/**
 * Open a preparation bracket. Returns a token for endPreparation. `L` (optional) is the allocation ledger whose GPU high-water the bracket records.
 * @param {string} label @param {{ total: number }|null} [L]
 */
export function beginPreparation(label, L) {
  const heap = heapNow();
  const p = {
    label,
    ledger: L,
    startGpu: L ? L.total : 0,
    gpuPeakDelta: 0,
    cpuNoted: 0,
    cpuNotedPeak: 0,
    startHeap: heap,
    heapPeak: heap,
    t0: Date.now(),
    parent: _preps.length ? _preps[_preps.length - 1] : null,
  };
  _preps.push(p);
  return p;
}

/** Add (or, negative, release) transient CPU bytes the current brackets hold, e.g. a padded plane copy that dies at the end of a build. */
export function notePreparationBytes(bytes) {
  for (const p of _preps) {
    p.cpuNoted += bytes;
    if (p.cpuNoted > p.cpuNotedPeak) p.cpuNotedPeak = p.cpuNoted;
  }
}

/** Sample the JS heap into every open bracket (a checkpoint inside a long build). */
export function preparationCheckpoint() {
  if (!_preps.length) return;
  const h = heapNow();
  if (h == null) return;
  for (const p of _preps) if (p.heapPeak == null || h > p.heapPeak) p.heapPeak = h;
}

/** Close a bracket; returns its record. @param {any} p */
export function endPreparation(p) {
  if (!p) return null;
  const i = _preps.lastIndexOf(p);
  if (i >= 0) _preps.splice(i, 1);
  const h = heapNow();
  if (h != null && (p.heapPeak == null || h > p.heapPeak)) p.heapPeak = h;
  const rec = {
    label: p.label,
    gpuPeakBytes: p.gpuPeakDelta,
    cpuTransientBytes: p.cpuNotedPeak,
    heapPeakDeltaBytes:
      p.startHeap != null && p.heapPeak != null ? Math.max(0, p.heapPeak - p.startHeap) : null,
    ms: Date.now() - p.t0,
  };
  _prepLog.push(rec);
  if (_prepLog.length > PREP_LOG_MAX) _prepLog.shift();
  if (!_prepHighWater)
    _prepHighWater = { gpuPeakBytes: 0, cpuTransientBytes: 0, heapPeakDeltaBytes: 0, label: '' };
  const hw = _prepHighWater;
  if (rec.gpuPeakBytes > hw.gpuPeakBytes) hw.gpuPeakBytes = rec.gpuPeakBytes;
  if (rec.cpuTransientBytes > hw.cpuTransientBytes) hw.cpuTransientBytes = rec.cpuTransientBytes;
  if ((rec.heapPeakDeltaBytes || 0) > hw.heapPeakDeltaBytes) {
    hw.heapPeakDeltaBytes = rec.heapPeakDeltaBytes || 0;
    hw.label = rec.label;
  }
  return rec;
}

/** Run `fn` inside a bracket (sync or async). `L`: the ledger for the GPU high-water, or null. */
export function withPreparation(label, L, fn) {
  const p = beginPreparation(label, L);
  let out;
  try {
    out = fn();
  } catch (e) {
    endPreparation(p);
    throw e;
  }
  if (out && typeof out.then === 'function')
    return out.then(
      (v) => {
        endPreparation(p);
        return v;
      },
      (e) => {
        endPreparation(p);
        throw e;
      },
    );
  endPreparation(p);
  return out;
}

/** The preparation log (latest last) and the high-water over every bracket since the last reset. */
export function preparationStats() {
  return {
    highWater: _prepHighWater
      ? { ..._prepHighWater }
      : { gpuPeakBytes: 0, cpuTransientBytes: 0, heapPeakDeltaBytes: 0, label: '' },
    recent: _prepLog.map((r) => ({ ...r })),
    open: _preps.map((p) => p.label),
    heapSampled: heapNow() != null,
  };
}

export function resetPreparationStats() {
  _prepLog.length = 0;
  _prepHighWater = null;
}
