// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importWalkStructure.js — the <image> leaf handler, split out of importWalk.js.
// Handles both raster <image> (emit an axis-aligned rect sampling the atlas)
// and SVG-content <image> (recursively walk the nested SVG via walkCtx.walk with
// a viewBox→rect fit matrix). Recurses through walkCtx.walk; the container
// dispatch (<g>/<use>/<symbol>/<switch>/nested <svg>) stays in importWalk.js.

import { resolveIdRef, elementChildren } from './utils.js';
import { parseLengthOr } from './length.js';
import {
  IDENT,
  matMul,
  matApply,
  transformSegInto,
  viewBoxFit,
  viewBoxDisablesRendering,
} from './transform.js';
import { GRAD_LINEAR, GRAD_PAD, GRAD_UNITS_USER } from './gradient.js';
import { mkLine, CAP_BUTT, JOIN_MITER } from './segment.js';
import { getStyleProp, getStrokeWidth, inheritedChannelOpacities, parseAlphaOr } from './style.js';

/// The referenced document's root viewBox [x, y, w, h], or null when absent or invalid.
function rootViewBox(root) {
  const parts = (root.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0
    ? parts
    : null;
}

/// A natural dimension of the referenced document: its root's width or height when that is a length,
/// or null for `auto` (the initial value), a percentage, or anything unusable.
function naturalLength(root, name) {
  const raw = (getStyleProp(root, name, '') || '').trim();
  if (!raw || raw === 'auto' || raw.endsWith('%')) return null;
  const v = parseLengthOr(raw, NaN);
  return v > 0 ? v : null;
}

/// The intrinsic size [w, h] of a referenced SVG document (SVG 2 §5.7, CSS Images 3 §5.1): its root's width and
/// height when both are lengths, else the one that is a length completed by its viewBox's ratio, else its viewBox's
/// size. null when it has no size to give.
function svgIntrinsicSize(root) {
  const vb = rootViewBox(root);
  const nw = naturalLength(root, 'width'),
    nh = naturalLength(root, 'height');
  if (nw && nh) return [nw, nh];
  if (vb) {
    if (nw) return [nw, (nw * vb[3]) / vb[2]];
    if (nh) return [(nh * vb[2]) / vb[3], nh];
    return [vb[2], vb[3]];
  }
  return null;
}

/// An <image>'s width or height attribute is `auto` (SVG 2 §5.7) when it is missing, empty or "auto".
const isAutoSize = (raw) => {
  const t = (raw || '').trim().toLowerCase();
  return t === '' || t === 'auto';
};

/// Where a raster image of the decoded size dw x dh lands in the positioning rectangle [x, y, w, h] under
/// preserveAspectRatio `parAttr` (SVG 1.1 §5.6: meet fits inside, slice covers, none stretches): the image's rect
/// F = [x, y, w, h] in the element's user space. An edge within rounding of the positioning rectangle's own is that
/// edge, so an image whose ratio already matches is exactly the positioning rectangle.
function rasterImageRect(dw, dh, parAttr, x, y, w, h) {
  const par = (parAttr || 'xMidYMid meet').trim().replace(/^defer\s+/i, '');
  const m = viewBoxFit(0, 0, dw, dh, par, x, y, w, h);
  const snap = (v, edge) => (Math.abs(v - edge) <= 1e-9 * (1 + Math.abs(edge)) ? edge : v);
  const x0 = snap(m[4], x),
    y0 = snap(m[5], y),
    x1 = snap(m[4] + m[0] * dw, x + w),
    y1 = snap(m[5] + m[3] * dh, y + h);
  return [x0, y0, x1 - x0, y1 - y0];
}

const overflowOf = (el) => (getStyleProp(el, 'overflow', '') || '').trim().toLowerCase();

/// Where an SVG <image> draws its referenced document: `fit` maps the document's user space into the
/// image's, `clip` is the axis-aligned rect [x0, y0, x1, y1] in the image's user space it is clipped
/// to (null: unclipped), and `viewport` [w, h] is what its percentages resolve against. P below is
/// the image's positioning rect, its x/y/width/height.
///
/// 'spec' (the default) is SVG 2 §image. The document's NATURAL aspect ratio is its root's width/height
/// when both are lengths, else its viewBox's; the image's preserveAspectRatio fits that ratio into P,
/// giving the image-rendering rect R (P itself for `none`, or when there is no ratio). R is the
/// document's viewport, and the root's own preserveAspectRatio is ignored (treated as `none`), so its
/// viewBox is stretched onto R. Without a viewBox nothing scales it: the content sits at R's origin in
/// the image's user units -- the reading of "the image-rendering rectangle defines the SVG viewport" in
/// the absence of a viewBox transform. The image's `overflow` (initially hidden) clips to P, the root's
/// (initially visible: it is its document's root) clips to R.
///
/// 'chrome' reproduces Chrome, which departs from the spec (importSvg({ compat: 'chrome' })). Unless the
/// image's preserveAspectRatio is `none`, the document's viewport is P itself and the ROOT's
/// preserveAspectRatio fits its viewBox there, the image's being ignored; a document with width/height
/// but no viewBox is stretched onto P. With `none` it is laid out at its concrete object size (CSS
/// default sizing, P as the default object size) and that is stretched onto P. Either way it is
/// clipped to P, whatever either overflow says.
function svgImagePlacement(node, root, ix, iy, iw, ih, mode) {
  const vb = rootViewBox(root);
  const nw = naturalLength(root, 'width'),
    nh = naturalLength(root, 'height');
  const ratio = nw && nh ? nw / nh : vb ? vb[2] / vb[3] : 0;
  // SVG 1.1's `defer` prefix is gone from SVG 2; what follows it is the value.
  const par = (node.getAttribute('preserveAspectRatio') || 'xMidYMid meet')
    .trim()
    .replace(/^defer\s+/i, '');
  const parNone = par.toLowerCase().split(/\s+/)[0] === 'none';
  if (mode === 'chrome') {
    const rootPar = root.getAttribute('preserveAspectRatio') || 'xMidYMid meet';
    const clip = [ix, iy, ix + iw, iy + ih];
    if (!parNone) {
      if (vb)
        return {
          fit: viewBoxFit(vb[0], vb[1], vb[2], vb[3], rootPar, ix, iy, iw, ih),
          clip,
          viewport: [vb[2], vb[3]],
        };
      if (nw && nh)
        return { fit: viewBoxFit(0, 0, nw, nh, 'none', ix, iy, iw, ih), clip, viewport: [nw, nh] };
      return { fit: [1, 0, 0, 1, ix, iy], clip, viewport: [iw, ih] };
    }
    let cw = nw || 0,
      ch = nh || 0;
    if (!(cw && ch)) {
      if (cw && ratio) ch = cw / ratio;
      else if (ch && ratio) cw = ch * ratio;
      else if (ratio) {
        cw = Math.min(iw, ih * ratio);
        ch = cw / ratio;
      } else {
        cw = cw || iw;
        ch = ch || ih;
      }
    }
    const inner = vb ? viewBoxFit(vb[0], vb[1], vb[2], vb[3], rootPar, 0, 0, cw, ch) : IDENT;
    return {
      fit: matMul([iw / cw, 0, 0, ih / ch, ix, iy], inner),
      clip,
      viewport: vb ? [vb[2], vb[3]] : [cw, ch],
    };
  }
  let rx = ix,
    ry = iy,
    rw = iw,
    rh = ih;
  if (ratio > 0 && !parNone) {
    const m = viewBoxFit(0, 0, ratio, 1, par, ix, iy, iw, ih);
    rx = m[4];
    ry = m[5];
    rw = m[0] * ratio;
    rh = m[3];
  }
  const fit = vb
    ? viewBoxFit(vb[0], vb[1], vb[2], vb[3], 'none', rx, ry, rw, rh)
    : [1, 0, 0, 1, rx, ry];
  let clip = null;
  const ov = overflowOf(node);
  if (ov !== 'visible' && ov !== 'auto') clip = [ix, iy, ix + iw, iy + ih];
  if (['hidden', 'scroll', 'clip'].includes(overflowOf(root))) {
    clip = clip
      ? [
          Math.max(clip[0], rx),
          Math.max(clip[1], ry),
          Math.min(clip[2], rx + rw),
          Math.min(clip[3], ry + rh),
        ]
      : [rx, ry, rx + rw, ry + rh];
  }
  return { fit, clip, viewport: vb ? [vb[2], vb[3]] : [rw, rh] };
}

/// Emit an <image> (or splice a nested SVG). Returns false when `tag` isn't an
/// image with decoded data (caller keeps dispatching); true when handled.
export function handleImageTag(walkCtx, node, tag, ctm, f, s, w, fo, so) {
  const {
    imageDataMap,
    nestedSvgRoots,
    walk,
    enqueueShape,
    claimImage,
    claimClip,
    claimMask,
    claimFilter,
    currentClipRef,
    currentMaskRef,
    currentFilterRef,
    ctx,
  } = walkCtx;
  if (tag !== 'image' || !imageDataMap.has(node)) return false;
  const decoded = imageDataMap.get(node);
  const vpX9 = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'x' } : undefined;
  const vpY9 = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'y' } : undefined;
  const ix = parseLengthOr(node.getAttribute('x') || '0', 0, vpX9);
  const iy = parseLengthOr(node.getAttribute('y') || '0', 0, vpY9);
  let iw = parseLengthOr(node.getAttribute('width') || '0', 0, vpX9);
  let ih = parseLengthOr(node.getAttribute('height') || '0', 0, vpY9);
  // A width or height that is auto (or missing) is the intrinsic one, scaled by the intrinsic ratio when only
  // one of the two is auto (SVG 2 §5.7): the bitmap's size, or the referenced document's.
  const autoW = isAutoSize(node.getAttribute('width')),
    autoH = isAutoSize(node.getAttribute('height'));
  if (autoW || autoH) {
    const innerForSize = nestedSvgRoots.get(node);
    const nat = innerForSize
      ? svgIntrinsicSize(innerForSize)
      : decoded && decoded.w > 0 && decoded.h > 0
        ? [decoded.w, decoded.h]
        : null;
    if (nat) {
      if (autoW && autoH) {
        iw = nat[0];
        ih = nat[1];
      } else if (autoW) iw = (ih * nat[0]) / nat[1];
      else ih = (iw * nat[1]) / nat[0];
    }
  }
  // SVG-content image: walk the referenced document's content with a CTM
  // that places it in (ix, iy, iw, ih) -- svgImagePlacement above, the
  // spec's placement or Chrome's (importSvg's compat). The document
  // is a separate one, so its content:
  //   - inherits nothing from the referencing element — its fill/stroke
  //     start from the import's defaults, then the inner root's own
  //     presentation attributes;
  //   - is clipped as the placement says;
  //   - composites as ONE GROUP under the <image>'s opacity /
  //     mix-blend-mode / isolation (and the inner root's opacity);
  //   - resolves percentages against its viewBox (its viewport without
  //     one), and its links are inert.
  // Its <defs> (gradients, clips, masks, filters, patterns, markers, <use>
  // targets) do NOT resolve: the def registries are the referencing
  // document's.
  const innerRoot = nestedSvgRoots.get(node);
  if (innerRoot && iw > 0 && ih > 0) {
    const place = svgImagePlacement(node, innerRoot, ix, iy, iw, ih, walkCtx.compat);
    const t1 = matMul(ctm, place.fit);
    const cl = place.clip;
    // An empty clip leaves nothing of the document to show.
    if ((!cl || (cl[2] > cl[0] && cl[3] > cl[1])) && !viewBoxDisablesRendering(innerRoot)) {
      if (cl) {
        walkCtx.narrowCurrentClip(
          walkCtx.viewportClipRef(
            node.ownerDocument,
            [
              [cl[0], cl[1]],
              [cl[2], cl[1]],
              [cl[2], cl[3]],
              [cl[0], cl[3]],
            ].map(([px, py]) => matApply(ctm, px, py)),
          ),
        );
      }
      const f0 = getStyleProp(innerRoot, 'fill', walkCtx.defaultFill);
      const s0 = getStyleProp(innerRoot, 'stroke', walkCtx.defaultStroke);
      const w0 = getStrokeWidth(innerRoot, walkCtx.defaultStrokeW, walkCtx.viewport);
      // A referenced document inherits nothing from the referencing one: its root starts from 1.
      const { fo: fo0, so: so0 } = inheritedChannelOpacities(innerRoot, 1, 1);
      const comp = walkCtx.groupCompositingOf(node);
      const rootOpacity = walkCtx.groupCompositingOf(innerRoot).opacity;
      const opacity = comp.opacity * rootOpacity;
      const grouped = opacity < 1 - 1e-6 || comp.blendMode !== 0 || comp.isolation === 1;
      if (grouped) {
        enqueueShape({
          kind: 'groupBegin',
          groupOpacity: opacity,
          blendMode: comp.blendMode,
          isolation: comp.isolation,
        });
      }
      const savedViewport = walkCtx.viewport;
      walkCtx.viewport = { parentWidth: place.viewport[0], parentHeight: place.viewport[1] };
      walkCtx._imageDocDepth++;
      try {
        const innerKids = elementChildren(innerRoot);
        const _inh = walkCtx.inheritanceChainOf(innerRoot.ownerDocument);
        _inh.push(innerRoot);
        try {
          for (let i = 0; i < innerKids.length; i++) walk(innerKids[i], f0, s0, w0, t1, fo0, so0);
        } finally {
          _inh.pop();
        }
      } finally {
        walkCtx._imageDocDepth--;
        walkCtx.viewport = savedViewport;
      }
      if (grouped) enqueueShape({ kind: 'groupEnd' });
    }
    const kidsS = elementChildren(node);
    for (let i = 0; i < kidsS.length; i++) walk(kidsS[i], f, s, w, ctm, fo, so);
    return true;
  }
  // Treat <image> as a rectangle at (x, y, width, height) sampling
  // its raster pixels in the cover frag. Build an axis-aligned rect
  // path under the current CTM.
  if (iw > 0 && ih > 0) {
    // The bitmap is placed in the x, y, width, height rectangle by preserveAspectRatio: meet and slice scale it
    // uniformly (default xMidYMid meet), none stretches it. The shape drawn is the part of the image's rect
    // inside the positioning rectangle, which is the whole rect for meet and none and the positioning rectangle
    // for slice, so the part sliced off paints nothing.
    const fit =
      decoded && decoded.w > 0 && decoded.h > 0
        ? rasterImageRect(
            decoded.w,
            decoded.h,
            node.getAttribute('preserveAspectRatio'),
            ix,
            iy,
            iw,
            ih,
          )
        : [ix, iy, iw, ih];
    const sx0 = Math.max(ix, fit[0]),
      sy0 = Math.max(iy, fit[1]);
    const sx1 = Math.min(ix + iw, fit[0] + fit[2]),
      sy1 = Math.min(iy + ih, fit[1] + fit[3]);
    let segs = [
      mkLine([sx0, sy0], [sx1, sy0]),
      mkLine([sx1, sy0], [sx1, sy1]),
      mkLine([sx1, sy1], [sx0, sy1]),
      mkLine([sx0, sy1], [sx0, sy0]),
    ];
    if (ctm !== IDENT) {
      const xf = [];
      for (const sg of segs) transformSegInto(sg, ctm, xf);
      segs = xf;
    }
    const imageId = claimImage(node);
    let imageRect = fit,
      imageMapId = 0;
    if (ctm[1] === 0 && ctm[2] === 0 && ctm[0] > 0 && ctm[3] > 0) {
      imageRect = [
        ctm[0] * fit[0] + ctm[4],
        ctm[3] * fit[1] + ctm[5],
        ctm[0] * fit[2],
        ctm[3] * fit[3],
      ];
    } else {
      // Images have no fill gradient. Its existing affine record stores
      // the image-to-document map for rotations, reflections and skew.
      ctx.gradientsUsed.push({
        gtype: GRAD_LINEAR,
        spread: GRAD_PAD,
        units: GRAD_UNITS_USER,
        gradient_transform: ctm.slice(),
        _carrierPlaced: true,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        stops: [{ offset: 0, color: [1, 1, 1, 1] }],
      });
      imageMapId = ctx.gradientsUsed.length;
    }
    // White fill so the cover frag's color × image-sample stays the
    // raw image color, at the element's OPACITY. An image has no fill,
    // so neither fill:none nor fill-opacity reaches it. Taking its alpha
    // from the fill (fill color x opacity x fill-opacity) with `|| 1`
    // would draw an image at opacity 0 fully opaque and dim one by its
    // fill-opacity.
    const _imgOpacity = Math.max(
      0,
      Math.min(1, parseAlphaOr(getStyleProp(node, 'opacity', '1'), 1)),
    );
    // image-rendering: pixelated / crisp-edges → nearest-neighbor
    // sample in the shader. SVG 2 + CSS Images 3 §5.3 — both keywords
    // request the same "sharp pixel boundaries" treatment.
    const irStr = (getStyleProp(node, 'image-rendering', '') || '').trim().toLowerCase();
    const pixelated = irStr === 'pixelated' || irStr === 'crisp-edges' ? 1 : 0;
    // Mask / clip-path inheritance: <image> is a shape leaf
    // and consumes the same currentMaskRef / currentClipRef stack
    // entries as <path>, the same way <text> handles them.
    // Stack alone: walk() already intersected own vs inherited clip-path.
    const _imgRawClipStr = currentClipRef();
    const _imgRawMaskStr = currentMaskRef(); // own mask included, placed in the image's user space
    const _imgOwnFilterValue = getStyleProp(node, 'filter', '') || node.getAttribute('filter');
    const _imgRawFilterStr = walkCtx.normFilter(_imgOwnFilterValue, node) || currentFilterRef();
    const _imgClipRef = resolveIdRef(_imgRawClipStr);
    const _imgMaskRef = resolveIdRef(_imgRawMaskStr);
    const _imgFilterRef = walkCtx.resolveFilterRef(_imgRawFilterStr, node);
    const _imgReferencingShapeIdx = ctx.shapesData.length;
    const _imgClipId = _imgClipRef ? claimClip(_imgClipRef, _imgReferencingShapeIdx) : 0;
    const _imgMaskId = _imgMaskRef ? claimMask(_imgMaskRef, _imgReferencingShapeIdx) : 0;
    // An image that names its filter ITSELF is a shape claim: the region, the primitive units and the lengths all resolve against its
    // own box and transform (the rect it paints). One inherited from a group keeps the older rule (a stated objectBoundingBox region).
    const _imgOwnFilter = !!_imgOwnFilterValue;
    const _imgFilterId = _imgFilterRef
      ? _imgOwnFilter
        ? claimFilter(_imgFilterRef, { own: true, ctm, shapeIdx: _imgReferencingShapeIdx })
        : claimFilter(_imgFilterRef, undefined, { ctm })
      : 0;
    // mix-blend-mode and isolation compose the image like any other element (Compositing 1 §3).
    const _imgComp = walkCtx.groupCompositingOf(node);
    enqueueShape({
      segs,
      fillRgba: [1, 1, 1, _imgOpacity],
      strokeRgba: [0, 0, 0, 0],
      sw: 0,
      fillRule: 'nonzero',
      capStyle: CAP_BUTT,
      joinStyle: JOIN_MITER,
      miterLimit: 4,
      fillGradId: imageMapId,
      strokeGradId: 0,
      flagsShape: 0,
      dashArray: [],
      dashOffset: 0,
      clipId: _imgClipId,
      maskId: _imgMaskId,
      filterId: _imgFilterId,
      blendMode: _imgComp.blendMode,
      isolation: _imgComp.isolation,
      imageId,
      // Image sampling needs em-space → uv mapping:
      imageRect,
      pixelated,
    });
  }
  const kids = elementChildren(node);
  for (let i = 0; i < kids.length; i++) walk(kids[i], f, s, w, ctm, fo, so);
  return true;
}
