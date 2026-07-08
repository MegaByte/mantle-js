// svg/utils.js — small generic helpers used across the importer.
//
// `elementChildren` / `switchChildMatches` are generic DOM-layer
// plumbing. `resolveIdRef` is a url(#id) parser used by gradients,
// filters, markers, clips/masks, and shape references.

/// Both xmldom (Node) and the browser DOM expose .childNodes (a
/// NodeList that includes text nodes); the browser also has .children
/// but xmldom does not. Normalise to an array of element nodes
/// (nodeType === 1) that works on both.
export function elementChildren(el) {
  if (!el) return [];
  const out = [];
  const kids = el.childNodes || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c && c.nodeType === 1) out.push(c);
  }
  return out;
}

/// SVG 1.1 conditional-processing test used by <switch>. Returns true
/// iff the element's requiredFeatures / requiredExtensions /
/// systemLanguage attributes (if present) all pass.
///
/// Per SVG 1.1 § 5.8:
///   - requiredFeatures: every space-separated URI must be in the UA's
///     supported feature set. We claim support for the Static-feature
///     URIs (Structure, BasicStructure, etc.) since we render static
///     vectors; anything else fails.
///   - requiredExtensions: every URI is a vendor extension — we
///     advertise none, so any non-empty list fails.
///   - systemLanguage: a comma-separated list; pass if the document
///     language matches. We don't track document language; treat as
///     "match anything" so most "i18n SVGs" using <switch> for
///     fallback chains pick their first child as the default.
export function switchChildMatches(el) {
  const reqExt = el.getAttribute && el.getAttribute('requiredExtensions');
  if (reqExt && reqExt.trim().length > 0) return false;
  const reqFeat = el.getAttribute && el.getAttribute('requiredFeatures');
  if (reqFeat && reqFeat.trim().length > 0) {
    // Conservative: accept the SVG 1.1 Static-render feature URIs;
    // reject anything else (Animation, DOM scripting, …).
    const ok = new Set([
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
    for (const f of reqFeat.split(/\s+/)) {
      if (f && !ok.has(f)) return false;
    }
  }
  // systemLanguage: comma-separated BCP 47 tags; pass when any tag
  // matches the document language (or when unset / empty).
  const sysLang = el.getAttribute && el.getAttribute('systemLanguage');
  if (sysLang && sysLang.trim().length > 0) {
    const docLang = (typeof document !== 'undefined' && document.documentElement)
      ? (document.documentElement.lang || document.documentElement.getAttribute('xml:lang') || '')
      : '';
    if (docLang) {
      const want = docLang.trim().toLowerCase().split('-');
      const tags = sysLang.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      let match = false;
      for (const tag of tags) {
        const parts = tag.split('-');
        if (parts[0] === want[0] && (parts.length === 1 || parts[1] === want[1])) {
          match = true;
          break;
        }
      }
      if (!match) return false;
    }
  }
  return true;
}

/// Resolve a fill="url(#foo)" / fill="#foo" attribute to its bare id.
/// Returns null when the value is empty, a literal color, or otherwise
/// doesn't reference a doc-local id.
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
