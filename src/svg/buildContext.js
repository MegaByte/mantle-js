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
import { segBboxInto } from './bbox.js';
import { getCoverQuadMesh } from './mesh.js';
const COVER_QUAD_STRIDE = 12;

/// Build a fresh accumulator. Curve buffer starts with a sentinel
/// zero-texel at index 0 so meta records can use 0 to mean "no
/// segment". Append-only: callers may inspect after a build but must
/// not splice / reorder buffer contents — meta-row indices into the
/// curve/band buffers depend on append order. New build calls extend
/// in place.
export function makeBuildContext(opts = {}) {
  const ctx = {
    // Band policy. The V bands exist solely for SLUG's second (vertical) ray:
    // renderFillAAC reads GD.w (bandsY) and never touches bandsX. An AAC-only
    // bundle can therefore collapse them to a single V band, which keeps the
    // layout and the Slug path CORRECT (just slower, if Slug is ever used) while
    // dropping roughly half of the band buffer.
    //
    // NOTE a transposed AAC (∫clamp(Yl)·dXl on the V bands) measures slower than
    // the H sweep, so AAC has no reason to want the V bands back.
    vBands: opts.vBands !== false,
    // PAIR BANDS. Each H band lists stripes {b, b+1}. AAC then serves a straddling
    // cell with ONE walk (-14..-30%); Slug pays +8..15% walking the superset. The
    // two engines want opposite layouts, so this is a build-time choice and the
    // shader is told which it is reading (BUNDLE_FLAG_PAIR_BANDS → the
    // MANTLE_AAC_PAIR_BANDS define). Reading a stripe bundle with the pair walk
    // would silently drop segments.
    pairBands: !!opts.pairBands,
    // opt-in GWN run tree: importSvg({ gwnTree: true }) / createTextBundle({ gwnTree: true }).
    gwnTree: !!opts.gwnTree,
    // Band-count coefficient for pickBandsAxis. k=32 for BOTH layouts: smaller k
    // hurts dense shapes (fewer, longer band lists), larger k ties within noise
    // while costing band-buffer memory. Pair bands do not want a different k.
    bandK: opts.bandK || 32,
    // Union of segment types (bit per SEG_LINE/QUAD/CUBIC/ARC) across every shape.
    // A bundle that never uses a type lets BOTH walkers compile that kernel out.
    segTypeMask: 0,
    totalSegments: 0,
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

/// Segment-density-driven band-count picker. THE single definition — importSvg,
/// font/textRun, streamGeometry and bundleFinalize all route here. Keep it that
/// way: every writer must agree on band counts or meta/band indices diverge.
///
/// Continuous-NPOT: the shader's band-location calc wraps at a 4096-texel row
/// regardless of POT, so any band count works as long as writer + shader agree
/// on the offset. H and V are picked independently from per-axis segment density
/// — a wide-and-thin shape doesn't need 64 H bands.
///
/// Coefficient k=32 → target ≈ sqrt(32·N). Per-band-walk cost in the shader is
/// O(segs/band); the per-pixel band-header read is O(1), so over-provisioning
/// bands is cheap until ctx.bandBuf footprint starts hurting cache — k=32 sits
/// at that knee. Note this makes segs-per-band = sqrt(N/32),
/// i.e. deliberately TINY lists, so any fixed
/// per-fragment cost in a walker is proportionally large. Slug never sees a
/// downside from more bands (its H-ray reads exactly one band); the AAC walker
/// does, because its 1px cell can straddle a boundary and force a second walk.
/// Bounds [4, 96].
export function pickBandsXY(segs, bbox, vBands = true, k = 32) {
  const w = Math.max(1e-6, bbox[2] - bbox[0]);
  const h = Math.max(1e-6, bbox[3] - bbox[1]);
  let nx = 0, ny = 0;
  const sb4 = [0, 0, 0, 0];
  for (const s of segs) {
    segBboxInto(s, sb4, 0);
    // A segment "contributes to H bands" when it spans some Y range — i.e. a
    // horizontal ray could cross it. Same vice-versa for V.
    if (sb4[3] - sb4[1] > h * 0.005) nx++;
    if (sb4[2] - sb4[0] > w * 0.005) ny++;
  }
  // Fallback: if the filter dropped everything, use the raw count.
  if (nx === 0) nx = segs.length;
  if (ny === 0) ny = segs.length;
  // bandsY = number of H bands (slice along Y) → driven by H-crossing segs (nx).
  // bandsX = number of V bands (slice along X) → ny.
  // vBands === false ⇒ one V band (Slug still correct; AAC never reads them).
  return { bandsX: vBands ? pickBandsAxis(ny, k) : 1, bandsY: pickBandsAxis(nx, k) };
}

// Per-axis band count from segment count n and coefficient k. k defaults to 32
// for both layouts (see the bandK note in makeBuildContext); result is clamped
// to [4, 96].
export function pickBandsAxis(n, k = 32) {
  return Math.max(4, Math.min(96, Math.round(Math.sqrt(Math.max(1, n) * k))));
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
  const { bandsX, bandsY } = pickBandsXY(segs, bb, ctx.vBands !== false, ctx.bandK || 32);
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
  const info = buildTexturesShape(segs, bandsX, bandsY, bb, ctx.curveBuf, ctx.bandBuf, 0, fillOnly, false, ctx.pairBands === true, ctx.gwnTree === true);
  ctx.segTypeMask |= info.typeMask;
  ctx.totalSegments += info.numSegments | 0;
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
