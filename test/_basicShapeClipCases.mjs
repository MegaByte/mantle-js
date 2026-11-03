// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _basicShapeClipCases.mjs -- the cells of basicShapeClipRenderSmoke (CSS basic-shape clip-path and clip-path on a
// nested <svg>). Each is a 64-unit cell drawn at 128 px by Mantle and by Chrome's own SVG engine at 8x, box-averaged.
//
// [id, svg, { mean, over, tol, spec, opts, scales }]. `spec: true` cells are held to a CONTROL (the same clip written as a plain
// userSpaceOnUse <clipPath>, below) rather than to Chrome, where Chrome departs from the spec text; Chrome is only reported.
// `opts` are the importSvg options of the cell (compat:'chrome' cells are Chrome-parity cells).
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/><defs>${defs}</defs>${body}</svg>`;
const R = (extra = '', st = '') =>
  `<rect x="8" y="8" width="48" height="40" fill="#e04020" ${extra} ${st ? `style="${st}"` : ''}/>`;
const clipCtl = (d, rule = 'nonzero', body = R) =>
  doc(
    `<g clip-path="url(#c)">${body()}</g>`,
    `<clipPath id="c"><path d="${d}" clip-rule="${rule}"/></clipPath>`,
  );
const rr = (x, y, w, h) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const circ = (cx, cy, r) =>
  `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
const ell = (cx, cy, rx, ry) =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;

/** @type {Array<[string, string, object]>} */
export const CASES = [
  // fill box (no stroke): all the box spellings that are the fill box
  ['circle-pct', doc(R('', 'clip-path:circle(50%)')), { scales: true }],
  ['circle-px-at', doc(R('', 'clip-path:circle(15px at 30% 70%)')), { scales: true }],
  ['circle-closest', doc(R('', 'clip-path:circle(closest-side at 25% 40%)')), {}],
  ['circle-farthest', doc(R('', 'clip-path:circle(farthest-side at 25% 40%)')), {}],
  ['ellipse', doc(R('', 'clip-path:ellipse(40% 25% at 50% 50%)')), { scales: true }],
  [
    'ellipse-kw-pos',
    doc(R('', 'clip-path:ellipse(closest-side farthest-side at right 10px bottom 20%)')),
    {},
  ],
  ['inset', doc(R('', 'clip-path:inset(5px 10px 15px 20px)')), { scales: true }],
  ['inset-round', doc(R('', 'clip-path:inset(4px round 12px 3px 9px 20px)')), { scales: true }],
  ['inset-round-elliptic', doc(R('', 'clip-path:inset(2px 3px round 20px / 6px 10px)')), {}],
  ['inset-round-overlap', doc(R('', 'clip-path:inset(0 round 60px)')), {}],
  ['inset-empty', doc(R('', 'clip-path:inset(30px 30px)')), {}],
  ['polygon', doc(R('', 'clip-path:polygon(50% 0, 100% 50%, 50% 100%, 0 50%)')), { scales: true }],
  [
    'polygon-evenodd',
    doc(R('', 'clip-path:polygon(evenodd, 50% 0, 80% 100%, 0 38%, 100% 38%, 20% 100%)')),
    {},
  ],
  [
    'polygon-nonzero',
    doc(R('', 'clip-path:polygon(nonzero, 50% 0, 80% 100%, 0 38%, 100% 38%, 20% 100%)')),
    {},
  ],
  [
    'polygon-px-calc',
    doc(R('', 'clip-path:polygon(calc(10px + 5%) 0, 100% 10px, calc(100% - 4px) 100%, 0 80%)')),
    {},
  ],
  ['path', doc(R('', "clip-path:path('M 5 5 L 40 5 L 40 20 Q 20 40 5 20 Z')")), { scales: true }],
  [
    'path-evenodd',
    doc(R('', "clip-path:path(evenodd, 'M 0 0 H 40 V 30 H 0 Z M 10 8 H 30 V 22 H 10 Z')")),
    {},
  ],
  ['xywh', doc(R('', 'clip-path:xywh(6px 4px 30px 20px round 5px)')), {}],
  ['rect-fn', doc(R('', 'clip-path:rect(4px 40px 30px 6px round 5px)')), {}],
  ['box-only-fill', doc(R('', 'clip-path:fill-box')), {}],
  ['em-units', doc(R('', 'font-size:4px;clip-path:inset(2em 1em)')), {}],
  ['attr-form', doc(R('clip-path="circle(40%)"')), {}],
  [
    'css-rule',
    doc(R('class="k"'), '').replace(
      '<defs>',
      '<style>.k{clip-path:ellipse(45% 30%)}</style><defs>',
    ),
    {},
  ],
  // reference boxes on a stroked shape: the stroke box is the DEFAULT (border-box), the fill box ignores the stroke
  [
    'stroke-default',
    doc(R('stroke="#206090" stroke-width="12"', 'clip-path:circle(50%)')),
    { scales: true },
  ],
  [
    'stroke-box',
    doc(R('stroke="#206090" stroke-width="12"', 'clip-path:circle(50%) stroke-box')),
    {},
  ],
  [
    'stroke-fill-box',
    doc(R('stroke="#206090" stroke-width="12"', 'clip-path:circle(50%) fill-box')),
    {},
  ],
  [
    'stroke-border-box',
    doc(R('stroke="#206090" stroke-width="12"', 'clip-path:inset(10px) border-box')),
    {},
  ],
  [
    'stroke-content-box',
    doc(R('stroke="#206090" stroke-width="12"', 'clip-path:inset(10px) content-box')),
    {},
  ],
  [
    'stroke-miter',
    doc(
      '<path d="M12 50L32 10L52 50" fill="none" stroke="#206090" stroke-width="10" stroke-linejoin="miter" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  [
    'stroke-bevel',
    doc(
      '<path d="M12 50L32 10L52 50" fill="none" stroke="#206090" stroke-width="10" stroke-linejoin="bevel" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  [
    'stroke-round',
    doc(
      '<path d="M12 50L32 10L52 50" fill="none" stroke="#206090" stroke-width="10" stroke-linejoin="round" stroke-linecap="round" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  [
    'stroke-square-cap',
    doc(
      '<path d="M14 14L48 40" fill="none" stroke="#206090" stroke-width="10" stroke-linecap="square" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  [
    'stroke-butt-diag',
    doc(
      '<path d="M14 14L48 40" fill="none" stroke="#206090" stroke-width="10" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  [
    'stroke-curve',
    doc(
      '<path d="M10 40C10 0 54 0 54 40" fill="none" stroke="#206090" stroke-width="12" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  // A stroke wider than the curve's radius of curvature: the offset curve has a cusp of its own at the bend. The cusp is inside the ink,
  // so the box (the clip's reference) must equal the one the other offset points give.
  [
    'stroke-cusp',
    doc(
      '<path d="M22 50C28 16 36 16 42 50" fill="none" stroke="#206090" stroke-width="26" stroke-linejoin="round" style="clip-path:inset(0 round 6px)"/>',
    ),
    {},
  ],
  [
    'stroke-cusp-miter',
    doc(
      '<path d="M22 50C28 16 36 16 42 50" fill="none" stroke="#206090" stroke-width="26" style="clip-path:inset(0 round 6px)"/>',
    ),
    {},
  ],
  [
    'stroke-cusp-xf',
    doc(
      '<path d="M22 50C28 16 36 16 42 50" fill="none" stroke="#206090" stroke-width="26" transform="translate(32 32) rotate(30) scale(1.3 .7) translate(-32 -32)" style="clip-path:inset(0 round 6px)"/>',
    ),
    {},
  ],
  [
    'stroke-circle',
    doc(
      '<circle cx="32" cy="32" r="18" fill="#e04020" stroke="#206090" stroke-width="10" style="clip-path:inset(0 round 8px)"/>',
    ),
    {},
  ],
  // view box
  ['view-box', doc(R('', 'clip-path:circle(30%) view-box')), {}],
  // transforms: the shape lives in the carrier's user space
  [
    'xf-rotate',
    doc(
      '<g transform="translate(32 32) rotate(25) scale(1.2 .8)"><rect x="-24" y="-20" width="48" height="40" fill="#e04020" style="clip-path:ellipse(40% 30%)"/></g>',
    ),
    { scales: true },
  ],
  [
    'xf-own-transform',
    doc(
      '<rect x="-24" y="-20" width="48" height="40" fill="#e04020" transform="translate(32 32) rotate(25) scale(1.2 .8)" style="clip-path:inset(4px round 10px)"/>',
    ),
    {},
  ],
  [
    'xf-skew',
    doc(
      '<rect x="8" y="12" width="40" height="32" fill="#e04020" transform="skewX(20)" style="clip-path:circle(50%)"/>',
    ),
    {},
  ],
  [
    'xf-stroked',
    doc(
      '<rect x="-20" y="-16" width="40" height="32" fill="#e04020" stroke="#206090" stroke-width="8" transform="translate(32 32) scale(1.4 .7)" style="clip-path:circle(50%)"/>',
    ),
    {},
  ],
  [
    'xf-stroked-rot',
    doc(
      '<path d="M-20 -14L0 14L20 -14" fill="none" stroke="#206090" stroke-width="8" transform="translate(32 32) rotate(30) scale(1.3 .8)" style="clip-path:inset(0 round 6px)"/>',
    ),
    {},
  ],
  // groups, uses, nested svg
  [
    'group',
    doc(
      '<g style="clip-path:circle(50%)"><rect x="6" y="10" width="30" height="30" fill="#e04020"/><rect x="28" y="24" width="30" height="30" fill="#2060d0"/></g>',
    ),
    { scales: true },
  ],
  [
    'group-stroked',
    doc(
      '<g style="clip-path:inset(0 round 10px)"><rect x="14" y="14" width="20" height="20" fill="#e04020" stroke="#206090" stroke-width="8"/><rect x="34" y="30" width="20" height="20" fill="#2060d0"/></g>',
    ),
    {},
  ],
  [
    'use-carrier',
    doc(
      '<defs><rect id="r" x="8" y="8" width="24" height="24" fill="#e04020"/></defs><use href="#r" style="clip-path:circle(50%)"/><use href="#r" x="26" y="26" style="clip-path:circle(50%)"/>',
    ),
    {},
  ],
  [
    'nested-svg-basic',
    doc(
      '<svg x="8" y="8" width="48" height="48" viewBox="0 0 24 24" style="clip-path:circle(50%)"><rect width="24" height="24" fill="#e04020"/><rect x="4" y="4" width="16" height="16" fill="#2060d0"/></svg>',
    ),
    {},
  ],
  [
    'nested-svg-url',
    doc(
      '<svg x="8" y="8" width="48" height="48" viewBox="0 0 24 24" clip-path="url(#c)"><rect width="24" height="24" fill="#e04020"/></svg>',
      '<clipPath id="c"><circle cx="12" cy="12" r="9"/></clipPath>',
    ),
    {},
  ],
  [
    'nested-svg-url-obb',
    doc(
      '<svg x="8" y="8" width="48" height="48" viewBox="0 0 24 24" clip-path="url(#c)"><rect x="2" y="2" width="20" height="16" fill="#e04020"/></svg>',
      '<clipPath id="c" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".4"/></clipPath>',
    ),
    {},
  ],
  [
    'nested-svg-overflow',
    doc(
      '<svg x="8" y="8" width="30" height="30" overflow="visible" style="clip-path:inset(0 round 6px)"><rect x="-10" y="-10" width="60" height="60" fill="#e04020"/></svg>',
    ),
    {},
  ],
  // view-box on a nested <svg>: the carrier itself, a child of it (its viewBox is the nearest viewport), and a viewBox-less one
  [
    'nested-svg-viewbox-carrier',
    doc(
      '<svg x="8" y="8" width="48" height="48" viewBox="0 0 24 24" style="clip-path:circle(30%) view-box"><rect width="24" height="24" fill="#e04020"/><rect x="4" y="4" width="16" height="16" fill="#2060d0"/></svg>',
    ),
    {},
  ],
  [
    'nested-svg-viewbox-child',
    doc(
      '<svg x="8" y="8" width="48" height="48" viewBox="0 0 24 24"><rect width="24" height="24" fill="#e04020" style="clip-path:circle(40%) view-box"/><rect x="4" y="4" width="16" height="16" fill="#2060d0"/></svg>',
    ),
    {},
  ],
  [
    'nested-svg-viewbox-scaled',
    doc(
      '<svg x="4" y="12" width="56" height="40" viewBox="0 0 100 50" preserveAspectRatio="xMinYMid meet"><rect width="100" height="50" fill="#e04020" style="clip-path:inset(10px 20px) view-box"/></svg>',
    ),
    {},
  ],
  [
    'nested-svg-viewbox-none',
    doc(
      '<svg x="8" y="8" width="40" height="40"><rect width="64" height="64" fill="#e04020" style="clip-path:circle(50%) view-box"/></svg>',
    ),
    {},
  ],
  // a clip on top of a clip: the intersection
  [
    'two-clips',
    doc(
      '<g clip-path="url(#c)"><rect x="8" y="8" width="48" height="40" fill="#e04020" style="clip-path:circle(50%)"/></g>',
      '<clipPath id="c"><rect x="0" y="0" width="30" height="64"/></clipPath>',
    ),
    {},
  ],
  [
    'basic-outer-child-clip',
    doc(
      '<g style="clip-path:circle(50%)"><rect x="8" y="8" width="48" height="40" fill="#e04020" clip-path="url(#c)"/><rect x="30" y="30" width="30" height="30" fill="#2060d0"/></g>',
      '<clipPath id="c"><rect x="0" y="0" width="34" height="64"/></clipPath>',
    ),
    {},
  ],
  [
    'obb-outer-child-clip',
    doc(
      '<g clip-path="url(#o)"><rect x="8" y="8" width="48" height="40" fill="#e04020" clip-path="url(#c)"/></g>',
      '<clipPath id="o" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath><clipPath id="c"><rect x="0" y="0" width="34" height="64"/></clipPath>',
    ),
    {},
  ],
  [
    'basic-in-basic',
    doc(
      '<g style="clip-path:inset(4px 10px 4px 4px round 8px)"><rect x="8" y="8" width="48" height="40" fill="#e04020" style="clip-path:circle(50% at 40% 50%)"/></g>',
    ),
    {},
  ],
  [
    'clip-in-clippath',
    doc(
      '<g clip-path="url(#c)"><rect width="64" height="64" fill="#e04020"/></g>',
      '<clipPath id="c"><rect x="8" y="8" width="48" height="40" style="clip-path:circle(50%)"/></clipPath>',
    ),
    {},
  ],
  // a shape that resolves to nothing, and a value that is invalid (no clip)
  ['invalid-ignored', doc(R('', 'clip-path:circle(-5px)')), {}],
  ['zero-radius', doc(R('', 'clip-path:circle(0px)')), {}],
];

// Controls: the same clip written as a userSpaceOnUse <clipPath> in the carrier's own space. A cell listed here must equal its control.
const stroked = (extra) =>
  `<rect x="8" y="8" width="48" height="40" fill="#e04020" stroke="#206090" stroke-width="12" ${extra}/>`;
export const CONTROLS = {
  'circle-pct': clipCtl(circ(32, 28, 0.5 * Math.sqrt((48 * 48 + 40 * 40) / 2))),
  'circle-px-at': clipCtl(circ(8 + 0.3 * 48, 8 + 0.7 * 40, 15)),
  inset: clipCtl(rr(28, 13, 18, 20)),
  polygon: clipCtl(`M32 8L56 28L32 48L8 28Z`),
  'stroke-default': doc(
    stroked('clip-path="url(#c)"'),
    `<clipPath id="c"><path d="${circ(32, 28, 0.5 * Math.sqrt((60 * 60 + 52 * 52) / 2))}"/></clipPath>`,
  ),
  'stroke-fill-box': doc(
    stroked('clip-path="url(#c)"'),
    `<clipPath id="c"><path d="${circ(32, 28, 0.5 * Math.sqrt((48 * 48 + 40 * 40) / 2))}"/></clipPath>`,
  ),
  'stroke-box': doc(
    stroked('clip-path="url(#c)"'),
    `<clipPath id="c"><path d="${circ(32, 28, 0.5 * Math.sqrt((60 * 60 + 52 * 52) / 2))}"/></clipPath>`,
  ),
  'zero-radius': doc('', ''),
  'invalid-ignored': doc(R()),
};
export const _helpers = { rr, circ, ell };
