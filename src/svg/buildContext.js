// Shared importer accumulator state + the simple-fill emitShape entry
// point that consumers (importer.js, font/textRun.js) use to push shapes
// into one bundle.
//
// The build context bundles all per-import accumulators (curve/band
// buffers, meta records, gradients-used, clips/masks/filters/images/
// patterns sets, hybrid mesh floats, etc.). emitShape is the common
// shape-emit path that font/textRun calls for every glyph without
// needing to know the full SVG-import surface.

import { makeTexelBuffer, texelAppend, buildTexturesShape } from './textures.js';
import { pathBbox } from './bbox.js';
import { segBbox } from './bbox.js';
import { getCoverQuadMesh } from './mesh.js';

const COVER_QUAD_STRIDE = 12;

/// Build a fresh accumulator. Curve buffer starts with a sentinel
/// zero-texel at index 0 so meta records can use 0 to mean "no
/// segment". Append-only: callers may inspect after a build but must
/// not splice / reorder buffer contents — meta-row indices into the
/// curve/band buffers depend on append order. New build calls extend
/// in place.
export function makeBuildContext() {
  const ctx = {
    curveBuf: makeTexelBuffer(),
    bandBuf: makeTexelBuffer(),
    metas: [],
    parents: [],
    shapeIds: [],
    gradientsUsed: [],
    clipsUsed: [],
    clipBindings: [],
    masksUsed: [],
    maskBindings: [],
    filtersUsed: [],
    imagesUsed: [],
    vecPatternsUsed: [],
    shapesData: [],
    hybridFloats: [],
    strokeMeshFloats: [],
    /// Per-context running gid counter for cover-quad chunks.
    /// Shared so callers building a bundle from multiple importSvg
    /// calls allocate unique gids across imports (e.g. textRun
    /// fanning emoji glyphs through importSvg with opts.ctx).
    nextGid: 1,
  };
  texelAppend(ctx.curveBuf, 0, 0, 0, 0);  // sentinel — idx=0 = "no segment"
  return ctx;
}

/// Segment-density-driven band-count picker. Shared between importSvg
/// and font/textRun. Conservative bounds [4, 96].
export function pickBandsXY(segs, bbox) {
  const w = Math.max(1e-6, bbox[2] - bbox[0]);
  const h = Math.max(1e-6, bbox[3] - bbox[1]);
  let nx = 0, ny = 0;
  for (const s of segs) {
    const sb = segBbox(s);
    if (!sb) { nx++; ny++; continue; }
    if (sb[3] - sb[1] > h * 0.005) nx++;
    if (sb[2] - sb[0] > w * 0.005) ny++;
  }
  if (nx === 0) nx = segs.length;
  if (ny === 0) ny = segs.length;
  return { bandsX: pickBandsAxis(ny), bandsY: pickBandsAxis(nx) };
}

function pickBandsAxis(n) {
  return Math.max(4, Math.min(96, Math.round(Math.sqrt(Math.max(1, n) * 32))));
}

/// Solid-fill (+ optional solid-stroke) per-shape emit into a
/// BuildContext. The shared per-shape work both importSvg and textRun
/// run once segs are in hand.
///
/// opts: { fillRgba, strokeRgba?, strokeWidth?, fillRule?, capStyle?,
///         joinStyle?, miterLimit?, parentIdx?, shapeId?,
///         flagsShape?, colrGraphId? }
/// gidBox: { next: number } — caller-owned gid counter (mutated in
///   place to match the textRun's unconditional-increment behavior).
/// bboxBox: optional { xmin, ymin, xmax, ymax } accumulator unioned
///   with the shape's path-tight bbox; pass null to skip.
///
/// Scope: the simple-fill case (no gradients / clips / masks /
/// blends / filters / images / patterns). importSvg's complex
/// per-shape emit still drives those itself.
export function emitShape(ctx, segs, opts, gidBox, bboxBox = null) {
  const bb = pathBbox(segs);
  const { bandsX, bandsY } = pickBandsXY(segs, bb);
  // Capture the curve-buffer write head (in FLOAT units) BEFORE this
  // shape's curves are appended, so the per-shape curve range is
  // authoritative — glyphLoc (meta texel 4) is a BAND-buffer index, NOT
  // a curve offset, so it can't be used to recover curve ranges on
  // multi-shape bundles. The SVG importer already captures this itself;
  // stamping it here means the shared text-shaping path
  // (textRun.js → emitShape) gets the same authoritative range for free
  // (needed by the no-WebGL fallback's native text bundle, which decodes
  // each glyph's curves back into an SVG <path>).
  const curveStartF = ctx.curveBuf.count * 4;
  // Skip the per-segment stroke metadata when this shape has no visible stroke
  // — its curve buffer is then read only by the fill walk. A stroked shape
  // shares ONE buffer between fill + stroke, so it needs the full encode.
  const fillOnly = !(opts.strokeWidth > 0 && opts.strokeRgba && opts.strokeRgba[3] > 0);
  const info = buildTexturesShape(segs, bandsX, bandsY, bb, ctx.curveBuf, ctx.bandBuf, 0, fillOnly);
  const gid = gidBox.next++;
  const fill = opts.fillRgba;
  // Slug cover-quad (hybrid fill mesh). Skipped for bundles destined for the
  // GPU-resident analytic fill (opts.skipCoverQuad): that path builds its own
  // mesh from the segments, never touching this — so building + uploading
  // cover-quads here would be dead work AND the source of stale-render bugs
  // (a handle uploads them to a per-mount VBO that the analytic stream never
  // refreshes). Not creating them makes a stale Slug render impossible.
  if (!opts.skipCoverQuad) {
    const mesh = getCoverQuadMesh(segs, gid, fill, opts.fillRule || 'nonzero');
    if (mesh.length) {
      const nv = mesh.length / COVER_QUAD_STRIDE;
      const [r, g, b, a] = fill;
      ctx.hybridFloats.push(nv, gid, r, g, b, a, 0, 0, 0, 0, -1, 1);
      for (const f of mesh) ctx.hybridFloats.push(f);
    }
  }
  ctx.metas.push({
    bbox: [info.bbox[0], info.bbox[1], info.bbox[2], info.bbox[3]],
    fillColor:   fill.slice(),
    strokeColor: opts.strokeRgba ? opts.strokeRgba.slice() : [0, 0, 0, 0],
    strokeWidth: opts.strokeWidth || 0,
    fillRule:    opts.fillRule || 'nonzero',
    accumGroupId: gid,
    dashId:       0,
    glyphLoc:     [info.glyphLoc[0], info.glyphLoc[1]],
    bandMaxX:     info.bandMaxX,
    bandMaxY:     info.bandMaxY,
    capStyle:     opts.capStyle || 0,
    // endCapStyle: null = symmetric (cap applies both ends); otherwise
    // a CAP_* enum used only at the segment's far end. Asymmetric caps
    // come from Flash LineStyle2; SVG has no syntax for this.
    endCapStyle:  (opts.endCapStyle == null) ? null : opts.endCapStyle,
    joinStyle:    opts.joinStyle || 0,
    miterLimit:   opts.miterLimit ?? 4,
    flagsShape:   opts.flagsShape || 0,
    fillGradId:   0, strokeGradId: 0,
    clipId:       0, maskId: 0,
    filterId:     0, blendMode: 0, isolation: 0,
    imageId:      0,
    // strokeImageId: 1-based atlas id when LineStyle2 carries bitmap-fill
    // stroke (Flash). SVG has no native syntax — populated by SWF
    // ingestion. 0 = no bitmap stroke (use solid / gradient).
    strokeImageId: opts.strokeImageId || 0,
    imageRect:    [0, 0, 0, 0],
    atlasSlot:    [0, 0, 0, 0],
    colrGraphId:  opts.colrGraphId || 0,
    // Per-shape curve-buffer start (float units). The SVG importer also
    // sets this on its own meta records; consumers build curveRangesByShape
    // by pairing each shape's begin with the next shape's begin.
    _curveStartF: curveStartF,
  });
  ctx.parents.push(opts.parentIdx ?? -1);
  ctx.shapeIds.push(opts.shapeId || '');
  if (bboxBox) {
    if (bb[0] < bboxBox.xmin) bboxBox.xmin = bb[0];
    if (bb[1] < bboxBox.ymin) bboxBox.ymin = bb[1];
    if (bb[2] > bboxBox.xmax) bboxBox.xmax = bb[2];
    if (bb[3] > bboxBox.ymax) bboxBox.ymax = bb[3];
  }
  return ctx.metas.length - 1;
}
