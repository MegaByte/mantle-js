// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverQuadChunks.js — per-shape cover-quad chunk parsing.
//
// Bundles ship the cover quads as a flat Float32Array (curveGeom
// section); each chunk is a 12-float header (n, gid, r, g, b,
// aFlag, _, _, _, _, marker, _) followed by n × COVER_QUAD_STRIDE vertex
// floats. parseCoverQuadChunks walks the stream and emits one
// chunk descriptor per shape so the renderer can drive per-shape
// draws by shapeIdx → chunk lookup.
//
// buildGidToShapeIdx + buildShapeIdxFloats are the two helpers
// bundle.js uses to thread gids through the renderer's per-vert
// shapeIdx attribute (MantleUnified shader's VertData.Idx.x).

export const COVER_QUAD_STRIDE = 12;
export const BUNDLE_FLAG_HYBRID_MESH_CHUNKED = 2;

/// Parse the curve-geom chunk stream. Each chunk corresponds to one
/// fill-or-stroke meta row. Returns an array of:
///   { start, count, gid, fillColor }
/// where `start` is the vertex index (COVER_QUAD_STRIDE floats per vert)
/// of the first body vertex.
///
/// The canonical evenodd runtime signal is meta texel 3.y (consumed by
/// mantle.frag as `evenOddFill = vStrokePad.y > 0.5`). aFlag's sign also
/// encodes it (both derive from the shape's `fillRule`); the binary keeps
/// the sign for debug tooling but the parsed chunk drops it.
export function parseCoverQuadChunks(f32, flags) {
  const chunks = [];
  if (!f32 || (flags & BUNDLE_FLAG_HYBRID_MESH_CHUNKED) === 0) return chunks;
  let i = 0;
  while (i + COVER_QUAD_STRIDE <= f32.length) {
    const n = Math.floor(f32[i] + 0.5);
    const gid = Math.floor(f32[i + 1] + 0.5);
    const r = f32[i + 2],
      g = f32[i + 3],
      b = f32[i + 4];
    const aFlag = f32[i + 5];
    const alpha = Math.abs(aFlag);
    if (n <= 0 || i + COVER_QUAD_STRIDE + n * COVER_QUAD_STRIDE > f32.length) break;
    chunks.push({
      start: i / COVER_QUAD_STRIDE + 1,
      count: n,
      gid,
      fillColor: [r, g, b, alpha],
    });
    i += COVER_QUAD_STRIDE * (n + 1);
  }
  return chunks;
}

/// Build a header-free cover-quad VBO from the parsed chunks.

/// This packs the body verts contiguously (headers dropped) and stamps each
/// chunk with `vboStart` — its offset in the stripped buffer. Consecutive
/// chunks then satisfy `vboStart === pendingEnd`, so the renderer collapses
/// them into one drawArrays. The parallel shapeIdx attribute is repacked to
/// match. Returns { verts, shapeIdx } aligned to the stamped vboStart values.
export function buildStrippedCoverQuad(coverQuadFloats, chunks, shapeIdxFloats) {
  let total = 0;
  for (let ci = 0; ci < chunks.length; ci++) total += chunks[ci].count;
  const verts = new Float32Array(total * COVER_QUAD_STRIDE);
  // Always emit a shapeIdx plane matching `verts` length. Cover VAOs keep
  // attrib 7 enabled; a missing/short shapeIdx buffer is what trips
  // `GL_INVALID_OPERATION: Vertex buffer is not big enough for the draw call`
  // when Slug draws the stripped mesh (heavy-asset LB→Slug fallback).
  const sidx = new Float32Array(total);
  let out = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const srcStart = c.start * COVER_QUAD_STRIDE;
    const n = c.count * COVER_QUAD_STRIDE;
    verts.set(coverQuadFloats.subarray(srcStart, srcStart + n), out * COVER_QUAD_STRIDE);
    if (shapeIdxFloats) sidx.set(shapeIdxFloats.subarray(c.start, c.start + c.count), out);
    c.vboStart = out;
    out += c.count;
  }
  return { verts, shapeIdx: sidx };
}

/// Where a cover buffer puts each chunk so that `drawList` walks it in contiguous runs: first the chunks the list paints,
/// then the ones it leaves out (rows the occlusion cull dropped, rows kept hidden, mask sources), each part in chunk order.
/// The cover pass merges chunks into one drawArrays only while each starts where the last ended, so a row left out between
/// two painted rows ends a run and costs another draw. Every chunk keeps its vertices, so a list that brings a row back (an
/// override that retires the cull) still finds it, and the stroke strips appended after the quads keep their offsets.
///
/// A layout is an Int32Array of first vertices indexed by the chunk's position in `chunks`, which this stamps on each chunk
/// as `_ci`. `current` is the buffer's present layout, or null for the bundle's own (each chunk's `vboStart`). Returns null
/// when `current` already serves the list, or when the chunks do not tile the planes from vertex 0 (a mesh this layout
/// does not describe). Otherwise `{ startAt, lo, hi }`: the new layout (null when it is the bundle's own) and the vertex
/// span [lo, hi) whose contents change. Chunks tile the span: each lies wholly inside it or wholly outside.
export function planCoverLayout(chunks, drawList, current) {
  if (!chunks || !chunks.length || !Array.isArray(drawList)) return null;
  const n = chunks.length;
  for (let i = 0; i < n; i++) chunks[i]._ci = i;
  const at = (c) => (current ? current[c._ci] : c.vboStart == null ? -1 : c.vboStart);
  const painted = new Uint8Array(n);
  let end = -1,
    gaps = 0;
  for (const op of drawList) {
    const c = op.chunk;
    if (!c) continue;
    if (chunks[c._ci] !== c) return null; // a painted chunk the planes do not hold
    const s = at(c);
    if (s < 0) return null;
    if (end >= 0 && s !== end) gaps++;
    end = s + c.count;
    painted[c._ci] = 1;
  }
  if (!gaps) return null;
  const startAt = new Int32Array(n);
  let pos = 0;
  for (let pass = 1; pass >= 0; pass--)
    for (let i = 0; i < n; i++)
      if (painted[i] === pass) {
        startAt[i] = pos;
        pos += chunks[i].count;
      }
  let lo = Infinity,
    hi = -1,
    own = true;
  for (let i = 0; i < n; i++) {
    const c = chunks[i],
      to = startAt[i],
      was = at(c);
    if (c.vboStart == null || was < 0 || was + c.count > pos) return null;
    if (to !== c.vboStart) own = false;
    if (to !== was) {
      lo = Math.min(lo, to, was);
      hi = Math.max(hi, to + c.count, was + c.count);
    }
  }
  return hi < 0 ? null : { startAt: own ? null : startAt, lo, hi };
}

/// Build the per-vert shapeIdx buffer: every vert in a chunk gets the
/// chunk's gid → shapeIdx mapping.
export function buildShapeIdxFloats(coverQuadFloats, chunks, gidToShapeIdx) {
  const vertCount = coverQuadFloats.length / COVER_QUAD_STRIDE;
  const arr = new Float32Array(vertCount);
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const si = gidToShapeIdx.get(c.gid);
    const sIdx = si === undefined ? 0 : si;
    for (let v = c.start; v < c.start + c.count; v++) arr[v] = sIdx;
  }
  return arr;
}

/// Construct the gid → shapeIdx map. gid 0 is reserved (groupBegin/End
/// meta rows + layer rows) and skipped to avoid clobbering.
export function buildGidToShapeIdx(metaFloats, numShapes, stride) {
  const map = new Map();
  if (!metaFloats) return map;
  for (let si = 0; si < numShapes; si++) {
    const gid = Math.floor(metaFloats[si * stride + 14] + 0.5);
    if (gid !== 0 && !map.has(gid)) map.set(gid, si);
  }
  return map;
}
