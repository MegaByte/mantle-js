// staticCache.js — static-scene cache state machine.
//
// The state machine maps each per-frame `tick(inputs)` call to one of:
//   - None: full coverage pipeline runs every frame.
//   - WholeAsset: whole asset rasterized into a viewport-sized target.
//   - ViewportWindow: viewport-plus-slack window for large pannable assets.
//           This tier is available only through ForceViewportWindow because it did not improve the
//           measured JS workloads enough to justify automatic promotion.
//   - SharedGroup: multiple handles with the same instance-group key share one
//           cache RT; bake runs once per invalidation event.
//
// Pure JS — no GL, no DOM. WebGL bake / blit lives in the renderer's
// enableStaticCache hookup.

/// Cache strategy selector exposed via renderer.enableStaticCache().
export const Strategy = Object.freeze({
  Auto:                0,
  AlwaysLive:          1,
  ForceWholeAsset:     2,
  ForceViewportWindow: 3,
  ForceSharedGroup:    4,
  // Deprecated aliases retained for 1.x source compatibility.
  ForceA1: 2,
  ForceA3: 4,
});

/// Resolved level for the current frame.
export const Level = Object.freeze({
  None:           0,
  WholeAsset:     1,
  ViewportWindow: 2,
  SharedGroup:    3,
  // Deprecated aliases retained for 1.x source compatibility.
  A1: 1,
  A3: 3,
});

/// Diagnostic reason for the current ResolvedLevel.
// Global auto-promotion budget (viewport-sized RTs are expensive; explicit opts bypass).
const AUTO_WHOLE_ASSET_BUDGET = 6;
let _autoPromotedCount = 0;
export const Reason = Object.freeze({
  Uninitialized:        0,
  UserOverride:         1,
  AnimatorActive:       2,
  MorphActive:          3,
  SizeUnstable:         4,
  AssetTransition:      5,
  GiantAssetPanning:    6,
  AssetFitsViewport:    7,
  InstanceGroupMember:  8,
  UnsupportedFeatures: 9,
});

/** @typedef {object} StaticCacheOptions
 * @property {number} [strategy]
 * @property {boolean} [autoBudgeted]
 * @property {number} [stabilityEpsilon]
 * @property {number} [stabilityPromoteFrames]
 * @property {number} [stabilityDemoteFrames]
 * @property {number} [viewportWindowGiantAssetFactor]
 * @property {number} [viewportWindowMarginPixels]
 * @property {string|null} [instanceGroupKey]
 * @property {object} [groupScope] Internal resource-owner scope.
 * @property {(group: SharedGroup) => void} [releaseSharedTarget] Internal resource cleanup.
 */

/** @typedef {object} StaticCacheInputs
 * @property {boolean} [hasAsset]
 * @property {boolean} [animatorActive]
 * @property {boolean} [morphActive]
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
 * @property {() => boolean} isGroupCacheValid
 * @property {() => void} invalidate
 * @property {() => void} invalidateLocal
 * @property {(frameNumber: number, bakeWm?: Float32Array|number[]|null) => void} markBaked
 * @property {(inputs: StaticCacheInputs) => void} tick
 * @property {() => void} dispose
 * @property {object} _cacheState Internal registry identity.
 */

// -------- Shared instance-group registry ------------------------------------
// When multiple handles share an asset and opt into ForceSharedGroup with a
// matching group key, the registry hands out a SINGLE GL cache RT per key.
// The first member to bake becomes the owner; siblings borrow the same RT.

/** @typedef {{ sharedTex: WebGLTexture|null, sharedFbo: WebGLFramebuffer|null,
 *             sharedRb: WebGLRenderbuffer|null,
 *             rtW: number, rtH: number, owner: object|null,
 *             ownerLastBakeFrame: number, bakeWm?: Float32Array|number[]|null,
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
    return { tex: g.sharedTex, fbo: g.sharedFbo, rb: g.sharedRb,
             rtW: g.rtW, rtH: g.rtH, group: g, bakeWm: g.bakeWm || null };
  }
  // Growing the shared RT: hand the old GL handles back so the caller
  // can free them (this registry is GL-free by design) — silently
  // overwriting leaked one texture+FBO per regrow.
  const retired = g.sharedTex
    ? { tex: g.sharedTex, fbo: g.sharedFbo, rb: g.sharedRb }
    : null;
  const created = ensureFbo(w, h);
  if (!created) return null;
  if (retired) {
    g.retired = retired;
    g.ownerLastBakeFrame = -1;   // the old bake lives in the retired RT
  }
  g.sharedTex = created.tex;
  g.sharedFbo = created.fbo;
  g.sharedRb = created.rb;
  g.rtW = created.rtW;
  g.rtH = created.rtH;
  g.owner = member;
  g.ownerLastBakeFrame = -1;
  return { tex: g.sharedTex, fbo: g.sharedFbo, rb: g.sharedRb,
           rtW: g.rtW, rtH: g.rtH, group: g };
}

function markSharedGroupBaked(key, frameNumber, bakeWm, member) {
  const g = key ? _groupsForMember(member).get(key) : null;
  if (g) {
    g.ownerLastBakeFrame = frameNumber;
    // The worldMatrix the shared RT was baked at. Borrowing members offset
    // their blit relative to THIS (not their own never-set bake wm) — without
    // it a borrower blitted at zero delta, landing the shared raster at the
    // OWNER's position (the ping-pong group member that never appeared).
    if (bakeWm) g.bakeWm = bakeWm;
  }
}

function isSharedGroupCacheValid(key, member) {
  if (!key) return false;
  const g = _groupsForMember(member).get(key);
  return !!(g && g.sharedTex && g.ownerLastBakeFrame >= 0);
}

/// Construct a fresh per-renderer cache state. The renderer owns one
/// of these; pass it to `tick({...})` once per frame to drive the
/// state machine.
/** @param {StaticCacheOptions} [opts]
 * @returns {StaticCache} */
export function createStaticCache(opts = {}) {
  // -------- Configuration --------
  const cfg = {
    strategy:               opts.strategy             ?? Strategy.Auto,
    autoBudgeted:           !!opts.autoBudgeted,
    stabilityEpsilon:       opts.stabilityEpsilon     ?? 0.05,
    stabilityPromoteFrames: opts.stabilityPromoteFrames ?? 15,
    stabilityDemoteFrames:  opts.stabilityDemoteFrames  ?? 3,
    viewportWindowGiantAssetFactor:
      opts.viewportWindowGiantAssetFactor ?? 1.5,
    viewportWindowMarginPixels:
      opts.viewportWindowMarginPixels ?? 256,
    releaseSharedTarget:
      typeof opts.releaseSharedTarget === 'function' ? opts.releaseSharedTarget : null,
  };

  // -------- Read-only diagnostics (state.* fields) --------
  const state = {
    // Mutable; reset by tick() each frame.
    resolvedLevel:         /** @type {number} */ (Level.None),
    resolvedReason:        /** @type {number} */ (Reason.Uninitialized),
    // Frame counter set by markBaked. -1 = never.
    lastBakeFrame:         -1,
    // Last footprint measured by tick().
    lastFootprintW:        0,
    lastFootprintH:        0,
    // True after a successful bake; flipped false on invalidate / level demotion.
    isCacheValid:          false,
    // Bumped on every invalidate() — engine compares against the RT's
    // baked generation to detect "RT contents are stale but level is
    // still WholeAsset" (e.g. content change while the level holds).
    cacheGeneration:       0,
    // Shared-group key. Null = not in a group.
    instanceGroupKey:      opts.instanceGroupKey ?? null,
    // Internal registry scope. Renderers pass their WebGL context so equal
    // user keys in separate contexts can never alias GL resources.
    _groupScope:           opts.groupScope ?? null,
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
  /// has been baked at least once since the last invalidation.
  function isGroupCacheValid() {
    if (!state.instanceGroupKey) return state.isCacheValid;
    return isSharedGroupCacheValid(state.instanceGroupKey, state);
  }

  /// Mark cache as freshly baked. Engine calls this after the RT bake
  /// succeeds. `frameNumber` is the engine's monotonic frame counter
  /// (gives diagnostics a sense of staleness).
  function markBaked(frameNumber, bakeWm) {
    state.isCacheValid = true;
    state.lastBakeFrame = frameNumber;
    if (state.instanceGroupKey) markSharedGroupBaked(state.instanceGroupKey, frameNumber, bakeWm, state);
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
    const firstFrame = _lastFootprintMagnitude === 0
                    && _stableFrames === 0
                    && _unstableFrames === 0;
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

    const sizeStable   = _stableFrames   >= cfg.stabilityPromoteFrames;
    const sizeUnstable = _unstableFrames >= cfg.stabilityDemoteFrames;

    if (sizeUnstable || !sizeStable) {
      return setResolved(Level.None, Reason.SizeUnstable);
    }

    // -------- Whole-asset vs giant-asset selection --------
    const giantX = inputs.viewportW > 0
                && fw > inputs.viewportW * cfg.viewportWindowGiantAssetFactor;
    const giantY = inputs.viewportH > 0
                && fh > inputs.viewportH * cfg.viewportWindowGiantAssetFactor;
    if (giantX || giantY) {
      // Keep Auto conservative. The larger window RT adds memory and bake work,
      // and did not win on the measured JS scenes. ForceViewportWindow remains available for
      // applications whose fill cost and pan cadence make the tradeoff worthwhile.
      return setResolved(Level.None, Reason.GiantAssetPanning);
    }

    // AUTO-DEFAULT BUDGET: auto-created caches (no explicit opts) hold a global
    // promotion budget — each whole-asset cache costs a viewport-sized target, so unbounded promotion
    // on many-handle scenes would blow GPU memory. Explicitly configured handles
    // bypass the budget (the caller opted in deliberately).
    if (cfg.autoBudgeted && state.resolvedLevel !== Level.WholeAsset) {
      if (_autoPromotedCount >= AUTO_WHOLE_ASSET_BUDGET) return setResolved(Level.None, Reason.SizeUnstable);
      _autoPromotedCount++;
      state._budgetHeld = true;
    }
    setResolved(Level.WholeAsset, Reason.AssetFitsViewport);
  }

  function setResolved(level, reason) {
      if (state._budgetHeld && level !== Level.WholeAsset) { _autoPromotedCount = Math.max(0, _autoPromotedCount - 1); state._budgetHeld = false; }
    // If we dropped out of a cached level, the cache RT is logically
    // invalid until the next bake at the new level.
    if (state.resolvedLevel !== Level.None && level === Level.None) {
      state.isCacheValid = false;
    }
    // Crossing between cached levels also invalidates (different RT layout).
    if (state.resolvedLevel !== level && level !== Level.None
        && state.resolvedLevel !== Level.None) {
      state.isCacheValid = false;
    }
    state.resolvedLevel = level;
    state.resolvedReason = reason;
  }

  if (state.instanceGroupKey) _acquireSharedGroup(state.instanceGroupKey, state);

  return {
    // State (read-only by convention)
    get resolvedLevel()   { return state.resolvedLevel; },
    get resolvedReason()  { return state.resolvedReason; },
    get lastBakeFrame()   { return state.lastBakeFrame; },
    get lastFootprintW()  { return state.lastFootprintW; },
    get lastFootprintH()  { return state.lastFootprintH; },
    get isCacheValid()    { return state.isCacheValid; },
    get cacheGeneration() { return state.cacheGeneration; },
    get strategy()        { return cfg.strategy; },
    get instanceGroupKey(){ return state.instanceGroupKey; },
    get viewportWindowMarginPixels() { return cfg.viewportWindowMarginPixels; },
    // Mutators
    setStrategy,
    setInstanceGroup,
    isGroupCacheValid,
    invalidate,
    invalidateLocal,
    markBaked,
    tick,
    dispose,
    // Internal identity for shared-group registry membership.
    _cacheState: state,
  };
}
