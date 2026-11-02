// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { certifyPolynomialMorph } from '../core/polynomialMorph.js';
// Convert independent contour batches off-thread without GL or DOM access.
import { convertContour, morphTolPx } from './cpatchConvert.js';
import { K_IMPL, K_PK } from '../geom/cpatchImplicit.js';
import { planMorph, splitForMorph } from './cpatchMorphCert.js';
import { applyWorkerFlags } from './workerFlags.js';

// Certify a native whole boundary before planning decomposition pieces. Both
// paths run in the worker; unsupported native geometry retains the planner.
function planJob(job, opts) {
  const native = job.nativeExact ? certifyPolynomialMorph(job.A, job.B) : null;
  if (native)
    return {
      key: job.key,
      A: job.A,
      B: job.B,
      plan: [{ t0: 0, t1: 1, nativeArea: native }],
      err: null,
    };

  if (opts && opts.nativeAreaOnly)
    return {
      key: job.key,
      plan: null,
      err: 'uncertified interval: native whole-interval certificate declined',
    };

  // Derive one tolerance from the authored endpoints for the fallback planner.
  const tolPx = (opts && opts.tolPx) != null ? opts.tolPx : morphTolPx(job.A, job.B);
  const convert = (cs, o) => {
    try {
      return convertContour(cs, {
        maxCurves: (opts && opts.maxCurves) || 8,
        tolPx,
        noCurveCuts: true,
        forceBezout: true,
        leakMargin: (o && o.leakMargin) || 0,
      });
    } catch {
      return null;
    }
  };
  const [A, B] = splitForMorph(job.A, job.B);
  // Preserve the caller's planning budget and report the refusal reason.
  const report = {};
  const plan = planMorph(A, B, convert, {
    tolPx,
    report,
    ...((opts && opts.maxPlanMs) != null ? { maxPlanMs: opts.maxPlanMs } : {}),
  });
  const why = report.overTime
    ? `no plan: over the ${report.planMs} ms plan budget`
    : report.overBudget
      ? 'no plan: over the certificate work budget'
      : report.exhausted
        ? 'no plan: maxSegments exhausted'
        : report.unsupportedWeights
          ? 'no plan: unsupported rational weights'
          : report.uncertified
            ? 'no plan: uncertified interval'
            : 'no plan';
  return plan ? { key: job.key, A, B, plan, err: null } : { key: job.key, plan: null, err: why };
}

// Apply and clear flags per job to prevent configuration leaking across jobs.
self.onmessage = (e) => {
  const { id, jobs, opts, kind, flags } = e.data || {};
  applyWorkerFlags(flags);
  // Epoch-time stamps of the work itself, so the pool tap can see the gap between a job ending
  // here and the next one arriving -- dispatch latency the main thread's side cannot observe.
  const wt0 = performance.timeOrigin + performance.now();
  const stamp = (msg) => {
    msg.wt0 = wt0;
    msg.wt1 = performance.timeOrigin + performance.now();
    return msg;
  };
  if (kind === 'plan') {
    const out = (jobs || []).map((j) => {
      try {
        return planJob(j, opts);
      } catch (ex) {
        return { key: j.key, plan: null, err: String((ex && ex.message) || ex) };
      }
    });
    self.postMessage(stamp({ id, out }));
    return;
  }
  const out = (jobs || []).map((j) => {
    try {
      // A split contour's piece carries its contour's bar (convertContourSplit), not one of its own.
      const r = convertContour(
        j.curves,
        j.tolPx != null ? { ...(opts || {}), tolPx: j.tolPx } : opts || {},
      );

      if (opts && opts.__countOnly)
        return { key: j.key, patches: r ? { patches: [], stats: {} } : null, err: null };
      // Send curves, interior points and validated implicit memos. Structured
      // clone drops symbol properties; rebuilding those memos would lose the
      // source-conditioned constraints used to certify the patches.
      const patches = r
        ? {
            slim: r.patches.map((p) => ({
              c: p.curves,
              i: p.inside,
              t: p._terminal || 0,
              m: p.curves.map((c) => [c[K_IMPL] || null, c[K_PK] || null]),
              s: p.impls.map((q) => q.s),
            })),
            stats: r.stats,
          }
        : null;
      return { key: j.key, patches, err: null };
    } catch (ex) {
      // A contour that will not convert is not fatal: the caller falls back to
      // another engine for that shape. Report it rather than losing the batch.
      return { key: j.key, patches: null, err: String((ex && ex.message) || ex) };
    }
  });
  self.postMessage(stamp({ id, out }));
};
