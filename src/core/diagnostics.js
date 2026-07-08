// diagnostics.js — opt-in logging and test-only debug flags.
//
// Library code calls mantleWarn / mantleError instead of console.* so
// integrators can silence, redirect, or capture diagnostics.

let _onWarn = null;
let _onError = null;
let _silent = false;
let _colrTrace = null;

/** Replace or silence library warnings/errors.
 *  `colrTrace`: pass an array to collect a per-node COLR filter-graph
 *  trace during draws (diagnostic; `null` disables). */
export function setDiagnostics({ onWarn, onError, silent, colrTrace } = {}) {
  if (onWarn !== undefined) _onWarn = onWarn;
  if (onError !== undefined) _onError = onError;
  if (silent !== undefined) _silent = silent;
  if (colrTrace !== undefined) _colrTrace = colrTrace;
}

/** The active COLR trace sink (array) or null. */
export function colrTraceSink() { return _colrTrace; }

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
 * Test / dev hooks on globalThis. In production builds, set
 * `globalThis.__MANTLE_DEBUG__ = true` before toggling sub-flags, or
 * pass explicit opts (e.g. `createMantleScene({ forceNative: true })`).
 */
export function mantleDebugFlag(name) {
  if (typeof globalThis === 'undefined') return false;
  const g = globalThis;
  switch (name) {
    case 'forceNative':
      return g.__MANTLE_FORCE_NATIVE === true;
    default:
      return false;
  }
}
