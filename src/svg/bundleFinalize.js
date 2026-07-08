// bundleFinalize.js — SVG import phase 2: BUNDLE ASSEMBLY. The walk
// (importWalk.js) has decoded every element into ctx.shapesData; this module
// turns that into the bundle struct: cover quads + meta shells, band-packed
// curve/band buffers, occupancy grid, sprite ranges, clip/mask/pattern meta
// rows, gradient/dash/filter/image tables, and the final section views.
// importer.js orchestrates (parse → walk → finalizeBundle) and re-exports.
import { elementChildren, switchChildMatches, resolveIdRef } from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseLength, parseLengthOr } from './length.js';
import { parsePatternDef } from './pattern.js';
import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  CAP_BUTT, CAP_ROUND, CAP_SQUARE,
  JOIN_MITER, JOIN_ROUND, JOIN_BEVEL, JOIN_ARCS,
  CAP_ENUM, JOIN_ENUM,
  mkLine, mkQuad, mkCubic, mkArc,
  segStartEnd, segStart, segEnd, segsToPathD,
  arcEndpointToCenter, arcToNative, arcToCubics,
} from './segment.js';
import { tokenizePath, parsePathD } from './path.js';
import {
  IDENT, matMul, matApply, parseTransform,
  transformSegInto, transformArcNative,
} from './transform.js';
import { parseShape } from './shape.js';
import { CSS_NAMED_COLORS, hslToRgb, parseColor } from './color.js';
import {
  parseStyleString, getParsedStyle, getStyleProp, getInheritedStyleProp, resolveCurrentColor,
  getShapeStyles, isDisplayed, isPaintable, isEffectivelyVisible,
  getCapsJoins, getFillRule,
} from './style.js';
import {
  buildStylesheet, buildStylesheetAsync, setActiveStylesheet, clearActiveStylesheet,
} from './stylesheet.js';
import {
  GRAD_LINEAR, GRAD_RADIAL, GRAD_PAD, GRAD_REFLECT, GRAD_REPEAT,
  GRAD_SPREAD_ENUM, GRAD_UNITS_USER, GRAD_UNITS_BBOX, GRADIENT_FLOATS,
  parseGradientStops, parseGradients, packGradientStops, buildGradientTables,
} from './gradient.js';
import { parseFilters } from "./filter.js";
import { instantiateMarker, parseMarkers } from './marker.js';
import { parseClipsAndMasks } from './clipMask.js';
import {
  segCtrlBbox, segCtrlBboxInto, segBbox, segBboxInto,
  arcTightBbox, curveTightBboxQuad, curveTightBboxQuadInto,
  curveTightBboxCubic, curveTightBboxCubicInto, pathBbox,
  splitSubpathsWithCloseInto, polygonSignedArea,
} from "./bbox.js";
import { getCoverQuadMesh } from "./mesh.js";
import {
  makeTexelBuffer, texelEnsure, texelAppend, texelSet, texelXYOf, texelToBytes,
  segArcLen, encodeSeg, segTangentAt, segTangentAtInto,
  buildPathArcLengthLut, samplePathAt, buildTexturesShape,
} from "./textures.js";
import { packMetaBody } from './meta.js';
import { buildOccupancyGrid } from './occupancy.js';
import { decodeImageHref, preloadImages, downscaleRgba8 } from './image.js';
import { makeBuildContext, pickBandsXY, emitShape } from './buildContext.js';
import { unionPaths } from './pathBoolean/union.js';
import { runImportWalk } from './importWalk.js';
import { buildFilterSections } from './importFilters.js';

// Bundle-level flag bits (consumers may peek bundle.flags).
export const BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM = 1;
export const BUNDLE_FLAG_HYBRID_MESH_CHUNKED = 2;
export const BUNDLE_FLAG_WIDE_BAND_HEADERS = 4;
export const TEXTURE_WIDTH = 4096;
export const META_FLOATS_V3 = 48;  // 12 texels: 9 + image em-rect + atlas slot + primitive fast-path
export const COVER_QUAD_STRIDE = 12;

export async function finalizeBundle(root, opts, defaultFill, defaultStroke, defaultStrokeW, preserveViewport, ctx, walk, walkCtx) {
  // Build cover quads + meta shells: each shape can produce a fill
  // shell (accumGroupId > 0) and/or a stroke shell (accumGroupId = 0).
  // (`ctx.metas`, `ctx.curveBuf`, `ctx.bandBuf` are hoisted to the top of
  // importSvgInner so vector-pattern claim can use them during the walk.)
  // nextGid lives on ctx so multiple importSvg calls sharing one
  // ctx (e.g. textRun's SVG-in-OT fan-out) allocate distinct gids.
  // Continuous-NPOT band picker. The shader's band-location calc wraps
  // at a 4096-texel row regardless of POT, so any band count works as
  // long as writer + shader agree on the offset. Pick H and V independently from per-axis
  // segment density — a wide-and-thin shape doesn't need 64 H bands.
  // Coefficient k=32 → target ≈ sqrt(32·N). Per-band-walk cost in the
  // shader is O(segs/band); per-pixel band-header read is O(1), so
  // over-provisioning bands is cheap until ctx.bandBuf footprint starts
  // hurting cache. k=32 is the knee: higher k grows the bundle ~10% per
  // step for negligible gain.
  function pickBandsAxis(densitySegCount) {
    const target = Math.round(Math.sqrt(Math.max(1, densitySegCount) * 32));
    return Math.max(4, Math.min(96, target));
  }
  // Per-axis density: count of segments whose extent on that axis is
  // non-trivial (filters out near-axis-aligned slivers that don't
  // benefit from finer bands on the perpendicular axis).
  function pickBandsXY(segs, bbox) {
    const w = Math.max(1e-6, bbox[2] - bbox[0]);
    const h = Math.max(1e-6, bbox[3] - bbox[1]);
    let nx = 0, ny = 0;
    const sb4 = [0, 0, 0, 0];
    for (const s of segs) {
      segBboxInto(s, sb4, 0);
      // A segment "contributes to H bands" when it spans some Y range
      // — i.e. a horizontal ray could cross it. Same vice-versa for V.
      if (sb4[3] - sb4[1] > h * 0.005) nx++;
      if (sb4[2] - sb4[0] > w * 0.005) ny++;
    }
    // Fallback: if filter dropped everything, use raw count.
    if (nx === 0) nx = segs.length;
    if (ny === 0) ny = segs.length;
    // bandsY = number of H bands (slice along Y) → driven by H-crossing
    // segments (nx). bandsX = number of V bands (slice along X) → ny.
    return { bandsX: pickBandsAxis(ny), bandsY: pickBandsAxis(nx) };
  }

  // Perimeter-outline silhouette: opt-in via opts.computeSilhouette.
  // Runs the path-boolean union over every filled shape collected so
  // far, then injects the result as a synthetic STROKE-ONLY shape at
  // the START of ctx.shapesData so it draws BEHIND all other shapes
  // (the canonical "outline shape" pattern). The stroke chunk then rides
  // the existing
  // chunk-emission pipeline below (mesh, curves, bands, meta) — no
  // separate codepath needed.
  //
  // Placeholder color/width: opts.outlineColor (default white) and
  // opts.outlineWidth (default 4 em-units). Per-instance recoloring
  // at draw time uses the existing OverrideTable mechanism (set
  // absolute stroke color on the synthetic shape's meta row via
  // bundle.shapeIds[0]). Width is baked in.
  if (opts.computeSilhouette && !ctx._silhouetteInjected) {
    const filledShapes = [];
    for (const sd of ctx.shapesData) {
      if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') continue;
      if (!sd.segs || !sd.segs.length) continue;
      if (!sd.fillRgba || sd.fillRgba[3] === 0) continue;
      filledShapes.push({ segs: sd.segs, fillRule: sd.fillRule || 'nonzero' });
    }
    if (filledShapes.length > 0) {
      const silSegs = unionPaths(filledShapes);
      if (silSegs.length > 0) {
        const silColor = opts.outlineColor || [1, 1, 1, 1];
        const silWidth = (opts.outlineWidth != null) ? opts.outlineWidth : 4;
        // Synthetic stroke-only shape. Field set mirrors what a normal
        // <path stroke="..." stroke-width="..." fill="none"> would
        // produce after parsing.
        const silShape = {
          kind: 'path',
          segs: silSegs,
          fillRgba:   [0, 0, 0, 0],        // no fill
          strokeRgba: silColor,
          sw: silWidth,
          fillRule: 'nonzero',
          capStyle: 0,                      // CAP_BUTT
          joinStyle: 0,                     // JOIN_MITER
          miterLimit: 4,
          flagsShape: 0,
          shapeId: '__silhouette__',
          anchorHref: '',
        };
        ctx.shapesData.unshift(silShape);
        ctx._silhouetteInjected = true;
      }
    }
  }

  // Pre-pass: per-shape bbox (path-tight, halfW-padded for stroked
  // shapes). Used by the clip/mask emission loop below to materialize
  // objectBoundingBox layer geometry for shapes that requested it.
  // Empty for group-flatten records (sd.kind === 'groupBegin'/'groupEnd').
  const shapeBb = new Array(ctx.shapesData.length).fill(null);
  // Unpadded (path-tight) bbox cache — main shape loop + emitMetaSuffix
  // re-use it to skip redundant pathBbox walks (a tight per-seg walk).
  const shapeBbRaw = new Array(ctx.shapesData.length).fill(null);
  for (let i = 0; i < ctx.shapesData.length; i++) {
    const sd = ctx.shapesData[i];
    if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') continue;
    if (!sd.segs || !sd.segs.length) continue;
    const bb = pathBbox(sd.segs);
    shapeBbRaw[i] = bb;
    if (sd.sw > 0 && sd.strokeRgba[3] > 0) {
      // Stroke bbox = path bbox padded by halfW for the body envelope
      // PLUS the miter limit factor for interior joins. SVG miter
      // joins extend up to halfW * miterLimit past each vertex; without
      // that padding the cover quad + band grid don't reach pixels in
      // the miter wedge and the stroke renders with a circular gap at
      // the join. Caps only extend by halfW (square cap), so the miter
      // factor is the binding constraint for any path with interior joins.
      const halfW = sd.sw * 0.5;
      const miterPad = (sd.joinStyle === 0)
        ? halfW * Math.max(1, sd.miterLimit || 4)
        : halfW;
      shapeBb[i] = [bb[0]-miterPad, bb[1]-miterPad, bb[2]+miterPad, bb[3]+miterPad];
    } else {
      shapeBb[i] = bb;
    }
  }

  // shape-index → (first, last) meta row this shape produced. The
  // visible-pattern stamp uses these to translate ctx.vecPatternsUsed[i]'s
  // recorded (firstShapeIdx, lastShapeIdx) into the contiguous meta-row
  // span for atlasSlot.xy.
  const shapeToFirstMeta = new Array(ctx.shapesData.length).fill(-1);
  const shapeToLastMeta  = new Array(ctx.shapesData.length).fill(-1);
  for (let _si = 0; _si < ctx.shapesData.length; _si++) {
    const sd = ctx.shapesData[_si];
    // Group transition shapes have no geometry — they're scaffolding
    // for the renderer to know where to allocate and composite group
    // FBOs. Push a placeholder meta record (so per-shape indexing
    // stays aligned) with flagsShape bit 6 = groupBegin and bit 7 =
    // groupEnd. The renderer can scan flagsShape to recognise the
    // boundary by scanning flagsShape.
    if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') {
      shapeToFirstMeta[_si] = ctx.metas.length;
      const isBegin = sd.kind === 'groupBegin';
      ctx.metas.push({
        shapeId: '',  // group boundary — no SVG element correspondence
        bbox: [0, 0, 0, 0],
        fillColor: [0, 0, 0, 0],
        strokeColor: [0, 0, 0, 0],
        strokeWidth: 0,
        fillRule: 'nonzero',
        accumGroupId: 0,
        glyphLoc: [0, 0], bandMaxX: 0, bandMaxY: 0,
        _solid_float_start: 0, _solid_float_count: 0,
        _cgeom_byte_off: 0, _cgeom_byte_len: 0,
        capStyle: CAP_BUTT, joinStyle: JOIN_MITER, miterLimit: 4,
        // flagsShape bit layout: bit 0 already used elsewhere; bits 6/7
        // reserved for group transitions.
        flagsShape: isBegin ? (1 << 6) : (1 << 7),
        fillGradId: 0, strokeGradId: 0,
        clipId: 0, maskId: 0,
        filterId: 0,
        blendMode: isBegin ? (sd.blendMode || 0) : 0,
        isolation: isBegin ? (sd.isolation || 0) : 0,
        // groupOpacity is stored in fillColor.alpha (texel 1.w) for
        // groupBegin records — the cover frag never reads this row
        // because the synthetic shape generates no draw entry, so
        // there's no risk of mis-sampling. The renderer that honours
        // group-flatten will read this slot when allocating the FBO.
        // (For groupEnd: opacity is irrelevant.)
        imageId: 0,
        imageRect: [0, 0, 0, 0],
      });
      // Stash the group opacity into fillColor.a slot of the meta we
      // just pushed so the renderer can recover it without an extra
      // sidecar table.
      if (isBegin) {
        const last = ctx.metas[ctx.metas.length - 1];
        last.fillColor = [0, 0, 0, sd.groupOpacity || 1];
      }
      shapeToLastMeta[_si] = ctx.metas.length - 1;
      continue;
    }
    // Reuse the cached path-tight bbox from the pre-pass; pathBbox is
    // a hot walk and we already paid for it once per shape.
    const bboxFull = shapeBbRaw[_si] || pathBbox(sd.segs);
    // Vector stroke pad — must include miter extension. SVG miter
    // joins extend up to halfW*miterLimit past each interior vertex;
    // without that padding the cover quad clips the miter wedge. Two pads:
    //   bboxRender = path + max(halfW, miterPad). Drives band grid +
    //                cover quad so per-pixel distance queries in the
    //                miter wedge get the right band selection AND get
    //                an emitted fragment.
    //   bboxMeta   = path + halfW. Stored on the meta row so the
    //                asset's globalBBox aggregation doesn't grow past
    //                the geometric ink bounds — miter wedges sit
    //                outside the path's perceived footprint and only
    //                need rendering coverage, not asset framing.
    let bbox = bboxFull.slice();
    let bboxMeta = bboxFull.slice();
    if (sd.sw > 0 && sd.strokeRgba[3] > 0) {
      const halfW = sd.sw * 0.5;
      const miterPad = (sd.joinStyle === 0)
        ? halfW * Math.max(1, sd.miterLimit || 4)
        : halfW;
      bbox = [bbox[0]-miterPad, bbox[1]-miterPad, bbox[2]+miterPad, bbox[3]+miterPad];
      bboxMeta = [bboxMeta[0]-halfW, bboxMeta[1]-halfW, bboxMeta[2]+halfW, bboxMeta[3]+halfW];
    }
    // (1) Fill shell via cover quad + curve+band data.
    //
    // Normally a fully-transparent fill (alpha 0) emits no fill row — the
    // shape is invisible, so culling it shrinks the bundle. But that makes a
    // pose's shape SET depend on its per-pose paint: a shape that fades in via
    // fill-opacity (0 → n) is absent in the early poses and present later, so
    // consecutive shape-timeline / morph poses get DIFFERENT topology and the
    // morph can't establish a stable correspondence (the faded shape pops in
    // and neighbours' correspondence shifts). `opts.keepInvisibleShapes` keeps
    // such a shape at alpha 0 so the topology is uniform across poses and the
    // morph lerps its opacity (+ geometry) smoothly. `fill="none"` (no fill
    // paint at all, vs a real color that's merely transparent) is still
    // culled — there's genuinely nothing to draw.
    const keepInvisibleFill = !!opts.keepInvisibleShapes
      && !sd.fillNone && sd.segs && sd.segs.length > 0;
    if (sd.fillRgba[3] > 0 || keepInvisibleFill) {
      // Layer rows (pattern children) don't draw their own cover quad
      // and don't allocate an accumGroupId — they exist purely so the
      // parent pattern's composite loop can sample them via texelFetch
      // on their meta row.
      const gid = sd.isLayer ? 0 : ctx.nextGid++;
      if (!sd.isLayer) {
        const mesh = getCoverQuadMesh(sd.segs, gid, sd.fillRgba, sd.fillRule);
        if (mesh.length) {
          const nv = mesh.length / COVER_QUAD_STRIDE;
          const [r, g, b, a] = sd.fillRgba;
          // The fill rule is honored verbatim — no `hasArc → force
          // evenodd` flip. The DirectFill pipeline runs the
          // ray-cast per pixel via `kind=1` and does not depend on
          // triangle winding, so a shape containing an arc can still use
          // non-zero. Forcing evenodd here would mis-fill annulus /
          // multi-contour arc shapes when the author intended non-zero
          // (e.g. outer + reversed-sweep inner).
          const useEvenOdd = sd.fillRule === 'evenodd';
          const aFlag = useEvenOdd ? -a : a;
          ctx.hybridFloats.push(nv, gid, r, g, b, aFlag, 0, 0, 0, 0, -1, 1);
          // Bulk append (push.apply) avoids per-float function-call overhead;
          // mesh sizes are well under the JS engine's argcount cap.
          Array.prototype.push.apply(ctx.hybridFloats, mesh);
        }
      }
      // curve+band data for the fill: enables per-pixel ray-cast
      // coverage in the curve-hull triangles of DirectFill (replaces the
      // ad-hoc convex/concave bulge logic with the rigorous coverage
      // algorithm). Stored in shared ctx.curveBuf/ctx.bandBuf, indexed by
      // glyphLoc on the meta row.
      //
      // Walk the path through splitSubpathsWithClose so each subpath is
      // explicitly closed by a synthetic line back to its start. The
      // coverage walker's winding accumulator (ray-cast crossings → coverage) only gives
      // correct fill coverage on CLOSED paths; an open polyline leaves
      // path-interior pixels undercounted.
      const closedFillSegs = [];
      splitSubpathsWithCloseInto(sd.segs, closedFillSegs);
      const bxy = pickBandsXY(closedFillSegs, bbox);
      // Capture the curveBuf write head BEFORE buildTexturesShape so
      // we can emit a per-shape curve-range array in `sections`. Used
      // by createShapeMorph to slice src/dst per matched shape. This is
      // an explicit curveBuf offset; meta texel 4 (glyphLoc) is a
      // BAND-buffer index, NOT a curveBuf offset, so deriving the range
      // from glyphLoc would produce out-of-bounds slices on multi-shape
      // morphs.
      const _fillCurveStart = ctx.curveBuf.count * 4;
      const fm = buildTexturesShape(closedFillSegs, bxy.bandsX, bxy.bandsY, bbox,
                                    ctx.curveBuf, ctx.bandBuf, 0, /* fillOnly */ true);

      // Vector pattern: visible parent shape's fill row stamps
      // atlasSlot = (firstMetaRow+1, lastMetaRow+1, 0, 2) — meta-row
      // range is resolved from the recorded (firstShapeIdx, lastShapeIdx)
      // via shapeToFirstMeta/shapeToLastMeta, populated as we emit. The
      // pattern children were appended to ctx.shapesData before the
      // parent, so they've already had their meta rows emitted here.
      let metaAtlasSlot = null;
      let metaImageRect = sd.imageRect || [0, 0, 0, 0];
      let metaPatInvLinear = null;   // vector-pattern inverse linear → texel 5
      if (sd.vecPatternId > 0 && sd.vecPatternId <= ctx.vecPatternsUsed.length) {
        const vp = ctx.vecPatternsUsed[sd.vecPatternId - 1];
        let firstM = -1, lastM = -1;
        for (let s = vp.firstShapeIdx; s <= vp.lastShapeIdx; s++) {
          const f = shapeToFirstMeta[s];
          const l = shapeToLastMeta[s];
          if (f < 0) continue;
          if (firstM < 0) firstM = f;
          lastM = l;
        }
        if (firstM >= 0) {
          metaAtlasSlot = [firstM + 1, lastM + 1, 0, 2];
        }
        // patternTransform M = [a,b,c,d,e,f] (linear L=[[a,c],[b,d]], trans
        // t=(e,f)). The shader samples the tile at p = L⁻¹·emCoord wrapped, so
        // store L⁻¹ (column-major, in the carrier's otherwise-unused texel 5 —
        // _solid/_cgeom are hardcoded 0 for this emission path) and fold the
        // inverse translation into the tile origin. Identity when no transform.
        const [pa, pb, pc, pd, pe, pf] = vp.patM || IDENT;
        const det = pa * pd - pc * pb;
        let patInv = [1, 0, 0, 1];   // column-major mat2 (L⁻¹)
        let origX = metaImageRect[0], origY = metaImageRect[1];
        if (Math.abs(det) > 1e-12) {
          const ia = pd / det, ib = -pb / det, ic = -pc / det, id = pa / det;
          patInv = [ia, ib, ic, id];   // mat2(ia,ib,ic,id)·v = L⁻¹·v
          // tileOriginEff = origin − T⁻¹, T⁻¹ = −L⁻¹·t.
          origX += ia * pe + ic * pf;
          origY += ib * pe + id * pf;
        }
        metaPatInvLinear = patInv;
        metaImageRect = [origX, origY, vp.tileEmW, vp.tileEmH];
      }
      if (shapeToFirstMeta[_si] < 0) shapeToFirstMeta[_si] = ctx.metas.length;
      ctx.metas.push({
        shapeId: sd.shapeId || `shape_${ctx.metas.length}_fill`,
        // Internal: float-index into curveFloats where this shape's
        // curves begin. Stripped during packMetaBody (won't reach
        // the GPU). Used to build sections.curveRangesByShape; the
        // morph slices per-shape curves with these offsets.
        _curveStartF: _fillCurveStart,
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        fillColor: sd.fillRgba,
        strokeColor: [0, 0, 0, 0],
        strokeWidth: 0,
        fillRule: sd.fillRule,
        accumGroupId: gid,
        glyphLoc: fm.glyphLoc,
        bandMaxX: fm.bandMaxX, bandMaxY: fm.bandMaxY,
        _solid_float_start: 0, _solid_float_count: 0,
        _cgeom_byte_off: 0, _cgeom_byte_len: 0,
        capStyle: CAP_BUTT, joinStyle: JOIN_MITER, miterLimit: 4,
        // Fill row keeps only shape-wide vector-effect bits (10/11/12).
        // Bits 0/1 (non-scaling-stroke, hasDash) are stroke-only.
        flagsShape: ((sd.flagsShape || 0) & 0x1C00) | (sd.isLayer ? 0x100 : 0),
        fillGradId: sd.fillGradId || 0, strokeGradId: 0,
        clipId: sd.clipId || 0, maskId: sd.maskId || 0,
        filterId: sd.filterId || 0,
        blendMode: sd.blendMode || 0,
        isolation: sd.isolation || 0,
        imageId: sd.imageId || 0,
        imageRect: metaImageRect,
        atlasSlot: metaAtlasSlot,  // null → back-filled by atlas pass; set → vector pattern sentinel
        patInvLinear: metaPatInvLinear,  // vector-pattern inverse linear (texel 5); null → solid/cgeom
        pixelated: sd.pixelated || 0,
        // Primitive fast path: closed-form fill coverage for tagged primitives
        // (circle=1). The shader derives the shape from this row's bbox and
        // gates on uniform scale; falls back to the ray-cast otherwise. Fill
        // row only — strokes still walk the curve buffer. Suppressed when the
        // fill needs the curve-walk path (gradient / vector-pattern / image
        // paint sample the coverage shape, and clip/mask coverage too).
        primKind: (sd.primKind && !sd.fillGradId && !sd.vecPatternId && !sd.imageId
                   && !sd.clipId && !sd.maskId) ? sd.primKind : 0,
        // roundRect corner radius (em); slot 46. Gated identically to primKind
        // (only meaningful when a roundRect's primKind==3 survives) so it never
        // carries stale rx when the primitive fast-path is suppressed.
        primRx: (sd.primKind === 3 && !sd.fillGradId && !sd.vecPatternId && !sd.imageId
                 && !sd.clipId && !sd.maskId) ? (sd.primRx || 0) : 0,
        // Interior-skip occupancy grid (opt-in). Built from the fill geometry
        // only (paint-agnostic: the skip returns coverage 1.0 for proven-
        // interior fragments, which downstream gradient/clip/blend handle
        // unchanged). Not built for primKind fast-path shapes (already O(1)),
        // vector-pattern carriers (texel-5 slots reused), or coverage-sampled
        // paints would still be correct but skip the build to keep it cheap.
        _occGrid: (opts.occupancyGrid && !sd.primKind && !sd.vecPatternId)
          ? buildOccupancyGrid(sd.segs, bbox, sd.fillRule === 'evenodd',
                               typeof opts.occupancyGrid === 'object' ? opts.occupancyGrid : undefined)
          : null,
      });
    }
    // (2) Stroke shell — emits a cover-quad chunk + curve/band data
    // for inline single-pass-per-shape rendering.
    if (sd.sw > 0 && sd.strokeRgba[3] > 0) {
      const sbxy = pickBandsXY(sd.segs, bbox);
      // Pad band membership by halfW so pixels within stroke distance
      // of a segment that lives in an adjacent band still discover it.
      const _strokeCurveStart = ctx.curveBuf.count * 4;
      // Use the miter-padded bbox for the band grid so per-pixel
      // distance queries on miter wedges fall in the right band;
      // pass the matching miter-pad to getCoverQuadMesh so the
      // cover quad emits fragments at those pixels.
      const halfWStroke = sd.sw * 0.5;
      const strokePad = (sd.joinStyle === 0 || sd.joinStyle === JOIN_ARCS)
        ? halfWStroke * Math.max(1, sd.miterLimit || 4)
        : halfWStroke;
      const sm = buildTexturesShape(sd.segs, sbxy.bandsX, sbxy.bandsY, bbox,
                                    ctx.curveBuf, ctx.bandBuf, strokePad,
                                    false, sd.joinStyle === JOIN_ARCS);

      // Layer stroke rows: no cover-quad mesh, no accum gid — the parent
      // pattern composite samples their stroke coverage directly.
      const sgid = sd.isLayer ? 0 : ctx.nextGid++;
      if (!sd.isLayer) {
        const strokeMesh = getCoverQuadMesh(sd.segs, sgid, sd.strokeRgba, 'nonzero', strokePad);
        if (strokeMesh.length) {
          const nv = strokeMesh.length / COVER_QUAD_STRIDE;
          const [r, g, b, a] = sd.strokeRgba;
          // strokes don't have a fill rule — use nonzero (positive aFlag).
          ctx.hybridFloats.push(nv, sgid, r, g, b, a, 0, 0, 0, 0, -1, 1);
          Array.prototype.push.apply(ctx.hybridFloats, strokeMesh);
        }
      }

      if (shapeToFirstMeta[_si] < 0) shapeToFirstMeta[_si] = ctx.metas.length;
      ctx.metas.push({
        shapeId: sd.shapeId
          ? `${sd.shapeId}_stroke`
          : `shape_${ctx.metas.length}_stroke`,
        _curveStartF: _strokeCurveStart,
        // Use the halfW-padded ink-tight bbox for meta storage. The
        // band grid + cover quad use the miter-padded version (`bbox`)
        // so per-pixel rendering correctly reaches miter wedges, but
        // the asset's globalBBox aggregation reads m.bbox and we want
        // it to stay tight to the perceived stroke ink.
        bbox: [bboxMeta[0], bboxMeta[1], bboxMeta[2], bboxMeta[3]],
        fillColor: [0, 0, 0, 0],
        strokeColor: sd.strokeRgba,
        strokeWidth: sd.sw,
        fillRule: sd.fillRule,
        accumGroupId: sgid,
        glyphLoc: sm.glyphLoc,
        bandMaxX: sm.bandMaxX, bandMaxY: sm.bandMaxY,
        _solid_float_start: 0, _solid_float_count: 0,
        _cgeom_byte_off: 0, _cgeom_byte_len: 0,
        capStyle: sd.capStyle, joinStyle: sd.joinStyle, miterLimit: sd.miterLimit,
        flagsShape: (sd.flagsShape || 0) | (sd.isLayer ? 0x100 : 0),
        fillGradId: 0, strokeGradId: sd.strokeGradId || 0,
        strokeImageId: sd.strokeImageId || 0,   // bitmap-fill stroke (image pattern)
        clipId: sd.clipId || 0, maskId: sd.maskId || 0,
        filterId: sd.filterId || 0,
        blendMode: sd.blendMode || 0,
        isolation: sd.isolation || 0,
      });
    }
    // paint-order: stroke fill — swap the last two ctx.metas this shape
    // emitted so the stroke draws first (under the fill). Fills are
    // emitted iff sd.fillRgba[3] > 0; strokes iff sd.sw > 0 && sd.strokeRgba[3] > 0.
    // Only swap if BOTH were emitted; single-paint shapes are a no-op.
    if (sd.strokeFirst) {
      const hadFill = sd.fillRgba[3] > 0;
      const hadStroke = sd.sw > 0 && sd.strokeRgba[3] > 0;
      if (hadFill && hadStroke && ctx.metas.length >= 2) {
        const a = ctx.metas.length - 2, b = ctx.metas.length - 1;
        const tmp = ctx.metas[a]; ctx.metas[a] = ctx.metas[b]; ctx.metas[b] = tmp;
      }
    }
    if (shapeToFirstMeta[_si] >= 0) shapeToLastMeta[_si] = ctx.metas.length - 1;
  }

  // Sprite-sheet ranges: { spriteId: [firstMetaRow, lastMetaRow] } in
  // meta-row space (the space drawSprite + the override table address). One
  // entry per top-level <g id> / lone id'd top-level shape (stamped as
  // sd._spriteId during the walk). Built post-loop from the same
  // shapeToFirst/LastMeta arrays clipperRows uses, so it survives the
  // shapesData→meta index drift (group scaffolding, fill+stroke pairs).
  //
  // Contiguity: a sprite's shapes are normally a single contiguous meta-row
  // span (document-order DFS). Vector patterns / clip children can inject
  // OTHER shapes mid-span, splitting it. We record the OUTER [min,max] span
  // and flag any sprite whose own shape count < span length (i.e. foreign
  // rows fall inside) in spriteRangesNonContiguous, so drawSprite can warn
  // rather than silently paint a neighbour's shapes.
  const _spriteSpan = new Map();   // id -> { lo, hi, count }
  for (let _si = 0; _si < ctx.shapesData.length; _si++) {
    const sid = ctx.shapesData[_si]._spriteId;
    if (!sid) continue;
    const fm = shapeToFirstMeta[_si], lm = shapeToLastMeta[_si];
    if (fm < 0 || lm < 0) continue;   // emitted no meta rows (e.g. group scaffolding)
    let e = _spriteSpan.get(sid);
    if (!e) { e = { lo: fm, hi: lm, count: 0 }; _spriteSpan.set(sid, e); }
    if (fm < e.lo) e.lo = fm;
    if (lm > e.hi) e.hi = lm;
    e.count += (lm - fm + 1);
  }
  const spriteRangesObj = {};
  const spriteRangesNonContiguous = [];
  for (const [sid, e] of _spriteSpan) {
    spriteRangesObj[sid] = [e.lo, e.hi];
    if (e.count !== (e.hi - e.lo + 1)) spriteRangesNonContiguous.push(sid);
  }

  // Emit clip / mask paths as additional meta rows with full
  // curve+band data. The shader runs the same per-pixel ray-cast on
  // a clip's meta row to compute its coverage, then multiplies the
  // referencing shape's coverage by it. Marker bit `flagsShape & 0x100`
  // identifies layer-only ctx.metas so the mesh emitter skips drawing
  // their bbox quads (they're not painted; only sampled).
  // Layer ctx.metas are appended AFTER all visible shape ctx.metas so the
  // visible-shape meta-row indices stay 0..N-1 unchanged.
  const FLAG_LAYER = 0x100;
  // 1-based layer-meta row index for each clip / mask (filled below).
  const clipMetaRow = new Array(ctx.clipsUsed.length).fill(0);
  // 1-based last-layer-row for each clip (the FLAG_CLIP_END row of
  // multi-shape clips; same as clipMetaRow for single-shape clips).
  // Needed by the animatable-clipper API: setClipper(svgId)
  // writes the affine override to ALL layer rows in [first..last] so
  // every child of a multi-shape clip transforms together.
  const clipMetaLastRow = new Array(ctx.clipsUsed.length).fill(0);
  const maskMetaRow = new Array(ctx.masksUsed.length).fill(0);
  // 1-based last layer row of each mask (= maskMetaRow for single-child
  // masks). Lets clipperRows expose a mask's full child-row range so the
  // native fallback can morph mask geometry (the reveal wipe).
  const maskMetaLastRow = new Array(ctx.masksUsed.length).fill(0);
  const FLAG_MASK_BEGIN = 1 << 9;
  const FLAG_MASK_END   = 1 << 10;

  // Helper: emit meta rows for shapes appended after a clip/mask
  // subtree walk. Handles fill/stroke degeneracy + IsLayer. Returns
  // (firstMeta, lastMeta) in 0-based meta-row indices.
  function emitMetaSuffix(fromShapeIdx) {
    while (shapeToFirstMeta.length < ctx.shapesData.length) shapeToFirstMeta.push(-1);
    while (shapeToLastMeta.length  < ctx.shapesData.length) shapeToLastMeta.push(-1);
    let firstMeta = -1, lastMeta = -1;
    for (let i = fromShapeIdx; i < ctx.shapesData.length; i++) {
      const sd = ctx.shapesData[i];
      if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') continue;
      if (!sd.segs || !sd.segs.length) continue;
      // Reuse cached path-tight bbox if available (most main-pass
      // shapes); layer-walk shapes are appended post-prep so they
      // miss the cache — compute lazily and stash for later.
      let fillBb2 = shapeBbRaw[i];
      if (!fillBb2) {
        fillBb2 = pathBbox(sd.segs);
        if (i < shapeBbRaw.length) shapeBbRaw[i] = fillBb2;
      }
      const fillBbValid = fillBb2[2] > fillBb2[0] && fillBb2[3] > fillBb2[1];
      let bbox2 = fillBb2.slice();
      if (sd.sw > 0 && sd.strokeRgba && sd.strokeRgba[3] > 0) {
        const halfW = sd.sw * 0.5;
        const pad = (sd.joinStyle === 0)
          ? halfW * Math.max(1, sd.miterLimit || 4)
          : halfW;
        const xmin = isFinite(fillBb2[0]) ? fillBb2[0] : 0;
        const ymin = isFinite(fillBb2[1]) ? fillBb2[1] : 0;
        const xmax = isFinite(fillBb2[2]) ? fillBb2[2] : 0;
        const ymax = isFinite(fillBb2[3]) ? fillBb2[3] : 0;
        bbox2 = [xmin - pad, ymin - pad, xmax + pad, ymax + pad];
      }
      const strokeBbValid = bbox2[2] > bbox2[0] && bbox2[3] > bbox2[1];
      if (!fillBbValid && !strokeBbValid) continue;
      const fillBboxDegen = !fillBbValid || (fillBb2[2] - fillBb2[0]) < 1e-6 || (fillBb2[3] - fillBb2[1]) < 1e-6;
      // Fill row.
      if (sd.fillRgba && sd.fillRgba[3] > 0 && !fillBboxDegen) {
        const psubs = [];
        splitSubpathsWithCloseInto(sd.segs, psubs);
        const pbbox = fillBb2;  // path-tight for layer rows
        const pbxy = pickBandsXY(psubs, pbbox);
        const _layerFillStart = ctx.curveBuf.count * 4;
        const pfm = buildTexturesShape(psubs, pbxy.bandsX, pbxy.bandsY, pbbox, ctx.curveBuf, ctx.bandBuf);
        if (shapeToFirstMeta[i] < 0) shapeToFirstMeta[i] = ctx.metas.length;
        if (firstMeta < 0) firstMeta = ctx.metas.length;
        lastMeta = ctx.metas.length;
        ctx.metas.push({
          shapeId: sd.shapeId || `shape_${ctx.metas.length}_fill`,
          _curveStartF: _layerFillStart,
          bbox: [pbbox[0], pbbox[1], pbbox[2], pbbox[3]],
          fillColor: sd.fillRgba,
          strokeColor: [0, 0, 0, 0], strokeWidth: 0,
          fillRule: sd.fillRule, accumGroupId: 0,
          glyphLoc: pfm.glyphLoc, bandMaxX: pfm.bandMaxX, bandMaxY: pfm.bandMaxY,
          _solid_float_start: 0, _solid_float_count: 0,
          _cgeom_byte_off: 0, _cgeom_byte_len: 0,
          capStyle: CAP_BUTT, joinStyle: JOIN_MITER, miterLimit: 4,
          flagsShape: FLAG_LAYER,
          fillGradId: sd.fillGradId || 0, strokeGradId: 0,
          // Propagate clipId / maskId for nested clipPath/mask support:
          // a clip-child can carry `clip-path="url(#inner)"`, and the
          // post-walk rewrite loop translates the 1-based registry ref
          // to a 1-based meta-row ref. The shader's depth-1 nested-clip
          // evaluator then AND-multiplies the inner clip's coverage
          // into the child's coverage.
          clipId: sd.clipId || 0, maskId: sd.maskId || 0,
          filterId: 0, blendMode: 0, isolation: 0,
          imageId: sd.imageId || 0,
          imageRect: sd.imageRect || [0, 0, 0, 0],
          pixelated: sd.pixelated || 0,
        });
      }
      // Stroke row.
      const strokeDegen = (fillBb2[2] - fillBb2[0]) < 1e-6 && (fillBb2[3] - fillBb2[1]) < 1e-6;
      if (sd.sw > 0 && sd.strokeRgba && sd.strokeRgba[3] > 0 && !strokeDegen) {
        const sbxy = pickBandsXY(sd.segs, bbox2);
        const _layerStrokeStart = ctx.curveBuf.count * 4;
        const sm = buildTexturesShape(sd.segs, sbxy.bandsX, sbxy.bandsY, bbox2,
                                       ctx.curveBuf, ctx.bandBuf, sd.sw * 0.5);
        let flagsShape = FLAG_LAYER;
        if (sd.flagsShape & 2) flagsShape |= 2;  // dash bit
        if (sd.flagsShape & 1) flagsShape |= 1;  // non-scaling stroke
        if (shapeToFirstMeta[i] < 0) shapeToFirstMeta[i] = ctx.metas.length;
        if (firstMeta < 0) firstMeta = ctx.metas.length;
        lastMeta = ctx.metas.length;
        ctx.metas.push({
          shapeId: sd.shapeId
            ? `${sd.shapeId}_stroke`
            : `shape_${ctx.metas.length}_stroke`,
          _curveStartF: _layerStrokeStart,
          bbox: [bbox2[0], bbox2[1], bbox2[2], bbox2[3]],
          fillColor: [0, 0, 0, 0],
          strokeColor: sd.strokeRgba,
          strokeWidth: sd.sw,
          fillRule: sd.fillRule, accumGroupId: 0,
          glyphLoc: sm.glyphLoc, bandMaxX: sm.bandMaxX, bandMaxY: sm.bandMaxY,
          _solid_float_start: 0, _solid_float_count: 0,
          _cgeom_byte_off: 0, _cgeom_byte_len: 0,
          capStyle: sd.capStyle, joinStyle: sd.joinStyle, miterLimit: sd.miterLimit,
          flagsShape,
          fillGradId: 0, strokeGradId: sd.strokeGradId || 0,
          strokeImageId: sd.strokeImageId || 0,
          // Nested clipPath support — see fill row above.
          clipId: sd.clipId || 0, maskId: sd.maskId || 0,
          filterId: 0, blendMode: 0, isolation: 0,
        });
      }
      if (shapeToFirstMeta[i] >= 0) shapeToLastMeta[i] = ctx.metas.length - 1;
    }
    return { firstMeta, lastMeta };
  }

  // Re-enter the main walk() on each used clip/mask def's element.
  // Pattern children flow through the same walker — every feature
  // (transforms, gradients, images, dashes, clips, masks, filters,
  // <use>, etc.) applies inside <clipPath> and <mask> children with
  // zero duplication.
  // Drain clips + masks to a fixed point. The mask loop can walk a
  // clip-path attribute on a mask child, claiming a NEW clip into
  // ctx.clipsUsed after the clip loop already finished. Re-enter
  // both loops while either has unclaimed entries. processedClips /
  // processedMasks track the already-emitted prefix so we don't
  // re-walk children that were already emitted.
  let processedClips = 0;
  let processedMasks = 0;
  while (processedClips < ctx.clipsUsed.length
      || processedMasks < ctx.masksUsed.length) {
  for (let ci = processedClips; ci < ctx.clipsUsed.length; ci++) {
    const clip = ctx.clipsUsed[ci];
    if (!clip.element) continue;
    let ctm = IDENT;
    if (ctx.clipBindings[ci] >= 0) {
      const refBb = shapeBb[ctx.clipBindings[ci]];
      if (refBb && refBb[2] > refBb[0] && refBb[3] > refBb[1]) {
        const w = refBb[2] - refBb[0], h = refBb[3] - refBb[1];
        ctm = [w, 0, 0, h, refBb[0], refBb[1]];
      }
    }
    const startShapes = ctx.shapesData.length;
    const savedLayer = walkCtx.walkLayerMode;
    walkCtx.walkLayerMode = true;
    try {
      const els = elementChildren(clip.element);
      for (let i = 0; i < els.length; i++) {
        walk(els[i], defaultFill, defaultStroke, defaultStrokeW, ctm);
      }
    } finally { walkCtx.walkLayerMode = savedLayer; }
    const { firstMeta, lastMeta } = emitMetaSuffix(startShapes);
    if (firstMeta >= 0) {
      // Grow clipMetaRow on demand: nested clip-path attrs on
      // clip/mask children can push new entries to ctx.clipsUsed
      // mid-drain.
      while (clipMetaRow.length <= ci) clipMetaRow.push(0);
      while (clipMetaLastRow.length <= ci) clipMetaLastRow.push(0);
      clipMetaRow[ci] = firstMeta + 1;
      clipMetaLastRow[ci] = lastMeta + 1;
      // Multi-shape clipPath union: bracket the layer rows with
      // FLAG_CLIP_BEGIN (bit 11) / FLAG_CLIP_END (bit 12) so the shader
      // walks the contiguous span and ORs (max) per-pixel coverages.
      if (lastMeta > firstMeta) {
        ctx.metas[firstMeta].flagsShape = (ctx.metas[firstMeta].flagsShape || 0) | (1 << 11);
        ctx.metas[lastMeta].flagsShape  = (ctx.metas[lastMeta].flagsShape  || 0) | (1 << 12);
      }
    }
  }
  processedClips = ctx.clipsUsed.length;

  for (let mi = processedMasks; mi < ctx.masksUsed.length; mi++) {
    const mask = ctx.masksUsed[mi];
    if (!mask.element) continue;
    let ctm = IDENT;
    if (ctx.maskBindings[mi] >= 0) {
      const refBb = shapeBb[ctx.maskBindings[mi]];
      if (refBb && refBb[2] > refBb[0] && refBb[3] > refBb[1]) {
        const w = refBb[2] - refBb[0], h = refBb[3] - refBb[1];
        ctm = [w, 0, 0, h, refBb[0], refBb[1]];
      }
    }
    const startShapes = ctx.shapesData.length;
    const savedLayer = walkCtx.walkLayerMode;
    walkCtx.walkLayerMode = true;
    try {
      const els = elementChildren(mask.element);
      for (let i = 0; i < els.length; i++) {
        walk(els[i], defaultFill, defaultStroke, defaultStrokeW, ctm);
      }
    } finally { walkCtx.walkLayerMode = savedLayer; }
    const { firstMeta, lastMeta } = emitMetaSuffix(startShapes);
    if (firstMeta < 0) continue;
    const childMaskId = mi + 1;
    const isLuminance = (mask.maskType !== 'alpha') ? 1 : 0;
    if (lastMeta > firstMeta) {
      // Multi-row mask: bracket with BEGIN/END so the runtime mask-
      // region builder groups the rows into one R8 RT.
      //
      // Preserve nested-mask depth-1 refs: a mask child carrying its
      // own `mask="url(#…)"` already has a non-zero maskId from the
      // child shape's walk. Stamping over it would erase the inner
      // reference that the bake shader's nested-mask AND consumes.
      // Only fill in maskId when the row didn't already capture one.
      // BEGIN/END flags + isolation still go on every row.
      ctx.metas[firstMeta].flagsShape |= FLAG_MASK_BEGIN;
      if (!ctx.metas[firstMeta].maskId) ctx.metas[firstMeta].maskId = childMaskId;
      ctx.metas[firstMeta].isolation = isLuminance;
      ctx.metas[lastMeta].flagsShape |= FLAG_MASK_END;
      if (!ctx.metas[lastMeta].maskId) ctx.metas[lastMeta].maskId = childMaskId;
      ctx.metas[lastMeta].isolation = isLuminance;
      for (let r = firstMeta + 1; r < lastMeta; r++) {
        if (!ctx.metas[r].maskId) ctx.metas[r].maskId = childMaskId;
        ctx.metas[r].isolation = isLuminance;
      }
    } else {
      // Single-row mask. If the only child needs image / gradient /
      // stroke sampling, the in-shader fast path (which only does
      // renderFill + solid color luminance) can't render it correctly.
      // Bracket the lone row with FLAG_MASK_BEGIN | FLAG_MASK_END so the
      // fill-frag mask composite takes the multi-row loop and applies
      // the gradient/image/stroke branch.
      //
      // Also force the bracket when ANY other layer row references
      // this mask via its own MaskId (nested mask depth 1, where this
      // mask is referenced by a child of another mask): the bake-pass
      // nested-mask AND only fires when the inner mask has an array
      // layer, and only multi-shape masks with FLAG_MASK_BEGIN
      // allocate one.
      const m = ctx.metas[firstMeta];
      m.isolation = isLuminance;
      let referencedByMaskChild = false;
      for (let i = 0; i < ctx.metas.length; i++) {
        if (i === firstMeta) continue;
        const om = ctx.metas[i];
        if (((om.flagsShape || 0) & FLAG_LAYER) === 0) continue;
        if (om.maskId === childMaskId) { referencedByMaskChild = true; break; }
      }
      const needsRT = (m.fillGradId || 0) > 0
        || (m.strokeGradId || 0) > 0
        || (m.imageId || 0) > 0
        || (m.strokeWidth || 0) > 0
        || referencedByMaskChild;
      if (needsRT) {
        m.flagsShape = (m.flagsShape || 0) | FLAG_MASK_BEGIN | FLAG_MASK_END;
        if (!m.maskId) m.maskId = childMaskId;
      }
    }
    while (maskMetaRow.length <= mi) maskMetaRow.push(0);
    maskMetaRow[mi] = firstMeta + 1;
    while (maskMetaLastRow.length <= mi) maskMetaLastRow.push(0);
    maskMetaLastRow[mi] = lastMeta + 1;
  }
  processedMasks = ctx.masksUsed.length;
  } // while (drain clips+masks to fixed point)

  // Rewrite each visible shape's clipId / maskId from "1-based index
  // into ctx.clipsUsed / ctx.masksUsed" to "1-based meta-row index of the
  // corresponding layer entry". The shader uses the rewritten field
  // directly to sample _MetaTex.
  //
  // Layer rows (FLAG_LAYER set) get the SAME rewrite when they carry a
  // clipId — that's the "nested clipPath" case: a clip-child has its
  // own clip-path attribute, so its meta texel 7.z must point at the
  // nested clip's first meta row, not the now-stale registry index.
  // The shader's nested-clip eval (mantle.frag.glsl)
  // reads texel 7.z on each clip child and AND-multiplies the nested
  // clip's union coverage into the child's coverage.
  //
  // Mask children: we rewrite maskId on layer rows for consistency,
  // but the mask shader doesn't consult nested maskId on mask children
  // — nested mask is single-level. Rewriting harmlessly produces a
  // correct reference that the shader ignores.
  for (const m of ctx.metas) {
    if (m.clipId > 0 && m.clipId <= clipMetaRow.length)
      m.clipId = clipMetaRow[m.clipId - 1];
    if (m.maskId > 0 && m.maskId <= maskMetaRow.length)
      m.maskId = maskMetaRow[m.maskId - 1];
  }

  // Global bbox = path-tight bounds across all shapes. The bundle
  // ALSO records the SVG viewBox (next to the path-tight bbox) so the
  // renderer can switch reference frames at runtime. Storing both is
  // essentially free (16 bytes) and keeps the binary the source of truth.
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const m of ctx.metas) {
    if (m.flagsShape & FLAG_LAYER) continue;  // don't expand global bbox
    minX = Math.min(minX, m.bbox[0]); minY = Math.min(minY, m.bbox[1]);
    maxX = Math.max(maxX, m.bbox[2]); maxY = Math.max(maxY, m.bbox[3]);
  }
  // viewBox + preserveAspectRatio source:
  //   - Default: the SVG root element.
  //   - When opts.viewName is set: look up <view id="opts.viewName">
  //     and use ITS attributes instead. This is the spec'd mechanism
  //     for SVG fragment-id navigation (`pic.svg#view=foo`): callers
  //     parse the fragment and pass the name here. Falls back to the
  //     root element when no matching view is found.
  let vbSourceEl = root;
  if (opts.viewName) {
    const views = root.getElementsByTagName('view');
    for (let i = 0; i < views.length; i++) {
      if (views[i].getAttribute('id') === opts.viewName) {
        vbSourceEl = views[i];
        break;
      }
    }
  }
  // Extract the viewBox if present. (0,0,0,0) signals "absent" to
  // the renderer. Stored as (xmin, ymin, w, h) to match globalBBox
  // and the shader's uGlobalBBox.
  let vbMinX = 0, vbMinY = 0, vbW = 0, vbH = 0;
  const vbAttr = vbSourceEl.getAttribute('viewBox');
  if (vbAttr) {
    const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(v => Number.isFinite(v)) && parts[2] > 0 && parts[3] > 0) {
      vbMinX = parts[0];
      vbMinY = parts[1];
      vbW = parts[2];
      vbH = parts[3];
    }
  }
  // SVG preserveAspectRatio. Default per spec is "xMidYMid meet"
  // → (1, 1, 0). Encoded as (alignX, alignY, meetOrSlice):
  //   alignX/Y: -1=none, 0=Min, 1=Mid, 2=Max
  //   meetOrSlice: 0=meet, 1=slice
  let parAx = 1, parAy = 1, parMs = 0;
  const parAttr = (vbSourceEl.getAttribute('preserveAspectRatio') || '').trim();
  if (parAttr) {
    const parts = parAttr.split(/\s+/);
    const align = (parts[0] || '').toLowerCase();
    if (align === 'none') { parAx = -1; parAy = -1; }
    else {
      const yIdx = align.indexOf('y');
      if (yIdx > 0 && yIdx + 4 <= align.length) {
        const xPart = align.substring(1, yIdx);
        const yPart = align.substring(yIdx + 1);
        parAx = xPart === 'min' ? 0 : xPart === 'max' ? 2 : 1;
        parAy = yPart === 'min' ? 0 : yPart === 'max' ? 2 : 1;
      }
    }
    if (parts[1] && parts[1].trim().toLowerCase() === 'slice') parMs = 1;
  }
  // If preserveViewport was requested by the caller AND the viewBox
  // exists, also override the path-tight bbox so rendering paths that
  // read the bundle's globalBBox get viewBox semantics.
  if (preserveViewport && vbW > 0 && vbH > 0) {
    minX = vbMinX; minY = vbMinY; maxX = vbMinX + vbW; maxY = vbMinY + vbH;
  } else if (vbW > 0 && vbH > 0 && Number.isFinite(minX)) {
    // Tight (default) mode: re-aggregate the path-tight bounds with each shape
    // CLAMPED to the viewBox. SVG clips content to the viewport (overflow:hidden
    // by default), so geometry extending OUTSIDE the viewBox is invisible and
    // must NOT expand the bundle's bounds. Without this, one off-canvas shape
    // (e.g. a clipped / rotated stripe that overhangs the viewBox) blows up
    // globalBBox, which mis-fits the WHOLE bundle under an identity worldMatrix
    // and drops on-canvas siblings off-screen (the clip was incidental;
    // the trigger is the overhang past the viewBox). Per-shape (not
    // union-then-clamp) so a far overhang contributes
    // only its in-viewBox part. In-viewBox content is unaffected — tight stays
    // tight (⊆ viewBox).
    const vbMaxX = vbMinX + vbW, vbMaxY = vbMinY + vbH;
    let nx = Infinity, ny = Infinity, xx = -Infinity, xy = -Infinity;
    for (const m of ctx.metas) {
      if (m.flagsShape & FLAG_LAYER) continue;
      const bx0 = Math.max(m.bbox[0], vbMinX), by0 = Math.max(m.bbox[1], vbMinY);
      const bx1 = Math.min(m.bbox[2], vbMaxX), by1 = Math.min(m.bbox[3], vbMaxY);
      if (bx1 <= bx0 || by1 <= by0) continue;   // shape lies entirely outside the viewBox
      if (bx0 < nx) nx = bx0; if (by0 < ny) ny = by0;
      if (bx1 > xx) xx = bx1; if (by1 > xy) xy = by1;
    }
    if (Number.isFinite(nx) && xx > nx && xy > ny) {
      minX = nx; minY = ny; maxX = xx; maxY = xy;
    } else {
      // All content lies outside the viewBox → fall back to the viewBox itself.
      minX = vbMinX; minY = vbMinY; maxX = vbMaxX; maxY = vbMaxY;
    }
  }
  // Bundle stores (minX, minY, width, height). Matches the shader's
  // uGlobalBBox convention (.xy = origin, .zw = extent) and is the
  // single format shared with textRun's output.
  const gw = maxX - minX, gh = maxY - minY;

  // Interior-skip occupancy: append each fill row's G×G grid into the CURVE
  // buffer (4 cells per RGBA texel), and stamp the fill row's dead solid slots
  // (texel 5 .xy → meta floats 20/21) with (baseTexelIdx, G). Packing into the
  // already-bound curve buffer means the fill shader reads SOLID_IN bits with
  // the existing texFetch — no extra sampler (the ubershader already binds all
  // 16 texture units). The shader skips the coverage walk when a fragment lands
  // in a SOLID_IN cell AND cellSize ≥ 1.5·emPerPx (so the ≤1px AA ramp can't
  // reach a boundary, keeping output identical to the walk). Never on pattern
  // carriers (their texel 5 holds patInvLinear). Must run BEFORE texelToBytes.
  let anyOccupancy = false;
  for (const m of ctx.metas) {
    if (!m._occGrid || m.patInvLinear) continue;
    const { bits, G } = m._occGrid;
    const base = ctx.curveBuf.count;            // texel index of first cell-texel
    for (let i = 0; i < bits.length; i += 4)
      texelAppend(ctx.curveBuf, bits[i] || 0, bits[i+1] || 0, bits[i+2] || 0, bits[i+3] || 0);
    m._solid_float_start = base;                // baseTexelIdx (texel 5 .x)
    m._solid_float_count = G;                   // grid dim G (texel 5 .y)
    anyOccupancy = true;
  }

  // Curve + band textures populated by buildTexturesShape for strokes.
  const curvesB = texelToBytes(ctx.curveBuf);
  const bandsB  = texelToBytes(ctx.bandBuf);
  const solidB  = new Uint8Array(0);

  // Cover-quad bytes.
  const cgeomB = new Uint8Array(new Float32Array(ctx.hybridFloats).buffer);
  // Wide band headers (plain-float counts + offsets) are the only
  // supported mode. The flag bit is still set on emit so consumers that
  // check it see the expected layout; readers may also ignore it.
  const flags = BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM
              | BUNDLE_FLAG_HYBRID_MESH_CHUNKED
              | BUNDLE_FLAG_WIDE_BAND_HEADERS;

  // Gradient section: records + stops LUT. Empty if no gradients used.
  // Gradients use an exact-stop LUT; record slots 10/11 point into the LUT.
  let gradientsB = new Uint8Array(0), stopsB = new Uint8Array(0);
  let gradientStopsCount = 0;
  if (ctx.gradientsUsed.length) {
    const gt = buildGradientTables(ctx.gradientsUsed);
    gradientsB = gt.records;
    stopsB = gt.stops;
    gradientStopsCount = gt.stopsCount;
  }

  // Dash-pattern section: row-major RGBA32F texture, 16 texels wide, one
  // row per dashed stroke meta. The renderer looks up a shape's dashes by
  // sampling row = (dashId - 1).
  //   texel 0: (cycleLen, patternCount, dashOffset, _pad)
  //   texels 1..15: packed pattern floats (up to 60; real SVG dasharrays
  //                 rarely exceed 6). Values beyond patternCount are ignored.
  // Meta row carries dashId (0 = no dashes) at texel 3 .w so the shader
  // uniformly branches on dashId > 0.
  const DASH_TEX_WIDTH = 16;
  let dashesB = new Uint8Array(0);
  {
    // Stroke-shell ctx.metas are those with accumGroupId == 0 and strokeWidth > 0,
    // emitted in the same order ctx.shapesData is walked. Pair each dashed shape
    // with its meta by matching order.
    // Use shapeToFirstMeta / shapeToLastMeta as the authoritative
    // shape→meta-row mapping (robust to skipped fill rows from bbox/area
    // degeneracy, e.g. an axis-aligned <line> with zero height).
    let nextDashId = 1;
    const dashRows = [];
    for (let si = 0; si < ctx.shapesData.length; si++) {
      const sd = ctx.shapesData[si];
      if (!sd.dashArray || !sd.dashArray.length) continue;
      if (!(sd.sw > 0 && sd.strokeRgba && sd.strokeRgba[3] > 0)) continue;
      const f = shapeToFirstMeta[si];
      const l = shapeToLastMeta[si];
      if (f < 0) continue;
      // Stroke meta is the last row this shape emitted (fill row, if
      // any, comes first). Detect by stroke-color presence.
      let strokeRow = l;
      if (!ctx.metas[strokeRow] || (ctx.metas[strokeRow].strokeColor[3] || 0) <= 0) {
        if (strokeRow > f) strokeRow = f;
      }
      const cycle = sd.dashArray.reduce((a, b) => a + b, 0);
      const row = new Float32Array(DASH_TEX_WIDTH * 4);
      row[0] = cycle;
      row[1] = sd.dashArray.length;
      row[2] = sd.dashOffset || 0;
      row[3] = 0;
      for (let k = 0; k < Math.min(sd.dashArray.length, DASH_TEX_WIDTH*4 - 4); k++)
        row[4 + k] = sd.dashArray[k];
      dashRows.push(row);
      ctx.metas[strokeRow].dashId = nextDashId++;
    }
    if (dashRows.length) {
      const total = new Float32Array(DASH_TEX_WIDTH * 4 * dashRows.length);
      for (let r = 0; r < dashRows.length; r++)
        total.set(dashRows[r], r * DASH_TEX_WIDTH * 4);
      dashesB = new Uint8Array(total.buffer);
    }
  }

  // Meta blob is built AFTER dashId is assigned on stroke ctx.metas above.
  const metaHdr = new ArrayBuffer(32);
  const mdv = new DataView(metaHdr);
  mdv.setUint32(0, ctx.metas.length, true);
  mdv.setFloat32(4, minX, true); mdv.setFloat32(8, minY, true);
  mdv.setFloat32(12, gw, true); mdv.setFloat32(16, gh, true);
  // metaBytes is sized here but its body is packed AFTER atlasSlots are
  // back-filled (see the second pack below). Packing the body now would be
  // dead work — it's never read before the re-pack overwrites it — so we
  // only allocate at the final size (header + n records of META_FLOATS_V3
  // float32s) and defer the single real pack.
  const metaBodyBytes = ctx.metas.length * META_FLOATS_V3 * 4;
  const metaBytes = new Uint8Array(metaHdr.byteLength + metaBodyBytes);

  // Stroke-mesh bytes.
  const strokeMeshB = new Uint8Array(new Float32Array(ctx.strokeMeshFloats).buffer);

  // clips/masks flow through the same meta-row + in-frag sampling
  // path as visible shapes (one walker, one emit). There is no
  // separate-FBO mesh-chunk path; emit empty arrays so the
  // bundle layout stays the same.
  const clipMeshB = new Uint8Array(0);
  const maskMeshB = new Uint8Array(0);

  const { filtersB, filterGraphsArr, kernelTab } = buildFilterSections(ctx.filtersUsed);
  // Image atlas: vertically stack the per-<image> RGBA8 buffers into one
  // 2D texture. Atlas width = max image width (clamped to opts.imageAtlasMaxWidth,
  // default 4096 = universal-safe across WebGL 2 spec min of 2048 and
  // virtually every GPU in production; callers can bump it for desktop-only
  // builds where they've confirmed the target's max-texture-size).
  // Per-image y-offset chosen by running sum. Pad with zeros where
  // row-width < atlas-width. Each image's atlasSlot meta is back-filled here.
  const maxAtlasWidth = Math.max(
    Number.isFinite(opts.imageAtlasMaxWidth) ? opts.imageAtlasMaxWidth : 4096,
    16);
  for (const im of ctx.imagesUsed) {
    if (im.w > maxAtlasWidth) {
      const scaled = downscaleRgba8(im.rgba, im.w, im.h, maxAtlasWidth);
      im.rgba = scaled.rgba;
      im.w = scaled.w;
      im.h = scaled.h;
    }
  }
  let atlasW = 0;
  for (const im of ctx.imagesUsed) atlasW = Math.max(atlasW, im.w);
  atlasW = Math.min(atlasW, maxAtlasWidth);
  let atlasH = 0;
  const atlasYs = [];
  for (const im of ctx.imagesUsed) {
    atlasYs.push(atlasH);
    atlasH += im.h;
  }
  let imageAtlasB = new Uint8Array(0);
  if (ctx.imagesUsed.length && atlasW > 0 && atlasH > 0) {
    const buf = new Uint8Array(atlasW * atlasH * 4);
    for (let i = 0; i < ctx.imagesUsed.length; i++) {
      const im = ctx.imagesUsed[i];
      const y0 = atlasYs[i];
      const stride = atlasW * 4;
      const srcStride = im.w * 4;
      for (let row = 0; row < im.h; row++) {
        buf.set(im.rgba.subarray(row * srcStride, row * srcStride + srcStride),
                (y0 + row) * stride);
      }
    }
    imageAtlasB = buf;
  }
  // Back-fill atlasSlot on every meta with imageId > 0. The 4th
  // component carries two pieces of info:
  //   bits 0..1 = kind (0 = image / clamp, 1 = pattern / wrap-tile)
  //   bit 2     = pixelated sampling (image-rendering: pixelated /
  //               crisp-edges → nearest-neighbor texel lookup in
  //               the fill fragment shader; bit cleared = LINEAR).
  // The shader reads kind via `(w & 3)` and pixelated via `(w & 4)`.
  for (const m of ctx.metas) {
    // Texels 9/10 are driven by the FILL image, or — when there's no fill image —
    // by the bitmap STROKE image (strokeImageId), which the stroke-paint branch
    // samples with those same texels. A fill image always wins; an independent
    // fill-image AND stroke-image would need an extra texel.
    const texImgId = m.imageId || (m.strokeImageId | 0);
    if (!texImgId) continue;
    const idx = texImgId - 1;
    const im = ctx.imagesUsed[idx];
    const wrapFlag = im.isPattern ? 1 : 0;
    const pxFlag = (m.pixelated ? 4 : 0);
    m.atlasSlot = [atlasYs[idx], im.w, im.h, wrapFlag | pxFlag];
    // No fill <image> rect to map against → map the stroke bitmap over the
    // shape's bbox (clamp), so the stroke samples the image across the silhouette.
    if (!m.imageId && (!m.imageRect || m.imageRect[2] <= 0) && m.bbox) {
      m.imageRect = [m.bbox[0], m.bbox[1], m.bbox[2] - m.bbox[0], m.bbox[3] - m.bbox[1]];
    }
    // For patterns, override imageRect's tile dims with the pattern's em
    // size so the cover shader tiles correctly across the shape.
    if (im.isPattern && im.emW && im.emH) {
      const bbX = m.imageRect[0], bbY = m.imageRect[1];
      m.imageRect = [bbX, bbY, im.emW, im.emH];
    }
  }
  // Pack metaBody now that atlasSlots are filled (single pack; nothing
  // reads metaBody before this point). Occupancy descriptors were stamped into
  // texel 5 .xy during the curve-buffer append pass above.
  const metaBody2 = packMetaBody(ctx.metas);
  // Fill metaBytes: header then body.
  metaBytes.set(new Uint8Array(metaHdr), 0);
  metaBytes.set(metaBody2, metaHdr.byteLength);

  // (Silhouette is now baked as a synthetic stroke shape in the
  // ctx.shapesData preprocessing loop above, so the mesh-emission
  // pipeline picks it up like any other stroke. No additional
  // post-emission work needed here.)

  // Return the bundle struct (typed-array section views) directly.
  // The runtime consumes the bundle struct directly, verbatim.
  return {
    version: 3,
    numShapes: ctx.metas.length,
    flags,
    globalBBox: [minX, minY, gw, gh],
    viewBox: [vbMinX, vbMinY, vbW, vbH],
    preserveAspectRatio: [parAx, parAy, parMs],
    curves: curvesB.buffer.slice(curvesB.byteOffset, curvesB.byteOffset + curvesB.byteLength),
    bands: bandsB.buffer.slice(bandsB.byteOffset, bandsB.byteOffset + bandsB.byteLength),
    meta: metaBytes.buffer.slice(metaBytes.byteOffset, metaBytes.byteOffset + metaBytes.byteLength),
    solid: solidB.buffer.slice(solidB.byteOffset, solidB.byteOffset + solidB.byteLength),
    curveGeom: cgeomB.buffer.slice(cgeomB.byteOffset, cgeomB.byteOffset + cgeomB.byteLength),
    gradients:    gradientsB.length   ? gradientsB.buffer.slice(gradientsB.byteOffset, gradientsB.byteOffset + gradientsB.byteLength)     : null,
    gradientStops: stopsB.length      ? stopsB.buffer.slice(stopsB.byteOffset, stopsB.byteOffset + stopsB.byteLength)                     : null,
    gradientStopsCount,
    dashes:       dashesB.length      ? dashesB.buffer.slice(dashesB.byteOffset, dashesB.byteOffset + dashesB.byteLength)                 : null,
    strokeMesh:   strokeMeshB.length  ? strokeMeshB.buffer.slice(strokeMeshB.byteOffset, strokeMeshB.byteOffset + strokeMeshB.byteLength) : null,
    clipMesh:     clipMeshB.length    ? clipMeshB.buffer.slice(clipMeshB.byteOffset, clipMeshB.byteOffset + clipMeshB.byteLength)         : null,
    maskMesh:     maskMeshB.length    ? maskMeshB.buffer.slice(maskMeshB.byteOffset, maskMeshB.byteOffset + maskMeshB.byteLength)         : null,
    filterTab:    filtersB.length     ? filtersB.buffer.slice(filtersB.byteOffset, filtersB.byteOffset + filtersB.byteLength)             : null,
    // CPU-only graph table parallel to filterTab. Entry N corresponds
    // to filterId N+1; null entries fall through to the kind path.
    filterGraphs: filterGraphsArr.some(g => g) ? filterGraphsArr : null,
    kernelTab:    kernelTab || null,
    imageAtlas:   imageAtlasB.length  ? imageAtlasB.buffer.slice(imageAtlasB.byteOffset, imageAtlasB.byteOffset + imageAtlasB.byteLength) : null,
    imageAtlasDim: (atlasW && atlasH) ? [atlasW, atlasH] : null,
    // Per-imageId atlas-slot rectangles. Indexed as
    // imageAtlasRects[imageId - 1] = [atlasY, w, h] in pixels. feImage
    // dispatch + hit-test use this to look up a slot without
    // having to walk meta texels. Null when no images.
    imageAtlasRects: ctx.imagesUsed.length
      ? ctx.imagesUsed.map((im, i) => [atlasYs[i], im.w, im.h])
      : null,
    metaFloatsPerShape: 48,  // v3 layout
    // Interior-skip occupancy: true when any fill row baked an interior grid
    // (opt-in opts.occupancyGrid). The bits live in the curve buffer; per-shape
    // (baseTexelIdx, G) ride in meta texel 5 .xy. The renderer gates the fill
    // shader's occupancy branch on this so the default path pays nothing, and
    // since the skip is output-identical, a runtime without it (C#) renders the
    // same pixels — no parity impact.
    hasOccupancy: anyOccupancy,
    extFlags: 0,
    // Per-meta-row string ids. Per-shape overrides address
    // shapes by this string. Length === numShapes (one entry per meta row).
    //
    // SVG bundles fill ids via `ctx.metas[i].shapeId` (stamped at each
    // emit site from the originating element's `id=` attribute, or a
    // synthetic `shape_N_fill` / `shape_N_stroke` when the element had
    // no id). Text bundles (via textRun.js → emitShape in buildContext)
    // push into `ctx.shapeIds` directly with their own synthesized ids;
    // those are taken positionally and the meta-row form fills in for
    // any unset slot.
    shapeIds: ctx.metas.map((m, i) =>
      (ctx.shapeIds[i] != null && ctx.shapeIds[i] !== '')
        ? ctx.shapeIds[i]
        : (m.shapeId || '')),
    // Per-meta-row renderable-leaf ordinal of the row's SOURCE element in
    // document order (the space the native fallback's positional DOM walk
    // addresses; see leafOrdinalByEl in importWalk), or -1 when the row has
    // no addressable element (<use> expansion, pattern/clip/mask layer
    // rows). Meta rows OUTNUMBER DOM elements whenever a shape emits both a
    // fill and a stroke row, so positional consumers must map through this
    // instead of treating a row index as "the N-th element". null when NO
    // row maps (text bundles / synthesized sections, where rows and
    // elements align 1:1 by construction → consumers fall back to identity).
    shapeDomIndex: (function() {
      const out = new Array(ctx.metas.length).fill(-1);
      let any = false;
      // Ordinals must be in EXPANDED-leaf space: the retained svgSource
      // replaces each <text> (ONE source leaf, N shapes) with a <g> of N
      // real <path>s, so glyph k of a <text> at original ordinal d lives at
      // expanded ordinal d+shift+k, and every leaf AFTER an expanded <text>
      // shifts by (N-1). Without this every glyph override lands on the
      // FIRST glyph's element (last-write-wins: the first letter vanishes
      // under a duplicate of the last).
      const expCount9 = new Map();
      for (let si = 0; si < ctx.shapesData.length; si++) {
        const sd9 = ctx.shapesData[si];
        if (sd9._domLeafGlyphK != null && sd9._domLeaf != null && sd9._domLeaf >= 0) {
          const c9 = expCount9.get(sd9._domLeaf) || 0;
          if (sd9._domLeafGlyphK + 1 > c9) expCount9.set(sd9._domLeaf, sd9._domLeafGlyphK + 1);
        }
      }
      const shiftFor9 = (dl) => {
        let sh9 = 0;
        for (const [d9, c9] of expCount9) if (d9 < dl) sh9 += c9 - 1;
        return sh9;
      };
      for (let si = 0; si < ctx.shapesData.length; si++) {
        const sd9 = ctx.shapesData[si];
        const dl = sd9._domLeaf;
        if (dl == null || dl < 0) continue;
        const f = shapeToFirstMeta[si], l = shapeToLastMeta[si];
        if (f < 0 || l < 0) continue;
        const dl9 = dl + shiftFor9(dl) + (sd9._domLeafGlyphK != null ? sd9._domLeafGlyphK : 0);
        for (let r = f; r <= l; r++) out[r] = dl9;
        any = true;
      }
      return any ? out : null;
    })(),
    // Animatable-clipper API: { clipSvgId: [firstMetaRow, lastMetaRow] }
    // — 0-based meta-row range of each clip's layer rows. The override
    // table's setClipper(svgId, opts) writes the 2D affine to every
    // layer row in the range so multi-shape clips transform as one
    // unit. Empty when the SVG had no <clipPath> elements (or none
    // were referenced).
    clipperRows: (function() {
      const out = {};
      const clipIds = ctx.clipSvgIds || [];
      for (let ci = 0; ci < ctx.clipsUsed.length; ci++) {
        const svgId = clipIds[ci];
        const first = clipMetaRow[ci] || 0;
        const last  = clipMetaLastRow[ci] || first;
        if (!svgId || first <= 0) continue;
        // Multiple ctx.clipsUsed entries can share the same svgId for
        // objectBoundingBox clips (one per referencing shape). Record
        // the FIRST occurrence's range; downstream consumers can scan
        // for additional entries via shapeIds if needed.
        if (svgId in out) continue;
        out[svgId] = [first - 1, last - 1];
      }
      // Masks share the same map (svgIds are unique across clips + masks).
      // This lets setClipper(maskId) animate a mask's transform AND lets the
      // native fallback route a morph's per-frame mask GEOMETRY to the
      // <mask>'s child <path>(s) by row range — the reveal-wipe fix.
      const maskIds = ctx.maskSvgIds || [];
      for (let mi = 0; mi < ctx.masksUsed.length; mi++) {
        const svgId = maskIds[mi];
        const first = maskMetaRow[mi] || 0;
        const last  = maskMetaLastRow[mi] || first;
        if (!svgId || first <= 0 || svgId in out) continue;
        out[svgId] = [first - 1, last - 1];
      }
      return out;
    })(),
    // Sprite-sheet addressing: { spriteId: [firstMetaRow, lastMetaRow] }
    // (0-based, inclusive) for each top-level <g id> / lone id'd top-level
    // shape. Drives renderer.drawSprite(bundle, id, opts) — a subset draw of
    // just that range. Empty when the
    // SVG had no id'd top-level elements. See spriteRangesNonContiguous.
    spriteRanges: spriteRangesObj,
    // Sprite ids whose meta-row span has foreign rows interleaved (a vector
    // pattern or clip child landed mid-span), so [first,last] is NOT a clean
    // subset. drawSprite warns for these; for clean Illustrator artboard
    // exports (flat groups, no patterns) this is always empty.
    spriteRangesNonContiguous,
    // Per-meta-row { begin, end } slices into curveFloats (float
    // units). Built from the `_curveStartF` field stamped on each
    // meta record at emit time. Each row's `end` is the next row's
    // `begin`; the last row extends to curveFloats.length. Consumed
    // by createShapeMorph to pair matched src/dst curves correctly.
    // These are explicit curveBuf offsets; meta texel 4 (glyphLoc) is a
    // BAND-buffer index, NOT a curveBuf offset.
    curveRangesByShape: (function() {
      const total = ctx.curveBuf.count * 4;
      const out = new Array(ctx.metas.length);
      for (let i = 0; i < ctx.metas.length; i++) {
        const begin = ctx.metas[i]._curveStartF | 0;
        out[i] = { begin, end: 0 };
      }
      for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].begin;
      if (out.length > 0) out[out.length - 1].end = total;
      return out;
    })(),
    // Per-meta-row <a href> values: when a shape lives inside an
    // <a href="..."> ancestor, every meta row it produces carries
    // the href so the hit-test consumer can map a hit back to a link
    // target. Empty string = not in an anchor. Length === numShapes.
    // Built by fanning the staged shape's anchorHref across its
    // shapeToFirstMeta..shapeToLastMeta range; shapes that didn't
    // emit any meta row (rare degeneracy) contribute nothing.
    shapeHrefs: (function() {
      const out = new Array(ctx.metas.length).fill('');
      for (let si = 0; si < ctx.shapesData.length; si++) {
        const sd = ctx.shapesData[si];
        if (!sd.anchorHref) continue;
        const f = shapeToFirstMeta[si];
        const l = shapeToLastMeta[si];
        if (f < 0) continue;
        for (let r = f; r <= l && r < out.length; r++) out[r] = sd.anchorHref;
      }
      return out;
    })(),
  };
}
