// svg/stylesheet.js — CSS stylesheet engine for inline <style> blocks.
//
// Supports tag, *, .class, #id, compound (tag.class#id), descendant
// combinator (' '), child ('>'), and selector lists (','). Unsupported
// pseudo-classes / pseudo-elements / attribute selectors parse as
// never-matching.

// The active stylesheet is keyed by the parsed Document, not a mutable
// module-global: importSvg is async and awaits mid-walk, so a single
// global slot is clobbered when imports run concurrently (Promise.all)
// and an element resolves the wrong sheet. Keying by el.ownerDocument
// makes every element resolve its own document's sheet. WeakMap so a
// finished import's sheet is collected with its document; nested
// <image> SVGs (their own Document) register independently.
const _sheetByDoc = new WeakMap();

// Per-sheet rule index, keyed by the rules array (rebuilt lazily on first
// lookup, GC'd with the sheet). Buckets each rule by its subject compound's
// most-selective token (id > first class > tag), so a property lookup tests
// only candidate rules instead of scanning every rule, turning the
// per-element/per-prop cost from O(all rules × depth) into
// O(matching-bucket rules × depth).
const _indexBySheet = new WeakMap();

function _pushBucket(map, key, r) {
  let arr = map.get(key);
  if (!arr) map.set(key, arr = []);
  arr.push(r);
}

function _buildSubjectIndex(rules) {
  const idx = { byId: new Map(), byClass: new Map(), byTag: new Map(), universal: [] };
  for (const r of rules) {
    const compounds = r.chain.compounds;
    const subj = compounds[compounds.length - 1];
    // Bucket by the subject compound's most-selective token; the rest of the
    // compound is still verified by compoundMatches when the rule is
    // considered. An element gathers every bucket its tokens hit, so a rule
    // bucketed under any required token is found iff the element carries it.
    if (subj.id) _pushBucket(idx.byId, subj.id, r);
    else if (subj.classes && subj.classes.length) _pushBucket(idx.byClass, subj.classes[0], r);
    else if (subj.tag && subj.tag !== '*') _pushBucket(idx.byTag, subj.tag, r);
    else idx.universal.push(r);  // *, attr-only, or pseudo-only subjects
  }
  return idx;
}

// Elements expose ownerDocument; a Document node is its own key. Guards
// detached nodes (null) so callers degrade to "no stylesheet".
function docOf(node) { return node ? (node.ownerDocument || node) : null; }

/// Register `root`'s parsed stylesheet (rules array, or null to drop),
/// keyed by root's Document so a concurrent import can't clobber it.
export function setActiveStylesheet(root, rules) {
  const doc = docOf(root);
  if (!doc) return;
  if (rules) _sheetByDoc.set(doc, rules);
  else _sheetByDoc.delete(doc);
}
/// The stylesheet governing `el`, resolved via its Document. Null when
/// el's document had no <style>/<link> rules.
export function getActiveStylesheet(el)    { const d = docOf(el); return d ? (_sheetByDoc.get(d) || null) : null; }
export function clearActiveStylesheet(root){ const d = docOf(root); if (d) _sheetByDoc.delete(d); }

/// Walk the <svg> tree collecting <style> blocks; parse + return as
/// a flat rules array (or null if no styles found). Suitable for
/// setActiveStylesheet().
///
/// Inline `<style>` only — external `<link rel="stylesheet" href>`
/// elements are picked up by buildStylesheetAsync (which falls back
/// to this when no css loader is wired).
export function buildStylesheet(root) {
  const rules = [];
  walkInlineStyles(root, rules);
  return rules.length ? rules : null;
}

function walkInlineStyles(root, rules) {
  function visit(el) {
    if (el && el.nodeType === 1 && (el.tagName || el.localName || '').toLowerCase() === 'style') {
      const css = (el.textContent || '').trim();
      if (css) parseCss(css, rules);
    }
    if (el && el.childNodes) {
      for (let i = 0; i < el.childNodes.length; i++) visit(el.childNodes[i]);
    }
  }
  visit(root);
}

/// Async variant: inline <style> + external <link rel="stylesheet">.
/// `cssTextLoader(href)` returns the CSS text (or null to drop). When
/// the loader is absent, behaves identically to buildStylesheet.
///
/// Rules from external sheets are appended AFTER the inline rules,
/// matching browser load-order behaviour (the sheet in DOM order
/// wins; ties broken by CSS specificity already implemented).
export async function buildStylesheetAsync(root, cssTextLoader) {
  const rules = [];
  walkInlineStyles(root, rules);
  if (typeof cssTextLoader === 'function') {
    const hrefs = collectLinkHrefs(root);
    for (const href of hrefs) {
      let css = null;
      try { css = await cssTextLoader(href); }
      catch (e) { css = null; }
      if (typeof css === 'string' && css.length > 0) parseCss(css, rules);
    }
  }
  return rules.length ? rules : null;
}

/// Walk the document collecting <link rel="stylesheet" href="...">
/// hrefs in document order. Skips alternate / disabled stylesheets
/// (rel="alternate stylesheet" or media="not all" etc.) per the
/// HTML spec's stylesheet-applies rules — we conservatively accept
/// only the unambiguous `rel="stylesheet"` case with no `disabled`
/// attribute.
function collectLinkHrefs(root) {
  const out = [];
  function visit(el) {
    if (el && el.nodeType === 1) {
      const tag = (el.tagName || el.localName || '').toLowerCase();
      if (tag === 'link') {
        const rel = ((el.getAttribute && el.getAttribute('rel')) || '').toLowerCase().trim();
        const href = (el.getAttribute && el.getAttribute('href')) || '';
        // Browser DOM returns null for absent attributes; xmldom
        // returns "". hasAttribute is the reliable presence check.
        const isDisabled = el.hasAttribute
          ? el.hasAttribute('disabled')
          : (el.getAttribute && el.getAttribute('disabled') != null);
        if (rel === 'stylesheet' && href && !isDisabled) out.push(href);
      }
    }
    if (el && el.childNodes) {
      for (let i = 0; i < el.childNodes.length; i++) visit(el.childNodes[i]);
    }
  }
  visit(root);
  return out;
}

export function parseCss(css, rules) {
  // Strip /* ... */ comments.
  css = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  parseCssInner(css, 0, css.length, rules);
}

/// Recursive inner parser that operates on a slice [start, end) of
/// the (comment-stripped) source. Splitting this out lets @media and
/// @supports descend into their nested blocks.
function parseCssInner(css, start, end, rules) {
  let i = start;
  while (i < end) {
    // Statement-form at-rules like `@import url(...);` have no
    // block. If we see one before the next `{`, skip past its `;`
    // so its tail doesn't get glued onto the next selector list.
    {
      let k = i;
      while (k < end && /[\s]/.test(css[k])) k++;
      if (k < end && css[k] === '@') {
        // Look for the next `{` or `;`, whichever comes first.
        let sc = -1, bc = -1;
        for (let m = k; m < end; m++) {
          const c = css[m];
          if (c === ';' && sc < 0) { sc = m; break; }
          if (c === '{') { bc = m; break; }
        }
        if (sc >= 0 && (bc < 0 || sc < bc)) {
          // Statement-form at-rule terminated by `;`. Skip it.
          i = sc + 1;
          continue;
        }
        // Otherwise fall through — block-form at-rule handled below.
      }
    }
    const open = css.indexOf('{', i);
    if (open < 0 || open >= end) break;
    // Find the matching '}' for THIS '{' (skip nested braces in
    // @media / @supports blocks). Without brace matching, `@media
    // screen { rect { fill: red; } }` would parse the inner `rect {`
    // as the body of an empty selector and silently drop the rule.
    const close = matchBrace(css, open);
    if (close < 0 || close >= end) break;
    const selectorList = css.substring(i, open).trim();
    i = close + 1;
    if (!selectorList) continue;
    if (selectorList.startsWith('@')) {
      // @-rule. We support @media + @supports recursively when the
      // condition evaluates to true under our static-renderer model
      // (screen-shaped, supports anything in our declared CSS prop
      // table). Other at-rules (@font-face, @import, @keyframes,
      // @page, @namespace, @charset) are skipped — they're not part
      // of the inline-style scope a renderer cares about.
      if (atRuleApplies(selectorList)) {
        parseCssInner(css, open + 1, close, rules);
      }
      continue;
    }
    const body = css.substring(open + 1, close);
    const decls = parseCssDecls(body);
    if (Object.keys(decls).length === 0) continue;
    for (const rawSel of selectorList.split(',')) {
      const sel = rawSel.trim();
      if (!sel) continue;
      const chain = parseCssChain(sel);
      if (!chain) continue;
      // Pre-compute the specificity tuple once per rule — chainSpec
      // walks chain.compounds (allocs per call) and the result is
      // deterministic for the rule's lifetime.
      const spec = chainSpec(chain);
      rules.push({ chain, decls, order: rules.length, spec });
    }
  }
}

/// Find the matching '}' for the '{' at `openIdx`. Returns -1 if the
/// brace is unmatched (truncated input). Strings/comments inside the
/// brace block are not handled — CSS string literals in real stylesheets
/// are rare and we strip comments before calling this.
function matchBrace(css, openIdx) {
  let depth = 1;
  for (let k = openIdx + 1; k < css.length; k++) {
    const c = css[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/// Static-renderer @media / @supports evaluator. Conservative:
/// returns true only for conditions we KNOW apply, false for anything
/// we don't recognize. This means an unknown @media query drops its
/// rules — preferable to applying them under wrong assumptions.
///
/// What evaluates true:
///   @media all                       — universal
///   @media screen                    — we render to screen
///   @media (no condition)            — bare @media, treat as all
///   @media screen, print             — comma list: any branch matches
///   @supports (prop: value)          — when `prop` is a known CSS
///                                     property (we don't validate
///                                     value; conservative-true)
///   @supports (anything) and (...)   — handled per-branch
///
/// What evaluates false:
///   @media print                     — non-screen media
///   @media (feature: value)          — feature queries we can't test
///   @font-face / @import / @keyframes / @page / @namespace / @charset
function atRuleApplies(atRule) {
  // Strip the at-rule keyword + leading whitespace.
  const m = /^@([a-zA-Z-]+)\s*(.*)$/.exec(atRule);
  if (!m) return false;
  const kw = m[1].toLowerCase();
  const cond = m[2].trim();
  if (kw === 'media') {
    if (cond === '' || cond === 'all') return true;
    // Comma-separated media query list: any match → apply.
    for (const part of cond.split(',')) {
      if (mediaQueryMatches(part.trim())) return true;
    }
    return false;
  }
  if (kw === 'supports') {
    return supportsConditionMatches(cond);
  }
  // @font-face / @import / @keyframes / @page / @namespace / @charset etc.
  return false;
}

function mediaQueryMatches(q) {
  // Accept: bare media type (screen / all), or a media-type-prefixed
  // query with the type matching screen/all. Reject any query with
  // feature parentheticals — we can't evaluate viewport size,
  // resolution, color depth, etc.
  // Examples that match:  'screen' / 'all' / 'screen and (no-feature)'
  // (the last is conservatively rejected by the feature-check below).
  if (q === 'screen' || q === 'all') return true;
  // `not print`, `only screen` etc.
  if (/^only\s+(screen|all)\s*$/i.test(q)) return true;
  if (/^not\s+print\s*$/i.test(q)) return true;
  // Anything with parens (feature query) is conservatively rejected.
  return false;
}

function supportsConditionMatches(cond) {
  // (prop: value) — supported if `prop` is in our known-CSS table.
  // (prop: value) and (prop2: value2) — both must be supported.
  // (prop: value) or (prop2: value2) — either supported.
  // not (prop: value) — supported iff inner is NOT supported.
  cond = cond.trim();
  if (cond.startsWith('not ')) return !supportsConditionMatches(cond.substring(4).trim());
  // Split on top-level 'and' / 'or'. CSS spec allows mixing only with
  // explicit grouping; we accept either as homogeneous.
  const parts = splitTopLevel(cond, [' and ', ' or ']);
  if (parts.length > 1) {
    // If any 'or' separator appeared, OR semantics; else AND.
    const hasOr = / or /i.test(cond);
    if (hasOr) return parts.some(p => supportsConditionMatches(p));
    return parts.every(p => supportsConditionMatches(p));
  }
  // Single bare term: '(prop: value)'.
  const inner = cond.replace(/^\((.*)\)$/, '$1').trim();
  const colon = inner.indexOf(':');
  if (colon < 0) return false;
  const prop = inner.substring(0, colon).trim().toLowerCase();
  return KNOWN_CSS_PROPS.has(prop);
}

/// Split `s` on top-level occurrences of any token in `seps`,
/// respecting parenthesis nesting. Returns the trimmed pieces.
function splitTopLevel(s, seps) {
  const out = [];
  let depth = 0, last = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth === 0) {
      for (const sep of seps) {
        if (s.substring(k, k + sep.length).toLowerCase() === sep) {
          out.push(s.substring(last, k).trim());
          k += sep.length - 1;
          last = k + 1;
          break;
        }
      }
    }
  }
  out.push(s.substring(last).trim());
  return out;
}

/// CSS properties we recognize for @supports detection. Not
/// exhaustive — meant to mirror what svg/style.js actually consults
/// during element-style lookup so @supports queries that reflect
/// real renderer capability return accurate answers.
const KNOWN_CSS_PROPS = new Set([
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'fill-opacity', 'stroke-opacity', 'opacity', 'fill-rule',
  'display', 'visibility', 'color', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'mix-blend-mode',
  'isolation', 'filter', 'clip-path', 'mask', 'transform',
  'paint-order', 'vector-effect', 'image-rendering',
  'color-interpolation', 'color-interpolation-filters',
  // CSS Color 4 + 5 properties we parse.
  'color-mix',
]);

export function parseCssDecls(body) {
  const out = {};
  for (const pair of body.split(';')) {
    const colon = pair.indexOf(':');
    if (colon < 0) continue;
    const key = pair.substring(0, colon).trim().toLowerCase();
    let val = pair.substring(colon + 1).trim();
    const imp = val.toLowerCase().lastIndexOf('!important');
    const important = imp >= 0;
    if (important) val = val.substring(0, imp).trim();
    if (key) {
      const impKey = '!' + key;
      // Within one declaration block, a later normal declaration cannot
      // override an earlier !important declaration. Same-importance
      // declarations still use source order by replacing the stored value.
      if (important || out[impKey] !== true) {
        out[key] = val;
        if (important) out[impKey] = true;
        else delete out[impKey];
      }
    }
  }
  return out;
}

export function parseCssChain(sel) {
  const compounds = [];
  const combinators = ['\0'];  // sentinel for index 0
  let sb = '';
  let pendingComb = '\0';
  function flush() {
    if (sb.length === 0) return;
    compounds.push(sb);
    sb = '';
    if (pendingComb !== '\0') { combinators.push(pendingComb); pendingComb = '\0'; }
    else if (compounds.length > 1) combinators.push(' ');
  }
  // Track parenthesis + bracket depth so combinator characters
  // inside `:not(...)` or `[attr~="..."]` aren't mis-tokenized as
  // selector boundaries.
  let parenDepth = 0, brackDepth = 0;
  for (let k = 0; k < sel.length; k++) {
    const c = sel[k];
    if (c === '(') { parenDepth++; sb += c; continue; }
    if (c === ')') { parenDepth--; sb += c; continue; }
    if (c === '[') { brackDepth++; sb += c; continue; }
    if (c === ']') { brackDepth--; sb += c; continue; }
    if (parenDepth > 0 || brackDepth > 0) { sb += c; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      flush();
      if (pendingComb === '\0') pendingComb = ' ';
    } else if (c === '>') {
      flush();
      pendingComb = '>';
    } else if (c === '+') {
      flush();
      pendingComb = '+';
    } else if (c === '~') {
      flush();
      pendingComb = '~';
    } else {
      sb += c;
    }
  }
  flush();
  if (compounds.length === 0) return null;
  const parsedCompounds = compounds.map(parseCssCompound);
  if (parsedCompounds.some(c => c === null)) return null;
  while (combinators.length < compounds.length) combinators.push(' ');
  while (combinators.length > compounds.length) combinators.pop();
  return { compounds: parsedCompounds, combinators };
}

export function parseCssCompound(s) {
  // compound = optional tag, then any mix of .class / #id / [attr] /
  // :pseudo. Compound-level "never-match" still fires for tokens we
  // don't recognize (catches typos and never-implementable selectors
  // gracefully).
  const c = { tag: '', id: '', classes: [], attrs: [], pseudos: [], neverMatch: false };
  let i = 0, N = s.length;
  if (i < N && (/[A-Za-z*]/.test(s[i]))) {
    let start = i;
    while (i < N && /[A-Za-z0-9\-*]/.test(s[i])) i++;
    c.tag = s.substring(start, i).toLowerCase();
  }
  while (i < N) {
    const ch = s[i];
    if (ch === '.') {
      i++;
      const start = i;
      while (i < N && /[A-Za-z0-9_\-]/.test(s[i])) i++;
      if (i > start) c.classes.push(s.substring(start, i));
    } else if (ch === '#') {
      i++;
      const start = i;
      while (i < N && /[A-Za-z0-9_\-]/.test(s[i])) i++;
      if (i > start) c.id = s.substring(start, i);
    } else if (ch === '[') {
      // [attr] / [attr=val] / [attr~=val] / [attr|=val] / [attr^=val]
      // / [attr$=val] / [attr*=val]. Whitespace inside the brackets
      // is permitted by CSS and stripped by the parser.
      const close = s.indexOf(']', i + 1);
      if (close < 0) { c.neverMatch = true; break; }
      const body = s.substring(i + 1, close).trim();
      const attr = parseAttrSelector(body);
      if (!attr) c.neverMatch = true;
      else c.attrs.push(attr);
      i = close + 1;
    } else if (ch === ':') {
      i++;
      // Allow `::pseudo-element` syntax (e.g. ::before) — we don't
      // support pseudo-elements, so mark never-match.
      if (i < N && s[i] === ':') { c.neverMatch = true; i++; while (i < N && /[A-Za-z0-9\-]/.test(s[i])) i++; continue; }
      const start = i;
      while (i < N && /[A-Za-z0-9\-]/.test(s[i])) i++;
      const name = s.substring(start, i).toLowerCase();
      let arg = null;
      if (i < N && s[i] === '(') {
        // Walk parens balanced (handles `:not(:first-child)` etc.).
        let depth = 1, k = i + 1;
        while (k < N && depth > 0) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')') depth--;
          if (depth === 0) break;
          k++;
        }
        if (depth !== 0) { c.neverMatch = true; break; }
        arg = s.substring(i + 1, k);
        i = k + 1;
      }
      const p = parsePseudo(name, arg);
      if (!p) c.neverMatch = true;
      else c.pseudos.push(p);
    } else {
      // Any unknown character → mark never-match and skip ahead.
      c.neverMatch = true;
      i++;
    }
  }
  return c;
}

/// Parse an attribute selector body (the part between [ and ]).
/// Returns { name, op, value, caseInsensitive } or null on parse fail.
function parseAttrSelector(body) {
  // Match `name op? value?` where op ∈ ['', '=', '~=', '|=', '^=', '$=', '*=']
  // value may be quoted with " or ' or bare (no whitespace/special).
  const m = /^([A-Za-z_][A-Za-z0-9_\-]*)\s*(?:([~|^$*]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]"']+)(?:\s+(i|s))?)?$/.exec(body);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const op = m[2] || '';
  let value = '';
  if (m[3]) value = m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : m[3]);
  const caseInsensitive = (m[6] || '').toLowerCase() === 'i';
  return { name, op, value, caseInsensitive };
}

/// Parse a pseudo-class. Returns descriptor or null for unsupported.
function parsePseudo(name, arg) {
  if (name === 'root' || name === 'first-child' || name === 'last-child' ||
      name === 'only-child' || name === 'first-of-type' || name === 'last-of-type' ||
      name === 'only-of-type' || name === 'empty') {
    return { kind: name };
  }
  if (name === 'nth-child' || name === 'nth-last-child' ||
      name === 'nth-of-type' || name === 'nth-last-of-type') {
    if (arg == null) return null;
    const coeffs = parseAnB(arg.trim());
    if (!coeffs) return null;
    return { kind: name, a: coeffs.a, b: coeffs.b };
  }
  if (name === 'not') {
    if (arg == null) return null;
    // :not(simple-selector). We parse the arg as a single compound
    // (selector-list inside :not() is CSS4; we accept commas but
    // require each to be a single compound).
    const compounds = arg.split(',').map(p => parseCssCompound(p.trim()));
    if (compounds.some(c => c == null || c.neverMatch)) {
      // Conservatively: any neverMatch sub-compound means :not()
      // matches everything (since the inner never matches anything).
      // But if ANY compound was unparseable, treat as never-match
      // (safer than over-matching).
      return null;
    }
    return { kind: 'not', compounds };
  }
  // Interactive pseudos never match in a static renderer.
  if (name === 'hover' || name === 'active' || name === 'focus' ||
      name === 'visited' || name === 'link' || name === 'target' ||
      name === 'focus-visible' || name === 'focus-within') {
    return { kind: 'never' };
  }
  return null; // unsupported
}

/// Parse the An+B microsyntax used in :nth-child(an+b). Returns
/// { a, b } or null on parse fail. Accepts:
///   'odd' → 2n+1
///   'even' → 2n
///   '5' → 0n+5
///   'n', '2n', '-n', '2n+1', '-2n+5', '4n-3'
function parseAnB(s) {
  s = s.replace(/\s+/g, '').toLowerCase();
  if (s === 'odd') return { a: 2, b: 1 };
  if (s === 'even') return { a: 2, b: 0 };
  // Just an integer: a=0.
  if (/^-?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
  // an+b / -an+b / -n+b / n / n+b / -n-b / an / etc.
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (!m) return null;
  let a = m[1];
  if (a === '' || a === '+') a = 1;
  else if (a === '-') a = -1;
  else a = parseInt(a, 10);
  const b = m[2] ? parseInt(m[2], 10) : 0;
  return { a, b };
}

export function compoundSpec(c) {
  // CSS specificity tuple: (idCount, classCount + attrCount + pseudoClassCount, tagCount + pseudoElementCount).
  // Pseudo-elements are unsupported (parseCssCompound marks them
  // never-match), so we ignore them here. :not() contributes the
  // spec of its argument's most-specific compound.
  let idCount = c.id ? 1 : 0;
  let cCount = c.classes.length + (c.attrs ? c.attrs.length : 0);
  // Count structural pseudos as classes; :not() contributes the
  // maximum spec of its inner compound.
  if (c.pseudos) {
    for (const p of c.pseudos) {
      if (p.kind === 'not' && p.compounds) {
        let maxA = 0, maxB = 0, maxT = 0;
        for (const inner of p.compounds) {
          const s = compoundSpec(inner);
          if (s[0] > maxA) maxA = s[0];
          if (s[1] > maxB) maxB = s[1];
          if (s[2] > maxT) maxT = s[2];
        }
        idCount += maxA; cCount += maxB; // tag-count handled below
      } else if (p.kind !== 'never') {
        cCount += 1;
      }
    }
  }
  let tagCount = (!c.tag || c.tag === '*') ? 0 : 1;
  return [idCount, cCount, tagCount];
}

export function compoundMatches(c, el) {
  if (c.neverMatch) return false;
  if (c.tag && c.tag !== '*') {
    const tag = ((el.tagName || el.localName || '') + '').toLowerCase();
    if (tag !== c.tag) return false;
  }
  if (c.id) {
    const elId = el.getAttribute ? el.getAttribute('id') : null;
    if (elId !== c.id) return false;
  }
  if (c.classes.length > 0) {
    const ca = el.getAttribute ? el.getAttribute('class') : null;
    if (!ca) return false;
    const classes = ca.split(/\s+/);
    for (const want of c.classes) {
      if (classes.indexOf(want) < 0) return false;
    }
  }
  if (c.attrs && c.attrs.length > 0) {
    for (const a of c.attrs) {
      if (!attrMatches(a, el)) return false;
    }
  }
  if (c.pseudos && c.pseudos.length > 0) {
    for (const p of c.pseudos) {
      if (!pseudoMatches(p, el)) return false;
    }
  }
  return true;
}

function attrMatches(a, el) {
  if (!el.getAttribute) return false;
  // hasAttribute is more reliable than getAttribute for presence
  // because xmldom returns '' for absent attrs while browser DOM
  // returns null. Use hasAttribute when available.
  const present = el.hasAttribute ? el.hasAttribute(a.name) : (el.getAttribute(a.name) != null);
  if (!present) return false;
  const v = el.getAttribute(a.name);
  if (v == null) return false;
  if (a.op === '') return true;  // presence test
  const subject = a.caseInsensitive ? v.toLowerCase() : v;
  const want = a.caseInsensitive ? a.value.toLowerCase() : a.value;
  if (a.op === '=')  return subject === want;
  if (a.op === '~=') return subject.split(/\s+/).indexOf(want) >= 0;
  if (a.op === '|=') return subject === want || subject.startsWith(want + '-');
  if (a.op === '^=') return want.length > 0 && subject.startsWith(want);
  if (a.op === '$=') return want.length > 0 && subject.endsWith(want);
  if (a.op === '*=') return want.length > 0 && subject.indexOf(want) >= 0;
  return false;
}

function pseudoMatches(p, el) {
  if (p.kind === 'never') return false;
  if (p.kind === 'root') {
    // :root matches the element with no element parent (the <svg>).
    const parent = el.parentNode;
    return !parent || parent.nodeType !== 1;
  }
  if (p.kind === 'first-child') return _elementSiblingIndex(el, false) === 0;
  if (p.kind === 'last-child')  return _elementSiblingIndex(el, true)  === 0;
  if (p.kind === 'only-child')  return _elementSiblingCount(el) === 1;
  if (p.kind === 'first-of-type') return _typeSiblingIndex(el, false) === 0;
  if (p.kind === 'last-of-type')  return _typeSiblingIndex(el, true)  === 0;
  if (p.kind === 'only-of-type')  return _typeSiblingCount(el) === 1;
  if (p.kind === 'empty') {
    if (!el.childNodes) return true;
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 1) return false;       // element
      if (n.nodeType === 3 && (n.nodeValue || '').length > 0) return false; // non-empty text
    }
    return true;
  }
  if (p.kind === 'nth-child')         return _nthMatches(p, _elementSiblingIndex(el, false));
  if (p.kind === 'nth-last-child')    return _nthMatches(p, _elementSiblingIndex(el, true));
  if (p.kind === 'nth-of-type')       return _nthMatches(p, _typeSiblingIndex(el, false));
  if (p.kind === 'nth-last-of-type')  return _nthMatches(p, _typeSiblingIndex(el, true));
  if (p.kind === 'not') {
    if (!p.compounds || p.compounds.length === 0) return true;
    // :not() matches when NONE of the inner compounds match.
    for (const inner of p.compounds) {
      if (compoundMatches(inner, el)) return false;
    }
    return true;
  }
  return false;
}

function _elementSiblingIndex(el, fromEnd) {
  const parent = el.parentNode;
  if (!parent || !parent.childNodes) return 0;
  const sibs = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n.nodeType === 1) sibs.push(n);
  }
  const list = fromEnd ? sibs.slice().reverse() : sibs;
  return list.indexOf(el);
}
function _elementSiblingCount(el) {
  const parent = el.parentNode;
  if (!parent || !parent.childNodes) return 1;
  let n = 0;
  for (let i = 0; i < parent.childNodes.length; i++)
    if (parent.childNodes[i].nodeType === 1) n++;
  return n;
}
function _typeSiblingIndex(el, fromEnd) {
  const parent = el.parentNode;
  if (!parent || !parent.childNodes) return 0;
  const tag = ((el.tagName || el.localName || '') + '').toLowerCase();
  const sibs = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n.nodeType !== 1) continue;
    const ntag = ((n.tagName || n.localName || '') + '').toLowerCase();
    if (ntag === tag) sibs.push(n);
  }
  const list = fromEnd ? sibs.slice().reverse() : sibs;
  return list.indexOf(el);
}
function _typeSiblingCount(el) {
  const parent = el.parentNode;
  if (!parent || !parent.childNodes) return 1;
  const tag = ((el.tagName || el.localName || '') + '').toLowerCase();
  let n = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const ch = parent.childNodes[i];
    if (ch.nodeType !== 1) continue;
    const ntag = ((ch.tagName || ch.localName || '') + '').toLowerCase();
    if (ntag === tag) n++;
  }
  return n;
}
/// Check whether 1-based index `idx0 + 1` satisfies the An+B
/// expression. CSS uses 1-based positions; our siblingIndex helpers
/// return 0-based.
function _nthMatches(p, idx0) {
  const pos = idx0 + 1;       // CSS positions are 1-based
  if (p.a === 0) return pos === p.b;
  // pos = a*n + b → n = (pos - b) / a must be a non-negative integer.
  const num = pos - p.b;
  if (num === 0) return true;
  if (Math.sign(num) !== Math.sign(p.a)) return false;
  return (num % p.a) === 0;
}

export function chainMatches(chain, el) {
  let idx = chain.compounds.length - 1;
  if (!compoundMatches(chain.compounds[idx], el)) return false;
  idx--;
  let cur = el;
  while (idx >= 0) {
    const comb = chain.combinators[idx + 1];
    if (comb === '>') {
      cur = cur.parentNode;
      if (!cur || cur.nodeType !== 1) return false;
      if (!compoundMatches(chain.compounds[idx], cur)) return false;
    } else if (comb === '+') {
      // Adjacent sibling: the previous element sibling must match.
      const prev = _previousElementSibling(cur);
      if (!prev) return false;
      if (!compoundMatches(chain.compounds[idx], prev)) return false;
      cur = prev;
    } else if (comb === '~') {
      // General sibling: SOME previous element sibling must match.
      let p = _previousElementSibling(cur);
      let matched = false;
      while (p) {
        if (compoundMatches(chain.compounds[idx], p)) { matched = true; cur = p; break; }
        p = _previousElementSibling(p);
      }
      if (!matched) return false;
    } else {
      // Descendant: walk up parents looking for a match.
      cur = cur.parentNode;
      let matched = false;
      while (cur && cur.nodeType === 1) {
        if (compoundMatches(chain.compounds[idx], cur)) { matched = true; break; }
        cur = cur.parentNode;
      }
      if (!matched) return false;
    }
    idx--;
  }
  return true;
}

function _previousElementSibling(el) {
  let p = el.previousSibling;
  while (p && p.nodeType !== 1) p = p.previousSibling;
  return p || null;
}

export function chainSpec(chain) {
  let a = 0, b = 0, c = 0;
  for (const cmp of chain.compounds) {
    const s = compoundSpec(cmp);
    a += s[0]; b += s[1]; c += s[2];
  }
  return [a, b, c];
}

/// Lookup a CSS property on `el` against the active stylesheet. Returns
/// `{ value, important }` for the cascade-winning matched declaration, or
/// null if none match. Cascade: !important first, then specificity, then
/// source order (later wins).
export function lookupCssProp(el, name) {
  const sheet = _sheetByDoc.get(docOf(el));
  if (!sheet || sheet.length === 0) return null;
  let idx = _indexBySheet.get(sheet);
  if (!idx) { idx = _buildSubjectIndex(sheet); _indexBySheet.set(sheet, idx); }

  let best = null, bestSpec = null, bestOrder = -1, bestImp = false;
  const consider = (r) => {
    const v = r.decls[name];
    if (v == null) return;
    if (!chainMatches(r.chain, el)) return;
    // r.spec is pre-computed at stylesheet build time. Cascade order:
    // !important wins over all non-important (regardless of specificity),
    // then by specificity, then by r.order (source order).
    const imp = r.decls['!' + name] === true;
    const s = r.spec;
    const replace = bestSpec === null
     || (imp && !bestImp)
     || (imp === bestImp && (
          s[0] > bestSpec[0]
       || (s[0] === bestSpec[0] && s[1] > bestSpec[1])
       || (s[0] === bestSpec[0] && s[1] === bestSpec[1] && s[2] > bestSpec[2])
       || (s[0] === bestSpec[0] && s[1] === bestSpec[1] && s[2] === bestSpec[2] && r.order > bestOrder)));
    if (replace) { best = v; bestSpec = s; bestOrder = r.order; bestImp = imp; }
  };

  // Candidate rules = every bucket this element's tokens hit (each rule lives in
  // exactly one bucket, so no rule is considered twice).
  for (const r of idx.universal) consider(r);
  const elId = el.getAttribute ? el.getAttribute('id') : null;
  if (elId) { const a = idx.byId.get(elId); if (a) for (const r of a) consider(r); }
  if (idx.byTag.size) {
    const tag = ((el.tagName || el.localName || '') + '').toLowerCase();
    const a = tag && idx.byTag.get(tag); if (a) for (const r of a) consider(r);
  }
  if (idx.byClass.size) {
    const ca = el.getAttribute ? el.getAttribute('class') : null;
    if (ca) {
      for (const c of ca.split(/\s+/)) {
        if (!c) continue;
        const a = idx.byClass.get(c); if (a) for (const r of a) consider(r);
      }
    }
  }
  return best == null ? null : { value: best, important: bestImp };
}
