// drawSprites.js — drawSprite, sprite sheet addressing.

import { mantleWarn } from '../core/diagnostics.js';

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachDrawSprites(R) {
  const _warnedNonContig = new Set();
  function _resolveSpriteRange(bundle, sprite) {
    if (Array.isArray(sprite) && sprite.length === 2) return [sprite[0] | 0, sprite[1] | 0];
    if (typeof sprite !== 'string') return null;
    const ranges = bundle && bundle.spriteRanges;
    const r = ranges && ranges[sprite];
    if (!r) {
      mantleWarn('[Mantle] drawSprite: unknown sprite id "' + sprite
        + '". Available: ' + (ranges ? Object.keys(ranges).join(', ') || '(none)' : '(no spriteRanges)'));
      return null;
    }
    const nc = bundle.spriteRangesNonContiguous;
    if (nc && nc.indexOf(sprite) >= 0 && !_warnedNonContig.has(sprite)) {
      _warnedNonContig.add(sprite);
      mantleWarn('[Mantle] drawSprite: sprite "' + sprite + '" has a '
        + 'non-contiguous shape range (a vector pattern or clip child is '
        + 'interleaved); the subset draw will also include those shapes.');
    }
    return r;
  }

  function drawSprite(target, sprite, opts) {
    if (R._contextLost || !target) return false;
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return false;
    const range = _resolveSpriteRange(bundle, sprite);
    if (!range) return false;
    R.draw.shapeRange = range;
    R.draw.spriteKey = typeof sprite === 'string' ? sprite : null;
    // The analytic route slices the combined VBO by assuming a sprite's shapes are a CONTIGUOUS
    // run. When the importer flagged this sprite as non-contiguous (a vector pattern or clip
    // child interleaved) that assumption fails, so the route falls back to Slug.
    const ncList = bundle.spriteRangesNonContiguous;
    R.draw.spriteNonContig = !!(ncList && typeof sprite === 'string' && ncList.indexOf(sprite) >= 0);
    try { R.drawBundle(target, opts); }
    finally { R.draw.shapeRange = null; R.draw.spriteKey = null; R.draw.spriteNonContig = false; }
    return true;
  }

  function drawSpriteInstanced(target, sprite, instances, shared) {
    if (R._contextLost || !target) return 0;
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return 0;
    const range = _resolveSpriteRange(bundle, sprite);
    if (!range) return 0;
    R.draw.shapeRange = range;
    R.draw.spriteKey = typeof sprite === 'string' ? sprite : null;
    let n = 0;
    try { n = R.drawBundleInstanced(target, instances, shared); }
    finally { R.draw.shapeRange = null; R.draw.spriteKey = null; }
    return n;
  }

  R.drawSprite = drawSprite;
  R.drawSpriteInstanced = drawSpriteInstanced;
}
