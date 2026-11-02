// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { rebuildMorphCurvatures } from './morphCurvatures.js';
import { updateMorphDashMetrics } from './morphDashMetrics.js';
import {
  applyArcFlagSteps,
  arcRecordToCenter,
  rebuildJoinTangents,
  restoreArcEndPoses,
} from './morphCore.js';
import { widenMorphRowForArcs } from './morphArcBounds.js';
const MORPH_LERP_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 21, 22, 23, 36, 37, 38, 39];
const _morphHitCache = new WeakMap();

/**
 * CPU pose for hit-testing a morphing bundle at its current `t`.
 * createShapeMorph updates GPU textures (and may skip CPU uploads entirely
 * on the LB route); hit tests read CPU curve/meta planes, so without this
 * they always evaluate the t=0 pose.
 */
export function sampleMorphPose(bundle) {
  const ms = bundle && bundle._morphSrc;
  if (!ms || !ms.mergedCurveF32 || !ms.dstCurveF32) return null;
  const t = +ms.t || 0;
  const gen = bundle._geomGen | 0;
  let c = _morphHitCache.get(bundle);
  if (
    c &&
    c.t === t &&
    c.gen === gen &&
    c.source === ms &&
    c.curve0 === ms.mergedCurveF32 &&
    c.curve1 === ms.dstCurveF32 &&
    c.meta0 === ms.mergedMetaF32 &&
    c.meta1 === ms.dstMetaF32
  )
    return c;
  // Composed glyph locations address band storage; native ranges exclude its
  // sentinel/padding and also describe unmatched fixed geometry.
  const nativeRanges = Object.assign(
    [],
    bundle.curveRangesByShape || [],
    ms.fixedCurveRanges || [],
    ms.curveRanges || [],
  );
  const identity = {
    t,
    gen,
    source: ms,
    gradientScratch: c?.gradientScratch || null,
    curve0: ms.mergedCurveF32,
    curve1: ms.dstCurveF32,
    meta0: ms.mergedMetaF32,
    meta1: ms.dstMetaF32,
  };
  // Fixed fades need no interpolated CPU plane; visibility is in overrides.
  const fixed = ms.matchedSrcIdxs && ms.matchedSrcIdxs.length === 0;
  if (!(t > 0) || fixed) {
    const pose = {
      ...identity,
      curve: ms.mergedCurveF32,
      meta: ms.mergedMetaF32,
      ranges: nativeRanges,
      owned: false,
    };
    _morphHitCache.set(bundle, pose);
    return pose;
  }

  const srcC =
    ms.srcEpCurveF32 && ms.arcOffsets && ms.arcOffsets.length
      ? ms.srcEpCurveF32
      : ms.mergedCurveF32;
  const dstC =
    ms.dstEpCurveF32 && ms.arcOffsets && ms.arcOffsets.length ? ms.dstEpCurveF32 : ms.dstCurveF32;
  const curve =
    c && c.owned && c.curve && c.curve.length === srcC.length
      ? c.curve
      : new Float32Array(srcC.length);
  curve.set(srcC);
  // Unmatched records are fixed even at t=1; overrides own their visibility.
  const ranges = ms.curveRanges || [];
  const ti = 1 - t;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!r) continue;
    if (t >= 1) curve.set(dstC.subarray(r.begin, r.end), r.begin);
    else {
      for (let j = r.begin; j < r.end; j++) curve[j] = srcC[j] * ti + dstC[j] * t;
    }
  }
  if (ms.arcOffsets && ms.arcOffsets.length) {
    applyArcFlagSteps(curve, ms.arcFlagSteps, t);
    for (let i = 0; i < ms.arcOffsets.length; i++) arcRecordToCenter(curve, ms.arcOffsets[i]);
  }
  if (ms.joinTable && ms.joinTable.length) rebuildJoinTangents(curve, ms.joinTable);
  rebuildMorphCurvatures(curve, ms.curvatureRows);
  if (ms.dashMetricPlan) updateMorphDashMetrics(ms.dashMetricPlan, t, curve);
  restoreArcEndPoses(curve, ms.arcEndPoseRanges, t, ms.mergedCurveF32, ms.dstCurveF32);

  const srcM = ms.mergedMetaF32;
  const dstM = ms.dstMetaF32;
  const stride = ms.metaStride | 0;
  let meta = null;
  if (srcM && dstM && stride) {
    meta =
      c && c.owned && c.meta && c.meta.length === srcM.length
        ? c.meta
        : new Float32Array(srcM.length);
    meta.set(srcM);
    const idxs = ms.matchedSrcIdxs;
    if (idxs) {
      for (let k = 0; k < idxs.length; k++) {
        const base = idxs[k] * stride;
        for (let s = 0; s < MORPH_LERP_SLOTS.length; s++) {
          const o = base + MORPH_LERP_SLOTS[s];
          meta[o] = srcM[o] * ti + dstM[o] * t;
        }
        widenMorphRowForArcs(ms, meta, base, idxs[k], t);
      }
    } else {
      // Legacy callers without a matched-row list describe a fully matched plane.
      for (let o = 0; o < meta.length; o++) meta[o] = srcM[o] * ti + dstM[o] * t;
    }
    // Clip/mask bindings switch to the destination composition at t = 1 (morphBindings.js).
    if (ms.bindingSteps)
      for (const e of ms.bindingSteps)
        if (t >= (e.at ?? 1)) meta[e.row * stride + e.slot] = e.value;
  }

  const pose = {
    ...identity,
    curve,
    meta,
    ranges: nativeRanges,
    owned: true,
  };
  _morphHitCache.set(bundle, pose);
  return pose;
}
