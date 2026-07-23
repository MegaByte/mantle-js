// diagnostics.js — opt-in logging and test-only debug flags.
//
// Library code calls mantleWarn / mantleError instead of console.* so
// integrators can silence, redirect, or capture diagnostics.

let _onWarn = null;
let _onError = null;
let _silent = false;
let _colrTrace = null;

/** Hot-path diagnostic switches. Default off — a single property load + branch;
 *  no globalThis, no string dispatch, no Map alloc until explicitly enabled. */
export const diagFlags = {
  /** Log main-thread stalls ≥ this many ms (0 = off). */
  stallMs: 0,
  /** Aggregate LB/Slug route + draw-state traces into diagnosticTraces(). */
  engineTrace: false,
  /** Capture static-cache RT dumps into diagnosticTraces().cacheDumps. */
  dumpCache: false,
};

let _engineMap = null;
let _drawMap = null;
let _cacheDumps = null;

/** Replace or silence library warnings/errors; opt into draw/engine traces.
 *  `colrTrace`: pass an array to collect a per-node COLR filter-graph
 *  trace during draws (diagnostic; `null` disables).
 *  `stallMs` / `engineTrace` / `dumpCache`: see `diagFlags` — off by default
 *  and cheap to check on hot paths. */
export function setDiagnostics({
  onWarn, onError, silent, colrTrace,
  stallMs, engineTrace, dumpCache,
} = {}) {
  if (onWarn !== undefined) _onWarn = onWarn;
  if (onError !== undefined) _onError = onError;
  if (silent !== undefined) _silent = silent;
  if (colrTrace !== undefined) _colrTrace = colrTrace;
  if (stallMs !== undefined) diagFlags.stallMs = Math.max(0, Number(stallMs) || 0);
  if (engineTrace !== undefined) {
    diagFlags.engineTrace = !!engineTrace;
    if (diagFlags.engineTrace) {
      if (!_engineMap) _engineMap = new Map();
      if (!_drawMap) _drawMap = new Map();
    }
  }
  if (dumpCache !== undefined) {
    diagFlags.dumpCache = !!dumpCache;
    if (diagFlags.dumpCache && !_cacheDumps) _cacheDumps = [];
  }
}

/** The active COLR trace sink (array) or null. */
export function colrTraceSink() { return _colrTrace; }

/** Live trace sinks (Maps / array) or null when never enabled. */
export function diagnosticTraces() {
  return { engine: _engineMap, draw: _drawMap, cacheDumps: _cacheDumps };
}

/** Clear aggregated trace data (does not disable the flags). */
export function clearDiagnosticTraces() {
  if (_engineMap) _engineMap.clear();
  if (_drawMap) _drawMap.clear();
  if (_cacheDumps) _cacheDumps.length = 0;
}

/** @internal bump engine-route counter; no-op when engineTrace is off. */
export function diagNoteEngine(key) {
  if (!diagFlags.engineTrace) return;
  const m = _engineMap || (_engineMap = new Map());
  const hit = m.get(key);
  if (hit === undefined) m.set(key, 1); else m.set(key, hit + 1);
}

/** @internal bump draw-state counter; no-op when engineTrace is off. */
export function diagNoteDraw(key) {
  if (!diagFlags.engineTrace) return;
  const m = _drawMap || (_drawMap = new Map());
  const hit = m.get(key);
  if (hit === undefined) m.set(key, 1); else m.set(key, hit + 1);
}

/** @internal push a cache dump; no-op when dumpCache is off. */
export function diagPushCacheDump(entry) {
  if (!diagFlags.dumpCache) return;
  (_cacheDumps || (_cacheDumps = [])).push(entry);
}

export function mantleWarn(...args) {
  if (_silent) return;
  if (_onWarn) { _onWarn(...args); return; }
  if (typeof console !== 'undefined' && console.warn) console.warn(...args);
}

export function mantleError(...args) {
  if (_silent) return;
  if (_onError) { _onError(...args); return; }
  if (typeof console !== 'undefined' && console.error) console.error(...args);
}

/**
 * Debug / A-B hooks on `globalThis`.
 *
 * Production-safe escapes (always readable):
 *   - `forceNative` ← `__MANTLE_FORCE_NATIVE`
 *
 * Everything else requires `globalThis.__MANTLE_DEBUG__ = true` first, so a
 * leftover `__MANTLE_NO_*` on a live page cannot silently change shipped
 * pixels. Prefer explicit opts / `setDiagnostics` / `setLoopBlinnMeshOpts`
 * in application code.
 *
 * @param {string} name
 * @returns {boolean|string|number|null}
 */
export function mantleDebugFlag(name) {
  if (typeof globalThis === 'undefined') return false;
  const g = globalThis;
  if (name === 'forceNative') return g.__MANTLE_FORCE_NATIVE === true;

  const debug = g.__MANTLE_DEBUG__ === true;
  switch (name) {
    case 'lbBand2NoChain': return debug && g.__LB_BAND2_NOCHAIN === true;
    case 'noOccupancy': return debug && g.__MANTLE_NO_OCCUPANCY === true;
    case 'noOcclusionCull': return debug && g.__MANTLE_NO_OCCLUSION_CULL === true;
    case 'noGroupRect': return debug && g.__MANTLE_NO_GROUP_RECT === true;
    case 'noStaticCache': return debug && g.__MANTLE_NO_STATIC_CACHE === true;
    case 'noInstancedFast': return debug && g.__MANTLE_NO_INSTANCED_FAST === true;
    case 'noFilterBbox': return debug && g.__MANTLE_NO_FILTER_BBOX === true;
    case 'forceSlug': return debug && g.__MANTLE_FORCE_SLUG === true;
    default:
      return false;
  }
}
