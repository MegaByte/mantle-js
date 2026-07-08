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

import { buildFromMarkup, buildStyled } from './textRun.js';
import { defaultStyle } from './markupParser.js';

/**
 * Build the textRun output and wrap it as a `sections`-shape dict
 * compatible with `createBundle`.
 *
 * Returns `{ sections, bundleSrc }`; `bundleSrc` is the raw textRun
 * output if a caller wants its `colrGraphs` / `parentShapeIdx` /
 * `shapeIds` fields (createBundle reads them through too).
 */
export async function buildTextSections(font, text, style, markup) {
  const layout = layoutFromStyle(style);
  const spans = markup
    ? null   // buildFromMarkup parses internally
    : [{ text: text || '', style: spanStyleFromStyle(style) }];

  const fill = style && style.fill ? style.fill : [0, 0, 0, 1];
  const build = (lo) => markup
    ? buildFromMarkup(text || '', font, fill, lo)
    : buildStyled(spans, font, lo);

  // Probe-build to learn the bbox, then rebuild with originX/Y so
  // globalBBox's (xmin, ymin) sits at (0, 0) — matches the textRun path the hit-test +
  // worldMatrix code assumes. Bundle format is (xmin, ymin, w, h).
  let raw = await build(layout);

  const boxW = layout.layoutWidthEm > 0 ? layout.layoutWidthEm : 0;
  if (boxW > 0) {
    // Layout-box mode. textRun has already aligned glyphs horizontally
    // within [0, boxW] (the alignment offset is baked into glyph
    // penX). We only need to (a) shift vertically so the typographic
    // box top sits at y=0 — keeping the (0,0)-origin assumption —
    // and (b) pin globalBBox to the layout box so the box width and the
    // alignment offset both survive into the bundle (no ink-tight
    // collapse). typoTop/typoBottom use the same formula as
    // buildRunMetrics so runMetrics.typoBBox stays consistent.
    const fm = raw.fontMetrics;
    const typoTop = fm ? raw.firstBaselineY - fm.ascent : raw.globalBBox[1];
    const typoBottom = fm ? raw.lastBaselineY + fm.descent
                          : raw.globalBBox[1] + raw.globalBBox[3];
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
    raw.curveTexels.byteOffset + raw.curveTexels.byteLength);
  const bandAb  = raw.bandTexels.buffer.slice(
    raw.bandTexels.byteOffset,
    raw.bandTexels.byteOffset + raw.bandTexels.byteLength);
  // textRun emits raw metaFloats; the importer + createBundle expect
  // the 32-byte (numShapes + globalBBox) header followed by per-shape
  // floats. Prepend it.
  const metaAb = new ArrayBuffer(32 + raw.metaFloats.byteLength);
  const mdv = new DataView(metaAb);
  mdv.setUint32(0,  raw.numShapes, true);
  mdv.setFloat32(4,  raw.globalBBox[0], true);
  mdv.setFloat32(8,  raw.globalBBox[1], true);
  mdv.setFloat32(12, raw.globalBBox[2], true);
  mdv.setFloat32(16, raw.globalBBox[3], true);
  new Uint8Array(metaAb, 32).set(new Uint8Array(
    raw.metaFloats.buffer, raw.metaFloats.byteOffset, raw.metaFloats.byteLength));

  const cgeomAb = raw.curveGeomFloats && raw.curveGeomFloats.byteLength
    ? raw.curveGeomFloats.buffer.slice(
        raw.curveGeomFloats.byteOffset,
        raw.curveGeomFloats.byteOffset + raw.curveGeomFloats.byteLength)
    : null;

  const sections = {
    flags: raw.flags,
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
    // textRun doesn't emit gradients / strokes / images / filters.
    gradients: null, gradientStops: null, gradientStopsCount: 0,
    dashes: null, strokeMesh: null, clipMesh: null, maskMesh: null,
    filterTab: null, imageAtlas: null, imageAtlasDim: null,
    // Plumb COLRv1 + shape IDs through so emoji and per-shape
    // overrides work on text bundles too.
    colrGraphs: raw.colrGraphs || null,
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
  return { sections, bundleSrc: raw };
}

export /// Per-string typographic rect, in the bundle's local coord space
/// (post-shift, so ymin = 0 aligns with the bundle's globalBBox
/// origin). `typoBBox.height = fontMetrics.emHeight` is the FONT
/// metric; ink bounds can extend past this for fonts with glyphs
/// that rise above the ascent (rare).
function buildRunMetrics(raw) {
  const fm = raw.fontMetrics;
  if (!fm) return null;
  const [, gbbYmin, gbbW] = raw.globalBBox;
  // typoBBox: ascent above the first baseline, descent below the last.
  // For multi-line runs we span all baselines.
  const baselineDelta = raw.lastBaselineY - raw.firstBaselineY;
  const typoTop    = raw.firstBaselineY - fm.ascent;
  const typoBottom = raw.lastBaselineY  + fm.descent;
  return {
    // (xmin, ymin, w, h) — same shape as globalBBox.
    typoBBox: [0, typoTop, gbbW, typoBottom - typoTop],
    // Y of the first / last baseline in bundle-local em coords.
    firstBaselineY: raw.firstBaselineY,
    lastBaselineY:  raw.lastBaselineY,
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
  const runMetrics = fm ? {
    typoBBox: [0, 0, 0, fm.emHeight],
    firstBaselineY: fm.ascent,
    lastBaselineY:  fm.ascent,
    baselineY:      fm.ascent,
    lineCount: 1,
    lastLineAdvance: 0,
  } : null;
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

/** Convert TextStyle into the LayoutOptions textRun consumes. */
function layoutFromStyle(style) {
  const s = style || {};
  const layout = {};
  if (s.maxWidthEm != null)   layout.maxWidthEm   = s.maxWidthEm;
  if (s.align != null)        layout.align        = s.align;
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
  // fontSizePx + maxWidthPx are caller-side scale concerns — Mantle
  // multiplies by worldMatrix at draw time. We translate maxWidthPx
  // into maxWidthEm via the style.fontSizePx ratio when both are
  // provided; otherwise leave it to the caller to express in em.
  if (s.maxWidthPx != null && s.fontSizePx) {
    layout.maxWidthEm = s.maxWidthPx / s.fontSizePx;
  }
  // OpenType feature toggles flow straight through to LayoutOptions —
  // textRun's layoutSlots reads layout.features / layout.disabledFeatures
  // and routes through GsubReader.applyFeatureToSeq (opt-in) plus
  // gates the kern/liga paths (opt-out).
  if (s.features != null)         layout.features         = s.features;
  if (s.disabledFeatures != null) layout.disabledFeatures = s.disabledFeatures;
  // Writing mode + text orientation (CSS Writing Modes / SVG 2). Plumb
  // them through so `buildStyled` can re-aim the pen DOWN the column for
  // vertical-rl / vertical-lr. Default (unset) leaves horizontal-tb, so
  // horizontal callers are unaffected.
  if (s.writingMode != null)      layout.writingMode      = s.writingMode;
  if (s.textOrientation != null)  layout.textOrientation  = s.textOrientation;
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
  if (s.fontSizePx != null) out.size = s.fontSizePx;
  if (s.family) out.family = s.family;
  if (s.weight) out.weight = s.weight;
  if (s.italic != null) out.italic = !!s.italic;
  return out;
}
