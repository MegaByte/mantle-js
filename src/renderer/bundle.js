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
} from './coverQuadChunks.js';
import { buildNineSliceMesh } from './nineSlice.js';
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
function buildDrawList(metaFloats, numShapes, stride, chunkByShape, filterGraphs) {
  const list = [];
  for (let s = 0; s < numShapes; s++) {
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
export function createBundle(gl, sections) {
  const flags = sections.flags || 0;
  const parsed = parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  const stride = parsed.floatsPerShape;
  const numShapes = parsed.numShapes;
  const metaFloats = parsed.metaFloats;

  // --- CPU-side per-shape state ---
  const gidToShapeIdx = buildGidToShapeIdx(metaFloats, numShapes, stride);
  const coverQuadFloats = sections.curveGeom && sections.curveGeom.byteLength
    ? new Float32Array(sections.curveGeom) : null;
  const coverQuadChunks = parseCoverQuadChunks(coverQuadFloats, flags);
  const hybridShapeIdxFloats = coverQuadFloats
    ? buildShapeIdxFloats(coverQuadFloats, coverQuadChunks, gidToShapeIdx) : null;
  const chunkByShape = new Array(numShapes);
  for (const c of coverQuadChunks) {
    const si = gidToShapeIdx.get(c.gid);
    if (si !== undefined) chunkByShape[si] = c;
  }
  const drawList = buildDrawList(metaFloats, numShapes, stride, chunkByShape, sections.filterGraphs);

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
    // per-stop alpha survives compositing (the old premult-rgb/offset-in-
    // alpha layout dropped it). Shared format with the COLRv1 dispatch —
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

  const bFR = new Float32Array(sections.bands);
  const bH = Math.max(1, Math.ceil(bFR.length / (4 * TEX_W)));
  const bF = new Float32Array(bH * 4 * TEX_W);
  bF.set(bFR);
  const bandTex = makeTex(gl, bF, TEX_W, bH, gl.RGBA32F, gl.RGBA, gl.FLOAT);

  const bundle = {
    // CPU-side state
    flags,
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
      // Callers that already have the bundle bound should re-call
      // renderer.setBundle(bundle) to mark the changed coverQuadFloats
      // buffer dirty for the next draw.
      return this;
    },
    /// Release all GL resources owned by this bundle. After dispose
    /// the bundle is invalid; create a new one for the next asset.
    dispose() {
      for (const tex of [this.curveTex, this.bandTex, this.metaTex, this.dashTex,
                         this.gradientTex, this.gradientStopsTex,
                         this.imageAtlasTex, this.filterTex, this.kernelTex]) {
        if (tex) gl.deleteTexture(tex);
      }
      this.curveTex = this.bandTex = this.metaTex = this.dashTex =
      this.gradientTex = this.gradientStopsTex =
      this.imageAtlasTex = this.filterTex = this.kernelTex = null;
    },
  };
  // AUTOMATIC mesh construction — OFF THE MAIN THREAD. The whole Loop-Blinn
  // triangulation for the bundle is handed to a Web Worker (see _lbBuilder →
  // lbWorkerPool); when it returns, the renderer stores the packed meshes and the
  // draw path upgrades from Slug to LB. The draw path itself NEVER builds. Where
  // no builder is registered (older init order / no-WebGL), fall back to the
  // legacy idle-drain prepare so behaviour degrades rather than breaking.
  if (!sections.streamable) {
    if (_lbBuilder) _lbBuilder(bundle);
    else if (_lbPreparer) _enqueuePrepare(bundle);
  }
  return bundle;
}

// Module-level preparer registration (set by the renderer's morphDraw attach).
let _lbPreparer = null;
export function setLbPreparer(fn) { _lbPreparer = fn; }
// Off-thread whole-bundle LB builder (set by morphDraw). Given a freshly created
// bundle, it kicks off the worker build and applies the result when ready.
let _lbBuilder = null;
export function setLbBuilder(fn) { _lbBuilder = fn; }

const _prepQ = [];
let _prepScheduled = false;
function _schedulePrepDrain() {
  if (_prepScheduled) return;
  _prepScheduled = true;
  const drain = (deadline) => {
    _prepScheduled = false;
    const t0 = Date.now();
    // On busy screens rIC rarely fires with real idle — the 200ms timeout + 6ms
    // fallback slice drained loads at ~5-15 shapes/s (a level select trickled
    // first-sighting builds for tens of seconds). 50ms timeout + 10ms fallback
    // finishes ~5-8× sooner; the draw-side pool still caps in-frame stalls.
    const budget = () => (deadline && deadline.timeRemaining ? deadline.timeRemaining() > 1 : (Date.now() - t0) < 10);
    while (_prepQ.length && budget()) {
      const b = _prepQ.shift();
      // The preparer itself is time-budgeted and self-re-enqueues partial builds, so
      // one monster bundle can no longer own a whole idle slice (the drain was the
      // residual crash freeze: it ran the UNBUDGETED ensure).
      try { if (_lbPreparer) _lbPreparer(b); } catch { /* draw-time fallback */ }
    }
    if (_prepQ.length) _schedulePrepDrain();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(drain, { timeout: 50 });
  else setTimeout(drain, 0);
}
function _enqueuePrepare(bundle) {
  _prepQ.push(bundle);
  _schedulePrepDrain();
}
// Draw paths defer missing meshes here (render Slug now, flip to LB when built).
export function enqueueLbPrepare(bundle) { if (_lbPreparer) _enqueuePrepare(bundle); }

/// Exported constants — useful for consumers that want to roll their
/// own bundle parsing or build a custom mesh layout.
export const Constants = {
  META_STRIDE_V2,
  FULL_META_W,
  COVER_QUAD_STRIDE,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
  TEX_W,
};
