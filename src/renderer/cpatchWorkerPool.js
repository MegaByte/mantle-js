// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchWorkerPool.js — N-worker pool for CPatch conversion.
//
// `convertContoursPooled(contours, opts)` returns a Promise of one result per
// contour, in input order. Contours are independent (convertContour is pure), so
// this is the one build step here big enough to be worth fanning across cores:
// ~9ms per contour, hundreds per real asset.

// Degrades to a synchronous in-thread conversion wherever `Worker` is missing
// (native / SSR) or the workers fail to spawn, so behavior is identical.
import {
  convertContour,
  convertContourSplit,
  contourSplit,
  mergeSplit,
  framePatch,
} from './cpatchConvert.js';
import { K_IMPL, K_PK } from '../geom/cpatchImplicit.js';
import { mantleWarn, mantleDebugHook } from '../core/diagnostics.js';
import { workerFlags } from './workerFlags.js';
import { spawnWorker, registerWorkerPool, describeWorkerError } from './workerConfig.js';

const HARD_CAP = 8;
let _pool = null; // { workers: [], inflight: Map<worker, job[]>, queue: [] }
let _poolFailed = false;
let _nextId = 1;

/// Every post is accounted for: posted = answered + failed + in flight + queued, always. A job that
/// is none of those four has been dropped, and a dropped job is a conversion that never lands.
/// cpatchConvStats in cpatchBuild reports it beside any stalled conversion, and debugStats carries both.
const _acct = { posted: 0, answered: 0, failed: 0 };

/// { posted, answered, failed, inflight, queued, oldestMs } -- oldestMs is the age of the oldest job
/// still waiting for an answer, in flight or queued.
export function cpatchPoolStats() {
  let inflight = 0,
    queued = 0,
    oldest = Infinity;
  const p = _pool;
  if (p) {
    for (const q of p.inflight.values()) {
      inflight += q.length;
      for (const j of q) if (j._tPost < oldest) oldest = j._tPost;
    }
    queued = p.queue.length;
    for (const j of p.queue) if (j._tPost < oldest) oldest = j._tPost;
  }
  return {
    posted: _acct.posted,
    answered: _acct.answered,
    failed: _acct.failed,
    inflight,
    queued,
    oldestMs: oldest === Infinity ? 0 : Math.round(performance.now() - oldest),
  };
}

/// THE PROBE'S FLAGS, FORWARDED. Conversion and packing happen in here, so a switch set on the main
/// thread reaches nothing that matters unless the message carries it (workerFlags.js, which the
/// Loop-Blinn pool uses too).

export function cpatchPoolSize() {
  if (mantleDebugHook('__CP_POOL_N') > 0) return mantleDebugHook('__CP_POOL_N') | 0; // diagnostic: a probe's sweep
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  // Leave a core for the main thread: conversion runs while it is still preparing
  // bundles, and starving that just moves the stall.
  return Math.max(1, Math.min(HARD_CAP, hc - 1));
}

function _spawn() {
  if (_pool || _poolFailed) return _pool;
  if (typeof Worker === 'undefined') {
    _poolFailed = true;
    return null;
  }
  try {
    const n = cpatchPoolSize();
    const workers = [],
      inflight = new Map();
    for (let i = 0; i < n; i++) {
      const w = spawnWorker(
        'cpatch',
        () => new Worker(new URL('./cpatch.worker.js', import.meta.url), { type: 'module' }),
      );
      if (!w) {
        for (const x of workers) {
          try {
            x.terminate();
          } catch {
            /* ignore */
          }
        }
        _poolFailed = true;
        return null;
      } // disabled by configureWorkers
      w.onmessage = (e) => _onDone(w, e.data);
      // A dead worker must not hang the batch: fail its in-flight jobs and let the
      // caller's sync fallback finish the work.
      w.onerror = (e) => _fail(w, describeWorkerError(e));
      // ...AND A REPLY THAT CANNOT BE READ IS THE same FAILURE. 'messageerror' fires instead of
      // 'message' when the answer does not deserialize, so the job it answered would otherwise wait
      // for a message that has already come and gone.
      w.onmessageerror = () => _fail(w, 'a reply could not be deserialized');
      workers.push(w);
      inflight.set(w, []);
    }
    _pool = { workers, inflight, queue: [] };
  } catch (ex) {
    _poolFailed = true;
    _pool = null;
    mantleWarn(
      '[mantle] CPatch conversion workers failed to construct -- conversions run on the main thread:',
      ex,
    );
  }
  return _pool;
}

const DEPTH = 2;

function _onDone(w, data) {
  const p = _pool;
  if (!p) return;
  const q = p.inflight.get(w);
  const job = q && q.length ? q.shift() : null; // a worker answers its jobs in order
  if (job) q._cost = (q._cost || 0) - (job._cost || 0);
  // DIAGNOSTIC TAP (globalThis.__CP_POOL_TAP = []): one row per post -- which worker, when it was
  // handed the post, when it answered, the worker's own start/end stamps, how many curves --
  // for a probe to compute the pool's utilization, its tail and its largest unit. Costs one
  // object per post when armed.
  if (globalThis.__CP_POOL_TAP && job)
    globalThis.__CP_POOL_TAP.push({
      w: p.workers.indexOf(w),
      t0: job._t0 || 0,
      t1: performance.now(),
      wt0: data && data.wt0,
      wt1: data && data.wt1,
      n: job.jobs.reduce((s, j) => s + ((j.curves && j.curves.length) | 0), 0),
      jobs: job.jobs.length,
    });
  if (job) {
    _acct.answered++;
    job.resolve(data && data.out ? data.out : []);
  }
  _drain();
}

function _reject(job, why) {
  _acct.failed++;
  job.reject(new Error(why));
}

function _fail(w, why) {
  const p = _pool;
  if (!p) return;
  const q = p.inflight.get(w) || [];
  p.inflight.delete(w);
  for (const job of q) _reject(job, 'cpatch worker failed');
  // Do not push a broken worker back into rotation.
  const i = p.workers.indexOf(w);
  if (i >= 0) p.workers.splice(i, 1);
  // LOUD, like the Loop-Blinn build worker: a dead pool is a silent performance inversion -- every
  // conversion it would have run lands on the main thread instead.
  if (!p.warned) {
    p.warned = true;
    mantleWarn(
      '[mantle] CPatch conversion worker failed -- its jobs convert on the main thread:',
      why || 'unknown',
    );
  }
  if (!p.workers.length) {
    for (const job of p.queue) _reject(job, 'cpatch pool has no workers');
    p.queue.length = 0;
    _poolFailed = true;
    _pool = null;
  } else _drain();
}

const COST_DEPTH = 24;

function _drain() {
  const p = _pool;
  if (!p) return;
  const depth =
    mantleDebugHook('__CP_POOL_DEPTH') > 0 ? mantleDebugHook('__CP_POOL_DEPTH') | 0 : DEPTH;
  const costDepth =
    mantleDebugHook('__CP_POOL_COST') != null ? +mantleDebugHook('__CP_POOL_COST') : COST_DEPTH;
  while (p.queue.length) {
    // The least-loaded eligible worker takes the next job: one with nothing in flight always is;
    // otherwise one under the count cap whose in-flight work is under the cost floor.
    let best = null,
      bestC = Infinity;
    for (const w of p.workers) {
      const q = p.inflight.get(w);
      const n = q.length;
      if (n === 0) {
        best = w;
        bestC = -1;
        break;
      }
      const ok = costDepth > 0 ? n < 8 && (q._cost || 0) < costDepth : n < depth;
      if (!ok) continue;
      if (q._cost < bestC) {
        bestC = q._cost;
        best = w;
      }
    }
    if (!best) break;
    const job = p.queue.shift();
    const q = p.inflight.get(best);
    q.push(job);
    q._cost = (q._cost || 0) + _jobCost(job.jobs);
    job._cost = _jobCost(job.jobs);
    if (globalThis.__CP_POOL_TAP) job._t0 = performance.now();
    best.postMessage({
      id: _nextId++,
      jobs: job.jobs,
      opts: job.opts,
      kind: job.kind,
      flags: workerFlags(),
    });
  }
}

/// Hand the thread back and resume `fn` as a fresh task, behind every message already queued --
/// which is what lets worker replies through between slices of main-thread work. A MessageChannel
/// task runs at once; setTimeout(0) is clamped to a millisecond or more once nested.
export function laterTask(fn) {
  if (typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      fn();
    };
    ch.port2.postMessage(0);
  } else setTimeout(fn, 0);
}

function _jobCost(jobs) {
  let c = 0;
  for (const j of jobs) c += j.curves ? j.curves.length | 0 : COST_DEPTH;
  return c;
}

// Bound work in the geometry routines rather than timing out queued jobs.
// Cached conversions and trace bakes must not depend on machine speed.
function _post(jobs, opts, kind) {
  _acct.posted++;
  return new Promise((resolve, reject) => {
    _pool.queue.push({ jobs, opts, kind, resolve, reject, _tPost: performance.now() });
    _drain();
  });
}

// Rebuild frames from the worker-provided interior points and coefficient memos.
// If any frame cannot be restored, refuse the complete contour; omitting a
// patch would change the fill.
function _rehydrate(r) {
  if (!r || !r.patches || !r.patches.slim) return r;
  const out = [];
  for (const sp of r.patches.slim) {
    // The constraints the worker's frame carried (see the worker's slim form), put back before
    // framing so the memo hands them out instead of deriving new ones.
    if (sp.m)
      for (let k = 0; k < sp.c.length; k++) {
        if (sp.m[k][0]) sp.c[k][K_IMPL] = sp.m[k][0];
        if (sp.m[k][1]) sp.c[k][K_PK] = sp.m[k][1];
      }
    const f = framePatch(sp.c, sp.i);
    if (!f) return { key: r.key, patches: null, err: 'frame did not rebuild' };
    if (sp.s) for (let k = 0; k < f.impls.length; k++) f.impls[k].s = sp.s[k];
    if (sp.t) f._terminal = true;
    out.push(f);
  }
  return { key: r.key, patches: { patches: out, stats: r.patches.stats }, err: r.err };
}

/// Without workers (node, a Worker-less host, a pool that died) every contour converts here --
/// SPLIT exactly as the pool splits it, so the decomposition does not depend on which ran.
function _syncConvert(contours, opts) {
  return contours.map((curves, i) => {
    try {
      return { key: i, patches: convertContourSplit(curves, opts || {}), err: null };
    } catch (ex) {
      return { key: i, patches: null, err: String((ex && ex.message) || ex) };
    }
  });
}

/// Convert `contours` (array of curve arrays) to patches, fanned across the pool.
/// Resolves to an array of { patches, err } in INPUT ORDER.
export async function convertContoursPooled(contours, opts = {}) {
  const list = contours || [];
  if (!list.length) return [];
  const pool = _spawn();
  if (!pool) return _syncConvert(list, opts);

  // LONGEST-PROCESSING-TIME-FIRST, and batched BY COST rather than by count.

  // So: heaviest first (a worker that starts the long pole at t=0 is the only way to finish at
  // the floor), and batches closed on ACCUMULATED COST, so an expensive contour travels alone
  // while cheap ones still ride together and amortize the postMessage.
  //
  const n = pool.workers.length;

  const units = []; // { key, part, parts, curves, tolPx }
  for (let k = 0; k < list.length; k++) {
    const c = list[k] || [];
    const sp = contourSplit(c, opts);
    if (sp)
      for (let p = 0; p < sp.pieces.length; p++)
        units.push({
          key: k,
          part: p,
          parts: sp.pieces.length,
          curves: sp.pieces[p],
          tolPx: sp.tolPx,
        });
    else units.push({ key: k, part: 0, parts: 1, curves: c });
  }
  const order = units
    .map((u, i) => i)
    .sort((a, b) => units[b].curves.length - units[a].curves.length);
  let totalCost = 0;
  for (const u of units) totalCost += u.curves.length;
  // Post one conversion unit per job, in descending curve-count order.
  // Idle workers take the next job. The optional cost mode batches units.
  const posts = [];
  if (opts.batch === 'cost') {
    const target = Math.max(1, totalCost / (n * 6));
    let jobs = [],
      acc = 0;
    for (const ui of order) {
      jobs.push({ key: ui, curves: units[ui].curves, tolPx: units[ui].tolPx });
      acc += units[ui].curves.length;
      if (acc >= target) {
        posts.push(_post(jobs, opts));
        jobs = [];
        acc = 0;
      }
    }
    if (jobs.length) posts.push(_post(jobs, opts));
  } else {
    for (const ui of order)
      posts.push(_post([{ key: ui, curves: units[ui].curves, tolPx: units[ui].tolPx }], opts));
  }
  let settled;
  try {
    settled = await Promise.all(posts);
  } catch {
    return _syncConvert(list, opts);
  } // a worker died mid-batch

  // Merge: a unit's result goes under its contour's key, and a split contour's parts merge in
  // piece order with mergeSplit, as convertContourSplit merges them. One failed part fails the
  // contour, and the fallback below then converts it whole -- again as convertContourSplit does.
  const unitOut = new Array(units.length).fill(null);
  for (const batchOut of settled) for (const r of batchOut) unitOut[r.key] = _rehydrate(r);
  const out = new Array(list.length).fill(null);
  const parts = new Map(),
    failed = new Set();
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui],
      r = unitOut[ui];
    if (u.parts === 1) {
      if (r) out[u.key] = { key: u.key, patches: r.patches, err: r.err };
      continue;
    }
    if (!r || !r.patches || !r.patches.patches) {
      failed.add(u.key);
      continue;
    }
    if (!parts.has(u.key)) parts.set(u.key, []);
    parts.get(u.key)[u.part] = r.patches;
  }
  for (const [k, ps] of parts)
    if (!failed.has(k)) out[k] = { key: k, patches: mergeSplit(ps), err: null };
  // Anything the pool did not return (a dropped batch) is converted here rather
  // than silently coming back null.
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    try {
      out[i] = { key: i, patches: convertContour(list[i], opts), err: null };
    } catch (ex) {
      out[i] = { key: i, patches: null, err: String((ex && ex.message) || ex) };
    }
  }
  return out;
}

export function warmCpatchPool() {
  const pool = _spawn();
  if (!pool) return Promise.resolve(false);
  if (pool.warmed) return pool.warmed;
  const cubic = (a, b, c, d) => ({ t: 'cubic', P: [a, b, c, d] });
  const line = (a, b) => ({ t: 'line', P: [a, b] });
  const claw = [
    cubic([-122.3, 84.29], [-122.3, 84.29], [-122.2, 86.18], [-123.03, 86.16]),
    cubic([-123.03, 86.16], [-123.85, 86.14], [-140.3, 38.07], [-160.83, 40.31]),
    cubic([-160.83, 40.31], [-160.83, 40.31], [-143.05, 32.96], [-122.3, 84.29]),
  ];
  const blob = [
    cubic([0, 0], [30, -40], [70, 40], [100, 0]),
    cubic([100, 0], [130, 30], [100, 60], [60, 90]),
    cubic([60, 90], [40, 20], [0, 60], [0, 40]),
    line([0, 40], [-20, 30]),
    line([-20, 30], [0, 0]),
  ];
  // Warm conversion branches on every worker using rotated inputs to avoid
  // memo hits. Queue the rounds together so idle workers can take more work.
  const rounds =
    mantleDebugHook('__CP_WARM_ROUNDS') != null ? mantleDebugHook('__CP_WARM_ROUNDS') | 0 : 24;
  const rot = (cs, k) => {
    const a = k * 0.37,
      c = Math.cos(a),
      s = Math.sin(a);
    return cs.map((sg) => ({
      t: sg.t,
      P: sg.P.map((p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]),
    }));
  };

  const opts = { maxCurves: 8, search: 'full', __warm: true }; // the main-thread helper leaves these to the workers
  const posts = [];
  for (let r = 0; r < rounds * pool.workers.length; r++)
    posts.push(
      _post(
        [
          { key: 0, curves: rot(claw, r) },
          { key: 1, curves: rot(blob, r) },
        ],
        opts,
      ),
    );
  pool.warmed = Promise.all(posts).then(
    () => true,
    () => false,
  );
  return pool.warmed;
}

// configureWorkers() stops the running pool; jobs it held are rejected and the callers' main-thread fallback finishes them.
registerWorkerPool('cpatch', () => disposeCpatchPool());

export function disposeCpatchPool() {
  if (!_pool) return;
  const p = _pool;
  for (const w of p.workers) {
    try {
      w.terminate();
    } catch {
      /* already gone */
    }
  }
  _pool = null;
  _poolFailed = false;
  // A terminated worker never answers, so its jobs -- and the queue nobody will now drain -- are
  // settled here rather than left pending for as long as their callers hold them.
  for (const q of p.inflight.values()) for (const job of q) _reject(job, 'cpatch pool disposed');
  for (const job of p.queue) _reject(job, 'cpatch pool disposed');
  p.inflight.clear();
  p.queue.length = 0;
}

// Plan each { key, A, B, nativeExact } entry in the worker pool.
// Return { key, A, B, plan, err } results in input order. Native contours
// are certified before decomposition planning. Without workers, return
// refused plans and leave rendering on its fallback route.
export async function planMorphsPooled(pairs, opts = {}) {
  const list = pairs || [];
  if (!list.length) return [];
  const pool = _spawn();
  if (!pool) return list.map((j) => ({ key: j.key, plan: null, err: 'no workers' }));
  const posts = list.map((j) =>
    _post([{ key: j.key, A: j.A, B: j.B, nativeExact: j.nativeExact === true }], opts, 'plan'),
  );
  let settled;
  try {
    settled = await Promise.all(posts);
  } catch {
    return list.map((j) => ({ key: j.key, plan: null, err: 'worker failed' }));
  }
  const out = new Array(list.length).fill(null);
  for (const batchOut of settled)
    for (const r of batchOut) {
      const i = list.findIndex((j) => j.key === r.key);
      if (i >= 0) out[i] = r;
    }
  return out.map((r, i) => r || { key: list[i].key, plan: null, err: 'lost' });
}
