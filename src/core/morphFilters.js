// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter IDs and convolution rows belong to each endpoint's resource tables.
const floatTable = (bundle, raw, view) =>
  bundle[view] || (bundle[raw] ? new Float32Array(bundle[raw]) : new Float32Array(0));
const SLOT_FILTER = 32;
/// A filter is a choice, not a quantity: a matched row whose two poses carry different filters keeps the source's until the middle of the
/// morph and takes the destination's from there (t = 0 and t = 1 are exact). Its output opacity follows the active filter.
export const MORPH_FILTER_STEP_AT = 0.5;
export const morphFilterOpacity = (pair, t) =>
  pair.length > 2 ? (t >= pair[2] ? pair[1] : pair[0]) : pair[0] * (1 - t) + pair[1] * t;
const referencedFilters = (dst, plan, stride, aligned) => {
  const ids = new Set(
    plan.dstOnly
      .map((e) => Math.round(dst.metaFloats[e.dstIdx * stride + SLOT_FILTER]))
      .filter((id) => id > 0),
  );
  if (aligned)
    for (const m of plan.matched || []) {
      const id = Math.round(aligned[m.srcIdx * stride + SLOT_FILTER]);
      if (id > 0) ids.add(id);
    }
  return ids;
};
export function morphFilterImageIds(dst, plan, stride, aligned) {
  const ids = new Set();
  for (const id of referencedFilters(dst, plan, stride, aligned))
    for (const node of dst.filterGraphs?.[id - 1]?.nodes || [])
      if (node.type === 'feImage' && node.params?.imageId > 0) ids.add(node.params.imageId);
  return ids;
}
function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return value.slice();
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}
// Two filter records that draw the same thing: equal records, graphs, regions and transforms, with nothing that addresses a table of its own
// (convolution kernels, feImage sources).
// A region resolved from fractions is those fractions and the rows they were taken against; the rect it came out as is the pose's.
const regionKey = (r, o) => (o ? [r && r[4], o] : r);
const sameFilter = (a, b) => {
  if (Math.round(a.row[20]) === 6 || Math.round(b.row[20]) === 6) return false;
  for (const g of [a.graph, b.graph])
    for (const node of g?.nodes || []) if (node.type === 'feImage') return false;
  for (let k = 0; k < 24; k++)
    if (a.row[k] !== b.row[k] && !(a.row[k] !== a.row[k] && b.row[k] !== b.row[k])) return false;
  return (
    JSON.stringify([a.graph, regionKey(a.region, a.obb), a.ctm]) ===
    JSON.stringify([b.graph, regionKey(b.region, b.obb), b.ctm])
  );
};
export function prepareMorphFilters(src, dst, plan, meta, stride, imageIds, aligned) {
  const a = floatTable(src, 'filterTab', 'lastFilterFloats'),
    b = floatTable(dst, 'filterTab', 'lastFilterFloats');
  const ka = floatTable(src, 'kernelTab', 'lastKernelFloats'),
    kb = floatTable(dst, 'kernelTab', 'lastKernelFloats');
  const count = a.length / 24,
    ids = new Map(),
    records = [a],
    graphs = Array.from({ length: count }, (_, i) => src.filterGraphs?.[i] || null),
    regions = Array.from({ length: count }, (_, i) => clone(src.filterRegions?.[i] || null)),
    obbs = Array.from({ length: count }, (_, i) => clone(src.filterRegionObb?.[i] || null)),
    ctms = Array.from({ length: count }, (_, i) => clone(src.filterPrimCtms?.[i] || null));
  let targetKernels = false;
  const steps = [];
  // A group filter's region lists the rows it was resolved against; those of a destination record are destination rows.
  const toMerged = new Map((plan.matched || []).map((m) => [m.dstIdx, m.srcIdx]));
  plan.dstOnly.forEach((e, k) => toMerged.set(e.dstIdx, src.numShapes + k));
  const mapObbRows = (obb) => {
    if (obb) obb[4] = obb[4].map((r) => toMerged.get(r)).filter((r) => r !== undefined);
    return obb;
  };
  // The merged id of destination filter `id`: the source's own record when it draws the same thing, else a copy appended after the source's.
  const take = (id, matchedSrcId) => {
    if (ids.has(id)) return ids.get(id);
    if (id * 24 > b.length)
      throw new Error('mantle: destination morph filter has no resource record');
    const row = b.slice((id - 1) * 24, id * 24);
    const graph = clone(dst.filterGraphs?.[id - 1] || null),
      region = clone(dst.filterRegions?.[id - 1] || null),
      obb = mapObbRows(clone(dst.filterRegionObb?.[id - 1] || null)),
      ctm = clone(dst.filterPrimCtms?.[id - 1] || null);
    if (matchedSrcId > 0 && matchedSrcId * 24 <= a.length) {
      const same = {
        row: a.slice((matchedSrcId - 1) * 24, matchedSrcId * 24),
        graph: src.filterGraphs?.[matchedSrcId - 1] || null,
        region: src.filterRegions?.[matchedSrcId - 1] || null,
        obb: src.filterRegionObb?.[matchedSrcId - 1] || null,
        ctm: src.filterPrimCtms?.[matchedSrcId - 1] || null,
      };
      if (sameFilter(same, { row, graph, region, obb, ctm })) return matchedSrcId;
    }
    if (Math.round(row[20]) === 6) {
      row[8] += ka.length / 25;
      targetKernels = true;
    }
    for (const node of graph?.nodes || [])
      if (node.type === 'feImage' && node.params?.imageId > 0)
        node.params.imageId = imageIds.get(node.params.imageId) || 0;
    const merged = count + records.length;
    ids.set(id, merged);
    records.push(row);
    graphs.push(graph);
    regions.push(region);
    obbs.push(obb);
    ctms.push(ctm);
    return merged;
  };
  for (let k = 0; k < plan.dstOnly.length; k++) {
    const offset = (src.numShapes + k) * stride,
      id = Math.round(meta[offset + SLOT_FILTER]);
    if (id <= 0) continue;
    meta[offset + SLOT_FILTER] = take(id, 0);
  }
  // Matched rows: the destination's filter replaces the source's from the middle of the morph on.
  if (aligned)
    for (const m of plan.matched || []) {
      const at = m.srcIdx * stride + SLOT_FILTER,
        from = Math.round(meta[at]),
        to = Math.round(aligned[at]);
      if (from <= 0 && to <= 0) continue;
      const value = to > 0 ? take(to, from) : 0;
      aligned[at] = value;
      if (value !== from)
        steps.push({ row: m.srcIdx, slot: SLOT_FILTER, value, at: MORPH_FILTER_STEP_AT });
    }
  const table = new Float32Array(records.reduce((n, r) => n + r.length, 0));
  let offset = 0;
  for (const row of records) {
    table.set(row, offset);
    offset += row.length;
  }
  const kernels = new Float32Array(ka.length + (targetKernels ? kb.length : 0));
  kernels.set(ka);
  if (targetKernels) kernels.set(kb, ka.length);
  return {
    filterTab: table.length ? table.buffer : null,
    kernelTab: kernels.length ? kernels.buffer : null,
    filterGraphs: graphs.some(Boolean) ? graphs : null,
    filterRegions: regions.some(Boolean) ? regions : null,
    filterRegionObb: obbs.some(Boolean) ? obbs : null,
    filterPrimCtms: ctms.some(Boolean) ? ctms : null,
    filterSteps: steps,
  };
}
