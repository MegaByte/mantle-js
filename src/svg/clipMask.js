// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// <clipPath> + <mask> def registry.
//
// Registry only — actual shape extraction happens when the main walker
// re-enters in walkLayerMode=true mode, so transforms, <use>, dashes,
// gradients, images, cap/join/miter, nested patterns all work inside
// <clipPath> and <mask> with zero duplication.

import { getStyleProp, domFontSize } from './style.js';
import { parseLengthOr } from './length.js';
import { svgElementName, elementChildren, isFirstWithId } from './utils.js';

/// A <mask>'s REGION (CSS Masking 1 §7.1, SVG 1.1 §14.4): x/y/width/height in maskUnits -- objectBoundingBox (the
/// default: fractions of the referencing element's box; a percentage is a fraction too) or userSpaceOnUse (lengths in
/// the referencing element's user space; a percentage is of the root viewport, width for x/width and height for
/// y/height, as the filter region reads it). The initial values are -10%/-10%/120%/120% in either system. Outside the
/// region the mask is transparent black, so nothing of the masked element shows there. `stated` records whether the
/// author wrote any of the four.
export function maskRegionOf(el, vpRoot) {
  const oBB = (el.getAttribute('maskUnits') || 'objectBoundingBox').trim() !== 'userSpaceOnUse';
  // em is of the <mask>'s own computed font-size (CSS Values 4), not 16.
  const { fontSize, rootFontSize } = domFontSize(el);
  const num = (name, pct) => {
    const raw = el.getAttribute(name);
    const t =
      raw === null || raw === undefined || String(raw).trim() === ''
        ? `${pct}%`
        : String(raw).trim();
    return parseLengthOr(t, NaN, {
      parentWidth: oBB ? 1 : vpRoot[0],
      parentHeight: oBB ? 1 : vpRoot[1],
      axis: name === 'x' || name === 'width' ? 'x' : 'y',
      fontSize,
      rootFontSize,
    });
  };
  const stated = ['x', 'y', 'width', 'height'].some((a) => {
    const v = el.getAttribute(a);
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
  return {
    oBB,
    stated,
    x: num('x', -10),
    y: num('y', -10),
    w: num('width', 120),
    h: num('height', 120),
  };
}

/// The root viewport's width and height (its viewBox, else its width/height), which a userSpaceOnUse percentage is of.
export function rootViewportOf(root) {
  const attr = (n) => (root && root.getAttribute ? root.getAttribute(n) : null);
  const vb = String(attr('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return [vb[2], vb[3]];
  const w = parseFloat(attr('width')),
    h = parseFloat(attr('height'));
  return [w > 0 ? w : 0, h > 0 ? h : 0];
}

/// Returns { clipPaths: { [id]: { element, units, maskType } },
///           masks:     { [id]: { element, units, maskType, region } } }.
/// `element` is the DOM node; downstream walker code resolves it on
/// demand via the layer-mode pass. `region` is the mask's maskRegionOf.
export function parseClipsAndMasks(root) {
  const clipPaths = Object.create(null); // keyed by authored ids: `constructor` is an id like any other
  const masks = Object.create(null);
  const vpRoot = rootViewportOf(root);
  const visit = (el) => {
    const tag = svgElementName(el);
    if (tag === 'clippath' || tag === 'mask') {
      const id = el.getAttribute('id');
      if (id && isFirstWithId(root, el, id)) {
        // Content geometry units: clipPathUnits for <clipPath>,
        // maskContentUnits for <mask> — maskUnits governs the mask
        // REGION rect, not its children's coordinates, and its default
        // (objectBoundingBox) is the opposite of maskContentUnits'.
        const units = (
          tag === 'clippath'
            ? el.getAttribute('clipPathUnits') || 'userSpaceOnUse'
            : el.getAttribute('maskContentUnits') || 'userSpaceOnUse'
        ).trim();
        const maskType = tag === 'mask' ? maskTypeOf(el) : 'luminance';
        if (tag === 'clippath') clipPaths[id] = { element: el, units, maskType };
        else masks[id] = { element: el, units, maskType, region: maskRegionOf(el, vpRoot) };
      }
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);
  return { clipPaths, masks };
}

// mask-type is not inherited unless its computed value explicitly requests it.
function maskTypeOf(el) {
  if (!el || el.nodeType !== 1) return 'luminance';
  const value = String(getStyleProp(el, 'mask-type', 'luminance'))
    .trim()
    .toLowerCase();
  if (value === 'inherit') return maskTypeOf(el.parentNode);
  return value === 'alpha' ? 'alpha' : 'luminance';
}
