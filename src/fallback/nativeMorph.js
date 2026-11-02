// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { imageUvFrame } from '../core/morphImageFrames.js';
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
  applyArcFlagSteps,
  resolveSpriteRange as _morphResolveSpriteRange,
  timelineBracketAt as _timelineBracketAt,
  timelineEase as _timelineEase,
} from '../core/morphCore.js';
import { parseMetaBin } from '../core/metaBin.js';
import { parseGroups } from '../core/morphGroups.js';
import {
  META_FILL_R,
  META_STROKE_R,
  META_STROKE_W,
  META_FILL_GRAD,
  META_STROKE_GRAD,
  META_IMAGE_ID,
  META_STROKE_IMAGE_ID,
} from '../bundle/layout.js';
import { createNativeOverrideTable } from './nativeOverrideTable.js';
import { curveRangeToPathD } from './curveToPathD.js';
import { createGradientMorph } from './nativeGradientPaint.js';

function imageRectangle(curves, begin, end, rect) {
  const [x, y, w, h] = rect,
    X = Math.fround(x + w),
    Y = Math.fround(y + h);
  let edges = 0,
    first = null,
    previous = null;
  for (let i = begin; i < end; i += 12) {
    if ((Math.round(curves[i]) & 3) !== 0) return false;
    const a = curves[i + 4],
      b = curves[i + 5],
      c = curves[i + 6],
      d = curves[i + 7];
    if (a === c && b === d) continue;
    if (previous && (a !== previous[0] || b !== previous[1])) return false;
    if (!first) first = [a, b];
    previous = [c, d];
    let edge;
    if (b === d && ((a === x && c === X) || (a === X && c === x))) {
      if (b === y) edge = 1;
      else if (b === Y) edge = 2;
      else return false;
    } else if (a === c && ((b === y && d === Y) || (b === Y && d === y))) {
      if (a === x) edge = 4;
      else if (a === X) edge = 8;
      else return false;
    } else return false;
    if (edges & edge) return false;
    edges |= edge;
  }
  return edges === 15 && previous[0] === first[0] && previous[1] === first[1];
}

// NaN and undefined read as 0, as the GL morph's clamp01 does.
function clamp01(x) {
  x = +x;
  return x > 1 ? 1 : x > 0 ? x : 0;
}

// The morph's plan/compose helpers expect a BUNDLE-shaped input (the
// typed-array views createBundle produces: metaFloats, curveFloats, …).
// The fallback has no createBundle (no gl), so adapt the importer's
// `sections` dict into the same field names with typed-array views.
// Cached on the sections object so repeated morphs over the same bundle
// are cheap.
function asMorphInput(sections) {
  if (sections.__morphInput) return sections.__morphInput;
  // createBundle output already has these — pass through.
  if (
    sections.metaFloats instanceof Float32Array &&
    (sections.curveFloats instanceof Float32Array || sections.curveTexels instanceof Float32Array)
  ) {
    sections.__morphInput = sections;
    return sections;
  }
  const meta = parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  const adapter = {
    numShapes: sections.numShapes,
    metaFloatsPerShape: sections.metaFloatsPerShape || 48,
    metaFloats: meta.metaFloats,
    curveFloats: sections.curves ? new Float32Array(sections.curves) : new Float32Array(0),
    // The BANDS come along too. Native never rasterizes from them — but the shared
    // morph core walks them to enumerate a shape's segments, which is how it finds
    // the ARC records it has to re-express in endpoint form (prepareArcMorph).
    // Without them that pass silently no-ops, native falls back to lerping arcs in
    // CENTER form, and every arc tears.
    bands: sections.bands || null,
    bandFloats: sections.bands ? new Float32Array(sections.bands) : null,
    curveRangesByShape: sections.curveRangesByShape,
    shapeIds: sections.shapeIds,
    shapeHrefs: sections.shapeHrefs,
    flags: sections.flags,
    globalBBox: sections.globalBBox,
    spriteRanges: sections.spriteRanges,
    spriteRangesNonContiguous: sections.spriteRangesNonContiguous,
    clipperRowSets: sections.clipperRowSets || null,
    strokeMiterLimits: sections.strokeMiterLimits || null,
    shapeDomPaths: sections.shapeDomPaths || null,
    shapeDomIndex: sections.shapeDomIndex || null,
    clipperRows: sections.clipperRows,
    // Side tables forwarded whole (composeMorphSections re-emits them on
    // the morph bundle; the native path doesn't render from them but the
    // helper reads their presence).
    gradientFloats: sections.gradients ? new Float32Array(sections.gradients) : null,
    gradientStopsBytes: sections.gradientStops ? new Uint8Array(sections.gradientStops) : null,
    gradientStopsCount: sections.gradientStopsCount || 0,
    dashFloats: sections.dashes ? new Float32Array(sections.dashes) : null,
    imageAtlas: sections.imageAtlas || null,
    imageAtlasDim: sections.imageAtlasDim || null,
    imageAtlasRects: sections.imageAtlasRects || null,
    imageAtlasSources: sections.imageAtlasSources || null,
    secondaryImageAtlas: sections.secondaryImageAtlas || null,
    secondaryImageAtlasDim: sections.secondaryImageAtlasDim || null,
    filterTab: sections.filterTab || null,
    filterGraphs: sections.filterGraphs || null,
    filterRegions: sections.filterRegions || null,
    filterRegionObb: sections.filterRegionObb || null,
    filterPrimCtms: sections.filterPrimCtms || null,
    kernelTab: sections.kernelTab || null,
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
 * @param {boolean} [opts.alignFullTurnDirection=false] Match full-turn arc direction; may change dash phase and winding.
 * @param {'spec'|'chrome'} [opts.compat='spec'] How an arc flag that differs between the poses interpolates (createShapeMorph).
 * @param {'spec'|'shortest'} [opts.arcRotation='spec'] How an arc's rotation interpolates (createShapeMorph).
 * @returns {{bundle, overrides, setT, plan, unrenderableDstOnly, dispose}}
 */
export function createNativeMorph(srcBundle, dstBundle, opts = {}) {
  if (!srcBundle || !dstBundle) throw new Error('createNativeMorph: two bundles required');
  if (!srcBundle.svgSource)
    throw new Error('createNativeMorph: srcBundle needs svgSource (import with retainSource:true)');

  const srcIn = asMorphInput(srcBundle);
  const dstIn = asMorphInput(dstBundle);

  const srcRange =
    opts.srcSprite != null ? _morphResolveSpriteRange(srcIn, opts.srcSprite, 'src') : null;
  const dstRange =
    opts.dstSprite != null ? _morphResolveSpriteRange(dstIn, opts.dstSprite, 'dst') : null;

  const plan = _morphBuildPlan(srcIn, dstIn, srcRange, dstRange);
  const sections = _morphComposeSections(srcIn, dstIn, plan, opts);
  // The poses with the neutral group rows the group policy added (morphGroups.js); the inputs themselves when it added none.
  const srcRows = plan.srcView || srcIn,
    dstRows = plan.dstView || dstIn;
  const imageFrames = new Map();
  let sourceRoot;
  const isSourceImage = (row) => {
    const path = srcIn.shapeDomPaths?.[row];
    if (!path) return false;
    if (sourceRoot === undefined)
      sourceRoot =
        typeof DOMParser === 'function'
          ? new DOMParser().parseFromString(srcBundle.svgSource, 'image/svg+xml').documentElement
          : null;
    let node = sourceRoot;
    if (!node) return false;
    for (const ordinal of path) {
      const children =
        node.children || Array.from(node.childNodes || []).filter((child) => child.nodeType === 1);
      node = children[ordinal];
      if (!node) return false;
    }
    return node.localName === 'image';
  };
  for (const match of plan.matched) {
    const stride = srcIn.metaFloatsPerShape || 48;
    if (!(
      srcRows.metaFloats[match.srcIdx * stride + 35] > 0 &&
      dstRows.metaFloats[match.dstIdx * stride + 35] > 0
    ))
      continue;
    if (!isSourceImage(match.srcIdx)) continue;
    const a = imageUvFrame(srcIn, match.srcIdx, 28, stride),
      b = imageUvFrame(dstIn, match.dstIdx, 28, stride);
    if (a && b) imageFrames.set(match.srcIdx, [a, b]);
  }

  // The planes to INTERPOLATE. When the morph carries arcs, that is the
  // endpoint-form pair, not the center-form one: a componentwise lerp of
  // center-form arcs pulls their endpoints off the contour and the shape tears
  // (morphCore.prepareArcMorph has the argument).

  // Nor is there a join-tangent rebuild here: the browser strokes the <path>, so
  // nothing ever reads the join texel.
  const arcOffsets = sections._arcOffsets;
  const hasArcs = !!(arcOffsets && arcOffsets.length);
  const epArcs = hasArcs ? new Set(arcOffsets) : null;
  const endPoseRanges = sections._arcEndPoseRanges;
  const merged = hasArcs ? sections._srcEpCurveF32 : sections._mergedCurveF32;
  const dstRemapped = hasArcs ? sections._dstEpCurveF32 : sections._dstCurveF32;

  // An empty source draws in the destination's frame, through its own copy: the table and the stashes below belong on the bundle the morph hands out.
  if (srcIn.numShapes === 0)
    srcBundle = {
      ...srcBundle,
      globalBBox: dstIn.globalBBox.slice(),
      viewBox: (dstBundle.viewBox || dstIn.globalBBox).slice(),
    };

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
    Object.defineProperty(srcBundle, '__nativeMorphOverrides', {
      value: overrides,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    /* frozen bundle — caller must forward overrides explicitly */
  }

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
  const hasLayerShapes = !!(
    (srcBundle.clipperRowSets || srcBundle.clipperRows) &&
    Object.keys(srcBundle.clipperRowSets || srcBundle.clipperRows).length
  );
  const directD = hasLayerShapes ? null : new Array(nMorphShapes);
  let streamGen = 0;
  const setHidden = (k, v) => {
    try {
      Object.defineProperty(srcBundle, k, {
        value: v,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch {
      try {
        srcBundle[k] = v;
      } catch {
        /* frozen */
      }
    }
  };

  // dst-only shapes exist only in the DESTINATION pose, so the cloned SRC
  // markup has no element for them. Decode each one's geometry + paint from
  // the dst bundle and emit it as an "extra shape" the scene injects into
  // the bundle <g> as a fresh <path>, faded IN across t (the mirror of
  // src-only fading out).
  const dstStride = dstIn.metaFloatsPerShape || 48;
  const dstMeta = dstIn.metaFloats;
  const dstCurveF =
    dstIn.curveFloats instanceof Float32Array
      ? dstIn.curveFloats
      : dstIn.curveTexels instanceof Float32Array
        ? dstIn.curveTexels
        : dstIn.curves
          ? new Float32Array(dstIn.curves)
          : new Float32Array(0);
  const dstRanges = dstIn.curveRangesByShape || [];
  // One static descriptor per dst-only shape (geometry + paint don't change
  // with t — only the fade-in alpha does, applied per setT below).
  const extraPlacement = new Map();
  if (sections.drawOrder) {
    const order = sections.drawOrder,
      parents = new Int32Array(order.length).fill(-1),
      stack = [];
    const meta = sections._mergedMetaF32,
      stride = sections._metaStride;
    for (const row of order) {
      const flags = Math.round(meta[row * stride + 27]);
      if (flags & 256) continue;
      if (flags & 128) {
        stack.pop();
        continue;
      }
      parents[row] = stack.length ? stack[stack.length - 1] : -1;
      if (flags & 64) stack.push(row);
    }
    for (let i = 0; i < order.length; i++) {
      const row = order[i];
      if (row < srcRows.numShapes) continue;
      const parentRow = parents[row];
      let beforeRow = -1;
      for (let j = i + 1; j < order.length; j++) {
        const next = order[j],
          flags = Math.round(meta[next * stride + 27]);
        if (next < srcRows.numShapes && parents[next] === parentRow && !(flags & (128 | 256))) {
          beforeRow = next;
          break;
        }
      }
      extraPlacement.set(row, { parentRow, beforeRow });
    }
  }
  const imagePaint = (id, offset) =>
    id > 0
      ? {
          bundle: dstIn,
          id,
          rect: Array.from(dstMeta.subarray(offset + 36, offset + 40)),
          flags: Math.round(dstMeta[offset + 43]),
        }
      : null;
  const extraShapes = plan.dstOnly
    .map((d, k) => {
      const idx = d.dstIdx;
      const r = dstRanges[idx];
      const pathD = r ? curveRangeToPathD(dstCurveF, r.begin, r.end) : '';
      const o = idx * dstStride;
      const fill = dstMeta
        ? [dstMeta[o + 4], dstMeta[o + 5], dstMeta[o + 6], dstMeta[o + 7]]
        : null;
      const stroke = dstMeta
        ? [dstMeta[o + 8], dstMeta[o + 9], dstMeta[o + 10], dstMeta[o + 11]]
        : null;
      const strokeWidth = dstMeta ? dstMeta[o + 12] : 0;
      const evenOdd = !!(dstMeta && dstMeta[o + 13] >= 0.5);
      const dashId = Math.round(dstMeta[o + 15]),
        dash = dstIn.dashFloats;
      const base = (dashId - 1) * 64;
      const pattern =
        dashId > 0 && dash && base + 64 <= dash.length
          ? {
              values: Array.from(dash.subarray(base + 4, base + 4 + Math.round(dash[base + 1]))),
              offset: dash[base + 2],
            }
          : null;
      const resource = (Math.round(dstMeta[o + 27]) & 256) !== 0;
      const retained =
        dstMeta[o + 32] > 0 ||
        dstMeta[o + 28] > 0 ||
        dstMeta[o + 29] > 0 ||
        dstMeta[o + 35] > 0 ||
        dstMeta[o + 47] > 0 ||
        Math.round(dstMeta[o + 43]) === 2;
      return {
        resource,
        mergedRow: srcRows.numShapes + k,
        key: `dstOnly${k}`,
        pathD,
        fill,
        stroke,
        strokeWidth,
        evenOdd,
        alpha: 0,
        filterSource: retained ? dstBundle.svgSource || null : null,
        filterDomPath: dstIn.shapeDomPaths?.[idx] || null,
        filterShapeId: dstIn.shapeIds?.[idx] || null,
        filterGraph: dstIn.filterGraphs?.[Math.round(dstMeta[o + 32]) - 1] || null,
        filterBundle: dstMeta[o + 32] > 0 ? dstIn : null,
        fillImage: imagePaint(dstMeta[o + 35], o),
        strokeImage: imagePaint(dstMeta[o + 47], o),
        cap: Math.round(dstMeta[o + 24]),
        join: Math.round(dstMeta[o + 25]),
        miter: dstMeta[o + 26],
        nonScaling: (Math.round(dstMeta[o + 27]) & 1) !== 0,
        dash: pattern,
        ...extraPlacement.get(srcRows.numShapes + k),
      };
    })
    .filter((s) => s.pathD && !s.resource);

  // dst-only shapes are renderable via extraShapes; nothing is dropped.
  const unrenderableDstOnly = [];

  const participates = new Set();
  for (const m of plan.matched) participates.add(m.srcIdx);
  for (const s of plan.srcOnly) participates.add(s.srcIdx);
  const nShapes = (srcBundle.shapeIds || []).length;
  for (let i = 0; i < nShapes; i++) {
    if (!participates.has(i)) overrides.update(i, { visibility: 0 });
  }

  // PAINT morph. The GL path lerps the morphable meta slots — fill RGBA,
  // stroke RGBA, strokeWidth — alongside the geometry, and a fade is exactly
  // the case where nothing BUT those move: identical contours, fill-opacity
  // 0 → 1. Lerping only the curves leaves such a tween holding the src pose's
  // paint, so the fade snaps at the bracket edge instead of playing.
  //
  // Only SOLID paints can be overridden this way — a gradient or image fill
  // has no single color, and writing one would replace the paint server's
  // url() with a flat color. A GRADIENT the GL morph tweens (same type on both
  // poses; nativeGradientPaint.js) rides its own override, a rebuilt gradient
  // element; an image fill and an incompatible gradient keep their authored paint.
  const metaA = sections._mergedMetaF32,
    metaB = sections._dstAlignedMetaF32;
  const metaStride = sections._metaStride | 0;
  const rowIsSolid = (meta, base, gradSlot, imageSlot) =>
    !(meta[base + gradSlot] > 0) && !(meta[base + imageSlot] > 0);
  const filterOpacityOf = (bundle, row) => {
    if (bundle._drivenFilterOpacities?.has(row)) return bundle._drivenFilterOpacities.get(row);
    const fid = Math.round(bundle.metaFloats[row * (bundle.metaFloatsPerShape || 48) + 32]);
    const data =
      bundle.lastFilterFloats || (bundle.filterTab ? new Float32Array(bundle.filterTab) : null);
    return fid > 0 && data ? 1 - data[(fid - 1) * 24 + 23] : 1;
  };
  const groupPairs = [];
  const paintPairs = [];
  // The rows a begin row without an element of its own stands for: the rows inside it that have one.
  let groupMembers = null;
  const ownElement = (row) =>
    row < srcIn.numShapes &&
    ((srcIn.shapeDomIndex ? srcIn.shapeDomIndex[row] >= 0 : !srcIn.shapeDomPaths) ||
      !!(srcIn.shapeDomPaths && srcIn.shapeDomPaths[row]));
  const membersOf = (beginRow) => {
    if (!groupMembers) {
      groupMembers = new Map();
      if (plan.groupPolicy)
        for (const [row, members] of plan.groupPolicy.virtualMembers)
          groupMembers.set(
            row,
            members.filter((r) => r < srcIn.numShapes && ownElement(r)),
          );
      for (const g of parseGroups(
        srcRows,
        0,
        srcRows.numShapes - 1,
        srcRows.metaFloatsPerShape || 48,
      ) || [])
        if (!groupMembers.has(g.b))
          groupMembers.set(
            g.b,
            g.members.filter((r) => r < srcIn.numShapes && ownElement(r)),
          );
    }
    return groupMembers.get(beginRow) || [];
  };
  const gradients = createGradientMorph(sections);
  if (metaA && metaB && metaStride > 0) {
    for (const m of plan.matched) {
      const base = m.srcIdx * metaStride;
      const flags = Math.round(metaA[base + 27]);
      if (flags & (64 | 128)) {
        if (flags & 64)
          groupPairs.push({
            srcIdx: m.srcIdx,
            base,
            members: ownElement(m.srcIdx) ? null : membersOf(m.srcIdx),
          });
        continue;
      }
      if (base + metaStride > metaA.length || base + metaStride > metaB.length) continue;
      const moved = (lo, n) => {
        for (let i = 0; i < n; i++) if (metaA[base + lo + i] !== metaB[base + lo + i]) return true;
        return false;
      };
      // A paint this morph CAN drive: solid in both poses, and actually
      // painted in at least one of them.
      const drivable = (lo, gradSlot, imageSlot) =>
        rowIsSolid(metaA, base, gradSlot, imageSlot) &&
        rowIsSolid(metaB, base, gradSlot, imageSlot) &&
        (metaA[base + lo + 3] > 0 || metaB[base + lo + 3] > 0);
      const fill = drivable(META_FILL_R, META_FILL_GRAD, META_IMAGE_ID);
      const stroke = drivable(META_STROKE_R, META_STROKE_GRAD, META_STROKE_IMAGE_ID);
      const width = metaA[base + META_STROKE_W] !== metaB[base + META_STROKE_W];
      // Trigger on MOVEMENT, but then drive every drivable paint: the native
      // scene can only neutralize the element's authored `opacity` (already
      // folded into these colors) when nothing is left reading it.
      // A gradient this morph CAN drive: the row's record id (remapped into the merged table) is one the GL plan tweens,
      // and it differs between the poses.
      const gradientOf = (slot, imageSlot) => {
        if (!gradients || metaA[base + imageSlot] > 0) return 0;
        const id = Math.round(metaA[base + slot]);
        return id > 0 && gradients.moves(id) ? id : 0;
      };
      const gradFill = gradientOf(META_FILL_GRAD, META_IMAGE_ID),
        gradStroke = gradientOf(META_STROKE_GRAD, META_STROKE_IMAGE_ID);
      const moves =
        (fill && moved(META_FILL_R, 4)) ||
        (stroke && moved(META_STROKE_R, 4)) ||
        width ||
        gradFill > 0 ||
        gradStroke > 0;
      const filtered = metaA[base + 32] > 0;
      const opacityA = filterOpacityOf(srcIn, m.srcIdx),
        opacityB = filterOpacityOf(dstIn, m.dstIdx);
      if (moves || (filtered && opacityA !== opacityB))
        paintPairs.push({
          srcIdx: m.srcIdx,
          base,
          fill,
          stroke,
          width,
          gradFill,
          gradStroke,
          filtered,
          opacityA,
          opacityB,
        });
    }
  }
  const paintOf = new Set(paintPairs.map((p) => p.srcIdx));
  // A shape whose paint moves rides the override TABLE end to end (geometry
  // included) so one writer owns its attributes for the frame.
  const lerp4 = (lo, base, t) => [
    metaA[base + lo] * (1 - t) + metaB[base + lo] * t,
    metaA[base + lo + 1] * (1 - t) + metaB[base + lo + 1] * t,
    metaA[base + lo + 2] * (1 - t) + metaB[base + lo + 2] * t,
    metaA[base + lo + 3] * (1 - t) + metaB[base + lo + 3] * t,
  ];

  let lastT = NaN;
  function setT(t) {
    t = clamp01(t);
    // Idle tickers often re-set the same hold pose every rAF. Rewriting
    // pathD + bumping generation/__streamGen would defeat dirty-frame skip.
    if (t === lastT) return t;
    lastT = t;
    // One generation bump per pose, not one per shape: the scene re-walks the
    // whole table on any bump, so an unbatched pose looked like N changes.
    overrides.beginBatch?.();
    try {
      lerp.set(merged);
      // Curve lerp for matched shapes, then decode each to a `d` string
      // and stash as a pathD override the scene applies to the <path>.
      for (const m of plan.matched) {
        for (let i = m.srcBegin; i < m.srcEnd; i++) {
          lerp[i] = merged[i] * (1 - t) + dstRemapped[i] * t;
        }
      }
      applyArcFlagSteps(lerp, sections._arcFlagSteps, t);
      for (const m of plan.matched) {
        if (metaA && Math.round(metaA[m.srcIdx * metaStride + 27]) & (64 | 128)) continue;
        // Arcs stay in ENDPOINT form all the way to the `d` string — see above.
        // (an end pose whose own arc flags differ from the poses between decodes from its center-form plane: morphCore endPoseRanges)
        const exactEnd =
          endPoseRanges &&
          (t === 0 || t === 1) &&
          endPoseRanges.some((r) => r.begin === m.srcBegin);
        const d = exactEnd
          ? curveRangeToPathD(
              t === 0 ? sections._mergedCurveF32 : sections._dstCurveF32,
              m.srcBegin,
              m.srcEnd,
            )
          : curveRangeToPathD(lerp, m.srcBegin, m.srcEnd, epArcs);
        const base = m.srcIdx * metaStride,
          flags = metaA ? Math.round(metaA[base + 27]) : 0;
        if (metaA && metaA[base + 35] > 0 && flags & 256) continue;
        let imageRow = metaA && metaA[base + 35] > 0 ? m.srcIdx : -1,
          frame = null,
          repeat = false;
        if (metaA && Math.round(metaA[base + 43]) === 2 && metaA[base + 40] === metaA[base + 41]) {
          const child = Math.round(metaA[base + 40]) - 1;
          if (child >= 0 && metaA[child * metaStride + 35] > 0) {
            const [a, b, c, e] = Array.from(metaA.subarray(base + 20, base + 24)),
              det = a * e - b * c;
            if (det !== 0) {
              const origin = lerp4(36, base, t);
              frame = [
                e / det,
                -b / det,
                -c / det,
                a / det,
                (e * origin[0] - c * origin[1]) / det,
                (-b * origin[0] + a * origin[1]) / det,
              ];
              imageRow = child;
              repeat = true;
            }
          }
        }
        if (imageRow >= 0) {
          const imageBase = imageRow * metaStride;
          let imageRect = lerp4(36, imageBase, t),
            direct = !repeat && imageRectangle(lerp, m.srcBegin, m.srcEnd, imageRect),
            directFrame = null;
          const endpoints = !repeat && imageFrames.get(m.srcIdx);
          if (endpoints) {
            directFrame = endpoints[0].map((v, i) => v * (1 - t) + endpoints[1][i] * t);
            imageRect = [0, 0, 1, 1];
            direct = true;
          }
          overrides.update(m.srcIdx, {
            pathD: d,
            bitmapPaint: {
              bundle: srcIn,
              id: metaA[imageBase + 35],
              rect: imageRect,
              direct,
              directFrame,
              opacity: metaA[base + 7] * (1 - t) + metaB[base + 7] * t,
              bounds: lerp4(0, base, t),
              frame,
              repeat,
              tile: repeat ? lerp4(36, base, t).slice(2) : null,
              role: metaA[base + 7] > 0 ? 'fill' : 'stroke',
            },
          });
          continue;
        }
        // Matched shapes are always visible (never hidden), so no visibility
        // entry is needed on the fast path — geometry alone.
        if (directD && !paintOf.has(m.srcIdx)) directD[m.srcIdx] = d;
        else overrides.update(m.srcIdx, { pathD: d, visibility: 1 });
      }
      for (const group of groupPairs) {
        const opacity = metaA[group.base + 7] * (1 - t) + metaB[group.base + 7] * t;
        // A group with an element of its own (a <g opacity>) is driven through its begin row; a leaf's group (opacity over its fill
        // and stroke, or the neutral partner of one) has none, so the leaf's element takes the opacity from the leaf's rows.
        if (group.members)
          for (const row of group.members) overrides.update(row, { elementOpacity: opacity });
        else overrides.update(group.srcIdx, { groupOpacity: opacity });
      }
      for (const p of paintPairs) {
        const o = {};
        if (p.filtered) o.filterOpacity = p.opacityA * (1 - t) + p.opacityB * t;
        if (p.fill) o.fill = lerp4(META_FILL_R, p.base, t);
        if (p.stroke) o.stroke = lerp4(META_STROKE_R, p.base, t);
        if (p.width)
          o.strokeWidth =
            metaA[p.base + META_STROKE_W] * (1 - t) + metaB[p.base + META_STROKE_W] * t;
        if (p.gradFill || p.gradStroke) {
          // A gradient row's color is white; one paired with a solid carries that solid's color across, and its stops read as white at that end (core/morphGradients.js).
          const tinted = (spec, lo) => {
            if (!spec) return spec;
            const c = lerp4(lo, p.base, t);
            return c[0] === 1 && c[1] === 1 && c[2] === 1
              ? spec
              : {
                  ...spec,
                  stops: spec.stops.map((q) => [q[0], q[1] * c[0], q[2] * c[1], q[3] * c[2], q[4]]),
                };
          };
          const fillSpec = p.gradFill ? tinted(gradients.specAt(p.gradFill, t), META_FILL_R) : null,
            strokeSpec = p.gradStroke
              ? tinted(gradients.specAt(p.gradStroke, t), META_STROKE_R)
              : null;
          if (fillSpec || strokeSpec) o.gradientPaint = { fill: fillSpec, stroke: strokeSpec };
        }
        overrides.update(p.srcIdx, o);
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
      if (directD) {
        setHidden('__streamPathD', directD);
        setHidden('__streamGen', ++streamGen);
      }
      return t;
    } finally {
      overrides.endBatch?.();
    }
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
      try {
        delete srcBundle.__nativeMorphOverrides;
      } catch {
        /* ignore */
      }
      try {
        delete srcBundle.__streamPathD;
        delete srcBundle.__streamGen;
      } catch {
        /* ignore */
      }
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
 * @param {{compat?: 'spec'|'chrome', arcRotation?: 'spec'|'shortest'}} [opts] Every bracket's morph takes them (createShapeMorph).
 * @returns {{bundle, overrides, currentMorph, setTime, dispose}}
 */
export function createNativeTimeline(refs, keys, opts = {}) {
  if (!Array.isArray(refs) || refs.length === 0)
    throw new Error('createNativeTimeline: refs required');
  if (!Array.isArray(keys) || keys.length === 0)
    throw new Error('createNativeTimeline: keys required');

  // The GL timelines' key contract: finite, time-sorted keys that reference a real pose.
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i] || !Number.isFinite(keys[i].time))
      throw new Error('createNativeTimeline: key times must be finite numbers');
    if (i > 0 && keys[i].time < keys[i - 1].time)
      throw new Error('createNativeTimeline: keys must be time-sorted');
    const k = keys[i],
      ref = k.refIndex != null ? k.refIndex : k.bundleIndex != null ? k.bundleIndex : 0;
    if (!(ref >= 0 && ref < refs.length && Number.isInteger(ref)))
      throw new Error(
        `createNativeTimeline: key ${k.refIndex != null ? 'refIndex' : 'bundleIndex'} ${ref} out of range`,
      );
  }

  const norm = refs.map((r) => (r && r.bundle ? r : { bundle: r, sprite: undefined }));
  // The scene clones this bundle's markup; use ref 0's bundle (every
  // pose shares the same source artwork in the common single-sheet case).
  const hostBundle = norm[0].bundle;

  let curMorph = null,
    curLo = -1,
    curHi = -1;

  function buildBracket(iLo, iHi) {
    const lo = norm[iLo],
      hi = norm[iHi];
    // The last bracket's stashes on its source pose would draw that pose at the bracket's last t.
    if (curMorph) curMorph.dispose();
    curMorph = createNativeMorph(lo.bundle, hi.bundle, {
      srcSprite: lo.sprite,
      dstSprite: hi.sprite,
      compat: opts && opts.compat,
      arcRotation: opts && opts.arcRotation,
    });
    curLo = iLo;
    curHi = iHi;
  }

  // Key.refIndex (sprite timeline) or key.bundleIndex (shape timeline).
  function keyRef(k) {
    return k.refIndex != null ? k.refIndex : k.bundleIndex != null ? k.bundleIndex : 0;
  }

  let lastTime = NaN;
  function setTime(time) {
    time = +time;
    if (time !== time) time = keys[0].time; // NaN reads as the first key, as in the GL timelines
    if (time === lastTime) return curMorph;
    lastTime = time;
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
    get bundle() {
      return curMorph ? curMorph.bundle : hostBundle;
    },
    // `currentMorph` exposes the active morph (with its .overrides + .setT),
    // mirroring the GL sprite timeline so a consumer reading
    // `handle.currentMorph?.overrides` works on both backends. `overrides`
    // is kept as a direct shortcut.
    get currentMorph() {
      return curMorph;
    },
    get overrides() {
      return curMorph ? curMorph.overrides : null;
    },
    setTime,
    dispose() {
      if (curMorph) curMorph.dispose();
    },
  };
}
