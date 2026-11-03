// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleFinalize.js — SVG import stage 2: BUNDLE ASSEMBLY. The walk
// (importWalk.js) has decoded every element into ctx.shapesData; this module
// turns that into the bundle struct: cover quads + meta shells, band-packed
// curve/band buffers, occupancy grid, sprite ranges, clip/mask/pattern meta
// rows, gradient/dash/filter/image tables, and the final section views.
// importer.js orchestrates (parse → walk → finalizeBundle) and re-exports.
import { svgElementName, elementChildren, switchChildMatches, resolveIdRef } from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseLength, parseLengthOr } from './length.js';
import { parsePatternDef } from './pattern.js';
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  CAP_BUTT,
  CAP_ROUND,
  CAP_SQUARE,
  JOIN_MITER,
  JOIN_ROUND,
  JOIN_BEVEL,
  JOIN_ARCS,
  CAP_ENUM,
  JOIN_ENUM,
  mkLine,
  mkQuad,
  mkCubic,
  mkArc,
  segStartEnd,
  segStart,
  segEnd,
  segsToPathD,
  pointsMeet,
  jointMag,
  arcEndpointToCenter,
  arcToNative,
  arcToCubics,
} from './segment.js';
import { tokenizePath, parsePathD } from './path.js';
import {
  IDENT,
  matMul,
  matApply,
  parseTransform,
  transformSegInto,
  transformArcNative,
} from './transform.js';
import { parseShape } from './shape.js';
import { CSS_NAMED_COLORS, hslToRgb, parseColor, setColorCompat } from './color.js';
import {
  parseStyleString,
  getParsedStyle,
  getStyleProp,
  getInheritedStyleProp,
  resolveCurrentColor,
  getShapeStyles,
  isDisplayed,
  isPaintable,
  isEffectivelyVisible,
  getCapsJoins,
  getFillRule,
  getClipRule,
} from './style.js';
import {
  buildStylesheet,
  buildStylesheetAsync,
  setActiveStylesheet,
  clearActiveStylesheet,
} from './stylesheet.js';
import {
  GRAD_LINEAR,
  GRAD_RADIAL,
  GRAD_PAD,
  GRAD_REFLECT,
  GRAD_REPEAT,
  GRAD_SPREAD_ENUM,
  GRAD_UNITS_USER,
  GRAD_UNITS_BBOX,
  GRADIENT_FLOATS,
  parseGradientStops,
  parseGradients,
  packGradientStops,
  buildGradientTables,
} from './gradient.js';
import { parseFilters } from './filter.js';
import { instantiateMarker, parseMarkers } from './marker.js';
import { parseClipsAndMasks, maskRegionOf } from './clipMask.js';
import {
  segCtrlBbox,
  segCtrlBboxInto,
  segBbox,
  segBboxInto,
  arcTightBbox,
  curveTightBboxQuad,
  curveTightBboxQuadInto,
  curveTightBboxCubic,
  curveTightBboxCubicInto,
  pathBbox,
  splitSubpathsWithCloseInto,
  polygonSignedArea,
} from './bbox.js';
import { getCoverQuadMesh } from './mesh.js';
import {
  makeTexelBuffer,
  texelEnsure,
  texelAppend,
  texelSet,
  texelXYOf,
  texelToBytes,
  segArcLen,
  encodeSeg,
  segTangentAt,
  segTangentAtInto,
  buildPathArcLengthLut,
  samplePathAt,
  buildTexturesShape,
} from './textures.js';
import { packMetaBody } from './meta.js';
import { buildOccupancyGrid } from './occupancy.js';
import { normalizedFillSegs } from './fillNormalize.js';
import { decodeImageHref, preloadImages, downscaleRgba8 } from './image.js';
import { makeBuildContext, pickBandsXY, emitShape } from './buildContext.js';
import { unionContours } from './pathBoolean/union.js';
import { runImportWalk } from './importWalk.js';
import { buildFilterSections } from './importFilters.js';
import { resolveObbGraph } from './filterUnits.js';
import { prepareFilterOwnerGradients } from './filterOwnerPaint.js';
import { strokeReachFactor, MAX_MITER_RATIO } from '../bundle/strokeReach.js';
import { droppedReportOf, warnDropped } from './dropped.js';
import {
  HIT_FILL,
  HIT_STROKE,
  HIT_BBOX,
  HIT_HIDDEN,
  hitOnlyNeeds,
  keepInvisibleOf,
} from './hitBits.js';
import { createGroupTree, treeIndexOf } from './hitGroups.js';
import { buildStrokeStrip } from './strokeStrip.js';
import { strokeInkPoints, growByInkPoints } from './strokeInk.js';
import { shapeToPath, boxKindOf } from './basicShape.js';
import { strokeBoxOf } from './strokeBox.js';

const STRIP_DEFAULT_TOL_DIAG = 0.004;
/// The id of a row whose element has none. A shape element (not text, a marker or a <use> instance) is named by its document ordinal, which is the
/// same in every pose of the same art whatever the pose drew: numbering by ROW would make a pose that dropped a row (a fill of `none`, a
/// hidden leaf) shift every later name, and a morph would pair a shape's fill with another shape's. Anything else is named by its row.
const synthId = (sd, row, kind) =>
  sd._stableLeaf >= 0 ? `shape_L${sd._stableLeaf}_${kind}` : `shape_${row}_${kind}`;
/// Whether the shape emits a stroke row: a positive width and a stroke that paints, or that is kept at alpha 0 (importWalk.js enqueueShape
/// stamps `_keepStroke` on a stroke whose alpha is 0, so a morph, an override or a hit test finds it).
const strokeRowOf = (sd) =>
  sd.sw > 0 && !!sd.strokeRgba && (sd.strokeRgba[3] > 0 || sd._keepStroke === true);
/// What the pointer answers for a row of `sd` at `mask` (HIT_FILL | HIT_BBOX for a fill row, HIT_STROKE for a stroke row). A row kept hidden
/// carries the bits it has once revealed, with HIT_HIDDEN set: the hit test lets it answer only while an override reveals it.
const hitBitsOfRow = (sd, mask) => {
  if (!sd._hidden) return (sd.hitBits | 0) & mask;
  const b = ((sd.hitBitsShown !== undefined ? sd.hitBitsShown : sd.hitBits) | 0) & mask;
  return b ? b | HIT_HIDDEN : 0;
};
import {
  FS_FILL_HUELESS,
  FS_KEPT_INVISIBLE,
  FS_HIDDEN,
  FS_STROKE_LOCAL,
  FS_DASH_SEAM,
  FS_GROUP_BEGIN,
  FS_GROUP_END,
  stampMetaHeader,
} from '../bundle/layout.js';

// Bundle-level flag bits (consumers may peek bundle.flags).
/// What a ZERO-LENGTH subpath of this stroke paints (SVG 1.1 11.4), for buildTexturesShape: its cap, the half width, and the
/// direction of the USER-space x axis in document space, the image of (1, 0) under the shape's CTM (a square cap is
/// axis-aligned in user space, so it turns with the element's transform; a stroke-space row maps it back by its frame).
///
/// `tangent` (the default, compat 'spec') orients a zero-length subpath's square cap along the path's direction there, as SVG 2
/// "Path implementation notes" (zero-length path segments) has it: the end direction of the closest preceding segment with length, else
/// the start direction of the closest following one, else (the whole path has no length) the positive x axis. Chrome and Skia draw it
/// axis-aligned whatever the path does: compat 'chrome' leaves `tangent` off and the square follows (ux, uy) alone.
function zeroLengthStroke(sd, tangent) {
  const m = sd._obbCtm;
  let ux = 1,
    uy = 0;
  if (m && Number.isFinite(m[0]) && Number.isFinite(m[1])) {
    const l = Math.hypot(m[0], m[1]);
    if (l > 0) {
      ux = m[0] / l;
      uy = m[1] / l;
    }
  }
  return { cap: sd.capStyle | 0, halfW: sd.sw * 0.5, ux, uy, tangent: tangent === true };
}

/// What a CLOSED contour of this stroke does at its start/end seam, for buildTexturesShape's dashSeam: false for a stroke without a dash pattern of positive
/// length; 'free' (the default, SVG 2 13.5.7: the dashes are laid along each subpath from its start to its end, each with its own caps, and a join is added only
/// between segments INSIDE a dash, so the seam is two dash ends); 'merge' under compat: 'chrome' (Chrome/Skia continue a dash that is on at both ends of a closed
/// contour through the seam, with a join: the encoder then carries the contour's length, FS_DASH_SEAM).
function dashedStroke(sd) {
  if (!(sd.dashArray && sd.dashArray.length && sd.dashArray.reduce((a, b) => a + b, 0) > 0))
    return false;
  return sd.dashSeamChrome ? 'merge' : 'free';
}

export const BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM = 1;
export const BUNDLE_FLAG_HYBRID_MESH_CHUNKED = 2;
export const BUNDLE_FLAG_WIDE_BAND_HEADERS = 4;
// Each H band lists two adjacent stripes; the AAC walker must step b += 2.
export const BUNDLE_FLAG_PAIR_BANDS = 8;
// No V bands: AAC never reads them, but Slug's vertical ray then degenerates to an
// O(segments-in-shape) walk. The
// draw-time engine selector must never route such a bundle to Slug.
export const BUNDLE_FLAG_NO_VBANDS = 16;
export const TEXTURE_WIDTH = 4096;
export const META_FLOATS_V3 = 48; // 12 texels: 9 + image em-rect + atlas slot + primitive fast-path
export const COVER_QUAD_STRIDE = 12;

/// The box of a stroke row's INK when it reaches past the row's bbox (path +- halfW): miter and miter-clip tips and a square cap's
/// corners (svg/strokeInk.js). null when it does not. A stroke drawn in STROKE SPACE (strokeFrame, bundle/strokeFrame.js) is an
/// ordinary stroke of the local path there: its tips are found in that space and come back through the frame.
function strokeInkBBox(sd, bboxMeta) {
  const reach = strokeReachFactor(
    sd.joinStyle,
    sd.miterLimit,
    sd.capStyle,
    sd.endCapStyle ?? sd.capStyle,
  );
  if (!(reach > 1)) return null;
  const halfW = sd.sw * 0.5;
  const g = growByInkPoints(
    bboxMeta,
    strokeInkPoints(sd.segs, {
      halfW,
      joinStyle: sd.joinStyle,
      miterLimit: sd.miterLimit,
      capStyle: sd.capStyle,
      endCapStyle: sd.endCapStyle ?? sd.capStyle,
      dashed: !!(sd.dashArray && sd.dashArray.length),
      N: sd.strokeFrame || null,
    }),
  );
  return g === bboxMeta ? null : g;
}

// A fill's implicit closing edge is not stroked for an open SVG subpath. The
// no-AA route therefore requires every geometric subpath to return to its
// start; exact Z provenance is no longer available after path parsing.
/// The stored miter limit is the ratio the shape actually turns, clamped to the declared ceiling
/// (buildTexturesShape.maxMiterRatio; the rationale lives there). The shader reads this one value
/// twice -- as its search radius (_reach = halfW * miterLimit) and as the per-join test
/// (miterLen <= halfW * miterLimit) -- and both stay correct: every join at or under the max still
/// miters, every join above the DECLARED limit still fails the test, and by construction none sits
/// between. So no wire-format change, and the radius collapses to what the geometry uses.
///
/// What a join that fails the test DRAWS depends on the segments, not on this value: between two
/// LINE segments it is a bevel, as SVG 2 specifies (_coverage.glsl strokeBandAccum); where a curve
/// takes part it is still ROUND, because _strokeMath.glsl's miter branch falls back to the
/// closest-point distance there instead of the bevel chord.
///
/// The margin absorbs the encoder computing this in double while the shader recomputes in float.
/// It has to be generous, not tight: on a ring every join has the same ratio by symmetry, so all
/// of them sit on the boundary at once. Erring wide only lets more joins miter, which the declared
/// limit already allowed.
function metaMiterLimit(sd, sm) {
  // Capped at the largest ratio a join can have (bundle/strokeReach.js): the shader's search radius is halfW * this value,
  // and an authored 1e16 (or a float32 overflow) made it reach past the plane for the join styles that keep the ceiling.
  let L = Math.min(Math.max(1, sd.miterLimit || 4), MAX_MITER_RATIO);
  if (sd.joinStyle !== 0) return L; // arcs / miter-clip keep the ceiling
  const r = sm && sm.maxMiterRatio;
  // SVG keeps the miter when the corner's ratio EQUALS the limit. The walk compares the two in float32, which tips an exact
  // equality (sqrt(2) at 90 degrees) to a bevel until the limit is 6e-8 relative higher. A limit within 2^-21 of the
  // sharpest corner's ratio is the equality (float32 noise, never a distinct authored value), so it is stored that much higher.
  if (r > 0 && Number.isFinite(r) && Math.abs(r - L) <= L * 2 ** -21)
    L = Math.max(L, r) * (1 + 2 ** -21);
  return r > 0 && Number.isFinite(r) ? Math.min(L, r * 1.02 + 1e-3) : L;
}

function hasClosedSubpaths(segs) {
  if (!segs || !segs.length) return false;
  let first = segStart(segs[0]),
    firstMag = jointMag(segs[0]),
    prev = segEnd(segs[0]),
    prevMag = jointMag(segs[0]);
  for (let i = 1; i < segs.length; i++) {
    const start = segStart(segs[i]),
      mag = jointMag(segs[i]);
    if (!pointsMeet(prev, start, prevMag, mag)) {
      if (!pointsMeet(prev, first, prevMag, firstMag)) return false;
      first = start;
      firstMag = mag;
    }
    prev = segEnd(segs[i]);
    prevMag = mag;
  }
  return pointsMeet(prev, first, prevMag, firstMag);
}

/// The ArrayBuffer behind a byte view, without copying when the view spans the whole buffer (every view passed here
/// is a freshly built one that nothing else holds). A byte-for-byte slice of such a view would be a full second copy of
/// the plane for the rest of the import, doubling the band, curve, meta and cover-quad planes at the peak.
function ownBuffer(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? u8.buffer
    : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export async function finalizeBundle(
  root,
  opts,
  defaultFill,
  defaultStroke,
  defaultStrokeW,
  preserveViewport,
  ctx,
  walk,
  walkCtx,
  append = {},
) {
  const { shapeBegin = 0, metaBegin = 0, clipBegin = 0, maskBegin = 0 } = append;
  // Build cover quads + meta shells: each shape can produce a fill
  // shell (accumGroupId > 0) and/or a stroke shell (accumGroupId = 0).
  // (`ctx.metas`, `ctx.curveBuf`, `ctx.bandBuf` are hoisted to the top of
  // importSvgInner so vector-pattern claim can use them during the walk.)
  // nextGid lives on ctx so multiple importSvg calls sharing one
  // ctx (e.g. textRun's SVG-in-OT fan-out) allocate distinct gids.
  // NOTE: pickBandsXY / pickBandsAxis intentionally live in buildContext.js and
  // are imported above — do not redefine them locally.

  // Perimeter-outline silhouette: opt-in via opts.computeSilhouette.
  // Runs the path-boolean union over every filled shape collected so
  // far, then injects the result as a synthetic STROKE-only shape at
  // the START of ctx.shapesData so it draws BEHIND all other shapes
  // (the canonical "outline shape" pattern). The stroke chunk then rides
  // the existing
  // chunk-emission pipeline below (mesh, curves, bands, meta) — no
  // separate codepath needed.
  //
  // opts.outlineColor (default white), opts.outlineWidth (default 4 em-units),
  // opts.outlineJoin / opts.outlineCap ('round' | 'miter' | 'bevel' | 'butt' |
  // 'square'; both default to ROUND).
  //
  // NOT usable on a MORPHING shape. The silhouette is baked per bundle, and
  // its structure — contour count, and segment count/type per contour —
  // depends on how the parts happen to overlap at that pose, so two keyframes
  // of the same animation generally disagree (a rotating train: 24 contours /
  // 202 segs at one heading, 28 / 211 at the next) and buildSplitStroke's
  // structure check rejects the pair. That is not a gap to close: the union is
  // a topology-changing, nonlinear function of the geometry, so the correct
  // silhouette at an in-between pose is NOT the interpolation of the endpoint
  // silhouettes, and no amount of structure-matching would make it one. For a
  // morphing shape, inflate each part instead (stroke every path outward by W
  // with round joins and paint the set behind the art) — dilation distributes
  // over union, so ⋃ dilate(Pᵢ,W) == dilate(⋃ Pᵢ, W) exactly, and it morphs
  // because it is the same path set.
  //
  // Per-instance recoloring
  // at draw time uses the existing OverrideTable mechanism (set
  // absolute stroke color on the synthetic shape's meta row via
  // bundle.shapeIds[0]). Width is baked in.
  // The path-tight bbox of a shape, cached BY THE SHAPE RECORD rather than by its index: the silhouette
  // injection below unshifts ctx.shapesData, so an index taken before it means something else after. The
  // shapeBbRaw pre-pass fills the same objects, so nothing computes a box twice.
  const _rawBbBySd = new WeakMap();
  const rawBbOf = (sd) => {
    if (sd?.groupBBox) return sd.groupBBox;
    if (!sd || !sd.segs || !sd.segs.length) return null;
    let b = _rawBbBySd.get(sd);
    if (b === undefined) {
      b = pathBbox(sd.segs);
      _rawBbBySd.set(sd, b);
    }
    return b;
  };
  // objectBoundingBox binding bbox for entry `i`: the REFERENCING
  // element's box (SVG 1.1 §14.3.5). When the attribute sat on a group
  // (instances[i] > 0, shared by every leaf claim under that group), the
  // box is the UNION of all shapes claiming the same instance — binding
  // each leaf to its own bbox visibly re-anchors the clip per shape.
  //
  // shapeBbRaw, NOT shapeBb: §7.11 defines the object bounding box on the
  // geometry, "without the stroke". shapeBb is the COVERAGE box (path +
  // halfW*miterLimit), which on a wide miter stroke is several times the
  // geometry — a `x=0.25 width=0.5` clip then spanned 174px where it should
  // span 75.
  // The shapes one claim stands for: the shape that made it, or every row of a text (importWalk.js setClaimBoxRows).
  const _claimRows = (bindings, j) => (bindings.rows && bindings.rows.get(j)) || [bindings[j]];
  const _bindingBb = (bindings, instances, i) => {
    const own = rawBbOf(ctx.shapesData[bindings[i]]);
    const inst = instances ? instances[i] | 0 : 0;
    let u = null;
    for (let j = 0; j < bindings.length; j++) {
      if (inst ? (instances[j] | 0) !== inst : j !== i) continue;
      for (const si of _claimRows(bindings, j)) {
        const sb = rawBbOf(ctx.shapesData[si]);
        if (!sb || !(sb[2] > sb[0] && sb[3] > sb[1])) continue;
        u = u
          ? [
              Math.min(u[0], sb[0]),
              Math.min(u[1], sb[1]),
              Math.max(u[2], sb[2]),
              Math.max(u[3], sb[3]),
            ]
          : sb.slice();
      }
    }
    return u || own;
  };
  // The supplemental matrix for an objectBoundingBox REFERENCE, in document space (where the fill shader samples
  // a clip row and the mask bake draws a mask row).

  // This used the DOCUMENT-SPACE axis-aligned box of the referencing shape and mapped [w 0 0 h x0 y0] straight
  // to document space, which is the product only when the carrier's linear part is a POSITIVE DIAGONAL. Under a
  // rotation or a skew the document-space AABB of a turned shape is bigger than the shape and stays
  // axis-aligned, so the clip would not turn with it; under a reflection the box is right but the unit square's
  // +x runs the wrong way, so an asymmetric clip would land mirrored. The positive-diagonal case keeps the
  // document-AABB arithmetic (an exact test, not a tolerance), which is exact there and moves no output by a rounding.
  const _obbUnitBox = (bb) =>
    bb && bb[2] > bb[0] && bb[3] > bb[1]
      ? [bb[2] - bb[0], 0, 0, bb[3] - bb[1], bb[0], bb[1]]
      : null;
  /// `refCtm` inverted, or null when it is missing or singular RELATIVE to its own terms -- the rule
  /// transformSegInto uses; an absolute floor is a uniform scale in disguise and reads every carrier under
  /// scale(2^-20) as degenerate.
  const _obbInv = (refCtm) => {
    if (!refCtm) return null;
    const [a, b, c, d, e, f] = refCtm;
    const det = a * d - b * c;
    if (!(Math.abs(det) > 1e-12 * (Math.abs(a * d) + Math.abs(b * c)))) return null;
    const inv = [d / det, -b / det, -c / det, a / det, 0, 0];
    inv[4] = -(inv[0] * e + inv[2] * f);
    inv[5] = -(inv[1] * e + inv[3] * f);
    return inv;
  };
  /// The union of `shapeIdxs`' boxes in the carrier's own user space, given that space's inverse.
  const _obbOwnBox = (shapeIdxs, refCtm, inv) => {
    let u = null;
    const scratch = [];
    for (const si of shapeIdxs) {
      const sd = ctx.shapesData[si];
      if (!sd || !sd.segs || !sd.segs.length) continue;
      // The carrier IS this shape (the same CTM array reached both the claim and the leaf): its box in its own
      // user space was taken before the transform and is exact. Otherwise the attribute sat on an ancestor, and
      // the box the spec wants is the tight one in THAT element's space — the geometry mapped back through it,
      // descendants' own transforms included, which is what unmapping the stored document-space segs gives.
      let bb;
      if (sd._obbCtm === refCtm && sd._obbBox) bb = sd._obbBox;
      else {
        scratch.length = 0;
        for (const sg of sd.segs) transformSegInto(sg, inv, scratch);
        bb = pathBbox(scratch);
      }
      if (!bb || !(bb[2] > bb[0] && bb[3] > bb[1])) continue;
      u = u
        ? [
            Math.min(u[0], bb[0]),
            Math.min(u[1], bb[1]),
            Math.max(u[2], bb[2]),
            Math.max(u[3], bb[3]),
          ]
        : bb.slice();
    }
    return u;
  };
  const _obbCtm = (bindings, instances, instCtm, i) => {
    const inst = instances ? instances[i] | 0 : 0;
    const refCtm = inst > 0 && instCtm ? instCtm.get(inst) : null;
    if (!refCtm || (refCtm[1] === 0 && refCtm[2] === 0 && refCtm[0] > 0 && refCtm[3] > 0)) {
      return _obbUnitBox(_bindingBb(bindings, instances, i));
    }
    const inv = _obbInv(refCtm);
    if (!inv) return _obbUnitBox(_bindingBb(bindings, instances, i));
    const idxs = [];
    for (let j = 0; j < bindings.length; j++)
      if ((instances[j] | 0) === inst) idxs.push(..._claimRows(bindings, j));
    const sup = _obbUnitBox(_obbOwnBox(idxs, refCtm, inv));
    return sup ? matMul(refCtm, sup) : null;
  };
  const _clipInstCtm = walkCtx && walkCtx.clipInstCtm;
  const _maskInstCtm = walkCtx && walkCtx.maskInstCtm;

  // THE MASK REGION (CSS Masking 1 §7.1): outside the <mask>'s x/y/width/height rect -- in maskUnits, the default
  // objectBoundingBox -10%/-10%/120%/120% of the REFERENCING element's box -- the mask is transparent black, so
  // nothing of the masked element shows. The drain ignored it: every mask reached as far as its content, and ink
  // outside the region drew (a marker, which is part of what the path paints but not of its box, crossed the
  // default region on every masked path; so does a wide stroke, and every stated region smaller than the content).
  //
  // The region is a rect in the carrier's box or user space, so in document space a parallelogram, and "the mask is
  // zero outside it" is exactly "the masked element is clipped to it". It becomes a clip of each masked shape whose
  // ink can leave it (applyMaskRegions below): a userSpaceOnUse clip def in DOCUMENT space, built as a <clipPath> the
  // drain walks like any other, so the fill shader, the mask bake and the hit test all read it as a clip. A shape
  // already clipped keeps its clip: the region def carries it as its nested clip (innerClipId), the shader's
  // depth-1 nested-clip AND. A shape whose clip ALREADY nests would need depth 2, which the shader does not evaluate,
  // so there the region cuts the MASK instead of the shape: the shape gets its own copy of the mask entry whose content
  // rows are each clipped to the region (a mask is zero outside its region, so a mask clipped to it is the same mask).
  // A content row that already has a clip of its own takes the region as the outer level of a depth-1 nest
  // (_regionClipFor); a row whose own clip nests as well cannot take it, and that is reported once by mantleWarn.
  //
  // A shape whose ink box (its geometry's, padded by its stroke's full reach) lies inside the region gets nothing:
  // the region cannot cut it, and every masked fill inside the default region -- the usual case -- keeps the clip-free
  // row it had.
  const _clipNests = (def) => {
    if (!def) return false;
    if ((def.innerClipId | 0) > 0) return true;
    const hasClip = (el) => {
      for (const k of elementChildren(el)) {
        const v = (k.getAttribute && (k.getAttribute('clip-path') || '')) || '';
        const st = (k.getAttribute && (k.getAttribute('style') || '')) || '';
        if ((v && v.trim() !== 'none') || /clip-path\s*:/.test(st)) return true;
        if (hasClip(k)) return true;
      }
      return false;
    };
    return !!(def.element && hasClip(def.element));
  };
  let maskRegionDocument;
  let maskRegionSkipWarned = false;
  const rowRegionClipMemo = new Map();
  /// The document-space clip entry (1-based index into ctx.clipsUsed) for a mask region's parallelogram `corners`,
  /// carrying `inner` (a claimed clip entry, or 0) as its nested clip. Memoized in `memo` per (instance, inner); undefined
  /// when no document can build it.
  const _regionClipFor = (maskEl, corners, inst, inner, memo) => {
    const key = `${inst}\0${inner}`;
    let id = memo.get(key);
    if (id !== undefined) return id;
    const owner = maskEl.ownerDocument;
    const doc = maskRegionDocument || (maskRegionDocument = owner && owner.cloneNode(false));
    if (!doc || !doc.createElementNS) return undefined;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const el = doc.createElementNS(SVGNS, 'clipPath');
    el.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const path = doc.createElementNS(SVGNS, 'path');
    // every digit of each coordinate (the shortest round trip), as the viewport clips write them
    path.setAttribute('d', `M${corners.map(([x, y]) => `${x} ${y}`).join(' L')} Z`);
    el.appendChild(path);
    const regionDef = {
      element: el,
      units: 'userSpaceOnUse',
      maskType: 'luminance',
      ctm: IDENT,
      placed: true,
    };
    if (inner > 0) regionDef.innerClipId = inner;
    ctx.clipsUsed.push(regionDef);
    ctx.clipBindings.push(-1);
    if (ctx.clipInstances) ctx.clipInstances.push(0);
    if (ctx.clipSvgIds) ctx.clipSvgIds.push('');
    id = ctx.clipsUsed.length;
    memo.set(key, id);
    return id;
  };
  const applyMaskRegions = (fromShapeIdx = 0) => {
    const byInst = new Map();
    for (let shapeIdx = fromShapeIdx; shapeIdx < ctx.shapesData.length; shapeIdx++) {
      const sd = ctx.shapesData[shapeIdx];
      if (!sd || !((sd.maskId | 0) > 0) || !((sd._maskInst | 0) > 0) || !sd.segs || !sd.segs.length)
        continue;
      const def = ctx.masksUsed[(sd.maskId | 0) - 1];
      if (!def || !def.region || !def.element) continue;
      const k = sd._maskInst | 0;
      if (!byInst.has(k)) byInst.set(k, { def, sds: [] });
      byInst.get(k).sds.push(sd);
    }
    const memo = new Map();
    for (const [inst, { def, sds }] of byInst) {
      const vp = def.viewport;
      const rg = vp ? maskRegionOf(def.element, [vp.parentWidth, vp.parentHeight]) : def.region;
      if (rg.w <= 0 || rg.h <= 0) {
        def.emptyRegion = true;
        continue;
      }
      if (!(rg.w > 0 && rg.h > 0)) continue;
      const refCtm = (_maskInstCtm && _maskInstCtm.get(inst)) || IDENT;
      // The region's unit (objectBoundingBox) or user (userSpaceOnUse) frame, mapped to document space.
      let M = refCtm;
      if (rg.oBB) {
        // The carrier's box: the union of its shapes' GEOMETRY, markers excluded (they paint, they are not geometry),
        // in the carrier's own user space -- _obbCtm's rule, applied to the shapes this instance masks.
        const own = sds.filter((sd) => !sd._marker);
        const idxs = [];
        for (const sd of own) {
          const i = ctx.shapesData.indexOf(sd);
          if (i >= 0) idxs.push(i);
        }
        let sup = null;
        if (refCtm[1] === 0 && refCtm[2] === 0 && refCtm[0] > 0 && refCtm[3] > 0) {
          let u = null;
          for (const sd of own) {
            const b = rawBbOf(sd);
            if (!b) continue;
            u = u
              ? [
                  Math.min(u[0], b[0]),
                  Math.min(u[1], b[1]),
                  Math.max(u[2], b[2]),
                  Math.max(u[3], b[3]),
                ]
              : b.slice();
          }
          sup = _obbUnitBox(u);
        } else {
          const inv = _obbInv(refCtm);
          const box = inv ? _obbOwnBox(idxs, refCtm, inv) : null;
          const ub = _obbUnitBox(box);
          sup = ub ? matMul(refCtm, ub) : null;
        }
        if (!sup) continue; // no box (a zero-area carrier): leave the shapes as they were
        M = sup;
      }
      const corners = [
        [rg.x, rg.y],
        [rg.x + rg.w, rg.y],
        [rg.x + rg.w, rg.y + rg.h],
        [rg.x, rg.y + rg.h],
      ].map(([x, y]) => matApply(M, x, y));
      // Inside the parallelogram: on the inner side of all four edges (either winding).
      const inside = (x, y) => {
        let pos = 0,
          neg = 0;
        for (let e = 0; e < 4; e++) {
          const [ax, ay] = corners[e],
            [bx, by] = corners[(e + 1) & 3];
          const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
          if (c > 0) pos++;
          else if (c < 0) neg++;
        }
        return pos === 0 || neg === 0;
      };
      for (const sd of sds) {
        // a group paints what its members do, strokes and markers included
        const b = sd._paintBBox || rawBbOf(sd);
        if (!b) continue;
        const pad =
          !sd._paintBBox && strokeRowOf(sd)
            ? sd.sw *
              0.5 *
              strokeReachFactor(
                sd.joinStyle,
                sd.miterLimit,
                sd.capStyle,
                sd.endCapStyle ?? sd.capStyle,
              )
            : 0;
        const x0 = b[0] - pad,
          y0 = b[1] - pad,
          x1 = b[2] + pad,
          y1 = b[3] + pad;
        if (inside(x0, y0) && inside(x1, y0) && inside(x1, y1) && inside(x0, y1)) continue;
        const C = sd.clipId | 0;
        if (C > 0 && _clipNests(ctx.clipsUsed[C - 1])) {
          const mkey = `${sd.maskId | 0}\0${inst}`;
          let cloneId = memo.get(mkey);
          if (cloneId === undefined) {
            const k = (sd.maskId | 0) - 1;
            ctx.masksUsed.push({ ...ctx.masksUsed[k], regionCorners: corners, regionInst: inst });
            ctx.maskBindings.push(ctx.maskBindings[k]);
            if (ctx.maskInstances) ctx.maskInstances.push(ctx.maskInstances[k]);
            if (ctx.maskSvgIds) ctx.maskSvgIds.push(ctx.maskSvgIds[k]);
            cloneId = ctx.masksUsed.length;
            memo.set(mkey, cloneId);
          }
          sd.maskId = cloneId;
          continue;
        }
        const id = _regionClipFor(def.element, corners, inst, C, memo);
        if (id === undefined) break;
        sd.clipId = id;
      }
    }
  };
  if (ctx.masksUsed && ctx.masksUsed.length) applyMaskRegions(shapeBegin);

  // The visible extent of a clipped or masked shape.
  //
  // The silhouette is the DRAWING'S VISIBLE PERIMETER -- an outline painted behind the art -- so a shape
  // contributes the part of it that is drawn, not the part of it that was authored. A union of every filled
  // shape at its full unclipped extent would let a shape entirely clipped away push the perimeter out to its
  // whole outline, and a half-clipped background push it to the background's corners.
  //
  // What that means exactly: a clipped shape contributes `shape ∩ clip`. unionPaths takes the clip's geometry as
  // an extra set of arrangement edges and tests each face against it, so the answer is the exact intersection,
  // not a bounding box (see its `shape.regions`). A <clipPath>'s children UNION (SVG 1.1 §14.3.5), so one clip
  // is one OR group, and a clip-of-clip wrapper adds another group that must also hold.
  //
  // A mask is not a geometric region: its effect is a luminance, so `shape ∩ maskContent` is an OUTER BOUND, not
  // the visible set. Outside all of a mask's content the mask is transparent black and the shape is fully
  // hidden, so intersecting with the content can never cut ink that is drawn; inside it, a black or dark region
  // is counted as visible when it is not. That is the safe direction for a perimeter, and it is what catches the
  // case the item names -- a shape whose mask does not reach it at all. The mask's own maskUnits rect is not
  // folded in: its default is -10%/120% of the shape's box, which is looser than the shape and cuts nothing.
  //
  // Where it declines. The def's geometry is read straight off its DOM here, because the clip/mask drain that
  // walks defs into shapesData runs hundreds of lines later and the silhouette has to be injected at index 0
  // before the emit loop renumbers anything. The reader handles shape elements and <g> wrappers (including the
  // <g clip-path> wrapper importWalk's combineClipRefs builds for a nested clip); a <use>, a <text>, an
  // objectBoundingBox outer clip on such a wrapper, or any other tag DECLINES the whole region and the shape
  // keeps its full extent, exactly as before. Declining never loses ink.
  const SIL_SHAPE_TAGS = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
  let _silDefs = null;
  const silDefs = () => _silDefs || (_silDefs = parseClipsAndMasks(root));
  /// Append the parts whose UNION is `element`'s content, placed by `ctm`, to `out`; a wrapper's own clip-path
  /// becomes a further AND group on `groups`. False when any child cannot be read here.
  // `rule`: which property a shape's winding rule comes from -- clip-rule in clip content, fill-rule in mask content.
  const silReadDef = (
    element,
    ctm,
    out,
    groups,
    depth,
    rule = 'fill',
    viewport = walkCtx.viewport,
  ) => {
    if (depth > 6) return false;
    const kids = elementChildren(element);
    for (let k = 0; k < kids.length; k++) {
      const el = kids[k];
      const tag = svgElementName(el);
      if (
        tag === 'defs' ||
        tag === 'title' ||
        tag === 'desc' ||
        tag === 'metadata' ||
        tag === 'style'
      )
        continue;
      if (!isDisplayed(el) || !isEffectivelyVisible(el)) continue;
      const m = matMul(
        ctm,
        parseTransform((el.getAttribute && el.getAttribute('transform')) || ''),
      );
      if (tag === 'g' || tag === 'a') {
        const ref = resolveIdRef(
          getStyleProp(el, 'clip-path', '') || el.getAttribute('clip-path') || '',
        );
        if (ref) {
          const def = (walkCtx.clipDefs && walkCtx.clipDefs[ref]) || silDefs().clipPaths[ref];
          // An objectBoundingBox outer clip is placed by the box of the element that REFERENCED it, which is
          // not this def's space and is not recoverable from here. Decline rather than place it wrong.
          if (!def || !def.element || def.units === 'objectBoundingBox') return false;
          // placeOwnClipMask gives the wrapper's own clip the same elCtm the wrapper's children get, so the
          // outer def's geometry is placed by `m` too.
          const grp = [];
          if (
            !silReadDef(
              def.element,
              matMul(def.ctm || m, parseTransform(def.element.getAttribute('transform') || '')),
              grp,
              groups,
              depth + 1,
              'clip',
              def.viewport || viewport,
            ) ||
            !grp.length
          )
            return false;
          groups.push(grp);
        }
        if (!silReadDef(el, m, out, groups, depth + 1, rule, viewport)) return false;
        continue;
      }
      if (SIL_SHAPE_TAGS.indexOf(tag) < 0) return false;
      let segs = parseShape(el, viewport);
      if (!segs || !segs.length) continue;
      if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) {
        const x = [];
        for (const sg of segs) transformSegInto(sg, m, x);
        segs = x;
      }
      // The rule the clip/mask DRAIN winds this shape by (clip-rule in clip content), so the
      // silhouette agrees with what is drawn.
      out.push({ segs, fillRule: rule === 'clip' ? getClipRule(el) : getFillRule(el) });
    }
    return true;
  };
  /// The AND groups restricting `sd`'s visible extent: null = unrestricted, false = could not be read (keep the
  /// full extent), [] = nothing of it is visible (drop it).
  const SIL_LAYERS = [
    () => [ctx.clipsUsed, ctx.clipBindings, ctx.clipInstances, _clipInstCtm],
    () => [ctx.masksUsed, ctx.maskBindings, ctx.maskInstances, _maskInstCtm],
  ];
  const silRegions = (sd) => {
    const groups = [];
    for (let L = 0; L < SIL_LAYERS.length; L++) {
      const id = (L === 0 ? sd.clipId : sd.maskId) | 0;
      if (!(id > 0)) continue;
      const [used, bindings, instances, instCtm] = SIL_LAYERS[L]();
      const def = used[id - 1];
      if (!def || !def.element) return false;
      if (def.emptyRegion) return [];
      let ctm = def.ctm || IDENT;
      if (bindings && bindings[id - 1] >= 0) {
        const obb = _obbCtm(bindings, instances, instCtm, id - 1);
        if (!obb) return false;
        ctm = obb;
      }
      const parts = [];
      if (
        !silReadDef(
          def.element,
          matMul(ctm, parseTransform(def.element.getAttribute('transform') || '')),
          parts,
          groups,
          0,
          L === 0 ? 'clip' : 'fill',
          def.units === 'objectBoundingBox'
            ? { parentWidth: 1, parentHeight: 1 }
            : def.viewport || walkCtx.viewport,
        )
      )
        return false;
      if (!parts.length) return []; // an EMPTY clip or mask hides the shape outright
      groups.push(parts);
    }
    return groups.length ? groups : null;
  };

  if (opts.computeSilhouette && !ctx._silhouetteInjected) {
    const filledShapes = [];
    let _silDeclined = 0;
    for (const sd of ctx.shapesData.slice(shapeBegin)) {
      if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') continue;
      if (!sd.segs || !sd.segs.length) continue;
      if (!sd.fillRgba || sd.fillRgba[3] === 0) continue;
      // The drawing's own shapes only. A pattern's children (isLayer) are walked in the PATTERN's
      // space and reach the page only through a carrier's inverse pattern matrix, tiled and clipped
      // to the carrier; their coordinates are not document coordinates and their union is not part
      // of the drawing's perimeter. Unioned as stored, a 10-unit tile child at the pattern origin
      // pulled the silhouette of a drawing that starts at (10, 10) out to (0, 0). The same rule the
      // occupancy grid's content extent applies a few lines below.
      if (sd.isLayer || sd._hidden) continue;
      const regions = silRegions(sd);
      if (regions && regions.length === 0) continue; // clipped away entirely: no perimeter of its own
      if (regions === false) _silDeclined++;
      filledShapes.push(
        regions
          ? { segs: sd.segs, fillRule: sd.fillRule || 'nonzero', regions }
          : { segs: sd.segs, fillRule: sd.fillRule || 'nonzero' },
      );
    }
    if (_silDeclined) {
      mantleWarn(
        `svgImporter: ${_silDeclined} clipped or masked shape(s) have a clip whose geometry this` +
          ' import cannot read (a <use>, <text> or objectBoundingBox nested clip); the silhouette takes them at' +
          ' their full extent.',
      );
    }
    if (filledShapes.length > 0) {
      // Contour-wise, so the degenerate zero-area slivers that abutting or
      // coincident input edges throw off get dropped: a thick stroke turns
      // each one into a visible lens. The pieces stay concatenated in one
      // segs list — the stroke and fill pipelines re-split on discontinuity,
      // so a multi-piece silhouette (a train and its caboose; an outline with
      // a hole) already works.

      const { intersectSegmentsExact } = await import('./pathBoolean/intersect/exact.js');
      setColorCompat(walkCtx ? walkCtx.compat : 'spec'); // (one slot, and other imports ran during that await: importWalk.js)
      const silSegs = unionContours(filledShapes, { intersect: intersectSegmentsExact }).flat();
      if (silSegs.length > 0) {
        const silColor = opts.outlineColor || [1, 1, 1, 1];
        const silWidth = opts.outlineWidth != null ? opts.outlineWidth : 4;
        // ROUND by default. A silhouette follows the art's corners, and at
        // outline widths (which are thick — that's the point) a MITER join
        // shoots a spike off every sharp one.
        const silJoin =
          opts.outlineJoin != null ? (JOIN_ENUM[opts.outlineJoin] ?? JOIN_ROUND) : JOIN_ROUND;
        const silCap =
          opts.outlineCap != null ? (CAP_ENUM[opts.outlineCap] ?? CAP_ROUND) : CAP_ROUND;
        // Synthetic stroke-only shape. Field set mirrors what a normal
        // <path stroke="..." stroke-width="..." fill="none"> would
        // produce after parsing.
        const silShape = {
          kind: 'path',
          segs: silSegs,
          fillRgba: [0, 0, 0, 0], // no fill
          fillNone: true,
          strokeRgba: silColor,
          sw: silWidth,
          fillRule: 'nonzero',
          capStyle: silCap,
          joinStyle: silJoin,
          miterLimit: 4,
          flagsShape: 0,
          shapeId: '__silhouette__',
          anchorHref: '',
        };
        ctx.shapesData.splice(shapeBegin, 0, silShape);
        ctx._silhouetteInjected = true;
        // THE SILHOUETTE TAKES INDEX 0, SO every INDEX THE WALK RECORDED MOVES UP ONE. Four slot
        // families address ctx.shapesData BY POSITION, all filled during the walk that just ended:
        // a vector pattern's (firstShapeIdx, lastShapeIdx) child span, and the referencing-shape
        // index of an objectBoundingBox clip, mask or filter claim. Unshifted, a carrier whose
        // children began at 0 sampled the SILHOUETTE row instead of its tile, and an
        // objectBoundingBox clip bound to the shape emitted before the one that referenced it
        // (a 40x40 rect's half-width clip came out over the pattern rect before it). Claims made
        // AFTER this point -- the clip/mask drain re-enters walk() below -- index the shifted list
        // already and must not be bumped, which is why this runs here and not at use.
        const _bumpIdx = (a) => {
          for (let i = 0; i < a.length; i++) if (a[i] >= shapeBegin) a[i] += 1;
        };
        _bumpIdx(ctx.clipBindings);
        _bumpIdx(ctx.maskBindings);
        _bumpIdx(ctx.filterBindings);
        for (const bindings of [ctx.clipBindings, ctx.maskBindings])
          if (bindings.rows) for (const list of bindings.rows.values()) _bumpIdx(list);
        if (ctx.filterInstShapes) for (const list of ctx.filterInstShapes.values()) _bumpIdx(list);
        for (const vp of ctx.vecPatternsUsed || []) {
          if (vp.firstShapeIdx >= shapeBegin) vp.firstShapeIdx += 1;
          if (vp.lastShapeIdx >= shapeBegin) vp.lastShapeIdx += 1;
        }
      }
    }
  }

  // Per-shape path-tight bbox cache — the main shape loop, the objectBoundingBox
  // binding below and emitMetaSuffix re-use it to skip redundant pathBbox walks
  // (a tight per-seg walk). Empty for group-flatten records
  // (sd.kind === 'groupBegin'/'groupEnd') and for segment-less shapes.
  //
  // There is no padded twin here. Every consumer that needs the stroke's
  // COVERAGE box builds it where it emits, from src/bundle/strokeReach.js, which
  // is the one bound for all five joins and all three caps.
  const shapeBbRaw = new Array(ctx.shapesData.length).fill(null);
  for (let i = 0; i < ctx.shapesData.length; i++) {
    const sd = ctx.shapesData[i];
    if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') continue;
    if (!sd.segs || !sd.segs.length) continue;
    shapeBbRaw[i] = rawBbOf(sd);
  }

  //
  // Both sides in document units. A pattern's children (isLayer) are walked in the pattern's own space and drawn
  // through the carrier's inverse pattern matrix, so their boxes are not document content: the union takes drawn
  // shapes only, and a pattern child's area is carried into document units by |det| of the matrices that place it.
  // Comparing both as stored would let the children's tile dominate the union under a scaled ancestor, so the
  // choice to build a grid would depend on the document's scale.
  let _dX0 = Infinity,
    _dY0 = Infinity,
    _dX1 = -Infinity,
    _dY1 = -Infinity;
  for (let i = 0; i < shapeBbRaw.length; i++) {
    const bb = shapeBbRaw[i];
    if (!bb || ctx.shapesData[i].isLayer) continue;
    if (bb[0] < _dX0) _dX0 = bb[0];
    if (bb[1] < _dY0) _dY0 = bb[1];
    if (bb[2] > _dX1) _dX1 = bb[2];
    if (bb[3] > _dY1) _dY1 = bb[3];
  }
  const _docArea = _dX1 > _dX0 && _dY1 > _dY0 ? (_dX1 - _dX0) * (_dY1 - _dY0) : 0;
  // Pattern space -> document area factor per vector pattern: the largest |det| of a carrier's pattern matrix (its
  // transform times patternTransform, the matrix bundleFinalize inverts for the shader), times the factor of the
  // pattern the carrier itself sits in. A carrier comes after its pattern's children, and an inner pattern's carrier
  // is a child of the outer pattern, so walking the shapes backward meets each outer carrier first.
  const _patAreaScale = new Array((ctx.vecPatternsUsed || []).length).fill(0);
  for (let i = ctx.shapesData.length - 1; i >= 0; i--) {
    const sd = ctx.shapesData[i],
      id = sd.vecPatternId | 0;
    if (id <= 0 || id > _patAreaScale.length) continue;
    const [pa, pb, pc, pd] = sd.patternMatrix || ctx.vecPatternsUsed[id - 1].patM || IDENT;
    const cm = sd.patternContent ? sd.patternContent.sx * sd.patternContent.sy : 1; // shared content: canonical units are 1/scale of tile units
    const own = sd._patternOwner > 0 ? _patAreaScale[sd._patternOwner - 1] : 1;
    _patAreaScale[id - 1] = Math.max(_patAreaScale[id - 1], Math.abs(pa * pd - pc * pb) * cm * own);
  }
  const _areaScaleOf = (sd) =>
    sd && sd._patternOwner > 0 ? _patAreaScale[sd._patternOwner - 1] : 1;
  // opts.occupancyGrid: undefined/true → ON (default); false → OFF; object →
  // ON with tuning ({grid, minInteriorFrac, minBboxAreaFrac}). minBboxAreaFrac
  // defaults to 2% of content area, excluding small shapes whose grids provide
  // little render benefit.
  const _occOpts =
    opts.occupancyGrid && typeof opts.occupancyGrid === 'object' ? opts.occupancyGrid : undefined;
  const _occOn = opts.occupancyGrid !== false;
  const _occMinAreaFrac =
    _occOpts && _occOpts.minBboxAreaFrac != null ? _occOpts.minBboxAreaFrac : 0.02;
  const _occAreaOk = (bb, sd) => {
    if (!_occOn || _docArea <= 0 || !bb) return false;
    const a = (bb[2] - bb[0]) * (bb[3] - bb[1]) * _areaScaleOf(sd);
    return a >= _occMinAreaFrac * _docArea;
  };
  // Default-on builds the grid ASYNC: import reserves a zeroed cell region + the
  // descriptor, and an idle pass fills it AFTER first draw. The grid is purely
  // additive (occSkip only ever turns a walk that would return 1.0 into one
  // fetch), so the first frame renders correct-but-unaccelerated and speeds up
  // once the bits land — no visible change, zero load stall. An explicit object
  // opt-in ({grid,…}) builds SYNC instead, so `sections.curves` carries the bits
  // immediately (predictable for tests and other non-GL consumers).
  const _occAsync = _occOn && !_occOpts;
  const _occG = (_occOpts && _occOpts.grid) || 24;

  // shape-index → (first, last) meta row this shape produced. The
  // visible-pattern stamp uses these to translate ctx.vecPatternsUsed[i]'s
  // recorded (firstShapeIdx, lastShapeIdx) into the contiguous meta-row
  // span for atlasSlot.xy.
  const shapeToFirstMeta = ctx._shapeToFirstMeta || (ctx._shapeToFirstMeta = []);
  const shapeToLastMeta = ctx._shapeToLastMeta || (ctx._shapeToLastMeta = []);
  while (shapeToFirstMeta.length < ctx.shapesData.length) shapeToFirstMeta.push(-1);
  while (shapeToLastMeta.length < ctx.shapesData.length) shapeToLastMeta.push(-1);

  // No-AA eligibility is bundle-wide because one fill program draws every row.
  // Restrict it to plain closed shapes whose later opaque stroke provably hides
  // the fill edge. Effects/layers and non-scaling strokes use separate geometry
  // or scale rules and stay on an AA engine.
  // ONE predicate, used twice: for the bundle-wide flag below and, per shape, for
  // the MIXED per-row engine bits. Two copies of this rule would be two chances to
  // let a fill drop its AA without a stroke actually covering it.
  const noAaCovered = (sd) =>
    sd.sw > 0 &&
    sd.strokeRgba &&
    sd.strokeRgba[3] >= 0.996 &&
    !sd.strokeGradId &&
    !sd.strokeImageId &&
    (!sd.dashArray || sd.dashArray.length === 0) &&
    !sd.strokeFirst &&
    !sd.isLayer &&
    !sd.clipId &&
    !sd.maskId &&
    !sd.filterId &&
    !sd.vecPatternId &&
    !sd.blendMode &&
    !sd.isolation &&
    ((sd.flagsShape || 0) & 1) === 0 &&
    hasClosedSubpaths(sd.segs);
  ctx._noAaCovered = noAaCovered;
  let _noAaAnyFill = false,
    _noAaAllCovered = true,
    _noAaMinSW = Infinity,
    _noAaCubicArc = false;
  for (const sd of ctx.shapesData) {
    const fillDrawn = !sd.fillNone && sd.fillRgba && sd.fillRgba[3] > 0;
    if (!fillDrawn) continue;
    _noAaAnyFill = true;
    const covered = noAaCovered(sd);
    if (!covered) {
      _noAaAllCovered = false;
      break;
    }
    // The stroke's THINNEST document-space width: under a non-conformal CTM `sw` is the widest, and the fill's
    // edge is covered only where the stroke is at its narrowest.
    const swMin = sd.swMin ?? sd.sw;
    if (swMin < _noAaMinSW) _noAaMinSW = swMin;
    if (sd.segs)
      for (const sg of sd.segs) {
        if (sg.type === SEG_CUBIC || sg.type === SEG_ARC) {
          _noAaCubicArc = true;
        }
      }
  }
  const noAaFill = _noAaAnyFill && _noAaAllCovered;
  //
  // Band-hard only (bits = 2). Tree-hard (3) needs the GWN run tree, which is baked
  // per BUNDLE and only when every fill is covered — the case the whole-bundle
  // MANTLE_HARD path already handles better.
  const NOAA_MIXED_MAX_SEGS = 64; // mirrors fillPass's NOAA_BANDHARD_MAX_SEGS
  let _noAaMixedAny = false,
    _noAaMixedMinSW = Infinity;
  for (let i = 0; i < ctx.shapesData.length; i++) {
    const sd = ctx.shapesData[i];
    if (!(!sd.fillNone && sd.fillRgba && sd.fillRgba[3] > 0)) continue;
    if (!noAaCovered(sd)) continue;
    // Cubic/arc walks get long; band-hard stops beating AA past this count, and
    // without an all-covered bundle there is no tree to fall back on.
    let curvy = 0,
      n = 0;
    for (const sg of sd.segs || []) {
      n++;
      if (sg.type === SEG_CUBIC || sg.type === SEG_ARC) curvy++;
    }
    if (curvy > 0 && n > NOAA_MIXED_MAX_SEGS) continue;
    sd._noAaHardBits = 2;
    _noAaMixedAny = true;
    if ((sd.swMin ?? sd.sw) < _noAaMixedMinSW) _noAaMixedMinSW = sd.swMin ?? sd.sw;
  }
  // THE NO-AA WINDING TREE IS OPT-IN (importSvg({ noAaTree: true })).
  // By default the import uses band-hard and does not build the tree; the option keeps tree-hard and its async tier-3 grid reachable.
  ctx._noAaTreeHard = opts.noAaTree === true && noAaFill && _noAaCubicArc;

  // The supplemental matrix for an objectBoundingBox GRADIENT.
  //
  // SVG 1.1 §13.2.2: under gradientUnits="objectBoundingBox" the gradient's coordinate system "is established
  // using the bounding box of the element to which the gradient is applied", and §7.11 says what that box is --
  // the tightest axis-aligned rectangle in the APPLICABLE ELEMENT'S own user space, the element's own transform
  // EXCLUDED from it -- and that the supplemental matrix [w 0 0 h minx miny] goes into the NESTED transform
  // stack, so the element's CTM applies on top. The element a gradient is applied to is the LEAF being painted
  // (fill / stroke resolve per painted element), never an ancestor: `<g fill="url(#g)">` gives each child its own
  // box. That is the one way this differs from an objectBoundingBox clip or mask, whose carrier may be a group.
  //
  // The defect. The shader normalizes the fragment through the meta row's bbox (_paintSample.glsl
  // sampleGradient, `shapeBB`), which is the DOCUMENT-space axis-aligned box of the already-transformed geometry.
  // That equals CTM x [w 0 0 h minx miny] only when the CTM's linear part is a POSITIVE DIAGONAL. Under a
  // rotation the document AABB of a turned shape is bigger than the shape and stays axis-aligned, so the
  // gradient did not turn with it; under a reflection the box is right but the unit square's +x runs backwards.
  //
  // THE FIX, and why it is not a new meta texel. A single AABB cannot express the turned box, but the bundle
  // ALREADY carries a full 2x3 per gradient: the gradient record's inverse-gradientTransform (gradient.js
  // buildGradientTables, slots 4..9), which the shader applies right after the normalization. Composing
  // `carrierCTM x [w 0 0 h minx miny]` into THAT and flipping the record's units flag to userSpaceOnUse gives
  //     gpos = inv(gradientTransform) x inv(supplemental) x fragment,
  // which is the spec's chain exactly -- with no wire-format change, no shader change on either platform, and no
  // extra per-fragment texel fetch in the seven places sampleGradient is called (two of them inside the pattern
  // composite loop, which runs per child per pixel). The price is one 16-float gradient record per DISTINCT
  // (gradient, supplemental matrix) pair, minted only for the carriers the document-AABB arithmetic gets wrong.
  //
  // The positive-diagonal case keeps the document-AABB arithmetic under an exact test, not a tolerance, so no
  // output that it already gets right moves by a rounding.
  //
  // The stroke row never uses the document-AABB arithmetic. The positive-diagonal early-out below is a statement
  // about the ROW a gradient samples against, not about the carrier. A FILL row's meta bbox is path-tight, so
  // under a positive diagonal the document AABB IS `carrierCTM x unit-square` and that arithmetic is exact.
  // A stroke row's is halfW-padded (bboxMeta below), which is precisely the box §7.11 says it is not ("without
  // the stroke") -- so there is NO carrier for which a stroke row's normalization is right, and the instance is
  // always minted for one, built from the path-tight own box.
  const _obbGradInst = new Map();
  /// `carrierCTM x [w 0 0 h minx miny]` for the shape's own box in its own user space, or null when the
  /// document-AABB arithmetic is already the same matrix (or when the shape never recorded its own space).
  /// True when this shape emits a STROKE row, whose meta bbox is halfW-padded. The condition is bboxMeta's own,
  /// verbatim, so the two cannot drift: pad the box there and this must mint an instance for it.
  const _hasPaddedStrokeRow = (sd) => strokeRowOf(sd);
  const _obbGradSup = (sd, forPaddedRow) => {
    const C = sd._obbCtm,
      bb = sd._obbBox;
    // No recorded own user space: text glyphs, markers and synthesized shapes arrive already in document space
    // and there is nothing to unmap them by. Leave them on the document-AABB path rather than guess at a box.
    if (!C || !bb) return null;
    if (!forPaddedRow && C[1] === 0 && C[2] === 0 && C[0] > 0 && C[3] > 0) return null;
    if (!(bb[2] > bb[0] && bb[3] > bb[1])) return null;
    return matMul(C, [bb[2] - bb[0], 0, 0, bb[3] - bb[1], bb[0], bb[1]]);
  };
  /// Reuse a placement record or compose the carrier matrix once. Object-box
  /// records include normalization; user-space records include only the CTM.
  const _obbGradId = (gid, M, userSpace = false) => {
    const g = ctx.gradientsUsed[gid - 1];
    if (!g || g._carrierPlaced || (g.units === GRAD_UNITS_USER && !userSpace)) return gid;
    const key = gid + '|' + M.join(',');
    const hit = _obbGradInst.get(key);
    if (hit) return hit;
    // No cap on minted rows: the gradient table wraps in 4096-row bands (renderer/tableLayout.js) and createBundle fails loudly
    // when the table exceeds the device capacity, so a placement is never silently left axis-aligned.
    // `stops` is shared BY REFERENCE with the row this clones, which is what buildGradientTables packs once.
    ctx.gradientsUsed.push(
      Object.assign({}, g, {
        units: GRAD_UNITS_USER,
        _carrierPlaced: true,
        gradient_transform: matMul(M, g.gradient_transform),
      }),
    );
    _obbGradInst.set(key, ctx.gradientsUsed.length);
    return ctx.gradientsUsed.length;
  };
  const rebindObbGradients = (fromShapeIdx) => {
    for (let i = fromShapeIdx; i < ctx.shapesData.length; i++) {
      const sd = ctx.shapesData[i];
      if (!(sd.fillGradId > 0 || sd.strokeGradId > 0)) continue;
      // Object-box paints require both extents before the CTM or stroke padding.
      const ownBox = sd._obbBox || shapeBbRaw[i];
      if (ownBox && !(ownBox[2] > ownBox[0] && ownBox[3] > ownBox[1])) {
        for (const paint of ['fill', 'stroke']) {
          const gid = sd[paint + 'GradId'];
          const gradient = gid > 0 && ctx.gradientsUsed[gid - 1];
          if (gradient && gradient.units !== GRAD_UNITS_USER) {
            // No usable paint server here (SVG 1.1 7.11): the url()'s fallback, else none.
            sd[paint + 'GradId'] = 0;
            sd[paint + 'Rgba'] = sd['_' + paint + 'Fallback'] || [0, 0, 0, 0];
          }
        }
      }
      for (const paint of ['fill', 'stroke']) {
        const field = paint + 'GradId',
          gid = sd[field],
          gradient = gid > 0 ? ctx.gradientsUsed[gid - 1] : null;
        if (!gradient || gradient._carrierPlaced) continue;
        if (gradient.units === GRAD_UNITS_USER) {
          const C = sd._obbCtm;
          if (
            C &&
            (C[0] !== 1 || C[1] !== 0 || C[2] !== 0 || C[3] !== 1 || C[4] !== 0 || C[5] !== 0)
          )
            sd[field] = _obbGradId(gid, C, true);
        } else {
          const M = _obbGradSup(sd, paint === 'stroke' && _hasPaddedStrokeRow(sd));
          if (M) sd[field] = _obbGradId(gid, M);
        }
      }
    }
  };
  rebindObbGradients(shapeBegin);

  function vectorPatternMaterial(sd) {
    let metaAtlasSlot = null;
    let metaImageRect = sd.imageRect || [0, 0, 0, 0];
    let metaPatInvLinear = null; // vector-pattern inverse linear → texel 5
    if (sd.vecPatternId > 0 && sd.vecPatternId <= ctx.vecPatternsUsed.length) {
      const vp = ctx.vecPatternsUsed[sd.vecPatternId - 1];
      let firstM = -1,
        lastM = -1;
      for (let s = vp.firstShapeIdx; s <= vp.lastShapeIdx; s++) {
        if (ctx.shapesData[s]._patternOwner !== sd.vecPatternId) continue;
        const f = shapeToFirstMeta[s];
        const l = shapeToLastMeta[s];
        if (f < 0) continue;
        if (firstM < 0) firstM = f;
        lastM = l;
      }
      if (firstM >= 0) {
        metaAtlasSlot = [firstM + 1, lastM + 1, 0, 2];
      } else {
        // A valid pattern with no emitted paint remains transparent.
        sd.fillRgba = [0, 0, 0, 0];
      }
      // patternTransform M = [a,b,c,d,e,f] (linear L=[[a,c],[b,d]], trans
      // t=(e,f)). The shader samples the tile at p = L⁻¹·emCoord wrapped, so
      // store L⁻¹ (column-major, in the carrier's otherwise-unused texel 5 —
      // _solid/_cgeom are hardcoded 0 for this emission path) and fold the
      // inverse translation into the tile origin. Identity when no transform.
      // Pattern space -> root: the referencing shape's transform times patternTransform, and the tile in pattern
      // space, both per shape (a pattern reused under different transforms or boxes tiles differently).
      const [pa, pb, pc, pd, pe, pf] = sd.patternMatrix || vp.patM || IDENT;
      const tile9 = sd.patternTile || [metaImageRect[0], metaImageRect[1], vp.tileEmW, vp.tileEmH];
      const det = pa * pd - pc * pb;
      let patInv = [1, 0, 0, 1]; // column-major mat2 (L⁻¹)
      let origX = tile9[0],
        origY = tile9[1];

      if (Math.abs(det) > 1e-12 * (Math.abs(pa * pd) + Math.abs(pc * pb))) {
        const ia = pd / det,
          ib = -pb / det,
          ic = -pc / det,
          id = pa / det;
        patInv = [ia, ib, ic, id]; // mat2(ia,ib,ic,id)·v = L⁻¹·v
        // tileOriginEff = origin − T⁻¹, T⁻¹ = −L⁻¹·t.
        origX += ia * pe + ic * pf;
        origY += ib * pe + id * pf;
      }
      // SHARED CONTENT (importWalk.js claimVectorPattern): the children are stored once, in canonical space, and this carrier is
      // an ordinary pattern whose space is that one: the box's scale (sx, sy) goes into the pattern inverse (its rows), the tile
      // origin and the tile size, and the alignment share of the tile (dx, dy canonical units) into the origin. The shader sees a
      // pattern with a transform, nothing more: no map, no flag, no wire field.
      const pcm = sd.patternContent;
      if (pcm) {
        patInv = [patInv[0] / pcm.sx, patInv[1] / pcm.sy, patInv[2] / pcm.sx, patInv[3] / pcm.sy];
        origX = origX / pcm.sx + pcm.dx;
        origY = origY / pcm.sy + pcm.dy;
        metaPatInvLinear = patInv;
        metaImageRect = [origX, origY, tile9[2] / pcm.sx, tile9[3] / pcm.sy];
      } else {
        metaPatInvLinear = patInv;
        metaImageRect = [origX, origY, tile9[2], tile9[3]];
      }
    }
    return { metaAtlasSlot, metaImageRect, metaPatInvLinear };
  }
  function emissionOrder(from, to, resource = false) {
    if (!ctx.vecPatternsUsed.length) return null;
    const compare = (a, b) => {
      const pa = ctx.shapesData[a]._patternOwner || 0,
        pb = ctx.shapesData[b]._patternOwner || 0;
      if (!pa) return pb ? 1 : a - b;
      if (!pb) return -1;
      return pa - pb || a - b;
    };
    if (resource) {
      let hasPattern = false;
      for (let i = from; i < to; i++)
        if (ctx.shapesData[i]._patternOwner > 0) {
          hasPattern = true;
          break;
        }
      if (!hasPattern) return null;
      return Array.from({ length: to - from }, (_, i) => from + i).sort(compare);
    }
    const nested = ctx.vecPatternsUsed.filter(
      (pattern) => pattern.nested && pattern.firstShapeIdx >= from && pattern.lastShapeIdx < to,
    );
    if (!nested.length) return null;
    const order = Array.from({ length: to - from }, (_, i) => from + i);
    nested.sort((a, b) => a.firstShapeIdx - b.firstShapeIdx || b.lastShapeIdx - a.lastShapeIdx);
    let covered = -1;
    for (const pattern of nested) {
      if (pattern.firstShapeIdx <= covered) continue;
      const first = pattern.firstShapeIdx - from,
        count = pattern.lastShapeIdx - pattern.firstShapeIdx + 1;
      const part = order.slice(first, first + count).sort(compare);
      for (let i = 0; i < part.length; i++) order[first + i] = part[i];
      covered = pattern.lastShapeIdx;
    }
    return order;
  }

  const mainOrder = emissionOrder(shapeBegin, ctx.shapesData.length);
  // The meta row each page shape (a non-layer record of the walk) starts at, for the hit-only shapes of the second import pass
  // (importer.js) to slot in among the drawn rows by document position. Entry `count` is the end of the page rows.
  const hitMainEnd = ctx.shapesData.length;
  const hitOrdinal = new Int32Array(hitMainEnd).fill(-1);
  let hitCount = 0;
  for (let j = shapeBegin; j < hitMainEnd; j++)
    if (!ctx.shapesData[j].isLayer && !ctx.shapesData[j]._hidden) hitOrdinal[j] = hitCount++;
  const hitRowAt = new Int32Array(hitCount + 1);
  const hitNeedsPass =
    !opts._hitPass &&
    !opts.ctx &&
    !opts.computeSilhouette &&
    (ctx._hitHiddenCandidate === true ||
      ctx.shapesData
        .slice(shapeBegin, hitMainEnd)
        .some((sd) => hitOnlyNeeds(sd, keepInvisibleOf(opts))));
  for (let ordinal = shapeBegin; ordinal < ctx.shapesData.length; ordinal++) {
    const _si = mainOrder ? mainOrder[ordinal - shapeBegin] : ordinal;
    const sd = ctx.shapesData[_si];
    if (hitOrdinal[_si] >= 0) hitRowAt[hitOrdinal[_si]] = ctx.metas.length;
    // Group transition shapes have no geometry — they're scaffolding
    // for the renderer to know where to allocate and composite group
    // FBOs. Push a placeholder meta record (so per-shape indexing
    // stays aligned) with flagsShape bit 6 = groupBegin and bit 7 =
    // groupEnd. The renderer can scan flagsShape to recognize the
    // boundary by scanning flagsShape.
    if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') {
      shapeToFirstMeta[_si] = ctx.metas.length;
      const isBegin = sd.kind === 'groupBegin';
      ctx.metas.push({
        shapeId: '', // group boundary — no SVG element correspondence
        bbox: sd.groupBBox || [0, 0, 0, 0],
        fillColor: [0, 0, 0, 0],
        strokeColor: [0, 0, 0, 0],
        strokeWidth: 0,
        fillRule: 'nonzero',
        accumGroupId: 0,
        glyphLoc: [0, 0],
        bandMaxX: 0,
        bandMaxY: 0,
        _solid_float_start: 0,
        _solid_float_count: 0,
        _cgeom_byte_off: 0,
        _cgeom_byte_len: 0,
        capStyle: CAP_BUTT,
        joinStyle: JOIN_MITER,
        miterLimit: 4,
        // flagsShape bit layout: bit 0 already used elsewhere; bits 6/7
        // reserved for group transitions.
        flagsShape:
          (sd.isLayer ? 0x100 : 0) | (isBegin ? 1 << 6 : 1 << 7) | (sd._hidden ? FS_HIDDEN : 0),
        fillGradId: 0,
        strokeGradId: 0,
        clipId: isBegin ? sd.clipId || 0 : 0,
        maskId: isBegin ? sd.maskId || 0 : 0,
        filterId: isBegin ? sd.filterId || 0 : 0,
        blendMode: isBegin ? sd.blendMode || 0 : 0,
        isolation: isBegin ? sd.isolation || 0 : 0,
        // groupOpacity is stored in fillColor.alpha (texel 1.w) for
        // groupBegin records — the cover frag never reads this row
        // because the synthetic shape generates no draw entry, so
        // there's no risk of mis-sampling. The renderer that honors
        // group-flatten will read this slot when allocating the FBO.
        // (For groupEnd: opacity is irrelevant.)
        imageId: 0,
        imageRect: [0, 0, 0, 0],
      });

      if (isBegin) {
        const last = ctx.metas[ctx.metas.length - 1];
        // `??`, not `||`: a group at opacity 0 is invisible, and `|| 1` made it opaque.
        last.fillColor = [0, 0, 0, sd.groupOpacity ?? 1];
      }
      shapeToLastMeta[_si] = ctx.metas.length - 1;
      continue;
    }

    const bboxFull = shapeBbRaw[_si] || pathBbox(sd.segs);
    // A stroked shape's boxes:
    //   bboxMeta   = path + halfW. Stored on the stroke row, and it is the box
    //                the shader indexes that row's bands through (strokeMinDist
    //                maps the fragment through MT_BBOX), so the encoder bins the
    //                bands through it too. Kept halfW-padded so the asset's
    //                globalBBox aggregation doesn't grow past the perceived ink,
    //                and because the annulus fast path derives the ring's radius
    //                from it.
    //   the stroke's REACH (bundle/strokeReach.js: miter tips, clipped-miter and
    //                square-cap corners) pads band membership and the cover quad
    //                instead; see emitStrokeRow.
    // The band grid is binned through the same box the shader indexes it by
    // (bboxMeta). Binning it through path + miterLimit * halfW instead would
    // let the two stripe sets drift apart by up to (miterLimit - 1) * halfW,
    // and a miter spike far from its segments could land in a stripe that does
    // not list them and go unpainted.
    // …and bboxFill = the PATH-TIGHT bbox, which is what the FILL row gets.
    //   A fill's ink stops at the path; padding its row by the stroke's reach
    //   made every consumer that reads a fill row's bbox as "the shape" wrong.
    //   The tagged-primitive SDF derives a circle's radius / a rect's extent
    //   from it (a stroked circle then flooded its whole cover quad with fill,
    //   showing as red bbox CORNERS outside the ring), and an
    //   objectBoundingBox gradient maps through it, which per SVG 1.1 §7.11 is
    //   the geometry bbox WITHOUT stroke. Layer fill rows already used the
    //   path-tight box; normal ones did not.
    let bboxMeta = bboxFull.slice();
    const bboxFill = bboxFull.slice();
    if (strokeRowOf(sd)) {
      const halfW = sd.sw * 0.5;
      bboxMeta = [
        bboxMeta[0] - halfW,
        bboxMeta[1] - halfW,
        bboxMeta[2] + halfW,
        bboxMeta[3] + halfW,
      ];
    }
    // Fill and stroke are emitted as SEPARATE meta rows. paint-order decides
    // which goes first, and it must decide it HERE: the cover-quad meshes are
    // appended to the VBO in emission order, and the renderer batches adjacent
    // chunks only while `chunk.vboStart === pendingEnd`. Emitting fill-then-stroke
    // and swapping the two meta rows afterwards — which is what this did — left the
    // draw order reversed against the VBO order, so the pair stopped being
    // contiguous and every paint-order:stroke shape cost TWO draws instead of one.
    // Emitting in the right order costs nothing and keeps the pair batchable.
    const emitFillRow = () => {
      // (1) Fill shell via cover quad + curve+band data.
      //
      // Normally a fully-transparent fill (alpha 0) emits no fill row — the
      // shape is invisible, so culling it shrinks the bundle. But that makes a
      // pose's shape SET depend on its per-pose paint: a shape that fades in via
      // fill-opacity (0 → n) is absent in the early poses and present later, so
      // consecutive shape-timeline / morph poses get DIFFERENT topology and the
      // morph can't establish a stable correspondence (the faded shape pops in
      // and neighbors' correspondence shifts). `opts.keepInvisibleShapes` keeps
      // such a shape at alpha 0 so the topology is uniform across poses and the
      // morph lerps its opacity (+ geometry) smoothly. `fill="none"` (no fill
      // paint at all, vs a real color that's merely transparent) is still
      // culled — there's genuinely nothing to draw.
      const keepInvisibleFill =
        keepInvisibleOf(opts) &&
        (sd.fillNone !== true || keepInvisibleOf(opts) === 2) &&
        sd.segs &&
        sd.segs.length > 0;
      if (sd.fillRgba[3] > 0 || keepInvisibleFill) {
        // Layer rows (pattern children) don't draw their own cover quad
        // and don't allocate an accumGroupId — they exist purely so the
        // parent pattern's composite loop can sample them via texelFetch
        // on their meta row.
        const gid = sd.isLayer ? 0 : ctx.nextGid++;
        if (!sd.isLayer) {
          // A filtered shape keeps the box (fan off). Its SourceGraphic pass renders it into an RT sized to the
          // filter's bbox, through a viewport translated by that RT's even origin, or into a canvas-sized one, and the
          // two must agree byte for byte (filterBboxRenderDiffSmoke). The GPU's varying interpolation is not exact
          // under that translation, and every internal edge of a cover that crosses the AA band exposes it; the box
          // quad's two triangles came out identical in every case.
          const mesh = getCoverQuadMesh(
            sd.segs,
            gid,
            sd.fillRgba,
            sd.fillRule,
            0,
            ctx.coverFan === true && !sd.filterId,
          );
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
        // Walk the path through splitSubpathsWithCloseInto so each subpath is
        // explicitly closed by a synthetic line back to its start. The
        // coverage walker's winding accumulator (ray-cast crossings → coverage) only gives
        // correct fill coverage on CLOSED paths; an open polyline leaves
        // path-interior pixels undercounted.
        const closedFillSegs = [];
        splitSubpathsWithCloseInto(sd.segs, closedFillSegs);
        const bxy = pickBandsXY(closedFillSegs, bboxFill, ctx.vBands !== false, ctx.bandK || 32);

        const _fillCurveStart = ctx.curveBuf.count * 4;
        // gwnTree (opt-in, importSvg({ gwnTree: true })): the run-tree the closed-form winding
        // kernel needs. Bands cannot prune a winding number; this can. Fill shapes only.
        // TIER-3 async: the AUTOMATIC no-AA-tree-hard path defers the tier-3 occupancy
        // grid (85% of the bake) to a post-load idle pass — the tree still renders
        // (tier-1/2 present), the grid just accelerates interior pixels once it lands.
        // An EXPLICIT gwnTree opt keeps it synchronous (bits in `sections.bands` for
        // non-GL consumers / predictable tests).
        const _treeAsync = ctx._noAaTreeHard === true && !opts.gwnTree;
        let fm = buildTexturesShape(
          closedFillSegs,
          bxy.bandsX,
          bxy.bandsY,
          bboxFill,
          ctx.curveBuf,
          ctx.bandBuf,
          0,
          /* fillOnly */ true,
          false,
          ctx.pairBands === true,
          !!opts.gwnTree || ctx._noAaTreeHard === true,
          _treeAsync ? ctx._pendingTier3 || (ctx._pendingTier3 = []) : null,
          // the FILL RULE, which the GWN tree needs to decide each
          // contour's ink side (an even-odd hole is wound like its outer)
          sd.fillRule === 'evenodd',
          ctx.aacLevels === true,
          // the crossing-axis lanes: a fill row, strokeWidth 0 -- the
          // shape's stroke is its own row with its own structure (below)
          ctx.rayLanes !== false,
        );
        if (fm.gwnUnsafe) ctx.gwnUnsafe = true;
        // a nonzero path with a contour wholly inside another of the same orientation. The winding integrators (AAC, Slug's
        // fold) would count the inner one twice, so the BANDS and every other fill-coverage structure are built from the list without it
        // (fillNormalize.js). The curve RECORDS stay the authored ones: this shape's curve range, the morph, the hit test, the Loop-Blinn
        // and CPatch builders and the exports all read them. The normalized build writes its own copy of the kept records after the
        // authored range (the bands refer to those), and the authored band region stays in the buffer so a morph can use it again
        // (createShapeMorph patches the meta row back to it -- bundle.authoredBandsByShape).
        let _authoredBands = null,
          _occSegs = closedFillSegs,
          _fillNorm = 0;
        if (ctx.normalizeFill !== false && !sd.primKind && !sd.vecPatternId) {
          const _normStatus = { status: 0 };
          const _normFillSegs = normalizedFillSegs(
            closedFillSegs,
            sd.fillRule === 'evenodd',
            _normStatus,
          );
          _fillNorm = _normStatus.status | 0;
          if (_normFillSegs) {
            const _authFm = fm,
              _authEnd =
                _authFm.curveEndF !== undefined ? _authFm.curveEndF : ctx.curveBuf.count * 4;
            const _bxyN = pickBandsXY(
              _normFillSegs,
              bboxFill,
              ctx.vBands !== false,
              ctx.bandK || 32,
            );
            fm = buildTexturesShape(
              _normFillSegs,
              _bxyN.bandsX,
              _bxyN.bandsY,
              bboxFill,
              ctx.curveBuf,
              ctx.bandBuf,
              0,
              /* fillOnly */ true,
              false,
              ctx.pairBands === true,
              !!opts.gwnTree || ctx._noAaTreeHard === true,
              _treeAsync ? ctx._pendingTier3 || (ctx._pendingTier3 = []) : null,
              // the FILL RULE, which the GWN tree needs to decide each
              // contour's ink side (an even-odd hole is wound like its outer)
              sd.fillRule === 'evenodd',
              ctx.aacLevels === true,
              // the crossing-axis lanes: a fill row, strokeWidth 0 -- the
              // shape's stroke is its own row with its own structure (below)
              ctx.rayLanes !== false,
            );
            fm.curveEndF = _authEnd;
            if (fm.gwnUnsafe) ctx.gwnUnsafe = true;
            ctx.totalSegments += _authFm.numSegments | 0;
            // Authored records remain in the bundle and are restored for morphs.
            // A redundant contour may be the only cubic/quad, so coverage-only
            // normalization must not erase the kernel needed by that geometry.
            ctx.segTypeMask |= _authFm.typeMask;
            _authoredBands = {
              glyphLoc: [_authFm.glyphLoc[0], _authFm.glyphLoc[1]],
              bandMaxX: _authFm.bandMaxX,
              bandMaxY: _authFm.bandMaxY,
            };
            _occSegs = _normFillSegs;
          }
        }

        ctx.segTypeMask |= fm.typeMask;
        ctx.totalSegments += fm.numSegments | 0;

        const { metaAtlasSlot, metaImageRect, metaPatInvLinear } = vectorPatternMaterial(sd);
        if (shapeToFirstMeta[_si] < 0) shapeToFirstMeta[_si] = ctx.metas.length;
        ctx.metas.push({
          _hit: hitBitsOfRow(sd, HIT_FILL | HIT_BBOX),
          shapeId: sd.shapeId || synthId(sd, ctx.metas.length, 'fill'),
          // Internal: float-index into curveFloats where this shape's
          // curves begin. Stripped during packMetaBody (won't reach
          // the GPU). Used to build sections.curveRangesByShape; the
          // morph slices per-shape curves with these offsets.
          _curveStartF: _fillCurveStart,
          // …and where they END. Inferring the end from "the next shape's begin,
          // else the buffer total" is wrong for the LAST shape: the curve buffer
          // also carries trailing data owned by NO shape (its size varies with
          // geometry), so that shape's length came out inflated AND different per
          // bundle. buildMorphPlan matches on equal curve length, so the last
          // shape of every bundle silently fell out of the morph and CROSSFADED —
          // a ghost of it drifting between poses. The cursor after emit is the
          // exact end; record it.
          //
          // And it must be the end of the CURVES, not of the buffer cursor: with importSvg({gwnTree})
          // the GWN run tree appends its piece records to this same buffer, right after them. Taking
          // the cursor here would hand every consumer that reads a shape by range (the Loop-Blinn
          // builder, the morph planner, the hit test) the tree as if it were geometry. buildTextures
          // reports where the curves actually stop.
          _curveEndF: fm.curveEndF !== undefined ? fm.curveEndF : ctx.curveBuf.count * 4,
          bbox: [bboxFill[0], bboxFill[1], bboxFill[2], bboxFill[3]],
          fillColor: sd.fillRgba,
          strokeColor: [0, 0, 0, 0],
          strokeWidth: 0,
          fillRule: sd.fillRule,
          accumGroupId: gid,
          glyphLoc: fm.glyphLoc,
          bandMaxX: fm.bandMaxX,
          bandMaxY: fm.bandMaxY,
          _authoredBands,
          _fillNorm,
          _solid_float_start: 0,
          _solid_float_count: 0,
          _cgeom_byte_off: 0,
          _cgeom_byte_len: 0,
          capStyle: CAP_BUTT,
          joinStyle: JOIN_MITER,
          miterLimit: 4,
          // Fill row keeps only shape-wide vector-effect bits (10/11/12).
          // Bits 0/1 (non-scaling-stroke, hasDash) are stroke-only.
          // Bits 15-16: per-row fill engine for MANTLE_HARD_MIXED (2 = hard-band,
          // 3 = hard-tree, else AA). Set only where a later opaque stroke provably
          // hides this fill's edge — see the MIXED per-row scan above.
          flagsShape:
            ((sd.flagsShape || 0) & 0x1c00) |
            (sd.isLayer ? 0x100 : 0) |
            ((sd._noAaHardBits || 0) << 15) |
            (keepInvisibleFill && sd.fillRgba[3] === 0 ? FS_KEPT_INVISIBLE : 0) |
            (keepInvisibleFill && sd.fillColorClear === true && sd.fillRgba[3] === 0
              ? FS_FILL_HUELESS
              : 0) |
            (sd._hidden ? FS_HIDDEN : 0),
          fillGradId: sd.fillGradId || 0,
          strokeGradId: 0,
          clipId: sd.clipId || 0,
          maskId: sd.maskId || 0,
          filterId: sd.filterId || 0,
          blendMode: sd.blendMode || 0,
          isolation: sd.isolation || 0,
          imageId: sd.imageId || 0,
          imageRect: metaImageRect,
          atlasSlot: metaAtlasSlot, // null → back-filled by atlas pass; set → vector pattern sentinel
          patInvLinear: metaPatInvLinear, // vector-pattern inverse linear (texel 5); null → solid/cgeom
          pixelated: sd.pixelated || 0,
          // Primitive fast path: closed-form fill coverage for tagged primitives
          // (circle=1). The shader derives the shape from this row's bbox and
          // gates on uniform scale; falls back to the ray-cast otherwise. Fill
          // row only — strokes still walk the curve buffer. Suppressed when the
          // fill needs the curve-walk path (gradient / vector-pattern / image
          // paint sample the coverage shape, and clip/mask coverage too).
          primKind:
            sd.primKind &&
            !sd.fillGradId &&
            !sd.vecPatternId &&
            !sd.imageId &&
            !sd.clipId &&
            !sd.maskId
              ? sd.primKind
              : 0,
          // roundRect corner radius (em); slot 46. Gated identically to primKind
          // (only meaningful when a roundRect's primKind==3 survives) so it never
          // carries stale rx when the primitive fast-path is suppressed.
          primRx:
            sd.primKind === 3 &&
            !sd.fillGradId &&
            !sd.vecPatternId &&
            !sd.imageId &&
            !sd.clipId &&
            !sd.maskId
              ? sd.primRx || 0
              : 0,
          // Interior-skip occupancy grid (opt-in). Built from the fill geometry
          // only (paint-agnostic: the skip returns coverage 1.0 for proven-
          // interior fragments, which downstream gradient/clip/blend handle
          // unchanged). Not built for primKind fast-path shapes (already O(1)),
          // vector-pattern carriers (texel-5 slots reused), or coverage-sampled
          // paints would still be correct but skip the build to keep it cheap.
          //
          // FROM THE CLOSED SEGMENTS THE FILL ENCODES, not the path as authored. The grid's
          // inside test crosses each segment's flattened run and never closes a contour
          // itself, so an OPEN subpath (legal, filled as if closed) handed in without its
          // closing edge certified cells beyond that edge as interior; the skip then painted
          // them solid under every kernel that reads the grid (Slug, AAC, band-hard, GWN);
          // Loop-Blinn builds its own mesh and does not read it.
          _occGrid:
            _occOn &&
            !_occAsync &&
            !sd.primKind &&
            !sd.vecPatternId &&
            _occAreaOk(shapeBbRaw[_si], sd)
              ? buildOccupancyGrid(_occSegs, bboxFill, sd.fillRule === 'evenodd', _occOpts)
              : null,
          // Async eligibility: hold the build inputs; the packing pass reserves a
          // zeroed region + descriptor and records this for the idle fill.
          _occPending:
            _occOn &&
            _occAsync &&
            !sd.primKind &&
            !sd.vecPatternId &&
            _occAreaOk(shapeBbRaw[_si], sd)
              ? { segs: _occSegs, bbox: bboxFill.slice(), evenOdd: sd.fillRule === 'evenodd' }
              : null,
        });
      }
    };
    const emitStrokeRow = () => {
      // (2) Stroke shell — emits a cover-quad chunk + curve/band data
      // for inline single-pass-per-shape rendering.
      if (strokeRowOf(sd)) {
        // Bin the bands through the box the shader indexes them by: the
        // row's meta bbox (see bboxMeta above).
        const sbxy = pickBandsXY(sd.segs, bboxMeta, ctx.vBands !== false, ctx.bandK || 32);
        const _strokeCurveStart = ctx.curveBuf.count * 4;
        // Pad band membership so pixels within the stroke's reach of a segment
        // that lives in an adjacent band still discover it, and pass the same
        // pad to getCoverQuadMesh so the cover quad emits fragments there.
        //
        // The pad is the stroke's whole REACH (bundle/strokeReach.js), and it
        // is not the grid bbox's pad: band membership and the cover quad must
        // reach every pixel the SVG 2 shape inks, while the grid bbox must stay
        // the one the shader indexes bands through. A pixel outside the grid box
        // clamps to an edge band, which lists every segment within the pad of
        // that edge. Padding miter-clip by halfW would cut its spike off flat at
        // half a width; padding arcs by the miter limit falls a little short of
        // the clip line's corners; and padding a square cap by halfW would cut
        // its outer corners (sqrt(2) * halfW from the endpoint) off both the
        // cover quad and the bands.
        //
        // A stroke drawn in STROKE SPACE (sd.strokeFrame) needs nothing else here: its `sw` is sMax * w, which is
        // the stroke-space width AND a bound on the document-space width in every direction, so this pad and the cover
        // quad still reach its ink. The encoder takes the frame to write its arc lengths and curvatures in its units.
        const halfWStroke = sd.sw * 0.5;
        const strokePad =
          halfWStroke *
          strokeReachFactor(
            sd.joinStyle,
            sd.miterLimit,
            sd.capStyle,
            sd.endCapStyle ?? sd.capStyle,
          );
        const sm = buildTexturesShape(
          sd.segs,
          sbxy.bandsX,
          sbxy.bandsY,
          bboxMeta,
          ctx.curveBuf,
          ctx.bandBuf,
          strokePad,
          false,
          sd.joinStyle === JOIN_ARCS,
          false,
          false,
          null,
          false,
          false,
          false,
          sd.strokeFrame || null,
          zeroLengthStroke(sd, !walkCtx || walkCtx.compat !== 'chrome'),
          dashedStroke(sd),
        );
        ctx.segTypeMask |= sm.typeMask;
        ctx.totalSegments += sm.numSegments | 0;

        // Layer stroke rows: no cover-quad mesh, no accum gid — the parent
        // pattern composite samples their stroke coverage directly.
        const sgid = sd.isLayer ? 0 : ctx.nextGid++;
        let strokeMesh = null;
        if (!sd.isLayer) {
          strokeMesh = getCoverQuadMesh(sd.segs, sgid, sd.strokeRgba, 'nonzero', strokePad);
          if (strokeMesh.length) {
            const nv = strokeMesh.length / COVER_QUAD_STRIDE;
            const [r, g, b, a] = sd.strokeRgba;
            // strokes don't have a fill rule — use nonzero (positive aFlag).
            ctx.hybridFloats.push(nv, sgid, r, g, b, a, 0, 0, 0, 0, -1, 1);
            Array.prototype.push.apply(ctx.hybridFloats, strokeMesh);
          }
        }

        // importSvg({ strokeStrip: true }). The strip cover of this stroke row (svg/strokeStrip.js), kept BESIDE the
        // row's single quad, which every other consumer keeps reading; only the unified route's stream builder
        // swaps it in (unifiedFillDraw entriesFor), per draw and where the draw allows it. Not for a stroke-space row, a
        // layer, or a non-scaling stroke (its em width follows the draw's scale, which a strip built once cannot).
        let _strip = null;
        // DEFAULT ON (the renderer's per-row policy decides, per draw, which rows use it); importSvg({ strokeStrip: false }) builds none.
        if (
          opts.strokeStrip !== false &&
          !sd.isLayer &&
          !sd.strokeFrame &&
          !((sd.flagsShape || 0) & 1) &&
          true
        ) {
          let boxArea = 0;
          const quadMesh = strokeMesh; // the row's own quad: the strip's area gate compares against it
          for (let i = 0; i + 2 < quadMesh.length / COVER_QUAD_STRIDE; i += 3) {
            const a0 = i * COVER_QUAD_STRIDE,
              b0 = a0 + COVER_QUAD_STRIDE,
              c0 = b0 + COVER_QUAD_STRIDE;
            boxArea +=
              0.5 *
              Math.abs(
                (quadMesh[b0] - quadMesh[a0]) * (quadMesh[c0 + 1] - quadMesh[a0 + 1]) -
                  (quadMesh[b0 + 1] - quadMesh[a0 + 1]) * (quadMesh[c0] - quadMesh[a0]),
              );
          }
          const so = typeof opts.strokeStrip === 'object' ? opts.strokeStrip : {};
          const maxR = so.maxAreaRatio > 0 ? so.maxAreaRatio : undefined;
          const st = buildStrokeStrip(sd.segs, {
            halfW: halfWStroke,
            joinStyle: sd.joinStyle,
            miterLimit: sd.miterLimit,
            capStyle: sd.capStyle,
            endCapStyle: sd.endCapStyle ?? sd.capStyle,
            boxArea,
            maxAreaRatio: maxR,
            tolFactor: so.tolFactor || undefined,
            tolDiag: so.tolDiag != null ? so.tolDiag : STRIP_DEFAULT_TOL_DIAG,
          });
          if (st)
            _strip = {
              verts: Float32Array.from(st.verts),
              overlap: st.overlap,
              authoredW: sd.sw,
              quadArea: boxArea,
              stripArea: st.area,
            };
        }
        if (shapeToFirstMeta[_si] < 0) shapeToFirstMeta[_si] = ctx.metas.length;
        if (_strip) (ctx.stripRows || (ctx.stripRows = []))[ctx.metas.length] = _strip;
        ctx.metas.push({
          _hit: hitBitsOfRow(sd, HIT_STROKE),
          shapeId: sd.shapeId ? `${sd.shapeId}_stroke` : synthId(sd, ctx.metas.length, 'stroke'),
          _curveStartF: _strokeCurveStart,
          _curveEndF: sm.curveEndF !== undefined ? sm.curveEndF : ctx.curveBuf.count * 4,

          bbox: [bboxMeta[0], bboxMeta[1], bboxMeta[2], bboxMeta[3]],
          // The ink's own box (miter tips, square-cap corners), for the bundle's globalBBox only: never packed, so the row's bbox
          // and every section stay byte-identical. null when the ink stays inside path +- halfW (almost every stroke).
          inkBBox: strokeInkBBox(sd, bboxMeta),
          fillColor: [0, 0, 0, 0],
          strokeColor: sd.strokeRgba,
          strokeWidth: sd.sw,
          fillRule: sd.fillRule,
          accumGroupId: sgid,
          glyphLoc: sm.glyphLoc,
          bandMaxX: sm.bandMaxX,
          bandMaxY: sm.bandMaxY,
          _solid_float_start: 0,
          _solid_float_count: 0,
          _cgeom_byte_off: 0,
          _cgeom_byte_len: 0,
          capStyle: sd.capStyle,
          joinStyle: sd.joinStyle,
          miterLimit: metaMiterLimit(sd, sm),
          _authoredMiterLimit: Math.max(1, sd.miterLimit || 4),
          // ANNULUS fast path (primKind 4, stroke rows only). A stroked circle is
          // an annulus, whose distance field is closed-form — so the per-fragment
          // band walk strokeMinDist would do is unnecessary. The shader derives
          // the centerline radius from this row's bbox, which is halfW-padded
          // (see the note above), so nothing extra is stored: slot 46 already
          // carries endCapStyle on stroke rows and must not be reused.
          //
          // A closed circle has no caps and no joins, so the cap/join arguments
          // the walk would consult are inert here. Dashing IS consulted, so the
          // shader falls back to the walk when a dash pattern is present.
          // Excluded when the stroke paint needs per-segment data (gradient /
          // bitmap stroke) or when the row is a clip/mask layer.
          // NOT under a stroke frame: the annulus is the offset of a CIRCLE, and a circle under a non-conformal CTM
          // is an ellipse whose stroke no annulus draws -- and whose baked bbox can still be square (rotate(45)
          // scale(2 1)), which is all the shader's own gate looks at.
          primKind:
            sd.primKind === 1 &&
            !sd.strokeGradId &&
            !sd.strokeImageId &&
            !sd.isLayer &&
            !sd.strokeFrame
              ? 4
              : 0,
          flagsShape:
            (sd.flagsShape || 0) |
            (sd.isLayer ? 0x100 : 0) |
            (sd.strokeFrame ? FS_STROKE_LOCAL : 0) |
            (sm.dashSeam ? FS_DASH_SEAM : 0) |
            (sd._keepStroke === true && sd.strokeRgba[3] === 0 ? FS_KEPT_INVISIBLE : 0) |
            (sd._hidden ? FS_HIDDEN : 0),
          strokeFrame: sd.strokeFrame || null,
          fillGradId: 0,
          strokeGradId: sd.strokeGradId || 0,
          strokeImageId: sd.strokeImageId || 0, // bitmap-fill stroke (image pattern)
          clipId: sd.clipId || 0,
          maskId: sd.maskId || 0,
          filterId: sd.filterId || 0,
          blendMode: sd.blendMode || 0,
          isolation: sd.isolation || 0,
        });
      }
    };
    // paint-order="stroke" puts the stroke UNDER the fill.
    if (sd.strokeFirst) {
      emitStrokeRow();
      emitFillRow();
    } else {
      emitFillRow();
      emitStrokeRow();
    }
    if (shapeToFirstMeta[_si] >= 0) shapeToLastMeta[_si] = ctx.metas.length - 1;
  }

  hitRowAt[hitCount] = ctx.metas.length;

  // Sprite-sheet ranges: { spriteId: [firstMetaRow, lastMetaRow] } in
  // meta-row space (the space drawSprite + the override table address). One
  // entry per top-level <g id> / lone id'd top-level shape (stamped as
  // sd._spriteId during the walk). Built post-loop from the same
  // shapeToFirst/LastMeta arrays clipperRows uses, so it survives the
  // shapesData→meta index drift (group scaffolding, fill+stroke pairs).

  const _spriteSpan = new Map(); // id -> { lo, hi, count }
  for (let _si = 0; _si < ctx.shapesData.length; _si++) {
    const sid = ctx.shapesData[_si]._spriteId;
    if (!sid) continue;
    const fm = shapeToFirstMeta[_si],
      lm = shapeToLastMeta[_si];
    if (fm < 0 || lm < 0) continue; // emitted no meta rows (e.g. group scaffolding)
    let e = _spriteSpan.get(sid);
    if (!e) {
      e = { lo: fm, hi: lm, count: 0 };
      _spriteSpan.set(sid, e);
    }
    if (fm < e.lo) e.lo = fm;
    if (lm > e.hi) e.hi = lm;
    e.count += lm - fm + 1;
  }
  const spriteRangesObj = {};
  const spriteRangesNonContiguous = [];
  for (const [sid, e] of _spriteSpan) {
    // defineProperty: a sprite id of "__proto__" is a key, not a prototype assignment.
    Object.defineProperty(spriteRangesObj, sid, {
      value: [e.lo, e.hi],
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (e.count !== e.hi - e.lo + 1) spriteRangesNonContiguous.push(sid);
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
  const clipMetaRow = ctx._clipMetaRow || (ctx._clipMetaRow = []);
  while (clipMetaRow.length < ctx.clipsUsed.length) clipMetaRow.push(0);
  // 1-based last-layer-row for each clip (the FLAG_CLIP_END row of
  // multi-shape clips; same as clipMetaRow for single-shape clips).
  // Needed by the animatable-clipper API: setClipper(svgId)
  // writes the affine override to ALL layer rows in [first..last] so
  // every child of a multi-shape clip transforms together.
  const clipMetaLastRow = ctx._clipMetaLastRow || (ctx._clipMetaLastRow = []);
  while (clipMetaLastRow.length < ctx.clipsUsed.length) clipMetaLastRow.push(0);
  const maskMetaRow = ctx._maskMetaRow || (ctx._maskMetaRow = []);
  while (maskMetaRow.length < ctx.masksUsed.length) maskMetaRow.push(0);
  // 1-based last layer row of each mask (= maskMetaRow for single-child
  // masks). Lets clipperRows expose a mask's full child-row range so the
  // native fallback can morph mask geometry (the reveal wipe).
  const maskMetaLastRow = ctx._maskMetaLastRow || (ctx._maskMetaLastRow = []);
  while (maskMetaLastRow.length < ctx.masksUsed.length) maskMetaLastRow.push(0);
  const FLAG_MASK_BEGIN = 1 << 9;
  const FLAG_MASK_END = 1 << 10;

  // Helper: emit meta rows for shapes appended after a clip/mask
  // subtree walk. Handles fill/stroke degeneracy + IsLayer. Returns
  // (firstMeta, lastMeta) in 0-based meta-row indices.
  function emitMetaSuffix(fromShapeIdx, retainGroups = false) {
    // Clip / mask / pattern children reach this the same way a page shape reaches the loop above, and an
    // objectBoundingBox gradient on one binds to ITS box in ITS own space (which for a pattern child is the
    // pattern's space, the space this row's bbox is in too).
    rebindObbGradients(fromShapeIdx);
    while (shapeToFirstMeta.length < ctx.shapesData.length) shapeToFirstMeta.push(-1);
    while (shapeToLastMeta.length < ctx.shapesData.length) shapeToLastMeta.push(-1);
    let firstMeta = -1,
      lastMeta = -1;
    const layerOrder = emissionOrder(fromShapeIdx, ctx.shapesData.length, true);
    for (let ordinal = fromShapeIdx; ordinal < ctx.shapesData.length; ordinal++) {
      const i = layerOrder ? layerOrder[ordinal - fromShapeIdx] : ordinal;
      const sd = ctx.shapesData[i];
      if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') {
        if (!retainGroups) continue;
        const row = ctx.metas.length,
          start = ctx.curveBuf.count * 4;
        const begin = sd.kind === 'groupBegin';
        ctx.metas.push({
          shapeId: '',
          bbox: [0, 0, 0, 0],
          fillColor: [0, 0, 0, begin ? (sd.groupOpacity ?? 1) : 0],
          strokeColor: [0, 0, 0, 0],
          strokeWidth: 0,
          glyphLoc: [0, 0],
          bandMaxX: 0,
          bandMaxY: 0,
          _curveStartF: start,
          _curveEndF: start,
          flagsShape: FLAG_LAYER | (begin ? 64 : 128),
          blendMode: begin ? sd.blendMode || 0 : 0,
          isolation: 0,
          capStyle: CAP_BUTT,
          joinStyle: JOIN_MITER,
          miterLimit: 4,
        });
        shapeToFirstMeta[i] = shapeToLastMeta[i] = row;
        if (!sd._patternOwner) {
          if (firstMeta < 0) firstMeta = row;
          lastMeta = row;
        }
        continue;
      }
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
        const pad =
          sd.joinStyle === 0
            ? halfW * Math.min(Math.max(1, sd.miterLimit || 4), MAX_MITER_RATIO)
            : halfW;
        const xmin = isFinite(fillBb2[0]) ? fillBb2[0] : 0;
        const ymin = isFinite(fillBb2[1]) ? fillBb2[1] : 0;
        const xmax = isFinite(fillBb2[2]) ? fillBb2[2] : 0;
        const ymax = isFinite(fillBb2[3]) ? fillBb2[3] : 0;
        bbox2 = [xmin - pad, ymin - pad, xmax + pad, ymax + pad];
      }
      const strokeBbValid = bbox2[2] > bbox2[0] && bbox2[3] > bbox2[1];
      if (!fillBbValid && !strokeBbValid) continue;

      const f32Res =
        2 ** -23 *
        Math.max(
          Math.abs(fillBb2[0]),
          Math.abs(fillBb2[1]),
          Math.abs(fillBb2[2]),
          Math.abs(fillBb2[3]),
        );
      const fillBboxDegen =
        !fillBbValid || fillBb2[2] - fillBb2[0] <= f32Res || fillBb2[3] - fillBb2[1] <= f32Res;
      // Fill row.
      if (sd.fillRgba && sd.fillRgba[3] > 0 && !fillBboxDegen) {
        const psubs = [];
        splitSubpathsWithCloseInto(sd.segs, psubs);
        const pbbox = fillBb2; // path-tight for layer rows
        const pbxy = pickBandsXY(psubs, pbbox, ctx.vBands !== false, ctx.bandK || 32);
        const { metaAtlasSlot, metaImageRect, metaPatInvLinear } = vectorPatternMaterial(sd);
        const _layerFillStart = ctx.curveBuf.count * 4;
        const pfm = buildTexturesShape(
          psubs,
          pbxy.bandsX,
          pbxy.bandsY,
          pbbox,
          ctx.curveBuf,
          ctx.bandBuf,
          0,
          false,
          false,
          ctx.pairBands === true,
          false,
          null,
          false,
          ctx.aacLevels === true,
          // a layer FILL row: no stroke walker reads it (the layer's stroke gets its own below)
          ctx.rayLanes !== false,
        );
        ctx.segTypeMask |= pfm.typeMask;
        ctx.totalSegments += pfm.numSegments | 0;
        if (shapeToFirstMeta[i] < 0) shapeToFirstMeta[i] = ctx.metas.length;
        if (!sd._patternOwner) {
          if (firstMeta < 0) firstMeta = ctx.metas.length;
          lastMeta = ctx.metas.length;
        }
        ctx.metas.push({
          shapeId: sd.shapeId || synthId(sd, ctx.metas.length, 'fill'),
          _curveStartF: _layerFillStart,
          _curveEndF: pfm.curveEndF ?? ctx.curveBuf.count * 4,
          bbox: [pbbox[0], pbbox[1], pbbox[2], pbbox[3]],
          fillColor: sd.fillRgba,
          strokeColor: [0, 0, 0, 0],
          strokeWidth: 0,
          fillRule: sd.fillRule,
          accumGroupId: 0,
          glyphLoc: pfm.glyphLoc,
          bandMaxX: pfm.bandMaxX,
          bandMaxY: pfm.bandMaxY,
          _solid_float_start: 0,
          _solid_float_count: 0,
          _cgeom_byte_off: 0,
          _cgeom_byte_len: 0,
          capStyle: CAP_BUTT,
          joinStyle: JOIN_MITER,
          miterLimit: 4,
          flagsShape: FLAG_LAYER,
          fillGradId: sd.fillGradId || 0,
          strokeGradId: 0,
          // Propagate clipId / maskId for nested clipPath/mask support:
          // a clip-child can carry `clip-path="url(#inner)"`, and the
          // post-walk rewrite loop translates the 1-based registry ref
          // to a 1-based meta-row ref. The shader's depth-1 nested-clip
          // evaluator then AND-multiplies the inner clip's coverage
          // into the child's coverage.
          clipId: sd.clipId || 0,
          maskId: sd.maskId || 0,
          filterId: 0,
          blendMode: retainGroups ? sd.blendMode || 0 : 0,
          isolation: 0,
          imageId: sd.imageId || 0,
          imageRect: metaImageRect,
          atlasSlot: metaAtlasSlot,
          patInvLinear: metaPatInvLinear,
          pixelated: sd.pixelated || 0,
        });
      }
      // Stroke row.
      const strokeDegen = fillBb2[2] - fillBb2[0] <= f32Res && fillBb2[3] - fillBb2[1] <= f32Res;
      if (sd.sw > 0 && sd.strokeRgba && sd.strokeRgba[3] > 0 && !strokeDegen) {
        const sbxy = pickBandsXY(sd.segs, bbox2, ctx.vBands !== false, ctx.bandK || 32);
        const _layerStrokeStart = ctx.curveBuf.count * 4;
        // Band membership reaches the whole stroke (bundle/strokeReach.js), not halfW: a
        // miter, clipped-miter or square-cap-corner pixel lies farther than halfW from the
        // segments it needs. And stroke-linejoin="arcs" needs the curvature texel here as on a
        // page shape's row: without it the walk read the next segment's header as the
        // join's curvatures and the hit test decoded the plane out of step.
        const sm = buildTexturesShape(
          sd.segs,
          sbxy.bandsX,
          sbxy.bandsY,
          bbox2,
          ctx.curveBuf,
          ctx.bandBuf,
          sd.sw *
            0.5 *
            strokeReachFactor(
              sd.joinStyle,
              sd.miterLimit,
              sd.capStyle,
              sd.endCapStyle ?? sd.capStyle,
            ),
          false,
          sd.joinStyle === JOIN_ARCS,
          false,
          false,
          null,
          false,
          false,
          false,
          sd.strokeFrame || null,
          zeroLengthStroke(sd, !walkCtx || walkCtx.compat !== 'chrome'),
          dashedStroke(sd),
        );
        ctx.segTypeMask |= sm.typeMask;
        ctx.totalSegments += sm.numSegments | 0;
        let flagsShape = FLAG_LAYER;
        if (sd.flagsShape & 2) flagsShape |= 2; // dash bit
        if (sd.flagsShape & 1) flagsShape |= 1; // non-scaling stroke
        if (sd.strokeFrame) flagsShape |= FS_STROKE_LOCAL; // drawn in stroke space
        if (sm.dashSeam) flagsShape |= FS_DASH_SEAM; // a closed dashed contour carries its length at its seam
        if (shapeToFirstMeta[i] < 0) shapeToFirstMeta[i] = ctx.metas.length;
        if (!sd._patternOwner) {
          if (firstMeta < 0) firstMeta = ctx.metas.length;
          lastMeta = ctx.metas.length;
        }
        ctx.metas.push({
          shapeId: sd.shapeId ? `${sd.shapeId}_stroke` : synthId(sd, ctx.metas.length, 'stroke'),
          _curveStartF: _layerStrokeStart,
          _curveEndF: sm.curveEndF ?? ctx.curveBuf.count * 4,
          bbox: [bbox2[0], bbox2[1], bbox2[2], bbox2[3]],
          fillColor: [0, 0, 0, 0],
          strokeColor: sd.strokeRgba,
          strokeWidth: sd.sw,
          fillRule: sd.fillRule,
          accumGroupId: 0,
          glyphLoc: sm.glyphLoc,
          bandMaxX: sm.bandMaxX,
          bandMaxY: sm.bandMaxY,
          _solid_float_start: 0,
          _solid_float_count: 0,
          _cgeom_byte_off: 0,
          _cgeom_byte_len: 0,
          capStyle: sd.capStyle,
          joinStyle: sd.joinStyle,
          miterLimit: metaMiterLimit(sd, sm),
          _authoredMiterLimit: Math.max(1, sd.miterLimit || 4),
          flagsShape,
          strokeFrame: sd.strokeFrame || null,
          fillGradId: 0,
          strokeGradId: sd.strokeGradId || 0,
          strokeImageId: sd.strokeImageId || 0,
          // Nested clipPath support — see fill row above.
          clipId: sd.clipId || 0,
          maskId: sd.maskId || 0,
          filterId: 0,
          blendMode: retainGroups ? sd.blendMode || 0 : 0,
          isolation: 0,
        });
      }
      if (shapeToFirstMeta[i] >= 0) shapeToLastMeta[i] = ctx.metas.length - 1;
    }
    return { firstMeta, lastMeta };
  }

  function emitEmptyLayer() {
    const bbox = [0, 0, 1, 1];
    const start = ctx.curveBuf.count * 4;
    const mesh = buildTexturesShape(
      [],
      1,
      1,
      bbox,
      ctx.curveBuf,
      ctx.bandBuf,
      0,
      false,
      false,
      false,
    );
    const row = ctx.metas.length;
    ctx.metas.push({
      bbox,
      fillColor: [0, 0, 0, 0],
      strokeColor: [0, 0, 0, 0],
      strokeWidth: 0,
      glyphLoc: mesh.glyphLoc,
      bandMaxX: mesh.bandMaxX,
      bandMaxY: mesh.bandMaxY,
      _curveStartF: start,
      _curveEndF: ctx.curveBuf.count * 4,
      flagsShape: FLAG_LAYER,
      capStyle: CAP_BUTT,
      joinStyle: JOIN_MITER,
      miterLimit: 4,
    });
    return { firstMeta: row, lastMeta: row };
  }

  /// A basic-shape clip-path claim (importWalk normClip, combineClipRefs): the shape resolved against its reference box, as clip
  /// content. The box is the CARRIER's, in the carrier's user space (the space its recorded CTM maps to the document): fill-box is
  /// the union of the shapes walked under the carrier, stroke-box adds their strokes (strokeBox.js, from each shape's own
  /// segments), view-box the nearest viewport. The outline is a <path> in a fresh clipPath, walked through the carrier's CTM, so the
  /// clip follows the carrier's transform exactly.
  ///
  /// An element can be clipped by several layers at once (its own basic shape, an ancestor's, a url() clip): the innermost layer is
  /// the content of the clip built here and every outer layer is a clip on a wrapper <g> around it, which the shader's nested clip
  /// ANDs (the same shape as importWalk's combineClipRefs). An outer basic shape lives in ITS carrier's space, so it is registered as
  /// a placed userSpaceOnUse def with that carrier's CTM. Returns { element, ctm } or null when there is nothing to build.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const _genBasicIds = new Map();
  /// The box of a layer's carrier in its own user space: the union of the boxes of the shapes walked under it. `kind` 'fill' is the
  /// object bounding box, 'stroke' adds the strokes, 'view' is the nearest viewport.
  const layerBox = (layer, refCtm, inv, kind, vb) => {
    const members = (walkCtx.clipInstMembers && walkCtx.clipInstMembers.get(layer.inst)) || [];
    let box = null;
    const add = (b) => {
      if (!b || !Number.isFinite(b[0] + b[1] + b[2] + b[3])) return;
      box = box
        ? [
            Math.min(box[0], b[0]),
            Math.min(box[1], b[1]),
            Math.max(box[2], b[2]),
            Math.max(box[3], b[3]),
          ]
        : b.slice();
    };
    if (kind === 'view') add([0, 0, vb[0], vb[1]]);
    else
      for (const sd of members) {
        const own = !!refCtm && sd._obbCtm === refCtm;
        let fill;
        if (own && sd._obbBox) fill = sd._obbBox;
        else {
          const sc = [];
          for (const sg of sd.segs) transformSegInto(sg, inv, sc);
          fill = pathBbox(sc);
        }
        if (kind === 'stroke' && sd._strokeLocal && sd._obbCtm) {
          const M = own ? IDENT : matMul(inv, sd._obbCtm);
          add(
            strokeBoxOf(
              sd._strokeLocal.segs,
              {
                halfW: sd._strokeLocal.halfW,
                joinStyle: sd.joinStyle,
                miterLimit: sd.miterLimit,
                capStyle: sd.capStyle,
                endCapStyle: sd.endCapStyle,
              },
              M,
            ),
          );
        } else add(fill);
      }
    return box;
  };
  /// What a layer clips with: { shape: { d, rule, origin }, ctm } for a basic shape (a path in the carrier's user space), or
  /// { content: <clipPath element>, ctm } for a clipPath def placed in document space; null when it cannot be built.
  const layerInfo = (layer) => {
    if (layer.ref) {
      const id = resolveIdRef(layer.ref),
        def = id && walkCtx.clipDefs[id];
      if (!def || !def.element || def.units === 'objectBoundingBox') return null;
      return { content: def.element, ctm: def.ctm || IDENT, ref: layer.ref };
    }
    const refCtm = layer.inst > 0 && _clipInstCtm ? _clipInstCtm.get(layer.inst) : null;
    const inv = refCtm ? _obbInv(refCtm) : IDENT;
    if (!inv) return null;
    if (layer.obb) {
      // an objectBoundingBox clipPath: its content in the unit square of the carrier's fill box (SVG 1.1 §7.11)
      const def = walkCtx.clipDefs[layer.obb];
      const box = def && def.element && layerBox(layer, refCtm, inv, 'fill');
      if (!box || !(box[2] > box[0] && box[3] > box[1])) return null;
      return {
        content: def.element,
        ctm: matMul(refCtm || IDENT, [box[2] - box[0], 0, 0, box[3] - box[1], box[0], box[1]]),
      };
    }
    const bs = layer.basic;
    const box = layerBox(layer, refCtm, inv, boxKindOf(bs.spec, bs.compat), bs.vb);
    if (!box) return null;
    const res = shapeToPath(
      bs.spec,
      { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] },
      bs.fc,
    );
    if (!res) mantleWarn('clip-path: a basic shape with an invalid number is clipped to nothing.');
    return { shape: res || { d: '', rule: 'nonzero' }, ctm: refCtm || IDENT };
  };
  const shapePathEl = (doc, res) => {
    if (!res.d) return null;
    const pe = doc.createElementNS(SVG_NS, 'path');
    pe.setAttribute('d', res.d);
    pe.setAttribute('clip-rule', res.rule);
    if (res.origin) pe.setAttribute('transform', `translate(${res.origin[0]} ${res.origin[1]})`);
    return pe;
  };
  /// The clip a claim of a basic-shape def, or of a combination of clips that involves one or an objectBoundingBox clipPath
  /// (importWalk combineClipRefs, a list of LAYERS, outermost first), resolves to once the carriers' boxes are known. The innermost
  /// layer is the content of the clip built here, every outer layer a clip on a wrapper <g> around it, which the shader's nested clip
  /// ANDs (the shape importWalk's combineClipRefs gives a plain intersection). Each layer lives in ITS carrier's space, so an outer
  /// layer is registered as a placed userSpaceOnUse def with that carrier's CTM. Returns { element, ctm } or null.
  ///
  /// A basic shape resolves against its carrier's reference box in the carrier's user space: fill-box is the union of the shapes
  /// walked under the carrier, stroke-box adds their strokes (strokeBox.js, from each shape's own segments), view-box is the nearest
  /// viewport. The outline is a <path> in a fresh clipPath, walked through the carrier's CTM, so the clip follows the carrier's
  /// transform exactly.
  const basicShapeFrame = (clip, i) => {
    const layers = clip.layers || [
      { basic: clip.basicShape, inst: ctx.clipInstances ? ctx.clipInstances[i] | 0 : 0 },
    ];
    const doc = clip.element.ownerDocument;
    const el = doc.createElementNS(SVG_NS, 'clipPath');
    el.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const base = layerInfo(layers[layers.length - 1]);
    if (!base) return null;
    let host = el;
    for (let k = 0; k < layers.length - 1; k++) {
      const lo = layerInfo(layers[k]);
      if (!lo) return null;
      let ref = lo.ref || null;
      if (!ref) {
        const gp = lo.shape ? shapePathEl(doc, lo.shape) : null;
        const key = lo.shape
          ? `${lo.shape.d}|${lo.shape.rule}|${lo.shape.origin || ''}|${lo.ctm.join(',')}`
          : `${layers[k].obb}|${lo.ctm.join(',')}`;
        let id = _genBasicIds.get(key);
        if (!id) {
          id = `__mantleBasicLayer${_genBasicIds.size}`;
          let ge = lo.content;
          if (lo.shape) {
            ge = doc.createElementNS(SVG_NS, 'clipPath');
            ge.setAttribute('clipPathUnits', 'userSpaceOnUse');
            if (gp) ge.appendChild(gp);
          }
          walkCtx.clipDefs[id] = {
            element: ge,
            units: 'userSpaceOnUse',
            maskType: 'luminance',
            ctm: lo.ctm,
            placed: true,
          };
          _genBasicIds.set(key, id);
        }
        ref = `url(#${id})`;
      }
      const g = doc.createElementNS(SVG_NS, 'g');
      g.setAttribute('clip-path', ref);
      g.setAttribute('data-mantle-clip-placed', '1');
      g.setAttribute('data-mantle-clip-wrap', '1');
      host.appendChild(g);
      host = g;
    }
    if (base.shape) {
      const pe = shapePathEl(doc, base.shape);
      if (pe) host.appendChild(pe);
    } else {
      if (base.content.getAttribute('transform'))
        el.setAttribute('transform', base.content.getAttribute('transform'));
      // the authored children, under their authored parents (svg/utils.js elementChildren)
      host._mantleKids = elementChildren(base.content);
      el._mantleInheritFrom = base.content._mantleInheritFrom || base.content;
    }
    return { element: el, ctm: base.ctm };
  };
  let processedClips = clipBegin;
  let processedMasks = maskBegin;
  // From here the walk runs for clip and mask content, which the sprite allow-list does not filter (importWalk.js enqueueShape).
  if (walkCtx) walkCtx._finalizing = true;
  while (processedClips < ctx.clipsUsed.length || processedMasks < ctx.masksUsed.length) {
    for (let ci = processedClips; ci < ctx.clipsUsed.length; ci++) {
      const clip = ctx.clipsUsed[ci];
      if (!clip.element) continue;
      // userSpaceOnUse: the CTM of the element that referenced it (importWalk.js placeDefRef), so the rows land in
      // document space where the shader samples them; the identity for a reference made at the identity.
      let ctm = clip.ctm || IDENT;
      if ((clip.basicShape || clip.layers) && ctx.clipBindings[ci] >= 0) {
        const fr = basicShapeFrame(clip, ci);
        clip.element = fr
          ? fr.element
          : clip.element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clip.units = 'userSpaceOnUse';
        ctm = fr ? fr.ctm : IDENT;
      } else if (ctx.clipBindings[ci] >= 0) {
        const obb = _obbCtm(ctx.clipBindings, ctx.clipInstances, _clipInstCtm, ci);
        if (obb) ctm = obb;
      }
      ctm = matMul(ctm, parseTransform(clip.element.getAttribute('transform') || ''));
      const startShapes = ctx.shapesData.length;
      const savedLayer = walkCtx.walkLayerMode;
      walkCtx.walkLayerMode = true;
      walkCtx.inClipContent = (walkCtx.inClipContent | 0) + 1; // its shapes wind by clip-rule
      try {
        // ClipPath content's inheritance parents are the <clipPath> and its own ancestors.
        walkCtx.walkDefContent(
          clip.element,
          elementChildren(clip.element),
          ctm,
          clip.units === 'objectBoundingBox'
            ? { parentWidth: 1, parentHeight: 1 }
            : clip.viewport || walkCtx.viewport,
        );
      } finally {
        walkCtx.walkLayerMode = savedLayer;
        walkCtx.inClipContent--;
      }
      applyMaskRegions(startShapes);
      let { firstMeta, lastMeta } = emitMetaSuffix(startShapes);
      if (firstMeta < 0) ({ firstMeta, lastMeta } = emitEmptyLayer());
      // A def that intersects an entry already claimed for another shape (importWalk.js nestClipDef): each of its
      // rows is cut by that entry, as a row's own clip-path cuts it. The id is the 1-based registry index, rewritten to a
      // meta row below with every other clipId.
      if (firstMeta >= 0 && clip.innerClipId > 0) {
        for (let r = firstMeta; r <= lastMeta; r++)
          if (!ctx.metas[r].clipId) ctx.metas[r].clipId = clip.innerClipId;
      }
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
          ctx.metas[lastMeta].flagsShape = (ctx.metas[lastMeta].flagsShape || 0) | (1 << 12);
        }
      }
    }
    processedClips = ctx.clipsUsed.length;

    for (let mi = processedMasks; mi < ctx.masksUsed.length; mi++) {
      const mask = ctx.masksUsed[mi];
      if (!mask.element) continue;
      const vp = mask.viewport;
      const region =
        mask.region &&
        (vp ? maskRegionOf(mask.element, [vp.parentWidth, vp.parentHeight]) : mask.region);
      if (region && (region.w <= 0 || region.h <= 0)) mask.emptyRegion = true;
      let ctm = mask.ctm || IDENT; // as for clips above
      if (ctx.maskBindings[mi] >= 0) {
        const obb = _obbCtm(ctx.maskBindings, ctx.maskInstances, _maskInstCtm, mi);
        if (obb) ctm = obb;
      }
      const startShapes = ctx.shapesData.length;
      const savedLayer = walkCtx.walkLayerMode;
      walkCtx.walkLayerMode = true;
      const savedGroups = walkCtx.retainLayerGroups;
      walkCtx.retainLayerGroups = true;
      try {
        // Mask content's inheritance parents are the <mask> and its own ancestors.
        if (!mask.emptyRegion)
          walkCtx.walkDefContent(
            mask.element,
            elementChildren(mask.element),
            ctm,
            mask.units === 'objectBoundingBox'
              ? { parentWidth: 1, parentHeight: 1 }
              : mask.viewport || walkCtx.viewport,
          );
      } finally {
        walkCtx.walkLayerMode = savedLayer;
        walkCtx.retainLayerGroups = savedGroups;
      }
      applyMaskRegions(startShapes);
      let { firstMeta, lastMeta } = emitMetaSuffix(startShapes, true);
      if (firstMeta < 0) ({ firstMeta, lastMeta } = emitEmptyLayer());
      // A mask entry made for a shape whose clip nests (applyMaskRegions): its content is cut to the region.
      if (mask.regionCorners && firstMeta >= 0) {
        for (let r = firstMeta; r <= lastMeta; r++) {
          const m = ctx.metas[r];
          if ((m.flagsShape || 0) & (FS_GROUP_BEGIN | FS_GROUP_END)) continue;
          const own = m.clipId | 0;
          if (own > 0 && _clipNests(ctx.clipsUsed[own - 1])) {
            if (!maskRegionSkipWarned) {
              maskRegionSkipWarned = true;
              mantleWarn(
                'mask: a mask whose content has a nested clip-path is not cut to the mask region of an element ' +
                  'whose own clip nests (the shader evaluates two clip levels); ink outside the region may show.',
              );
            }
            continue;
          }
          const id = _regionClipFor(
            mask.element,
            mask.regionCorners,
            mask.regionInst,
            own,
            rowRegionClipMemo,
          );
          if (id !== undefined) m.clipId = id;
        }
      }
      const childMaskId = mi + 1;
      const isLuminance = mask.maskType !== 'alpha' ? 1 : 0;
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
        for (let i = metaBegin; i < ctx.metas.length; i++) {
          if (i === firstMeta) continue;
          const om = ctx.metas[i];
          if (((om.flagsShape || 0) & FLAG_LAYER) === 0) continue;
          if (om.maskId === childMaskId) {
            referencedByMaskChild = true;
            break;
          }
        }
        const needsRT =
          !!(m.atlasSlot && m.atlasSlot[3] === 2) ||
          (m.fillGradId || 0) > 0 ||
          (m.strokeGradId || 0) > 0 ||
          (m.imageId || 0) > 0 ||
          (m.strokeWidth || 0) > 0 ||
          ((m.maskId || 0) > 0 && m.maskId !== childMaskId) ||
          referencedByMaskChild;
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
  // Layer rows (FLAG_LAYER set) get the same rewrite when they carry a
  // clipId — that's the "nested clipPath" case: a clip-child has its
  // own clip-path attribute, so its meta texel 7.z must point at the
  // nested clip's first meta row, not the now-stale registry index.
  // The shader's nested-clip eval (mantle.frag.glsl)
  // reads texel 7.z on each clip child and AND-multiplies the nested
  // clip's union coverage into the child's coverage.

  for (const m of ctx.metas.slice(metaBegin)) {
    if (m.clipId > 0 && m.clipId <= clipMetaRow.length) m.clipId = clipMetaRow[m.clipId - 1];
    if (m.maskId > 0 && m.maskId <= maskMetaRow.length) m.maskId = maskMetaRow[m.maskId - 1];
  }

  const clipperRowSets = Object.create(null);
  const addPlacedRows = (id, first, last) => {
    if (!id || !(first > 0)) return;
    const rows = [];
    for (let row = first - 1; row < last; row++)
      if (((ctx.metas[row].flagsShape || 0) & (64 | 128)) === 0) rows.push(row);
    (clipperRowSets[id] || (clipperRowSets[id] = [])).push(rows);
  };
  for (let i = 0; i < clipMetaRow.length; i++)
    addPlacedRows((ctx.clipSvgIds || [])[i], clipMetaRow[i], clipMetaLastRow[i] || clipMetaRow[i]);
  for (let i = 0; i < maskMetaRow.length; i++)
    addPlacedRows((ctx.maskSvgIds || [])[i], maskMetaRow[i], maskMetaLastRow[i] || maskMetaRow[i]);

  // Global bbox = path-tight bounds across all shapes. The bundle
  // ALSO records the SVG viewBox (next to the path-tight bbox) so the
  // renderer can switch reference frames at runtime. Storing both is
  // essentially free (16 bytes) and keeps the binary the source of truth.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const m of ctx.metas) {
    // Not a layer row, a row kept hidden (it draws nothing), or group scaffolding, whose box is its members' or none at all.
    if (m.flagsShape & (FLAG_LAYER | FS_HIDDEN | FS_GROUP_BEGIN | FS_GROUP_END)) continue;
    const gb = m.inkBBox || m.bbox; // a stroke's ink box when its tips or caps leave the row's bbox
    minX = Math.min(minX, gb[0]);
    minY = Math.min(minY, gb[1]);
    maxX = Math.max(maxX, gb[2]);
    maxY = Math.max(maxY, gb[3]);
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
    const views = root.getElementsByTagName('*');
    for (let i = 0; i < views.length; i++) {
      if (svgElementName(views[i]) === 'view' && views[i].getAttribute('id') === opts.viewName) {
        vbSourceEl = views[i];
        break;
      }
    }
  }
  // Extract the viewBox if present. (0,0,0,0) signals "absent" to
  // the renderer. Stored as (xmin, ymin, w, h) to match globalBBox
  // and the shader's uGlobalBBox.
  const originX = opts._origin ? opts._origin[0] : 0,
    originY = opts._origin ? opts._origin[1] : 0;
  let vbMinX = 0,
    vbMinY = 0,
    vbW = 0,
    vbH = 0;
  const vbAttr = vbSourceEl.getAttribute('viewBox');
  if (vbAttr) {
    const parts = vbAttr
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      parts.length === 4 &&
      parts.every((v) => Number.isFinite(v)) &&
      parts[2] > 0 &&
      parts[3] > 0
    ) {
      vbMinX = parts[0] - originX; // the walk's coordinates are relative to the bundle origin; so is the stored box
      vbMinY = parts[1] - originY;
      vbW = parts[2];
      vbH = parts[3];
    }
  }
  // SVG preserveAspectRatio. Default per spec is "xMidYMid meet"
  // → (1, 1, 0). Encoded as (alignX, alignY, meetOrSlice):
  //   alignX/Y: -1=none, 0=Min, 1=Mid, 2=Max
  //   meetOrSlice: 0=meet, 1=slice
  let parAx = 1,
    parAy = 1,
    parMs = 0;
  const parAttr = (vbSourceEl.getAttribute('preserveAspectRatio') || '').trim();
  if (parAttr) {
    const parts = parAttr.split(/\s+/);
    const align = (parts[0] || '').toLowerCase();
    if (align === 'none') {
      parAx = -1;
      parAy = -1;
    } else {
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
    minX = vbMinX;
    minY = vbMinY;
    maxX = vbMinX + vbW;
    maxY = vbMinY + vbH;
  } else if (vbW > 0 && vbH > 0 && Number.isFinite(minX)) {
    // Tight (default) mode: re-aggregate the path-tight bounds with each shape
    // CLAMPED to the viewBox. SVG clips content to the viewport (overflow:hidden
    // by default), so geometry extending OUTSIDE the viewBox is invisible and
    // must NOT expand the bundle's bounds. Without this, one off-canvas shape
    // (e.g. a clipped / rotated stripe that overhangs the viewBox) blows up
    // globalBBox, which mis-fits the whole bundle under an identity worldMatrix
    // and drops on-canvas siblings off-screen (the clip was incidental;
    // the trigger is the overhang past the viewBox). Per-shape (not
    // union-then-clamp) so a far overhang contributes
    // only its in-viewBox part. In-viewBox content is unaffected — tight stays
    // tight (⊆ viewBox).
    const vbMaxX = vbMinX + vbW,
      vbMaxY = vbMinY + vbH;
    let nx = Infinity,
      ny = Infinity,
      xx = -Infinity,
      xy = -Infinity;
    for (const m of ctx.metas) {
      if (m.flagsShape & (FLAG_LAYER | FS_HIDDEN)) continue;
      const gb = m.inkBBox || m.bbox;
      const bx0 = Math.max(gb[0], vbMinX),
        by0 = Math.max(gb[1], vbMinY);
      const bx1 = Math.min(gb[2], vbMaxX),
        by1 = Math.min(gb[3], vbMaxY);
      if (bx1 <= bx0 || by1 <= by0) continue; // shape lies entirely outside the viewBox
      if (bx0 < nx) nx = bx0;
      if (by0 < ny) ny = by0;
      if (bx1 > xx) xx = bx1;
      if (by1 > xy) xy = by1;
    }
    if (Number.isFinite(nx) && xx > nx && xy > ny) {
      minX = nx;
      minY = ny;
      maxX = xx;
      maxY = xy;
    } else {
      // All content lies outside the viewBox → fall back to the viewBox itself.
      minX = vbMinX;
      minY = vbMinY;
      maxX = vbMaxX;
      maxY = vbMaxY;
    }
  }
  // Bundle stores (minX, minY, width, height). Matches the shader's
  // uGlobalBBox convention (.xy = origin, .zw = extent) and is the
  // single format shared with textRun's output.
  // No ink (every shape dropped or culled): the empty bundle's [0, 0, 0, 0], as the no-shape return of importSvg gives, never
  // [Infinity, Infinity, -Infinity, -Infinity] (which JSON-serializes to nulls and fits nothing).
  if (!(maxX >= minX && maxY >= minY && Number.isFinite(minX + minY + maxX + maxY))) {
    minX = minY = maxX = maxY = 0;
  }
  const gw = maxX - minX,
    gh = maxY - minY;
  // What the import dropped for being marked as not drawn (dropped.js): reported on the bundle, and warned about once.
  const _dropped = opts._hitPass || opts.ctx ? null : droppedReportOf(ctx.dropped);
  if (_dropped) warnDropped(_dropped, opts);

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
  const pendingOcc = []; // async grids: {base, G, segs, bbox, evenOdd}
  for (const m of ctx.metas) {
    if (m.patInvLinear) continue;
    if (m._occGrid) {
      // SYNC: real bits packed in-buffer now
      const { bits, G } = m._occGrid;
      const base = ctx.curveBuf.count; // texel index of first cell-texel
      for (let i = 0; i < bits.length; i += 4)
        texelAppend(
          ctx.curveBuf,
          bits[i] || 0,
          bits[i + 1] || 0,
          bits[i + 2] || 0,
          bits[i + 3] || 0,
        );
      m._solid_float_start = base; // baseTexelIdx (texel 5 .x)
      m._solid_float_count = G; // grid dim G (texel 5 .y)
      anyOccupancy = true;
    } else if (m._occPending) {
      // ASYNC: reserve G²/4 zeroed texels; fill later
      const G = _occG,
        base = ctx.curveBuf.count,
        nTexels = Math.ceil((G * G) / 4);
      for (let i = 0; i < nTexels; i++) texelAppend(ctx.curveBuf, 0, 0, 0, 0);
      m._solid_float_start = base;
      m._solid_float_count = G; // descriptor valid, but cells zero → dormant until filled
      pendingOcc.push({
        base,
        G,
        segs: m._occPending.segs,
        bbox: m._occPending.bbox,
        evenOdd: m._occPending.evenOdd,
      });
    }
  }

  // Curve + band textures populated by buildTexturesShape for strokes.
  const curvesB = texelToBytes(ctx.curveBuf);
  const bandsB = texelToBytes(ctx.bandBuf);
  const solidB = new Uint8Array(0);

  // Cover-quad bytes.
  const cgeomB = new Uint8Array(new Float32Array(ctx.hybridFloats).buffer);
  // Wide band headers (plain-float counts + offsets) are the only
  // supported mode. The flag bit is still set on emit so consumers that
  // check it see the expected layout; readers may also ignore it.
  const flags =
    BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM |
    BUNDLE_FLAG_HYBRID_MESH_CHUNKED |
    BUNDLE_FLAG_WIDE_BAND_HEADERS |
    (ctx.pairBands === true ? BUNDLE_FLAG_PAIR_BANDS : 0) |
    (ctx.vBands === false ? BUNDLE_FLAG_NO_VBANDS : 0);

  prepareFilterOwnerGradients(ctx, walkCtx?.gradientDefinition, (frame) => {
    const inverse = _obbInv(frame.ctm);
    return inverse ? _obbOwnBox([frame.shapeIdx], frame.ctm, inverse) : null;
  });

  // Gradient section: records + stops LUT. Empty if no gradients used.
  // Gradients use an exact-stop LUT; record slots 10/11 point into the LUT.
  let gradientsB = new Uint8Array(0),
    stopsB = new Uint8Array(0);
  let gradientStopsCount = 0;
  if (ctx.gradientsUsed.length) {
    const gt = buildGradientTables(ctx.gradientsUsed, !!ctx.curveBuf.docOrigin);
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
      if (!strokeRowOf(sd)) continue;
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
      for (let k = 0; k < Math.min(sd.dashArray.length, DASH_TEX_WIDTH * 4 - 4); k++)
        row[4 + k] = sd.dashArray[k];
      dashRows.push(row);
      ctx.metas[strokeRow].dashId = nextDashId++;
    }
    if (dashRows.length) {
      const total = new Float32Array(DASH_TEX_WIDTH * 4 * dashRows.length);
      for (let r = 0; r < dashRows.length; r++) total.set(dashRows[r], r * DASH_TEX_WIDTH * 4);
      dashesB = new Uint8Array(total.buffer);
    }
  }

  // Meta blob is built AFTER dashId is assigned on stroke ctx.metas above.
  const metaHdr = new ArrayBuffer(32);
  const mdv = new DataView(metaHdr);
  mdv.setUint32(0, ctx.metas.length, true);
  stampMetaHeader(
    mdv,
    opts._origin,
    ctx.metas.some((m) => (m.flagsShape & FS_HIDDEN) !== 0),
  );
  mdv.setFloat32(4, minX, true);
  mdv.setFloat32(8, minY, true);
  mdv.setFloat32(12, gw, true);
  mdv.setFloat32(16, gh, true);

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

  // A filter inherited from a <g> clips at the GROUP's box: the region is a fraction of the union of the shapes
  // that claim the same group instance, which only exists now that every shape has a bbox. Resolve it to a
  // root-space rect, the space a userSpaceOnUse region already resolves to. shapeBbRaw (geometry, no stroke) is
  // the box the spec means, the same one objectBoundingBox clips and masks bind to.
  //
  // ...AND THE FRACTIONS ARE OF THE GROUP'S BOX IN THE GROUP'S own USER SPACE. Filter Effects 1 §8:
  // "If filterUnits is equal to objectBoundingBox, then x, y, width, height represent fractions or percentages
  // of the bounding box on the referencing element", and SVG 1.1 §7.11 puts that bounding box in the referencing
  // element's own user coordinate system with its own transform excluded. §5: "The filter operations are applied
  // in the element's local coordinate system." So the region is a rect in the GROUP's space, and on the canvas
  // it is that rect through the group's CTM -- a turned or skewed rect under a non-diagonal carrier, not an
  // axis-aligned fraction of the document-space AABB, which is both offset and the wrong size.
  //
  // WHAT IS STORED. §8 says "The bounds of this rectangle act as a hard clipping region for each filter primitive". The scissor is axis-aligned
  // by construction, so regionUse holds the AABB of the turned rect, and its corners ride along (regionUse.quad): the OUTPUT is clipped to the
  // quad when it composites (renderer/filterDraw.js _compositeFilteredTex). What remains: a primitive's own result is clipped to the AABB, not the
  // quad, so a blur reading past the quad's edge inside that box sees it; and running the graph in the element's local space, so a non-uniform
  // carrier scales the blur with it, needs a render target that turns with the element.
  let _warnedObbEmpty = false;
  const _filterInstCtm = walkCtx && walkCtx.filterInstCtm;
  for (let fi = 0; fi < ctx.filtersUsed.length; fi++) {
    const fEnt = ctx.filtersUsed[fi],
      gr = fEnt && fEnt.groupRegion;
    if (!gr) continue;
    const inst = ctx.filterInstances[fi] | 0;
    const claimers = (ctx.filterInstShapes && ctx.filterInstShapes.get(inst)) || [
      ctx.filterBindings[fi] | 0,
    ];
    const carrier = inst > 0 && _filterInstCtm ? _filterInstCtm.get(inst) : null;
    // A positive diagonal keeps the document-AABB arithmetic, an exact test rather than a tolerance, so no
    // region that it already gets right moves by a rounding.
    const turned =
      carrier && !(carrier[1] === 0 && carrier[2] === 0 && carrier[0] > 0 && carrier[3] > 0)
        ? _obbInv(carrier)
        : null;
    if (turned) {
      const own = _obbOwnBox(claimers, carrier, turned);
      const sup = _obbUnitBox(own);
      if (!sup) {
        fEnt.regionUse = null;
        continue;
      }
      // The fractional rect lives in the unit square the supplemental matrix maps onto the group's own box, so
      // map its corners through carrier x supplemental and take the bound.
      const M = matMul(carrier, sup);
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const [ux, uy] of [
        [gr.x, gr.y],
        [gr.x + gr.w, gr.y],
        [gr.x, gr.y + gr.h],
        [gr.x + gr.w, gr.y + gr.h],
      ]) {
        const [qx, qy] = matApply(M, ux, uy);
        if (qx < x0) x0 = qx;
        if (qy < y0) y0 = qy;
        if (qx > x1) x1 = qx;
        if (qy > y1) y1 = qy;
      }
      fEnt.regionUse = [x0, y0, x1 - x0, y1 - y0, 1];
      fEnt.regionUse.quad = [
        [gr.x, gr.y],
        [gr.x + gr.w, gr.y],
        [gr.x + gr.w, gr.y + gr.h],
        [gr.x, gr.y + gr.h],
      ].flatMap(([ux, uy]) => matApply(M, ux, uy));
      continue;
    }
    let bb = null;
    for (const si of claimers) {
      const sb = shapeBbRaw[si];
      if (!sb || !(sb[2] > sb[0]) || !(sb[3] > sb[1])) continue;
      bb = bb
        ? [
            Math.min(bb[0], sb[0]),
            Math.min(bb[1], sb[1]),
            Math.max(bb[2], sb[2]),
            Math.max(bb[3], sb[3]),
          ]
        : sb.slice();
    }
    if (!bb) {
      fEnt.regionUse = null;
      continue;
    }
    const gw = bb[2] - bb[0],
      gh = bb[3] - bb[1];
    fEnt.regionUse = [bb[0] + gr.x * gw, bb[1] + gr.y * gh, gr.w * gw, gr.h * gh, 1];
    // The fractions and the rows they were taken against: a morph re-resolves the region against its members' lerped boxes (filterRegionObb).
    fEnt.regionObb = [
      gr.x,
      gr.y,
      gr.w,
      gr.h,
      claimers.filter((si) => {
        const sb = shapeBbRaw[si];
        return sb && sb[2] > sb[0] && sb[3] > sb[1];
      }),
    ];
  }
  // ...AND A SHAPE'S own objectBoundingBox REGION, UNDER THE same RULE. Same spec sentences, one shape
  // wide: the fractions are of the shape's box in its own user space, so the region on the canvas is that rect
  // through the shape's CTM. Stored as space 0, renderer/filterDraw.js `_filterRegionRectPx` resolves it at draw
  // time against `_rowBoxEm` -- the meta row's DOCUMENT-space box, which for a turned shape is the AABB of the
  // turned geometry and therefore the wrong rect. The walker marks only the turned shapes (importWalk.js's
  // `ownTurned`, an exact positive-diagonal test, minting one entry each so two shapes sharing one filter under
  // different CTMs do not share a region), and they resolve to a root-space rect here instead, exactly as the
  // group branch above does. Everything else keeps the late resolve, which is what lets a morph re-resolve the
  // region against the lerped row.

  for (let fi = 0; fi < ctx.filtersUsed.length; fi++) {
    const fEnt = ctx.filtersUsed[fi];
    if (!fEnt || fEnt.groupRegion || !Number.isFinite(fEnt.ownRegionShape)) continue;
    const rg = fEnt.regionUse;
    if (!rg || (rg[4] | 0) !== 0) continue;
    const sd = ctx.shapesData[fEnt.ownRegionShape | 0];
    const M = sd ? _obbGradSup(sd, false) : null; // null when the document-AABB arithmetic already IS this matrix
    if (!M) continue;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [ux, uy] of [
      [rg[0], rg[1]],
      [rg[0] + rg[2], rg[1]],
      [rg[0], rg[1] + rg[3]],
      [rg[0] + rg[2], rg[1] + rg[3]],
    ]) {
      const [qx, qy] = matApply(M, ux, uy);
      if (qx < x0) x0 = qx;
      if (qy < y0) y0 = qy;
      if (qx > x1) x1 = qx;
      if (qy > y1) y1 = qy;
    }
    fEnt.regionUse = x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0, 1] : null;
    if (fEnt.regionUse)
      fEnt.regionUse.quad = [
        [rg[0], rg[1]],
        [rg[0] + rg[2], rg[1]],
        [rg[0] + rg[2], rg[1] + rg[3]],
        [rg[0], rg[1] + rg[3]],
      ].flatMap(([ux, uy]) => matApply(M, ux, uy));
  }
  // PRIMITIVE UNITS = objectBoundingBox (Filter Effects 1 §15.7): the numbers of a filter's primitives (and the x / y / width / height of
  // their subregions) are fractions of the referencing element's box in its own user space. An entry minted for one shape or one group
  // instance (importWalk claimFilter: obbBox) now turns them into user units against that box, the form every later stage reads.
  for (let fi = 0; fi < ctx.filtersUsed.length; fi++) {
    const fEnt = ctx.filtersUsed[fi];
    if (!fEnt || !fEnt.obbBox || !fEnt.graph || !fEnt.graph.obb) continue;
    const inst = ctx.filterInstances[fi] | 0;
    const claimers =
      fEnt.obbClaimers ||
      (inst > 0
        ? (ctx.filterInstShapes && ctx.filterInstShapes.get(inst)) || [ctx.filterBindings[fi] | 0]
        : [ctx.filterBindings[fi] | 0]);
    const carrier = inst > 0 ? (_filterInstCtm ? _filterInstCtm.get(inst) : null) : fEnt.obbCtm;
    const inv = carrier ? _obbInv(carrier) : null;
    let box = null;
    if (inv) box = _obbOwnBox(claimers, carrier, inv);
    else {
      for (const si of claimers) {
        const sb = rawBbOf(ctx.shapesData[si]);
        if (!sb || !(sb[2] > sb[0] && sb[3] > sb[1])) continue;
        box = box
          ? [
              Math.min(box[0], sb[0]),
              Math.min(box[1], sb[1]),
              Math.max(box[2], sb[2]),
              Math.max(box[3], sb[3]),
            ]
          : sb.slice();
      }
    }
    if (box && box[2] > box[0] && box[3] > box[1]) fEnt.graph = resolveObbGraph(fEnt.graph, box);
    else {
      // No box to take fractions of (an empty box): Filter Effects 1 §15.7 leaves the primitive in error. The numbers stay as written, said once.
      if (!_warnedObbEmpty) {
        _warnedObbEmpty = true;
        mantleWarn(
          'bundle exporter: primitiveUnits="objectBoundingBox" on an element with an empty bounding box; the primitives keep their numbers as written.',
        );
      }
      const g = {
        ...fEnt.graph,
        nodes: fEnt.graph.nodes.map((n) => {
          if (!n.params || !n.params.obb) return n;
          const { obb, ...rest } = n.params;
          return { ...n, params: rest };
        }),
      };
      delete g.obb;
      fEnt.graph = g;
    }
  }
  const {
    filtersB,
    filterGraphsArr,
    filterRegionsArr,
    filterRegionObbArr,
    filterRegionQuadsArr,
    filterPrimCtmsArr,
    kernelTab,
  } = buildFilterSections(ctx.filtersUsed, ctx.curveBuf.docOrigin);
  // Image atlas: vertically stack the per-<image> RGBA8 buffers into one
  // 2D texture. Atlas width = max image width (clamped to opts.imageAtlasMaxWidth,
  // default 4096 = universal-safe across WebGL 2 spec min of 2048 and
  // virtually every GPU in production; callers can bump it for desktop-only
  // builds where they've confirmed the target's max-texture-size).
  // Per-image y-offset chosen by running sum. Pad with zeros where
  // row-width < atlas-width. Each image's atlasSlot meta is back-filled here.
  const maxAtlasWidth = Math.max(
    Number.isFinite(opts.imageAtlasMaxWidth) ? opts.imageAtlasMaxWidth : 4096,
    16,
  );
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
        buf.set(
          im.rgba.subarray(row * srcStride, row * srcStride + srcStride),
          (y0 + row) * stride,
        );
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
    const texImgId = m.imageId || m.strokeImageId | 0;
    if (!texImgId) continue;
    const idx = texImgId - 1;
    const im = ctx.imagesUsed[idx];
    const wrapFlag = im.isPattern ? 1 : 0;
    const pxFlag = m.pixelated ? 4 : 0;
    m.atlasSlot = [atlasYs[idx], im.w, im.h, wrapFlag | pxFlag];
    // No fill <image> rect to map against → map the stroke bitmap over the
    // shape's bbox (clamp), so the stroke samples the image across the silhouette.
    if (!m.imageId && (!m.imageRect || m.imageRect[2] <= 0) && m.bbox) {
      m.imageRect = [m.bbox[0], m.bbox[1], m.bbox[2] - m.bbox[0], m.bbox[3] - m.bbox[1]];
    }
    // For patterns, override imageRect's tile dims with the pattern's em
    // size so the cover shader tiles correctly across the shape.
    if (im.isPattern && im.emW && im.emH) {
      const bbX = m.imageRect[0],
        bbY = m.imageRect[1];
      m.imageRect = [bbX, bbY, im.emW, im.emH];
    }
  }
  // Vector pattern atlas.z records its enclosing carrier (one-based), so
  // nested bakes evaluate coverage at the same screen pixel and footprint.
  const patternCarriers = new Map();
  for (let i = 0; i < ctx.shapesData.length; i++) {
    const shape = ctx.shapesData[i],
      row = shapeToFirstMeta[i];
    if (shape.vecPatternId > 0 && row >= 0 && !patternCarriers.has(shape.vecPatternId))
      patternCarriers.set(shape.vecPatternId, row);
  }
  for (let i = 0; i < ctx.shapesData.length; i++) {
    const shape = ctx.shapesData[i],
      row = shapeToFirstMeta[i];
    if (!(shape.vecPatternId > 0 && shape._patternOwner > 0 && row >= 0)) continue;
    const parent = patternCarriers.get(shape._patternOwner),
      meta = ctx.metas[row];
    if (parent != null && meta.atlasSlot && meta.atlasSlot[3] === 2) meta.atlasSlot[2] = parent + 1;
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
  // (noAaFill / noAaTree / minStrokeEmW computed above the emit loop, since the tree-hard
  // route bakes its GWN tree during that loop.)
  return {
    version: 3,
    numShapes: ctx.metas.length,
    frameFixed: !!preserveViewport && vbW > 0 && vbH > 0, // globalBBox is the viewBox: an update keeps it
    noAaFill,
    // Any row carries per-row hard bits (MANTLE_HARD_MIXED). Independent of
    // noAaFill: that one needs every fill covered, this one needs at least one.
    noAaMixed: _noAaMixedAny,
    // Narrowest stroke among the MIXED-marked shapes only. The draw-time gate
    // needs the stroke at least ~2px on screen to hide the fill edge, and the
    // bundle-wide minStrokeEmW below is 0 unless every fill is covered.
    minStrokeEmWMixed: _noAaMixedAny ? _noAaMixedMinSW : 0,
    noAaTree: ctx._noAaTreeHard === true,

    gwnTree: !!opts.gwnTree || ctx._noAaTreeHard === true,
    // a self-closing cubic, loop or cusp was baked into the tree: the GWN+SDF kernel cannot fill it (renderer vetoes it)
    gwnUnsafe: ctx.gwnUnsafe === true,
    minStrokeEmW: noAaFill ? _noAaMinSW : 0,
    flags,
    segTypeMask: ctx.segTypeMask | 0,
    totalSegments: ctx.totalSegments | 0,
    globalBBox: [minX, minY, gw, gh],
    ...(originX !== 0 || originY !== 0 ? { origin: [originX, originY] } : {}),
    ...(_dropped ? { dropped: _dropped } : null),
    viewBox: [vbMinX, vbMinY, vbW, vbH],
    preserveAspectRatio: [parAx, parAy, parMs],
    curves: ownBuffer(curvesB),
    //
    // Kept only while something needs it — cpatchBuild releases it once a bundle is converted (see
    // there), so this is build-time memory, not resident.
    curves64:
      ctx.curveBuf.floats instanceof Float64Array
        ? ctx.curveBuf.floats.slice(0, ctx.curveBuf.count * 4).buffer
        : null,
    bands: ownBuffer(bandsB),
    meta: ownBuffer(metaBytes),
    solid: solidB.buffer.slice(solidB.byteOffset, solidB.byteOffset + solidB.byteLength),
    curveGeom: ownBuffer(cgeomB),
    gradients: gradientsB.length
      ? gradientsB.buffer.slice(
          gradientsB.byteOffset,
          gradientsB.byteOffset + gradientsB.byteLength,
        )
      : null,
    gradientStops: stopsB.length
      ? stopsB.buffer.slice(stopsB.byteOffset, stopsB.byteOffset + stopsB.byteLength)
      : null,
    gradientStopsCount,
    dashes: dashesB.length
      ? dashesB.buffer.slice(dashesB.byteOffset, dashesB.byteOffset + dashesB.byteLength)
      : null,
    strokeMesh: strokeMeshB.length ? ownBuffer(strokeMeshB) : null,
    clipMesh: clipMeshB.length
      ? clipMeshB.buffer.slice(clipMeshB.byteOffset, clipMeshB.byteOffset + clipMeshB.byteLength)
      : null,
    maskMesh: maskMeshB.length
      ? maskMeshB.buffer.slice(maskMeshB.byteOffset, maskMeshB.byteOffset + maskMeshB.byteLength)
      : null,
    filterTab: filtersB.length
      ? filtersB.buffer.slice(filtersB.byteOffset, filtersB.byteOffset + filtersB.byteLength)
      : null,
    // CPU-only graph table parallel to filterTab. Entry N corresponds
    // to filterId N+1; null entries fall through to the kind path.
    filterGraphs: filterGraphsArr.some((g) => g) ? filterGraphsArr : null,
    // Explicit objectBoundingBox filter regions, entry N == filterId N+1.
    filterRegions: filterRegionsArr.some((r) => r) ? filterRegionsArr : null,
    filterRegionObb: filterRegionObbArr.some((r) => r) ? filterRegionObbArr : null,
    filterRegionQuads: filterRegionQuadsArr.some((q) => q) ? filterRegionQuadsArr : null,
    filterPrimCtms: filterPrimCtmsArr.some((m) => m) ? filterPrimCtmsArr : null,
    kernelTab: kernelTab || null,
    imageAtlas: imageAtlasB.length
      ? imageAtlasB.buffer.slice(
          imageAtlasB.byteOffset,
          imageAtlasB.byteOffset + imageAtlasB.byteLength,
        )
      : null,
    imageAtlasDim: atlasW && atlasH ? [atlasW, atlasH] : null,
    // Per-imageId atlas-slot rectangles. Indexed as
    // imageAtlasRects[imageId - 1] = [atlasY, w, h] in pixels. feImage
    // dispatch + hit-test use this to look up a slot without
    // having to walk meta texels. Null when no images.
    imageAtlasRects: ctx.imagesUsed.length
      ? ctx.imagesUsed.map((im, i) => [atlasYs[i], im.w, im.h])
      : null,
    metaFloatsPerShape: 48, // v3 layout
    // Interior-skip occupancy: true when any fill row baked an interior grid
    // (opt-in opts.occupancyGrid). The bits live in the curve buffer; per-shape
    // (baseTexelIdx, G) ride in meta texel 5 .xy. The renderer gates the fill
    // shader's occupancy branch on this so the default path pays nothing, and
    // since the skip is output-identical, a build without the grid renders the
    // same pixels.
    hasOccupancy: anyOccupancy,
    // Strip covers by meta row (sparse array of { verts: Float32Array, overlap, authoredW }), or null.
    stripRows: ctx.stripRows || null,
    // Async interior grids: reserved (zeroed) in the curve buffer above; the
    // renderer fills them from an idle pass after first draw, then flips
    // bundle.hasOccupancy on. Absent when every grid was built synchronously.
    pendingOccupancy: pendingOcc.length ? pendingOcc : undefined,
    // Async GWN tier-3 grids (band buffer): reserved zeroed during the tree bake,
    // filled by the same idle pass. Absent unless the automatic tree-hard path ran.
    pendingTier3: ctx._pendingTier3 && ctx._pendingTier3.length ? ctx._pendingTier3 : undefined,
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
      ctx.shapeIds[i] != null && ctx.shapeIds[i] !== '' ? ctx.shapeIds[i] : m.shapeId || '',
    ),
    // Per-meta-row renderable-leaf ordinal of the row's SOURCE element in
    // document order (the space the native fallback's positional DOM walk
    // addresses; see leafOrdinalByEl in importWalk), or -1 when the row has
    // no addressable element (<use> expansion, pattern/clip/mask layer
    // rows). Meta rows OUTNUMBER DOM elements whenever a shape emits both a
    // fill and a stroke row, so positional consumers must map through this
    // instead of treating a row index as "the N-th element". null when NO
    // row maps (text bundles / synthesized sections, where rows and
    // elements align 1:1 by construction → consumers fall back to identity).
    // Static metadata may tighten the search radius to this pose's joins.
    // Morph preparation needs the authored ceiling for intermediate turns.
    strokeMiterLimits: ctx.metas.some(
      (m) => m._authoredMiterLimit !== undefined && m._authoredMiterLimit !== m.miterLimit,
    )
      ? Float32Array.from(ctx.metas, (m) => m._authoredMiterLimit ?? m.miterLimit ?? 4)
      : null,
    shapeDomPaths: opts.retainSource
      ? (() => {
          const paths = new Array(ctx.metas.length).fill(null);
          for (let i = 0; i < ctx.shapesData.length; i++) {
            const shape = ctx.shapesData[i];
            if (!shape._domPath) continue;
            const path =
              shape._domLeafGlyphK != null
                ? shape._domPath.concat(shape._domLeafGlyphK)
                : shape._domPath;
            for (let row = shapeToFirstMeta[i]; row >= 0 && row <= shapeToLastMeta[i]; row++)
              paths[row] = path;
          }
          return paths;
        })()
      : null,
    shapeDomIndex: (function () {
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
        const f = shapeToFirstMeta[si],
          l = shapeToLastMeta[si];
        if (f < 0 || l < 0) continue;
        const dl9 = dl + shiftFor9(dl) + (sd9._domLeafGlyphK != null ? sd9._domLeafGlyphK : 0);
        for (let r = f; r <= l; r++) out[r] = dl9;
        any = true;
      }
      return any ? out : null;
    })(),
    // Exact ordered row groups for each placed clip or mask; zero-based.
    // clipperRows retains the first instance's inclusive range for older consumers.
    clipperRowSets,
    clipperRows: (function () {
      const out = Object.create(null);
      const clipIds = ctx.clipSvgIds || [];
      for (let ci = 0; ci < ctx.clipsUsed.length; ci++) {
        const svgId = clipIds[ci];
        const first = clipMetaRow[ci] || 0;
        const last = clipMetaLastRow[ci] || first;
        if (!svgId || first <= 0) continue;
        // Repeated placements use clipperRowSets; keep the legacy first range.
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
        const last = maskMetaLastRow[mi] || first;
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
    // Per-meta-row { glyphLoc, bandMaxX, bandMaxY } of the AUTHORED band region, for the rows whose bands were built from a normalized
    // fill list; null elsewhere. createShapeMorph reads the authored bands back through it.
    authoredBandsByShape: ctx.metas.some((m) => m._authoredBands)
      ? ctx.metas.map((m) => m._authoredBands || null)
      : null,
    fillNormByShape: ctx.metas.some((m) => m._fillNorm)
      ? Int8Array.from(ctx.metas, (m) => m._fillNorm | 0)
      : null,
    curveRangesByShape: (function () {
      const total = ctx.curveBuf.count * 4;
      const n = ctx.metas.length;
      const begins = new Array(n);
      const sorted = [];
      for (let i = 0; i < n; i++) {
        const hasStart = ctx.metas[i]._curveStartF !== undefined;
        begins[i] = hasStart ? ctx.metas[i]._curveStartF | 0 : -1;
        if (hasStart) sorted.push(begins[i]);
      }
      sorted.sort((a, b) => a - b);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const b = begins[i];
        if (b < 0) {
          out[i] = { begin: 0, end: 0 };
          continue;
        }
        // Prefer the END RECORDED AT EMIT — exact, and the only correct answer
        // for the last shape (see _curveEndF above). Fall back to inferring it
        // from the next shape's begin for meta rows that carry no recorded end.
        const e = ctx.metas[i]._curveEndF;
        if (e !== undefined) {
          out[i] = { begin: b, end: e | 0 };
          continue;
        }
        let lo = 0,
          hi = sorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sorted[mid] <= b) lo = mid + 1;
          else hi = mid;
        }
        out[i] = { begin: b, end: lo < sorted.length ? sorted[lo] : total };
      }
      return out;
    })(),
    // Per-meta-row <a href> values: when a shape lives inside an
    // <a href="..."> ancestor, every meta row it produces carries
    // the href so the hit-test consumer can map a hit back to a link
    // target. Empty string = not in an anchor. Length === numShapes.
    // Built by fanning the staged shape's anchorHref across its
    // shapeToFirstMeta..shapeToLastMeta range; shapes that didn't
    // emit any meta row (rare degeneracy) contribute nothing.
    // What the pointer can target, per meta row (hitBits.js): HIT_FILL / HIT_STROKE / HIT_BBOX of the row's own region.
    hitBits: Uint8Array.from(ctx.metas, (m) => m._hit | 0),
    // The second import pass: each row's document position (the count of page shapes before its shape). The first
    // pass: the row each page shape starts at, and whether a second pass has hit-only shapes to find.
    _hitPos: opts._hitPass
      ? (() => {
          const out = new Int32Array(ctx.metas.length);
          for (let si = 0; si < ctx.shapesData.length; si++) {
            const f = shapeToFirstMeta[si],
              l = shapeToLastMeta[si];
            if (f < 0) continue;
            for (let r = f; r <= l && r < out.length; r++) out[r] = ctx.shapesData[si]._pos | 0;
          }
          return out;
        })()
      : null,
    // Temporary meta-row identities are consumed by importer, not retained in bundle data.
    _hitOwners:
      opts._hitOwnerSession && (opts._hitPass || hitNeedsPass)
        ? (() => {
            const owners = new Int32Array(ctx.metas.length);
            for (let si = 0; si < ctx.shapesData.length; si++) {
              const owner = ctx.shapesData[si]._hitOwner;
              if (!owner || shapeToFirstMeta[si] < 0) continue;
              for (let r = shapeToFirstMeta[si]; r <= shapeToLastMeta[si] && r < owners.length; r++)
                owners[r] = owner;
            }
            return owners;
          })()
        : null,
    _hitRowAt: hitNeedsPass ? hitRowAt : null,
    _hitNeeded: hitNeedsPass,
    // The id-bearing ancestor of each row, for group overrides (hitGroups.js): every import builds it, importSvg keeps it as
    // `groupTree` when some row sits under an element with an id, and the second pass adds the hit-only rows to it.
    _hitGroups: (() => {
      const tree = createGroupTree(),
        row = new Int32Array(ctx.metas.length).fill(-1);
      for (let si = 0; si < ctx.shapesData.length; si++) {
        const sd = ctx.shapesData[si];
        if (
          sd.isLayer ||
          (sd.kind && sd.kind !== 'groupBegin' && sd.kind !== 'groupEnd') ||
          !sd._grp
        )
          continue;
        const f = shapeToFirstMeta[si],
          l = shapeToLastMeta[si];
        if (f < 0) continue;
        const k = treeIndexOf(tree, sd._grp);
        for (let r = f; r <= l && r < row.length; r++) row[r] = k;
      }
      return { names: tree.names, parent: Int32Array.from(tree.parent), row };
    })(),
    shapeHrefs: (function () {
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
