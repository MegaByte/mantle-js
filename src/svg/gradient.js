// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/gradient.js — <linearGradient> / <radialGradient> parsing + bundle
// table packing.
//
// Resolves href / xlink:href chains (one gradient inheriting another's
// stops / transform / parameters). `packGradientStops` +
// `buildGradientTables` produce the per-run stops LUT that slug.frag and
// the COLRv1 dispatch both sample — see ../shaders/_gradientHelpers.glsl
// for the shader-side reader.

import { svgElementName, elementChildren, resolveIdRef, isFirstWithId } from './utils.js';
import { parseColor } from './color.js';
import { mantleWarn } from '../core/diagnostics.js';
import {
  getStyleProp,
  getNonInheritedProp,
  parseAlphaOr,
  withCurrentColor,
  domFontSize,
} from './style.js';
import { parseTransform, IDENT } from './transform.js';
import { parseLength, parseLengthOr } from './length.js';
import { packStopList, packStopListAs } from '../core/gradientStops.js';

export const GRAD_LINEAR = 0,
  GRAD_RADIAL = 1;
export const GRAD_PAD = 0,
  GRAD_REFLECT = 1,
  GRAD_REPEAT = 2;
export const GRAD_SPREAD_ENUM = { pad: GRAD_PAD, reflect: GRAD_REFLECT, repeat: GRAD_REPEAT };
export const GRAD_UNITS_USER = 'userSpaceOnUse';
export const GRAD_UNITS_BBOX = 'objectBoundingBox';
export const GRADIENT_FLOATS = 16;
/// The largest q / 2 a record carries in its spread slot (fr / r up to about 2^20); a still larger focal radius clamps to it.
const FR_HALF_MAX = 0.5 - 1 / 2 ** 21;

/** @typedef {[number, number, number, number]} GradientRGBA A straight (non-premultiplied) color, each channel 0..1. */
/** @typedef {{ offset: number, color: GradientRGBA }} GradientStop One <stop>: its offset (0..1, never decreasing along the list) and color. */
/** @typedef {ArrayLike<number>} GradientMatrix6 An affine [a, b, c, d, e, f]. */
/**
 * @typedef {object} Gradient A resolved <linearGradient> or <radialGradient> (parseGradients), with its href chain applied. A linear gradient
 * carries x1..y2, a radial one cx, cy, r, fx, fy, fr.
 * @property {number} gtype GRAD_LINEAR or GRAD_RADIAL
 * @property {number} spread GRAD_PAD, GRAD_REFLECT or GRAD_REPEAT
 * @property {string} units GRAD_UNITS_USER or GRAD_UNITS_BBOX
 * @property {GradientMatrix6} gradient_transform
 * @property {GradientStop[]} stops
 * @property {number} [x1] linear axis start x
 * @property {number} [y1] linear axis start y
 * @property {number} [x2] linear axis end x
 * @property {number} [y2] linear axis end y
 * @property {number} [cx] radial center x
 * @property {number} [cy] radial center y
 * @property {number} [r] radial radius
 * @property {number} [fx] radial focal x
 * @property {number} [fy] radial focal y
 * @property {number} [fr] radial focal radius
 */

/// True when a 2x3 matrix [a, b, c, d, e, f] has no inverse: its determinant is zero, or lost to cancellation. Judged relative to the matrix's
/// own terms, not an absolute 1e-12: an authored gradientTransform="scale(1e-6)" has a determinant of 1e-12 and is a real, invertible
/// transform. NaN is singular.
/** @param {GradientMatrix6} m @returns {boolean} */
export function isSingularMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return !(Math.abs(det) > 1e-12 * (Math.abs(m[0] * m[3]) + Math.abs(m[1] * m[2])));
}

/// Read <stop> children of a gradient element into a sorted
/// [{ offset, color: [r,g,b,a] }] array. stop-color and stop-opacity
/// can appear as attributes OR in the inline style attribute (both
/// per spec).
/** @param {Element} el the gradient element @returns {GradientStop[]} */
export function parseGradientStops(el) {
  const stops = [];
  const kids = elementChildren(el);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (svgElementName(c) !== 'stop') continue;
    const offStr = c.getAttribute('offset') || '0';
    let off;
    if (offStr.endsWith('%')) off = parseFloat(offStr.slice(0, -1)) / 100;
    else off = parseFloat(offStr);
    off = Math.max(0, Math.min(1, off || 0));
    // stop-color and stop-opacity do not inherit: `inherit` takes the gradient's value (getNonInheritedProp).
    const paint = getNonInheritedProp(c, 'stop-color', 'black');
    const color = withCurrentColor(c, paint);
    const opac = Math.max(
      0,
      Math.min(1, parseAlphaOr(getNonInheritedProp(c, 'stop-opacity', '1'), 1)),
    );
    const rgba = parseColor(color);
    stops.push({ offset: off, color: [rgba[0], rgba[1], rgba[2], rgba[3] * opac] });
  }
  // SVG 1.1 §13.2.4: an offset smaller than any preceding one is rounded
  // up to the largest so far — document order is preserved, never sorted
  // (sorting would reorder the color sequence of hard-stop gradients).
  let prev = 0;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].offset < prev) stops[i].offset = prev;
    else prev = stops[i].offset;
  }
  return stops;
}

/// Walk <defs> / inline <linearGradient> + <radialGradient> children
/// of `root`, resolving href / xlink:href chains so each entry has
/// its full inherited shape (transform, spreadMethod, stops, etc.).
/// Returns { [id]: { gtype, spread, units, gradient_transform,
///                   x1/y1/x2/y2 | cx/cy/r/fx/fy, stops } }.
/** @param {Element} root the document root @returns {Record<string, Gradient>} the resolved gradients by id */
export function parseGradients(root) {
  const raw = Object.create(null); // keyed by authored ids
  const visit = (el) => {
    const tag = svgElementName(el);
    if (tag === 'lineargradient' || tag === 'radialgradient') {
      const id = el.getAttribute('id');
      if (id && isFirstWithId(root, el, id)) raw[id] = el;
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);

  // Viewport dims for percentage coordinates under
  // gradientUnits="userSpaceOnUse" (SVG 1.1 §13.2.2: resolve against the
  // viewport per §7.10; under objectBoundingBox a percentage is just the
  // 0..1 fraction).
  let vpW = NaN,
    vpH = NaN;
  {
    const vbStr = (root.getAttribute && (root.getAttribute('viewBox') || '').trim()) || '';
    const p = vbStr ? vbStr.split(/[\s,]+/).map(parseFloat) : [];
    if (p.length === 4 && Number.isFinite(p[2]) && p[2] > 0) {
      vpW = p[2];
      vpH = p[3];
    } else if (root.getAttribute) {
      vpW = parseLengthOr(root.getAttribute('width'), NaN);
      vpH = parseLengthOr(root.getAttribute('height'), NaN);
    }
    if (!(vpH > 0)) vpH = vpW;
  }
  const vpDiag = vpW > 0 ? Math.sqrt((vpW * vpW + vpH * vpH) / 2) : NaN;

  const resolved = Object.create(null);
  // A gradient is its href chain: the element itself, then each gradient it names, up to a cycle. Every attribute comes
  // from the first link that states it (SVG 1.1 §13.2.2), as the RAW string, and is read last, in the units of the
  // gradient that is being resolved: a parent's x2="50%" is half the viewport when the child is userSpaceOnUse and 0.5
  // when it is objectBoundingBox, and a parent that states nothing leaves the child its own defaults. Geometry comes only
  // from links of the same kind (a linear gradient has no cx); stops, units, transform and spread from any.
  const chainOf = (id) => {
    const chain = [];
    const seen = new Set();
    for (let cur = id; cur && raw[cur] && !seen.has(cur);) {
      seen.add(cur);
      chain.push(raw[cur]);
      cur = resolveIdRef(
        raw[cur].getAttribute('href') || raw[cur].getAttribute('xlink:href') || '',
      );
    }
    return chain;
  };
  const resolve = (id) => {
    if (resolved[id]) return resolved[id];
    const el = raw[id];
    if (!el) return null;
    const tag = svgElementName(el);
    const chain = chainOf(id);
    const sameKind = chain.filter((c) => svgElementName(c) === tag);

    const gtype = tag === 'lineargradient' ? GRAD_LINEAR : GRAD_RADIAL;
    const smEl = chain.find((c) => c.getAttribute('spreadMethod')); // (xmldom answers '' for an absent attribute)
    const sm = smEl ? smEl.getAttribute('spreadMethod') : null;
    const spread =
      sm != null && Object.hasOwn(GRAD_SPREAD_ENUM, sm) ? GRAD_SPREAD_ENUM[sm] : GRAD_PAD;
    const units =
      chain.map((c) => c.getAttribute('gradientUnits')).find((v) => v) || GRAD_UNITS_BBOX;
    const xf = chain.map((c) => c.getAttribute('gradientTransform')).find((v) => v);
    const gtransform = xf ? parseTransform(xf) : IDENT;

    const isUser = units === GRAD_UNITS_USER;
    const fontOf = new Map();
    const lengthCtx = (c, axis) => {
      let fi = fontOf.get(c);
      if (!fi) fontOf.set(c, (fi = domFontSize(c)));
      return {
        parentWidth: vpW,
        parentHeight: vpH,
        axis,
        fontSize: fi.fontSize,
        rootFontSize: fi.rootFontSize,
      };
    };
    // One link's value in the final units, or undefined when it is absent or not a finite length.
    const read = (c, attr, axis) => {
      const v = c.getAttribute(attr);
      if (v == null) return undefined;
      let n;
      if (v.endsWith('%')) {
        const frac = parseFloat(v.slice(0, -1)) / 100;
        n =
          !isUser || !(vpW > 0) ? frac : frac * (axis === 'y' ? vpH : axis === 'd' ? vpDiag : vpW);
      } else {
        n = isUser ? parseLengthOr(v, NaN, lengthCtx(c, axis)) : parseFloat(v);
      }
      return Number.isFinite(n) ? n : undefined;
    };
    const ownAttr = (attr, axis) => {
      for (const c of sameKind) {
        const n = read(c, attr, axis);
        if (n !== undefined) return n;
      }
      return undefined;
    };
    const f = (attr, defaultVal, axis) => {
      const o = ownAttr(attr, axis);
      return o !== undefined ? o : defaultVal;
    };
    // Attribute defaults are percentages per spec (x2=100%, cx/cy/r=50%),
    // so under userSpaceOnUse the numeric fallbacks scale by the viewport.
    const dx = (frac, axis) =>
      isUser && vpW > 0 ? frac * (axis === 'y' ? vpH : axis === 'd' ? vpDiag : vpW) : frac;

    let g;
    if (gtype === GRAD_LINEAR) {
      g = {
        gtype,
        spread,
        units,
        gradient_transform: gtransform,
        x1: f('x1', 0, 'x'),
        y1: f('y1', 0, 'y'),
        x2: f('x2', dx(1, 'x'), 'x'),
        y2: f('y2', 0, 'y'),
        stops: /** @type {object[]} */ ([]),
      };
    } else {
      const cx = f('cx', dx(0.5, 'x'), 'x');
      const cy = f('cy', dx(0.5, 'y'), 'y');
      const r = f('r', dx(0.5, 'd'), 'd');
      // A gradient that states neither fx nor fy anywhere on its chain puts the focal point at ITS own center
      // (SVG 1.1 §13.2.3), not at a parent's.
      const fx = ownAttr('fx', 'x'),
        fy = ownAttr('fy', 'y');
      // SVG 2 `fr`, the radius of the focal circle (default 0). A negative value is an error and reads as 0, as in Chrome. It is NOT clamped
      // to r: Chrome and the canvas two-circle gradient it matches let fr exceed r (the circles then shrink toward the end circle).
      let fr = ownAttr('fr', 'd');
      if (!(fr > 0)) fr = 0;
      if (fr > 0 && !(r > 0)) {
        // r = 0 paints the last stop alone for an fr of 0; with an fr the circles would shrink to a point, which the record cannot
        // carry (fr rides as a fraction of r). Said once, never silently dropped.
        mantleWarn(
          'gradient: a radialGradient with r="0" and fr > 0 is not supported; fr is ignored (it paints the last stop color).',
        );
        fr = 0;
      }
      g = {
        gtype,
        spread,
        units,
        gradient_transform: gtransform,
        cx,
        cy,
        r,
        fx: fx !== undefined ? fx : cx,
        fy: fy !== undefined ? fy : cy,
        fr,
        stops: /** @type {object[]} */ ([]),
      };
    }
    // `stops` belongs to the gradient shape, not bolted on afterwards: the two
    // branches above build different geometry fields, so assigning it later
    // left neither shape declaring it.
    let stops = [];
    for (const c of chain) {
      stops = parseGradientStops(c);
      if (stops.length) break;
    }
    g.stops = stops;
    resolved[id] = g;
    return g;
  };
  for (const id of Object.keys(raw)) resolve(id);
  return resolved;
}

/// Pack a gradient's stops into a flat RGBA8 array, in the layout `oneTexel`
/// names (core/gradientStops.js). The shader picks the layout by the sign of the
/// gradient's stopsCount; buildGradientTables decides it with packStopList. The
/// shader lerps adjacent stops on-the-fly — sharing `_gradientHelpers.glsl` with
/// the COLRv1 dispatch — which avoids the offset quantization of a fixed-bin ramp
/// atlas (visible banding at high resolutions).
/** @param {{ stops?: GradientStop[] } | null | undefined} g @param {boolean} [oneTexel] 4 bytes per stop (equal-spaced) instead of 8 @returns {Uint8Array} */
export function packGradientStops(g, oneTexel = false) {
  return packStopListAs(g && g.stops, oneTexel);
}

// The record stores the endpoints as float32, so two endpoints that differ by less than the float32 resolution of their
// magnitude (x1 = 64, x2 = 64 + 1e-6) collapse to the same value, and the shader reads "x1 == x2" as the zero-length vector
// that paints the last stop. A vector that differs by any nonzero amount is a valid one (a hard step at the endpoint), so the
// stored x2/y2 moves to the adjacent float32 on the authored side of p1 along the longer axis. A truly zero vector stays equal.
const _nudgeF = new Float32Array(1),
  _nudgeU = new Uint32Array(_nudgeF.buffer);
function nextFloat32(v, dir) {
  _nudgeF[0] = v;
  if (v === 0) {
    _nudgeU[0] = 1;
    return dir > 0 ? _nudgeF[0] : -_nudgeF[0];
  } // the smallest denormal, signed
  if (v > 0 === dir > 0) _nudgeU[0]++;
  else _nudgeU[0]--;
  return _nudgeF[0];
}
function keepShortVector(records, at, x1, y1, x2, y2) {
  if (!(Math.fround(x1) === Math.fround(x2) && Math.fround(y1) === Math.fround(y2))) return;
  const dx = x2 - x1,
    dy = y2 - y1;
  if (!(dx !== 0 || dy !== 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (Math.abs(dx) >= Math.abs(dy)) records[at + 2] = nextFloat32(records[at], dx);
  else records[at + 3] = nextFloat32(records[at + 1], dy);
}

/// Build the runtime gradient table: per-gradient float record (16
/// floats — type/spread/units, inverse transform, stops slice, axis
/// params) + the concatenated stops blob. Renderer uploads as two GL
/// textures (RGBA32F records + RGBA8 stops LUT) consumed by
/// slug.frag::sampleGradient.
///
/// `rebase` (a bundle stored relative to an ORIGIN, bundle/layout.js): a userSpaceOnUse gradient's own numbers (x1, cx ...) are document
/// coordinates, and the placement matrix that takes the bundle's frame to them carries the origin as its translation. Both would be float32
/// numbers 1e7 out, and a gradient across 1e-3 units of art would be a step. The gradient space is moved to where the bundle's (0, 0) is: the
/// matrix loses its translation c (the image of (0, 0)) and the geometry loses c, which is the same picture to the last float64 bit.
/**
 * @param {Gradient[]} gradientsUsed
 * @param {boolean} [rebase] move a userSpaceOnUse gradient to the bundle's origin frame
 * @returns {{ records: Uint8Array, stops: Uint8Array, stopsCount: number }} the per-gradient float records (as bytes), the stops blob and its texel count
 */
export function buildGradientTables(gradientsUsed, rebase = false) {
  const records = new Float32Array(gradientsUsed.length * GRADIENT_FLOATS);

  const packs = gradientsUsed.map((g) => packStopList(g.stops));
  const oneTexelOf = packs.map((p) => p.count < 0);
  const packedPerGradient = packs.map((p) => p.bytes);
  // One slice per distinct stop list. Records that carry the same `stops` array -- by reference, which is only
  // ever a record cloned from another (bundleFinalize mints one per objectBoundingBox gradient placement whose
  // carrier turns or skews) -- differ solely in their matrix, so they read the same slice instead of packing a
  // byte-identical copy each. Identity, not value: an href-inherited gradient copies its parent's stops with
  // slice(), so two distinct stop arrays always stay two slices.
  const sliceOfStops = new Map();
  let totalTexels = 0;
  for (let i = 0; i < gradientsUsed.length; i++) {
    const own = gradientsUsed[i].stops;
    if (own && sliceOfStops.has(own)) {
      // The layout is a function of the stops alone, so a shared list always packs the same way; the guard is here
      // because the two are separate arrays and a future caller could break the tie.
      if (oneTexelOf[sliceOfStops.get(own)] === oneTexelOf[i]) continue;
    } else if (own) sliceOfStops.set(own, i);
    totalTexels += packedPerGradient[i].length >>> 2; // 4 bytes / texel
  }
  const stops = new Uint8Array(Math.max(4, totalTexels * 4));
  const sliceAt = new Map(); // packing index -> TEXEL offset already written
  let texelCursor = 0;
  for (let idx = 0; idx < gradientsUsed.length; idx++) {
    const g = gradientsUsed[idx];
    const [a, b, c, d, e, f] = g.gradient_transform;
    const det = a * d - b * c;
    let ia, ib, ic, id_, ie, if_;
    // (A singular gradientTransform never reaches here: the importer treats the gradient as no paint server, claimGradient.)
    if (isSingularMatrix(g.gradient_transform)) {
      ia = 1;
      ib = 0;
      ic = 0;
      id_ = 1;
      ie = 0;
      if_ = 0;
    } else {
      ia = d / det;
      ib = -b / det;
      ic = -c / det;
      id_ = a / det;
      ie = -(ia * e + ic * f);
      if_ = -(ib * e + id_ * f);
    }
    const packed = packedPerGradient[idx];
    const oneTexel = oneTexelOf[idx];
    const stopCount = packed.length >>> (oneTexel ? 2 : 3); // stops (4 or 8 bytes/stop)
    const owner = g.stops ? sliceOfStops.get(g.stops) : undefined;
    const shared =
      owner !== undefined && owner !== idx && oneTexelOf[owner] === oneTexel
        ? sliceAt.get(owner)
        : undefined;
    let stopsOffset; // TEXEL offset
    if (shared !== undefined) {
      stopsOffset = shared;
    } else {
      stopsOffset = texelCursor;
      stops.set(packed, texelCursor * 4);
      texelCursor += packed.length >>> 2; // advance by texels
      sliceAt.set(idx, stopsOffset);
    }
    let gx1 = g.x1,
      gy1 = g.y1,
      gx2 = g.x2,
      gy2 = g.y2,
      gcx = g.cx,
      gcy = g.cy;
    if (rebase && g.units === GRAD_UNITS_USER) {
      gx1 -= ie;
      gy1 -= if_;
      gx2 -= ie;
      gy2 -= if_;
      gcx -= ie;
      gcy -= if_;
      ie = 0;
      if_ = 0;
    }
    const base = idx * GRADIENT_FLOATS;
    let fyFrac = 0;
    if (g.gtype === GRAD_RADIAL && g.r > 0) fyFrac = (g.fy - g.cy) / g.r;
    records[base + 0] = g.gtype;
    // Slot 1 is the spread, a whole number 0..2. A radial gradient with a focal radius adds q / 2 to it, q = fr / (fr + r) in (0, 1): the
    // reader takes the spread as round(slot) (q / 2 stays under 1/2) and q as the remainder. An fr of 0 writes the bare spread, byte for byte.
    records[base + 1] =
      g.spread +
      (g.gtype === GRAD_RADIAL && g.fr > 0 && g.r > 0
        ? Math.min((0.5 * g.fr) / (g.fr + g.r), FR_HALF_MAX)
        : 0);
    records[base + 2] = g.units === GRAD_UNITS_USER ? 0 : 1;
    records[base + 3] = fyFrac;
    records[base + 4] = ia;
    records[base + 5] = ib;
    records[base + 6] = ic;
    records[base + 7] = id_;
    records[base + 8] = ie;
    records[base + 9] = if_;
    // Slots 10/11 carry (stopsOffset, stopsCount) into the exact-stop
    // LUT shared with COLRv1.
    records[base + 10] = stopsOffset; // TEXEL offset
    records[base + 11] = oneTexel ? -stopCount : stopCount; // signed: < 0 = 1-texel
    if (g.gtype === GRAD_LINEAR) {
      records[base + 12] = gx1;
      records[base + 13] = gy1;
      records[base + 14] = gx2;
      records[base + 15] = gy2;
      keepShortVector(records, base + 12, gx1, gy1, gx2, gy2);
    } else {
      const fxFrac = g.r > 0 ? (g.fx - g.cx) / g.r : 0;
      records[base + 12] = gcx;
      records[base + 13] = gcy;
      records[base + 14] = g.r;
      records[base + 15] = fxFrac;
    }
  }
  return { records: new Uint8Array(records.buffer), stops, stopsCount: texelCursor };
}
