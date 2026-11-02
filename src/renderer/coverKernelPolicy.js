// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverKernelPolicy — which cover-quad kernel shades the rows Loop-Blinn did NOT take.

// What it decides. Slug and AAC consume the same band data from the same cover quad and differ only
// in how they integrate coverage, so choosing between them is a speed question about this draw --
// unlike the analytic engines, which are selected by the presence of geometry (fillPass,
// variantDefinesFor, rules 1 and 2). One program serves a whole bundle, so exactly one kernel wins.
//
// What the thresholds are. AAC's cost is a big fragment kernel (register pressure) paid once per
// FRAGMENT, so its win is governed by fragments per shape, in device pixels -- never px^2 per
// segment, which is the LB currency and is non-monotone for arcs here. The constants are the fitted
// ones.
//
// ...AND IN A UNIFIED DRAW, WHAT THE KERNEL'S PRESENCE COSTS. There most fragments are Loop-Blinn meshes
// the cover kernel never shades, and they pay its register allocation all the same, so the unified route
// asks aacPresenceTerms instead: the cover rows' saving against the presence on everything else.

/// Minimum device px^2 a shape must cover before AAC's kernel amortizes, per segment type.
/// Both quadratic and cubic are curve types whose per-segment Slug walk is what AAC's area kernel replaces.
/// Arc is asked of arc ROWS rather than of every bundle that happens to contain one.
export const AAC_MIN_PX2 = [
  512, // line
  3e3, // quadratic
  3e3, // cubic
  Number.POSITIVE_INFINITY, // arc
];

/// The device px^2 a row of these segment types must cover for AAC to pay. A row's walk visits its
/// own segments, so the bar is the maximum over the types it holds -- and over nothing else.
export function aacTypeFloor(types) {
  let need = 0;
  for (let t = 0; t < 4; t++) if (types & (1 << t)) need = Math.max(need, AAC_MIN_PX2[t]);
  return need;
}

/// Per-row AAC floor for a row's segment-type bitmask.
/// Note: `AAC_MIN_PX2[SEG_ARC]` is `Infinity` because the GPU arc area kernel (`aacArcContrib`) is slower
/// than the arc crossing solver at every size, regardless of boundary normalization (`fillNormByShape`).
export function aacRowFloor(types, _fillNorm = 0) {
  return aacTypeFloor(types);
}

/// THE CLASSIC AAC GATE AS DATA: AAC iff the mean fill-shape bbox in device px2 reaches the bundle floor, i.e. meanArea * k2 >= floor (k2 = unit px2, UNQUANTIZED).
/// `aacClassicPick` is the gate (fillPass preferAac, the instanced path's engine defines) and `aacClassicBar` is the unit px2 at which it flips: one definition.
export const aacClassicPick = (meanFillArea, floor, k2) => meanFillArea * k2 >= floor;
export const aacClassicBar = (meanFillArea, floor) =>
  meanFillArea > 0 && Number.isFinite(floor) ? floor / meanFillArea : Number.POSITIVE_INFINITY;
/// Bundle-level AAC floor used by the classic cover pass (`aacVoteShipped` and `fillPass`).
export function aacBundleFloor(bundle) {
  return aacTypeFloor((bundle && bundle.segTypeMask) | 0 || 0xf);
}

/// The classic route's rule, as a function a probe can ask without a GL context (fillPass computes the same
/// mean from the renderer's own px2): the mean bbox of every fill row against the maximum threshold over
/// every type in the bundle. (A unified draw is priced by aacPresenceTerms instead.)
export function aacVoteShipped(bundle, k2) {
  if (!bundle) return false;
  const meta = bundle.metaFloats,
    st = bundle.metaFloatsPerShape | 0,
    n = bundle.numShapes | 0;
  let sum = 0,
    cnt = 0;
  for (let s = 0; s < n; s++) {
    const b = s * st;
    if (!meta || !st || !(meta[b + 7] > 0)) continue;
    cnt++;
    const w = meta[b + 2] - meta[b],
      h = meta[b + 3] - meta[b + 1];
    if (w > 0 && h > 0) sum += w * h;
  }
  const px2 = cnt ? (sum / cnt) * k2 : 0;
  return px2 >= aacBundleFloor(bundle);
}

/// WHAT each ROW OF A UNIFIED DRAW IS, for the presence model below (unifiedFillDraw._unifiedRowClasses):
/// a fill row drawn as a cover quad the AA kernel shades, one drawn as a cover quad with a hard per-row id,
/// a row its Loop-Blinn / CPatch / primitive mesh draws, and a cover quad no fill kernel shades (a stroke
/// row, or a fill row with no fill). ROW_NONE: the draw does not paint the row.
export const ROW_NONE = 0,
  ROW_COVER_AA = 1,
  ROW_COVER_HARD = 2,
  ROW_MESH = 3,
  ROW_OTHER_QUAD = 4;

/// The presence model. Compiling AAC into a program costs every fragment of the draw (registers are allocated
/// per program, so occupancy drops for fragments that never enter the kernel); it pays back only on the
/// fragments it shades. So, per unified draw, with F the device px^2 of a row's bbox:
///
///   AAC  iff  sum over AA cover rows of F * (1 - rho)  >  PRESENCE * sum over every other painted row of F
///
export const AAC_PRESENCE = 0.2,
  AAC_RHO_ABOVE = 0.78,
  AAC_RHO_BELOW = 1.11;

/// The model's two sides for one draw: `gain` (px^2 AAC saves on its rows) and `presence` (px^2 it costs the
/// rest). `cls` from _unifiedRowClasses; `types` per row (shapeSegStats(bundle).types) or null for the bundle
/// mask; `k2` the em^2 -> device px^2 factor (shapeScale.unitPx2).
export function aacPresenceTerms(bundle, cls, types, k2) {
  const meta = bundle && bundle.metaFloats,
    st = (bundle && bundle.metaFloatsPerShape) | 0;
  let gain = 0,
    other = 0,
    rows = 0;
  if (!meta || !st || !cls) return { gain, presence: 0, rows };
  const mask = bundle.segTypeMask | 0 || 0xf;
  const fn = bundle.fillNormByShape;
  for (let s = 0; s < cls.length; s++) {
    const c = cls[s];
    if (c === ROW_NONE) continue;
    const b = s * st,
      w = meta[b + 2] - meta[b],
      h = meta[b + 3] - meta[b + 1];
    const px2 = w > 0 && h > 0 ? w * h * k2 : 0;
    if (c !== ROW_COVER_AA) {
      other += px2;
      continue;
    }
    rows++;
    const floor = aacRowFloor((types && types[s]) || mask, fn ? fn[s] : 0);
    gain += px2 * (px2 >= floor ? 1 - AAC_RHO_ABOVE : 1 - AAC_RHO_BELOW);
  }
  return { gain, presence: AAC_PRESENCE * other, rows };
}

/// THE PRESENCE MODEL AS DATA. gain = k2 * sum over AA cover rows of area * (0.22 above the row's floor, -0.11 below), presence = 0.2 * k2 * sum of the other rows' area: k2 cancels,
/// so the verdict is `G(k2) > P` with G a staircase that only RISES (each row steps from -0.11 area to +0.22 area at k2 = floor / area). The pick therefore flips at most once, at the
/// first row threshold where G passes P. Returns { always, never, k2 }: AAC at every k2 (`always`), at none (`never`), or for k2 >= `k2` (unit px2). No scale is sampled.
export function aacPresenceBreak(bundle, cls, types) {
  const meta = bundle && bundle.metaFloats,
    st = (bundle && bundle.metaFloatsPerShape) | 0;
  if (!meta || !st || !cls) return { always: false, never: true, k2: Number.POSITIVE_INFINITY };
  const mask = bundle.segTypeMask | 0 || 0xf,
    fn = bundle.fillNormByShape;
  let other = 0,
    g0 = 0;
  const rows = [];
  for (let s = 0; s < cls.length; s++) {
    const c = cls[s];
    if (c === ROW_NONE) continue;
    const b = s * st,
      w = meta[b + 2] - meta[b],
      h = meta[b + 3] - meta[b + 1],
      area = w > 0 && h > 0 ? w * h : 0;
    if (c !== ROW_COVER_AA) {
      other += area;
      continue;
    }
    const floor = aacRowFloor((types && types[s]) || mask, fn ? fn[s] : 0);
    rows.push([area > 0 ? floor / area : Number.POSITIVE_INFINITY, area]);
    g0 += area * (1 - AAC_RHO_BELOW); // below its floor a row costs 0.11 * area
  }
  if (!rows.length) return { always: false, never: true, k2: Number.POSITIVE_INFINITY };
  const P = AAC_PRESENCE * other;
  let g = g0;
  if (g > P) return { always: true, never: false, k2: 0 };
  rows.sort((p, q) => p[0] - q[0]);
  for (const [t, a] of rows) {
    g += a * (1 - AAC_RHO_ABOVE - (1 - AAC_RHO_BELOW));
    if (g > P)
      return Number.isFinite(t)
        ? { always: false, never: false, k2: t }
        : { always: false, never: true, k2: Number.POSITIVE_INFINITY };
  }
  return { always: false, never: true, k2: Number.POSITIVE_INFINITY };
}

/// The verdict: AAC is worth its presence in this draw.
export function aacPaysPresence(bundle, cls, types, k2) {
  const t = aacPresenceTerms(bundle, cls, types, k2);
  return t.rows > 0 && t.gain > t.presence;
}
