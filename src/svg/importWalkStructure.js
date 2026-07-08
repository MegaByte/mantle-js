// importWalkStructure.js — the <image> leaf handler, split out of importWalk.js.
// Handles both raster <image> (emit an axis-aligned rect sampling the atlas)
// and SVG-content <image> (recursively walk the nested SVG via walkCtx.walk with
// a viewBox→rect fit matrix). Recurses through walkCtx.walk; the container
// dispatch (<g>/<use>/<symbol>/<switch>/nested <svg>) stays in importWalk.js.

import { resolveIdRef, elementChildren } from './utils.js';
import { parseLengthOr } from './length.js';
import { IDENT, matMul, transformSegInto } from './transform.js';
import { mkLine, CAP_BUTT, JOIN_MITER } from './segment.js';
import { parseStyleString, getStyleProp, getShapeStyles } from './style.js';

/// Emit an <image> (or splice a nested SVG). Returns false when `tag` isn't an
/// image with decoded data (caller keeps dispatching); true when handled.
export function handleImageTag(walkCtx, node, tag, ctm, f, s, w) {
  const {
    imageDataMap, nestedSvgRoots, walk, enqueueShape, claimImage,
    claimClip, claimMask, claimFilter,
    currentClipRef, currentMaskRef, currentFilterRef, ctx,
  } = walkCtx;
  if (tag !== 'image' || !imageDataMap.has(node)) return false;
      const decoded = imageDataMap.get(node);
      const ix = parseLengthOr(node.getAttribute('x') || '0', 0);
      const iy = parseLengthOr(node.getAttribute('y') || '0', 0);
      const iw = parseLengthOr(node.getAttribute('width') || '0', 0);
      const ih = parseLengthOr(node.getAttribute('height') || '0', 0);
      // SVG-content image: recursively walk the nested SVG with a
      // composed CTM that maps the inner viewBox into (ix, iy, iw, ih).
      // The outer <image>'s preserveAspectRatio governs fitting per
      // SVG 2 §13.6.6 (preserveAspectRatio on <image> applies to the
      // referenced content's intrinsic viewport).
      const innerRoot = nestedSvgRoots.get(node);
      if (innerRoot && iw > 0 && ih > 0) {
        // Read the inner viewBox (or width/height fallback).
        let ivb = innerRoot.getAttribute('viewBox') || '';
        let ivbX = 0, ivbY = 0, ivbW = 0, ivbH = 0;
        if (ivb) {
          const parts = ivb.trim().split(/[\s,]+/).map(Number);
          if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
            ivbX = parts[0]; ivbY = parts[1]; ivbW = parts[2]; ivbH = parts[3];
          }
        }
        if (ivbW <= 0 || ivbH <= 0) {
          // Fall back to inner width/height.
          ivbW = parseLengthOr(innerRoot.getAttribute('width') || '0', 0);
          ivbH = parseLengthOr(innerRoot.getAttribute('height') || '0', 0);
        }
        if (ivbW > 0 && ivbH > 0) {
          // Default PAR for <image>: xMidYMid meet.
          const parAttr = (node.getAttribute('preserveAspectRatio') || 'xMidYMid meet')
            .trim().toLowerCase();
          let alignX = 1, alignY = 1, meet = 1;  // mid/mid/meet defaults
          {
            const pParts = parAttr.split(/\s+/);
            const align = pParts[0] || '';
            if (align === 'none') { alignX = -1; alignY = -1; }
            else {
              const yIdx = align.indexOf('y');
              if (yIdx > 0 && yIdx + 4 <= align.length) {
                const xPart = align.substring(1, yIdx);
                const yPart = align.substring(yIdx + 1);
                alignX = xPart === 'min' ? 0 : xPart === 'max' ? 2 : 1;
                alignY = yPart === 'min' ? 0 : yPart === 'max' ? 2 : 1;
              }
            }
            if (pParts[1] && pParts[1] === 'slice') meet = 0;
          }
          let sx = iw / ivbW, sy = ih / ivbH;
          let tx = 0, ty = 0;
          if (alignX < 0) {
            // 'none' — non-uniform; sx, sy already independent.
          } else {
            // Uniform: pick min for meet, max for slice.
            const s = meet ? Math.min(sx, sy) : Math.max(sx, sy);
            sx = s; sy = s;
            const wScaled = ivbW * sx, hScaled = ivbH * sy;
            // Align in the outer rect.
            const slackX = iw - wScaled, slackY = ih - hScaled;
            if      (alignX === 0) tx = 0;
            else if (alignX === 2) tx = slackX;
            else                   tx = slackX * 0.5;
            if      (alignY === 0) ty = 0;
            else if (alignY === 2) ty = slackY;
            else                   ty = slackY * 0.5;
          }
          // CTM: outer * translate(ix+tx, iy+ty) * scale(sx, sy) * translate(-ivbX, -ivbY)
          // i.e. outerCtm applied to inner coords mapped into the outer rect.
          const t1 = matMul(ctm, [sx, 0, 0, sy, ix + tx - sx * ivbX, iy + ty - sy * ivbY]);
          // Walk the inner root's CHILDREN (not the root itself) so
          // the walker's nested-<svg> viewBox branch doesn't re-apply
          // the inner viewBox — we already baked it into t1.
          const innerKids = elementChildren(innerRoot);
          for (let i = 0; i < innerKids.length; i++) walk(innerKids[i], f, s, w, t1);
        }
        const kidsS = elementChildren(node);
        for (let i = 0; i < kidsS.length; i++) walk(kidsS[i], f, s, w, ctm);
        return true;
      }
      // Treat <image> as a rectangle at (x, y, width, height) sampling
      // its raster pixels in the cover frag. Build an axis-aligned rect
      // path under the current CTM.
      if (iw > 0 && ih > 0) {
        let segs = [
          mkLine([ix, iy], [ix+iw, iy]),
          mkLine([ix+iw, iy], [ix+iw, iy+ih]),
          mkLine([ix+iw, iy+ih], [ix, iy+ih]),
          mkLine([ix, iy+ih], [ix, iy]),
        ];
        if (ctm !== IDENT) {
          const xf = [];
          for (const sg of segs) transformSegInto(sg, ctm, xf);
          segs = xf;
        }
        const imageId = claimImage(node);
        // White fill so the cover frag's color × image-sample stays the
        // raw image color. Opacity respected via getShapeStyles.
        const styles = getShapeStyles(node, '#ffffff', 'none', 0);
        // image-rendering: pixelated / crisp-edges → nearest-neighbor
        // sample in the shader. SVG 2 + CSS Images 3 §5.3 — both keywords
        // request the same "sharp pixel boundaries" treatment.
        const irStr = (getStyleProp(node, 'image-rendering', '') || '')
                        .trim().toLowerCase();
        const pixelated = (irStr === 'pixelated' || irStr === 'crisp-edges') ? 1 : 0;
        // Mask / clip-path inheritance: <image> is a shape leaf
        // and consumes the same currentMaskRef / currentClipRef stack
        // entries as <path>, the same way <text> handles them.
        const _imgStyleMap   = parseStyleString(node.getAttribute('style') || '');
        const _imgRawClipStr = _imgStyleMap['clip-path'] || node.getAttribute('clip-path') || currentClipRef();
        const _imgRawMaskStr = _imgStyleMap['mask']      || node.getAttribute('mask')      || currentMaskRef();
        const _imgRawFilterStr = _imgStyleMap['filter']  || node.getAttribute('filter')   || currentFilterRef();
        const _imgClipRef    = resolveIdRef(_imgRawClipStr);
        const _imgMaskRef    = resolveIdRef(_imgRawMaskStr);
        const _imgFilterRef  = resolveIdRef(_imgRawFilterStr);
        const _imgReferencingShapeIdx = ctx.shapesData.length;
        const _imgClipId   = _imgClipRef   ? claimClip(_imgClipRef, _imgReferencingShapeIdx) : 0;
        const _imgMaskId   = _imgMaskRef   ? claimMask(_imgMaskRef, _imgReferencingShapeIdx) : 0;
        const _imgFilterId = _imgFilterRef ? claimFilter(_imgFilterRef) : 0;
        enqueueShape({
          segs,
          fillRgba: [1, 1, 1, styles.fillRgba[3] || 1],
          strokeRgba: [0, 0, 0, 0],
          sw: 0,
          fillRule: 'nonzero',
          capStyle: CAP_BUTT, joinStyle: JOIN_MITER, miterLimit: 4,
          fillGradId: 0, strokeGradId: 0,
          flagsShape: 0,
          dashArray: [], dashOffset: 0,
          clipId: _imgClipId, maskId: _imgMaskId,
          filterId: _imgFilterId, blendMode: 0, isolation: 0,
          imageId,
          // Image sampling needs em-space → uv mapping:
          imageRect: [ix, iy, iw, ih],
          pixelated,
        });
      }
      const kids = elementChildren(node);
      for (let i = 0; i < kids.length; i++) walk(kids[i], f, s, w, ctm);
      return true;
}
