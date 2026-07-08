// <clipPath> + <mask> def registry.
//
// Registry only — actual shape extraction happens when the main walker
// re-enters in walkLayerMode=true mode, so transforms, <use>, dashes,
// gradients, images, cap/join/miter, nested patterns all work inside
// <clipPath> and <mask> with zero duplication.

import { elementChildren } from './utils.js';

/// Returns { clipPaths: { [id]: { element, units, maskType } },
///           masks:     { [id]: { element, units, maskType } } }.
/// `element` is the DOM node; downstream walker code resolves it on
/// demand via the layer-mode pass.
export function parseClipsAndMasks(root) {
  const clipPaths = {};
  const masks = {};
  const visit = el => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'clippath' || tag === 'mask') {
      const id = el.getAttribute('id');
      if (id) {
        const units = (el.getAttribute('clipPathUnits') || el.getAttribute('maskUnits') || 'userSpaceOnUse').trim();
        const maskType = (tag === 'mask'
          ? ((el.getAttribute('mask-type') || 'luminance').trim().toLowerCase())
          : 'luminance');
        (tag === 'clippath' ? clipPaths : masks)[id] = {
          element: el, units, maskType,
        };
      }
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);
  return { clipPaths, masks };
}
