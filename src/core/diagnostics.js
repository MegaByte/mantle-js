// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
  /** Make every glState setter read the driver back and warn on divergence —
   *  i.e. catch a pipeline-state write that bypassed the shadow. Costs a
   *  getParameter per set (which can flush), so it is a test/debug tool. */
  auditGlState: false,
};

let _engineMap = null;
let _drawMap = null;
let _cacheDumps = null;

/** Options for {@link setDiagnostics}. Typed explicitly because the
 *  destructured parameter alone emits `?: {}` into the generated .d.ts, and
 *  every property access then fails a strict consumer build.
 *
 *  @typedef {Object} DiagnosticsOptions
 *  @property {((...args: any[]) => void)|null} [onWarn]   replace the warn sink
 *  @property {((...args: any[]) => void)|null} [onError]  replace the error sink
 *  @property {boolean} [silent]        suppress both sinks
 *  @property {any[]|null} [colrTrace]  array to collect a per-node COLR
 *    filter-graph trace during draws; null disables
 *  @property {number} [stallMs]        log main-thread stalls >= this (0 = off)
 *  @property {boolean} [engineTrace]   aggregate LB/Slug route + draw-state
 *    traces into diagnosticTraces()
 *  @property {boolean} [dumpCache]     capture static-cache RT dumps
 *  @property {boolean} [auditGlState]  make every glState setter read the
 *    driver back and warn on divergence (test/debug: costs a getParameter
 *    per set, which can flush the pipeline)
 */

/** Replace or silence library warnings/errors; opt into draw/engine traces.
 *  `colrTrace`: pass an array to collect a per-node COLR filter-graph
 *  trace during draws (diagnostic; `null` disables).
 *  `stallMs` / `engineTrace` / `dumpCache` / `auditGlState`: see `diagFlags` —
 *  off by default and cheap to check on hot paths.
 *  @param {DiagnosticsOptions} [opts] */
export function setDiagnostics({
  onWarn,
  onError,
  silent,
  colrTrace,
  stallMs,
  engineTrace,
  dumpCache,
  auditGlState,
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
  if (auditGlState !== undefined) diagFlags.auditGlState = !!auditGlState;
}

/** The active COLR trace sink (array) or null. */
export function colrTraceSink() {
  return _colrTrace;
}

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
  if (hit === undefined) m.set(key, 1);
  else m.set(key, hit + 1);
}

/** @internal bump draw-state counter; no-op when engineTrace is off. */
export function diagNoteDraw(key) {
  if (!diagFlags.engineTrace) return;
  const m = _drawMap || (_drawMap = new Map());
  const hit = m.get(key);
  if (hit === undefined) m.set(key, 1);
  else m.set(key, hit + 1);
}

/** @internal push a cache dump; no-op when dumpCache is off. */
export function diagPushCacheDump(entry) {
  if (!diagFlags.dumpCache) return;
  (_cacheDumps || (_cacheDumps = [])).push(entry);
}

export function mantleWarn(...args) {
  if (_silent) return;
  if (_onWarn) {
    _onWarn(...args);
    return;
  }
  if (typeof console !== 'undefined' && console.warn) console.warn(...args);
}

/// Warns once per hit-only table (the object, not its contents): the table is static, so the warning is about the bundle.
const _hitOnlyWarned = new WeakSet();
export function warnHitOnlyStatic(hitOnly, subject, what) {
  if (!hitOnly || _hitOnlyWarned.has(hitOnly)) return;
  _hitOnlyWarned.add(hitOnly);
  const k = hitOnly.rows ? hitOnly.rows.length : 0;
  mantleWarn(
    `${subject}: the bundle has ${k} hit-only shape${k === 1 ? '' : 's'} (shapes that draw nothing but are pointer targets, such as a ` +
      `transparent hit rectangle). ${what} Hit tests keep them where they were authored. Only an override table moves them.`,
  );
}

export function mantleError(...args) {
  if (_silent) return;
  if (_onError) {
    _onError(...args);
    return;
  }
  if (typeof console !== 'undefined' && console.error) console.error(...args);
}

/**
 * Debug / A-B hooks on `globalThis`.
 *
 * Every one requires `globalThis.__MANTLE_DEBUG__ = true` first, so a
 * leftover `__MANTLE_NO_*` on a live page cannot silently change shipped
 * pixels. Value-carrying test hooks take the same gate through
 * {@link mantleDebugHook}. Prefer explicit opts / `setDiagnostics` / `setLoopBlinnMeshOpts`
 * in application code.
 *
 * @param {string} name
 * @returns {boolean|string|number|null}
 */
export function mantleDebugFlag(name) {
  if (typeof globalThis === 'undefined') return false;
  const g = globalThis;

  const debug = g.__MANTLE_DEBUG__ === true;
  switch (name) {
    case 'lbBand2NoChain':
      return debug && g.__LB_BAND2_NOCHAIN === true;
    case 'noOccupancy':
      return debug && g.__MANTLE_NO_OCCUPANCY === true;
    case 'noOcclusionCull':
      return debug && g.__MANTLE_NO_OCCLUSION_CULL === true;
    case 'noGroupRect':
      return debug && g.__MANTLE_NO_GROUP_RECT === true;
    case 'noGroupFilterSkip':
      return debug && g.__MANTLE_NO_GROUP_FILTER_SKIP === true;
    case 'noInstancedComposite':
      return debug && g.__MANTLE_NO_INSTANCED_COMPOSITE === true;
    case 'noAlphaSlots':
      return debug && g.__MANTLE_NO_ALPHA_SLOTS === true;
    case 'groupCopyComposite':
      return debug && g.__MANTLE_GROUP_COPY_COMPOSITE === true;
    case 'noStaticCache':
      return debug && g.__MANTLE_NO_STATIC_CACHE === true;
    case 'noInstancedFast':
      return debug && g.__MANTLE_NO_INSTANCED_FAST === true;
    case 'noAacPoints':
      return debug && g.__MANTLE_NO_AAC_POINTS === true;
    case 'noFilterBbox':
      return debug && g.__MANTLE_NO_FILTER_BBOX === true;
    case 'noSdfPrims':
      return debug && g.__MANTLE_NO_SDF_PRIMS === true;
    case 'forceSlug':
      return debug && g.__MANTLE_FORCE_SLUG === true;
    default:
      return false;
  }
}

/**
 * @internal A TEST HOOK's value: `globalThis[name]` while `globalThis.__MANTLE_DEBUG__ === true`,
 * otherwise `undefined`, so a hook left set on a live page reads as unset and cannot change
 * shipped output. The value-carrying twin of {@link mantleDebugFlag}, for hooks that pass a
 * string, a number or an object rather than a boolean. Read at call time, never at module
 * scope, so a flag the worker pools forward reaches a pooled build.
 *
 * The hooks that go through here, and what each forces:
 *   `__MANTLE_FILL_DEFINES`  extra fill-program defines (comma-separated)
 *   `__CP_DEFINES`           extra CPatch fill-program defines (comma-separated)
 *   `__MANTLE_NO_DEPTH`      the fill pass without its depth test
 *   `__lbAuditOff`           keep a Loop-Blinn mesh the over-paint audit would decline
 *   `__LB_CUBIC_FASTPATH`    send cubic shapes to Loop-Blinn's fast mesh first
 *   `__CP_OPTS`              default CPatch conversion options (explicit options still win)
 *   `__CP_GRID`              the CPatch packer's grid
 *   `__CP_AREA_SPLIT`        `false` draws a CPatch bundle as ONE combined program instead of its ordered area/seam runs (an A/B arm)
 *   `__CP_ONLY_PATCH`        emit one CPatch patch's cover geometry and no other
 *   `__CP_TEST_DECLINE_ALL`  decline every non-primitive CPatch shape (=== true)
 *   `__CP_COMP_ON`           pack each CPatch seam's outline companion, off by default (=== 1)
 *   `__LB_CUBIC_CHAIN`       a concave cubic's interior chain keeps its straight half-chords (=== false)
 *   `__LB_CUBIC_CHAIN2`      chain 2 takes no arc (false), or only the 'swap' / 'piece' placement
 *   `__LB_SERPENTINE_PAIR`   a moving-inflection morph skips the serpentine pair for the fine t-cells (=== false)
 *   `__LB_BEZ_RING_ARC`      a Bezout ring keeps the resultant instead of carrying its arc (=== false)
 *   `__LB_EMIT_ORDER`        the packer keeps the builder's order: no rings after hulls, no cubic faces first (=== false)
 *
 * @param {string} name  the global's full name, e.g. `'__CP_GRID'`
 * @returns {any}
 */
export function mantleDebugHook(name) {
  if (typeof globalThis === 'undefined') return undefined;
  const g = /** @type {any} */ (globalThis);
  return g.__MANTLE_DEBUG__ === true ? g[name] : undefined;
}

/**
 * @internal True while `globalThis.__MANTLE_DEBUG__ === true`: the gate for a test hook that arrives as an OPTION
 * rather than a global (createRenderer's `fillDefines`), read when the option is taken.
 * @returns {boolean}
 */
export function mantleDebugEnabled() {
  return (
    typeof globalThis !== 'undefined' && /** @type {any} */ (globalThis).__MANTLE_DEBUG__ === true
  );
}

// ── Duplicate-copy notice ──────────────────────────────────────────
// Module state (registries, caches, worker pools, the diagnostics sinks above) is per copy of this module. Unbundled ESM served
// from one origin is ONE copy however many scripts import it; two SEPARATELY BUNDLED builds on one page are two copies, and a
// feature registered in one is invisible to the other. Sharing state across copies is not safe (two bundles can be different
// versions with different worker protocols), so each copy stays independent, and the second to load says so once.
{
  const COPIES = Symbol.for('@kontek/mantle.copies');
  const g = /** @type {any} */ (globalThis);
  const n = (g[COPIES] | 0) + 1;
  g[COPIES] = n;
  if (n === 2)
    mantleWarn(
      '[Mantle] a second copy of Mantle was loaded on this page. Each copy has its own feature registrations, caches and worker pool, ' +
        'so a feature imported into one is not seen by the other. Serve one copy (an import map to a single URL per module) to share them.',
    );
}
