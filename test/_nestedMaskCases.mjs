// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _nestedMaskCases.mjs — the nested-mask corpus: one mask nested in a mask (the corpus case _mask_nested.svg), deeper chains, a mask reached
// through <use> and <g>, the clip-path variants, and single-level controls that must keep the unified route.
// `nested` is what nestedMask.js must say; `coverWrong` marks a cell the COVER PASS ITSELF draws wrongly (an inner mask two levels down,
// and a mask on a <g> around a masked child), so only route agreement is asserted for it; `bound` is the bound on the mean pixel error against Chrome 8x (0-255 units).
const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200" width="200" height="200"><defs>${defs}</defs>${body}</svg>`;
const BOTTOM = '<rect x="0" y="100" width="200" height="100" fill="white"/>';
const L = (x, extra = '') => `<circle cx="${x}" cy="100" r="60" fill="white" ${extra}/>`;
const RED = '<rect x="0" y="0" width="200" height="200" fill="red"';
export const nestedMaskCases = [
  {
    id: 'mask-nested',
    nested: true,
    svg: svg(
      `<mask id="i" mask-type="luminance">${BOTTOM}</mask><mask id="o" mask-type="luminance">${L(70, 'mask="url(#i)"')}${L(130)}</mask>`,
      `${RED} mask="url(#o)"/>`,
    ),
  },
  {
    id: 'mask-depth3',
    nested: true,
    coverWrong: true,
    svg: svg(
      `<mask id="a">${BOTTOM}</mask><mask id="b">${L(70, 'mask="url(#a)"')}<circle cx="60" cy="100" r="30" fill="white"/></mask><mask id="c">${L(70, 'mask="url(#b)"')}${L(130)}</mask>`,
      `${RED} mask="url(#c)"/>`,
    ),
  },
  {
    id: 'mask-use-child',
    nested: true,
    svg: svg(
      `<mask id="i">${BOTTOM}</mask><circle id="c1" cx="70" cy="100" r="60" fill="white"/><mask id="m"><use href="#c1" mask="url(#i)"/>${L(130)}</mask>`,
      `${RED} mask="url(#m)"/>`,
    ),
  },
  {
    id: 'mask-g-child',
    nested: true,
    svg: svg(
      `<mask id="i">${BOTTOM}</mask><mask id="m"><g mask="url(#i)">${L(70)}${L(130)}</g></mask>`,
      `${RED} mask="url(#m)"/>`,
    ),
  },
  {
    id: 'mask-single',
    nested: false,
    svg: svg(`<mask id="m">${L(70)}${L(130)}</mask>`, `${RED} mask="url(#m)"/>`),
  },
  {
    id: 'mask-one-shape',
    nested: false,
    svg: svg(`<mask id="m">${L(100)}</mask>`, `${RED} mask="url(#m)"/>`),
  },
  {
    id: 'mask-on-g',
    nested: false,
    svg: svg(
      `<mask id="m">${L(70)}${L(130)}</mask>`,
      '<g mask="url(#m)"><rect x="0" y="0" width="100" height="200" fill="red"/><rect x="100" y="0" width="100" height="200" fill="blue"/></g>',
    ),
  },
  {
    id: 'mask-on-use',
    nested: false,
    svg: svg(
      `<mask id="m">${L(70)}${L(130)}</mask><rect id="r" x="0" y="0" width="200" height="200" fill="red"/>`,
      '<use href="#r" mask="url(#m)"/>',
    ),
  },
  {
    id: 'two-masks-siblings',
    nested: false,
    svg: svg(
      `<mask id="a">${L(60)}${L(90)}</mask><mask id="b">${L(120)}${L(150)}</mask>`,
      '<rect x="0" y="0" width="200" height="100" fill="red" mask="url(#a)"/><rect x="0" y="100" width="200" height="100" fill="blue" mask="url(#b)"/>',
    ),
  },
  // The clip-path family: a clip inside a mask child, a clip and a mask on one element, a clip-path on a <use> mask child, and a mask
  // attribute on a clipPath child (not in the SVG clipping model: Chrome ignores it).
  {
    id: 'clip-in-mask',
    nested: false,
    svg: svg(
      `<clipPath id="c">${BOTTOM}</clipPath><mask id="m">${L(70, 'clip-path="url(#c)"')}${L(130)}</mask>`,
      `${RED} mask="url(#m)"/>`,
    ),
  },
  {
    id: 'clip-and-mask',
    nested: false,
    svg: svg(
      `<mask id="i">${BOTTOM}</mask><clipPath id="c"><circle cx="70" cy="100" r="60"/><circle cx="130" cy="100" r="60"/></clipPath>`,
      `${RED} clip-path="url(#c)" mask="url(#i)"/>`,
    ),
  },
  {
    id: 'clip-use-in-mask',
    nested: false,
    svg: svg(
      `<clipPath id="c">${BOTTOM}</clipPath><circle id="c1" cx="70" cy="100" r="60" fill="white"/><mask id="m"><use href="#c1" clip-path="url(#c)"/>${L(130)}</mask>`,
      `${RED} mask="url(#m)"/>`,
    ),
  },
  {
    id: 'mask-in-clip',
    nested: false,
    svg: svg(
      `<mask id="i">${BOTTOM}</mask><clipPath id="c"><circle cx="70" cy="100" r="60" mask="url(#i)"/><circle cx="130" cy="100" r="60"/></clipPath>`,
      `${RED} clip-path="url(#c)"/>`,
    ),
  },
  {
    id: 'clip-in-clip',
    nested: false,
    svg: svg(
      `<clipPath id="i">${BOTTOM.replace(' fill="white"', '')}</clipPath><clipPath id="c"><circle cx="70" cy="100" r="60" clip-path="url(#i)"/><circle cx="130" cy="100" r="60"/></clipPath>`,
      `${RED} clip-path="url(#c)"/>`,
    ),
  },
  {
    id: 'mask-on-masked-g',
    nested: false,
    coverWrong: true,
    svg: svg(
      `<mask id="a">${L(70)}${L(130)}</mask><mask id="b">${BOTTOM}</mask>`,
      '<g mask="url(#b)"><rect x="0" y="0" width="200" height="200" fill="red" mask="url(#a)"/></g>',
    ),
  },
];
