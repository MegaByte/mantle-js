// importWalkShapes.js — shape/path/primitive leaf emission (paint servers,
// clip/mask/filter refs, dash, vector-effect, primKind fast-path, markers),
// split out of importWalk.js. A leaf handler taking the shared walkCtx that
// returns true when it handled the tag. No recursion (the container dispatch
// stays in importWalk.js).

import { resolveIdRef, resolvePaintRef, elementChildren } from './utils.js';
import { parseLengthOr } from './length.js';
import { parseShape } from './shape.js';
import { IDENT, transformSegInto } from './transform.js';
import {
  parseStyleString, getStyleProp, getInheritedStyleProp,
  getShapeStyles, getCapsJoins, getFillRule,
} from './style.js';
import { pathBbox } from './bbox.js';
import { instantiateMarker } from './marker.js';
import { segStart, segEnd } from './segment.js';
import { segTangentAt } from './textures.js';

// mix-blend-mode → texel-8 blendMode int. CSS Compositing & Blending L1 (0..15)
// + L2 extras (16..18, alpha 20, erase 21).
const BLEND_MODES = {
  'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3,
  'darken': 4, 'lighten': 5, 'color-dodge': 6, 'color-burn': 7,
  'hard-light': 8, 'soft-light': 9, 'difference': 10, 'exclusion': 11,
  'hue': 12, 'saturation': 13, 'color': 14, 'luminosity': 15,
  'plus-lighter': 16, 'add': 16,
  'plus-darker':  17, 'subtract': 17,
  'invert': 18,
  'alpha': 20, 'erase': 21,
};

/// Emit a shape leaf (<path>/<rect>/<circle>/<ellipse>/<line>/<polyline>/
/// <polygon>). Returns false when `tag` is not a shape tag (caller keeps
/// dispatching); true when handled (caller returns). `ctm`/`f`/`s`/`w` are the
/// resolved CTM + inherited fill/stroke/stroke-width from the walk.
export function handleShapePaintTag(walkCtx, node, tag, ctm, f, s, w) {
  if (!['path','rect','circle','ellipse','line','polyline','polygon'].includes(tag)) return false;
  const {
    enqueueShape, claimGradient, claimVectorPattern, claimImage,
    claimClip, claimMask, claimFilter,
    currentClipRef, currentMaskRef, currentFilterRef,
    ctx, _patternElById, markersDict,
  } = walkCtx;
  let segs = parseShape(node, walkCtx.viewport);
  if (segs.length) {
        if (ctm !== IDENT && !(ctm[0]===1 && ctm[1]===0 && ctm[2]===0 && ctm[3]===1 && ctm[4]===0 && ctm[5]===0)) {
          const xformed = [];
          for (const sg of segs) transformSegInto(sg, ctm, xformed);
          segs = xformed;
        }
        // Detect url(#id) refs before resolving colors.
        const styleMap = parseStyleString(node.getAttribute('style') || '');
        const rawFillStr = styleMap.fill || node.getAttribute('fill') || f;
        const rawStrokeStr = styleMap.stroke || node.getAttribute('stroke') || s;
        let fillGradId = 0, strokeGradId = 0;
        let fillVecPatternId = 0;
        const fid = resolvePaintRef(rawFillStr);
        const sid = resolvePaintRef(rawStrokeStr);
        if (fid) {
          fillGradId = claimGradient(fid);
          if (!fillGradId && fid in _patternElById) {
            fillVecPatternId = claimVectorPattern(fid, _patternElById[fid]);
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
          if (!strokeGradId && sid in _patternElById) {
            for (const ch of elementChildren(_patternElById[sid])) {
              if ((ch.tagName || '').toLowerCase() === 'image') {
                strokeImageId = claimImage(ch);
                if (strokeImageId) break;
              }
            }
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
        const rawMaskStr = styleMap['mask']      || node.getAttribute('mask')      || currentMaskRef();
        const rawFilterStr = styleMap['filter']  || node.getAttribute('filter')   || currentFilterRef();
        const clipRef = resolveIdRef(rawClipStr);
        const maskRef = resolveIdRef(rawMaskStr);
        const filterRef = resolveIdRef(rawFilterStr);
        // Pass the about-to-be-emitted shape index so objectBoundingBox
        // clip/mask defs can be specialized per-shape.
        const referencingShapeIdx = ctx.shapesData.length;
        const clipId   = clipRef   ? claimClip(clipRef, referencingShapeIdx) : 0;
        const maskId   = maskRef   ? claimMask(maskRef, referencingShapeIdx) : 0;
        const filterId = filterRef ? claimFilter(filterRef) : 0;
        // mix-blend-mode (CSS Compositing & Blending). Encoded as small
        // int matching the texel-8 .y blendMode field. Modes the renderer
        // can express with fixed-function blending (multiply, screen,
        // darken, lighten) work natively; others fall back to normal
        // SRC_OVER.
        const blendStr = (styleMap['mix-blend-mode'] || node.getAttribute('mix-blend-mode') || 'normal').trim().toLowerCase();
        // BLEND_MODES (module scope): CSS Compositing & Blending L1 (0..15) +
        // L2 extras (16..18, alpha 20, erase 21).
        const blendMode = BLEND_MODES[blendStr] || 0;
        const isolStr = (styleMap['isolation'] || node.getAttribute('isolation') || 'auto').trim().toLowerCase();
        const isolation = (isolStr === 'isolate') ? 1 : 0;
        // paint-order: SVG 2 / CSS Painting Order. Default is
        //   "fill stroke markers"
        // Authors commonly use "stroke fill" for text outlines etc.
        // We parse the first two tokens (markers we always emit between
        // fill and the stroke meta row, since markers ARE shapes).
        const paintOrderStr = (styleMap['paint-order']
                                || getInheritedStyleProp(node, 'paint-order', 'fill stroke markers')
                                || 'fill stroke markers').trim().toLowerCase();
        const tokens = paintOrderStr.split(/\s+/).filter(t => t.length > 0);
        // strokeFirst = true iff "stroke" appears BEFORE "fill" in the list.
        let strokeFirst = false;
        for (const tok of tokens) {
          if (tok === 'fill') break;
          if (tok === 'stroke') { strokeFirst = true; break; }
        }
        const styles = getShapeStyles(node, f, s, w);
        const capsJoins = getCapsJoins(node);
        if (fillGradId > 0) styles.fillRgba = [1, 1, 1, 1];
        if (strokeGradId > 0) styles.strokeRgba = [1, 1, 1, 1];
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
        const veStr = (styleMap['vector-effect'] || node.getAttribute('vector-effect') || '').trim().toLowerCase();
        const veTokens = veStr ? veStr.split(/\s+/).filter(t => t) : [];
        const nonScalingStroke = veTokens.includes('non-scaling-stroke');
        const nonScalingSize   = veTokens.includes('non-scaling-size');
        const nonRotation      = veTokens.includes('non-rotation');
        const fixedPosition    = veTokens.includes('fixed-position');
        // stroke-dasharray parsing. SVG allows a list of lengths (+ optional
        // percent/'none'). We parse into a bare number[] in em-space. If the
        // pattern has odd length, SVG spec says duplicate it (4,2 ↔ 4,2,4,2).
        const rawDash = (styleMap['stroke-dasharray']
                          || getInheritedStyleProp(node, 'stroke-dasharray', '')
                          || '').trim();
        // Average CTM scale — segments are baked into root space, so
        // stroke width AND dash lengths/offset (which position along the
        // TRANSFORMED arc length) must scale the same way. Percent dash
        // entries resolve against the viewport diagonal (§7.10).
        const ctmScale = 0.5 * (Math.hypot(ctm[0], ctm[1]) + Math.hypot(ctm[2], ctm[3]));
        const vpD9 = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'd' } : undefined;
        let dashArray = [];
        if (rawDash && rawDash.toLowerCase() !== 'none') {
          dashArray = rawDash.split(/[\s,]+/)
            .map((t) => parseLengthOr(t, NaN, vpD9))
            .filter(Number.isFinite)
            .map((d) => d * ctmScale);
          if (dashArray.length & 1) dashArray = dashArray.concat(dashArray);
        }
        const dashOffsetStr = (styleMap['stroke-dashoffset']
                                || getInheritedStyleProp(node, 'stroke-dashoffset', '0')
                                || '0').trim();
        const dashOffset = parseLengthOr(dashOffsetStr, 0, vpD9) * ctmScale;
        const hasDash = dashArray.length > 0;
        let sw = styles.sw;
        if (sw > 0 && !nonScalingStroke) sw *= ctmScale;
        let flagsShape = 0;
        if (nonScalingStroke) flagsShape |= 1;
        if (hasDash)          flagsShape |= 2;
        if (nonScalingSize)   flagsShape |= 1024;   // bit 10
        if (nonRotation)      flagsShape |= 2048;   // bit 11
        if (fixedPosition)    flagsShape |= 4096;   // bit 12
        // Vector pattern fill: atlasSlot.w == 2 + (firstRow, lastRow)
        // get stamped at meta-pack time; here we just record the path
        // bbox as imageRect so the shader's tile-wrap loop has its
        // origin.
        let imageId = 0;
        let imageRect = [0, 0, 0, 0];
        if (fillVecPatternId > 0) {
          const bb = pathBbox(segs);
          imageRect = [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]];
        }
        // primKind fast-path tag. circle: tagged always — the shader's square-bbox
        // check is the gate (a non-uniformly-scaled circle bakes to an ellipse
        // bbox → falls back). rect (2) / roundRect (3): only when the baked ctm
        // is axis-aligned (no rotation/shear) so the bbox IS the rect; render-
        // time override rotation is still fine (em-space SDF + screen-gradient
        // AA). roundRect additionally needs uniform scale + circular corners so
        // a single corner radius is valid (else falls back to the ray-cast).
        const _axisAligned = Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6;
        let _primKind = tag === 'circle' ? 1 : 0;
        let _primRx = 0;
        if (tag === 'rect' && _axisAligned) {
          let _rx = parseFloat(node.getAttribute('rx'));
          let _ry = parseFloat(node.getAttribute('ry'));
          _rx = Number.isFinite(_rx) ? _rx : (Number.isFinite(_ry) ? _ry : 0);
          _ry = Number.isFinite(_ry) ? _ry : _rx;
          const _sx = Math.abs(ctm[0]), _sy = Math.abs(ctm[3]);
          if (_rx <= 0) _primKind = 2;                                   // sharp rect
          else if (Math.abs(_rx - _ry) < 1e-6 && Math.abs(_sx - _sy) < 1e-4 * Math.max(_sx, 1e-6)) {
            _primKind = 3; _primRx = _rx * _sx;                          // roundRect, em-space radius
          }
          // elliptical corners / non-uniform scale → fall back (0)
        }
        enqueueShape({
          segs,
          fillRgba: styles.fillRgba,
          fillNone: styles.fillNone,
          strokeRgba: styles.strokeRgba,
          sw,
          fillRule: getFillRule(node),
          primKind: _primKind,
          primRx: _primRx,
          ...capsJoins,
          fillGradId,
          strokeGradId,
          strokeImageId,
          vecPatternId: fillVecPatternId,
          flagsShape,
          dashArray,
          dashOffset,
          clipId,
          maskId,
          filterId,
          blendMode,
          isolation,
          imageId,
          imageRect,
          strokeFirst,
        });
        // marker-start / marker-mid / marker-end. Each marker is
        // instantiated at its vertex with the path's local tangent and
        // becomes a regular shape entry — no renderer changes needed.
        // marker-start / marker-mid / marker-end are inheritable per
        // SVG 1.1 §11.6.2 — walk ancestors so `<g marker-end="url(#m)">`
        // applies markers to descendant paths.
        const markerStartRef = resolveIdRef(getInheritedStyleProp(node, 'marker-start', '') || '');
        const markerMidRef   = resolveIdRef(getInheritedStyleProp(node, 'marker-mid',   '') || '');
        const markerEndRef   = resolveIdRef(getInheritedStyleProp(node, 'marker-end',   '') || '');
        const mStart = markerStartRef ? markersDict[markerStartRef] : null;
        const mMid   = markerMidRef   ? markersDict[markerMidRef]   : null;
        const mEnd   = markerEndRef   ? markersDict[markerEndRef]   : null;
        if ((mStart || mMid || mEnd) && segs.length) {
          // Walk path vertices and tangents. SVG marker placement: at the
          // first endpoint of the path (start), at each interior shared
          // endpoint (mid), at the last endpoint (end). Tangent at start
          // = first segment's start tangent. At mid = average of incoming/
          // outgoing tangents. At end = last segment's end tangent.
          const tanStart = segTangentAt(segs[0], true);
          const tanEnd   = segTangentAt(segs[segs.length - 1], false);
          const angleStart = Math.atan2(tanStart[1], tanStart[0]);
          const angleEnd   = Math.atan2(tanEnd[1], tanEnd[0]);
          if (mStart) {
            const sp0 = segStart(segs[0]);
            for (const sd of instantiateMarker(mStart, sp0[0], sp0[1], angleStart, sw || 1, true))
              enqueueShape(sd);
          }
          if (mMid && segs.length > 1) {
            for (let i = 0; i < segs.length - 1; i++) {
              const ep = segEnd(segs[i]);
              const ta = segTangentAt(segs[i], false);
              const tb = segTangentAt(segs[i + 1], true);
              const ax = ta[0] + tb[0], ay = ta[1] + tb[1];
              const ang = Math.atan2(ay, ax);
              for (const sd of instantiateMarker(mMid, ep[0], ep[1], ang, sw || 1))
                enqueueShape(sd);
            }
          }
          if (mEnd) {
            const ep = segEnd(segs[segs.length - 1]);
            for (const sd of instantiateMarker(mEnd, ep[0], ep[1], angleEnd, sw || 1))
              enqueueShape(sd);
          }
        }
  }
  return true;
}
