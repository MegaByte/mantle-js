// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/cssTransform.js -- the CSS transform properties of an SVG element (CSS Transforms 1 and 2; SVG 2 §8):
// `transform`, `translate`, `rotate`, `scale`, `transform-origin` and `transform-box`.
//
// The element's matrix is   T(origin) * translate * rotate * scale * transform * T(-origin)   where `origin` is the
// transform-origin resolved against the reference box of transform-box. An element with NONE of the six properties
// authored in CSS keeps the `transform` ATTRIBUTE's matrix untouched (elementMatrix returns it as given); with any of
// them, the CSS `transform` replaces the attribute (the attribute is the lowest layer of the same property), and
// transform-origin and the individual properties apply around whichever transform results.
//
// Supported: every 2D transform function, translate3d / scale3d / rotateZ and a 2D-reducible matrix3d (no depth,
// no perspective); lengths in every absolute and font-relative unit; percentages against the reference box;
// transform-origin keywords, lengths and percentages; transform-box view-box (default), fill-box and content-box
// against the element's geometry box; a CSS math function (calc, min, max, clamp ...) as a length, angle or number argument.
// Not supported, and the declaration is then ignored as an invalid one: 3D functions and axes (rotateX / rotateY / rotate3d
// off z / perspective).
// stroke-box and border-box are the fill box (the stroke extent is not added).
//
// The used transform-origin of an SVG element without a CSS layout box is `0 0` of the reference box when the
// property is not authored (CSS Transforms 1 §transform-origin).

import { IDENT, matMul, transformSegInto } from './transform.js';
import { getCssProp, isDisplayed } from './style.js';
import { parseLength, parseLengthOr } from './length.js';
import { parseShape } from './shape.js';
import { pathBbox } from './bbox.js';
import { mkLine } from './segment.js';
import { svgElementName, elementChildren, resolveIdRef } from './utils.js';

const NUM = '[+-]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][+-]?\\d+)?';
const LENGTH_RE = new RegExp(`^(${NUM})(px|em|rem|ex|ch|vw|vh|vmin|vmax|pt|pc|in|cm|mm|q)$`, 'i');
const PERCENT_RE = new RegExp(`^(${NUM})%$`);
const NUMBER_RE = new RegExp(`^${NUM}$`);
const ANGLE_RE = new RegExp(`^(${NUM})(deg|grad|rad|turn)$`, 'i');
const DEG = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

const PROPS = ['transform', 'translate', 'rotate', 'scale', 'transform-origin', 'transform-box'];

/// Whether any of the six properties is authored in CSS on `el`.
export function hasCssTransformProps(el) {
  if (!el || !el.getAttribute) return false;
  for (let i = 0; i < PROPS.length; i++) if (getCssProp(el, PROPS[i]) != null) return true;
  return !!originAttribute(el);
}

/// The `transform-origin` PRESENTATION ATTRIBUTE (SVG 2 8.5), the one transform property besides `transform` an attribute can state. As a
/// presentation attribute its lengths may be bare numbers, which are user units. '' when absent.
function originAttribute(el) {
  const raw = el.getAttribute('transform-origin');
  return raw ? raw.trim().replace(new RegExp(`(^|\\s)(${NUM})(?=\\s|$)`, 'g'), '$1$2px') : '';
}

/// A length token as { px } (absolute, resolved with `vp`), { pct } (of the reference box) or null.
function lengthToken(tok, vp, axis) {
  if (isMathFn(tok)) {
    // A math function may mix lengths and percentages (calc(50% - 4px)) or be nonlinear (min, max, clamp): resolve it against the
    // reference box when the box is known. A value that is not finite for any reference size is invalid.
    const at = (size) =>
      parseLength(tok, {
        ...(vp || {}),
        parentWidth: size,
        parentHeight: size,
        axis: axis === 'y' ? 'y' : 'x',
      });
    return Number.isFinite(at(0)) && Number.isFinite(at(100)) ? { fn: at } : null;
  }
  let m = PERCENT_RE.exec(tok);
  if (m) return { pct: parseFloat(m[1]) / 100 };
  if (/^[+-]?0*\.?0+$/.test(tok)) return { px: 0 };
  m = LENGTH_RE.exec(tok);
  if (!m) return null;
  const v = parseLengthOr(tok, NaN, vp ? { ...vp, axis } : undefined);
  return Number.isFinite(v) ? { px: v } : null;
}
const resolveLen = (l, size) => (l.fn ? l.fn(size) : l.pct !== undefined ? l.pct * size : l.px);

const isMathFn = (tok) =>
  /^(?:calc|min|max|clamp|round|mod|rem|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp|abs|sign|var)\(/i.test(
    tok,
  );

function angleToken(tok) {
  if (isMathFn(tok)) {
    const r = parseLength(tok);
    return Number.isFinite(r) ? (r * 180) / Math.PI : NaN;
  } // the length parser answers an angle in radians
  const m = ANGLE_RE.exec(tok);
  if (m) return parseFloat(m[1]) * DEG[m[2].toLowerCase()];
  return /^[+-]?0*\.?0+$/.test(tok) ? 0 : NaN;
}
const numberToken = (tok) =>
  NUMBER_RE.test(tok) ? parseFloat(tok) : isMathFn(tok) ? parseLength(tok) : NaN;

const rotation = (deg) => {
  const a = (deg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
};

/// The CSS `transform` property value as a function of the reference box, or null when it is invalid or unsupported.
/// `none` is the identity.
function parseTransformProperty(text, vp) {
  const v = text.trim();
  if (/^none$/i.test(v)) return () => IDENT;
  const fnRe = /\s*([a-zA-Z0-9]+)\(/y;
  const steps = [];
  let i = 0;
  while (i < v.length) {
    fnRe.lastIndex = i;
    const m = fnRe.exec(v);
    if (!m) return null;
    const close = matchingParen(v, fnRe.lastIndex - 1);
    if (close < 0) return null;
    const inner = v.slice(fnRe.lastIndex, close);
    i = close + 1;
    const name = m[1].toLowerCase();
    const args = splitTopLevel(inner, ',').map((a) => a.trim());
    if (args.some((a) => a === '')) return null;
    const n = args.length;
    const len = (k, axis) => lengthToken(args[k], vp, axis);
    const need = (lo, hi) => n >= lo && n <= hi;
    let step = null;
    if (name === 'matrix' && n === 6) {
      const nums = args.map(numberToken);
      if (nums.every(Number.isFinite)) step = () => nums;
    } else if (name === 'matrix3d' && n === 16) {
      const k = args.map(numberToken);
      if (
        k.every(Number.isFinite) &&
        k[2] === 0 &&
        k[3] === 0 &&
        k[6] === 0 &&
        k[7] === 0 &&
        k[8] === 0 &&
        k[9] === 0 &&
        k[10] === 1 &&
        k[11] === 0 &&
        k[14] === 0 &&
        k[15] === 1
      ) {
        const mat = [k[0], k[1], k[4], k[5], k[12], k[13]];
        step = () => mat;
      }
    } else if (name === 'translate' || name === 'translate3d') {
      if (need(1, name === 'translate' ? 2 : 3) && (name === 'translate' || n === 3)) {
        const x = len(0, 'x'),
          y = n > 1 ? len(1, 'y') : { px: 0 };
        if (x && y && (n < 3 || lengthToken(args[2], vp, 'x'))) {
          step = (box) => [1, 0, 0, 1, resolveLen(x, box.w), resolveLen(y, box.h)];
        }
      }
    } else if (name === 'translatex' && n === 1) {
      const x = len(0, 'x');
      if (x) step = (box) => [1, 0, 0, 1, resolveLen(x, box.w), 0];
    } else if (name === 'translatey' && n === 1) {
      const y = len(0, 'y');
      if (y) step = (box) => [1, 0, 0, 1, 0, resolveLen(y, box.h)];
    } else if ((name === 'scale' && need(1, 2)) || (name === 'scale3d' && n === 3)) {
      const sx = numberToken(args[0]),
        sy =
          n > 1 && name === 'scale'
            ? numberToken(args[1])
            : name === 'scale3d'
              ? numberToken(args[1])
              : sx;
      if (
        Number.isFinite(sx) &&
        Number.isFinite(sy) &&
        (name === 'scale' || Number.isFinite(numberToken(args[2])))
      ) {
        step = () => [sx, 0, 0, sy, 0, 0];
      }
    } else if (name === 'scalex' && n === 1) {
      const sx = numberToken(args[0]);
      if (Number.isFinite(sx)) step = () => [sx, 0, 0, 1, 0, 0];
    } else if (name === 'scaley' && n === 1) {
      const sy = numberToken(args[0]);
      if (Number.isFinite(sy)) step = () => [1, 0, 0, sy, 0, 0];
    } else if ((name === 'rotate' || name === 'rotatez') && n === 1) {
      const a = angleToken(args[0]);
      if (Number.isFinite(a)) step = () => rotation(a);
    } else if (name === 'skewx' && n === 1) {
      const a = angleToken(args[0]);
      if (Number.isFinite(a)) step = () => [1, 0, Math.tan((a * Math.PI) / 180), 1, 0, 0];
    } else if (name === 'skewy' && n === 1) {
      const a = angleToken(args[0]);
      if (Number.isFinite(a)) step = () => [1, Math.tan((a * Math.PI) / 180), 0, 1, 0, 0];
    } else if (name === 'skew' && need(1, 2)) {
      const ax = angleToken(args[0]),
        ay = n > 1 ? angleToken(args[1]) : 0;
      if (Number.isFinite(ax) && Number.isFinite(ay)) {
        step = () => [1, Math.tan((ay * Math.PI) / 180), Math.tan((ax * Math.PI) / 180), 1, 0, 0];
      }
    }
    if (!step) return null;
    steps.push(step);
  }
  if (!steps.length) return null;
  return (box) => {
    let r = IDENT;
    for (const st of steps) r = matMul(r, st(box));
    return r;
  };
}

/// The index of the ')' closing the '(' at `open`, or -1.
function matchingParen(v, open) {
  let depth = 0;
  for (let k = open; k < v.length; k++) {
    if (v[k] === '(') depth++;
    else if (v[k] === ')' && --depth === 0) return k;
  }
  return -1;
}

/// `v` split at `sep` outside parentheses (whitespace separators collapse).
function splitTopLevel(v, sep) {
  const out = [];
  let depth = 0,
    cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (sep !== ' ' || cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (sep !== ' ' || cur) out.push(cur);
  return out;
}

const tokens = (v) => splitTopLevel(v.trim(), ' ');

function parseTranslateProperty(text, vp) {
  const v = text.trim();
  if (/^none$/i.test(v)) return () => IDENT;
  const t = tokens(v);
  if (t.length < 1 || t.length > 3) return null;
  const x = lengthToken(t[0], vp, 'x'),
    y = t.length > 1 ? lengthToken(t[1], vp, 'y') : { px: 0 };
  if (!x || !y) return null;
  if (
    t.length === 3 &&
    !(lengthToken(t[2], vp, 'x') && lengthToken(t[2], vp, 'x').px !== undefined)
  )
    return null;
  return (box) => [1, 0, 0, 1, resolveLen(x, box.w), resolveLen(y, box.h)];
}

function parseScaleProperty(text) {
  const v = text.trim();
  if (/^none$/i.test(v)) return () => IDENT;
  const t = tokens(v);
  if (t.length < 1 || t.length > 3) return null;
  const val = t.map((s) => {
    const p = PERCENT_RE.exec(s);
    return p ? parseFloat(p[1]) / 100 : numberToken(s);
  });
  if (!val.every(Number.isFinite)) return null;
  const sx = val[0],
    sy = t.length > 1 ? val[1] : sx;
  return () => [sx, 0, 0, sy, 0, 0];
}

function parseRotateProperty(text) {
  const v = text.trim();
  if (/^none$/i.test(v)) return () => IDENT;
  const t = tokens(v);
  let deg = NaN;
  if (t.length === 1) deg = angleToken(t[0]);
  else if (t.length === 2 && /^z$/i.test(t[0])) deg = angleToken(t[1]);
  else if (t.length === 2 && /^z$/i.test(t[1])) deg = angleToken(t[0]);
  else if (t.length === 4) {
    const [x, y, z] = t.slice(0, 3).map(numberToken);
    const a = angleToken(t[3]);
    if (x === 0 && y === 0 && Number.isFinite(z) && z !== 0 && Number.isFinite(a))
      deg = z > 0 ? a : -a;
  }
  if (!Number.isFinite(deg)) return null;
  return () => rotation(deg);
}

const ORIGIN_X = { left: 0, center: 0.5, right: 1 };
const ORIGIN_Y = { top: 0, center: 0.5, bottom: 1 };

/// transform-origin as a function of the reference box -> [dx, dy] from the box's origin, or null when invalid.
function parseOrigin(text, vp) {
  const t = tokens(text.toLowerCase());
  if (t.length < 1 || t.length > 3) return null;
  if (
    t.length === 3 &&
    !(lengthToken(t[2], vp, 'x') && lengthToken(t[2], vp, 'x').px !== undefined)
  )
    return null;
  const a = t[0],
    b = t.length > 1 ? t[1] : 'center';
  const isX = (s) => s in ORIGIN_X,
    isY = (s) => s in ORIGIN_Y;
  const single = t.length === 1;
  // One keyword: top / bottom name the vertical component and the horizontal is center; one length is the
  // horizontal component with a centered vertical.
  let xTok, yTok;
  if (single && isY(a) && !isX(a)) {
    xTok = 'center';
    yTok = a;
  } else if (isX(a) && !(isY(a) && !isX(a))) {
    // `left top`, `left 5px`, `center top`...: x then y. A y-only keyword first (`top left`) swaps.
    xTok = a;
    yTok = b;
  } else if (isY(a) && !isX(a)) {
    // `top left`, `bottom center`: both must be keywords.
    if (!(isX(b) || b === 'center')) return null;
    xTok = b;
    yTok = a;
  } else {
    xTok = a;
    yTok = b;
  }
  const comp = (tok, kw, axis) => {
    if (Object.hasOwn(kw, tok)) return { pct: kw[tok] };
    return lengthToken(tok, vp, axis);
  };
  const x = comp(xTok, ORIGIN_X, 'x'),
    y = comp(yTok, ORIGIN_Y, 'y');
  if (!x || !y) return null;
  // A y keyword may not stand in the x slot and an x keyword not in the y slot.
  if (
    (Object.hasOwn(ORIGIN_X, yTok) && !Object.hasOwn(ORIGIN_Y, yTok)) ||
    (Object.hasOwn(ORIGIN_Y, xTok) && !Object.hasOwn(ORIGIN_X, xTok))
  )
    return null;
  return (box) => [resolveLen(x, box.w), resolveLen(y, box.h)];
}

const BOXES = new Set(['view-box', 'fill-box', 'stroke-box', 'border-box', 'content-box']);

/// The geometry segments of `node` in its own user space (its own transform excluded), appended to `out`, as the
/// exact outline the fill-box measures. Shapes, groups, links, switches, nested <svg> (its viewBox fit ignored),
/// <use> of a shape or group (a symbol's viewport fit ignored) and <image> contribute; text does not.
/// `env` = { viewport, idMap, matrixOf(node) }.
function collectGeometry(node, m, out, env, depth) {
  if (depth > 24) return;
  const tag = svgElementName(node);
  if (
    tag === 'defs' ||
    tag === 'clippath' ||
    tag === 'mask' ||
    tag === 'marker' ||
    tag === 'pattern' ||
    tag === 'lineargradient' ||
    tag === 'radialgradient' ||
    tag === 'filter' ||
    tag === 'symbol'
  )
    return;
  if (node.getAttribute && !isDisplayed(node)) return;
  if (
    tag === 'path' ||
    tag === 'rect' ||
    tag === 'circle' ||
    tag === 'ellipse' ||
    tag === 'line' ||
    tag === 'polyline' ||
    tag === 'polygon'
  ) {
    for (const sg of parseShape(node, env.viewport)) transformSegInto(sg, m, out);
    return;
  }
  if (tag === 'image') {
    const vx = env.viewport ? { ...env.viewport, axis: 'x' } : undefined,
      vy = env.viewport ? { ...env.viewport, axis: 'y' } : undefined;
    const x = parseLengthOr(node.getAttribute('x'), 0, vx),
      y = parseLengthOr(node.getAttribute('y'), 0, vy);
    const w = parseLengthOr(node.getAttribute('width'), 0, vx),
      h = parseLengthOr(node.getAttribute('height'), 0, vy);
    if (w > 0 && h > 0) {
      const c = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      for (let k = 0; k < 4; k++) transformSegInto(mkLine(c[k], c[(k + 1) & 3]), m, out);
    }
    return;
  }
  if (tag === 'use') {
    const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
    const id = resolveIdRef(href);
    const target = id && env.idMap[id];
    if (!target || target === node) return;
    const vx = env.viewport ? { ...env.viewport, axis: 'x' } : undefined,
      vy = env.viewport ? { ...env.viewport, axis: 'y' } : undefined;
    const x = parseLengthOr(node.getAttribute('x') || '0', 0, vx),
      y = parseLengthOr(node.getAttribute('y') || '0', 0, vy);
    const mu = matMul(m, [1, 0, 0, 1, x, y]);
    if (svgElementName(target) === 'symbol') {
      for (const c of elementChildren(target))
        collectGeometry(c, matMul(mu, env.matrixOf(c)), out, env, depth + 1);
    } else collectGeometry(target, matMul(mu, env.matrixOf(target)), out, env, depth + 1);
    return;
  }
  for (const c of elementChildren(node))
    collectGeometry(c, matMul(m, env.matrixOf(c)), out, env, depth + 1);
}

/// The geometry box { x, y, w, h } of `node` in its own user space, or zeros when it has none.
function geometryBox(node, env) {
  const segs = [];
  collectGeometry(node, IDENT, segs, env, 0);
  const b = segs.length ? pathBbox(segs) : null;
  return b && b.every(Number.isFinite)
    ? { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }
    : { x: 0, y: 0, w: 0, h: 0 };
}

/// The matrix of `node` given its `transform` attribute's matrix `attrMatrix`. Identity-preserving: with no CSS
/// transform property authored on the element, `attrMatrix` is returned as is. `env` = { viewport, idMap, matrixOf }.
export function elementMatrix(node, attrMatrix, env) {
  if (!hasCssTransformProps(node)) return attrMatrix;
  const vp = env.viewport;
  const read = (name, parse) => {
    const v = getCssProp(node, name);
    return v == null ? null : parse(v, vp);
  };
  const tf = read('transform', parseTransformProperty);
  const tr = read('translate', parseTranslateProperty);
  const ro = read('rotate', parseRotateProperty);
  const sc = read('scale', parseScaleProperty);
  const og =
    read('transform-origin', parseOrigin) ||
    (originAttribute(node) ? parseOrigin(originAttribute(node), vp) : null);
  const boxKind = (getCssProp(node, 'transform-box') || '').trim().toLowerCase();
  if (!tf && !tr && !ro && !sc && !og) return attrMatrix;
  const kind = BOXES.has(boxKind) ? boxKind : 'view-box';
  const box =
    kind === 'view-box'
      ? { x: 0, y: 0, w: (vp && +vp.parentWidth) || 0, h: (vp && +vp.parentHeight) || 0 }
      : geometryBox(node, env);
  let m = IDENT;
  if (tr) m = matMul(m, tr(box));
  if (ro) m = matMul(m, ro(box));
  if (sc) m = matMul(m, sc(box));
  m = matMul(m, tf ? tf(box) : attrMatrix);
  const [dx, dy] = og ? og(box) : [0, 0];
  const ox = box.x + dx,
    oy = box.y + dy;
  return matMul(matMul([1, 0, 0, 1, ox, oy], m), [1, 0, 0, 1, -ox, -oy]);
}
