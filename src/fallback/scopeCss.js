// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// scopeCss.js: rewrite the text of a bundle's retained <style> so it stays correct after the
// native scene hosts the bundle inside a shared document.
//
// Contract:
//  - Every style rule's selectors are prefixed with `[data-mantle-scope="<scope>"] `, so a rule in
//    one bundle's <style> cannot restyle another bundle drawn into the same <svg>. A leading
//    `svg` / `:root` compound names the bundle root, which the scene replaces by the scoped group,
//    so it becomes the scope selector itself.
//  - `#id` selectors and `url(#id)` references are rewritten through `idMap` (authored id -> live
//    id), so rules keep matching after the scene renamed an id.
//  - Conditional group rules (@media, @supports, @layer, @container, @document) are scoped
//    recursively; @font-face, @keyframes and other non-style at-rules pass through, except for
//    url(#id) references. A name defined by @keyframes stays global (it is not scoped).
//  - The scanner is tolerant: strings, comments, parentheses and brackets are skipped as units,
//    and text it cannot parse is copied through unchanged rather than dropped.

const GROUP_AT = /^@(media|supports|layer|container|document|-moz-document)\b/i;

/** Rewrite `url(#id)` / `url('#id')` references in a declaration block or value. */
export function rewriteUrlRefs(text, idMap) {
  if (!idMap || !idMap.size || text.indexOf('url(') < 0) return text;
  return text.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, q, id) =>
    idMap.has(id) && idMap.get(id) !== id ? `url(${q}#${idMap.get(id)}${q})` : m,
  );
}

// Index of the character that ends the string/comment starting at i (exclusive end), or n.
function skipQuoted(t, i) {
  const q = t[i];
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') {
      j++;
      continue;
    }
    if (t[j] === q) return j + 1;
  }
  return t.length;
}
function skipComment(t, i) {
  const e = t.indexOf('*/', i + 2);
  return e < 0 ? t.length : e + 2;
}

// Index of the `}` matching the `{` at open (or n when unbalanced).
function matchBrace(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(t, i) - 1;
      continue;
    }
    if (c === '/' && t[i + 1] === '*') {
      i = skipComment(t, i) - 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return t.length;
}

// Split a selector list at top-level commas.
function splitList(sel) {
  const out = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(sel, i) - 1;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  out.push(sel.slice(start));
  return out;
}

// Rewrite `#id` tokens (not inside strings, brackets or parentheses) through idMap.
function rewriteIdSelectors(sel, idMap) {
  if (!idMap || !idMap.size || sel.indexOf('#') < 0) return sel;
  let out = '',
    depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '"' || c === "'") {
      const e = skipQuoted(sel, i);
      out += sel.slice(i, e);
      i = e - 1;
      continue;
    }
    if (c === '\\') {
      out += sel.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    if (c === '#' && depth === 0) {
      let j = i + 1;
      while (j < sel.length && /[\w -￿-]/.test(sel[j])) j++;
      const id = sel.slice(i + 1, j);
      out += idMap.has(id) ? '#' + idMap.get(id) : sel.slice(i, j);
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function scopeSelector(sel, scopeSel, idMap) {
  const s = rewriteIdSelectors(sel.trim(), idMap);
  if (!s) return s;
  // A leading svg / :root compound names the bundle root: it is the scoped group here.
  const root = /^(svg|:root)(?![\w-])/i.exec(s);
  if (root) return scopeSel + s.slice(root[0].length);
  return scopeSel + ' ' + s;
}

function scopeBlock(t, scopeSel, idMap) {
  let out = '',
    i = 0;
  const n = t.length;
  while (i < n) {
    const c = t[i];
    if (c === '/' && t[i + 1] === '*') {
      const e = skipComment(t, i);
      out += t.slice(i, e);
      i = e;
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    // Read a prelude up to `{` or `;`.
    let j = i;
    for (; j < n; j++) {
      const d = t[j];
      if (d === '"' || d === "'") {
        j = skipQuoted(t, j) - 1;
        continue;
      }
      if (d === '/' && t[j + 1] === '*') {
        j = skipComment(t, j) - 1;
        continue;
      }
      if (d === '\\') {
        j++;
        continue;
      }
      if (d === '{' || d === ';' || d === '}') break;
    }
    if (j >= n) {
      out += t.slice(i);
      break;
    }
    if (t[j] === '}') {
      out += t.slice(i, j + 1);
      i = j + 1;
      continue;
    } // stray brace
    const prelude = t.slice(i, j);
    if (t[j] === ';') {
      out += rewriteUrlRefs(prelude, idMap) + ';';
      i = j + 1;
      continue;
    }
    const close = matchBrace(t, j);
    const body = t.slice(j + 1, close);
    const closed = close < n ? '}' : '';
    const head = prelude.trim();
    if (head[0] === '@') {
      out += GROUP_AT.test(head)
        ? prelude + '{' + scopeBlock(body, scopeSel, idMap) + closed
        : prelude + '{' + rewriteUrlRefs(body, idMap) + closed;
    } else {
      const sels = splitList(prelude)
        .map((x) => scopeSelector(x, scopeSel, idMap))
        .join(', ');
      out += sels + '{' + rewriteUrlRefs(body, idMap) + closed;
    }
    i = close + 1;
  }
  return out;
}

/**
 * Scope and id-rewrite one <style> text.
 * @param {string} text   the stylesheet text
 * @param {string} scope  the value of the host group's `data-mantle-scope` attribute
 * @param {Map<string,string>} [idMap]  authored id -> live id
 * @returns {string}
 */
export function scopeCssText(text, scope, idMap) {
  return scopeBlock(String(text), `[data-mantle-scope="${scope}"]`, idMap || null);
}
