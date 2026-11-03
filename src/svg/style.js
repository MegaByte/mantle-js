// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/style.js — element style resolution (inline style="…", stylesheet
// rules, presentation attributes) + the SVG visibility cascade +
// stroke/fill style readers.
//
// Reads from the active stylesheet
// (svg/stylesheet.js) for matched CSS rules.

import { parseColor } from './color.js';
import { mantleWarn } from '../core/diagnostics.js';
import { lookupCssProp } from './stylesheet.js';
import { parseLength, parseLengthOr, splitLengthList } from './length.js';
import { readDeclarations, isValidPropertyValue } from './cssDecl.js';
import { CAP_ENUM, JOIN_ENUM, CAP_BUTT, JOIN_MITER } from './segment.js';

/// Parse a single "k: v; …" inline style string into a key→value dict (readDeclarations: comments, quoting, case and
/// invalid-value rules). A value keeps a trailing " !important", which getStyleProp reads; a normal declaration never
/// replaces an !important one. Returns {} for empty/null input.
export function parseStyleString(s) {
  const out = {};
  if (!s) return out;
  const important = {};
  for (const d of readDeclarations(s)) {
    if (important[d.name] && !d.important) continue;
    out[d.name] = d.important ? d.value + ' !important' : d.value;
    if (d.important) important[d.name] = true;
  }
  return out;
}

// ---- INHERITANCE PARENTS -------------------------------------------------------
// An inherited property comes from the element's parent IN THE RENDERED TREE, which is not always its
// DOM parent: a <use> instantiates its target as ITS child (SVG 2 §5.6.3), so the target's DOM
// ancestors under <defs> contribute nothing and the <use> and its ancestors do; pattern, clipPath and
// mask content inherits from the pattern / clipPath / mask element, never from the element that
// references it. The walker keeps that parent chain -- the elements it is inside, outermost first --
// and registers it for the document it walks. Every inherited read below goes down the DOM only as
// far as the element the walker is on (a <tspan>'s own <text>, say), then along the chain. With no
// chain registered, or for an element outside the walked subtree (marker content, parsed from the
// DOM), it is the plain DOM walk.
//
// Keyed by Document like the stylesheet (svg/stylesheet.js): imports run concurrently, but a walk is
// synchronous and one Document is only ever walked by its own import.
const _chainByDoc = new WeakMap();
/// Register the walker's inheritance-parent stack for `doc` (mutated in place as it walks), or clear it.
export function setInheritanceChain(doc, chain) {
  if (!doc) return;
  if (chain) _chainByDoc.set(doc, chain);
  else _chainByDoc.delete(doc);
}
/// The first non-null `pick(ancestor)` over `el` and its inheritance ancestors, nearest first.
function firstInherited(el, pick) {
  const chain = el && el.ownerDocument ? _chainByDoc.get(el.ownerDocument) : null;
  const top = chain && chain.length ? chain[chain.length - 1] : null;
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
    if (cur === top) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const v = pick(chain[i]);
        if (v != null) return v;
      }
      return null;
    }
    const v = pick(cur);
    if (v != null) return v;
  }
  return null;
}

// WeakMap caches the parsed style="..." object per element so repeated
// getStyleProp calls on the same element (getShapeStyles fires 15+ per
// shape) don't re-parse. WeakMap entries are GC'd along with the DOM
// nodes when the import finishes.
const _parsedStyleCache = new WeakMap();

export function getParsedStyle(el) {
  let s = _parsedStyleCache.get(el);
  if (s === undefined) {
    s = parseStyleString(el.getAttribute('style') || '');
    _parsedStyleCache.set(el, s);
  }
  return s;
}

function lookupCustomProp(el, name) {
  return firstInherited(el, (cur) => {
    const inline = getParsedStyle(cur);
    const fromCss = lookupCssProp(cur, name);
    // !important author rule beats inline; else inline beats a normal rule.
    if (inline[name] != null && /\s*!important\s*$/i.test(inline[name]))
      return inline[name].replace(/\s*!important\s*$/i, '');
    if (fromCss != null && fromCss.important && fromCss.value !== '') return fromCss.value;
    if (inline[name] != null) return inline[name];
    if (fromCss != null && fromCss.value !== '') return fromCss.value;
    return null;
  });
}

// var(--name) or var(--name, fallback). The fallback group tolerates one
// nested paren level (e.g. a nested var()/rgb()), and the whole result is
// re-scanned so nested var() resolves recursively.
const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*?))?\s*\)/gi;

/// Substitute CSS `var(--token[, fallback])` references in a property
/// value against the custom-property cascade. Returns the value with all
/// resolvable references replaced; an unresolvable reference with no
/// fallback is left verbatim (so the downstream parser fails to its own
/// default, matching CSS "invalid at computed-value time" → initial).
function resolveVars(el, value, depth) {
  if (typeof value !== 'string' || value.indexOf('var(') < 0) return value;
  if (depth >= 16) return value; // cycle / runaway guard
  return value.replace(VAR_RE, (m, rawName, fallback) => {
    const name = rawName.toLowerCase();
    const resolved = lookupCustomProp(el, name);
    if (resolved != null && resolved !== '') return resolveVars(el, resolved.trim(), depth + 1);
    if (fallback != null) return resolveVars(el, fallback.trim(), depth + 1);
    return m; // unresolved, no fallback
  });
}

/// Resolve an SVG style property on `el`. Search order matches the CSS
/// cascade for SVG presentation styling: !important stylesheet rule →
/// inline style="…" → normal-importance stylesheet rule → presentation
/// attribute → `fallback`. Any CSS `var(--token)` references in the
/// resolved value are substituted from the custom-property cascade.
export function getStyleProp(el, name, fallback, resolveCustomProperties = true) {
  let v = null;
  const fromCss = lookupCssProp(el, name);
  const inline = getParsedStyle(el)[name];
  const inlineImportant = inline != null && /\s*!important\s*$/i.test(inline);
  if (inlineImportant) v = inline.replace(/\s*!important\s*$/i, '');
  else if (fromCss && fromCss.important) v = fromCss.value;
  else if (inline) v = inline;
  if (v == null && fromCss) v = fromCss.value;
  if (v == null) {
    // An invalid presentation attribute is ignored as an invalid declaration is (the lower layers then apply).
    const fromAttr = el.getAttribute(name);
    if (fromAttr && isValidPropertyValue(name, fromAttr)) v = fromAttr;
  }
  if (v == null) return fallback;
  if (resolveCustomProperties && v.indexOf('var(') >= 0) return resolveVars(el, v, 0);
  return v;
}

/// The CSS-layer value of `name` on `el` (an !important rule, inline style or a rule, in the getStyleProp order) with
/// the presentation attribute NOT consulted, or null when no CSS declaration sets it. For a property whose attribute
/// form has a different grammar from the CSS one (`transform`), where the attribute is read by its own parser.
export function getCssProp(el, name) {
  let v = null;
  const fromCss = lookupCssProp(el, name);
  const inline = getParsedStyle(el)[name];
  if (inline != null && /\s*!important\s*$/i.test(inline))
    v = inline.replace(/\s*!important\s*$/i, '');
  else if (fromCss && fromCss.important) v = fromCss.value;
  else if (inline) v = inline;
  if (v == null && fromCss) v = fromCss.value;
  if (v == null) return null;
  return v.indexOf('var(') >= 0 ? resolveVars(el, v, 0) : v;
}

const initialColors = new WeakMap();

export function setInitialColor(root, color) {
  if (color != null) initialColors.set(root, color);
}

export function resolveCurrentColor(el) {
  // A concrete color only -- `currentColor` and `inherit` on an ancestor mean "keep walking".
  const c = firstInherited(el, (cur) => {
    const v = getStyleProp(cur, 'color', null);
    return v && !/^(currentcolor|inherit|unset)$/i.test(v.trim())
      ? v
      : (initialColors.get(cur) ?? null);
  });
  return c != null ? c : 'black';
}

/// `value` with `currentcolor` resolved against the element's `color`: a bare keyword becomes the color, and a `currentcolor` named inside a
/// color function (color-mix(in srgb, currentcolor, red), rgb(from currentcolor r g b), light-dark(currentcolor, ..)) is replaced in place,
/// so the color parser sees a concrete color (it has no element to ask).
export function withCurrentColor(el, value) {
  if (typeof value !== 'string' || !/currentcolor/i.test(value)) return value;
  const t = value.trim();
  return /^currentcolor$/i.test(t)
    ? resolveCurrentColor(el)
    : t.replace(/currentcolor/gi, () => resolveCurrentColor(el));
}

/// Read fill / stroke / stroke-width with all SVG opacity multipliers
/// applied. Resolves currentColor against the element's color cascade.
/// Returns { fillRgba, strokeRgba, sw, fillNone } — premultiplied-safe
/// alphas. `fillNone` is true iff the resolved fill paint is literally
/// `none` (vs a real color that merely happens to be fully transparent,
/// e.g. via fill-opacity:0). Callers that keep otherwise-invisible shapes
/// for stable morph topology use it to distinguish "faded out" (keep) from
/// "no fill at all" (cull).
///
/// `pfo` / `pso` are the INHERITED fill-opacity and stroke-opacity (numbers), carried by the walker
/// the way it carries `pf` / `ps` / `pw`: both properties inherit (SVG 2 §13.3, §13.5.1), and a DOM
/// ancestor walk cannot find them, because a <use> walks its target in place under <defs>.
/// The result also returns the values descendants inherit (`fillOpacity`, `strokeOpacity`)
/// and the paint before them (`fillPaintRgba`, `strokePaintRgba`), which is what a <tspan> that
/// names its own fill-opacity has to start from.
///
/// `paint` ({ fill?, stroke? }, optional) replaces the paint STRING read from the cascade: the walker passes the
/// fallback (or `none`) of a url() paint whose server does not exist, and the resolved text of one that does.
/// `paint.noOpacity` leaves the element's `opacity` out of the paint alpha: a group the walker opened carries it.
export function getShapeStyles(
  el,
  pf,
  ps,
  pw,
  pfo = 1,
  pso = 1,
  viewport,
  clipContent = false,
  paint = null,
) {
  if (clipContent)
    return {
      fillRgba: [1, 1, 1, 1],
      strokeRgba: [0, 0, 0, 0],
      sw: 0,
      fillNone: false,
      strokeNone: true,
      fillOpacity: 1,
      strokeOpacity: 1,
      fillPaintRgba: [1, 1, 1, 1],
      strokePaintRgba: [0, 0, 0, 0],
    };
  let fill = paint && paint.fill != null ? paint.fill : getPaintProp(el, 'fill', pf);
  let stroke = paint && paint.stroke != null ? paint.stroke : getPaintProp(el, 'stroke', ps);
  const fillNone = (fill || '').trim().toLowerCase() === 'none';
  // No stroke at all: `none`, or no element in the cascade names a stroke and the import default is itself unpainted
  // (importSvg's defaultStroke is `transparent`, which stands for the SVG initial value `none` here).
  const strokeNone =
    (stroke || '').trim().toLowerCase() === 'none' ||
    (/^(?:transparent|none)$/i.test((stroke || '').trim()) &&
      getInheritedStyleProp(el, 'stroke', null) == null);

  if (fill) fill = withCurrentColor(el, fill);
  if (stroke) stroke = withCurrentColor(el, stroke);
  const fillRgba = parseColor(fill).slice();
  const strokeRgba = parseColor(stroke).slice();
  const sw = getStrokeWidth(el, pw, viewport, false);
  // Apply opacity attributes/style. `opacity` is the parent multiplier;
  // `fill-opacity` / `stroke-opacity` are per-channel multipliers. SVG
  // composes them as final.alpha = base.alpha * opacity * channel-opacity.
  // `opacity` does not inherit; the two channel opacities do, so an element that does not name one
  // takes its parent's. Each is clamped to [0, 1] on its own, as a used value is.
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const op =
    paint && paint.noOpacity ? 1 : clamp01(parseAlphaOr(getStyleProp(el, 'opacity', null), 1));
  const fop = parseAlphaOr(getStyleProp(el, 'fill-opacity', null), pfo);
  const sop = parseAlphaOr(getStyleProp(el, 'stroke-opacity', null), pso);
  // The color's own alpha is zero (`transparent`, `rgba(.., 0)`): a color with no hue of its own to interpolate (CSS Color 4 premultiplied).
  const fillColorClear = fillRgba[3] === 0;
  fillRgba[3] *= op;
  strokeRgba[3] *= op;
  const fillPaintRgba = fillRgba.slice(),
    strokePaintRgba = strokeRgba.slice();
  fillRgba[3] *= clamp01(fop);
  strokeRgba[3] *= clamp01(sop);
  return {
    fillRgba,
    strokeRgba,
    sw,
    fillNone,
    strokeNone,
    fillOpacity: fop,
    strokeOpacity: sop,
    fillPaintRgba,
    strokePaintRgba,
    fillColorClear,
  };
}

/// fill or stroke on `el`, or `parent` (the inherited paint) when it names none or says `inherit` / `unset`: both
/// properties inherit, so the keywords mean the parent's computed value.
export function getPaintProp(el, name, parent) {
  const v = getStyleProp(el, name, parent);
  if (v === parent || v == null) return v;
  const t = v.trim().toLowerCase();
  if (t === 'inherit' || t === 'unset' || t === 'revert' || t === 'revert-layer') return parent;
  // The initial values (SVG 2 13.2): fill is black, stroke is none.
  return t === 'initial' ? (name === 'stroke' ? 'none' : 'black') : v;
}

/// A NON-inherited property (stop-color, flood-color, ...): the declared value, else `initial`. `inherit` takes the
/// parent element's computed value (CSS Cascade 4 §7.2), found by walking up the DOM, and `initial`, `unset` and
/// `revert` give the initial value. The DOM parent is the right parent for the elements that use this (a <stop>'s
/// gradient, a filter primitive's <filter>), which are never instantiated elsewhere.
export function getNonInheritedProp(el, name, initial) {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
    const v = getStyleProp(cur, name, null);
    if (v == null) return initial;
    const t = v.trim().toLowerCase();
    if (t === 'inherit') continue;
    if (t === 'initial' || t === 'unset' || t === 'revert' || t === 'revert-layer') return initial;
    return v;
  }
  return initial;
}

// font-size keywords as Chrome and Firefox compute them at the initial `medium` (16 px).
const FONT_SIZE_KEYWORDS = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};
export const INITIAL_FONT_SIZE = 16;

/// The computed font-size of `el` in user units: its own `font-size` resolved against the parent's computed size
/// `parentPx` (and `rootPx` for rem), else `parentPx`. A percentage and em are of the parent's size, as CSS Fonts 4
/// §2.5 has it; `larger` / `smaller` step by 1.2; an unparseable or negative value is ignored.
export function resolveFontSize(el, parentPx, rootPx) {
  const raw = getStyleProp(el, 'font-size', null);
  if (raw == null) return parentPx;
  const t = raw.trim().toLowerCase();
  if (!t || t === 'inherit' || t === 'unset') return parentPx;
  if (t === 'initial') return INITIAL_FONT_SIZE;
  if (Object.hasOwn(FONT_SIZE_KEYWORDS, t)) return FONT_SIZE_KEYWORDS[t];
  if (t === 'larger') return parentPx * 1.2;
  if (t === 'smaller') return parentPx / 1.2;
  const v = parseLength(t, {
    fontSize: parentPx,
    rootFontSize: rootPx,
    parentWidth: parentPx,
    parentHeight: parentPx,
  });
  return Number.isFinite(v) && v >= 0 ? v : parentPx;
}

/// { fontSize, rootFontSize } of `el` taken down the DOM from the document element, for an element the walker does
/// not reach through its rendered-tree chain (the content of a clipPath, mask or pattern; a filter primitive).
export function domFontSize(el) {
  const chain = [];
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) chain.push(cur);
  let px = INITIAL_FONT_SIZE,
    rootPx = INITIAL_FONT_SIZE;
  for (let i = chain.length - 1; i >= 0; i--) {
    px = resolveFontSize(chain[i], px, rootPx);
    if (i === chain.length - 1) rootPx = px;
  }
  return { fontSize: px, rootFontSize: rootPx };
}

const ALPHA_PARSE_CONTEXT = { parentWidth: 1 };

/// An <alpha-value> is a number or percentage of one, including CSS math.
/// Empty, inherited or invalid values use the caller's fallback.
export function parseAlphaOr(v, fallback) {
  if (v == null) return fallback;
  const t = String(v).trim();
  if (!t || /^(?:inherit|unset|revert|revert-layer)$/i.test(t)) return fallback;
  if (/^initial$/i.test(t)) return 1; // the initial value of every alpha property
  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : fallback;
  }
  return parseLengthOr(t, fallback, ALPHA_PARSE_CONTEXT);
}

/// The fill-opacity and stroke-opacity `el` passes to its children: its own, else the inherited
/// `pfo` / `pso`. The walker carries these the way it carries fill, stroke and stroke-width.
export function inheritedChannelOpacities(el, pfo, pso) {
  return {
    fo: parseAlphaOr(getStyleProp(el, 'fill-opacity', null), pfo),
    so: parseAlphaOr(getStyleProp(el, 'stroke-opacity', null), pso),
  };
}

export function isDisplayed(el) {
  const display = getStyleProp(el, 'display', '');
  return !(display && display.toLowerCase() === 'none');
}

export function isPaintable(el) {
  if (!isDisplayed(el)) return false;
  const visibility = getStyleProp(el, 'visibility', '');
  return !(visibility && visibility.toLowerCase() === 'hidden');
}

const POINTER_EVENTS = new Set([
  'auto',
  'bounding-box',
  'visiblepainted',
  'visiblefill',
  'visiblestroke',
  'visible',
  'painted',
  'fill',
  'stroke',
  'all',
  'none',
]);

/// The computed `pointer-events` of `el` (SVG 2 interact.html; inherited, initial `auto`), lowercase. The nearest
/// element in the cascade that declares a valid value decides; `inherit` and `unset` keep walking, `initial` ends at
/// the initial value, and an invalid value is ignored as CSS ignores it.
export function getPointerEvents(el) {
  const v = firstInherited(el, (cur) => {
    const t = (getStyleProp(cur, 'pointer-events', '') || '').trim().toLowerCase();
    if (!t || t === 'inherit' || t === 'unset') return null;
    if (t === 'initial') return 'auto';
    return POINTER_EVENTS.has(t) ? t : null;
  });
  return v != null ? v : 'auto';
}

export function isEffectivelyVisible(el) {
  const v = firstInherited(el, (cur) => {
    const lower = (getStyleProp(cur, 'visibility', '') || '').toLowerCase();
    if (lower === 'visible' || lower === 'initial') return true;
    if (lower === 'hidden' || lower === 'collapse') return false;
    return null; // unset, 'inherit' or anything else: keep walking
  });
  return v != null ? v : true;
}

/// SVG/CSS-inheritable property reader. Walks the inheritance ancestors (see firstInherited)
/// looking for the first explicit setting (style attr, matched CSS,
/// or presentation attr), bottoming out at the supplied default.
/// Use for properties listed as inheritable in SVG 1.1 §6.4 +
/// CSS Cascade §6.2: stroke-linecap, stroke-linejoin,
/// stroke-miterlimit, fill-rule, font-family/size/weight, etc.
///
/// Non-inheritable container properties (clip-path, mask, filter,
/// opacity, mix-blend-mode) use the explicit stack model in
/// svg/importer.js instead.
export function getInheritedStyleProp(el, name, fallback) {
  const v = firstInherited(el, (cur) => {
    const x = getStyleProp(cur, name, null);
    if (x == null || x === '') return null;
    // Every property read here inherits, so `unset` and `revert` (no user or agent rule sets it) ask the parent as `inherit` does.
    return /^(?:inherit|unset|revert|revert-layer)$/i.test(x.trim()) ? null : x;
  });
  return v != null ? v : fallback;
}

export function getCapsJoins(el) {
  const cap = (getInheritedStyleProp(el, 'stroke-linecap', 'butt') || 'butt').toLowerCase();
  const join = (getInheritedStyleProp(el, 'stroke-linejoin', 'miter') || 'miter').toLowerCase();
  const mlStr = getInheritedStyleProp(el, 'stroke-miterlimit', '4');
  const miterLimit = parseLengthOr(mlStr, 4);
  return {
    capStyle: CAP_ENUM[cap] ?? CAP_BUTT,
    joinStyle: JOIN_ENUM[join] ?? JOIN_MITER,
    miterLimit,
  };
}

export function getFillRule(el) {
  const fr = (getInheritedStyleProp(el, 'fill-rule', 'nonzero') || 'nonzero').toLowerCase();
  return fr === 'evenodd' ? 'evenodd' : 'nonzero';
}

/// The winding rule a shape inside a <clipPath> contributes with: `clip-rule` (inherited, initial
/// nonzero), not `fill-rule` (CSS Masking 1 §6.2.1).
export function getClipRule(el) {
  const cr = (getInheritedStyleProp(el, 'clip-rule', 'nonzero') || 'nonzero').toLowerCase();
  return cr === 'evenodd' ? 'evenodd' : 'nonzero';
}

export function getStrokeWidth(el, fallback, viewport, inherited = true) {
  let context;
  const pick = (cur) => {
    const raw = getStyleProp(cur, 'stroke-width', null);
    if (raw == null || /^(inherit|unset)$/i.test(raw.trim())) return null;
    if (context === undefined && viewport) context = { ...viewport, axis: 'd' };
    const width = /^initial$/i.test(raw.trim()) ? 1 : parseLengthOr(raw, NaN, context);
    return Number.isFinite(width) && width >= 0 ? width : null;
  };
  const width = inherited ? firstInherited(el, pick) : pick(el);
  return width == null ? fallback : width;
}

export function getStrokeDashes(el, viewport, scale = 1) {
  let context;
  const read = (cur, name) => {
    const raw = getStyleProp(cur, name, null);
    return raw == null || /^(inherit|unset)$/i.test(raw.trim()) ? null : raw.trim();
  };
  const parse = (value) => {
    if (context === undefined && viewport) context = { ...viewport, axis: 'd' };
    return parseLengthOr(value, NaN, context);
  };
  let dashArray =
    firstInherited(el, (cur) => {
      const raw = read(cur, 'stroke-dasharray');
      if (raw == null) return null;
      if (/^(none|initial)$/i.test(raw)) return [];
      const tokens = splitLengthList(raw);
      if (!tokens) return null;
      const values = tokens.map(parse);
      return values.every((v) => Number.isFinite(v) && v >= 0) ? values : null;
    }) || [];
  if (!dashArray.some((v) => v > 0)) dashArray = [];
  dashArray = dashArray.map((v) => v * scale);
  if (dashArray.length & 1) dashArray = dashArray.concat(dashArray);
  dashArray = fitDashTable(dashArray);
  const offset = firstInherited(el, (cur) => {
    const raw = read(cur, 'stroke-dashoffset');
    if (raw == null) return null;
    const value = /^initial$/i.test(raw) ? 0 : parse(raw);
    return Number.isFinite(value) ? value : null;
  });
  let dashOffset = (offset || 0) * scale;
  // The phase is the offset modulo the cycle. The table stores it as a float32, which at 1e7 and beyond has lost the
  // fraction of a pixel the phase is made of; reducing it here, in float64, keeps it exact at any offset. An offset inside one
  // cycle is stored as authored.
  const cycle = dashArray.reduce((a, b) => a + b, 0);
  if (cycle > 0 && Math.abs(dashOffset) >= cycle) {
    dashOffset %= cycle;
    if (dashOffset < 0) dashOffset += cycle;
  }
  return { dashArray, dashOffset };
}

/// The dash table row holds this many pattern floats (bundleFinalize.js: 16 RGBA texels minus the header texel).
export const DASH_TABLE_MAX = 60;

/// Fit an even-length dash array to the table row. A pattern over the row that is a whole repetition of a shorter even-length one ("5 5 5 5 ...",
/// or an odd list doubled by the spec) is stored as that shorter pattern, which draws the same. One that is still longer than the
/// row cannot be stored; it is declined WITH A WARNING and the stroke is drawn solid (the documented limit: patterns of at most
/// 60 values after that reduction), rather than storing 60 values against the cycle of all of them.
function fitDashTable(arr) {
  let a = arr;
  if (a.length <= DASH_TABLE_MAX) return a;
  for (let p = 2; p <= a.length / 2; p += 2) {
    if (a.length % p !== 0) continue;
    let rep = true;
    for (let i = p; i < a.length && rep; i++) if (a[i] !== a[i - p]) rep = false;
    if (rep) {
      a = a.slice(0, p);
      break;
    }
  }
  if (a.length > DASH_TABLE_MAX) {
    mantleWarn(
      `svgImporter: stroke-dasharray with ${a.length} values exceeds the ${DASH_TABLE_MAX}-value dash table; drawn solid`,
    );
    return [];
  }
  return a;
}
