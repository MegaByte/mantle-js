// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmNeeds.js -- a game's shader NEEDS on the renderer: the declared-needs manifest (warmPolicy.parseNeeds), the keys a public runtime API can reach for a
// bundle (computed by the renderer's own key function, never a copy of it), and the NEED-MISS counter.
//
// Three sources make up what a game needs: (a) the assets (the variant keys fillPass derives from each bundle's features, as always); (b) DECLARED (a needs
// manifest passed as `createRenderer(..., { declaredNeeds })` or `renderer.setWarmContext({ declaredNeeds })`); (c) RECORDED (a `recordWarmManifest` session's
// export, turned into a needs manifest by scripts/warmNeedsFromRun.mjs). A request for a variant or program that none of them named is a NEED MISS: counted in
// `debugStats.needMiss`, warned once per key in a dev build, and served by the same non-blocking path as before (a stand-in, or a deferred draw): a miss never
// stalls, never leaves a cache stamped valid (the deferral guards of fillPass/cacheDraw are untouched).

import { parseNeeds, sortedKey, REACH_TAGS } from './warmPolicy.js';

const ROT = new Float32Array([
  Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  -Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  0,
  0,
  1,
]);
const TINT = new Float32Array([0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1]);
const TINT_OFF = new Float32Array([0.02, 0, 0, 0]);
/// An override table that gives its one drawn row an absolute stroke width (texel 1.w bit 4, texel 5.x), and one that only moves a row.
const OVR_STROKE = {
  packedBuffer: (() => {
    const p = new Float32Array(24);
    p[0] = 1;
    p[3] = 1;
    p[6] = 1;
    p[7] = 4;
    p[20] = 2;
    return p;
  })(),
  numShapes: 1,
};
const OVR_MOVE = {
  packedBuffer: (() => {
    const p = new Float32Array(24);
    p[0] = 1;
    p[3] = 1;
    p[4] = 3;
    p[6] = 1;
    return p;
  })(),
  numShapes: 1,
};

/** @param {any} R the renderer context */
export function attachWarmNeeds(R) {
  /** @type {ReturnType<typeof parseNeeds>} */
  let declared = null;
  const declaredReach = new Map(); // bundle -> Set(keys) its declared reach resolved to
  const declaredKeys = new Set(); // every key a declared need (variants + resolved reach) names
  const declaredProgKinds = new Set(),
    seenMisses = new Set();
  const stats = (R._needStats = {
    fillMisses: 0,
    programMisses: 0,
    declaredCold: 0,
    keys: [],
    why: [],
    preLoad: 0,
    warned: 0,
  });

  const drawKeys = [
    'worldM',
    'colorMatrix',
    'colorMatrixOffset',
    'palette',
    'channelLerp',
    'overrides',
    'alpha',
  ];
  /// The variant keys (and cover siblings) `bundle` would bind if its draw carried the state of `tag`. Uses R._variantDefinesNow, the production decision.
  function keysFor(bundle, tag) {
    if (
      !bundle ||
      bundle._disposed ||
      !R._variantDefinesNow ||
      !Object.prototype.hasOwnProperty.call(REACH_TAGS, tag)
    )
      return [];
    const d = R.draw,
      saved = {},
      savedAuto = R._autoEngine,
      savedMask = bundle.segTypeMask;
    for (const k of drawKeys) saved[k] = d[k];
    try {
      if (tag === 'rotate') d.worldM = ROT;
      else if (tag === 'recolor') {
        d.colorMatrix = TINT;
        d.colorMatrixOffset = TINT_OFF;
      } else if (tag === 'palette') d.palette = { texture: {} };
      else if (tag === 'channelLerp')
        d.channelLerp = { primary: [0, 0, 0, 1], contrast: [0, 0, 0, 1], highlight: [1, 1, 1, 1] };
      else if (tag === 'strokeWidth') d.overrides = OVR_STROKE;
      else if (tag === 'overrides') d.overrides = OVR_MOVE;
      else if (tag === 'alpha') d.alpha = 0.5;
      else if (tag === 'typeUnion') bundle.segTypeMask = 0xf;
      const defs = R._variantDefinesNow(bundle);
      const out = [sortedKey(defs.join('|'))];
      if (defs.includes('MANTLE_NO_COVER_FILL'))
        out.push(sortedKey(defs.filter((x) => x !== 'MANTLE_NO_COVER_FILL').join('|')));
      return out;
    } catch {
      return [];
    } finally {
      for (const k of drawKeys) d[k] = saved[k];
      bundle.segTypeMask = savedMask;
      R._autoEngine = savedAuto;
    }
  }
  /// The keys the declared reach resolves to for this bundle, `tags` combined one at a time and pairwise (a recolored rotated draw is its own key).
  function reachKeysOf(bundle, tags) {
    const out = new Set();
    for (const t of tags) for (const k of keysFor(bundle, t)) out.add(k);
    return [...out];
  }
  /// The key a draw of `bundle` binds under the draw state `patch` ({ overrides, worldM, colorMatrix, alpha, ... }); the production decision (tests, probes).
  R._keyWith = (bundle, patch) => {
    const d = R.draw,
      saved = {},
      savedAuto = R._autoEngine;
    for (const k of drawKeys) saved[k] = d[k];
    try {
      Object.assign(d, patch || {});
      return sortedKey(R._variantDefinesNow(bundle).join('|'));
    } finally {
      for (const k of drawKeys) d[k] = saved[k];
      R._autoEngine = savedAuto;
    }
  };
  R._reachKeys = reachKeysOf;
  R._reachKeysFor = keysFor;

  /// PER-BUNDLE REACH (renderer.declareReach(bundle, tags)): the app names a bundle's reach directly -- a source scan knows its assets, not their content
  /// keys. Authoritative for that bundle; a bundle declared nowhere keeps the needs manifest's reach, or the full default domain.
  const bundleReach = new WeakMap();
  const recolorFold = new WeakMap(); // (R._foldsRecolors: each declared bundle's last answer)
  R._declareBundleReach = (bundle, tags) => {
    if (!bundle) return;
    if (tags == null) {
      bundleReach.delete(bundle);
      declaredReach.delete(bundle);
      recolorFold.delete(bundle);
      return;
    }
    bundleReach.set(bundle, [...new Set(tags.map(String))]);
    if (!bundle._disposed) R._declaredReach(bundle);
  };
  /// PER-BUNDLE STREAM (renderer.declareStream(bundle, on)): the app says an imported bundle's geometry will be replaced by updateBundleGeometry. What it contains now is then not what it will
  /// contain, so its key leaves out nothing its content could bring (fillPass oneKeyStream), and the warm image, K itself, holds what its updates bind. Off again, it is the bundle it was.
  R._declareBundleStream = (bundle, on) => {
    if (!bundle) return;
    if (on) {
      if (bundle.streamable !== true) {
        bundle.streamable = true;
        bundle._streamDeclared = true;
      }
    } else if (bundle._streamDeclared === true) {
      bundle.streamable = false;
      bundle._streamDeclared = false;
    }
  };
  /// A morph declared nowhere reaches what its two poses reach (their union), when both are declared (bundle._reachPoses: weak references set by the
  /// shared pair builder, shapeAnimation acquirePair).
  function bundleTags(bundle) {
    if (bundleReach.has(bundle)) return bundleReach.get(bundle);
    const rp = bundle && bundle._reachPoses;
    if (!rp) return undefined;
    const ps = rp.map((r) => r.deref());
    if (!ps.every((p) => p && bundleReach.has(p))) return undefined;
    return [...new Set(ps.flatMap((p) => bundleReach.get(p)))];
  }
  function declaredTagsFor(bundle) {
    const own = bundleTags(bundle);
    if (own !== undefined) return own.length ? own : null;
    if (!declared || !declared.reach.length) return null;
    const key = R._wmKeyOf ? R._wmKeyOf(bundle) : null;
    const tags = new Set();
    for (const r of declared.reach)
      if (r.bundle === '*' || r.bundle === key) for (const t of r.tags) tags.add(t);
    return tags.size ? [...tags] : null;
  }
  /// The draw-state DOMAIN a declaration leaves this bundle: null = no declaration (the full default domain: as drawn, rotated, recolored, both); otherwise the states its
  /// declared reach tags allow. A declared manifest is authoritative: a bundle whose reach lists neither `rotate` nor `recolor` cannot enter those states, so they are not warmed.
  R._declaredDomain = (bundle) => {
    if (!declared && bundleTags(bundle) === undefined) return null;
    const tags = new Set(declaredTagsFor(bundle) || []);
    return {
      rotate: tags.has('rotate'),
      recolor: tags.has('recolor'),
      channelLerp: tags.has('channelLerp'),
    };
  };
  /// Does this bundle share one recolor program across its color-matrix and channel-lerp states? (fillPass pushRecolorOmits.) A declared reach naming both does, and so does a bundle declared
  /// nowhere, whose domain is every recolor: a text bundle created in play asks for the key the declared art built. The draw path asks this, so the answer may not move under a warmed bundle:
  /// a morph's reach is its poses', weakly held, and a morph that outlives a pose keeps the answer its warm was built on.
  R._foldsRecolors = (bundle) => {
    if (!declared && bundleTags(bundle) === undefined)
      return recolorFold.has(bundle) ? recolorFold.get(bundle) : true;
    const tags = declaredTagsFor(bundle);
    const both = !!tags && tags.includes('recolor') && tags.includes('channelLerp');
    recolorFold.set(bundle, both);
    return both;
  };
  /// A bundle is being prewarmed: link the keys its declared reach names (a declared need is warmed, so it is never missed).
  R._declaredReach = (bundle) => {
    if ((!declared && bundleTags(bundle) === undefined) || bundle._disposed) return;
    const tags = declaredTagsFor(bundle);
    if (!tags) return;
    const keys = reachKeysOf(bundle, tags);
    declaredReach.set(bundle, new Set(keys));
    for (const k of keys) {
      declaredKeys.add(k);
      if (R._wq) {
        try {
          R._wq.link(k);
        } catch {
          /* the draw path links it */
        }
      }
    }
  };
  /// Accept a needs manifest (object, JSON, or null to clear). Variants link at once (cheap, parallel, no pipeline); programs go through the prelinkers the
  /// warm manifest already uses; the reach of each bundle already prewarmed resolves now, later bundles when they are prewarmed.
  R._setDeclaredNeeds = (m) => {
    declared = m == null ? null : parseNeeds(m);
    declaredKeys.clear();
    declaredReach.clear();
    declaredProgKinds.clear();
    if (!declared) return !!(m == null);
    for (const k of declared.variants) {
      declaredKeys.add(k);
      if (R._wq) {
        try {
          R._wq.link(k);
        } catch {
          /* best effort */
        }
      }
    }
    for (const { t, a } of declared.programs) {
      declaredProgKinds.add(t); // (a program is matched by its kind: the argument lists are the recorder's, and a draw's list varies with the state)
      try {
        const f = R._wmPrelinkers && R._wmPrelinkers[t];
        if (f) f(a);
      } catch {
        /* the draw starts it */
      }
    }
    if (R._liveBundles) for (const b of R._liveBundles()) R._declaredReach(b);
    return true;
  };
  R._declaredNeeds = () => declared;
  R._isDeclaredKey = (key) => declaredKeys.has(key);

  function warn(kind, key) {
    if (stats.warned >= 20) return;
    const dev =
      R.opts.needMissWarn === true ||
      (R.opts.needMissWarn !== false &&
        globalThis.__MANTLE_DEBUG__ &&
        R._loadStats &&
        R._loadStats.phase === 'done');
    if (!dev) return;
    stats.warned++;
    console.warn(
      `[mantle] need miss: the ${kind} ${key || '(base)'} was requested at run time and was neither warmed nor declared. It drew through the non-blocking path (a stand-in or a deferred draw). Declare it (setWarmContext({ declaredNeeds })) or record it (recordWarmManifest + scripts/warmNeedsFromRun.mjs).`,
    );
  }
  /// A draw asked for a fill variant that does not exist yet (fillPass selectFillVariantInner). Not counted while the loading call or a warm draws.
  R._noteNeedMiss = (kind, key) => {
    if (R._psoWarming || R._variantProbe || R._coop) return;
    // before the loading call has finished the screen is a loading screen: its cold requests are counted apart, they are not needs the warm missed
    if (!(R._loadStats && R._loadStats.phase === 'done')) {
      stats.preLoad = (stats.preLoad | 0) + 1;
      return;
    }
    const id = kind + ':' + key;
    if (seenMisses.has(id)) return;
    seenMisses.add(id);
    if (declaredKeys.has(key)) {
      stats.declaredCold++;
      return;
    }
    if (kind === 'fill') stats.fillMisses++;
    else stats.programMisses++;
    if (stats.keys.length < 40) stats.keys.push(id.slice(0, 600));
    // WHY: where the request happened (the miss diagnosis the warm policy is built from)
    if (stats.why.length < 40) {
      let vi = null;
      try {
        vi = R._viewportClassInfo ? R._viewportClassInfo() : null;
      } catch {
        /* none */
      }
      // the nearest key the cache already holds and exactly which tokens differ: the reason the asset-derived warm did not produce this one
      let near = null;
      if (kind === 'fill' && R._variantList) {
        const want = new Set(key ? key.split('|') : []);
        let best = 1e9;
        for (const v of R._variantList()) {
          const have = new Set(v.key ? v.key.split('|') : []);
          let d = 0;
          for (const t of want) if (!have.has(t)) d++;
          for (const t of have) if (!want.has(t)) d++;
          if (d < best) {
            best = d;
            near = {
              key: v.key.length > 400 ? v.key.slice(0, 400) : v.key,
              onlyWanted: [...want].filter((t) => !have.has(t)),
              onlyHave: [...have].filter((t) => !want.has(t)),
              ready: v.ready,
              pending: v.pending,
            };
          }
        }
      }
      stats.why.push({
        near,
        id: id.slice(0, 600),
        frame: R._frameSerial | 0,
        phase: R._loadStats ? R._loadStats.phase : null,
        aacMode: R.opts.aacFill,
        ...(vi || {}),
        prewarmedBundles: R._liveBundles ? R._liveBundles().length : null,
      });
    }
    warn(kind, key);
  };
  /// A non-fill program (instanced, mask bake, points) is created by a draw. `key` is that program's cache key; a declared kind counts as warmed.
  R._noteProgramMiss = (kind, key) => {
    if (R._psoWarming || R._coop) return;
    if (declaredProgKinds.has(kind)) return;
    R._noteNeedMiss(kind, key);
  };
  R._needStatsSnapshot = () => ({
    fillMisses: stats.fillMisses,
    programMisses: stats.programMisses,
    declaredCold: stats.declaredCold,
    preLoadRequests: stats.preLoad | 0,
    keys: stats.keys.slice(),
    why: stats.why.slice(),
    playBuildWhy: R._playBuildWhy ? R._playBuildWhy.slice() : [],
    bindSetKeys: R._bindSetKeys ? R._bindSetKeys.slice() : [],
    bindSetImage: R._bindSetImage | 0,
    kOutsideWarmSet: R._kOutside | 0,
    kOutsideBuilt: R._kOutsideBuilt | 0,
    kOutsideKeys: R._kOutsideKeys ? R._kOutsideKeys.slice() : [],
    bindSetBuilds: R._bindSetBuilds | 0,
    bindSetUnbuilt: R._bindSetUnbuilt | 0,
    bindSetUnbuiltKeys: R._bindSetUnbuiltKeys ? R._bindSetUnbuiltKeys.slice() : [],
    bindSetMs: Math.round(R._bindSetMs || 0),
    bindSetEnumMs: Math.round(R._bindSetEnumMs || 0),
    bindSetEnumMaxMs: Math.round(R._bindSetEnumMax || 0),
    bindSetEnumBundles: R._bindSetEnumBundles | 0,
    bindSetLastBundles: R._bindSetLastBundles | 0,
    needsWarmCalls: R._needsWarmCalls | 0,
    needsWarmMs: Math.round(R._needsWarmMs || 0),
    needsWarmMaxMs: Math.round(R._needsWarmMax || 0),
    engineCandidateBuilds: R._engineCandidateBuilds | 0,
    engineCandidateMs: Math.round(R._engineCandidateMs || 0),
    blocked: R._needBlocked | 0,
    reuseDraws: R._reuseDraws | 0,
    reuseDeadline: R._reuseDeadline | 0,
    reuseByKey: R._reuseByKey ? Object.fromEntries([...R._reuseByKey]) : {},
    standIns: R.opts.standIns === false ? 'off' : 'on',
    policy: R.opts.needMissPolicy === 'block' ? 'block' : 'defer',
    standInDraws: R._standInDraws | 0,
    standInWhy: R._standInWhy ? R._standInWhy.slice() : [],
    standInByKey: R._standInByKey ? Object.fromEntries([...R._standInByKey].slice(0, 40)) : {},
    declared: declared
      ? {
          game: declared.game,
          variants: declared.variants.size,
          programs: declared.programs.length,
          reach: declared.reach.length,
        }
      : null,
  });
  if (R.opts && R.opts.declaredNeeds) R._setDeclaredNeeds(R.opts.declaredNeeds);
}
