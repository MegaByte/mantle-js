// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter FillPaint / StrokePaint: the importer captures each filter use's computed owner fill and stroke
// (inherited, currentColor, <use>, none) with their opacities kept separate, and a distinct owner paint is a
// distinct claim. A filter that never names FillPaint/StrokePaint carries no ownerPaints record.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { importSvg } = await import('../../src/index.js');
const identity = '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0';
const defs = (input) =>
  `<filter id="f"><feColorMatrix in="${input}" values="${identity}"/></filter>`;
const cases = [
  [
    'group',
    '<g fill="lime" stroke="blue" filter="url(#f)"><rect width="16" height="16" fill="red"/></g>',
    [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ],
  ],
  [
    'inherit',
    '<g fill="lime" stroke="blue"><g filter="url(#f)"><rect width="16" height="16" fill="red"/></g></g>',
    [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ],
  ],
  [
    'opacity',
    '<g fill="lime" stroke="blue" opacity=".25" fill-opacity=".1" stroke-opacity=".2" filter="url(#f)"><rect width="16" height="16" fill="red"/></g>',
    [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ],
  ],
  [
    'currentColor',
    '<style>.owner{color:#336699;fill:currentColor;stroke:none}</style><g class="owner" filter="url(#f)"><rect width="16" height="16" fill="red"/></g>',
    [
      [0.2, 0.4, 0.6, 1],
      [0, 0, 0, 0],
    ],
  ],
  [
    'use',
    '<defs><rect id="s" width="16" height="16" fill="red"/></defs><use href="#s" fill="lime" stroke="blue" filter="url(#f)"/>',
    [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ],
  ],
  [
    'none',
    '<g fill="none" stroke="none" filter="url(#f)"><rect width="16" height="16" fill="red"/></g>',
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  ],
];
let checks = 0;
const rows = [],
  errors = [];
for (const [name, content, expected] of cases)
  for (const input of ['FillPaint', 'StrokePaint']) {
    const sections = await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${defs(input)}</defs>${content}</svg>`,
        { preserveViewport: true },
      ),
      graph = sections.filterGraphs?.find(Boolean),
      actual = graph?.ownerPaints;
    checks++;
    if (
      !actual ||
      JSON.stringify(actual.fill) !== JSON.stringify(expected[0]) ||
      JSON.stringify(actual.stroke) !== JSON.stringify(expected[1])
    )
      errors.push({ name, input, actual, expected });
    rows.push({ name, input, actual });
  }
const duplicate = await importSvg(
  `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs('FillPaint')}</defs><rect width="16" height="16" fill="lime" filter="url(#f)"/><rect x="20" width="16" height="16" fill="blue" filter="url(#f)"/></svg>`,
);
checks++;
const fills = duplicate.filterGraphs?.filter(Boolean).map((g) => g.ownerPaints?.fill);
if (JSON.stringify(fills) !== '[[0,1,0,1],[0,0,1,1]]')
  errors.push({ name: 'distinct owner claims', fills });
{
  const plain = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="f"><feColorMatrix in="SourceGraphic" values="${identity}"/></filter></defs><rect width="16" height="16" fill="lime" filter="url(#f)"/></svg>`,
  );
  checks++;
  if (plain.filterGraphs?.some((g) => g && 'ownerPaints' in g))
    errors.push({ name: 'no owner paint record without a paint input' });
}
assert.equal(errors.length, 0, JSON.stringify(errors.slice(0, 4)));
console.log('filterOwnerPaintImportSmoke PASS', checks, 'checks');
