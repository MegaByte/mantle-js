// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/length.js — CSS length parser with calc() / var() / min() / max() /
// clamp() support.
//
// SVG attributes that accept a `<length>` (per SVG 2 §8) can be:
//   - a bare number (user units):              "12"
//   - a number with unit suffix:               "12px", "1em", "50%"
//   - a CSS math function:                     "calc(100% - 20px)"
//   - a CSS Variables var() reference:         "var(--w)" / "var(--w, 12px)"
//   - a CSS Values 4 math function:            "min(100, 50%)" / "clamp(0, var(--x), 100)"
//
// All collapse to a single em-space (user-unit) number at import time;
// every length reaching the GPU is a finite float.
//
// Resolution context:
//   ctx = {
//     parentWidth?: number,    // resolves "%"; default 0 (yields 0)
//     parentHeight?: number,   // optional axis selector for %; if absent,
//                              // falls back to parentWidth.
//     fontSize?: number,       // resolves "em" / "ex" / "ch"; default 16
//     rootFontSize?: number,   // resolves "rem"; default fontSize
//     viewportWidth?: number,  // resolves "vw" / "vmin" / "vmax": the root viewport's width
//     viewportHeight?: number, // ...and "vh": its height (in px; the walker supplies both)
//     vars?: Map<string, string>,  // CSS custom-property substitution
//     axis?: 'x' | 'y' | 'd',  // selects parentWidth vs parentHeight for %
//                              // 'd' = the SVG-2 "diagonal" axis used by r/rx/ry
//                              //       — sqrt((w² + h²) / 2)
//   }
//
// All ctx fields are optional; missing context resolves the relevant
// units to 0 (per SVG 2 — "auto" lengths in unresolvable contexts
// degrade gracefully).
//
// A unit this parser does not know ("5foo", a bare "1e") makes the whole value invalid (NaN), as it is in CSS;
// "ex" and "ch" are half an em (the metric a font without x-height data reports), "vw" / "vh" / "vmin" / "vmax" are
// percents of the root viewport (ctx.viewportWidth / viewportHeight, 0 when absent).
//
// Return: a finite number, or NaN if the input is unparseable. Callers
// typically `|| fallback` the result.

const FN_NAMES = new Set([
  'calc',
  'min',
  'max',
  'clamp',
  'var',
  // CSS Values 4 stepped value functions
  'round',
  'mod',
  'rem',
  // CSS Values 4 trig
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  // CSS Values 4 exponential
  'pow',
  'sqrt',
  'hypot',
  'log',
  'exp',
  // CSS Values 4 sign-related
  'abs',
  'sign',
]);
// Identifier keywords that round() accepts as a rounding strategy.
const ROUND_STRATEGIES = new Set(['nearest', 'up', 'down', 'to-zero']);

/**
 * Parse a CSS length string into a user-unit number.
 * @param {string|number|null|undefined} input
 * @param {object} [ctx]
 * @returns {number}
 */
export function parseLength(input, ctx) {
  if (input == null) return NaN;
  if (typeof input === 'number') return input;
  let s = String(input).trim();
  if (!s) return NaN;
  // Fast path: bare number with optional unit, no function call.
  if (!s.includes('(')) {
    return parseUnit(s, ctx);
  }
  return evalExpr(s, ctx);
}

/**
 * Like parseLength but returns the fallback when the result is non-
 * finite. Equivalent of `parseFloat(s) || fallback` but calc-aware.
 */
export function parseLengthOr(input, fallback, ctx) {
  const v = parseLength(input, ctx);
  return Number.isFinite(v) ? v : fallback;
}

// ---- helpers --------------------------------------------------------

function pct100Of(ctx) {
  if (!ctx) return 0;
  const w = +ctx.parentWidth || 0;
  const h = +ctx.parentHeight;
  switch (ctx.axis) {
    case 'y':
      return Number.isFinite(h) ? h : w;
    case 'd':
      if (!Number.isFinite(h)) return w;
      // SVG 2 "diagonal" percentage axis used by r/rx/ry/text-base.
      return Math.sqrt((w * w + h * h) / 2);
    case 'x':
    default:
      return w;
  }
}

function emBase(ctx) {
  return (ctx && ctx.fontSize) || 16;
}
function vwBase(ctx) {
  return (ctx && +ctx.viewportWidth) || 0;
}
function vhBase(ctx) {
  return (ctx && +ctx.viewportHeight) || 0;
}
function remBase(ctx) {
  return (ctx && ctx.rootFontSize) || emBase(ctx);
}

/** Convert "<number><unit>?" → user-unit number. Unitless and px are
 *  identity; em/rem use ctx.fontSize; % uses ctx.parent{Width,Height}. */
function parseUnit(s, ctx) {
  // Match leading number (with optional sign/decimal/exponent).
  const m = /^([+-]?(?:\d*\.?\d+|\d+\.)(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i.exec(s);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return NaN;
  const unit = m[2].toLowerCase();
  if (!unit || unit === 'px') return n;
  if (unit === '%') return (n * pct100Of(ctx)) / 100;
  if (unit === 'em') return n * emBase(ctx);
  if (unit === 'rem') return n * remBase(ctx);
  if (unit === 'ex' || unit === 'ch') return n * 0.5 * emBase(ctx);
  if (unit === 'vw') return (n * vwBase(ctx)) / 100;
  if (unit === 'vh') return (n * vhBase(ctx)) / 100;
  if (unit === 'vmin') return (n * Math.min(vwBase(ctx), vhBase(ctx))) / 100;
  if (unit === 'vmax') return (n * Math.max(vwBase(ctx), vhBase(ctx))) / 100;
  // SVG 1.1 absolute units. Use CSS px equivalents.
  if (unit === 'pt') return n * (96 / 72); // 1pt  = 4/3 px
  if (unit === 'pc') return n * 16; // 1pc  = 12pt
  if (unit === 'in') return n * 96;
  if (unit === 'cm') return n * (96 / 2.54);
  if (unit === 'mm') return n * (96 / 25.4);
  if (unit === 'q') return n * (96 / 25.4 / 4);
  if (unit === 'deg') return (n * Math.PI) / 180;
  if (unit === 'rad') return n;
  if (unit === 'grad') return (n * Math.PI) / 200;
  if (unit === 'turn') return n * 2 * Math.PI;
  return NaN; // unknown unit: the value is invalid
}

/// An <angle> in radians: a number is DEGREES (the SVG attribute form, e.g. marker orient="90"), and deg, grad, rad
/// and turn convert. NaN for anything else, including a length unit.
export function parseAngle(input) {
  if (typeof input === 'number') return (input * Math.PI) / 180;
  const m = /^\s*([+-]?(?:\d*\.?\d+|\d+\.)(?:[eE][+-]?\d+)?)(deg|grad|rad|turn)?\s*$/i.exec(
    String(input == null ? '' : input),
  );
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  switch ((m[2] || 'deg').toLowerCase()) {
    case 'rad':
      return n;
    case 'grad':
      return (n * Math.PI) / 200;
    case 'turn':
      return n * 2 * Math.PI;
    default:
      return (n * Math.PI) / 180;
  }
}

// Tokenizer + recursive-descent evaluator for the CSS math grammar.
// Grammar (relaxed):
//   expr     := term (('+' | '-') term)*
//   term     := factor (('*' | '/') factor)*
//   factor   := '(' expr ')' | fn '(' args ')' | numWithUnit
//   fn       := 'calc' | 'min' | 'max' | 'clamp' | 'var'
//   args     := expr (',' expr)*
//   numWithUnit := number unit?
function evalExpr(s, ctx) {
  const tokens = tokenize(s);
  const p = { toks: tokens, pos: 0 };
  const v = parseExpr(p, ctx);
  if (p.pos !== tokens.length) return NaN; // trailing garbage
  return v;
}

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push(c);
      i++;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      // CSS custom-property identifiers start with `--` (e.g. var(--w)).
      // Don't split `--foo` into two minus operators — fall through to
      // the regex so it captures the whole ident.
      if (c === '-' && s[i + 1] === '-') {
        // fall through to the regex below
      } else {
        out.push(c);
        i++;
        continue;
      }
    }
    // Number with optional unit / function name.
    const re = /[+-]?(?:\d*\.?\d+|\d+\.)(?:[eE][+-]?\d+)?[a-z%]*|[a-z][a-z0-9-]*|--[a-z0-9-]*/iy;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return []; // tokenize fail — caller falls back to NaN
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

function peek(p) {
  return p.pos < p.toks.length ? p.toks[p.pos] : null;
}
function eat(p) {
  return p.toks[p.pos++];
}

function parseExpr(p, ctx) {
  let v = parseTerm(p, ctx);
  while (peek(p) === '+' || peek(p) === '-') {
    const op = eat(p);
    const rhs = parseTerm(p, ctx);
    v = op === '+' ? v + rhs : v - rhs;
  }
  return v;
}

function parseTerm(p, ctx) {
  let v = parseFactor(p, ctx);
  while (peek(p) === '*' || peek(p) === '/') {
    const op = eat(p);
    const rhs = parseFactor(p, ctx);
    v = op === '*' ? v * rhs : v / rhs;
  }
  return v;
}

function parseFactor(p, ctx) {
  const t = peek(p);
  if (t == null) return NaN;
  if (t === '(') {
    eat(p);
    const v = parseExpr(p, ctx);
    if (peek(p) !== ')') return NaN;
    eat(p);
    return v;
  }
  if (t === '+' || t === '-') {
    const sign = eat(p) === '-' ? -1 : 1;
    return sign * parseFactor(p, ctx);
  }
  // Function call?
  if (FN_NAMES.has(t.toLowerCase()) && p.toks[p.pos + 1] === '(') {
    return parseFnCall(p, ctx);
  }
  // Number with optional unit.
  eat(p);
  return parseUnit(t, ctx);
}

function parseFnCall(p, ctx) {
  const name = eat(p).toLowerCase();
  eat(p); // consume '('
  // var() has its own grammar: var(<ident> [, fallback])
  if (name === 'var') {
    const ident = eat(p);
    let fallback = NaN;
    if (peek(p) === ',') {
      eat(p);
      // Fallback is itself a value expression. Re-serialize remaining
      // tokens up to the matching ')' and parse as a length string.
      const start = p.pos;
      let depth = 1;
      while (p.pos < p.toks.length && depth > 0) {
        const tk = p.toks[p.pos];
        if (tk === '(') depth++;
        else if (tk === ')') {
          depth--;
          if (depth === 0) break;
        }
        p.pos++;
      }
      const fbStr = p.toks.slice(start, p.pos).join(' ');
      fallback = parseLength(fbStr, ctx);
    }
    if (peek(p) !== ')') return NaN;
    eat(p);
    if (ctx && ctx.vars && ctx.vars.has(ident)) {
      return parseLength(ctx.vars.get(ident), ctx);
    }
    return fallback;
  }
  // round() takes an optional leading strategy identifier.
  // round(<strategy>?, A, B) where strategy ∈ {nearest, up, down, to-zero}.
  let roundStrategy = 'nearest';
  if (name === 'round') {
    const tk = peek(p);
    if (tk && ROUND_STRATEGIES.has(tk.toLowerCase())) {
      roundStrategy = eat(p).toLowerCase();
      if (peek(p) === ',') eat(p);
    }
  }
  const args = [];
  if (peek(p) !== ')') {
    args.push(parseExpr(p, ctx));
    while (peek(p) === ',') {
      eat(p);
      args.push(parseExpr(p, ctx));
    }
  }
  if (peek(p) !== ')') return NaN;
  eat(p);
  switch (name) {
    case 'calc':
      return args.length === 1 ? args[0] : NaN;
    case 'min':
      return Math.min(...args);
    case 'max':
      return Math.max(...args);
    case 'clamp':
      // clamp(min, val, max). Real spec is "max(min, min(val, max))".
      if (args.length < 3) return NaN;
      return Math.max(args[0], Math.min(args[1], args[2]));
    // --- Stepped value functions (CSS Values 4 §10.8) ----------------
    case 'round': {
      if (args.length < 2) return NaN;
      const a = args[0],
        b = args[1];
      if (b === 0) return NaN;
      const q = a / b;
      switch (roundStrategy) {
        case 'up':
          return Math.ceil(q) * b;
        case 'down':
          return Math.floor(q) * b;
        case 'to-zero':
          return Math.trunc(q) * b;
        case 'nearest':
        default:
          return Math.round(q) * b;
      }
    }
    case 'mod': {
      // Modulo with the sign of B (mathematical mod, per CSS spec).
      if (args.length < 2) return NaN;
      const a = args[0],
        b = args[1];
      if (b === 0) return NaN;
      return ((a % b) + b) % b;
    }
    case 'rem': {
      // Remainder with sign of A (C-style %).
      if (args.length < 2) return NaN;
      const a = args[0],
        b = args[1];
      if (b === 0) return NaN;
      return a % b;
    }

    case 'sin':
      return Math.sin(args[0]);
    case 'cos':
      return Math.cos(args[0]);
    case 'tan':
      return Math.tan(args[0]);
    case 'asin':
      return Math.asin(args[0]);
    case 'acos':
      return Math.acos(args[0]);
    case 'atan':
      return Math.atan(args[0]);
    case 'atan2':
      if (args.length < 2) return NaN;
      return Math.atan2(args[0], args[1]);
    // --- Exponential (CSS Values 4 §10.10) --------------------------
    case 'pow':
      if (args.length < 2) return NaN;
      return Math.pow(args[0], args[1]);
    case 'sqrt':
      return Math.sqrt(args[0]);
    case 'hypot':
      return Math.hypot(...args);
    case 'log':
      // log(A) is natural log; log(A, base) is log base `base` of A.
      if (args.length === 1) return Math.log(args[0]);
      if (args.length === 2) return Math.log(args[0]) / Math.log(args[1]);
      return NaN;
    case 'exp':
      return Math.exp(args[0]);
    // --- Sign-related (CSS Values 4 §10.11) -------------------------
    case 'abs':
      return Math.abs(args[0]);
    case 'sign':
      return Math.sign(args[0]);
  }
  return NaN;
}

// Split CSS length lists only between complete values, preserving function arguments.
export function splitLengthList(value) {
  const out = [];
  let start = 0,
    depth = 0;
  const text = String(value || '').trim();
  if (/^,|,\s*,|,\s*$/.test(text)) return null;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (--depth < 0) return null;
    }
    if (i === text.length || (depth === 0 && (ch === ',' || /\s/.test(ch)))) {
      const token = text.slice(start, i).trim();
      if (token) out.push(token);
      start = i + 1;
    }
  }
  return depth === 0 ? out : null;
}
