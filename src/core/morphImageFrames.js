// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Image morphs interpolate the forward UV frame. Mixing its inverse changes
// the image motion and cannot represent a transition through a singular frame.
function writeInverse(out, base, a, b, c, d, e, f) {
  const determinant = a * d - b * c;
  if (!(Math.abs(determinant) > 1e-12 * (Math.abs(a * d) + Math.abs(b * c)))) {
    out.fill(0, base + 4, base + 10);
    out[base + 8] = out[base + 9] = 2;
    return;
  }
  out[base + 4] = d / determinant;
  out[base + 5] = -b / determinant;
  out[base + 6] = -c / determinant;
  out[base + 7] = a / determinant;
  out[base + 8] = (c * f - d * e) / determinant;
  out[base + 9] = (b * e - a * f) / determinant;
}

export function imageUvFrame(bundle, row, slot, stride) {
  const o = row * stride,
    id = bundle.metaFloats[o + slot];
  const rect = bundle.metaFloats.subarray(o + 36, o + 40);
  let a = 1,
    b = 0,
    c = 0,
    d = 1,
    e = 0,
    f = 0;
  if (id > 0) {
    const p = bundle.gradientFloats,
      base = (id - 1) * 16;
    if (!p || base + 16 > p.length) return null;
    const ia = p[base + 4],
      ib = p[base + 5],
      ic = p[base + 6],
      id_ = p[base + 7],
      ie = p[base + 8],
      iff = p[base + 9];
    const det = ia * id_ - ib * ic;
    if (!(Math.abs(det) > 1e-12 * (Math.abs(ia * id_) + Math.abs(ib * ic)))) return null;
    a = id_ / det;
    b = -ib / det;
    c = -ic / det;
    d = ia / det;
    e = (ic * iff - id_ * ie) / det;
    f = (ib * ie - ia * iff) / det;
  }
  return [
    a * rect[2],
    b * rect[2],
    c * rect[3],
    d * rect[3],
    a * rect[0] + c * rect[1] + e,
    b * rect[0] + d * rect[1] + f,
  ];
}

export function prepareMorphImageFrames(src, dst, plan, meta, targetMeta, stride, paint) {
  const frames = [];
  for (const match of plan.matched) {
    const source = match.srcIdx * stride,
      target = match.dstIdx * stride;
    // Both image roles share imageRect. An image/solid transition keeps the
    // source binding, as before; only matching image roles have two frames.
    for (const slot of [28, 29]) {
      const imageSlot = slot === 28 ? 35 : 47;
      if (!(src.metaFloats[source + imageSlot] > 0 && dst.metaFloats[target + imageSlot] > 0))
        continue;
      const aId = src.metaFloats[source + slot],
        bId = dst.metaFloats[target + slot];
      if (!aId && !bId) continue;
      if (aId && bId) {
        const ap = src.gradientFloats,
          bp = dst.gradientFloats,
          ab = (aId - 1) * 16,
          bb = (bId - 1) * 16;
        if ([4, 5, 6, 7, 8, 9].every((k) => ap[ab + k] === bp[bb + k])) continue;
      }
      const a = imageUvFrame(src, match.srcIdx, slot, stride),
        b = imageUvFrame(dst, match.dstIdx, slot, stride);
      if (a && b) frames.push({ address: source + slot, row: source, a, b });
    }
  }
  if (!frames.length) return paint;
  const count = paint.params.length / 16,
    params = new Float32Array((count + frames.length) * 16),
    targetParams = new Float32Array(params.length);
  params.set(paint.params);
  targetParams.set(paint.targetParams);
  const stops = new Uint8Array(paint.stops.length + 4),
    targetStops = new Uint8Array(paint.targetStops.length + 4);
  stops.set(paint.stops);
  targetStops.set(paint.targetStops);
  stops.fill(255, paint.stops.length);
  targetStops.fill(255, paint.targetStops.length);
  const paramPlan = paint.paramPlan.slice();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i],
      base = (count + i) * 16;
    params[base + 10] = targetParams[base + 10] = paint.stops.length / 4;
    params[base + 11] = targetParams[base + 11] = -1;
    writeInverse(params, base, ...frame.a);
    writeInverse(targetParams, base, ...frame.b);
    meta[frame.address] = count + i + 1;
    meta.set([0, 0, 1, 1], frame.row + 36);
    targetMeta.set([0, 0, 1, 1], frame.row + 36);
    paramPlan.push({ baseF: base, lerpSlots: [], imageFrames: [frame.a, frame.b] });
  }
  return { ...paint, params, targetParams, stops, targetStops, paramPlan };
}

export function sampleMorphGradientParams(out, source, target, plan, t) {
  out.set(source);
  const ti = 1 - t;
  for (const row of plan) {
    for (const slot of row.lerpSlots) {
      const i = row.baseF + slot;
      out[i] = source[i] * ti + target[i] * t;
    }
    if (row.imageFrames) {
      const [a, b] = row.imageFrames;
      writeInverse(
        out,
        row.baseF,
        a[0] * ti + b[0] * t,
        a[1] * ti + b[1] * t,
        a[2] * ti + b[2] * t,
        a[3] * ti + b[3] * t,
        a[4] * ti + b[4] * t,
        a[5] * ti + b[5] * t,
      );
    }
  }
  return out;
}
