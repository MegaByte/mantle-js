// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// workerFlags.js — the page's switches, carried to the build workers with every message.
//
// A switch read inside a pooled build is read in the WORKER's global scope, which sees only what
// the message carries. So each pool sends the switches its worker reads with every message
// (`workerFlags`), and the worker applies them for that message alone (`applyWorkerFlags`): the
// worker outlives a build, so a flag left behind would configure the next one.

// What crosses: a primitive, always -- the reader applies its own gate, and `__MANTLE_DEBUG__`
// travels like any other switch, so a test hook answers in the worker exactly as on the page. A
// structured-data test hook (`__CP_OPTS`) crosses only while `__MANTLE_DEBUG__` is on, the only
// state in which it is read. A function never does.
//
// MAIN-THREAD only, by contract: the diagnostic SINKS -- arrays, objects, functions and counters a
// probe sets up for the library to fill or call, and the flags that arm them. A worker's copy would
// be filled and thrown away, and a function cannot cross at all. A probe that needs one builds on
// the main thread (`buildCPatchBundle(gl, bundle, { pool: false })`, or node, which has no Worker);
// setting one while a pool posts warns once. The globals the library itself WRITES are outputs and
// never cross in either direction.
//
// The other two workers carry no flags. occlusion.worker reads no global at all; occupancy.worker's
// import graph reaches lbCubicMath through svg/textures.js, but neither buildOccupancyGrid nor
// computeGwnOccupancyCells calls the functions that read its knobs.
import { mantleWarn } from '../core/diagnostics.js';

/// Every switch a pooled build reads: live knobs, the OFF switches still awaiting an answer, and the
/// test hooks (read under `__MANTLE_DEBUG__`, which is itself on the list).
export const WORKER_SWITCHES = Object.freeze([
  '__MANTLE_DEBUG__',
  // boolean debug flags read in a worker (mantleDebugFlag: lbPack, shapeRecognize)
  '__LB_BAND2_NOCHAIN',
  '__MANTLE_NO_SDF_PRIMS',
  // Loop-Blinn build and morph pair (lbBuildCore, lbPartition, lbFastMesh, lbCubicMath, loopBlinnMorph)
  '__LB_BEZ_FAITH_FRAC',
  '__LB_FAITH_ARC',
  '__LB_FAITH_DEPTH',
  '__LB_FAITH_GRID',
  '__LB_FAITH_MIN_T',
  '__LB_HULL_CAP',
  '__LB_HULL_TOL',
  '__LB_HULL_TOL_REL',
  '__LB_KLMN_MIN',
  '__LB_MIN_EDGE',
  '__LB_MORPH_DRIFT',
  '__LB_R_HOPS',
  '__LB_R_NEAR',
  '__LB_R_REACH',
  '__LB_R_TURN',
  '__LB_SPLIT_DEPTH',
  '__LB_SPLIT_TURN',
  '__LB_XSPLIT_MIN',
  '__LB_CUBIC_FASTPATH',
  '__lbAuditOff',
  '__LB_CUBIC_CHAIN',
  '__LB_CUBIC_CHAIN2',
  '__LB_SERPENTINE_PAIR',
  '__LB_BEZ_RING_ARC',
  '__LB_EMIT_ORDER',
  '__LB_STATIC_HULL',
  '__LB_BAND_FOOTPRINT',
  // CPatch conversion and morph planning (cpatchConvert, cpatchImplicit, cpatchGraph, cpatchMorphCert)
  '__CP_AFF_FLAT_REL',
  '__CP_COVER_TOL_REL',
  '__CP_DET_EPS',
  '__CP_LEAK_PROBE_N',
  '__CP_LEAK_REL',
  '__CP_MORPH_CERT_BUDGET',
  '__CP_MORPH_WORK_BUDGET',
  '__CP_NODE_BUDGET',
  '__CP_PAIR_BUDGET',
  '__CP_PROBE_OFF',
  '__CP_PROBE_TOP',
  '__CP_TOL_ABS',
  '__CP_TRI_EPS',
  '__CP_OPTS',
]);

/// Diagnostic sinks a probe sets for a build to fill or call, and the flags that arm them. Never
/// forwarded; setting one while a pool posts warns once.
export const MAIN_THREAD_SINKS = Object.freeze([
  '__CHAIN_DEBUG',
  '__chainDbg',
  '__leftoverDbg',
  '__EDGE_TAP',
  '__LB_HULLDUMP',
  '__LB_CDT_DROP',
  '__LB_CHAINEDGEDUMP',
  '__LB_FACE_TAP',
  '__lbAuditTrace',
  '__lbAuditBad',
  '__lbChainTrace',
  '__lbChainEmpty',
  '__lbProofTrace',
  '__CPQ',
  '__CP_AREA_AUDIT',
  '__CP_AREA_N',
  '__CP_AREA_OUT',
  '__CP_BEZCOUNT',
  '__CP_ISOCOUNT',
  '__CP_PHASECOUNT',
  '__CP_CALLS',
  '__CP_CALL_CAP',
  '__CP_CROSS_AUDIT',
  '__CP_EAR_DUMP',
  '__CP_LOOP_AUDIT',
  '__CP_SIZES',
  '__CP_STATS',
  '__CP_TERM_HOOK',
]);

/// Globals the library WRITES as a record of what it did. Outputs: never forwarded, never warned about.
export const LIBRARY_OUTPUTS = Object.freeze([
  '__lbDeclineWhy',
  '__lbPartitionErr',
  '__lbAuditTot',
  '__lbAuditBadN',
  '__lbAuditPieces',
  '__lbProofWhy',
  '__CP_FROZEN_DECLINES',
]);

/// Plain data a structured clone reproduces exactly: primitives, arrays, typed arrays and plain
/// objects of them. Depth-bounded, so a cycle is refused rather than walked.
function plainData(v, depth = 0) {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return true;
  if (t !== 'object' || depth > 8) return false;
  if (ArrayBuffer.isView(v)) return true;
  if (Array.isArray(v)) return v.every((e) => plainData(e, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(v)) if (!plainData(v[k], depth + 1)) return false;
  return true;
}

const _warned = new Set();

/// The switches to send with a worker message, or null when none is set.
export function workerFlags() {
  if (typeof globalThis === 'undefined') return null;
  const g = /** @type {any} */ (globalThis);
  let out = null;
  for (const k of WORKER_SWITCHES) {
    const v = g[k];
    if (v === undefined) continue;
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string' || v === null)
      (out || (out = {}))[k] = v;
    else if (t === 'object' && g.__MANTLE_DEBUG__ === true && plainData(v))
      (out || (out = {}))[k] = v;
  }
  for (const k of MAIN_THREAD_SINKS) {
    if (g[k] === undefined || g[k] === null || _warned.has(k)) continue;
    _warned.add(k);
    mantleWarn(
      `[mantle] ${k} is a main-thread diagnostic: a pooled build neither reports to it nor reads it. Build on the main thread to use it.`,
    );
  }
  return out;
}

let _applied = [];
/// Worker side: make `flags` this message's switches, removing the previous message's first.
export function applyWorkerFlags(flags) {
  const g = /** @type {any} */ (globalThis);
  for (const k of _applied) delete g[k];
  _applied = [];
  if (!flags) return;
  for (const k of Object.keys(flags)) {
    g[k] = flags[k];
    _applied.push(k);
  }
}
