// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Build CPatch meshes from decoded curves and upload appended coefficients.
// Meshes use the shared fill layout with CPatch kind14. Constraint indices
// address blocks appended after the original curve texture payload.

import { claimFillMeshes, MESH_OWNER } from './fillMeshOwner.js';
import { circleFromContours, ellipseFromContours } from '../geom/shapeRecognize.js';
import { packLoopBlinnMesh } from './lbPack.js';

import {
  packCPatchShape,
  cpatchConvKey,
  cpatchConvSettings,
  CP_BLOCK_TEXELS,
} from './cpatchPack.js';
import { segSlice } from '../geom/cpatchImplicit.js';
import { snapSubPrecisionLines, snapSubPrecisionHandles } from '../core/subPrecision.js';
import { cubicInflections, cubicLoopCuts } from '../geom/lbCubicMath.js';
import { convertContoursPooled, laterTask, cpatchPoolStats } from './cpatchWorkerPool.js';
import { peekLedger, notePreparationBytes, preparationCheckpoint } from './memoryLedger.js';
import { mantleWarn, mantleError, mantleDebugHook } from '../core/diagnostics.js';
// Contours convert independently in the worker pool. Pending bundles retain
// their fallback geometry until the converted coefficients can be uploaded.
import { curveRangeToContours } from '../geom/lbContour.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { encodeTraceBake } from './cpatchTrace.js';
import { parseMetaBin } from '../core/metaBin.js';
import { planeFits, maxTextureSize } from './tableLayout.js';

const TEX_W = 4096;

// Report stalled conversion without canceling it or changing geometry.
// cpatchOpts.stallReportMs overrides the warning delay; zero disables it.
export const CPATCH_STALL_REPORT_MS = 20000;

const _convStats = { stalled: 0, stalledLanded: 0 };

// Counts reported stalls and subsequent completions, with current pool statistics.
export function cpatchConvStats() {
  return {
    stalled: _convStats.stalled,
    stalledLanded: _convStats.stalledLanded,
    pool: cpatchPoolStats(),
  };
}

function reportStall(bundle, watch, cause, ex) {
  if (watch.stalled) return;
  watch.stalled = true;
  if (watch.timer) {
    clearTimeout(watch.timer);
    watch.timer = null;
  }
  _convStats.stalled++;
  const pool = cpatchPoolStats();
  bundle._cpatchStall = {
    ms: Math.round(performance.now() - watch.t0),
    cause,
    posted: pool.posted,
    answered: pool.answered,
    inflight: pool.inflight,
    queued: pool.queued,
  };
  if (ex) {
    mantleError(
      '[mantle] CPatch conversion stopped part way and will not land; this bundle draws its fallback engine:',
      cause,
    );
  } else {
    mantleWarn(
      `[mantle] CPatch conversion has not landed after ${bundle._cpatchStall.ms} ms; this bundle draws its fallback` +
        ` engine until it does. Pool: ${pool.answered} of ${pool.posted} posts answered, ${pool.inflight} in flight,` +
        ` ${pool.queued} queued, oldest waiting ${pool.oldestMs} ms.`,
    );
  }
}

function settleWatch(bundle, watch) {
  if (watch.timer) {
    clearTimeout(watch.timer);
    watch.timer = null;
  }
  if (!watch.stalled) return;
  _convStats.stalledLanded++;
  const ms = Math.round(performance.now() - watch.t0);
  if (bundle._cpatchStall) bundle._cpatchStall.landedMs = ms;
  mantleWarn(`[mantle] CPatch conversion reported stalled has landed, after ${ms} ms.`);
}

// Translate importer segments to converter curves. Unsupported or empty shapes
// return null and record the refusal in bundle._cpatchBail.
export function contoursToConverter(contours, bundle) {
  const cs = [];
  for (const c of contours) {
    const out = [];
    for (const sg of c) {
      // Segment tags use the importer constants, including SEG_RQUAD.
      const t =
        sg.type === SEG_LINE
          ? 'line'
          : sg.type === SEG_QUAD
            ? 'quad'
            : sg.type === SEG_CUBIC
              ? 'cubic'
              : sg.type === SEG_RQUAD
                ? 'rquad'
                : null;
      if (!t) {
        if (bundle) bundle._cpatchBail = 'segtype ' + sg.type;
        return null;
      }
      const P = [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean);
      // Coincident-endpoint lines and quadratics retrace and enclose no area.
      // A cubic can enclose area with coincident endpoints; drop it only when
      // all controls coincide. The tolerance below scales with this segment.
      const a = P[0],
        b = P[P.length - 1];
      let _ex = 0,
        _ey = 0;
      for (const q of P) {
        for (const r of P) {
          const dx = Math.abs(q[0] - r[0]),
            dy = Math.abs(q[1] - r[1]);
          if (dx > _ex) _ex = dx;
          if (dy > _ey) _ey = dy;
        }
      }
      const _sc = 1e-9 * Math.max(_ex, _ey);
      const same = (u, v) => u && v && Math.abs(u[0] - v[0]) <= _sc && Math.abs(u[1] - v[1]) <= _sc;
      if ((t === 'line' || t === 'quad' || t === 'rquad') && same(a, b)) continue;
      if (t === 'cubic' && same(a, b) && same(a, P[1]) && same(a, P[2])) continue;

      out.push(sg.w != null ? { t, P, w: sg.w } : { t, P });
    }
    if (out.length >= 2) cs.push(preSplit(snapSubPrecisionHandles(snapSubPrecisionLines(out))));
  }
  if (!cs.length) {
    if (bundle) bundle._cpatchBail = 'no contours';
    return null;
  }
  return cs;
}

// Split cubics at inflections/double points by default. Numeric values above
// one select uniform subdivision; one disables subdivision.
/** @type {'singular' | number} */
export let CP_PRESPLIT = 'singular';
export function setCPatchPreSplit(n) {
  CP_PRESPLIT = n === 'singular' ? n : n > 1 ? n | 0 : 1;
}

// Keep the source implicit while subdividing converter boundaries.
function preSplit(out) {
  if (CP_PRESPLIT === 'singular') return splitAtSingular(out);
  if (CP_PRESPLIT <= 1) return out;
  const res = [];
  for (const sg of out) {
    if (sg.t === 'line') {
      res.push(sg);
      continue;
    }
    for (let k = 0; k < CP_PRESPLIT; k++)
      res.push(segSlice(sg, k / CP_PRESPLIT, (k + 1) / CP_PRESPLIT));
  }
  return res;
}

// A cubic has at most two inflections and one double point. Split at their
// parameters to isolate branches before implicit conversion.

function splitAtSingular(out) {
  const res = [];
  for (const sg of out) {
    if (sg.t !== 'cubic' || !sg.P || sg.P.length !== 4) {
      res.push(sg);
      continue;
    }
    const ts = [];
    for (const t of cubicInflections(sg.P) || []) if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
    for (const t of cubicLoopCuts(sg.P) || []) if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
    if (!ts.length) {
      res.push(sg);
      continue;
    }
    ts.sort((a, b) => a - b);
    let pr = 0;
    for (const t of ts)
      if (t - pr > 1e-4) {
        res.push(segSlice(sg, pr, t));
        pr = t;
      }
    res.push(pr > 0 ? segSlice(sg, pr, 1) : sg);
  }
  return res;
}

// Fill rule is per shape: MT_STROKE_PARAMS.y selects even-odd.
export function shapeEvenOdd(bundle, s) {
  const mst = bundle.metaFloatsPerShape | 0;
  const meta = bundle.metaFloats;
  return !!(meta && mst && meta[s * mst + 3 * 4 + 1] > 0.5);
}

// Use authored float64 controls when retained; otherwise use the float32 wire.
// Runtime conversion and offline baking must use the same source plane.
export function cpatchCurvePlane(bundle) {
  return bundle.curveFloats64 && bundle.curveFloats64.length >= bundle.curveFloats.length
    ? bundle.curveFloats64
    : bundle.curveFloats;
}

/// A bundle-shaped object with everything the CPatch build reads and no GPU: what a bake
/// producer builds from importSvg's sections without a WebGL context.
export function headlessCPatchBundle(sections) {
  const parsed = parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  return {
    curveFloats: new Float32Array(sections.curves),
    curveFloats64: sections.curves64 ? new Float64Array(sections.curves64) : null,
    curveRangesByShape: (sections.curveRangesByShape || []).map((r) => ({
      begin: r.begin | 0,
      end: r.end | 0,
    })),
    metaFloats: parsed.metaFloats,
    metaFloatsPerShape: parsed.floatsPerShape,
    numShapes: parsed.numShapes,
    curveTex: true, // buildCPatchBundle's guard; nothing here uploads
  };
}

// Record legacy decomposition traces. Prepared whole-paint packing does not
// replay this representation.
export function bakeCPatchBundle(bundle, opts = {}) {
  const traceOut = new Map();
  const ranges = bundle.curveRangesByShape || [];
  const cf = cpatchCurvePlane(bundle);
  let shapes = 0,
    skipped = 0;
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      contours = null;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) {
      skipped++;
      continue;
    } // a primitive draws itself
    const cs = contoursToConverter(contours, null);
    if (!cs) continue;
    const evenOdd = shapeEvenOdd(bundle, s);
    try {
      packCPatchShape(cs, 0, {
        ...opts,
        evenOdd,
        traceOut,
        pool: false,
        search: opts.search || 'full',
      });
      shapes++;
    } catch {
      /* the build will bail the same way */
    }
  }
  const bytes = encodeTraceBake(traceOut);
  return Object.assign(bytes, { entries: traceOut.size, shapes, skipped });
}

export function buildCPatchBundle(gl, bundle, opts = {}) {
  if (!bundle || !bundle.curveFloats || !bundle.curveTex) return false;
  const ranges = bundle.curveRangesByShape;
  if (!ranges || !ranges.length) return false;

  const cf = cpatchCurvePlane(bundle); // float64 where the importer kept it; see there
  // Append after the original plane, aligned to CP_BLOCK_TEXELS. Mesh
  // (first,count) addresses coefficient blocks, not individual texels.
  const baseTexel0 = Math.ceil(Math.ceil(cf.length / 4) / CP_BLOCK_TEXELS) * CP_BLOCK_TEXELS;
  const baseBlock0 = baseTexel0 / CP_BLOCK_TEXELS;
  const meshes = new Array(ranges.length).fill(null);
  const skip = opts.skip || null;
  const autoPolicy = opts.autoPolicy === true;
  const chunks = [];
  let blockCursor = baseBlock0;
  let built = 0,
    drops = 0,
    unres = 0,
    cellN = 0,
    seamN = 0;

  // Pool only real worker conversions. Traces replay locally; trace recording
  // also stays local. A per-bundle bake takes precedence over renderer traces.
  const traces = bundle._cpatchTraces || opts.traces || null;
  if (autoPolicy) bundle._cpatchAutoTriedGen = bundle._geomGen | 0;
  const pooling =
    !autoPolicy &&
    opts.pool !== false &&
    typeof Promise !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    !traces &&
    !opts.traceOut;
  const collecting = pooling && bundle._cpatchConv === undefined;
  // Pool entries must share conversion settings. Shapes with holes convert
  // locally. Leave tolPx unset unless supplied so its default scales with extent.
  const cOpts = {
    maxCurves: opts.maxCurves || 8,
    interiorN: opts.interiorN,
    holes: null,
    search: opts.search || 'full',
  };
  if (opts.tolPx != null) cOpts.tolPx = opts.tolPx;
  if (pooling && bundle._cpatchConv === 'pending') return false;
  bundle._cpatchRetry = false; // consumed: past the pending gate, this IS the retry
  bundle._cpatchRules = []; // this pass's rules, not a running tally across retries
  // A SERIAL BUILD still KEEPS ONE CONVERSION PER KEY, as the pooled one does (see packCPatchShape).
  const convCache = bundle._cpatchConv instanceof Map ? bundle._cpatchConv : new Map();
  // The graph front end's answer per shape, shared by the collect pass and the build pass.
  const cycleCache = bundle._cpatchCycles || (bundle._cpatchCycles = new Map());

  if (collecting) {
    // Yield between collect slices to receive worker replies and draw fallback.
    // A zero collectSlice disables yielding.
    const SLICE_MS =
      mantleDebugHook('__CP_COLLECT_SLICE') != null
        ? +mantleDebugHook('__CP_COLLECT_SLICE')
        : opts.collectSlice != null
          ? +opts.collectSlice
          : 6;
    const posts = [];
    bundle._cpatchConv = 'pending';
    // THE WATCH (see CPATCH_STALL_REPORT_MS). One per pass, keyed on the bundle, so a pass that a new
    // bake superseded does not report on the bundle's behalf.
    const watch = { t0: performance.now(), timer: null, stalled: false };
    bundle._cpatchConvWatch = watch;
    const stallMs = opts.stallReportMs != null ? +opts.stallReportMs : CPATCH_STALL_REPORT_MS;
    if (stallMs > 0) {
      watch.timer = setTimeout(() => {
        watch.timer = null;
        if (
          bundle._cpatchConvWatch === watch &&
          bundle._cpatchConv === 'pending' &&
          !bundle._disposed
        ) {
          reportStall(bundle, watch, 'no answer');
        }
      }, stallMs);
      // A report must not be what keeps a node process (a bake, a test) alive.
      if (watch.timer && typeof watch.timer.unref === 'function') watch.timer.unref();
    }
    const state = { s: 0 };
    const current = () =>
      !bundle._disposed && bundle._cpatchConvWatch === watch && bundle._cpatchConv === 'pending';
    const slice = () => {
      if (!current()) {
        settleWatch(bundle, watch);
        return;
      }
      const t0 = performance.now();
      // Report exceptions from both the initial slice and later queued tasks;
      // otherwise a failed collect pass could remain pending indefinitely.
      try {
        for (; state.s < ranges.length; state.s++) {
          if (SLICE_MS > 0 && performance.now() - t0 > SLICE_MS) {
            laterTask(slice);
            return;
          }
          const s = state.s,
            r = ranges[s];
          if (!r) continue;
          let contours = null;
          try {
            contours = curveRangeToContours(cf, r.begin, r.end);
          } catch {
            contours = null;
          }
          if (!contours || !contours.length) continue;
          // A recognized primitive is its own engine (the build pass below packs it); it converts nothing.
          if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
          if (skip && skip[s]) continue;
          if (autoPolicy && bundle.fillNormByShape && bundle.fillNormByShape[s] < 0) continue;
          const cs = contoursToConverter(contours, bundle);
          if (!cs) continue;
          const evenOdd = shapeEvenOdd(bundle, s);
          const collected = [];
          try {
            packCPatchShape(cs, 0, { ...opts, evenOdd, collect: collected, cycleCache });
          } catch {
            /* a shape
          that cannot even be walked converts nothing; the build pass will report it */
          }
          // DISPATCH this SHAPE'S CYCLES now, not after the whole pass. Contours carrying holes
          // still convert on the build pass, as before.
          const fresh = collected.filter((e) => !e.holes);
          if (fresh.length)
            posts.push(
              convertContoursPooled(
                fresh.map((e) => e.curves),
                cOpts,
              ).then((res) => ({ entries: fresh, res })),
            );
        }
      } catch (ex) {
        reportStall(
          bundle,
          watch,
          'collect pass threw at shape ' + state.s + ': ' + ((ex && ex.message) || ex),
          ex,
        );
        return;
      }
      bundle._cpatchCollectEnd = performance.now(); // diagnostic: when the pass finished
      if (posts.length === 0) {
        settleWatch(bundle, watch);
        bundle._cpatchConv = new Map();
        bundle._cpatchConvN = 0;
        return;
      }
      // Every shape's cycles are posted; gather every post's answer into the conversion map.
      Promise.all(posts)
        .then((parts) => {
          settleWatch(bundle, watch);
          if (!current()) return;
          const map = new Map();
          for (const part of parts) {
            const { entries, res } = part;
            for (let i = 0; i < entries.length; i++) {
              const r = res && res[i];
              // Keep the first conversion per key, keyed by the pool's settings.
              const k = cpatchConvKey(entries[i].curves, null, cpatchConvSettings(cOpts));
              if (r && r.patches && !map.has(k)) map.set(k, r.patches);
            }
          }
          bundle._cpatchConv = map;
          bundle._cpatchConvN = map.size;
          bundle._cpatchRetry = true; // re-open the gate the LB fallback closed
        })
        .catch(() => {
          settleWatch(bundle, watch);
          if (!current()) return;
          bundle._cpatchConv = new Map(); // every cycle misses and converts inline, as before
          bundle._cpatchRetry = true;
        });
    };
    slice();
    if (bundle._cpatchConv === 'pending') return false;
  }

  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      contours = null;
    }
    if (!contours || !contours.length) continue;
    // Recognize exact primitives before CPatch conversion. Their independent
    // kind flags select the SDF kernel in the shared analytic vertex stream.
    {
      const prim = circleFromContours(contours) || ellipseFromContours(contours);
      if (prim) {
        let pm = null;
        try {
          pm = packLoopBlinnMesh({
            interior: new Float32Array(0),
            interiorEdges: null,
            quads: [],
            cubics: [],
            edges: [],
            fallback: [],
            circles: [prim],
            _topo: null,
          });
        } catch {
          pm = null;
        }
        if (pm && (pm.vertexCount | 0) > 0) {
          meshes[s] = {
            verts: pm.verts,
            vertexCount: pm.vertexCount,
            fallback: false,
            cpatch: false,
            slug: false,
            prim: true,
            kindMask: pm.kindMask,
            hasCubicChain: !!pm.hasCubicChain,
          };
          built++;
          continue;
        }
      }
    }
    // TEST HOOK, read only under __MANTLE_DEBUG__: decline every non-primitive shape, so a smoke can drive the whole-bundle
    // decline path (nothing built -> the cover-quad kernel, never Loop-Blinn), which real assets do not reach.
    if (mantleDebugHook('__CP_TEST_DECLINE_ALL') === true) {
      bundle._cpatchBail = 'test: __CP_TEST_DECLINE_ALL';
      continue;
    }
    if (skip && skip[s]) continue;
    if (autoPolicy && bundle.fillNormByShape && bundle.fillNormByShape[s] < 0) continue;
    const cs = contoursToConverter(contours, bundle);
    if (!cs) continue;
    const evenOdd = shapeEvenOdd(bundle, s);
    bundle._cpatchRules = bundle._cpatchRules || [];
    bundle._cpatchRules.push((evenOdd ? 'eo' : 'nz') + ':' + cs.length);
    let m = null;
    try {
      m = packCPatchShape(cs, blockCursor, { ...opts, evenOdd, convCache, traces, cycleCache });
    } catch (e) {
      m = null;
      bundle._cpatchBail = 'pack threw: ' + ((e && e.message) || e);
    }
    if (!m) {
      if (!bundle._cpatchBail) {
        const d = cs.map((c) => c.length + '[' + c.map((x) => x.t).join('') + ']').join(' ');
        const p0 = cs[0] && cs[0][0] ? JSON.stringify(cs[0][0].P) : '?';
        bundle._cpatchBail =
          'pack null · contours ' +
          cs.length +
          ' · ' +
          d.slice(0, 120) +
          ' · p0=' +
          p0.slice(0, 60);
      }
      continue;
    }
    if (autoPolicy && ((m.dropped | 0) > 0 || (m.unresolved | 0) > 0)) continue;
    meshes[s] = {
      _cpAdmission: m._cpAdmission,
      verts: m.verts,
      vertexCount: m.vertexCount,
      fallback: false,
      // Retain the mesh kind and certificate for routing and engine attribution.
      cpatch: true,
      cpatchAreaOnly: !!m.cpatchAreaOnly,
      areaCurves: m.areaCurves | 0,
      slug: false,
      kindMask: m.kindMask,
      hasQuadraticArea: m.hasQuadraticArea,
      hasCubicArea: m.hasCubicArea,
      dropped: m.dropped | 0,
      unresolved: m.unresolved | 0,
      cells: m.cells | 0,
      // CPatch has no LB chain faces. comp records companion seams.
      hasCubicChain: false,
      comp: (m.comp | 0) > 0,
    };
    chunks.push(m.texels);
    // Retain dropped/unresolved counts for diagnostics and auto admission.
    drops += m.dropped | 0;
    unres += m.unresolved | 0;
    cellN += m.cells | 0;
    seamN += m.allSeam | 0;
    blockCursor += m.texels.length / (CP_BLOCK_TEXELS * 4); // one curve block
    built++;
  }
  if (!built) {
    if (opts._preparedStaticProgram) {
      bundle._cpPreparedTerminalAutoPolicy = autoPolicy;
      bundle._cpPreparedTerminalGen = bundle._geomGen | 0;
      bundle._cpPreparedTerminalKey = opts._preparedStaticKey;
      bundle._cpPreparedRefusal = 'no-certified-static-paints';
    }
    return false;
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const need = baseTexel0 * 4 + total;
  const rows = Math.max(1, Math.ceil(need / (4 * TEX_W)));
  // Reject oversized coefficient planes before allocation, preserving the
  // original curve plane and selected raw fallback.
  if (!planeFits(gl, TEX_W, rows)) {
    if (bundle._cpatchOverflowGen !== (bundle._geomGen | 0)) {
      bundle._cpatchOverflowGen = bundle._geomGen | 0;
      mantleWarn(
        `CPatch: the curve plane with its coefficient blocks needs a ${TEX_W} x ${rows} texture but this device's MAX_TEXTURE_SIZE is ${maxTextureSize(gl)}; ` +
          'this bundle stays on the cover/Slug route. Split the art into several bundles to use CPatch.',
      );
    }
    return false;
  }
  // The scene memory budget: the grown curve plane is optional (the cover route draws without it). Refused, the bundle keeps its plane.
  {
    const L = peekLedger(gl);
    const planeGrowth = L ? Math.max(0, rows * TEX_W * 16 - L.bytesOf(bundle.curveTex)) : 0;
    if (L && L.budget() < Infinity && opts.admitStaticStream) {
      if (!opts.admitStaticStream(bundle, meshes, planeGrowth)) return false;
    } else if (L && !L.admit(planeGrowth, 'CPatch plane')) return false;
  }
  const plane = new Float32Array(rows * 4 * TEX_W);
  notePreparationBytes(plane.byteLength); // the packed plane lives until its upload below
  // Decode geometry at authored precision, but upload the live float32 payload.
  // Occupancy workers patch this prefix without changing the authored plane.
  plane.set(bundle.curveFloats.subarray(0, Math.min(bundle.curveFloats.length, plane.length)));
  let o = baseTexel0 * 4;
  for (const c of chunks) {
    plane.set(c, o);
    o += c.length;
  }

  gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, plane);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
    gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  preparationCheckpoint();
  notePreparationBytes(-plane.byteLength);
  // Diagnostic handle: the exact plane CPatch uploaded, so a probe can ask whether what is on the GPU
  // at draw time is still this.
  if (mantleDebugHook('__CP_KEEP_PLANE') === true) {
    bundle._cpatchPlane = plane;
    bundle._cpatchRows = rows;
    bundle._cpatchTexW = TEX_W;
  }

  if (!claimFillMeshes(bundle, MESH_OWNER.CPATCH, meshes)) return false;
  if (opts._preparedStaticProgram) {
    bundle._cpPreparedHasCandidate = meshes.some((mesh) => !!mesh?._cpAdmission);
    bundle._lbBuildGated = false;
    bundle._cpPreparedTerminalGen = undefined;
    bundle._cpPreparedTerminalKey = undefined;
    bundle._cpPreparedTerminalAutoPolicy = undefined;
    bundle._cpPreparedRefusal = null;
  }
  bundle._lbMeshesRaw = null;
  bundle._lbGen = bundle._geomGen | 0;
  bundle._lbHasSlug = meshes.some((m) => !m);
  // Invalidate both the kind mask and its generation so variant selection
  // includes the newly published CPatch kernel.
  bundle._lbKindMask = undefined;
  bundle._lbKindMaskGen = -1; // recompute: the mask carries 1<<14 from here on
  bundle._cpatchBuilt = built;
  bundle._cpatchAutoBuilt = autoPolicy;
  bundle._cpatchDropped = drops;
  bundle._cpatchUnresolved = unres;
  bundle._cpatchCells = cellN;
  // All-seam patches have hard coverage. Count them separately because their
  // outer edges cannot produce an antialiasing ramp.
  bundle._cpatchAllSeam = seamN;

  // Route changes can rebuild this mesh without a worker conversion cache.
  // Keep the authored precision so a rebuild uses the same decomposition.
  return true;
}
