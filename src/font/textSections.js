// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { SVG_TEXT_RESOURCE_FIELDS } from './textSvgInOt.js';
import { stampMetaHeader } from '../bundle/layout.js';
// textSections.js — the shared, GL-FREE text-shaping core.
//
// ONE text pipeline serves both backends: buildTextSections shapes a
// string/markup into a `sections` dict (layout box, alignment, origin
// normalization, run metrics — the full contract documented on
// createTextBundle's TextStyle). The WebGL path (textBundle.js) feeds
// `sections` to createBundle; the native fallback (nativeTextBundle.js)
// attaches an svgSource instead. Layout semantics live HERE so the two
// backends cannot drift.
//
// This module must stay free of renderer/GL imports: the native fallback
// subpath ships it, and a native run must not download the GL pipeline.

import { buildFromMarkup, buildStyled, isBoldWeight } from './textRun.js';
import { defaultStyle } from './markupParser.js';

/**
 * Build the textRun output and wrap it as a `sections`-shape dict
 * compatible with `createBundle`.
 *
 * Returns `{ sections, bundleSrc }`; `bundleSrc` is the raw textRun
 * output if a caller wants its `colrGraphs` / `parentShapeIdx` /
 * `shapeIds` fields (createBundle reads them through too).
 */
/**
 * @param {import('./fontAsset.js').MantleFontAsset} font
 * @param {string} text
 * @param {import('../textBundle.js').TextStyle} [style]
 * @param {boolean} [markup]  parse `text` as tag markup (`<color>`, `<b>`, sprites)
 * @param {{ gwnTree?: boolean }} [opts]
 * @returns {Promise<{ sections: any, bundleSrc: any }>}
 */
export async function buildTextSections(font, text, style, markup, opts) {
  const layout = layoutFromStyle(style);
  if (opts && opts.gwnTree) layout.gwnTree = true;
  const spans = markup
    ? null // buildFromMarkup parses internally
    : [{ text: text || '', style: spanStyleFromStyle(style) }];

  const fill = style && style.fill ? style.fill : [0, 0, 0, 1];
  const build = (lo) =>
    markup ? buildFromMarkup(text || '', font, fill, lo) : buildStyled(spans, font, lo);

  // Probe-build to learn the bbox, then rebuild with originX/Y so
  // globalBBox's (xmin, ymin) sits at (0, 0) — matches the textRun path the hit-test +
  // worldMatrix code assumes. Bundle format is (xmin, ymin, w, h).
  let raw = await build(layout);

  const boxW = layout.layoutWidthEm > 0 ? layout.layoutWidthEm : 0;
  if (boxW > 0) {
    const fm = raw.fontMetrics;
    const typoTop = fm ? raw.firstBaselineY - fm.ascent : raw.globalBBox[1];
    const typoBottom = fm ? raw.lastBaselineY + fm.descent : raw.globalBBox[1] + raw.globalBBox[3];
    if (typoTop !== 0) raw = await build({ ...layout, originY: -typoTop });
    raw.globalBBox = [0, 0, boxW, typoBottom - typoTop];
  } else {
    const [bbXmin, bbYmin] = raw.globalBBox;
    if (bbXmin !== 0 || bbYmin !== 0) {
      raw = await build({ ...layout, originX: -bbXmin, originY: -bbYmin });
    }
  }

  // Reconstruct the sections dict createBundle expects.
  const curveAb = raw.curveTexels.buffer.slice(
    raw.curveTexels.byteOffset,
    raw.curveTexels.byteOffset + raw.curveTexels.byteLength,
  );
  const bandAb = raw.bandTexels.buffer.slice(
    raw.bandTexels.byteOffset,
    raw.bandTexels.byteOffset + raw.bandTexels.byteLength,
  );
  // textRun emits raw metaFloats; the importer + createBundle expect
  // the 32-byte (numShapes + globalBBox) header followed by per-shape
  // floats. Prepend it.
  const metaAb = new ArrayBuffer(32 + raw.metaFloats.byteLength);
  const mdv = new DataView(metaAb);
  mdv.setUint32(0, raw.numShapes, true);
  stampMetaHeader(mdv);
  mdv.setFloat32(4, raw.globalBBox[0], true);
  mdv.setFloat32(8, raw.globalBBox[1], true);
  mdv.setFloat32(12, raw.globalBBox[2], true);
  mdv.setFloat32(16, raw.globalBBox[3], true);
  new Uint8Array(metaAb, 32).set(
    new Uint8Array(raw.metaFloats.buffer, raw.metaFloats.byteOffset, raw.metaFloats.byteLength),
  );

  const cgeomAb =
    raw.curveGeomFloats && raw.curveGeomFloats.byteLength
      ? raw.curveGeomFloats.buffer.slice(
          raw.curveGeomFloats.byteOffset,
          raw.curveGeomFloats.byteOffset + raw.curveGeomFloats.byteLength,
        )
      : null;

  const sections = {
    flags: raw.flags,
    segTypeMask: raw.segTypeMask | 0,
    totalSegments: raw.totalSegments | 0,
    metaFloatsPerShape: raw.metaFloatsPerShape,
    meta: metaAb,
    curves: curveAb,
    bands: bandAb,
    curveGeom: cgeomAb,
    // Authoritative per-shape curve ranges (from each glyph's _curveStartF).
    // Without these, createBundle falls back to buildCurveRangesByShape, which
    // derives ranges from glyphLoc (meta texel 4) — a BAND-buffer index, NOT a
    // curve offset — so on text the ranges are wrong (they point into band
    // space, and shape 0 begins at the leading sentinel texel instead of after
    // it). Any curve-range consumer breaks: the analytic (Loop-Blinn) fill
    // mis-reconstructs glyph contours, shape morph, hit-testing. Forward the
    // real ranges so text matches SVG (whose importer already supplies them).
    curveRangesByShape: raw.curveRangesByShape || null,
    authoredBandsByShape: raw.authoredBandsByShape || null,
    fillNormByShape: raw.fillNormByShape || null,
    // The GWN run tree was baked into `bands` when the caller asked for it (layout.gwnTree). createBundle reads this flag, and
    // without it every GWN kernel's renderer warned that the bundle "will render EMPTY" while drawing the text correctly.
    gwnTree: !!layout.gwnTree,
    // COLRv1 gradient stops and decoded bitmap glyphs accompany the geometry.
    gradients: null,
    gradientStops: raw.gradientStops || null,
    gradientStopsCount: raw.gradientStopsCount || 0,
    dashes: null,
    strokeMesh: null,
    clipMesh: null,
    maskMesh: null,
    filterTab: null,
    imageAtlas: raw.imageAtlas || null,
    imageAtlasDim: raw.imageAtlasDim || null,
    imageAtlasRects: raw.imageAtlasRects || null,
    // Plumb COLRv1 + shape IDs through so emoji and per-shape
    // overrides work on text bundles too.
    colrGraphs: raw.colrGraphs || null,
    colrHit: raw.colrHit || null,
    shapeIds: raw.shapeIds ? raw.shapeIds.slice() : null,
    // Font-wide + per-run typographic metrics (em-normalized layout).
    // createBundle surfaces them on the bundle object verbatim; textBundle's
    // handle exposes them via `.fontMetrics` / `.runMetrics` so
    // layout callers can scale + position against the FONT's metrics
    // instead of the per-string ink-tight globalBBox (which changes
    // height with whether the string has descenders).
    fontMetrics: raw.fontMetrics || null,
    runMetrics: buildRunMetrics(raw),
  };
  for (const field of SVG_TEXT_RESOURCE_FIELDS)
    if (raw[field] !== undefined) sections[field] = raw[field];
  return { sections, bundleSrc: raw };
}

/**
 * Per-string typographic metrics — the SUPPORTED layout surface for text
 * consumers (exposed as `bundle.runMetrics` / text-handle `.runMetrics`
 * on both the WebGL and native backends; refreshed by every setText/
 * setStyle). All values are em-normalized, in the bundle's local coord
 * space (post-shift: the bundle's globalBBox origin is (0,0); apply the
 * same em→world scale you draw the bundle with).
 *
 * Prefer `typoBBox` over the bundle's ink-tight `globalBBox` when
 * positioning labels: the typographic rect spans ascent-to-descent, so
 * its height does not jitter with whether the current string happens to
 * contain descenders or tall glyphs.
 *
 * @typedef {Object} RunMetrics
 * @property {[number,number,number,number]} typoBBox  (xmin, ymin, w, h)
 *   typographic rect: from `firstBaselineY - ascent` down to
 *   `lastBaselineY + descent`, spanning the run's layout width. NOT the
 *   ink-tight bbox (that is `bundle.globalBBox`).
 * @property {number} firstBaselineY  Y of the first line's baseline.
 * @property {number} lastBaselineY   Y of the last line's baseline.
 * @property {number} baselineY       Alias of firstBaselineY (single-line
 *   convenience).
 * @property {number} lineCount       Laid-out line count (≥ 1).
 * @property {number} lastLineAdvance Pen advance of the last line — where
 *   a caret/appended run would continue.
 */

export /// Per-string typographic rect, in the bundle's local coord space
/// (post-shift, so ymin = 0 aligns with the bundle's globalBBox
/// origin). `typoBBox.height = fontMetrics.emHeight` is the FONT
/// metric; ink bounds can extend past this for fonts with glyphs
/// that rise above the ascent (rare).
/// @returns {RunMetrics|null} null when the font exposes no metrics.
function buildRunMetrics(raw) {
  const fm = raw.fontMetrics;
  if (!fm) return null;
  const [, gbbYmin, gbbW] = raw.globalBBox;

  const baselineDelta = raw.lastBaselineY - raw.firstBaselineY;
  const typoTop = raw.firstBaselineY - fm.ascent;
  const typoBottom = raw.lastBaselineY + fm.descent;
  return {
    // (xmin, ymin, w, h) — same shape as globalBBox.
    typoBBox: [0, typoTop, gbbW, typoBottom - typoTop],
    // Y of the first / last baseline in bundle-local em coords.
    firstBaselineY: raw.firstBaselineY,
    lastBaselineY: raw.lastBaselineY,
    // Convenience alias for single-line runs.
    baselineY: raw.firstBaselineY,
    lineCount: Math.max(raw.lineCount | 0, 1),
    lastLineAdvance: raw.lastLineAdvance || 0,
  };
}

export function makeEmptyBundle(font) {
  // Even an empty run carries meaningful font-wide metrics — the
  // FONT is still loaded, so callers can lay out an empty label's
  // box at the font's intrinsic line height. runMetrics reports a
  // zero-width single-line typoBBox so layout consumers get a
  // sensible line-height fallback.
  const fm = font && typeof font.fontMetrics === 'function' ? font.fontMetrics() : null;
  const runMetrics = fm
    ? {
        typoBBox: [0, 0, 0, fm.emHeight],
        firstBaselineY: fm.ascent,
        lastBaselineY: fm.ascent,
        baselineY: fm.ascent,
        lineCount: 1,
        lastLineAdvance: 0,
      }
    : null;
  return {
    numShapes: 0,
    metaFloatsPerShape: 48,
    metaFloats: new Float32Array(0),
    curveFloats: new Float32Array(0),
    curveRangesByShape: [],
    flags: 0,
    globalBBox: [0, 0, 0, 0],
    shapeIds: [],
    coverQuadFloats: null,
    coverQuadChunks: [],
    hybridShapeIdxFloats: null,
    chunkByShape: [],
    gidToShapeIdx: new Map(),
    drawList: [],
    fontMetrics: fm,
    runMetrics,
    dispose() {},
  };
}

/** Convert TextStyle into the LayoutOptions textRun consumes. (Exported for the smokes; not public API.) */
export function layoutFromStyle(style) {
  const s = style || {};
  const layout = {};
  if (s.bitmapPpem != null) layout.bitmapPpem = s.bitmapPpem;
  else if (s.fontSizePx > 0) layout.bitmapPpem = s.fontSizePx;
  if (s.maxWidthEm != null) layout.maxWidthEm = s.maxWidthEm;
  if (s.align != null) layout.align = s.align;
  if (s.lastLineAlign != null) layout.lastLineAlign = s.lastLineAlign;
  if (s.lineHeightEm != null) layout.lineHeightEm = s.lineHeightEm;
  // Fixed layout-box width (align in a rect). When set,
  // the bundle's globalBBox becomes the layout box [0,0,W,H] instead of
  // ink-tight, and `align` positions glyphs WITHIN that box — a
  // right-aligned line sits at the box's right edge, a center-aligned
  // line stays centered, regardless of the string's own ink width.
  if (s.layoutWidthEm != null) layout.layoutWidthEm = s.layoutWidthEm;
  if (s.layoutWidthPx != null && s.fontSizePx) {
    layout.layoutWidthEm = s.layoutWidthPx / s.fontSizePx;
  }

  if (s.maxWidthPx != null && s.fontSizePx) {
    layout.maxWidthEm = s.maxWidthPx / s.fontSizePx;
  }
  // OpenType feature toggles flow straight through to LayoutOptions —
  // textRun's layoutSlots reads layout.features / layout.disabledFeatures
  // and routes through GsubReader.applyFeatureToSeq (opt-in) plus
  // gates the kern/liga paths (opt-out).
  if (s.features != null) layout.features = s.features;
  if (s.disabledFeatures != null) layout.disabledFeatures = s.disabledFeatures;
  // Writing mode + text orientation (CSS Writing Modes / SVG 2). Plumb
  // them through so `buildStyled` can re-aim the pen DOWN the column for
  // vertical-rl / vertical-lr. Default (unset) leaves horizontal-tb, so
  // horizontal callers are unaffected.
  if (s.writingMode != null) layout.writingMode = s.writingMode;
  if (s.textOrientation != null) layout.textOrientation = s.textOrientation;
  // Variant faces for bold/italic spans — `<b>`/`<i>` markup, and
  // style.weight / style.italic. textLayout picks layout.{bold,italic,
  // boldItalic}Font per span and SYNTHESIZES (stroke inflation / shear) when
  // the matching face is absent. These were never forwarded, so this entry
  // point could only ever synthesize even when the caller had the real face
  // loaded; buildSvgTextGlyphs' styleOpts.variantFonts already accepts them.
  if (s.boldFont != null) layout.boldFont = s.boldFont;
  if (s.italicFont != null) layout.italicFont = s.italicFont;
  if (s.boldItalicFont != null) layout.boldItalicFont = s.boldItalicFont;
  // Variable-font axis values, the glyph fallback chain, and the OpenType language system. LayoutOptions
  // carries all three (buildStyled / buildFromMarkup honor them); forwarding them here is what lets a variable
  // font leave its default instance and a fallback face be requested through createTextBundle / setText / setStyle.
  if (s.varCoords != null) layout.varCoords = s.varCoords;
  if (s.fallbacks != null) layout.fallbacks = s.fallbacks;
  if (s.language != null) layout.language = s.language;
  if (s.compat != null) layout.compat = s.compat;
  if (s.ptem != null) layout.ptem = s.ptem;
  if (s.preferAat != null) layout.preferAat = s.preferAat;
  if (s.useJstf != null) layout.useJstf = s.useJstf;
  return layout;
}

/** Convert TextStyle into a textRun Span style.
 *
 *  Start from `defaultStyle()` (the markup-parser canonical defaults)
 *  so every field textRun reads — `sizeScale`, `voffsetEm`, `widthScale`,
 *  `glyphScale`, etc. — is present and finite. Without `sizeScale`,
 *  textRun multiplies every glyph coord by undefined, the per-shape
 *  bbox stays at the Infinity seed, and globalBBox is Infinity.
 *  Overlay the caller's fields on top.
 */
function spanStyleFromStyle(style) {
  const s = style || {};
  const out = defaultStyle();
  if (s.fill) out.color = s.fill.slice();

  if (s.weight != null) out.bold = isBoldWeight(s.weight);
  if (s.italic != null) out.italic = !!s.italic;
  // NOT mapped, deliberately: `fontSizePx` is an absolute size the CALLER
  // scales the laid-out result by (see layoutFromStyle, which turns it into
  // layoutWidthEm / maxWidthEm ratios), and per-span `family` has no
  // representation — font selection is the `font` argument plus
  // styleOpts.variantFonts. Writing either onto the span style would be
  // another field nothing reads.
  return out;
}
