// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { checkSectionsHead, checkSectionsBody } from './sectionsCheck.js';
import { deleteGlResource, resourceGeneration, trackGlResource } from './contextResources.js';
import { peekGate } from './gpuGate.js';
import { ledgerFor, beginPreparation, endPreparation } from './memoryLedger.js';
import { assertUsableGl } from './contextCheck.js';
import { premultiplyRgba8 } from '../core/premultiply.js';
// MantleBundle (WebGL2) — owns the GL texture resources for one
// loaded Mantle bundle plus the parsed CPU-side state the renderer
// needs to walk per frame (drawList, coverQuadChunks, shape→chunk
// mapping, per-vert shapeIdx buffer).
//
// Public API:
//   const bundle = createBundle(gl, sections);
//   // … renderer.setBundle(bundle); renderer.render(); …
//   bundle.dispose();
//
// `sections` matches the in-memory shape importSvg returns under
// `{ bundleForm: true }`:
//   {
//     meta:           ArrayBuffer,   // 32-byte header + per-shape float records
//     curves:         ArrayBuffer,   // RGBA32F packed curve table
//     bands:          ArrayBuffer,   // RGBA32F packed band table
//     curveGeom:      ArrayBuffer,   // cover quads (per-shape chunks)
//     gradients:      ArrayBuffer?,  // RGBA32F gradient records (4 texels each)
//     gradientStops:  ArrayBuffer?,  // RGBA8 packed stops LUT (bundle/layout.js GRAD_STOPS_*)
//     gradientStopsCount: number?,   // the LUT's texel count (across all gradients)
//     dashes:         ArrayBuffer?,  // RGBA32F dash-pattern table (16 texels each)
//     filterTab:      ArrayBuffer?,  // RGBA32F color-matrix + kind/sigma per filter
//     imageAtlas:     ArrayBuffer?,  // RGBA8 stacked image tiles
//     imageAtlasDim:  [w, h]?,       // pixel dims of the atlas
//     flags:          number,        // BUNDLE_FLAG_*
//     metaFloatsPerShape: number?    // optional override; inferred otherwise
//   }

import {
  COVER_QUAD_STRIDE,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
  parseCoverQuadChunks,
  buildShapeIdxFloats,
  buildGidToShapeIdx,
  buildStrippedCoverQuad,
} from './coverQuadChunks.js';

let _bundleUidSeq = 0;
import { buildNineSliceMesh, resolveNineSlice } from './nineSlice.js';
import { computeOccludedShapes } from './occlusionCull.js';
import { requestOcclusionCull } from './occlusionWorkerPool.js';
// Interior-skip occupancy grids + GWN tier-3 cells are reserved (zeroed) at import
// and built OFF the main thread by the occupancy worker; the results are applied
// (float-plane write + texSubImage2D) when they arrive — see _applyOccupancyGrids
// / _applyTreeGrids. The grids come online mid-play with no main-thread build cost.
import { requestOccupancyBuild } from './occupancyWorkerPool.js';
// parseMetaBin lives in the gl-free core so the no-WebGL fallback can use
// it without pulling this GL module. Re-exported below.
import { parseMetaBin, META_STRIDE_V2 } from '../core/metaBin.js';
import {
  gradientStopsLutSize,
  padGradientStopsLut,
  FS_KEPT_INVISIBLE,
  FS_HIDDEN,
  FS_LAYER,
  sectionsOrigin,
} from '../bundle/layout.js';
import { decodeTraceBake } from './cpatchTrace.js';
import {
  META_COLS,
  GRAD_COLS,
  DASH_COLS,
  FILTER_COLS,
  tableDims,
  uploadTableRows,
  checkTableFits,
  checkPlaneFits,
} from './tableLayout.js';

const FULL_META_W = 12; // texels per shape in the meta texture (v3+)
const TEX_W = 4096; // curve/band texture row width

export { parseMetaBin };

export { parseCoverQuadChunks };

/// One-shot texture upload — width × height surface from a typed-array
/// source. Caller-supplied format/type must match the source's element
/// layout. Exported so streamGeometry.js can re-allocate a grown
/// curve/band plane with identical sampler params.
export function makeTex(gl, data, w, h, internal, format, type) {
  const t = trackGlResource(gl, gl.createTexture(), 'bundle');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  return t;
}

/// Upload an UNPADDED RGBA32F plane as a TEX_W-wide, `h`-row texture without building the zero-padded copy that
/// makeTex wants. The texture is allocated zero-filled (WebGL guarantees it), whole rows go straight from the plane, and
/// the partial last row goes through one row-sized scratch. A padded copy would be the plane's size again for the length of
/// createBundle (a 5,000-shape band plane: 9.6 MB; a morph pair's merged plane: hundreds). The texture is byte-identical.
/// Upload a per-item table (`cols` texels per row, `n` rows, `cols * 4` floats each) as RGBA32F. A table of <= TAB_H rows is the plain
/// `cols x n` texture makeTex always built; a taller one wraps in bands (tableLayout.js) so it never outgrows MAX_TEXTURE_SIZE.
export function makeTableTex(gl, data, cols, n) {
  const { w, h, bands } = tableDims(cols, n);
  if (bands === 1) return makeTex(gl, data, cols, h, gl.RGBA32F, gl.RGBA, gl.FLOAT);
  const t = makeTex(gl, null, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT);
  uploadTableRows(
    gl,
    cols,
    0,
    n - 1,
    data.length === n * cols * 4 ? data : data.subarray(0, n * cols * 4),
  );
  return t;
}

export function makePlaneTex(gl, plane, h) {
  const t = trackGlResource(gl, gl.createTexture(), 'bundle');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, h, 0, gl.RGBA, gl.FLOAT, null);
  const rowF = 4 * TEX_W,
    full = Math.floor(plane.length / rowF),
    rem = plane.length - full * rowF;
  if (full)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      TEX_W,
      full,
      gl.RGBA,
      gl.FLOAT,
      plane.subarray(0, full * rowF),
    );
  if (rem) {
    const row = new Float32Array(rowF);
    row.set(plane.subarray(full * rowF));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, TEX_W, 1, gl.RGBA, gl.FLOAT, row);
  }
  return t;
}

/// Build per-shape curve-buffer ranges from meta texel 4
/// (glyphLoc.x, glyphLoc.y). Each entry is `{ begin, end }` in
/// float units (1 RGBA32F texel = 4 floats). The last shape's
/// end is `curveFloatCount` (the bundle's UNPADDED curve float
/// total) so trailing row padding never appears inside any range.
/// Used for exact per-shape curve scoping (e.g. shape morph).
function buildCurveRangesByShape(metaFloats, numShapes, stride, curveFloatCount) {
  const TEX_W_LOCAL = TEX_W;
  const META_TEXEL_4 = 16;
  const ranges = new Array(numShapes);
  for (let i = 0; i < numShapes; i++) {
    const base = i * stride;
    const gx = metaFloats[base + META_TEXEL_4] | 0;
    const gy = metaFloats[base + META_TEXEL_4 + 1] | 0;
    ranges[i] = { begin: 4 * (gy * TEX_W_LOCAL + gx), end: 0 };
  }
  for (let i = 0; i < numShapes - 1; i++) ranges[i].end = ranges[i + 1].begin;
  if (numShapes > 0) ranges[numShapes - 1].end = curveFloatCount;
  return ranges;
}

/// Build the meta plane. v3+ bundles (stride == FULL_META_W * 4) can
/// pass the parsed buffer through directly; older bundles get padded
/// with SVG defaults for the v3-extension texels.
function buildMetaPlane(metaFloats, numShapes, stride) {
  const mh = Math.max(1, numShapes);
  // Zero-shape bundles still need a 1-row meta texture so the GL
  // upload (FULL_META_W × mh = 12 × 1 RGBA32F) has a backing buffer
  // of the expected size. Without this guard, `metaFloats` is an
  // empty array and texImage2D errors with "ArrayBufferView not big
  // enough for request". An empty Float32Array is zero-init, so the
  // shader reads zeroed metadata — no shape is ever indexed (numShapes
  // is the bound) so the values don't matter, only their existence.
  if (numShapes === 0) return new Float32Array(FULL_META_W * 4 * mh);
  if (stride === FULL_META_W * 4) return metaFloats;
  const plane = new Float32Array(FULL_META_W * 4 * mh);
  for (let s = 0; s < numShapes; s++) {
    plane.set(metaFloats.subarray(s * stride, s * stride + stride), s * FULL_META_W * 4);
    if (stride < 44) {
      // v2 → fill v3 extension texel 6 with round caps/joins.
      const base = s * FULL_META_W * 4 + stride;
      plane[base + 0] = 1; // capStyle=round
      plane[base + 1] = 1; // joinStyle=round
      plane[base + 2] = 4; // miterLimit
      plane[base + 3] = 0; // flagsShape
    }
    // Texel 11 (primFastPath) default zero — Float32Array is zero-init.
  }
  return plane;
}

/// Does a row of this bundle blend with what lies under the bundle? A blend inside a group that isolates (opacity, filter, blend, clip, mask or `isolation`) only reads that group's own content; a
/// group with none of those passes its backdrop through. A cached picture is baked over nothing, so such a bundle has to draw live to read the real backdrop.
export function bundleBlendsBackdrop(bundle) {
  const m = bundle && bundle.metaFloats,
    st = bundle ? bundle.metaFloatsPerShape | 0 : 0,
    n = bundle ? bundle.numShapes | 0 : 0;
  if (!m || st < 35) return false;
  const isolating = []; // one entry per open group: does it isolate?
  let isolated = 0;
  for (let s = 0; s < n; s++) {
    const b = s * st,
      f = Math.floor(m[b + 27] + 0.5);
    if ((f & 128) !== 0) {
      if (isolating.pop()) isolated--;
      continue;
    }
    if ((f & (256 | FS_LAYER)) !== 0) continue; // resource rows and clip or mask content are not painted into the scene
    const blend = Math.floor(m[b + 33] + 0.5) > 0;
    if (blend && isolated === 0) return true;
    if ((f & 64) !== 0) {
      const iso =
        blend ||
        m[b + 7] < 1 ||
        Math.round(m[b + 32]) > 0 ||
        Math.floor(m[b + 34] + 0.5) > 0 ||
        Math.floor(m[b + 30] + 0.5) > 0 ||
        Math.floor(m[b + 31] + 0.5) > 0;
      isolating.push(iso);
      if (iso) isolated++;
    }
  }
  return false;
}

/// Build the per-frame draw list in meta-row (SVG painter's) order.
/// Each entry is one of:
///   { kind: 'fillShape',  shapeIdx, chunk, filterId?, filterGraphId?, colrGraphId? }
///   { kind: 'groupBegin', shapeIdx, opacity, blendMode, isolation }
///   { kind: 'groupEnd' }
/// filterId is meta texel 32 (per-shape filter index, 1-based; 0 = none).
/// When `filterGraphs[filterId-1]` is non-null the filter is a graph the
/// kind path can't represent: the op gets filterGraphId set (filterId
/// omitted) so the renderer's graph branch fires instead of the kind branch.
/// colrGraphId is meta slot 45 (texel 11.y; per-shape COLRv1 paint-graph
/// index, 1-based; 0 = none) for COLRv1 color glyphs; the COLR dispatch
/// evaluates colrGraphs[colrGraphId-1] using the coverage-rendered shape
/// silhouette as PaintGlyph's alpha mask.
///
/// The positions (in draw order) of the hidden group brackets that hold a revealed row.
function hiddenGroupsHolding(metaFloats, numShapes, stride, drawOrder, revealed) {
  const live = new Set(),
    open = []; // open: [position, hidden] of the groupBegin rows now open
  for (let p = 0; p < numShapes; p++) {
    const s = drawOrder ? drawOrder[p] : p,
      flags = Math.floor(metaFloats[s * stride + 27] + 0.5);
    if ((flags & 256) !== 0) continue;
    if ((flags & 64) !== 0) open.push([p, (flags & FS_HIDDEN) !== 0]);
    else if ((flags & 128) !== 0) {
      const b = open.pop();
      if (b && b[1] && live.has(b[0])) live.add(p);
    } else if (revealed.has(s)) for (const b of open) if (b[1]) live.add(b[0]);
  }
  return live;
}

/// `includeKept`: also the rows kept at alpha 0 (see _keptRows in createBundle; drawDispatch.js syncKeptRows).
/// `metaAlt` is a morph's DESTINATION rows (the morph bundle's own meta is its source pose): a row that paints in either pose is in the list, because
/// the pose the morph starts from can be a kept alpha-0 fill or stroke that fades in, and a list baked from the source alone would never draw it.
///
/// `revealed`: a Set of the rows kept hidden (FS_HIDDEN: importSvg keepHidden) that an override reveals. A hidden row is in the list only
/// then, and so is a hidden group bracket that holds one of them; left out, a hidden row costs the draw nothing.
export function buildDrawList(
  metaFloats,
  numShapes,
  stride,
  chunkByShape,
  filterGraphs,
  culled,
  order,
  metaAlt,
  includeKept,
  revealed,
) {
  const list = [],
    drawOrder = order && order.length === numShapes ? order : null;
  const liveGroups =
    revealed && revealed.size && stride >= 28
      ? hiddenGroupsHolding(metaFloats, numShapes, stride, drawOrder, revealed)
      : null;
  for (let p = 0; p < numShapes; p++) {
    const s = drawOrder ? drawOrder[p] : p;
    // Fully occluded by a later opaque shape (occlusionCull.js): drawing it adds
    // nothing but a conflated AA edge under the occluder's boundary.
    if (culled && culled.has(s)) continue;
    const b = s * stride;
    const fillA = metaAlt ? Math.max(metaFloats[b + 7], metaAlt[b + 7]) : metaFloats[b + 7];
    const strokeA = metaAlt ? Math.max(metaFloats[b + 11], metaAlt[b + 11]) : metaFloats[b + 11];
    const sw = metaAlt ? Math.max(metaFloats[b + 12], metaAlt[b + 12]) : metaFloats[b + 12];
    const accum = Math.floor(metaFloats[b + 14] + 0.5);
    const stroked = sw > 0 && strokeA > 0;
    const flagsShape = stride >= 28 ? Math.floor(metaFloats[b + 27] + 0.5) : 0;
    if ((flagsShape & 256) !== 0) continue; // Resource rows are never scene operations.
    if ((flagsShape & FS_HIDDEN) !== 0) {
      // A row kept hidden draws only while an override reveals it; its group brackets only while they hold one.
      if (
        (flagsShape & (64 | 128)) !== 0
          ? !(liveGroups && liveGroups.has(p))
          : !(revealed && revealed.has(s))
      )
        continue;
    }
    if ((flagsShape & 64) !== 0) {
      list.push({
        kind: 'groupBegin',
        shapeIdx: s, // structural meta row; opacity can morph
        opacity: metaFloats[b + 7],
        filterId: Math.round(metaFloats[b + 32]),
        blendMode: Math.floor(metaFloats[b + 33] + 0.5),
        isolation: Math.floor(metaFloats[b + 34] + 0.5),
      });
      continue;
    }
    if ((flagsShape & 128) !== 0) {
      list.push({ kind: 'groupEnd' });
      continue;
    }
    // FLAG_COLR_MASK_ONLY (bit 256): this shape exists only to supply
    // a per-gid alpha mask for a COLRv1 PaintGlyph node; the renderer
    // picks it up via its `colrGraphId` + colrGraphs[].masks lookup.
    // No colored render op is emitted.
    if ((flagsShape & 256) !== 0) continue;
    // A kept alpha-0 row (FS_KEPT_INVISIBLE) is in the list only when asked for (`includeKept`, while an override table gives one ink): left out it
    // costs the draw nothing, as a row the import dropped never did.
    if (
      (fillA > 0 ||
        (stroked && strokeA > 0) ||
        (includeKept === true && (flagsShape & FS_KEPT_INVISIBLE) !== 0)) &&
      accum > 0
    ) {
      const chunk = chunkByShape[s];
      if (!chunk) continue;
      const filterId = stride >= 33 ? Math.floor(metaFloats[b + 32] + 0.5) : 0;
      // Per-leaf mix-blend-mode. blendMode == 0 (normal) renders via the
      // coalesced run; non-zero requires an offscreen FBO route + the
      // composite shader, just like a filter. blendMode lives at texel
      // 8.y (= float offset 33).
      const blendMode = stride >= 34 ? Math.floor(metaFloats[b + 33] + 0.5) : 0;
      const op = { kind: 'fillShape', shapeIdx: s, chunk };
      if (filterId > 0) {
        const g = filterGraphs && filterGraphs[filterId - 1];
        if (g) op.filterGraphId = filterId;
        else op.filterId = filterId;
      }
      // colrGraphId lives at texel 11 slot 45 (texel-11.y). Slot 44
      // (texel-11.x) is reserved for primKind, hence the stride>=46
      // gate. Pre-bump bundles with stride<46 see colrGraphId = 0
      // and render via the regular coverage fill path.
      const colrGraphId = stride >= 46 ? Math.floor(metaFloats[b + 45] + 0.5) : 0;
      if (colrGraphId > 0) op.colrGraphId = colrGraphId;
      if (blendMode > 0) op.blendMode = blendMode;
      if (filterId > 0 && blendMode === 19) {
        // Filter output composites by source-over; apply CSS additive composition after it.
        // This synthetic bracket has no metadata row whose opacity can be morphed.
        list.push({ kind: 'groupBegin', shapeIdx: -1, opacity: 1, blendMode, isolation: 1 });
        list.push({ ...op, blendMode: 0 });
        list.push({ kind: 'groupEnd' });
      } else list.push(op);
    }
  }
  return list;
}

/// Brings the rows kept at alpha 0 into the draw list while an override table gives one of them ink (an absolute fill or stroke on it), and the rows kept hidden (importSvg keepHidden) while the table reveals them
/// (`reveal: true` on the row or on a group above it), and takes them out again when none does. A bundle with no such rows
/// (`_keptRows` and `_hiddenRows` null) pays nothing. While any is in, the list is the UNCULLED full list, so the occlusion cull cannot
/// hide what the override reveals.
export function syncKeptRows(bundle, table) {
  const kept = bundle && bundle._keptRows,
    hid = bundle && bundle._hiddenRows;
  if (!kept && !hid) return;
  const shown = bundle._keptShown === true;
  // Nothing to look at again: the same table in the same state, and the list this function left is still the bundle's.
  if (
    bundle._keptTable === table &&
    bundle._keptRevision === (table ? table.revision : 0) &&
    bundle._keptList === bundle.drawList
  )
    return;
  const P = table && table.packedBuffer;
  let reveal = false,
    rev = null,
    sig = '';
  if (kept && P)
    for (let i = 0; i < kept.length; i++) {
      const o = kept[i] * 24 + 7;
      if (o < P.length && (Math.floor(P[o] + 0.5) & 3) !== 0) {
        reveal = true;
        break;
      }
    }
  if (hid && P)
    for (let i = 0; i < hid.length; i++) {
      const r = hid[i],
        o = r * 24;
      if (o + 7 < P.length && (Math.floor(P[o + 7] + 0.5) & 16) !== 0 && P[o + 6] > 0.004) {
        (rev || (rev = new Set())).add(r);
        sig += r + ',';
      }
    }
  const settle = () => {
    bundle._keptTable = table;
    bundle._keptRevision = table ? table.revision : 0;
    bundle._keptList = bundle.drawList;
  };
  if (reveal || rev) {
    if (
      shown &&
      bundle.drawList === bundle._keptFull &&
      bundle._keptSig === sig &&
      bundle._keptAll === reveal
    ) {
      settle();
      return;
    }
    const full = buildDrawList(
      bundle.metaFloats,
      bundle.numShapes,
      bundle.metaFloatsPerShape,
      bundle.chunkByShape,
      bundle.filterGraphs,
      null,
      bundle._drawOrder,
      bundle._drawAltMeta,
      reveal,
      rev,
    );
    bundle._keptFull = full;
    bundle._keptShown = true;
    bundle._keptSig = sig;
    bundle._keptAll = reveal;
    bundle.drawList = full;
    bundle.drawListUnculled = full;
    bundle._cullGen = (bundle._cullGen | 0) + 1;
  } else if (shown) {
    bundle._keptFull = null;
    bundle._keptShown = false;
    bundle._keptSig = '';
    bundle._keptAll = false;
    // a cull an override or a sprite draw retired stays retired: the lean list it goes back to keeps the rows the cull dropped
    const set = bundle._cullRetired ? null : bundle._culledShapes || null;
    const lean = buildDrawList(
      bundle.metaFloats,
      bundle.numShapes,
      bundle.metaFloatsPerShape,
      bundle.chunkByShape,
      bundle.filterGraphs,
      set,
      bundle._drawOrder,
      bundle._drawAltMeta,
    );
    bundle.drawList = lean;
    bundle.drawListUnculled = set
      ? buildDrawList(
          bundle.metaFloats,
          bundle.numShapes,
          bundle.metaFloatsPerShape,
          bundle.chunkByShape,
          bundle.filterGraphs,
          null,
          bundle._drawOrder,
          bundle._drawAltMeta,
        )
      : lean;
    bundle._cullGen = (bundle._cullGen | 0) + 1;
  }
  settle();
}

/// Build a MantleBundle from the importer's in-memory section dict.
/// The bundle owns its GL textures + ArrayBuffers (mesh + shapeIdx
/// floats) and must be `.dispose()`d to free GPU memory.
// Newly created bundles awaiting fill-program warm-up. A bundle belongs to a WebGL context, but the
// WARM belongs to a RENDERER: each one compiles and caches its own fill-variant programs, so a
// bundle is only warm for the renderer that was handed it. ONE QUEUE PER CONTEXT, POPPED, would not
// work: with two renderers on a canvas whichever one's warm tick ran first would take every bundle and
// the other would draw all of them on the universal program for good; a renderer created second, with
// a peer already draining the queue each frame, would never warm a single bundle; and precompileFills
// drains the same queue, so one renderer's load-screen precompile would empty the other's.
//
// So each renderer takes a CONSUMER and drains its own queue, and an enqueue is a broadcast. The
// per-context BACKLOG is what a consumer registering later starts from — a renderer created after
// the bundles it will draw still warms them, which is the one thing a single shared queue gets
// right and the reason it cannot simply be per-renderer.
const _prewarmByGl = new WeakMap(); // gl → { backlog: bundle[], consumers: Set<{ gl, q }> }
const PREWARM_CAP = 4096;

function _prewarmCtx(gl) {
  let c = _prewarmByGl.get(gl);
  const generation = resourceGeneration(gl);
  if (!c || c.generation !== generation) {
    c = { generation, backlog: [], consumers: new Set(), pruneAt: 64 };
    _prewarmByGl.set(gl, c);
  }
  return c;
}

/// A renderer's own prewarm queue, seeded with the bundles its context already holds.
/// Released by removeFillPrewarmConsumer on renderer disposal.
export function addFillPrewarmConsumer(gl) {
  if (!gl) return null;
  const c = _prewarmCtx(gl);
  const consumer = { gl, context: c, q: c.backlog.slice() };
  c.consumers.add(consumer);
  return consumer;
}

export function removeFillPrewarmConsumer(consumer) {
  if (!consumer) return;
  const c = consumer.context;
  if (c) c.consumers.delete(consumer);
  consumer.q.length = 0;
}

/// Drop a disposed bundle from the per-context backlog and every renderer's own queue (see _prewarmRef).
function _forgetPrewarm(gl, bundle) {
  const c = _prewarmByGl.get(gl);
  if (!c) return;
  const drop = (a) => {
    for (let i = a.length - 1; i >= 0; i--) if (a[i].deref() === bundle) a.splice(i, 1);
  };
  drop(c.backlog);
  for (const consumer of c.consumers) drop(consumer.q);
}

const _prewarmRef = (bundle) => new WeakRef(bundle);

export function enqueueFillPrewarm(gl, bundle) {
  if (
    !gl ||
    !bundle ||
    (bundle._resourceGeneration != null && bundle._resourceGeneration !== resourceGeneration(gl))
  )
    return;
  const c = _prewarmCtx(gl);
  // The backlog OUTLIVES a drain — it is what a later renderer starts from — so it is the one list
  // that can accumulate dead bundles. Prune on a doubling schedule: amortized O(1) per enqueue.
  if (c.backlog.length >= c.pruneAt) {
    c.backlog = c.backlog.filter((r) => {
      const b = r.deref();
      return b && !b._disposed;
    });
    c.pruneAt = Math.max(64, c.backlog.length * 2);
  }
  if (c.backlog.length >= PREWARM_CAP) c.backlog.shift(); // drop the oldest, never the newest
  const ref = _prewarmRef(bundle);
  c.backlog.push(ref);
  for (const consumer of c.consumers) if (consumer.q.length < PREWARM_CAP) consumer.q.push(ref);
}

/// The next bundle this renderer has not been handed yet. LIFO: the newest bundle is the one about
/// to be drawn, and the frame budget may not reach the rest this tick.
export function takeFillPrewarm(consumer, skip) {
  const q = consumer && consumer.q;
  while (q && q.length) {
    const bundle = q.pop().deref();
    if (bundle && !bundle._disposed && !(skip && skip(bundle))) return bundle;
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.preferBezout]
 * @param {object} [opts.cpatchBake]
 * @param {boolean} [opts.recolor] Legacy option, accepted and ignored.
 * @param {boolean} [opts.occlusionCull=true] Drop shapes a later opaque shape fully
 *   covers. They add nothing but a conflated AA edge (see occlusionCull.js). Set
 *   false to draw every shape exactly as authored.
 */
export function createBundle(gl, sections, opts) {
  assertUsableGl('createBundle', gl, true);
  const L = ledgerFor(gl),
    prep = beginPreparation('createBundle', gl);
  L.pushScope('bundle');
  try {
    const bundle = createBundleImpl(gl, sections, opts);
    L.adopt(bundle, 'bundle');
    return bundle;
  } finally {
    L.popScope();
    endPreparation(prep);
  }
}

function createBundleImpl(gl, sections, opts) {
  assertUsableGl('createBundle', gl, true);
  {
    const g = peekGate(gl);
    if (g) g.touch();
  } // (an upload is about to happen: gpuGate.js)
  checkSectionsHead(sections);
  const flags = sections.flags || 0;
  const pairBands = (flags & 8) !== 0; // BUNDLE_FLAG_PAIR_BANDS
  const noVBands = (flags & 16) !== 0; // BUNDLE_FLAG_NO_VBANDS
  // 0 = unknown (older bundles) ⇒ assume every type is present.
  const segTypeMask = sections.segTypeMask | 0 || 0xf;
  const parsed = parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  // (before the body check and before anything is allocated)
  // Every table that grows with an item count must fit the device, or the upload fails with a GL error and the bundle draws
  // nothing -- throw instead, before anything is allocated.
  checkTableFits(gl, 'meta (shape) table', META_COLS, parsed.numShapes);
  if (sections.gradients && sections.gradients.byteLength)
    checkTableFits(gl, 'gradient table', GRAD_COLS, sections.gradients.byteLength / 64);
  if (sections.dashes && sections.dashes.byteLength)
    checkTableFits(gl, 'dash table', DASH_COLS, sections.dashes.byteLength / 256);
  if (sections.filterTab && sections.filterTab.byteLength)
    checkTableFits(gl, 'filter table', FILTER_COLS, sections.filterTab.byteLength / 96);
  checkPlaneFits(
    gl,
    'curve plane',
    4096,
    Math.ceil((sections.curves ? sections.curves.byteLength / 4 : 0) / (4 * TEX_W)),
  );
  checkPlaneFits(
    gl,
    'band plane',
    4096,
    Math.ceil((sections.bands ? sections.bands.byteLength / 4 : 0) / (4 * TEX_W)),
  );
  if (sections.imageAtlas && sections.imageAtlasDim)
    checkPlaneFits(gl, 'image atlas', sections.imageAtlasDim[0], sections.imageAtlasDim[1]);
  if (sections.secondaryImageAtlas && sections.secondaryImageAtlasDim)
    checkPlaneFits(
      gl,
      'secondary image atlas',
      sections.secondaryImageAtlasDim[0],
      sections.secondaryImageAtlasDim[1],
    );
  checkSectionsBody(sections, parsed);
  const stride = parsed.floatsPerShape;
  const numShapes = parsed.numShapes;
  const metaFloats = parsed.metaFloats;

  // Mean bbox area of a FILL-BEARING shape, in the bundle's own units. AAC's cost
  // on small shapes is register pressure paid PER FRAGMENT, so its win is governed
  // by how many fragments a shape covers — see fillPass's `aacFill: 'auto'`.
  //
  // Rows with no fill are excluded, and that is the whole point: every engine
  // branch in mantle.frag sits inside `doFill ? renderFillX(…) : 0.0`, and no
  // engine define reaches the stroke coverage block. A stroke-only row therefore
  // contributes bbox area to a decision that cannot change one of its pixels, and
  // averaging it in makes a stroke-heavy bundle look bigger or smaller than its
  // fill work really is. Every consumer of this number is a fill-engine gate.
  let meanFillShapeArea = 0,
    numFillShapes = 0;
  for (let i = 0; i < numShapes; i++) {
    const b = i * stride;
    if (!(metaFloats[b + 7] > 0)) continue; // MT_FILL.a — the shader's own doFill
    numFillShapes++;
    const w = metaFloats[b + 2] - metaFloats[b + 0];
    const h = metaFloats[b + 3] - metaFloats[b + 1];
    if (w > 0 && h > 0) meanFillShapeArea += w * h;
  }
  if (numFillShapes) meanFillShapeArea /= numFillShapes;

  // Mean segments per shape is used by the LB size gate, whose mesh cost scales
  // with geometry while its benefit scales with covered fragments.
  const meanSegsPerShape = numShapes ? (sections.totalSegments | 0) / numShapes : 0;

  // --- CPU-side per-shape state ---
  const gidToShapeIdx = buildGidToShapeIdx(metaFloats, numShapes, stride);
  const coverQuadFloats =
    sections.curveGeom && sections.curveGeom.byteLength
      ? new Float32Array(sections.curveGeom)
      : null;
  const coverQuadChunks = parseCoverQuadChunks(coverQuadFloats, flags);
  const hybridShapeIdxFloats = coverQuadFloats
    ? buildShapeIdxFloats(coverQuadFloats, coverQuadChunks, gidToShapeIdx)
    : null;
  // Header-free VBO: pack chunk body verts contiguously (drops the dead
  // one-vertex chunk headers) and stamp each chunk's `vboStart` so the
  // renderer can batch adjacent chunks into a single drawArrays. See
  // buildStrippedCoverQuad for why the interleaved headers break batching.
  const strippedCover = coverQuadFloats
    ? buildStrippedCoverQuad(coverQuadFloats, coverQuadChunks, hybridShapeIdxFloats)
    : null;
  let coverQuadVboFloats = strippedCover ? strippedCover.verts : null;
  let hybridShapeIdxVboFloats = strippedCover ? strippedCover.shapeIdx : null;
  const chunkByShape = new Array(numShapes);
  for (const c of coverQuadChunks) {
    const si = gidToShapeIdx.get(c.gid);
    if (si !== undefined) chunkByShape[si] = c;
  }
  // the conforming strip of each stroke row (svg/strokeStrip.js) rides the same header-free VBO planes, appended after
  // the quads, and its chunk remembers where (`chunk._strip`). Which of the two a draw uses is `R._applyStripMode` (per draw,
  // from the mode the draw allows); the base chunk.start / vboStart / count are untouched, so every consumer that does not know
  // about the strip (cache bake, instanced fill, occlusion) still sees the quad.
  const stripChunks = [];
  if (sections.stripRows && strippedCover) {
    let extra = 0;
    for (let si = 0; si < numShapes; si++) {
      const sr = sections.stripRows[si];
      if (sr && chunkByShape[si]) extra += (sr.verts.length / 12) | 0;
    }
    if (extra > 0) {
      const base = (coverQuadVboFloats.length / 12) | 0;
      const nv = new Float32Array(coverQuadVboFloats.length + extra * 12);
      nv.set(coverQuadVboFloats);
      const ns = new Float32Array(base + extra);
      ns.set(hybridShapeIdxVboFloats);
      let at = base;
      for (let si = 0; si < numShapes; si++) {
        const sr = sections.stripRows[si],
          c = chunkByShape[si];
        if (!sr || !c) continue;
        const n = (sr.verts.length / 12) | 0;
        nv.set(sr.verts, at * 12);
        ns.fill(si, at, at + n);
        c._strip = {
          start: at,
          count: n,
          overlap: !!sr.overlap,
          row: si,
          quadArea: sr.quadArea || 0,
          stripArea: sr.stripArea || 0,
        };
        stripChunks.push(c);
        at += n;
      }
      coverQuadVboFloats = nv;
      hybridShapeIdxVboFloats = ns;
    }
  }

  const mh = Math.max(1, numShapes);
  const metaPlane = buildMetaPlane(metaFloats, numShapes, stride);
  const metaTex = makeTableTex(gl, metaPlane, FULL_META_W, mh);

  let gradientTex = null,
    gradientStopsTex = null,
    gradientCount = 0;
  let gradientStopsCount = 0;
  // CPU-side copy of the packed stops bytes. Held for animation
  // drivers (shape-morph) that lerp stops per-frame and need a known-
  // shape source-of-truth alongside the GL texture they update via
  // texSubImage2D. Cheap (1 byte per channel × stops count).
  let gradientStopsBytes = null;
  let gradientFloats = null;
  if (sections.gradients && sections.gradients.byteLength) {
    const gFloats = new Float32Array(sections.gradients);
    gradientCount = gFloats.length / 16;
    gradientFloats = gFloats;
    gradientTex = makeTableTex(gl, gFloats, GRAD_COLS, gradientCount);
  }
  // Exact-stop LUT — one or two RGBA8 texels per stop (bundle/layout.js):
  // straight (R,G,B,alpha) + an offset texel, or (R,G,B,offset) for an
  // all-opaque gradient. The shader premultiplies after sampling so
  // per-stop alpha survives compositing (a premultiplied-at-encode
  // layout would drop it). Shared format with the COLRv1 dispatch —
  // both halves read via _gradientHelpers.glsl. Rows of GRAD_STOPS_LUT_W
  // texels: a LUT that fits one row is one row of its own length, a longer
  // one wraps (padded to whole rows) instead of outgrowing MAX_TEXTURE_SIZE.
  //
  // Not only with an SVG gradient table: a text bundle's COLRv1 gradients bring a LUT and no table,
  // and uploading it only beside a table left every one of them without stops -- drawn transparent.
  if (sections.gradientStops && sections.gradientStops.byteLength) {
    const stopsBytes = new Uint8Array(sections.gradientStops);
    const texels = stopsBytes.length / 4;
    gradientStopsCount = sections.gradientStopsCount || texels;
    gradientStopsBytes = stopsBytes;
    const [lutW, lutH] = gradientStopsLutSize(texels);
    gradientStopsTex = makeTex(
      gl,
      padGradientStopsLut(stopsBytes),
      lutW,
      lutH,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
    );
    gl.bindTexture(gl.TEXTURE_2D, gradientStopsTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  let dashTex = null,
    dashCount = 0,
    dashFloats = null;
  if (sections.dashes && sections.dashes.byteLength) {
    dashFloats = new Float32Array(sections.dashes);
    dashCount = dashFloats.length / (16 * 4);
    dashTex = makeTableTex(gl, dashFloats, DASH_COLS, dashCount);
  }

  let filterTex = null,
    lastFilterFloats = null;
  if (sections.filterTab && sections.filterTab.byteLength) {
    const fFloats = new Float32Array(sections.filterTab);
    const filterCount = fFloats.length / (6 * 4);
    filterTex = makeTableTex(gl, fFloats, FILTER_COLS, filterCount);
    lastFilterFloats = fFloats;
  }

  // Per-convolve-filter kernels, 25 floats each (row-major at the kernel's own order). CPU-side only:
  // the convolve pass flips a row into its uKernel uniform per draw; there is no texture.
  let lastKernelFloats = null;
  if (sections.kernelTab && sections.kernelTab.byteLength) {
    lastKernelFloats = new Float32Array(sections.kernelTab);
  }

  let imageAtlasTex = null,
    imageAtlasSize = [0, 0];
  if (sections.imageAtlas && sections.imageAtlas.byteLength && sections.imageAtlasDim) {
    const [aw, ah] = sections.imageAtlasDim;
    // The atlas section is STRAIGHT RGBA (the wire contract, and what hit testing and the native export read); the texture the
    // shader filters is premultiplied, so a bilinear / mip sample next to a transparent texel does not darken.
    const px = premultiplyRgba8(new Uint8Array(sections.imageAtlas));
    imageAtlasTex = makeTex(gl, px, aw, ah, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, imageAtlasTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    imageAtlasSize = [aw, ah];
  }
  let secondaryImageAtlasTex = null,
    secondaryImageAtlasSize = [0, 0];
  if (
    sections.secondaryImageAtlas &&
    sections.secondaryImageAtlas.byteLength &&
    sections.secondaryImageAtlasDim
  ) {
    const [aw, ah] = sections.secondaryImageAtlasDim;
    const px = premultiplyRgba8(new Uint8Array(sections.secondaryImageAtlas));
    secondaryImageAtlasTex = makeTex(gl, px, aw, ah, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, secondaryImageAtlasTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    secondaryImageAtlasSize = [aw, ah];
  }

  // Curve + band textures. Both are RGBA32F, TEX_W-wide, height
  // capacity-padded to the next full row so the shader's row-wrap
  // logic (MantleCalcBandLoc) sees a power-of-two-aligned grid.
  const cFR = new Float32Array(sections.curves);
  const cH = Math.max(1, Math.ceil(cFR.length / (4 * TEX_W)));
  const curveTex = makePlaneTex(gl, cFR, cH);

  // Per-shape curve-buffer ranges in float units. Prefer the
  // importer-emitted ranges (required so mask geometry interpolates
  // correctly across a shape morph). Fall back to inferring from meta
  // texel 4 (glyphLoc) for bundles without explicit ranges — that
  // inference is wrong on multi-shape bundles (glyphLoc is a bandBuf
  // index, not a curveBuf offset) but fine for single-shape SVGs.
  const curveRangesByShape = sections.curveRangesByShape
    ? sections.curveRangesByShape.map((r) => ({ begin: r.begin | 0, end: r.end | 0 }))
    : buildCurveRangesByShape(metaFloats, numShapes, stride, cFR.length);

  // Occlusion cull. A shape a later OPAQUE shape completely covers adds nothing to
  // the image — except its ANTIALIASED EDGE, which painter compositing blends in a
  // SECOND time underneath the occluder's own edge, painting a 1px fringe of the
  // hidden shape's color along every shared boundary (the classic CONFLATION
  // artifact — Chrome shows the same fringe on a straight shared edge; see
  // occlusionCull.js). Art that stacks coincident layers — a duplicate ridge under a
  // translucent one — therefore grew a colored, too-dark AA edge. Culling removes
  // the artifact by removing a draw that was invisible anyway: it costs less than
  // nothing at render time.
  //
  // TWO HALVES, TWO SCHEDULES. The CORRECTNESS half — shapes that touch their
  // occluder's boundary, which are the ones that conflate — is cheap and runs INLINE:
  // it must hold on the very first frame or the fringe is visible. The PERF half —
  // hidden shapes that keep clear of the boundary — buys draws and nothing else, so
  // it is handed to a WORKER and applied when it lands. Nothing looks wrong while it
  // is in flight, and off the load path it can afford to be thorough.
  // Opt out with opts.occlusionCull === false.
  let culled = null;
  const cullEnabled = !(opts && opts.occlusionCull === false);
  if (cullEnabled) {
    try {
      const set = computeOccludedShapes(
        cFR,
        curveRangesByShape,
        metaFloats,
        numShapes,
        stride,
        'coincident',
      );
      if (set && set.size) culled = set;
    } catch {
      culled = null;
    } // a cull is an optimization — never fail the build over it
  }
  const drawAlt = sections._dstAlignedMetaF32 || null;
  // The rows kept at alpha 0 that the lean draw list leaves out: an override that gives one ink brings them back (syncKeptRows).
  let keptRows = null,
    hiddenRows = null;
  if (stride >= 28) {
    const inks = (m, b) => m[b + 7] > 0 || (m[b + 11] > 0 && m[b + 12] > 0); // a fill with alpha, or a stroke with alpha and width
    for (let s = 0; s < numShapes; s++) {
      const b = s * stride,
        flags = Math.floor(metaFloats[b + 27] + 0.5);
      // The rows kept hidden (importSvg keepHidden) that the draw list leaves out until an override reveals them. Group scaffolding follows its rows.
      if ((flags & FS_HIDDEN) !== 0 && (flags & (64 | 128 | 256)) === 0)
        (hiddenRows || (hiddenRows = [])).push(s);
      if ((flags & FS_KEPT_INVISIBLE) === 0) continue;
      if (inks(metaFloats, b) || (drawAlt && inks(drawAlt, b))) continue;
      (keptRows || (keptRows = [])).push(s);
    }
  }
  const drawList = buildDrawList(
    metaFloats,
    numShapes,
    stride,
    chunkByShape,
    sections.filterGraphs,
    culled,
    sections.drawOrder,
    drawAlt,
  );
  // Keep the UNCULLED list: the cull is only valid for the geometry as authored, and
  // a bundle whose shapes later MOVE (a streamed road, a morph) must fall back to
  // drawing everything — a shape hidden at load is not hidden once it slides out.
  const drawListUnculled = culled
    ? buildDrawList(
        metaFloats,
        numShapes,
        stride,
        chunkByShape,
        sections.filterGraphs,
        null,
        sections.drawOrder,
        drawAlt,
      )
    : drawList;

  const bFR = new Float32Array(sections.bands);
  const bH = Math.max(1, Math.ceil(bFR.length / (4 * TEX_W)));
  const bandTex = makePlaneTex(gl, bFR, bH);

  const bundle = {
    _drawAltMeta: drawAlt,
    _keptRows: keptRows,
    _hiddenRows: hiddenRows,
    _resourceGeneration: resourceGeneration(gl),
    // CPU-side state
    // Unique per bundle, for renderer-side caches keyed by bundle. filterGraphId and
    // filterId are BUNDLE-LOCAL (every bundle's first filter is 1), so a cache keyed on
    // those alone silently shares one entry between unrelated bundles.
    uid: ++_bundleUidSeq,

    flags,
    pairBands, // BUNDLE_FLAG_PAIR_BANDS: each H band covers a stripe PAIR
    noVBands, // BUNDLE_FLAG_NO_VBANDS: Slug's V ray would degenerate — AAC only
    meanSegsPerShape,
    segTypeMask, // which of LINE/QUAD/CUBIC/ARC this bundle actually contains
    streamable: !!sections.streamable, // its geometry is replaced by updateBundleGeometry: what it contains now is not what it will contain (the warm image pins its content omissions)
    meanFillShapeArea, // mean bbox area of a fill-bearing shape (for aacFill:'auto')
    numFillShapes, // 0 ⇒ no engine define can change a pixel of this bundle
    noAaFill: !!sections.noAaFill, // every drawn fill is opaque-stroke-covered ⇒ no-AA fill OK
    noAaMixed: !!sections.noAaMixed, // SOME row is ⇒ per-row hard bits (MANTLE_HARD_MIXED)
    minStrokeEmWMixed: sections.minStrokeEmWMixed || 0,
    noAaTree: !!sections.noAaTree, // …and cubic/arc-bearing ⇒ GWN tree baked ⇒ route tree-hard (not band-hard)
    gwnUnsafe: !!sections.gwnUnsafe, // a self-closing cubic / loop / cusp is baked: the GWN+SDF AA kernel is vetoed for this bundle
    gwnTree: !!sections.gwnTree, // importSvg({gwnTree:true}) — required by every GWN kernel
    minStrokeEmW: sections.minStrokeEmW || 0, // min covering-stroke width (em); draw gate needs ≥2 device px
    numShapes,
    globalBBox: parsed.globalBBox,
    frameFixed: !!sections.frameFixed, // the author fixed the frame (fixedBBox, preserveViewport): updateBundleGeometry keeps globalBBox
    // The bundle's coordinates (curve table, bbox, gradients, regions) are RELATIVE to this document-space point, a float64
    // [x, y] ([0, 0] for art near the origin; bundle/layout.js, svg/importer.js). document = stored + origin. Every API that
    // takes or returns a position in bundle units (fillHit*, bundleDrawMatrix, globalBBox, overrides) is in the stored frame.
    origin: sectionsOrigin(sections),
    // Optional font-wide + per-run typographic metrics. Populated for
    // text bundles; null for SVG/raster bundles (no baseline). Typographic
    // layout reads these instead of the per-string ink-tight globalBBox.
    fontMetrics: sections.fontMetrics || null,
    runMetrics: sections.runMetrics || null,
    // Per-shape stable string ids (SVG `id=` attribute, "" when absent).
    // Used by createOverrideTable + hitTest for stable shape addressing
    // across rebuilds. Length === numShapes.
    shapeIds: sections.shapeIds ? sections.shapeIds.slice() : new Array(numShapes).fill(''),
    // Per-shape <a href> (the innermost enclosing anchor's href, xlink:href as the fallback; ""
    // outside every anchor). fillHitHref reads it to answer the link under a point. Length ===
    // numShapes, like shapeIds.
    shapeHrefs:
      sections.shapeHrefs && sections.shapeHrefs.length === numShapes
        ? sections.shapeHrefs.slice()
        : new Array(numShapes).fill(''),
    // What the pointer can target per shape (svg/hitBits.js: HIT_FILL | HIT_STROKE | HIT_BBOX of the row's region), or null on a
    // bundle that did not come from importSvg (the hit test then reads the row's paint). `hitOnly` holds the regions that draw
    // nothing but can still be targeted (a transparent fill, a hidden leaf under pointer-events: all); only hit queries read it.
    hitBits: sections.hitBits && sections.hitBits.length === numShapes ? sections.hitBits : null,
    hitOnly: sections.hitOnly || null,
    hitOnlyTo: sections.hitOnlyTo || null,
    // The id-bearing containers (`<g>`, `<use>`, nested `<svg>`) and which of them each drawn row sits in, so an override on a group id
    // reaches the rows under it (animation/overrideKeys.js): { format, groupNames, groupParent, drawnGroup }. null when no row sits under an
    // element with an id, and on a bundle that did not come from importSvg.
    groupTree: sections.groupTree || null,
    // What the import dropped for being marked as not drawn, by class (svg/dropped.js); null when nothing was.
    dropped: sections.dropped || null,
    // Original SVG markup, retained only when imported with
    // { retainSource: true } (null otherwise). Carried so the SVG-export
    // path and the native morph can reconstruct the current frame as
    // markup without a GPU read-back.
    svgSource: sections.svgSource || null,
    strokeMiterLimits: sections.strokeMiterLimits || null,
    shapeDomPaths: sections.shapeDomPaths || null,
    shapeDomIndex: sections.shapeDomIndex || null,
    // animatable-clipper API: { clipSvgId: [firstMetaRow, lastMetaRow] }
    // — 0-based row range of each <clipPath>'s layer rows. Drives the
    // override table's setClipper(svgId, opts) so callers can apply a
    // runtime 2D affine to a clip mask without touching shape geometry.
    clipperRowSets: sections.clipperRowSets || null,
    clipperRows: sections.clipperRows || {},
    // Sprite-sheet addressing: { spriteId: [firstRow,lastRow] }
    // for top-level id'd groups/shapes. Drives renderer.drawSprite.
    spriteRanges: sections.spriteRanges || {},
    spriteRangesNonContiguous: sections.spriteRangesNonContiguous || [],
    metaFloats,
    metaFloatsPerShape: stride,
    // Phase-1 Bezout preference. It must be set
    // HERE, at construction: createBundle kicks the off-thread LB build, and _lbBuilderFn
    // short-circuits on `_lbWorkerPendingGen === reqGen`, so a flag assigned after
    // createBundle never reaches the build and reads as a silent no-op.
    _preferBezout: !!(opts && opts.preferBezout),
    // Legacy decomposition traces, supplied as bytes or a decoded Map.
    // Prepared whole-paint packing declines explicit traces.
    _cpatchTraces:
      opts && opts.cpatchBake
        ? opts.cpatchBake instanceof Map
          ? opts.cpatchBake
          : decodeTraceBake(opts.cpatchBake)
        : null,
    coverQuadFloats,
    // the cover mesh the import made; a nine-slice or a streamed rebuild REPLACES it, and a strip cover built for the
    // import's geometry is then stale (unifiedFillDraw stripModeFor).
    _stripCoverRef: coverQuadFloats,
    _stripChunks: stripChunks,
    coverQuadChunks,
    hybridShapeIdxFloats,
    // Header-free, batch-friendly VBO planes (chunks carry `vboStart`).
    coverQuadVboFloats,
    hybridShapeIdxVboFloats,
    chunkByShape,
    // CPU-side curve float plane (UNPADDED). Kept so shape morph can lerp
    // curves between bundles without re-reading from GL. `curveFloats.length`
    // is the unpadded count; the row-padded plane uploaded to curveTex is
    // not built (makePlaneTex uploads rows from `curveFloats`).
    curveFloats: cFR,
    // The unquantized twin of curveFloats, when the importer kept one. Only the CPatch converter
    // reads it, and only at build time — its precision is what decides how many patches a shape
    // decomposes into. Released after conversion.
    curveFloats64: sections.curves64 ? new Float64Array(sections.curves64) : null,
    // CPU-side band float plane (UNPADDED). Required by morph + animation
    // primitives that build a derived bundle without round-tripping the
    // importer. Reads use the same offsets as the GL bandTex; writes must
    // mirror both. The row-padded plane is not built (makePlaneTex uploads rows from `bandFloats`).
    bandFloats: bFR,
    // Per-shape curve-buffer ranges in float units. Length == numShapes;
    // each entry `{ begin, end }` is a half-open slice of `curveFloats`.
    // The last shape's `end` is `curveFloats.length`.
    curveRangesByShape,
    // rows whose bands were built without a contained contour keep their authored band region here (null: none).
    authoredBandsByShape: sections.authoredBandsByShape || null,
    fillNormByShape: sections.fillNormByShape || null,
    gidToShapeIdx,
    drawList,
    drawListUnculled,
    _culledShapes: culled,
    // Bumped whenever the CULL swaps drawList. The cull runs off-thread and lands without
    // touching _geomGen (the geometry did not move), so anything caching a draw-list
    // derivative against the geometry gen would keep a pre-cull copy forever.
    _cullGen: 0,
    // GL handles
    curveTex,
    bandTex,
    metaTex,
    dashTex,
    dashCount,
    // CPU-side dash table (UNPADDED, 16 texels = 64 floats/row, row =
    // dashId-1). Required by the hit test to gate the stroke band by
    // dasharray (mirrors the GLSL dashCovered). null when no dashes.
    dashFloats,
    gradientTex,
    gradientStopsTex,
    gradientStopsBytes,
    gradientFloats,
    gradientCount,
    gradientStopsCount,
    filterTex,
    lastFilterFloats,
    lastKernelFloats,
    // Optional CPU-only filter-graph table (one entry per graph-typed
    // filter; populated for multi-primitive chains the single-kind path
    // can't represent). The renderer prefers op.filterGraphId when set,
    // falling back to op.filterId (kind path).
    filterGraphs: sections.filterGraphs || null,
    filterRegions: sections.filterRegions || null, // per filter entry: [x, y, w, h, space] or null (importWalk resolveFilterRegion)
    filterRegionObb: sections.filterRegionObb || null,
    filterRegionQuads: sections.filterRegionQuads || null, // per filter entry: the region's corners [x0, y0 .. x3, y3] when a turn makes it no box, or null
    filterPrimCtms: sections.filterPrimCtms || null, // per filter entry: the referencing element's CTM [a..f], or null (identity)
    // Interior-skip occupancy: true when the importer baked interior grids
    // (opt-in). Gates the fill shader's occupancy branch so the default path is
    // untouched. Bits live in the curve buffer; descriptors in meta texel 5.
    hasOccupancy: !!sections.hasOccupancy,
    stripRows: sections.stripRows || null,
    stripOverlap: !!(sections.stripRows && sections.stripRows.some((r) => r && r.overlap)),
    // Private worker-completion markers used by deterministic prewarm/tests.
    // Rendering remains correct while either is true; the worker only adds
    // acceleration data or removes conservatively hidden draws.
    _occupancyBuildPending: false,
    _occlusionCullPending: false,
    // CPU-only COLRv1 paint-graph table — one entry per text-run color
    // glyph that carries a v1 paint tree. The COLR dispatch evaluates
    // colrGraphs[colrGraphId-1] using the coverage-rendered glyph
    // silhouette as PaintGlyph's mask. Null for SVG-only bundles.
    colrGraphs: sections.colrGraphs || null,
    // Text bundles with COLRv1 glyphs: which mask-only rows the hit test answers for, and which primary rows it must not
    // (font/textRun.js colrHitSection). Null otherwise.
    colrHit: sections.colrHit || null,
    _drawOrder: sections.drawOrder || null,
    _morphBindingAliases: sections._morphBindingAliases || null,
    imageAtlasTex,
    imageAtlasSize,
    secondaryImageAtlasTex,
    secondaryImageAtlasSize,
    // Per-imageId atlas-slot rects in pixels (atlasY, w, h). Forwarded
    // from the importer so feImage dispatch (and external hit-test
    // consumers) can look up a slot by id without touching meta texels.
    imageAtlasRects: sections.imageAtlasRects || null,
    imageAtlasSources: sections.imageAtlasSources || null,
    // Raw side-band ArrayBuffers, preserved alongside the GL textures
    // so derived-bundle builders can forward the same tables into a
    // newly composed sections dict and re-run createBundle. The textures
    // can't be reused across a new bundle (the morph rebuilds its own);
    // the raw bytes can. Null when the source asset had no entries.
    filterTab: sections.filterTab || null,
    imageAtlas: sections.imageAtlas || null,
    imageAtlasDim: sections.imageAtlasDim || null,
    secondaryImageAtlas: sections.secondaryImageAtlas || null,
    secondaryImageAtlasDim: sections.secondaryImageAtlasDim || null,
    // Total vertex count across all cover-quad chunks — handy for
    // bench stats + downstream consumers.
    get hybridVerts() {
      let total = 0;
      for (let i = 0; i < this.coverQuadChunks.length; i++) total += this.coverQuadChunks[i].count;
      return total;
    },
    /// Rewrite this bundle's fill cover-quads as 18-tri 3×3 grids so
    /// the renderer's draw pass paints into a 9-sliced target rect.
    ///
    /// First call snapshots the native-frame mesh data (so subsequent
    /// calls can rebuild from the un-rewritten baseline). Pass border
    /// = [0,0,0,0] or omit worldSize to restore the native mesh.
    ///
    /// @param {object} opts
    /// @param {number[]} opts.border     [L, B, R, T] em-space (Sprite.border channel order)
    /// @param {number[]} opts.worldSize  [W, H] target em rect; the renderer's
    ///                                   existing em→world scale lands the final size.
    /// @param {number[]} [opts.nativeBBox] [xmin, ymin, xmax, ymax] em-space;
    ///                                   the user-authored frame to slice against
    ///                                   (defaults to bundle.globalBBox).
    applyNineSlice(opts) {
      // Validate FIRST: invalid options (non-finite or negative border, bad worldSize / nativeBBox) throw here, before any
      // state below is touched. `geom` is null when the options mean "no slicing" (restores the native state).
      const geom = resolveNineSlice(
        opts,
        this._nineSliceBaseline ? this._nineSliceBaseline.globalBBox : this.globalBBox,
      );
      // Stash the native baseline once so callers can change WorldSize
      // multiple times without round-tripping through createBundle.
      if (!this._nineSliceBaseline) {
        this._nineSliceBaseline = {
          coverQuadFloats: this.coverQuadFloats,
          coverQuadChunks: this.coverQuadChunks,
          hybridShapeIdxFloats: this.hybridShapeIdxFloats,
          coverQuadVboFloats: this.coverQuadVboFloats,
          hybridShapeIdxVboFloats: this.hybridShapeIdxVboFloats,
          chunkByShape: this.chunkByShape,
          drawList: this.drawList,
          globalBBox: this.globalBBox.slice(),
        };
      }
      const baseline = this._nineSliceBaseline;
      const { meshFloats, chunks, shapeIdxFloats } = buildNineSliceMesh({
        meshFloats: baseline.coverQuadFloats,
        chunks: baseline.coverQuadChunks,
        gidToShapeIdx: this.gidToShapeIdx,
        metaFloats: this.metaFloats,
        metaStride: this.metaFloatsPerShape,
        border: opts && opts.border,
        worldSize: opts && opts.worldSize,
        nativeBBox: (opts && opts.nativeBBox) || null,
        fallbackBBox: baseline.globalBBox,
      });
      this.coverQuadFloats = meshFloats;
      this.coverQuadChunks = chunks;
      this.hybridShapeIdxFloats = shapeIdxFloats || baseline.hybridShapeIdxFloats;
      // Repack the header-free VBO planes + restamp chunk vboStart for the
      // new mesh (batching depends on vboStart tracking the current chunks).
      const strip = meshFloats
        ? buildStrippedCoverQuad(meshFloats, chunks, this.hybridShapeIdxFloats)
        : null;
      this.coverQuadVboFloats = strip ? strip.verts : null;
      this.hybridShapeIdxVboFloats = strip ? strip.shapeIdx : baseline.hybridShapeIdxVboFloats;
      // Rebuild chunkByShape so per-shape lookups land in the new chunk array.
      const cbs = new Array(this.numShapes);
      for (const c of chunks) {
        const si = this.gidToShapeIdx.get(c.gid);
        if (si !== undefined) cbs[si] = c;
      }
      this.chunkByShape = cbs;
      // drawList references chunk objects; rebuild it so per-shape ops
      // pick up the new {start, count}.
      this.drawList = buildDrawList(
        this.metaFloats,
        this.numShapes,
        this.metaFloatsPerShape,
        cbs,
        this.filterGraphs,
        null,
        this._drawOrder,
        this._drawAltMeta,
      );
      // The uncut list and the retired cull's list reference the previous chunk objects: this list is the only current one.
      this.drawListUnculled = this.drawList;
      this._drawListCulled = null;
      // Override globalBBox so the renderer's existing em→NDC pipeline
      // maps `aPos` (target em coords) to the correct viewport region.
      // Restored from baseline when border is zero or worldSize collapses.
      if (geom) {
        // Anchor at native-em origin; span = max(worldSize, border sum)
        // matching buildNineSliceMesh's clamping behavior.
        this.globalBBox = [geom.emL, geom.emT, geom.targetW, geom.targetH];
        this._nineSliceActive = true;
        // The cut table, for hit tests (they run on native curves and map the query point through its inverse).
        this._nineSliceGeom = geom;
      } else {
        this.globalBBox = baseline.globalBBox.slice();
        this._nineSliceActive = false;
        this._nineSliceGeom = null;
      }
      // Bump the geometry generation so a same-bundle setBundle (or the
      // analytic-route gates) sees the rewritten coverQuadFloats —
      // without the bump the documented "re-call setBundle" contract
      // hits the same-bundle fast path, which never re-uploads the mesh.
      this._geomGen = (this._geomGen | 0) + 1;
      return this;
    },
    /// Create a lightweight PER-DRAW nine-slice view of this bundle.

    /// Re-size an instance by calling inst.applyNineSlice({...}) again;
    /// it rebuilds from the base's un-sliced mesh and bumps the
    /// instance's own _geomGen so bound handles re-upload.
    ///
    /// Lifetime: the BASE owns all GPU resources. inst.dispose() only
    /// invalidates the instance (and frees any draw-route state stamped
    /// on it); disposing the base invalidates every instance.
    ///
    /// @param {object} opts  same contract as applyNineSlice:
    ///   { border: [L,B,R,T], worldSize: [W,H], nativeBBox?: [x0,y0,x1,y1] }
    /// @returns {object} a bundle-shaped instance, drawable anywhere a
    ///   bundle is accepted.
    nineSliceInstance(opts) {
      const inst = Object.create(this);
      inst._nineSliceBase = this;
      // Never inherit gen-keyed route caches or LB draw-route state —
      // they are keyed on _geomGen values from ANOTHER object's
      // timeline. Start the instance clean; the nine-slice route gates
      // (_nineSliceActive) keep it off the LB/instanced fast paths.
      inst._instSimpleCache = null;
      inst._lbEligCache = null;
      inst._lbMeshes = null;
      inst._lbGen = -1;
      inst._lbHasSlug = false;
      inst._lbPaintTexGl = null;
      inst._lbRouteGl = null;
      // Baseline = the base's UN-SLICED mesh (shared by reference; the
      // arrays are immutable). If the base was itself applyNineSlice'd,
      // its stashed baseline is the true native mesh.
      inst._nineSliceBaseline = this._nineSliceBaseline || {
        coverQuadFloats: this.coverQuadFloats,
        coverQuadChunks: this.coverQuadChunks,
        hybridShapeIdxFloats: this.hybridShapeIdxFloats,
        coverQuadVboFloats: this.coverQuadVboFloats,
        hybridShapeIdxVboFloats: this.hybridShapeIdxVboFloats,
        chunkByShape: this.chunkByShape,
        drawList: this.drawList,
        globalBBox: this.globalBBox.slice(),
      };
      // Own generation counter (starts at the base's current value;
      // applyNineSlice below bumps it, so a handle freshly bound to the
      // base never confuses the two).
      inst._geomGen = this._geomGen | 0;
      /** @this {any} The instance owns only fields stamped on this derived bundle. */
      inst.dispose = function () {
        this._disposed = true;
        // Free only draw-route GL state stamped on the INSTANCE itself;
        // everything inherited belongs to the base.
        if (Object.prototype.hasOwnProperty.call(this, '_lbPaintTexGl') && this._lbPaintTexGl) {
          deleteGlResource(gl, 'Texture', this._lbPaintTexGl);
          this._lbPaintTexGl = null;
        }
        const route = /** @type {{vao?: WebGLVertexArrayObject, buf?: WebGLBuffer}|null} */ (
          Object.prototype.hasOwnProperty.call(this, '_lbRouteGl') ? this._lbRouteGl : null
        );
        if (route) {
          if (route.vao) deleteGlResource(gl, 'VertexArray', route.vao);
          if (route.buf) deleteGlResource(gl, 'Buffer', route.buf);
          this._lbRouteGl = null;
        }
        const uf = Object.prototype.hasOwnProperty.call(this, '_unifiedFill')
          ? this._unifiedFill
          : null;
        if (uf) {
          if (uf.glo) {
            deleteGlResource(gl, 'VertexArray', uf.glo.vao);
            deleteGlResource(gl, 'Buffer', uf.glo.buf);
            uf.glo = null;
          }
          if (uf.coef && uf.coef.tex) {
            deleteGlResource(gl, 'Texture', uf.coef.tex);
            uf.coef.tex = null;
          }
        }
      };
      inst.applyNineSlice(opts || {});
      return inst;
    },
    /// Release all GL resources owned by this bundle. After dispose
    /// the bundle is invalid; create a new one for the next asset.
    dispose() {
      this._disposed = true;
      this.curveFloats64 = null;
      _forgetPrewarm(gl, this);
      if (this._disposeHooks) {
        for (const f of [...this._disposeHooks]) {
          try {
            f(this);
          } catch {
            /* a hook must not stop the free */
          }
        }
        this._disposeHooks = null;
      }
      // A Set: `this.metaTex` is one of the ring's planes, and a texture is deleted once.
      for (const tex of new Set([
        this.curveTex,
        this.bandTex,
        this.metaTex,
        this.dashTex,
        this.gradientTex,
        this.gradientStopsTex,
        this.imageAtlasTex,
        this.secondaryImageAtlasTex,
        this.filterTex,
        // A morph writes its meta plane into a RING so a frame's write does not
        // land on the plane the previous frames are still reading; only one of
        // them is ever `this.metaTex`, and the rest would leak.
        ...(this._metaRing || []),
      ])) {
        if (tex) deleteGlResource(gl, 'Texture', tex);
      }
      this._metaRing = null;
      this.curveTex =
        this.bandTex =
        this.metaTex =
        this.dashTex =
        this.gradientTex =
        this.gradientStopsTex =
        this.imageAtlasTex =
        this.secondaryImageAtlasTex =
        this.filterTex =
          null;
      // LB route resources are lazily stamped onto the bundle by the draw
      // path (morphDraw) — free them here or they outlive the bundle.
      if (this._lbPaintTexGl) {
        deleteGlResource(gl, 'Texture', this._lbPaintTexGl);
        this._lbPaintTexGl = null;
      }
      if (this._lbRouteGl) {
        if (this._lbRouteGl.vao) deleteGlResource(gl, 'VertexArray', this._lbRouteGl.vao);
        if (this._lbRouteGl.buf) deleteGlResource(gl, 'Buffer', this._lbRouteGl.buf);
        this._lbRouteGl = null;
      }
      // The unified fill's stream cache owns a vertex array, a buffer and a coefficient texture (unifiedFillDraw.js).
      const uf = this._unifiedFill;
      if (uf) {
        if (uf.glo) {
          deleteGlResource(gl, 'VertexArray', uf.glo.vao);
          deleteGlResource(gl, 'Buffer', uf.glo.buf);
          uf.glo = null;
        }
        if (uf.coef && uf.coef.tex) {
          deleteGlResource(gl, 'Texture', uf.coef.tex);
          uf.coef.tex = null;
        }
      }
      this._unifiedFill = null;
    },
  };
  // AUTOMATIC mesh construction — OFF THE MAIN THREAD. The whole Loop-Blinn
  // triangulation for the bundle is handed to a Web Worker (see _lbBuilder →
  // lbWorkerPool); when it returns, the renderer stores the packed meshes and the
  // draw path upgrades from Slug to LB. The draw path itself never builds. Where
  // no builder is registered (older init order / no-WebGL), fall back to the
  // idle-drain prepare so behavior degrades rather than breaking.
  // sections.deferAutoLb: opt-out for callers that immediately TRANSPLANT the
  // fresh bundle's fields into an existing bundle object (textBundle's
  // identity-stable setText) — the worker result would land on the abandoned
  // temporary. Such bundles carry _geomGen > 0 after transplant, which keeps
  // them off the LB-static route anyway (same policy as streamed geometry).
  if (!sections.streamable && !sections.deferAutoLb) {
    // `false` means the builders registered ON this CONTEXT deliberately declined (every renderer
    // sharing this canvas is Slug-only). Only `null` means no builder exists there and needs the
    // legacy idle-preparer fallback — a renderer on a DIFFERENT canvas is neither.
    if (_runLbBuilders(gl, bundle) === null && _hasLbPreparer(gl)) _enqueuePrepare(gl, bundle);
  }
  //
  const _occPend = sections.pendingOccupancy,
    _tierPend = sections.pendingTier3;
  if ((_occPend && _occPend.length) || (_tierPend && _tierPend.length)) {
    // Capture CPU plane identities and geometry/resource generations. Results
    // may arrive after a geometry replacement or context restoration; neither
    // may upload data prepared for the old owner.
    const occGen = bundle._geomGen | 0;
    const occResourceGen = resourceGeneration(gl);
    const occCurves = cFR;
    const occBands = bFR;
    bundle._occupancyBuildPending = true;
    requestOccupancyBuild(_occPend || [], _tierPend || [], (out) => {
      bundle._occupancyBuildPending = false;
      if (bundle._disposed || occResourceGen !== resourceGeneration(gl)) return;
      if ((bundle._geomGen | 0) !== occGen) return;
      if (bundle.curveFloats !== occCurves) return;
      if (out.occ && out.occ.length) _applyOccupancyGrids(gl, bundle, out.occ, occCurves);
      if (out.tier3 && out.tier3.length) {
        if (bundle.bandFloats !== occBands) return;
        _applyTreeGrids(gl, bundle, out.tier3, occBands);
      }
    });
  }
  // The PERF half of the occlusion cull, off the main thread. createBundle already
  // applied the cheap 'coincident' pass inline (that one is the correctness fix and
  // has to hold on frame one); this hunts the rest — shapes hidden well clear of
  // their occluder's boundary — and simply drops them from the draw list when it
  // lands. Arriving late costs nothing: the first frames just draw a few shapes that
  // nobody can see. Skipped once geometry has moved, for the same reason the stream
  // path retires the cull: a shape hidden as authored is not hidden once it slides.
  if (cullEnabled && numShapes > 1) {
    bundle._occlusionCullPending = true;
    requestOcclusionCull(
      { cv: cFR, meta: metaFloats, n: numShapes, stride, ranges: curveRangesByShape },
      (extra) => {
        bundle._occlusionCullPending = false;
        if (bundle._disposed || !extra || !extra.length) return;
        if ((bundle._geomGen | 0) !== 0) return; // geometry moved — cull is stale
        const set = new Set(bundle._culledShapes || []);
        const before = set.size;
        for (const i of extra) set.add(i);
        if (set.size === before) return;
        bundle._culledShapes = set;
        // An override retired the cull (renderer.js _retireCullIfOverridden), or revealed rows hold the full list: the late set is
        // recorded (a later lean rebuild uses it) but must not put a cut list back over a draw that has moved its occluder.
        if (!bundle._cullRetired && bundle._cullSpriteRanges) {
          for (const i of set)
            if (bundle._cullSpriteRanges.some((r) => i >= r[0] && i <= r[1])) {
              bundle._cullRetired = true;
              break;
            }
        }
        if (bundle._cullRetired || bundle._keptShown) return;
        bundle.drawList = buildDrawList(
          bundle.metaFloats,
          bundle.numShapes,
          bundle.metaFloatsPerShape,
          bundle.chunkByShape,
          bundle.filterGraphs,
          set,
          bundle._drawOrder,
          bundle._drawAltMeta,
        );
        bundle._cullGen = (bundle._cullGen | 0) + 1; // draw-list derivatives must rebuild
        // The analytic route assembles ONE combined VBO from the draw list and caches
        // it against the geometry gen — which hasn't changed — so retire that cache to
        // make it re-read the now-shorter list. Do NOT touch _lbMeshes: the per-shape
        // meshes are still valid, and `null` there is the memory-budget gate's "denied"
        // marker (clearing it would silently un-deny a bundle the gate refused).
      },
    );
  }
  enqueueFillPrewarm(gl, bundle);
  return bundle;
}

// Apply worker-built interior-occupancy bits into cFR (the curve float plane) and
// upload the affected rows, then flip bundle.hasOccupancy on. The heavy
// O(G²·segs) build already ran off-thread; this is the cheap write + texSubImage2D.
function _applyOccupancyGrids(gl, bundle, built, cFR) {
  if (!bundle.curveTex) return; // disposed
  let minRow = Infinity,
    maxRow = -1,
    changed = false;
  for (const g of built) {
    if (!g.bits) continue; // low interior → cells stay zero (dormant, correct)
    const bits = g.bits;
    for (let i = 0; i < bits.length; i += 4) {
      const t = (g.base + (i >> 2)) * 4;
      cFR[t] = bits[i] || 0;
      cFR[t + 1] = bits[i + 1] || 0;
      cFR[t + 2] = bits[i + 2] || 0;
      cFR[t + 3] = bits[i + 3] || 0;
    }
    const nTexels = Math.ceil((g.G * g.G) / 4);
    const r0 = Math.floor(g.base / TEX_W),
      r1 = Math.floor((g.base + nTexels - 1) / TEX_W);
    if (r0 < minRow) minRow = r0;
    if (r1 > maxRow) maxRow = r1;
    changed = true;
  }
  if (changed) {
    // Upload only the original curve plane. CPatch can append coefficients
    // in this row's padding before the occupancy worker replies; padding it
    // with zeros here would erase those live constraints.
    const rowFloats = TEX_W * 4,
      srcStart = minRow * rowFloats;
    const srcEnd = Math.min((maxRow + 1) * rowFloats, cFR.length);
    const fullRows = Math.floor((srcEnd - srcStart) / rowFloats);
    const tailStart = srcStart + fullRows * rowFloats;
    gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
    if (fullRows > 0)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        minRow,
        TEX_W,
        fullRows,
        gl.RGBA,
        gl.FLOAT,
        cFR.subarray(srcStart, tailStart),
      );
    const tailTexels = (srcEnd - tailStart) / 4;
    if (tailTexels > 0)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        minRow + fullRows,
        tailTexels,
        1,
        gl.RGBA,
        gl.FLOAT,
        cFR.subarray(tailStart, srcEnd),
      );
    bundle.hasOccupancy = true; // patched grids now skip; unbuilt ones stay zero (correct)
  }
}

// Apply worker-built GWN tier-3 cells into bFR (band plane) + upload. Packs 2
// cells/texel; no activation flag — zeroed cells were already dormant.
function _applyTreeGrids(gl, bundle, built, bFR) {
  if (!bundle.bandTex) return; // disposed
  let minRow = Infinity,
    maxRow = -1,
    changed = false;
  for (const g of built) {
    if (!g.cells) continue;
    const cells = g.cells,
      nCells = g.gridW * g.gridH;
    for (let i = 0, ti = g.absTexel; i < nCells; i += 2, ti++) {
      const t = ti * 4;
      bFR[t] = cells[i * 2];
      bFR[t + 1] = cells[i * 2 + 1];
      bFR[t + 2] = i + 1 < nCells ? cells[i * 2 + 2] : 0;
      bFR[t + 3] = i + 1 < nCells ? cells[i * 2 + 3] : 0;
    }
    const nTexels = Math.ceil(nCells / 2);
    const r0 = Math.floor(g.absTexel / TEX_W),
      r1 = Math.floor((g.absTexel + nTexels - 1) / TEX_W);
    if (r0 < minRow) minRow = r0;
    if (r1 > maxRow) maxRow = r1;
    changed = true;
  }
  if (changed) {
    const rows = maxRow - minRow + 1;
    const buf = new Float32Array(rows * TEX_W * 4);
    const srcStart = minRow * TEX_W * 4;
    const srcLen = Math.max(0, Math.min(rows * TEX_W * 4, bFR.length - srcStart));
    if (srcLen > 0) buf.set(bFR.subarray(srcStart, srcStart + srcLen));
    gl.bindTexture(gl.TEXTURE_2D, bundle.bandTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, minRow, TEX_W, rows, gl.RGBA, gl.FLOAT, buf);
  }
}

// LB BUILD HOOKS, PER WEBGL CONTEXT. Every renderer registers a builder and a preparer here and
// unregisters both on disposal. Two FLAT module-level arrays would make every renderer in the
// process a candidate for every bundle — and a bundle belongs to exactly ONE context, since
// createBundle puts its textures there. A renderer on another canvas would then decide a bundle it
// can never draw, with its own route, memory budget and adopt options; the visible case is a CPatch
// renderer, whose builder answers "handled" for any bundle, leaving the OTHER canvas's bundles with
// no meshes and its renderer on Slug for the rest of the session. Keyed by gl, a renderer can only
// ever answer for its own context.
const _lbHooksByGl = new WeakMap(); // gl → { builders: fn[], preparers: fn[] }
function _lbHooks(gl, make) {
  let h = _lbHooksByGl.get(gl);
  const generation = resourceGeneration(gl);
  if (h && h.generation !== generation) h = null;
  if (!h && make) {
    h = { generation, builders: [], preparers: [] };
    _lbHooksByGl.set(gl, h);
  }
  return h || null;
}
function _addHook(list, fn) {
  if (typeof fn === 'function' && !list.includes(fn)) list.push(fn);
}
function _dropHook(list, fn) {
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

export function setLbPreparer(gl, fn) {
  if (gl) _addHook(_lbHooks(gl, true).preparers, fn);
}
export function removeLbPreparer(gl, fn) {
  const h = gl ? _lbHooks(gl) : null;
  if (h) _dropHook(h.preparers, fn);
}
export function setLbBuilder(gl, fn) {
  if (gl) _addHook(_lbHooks(gl, true).builders, fn);
}
export function removeLbBuilder(gl, fn) {
  const h = gl ? _lbHooks(gl) : null;
  if (h) _dropHook(h.builders, fn);
}

function _hasLbPreparer(gl) {
  const h = gl ? _lbHooks(gl) : null;
  return !!(h && h.preparers.length);
}

function _lbPreparer(gl, b) {
  const h = gl ? _lbHooks(gl) : null;
  if (!h || !h.preparers.length) return false;
  for (let i = h.preparers.length - 1; i >= 0; i--) if (h.preparers[i](b) !== false) return true;
  return false;
}
// Off-thread whole-bundle LB builders. The newest renderer ON THE BUNDLE'S CONTEXT is asked first;
// returning false lets another live renderer on that same context accept the shared bundle.
function _runLbBuilders(gl, bundle) {
  const h = gl ? _lbHooks(gl) : null;
  if (!h || !h.builders.length) return null;
  for (let i = h.builders.length - 1; i >= 0; i--) {
    if (h.builders[i](bundle) !== false) return true; // handled (or built)
  }
  return false;
}

const _prepQ = [];
const _prepQueued = new WeakSet();
let _prepHead = 0;
let _prepScheduled = false;
function _schedulePrepDrain() {
  if (_prepScheduled) return;
  _prepScheduled = true;
  const drain = (deadline) => {
    _prepScheduled = false;
    const t0 = Date.now();
    // On busy screens rIC rarely fires with real idle — a 200ms timeout + 6ms
    // fallback slice drained loads at only ~5-15 shapes/s. 50ms timeout + 10ms
    // fallback finishes ~5-8× sooner; the draw-side pool still caps in-frame
    // stalls.
    const budget = () =>
      deadline && deadline.timeRemaining && !deadline.didTimeout
        ? deadline.timeRemaining() > 1
        : Date.now() - t0 < 10;
    while (_prepHead < _prepQ.length && budget()) {
      // The ENTRY carries the context the bundle was created on: the preparers are per-context, and
      // a queue entry with no context to match would be back to draining into whoever is newest.
      const { gl, b } = _prepQ[_prepHead++];
      _prepQueued.delete(b);
      // The preparer itself is time-budgeted and self-re-enqueues partial builds,
      // so one monster bundle cannot own a whole idle slice.
      try {
        if (
          !b._disposed &&
          (b._resourceGeneration == null || b._resourceGeneration === resourceGeneration(gl))
        )
          _lbPreparer(gl, b);
      } catch {
        /* draw-time fallback */
      }
    }
    if (_prepHead === _prepQ.length) {
      _prepQ.length = 0;
      _prepHead = 0;
    } else if (_prepHead > 1024 && _prepHead * 2 > _prepQ.length) {
      _prepQ.splice(0, _prepHead);
      _prepHead = 0;
    }
    if (_prepHead < _prepQ.length) _schedulePrepDrain();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(drain, { timeout: 50 });
  else setTimeout(drain, 0);
}
function _enqueuePrepare(gl, bundle) {
  if (
    !gl ||
    !bundle ||
    bundle._disposed ||
    _prepQueued.has(bundle) ||
    (bundle._resourceGeneration != null && bundle._resourceGeneration !== resourceGeneration(gl))
  )
    return;
  _prepQueued.add(bundle);
  _prepQ.push({ gl, b: bundle });
  _schedulePrepDrain();
}
// Draw paths defer missing meshes here (render Slug now, flip to LB when built). `gl` is the
// bundle's own context — the caller is a renderer, and it must not queue work onto another canvas.
export function enqueueLbPrepare(gl, bundle) {
  if (_hasLbPreparer(gl)) _enqueuePrepare(gl, bundle);
}

/// Exported constants — useful for consumers that want to roll their
/// own bundle parsing or build a custom mesh layout.
export const Constants = {
  META_STRIDE_V2,
  FULL_META_W,
  COVER_QUAD_STRIDE,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
  TEX_W,
};
