// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { sampleMorphGradientParams } from '../core/morphImageFrames.js';
import { hasRetainedSvgSource } from '../core/exportSource.js';
import { updateVisibility } from '../core/morphCore.js';
import { uploadTableRows, GRAD_COLS } from '../renderer/tableLayout.js';
import { gradientStopsLutSize, padGradientStopsLut } from '../bundle/layout.js';
import { transformSegInto } from '../svg/transform.js';
import { morphFilterOpacity } from '../core/morphFilters.js';
import { sampleMorphPose } from '../core/morphPose.js';
import { updateDrivenGeometry } from '../renderer/streamGeometry.js';
import { createNativeOverrideTable } from '../fallback/nativeOverrideTable.js';
import { mkLine, mkQuad, mkCubic, mkArc, segsToPathD } from '../svg/segment.js';

// A driver samples authoring coordinates. Packed headers, distance tables and
// join tangents are regenerated from the resulting paths, never deformed.
export function curvePoseLayout(bundle, plane = null) {
  if (
    !bundle ||
    !bundle.metaFloats ||
    bundle.metaFloatsPerShape !== 48 ||
    !bundle.curveRangesByShape
  )
    return null;
  if (
    bundle.curveRangesByShape.some(
      (r, i) =>
        !(bundle.metaFloats[i * 48 + 27] & (64 | 128)) &&
        (!r || (r.end > r.begin && r.end - r.begin < 12)),
    )
  )
    return null;
  plane ||= bundle.curveFloats;
  if (!(plane instanceof Float32Array)) return null;
  const rows = [],
    coordinates = [];
  for (let row = 0; row < bundle.numShapes; row++) {
    if (bundle.metaFloats[row * 48 + 27] & (64 | 128)) {
      rows.push([]);
      continue;
    }
    const records = [],
      range = bundle.curveRangesByShape[row],
      curvature = bundle.metaFloats[row * 48 + 25] === 4 ? 4 : 0;
    for (let h = range.begin; h + 8 <= range.end;) {
      const type = plane[h] & 3,
        d = h + 4,
        count = type === 0 ? 4 : type === 1 ? 6 : type === 2 ? 8 : 12;
      const next = h + (type === 0 ? 12 : type === 3 ? 20 : 16) + curvature;
      if (next > range.end || !Number.isFinite(plane[h]))
        throw new Error('Invalid driven curve record');
      records.push({ h, d, type });
      // Arc data includes radii/angles; delta animation may alter these, while
      // skinning uses the arc's affine image rather than translating parameters.
      for (let i = 0; i < count; i++) coordinates.push(d + i);
      h = next;
    }
    rows.push(records);
  }
  return { rows, coordinates };
}

export function adoptCurvePose(gl, bundle, plane, layout, arcTransforms = null) {
  if (!layout) return false;
  const paths = layout.rows.map((records) =>
    records.flatMap(({ h, d, type }) => {
      let s;
      if (type === 0) s = mkLine([plane[d], plane[d + 1]], [plane[d + 2], plane[d + 3]]);
      else if (type === 1)
        s = mkQuad(
          [plane[d], plane[d + 1]],
          [plane[d + 2], plane[d + 3]],
          [plane[d + 4], plane[d + 5]],
        );
      else if (type === 2)
        s = mkCubic(
          [plane[d], plane[d + 1]],
          [plane[d + 2], plane[d + 3]],
          [plane[d + 4], plane[d + 5]],
          [plane[d + 6], plane[d + 7]],
        );
      else {
        const phi = plane[d + 6],
          cp = Math.cos(phi),
          sp = Math.sin(phi),
          rx = plane[d + 2],
          ry = plane[d + 3];
        // Refine the derivative from the stored endpoint only when re-encoding
        // keeps the exact same float32 arc. Cardinal tangents then retain zero
        // components instead of acquiring a sign from a rounded pi constant.
        const angle = (slot, old) => {
          if (!(rx > 0 && ry > 0)) return old;
          const x = plane[slot] - plane[d],
            y = plane[slot + 1] - plane[d + 1];
          let a = Math.atan2((-sp * x + cp * y) / ry, (cp * x + sp * y) / rx);
          a += 2 * Math.PI * Math.round((old - a) / (2 * Math.PI));
          return Math.fround(a) === old ? a : old;
        };
        const start = angle(d + 8, plane[d + 4]),
          end = angle(d + 10, plane[d + 5]);
        s = mkArc(
          plane[d],
          plane[d + 1],
          rx,
          ry,
          start,
          end,
          phi,
          Math.abs(end - start) > Math.PI,
          end >= start,
          [plane[d + 8], plane[d + 9]],
          [plane[d + 10], plane[d + 11]],
        );
      }
      if (plane[h] & 4) s.is_fill_only = true;
      if ((plane[h] | 0) & 8) s.subStart = true;
      if (plane[h + 2] > 0.5 && plane[h + 2] < 1.5) s.openEnd = true; // (2 is the seam of a closed dashed contour drawn the spec's way: still closed)
      if (type === 3 && arcTransforms?.has(h)) {
        const out = [];
        transformSegInto(s, arcTransforms.get(h), out);
        return out;
      }
      return [s];
    }),
  );
  const result = updateDrivenGeometry(gl, bundle, paths);
  if (!result.ok) throw new Error('Cannot adopt driven geometry: ' + result.reason);
  if (bundle.svgSource || hasRetainedSvgSource(bundle.__exportMorph?.srcBundle)) {
    const ds = paths.map((segs, i) =>
      bundle.metaFloats[i * 48 + 27] & (64 | 128) ? null : segsToPathD(segs),
    );
    if (bundle.__exportMorph) bundle.__exportMorph.currentPaths = ds;
    if (bundle.svgSource) {
      const table = bundle.__nativeDrivenOverrides || createNativeOverrideTable(bundle);
      bundle.__nativeDrivenOverrides = table;
      bundle.__nativeMorphOverrides = table;
      for (let i = 0; i < ds.length; i++) if (ds[i] != null) table.update(i, { pathD: ds[i] });
    }
  }
  bundle._morphSrc = null;
  return true;
}

export function sampleDrivenPaint(gl, morph, source, t) {
  const bundle = morph.bundle;
  bundle._morphSrc = source;
  source.t = t;
  updateVisibility(morph.overrides, morph.plan, t);
  const pose = sampleMorphPose(bundle);
  bundle.metaFloats.set(pose.meta);
  if (bundle.__exportMorph)
    Object.defineProperty(bundle.__exportMorph, 't', { get: () => source.t, configurable: true });
  if (source.gradientParamPlan?.length) {
    const data = (source.drivenGradientParams ||= new Float32Array(source.gradientParams.length));
    sampleMorphGradientParams(
      data,
      source.gradientParams,
      source.targetGradientParams,
      source.gradientParamPlan,
      t,
    );
    bundle.gradientFloats = data;
    gl.bindTexture(gl.TEXTURE_2D, bundle.gradientTex);
    uploadTableRows(gl, GRAD_COLS, 0, data.length / 16 - 1, data);
  }
  if (source.gradientStopPlan?.length) {
    const data = (source.drivenGradientStops ||= new Uint8Array(source.gradientStops.length));
    data.set(source.gradientStops);
    for (const row of source.gradientStopPlan)
      for (let k = 0; k < row.byteLength; k++) {
        const i = row.srcByteOffset + k;
        data[i] =
          (source.gradientStops[i] * (1 - t) +
            source.targetGradientStops[row.dstByteOffset + k] * t +
            0.5) |
          0;
      }
    bundle.gradientStopsBytes = data;
    const [w, h] = gradientStopsLutSize(data.length >>> 2);
    gl.bindTexture(gl.TEXTURE_2D, bundle.gradientStopsTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      w,
      h,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      padGradientStopsLut(data),
    );
  }
  const opacity = (bundle._drivenFilterOpacities ||= new Map());
  for (const [row, pair] of source.filterOpacityPairs || [])
    opacity.set(row, morphFilterOpacity(pair, t));
  return pose;
}
