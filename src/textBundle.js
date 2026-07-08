// textBundle.js — dynamic-text bundle with mutable
// content + style.
//
// Wraps `font/textRun.js::buildFromMarkup` + `createBundle` into a
// single updateable handle. `setText(text, style?)` rebuilds the
// text run, repacks the meta/curve/band/curveGeom planes, and
// re-uploads them into the bundle's existing GL textures. The
// renderer's `drawBundle`/`setBundle`/`render()` doesn't care that
// the bundle's content changed — it re-binds the same textures.
//
// Cost shape: the GL textures are reallocated only when the new
// content needs more rows / texels than the current allocation; the
// common per-trial case (same string length / similar glyph count)
// reuses storage via `texSubImage2D`.
//
// Public API:
//
//   const tb = await createTextBundle(gl, {
//     font, text: 'red', style: { fill: [1, 0, 0, 1], fontSizePx: 48 },
//   });
//   renderer.drawBundle(tb.bundle, { worldMatrix });
//
//   // Per trial:
//   await tb.setText('verde', { fill: [0, 1, 0, 1] });
//   renderer.drawBundle(tb.bundle, { worldMatrix });
//
//   // Done:
//   tb.dispose();

import { createBundle } from './renderer/bundle.js';
// The shaping/layout core is shared with the native fallback (ONE text
// pipeline, two materializations — see font/textSections.js).
import { buildTextSections, makeEmptyBundle } from './font/textSections.js';
export { buildTextSections } from './font/textSections.js';

/** TextStyle interface. All optional; defaults match
 *  buildFromMarkup's `defaultStyle()`.
 *
 *  @typedef {Object} TextStyle
 *  @property {[number,number,number,number]} [fill] rgba in [0,1]
 *  @property {number} [fontSizePx]
 *  @property {('left'|'center'|'right')} [align]
 *  @property {number} [maxWidthEm]
 *  @property {number} [maxWidthPx]
 *  @property {number} [layoutWidthEm]  Fixed layout-box width (em). When
 *    set, the bundle's globalBBox is the layout box `[0,0,W,H]` (NOT
 *    ink-tight) and `align` positions glyphs within it — right-aligned
 *    text sits flush at the box's right edge, center stays centered.
 *    Unlike `maxWidthEm` it does not force word-wrap. Default (unset) =
 *    ink-tight bundle. Use for fixed-rect labels.
 *  @property {number} [layoutWidthPx]  As `layoutWidthEm` but in px;
 *    converted via `fontSizePx`.
 *  @property {number} [lineHeightEm]
 *  @property {Record<string, boolean>} [features]  OpenType opt-in
 *    GSUB feature tags (e.g. `{ tnum: true }` for tabular figures,
 *    `{ ss01: true }` for stylistic-set 1). Each truthy entry runs
 *    that feature's GSUB lookups across the glyph run. Unknown /
 *    unsupported tags no-op silently.
 *  @property {string[]|Set<string>} [disabledFeatures]  Default-on
 *    tags to suppress: `kern` skips pair kerning + GPOS xAdvance
 *    deltas; `liga` / `rlig` skips ligature substitution. Other
 *    tags in the set are ignored (default-on script shapers are
 *    not caller-controllable).
 *  @property {('horizontal-tb'|'vertical-rl'|'vertical-lr')} [writingMode]
 *    Layout axis. Default `horizontal-tb` advances the pen along +X.
 *    `vertical-rl` / `vertical-lr` advance DOWN the column (+Y); pair
 *    with `textOrientation` to control per-glyph rotation.
 *  @property {('mixed'|'upright'|'sideways')} [textOrientation]
 *    Per-glyph orientation in vertical modes (default `mixed`: CJK
 *    upright, other scripts rotated 90° clockwise). Ignored when
 *    `writingMode` is horizontal.
 */

/** @typedef {Object} CreateTextBundleOpts
 *  @property {import('../../font/fontAsset.js').MantleFontAsset} font
 *  @property {string} [text]                 initial content; default ''
 *  @property {TextStyle|Object} [style]      initial style
 *  @property {boolean} [markup]              treat text as rich-text markup; default false
 */

/**
 * Create a dynamic-text bundle. The returned handle owns its GL
 * textures and stays valid until `dispose()`. Call `setText()` per
 * frame / per trial to mutate content + style.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {CreateTextBundleOpts} opts
 * @returns {Promise<MantleTextBundle>}
 */
export async function createTextBundle(gl, opts) {
  if (!gl) throw new Error('createTextBundle: gl required');
  if (!opts || !opts.font) throw new Error('createTextBundle: opts.font required');
  const font = opts.font;
  const markup = !!opts.markup;
  // retainText (or retainSource, for symmetry with importSvg) keeps the
  // ORIGINAL text + paint + baseline on the bundle as `textSource`, so the
  // SVG-export path can emit a real <text> element instead of glyph
  // outlines when called with { recoverText: true }. Cheap (a string + a
  // few scalars); off by default.
  const retainText = !!(opts.retainText || opts.retainSource);
  let text = typeof opts.text === 'string' ? opts.text : '';
  let style = opts.style || {};

  let bundle = await rebuild(gl, font, text, style, markup, null);
  const applyTextSource = () => {
    if (retainText && bundle && (bundle.numShapes | 0) > 0)
      bundle.textSource = buildTextSource(text, style, font, bundle);
  };
  applyTextSource();

  return /** @type {MantleTextBundle} */ ({
    get bundle() { return bundle; },
    get text()   { return text; },
    get style()  { return style; },
    get font()   { return font; },
    /** Font-wide em-normalized metrics. Stable across setText()
     *  for the same font + axis configuration; cache once. */
    get fontMetrics() { return bundle ? bundle.fontMetrics : null; },
    /** Per-current-string typographic rect (em-relative, in the
     *  bundle's local coord space). Refreshed on every setText() /
     *  setStyle(). Includes typoBBox (ascent-to-descent rect — NOT
     *  the ink-tight bbox), firstBaselineY, lastBaselineY,
     *  lineCount, lastLineAdvance. */
    get runMetrics() { return bundle ? bundle.runMetrics : null; },

    /** Mutate content and (optionally) style; rebuild + re-upload. */
    async setText(newText, newStyle) {
      text = typeof newText === 'string' ? newText : '';
      if (newStyle != null) style = newStyle;
      bundle = await rebuild(gl, font, text, style, markup, bundle);
      applyTextSource();
      return bundle;
    },

    /** Mutate style only; keep current text. */
    async setStyle(newStyle) {
      if (newStyle != null) style = newStyle;
      bundle = await rebuild(gl, font, text, style, markup, bundle);
      applyTextSource();
      return bundle;
    },

    dispose() {
      if (bundle && typeof bundle.dispose === 'function') bundle.dispose();
      bundle = null;
    },
  });
}

// ---- Internal helpers ----------------------------------------------

async function rebuild(gl, font, text, style, markup, prevBundle) {
  const { sections, bundleSrc } = await buildTextSections(font, text, style, markup);
  // Dispose the previous bundle's GL textures before allocating fresh
  // ones. `createBundle` allocates new Texture2Ds each call, so we'd
  // otherwise leak across every setText.
  if (prevBundle && typeof prevBundle.dispose === 'function') {
    prevBundle.dispose();
  }
  // Empty runs (no glyphs in the input font / text) produce zero-shape
  // bundles whose curve + band buffers are too small to round-trip
  // through GL. Skip the GL upload and return a stub bundle the
  // renderer treats as a no-op.
  if (!bundleSrc || bundleSrc.numShapes === 0) {
    return makeEmptyBundle(font);
  }
  return createBundle(gl, sections);
}







/** Capture the minimal original-text descriptor needed to re-emit a real
 *  SVG <text> at export time (renderer.exportFrameSVG({ recoverText:true })).
 *  All positions are in the bundle's local EM space — the same space the
 *  glyph geometry lives in (fontSizePx is applied later via worldMatrix),
 *  so a <text font-size="1" y={baseline}> drawn under the bundle's group
 *  lands where the outlined glyphs would. Alignment is already baked into
 *  the glyph penX during layout, so text-anchor stays 'start' at x=0. */
function buildTextSource(text, style, font, bundle) {
  const rm = bundle && bundle.runMetrics;
  const s = style || {};
  return {
    text: text || '',
    // [r,g,b,a] in [0,1] — serialized to a CSS color at export time.
    fill: s.fill ? [s.fill[0], s.fill[1], s.fill[2], s.fill.length > 3 ? s.fill[3] : 1] : [0, 0, 0, 1],
    fontSizeEm: 1,                              // em-normalized geometry
    fontSizePx: typeof s.fontSizePx === 'number' ? s.fontSizePx : null,
    originX: 0,
    baselineY: rm ? rm.firstBaselineY : 0,
    textAnchor: 'start',
    align: s.align || 'left',
    // Best-effort family hint; the consumer must have the font available
    // (e.g. via @font-face) for a faithful render. Omitted when unknown.
    fontFamily: (font && (font.familyName || font.family || font.name)) || null,
    lineCount: rm ? rm.lineCount : 1,
  };
}




