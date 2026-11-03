// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphArcBounds.js -- the exact extent of a morphing arc at pose t.
//
// A morph lerps each arc in ENDPOINT form (end points, rx, ry, rotation: morphCore.prepareArcMorph), and the bbox
// slots of the meta row are a linear lerp of the two endpoint boxes. An arc's extent is not linear in t (the
// rotation and the F.6.6 radius scale move it along sines and a square root), so the lerped box can be smaller
// than the pose it bounds. The box a pose needs is the union of that lerp and the exact extent of every lerped
// arc of the row, which is analytic: the end points plus the axis extrema of the rotated ellipse that fall inside
// the sweep.
import { arcRecordToCenter } from './morphCore.js';

const TWO_PI = Math.PI * 2;
const _rec = new Float32Array(20);

// Per-morph-source lookup: row -> arc header offsets inside that row's curve range. Built once per source.
function arcsByRow(ms) {
  if (ms._arcsByRow !== undefined) return ms._arcsByRow;
  let map = null;
  const arcs = ms.arcOffsets,
    ranges = ms.curveRanges;
  if (arcs && arcs.length && ranges && ms.srcEpCurveF32 && ms.dstEpCurveF32) {
    for (let row = 0; row < ranges.length; row++) {
      const r = ranges[row];
      if (!r) continue;
      let list = null;
      for (let i = 0; i < arcs.length; i++)
        if (arcs[i] >= r.begin && arcs[i] < r.end) (list || (list = [])).push(arcs[i]);
      if (list) (map || (map = new Map())).set(row, list);
    }
  }
  ms._arcsByRow = map;
  return map;
}

/** True when the matched row `row` carries arcs that the morph lerps in endpoint form. */
export function morphRowHasArcs(ms, row) {
  const m = ms && arcsByRow(ms);
  return !!(m && m.has(row | 0));
}

// Is angle a inside the sweep th0 -> th1 (either direction)?
function inSweep(a, th0, dth) {
  if (dth >= 0) {
    let u = (a - th0) % TWO_PI;
    if (u < 0) u += TWO_PI;
    return u <= dth;
  }
  let u = (th0 - a) % TWO_PI;
  if (u < 0) u += TWO_PI;
  return u <= -dth;
}

/**
 * Grow `box` ([xmin, ymin, xmax, ymax]) to hold every arc of row `row` at pose `t`, padded by `pad` on every side
 * (half the stroke width on a stroke row, 0 on a fill row). Returns whether the row has arcs.
 */
export function unionMorphArcBounds(ms, row, t, pad, box) {
  const list = (arcsByRow(ms) || EMPTY).get(row | 0);
  if (!list) return false;
  const A = ms.srcEpCurveF32,
    B = ms.dstEpCurveF32,
    ti = 1 - t;
  const grow = (x, y) => {
    if (x - pad < box[0]) box[0] = x - pad;
    if (y - pad < box[1]) box[1] = y - pad;
    if (x + pad > box[2]) box[2] = x + pad;
    if (y + pad > box[3]) box[3] = y + pad;
  };
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    for (let k = 4; k < 12; k++) _rec[k] = A[o + k] * ti + B[o + k] * t;
    const step = ms.arcFlagSteps && ms.arcFlagSteps.get(o);
    if (step) _rec[11] = t < 0.5 ? step[0] : t > 0.5 ? step[1] : step[0] | step[1];
    grow(_rec[4], _rec[5]);
    grow(_rec[6], _rec[7]);
    arcRecordToCenter(_rec, 0);
    const cx = _rec[4],
      cy = _rec[5],
      rx = _rec[6],
      ry = _rec[7],
      th0 = _rec[8],
      dth = _rec[9] - _rec[8],
      phi = _rec[10];
    const cp = Math.cos(phi),
      sp = Math.sin(phi);
    // x(th) = cx + rx cos(th) cp - ry sin(th) sp, y(th) = cy + rx cos(th) sp + ry sin(th) cp: the extrema solve
    // tan(th) = -ry sp / (rx cp) for x and ry cp / (rx sp) for y, each repeating every pi.
    const ax = Math.atan2(-ry * sp, rx * cp),
      ay = Math.atan2(ry * cp, rx * sp);
    for (const a of [ax, ax + Math.PI, ay, ay + Math.PI]) {
      if (!inSweep(a, th0, dth)) continue;
      const c = Math.cos(a),
        s = Math.sin(a);
      grow(cx + rx * c * cp - ry * s * sp, cy + rx * c * sp + ry * s * cp);
    }
  }
  return true;
}
const EMPTY = new Map();

const _box = [0, 0, 0, 0];

/**
 * Widen the bbox slots 0..3 of the lerped meta row at float offset `base` in `meta` to hold the arcs of row `row` at
 * pose `t`. The pad is half the lerped stroke width on a stroke row (whose box is halfW padded) and 0 on a fill row.
 * A pose at t <= 0 or t >= 1 is an endpoint, whose box is already exact. Returns whether the row changed.
 */
export function widenMorphRowForArcs(ms, meta, base, row, t) {
  if (!(t > 0 && t < 1) || !morphRowHasArcs(ms, row)) return false;
  const so = row * (ms.metaStride | 0),
    src = ms.mergedMetaF32;
  const stroke = src[so + 11] > 0 && src[so + 12] > 0;
  _box[0] = meta[base];
  _box[1] = meta[base + 1];
  _box[2] = meta[base + 2];
  _box[3] = meta[base + 3];
  unionMorphArcBounds(ms, row, t, stroke ? meta[base + 12] * 0.5 : 0, _box);
  let changed = false;
  for (let k = 0; k < 4; k++)
    if (meta[base + k] !== _box[k]) {
      meta[base + k] = _box[k];
      changed = true;
    }
  return changed;
}
