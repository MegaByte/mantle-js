// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _filterOwnerGradientCases.mjs -- the cells of filterOwnerGradientRenderSmoke (FillPaint and StrokePaint that are gradients).
// Chrome does not implement FillPaint, so each cell carries an independently authored reference that Chrome renders:
//   plain  the element itself, no filter: `FillPaint in SourceAlpha` IS the element's own fill (and `StrokePaint in SourceAlpha` its stroke);
//   image  the same filter with FillPaint / StrokePaint replaced by an <feImage> of the paint server painted over the filter region (a data: SVG
//          whose viewBox is the region), so every primitive after it runs on Chrome's own paint.
// Every cell is a 64-unit canvas drawn at 128 px by Mantle and by Chrome's SVG engine at 8x (box-averaged). `scale(s)` re-authors a cell at s times
// the size (a viewBox of 64 s units, the content under scale(s)): a gradient paint must come out the same at any scale.
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const REGION = { x: -8, y: -8, w: 80, h: 80 }; // the filter region of every cell (user space), a margin of 8 units around the 64-unit canvas
const regionAttrs = (rg) =>
  `filterUnits="userSpaceOnUse" x="${rg.x}" y="${rg.y}" width="${rg.w}" height="${rg.h}"`;

const STOPS3 =
  '<stop offset="0" stop-color="#e02010"/><stop offset=".55" stop-color="#f0c020" stop-opacity=".8"/><stop offset="1" stop-color="#1040e0"/>';
const STOPS2 =
  '<stop offset="0" stop-color="#10a050"/><stop offset="1" stop-color="#8020c0" stop-opacity=".7"/>';
// (The plain cells need an OPAQUE source: `FillPaint in SourceAlpha` is paint x the element's own alpha, which is the paint squared where a stop is translucent.)
const OPAQUE = (stops) => stops.replace(/ stop-opacity="[^"]*"/g, '');
/** The paint servers, id "g" (fill) and "h" (stroke). `user`: userSpaceOnUse numbers for the image reference, same picture as the authored one. */
export const SERVERS_OPAQUE = {};
export const SERVERS = {
  linObb: { def: `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${STOPS3}</linearGradient>` },
  linUser: {
    def: `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="12" y1="10" x2="52" y2="46">${STOPS3}</linearGradient>`,
  },
  radFocal: {
    def: `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32" cy="32" r="22" fx="24" fy="26" spreadMethod="reflect">${STOPS3}</radialGradient>`,
  },
  rep: {
    def: `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="14" y1="14" x2="30" y2="14" gradientTransform="rotate(30 32 32)" spreadMethod="repeat">${STOPS3}</linearGradient>`,
  },
  linEndAlpha: {
    def: `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="54" y2="0">${STOPS2}</linearGradient>`,
  },
  strokeUser: {
    def: `<linearGradient id="h" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="54" y2="0">${STOPS2}</linearGradient>`,
  },
};
for (const [k, v] of Object.entries(SERVERS)) SERVERS_OPAQUE[k] = { def: OPAQUE(v.def) };

const doc = (body, defs = '', s = 1) =>
  `<svg ${NS} width="128" height="128" viewBox="0 0 ${64 * s} ${64 * s}"><rect width="${64 * s}" height="${64 * s}" fill="white"/>` +
  `<g transform="scale(${s})"><defs>${defs}</defs>${body}</g></svg>`;
const imageHref = (rg, grad, id) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg ${NS} width="${rg.w}" height="${rg.h}" viewBox="${rg.x} ${rg.y} ${rg.w} ${rg.h}" preserveAspectRatio="none"><defs>${grad}</defs><rect x="${rg.x}" y="${rg.y}" width="${rg.w}" height="${rg.h}" fill="url(#${id})"/></svg>`,
  );
const feImage = (rg, grad, id, result) =>
  `<feImage href="${imageHref(rg, grad, id)}" x="${rg.x}" y="${rg.y}" width="${rg.w}" height="${rg.h}" preserveAspectRatio="none" result="${result}"/>`;

/**
 * A cell: { id, shape (markup of the element; it carries filter="url(#f)"), defs (paint servers), filter (inner markup, FillPaint / StrokePaint named),
 *   ref: 'plain' | 'image', plain (markup of the element without the filter), imageGrads: { FillPaint: [def, id], StrokePaint: [def, id] }, dark?, bounds }
 */
const cell = (c) => c;
const SQ = (attrs) =>
  `<rect x="14" y="14" width="36" height="32" rx="4" filter="url(#f)" ${attrs}/>`;
const SQ0 = (attrs) => `<rect x="14" y="14" width="36" height="32" rx="4" ${attrs}/>`;
const IN_ALPHA = '<feComposite in="FillPaint" in2="SourceAlpha" operator="in"/>';

export const CELLS = [
  // ── plain: the paint inside the shape is the shape's own fill ──────────────────────────────────────────────────────────────────────
  cell({
    id: 'lin-obb',
    defs: SERVERS_OPAQUE.linObb.def,
    shape: SQ('fill="url(#g)"'),
    plain: SQ0('fill="url(#g)"'),
    filter: IN_ALPHA,
    ref: 'plain',
  }),
  cell({
    id: 'lin-user',
    defs: SERVERS_OPAQUE.linUser.def,
    shape: SQ('fill="url(#g)"'),
    plain: SQ0('fill="url(#g)"'),
    filter: IN_ALPHA,
    ref: 'plain',
  }),
  cell({
    id: 'radial-focal-reflect',
    defs: SERVERS_OPAQUE.radFocal.def,
    shape: '<circle cx="32" cy="32" r="19" filter="url(#f)" fill="url(#g)"/>',
    plain: '<circle cx="32" cy="32" r="19" fill="url(#g)"/>',
    filter: IN_ALPHA,
    ref: 'plain',
  }),
  cell({
    id: 'repeat-rotated',
    defs: SERVERS_OPAQUE.rep.def,
    shape: SQ('fill="url(#g)"'),
    plain: SQ0('fill="url(#g)"'),
    filter: IN_ALPHA,
    ref: 'plain',
  }),
  cell({
    id: 'stroke',
    defs: SERVERS_OPAQUE.strokeUser.def,
    shape:
      '<path d="M12 40 C 22 8 42 8 52 40" fill="none" stroke="url(#h)" stroke-width="8" stroke-linecap="round" filter="url(#f)"/>',
    plain:
      '<path d="M12 40 C 22 8 42 8 52 40" fill="none" stroke="url(#h)" stroke-width="8" stroke-linecap="round"/>',
    filter: '<feComposite in="StrokePaint" in2="SourceAlpha" operator="in"/>',
    ref: 'plain',
    mean: 2.5,
    over: 1800,
  }),
  cell({
    id: 'transformed-obb',
    region: { x: -30, y: -30, w: 60, h: 60 },
    defs: SERVERS_OPAQUE.linObb.def,
    shape:
      '<g transform="translate(32 32) rotate(20) scale(1.2 .8)"><rect x="-18" y="-16" width="36" height="32" rx="4" fill="url(#g)" filter="url(#f)"/></g>',
    plain:
      '<g transform="translate(32 32) rotate(20) scale(1.2 .8)"><rect x="-18" y="-16" width="36" height="32" rx="4" fill="url(#g)"/></g>',
    filter: IN_ALPHA,
    ref: 'plain',
  }),
  cell({
    id: 'group-user',
    defs: SERVERS_OPAQUE.linUser.def,
    shape:
      '<g fill="url(#g)" filter="url(#f)"><rect x="10" y="12" width="24" height="24"/><circle cx="40" cy="38" r="12"/></g>',
    plain:
      '<g fill="url(#g)"><rect x="10" y="12" width="24" height="24"/><circle cx="40" cy="38" r="12"/></g>',
    filter: IN_ALPHA,
    ref: 'plain',
  }),
  // ── image: the filter runs on Chrome's own paint ────────────────────────────────────────────────────────────────────────────────────
  cell({
    id: 'offset',
    defs: SERVERS.linUser.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) =>
      `<feOffset in="${p}" dx="9" dy="-4" result="o"/><feComposite in="o" in2="SourceAlpha" operator="in"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.linUser.def, 'g'] },
  }),
  cell({
    id: 'blur',
    defs: SERVERS.rep.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) =>
      `<feGaussianBlur in="${p}" stdDeviation="2.5" result="b"/><feComposite in="b" in2="SourceAlpha" operator="in"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.rep.def, 'g'] },
  }),
  cell({
    id: 'saturate-linear',
    linear: true,
    defs: SERVERS.radFocal.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) =>
      `<feColorMatrix in="${p}" type="saturate" values=".3" result="s"/><feComposite in="s" in2="SourceAlpha" operator="in"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.radFocal.def, 'g'] },
  }),
  cell({
    id: 'multiply-source',
    defs: SERVERS.linUser.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) => `<feBlend in="${p}" in2="SourceGraphic" mode="multiply"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.linUser.def, 'g'] },
  }),
  cell({
    id: 'fill-and-stroke',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p, q) =>
      `<feComposite in="${p}" in2="SourceAlpha" operator="atop" result="a"/><feBlend in="${q}" in2="a" mode="screen"/>`,
    ref: 'image',
    imageGrads: {
      FillPaint: [SERVERS.linUser.def, 'g'],
      StrokePaint: [SERVERS.strokeUser.def, 'h'],
    },
  }),
  // The region reaches 8 units past the canvas on every side: an offset of the paint pulls paint from beyond the canvas edge.
  // The pieces of fill-and-stroke, one at a time. (The filter sits on a <g>: a filter on a LEAF that has both a fill and a stroke is applied once per row, a separate
  // defect that doubles any translucent result.)
  cell({
    id: 'atop',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p) => `<feComposite in="${p}" in2="SourceAlpha" operator="atop"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.linUser.def, 'g'] },
  }),
  cell({
    id: 'screen-stroke',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p, q) => `<feBlend in="${q}" in2="SourceGraphic" mode="screen"/>`,
    ref: 'image',
    imageGrads: { StrokePaint: [SERVERS.strokeUser.def, 'h'] },
  }),
  cell({
    id: 'fill-in-stroke',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p, q) => `<feComposite in="${p}" in2="${q}" operator="in"/>`,
    ref: 'image',
    imageGrads: {
      FillPaint: [SERVERS.linUser.def, 'g'],
      StrokePaint: [SERVERS.strokeUser.def, 'h'],
    },
  }),
  // The paint alone, and an end stop with alpha (the paint beyond the gradient's end is its last stop), for each role.
  cell({
    id: 'fill-alone-end-alpha',
    defs: SERVERS.linEndAlpha.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) => `<feMerge><feMergeNode in="${p}"/></feMerge>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.linEndAlpha.def, 'g'] },
  }),
  cell({
    id: 'stroke-alone',
    defs: SERVERS.strokeUser.def,
    shape: SQ('fill="none" stroke="url(#h)" stroke-width="6"'),
    filter: (p, q) => `<feMerge><feMergeNode in="${q}"/></feMerge>`,
    ref: 'image',
    imageGrads: { StrokePaint: [SERVERS.strokeUser.def, 'h'] },
  }),
  // ...on an element that has both paints.
  cell({
    id: 'stroke-alone-both',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p, q) => `<feMerge><feMergeNode in="${q}"/></feMerge>`,
    ref: 'image',
    imageGrads: { StrokePaint: [SERVERS.strokeUser.def, 'h'] },
  }),
  cell({
    id: 'fill-alone-both',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p, q) => `<feMerge><feMergeNode in="${p}"/></feMerge>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.linUser.def, 'g'] },
  }),
  cell({
    id: 'stroke-in-fill',
    defs: SERVERS.linUser.def + SERVERS.strokeUser.def,
    shape:
      '<g fill="url(#g)" stroke="url(#h)" stroke-width="7" filter="url(#f)"><rect x="16" y="16" width="32" height="30" rx="6"/></g>',
    filter: (p, q) => `<feComposite in="${q}" in2="${p}" operator="in"/>`,
    ref: 'image',
    imageGrads: {
      FillPaint: [SERVERS.linUser.def, 'g'],
      StrokePaint: [SERVERS.strokeUser.def, 'h'],
    },
  }),
  // A region well inside the canvas: the paint target is the region plus the graph's reach, on the pool's grid, and nothing is read past it.
  cell({
    id: 'small-region-blur',
    region: { x: 6, y: 8, w: 52, h: 46 },
    defs: SERVERS.rep.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) =>
      `<feGaussianBlur in="${p}" stdDeviation="1.5" result="b"/><feComposite in="b" in2="SourceAlpha" operator="in"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.rep.def, 'g'] },
  }),
  cell({
    id: 'small-region-offset',
    region: { x: 4, y: 4, w: 56, h: 56 },
    defs: SERVERS.radFocal.def,
    shape: SQ('fill="url(#g)"'),
    filter: (p) =>
      `<feOffset in="${p}" dx="-6" dy="5" result="o"/><feComposite in="o" in2="SourceAlpha" operator="in"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.radFocal.def, 'g'] },
  }),
  cell({
    id: 'canvas-edge-offset',
    defs: SERVERS.linUser.def,
    shape: '<rect x="-4" y="14" width="30" height="32" filter="url(#f)" fill="url(#g)"/>',
    filter: (p) =>
      `<feOffset in="${p}" dx="7" dy="0" result="o"/><feComposite in="o" in2="SourceAlpha" operator="in"/>`,
    ref: 'image',
    imageGrads: { FillPaint: [SERVERS.linUser.def, 'g'] },
  }),
];

/** The SVG Mantle draws and the one Chrome draws, for a cell at scale `s`. */
export function cellSvgs(c, s = 1) {
  const f = typeof c.filter === 'function' ? c.filter('FillPaint', 'StrokePaint') : c.filter;
  const rg = c.region || REGION,
    REGION_ATTRS = regionAttrs(rg);
  const cif = c.linear ? '' : ' color-interpolation-filters="sRGB"'; // (the property's initial value is linearRGB)
  const mantle = doc(c.shape, `${c.defs}<filter id="f" ${REGION_ATTRS}${cif}>${f}</filter>`, s);
  if (c.ref === 'plain') return { mantle, chrome: doc(c.plain, c.defs, s) };
  const names = { FillPaint: 'pf', StrokePaint: 'ps' };
  const images = Object.entries(c.imageGrads)
    .map(([role, [def, id]]) => feImage(rg, def, id, names[role]))
    .join('');
  const fc = typeof c.filter === 'function' ? c.filter('pf', 'ps') : c.filter;
  const chrome = doc(
    c.shape,
    `${c.defs}<filter id="f" ${REGION_ATTRS}${cif}>${images}${fc}</filter>`,
    s,
  );
  return { mantle, chrome };
}
