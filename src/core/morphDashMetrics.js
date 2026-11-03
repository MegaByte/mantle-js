// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { segArcLen } from '../svg/textures.js';
import { arcRecordToCenter } from './morphCore.js';

// Preparation owns the record addresses and scratch storage. Per-pose work
// visits dashed matched rows only; it never reads the live GPU curve plane.
//
// Per segment the plan carries two numbers (values[2 i], values[2 i + 1]): its startDist at the pose, and -- on the first and the last segment of a
// CLOSED contour (svg/textures.js encodeSeg: the seam of a closed dashed contour carries its length L as -L in the free-end field) -- that
// contour's length L at the pose, 0 elsewhere. `flags[i]` says which: bit 0 the first segment of such a contour, bit 1 its last (both for a
// contour of one segment). A contour is one in EITHER pose; at the end poses the numbers are the end plane's own (a plane whose contour is not
// closed-dashed has 0 and keeps its lerped free-end fields, which at an end pose are its own).
export function prepareMorphDashMetrics(sections) {
  const rows = sections._dashMetricRows;
  if (!rows || !rows.length) return null;
  const source = sections._srcEpCurveF32 || sections._mergedCurveF32;
  const destination = sections._dstEpCurveF32 || sections._dstCurveF32;
  const total = rows.reduce((n, r) => n + r.offsets.length, 0);
  const flags = new Uint8Array(total);
  let anySeam = false,
    at = 0;
  for (const row of rows) {
    const offs = row.offsets;
    row.contours = []; // [first k, last k] of each contour that is closed-dashed in either pose
    let first = 0;
    for (let k = 0; k <= offs.length; k++) {
      if (k < offs.length && k > 0 && !startsContour(source, offs[k])) continue;
      if (k > 0) {
        const last = k - 1;
        const seam =
          (source[offs[first] + 1] < 0 && source[offs[last] + 2] < 0) ||
          (destination[offs[first] + 1] < 0 && destination[offs[last] + 2] < 0);
        if (seam) {
          row.contours.push([first, last]);
          flags[at + first] |= 1;
          flags[at + last] |= 2;
          anySeam = true;
        }
      }
      first = k;
    }
    at += offs.length;
  }
  return {
    rows,
    source,
    destination,
    record: new Float64Array(20),
    arcSet: new Set(sections._arcOffsets),
    flagSteps: sections._arcFlagSteps || null,
    values: new Float32Array(2 * total),
    flags,
    anySeam,
    seg: { type: 0, p1: [0, 0], p2: [0, 0], p3: [0, 0], p4: [0, 0] },
  };
}

// A header begins a contour when it is the row's first (the caller), carries the subpath-start bit, is a free start, or is the seam end of a
// closed dashed contour (a negative free-start field: svg/textures.js encodeSeg).
function startsContour(plane, off) {
  return (plane[off] & 8) !== 0 || plane[off + 1] > 0.5 || plane[off + 1] < 0;
}

export function updateMorphDashMetrics(plan, t, target = null) {
  const { source, destination, record, seg, values, flags } = plan;
  let index = 0;
  if (t === 0 || t === 1) {
    const endpoint = t === 0 ? source : destination;
    for (const row of plan.rows) {
      for (const off of row.offsets) {
        values[2 * index] = endpoint[off + 3];
        values[2 * index + 1] = 0;
        if (target) target[off + 3] = endpoint[off + 3];
        index++;
      }
      // the end plane's own seam lengths (its fields are in `target` already when it is the live plane's source of truth; a morph
      // lerps them, so the exact end value is written back)
      for (const [first, last] of row.contours) {
        const base = index - row.offsets.length;
        const fo = row.offsets[first],
          lo = row.offsets[last];
        if (endpoint[fo + 1] < 0 && endpoint[lo + 2] < 0) {
          values[2 * (base + first) + 1] = values[2 * (base + last) + 1] = -endpoint[fo + 1];
          if (target) {
            target[fo + 1] = endpoint[fo + 1];
            target[lo + 2] = endpoint[lo + 2];
          }
        }
      }
    }
    return values;
  }
  for (const row of plan.rows) {
    const offs = row.offsets,
      base = index;
    let distance = 0,
      seamFirst = -1,
      inSeam = false;
    for (let k = 0; k < offs.length; k++) {
      const off = offs[k],
        raw = source[off] | 0,
        type = raw & 3;
      const starts = k === 0 || startsContour(source, off);
      if (starts) {
        distance = 0;
        inSeam = false;
        seamFirst = -1;
        for (const c of row.contours)
          if (c[0] === k) {
            inSeam = true;
            seamFirst = k;
            break;
          }
      }
      values[2 * index] = distance;
      values[2 * index + 1] = 0;
      if (target) target[off + 3] = distance;
      index++;
      const nextStarts = k + 1 === offs.length || startsContour(source, offs[k + 1]);
      // The last segment's length is unused unless another segment follows -- or it ends a closed contour, whose length is the seam's.
      if (nextStarts && !inSeam) continue;
      const count = type === 0 ? 8 : type === 3 ? 16 : 12;
      for (let j = 0; j < count; j++)
        record[j] = source[off + j] * (1 - t) + destination[off + j] * t;
      if (type === 3 && plan.arcSet.has(off)) {
        const step = plan.flagSteps && plan.flagSteps.get(off);
        if (step) record[11] = t < 0.5 ? step[0] : t > 0.5 ? step[1] : step[0] | step[1];
        arcRecordToCenter(record, 0);
      }
      seg.type = type;
      if (type === 3) {
        seg.cx = record[4];
        seg.cy = record[5];
        seg.rx = record[6];
        seg.ry = record[7];
        seg.theta_start = record[8];
        seg.theta_end = record[9];
        seg.phi = record[10];
        seg.p1[0] = record[12];
        seg.p1[1] = record[13];
        seg.p4[0] = record[14];
        seg.p4[1] = record[15];
        seg.large_arc_flag = Math.abs(seg.theta_end - seg.theta_start) > Math.PI ? 1 : 0;
        seg.sweep_flag = seg.theta_end >= seg.theta_start ? 1 : 0;
      } else {
        for (let j = 0; j <= type + 1; j++) {
          const p = j === 0 ? seg.p1 : j === 1 ? seg.p2 : j === 2 ? seg.p3 : seg.p4;
          p[0] = record[4 + j * 2];
          p[1] = record[5 + j * 2];
        }
      }
      distance += segArcLen(seg, row.frame);
      if (nextStarts && inSeam) {
        // the contour ends here: its length goes to its first and its last segment, as the encoder writes it (-L in the free-end fields)
        const c = row.contours.find((q) => q[0] === seamFirst);
        const L = distance;
        values[2 * (base + c[0]) + 1] = values[2 * (base + c[1]) + 1] = L;
        if (target) {
          target[offs[c[0]] + 1] = -L;
          target[offs[c[1]] + 2] = -L;
        }
      }
    }
  }
  return values;
}
