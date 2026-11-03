// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Worker policy shared by the four build pools (Loop-Blinn, CPatch, occlusion, occupancy).
//
// By default each pool starts its own module worker with `new Worker(new URL('./x.worker.js', import.meta.url))`,
// the form Vite and webpack 5 recognize and emit. That cannot work everywhere: esbuild and rollup leave the URL
// pointing at a file they never emitted, a Content-Security-Policy `worker-src` can forbid workers, and a module
// graph served from another origin cannot start one. Each failure falls back to the same work on the main thread
// (slower, never wrong) with one console warning. `configureWorkers` is the explicit control:
//
//   configureWorkers({ enabled: false });                 // never start a worker; run everything on the main thread
//   configureWorkers({ lb: new URL('/w/lbBuild.worker.js', location.href) });   // your own URL for one pool
//   configureWorkers({ cpatch: () => new Worker(url, { type: 'module' }) });    // or a factory
//
// Call it before the first renderer or bundle is created; calling it later stops the running workers
// (their pending work finishes on the main thread) and the next request starts them under the new policy.
// The pools are shared by every renderer on the page, so the policy is global, not a createRenderer option.

/** @typedef {string | URL | (() => Worker)} WorkerSource */
/** @typedef {{ enabled?: boolean, lb?: WorkerSource | null, cpatch?: WorkerSource | null,
 *   occlusion?: WorkerSource | null, occupancy?: WorkerSource | null }} WorkerConfig */

const KINDS = ['lb', 'cpatch', 'occlusion', 'occupancy'];
let _enabled = true;
/** @type {Record<string, WorkerSource | null>} */
const _sources = { lb: null, cpatch: null, occlusion: null, occupancy: null };
/** @type {Map<string, () => void>} */
const _resets = new Map();

/// A pool registers how to stop its workers and forget a recorded failure.
export function registerWorkerPool(kind, reset) {
  _resets.set(kind, reset);
}

/**
 * Set the worker policy: disable workers, or supply the worker script (a URL, or a factory returning a started
 * `Worker`) for any of the four pools: `lb` (Loop-Blinn mesh builds), `cpatch` (CPatch conversion),
 * `occlusion` (occlusion cull) and `occupancy` (interior-skip grids). Unspecified fields keep their value; `null`
 * restores the default. Unknown keys throw. Returns the policy now in force.
 * @param {WorkerConfig} [opts]
 * @returns {{ enabled: boolean, lb: boolean, cpatch: boolean, occlusion: boolean, occupancy: boolean }} which pools have a custom source
 */
export function configureWorkers(opts) {
  if (opts === undefined) return workerPolicy();
  if (opts === null || typeof opts !== 'object')
    throw new Error('configureWorkers: pass an options object, e.g. { enabled: false }.');
  for (const k of Object.keys(opts)) {
    if (k !== 'enabled' && !KINDS.includes(k)) {
      throw new Error(
        `configureWorkers: unknown option '${k}' (expected enabled, ${KINDS.join(', ')}).`,
      );
    }
  }
  if ('enabled' in opts && typeof opts.enabled !== 'boolean')
    throw new Error('configureWorkers: enabled must be true or false.');
  for (const k of KINDS) {
    const v = /** @type {any} */ (opts)[k];
    if (
      v !== undefined &&
      v !== null &&
      typeof v !== 'string' &&
      typeof v !== 'function' &&
      !(v instanceof URL)
    ) {
      throw new Error(
        `configureWorkers: ${k} must be a URL, a string, or a function returning a Worker.`,
      );
    }
  }
  if ('enabled' in opts) _enabled = /** @type {boolean} */ (opts.enabled);
  for (const k of KINDS) if (k in opts) _sources[k] = /** @type {any} */ (opts)[k] ?? null;
  for (const reset of _resets.values()) reset();
  return workerPolicy();
}

/**
 * Stop every worker the shared pools started (Loop-Blinn, CPatch, occlusion, occupancy), for a page that is done with Mantle or an
 * app that wants its threads back. Work still queued finishes on the main thread, and the policy set by `configureWorkers` is
 * unchanged: the next request that wants a worker starts a new one. Safe to call at any time and more than once.
 * @returns {number} how many pools were asked to stop
 */
export function terminateWorkers() {
  let n = 0;
  for (const reset of _resets.values()) {
    reset();
    n++;
  }
  return n;
}

function workerPolicy() {
  return {
    enabled: _enabled,
    lb: !!_sources.lb,
    cpatch: !!_sources.cpatch,
    occlusion: !!_sources.occlusion,
    occupancy: !!_sources.occupancy,
  };
}

/// Whether the policy allows workers at all.
export function workersEnabled() {
  return _enabled;
}

/// Start the worker for `kind`, or return null when the policy disables workers. `makeDefault` is the pool's
/// own `() => new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`; it stays at the call
/// site so a bundler sees the literal pattern it knows how to emit.
export function spawnWorker(kind, makeDefault) {
  if (!_enabled) return null;
  const src = _sources[kind];
  if (typeof src === 'function') return src();
  if (src) return new Worker(src, { type: 'module' });
  return makeDefault();
}

/// Readable text for a worker `error` event. A failed worker load (a CSP `worker-src`, a 404 for the script, a
/// cross-origin URL) delivers an ErrorEvent with an empty message, which printed as "[object Event]".
export function describeWorkerError(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.filename) parts.push(`${e.filename}${e.lineno ? ':' + e.lineno : ''}`);
  if (parts.length) return parts.join(' at ');
  const type = e.type ? `${e.type} event` : String(e);
  return (
    `${type} with no message: the worker script could not be loaded or was blocked (a missing file, a ` +
    'Content-Security-Policy worker-src, or a cross-origin URL). Use configureWorkers({ enabled: false }) to run ' +
    'on the main thread without this warning.'
  );
}
