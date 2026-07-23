// drawDispatch.js — drawBundle / drawBundleInstanced / drawInstance entry points.

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachDrawDispatch(R) {
  const { setBundle, render, paletteChannelToInt, _analyticRoute, _canvasUnsized } = R;

  /// Once per frame, before any geometry is bound: let the fill pass finish and pipeline-warm a
  /// variant whose link has completed. Hooked here rather than in beginFrame because consumers
  /// reach the renderer through several frame entries (render(), handle.draw(), instanced), and
  /// a warm that never runs is worse than useless — it looks like it works.
  function warmTick() {
    if (!R.fillWarmTick) return;
    // Not keyed on R._frameSerial: that is only bumped by beginFrame(), and consumers that drive
    // the renderer through render()/handle.draw() never call it — the guard would then compare
    // undefined to undefined and never fire. Throttle on wall clock instead: at most one
    // pipeline build per ~frame.
    const now = performance.now();
    if (now - (R._warmAt || 0) < 8) return;
    R._warmAt = now;
    R.fillWarmTick();
  }

  function clearDrawState() {
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

  function drawBundle(target, opts) {
    warmTick();
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
    // Node clips must be resolved BEFORE the route gate: _analyticRoute
    // declines when an external clip is set, so registering a clip via
    // setNodeClip forces the Slug path (handle.draw already orders it this
    // way — resolving after the gate silently dropped the clip on
    // LB-routed bundles).
    try {
      R._autoNodeClip(bundle);
      if (!_analyticRoute(bundle, { bare: _bareBundle })) {
        if (R._lbSlugFallback) render();   // LB-only ('only' mode): no Slug fallback → draw nothing
      } else {
        // render() draws the debug overlays at the end of its pass; the analytic route never
        // enters it, so it must draw them itself — over ITS mesh, which is the one on screen.
        R._drawDebugOverlays(bundle, true);
      }
    } finally {
      clearDrawState();
    }
  }

  // ---- per-instance color helpers (drawBundleInstanced) -------------------
  // Per-instance color state is defined at the colorMatrix stage:
  //   c' = sharedCM · ( instCM · ( diag(tint) · c ) + instOff ) + sharedOff
  // i.e. the instance tint applies first (as a diagonal matrix), then the
  // instance matrix+offset, then the shared matrix+offset. The GPU fast path
  // implements diag(tint) via the vertex override-tint multiply — identical
  // math when channelLerp is off (multiplication commutes past the paint
  // eval); full per-instance matrices take the per-instance loop below,
  // where the stages are composed into ONE effective matrix+offset.
  // All matrices are 16-float COLUMN-MAJOR (the uniformMatrix4fv layout —
  // same convention as drawBundle's opts.colorMatrix).
  function _mat4MulInto(o, A, B) {       // o = A·B, column-major flat
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  let _fastColorScratch = null;
  let _fastColorCap = 0;
  // The loop consumes this state synchronously in render(), so one pair of
  // scratch buffers avoids allocating matrices and offsets for every copy.
  const _loopColorMatrix = new Float32Array(16);
  const _loopColorTintMatrix = new Float32Array(16);
  const _loopColorOffset = new Float32Array(4);
  function _setEffInstColor(inst, sharedCM, sharedOff) {
    const t = inst.tint, iM = inst.colorMatrix, iO = inst.colorMatrixOffset;
    if (!t && !iM && !iO) {
      R.draw.colorMatrix = sharedCM;
      R.draw.colorMatrixOffset = sharedOff;
      return;
    }

    let innerM = iM;
    if (t) {
      const tr = t[0], tg = t[1], tb = t[2];
      const ta = (t.length > 3 && t[3] != null) ? t[3] : 1;
      if (iM) {
        for (let c = 0; c < 4; c++) {
          const scale = c === 0 ? tr : c === 1 ? tg : c === 2 ? tb : ta;
          const p = c * 4;
          _loopColorTintMatrix[p] = iM[p] * scale;
          _loopColorTintMatrix[p + 1] = iM[p + 1] * scale;
          _loopColorTintMatrix[p + 2] = iM[p + 2] * scale;
          _loopColorTintMatrix[p + 3] = iM[p + 3] * scale;
        }
      } else {
        _loopColorTintMatrix.fill(0);
        _loopColorTintMatrix[0] = tr;
        _loopColorTintMatrix[5] = tg;
        _loopColorTintMatrix[10] = tb;
        _loopColorTintMatrix[15] = ta;
      }
      innerM = _loopColorTintMatrix;
    }

    let m = innerM;
    if (sharedCM && innerM) {
      _mat4MulInto(_loopColorMatrix, sharedCM, innerM);
      m = _loopColorMatrix;
    } else if (sharedCM) {
      m = sharedCM;
    }

    let off = iO;
    if (iO && sharedCM) {
      for (let r = 0; r < 4; r++) {
        _loopColorOffset[r] = sharedCM[r] * iO[0] + sharedCM[4 + r] * iO[1]
          + sharedCM[8 + r] * iO[2] + sharedCM[12 + r] * iO[3]
          + (sharedOff ? sharedOff[r] : 0);
      }
      off = _loopColorOffset;
    } else if (iO && sharedOff) {
      for (let r = 0; r < 4; r++) _loopColorOffset[r] = iO[r] + sharedOff[r];
      off = _loopColorOffset;
    } else if (!iO) {
      off = sharedOff;
    }
    R.draw.colorMatrix = m;
    R.draw.colorMatrixOffset = off;
  }

  /** drawBundleInstanced(target, instances, shared) — draw ONE bundle at N
   *  transforms with per-instance worldMatrix/alpha/tint (and optionally a
   *  full per-instance colorMatrix+offset), sharing the bundle geometry AND
   *  a single `shared.overrides` table across every instance. The bundle is
   *  bound ONCE (the per-mount setBundle + intermediate bakes run a single
   *  time, reused via the mask-bake + filter caches).
   *
   *  Routing:
   *  - GPU fast path (one drawArraysInstanced): simple fill-only bundles,
   *    per-instance worldMatrix + alpha + rgba `tint` as instanced vertex
   *    attributes. Taken when no instance carries a full colorMatrix/offset
   *    (a tint IS instanced natively) and, if any instance is tinted, no
   *    shared channelLerp is active (ordering vs the lerp would diverge
   *    from the composed-matrix semantics below).
   *  - Per-instance loop otherwise (masks/filters/clips/9-slice/_lbStream,
   *    or per-instance colorMatrix/colorMatrixOffset): each instance's
   *    tint/matrix/offset is composed with the shared matrix into ONE
   *    effective colorMatrix per instance — pixel-equivalent to the fast
   *    path for the states both support.
   *
   *  @param {object} target  bundle or animation handle (auto-unwrapped).
   *  @param {Array<{worldMatrix?, alpha?, tint?, colorMatrix?, colorMatrixOffset?}>} instances
   *    worldMatrix: 9-float column-major mat3; alpha: [0,1] multiplier;
   *    tint: [r,g,b,a] multiplicative rgba (≡ diagonal colorMatrix);
   *    colorMatrix/colorMatrixOffset: 16/4-float, column-major (loop path).
   *  @param {object} [shared] overrides/colorMatrix/colorMatrixOffset/palette/
   *    paletteChannel/channelLerp — applied to every instance.
   *  @returns {number} instances drawn.
   */
  function drawBundleInstanced(target, instances, shared) {
    warmTick();
    if (R._contextLost) return 0;
    if (!target) return 0;
    if (!Array.isArray(instances) || instances.length === 0) return 0;
    const bundle = target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return 0;
    // Bind the bundle ONCE — the per-mount cost (setBundle, and on first
    // render the mask bake + filter eval) is paid a single time; the
    // mask-bake + filter caches make every subsequent instance reuse those bakes.
    // Simple instancing uses its own compact mesh cache. Avoid uploading the
    // normal cover VBO into this transient handle unless the fallback loop
    // actually reaches render().
    setBundle(bundle, { deferCoverUpload: true });
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
    // Per-instance color-state scan: a full colorMatrix/offset can't ride the
    // instanced attributes (5 extra vec4 slots would blow the 16-attribute
    // floor) → loop path. A tint IS instanced natively, unless a shared
    // channelLerp is active (the fast path's tint multiplies BEFORE the lerp;
    // the loop's composed matrix applies AFTER — keep one semantic).
    // A diagonal colour matrix plus offset maps exactly to the fast path's
    // per-instance tint and bias attributes. General matrices use the loop path.
    const _isDiagCm = (m) => {
      if (!m) return true;
      for (let i = 0; i < 16; i++) {
        if (i % 5 === 0) continue;                       // diagonal
        if (Math.abs(m[i]) > 1e-6) return false;          // a real matrix — needs the loop
      }
      return true;
    };
    let _anyInstCM = false, _anyInstTint = false, _hasDiagInstColor = false;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (!inst) continue;
      if (inst.colorMatrix || inst.colorMatrixOffset) {
        // Diagonal → it IS a tint + bias, so stay on the fast path.
        if (!_isDiagCm(inst.colorMatrix)) { _anyInstCM = true; break; } // a real matrix → the loop
        _hasDiagInstColor = true;
        _anyInstTint = true;
        continue;
      }
      if (inst.tint) _anyInstTint = true;
    }
    // GPU instancing fast path: a fill-only bundle paints all N copies in one
    // drawArraysInstanced per chunk. Skipped for _lbStream (no cover-quad VBO),
    // when capturing frames for SVG export (the loop records each instance), or
    // when the bundle isn't simple / the program fails to build.
    try {
      // …and NOT when the analytic route would serve a PLAIN-FILL instanced draw.
      // The fast path is Slug-only, so taking it made the engine a property of the
      // CALL SITE rather than of the bundle: the same content painted by Slug when
      // drawn instanced and by LB when drawn through a handle — so enabling
      // something as unrelated as a static cache silently swapped renderers (a
      // per-mount cache breaks the caller's instancing run). Ask the same question
      // in both places. LB's 'auto' gate inside _lbWouldServe is what keeps
      // many-small-instance content — sprites, text — on the instanced Slug path,
      // where one drawArraysInstanced genuinely beats N analytic draws.
      //
      // PER-INSTANCE COLOUR KEEPS THE FAST PATH. A tint rides the instanced vertex
      // attributes, so N tinted copies still cost ONE draw; routing them per-instance
      // through LB would trade that batching away. The engine can still differ by
      // call site for those, but paying N analytic draws to eliminate that
      // difference would cost more than preserving the instanced path.
      const _lbOverInstanced = R._lbWouldServe(bundle) && !_anyInstCM && !_anyInstTint;
      const instFastOff = R.mantleDebugFlag('noInstancedFast');
      if (!instFastOff && !_lbStreamed && R._instancedFastEnabled && instances.length >= 2 && !(R._captureFrames && R._inFrame) &&
          !_anyInstCM && !(_anyInstTint && shared.channelLerp) &&
          !_canvasUnsized() && !_lbOverInstanced && R._simpleInstanceable(bundle, R._handle) &&
          R._ensureInstProg(R._instancedEngineDefines ? R._instancedEngineDefines(bundle) : [])) {
        let packedColor = null;
        if (_hasDiagInstColor) {
          const needed = instances.length * 8;
          if (_fastColorCap < needed) {
            _fastColorCap = Math.max(needed, _fastColorCap ? _fastColorCap * 2 : 64);
            _fastColorScratch = new Float32Array(_fastColorCap);
          }
          packedColor = _fastColorScratch;
          for (let i = 0; i < instances.length; i++) {
            const inst = instances[i] || {};
            const tint = inst.tint;
            const cm = inst.colorMatrix;
            const off = inst.colorMatrixOffset;
            const p = i * 8;
            const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
            const ta = tint && tint[3] != null ? tint[3] : 1;
            packedColor[p] = tr * (cm ? cm[0] : 1);
            packedColor[p + 1] = tg * (cm ? cm[5] : 1);
            packedColor[p + 2] = tb * (cm ? cm[10] : 1);
            packedColor[p + 3] = ta * (cm ? cm[15] : 1);
            packedColor[p + 4] = off ? off[0] : 0;
            packedColor[p + 5] = off ? off[1] : 0;
            packedColor[p + 6] = off ? off[2] : 0;
            packedColor[p + 7] = off ? (off[3] || 0) : 0;
          }
        }
        return R._drawBundleInstancedFast(bundle, instances, packedColor);
      }
      // Shared-bake bundles stay on Slug so the bake is reused across instances.
      const _instSlug = !_lbStreamed && R._instancedPrefersSlug(bundle, R._handle);
      const _hasInstColor = _anyInstCM || _anyInstTint;
      let drawn = 0;
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i] || {};
        R.draw.worldM = inst.worldMatrix || null;
        R.draw.alpha  = (typeof inst.alpha === 'number')
          ? Math.max(0, Math.min(1, inst.alpha)) : 1.0;
        if (_hasInstColor) {
          // Compose tint ∘ instance-CM ∘ shared-CM into ONE effective pair.
          // Instances without their own color state fall back to the shared
          // pair (reset each iteration — a prior instance may have replaced it).
          _setEffInstColor(inst, shared.colorMatrix || null, shared.colorMatrixOffset || null);
        }
        if (R._captureFrames && R._inFrame) R._recordBundleDraw(bundle, {
          worldMatrix: inst.worldMatrix, alpha: inst.alpha,
          overrides: shared.overrides,
          colorMatrix: _hasInstColor ? R.draw.colorMatrix : shared.colorMatrix,
          colorMatrixOffset: _hasInstColor ? R.draw.colorMatrixOffset : shared.colorMatrixOffset,
          palette: shared.palette,
          paletteChannel: shared.paletteChannel, channelLerp: shared.channelLerp,
        });
        if (_instSlug || !_analyticRoute(bundle, { streamOnly: true })) {
          if (R._lbSlugFallback) render();
        }
        drawn++;
      }
      return drawn;
    } finally {
      clearDrawState();
    }
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
