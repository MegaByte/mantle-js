// nativeMorph.js — geometry morphs + timelines for the no-WebGL
// fallback. Runs the same CPU curve lerp as the WebGL morph (reusing the
// engine's plan/compose helpers) but decodes each matched shape's lerped
// curves into an SVG path `d` string, written onto the native override
// table as a `pathD`. The native scene rewrites each shape's <path d="…">
// per frame so the browser's SVG engine rasterizes the tweened geometry.
//
//   const morph = createNativeMorph(srcBundle, dstBundle);
//   scene.drawBundle(morph.bundle, { overrides: morph.overrides });
//   morph.setT(0.5);     // lerp; writes pathD + visibility to overrides
//
// The morph's `bundle` is the SRC bundle (it carries the source markup
// the scene clones); setT mutates the shared override table, which the
// scene reads to rewrite geometry.
//
// MATCHED-topology shapes (same id / position, same curve length) tween
// geometrically; mismatched shapes crossfade by visibility. src-only shapes
// fade OUT; dst-only shapes (geometry present only in the destination pose,
// with no element in the cloned source markup) are decoded from the dst
// bundle and INJECTED as fresh <path>s the scene fades IN.
// `morph.unrenderableDstOnly` is therefore empty (kept for API compatibility).

// Import the morph machinery + meta parser from the GL-free core, NOT
// from shapeMorph.js / renderer/bundle.js — those statically pull the
// WebGL renderer (createBundle / createOverrideTable). Going straight to
// the core keeps the native build free of any GL code.
import {
  buildMorphPlan as _morphBuildPlan,
  composeMorphSections as _morphComposeSections,
  resolveSpriteRange as _morphResolveSpriteRange,
  timelineBracketAt as _timelineBracketAt,
  timelineEase as _timelineEase,
} from '../core/morphCore.js';
import { parseMetaBin } from '../core/metaBin.js';
import { createNativeOverrideTable } from './nativeOverrideTable.js';
import { curveRangeToPathD } from './curveToPathD.js';

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// The morph's plan/compose helpers expect a BUNDLE-shaped input (the
// typed-array views createBundle produces: metaFloats, curveFloats, …).
// The fallback has no createBundle (no gl), so adapt the importer's
// `sections` dict into the same field names with typed-array views.
// Cached on the sections object so repeated morphs over the same bundle
// are cheap.
function asMorphInput(sections) {
  if (sections.__morphInput) return sections.__morphInput;
  // createBundle output already has these — pass through.
  if (sections.metaFloats instanceof Float32Array
      && (sections.curveFloats instanceof Float32Array
          || sections.curveTexels instanceof Float32Array)) {
    sections.__morphInput = sections;
    return sections;
  }
  const meta = parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  const adapter = {
    numShapes: sections.numShapes,
    metaFloatsPerShape: sections.metaFloatsPerShape || 48,
    metaFloats: meta.metaFloats,
    curveFloats: sections.curves ? new Float32Array(sections.curves) : new Float32Array(0),
    curveRangesByShape: sections.curveRangesByShape,
    shapeIds: sections.shapeIds,
    flags: sections.flags,
    globalBBox: sections.globalBBox,
    spriteRanges: sections.spriteRanges,
    spriteRangesNonContiguous: sections.spriteRangesNonContiguous,
    clipperRows: sections.clipperRows,
    // Side tables forwarded WHOLE (composeMorphSections re-emits them on
    // the morph bundle; the native path doesn't render from them but the
    // helper reads their presence).
    gradientFloats: sections.gradients ? new Float32Array(sections.gradients) : null,
    gradientStopsBytes: sections.gradientStops ? new Uint8Array(sections.gradientStops) : null,
    gradientStopsCount: sections.gradientStopsCount || 0,
    strokeMesh: sections.strokeMesh || null,
    clipMesh: sections.clipMesh || null,
    maskMesh: sections.maskMesh || null,
    // Keep the source for the scene + a back-pointer.
    svgSource: sections.svgSource,
    __sections: sections,
  };
  sections.__morphInput = adapter;
  return adapter;
}

/**
 * Build a native (DOM) morph between two bundles (or two sprites).
 *
 * @param {object} srcBundle  must carry svgSource (retainSource import)
 * @param {object} dstBundle
 * @param {object} [opts]
 * @param {string|[number,number]} [opts.srcSprite]  morph one sprite only
 * @param {string|[number,number]} [opts.dstSprite]
 * @returns {{bundle, overrides, setT, plan, unrenderableDstOnly, dispose}}
 */
export function createNativeMorph(srcBundle, dstBundle, opts = {}) {
  if (!srcBundle || !dstBundle) throw new Error('createNativeMorph: two bundles required');
  if (!srcBundle.svgSource)
    throw new Error('createNativeMorph: srcBundle needs svgSource (import with retainSource:true)');

  const srcIn = asMorphInput(srcBundle);
  const dstIn = asMorphInput(dstBundle);

  const srcRange = opts.srcSprite != null
    ? _morphResolveSpriteRange(srcIn, opts.srcSprite, 'src') : null;
  const dstRange = opts.dstSprite != null
    ? _morphResolveSpriteRange(dstIn, opts.dstSprite, 'dst') : null;

  const plan = _morphBuildPlan(srcIn, dstIn, srcRange, dstRange);
  const sections = _morphComposeSections(srcIn, dstIn, plan);

  const merged = sections._mergedCurveF32;          // src curves (baseline)
  const dstRemapped = sections._dstCurveF32;        // dst curves at src slots

  // The override table the scene reads. Native (CPU) — no gl. Addresses
  // shapes by the SRC bundle's ids (same as srcIn.shapeIds).
  const overrides = createNativeOverrideTable(srcBundle);

  // On native the tween lives in this override table, which the caller must
  // forward every frame — a draw path that forgets to (e.g. one that only
  // passes a recolor table, or none) renders the static src pose, so the
  // animation snaps pose-to-pose at bracket edges. Stash the table on the
  // bundle so the native scene auto-applies it when no explicit overrides
  // are passed, making drawBundle(morph.bundle) self-sufficient. An
  // explicitly-passed table still wins.
  try {
    Object.defineProperty(srcBundle, '__nativeMorphOverrides',
      { value: overrides, configurable: true, enumerable: false, writable: true });
  } catch { /* frozen bundle — caller must forward overrides explicitly */ }

  // Scratch reused each setT to avoid per-frame allocation.
  const lerp = new Float32Array(merged.length);

  // Fast geometry path: when the src bundle has NO clip/mask LAYER shapes
  // (matched shapes are then all rendered <path> leaves, addressable by the
  // scene's positional shapeElByIndex), stream the matched-shape `d` strings
  // straight onto the cloned elements via the bundle's direct-write stash
  // (__streamPathD) instead of the override table — the same allocation-light
  // route the road uses, skipping the per-shape get()/applyShapeOverride
  // diffing. Layer-geometry morphs (animated <mask>/<clipPath>) keep the table
  // path, which addresses layer children via layerChildEl. Visibility fades
  // (src-only / hides) and dst-only extras always ride the table — disjoint
  // shapes, so both routes coexist in one draw.
  const nMorphShapes = (srcBundle.shapeIds || []).length;
  const hasLayerShapes = !!(srcBundle.clipperRows && Object.keys(srcBundle.clipperRows).length);
  const directD = hasLayerShapes ? null : new Array(nMorphShapes);
  let streamGen = 0;
  const setHidden = (k, v) => {
    try { Object.defineProperty(srcBundle, k, { value: v, configurable: true, enumerable: false, writable: true }); }
    catch { try { srcBundle[k] = v; } catch { /* frozen */ } }
  };

  // dst-only shapes exist only in the DESTINATION pose, so the cloned SRC
  // markup has no element for them. Decode each one's geometry + paint from
  // the dst bundle and emit it as an "extra shape" the scene injects into
  // the bundle <g> as a fresh <path>, faded IN across t (the mirror of
  // src-only fading out).
  const dstStride = dstIn.metaFloatsPerShape || 48;
  const dstMeta = dstIn.metaFloats;
  const dstCurveF = dstIn.curveFloats instanceof Float32Array
    ? dstIn.curveFloats
    : (dstIn.curveTexels instanceof Float32Array ? dstIn.curveTexels
       : (dstIn.curves ? new Float32Array(dstIn.curves) : new Float32Array(0)));
  const dstRanges = dstIn.curveRangesByShape || [];
  // One static descriptor per dst-only shape (geometry + paint don't change
  // with t — only the fade-in alpha does, applied per setT below).
  const extraShapes = plan.dstOnly.map((d, k) => {
    const idx = d.dstIdx;
    const r = dstRanges[idx];
    const pathD = r ? curveRangeToPathD(dstCurveF, r.begin, r.end) : '';
    const o = idx * dstStride;
    const fill = dstMeta ? [dstMeta[o + 4], dstMeta[o + 5], dstMeta[o + 6], dstMeta[o + 7]] : null;
    const stroke = dstMeta ? [dstMeta[o + 8], dstMeta[o + 9], dstMeta[o + 10], dstMeta[o + 11]] : null;
    const strokeWidth = dstMeta ? dstMeta[o + 12] : 0;
    const evenOdd = !!(dstMeta && dstMeta[o + 13] >= 0.5);
    return { key: `dstOnly${k}`, pathD, fill, stroke, strokeWidth, evenOdd, alpha: 0 };
  }).filter(s => s.pathD);

  // dst-only shapes are now renderable via extraShapes; nothing is dropped.
  const unrenderableDstOnly = [];

  // The morph renders ONLY the morphing sprite. The src-bundle markup we
  // clone, though, also contains the DST sprite's elements (same-sheet
  // case) and any other shapes — all of which must be hidden so they
  // don't paint alongside the tween. Allow-list = the src shapes that
  // participate (matched srcIdx + srcOnly); hide everything else once.
  const participates = new Set();
  for (const m of plan.matched) participates.add(m.srcIdx);
  for (const s of plan.srcOnly) participates.add(s.srcIdx);
  const nShapes = (srcBundle.shapeIds || []).length;
  for (let i = 0; i < nShapes; i++) {
    if (!participates.has(i)) overrides.update(i, { visibility: 0 });
  }

  function setT(t) {
    t = clamp01(t);
    lerp.set(merged);
    // Curve lerp for matched shapes, then decode each to a `d` string
    // and stash as a pathD override the scene applies to the <path>.
    for (const m of plan.matched) {
      for (let i = m.srcBegin; i < m.srcEnd; i++) {
        lerp[i] = merged[i] * (1 - t) + dstRemapped[i] * t;
      }
      const d = curveRangeToPathD(lerp, m.srcBegin, m.srcEnd);
      // Matched shapes are always visible (never hidden), so no visibility
      // entry is needed on the fast path — geometry alone.
      if (directD) directD[m.srcIdx] = d;
      else overrides.update(m.srcIdx, { pathD: d, visibility: 1 });
    }
    // src-only fade OUT; matched stay visible; dst-only fade IN (injected
    // as extra <path>s by the scene — see overrides.extraShapes).
    for (const s of plan.srcOnly) {
      overrides.update(s.srcIdx, { visibility: 1 - t });
    }
    for (const e of extraShapes) e.alpha = t;
    overrides.bumpExtras();
    // Publish the matched-shape geometry to the direct-write stash (the array
    // ref is stable; only the gen bump tells the scene to re-apply).
    if (directD) { setHidden('__streamPathD', directD); setHidden('__streamGen', ++streamGen); }
    return t;
  }

  // Expose the dst-only injected shapes on the override table so the scene
  // (which reads drawOpts.overrides) can mount + update them. A small
  // generation bump lets the scene skip work when nothing changed.
  overrides.setExtraShapes(extraShapes);

  setT(0);

  return {
    bundle: srcBundle,
    overrides,
    plan,
    unrenderableDstOnly,
    setT,
    dispose() {
      overrides.dispose();
      // Clear the auto-apply stash so a later direct draw of this pose
      // bundle doesn't pick up a disposed morph's geometry.
      try { delete srcBundle.__nativeMorphOverrides; } catch { /* ignore */ }
      try { delete srcBundle.__streamPathD; delete srcBundle.__streamGen; } catch { /* ignore */ }
    },
  };
}

/**
 * N-keyframe native timeline over bundle refs (the fallback analogue of
 * createShapeTimeline). Each adjacent key-pair is a native morph blended
 * with the key's easing. Refs may be plain bundles (createShapeTimeline
 * style) or {bundle, sprite} refs (createSpriteTimeline style).
 *
 * @param {Array<object|{bundle,sprite}>} refs
 * @param {Array<{time, refIndex?, bundleIndex?, interp?, outX?, outY?, inX?, inY?}>} keys
 * @returns {{bundle, overrides, setTime, dispose}}
 */
export function createNativeTimeline(refs, keys) {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error('createNativeTimeline: refs required');
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('createNativeTimeline: keys required');

  const norm = refs.map(r => (r && r.bundle) ? r : { bundle: r, sprite: undefined });
  // The scene clones THIS bundle's markup; use ref 0's bundle (every
  // pose shares the same source artwork in the common single-sheet case).
  const hostBundle = norm[0].bundle;

  let curMorph = null, curLo = -1, curHi = -1;

  function buildBracket(iLo, iHi) {
    const lo = norm[iLo], hi = norm[iHi];
    curMorph = createNativeMorph(lo.bundle, hi.bundle, {
      srcSprite: lo.sprite, dstSprite: hi.sprite,
    });
    curLo = iLo; curHi = iHi;
  }

  // Key.refIndex (sprite timeline) or key.bundleIndex (shape timeline).
  function keyRef(k) {
    return k.refIndex != null ? k.refIndex : (k.bundleIndex != null ? k.bundleIndex : 0);
  }

  function setTime(time) {
    const { iLo, iHi, localT } = _timelineBracketAt(keys, time);
    const rLo = keyRef(keys[iLo]);
    const rHi = keyRef(keys[iHi]);
    if (rLo === rHi) {
      // Hold a single pose: a lo→lo morph pinned at t=0 (matched shapes
      // render at their src geometry, nothing fades).
      if (!(curLo === rLo && curHi === rLo)) buildBracket(rLo, rLo);
      curMorph.setT(0);
      return curMorph;
    }
    if (!(curLo === rLo && curHi === rHi)) buildBracket(rLo, rHi);
    curMorph.setT(_timelineEase(keys[iLo], localT));
    return curMorph;
  }

  setTime(keys[0].time);

  return {
    // `bundle` is the live morph bundle (the host markup it renders);
    // matches the GL timeline's `get bundle() { return curMorph.bundle }`.
    get bundle() { return curMorph ? curMorph.bundle : hostBundle; },
    // `currentMorph` exposes the active morph (with its .overrides + .setT),
    // mirroring the GL sprite timeline so a consumer reading
    // `handle.currentMorph?.overrides` works on both backends. `overrides`
    // is kept as a direct shortcut.
    get currentMorph() { return curMorph; },
    get overrides() { return curMorph ? curMorph.overrides : null; },
    setTime,
    dispose() { if (curMorph) curMorph.dispose(); },
  };
}
