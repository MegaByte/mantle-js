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
    const r = f32[i + 2], g = f32[i + 3], b = f32[i + 4];
    const aFlag = f32[i + 5];
    const alpha = Math.abs(aFlag);
    if (n <= 0 || i + COVER_QUAD_STRIDE + n * COVER_QUAD_STRIDE > f32.length) break;
    chunks.push({
      start: (i / COVER_QUAD_STRIDE) + 1,
      count: n,
      gid,
      fillColor: [r, g, b, alpha],
    });
    i += COVER_QUAD_STRIDE * (n + 1);
  }
  return chunks;
}

/// Build the per-vert shapeIdx buffer: every vert in a chunk gets the
/// chunk's gid → shapeIdx mapping.
export function buildShapeIdxFloats(coverQuadFloats, chunks, gidToShapeIdx) {
  const vertCount = coverQuadFloats.length / COVER_QUAD_STRIDE;
  const arr = new Float32Array(vertCount);
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const si = gidToShapeIdx.get(c.gid);
    const sIdx = (si === undefined) ? 0 : si;
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
