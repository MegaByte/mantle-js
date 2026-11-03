// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// defContentInheritanceSmoke — pattern, clipPath and mask content inherits from the
// <pattern> / <clipPath> / <mask> element and ITS ancestors (SVG 2 §14.2; Masking §6.2, §7.2), never
// from the element that references it.
//
// The importer re-walks that content from inside the shape that claims it. Starting from the
// DOCUMENT DEFAULTS for the carried paint -- fill black, stroke none, stroke-width 1, opacities 1 --
// would mask a <mask fill="white"> with black content (everything hidden), tile a <pattern fill="red">
// black, and keep a fill-opacity on a <defs> around a pattern or mask from its content. The content
// takes its definition's own ancestry for every inherited property, the carried paint included
// (importWalk.js walkDefContent).
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/// Alphas of the rows whose fill color is `h` (pattern tiles and mask content are rows too).
function alphasOf(b, h) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    want = hex(h),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape + 4;
    if (!(F[o + 3] > 0)) continue;
    if (want.every((v, i) => Math.abs(F[o + i] - v) < 0.6 / 255)) out.push(+F[o + 3].toFixed(4));
  }
  return out;
}
const near = (a, v) => a.length > 0 && a.every((x) => Math.abs(x - v) < 1e-4);
const PAT = (id, attrs, content = '<rect width="5" height="5"/>') =>
  `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse" ${attrs}>${content}</pattern>`;
const MASK = (id, attrs, content = '<rect width="100" height="100"/>') =>
  `<mask id="${id}" ${attrs}>${content}</mask>`;

const b = await importSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    ${PAT('p1', 'fill="#700001"')}
    ${PAT('p3', '', '<rect width="5" height="5" fill="#700003"/>')}
    ${MASK('m1', 'fill="#700004"')}
  </defs>
  <defs fill-opacity="0.5">${PAT('p2', '', '<rect width="5" height="5" fill="#700002"/>')}${MASK('m2', '', '<rect width="100" height="100" fill="#700005"/>')}</defs>
  <rect x="0" y="0" width="20" height="20" fill="url(#p1)"/>
  <rect x="20" y="0" width="20" height="20" fill="url(#p2)"/>
  <g fill-opacity="0.3" fill="#700009"><rect x="40" y="0" width="20" height="20" fill="url(#p3)"/></g>
  <rect x="0" y="40" width="20" height="20" fill="#000" mask="url(#m1)"/>
  <rect x="40" y="40" width="20" height="20" fill="#000" mask="url(#m2)"/>
</svg>`);

for (const [h, want, what] of [
  ['#700001', 1, "a <pattern>'s own fill reaches its content"],
  ['#700002', 0.5, 'an ancestor of the <pattern> reaches its content (fill-opacity)'],
  [
    '#700003',
    1,
    "the REFERENCING shape's group fill-opacity does not reach pattern content (control)",
  ],
  ['#700004', 1, "a <mask>'s own fill reaches its content"],
  ['#700005', 0.5, 'an ancestor of the <mask> reaches its content (fill-opacity)'],
]) {
  const a = alphasOf(b, h);
  ok(near(a, want), `${what}: ${h} alpha ${a.join(', ') || 'none'}, want ${want}`);
}
ok(
  alphasOf(b, '#700009').length === 0,
  "the referencing group's FILL does not reach pattern content either",
);

console.log(fail ? `defContentInheritanceSmoke FAIL (${fail})` : 'defContentInheritanceSmoke PASS');
process.exit(fail ? 1 : 0);
