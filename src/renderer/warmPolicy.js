// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmPolicy.js -- the pure parts of the warm policy (no GL, no renderer): how likely a program is to be needed, what a public runtime API can do to a
// fill variant key, and the game's DECLARED NEEDS manifest.
//
// 1. LIKELIHOOD (keyLikelihood). While several games' shaders warm at once (a hub), the programs most games draw link first. The score of a key is,
//    in order of preference: the fraction of the scenes the queue was given that need it (when two or more scenes are queued: exact and current), else
//    the census fraction of games that DREW this exact key (warmLikelihood.js, baked from the shader census), else an estimate from the key's parts
//    (the rarest feature family it uses, the rarest non-omission token it carries), halved because the exact key was never seen.
// 2. API_REACH: every public mutation API against the variant-key axes it can change, with the code that makes the axis move. The warm test sweeps this
//    table, so a new row is a new assertion.
// 3. DECLARED NEEDS (needs manifest v1): what the game says its runtime can reach beyond what the assets show.

import { WARM_LIKELIHOOD } from './warmLikelihood.js';

const FNV = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
};
export const sortedKey = (key) => (key ? key.split('|').sort().join('|') : '');

const FAMILIES = ['GRADIENT', 'CLIP', 'MASK', 'FILTER', 'STROKE', 'PATTERN', 'IMAGE', 'RECOLOR'];

/** Census fraction (0..1) of games that drew this exact key, 0 when unseen. Linked-only adds a tenth of its fraction. */
export function censusFraction(key) {
  const L = WARM_LIKELIHOOD,
    a = L.keys[FNV(sortedKey(key))];
  return a ? (a[0] + 0.1 * Math.max(0, a[1] - a[0])) / L.games : 0;
}
/** An estimate for a key the census never saw: the rarest thing it needs, halved. */
export function estimateFraction(key) {
  const L = WARM_LIKELIHOOD,
    toks = key ? key.split('|') : [];
  let est = 1;
  for (const fam of FAMILIES)
    if (!toks.includes('MANTLE_NO_' + fam)) {
      const a = L.uses[fam];
      est = Math.min(est, a ? a[0] / L.games : 0.05);
    }
  for (const t of toks) {
    if (t.startsWith('MANTLE_NO_') || t.startsWith('MANTLE_LB_NO_')) continue;
    const a = L.tokens[t];
    est = Math.min(est, a ? a[0] / L.games : 0.05);
  }
  return Math.max(est, 0.05) * 0.5;
}
/**
 * The likelihood score of a variant key: higher links first.
 * @param {string} key
 * @param {{ scenes?: number, sceneCount?: number }} [o] `scenes` queued scenes and `sceneCount` of them that need the key
 */
export function keyLikelihood(key, o) {
  if (o && o.scenes >= 2)
    return o.sceneCount / o.scenes + 1e-3 * (censusFraction(key) || estimateFraction(key));
  const c = censusFraction(key);
  return c > 0 ? c : estimateFraction(key);
}

// ---- API REACH ------------------------------------------------------------------------------------------------------------------------------------
/// The AXES a variant key can move along, each with the draw-time input that moves it. A tag is also a REACH TAG in a needs manifest.
export const REACH_TAGS = Object.freeze({
  rotate: 'a rotated or skewed map: +MANTLE_ROTATED_MAP (the footprint only that program has)',
  recolor:
    'a color matrix / offset: MANTLE_NO_RECOLOR off, MANTLE_NO_CHANNEL_LERP and MANTLE_NO_PALETTE stay',
  palette: 'a palette texture: MANTLE_NO_PALETTE off',
  channelLerp: 'a channel-lerp recolor: MANTLE_NO_CHANNEL_LERP off',
  strokeWidth: 'an override that gives a row an absolute stroke width: MANTLE_NO_STROKE off',
  overrides:
    'an override table on the draw: the no-AA kernels (MANTLE_HARD*) are off and a transform override puts a row on a cover quad (MANTLE_NO_COVER_FILL sibling)',
  alpha: 'a translucent draw (alpha < 0.996): the no-AA kernels (MANTLE_HARD*) are off',
  typeUnion:
    'segment types appearing in a streamed or rebuilt bundle: MANTLE_NO_LINE / _QUAD / _CUBIC / _ARC off',
});
/// Axes that move with the SIZE of the draw (engine pick, route, strips) rather than with a draw-state input. Those are the viewport classes, which the
/// queue's onResize / ctx.viewport handle, and which a needs manifest names by `scales`.
export const SCALE_AXIS = 'scale';

/**
 * Every public mutation API against the key axes it can change. `at` cites the code that moves the axis (a file:line in src; line numbers can
 * drift). `tags` are REACH_TAGS entries, `scale` marks the size axis, an empty `tags` is a proof that the API cannot change a fill variant key.
 * The warm test (test/warmPolicySmoke.mjs) draws every row's tags through the real renderer and asserts the resulting key is warmed, declared, or has a
 * non-stalling path.
 */
export const API_REACH = Object.freeze([
  {
    api: 'drawBundle(opts.worldMatrix) / dstRect / fit / setViewport / setResolutionScale',
    tags: ['rotate'],
    scale: true,
    at: 'renderer/fillPass.js:1051 (worldMapAxisAligned), :1047 (typeOmit), renderer/fillPass.js:2056 (_deriveSizeRegions: the analytic breakpoints)',
    note: 'rotation/skew adds MANTLE_ROTATED_MAP; scale moves the engine pick (MANTLE_AAC, pair bands, the LB route, strips) at the breakpoints viewportWarm derives; a world matrix reaches past them, so a stand-in-free image asks the key-moving gates over (0, inf) (fillPass.js scaleProbes)',
  },
  {
    api: 'drawBundle(opts.colorMatrix, opts.colorMatrixOffset), colorMatrixDualTint / TripleTint / Monochrome / Combine',
    tags: ['recolor'],
    at: 'renderer/fillPass.js:459 (drawUsesRecolor), :465 (pushRecolorOmits)',
    note: 'a non-identity matrix or non-zero offset',
  },
  {
    api: 'drawBundle(opts.palette, opts.paletteChannel), createPalette',
    tags: ['palette'],
    at: 'renderer/fillPass.js:472 (pushRecolorOmits)',
    note: '',
  },
  {
    api: 'drawBundle(opts.channelLerp), channelLerpParams, createTextBundle(two-tone)',
    tags: ['channelLerp'],
    at: 'renderer/fillPass.js:470 (pushRecolorOmits)',
    note: '',
  },
  {
    api: 'drawBundle(opts.alpha)',
    tags: ['alpha'],
    at: 'renderer/fillPass.js:582 (preferNoAa), :613 (preferNoAaMixed)',
    note: 'alpha < 0.996 turns the no-AA kernels off; no other key bit (group opacity composites in a target, the fill keys are those of the leaves)',
  },
  {
    api: 'createOverrideTable().set/update: localPosition, localScale',
    tags: ['overrides'],
    at: 'animation/overrides.js:315 (writeRecord), renderer/fillPass.js:582, :1051',
    note: 'any table on the draw turns the no-AA kernels off; a transform puts a row on a cover quad',
  },
  {
    api: 'createOverrideTable().set/update: localRotation, matrix (group override)',
    tags: ['overrides', 'rotate'],
    at: 'renderer/shapeScale.js:82 (overridesAxisAligned), renderer/fillPass.js:1051',
    note: 'a rotated row needs the rotated footprint',
  },
  {
    api: 'createOverrideTable().set/update: strokeWidth',
    tags: ['overrides', 'strokeWidth'],
    at: 'renderer/shapeScale.js:94 (overridesRaiseStroke), renderer/fillPass.js:836',
    note: 'the only override field that reaches a baked omission (the stroke walk)',
  },
  {
    api: 'createOverrideTable().set/update: fill, stroke (absolute RGBA lists), tint, visibility, reveal',
    tags: ['overrides'],
    at: 'animation/overrides.js:334-362 (a solid color in a texel; no gradient, pattern or image can be written)',
    note: 'so an override can NEVER add MANTLE_NO_GRADIENT / _PATTERN / _IMAGE / _MASK / _CLIP / _FILTER back: those bits come from the bundle only',
  },
  {
    api: 'createOverrideTable().setClipper / clearClipper / clear / clearAll',
    tags: ['overrides'],
    at: 'animation/overrides.js:695',
    note: 'writes the row transform only',
  },
  {
    api: 'setNodeClip / clearNodeClip / renderClipCoverage / opts.extClipTex',
    tags: [],
    at: 'renderer/clipDraw.js:131; shaders/mantle.frag.glsl:78 (MANTLE_NO_EXTCLIP is set only by renderer/morphDraw.js:358)',
    note: 'the external clip code is in every fill variant: no key bit',
  },
  {
    api: 'createShapeMorph, createSpriteMorph, createShapeTimeline, createSpriteTimeline, createSpatialBezierMorph, createPathDeltaMorph, createSkinnedMorph, createPoseStack',
    tags: [],
    at: 'renderer/fillPass.js:923 (MANTLE_LB_MORPH from the bundle), :1047 (morph masks include every pose)',
    note: 'the morph bundle exists at creation: its keys are asset-derived and prewarmed with it; setting T moves a uniform, not a key',
  },
  {
    api: 'updateBundleGeometry, buildStreamableSections (streamed geometry)',
    tags: ['typeUnion'],
    at: 'renderer/streamGeometry.js:297-306 (refreshDerivedStats: segTypeMask grows by union)',
    note: 'a segment type that first appears mid-stream removes a MANTLE_NO_<type>',
  },
  {
    api: 'createTextBundle().setText / setStyle',
    tags: ['typeUnion', 'channelLerp'],
    at: 'textBundle.js:117 (the rebuilt bundle carries its own segTypeMask); renderer/fillPass.js:1047',
    note: 'the rebuilt bundle is a new bundle: prewarmed when created; two-tone text draws with channelLerp',
  },
  {
    api: 'drawSprite / drawSpriteInstanced / drawBundleInstanced / drawImage / drawImageInstanced',
    tags: ['rotate', 'recolor'],
    at: 'renderer/instancedFill.js:266 (_selectInstProgramAsync: its own program key from the bundle omissions and the draw)',
    note: 'instanced programs are keyed by instancedEngineDefines + instancedOmitDefines: the same axes',
  },
  {
    api: 'createFilterParams().set (filter parameters)',
    tags: [],
    at: 'animation/filterParams.js:146',
    note: 'a uniform; the filter programs follow the bundle (bundleHasFilters, renderer/fillPass.js:655)',
  },
  {
    api: 'fillHitShape / fillHits / fillHitId / fillHitHref (hit testing)',
    tags: [],
    at: 'hitTest/hitTest.js:949',
    note: 'CPU winding over the curve buffer: draws nothing, links nothing',
  },
  {
    api: 'setFillEngine, setLoopBlinnFill, setLoopBlinnMorphFill, setFillPolicyOptions, setSceneUnion',
    tags: ['rotate'],
    scale: true,
    at: 'renderer/fillPass.js:1930 (_ageWarmDemands drops a demand when the selection changes)',
    note: 'an engine pin changes the kernel family for every bundle: the host calls it at configuration time, before warming; a pin after warming is a new selection, warmed by the next precompile',
  },
]);

// ---- DECLARED NEEDS (needs manifest v1) ---------------------------------------------------------------------------------------------------------------
export const NEEDS_FORMAT = 'mantle-needs';
export const NEEDS_VERSION = 1;
/**
 * The game's declared shader needs, parsed. Forward compatible: a higher `version` is read for the fields known here, unknown fields are ignored, a
 * wrong-typed entry is skipped. Returns null for anything that is not a needs manifest (a missing manifest is `null`, never an error).
 *
 * {
 *   "format": "mantle-needs", "version": 1, "game": "my-game",
 *   "variants": ["MANTLE_NO_ARC|...", ...],                  exact fill variant keys the game can draw (recorded, or declared)
 *   "programs": [{ "t": "inst"|"bake"|"points", "a": [...] }],   non-fill programs, as exportWarmManifest records them
 *   "reach":    [{ "bundle": "<warm manifest bundle key>"|"*", "tags": ["rotate","recolor","palette","channelLerp","strokeWidth","overrides","alpha","typeUnion"] }],
 *   "scales":   [{ "c": <viewport class>, "w": px, "h": px }]  viewport classes the game runs at (optional)
 * }
 * @param {any} m an object or its JSON
 */
export function parseNeeds(m) {
  try {
    const o = typeof m === 'string' ? JSON.parse(m) : m;
    if (!o || typeof o !== 'object' || o.format !== NEEDS_FORMAT || !(o.version >= 1)) return null;
    const variants = new Set(
      (Array.isArray(o.variants) ? o.variants : [])
        .filter((k) => typeof k === 'string')
        .map(sortedKey),
    );
    const programs = (Array.isArray(o.programs) ? o.programs : []).filter(
      (p) => p && typeof p.t === 'string' && Array.isArray(p.a),
    );
    const reach = [];
    for (const r of Array.isArray(o.reach) ? o.reach : []) {
      if (!r || typeof r.bundle !== 'string') continue;
      const tags = (Array.isArray(r.tags) ? r.tags : []).filter(
        (t) => typeof t === 'string' && Object.prototype.hasOwnProperty.call(REACH_TAGS, t),
      );
      if (tags.length) reach.push({ bundle: r.bundle, tags });
    }
    const scales = (Array.isArray(o.scales) ? o.scales : [])
      .filter((s) => s && Number.isFinite(s.c))
      .map((s) => ({ c: s.c | 0, w: +s.w || 0, h: +s.h || 0 }));
    return {
      format: NEEDS_FORMAT,
      version: o.version | 0,
      game: typeof o.game === 'string' ? o.game : null,
      variants,
      programs,
      reach,
      scales,
    };
  } catch {
    return null;
  }
}
/** The REACH tags a recorded warm-manifest state implies (the states are what the recording session drew: overrides, a recolor, a channel lerp, a palette). */
function tagsOfState(sig) {
  const t = [];
  if (!sig) return t;
  if (sig.ov === 1) t.push('overrides', 'rotate');
  else if (sig.ov === 2) t.push('overrides', 'strokeWidth');
  if (sig.cm) t.push('recolor');
  if (sig.cl) t.push('channelLerp');
  if (sig.pal) t.push('palette');
  if (sig.w && (sig.w[1] !== 0 || sig.w[2] !== 0)) t.push('rotate');
  return t;
}
/**
 * A needs manifest from a recorded warm manifest (renderer.exportWarmManifest of a `recordWarmManifest: true` session): what the session bound and the
 * draw states it met. The recorder tool (scripts/warmNeedsFromRun.mjs) wraps this.
 * @param {any} wm the warm manifest (version 1..3)
 * @param {{ game?: string }} [o]
 */
export function needsFromWarmManifest(wm, o = {}) {
  const variants = new Set(),
    reach = [];
  for (const v of Array.isArray(wm && wm.variants) ? wm.variants : []) {
    const k = typeof v === 'string' ? v : v && v.k;
    if (typeof k === 'string') variants.add(sortedKey(k));
  }
  for (const p of Array.isArray(wm && wm.pipelines) ? wm.pipelines : [])
    if (p && typeof p.k === 'string') variants.add(sortedKey(p.k));
  for (const [b, states] of Object.entries((wm && wm.entries) || {})) {
    const tags = new Set();
    for (const s of Array.isArray(states) ? states : [])
      for (const t of tagsOfState(s)) tags.add(t);
    if (tags.size) reach.push({ bundle: b, tags: [...tags].sort() });
  }
  return {
    format: NEEDS_FORMAT,
    version: NEEDS_VERSION,
    game: o.game || null,
    variants: [...variants].sort(),
    programs: Array.isArray(wm && wm.programs) ? wm.programs : [],
    reach,
    scales: Array.isArray(wm && wm.scales)
      ? wm.scales.map((s) => ({ c: s.c, w: s.w, h: s.h }))
      : [],
  };
}
/**
 * A needs manifest from a shader-census row (the shader-census harness output, census-<game>.json rows[0]): the keys the game DREW
 * (startupDraws + activeDraws), which is the observed need; programs the census saw only linked are not needs.
 */
export function needsFromCensusRow(row, o = {}) {
  const drawn = new Set([
    ...Object.keys(row.startupDraws || {}),
    ...Object.keys(row.activeDraws || {}),
  ]);
  // (only keys the renderer's variant cache holds are fill variants: the census lists the other programs' defines too, and linking one of those as a fill variant is a wrong program)
  const fill = new Set(((row.ds && row.ds.variantKeys) || []).map((v) => sortedKey(v.key)));
  const variants = new Set();
  for (const p of row.progFacts || [])
    if (p.defines && p.defines.length && drawn.has(String(p.id))) {
      const k = sortedKey(
        p.defines
          .filter((d) => d !== 'MANTLE_IS_LB_VERT' && d !== 'MANTLE_COVER_KID_SRC')
          .join('|'),
      );
      if (fill.has(k)) variants.add(k);
    }
  return {
    format: NEEDS_FORMAT,
    version: NEEDS_VERSION,
    game: o.game || row.game || null,
    variants: [...variants].sort(),
    programs: [],
    reach: [],
    scales: [],
  };
}
