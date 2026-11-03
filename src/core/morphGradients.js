// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

const EMPTY_FLOATS = new Float32Array(0),
  EMPTY_BYTES = new Uint8Array(0);
const EMPTY = {
  params: EMPTY_FLOATS,
  targetParams: EMPTY_FLOATS,
  stops: EMPTY_BYTES,
  targetStops: EMPTY_BYTES,
  paramPlan: [],
  stopPlan: [],
  steps: [],
};
const PARAM_SLOTS = [3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15];

// A stop list packs one texel per stop (count < 0: opaque, offsets multiples of 1/255) or two (count > 0), so two gradients with the
// same number of stops can sit in different layouts. The morph lerps bytes, which needs one layout for both ends: the two-texel one holds
// everything the one-texel one does, losslessly (the color gains alpha 255, the 8-bit offset becomes the high byte of the 24-bit one, which
// decodes by the same formula).
function expandOneTexel(bytes, begin, n) {
  const out = new Uint8Array(n * 8);
  for (let k = 0; k < n; k++) {
    const from = begin + k * 4,
      to = k * 8;
    out[to] = bytes[from];
    out[to + 1] = bytes[from + 1];
    out[to + 2] = bytes[from + 2];
    out[to + 3] = 255;
    out[to + 4] = bytes[from + 3];
  }
  return out;
}

// A gradient row paints stops * row color, its row color white; a solid row paints its color. A pair of the two has no table to lerp, so the side with no gradient gets the
// other's record with every stop white: it reads as its own color at its own end, and the stops and the color lerp across. (A table holding opaque white loses nothing.)
function whiteStops(bytes, begin, count) {
  const stride = count < 0 ? 4 : 8,
    out = bytes.slice(begin, begin + Math.abs(count) * stride);
  for (let k = 0; k < out.length; k += stride) {
    out[k] = out[k + 1] = out[k + 2] = 255;
    if (count > 0) out[k + 3] = 255;
  }
  return out;
}

// Gradient IDs are local to each input. Match paint claims, not table indices.
export function prepareMorphGradients(src, dst, plan, meta, stride) {
  const source = src.gradientFloats || EMPTY_FLOATS;
  const target = dst.gradientFloats || EMPTY_FLOATS;
  const sourceStops = src.gradientStopsBytes || EMPTY_BYTES;
  const targetStops = dst.gradientStopsBytes || EMPTY_BYTES;
  if (!source.length && !target.length) return EMPTY;
  const valid = (table, id) => Number.isInteger(id) && id > 0 && id * 16 <= table.length;
  const matched = new Map(plan.matched.map((m) => [m.srcIdx, m.dstIdx]));
  const requests = new Map(),
    claims = new Map(),
    endSteps = [];
  // (an image or a pattern carrier paints from its own texel: no plain color to pair a gradient with)
  const plainRow = (plane, row, slot) =>
    !(plane[row * stride + (slot === 28 ? 35 : 47)] > 0) &&
    Math.round(plane[row * stride + 43]) !== 2;
  for (let row = 0; row < src.numShapes; row++)
    for (const slot of [28, 29]) {
      if (src.metaFloats[row * stride + (slot === 28 ? 35 : 47)] > 0) continue;
      const id = src.metaFloats[row * stride + slot];
      const destRow = matched.get(row);
      const to = destRow === undefined ? 0 : dst.metaFloats[destRow * stride + slot];
      if (!valid(source, id)) {
        if (
          destRow === undefined ||
          !valid(target, to) ||
          !plainRow(src.metaFloats, row, slot) ||
          !Math.round(target[(to - 1) * 16 + 11])
        )
          continue;
        const key = 'solid:' + to;
        let request = requests.get(key);
        if (!request) {
          request = { id: 0, to, rows: [], fromSolid: true };
          requests.set(key, request);
        }
        request.rows.push(row * stride + slot);
        continue;
      }
      const toSolid =
        destRow !== undefined &&
        !valid(target, to) &&
        plainRow(dst.metaFloats, destRow, slot) &&
        !!Math.round(source[(id - 1) * 16 + 11]);
      if (toSolid) {
        const key = id + ':solid';
        let uses = claims.get(id);
        if (!uses) {
          uses = new Set();
          claims.set(id, uses);
        }
        uses.add(key);
        let request = requests.get(key);
        if (!request) {
          request = { id, to: 0, rows: [], toSolid: true, relayout: false };
          requests.set(key, request);
        }
        request.rows.push(row * stride + slot);
        continue;
      }
      const compatible = valid(target, to) && source[(id - 1) * 16] === target[(to - 1) * 16];
      const key = compatible ? id + ':' + to : '';
      // Nothing to lerp, a linear with a radial or two stop counts: the source's paint holds, and the destination's takes over at t = 1, as a clip or mask binding does.
      if (
        valid(target, to) &&
        (!compatible ||
          Math.abs(Math.round(source[(id - 1) * 16 + 11])) !==
            Math.abs(Math.round(target[(to - 1) * 16 + 11])))
      )
        endSteps.push({ row, slot, to });
      const sourceCount = Math.round(source[(id - 1) * 16 + 11]),
        targetCount = compatible ? Math.round(target[(to - 1) * 16 + 11]) : 0;
      const relayout =
        compatible &&
        sourceCount !== 0 &&
        targetCount !== 0 &&
        sourceCount !== targetCount &&
        Math.abs(sourceCount) === Math.abs(targetCount);
      let uses = claims.get(id);
      if (!uses) {
        uses = new Set();
        claims.set(id, uses);
      }
      uses.add(key);
      if (!key) continue;
      let request = requests.get(key);
      if (!request) {
        request = { id, to, rows: [], relayout };
        requests.set(key, request);
      }
      request.rows.push(row * stride + slot);
    }
  // Distinct placement records can share a packed stop slice.
  const spans = [];
  for (let i = 0; i < source.length / 16; i++) {
    const count = Math.round(source[i * 16 + 11]),
      begin = Math.round(source[i * 16 + 10]) * 4;
    const end = begin + Math.abs(count) * (count < 0 ? 4 : 8);
    if (end > begin) spans.push({ id: i + 1, begin, end });
  }
  spans.sort((a, b) => a.begin - b.begin || a.end - b.end);
  const sharedStops = new Set();
  let far = -1,
    owner = -1;
  for (const span of spans) {
    if (span.begin < far) {
      sharedStops.add(owner);
      sharedStops.add(span.id);
    }
    if (span.end > far) {
      far = span.end;
      owner = span.id;
    }
  }
  const paramChunks = [source],
    stopChunks = [sourceStops];
  let paramCount = source.length / 16,
    stopLength = sourceStops.length;
  const append = (table, bytes, id, expand = false, white = false) => {
    const record = table.slice((id - 1) * 16, id * 16);
    const count = Math.round(record[11]),
      begin = Math.round(record[10]) * 4;
    let length = Math.abs(count) * (count < 0 ? 4 : 8);
    if (begin < 0 || begin + length > bytes.length)
      throw new Error('mantle: invalid morph gradient stop range');
    record[10] = stopLength / 4;
    if (expand && count < 0) {
      record[11] = -count;
      stopChunks.push(expandOneTexel(bytes, begin, -count));
      length = -count * 8;
    } else
      stopChunks.push(
        white ? whiteStops(bytes, begin, count) : bytes.subarray(begin, begin + length),
      );
    stopLength += length;
    paramChunks.push(record);
    return ++paramCount;
  };
  for (const request of requests.values()) {
    // A source in the one-texel layout facing a two-texel destination is rewritten in the wider one, in a record of its own.
    if (request.fromSolid) {
      request.output = append(target, targetStops, request.to, false, true);
      for (const address of request.rows) meta[address] = request.output;
      continue;
    }
    const widen = request.relayout && Math.round(source[(request.id - 1) * 16 + 11]) < 0;
    request.output =
      claims.get(request.id).size === 1 && !sharedStops.has(request.id) && !widen
        ? request.id
        : append(source, sourceStops, request.id, request.relayout);
    for (const address of request.rows) meta[address] = request.output;
  }
  const appended = new Map();
  for (let k = 0; k < plan.dstOnly.length; k++)
    for (const slot of [28, 29]) {
      const address = (src.numShapes + k) * stride + slot;
      const id = dst.metaFloats[plan.dstOnly[k].dstIdx * stride + slot];
      if (!valid(target, id)) continue;
      if (!appended.has(id)) appended.set(id, append(target, targetStops, id));
      meta[address] = appended.get(id);
    }
  const steps = endSteps.map(({ row, slot, to }) => {
    if (!appended.has(to)) appended.set(to, append(target, targetStops, to));
    return { row, slot, value: appended.get(to) };
  });
  const a = new Float32Array(paramCount * 16),
    sa = new Uint8Array(stopLength);
  let offset = 0;
  for (const chunk of paramChunks) {
    a.set(chunk, offset);
    offset += chunk.length;
  }
  offset = 0;
  for (const chunk of stopChunks) {
    sa.set(chunk, offset);
    offset += chunk.length;
  }
  const b = requests.size ? a.slice() : a,
    sb = requests.size ? sa.slice() : sa;
  const paramPlan = [],
    stopPlan = [];
  for (const request of requests.values()) {
    const base = (request.output - 1) * 16,
      targetBase = (request.to - 1) * 16;
    if (request.fromSolid || request.toSolid) {
      const count = Math.round(a[base + 11]),
        begin = Math.round(a[base + 10]) * 4,
        length = Math.abs(count) * (count < 0 ? 4 : 8);
      if (request.toSolid) sb.set(whiteStops(sa, begin, count), begin);
      else {
        const targetBegin = Math.round(target[targetBase + 10]) * 4;
        sb.set(targetStops.subarray(targetBegin, targetBegin + length), begin);
      }
      stopPlan.push({ srcByteOffset: begin, dstByteOffset: begin, byteLength: length });
      paramPlan.push({ baseF: base, lerpSlots: PARAM_SLOTS }); // (the same at both ends: the native morph reads this plan for which records tween)
      continue;
    }
    for (const slot of PARAM_SLOTS) b[base + slot] = target[targetBase + slot];
    paramPlan.push({ baseF: base, lerpSlots: PARAM_SLOTS });
    const count = Math.round(a[base + 11]),
      targetCount = Math.round(target[targetBase + 11]);
    if (
      !count ||
      !(count === targetCount || (request.relayout && Math.abs(count) === Math.abs(targetCount)))
    )
      continue;
    const length = Math.abs(count) * (count < 0 ? 4 : 8),
      targetLength = Math.abs(targetCount) * (targetCount < 0 ? 4 : 8);
    const begin = Math.round(a[base + 10]) * 4,
      targetBegin = Math.round(target[targetBase + 10]) * 4;
    if (targetBegin < 0 || targetBegin + targetLength > targetStops.length)
      throw new Error('mantle: invalid target morph gradient stop range');
    sb.set(
      targetCount < 0 && count > 0
        ? expandOneTexel(targetStops, targetBegin, -targetCount)
        : targetStops.subarray(targetBegin, targetBegin + length),
      begin,
    );
    stopPlan.push({ srcByteOffset: begin, dstByteOffset: begin, byteLength: length });
  }
  return { params: a, targetParams: b, stops: sa, targetStops: sb, paramPlan, stopPlan, steps };
}
