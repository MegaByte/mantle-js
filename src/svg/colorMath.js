// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/colorMath.js — the CSS math functions (calc, min, max, clamp, round, mod, rem, abs, sign, sqrt, pow, hypot, log, exp,
// sin, cos, tan, asin, acos, atan, atan2) as they may appear INSIDE a color function (CSS Values 4 §10, CSS Color 4 / 5).
//
// A color channel takes a number, a percentage or (for a hue) an angle, so every value here has a KIND: 'n' number, 'p' percentage
// (the value is the percent figure, 50 for 50%) or 'a' angle (the value is in degrees). `+`, `-`, min, max, clamp, mod, rem and
// round need operands of one kind; `*` needs a number on one side; `/` needs a number on the right. An identifier is a
// constant (pi, e, infinity, -infinity, NaN) or a key of `env` (a relative color's channel keywords, always numbers). Returns
// { v, k } or null when the expression is not valid; the caller turns a 'p' into the channel's own scale.
//
// Pure, no state. Resolved at import: nothing here runs while drawing.

const NUM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/;
const ANGLE_UNITS = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === '*' || c === '/') {
      out.push(c);
      i++;
      continue;
    }
    const m = NUM.exec(s.slice(i, i + 40));
    if (m && (c !== '+' && c !== '-' ? true : /[\d.]/.test(s[i + 1] || ''))) {
      i += m[0].length;
      let unit = '';
      if (s[i] === '%') {
        unit = '%';
        i++;
      } else {
        const u = /^[a-z]+/.exec(s.slice(i, i + 12));
        if (u) {
          unit = u[0];
          i += unit.length;
        }
      }
      out.push({ n: parseFloat(m[0]), unit });
      continue;
    }
    if (c === '+' || c === '-') {
      const id = c === '-' ? /^-[a-z_][a-z0-9_-]*/.exec(s.slice(i, i + 40)) : null;
      if (id) {
        out.push({ id: id[0] });
        i += id[0].length;
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    const id = /^[a-z_][a-z0-9_-]*/.exec(s.slice(i, i + 40));
    if (!id) return null;
    out.push({ id: id[0] });
    i += id[0].length;
  }
  return out;
}

const FUNCS = new Set([
  'calc',
  'min',
  'max',
  'clamp',
  'round',
  'mod',
  'rem',
  'abs',
  'sign',
  'sqrt',
  'pow',
  'hypot',
  'log',
  'exp',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
]);
export const isMathFunction = (name) => FUNCS.has(name);

/// Evaluate `text`, a whole math-function call such as `calc(r * 2)`. `env` maps identifiers to numbers (or is null).
export function evalColorMath(text, env) {
  const toks = tokenize(text.toLowerCase());
  if (!toks || toks.length < 3) return null;
  const p = { toks, i: 0, env: env || null };
  const r = factor(p);
  return r && p.i === toks.length ? r : null; // NaN / Infinity are values (the channel clamps them)
}

const peek = (p) => p.toks[p.i];
const num = (v) => ({ v, k: 'n' });

function expr(p) {
  let a = term(p);
  while (a && (peek(p) === '+' || peek(p) === '-')) {
    const op = p.toks[p.i++],
      b = term(p);
    if (!b || a.k !== b.k) return null;
    a = { v: op === '+' ? a.v + b.v : a.v - b.v, k: a.k };
  }
  return a;
}
function term(p) {
  let a = factor(p);
  while (a && (peek(p) === '*' || peek(p) === '/')) {
    const op = p.toks[p.i++],
      b = factor(p);
    if (!b) return null;
    if (op === '*') {
      if (a.k !== 'n' && b.k !== 'n') return null;
      a = { v: a.v * b.v, k: a.k === 'n' ? b.k : a.k };
    } else {
      if (b.k !== 'n') return null;
      a = { v: a.v / b.v, k: a.k };
    }
  }
  return a;
}
function factor(p) {
  const t = p.toks[p.i++];
  if (t === undefined) return null;
  if (t === '(') {
    const r = expr(p);
    return r && p.toks[p.i++] === ')' ? r : null;
  }
  if (typeof t === 'string') return null;
  if (t.n !== undefined) {
    if (t.unit === '') return num(t.n);
    if (t.unit === '%') return { v: t.n, k: 'p' };
    return t.unit in ANGLE_UNITS ? { v: t.n * ANGLE_UNITS[t.unit], k: 'a' } : null;
  }
  const id = t.id;
  if (peek(p) === '(' && FUNCS.has(id)) {
    p.i++;
    return call(id, p);
  }
  switch (id) {
    case 'pi':
      return num(Math.PI);
    case 'e':
      return num(Math.E);
    case 'infinity':
      return num(Infinity);
    case '-infinity':
      return num(-Infinity);
    case 'nan':
      return num(NaN);
    default:
      return p.env && Object.prototype.hasOwnProperty.call(p.env, id) ? num(p.env[id]) : null;
  }
}
// The arguments of a function: expressions separated by commas, up to the closing paren (consumed). `round` may lead with a keyword.
function call(name, p) {
  const args = [];
  let strategy = null;
  if (name === 'round') {
    const t = peek(p);
    if (t && t.id && /^(nearest|up|down|to-zero)$/.test(t.id) && p.toks[p.i + 1] === ',') {
      strategy = t.id;
      p.i += 2;
    }
  }
  if (peek(p) === ')') return null;
  for (;;) {
    const a = expr(p);
    if (!a) return null;
    args.push(a);
    const t = p.toks[p.i++];
    if (t === ')') break;
    if (t !== ',' || name === 'calc') return null;
  }
  const same = args.every((a) => a.k === args[0].k);
  const v = args.map((a) => a.v);
  const k0 = args[0].k;
  const n1 = () => args.length === 1 && k0 === 'n';
  switch (name) {
    case 'calc':
      return args.length === 1 ? args[0] : null;
    case 'min':
      return same ? { v: Math.min(...v), k: k0 } : null;
    case 'max':
      return same ? { v: Math.max(...v), k: k0 } : null;
    case 'clamp':
      return args.length === 3 && same ? { v: Math.min(Math.max(v[0], v[1]), v[2]), k: k0 } : null;
    case 'abs':
      return args.length === 1 ? { v: Math.abs(v[0]), k: k0 } : null;
    case 'sign':
      return args.length === 1 ? num(Math.sign(v[0])) : null;
    case 'sqrt':
      return n1() ? num(Math.sqrt(v[0])) : null;
    case 'exp':
      return n1() ? num(Math.exp(v[0])) : null;
    case 'log':
      return args.length >= 1 && args.length <= 2 && args.every((a) => a.k === 'n')
        ? num(args.length === 2 ? Math.log(v[0]) / Math.log(v[1]) : Math.log(v[0]))
        : null;
    case 'pow':
      return args.length === 2 && args.every((a) => a.k === 'n') ? num(Math.pow(v[0], v[1])) : null;
    case 'hypot':
      return same ? { v: Math.hypot(...v), k: k0 } : null;
    case 'sin':
    case 'cos':
    case 'tan': {
      if (args.length !== 1 || (k0 !== 'n' && k0 !== 'a')) return null;
      const rad = k0 === 'a' ? (v[0] * Math.PI) / 180 : v[0];
      return num(name === 'sin' ? Math.sin(rad) : name === 'cos' ? Math.cos(rad) : Math.tan(rad));
    }
    case 'asin':
    case 'acos':
    case 'atan': {
      if (!n1()) return null;
      const r =
        name === 'asin' ? Math.asin(v[0]) : name === 'acos' ? Math.acos(v[0]) : Math.atan(v[0]);
      return { v: (r * 180) / Math.PI, k: 'a' };
    }
    case 'atan2':
      return args.length === 2 && same
        ? { v: (Math.atan2(v[0], v[1]) * 180) / Math.PI, k: 'a' }
        : null;
    case 'mod':
    case 'rem': {
      if (args.length !== 2 || !same) return null;
      const r = name === 'rem' ? v[0] % v[1] : ((v[0] % v[1]) + v[1]) % v[1];
      return { v: r, k: k0 };
    }
    case 'round': {
      if (!same || args.length < 1 || args.length > 2) return null;
      const step = args.length === 2 ? v[1] : 1;
      const q = v[0] / step;
      const r =
        strategy === 'up'
          ? Math.ceil(q)
          : strategy === 'down'
            ? Math.floor(q)
            : strategy === 'to-zero'
              ? Math.trunc(q)
              : Math.round(q);
      return { v: r * step, k: k0 };
    }
    default:
      return null;
  }
}
