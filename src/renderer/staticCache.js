// staticCache.js — static-scene cache state machine.
//
// The state machine maps each per-frame `tick(inputs)` call to one of:
//   - None: full coverage pipeline runs every frame.
//   - A1:   whole asset rasterized into an RT sized to on-screen pixel
//           footprint. Per-frame cost: one textured-quad draw.
//   - A3:   multiple handles with the same instance-group key share one
//           cache RT; bake runs once per invalidation event.
//
// A2 (viewport-clamped for giant pannable assets) is intentionally a
// no-op: the cache RT is already viewport-sized, so clamping a projected
// world footprint to the viewport has nothing to reduce here.
//
// Pure JS — no GL, no DOM. WebGL bake / blit lives in the renderer's
// enableStaticCache hookup.

/// Cache strategy selector exposed via renderer.enableStaticCache().
export const Strategy = Object.freeze({
  Auto:       0,
  AlwaysLive: 1,
  ForceA1:    2,
  ForceA2:    3,  // Intentional no-op: the cache RT is already viewport-sized.
  ForceA3:    4,  // Instance-group sharing; pair with setInstanceGroup().
});

/// Resolved level for the current frame.
export const Level = Object.freeze({
  None: 0,
  A1:   1,
  A2:   2,  // No-op; tick always demotes A2 → None.
  A3:   3,
});

/// Diagnostic reason for the current ResolvedLevel.
// Global auto-promotion budget (viewport-sized RTs are expensive; explicit opts bypass).
const AUTO_A1_BUDGET = 6;
let _autoPromotedCount = 0;
export const Reason = Object.freeze({
  Uninitialized:        0,
  UserOverride:         1,
  AnimatorActive:         2,
  MorphActive:          3,
  SizeUnstable:         4,
  AssetTransition:      5,
  GiantAssetPanning:    6,
  AssetFitsViewport:    7,
  InstanceGroupMember:  8,
  /// Engine-side feature gate: A2 not wired on this runtime.
  LevelNotImplemented:  9,
});

// -------- A3 instance-group registry -----------------------------------------
// When multiple handles share an asset and opt into Strategy=ForceA3 with a
// matching group key, the registry hands out a SINGLE GL cache RT per key.
// The first member to bake becomes the owner; siblings borrow the same RT.

/** @typedef {{ sharedTex: WebGLTexture|null, sharedFbo: WebGLFramebuffer|null,
 *             rtW: number, rtH: number, owner: object|null,
 *             ownerLastBakeFrame: number, bakeWm?: Float32Array|number[]|null,
 *             members: Set<object> }} A3Group */

/** @type {Map<string, A3Group>} */
const _a3Groups = new Map();

function _acquireA3Group(key, member) {
  if (!key) return null;
  let g = _a3Groups.get(key);
  if (!g) {
    g = {
      sharedTex: null,
      sharedFbo: null,
      rtW: 0,
      rtH: 0,
      owner: null,
      ownerLastBakeFrame: -1,
      bakeWm: null,
      members: new Set(),
    };
    _a3Groups.set(key, g);
  }
  g.members.add(member);
  if (!g.owner) g.owner = member;
  return g;
}

function _releaseA3Group(key, member) {
  if (!key) return;
  const g = _a3Groups.get(key);
  if (!g || !g.members.delete(member)) return;
  if (g.owner === member) {
    g.owner = g.members.size > 0 ? g.members.values().next().value : null;
  }
  if (g.members.size === 0) {
    _a3Groups.delete(key);
  }
}

export function releaseA3GroupMember(key, member, onEmpty) {
  if (!key) return;
  const g = _a3Groups.get(key);
  if (!g || !g.members.has(member)) return;
  const emptying = g.members.size === 1;
  _releaseA3Group(key, member);
  if (emptying && onEmpty) onEmpty(g);
}

/// Borrow or allocate a group-shared cache RT. Returns null when not in a
/// group. `ensureFbo(rtW, rtH, alloc)` is called by the renderer to create
/// GL resources when the group needs a new/larger RT.
export function borrowA3GroupRt(key, member, rtW, rtH, ensureFbo) {
  const g = _acquireA3Group(key, member);
  if (!g) return null;
  const w = Math.max(16, rtW | 0);
  const h = Math.max(16, rtH | 0);
  if (g.sharedTex && g.rtW >= w && g.rtH >= h) {
    return { tex: g.sharedTex, fbo: g.sharedFbo, rtW: g.rtW, rtH: g.rtH, group: g, bakeWm: g.bakeWm || null };
  }
  const created = ensureFbo(w, h);
  if (!created) return null;
  g.sharedTex = created.tex;
  g.sharedFbo = created.fbo;
  g.rtW = created.rtW;
  g.rtH = created.rtH;
  g.owner = member;
  g.ownerLastBakeFrame = -1;
  return { tex: g.sharedTex, fbo: g.sharedFbo, rtW: g.rtW, rtH: g.rtH, group: g };
}

export function markA3GroupBaked(key, frameNumber, bakeWm) {
  const g = key ? _a3Groups.get(key) : null;
  if (g) {
    g.ownerLastBakeFrame = frameNumber;
    // The worldMatrix the shared RT was baked at. Borrowing members offset
    // their blit relative to THIS (not their own never-set bake wm) — without
    // it a borrower blitted at zero delta, landing the shared raster at the
    // OWNER's position (the ping-pong group member that never appeared).
    if (bakeWm) g.bakeWm = bakeWm;
  }
}

export function isA3GroupCacheValid(key) {
  if (!key) return false;
  const g = _a3Groups.get(key);
  return !!(g && g.sharedTex && g.ownerLastBakeFrame >= 0);
}

/// Construct a fresh per-renderer cache state. The renderer owns one
/// of these; pass it to `tick({...})` once per frame to drive the
/// state machine.
export function createStaticCache(opts = {}) {
  // -------- Configuration --------
  const cfg = {
    strategy:               opts.strategy             ?? Strategy.Auto,
    autoBudgeted:           !!opts.autoBudgeted,
    stabilityEpsilon:       opts.stabilityEpsilon     ?? 0.05,
    stabilityPromoteFrames: opts.stabilityPromoteFrames ?? 15,
    stabilityDemoteFrames:  opts.stabilityDemoteFrames  ?? 3,
    a2GiantAssetFactor:     opts.a2GiantAssetFactor   ?? 1.5,
    a2MarginPixels:         opts.a2MarginPixels       ?? 256,
  };

  // -------- Read-only diagnostics (state.* fields) --------
  const state = {
    // Mutable; reset by tick() each frame.
    resolvedLevel:         /** @type {number} */ (Level.None),
    resolvedReason:        Reason.Uninitialized,
    // Frame counter set by markBaked. -1 = never.
    lastBakeFrame:         -1,
    // Last footprint measured by tick().
    lastFootprintW:        0,
    lastFootprintH:        0,
    // True after a successful bake; flipped false on invalidate / level demotion.
    isCacheValid:          false,
    // Bumped on every invalidate() — engine compares against the RT's
    // baked generation to detect "RT contents are stale but level is
    // still A1" (e.g. content-change while level holds).
    cacheGeneration:       0,
    // A3 instance-group key. Null = not in a group.
    instanceGroupKey:      opts.instanceGroupKey ?? null,
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
      const g = _a3Groups.get(state.instanceGroupKey);
      if (g) g.ownerLastBakeFrame = -1;
    }
  }

  /// Set the user strategy override.
  /// Invalidates the cache because crossing AlwaysLive↔Auto changes the
  /// level resolution.
  function setStrategy(s) {
    if (cfg.strategy === s) return;
    cfg.strategy = s;
    invalidate();
  }

  /// Opt into A3 instancing as a member of a named group. Pass null to leave.
  function setInstanceGroup(key) {
    if (state.instanceGroupKey === key) return;
    if (state.instanceGroupKey) {
      _releaseA3Group(state.instanceGroupKey, state);
      state.isCacheValid = false;
    }
    state.instanceGroupKey = key || null;
    if (state.instanceGroupKey) _acquireA3Group(state.instanceGroupKey, state);
    invalidate();
  }

  /// True when this cache is an A3 group member AND the group's shared RT
  /// has been baked at least once since the last invalidation.
  function isGroupCacheValid() {
    if (!state.instanceGroupKey) return state.isCacheValid;
    return isA3GroupCacheValid(state.instanceGroupKey);
  }

  /// Mark cache as freshly baked. Engine calls this after the RT bake
  /// succeeds. `frameNumber` is the engine's monotonic frame counter
  /// (gives diagnostics a sense of staleness).
  function markBaked(frameNumber, bakeWm) {
    state.isCacheValid = true;
    state.lastBakeFrame = frameNumber;
    if (state.instanceGroupKey) markA3GroupBaked(state.instanceGroupKey, frameNumber, bakeWm);
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
  /// }
  function tick(inputs) {
    state.lastFootprintW = inputs.footprintW | 0;
    state.lastFootprintH = inputs.footprintH | 0;

    // -------- User-override fast paths --------
    switch (cfg.strategy) {
      case Strategy.AlwaysLive:
        return setResolved(Level.None, Reason.UserOverride);
      case Strategy.ForceA1:
        return setResolved(Level.A1, Reason.UserOverride);
      case Strategy.ForceA2:
        // A2 is intentionally absent: renderer.js caches the viewport
        // already, so an A2 viewport clamp would not reduce RT size.
        return setResolved(Level.None, Reason.LevelNotImplemented);
      case Strategy.ForceA3:
        return setResolved(Level.A3, Reason.UserOverride);
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

    // -------- A1 vs giant-asset selection --------
    const giantX = inputs.viewportW > 0
                && fw > inputs.viewportW * cfg.a2GiantAssetFactor;
    const giantY = inputs.viewportH > 0
                && fh > inputs.viewportH * cfg.a2GiantAssetFactor;
    if (giantX || giantY) {
      return setResolved(Level.None, Reason.LevelNotImplemented);
    }

    // AUTO-DEFAULT BUDGET: auto-created caches (no explicit opts) hold a global
    // promotion budget — each A1 costs a viewport-sized RT, so unbounded promotion
    // on many-handle scenes would blow GPU memory. Explicitly configured handles
    // bypass the budget (the caller opted in deliberately).
    if (cfg.autoBudgeted && state.resolvedLevel !== Level.A1) {
      if (_autoPromotedCount >= AUTO_A1_BUDGET) return setResolved(Level.None, Reason.SizeUnstable);
      _autoPromotedCount++;
      state._budgetHeld = true;
    }
    setResolved(Level.A1, Reason.AssetFitsViewport);
  }

  function setResolved(level, reason) {
      if (state._budgetHeld && level !== Level.A1) { _autoPromotedCount = Math.max(0, _autoPromotedCount - 1); state._budgetHeld = false; }
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

  if (state.instanceGroupKey) _acquireA3Group(state.instanceGroupKey, state);

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
    // Mutators
    setStrategy,
    setInstanceGroup,
    isGroupCacheValid,
    invalidate,
    markBaked,
    tick,
    // Internal identity for A3 registry membership.
    _cacheState: state,
  };
}
