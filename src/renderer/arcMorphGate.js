// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcMorphGate.js -- The Loop-Blinn GPU morph and the CPatch morph build from the two poses' CENTER-form curve planes and lerp control points. SVG path
// animation interpolates an arc's own numbers (rx, ry, rotation, end points) and normalizes the radii at each pose (src/core/morphCore.js: the CPU-lerp
// path, exact). The two agree only where one pose's arc is the other's scaled and moved: same rotation, same radii ratio, same F.6.6 factor and the same angles on
// the ellipse, which covers its flags. Any other pair (an ellipse turning, a pill authored with a too-small radius, a chord that changes against its radius) is sent to
// the CPU-lerp (Slug) route instead. The rotation is compared as the number it is: an ellipse turned by pi is the same ellipse, and it still spins on its way there.
// A circle growing and a rect's corners stay on the GPU lerp. Under arcRotation: 'shortest' a half turn spells the same ellipse, so it does not turn.
// Pure and scale free: angles and ratios, no distance.
import { arcRecordFlags } from '../core/morphCore.js';

export function arcPairNeedsCpuLerp(ca, cb, o, shortest = false) {
  const rs0 = Math.max(Math.abs(ca[o + 11]), 1),
    rs1 = Math.max(Math.abs(cb[o + 11]), 1); // w's sign is a half turn's large mark
  const q0 = ca[o + 6] / (ca[o + 7] || 1),
    q1 = cb[o + 6] / (cb[o + 7] || 1);
  // the half turns the rotation is off by, under 'shortest'; then the start on the ellipse is off by the same
  const halves = shortest ? Math.round((cb[o + 10] - ca[o + 10]) / Math.PI) : 0;
  if (
    Math.abs(cb[o + 10] - ca[o + 10] - halves * Math.PI) > 1e-4 ||
    Math.abs(rs0 - rs1) > 1e-6 * Math.max(rs0, rs1) ||
    Math.abs(q0 - q1) > 1e-6 * Math.max(Math.abs(q0), Math.abs(q1), 1e-30)
  )
    return true;
  // A line at both poses on one zero axis has no flags to tell apart.
  if ((ca[o + 6] === 0 && cb[o + 6] === 0) || (ca[o + 7] === 0 && cb[o + 7] === 0)) return false;
  if (arcRecordFlags(ca, o) !== arcRecordFlags(cb, o)) return true;
  // The sweep, and where it starts on the ellipse (one angle has many spellings).
  const turn = Math.PI * 2,
    start = (ca[o + 8] - cb[o + 8] + halves * Math.PI) / turn;
  return (
    Math.abs(ca[o + 9] - ca[o + 8] - (cb[o + 9] - cb[o + 8])) > 1e-4 ||
    Math.abs(start - Math.round(start)) * turn > 1e-4
  );
}

export function arcMorphNeedsCpuLerp(ms) {
  if (!ms || !ms.arcOffsets || !ms.arcOffsets.length) return false;
  const ca = ms.mergedCurveF32,
    cb = ms.dstCurveF32;
  if (!ca || !cb) return true;
  for (let i = 0; i < ms.arcOffsets.length; i++)
    if (arcPairNeedsCpuLerp(ca, cb, ms.arcOffsets[i], ms.arcRotationShortest)) return true;
  return false;
}
