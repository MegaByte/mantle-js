// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerInheritanceSmoke — a marker's content inherits its paint from the <marker>
// element and the marker's own ancestors (SVG 2 §13.7.2), never from the shape that references it.
//
// Started from fill black, stroke none, stroke-width 1, a <marker fill="red"> would draw black
// arrowheads and a <defs stroke="..."> around the markers would draw none. (fill-opacity /
// stroke-opacity, caps, joins and fill-rule come through the DOM walk that is correct for marker
// content.)
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import * as M from '../src/bundle/layout.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/// Rows whose fill (o0 = 4) or stroke (o0 = 8) color is `h`.
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
const mk = (id, attrs, content = '<path d="M0 0 L10 5 L0 10 Z"/>') =>
  `<marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" ${attrs}>${content}</marker>`;
const line = (y, m, attrs = 'fill="none" stroke="#000"') =>
  `<path d="M10 ${y} L60 ${y} L60 ${y + 5}" ${attrs} stroke-width="1" marker-end="url(#${m})"/>`;

const b = await importSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>
    ${mk('a', 'fill="#600001"')}
    ${mk('c', 'fill="#600003"', '<path d="M0 0 L10 5 L0 10 Z" fill="#600004"/>')}
    ${mk('e', '')}
  </defs>
  <defs fill="#600002" stroke="#600005" stroke-width="3">${mk('b', '')}</defs>
  ${line(10, 'a')}
  ${line(30, 'b')}
  ${line(50, 'c')}
  ${line(70, 'e', 'stroke="#600006" fill="#600007"')}
</svg>`);

ok(
  rowsOf(b, '#600001').length === 1,
  `<marker fill> reaches its content (${rowsOf(b, '#600001').length} row)`,
);
ok(
  rowsOf(b, '#600002').length === 1,
  `an ancestor of the <marker> reaches its content: fill (${rowsOf(b, '#600002').length} row)`,
);
const st = rowsOf(b, '#600005', 8);
ok(
  st.length === 1 && st[0].get(M.META_STROKE_W) === 3,
  `...and stroke / stroke-width (${st.length} stroke row, width ${st[0] ? st[0].get(M.META_STROKE_W) : '-'})`,
);
ok(
  rowsOf(b, '#600004').length === 1 && rowsOf(b, '#600003').length === 0,
  "the content's own fill beats the marker's",
);
ok(
  rowsOf(b, '#600007').length === 1 && rowsOf(b, '#600006', 8).length === 1,
  `the REFERENCING shape's fill and stroke do not reach the marker (its own rows only: fill ${rowsOf(b, '#600007').length}, stroke ${rowsOf(b, '#600006', 8).length})`,
);
// ...and marker e, with nothing set anywhere, keeps the initial fill: black, stroke none.
const blacks = rowsOf(b, '#000000').filter((r) => r.get(M.META_STROKE_W) === 0);
ok(
  blacks.length >= 1,
  `a marker with no paint anywhere draws black, the initial fill (${blacks.length} black fill rows)`,
);

console.log(fail ? `markerInheritanceSmoke FAIL (${fail})` : 'markerInheritanceSmoke PASS');
process.exit(fail ? 1 : 0);
