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
  path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polygon: 1, polyline: 1,
  image: 1, text: 1,
};

// CSS/SVG mix-blend-mode name → enum. Two variants: SHAPE includes the
// extras (alpha 20 / erase 21); GROUP intentionally omits them.
const BLEND_MODES = {
  'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3,
  'darken': 4, 'lighten': 5, 'color-dodge': 6, 'color-burn': 7,
  'hard-light': 8, 'soft-light': 9, 'difference': 10, 'exclusion': 11,
  'hue': 12, 'saturation': 13, 'color': 14, 'luminosity': 15,
  'plus-lighter': 16, 'add': 16,
  'plus-darker':  17, 'subtract': 17,
  'invert': 18,
  // ALPHA (20) / ERASE (21) — no SVG syntax; supplied via a CSS custom
  // name. Renderer handles 20/21 in the composite shader directly.
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

import { finalizeBundle, BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM, BUNDLE_FLAG_HYBRID_MESH_CHUNKED, BUNDLE_FLAG_WIDE_BAND_HEADERS, TEXTURE_WIDTH, META_FLOATS_V3, COVER_QUAD_STRIDE } from './bundleFinalize.js';
import { elementChildren, switchChildMatches, resolveIdRef } from './utils.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseLength, parseLengthOr } from './length.js';
import { parsePatternDef } from './pattern.js';
import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  CAP_BUTT, CAP_ROUND, CAP_SQUARE,
  JOIN_MITER, JOIN_ROUND, JOIN_BEVEL, JOIN_ARCS,
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
import { CSS_NAMED_COLORS, hslToRgb, parseColor } from './color.js';
import {
  parseStyleString, getParsedStyle, getStyleProp, getInheritedStyleProp, resolveCurrentColor,
  getShapeStyles, isDisplayed, isPaintable, isEffectivelyVisible,
  getCapsJoins, getFillRule,
} from './style.js';
import {
  buildStylesheet, buildStylesheetAsync, setActiveStylesheet, clearActiveStylesheet,
} from './stylesheet.js';
import {
  GRAD_LINEAR, GRAD_RADIAL, GRAD_PAD, GRAD_REFLECT, GRAD_REPEAT,
  GRAD_SPREAD_ENUM, GRAD_UNITS_USER, GRAD_UNITS_BBOX, GRADIENT_FLOATS,
  parseGradientStops, parseGradients, packGradientStops, buildGradientTables,
} from './gradient.js';
import { parseFilters } from "./filter.js";
import { instantiateMarker, parseMarkers } from './marker.js';
import { parseClipsAndMasks } from './clipMask.js';
import {
  segCtrlBbox, segCtrlBboxInto, segBbox, segBboxInto,
  arcTightBbox, curveTightBboxQuad, curveTightBboxQuadInto,
  curveTightBboxCubic, curveTightBboxCubicInto, pathBbox,
  splitSubpathsWithCloseInto, polygonSignedArea,
} from "./bbox.js";
import { getCoverQuadMesh } from "./mesh.js";
import {
  makeTexelBuffer, texelEnsure, texelAppend, texelSet, texelXYOf, texelToBytes,
  segArcLen, encodeSeg, segTangentAt, segTangentAtInto,
  buildPathArcLengthLut, samplePathAt, buildTexturesShape,
} from "./textures.js";
import { packMetaBody } from './meta.js';
import { buildOccupancyGrid } from './occupancy.js';
import { decodeImageHref, preloadImages, downscaleRgba8 } from './image.js';
import { makeBuildContext, pickBandsXY, emitShape } from './buildContext.js';
import { unionPaths } from './pathBoolean/union.js';
import { runImportWalk } from './importWalk.js';
import { buildFilterSections } from './importFilters.js';
export async function importSvg(svgText, opts = {}) {
  const defaultFill = opts.defaultFill || 'black';
  const defaultStroke = opts.defaultStroke || 'transparent';
  // When true, the bundle's globalBBox uses the SVG viewBox; when false
  // (default), it uses the path-tight bbox.
  const preserveViewport = !!opts.preserveViewport;
  // Opt-in silhouette computation (perimeter-outline feature). When
  // `opts.computeSilhouette` is true, importSvg runs the path-boolean
  // union over every filled shape in the bundle and stores the result
  // as `bundle.silhouette` — an array of native segments
  // (LINE/QUAD/CUBIC/ARC preserved) that the renderer can stroke at
  // draw time via `opts.outline` (slice 9). Read inside importSvgInner
  // straight off `opts` so we don't have to thread an extra param.
  // When the flag is false (default) — no extra work, no extra storage.
  // Per SVG 1.1 § 11.4 the initial value for stroke-width is `1`. An element
  // that specifies `stroke="#000"` but omits stroke-width must therefore
  // render a 1-unit stroke; defaulting to 0 here silently drops outlines.
  const defaultStrokeW = (opts.defaultStrokeW !== undefined) ? opts.defaultStrokeW : 1;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() === 'parsererror')
    throw new Error('Failed to parse SVG');

  // Activate the stylesheet engine for the duration of this import.
  // getStyleProp consults <style> rules between inline-style and the
  // presentation-attribute layer. opts.cssTextLoader (when provided)
  // pulls external <link rel="stylesheet" href> sheets and appends
  // their rules after inline-style rules.
  setActiveStylesheet(root, opts.cssTextLoader
    ? await buildStylesheetAsync(root, opts.cssTextLoader)
    : buildStylesheet(root));

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
    //                                      CORRECTLY BUT PATHOLOGICALLY: with one V
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
    const dflt = { pairBands: engine !== 'slug', vBands: engine !== 'aac' };
    const ctx = opts.ctx || makeBuildContext({
      vBands: opts.vBands !== undefined ? opts.vBands : dflt.vBands,
      pairBands: opts.pairBands !== undefined ? opts.pairBands : dflt.pairBands,
      bandK: opts.bandK,
    });
    const sections = await importSvgInner(root, opts, defaultFill, defaultStroke, defaultStrokeW, preserveViewport, ctx);
    // Opt-in source retention. The WebGL path never reads this; it
    // exists for the no-WebGL native-SVG fallback (createNativeScene),
    // which re-injects the ORIGINAL markup into the DOM so the browser's
    // own SVG engine rasterizes it (including <mask>/<filter>/<clipPath>,
    // which it re-evaluates per frame for free). Gated so regular
    // consumers don't pay the string-retention cost. `bundleForm: true`
    // packs to bytes and has no struct to attach to — skip there.
    if (opts.retainSource && sections && typeof sections === 'object'
        && !(sections instanceof ArrayBuffer)) {
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
  // `transform` is intentionally NOT copied — each glyph's CTM (including
  // the <text>'s own transform) is already baked into its pathD.
  const CARRY = ['id', 'class', 'style', 'mask', 'clip-path', 'filter', 'opacity'];
  const cssRgba = (rgba) => {
    if (!rgba) return null;
    const a = (rgba[3] == null) ? 1 : rgba[3];
    return 'rgba(' + Math.round(rgba[0] * 255) + ',' + Math.round(rgba[1] * 255)
         + ',' + Math.round(rgba[2] * 255) + ',' + a + ')';
  };
  for (const { node, paths } of expansions) {
    const doc = node.ownerDocument;
    const g = doc.createElementNS(_SVGNS, 'g');
    for (const attr of CARRY) {
      const v = (typeof node.getAttribute === 'function') ? node.getAttribute(attr) : null;
      if (v != null && v !== '') g.setAttribute(attr, v);
    }
    for (const p of paths) {
      const path = doc.createElementNS(_SVGNS, 'path');
      path.setAttribute('d', p.pathD);
      const fill = cssRgba(p.fill);
      path.setAttribute('fill', fill || 'none');
      // Only emit a stroke when it's actually visible (non-zero width AND
      // non-transparent) — glyph fills default to a 1-unit stroke width
      // with a transparent stroke color, which we don't want to serialize.
      if (p.stroke && (p.sw || 0) > 0 && (p.stroke[3] == null || p.stroke[3] > 0)) {
        const stroke = cssRgba(p.stroke);
        if (stroke) { path.setAttribute('stroke', stroke); path.setAttribute('stroke-width', String(p.sw)); }
      }
      g.appendChild(path);
    }
    if (node.parentNode) node.parentNode.replaceChild(g, node);
  }
  // Browsers and xmldom both expose XMLSerializer.
  return new XMLSerializer().serializeToString(root);
}

async function importSvgInner(root, opts, defaultFill, defaultStroke, defaultStrokeW, preserveViewport, ctx) {
  const { walk, walkCtx } = await runImportWalk(root, opts, defaultFill, defaultStroke, defaultStrokeW, ctx);

  if (!ctx.shapesData.length) {
    return {
      version: 3,
      numShapes: 0,
      flags: BUNDLE_FLAG_HYBRID_MESH_IN_CGEOM
           | BUNDLE_FLAG_HYBRID_MESH_CHUNKED
           | BUNDLE_FLAG_WIDE_BAND_HEADERS,
      globalBBox: [0, 0, 0, 0],
      viewBox: [0, 0, 0, 0],
      preserveAspectRatio: [1, 1, 0],
      curves: new ArrayBuffer(0),
      bands: new ArrayBuffer(0),
      meta: new ArrayBuffer(0),
      solid: new ArrayBuffer(0),
      curveGeom: new ArrayBuffer(0),
      gradients: null, gradientStops: null, gradientStopsCount: 0,
      dashes: null, strokeMesh: null, clipMesh: null, maskMesh: null,
      filterTab: null, filterGraphs: null,
      kernelTab: null, imageAtlas: null, imageAtlasDim: null, imageAtlasRects: null,
      metaFloatsPerShape: 48,
      extFlags: 0,
      shapeIds: [],
      curveRangesByShape: [],
    };
  }

  return finalizeBundle(root, opts, defaultFill, defaultStroke, defaultStrokeW, preserveViewport, ctx, walk, walkCtx);
}

export default importSvg;

// Internal helpers re-exported for sibling subsystems (font/textRun.js
// etc.) that need to assemble bundles without going through SVG. Kept
// intentionally narrow. Contract: the output must be shape-identical to
// what importSvg() produces internally; if you bump the layout, bump
// both here and in textRun simultaneously.
export {
  makeTexelBuffer,
  texelAppend,
  texelSet,
  buildTexturesShape,
  packMetaBody,
  pathBbox,
  segBbox,
  mkLine, mkQuad, mkCubic,
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  getCoverQuadMesh,
  COVER_QUAD_STRIDE,
};

