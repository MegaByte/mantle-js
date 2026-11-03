// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importer.js — browser-side SVG → Mantle bundle encoder.
//
// importSvg returns an in-memory bundle struct directly (typed-array
// section views: curves, bands, meta, curveGeom, gradients,
// gradientStops, dashes, strokeMesh, clipMesh, maskMesh, filterTab,
// imageAtlas). the runtime consumes the struct verbatim — no
// pack→parse round-trip.
//
// Uses DOMParser for parsing; outputs ArrayBuffer-backed views for
// each section.
//
// Exports default: importSvg(svgText, opts) → bundle struct.
//
// opts:
//   defaultFill       : string  (default 'black')
//   defaultStroke     : string  (default 'transparent')
//   defaultStrokeW    : number  (default 1, per SVG spec § Stroke Properties)
// Bundle-level flag bits. The flag bits below are exposed for
// consumers that peek bundle.flags; readers may also ignore them.

// Renderable leaf tags (visibility-cascade gate). Hoisted to module scope so
// the per-node walker doesn't rebuild this object on every element visited.
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
};

// CSS/SVG mix-blend-mode name → enum. Two variants: SHAPE includes the
// extras (alpha 20 / erase 21); GROUP intentionally omits them.
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
  // ALPHA (20) / ERASE (21) — no SVG syntax; supplied via a CSS custom
  // name. Renderer handles 20/21 in the composite shader directly.
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

import { withPreparation } from '../core/preparation.js';
import {
  finalizeBundle,
  BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM,
  BUNDLE_FLAG_HYBRID_MESH_CHUNKED,
  BUNDLE_FLAG_WIDE_BAND_HEADERS,
  TEXTURE_WIDTH,
  META_FLOATS_V3,
  COVER_QUAD_STRIDE,
} from './bundleFinalize.js';
import {
  elementChildren,
  switchChildMatches,
  resolveIdRef,
  elementDepthExceeds,
  MAX_ELEMENT_DEPTH,
} from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseLength, parseLengthOr } from './length.js';
import { parsePatternDef } from './pattern.js';
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
  JOIN_ARCS,
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
} from './segment.js';
import { tokenizePath, parsePathD } from './path.js';
import {
  IDENT,
  matMul,
  matApply,
  parseTransform,
  transformSegInto,
  transformArcNative,
} from './transform.js';
import { parseShape } from './shape.js';
import { CSS_NAMED_COLORS, hslToRgb, parseColor, setColorCompat } from './color.js';
import {
  parseStyleString,
  getParsedStyle,
  getStyleProp,
  getInheritedStyleProp,
  resolveCurrentColor,
  setInitialColor,
  getShapeStyles,
  isDisplayed,
  isPaintable,
  isEffectivelyVisible,
  getCapsJoins,
  getFillRule,
} from './style.js';
import {
  buildStylesheet,
  buildStylesheetAsync,
  setActiveStylesheet,
  clearActiveStylesheet,
} from './stylesheet.js';
import {
  GRAD_LINEAR,
  GRAD_RADIAL,
  GRAD_PAD,
  GRAD_REFLECT,
  GRAD_REPEAT,
  GRAD_SPREAD_ENUM,
  GRAD_UNITS_USER,
  GRAD_UNITS_BBOX,
  GRADIENT_FLOATS,
  parseGradientStops,
  parseGradients,
  packGradientStops,
  buildGradientTables,
} from './gradient.js';
import { parseFilters } from './filter.js';
import { instantiateMarker, parseMarkers } from './marker.js';
import { parseClipsAndMasks } from './clipMask.js';
import {
  segCtrlBbox,
  segCtrlBboxInto,
  segBbox,
  segBboxInto,
  arcTightBbox,
  curveTightBboxQuad,
  curveTightBboxQuadInto,
  curveTightBboxCubic,
  curveTightBboxCubicInto,
  pathBbox,
  splitSubpathsWithCloseInto,
  polygonSignedArea,
} from './bbox.js';
import { getCoverQuadMesh } from './mesh.js';
import {
  makeTexelBuffer,
  texelEnsure,
  texelAppend,
  texelSet,
  texelXYOf,
  texelToBytes,
  segArcLen,
  encodeSeg,
  segTangentAt,
  segTangentAtInto,
  buildPathArcLengthLut,
  samplePathAt,
  buildTexturesShape,
} from './textures.js';
import { packMetaBody } from './meta.js';
import { buildOccupancyGrid } from './occupancy.js';
import { decodeImageHref, preloadImages, downscaleRgba8 } from './image.js';
import { makeBuildContext, pickBandsXY, emitShape } from './buildContext.js';
import { unionPaths } from './pathBoolean/union.js';
import { runImportWalk } from './importWalk.js';
import { buildFilterSections } from './importFilters.js';
import { HIT_FILL, HIT_STROKE, HIT_BBOX, hitOnlyNeeds, keepInvisibleOf } from './hitBits.js';
import { mergeNode, compactTree } from './hitGroups.js';
import { droppedReportOf, warnDropped } from './dropped.js';
/**
 * Parse SVG markup into a bundle struct.
 *
 * Throws a TypeError unless `svgText` is a non-empty string. A document with no ink (every shape dropped or culled) returns
 * `numShapes: 0` and `globalBBox: [0, 0, 0, 0]`.
 *
 * A fill or stroke whose alpha is 0 (`fill="transparent"`, `fill-opacity="0"`, `stroke-opacity="0"`, `opacity="0"`) keeps its drawn row at
 * alpha 0, so a morph pairs it, an override finds it and a hit test targets it (`keepInvisibleShapes`, on by default; `false` is the
 * optimizing mode that drops it, `'all'` also keeps a fill of `none`). A `visibility:hidden` leaf draws nothing and gets no row;
 * `display="none"` shapes are dropped outright. What the pointer can target is resolved separately (SVG 2 `pointer-events`,
 * src/svg/hitBits.js): a region the pointer can still target but no row draws goes to the bundle's HIT-only side table (`hitOnly`), which a
 * second import pass builds and only the hit queries read.
 *
 * @param {string} svgText  non-empty SVG markup
 * @param {{ keepInvisibleShapes?: boolean | 'all', [option: string]: any }} [opts]  see the README for the full option list
 */
export async function importSvg(svgText, opts = {}) {
  return withPreparation('importSvg', null, () => importSvgImpl(svgText, opts));
}

async function importSvgImpl(svgText, opts = {}) {
  // Share integer source occurrences across independently parsed passes, including use instances.
  if (opts.keepHidden && !opts.ctx && !opts._hitOwnerSession) {
    let next = 1;
    const owners = new Map(),
      parts = new Map();
    const intern = (map, parent, key) => {
      let children = map.get(parent);
      if (!children) map.set(parent, (children = new Map()));
      if (!children.has(key)) children.set(key, next++);
      return children.get(key);
    };
    opts = {
      ...opts,
      _hitOwnerSession: {
        owner: (parent, node) => intern(owners, parent, node),
        part: (owner, index) => intern(parts, owner, index),
      },
    };
  }
  // The bundle ORIGIN. `opts.origin` is a [x, y] pair (every coordinate is stored relative to it, in float64 before the float32
  // store; see bundle/layout.js), `false` (store absolute coordinates, as before), or unset: the importer then picks one only when
  // the art lies far from the document origin compared to its own size (originFor), by importing once, reading the box, and
  // importing again relative to its center. A bundle near the origin is not touched: same bytes as before. `retainSource` (the
  // native SVG fallback draws the retained markup in document coordinates) keeps absolute coordinates.
  let sections;
  if (Array.isArray(opts.origin)) {
    const o = [Number(opts.origin[0]), Number(opts.origin[1])];
    if (!(Number.isFinite(o[0]) && Number.isFinite(o[1])))
      throw new TypeError(
        'importSvg: opts.origin must be a [x, y] pair of finite numbers, got ' +
          JSON.stringify(opts.origin),
      );
    if (opts.retainSource)
      throw new TypeError(
        'importSvg: opts.origin cannot be combined with retainSource: the retained markup is in document coordinates, which the native SVG fallback draws as they are',
      );
    opts = { ...opts, _origin: o };
    sections = await importSvgOnce(svgText, opts);
  } else {
    sections = await importSvgOnce(svgText, opts);
    if (
      opts.origin !== false &&
      !opts.retainSource &&
      !opts.ctx &&
      !opts._hitPass &&
      sections &&
      typeof sections === 'object' &&
      !(sections instanceof ArrayBuffer)
    ) {
      const o = originFor(sections.globalBBox);
      if (o) {
        opts = { ...opts, _origin: o };
        sections = await importSvgOnce(svgText, opts);
      }
    }
  }
  if (!sections || typeof sections !== 'object' || sections instanceof ArrayBuffer || opts._hitPass)
    return sections;
  const needed = sections._hitNeeded,
    rowAt = sections._hitRowAt,
    groups1 = sections._hitGroups,
    owners1 = sections._hitOwners;
  delete sections._hitOwners;
  delete sections._hitNeeded;
  delete sections._hitRowAt;
  delete sections._hitPos;
  delete sections._hitGroups;
  // The group tree of the drawn rows, on every bundle with an id'd container (animation/overrideKeys.js reads it): a bundle with no
  // such element carries no field.
  const drawn = groups1 ? Int32Array.from(groups1.row) : null;
  if (!needed || !rowAt) {
    if (groups1) {
      const tree = compactTree(groups1.names.slice(), Array.from(groups1.parent), [drawn]);
      if (tree)
        sections.groupTree = {
          format: 2,
          groupNames: tree.names,
          groupParent: tree.parent,
          drawnGroup: drawn,
        };
    }
    return sections;
  }
  const second = await importSvgOnce(svgText, { ...opts, _hitPass: true, retainSource: false });
  const groups2 = second && second._hitGroups,
    owners2 = second && second._hitOwners;
  if (second) delete second._hitOwners;
  if (second) {
    delete second._hitNeeded;
    delete second._hitRowAt;
    delete second._hitGroups;
  }
  const treeOnly = () => {
    if (!groups1) return sections;
    const tree = compactTree(groups1.names.slice(), Array.from(groups1.parent), [drawn]);
    if (tree)
      sections.groupTree = {
        format: 2,
        groupNames: tree.names,
        groupParent: tree.parent,
        drawnGroup: drawn,
      };
    return sections;
  };
  if (!second || !(second.numShapes > 0) || !second.hitBits) return treeOnly();
  const rows = [],
    before = [];
  for (let r = 0; r < second.numShapes; r++) {
    if (!second.hitBits[r]) continue;
    rows.push(r);
    before.push(rowAt[Math.min(second._hitPos[r], rowAt.length - 1)]);
  }
  if (!rows.length) return treeOnly();
  // Only what the hit queries read: meta rows, curve records, dashes, ids. The bands, cover meshes, gradients and atlas of
  // the second pass are not retained.
  // Owners propagate transforms; a different hit region is not replaced by its owner's paint row.
  // -2 identifies an ambiguous known occurrence, which must not fall back to an authored ID.
  let hiddenOwner = null;
  if (owners1 && owners2) {
    const main = new Map(),
      only = new Map(),
      occurrence = new Map();
    const meta = new Float32Array(sections.meta, 32),
      stride = sections.metaFloatsPerShape || 48;
    for (let r = 0; r < sections.numShapes; r++) {
      const owner = owners1[r];
      if (owner < 1 || Math.round(meta[r * stride + 27]) & (64 | 128 | 256)) continue;
      if (!occurrence.has(owner)) occurrence.set(owner, []);
      occurrence.get(owner).push(r);
      const key = owner * 8 + (sections.hitBits[r] & 7);
      if (!main.has(key)) main.set(key, []);
      main.get(key).push(r);
    }
    rows.forEach((r, k) => {
      const owner = owners2[r];
      if (owner < 1) return;
      if (occurrence.has(owner)) {
        if (!hiddenOwner) hiddenOwner = new Int32Array(rows.length).fill(-1);
        hiddenOwner[k] = -2;
      }
      const key = owner * 8 + (second.hitBits[r] & 7);
      if (!only.has(key)) only.set(key, []);
      only.get(key).push(k);
    });
    for (const [key, list] of only) {
      const matched = main.get(key);
      if (!matched || matched.length !== list.length) continue;
      if (!hiddenOwner) hiddenOwner = new Int32Array(rows.length).fill(-1);
      list.forEach((k, i) => {
        hiddenOwner[k] = matched[i];
      });
    }
    rows.forEach((r, k) => {
      if (!hiddenOwner || hiddenOwner[k] !== -2) return;
      const retained = occurrence.get(owners2[r]);
      if (retained && retained.length === 1) hiddenOwner[k] = retained[0];
    });
  }
  sections.hitOnly = {
    meta: second.meta,
    curves: second.curves,
    dashes: second.dashes,
    numShapes: second.numShapes,
    metaFloatsPerShape: second.metaFloatsPerShape,
    curveRangesByShape: second.curveRangesByShape,
    shapeIds: second.shapeIds,
    shapeHrefs: second.shapeHrefs,
    hitBits: second.hitBits,
    rows: Int32Array.from(rows),
    before: Int32Array.from(before),
    ...(hiddenOwner ? { hiddenOwner } : {}),
  };
  // Which id-bearing ancestor each hit-only row sits in, so an override on a group id reaches the rows under it (animation/overrides.js).
  // The nodes only a hit-only row reaches join the bundle's group tree; `rowGroup` rides in the hit-only table (format 2).
  if (groups1 && groups2) {
    const into = { names: groups1.names.slice(), parent: Array.from(groups1.parent) };
    const memo = new Map();
    const only = new Int32Array(rows.length);
    for (let k = 0; k < rows.length; k++)
      only[k] = mergeNode(into, groups2.names, groups2.parent, groups2.row[rows[k]], memo);
    const tree = compactTree(into.names, into.parent, [drawn, only]);
    if (tree) {
      sections.groupTree = {
        format: 2,
        groupNames: tree.names,
        groupParent: tree.parent,
        drawnGroup: drawn,
      };
      sections.hitOnly.format = 2;
      sections.hitOnly.rowGroup = only;
    }
  }
  return sections;
}

/** The ratio of the art's distance from the document origin to its own size beyond which the importer stores coordinates relative
 *  to a bundle origin. A float32 has 24 bits: art c away from the origin and e wide is quantized to c * 2^-24 in a box of e, so a
 *  4096 px draw of it moves by c / e * 2^-12 px: 1/64 px at c / e = 64, and linearly more after it (0.05 px at 1e4 for 128 px art).
 *  Under it the bytes stay exactly what they were (an icon at (50, 20) is not touched). */
export const ORIGIN_RATIO = 64;

/** The origin for a box [x, y, w, h] (the first import's globalBBox), or null when the art is near enough to the document origin
 *  to need none. The box center snapped to a multiple of the largest power of two not above the box's size, so two bundles of one
 *  sprite sheet land on the same origin and the subtraction is exact where the coordinates are. */
export function originFor(box) {
  if (!box) return null;
  const e = Math.max(box[2], box[3]);
  if (!(e > 0) || !Number.isFinite(e)) return null;
  const c = Math.max(
    Math.abs(box[0]),
    Math.abs(box[1]),
    Math.abs(box[0] + box[2]),
    Math.abs(box[1] + box[3]),
  );
  if (!(c > ORIGIN_RATIO * e)) return null;
  const step = Math.pow(2, Math.floor(Math.log2(e)));
  const o = [
    Math.round((box[0] + box[2] / 2) / step) * step,
    Math.round((box[1] + box[3] / 2) / step) * step,
  ];
  return (o[0] === 0 && o[1] === 0) || !Number.isFinite(o[0] + o[1]) ? null : o;
}

async function importSvgOnce(svgText, opts) {
  // The one input is markup text; anything else is a caller bug, named here rather than as a TypeError inside the DOM parser.
  if (typeof svgText !== 'string' || svgText.trim() === '')
    throw new TypeError(
      'importSvg: svgText must be a non-empty SVG string, got ' +
        (typeof svgText === 'string'
          ? 'an empty string'
          : svgText === null
            ? 'null'
            : typeof svgText),
    );
  const defaultFill = opts.defaultFill || 'black';
  const defaultStroke = opts.defaultStroke || 'transparent';
  // When true, the bundle's globalBBox uses the SVG viewBox; when false
  // (default), it uses the path-tight bbox.
  const preserveViewport = !!opts.preserveViewport;

  const defaultStrokeW = opts.defaultStrokeW !== undefined ? opts.defaultStrokeW : 1;

  if (typeof DOMParser === 'undefined')
    throw new Error(
      'importSvg: no global DOMParser. DOMParser exists on a browser main thread but not inside a Worker (import the SVG on the ' +
        'main thread and transfer the sections to the worker); in Node install a DOM parser (for example @xmldom/xmldom) ' +
        'and set globalThis.DOMParser and globalThis.XMLSerializer before importing SVG.',
    );
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() === 'parsererror') throw new Error('Failed to parse SVG');
  // Refuse a document nested deeper than the walk can recurse, cleanly (see MAX_ELEMENT_DEPTH).
  if (elementDepthExceeds(root))
    throw new Error(
      `svgImporter: elements nested deeper than ${MAX_ELEMENT_DEPTH} levels — not imported`,
    );
  setInitialColor(root, opts.initialColor);
  // The color grammar's compat mode (AccentColor) for the duration of this import, like the stylesheet below.
  setColorCompat(opts.compat === 'chrome' ? 'chrome' : 'spec');

  // Activate the stylesheet engine for the duration of this import.
  // getStyleProp consults <style> rules between inline-style and the
  // presentation-attribute layer. opts.cssTextLoader (when provided)
  // pulls external <link rel="stylesheet" href> sheets and appends
  // their rules after inline-style rules.
  setActiveStylesheet(
    root,
    opts.cssTextLoader
      ? await buildStylesheetAsync(root, opts.cssTextLoader)
      : buildStylesheet(root),
  );

  try {
    // opts.ctx lets callers (e.g. font/textRun for SVG-in-OT) graft
    // multiple SVG imports into one bundle by sharing accumulator
    // state across calls. When unset, each import gets a fresh ctx.
    // Band layout is fixed at IMPORT; the engine is chosen at DRAW (aacFill:'auto'
    // keys off px²/shape, a function of the world matrix). So unless the caller
    // pins an engine, the bands must serve both:
    //
    //   'slug'  stripe H bands + V bands   Slug's layout. AAC renders it correctly
    //                                      (stripe walk) but loses its pair speedup.
    //   'aac'   pair   H bands, no V bands -44% band memory. Slug renders it
    //                                      Correctly but pathologically: with one V
    //                                      band, its vertical ray walks every segment
    //                                      in the shape. Pin only if you will
    //                                      never draw it with Slug.
    //   default pair   H bands + V bands   The union. A pair list is a superset of a
    //                                      stripe list, so Slug is correct and pays
    //                                      only 0-8%; AAC keeps its full -24..-34%.
    //                                      Costs +5.5% band memory over 'slug'.
    //
    // Default to the union so 'auto' is free to pick either engine at any scale.
    const engine = opts.engine;
    const dflt = {
      pairBands: engine !== 'slug',
      vBands: engine !== 'aac',
      aacLevels: engine !== 'slug',
    };
    const ctx =
      opts.ctx ||
      makeBuildContext({
        vBands: opts.vBands !== undefined ? opts.vBands : dflt.vBands,
        pairBands: opts.pairBands !== undefined ? opts.pairBands : dflt.pairBands,
        aacLevels: opts.aacLevels !== undefined ? opts.aacLevels : dflt.aacLevels,
        bandK: opts.bandK,
        rayLanes: opts.rayLanes,
        coverFan: opts.coverFan,
        normalizeFill: opts.normalizeFill,
        sizeHint: svgText.length,
        curve64: opts.curves64 !== false, // false: no unrounded curve twin (the CPatch converter then reads the float32 plane)
      });
    if (!opts.ctx && opts._origin && (opts._origin[0] !== 0 || opts._origin[1] !== 0))
      ctx.curveBuf.docOrigin = opts._origin; // the walk is stored relative to it (svg/segment.js pointsMeet)
    let sections;
    try {
      sections = await importSvgInner(
        root,
        opts,
        defaultFill,
        defaultStroke,
        defaultStrokeW,
        preserveViewport,
        ctx,
      );
    } catch (e) {
      // A stack overflow below the depth cap (a heavy level: text, filters, clip chains) is the same refusal.
      if (e instanceof RangeError && /call stack/i.test(e.message)) {
        throw new Error('svgImporter: the document nests too deeply to import');
      }
      throw e;
    }
    // Opt-in source retention. The WebGL path never reads this; it
    // exists for the no-WebGL native-SVG fallback (createNativeScene),
    // which re-injects the ORIGINAL markup into the DOM so the browser's
    // own SVG engine rasterizes it (including <mask>/<filter>/<clipPath>,
    // which it re-evaluates per frame for free). Gated so regular
    // consumers don't pay the string-retention cost. `bundleForm: true`
    // packs to bytes and has no struct to attach to — skip there.
    if (
      opts.retainSource &&
      sections &&
      typeof sections === 'object' &&
      !(sections instanceof ArrayBuffer)
    ) {
      const expansions = ctx._textExpansions;
      if (expansions && expansions.length) {
        // <text> is ONE source element but expands to N glyph (+
        // decoration) shapes in the bundle. The native-SVG fallback
        // addresses shapes by document-order position, so a raw <text>
        // in svgSource would misalign every shape after it. Replace each
        // <text> with a <g> of real <path>s — one per bundle shape, in
        // shape order — so svgSource's renderable elements match the
        // bundle 1:1. The glyph paths are in the bundle's (post-CTM)
        // coordinate space, the same space the native morph writes per
        // frame, so a morph overwrite is continuous with the static path.
        // The <g> wrapper is invisible to the fallback's positional walk
        // (it filters to leaf shape tags), so [box, brace, g[glyphs…]]
        // reads as [box, brace, glyph0, glyph1, …] — exactly the shapes.
        //
        // The authored markup (with the real <text>) is kept as
        // svgSourceNativeText for consumers that want the browser's own
        // text rendering (crisper, selectable) and don't need per-glyph
        // morph/override — see createNativeScene({ nativeText: true }).
        sections.svgSourceNativeText = svgText;
        sections.svgSource = buildExpandedTextSource(root, expansions);
      } else {
        sections.svgSource = svgText;
      }
    }
    return sections;
  } finally {
    clearActiveStylesheet(root);
    setColorCompat('spec');
  }
}

const _SVGNS = 'http://www.w3.org/2000/svg';

/// Build the retained svgSource with each <text> replaced by a <g> of
/// real <path> elements (one per glyph/decoration shape, in shape order).
/// `expansions` is ctx._textExpansions: [{ node, paths }] where node is
/// the source <text> element and paths carry the per-shape `pathD` + paint
/// captured at import. Mutates `root` in place (it has already been fully
/// walked) and serializes the result. See the retainSource block above.
function buildExpandedTextSource(root, expansions) {
  // Presentation/effect attrs that belong on the wrapper <g> so the
  // glyph paths inherit the same masking/clipping/opacity the <text> had.
  // Local glyph outlines retain the text transform and the ancestor hierarchy.
  const CARRY = ['id', 'class', 'style', 'transform', 'mask', 'clip-path', 'filter', 'opacity'];
  const cssRgba = (rgba) => {
    if (!rgba) return null;
    const a = rgba[3] == null ? 1 : rgba[3];
    return (
      'rgba(' +
      Math.round(rgba[0] * 255) +
      ',' +
      Math.round(rgba[1] * 255) +
      ',' +
      Math.round(rgba[2] * 255) +
      ',' +
      a +
      ')'
    );
  };
  for (const { node, paths } of expansions) {
    const doc = node.ownerDocument;
    const g = doc.createElementNS(_SVGNS, 'g');
    for (const attr of CARRY) {
      const v = typeof node.getAttribute === 'function' ? node.getAttribute(attr) : null;
      if (v != null && v !== '') g.setAttribute(attr, v);
    }
    for (const p of paths) {
      const path = doc.createElementNS(_SVGNS, 'path');
      path.setAttribute('d', p.pathD);
      if (p.visible) path.setAttribute('visibility', 'visible'); // a visible <tspan> of a hidden <text>: the wrapper carries the <text>'s style
      const fill = cssRgba(p.fill);
      path.setAttribute('fill', fill || 'none');

      if (p.stroke && (p.sw || 0) > 0 && (p.stroke[3] == null || p.stroke[3] > 0)) {
        const stroke = cssRgba(p.stroke);
        if (stroke) {
          path.setAttribute('stroke', stroke);
          path.setAttribute('stroke-width', String(p.sw));
          for (const [name, value] of Object.entries(p.strokeAttrs || {}))
            if (value != null) path.setAttribute(name, value);
        }
      }
      g.appendChild(path);
    }
    if (node.parentNode) node.parentNode.replaceChild(g, node);
  }
  // Browsers and xmldom both expose XMLSerializer.
  return new XMLSerializer().serializeToString(root);
}

async function importSvgInner(
  root,
  opts,
  defaultFill,
  defaultStroke,
  defaultStrokeW,
  preserveViewport,
  ctx,
) {
  const append = {
    shapeBegin: ctx.shapesData.length,
    metaBegin: ctx.metas.length,
    clipBegin: ctx.clipsUsed.length,
    maskBegin: ctx.masksUsed.length,
  };
  const { walk, walkCtx } = await runImportWalk(
    root,
    opts,
    defaultFill,
    defaultStroke,
    defaultStrokeW,
    ctx,
  );
  if (opts._hitPass) isolateHitOnlyShapes(ctx, append.shapeBegin, keepInvisibleOf(opts));

  if (!ctx.shapesData.length) {
    const dropped = opts._hitPass || opts.ctx ? null : droppedReportOf(ctx.dropped);
    if (dropped) warnDropped(dropped, opts);
    return {
      ...(dropped ? { dropped } : null),
      version: 3,
      numShapes: 0,
      flags:
        BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM |
        BUNDLE_FLAG_HYBRID_MESH_CHUNKED |
        BUNDLE_FLAG_WIDE_BAND_HEADERS,
      globalBBox: [0, 0, 0, 0],
      ...(opts._origin && (opts._origin[0] !== 0 || opts._origin[1] !== 0)
        ? { origin: opts._origin.slice() }
        : {}), // (a hit-only bundle's targets are stored relative to it)
      viewBox: [0, 0, 0, 0],
      preserveAspectRatio: [1, 1, 0],
      curves: new ArrayBuffer(0),
      bands: new ArrayBuffer(0),
      meta: new ArrayBuffer(0),
      solid: new ArrayBuffer(0),
      curveGeom: new ArrayBuffer(0),
      gradients: null,
      gradientStops: null,
      gradientStopsCount: 0,
      dashes: null,
      strokeMesh: null,
      clipMesh: null,
      maskMesh: null,
      filterTab: null,
      filterGraphs: null,
      kernelTab: null,
      imageAtlas: null,
      imageAtlasDim: null,
      imageAtlasRects: null,
      metaFloatsPerShape: 48,
      extFlags: 0,
      shapeIds: [],
      shapeHrefs: [],
      curveRangesByShape: [],
      // Hidden leaves the second pass may still find targets (no page shape starts at any row).
      _hitNeeded: !opts._hitPass && !opts.ctx && ctx._hitHiddenCandidate === true,
      _hitRowAt: new Int32Array(1),
    };
  }

  return finalizeBundle(
    root,
    opts,
    defaultFill,
    defaultStroke,
    defaultStrokeW,
    preserveViewport,
    ctx,
    walk,
    walkCtx,
    append,
  );
}

export default importSvg;

// Geometry and bounding-box helpers for programmatic bundles.
export {
  pathBbox,
  segBbox,
  mkLine,
  mkQuad,
  mkCubic,
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  getCoverQuadMesh,
  COVER_QUAD_STRIDE,
};

/// The second import pass keeps only the regions the first one drew nothing for: every other record is neutralized (it
/// emits no row), and a kept one is made plain opaque geometry (no paint server, image, filter, mask or blend), because
/// the hit queries read geometry, fill rule, stroke style and clip-path only. Records are never removed or reordered:
/// clip, mask and pattern references address them by index.
function isolateHitOnlyShapes(ctx, from, keepInvisible) {
  for (let i = from; i < ctx.shapesData.length; i++) {
    const sd = ctx.shapesData[i];
    if (sd.kind || sd.isLayer) continue;
    const needs = hitOnlyNeeds(sd, keepInvisible);
    sd.fillGradId = 0;
    sd.strokeGradId = 0;
    sd.strokeImageId = 0;
    sd.vecPatternId = 0;
    sd.patternTile = null;
    sd.patternMatrix = null;
    sd.patternContent = null;
    sd.imageId = 0;
    sd.filterId = 0;
    sd.maskId = 0;
    sd.blendMode = 0;
    sd.isolation = 0;
    sd.fillRgba = needs && needs.fill ? [0, 0, 0, 1] : [0, 0, 0, 0];
    sd.fillNone = !(needs && needs.fill);
    sd.strokeRgba = needs && needs.stroke ? [0, 0, 0, 1] : [0, 0, 0, 0];
    if (!(needs && needs.stroke)) sd.sw = 0;
    sd.hitBits = needs
      ? sd.hitBits & ((needs.fill ? HIT_FILL | HIT_BBOX : 0) | (needs.stroke ? HIT_STROKE : 0))
      : 0;
    sd.hitVis = true;
  }
}
