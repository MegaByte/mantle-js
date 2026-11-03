// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { META_FLAGS_SHAPE, META_CLIP_ID, META_MASK_ID, FS_LAYER } from '../bundle/layout.js';
import { mantleWarn } from './diagnostics.js';

const CLIP_BEGIN = 2048,
  CLIP_END = 4096,
  MASK_BEGIN = 512,
  MASK_END = 1024;
const MARKERS = CLIP_BEGIN | CLIP_END | MASK_BEGIN | MASK_END;
const BINDING_SLOTS = [META_CLIP_ID, META_MASK_ID];

/// Clip/mask bindings are row indices, not quantities, so a morph cannot interpolate them. The
/// policy is explicit instead of an automatic coverage crossfade:
///
///   * A clip/mask child present in both poses morphs like any other matched row.
///   * A destination-only row binds the destination composition from t = 0 (it fades in as paint).
///   * A matched row whose destination binding differs from its source binding keeps the SOURCE
///     binding for t < 1 and takes the destination composition at t = 1 (`steps`). Children added
///     or removed by the destination therefore enter or leave the clip exactly at the endpoint.
///
/// Source row addresses never move. A destination run that is not already a contiguous, correctly
/// terminated run of merged rows is rebuilt from ALIAS rows appended after the merged plane:
/// metadata copies that share the original curve and band data, ordered and terminated as the
/// destination run is. Aliases of matched rows morph with their origin and follow its overrides.
///
/// Returns the (possibly expanded) planes plus:
///   aliases[origin]  alias rows that mirror the origin row,
///   sources[k]       { origin, dst } of alias row (originalN + k),
///   matched          alias rows whose destination row is a matched row (they morph),
///   steps            [{ row, slot, value }] bindings applied at t = 1.
export function composeMorphBindings(src, dst, plan, meta, aligned, stride) {
  const originalN = plan.finalShapeCount,
    toMerged = new Map(),
    matchedDst = new Set();
  for (const m of plan.matched) {
    toMerged.set(m.dstIdx, m.srcIdx);
    matchedDst.add(m.dstIdx);
  }
  for (let i = 0; i < plan.dstOnly.length; i++)
    toMerged.set(plan.dstOnly[i].dstIdx, src.numShapes + i);
  const none = { meta, aligned, aliases: [], sources: [], matched: [], steps: [] };

  const flags = (plane, row) => plane[row * stride + META_FLAGS_SHAPE] | 0;
  const layer = (plane, row, n) => row >= 0 && row < n && (flags(plane, row) & FS_LAYER) !== 0;
  const idAt = (plane, row, slot) => Math.round(plane[row * stride + slot]);
  // The importer gives every mask child its own mask's id in the mask slot (a self reference, not a
  // nested binding). Aliases keep that reference pointing at their own run.
  const ownerFirst = (plane, row) => {
    let first = row;
    while (first > 0 && !(flags(plane, first) & MASK_BEGIN) && layer(plane, first - 1, Infinity))
      first--;
    return first;
  };
  const selfMask = (plane, row) => idAt(plane, row, META_MASK_ID) - 1 === ownerFirst(plane, row);
  const extra = [],
    sources = [],
    aliases = [],
    matched = [],
    steps = [];
  const cache = new Map(),
    visiting = new Set();
  let dropped = 0;

  // The complete run starting at a destination layer row; null when it is not a well-formed run.
  function readRun(first, slot) {
    if (!layer(dst.metaFloats, first, dst.numShapes)) return null;
    const begin = slot === META_CLIP_ID ? CLIP_BEGIN : MASK_BEGIN,
      end = slot === META_CLIP_ID ? CLIP_END : MASK_END;
    if (!(flags(dst.metaFloats, first) & begin)) return [first];
    const rows = [];
    for (let row = first; row < dst.numShapes; row++) {
      if (!layer(dst.metaFloats, row, dst.numShapes)) return null;
      rows.push(row);
      if (flags(dst.metaFloats, row) & end) return rows;
    }
    return null;
  }

  // Merged-plane 1-based binding that reproduces a destination binding; 0 for none, null when
  // the destination run cannot be reproduced.
  function resolve(id, slot) {
    if (id <= 0) return 0;
    const first = id - 1,
      key = slot + ':' + first;
    if (visiting.has(key)) return null;
    if (cache.has(key)) return cache.get(key);
    const rows = readRun(first, slot);
    if (!rows) return null;
    const origin = toMerged.get(first),
      marker = slot === META_CLIP_ID ? CLIP_BEGIN | CLIP_END : MASK_BEGIN | MASK_END;
    const survives =
      origin !== undefined &&
      rows.every(
        (row, k) =>
          toMerged.get(row) === origin + k &&
          layer(meta, origin + k, originalN) &&
          (flags(meta, origin + k) & marker) === (flags(dst.metaFloats, row) & marker),
      );
    if (survives) {
      cache.set(key, origin + 1);
      return origin + 1;
    }
    if (rows.some((row) => !toMerged.has(row) || !layer(meta, toMerged.get(row), originalN)))
      return null;
    const start = originalN + extra.length;
    // Reserve the whole run before resolving nested bindings so they address stable rows.
    for (const row of rows) {
      const from = toMerged.get(row),
        index = originalN + extra.length;
      const data = meta.slice(from * stride, (from + 1) * stride);
      data[META_FLAGS_SHAPE] =
        (data[META_FLAGS_SHAPE] & ~MARKERS) | (flags(dst.metaFloats, row) & MARKERS);
      if (layer(dst.metaFloats, row, dst.numShapes) && selfMask(dst.metaFloats, row))
        data[META_MASK_ID] = start + 1;
      extra.push(data);
      sources.push({ origin: from, dst: row });
      (aliases[from] || (aliases[from] = [])).push(index);
      if (matchedDst.has(row)) matched.push(index);
    }
    cache.set(key, start + 1);
    visiting.add(key);
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      if (matchedDst.has(row)) continue; // stepped below, like every matched row
      const data = extra[start - originalN + k];
      for (const slot2 of BINDING_SLOTS) {
        if (slot2 === META_MASK_ID && selfMask(dst.metaFloats, row)) continue;
        const value = resolve(idAt(dst.metaFloats, row, slot2), slot2);
        data[slot2] = value ?? 0;
        if (value === null) dropped++;
      }
    }
    visiting.delete(key);
    return start + 1;
  }

  // Destination-only rows bind the destination composition from the start.
  for (let k = 0; k < plan.dstOnly.length; k++) {
    const row = plan.dstOnly[k].dstIdx,
      base = (src.numShapes + k) * stride;
    const isLayer = layer(dst.metaFloats, row, dst.numShapes);
    if (isLayer && selfMask(dst.metaFloats, row)) {
      const owner = toMerged.get(ownerFirst(dst.metaFloats, row));
      if (owner !== undefined) meta[base + META_MASK_ID] = owner + 1;
    }
    for (const slot of BINDING_SLOTS) {
      if (isLayer && slot === META_MASK_ID && selfMask(dst.metaFloats, row)) continue;
      const value = resolve(idAt(dst.metaFloats, row, slot), slot);
      meta[base + slot] = value ?? 0;
      if (value === null) dropped++;
    }
  }

  // Matched rows (and matched aliases, which resolution may append while this runs) take the
  // destination binding at t = 1 when it differs from the source binding they morph under.
  const pending = plan.matched.map((m) => ({ row: m.srcIdx, dst: m.dstIdx }));
  let unresolved = 0,
    queued = 0;
  const queueAliases = () => {
    while (queued < matched.length) {
      const index = matched[queued++];
      pending.push({ row: index, dst: sources[index - originalN].dst });
    }
  };
  queueAliases();
  for (let at = 0; at < pending.length; at++) {
    const { row, dst: dstRow } = pending[at];
    const data = row < originalN ? null : extra[row - originalN];
    for (const slot of BINDING_SLOTS) {
      if (slot === META_MASK_ID && selfMask(dst.metaFloats, dstRow)) continue;
      const current = Math.round(data ? data[slot] : meta[row * stride + slot]);
      const value = resolve(idAt(dst.metaFloats, dstRow, slot), slot);
      if (value === null) {
        unresolved++;
        continue;
      }
      if (value !== current) steps.push({ row, slot, value });
    }
    queueAliases();
  }
  if (unresolved)
    mantleWarn(
      '[Mantle] morph: ' +
        unresolved +
        ' matched clip/mask binding(s) address a destination run that cannot be reproduced; the source binding is kept.',
    );
  if (dropped)
    mantleWarn(
      '[Mantle] morph: dropped ' +
        dropped +
        ' destination clip/mask bindings with missing or invalid layer runs.',
    );
  // The destination plane carries the t = 1 binding, so consumers that compare poses see it move.
  const retarget = (plane) => {
    for (const e of steps) plane[e.row * stride + e.slot] = e.value;
    return plane;
  };
  if (!extra.length && !steps.length) return none;
  if (!extra.length) return { ...none, aligned: retarget(aligned), steps };

  const expanded = new Float32Array((originalN + extra.length) * stride),
    target = new Float32Array(expanded.length);
  expanded.set(meta);
  target.set(aligned);
  for (let i = 0; i < extra.length; i++) {
    expanded.set(extra[i], (originalN + i) * stride);
    const row = sources[i].dst;
    target.set(dst.metaFloats.subarray(row * stride, (row + 1) * stride), (originalN + i) * stride);
  }
  return { meta: expanded, aligned: retarget(target), aliases, sources, matched, steps };
}
