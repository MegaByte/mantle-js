// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rowEngines.js -- WHICH ENGINE DREW each ROW, per draw.

//   debugStats.rowEngines = { routeClass: the fillRouteClass reason ('static-cover', 'morph', ...), route: 'unified' | 'points' | 'hybrid', rows, counts: { lb, sdf, cpatch, cover, coverHard, points, other },
//                              ranges: [[firstRow, lastRow, 'lb'], ...] (maximal runs of one engine, in row order), hash }
//
// `hash` is FNV-1a over the per-row engine codes, so a harness can assert the SET with one string compare: the same bundle at the
// same size under the same options must give the same hash on any page. The classes are the ones the unified route itself reads
// (R._unifiedRowClasses: the same rules entriesFor applies when it builds the stream), and the points rows come from the row gate's
// plan, so the report cannot describe a draw nobody made.
import { ROW_COVER_AA, ROW_COVER_HARD, ROW_MESH } from './coverKernelPolicy.js';
import { isStrokeRow } from './engineLedger.js';
import { lbShapeMayPick } from './lbShapePolicy.js';
import { META_FLAGS_SHAPE, META_FILL_A } from '../bundle/layout.js';

export const ROW_ENGINE = Object.freeze({
  other: 0,
  cover: 1,
  coverHard: 2,
  lb: 3,
  sdf: 4,
  cpatch: 5,
  points: 6,
});
const NAMES = ['other', 'cover', 'coverHard', 'lb', 'sdf', 'cpatch', 'points'];

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachRowEngines(R) {
  /// Record that `bundle` was just drawn by `route` ('unified' | 'points'); `plan` is the row gate's cut for a points draw.
  R._noteRowDraw = (bundle, route, plan) => {
    R._lastRowDraw = { bundle, route, plan: plan || null };
  };

  /// The per-row engine codes (a Uint8Array over the bundle's rows) of the last recorded draw, or null.
  R.rowEngineCodes = (bundle) => {
    const last = R._lastRowDraw;
    const b = bundle || (last && last.bundle);
    if (!b || !last || last.bundle !== b) return null;
    const n = b.numShapes | 0;
    const codes = new Uint8Array(n);
    if (last.route === 'cover') {
      // the classic cover pass: a fill row is a cover quad (Slug / AAC kernel, or the hard per-row id), a stroke row or a row with no fill is not a fill engine's
      const meta = b.metaFloats,
        st = b.metaFloatsPerShape | 0;
      if (!meta || !st || !b.drawList) return null;
      for (const op of b.drawList) {
        if (op.kind !== 'fillShape') continue;
        const s = op.shapeIdx | 0;
        if (s < 0 || s >= n) continue;
        if (isStrokeRow(meta, st, s) || !(meta[s * st + META_FILL_A] > 0)) continue;
        codes[s] =
          (((meta[s * st + META_FLAGS_SHAPE] | 0) >> 15) & 3) >= 2
            ? ROW_ENGINE.coverHard
            : ROW_ENGINE.cover;
      }
      return codes;
    }
    const fixed = new Uint8Array(n); // rows whose engine the row gate's plan already named
    if (last.route === 'points') {
      const s = b._aacPointsShapes;
      const plan = last.plan;
      const meta = b.metaFloats,
        st = b.metaFloatsPerShape | 0;
      if (s && s.rows) {
        for (let i = 0; i < s.rows.length; i++) {
          codes[s.rows[i]] = ROW_ENGINE.points;
          fixed[s.rows[i]] = 1;
        }
        if (plan && plan.runs)
          for (const run of plan.runs) {
            if (run.pts) continue;
            for (let i = run.a; i < run.b; i++) {
              const r = s.rows[i];
              if (run.cover) {
                // the cover pass with the AAC kernel: a fill row is a cover quad, a stroke row is the stroke pass's
                codes[r] =
                  meta && st && !isStrokeRow(meta, st, r) && meta[r * st + META_FILL_A] > 0
                    ? ROW_ENGINE.cover
                    : 0;
              } else {
                codes[r] = 0;
                fixed[r] = 0;
              }
            }
          }
      }
      if (!plan || !plan.runs || plan.runs.every((r) => r.pts || r.cover)) return codes;
      // a hybrid: the mesh runs are the unified route's rows
    }
    const cls = R._unifiedRowClasses ? R._unifiedRowClasses(b) : null;
    if (!cls) return last.route === 'points' ? codes : null;
    const meshes = b._lbMeshes;
    const cp = R.opts.cpatchFill === true && !!b._cpatchBuilt;
    for (let s = 0; s < n && s < cls.length; s++) {
      if (fixed[s]) continue;
      const c = cls[s];
      if (c === ROW_MESH) {
        const m = meshes && meshes[s];
        codes[s] =
          m && m.prim ? ROW_ENGINE.sdf : (m && m.cpatch) || cp ? ROW_ENGINE.cpatch : ROW_ENGINE.lb;
      } else if (c === ROW_COVER_AA) codes[s] = ROW_ENGINE.cover;
      else if (c === ROW_COVER_HARD) codes[s] = ROW_ENGINE.coverHard;
    }
    return codes;
  };

  /// debugStats.rowEngines: null before any recorded draw.
  R.getRowEngines = () => {
    const last = R._lastRowDraw;
    if (!last) return null;
    const codes = R.rowEngineCodes(last.bundle);
    if (!codes) return null;
    const counts = {};
    for (const nm of NAMES) counts[nm] = 0;
    const ranges = [];
    let h = 0x811c9dc5;
    for (let i = 0; i < codes.length; i++) {
      counts[NAMES[codes[i]]]++;
      h = Math.imul(h ^ codes[i], 0x01000193) >>> 0;
      const prev = ranges[ranges.length - 1];
      if (prev && prev[2] === NAMES[codes[i]] && prev[1] === i - 1) prev[1] = i;
      else if (codes[i] !== 0) ranges.push([i, i, NAMES[codes[i]]]);
    }
    const hybrid =
      last.route === 'points' &&
      last.plan &&
      last.plan.runs &&
      !last.plan.runs.every((r) => r.pts || r.cover);
    // WHY a fill row has no mesh, from the build that produced them (bundle._lbSlugWhy), and the build's own state: the two facts that
    // separate "the policy passed it over" from "the mesh never arrived".
    const b = last.bundle,
      why = {};
    if (b._lbSlugWhy)
      for (let i = 0; i < codes.length; i++)
        if (codes[i] === ROW_ENGINE.cover || codes[i] === ROW_ENGINE.coverHard) {
          const w = b._lbSlugWhy[i] == null ? 'none' : String(b._lbSlugWhy[i]);
          why[w] = (why[w] | 0) + 1;
        }
    const meshes = b._lbMeshes;
    let built = 0,
      sentinel = 0,
      pending = 0;
    if (meshes)
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        if (m === undefined) {
          pending++;
          continue;
        }
        if (!m) continue;
        if (m.slug || !((m.vertexCount | 0) > 0)) sentinel++;
        else built++;
      }
    // `pending` = rows the build has not delivered yet (a partial adoption): they draw their cover quad until the mesh lands, so a draw with
    // pending > 0 is NOT the steady-state picture (ready: false); the steady state is a function of (bundle, size, options) only.
    // No mesh set yet while the route is on: every row that COULD take a mesh is pending (the classic cover pass drew them meanwhile).
    // A static bundle under 'auto' takes the cover pass and no mesh is ever built for it (fillRouteClass.js): nothing is pending.
    if (
      !meshes &&
      R._lbFillMode !== 'off' &&
      !R._lbSlugOnly &&
      R.opts.unifiedFill !== false &&
      !(R._fillRouteReason && R._fillRouteReason(b) === 'static-cover')
    ) {
      const cpAuto = R.opts.cpatchAuto === true && !b._morphSrc;
      for (let i = 0; i < codes.length; i++)
        if (codes[i] !== 0 && lbShapeMayPick(b, i, null, cpAuto)) pending++;
    }
    const build = {
      meshes: meshes ? meshes.length : null,
      built,
      sentinel,
      pending,
      ready: pending === 0 && b._lbPartialGen == null,
      partial: b._lbPartialGen != null,
      gen: b._lbGen | 0,
      preparedGen: b._lbPreparedGen | 0,
      adoptKey: b._lbAdoptKey | 0,
      memDenied: !!b._lbMemDenied,
      why,
    };
    return {
      route: hybrid ? 'hybrid' : last.route,
      rows: codes.length,
      counts,
      ranges,
      hash: h.toString(16),
      build,
      routeClass: R._fillRouteReason ? R._fillRouteReason(b) : null,
    };
  };

  /// WHERE A BUNDLE'S ANALYTIC (LOOP-BLINN) BUILD STANDS, in one word, for the cold-start harnesses (they log it per bundle with the time a
  /// route flipped): 'off' (the route is off), 'skipped-by-type' (no row can ever pick a mesh: strokes, clips, masks, filters, primitives,
  /// straight-edged shapes), 'pending' (rows that can pick one have none yet: the worker has not delivered), 'built-declined' (meshes are
  /// built and none draws: every one is a Slug sentinel), 'built-picked' (at least one real mesh is resident and drawable).
  R.lbCensus = (bundle) => {
    const b = bundle;
    if (!b || b._disposed) return null;
    const n = b.numShapes | 0,
      cpAuto = R.opts.cpatchAuto === true && !b._morphSrc;
    let may = 0;
    for (let i = 0; i < n; i++) if (lbShapeMayPick(b, i, null, cpAuto)) may++;
    const meshes = b._morphSrc ? b._morphMeshes : b._lbMeshes;
    let built = 0,
      sentinel = 0,
      missing = 0;
    if (Array.isArray(meshes))
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        if (m === undefined) {
          missing++;
          continue;
        }
        if (!m) continue;
        if (m.slug || !((m.vertexCount | 0) > 0)) sentinel++;
        else built++;
      }
    let state;
    if (R._lbSlugOnly || R._lbFillMode === 'off' || R.opts.unifiedFill === false) state = 'off';
    else if (may === 0) state = 'skipped-by-type';
    else if (
      b._lbPartialGen != null ||
      (!Array.isArray(meshes) && !(meshes === null && (b._lbGen | 0) === (b._geomGen | 0))) ||
      b._lbWorkerPendingGen === (b._geomGen | 0)
    )
      state = 'pending';
    else if (built > 0) state = 'built-picked';
    else state = 'built-declined';
    return { state, rows: n, mayPick: may, built, sentinel, missing };
  };
}
