// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/fontShorthand.js — the CSS `font` shorthand, expanded to the longhands the SVG text importer reads.
//
// CSS Fonts 4 §9.1: [ <font-style> || <font-variant-css2> || <font-weight> || <font-stretch-css3> ]?
// <font-size> [ / <line-height> ]? <font-family>#. The shorthand sets every font longhand it names and resets the
// others to their initial value, so the expansion always names font-style, font-variant, font-weight, font-size and
// font-family. font-stretch and line-height are accepted and dropped (the importer reads neither).

const WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const SYSTEM_FONTS = new Set([
  'caption',
  'icon',
  'menu',
  'message-box',
  'small-caption',
  'status-bar',
]);
const STRETCH = new Set([
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
]);
const SIZE_KEYWORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'larger',
  'smaller',
]);
const ANGLE = /^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:deg|grad|rad|turn)$/i;
const SIZE = /^(?:[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:[a-z]+|%)?|(?:calc|min|max|clamp)\(.*\))$/i;

/// Split on whitespace outside quotes and parentheses.
function tokens(text) {
  const out = [];
  let cur = '',
    quote = '',
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    if (depth === 0 && /\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/// The longhand declarations a `font:` value expands to, as [[name, value], ...], or null when the value is not a valid
/// `font` shorthand (a system font keyword, no size, no family). The caller keeps a value with var() whole.
export function expandFontShorthand(value) {
  const v = String(value).trim();
  const lower = v.toLowerCase();
  if (WIDE.has(lower))
    return ['font-style', 'font-variant', 'font-weight', 'font-size', 'font-family'].map((n) => [
      n,
      v,
    ]);
  if (SYSTEM_FONTS.has(lower)) return null;
  const tk = tokens(v);
  let style = 'normal',
    variant = 'normal',
    weight = 'normal';
  let i = 0;
  for (; i < tk.length; i++) {
    const t = tk[i].toLowerCase();
    if (t === 'normal') continue;
    if (t === 'italic') {
      style = 'italic';
      continue;
    }
    if (t === 'oblique') {
      style = 'oblique';
      if (i + 1 < tk.length && ANGLE.test(tk[i + 1])) i++;
      continue;
    }
    if (t === 'small-caps') {
      variant = 'small-caps';
      continue;
    }
    if (t === 'bold' || t === 'bolder' || t === 'lighter') {
      weight = t;
      continue;
    }
    // A bare number before the size is a weight (the size itself has a unit).
    if (/^\d+(?:\.\d+)?$/.test(t) && Number(t) >= 1 && Number(t) <= 1000) {
      weight = t;
      continue;
    }
    if (STRETCH.has(t)) continue;
    break;
  }
  if (i >= tk.length) return null;
  const sizeTok = tk[i++];
  let size = sizeTok,
    lineHeight = null;
  const slash = sizeTok.indexOf('/');
  if (slash >= 0) {
    size = sizeTok.slice(0, slash);
    lineHeight = sizeTok.slice(slash + 1);
  }
  if (!(SIZE.test(size) || SIZE_KEYWORDS.has(size.toLowerCase()))) return null;
  if (/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?$/.test(size) && Number(size) !== 0) return null; // a unitless size is invalid
  // The line-height may follow as "/ 1.5", "/1.5" or "20px/ 1.5"; it is read and dropped.
  if (lineHeight === null && i < tk.length && tk[i].startsWith('/')) lineHeight = tk[i++].slice(1);
  if (lineHeight === '' && i < tk.length) i++;
  const family = tk.slice(i).join(' ').trim();
  if (!family) return null;
  return [
    ['font-style', style],
    ['font-variant', variant],
    ['font-weight', weight],
    ['font-size', size],
    ['font-family', family],
  ];
}
