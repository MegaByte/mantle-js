// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbShapePolicy — under 'auto', which shapes the analytic route draws with their Loop-Blinn mesh.
//
// The unified draw carries mesh entries and cover quads in ONE stream through ONE program, so the
// engine is a per-entry choice and mixing them costs a draw nothing (unifiedFillDraw entriesFor).
//
// The rule:
//   cubic and arc shapes    take Loop-Blinn meshes
//     ...except compact     a convex CUBIC shape cut into many short segments (>= LB_CONVEX_MIN_SEGS,
//                           under LB_CONVEX_MIN_PX2_PER_SEG px² per segment), where the cover kernel's
//                           band walk stays cheap and LB pays for many tiny cubic crescents; arcs are exempt.
//   quadratic shapes        keep their cover quad
//   line-only shapes        keep their cover quad
//
// "Convex" is estimated as an outline an average scanline crosses at most LB_CONVEX_CROSS
// times (shapeStats `cross`: 2 for any convex outline, ~2x the point count for a star). That count is
// also what the cover kernel's band walk pays per fragment.
import { shapeSegStats } from './shapeStats.js';
import { unitPx2 } from './shapeScale.js';
import { isStrokeRow } from './engineLedger.js';
import { SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../primitives/seg.js';
import { mantleDebugHook } from '../core/diagnostics.js';

const LB_CURVED = (1 << SEG_CUBIC) | (1 << SEG_ARC);
const CPATCH_CURVED = LB_CURVED | (1 << SEG_QUAD);
export const LB_CONVEX_CROSS = 2.5;
export const LB_CONVEX_MIN_PX2_PER_SEG = 200;
export const LB_CONVEX_MIN_SEGS = 32;
const CUBIC = 1 << SEG_CUBIC;

// ── THE NO-AA TERM ──────────────────────────────────────────────────────────────────────────────
//
// When an opaque stroke provably covers a fill's edge the cover quad is shaded by a HARD kernel
// (renderFillHardBand / renderFillGWNSDF), not by Slug or AAC. That changes the right-hand side of
// the model above and nothing else: the walk is the same walk, integrating a crossing count instead
// of an area. So "should this row take its mesh" is still a per-row question with the same shape,
// asked against a different constant:
//   * a row of a bundle whose every fill is covered (`noAaFill`, what preferNoAa tests) is declined;
//   * a row merely STAMPED hard by the per-row census (MANTLE_HARD_MIXED, flagsShape bits 15-16) is not.
const LB_NOAA_PX2_PER_SEG = Number.POSITIVE_INFINITY;
const LB_NOAA_MIXED_PX2_PER_SEG = 0;
/// Per-row hard bits the importer stamped for MANTLE_HARD_MIXED: 2 = band-hard, 3 = tree-hard.
/// meta slot 27 is `flagsShape`; see bundleFinalize's MIXED census.
function hardRowBits(meta, st, s) {
  if (!meta || st < 28) return 0;
  return (Math.floor(meta[s * st + 27] + 0.5) >> 15) & 3;
}
/// The on-screen size term. A bundle whose fill rows' bboxes cover, summed, fewer than this many DEVICE px2
/// -- a 512 x 512 px canvas of bbox -- stays on the cover kernel entirely: its mesh's per-triangle work does not amortize
/// over so few pixels and LB draws its sub-pixel triangles with the larger edge error. It is a RENDER-TIME choice -- the
/// bbox areas are authored em^2 and the factor is the draw's own px2 per em2 (unitPx2), so the authored scale cancels and the
/// build is untouched. The TEST HOOK `__LB_MIN_BUNDLE_PX2` (under __MANTLE_DEBUG__) replaces the bar; 0 turns the term off.
export const LB_MIN_BUNDLE_PX2 = 262144;
/// E_MIN: an AUTO row under this device extent keeps its cover quad, when at least LB_MIN_EXTENT_SHARE of the
/// fill rows are under it (options lbMinExtentPx, lbMinExtentShare; 0 turns it off).
export const LB_MIN_EXTENT_PX = 8;
export const LB_MIN_EXTENT_SHARE = 0.1;
const minBundlePx2 = () => {
  const v = mantleDebugHook('__LB_MIN_BUNDLE_PX2');
  return v === undefined ? LB_MIN_BUNDLE_PX2 : +v;
};
/// every switch that can change an answer, in the pick cache's key.
const ruleSig = () => `${minBundlePx2()}|${areaMaxCurvePx2()}`;
/// THE AREA COST GATE. A complete-paint area is ONE cell whose fragment shader walks all of its curves for every pixel of the
/// shape's bounding box, so its cost goes as curves x box pixels. Where that product is over the limit the area cell loses to the
/// cover quad (a large drawing at 2048 px takes half again as long when hundreds more shapes take the area cell) and the row draws its cover
/// quad instead, exactly as a row the policy passes over does. Dropping the area route at BUILD time and decomposing the paint
/// instead is not the answer: the area cells of the large many-curve shapes are where the route's accuracy gain comes from
/// (decomposing even the three largest shapes of a complex drawing raises its mean error against the Chrome 8x reference by
/// over a third, and a 64-point cubic star's many times over). The cost is in device pixels, so the decision follows the draw's scale like the other
/// size terms. It is a choice for 'cpatch-auto', which is asked to pick: a pin (route 'cpatch') draws every cell and takes the cost. CP_AREA_MAX_CURVE_PX2 is the break-even; the debug hook __CP_AREA_PX replaces it (a very large value turns the gate off).
export const CP_AREA_MAX_CURVE_PX2 = 3e6;
const areaMaxCurvePx2 = () => {
  const v = mantleDebugHook('__CP_AREA_PX');
  return v === undefined ? CP_AREA_MAX_CURVE_PX2 : +v;
};
/// Does a complete-paint area of `curves` curves over `bboxPx2` device px^2 of box cost more than the cover quad? Not for a mesh with
/// no area curve count (a decomposition), and never when the limit is off.
export function areaCellLoses(curves, bboxPx2, limit = areaMaxCurvePx2()) {
  return curves > 0 && curves * bboxPx2 > limit;
}
/// The pixels an area cell can shade are its box's on the canvas, so where even the whole canvas pays, the row pays at any scale: the box past the canvas shades nothing. Under
/// `bar` the row keeps its cell at scale <= bar; a row that pays takes no bar at all. Without this, a shape zoomed past the canvas priced pixels it never draws, and a few-curve
/// shape, cheap at any zoom, left CPatch at scale 2^4.
const areaBar = (limit, curves, boxArea, canvasPx2) =>
  curves * canvasPx2 <= limit ? Number.POSITIVE_INFINITY : barArea(limit, curves, boxArea);
const canvasPx2Of = (R) => {
  const v = R && R.viewportSize ? R.viewportSize() : null;
  return v ? v[0] * v[1] : Number.POSITIVE_INFINITY;
};
/// The answer is a function of (bundle, scale bucket, options) only: it recomputes when the quarter-octave
/// bucket changes, and the unified stream rebuilds only when the answer differs.
export const LB_PICK_MIN_INTERVAL_MS = 0;

/// Can shape row `s` ever take its mesh, whatever the draw size? The rows that never can are the
/// ones not worth BUILDING a mesh for: no fill, a stroke row (its mesh is the interior, not its
/// paint), clip / mask / inline filter (per-shape passes the combined stream does not batch), the
/// recognized-primitive kinds (meta slot 44, drawn as SDF records), and shapes with no cubic or arc
/// (or no quadratic, cubic or arc when CPatch is in the decision tree).
export function lbShapeMayPick(bundle, s, stats, cpatchAuto = false) {
  const meta = bundle.metaFloats,
    st = bundle.metaFloatsPerShape | 0;
  if (!meta || !st) return false;
  const b = s * st;
  if (!(meta[b + 7] > 0) || isStrokeRow(meta, st, s)) return false;
  if (Math.floor(meta[b + 30] + 0.5) !== 0 || Math.floor(meta[b + 31] + 0.5) !== 0) return false;
  if (st >= 33 && Math.floor(meta[b + 32] + 0.5) !== 0) return false;
  if (st >= 45) {
    const pk = Math.floor(meta[b + 44] + 0.5);
    if (pk === 2 || pk === 3) return false;
    if (pk === 1) {
      const w = meta[b + 2] - meta[b],
        h = meta[b + 3] - meta[b + 1];
      if (Math.abs(w - h) <= 1e-3 * Math.max(w, 1e-6)) return false;
    }
  }
  const types = stats ? stats.types[s] : bundle.segTypeMask | 0;
  const cpAuto = cpatchAuto && !(bundle && bundle._morphSrc);
  if (cpAuto && !(types & LB_CURVED)) {
    if (bundle.fillNormByShape && bundle.fillNormByShape[s] < 0) return false;
    if (stats && stats.segs[s] > 256) return false;
  }
  return (types & (cpAuto ? CPATCH_CURVED : LB_CURVED)) !== 0;
}

/// Build-skip mask for rows that cannot select a mesh at any draw scale.
/// Null means every row is eligible. Apply only under explicitly selected auto
/// policy; pinned modes may require rows omitted by an automatic build.
export function lbBuildSkipMask(bundle, cpatchAuto = false) {
  const n = bundle ? bundle.numShapes | 0 : 0;
  if (n < 1) return null;
  const cpAuto = cpatchAuto && !bundle._morphSrc;
  const stats = shapeSegStats(bundle);
  let skip = null;
  for (let s = 0; s < n; s++) {
    if (lbShapeMayPick(bundle, s, stats, cpAuto)) continue;
    (skip || (skip = new Uint8Array(n)))[s] = 1;
  }
  return skip;
}

/// Does ANY row of this bundle qualify? The build admission: false means no mesh is worth building.
///
/// Its cheap early-out has to agree with lbShapeMayPick, WHICH IS THE PREDICATE IT SUMMARIZES. The
/// type test below is a shortcut for "no row can qualify": a row with no cubic or arc never does.
export function lbBundleMayPick(bundle, cpatchAuto = false) {
  const cpAuto = cpatchAuto && !(bundle && bundle._morphSrc);
  const curveMask = cpAuto ? CPATCH_CURVED : LB_CURVED;
  if (!bundle || !((bundle.segTypeMask | 0 || 0xf) & curveMask)) return false;
  const gen = bundle._geomGen | 0;
  if (cpAuto) {
    if (bundle._cpatchMayPickGen === gen) return bundle._cpatchMayPick;
  } else if (bundle._lbMayPickGen === gen) {
    return bundle._lbMayPick;
  }
  const stats = shapeSegStats(bundle);
  const n = bundle.numShapes | 0;
  let any = false;
  for (let s = 0; s < n && !any; s++) any = lbShapeMayPick(bundle, s, stats, cpAuto);
  if (cpAuto) {
    bundle._cpatchMayPickGen = gen;
    return (bundle._cpatchMayPick = any);
  }
  bundle._lbMayPickGen = gen;
  return (bundle._lbMayPick = any);
}

/// The floor row `s` must clear, in device px^2 of bbox per segment, for its mesh to be worth
/// taking on this draw. 0 means "no size condition" (the answer is scale-free for this row).
///
/// ONE function, so the policy, the decision-surface probe and the smoke cannot drift: the size
/// exclusion and both no-AA floors are the same lines read three ways.
/// @param {boolean} hardAll   every fill of the bundle is opaque-stroke-covered (preferNoAa)
/// @param {boolean} hardMixed some rows are, stamped per row (preferNoAaMixed)
export function minPx2PerSegFor(
  meta,
  st,
  s,
  stats,
  hardAll,
  hardMixed,
  fillNorm = 0,
  isCpatch = false,
) {
  const types = stats ? stats.types[s] : 0,
    cross = stats ? stats.cross[s] : 0;
  // A hard cover quad is a different right-hand side, so it gets its own floor and the size term
  // does not also apply -- asking both would price the row against two kernels at once.
  if (hardAll) return LB_NOAA_PX2_PER_SEG;
  if (hardMixed && hardRowBits(meta, st, s) >= 2) return LB_NOAA_MIXED_PX2_PER_SEG;
  // An uncertified multi-contour fill (fillNorm < 0) keeps its CDT-resolved Loop-Blinn mesh rather
  // than dropping back to an unnormalized cover quad.
  if (fillNorm < 0) return 0;
  // CPatch does not tessellate per-segment cubic crescents, so the compact-convex cubic triangle
  // count floor does not apply to CPatch meshes.
  if (isCpatch) return 0;
  const ns = stats ? stats.segs[s] : 0;
  return types & CUBIC && ns >= LB_CONVEX_MIN_SEGS && cross <= LB_CONVEX_CROSS
    ? LB_CONVEX_MIN_PX2_PER_SEG
    : 0;
}

/// Per shape row, 1 = draw its mesh, 0 = its cover quad; null when no row takes a mesh. `meshes` is
/// the bundle's built set (a missing or Slug-sentinel entry is never picked). A recognized
/// primitive is always taken: it is one analytic distance and wins at every size.
///
/// Recomputed when the geometry, the mesh set or the draw's no-AA answer changes. A bundle with a
/// row whose floor is not 0 depends on the device scale, so it recomputes when the scale moves by a
/// quarter octave, at most once every LB_PICK_MIN_INTERVAL_MS; a bundle whose every row's floor is 0
/// is SCALE-FREE and never recomputes for a zoom. `bundle._lbPickKey` changes only when the
/// ANSWER does, so a zoom that crosses no shape's threshold rebuilds no stream.
///
/// THE NO-AA ANSWER IS PER-DRAW STATE, not per bundle -- an override, a translucent draw, a recolor
/// or a stroke that has become thinner than ~2 device px all withdraw the proof -- so it is part of
/// what the cache is keyed on. Left out, a bundle would keep the picks it had under a covering
/// stroke into the frame where the stroke stopped covering.
// ── THE SIZE GATES, AS DATA ─────────────────────────────────────────────────────────────────────
//
// Every scale-dependent term of the pick is a comparison of the draw's QUANTIZED scale (px2 per unit2, rounded to a quarter octave) with a BAR that
// depends on the bundle alone, so the gate and its critical scales come from the same definition: `lbPickRows` turns a bundle into rows
// ({ always | loBar, eBar, hiBar, hard }), `rowMeshed` is the gate, and `lbPickBreaks` reads the same rows for the unit px2 values at which the answer
// can change. Nothing in `lbPickBreaks` samples a scale or calls the gate at a size.
//   pick iff  scale >= loBar            (bundle size bar, compact-convex floor)
//        and  scale >= eBar             (E_MIN, while the extent share is met: a function of the UNQUANTIZED unit px2)
//        and  scale <= hiBar            (the CPatch area cost gate: loses once curves x box px2 passes the limit)
/// The quantized scale of a draw whose unit px2 is k2: the rule the pick cache keys on.
export const pickBucket = (k2) => (k2 > 0 ? Math.round(Math.log2(k2) * 4) : -1e9);
export const bucketScale = (bucket) => (bucket > -1e8 ? Math.pow(2, bucket / 4) : 0);
/// The smallest unit px2 whose quantized scale is >= T (a "scale >= T" bar flips there), and the smallest whose quantized scale is > T ("scale <= T" stops holding).
export const k2AtLeast = (T) =>
  T > 0 && Number.isFinite(T) ? Math.pow(2, (Math.ceil(Math.log2(T) * 4 - 1e-9) - 0.5) / 4) : 0;
export const k2Above = (T) =>
  T > 0 && Number.isFinite(T)
    ? Math.pow(2, (Math.floor(Math.log2(T) * 4 + 1e-9) + 1 - 0.5) / 4)
    : 0;
/// The bars. Each is the scale at which its comparison flips, from the same terms the gate compares.
export const barBundle = (minBundle, sumBoxArea) =>
  sumBoxArea > 0 ? minBundle / sumBoxArea : Number.POSITIVE_INFINITY;
export const barExtent = (eMin, extent) =>
  extent > 0 ? (eMin / extent) * (eMin / extent) : Number.POSITIVE_INFINITY;
export const barFloor = (floor, segs, boxArea) => (floor * segs) / boxArea;
export const barArea = (limit, curves, boxArea) => limit / (curves * boxArea);
/// One row's answer at quantized scale `scale`, with E_MIN `eActive` (the share rule, a function of the unquantized unit px2).
export function rowMeshed(row, scale, eActive) {
  if (row.always) return true;
  if (!(scale >= row.loBar)) return false;
  if (eActive && !(scale >= row.eBar)) return false;
  if (!(scale <= row.hiBar)) return false;
  return true;
}
/// The rows of a bundle's pick, and the E_MIN share rule's inputs: everything about the answer that does not depend on the draw's scale.
export function lbPickRows(R, bundle, meshes, hardAll, hardMixed) {
  const stats = shapeSegStats(bundle);
  const meta = bundle.metaFloats,
    st = bundle.metaFloatsPerShape | 0,
    n = bundle.numShapes | 0;
  const eMinOpt =
    R && R.opts
      ? R.opts.lbMinExtentPx != null
        ? Math.max(0, +R.opts.lbMinExtentPx)
        : LB_MIN_EXTENT_PX
      : 0;
  const shareOpt =
    R && R.opts && R.opts.lbMinExtentShare != null ? +R.opts.lbMinExtentShare : LB_MIN_EXTENT_SHARE;
  const minBundle =
    R && R.opts && R.opts.lbMinBundlePx2 != null ? +R.opts.lbMinBundlePx2 : minBundlePx2();
  const cpatchAuto = !!(R && R.opts && R.opts.cpatchAuto === true && !(bundle && bundle._morphSrc));
  const pinned = !!(R && R.opts && R.opts.cpatchFill === true && bundle._cpatchBuilt);
  const areaLimit = areaMaxCurvePx2(),
    canvasPx2 = canvasPx2Of(R);
  let sumA = 0;
  const fillExtents = []; // every fill row's extent (the share rule counts them all, mesh or not)
  for (let s = 0; meta && st && s < n; s++) {
    const b = s * st;
    if (!(meta[b + 7] > 0)) continue;
    fillExtents.push(Math.max(meta[b + 2] - meta[b], meta[b + 3] - meta[b + 1]));
    sumA += Math.max(0, (meta[b + 2] - meta[b]) * (meta[b + 3] - meta[b + 1]));
  }
  const fn = bundle.fillNormByShape;
  const rows = []; // { s, always, loBar, eBar, hiBar, hard }
  for (let s = 0; s < n && s < meshes.length; s++) {
    const m = meshes[s];
    if (!m || m.slug || !((m.vertexCount | 0) > 0)) continue;
    if (m.prim) {
      rows.push({ s, always: true, hard: false });
      continue;
    }
    const isCpatch = !!m.cpatch;
    const bb =
      meta && st ? (meta[s * st + 2] - meta[s * st]) * (meta[s * st + 3] - meta[s * st + 1]) : 0;
    const row = {
      s,
      always: false,
      loBar: 0,
      eBar: 0,
      hiBar: Number.POSITIVE_INFINITY,
      hard: !!(hardAll || (hardMixed && hardRowBits(meta, st, s) >= 2)),
    };
    // A pinned CPatch bundle draws every mesh it was given, at any size: the request wins over the cost gate, and the caller takes the cost.
    if (pinned) {
      row.always = true;
      row.scaleFree = true;
      rows.push(row);
      continue;
    }
    if (isCpatch && !cpatchAuto && !(R && R.opts && R.opts.cpatchFill === true)) continue;
    if (isCpatch && ((m.dropped | 0) > 0 || (m.unresolved | 0) > 0)) continue;
    if (!lbShapeMayPick(bundle, s, stats, isCpatch || cpatchAuto)) continue;
    const isAreaOnly = isCpatch && !!m.cpatchAreaOnly;
    if (isAreaOnly && m.areaCurves > 0 && meta && st)
      row.hiBar = areaBar(areaLimit, m.areaCurves, bb, canvasPx2);
    if (!isAreaOnly) {
      if (minBundle > 0) row.loBar = Math.max(row.loBar, barBundle(minBundle, sumA));
      const fillNorm = fn ? fn[s] : 0;
      if (eMinOpt > 0 && fillNorm >= 0 && meta && st)
        row.eBar = barExtent(
          eMinOpt,
          Math.max(meta[s * st + 2] - meta[s * st], meta[s * st + 3] - meta[s * st + 1]),
        );
    }
    const fillNorm = fn ? fn[s] : 0;
    if (stats && meta && st) {
      const ns = stats.segs[s];
      if (bb > 0 && ns > 0) {
        const floor = minPx2PerSegFor(meta, st, s, stats, hardAll, hardMixed, fillNorm, isCpatch);
        if (floor > 0) row.loBar = Math.max(row.loBar, barFloor(floor, ns, bb));
      }
    }
    row.scaleFree = !(row.loBar > 0 || row.eBar > 0 || row.hiBar < Number.POSITIVE_INFINITY);
    rows.push(row);
  }
  return { rows, fillExtents, eMinOpt, shareOpt, minBundle, pinned, cpatchAuto, areaLimit };
}
/// A key that changes exactly when E_MIN's state does, for the pick cache.
export const eMinKey = (model, k2) => (model.eMinOpt > 0 ? (eMinActive(model, k2) ? 1 : 0) : 0);
/// Is E_MIN in force at unquantized unit px2 `k2`? At least `share` of the fill rows are under the extent bar. (Whether a row is under is E * sqrt(k2) < eMin.)
export function eMinActive(model, k2) {
  const { eMinOpt, shareOpt, fillExtents } = model;
  if (!(eMinOpt > 0) || !fillExtents.length) return false;
  const sc0 = Math.sqrt(Math.max(0, k2));
  let under = 0;
  for (let i = 0; i < fillExtents.length; i++) if (fillExtents[i] * sc0 < eMinOpt) under++;
  return under / fillExtents.length >= shareOpt;
}
/// THE CRITICAL UNIT PX2 VALUES of a bundle's pick inside [k2Lo, k2Hi]: every point at which the answer for the bundle's rows can change, read from the rows'
/// bars (and the E_MIN share rule's one crossing) -- no scale is sampled and the gate is not called at any size. Then only those whose effect reaches the
/// route's census (any row on a mesh, any on an AA cover quad, any on a hard cover quad) are kept: the ones the census does not see change nothing a
/// program key is built from. `rep` is a unit px2 strictly inside each interval, from its two analytic ends.
export function lbPickBreaks(model, k2Lo, k2Hi) {
  const { rows, fillExtents, eMinOpt, shareOpt } = model;
  const cuts = new Set();
  const add = (k) => {
    if (k > k2Lo && k < k2Hi && Number.isFinite(k)) cuts.add(k);
  };
  for (const r of rows) {
    if (r.always) continue;
    if (r.loBar > 0) add(k2AtLeast(r.loBar));
    if (r.eBar > 0) add(k2AtLeast(r.eBar));
    if (r.hiBar < Number.POSITIVE_INFINITY) add(k2Above(r.hiBar));
  }
  if (eMinOpt > 0 && fillExtents.length) {
    // active iff #{ extent * sqrt(k2) < eMin } >= share * fills: with the extents sorted, one crossing, at the need-th smallest extent's k2
    const need = Math.ceil(shareOpt * fillExtents.length - 1e-9);
    if (need >= 1 && need <= fillExtents.length) {
      const ex = fillExtents.slice().sort((a, b) => a - b)[fillExtents.length - need];
      if (ex > 0) add((eMinOpt / ex) * (eMinOpt / ex));
    }
  }
  const ks = [...cuts].sort((a, b) => a - b);
  const bounds = [k2Lo, ...ks, k2Hi];
  const census = (k2) => {
    const sc = bucketScale(pickBucket(k2)),
      ea = eMinActive(model, k2);
    let mesh = 0,
      cov = 0,
      hardCov = 0;
    for (const r of model.rows) {
      if (rowMeshed(r, sc, ea)) mesh = 1;
      else if (r.hard) hardCov = 1;
      else cov = 1;
    }
    return mesh | (cov << 1) | (hardCov << 2);
  };
  const out = [];
  let prev = null;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const rep = Math.sqrt(bounds[i] * bounds[i + 1]),
      c = census(rep);
    if (prev !== null && c !== prev) out.push({ k2: bounds[i], census: c });
    prev = c;
  }
  return { breaks: out, intervals: bounds.length - 1 };
}
export function lbShapePicks(R, bundle, meshes) {
  if (!bundle || !meshes) return null;
  const k2 = unitPx2(R, bundle);
  const bucket = pickBucket(k2);
  const gen = bundle._geomGen | 0;
  const c = bundle._lbPickCache;
  const eMinOpt =
    R && R.opts
      ? R.opts.lbMinExtentPx != null
        ? Math.max(0, +R.opts.lbMinExtentPx)
        : LB_MIN_EXTENT_PX
      : 0;
  const shareOpt =
    R && R.opts && R.opts.lbMinExtentShare != null ? +R.opts.lbMinExtentShare : LB_MIN_EXTENT_SHARE;
  // The bundle's size term, per renderer (option lbMinBundlePx2; unset = the constant, or the debug hook that replaces it; 0 turns it off).
  const minBundle =
    R && R.opts && R.opts.lbMinBundlePx2 != null ? +R.opts.lbMinBundlePx2 : minBundlePx2();
  const cpatchAuto = !!(R && R.opts && R.opts.cpatchAuto === true && !(bundle && bundle._morphSrc));
  const pinned = !!(R && R.opts && R.opts.cpatchFill === true && bundle._cpatchBuilt);
  const areaLimit = areaMaxCurvePx2();
  // Whole-bundle no-AA (every fill covered) and the per-row MIXED census are separate answers with
  // separate floors. Asked once per recompute, never per row.
  const hardAll = !!(R && R._preferNoAa && R._preferNoAa(bundle));
  const hardMixed = !hardAll && !!(R && R._preferNoAaMixed && R._preferNoAaMixed(bundle));
  const hard = (hardAll ? 2 : 0) | (hardMixed ? 1 : 0);
  // E_MIN (option lbMinExtentPx, default 8 px; 0 = off): an AUTO row whose device extent E = max(w, h) em * sqrt(px2 per em2) is
  // under it keeps its cover quad instead of its mesh. Scale-dependent, so it is in the pick key and the bundle is not scale-free.
  // Moving rows onto the cover kernel inside the unified draw pays the cover kernel's presence cost across the draw, so it applies
  // only where at least lbMinExtentShare (default 0.1) of the fill rows are under it.
  const sig =
    ruleSig() +
    '|' +
    minBundle +
    '|' +
    (cpatchAuto ? 1 : 0) +
    '|' +
    (pinned ? 1 : 0) +
    '|' +
    eMinOpt +
    '|' +
    shareOpt +
    '|' +
    canvasPx2Of(R);
  if (
    c &&
    c.gen === gen &&
    c.meshes === meshes &&
    c.sig === sig &&
    c.hard === hard &&
    c.model &&
    (c.scaleFree || c.bucket === bucket) &&
    (!(c.model.eMinOpt > 0) || c.eKey === eMinKey(c.model, k2))
  ) {
    // The diagnostic must describe the draw that HAPPENED, and most draws answer from this cache.
    // Left to the last recompute it reported another bundle's count for every cached one.
    c.k2 = k2;
    R._lbAutoPicked = c.any | 0;
    return c.picks;
  }
  const model =
    c && c.model && c.gen === gen && c.meshes === meshes && c.sig === sig && c.hard === hard
      ? c.model
      : lbPickRows(R, bundle, meshes, hardAll, hardMixed);
  const scale = bucketScale(bucket);
  const eActive = eMinActive(model, k2);
  const picks = new Uint8Array(bundle.numShapes | 0);
  let any = 0,
    scaleFree = true;
  for (const row of model.rows) {
    if (!row.always && !row.scaleFree) scaleFree = false;
    if (rowMeshed(row, scale, eActive)) {
      picks[row.s] = 1;
      any++;
    }
  }
  const prev = c && c.picks;
  // A pinned bundle answers null: every mesh draws.
  const result = !pinned && any ? picks : null;
  const same =
    prev === result ||
    (prev && result && prev.length === result.length && prev.every((v, i) => v === result[i]));
  if (!same) bundle._lbPickKey = (bundle._lbPickKey | 0) + 1;
  bundle._lbPickCache = {
    gen,
    meshes,
    bucket,
    scaleFree,
    sig,
    hard,
    k2,
    model,
    eKey: eMinKey(model, k2),
    any,
    picks: same ? prev : result,
  };
  R._lbAutoPicked = any;
  return same ? prev : result;
}
