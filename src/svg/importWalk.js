// svg/importWalk.js — DOM tree walk + inherited style resolution.

import { elementChildren, switchChildMatches, resolveIdRef } from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseLength, parseLengthOr } from './length.js';
import { parsePatternDef } from './pattern.js';
import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  CAP_BUTT, CAP_ROUND, CAP_SQUARE,
  JOIN_MITER, JOIN_ROUND, JOIN_BEVEL,
  CAP_ENUM, JOIN_ENUM,
  mkLine, mkQuad, mkCubic, mkArc,
  segStartEnd, segStart, segEnd, segsToPathD,
  arcEndpointToCenter, arcToNative, arcToCubics,
} from './segment.js';
import { tokenizePath, parsePathD } from './path.js';
import {
  IDENT, matMul, matApply, parseTransform,
  transformSegInto, transformArcNative,
} from './transform.js';
import { parseShape } from './shape.js';
import {
  parseStyleString, getParsedStyle, getStyleProp, getInheritedStyleProp, resolveCurrentColor,
  getShapeStyles, isDisplayed, isPaintable, isEffectivelyVisible,
  getCapsJoins, getFillRule,
} from './style.js';
import {
  buildStylesheet, setActiveStylesheet,
} from './stylesheet.js';
import { parseGradients } from './gradient.js';
import { parseFilters } from './filter.js';
import { instantiateMarker, parseMarkers } from './marker.js';
import { parseClipsAndMasks } from './clipMask.js';
import { pathBbox } from './bbox.js';
import { preloadImages } from './image.js';
import { handleTextPaintTag } from './importText.js';
import { handleShapePaintTag } from './importWalkShapes.js';
import { handleImageTag } from './importWalkStructure.js';

const LEAF_PAINT_TAGS = {
  path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polygon: 1, polyline: 1,
  image: 1, text: 1,
};

const BLEND_MODES = {
  'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3,
  'darken': 4, 'lighten': 5, 'color-dodge': 6, 'color-burn': 7,
  'hard-light': 8, 'soft-light': 9, 'difference': 10, 'exclusion': 11,
  'hue': 12, 'saturation': 13, 'color': 14, 'luminosity': 15,
  'plus-lighter': 16, 'add': 16,
  'plus-darker':  17, 'subtract': 17,
  'invert': 18,
  'alpha': 20, 'erase': 21,
};
const G_BLEND_MODES = {
  'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3,
  'darken': 4, 'lighten': 5, 'color-dodge': 6, 'color-burn': 7,
  'hard-light': 8, 'soft-light': 9, 'difference': 10, 'exclusion': 11,
  'hue': 12, 'saturation': 13, 'color': 14, 'luminosity': 15,
  'plus-lighter': 16, 'add': 16,
  'plus-darker':  17, 'subtract': 17,
  'invert': 18,
};

/// Shared walk context threaded through DOM traversal + text handlers.
export function makeImportWalkContext() {
  return {
    walkLayerMode: false,
    // Source element currently being walked (maintained by walk()'s
    // enter/exit) — lets enqueueShape stamp each record with its
    // originating element's renderable-leaf ordinal (sd._domLeaf).
    _curEl: null,
    // >0 while expanding a <use> subtree: the emitted shapes have no
    // element of their own in the source markup (the DOM leaf is the
    // <use> itself), so positional DOM addressing must not claim the
    // referenced element — records get _domLeaf -1.
    _useDepth: 0,
  };
}

/// Parse defs, preload images, build claim registries, walk the DOM tree.
export async function runImportWalk(root, opts, defaultFill, defaultStroke, defaultStrokeW, ctx) {
  const walkCtx = makeImportWalkContext();
  walkCtx.root = root;
  walkCtx.opts = opts;
  walkCtx.ctx = ctx;
  walkCtx.defaultFill = defaultFill;
  walkCtx.defaultStroke = defaultStroke;
  walkCtx.defaultStrokeW = defaultStrokeW;

  // Sprite-sheet allow-list. When opts.sprites is a non-empty array, only
  // those top-level sprite ids are kept; everything else is discarded at
  // enqueue time (never encoded). null => keep everything (the default).
  const _spriteAllow = (Array.isArray(opts.sprites) && opts.sprites.length)
    ? new Set(opts.sprites) : null;
  // Parse gradients and set up claim-on-use registry. Hoisted early so
  // claim-on-use code (including vector patterns) can emit meta rows +
  // push curve/band data during the shape walk.
  const gradientsDict = parseGradients(root);
  const gradientIdBySvgId = {};
  const claimGradient = (svgId) => {
    if (!gradientsDict[svgId]) return 0;
    if (!(svgId in gradientIdBySvgId)) {
      ctx.gradientsUsed.push(gradientsDict[svgId]);
      gradientIdBySvgId[svgId] = ctx.gradientsUsed.length; // 1-based
    }
    return gradientIdBySvgId[svgId];
  };

  // Parse <marker> defs. Markers are instantiated as ordinary shapes at
  // path vertices, so they don't need a separate bundle section — once
  // a stroked path references a marker, we splice the marker's children
  // (transformed to the vertex + tangent) into ctx.shapesData.
  const markersDict = parseMarkers(root);

  // Pre-decode <image> hrefs. Two paths emerge:
  //   - Raster (PNG/JPEG/etc.): { w, h, rgba } records go into the
  //     image atlas; the renderer samples them in the cover frag.
  //   - SVG content (data:image/svg+xml or *.svg URL): { isSvg, svgText }
  //     records bypass the atlas; the walker recursively imports the
  //     nested SVG and splices its shapes into ctx with a transform
  //     mapping the inner viewBox to the outer <image>'s (x, y, w, h)
  //     rect (honoring preserveAspectRatio).
  const imageDataMap = await preloadImages(root,
    opts.svgTextLoader ? { svgTextLoader: opts.svgTextLoader } : undefined);
  // For SVG-content records, pre-parse the inner document and stash
  // the parsed root so the walker can splice it synchronously. We use
  // a separate map (not imageDataMap) so the imageIdByEl flow stays
  // raster-only.
  const nestedSvgRoots = new Map();
  for (const [el, dec] of imageDataMap.entries()) {
    if (!dec.isSvg) continue;
    try {
      const innerDoc = new DOMParser().parseFromString(dec.svgText, 'image/svg+xml');
      const innerRoot = innerDoc.documentElement;
      if (!innerRoot || innerRoot.tagName.toLowerCase() === 'parsererror') continue;
      nestedSvgRoots.set(el, innerRoot);
      // Register the nested SVG's OWN stylesheet (keyed by innerDoc), so
      // its <style> class fills resolve against itself — not the parent's
      // sheet. Keyed per-document, so no clobber with the parent.
      setActiveStylesheet(innerRoot, buildStylesheet(innerRoot));
    } catch (e) {
      mantleWarn(`svgImporter: nested SVG in <image> failed to parse (${e?.message || e}) — skipped`);
    }
  }
  const imageIdByEl = new Map();
  const claimImage = (el) => {
    if (!el || !imageDataMap.has(el)) return 0;
    const dec = imageDataMap.get(el);
    // SVG-content records don't go to the raster atlas — caller
    // dispatches via the isSvg branch below.
    if (dec.isSvg) return 0;
    if (!imageIdByEl.has(el)) {
      ctx.imagesUsed.push(dec);
      imageIdByEl.set(el, ctx.imagesUsed.length);
    }
    return imageIdByEl.get(el);
  };

  // Vector pattern registry. Each entry stores the SHAPE-index range
  // captured into `ctx.shapesData` when claimVectorPattern
  // ran (with walkCtx.walkLayerMode=true). The post-walk meta-emit translates
  // (firstShapeIdx..lastShapeIdx) → (firstMetaRow1..lastMetaRow1) via
  // the shapeToFirstMeta/shapeToLastMeta arrays and stamps the visible
  // shape's atlasSlot accordingly. Pattern children flow through the
  // SAME main walker — every supported feature (transforms, gradients,
  // images, dashes, clips, masks, filters, blends, <use>, paint-order)
  // applies in pattern children with zero duplication.
  const vecPatternIdBySvgId = {};
  // walkCtx.walkLayerMode is set true while the main walk() is traversing a
  // <pattern> subtree. enqueueShape() (see below) decorates each pushed
  // record with isLayer=true and clears blend/isolation so it sits in
  // the bundle as raw sampleable geometry, not a directly-drawn shape.
  // walkLayerMode lives on shared walk context `w` (see makeImportWalkContext).
  // Stack of active <a href> values. Top of stack = href that
  // applies to shapes emitted at the current walker position; empty
  // = no anchor (most content). Pushed/popped by the <a> branch
  // below; consulted by enqueueShape via the `anchorHref` field on
  // each staged record.
  const anchorHrefStack = [];
  const currentAnchorHref = () =>
    anchorHrefStack.length > 0 ? anchorHrefStack[anchorHrefStack.length - 1] : '';
  // Per-element SVG `id` attribute. Stamped on every record `enqueueShape`
  // pushes so the bake loop can fan ids out to per-meta-row entries in
  // bundle.shapeIds. Empty string when the element has no id or the
  // record is a synthetic groupBegin/groupEnd boundary.
  const idStack = [];
  const currentId = () =>
    idStack.length > 0 ? idStack[idStack.length - 1] : '';

  // Ancestor `mask` / `clip-path` attribute stacks. SVG inheritance:
  // when a <g> (or any container) has `mask="url(#m)"` it applies to
  // every descendant shape that doesn't override it. The attribute is
  // tracked on a stack so `<g mask="url(#m)"><rect …/></g>` keeps the
  // mask reference on the descendant.
  // The stack mirrors `idStack`: push the element's own value (or empty)
  // on enter; the shape-leaf reads `currentMaskRef()` and prefers its
  // own attribute when present.
  const maskStack = [];
  const clipStack = [];
  // SVG 1.1 §6.4: `filter` is an inheritable property. Mirror the
  // mask + clip-path stacks so `<g filter="url(#fN)"><path .../></g>`
  // applies the filter to the descendant.
  const filterStack = [];
  const currentMaskRef = () =>
    maskStack.length > 0 ? maskStack[maskStack.length - 1] : '';
  const currentClipRef = () =>
    clipStack.length > 0 ? clipStack[clipStack.length - 1] : '';
  const currentFilterRef = () =>
    filterStack.length > 0 ? filterStack[filterStack.length - 1] : '';
  const claimVectorPattern = (svgId, patternEl) => {
    if (svgId in vecPatternIdBySvgId) {
      // Memoized value 0 acts as a cycle sentinel: a nested pattern
      // child referenced THIS pattern while we were walking it.
      // Returning 0 collapses the back-edge — the child renders
      // without a pattern fill (its base color, if any).
      return vecPatternIdBySvgId[svgId];
    }
    if (!patternEl) return 0;
    const pdef = parsePatternDef(patternEl);
    const tileW = pdef.tileEmW, tileH = pdef.tileEmH;
    if (tileW <= 0 || tileH <= 0) return 0;
    // CYCLE GUARD: stamp the memo with 0 BEFORE walking the
    // subtree. If a pattern child references this same pattern
    // (mutually or self-recursive), the lookup at line above
    // returns 0, the child silently drops the pattern fill, and
    // recursion terminates. The real id is patched in below.
    vecPatternIdBySvgId[svgId] = 0;
    // Re-enter the main walk() on the pattern subtree with
    // walkCtx.walkLayerMode=true. Pattern children flow through the same
    // feature-complete walker as visible shapes — transforms,
    // gradients, images, clips, masks, dashes, blend modes, <use>,
    // paint-order, etc. all "just work" inside patterns with zero
    // duplication.
    const firstShapeIdx = ctx.shapesData.length;
    const savedLayer = walkCtx.walkLayerMode;
    walkCtx.walkLayerMode = true;
    try {
      const _els = elementChildren(patternEl);
      for (let _i = 0; _i < _els.length; _i++) {
        walk(_els[_i], defaultFill, defaultStroke, defaultStrokeW, IDENT);
      }
    } finally { walkCtx.walkLayerMode = savedLayer; }
    const lastShapeIdx = ctx.shapesData.length - 1;
    if (lastShapeIdx < firstShapeIdx) return 0;
    // patternTransform (parsed by parsePatternDef) is applied to the
    // SAMPLE coord in the shader (its inverse); tile children stay walked
    // in pattern-local space (IDENT) since a rotated/skewed tile can't
    // wrap on an axis-aligned lattice.
    ctx.vecPatternsUsed.push({
      firstShapeIdx, lastShapeIdx,
      tileEmW: tileW, tileEmH: tileH,
      patM: pdef.patM,
    });
    const id = ctx.vecPatternsUsed.length;
    vecPatternIdBySvgId[svgId] = id;
    return id;
  };

  // Find the pattern's <pattern> element (already collected at visit time).
  const _patternElById = {};
  // <textPath href="#id"> reference target. Any id'd element with a
  // usable shape definition (path/rect/circle/etc.) qualifies.
  const _shapeElById = {};
  // Parse <filter> defs. The supported subset (color-matrix-only chains)
  // bakes into a per-shape 4×5 matrix that the cover/AA fragment shaders
  // apply to the final color. Unsupported primitives leave the shape
  // unfiltered and emit a one-time console warning. imageResolver gives
  // the parser a callback for <feImage xlink:href="#imgId"> → atlas slot.
  const imageElById = {};
  // id → element registry for <use> resolution. Indexed across the whole
  // tree so ids inside <defs> resolve even though those subtrees don't
  // directly emit shapes.
  const idMap = {};
  // Single setup traversal building all three maps (pattern/shape
  // index, image index, id index) in one pass — same maps, one walk,
  // one getAttribute('id') per element.
  {
    // Hoisted out of the per-node loop so it is built once rather than
    // rebuilt for every visited element.
    const SHAPE_REF_TAGS = {
      path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1,
    };
    const visit = el => {
      if (el.getAttribute) {
        const id = el.getAttribute('id');
        if (id) {
          const tag = (el.tagName || '').toLowerCase();
          idMap[id] = el;
          if (tag === 'pattern') _patternElById[id] = el;
          // Any id'd element with a shape definition is a valid textPath
          // target — SVG allows any basic shape, not just <path>.
          else if (SHAPE_REF_TAGS[tag]) _shapeElById[id] = el;
          else if (tag === 'image') imageElById[id] = el;
        }
      }
      const ks = elementChildren(el);
      for (let i = 0; i < ks.length; i++) visit(ks[i]);
    };
    visit(root);
  }

  // Renderable-leaf ordinals: element → index among rendered leaf shapes in
  // document order. This is the EXACT space the native fallback's positional
  // DOM walk addresses (nativeSvgFallback shapeElByIndex: tag in its
  // RECOLOR_TAGS set, not inside a non-rendered container) — keep the two
  // filters in lockstep. Counted INDEPENDENTLY of what the walk emits
  // (visibility:hidden / paint-less leaves still occupy a DOM slot), so the
  // exported per-meta-row map (bundle.shapeDomIndex) stays aligned with the
  // live markup even when a shape emits 0 or 2 meta rows.
  const leafOrdinalByEl = new Map();
  {
    const ORDINAL_TAGS = {
      path: 1, rect: 1, circle: 1, ellipse: 1, polygon: 1, polyline: 1,
      line: 1, text: 1,
    };
    const NON_RENDER = { defs: 1, mask: 1, clippath: 1, symbol: 1, pattern: 1, marker: 1 };
    let _ord = 0;
    const countLeaves = (el, excluded) => {
      const tag = (el.tagName || '').toLowerCase();
      const ex = excluded || NON_RENDER[tag] === 1;
      if (!ex && el !== root && ORDINAL_TAGS[tag] === 1) leafOrdinalByEl.set(el, _ord++);
      const ks = elementChildren(el);
      for (let i = 0; i < ks.length; i++) countLeaves(ks[i], ex);
    };
    countLeaves(root, false);
  }

  const imageResolver = (href) => {
    if (!href || !href.startsWith('#')) return null;
    const id = href.slice(1);
    const el = imageElById[id];
    if (!el || !imageDataMap.has(el)) return null;
    const dec = imageDataMap.get(el);
    const imageId = claimImage(el);
    if (!imageId) return null;
    return { imageId, w: dec.w, h: dec.h };
  };
  const filtersDict = parseFilters(root, imageResolver);
  const filterIdBySvgId = {};
  const claimFilter = (svgId) => {
    if (!filtersDict[svgId]) return 0;
    if (filtersDict[svgId].kind === 'unsupported') {
      if (!claimFilter._warned) {
        mantleWarn('bundle exporter: unsupported filter primitives in #' + svgId + '; rendering unfiltered.');
        claimFilter._warned = true;
      }
      return 0;
    }
    if (!(svgId in filterIdBySvgId)) {
      ctx.filtersUsed.push(filtersDict[svgId]);
      filterIdBySvgId[svgId] = ctx.filtersUsed.length;
    }
    return filterIdBySvgId[svgId];
  };

  // Parse <clipPath> and <mask> defs; claim-on-use mapping to 1-based IDs.
  // userSpaceOnUse defs are shared across all referencing shapes (one
  // entry in ctx.clipsUsed/ctx.masksUsed). objectBoundingBox defs need a SEPARATE
  // entry per referencing shape because each shape's bbox produces a
  // different transformed geometry. ctx.clipBindings[i] / ctx.maskBindings[i]
  // record the referencing shape's index when entry i is bbox-bound,
  // -1 for shared userSpaceOnUse.
  const { clipPaths: clipDict, masks: maskDict } = parseClipsAndMasks(root);
  const clipIdBySvgId = {};
  // Parallel to ctx.clipsUsed: the SVG `<clipPath id="...">` for each
  // entry, or '' for entries with no id. Drives the post-walk
  // `clipperRows` map so consumers can address the live first-meta-row
  // of a clip by its author-facing svgId (animatable clipper).
  if (!ctx.clipSvgIds) ctx.clipSvgIds = [];
  const claimClip = (svgId, referencingShapeIdx) => {
    const def = clipDict[svgId];
    if (!def) return 0;
    const isObjBBox = def.units === 'objectBoundingBox';
    if (!isObjBBox) {
      if (!(svgId in clipIdBySvgId)) {
        ctx.clipsUsed.push(def);
        ctx.clipBindings.push(-1);
        ctx.clipSvgIds.push(svgId);
        clipIdBySvgId[svgId] = ctx.clipsUsed.length;
      }
      return clipIdBySvgId[svgId];
    }
    ctx.clipsUsed.push(def);
    ctx.clipBindings.push(referencingShapeIdx);
    ctx.clipSvgIds.push(svgId);
    return ctx.clipsUsed.length;
  };
  const maskIdBySvgId = {};
  // Parallel to ctx.masksUsed: the `<mask id="...">` svgId for each entry
  // (mirrors ctx.clipSvgIds). Drives the clipperRows map so the native
  // fallback can address a mask's child <path> by its author-facing id —
  // needed to animate the mask GEOMETRY through a morph (the reveal-wipe
  // case), not just transforms.
  if (!ctx.maskSvgIds) ctx.maskSvgIds = [];
  const claimMask = (svgId, referencingShapeIdx) => {
    const def = maskDict[svgId];
    if (!def) return 0;
    const isObjBBox = def.units === 'objectBoundingBox';
    if (!isObjBBox) {
      if (!(svgId in maskIdBySvgId)) {
        ctx.masksUsed.push(def);
        ctx.maskBindings.push(-1);
        ctx.maskSvgIds.push(svgId);
        maskIdBySvgId[svgId] = ctx.masksUsed.length;
      }
      return maskIdBySvgId[svgId];
    }
    ctx.masksUsed.push(def);
    ctx.maskBindings.push(referencingShapeIdx);
    ctx.maskSvgIds.push(svgId);
    return ctx.masksUsed.length;
  };

  // idMap (id → element, for <use> resolution) is built by the single
  // setup traversal above.

  // Walk tree accumulating inherited style + CTM.
  // enqueueShape: when walkCtx.walkLayerMode is active (claimVectorPattern is
  // re-entering walk() on a <pattern> subtree), decorate each pushed
  // record with isLayer=true and clear blend/isolation so the row sits
  // in the bundle as raw sampleable geometry, not a directly-drawn
  // shape. Group-flatten placeholders are dropped silently (the parent
  // pattern composite doesn't allocate group FBOs for its children).
  function enqueueShape(sd) {
    if (walkCtx.walkLayerMode) {
      if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') return;
      sd.isLayer = true;
      sd.blendMode = 0;
      sd.isolation = 0;
    }
    // Stamp the active <a href> (if any) on every staged record so
    // the bake loop can fan it out to per-meta-row entries in
    // bundle.shapeHrefs. Empty string when not inside <a>.
    if (sd.anchorHref == null) sd.anchorHref = currentAnchorHref();
    // Stamp the originating SVG element's `id=` attribute (if any).
    // Synthetic groupBegin/groupEnd records carry '' — they don't
    // correspond to a single author-facing element. Caller-supplied
    // sd.shapeId wins over the stack so the (rare) explicit-id path
    // (e.g. text-glyph emit that synthesises its own id) is preserved.
    if (sd.shapeId == null) sd.shapeId =
      (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') ? '' : currentId();
    // Sprite-sheet addressing: stamp the TOP-LEVEL sprite id this record
    // belongs to. idStack[0] is the root <svg>'s id (usually ''); idStack[1]
    // is the direct child of root — a top-level <g id> or a lone id'd
    // top-level shape, i.e. one addressable "sprite". Descendants of a
    // top-level group all share that group's id (idStack[1] is stable down
    // the subtree). Empty when the record isn't under any id'd top-level
    // element (not addressable as a sprite). Captured here so the meta loop
    // can build bundle.spriteRanges in meta-row space (clipperRows-style).
    sd._spriteId = (idStack.length > 1 ? idStack[1] : '') || '';
    // Renderable-leaf ordinal of the originating source element (see
    // leafOrdinalByEl above). -1 when the record has no addressable element
    // of its own: <use> expansions (the DOM leaf is the <use>), pattern
    // layer children, group scaffolding, glyphs of a shared <text> get the
    // <text>'s ordinal. Consumed per meta row as bundle.shapeDomIndex by
    // the native fallback's positional addressing.
    if (sd._domLeaf == null) {
      const cur = walkCtx._curEl;
      sd._domLeaf = (walkCtx._useDepth > 0 || walkCtx.walkLayerMode || !cur
        || !leafOrdinalByEl.has(cur)) ? -1 : leafOrdinalByEl.get(cur);
    }
    // opts.sprites allow-list filter: when provided, keep ONLY records whose
    // top-level sprite is listed and DISCARD the rest entirely (never
    // encoded — a smaller bundle, not a hidden one). Group scaffolding
    // (groupBegin/groupEnd) follows its subtree: dropped if its sprite is.
    if (_spriteAllow && sd._spriteId && !_spriteAllow.has(sd._spriteId)) return;
    if (_spriteAllow && !sd._spriteId) return;  // un-id'd top-level = "the rest"
    ctx.shapesData.push(sd);
  }
  walkCtx.enqueueShape = enqueueShape;
  walkCtx.claimClip = claimClip;
  walkCtx.claimMask = claimMask;
  walkCtx.claimFilter = claimFilter;
  walkCtx.currentClipRef = currentClipRef;
  walkCtx.currentMaskRef = currentMaskRef;
  walkCtx.currentFilterRef = currentFilterRef;
  walkCtx._shapeElById = _shapeElById;
  // Shape-leaf emission (importWalkShapes.js) needs the paint-server + marker
  // registries too.
  walkCtx.claimGradient = claimGradient;
  walkCtx.claimVectorPattern = claimVectorPattern;
  walkCtx.claimImage = claimImage;
  walkCtx._patternElById = _patternElById;
  walkCtx.markersDict = markersDict;
  // <image> leaf handler (importWalkStructure.js) needs the decoded-image maps
  // + the walk recursion (for nested-SVG content).
  walkCtx.imageDataMap = imageDataMap;
  walkCtx.nestedSvgRoots = nestedSvgRoots;
  // Outer walk wrapper: maintains the per-element idStack lifecycle
  // (push on enter, pop on every exit path) so enqueueShape can
  // stamp shapeId on any record produced inside this subtree without
  // each callsite having to thread the value through.

  function walk(node, pf, ps, pw, pCtm) {
    // defs-class subtrees never emit shapes; they're collected via
    // dedicated passes (clipPath / mask / gradient / pattern / filter /
    // marker) or simply discarded (<view>). Skip BEFORE pushing the
    // stack so we don't pop something we didn't push.
    const ntag = (node.tagName || '').toLowerCase();
    if (ntag === 'defs' || ntag === 'clippath' || ntag === 'mask' ||
        ntag === 'lineargradient' || ntag === 'radialgradient' || ntag === 'pattern' ||
        ntag === 'symbol' || ntag === 'filter' || ntag === 'marker' ||
        ntag === 'view') return;
    // display:none subtree skip — same rationale: no enqueueShape can
    // fire below, so don't push the stack.
    if (node.getAttribute && !isDisplayed(node)) return;
    const _nodeId = (node.getAttribute && node.getAttribute('id')) || '';
    idStack.push(_nodeId);
    // Track the element being walked so enqueueShape can stamp _domLeaf.
    // Saved/restored (not just cleared) so a parent group's trailing
    // records after child recursion still see the right element.
    const _prevEl = walkCtx._curEl;
    walkCtx._curEl = node;
    // Push this element's own `mask` / `clip-path` if it has one; else
    // re-push the inherited value so descendants see a consistent
    // top-of-stack. Read from both the `style` attr AND direct attrs
    // (SVG accepts both forms). Empty string = no constraint.
    const _ownMask = node.getAttribute
      ? (getStyleProp(node, 'mask', '') || node.getAttribute('mask') || '')
      : '';
    const _ownClip = node.getAttribute
      ? (getStyleProp(node, 'clip-path', '') || node.getAttribute('clip-path') || '')
      : '';
    const _ownFilter = node.getAttribute
      ? (getStyleProp(node, 'filter', '') || node.getAttribute('filter') || '')
      : '';
    maskStack.push(_ownMask || currentMaskRef());
    clipStack.push(_ownClip || currentClipRef());
    filterStack.push(_ownFilter || currentFilterRef());
    try {
      _walkInner(node, pf, ps, pw, pCtm);
    } finally {
      walkCtx._curEl = _prevEl;
      idStack.pop();
      maskStack.pop();
      clipStack.pop();
      filterStack.pop();
    }
  }

  function _walkInner(node, pf, ps, pw, pCtm) {
    const ntag = (node.tagName || '').toLowerCase();
    // visibility:hidden gate for paint-emitting leaves. Group containers
    // (<g>, <svg>, <a>, <switch>, <use>, <symbol>) keep recursing so a
    // descendant with visibility:visible can render. For leaf shape
    // tags, we evaluate the inherited visibility cascade once and skip
    // the emit if hidden — the geometry parse + transform + segs alloc
    // are still wasted, but visibility:hidden is rare enough in
    // production SVGs that the simpler gate is the right tradeoff.
    if (LEAF_PAINT_TAGS[ntag] && !isEffectivelyVisible(node)) return;
    // <use href="#id" x=".." y=".."> instantiates a referenced shape with an
    // optional translation. Resolve via idMap and walk the referenced node
    // with the use's transform + (x,y) translation composed onto the CTM,
    // and the use's inherited style passed down. <symbol> targets are
    // handled by walking their direct children (the symbol element itself
    // doesn't render).
    if (ntag === 'use') {
      const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      const refId = resolveIdRef(href);
      if (!refId || !idMap[refId]) return;
      const target = idMap[refId];
      const localTm2 = parseTransform(node.getAttribute('transform') || '');
      const x = parseLengthOr(node.getAttribute('x') || '0', 0);
      const y = parseLengthOr(node.getAttribute('y') || '0', 0);
      const useTm = matMul(localTm2, [1, 0, 0, 1, x, y]);
      const ctm2 = matMul(pCtm, useTm);
      // <use> can override fill/stroke/etc; resolve with use's own attrs as
      // parents so children can still override via direct attrs.
      const f2 = getStyleProp(node, 'fill', pf);
      const s2 = getStyleProp(node, 'stroke', ps);
      const w2 = parseLengthOr(getStyleProp(node, 'stroke-width', String(pw)), pw);
      // For <symbol> targets, walk their children. For other targets, walk
      // the target itself (it'll emit if it's a shape, or recurse if it's a
      // group).
      const targetTag = (target.tagName || '').toLowerCase();
      // Shapes emitted from a <use> expansion have no source element of
      // their own (the DOM leaf is the <use>) — flag so enqueueShape stamps
      // _domLeaf -1 instead of claiming the referenced element's ordinal.
      walkCtx._useDepth++;
      try {
        if (targetTag === 'symbol') {
          const tk = elementChildren(target);
          for (let i = 0; i < tk.length; i++) walk(tk[i], f2, s2, w2, ctm2);
        } else {
          walk(target, f2, s2, w2, ctm2);
        }
      } finally { walkCtx._useDepth--; }
      return;
    }
    let localTm = parseTransform(node.getAttribute ? node.getAttribute('transform') || '' : '');
    // Nested <svg> introduces its own viewport: x/y offset the inner box on
    // the parent canvas, and viewBox + preserveAspectRatio define an inner
    // coordinate system that is fit into [0..width] × [0..height]. The root
    // <svg> is handled separately at bundle-finalize, so this branch only
    // fires for non-root <svg> elements. SVG 1.1 §7.2 + §7.8.
    if (ntag === 'svg' && node !== root) {
      const sx = parseLengthOr(node.getAttribute('x') || '0', 0);
      const sy = parseLengthOr(node.getAttribute('y') || '0', 0);
      const sw_ = parseLengthOr(node.getAttribute('width')  || '0', 0);
      const sh_ = parseLengthOr(node.getAttribute('height') || '0', 0);
      const vb  = (node.getAttribute('viewBox') || '').trim();
      let vbX = 0, vbY = 0, vbW = 0, vbH = 0, hasVb = false;
      if (vb) {
        const p = vb.split(/[\s,]+/).map(Number);
        if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) {
          vbX = p[0]; vbY = p[1]; vbW = p[2]; vbH = p[3]; hasVb = true;
        }
      }
      // Build viewport transform: Translate(x,y) ∘ FitMatrix ∘ Translate(-vbX,-vbY).
      // FitMatrix scales the viewBox to width/height honoring PAR (xMidYMid
      // meet by default). When no viewBox is present the translate(x,y) is
      // the entire viewport adjustment.
      let vt = [1, 0, 0, 1, sx, sy];
      if (hasVb && sw_ > 0 && sh_ > 0) {
        const parA = (node.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
        const parParts = parA.split(/\s+/);
        const align = (parParts[0] || 'xMidYMid').toLowerCase();
        const slice = (parParts[1] || 'meet').toLowerCase() === 'slice';
        let scaleX = sw_ / vbW, scaleY = sh_ / vbH;
        if (align !== 'none') {
          const s = slice ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
          scaleX = scaleY = s;
        }
        // Alignment offset within the viewport box. Default xMid/yMid.
        const xIdx = align.indexOf('x'), yIdx = align.indexOf('y');
        const xPart = (xIdx >= 0 && yIdx > xIdx) ? align.substring(xIdx + 1, yIdx) : 'mid';
        const yPart = (yIdx >= 0) ? align.substring(yIdx + 1) : 'mid';
        const xFactor = xPart === 'min' ? 0 : xPart === 'max' ? 1 : 0.5;
        const yFactor = yPart === 'min' ? 0 : yPart === 'max' ? 1 : 0.5;
        const tx = sx + (align === 'none' ? 0 : (sw_ - vbW * scaleX) * xFactor) - vbX * scaleX;
        const ty = sy + (align === 'none' ? 0 : (sh_ - vbH * scaleY) * yFactor) - vbY * scaleY;
        vt = [scaleX, 0, 0, scaleY, tx, ty];
      }
      localTm = matMul(vt, localTm);
    }
    const ctm = matMul(pCtm, localTm);
    const f = getStyleProp(node, 'fill', pf);
    const s = getStyleProp(node, 'stroke', ps);
    const w = parseLengthOr(getStyleProp(node, 'stroke-width', String(pw)), pw);
    // Emit shapes.
    const tag = ntag;
    if (handleImageTag(walkCtx, node, tag, ctm, f, s, w)) return;
    if (handleTextPaintTag(walkCtx, node, tag, ctm, pf, ps, pw, f, s, w)) return;
    if (handleShapePaintTag(walkCtx, node, tag, ctm, f, s, w)) return;
    // Group flatten: if this element introduces a compositing group
    // (isolation:isolate, non-normal mix-blend-mode, or opacity < 1
    // applied to a container), wrap the children in a groupBegin /
    // groupEnd pair. Per CSS Compositing & Blending §6 such a group's
    // descendants composite among themselves first, then the result
    // composites onto the parent backdrop using the group's blend
    // mode + opacity. The renderer interprets groupBegin/End to route
    // children through an offscreen FBO.
    let needsGroupFlatten = false;
    let gOpacity = 1, gBlendMode = 0, gIsolation = 0;
    // Element-child list computed once; both the group-flatten count test
    // and the recursion loop below reuse it (elementChildren allocates a
    // fresh array + scans every childNode).
    const kids = elementChildren(node);
    // <a href>: stash the href on the anchor stack so any shape
    // emitted within this subtree records the URL for hit-test
    // consumption. xlink:href fallback per SVG 1.1.
    let pushedAnchor = false;
    if (tag === 'a') {
      const ah = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (ah) { anchorHrefStack.push(ah); pushedAnchor = true; }
    }
    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      const rawOpacity = parseLength(getStyleProp(node, 'opacity', '1'));
      gOpacity = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(1, rawOpacity)) : 1;
      const blendStr = (getStyleProp(node, 'mix-blend-mode', 'normal') || 'normal')
                         .trim().toLowerCase();
      // G_BLEND_MODES (module scope): same as the per-shape map minus the
      // SWF-only alpha/erase extras (groups don't carry those).
      gBlendMode = G_BLEND_MODES[blendStr] || 0;
      const isolStr = (getStyleProp(node, 'isolation', 'auto') || 'auto')
                        .trim().toLowerCase();
      gIsolation = (isolStr === 'isolate') ? 1 : 0;
      // Need flatten if any compositing-changing attribute applies AND
      // the group has more than one descendant shape (a single-leaf
      // group is equivalent to applying the attrs to the leaf).
      const childShapeCount = kids.length;
      needsGroupFlatten =
        (gOpacity < 1 - 1e-6 || gBlendMode !== 0 || gIsolation === 1)
        && childShapeCount > 1;
    }

    if (needsGroupFlatten) {
      enqueueShape({
        kind: 'groupBegin',
        groupOpacity: gOpacity,
        blendMode: gBlendMode,
        isolation: gIsolation,
      });
    }
    if (tag === 'switch') {
      // SVG 1.1 conditional processing: render the FIRST child whose
      // requiredFeatures / requiredExtensions / systemLanguage tests
      // all pass; skip the rest. Real-world SVGs almost always use
      // <switch> with the first child as a fallback-free "default"
      // branch — passing on the first match handles them all.
      for (let i = 0; i < kids.length; i++) {
        if (switchChildMatches(kids[i])) {
          walk(kids[i], f, s, w, ctm);
          break;
        }
      }
    } else {
      for (let i = 0; i < kids.length; i++) walk(kids[i], f, s, w, ctm);
    }
    if (needsGroupFlatten) {
      enqueueShape({ kind: 'groupEnd' });
    }
    if (pushedAnchor) anchorHrefStack.pop();
  }

  walkCtx.walk = walk;
  walk(root, defaultFill, defaultStroke, defaultStrokeW, IDENT);

  return { walk, walkCtx };
}
