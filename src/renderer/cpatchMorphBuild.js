// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { nativePairIsExact } from '../core/polynomialMorph.js';
import { arcPairNeedsCpuLerp } from './arcMorphGate.js';
import { packSimplePolynomialPaint } from './cpatchSimpleArea.js';
import { deleteGlResource } from './contextResources.js';
import { planeFits, maxTextureSize } from './tableLayout.js';
import { mantleWarn } from '../core/diagnostics.js';
import { ledgerFor } from './memoryLedger.js';
// CPatch morph preparation certifies a native boundary or an interval decomposition.
// Frames reuse that layout and update its coefficients on the CPU or GPU.
// Multi-contour shapes retain their previous route because their bridges do
// not have a shared pose correspondence.
import { claimFillMeshes, MESH_OWNER } from './fillMeshOwner.js';

import { layoutAt, applyLayout, splitForMorph } from './cpatchMorphCert.js';
import { planMorphsPooled } from './cpatchWorkerPool.js';
import {
  packCPatchMorphFrame,
  planCPatchMorphSegment,
  packCPatchMorphPlanes,
  CP_BLOCK_TEXELS,
  CP_MORPH_C_FLOATS,
} from './cpatchPack.js';
const CP_BLOCK_FLOATS = CP_BLOCK_TEXELS * 4;
import {
  buildCPatchBlend,
  runCPatchBlend,
  updateCPatchBlend,
  disposeCPatchBlend,
  cpatchBlendAllocationBytes,
} from './cpatchMorphBlend.js';
import { noteExternalGlWrite } from '../core/glEpoch.js';
import { convertContour, framePatch } from './cpatchConvert.js';
import { curveRangeToContours } from '../geom/lbContour.js';
import { isStrokeRow } from './engineLedger.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { SLUG_WHY } from './lbBuildCore.js';

// Convert both poses together. Drop a segment only when both corresponding
// segments are degenerate; unilateral drops would change their pairing.
// Closed cubics with distinct controls retain their enclosed geometry.
const _same = (u, v, e) => u && v && Math.abs(u[0] - v[0]) < e && Math.abs(u[1] - v[1]) < e;
function _degenerate(t, P, e) {
  const a = P[0],
    b = P[P.length - 1];
  if (t === 'line' || t === 'quad' || t === 'rquad') return _same(a, b, e);
  if (t === 'cubic') return _same(a, b, e) && _same(a, P[1], e) && _same(a, P[2], e);
  return false;
}
// Use one float32 ulp of the combined endpoint extent for joint degeneracy.
function _pairEps(contourA, contourB) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const cs of [contourA, contourB])
    for (const sg of cs)
      for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!p) continue;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
  const ext = Math.max(x1 - x0, y1 - y0);
  return (ext > 0 && Number.isFinite(ext) ? ext : 1) * 2 ** -24;
}
function _decode(sg) {
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
  if (!t) return null;
  const P = [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean);
  if (P.length < 2) return null;
  return { t, P, w: sg.w };
}
// Expose the pairing decision for CPU correspondence tests.
export const _toCurvesPair = (a, b) => toCurvesPair(a, b);
function toCurvesPair(contourA, contourB) {
  if (!contourA || !contourB || contourA.length !== contourB.length) return null;
  const eps = _pairEps(contourA, contourB);
  const A = [],
    B = [];
  for (let i = 0; i < contourA.length; i++) {
    const da = _decode(contourA[i]),
      db = _decode(contourB[i]);
    if (!da || !db) return null;
    // Preserve type-converted segments to retain endpoint correspondence.
    const drop = da.t === db.t && _degenerate(da.t, da.P, eps) && _degenerate(db.t, db.P, eps);
    if (drop) continue; // both poses agree it is nothing
    A.push(da.t === 'rquad' ? { t: da.t, P: da.P, w: da.w } : { t: da.t, P: da.P });
    B.push(db.t === 'rquad' ? { t: db.t, P: db.P, w: db.w } : { t: db.t, P: db.P });
  }
  return A.length >= 2 ? { A, B } : null;
}

const lerpPose = (A, B, t) =>
  A.map((c, i) => ({
    t: c.t,
    cut: c.cut,
    w: c.w,
    _bez: c._bez,
    P: c.P.map((q, k) => [q[0] + (B[i].P[k][0] - q[0]) * t, q[1] + (B[i].P[k][1] - q[1]) * t]),
  }));

// Collect single-contour endpoint pairs. Multi-contour bridges require
// shared provenance and are not planned here. rowWhy records why each
// shape with curves was left off the plan.
function morphPairs(bundle, rowWhy = {}) {
  const ms = bundle._morphSrc;
  const out = [];
  const arcPlanes = { A: ms.srcEpCurveF32, B: ms.dstEpCurveF32, offsets: ms.arcOffsets };
  for (let s = 0; s < ms.curveRanges.length; s++) {
    const r = ms.curveRanges[s];
    if (!r) continue;
    // A control-point lerp cannot draw this arc's interpolation, so the shape stays off the plan and on the exact lerp (arcMorphGate.js).
    if (
      ms.arcOffsets &&
      ms.arcOffsets.some(
        (o) =>
          o >= r.begin &&
          o < r.end &&
          arcPairNeedsCpuLerp(ms.mergedCurveF32, ms.dstCurveF32, o, ms.arcRotationShortest),
      )
    ) {
      rowWhy[s] = 'an arc a control-point lerp cannot draw';
      continue;
    }
    let ca = null,
      cb = null;
    try {
      // A zero-radius arc decodes as its chord only where both poses' is one (one topology).
      ca = curveRangeToContours(ms.mergedCurveF32, r.begin, r.end, ms.dstCurveF32);
      cb = curveRangeToContours(ms.dstCurveF32, r.begin, r.end, ms.mergedCurveF32);
    } catch {
      rowWhy[s] = 'contours failed to decode';
      continue;
    }
    if (!ca || !cb || ca.length !== 1 || cb.length !== 1) {
      rowWhy[s] = 'contours ' + (ca ? ca.length : 0) + ':' + (cb ? cb.length : 0) + ', not one';
      continue;
    }
    const pair = toCurvesPair(ca[0], cb[0]);
    if (!pair) {
      rowWhy[s] = 'segments do not pair';
      continue;
    } // lengths cannot diverge: dropped in lockstep
    out.push({
      key: s,
      A: pair.A,
      B: pair.B,
      nativeExact: nativePairIsExact(ms.mergedCurveF32, ms.dstCurveF32, r, pair, arcPlanes),
    });
  }
  return out;
}

// Request one asynchronous plan per bundle. While pending or declined,
// the renderer retains its previous route. Plan states are undefined
// (unrequested), 'pending', null (declined), or the completed object.
function requestPlan(bundle, opts) {
  const rowWhy = {};
  const pairs = morphPairs(bundle, rowWhy);
  bundle._cpatchMorphRowWhy = rowWhy;
  if (!pairs.length) {
    const ms = bundle._morphSrc,
      arcs = ms.arcOffsets;
    bundle._cpatchMorphPlan = null;
    bundle._cpatchBail =
      arcs &&
      arcs.length &&
      Array.from(arcs).some((o) =>
        arcPairNeedsCpuLerp(ms.mergedCurveF32, ms.dstCurveF32, o, ms.arcRotationShortest),
      )
        ? 'morph: an arc a control-point lerp cannot draw'
        : 'morph: no single-contour shape';
    return;
  }
  bundle._cpatchMorphPlan = 'pending';
  const gen = (bundle._morphPlanGen = (bundle._morphPlanGen | 0) + 1);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // Omit an unspecified tolerance so the worker derives it per shape pair.
  planMorphsPooled(pairs, {
    ...(opts.tolPx != null ? { tolPx: opts.tolPx } : {}),
    maxCurves: opts.maxCurves || 8,
    ...(opts.nativeAreaOnly ? { nativeAreaOnly: true } : {}),
    ...(opts.maxPlanMs != null ? { maxPlanMs: opts.maxPlanMs } : {}),
  })
    .then((res) => {
      // A bundle that was disposed, or re-planned since, must not have a stale plan applied.
      if (bundle._disposed || (bundle._morphPlanGen | 0) !== gen) return;
      const shapes = [];
      let planned = 0;
      const why = [];
      for (let k = 0; k < pairs.length; k++) {
        const r = res[k];
        if (!r || !r.plan) {
          why.push(pairs[k].key + ':' + ((r && r.err) || 'no plan'));
          rowWhy[pairs[k].key] = 'plan: ' + ((r && r.err) || 'no plan');
          continue;
        }
        shapes[pairs[k].key] = {
          A: r.A,
          B: r.B,
          plan: r.plan,
          seg: -1,
          pack: null,
          first: 0,
          plan2: null,
          planBase: -1,
        };
        planned++;
      }
      if (!planned) {
        bundle._cpatchMorphPlan = null;
        bundle._cpatchBail = 'morph: ' + (why.join(' | ') || 'no shapes');
        return;
      }
      // Record only an explicitly pinned tolerance; the worker owns derived tolerances.
      bundle._cpatchMorphPlan = { shapes, planned, tolPx: opts.tolPx != null ? opts.tolPx : null };
      bundle._cpatchPlanMs = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
      );
      // The next frame has to rebuild rather than take the "already posed" early-out.
      bundle._cpatchMorphT = undefined;
    })
    .catch(() => {
      bundle._cpatchMorphPlan = null;
      bundle._cpatchBail = 'morph: plan rejected';
    });
}

// Use a float32 origin fixed over the segment to condition coefficients.
// Every intermediate control lies in the combined endpoint control box.
export function morphKernelFrame(loops0, loops1) {
  let x0 = Infinity,
    y0 = Infinity;
  for (const ls of [loops0, loops1])
    for (const l of ls)
      for (const c of l)
        for (const q of c.P) {
          if (q[0] < x0) x0 = q[0];
          if (q[1] < y0) y0 = q[1];
        }
  return Number.isFinite(x0) && Number.isFinite(y0) ? [Math.fround(x0), Math.fround(y0)] : [0, 0];
}
// Translate control points without copying symbol-keyed geometry memos.
// Translation preserves the frozen chord-length conditioning.
export function moveLoops(loops, O) {
  if (O[0] === 0 && O[1] === 0) return loops;
  const mv = (P) => P.map((q) => [q[0] - O[0], q[1] - O[1]]);
  return loops.map((l) =>
    l.map((c) => {
      const o = {};
      for (const k of Object.keys(c)) o[k] = c[k];
      o.P = mv(c.P);
      if (c._srcP) o._srcP = mv(c._srcP);
      return o;
    }),
  );
}
// Return shapes requiring new buffers; rewrite other packs in place.
// fresh retains separate sample arrays; segT fixes the layout at shared endpoints.
export function setCPatchMorphT(morph, t, baseBlock = 0, opts = {}, fresh = false, segT = null) {
  if (!morph) return null;
  const restructured = [];
  let why = null;
  let block = baseBlock;
  for (let s = 0; s < morph.shapes.length; s++) {
    const sh = morph.shapes[s];
    if (!sh) continue;
    const selT = segT == null ? t : segT;
    const whole = sh.plan.length === 1 && sh.plan[0].nativeArea;
    if (whole) {
      const changed = sh.seg !== 0 || sh.planBase !== block;
      const pk =
        fresh || changed || !sh.pack
          ? packSimplePolynomialPaint({ curves: lerpPose(sh.A, sh.B, t) }, block, {
              areaFrame: whole.frame,
              areaBounds: whole.bounds,
            })
          : sh.pack;
      pk.curveBlocks = sh.A.length;
      if (pk === sh.pack)
        for (let i = 0; i < sh.A.length; i++)
          for (let k = 0; k < sh.A[i].P.length; k++)
            for (let axis = 0; axis < 2; axis++) {
              const a = sh.A[i].P[k][axis],
                b = sh.B[i].P[k][axis];
              pk.texels[i * 28 + 20 + 2 * k + axis] = a + (b - a) * t - whole.frame[axis];
            }
      if (changed) restructured.push(s);
      sh.seg = 0;
      sh.planBase = block;
      sh.pack = pk;
      sh.first = block;
      block += pk.curveBlocks;
      continue;
    }
    const layout = layoutAt(sh.plan, selT);
    const foundIdx = sh.plan.findIndex((p) => selT >= p.t0 - 1e-9 && selT <= p.t1 + 1e-9);
    const segIdx = foundIdx >= 0 ? foundIdx : sh.plan.length - 1;
    const loopsW = applyLayout(layout, lerpPose(sh.A, sh.B, t));
    if (!loopsW) {
      sh.pack = null;
      why = 'applyLayout null s=' + s + ' t=' + t.toFixed(4);
      continue;
    }
    // Keep layout slots and the kernel frame fixed within each plan segment.
    if (segIdx !== sh.seg || !sh.plan2 || sh.planBase !== block) {
      const segp = sh.plan[segIdx];
      const loops0 = applyLayout(layout, lerpPose(sh.A, sh.B, segp.t0));
      const loops1 = applyLayout(layout, lerpPose(sh.A, sh.B, segp.t1));
      const framesOf = (ls) => {
        if (!ls) return null;
        const out = [];
        for (const l of ls) {
          const f = framePatch(l);
          if (!f) return null;
          out.push(f);
        }
        return out;
      };
      const O = loops0 && loops1 ? morphKernelFrame(loops0, loops1) : [0, 0];
      const fLo = loops0 && framesOf(moveLoops(loops0, O)),
        fHi = loops1 && framesOf(moveLoops(loops1, O));
      sh.plan2 = fLo && fHi ? planCPatchMorphSegment(fLo, fHi, block, { ...opts, frame: O }) : null;
      sh.planBase = block;
      restructured.push(s);
    }
    if (!sh.plan2) {
      sh.pack = null;
      why = 'seg plan null s=' + s;
      continue;
    }
    const loops = moveLoops(loopsW, sh.plan2.frame || [0, 0]);
    const patches = [];
    let ok = true;
    for (const l of loops) {
      const f = framePatch(l);
      if (!f) {
        ok = false;
        break;
      }
      patches.push(f);
    }
    if (!ok) {
      sh.pack = null;
      why = 'framePatch null s=' + s + ' t=' + t.toFixed(4);
      continue;
    }
    const pk = packCPatchMorphFrame(patches, sh.plan2, fresh ? null : sh.pack);
    if (!pk) {
      sh.pack = null;
      why = 'frame pack null s=' + s + ' t=' + t.toFixed(4);
      continue;
    }
    sh.seg = segIdx;
    sh.pack = pk;
    sh.first = block;
    block += pk.curveBlocks;
  }
  return { restructured, blocks: block - baseBlock, why };
}

// Intersect the per-shape plan intervals containing t. All shapes retain
// fixed cells and triangle lists throughout this common interval.
export function cpatchGlobalSegment(morph, t) {
  let t0 = 0,
    t1 = 1;
  for (const sh of morph.shapes) {
    if (!sh || !sh.plan || !sh.plan.length) continue;
    const p =
      sh.plan.find((q) => t >= q.t0 - 1e-9 && t <= q.t1 + 1e-9) || sh.plan[sh.plan.length - 1];
    if (p) {
      t0 = Math.max(t0, p.t0);
      t1 = Math.min(t1, p.t1);
    }
  }
  return { t0, t1: Math.max(t1, t0 + 1e-9) };
}

// Queue coefficient passes for one write-to-read transition before fills.
// Without a renderer, execute the pass immediately.
function cancelQueuedBlend(R, tgt) {
  const q = R && R._cpatchPending;
  if (!q || !tgt) return;
  for (let i = q.length - 1; i >= 0; i--) if (q[i].tgt === tgt) q.splice(i, 1);
}

function queueBlend(R, gl, tgt, u, defer) {
  if (!R || defer === false) {
    runBlendsRestoring(R, gl, [{ tgt, u }]);
    return;
  }
  if (!R._cpatchPending) R._cpatchPending = [];
  R._cpatchPending.push({ tgt, u });
}

// Flush queued coefficient passes once before the first fill.
export function flushCPatchBlends(R, gl) {
  const q = R && R._cpatchPending;
  if (!q || !q.length) return;
  const list = q.slice();
  q.length = 0;
  runBlendsRestoring(R, gl, list);
}

// Preserve the caller's framebuffer and tracked GL state. A flush may run
// inside a warmup scissor, filter target or group draw. State restoration
// uses renderer shadows without querying native GL.
function runBlendsRestoring(R, gl, list) {
  const snap = R && R.glPeek ? R.glPeek() : null;
  const fbo = R && R._boundDrawFbo !== undefined ? R._boundDrawFbo : null;
  for (const e of list) runCPatchBlend(gl, e.tgt, e.u);
  if (!R) return;
  if (R.bindFb) R.bindFb(gl.FRAMEBUFFER, fbo);
  else gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  if (snap && R.glRestore) R.glRestore(snap);
}

const TEX_W = 4096;

// Prepare or update CPatch meshes for the current morph pose.
// Return false while preparation is pending or unavailable.
const nativeMorphViews = new WeakMap();
function nativeMorphView(plan) {
  if (nativeMorphViews.has(plan)) return nativeMorphViews.get(plan);
  const shapes = plan.shapes.map((shape) =>
    shape && shape.plan.length === 1 && shape.plan[0].nativeArea ? shape : null,
  );
  const planned = shapes.filter(Boolean).length;
  const view = planned ? { ...plan, shapes, planned } : null;
  nativeMorphViews.set(plan, view);
  return view;
}

export function applyCPatchMorphFrame(gl, bundle, opts = {}, R = null) {
  if (bundle) bundle._cpatchMorphWhy = null;
  // Record wrapper identity and plan state for the optional trace hook.
  if (globalThis.__CPATCH_TRACE && globalThis.__CPATCH_TRACE.length < 500)
    globalThis.__CPATCH_TRACE.push({
      tag: (bundle && bundle.__tag) || '?',
      plan: !bundle
        ? 'nobundle'
        : bundle._cpatchMorphPlan === undefined
          ? 'undefined'
          : bundle._cpatchMorphPlan === 'pending'
            ? 'pending'
            : bundle._cpatchMorphPlan
              ? 'ready'
              : 'null',
      morphSrc: !!(bundle && bundle._morphSrc),
    });
  const ms = bundle && bundle._morphSrc;
  if (!ms || !bundle.curveTex) {
    if (bundle) bundle._cpatchMorphWhy = !ms ? 'no _morphSrc' : 'no curveTex';
    return false;
  }
  // Request preparation once and retain the previous route until it completes.
  if (bundle._cpatchMorphPlan === undefined) requestPlan(bundle, opts);
  let morph = bundle._cpatchMorphPlan;
  if (!morph || morph === 'pending') {
    bundle._cpatchMorphWhy = morph === 'pending' ? 'plan pending' : 'no plan';
    return false;
  }
  if (opts.nativeAreaOnly) {
    morph = nativeMorphView(morph);
    if (!morph) {
      bundle._cpatchMorphWhy = 'no certified native whole-interval paint';
      return false;
    }
  }

  const cf = bundle.curveFloats;
  const lerpedFloats = Math.max(
    cf ? cf.length : 0,
    ms.mergedCurveF32 ? ms.mergedCurveF32.length : 0,
  );
  const rowFloats = 4 * TEX_W;

  const alignFloats = rowFloats * CP_BLOCK_TEXELS;
  const baseFloat = Math.ceil(lerpedFloats / alignFloats) * alignFloats;
  const baseBlock = baseFloat / CP_BLOCK_FLOATS;

  // Three static packs reconstruct degree-two coefficients within a certified
  // interval. The CPU pack remains the fallback when blending is unavailable
  // or the interval fails the additional coefficient checks below.
  const tNow = ms.t || 0;
  const useBlend = opts.gpuBlend !== false;
  const gseg = useBlend ? cpatchGlobalSegment(morph, tNow) : null;
  const blendKey = gseg ? gseg.t0.toFixed(9) + ':' + gseg.t1.toFixed(9) + ':' + baseBlock : null;
  const uOf = () => {
    const sp = gseg.t1 - gseg.t0;
    return sp > 0 ? (tNow - gseg.t0) / sp : 0;
  };
  // Remember failed blend keys to avoid repacking three samples every frame.
  const fast = !!(
    useBlend &&
    bundle._cpatchBlend &&
    bundle._cpatchBlendKey === blendKey &&
    bundle._cpatchMeshRef
  );
  let meshes = null,
    built = 0,
    moved = false,
    planeGrew = false,
    blendRetired = false;

  if (fast) {
    // Reuse coefficients when the pose is unchanged unless a blend is forced.
    if (bundle._cpatchMorphT !== tNow || opts.forceBlend)
      queueBlend(R, gl, bundle._cpatchBlend, uOf(), opts.deferBlends);
    meshes = bundle._cpatchMeshRef;
    for (const m of meshes) if (m) built++;
  } else {
    let r = null,
      blendSnaps = null;
    if (useBlend && bundle._cpatchBlendDead !== blendKey) {
      // Pack three coexisting poses using the same segment layout.
      const span = gseg.t1 - gseg.t0;
      const ats = [gseg.t0, gseg.t0 + span * 0.5, gseg.t1];
      // Check quarter poses against quadratic interpolation. Sign or frame
      // changes that violate the check require CPU packing for this segment.
      const checks = [0.25, 0.75].map((u) => {
        const t = gseg.t0 + span * u;
        const rk = setCPatchMorphT(morph, t, baseBlock, opts, true, ats[1]);
        return rk
          ? {
              u,
              packs: morph.shapes.map((sh) =>
                sh && sh.pack ? { first: sh.first, texels: sh.pack.texels } : null,
              ),
            }
          : null;
      });
      const snaps = [];
      for (let k = 0; k < 3; k++) {
        const rk = setCPatchMorphT(morph, ats[k], baseBlock, opts, true, ats[1]);
        if (!rk) break;
        if (k === 0) r = rk;
        snaps.push(
          morph.shapes.map((sh) => (sh && sh.pack ? { first: sh.first, pack: sh.pack } : null)),
        );
      }
      if (snaps.length === 3 && checks.every(Boolean)) {
        let off = 0;
        for (const c of checks) {
          const l0 = 2 * (c.u - 0.5) * (c.u - 1),
            l1 = -4 * c.u * (c.u - 1),
            l2 = 2 * c.u * (c.u - 0.5);
          for (let k = 0; k < c.packs.length && !off; k++) {
            const d = c.packs[k],
              a = snaps[0][k],
              b = snaps[1][k],
              e = snaps[2][k];
            if (!d || !a || !b || !e) continue;
            const x = d.texels,
              A = a.pack.texels,
              B = b.pack.texels,
              E = e.pack.texels;
            const n = Math.min(x.length, A.length, B.length, E.length);
            for (let i = 0; i < n; i++) {
              if (!Number.isFinite(x[i])) continue;
              const want = l0 * A[i] + l1 * B[i] + l2 * E[i];
              if (Math.abs(want - x[i]) > 1e-3 * Math.max(1, Math.abs(x[i]))) {
                off++;
                break;
              }
            }
          }
        }
        if (off) {
          bundle._cpatchBlendDead = blendKey;
          bundle._cpatchBail = 'blend premise (degree 2 in t) fails on this segment: CPU pack';
          r = null;
          blendRetired = true;
        } else blendSnaps = snaps;
      } else {
        r = null;
        bundle._cpatchBail = 'blend pack failed';
      }
    }
    if (!r) r = setCPatchMorphT(morph, tNow, baseBlock, opts);
    if (!r) {
      bundle._cpatchMorphWhy = bundle._cpatchBail || 'setCPatchMorphT returned null';
      return false;
    }
    if (r.why) bundle._cpatchBail = r.why;

    meshes = new Array(Math.max(bundle.numShapes | 0, morph.shapes.length)).fill(null);
    const chunks = [];
    let total = 0;
    for (let s = 0; s < morph.shapes.length; s++) {
      const sh = morph.shapes[s];
      if (!sh || !sh.pack) continue;
      meshes[s] = {
        verts: sh.pack.verts,
        vertexCount: sh.pack.vertexCount,
        cpatch: true,
        fallback: false,
        slug: false,
        kindMask: sh.pack.kindMask,
        cpatchAreaOnly: !!sh.pack.cpatchAreaOnly,
        hasQuadraticArea: !!sh.pack.hasQuadraticArea,
        hasCubicArea: !!sh.pack.hasCubicArea,
        hasCubicChain: false,
      }; // no LB chain face (fillPass)
      chunks.push({ at: (sh.first - baseBlock) * CP_BLOCK_FLOATS, data: sh.pack.texels });
      total = Math.max(total, (sh.first - baseBlock) * CP_BLOCK_FLOATS + sh.pack.texels.length);
      built++;
    }
    if (!built) {
      bundle._cpatchMorphWhy = 'no shape produced a mesh';
      return false;
    }

    const rows = Math.max(1, Math.ceil((baseFloat + total) / rowFloats));
    // A plane taller than the device's MAX_TEXTURE_SIZE cannot be uploaded: decline before allocating.
    if (!planeFits(gl, TEX_W, rows)) {
      bundle._cpatchMorphWhy = `the CPatch morph plane needs a ${TEX_W} x ${rows} texture; MAX_TEXTURE_SIZE is ${maxTextureSize(gl)}`;
      if (bundle._cpatchOverflowGen !== (bundle._geomGen | 0)) {
        bundle._cpatchOverflowGen = bundle._geomGen | 0;
        mantleWarn(
          `CPatch morph: ${bundle._cpatchMorphWhy}; this bundle morphs on the cover/Slug route. Split the art into several bundles.`,
        );
      }
      return false;
    }
    // Admit the complete optional route before resizing the live curve texture.
    // Existing allocations are credited because coefficient targets are reused
    // or retired before their replacements are created.
    const y0 = baseFloat / rowFloats,
      h = rows - y0;
    const nTexels = Math.ceil(total / 4);
    const bw = nTexels <= TEX_W ? Math.max(1, nTexels) : TEX_W;
    const bh = nTexels <= TEX_W ? 1 : Math.min(h, Math.ceil(nTexels / TEX_W));
    const nBlocks = Math.ceil(total / CP_BLOCK_FLOATS);
    const nC = nBlocks * (CP_MORPH_C_FLOATS / 4);
    const cw = Math.max(1, Math.min(TEX_W, nC)),
      ch = Math.max(1, Math.ceil(nC / cw));
    const L = ledgerFor(gl);
    const blendBytes =
      blendSnaps && h > 0 && bh > 0
        ? cpatchBlendAllocationBytes(gl, bundle._cpatchBlend, bw, bh, y0, cw, ch)
        : 0;
    const extraBytes = Math.max(0, rows * TEX_W * 16 - L.bytesOf(bundle.curveTex) + blendBytes);
    if (!L.admit(extraBytes, 'CPatch plane')) {
      bundle._cpatchMorphWhy = 'memory budget';
      // A previous segment's meshes do not describe this pose. The caller must
      // decline the analytic route and resume the raw morph's current upload.
      bundle._cpatchBuilt = 0;
      cancelQueuedBlend(R, bundle._cpatchBlend);
      const resume = ms.skipUploads || ms.skipCurveUploads;
      ms.skipUploads = false;
      ms.skipCurveUploads = false;
      if (resume && typeof ms.relerp === 'function') ms.relerp();
      return false;
    }
    const oldBlend = bundle._cpatchBlend;
    if (
      blendSnaps &&
      oldBlend &&
      (oldBlend.w !== bw ||
        oldBlend.h !== bh ||
        oldBlend.y0 !== y0 ||
        oldBlend.cw !== cw ||
        oldBlend.ch !== ch)
    ) {
      // Realize the replacement credit before growing the live plane. No queued
      // write may refer to the retired target or overwrite the fallback pose.
      cancelQueuedBlend(R, oldBlend);
      disposeCPatchBlend(gl, oldBlend);
      bundle._cpatchBlend = null;
    }
    const prev = bundle._cpatchMorphPlane;
    const grew = !prev || prev.rows !== rows;
    planeGrew = grew;
    const plane = grew ? new Float32Array(rows * rowFloats) : prev.plane;
    if (grew && cf) plane.set(cf.subarray(0, Math.min(cf.length, plane.length)));
    for (const c of chunks) plane.set(c.data, baseFloat + c.at);
    bundle._cpatchMorphPlane = { plane, rows };

    gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
    if (grew) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, plane);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    } else if (!blendSnaps) {
      // Upload appended rows only. A pending blend writes them directly.
      const y0 = baseFloat / rowFloats,
        h = rows - y0;
      if (h > 0)
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          y0,
          TEX_W,
          h,
          gl.RGBA,
          gl.FLOAT,
          plane.subarray(y0 * rowFloats, rows * rowFloats),
        );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Build coefficient planes after the live texture size is known.
    if (blendSnaps) {
      if (h > 0 && bh > 0) {
        // Store two linear functionals and one quadratic scalar: nine texels per block.
        const packed = packCPatchMorphPlanes(
          blendSnaps[0],
          blendSnaps[1],
          blendSnaps[2],
          nBlocks,
          baseBlock,
        );
        const nA = nBlocks * CP_BLOCK_FLOATS;
        const cPlane = new Float32Array(cw * ch * 4);
        cPlane.set(packed.subarray(nA * 2, nA * 2 + nBlocks * CP_MORPH_C_FLOATS));
        // Pad the A/B planes to their complete upload rectangles.
        const pad = (v) => {
          if (v.length === bw * bh * 4) return v;
          const o = new Float32Array(bw * bh * 4);
          o.set(v);
          return o;
        };
        const planes = [pad(packed.subarray(0, nA)), pad(packed.subarray(nA, nA * 2)), cPlane];
        if (!updateCPatchBlend(gl, bundle._cpatchBlend, planes, bw, bh, y0, cw, ch)) {
          disposeCPatchBlend(gl, bundle._cpatchBlend);
          bundle._cpatchBlend = buildCPatchBlend(gl, bundle.curveTex, planes, bw, bh, y0, cw, ch);
          if (bundle._cpatchBlend && !bundle._cpatchBlendDisposeHook) {
            bundle._cpatchBlendDisposeHook = true;
            (bundle._disposeHooks || (bundle._disposeHooks = new Set())).add((b) => {
              disposeCPatchBlend(gl, b._cpatchBlend);
              b._cpatchBlend = null;
              b._cpatchBlendKey = null;
            });
          }
        }
      }
      bundle._cpatchBlendKey = bundle._cpatchBlend ? blendKey : null;
      bundle._cpatchBlendDead = bundle._cpatchBlend ? null : blendKey;
      // Apply the current pose after packing samples; the last sample is u = 1.
      if (bundle._cpatchBlend) queueBlend(R, gl, bundle._cpatchBlend, uOf(), opts.deferBlends);
      else if (!grew) {
        // The blend could not be built and the upload above was skipped on its promise.
        const yy = baseFloat / rowFloats,
          hh = rows - yy;
        gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
        if (hh > 0)
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            yy,
            TEX_W,
            hh,
            gl.RGBA,
            gl.FLOAT,
            plane.subarray(yy * rowFloats, rows * rowFloats),
          );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    moved = r.restructured.length > 0 || !!blendSnaps || blendRetired;
  }

  if (!claimFillMeshes(bundle, MESH_OWNER.CPATCH, meshes)) return false;
  bundle._cpatchMeshRef = meshes;
  bundle._lbMeshesRaw = null;
  bundle._lbGen = bundle._geomGen | 0;
  bundle._lbHasSlug = meshes.some((m) => !m);
  // A row without a posed mesh draws its cover quad in the same stream. Record it as a
  // decline (bundle._cpatchMorphRowWhy says why), never as a row CPatch drew.
  bundle._lbSlugWhy = meshes.map((m, s) =>
    m
      ? SLUG_WHY.REAL
      : ms.curveRanges && ms.curveRanges[s]
        ? SLUG_WHY.DECLINED
        : SLUG_WHY.NO_GEOMETRY,
  );
  // Invalidate both the kind mask and its generation after claiming CPatch meshes.
  bundle._lbKindMask = undefined;
  bundle._lbKindMaskGen = -1;
  // Retain vertex uploads within a segment; only coefficients change with t.
  if (moved && bundle._unifiedFill) {
    // The cache owns GL objects (its vertex array, buffer and coefficient texture); dropping the reference would leak them.
    const uf = bundle._unifiedFill;
    if (uf.glo) {
      deleteGlResource(gl, 'VertexArray', uf.glo.vao);
      deleteGlResource(gl, 'Buffer', uf.glo.buf);
    }
    if (uf.coef && uf.coef.tex) deleteGlResource(gl, 'Texture', uf.coef.tex);
    bundle._unifiedFill = null;
  }
  bundle._cpatchStructGen = (bundle._cpatchStructGen | 0) + (moved ? 1 : 0);
  // Suppress raw curve uploads only when every drawn row has a CPatch mesh
  // and no stroke reads the raw plane. Restore the current raw pose after
  // plane growth or after re-enabling its uploads.
  const readsPlane = (() => {
    const dl = bundle.drawList,
      meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0;
    if (!dl || !meta || !st) return true;
    // Resource bakes read raw curves even when all visible rows have meshes.
    if (R._handle && R._handle.bundle === bundle && R._handle.maskRegions.length) return true;
    for (const op of dl) {
      if (op.kind !== 'fillShape') continue;
      const sIdx = op.shapeIdx | 0;
      if (!(meshes && meshes[sIdx]) || isStrokeRow(meta, st, sIdx)) return true;
    }
    return false;
  })();
  const lerpWasOff = !!ms.skipCurveUploads;
  ms.skipCurveUploads = !readsPlane;
  if (readsPlane && (planeGrew || lerpWasOff) && typeof ms.relerp === 'function') ms.relerp();
  // Allow the diagnostic option to force GPU blending for small paint planes.
  if (opts.skipPaintUploads === false) ms.gpuSmallPlanes = true;
  if (opts.dupUpload) ms.dupUpload = opts.dupUpload | 0;
  // Diagnostic control: invalidate tracked state without changing native GL.
  if (opts.bumpEpoch) noteExternalGlWrite();
  bundle._cpatchMorphT = tNow;
  bundle._cpatchBuilt = built;
  bundle._cpatchMeshN = meshes.length;
  bundle._cpatchMeshAt = meshes
    .map((m, k) => (m ? k : -1))
    .filter((k) => k >= 0)
    .join('/');
  bundle._cpatchMorphSegs = morph.shapes.filter(Boolean).map((sh) => sh.seg);
  if (globalThis.__CPATCH_TRACE && globalThis.__CPATCH_TRACE.length < 500)
    globalThis.__CPATCH_TRACE.push({
      exit: true,
      built,
      meshes: meshes.length,
      tag: bundle.__tag || '?',
    });
  return true;
}
