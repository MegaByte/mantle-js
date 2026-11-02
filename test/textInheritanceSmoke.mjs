// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textInheritanceSmoke — the text-layout reads follow the cascade and the inheritance
// parents, like every other inherited property.
//
// Four reads that must not bypass it:
//   - text-anchor INHERITS (SVG 2 §11.10.1): a <g text-anchor="middle"> around a <text>, or a <use
//     text-anchor="end">, applies;
//   - a <tspan>'s (and a <textPath>'s) font-size and font-family come from the cascade, not the ATTRIBUTE
//     only, so style="font-size:40px" or a stylesheet class on a <tspan> applies;
//   - the <text>'s own style= font-size wins over its attribute;
//   - xml:space inherits (XML 1.0 §2.10), so it is not read on the <text> alone.
// Each case reads the glyph rows the text produces (their meta bboxes).
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import * as M from '../src/bundle/layout.js';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';
import { fontFixture, requireAsset } from './_assets.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(requireAsset(fontFixture('roboto-regular.ttf')))),
);
const OPTS = { fonts: { Roboto: font }, svgTextLayout: buildSvgTextGlyphs, preserveViewport: true };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/// The glyph rows filled with `h`, as meta bboxes [x0, y0, x1, y1], left to right.
function glyphs(b, h) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    want = hex(h),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + 7] > 0) || !want.every((v, i) => Math.abs(F[o + 4 + i] - v) < 0.6 / 255)) continue;
    out.push([
      F[o + M.META_BBOX_XMIN],
      F[o + M.META_BBOX_YMIN],
      F[o + M.META_BBOX_XMAX],
      F[o + M.META_BBOX_YMAX],
    ]);
  }
  return out.sort((a, c) => a[0] - c[0]);
}
const inkX = (g) => [Math.min(...g.map((q) => q[0])), Math.max(...g.map((q) => q[2]))];
const height = (g) => Math.max(...g.map((q) => q[3] - q[1]));
const T = (inner, fill, x = 100, y = 60) =>
  `<text x="${x}" y="${y}" font-family="Roboto" font-size="20" fill="${fill}">${inner}</text>`;

const b = await importSvg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 400">
  <style>.big { font-size: 40px }</style>
  <defs><text id="u" x="100" y="160" font-family="Roboto" font-size="20" fill="#800003">HHHH</text></defs>
  ${T('HHHH', '#800001')}
  <g text-anchor="middle">${T('HHHH', '#800002', 100, 100)}</g>
  <use href="#u" text-anchor="end"/>
  <text x="10" y="220" font-family="Roboto" font-size="10" fill="#800004"><tspan style="font-size:40px">H</tspan></text>
  <text x="10" y="270" font-family="Roboto" font-size="10" fill="#800005"><tspan class="big">H</tspan></text>
  <text x="10" y="320" font-family="Roboto" font-size="10" style="font-size:40px" fill="#800006">H</text>
  ${T('A    B', '#800007', 10, 360)}
  <g xml:space="preserve">${T('A    B', '#800008', 10, 390)}</g>
</svg>`,
  OPTS,
);

{
  const start = glyphs(b, '#800001'),
    mid = glyphs(b, '#800002'),
    end = glyphs(b, '#800003');
  const [s0, s1] = inkX(start),
    w = s1 - s0,
    [m0, m1] = inkX(mid),
    [e0, e1] = inkX(end);
  ok(
    start.length === 4 && Math.abs(s0 - 100) < 0.2 * w,
    `control: text-anchor start inks from x = 100 (${s0.toFixed(1)}..${s1.toFixed(1)})`,
  );
  ok(
    Math.abs((m0 + m1) / 2 - 100) < 0.1 * w,
    `a <g text-anchor="middle"> centers its text on x = 100 (ink ${m0.toFixed(1)}..${m1.toFixed(1)})`,
  );
  ok(
    Math.abs(e1 - 100) < 0.2 * w,
    `a <use text-anchor="end"> ends its target's text at x = 100 (ink ${e0.toFixed(1)}..${e1.toFixed(1)})`,
  );
}
{
  const h4 = height(glyphs(b, '#800004')),
    h5 = height(glyphs(b, '#800005')),
    h6 = height(glyphs(b, '#800006'));
  ok(
    h4 > 25,
    `a <tspan style="font-size:40px"> sets its size (H height ${h4.toFixed(1)}; 10 px would be ~7)`,
  );
  ok(h5 > 25, `a <tspan> sized by a stylesheet class (H height ${h5.toFixed(1)})`);
  ok(h6 > 25, `a <text>'s own style= font-size beats its attribute (H height ${h6.toFixed(1)})`);
}
{
  const col = glyphs(b, '#800007'),
    pre = glyphs(b, '#800008');
  const gapC = col[1][0] - col[0][2],
    gapP = pre[1][0] - pre[0][2];
  ok(
    col.length === 2 && pre.length === 2 && gapP > gapC + 10,
    `xml:space="preserve" on a <g> keeps its text's four spaces (gap ${gapP.toFixed(1)} vs collapsed ${gapC.toFixed(1)})`,
  );
}

console.log(fail ? `textInheritanceSmoke FAIL (${fail})` : 'textInheritanceSmoke PASS');
process.exit(fail ? 1 : 0);
