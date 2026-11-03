// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// useInheritanceSmoke — every INHERITED property reaches a <use>'s target from the
// <use> and its ancestors, and never from the target's own ancestors under <defs>.
//
// A <use> instantiates its target as its own child (SVG 2 §5.6.3). The walker walks the target in
// place, so reading inherited properties by walking the target's DOM parents -- which under <defs>
// are not its parents in the rendered tree -- would fill a <use fill-rule="evenodd"> nonzero, drop
// its caps, joins, miter limit, paint-order, dashes and marker references, take `color` for
// currentColor from the wrong place, and apply a `visibility="hidden"` or a stroke-linejoin on the
// target's <defs> group when it must not. The walker keeps the chain of elements it is inside
// (style.js firstInherited), so every inherited read follows the rendered tree.
//
// Each case checks the meta row(s) the target produces, and each has a control that must not change:
// the same property on an ordinary <g> ancestor, and the target's own value beating the <use>'s.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import * as M from '../src/bundle/layout.js';
import { CAP_ENUM, JOIN_ENUM } from '../src/svg/segment.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';
import { fontFixture, optionalAsset } from './_assets.mjs';
import { readFileSync } from 'fs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">${body}</svg>`;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/// Rows whose fill (o0 = 4) or stroke (o0 = 8) color is `h`, with their index and meta.
function rowsOf(b, h, o0 = 4) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    want = hex(h),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + o0 + 3] > 0)) continue;
    if (want.every((v, i) => Math.abs(F[o + o0 + i] - v) < 0.6 / 255))
      out.push({ s, get: (k) => F[o + k] });
  }
  return out;
}
const TRI = 'M10 10 L60 10 L10 60 Z M20 20 L50 20 L20 50 Z'; // two same-wound triangles: the inner one is a hole only under evenodd

// ---- fill-rule --------------------------------------------------------------------------------------
{
  const b = await importSvg(
    doc(`<defs>
      <path id="a" d="${TRI}" fill="#100001"/>
      <path id="a2" d="${TRI}"/>
      <g fill-rule="evenodd"><path id="b" d="${TRI}" fill="#100002"/></g>
      <path id="c" d="${TRI}" fill="#100003" fill-rule="nonzero"/>
    </defs>
    <use href="#a" fill-rule="evenodd"/>
    <g fill-rule="evenodd"><use href="#a2" fill="#100004"/></g>
    <use href="#b"/>
    <use href="#c" fill-rule="evenodd"/>
    <g fill-rule="evenodd"><path d="${TRI}" fill="#100005"/></g>`),
  );
  const fr = (h) => rowsOf(b, h).map((r) => r.get(M.META_FILL_RULE));
  ok(
    fr('#100001').every((v) => v === 1) && fr('#100001').length === 1,
    `<use fill-rule="evenodd"> reaches the target (${fr('#100001')})`,
  );
  ok(
    fr('#100004').every((v) => v === 1) && fr('#100004').length === 1,
    `...and so does an ancestor of the <use> (${fr('#100004')})`,
  );
  ok(
    fr('#100002').every((v) => v === 0) && fr('#100002').length === 1,
    `the target's own <defs> group does NOT (${fr('#100002')}, want nonzero)`,
  );
  ok(
    fr('#100003').every((v) => v === 0) && fr('#100003').length === 1,
    `the target's own value beats the <use>'s (${fr('#100003')})`,
  );
  ok(
    fr('#100005').every((v) => v === 1) && fr('#100005').length === 1,
    `control: an ordinary <g> ancestor (${fr('#100005')})`,
  );
}

// ---- caps, joins, miter limit, dashes --------------------------------------------------------------
{
  const P = 'M10 80 L50 40 L90 80';
  const b = await importSvg(
    doc(`<defs>
      <path id="s" d="${P}" fill="none" stroke="#200001" stroke-width="4"/>
      <g stroke-linejoin="round" stroke-linecap="square"><path id="t" d="${P}" fill="none" stroke="#200002" stroke-width="4"/></g>
    </defs>
    <use href="#s" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="2" stroke-dasharray="5 3" stroke-dashoffset="1"/>
    <use href="#t"/>`),
  );
  const s = rowsOf(b, '#200001', 8)[0],
    t = rowsOf(b, '#200002', 8)[0];
  ok(
    !!s &&
      s.get(M.META_CAP_STYLE) === CAP_ENUM.round &&
      s.get(M.META_JOIN_STYLE) === JOIN_ENUM.bevel &&
      s.get(M.META_MITER_LIMIT) === 2,
    `the <use>'s linecap / linejoin / miterlimit reach the target (cap ${s && s.get(M.META_CAP_STYLE)}, join ${s && s.get(M.META_JOIN_STYLE)}, limit ${s && s.get(M.META_MITER_LIMIT)})`,
  );
  ok(
    !!s && s.get(M.META_DASH_ID) > 0,
    `...and its stroke-dasharray (dash id ${s && s.get(M.META_DASH_ID)})`,
  );
  ok(
    !!t &&
      t.get(M.META_CAP_STYLE) === CAP_ENUM.butt &&
      t.get(M.META_JOIN_STYLE) === JOIN_ENUM.miter,
    `the target's own <defs> group's cap and join do NOT (cap ${t && t.get(M.META_CAP_STYLE)}, join ${t && t.get(M.META_JOIN_STYLE)}, want butt / miter)`,
  );
}

// ---- paint-order, marker references ----------------------------------------------------------------
{
  const b = await importSvg(
    doc(`<defs>
      <marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4"><rect width="10" height="10" fill="#300009"/></marker>
      <rect id="r" x="10" y="10" width="30" height="30" fill="#300001" stroke="#300002" stroke-width="6"/>
      <path id="l" d="M10 80 L60 80" fill="none" stroke="#300003" stroke-width="2"/>
    </defs>
    <use href="#r" paint-order="stroke"/>
    <use href="#l" marker-end="url(#m)"/>`),
  );
  const f = rowsOf(b, '#300001')[0],
    st = rowsOf(b, '#300002', 8)[0];
  ok(
    !!f && !!st && st.s < f.s,
    `<use paint-order="stroke"> puts the target's stroke row first (stroke ${st && st.s}, fill ${f && f.s})`,
  );
  ok(
    rowsOf(b, '#300009').length > 0,
    `<use marker-end> reaches the target (${rowsOf(b, '#300009').length} marker rows)`,
  );
}

// ---- visibility, color, custom properties, a <symbol>'s own properties ------------------------------
{
  const b = await importSvg(
    doc(`<defs>
      <rect id="v" width="10" height="10" fill="#400001"/>
      <g visibility="hidden"><rect id="w" width="10" height="10" fill="#400002"/></g>
      <rect id="c" width="10" height="10" fill="currentColor"/>
      <rect id="k" width="10" height="10" style="fill: var(--k)"/>
      <symbol id="sym" viewBox="0 0 100 100" fill="#400005" fill-rule="evenodd"><path d="${TRI}"/></symbol>
    </defs>
    <use href="#v" visibility="hidden"/>
    <use href="#w"/>
    <use href="#c" color="#400003"/>
    <use href="#k" style="--k: #400004"/>
    <use href="#sym" width="100" height="100"/>`),
  );
  ok(
    rowsOf(b, '#400001').length === 0,
    `<use visibility="hidden"> hides the target (${rowsOf(b, '#400001').length} rows)`,
  );
  ok(
    rowsOf(b, '#400002').length === 1,
    `the target's own <defs> group's visibility="hidden" does NOT (${rowsOf(b, '#400002').length} row)`,
  );
  ok(
    rowsOf(b, '#400003').length === 1,
    `currentColor resolves against the <use>'s color (${rowsOf(b, '#400003').length} row)`,
  );
  ok(
    rowsOf(b, '#400004').length === 1,
    `a custom property set on the <use> reaches the target (${rowsOf(b, '#400004').length} row)`,
  );
  const sym = rowsOf(b, '#400005');
  ok(
    sym.length === 1 && sym[0].get(M.META_FILL_RULE) === 1,
    `a <symbol>'s own fill and fill-rule reach its content (${sym.length} row, rule ${sym[0] && sym[0].get(M.META_FILL_RULE)})`,
  );
}

// ---- text: font properties through a <use> ---------------------------------------------------------
{
  const fontPath = optionalAsset(fontFixture('roboto-regular.ttf'));
  if (fontPath) {
    const font = new MantleFontAsset(new Uint8Array(readFileSync(fontPath)));
    const b = await importSvg(
      doc(`<defs><text id="t" x="10" y="50" font-family="Roboto" fill="#500001">H</text></defs>
      <use href="#t" font-size="40"/>`),
      { fonts: { Roboto: font }, svgTextLayout: buildSvgTextGlyphs },
    );
    const r = rowsOf(b, '#500001')[0];
    const h = r ? r.get(M.META_BBOX_YMAX) - r.get(M.META_BBOX_YMIN) : 0;
    ok(
      h > 25,
      `<use font-size="40"> sizes the target's text (glyph height ${h.toFixed(1)}; the 16 px default is ~11.4)`,
    );
  }
}

console.log(fail ? `useInheritanceSmoke FAIL (${fail})` : 'useInheritanceSmoke PASS');
process.exit(fail ? 1 : 0);
