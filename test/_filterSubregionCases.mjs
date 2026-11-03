// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _filterSubregionCases.mjs -- the cells of filterSubregionRenderSmoke (primitive subregions, primitiveUnits,
// CSS filter functions and filter lists). Each is a 64-unit cell drawn at 128 px by Mantle and by Chrome (8x, box-averaged).
//
// [id, svg, { mean, over, tol }] -- the bound on the mean absolute channel difference over the non-edge pixels, and on how many
// of them differ by more than `tol` (default 8).
import zlib from 'zlib';
// A flat green 8 x 8 PNG (feImage takes a raster, not an SVG).
function png(w, h, pixel) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      len = Buffer.alloc(4),
      c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
const PNG = png(8, 8, (x) => (x < 4 ? [0, 160, 0, 255] : [0, 0, 255, 255]));
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/><defs>${defs}</defs>${body}</svg>`;
const SQ = '<rect x="16" y="16" width="32" height="32" fill="#e04020"/>';
const SQ2 = '<rect x="16" y="16" width="32" height="16" fill="#e04020"/>'; // 32 x 16: an anisotropic box
const SRC =
  '<rect x="12" y="12" width="28" height="28" fill="#e04020"/><circle cx="40" cy="40" r="13" fill="#2060d0" fill-opacity=".75"/><rect x="26" y="8" width="6" height="48" fill="#20a040" fill-opacity=".5"/>';
const REG =
  'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"';
const OBB = 'primitiveUnits="objectBoundingBox"';
const F = (inner, attrs = REG) => `<filter id="f" ${attrs}>${inner}</filter>`;
const use = (inner, { attrs = REG, body = SQ, g = '' } = {}) =>
  doc(`<g filter="url(#f)" ${g}>${body}</g>`, F(inner, attrs));
const el = (inner, { attrs = REG, body = SQ } = {}) =>
  doc(body.replace('<rect', '<rect filter="url(#f)"'), F(inner, attrs));

/** @type {Array<[string, string, {mean?: number, over?: number, tol?: number}]>} */
export const CASES = [
  // ── primitive subregions ─────────────────────────────────────────────────────────────────────────────────────────────────
  ['s-flood', use('<feFlood flood-color="#2060d0" x="10" y="10" width="20" height="20"/>'), {}],
  [
    's-flood-percent',
    use('<feFlood flood-color="#2060d0" x="25%" y="25%" width="50%" height="25%"/>'),
    { scales: true },
  ],
  ['s-flood-xonly', use('<feFlood flood-color="#2060d0" x="30"/>'), {}],
  ['s-flood-wh-only', use('<feFlood flood-color="#2060d0" width="20" height="30"/>', {}), {}],
  [
    's-offset',
    use('<feOffset dx="10" dy="0" x="20" y="0" width="30" height="64"/>'),
    { scales: true },
  ],
  ['s-offset-y', use('<feOffset dx="0" dy="9" x="0" y="20" width="64" height="30"/>'), {}],
  [
    's-blur',
    use('<feGaussianBlur stdDeviation="4" x="20" y="0" width="30" height="64"/>'),
    { scales: true },
  ],
  [
    's-blur-of-flood',
    use(
      '<feFlood flood-color="#2060d0" x="20" y="20" width="24" height="24" result="a"/><feGaussianBlur stdDeviation="4"/>',
    ),
    { scales: true },
  ],
  [
    's-offset-of-flood',
    use(
      '<feFlood flood-color="#2060d0" x="20" y="20" width="10" height="10" result="a"/><feOffset in="a" dx="5" dy="5"/>',
    ),
    {},
  ],
  [
    's-merge-default',
    use(
      '<feFlood flood-color="#2060d0" x="20" y="20" width="10" height="10" result="a"/><feFlood flood-color="#e03030" x="40" y="40" width="10" height="10" result="b"/><feMerge><feMergeNode in="a"/><feMergeNode in="b"/></feMerge>',
    ),
    {},
  ],
  [
    's-blend-default',
    use(
      '<feFlood flood-color="#2060d0" x="20" y="20" width="10" height="10" result="a"/><feBlend in="a" in2="SourceGraphic" mode="multiply"/>',
    ),
    {},
  ],
  [
    's-composite-in',
    use(
      '<feFlood flood-color="#2060d0" x="24" y="0" width="16" height="64" result="a"/><feComposite in="a" in2="SourceGraphic" operator="in"/>',
    ),
    {},
  ],
  [
    's-tile',
    use(
      '<feFlood flood-color="#2060d0" x="8" y="8" width="8" height="8" result="a"/><feOffset in="a" dx="0" dy="0" x="8" y="8" width="16" height="16" result="b"/><feTile in="b"/>',
    ),
    { over: 80, scales: true },
  ],
  [
    's-tile-offset',
    use(
      '<feOffset dx="6" dy="4" x="16" y="16" width="16" height="16" result="o"/><feTile in="o"/>',
      { body: SQ },
    ),
    { over: 80, scales: true },
  ],
  [
    's-tile-flood',
    use(
      '<feFlood flood-color="#2060d0" x="4" y="4" width="12" height="12" result="a"/><feTile in="a"/>',
    ),
    { over: 80 },
  ],
  // A zero or negative subregion extent: Filter Effects 1 DISABLES the primitive (transparent black) -- the default, held to a literal control, not to
  // Chrome, which floods the whole region ({ spec: true } reports Chrome's difference but does not score it). compat: 'chrome' is held to Chrome.
  [
    's-empty-width',
    use(
      '<feFlood flood-color="#2060d0" x="10" y="10" width="0" height="20" result="a"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="a"/></feMerge>',
    ),
    { opts: { compat: 'chrome' } },
  ],
  [
    's-empty-width-spec',
    use(
      '<feFlood flood-color="#2060d0" x="10" y="10" width="0" height="20" result="a"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="a"/></feMerge>',
    ),
    { spec: true },
  ],
  [
    's-empty-height-negative-spec',
    use(
      '<feFlood flood-color="#2060d0" x="10" y="10" width="20" height="-5" result="a"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="a"/></feMerge>',
    ),
    { spec: true },
  ],
  [
    's-empty-blur-input-spec',
    use(
      '<feFlood flood-color="#2060d0" x="10" y="10" width="0" height="20" result="a"/><feGaussianBlur in="a" stdDeviation="3"/>',
    ),
    { spec: true },
  ],
  [
    's-colormatrix',
    use(
      '<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 1  0 0 0 1 0" x="20" y="0" width="16" height="64"/>',
    ),
    {},
  ],
  [
    's-componenttransfer',
    use(
      '<feComponentTransfer x="0" y="24" width="64" height="12"><feFuncA type="table" tableValues="0.5"/></feComponentTransfer>',
    ),
    {},
  ],
  [
    's-morphology',
    use('<feMorphology operator="dilate" radius="4" x="20" y="0" width="30" height="64"/>'),
    {},
  ],
  [
    's-convolve',
    use(
      '<feConvolveMatrix order="3" kernelMatrix="0 0 0 0 0 1 0 0 0" divisor="1" x="24" y="0" width="30" height="64"/>',
    ),
    {},
  ],
  [
    's-displacement',
    use(
      '<feFlood flood-color="rgb(255,128,128)" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="12" xChannelSelector="R" yChannelSelector="G" x="0" y="20" width="64" height="24"/>',
    ),
    {},
  ],
  [
    's-turbulence',
    use(
      '<feTurbulence baseFrequency="0.08" numOctaves="2" seed="3" x="12" y="12" width="30" height="30"/>',
    ),
    { mean: 3 },
  ],
  [
    's-dropshadow',
    use('<feDropShadow dx="6" dy="6" stdDeviation="2" x="0" y="0" width="52" height="52"/>'),
    { over: 60, scales: true },
  ],
  [
    's-image',
    use(
      `<feImage href="${PNG}" x="10" y="10" width="20" height="20" result="i"/><feOffset in="i" dx="14" dy="14"/>`,
    ),
    { over: 120 },
  ],
  [
    's-frac',
    use('<feFlood flood-color="#2060d0" x="10.5" y="10.5" width="20.25" height="20.25"/>'),
    { over: 60 },
  ],
  // Chrome at 1x clips a fractional subregion to the ENCLOSING pixel rect (10.25..30.25 user units at 2x is columns 20..60): scored against Chrome's own 1x
  // picture, edges included, so the rounding rule itself is held.
  [
    's-frac-outward',
    use('<feFlood flood-color="#2060d0" x="10.25" y="10.75" width="20" height="20.5"/>'),
    { exact1x: true, mean: 0.05, over: 0 },
  ],
  [
    's-frac-outward-offset',
    use('<feOffset dx="7" dy="5" x="14.3" y="9.6" width="25.2" height="30.1"/>'),
    { exact1x: true, mean: 0.05, over: 0 },
  ],
  [
    's-frac-outward-scaled',
    use('<feFlood flood-color="#2060d0" x="8.3" y="8.3" width="12.7" height="12.7"/>', {
      g: 'transform="scale(1.5)"',
      attrs:
        'filterUnits="userSpaceOnUse" x="0" y="0" width="42" height="42" color-interpolation-filters="sRGB"',
    }),
    { exact1x: true, mean: 0.05, over: 0 },
  ],
  [
    's-beyond-region',
    use('<feFlood flood-color="#2060d0" x="-20" y="-20" width="200" height="200"/>', {
      attrs:
        'filterUnits="userSpaceOnUse" x="8" y="8" width="40" height="40" color-interpolation-filters="sRGB"',
    }),
    {},
  ],
  [
    's-scaled-ctm',
    use('<feFlood flood-color="#2060d0" x="12" y="12" width="14" height="14"/>', {
      g: 'transform="scale(1.5)"',
      attrs:
        'filterUnits="userSpaceOnUse" x="0" y="0" width="42" height="42" color-interpolation-filters="sRGB"',
    }),
    { scales: true },
  ],
  [
    's-translated-ctm',
    use('<feOffset dx="6" dy="0" x="20" y="0" width="22" height="40"/>', {
      g: 'transform="translate(6 8)"',
      attrs:
        'filterUnits="userSpaceOnUse" x="0" y="0" width="58" height="56" color-interpolation-filters="sRGB"',
    }),
    {},
  ],
  [
    's-group-two-kids',
    use('<feOffset dx="8" dy="0" x="24" y="0" width="30" height="64"/>', {
      body: '<rect x="10" y="12" width="20" height="20" fill="#e04020"/><rect x="30" y="30" width="20" height="20" fill="#2060d0"/>',
    }),
    {},
  ],
  [
    's-obb-flood',
    use('<feFlood flood-color="#2060d0" x="0.25" y="0.25" width="0.5" height="0.5"/>', {
      attrs: REG + ' ' + OBB,
    }),
    {},
  ],
  [
    's-obb-offset',
    use('<feOffset dx="0.25" dy="0" x="0.25" width="0.5"/>', { attrs: REG + ' ' + OBB }),
    { scales: true },
  ],
  [
    's-obb-percent',
    use('<feFlood flood-color="#2060d0" x="25%" y="25%" width="50%" height="50%"/>', {
      attrs: REG + ' ' + OBB,
    }),
    {},
  ],
  [
    's-filterunits-obb',
    use('<feFlood flood-color="#2060d0" x="20" y="20" width="12" height="12"/>', {
      attrs: 'color-interpolation-filters="sRGB"',
    }),
    {},
  ],
  [
    's-filterunits-obb-prim-obb',
    use('<feFlood flood-color="#2060d0" x="0.1" y="0.1" width="0.5" height="0.5"/>', {
      attrs: 'color-interpolation-filters="sRGB" ' + OBB,
    }),
    {},
  ],

  // ── primitiveUnits = objectBoundingBox ─────────────────────────────────────────────────────────────────────────────────
  [
    'p-blur',
    use('<feGaussianBlur stdDeviation="0.1"/>', { attrs: REG + ' ' + OBB }),
    { scales: true },
  ],
  [
    'p-blur-aniso',
    use('<feGaussianBlur stdDeviation="0.1 0.2"/>', { attrs: REG + ' ' + OBB, body: SQ2 }),
    {},
  ],
  [
    'p-offset',
    use('<feOffset dx="0.25" dy="0.5"/>', { attrs: REG + ' ' + OBB, body: SQ2 }),
    { scales: true },
  ],
  [
    'p-morph',
    use('<feMorphology operator="dilate" radius="0.1 0.2"/>', {
      attrs: REG + ' ' + OBB,
      body: SQ2,
    }),
    { scales: true },
  ],
  [
    'p-disp',
    use(
      '<feFlood flood-color="rgb(255,128,128)" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="0.5" xChannelSelector="R" yChannelSelector="G"/>',
      { attrs: REG + ' ' + OBB, body: SQ2 },
    ),
    {},
  ],
  [
    'p-disp-y',
    use(
      '<feFlood flood-color="rgb(128,255,128)" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="0.5" xChannelSelector="R" yChannelSelector="G"/>',
      { attrs: REG + ' ' + OBB, body: SQ2 },
    ),
    {},
  ],
  [
    'p-dropshadow',
    use('<feDropShadow dx="0.2" dy="0.2" stdDeviation="0.05" flood-color="#2060d0"/>', {
      attrs: REG + ' ' + OBB,
    }),
    { scales: true },
  ],
  [
    'p-dropshadow-chain',
    use(
      '<feOffset dx="0.1" result="o"/><feDropShadow in="o" dx="0.1" dy="0.1" stdDeviation="0.05" flood-color="#2060d0"/>',
      { attrs: REG + ' ' + OBB },
    ),
    { scales: true },
  ],
  // (Mantle's point-light shading itself differs from Chrome's by about 7 levels over the whole cell, the same at the user-unit control below, which this cell equals exactly.)
  [
    'p-light-point',
    use(
      '<feGaussianBlur in="SourceAlpha" stdDeviation="0.1" result="a"/><feDiffuseLighting in="a" surfaceScale="6" lighting-color="white"><fePointLight x="0.25" y="0.25" z="0.375"/></feDiffuseLighting>',
      { attrs: REG + ' ' + OBB },
    ),
    { mean: 3, over: 700, meanAll: 9 },
  ],
  [
    'p-light-spot',
    use(
      '<feGaussianBlur in="SourceAlpha" stdDeviation="0.1" result="a"/><feSpecularLighting in="a" surfaceScale="5" specularExponent="12" lighting-color="white"><feSpotLight x="0.2" y="0.2" z="0.5" pointsAtX="0.6" pointsAtY="0.6" pointsAtZ="0" specularExponent="2"/></feSpecularLighting>',
      { attrs: REG + ' ' + OBB },
    ),
    { mean: 3, scales: true },
  ],
  [
    'p-two-primitives',
    use('<feGaussianBlur stdDeviation="0.05" result="b"/><feOffset in="b" dx="0.2" dy="0.1"/>', {
      attrs: REG + ' ' + OBB,
    }),
    {},
  ],
  [
    'p-group-box',
    use('<feGaussianBlur stdDeviation="0.05"/>', {
      attrs: REG + ' ' + OBB,
      body: '<rect x="8" y="12" width="20" height="12" fill="#e04020"/><rect x="36" y="30" width="20" height="24" fill="#2060d0"/>',
    }),
    {},
  ],
  ['p-on-element', el('<feGaussianBlur stdDeviation="0.1"/>', { attrs: REG + ' ' + OBB }), {}],
  [
    'p-scaled-element',
    doc(
      '<g transform="scale(1.5)"><rect x="8" y="8" width="24" height="24" fill="#e04020" filter="url(#f)"/></g>',
      F(
        '<feOffset dx="0.25" dy="0.25"/><feGaussianBlur stdDeviation="0.05"/>',
        'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB" ' +
          OBB,
      ),
    ),
    {},
  ],
  ['p-unit-user', use('<feGaussianBlur stdDeviation="3.2"/><feOffset dx="8" dy="0"/>'), {}], // control: the same numbers in user units
  [
    'p-filterunits-user-region-obb-prim',
    use('<feOffset dx="0.25" dy="0"/>', {
      attrs:
        'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB" ' +
        OBB,
    }),
    {},
  ],
  [
    'p-obb-region-user-prim',
    use('<feOffset dx="8" dy="0"/>', {
      attrs: 'color-interpolation-filters="sRGB" x="-0.5" y="-0.5" width="2" height="2"',
    }),
    {},
  ],
  [
    'p-kernelunitlength',
    use(
      '<feConvolveMatrix order="3" kernelMatrix="0 0 0 0 0 1 0 0 0" divisor="1" kernelUnitLength="2"/>',
    ),
    {},
  ],

  // ── CSS filter functions and filter lists ────────────────────────────────────────────────────────────────────────────
  ['c-blur', doc(`<g style="filter: blur(3px)">${SQ}</g>`), { scales: true }],
  ['c-blur-attr', doc(`<g filter="blur(3px)">${SQ}</g>`), {}],
  ['c-blur-em', doc(`<g style="filter: blur(0.15em); font-size: 20px">${SQ}</g>`), {}],
  ['c-brightness', doc(`<g style="filter: brightness(150%)">${SRC}</g>`), {}],
  ['c-brightness-dark', doc(`<g style="filter: brightness(0.4)">${SRC}</g>`), {}],
  ['c-contrast', doc(`<g style="filter: contrast(.5)">${SRC}</g>`), {}],
  ['c-contrast-high', doc(`<g style="filter: contrast(200%)">${SRC}</g>`), {}],
  ['c-grayscale', doc(`<g style="filter: grayscale(1)">${SRC}</g>`), { scales: true }],
  ['c-grayscale-half', doc(`<g style="filter: grayscale(50%)">${SRC}</g>`), {}],
  ['c-hue-rotate', doc(`<g style="filter: hue-rotate(90deg)">${SRC}</g>`), {}],
  ['c-hue-rotate-turn', doc(`<g style="filter: hue-rotate(0.25turn)">${SRC}</g>`), {}],
  ['c-hue-rotate-rad', doc(`<g style="filter: hue-rotate(2rad)">${SRC}</g>`), {}],
  ['c-invert', doc(`<g style="filter: invert(.3)">${SRC}</g>`), {}],
  ['c-invert-full', doc(`<g style="filter: invert(100%)">${SRC}</g>`), {}],
  ['c-opacity', doc(`<g style="filter: opacity(40%)">${SRC}</g>`), {}],
  ['c-saturate', doc(`<g style="filter: saturate(3)">${SRC}</g>`), {}],
  ['c-saturate-low', doc(`<g style="filter: saturate(0.3)">${SRC}</g>`), {}],
  ['c-sepia', doc(`<g style="filter: sepia(1)">${SRC}</g>`), {}],
  ['c-sepia-part', doc(`<g style="filter: sepia(.4)">${SRC}</g>`), {}],
  [
    'c-dropshadow',
    doc(`<g style="filter: drop-shadow(6px 6px 4px #2060d0)">${SQ}</g>`),
    { scales: true },
  ],
  [
    'c-dropshadow-colorfirst',
    doc(`<g style="filter: drop-shadow(#2060d0 6px 6px)">${SQ}</g>`),
    { scales: true },
  ],
  [
    'c-dropshadow-currentcolor',
    doc(`<g style="filter: drop-shadow(6px 6px 2px); color: #20a040">${SQ}</g>`),
    { scales: true },
  ],
  [
    'c-dropshadow-alpha',
    doc(`<g style="filter: drop-shadow(5px 5px 3px rgba(0,0,255,.5))">${SQ}</g>`),
    { scales: true },
  ],
  [
    'c-dropshadow-transform',
    doc(
      `<g transform="scale(1.5)" style="filter: drop-shadow(3px 3px 2px #2060d0)"><rect x="8" y="8" width="20" height="20" fill="#e04020"/></g>`,
    ),
    { scales: true },
  ],
  [
    'c-list',
    doc(`<g style="filter: grayscale(100%) blur(2px) brightness(1.5)">${SRC}</g>`),
    { scales: true },
  ],
  ['c-list-order', doc(`<g style="filter: brightness(2) contrast(.5)">${SRC}</g>`), {}],
  ['c-list-order-rev', doc(`<g style="filter: contrast(.5) brightness(2)">${SRC}</g>`), {}],
  [
    'c-list-dropshadow-then-blur',
    doc(`<g style="filter: drop-shadow(5px 5px 0 #2060d0) blur(2px)">${SQ}</g>`),
    { scales: true },
  ],
  [
    'c-list-blur-then-dropshadow',
    doc(`<g style="filter: blur(1px) drop-shadow(5px 5px 0 #2060d0)">${SQ}</g>`),
    { scales: true },
  ],
  [
    'c-url-fn',
    doc(`<g style="filter: url(#f) hue-rotate(90deg)">${SQ}</g>`, F('<feOffset dx="6" dy="0"/>')),
    {},
  ],
  [
    'c-fn-url',
    doc(`<g style="filter: blur(2px) url(#f)">${SQ}</g>`, F('<feOffset dx="6" dy="0"/>')),
    {},
  ],
  [
    'c-url-url',
    doc(
      `<g filter="url(#f) url(#g)">${SQ}</g>`,
      F('<feOffset dx="6" dy="0"/>') +
        '<filter id="g" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter>',
    ),
    {},
  ],
  // A url() that names no filter: Filter Effects 1 ignores the whole chain (the default: the plain square); Chrome applies the other stages.
  // Each url() stage of a list is a filter of its own with its own region (Filter Effects 1 section 5): the first stage's result is clipped to ITS
  // region before the second reads it, not the list drawn with the last stage's region only (the nested-group control below is the same picture
  // built from two filters, each on its own element).
  [
    'c-url-url-regions',
    doc(
      `<g filter="url(#f) url(#g)">${SQ}</g>`,
      '<filter id="f" filterUnits="userSpaceOnUse" x="20" y="20" width="24" height="24" color-interpolation-filters="sRGB"><feOffset dx="10" dy="0"/></filter><filter id="g" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter>',
    ),
    {},
  ],
  // ...an unstated region is -10% / -10% / 120% / 120% of the element's box: the first stage's blur is cut there, the offset after it moves what is left.
  [
    'c-url-url-default-region',
    doc(
      `<g filter="url(#f) url(#g)">${SQ}</g>`,
      '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="5"/></filter><filter id="g" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feOffset dx="8" dy="0"/></filter>',
    ),
    {},
  ],
  // ...a function after the last url() is not bounded by that stage's region.
  [
    'c-url-fn-region',
    doc(
      `<g style="filter: url(#f) blur(4px)">${SQ}</g>`,
      '<filter id="f" filterUnits="userSpaceOnUse" x="14" y="14" width="36" height="36" color-interpolation-filters="sRGB"><feOffset dx="0" dy="0"/></filter>',
    ),
    {},
  ],
  [
    'c-url-missing',
    doc(`<g style="filter: url(#nope) blur(2px)">${SQ}</g>`),
    { opts: { compat: 'chrome' } },
  ],
  ['c-url-missing-spec', doc(`<g style="filter: url(#nope) blur(2px)">${SQ}</g>`), { spec: true }],
  [
    'c-on-element',
    doc(`<rect x="16" y="16" width="32" height="32" fill="#e04020" style="filter: blur(3px)"/>`),
    {},
  ],
  [
    'c-on-element-attr',
    doc(
      `<rect x="16" y="16" width="32" height="32" fill="#e04020" filter="drop-shadow(5px 5px 2px #2060d0)"/>`,
    ),
    { scales: true },
  ],
  [
    'c-stylesheet',
    doc(`<style>.s{filter:blur(3px) saturate(2)}</style><g class="s">${SRC}</g>`),
    {},
  ],
  [
    'c-stylesheet-elem',
    doc(
      `<style>rect.s{filter:drop-shadow(4px 4px 2px #2060d0)}</style><rect class="s" x="16" y="16" width="30" height="30" fill="#e04020"/>`,
    ),
    {},
  ],
  // A blur under an element's scaling transform: Mantle does not carry the element's scale into stdDeviation for ANY filter (a url() blur on the same group is
  // identical to this one, the control below), so the Chrome comparison is held only loosely; the equality with the url() filter is what this cell asserts.
  [
    'c-scaled',
    doc(
      `<g transform="scale(2)" style="filter: blur(2px)"><rect x="8" y="8" width="16" height="16" fill="#e04020"/></g>`,
    ),
    { meanAll: 6 },
  ],
  ['c-none', doc(`<g style="filter: none">${SQ}</g>`), {}],
  [
    'c-none-child',
    doc(
      `<g style="filter: blur(3px)"><rect x="8" y="8" width="20" height="20" fill="#e04020"/><rect x="34" y="34" width="20" height="20" fill="#2060d0" style="filter:none"/></g>`,
    ),
    {},
  ],
  [
    'c-child-filter-in-filtered-group',
    doc(
      `<g style="filter: grayscale(1)"><rect x="8" y="8" width="24" height="24" fill="#e04020" style="filter: blur(2px)"/><rect x="34" y="34" width="20" height="20" fill="#2060d0"/></g>`,
    ),
    {},
  ],
  ['c-invalid-unitless', doc(`<g style="filter: blur(3)">${SQ}</g>`), {}],
  ['c-invalid-attr', doc(`<g filter="blur(3)">${SQ}</g>`), {}],
  ['c-invalid-negative', doc(`<g style="filter: brightness(-1)">${SRC}</g>`), {}],
  ['c-invalid-cascade', doc(`<g style="filter: blur(3px); filter: foo(1)">${SQ}</g>`), {}],
  [
    'c-invalid-attr-keeps-style',
    doc(`<g filter="blur(5)" style="filter: grayscale(1)">${SRC}</g>`),
    {},
  ],
  ['c-clamp-high', doc(`<g style="filter: grayscale(3) sepia(5)">${SRC}</g>`), {}],
  ['c-default-args', doc(`<g style="filter: grayscale() sepia()">${SRC}</g>`), {}],
];

/// The same picture drawn with constructs that already worked (user units, an ordinary filter), id -> svg: Mantle against Mantle, held to
/// a max of 3 levels. What the new path must be, exactly.
export const CONTROLS = {
  's-empty-width-spec': use('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>'),
  's-empty-height-negative-spec': use('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>'),
  's-empty-blur-input-spec': doc(''),
  'c-url-missing-spec': doc(SQ),
  'p-blur': use('<feGaussianBlur stdDeviation="3.2"/>'),
  'p-blur-aniso': use('<feGaussianBlur stdDeviation="3.2 3.2"/>', { body: SQ2 }),
  'p-offset': use('<feOffset dx="8" dy="8"/>', { body: SQ2 }),
  'p-morph': use('<feMorphology operator="dilate" radius="3.2 3.2"/>', { body: SQ2 }),
  'p-two-primitives': use(
    '<feGaussianBlur stdDeviation="1.6" result="b"/><feOffset in="b" dx="6.4" dy="3.2"/>',
  ),
  'p-light-point': use(
    '<feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="a"/><feDiffuseLighting in="a" surfaceScale="6" lighting-color="white"><fePointLight x="24" y="24" z="12"/></feDiffuseLighting>',
  ),
  'p-on-element': el('<feGaussianBlur stdDeviation="3.2"/>'),
  'p-group-box': use('<feGaussianBlur stdDeviation="2.4 2.1"/>', {
    body: '<rect x="8" y="12" width="20" height="12" fill="#e04020"/><rect x="36" y="30" width="20" height="24" fill="#2060d0"/>',
  }),
  'c-blur': use('<feGaussianBlur stdDeviation="3"/>'),
  'c-blur-attr': use('<feGaussianBlur stdDeviation="3"/>'),
  'c-blur-em': use('<feGaussianBlur stdDeviation="3"/>'),
  'c-scaled': doc(
    '<g transform="scale(2)" filter="url(#f)"><rect x="8" y="8" width="16" height="16" fill="#e04020"/></g>',
    F(
      '<feGaussianBlur stdDeviation="2"/>',
      'filterUnits="userSpaceOnUse" x="-50" y="-50" width="200" height="200" color-interpolation-filters="sRGB"',
    ),
  ),
  'c-url-url-regions': doc(
    `<g filter="url(#g)"><g filter="url(#f)">${SQ}</g></g>`,
    '<filter id="f" filterUnits="userSpaceOnUse" x="20" y="20" width="24" height="24" color-interpolation-filters="sRGB"><feOffset dx="10" dy="0"/></filter><filter id="g" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter>',
  ),
  'c-url-url-default-region': doc(
    `<g filter="url(#g)"><g filter="url(#f)">${SQ}</g></g>`,
    '<filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="5"/></filter><filter id="g" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feOffset dx="8" dy="0"/></filter>',
  ),
  'c-url-fn-region': doc(
    `<g style="filter: blur(4px)"><g filter="url(#f)">${SQ}</g></g>`,
    '<filter id="f" filterUnits="userSpaceOnUse" x="14" y="14" width="36" height="36" color-interpolation-filters="sRGB"><feOffset dx="0" dy="0"/></filter>',
  ),
  'c-none': doc(SQ),
  'c-invalid-unitless': doc(SQ),
  'c-invalid-attr': doc(SQ),
  'c-invalid-cascade': use('<feGaussianBlur stdDeviation="3"/>'),
  'c-invalid-negative': doc(SRC),
  'c-on-element': el('<feGaussianBlur stdDeviation="3"/>'),
};
