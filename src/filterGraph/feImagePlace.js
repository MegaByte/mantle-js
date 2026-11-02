// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImagePlace.js — where an EXTERNAL feImage draws (Filter Effects 1 §15.14): its image fitted by
// preserveAspectRatio into the primitive SUBREGION, and nothing outside that subregion.
//
// The subregion is the feImage's x / y / width / height in the filter's primitiveUnits, each one
// the FILTER REGION's own when unstated (§8.1: for a primitive with no inputs the default subregion is
// 0%, 0%, 100%, 100% of the filter region). userSpaceOnUse values are in the user space of the element
// that references the filter; objectBoundingBox values are fractions of that element's bounding box.
//
// Pure: em rects in, em rects out. The renderer (filterDraw.js) supplies the region and the box in em
// (root user space, where the meta rows live) and the referencing element's CTM, and maps the answer
// to canvas pixels the way it maps the region itself.
//
// Rects are [x0, y0, x1, y1]. A CTM is [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f).
// A turned or skewed CTM maps a user-space rect to its axis-aligned bound, as the filter region does.

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function mapRect(m, r) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [px, py] of [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]],
  ]) {
    const [qx, qy] = apply(m, px, py);
    if (qx < x0) x0 = qx;
    if (qx > x1) x1 = qx;
    if (qy < y0) y0 = qy;
    if (qy > y1) y1 = qy;
  }
  return [x0, y0, x1, y1];
}
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 1e-12 * (Math.abs(m[0] * m[3]) + Math.abs(m[1] * m[2])))) return null;
  const ia = m[3] / det,
    ib = -m[1] / det,
    ic = -m[2] / det,
    id = m[0] / det;
  return [ia, ib, ic, id, -(ia * m[4] + ic * m[5]), -(ib * m[4] + id * m[5])];
}

/// The image rect preserveAspectRatio puts an iw x ih image at inside `vp` ([x0, y0, x1, y1]).
/// align: [ax, ay], each 0 (min) / 1 (mid) / 2 (max); fit: 0 meet, 1 slice, 2 none.
export function fitImageRect(vp, iw, ih, align, fit) {
  const w = vp[2] - vp[0],
    h = vp[3] - vp[1];
  if (!(w > 0 && h > 0 && iw > 0 && ih > 0)) return null;
  if (fit === 2) return vp.slice();
  const s = fit === 1 ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const fw = iw * s,
    fh = ih * s;
  const ox = vp[0] + (w - fw) * (align[0] / 2),
    oy = vp[1] + (h - fh) * (align[1] / 2);
  return [ox, oy, ox + fw, oy + fh];
}

/// Where one external feImage draws, in em: { sub, img } ([x0, y0, x1, y1] each) — the subregion it
/// is clipped to and the fitted image — or null when either is empty (the primitive is then
/// transparent black).
///   p:   the node's params: imgW, imgH (the image's natural size), sub ([x, y, w, h], null where
///        unstated), subUnits (0 userSpaceOnUse, 1 objectBoundingBox), align, fit.
///   env: regionEm (the filter region), boxEm (the referencing element's bounding box), ctm (its
///        user space -> em, null = identity).
export function feImagePlacement(p, env) {
  const region = env && env.regionEm;
  if (!p || !region || !(region[2] > region[0] && region[3] > region[1])) return null;
  const sub = p.sub || [null, null, null, null];
  const align = p.align || [1, 1],
    fit = p.fit | 0;
  const has = (v) => typeof v === 'number' && Number.isFinite(v);
  let subEm, imgEm;
  if ((p.subUnits | 0) === 1) {
    // Fractions of the bounding box, in em (the box is), unstated components from the region.
    const b = env.boxEm;
    if (!b || !(b[2] > b[0] && b[3] > b[1])) return null;
    const bw = b[2] - b[0],
      bh = b[3] - b[1];
    const x = has(sub[0]) ? b[0] + sub[0] * bw : region[0];
    const y = has(sub[1]) ? b[1] + sub[1] * bh : region[1];
    const w = has(sub[2]) ? sub[2] * bw : region[2] - region[0];
    const h = has(sub[3]) ? sub[3] * bh : region[3] - region[1];
    subEm = [x, y, x + w, y + h];
    imgEm = fitImageRect(subEm, p.imgW, p.imgH, align, fit);
  } else {
    // User units: fill the unstated components from the region taken back into that user space,
    // fit the image there, then carry both rects to em.
    const m = env.ctm || null;
    const inv = m ? invert(m) : null;
    if (m && !inv) return null;
    const ru = inv ? mapRect(inv, region) : region;
    const x = has(sub[0]) ? sub[0] : ru[0];
    const y = has(sub[1]) ? sub[1] : ru[1];
    const w = has(sub[2]) ? sub[2] : ru[2] - ru[0];
    const h = has(sub[3]) ? sub[3] : ru[3] - ru[1];
    const subU = [x, y, x + w, y + h];
    const imgU = fitImageRect(subU, p.imgW, p.imgH, align, fit);
    subEm = m ? mapRect(m, subU) : subU;
    imgEm = imgU && (m ? mapRect(m, imgU) : imgU);
  }
  if (!imgEm || !(subEm[2] > subEm[0] && subEm[3] > subEm[1])) return null;
  return { sub: subEm, img: imgEm };
}

/// The PRIMITIVE SUBREGION of every node of a filter graph, in em (Filter Effects 1 §15.3): [x0, y0, x1, y1], null for the filter region
/// itself, or 'empty' for a subregion with no area (the primitive is then transparent black).
///
///   A primitive that states x / y / width / height (node.params.sub, in user units: an objectBoundingBox one was turned into user units
///   at import) takes those; every component it leaves out comes from its DEFAULT subregion, which is the union of the subregions of the
///   nodes it reads -- the filter region when any of them is a standard input (SourceGraphic, ...) or it reads none (feFlood,
///   feTurbulence, feImage) -- and feTile's is always the filter region (its job is to fill past its input).
///   An external feImage's is the one its placement gives.
///   A stated width or height of zero or less disables the primitive: transparent black (Chrome leaves it unclipped: params.chromeZeroSub).
///
/// Pure. `env`: { regionEm, boxEm, ctm } exactly as feImagePlacement takes them. Only meaningful when some node states a subregion: for
/// a graph that states none every entry is null (and the renderer does not call this).
export function primitiveSubregions(graph, env) {
  const nodes = graph.nodes,
    n = nodes.length,
    out = new Array(n).fill(undefined);
  const region = env && env.regionEm;
  const m = (env && env.ctm) || null,
    inv = m ? invert(m) : null;
  const has = (v) => typeof v === 'number' && Number.isFinite(v);
  const union = (a, b) => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
  const at = (i) => {
    if (i < 0 || i >= n) return null;
    if (out[i] !== undefined) return out[i];
    out[i] = null; // (a graph is acyclic; this only guards a malformed one)
    const node = nodes[i],
      p = node.params || {};
    let def = null;
    if (node.type === 'feImage' && p.external) {
      const pl = feImagePlacement(p, env);
      // Only a subregion the feImage states is its subregion for what reads it; unstated, it is the filter region (null).
      return (out[i] = !pl ? 'empty' : p.subStated ? pl.sub : null);
    }
    if (node.type !== 'feTile' && node.inputs.length) {
      let u,
        anyRegion = false,
        anyEmpty = false;
      for (const k of node.inputs) {
        const s = k >= 0 ? at(k) : null;
        if (s === null) {
          anyRegion = true;
          break;
        }
        if (s === 'empty') {
          anyEmpty = true;
          continue;
        }
        u = u ? union(u, s) : s;
      }
      def = anyRegion ? null : u || (anyEmpty ? 'empty' : null);
    }
    // `subRegion` (the importer, for the first primitives of a filter-list stage after a url() stage's own clip): the stage is a filter of its
    // own, so what it reads does not narrow its default subregion; that is the filter region.
    if (p.subRegion === 1 && def !== 'empty') def = null;
    const sub = node.type !== 'feImage' ? p.sub : null;
    if (sub && p.subUnits !== 1 && def !== 'empty') {
      const base = def || region;
      if (!base || (m && !inv)) return (out[i] = 'empty');
      const bu = inv ? mapRect(inv, base) : base; // the default, back in the user space the attributes are in
      const x = has(sub[0]) ? sub[0] : bu[0],
        y = has(sub[1]) ? sub[1] : bu[1];
      const w = has(sub[2]) ? sub[2] : bu[2] - bu[0],
        h = has(sub[3]) ? sub[3] : bu[3] - bu[1];
      // A stated subregion of no area (width or height zero or negative) DISABLES the primitive: its result is transparent black (Filter
      // Effects 1 §9, "Filter primitive subregion"; a zero or negative width / height "disables the effect of the given filter primitive").
      // Chrome does not clip it -- a zero-width feFlood floods the whole filter region -- and importSvg({ compat: 'chrome' }) marks such a
      // node chromeZeroSub, which keeps its default subregion.
      if (w > 0 && h > 0) {
        const ur = [x, y, x + w, y + h];
        def = m ? mapRect(m, ur) : ur;
      } else if (p.chromeZeroSub !== 1) return (out[i] = 'empty');
    }
    return (out[i] = def);
  };
  for (let i = 0; i < n; i++) at(i);
  return out;
}
