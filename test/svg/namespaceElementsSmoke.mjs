// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { importSvg } from '../../src/svg/importer.js';
import { chainMatches, parseCssChain } from '../../src/svg/stylesheet.js';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { buildCff2TestSfnt } from '../font/_cff2FontFixture.mjs';
import { registerCffReader } from '../../src/font/formats/cff.js';
registerCffReader();
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const ns = 'http://www.w3.org/2000/svg';
const root = (body) => `<svg xmlns="${ns}" viewBox="0 0 32 32">${body}</svg>`;
// Change only XML element prefixes: CSS selectors, attributes and references
// stay authored. Both prefixes deliberately resolve to the same namespace.
function prefixed(xml, mixed) {
  return xml
    .replace(
      /<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g,
      (_, close, name) => `<${close}${mixed && name.length % 2 ? 'b' : 'a'}:${name}`,
    )
    .replace(`xmlns="${ns}"`, `xmlns:a="${ns}" xmlns:b="${ns}"`);
}
const fixtures = [
  [
    'primitives',
    '<rect x="2" y="2" width="6" height="6"/><circle cx="20" cy="8" r="4"/><ellipse cx="9" cy="20" rx="5" ry="3"/><path d="M18 18H28V28H18Z"/>',
  ],
  [
    'css',
    '<style>g > rect {fill:red} rect:nth-of-type(2) {fill:blue}</style><g><rect x="2" y="2" width="8" height="8"/><rect x="12" y="2" width="8" height="8"/></g>',
  ],
  [
    'external css',
    '<link rel="stylesheet" href="colors.css"/><rect x="2" y="2" width="20" height="20"/>',
  ],
  [
    'HTML style',
    '<foreignObject><h:style xmlns:h="http://www.w3.org/1999/xhtml">rect {fill:red}</h:style></foreignObject><rect x="4" y="4" width="24" height="24"/>',
  ],
  [
    'HTML link',
    '<foreignObject><h:link xmlns:h="http://www.w3.org/1999/xhtml" rel="stylesheet" href="colors.css"/></foreignObject><rect x="4" y="4" width="24" height="24"/>',
  ],
  [
    'gradient',
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" fill="url(#g)"/>',
  ],
  [
    'clip and mask',
    '<defs><clipPath id="c"><circle cx="16" cy="16" r="12"/></clipPath><mask id="m"><rect width="32" height="32" fill="white"/></mask></defs><rect width="30" height="30" clip-path="url(#c)" mask="url(#m)"/>',
  ],
  [
    'pattern',
    '<defs><pattern id="p" patternUnits="userSpaceOnUse" width="8" height="8"><rect width="4" height="8" fill="red"/></pattern></defs><rect width="32" height="32" fill="url(#p)"/>',
  ],
  [
    'marker',
    '<defs><marker id="m" markerWidth="3" markerHeight="3" refX="1" refY="1"><path d="M0 0L3 1L0 3Z"/></marker></defs><path d="M4 4L24 24" fill="none" stroke="blue" marker-end="url(#m)"/>',
  ],
  [
    'filter',
    '<defs><filter id="f"><feComponentTransfer><feFuncR type="linear" slope="0.5"/></feComponentTransfer><feGaussianBlur stdDeviation="0.25"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode/></feMerge></filter></defs><rect x="4" y="4" width="20" height="20" filter="url(#f)"/>',
  ],
  [
    'use and symbol',
    '<defs><symbol id="s" viewBox="0 0 8 8"><path d="M1 1H7V7H1Z"/></symbol></defs><use href="#s" x="4" y="4" width="24" height="24"/>',
  ],
  ['nested image', '<image href="nested.svg" x="4" y="4" width="24" height="24"/>'],
  [
    'text spans',
    '<text x="1" y="24" font-family="Fixture" font-size="16">A<tspan dx="2">A</tspan></text>',
  ],
  [
    'text path',
    '<defs><path id="line" d="M1 24H31"/></defs><text font-family="Fixture" font-size="16"><textPath href="#line">AA</textPath></text>',
  ],
  ['view', '<view id="detail" viewBox="4 4 24 24"/><path d="M4 4H28V28H4Z"/>'],
];
const options = {
  viewName: 'detail',
  cssTextLoader: async () => 'rect {fill:green}',
  svgTextLoader: async () => prefixed(root('<circle cx="16" cy="16" r="12" fill="red"/>'), true),
  fonts: { Fixture: new MantleFontAsset(buildCff2TestSfnt()) },
  svgTextLayout: buildSvgTextGlyphs,
};
for (const [name, body] of fixtures) {
  const xml = root(body);
  const plain = await importSvg(xml, options);
  if (name.startsWith('HTML ')) {
    const svgStyle = await importSvg(
      root(body.replaceAll('http://www.w3.org/1999/xhtml', ns)),
      options,
    );
    assert.deepEqual(plain, svgStyle, name + ': complete bundle equals the SVG stylesheet control');
    const fill = new Float32Array(plain.meta, 32).slice(4, 8);
    assert.ok(
      name === 'HTML style' ? fill[0] > 0.99 && fill[1] === 0 : fill[0] === 0 && fill[1] > 0.49,
      name + ': authored stylesheet color',
    );
  }
  assert.ok(plain.numShapes > 0, `${name}: positive control contains geometry`);
  for (const mixed of [false, true]) {
    const actual = await importSvg(prefixed(xml, mixed), options);
    assert.deepEqual(actual, plain, `${name}: ${mixed ? 'mixed aliases' : 'prefixed'} bundle`);
  }
  console.log(`ok ${name}: identical complete bundle for both prefix layouts`);
}
const doc = new DOMParser().parseFromString(
  `<a:svg xmlns:a="${ns}" xmlns:b="${ns}" xmlns:f="urn:foreign"><a:rect id="a"/><f:rect/><b:rect id="b"/></a:svg>`,
  'application/xml',
);
const second = doc.getElementById('b');
assert.ok(
  chainMatches(parseCssChain('rect:nth-of-type(2)'), second),
  'same namespace aliases share type positions',
);
assert.ok(
  chainMatches(parseCssChain('rect:last-of-type'), second),
  'foreign namespaces do not share type positions',
);
const foreign = await importSvg(
  root(
    '<f:rect xmlns:f="urn:foreign" width="32" height="32"/><rect x="4" y="4" width="8" height="8"/>',
  ),
);
const control = await importSvg(root('<rect x="4" y="4" width="8" height="8"/>'));
assert.deepEqual(foreign.curves, control.curves, 'foreign rectangle does not become SVG geometry');
assert.equal(foreign.numShapes, 1);

const legacyHtmlStyle = await importSvg(
  root(
    '<foreignObject><style xmlns="http://www.w3.org/1999/xhtml">rect {fill:red}</style></foreignObject><rect width="24" height="24"/>',
  ),
);
assert.equal(
  new Float32Array(legacyHtmlStyle.meta, 32)[4],
  1,
  'unprefixed embedded HTML stylesheet remains active',
);
console.log('SVG NAMESPACE PASS');
