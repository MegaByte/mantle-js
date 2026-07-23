// textBundle.js — dynamic-text bundle with mutable
// content + style.
//
// Wraps `font/textRun.js::buildFromMarkup` + `createBundle` into a
// single updateable handle. `setText(text, style?)` rebuilds the
// text run, repacks the meta/curve/band/curveGeom planes, and
// REPLACES THE BUNDLE'S CONTENT IN PLACE: `tb.bundle` keeps the SAME
// object identity for the handle's whole lifetime, so renderer draw
// handles bound to it (renderer.setBundle / createBundleHandle) stay
// valid across setText()/setStyle() — the rebuild bumps the bundle's
// geometry generation and every bound handle re-uploads automatically
// on its next draw. No re-mount, no id juggling, no manual
// invalidate(). (The old GL textures are disposed and the fresh ones
// adopted under the same identity; the first build allocates, later
// builds swap.)
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
 *  @property {boolean} [recolor]             this bundle is drawn with recolour state
 *    (colorMatrix / channelLerp / palette). Fixes the fill variant at creation —
 *    and, because setText/setStyle REBUILD the bundle, it is re-declared on every
 *    rebuild so a recoloured label never silently drops back to the lean variant.
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
  // Recolour is a BUNDLE property, and setText/setStyle rebuild the bundle — so
  // carry the declaration on the HANDLE and re-apply it to every rebuild, else the
  // first setText on a tinted label would drop it back to the non-recolour variant
  // and self-heal (recompile) on the very next draw.
  const recolor = !!opts.recolor;
  const gwnTree = !!opts.gwnTree;
  let text = typeof opts.text === 'string' ? opts.text : '';
  let style = opts.style || {};

  let bundle = await rebuild(gl, font, text, style, markup, null, recolor, gwnTree);
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
    /** Per-current-string typographic metrics
     *  ({@link import('./font/textSections.js').RunMetrics}), em-relative
     *  in the bundle's local coord space. Refreshed on every setText() /
     *  setStyle(). This is the SUPPORTED metrics surface for layout
     *  consumers — position labels against `runMetrics.typoBBox`
     *  (ascent-to-descent rect, stable across strings with/without
     *  descenders) and the baselines, not the ink-tight globalBBox.
     *  Fields: typoBBox [x,y,w,h], firstBaselineY, lastBaselineY,
     *  baselineY, lineCount, lastLineAdvance. */
    get runMetrics() { return bundle ? bundle.runMetrics : null; },

    /** Mutate content and (optionally) style; rebuild + re-upload.
     *  IN-PLACE: `tb.bundle` keeps its object identity, so existing
     *  draw handles remain bound and pick the new glyphs up on their
     *  next draw. Resolves to the (same) live bundle. */
    async setText(newText, newStyle) {
      const nextText = typeof newText === 'string' ? newText : '';
      // A caller that re-applies the current label has no observable update.
      // More importantly, rebuilding here allocates every glyph texture and
      // invalidates the bound handle's geometry. Do not infer equality for a
      // supplied style: callers may deliberately mutate and re-submit one.
      if (nextText === text && newStyle == null) return bundle;
      text = nextText;
      if (newStyle != null) style = newStyle;
      bundle = await rebuild(gl, font, text, style, markup, bundle, recolor, gwnTree);
      applyTextSource();
      return bundle;
    },

    /** Mutate style only; keep current text. Same in-place identity
     *  contract as setText(). */
    async setStyle(newStyle) {
      if (newStyle != null) style = newStyle;
      bundle = await rebuild(gl, font, text, style, markup, bundle, recolor, gwnTree);
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

async function rebuild(gl, font, text, style, markup, prevBundle, recolor, gwnTree) {
  const { sections, bundleSrc } = await buildTextSections(font, text, style, markup, { gwnTree: !!gwnTree });
  // Rebuilds (prevBundle set) transplant the fresh bundle's fields into
  // the EXISTING bundle object below; suppress createBundle's automatic
  // off-thread LB build so the worker result can't land on the abandoned
  // temporary. Post-transplant the bundle carries _geomGen > 0, which the
  // LB-static route gate skips anyway (text rides Slug under 'auto').
  if (prevBundle) sections.deferAutoLb = true;
  // Empty runs (no glyphs in the input font / text) produce zero-shape
  // bundles whose curve + band buffers are too small to round-trip
  // through GL. Skip the GL upload and use a stub bundle the renderer
  // treats as a no-op.
  const next = (!bundleSrc || bundleSrc.numShapes === 0)
    ? makeEmptyBundle(font)
    : createBundle(gl, sections, { recolor: !!recolor });
  if (!prevBundle) return next;
  return transplantBundle(prevBundle, next);
}

/** Replace `target`'s content with `next`'s while PRESERVING `target`'s
 *  object identity — the heart of the identity-stable setText contract.
 *
 *  Steps: (1) dispose target's GL textures (createBundle allocated fresh
 *  ones on `next`; without this every setText leaks GPU memory),
 *  (2) strip target's own properties, (3) adopt next's property
 *  descriptors verbatim (fields, accessors like `hybridVerts`, methods
 *  incl. dispose/applyNineSlice bound to their closure state), and
 *  (4) carry the geometry generation forward MONOTONICALLY — the bump is
 *  what makes bound renderer handles re-upload the new mesh and drop
 *  stale caches on their next draw.
 *
 *  Safe for text bundles in both directions of the empty↔non-empty
 *  transition (the empty stub is bundle-shaped). Text bundles emit no
 *  clip/mask rows, so per-handle mask-region state cannot go stale. */
function transplantBundle(target, next) {
  const nextGen = ((target._geomGen | 0) + 1);
  if (typeof target.dispose === 'function') target.dispose();
  for (const k of Object.getOwnPropertyNames(target)) delete target[k];
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(next));
  target._geomGen = nextGen;
  // dispose() above stamped _disposed on target; the delete loop removed
  // it, and `next` was never disposed — make the live state explicit.
  target._disposed = false;
  // `next` is now a SPENT SHELL: target owns every GL object it named, and next's
  // fields still point at them. createBundle already enqueued next for fill-prewarm,
  // so it is sitting in the PSO-warm queue — and on the NEXT setText, target.dispose()
  // deletes exactly those textures. The shell then handed a deleted texture straight to
  // beginFillPass: "bindTexture: attempt to use a deleted object", once per warm, for
  // every text bundle a scene retypes (a score, a label, a timer).
  //
  // Mark it dead so the warm queues skip it. Do NOT dispose it — the textures are
  // target's now, and deleting them here would kill the live bundle.
  next._disposed = true;
  return target;
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



