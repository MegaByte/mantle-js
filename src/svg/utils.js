// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/utils.js — small generic helpers used across the importer.
//
// `elementChildren` / `switchChildMatches` are generic DOM-layer
// plumbing. `resolveIdRef` is a url(#id) parser used by gradients,
// filters, markers, clips/masks, and shape references.

// XML prefixes do not form part of an element's local name. The tagName
// fallback supports DOM adapters that omit localName.
export function elementLocalName(el) {
  if (el?.localName) return el.localName.toLowerCase();
  const name = el?.tagName || '';
  return name.slice(name.indexOf(':') + 1).toLowerCase();
}

// Keep namespace-free input supported by the existing importer, but do not
// interpret elements from another namespace as SVG primitives or definitions.
export function svgElementName(el) {
  if (el?.namespaceURI && el.namespaceURI !== 'http://www.w3.org/2000/svg') return '';
  return elementLocalName(el);
}

/// Both xmldom (Node) and the browser DOM expose .childNodes (a
/// NodeList that includes text nodes); the browser also has .children
/// but xmldom does not. Normalize to an array of element nodes
/// (nodeType === 1) that works on both.
///
/// `_mantleKids` overrides the DOM for a wrapper the importer builds around a def's content (a clip-path on a <clipPath> or <mask>, an
/// intersection of two clips): the content stays the authored elements, under their authored parents, so inheritance and selectors see
/// what the author wrote.
export function elementChildren(el) {
  if (!el) return [];
  if (el._mantleKids) return el._mantleKids;
  const out = [];
  const kids = el.childNodes || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c && c.nodeType === 1) out.push(c);
  }
  return out;
}

/// The deepest element nesting the importer walks. The walk recurses once per level, and a level costs enough stack
/// that a default Node or browser stack gives out near 850 levels; real art nests tens (design tools emit under 100).
/// 512 keeps a wide margin below the failure and far above any drawing; a deeper document is refused up front with a
/// clear error instead of a RangeError from the middle of the walk.
export const MAX_ELEMENT_DEPTH = 512;

/// Whether any element under `root` (counted from 1 at `root`) lies deeper than `limit`. Iterative, so a hostile
/// document cannot overflow the stack of the check itself.
export function elementDepthExceeds(root, limit = MAX_ELEMENT_DEPTH) {
  const stack = [root, 1];
  while (stack.length) {
    const depth = stack.pop(),
      el = stack.pop();
    if (depth > limit) return true;
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++)
      if (kids[i] && kids[i].nodeType === 1) stack.push(kids[i], depth + 1);
  }
  return false;
}

/// SVG conditional-processing test used by <switch>. Returns true
/// iff the element's requiredFeatures / requiredExtensions /
/// systemLanguage attributes (if present) all pass.
///
///
/// `features: false` skips requiredFeatures, which SVG 2 removed and browsers ignore: the test for an element
/// OUTSIDE a <switch>, where only requiredExtensions and systemLanguage are honored.
export function switchChildMatches(el, languages = null, features = true) {
  const reqExt = el.getAttribute && el.getAttribute('requiredExtensions');
  if (reqExt && reqExt.trim().length > 0) return false;
  const reqFeat = features && el.getAttribute && el.getAttribute('requiredFeatures');
  if (reqFeat && reqFeat.trim().length > 0) {
    for (const f of reqFeat.split(/\s+/)) {
      if (f && !STATIC_FEATURES.has(f)) return false;
    }
  }
  // Present-but-empty is FALSE (SVG 2 §5.8.5), and absent is true — so ask hasAttribute: xmldom's
  // getAttribute answers '' for an absent attribute.
  const hasLang = el.hasAttribute
    ? el.hasAttribute('systemLanguage')
    : !!(el.getAttribute && el.getAttribute('systemLanguage'));
  if (hasLang) {
    const tags = String(el.getAttribute('systemLanguage') || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (!tags.length) return false;
    if (!languages) return true;
    let match = false;
    for (let i = 0; i < tags.length && !match; i++) {
      const tag = tags[i];
      for (let j = 0; j < languages.length; j++) {
        const u = languages[j];
        if (
          tag === u ||
          (tag.length > u.length && tag.startsWith(u) && tag.charCodeAt(u.length) === 45) /* - */
        ) {
          match = true;
          break;
        }
      }
    }
    if (!match) return false;
  }
  return true;
}

/// The user languages a <switch>'s systemLanguage test compares against, as
/// lower-case BCP 47 tags (switchChildMatches' `languages`). `requested` is
/// importSvg's `languages` option — an array of tags, or one tag as a string.
/// Unset, it defaults to `navigator.languages`, else `navigator.language`
/// (Node 21+ defines both from the process locale), else null: no language
/// information, so every systemLanguage test passes and a <switch> renders its
/// first child that passes the other tests.
export function resolveSwitchLanguages(requested) {
  let list = null;
  if (typeof requested === 'string') list = [requested];
  else if (Array.isArray(requested)) list = requested;
  else if (typeof navigator !== 'undefined' && navigator) {
    if (Array.isArray(navigator.languages) && navigator.languages.length)
      list = navigator.languages;
    else if (typeof navigator.language === 'string' && navigator.language)
      list = [navigator.language];
  }
  if (!list) return null;
  const out = [];
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const v = t.trim().toLowerCase();
    if (v && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

// SVG 1.1 feature strings a static renderer can claim (requiredFeatures).
const STATIC_FEATURES = new Set([
  'http://www.w3.org/TR/SVG11/feature#SVG',
  'http://www.w3.org/TR/SVG11/feature#SVG-static',
  'http://www.w3.org/TR/SVG11/feature#CoreAttribute',
  'http://www.w3.org/TR/SVG11/feature#Structure',
  'http://www.w3.org/TR/SVG11/feature#BasicStructure',
  'http://www.w3.org/TR/SVG11/feature#ContainerAttribute',
  'http://www.w3.org/TR/SVG11/feature#ConditionalProcessing',
  'http://www.w3.org/TR/SVG11/feature#Image',
  'http://www.w3.org/TR/SVG11/feature#Style',
  'http://www.w3.org/TR/SVG11/feature#ViewportAttribute',
  'http://www.w3.org/TR/SVG11/feature#Shape',
  'http://www.w3.org/TR/SVG11/feature#BasicText',
  'http://www.w3.org/TR/SVG11/feature#PaintAttribute',
  'http://www.w3.org/TR/SVG11/feature#BasicPaintAttribute',
  'http://www.w3.org/TR/SVG11/feature#OpacityAttribute',
  'http://www.w3.org/TR/SVG11/feature#GraphicsAttribute',
  'http://www.w3.org/TR/SVG11/feature#BasicGraphicsAttribute',
  'http://www.w3.org/TR/SVG11/feature#Marker',
  'http://www.w3.org/TR/SVG11/feature#ColorProfile',
  'http://www.w3.org/TR/SVG11/feature#Gradient',
  'http://www.w3.org/TR/SVG11/feature#Pattern',
  'http://www.w3.org/TR/SVG11/feature#Clip',
  'http://www.w3.org/TR/SVG11/feature#BasicClip',
  'http://www.w3.org/TR/SVG11/feature#Mask',
  'http://www.w3.org/TR/SVG11/feature#Filter',
  'http://www.w3.org/TR/SVG11/feature#BasicFilter',
  'http://www.w3.org/TR/SVG11/feature#DocumentEventsAttribute',
  'http://www.w3.org/TR/SVG11/feature#GraphicalEventsAttribute',
  'http://www.w3.org/TR/SVG11/feature#AnimationEventsAttribute',
  'http://www.w3.org/TR/SVG11/feature#Cursor',
  'http://www.w3.org/TR/SVG11/feature#Hyperlinking',
  'http://www.w3.org/TR/SVG11/feature#XlinkAttribute',
  'http://www.w3.org/TR/SVG11/feature#ExternalResourcesRequired',
  'http://www.w3.org/TR/SVG11/feature#View',
  'http://www.w3.org/TR/SVG11/feature#Script',
]);

/// Split a paint value that starts with url(...) into { ref, fallback }: the `#id` it names (null for a reference
/// outside the document), and the text after the closing parenthesis (SVG 2 §13.2: `url(#g) lime` paints lime where
/// #g is missing or not a paint server). Returns null for a value that is not a url() paint.
export function parsePaintUrl(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!/^url\(/i.test(s)) return null;
  let i = 4;
  while (i < s.length && /\s/.test(s[i])) i++;
  let inner;
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    const end = s.indexOf(q, i + 1);
    if (end < 0) return null;
    inner = s.slice(i + 1, end);
    i = end + 1;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== ')') return null;
  } else {
    const end = s.indexOf(')', i);
    if (end < 0) return null;
    inner = s.slice(i, end).trim();
    i = end;
  }
  inner = inner.trim();
  return {
    ref: inner.startsWith('#') && inner.length > 1 ? inner.slice(1) : null,
    fallback: s.slice(i + 1).trim(),
  };
}

/// Resolve a paint-server reference to its bare id — url(#foo) only, with or without a trailing fallback.
/// The SVG paint grammar requires the url() functional form; a bare
/// "#abc" in fill/stroke is a hex COLOR, and treating it as a ref lets
/// a gradient/pattern with id "abc" hijack the paint.
export function resolvePaintRef(val) {
  const p = parsePaintUrl(val);
  return p ? p.ref : null;
}

/// The first element carrying each id in `root`'s document, in tree order, as `getElementById` answers (SVG 1.1 calls a
/// duplicate an error; every browser resolves a reference to the first). Cached per root: the tree is not edited
/// during an import. Every id-keyed registry of the importer takes its entries through `isFirstWithId`.
const _idIndex = new WeakMap();
export function idIndexOf(root) {
  let index = _idIndex.get(root);
  if (index) return index;
  index = new Map();
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    const id = el.getAttribute && el.getAttribute('id');
    if (id && !index.has(id)) index.set(id, el);
    // children pushed in reverse so the walk is document order
    const kids = elementChildren(el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  _idIndex.set(root, index);
  return index;
}
/// Whether `el` is the element `root`'s document resolves its id to.
export function isFirstWithId(root, el, id) {
  return idIndexOf(root).get(id) === el;
}

/// Resolve a href="url(#foo)" / href="#foo" attribute to its bare id.
/// Returns null when the value is empty, a literal color, or otherwise
/// doesn't reference a doc-local id. For fill/stroke use resolvePaintRef.
export function resolveIdRef(val) {
  if (!val) return null;
  const s = val.trim();
  if (s.startsWith('url(') && s.endsWith(')')) {
    let inner = s.slice(4, -1).trim();
    inner = inner.replace(/^["']|["']$/g, '');
    if (inner.startsWith('#')) return inner.slice(1);
  } else if (s.startsWith('#')) {
    return s.slice(1);
  }
  return null;
}
