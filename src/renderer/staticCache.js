// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// staticCache.js — static-scene cache state machine.

// Pure JS — no GL, no DOM. WebGL bake / blit lives in the renderer's
// enableStaticCache hookup.

/// Cache strategy selector exposed via renderer.enableStaticCache().
export const Strategy = Object.freeze({
  Auto: 0,
  AlwaysLive: 1,
  ForceWholeAsset: 2,
  ForceViewportWindow: 3,
  ForceSharedGroup: 4,
  // Deprecated aliases retained for 1.x source compatibility.
  ForceA1: 2,
  ForceA3: 4,
});

/// Resolved level for the current frame.
export const Level = Object.freeze({
  None: 0,
  WholeAsset: 1,
  ViewportWindow: 2,
  SharedGroup: 3,
  // Deprecated aliases retained for 1.x source compatibility.
  A1: 1,
  A3: 3,
});

/// Diagnostic reason for the current ResolvedLevel.
// Global auto-promotion budget (viewport-sized RTs are expensive; explicit opts bypass).
const AUTO_WHOLE_ASSET_BUDGET = 6;
let _autoPromotedCount = 0;
export const Reason = Object.freeze({
  Uninitialized: 0,
  UserOverride: 1,
  AnimatorActive: 2,
  MorphActive: 3,
  SizeUnstable: 4,
  AssetTransition: 5,
  GiantAssetPanning: 6,
  AssetFitsViewport: 7,
  InstanceGroupMember: 8,
  UnsupportedFeatures: 9,
  // Auto only: live redraw is cheap enough that a viewport bake+blit would
  // add overhead. Selected by a complexity heuristic (not a live cadence probe).
  LiveCheaper: 10,
});

/** @typedef {object} StaticCacheOptions
 * @property {number} [strategy]
 * @property {boolean} [autoBudgeted]
 * @property {number} [stabilityEpsilon]
 * @property {number} [stabilityPromoteFrames]
 * @property {number} [stabilityDemoteFrames]
 * @property {number} [viewportWindowGiantAssetFactor]
 * @property {number} [viewportWindowMarginPixels]
 * @property {number} [minLiveComplexityForCache] Auto only: below this, stay live.
 * @property {number} [minCoverageForCache] Auto only: footprint/viewport area below this stays live.
 * @property {string|null} [instanceGroupKey]
 * @property {object} [groupScope] Internal resource-owner scope.
 * @property {(group: SharedGroup) => void} [releaseSharedTarget] Internal resource cleanup.
 */

/** @typedef {object} StaticCacheInputs
 * @property {boolean} [hasAsset]
 * @property {boolean} [animatorActive]
 * @property {boolean} [morphActive]
 * @property {boolean} [dynamicContent] Rasterized content changed since the last
 *   tick (override table, per-draw visual state, or bundle geometry generation).
 *   Unlike the Auto-only disqualifiers this also demotes FORCED strategies —
 *   a forced cache would otherwise blit a raster of the previous content.
 * @property {number} [liveComplexity] Auto only: approximate cost of drawing
 *   live, compared against `minLiveComplexityForCache`.
 * @property {number} [footprintW]
 * @property {number} [footprintH]
 * @property {number} [viewportW]
 * @property {number} [viewportH]
 * @property {boolean} [cacheCompatible]
 * @property {boolean} [viewportWindowCompatible]
 * @property {boolean} [sharedGroupCompatible]
 */

/** @typedef {object} StaticCache
 * @property {number} resolvedLevel
 * @property {number} resolvedReason
 * @property {number} lastBakeFrame
 * @property {number} lastFootprintW
 * @property {number} lastFootprintH
 * @property {boolean} isCacheValid
 * @property {number} cacheGeneration
 * @property {number} strategy
 * @property {string|null} instanceGroupKey
 * @property {number} viewportWindowMarginPixels
 * @property {(strategy: number) => void} setStrategy
 * @property {(key: string|null) => void} setInstanceGroup
 * @property {(contentKey?: string|null) => boolean} isGroupCacheValid
 * @property {() => void} invalidate
 * @property {() => void} invalidateLocal
 * @property {(frameNumber: number, bakeWm?: Float32Array|number[]|null,
 *             contentKey?: string|null) => void} markBaked
 * @property {() => boolean} groupRasterStale
 * @property {() => void} noteGroupRasterWrite
 * @property {(contentKey: string|null|undefined, frame: number) => boolean} groupRasterTaken
 * @property {(frame: number) => void} noteGroupBlit
 * @property {(rect: number[]|null|undefined) => void} setGroupContentRect
 * @property {() => number[]|null} groupContentRect
 * @property {(inputs: StaticCacheInputs) => void} tick
 * @property {() => void} dispose
 * @property {object} _cacheState Internal registry identity.
 */

/** @typedef {{ sharedTex: WebGLTexture|null, sharedFbo: WebGLFramebuffer|null,
 *             sharedRb: WebGLRenderbuffer|null,
 *             rtW: number, rtH: number, owner: object|null,
 *             ownerLastBakeFrame: number, bakeWm?: Float32Array|number[]|null,
 *             contentKey?: string|null, contentRect?: number[]|null,
 *             rasterSerial: number, lastBlitBy: object|null, lastBlitFrame: number,
 *             retired?: {tex: WebGLTexture|null, fbo: WebGLFramebuffer|null,
 *                       rb: WebGLRenderbuffer|null}|null,
 *             members: Set<object> }} SharedGroup */

/** Unscoped registry used by direct state-machine consumers. */
const _sharedGroups = new Map();
/** Renderer-created caches are isolated by WebGL context. */
const _scopedSharedGroups = new WeakMap();

function _groupsFor(scope) {
  if ((typeof scope !== 'object' && typeof scope !== 'function') || scope === null)
    return _sharedGroups;
  let groups = _scopedSharedGroups.get(scope);
  if (!groups) {
    groups = new Map();
    _scopedSharedGroups.set(scope, groups);
  }
  return groups;
}

function _groupsForMember(member) {
  return _groupsFor(member && member._groupScope);
}

function _acquireSharedGroup(key, member) {
  if (!key) return null;
  const groups = _groupsForMember(member);
  let g = groups.get(key);
  if (!g) {
    g = {
      sharedTex: null,
      sharedFbo: null,
      sharedRb: null,
      rtW: 0,
      rtH: 0,
      owner: null,
      ownerLastBakeFrame: -1,
      bakeWm: null,
      contentKey: null,
      // Bumped whenever the raster is written over; a member remembers the serial it took. Its own isCacheValid cannot see a sibling's bake (the raster is shared, the flag is not).
      rasterSerial: 0,
      contentRect: null,
      lastBlitBy: null, // who drew from the raster last, and when (renderer frame): a raster in use is not baked over for different content
      lastBlitFrame: 0,
      members: new Set(),
    };
    groups.set(key, g);
  }
  g.members.add(member);
  if (!g.owner) g.owner = member;
  return g;
}

function _releaseSharedGroup(key, member) {
  if (!key) return null;
  const groups = _groupsForMember(member);
  const g = groups.get(key);
  if (!g || !g.members.delete(member)) return null;
  if (g.owner === member) {
    g.owner = g.members.size > 0 ? g.members.values().next().value : null;
  }
  if (g.members.size === 0) {
    groups.delete(key);
    return g;
  }
  return null;
}

/// Borrow or allocate a group-shared cache RT. Returns null when not in a
/// group. `ensureFbo(rtW, rtH, alloc)` is called by the renderer to create
/// GL resources when the group needs a new/larger RT.
export function borrowSharedGroupTarget(key, member, rtW, rtH, ensureFbo) {
  const g = _acquireSharedGroup(key, member);
  if (!g) return null;
  const w = Math.max(16, rtW | 0);
  const h = Math.max(16, rtH | 0);
  if (g.sharedTex && g.rtW === w && g.rtH === h) {
    return {
      tex: g.sharedTex,
      fbo: g.sharedFbo,
      rb: g.sharedRb,
      rtW: g.rtW,
      rtH: g.rtH,
      group: g,
      bakeWm: g.bakeWm || null,
    };
  }
  // Growing the shared RT: hand the old GL handles back so the caller
  // can free them (this registry is GL-free by design) — silently
  // overwriting leaked one texture+FBO per regrow.
  const retired = g.sharedTex ? { tex: g.sharedTex, fbo: g.sharedFbo, rb: g.sharedRb } : null;
  const created = ensureFbo(w, h);
  if (!created) return null;
  if (retired) {
    g.retired = retired;
    g.ownerLastBakeFrame = -1; // the old bake lives in the retired RT
  }
  g.sharedTex = created.tex;
  g.sharedFbo = created.fbo;
  g.sharedRb = created.rb;
  g.rtW = created.rtW;
  g.rtH = created.rtH;
  g.owner = member;
  g.ownerLastBakeFrame = -1;
  noteRasterWritten(g); // a new target holds nothing yet
  return { tex: g.sharedTex, fbo: g.sharedFbo, rb: g.sharedRb, rtW: g.rtW, rtH: g.rtH, group: g };
}

function noteRasterWritten(g) {
  g.rasterSerial++;
  g.contentKey = null;
  g.contentRect = null;
  g.lastBlitBy = null;
}

function markSharedGroupBaked(key, frameNumber, bakeWm, member, contentKey) {
  const g = key ? _groupsForMember(member).get(key) : null;
  if (g) {
    g.ownerLastBakeFrame = frameNumber;
    member._groupRaster = g.rasterSerial;
    // The worldMatrix the shared RT was baked at. Borrowing members offset
    // their blit relative to this (not their own never-set bake wm) — without
    // it a borrower would blit at zero delta, landing the shared raster at the
    // OWNER's position (a group member that never appears).
    if (bakeWm) g.bakeWm = bakeWm;
    // What the shared raster DEPICTS (geometry generation + per-draw visual
    // state). Members sharing a key still differ in override table / alpha /
    // palette, and adopting a sibling's bake then shows the sibling's colors.
    if (contentKey !== undefined) g.contentKey = contentKey ?? null;
  }
}

function isSharedGroupCacheValid(key, member, contentKey) {
  if (!key) return false;
  const g = _groupsForMember(member).get(key);
  if (!(g && g.sharedTex && g.ownerLastBakeFrame >= 0)) return false;
  // Only compare when both sides named their content: a caller that tracks no
  // key keeps the pre-key behavior of adopting whatever the group last baked.
  if (contentKey != null && g.contentKey != null && g.contentKey !== contentKey) return false;
  return true;
}

/// Construct a fresh per-renderer cache state. The renderer owns one
/// of these; pass it to `tick({...})` once per frame to drive the
/// state machine.
/** @param {StaticCacheOptions} [opts]
 * @returns {StaticCache} */
export function createStaticCache(opts = {}) {
  // -------- Configuration --------
  const cfg = {
    strategy: opts.strategy ?? Strategy.Auto,
    autoBudgeted: !!opts.autoBudgeted,
    stabilityEpsilon: opts.stabilityEpsilon ?? 0.05,
    stabilityPromoteFrames: opts.stabilityPromoteFrames ?? 15,
    stabilityDemoteFrames: opts.stabilityDemoteFrames ?? 3,
    viewportWindowGiantAssetFactor: opts.viewportWindowGiantAssetFactor ?? 1.5,
    viewportWindowMarginPixels: opts.viewportWindowMarginPixels ?? 256,
    // Auto cost gate (no live CACHED↔DIRECT cadence probe).
    // A viewport-sized bake+blit has fixed GPU overhead; below these thresholds
    // the blit is usually slower than redrawing. Forced strategies ignore them.
    minLiveComplexityForCache: opts.minLiveComplexityForCache ?? 48,
    // WholeAsset RTs are viewport-sized. Auto must not promote a small card on a
    // large canvas — that allocates and fills a fullscreen target for little gain.
    minCoverageForCache: opts.minCoverageForCache ?? 0.45,
    releaseSharedTarget:
      typeof opts.releaseSharedTarget === 'function' ? opts.releaseSharedTarget : null,
  };

  // -------- Read-only diagnostics (state.* fields) --------
  const state = {
    // Mutable; reset by tick() each frame.
    resolvedLevel: /** @type {number} */ (Level.None),
    resolvedReason: /** @type {number} */ (Reason.Uninitialized),
    // Frame counter set by markBaked. -1 = never.
    lastBakeFrame: -1,

    lastFootprintW: 0,
    lastFootprintH: 0,
    // True after a successful bake; flipped false on invalidate / level demotion.
    isCacheValid: false,
    // Bumped on every invalidate() — engine compares against the RT's
    // baked generation to detect "RT contents are stale but level is
    // still WholeAsset" (e.g. content change while the level holds).
    cacheGeneration: 0,
    // Shared-group key. Null = not in a group.
    instanceGroupKey: opts.instanceGroupKey ?? null,
    // Internal registry scope. Renderers pass their WebGL context so equal
    // user keys in separate contexts can never alias GL resources.
    _groupScope: opts.groupScope ?? null,
  };

  // -------- Private hysteresis state --------
  let _stableFrames = 0;
  let _unstableFrames = 0;
  let _lastFootprintMagnitude = 0;

  // -------- API --------

  /// Force the cache to invalidate. Engine calls this on bundle swap /
  /// content change. Bumps generation so the bake path knows to re-run.
  function invalidate() {
    state.isCacheValid = false;
    state.cacheGeneration++;
    if (state.instanceGroupKey) {
      const g = _groupsForMember(state).get(state.instanceGroupKey);
      if (g) g.ownerLastBakeFrame = -1;
    }
  }

  // Invalidate only this member's view of the target. SharedGroup uses this on canvas
  // resize: one member may already have rebuilt the group RT at the new size,
  // so a stale sibling must adopt that bake instead of invalidating it globally.
  function invalidateLocal() {
    state.isCacheValid = false;
    state.cacheGeneration++;
  }

  /// Set the user strategy override.
  /// Invalidates the cache because crossing AlwaysLive↔Auto changes the
  /// level resolution.
  function setStrategy(s) {
    if (cfg.strategy === s) return;
    cfg.strategy = s;
    invalidate();
  }

  /// Opt into target sharing as a member of a named group. Pass null to leave.
  function setInstanceGroup(key) {
    if (_disposed) return;
    if (state.instanceGroupKey === key) return;
    if (state.instanceGroupKey) {
      const released = _releaseSharedGroup(state.instanceGroupKey, state);
      if (released && cfg.releaseSharedTarget) cfg.releaseSharedTarget(released);
      state.isCacheValid = false;
    }
    state.instanceGroupKey = key || null;
    if (state.instanceGroupKey) _acquireSharedGroup(state.instanceGroupKey, state);
    invalidate();
  }

  /// True when this cache is a shared-group member AND the group's target
  /// has been baked at least once since the last invalidation. Pass the
  /// caller's `contentKey` to refuse a bake that depicts different content.
  function isGroupCacheValid(contentKey) {
    if (!state.instanceGroupKey) return state.isCacheValid;
    return isSharedGroupCacheValid(state.instanceGroupKey, state, contentKey);
  }

  /// Mark cache as freshly baked. Engine calls this after the RT bake
  /// succeeds. `frameNumber` is the engine's monotonic frame counter
  /// (gives diagnostics a sense of staleness). `contentKey` identifies WHAT
  /// was rasterized, so shared-group siblings only adopt a matching bake.
  function markBaked(frameNumber, bakeWm, contentKey) {
    state.isCacheValid = true;
    state.lastBakeFrame = frameNumber;
    if (state.instanceGroupKey)
      markSharedGroupBaked(state.instanceGroupKey, frameNumber, bakeWm, state, contentKey);
  }

  const _group = () =>
    state.instanceGroupKey ? _groupsForMember(state).get(state.instanceGroupKey) : null;
  /// A valid member whose raster was written over since it took it: by a sibling's bake (its own flag cannot say). It adopts or bakes again before it blits.
  function groupRasterStale() {
    const g = _group();
    return !!g && state._groupRaster !== g.rasterSerial;
  }
  /// This member is about to write the shared raster. A bake that is then refused (deferred) has still written it, so this is noted before the first pixel, not at markBaked.
  function noteGroupRasterWrite() {
    const g = _group();
    if (g) {
      noteRasterWritten(g);
      g.ownerLastBakeFrame = -1;
    }
  }
  /// Does another member draw from the raster (this renderer frame or the last), and does the raster show something else? One raster cannot show two contents: baking over it would
  /// make that member bake back, each a full bake per frame, so the member that finds it taken draws live until it is free.
  function groupRasterTaken(contentKey, frame) {
    const g = _group();
    return (
      !!g &&
      g.contentKey != null &&
      contentKey != null &&
      g.contentKey !== contentKey &&
      g.lastBlitBy !== null &&
      g.lastBlitBy !== state &&
      frame - g.lastBlitFrame <= 1
    );
  }
  function noteGroupBlit(frame) {
    const g = _group();
    if (g) {
      g.lastBlitBy = state;
      g.lastBlitFrame = frame;
    }
  }
  /// The box of the content in the shared raster (GL px, the bake's coordinates), which belongs to the raster and not to whoever draws from it.
  function setGroupContentRect(rect) {
    const g = _group();
    if (g) g.contentRect = rect;
  }
  function groupContentRect() {
    const g = _group();
    return g ? g.contentRect : null;
  }

  let _disposed = false;
  function dispose() {
    if (_disposed) return;
    _disposed = true;
    if (state._budgetHeld) {
      _autoPromotedCount = Math.max(0, _autoPromotedCount - 1);
      state._budgetHeld = false;
    }
    if (state.instanceGroupKey) {
      const released = _releaseSharedGroup(state.instanceGroupKey, state);
      if (released && cfg.releaseSharedTarget) cfg.releaseSharedTarget(released);
      state.instanceGroupKey = null;
    }
    state.isCacheValid = false;
  }

  /// Run one frame of eligibility detection. Updates resolvedLevel +
  /// resolvedReason + lastFootprint{W,H} + hysteresis counters.
  ///
  /// inputs = {
  ///   hasAsset:        bool — bundle bound + ready to draw
  ///   animatorActive:  bool — per-frame override table is producing changes
  ///   morphActive:     bool — shape morph t is not at an endpoint
  ///   footprintW/H:    int  — projected on-screen pixel size of the asset
  ///   viewportW/H:     int  — current viewport size in pixels
  ///   cacheCompatible: bool — false for mutable screen-space dependencies
  ///   viewportWindowCompatible/sharedGroupCompatible: per-level feature gates
  /// }
  /** @param {StaticCacheInputs} inputs */
  function tick(inputs) {
    if (_disposed) return setResolved(Level.None, Reason.AssetTransition);
    state.lastFootprintW = inputs.footprintW | 0;
    state.lastFootprintH = inputs.footprintH | 0;

    // -------- Content invalidation (applies to FORCED strategies too) --------
    // A raster can only stand in for content that did not change since it was
    // taken. `dynamicContent` reports the frame in which the override table,
    // per-draw visual state, or bundle geometry generation moved — the bake is
    // then a picture of the PREVIOUS frame, so drop it and draw live. Forcing a
    // strategy opts into the cost of caching, never into showing stale pixels.
    // (AlwaysLive is unaffected: it never caches, so it keeps its own reason.)
    if (inputs.dynamicContent && cfg.strategy !== Strategy.AlwaysLive) {
      _stableFrames = 0;
      invalidate();
      return setResolved(Level.None, Reason.AnimatorActive);
    }

    // -------- User-override fast paths --------
    switch (cfg.strategy) {
      case Strategy.AlwaysLive:
        return setResolved(Level.None, Reason.UserOverride);
      case Strategy.ForceWholeAsset:
        if (inputs.cacheCompatible === false)
          return setResolved(Level.None, Reason.UnsupportedFeatures);
        return setResolved(Level.WholeAsset, Reason.UserOverride);
      case Strategy.ForceViewportWindow:
        if (inputs.cacheCompatible === false || inputs.viewportWindowCompatible === false)
          return setResolved(Level.None, Reason.UnsupportedFeatures);
        return setResolved(Level.ViewportWindow, Reason.UserOverride);
      case Strategy.ForceSharedGroup:
        if (inputs.cacheCompatible === false || inputs.sharedGroupCompatible === false)
          return setResolved(Level.None, Reason.UnsupportedFeatures);
        return setResolved(Level.SharedGroup, Reason.UserOverride);
      // case Strategy.Auto: fall through.
    }

    // -------- Disqualifiers (any → None) --------
    if (!inputs.hasAsset) {
      _stableFrames = 0;
      return setResolved(Level.None, Reason.AssetTransition);
    }
    if (inputs.animatorActive) {
      _stableFrames = 0;
      invalidate();
      return setResolved(Level.None, Reason.AnimatorActive);
    }
    if (inputs.morphActive) {
      _stableFrames = 0;
      invalidate();
      return setResolved(Level.None, Reason.MorphActive);
    }
    if (inputs.cacheCompatible === false) {
      return setResolved(Level.None, Reason.UnsupportedFeatures);
    }

    // -------- Size-stability check --------
    const fw = state.lastFootprintW;
    const fh = state.lastFootprintH;
    const footprintMag = Math.max(fw, fh);
    const firstFrame =
      _lastFootprintMagnitude === 0 && _stableFrames === 0 && _unstableFrames === 0;
    let stableThisFrame;
    if (firstFrame) {
      stableThisFrame = true;
    } else {
      const delta = Math.abs(footprintMag - _lastFootprintMagnitude);
      const relDelta = footprintMag > 1e-6 ? delta / footprintMag : 0;
      stableThisFrame = relDelta <= cfg.stabilityEpsilon;
    }
    _lastFootprintMagnitude = footprintMag;

    if (stableThisFrame) {
      _unstableFrames = 0;
      if (_stableFrames < 0x7fffffff) _stableFrames++;
    } else {
      _stableFrames = 0;
      if (_unstableFrames < 0x7fffffff) _unstableFrames++;
      invalidate();
    }

    const sizeStable = _stableFrames >= cfg.stabilityPromoteFrames;
    const sizeUnstable = _unstableFrames >= cfg.stabilityDemoteFrames;

    if (sizeUnstable || !sizeStable) {
      return setResolved(Level.None, Reason.SizeUnstable);
    }

    // -------- Whole-asset vs giant-asset selection --------
    const giantX =
      inputs.viewportW > 0 && fw > inputs.viewportW * cfg.viewportWindowGiantAssetFactor;
    const giantY =
      inputs.viewportH > 0 && fh > inputs.viewportH * cfg.viewportWindowGiantAssetFactor;
    if (giantX || giantY) {
      return setResolved(Level.None, Reason.GiantAssetPanning);
    }

    // -------- Live-cost heuristic (Auto only) --------
    // Prefer live when a viewport-sized bake+blit is unlikely to beat redraw.
    // WholeAsset always allocates a full-viewport RT — at native fullscreen
    // (e.g. 3456×2234) that is tens of MB and a full-screen fill even for a
    // small card. Coverage gates that; complexity catches near-fullscreen
    // light scenes. Forced strategies skip both — the caller opted in.
    // (A live CACHED↔DIRECT cadence probe would itself cost frames and cause
    // early drops.)
    {
      const vpArea = Math.max(1, (inputs.viewportW | 0) * (inputs.viewportH | 0));
      const coverage = Math.min(1, (Math.max(0, fw) * Math.max(0, fh)) / vpArea);
      if (coverage < cfg.minCoverageForCache) {
        return setResolved(Level.None, Reason.LiveCheaper);
      }
      if (
        typeof inputs.liveComplexity === 'number' &&
        inputs.liveComplexity < cfg.minLiveComplexityForCache
      ) {
        return setResolved(Level.None, Reason.LiveCheaper);
      }
    }

    // Auto-default budget: auto-created caches (no explicit opts) hold a global
    // promotion budget — each whole-asset cache costs a viewport-sized target, so unbounded promotion
    // on many-handle scenes would blow GPU memory. Explicitly configured handles
    // bypass the budget (the caller opted in deliberately).
    if (cfg.autoBudgeted && state.resolvedLevel !== Level.WholeAsset) {
      if (_autoPromotedCount >= AUTO_WHOLE_ASSET_BUDGET)
        return setResolved(Level.None, Reason.SizeUnstable);
      _autoPromotedCount++;
      state._budgetHeld = true;
    }
    setResolved(Level.WholeAsset, Reason.AssetFitsViewport);
  }

  function setResolved(level, reason) {
    if (state._budgetHeld && level !== Level.WholeAsset) {
      _autoPromotedCount = Math.max(0, _autoPromotedCount - 1);
      state._budgetHeld = false;
    }

    if (state.resolvedLevel !== Level.None && level === Level.None) {
      state.isCacheValid = false;
    }
    // Crossing between cached levels also invalidates (different RT layout).
    if (
      state.resolvedLevel !== level &&
      level !== Level.None &&
      state.resolvedLevel !== Level.None
    ) {
      state.isCacheValid = false;
    }
    state.resolvedLevel = level;
    state.resolvedReason = reason;
  }

  if (state.instanceGroupKey) _acquireSharedGroup(state.instanceGroupKey, state);

  return {
    // State (read-only by convention)
    get resolvedLevel() {
      return state.resolvedLevel;
    },
    get resolvedReason() {
      return state.resolvedReason;
    },
    get lastBakeFrame() {
      return state.lastBakeFrame;
    },
    get lastFootprintW() {
      return state.lastFootprintW;
    },
    get lastFootprintH() {
      return state.lastFootprintH;
    },
    get isCacheValid() {
      return state.isCacheValid;
    },
    get cacheGeneration() {
      return state.cacheGeneration;
    },
    get strategy() {
      return cfg.strategy;
    },
    get instanceGroupKey() {
      return state.instanceGroupKey;
    },
    get viewportWindowMarginPixels() {
      return cfg.viewportWindowMarginPixels;
    },
    // Mutators
    setStrategy,
    setInstanceGroup,
    isGroupCacheValid,
    invalidate,
    invalidateLocal,
    markBaked,
    groupRasterStale,
    noteGroupRasterWrite,
    groupRasterTaken,
    noteGroupBlit,
    setGroupContentRect,
    groupContentRect,
    tick,
    dispose,
    // Internal identity for shared-group registry membership.
    _cacheState: state,
  };
}
