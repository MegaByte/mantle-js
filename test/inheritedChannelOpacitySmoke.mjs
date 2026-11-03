// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// inheritedChannelOpacitySmoke — fill-opacity and stroke-opacity INHERIT (SVG 2 §13.3,
// §13.5.1), so `<g fill-opacity="0.6"><rect fill="#f00"/></g>` imports at alpha 0.6, not the
// painted element's own 1. The walker carries both the way it carries
// fill, stroke and stroke-width (a DOM-ancestor walk would not do: a <use> walks its target in place,
// under <defs>). Every case names its own fill (and stroke) color and reads the alpha of the row(s)
// painted with it.
//
//   - a group's attribute, its style="", a stylesheet class on it;
//   - a nested <g> that sets only fill passes the outer value through; one that sets its own
//     fill-opacity REPLACES it (inherited, not multiplied); `inherit` and a percentage;
//   - <use>: the value on the <use>, on an ancestor of the <use>, through a <symbol>, overridden by
//     the target itself -- and NOT from the target's own ancestors under <defs>;
//   - a marker: from the marker and its ancestors, never from the shape that references it;
//   - text: a glyph under a <g>, a <tspan> that names its own fill (it keeps the text's
//     fill-opacity) or its own fill-opacity (it replaces the text's, not multiplies it).
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';
import { fontFixture, optionalAsset } from './_assets.mjs';
import { readFileSync } from 'fs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/// The alphas of every row whose FILL (or, with `stroke`, STROKE) color is `h`.
function alphasOf(b, h, stroke = false) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    want = hex(h),
    out = [];
  const o0 = stroke ? 8 : 4;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape + o0;
    if (!(F[o + 3] > 0)) continue;
    if (want.every((v, i) => Math.abs(F[o + i] - v) < 0.6 / 255)) out.push(F[o + 3]);
  }
  return out;
}
const near = (a, v) => a.length > 0 && a.every((x) => Math.abs(x - v) < 1e-4);
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200">${body}</svg>`;
const R = (fill, extra = '') =>
  `<rect x="10" y="10" width="20" height="20" fill="${fill}" ${extra}/>`;

const SHAPES = doc(`
  <style>.half { fill-opacity: 0.4; stroke-opacity: 0.2 }</style>
  <defs>
    <rect id="tgt" x="0" y="0" width="10" height="10" fill="#110001"/>
    <rect id="tgt2" x="0" y="0" width="10" height="10" fill="#110002"/>
    <rect id="tgtOwn" x="0" y="0" width="10" height="10" fill="#110003" fill-opacity="0.9"/>
    <g fill-opacity="0.2"><rect id="deep" x="0" y="0" width="10" height="10" fill="#110004"/></g>
    <g id="gdeep" fill-opacity="0.2"><rect x="0" y="0" width="10" height="10" fill="#110005"/></g>
    <symbol id="sym" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="#110006"/></symbol>
  </defs>
  <g fill-opacity="0.6" stroke-opacity="0.3">${R('#220001', 'stroke="#330001" stroke-width="2"')}</g>
  <g style="fill-opacity:0.5; stroke-opacity:0.25">${R('#220002', 'stroke="#330002" stroke-width="2"')}</g>
  <g class="half">${R('#220003', 'stroke="#330003" stroke-width="2"')}</g>
  <g fill-opacity="0.5"><g fill="#220004"><rect x="40" y="40" width="10" height="10"/></g></g>
  <g fill-opacity="0.5"><g fill-opacity="0.8">${R('#220005')}</g></g>
  <g fill-opacity="0.5">${R('#220006', 'fill-opacity="0.9"')}</g>
  <g fill-opacity="0.7">${R('#220007', 'fill-opacity="inherit"')}</g>
  <g fill-opacity="40%">${R('#220008')}</g>
  ${R('#220009', 'fill-opacity="0.35"')}
  <use href="#tgt" x="50" y="50" fill-opacity="0.5"/>
  <g fill-opacity="0.45"><use xlink:href="#tgt2" x="60" y="60"/></g>
  <use href="#tgtOwn" x="70" y="70" fill-opacity="0.5"/>
  <use href="#deep" x="80" y="80"/>
  <use href="#gdeep" x="90" y="90" fill-opacity="0.9"/>
  <use href="#sym" x="100" y="100" width="10" height="10" fill-opacity="0.35"/>
`);
const b = await importSvg(SHAPES);
for (const [h, want, what, stroke] of [
  ['#220001', 0.6, "a group's fill-opacity attribute"],
  ['#330001', 0.3, "a group's stroke-opacity attribute", true],
  ['#220002', 0.5, 'a group\'s style="fill-opacity"'],
  ['#330002', 0.25, 'a group\'s style="stroke-opacity"', true],
  ['#220003', 0.4, 'a stylesheet class on the group (fill)'],
  ['#330003', 0.2, 'a stylesheet class on the group (stroke)', true],
  ['#220004', 0.5, 'through a nested <g> that sets only fill'],
  ['#220005', 0.8, 'a nested <g fill-opacity> REPLACES the outer value (not 0.4)'],
  ['#220006', 0.9, "the shape's own value replaces the group's"],
  ['#220007', 0.7, "`inherit` takes the parent's"],
  ['#220008', 0.4, 'a percentage'],
  ['#220009', 0.35, "the shape's own value, no group (unchanged)"],
  ['#110001', 0.5, '<use fill-opacity> reaches its target'],
  ['#110002', 0.45, 'an ancestor of the <use> reaches its target'],
  ['#110003', 0.9, "the target's own value beats the <use>'s"],
  ['#110004', 1, 'the target does NOT inherit from its own ancestors under <defs>'],
  ['#110005', 0.2, "a <use>d group's own value beats the <use>'s"],
  ['#110006', 0.35, "<use fill-opacity> reaches a <symbol>'s content"],
]) {
  const a = alphasOf(b, h, !!stroke);
  ok(
    near(a, want),
    `${what}: ${h} alpha ${a.map((v) => +v.toFixed(4)).join(', ') || 'none'}, want ${want}`,
  );
}

// ---- markers: from the marker and its ancestors, never from the referencing shape ----------------
{
  const mk = (id, fill, attrs = '') =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" ${attrs}>` +
    `<path d="M0 0 L10 5 L0 10 Z" fill="${fill}"/></marker>`;
  const m = await importSvg(
    doc(`
    <defs>${mk('m1', '#440001', 'fill-opacity="0.5"')}${mk('m2', '#440002')}</defs>
    <defs fill-opacity="0.6">${mk('m3', '#440003')}</defs>
    <path d="M20 150 L80 150" stroke="#000" stroke-width="2" fill="none" marker-end="url(#m1)"/>
    <g fill-opacity="0.3"><path d="M20 170 L80 170" stroke="#000" stroke-width="2" fill="none" marker-end="url(#m2)"/></g>
    <path d="M20 190 L80 190" stroke="#000" stroke-width="2" fill="none" marker-end="url(#m3)"/>`),
  );
  for (const [h, want, what] of [
    ['#440001', 0.5, "the <marker>'s own fill-opacity reaches its content"],
    ['#440002', 1, "the REFERENCING shape's group does not reach a marker"],
    ['#440003', 0.6, 'an ancestor of the <marker> does'],
  ]) {
    const a = alphasOf(m, h);
    ok(
      near(a, want),
      `marker: ${what}: alpha ${a.map((v) => +v.toFixed(4)).join(', ') || 'none'}, want ${want}`,
    );
  }
}

// ---- text ------------------------------------------------------------------------------------------
{
  const fontPath = optionalAsset(fontFixture('roboto-regular.ttf'));
  if (fontPath) {
    const font = new MantleFontAsset(new Uint8Array(readFileSync(fontPath)));
    const T = (x, y, inner, attrs = '') =>
      `<text x="${x}" y="${y}" font-family="Roboto" font-size="20" ${attrs}>${inner}</text>`;
    const t = await importSvg(
      doc(`
      <g fill-opacity="0.6">${T(10, 30, 'AB', 'fill="#550001"')}</g>
      ${T(10, 60, '<tspan fill="#550002">CD</tspan>', 'fill="#550099" fill-opacity="0.5"')}
      ${T(10, 90, '<tspan fill="#550003" fill-opacity="0.8">EF</tspan>', 'fill-opacity="0.5"')}
      ${T(10, 120, 'G<tspan>H</tspan>', 'fill="#550004" fill-opacity="0.5"')}
      <g fill-opacity="0.4">${T(10, 150, '<tspan fill="#550005">IJ</tspan>')}</g>
      ${T(10, 180, '<tspan fill-opacity="0.8">KL</tspan>', 'fill="#550006" fill-opacity="0.5"')}`),
      { fonts: { Roboto: font }, svgTextLayout: buildSvgTextGlyphs },
    );
    for (const [h, want, what] of [
      ['#550001', 0.6, 'a glyph under <g fill-opacity>'],
      ['#550002', 0.5, "a <tspan> naming its own fill keeps the text's fill-opacity"],
      ['#550003', 0.8, "a <tspan> naming its own fill-opacity replaces the text's (not 0.4)"],
      ['#550004', 0.5, 'text and a plain <tspan> (unchanged)'],
      ['#550005', 0.4, 'a <tspan> under a <g fill-opacity>'],
      [
        '#550006',
        0.8,
        "a <tspan> with its own fill-opacity and the text's fill (it read 0.4, the two multiplied)",
      ],
    ]) {
      const a = alphasOf(t, h);
      ok(
        near(a, want),
        `text: ${what}: ${a.length} glyph rows at ${[...new Set(a.map((v) => +v.toFixed(4)))].join(', ') || 'none'}, want ${want}`,
      );
    }
  }
}

console.log(
  fail ? `inheritedChannelOpacitySmoke FAIL (${fail})` : 'inheritedChannelOpacitySmoke PASS',
);
process.exit(fail ? 1 : 0);
