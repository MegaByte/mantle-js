// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cssClassFillSmoke.mjs — importSvg resolves <style> CSS-class fills.
//
// Covers defs>style classes (incl. Illustrator `.cls-N` exports), the
// cascade (a matched CSS rule beats a presentation attribute), CDATA-
// wrapped <style>, multiple classes on one element, and var(--token)
// custom properties with fallbacks.

import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const meta = (r) => r.metaFloats || new Float32Array(r.meta, 32);
const fill = (r, i) => {
  const m = meta(r),
    o = i * 48;
  return [m[o + 4], m[o + 5], m[o + 6], m[o + 7]];
};
const hex = (a) =>
  '#' +
  a
    .slice(0, 3)
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const fillsHex = (r) => {
  const o = [];
  for (let i = 0; i < r.numShapes; i++) o.push(hex(fill(r, i)));
  return o;
};

// --- defs>style classes (.cls-N). ---
const scaleBar =
  '<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 394.27 51"><defs><style>.cls-1{fill:#103a49;}.cls-2{fill:#0b5669;}</style></defs><path class="cls-1" d="M10803.43,11525.3l-183.87,12-183.4-12c-8.56,0-13.5-2-13.5-13.5,0-10.88,4.94-13.5,13.5-13.5l183.4-12,183.87,12c8.56,0,13.5,2,13.5,13.5C10816.93,11521.81,10812,11525.3,10803.43,11525.3Z" transform="translate(-10422.67 -11486.3)"/><circle class="cls-2" cx="196.9" cy="25.5" r="12.74"/></svg>';

const bar = await importSvg(scaleBar, {});
const barFills = fillsHex(bar);
if (bar.numShapes === 2 && barFills[0] === '#103a49' && barFills[1] === '#0b5669')
  ok('scale-bar: .cls-1→#103a49, .cls-2→#0b5669 (defs>style classes resolved)');
else fail(`scale-bar fills wrong: n=${bar.numShapes} ${JSON.stringify(barFills)}`);

// --- Cascade: a matched CSS rule wins over a presentation attribute. ---
const cascade = await importSvg(
  '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
    '<style>.x{fill:#ff0000}</style>' +
    '<rect class="x" fill="#00ff00" x="5" y="5" width="40" height="40"/></svg>',
  {},
);
if (hex(fill(cascade, 0)) === '#ff0000')
  ok('cascade: CSS class fill beats fill="…" presentation attribute');
else fail('cascade wrong: ' + hex(fill(cascade, 0)));

// --- CDATA-wrapped <style> (Illustrator variant). ---
const cdata = await importSvg(
  '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
    '<style type="text/css"><![CDATA[.st0{fill:#103a49;}]]></style>' +
    '<rect class="st0" x="5" y="5" width="40" height="40"/></svg>',
  {},
);
if (hex(fill(cdata, 0)) === '#103a49') ok('CDATA-wrapped <style> class resolved');
else fail('CDATA class wrong: ' + hex(fill(cdata, 0)));

// --- Multiple classes on one element. ---
const multi = await importSvg(
  '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
    '<style>.a{fill:#103a49}.b{fill-opacity:0.5}</style>' +
    '<rect class="a b" x="5" y="5" width="40" height="40"/></svg>',
  {},
);
if (hex(fill(multi, 0)) === '#103a49' && Math.abs(fill(multi, 0)[3] - 0.5) < 0.01)
  ok('multiple classes compose (fill + fill-opacity)');
else fail('multi-class wrong: ' + JSON.stringify(fill(multi, 0)));

// --- CSS custom properties: var(--token) resolves against the
//     :root / inherited custom-property cascade, incl. fallbacks.
const cssVar = await importSvg(
  '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
    '<style>:root{--c:#ff0000}.v{fill:var(--c)}</style>' +
    '<rect class="v" x="5" y="5" width="40" height="40"/></svg>',
  {},
);
if (hex(fill(cssVar, 0)) === '#ff0000') ok('var(--token) resolves from :root custom property');
else fail('var(--c) not resolved: ' + hex(fill(cssVar, 0)));

const cssVarFallback = await importSvg(
  '<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">' +
    '<style>.v{fill:var(--missing,#103a49)}</style>' +
    '<rect class="v" x="5" y="5" width="40" height="40"/></svg>',
  {},
);
if (hex(fill(cssVarFallback, 0)) === '#103a49') ok('var(--missing, fallback) uses the fallback');
else fail('var() fallback not used: ' + hex(fill(cssVarFallback, 0)));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nCSS-CLASS-FILL PASS');
process.exit(failures ? 1 : 0);
