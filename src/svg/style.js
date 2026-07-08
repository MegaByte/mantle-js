// svg/style.js — element style resolution (inline style="…", stylesheet
// rules, presentation attributes) + the SVG visibility cascade +
// stroke/fill style readers.
//
// Reads from the active stylesheet
// (svg/stylesheet.js) for matched CSS rules.

import { parseColor } from './color.js';
import { lookupCssProp } from './stylesheet.js';
import { parseLength, parseLengthOr } from './length.js';
import {
  CAP_ENUM, JOIN_ENUM, CAP_BUTT, JOIN_MITER,
} from './segment.js';

/// Parse a single "k: v; …" inline style string into a key→value dict.
/// Returns {} for empty/null input.
export function parseStyleString(s) {
  const out = {};
  if (!s) return out;
  for (const pair of s.split(';')) {
    const i = pair.indexOf(':');
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i+1).trim();
  }
  return out;
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

/// Resolve a CSS custom property (`--foo`) for `el` against the
/// inheritance cascade. Custom properties inherit, so we walk the
/// ancestor chain taking the nearest definition from inline `style="…"`
/// or a matched stylesheet rule (incl. `:root{…}` on the <svg> root).
/// They are never presentation attributes, so the attribute step is
/// skipped. Names are treated case-insensitively to match how the
/// stylesheet parser lowercases declaration keys (svg/stylesheet.js).
function lookupCustomProp(el, name) {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
    const inline = getParsedStyle(cur);
    const fromCss = lookupCssProp(cur, name);
    // !important author rule beats inline; else inline beats a normal rule.
    if (fromCss != null && fromCss.important && fromCss.value !== '') return fromCss.value;
    if (inline[name] != null) return inline[name];
    if (fromCss != null && fromCss.value !== '') return fromCss.value;
  }
  return null;
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
  if (depth >= 16) return value;            // cycle / runaway guard
  return value.replace(VAR_RE, (m, rawName, fallback) => {
    const name = rawName.toLowerCase();
    const resolved = lookupCustomProp(el, name);
    if (resolved != null && resolved !== '') return resolveVars(el, resolved.trim(), depth + 1);
    if (fallback != null) return resolveVars(el, fallback.trim(), depth + 1);
    return m;                               // unresolved, no fallback
  });
}

/// Resolve an SVG style property on `el`. Search order matches the CSS
/// cascade for SVG presentation styling: !important stylesheet rule →
/// inline style="…" → normal-importance stylesheet rule → presentation
/// attribute → `fallback`. Any CSS `var(--token)` references in the
/// resolved value are substituted from the custom-property cascade.
export function getStyleProp(el, name, fallback) {
  let v = null;
  const fromCss = lookupCssProp(el, name);   // { value, important } | null
  // An author !important declaration outranks the inline style="" value.
  if (fromCss && fromCss.important) v = fromCss.value;
  if (v == null) {
    const styles = getParsedStyle(el);
    if (styles[name]) v = styles[name];
  }
  if (v == null && fromCss) v = fromCss.value;
  if (v == null) {
    const fromAttr = el.getAttribute(name);
    if (fromAttr) v = fromAttr;
  }
  if (v == null) return fallback;
  if (v.indexOf('var(') >= 0) return resolveVars(el, v, 0);
  return v;
}

/// Walk the element's ancestor chain looking for an explicit `color`
/// property (style attr, matched CSS, or color="…" presentation attr).
/// SVG's `currentColor` resolves to this; defaults to black per CSS.
/// We don't memoize because the walk is shallow in practice (rarely
/// deeper than a few <g> levels) and getShapeStyles already caches
/// the per-element parsed style dict via the WeakMap above.
export function resolveCurrentColor(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const c = getStyleProp(cur, 'color', null);
    if (c && c.toLowerCase() !== 'currentcolor' && c !== 'inherit') {
      // Found a concrete color — caller treats it as the resolved
      // value. Avoid infinite recursion via the lowercased check.
      return c;
    }
    cur = cur.parentNode;
  }
  return 'black';
}

/// Read fill / stroke / stroke-width with all SVG opacity multipliers
/// applied. Resolves currentColor against the element's color cascade.
/// Returns { fillRgba, strokeRgba, sw, fillNone } — premultiplied-safe
/// alphas. `fillNone` is true iff the resolved fill paint is literally
/// `none` (vs a real color that merely happens to be fully transparent,
/// e.g. via fill-opacity:0). Callers that keep otherwise-invisible shapes
/// for stable morph topology use it to distinguish "faded out" (keep) from
/// "no fill at all" (cull).
export function getShapeStyles(el, pf, ps, pw) {
  let fill = getStyleProp(el, 'fill', pf);
  let stroke = getStyleProp(el, 'stroke', ps);
  const fillNone = (fill || '').trim().toLowerCase() === 'none';
  // Resolve currentColor against the element's color cascade. We only
  // pay the ancestor walk when either fill OR stroke names currentColor
  // — common pattern for icon SVGs that re-skin via a single `color`
  // set on the root <svg>.
  if (fill && /^currentcolor$/i.test(fill.trim())) fill = resolveCurrentColor(el);
  if (stroke && /^currentcolor$/i.test(stroke.trim())) stroke = resolveCurrentColor(el);
  const swStr = getStyleProp(el, 'stroke-width', String(pw));
  const fillRgba = parseColor(fill).slice();
  const strokeRgba = parseColor(stroke).slice();
  // stroke-width accepts the full CSS length grammar (incl. calc/min/
  // max/clamp/var). Fallback to the parent's stroke-width on parse
  // failure to mirror SVG's cascade. calc() evaluates atomically, so
  // a bare number shorter than the entire string cannot leak through.
  let sw = 0;
  if (swStr) {
    sw = parseLengthOr(swStr, pw);
  }
  // Apply opacity attributes/style. `opacity` is the parent multiplier;
  // `fill-opacity` / `stroke-opacity` are per-channel multipliers. SVG
  // composes them as final.alpha = base.alpha * opacity * channel-opacity.
  const op = parseLengthOr(getStyleProp(el, 'opacity', '1'), 1);
  const fop = parseLengthOr(getStyleProp(el, 'fill-opacity', '1'), 1);
  const sop = parseLengthOr(getStyleProp(el, 'stroke-opacity', '1'), 1);
  fillRgba[3]   *= Math.max(0, Math.min(1, op * fop));
  strokeRgba[3] *= Math.max(0, Math.min(1, op * sop));
  return { fillRgba, strokeRgba, sw, fillNone };
}

// Two distinct visibility predicates per SVG spec:
//   display:none      → skip the whole subtree (no descendant can opt in).
//   visibility:hidden → skip THIS element's own rendering, but children
//                       with visibility:visible re-enable.
// isDisplayed answers "should we recurse into this element at all?" while
// isPaintable answers "should this element produce paint?". The walker
// keeps recursing whenever isDisplayed is true and only suppresses paint
// when isPaintable is false; a leaf shape inside a visibility:hidden
// group that itself declares visibility:visible thus renders correctly.

export function isDisplayed(el) {
  const display = getStyleProp(el, 'display', '');
  return !(display && display.toLowerCase() === 'none');
}

export function isPaintable(el) {
  if (!isDisplayed(el)) return false;
  const visibility = getStyleProp(el, 'visibility', '');
  return !(visibility && visibility.toLowerCase() === 'hidden');
}

/// Per spec, visibility is an inherited property that any descendant
/// can override to 'visible'. Walk the ancestor chain: the nearest
/// explicit declaration wins. (display:none short-circuits earlier
/// via the walker; here we only worry about visibility.) Used as a
/// per-leaf paint gate once the walker descended through a hidden
/// subtree.
export function isEffectivelyVisible(el) {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
    const v = getStyleProp(cur, 'visibility', '');
    if (!v) continue;
    const lower = v.toLowerCase();
    if (lower === 'visible') return true;
    if (lower === 'hidden' || lower === 'collapse') return false;
    // 'inherit' (or any other value) — keep walking.
  }
  return true;
}

/// SVG/CSS-inheritable property reader. Walks the ancestor chain
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
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const v = getStyleProp(cur, name, null);
    if (v != null && v !== '' && v.toLowerCase() !== 'inherit') return v;
    cur = cur.parentNode;
  }
  return fallback;
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
