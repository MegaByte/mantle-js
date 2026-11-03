// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textBundle.js — dynamic-text bundle with mutable
// content + style.
//
// Wraps `font/textRun.js::buildFromMarkup` + `createBundle` into a
// single updateable handle. `setText(text, style?)` rebuilds the
// text run, repacks the meta/curve/band/curveGeom planes, and
// Replaces the bundle's content in place: `tb.bundle` keeps the same
// object identity for the handle's whole lifetime, so renderer draw
// handles bound to it (renderer.setBundle / createBundleHandle) stay
// valid across setText()/setStyle() — the rebuild bumps the bundle's
// geometry generation and every bound handle re-uploads automatically
// on its next draw. No re-mount, no id juggling, no manual
// invalidate(). (The previous GL textures are disposed and the fresh ones
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

import { SEG_LINE, SEG_QUAD, SEG_CUBIC } from './primitives/seg.js';
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
 *  @property {number} [bitmapPpem] Preferred bitmap strike pixels per em; defaults to fontSizePx or32.
 *  @property {number} [fontSizePx]
 *  @property {('left'|'center'|'right'|'justify')} [align]
 * @property {('auto'|'left'|'center'|'right'|'justify')} [lastLineAlign] Final-line alignment; auto keeps paragraph alignment.
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
 *    tags to suppress: `kern` skips optional pair/contextual kerning and
 *    GPOS advance adjustments; required positioning and mark attachment remain.
 *    `liga` / `rlig` skips ligature substitution. Other
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
 *  @property {Record<string, number>|number[]|null} [varCoords]  Variable-font
 *    axis values in native axis units (`{ wght: 700, opsz: 20 }`, or an array in
 *    font axis order). Null/unset = the font's default instance. Outlines,
 *    advances, metrics and GPOS pair kerning all follow the instance.
 *  @property {import('./font/fontAsset.js').MantleFontAsset[]} [fallbacks]  Fonts
 *    consulted, in order, for a code point the primary font does not map.
 *  @property {string} [language]  OpenType language system tag (`'TRK '`,
 *    `'MAR '`, ...; shorter strings are padded and uppercased) used to pick the
 *    language-specific features inside each run's script.
 *  @property {('spec'|'harfbuzz')} [compat]  Shaping compatibility. `'spec'` (default)
 *    follows the OpenType, AAT and Unicode specifications; `'harfbuzz'` reproduces the
 *    places where HarfBuzz departs from them (today: AAT `trak` tracking, which HarfBuzz
 *    applies at 12 pt when no size is given).
 *  @property {number} [ptem]  Point size HarfBuzz compatibility reads size-dependent
 *    tables at (`trak`); default 12.
 *  @property {boolean} [preferAat]  A font with both AAT (`morx`/`mort`, `kerx`) and OpenType (GSUB, GPOS) tables is
 *    shaped by the AAT ones (default true). `false` keeps GSUB/GPOS; `compat: 'harfbuzz'` uses HarfBuzz's table priorities.
 *  @property {boolean} [useJstf]  Use the font's JSTF priorities when justifying (default true; the reader must be
 *    registered, as the `font` barrel and `autoRegisterForFont` do).
 */

/** The handle createTextBundle resolves to. Declared here because the public
 *  @returns below names it — and the generated types/textBundle.d.ts inherits
 *  that name, so without a declaration every TypeScript consumer of
 *  createTextBundle hit `Cannot find name 'MantleTextBundle'` (masked locally
 *  by skipLibCheck, not masked in a strict consumer build).
 *
 *  @typedef {Object} MantleTextBundle
 *  @property {object} bundle       the live GL bundle; identity is STABLE
 *    across setText/setStyle, so bound draw handles stay valid
 *  @property {string} text         current content
 *  @property {TextStyle|Object} style
 *  @property {import('./font/fontAsset.js').MantleFontAsset} font
 *  @property {object|null} fontMetrics  font-wide em-normalized metrics;
 *    stable for a given font + axis configuration
 *  @property {object|null} runMetrics   per-string typographic metrics —
 *    typoBBox [x,y,w,h], firstBaselineY, lastBaselineY, baselineY, lineCount,
 *    lastLineAdvance. The SUPPORTED surface for laying labels out.
 *  @property {(text?: string, style?: TextStyle|Object) => Promise<object>} setText
 *    mutate content (and optionally style); resolves to the same live bundle
 *  @property {(style?: TextStyle|Object) => Promise<object>} setStyle
 *  @property {() => void} dispose
 */

/** @typedef {Object} CreateTextBundleOpts
 *  @property {import('./font/fontAsset.js').MantleFontAsset} font
 *  @property {string} [text]                 initial content; default ''
 *  @property {TextStyle|Object} [style]      initial style
 *  @property {boolean} [markup]              treat text as rich-text markup; default false
 *  @property {boolean} [retainText]          keep a reconstructable text source
 *    on the bundle (`bundle.textSource`) so the no-WebGL fallback and frame
 *    export can re-emit the run; default false
 *  @property {boolean} [retainSource]        alias of `retainText`, named for
 *    symmetry with importSvg's option
 *  @property {boolean} [gwnTree]             bake the GWN run tree (required by
 *    every GWN fill kernel); default false
 *  @property {boolean} [recolor]             this bundle is drawn with recolor state
 *    (colorMatrix / channelLerp / palette). Fixes the fill variant at creation —
 *    and, because setText/setStyle REBUILD the bundle, it is re-declared on every
 *    rebuild so a recolored label never silently drops back to the lean variant.
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
  // Recolor is a BUNDLE property, and setText/setStyle rebuild the bundle — so
  // carry the declaration on the HANDLE and re-apply it to every rebuild, else the
  // first setText on a tinted label would drop it back to the non-recolor variant
  // and self-heal (recompile) on the very next draw.
  const recolor = !!opts.recolor;
  const gwnTree = !!opts.gwnTree;
  let text = typeof opts.text === 'string' ? opts.text : '';
  let style = opts.style || {};

  let disposed = false;
  // Rebuild generation: each setText/setStyle takes the next one, and a rebuild
  // whose shaping lands after a newer request began is dropped, so the bundle
  // always reflects the LAST request, never the last one to finish.
  let generation = 0;
  let bundle = await rebuild(gl, font, text, style, markup, null, recolor, gwnTree);
  const applyTextSource = () => {
    if (retainText && bundle && (bundle.numShapes | 0) > 0)
      bundle.textSource = buildTextSource(text, style, font, bundle);
  };
  applyTextSource();
  // `text` and `style` name the last request; these name what the bundle shows. A rebuild that fails takes the request back, or the equal-text early return below would swallow the
  // retry and the label would stay as it was for good.
  let shownText = text,
    shownStyle = style;
  // The newest request while its rebuild runs: a repeat of it waits for it, instead of resolving at once with the previous content.
  /** @type {{ text: string, done: Promise<any> }|null} */
  let inFlight = null;
  const request = (nextText, nextStyle) => {
    text = nextText;
    style = nextStyle;
    const mine = ++generation;
    const done = (async () => {
      try {
        const built = await rebuild(
          gl,
          font,
          nextText,
          nextStyle,
          markup,
          bundle,
          recolor,
          gwnTree,
          () => disposed || mine !== generation,
        );
        if (mine !== generation && !disposed) return bundle;
        bundle = built;
        shownText = nextText;
        shownStyle = nextStyle;
        applyTextSource();
        return bundle;
      } catch (e) {
        if (mine === generation) {
          text = shownText;
          style = shownStyle;
        }
        throw e;
      } finally {
        if (mine === generation) inFlight = null;
      }
    })();
    inFlight = { text: nextText, done };
    return done;
  };

  return /** @type {MantleTextBundle} */ ({
    get bundle() {
      return bundle;
    },
    get text() {
      return text;
    },
    get style() {
      return style;
    },
    get font() {
      return font;
    },
    /** Font-wide em-normalized metrics. Stable across setText()
     *  for the same font + axis configuration; cache once. */
    get fontMetrics() {
      return bundle ? bundle.fontMetrics : null;
    },
    /** Per-current-string typographic metrics
     *  ({@link import('./font/textSections.js').RunMetrics}), em-relative
     *  in the bundle's local coord space. Refreshed on every setText() /
     *  setStyle(). This is the SUPPORTED metrics surface for layout
     *  consumers — position labels against `runMetrics.typoBBox`
     *  (ascent-to-descent rect, stable across strings with/without
     *  descenders) and the baselines, not the ink-tight globalBBox.
     *  Fields: typoBBox [x,y,w,h], firstBaselineY, lastBaselineY,
     *  baselineY, lineCount, lastLineAdvance. */
    get runMetrics() {
      return bundle ? bundle.runMetrics : null;
    },

    /** Mutate content and (optionally) style; rebuild + re-upload.
     *  IN-PLACE: `tb.bundle` keeps its object identity, so existing
     *  draw handles remain bound and pick the new glyphs up on their
     *  next draw. Resolves to the (same) live bundle once it shows this text; a repeat of
     *  a call still running waits for it. A rebuild that fails rejects and leaves `text`
     *  and `style` naming what the bundle still shows, so the same call can be retried. */
    async setText(newText, newStyle) {
      if (disposed) return bundle;
      const nextText = typeof newText === 'string' ? newText : '';
      // A caller that re-applies the current label has no observable update.
      // More importantly, rebuilding here allocates every glyph texture and
      // invalidates the bound handle's geometry. Do not infer equality for a
      // supplied style: callers may deliberately mutate and re-submit one.
      if (newStyle == null) {
        if (inFlight) {
          if (inFlight.text === nextText) return inFlight.done;
        } else if (nextText === shownText) return bundle;
      }
      return request(nextText, newStyle != null ? newStyle : style);
    },

    /** Mutate style only; keep current text. Same in-place identity
     *  contract as setText(). */
    async setStyle(newStyle) {
      if (disposed) return bundle;
      return request(text, newStyle != null ? newStyle : style);
    },

    /** Free the GL textures. Idempotent. After it `bundle` is null and setText / setStyle resolve to null
     *  without building anything (a rebuild already awaiting its shaping is dropped when it lands). */
    dispose() {
      disposed = true;
      if (bundle && typeof bundle.dispose === 'function') bundle.dispose();
      bundle = null;
    },
  });
}

// ---- Internal helpers ----------------------------------------------

/// The segment types any string of this font can have (a bit per SEG_*; glyph outlines have no arcs).
function fontSegTypes(font) {
  const t = font && font._tables;
  return t && (t.cff || t.cff2)
    ? (1 << SEG_LINE) | (1 << SEG_CUBIC)
    : (1 << SEG_LINE) | (1 << SEG_QUAD);
}

async function rebuild(gl, font, text, style, markup, prevBundle, recolor, gwnTree, isDisposed) {
  const { sections, bundleSrc } = await buildTextSections(font, text, style, markup, {
    gwnTree: !!gwnTree,
  });
  // A text bundle's segment types are its FONT's, not this string's: setText re-flows the bundle in place, and a string's own types (a "0" is all curves, a "1"
  // all lines) would change its fill program on every re-flow -- a program the loading call never built. The outline format bounds every string: TrueType
  // glyphs are lines and quads, CFF lines and cubics. (The run's own mask is kept in the union: a path that ever produced another type stays correct.)
  if (sections && bundleSrc && bundleSrc.numShapes)
    sections.segTypeMask = sections.segTypeMask | 0 | fontSegTypes(font);
  // disposed while the shaping was in flight: build no GL objects for a handle that has none to free them
  if (isDisposed && isDisposed()) return null;
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
  const next =
    !bundleSrc || bundleSrc.numShapes === 0
      ? makeEmptyBundle(font)
      : createBundle(gl, sections, { recolor: !!recolor });
  next.reflowable = true; // its content is replaced in place: the warm image holds every program a string of this font can need (fillPass wantKeysOf)
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
  const nextGen = (target._geomGen | 0) + 1;
  if (typeof target.dispose === 'function') target.dispose();
  for (const k of Object.getOwnPropertyNames(target)) delete target[k];
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(next));
  target._geomGen = nextGen;
  // dispose() above stamped _disposed on target; the delete loop removed
  // it, and `next` was never disposed — make the live state explicit.
  target._disposed = false;
  // Ownership has transferred to target; next's
  // fields still point at them. createBundle already enqueued next for fill-prewarm,
  // so it is sitting in the PSO-warm queue — and on the NEXT setText, target.dispose()
  // deletes exactly those textures. A live shell would then hand a deleted texture
  // straight to beginFillPass ("bindTexture: attempt to use a deleted object"), once per
  // warm, for every text bundle a scene retypes (a score, a label, a timer).
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
 *  lands where the outlined glyphs would. Without a fixed layout box the
 *  bundle is ink-tight and starts at x=0, so the anchor is 'start' at x=0.
 *  Inside a fixed layout box (layoutWidthEm / layoutWidthPx) a centered or
 *  right-aligned line sits at the box's center or right edge, so the anchor
 *  is 'middle' at boxW/2 or 'end' at boxW. */
function buildTextSource(text, style, font, bundle) {
  const rm = bundle && bundle.runMetrics;
  const s = style || {};
  let boxW = 0;
  if (s.layoutWidthEm > 0) boxW = s.layoutWidthEm;
  else if (s.layoutWidthPx > 0 && s.fontSizePx > 0) boxW = s.layoutWidthPx / s.fontSizePx;
  const align = s.align || 'left';
  const anchored = boxW > 0 && (align === 'center' || align === 'right');
  return {
    text: text || '',
    // [r,g,b,a] in [0,1] — serialized to a CSS color at export time.
    fill: s.fill
      ? [s.fill[0], s.fill[1], s.fill[2], s.fill.length > 3 ? s.fill[3] : 1]
      : [0, 0, 0, 1],
    fontSizeEm: 1, // em-normalized geometry
    fontSizePx: typeof s.fontSizePx === 'number' ? s.fontSizePx : null,
    originX: anchored ? (align === 'center' ? boxW / 2 : boxW) : 0,
    baselineY: rm ? rm.firstBaselineY : 0,
    textAnchor: anchored ? (align === 'center' ? 'middle' : 'end') : 'start',
    align: s.align || 'left',
    // Best-effort family hint; the consumer must have the font available
    // (e.g. via @font-face) for a faithful render. Omitted when unknown.
    fontFamily: (font && (font.familyName || font.family || font.name)) || null,
    lineCount: rm ? rm.lineCount : 1,
    // Style fields that shaped the outlines but have no SVG <text> equivalent here; the export names them in
    // its notes instead of silently handing back a differently-shaped <text>.
    unrecovered: ['varCoords', 'fallbacks', 'language', 'compat', 'preferAat', 'useJstf'].filter(
      (k) => s[k] != null && !(Array.isArray(s[k]) && s[k].length === 0),
    ),
  };
}
