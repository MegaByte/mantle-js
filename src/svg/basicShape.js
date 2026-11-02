// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/basicShape.js -- CSS basic shapes as clip geometry (CSS Masking 1 `clip-path`, CSS Shapes 1 §basic-shape).
//
//   clip-path: [ <basic-shape> || <geometry-box> ]
//   <basic-shape>  = inset() | circle() | ellipse() | polygon() | path() | rect() | xywh()
//   <geometry-box> = margin-box | border-box | padding-box | content-box | fill-box | stroke-box | view-box
//
// A shape is parsed once (parseClipPathShape) into a plain record and resolved against its REFERENCE BOX when the box is known
// (shapeToPath): the result is the shape's exact outline as a path `d` in the user space of the element that carries the
// clip-path, with lines and native elliptical arcs only. Nothing is flattened, so the clip is exact at every scale.
//
// Reference boxes. An SVG element has no CSS layout box, so (CSS Masking 1 §geometry-box) content-box and padding-box are
// fill-box, border-box and margin-box are stroke-box, and view-box is the nearest SVG viewport; with no <geometry-box> the shape
// uses border-box, i.e. the STROKE box. fill-box is the object bounding box, stroke-box adds the stroke (svg/strokeBox.js).
// compat:'chrome' reads the omitted box as Chrome does (see boxKindOf).
import { parseLengthOr } from './length.js';

const BOXES = {
  'margin-box': 'stroke',
  'border-box': 'stroke',
  'padding-box': 'fill',
  'content-box': 'fill',
  'fill-box': 'fill',
  'stroke-box': 'stroke',
  'view-box': 'view',
};

/// Split `s` at top-level whitespace (and at top-level commas / slashes when `seps` says so); parentheses and quotes nest.
function tokens(s, seps = '') {
  const out = [];
  let cur = '',
    depth = 0,
    q = '';
  const push = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && /\s/.test(c)) {
      push();
      continue;
    }
    if (depth === 0 && seps.includes(c)) {
      push();
      out.push(c);
      continue;
    }
    cur += c;
  }
  push();
  return depth === 0 && !q ? out : null;
}

const LP = /^[+-]?(?:\d*\.?\d+|\d+\.)(?:e[+-]?\d+)?(?:[a-z%]+)?$|^(?:calc|min|max|clamp)\(/i;
const isLp = (t) => LP.test(t);
const isNeg = (t) => /^-\s*[\d.]/.test(t); // a literal negative number: radii and sizes may not be

const POS_KW = new Set(['left', 'right', 'top', 'bottom', 'center']);

/// <position> (CSS Values 4 §position) as { x: { edge, off }, y: { edge, off } }: `edge` 0 = from the start (left/top), 1 = from
/// the end (right/bottom), `off` a <length-percentage> token (percentages of the axis).
function parsePosition(toks) {
  const n = toks.length;
  if (n < 1 || n > 4) return null;
  const isKw = (t) => POS_KW.has(t.toLowerCase());
  const axisOf = (k) =>
    k === 'left' || k === 'right' ? 'x' : k === 'top' || k === 'bottom' ? 'y' : 'c';
  const res = { x: null, y: null };
  const kwSpec = (k, off) => ({
    edge: k === 'right' || k === 'bottom' ? 1 : 0,
    off: off == null ? '0px' : off,
    center: k === 'center' && off == null,
  });
  const t = toks.map((s) => (isKw(s) ? s.toLowerCase() : s));
  if (n === 1) {
    if (isLp(t[0])) {
      res.x = { edge: 0, off: t[0] };
      res.y = { edge: 0, off: '50%' };
    } else if (t[0] === 'center') {
      res.x = { edge: 0, off: '50%' };
      res.y = { edge: 0, off: '50%' };
    } else if (axisOf(t[0]) === 'x') {
      res.x = kwSpec(t[0]);
      res.y = { edge: 0, off: '50%' };
    } else if (axisOf(t[0]) === 'y') {
      res.y = kwSpec(t[0]);
      res.x = { edge: 0, off: '50%' };
    } else return null;
  } else if (n === 2) {
    const [a, b] = t;
    const spec = (k) =>
      isLp(k) ? { edge: 0, off: k } : k === 'center' ? { edge: 0, off: '50%' } : kwSpec(k);
    const ax = (k) => (isKw(k) ? axisOf(k) : '?');
    if ((ax(a) === 'y' && ax(b) === 'y') || (ax(a) === 'x' && ax(b) === 'x')) return null;
    if (ax(a) === 'y' || ax(b) === 'x') {
      res.y = spec(a);
      res.x = spec(b);
    } else {
      res.x = spec(a);
      res.y = spec(b);
    }
  } else {
    // 3 or 4 values: each keyword may be followed by an offset
    const items = [];
    for (let i = 0; i < n; i++) {
      if (!isKw(t[i])) return null;
      if (i + 1 < n && isLp(t[i + 1])) {
        items.push([t[i], t[i + 1]]);
        i++;
      } else items.push([t[i], null]);
    }
    for (const [k, off] of items) {
      const ax = axisOf(k);
      if (ax === 'c') {
        if (off != null) return null;
        if (!res.x) res.x = { edge: 0, off: '50%' };
        else if (!res.y) res.y = { edge: 0, off: '50%' };
        continue;
      }
      if (res[ax]) return null;
      res[ax] = kwSpec(k, off);
    }
    if (items.length !== 2) return null;
    if (!res.x || !res.y) return null;
  }
  if (!res.x || !res.y) return null;
  return res;
}

/// Parse the value of a `clip-path` property. Returns null when it is `none`, a `url()` / reference, or not valid; otherwise
/// { box: 'fill' | 'stroke' | 'view' | null (the property's default), kind, ... } (a record resolveShape reads).
export function parseClipPathShape(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /^none$/i.test(s) || /^url\(/i.test(s) || /^#/.test(s)) return null;
  const parts = tokens(s);
  if (!parts || !parts.length || parts.length > 2) return null;
  let box = null,
    shape = null,
    seenBox = false;
  for (const p of parts) {
    const kw = p.toLowerCase();
    if (Object.hasOwn(BOXES, kw)) {
      if (seenBox) return null;
      seenBox = true;
      box = BOXES[kw];
      continue;
    }
    if (shape) return null;
    shape = parseFunction(p);
    if (!shape) return null;
  }
  if (!shape) shape = { kind: 'inset', sides: ['0px', '0px', '0px', '0px'], radii: null }; // a lone <geometry-box>: its edge
  return { box, ...shape };
}

function parseFunction(p) {
  const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(p);
  if (!m) return null;
  const name = m[1].toLowerCase(),
    body = m[2].trim();
  if (name === 'inset') return parseInset(body, 'inset');
  if (name === 'rect') return parseInset(body, 'rect');
  if (name === 'xywh') return parseInset(body, 'xywh');
  if (name === 'circle' || name === 'ellipse') return parseRadial(name, body);
  if (name === 'polygon') return parsePolygon(body);
  if (name === 'path') return parsePath(body);
  return null;
}

function parseRadii(toks) {
  // <length-percentage>{1,4} [ / <length-percentage>{1,4} ]?
  const slash = toks.indexOf('/');
  const hs = slash < 0 ? toks : toks.slice(0, slash),
    vs = slash < 0 ? null : toks.slice(slash + 1);
  if (!hs.length || hs.length > 4 || !hs.every(isLp) || hs.some(isNeg)) return null;
  if (vs && (!vs.length || vs.length > 4 || !vs.every(isLp) || vs.some(isNeg))) return null;
  const expand = (a) => {
    // TL TR BR BL
    if (a.length === 1) return [a[0], a[0], a[0], a[0]];
    if (a.length === 2) return [a[0], a[1], a[0], a[1]];
    if (a.length === 3) return [a[0], a[1], a[2], a[1]];
    return a.slice();
  };
  const h = expand(hs),
    v = vs ? expand(vs) : h;
  return h.map((x, i) => [x, v[i]]);
}

function parseInset(body, kind) {
  const toks = tokens(body, '/');
  if (!toks || !toks.length) return null;
  const ri = toks.findIndex((t) => t.toLowerCase() === 'round');
  const sides = ri < 0 ? toks : toks.slice(0, ri);
  let radii = null;
  if (ri >= 0) {
    radii = parseRadii(toks.slice(ri + 1));
    if (!radii) return null;
  }
  if (kind === 'xywh') {
    if (sides.length !== 4 || !sides.every(isLp) || isNeg(sides[2]) || isNeg(sides[3])) return null;
    return { kind, sides, radii };
  }
  if (kind === 'rect') {
    if (sides.length !== 4 || !sides.every((t) => isLp(t) || t.toLowerCase() === 'auto'))
      return null;
    return { kind, sides, radii };
  }
  if (!sides.length || sides.length > 4 || !sides.every(isLp)) return null;
  const [a, b = a, c = a, d = b] = sides;
  return { kind, sides: [a, b, c, d], radii };
}

function parseRadial(name, body) {
  const toks = tokens(body);
  if (!toks) return null;
  const at = toks.findIndex((t) => t.toLowerCase() === 'at');
  const sizes = at < 0 ? toks : toks.slice(0, at);
  const pos = at < 0 ? ['center'] : toks.slice(at + 1);
  const need = name === 'circle' ? 1 : 2;
  if (sizes.length !== 0 && sizes.length !== need) return null;
  const sz = sizes.map((t) =>
    /^(closest-side|farthest-side)$/i.test(t) ? t.toLowerCase() : isLp(t) && !isNeg(t) ? t : null,
  );
  if (sz.some((x) => x == null)) return null;
  const position = parsePosition(pos);
  if (!position) return null;
  return { kind: name, sizes: sz.length ? sz : Array(need).fill('closest-side'), position };
}

function parseFillRule(first) {
  const k = first.toLowerCase();
  return k === 'nonzero' || k === 'evenodd' ? k : null;
}

function parsePolygon(body) {
  const items = tokens(body, ',');
  if (!items) return null;
  const groups = [[]];
  for (const t of items) {
    if (t === ',') groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  let rule = 'nonzero';
  if (groups[0].length === 1 && parseFillRule(groups[0][0])) {
    rule = parseFillRule(groups[0][0]);
    groups.shift();
  }
  if (!groups.length) return null;
  const points = [];
  for (const g of groups) {
    if (g.length !== 2 || !g.every(isLp)) return null;
    points.push(g);
  }
  return { kind: 'polygon', rule, points };
}

function parsePath(body) {
  const items = tokens(body, ',');
  if (!items) return null;
  let rule = 'nonzero',
    rest = items;
  if (items.length >= 3 && items[1] === ',' && parseFillRule(items[0])) {
    rule = parseFillRule(items[0]);
    rest = items.slice(2);
  }
  if (rest.length !== 1) return null;
  const q = /^(["'])([\s\S]*)\1$/.exec(rest[0]);
  if (!q) return null;
  return { kind: 'path', rule, d: q[2] };
}

/// The reference box kind for a parsed shape: its stated one, else the property's default, border-box = the stroke box.
export function boxKindOf(spec, compat) {
  if (spec.box) return spec.box;
  return compat === 'chrome' ? CHROME_DEFAULT_BOX : 'stroke';
}
const CHROME_DEFAULT_BOX = 'stroke';

const f = (v) => String(+v);
const rectD = (x, y, w, h) => `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;

/// Rounded rectangle path (CSS Backgrounds 3 §5.5 corner overlap: every radius scales by one factor so no two adjacent radii
/// exceed their side). `r` = [[rx, ry] x 4] (TL, TR, BR, BL), already resolved to user units.
function roundRectD(x, y, w, h, r) {
  let k = 1;
  const lim = (sum, side) => {
    if (sum > side && sum > 0) k = Math.min(k, side / sum);
  };
  lim(r[0][0] + r[1][0], w);
  lim(r[3][0] + r[2][0], w);
  lim(r[0][1] + r[3][1], h);
  lim(r[1][1] + r[2][1], h);
  const [tl, tr, br, bl] = r.map(([a, b]) => [a * k, b * k]);
  const arc = (c, ex, ey) =>
    c[0] > 0 && c[1] > 0 ? `A${f(c[0])} ${f(c[1])} 0 0 1 ${f(ex)} ${f(ey)}` : `L${f(ex)} ${f(ey)}`;
  return (
    `M${f(x + tl[0])} ${f(y)}H${f(x + w - tr[0])}${arc(tr, x + w, y + tr[1])}V${f(y + h - br[1])}${arc(br, x + w - br[0], y + h)}` +
    `H${f(x + bl[0])}${arc(bl, x, y + h - bl[1])}V${f(y + tl[1])}${arc(tl, x + tl[0], y)}Z`
  );
}

/// Resolve a parsed shape against `box` ({x, y, w, h}, user units) with the element's font sizes `fc`: { d, rule }, or
/// { d: '', rule } for an empty shape (everything clipped), or null when a number is invalid (a negative radius): the property
/// is then invalid as a whole and the caller treats it as `none`.
export function shapeToPath(spec, box, fc) {
  const { x: bx, y: by, w, h } = box;
  const ctx = (axis) => ({
    parentWidth: w,
    parentHeight: h,
    axis,
    fontSize: fc.fontSize,
    rootFontSize: fc.rootFontSize,
  });
  const X = (t) => parseLengthOr(t, NaN, ctx('x')),
    Y = (t) => parseLengthOr(t, NaN, ctx('y')),
    D = (t) => parseLengthOr(t, NaN, ctx('d'));
  const radiiOf = (rw, rh) => {
    if (!spec.radii) return null;
    const r = spec.radii.map(([a, b]) => [
      parseLengthOr(a, NaN, { ...ctx('x'), parentWidth: rw }),
      parseLengthOr(b, NaN, { ...ctx('y'), parentHeight: rh }),
    ]);
    return r.some(([a, b]) => !(a >= 0) || !(b >= 0)) ? undefined : r;
  };
  let rule = 'nonzero';
  switch (spec.kind) {
    case 'inset':
    case 'rect':
    case 'xywh': {
      let x0, y0, x1, y1;
      if (spec.kind === 'inset') {
        const [t, r, b, l] = [
          Y(spec.sides[0]),
          X(spec.sides[1]),
          Y(spec.sides[2]),
          X(spec.sides[3]),
        ];
        if (![t, r, b, l].every(Number.isFinite)) return null;
        x0 = bx + l;
        y0 = by + t;
        x1 = bx + w - r;
        y1 = by + h - b;
      } else if (spec.kind === 'rect') {
        // rect(top right bottom left): top and bottom are distances from the TOP edge, right and left from the LEFT edge
        const ty = spec.sides[0].toLowerCase() === 'auto' ? 0 : Y(spec.sides[0]);
        const rx = spec.sides[1].toLowerCase() === 'auto' ? w : X(spec.sides[1]);
        const by2 = spec.sides[2].toLowerCase() === 'auto' ? h : Y(spec.sides[2]);
        const lx = spec.sides[3].toLowerCase() === 'auto' ? 0 : X(spec.sides[3]);
        if (![ty, rx, by2, lx].every(Number.isFinite)) return null;
        x0 = bx + lx;
        y0 = by + ty;
        x1 = bx + rx;
        y1 = by + by2;
      } else {
        const [px, py, pw, ph] = [
          X(spec.sides[0]),
          Y(spec.sides[1]),
          X(spec.sides[2]),
          Y(spec.sides[3]),
        ];
        if (![px, py, pw, ph].every(Number.isFinite) || pw < 0 || ph < 0) return null;
        x0 = bx + px;
        y0 = by + py;
        x1 = x0 + pw;
        y1 = y0 + ph;
      }
      if (!(x1 > x0 && y1 > y0)) {
        if (spec.radii && radiiOf(Math.max(0, x1 - x0), Math.max(0, y1 - y0)) === undefined)
          return null;
        return { d: '', rule };
      }
      const r = radiiOf(x1 - x0, y1 - y0);
      if (r === undefined) return null;
      return {
        d:
          r && r.some(([a, b]) => a > 0 && b > 0)
            ? roundRectD(x0, y0, x1 - x0, y1 - y0, r)
            : rectD(x0, y0, x1 - x0, y1 - y0),
        rule,
      };
    }
    case 'circle':
    case 'ellipse': {
      const pos = spec.position;
      const at = (p, size, axis) => {
        const o = parseLengthOr(p.off, NaN, ctx(axis));
        return p.edge ? size - o : o;
      };
      const cx = bx + at(pos.x, w, 'x'),
        cy = by + at(pos.y, h, 'y');
      if (!Number.isFinite(cx + cy)) return null;
      const near = (c, lo, hi) => Math.min(Math.abs(c - lo), Math.abs(c - hi)),
        far = (c, lo, hi) => Math.max(Math.abs(c - lo), Math.abs(c - hi));
      const dx = [near(cx, bx, bx + w), far(cx, bx, bx + w)],
        dy = [near(cy, by, by + h), far(cy, by, by + h)];
      let rx, ry;
      if (spec.kind === 'circle') {
        const t = spec.sizes[0];
        if (t === 'closest-side') rx = ry = Math.min(dx[0], dy[0]);
        else if (t === 'farthest-side') rx = ry = Math.max(dx[1], dy[1]);
        else rx = ry = D(t);
      } else {
        const one = (t, d, axisFn) =>
          t === 'closest-side' ? d[0] : t === 'farthest-side' ? d[1] : axisFn(t);
        rx = one(spec.sizes[0], dx, X);
        ry = one(spec.sizes[1], dy, Y);
      }
      if (!(rx >= 0) || !(ry >= 0)) return null;
      if (rx === 0 || ry === 0) return { d: '', rule };
      return {
        d: `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`,
        rule,
      };
    }
    case 'polygon': {
      const pts = spec.points.map(([a, b]) => [bx + X(a), by + Y(b)]);
      if (pts.some((p) => !Number.isFinite(p[0] + p[1]))) return null;
      rule = spec.rule;
      return { d: 'M' + pts.map((p) => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z', rule };
    }
    case 'path':
      return { d: spec.d, rule: spec.rule, origin: [bx, by] };
    default:
      return null;
  }
}
