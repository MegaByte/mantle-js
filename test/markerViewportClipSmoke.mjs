// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerViewportClipSmoke — a marker's content is clipped to the marker's viewport unless its overflow is visible
//.
//
// WHY. SVG draws a marker's content in a viewport markerWidth x markerHeight, and the UA style sheet gives
// <marker> `overflow: hidden` (SVG 2 §13.7.2): content outside the viewport is clipped away unless the marker says
// `overflow="visible"` (or "auto"): a circle overflowing a 10 x 10 viewBox draws as the square it is cut to, not
// whole.
//
// SO instantiateMarker hands back the viewport as the polygon it maps to in document space -- the rect [0, w] x [0, h]
// of the viewport's own coordinates, taken back through the viewBox fit (preserveAspectRatio's scale AND alignment:
// with "meet" the viewport reaches past the viewBox on one axis, with "slice" it keeps a band of it), then through the
// placement and the path's CTM -- and the walker clips the instance's content to it, as a nested viewport's
// clip. Content wholly inside its viewport (a stroke's reach included) takes no clip: it would cut nothing.
//
// (a) every overflow value: hidden (the initial value, as an attribute and in a style), scroll -> clipped;
//     visible, auto -> not;
// (b) THE POLYGON: the clip row's outline is the viewport's image, in float64, for viewBox fits (the default meet,
//     xMinYMax meet, slice, none), no viewBox, markerUnits="strokeWidth", orient="auto" on a diagonal, under a
//     non-conformal carrier and at 2^-20, 1 and 2^20;
// (c) content inside its viewport -- including a stroke that stays inside -- takes no clip; a stroke that reaches out
//     of it does.
import { curveView, curveRangesOf, decodeSegs } from '../src/hitTest/curveGeom.js';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const D2R = Math.PI / 180;
const mm = (P, Q) => [
  P[0] * Q[0] + P[2] * Q[1],
  P[1] * Q[0] + P[3] * Q[1],
  P[0] * Q[2] + P[2] * Q[3],
  P[1] * Q[2] + P[3] * Q[3],
  P[0] * Q[4] + P[2] * Q[5] + P[4],
  P[1] * Q[4] + P[3] * Q[5] + P[5],
];
const ap = (M, p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];
const rot = (d) => [
  Math.cos(d * D2R),
  Math.sin(d * D2R),
  -Math.sin(d * D2R),
  Math.cos(d * D2R),
  0,
  0,
];

/// The marker rows of a bundle (the only rows carrying a clip here), each with its clip row's outline vertices.
function markerRows(b) {
  const meta = new Float32Array(b.meta, 32),
    n = b.numShapes,
    cv = curveView(b),
    rg = curveRangesOf(b, meta, n, 48, cv.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const clipId = meta[i * 48 + 30] | 0;
    if ((meta[i * 48 + 27] | 0) & 256) continue; // a layer row (clip or mask content)
    const r = { row: i, clipId, poly: null };
    if (clipId > 0) {
      const c = clipId - 1;
      // the outline's vertices: each non-degenerate segment's start (the range's padding decodes as empty segments)
      r.poly = decodeSegs(cv, rg[c].begin, rg[c].end)
        .filter((s) => s.x0 !== s.x1 || s.y0 !== s.y1)
        .map((s) => [s.x0, s.y0]);
    }
    rows.push(r);
  }
  return rows;
}
/// Do two quadrilaterals have the same vertices (any order, any start), to `tol`?
const samePoly = (P, Q, tol) =>
  P.length >= 4 &&
  Q.every((q) => P.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol)) &&
  P.every((p) => Q.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol));

const CIRCLE = '<circle cx="5" cy="5" r="8" fill="#000"/>'; // overflows a 0 0 10 10 viewBox on every side
const svgOf = (S, carrier, marker, pathD = 'M-20 0 L20 0', sw = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${400 * S}" height="${400 * S}" viewBox="0 0 ${400 * S} ${400 * S}"><defs>${marker}</defs>` +
  `<g transform="scale(${S}) translate(200 200) ${carrier}"><path d="${pathD}" fill="none" stroke="none" stroke-width="${sw}" marker-end="url(#m)"/></g></svg>`;

// ---- (a) overflow ------------------------------------------------------------------------------------------------------
for (const [attr, clips] of [
  ['', true],
  ['overflow="hidden"', true],
  ['style="overflow: hidden"', true],
  ['overflow="scroll"', true],
  ['overflow="visible"', false],
  ['style="overflow:visible"', false],
  ['overflow="auto"', false],
]) {
  const b = await importSvg(
    svgOf(
      1,
      '',
      `<marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="0" ${attr}>${CIRCLE}</marker>`,
    ),
    { preserveViewport: true },
  );
  const rows = markerRows(b);
  ok(
    rows.length === 1 && rows[0].clipId > 0 === clips,
    `(a) ${attr || 'no overflow (hidden, the initial value)'}: the marker's row is ${rows.length === 1 && rows[0].clipId > 0 ? '' : 'not '}clipped (want ${clips ? '' : 'not '}clipped)`,
  );
}

// ---- (b) the polygon ---------------------------------------------------------------------------------------------------
// [what, marker attributes, the viewport's rect in CONTENT coordinates, content, placement scale in content -> user,
//  path d, stroke-width, the vertex and tangent angle (degrees) the marker is placed at]
const FITS = [
  // the default xMidYMid meet: k = min(30/10, 30/20) = 1.5, the viewport 30 wide over a 15-wide fitted viewBox, centered
  [
    'viewBox 0 0 10 20 in 30 x 30, the default meet',
    'viewBox="0 0 10 20" markerWidth="30" markerHeight="30"',
    [-5, 0, 15, 20],
    '<rect x="-8" y="-3" width="26" height="26" fill="#000"/>',
    1.5,
    [2, 10],
  ],
  [
    '...xMinYMax meet',
    'viewBox="0 0 10 20" preserveAspectRatio="xMinYMax meet" markerWidth="30" markerHeight="30"',
    [0, 0, 20, 20],
    '<rect x="-8" y="-3" width="26" height="26" fill="#000"/>',
    1.5,
    [2, 10],
  ],
  // slice: k = 3, the fitted viewBox 60 tall in a 30-tall viewport: the band y 5..15 of it
  [
    '...xMidYMid slice',
    'viewBox="0 0 10 20" preserveAspectRatio="xMidYMid slice" markerWidth="30" markerHeight="30"',
    [0, 5, 10, 15],
    '<rect x="-8" y="-3" width="26" height="26" fill="#000"/>',
    3,
    [2, 10],
  ],
  [
    '...none',
    'viewBox="0 0 10 20" preserveAspectRatio="none" markerWidth="30" markerHeight="30"',
    [0, 0, 10, 20],
    '<rect x="-8" y="-3" width="26" height="26" fill="#000"/>',
    [3, 1.5],
    [2, 10],
  ],
  [
    'no viewBox, 6 x 4',
    'markerWidth="6" markerHeight="4"',
    [0, 0, 6, 4],
    '<rect x="-2" y="-2" width="12" height="12" fill="#000"/>',
    1,
    [2, 2],
  ],
];
const CARRIERS = [
  ['plain', ''],
  ['scale(2 1.5) rotate(20)', 'scale(2 1.5) rotate(20)'],
  ['skewX(30)', 'skewX(30)'],
];
const carrierM = {
  plain: [1, 0, 0, 1, 0, 0],
  'scale(2 1.5) rotate(20)': mm([2, 0, 0, 1.5, 0, 0], rot(20)),
  'skewX(30)': [1, 0, Math.tan(30 * D2R), 1, 0, 0],
};
for (const S of [2 ** -20, 1, 2 ** 20])
  for (const [cname, ctext] of CARRIERS)
    for (const [what, attrs, rect, content, k, ref] of FITS) {
      for (const [units, sw, orient, pathD, vtx, angDeg] of [
        ['userSpaceOnUse', 1, '0', 'M-20 0 L20 0', [20, 0], 0],
        ['strokeWidth', 3, 'auto', 'M-20 -10 L20 10', [20, 10], Math.atan2(20, 40) / D2R],
      ]) {
        const marker = `<marker id="m" ${attrs} refX="${ref[0]}" refY="${ref[1]}" markerUnits="${units}" orient="${orient}">${content}</marker>`;
        const b = await importSvg(svgOf(S, ctext, marker, pathD, sw), { preserveViewport: true });
        const rows = markerRows(b);
        const [kx, ky] = Array.isArray(k) ? k : [k, k],
          us = units === 'strokeWidth' ? sw : 1;
        // content p -> document: S (200, 200) C (vtx + R(ang) diag(kx us, ky us) (p - ref))
        const place = mm(
          [S, 0, 0, S, 200 * S, 200 * S],
          mm(
            carrierM[cname],
            mm(
              [1, 0, 0, 1, vtx[0], vtx[1]],
              mm(rot(angDeg), [kx * us, 0, 0, ky * us, -kx * us * ref[0], -ky * us * ref[1]]),
            ),
          ),
        );
        const want = [
          [rect[0], rect[1]],
          [rect[2], rect[1]],
          [rect[2], rect[3]],
          [rect[0], rect[3]],
        ].map((p) => ap(place, p));
        const ext = Math.max(...want.map((p) => Math.hypot(p[0] - want[0][0], p[1] - want[0][1])));
        const r = rows[0];
        const good = rows.length === 1 && r.clipId > 0 && samePoly(r.poly, want, 1e-5 * ext);
        ok(
          good,
          `(b) ${what}, ${units}${orient === 'auto' ? ', orient auto on a diagonal' : ''}, ${cname}, 2^${Math.log2(S)}: the clip is the viewport's image` +
            (good
              ? ''
              : ` -- ${rows.length} rows, clip ${r && r.clipId}, outline ${r && r.poly ? r.poly.map((p) => `(${p[0].toPrecision(6)}, ${p[1].toPrecision(6)})`).join(' ') : 'none'}, want ${want.map((p) => `(${p[0].toPrecision(6)}, ${p[1].toPrecision(6)})`).join(' ')}`),
        );
      }
    }

// ---- (c) content inside its viewport takes no clip -----------------------------------------------------------------------
for (const [what, content, clips] of [
  ['a fill inside the viewBox', '<rect x="1" y="1" width="8" height="8" fill="#000"/>', false],
  ['a fill touching its edges', '<rect x="0" y="0" width="10" height="10" fill="#000"/>', false],
  [
    'a stroke that stays inside',
    '<rect x="2" y="2" width="6" height="6" fill="none" stroke="#000" stroke-width="2"/>',
    false,
  ],
  [
    'a stroke that reaches out of it',
    '<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="#000" stroke-width="2"/>',
    true,
  ],
  ['a fill poking out of one side', '<rect x="1" y="1" width="8" height="9.5" fill="#000"/>', true],
]) {
  const b = await importSvg(
    svgOf(
      1,
      '',
      `<marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="0">${content}</marker>`,
    ),
    { preserveViewport: true },
  );
  const rows = markerRows(b);
  ok(
    rows.length >= 1 && rows.every((r) => r.clipId > 0 === clips),
    `(c) ${what}: ${clips ? 'clipped' : 'no clip'} (${rows.map((r) => (r.clipId > 0 ? 'clipped' : 'unclipped')).join(', ')})`,
  );
}
console.log(fail ? `MARKER-VIEWPORT-CLIP FAIL (${fail})` : 'MARKER-VIEWPORT-CLIP PASS');
process.exit(fail ? 1 : 0);
