// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _filterLinearCases.mjs -- the cells of filterLinearRenderSmoke (color-interpolation-filters, the linearRGB default).
// Each is a 64-unit cell drawn at 128 px by Mantle and by Chrome's own SVG engine (8x, box-averaged). Cells named lin-* leave the property at
// its initial value (linearRGB, Filter Effects 1 §15.8); srgb-* pin it. [id, svg, { mean, over, tol, meanAll }]: bounds on the mean absolute
// channel difference over the non-edge pixels and on how many differ by more than `tol` (default 8).
const doc = (body, defs = '', extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64" ${extra}><rect width="64" height="64" fill="white"/><defs>${defs}</defs>${body}</svg>`;
const SRC =
  '<rect x="12" y="12" width="28" height="28" fill="#e04020"/><circle cx="40" cy="40" r="13" fill="#2060d0" fill-opacity=".75"/><rect x="26" y="8" width="6" height="48" fill="#20a040" fill-opacity=".5"/>';
const FLAT = '<rect x="12" y="12" width="40" height="40" fill="#e04020"/>';
const REGION = 'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"';
const F = (inner, attrs = '') => `<filter id="f" ${REGION} ${attrs}>${inner}</filter>`;
const use = (inner, { attrs = '', body = SRC, g = '', extra = '' } = {}) =>
  doc(`<g filter="url(#f)" ${g}>${body}</g>`, F(inner, attrs), extra);
const CM = (t, v, a = '') => `<feColorMatrix type="${t}" values="${v}" ${a}/>`;
const OFF = '<feOffset dx="8" dy="6" result="b"/>';
const LUM =
  '<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#303030"/></linearGradient>';
const RAMP = '<rect width="64" height="64" fill="url(#g)"/>';
const DIST = '<feDistantLight azimuth="40" elevation="50"/>';
const BLURA = '<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="a"/>';
const S = 'color-interpolation-filters="sRGB"',
  L = 'color-interpolation-filters="linearRGB"';

const GAMMA = use(
  '<feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="2" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="2" offset="0"/></feComponentTransfer>',
);

/** @type {Array<[string, string, {mean?: number, over?: number, tol?: number, meanAll?: number}]>} */
export const CASES = [
  // ── the reference cells: linearRGB by default ─────────────────────────────────────────────────────────────────────────────────────
  ['lin-blur', use('<feGaussianBlur stdDeviation="3"/>'), {}],
  // (a box-blurred sigma past the Gaussian table's reach differs from Chrome by 3.3 in sRGB as well: the bound is that, not a linear error)
  [
    'lin-blur-box',
    use('<feGaussianBlur stdDeviation="40"/>'),
    { mean: 3.5, meanAll: 3.5, over: 400 },
  ],
  ['lin-blend-overlay', use(`${OFF}<feBlend in="SourceGraphic" in2="b" mode="overlay"/>`), {}],
  ['lin-blend-screen', use(`${OFF}<feBlend in="SourceGraphic" in2="b" mode="screen"/>`), {}],
  ['lin-blend-multiply', use(`${OFF}<feBlend in="SourceGraphic" in2="b" mode="multiply"/>`), {}],
  [
    'lin-comp-arith',
    use(
      `${OFF}<feComposite in="SourceGraphic" in2="b" operator="arithmetic" k1="0" k2=".5" k3=".5" k4="0"/>`,
    ),
    {},
  ],
  ['lin-comp-over', use(`${OFF}<feComposite in="b" in2="SourceGraphic" operator="over"/>`), {}],
  ['lin-cm-saturate', use(CM('saturate', '0.3')), {}],
  ['lin-cm-hue', use(CM('hueRotate', '90')), {}],
  ['lin-cm-luminance', use(CM('luminanceToAlpha', '')), {}],
  [
    'srgb-blur-box',
    use('<feGaussianBlur stdDeviation="40"/>', { attrs: S }),
    { mean: 3.5, meanAll: 3.5, over: 400 },
  ],
  [
    'srgb-ct-gamma',
    use(
      '<feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="2" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="2" offset="0"/></feComponentTransfer>',
      { attrs: S },
    ),
    {},
  ],
  [
    'lin-ct-table',
    use('<feComponentTransfer><feFuncR type="table" tableValues="1 0"/></feComponentTransfer>'),
    {},
  ],
  // Chrome's 8-bit table drops the fraction, which linear light shows in the darks (compat: 'chrome' reproduces it; the default is the spec's exact table).
  ['lin-ct-gamma-spec', GAMMA, { mean: 1, meanAll: 1, over: 2400, max: 16 }],
  ['lin-ct-gamma', GAMMA, { importOpts: { compat: 'chrome' } }],
  [
    'lin-chain',
    use(
      '<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b"/><feOffset in="b" dx="4" dy="4" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
    ),
    {},
  ],
  [
    'lin-turbulence',
    use('<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="1"/>'),
    { mean: 2.5, meanAll: 3.5, over: 400 },
  ],
  [
    'lin-turbulence-turb',
    use('<feTurbulence type="turbulence" baseFrequency="0.05" numOctaves="2" seed="3"/>'),
    { mean: 2.5, meanAll: 3.5, over: 400 },
  ],
  [
    'lin-disp',
    use(
      '<feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="3" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="8" xChannelSelector="R" yChannelSelector="G"/>',
    ),
    { mean: 2.5, meanAll: 3.5, over: 400 },
  ],
  [
    'lin-diffuse',
    use(
      `${BLURA}<feDiffuseLighting in="a" surfaceScale="3" lighting-color="#ffcc66">${DIST}</feDiffuseLighting>`,
    ),
    { mean: 2.5, meanAll: 3.5, over: 200 },
  ],
  [
    'lin-specular',
    use(
      `${BLURA}<feSpecularLighting in="a" surfaceScale="3" specularConstant="1" specularExponent="12" lighting-color="#ffcc66">${DIST}</feSpecularLighting>`,
    ),
    { mean: 2.5, meanAll: 3.5, over: 200 },
  ],
  ['lin-dropshadow', use('<feDropShadow dx="4" dy="4" stdDeviation="2" flood-color="#f00"/>'), {}],
  [
    'lin-dropshadow-alpha',
    use('<feDropShadow dx="4" dy="4" stdDeviation="2" flood-color="#2060d0" flood-opacity=".5"/>', {
      body: FLAT,
    }),
    {},
  ],
  ['lin-flood', use('<feFlood flood-color="#0a1428"/>', { body: FLAT }), {}],
  [
    'lin-flood-alpha',
    use(
      '<feFlood flood-color="#808080" flood-opacity=".5" result="a"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="a"/></feMerge>',
    ),
    {},
  ],
  [
    'lin-flood-in',
    use(
      '<feFlood flood-color="#2060d0" result="a"/><feComposite in="a" in2="SourceGraphic" operator="in"/>',
    ),
    {},
  ],
  ['lin-morph-erode', use('<feMorphology operator="erode" radius="2"/>'), {}],
  ['lin-morph-dilate', use('<feMorphology operator="dilate" radius="2"/>'), {}],
  ['lin-convolve', use('<feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0"/>'), {}],
  [
    'lin-offset-frac',
    use('<feOffset dx="0.5" dy="0"/>', {
      body: '<rect x="12" y="12" width="30" height="30" fill="#000"/>',
    }),
    { mean: 2.5, meanAll: 3 },
  ],
  [
    'lin-tile',
    use(
      '<feFlood flood-color="#2060d0" x="8" y="8" width="8" height="8" result="a"/><feOffset in="a" dx="0" dy="0" x="8" y="8" width="16" height="16" result="b"/><feTile in="b"/>',
    ),
    {},
  ],
  [
    'lin-dark-ramp',
    doc(
      `<g filter="url(#f)">${RAMP}</g>`,
      F(CM('matrix', '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0')) + LUM,
    ),
    { mean: 2, meanAll: 2 },
  ],
  [
    'lin-dark-ramp-blur',
    doc(`<g filter="url(#f)">${RAMP}</g>`, F('<feGaussianBlur stdDeviation="0.1"/>') + LUM),
    { mean: 2, meanAll: 2 },
  ],
  [
    'lin-group',
    doc(
      `<g filter="url(#f)"><g>${SRC}</g></g>`,
      F(`${OFF}<feBlend in="SourceGraphic" in2="b" mode="screen"/>`),
    ),
    {},
  ],
  [
    'lin-stroke',
    doc(
      '<path d="M12 40 C 20 8, 44 8, 52 40" fill="none" stroke="#e04020" stroke-width="5" stroke-linecap="round" filter="url(#f)"/>',
      F('<feGaussianBlur stdDeviation="2"/>' + CM('saturate', '0.2')),
    ),
    {},
  ],
  ['lin-opacity', use(CM('saturate', '0.3'), { g: 'opacity=".6"' }), {}],
  // ── the property: every place it is read, and who overrides whom ─────────────────────────────────────────────────────────────────
  ['srgb-cm', use(CM('saturate', '0.3'), { attrs: S }), {}],
  ['srgb-auto', use(CM('saturate', '0.3'), { attrs: 'color-interpolation-filters="auto"' }), {}],
  ['lin-explicit', use(CM('saturate', '0.3'), { attrs: L }), {}],
  ['prim-srgb-in-linear', use(CM('saturate', '0.3', S), { attrs: L }), {}],
  ['prim-linear-in-srgb', use(CM('saturate', '0.3', L), { attrs: S }), {}],
  [
    'prim-style',
    use(CM('saturate', '0.3', 'style="color-interpolation-filters:sRGB"'), { attrs: L }),
    {},
  ],
  [
    'prim-inherit',
    use(CM('saturate', '0.3', 'color-interpolation-filters="inherit"'), { attrs: S }),
    {},
  ],
  [
    'filter-style',
    use(CM('saturate', '0.3'), { attrs: 'style="color-interpolation-filters:sRGB"' }),
    {},
  ],
  [
    'filter-rule',
    doc(
      `<g filter="url(#f)">${SRC}</g>`,
      `<style>#f{color-interpolation-filters:sRGB}</style>${F(CM('saturate', '0.3'))}`,
    ),
    {},
  ],
  ['root-attr', use(CM('saturate', '0.3'), { extra: 'color-interpolation-filters="sRGB"' }), {}],
  [
    'defs-parent',
    doc(
      `<g filter="url(#f)">${SRC}</g>`,
      `<g style="color-interpolation-filters:sRGB">${F(CM('saturate', '0.3'))}</g>`,
    ),
    {},
  ],
  [
    'referencer-not-inherited',
    use(CM('saturate', '0.3'), { g: 'color-interpolation-filters="sRGB"' }),
    {},
  ],
  [
    'invalid-value',
    use(CM('saturate', '0.3'), { attrs: 'color-interpolation-filters="bogus"' }),
    {},
  ],
  // ── chains that change space ─────────────────────────────────────────────────────────────────────────────────────────────────
  ['mix-lin-then-srgb', use(CM('saturate', '0.3') + CM('hueRotate', '90', S)), {}],
  ['mix-srgb-then-lin', use(CM('saturate', '0.3', S) + CM('hueRotate', '90', L)), {}],
  [
    'mix-blur-srgb-blend-lin',
    use(
      `<feGaussianBlur stdDeviation="2" ${S} result="a"/><feOffset in="SourceGraphic" dx="5" dy="5" result="b"/><feBlend in="a" in2="b" mode="multiply" ${L}/>`,
    ),
    {},
  ],
  [
    'mix-merge-lin-of-srgb',
    use(
      `<feFlood flood-color="#2060d0" flood-opacity=".6" ${S} result="a"/><feMerge ${L}><feMergeNode in="SourceGraphic"/><feMergeNode in="a"/></feMerge>`,
    ),
    {},
  ],
  [
    'mix-chain-lin-3',
    use(
      `${CM('saturate', '0.5')}<feGaussianBlur stdDeviation="2"/><feComponentTransfer><feFuncA type="linear" slope=".8"/></feComponentTransfer>`,
    ),
    {},
  ],
  [
    'mix-composite-two-spaces',
    use(
      `<feGaussianBlur stdDeviation="2" ${S} result="a"/><feGaussianBlur stdDeviation="2" ${L} in="SourceGraphic" result="b"/><feComposite in="a" in2="b" operator="arithmetic" k2="1" k3="1" ${L}/>`,
    ),
    {},
  ],
  [
    'mix-disp-in2-linear',
    use(
      `<feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="3" ${S} result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="8" xChannelSelector="R" yChannelSelector="G" ${L}/>`,
    ),
    { mean: 2.5, meanAll: 3.5, over: 400 },
  ],
  // ── CSS filter functions and lists operate in sRGB whatever the property says ─────────────────────────────────────────────────
  ['css-blur-fn', doc(`<g style="filter:blur(3px)">${SRC}</g>`), {}],
  ['css-grayscale-fn', doc(`<g style="filter:grayscale(0.6) sepia(0.3)">${SRC}</g>`), {}],
  ['css-dropshadow-fn', doc(`<g style="filter:drop-shadow(3px 3px 2px #f00)">${FLAT}</g>`), {}],
  ['css-hue-fn', doc(`<g style="filter:hue-rotate(90deg) saturate(0.5)">${SRC}</g>`), {}],
  [
    'css-url-then-fn',
    doc(`<g style="filter:url(#f) blur(2px)">${SRC}</g>`, F(CM('saturate', '0.3'))),
    {},
  ],
];
