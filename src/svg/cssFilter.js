// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/cssFilter.js — the CSS `filter` property value (Filter Effects 1 §5): `none` or a list of filter functions and
// url() references, applied in order.
//
//   blur(<length>)  brightness(<n|%>)  contrast(<n|%>)  drop-shadow([<color>] <x> <y> [<blur>] [<color>])
//   grayscale(<n|%>)  hue-rotate(<angle>)  invert(<n|%>)  opacity(<n|%>)  saturate(<n|%>)  sepia(<n|%>)  url(#id)
//
// Three layers, none of which touches the DOM:
//   scanFilterList(text)        the syntax check and tokenizer: items, or null when the value is not a valid filter list (a
//                               declaration that does not parse is DROPPED, exactly as Chrome drops it; cssDecl.js calls this)
//   canonicalFilter(items, env) the list as a normalized string with every length in px and every color resolved: the key
//                               an import interns a compiled list under (so `currentColor` and `em` are resolved where the
//                               declaration was made, and a list inherited by a group means the same thing in every child)
//   filterListGraph(items, env) the list as a filter graph, each function compiled to the equivalent filter primitives. CSS
//                               filter functions operate in sRGB (Filter Effects 1 §5: the functions are defined on sRGB
//                               values), which is the space the filter graph runs in.
//
// Pure: no GL, no renderer, and the compile costs nothing for an asset that never writes one of these.

import { parseColorStrict } from './color.js';

const NUM = '[+-]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][+-]?\\d+)?';
const LENGTH_UNITS = 'px|em|rem|ex|ch|pt|pc|cm|mm|q|in|vw|vh|vmin|vmax';
const RE_NUM = new RegExp('^' + NUM + '$');
const RE_PCT = new RegExp('^(' + NUM + ')%$');
const RE_LEN = new RegExp('^(' + NUM + ')(' + LENGTH_UNITS + ')$', 'i');
const RE_ANGLE = new RegExp('^(' + NUM + ')(deg|grad|rad|turn)$', 'i');
const MATH =
  /^(?:calc|min|max|clamp|var|env|round|mod|rem|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp|abs|sign)\(/i;

/// The position of the `)` closing the `(` at `open`, or -1 (quotes and nested parentheses skipped).
function closeParen(text, open) {
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

/// Split `text` on whitespace at parenthesis depth 0 (commas inside a function stay in their token).
function splitTop(text) {
  const out = [];
  let depth = 0,
    quote = '',
    cur = '';
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
    else if (c === ')') depth--;
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

const isMath = (t) => MATH.test(t);
const isLen = (t) => t === '0' || RE_LEN.test(t) || (RE_NUM.test(t) && Number(t) === 0);
const isColorTok = (t) => /^currentcolor$/i.test(t) || parseColorStrict(t.toLowerCase()) !== null;

const AMOUNT_FNS = new Set([
  'brightness',
  'contrast',
  'grayscale',
  'invert',
  'opacity',
  'saturate',
  'sepia',
]);

/// Check one function's arguments against its grammar. Returns the argument tokens (a clean array) or null.
function checkArgs(name, body) {
  const t = body.trim();
  const toks = t ? splitTop(t) : [];
  if (toks.some((x) => x.includes(',') && !/\(/.test(x))) return null; // commas separate nothing in these grammars
  if (name === 'blur') {
    if (toks.length > 1) return null;
    if (toks.length === 1 && !isMath(toks[0])) {
      if (!isLen(toks[0])) return null;
      const m = RE_LEN.exec(toks[0]);
      if (m && Number(m[1]) < 0) return null;
    }
    return toks;
  }
  if (AMOUNT_FNS.has(name)) {
    if (toks.length > 1) return null;
    if (toks.length === 1 && !isMath(toks[0])) {
      const pct = RE_PCT.exec(toks[0]);
      if (pct ? Number(pct[1]) < 0 : !(RE_NUM.test(toks[0]) && Number(toks[0]) >= 0)) return null;
    }
    return toks;
  }
  if (name === 'hue-rotate') {
    if (toks.length > 1) return null;
    if (
      toks.length === 1 &&
      !isMath(toks[0]) &&
      !(RE_ANGLE.test(toks[0]) || (RE_NUM.test(toks[0]) && Number(toks[0]) === 0))
    )
      return null;
    return toks;
  }
  if (name === 'drop-shadow') {
    if (!toks.length) return null;
    const lens = toks.filter((x) => !isColorTok(x) && (isLen(x) || isMath(x)));
    const colors = toks.filter((x) => isColorTok(x));
    if (
      lens.length + colors.length !== toks.length ||
      colors.length > 1 ||
      lens.length < 2 ||
      lens.length > 3
    )
      return null;
    // The color is one token at the front or the back; the lengths are contiguous.
    const ci = toks.findIndex((x) => isColorTok(x));
    if (ci > 0 && ci < toks.length - 1) return null;
    if (lens.length === 3) {
      const m = RE_LEN.exec(lens[2]);
      if (m && Number(m[1]) < 0) return null;
    }
    return toks;
  }
  return null;
}

/// Parse a CSS `filter` value. Returns [{ url: id } | { fn, args: string[] }] (empty for `none`), or null when the
/// value is not a valid filter list. `var()` / `env()` anywhere are not judged here (they are substituted before the
/// value is read for rendering); the caller passes those values through.
export function scanFilterList(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  if (/^none$/i.test(s)) return [];
  const items = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const open = s.indexOf('(', i);
    if (open < 0) return null;
    const name = s.slice(i, open).trim().toLowerCase();
    if (!/^[a-z][a-z-]*$/.test(name)) return null;
    const close = closeParen(s, open);
    if (close < 0) return null;
    const body = s.slice(open + 1, close);
    if (name === 'url') {
      const u = body
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
      if (!u) return null;
      items.push({ url: u.startsWith('#') ? u.slice(1) : null, href: u });
    } else if (
      name === 'blur' ||
      name === 'hue-rotate' ||
      name === 'drop-shadow' ||
      AMOUNT_FNS.has(name)
    ) {
      const args = checkArgs(name, body);
      if (!args) return null;
      items.push({ fn: name, args });
    } else return null;
    i = close + 1;
    // functions are separated by whitespace (or abut a following token, which then fails the name test)
  }
  return items;
}

/// Whether `text` is a plain single `url(#id)` (the form the importer has always read), not a list or a function.
export function isPlainUrlRef(text) {
  const s = String(text || '').trim();
  return /^url\(/i.test(s) && s.indexOf(')') === s.length - 1 && s.indexOf('(', 4) < 0;
}

const fmt = (v) => String(+Number(v).toPrecision(12));

/// The value of a <number> | <percentage> token: a fraction (50% is 0.5). NaN for a math function (not evaluated here).
function amountOf(tok, dflt) {
  if (tok === undefined) return dflt;
  const p = RE_PCT.exec(tok);
  if (p) return Number(p[1]) / 100;
  return RE_NUM.test(tok) ? Number(tok) : NaN;
}
/// An angle token in degrees. NaN for a math function.
function angleOf(tok) {
  if (tok === undefined) return 0;
  const m = RE_ANGLE.exec(tok);
  if (!m) return RE_NUM.test(tok) ? Number(tok) : NaN;
  const v = Number(m[1]),
    u = m[2].toLowerCase();
  return u === 'deg' ? v : u === 'grad' ? v * 0.9 : u === 'rad' ? (v * 180) / Math.PI : v * 360;
}

/// `env`: { len(token) -> px number | NaN, colorStr(token) -> a CSS color string | null }. A token the environment cannot
/// resolve (a math function, a viewport unit) makes the whole list unrepresentable: canonicalFilter returns null.
export function canonicalFilter(items, env) {
  const out = [];
  for (const it of items) {
    if (it.url !== undefined) {
      if (it.url === null) return null;
      out.push('url(#' + it.url + ')');
      continue;
    }
    const a = it.args;
    if (it.fn === 'blur') {
      const v = a.length ? env.len(a[0]) : 0;
      if (!(v >= 0)) return null;
      out.push('blur(' + fmt(v) + 'px)');
    } else if (AMOUNT_FNS.has(it.fn)) {
      const v = amountOf(a[0], 1);
      if (!(v >= 0)) return null;
      out.push(it.fn + '(' + fmt(v) + ')');
    } else if (it.fn === 'hue-rotate') {
      const v = angleOf(a[0]);
      if (!Number.isFinite(v)) return null;
      out.push('hue-rotate(' + fmt(v) + 'deg)');
    } else {
      const ci = a.findIndex((x) => isColorTok(x));
      const colorTok = ci >= 0 ? a[ci] : 'currentcolor';
      const color = env.colorStr(colorTok);
      const lens = a.filter((x) => !isColorTok(x)).map((x) => env.len(x));
      if (!color || lens.some((v) => !Number.isFinite(v)) || (lens[2] !== undefined && lens[2] < 0))
        return null;
      out.push('drop-shadow(' + color + ' ' + lens.map((v) => fmt(v) + 'px').join(' ') + ')');
    }
  }
  return out.join(' ');
}

// ── Matrices (row-major 4x5, the feColorMatrix params layout) ──────────────────────────────────────────────────────
const rgb = (m) => [
  m[0],
  m[1],
  m[2],
  0,
  0,
  m[3],
  m[4],
  m[5],
  0,
  0,
  m[6],
  m[7],
  m[8],
  0,
  0,
  0,
  0,
  0,
  1,
  0,
];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/// The color matrix of one CSS color function with its (already numeric) amount, per Filter Effects 1 §5.
export function cssColorMatrix(fn, v) {
  switch (fn) {
    case 'brightness':
      return [v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, 1, 0];
    case 'contrast': {
      const o = 0.5 - 0.5 * v;
      return [v, 0, 0, 0, o, 0, v, 0, 0, o, 0, 0, v, 0, o, 0, 0, 0, 1, 0];
    }
    case 'grayscale': {
      const n = 1 - clamp01(v);
      return rgb([
        0.2126 + 0.7874 * n,
        0.7152 - 0.7152 * n,
        0.0722 - 0.0722 * n,
        0.2126 - 0.2126 * n,
        0.7152 + 0.2848 * n,
        0.0722 - 0.0722 * n,
        0.2126 - 0.2126 * n,
        0.7152 - 0.7152 * n,
        0.0722 + 0.9278 * n,
      ]);
    }
    case 'invert': {
      const n = clamp01(v),
        k = 1 - 2 * n;
      return [k, 0, 0, 0, n, 0, k, 0, 0, n, 0, 0, k, 0, n, 0, 0, 0, 1, 0];
    }
    case 'opacity':
      return [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, clamp01(v), 0];
    case 'saturate':
      return rgb([
        0.213 + 0.787 * v,
        0.715 - 0.715 * v,
        0.072 - 0.072 * v,
        0.213 - 0.213 * v,
        0.715 + 0.285 * v,
        0.072 - 0.072 * v,
        0.213 - 0.213 * v,
        0.715 - 0.715 * v,
        0.072 + 0.928 * v,
      ]);
    case 'sepia': {
      const n = 1 - clamp01(v);
      return rgb([
        0.393 + 0.607 * n,
        0.769 - 0.769 * n,
        0.189 - 0.189 * n,
        0.349 - 0.349 * n,
        0.686 + 0.314 * n,
        0.168 - 0.168 * n,
        0.272 - 0.272 * n,
        0.534 - 0.534 * n,
        0.131 + 0.869 * n,
      ]);
    }
    default:
      return null;
  }
}
export function cssHueRotateMatrix(deg) {
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return rgb([
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ]);
}
const ALPHA_ONLY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];

/// The graph of a CANONICAL list (canonicalFilter's output re-scanned): each function becomes the primitives that do the
/// same, chained in order. `env.color(token)` -> [r, g, b, a] (each 0..1, straight alpha); `env.urlGraph(id)` -> the graph of the
/// <filter> with that id ({ nodes, rootOut } built to take SourceGraphic = -1) or null for an id that names none. `env.urlMissing(id)`
/// (optional) says whether an id names no <filter>: when it is given and true for any stage the whole list is ignored (Filter Effects 1
/// §5); without it that stage alone is the identity, as in Chrome.
///
/// `env.urlSub(id)` (optional) -> { v: [x, y, w, h], u: 0 | 1 } or null: the filter REGION of that <filter> as a primitive subregion (u 1 = fractions
/// of the element's box). Each url() stage is a filter of its own with its own region (Filter Effects 1 §5: the list is applied in order, each
/// a complete filter), so a stage that is not the last item of the list is clipped to its region by an identity primitive that states it
/// as its subregion; the last item's region is the list's (the caller sets it on the record).
///
/// Returns { graph, urlIds } (graph null when the whole list is the identity).
export function filterListGraph(items, env) {
  const nodes = [];
  let last = -1; // the previous stage's result: -1 is the SourceGraphic
  const urlIds = [];
  const clips = new Set(); // the indices of the identity primitives that clip a url() stage to its own region
  const push = (type, inputs, params) => {
    nodes.push({ type, inputs, params });
    return nodes.length - 1;
  };
  /// The alpha channel of the previous result as a colorless image (what SourceAlpha is to the SourceGraphic).
  const alphaOf = () =>
    last === -1 ? -2 : push('feColorMatrix', [last], { matrix: ALPHA_ONLY.slice() });
  // Filter Effects 1 §5: a url() naming no <filter> ignores the whole chain (env.urlMissing, set for the spec default); without
  // it (compat 'chrome') only that stage is skipped.
  if (env.urlMissing && items.some((it) => it.url != null && env.urlMissing(it.url))) {
    for (const it of items) if (it.url != null && env.urlMissing(it.url)) env.urlGraph(it.url); // says so once
    return { graph: null, urlIds: [] };
  }
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    if (it.url !== undefined) {
      const g = it.url !== null ? env.urlGraph(it.url) : null;
      if (!g) continue;
      urlIds.push(it.url);
      const prev = last;
      // Remap into this list: SourceGraphic reads the previous stage, SourceAlpha its alpha, the backdrop stays the backdrop.
      const alphaIn =
        prev !== -1 && g.nodes.some((n) => n.inputs.includes(-2))
          ? push('feColorMatrix', [prev], { matrix: ALPHA_ONLY.slice() })
          : -2;
      const base = nodes.length;
      for (const n of g.nodes) {
        nodes.push({
          type: n.type,
          params: n.params,
          inputs: n.inputs.map((j) =>
            j >= 0 ? j + base : j === -1 ? prev : j === -2 ? alphaIn : j,
          ),
        });
      }
      last = g.rootOut + base;
      // This stage's own region clips its result before the next stage reads it.
      // (A stage of color matrices and transfer functions alone paints nowhere its input does not: its region cannot cut anything, and it
      // adds no pass.)
      const sub =
        ii < items.length - 1 &&
        env.urlSub &&
        !g.nodes.every((n) => n.type === 'feColorMatrix' || n.type === 'feComponentTransfer')
          ? env.urlSub(it.url)
          : null;
      if (sub) {
        last = push('feOffset', [last], { dx: 0, dy: 0, sub: sub.v.slice(), subUnits: sub.u });
        clips.add(last);
      }
      continue;
    }
    const a = it.args;
    if (it.fn === 'blur') {
      const s = a.length ? parseFloat(a[0]) : 0;
      // blur(0) draws as the identity but keeps its node (as <feGaussianBlur stdDeviation="0"> does), so a blur can be animated up from 0
      // (createFilterParams writes the node's sigma). Only an unreadable or negative radius is skipped.
      if (!(s >= 0)) continue;
      last = push('feGaussianBlur', [last], { sigmaX: s, sigmaY: s });
    } else if (AMOUNT_FNS.has(it.fn)) {
      const v = amountOf(a[0], 1);
      last = push('feColorMatrix', [last], { matrix: cssColorMatrix(it.fn, v) });
    } else if (it.fn === 'hue-rotate') {
      last = push('feColorMatrix', [last], { matrix: cssHueRotateMatrix(angleOf(a[0])) });
    } else if (it.fn === 'drop-shadow') {
      const ci = a.findIndex((x) => isColorTok(x));
      const rgba = env.color(a[ci >= 0 ? ci : 0]);
      const lens = a.filter((x) => !isColorTok(x)).map((x) => parseFloat(x));
      const dx = lens[0],
        dy = lens[1],
        sd = lens[2] || 0; // the third length IS the standard deviation (Filter Effects 1 §5.7; Chrome blurs by exactly it)
      const src = last;
      const blur = push('feGaussianBlur', [alphaOf()], { sigmaX: sd, sigmaY: sd });
      const off = push('feOffset', [blur], { dx, dy });
      const flood = push('feFlood', [], { rgba });
      const tint = push('feComposite', [flood, off], { op: 1, k: [0, 0, 0, 0] });
      last = push('feMerge', [tint, src], {});
    }
  }
  if (!nodes.length) return { graph: null, urlIds };
  // The primitives that read a stage's clip start a stage of their own: their default subregion is the filter region, not the clip.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (clips.has(i) || !n.inputs.some((j) => clips.has(j))) continue;
    nodes[i] = { ...n, params: { ...(n.params || {}), subRegion: 1 } };
  }
  return { graph: { nodes, rootOut: last }, urlIds };
}
