// svg/gradient.js — <linearGradient> / <radialGradient> parsing + bundle
// table packing.
//
// Resolves href / xlink:href chains (one gradient inheriting another's
// stops / transform / parameters). `packGradientStops` +
// `buildGradientTables` produce the per-run stops LUT that slug.frag and
// the COLRv1 dispatch both sample — see ../shaders/_gradientHelpers.glsl
// for the shader-side reader.

import { elementChildren, resolveIdRef } from './utils.js';
import { parseColor } from './color.js';
import { parseStyleString } from './style.js';
import { parseTransform, IDENT } from './transform.js';
import { parseLength, parseLengthOr } from './length.js';

export const GRAD_LINEAR = 0, GRAD_RADIAL = 1;
export const GRAD_PAD = 0, GRAD_REFLECT = 1, GRAD_REPEAT = 2;
export const GRAD_SPREAD_ENUM = { pad: GRAD_PAD, reflect: GRAD_REFLECT, repeat: GRAD_REPEAT };
export const GRAD_UNITS_USER = 'userSpaceOnUse';
export const GRAD_UNITS_BBOX = 'objectBoundingBox';
export const GRADIENT_FLOATS = 16;

/// Read <stop> children of a gradient element into a sorted
/// [{ offset, color: [r,g,b,a] }] array. stop-color and stop-opacity
/// can appear as attributes OR in the inline style attribute (both
/// per spec).
export function parseGradientStops(el) {
  const stops = [];
  const kids = elementChildren(el);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.tagName.toLowerCase() !== 'stop') continue;
    const offStr = c.getAttribute('offset') || '0';
    let off;
    if (offStr.endsWith('%')) off = parseFloat(offStr.slice(0, -1)) / 100;
    else off = parseFloat(offStr);
    off = Math.max(0, Math.min(1, off || 0));
    const style = parseStyleString(c.getAttribute('style') || '');
    const color = style['stop-color'] || c.getAttribute('stop-color') || 'black';
    const opacStr = style['stop-opacity'] || c.getAttribute('stop-opacity') || '1';
    const opac = parseLengthOr(opacStr, 1);
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
export function parseGradients(root) {
  const raw = {};
  const visit = el => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'lineargradient' || tag === 'radialgradient') {
      const id = el.getAttribute('id');
      if (id) raw[id] = el;
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);

  // Viewport dims for percentage coordinates under
  // gradientUnits="userSpaceOnUse" (SVG 1.1 §13.2.2: resolve against the
  // viewport per §7.10; under objectBoundingBox a percentage is just the
  // 0..1 fraction).
  let vpW = NaN, vpH = NaN;
  {
    const vbStr = (root.getAttribute && (root.getAttribute('viewBox') || '').trim()) || '';
    const p = vbStr ? vbStr.split(/[\s,]+/).map(parseFloat) : [];
    if (p.length === 4 && Number.isFinite(p[2]) && p[2] > 0) { vpW = p[2]; vpH = p[3]; }
    else if (root.getAttribute) {
      vpW = parseFloat(root.getAttribute('width'));
      vpH = parseFloat(root.getAttribute('height'));
    }
    if (!(vpH > 0)) vpH = vpW;
  }
  const vpDiag = (vpW > 0) ? Math.sqrt((vpW * vpW + vpH * vpH) / 2) : NaN;

  const resolved = {};
  const resolve = (id, seen) => {
    if (!seen) seen = new Set();
    if (seen.has(id)) return null;
    seen.add(id);
    if (resolved[id]) return resolved[id];
    const el = raw[id];
    if (!el) return null;
    const tag = el.tagName.toLowerCase();
    const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
    const hrefId = resolveIdRef(href);
    const parent = hrefId ? resolve(hrefId, seen) : null;

    const gtype = tag === 'lineargradient' ? GRAD_LINEAR : GRAD_RADIAL;
    const sm = el.getAttribute('spreadMethod');
    const spread = sm != null
      ? (GRAD_SPREAD_ENUM[sm] ?? GRAD_PAD)
      : (parent ? parent.spread : GRAD_PAD);
    const units = el.getAttribute('gradientUnits')
      || (parent ? parent.units : GRAD_UNITS_BBOX);
    const xf = el.getAttribute('gradientTransform');
    const gtransform = xf ? parseTransform(xf) : (parent ? parent.gradient_transform : IDENT);

    const isUser = units === GRAD_UNITS_USER;
    const f = (attr, defaultProp, defaultVal, axis) => {
      const v = el.getAttribute(attr);
      if (v != null) {
        if (v.endsWith('%')) {
          const frac = parseFloat(v.slice(0, -1)) / 100;
          if (!isUser || !(vpW > 0)) return frac;
          return frac * (axis === 'y' ? vpH : axis === 'd' ? vpDiag : vpW);
        }
        const n = parseFloat(v);
        if (!isNaN(n)) return n;
      }
      if (parent) return parent[defaultProp] ?? defaultVal;
      return defaultVal;
    };
    // Attribute defaults are percentages per spec (x2=100%, cx/cy/r=50%),
    // so under userSpaceOnUse the numeric fallbacks scale by the viewport.
    const dx = (frac, axis) => (isUser && vpW > 0)
      ? frac * (axis === 'y' ? vpH : axis === 'd' ? vpDiag : vpW) : frac;

    let g;
    if (gtype === GRAD_LINEAR) {
      g = {
        gtype, spread, units, gradient_transform: gtransform,
        x1: f('x1', 'x1', 0, 'x'),
        y1: f('y1', 'y1', 0, 'y'),
        x2: f('x2', 'x2', dx(1, 'x'), 'x'),
        y2: f('y2', 'y2', 0, 'y'),
      };
    } else {
      const cx = f('cx', 'cx', dx(0.5, 'x'), 'x');
      const cy = f('cy', 'cy', dx(0.5, 'y'), 'y');
      const r  = f('r',  'r',  dx(0.5, 'd'), 'd');
      g = {
        gtype, spread, units, gradient_transform: gtransform,
        cx, cy, r,
        fx: f('fx', 'fx', cx, 'x'),
        fy: f('fy', 'fy', cy, 'y'),
      };
    }
    let stops = parseGradientStops(el);
    if (!stops.length && parent) stops = parent.stops.slice();
    g.stops = stops;
    resolved[id] = g;
    return g;
  };
  for (const id of Object.keys(raw)) resolve(id);
  return resolved;
}

/// Pack a gradient's stops into a flat RGBA8 array. Two layouts (the
/// shader picks via the signed stopsCount): `oneTexel` = the all-opaque
/// fast path (1 texel/stop: rgb + offset-in-alpha, implicit alpha 1);
/// otherwise 2 texels/stop (straight RGBA + a separate offset texel, so
/// per-stop alpha survives). The shader lerps adjacent stops on-the-fly —
/// sharing `_gradientHelpers.glsl` with the COLRv1 dispatch — which avoids
/// the offset quantization of a fixed-bin ramp atlas (visible banding at
/// high resolutions).
export function packGradientStops(g, oneTexel = false) {
  let stops = g.stops && g.stops.length
    ? g.stops.slice().sort((a, b) => a.offset - b.offset)
    : [{ offset: 0, color: [0, 0, 0, 0] }, { offset: 1, color: [0, 0, 0, 0] }];
  // Insert sentinel endpoints so PAD mode (the most common) wraps
  // cleanly without the shader having to special-case t < first.offset.
  if (stops[0].offset > 0) stops = [{ offset: 0, color: stops[0].color }].concat(stops);
  if (stops[stops.length - 1].offset < 1) stops.push({ offset: 1, color: stops[stops.length - 1].color });
  // Cap at 256 stops (binary-search sampler upper-bounds at 9 iters).
  if (stops.length > 256) stops = stops.slice(0, 256);
  const q = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  if (oneTexel) {
    // Opaque fast path — ONE RGBA8 texel per stop: (R, G, B, offset). Alpha is
    // implicitly 1, so premult == straight; the sampler reads .a as the offset
    // and substitutes alpha 1. Half the bytes + no separate offset texel.
    const out = new Uint8Array(stops.length * 4);
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const c = i * 4;
      out[c + 0] = q(s.color[0]); out[c + 1] = q(s.color[1]);
      out[c + 2] = q(s.color[2]); out[c + 3] = q(s.offset);
    }
    return out;
  }
  // TWO RGBA8 texels per stop (gradients with a transparent stop):
  //   texel A = (R, G, B, alpha)  — STRAIGHT (non-premultiplied) color.
  //   texel B = (offset, 0, 0, 0) — stop position in [0,1], 8-bit.
  // The shader premultiplies AFTER sampling, preserving per-stop alpha;
  // straight-space interpolation matches the SVG color-interpolation default.
  const out = new Uint8Array(stops.length * 8);
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const c = i * 8;
    out[c + 0] = q(s.color[0]);
    out[c + 1] = q(s.color[1]);
    out[c + 2] = q(s.color[2]);
    out[c + 3] = q(s.color[3]);
    out[c + 4] = q(s.offset);
  }
  return out;
}

/// Build the runtime gradient table: per-gradient float record (16
/// floats — type/spread/units, inverse transform, stops slice, axis
/// params) + the concatenated stops blob. Renderer uploads as two GL
/// textures (RGBA32F records + RGBA8 stops LUT) consumed by
/// slug.frag::sampleGradient.
export function buildGradientTables(gradientsUsed) {
  const records = new Float32Array(gradientsUsed.length * GRADIENT_FLOATS);
  // Pack stops first so we can record (stopsOffset, stopsCount) per
  // gradient. Each stop is one RGBA8 texel; all gradients share a
  // single Nx1 texture.
  // Per-gradient layout: all-opaque gradients take the 1-texel/stop fast path
  // (signalled by a NEGATIVE stopsCount); gradients with any transparent stop
  // use 2 texels/stop. stopsOffset is the TEXEL offset into the shared LUT (so
  // mixed strides compose); stopsCount is signed.
  const isOpaque = (g) => !!(g.stops && g.stops.length
    && g.stops.every((s) => Math.round((s.color[3] ?? 1) * 255) === 255));
  const oneTexelOf = gradientsUsed.map(isOpaque);
  const packedPerGradient = gradientsUsed.map((g, i) => packGradientStops(g, oneTexelOf[i]));
  let totalTexels = 0;
  for (const p of packedPerGradient) totalTexels += p.length >>> 2;   // 4 bytes / texel
  const stops = new Uint8Array(Math.max(4, totalTexels * 4));
  let texelCursor = 0;
  for (let idx = 0; idx < gradientsUsed.length; idx++) {
    const g = gradientsUsed[idx];
    const [a, b, c, d, e, f] = g.gradient_transform;
    const det = a * d - b * c;
    let ia, ib, ic, id_, ie, if_;
    if (Math.abs(det) < 1e-12) {
      ia = 1; ib = 0; ic = 0; id_ = 1; ie = 0; if_ = 0;
    } else {
      ia = d / det; ib = -b / det; ic = -c / det; id_ = a / det;
      ie = -(ia * e + ic * f); if_ = -(ib * e + id_ * f);
    }
    const packed = packedPerGradient[idx];
    const oneTexel = oneTexelOf[idx];
    const stopCount = packed.length >>> (oneTexel ? 2 : 3);   // stops (4 or 8 bytes/stop)
    const stopsOffset = texelCursor;                          // TEXEL offset
    stops.set(packed, texelCursor * 4);
    texelCursor += packed.length >>> 2;                       // advance by texels
    const base = idx * GRADIENT_FLOATS;
    let fyFrac = 0;
    if (g.gtype === GRAD_RADIAL && g.r > 0) fyFrac = (g.fy - g.cy) / g.r;
    records[base + 0] = g.gtype;
    records[base + 1] = g.spread;
    records[base + 2] = g.units === GRAD_UNITS_USER ? 0 : 1;
    records[base + 3] = fyFrac;
    records[base + 4] = ia; records[base + 5] = ib;
    records[base + 6] = ic; records[base + 7] = id_;
    records[base + 8] = ie; records[base + 9] = if_;
    // Slots 10/11 carry (stopsOffset, stopsCount) into the exact-stop
    // LUT shared with COLRv1.
    records[base + 10] = stopsOffset;                        // TEXEL offset
    records[base + 11] = oneTexel ? -stopCount : stopCount;  // signed: < 0 = 1-texel
    if (g.gtype === GRAD_LINEAR) {
      records[base + 12] = g.x1; records[base + 13] = g.y1;
      records[base + 14] = g.x2; records[base + 15] = g.y2;
    } else {
      const fxFrac = g.r > 0 ? (g.fx - g.cx) / g.r : 0;
      records[base + 12] = g.cx; records[base + 13] = g.cy;
      records[base + 14] = g.r;  records[base + 15] = fxFrac;
    }
  }
  return { records: new Uint8Array(records.buffer), stops, stopsCount: texelCursor };
}
