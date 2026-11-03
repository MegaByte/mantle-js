// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importWalkShapes.js — shape/path/primitive leaf emission (paint servers,
// clip/mask/filter refs, dash, vector-effect, primKind fast-path, markers),
// split out of importWalk.js. A leaf handler taking the shared walkCtx that
// returns true when it handled the tag. No recursion (the container dispatch
// stays in importWalk.js).

import { svgElementName, resolveIdRef, parsePaintUrl, elementChildren } from './utils.js';
import { parseLengthOr } from './length.js';
import { parseShape, resolveRectRadii } from './shape.js';
import { IDENT, matMul, transformSegInto } from './transform.js';
import {
  getStyleProp,
  getInheritedStyleProp,
  getShapeStyles,
  getStrokeDashes,
  getCapsJoins,
  getFillRule,
  getClipRule,
  parseAlphaOr,
  withCurrentColor,
} from './style.js';
import { parseColor } from './color.js';
import { pathBbox } from './bbox.js';
import { instantiateMarker, markerPlacement, markerViewport } from './marker.js';
import { segStart, segEnd, JOIN_MITER, JOIN_ARCS } from './segment.js';
import { segTangentAt, segArcLen } from './textures.js';
import { strokeFrameOf, ctmConformal, ctmSingular } from '../bundle/strokeFrame.js';
import { mantleWarn } from '../core/diagnostics.js';

// mix-blend-mode → texel-8 blendMode int. CSS Compositing & Blending L1 (0..15)
// + L2 extras (16..18, alpha 20, erase 21).
const BLEND_MODES = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  'plus-lighter': 19,
  add: 16,
  'plus-darker': 17,
  subtract: 17,
  invert: 18,
  alpha: 20,
  erase: 21,
};

/// actual / authored length for an element with a positive `pathLength`, else 1. The actual length is the path's own arc length in user
/// space. Only the dash array and offset read it (a stroke that is not dashed never measures anything).
function pathLengthScale(node, localSegs) {
  const raw = node.getAttribute('pathLength');
  if (raw == null) return 1;
  const pl = Number(String(raw).trim());
  if (!(pl > 0) || !Number.isFinite(pl)) return 1;
  let len = 0;
  for (const sg of localSegs) len += segArcLen(sg);
  return len > 0 && Number.isFinite(len) ? len / pl : 1;
}

const MARKABLE_TAGS = { path: 1, line: 1, polyline: 1, polygon: 1 };
const ZERO_SIZE_TAGS = { rect: 1, circle: 1, ellipse: 1 };

/// Emit a shape leaf (<path>/<rect>/<circle>/<ellipse>/<line>/<polyline>/
/// <polygon>). Returns false when `tag` is not a shape tag (caller keeps
/// dispatching); true when handled (caller returns). `ctm`/`f`/`s`/`w` are the
/// resolved CTM + inherited fill/stroke/stroke-width from the walk.
export function handleShapePaintTag(walkCtx, node, tag, ctm, f, s, w, fo, so) {
  if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(tag))
    return false;
  const {
    enqueueShape,
    claimGradient,
    claimVectorPattern,
    claimImage,
    claimClip,
    claimMask,
    claimFilter,
    currentClipRef,
    currentMaskRef,
    currentFilterRef,
    ctx,
    _patternElById,
    markersDict,
    patternTransformSingular,
  } = walkCtx;
  let segs = parseShape(node, walkCtx.viewport);
  // A shape with nothing to draw is dropped and counted (bundle.dropped). An empty path has no geometry to keep.
  if (!segs.length)
    walkCtx.dropCount(ZERO_SIZE_TAGS[tag] === 1 ? 'zeroSizeShapes' : 'emptyGeometry');
  // The path in its own user space: markers are placed there and transformed by the CTM with it.
  const localSegs = segs;
  if (segs.length) {
    // A pattern's objectBoundingBox is the shape's box in its own user space, so take it before the transform.
    const userBbox = walkCtx._paintBBox || pathBbox(segs);
    if (
      ctm !== IDENT &&
      !(
        ctm[0] === 1 &&
        ctm[1] === 0 &&
        ctm[2] === 0 &&
        ctm[3] === 1 &&
        ctm[4] === 0 &&
        ctm[5] === 0
      )
    ) {
      const xformed = [];
      for (const sg of segs) transformSegInto(sg, ctm, xformed);
      segs = xformed;
    }
    // context-fill / context-stroke (SVG 2 §13.2.3): the fill / stroke of the CONTEXT ELEMENT, the path a marker
    // is on or the <use> an instance is under (walkCtx.contextPaint, set by the code that walks the content).
    // With no context element they are `none`.
    const contextPaint = walkCtx.contextPaint || null;
    const contextOverride = {};
    const resolveContext = (v, which) => {
      const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (t !== 'context-fill' && t !== 'context-stroke') return v;
      contextOverride[which] =
        (t === 'context-fill' ? contextPaint?.fill : contextPaint?.stroke) ?? 'none';
      return contextOverride[which];
    };
    f = resolveContext(f, 'fill');
    s = resolveContext(s, 'stroke');
    // The cascade's answer (`f` / `s`: !important rule, inline style, rule, attribute, else inherited), so a
    // url() paint set by a stylesheet rule or an inherited one resolves as one set by an attribute does.
    const rawFillStr = walkCtx.inClipContent > 0 ? 'white' : f;
    const rawStrokeStr = walkCtx.inClipContent > 0 ? 'none' : s;
    let fillGradId = 0,
      strokeGradId = 0;
    let fillVecPatternId = 0,
      patternTile = null,
      patternMatrix = null,
      patternContent = null;
    let emptyPattern = false;
    // SVG 2 §13.2: `url(#id) fallback`. A reference that names no paint server paints the fallback, else none.
    const fillUrl = parsePaintUrl(rawFillStr);
    const strokeUrl = parsePaintUrl(rawStrokeStr);
    const fid = fillUrl ? fillUrl.ref : null;
    const sid = strokeUrl ? strokeUrl.ref : null;
    if (fid) {
      fillGradId = claimGradient(fid);
      if (!fillGradId && fid in _patternElById && !patternTransformSingular(fid)) {
        const vp = claimVectorPattern(fid, _patternElById[fid], userBbox);
        if (vp) {
          fillVecPatternId = vp.id;
          patternTile = vp.tile;
          patternContent = vp.content || null;
          // Pattern space is the shape's user space with patternTransform applied: root <- ctm <- patM.
          patternMatrix = matMul(ctm, vp.patM);
          // A viewBox of zero width or height: no paint is applied (SVG 1.1 13.3), though the url() names a fallback. Chrome paints the fallback (compat: 'chrome').
        } else emptyPattern = !(walkCtx.compat === 'chrome' && walkCtx.patternViewBoxEmpty(fid));
      }
    }
    let strokeImageId = 0;
    if (sid) {
      strokeGradId = claimGradient(sid);
      // Image-painted stroke: stroke="url(#p)" with <pattern><image/></pattern>.
      // Map the pattern's first <image> to a bitmap stroke (strokeImageId).
      // It reuses the fill's imageRect/atlasSlot texels (the back-fill below
      // sources them from the stroke image when the shape has NO fill image),
      // covering image strokes on solid/gradient-filled shapes; an
      // independent fill-image AND stroke-image needs an extra meta texel.
      if (!strokeGradId && sid in _patternElById && !patternTransformSingular(sid)) {
        for (const ch of elementChildren(_patternElById[sid])) {
          if (svgElementName(ch) === 'image') {
            strokeImageId = claimImage(ch);
            if (strokeImageId) break;
          }
        }
      }
    }
    // A VECTOR pattern as the STROKE paint (SVG 2 13.2: a pattern is a paint for a stroke too). The shader paints a pattern only through a
    // row's fill, so the stroke is drawn as the pattern MASKED BY THE STROKED OUTLINE: a rect filled with the pattern, masked by a
    // synthetic alpha mask whose content is this element's own geometry stroked white (emitPatternStroke below). 'ok' draws it; any
    // other outcome paints the url() fallback, else nothing, and says why once.
    let patternStroke = null;
    if (
      sid &&
      !strokeGradId &&
      !strokeImageId &&
      sid in _patternElById &&
      !patternTransformSingular(sid)
    ) {
      const veRaw = (getStyleProp(node, 'vector-effect', '') || '').toLowerCase();
      if (walkCtx.walkLayerMode || walkCtx.inClipContent > 0)
        patternStroke = { why: 'inside pattern, mask or clip content' };
      else if (veRaw.includes('non-scaling-stroke'))
        patternStroke = { why: 'with vector-effect: non-scaling-stroke' };
      else {
        const vp = claimVectorPattern(sid, _patternElById[sid], userBbox);
        patternStroke = vp
          ? { ok: true }
          : {
              why: 'a pattern that paints nothing',
              quiet: true,
              noPaint: walkCtx.compat !== 'chrome' && walkCtx.patternViewBoxEmpty(sid),
            };
      }
      if (!patternStroke.ok && !patternStroke.quiet && !walkCtx._warnedPatternStroke) {
        walkCtx._warnedPatternStroke = true;
        mantleWarn(
          `svgImporter: a vector pattern as a stroke is not drawn ${patternStroke.why}; the stroke paints the url() fallback, else nothing.`,
        );
      }
    }
    // clip-path / mask attribute or style (both url(#id) form).
    // Falls back to the inherited ancestor ref so a shape inside
    // `<g mask="url(#m)">` picks up the group's mask. SVG
    // semantics: mask + clip-path inherit through container
    // elements (`<g>`, `<svg>`, `<a>`, `<use>`) unless the
    // descendant declares its own.
    // clip-path is read from the STACK ALONE: walk() already pushed this
    // node's own clip INTERSECTED with the inherited one (SVG 1.1 §14.3,
    // see combineClipRefs in importWalk.js), so re-reading the attribute
    // here would drop the ancestor half of the intersection.
    const rawClipStr = currentClipRef();
    // The mask from the stack too: walk() pushed this node's own mask there, placed in its user space.
    const rawMaskStr = currentMaskRef();
    // The element's own filter value (a url(#id), `none` or a CSS function list; an invalid one is not a value), else the one it inherits.
    const ownFilterValue = getStyleProp(node, 'filter', '') || node.getAttribute('filter');
    const ownFilterStr = walkCtx.normFilter(ownFilterValue, node);
    const rawFilterStr = ownFilterStr || currentFilterRef();
    const clipRef = resolveIdRef(rawClipStr);
    const maskRef = resolveIdRef(rawMaskStr);
    const filterRef = walkCtx.resolveFilterRef(rawFilterStr, node);
    // mix-blend-mode (CSS Compositing & Blending). Encoded as small int matching the texel-8 .y blendMode field.
    // BLEND_MODES (module scope): CSS Compositing & Blending L1 (0..15) + L2 extras (16..18, alpha 20, erase 21).
    const blendStr = (getStyleProp(node, 'mix-blend-mode', 'normal') || 'normal')
      .trim()
      .toLowerCase();
    let blendMode = Object.hasOwn(BLEND_MODES, blendStr) ? BLEND_MODES[blendStr] : 0;
    const isolStr = (getStyleProp(node, 'isolation', 'auto') || 'auto').trim().toLowerCase();
    let isolation = isolStr === 'isolate' ? 1 : 0;
    // markers (marker-start / marker-mid / marker-end), inheritable per SVG 1.1 §11.6.2: walk ancestors so
    // `<g marker-end="url(#m)">` applies markers to descendant paths. Markers go on the elements with path
    // vertices only: <path>, <line>, <polyline> and <polygon> (SVG 2 §13.6; 'markable elements'), never a <rect>,
    // <circle> or <ellipse>.
    const markable =
      MARKABLE_TAGS[tag] === 1 && !(walkCtx.inClipContent > 0) && !(walkCtx._markerDepth > 0);
    const markerStartRef = markable
      ? resolveIdRef(getInheritedStyleProp(node, 'marker-start', '') || '')
      : null;
    const markerMidRef = markable
      ? resolveIdRef(getInheritedStyleProp(node, 'marker-mid', '') || '')
      : null;
    const markerEndRef = markable
      ? resolveIdRef(getInheritedStyleProp(node, 'marker-end', '') || '')
      : null;
    const mStart = markerStartRef ? markersDict[markerStartRef] : null;
    const mMid = markerMidRef ? markersDict[markerMidRef] : null;
    const mEnd = markerEndRef ? markersDict[markerEndRef] : null;
    const hasMarkers = !!(mStart || mMid || mEnd) && segs.length > 0;
    // Pass the about-to-be-emitted shape index so objectBoundingBox
    // clip/mask defs can be specialized per-shape.
    let referencingShapeIdx = ctx.shapesData.length;
    // A filter the shape names ITSELF resolves its region against this shape: its bounding box, or its CTM for a
    // userSpaceOnUse region (the user space the reference is made in). One inherited from a group does not; see
    // resolveFilterRegion.
    const ownFilter = !!ownFilterStr;
    // THE ELEMENT IS ONE COMPOSITED GROUP when it paints more than one thing: its markers are part of what it paints
    // (SVG 2 §13.7.2), and its fill and stroke are one picture. Its opacity, filter and mask then apply to the result
    // once, as a container's do -- not to the path alone (a marker kept its full alpha and its colors), nor to the fill
    // and the stroke separately (the stroke showed the fill through it). The group takes the element's opacity, filter,
    // mask and blend; the clip stays on the rows unless a filter group owns it. Mask and clip content, and pattern
    // layers, keep the rows as they were.
    const elOpacity = Math.max(
      0,
      Math.min(1, parseAlphaOr(getStyleProp(node, 'opacity', null), 1)),
    );
    const groupable = !walkCtx.walkLayerMode && !(walkCtx.inClipContent > 0);
    const paintsBoth =
      !/^none$/i.test((f || '').trim()) &&
      !/^(?:none|transparent)$/i.test((s || '').trim()) &&
      w > 0;
    const groupFilter = ownFilter && !!filterRef;
    let leafGroup = null,
      groupTookClip = false,
      groupTookMask = false,
      groupTookFilter = false;
    // (A mask of exactly white / black shapes cannot show a fill through its stroke or a marker through the path: it keeps the
    // per-row mask and asks for no group.)
    const maskMatters = !!maskRef && !walkCtx.maskIsBinaryId(maskRef);
    if (
      groupable &&
      ((hasMarkers && (elOpacity < 1 - 1e-6 || groupFilter || maskMatters)) ||
        (paintsBoth &&
          (maskMatters ||
            (groupFilter &&
              fo > 0 &&
              so > 0 &&
              tag !== 'line' &&
              walkCtx.filterClaimable(filterRef)) ||
            (elOpacity < 1 - 1e-6 && fo > 0 && so > 0))))
    ) {
      const gi = ctx.shapesData.length;
      const gFilterId = groupFilter
        ? claimFilter(filterRef, { own: true, container: true, ctm, shapeIdx: gi })
        : 0;
      const gMaskId = maskRef ? claimMask(maskRef, gi) : 0;
      const gClipId = gFilterId ? claimClip(clipRef, gi) : 0;
      enqueueShape({
        kind: 'groupBegin',
        groupOpacity: elOpacity,
        filterId: gFilterId,
        clipId: gClipId,
        maskId: gMaskId,
        blendMode,
        isolation,
        _domLeaf: -1,
      });
      leafGroup = ctx.shapesData[gi];
      groupTookFilter = gFilterId > 0;
      groupTookMask = gMaskId > 0;
      groupTookClip = gClipId > 0;
      blendMode = 0;
      isolation = 0;
      referencingShapeIdx = ctx.shapesData.length;
    }
    const clipId = clipRef && !groupTookClip ? claimClip(clipRef, referencingShapeIdx) : 0;
    const maskId = maskRef && !groupTookMask ? claimMask(maskRef, referencingShapeIdx) : 0;
    const filterId =
      filterRef && !groupTookFilter
        ? claimFilter(filterRef, { own: ownFilter, ctm, shapeIdx: referencingShapeIdx })
        : 0;
    // mix-blend-mode (CSS Compositing & Blending). Encoded as small
    // int matching the texel-8 .y blendMode field. Modes the renderer
    // can express with fixed-function blending (multiply, screen,
    // darken, lighten) work natively; others fall back to normal
    // SRC_OVER.
    const paintOrderStr = (
      getInheritedStyleProp(node, 'paint-order', 'fill stroke markers') || 'fill stroke markers'
    )
      .trim()
      .toLowerCase();
    const tokens = paintOrderStr.split(/\s+/).filter((t) => t.length > 0);

    let strokeFirst = false;
    for (const tok of tokens) {
      if (tok === 'fill') break;
      if (tok === 'stroke') {
        strokeFirst = true;
        break;
      }
    }
    // A url() paint whose reference resolved to nothing this importer paints with (no such id, an element that is
    // not a paint server, an external document) takes its fallback color, or none. A pattern stroke the importer
    // cannot draw (no <image> in it) keeps painting its placeholder, as before.
    const paintOverride = { ...contextOverride };
    if (leafGroup && elOpacity < 1) paintOverride.noOpacity = true;
    if (fillUrl && !(fillGradId > 0 || fillVecPatternId > 0 || emptyPattern))
      paintOverride.fill = fillUrl.fallback || 'none';
    if (
      strokeUrl &&
      !(strokeGradId > 0 || (sid && sid in _patternElById && !patternTransformSingular(sid)))
    )
      paintOverride.stroke = strokeUrl.fallback || 'none';
    else if (patternStroke)
      paintOverride.stroke =
        patternStroke.ok || patternStroke.noPaint ? 'none' : strokeUrl.fallback || 'none';
    const styles = getShapeStyles(
      node,
      f,
      s,
      w,
      fo,
      so,
      walkCtx.viewport,
      walkCtx.inClipContent > 0,
      paintOverride,
    );
    const capsJoins = getCapsJoins(node);
    // A gradient paint is WHITE times the gradient, at the paint's alpha: opacity x fill-opacity
    // (x stroke-opacity for a stroke). mantle.frag.glsl multiplies the ramp sample by vFill /
    // vStroke and documents exactly this, "(1,1,1,fillOpacity)"; alpha 1 here would draw every
    // gradient opaque whatever its opacity, fill-opacity or stroke-opacity.
    // parseColor('url(#g)') is opaque, so the alpha here is those multipliers alone.
    if (fillGradId > 0) styles.fillRgba = [1, 1, 1, styles.fillRgba[3]];
    if (strokeGradId > 0) styles.strokeRgba = [1, 1, 1, styles.strokeRgba[3]];
    // What the paint is if the gradient turns out unusable: an objectBoundingBox gradient on a shape with no width or height (finalize knows).
    const fallbackRgba = (url, alpha) => {
      const t = url && url.fallback ? url.fallback.trim().toLowerCase() : '';
      if (!t || t === 'none' || t.startsWith('context-')) return null;
      const c = parseColor(withCurrentColor(node, url.fallback)).slice();
      c[3] *= alpha;
      return c;
    };
    // Bitmap stroke (stroke="url(#pattern→image)"): parseColor('url(#p)')
    // returns black, but the shader multiplies the bitmap sample by vStroke
    // (strokePaint = imgCol * vStroke). Force RGB to white so the image
    // shows through, keeping the stroke-opacity in alpha.
    if (strokeImageId > 0) styles.strokeRgba = [1, 1, 1, styles.strokeRgba[3]];
    // Vector pattern: keep alpha intact (parent fill-opacity still
    // applies as a multiplier — including a legitimate 0, which must
    // stay 0) but force RGB to white so the shader's
    // "color = vFill.rgba * fCov" line stays opaque before the
    // vector-pattern branch overrides it. parseColor('url(#p)')
    // yields alpha 1, so an unset fill-opacity is already 1 here.
    if (fillVecPatternId > 0) styles.fillRgba = [1, 1, 1, styles.fillRgba[3]];
    else if (emptyPattern) styles.fillRgba = [0, 0, 0, 0];
    // vector-effect: SVG 2 §6.6 — counteract parts of the supplemental
    // transformation matrix (the post-import world transform applied
    // at draw time via uWorldM). All 4 spec values accepted as a
    // space-separated list; each one toggles its own flagsShape bit
    // and the vertex shader selectively un-applies parts of uWorldM
    // when the flag is set AND uHasWorldM == 1.
    //
    // Values:
    //   non-scaling-stroke — divide stroke width by world-matrix scale
    //                        (existing impl, fragment-side)
    //   non-scaling-size   — undo world-matrix scale on the shape itself
    //   non-rotation       — undo world-matrix rotation
    //   fixed-position     — undo world-matrix translation (positions stay
    //                        at the shape's authored em coords)
    const veStr = (getStyleProp(node, 'vector-effect', '') || '').trim().toLowerCase();
    const veTokens = veStr ? veStr.split(/\s+/).filter((t) => t) : [];
    const nonScalingStroke = veTokens.includes('non-scaling-stroke');
    const nonScalingSize = veTokens.includes('non-scaling-size');
    const nonRotation = veTokens.includes('non-rotation');
    const fixedPosition = veTokens.includes('fixed-position');

    // The stroke's scale. Segments are baked into root space, so the stroke width AND the dash lengths/offset
    // (which position along the arc length) must scale with them. Under a CONFORMAL CTM that is its one scale,
    // the mean of the column lengths (which agree). Under a non-uniform scale or a skew NO width is right --
    // SVG strokes the element in its own space and transforms the outline, so scale(2 1.5) draws half-width 4
    // across a vertical edge and 3 across a horizontal one, where the mean would draw 3.5 on both. Such
    // a row is drawn in STROKE SPACE (bundle/strokeFrame.js): the local space scaled by the CTM's larger singular
    // value sMax, so width and dashes scale by sMax and the row carries the frame N that maps into it.
    // vector-effect: non-scaling-stroke strokes in the host's space, never the element's, so it takes no frame.
    // Percent dash entries resolve against the viewport diagonal (§7.10).
    const ctmScale = 0.5 * (Math.hypot(ctm[0], ctm[1]) + Math.hypot(ctm[2], ctm[3]));
    const frameCandidate = styles.sw > 0 && !nonScalingStroke ? strokeFrameOf(ctm) : null;
    const strokeFrame = frameCandidate?.representable === false ? null : frameCandidate;
    const strokeScale = strokeFrame ? strokeFrame.sMax : ctmScale;
    // pathLength (SVG 2 'pathLength'): the author's total length. Dash lengths and the offset are in that length, so they are
    // scaled by actual / authored length, measured in the path's own user space (before the CTM).
    const dashLengthScale = pathLengthScale(node, localSegs);
    const { dashArray, dashOffset } = getStrokeDashes(
      node,
      walkCtx.viewport,
      (nonScalingStroke ? 1 : strokeScale) * dashLengthScale,
    );
    const hasDash = dashArray.length > 0;
    let sw = ctmSingular(ctm) || frameCandidate?.representable === false ? 0 : styles.sw;
    if (sw > 0 && !nonScalingStroke) sw *= strokeScale;
    // Markers scale by the LOCAL stroke width (markerUnits="strokeWidth") and are transformed by the CTM with the
    // path.
    const markerSw = styles.sw;
    let flagsShape = 0;
    if (nonScalingStroke) flagsShape |= 1;
    if (hasDash) flagsShape |= 2;
    if (nonScalingSize) flagsShape |= 1024; // bit 10
    if (nonRotation) flagsShape |= 2048; // bit 11
    if (fixedPosition) flagsShape |= 4096;
    let imageId = 0;
    let imageRect = [0, 0, 0, 0];
    if (fillVecPatternId > 0) {
      const bb = pathBbox(segs);
      imageRect = [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]];
    }

    const _ctmScale = Math.max(
      Math.abs(ctm[0]),
      Math.abs(ctm[1]),
      Math.abs(ctm[2]),
      Math.abs(ctm[3]),
    );
    const _axisAligned = Math.abs(ctm[1]) < 1e-6 * _ctmScale && Math.abs(ctm[2]) < 1e-6 * _ctmScale;
    let _primKind = tag === 'circle' && ctmConformal(ctm) ? 1 : 0;
    let _primRx = 0;
    if (tag === 'rect' && _axisAligned) {
      const [_rx, _ry] = resolveRectRadii(
        node,
        userBbox[2] - userBbox[0],
        userBbox[3] - userBbox[1],
        walkCtx.viewport,
      );
      const _sx = Math.abs(ctm[0]),
        _sy = Math.abs(ctm[3]);
      if (_rx <= 0) _primKind = 2;
      else if (
        Math.abs(_rx - _ry) < 1e-6 * Math.max(_rx, _ry) &&
        Math.abs(_sx - _sy) < 1e-4 * Math.max(_sx, _sy)
      ) {
        _primKind = 3;
        _primRx = _rx * _sx; // roundRect, em-space radius
      }
      // elliptical corners / non-uniform scale → fall back (0)
    }
    // `M x y Z` alone is a zero-length subpath the stroke can paint (round or square cap); with no stroke to paint it, it is nothing, as before
    // the parser kept a record for it.
    // THE PATTERN STROKE, drawn: <g mask=(the element's own mask, as a group)><rect fill=url(#pattern) mask=(synthetic)/></g> walked in the
    // element's user space. The synthetic mask holds a copy of this element, fill none, stroke white, so the stroke's dashes, caps,
    // joins, width and vector-effect are the stroke's own; the pattern's objectBoundingBox is this element's box (walkCtx._paintBBox),
    // not the rect's. The element's opacity, blend mode and isolation ride on the rect; its clip and filter reach it through the stacks;
    // its mask moves to the group because a leaf takes one mask.
    const emitPatternStroke = () => {
      if (!patternStroke || !patternStroke.ok || !(styles.sw > 0) || !(so > 0)) return;
      const doc = node.ownerDocument,
        ns = node.namespaceURI,
        parent = node.parentNode;
      if (!doc || !parent) return;
      const mk = (name) =>
        doc.createElementNS ? doc.createElementNS(ns, name) : doc.createElement(name);
      const reachK = Math.max(
        Math.SQRT2,
        capsJoins.joinStyle === JOIN_MITER || capsJoins.joinStyle === JOIN_ARCS
          ? capsJoins.miterLimit
          : 1,
      );
      const pad =
        0.5 * styles.sw * reachK * 1.02 +
        1e-6 * Math.max(userBbox[2] - userBbox[0], userBbox[3] - userBbox[1], 1);
      const rx = userBbox[0] - pad,
        ry = userBbox[1] - pad,
        rw = userBbox[2] - userBbox[0] + 2 * pad,
        rh = userBbox[3] - userBbox[1] + 2 * pad;
      const mask = mk('mask');
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
      mask.setAttribute('x', String(rx));
      mask.setAttribute('y', String(ry));
      mask.setAttribute('width', String(rw));
      mask.setAttribute('height', String(rh));
      const copy = node.cloneNode(false);
      for (const att of [
        'id',
        'transform',
        'mask',
        'clip-path',
        'filter',
        'opacity',
        'mix-blend-mode',
        'isolation',
        'marker',
        'marker-start',
        'marker-mid',
        'marker-end',
        'fill-opacity',
        'stroke-opacity',
        'paint-order',
        'fill',
        'stroke',
      ])
        copy.removeAttribute(att);
      copy.setAttribute(
        'style',
        `${node.getAttribute('style') || ''};fill:none;stroke:#fff;stroke-opacity:1;fill-opacity:1;opacity:1;mask:none;clip-path:none;` +
          'filter:none;mix-blend-mode:normal;isolation:auto;marker:none;marker-start:none;marker-mid:none;marker-end:none;transform:none;paint-order:normal',
      );
      mask.appendChild(copy);
      parent.appendChild(mask); // stays: the mask's content is walked at finalize and inherits from the parent chain
      const maskId = walkCtx.addSyntheticMask(mask, { x: rx, y: ry, w: rw, h: rh });
      const rect = mk('rect');
      rect.setAttribute('x', String(rx));
      rect.setAttribute('y', String(ry));
      rect.setAttribute('width', String(rw));
      rect.setAttribute('height', String(rh));
      rect.setAttribute('fill', `url(#${sid})`);
      rect.setAttribute('stroke', 'none');
      rect.setAttribute('fill-opacity', String(so));
      rect.setAttribute('mask', `url(#${maskId})`);
      // The compositing the ELEMENT has applies to the stroke picture, in the spec's order (filter, clip, mask, opacity): a filter or a mask
      // makes a group of its own around the masked pattern (a leaf takes one mask, and its filter would run before the outline
      // masked it); otherwise opacity and blend ride on the rect. A group the element opened already carries all of it.
      const ownFilterRef = ownFilter && filterRef && !groupTookFilter ? ownFilterValue : '';
      const ownMaskRef = maskRef && !groupTookMask ? `url(#${maskRef})` : '';
      let top = rect;
      const carrier = ownFilterRef || ownMaskRef ? (top = mk('g')) : rect;
      if (carrier !== rect) {
        if (ownMaskRef) {
          carrier._mantleMaskGroup = true;
          carrier.setAttribute('mask', ownMaskRef);
        }
        if (ownFilterRef) carrier.setAttribute('filter', ownFilterRef);
        carrier.appendChild(rect);
      }
      if (!leafGroup) {
        const elOp = getStyleProp(node, 'opacity', null);
        if (elOp != null) carrier.setAttribute('opacity', elOp);
        if (blendStr !== 'normal') carrier.setAttribute('mix-blend-mode', blendStr);
        if (isolStr === 'isolate') carrier.setAttribute('isolation', 'isolate');
      }
      parent.appendChild(top);
      const saved = walkCtx._paintBBox,
        savedSegs = walkCtx._groupBoxSegs;
      walkCtx._paintBBox = userBbox;
      walkCtx._groupBoxSegs = segs;
      walkCtx._useDepth++; // the rows have no element of their own in the source markup (_domLeaf -1)
      try {
        walkCtx.walk(top, f, s, w, ctm, fo, so);
      } finally {
        walkCtx._useDepth--;
        walkCtx._paintBBox = saved;
        walkCtx._groupBoxSegs = savedSegs;
        parent.removeChild(top);
      }
    };
    const dropMoveClose =
      localSegs.every((sg) => sg.fromMoveClose === true) &&
      !(
        sw > 0 &&
        !styles.strokeNone &&
        styles.strokeRgba &&
        styles.strokeRgba[3] > 0 &&
        capsJoins.capStyle !== 0
      );
    if (strokeFirst) emitPatternStroke();
    if (!dropMoveClose)
      enqueueShape({
        segs,
        // THE SHAPE'S own BOUNDING BOX, and the CTM it was taken before. An objectBoundingBox clip or mask
        // this shape carries itself binds to exactly this box (SVG 1.1 §7.11: the element's own transform is
        // excluded from the box and applied to the supplemental matrix afterwards), so finalizeBundle can use
        // it directly instead of unmapping the document-space geometry. `ctm` is the identical array
        // _walkInner recorded for this element's clip/mask instance, which is how the two are matched up.
        _obbBox: userBbox,
        _obbCtm: ctm,
        // The shape's own segments and local half width, kept only when a basic-shape clip-path asked for a stroke-box
        // (svg/strokeBox.js reads them with the shape's joins and caps, which ride on the record).
        ...(walkCtx._strokeBoxWanted && styles.sw > 0 && !styles.strokeNone && !nonScalingStroke
          ? { _strokeLocal: { segs: localSegs, halfW: 0.5 * styles.sw } }
          : null),
        fillRgba: styles.fillRgba,
        fillColorClear: !!styles.fillColorClear,
        fillNone: styles.fillNone || emptyPattern, // a pattern that paints nothing is no paint to keep
        strokeNone: styles.strokeNone,
        strokeRgba: styles.strokeRgba,
        sw,
        // The stroke frame: N, column-major, or null for a conformal CTM. `swMin` is the stroke's width in
        // its THINNEST document direction, for the consumers that need a lower bound (a fill whose AA band the
        // stroke must cover); `sw`, sMax * w, is the upper bound every pad and cull reads.
        strokeFrame: strokeFrame ? strokeFrame.N : null,
        swMin: strokeFrame ? styles.sw * strokeFrame.sMin : sw,
        // Inside a <clipPath> a shape winds by clip-rule; fill-rule means nothing there.
        fillRule: walkCtx.inClipContent > 0 ? getClipRule(node) : getFillRule(node),
        primKind: _primKind,
        primRx: _primRx,
        ...capsJoins,
        fillGradId,
        strokeGradId,
        ...(fillGradId > 0 && fillUrl.fallback
          ? { _fillFallback: fallbackRgba(fillUrl, styles.fillRgba[3]) }
          : null),
        ...(strokeGradId > 0 && strokeUrl.fallback
          ? { _strokeFallback: fallbackRgba(strokeUrl, styles.strokeRgba[3]) }
          : null),
        strokeImageId,
        vecPatternId: fillVecPatternId,
        patternTile,
        patternMatrix,
        patternContent,
        flagsShape,
        dashArray,
        dashOffset,
        dashSeamChrome: walkCtx.compat === 'chrome', // closed dashed contour: Chrome's one merged seam dash (compat: 'chrome'), else the spec's two capped dashes
        clipId,
        maskId,
        filterId,
        blendMode,
        isolation,
        imageId,
        imageRect,
        strokeFirst,
        ...(walkCtx._groupBoxSegs ? { groupBoxSegs: walkCtx._groupBoxSegs } : null),
      });
    if (!strokeFirst) emitPatternStroke();
    // marker-start / marker-mid / marker-end. Each marker is
    // instantiated at its vertex with the path's local tangent and
    // becomes a regular shape entry — no renderer changes needed.
    // marker-start / marker-mid / marker-end are inheritable per
    // SVG 1.1 §11.6.2 — walk ancestors so `<g marker-end="url(#m)">`
    // applies markers to descendant paths.
    // Markers go on the elements with path vertices only: <path>, <line>, <polyline> and <polygon> (SVG 2 §13.6;
    // 'markable elements'), never a <rect>, <circle> or <ellipse>.
    // An instance's rows, each clipped to the marker's viewport where its content reaches out of it:
    // instantiateMarker hands back the viewport's polygon in document space, a clip like a nested viewport's.
    // A marker renders AS PART OF the path (SVG 2 §13.7.2), so the path's own clip-path and mask apply to it too
    //: its rows take the path's claimed entries -- the same entry, so an objectBoundingBox clip or mask keeps
    // the path's box -- and a viewport clip is intersected with the path's clip rather than replacing it.
    const placeMarker = (sds) => {
      let mClip = clipId;
      if (sds.viewport) {
        const vref = resolveIdRef(walkCtx.viewportClipRef(node.ownerDocument, sds.viewport));
        if (vref) mClip = claimClip(walkCtx.nestClipDef(vref, clipId), ctx.shapesData.length);
      }
      // `_marker`: part of what the path PAINTS, not of its geometry -- a mask region's objectBoundingBox is the
      // path's box without its markers (bundleFinalize applyMaskRegions).
      for (const sd of sds) enqueueShape({ ...sd, clipId: mClip, maskId, _marker: true });
    };
    // A marker whose content needs the main walker (transforms, <use>, gradient or pattern paints, groups) is
    // walked there with the placement as its CTM; any other keeps the flat records of instantiateMarker.
    // The context element's paints, for context-fill / context-stroke in the marker's content.
    const markerContext = { fill: f, stroke: s };
    const putMarker = (marker, x, y, angle, isStart) => {
      // The <marker>'s own opacity composes its instance as one group (it does not inherit, so the content's own
      // cascade never saw it).
      const mop = Math.max(
        0,
        Math.min(1, parseAlphaOr(getStyleProp(marker.el, 'opacity', null), 1)),
      );
      const grouped = mop < 1 - 1e-6;
      if (grouped)
        enqueueShape({
          kind: 'groupBegin',
          groupOpacity: mop,
          filterId: 0,
          clipId: 0,
          maskId: 0,
          blendMode: 0,
          isolation: 0,
          _domLeaf: -1,
        });
      const savedContext = walkCtx.contextPaint;
      walkCtx.contextPaint = markerContext;
      try {
        // A marker at stroke width 0 is nothing, as in a browser; the default import counts it (bundle.dropped).
        if (!(markerSw > 0) && marker.units !== 'userSpaceOnUse')
          walkCtx.dropCount('zeroWidthMarkers');
        if (!marker.walked)
          placeMarker(instantiateMarker(marker, x, y, angle, markerSw, isStart, ctm));
        else {
          const place = markerPlacement(marker, x, y, angle, markerSw, isStart, ctm);
          if (place)
            walkCtx.walkMarkerContent(
              marker,
              place.M,
              markerViewport(marker, place.hasVb, place.k, place.M, true),
            );
        }
      } finally {
        walkCtx.contextPaint = savedContext;
      }
      if (grouped) enqueueShape({ kind: 'groupEnd' });
    };
    // The mask and clip the element's group took must not reach the walked marker content again through the stacks.
    const heldMask = groupTookMask ? walkCtx.holdTopMask() : null;
    const heldClip = groupTookClip ? walkCtx.holdTopClip() : null;
    if ((mStart || mMid || mEnd) && segs.length) {
      // Walk path vertices and tangents. SVG marker placement: at the
      // first endpoint of the path (start), at each interior shared
      // endpoint (mid), at the last endpoint (end). Tangent at start
      // = first segment's start tangent. At mid = average of incoming/
      // outgoing tangents. At end = last segment's end tangent.
      //
      // All in the path's own space: SVG places the marker in the referencing path's user space and the
      // path's CTM transforms it with the path, so the vertex, the angle and the stroke width are LOCAL and the CTM
      // goes to instantiateMarker. Taken off the document-space segments with the CTM's mean scale instead, a
      // marker would keep its shape under a non-uniform scale or a skew the path does not, and would not be
      // mirrored by a reflection that mirrors the path.
      const ls = localSegs;
      const tanStart = segTangentAt(ls[0], true);
      const tanEnd = segTangentAt(ls[ls.length - 1], false);
      const angleStart = Math.atan2(tanStart[1], tanStart[0]);
      const angleEnd = Math.atan2(tanEnd[1], tanEnd[0]);
      if (mStart) {
        const sp0 = segStart(ls[0]);
        // The stroke width as it is: markerUnits="strokeWidth" scales a marker by it, so at
        // stroke-width 0 the marker vanishes, as in a browser. `sw || 1` would draw it at 1.
        putMarker(mStart, sp0[0], sp0[1], angleStart, true);
      }
      if (mMid && ls.length > 1) {
        // Every vertex but the first and the last is a mid vertex, the ends and starts of the INNER subpaths
        // included (SVG 2 §13.6.2). Inside a subpath the direction bisects the incoming and outgoing tangents.
        // A subpath's own end has its incoming tangent only, its start its outgoing only; a CLOSED one (a Z
        // ended it: parsePathD leaves `openEnd` on the last segment of every open subpath) joins the two.
        const subpaths = [];
        for (let i = 0, first = 0; i < ls.length; i++) {
          if (i + 1 === ls.length || ls[i + 1].subStart === true) {
            subpaths.push({ first, last: i, closed: ls[i].openEnd !== true });
            first = i + 1;
          }
        }
        const bisect = (ta, tb) => Math.atan2(ta[1] + tb[1], ta[0] + tb[0]);
        for (const sp of subpaths) {
          if (sp.first > 0) {
            // the start vertex of an inner subpath
            const at = segStart(ls[sp.first]);
            const out = segTangentAt(ls[sp.first], true);
            const ang =
              sp.closed && sp.last > sp.first
                ? bisect(segTangentAt(ls[sp.last], false), out)
                : Math.atan2(out[1], out[0]);
            putMarker(mMid, at[0], at[1], ang, false);
          }
          for (let i = sp.first; i < sp.last; i++) {
            // the joints inside the subpath
            const ep = segEnd(ls[i]);
            const ta = segTangentAt(ls[i], false);
            const tb = segTangentAt(ls[i + 1], true);
            const ax = ta[0] + tb[0],
              ay = ta[1] + tb[1];
            const ang = Math.atan2(ay, ax);
            putMarker(mMid, ep[0], ep[1], ang, false);
          }
          if (sp.last < ls.length - 1) {
            // the end vertex of an inner subpath
            const at = segEnd(ls[sp.last]);
            const inc = segTangentAt(ls[sp.last], false);
            const ang =
              sp.closed && sp.last > sp.first
                ? bisect(inc, segTangentAt(ls[sp.first], true))
                : Math.atan2(inc[1], inc[0]);
            putMarker(mMid, at[0], at[1], ang, false);
          }
        }
      }
      if (mEnd) {
        const ep = segEnd(ls[ls.length - 1]);
        putMarker(mEnd, ep[0], ep[1], angleEnd, false);
      }
    }
    if (groupTookMask) walkCtx.releaseTopMask(heldMask);
    if (groupTookClip) walkCtx.releaseTopClip(heldClip);
    if (leafGroup) {
      // The group's box is the element's GEOMETRY: its markers paint, they are not part of the box.
      const members = walkCtx.collectGroupGeometry(leafGroup, true);
      if (groupTookFilter) walkCtx.setFilterGroupMembers(members);
      enqueueShape({ kind: 'groupEnd' });
    }
  }
  return true;
}
