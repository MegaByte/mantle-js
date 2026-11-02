// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/importWalk.js — DOM tree walk + inherited style resolution.

import {
  svgElementName,
  elementChildren,
  switchChildMatches,
  resolveSwitchLanguages,
  resolveIdRef,
  elementDepthExceeds,
  MAX_ELEMENT_DEPTH,
} from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseLength, parseLengthOr } from './length.js';
import { resolvePatternDef } from './pattern.js';
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  CAP_BUTT,
  CAP_ROUND,
  CAP_SQUARE,
  JOIN_MITER,
  JOIN_ROUND,
  JOIN_BEVEL,
  CAP_ENUM,
  JOIN_ENUM,
  mkLine,
  mkQuad,
  mkCubic,
  mkArc,
  segStartEnd,
  segStart,
  segEnd,
  segsToPathD,
  arcEndpointToCenter,
  arcToNative,
  arcToCubics,
  clampSegsToF32,
} from './segment.js';
import { tokenizePath, parsePathD } from './path.js';
import {
  IDENT,
  matMul,
  matApply,
  parseTransform,
  transformSegInto,
  transformArcNative,
  viewBoxFit,
  parseAspect,
  viewBoxDisablesRendering,
} from './transform.js';
import { parseColor, setColorCompat } from './color.js';
import { parseShape } from './shape.js';
import {
  parseStyleString,
  getParsedStyle,
  getStyleProp,
  getInheritedStyleProp,
  resolveCurrentColor,
  withCurrentColor,
  getShapeStyles,
  getStrokeWidth,
  isDisplayed,
  isPaintable,
  isEffectivelyVisible,
  getCapsJoins,
  getFillRule,
  inheritedChannelOpacities,
  parseAlphaOr,
  setInheritanceChain,
  getPaintProp,
  resolveFontSize,
  domFontSize,
  INITIAL_FONT_SIZE,
  getPointerEvents,
} from './style.js';
import { hitBitsOf, keepInvisibleOf, keepHiddenOf } from './hitBits.js';
const STABLE_ID_TAGS = {
  path: 1,
  rect: 1,
  circle: 1,
  ellipse: 1,
  polygon: 1,
  polyline: 1,
  line: 1,
};
import { buildStylesheet, setActiveStylesheet } from './stylesheet.js';
import { parseGradients, isSingularMatrix } from './gradient.js';
import { parseFilters } from './filter.js';
import {
  blurFollowsAxes,
  morphFollowsAxes,
  ctmLinearIsIdentity,
  recordNeedsLinear,
  recordNeedsFullCtm,
} from './importFilters.js';
import { scanFilterList, isPlainUrlRef, canonicalFilter, filterListGraph } from './cssFilter.js';
import { instantiateMarker, parseMarkers } from './marker.js';
import { parseClipsAndMasks } from './clipMask.js';
import { parseClipPathShape } from './basicShape.js';
import { pathBbox } from './bbox.js';
import { strokeReachFactor } from '../bundle/strokeReach.js';
import { elementMatrix } from './cssTransform.js';
import { preloadImages, isSvgHref } from './image.js';
import { handleTextPaintTag, textHasVisibleContent } from './importText.js';
import { handleShapePaintTag } from './importWalkShapes.js';
import { handleImageTag } from './importWalkStructure.js';
import { groupNode } from './hitGroups.js';

const LEAF_PAINT_TAGS = {
  path: 1,
  rect: 1,
  circle: 1,
  ellipse: 1,
  line: 1,
  polygon: 1,
  polyline: 1,
  image: 1,
  text: 1,
  textarea: 1,
};

const COUNTED_SHAPE_TAGS = {
  path: 1,
  rect: 1,
  circle: 1,
  ellipse: 1,
  line: 1,
  polygon: 1,
  polyline: 1,
  image: 1,
  text: 1,
  textarea: 1,
};
/// The shape elements under `node` (itself included), for the report of a dropped display:none subtree.
function countShapeElements(node) {
  let n = COUNTED_SHAPE_TAGS[svgElementName(node)] === 1 ? 1 : 0;
  for (const c of elementChildren(node)) n += countShapeElements(c);
  return n;
}

// Marks a synthesized wrapper whose clip-path ref is already in document space (see placeDefRef).
const CLIP_PLACED_ATTR = 'data-mantle-clip-placed';
// The wrapper <g> the importer itself builds around clip content (a clip-path on a clipPath, an intersection of
// clips) is not authored content; see clipContentAllows.
const CLIP_WRAP_ATTR = 'data-mantle-clip-wrap';
// CSS Masking 1 §6.2: a <clipPath> contains shapes, <text> and <use> elements whose target is a shape or text, and
// nothing else: a <g> or a <use> of one is not part of the clip.
const CLIP_CONTENT_LEAVES = {
  path: 1,
  rect: 1,
  circle: 1,
  ellipse: 1,
  line: 1,
  polygon: 1,
  polyline: 1,
  text: 1,
  textarea: 1,
};
const clipContentAllows = (node, tag) =>
  CLIP_CONTENT_LEAVES[tag] === 1 ||
  tag === 'use' ||
  (tag === 'g' && !!(node.getAttribute && node.getAttribute(CLIP_WRAP_ATTR)));
const isIdentityCtm = (m) =>
  m === IDENT || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

const BLEND_MODES = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  'plus-lighter': 19,
  add: 16,
  'plus-darker': 17,
  subtract: 17,
  invert: 18,
  alpha: 20,
  erase: 21,
};
const G_BLEND_MODES = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  'plus-lighter': 19,
  add: 16,
  'plus-darker': 17,
  subtract: 17,
  invert: 18,
};

/// How deep SVG images may nest inside SVG images (an <image> in the referenced document, and so on).
/// A cycle through svgTextLoader URLs is cut by href before this; the depth bounds a chain of distinct
/// documents, data: URLs included.
const MAX_SVG_IMAGE_DEPTH = 8;
/// importSvg's default `maxUseInstances`: the most `<use>` instances one import expands. See the README.
export const DEFAULT_MAX_USE_INSTANCES = 100000;

/// How many SVG documents one import loads and splices in as <image> content, all levels together. The depth cap bounds the chain, not the
/// fan-out: K images per level at depth 8 is K^8 loads (K = 4: 21,845; K = 10: 10^8). An <image> past the budget renders nothing, as one
/// cut by the depth cap does, and the import warns once. Real art nests a handful of icons; this admits a thousand times that.
const MAX_SVG_IMAGE_DOCS = 4096;

/// The compositing attributes an element applies to its content as ONE GROUP: opacity (clamped to
/// [0, 1]), mix-blend-mode (G_BLEND_MODES: the per-shape map minus the SWF-only alpha/erase extras,
/// which groups don't carry) and isolation.
function groupCompositingOf(node) {
  const rawOpacity = parseAlphaOr(getStyleProp(node, 'opacity', '1'), 1);
  const opacity = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(1, rawOpacity)) : 1;
  const blendStr = (getStyleProp(node, 'mix-blend-mode', 'normal') || 'normal')
    .trim()
    .toLowerCase();
  const isolStr = (getStyleProp(node, 'isolation', 'auto') || 'auto').trim().toLowerCase();
  return {
    opacity,
    blendMode: Object.hasOwn(G_BLEND_MODES, blendStr) ? G_BLEND_MODES[blendStr] : 0,
    isolation: isolStr === 'isolate' ? 1 : 0,
  };
}

/// The value of an element's own mask, through the cascade: `mask`, else `mask-image`; '' when it names none.
const ownMaskOf = (node) =>
  node.getAttribute
    ? getStyleProp(node, 'mask', '') ||
      node.getAttribute('mask') ||
      getStyleProp(node, 'mask-image', '') ||
      ''
    : '';

/// Shared walk context threaded through DOM traversal + text handlers.
/// viewBox → viewport fit (SVG 1.1 §7.8) for <svg>/<symbol> viewports:
/// Translate(x,y) ∘ FitMatrix(preserveAspectRatio) ∘ Translate(−vbX,−vbY).
/// Returns the plain translate when the element has no usable viewBox or
/// the viewport is degenerate.
function viewportFitMatrix(el, sx, sy, sw_, sh_) {
  const vb = (el.getAttribute('viewBox') || '').trim();
  let vbX = 0,
    vbY = 0,
    vbW = 0,
    vbH = 0,
    hasVb = false;
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) {
      vbX = p[0];
      vbY = p[1];
      vbW = p[2];
      vbH = p[3];
      hasVb = true;
    }
  }
  if (!(hasVb && sw_ > 0 && sh_ > 0)) return [1, 0, 0, 1, sx, sy];
  const parA = (el.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
  const parParts = parA.split(/\s+/);
  const align = (parParts[0] || 'xMidYMid').toLowerCase();
  const slice = (parParts[1] || 'meet').toLowerCase() === 'slice';
  let scaleX = sw_ / vbW,
    scaleY = sh_ / vbH;
  if (align !== 'none') {
    const s = slice ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    scaleX = scaleY = s;
  }
  // Alignment offset within the viewport box. Default xMid/yMid.
  const xIdx = align.indexOf('x'),
    yIdx = align.indexOf('y');
  const xPart = xIdx >= 0 && yIdx > xIdx ? align.substring(xIdx + 1, yIdx) : 'mid';
  const yPart = yIdx >= 0 ? align.substring(yIdx + 1) : 'mid';
  const xFactor = xPart === 'min' ? 0 : xPart === 'max' ? 1 : 0.5;
  const yFactor = yPart === 'min' ? 0 : yPart === 'max' ? 1 : 0.5;
  const tx = sx + (align === 'none' ? 0 : (sw_ - vbW * scaleX) * xFactor) - vbX * scaleX;
  const ty = sy + (align === 'none' ? 0 : (sh_ - vbH * scaleY) * yFactor) - vbY * scaleY;
  return [scaleX, 0, 0, scaleY, tx, ty];
}

// The length context a viewport object carries beyond its percentage base: the computed font-size and the root's,
// for em / rem / ex / ch, and the root viewport's size in px, for vw / vh / vmin / vmax. Every parse that takes
// `{ ...walkCtx.viewport, axis }` as its context sees them.
function carryLengthContext(next, prev) {
  if (!next || !prev || (prev.fontSize === undefined && prev.viewportWidth === undefined))
    return next;
  return {
    ...next,
    fontSize: prev.fontSize,
    rootFontSize: prev.rootFontSize,
    viewportWidth: prev.viewportWidth,
    viewportHeight: prev.viewportHeight,
  };
}
/// `vp` with the computed font-size `fontSize` (and `rootFontSize`, for rem) set. A document with no usable root size
/// has no viewport; one that sets a font-size gets a zero-based one, which resolves percentages to 0 as none did.
function withFontSize(vp, fontSize, rootFontSize) {
  return { ...(vp || { parentWidth: 0, parentHeight: 0 }), fontSize, rootFontSize };
}

// Descendant percentages use the viewport's local user coordinates.
function localViewport(el, width, height, prev) {
  const vb = (el.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0)
    return carryLengthContext({ parentWidth: vb[2], parentHeight: vb[3] }, prev);
  return carryLengthContext({ parentWidth: width, parentHeight: height }, prev);
}

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
    // <use> instances expanded so far this import, and the most it may expand (importSvg `maxUseInstances`).
    _useInstances: 0,
    maxUseInstances: DEFAULT_MAX_USE_INSTANCES,
    // >0 while walking the document an SVG <image> references (importWalkStructure.js).
    _imageDocDepth: 0,
    // importSvg's `compat`: 'spec' (the default) or 'chrome' (Chrome's departures from the specs).
    compat: 'spec',
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
  // The second pass of importSvg (importer.js): it walks the shapes the first pass drew nothing for, hidden leaves included.
  walkCtx.hitPass = !!opts._hitPass;
  // importSvg `keepHidden`: content the document marks as not drawn (display:none, visibility:hidden / collapse) is kept as rows that draw
  // nothing until an override reveals them. Not in the hit-only pass (it looks for what the pointer can still target), not in clip,
  // mask or pattern content (those rows are resources, not scene rows).
  walkCtx.keepHidden = keepHiddenOf(opts) && !opts._hitPass;
  // What the import dropped for being explicitly marked as not drawn, by class (bundle.dropped). Counted in the first pass only.
  walkCtx.dropCount = (cls, n = 1) => {
    if (
      opts._hitPass ||
      walkCtx.walkLayerMode ||
      walkCtx.inClipContent > 0 ||
      walkCtx._markerDepth > 0 ||
      !(n > 0)
    )
      return;
    const d = ctx.dropped || (ctx.dropped = {});
    d[cls] = (d[cls] | 0) + n;
  };
  // Bits of how the element being walked is hidden: 1 = in a display:none subtree, 2 = a leaf whose computed visibility is hidden / collapse.
  walkCtx._hiddenBits = 0;

  // Root viewport for percentage-length resolution (SVG 1.1 §7.10):
  // viewBox width/height when present, else the width/height attrs.
  // Without a ctx, parseUnit resolves '%' against 0 and the geometry
  // vanishes (the full-viewport `<rect width="100%">` pattern).
  {
    const vbStr = (root.getAttribute && (root.getAttribute('viewBox') || '').trim()) || '';
    const p = vbStr ? vbStr.split(/[\s,]+/).map(parseFloat) : [];
    let vw = p.length === 4 && Number.isFinite(p[2]) && p[2] > 0 ? p[2] : NaN;
    let vh = p.length === 4 && Number.isFinite(p[3]) && p[3] > 0 ? p[3] : NaN;
    if (!Number.isFinite(vw))
      vw = parseLengthOr(root.getAttribute && root.getAttribute('width'), NaN);
    if (!Number.isFinite(vh))
      vh = parseLengthOr(root.getAttribute && root.getAttribute('height'), NaN);
    walkCtx.viewport =
      Number.isFinite(vw) && vw > 0
        ? { parentWidth: vw, parentHeight: Number.isFinite(vh) && vh > 0 ? vh : vw }
        : null;
    // The root viewport's size in px, which vw / vh / vmin / vmax are percents of: the root's own absolute
    // width / height, else the viewBox's (a missing side follows the viewBox aspect ratio). Unknown sides stay 0.
    if (walkCtx.viewport) {
      const absolute = (name) => {
        const raw = root.getAttribute && (root.getAttribute(name) || '').trim();
        return raw && !raw.endsWith('%') ? parseLengthOr(raw, NaN) : NaN;
      };
      const vbW = p.length === 4 && p[2] > 0 ? p[2] : NaN,
        vbH = p.length === 4 && p[3] > 0 ? p[3] : NaN;
      let rw = absolute('width'),
        rh = absolute('height');
      if (!(rw > 0) && !(rh > 0)) {
        rw = vbW;
        rh = vbH;
      } else if (!(rw > 0)) rw = vbW > 0 && vbH > 0 ? (rh * vbW) / vbH : NaN;
      else if (!(rh > 0)) rh = vbW > 0 && vbH > 0 ? (rw * vbH) / vbW : NaN;
      walkCtx.viewport.viewportWidth = rw > 0 ? rw : 0;
      walkCtx.viewport.viewportHeight = rh > 0 ? rh : 0;
    }
    // for rem: the root element's own computed font-size (the initial 16 px unless it sets one)
    walkCtx.rootFontSize = resolveFontSize(root, INITIAL_FONT_SIZE, INITIAL_FONT_SIZE);
  }
  // The user languages <switch> chooses a systemLanguage child by (null = no information, match
  // anything). Resolved once per import: opts.languages, else the navigator's.
  const switchLanguages = resolveSwitchLanguages(opts.languages);
  walkCtx.switchLanguages = switchLanguages;
  // importSvg's `compat`: 'spec' (the default) draws what the specs say; 'chrome' draws what Chrome does
  // where it departs from them -- an SVG <image>'s placement of its document (importWalkStructure.js
  // svgImagePlacement) and feSpecularLighting with a specularConstant of 0 (filter.js). One switch for every
  // divergence, and named for Chrome because it is Chrome's: at both, Firefox and Safari do not agree with
  // it.
  if (opts.maxUseInstances != null) {
    const m = Number(opts.maxUseInstances);
    if (!(m >= 0))
      throw new RangeError(
        `importSvg: maxUseInstances must be a non-negative number (Infinity disables the budget), got ${String(opts.maxUseInstances)}`,
      );
    walkCtx.maxUseInstances = Math.floor(m);
  }
  const compatOpt = opts.compat == null ? 'spec' : String(opts.compat);
  if (compatOpt !== 'spec' && compatOpt !== 'chrome')
    mantleWarn(`svgImporter: compat "${compatOpt}" is not 'spec' or 'chrome' — using 'spec'`);
  walkCtx.compat = compatOpt === 'chrome' ? 'chrome' : 'spec';
  // The color grammar's mode is one module-wide slot, and imports run concurrently: set it for each synchronous stretch of this import, here
  // and after every await (a stylesheet loader's above, the image preload below).
  setColorCompat(walkCtx.compat);
  // Per-feature switches that `compat` replaces: passing one warns.
  for (const old of ['svgImageFit', 'svgLighting']) {
    if (opts[old] != null)
      mantleWarn(
        `svgImporter: the ${old} option is gone — use compat: 'chrome' for Chrome's behavior`,
      );
  }

  // Sprite-sheet allow-list. When opts.sprites is a non-empty array, only
  // those top-level sprite ids are kept; everything else is discarded at
  // enqueue time (never encoded). null => keep everything (the default).
  const _spriteAllow =
    Array.isArray(opts.sprites) && opts.sprites.length ? new Set(opts.sprites) : null;
  // Parse gradients and set up claim-on-use registry. Hoisted early so
  // claim-on-use code (including vector patterns) can emit meta rows +
  // push curve/band data during the shape walk.
  const gradientsDict = parseGradients(root);
  const gradientIdBySvgId = Object.create(null);
  const claimGradient = (svgId) => {
    if (!gradientsDict[svgId]) return 0;
    // A gradientTransform with no inverse makes the gradient unusable as a paint (browsers paint the url() fallback, else nothing,
    // rather than the gradient untransformed): it is no paint server, and the caller takes the fallback.
    if (isSingularMatrix(gradientsDict[svgId].gradient_transform)) return 0;
    if (!(svgId in gradientIdBySvgId)) {
      ctx.gradientsUsed.push(gradientsDict[svgId]);
      gradientIdBySvgId[svgId] = ctx.gradientsUsed.length; // 1-based
    }
    return gradientIdBySvgId[svgId];
  };

  const markersDict = parseMarkers(root);

  // Pre-decode <image> hrefs. Two paths emerge:
  //   - Raster (PNG/JPEG/etc.): { w, h, rgba } records go into the
  //     image atlas; the renderer samples them in the cover frag.
  //   - SVG content (data:image/svg+xml or *.svg URL): { isSvg, svgText }
  //     records bypass the atlas; the walker recursively imports the
  //     nested SVG and splices its shapes into ctx with a transform
  //     mapping the inner viewBox to the outer <image>'s (x, y, w, h)
  //     rect (honoring preserveAspectRatio).
  //
  // An SVG image's own <image> elements are preloaded too, level by level, so an image inside an
  // image renders (data: URLs, and whatever opts.svgTextLoader resolves). An SVG href already on the
  // chain of documents being loaded is a reference cycle and is cut, and nesting stops at
  // MAX_SVG_IMAGE_DEPTH: an <image> cut either way renders nothing, as a failed load does.
  const imageDataMap = new Map();
  const nestedSvgRoots = new Map();
  const imageLoadOpts = opts.svgTextLoader ? { svgTextLoader: opts.svgTextLoader } : undefined;
  let warnedImageCycle = false,
    warnedImageBudget = false,
    svgImageDocs = 0;
  const decodeCache = new Map(); // href -> decode, shared by every document of this import
  const preloadDocImages = async (docRoot, chain) => {
    const decoded = await preloadImages(
      docRoot,
      imageLoadOpts,
      (el) => {
        // An external <feImage> raster: only the referencing document's filters are parsed.
        if (svgElementName(el) === 'feimage') return chain.length === 0;
        const href = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim();
        if (!isSvgHref(href)) return chain.length < MAX_SVG_IMAGE_DEPTH; // a raster: no document to splice in
        const isData = /^data:/i.test(href);
        if (chain.length < MAX_SVG_IMAGE_DEPTH && (isData || chain.indexOf(href) < 0)) {
          if (svgImageDocs < MAX_SVG_IMAGE_DOCS) {
            svgImageDocs++;
            return true;
          }
          if (!warnedImageBudget) {
            mantleWarn(
              `svgImporter: more than ${MAX_SVG_IMAGE_DOCS} SVG <image> documents in one import (nesting multiplies them) — the rest are not rendered`,
            );
            warnedImageBudget = true;
          }
          return false;
        }
        if (isData) return false; // deeper than the cap: silent as before
        if (!warnedImageCycle) {
          mantleWarn(
            `svgImporter: <image href="${href}"> ${
              chain.indexOf(href) >= 0
                ? 'references a document it is inside'
                : `nests SVG images deeper than ${MAX_SVG_IMAGE_DEPTH}`
            } — not rendered`,
          );
          warnedImageCycle = true;
        }
        return false;
      },
      decodeCache,
    );
    for (const [el, dec] of decoded.entries()) {
      if (!dec.isSvg) {
        imageDataMap.set(el, dec);
        continue;
      }

      let innerRoot = null;
      try {
        const innerDoc = new DOMParser().parseFromString(dec.svgText, 'image/svg+xml');
        innerRoot = innerDoc.documentElement;
        if (!innerRoot || innerRoot.tagName.toLowerCase() === 'parsererror') innerRoot = null;
        else if (elementDepthExceeds(innerRoot)) {
          mantleWarn(
            `svgImporter: nested SVG in <image> is nested deeper than ${MAX_ELEMENT_DEPTH} levels — skipped`,
          );
          innerRoot = null;
        }
      } catch (e) {
        mantleWarn(
          `svgImporter: nested SVG in <image> failed to parse (${e?.message || e}) — skipped`,
        );
      }
      if (!innerRoot) continue;
      imageDataMap.set(el, dec);
      nestedSvgRoots.set(el, innerRoot);
      // Register the nested SVG's own stylesheet (keyed by innerDoc), so
      // its <style> class fills resolve against itself — not the parent's
      // sheet. Keyed per-document, so no clobber with the parent.
      setActiveStylesheet(innerRoot, buildStylesheet(innerRoot));
      const href = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim();
      await preloadDocImages(innerRoot, chain.concat(/^data:/i.test(href) ? '' : href));
    }
  };
  await preloadDocImages(root, []);
  setColorCompat(walkCtx.compat);
  const imageIdByEl = new Map();
  const imageIdByDec = new Map();
  const claimImage = (el) => {
    if (!el || !imageDataMap.has(el)) return 0;
    const dec = imageDataMap.get(el);
    // SVG-content records don't go to the raster atlas — caller
    // dispatches via the isSvg branch below.
    if (dec.isSvg) return 0;
    if (!imageIdByEl.has(el)) {
      // Elements that share a decoded record (preloadImages decodes one href once) share one atlas region.
      if (!imageIdByDec.has(dec)) {
        ctx.imagesUsed.push(dec);
        imageIdByDec.set(dec, ctx.imagesUsed.length);
      }
      imageIdByEl.set(el, imageIdByDec.get(dec));
    }
    return imageIdByEl.get(el);
  };

  // Vector pattern registry. Each entry stores the SHAPE-index range
  // captured into `ctx.shapesData` when claimVectorPattern
  // ran (with walkCtx.walkLayerMode=true). The post-walk meta-emit translates
  // (firstShapeIdx..lastShapeIdx) → (firstMetaRow1..lastMetaRow1) via
  // the shapeToFirstMeta/shapeToLastMeta arrays and stamps the visible
  // shape's atlasSlot accordingly. Pattern children flow through the
  // same main walker — every supported feature (transforms, gradients,
  // images, dashes, clips, masks, filters, blends, <use>, paint-order)
  // applies in pattern children with zero duplication.
  const vecPatternIdBySvgId = Object.create(null);
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
  // The same stack as hit-group nodes (hitGroups.js): the innermost element with an id at or above each level, or null. A record
  // is stamped with its PARENT'S node (`_grp`): the element's own id addresses the row, an ancestor's id addresses the group.
  const groupStack = [];
  // The sprite id of the top-level element being walked: its own id the FIRST time that id is seen among the root's children,
  // '' for a later element that reuses it (that one is not an addressable sprite; the first keeps the id, as the override
  // table's first-id-wins does). Without this a repeated id folded every shape between the two into one [first, last] range.
  let _spriteTop = '';
  const _spriteIdsSeen = new Set(),
    _spriteDupWarned = new Set();
  const currentId = () => (idStack.length > 0 ? idStack[idStack.length - 1] : '');

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
  // `filter` is NOT an inherited property per spec — on a <g> it
  // applies to the group as a single rendered unit. Mirroring the
  // mask + clip-path stacks so `<g filter="url(#fN)"><path .../></g>`
  // applies the filter to each descendant shape is a deliberate
  // per-shape approximation of that group-level filter.
  const filterStack = [];
  const currentMaskRef = () => (maskStack.length > 0 ? maskStack[maskStack.length - 1] : '');
  const currentClipRef = () => (clipStack.length > 0 ? clipStack[clipStack.length - 1] : '');
  // Per-REFERENCING-ELEMENT instance ids: an objectBoundingBox clip/mask
  // binds to the bbox of the element that carries the attribute (SVG 1.1
  // §14.3.5) — for a <g>, that's the union of its shapes, not each
  // leaf's own box. A fresh id is minted where the attribute appears;
  // descendants inherit it, and finalize unions the bboxes of all
  // claims sharing an instance.
  const nextInstance = (kind) => {
    const key = '_next' + kind + 'Instance';
    const n = ctx[key] || 1;
    ctx[key] = n + 1;
    return n;
  };
  const clipInstStack = [],
    maskInstStack = [];
  // Filter instances work the same way, for the same reason: a filter on a <g> applies to the group as one
  // rendered unit, so its region belongs to the group's box, not to each leaf's. The stack marks which group
  // instance a descendant's claim belongs to; filterOwnStack says whether this element is the one carrying the
  // attribute, so _walkInner can record the group's CTM for a userSpaceOnUse region.
  const filterInstStack = [],
    filterOwnStack = [];
  const _filterInstCtm = new Map(),
    _filterInstPaints = new Map();
  const ownerPaint = (node, property, fallback) => {
    let value = (getInheritedStyleProp(node, property, fallback) || fallback).trim();
    if (/^url\(/i.test(value)) return { kind: 'server', reference: value };
    value = withCurrentColor(node, value);
    return parseColor(value).slice();
  };
  // ...and the same record for clip and mask instances, which an objectBoundingBox reference needs to place its
  // supplemental matrix inside the carrier's CTM (see _walkInner, and _obbCtm in bundleFinalize.js). Local to
  // this walk, not on ctx: the instance counters restart per importSvg call, so a ctx shared across calls
  // (textRun's SVG-in-OT fan-out) would have two carriers under one id.
  const _clipInstCtm = new Map(),
    _maskInstCtm = new Map();
  // Basic-shape clip-path carriers (normClip): the shapes walked under each, by clip instance, because a basic shape resolves
  // against its CARRIER's box and a claim only exists for a leaf that references the def itself. A stack of the carrier
  // instances in force; enqueueShape adds every shape it emits to each.
  const _clipInstMembers = new Map(),
    basicInstStack = [];
  const currentClipInstance = () =>
    clipInstStack.length > 0 ? clipInstStack[clipInstStack.length - 1] : 0;
  const currentMaskInstance = () =>
    maskInstStack.length > 0 ? maskInstStack[maskInstStack.length - 1] : 0;
  const currentFilterInstance = () =>
    filterInstStack.length > 0 ? filterInstStack[filterInstStack.length - 1] : 0;
  const currentFilterRef = () =>
    filterStack.length > 0 ? filterStack[filterStack.length - 1] : '';
  // THE PATTERN COORDINATE SYSTEM (SVG 2 §14.3). x/y/width/height are fractions of the referencing element's bounding
  // box under patternUnits="objectBoundingBox" -- the DEFAULT -- and user units under "userSpaceOnUse". The contents
  // have their origin at the tile's corner (which is where the shader samples a child), scaled by the viewBox fit when
  // there is one, else by the bounding box under patternContentUnits="objectBoundingBox". href supplies what the
  // pattern does not set. Reading width/height as user units in every mode, with the tile origin at the filled shape's
  // corner and x, y, viewBox, the content units and href ignored, would make both unit systems produce byte-identical meta.
  //
  // `bboxUser` is the referencing shape's bounding box in ITS own user space (before its transform). Returns null for
  // a pattern that paints nothing, else { id, tile: [x, y, w, h] in pattern space, patM: patternTransform }; the
  // caller composes patM with the shape's transform. The claimed children depend only on the content transform, so a
  // claim is shared by every shape whose content comes out the same.
  /// Whether a pattern's viewBox, through its href chain, disables its rendering.
  walkCtx.patternViewBoxEmpty = (svgId) => {
    const el = _patternElById[svgId];
    if (!el) return false;
    const vb = (resolvePatternDef(el, _patternElById).attrs.viewBox || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return (
      vb.length === 4 &&
      vb.every(Number.isFinite) &&
      vb[2] >= 0 &&
      vb[3] >= 0 &&
      (vb[2] === 0 || vb[3] === 0)
    );
  };
  const claimVectorPattern = (svgId, patternEl, bboxUser) => {
    if (!patternEl) return null;
    const def = resolvePatternDef(patternEl, _patternElById);
    const A = def.attrs;
    const bb = bboxUser || [0, 0, 0, 0];
    const bw = bb[2] - bb[0],
      bh = bb[3] - bb[1];
    const obb = (A.patternUnits || 'objectBoundingBox').trim() !== 'userSpaceOnUse';
    // em is of the font-size of the pattern that states the attribute (CSS Values 4), never of the referencing shape.
    const len = (name, axis) => {
      const owner = def.owners[name],
        fi = owner ? domFontSize(owner) : null;
      const font = fi ? { fontSize: fi.fontSize, rootFontSize: fi.rootFontSize } : {};
      return parseLengthOr(
        A[name] || '0',
        0,
        obb
          ? { parentWidth: 1, parentHeight: 1, axis, ...font }
          : walkCtx.viewport
            ? { ...walkCtx.viewport, axis, ...font }
            : fi
              ? { axis, ...font }
              : undefined,
      );
    };
    let tx = len('x', 'x'),
      ty = len('y', 'y'),
      tw = len('width', 'x'),
      th = len('height', 'y');
    if (obb) {
      tx = bb[0] + tx * bw;
      ty = bb[1] + ty * bh;
      tw *= bw;
      th *= bh;
    }
    if (!(tw > 0) || !(th > 0)) return null;
    let contentM = IDENT,
      contentKey = '';
    // SHARED CONTENT. A content point c sits in the tile at (sx * c', sy * c') + (ax/2 * (tw - sx * vbW), ay/2 * (th - sy * vbH)),
    // c' = c moved by `canon` (the viewBox corner to the origin). The children are walked once at c' + (mx, my), and each referencing
    // shape draws them through a CARRIER that is an ordinary pattern: its pattern space is the canonical one (the box's scale (sx, sy)
    // folded into the pattern inverse, the tile origin and the tile size, bundleFinalize.js vectorPatternMaterial), and the alignment
    // share (dx, dy) = ax/2 * (T - vbW) - (mx, my) in canonical units moves the tile's window. (mx, my) is the share rounded down to a
    // class (0, vb/32, vb/16 ... 4 vb): the content keeps about the margin the per-box walk gave it, so a fragment is not near the
    // window's edge for a child that is not near the tile's; a pattern costs one content copy per class, never one per box.
    // That moves the window, not the content inside it, so it is exact when every child lies inside the viewBox on an axis that has
    // a share (checked below, against the children's box) and the share is not negative (a `slice` crops, so its window differs).
    // No shader or wire change.
    let share = null;
    const vb = (A.viewBox || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      vb.length === 4 &&
      vb.every(Number.isFinite) &&
      vb[2] >= 0 &&
      vb[3] >= 0 &&
      (vb[2] === 0 || vb[3] === 0)
    )
      return null; // a zero viewBox paints nothing
    if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
      contentM = viewBoxFit(
        vb[0],
        vb[1],
        vb[2],
        vb[3],
        A.preserveAspectRatio || 'xMidYMid meet',
        0,
        0,
        tw,
        th,
      );
      contentKey = contentM.join(',');
      const asp = parseAspect(A.preserveAspectRatio || 'xMidYMid meet');
      const ax = asp.none ? 0 : asp.alignX,
        ay = asp.none ? 0 : asp.alignY;
      const sx = contentM[0],
        sy = contentM[3];
      const ex = contentM[0] * -vb[0] + ax * 0.5 * (tw - sx * vb[2]),
        ey = contentM[3] * -vb[1] + ay * 0.5 * (th - sy * vb[3]);
      const tol = 1e-9 * (Math.abs(contentM[4]) + Math.abs(contentM[5]) + tw + th);
      // Only a tile that scales with the box moves the content per shape; a user-space tile gives every shape the same matrix,
      // which the memo below already shares.
      if (obb && Math.abs(ex - contentM[4]) <= tol && Math.abs(ey - contentM[5]) <= tol) {
        const slackX = tw / sx - vb[2],
          slackY = th / sy - vb[3];
        const tx0 = 1e-9 * (tw / sx),
          ty0 = 1e-9 * (th / sy);
        const dx = Math.abs(slackX) <= tx0 ? 0 : ax * 0.5 * slackX,
          dy = Math.abs(slackY) <= ty0 ? 0 : ay * 0.5 * slackY;
        // a share of the tile needs a non-negative slack (meet): a cropped window moves per box
        if (dx >= 0 && dy >= 0) {
          const mx = marginClass(dx, vb[2]),
            my = marginClass(dy, vb[3]);
          share = {
            canon: [1, 0, 0, 1, -vb[0] + mx, -vb[1] + my],
            key: mx + ',' + my,
            sx,
            sy,
            dx: dx - mx,
            dy: dy - my,
            hasShare: dx > 0 || dy > 0,
            lo: [mx, my],
            hi: [mx + vb[2], my + vb[3]],
            vbW: vb[2],
            vbH: vb[3],
          };
        }
      }
    } else if ((A.patternContentUnits || '').trim() === 'objectBoundingBox') {
      if (!(bw > 0) || !(bh > 0)) return null;
      contentM = [bw, 0, 0, bh, 0, 0];
      contentKey = contentM.join(',');
      share = {
        canon: IDENT,
        key: '',
        sx: bw,
        sy: bh,
        dx: 0,
        dy: 0,
        hasShare: false,
        lo: [0, 0],
        hi: [0, 0],
        vbW: 0,
        vbH: 0,
      };
    }
    const tile = [tx, ty, tw, th];
    const patM = parseTransform(A.patternTransform || '');
    // SHARED CONTENT. The children are walked ONCE in the pattern's canonical space; each referencing shape carries its own
    // scale and alignment (its carrier row: tile, pattern inverse, atlasSlot.z) and the shader maps the tile position into the
    // canonical space. Only a top-level, flat pattern shares: children inside another pattern, clip or mask are read by paths that
    // know no content map, and so are children that clip, mask, filter, blend, group, nest another pattern or scale their
    // stroke by the screen. A pattern with a stroke shares only among uniform scales (a non-uniform one turns the pen elliptical,
    // which the baked rows carry in their stroke frames). Everything else walks per scale, as it always did.
    if (
      share &&
      !walkCtx.walkLayerMode &&
      !(walkCtx.inClipContent > 0) &&
      !patternNoShare.has(svgId) &&
      Number.isFinite(share.sx) &&
      Number.isFinite(share.sy) &&
      share.sx > 0 &&
      share.sy > 0
    ) {
      const ckey = svgId + '|C' + share.key;
      const r = claimPatternWalk(
        ckey,
        share.canon,
        def,
        tile,
        patM,
        (first, last, nestedBefore) => {
          if (ctx.vecPatternsUsed.length > nestedBefore) return false;
          let hasStroke = false;
          const box = [Infinity, Infinity, -Infinity, -Infinity];
          for (let i = first; i <= last; i++) {
            const sd = ctx.shapesData[i];
            if (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') return false;
            if (
              sd.clipId | 0 ||
              sd.maskId | 0 ||
              sd.filterId | 0 ||
              sd.blendMode | 0 ||
              sd.isolation | 0 ||
              sd.vecPatternId | 0 ||
              sd.strokeImageId | 0
            )
              return false;
            if (
              (sd.flagsShape | 0) &
              (1 | (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13) | (1 << 14))
            )
              return false;
            const stroked = sd.sw > 0 && (sd.strokeRgba?.[3] > 0 || sd.strokeGradId > 0);
            if (stroked) hasStroke = true;
            // The children's box in canonical units, with each stroke's reach (an image or an empty path has no box to bound: unbounded).
            if (sd.imageId > 0 || !sd.segs || !sd.segs.length) {
              box[0] = box[1] = -Infinity;
              box[2] = box[3] = Infinity;
              continue;
            }
            const bb = pathBbox(sd.segs);
            const pad = stroked
              ? sd.sw *
                0.5 *
                strokeReachFactor(
                  sd.joinStyle,
                  sd.miterLimit,
                  sd.capStyle,
                  sd.endCapStyle ?? sd.capStyle,
                )
              : 0;
            box[0] = Math.min(box[0], bb[0] - pad);
            box[1] = Math.min(box[1], bb[1] - pad);
            box[2] = Math.max(box[2], bb[2] + pad);
            box[3] = Math.max(box[3], bb[3] + pad);
          }
          patternShareStroke.set(ckey, hasStroke);
          patternShareBox.set(ckey, box);
          return true;
        },
      );
      if (r === PATTERN_REJECT) patternNoShare.add(svgId);
      else if (!r) return null;
      else if (
        Math.abs(share.sx - share.sy) <= 1e-9 * Math.max(share.sx, share.sy) ||
        !patternShareStroke.get(ckey)
      ) {
        // The alignment share moves the tile's window, so every child must lie inside the viewBox on an axis that has one.
        const box = patternShareBox.get(ckey),
          eps = 1e-9 * Math.max(share.vbW, share.vbH);
        const inX = box[0] >= share.lo[0] - eps && box[2] <= share.hi[0] + eps,
          inY = box[1] >= share.lo[1] - eps && box[3] <= share.hi[1] + eps;
        if (!share.hasShare || (inX && inY))
          return {
            id: r,
            tile,
            patM,
            content: { sx: share.sx, sy: share.sy, dx: share.dx, dy: share.dy },
          };
      }
    }
    const id = claimPatternWalk(
      contentKey ? svgId + '|' + contentKey : svgId,
      contentM,
      def,
      tile,
      patM,
      null,
    );
    return id > 0 ? { id, tile, patM } : null;
  };
  // The share of the tile (canonical units, `vb` the viewBox extent on that axis) rounded down to 0, vb/32, vb/16 ... vb, 2 vb or 4 vb (each class twice the last: the margin kept is more than half).
  const marginClass = (d, vb) => {
    let m = 0;
    for (let k = 1 / 32; k <= 4 && k * vb <= d; k *= 2) m = k * vb;
    return m;
  };
  const patternNoShare = new Set();
  const patternShareStroke = new Map();
  const patternShareBox = new Map();
  const PATTERN_REJECT = -1;

  // Walk the <pattern> content under `walkM` (once per memo `key`), claim it, and return its id; null for a pattern that paints
  // nothing or is mid-walk (the cycle guard); PATTERN_REJECT when `accept(first, last, nestedBefore)` refuses what the walk made
  // (its rows stay, unreferenced, like those of a pattern that paints nothing). `tile` and `patM` are the first referencing
  // shape's, for readers that predate per-shape tiles.
  const claimPatternWalk = (key, walkM, def, tile, patM, accept) => {
    if (key in vecPatternIdBySvgId) {
      const known = vecPatternIdBySvgId[key];
      // Nested carriers need a unique parent context for their screen-space bakes.
      // Keep the zero entry as the cycle guard; flat pattern content can share rows.
      if (!known || !ctx.vecPatternsUsed[known - 1].nested) return known || null;
    }
    // Cycle guard: stamp the memo with 0 BEFORE walking the
    // subtree. If a pattern child references this same pattern
    // (mutually or self-recursive), the lookup above returns 0, the
    // child silently drops the pattern fill, and recursion
    // terminates. The real id is patched in below.
    vecPatternIdBySvgId[key] = 0;
    // Re-enter the main walk() on the pattern subtree with
    // walkCtx.walkLayerMode=true. Pattern children flow through the same
    // feature-complete walker as visible shapes — transforms,
    // gradients, images, clips, masks, dashes, blend modes, <use>,
    // paint-order, etc. all "just work" inside patterns with zero
    // duplication. They are walked in tile-local content space: the
    // content transform above, with the tile corner as the origin.
    const firstShapeIdx = ctx.shapesData.length;
    const nestedPatternsBefore = ctx.vecPatternsUsed.length;
    const savedLayer = walkCtx.walkLayerMode,
      savedClip = walkCtx.inClipContent | 0,
      savedGroups = walkCtx.retainLayerGroups;
    walkCtx.retainLayerGroups = true;
    walkCtx.walkLayerMode = true;
    walkCtx.inClipContent = 0; // a pattern PAINTS, even one claimed from inside a clipPath
    try {
      // Pattern content's inheritance parents are the pattern element and ITS ancestors, never the shape
      // that references it.
      walkDefContent(def.contentEl, elementChildren(def.contentEl), walkM);
    } finally {
      walkCtx.walkLayerMode = savedLayer;
      walkCtx.inClipContent = savedClip;
      walkCtx.retainLayerGroups = savedGroups;
    }
    const lastShapeIdx = ctx.shapesData.length - 1;
    if (lastShapeIdx < firstShapeIdx) return null;
    const paints = ctx.shapesData
      .slice(firstShapeIdx, lastShapeIdx + 1)
      .some(
        (sd) =>
          (!sd.fillNone && sd.fillRgba?.[3] > 0) ||
          (sd.sw > 0 && sd.strokeRgba?.[3] > 0) ||
          sd.imageId > 0 ||
          sd.filterId > 0,
      );
    if (!paints) return null;
    if (accept && !accept(firstShapeIdx, lastShapeIdx, nestedPatternsBefore)) {
      delete vecPatternIdBySvgId[key];
      return PATTERN_REJECT;
    }
    ctx.vecPatternsUsed.push({
      firstShapeIdx,
      lastShapeIdx,
      nested: ctx.vecPatternsUsed.length > nestedPatternsBefore,
      // The first referencing shape's tile and transform, for readers that predate per-shape tiles. Each shape
      // carries its own (patternTile / patternMatrix), which is what bundleFinalize uses.
      tileEmW: tile[2],
      tileEmH: tile[3],
      patM,
    });
    const id = ctx.vecPatternsUsed.length;
    vecPatternIdBySvgId[key] = id;
    // The pattern whose space each child is stored in (the innermost: a nested pattern's claim finished first and
    // tagged its own). bundleFinalize carries a child's area into document units through it.
    for (let s = firstShapeIdx; s <= lastShapeIdx; s++)
      if (!ctx.shapesData[s]._patternOwner) ctx.shapesData[s]._patternOwner = id;
    return id;
  };

  // Find the pattern's <pattern> element (already collected at visit time).
  const _patternElById = Object.create(null);
  // True when a pattern's patternTransform (its own, else the first on its href chain) has no inverse: the pattern is no paint server.
  const patternTransformSingular = (svgId) => {
    const el = _patternElById[svgId];
    if (!el) return false;
    const t = resolvePatternDef(el, _patternElById).attrs.patternTransform;
    return t != null && t.trim() !== '' && isSingularMatrix(parseTransform(t));
  };
  // <textPath href="#id"> reference target. Any id'd element with a
  // usable shape definition (path/rect/circle/etc.) qualifies.
  const _shapeElById = Object.create(null);
  // Parse <filter> defs. The supported subset (color-matrix-only chains)
  // bakes into a per-shape 4×5 matrix that the cover/AA fragment shaders
  // apply to the final color. Unsupported primitives leave the shape
  // unfiltered and emit a one-time console warning. imageResolver gives
  // the parser a callback for <feImage xlink:href="#imgId"> → atlas slot.
  const imageElById = Object.create(null);
  // id → element registry for <use> resolution. Indexed across the whole
  // tree so ids inside <defs> resolve even though those subtrees don't
  // directly emit shapes.
  const idMap = Object.create(null);
  // Single setup traversal building all three maps (pattern/shape
  // index, image index, id index) in one pass — same maps, one walk,
  // one getAttribute('id') per element.
  {
    // Hoisted out of the per-node loop so it is built once rather than
    // rebuilt for every visited element.
    const SHAPE_REF_TAGS = {
      path: 1,
      rect: 1,
      circle: 1,
      ellipse: 1,
      line: 1,
      polyline: 1,
      polygon: 1,
    };
    const visit = (el) => {
      if (el.getAttribute) {
        const id = el.getAttribute('id');
        // A duplicate id resolves to the FIRST element (document order), as getElementById does; a later element
        // of another kind with the same id is not a pattern, shape or image reference target either.
        if (id && !(id in idMap)) {
          const tag = svgElementName(el);
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
  // document order. This is the exact space the native fallback's positional
  // DOM walk addresses (nativeSvgFallback shapeElByIndex: tag in its
  // RECOLOR_TAGS set, not inside a non-rendered container) — keep the two
  // filters in lockstep. Counted INDEPENDENTLY of what the walk emits
  // (visibility:hidden / paint-less leaves still occupy a DOM slot), so the
  // exported per-meta-row map (bundle.shapeDomIndex) stays aligned with the
  // live markup even when a shape emits 0 or 2 meta rows.
  const sourcePaths = opts.retainSource ? new WeakMap() : null;
  if (sourcePaths) {
    const record = (element, path) => {
      sourcePaths.set(element, path);
      const children = elementChildren(element);
      for (let i = 0; i < children.length; i++) record(children[i], path.concat(i));
    };
    record(root, []);
  }
  // Reuse the existing source traversal; authored IDs can repeat and are not ownership keys.
  const hitOwnerNodes = opts._hitOwnerSession ? new WeakMap() : null;
  let hitNodeIndex = 0;
  const leafOrdinalByEl = new Map();
  {
    const ORDINAL_TAGS = {
      path: 1,
      rect: 1,
      circle: 1,
      ellipse: 1,
      polygon: 1,
      polyline: 1,
      line: 1,
      text: 1,
      textarea: 1,
    };
    const NON_RENDER = { defs: 1, mask: 1, clippath: 1, symbol: 1, pattern: 1, marker: 1 };
    let _ord = 0;
    const countLeaves = (el, excluded) => {
      if (hitOwnerNodes) hitOwnerNodes.set(el, hitNodeIndex++);
      const tag = svgElementName(el);
      const ex = excluded || NON_RENDER[tag] === 1;
      if (!ex && el !== root && ORDINAL_TAGS[tag] === 1) leafOrdinalByEl.set(el, _ord++);
      const ks = elementChildren(el);
      for (let i = 0; i < ks.length; i++) countLeaves(ks[i], ex);
    };
    countLeaves(root, false);
  }

  const _warnedFeImageEl = new Set();
  const imageResolver = (href, feEl) => {
    if (!href) return null;
    if (!href.startsWith('#')) {
      // An EXTERNAL raster, preloaded against the <feImage> element itself.
      const dec = feEl && imageDataMap.get(feEl);
      if (!dec || dec.isSvg) return null;
      const imageId = claimImage(feEl);
      return imageId ? { imageId, w: dec.w, h: dec.h, external: true } : null;
    }
    const id = href.slice(1);
    const el = imageElById[id];
    if (!el && idMap[id]) {
      // Filter Effects 1 (feImage): an element reference is rendered "according to the behavior of the use element" in the referencing
      // element's user space. Only a referenced <image> is placed so far (it is a raster the atlas holds); a shape or group has no
      // raster to sample, and the primitive draws transparent black.
      if (!_warnedFeImageEl.has(id)) {
        _warnedFeImageEl.add(id);
        mantleWarn(
          'bundle exporter: feImage href="#' +
            id +
            '" names an element other than <image>; only <image> references are rendered, and this primitive draws nothing.',
        );
      }
    }
    if (!el || !imageDataMap.has(el)) return null;
    const dec = imageDataMap.get(el);
    const imageId = claimImage(el);
    if (!imageId) return null;
    // A referenced <image> with a stated box draws like <use> would: at its own x, y, width, height in the
    // user space of the element that references the filter, fitted by ITS preserveAspectRatio. The
    // consumer places it as an external image whose subregion is that box. One without a stated size keeps
    // the older placement, the image fitted to the filter region.
    const num = (a) => {
      const v = el.getAttribute(a);
      return v == null || !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?(px)?\s*$/i.test(v)
        ? NaN
        : parseFloat(v);
    };
    const bw = num('width'),
      bh = num('height');
    if (bw > 0 && bh > 0) {
      const bx = num('x'),
        by = num('y');
      return {
        imageId,
        w: dec.w,
        h: dec.h,
        external: true,
        box: [Number.isFinite(bx) ? bx : 0, Number.isFinite(by) ? by : 0, bw, bh],
        par: el.getAttribute('preserveAspectRatio'),
      };
    }
    return { imageId, w: dec.w, h: dec.h };
  };
  const filtersDict = parseFilters(root, imageResolver, { compat: walkCtx.compat });
  const filterIdBySvgId = Object.create(null);
  // CSS FILTER VALUES (Filter Effects 1 §5): `filter: blur(3px)`, `drop-shadow(...)`, `grayscale(.5) url(#f)`, lists of several. Read
  // through the same stylesheet / style attribute / presentation attribute chain as `url(#id)`. A value that does not parse is
  // dropped where declarations are read (cssDecl.js), so by here an invalid one is only a presentation attribute handed straight
  // to a leaf.
  //
  // A plain `url(#id)` is exactly what it was. Anything else is normalized (lengths in px, colors resolved against the element
  // that wrote it, `currentColor` and `em` included, so a list inherited by a group means the same thing in every child), then
  // compiled ONCE into a graph record interned under that normalized text in filtersDict: claimFilter and everything after it
  // see an ordinary filter. An asset that writes none of these never reaches this code.
  const warnedFilterValues = new Set();
  const warnFilterValue = (msg) => {
    if (warnedFilterValues.has(msg)) return;
    warnedFilterValues.add(msg);
    mantleWarn('bundle exporter: ' + msg);
  };
  const normFilter = (raw, node) => {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s || /^none$/i.test(s) || s[0] === '#' || isPlainUrlRef(s)) return s;
    const items = scanFilterList(s);
    if (!items) return ''; // not a filter list: ignored, as an invalid declaration is
    if (!items.length) return 'none';
    const fc = {
      ...(node
        ? domFontSize(node)
        : { fontSize: INITIAL_FONT_SIZE, rootFontSize: INITIAL_FONT_SIZE }),
      // for vw / vh / vmin / vmax
      viewportWidth: walkCtx.viewport?.viewportWidth,
      viewportHeight: walkCtx.viewport?.viewportHeight,
    };
    const colorOf = (tok) => {
      const rgba = parseColor(node ? withCurrentColor(node, tok) : tok);
      return rgba;
    };
    const canon = canonicalFilter(items, {
      len: (tok) => parseLengthOr(tok, NaN, fc),
      colorStr: (tok) => {
        const c = colorOf(tok);
        return (
          'rgba(' +
          [c[0] * 255, c[1] * 255, c[2] * 255].map((v) => +v.toPrecision(10)).join(',') +
          ',' +
          +c[3].toPrecision(10) +
          ')'
        );
      },
    });
    if (canon === null) {
      warnFilterValue(
        `filter value "${s.slice(0, 80)}" uses something this importer cannot evaluate (an external url(), a math function or a viewport unit); the element is drawn unfiltered.`,
      );
      return '';
    }
    return canon;
  };
  /// The filtersDict key a filter VALUE resolves to: the id of a plain url(#id), the interned compiled list for a function / list
  /// value, null for `none`, an invalid value, or a list that does nothing.
  const resolveFilterRef = (raw, node) => {
    const s = normFilter(raw, node);
    if (!s || /^none$/i.test(s)) return null;
    if (s[0] === '#' || isPlainUrlRef(s)) return resolveIdRef(s);
    if (Object.prototype.hasOwnProperty.call(filtersDict, s)) return s;
    const items = scanFilterList(s);
    const { graph, urlIds } = filterListGraph(items, {
      color: (tok) => parseColor(tok).slice(),
      // Filter Effects 1 §5: a url() that names no <filter> makes "the whole filter chain ... ignored. No filter is applied to the
      // object." Chrome skips only that stage and applies the others: compat 'chrome'.
      urlMissing: walkCtx.compat === 'chrome' ? null : (id) => !filtersDict[id],
      // The region of a url() stage as a primitive subregion: fractions of the element's box for objectBoundingBox filterUnits (the
      // unstated default is -10% / -10% / 120% / 120%), user units otherwise; a region with no area empties the stage.
      urlSub: (id) => {
        const rg = filtersDict[id] && filtersDict[id].region;
        if (!rg || rg.unbounded) return null;
        if (rg.empty) return { v: [0, 0, 0, 0], u: 0 };
        if (rg.oBB)
          return rg.stated
            ? rg.w > 0 && rg.h > 0
              ? { v: [rg.x, rg.y, rg.w, rg.h], u: 1 }
              : null
            : { v: [-0.1, -0.1, 1.2, 1.2], u: 1 };
        return rg.w > 0 && rg.h > 0 ? { v: [rg.x, rg.y, rg.w, rg.h], u: 0 } : null;
      },
      urlGraph: (id) => {
        const r = filtersDict[id];
        if (!r) {
          warnFilterValue(
            walkCtx.compat === 'chrome'
              ? `filter list names #${id}, which is not a <filter>; that stage is skipped.`
              : `filter list names #${id}, which is not a <filter>; the whole list is ignored.`,
          );
          return null;
        }
        const g = r._makeGroupGraph ? r._makeGroupGraph() : null;
        if (!g)
          warnFilterValue(
            `filter list names #${id}, whose primitives are not supported; that stage is skipped.`,
          );
        return g;
      },
    });
    if (!graph) return null;
    // Each url() stage keeps the filter region of its <filter>; only the LAST stage's region clips the list's result, and the
    // earlier stages' regions do not clip their own stage (said once).
    // (Filter Effects 1 §5: each url() stage is a filter of its own.) Each stage that is not the last item of the list clipped itself to
    // its region inside the graph (filterListGraph, env.urlSub); the last item's region is the list's. A list that ends in a function
    // has none: a CSS function is not bounded by an earlier stage's region.
    const endsInUrl = items.length > 0 && items[items.length - 1].url != null;
    const lastRegion =
      endsInUrl && urlIds.length ? filtersDict[urlIds[urlIds.length - 1]].region : null;
    if (
      graph.nodes.some(
        (n) => n.params && (n.params.obb || (n.params.subUnits === 1 && n.type !== 'feImage')),
      )
    )
      graph.obb = true;
    const rec = { region: lastRegion || { unbounded: true }, kind: 'graph', graph };
    Object.defineProperty(rec, '_makeGroupGraph', {
      value: () => ({
        ...graph,
        nodes: graph.nodes.map((n) => ({
          ...n,
          inputs: n.inputs.slice(),
          params: n.params ? { ...n.params } : n.params,
        })),
      }),
    });
    filtersDict[s] = rec;
    return s;
  };
  // Warn once per import, not once per referencing element. Held as a plain
  // binding rather than a property on claimFilter itself: state hidden on a
  // function object is state nobody finds.
  let warnedUnsupportedFilter = false,
    warnedBoxFilter = false;
  /// The region one use of a filter clips to, as [x, y, w, h, space] -- space 0: fractions of the referencing shape's
  /// object bounding box; space 1: a rect in root user space -- or null for no clip. Filter Effects 1 §7.1: x/y/width/
  /// height are in filterUnits, objectBoundingBox (the default, fractions) or userSpaceOnUse (lengths in the user space
  /// of the element that references the filter, so its CTM applies), and an unstated region is -10%/-10%/120%/120%.
  ///
  /// A shape that references the filter ITSELF gets all of that. An inherited reference (the filter is on an ancestor
  /// group) keeps the older rule, a stated objectBoundingBox region only: the region belongs to the group, and neither
  /// the group's bounding box nor its CTM reaches this per-shape claim, so clipping each child would cut more than a
  /// browser does. A rotated or skewed userSpaceOnUse region clips to its axis-aligned bound.
  /// A region under a turn or a skew is not the box its AABB says: the four corners ride along for the composite (renderer/filterDraw.js _filterRegionRectPx).
  const regionWithQuad = (box, ctm, x, y, w, h) => {
    if (ctm[1] !== 0 || ctm[2] !== 0)
      box.quad = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ].flatMap(([px, py]) => matApply(ctm, px, py));
    return box;
  };
  const resolveFilterRegion = (rg, use) => {
    if (!rg) return null;
    if (rg.unbounded) return null; // data-mantle-filter-region="none" (see svg/filter.js)
    // A region with no area (width or height 0 or negative) disables the effect: nothing is painted (Filter Effects 1
    // §7.1). Space 0 with zero extent is the renderer's EMPTY_REGION whatever the element's box.
    if (rg.empty) return [0, 0, 0, 0, 0];
    if (rg.oBB) {
      if (rg.stated) return rg.w > 0 && rg.h > 0 ? [rg.x, rg.y, rg.w, rg.h, 0] : null;
      return use.own ? [-0.1, -0.1, 1.2, 1.2, 0] : null;
    }
    if (!use.own || !use.ctm || !(rg.w > 0 && rg.h > 0)) return null;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [px, py] of [
      [rg.x, rg.y],
      [rg.x + rg.w, rg.y],
      [rg.x, rg.y + rg.h],
      [rg.x + rg.w, rg.y + rg.h],
    ]) {
      const [qx, qy] = matApply(use.ctm, px, py);
      if (qx < x0) x0 = qx;
      if (qy < y0) y0 = qy;
      if (qx > x1) x1 = qx;
      if (qy > y1) y1 = qy;
    }
    return regionWithQuad([x0, y0, x1 - x0, y1 - y0, 1], use.ctm, rg.x, rg.y, rg.w, rg.h);
  };
  // `use` (a shape's claim, { own, ctm }) resolves the region for that use, so each distinct region gets its own filter
  // entry: a shallow copy of the parsed record carrying `regionUse`. Images and text pass no `use` and share the record,
  // keeping the older rule that only a stated objectBoundingBox region clips.
  /// The region of a filter INHERITED from a group. Either a rect in root user space (userSpaceOnUse, mapped through
  /// the CTM of the element carrying the attribute) or the objectBoundingBox fractions, which bundleFinalize turns
  /// into a rect once the union of the group's shapes is known. An unstated region is the -10%/120% default, which for
  /// a group is a fraction of the GROUP's box — the reason a per-shape claim cannot resolve it.
  const groupFilterRegion = (rg, inst) => {
    if (!rg || rg.unbounded) return null;
    if (rg.empty) return { frac: { x: 0, y: 0, w: 0, h: 0 } };
    if (rg.oBB) {
      const x = rg.stated ? rg.x : -0.1,
        y = rg.stated ? rg.y : -0.1;
      const w = rg.stated ? rg.w : 1.2,
        h = rg.stated ? rg.h : 1.2;
      return w > 0 && h > 0 ? { frac: { x, y, w, h } } : null;
    }
    const ctm = _filterInstCtm.get(inst);
    if (!ctm || !(rg.w > 0 && rg.h > 0)) return null;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [px, py] of [
      [rg.x, rg.y],
      [rg.x + rg.w, rg.y],
      [rg.x, rg.y + rg.h],
      [rg.x + rg.w, rg.y + rg.h],
    ]) {
      const [qx, qy] = matApply(ctm, px, py);
      if (qx < x0) x0 = qx;
      if (qy < y0) y0 = qy;
      if (qx > x1) x1 = qx;
      if (qy > y1) y1 = qy;
    }
    return { rect: regionWithQuad([x0, y0, x1 - x0, y1 - y0, 1], ctm, rg.x, rg.y, rg.w, rg.h) };
  };
  // Whether a filter graph places anything in the referencing element's user space: an external feImage
  // whose subregion is in userSpaceOnUse primitive units (filterGraph/feImagePlace.js).
  const graphPlacesInUserSpace = (rec) =>
    !!(
      rec &&
      rec.kind === 'graph' &&
      rec.graph &&
      rec.graph.nodes &&
      rec.graph.nodes.some(
        (n) =>
          (n.type === 'feImage' && n.params && n.params.external && !n.params.subUnits) ||
          // ...and any other primitive that states a subregion: x / y / width / height are in the user space of the referencing element
          // (an objectBoundingBox one is turned into that user space at finalize).
          (n.type !== 'feImage' && n.params && n.params.sub),
      )
    );
  // A node whose parameters live in the referencing element's user space and so need its CTM: a point or spot
  // light's position, and a blur whose axes are the element's (importFilters blurFollowsAxes decides, per CTM).
  const graphNodeNeedsCtm = (n, ctm) =>
    !!(
      n.params &&
      (((n.type === 'feDiffuseLighting' || n.type === 'feSpecularLighting') &&
        (n.params.lightType | 0) > 0) ||
        (n.type === 'feGaussianBlur' && blurFollowsAxes(n.params, ctm)))
    );
  // `extra` ({ ctm, shapeIdx }): an element that is not a shape claim (text, an image with an inherited filter) still has a user space; its
  // filter's lengths follow its transform. `shapeIdx` names the first row it emits, which boxes the objectBoundingBox primitive units
  // (a text claims every glyph row it emits after the fact: setFilterBoxRows).
  const claimFilter = (svgId, use, extra) => {
    let rec = filtersDict[svgId];
    if (use?.container && rec?._makeGroupGraph)
      rec = { ...rec, kind: 'graph', graph: rec._makeGroupGraph() };
    // A lone anisotropic blur is the single-kind blur, which has no graph to carry axes in. Under an element CTM
    // that turns or skews it the blur belongs to the element's axes, so it takes the graph route.
    else if (
      rec &&
      rec.kind === 'blur' &&
      use?.own &&
      use.ctm &&
      rec._makeGroupGraph &&
      blurFollowsAxes({ sigmaX: rec.sigmaX, sigmaY: rec.sigmaY }, use.ctm)
    ) {
      const g = rec._makeGroupGraph();
      if (g) rec = { ...rec, kind: 'graph', graph: g };
    }
    // ...and a lone morphology under a CTM that turns or skews it: its window is the element's rectangle.
    else if (
      rec &&
      rec.kind === 'morphology' &&
      use?.own &&
      use.ctm &&
      rec._makeGroupGraph &&
      morphFollowsAxes(rec, use.ctm)
    ) {
      const g = rec._makeGroupGraph();
      if (g) rec = { ...rec, kind: 'graph', graph: g };
    }
    if (!rec) return 0;
    if (rec.kind === 'unsupported') {
      if (!warnedUnsupportedFilter) {
        mantleWarn(
          'bundle exporter: unsupported filter primitives in #' + svgId + '; rendering unfiltered.',
        );
        warnedUnsupportedFilter = true;
      }
      return 0;
    }
    // An inherited claim gets ONE entry per group instance, keyed by it: every child of that group shares the entry and
    // therefore the group's region. A shape's own claim keys by its resolved region as before.
    const inst = use && (!use.own || use.container) ? currentFilterInstance() : 0;
    const regionUse = use ? resolveFilterRegion(rec.region, use) : undefined;
    const groupRg = inst > 0 ? groupFilterRegion(rec.region, inst) : null;
    // A shape's own objectBoundingBox REGION UNDER A TURNED CTM. The fractions are of the shape's box in
    // its own user space (SVG 1.1 §7.11 excludes the element's own transform from that box; Filter Effects 1 §5
    // puts the operations in the element's local system), and filterDraw resolves space 0 at draw time against
    // the meta row's DOCUMENT-space box -- which under a rotation or a skew is the AABB of the turned shape,
    // both bigger and offset. finalizeBundle resolves those to a root-space rect instead, as it does
    // for a group's region, and that needs ONE ENTRY PER SHAPE: the key below is the fractions, which are equal
    // for every shape referencing the filter however each one is turned. Only a turned shape splits, so an
    // unturned shape gains no entry and moves no byte. The positive-diagonal test is exact, not a
    // tolerance, and matches _obbGradSup / _obbCtm in bundleFinalize.js.
    const ownTurned = !!(
      use &&
      use.own &&
      !use.container &&
      regionUse &&
      (regionUse[4] | 0) === 0 &&
      regionUse[2] > 0 &&
      regionUse[3] > 0 &&
      use.ctm &&
      Number.isFinite(use.shapeIdx) &&
      !(use.ctm[1] === 0 && use.ctm[2] === 0 && use.ctm[0] > 0 && use.ctm[3] > 0)
    );
    // An EXTERNAL feImage is placed in the user space of the element referencing the filter
    // (primitiveUnits userSpaceOnUse), so the entry carries that CTM and one entry per distinct CTM.
    // (the noise of feTurbulence follows the element's DOCUMENT transform: a bundle stored relative to an origin has the origin's translation in
    // every CTM, which is not a transform of the element)
    const docCtmOf = (m) => {
      const o = opts._origin;
      return o && (o[0] !== 0 || o[1] !== 0)
        ? [m[0], m[1], m[2], m[3], m[4] + o[0], m[5] + o[1]]
        : m;
    };
    const userCtm =
      (use && use.own && use.ctm) ||
      (inst > 0 && _filterInstCtm.get(inst)) ||
      (extra && extra.ctm) ||
      null;
    // The filter's lengths live in that user space too (SVG 1.1 section 15.7.1 / Filter Effects 1 section 3.2: the user coordinate system of the
    // referencing element, its transform included): a blur under scale(2) reaches twice as far. A graph or record with only such lengths needs
    // the LINEAR part of the CTM, so the entry splits per linear part and not per position; one that places something (an offset, a light, a
    // subregion, the noise field) takes the whole CTM.
    const fullCtm =
      graphPlacesInUserSpace(rec) ||
      (rec.kind === 'graph' &&
        rec.graph?.nodes.some((n) => n.type === 'feOffset' || graphNodeNeedsCtm(n, userCtm))) ||
      (recordNeedsFullCtm(rec) && !!userCtm && !isIdentityCtm(docCtmOf(userCtm)));
    const primCtm = fullCtm
      ? userCtm
      : userCtm && recordNeedsLinear(rec, userCtm)
        ? [userCtm[0], userCtm[1], userCtm[2], userCtm[3], 0, 0]
        : null;
    // Numbers in objectBoundingBox primitiveUnits are fractions of the referencing element's box (bundleFinalize turns them into user
    // units), so the entry is that element's: one per shape, and a group's per instance (its key already carries it).
    const needsBox = rec.kind === 'graph' && !!(rec.graph && rec.graph.obb);
    const boxUse =
      needsBox &&
      ((!!use && Number.isFinite(use.shapeIdx)) || (!!extra && Number.isFinite(extra.shapeIdx)));
    const boxShapeIdx =
      use && Number.isFinite(use.shapeIdx)
        ? use.shapeIdx | 0
        : extra && Number.isFinite(extra.shapeIdx)
          ? extra.shapeIdx | 0
          : -1;
    if (needsBox && !boxUse && !warnedBoxFilter) {
      warnedBoxFilter = true;
      mantleWarn(
        'bundle exporter: primitiveUnits="objectBoundingBox" is resolved for shapes, groups, text and images; on this element its numbers stay as written.',
      );
    }
    const readsOwnerPaint =
      rec.kind === 'graph' &&
      rec.graph?.nodes.some((node) => node.inputs.some((input) => input === -5 || input === -6));
    const ownerPaints = readsOwnerPaint ? _filterInstPaints.get(currentFilterInstance()) : null;
    const elementOpacity = Math.max(
      0,
      Math.min(1, parseAlphaOr(getStyleProp(walkCtx._curEl, 'opacity', null), 1)),
    );
    const key =
      (use
        ? inst > 0
          ? svgId + '|g' + inst
          : ownTurned
            ? svgId + '|s' + (use.shapeIdx | 0)
            : svgId +
              '|' +
              (regionUse
                ? regionUse.join(',') + (regionUse.quad ? '|q' + regionUse.quad.join(',') : '')
                : '-')
        : svgId) +
      (boxUse && inst === 0 ? '|b' + boxShapeIdx : '') +
      (primCtm && !isIdentityCtm(primCtm) ? '|m' + primCtm.join(',') : '') +
      '|a' +
      elementOpacity +
      (ownerPaints ? '|p' + JSON.stringify(ownerPaints) : '') +
      (ownerPaints && Object.values(ownerPaints).some((paint) => paint?.kind === 'server')
        ? '|owner' + (use?.shapeIdx ?? -1) + ':' + currentFilterInstance()
        : '');
    if (!(key in filterIdBySvgId)) {
      const entry = Object.assign({}, rec, use ? { regionUse } : {}, { elementOpacity });
      if (ownerPaints) entry.graph = { ...rec.graph, ownerPaints };
      if (ownerPaints)
        entry.ownerPaintFrame = {
          ctm: (
            (use?.own && use.ctm) ||
            _filterInstCtm.get(currentFilterInstance()) ||
            IDENT
          ).slice(),
          shapeIdx: use?.shapeIdx ?? -1,
        };
      // (A CTM only comes with a `use`, so the entry is a copy, never the shared record.)
      if (primCtm && !isIdentityCtm(primCtm)) entry.primCtm = primCtm.slice();
      if (ownTurned) entry.ownRegionShape = use.shapeIdx | 0;
      if (boxUse) {
        entry.obbBox = true;
        entry.obbCtm = userCtm || null;
      }
      if (groupRg) {
        entry.regionUse = groupRg.rect || null;
        if (groupRg.frac) entry.groupRegion = groupRg.frac;
      }
      ctx.filtersUsed.push(entry);
      ctx.filterBindings.push(boxShapeIdx);
      ctx.filterInstances.push(inst);
      filterIdBySvgId[key] = ctx.filtersUsed.length;
    }
    // every shape under the group, not just the one that minted the entry: the group's box is their union, and the
    // entry records only its first claimer. (An objectBoundingBox clip mints an entry per shape, so its union can be
    // taken over the entries themselves; one entry per group cannot.)
    if (inst > 0 && use && Number.isFinite(use.shapeIdx)) {
      if (!ctx.filterInstShapes) ctx.filterInstShapes = new Map();
      const list = ctx.filterInstShapes.get(inst) || [];
      list.push(use.shapeIdx | 0);
      ctx.filterInstShapes.set(inst, list);
    }
    return filterIdBySvgId[key];
  };

  // Parse <clipPath> and <mask> defs; claim-on-use mapping to 1-based IDs.
  // userSpaceOnUse defs are shared across all referencing shapes (one
  // entry in ctx.clipsUsed/ctx.masksUsed). objectBoundingBox defs need a SEPARATE
  // entry per referencing shape because each shape's bbox produces a
  // different transformed geometry. ctx.clipBindings[i] / ctx.maskBindings[i]
  // record the referencing shape's index when entry i is bbox-bound,
  // -1 for shared userSpaceOnUse.
  const { clipPaths: clipDict, masks: maskDict } = parseClipsAndMasks(root);
  const clipIdBySvgId = Object.create(null);
  // Parallel to ctx.clipsUsed: the SVG `<clipPath id="...">` for each
  // entry, or '' for entries with no id. Drives the post-walk
  // `clipperRows` map so consumers can address the live first-meta-row
  // of a clip by its author-facing svgId (animatable clipper).
  if (!ctx.clipSvgIds) ctx.clipSvgIds = [];
  const claimClip = (svgId, referencingShapeIdx) => {
    const def = clipDict[svgId];
    if (!def) return 0;
    if (!ctx.clipInstances) ctx.clipInstances = [];
    const isObjBBox = def.units === 'objectBoundingBox';
    if (!isObjBBox) {
      if (!(svgId in clipIdBySvgId)) {
        ctx.clipsUsed.push(def);
        ctx.clipBindings.push(-1);
        ctx.clipInstances.push(0);
        ctx.clipSvgIds.push(def.svgId || svgId);
        clipIdBySvgId[svgId] = ctx.clipsUsed.length;
      }
      return clipIdBySvgId[svgId];
    }
    ctx.clipsUsed.push({ ...def, viewport: walkCtx.viewport });
    ctx.clipBindings.push(referencingShapeIdx);
    ctx.clipInstances.push(currentClipInstance());
    ctx.clipSvgIds.push(def.svgId || svgId);
    return ctx.clipsUsed.length;
  };
  const maskIdBySvgId = Object.create(null);
  // Parallel to ctx.masksUsed: the `<mask id="...">` svgId for each entry
  // (mirrors ctx.clipSvgIds). Drives the clipperRows map so the native
  // fallback can address a mask's child <path> by its author-facing id —
  // needed to animate the mask GEOMETRY through a morph (the reveal-wipe
  // case), not just transforms.
  if (!ctx.maskSvgIds) ctx.maskSvgIds = [];
  const claimMask = (svgId, referencingShapeIdx) => {
    const def = maskDict[svgId];
    if (!def) return 0;
    if (!ctx.maskInstances) ctx.maskInstances = [];
    const isObjBBox = def.units === 'objectBoundingBox';
    if (!isObjBBox) {
      if (!(svgId in maskIdBySvgId)) {
        ctx.masksUsed.push(def);
        ctx.maskBindings.push(-1);
        ctx.maskInstances.push(0);
        ctx.maskSvgIds.push(def.svgId || svgId);
        maskIdBySvgId[svgId] = ctx.masksUsed.length;
      }
      return maskIdBySvgId[svgId];
    }
    ctx.masksUsed.push({ ...def, viewport: walkCtx.viewport });
    ctx.maskBindings.push(referencingShapeIdx);
    ctx.maskInstances.push(currentMaskInstance());
    ctx.maskSvgIds.push(def.svgId || svgId);
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
    if (sd.segs && sd.segs.length) {
      const info = {};
      sd.segs = clampSegsToF32(sd.segs, info);
      if (info.clamped && !walkCtx._warnedF32Clamp) {
        walkCtx._warnedF32Clamp = true;
        mantleWarn(
          'svgImporter: a coordinate beyond the float32 range (about 4e37) was clamped; the shape is wrong beyond it',
        );
      }
    }
    if (sourcePaths && walkCtx._curEl && sourcePaths.has(walkCtx._curEl))
      sd._domPath = sourcePaths.get(walkCtx._curEl);
    if (walkCtx.walkLayerMode) {
      if (
        (sd.kind === 'groupBegin' || sd.kind === 'groupEnd') &&
        (!walkCtx.retainLayerGroups || walkCtx.inClipContent > 0)
      )
        return;
      sd.isLayer = true;
      if (!walkCtx.retainLayerGroups) {
        sd.blendMode = 0;
        sd.isolation = 0;
      }
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
    if (sd.shapeId == null)
      sd.shapeId = sd.kind === 'groupBegin' || sd.kind === 'groupEnd' ? '' : currentId();
    // Sprite-sheet addressing: stamp the TOP-LEVEL sprite id this record
    // belongs to. idStack[0] is the root <svg>'s id (usually ''); idStack[1]
    // is the direct child of root — a top-level <g id> or a lone id'd
    // top-level shape, i.e. one addressable "sprite". Descendants of a
    // top-level group all share that group's id (idStack[1] is stable down
    // the subtree). Empty when the record isn't under any id'd top-level
    // element (not addressable as a sprite). Captured here so the meta loop
    // can build bundle.spriteRanges in meta-row space (clipperRows-style).
    sd._spriteId = opts._spriteId || (idStack.length > 1 ? _spriteTop : '') || '';
    sd._grp =
      sd.kind === 'groupBegin' || sd.kind === 'groupEnd'
        ? groupStack.at(-1) || null
        : groupStack.length > 1
          ? groupStack[groupStack.length - 2]
          : null;
    // Renderable-leaf ordinal of the originating source element (see
    // leafOrdinalByEl above). -1 when the record has no addressable element
    // of its own: <use> expansions (the DOM leaf is the <use>), pattern
    // layer children, group scaffolding, glyphs of a shared <text> get the
    // <text>'s ordinal. Consumed per meta row as bundle.shapeDomIndex by
    // the native fallback's positional addressing.
    if (sd._domLeaf == null) {
      const cur = walkCtx._curEl;
      sd._domLeaf =
        walkCtx._useDepth > 0 || walkCtx.walkLayerMode || !cur || !leafOrdinalByEl.has(cur)
          ? -1
          : leafOrdinalByEl.get(cur);
    }
    // Shape elements are named by their document ordinal when they have no id (bundleFinalize synthId), so a morph pairs them whatever each pose drew.
    {
      const cur = walkCtx._curEl,
        t = cur ? svgElementName(cur) : '';
      sd._stableLeaf =
        sd._domLeaf >= 0 && !sd._marker && !sd.isLayer && !sd.kind && STABLE_ID_TAGS[t] === 1
          ? sd._domLeaf
          : -1;
    }
    // opts.sprites allow-list filter: when provided, keep only records whose
    // top-level sprite is listed and DISCARD the rest entirely (never
    // encoded — a smaller bundle, not a hidden one). Group scaffolding
    // (groupBegin/groupEnd) follows its subtree: dropped if its sprite is.
    // The clip and mask drain (walkCtx._finalizing) is exempt: that content belongs to whichever kept shape claimed the def, and it has no
    // sprite of its own.
    if (_spriteAllow && !walkCtx._finalizing && sd._spriteId && !_spriteAllow.has(sd._spriteId))
      return;
    if (_spriteAllow && !walkCtx._finalizing && !sd._spriteId) return; // un-id'd top-level = "the rest"
    // THE ELEMENT CARRYING this SHAPE'S MASK, as the instance walk() minted for it: the mask REGION is a rect in that
    // element's box or user space (clipMask.js maskRegionOf), which finalizeBundle resolves once the carrier's shapes
    // are all known (applyMaskRegions), including nested masks found during the layer drain.
    if ((sd.maskId | 0) > 0 && sd._maskInst == null) sd._maskInst = currentMaskInstance();
    // WHAT THE POINTER CAN TARGET (hitBits.js): resolved here, from the leaf's own cascade. Scaffolding, pattern /
    // clip / mask content and marker content are never targets (a marker belongs to the path that references it and
    // Chrome does not hit-test it).
    if (sd.kind === undefined && sd.hitBits === undefined) {
      if (sd.isLayer || sd._marker || walkCtx.inClipContent > 0 || walkCtx._markerDepth > 0)
        sd.hitBits = 0;
      else {
        const el = walkCtx._curEl;
        const vis = sd.hitVisible ?? (el ? isEffectivelyVisible(el) : true); // hitVisible: a glyph of a <text> whose elements differ answers for its own
        sd.hitVis = vis;
        const pe = el ? getPointerEvents(el) : 'auto',
          fillPainted = !(sd.hitFillNone ?? sd.fillNone),
          strokePainted = sd.strokeNone !== undefined ? !sd.strokeNone : sd.strokeRgba[3] > 0;
        sd.hitBits = hitBitsOf(pe, vis, fillPainted, strokePainted, sd.sw > 0);
        // A row kept hidden answers, once revealed, as the same element displayed and visible (hitBits.js HIT_HIDDEN).
        if (walkCtx._hiddenBits)
          sd.hitBitsShown = hitBitsOf(pe, true, fillPainted, strokePainted, sd.sw > 0);
      }
    }
    // keepHidden: this record belongs to content the document hides (display:none, a visibility:hidden leaf).
    // Its rows are flagged (FS_HIDDEN) and draw nothing until revealed. The scaffolding of such an element (a group it opened) follows it, and so
    // does a marker, which is walked inside its path; pattern, clip and mask rows are never flagged.
    if (
      walkCtx._hiddenBits &&
      !sd.isLayer &&
      !(walkCtx.inClipContent > 0) &&
      !walkCtx.walkLayerMode
    )
      sd._hidden = walkCtx._hiddenBits;
    // A stroke whose alpha is 0 (stroke-opacity 0, opacity 0, `transparent`) still gets its row, drawn at alpha 0 (keepInvisibleShapes, on by
    // default): a morph pairs it, an override or a hit test finds it. A stroke of `none` has no paint to keep.
    if (
      sd.kind === undefined &&
      !sd.isLayer &&
      sd.strokeNone === false &&
      sd.sw > 0 &&
      sd.strokeRgba &&
      sd.strokeRgba[3] === 0 &&
      sd.segs &&
      sd.segs.length &&
      keepInvisibleOf(opts)
    )
      sd._keepStroke = true;
    // A painted stroke of width 0 has no row; the default import counts it (bundle.dropped).
    else if (
      sd.kind === undefined &&
      !sd.isLayer &&
      !sd._marker &&
      sd.strokeNone === false &&
      !(sd.sw > 0) &&
      sd.strokeRgba &&
      sd.strokeRgba[3] > 0 &&
      sd.segs &&
      sd.segs.length
    )
      walkCtx.dropCount('zeroWidthStrokes');
    if (hitOwnerNodes && !sd.isLayer && !sd.kind && hitOwnerNodes.has(walkCtx._curEl)) {
      const part = walkCtx._hitOwnerPart++;
      if (walkCtx._hiddenLeaf || sd._hidden) {
        const owner = opts._hitOwnerSession.owner(
          walkCtx._hitUseOwner || 0,
          hitOwnerNodes.get(walkCtx._curEl),
        );
        sd._hitOwner = opts._hitOwnerSession.part(owner, part);
      }
    }
    // The document position of a shape the first pass never saw (a hidden leaf): the count of shapes before it.
    if (walkCtx.hitPass && !sd.isLayer) {
      const at = walkCtx._hitSeq | 0;
      sd._pos = at;
      if (!walkCtx._hiddenLeaf) walkCtx._hitSeq = at + 1;
    }
    if (basicInstStack.length && sd.segs && sd.segs.length) {
      for (const inst of basicInstStack) {
        let m = _clipInstMembers.get(inst);
        if (!m) _clipInstMembers.set(inst, (m = []));
        m.push(sd);
      }
    }
    ctx.shapesData.push(sd);
  }
  // Nested clip-path INTERSECTION (SVG 1.1 §14.3): an element's own
  // `clip-path` narrows the inherited one, it does not replace it. This is the
  // pdftocairo / Illustrator shape — an outer artboard-bbox clip wrapping an
  // inner contour clip — where taking the inner alone silently over-draws.
  //
  // Rather than teach the per-shape data model to hold a list of clip ids
  // (each shape carries exactly one `clipId`), synthesize a combined
  // `<clipPath>` def: a copy of the inner def whose children are wrapped in
  // `<g clip-path="url(#outer)">`. The clip-def drain in bundleFinalize.js
  // walks clip children with the same walk(), so the wrapper re-enters this
  // path and the shader's depth-1 nested-clip evaluator AND-multiplies the
  // two coverages. Deeper nesting folds recursively (the synthetic def
  // becomes the next level's outer).
  //
  // Returns a `url(#id)` ref string. Memoized per (outer, inner) pair so a
  // file with 76 identical nestings registers each combination once.
  const SVGNS = 'http://www.w3.org/2000/svg';
  const _combinedClipIds = new Map();
  const _basicComboIds = new Map();
  const combineClipRefs = (ownRef, inheritedRef, ownInst = 0, inheritedInst = 0) => {
    if (!ownRef) return inheritedRef || '';
    if (!inheritedRef) return ownRef;
    const innerId = resolveIdRef(ownRef),
      outerId = resolveIdRef(inheritedRef);
    const inner = innerId && clipDict[innerId],
      outer = outerId && clipDict[outerId];
    // An absent or invalid child clip adds no restriction to ancestor clipping.
    if (!inner || !inner.element) return inheritedRef;
    if (!outer || !outer.element) return ownRef;
    // A basic shape on either side: the intersection is a LIST OF LAYERS, outermost first, each a basic shape (resolved against its
    // own carrier, whose instance it remembers) or a plain reference. bundleFinalize builds one clip from it when the boxes are
    // known (basicShapeFrame): the innermost layer is the content, every outer layer a clip on a wrapper around it.
    const isObb = (d) => d.units === 'objectBoundingBox';
    if (
      inner.basicShape ||
      inner.layers ||
      outer.basicShape ||
      outer.layers ||
      isObb(inner) ||
      isObb(outer)
    ) {
      const layersOf = (id, def, inst) =>
        def.layers ||
        (def.basicShape
          ? [{ basic: def.basicShape, inst }]
          : isObb(def)
            ? [{ obb: id, inst }]
            : [{ ref: `url(#${id})` }]);
      const key = `${outerId}\0${innerId}\0${ownInst}\0${inheritedInst}`;
      const hit = _basicComboIds.get(key);
      if (hit) return hit;
      const comboId = `__mantleBasicCombo${_basicComboIds.size}`;
      const doc = inner.element.ownerDocument;
      clipDict[comboId] = {
        element: doc.createElementNS(SVGNS, 'clipPath'),
        units: 'objectBoundingBox',
        maskType: 'luminance',
        layers: [...layersOf(outerId, outer, inheritedInst), ...layersOf(innerId, inner, ownInst)],
      };
      const ref = `url(#${comboId})`;
      _basicComboIds.set(key, ref);
      return ref;
    }
    const key = `${outerId}\0${innerId}`;
    const hit = _combinedClipIds.get(key);
    if (hit) return hit;
    const doc = inner.element.ownerDocument;
    if (!doc || !doc.createElementNS) return ownRef;
    const combinedId = `__mantleClipIsect${_combinedClipIds.size}_${outerId}_${innerId}`;
    const el = doc.createElementNS(SVGNS, 'clipPath');
    el.setAttribute('id', combinedId);
    // clipPathUnits is the INNER def's — the wrapper's own clip resolves
    // through the normal ref path and carries the outer def's units itself.
    el.setAttribute('clipPathUnits', inner.units);
    if (inner.element.getAttribute('transform'))
      el.setAttribute('transform', inner.element.getAttribute('transform'));
    const g = doc.createElementNS(SVGNS, 'g');
    g.setAttribute('clip-path', `url(#${outerId})`);
    // Both refs are already placed (see placeDefRef): the inner def's children are walked with its CTM, and the
    // outer ref must not be placed again in that space.
    g.setAttribute(CLIP_PLACED_ATTR, '1');
    g.setAttribute(CLIP_WRAP_ATTR, '1');
    g._mantleKids = elementChildren(inner.element);
    el.appendChild(g);
    // The content inherits from the inner <clipPath> and its ancestors (walkDefContent), which is who it inherits from alone.
    el._mantleInheritFrom = inner.element._mantleInheritFrom || inner.element;
    clipDict[combinedId] = {
      element: el,
      units: inner.units,
      maskType: 'luminance',
      ctm: inner.ctm,
      viewport: inner.viewport,
      placed: true,
    };
    const ref = `url(#${combinedId})`;
    _combinedClipIds.set(key, ref);
    return ref;
  };

  /// A CSS BASIC-SHAPE clip-path (CSS Masking 1: inset(), circle(), ellipse(), polygon(), path(), rect(), xywh(), with an optional
  /// geometry-box) is read at the element that carries it and becomes an ordinary clip def: objectBoundingBox-bound (one claim per
  /// carrier, because the shape is resolved against the carrier's reference box), with the parsed shape on the def. The shape's
  /// outline is built when the box is known (bundleFinalize, basicShapeFrame) as exact path geometry in the carrier's user space, so
  /// the rest of the pipeline (the fill shader, the mask bake, the hit test) sees a clipPath. Anything else comes back unchanged.
  const _basicShapeIds = new Map();
  const normClip = (raw, node) => {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s || /^none$/i.test(s) || s[0] === '#' || /^url\(/i.test(s)) return s;
    const spec = parseClipPathShape(s);
    const doc = node && node.ownerDocument;
    if (!spec || !doc || !doc.createElementNS) return s;
    const vp = walkCtx.viewport;
    const fc = {
      fontSize: (vp && vp.fontSize) || INITIAL_FONT_SIZE,
      rootFontSize: (vp && vp.rootFontSize) || walkCtx.rootFontSize || INITIAL_FONT_SIZE,
    };
    const vb = [(vp && +vp.parentWidth) || 0, (vp && +vp.parentHeight) || 0];
    const key = `${s}\0${fc.fontSize}\0${fc.rootFontSize}\0${vb[0]},${vb[1]}`;
    let id = _basicShapeIds.get(key);
    if (!id) {
      id = `__mantleBasicShape${_basicShapeIds.size}`;
      const el = doc.createElementNS(SVGNS, 'clipPath');
      el.setAttribute('id', id);
      clipDict[id] = {
        element: el,
        units: 'objectBoundingBox',
        maskType: 'luminance',
        basicShape: { spec, fc, vb, compat: walkCtx.compat },
      };
      _basicShapeIds.set(key, id);
    }
    if (spec.box !== 'fill' && spec.box !== 'view') walkCtx._strokeBoxWanted = true;
    return `url(#${id})`;
  };

  /// A viewport clip: the polygon a nested viewport's rect maps to in root user space.
  ///
  /// A nested <svg>, and a <symbol> instantiated by <use>, establish a viewport that CLIPS their content unless the
  /// author asks for overflow:visible (CSS UA style `svg { overflow: hidden }`, SVG 1.1 §14.3.3). userSpaceOnUse clip
  /// geometry is walked in ROOT user space, so the rect is mapped through the CTM in force where x/y/width/height are
  /// written — as a path, because a rotated or skewed ancestor turns the rect into a parallelogram that no <rect> can
  /// express. Memoized per polygon: a file with many instances of one symbol registers each geometry once.
  const _viewportClipIds = new Map();
  let viewportClipDocument = null;
  const viewportClipRef = (doc, pts) => {
    if (!doc || !doc.createElementNS) return '';
    // Every digit of each coordinate (a number's shortest round trip): toFixed(4) rounded to an absolute 1e-4, so a
    // viewport 1e-4 across collapsed to a point and one at 2^-20 art scale to nothing.
    const d = 'M' + pts.map((p) => String(p[0]) + ' ' + String(p[1])).join('L') + 'Z';
    const hit = _viewportClipIds.get(d);
    if (hit) return hit;
    const id = `__mantleViewportClip${_viewportClipIds.size}`;
    // Implicit viewport boundaries are not authored elements and cannot match
    // the document's selectors. Reuse one detached document per import.
    const generatedDoc = viewportClipDocument || (viewportClipDocument = doc.cloneNode(false));
    const el = generatedDoc.createElementNS(SVGNS, 'clipPath');
    el.setAttribute('id', id);
    el.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const path = generatedDoc.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    el.appendChild(path);
    clipDict[id] = { element: el, units: 'userSpaceOnUse', maskType: 'luminance', placed: true };
    const ref = `url(#${id})`;
    _viewportClipIds.set(d, ref);
    return ref;
  };

  /// A clip def whose every row is further cut by the clip entry `innerClipId` (a claimed 1-based id): the
  /// intersection of the two, for a row that must honor a second clip already CLAIMED for another shape. A marker is
  /// clipped by its viewport and by the referencing path's own clip-path, and that clip is the path's claimed
  /// entry -- an objectBoundingBox one bound to the PATH's box, or a group's to the group's -- which re-referencing it
  /// by url() would bind to the viewport polygon instead (combineClipRefs). bundleFinalize stamps the id on the rows
  /// the drain emits for this def, and the shader's nested-clip walk ANDs it in. Memoized per (def, inner id).
  const nestClipDef = (svgId, innerClipId) => {
    const def = clipDict[svgId];
    if (!def || !(innerClipId > 0)) return svgId;
    const id = `${svgId}__in${innerClipId}`;
    if (!clipDict[id]) clipDict[id] = { ...def, innerClipId };
    return id;
  };

  /// A userSpaceOnUse <clipPath> or <mask> is in THE USER SPACE OF THE ELEMENT THAT REFERENCES IT (CSS Masking 1:
  /// "the user coordinate system for the element referencing the clipPath element via the clip-path property"), which
  /// includes that element's own transform. Every consumer reads the rows in document space: the fill shader samples a
  /// clip row, and the mask bake draws a mask row, at the drawn fragment's own coordinate (transformClipCoord is the
  /// identity without an override). Walking every such def at the identity would leave a clip or mask referenced
  /// under any transform where the def's numbers put it: under a <g transform="scale(2)"> the clip would keep its
  /// unscaled size, and on <rect transform="translate(30 30)"> it would miss the rect.
  ///
  /// So a reference made under a CTM other than the identity gets its own entry: the same def element, with the CTM
  /// the drain walks its children through, memoized per (def, CTM). At the identity the ref comes back unchanged (the
  /// shared entry, as before). objectBoundingBox content is placed by the referencing shape's box, which the CTM
  /// already moved; refs this walker made in document space (viewport clips, intersections) are not placed twice.
  /// The entry keeps the author's id, so clipperRows still addresses it.
  const _placedDefIds = new Map();
  const placeDefRef = (dict, prefix, ref, ctm) => {
    if (!ref) return ref;
    const id = resolveIdRef(ref),
      def = id && dict[id];
    if (!def || !def.element || def.placed || def.units === 'objectBoundingBox') return ref;
    const viewport = walkCtx.viewport;
    const key = `${prefix}\0${id}\0${ctm.join(',')}\0${viewport ? viewport.parentWidth + ',' + viewport.parentHeight : ''}`;
    let hit = _placedDefIds.get(key);
    if (!hit) {
      const placedId = `${prefix}${_placedDefIds.size}_${id}`;
      dict[placedId] = {
        element: def.element,
        units: def.units,
        maskType: def.maskType,
        ctm,
        viewport,
        placed: true,
        svgId: def.svgId || id,
      };
      if (def.region) dict[placedId].region = def.region; // a mask's region travels with its placed copy
      hit = `url(#${placedId})`;
      _placedDefIds.set(key, hit);
    }
    return hit;
  };
  /// Place the element's own clip-path and mask (walk() pushed them before its CTM existed) in the space of `elCtm`.
  /// The clip is re-intersected with the inherited one, which is already placed.
  const placeOwnClipMask = (node, ownClip, ownMask, elCtm) => {
    if (ownClip && !(node.getAttribute && node.getAttribute(CLIP_PLACED_ATTR))) {
      const placed = placeDefRef(clipDict, '__mantleClipPlaced', ownClip, elCtm);
      if (placed !== ownClip) {
        clipStack[clipStack.length - 1] = combineClipRefs(
          placed,
          clipStack.length > 1 ? clipStack[clipStack.length - 2] : '',
          currentClipInstance(),
          clipInstStack.length > 1 ? clipInstStack[clipInstStack.length - 2] : 0,
        );
      }
    }
    if (ownMask)
      maskStack[maskStack.length - 1] = placeDefRef(maskDict, '__mantleMaskPlaced', ownMask, elCtm);
  };
  /// Record the CTM of the element CARRYING a clip-path or mask, keyed by the instance walk() just minted for it.
  /// An objectBoundingBox reference's supplemental matrix [w 0 0 h minx miny] is inserted into the NESTED
  /// transform stack (SVG 1.1 §7.11), so it composes INSIDE this element's CTM, and the box it maps is this
  /// element's box in its own user space -- the element's own transform excluded from the box and applied to the
  /// matrix afterwards. finalizeBundle needs both halves and a descendant's claim carries neither. The same array
  /// goes to the leaf handlers, so a shape that is itself the carrier is recognized by identity and can use its
  /// own untransformed box rather than unmapping the document-space geometry.
  const recordObbCarrier = (ownClip, ownMask, elCtm) => {
    if (ownClip) {
      const ci = currentClipInstance();
      if (ci > 0 && !_clipInstCtm.has(ci)) _clipInstCtm.set(ci, elCtm);
    }
    if (ownMask) {
      const mi = currentMaskInstance();
      if (mi > 0 && !_maskInstCtm.has(mi)) _maskInstCtm.set(mi, elCtm);
    }
  };
  /// An effect group (filter or mask) stands for the union of what it holds: its box and its segments, which the
  /// region and bbox-relative references of the effect are resolved against. Returns the member rows.
  const collectGroupGeometry = (group, skipMarkers = false) => {
    const at = ctx.shapesData.indexOf(group);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    // ...and the extent it PAINTS (strokes and markers included), which a region test against a mask or clip must use.
    const paint = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = at + 1; i < ctx.shapesData.length; i++) {
      const child = ctx.shapesData[i];
      if (child.isLayer || !child.segs?.length) continue;
      const pb = pathBbox(child.segs);
      const pad =
        child.sw > 0 && child.strokeRgba && child.strokeRgba[3] > 0
          ? child.sw *
            0.5 *
            strokeReachFactor(
              child.joinStyle,
              child.miterLimit,
              child.capStyle,
              child.endCapStyle ?? child.capStyle,
            )
          : 0;
      paint[0] = Math.min(paint[0], pb[0] - pad);
      paint[1] = Math.min(paint[1], pb[1] - pad);
      paint[2] = Math.max(paint[2], pb[2] + pad);
      paint[3] = Math.max(paint[3], pb[3] + pad);
      if (skipMarkers && child._marker) continue;
      // (A pattern STROKE's rect is the stroke's extent; the box the group's objectBoundingBox regions are fractions of is the element's.)
      const b = child.groupBoxSegs ? pathBbox(child.groupBoxSegs) : pb;
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
    }
    group.groupBBox = Number.isFinite(box[0]) ? box : [0, 0, 0, 0];
    group._paintBBox = Number.isFinite(paint[0]) ? paint : group.groupBBox;
    const members = [];
    group.segs = [];
    for (let i = at + 1; i < ctx.shapesData.length; i++) {
      const child = ctx.shapesData[i];
      if (!child.isLayer && child.segs?.length && !(skipMarkers && child._marker)) {
        members.push(i);
        for (const seg of child.segs) group.segs.push(seg);
      }
    }
    return members;
  };
  walkCtx.collectGroupGeometry = collectGroupGeometry;
  /// The rows a filter group's region is a fraction of: every shape under the group that owns the filter instance being walked.
  walkCtx.setFilterGroupMembers = (members) => {
    (ctx.filterInstShapes || (ctx.filterInstShapes = new Map())).set(
      currentFilterInstance(),
      members,
    );
  };
  /// Does a mask on a container need the composited group, or does the mask on the one leaf under it say the same thing?
  /// A mask multiplies the composite of everything the container paints; the composite of ONE shape that paints only a fill
  /// or only a stroke is that shape, so the leaf takes the mask as it always did and the container opens no group (no extra
  /// rows or offscreen pass, and a morph or an animated mask keeps the rows it matched). Anything else -- two leaves that may
  /// overlap, a fill with a stroke, markers, text, a nested <use> or <svg>, a leaf with a mask of its own -- needs the group.
  const MASK_SKIP_TAGS = {
    defs: 1,
    clippath: 1,
    mask: 1,
    marker: 1,
    pattern: 1,
    symbol: 1,
    lineargradient: 1,
    radialgradient: 1,
    filter: 1,
    style: 1,
    title: 1,
    desc: 1,
    metadata: 1,
    script: 1,
    view: 1,
  };
  const isPainted = (v) => {
    const t = (v == null ? '' : String(v)).trim().toLowerCase();
    return t !== 'none' && t !== 'transparent' && t !== '';
  };
  const leafNeedsMaskGroup = (leaf, fillOf, strokeOf) => {
    const tag = svgElementName(leaf);
    if (tag === 'image') return false;
    const own =
      (leaf.getAttribute &&
        (getStyleProp(leaf, 'mask', '') ||
          leaf.getAttribute('mask') ||
          getStyleProp(leaf, 'mask-image', ''))) ||
      '';
    if (own && own.trim().toLowerCase() !== 'none') return true;
    if (
      ['path', 'line', 'polyline', 'polygon'].includes(tag) &&
      ['marker-start', 'marker-mid', 'marker-end'].some((m) => {
        const v = getInheritedStyleProp(leaf, m, '');
        return v && v.trim().toLowerCase() !== 'none';
      })
    )
      return true;
    const sw = parseLengthOr(getInheritedStyleProp(leaf, 'stroke-width', '1'), 1, walkCtx.viewport);
    return isPainted(fillOf(leaf)) && isPainted(strokeOf(leaf)) && !(sw <= 0);
  };
  /// Is a mask's value 0 or 1 at every pixel it covers (apart from its own anti-aliased edge)? Shapes filled with exactly
  /// white or black (a luminance mask) or any opaque color (an alpha mask), no opacity, gradient, pattern, image, text,
  /// filter or nested mask. Such a mask cannot make two overlapping leaves show through each other, so each leaf keeps
  /// it (the exporter's usual rounded-corner frame) and the container opens no group; the edge pixels differ from the
  /// group result only where leaves overlap there (the stacked-leaf edge leak of a clip or mask, a documented limit).
  const maskIsBinary = (def) => {
    const el = def && def.element;
    if (!el || !el.getAttribute) return false;
    const alphaMask = String(def.maskType || '').toLowerCase() === 'alpha';
    const one = (v) => v === 1 || v === 0;
    let ok = true;
    const paintBinary = (v) => {
      const t = (v == null ? '' : String(v)).trim().toLowerCase();
      if (t === 'none' || t === 'transparent') return true;
      if (!t || /url\(|currentcolor|context-|inherit|var\(|light-dark|color-mix/.test(t))
        return false;
      const c = parseColor(t);
      if (!c || !(c[3] === 1)) return false;
      return alphaMask || (c[0] === c[1] && c[1] === c[2] && one(c[0]));
    };
    const visit = (n) => {
      for (const c of elementChildren(n)) {
        if (!ok) return;
        const t = svgElementName(c);
        if (MASK_SKIP_TAGS[t] === 1) continue;
        if (c.getAttribute && !isDisplayed(c)) continue;
        const touchy = ['filter', 'mask', 'mask-image', 'mix-blend-mode'].some((k) => {
          const v = (getStyleProp(c, k, '') || c.getAttribute(k) || '').trim().toLowerCase();
          return v && v !== 'none' && v !== 'normal';
        });
        const op = parseAlphaOr(getStyleProp(c, 'opacity', null), 1);
        if (touchy || op !== 1) {
          ok = false;
          return;
        }
        if (t === 'g' || t === 'a') {
          visit(c);
          continue;
        }
        if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(t)) {
          ok = false;
          return;
        }
        const fo = parseAlphaOr(getInheritedStyleProp(c, 'fill-opacity', null), 1),
          so = parseAlphaOr(getInheritedStyleProp(c, 'stroke-opacity', null), 1);
        if (
          fo !== 1 ||
          so !== 1 ||
          !paintBinary(getInheritedStyleProp(c, 'fill', 'black')) ||
          !paintBinary(getInheritedStyleProp(c, 'stroke', 'none'))
        ) {
          ok = false;
          return;
        }
      }
    };
    const own = (getStyleProp(el, 'mask', '') || el.getAttribute('mask') || '')
      .trim()
      .toLowerCase();
    if (own && own !== 'none') return false;
    visit(el);
    return ok;
  };
  /// Whether `el`, or anything rendered under it (through a <use> too), names a mask of its own. A leaf holds one mask, so a binary mask
  /// on an ancestor cannot ride down to such a leaf: the leaf's own would replace it.
  const hasOwnMask = (el) => {
    const v = ownMaskOf(el).trim().toLowerCase();
    return !!v && v !== 'none';
  };
  const ownsMaskBelow = (el, seen = new Set()) => {
    if (seen.has(el)) return false;
    seen.add(el);
    if (svgElementName(el) === 'use') {
      const target =
        idMap[resolveIdRef(el.getAttribute('href') || el.getAttribute('xlink:href') || '')];
      return !!target && (hasOwnMask(target) || ownsMaskBelow(target, seen));
    }
    for (const c of elementChildren(el)) {
      if (MASK_SKIP_TAGS[svgElementName(c)] === 1 && svgElementName(c) !== 'symbol') continue;
      if (hasOwnMask(c) || ownsMaskBelow(c, seen)) return true;
    }
    return false;
  };
  const maskNeedsGroup = (container, viaUse = null) => {
    if (viaUse) {
      const t = svgElementName(container);
      if (!LEAF_PAINT_TAGS[t] || t === 'text' || t === 'textarea') return true;
      return leafNeedsMaskGroup(
        container,
        (l) => getStyleProp(l, 'fill', viaUse.f),
        (l) => getStyleProp(l, 'stroke', viaUse.s),
      );
    }
    let leaf = null,
      count = 0,
      other = false;
    const scan = (el) => {
      for (const c of elementChildren(el)) {
        const t = svgElementName(c);
        if (MASK_SKIP_TAGS[t] === 1 || other) continue;
        if (c.getAttribute && !isDisplayed(c)) continue;
        if (t === 'g' || t === 'a') {
          const nested =
            c.getAttribute &&
            (getStyleProp(c, 'mask', '') ||
              c.getAttribute('mask') ||
              getStyleProp(c, 'filter', '') ||
              c.getAttribute('filter') ||
              '');
          const op = parseAlphaOr(getStyleProp(c, 'opacity', null), 1);
          const blend = (getStyleProp(c, 'mix-blend-mode', 'normal') || 'normal')
            .trim()
            .toLowerCase();
          if ((nested && nested.trim().toLowerCase() !== 'none') || op < 1 || blend !== 'normal')
            other = true;
          else scan(c);
        } else if (LEAF_PAINT_TAGS[t] && t !== 'text' && t !== 'textarea') {
          count++;
          leaf = c;
        } else other = true; // <use>, nested <svg>, <switch>, <text>, anything this does not look into
      }
    };
    scan(container);
    if (other || count > 1) return true;
    return (
      count === 1 &&
      leafNeedsMaskGroup(
        leaf,
        (l) => getInheritedStyleProp(l, 'fill', 'black'),
        (l) => getInheritedStyleProp(l, 'stroke', 'none'),
      )
    );
  };
  walkCtx.maskNeedsGroup = maskNeedsGroup;
  walkCtx.maskIsBinaryId = (id) => maskIsBinary(maskDict[id]);
  /// Take the mask / clip off the element being walked for its walked descendants (a group has taken it), and give it back.
  walkCtx.holdTopMask = () => {
    const held = maskStack[maskStack.length - 1];
    maskStack[maskStack.length - 1] = '';
    return held;
  };
  walkCtx.releaseTopMask = (held) => {
    maskStack[maskStack.length - 1] = held;
  };
  walkCtx.holdTopClip = () => {
    const held = clipStack[clipStack.length - 1];
    clipStack[clipStack.length - 1] = '';
    return held;
  };
  walkCtx.releaseTopClip = (held) => {
    clipStack[clipStack.length - 1] = held;
  };
  /// Intersect `ref` into the clip the element being walked passes to its descendants. walk() has already pushed this
  /// element's entry, so the top of the stack is ours to narrow and the pop in walk()'s finally still balances.
  const narrowCurrentClip = (ref) => {
    if (!ref || clipStack.length === 0) return;
    clipStack[clipStack.length - 1] = combineClipRefs(
      ref,
      clipStack[clipStack.length - 1],
      0,
      currentClipInstance(),
    );
  };
  /// SVG's overflow: `visible` and `auto` show the overflow, anything else (including the initial `hidden`) clips.
  const viewportClips = (node) => {
    const v = (
      getStyleProp(node, 'overflow', '') ||
      (node.getAttribute ? node.getAttribute('overflow') : '') ||
      ''
    )
      .trim()
      .toLowerCase();
    return v !== 'visible' && v !== 'auto';
  };
  /// A <clipPath> or <mask> def may carry its own `clip-path`, and the clip is then the INTERSECTION of the two
  /// (SVG 1.1 §14.3.5, clip-of-clip). The drain walks the def's CHILDREN, which never see the def element's own
  /// attribute, so fold it in the way combineClipRefs folds an element's own clip into the inherited one: the def's
  /// children are walked under a <g clip-path="...">. The wrapper re-enters the ordinary ref path, so a def whose own clip
  /// has its own clip folds recursively. The def and its children stay the authored elements (elementChildren): what
  /// they inherit and which rules match them do not change.
  const foldDefOwnClips = (dict) => {
    for (const id of Object.keys(dict)) {
      const def = dict[id],
        el = def && def.element;
      if (!el || !el.getAttribute) continue;
      const own = (getStyleProp(el, 'clip-path', '') || el.getAttribute('clip-path') || '').trim();
      if (!own || own === 'none') continue;
      const doc = el.ownerDocument;
      if (!doc || !doc.createElementNS || el._mantleKids) continue;
      const g = doc.createElementNS(SVGNS, 'g');
      g.setAttribute(CLIP_WRAP_ATTR, '1');
      g.setAttribute('clip-path', own);
      g._mantleKids = elementChildren(el);
      el._mantleKids = [g];
    }
  };
  foldDefOwnClips(clipDict);
  // A <mask> is a container element, and clip-path applies to those (CSS Masking 1); only opacity, filter and display are named as not applying. Chrome ignores it.
  if (walkCtx.compat !== 'chrome') foldDefOwnClips(maskDict);

  walkCtx.clipDefs = clipDict;
  walkCtx.enqueueShape = enqueueShape;
  // The carrier CTM per clip / mask instance, read by finalizeBundle's objectBoundingBox placement.
  walkCtx.clipInstCtm = _clipInstCtm;
  walkCtx.clipInstMembers = _clipInstMembers;
  walkCtx.maskInstCtm = _maskInstCtm;
  // ...and per GROUP FILTER instance, for the same reason: an objectBoundingBox filter region is a fraction of
  // the group's box in the group's own user space (Filter Effects 1 §8 + SVG 1.1 §7.11), and finalizeBundle is
  // where the union of the group's shapes first exists.
  walkCtx.filterInstCtm = _filterInstCtm;
  walkCtx.combineClipRefs = combineClipRefs;
  walkCtx.claimClip = claimClip;
  walkCtx.claimMask = claimMask;
  walkCtx.claimFilter = claimFilter;
  walkCtx.normFilter = normFilter;
  walkCtx.resolveFilterRef = resolveFilterRef;
  /// Will claimFilter(ref) mint a filter (the reference names a filter this renderer draws)? A group opened for a filter that is
  /// never claimed would be an empty offscreen pass.
  walkCtx.filterClaimable = (ref) => {
    const rec = ref ? filtersDict[ref] : null;
    return !!rec && rec.kind !== 'unsupported';
  };
  walkCtx.currentClipRef = currentClipRef;
  walkCtx.currentMaskRef = currentMaskRef;
  walkCtx.currentFilterRef = currentFilterRef;
  walkCtx._shapeElById = _shapeElById;
  // Shape-leaf emission (importWalkShapes.js) needs the paint-server + marker
  // registries too.
  walkCtx.claimGradient = claimGradient;
  // A mask the importer authors itself (a vector-pattern STROKE is the pattern, masked by the stroked outline: importWalkShapes.js).
  // `element` is a <mask> element attached to the document where its content must inherit from; the region is in the referencing
  // element's user space. Returns the id to claim it by.
  let _syntheticMasks = 0;
  walkCtx.addSyntheticMask = (element, region) => {
    const id = `__mantlePatternStroke${++_syntheticMasks}`;
    maskDict[id] = {
      element,
      units: 'userSpaceOnUse',
      maskType: 'alpha',
      region: { oBB: false, stated: true, ...region },
    };
    return id;
  };
  walkCtx.patternTransformSingular = patternTransformSingular;
  walkCtx.gradientDefinition = (svgId) => gradientsDict[svgId] || null;
  walkCtx.claimVectorPattern = claimVectorPattern;
  // A text claims its filter before it lays any glyph out; once the glyph rows exist, the filter entry minted for it boxes its
  // objectBoundingBox primitive units against THEM (the union of every row carrying that filter from `firstRow` on) -- the text's box.
  walkCtx.setFilterBoxRows = (filterId, firstRow) => {
    const e = ctx.filtersUsed[filterId - 1];
    if (!e || !e.obbBox) return;
    const rows = [];
    for (let i = firstRow | 0; i < ctx.shapesData.length; i++)
      if (ctx.shapesData[i].filterId === filterId) rows.push(i);
    if (rows.length) e.obbClaimers = rows;
  };
  /// A text claims its clip and mask once, before it lays out a glyph; once the glyph rows exist, an objectBoundingBox entry binds to all of
  /// them, the text's box, and not to the row that claimed it (bundleFinalize _bindingBb).
  walkCtx.setClaimBoxRows = (clipId, maskId, firstRow) => {
    const bind = (id, field, bindings) => {
      if (!(id > 0) || !(bindings[id - 1] >= 0)) return;
      const rows = [];
      for (let i = firstRow | 0; i < ctx.shapesData.length; i++)
        if (ctx.shapesData[i][field] === id) rows.push(i);
      if (rows.length) (bindings.rows || (bindings.rows = new Map())).set(id - 1, rows);
    };
    bind(clipId, 'clipId', ctx.clipBindings);
    bind(maskId, 'maskId', ctx.maskBindings);
  };
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

  // Inheritance parents: one stack per Document, the elements the walk is inside,
  // outermost first, registered with style.js so every inherited read (fill-rule, caps and joins,
  // paint-order, dashes, marker refs, visibility, color, fonts, custom properties) follows the RENDERED
  // tree: a <use>'s target inherits from the <use>, not from its own ancestors under <defs>.
  const _inhChains = new Map();
  const inheritanceChainOf = (doc) => {
    let c = _inhChains.get(doc);
    if (!c) {
      c = [];
      _inhChains.set(doc, c);
      setInheritanceChain(doc, c);
    }
    return c;
  };
  walkCtx.inheritanceChainOf = inheritanceChainOf;
  /// Walk `kids` of a pattern / clipPath / mask element `defEl`. Their inheritance parents are defEl and
  /// its own ancestors, whatever referenced it (SVG 2 §14.2, §14.3.5, Masking §7.2), so the chain is
  /// swapped for defEl's ancestry for the duration -- without the swap they would inherit from the shape
  /// that is claiming the pattern or clip -- and the carried paint (fill, stroke, stroke-width, fill-
  /// and stroke-opacity) starts from defEl's inherited values. It started from the document defaults,
  /// so a <mask fill="white"> or a <pattern fill-opacity="0.5"> did not reach its content.
  function walkDefContent(defElement, kids, ctm, viewport = walkCtx.viewport) {
    const defEl = defElement._mantleInheritFrom || defElement; // a def the importer built inherits as the authored one it stands for
    const savedViewport = walkCtx.viewport;
    // The content's length context: the viewport it was claimed under, the root size, and the font-size of the
    // def itself (its own ancestors', never the referencing element's).
    let contentViewport =
      viewport === savedViewport ? viewport : carryLengthContext(viewport, savedViewport);
    {
      const fi = domFontSize(defEl);
      if (fi.fontSize !== ((contentViewport && contentViewport.fontSize) || INITIAL_FONT_SIZE)) {
        contentViewport = withFontSize(contentViewport, fi.fontSize, fi.rootFontSize);
      }
    }
    walkCtx.viewport = contentViewport;
    const ch = inheritanceChainOf(defEl.ownerDocument);
    const saved = ch.splice(0);
    for (let cur = defEl; cur && cur.nodeType === 1; cur = cur.parentNode) ch.unshift(cur);
    try {
      const f = getInheritedStyleProp(defEl, 'fill', defaultFill);
      const s = getInheritedStyleProp(defEl, 'stroke', defaultStroke);
      const w = getStrokeWidth(defEl, defaultStrokeW, walkCtx.viewport);
      const fo = parseAlphaOr(getInheritedStyleProp(defEl, 'fill-opacity', null), 1);
      const so = parseAlphaOr(getInheritedStyleProp(defEl, 'stroke-opacity', null), 1);
      for (let i = 0; i < kids.length; i++) walk(kids[i], f, s, w, ctm, fo, so);
    } finally {
      walkCtx.viewport = savedViewport;
      ch.length = 0;
      for (const e of saved) ch.push(e);
    }
  }
  walkCtx.walkDefContent = walkDefContent;
  /// Walk a marker's content (src/svg/marker.js `walked` markers) with `M`, the marker-to-document placement, as its
  /// CTM. The content is a subtree of the main walk, so paints, transforms, <use>, groups, clip, mask and opacity all
  /// apply; it inherits from the <marker> and its ancestors (walkDefContent), and renders as part of the referencing
  /// path: that path's clip and mask stay in force, narrowed by the marker viewport polygon `viewportPoly` (null for
  /// none), while its filter does not reach the content. Markers inside marker content are not placed.
  function walkMarkerContent(marker, M, viewportPoly) {
    const markerEl = marker.el;
    const kids = elementChildren(markerEl);
    if (!kids.length) return;
    const first = ctx.shapesData.length;
    maskStack.push(currentMaskRef());
    clipStack.push(currentClipRef());
    filterStack.push('');
    clipInstStack.push(currentClipInstance());
    maskInstStack.push(currentMaskInstance());
    filterInstStack.push(0);
    filterOwnStack.push(false);
    walkCtx._markerDepth = (walkCtx._markerDepth | 0) + 1;
    walkCtx._useDepth++;
    try {
      if (viewportPoly) narrowCurrentClip(viewportClipRef(markerEl.ownerDocument, viewportPoly));
      walkDefContent(markerEl, kids, M, marker.viewport);
    } finally {
      walkCtx._useDepth--;
      walkCtx._markerDepth--;
      maskStack.pop();
      clipStack.pop();
      filterStack.pop();
      clipInstStack.pop();
      maskInstStack.pop();
      filterInstStack.pop();
      filterOwnStack.pop();
    }
    // `_marker`: part of what the path PAINTS, not of its geometry (bundleFinalize applyMaskRegions).
    for (let i = first; i < ctx.shapesData.length; i++) {
      const sd = ctx.shapesData[i];
      if (sd.kind !== 'groupBegin' && sd.kind !== 'groupEnd') sd._marker = true;
    }
  }
  walkCtx.walkMarkerContent = walkMarkerContent;

  /// The matrix of an element's own transform: its `transform` attribute, or the CSS transform properties
  /// (src/svg/cssTransform.js) when any is authored on it.
  const cssTransformEnv = {
    get viewport() {
      return walkCtx.viewport;
    },
    idMap,
    matrixOf: (n) => elementMatrixOf(n),
  };
  function elementMatrixOf(n) {
    return elementMatrix(
      n,
      parseTransform(n.getAttribute ? n.getAttribute('transform') || '' : ''),
      cssTransformEnv,
    );
  }

  // pfo / pso: the inherited fill-opacity and stroke-opacity, carried like pf / ps / pw.
  function walk(node, pf, ps, pw, pCtm, pfo, pso) {
    const ntag = svgElementName(node);
    if (
      ntag === 'defs' ||
      ntag === 'clippath' ||
      ntag === 'mask' ||
      ntag === 'lineargradient' ||
      ntag === 'radialgradient' ||
      ntag === 'pattern' ||
      ntag === 'symbol' ||
      ntag === 'filter' ||
      ntag === 'marker' ||
      ntag === 'view'
    )
      return;
    // Descriptive and non-graphical elements never render, whatever they hold (SVG 2 5.1, 5.10), and an element of another namespace is not
    // SVG content: what is inside it is not part of the rendered tree. (An SVG root only: a host document's elements lead to its <svg>.)
    if (
      ntag === 'title' ||
      ntag === 'desc' ||
      ntag === 'metadata' ||
      ntag === 'style' ||
      ntag === 'script' ||
      (!ntag && node !== root && svgElementName(root) === 'svg')
    )
      return;
    // display:none subtree skip — same rationale: no enqueueShape can
    // fire below, so don't push the stack.
    const _prevHiddenBits = walkCtx._hiddenBits | 0;
    let _hiddenBitsNow = _prevHiddenBits;
    if (node.getAttribute && !isDisplayed(node)) {
      if (!walkCtx.keepHidden || walkCtx.walkLayerMode || walkCtx.inClipContent > 0) {
        if (!(_prevHiddenBits & 1)) {
          walkCtx.dropCount('displayNoneSubtrees');
          walkCtx.dropCount('displayNoneShapes', countShapeElements(node));
        }
        return;
      }
      _hiddenBitsNow = _prevHiddenBits | 1;
    }
    // Conditional processing (SVG 2 §5.8) holds for every element, not just a <switch> child: an element whose
    // systemLanguage or requiredExtensions test fails is not rendered. (requiredFeatures is gone from SVG 2 and
    // ignored by browsers outside a <switch>.)
    if (
      node.hasAttribute &&
      (node.hasAttribute('systemLanguage') || node.hasAttribute('requiredExtensions')) &&
      !switchChildMatches(node, switchLanguages, false)
    )
      return;
    if (walkCtx.inClipContent > 0 && !clipContentAllows(node, ntag)) return;
    if ((ntag === 'g' || ntag === 'a') && !elementChildren(node).length)
      walkCtx.dropCount('emptyGroups'); // (nothing in it to reveal: reported, never warned about)
    const _nodeId = (node.getAttribute && node.getAttribute('id')) || '';
    if (idStack.length === 1) {
      if (_nodeId && _spriteIdsSeen.has(_nodeId)) {
        _spriteTop = '';
        if (!_spriteDupWarned.has(_nodeId)) {
          _spriteDupWarned.add(_nodeId);
          mantleWarn(
            'importSvg: top-level id "' +
              _nodeId +
              '" is used by more than one element; the first is the sprite "' +
              _nodeId +
              '", the later ones are not addressable as sprites',
          );
        }
      } else {
        _spriteTop = _nodeId;
        if (_nodeId) _spriteIdsSeen.add(_nodeId);
      }
      // opts.sprites: a top-level element the list does not name is not walked at all, so it claims no clip, mask, filter or pattern and
      // opens no group. (Depth 1 of the clip and mask drain is not a top-level element.)
      if (_spriteAllow && !opts._spriteId && !walkCtx._finalizing && !_spriteAllow.has(_spriteTop))
        return;
    }
    idStack.push(_nodeId);
    groupStack.push(
      _nodeId
        ? groupNode(groupStack.length ? groupStack[groupStack.length - 1] : null, _nodeId)
        : groupStack.length
          ? groupStack[groupStack.length - 1]
          : null,
    );
    const _inh = inheritanceChainOf(node.ownerDocument);
    _inh.push(node);
    const _prevHiddenLeaf = walkCtx._hiddenLeaf;
    if (walkCtx.hitPass && LEAF_PAINT_TAGS[ntag] && !isEffectivelyVisible(node))
      walkCtx._hiddenLeaf = true;
    // Track the element being walked so enqueueShape can stamp _domLeaf.
    // Saved/restored (not just cleared) so a parent group's trailing
    // records after child recursion still see the right element.
    const _prevViewport = walkCtx.viewport;
    const _prevEl = walkCtx._curEl;
    walkCtx._curEl = node;
    const previousHitPart = hitOwnerNodes ? walkCtx._hitOwnerPart || 0 : 0;
    if (hitOwnerNodes) walkCtx._hitOwnerPart = 0;
    // The element's computed font-size, for the em / ex / ch lengths of its own attributes and of what it contains.
    {
      const vp = walkCtx.viewport,
        parentFs = (vp && vp.fontSize) || INITIAL_FONT_SIZE;
      const fs = resolveFontSize(node, parentFs, walkCtx.rootFontSize);
      if (fs !== parentFs) walkCtx.viewport = withFontSize(vp, fs, walkCtx.rootFontSize);
    }
    // Push this element's own `mask` / `clip-path` if it has one; else
    // re-push the inherited value so descendants see a consistent
    // top-of-stack. Read from both the `style` attr AND direct attrs
    // (SVG accepts both forms). Empty string = no constraint.
    // `mask` does not inherit: `none` says this element has none of its own, and an ancestor's mask still applies to it (the stack carries
    // that mask down to the leaves of a group that opened no offscreen pass).
    const _ownMaskValue = ownMaskOf(node);
    const _ownMask = /^none$/i.test(_ownMaskValue.trim()) ? '' : _ownMaskValue;
    const _ownClip = node.getAttribute
      ? normClip(getStyleProp(node, 'clip-path', '') || node.getAttribute('clip-path') || '', node)
      : '';
    const _ownFilter = node.getAttribute
      ? normFilter(getStyleProp(node, 'filter', '') || node.getAttribute('filter') || '', node)
      : '';
    maskStack.push(_ownMask || currentMaskRef());
    // Own clip INTERSECTS the inherited one (SVG 1.1 §14.3) — see
    // combineClipRefs. mask/filter keep replace-semantics.
    const _ownClipInst = _ownClip ? nextInstance('Clip') : currentClipInstance();
    clipStack.push(
      combineClipRefs(_ownClip, currentClipRef(), _ownClipInst, currentClipInstance()),
    );
    filterStack.push(_ownFilter || currentFilterRef());
    clipInstStack.push(_ownClipInst);
    // (An objectBoundingBox clip too: once it meets another clip its box is needed again, see combineClipRefs.)
    const _ownBasic = !!(
      _ownClip &&
      (() => {
        const d = clipDict[resolveIdRef(_ownClip)];
        return d && (d.basicShape || d.units === 'objectBoundingBox');
      })()
    );
    if (_ownBasic) basicInstStack.push(_ownClipInst);
    maskInstStack.push(_ownMask ? nextInstance('Mask') : currentMaskInstance());
    filterInstStack.push(_ownFilter ? nextInstance('Filter') : currentFilterInstance());
    filterOwnStack.push(!!_ownFilter);
    if (_ownFilter)
      _filterInstPaints.set(currentFilterInstance(), {
        fill: ownerPaint(node, 'fill', pf || 'black'),
        stroke: ownerPaint(node, 'stroke', ps || 'none'),
      });
    walkCtx._hiddenBits = _hiddenBitsNow;
    try {
      _walkInner(node, pf, ps, pw, pCtm, pfo, pso, _ownClip, _ownMask);
    } finally {
      walkCtx._hiddenBits = _prevHiddenBits;
      walkCtx.viewport = _prevViewport;
      walkCtx._curEl = _prevEl;
      if (hitOwnerNodes) walkCtx._hitOwnerPart = previousHitPart;
      walkCtx._hiddenLeaf = _prevHiddenLeaf;
      _inh.pop();
      idStack.pop();
      groupStack.pop();
      maskStack.pop();
      clipStack.pop();
      filterStack.pop();
      clipInstStack.pop();
      if (_ownBasic) basicInstStack.pop();
      maskInstStack.pop();
      filterInstStack.pop();
      filterOwnStack.pop();
    }
  }

  function _walkInner(node, pf, ps, pw, pCtm, pfo, pso, ownClip, ownMask) {
    const ntag = svgElementName(node);

    if (walkCtx.inClipContent > 0 && ntag === 'image') return;
    if (LEAF_PAINT_TAGS[ntag] && !isEffectivelyVisible(node)) {
      // A hidden leaf draws nothing; the second pass (hit-only shapes) walks it when pointer-events can still target it.
      if (!walkCtx.hitPass) {
        const pe = getPointerEvents(node);
        if (
          pe === 'painted' ||
          pe === 'fill' ||
          pe === 'stroke' ||
          pe === 'all' ||
          pe === 'bounding-box'
        )
          ctx._hitHiddenCandidate = true;
        // visibility inherits and a descendant can set it back: a hidden <text> with visible content goes on, and the text handler sorts its glyphs.
        if (!(ntag === 'text' && textHasVisibleContent(node))) {
          // keepHidden: the leaf keeps its rows, flagged hidden (its pointer-events region while hidden still rides the hit-only table).
          if (!walkCtx.keepHidden || walkCtx.walkLayerMode || walkCtx.inClipContent > 0) {
            walkCtx.dropCount('hiddenVisibilityLeaves');
            return;
          }
          walkCtx._hiddenBits |= 2;
        }
      }
    }
    // <use href="#id" x=".." y=".."> instantiates a referenced shape with an
    // optional translation. Resolve via idMap and walk the referenced node
    // with the use's transform + (x,y) translation composed onto the CTM,
    // and the use's inherited style passed down. <symbol> targets are
    // handled by walking their direct children (the symbol element itself
    // doesn't render).
    if (ntag === 'use') {
      const vpX = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'x' } : undefined;
      const vpY = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'y' } : undefined;

      const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      const refId = resolveIdRef(href);
      if (!refId || !idMap[refId]) return;
      // A <use> that reaches itself through its target's subtree is a
      // reference cycle (spec error); browsers break the cycle — recursing
      // would overflow the stack.
      const active = walkCtx._useActive || (walkCtx._useActive = new Set());
      if (active.has(refId)) return;
      const target = idMap[refId];
      if (walkCtx.inClipContent > 0 && CLIP_CONTENT_LEAVES[svgElementName(target)] !== 1) return;
      const localTm2 = elementMatrixOf(node);
      const x = parseLengthOr(node.getAttribute('x') || '0', 0, vpX);
      const y = parseLengthOr(node.getAttribute('y') || '0', 0, vpY);
      const useTm = matMul(localTm2, [1, 0, 0, 1, x, y]);
      const ctm2 = matMul(pCtm, useTm);
      // A filter on the <use> itself works in the <use>'s user space, its transform and translate(x, y) included: the CTM that every leaf of the
      // instance (which claims the filter as inherited) takes its region and its lengths from. This branch returns before the generic
      // record of the carrier's CTM below.
      if (filterOwnStack.length > 0 && filterOwnStack[filterOwnStack.length - 1]) {
        const _fi = currentFilterInstance();
        if (_fi > 0 && !_filterInstCtm.has(_fi)) _filterInstCtm.set(_fi, ctm2);
      }
      // The <use>'s own clip-path / mask are in its user space, translate(x, y) included (the generated <g> carries
      // it, SVG 1.1 §5.6).
      placeOwnClipMask(node, ownClip, ownMask, ctm2);
      // ...and it is the CARRIER for an objectBoundingBox reference: this branch returns before the generic
      // record below, so a <use> whose clip is bbox-bound would otherwise have no carrier CTM at all.
      recordObbCarrier(ownClip, ownMask, ctm2);
      // <use> can override fill/stroke/etc; resolve with use's own attrs as
      // parents so children can still override via direct attrs.
      const f2 = getPaintProp(node, 'fill', pf);
      const s2 = getPaintProp(node, 'stroke', ps);
      const w2 = getStrokeWidth(node, pw, walkCtx.viewport, false);
      // ...and fill-opacity / stroke-opacity, which the target's DOM ancestors (in <defs>) cannot supply.
      const { fo: fo2, so: so2 } = inheritedChannelOpacities(node, pfo, pso);
      // For <symbol> targets, walk their children. For other targets, walk
      // the target itself (it'll emit if it's a shape, or recurse if it's a
      // group).
      const targetTag = svgElementName(target);
      // Shapes emitted from a <use> expansion have no source element of
      // their own (the DOM leaf is the <use>) — flag so enqueueShape stamps
      // _domLeaf -1 instead of claiming the referenced element's ordinal.
      // The <use> composes its instance as ONE GROUP under its own opacity, mix-blend-mode and isolation
      // (CSS Compositing 1 §3; SVG 1.1 §14.5), in addition to the referenced element's own, as for <g>.
      const useComp = groupCompositingOf(node);
      const useGroup =
        useComp.opacity < 1 - 1e-6 || useComp.blendMode !== 0 || useComp.isolation === 1;
      // ...and under its own mask, applied to that composite once (as for <g>; the clip stays per leaf).
      const useMaskRef =
        ownMask &&
        !walkCtx.walkLayerMode &&
        !(walkCtx.inClipContent > 0) &&
        maskNeedsGroup(target, { f: f2, s: s2 }) &&
        (!maskIsBinary(maskDict[resolveIdRef(currentMaskRef())]) ||
          hasOwnMask(target) ||
          ownsMaskBelow(target))
          ? resolveIdRef(currentMaskRef())
          : '';
      // ...and under its own FILTER, which processes the complete instance as one SourceGraphic (Filter Effects 1 §3), as for <g>:
      // the group row owns the filter, the clip and the mask and the leaves render plain. Handed to each leaf instead, every leaf
      // of the instance would be filtered by itself and the results composited.
      const useFilterRef0 =
        filterOwnStack.length > 0 &&
        filterOwnStack[filterOwnStack.length - 1] &&
        !walkCtx.walkLayerMode &&
        !(walkCtx.inClipContent > 0)
          ? resolveFilterRef(currentFilterRef(), node)
          : '';
      const useFilterRef =
        useFilterRef0 && walkCtx.filterClaimable(useFilterRef0) ? useFilterRef0 : '';
      let useMaskGroup = null,
        useFilterGroup = null;
      if (useFilterRef) {
        const useIndex = ctx.shapesData.length;
        const filterId = claimFilter(useFilterRef, {
          own: true,
          container: true,
          ctm: ctm2,
          shapeIdx: useIndex,
        });
        enqueueShape({
          kind: 'groupBegin',
          groupOpacity: useComp.opacity,
          filterId,
          clipId: filterId ? claimClip(resolveIdRef(currentClipRef()), useIndex) : 0,
          maskId: filterId ? claimMask(resolveIdRef(currentMaskRef()), useIndex) : 0,
          blendMode: useComp.blendMode,
          isolation: useComp.isolation,
          _domLeaf: -1,
        });
        if (filterId) {
          useFilterGroup = ctx.shapesData[useIndex];
          filterStack[filterStack.length - 1] = '';
          clipStack[clipStack.length - 1] = '';
          maskStack[maskStack.length - 1] = '';
        }
      } else if (useGroup || (useMaskRef && maskDict[useMaskRef])) {
        const useIndex = ctx.shapesData.length;
        enqueueShape({
          kind: 'groupBegin',
          groupOpacity: useComp.opacity,
          filterId: 0,
          clipId: 0,
          maskId: useMaskRef && maskDict[useMaskRef] ? claimMask(useMaskRef, useIndex) : 0,
          blendMode: useComp.blendMode,
          isolation: useComp.isolation,
          _domLeaf: -1,
        });
        if (ctx.shapesData[useIndex].maskId > 0) {
          useMaskGroup = ctx.shapesData[useIndex];
          maskStack[maskStack.length - 1] = '';
        }
      }
      const useOpen = useGroup || !!useMaskGroup || !!useFilterRef;
      // The expansion budget: each <use> instance is a copy of its target's subtree, and uses nest (a doubling chain of 16 levels is
      // 65,536 copies; 30 levels never finishes), so the document is refused LOUDLY before the time and memory blow up.
      if (++walkCtx._useInstances > walkCtx.maxUseInstances)
        throw new Error(
          `svgImporter: the document expands more than ${walkCtx.maxUseInstances} <use> instances (importSvg option maxUseInstances) — not imported`,
        );
      // The parent occurrence distinguishes repeated and nested use expansions.
      const previousHitUse = walkCtx._hitUseOwner || 0;
      if (hitOwnerNodes && hitOwnerNodes.has(node))
        walkCtx._hitUseOwner = opts._hitOwnerSession.owner(previousHitUse, hitOwnerNodes.get(node));
      walkCtx._useDepth++;
      active.add(refId);
      // The <use> is the CONTEXT ELEMENT of its instance: context-fill / context-stroke in the content take its paints
      // (SVG 2 §13.2.3), itself resolved against an outer context when it names one.
      const outerContext = walkCtx.contextPaint;
      const contextOf = (v) => {
        const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
        return t === 'context-fill'
          ? (outerContext?.fill ?? 'none')
          : t === 'context-stroke'
            ? (outerContext?.stroke ?? 'none')
            : v;
      };
      walkCtx.contextPaint = { fill: contextOf(f2), stroke: contextOf(s2) };
      try {
        if (targetTag === 'symbol') {
          if (viewBoxDisablesRendering(target)) return;
          // SVG 2 §5.9.3: <use> instantiates the symbol as an <svg> with
          // the use's width/height and the symbol's viewBox/PAR. Omitted
          // extents use the current viewport dimensions when known.
          const authoredW = parseLengthOr(node.getAttribute('width'), NaN, vpX);
          const authoredH = parseLengthOr(node.getAttribute('height'), NaN, vpY);
          if (walkCtx.viewport && (authoredW <= 0 || authoredH <= 0)) return;
          const uw = Number.isFinite(authoredW) ? authoredW : walkCtx.viewport?.parentWidth || 0;
          const uh = Number.isFinite(authoredH) ? authoredH : walkCtx.viewport?.parentHeight || 0;
          const sized = uw > 0 && uh > 0;
          const ctm3 = sized ? matMul(ctm2, viewportFitMatrix(target, 0, 0, uw, uh)) : ctm2;
          // The instantiated symbol is a viewport of the use's width/height at the use's origin, and it clips the same
          // way a nested <svg> does.
          if (sized && viewportClips(target)) {
            narrowCurrentClip(
              viewportClipRef(
                node.ownerDocument,
                [
                  [0, 0],
                  [uw, 0],
                  [uw, uh],
                  [0, uh],
                ].map(([px, py]) => matApply(ctm2, px, py)),
              ),
            );
          }
          // The instantiated symbol is an element of the rendered tree between the <use> and the
          // symbol's children, so ITS properties reach them too (they inherit from it).
          if (sized) walkCtx.viewport = localViewport(target, uw, uh, walkCtx.viewport);
          // ...including its font-size, which the em lengths of its children are of
          {
            const vp = walkCtx.viewport,
              parentFs = (vp && vp.fontSize) || INITIAL_FONT_SIZE;
            const symbolFs = resolveFontSize(target, parentFs, walkCtx.rootFontSize);
            if (symbolFs !== parentFs)
              walkCtx.viewport = withFontSize(vp, symbolFs, walkCtx.rootFontSize);
          }
          const fS = getPaintProp(target, 'fill', f2),
            sS = getPaintProp(target, 'stroke', s2);
          const wS = getStrokeWidth(target, w2, walkCtx.viewport);
          const { fo: foS, so: soS } = inheritedChannelOpacities(target, fo2, so2);
          const _symCh = inheritanceChainOf(target.ownerDocument);
          _symCh.push(target);
          try {
            const tk = elementChildren(target);
            for (let i = 0; i < tk.length; i++) walk(tk[i], fS, sS, wS, ctm3, foS, soS);
          } finally {
            _symCh.pop();
          }
        } else {
          // SVG 2 §5.6: a <use> of an <svg> overrides that svg's width and height with its own.
          let overridden = false;
          if (targetTag === 'svg') {
            const ow = parseLengthOr(node.getAttribute('width'), NaN, vpX);
            const oh = parseLengthOr(node.getAttribute('height'), NaN, vpY);
            if (Number.isFinite(ow) || Number.isFinite(oh)) {
              (walkCtx._svgSizeOverride || (walkCtx._svgSizeOverride = new Map())).set(target, {
                w: ow,
                h: oh,
              });
              overridden = true;
            }
          }
          try {
            walk(target, f2, s2, w2, ctm2, fo2, so2);
          } finally {
            if (overridden) walkCtx._svgSizeOverride.delete(target);
          }
        }
      } finally {
        active.delete(refId);
        walkCtx._useDepth--;
        if (hitOwnerNodes) walkCtx._hitUseOwner = previousHitUse;
        walkCtx.contextPaint = outerContext;
        if (useMaskGroup) collectGroupGeometry(useMaskGroup);
        if (useFilterGroup) {
          const members = collectGroupGeometry(useFilterGroup);
          (ctx.filterInstShapes || (ctx.filterInstShapes = new Map())).set(
            currentFilterInstance(),
            members,
          );
        }
        if (useOpen) enqueueShape({ kind: 'groupEnd' });
      }
      return;
    }
    let localTm = elementMatrixOf(node);
    // Nested <svg> introduces its own viewport: x/y offset the inner box on
    // the parent canvas, and viewBox + preserveAspectRatio define an inner
    // coordinate system that is fit into [0..width] × [0..height]. The root
    // <svg> is handled separately at bundle-finalize, so this branch only
    // fires for non-root <svg> elements. SVG 1.1 §7.2 + §7.8.
    let ownPlaced = false;
    if (ntag === 'svg' && node !== root) {
      const vpX = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'x' } : undefined;
      const vpY = walkCtx.viewport ? { ...walkCtx.viewport, axis: 'y' } : undefined;

      const sx = parseLengthOr(node.getAttribute('x') || '0', 0, vpX);
      const sy = parseLengthOr(node.getAttribute('y') || '0', 0, vpY);
      let authoredW = parseLengthOr(node.getAttribute('width'), NaN, vpX);
      let authoredH = parseLengthOr(node.getAttribute('height'), NaN, vpY);
      const sizeOverride = walkCtx._svgSizeOverride && walkCtx._svgSizeOverride.get(node);
      if (sizeOverride) {
        if (Number.isFinite(sizeOverride.w)) authoredW = sizeOverride.w;
        if (Number.isFinite(sizeOverride.h)) authoredH = sizeOverride.h;
      }
      if (
        (walkCtx.viewport && (authoredW <= 0 || authoredH <= 0)) ||
        viewBoxDisablesRendering(node)
      )
        return;
      const sw_ = Number.isFinite(authoredW) ? authoredW : walkCtx.viewport?.parentWidth || 0;
      const sh_ = Number.isFinite(authoredH) ? authoredH : walkCtx.viewport?.parentHeight || 0;
      const fit = viewportFitMatrix(node, sx, sy, sw_, sh_);
      if (sw_ > 0 && sh_ > 0) walkCtx.viewport = localViewport(node, sw_, sh_, walkCtx.viewport);
      // Before the viewport clip narrows the stack, so the intersection is built in the same order as at the identity.
      placeOwnClipMask(node, ownClip, ownMask, matMul(pCtm, matMul(localTm, fit)));
      ownPlaced = true;
      // The viewport rect is written in the space OUTSIDE the fit, so map it through the CTM before the fit is applied.
      if (sw_ > 0 && sh_ > 0 && viewportClips(node)) {
        const outer = matMul(pCtm, localTm);
        narrowCurrentClip(
          viewportClipRef(
            node.ownerDocument,
            [
              [sx, sy],
              [sx + sw_, sy],
              [sx + sw_, sy + sh_],
              [sx, sy + sh_],
            ].map(([px, py]) => matApply(outer, px, py)),
          ),
        );
      }
      localTm = matMul(localTm, fit);
    }
    const ctm = matMul(pCtm, localTm);
    if (!ownPlaced) placeOwnClipMask(node, ownClip, ownMask, ctm);
    // The CTM of the element that CARRIES the filter. A userSpaceOnUse region is in the referencing element's
    // user space (Filter Effects 1 §7.1), and a descendant's claim knows only its own, so record it here where
    // the group's CTM exists and the children have not been walked yet.
    if (filterOwnStack.length > 0 && filterOwnStack[filterOwnStack.length - 1]) {
      const _fi = currentFilterInstance();
      if (_fi > 0 && !_filterInstCtm.has(_fi)) _filterInstCtm.set(_fi, ctm);
    }
    // ...and the CTM of the element that CARRIES a clip-path or mask, for the same reason (see recordObbCarrier).
    recordObbCarrier(ownClip, ownMask, ctm);
    const f = getPaintProp(node, 'fill', pf);
    const s = getPaintProp(node, 'stroke', ps);
    const w = getStrokeWidth(node, pw, walkCtx.viewport, ntag === 'svg' && node !== root);
    const { fo, so } = inheritedChannelOpacities(node, pfo, pso);
    // Emit shapes.
    const tag = ntag;
    if (handleImageTag(walkCtx, node, tag, ctm, f, s, w, fo, so)) return;
    if (handleTextPaintTag(walkCtx, node, tag, ctm, pf, ps, pw, f, s, w, fo, so)) return;
    if (handleShapePaintTag(walkCtx, node, tag, ctm, f, s, w, fo, so)) return;
    // Group flatten: if this element introduces a compositing group
    // (isolation:isolate, non-normal mix-blend-mode, or opacity < 1
    // applied to a container), wrap the children in a groupBegin /
    // groupEnd pair. Per CSS Compositing & Blending §6 such a group's
    // descendants composite among themselves first, then the result
    // composites onto the parent backdrop using the group's blend
    // mode + opacity. The renderer interprets groupBegin/End to route
    // children through an offscreen FBO.
    let needsGroupFlatten = false;
    let gOpacity = 1,
      gBlendMode = 0,
      gIsolation = 0;
    // Element-child list computed once; both the group-flatten count test
    // and the recursion loop below reuse it (elementChildren allocates a
    // fresh array + scans every childNode).
    const kids = elementChildren(node);
    // <a href>: stash the href on the anchor stack so any shape
    // emitted within this subtree records the URL for hit-test
    // consumption. xlink:href fallback per SVG 1.1.
    let pushedAnchor = false;
    // Links inside an SVG IMAGE are inert, as in a browser: the image is a picture, and only an <a>
    // around the <image> in the referencing document makes it a link.
    if (tag === 'a' && !(walkCtx._imageDocDepth > 0)) {
      const ah = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (ah) {
        anchorHrefStack.push(ah);
        pushedAnchor = true;
      }
    }
    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      ({
        opacity: gOpacity,
        blendMode: gBlendMode,
        isolation: gIsolation,
      } = groupCompositingOf(node));
      // Need flatten whenever any compositing-changing attribute applies.
      // A single-child group is NOT equivalent to pushing the attrs onto
      // the leaf: the child may itself be a container, blend modes always
      // need the group backdrop, and group opacity applies to the
      // composited result (≠ scaling fill and stroke separately where
      // they overlap). Nothing else applies these attrs, so gating on
      // child count silently dropped them.
      needsGroupFlatten =
        (gOpacity < 1 - 1e-6 || gBlendMode !== 0 || gIsolation === 1) &&
        kids.length > 0 &&
        // A <switch> with no child to select renders nothing and has no group to open.
        (tag !== 'switch' || kids.some((k) => switchChildMatches(k, switchLanguages)));
    }

    // A container filter processes the complete child composite. Descendants
    // keep their own filters rather than inheriting or replacing this program.
    // (A reference to no filter, or to one this renderer does not draw, is no filter: it opens no group.)
    const containerFilterRef =
      (tag === 'g' || tag === 'svg' || tag === 'a') && filterOwnStack.at(-1)
        ? resolveFilterRef(currentFilterRef(), node)
        : '';
    const containerFilter =
      containerFilterRef && walkCtx.filterClaimable(containerFilterRef) ? containerFilterRef : '';
    let filterGroup = null,
      maskGroup = null;
    if (containerFilter) needsGroupFlatten = true;
    // A MASK ON A CONTAINER applies to the composited group, once (Masking 1 §7: the element and its descendants render
    // into a group first, then the mask multiplies that result), like its filter, clip and opacity. Handed to each leaf
    // instead, two overlapping kids showed through each other. The group row carries the mask and the stack entry is
    // cleared so the leaves do not apply it again. Mask and clip content keep the per-leaf mask: a layer group's mask
    // is not baked as a group (maskBake.js), and a mask nested in a mask is the inner-mask pass.
    if (
      !containerFilter &&
      ownMask &&
      kids.length > 0 &&
      (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') &&
      !walkCtx.walkLayerMode &&
      !(walkCtx.inClipContent > 0) &&
      (tag !== 'switch' || kids.some((k) => switchChildMatches(k, switchLanguages)))
    ) {
      const mid = resolveIdRef(currentMaskRef());
      if (
        mid &&
        maskDict[mid] &&
        (node._mantleMaskGroup === true ||
          ((!maskIsBinary(maskDict[mid]) || ownsMaskBelow(node)) && maskNeedsGroup(node)))
      ) {
        needsGroupFlatten = true;
        maskGroup = true;
      }
    }
    if (needsGroupFlatten) {
      const groupIndex = ctx.shapesData.length;
      const filterId = containerFilter
        ? claimFilter(containerFilter, { own: true, container: true, ctm, shapeIdx: groupIndex })
        : 0;
      enqueueShape({
        kind: 'groupBegin',
        groupOpacity: gOpacity,
        filterId,
        clipId: filterId ? claimClip(resolveIdRef(currentClipRef()), groupIndex) : 0,
        maskId: filterId || maskGroup ? claimMask(resolveIdRef(currentMaskRef()), groupIndex) : 0,
        blendMode: gBlendMode,
        isolation: gIsolation,
      });
      if (filterId) {
        filterGroup = ctx.shapesData[groupIndex];
        // The group marker owns the filter; leaves render SourceGraphic.
        filterStack[filterStack.length - 1] = '';
        clipStack[clipStack.length - 1] = '';
        maskStack[maskStack.length - 1] = '';
      } else if (maskGroup && ctx.shapesData[groupIndex].maskId > 0) {
        // The clip stays per leaf (a clip is a coverage test, not a blend); only the mask moves to the group.
        maskGroup = ctx.shapesData[groupIndex];
        maskStack[maskStack.length - 1] = '';
      } else maskGroup = null;
    }
    if (tag === 'switch') {
      // Conditional processing: render the FIRST child whose
      // requiredFeatures / requiredExtensions / systemLanguage tests
      // all pass; skip the rest.
      for (let i = 0; i < kids.length; i++) {
        if (switchChildMatches(kids[i], switchLanguages)) {
          walk(kids[i], f, s, w, ctm, fo, so);
          break;
        }
      }
    } else {
      for (let i = 0; i < kids.length; i++) walk(kids[i], f, s, w, ctm, fo, so);
    }
    if (needsGroupFlatten) {
      const effectGroup = filterGroup || maskGroup;
      if (effectGroup) {
        const members = collectGroupGeometry(effectGroup);
        if (filterGroup)
          (ctx.filterInstShapes || (ctx.filterInstShapes = new Map())).set(
            currentFilterInstance(),
            members,
          );
      }
      enqueueShape({ kind: 'groupEnd' });
    }
    if (pushedAnchor) anchorHrefStack.pop();
  }

  walkCtx.walk = walk;
  walkCtx.groupCompositingOf = groupCompositingOf;
  walkCtx.viewportClipRef = viewportClipRef;
  walkCtx.nestClipDef = nestClipDef;
  walkCtx.narrowCurrentClip = narrowCurrentClip;
  // The bundle ORIGIN (svg/importer.js originFor): the root CTM translates by -origin, in float64, so every coordinate the walk
  // emits (segments, gradients, patterns, regions, text) is relative to it before the float32 store. IDENT when there is none.
  const originXY = opts._origin;
  if (!viewBoxDisablesRendering(root))
    walk(
      root,
      defaultFill,
      defaultStroke,
      defaultStrokeW,
      originXY && (originXY[0] !== 0 || originXY[1] !== 0)
        ? [1, 0, 0, 1, -originXY[0], -originXY[1]]
        : IDENT,
      1,
      1,
    );

  return { walk, walkCtx };
}
