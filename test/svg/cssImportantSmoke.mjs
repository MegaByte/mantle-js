// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cssImportantSmoke.mjs — CSS `!important` cascade order in importSvg.
//
// Per CSS cascade, an author `!important` declaration outranks an inline
// `style="…"` value AND outranks higher-specificity normal declarations.
// A normal-importance rule still loses to inline. Verified on imported
// fill colors (meta texel 1).

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../../src/svg/importer.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const meta = (r) => r.metaFloats || new Float32Array(r.meta, 32);
const fill0 = (r) => {
  const m = meta(r),
    o = 0;
  return (
    '#' +
    [m[o + 4], m[o + 5], m[o + 6]]
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
};
const imp = async (svg) => fill0(await importSvg(svg, {}));
const wrap = (style, body) =>
  `<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg"><style>${style}</style>${body}</svg>`;
const RED = '#ff0000',
  BLUE = '#0000ff',
  GREEN = '#00ff00';

// 1) author !important rule beats inline style.
if (
  (await imp(
    wrap(
      '.x{fill:#ff0000 !important}',
      '<rect class="x" style="fill:#0000ff" x="5" y="5" width="40" height="40"/>',
    ),
  )) === RED
)
  ok('!important rule beats inline style="" value');
else fail('!important did not beat inline');

// 2) normal rule loses to inline.
if (
  (await imp(
    wrap(
      '.x{fill:#ff0000}',
      '<rect class="x" style="fill:#0000ff" x="5" y="5" width="40" height="40"/>',
    ),
  )) === BLUE
)
  ok('normal rule loses to inline style="" value');
else fail('normal rule wrongly beat inline');

// 3) !important beats a higher-specificity NORMAL id rule.
if (
  (await imp(
    wrap(
      '#r{fill:#0000ff} .x{fill:#ff0000 !important}',
      '<rect id="r" class="x" x="5" y="5" width="40" height="40"/>',
    ),
  )) === RED
)
  ok('!important class rule beats higher-specificity normal #id rule');
else fail('!important lost to higher-specificity normal rule');

// 4) between two !important rules, higher specificity wins.
if (
  (await imp(
    wrap(
      '.x{fill:#ff0000 !important} #r{fill:#00ff00 !important}',
      '<rect id="r" class="x" x="5" y="5" width="40" height="40"/>',
    ),
  )) === GREEN
)
  ok('among !important rules, higher specificity (#id) wins');
else fail('!important specificity tiebreak wrong');

// 5) !important + presentation attribute: !important wins.
if (
  (await imp(
    wrap(
      '.x{fill:#ff0000 !important}',
      '<rect class="x" fill="#0000ff" x="5" y="5" width="40" height="40"/>',
    ),
  )) === RED
)
  ok('!important rule beats fill="" presentation attribute');
else fail('!important lost to presentation attribute');

// 6) A later normal declaration in the same block cannot downgrade an earlier
// !important declaration for the same property.
if (
  (await imp(
    wrap(
      '.x{fill:#ff0000 !important; fill:#0000ff}',
      '<rect class="x" x="5" y="5" width="40" height="40"/>',
    ),
  )) === RED
)
  ok('same-block normal declaration does not override earlier !important');
else fail('same-block normal declaration overrode !important');

if (failures) {
  console.error(`CSS-IMPORTANT FAIL (${failures})`);
  process.exit(1);
}
console.log('CSS-IMPORTANT PASS');
