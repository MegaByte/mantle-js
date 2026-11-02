// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nineSlice.js — fill 9-slice rewrite for cover-quad chunks.
//
// Given a bundle's coverQuadFloats / chunks plus a border + worldSize,
// rewrite every fill cover-quad (count == 6, i.e. 2 triangles) -- or a
// cover FAN, which the grid replaces the same way -- into an
// 18-triangle 3×3 grid (54 verts). Other chunks pass through unchanged.
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

const FLAG_LAYER = 0x100;
const FLAG_GROUP_BEGIN = 1 << 6;
const FLAG_GROUP_END = 1 << 7;
// Meta texel offsets — keep in sync with bundle.js / mantle.frag.
const META_GID = 14;
const META_FLAGS = 27;

/// A cover fan chunk (svg/mesh.js getCoverFanVerts): 1 to 6 triangles, every vertex in the cover-quad branch.
function isCoverFan(meshFloats, c) {
  if (c.count < 3 || c.count > 18 || c.count % 3 !== 0) return false;
  for (let v = 0; v < c.count; v++) {
    const o = (c.start + v) * COVER_QUAD_STRIDE;
    if (meshFloats[o + 10] !== 1 || meshFloats[o + 11] !== -1) return false;
  }
  return true;
}

/// Read a 4-slot (or shorter) numeric list: a missing slot is 0, a present slot must be a finite number >= `min`.
function numList(name, v, n, min) {
  if (v == null) return null;
  if (typeof v !== 'object' || typeof v.length !== 'number')
    throw new TypeError('nine-slice: ' + name + ' must be an array of numbers');
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x === undefined || x === null) continue;
    if (typeof x !== 'number' || !Number.isFinite(x))
      throw new RangeError(
        'nine-slice: ' + name + '[' + i + '] must be a finite number, got ' + String(x),
      );
    if (x < min)
      throw new RangeError('nine-slice: ' + name + '[' + i + '] must be >= ' + min + ', got ' + x);
    out[i] = x;
  }
  return out;
}

/// Validate nine-slice options and resolve them against the native frame. THROWS (before anything is built or mutated) on invalid
/// input: a border / worldSize / nativeBBox that is not a list of finite numbers, a negative border, a nativeBBox without a positive
/// extent on both axes. Returns null when the options mean "no slicing" (no border, all-zero border, no worldSize, a worldSize
/// of zero or less on an axis, or a native frame with no extent): the bundle then keeps or regains its native state.
///
/// `fallbackBBox` is the bundle's native `globalBBox` (xmin, ymin, w, h), used when `nativeBBox` is absent.
export function resolveNineSlice(opts, fallbackBBox) {
  if (!opts) return null;
  const border = numList('border', opts.border, 4, 0);
  const worldSize = numList('worldSize', opts.worldSize, 2, -Infinity);
  const nb = numList('nativeBBox', opts.nativeBBox, 4, -Infinity);
  if (nb && !(nb[2] > nb[0] && nb[3] > nb[1])) {
    throw new RangeError(
      'nine-slice: nativeBBox [xmin, ymin, xmax, ymax] needs xmax > xmin and ymax > ymin, got [' +
        nb.join(', ') +
        ']',
    );
  }
  if (!border || !worldSize) return null;
  const bL = border[0],
    bB = border[1],
    bR = border[2],
    bT = border[3];
  if (bL === 0 && bB === 0 && bR === 0 && bT === 0) return null;
  const tW = worldSize[0],
    tH = worldSize[1];
  if (tW <= 0 || tH <= 0) return null;
  let emL, emT, emR, emB;
  if (nb) {
    emL = nb[0];
    emT = nb[1];
    emR = nb[2];
    emB = nb[3];
  } else if (fallbackBBox) {
    emL = fallbackBBox[0];
    emT = fallbackBBox[1];
    emR = fallbackBBox[0] + fallbackBBox[2];
    emB = fallbackBBox[1] + fallbackBBox[3];
    if (!(emR > emL && emB > emT)) return null;
  } else return null;
  const emW = emR - emL,
    emH = emB - emT;
  // Clamp border sums to the native frame.
  let nbL = bL,
    nbR = bR,
    nbT = bT,
    nbB = bB;
  if (nbL + nbR > emW) {
    const s = emW / (nbL + nbR);
    nbL *= s;
    nbR *= s;
  }
  if (nbT + nbB > emH) {
    const s = emH / (nbT + nbB);
    nbT *= s;
    nbB *= s;
  }
  const targetW = Math.max(tW, nbL + nbR),
    targetH = Math.max(tH, nbT + nbB);
  if (
    !Number.isFinite(targetW) ||
    !Number.isFinite(targetH) ||
    !Number.isFinite(emW) ||
    !Number.isFinite(emH)
  ) {
    throw new RangeError('nine-slice: the frame or target size overflows');
  }
  return { emL, emT, emR, emB, nbL, nbB, nbR, nbT, targetW, targetH };
}

/// One axis of the cut table: target cuts (where a draw lands) and native cuts (what they show), as the 3x3 grid uses them.
function cutsOf(g) {
  return {
    px: [g.emL, g.emL + g.nbL, g.emL + g.targetW - g.nbR, g.emL + g.targetW],
    py: [g.emT, g.emT + g.nbT, g.emT + g.targetH - g.nbB, g.emT + g.targetH],
    ex: [g.emL, g.emL + g.nbL, g.emR - g.nbR, g.emR],
    ey: [g.emT, g.emT + g.nbT, g.emB - g.nbB, g.emB],
  };
}

function invAxis(v, p, e) {
  if (v <= p[0]) return e[0] + (v - p[0]); // outside: the corner pins, so the offset carries over
  if (v >= p[3]) return e[3] + (v - p[3]);
  const k = v < p[1] ? 0 : v < p[2] ? 1 : 2;
  const span = p[k + 1] - p[k];
  if (!(span > 0)) return e[k]; // a zero-width target cell shows its left native edge
  return e[k] + ((v - p[k]) * (e[k + 1] - e[k])) / span;
}

/// The native-em point a target-em point shows, through the inverse of the 3x3 cut table the draw uses
/// (`geom` = the object resolveNineSlice returned). Hit tests run on native curves, so a point on a sliced bundle maps here first.
export function nineSliceNativePoint(geom, x, y) {
  const c = geom.cuts || (geom.cuts = cutsOf(geom));
  return [invAxis(x, c.px, c.ex), invAxis(y, c.py, c.ey)];
}

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
  meshFloats,
  chunks,
  gidToShapeIdx,
  metaFloats,
  metaStride,
  border,
  worldSize,
  nativeBBox = null,
  fallbackBBox = null,
}) {
  if (!meshFloats || !chunks || !chunks.length) {
    return { meshFloats, chunks, shapeIdxFloats: null };
  }
  // Validates (throws on invalid options) and resolves; null = no slicing.
  const geom = resolveNineSlice({ border, worldSize, nativeBBox }, fallbackBBox);
  if (!geom) return { meshFloats, chunks, shapeIdxFloats: null };
  const { emL, emT, emR, emB, nbL, nbB, nbR, nbT, targetW, targetH } = geom;

  // Output: walk every chunk. For chunks that are quad-fills AND whose
  // shape is a real fill row (not FLAG_LAYER / group marker), expand
  // the 6-vert quad into a 54-vert 18-triangle grid. Otherwise copy
  // verbatim.
  const outFloats = [];
  const outChunks = new Array(chunks.length);

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];

    const headerStart = (c.start - 1) * COVER_QUAD_STRIDE;
    for (let k = 0; k < COVER_QUAD_STRIDE; k++) outFloats.push(meshFloats[headerStart + k]);

    // Compute whether this chunk should be 9-sliced. Criteria:
    //   1. count === 6 (a single fill bbox-quad), or a cover FAN: a triangle list of 3 to 18 cover vertices
    //      (kind 1, zone -1), a fill row's convex hull in place of its box. The grid below spans the native rect
    //      whatever the cover was, so a fan slices exactly as its box does; passed through, it would be drawn unsliced.
    //   2. The owning meta row is renderable (not LAYER / GROUP).
    let nineSlice = c.count === 6 || isCoverFan(meshFloats, c);
    if (nineSlice && metaFloats && gidToShapeIdx) {
      const row = gidToShapeIdx.get(c.gid);
      if (row === undefined) {
        nineSlice = false;
      } else {
        const flags = Math.floor(metaFloats[row * metaStride + META_FLAGS] + 0.5);
        if ((flags & (FLAG_LAYER | FLAG_GROUP_BEGIN | FLAG_GROUP_END)) !== 0) nineSlice = false;
      }
    }

    const newBodyStart = outFloats.length / COVER_QUAD_STRIDE;
    if (nineSlice) {
      const v0Off = c.start * COVER_QUAD_STRIDE;
      const kindCommon = meshFloats[v0Off + 10];
      const zoneCommon = meshFloats[v0Off + 11];

      // Position cuts (em-space, span the target rect anchored at (emL, emT)).
      const px = [emL, emL + nbL, emL + targetW - nbR, emL + targetW];
      const py = [emT, emT + nbT, emT + targetH - nbB, emT + targetH];
      // EmCoord cuts (em-space, span the NATIVE rect — corners pin).
      const ex = [emL, emL + nbL, emR - nbR, emR];
      const ey = [emT, emT + nbT, emB - nbB, emB];

      // Emit 18 triangles = 54 verts. Per vert: aPos (target), aNormal=0,
      // aEmCoord (native), zeros, kind, zone.
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const v00 = [i, j];
          const v10 = [i + 1, j];
          const v01 = [i, j + 1];
          const v11 = [i + 1, j + 1];
          const order = [v00, v10, v11, v00, v11, v01];
          for (const [ii, jj] of order) {
            outFloats.push(px[ii], py[jj]); // aPos (target em)
            outFloats.push(0, 0); // aNormal (no dilation across grid edges)
            outFloats.push(ex[ii], ey[jj]); // aEmCoord (native em)
            outFloats.push(0, 0, 0, 0); // v2..v3 unused
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
      const srcBodyEnd = srcBodyStart + c.count * COVER_QUAD_STRIDE;
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
      const sIdx = si === undefined ? 0 : si;
      for (let v = c.start; v < c.start + c.count; v++) shapeIdxFloats[v] = sIdx;
    }
  }

  return { meshFloats: newMeshFloats, chunks: outChunks, shapeIdxFloats };
}
