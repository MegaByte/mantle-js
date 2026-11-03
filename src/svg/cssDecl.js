// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/cssDecl.js — CSS declaration-block reading shared by the inline style="…" parser (style.js) and the
// stylesheet rule parser (stylesheet.js).
//
// CSS Syntax 3 §5.4.5 and CSS Cascade 4 §4.3: a declaration block is read token by token, so a `;` inside a string or
// a function, or the text of a comment, does not end a declaration; property names are ASCII case-insensitive; a
// declaration whose value does not parse for its property is DROPPED at parse time, which leaves any earlier
// declaration of the property (and every lower layer of the cascade) in force. Shorthands expand to their longhands in
// declaration order.
//
// The value check is deliberately structural: it rejects a value that no grammar of the property could accept (an
// unknown color name, a malformed hex, a stray word) and passes anything it cannot judge (var(), env(), a function it
// does not know), so a supported value is never dropped.

import { CSS_NAMED_COLORS, systemColorOf, parseColorStrict } from './color.js';
import { JOIN_ENUM } from './segment.js';
import { expandFontShorthand } from './fontShorthand.js';
import { scanFilterList } from './cssFilter.js';

const WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const MATH_FUNCTIONS = new Set([
  'calc',
  'min',
  'max',
  'clamp',
  'round',
  'mod',
  'rem',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'pow',
  'sqrt',
  'hypot',
  'log',
  'exp',
  'abs',
  'sign',
]);

const ALPHA_PROPS = new Set([
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'stop-opacity',
  'flood-opacity',
]);
const COLOR_PROPS = new Set(['color', 'stop-color', 'flood-color', 'lighting-color']);
const KEYWORD_PROPS = {
  'fill-rule': new Set(['nonzero', 'evenodd']),
  'clip-rule': new Set(['nonzero', 'evenodd']),
  'stroke-linecap': new Set(['butt', 'round', 'square']),
  'stroke-linejoin': new Set(Object.keys(JOIN_ENUM)),
  visibility: new Set(['visible', 'hidden', 'collapse']),
  'color-interpolation-filters': new Set(['auto', 'srgb', 'linearrgb']),
};

const JUDGED_PROPS = new Set([
  'fill',
  'stroke',
  'filter',
  ...COLOR_PROPS,
  ...ALPHA_PROPS,
  ...Object.keys(KEYWORD_PROPS),
]);

/// The position of the `)` closing the `(` at `open`, or -1. Quotes and nested parentheses are skipped.
function closingParen(text, open) {
  let depth = 0,
    quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/// Whether `value` is a function call spanning the whole string whose name satisfies `ok`.
function wholeFunction(value, ok) {
  const open = value.indexOf('(');
  if (open <= 0) return false;
  return (
    ok(value.slice(0, open).trim().toLowerCase()) && closingParen(value, open) === value.length - 1
  );
}

/// A single <color> (or currentcolor): a keyword, a hex of 3, 4, 6 or 8 digits, or a color function that is valid under the CSS Color 4 /
/// 5 grammar (color.js parseColorStrict): `rgb(1,2)`, `hsl(120,100,50)`, `rgb(255,0,0,)` and a stray word are not colors, so the
/// declaration is dropped and the inherited value stays in force.
export function isColorValue(value) {
  const v = String(value).trim().toLowerCase();
  if (!v || v === 'none') return false;
  if (
    v === 'currentcolor' ||
    v === 'transparent' ||
    systemColorOf(v) !== undefined ||
    Object.prototype.hasOwnProperty.call(CSS_NAMED_COLORS, v)
  )
    return true;
  return parseColorStrict(v) !== null;
}

/// <paint>: none | <color> | context-fill | context-stroke | <url> [none | <color>]?  (SVG 2 §13.2).
function isPaintValue(value) {
  const v = value.trim();
  if (/^url\(/i.test(v)) {
    const close = closingParen(v, v.indexOf('('));
    if (close < 0) return false;
    const rest = v
      .slice(close + 1)
      .trim()
      .toLowerCase();
    return (
      rest === '' ||
      rest === 'none' ||
      rest === 'context-fill' ||
      rest === 'context-stroke' ||
      isColorValue(rest)
    );
  }
  const lower = v.toLowerCase();
  return (
    lower === 'none' ||
    lower === 'context-fill' ||
    lower === 'context-stroke' ||
    isColorValue(lower)
  );
}

/// <alpha-value>: a number, a percentage, or a math function.
function isAlphaValue(value) {
  const v = value.trim().toLowerCase();
  if (/^[+-]?(?:\d*\.?\d+|\d+\.)(?:e[+-]?\d+)?%?$/.test(v)) return true;
  return wholeFunction(v, (name) => MATH_FUNCTIONS.has(name));
}

/// Whether `value` can be a value of `name`. True for a property this module does not judge.
export function isValidPropertyValue(name, value) {
  const v = String(value).trim();
  if (name.startsWith('--')) return true; // custom properties accept any token stream
  if (!v) return false;
  if (!JUDGED_PROPS.has(name)) return true;
  if (WIDE_KEYWORDS.has(v.toLowerCase())) return true;
  if (/\b(?:var|env)\(/i.test(v)) return true; // substituted later; judged on the substituted text
  if (name === 'fill' || name === 'stroke') return isPaintValue(v);
  // <filter-value-list>: none, or url() references and filter functions (Filter Effects 1 §5). A bare `#id` is the legacy form
  // this importer has always read.
  if (name === 'filter') return /^#[^\s()]+$/.test(v) || scanFilterList(v) !== null;
  if (COLOR_PROPS.has(name)) return isColorValue(v);
  if (ALPHA_PROPS.has(name)) return isAlphaValue(v);
  const kw = KEYWORD_PROPS[name];
  if (kw) return kw.has(v.toLowerCase());
  return true;
}

/// Split a declaration block (the text between `{` and `}`, or a style attribute) into
/// [{ name, value, important }] in source order. `name` is lower-cased, `value` has its `!important` removed, and a
/// declaration with no `:`, no name or a value invalid for its property is omitted. `marker` expands to its three
/// longhands here, so a later longhand overrides it as it does in a browser.
export function readDeclarations(body) {
  const out = [];
  const text = String(body || '');
  const n = text.length;
  let depth = 0,
    quote = '';
  let piece = '';
  const flush = () => {
    const decl = piece;
    piece = '';
    const colon = decl.indexOf(':');
    if (colon < 0) return;
    const name = decl.slice(0, colon).trim().toLowerCase();
    if (!name || /\s/.test(name)) return;
    let value = decl.slice(colon + 1).trim();
    let important = false;
    const m = /!\s*important\s*$/i.exec(value);
    if (m) {
      important = true;
      value = value.slice(0, m.index).trim();
    }
    if (!isValidPropertyValue(name, value)) return;
    if (name === 'marker') {
      for (const longhand of ['marker-start', 'marker-mid', 'marker-end'])
        out.push({ name: longhand, value, important });
    } else if (name === 'font' && !/\b(?:var|env)\(/i.test(value)) {
      // `font` resets and sets every font longhand it covers; an invalid shorthand is dropped whole.
      const parts = expandFontShorthand(value);
      if (parts)
        for (const [longhand, v] of parts) out.push({ name: longhand, value: v, important });
    } else out.push({ name, value, important });
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (quote) {
      piece += c;
      if (c === '\\' && i + 1 < n) piece += text[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      piece += ' ';
      if (end < 0) break; // an unterminated comment runs to the end
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      piece += c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth > 0) depth--;
    } else if (c === ';' && depth === 0) {
      flush();
      continue;
    }
    piece += c;
  }
  flush();
  return out;
}
