// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Build static and paired-pose Loop-Blinn meshes in a worker. Curve/meta
// inputs are cloned because rendering retains them; output vertex arrays are
// transferred back. Without a worker, the same CPU cores run in a deferred task.

import { buildLbBundle, packLbMeshForWire } from './lbBuildCore.js';
import { buildMorphBundle } from './lbMorphCore.js';
import { sdfPrimitivesDisabled } from '../geom/shapeRecognize.js';
import { getLbShapeMemoryBudget } from './lbPack.js';
import { workerFlags } from './workerFlags.js';
import { spawnWorker, registerWorkerPool, describeWorkerError } from './workerConfig.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map(); // id → { input, onDone }

/// Jobs waiting on the build worker and the bytes of their cloned inputs (the worker holds a copy of each until it answers).
export function lbPoolStats() {
  let inputBytes = 0;
  for (const j of _pending.values()) {
    const i = j.input;
    if (!i) continue;
    inputBytes += (i.curves && i.curves.byteLength) || 0;
    inputBytes += (i.meta && i.meta.byteLength) || 0;
  }
  return { pending: _pending.size, inputBytes };
}

function _packForWire(res) {
  return res.packed.map(packLbMeshForWire);
}

function _errString(ex) {
  return String((ex && (ex.message || (ex.error && ex.error.message))) || ex);
}

function _scheduleSyncBuild(input, onDone, kind) {
  const run = () => {
    try {
      if (kind === 'morph') {
        const res = buildMorphBundle(input);
        onDone({
          meshes: res.meshes || null,
          hasSlug: !!res.hasSlug,
          why: res.why || null,
          pairWhy: res.pairWhy || null,
        });
        return;
      }
      // Sync path shares the main-thread lbPack module.
      const res = buildLbBundle({
        curveFloats: input.curves,
        metaFloats: input.meta,
        metaFloatsPerShape: input.metaFloatsPerShape,
        ranges: input.ranges,
        numShapes: input.numShapes,
        preferBezout: !!input.preferBezout,
        skip: input.skip || null,
        shapeMemBytes: input.shapeMemBytes || 0,
      });
      onDone({
        packed: _packForWire(res),
        why: res.why || null,
        memWants: res.memWants && res.memWants.length ? res.memWants : null,
        hasReal: res.hasReal && !res.overBudget,
        hasSlug: res.hasSlug || !!res.overBudget,
        overBudget: !!res.overBudget,
      });
    } catch (ex) {
      onDone(
        kind === 'morph'
          ? { meshes: null, hasSlug: false, err: _errString(ex) }
          : { packed: [], hasReal: false, hasSlug: false, err: _errString(ex) },
      );
    }
  };
  (typeof queueMicrotask === 'function' ? queueMicrotask : (f) => setTimeout(f, 0))(run);
}

function _failWorker(ex) {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  _workerFailed = true;
  if (_worker) {
    try {
      _worker.terminate();
    } catch {}
  }
  _worker = null;
  for (const job of jobs) _scheduleSyncBuild(job.input, job.onDone, job.kind);
}

// configureWorkers() stops the running worker and forgets a recorded failure; its pending builds finish on the main thread.
registerWorkerPool('lb', () => {
  const jobs = Array.from(_pending.values());
  _pending.clear();
  if (_worker) {
    try {
      _worker.terminate();
    } catch {}
  }
  _worker = null;
  _workerFailed = false;
  for (const job of jobs) _scheduleSyncBuild(job.input, job.onDone, job.kind);
});

function _tryWorker() {
  if (_worker || _workerFailed) return _worker;
  // Guard the whole construction: bundlers that can't resolve the worker URL, or
  // runtimes without `Worker`, must fall through to the synchronous path.
  try {
    if (typeof Worker === 'undefined') {
      _workerFailed = true;
      return null;
    }
    _worker = spawnWorker(
      'lb',
      () => new Worker(new URL('./lbBuild.worker.js', import.meta.url), { type: 'module' }),
    );
    if (!_worker) {
      _workerFailed = true;
      return null;
    } // workers disabled by configureWorkers
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const job = _pending.get(d.id);
      if (job && d.kind === 'morph') {
        _pending.delete(d.id);
        job.onDone({
          meshes: d.meshes || null,
          hasSlug: !!d.hasSlug,
          why: d.why || null,
          pairWhy: d.pairWhy || null,
          err: d.err,
        });
        return;
      }
      if (!job) return;
      // Partial batches leave the job pending until its final result arrives.
      if (d.kind === 'lbPartial') {
        if (job.onPartial) job.onPartial(d);
        return;
      }
      _pending.delete(d.id);
      // Preserve per-shape decline reasons and memory-budget diagnostics.
      job.onDone({
        packed: d.packed,
        tail: d.tail,
        streamed: !!d.streamed,
        why: d.why || null,
        memWants: d.memWants || null,
        hasReal: d.hasReal,
        hasSlug: d.hasSlug,
        overBudget: !!d.overBudget,
        err: d.err,
      });
    };
    _worker.onerror = (e) => {
      if (typeof console !== 'undefined')
        console.warn(
          '[mantle] LB build worker died — builds fall back to the main thread:',
          describeWorkerError(e),
        );
      _failWorker(e);
    };
  } catch (ex) {
    // Report construction failure because subsequent LB builds fall back to the
    // main thread. A common cause is a dev server rejecting the worker URL.
    if (typeof console !== 'undefined')
      console.warn(
        '[mantle] LB build worker failed to construct — builds fall back to the main thread:',
        ex,
      );
    _workerFailed = true;
    _worker = null;
  }
  return _worker;
}

// Worker flags travel with each request because workers have separate globals.
// With adopt={ms, shapes, onPartial}, completed shapes arrive in batches and
// onDone carries the remaining tail. Without adopt, onDone carries all shapes.
export function requestLbBuild(bundle, onDone, adopt) {
  const onPartial = adopt && typeof adopt.onPartial === 'function' ? adopt.onPartial : null;
  const input = {
    curves: bundle.curveFloats,
    meta: bundle.metaFloats || null,
    metaFloatsPerShape: bundle.metaFloatsPerShape | 0,
    ranges: bundle.curveRangesByShape,
    numShapes: bundle.numShapes | 0,
    // Enable partial-result messages only when a consumer is registered.
    adoptMs: onPartial ? Math.max(0, adopt.ms | 0) : 0,
    adoptShapes: onPartial ? Math.max(0, adopt.shapes | 0) : 0,
    // Capture renderer policy explicitly for the worker's separate modules.
    preferBezout: !!bundle._preferBezout,
    // null builds every row; otherwise skip rows excluded by per-shape policy.
    skip: bundle._lbBuildSkip || null,
    sdfPrimsOff: sdfPrimitivesDisabled(),
    // Apply the memory limit before allocating worker mesh streams.
    shapeMemBytes: getLbShapeMemoryBudget() < Infinity ? getLbShapeMemoryBudget() : 0,
  };
  if (!input.curves || !input.ranges || input.numShapes < 1) {
    onDone({ packed: [], hasReal: false, hasSlug: false });
    return;
  }

  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { input, onDone, onPartial, kind: 'static' });
    // No transfer list → curve/meta are cloned into the worker; main keeps its copies.
    try {
      w.postMessage({ id, ...input, flags: workerFlags() });
    } catch (ex) {
      _pending.delete(id);
      _failWorker(ex);
      _scheduleSyncBuild(input, onDone, 'static');
    }
    return;
  }

  // No Worker: build synchronously but deferred, so createBundle doesn't block.
  _scheduleSyncBuild(input, onDone, 'static');
}

// Build interleaved endpoint meshes for GPU morphing. Results include per-shape
// decline reasons; hasSlug requests whole-bundle fallback. Worker failure uses
// the same deferred CPU fallback as static preparation.
export function requestMorphBuild(bundle, onDone, opts) {
  const src = bundle._morphSrc;
  if (
    !src ||
    !src.mergedCurveF32 ||
    !src.dstCurveF32 ||
    !src.curveRanges ||
    (bundle.numShapes | 0) < 1
  ) {
    onDone({ meshes: null, hasSlug: false });
    return;
  }
  const input = {
    kind: 'morph',
    srcCurve: src.mergedCurveF32,
    dstCurve: src.dstCurveF32,
    srcMeta: src.mergedMetaF32,
    dstMeta: src.dstMetaF32,
    metaStride: src.metaStride | 0,
    ranges: src.curveRanges,
    numShapes: bundle.numShapes | 0,
    sdfPrimsOff: sdfPrimitivesDisabled(),
    // Charge all pose-interval meshes against the per-shape memory limit.
    shapeMemBytes: getLbShapeMemoryBudget() < Infinity ? getLbShapeMemoryBudget() : 0,
    declineIncomplete: !!(opts && opts.declineIncomplete),
  };
  const w = _tryWorker();
  if (w) {
    const id = _nextId++;
    _pending.set(id, { input, onDone, kind: 'morph' });
    try {
      w.postMessage({ id, ...input, flags: workerFlags() });
    } catch (ex) {
      _pending.delete(id);
      _failWorker(ex);
      _scheduleSyncBuild(input, onDone, 'morph');
    }
    return;
  }
  _scheduleSyncBuild(input, onDone, 'morph');
}
