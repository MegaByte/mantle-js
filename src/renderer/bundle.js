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
//     gradientStops:  ArrayBuffer?,  // RGBA8 N×1 packed stops LUT (rgb=premult, a=offset)
//     gradientStopsCount: number?,   // total stops across all gradients (texel count)
//     dashes:         ArrayBuffer?,  // RGBA32F dash-pattern table (16 texels each)
//     filterTab:      ArrayBuffer?,  // RGBA32F color-matrix + kind/sigma per filter
//     imageAtlas:     ArrayBuffer?,  // RGBA8 stacked image tiles
//     imageAtlasDim:  [w, h]?,       // pixel dims of the atlas
//     flags:          number,        // BUNDLE_FLAG_*
//     metaFloatsPerShape: number?    // optional override; inferred otherwise
//   }

import {
  COVER_QUAD_STRIDE, BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
  parseCoverQuadChunks, buildShapeIdxFloats, buildGidToShapeIdx,
  buildStrippedCoverQuad,
} from './coverQuadChunks.js';

let _bundleUidSeq = 0;
import { buildNineSliceMesh } from './nineSlice.js';
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

const FULL_META_W = 12;             // texels per shape in the meta texture (v3+)
const TEX_W = 4096;                 // curve/band texture row width

export { parseMetaBin };

export { parseCoverQuadChunks };

/// One-shot texture upload — width × height surface from a typed-array
/// source. Caller-supplied format/type must match the source's element
/// layout. Exported so streamGeometry.js can re-allocate a grown
/// curve/band plane with identical sampler params.
export function makeTex(gl, data, w, h, internal, format, type) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
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
    const gx = (metaFloats[base + META_TEXEL_4]     | 0);
    const gy = (metaFloats[base + META_TEXEL_4 + 1] | 0);
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
    plane.set(metaFloats.subarray(s * stride, s * stride + stride),
              s * FULL_META_W * 4);
    if (stride < 44) {
      // v2 → fill v3 extension texel 6 with round caps/joins.
      const base = s * FULL_META_W * 4 + stride;
      plane[base + 0] = 1;  // capStyle=round
      plane[base + 1] = 1;  // joinStyle=round
      plane[base + 2] = 4;  // miterLimit
      plane[base + 3] = 0;  // flagsShape
    }
    // Texel 11 (primFastPath) default zero — Float32Array is zero-init.
  }
  return plane;
}

/// Build the per-frame draw list in meta-row (SVG painter's) order.
/// Each entry is one of:
///   { kind: 'fillShape',  shapeIdx, chunk, filterId?, filterGraphId?, colrGraphId? }
///   { kind: 'groupBegin', opacity, blendMode, isolation }
///   { kind: 'groupEnd' }
/// filterId is meta texel 32 (per-shape filter index, 1-based; 0 = none).
/// When `filterGraphs[filterId-1]` is non-null the filter is a graph the
/// kind path can't represent: the op gets filterGraphId set (filterId
/// omitted) so the renderer's graph branch fires instead of the kind branch.
/// colrGraphId is meta slot 45 (texel 11.y; per-shape COLRv1 paint-graph
/// index, 1-based; 0 = none) for COLRv1 color glyphs; the COLR dispatch
/// evaluates colrGraphs[colrGraphId-1] using the coverage-rendered shape
/// silhouette as PaintGlyph's alpha mask.
export function buildDrawList(metaFloats, numShapes, stride, chunkByShape, filterGraphs, culled) {
  const list = [];
  for (let s = 0; s < numShapes; s++) {
    // Fully occluded by a later opaque shape (occlusionCull.js): drawing it adds
    // nothing but a conflated AA edge under the occluder's boundary.
    if (culled && culled.has(s)) continue;
    const b = s * stride;
    const fillA   = metaFloats[b + 7];
    const strokeA = metaFloats[b + 11];
    const sw      = metaFloats[b + 12];
    const accum   = Math.floor(metaFloats[b + 14] + 0.5);
    const stroked = sw > 0 && strokeA > 0;
    const flagsShape = (stride >= 28) ? Math.floor(metaFloats[b + 27] + 0.5) : 0;
    if ((flagsShape & 64) !== 0) {
      list.push({
        kind: 'groupBegin',
        opacity:   metaFloats[b + 7],
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
    if ((fillA > 0 || (stroked && strokeA > 0)) && accum > 0) {
      const chunk = chunkByShape[s];
      if (!chunk) continue;
      const filterId = (stride >= 33) ? Math.floor(metaFloats[b + 32] + 0.5) : 0;
      // Per-leaf mix-blend-mode. blendMode == 0 (normal) renders via the
      // coalesced run; non-zero requires an offscreen FBO route + the
      // composite shader, just like a filter. blendMode lives at texel
      // 8.y (= float offset 33).
      const blendMode = (stride >= 34) ? Math.floor(metaFloats[b + 33] + 0.5) : 0;
      const op = { kind: 'fillShape', shapeIdx: s, chunk };
      if (filterId > 0) {
        const g = filterGraphs && filterGraphs[filterId - 1];
        if (g) op.filterGraphId = filterId;
        else   op.filterId = filterId;
      }
      // colrGraphId lives at texel 11 slot 45 (texel-11.y). Slot 44
      // (texel-11.x) is reserved for primKind, hence the stride>=46
      // gate. Pre-bump bundles with stride<46 see colrGraphId = 0
      // and render via the regular coverage fill path.
      const colrGraphId = (stride >= 46) ? Math.floor(metaFloats[b + 45] + 0.5) : 0;
      if (colrGraphId > 0) op.colrGraphId = colrGraphId;
      if (blendMode > 0) op.blendMode = blendMode;
      list.push(op);
    }
  }
  return list;
}

/// Build a MantleBundle from the importer's in-memory section dict.
/// The bundle owns its GL textures + ArrayBuffers (mesh + shapeIdx
/// floats) and must be `.dispose()`d to free GPU memory.
// Newly created bundles awaiting fill-program warm-up, partitioned by WebGL
// context so one canvas never consumes another canvas's GL resources.
const _newBundlesByGl = new WeakMap();

export function enqueueFillPrewarm(gl, bundle) {
  let q = _newBundlesByGl.get(gl);
  if (!q) { q = []; _newBundlesByGl.set(gl, q); }
  if (q.length < 4096) q.push(bundle);
}

export function takeFillPrewarm(gl) {
  const q = _newBundlesByGl.get(gl);
  while (q && q.length) {
    const bundle = q.pop();
    if (bundle && !bundle._disposed) return bundle;
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.occlusionCull=true] Drop shapes a later opaque shape fully
 *   covers. They add nothing but a conflated AA edge (see occlusionCull.js). Set
 *   false to draw every shape exactly as authored.
 */
export function createBundle(gl, sections, opts) {
  const flags = sections.flags || 0;
  const pairBands = (flags & 8) !== 0;   // BUNDLE_FLAG_PAIR_BANDS
  const noVBands  = (flags & 16) !== 0;  // BUNDLE_FLAG_NO_VBANDS
  // 0 = unknown (older bundles) ⇒ assume every type is present.
  const segTypeMask = (sections.segTypeMask | 0) || 0xF;
  const parsed = parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  const stride = parsed.floatsPerShape;
  const numShapes = parsed.numShapes;
  const metaFloats = parsed.metaFloats;

  // Mean per-shape bbox area, in the bundle's own units. AAC's cost on small shapes
  // is register pressure paid PER FRAGMENT, so its win is governed by how many
  // fragments a shape covers — see fillPass's `aacFill: 'auto'`.
  let meanShapeArea = 0;
  for (let i = 0; i < numShapes; i++) {
    const b = i * stride;
    const w = metaFloats[b + 2] - metaFloats[b + 0];
    const h = metaFloats[b + 3] - metaFloats[b + 1];
    if (w > 0 && h > 0) meanShapeArea += w * h;
  }
  if (numShapes) meanShapeArea /= numShapes;

  // Mean segments per shape is used by the LB size gate, whose mesh cost scales
  // with geometry while its benefit scales with covered fragments.
  const meanSegsPerShape = numShapes ? (sections.totalSegments | 0) / numShapes : 0;


  // --- CPU-side per-shape state ---
  const gidToShapeIdx = buildGidToShapeIdx(metaFloats, numShapes, stride);
  const coverQuadFloats = sections.curveGeom && sections.curveGeom.byteLength
    ? new Float32Array(sections.curveGeom) : null;
  const coverQuadChunks = parseCoverQuadChunks(coverQuadFloats, flags);
  const hybridShapeIdxFloats = coverQuadFloats
    ? buildShapeIdxFloats(coverQuadFloats, coverQuadChunks, gidToShapeIdx) : null;
  // Header-free VBO: pack chunk body verts contiguously (drops the dead
  // one-vertex chunk headers) and stamp each chunk's `vboStart` so the
  // renderer can batch adjacent chunks into a single drawArrays. See
  // buildStrippedCoverQuad for why the interleaved headers break batching.
  const strippedCover = coverQuadFloats
    ? buildStrippedCoverQuad(coverQuadFloats, coverQuadChunks, hybridShapeIdxFloats) : null;
  const coverQuadVboFloats = strippedCover ? strippedCover.verts : null;
  const hybridShapeIdxVboFloats = strippedCover ? strippedCover.shapeIdx : null;
  const chunkByShape = new Array(numShapes);
  for (const c of coverQuadChunks) {
    const si = gidToShapeIdx.get(c.gid);
    if (si !== undefined) chunkByShape[si] = c;
  }
  // drawList is built AFTER curveRangesByShape below — the occlusion cull needs the
  // authoritative per-shape curve slices to test containment.

  // --- GL textures ---
  const mh = Math.max(1, numShapes);
  const metaPlane = buildMetaPlane(metaFloats, numShapes, stride);
  const metaTex = makeTex(gl, metaPlane, FULL_META_W, mh,
                          gl.RGBA32F, gl.RGBA, gl.FLOAT);

  let gradientTex = null, gradientStopsTex = null, gradientCount = 0;
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
    gradientTex = makeTex(gl, gFloats, 4, gradientCount,
                          gl.RGBA32F, gl.RGBA, gl.FLOAT);
    // Exact-stop LUT — TWO RGBA8 texels per stop: texel A = straight
    // (R,G,B,alpha), texel B = (offset,…). Texture width = total texels
    // = 2 × stop count. The shader premultiplies after sampling so
    // per-stop alpha survives compositing (a premultiplied-at-encode
    // layout would drop it). Shared format with the COLRv1 dispatch —
    // both halves read via _gradientHelpers.glsl.
    if (sections.gradientStops && sections.gradientStops.byteLength) {
      const stopsBytes = new Uint8Array(sections.gradientStops);
      const texelW = stopsBytes.length / 4;           // 2 texels per stop
      gradientStopsCount = sections.gradientStopsCount || (texelW / 2);
      gradientStopsBytes = stopsBytes;
      gradientStopsTex = makeTex(gl, stopsBytes,
                                 Math.max(1, texelW), 1,
                                 gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      gl.bindTexture(gl.TEXTURE_2D, gradientStopsTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
  }

  let dashTex = null, dashCount = 0, dashFloats = null;
  if (sections.dashes && sections.dashes.byteLength) {
    dashFloats = new Float32Array(sections.dashes);
    dashCount = dashFloats.length / (16 * 4);
    dashTex = makeTex(gl, dashFloats, 16, dashCount,
                      gl.RGBA32F, gl.RGBA, gl.FLOAT);
  }

  let filterTex = null, lastFilterFloats = null;
  if (sections.filterTab && sections.filterTab.byteLength) {
    const fFloats = new Float32Array(sections.filterTab);
    const filterCount = fFloats.length / (6 * 4);
    filterTex = makeTex(gl, fFloats, 6, filterCount,
                        gl.RGBA32F, gl.RGBA, gl.FLOAT);
    lastFilterFloats = fFloats;
  }

  // Per-convolve-filter kernel storage. 25 floats per kernel padded to
  // 28 (= 7 RGBA32F texels) so the GLSL side can sample by a clean
  // texelFetch(ivec2(c, row)) where c in [0, 6] covers the 5×5 case.
  let kernelTex = null, lastKernelFloats = null;
  if (sections.kernelTab && sections.kernelTab.byteLength) {
    const kIn = new Float32Array(sections.kernelTab);
    const kernelCount = kIn.length / 25;
    const padded = new Float32Array(kernelCount * 28);
    for (let i = 0; i < kernelCount; i++) {
      padded.set(kIn.subarray(i * 25, i * 25 + 25), i * 28);
    }
    kernelTex = makeTex(gl, padded, 7, kernelCount,
                        gl.RGBA32F, gl.RGBA, gl.FLOAT);
    lastKernelFloats = kIn;
  }

  let imageAtlasTex = null, imageAtlasSize = [0, 0];
  if (sections.imageAtlas && sections.imageAtlas.byteLength && sections.imageAtlasDim) {
    const [aw, ah] = sections.imageAtlasDim;
    const px = new Uint8Array(sections.imageAtlas);
    imageAtlasTex = makeTex(gl, px, aw, ah, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, imageAtlasTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    imageAtlasSize = [aw, ah];
  }

  // Curve + band textures. Both are RGBA32F, TEX_W-wide, height
  // capacity-padded to the next full row so the shader's row-wrap
  // logic (MantleCalcBandLoc) sees a power-of-two-aligned grid.
  const cFR = new Float32Array(sections.curves);
  const cH = Math.max(1, Math.ceil(cFR.length / (4 * TEX_W)));
  const cF = new Float32Array(cH * 4 * TEX_W);
  cF.set(cFR);
  const curveTex = makeTex(gl, cF, TEX_W, cH, gl.RGBA32F, gl.RGBA, gl.FLOAT);

  // Per-shape curve-buffer ranges in float units. Prefer the
  // importer-emitted ranges (required so mask geometry interpolates
  // correctly across a shape morph). Fall back to inferring from meta
  // texel 4 (glyphLoc) for bundles without explicit ranges — that
  // inference is wrong on multi-shape bundles (glyphLoc is a bandBuf
  // index, not a curveBuf offset) but fine for single-shape SVGs.
  const curveRangesByShape = sections.curveRangesByShape
    ? sections.curveRangesByShape.map(r => ({ begin: r.begin | 0, end: r.end | 0 }))
    : buildCurveRangesByShape(metaFloats, numShapes, stride, cFR.length);

  // OCCLUSION CULL. A shape a later OPAQUE shape completely covers adds nothing to
  // the image — except its ANTIALIASED EDGE, which painter compositing blends in a
  // SECOND time underneath the occluder's own edge, painting a 1px fringe of the
  // hidden shape's colour along every shared boundary (the classic CONFLATION
  // artifact — Chrome shows the same fringe on a straight shared edge; see
  // occlusionCull.js). Art that stacks coincident layers — a duplicate ridge under a
  // translucent one — therefore grew a coloured, too-dark AA edge. Culling removes
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
      const set = computeOccludedShapes(cFR, curveRangesByShape, metaFloats, numShapes,
                                        stride, 'coincident');
      if (set && set.size) culled = set;
    } catch { culled = null; }   // a cull is an optimisation — never fail the build over it
  }
  const drawList = buildDrawList(metaFloats, numShapes, stride, chunkByShape,
                                 sections.filterGraphs, culled);
  // Keep the UNCULLED list: the cull is only valid for the geometry as authored, and
  // a bundle whose shapes later MOVE (a streamed road, a morph) must fall back to
  // drawing everything — a shape hidden at load is not hidden once it slides out.
  const drawListUnculled = culled
    ? buildDrawList(metaFloats, numShapes, stride, chunkByShape, sections.filterGraphs, null)
    : drawList;

  const bFR = new Float32Array(sections.bands);
  const bH = Math.max(1, Math.ceil(bFR.length / (4 * TEX_W)));
  const bF = new Float32Array(bH * 4 * TEX_W);
  bF.set(bFR);
  const bandTex = makeTex(gl, bF, TEX_W, bH, gl.RGBA32F, gl.RGBA, gl.FLOAT);

  const bundle = {
    // CPU-side state
    // Unique per bundle, for renderer-side caches keyed by bundle. filterGraphId and
    // filterId are BUNDLE-LOCAL (every bundle's first filter is 1), so a cache keyed on
    // those alone silently shares one entry between unrelated bundles.
    uid: ++_bundleUidSeq,
    // `opts.recolor` is ACCEPTED AND IGNORED. Recolour was briefly a declared bundle
    // property, because it was a shader-variant axis and the variant could otherwise only
    // be discovered mid-play. It is not an axis any more: measured, compiling the recolour
    // block in costs ~2% — inside the noise floor — so it is always compiled in and there
    // is nothing to declare. Kept in the signature so callers that added it still work.
    flags,
    pairBands,   // BUNDLE_FLAG_PAIR_BANDS: each H band covers a stripe PAIR
    noVBands,    // BUNDLE_FLAG_NO_VBANDS: Slug's V ray would degenerate — AAC only
    meanSegsPerShape,
    segTypeMask, // which of LINE/QUAD/CUBIC/ARC this bundle actually contains
    meanShapeArea, // mean per-shape bbox area, bundle units (for aacFill:'auto')
    noAaFill: !!sections.noAaFill,      // every drawn fill is opaque-stroke-covered ⇒ no-AA fill OK
    noAaTree: !!sections.noAaTree,      // …and cubic/arc-bearing ⇒ GWN tree baked ⇒ route tree-hard (not band-hard)
    gwnTree: !!sections.gwnTree,        // importSvg({gwnTree:true}) — required by every GWN kernel
    minStrokeEmW: sections.minStrokeEmW || 0, // min covering-stroke width (em); draw gate needs ≥2 device px
    numShapes,
    globalBBox: parsed.globalBBox,
    // Optional font-wide + per-run typographic metrics. Populated for
    // text bundles; null for SVG/raster bundles (no baseline). Typographic
    // layout reads these instead of the per-string ink-tight globalBBox.
    fontMetrics: sections.fontMetrics || null,
    runMetrics:  sections.runMetrics  || null,
    // Per-shape stable string ids (SVG `id=` attribute, "" when absent).
    // Used by createOverrideTable + hitTest for stable shape addressing
    // across rebuilds. Length === numShapes.
    shapeIds: sections.shapeIds ? sections.shapeIds.slice() : new Array(numShapes).fill(''),
    // Original SVG markup, retained only when imported with
    // { retainSource: true } (null otherwise). Carried so the SVG-export
    // path and the native morph can reconstruct the current frame as
    // markup without a GPU read-back.
    svgSource: sections.svgSource || null,
    // animatable-clipper API: { clipSvgId: [firstMetaRow, lastMetaRow] }
    // — 0-based row range of each <clipPath>'s layer rows. Drives the
    // override table's setClipper(svgId, opts) so callers can apply a
    // runtime 2D affine to a clip mask without touching shape geometry.
    clipperRows: sections.clipperRows || {},
    // Sprite-sheet addressing: { spriteId: [firstRow,lastRow] }
    // for top-level id'd groups/shapes. Drives renderer.drawSprite.
    spriteRanges: sections.spriteRanges || {},
    spriteRangesNonContiguous: sections.spriteRangesNonContiguous || [],
    metaFloats,
    metaFloatsPerShape: stride,
    coverQuadFloats,
    coverQuadChunks,
    hybridShapeIdxFloats,
    // Header-free, batch-friendly VBO planes (chunks carry `vboStart`).
    coverQuadVboFloats,
    hybridShapeIdxVboFloats,
    chunkByShape,
    // CPU-side curve float plane (UNPADDED). Kept so shape morph can lerp
    // curves between bundles without re-reading from GL. `curveFloats.length`
    // is the unpadded count; the row-padded plane uploaded to curveTex is
    // `cF` (not exposed).
    curveFloats: cFR,
    // CPU-side band float plane (UNPADDED). Required by morph + animation
    // primitives that build a derived bundle without round-tripping the
    // importer. Reads use the same offsets as the GL bandTex; writes must
    // mirror both. The row-padded plane uploaded to bandTex is `bF`.
    bandFloats: bFR,
    // Per-shape curve-buffer ranges in float units. Length == numShapes;
    // each entry `{ begin, end }` is a half-open slice of `curveFloats`.
    // The last shape's `end` is `curveFloats.length`.
    curveRangesByShape,
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
    kernelTex,
    lastKernelFloats,
    // Optional CPU-only filter-graph table (one entry per graph-typed
    // filter; populated for multi-primitive chains the single-kind path
    // can't represent). The renderer prefers op.filterGraphId when set,
    // falling back to op.filterId (kind path).
    filterGraphs: sections.filterGraphs || null,
    // Interior-skip occupancy: true when the importer baked interior grids
    // (opt-in). Gates the fill shader's occupancy branch so the default path is
    // untouched. Bits live in the curve buffer; descriptors in meta texel 5.
    hasOccupancy: !!sections.hasOccupancy,
    // Private worker-completion markers used by deterministic prewarm/tests.
    // Rendering remains correct while either is true; the worker only adds
    // acceleration data or removes conservatively hidden draws.
    _occupancyBuildPending: false,
    _occlusionCullPending: false,
    // CPU-only COLRv1 paint-graph table — one entry per text-run color
    // glyph that ships a v1 paint tree. The COLR dispatch evaluates
    // colrGraphs[colrGraphId-1] using the coverage-rendered glyph
    // silhouette as PaintGlyph's mask. Null for SVG-only bundles.
    colrGraphs: sections.colrGraphs || null,
    imageAtlasTex,
    imageAtlasSize,
    // Per-imageId atlas-slot rects in pixels (atlasY, w, h). Forwarded
    // from the importer so feImage dispatch (and external M5 hit-test
    // consumers) can look up a slot by id without touching meta texels.
    imageAtlasRects: sections.imageAtlasRects || null,
    // Raw side-band ArrayBuffers, preserved alongside the GL textures
    // so derived-bundle builders can forward the same tables into a
    // newly composed sections dict and re-run createBundle. The textures
    // can't be reused across a new bundle (the morph rebuilds its own);
    // the raw bytes can. Null when the source asset had no entries.
    filterTab:    sections.filterTab    || null,
    imageAtlas:   sections.imageAtlas   || null,
    imageAtlasDim: sections.imageAtlasDim || null,
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
      // Stash the native baseline once so callers can change WorldSize
      // multiple times without round-tripping through createBundle.
      if (!this._nineSliceBaseline) {
        this._nineSliceBaseline = {
          coverQuadFloats:    this.coverQuadFloats,
          coverQuadChunks:    this.coverQuadChunks,
          hybridShapeIdxFloats:this.hybridShapeIdxFloats,
          coverQuadVboFloats:   this.coverQuadVboFloats,
          hybridShapeIdxVboFloats: this.hybridShapeIdxVboFloats,
          chunkByShape:        this.chunkByShape,
          drawList:            this.drawList,
          globalBBox:          this.globalBBox.slice(),
        };
      }
      const baseline = this._nineSliceBaseline;
      const { meshFloats, chunks, shapeIdxFloats } = buildNineSliceMesh({
        meshFloats:  baseline.coverQuadFloats,
        chunks:      baseline.coverQuadChunks,
        gidToShapeIdx: this.gidToShapeIdx,
        metaFloats:  this.metaFloats,
        metaStride:  this.metaFloatsPerShape,
        border:      opts && opts.border,
        worldSize:   opts && opts.worldSize,
        nativeBBox:  (opts && opts.nativeBBox) || null,
        fallbackBBox: baseline.globalBBox,
      });
      this.coverQuadFloats     = meshFloats;
      this.coverQuadChunks     = chunks;
      this.hybridShapeIdxFloats = shapeIdxFloats || baseline.hybridShapeIdxFloats;
      // Repack the header-free VBO planes + restamp chunk vboStart for the
      // new mesh (batching depends on vboStart tracking the current chunks).
      const strip = meshFloats
        ? buildStrippedCoverQuad(meshFloats, chunks, this.hybridShapeIdxFloats) : null;
      this.coverQuadVboFloats     = strip ? strip.verts : null;
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
        this.metaFloats, this.numShapes, this.metaFloatsPerShape,
        cbs, this.filterGraphs);
      // Override globalBBox so the renderer's existing em→NDC pipeline
      // maps `aPos` (target em coords) to the correct viewport region.
      // Restored from baseline when border is zero or worldSize collapses.
      const bL = (opts && opts.border && opts.border[0]) || 0;
      const bB = (opts && opts.border && opts.border[1]) || 0;
      const bR = (opts && opts.border && opts.border[2]) || 0;
      const bT = (opts && opts.border && opts.border[3]) || 0;
      const wW = (opts && opts.worldSize && opts.worldSize[0]) || 0;
      const wH = (opts && opts.worldSize && opts.worldSize[1]) || 0;
      const isActive = (bL || bB || bR || bT) && wW > 0 && wH > 0;
      if (isActive) {
        // Anchor at native-em origin; span = max(worldSize, border sum)
        // matching buildNineSliceMesh's clamping behavior.
        const nb = (opts && opts.nativeBBox)
          ? [opts.nativeBBox[0], opts.nativeBBox[1],
             opts.nativeBBox[2] - opts.nativeBBox[0],
             opts.nativeBBox[3] - opts.nativeBBox[1]]
          : baseline.globalBBox;
        const emW = nb[2];
        const emH = nb[3];
        let lbL = bL, lbR = bR, lbT = bT, lbB = bB;
        if (lbL + lbR > emW) { const s = emW / (lbL + lbR); lbL *= s; lbR *= s; }
        if (lbT + lbB > emH) { const s = emH / (lbT + lbB); lbT *= s; lbB *= s; }
        const tW = Math.max(wW, lbL + lbR);
        const tH = Math.max(wH, lbT + lbB);
        this.globalBBox = [nb[0], nb[1], tW, tH];
        this._nineSliceActive = true;
      } else {
        this.globalBBox = baseline.globalBBox.slice();
        this._nineSliceActive = false;
      }
      // Bump the geometry generation so a same-bundle setBundle (or the
      // analytic-route gates) sees the rewritten coverQuadFloats —
      // without the bump the documented "re-call setBundle" contract
      // hits the same-bundle fast path, which never re-uploads the mesh.
      this._geomGen = (this._geomGen | 0) + 1;
      return this;
    },
    /// Create a lightweight PER-DRAW nine-slice view of this bundle.
    ///
    /// Unlike applyNineSlice (which rewrites THIS bundle's mesh in
    /// place — one nine-slice state per bundle), the returned instance
    /// carries its own rewritten cover-quad mesh + drawList + globalBBox
    /// while SHARING every heavy resource with the base bundle by
    /// prototype: curve/band/meta/gradient/atlas textures, CPU float
    /// planes, hit-test tables. Cost per instance ≈ the rewritten mesh
    /// floats (a few KB), so one chrome asset can be drawn at N sizes
    /// simultaneously — bind each instance to its own draw handle
    /// (renderer.createBundleHandle(inst) / setBundle(inst)).
    ///
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
        coverQuadFloats:      this.coverQuadFloats,
        coverQuadChunks:      this.coverQuadChunks,
        hybridShapeIdxFloats: this.hybridShapeIdxFloats,
        coverQuadVboFloats:   this.coverQuadVboFloats,
        hybridShapeIdxVboFloats: this.hybridShapeIdxVboFloats,
        chunkByShape:         this.chunkByShape,
        drawList:             this.drawList,
        globalBBox:           this.globalBBox.slice(),
      };
      // Own generation counter (starts at the base's current value;
      // applyNineSlice below bumps it, so a handle freshly bound to the
      // base never confuses the two).
      inst._geomGen = (this._geomGen | 0);
      inst.dispose = function () {
        this._disposed = true;
        // Free only draw-route GL state stamped on the INSTANCE itself;
        // everything inherited belongs to the base.
        if (Object.prototype.hasOwnProperty.call(this, '_lbPaintTexGl') && this._lbPaintTexGl) {
          gl.deleteTexture(this._lbPaintTexGl); this._lbPaintTexGl = null;
        }
        const route = /** @type {{vao?: WebGLVertexArrayObject, buf?: WebGLBuffer}|null} */ (
          Object.prototype.hasOwnProperty.call(this, '_lbRouteGl') ? this._lbRouteGl : null);
        if (route) {
          if (route.vao) gl.deleteVertexArray(route.vao);
          if (route.buf) gl.deleteBuffer(route.buf);
          this._lbRouteGl = null;
        }
      };
      inst.applyNineSlice(opts || {});
      return inst;
    },
    /// Release all GL resources owned by this bundle. After dispose
    /// the bundle is invalid; create a new one for the next asset.
    dispose() {
      this._disposed = true;
      for (const tex of [this.curveTex, this.bandTex, this.metaTex, this.dashTex,
                         this.gradientTex, this.gradientStopsTex,
                         this.imageAtlasTex, this.filterTex, this.kernelTex]) {
        if (tex) gl.deleteTexture(tex);
      }
      this.curveTex = this.bandTex = this.metaTex = this.dashTex =
      this.gradientTex = this.gradientStopsTex =
      this.imageAtlasTex = this.filterTex = this.kernelTex = null;
      // LB route resources are lazily stamped onto the bundle by the draw
      // path (morphDraw) — free them here or they outlive the bundle.
      if (this._lbPaintTexGl) { gl.deleteTexture(this._lbPaintTexGl); this._lbPaintTexGl = null; }
      if (this._lbRouteGl) {
        if (this._lbRouteGl.vao) gl.deleteVertexArray(this._lbRouteGl.vao);
        if (this._lbRouteGl.buf) gl.deleteBuffer(this._lbRouteGl.buf);
        this._lbRouteGl = null;
      }
    },
  };
  // AUTOMATIC mesh construction — OFF THE MAIN THREAD. The whole Loop-Blinn
  // triangulation for the bundle is handed to a Web Worker (see _lbBuilder →
  // lbWorkerPool); when it returns, the renderer stores the packed meshes and the
  // draw path upgrades from Slug to LB. The draw path itself NEVER builds. Where
  // no builder is registered (older init order / no-WebGL), fall back to the
  // idle-drain prepare so behaviour degrades rather than breaking.
  // sections.deferAutoLb: opt-out for callers that immediately TRANSPLANT the
  // fresh bundle's fields into an existing bundle object (textBundle's
  // identity-stable setText) — the worker result would land on the abandoned
  // temporary. Such bundles carry _geomGen > 0 after transplant, which keeps
  // them off the LB-static route anyway (same policy as streamed geometry).
  if (!sections.streamable && !sections.deferAutoLb) {
    // `false` means registered builders deliberately declined (all renderers
    // are Slug-only). Only `null` means no builder exists and needs the legacy
    // idle-preparer fallback.
    if (_runLbBuilders(bundle) === null && _lbPreparers.length) _enqueuePrepare(bundle);
  }
  // Interior-skip grids reserved (zeroed) at import fill in AFTER first draw:
  // the region is additive (occSkip only collapses a walk that returns 1.0), so
  // the first frame is correct-but-unaccelerated and hasOccupancy flips on once
  // bits land. curveFloats IS cFR, so writes patch the CPU copy in place.
  // GWN tier-3 grids reserved (zeroed) during the tree bake fill the same way,
  // into bandTex. Zeroed cells are already dormant (margin 0), so there is no
  // activation flag — the descriptor is live and the grid accelerates interior
  // pixels the moment real cells land.
  //
  // Both grid builds are pure O(G²·segs) math, so they run OFF the main thread in
  // the occupancy worker; when the bits/cells come back we only write the float
  // planes + texSubImage2D (cheap). "Come online when ready": the first frames are
  // correct-but-unaccelerated (occSkip only collapses a walk that returns 1.0;
  // zeroed tier-3 cells are dormant), and the grids activate the moment they land.
  const _occPend = sections.pendingOccupancy, _tierPend = sections.pendingTier3;
  if ((_occPend && _occPend.length) || (_tierPend && _tierPend.length)) {
    // Capture the curve/band planes + geometry generation at schedule time.
    // updateBundleGeometry / setText transplant replace those planes; applying
    // a late worker result into the live texture would patch occupancy bits
    // over real curve texels (wrong interiors / corrupted fills).
    const occGen = bundle._geomGen | 0;
    const occCurves = cFR;
    const occBands = bFR;
    bundle._occupancyBuildPending = true;
    requestOccupancyBuild(_occPend || [], _tierPend || [], (out) => {
      bundle._occupancyBuildPending = false;
      if (bundle._disposed) return;
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
        if ((bundle._geomGen | 0) !== 0) return;          // geometry moved — cull is stale
        const set = new Set(bundle._culledShapes || []);
        const before = set.size;
        for (const i of extra) set.add(i);
        if (set.size === before) return;
        bundle._culledShapes = set;
        bundle.drawList = buildDrawList(bundle.metaFloats, bundle.numShapes,
                                        bundle.metaFloatsPerShape, bundle.chunkByShape,
                                        bundle.filterGraphs, set);
        bundle._cullGen = (bundle._cullGen | 0) + 1;   // draw-list derivatives must rebuild
        // The analytic route assembles ONE combined VBO from the draw list and caches
        // it against the geometry gen — which hasn't changed — so retire that cache to
        // make it re-read the now-shorter list. Do NOT touch _lbMeshes: the per-shape
        // meshes are still valid, and `null` there is the memory-budget gate's "denied"
        // marker (clearing it silently un-denied a bundle the gate had refused).
        bundle._lbCombined = null;
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
  if (!bundle.curveTex) return;                           // disposed
  let minRow = Infinity, maxRow = -1, changed = false;
  for (const g of built) {
    if (!g.bits) continue;                                // low interior → cells stay zero (dormant, correct)
    const bits = g.bits;
    for (let i = 0; i < bits.length; i += 4) {
      const t = (g.base + (i >> 2)) * 4;
      cFR[t] = bits[i] || 0; cFR[t + 1] = bits[i + 1] || 0;
      cFR[t + 2] = bits[i + 2] || 0; cFR[t + 3] = bits[i + 3] || 0;
    }
    const nTexels = Math.ceil(g.G * g.G / 4);
    const r0 = Math.floor(g.base / TEX_W), r1 = Math.floor((g.base + nTexels - 1) / TEX_W);
    if (r0 < minRow) minRow = r0; if (r1 > maxRow) maxRow = r1;
    changed = true;
  }
  if (changed) {
    // Re-upload the affected full rows from cFR (row-padded to TEX_W; the tail
    // beyond cFR.length stays zero, matching the texture's original padding).
    const rows = maxRow - minRow + 1;
    const buf = new Float32Array(rows * TEX_W * 4);
    const srcStart = minRow * TEX_W * 4;
    const srcLen = Math.max(0, Math.min(rows * TEX_W * 4, cFR.length - srcStart));
    if (srcLen > 0) buf.set(cFR.subarray(srcStart, srcStart + srcLen));
    gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, minRow, TEX_W, rows, gl.RGBA, gl.FLOAT, buf);
    bundle.hasOccupancy = true;                            // patched grids now skip; unbuilt ones stay zero (correct)
  }
}

// Apply worker-built GWN tier-3 cells into bFR (band plane) + upload. Packs 2
// cells/texel; no activation flag — zeroed cells were already dormant.
function _applyTreeGrids(gl, bundle, built, bFR) {
  if (!bundle.bandTex) return;                            // disposed
  let minRow = Infinity, maxRow = -1, changed = false;
  for (const g of built) {
    if (!g.cells) continue;
    const cells = g.cells, nCells = g.gridW * g.gridH;
    for (let i = 0, ti = g.absTexel; i < nCells; i += 2, ti++) {
      const t = ti * 4;
      bFR[t] = cells[i * 2]; bFR[t + 1] = cells[i * 2 + 1];
      bFR[t + 2] = i + 1 < nCells ? cells[i * 2 + 2] : 0;
      bFR[t + 3] = i + 1 < nCells ? cells[i * 2 + 3] : 0;
    }
    const nTexels = Math.ceil(nCells / 2);
    const r0 = Math.floor(g.absTexel / TEX_W), r1 = Math.floor((g.absTexel + nTexels - 1) / TEX_W);
    if (r0 < minRow) minRow = r0; if (r1 > maxRow) maxRow = r1;
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

// Every renderer registers its preparer and unregisters it on disposal.
const _lbPreparers = [];
export function setLbPreparer(fn) {
  if (typeof fn === 'function' && !_lbPreparers.includes(fn)) _lbPreparers.push(fn);
}
export function removeLbPreparer(fn) {
  const i = _lbPreparers.indexOf(fn);
  if (i >= 0) _lbPreparers.splice(i, 1);
}
function _lbPreparer(b) {                       // the newest live preparer
  const fn = _lbPreparers[_lbPreparers.length - 1];
  return fn ? fn(b) : undefined;
}
// Off-thread whole-bundle LB builders. The newest renderer is asked first;
// returning false lets another live renderer accept the shared bundle.
const _lbBuilders = [];
export function setLbBuilder(fn) {
  if (typeof fn === 'function' && !_lbBuilders.includes(fn)) _lbBuilders.push(fn);
}
export function removeLbBuilder(fn) {
  const i = _lbBuilders.indexOf(fn);
  if (i >= 0) _lbBuilders.splice(i, 1);
}
function _runLbBuilders(bundle) {
  if (!_lbBuilders.length) return null;
  for (let i = _lbBuilders.length - 1; i >= 0; i--) {
    if (_lbBuilders[i](bundle) !== false) return true;   // handled (or built)
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
    const budget = () => (deadline && deadline.timeRemaining ? deadline.timeRemaining() > 1 : (Date.now() - t0) < 10);
    while (_prepHead < _prepQ.length && budget()) {
      const b = _prepQ[_prepHead++];
      _prepQueued.delete(b);
      // The preparer itself is time-budgeted and self-re-enqueues partial builds,
      // so one monster bundle cannot own a whole idle slice.
      try { if (!b._disposed && _lbPreparers.length) _lbPreparer(b); } catch { /* draw-time fallback */ }
    }
    if (_prepHead === _prepQ.length) { _prepQ.length = 0; _prepHead = 0; }
    else if (_prepHead > 1024 && _prepHead * 2 > _prepQ.length) {
      _prepQ.splice(0, _prepHead);
      _prepHead = 0;
    }
    if (_prepHead < _prepQ.length) _schedulePrepDrain();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(drain, { timeout: 50 });
  else setTimeout(drain, 0);
}
function _enqueuePrepare(bundle) {
  if (!bundle || bundle._disposed || _prepQueued.has(bundle)) return;
  _prepQueued.add(bundle);
  _prepQ.push(bundle);
  _schedulePrepDrain();
}
// Draw paths defer missing meshes here (render Slug now, flip to LB when built).
export function enqueueLbPrepare(bundle) { if (_lbPreparers.length) _enqueuePrepare(bundle); }

/// Exported constants — useful for consumers that want to roll their
/// own bundle parsing or build a custom mesh layout.
export const Constants = {
  META_STRIDE_V2,
  FULL_META_W,
  COVER_QUAD_STRIDE,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
  TEX_W,
};
