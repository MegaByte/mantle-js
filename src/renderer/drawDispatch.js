// drawDispatch.js — the public per-bundle draw entry points, split out of
// renderer.js: drawBundle, drawBundleInstanced, drawInstance.
//
// Each resolves target→bundle, binds it (R.setBundle), stamps the per-draw
// recolor state, routes through the centralized analytic dispatch
// (R._analyticRoute) or falls back to the Slug render (R.render), then clears
// the per-draw state. This is per-draw-CALL work (not per-shape), so reading/
// writing the per-draw state + _handle/_inFrame/… through their R get/set
// bridges is cheap. _analyticRoute stays in renderer.js (it closes over the
// route internals); this module just calls R._analyticRoute. attachDrawDispatch
// runs after the Object.assign that publishes the destructured helpers; the
// drawSprites module reaches R.drawBundle/R.drawBundleInstanced at call time.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachDrawDispatch(R) {
  const { setBundle, render, paletteChannelToInt, _analyticRoute, _canvasUnsized } = R;

  function drawBundle(target, opts) {
    if (R._contextLost) return;
    if (!target) return;
    // Accept either a bundle directly, or an animation handle that
    // owns a bundle (createShapeMorph, createShapeTimeline,
    // createSpatialBezierMorph, createPathDeltaMorph, createSkinnedMorph,
    // createPoseStack — anything with a `.bundle` getter). Consumers
    // never have to manually unwrap: pass the morph/timeline and the
    // current frame's data is bound automatically. Re-binding each
    // draw call is cheap (per-asset dirty flag short-circuits when
    // the same bundle is bound back-to-back); ensures timelines that
    // internally rebuild a morph across bracket boundaries don't need
    // a re-`setBundle` from the caller.
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    if (R._captureFrames && R._inFrame) R._recordBundleDraw(bundle, opts);
    setBundle(bundle);
    R.draw.overrides = (opts && opts.overrides) || null;
    R.draw.worldM = (opts && opts.worldMatrix) || null;
    // opts.alpha as a uniform multiplier (mantle.vert: uDrawAlpha →
    // ovTint.a *= uDrawAlpha). Works on bare bundles (no override
    // table required) AND on bundles with overrides — the override
    // buffer's stored tint stays unmodified across draws, so
    // animator-driven flows that own the override buffer can keep
    // mutating tint independently without the alpha multiplier
    // accumulating or clobbering their values.
    //
    // The uniform path is unconditional and cheaper than folding
    // the alpha into the override buffer.
    R.draw.alpha = (opts && typeof opts.alpha === 'number')
      ? Math.max(0, Math.min(1, opts.alpha))
      : 1.0;
    R.draw.colorMatrix       = (opts && opts.colorMatrix) || null;
    R.draw.colorMatrixOffset = (opts && opts.colorMatrixOffset) || null;
    R.draw.palette = (opts && opts.palette) || null;
    R.draw.paletteChannel = paletteChannelToInt(opts && opts.paletteChannel);
    R.draw.channelLerp = (opts && opts.channelLerp) || null;
    R.draw.extClipTex = (opts && opts.extClipTex) || null;
    R.draw.extClipMode = (opts && opts.extClipMode) | 0;
    // Loop-Blinn fill route (opt-in via setLoopBlinnFill). When the whole
    // bundle qualifies it renders through the analytic implicit mesh instead of
    // the Slug ray-cast; anything unsupported → render() (Slug). POLICY: route
    // STATIC bundles only (see _analyticRoute + the _geomGen gate).
    const _bareBundle = target.bundle === undefined;
    if (!_analyticRoute(bundle, { bare: _bareBundle })) {
      R._autoNodeClip(bundle);
      if (R._lbSlugFallback) render();   // LB-only ('only' mode): no Slug fallback → draw nothing
    }
    R.draw.overrides = null;
    R.draw.worldM = null;
    R.draw.alpha = 1.0;
    R.draw.colorMatrix = null;
    R.draw.colorMatrixOffset = null;
    R.draw.palette = null;
    R.draw.paletteChannel = 0;
    R.draw.channelLerp = null;
    R.draw.extClipTex = null;
    R.draw.extClipMode = 0;
  }

  /** drawBundleInstanced(target, instances, shared) — draw ONE bundle at N
   *  transforms with per-instance worldMatrix/alpha, sharing the bundle
   *  geometry AND a single `shared.overrides` table across every instance.
   *  The bundle is bound ONCE (the per-mount setBundle + intermediate bakes
   *  run a single time, reused via the mask-bake + filter caches); only the fill pass
   *  repeats per instance. Live-fill counterpart to R.drawImageInstanced.
   *  @param {object} target  bundle or animation handle (auto-unwrapped).
   *  @param {Array<{worldMatrix?, alpha?}>} instances
   *  @param {object} [shared] overrides/colorMatrix/colorMatrixOffset/palette/
   *    paletteChannel/channelLerp — applied to every instance.
   *  @returns {number} instances drawn.
   */
  function drawBundleInstanced(target, instances, shared) {
    if (R._contextLost) return 0;
    if (!target) return 0;
    if (!Array.isArray(instances) || instances.length === 0) return 0;
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return 0;
    // Bind the bundle ONCE — the per-mount cost (setBundle, and on first
    // render the mask bake + filter eval) is paid a single time; the
    // mask-bake + filter caches make every subsequent instance reuse those bakes.
    setBundle(bundle);
    shared = shared || {};
    R.draw.overrides         = shared.overrides || null;
    R.draw.colorMatrix       = shared.colorMatrix || null;
    R.draw.colorMatrixOffset = shared.colorMatrixOffset || null;
    R.draw.palette           = shared.palette || null;
    R.draw.paletteChannel    = paletteChannelToInt(shared.paletteChannel);
    R.draw.channelLerp       = shared.channelLerp || null;
    // A lightweight-streamed bundle has no Slug cover-quad VBO, so the Slug
    // instancing fast path + render() loop can't paint it — route each instance
    // through the analytic fill (which honors the per-instance worldMatrix).
    const _lbStreamed = !!(bundle && bundle._lbStream);
    // GPU instancing fast path: a fill-only bundle paints all N copies in one
    // drawArraysInstanced per chunk. Skipped for _lbStream (no cover-quad VBO),
    // when capturing frames for SVG export (the loop records each instance), or
    // when the bundle isn't simple / the program fails to build.
    if (!_lbStreamed && R._instancedFastEnabled && instances.length >= 2 && !(R._captureFrames && R._inFrame) &&
        !_canvasUnsized() && R._simpleInstanceable(bundle, R._handle) && R._ensureInstProg()) {
      const drawnFast = R._drawBundleInstancedFast(bundle, instances);
      R.draw.overrides = null; R.draw.worldM = null; R.draw.alpha = 1.0;
      R.draw.colorMatrix = null; R.draw.colorMatrixOffset = null;
      R.draw.palette = null; R.draw.paletteChannel = 0; R.draw.channelLerp = null;
      return drawnFast;
    }
    // A bundle whose render rides a shared bake (mask/clip/filter/COLR/blend)
    // stays on Slug in this loop: Slug bakes it ONCE and reuses across instances,
    // whereas per-instance analytic composite redoes it N times. Simple bundles
    // (no shared bake) route the analytic fill; a lightweight _lbStream bundle
    // always routes (no Slug geometry). Computed ONCE (bundle bound once).
    const _instSlug = !_lbStreamed && R._instancedPrefersSlug(bundle, R._handle);
    let drawn = 0;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i] || {};
      R.draw.worldM = inst.worldMatrix || null;
      R.draw.alpha  = (typeof inst.alpha === 'number')
        ? Math.max(0, Math.min(1, inst.alpha)) : 1.0;
      // Record each instance as its own bundle draw (shared paint +
      // per-instance worldMatrix/alpha) so SVG export replays the full
      // instanced fan-out.
      if (R._captureFrames && R._inFrame) R._recordBundleDraw(bundle, {
        worldMatrix: inst.worldMatrix, alpha: inst.alpha,
        overrides: shared.overrides, colorMatrix: shared.colorMatrix,
        colorMatrixOffset: shared.colorMatrixOffset, palette: shared.palette,
        paletteChannel: shared.paletteChannel, channelLerp: shared.channelLerp,
      });
      // Each instance routes through the centralized analytic dispatch at its
      // own worldMatrix (streamOnly: a _lbStream bundle has no Slug VBO).
      // Shared-bake bundles skip the analytic route → Slug (bake-once reuse).
      if (_instSlug || !_analyticRoute(bundle, { streamOnly: true })) { if (R._lbSlugFallback) render(); }   // LB-only → no Slug fallback
      drawn++;
    }
    R.draw.overrides = null;
    R.draw.worldM = null;
    R.draw.alpha = 1.0;
    R.draw.colorMatrix = null;
    R.draw.colorMatrixOffset = null;
    R.draw.palette = null;
    R.draw.paletteChannel = 0;
    R.draw.channelLerp = null;
    return drawn;
  }

  /** Draw a single bundle's fill pass into the currently-bound framebuffer
   *  with caller-supplied per-instance state. Skips the frame-lifecycle
   *  auto-clear: the caller owns the outer state (viewport, clear, blend,
   *  depth); Mantle owns the inner fill-pass setup. Each call is a fresh
   *  per-asset bind so per-bundle texture state never leaks across instances.
   *  Same option semantics as drawBundle (bundle/handle auto-unwrapped). */
  function drawInstance(bundle, opts) {
    if (R._contextLost) return;
    if (!bundle) return;
    const wasInFrame = R._inFrame;
    // Flip _inFrame=true so render()'s auto-clear is suppressed. The caller's
    // framebuffer state is preserved on exit (wasInFrame restored below).
    R._inFrame = true;
    try {
      drawBundle(bundle, opts);
    } finally {
      R._inFrame = wasInFrame;
    }
  }

  R.drawBundle = drawBundle;
  R.drawBundleInstanced = drawBundleInstanced;
  R.drawInstance = drawInstance;
}
