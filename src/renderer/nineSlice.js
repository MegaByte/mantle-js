// nineSlice.js — fill 9-slice rewrite for cover-quad chunks.
//
// Given a bundle's coverQuadFloats / chunks plus a border + worldSize,
// rewrite every fill cover-quad (count == 6, i.e. 2 triangles) into an
// 18-triangle 3×3 grid (54 verts). Stroke chunks and non-quad fills pass
// through unchanged.
//
// Drawing is gl.drawArrays(TRIANGLES) with no index buffer, so each of
// the 18 tris contributes 3 verts → 54 verts total. Only fills are
// nine-sliced; strokes are out of scope.
//
// API:
//   const { meshFloats, chunks } = buildNineSliceMesh({
//     meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
//     border:     [L, B, R, T],       // em-space, Sprite.border channel order
//     worldSize:  [W, H],             // em-space target rect
//     nativeBBox: [xmin, ymin, xmax, ymax],  // em-space; bundle.viewBox usually
//   });
//
//   Pass nativeBBox = null to fall back to bundle.GlobalBBox (caller-
//   supplied via the metadata, not derived here — the function takes
//   nativeBBox or null; if null AND no fallback, the rewrite no-ops).
//
// Returns a NEW Float32Array — the caller's input is not mutated. The
// returned `chunks` array has the same length as the input but each
// quad-fill chunk's `start`/`count` references the new buffer.

import { COVER_QUAD_STRIDE } from './coverQuadChunks.js';

const FLAG_LAYER       = 0x100;
const FLAG_GROUP_BEGIN = 1 << 6;
const FLAG_GROUP_END   = 1 << 7;
// Meta texel offsets — keep in sync with bundle.js / mantle.frag.
const META_GID         = 14;
const META_FLAGS       = 27;

/// Build a rewritten coverQuadFloats with 9-slice fills.
///
/// @param {Float32Array} meshFloats — input coverQuadFloats from a bundle.
/// @param {Array<{start:number,count:number,gid:number,fillColor:number[]}>} chunks
///     parseCoverQuadChunks output for the input meshFloats.
/// @param {Map<number,number>} gidToShapeIdx — gid → meta row index.
/// @param {Float32Array} metaFloats — bundle.metaFloats.
/// @param {number} metaStride — bundle.floatsPerShape.
/// @param {number[]} border — [L, B, R, T] em-space.
/// @param {number[]} worldSize — [W, H] em-space target rect.
/// @param {number[]|null} nativeBBox — [xmin, ymin, xmax, ymax] em-space, or null.
/// @param {number[]|null} fallbackBBox — bundle.GlobalBBox (xmin, ymin, w, h)
///     fallback when nativeBBox is null. Optional; pass-through no-op if null.
///
/// @returns {{ meshFloats: Float32Array, chunks: Array, shapeIdxFloats: Float32Array|null }}
///   When 9-slice doesn't apply (no border / no worldSize / no valid bbox),
///   returns references to the inputs verbatim (no copy). Otherwise the
///   returned arrays are fresh allocations.
export function buildNineSliceMesh({
  meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
  border, worldSize, nativeBBox = null, fallbackBBox = null,
}) {
  if (!meshFloats || !chunks || !chunks.length) {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }
  if (!border || !worldSize) {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }
  const bL = border[0] || 0, bB = border[1] || 0, bR = border[2] || 0, bT = border[3] || 0;
  if (bL === 0 && bB === 0 && bR === 0 && bT === 0) {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }
  const tW = worldSize[0] || 0, tH = worldSize[1] || 0;
  if (tW <= 0 || tH <= 0) {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }

  // Resolve native-em bbox. nativeBBox is (xmin, ymin, xmax, ymax).
  // fallbackBBox is bundle.GlobalBBox = (xmin, ymin, w, h) — convert
  // to xyxy.
  let emL, emT, emR, emB;
  if (nativeBBox) {
    emL = nativeBBox[0]; emT = nativeBBox[1];
    emR = nativeBBox[2]; emB = nativeBBox[3];
  } else if (fallbackBBox) {
    emL = fallbackBBox[0]; emT = fallbackBBox[1];
    emR = fallbackBBox[0] + fallbackBBox[2];
    emB = fallbackBBox[1] + fallbackBBox[3];
  } else {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }
  const emW = emR - emL, emH = emB - emT;
  if (emW <= 0 || emH <= 0) {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }

  // Clamp border sums to bbox.
  let nbL = bL, nbR = bR, nbT = bT, nbB = bB;
  if (nbL + nbR > emW) { const s = emW / (nbL + nbR); nbL *= s; nbR *= s; }
  if (nbT + nbB > emH) { const s = emH / (nbT + nbB); nbT *= s; nbB *= s; }
  const targetW = Math.max(tW, nbL + nbR);
  const targetH = Math.max(tH, nbT + nbB);

  // Output: walk every chunk. For chunks that are quad-fills AND whose
  // shape is a real fill row (not FLAG_LAYER / group marker), expand
  // the 6-vert quad into a 54-vert 18-triangle grid. Otherwise copy
  // verbatim.
  const outFloats = [];
  const outChunks = new Array(chunks.length);

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    // Header: 12 floats. Copy verbatim; we'll patch `n` below if the
    // body was expanded.
    const headerStart = (c.start - 1) * COVER_QUAD_STRIDE;
    for (let k = 0; k < COVER_QUAD_STRIDE; k++) outFloats.push(meshFloats[headerStart + k]);

    // Compute whether this chunk should be 9-sliced. Criteria:
    //   1. count === 6 (a single fill bbox-quad).
    //   2. The owning meta row is renderable (not LAYER / GROUP).
    let nineSlice = (c.count === 6);
    if (nineSlice && metaFloats && gidToShapeIdx) {
      const row = gidToShapeIdx.get(c.gid);
      if (row === undefined) {
        nineSlice = false;
      } else {
        const flags = Math.floor(metaFloats[row * metaStride + META_FLAGS] + 0.5);
        if ((flags & (FLAG_LAYER | FLAG_GROUP_BEGIN | FLAG_GROUP_END)) !== 0)
          nineSlice = false;
      }
    }

    const newBodyStart = (outFloats.length / COVER_QUAD_STRIDE);
    if (nineSlice) {
      // Pull common per-vert fields from the FIRST source vert. For a
      // cover quad the per-vert layout is:
      //   floats 0-1  : aPos.xy        (target em — rewritten below)
      //   floats 2-3  : aNormal.xy     (outward bisector — kept; the
      //                                 vert shader skips dilation when
      //                                 the normal is zero. We zero
      //                                 these on 9-slice verts so the
      //                                 piecewise-linear cell boundaries
      //                                 don't get dilated outward.)
      //   floats 4-5  : aEmCoord.xy    (NATIVE em — written below; the
      //                                 vert shader reads it instead of
      //                                 aPos for vEmCoord when
      //                                 uHasEmCoord == 1.)
      //   floats 6-9  : v2..v3         (unused for cover quads — zero)
      //   floats 10   : kind           (1 — cover-quad branch)
      //   floats 11   : zone           (-1 — hull interior)
      const v0Off = c.start * COVER_QUAD_STRIDE;
      const kindCommon = meshFloats[v0Off + 10];
      const zoneCommon = meshFloats[v0Off + 11];

      // Position cuts (em-space, span the target rect anchored at (emL, emT)).
      const px = [emL,            emL + nbL,        emL + targetW - nbR, emL + targetW];
      const py = [emT,            emT + nbT,        emT + targetH - nbB, emT + targetH];
      // EmCoord cuts (em-space, span the NATIVE rect — corners pin).
      const ex = [emL,            emL + nbL,        emR - nbR,           emR];
      const ey = [emT,            emT + nbT,        emB - nbB,           emB];

      // Emit 18 triangles = 54 verts. Per vert: aPos (target), aNormal=0,
      // aEmCoord (native), zeros, kind, zone.
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const v00 = [i,     j    ];
          const v10 = [i + 1, j    ];
          const v01 = [i,     j + 1];
          const v11 = [i + 1, j + 1];
          const order = [v00, v10, v11, v00, v11, v01];
          for (const [ii, jj] of order) {
            outFloats.push(px[ii], py[jj]);          // aPos (target em)
            outFloats.push(0, 0);                     // aNormal (no dilation across grid edges)
            outFloats.push(ex[ii], ey[jj]);          // aEmCoord (native em)
            outFloats.push(0, 0, 0, 0);               // v2..v3 unused
            outFloats.push(kindCommon, zoneCommon);
          }
        }
      }
      outChunks[ci] = {
        start: newBodyStart,
        count: 54,
        gid: c.gid,
        fillColor: c.fillColor,
      };
    } else {
      // Copy body verbatim.
      const srcBodyStart = c.start * COVER_QUAD_STRIDE;
      const srcBodyEnd   = srcBodyStart + c.count * COVER_QUAD_STRIDE;
      for (let k = srcBodyStart; k < srcBodyEnd; k++) outFloats.push(meshFloats[k]);
      outChunks[ci] = {
        start: newBodyStart,
        count: c.count,
        gid: c.gid,
        fillColor: c.fillColor,
      };
    }
  }

  const newMeshFloats = new Float32Array(outFloats);
  // Patch each chunk's header `n` slot to its (possibly expanded) count.
  for (let ci = 0; ci < outChunks.length; ci++) {
    const c = outChunks[ci];
    const headerOff = (c.start - 1) * COVER_QUAD_STRIDE;
    newMeshFloats[headerOff + 0] = c.count;
  }

  // Build a parallel shapeIdxFloats — one float per vert, holding the
  // chunk's shapeIdx. (Mirrors buildShapeIdxFloats in coverQuadChunks.js.)
  let shapeIdxFloats = null;
  if (gidToShapeIdx) {
    const vertCount = newMeshFloats.length / COVER_QUAD_STRIDE;
    shapeIdxFloats = new Float32Array(vertCount);
    for (let ci = 0; ci < outChunks.length; ci++) {
      const c = outChunks[ci];
      const si = gidToShapeIdx.get(c.gid);
      const sIdx = (si === undefined) ? 0 : si;
      for (let v = c.start; v < c.start + c.count; v++) shapeIdxFloats[v] = sIdx;
    }
  }

  return { meshFloats: newMeshFloats, chunks: outChunks, shapeIdxFloats };
}
